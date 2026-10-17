// The Canvas 2D GPU binding (docs/specifications/gpu-command-stream.md).
// Renderer-core decides every Canvas GPU operation: bitmaps, image
// conversion, the draw execution of a command list with its layers,
// filters, shadows, masks and copies, readback and pixel conversion. This
// module transports host objects and bounded inputs into renderer-core
// memory, executes the records through the GPU binding, and keeps the
// caller-owned textures with the host objects that own them.
import { instantiateRendererCore } from '../wasm/renderer-core-binary.js';
import { createGpuBinding } from '../gpu-binding.js';
import { canvasUnpremultiplyTable } from '../canvas-unpremultiply.js';
import { composeShaderBytes, shaderLibraryFor } from '../shaders/compose.js';
import { GlyphResourceManager } from '../glyph-resource-manager.js';
import { imageUploadRepresentation, sourceConversionPlan } from '../image-data.js';
import { loadColorKernel } from '../wasm/color-kernel.js';
import { canvasGamutRows } from './canvas-2d-color-space.js';
import { gpuThreadQueueDevice, setGpuThreadExternalImageCopy } from './webgpu-facade.js';

const formats = ['rgba8unorm', 'rgba16float', 'rgba16uint', 'rgba32float',
  'r8unorm', 'r8uint', 'depth24plus-stencil8', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb'];
const bindings = new WeakMap();
let canvasCore;

// The record size of src/wasm/canvas-2d.wat.
export const COMMAND_SIZE = 128;
// The bitmap format of each Canvas 2D colorType.
export const BITMAP_FORMAT = 'rgba8unorm';
export const BITMAP_FORMATS = Object.freeze({ unorm8: BITMAP_FORMAT, float16: 'rgba16float' });

// The bytes of one pixel of a bitmap or payload format.
export function bytesPerPixel(format) {
  if (format === 'rgba8unorm') return 4;
  if (format === 'rgba16float') return 8;
  throw new Error(`Canvas 2D bitmap format ${format}: expected rgba8unorm or rgba16float`);
}

function bitmapFormat(format) {
  bytesPerPixel(format);
  return format === 'rgba16float' ? 1 : 0;
}

function executionCore() {
  return canvasCore ??= instantiateRendererCore().exports;
}

function bindingFor(device) {
  let binding = bindings.get(device);
  if (binding !== undefined) return binding;
  const core = executionCore();
  const gpu = createGpuBinding(core, device);
  const table = canvasUnpremultiplyTable();
  const pointer = gpu.input(table.length).byteOffset;
  new Uint8Array(core.memory.buffer, pointer, table.length).set(table);
  const shader = composeShaderBytes(core, 'canvas-copy');
  const state = core.gpu_canvas_copy_create(gpu.stream, shader.pointer, shader.length, pointer);
  gpu.execute();
  const blurShader = composeShaderBytes(core, 'canvas-blur');
  const blurState = core.gpu_canvas_blur_create(gpu.stream, blurShader.pointer, blurShader.length);
  gpu.execute();
  const colorShader = composeShaderBytes(core, 'canvas-color-pass');
  const colorState = core.gpu_canvas_color_create(gpu.stream, colorShader.pointer, colorShader.length);
  gpu.execute();
  const library = shaderLibraryFor(core);
  const rasterState = core.gpu_canvas_raster_create(gpu.stream, library);
  const imageState = core.gpu_canvas_image_create(gpu.stream, library);
  const readbackState = core.gpu_canvas_readback_create(gpu.stream);
  const frames = core.gpu_canvas_frames_create(gpu.stream);
  gpu.execute();
  binding = { core, gpu, state, blurState, colorState, rasterState, imageState, readbackState, frames };
  bindings.set(device, binding);
  device.lost.then(() => {
    core.gpu_canvas_copy_destroy(state);
    core.gpu_canvas_blur_destroy(blurState);
    core.gpu_canvas_color_destroy(colorState);
    core.gpu_canvas_raster_destroy(rasterState);
    core.gpu_canvas_image_destroy(imageState);
    core.gpu_canvas_readback_destroy(readbackState);
    core.gpu_canvas_frames_destroy(frames);
    gpu.execute();
    gpu.close();
    bindings.delete(device);
  });
  return binding;
}

// ------------------------------------------------------------- bitmaps

export function createBitmapTexture(device, width, height, format = BITMAP_FORMAT) {
  const { core, gpu } = bindingFor(device);
  gpu.beginFrame();
  const handle = core.gpu_canvas_bitmap_create(gpu.stream, width, height, bitmapFormat(format));
  gpu.execute();
  return gpu.resource(handle);
}

// A GPU copy of a bitmap, for a drawImage() that reads this state later.
export function copyBitmapTexture(device, texture, width, height) {
  const { core, gpu } = bindingFor(device);
  gpu.beginFrame();
  const handle = core.gpu_canvas_bitmap_copy(gpu.stream, gpu.importResource(texture), width, height, bitmapFormat(texture.format));
  gpu.execute();
  return gpu.resource(handle);
}

// ------------------------------------------------------ decoded images

const { linearRgbToWorkingMatrix } = loadColorKernel();
const imageTextures = new WeakMap();

// The source-convert uniforms that bring `descriptor` into a bitmap of
// `colorSpace`: the standard plan (sRGB-encoded output, premultiplied in
// float) with its matrix replaced by the one into the bitmap's primaries.
function conversionUniforms(descriptor, colorSpace) {
  const plan = sourceConversionPlan(descriptor, 'standard');
  const uniforms = new Float32Array(20);
  uniforms.set(plan.matrix, 0);
  const primaries = descriptor.colorEncoding.primaries;
  if (primaries !== colorSpace) {
    const rows = primaries === 'srgb' || primaries === 'display-p3'
      ? canvasGamutRows(primaries, colorSpace)
      : linearRgbToWorkingMatrix(primaries, colorSpace);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) uniforms[row * 4 + column] = rows[row][column];
    }
  }
  uniforms[12] = plan.transferId;
  uniforms[13] = plan.gammaExponent;
  uniforms[14] = plan.linearScale;
  uniforms[15] = plan.encodeSrgbOutput;
  uniforms[16] = plan.alphaSourceMode;
  uniforms[17] = plan.sourceScale;
  uniforms[18] = descriptor.sampleType === 'float16' && descriptor.canvasToneMapping === 'standard' ? 1 : 0;
  return uniforms;
}

// The bitmap of a renderer image entry { width, height, descriptor } on
// `device` in `colorSpace`. The renderer's single decode uploads once per
// device and color space; the texture lives with the decoded image.
export function decodedImageTexture(device, image, colorSpace = 'srgb') {
  let byDevice = imageTextures.get(image);
  if (byDevice === undefined) {
    byDevice = new WeakMap();
    imageTextures.set(image, byDevice);
  }
  let bySpace = byDevice.get(device);
  if (bySpace === undefined) {
    bySpace = new Map();
    byDevice.set(device, bySpace);
  }
  let texture = bySpace.get(colorSpace);
  if (texture !== undefined) return texture;
  const { descriptor, width, height } = image;
  const upload = imageUploadRepresentation(descriptor);
  const bytes = new Uint8Array(upload.data.buffer, upload.data.byteOffset, upload.data.byteLength);
  const uniforms = conversionUniforms(descriptor, colorSpace);
  const { core, gpu, imageState } = bindingFor(device);
  gpu.beginFrame();
  const input = gpu.input(112 + bytes.length);
  const words = new Uint32Array(core.memory.buffer, input.byteOffset, 8);
  words.set([width, height, formats.indexOf(upload.format), upload.sampleKind === 'uint' ? 1 : 0,
    input.byteOffset + 112, bytes.length, upload.bytesPerRow, input.byteOffset + 32]);
  new Float32Array(core.memory.buffer, input.byteOffset + 32, 20).set(uniforms);
  new Uint8Array(core.memory.buffer, input.byteOffset + 112, bytes.length).set(bytes);
  const handle = core.gpu_canvas_image_convert(imageState, input.byteOffset);
  gpu.execute();
  texture = gpu.resource(handle);
  bySpace.set(colorSpace, texture);
  return texture;
}

// A "texture" source's bitmap on `device`: its own texture on its device,
// else a copy through the GPU-thread readback that the source keeps.
function textureOnDevice(device, source) {
  if (source.device === device) return source.texture;
  const retained = source.textures?.get(device);
  if (retained !== undefined) return retained;
  let texture;
  const format = bitmapFormat(source.format);
  readTextureRegion(source.device, source.texture, source.width, source.height, source.format, 0, 0, format, {
    reply({ readbackState }) {
      const { core, gpu } = bindingFor(device);
      gpu.beginFrame();
      const handle = core.gpu_canvas_bitmap_upload(gpu.stream, readbackState, source.width, source.height, format);
      gpu.execute();
      texture = gpu.resource(handle);
    },
    throw(error) { throw error; },
  });
  source.textures ??= new Map();
  source.textures.set(device, texture);
  return texture;
}

// ------------------------------------------------------- glyph transport

// Canvas has a CPU-only manager, so a synchronous flush never waits for a
// GPU generation callback on the script thread.
let canvasGlyphManager = null;
const GLYPH_RUN = 12;

// The glyph runs of each list, with the atlas glyph records that
// renderer-core places as instances. Returns { runs: Map(list -> run
// array), release } or null without glyph runs.
function prepareGlyphs(lists, device) {
  const runs = [];
  const requests = [];
  const requestIndices = new Map();
  for (const list of lists) {
    const view = new DataView(list.bytes.buffer, list.bytes.byteOffset, list.bytes.byteLength);
    const floats = new Float32Array(list.geometry.buffer, list.geometry.byteOffset, list.geometry.byteLength / 4);
    for (let offset = 0; offset < list.bytes.length; offset += COMMAND_SIZE) {
      if (view.getUint32(offset, true) !== GLYPH_RUN) continue;
      const font = list.fonts[view.getUint32(offset + 68, true)];
      const devicePixelSize = view.getFloat32(offset + 72, true) * view.getFloat32(offset + 56, true);
      let bySize = requestIndices.get(font);
      if (bySize === undefined) {
        bySize = new Map();
        requestIndices.set(font, bySize);
      }
      let request = bySize.get(devicePixelSize);
      if (request === undefined) {
        request = requests.length;
        bySize.set(devicePixelSize, request);
        requests.push({
          fontBytes: font.bytes, faceIndex: font.faceIndex, glyphIds: new Set(), weight: font.weight,
          variationWidth: font.variationWidth, variationSlant: font.variationSlant, opticalSize: font.opticalSize,
          devicePixelSize,
        });
      }
      const first = view.getUint32(offset + 4, true);
      const count = view.getUint32(offset + 64, true);
      const glyphs = [];
      for (let glyph = 0; glyph < count; glyph++) {
        const id = floats[(first + glyph * 2 + 1) * 2];
        requests[request].glyphIds.add(id);
        glyphs.push(id);
      }
      runs.push({ list, command: offset / COMMAND_SIZE, font, devicePixelSize, request, glyphs });
    }
  }
  if (runs.length === 0) return null;
  let lease;
  (canvasGlyphManager ??= new GlyphResourceManager()).acquireWithCompletion(
    requests.map((request) => ({ ...request, glyphIds: [...request.glyphIds] })),
    { generationBackend: { kind: 'cpu' } },
    { reply(value) { lease = value; }, throw(error) { throw error; } },
  );
  try {
    const byList = new Map();
    for (const run of runs) {
      const atlas = lease.atlases[run.request];
      const infos = run.glyphs.map((id) => atlas.glyphInfo(id, run.font.weight, run.font.opticalSize, run.devicePixelSize));
      let entries = byList.get(run.list);
      if (entries === undefined) byList.set(run.list, entries = []);
      entries.push({ command: run.command, atlas: atlas.deviceTexture(device), upem: run.font.upem, infos });
    }
    return { runs: byList, release: () => lease.release() };
  } catch (error) {
    lease.release();
    throw error;
  }
}

// --------------------------------------------------------------- flushes

// The parity harness (test/oracle/canvas-2d-parity.js) observes each job
// that renderer-core draws: { width, height, multisampled, bytes,
// geometry, fonts } with copies of the job's records; null otherwise.
let commandListObserver = null;
export function observeCommandLists(observer) {
  commandListObserver = observer;
}

const LIST_SIZE = 160;
const align = (value) => (value + 7) & ~7;

// Draws `list` into `target` ({ texture, width, height, opaque,
// colorSpace }) on `device`; `clear` starts from the blank bitmap.
// list: { bytes, geometry, clips, masks, maskGeometry, paints, sources,
// payloads, fonts }; a source is { kind: "texture", device, texture },
// { kind: "commands", list, width, height, opaque, colorSpace, format,
// persistent } or { kind: "image", image }.
export function rasterizeCommands(device, target, list, clear) {
  // Every list with its source objects, the target's list first.
  const entries = [{ list, colorSpace: target.colorSpace ?? 'srgb', format: target.texture.format, source: null }];
  const listIndices = new Map();
  for (let index = 0; index < entries.length; index++) {
    for (const source of entries[index].list.sources) {
      if (source?.kind !== 'commands' || listIndices.has(source)) continue;
      listIndices.set(source, entries.length);
      entries.push({ list: source.list, colorSpace: source.colorSpace ?? 'srgb', format: source.format, source });
    }
  }
  // Host objects resolve before the flush imports them.
  for (const entry of entries) {
    entry.textures = entry.list.sources.map((source) => {
      if (source?.kind === 'image') return decodedImageTexture(device, source.image, entry.colorSpace);
      if (source?.kind === 'texture') return textureOnDevice(device, source);
      return null;
    });
    const kept = entry.source?.persistent ? entry.source.textures?.get(device) : undefined;
    entry.kept = kept ?? null;
  }
  const glyphs = prepareGlyphs(entries.map((entry) => entry.list), device);
  const { core, gpu, rasterState, blurState, colorState, frames } = bindingFor(device);
  let input = 0;
  try {
    gpu.beginFrame();
    let length = 48 + entries.length * LIST_SIZE;
    for (const entry of entries) {
      const { list: commands } = entry;
      entry.runs = glyphs?.runs.get(commands) ?? [];
      const glyphCount = entry.runs.reduce((sum, run) => sum + run.infos.length, 0);
      length += align(commands.bytes.length) + align(commands.geometry.length) + align(commands.clips.length) +
        align(commands.masks.length) + align(commands.maskGeometry.length) + align(commands.paints.length) +
        align(commands.sources.length * 8) + align(commands.payloads.length * 20) +
        commands.payloads.reduce((sum, payload) => sum + align(payload.bytes.byteLength), 0) +
        entry.runs.length * 24 + glyphCount * 96;
    }
    input = core.abi_allocate(length);
    const memory = new Uint8Array(core.memory.buffer);
    const view = new DataView(core.memory.buffer);
    memory.fill(0, input, input + length);
    let cursor = input + 48 + entries.length * LIST_SIZE;
    const place = (bytes) => {
      const at = cursor;
      memory.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), at);
      cursor += align(bytes.byteLength);
      return [at, bytes.byteLength];
    };
    view.setUint32(input, gpu.importResource(target.texture), true);
    view.setUint32(input + 4, target.width, true);
    view.setUint32(input + 8, target.height, true);
    view.setUint32(input + 12, target.opaque ? 1 : 0, true);
    view.setUint32(input + 16, bitmapFormat(target.texture.format), true);
    view.setUint32(input + 20, clear ? 1 : 0, true);
    view.setUint32(input + 24, entries.length, true);
    view.setUint32(input + 28, input + 48, true);
    view.setUint32(input + 32, commandListObserver === null ? 0 : 1, true);
    entries.forEach((entry, index) => {
      const at = input + 48 + index * LIST_SIZE;
      const { list: commands, source } = entry;
      const spans = [commands.bytes, commands.geometry, commands.clips, commands.masks, commands.maskGeometry, commands.paints];
      spans.forEach((bytes, span) => {
        const [pointer, byteLength] = place(bytes);
        view.setUint32(at + span * 8, pointer, true);
        view.setUint32(at + span * 8 + 4, byteLength, true);
      });
      const sources = cursor;
      commands.sources.forEach((value, slot) => {
        const record = sources + slot * 8;
        if (value?.kind === 'commands') {
          view.setUint32(record, 2, true);
          view.setUint32(record + 4, listIndices.get(value), true);
        } else if (entry.textures[slot] !== null) {
          view.setUint32(record, 1, true);
          view.setUint32(record + 4, gpu.importResource(entry.textures[slot]), true);
        }
      });
      cursor += align(commands.sources.length * 8);
      view.setUint32(at + 48, sources, true);
      view.setUint32(at + 52, commands.sources.length, true);
      const payloads = cursor;
      cursor += align(commands.payloads.length * 20);
      commands.payloads.forEach((payload, slot) => {
        const record = payloads + slot * 20;
        const [pointer, byteLength] = place(payload.bytes);
        view.setUint32(record, pointer, true);
        view.setUint32(record + 4, byteLength, true);
        view.setUint32(record + 8, payload.width, true);
        view.setUint32(record + 12, payload.height, true);
        view.setUint32(record + 16, bitmapFormat(payload.format), true);
      });
      view.setUint32(at + 56, payloads, true);
      view.setUint32(at + 60, commands.payloads.length, true);
      const runs = cursor;
      cursor += entry.runs.length * 24;
      const infos = cursor;
      let glyph = 0;
      entry.runs.forEach((run, slot) => {
        const record = runs + slot * 24;
        view.setUint32(record, run.command, true);
        view.setUint32(record + 4, gpu.importResource(run.atlas), true);
        view.setUint32(record + 8, glyph, true);
        view.setFloat64(record + 16, run.upem, true);
        for (const information of run.infos) {
          const info = infos + glyph * 96;
          glyph++;
          if (!information) continue;
          const { metrics } = information;
          view.setUint32(info, 1, true);
          [information.w, information.h, information.u, information.v, information.uW, information.vH,
            metrics.bboxXMin, metrics.bboxYMin, metrics.bboxXMax, metrics.bboxYMax]
            .forEach((value, field) => view.setFloat64(info + 8 + field * 8, value, true));
        }
      });
      cursor += glyph * 96;
      view.setUint32(at + 64, runs, true);
      view.setUint32(at + 68, entry.runs.length, true);
      view.setUint32(at + 72, infos, true);
      view.setUint32(at + 76, bitmapFormat(entry.format), true);
      if (source !== null) {
        view.setUint32(at + 80, source.width, true);
        view.setUint32(at + 84, source.height, true);
        view.setUint32(at + 88, source.opaque ? 1 : 0, true);
        view.setUint32(at + 92, source.persistent ? 1 : 0, true);
        view.setUint32(at + 96, entry.kept === null ? 0 : gpu.importResource(entry.kept), true);
      }
    });
    core.gpu_canvas_rasterize(rasterState, blurState, colorState, frames, input);
    gpu.execute();
    const result = new DataView(core.memory.buffer);
    if (result.getUint32(input + 36, true) !== 0) {
      throw new RangeError('Canvas 2D blur: an image lacks its one-pixel transparent border');
    }
    entries.forEach((entry, index) => {
      if (entry.source?.persistent && entry.kept === null) {
        entry.source.textures ??= new Map();
        entry.source.textures.set(device, gpu.resource(result.getUint32(input + 48 + index * LIST_SIZE + 132, true)));
      }
    });
    if (commandListObserver !== null) observeJobs(core, input, entries);
  } finally {
    glyphs?.release();
    if (input !== 0) core.abi_free(input);
  }
}

function observeJobs(core, input, entries) {
  const view = new DataView(core.memory.buffer);
  const log = view.getUint32(input + 40, true);
  const end = log + view.getUint32(input + 44, true);
  for (let at = log; at < end;) {
    const index = view.getUint32(at, true);
    const count = view.getUint32(at + 16, true);
    const composited = view.getUint32(input + 48 + index * LIST_SIZE + 100, true);
    const bytes = new Uint8Array(count * COMMAND_SIZE);
    for (let position = 0; position < count; position++) {
      const command = view.getUint32(at + 20 + position * 4, true);
      bytes.set(new Uint8Array(core.memory.buffer, composited + command * COMMAND_SIZE, COMMAND_SIZE), position * COMMAND_SIZE);
    }
    const { list } = entries[index];
    commandListObserver({
      width: view.getUint32(at + 4, true),
      height: view.getUint32(at + 8, true),
      multisampled: view.getUint32(at + 12, true) !== 0,
      bytes,
      geometry: list.geometry.slice(),
      fonts: list.fonts,
    });
    at += 20 + count * 4;
  }
}

// A source's bitmap on `device` for a copy: { draw() -> texture, release() }.
// A commands source without a kept bitmap draws into a temporary one.
export function sourceRaster(device, source) {
  if (source.kind === 'image') {
    return { draw: () => decodedImageTexture(device, source.image), release() {} };
  }
  if (source.kind === 'texture') {
    return { draw: () => textureOnDevice(device, source), release() {} };
  }
  const kept = source.persistent ? source.textures?.get(device) : undefined;
  if (kept !== undefined) return { draw: () => kept, release() {} };
  let texture = null;
  return {
    draw() {
      texture = createBitmapTexture(device, source.width, source.height, source.format);
      const target = { texture, width: source.width, height: source.height, opaque: source.opaque, colorSpace: source.colorSpace };
      rasterizeCommands(device, target, source.list, true);
      return texture;
    },
    release() { texture?.destroy(); },
  };
}

// --------------------------------------------------------------- copies

function copyInput(device, description, upload = null) {
  const { core, gpu } = bindingFor(device);
  const format = formats.indexOf(description.format);
  if (format < 0) throw new DOMException(`GPUQueue.copyExternalImageToTexture: texture format ${description.format} is unsupported`, 'NotSupportedError');
  const input = gpu.input(96 + (upload?.bytes.byteLength ?? 0));
  new Uint32Array(core.memory.buffer, input.byteOffset, 24).set([
    0, 0, format, description.width, description.height, description.sourceX, description.sourceY,
    description.targetX, description.targetY, description.flipY ? 1 : 0,
    description.sourceKind, description.sourceColorSpace === 'display-p3' ? 1 : 0,
    description.targetColorSpace === 'display-p3' ? 1 : 0, description.opaque ? 1 : 0,
    description.premultiplied ? 1 : 0, description.targetUsage ?? 0,
    upload === null ? 0 : input.byteOffset + 96, upload?.bytes.byteLength ?? 0,
    upload === null ? 0 : bitmapFormat(upload.format), description.imageWidth ?? 0, description.imageHeight ?? 0,
    description.originClean === false ? 0 : 1, description.depth ?? 1, 0,
  ]);
  if (upload !== null) {
    new Uint8Array(core.memory.buffer, input.byteOffset + 96, upload.bytes.byteLength)
      .set(new Uint8Array(upload.bytes.buffer, upload.bytes.byteOffset, upload.bytes.byteLength));
  }
  return { core, gpu, input };
}

// The host supplies resource identities and bounded source metadata. WAT
// selects copy/conversion, uniforms, pipeline, commands, and resource lifetime.
export function copyCanvasTexture(device, source, target, description, upload = null) {
  const { core, gpu, state } = bindingFor(device);
  gpu.beginFrame();
  const { input } = copyInput(device, { ...description, targetUsage: target?.usage }, upload);
  const words = new Uint32Array(core.memory.buffer, input.byteOffset, 2);
  words[0] = source === null ? 0 : gpu.importResource(source);
  words[1] = target === null ? 0 : gpu.importResource(target);
  const handle = core.gpu_canvas_copy(state, input.byteOffset);
  gpu.execute();
  return gpu.resource(handle);
}

// The current texture of a WebGPU canvas `frame` (src/dom/canvas.js) as a
// "texture" source: a bitmap copy on its device in the order of its queue.
export function canvasFrameSource(frame) {
  const { device, width, height, format } = frame;
  const opaque = frame.alphaMode === 'opaque';
  return {
    kind: 'texture',
    device,
    texture: copyCanvasTexture(device, frame.texture, null, {
      format, width, height, sourceX: 0, sourceY: 0, targetX: 0, targetY: 0,
      flipY: false, sourceKind: 0, sourceColorSpace: frame.colorSpace,
      targetColorSpace: 'srgb', opaque, premultiplied: true,
    }),
    width,
    height,
    opaque,
    format: BITMAP_FORMAT,
    references: 0,
  };
}

let sandomImageSources = { test: () => false, resolve: null, retain: null, release: null };

// The Canvas 2D side registers how it recognizes, resolves, retains and
// releases a Sandom image source (src/dom/canvas-2d.js). `resolve(member,
// value)` gives { image, upload }: a resolved source ({ source, width,
// height, originClean }, or an ImageData's { width, height, originClean,
// bytes, format, colorSpace } with `upload` "straight"), or a null image
// for an image that is not fully decodable, which copies nothing.
export function registerSandomImageSources(sources) {
  sandomImageSources = sources;
}

function integer(value, fallback) {
  if (value === undefined) return fallback;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : 0;
}

// GPUOrigin2D or the x and y of a GPUOrigin3D.
function origin2D(value) {
  if (value === undefined) return [0, 0];
  if (typeof value?.[Symbol.iterator] === 'function') {
    const values = [...value];
    return [integer(values[0], 0), integer(values[1], 0)];
  }
  return [integer(value.x, 0), integer(value.y, 0)];
}

// GPUExtent3D: width, height (1 by default) and depthOrArrayLayers (1).
function extent3D(value) {
  if (typeof value?.[Symbol.iterator] === 'function') {
    const values = [...value];
    return [integer(values[0], 0), integer(values[1], 1), integer(values[2], 1)];
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError("GPUQueue.copyExternalImageToTexture: copySize is not of type 'GPUExtent3D'.");
  }
  return [integer(value.width, 0), integer(value.height, 1), integer(value.depthOrArrayLayers, 1)];
}

const COPY_ERRORS = [
  null,
  ['The external image is tainted by cross-origin data.', 'SecurityError'],
  ['Copy rect is out of bounds of external image', 'OperationError'],
];

// GPUQueue.copyExternalImageToTexture() with a Sandom source, as Chrome
// copies a canvas source with Dawn's CopyTextureForBrowser. Renderer-core
// checks the copy and selects its passes; the destination's own
// validation reports through the native operations of the copy.
function copyExternalImage(device, sourceInfo, destination, copySize) {
  const member = 'GPUQueue.copyExternalImageToTexture';
  const value = sourceInfo?.source;
  if (value === null || typeof value !== 'object' || !sandomImageSources.test(value)) {
    throw new TypeError(
      "GPUQueue.copyExternalImageToTexture: Failed to read the 'source' property from 'GPUImageCopyExternalImage': The provided value is not of type '(HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or VideoFrame)'.",
    );
  }
  const { image, upload } = sandomImageSources.resolve(member, value, device);
  if (image === null) return true;
  const straight = upload === 'straight';
  const origin = origin2D(sourceInfo.origin);
  const [width, height, depth] = extent3D(copySize);
  const destinationOrigin = origin2D(destination.origin);
  const texture = destination.texture;
  const description = {
    format: texture.format, width, height, sourceX: origin[0], sourceY: origin[1],
    targetX: destinationOrigin[0], targetY: destinationOrigin[1], flipY: Boolean(sourceInfo.flipY),
    sourceKind: straight ? 2 : 1,
    sourceColorSpace: (straight ? image.colorSpace : image.source.colorSpace) ?? 'srgb',
    targetColorSpace: destination.colorSpace ?? 'srgb', opaque: false,
    premultiplied: Boolean(destination.premultipliedAlpha),
    imageWidth: image.width, imageHeight: image.height, originClean: Boolean(image.originClean), depth,
  };
  const { core, input } = copyInput(device, description);
  const status = core.gpu_canvas_copy_check(input.byteOffset);
  if (status === 1 || status === 2) throw new DOMException(`${member}: ${COPY_ERRORS[status][0]}`, COPY_ERRORS[status][1]);
  if (status === 3) return true;
  if (straight) {
    copyCanvasTexture(device, null, texture, description, { bytes: image.bytes, format: image.format });
    return true;
  }
  sandomImageSources.retain(image.source);
  try {
    // The raster stays in the source's color space; the copy converts it
    // in float into the destination's.
    const raster = sourceRaster(device, image.source);
    try {
      copyCanvasTexture(device, raster.draw(), texture, description);
    } finally {
      raster.release();
    }
  } finally {
    sandomImageSources.release(image.source);
  }
  return true;
}
setGpuThreadExternalImageCopy((queue, sourceInfo, destination, copySize) =>
  copyExternalImage(gpuThreadQueueDevice(queue), sourceInfo, destination, copySize));

// -------------------------------------------------------------- readback

function readTextureRegion(device, texture, width, height, format, x, y, targetFormat, operation) {
  let binding;
  let token;
  const formatIndex = ['rgba8unorm', 'rgba16float'].indexOf(format);
  try {
    if (formatIndex < 0) throw new TypeError(`Canvas readback format ${format} is unsupported; copy to rgba8unorm or rgba16float first`);
    binding = bindingFor(device);
    const { core, gpu, readbackState } = binding;
    gpu.beginFrame();
    token = core.gpu_canvas_readback_begin(readbackState, gpu.importResource(texture), width, height, formatIndex, x, y, targetFormat);
    gpu.execute();
  } catch (error) {
    operation.throw(error);
    return;
  }
  binding.gpu.completion(token, {
    reply() { operation.reply(binding, formatIndex); },
    throw(error) { operation.throw(error); },
  });
}

// Bytes belong to the binding and are valid during reply. A consumer that
// retains them copies its addressed span before returning from reply.
export function readCanvasTexture(device, texture, width, height, format, operation) {
  readTextureRegion(device, texture, width, height, format, 0, 0, format === 'rgba16float' ? 1 : 0, {
    reply({ core, readbackState }, formatIndex) {
      const pointer = new DataView(core.memory.buffer).getUint32(readbackState + 12, true);
      operation.reply(new Uint8Array(core.memory.buffer, pointer, width * height * (formatIndex === 1 ? 8 : 4)));
    },
    throw(error) { operation.throw(error); },
  });
}

// The premultiplied RGBA samples of a bitmap texture, row by row: a
// Uint8Array of an rgba8unorm bitmap, a Float16Array of an rgba16float one.
export function readBitmapTexture(device, texture, width, height) {
  let samples;
  readCanvasTexture(device, texture, width, height, texture.format, {
    reply(mapped) {
      const bytes = mapped.slice();
      samples = texture.format === 'rgba16float' ? new Float16Array(bytes.buffer) : bytes;
    },
    throw(error) { throw error; },
  });
  return samples;
}

export function readCanvasImageData(device, texture, region, sourceColorSpace, opaque, imageData, operation) {
  const format = imageData.pixelFormat === 'rgba-float16' ? 1 : 0;
  readTextureRegion(device, texture, region[4], region[5], texture.format, region[2], region[3], format, {
    reply({ core, readbackState }) {
      try {
        const pointer = core.gpu_canvas_pixels(readbackState, region[0], region[6], region[7], format,
          sourceColorSpace === 'display-p3' ? 1 : 0, imageData.colorSpace === 'display-p3' ? 1 : 0, opaque ? 1 : 0);
        const spans = new Uint32Array(core.memory.buffer, pointer, region[5] * 3);
        const destination = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
        for (let index = 0; index < spans.length; index += 3) {
          destination.set(new Uint8Array(core.memory.buffer, spans[index + 1], spans[index + 2]), spans[index]);
        }
      } catch (error) {
        operation.throw(error);
        return;
      }
      operation.reply(imageData);
    },
    throw(error) { operation.throw(error); },
  });
}

export function readCanvasEncodingPixels(device, texture, width, height, jpeg, opaque, operation) {
  readTextureRegion(device, texture, width, height, texture.format, 0, 0, 0, {
    reply({ core, readbackState }) {
      let samples;
      try {
        const pointer = core.gpu_canvas_encode_pixels(readbackState, jpeg ? 1 : 0, opaque ? 1 : 0);
        const descriptor = new Uint32Array(core.memory.buffer, pointer, 4);
        const bitDepth = descriptor[2];
        const pixels = bitDepth === 16
          ? new Uint16Array(core.memory.buffer, descriptor[0], descriptor[1] / 2)
          : new Uint8Array(core.memory.buffer, descriptor[0], descriptor[1]);
        samples = { pixels, bitDepth, channelLayout: descriptor[3] === 3 ? 'rgb' : 'rgba' };
      } catch (error) {
        operation.throw(error);
        return;
      }
      operation.reply(samples);
    },
    throw(error) { operation.throw(error); },
  });
}
