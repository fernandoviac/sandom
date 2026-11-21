// The Canvas 2D GPU binding (docs/specifications/gpu-command-stream.md).
// Renderer-core decides every Canvas GPU operation: bitmaps, image
// conversion, the draw execution of a command list with its layers,
// filters, shadows, masks and copies, readback and pixel conversion. This
// module transports host objects and bounded inputs into renderer-core
// memory, executes the records through the GPU binding, and keeps the
// caller-owned textures with the host objects that own them.
import { instantiateRendererCore } from '../wasm/renderer-core-binary.js';
import { CoreOperations, observeMemoryGrowth } from '../dom-wasm/core.js';
import { createGpuBinding } from '../gpu-binding.js';
import { canvasUnpremultiplyTable } from '../canvas-unpremultiply.js';
import { composeShaderBytes, shaderLibraryFor } from '../shaders/compose.js';
import { GlyphResourceManager } from '../glyph-resource-manager.js';
import { imageUploadRepresentation } from '../image-data.js';
import { imageConversionUniform } from '../image-conversion.js';
import { gpuThreadQueueDevice, setGpuThreadExternalImageCopy } from './webgpu-facade.js';
import { layoutConstant, moduleLayoutConstants } from '../wasm/layout-table.js';
import * as canvas2dBinary from '../wasm/canvas-2d-binary.js';

const CANVAS_COPY_KIND = Object.freeze(Object.fromEntries(['FRAME', 'BITMAP', 'IMAGE_DATA']
  .map((name) => [name, layoutConstant(`CANVAS_COPY_KIND_${name}`)])));
const CANVAS_COPY_STATUS = Object.freeze(Object.fromEntries(['TAINTED', 'OUTSIDE', 'EMPTY']
  .map((name) => [name, layoutConstant(`CANVAS_COPY_STATUS_${name}`)])));
const CANVAS_FORMAT_RGBA8UNORM = layoutConstant('CANVAS_FORMAT_RGBA8UNORM');
const CANVAS_FORMAT_RGBA16FLOAT = layoutConstant('CANVAS_FORMAT_RGBA16FLOAT');
// The Canvas flush, copy and readback records (gpu-canvas-flush, -copy and
// -readback watparts), keyed by their name without the CANVAS_ prefix.
const CANVAS = Object.freeze(Object.fromEntries([
  'FLUSH_SIZE', 'FLUSH_TARGET', 'FLUSH_WIDTH', 'FLUSH_HEIGHT', 'FLUSH_OPAQUE', 'FLUSH_FORMAT', 'FLUSH_CLEAR',
  'FLUSH_LIST_COUNT', 'FLUSH_LISTS', 'FLUSH_OBSERVE', 'FLUSH_STATUS', 'FLUSH_JOB_LOG', 'FLUSH_JOB_LOG_LENGTH',
  'LIST_SIZE', 'LIST_SPANS', 'LIST_SOURCES', 'LIST_SOURCE_COUNT', 'LIST_PAYLOADS', 'LIST_PAYLOAD_COUNT',
  'LIST_GLYPH_RUNS', 'LIST_GLYPH_RUN_COUNT', 'LIST_GLYPHS', 'LIST_FORMAT', 'LIST_WIDTH', 'LIST_HEIGHT',
  'LIST_OPAQUE', 'LIST_PERSISTENT', 'LIST_KEPT_TEXTURE', 'LIST_COMPOSITED', 'LIST_TEXTURE',
  'SPAN_SIZE', 'SPAN_POINTER', 'SPAN_LENGTH',
  'SOURCE_SIZE', 'SOURCE_KIND', 'SOURCE_VALUE', 'SOURCE_KIND_TEXTURE', 'SOURCE_KIND_LIST',
  'PAYLOAD_SIZE', 'PAYLOAD_BYTES', 'PAYLOAD_LENGTH', 'PAYLOAD_WIDTH', 'PAYLOAD_HEIGHT', 'PAYLOAD_FORMAT',
  'GLYPH_RUN_SIZE', 'GLYPH_RUN_COMMAND', 'GLYPH_RUN_ATLAS', 'GLYPH_RUN_FIRST', 'GLYPH_RUN_UNITS_PER_EM',
  'GLYPH_SIZE', 'GLYPH_PRESENT', 'GLYPH_WIDTH', 'GLYPH_HEIGHT', 'GLYPH_U', 'GLYPH_V', 'GLYPH_U_WIDTH',
  'GLYPH_V_HEIGHT', 'GLYPH_BOX_X_MINIMUM', 'GLYPH_BOX_Y_MINIMUM', 'GLYPH_BOX_X_MAXIMUM', 'GLYPH_BOX_Y_MAXIMUM',
  'JOB_LOG_LIST', 'JOB_LOG_WIDTH', 'JOB_LOG_HEIGHT', 'JOB_LOG_MULTISAMPLED', 'JOB_LOG_COUNT', 'JOB_LOG_COMMANDS',
  'COPY_SIZE', 'COPY_SOURCE', 'COPY_TARGET', 'COPY_FORMAT', 'COPY_WIDTH', 'COPY_HEIGHT', 'COPY_SOURCE_X',
  'COPY_SOURCE_Y', 'COPY_TARGET_X', 'COPY_TARGET_Y', 'COPY_FLIP', 'COPY_SOURCE_KIND', 'COPY_SOURCE_SPACE',
  'COPY_TARGET_SPACE', 'COPY_SOURCE_OPAQUE', 'COPY_TARGET_PREMULTIPLIED', 'COPY_TARGET_USAGE', 'COPY_UPLOAD',
  'COPY_UPLOAD_LENGTH', 'COPY_UPLOAD_FORMAT', 'COPY_IMAGE_WIDTH', 'COPY_IMAGE_HEIGHT', 'COPY_ORIGIN_CLEAN',
  'COPY_DEPTH', 'READBACK_BYTES',
  'IMAGE_INPUT_SIZE', 'IMAGE_INPUT_WIDTH', 'IMAGE_INPUT_HEIGHT', 'IMAGE_INPUT_FORMAT', 'IMAGE_INPUT_SAMPLE_KIND',
  'IMAGE_INPUT_UPLOAD', 'IMAGE_INPUT_UPLOAD_LENGTH', 'IMAGE_INPUT_ROW_BYTES', 'IMAGE_INPUT_UNIFORM', 'IMAGE_UNIFORM_SIZE',
  'ENCODE_SIZE', 'ENCODE_PIXELS', 'ENCODE_LENGTH', 'ENCODE_BIT_DEPTH', 'ENCODE_CHANNELS',
].map((name) => [name, layoutConstant(`CANVAS_${name}`)])));

const formats = ['rgba8unorm', 'rgba16float', 'rgba16uint', 'rgba32float',
  'r8unorm', 'r8uint', 'depth24plus-stencil8', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb'];
const bindings = new WeakMap();
let canvasCore;
let canvasOperations;

// The record size of a Canvas 2D command (canvas-2d-core.watpart).
const canvasConstant = moduleLayoutConstants(canvas2dBinary, 'canvas 2d');
export const COMMAND_SIZE = canvasConstant('COMMAND_SIZE');
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
  return format === 'rgba16float' ? CANVAS_FORMAT_RGBA16FLOAT : CANVAS_FORMAT_RGBA8UNORM;
}

// The renderer core of Canvas 2D execution: its exports, which record their
// operations so an output is read only through canvasOperations.
function executionCore() {
  if (canvasCore === undefined) {
    const { exports } = instantiateRendererCore();
    canvasOperations = new CoreOperations(exports);
    canvasCore = observeMemoryGrowth(exports.memory, exports, () => {}, canvasOperations);
  }
  return canvasCore;
}

const CANVAS_SPACES = new Map([['srgb', 0], ['display-p3', 1]]);

// The matrix, by rows, from linear `source` to linear `destination`, both
// canvas color spaces (canvas_gamut_rows: Skia's matrix through XYZ D50).
export function canvasGamutRows(source, destination) {
  const from = CANVAS_SPACES.get(source);
  const to = CANVAS_SPACES.get(destination);
  if (from === undefined || to === undefined) {
    throw new Error(`Canvas 2D color space conversion from ${source} to ${destination}: expected "srgb" or "display-p3"`);
  }
  const core = executionCore();
  if (core.canvas_gamut_rows(from, to) !== 1) throw new Error('canvas_gamut_rows failed');
  const entries = new Float64Array(canvasOperations.outputBytes('canvas_gamut_rows', 0, 9 * 8).buffer);
  return [0, 3, 6].map((start) => Array.from(entries.subarray(start, start + 3)));
}

function bindingFor(device) {
  let binding = bindings.get(device);
  if (binding !== undefined) return binding;
  const core = executionCore();
  const gpu = createGpuBinding(core, device, { label: "2d canvas" });
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

const imageTextures = new WeakMap();

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
  // The standard uniform (sRGB-encoded output, premultiplied in float)
  // with the matrix into the bitmap's primaries.
  const uniforms = imageConversionUniform(descriptor, 'standard', colorSpace);
  const { core, gpu, imageState } = bindingFor(device);
  gpu.beginFrame();
  const uniformAt = CANVAS.IMAGE_INPUT_SIZE;
  const uploadAt = uniformAt + CANVAS.IMAGE_UNIFORM_SIZE;
  const input = gpu.input(uploadAt + bytes.length);
  const view = new DataView(core.memory.buffer, input.byteOffset, CANVAS.IMAGE_INPUT_SIZE);
  view.setUint32(CANVAS.IMAGE_INPUT_WIDTH, width, true);
  view.setUint32(CANVAS.IMAGE_INPUT_HEIGHT, height, true);
  view.setUint32(CANVAS.IMAGE_INPUT_FORMAT, formats.indexOf(upload.format), true);
  view.setUint32(CANVAS.IMAGE_INPUT_SAMPLE_KIND, upload.sampleKind === 'uint' ? 1 : 0, true);
  view.setUint32(CANVAS.IMAGE_INPUT_UPLOAD, input.byteOffset + uploadAt, true);
  view.setUint32(CANVAS.IMAGE_INPUT_UPLOAD_LENGTH, bytes.length, true);
  view.setUint32(CANVAS.IMAGE_INPUT_ROW_BYTES, upload.bytesPerRow, true);
  view.setUint32(CANVAS.IMAGE_INPUT_UNIFORM, input.byteOffset + uniformAt, true);
  new Float32Array(core.memory.buffer, input.byteOffset + uniformAt, CANVAS.IMAGE_UNIFORM_SIZE / Float32Array.BYTES_PER_ELEMENT)
    .set(uniforms);
  new Uint8Array(core.memory.buffer, input.byteOffset + uploadAt, bytes.length).set(bytes);
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
// The glyph run command of canvas-2d-glyphs.watpart, by WAT name.
const GLYPH_RUN = Object.freeze(Object.fromEntries(["KIND", "FIRST", "MAXIMUM_SCALE", "COUNT", "FONT", "FONT_SIZE"]
  .map((name) => [name, canvasConstant(`GLYPH_RUN_${name}`)])));
const COMMAND_KIND = canvasConstant("COMMAND_KIND");

// The glyph runs of each list, with the atlas glyph records that
// renderer-core places as instances. Returns { runs: Map(list -> run
// array), release } or null without glyph runs.
function prepareGlyphs(lists, device) {
  const runs = [];
  const requests = [];
  const requestIndices = new Map();
  for (const list of lists) {
    const view = new DataView(list.bytes.buffer, list.bytes.byteOffset, list.bytes.byteLength);
    const floats = new Float32Array(list.geometry.buffer, list.geometry.byteOffset,
      list.geometry.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let offset = 0; offset < list.bytes.length; offset += COMMAND_SIZE) {
      if (view.getUint32(offset + COMMAND_KIND, true) !== GLYPH_RUN.KIND) continue;
      const font = list.fonts[view.getUint32(offset + GLYPH_RUN.FONT, true)];
      const devicePixelSize = view.getFloat32(offset + GLYPH_RUN.FONT_SIZE, true) *
        view.getFloat32(offset + GLYPH_RUN.MAXIMUM_SCALE, true);
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
      const first = view.getUint32(offset + GLYPH_RUN.FIRST, true);
      const count = view.getUint32(offset + GLYPH_RUN.COUNT, true);
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
    let length = CANVAS.FLUSH_SIZE + entries.length * CANVAS.LIST_SIZE;
    for (const entry of entries) {
      const { list: commands } = entry;
      entry.runs = glyphs?.runs.get(commands) ?? [];
      const glyphCount = entry.runs.reduce((sum, run) => sum + run.infos.length, 0);
      length += align(commands.bytes.length) + align(commands.geometry.length) + align(commands.clips.length) +
        align(commands.masks.length) + align(commands.maskGeometry.length) + align(commands.paints.length) +
        align(commands.sources.length * CANVAS.SOURCE_SIZE) + align(commands.payloads.length * CANVAS.PAYLOAD_SIZE) +
        commands.payloads.reduce((sum, payload) => sum + align(payload.bytes.byteLength), 0) +
        entry.runs.length * CANVAS.GLYPH_RUN_SIZE + glyphCount * CANVAS.GLYPH_SIZE;
    }
    // A retained block: the finally below frees it. A transient abi_allocate
    // block would also be freed at the next DOM core operation.
    input = core.abi_malloc(length);
    if (input === 0) throw new Error(`renderer-core could not allocate ${length} bytes of Canvas input`);
    const memory = new Uint8Array(core.memory.buffer);
    const view = new DataView(core.memory.buffer);
    memory.fill(0, input, input + length);
    let cursor = input + CANVAS.FLUSH_SIZE + entries.length * CANVAS.LIST_SIZE;
    const place = (bytes) => {
      const at = cursor;
      memory.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), at);
      cursor += align(bytes.byteLength);
      return [at, bytes.byteLength];
    };
    view.setUint32(input + CANVAS.FLUSH_TARGET, gpu.importResource(target.texture), true);
    view.setUint32(input + CANVAS.FLUSH_WIDTH, target.width, true);
    view.setUint32(input + CANVAS.FLUSH_HEIGHT, target.height, true);
    view.setUint32(input + CANVAS.FLUSH_OPAQUE, target.opaque ? 1 : 0, true);
    view.setUint32(input + CANVAS.FLUSH_FORMAT, bitmapFormat(target.texture.format), true);
    view.setUint32(input + CANVAS.FLUSH_CLEAR, clear ? 1 : 0, true);
    view.setUint32(input + CANVAS.FLUSH_LIST_COUNT, entries.length, true);
    view.setUint32(input + CANVAS.FLUSH_LISTS, input + CANVAS.FLUSH_SIZE, true);
    view.setUint32(input + CANVAS.FLUSH_OBSERVE, commandListObserver === null ? 0 : 1, true);
    entries.forEach((entry, index) => {
      const at = input + CANVAS.FLUSH_SIZE + index * CANVAS.LIST_SIZE;
      const { list: commands, source } = entry;
      const spans = [commands.bytes, commands.geometry, commands.clips, commands.masks, commands.maskGeometry, commands.paints];
      spans.forEach((bytes, span) => {
        const [pointer, byteLength] = place(bytes);
        const spanRecord = at + CANVAS.LIST_SPANS + span * CANVAS.SPAN_SIZE;
        view.setUint32(spanRecord + CANVAS.SPAN_POINTER, pointer, true);
        view.setUint32(spanRecord + CANVAS.SPAN_LENGTH, byteLength, true);
      });
      const sources = cursor;
      commands.sources.forEach((value, slot) => {
        const record = sources + slot * CANVAS.SOURCE_SIZE;
        if (value?.kind === 'commands') {
          view.setUint32(record + CANVAS.SOURCE_KIND, CANVAS.SOURCE_KIND_LIST, true);
          view.setUint32(record + CANVAS.SOURCE_VALUE, listIndices.get(value), true);
        } else if (entry.textures[slot] !== null) {
          view.setUint32(record + CANVAS.SOURCE_KIND, CANVAS.SOURCE_KIND_TEXTURE, true);
          view.setUint32(record + CANVAS.SOURCE_VALUE, gpu.importResource(entry.textures[slot]), true);
        }
      });
      cursor += align(commands.sources.length * CANVAS.SOURCE_SIZE);
      view.setUint32(at + CANVAS.LIST_SOURCES, sources, true);
      view.setUint32(at + CANVAS.LIST_SOURCE_COUNT, commands.sources.length, true);
      const payloads = cursor;
      cursor += align(commands.payloads.length * CANVAS.PAYLOAD_SIZE);
      commands.payloads.forEach((payload, slot) => {
        const record = payloads + slot * CANVAS.PAYLOAD_SIZE;
        const [pointer, byteLength] = place(payload.bytes);
        view.setUint32(record + CANVAS.PAYLOAD_BYTES, pointer, true);
        view.setUint32(record + CANVAS.PAYLOAD_LENGTH, byteLength, true);
        view.setUint32(record + CANVAS.PAYLOAD_WIDTH, payload.width, true);
        view.setUint32(record + CANVAS.PAYLOAD_HEIGHT, payload.height, true);
        view.setUint32(record + CANVAS.PAYLOAD_FORMAT, bitmapFormat(payload.format), true);
      });
      view.setUint32(at + CANVAS.LIST_PAYLOADS, payloads, true);
      view.setUint32(at + CANVAS.LIST_PAYLOAD_COUNT, commands.payloads.length, true);
      const runs = cursor;
      cursor += entry.runs.length * CANVAS.GLYPH_RUN_SIZE;
      const infos = cursor;
      let glyph = 0;
      entry.runs.forEach((run, slot) => {
        const record = runs + slot * CANVAS.GLYPH_RUN_SIZE;
        view.setUint32(record + CANVAS.GLYPH_RUN_COMMAND, run.command, true);
        view.setUint32(record + CANVAS.GLYPH_RUN_ATLAS, gpu.importResource(run.atlas), true);
        view.setUint32(record + CANVAS.GLYPH_RUN_FIRST, glyph, true);
        view.setFloat64(record + CANVAS.GLYPH_RUN_UNITS_PER_EM, run.upem, true);
        for (const information of run.infos) {
          const info = infos + glyph * CANVAS.GLYPH_SIZE;
          glyph++;
          if (!information) continue;
          const { metrics } = information;
          view.setUint32(info + CANVAS.GLYPH_PRESENT, 1, true);
          view.setFloat64(info + CANVAS.GLYPH_WIDTH, information.w, true);
          view.setFloat64(info + CANVAS.GLYPH_HEIGHT, information.h, true);
          view.setFloat64(info + CANVAS.GLYPH_U, information.u, true);
          view.setFloat64(info + CANVAS.GLYPH_V, information.v, true);
          view.setFloat64(info + CANVAS.GLYPH_U_WIDTH, information.uW, true);
          view.setFloat64(info + CANVAS.GLYPH_V_HEIGHT, information.vH, true);
          view.setFloat64(info + CANVAS.GLYPH_BOX_X_MINIMUM, metrics.bboxXMin, true);
          view.setFloat64(info + CANVAS.GLYPH_BOX_Y_MINIMUM, metrics.bboxYMin, true);
          view.setFloat64(info + CANVAS.GLYPH_BOX_X_MAXIMUM, metrics.bboxXMax, true);
          view.setFloat64(info + CANVAS.GLYPH_BOX_Y_MAXIMUM, metrics.bboxYMax, true);
        }
      });
      cursor += glyph * CANVAS.GLYPH_SIZE;
      view.setUint32(at + CANVAS.LIST_GLYPH_RUNS, runs, true);
      view.setUint32(at + CANVAS.LIST_GLYPH_RUN_COUNT, entry.runs.length, true);
      view.setUint32(at + CANVAS.LIST_GLYPHS, infos, true);
      view.setUint32(at + CANVAS.LIST_FORMAT, bitmapFormat(entry.format), true);
      if (source !== null) {
        view.setUint32(at + CANVAS.LIST_WIDTH, source.width, true);
        view.setUint32(at + CANVAS.LIST_HEIGHT, source.height, true);
        view.setUint32(at + CANVAS.LIST_OPAQUE, source.opaque ? 1 : 0, true);
        view.setUint32(at + CANVAS.LIST_PERSISTENT, source.persistent ? 1 : 0, true);
        view.setUint32(at + CANVAS.LIST_KEPT_TEXTURE, entry.kept === null ? 0 : gpu.importResource(entry.kept), true);
      }
    });
    core.gpu_canvas_rasterize(rasterState, blurState, colorState, frames, input);
    gpu.execute();
    const result = new DataView(core.memory.buffer);
    if (result.getUint32(input + CANVAS.FLUSH_STATUS, true) !== 0) {
      throw new RangeError('Canvas 2D blur: an image lacks its one-pixel transparent border');
    }
    entries.forEach((entry, index) => {
      if (entry.source?.persistent && entry.kept === null) {
        entry.source.textures ??= new Map();
        const list = input + CANVAS.FLUSH_SIZE + index * CANVAS.LIST_SIZE;
        entry.source.textures.set(device, gpu.resource(result.getUint32(list + CANVAS.LIST_TEXTURE, true)));
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
  const log = view.getUint32(input + CANVAS.FLUSH_JOB_LOG, true);
  const end = log + view.getUint32(input + CANVAS.FLUSH_JOB_LOG_LENGTH, true);
  for (let at = log; at < end;) {
    const index = view.getUint32(at + CANVAS.JOB_LOG_LIST, true);
    const count = view.getUint32(at + CANVAS.JOB_LOG_COUNT, true);
    const composited = view.getUint32(input + CANVAS.FLUSH_SIZE + index * CANVAS.LIST_SIZE + CANVAS.LIST_COMPOSITED, true);
    const bytes = new Uint8Array(count * COMMAND_SIZE);
    for (let position = 0; position < count; position++) {
      const command = view.getUint32(at + CANVAS.JOB_LOG_COMMANDS + position * Uint32Array.BYTES_PER_ELEMENT, true);
      bytes.set(new Uint8Array(core.memory.buffer, composited + command * COMMAND_SIZE, COMMAND_SIZE), position * COMMAND_SIZE);
    }
    const { list } = entries[index];
    commandListObserver({
      width: view.getUint32(at + CANVAS.JOB_LOG_WIDTH, true),
      height: view.getUint32(at + CANVAS.JOB_LOG_HEIGHT, true),
      multisampled: view.getUint32(at + CANVAS.JOB_LOG_MULTISAMPLED, true) !== 0,
      bytes,
      geometry: list.geometry.slice(),
      fonts: list.fonts,
    });
    at += CANVAS.JOB_LOG_COMMANDS + count * 4;
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
  const input = gpu.input(CANVAS.COPY_SIZE + (upload?.bytes.byteLength ?? 0));
  const fields = [
    ['COPY_SOURCE', 0], ['COPY_TARGET', 0], ['COPY_FORMAT', format], ['COPY_WIDTH', description.width],
    ['COPY_HEIGHT', description.height], ['COPY_SOURCE_X', description.sourceX], ['COPY_SOURCE_Y', description.sourceY],
    ['COPY_TARGET_X', description.targetX], ['COPY_TARGET_Y', description.targetY], ['COPY_FLIP', description.flipY ? 1 : 0],
    ['COPY_SOURCE_KIND', description.sourceKind],
    ['COPY_SOURCE_SPACE', description.sourceColorSpace === 'display-p3' ? 1 : 0],
    ['COPY_TARGET_SPACE', description.targetColorSpace === 'display-p3' ? 1 : 0],
    ['COPY_SOURCE_OPAQUE', description.opaque ? 1 : 0], ['COPY_TARGET_PREMULTIPLIED', description.premultiplied ? 1 : 0],
    ['COPY_TARGET_USAGE', description.targetUsage ?? 0],
    ['COPY_UPLOAD', upload === null ? 0 : input.byteOffset + CANVAS.COPY_SIZE],
    ['COPY_UPLOAD_LENGTH', upload?.bytes.byteLength ?? 0],
    ['COPY_UPLOAD_FORMAT', upload === null ? 0 : bitmapFormat(upload.format)],
    ['COPY_IMAGE_WIDTH', description.imageWidth ?? 0], ['COPY_IMAGE_HEIGHT', description.imageHeight ?? 0],
    ['COPY_ORIGIN_CLEAN', description.originClean === false ? 0 : 1], ['COPY_DEPTH', description.depth ?? 1],
  ];
  new Uint8Array(core.memory.buffer, input.byteOffset, CANVAS.COPY_SIZE).fill(0);
  for (const [field, value] of fields) input.setUint32(CANVAS[field], value, true);
  if (upload !== null) {
    new Uint8Array(core.memory.buffer, input.byteOffset + CANVAS.COPY_SIZE, upload.bytes.byteLength)
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
  input.setUint32(CANVAS.COPY_SOURCE, source === null ? 0 : gpu.importResource(source), true);
  input.setUint32(CANVAS.COPY_TARGET, target === null ? 0 : gpu.importResource(target), true);
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
      flipY: false, sourceKind: CANVAS_COPY_KIND.FRAME, sourceColorSpace: frame.colorSpace,
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

// The DOMException of each failed gpu_canvas_copy_check status.
const COPY_ERRORS = new Map([
  [CANVAS_COPY_STATUS.TAINTED, ['The external image is tainted by cross-origin data.', 'SecurityError']],
  [CANVAS_COPY_STATUS.OUTSIDE, ['Copy rect is out of bounds of external image', 'OperationError']],
]);

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
    sourceKind: straight ? CANVAS_COPY_KIND.IMAGE_DATA : CANVAS_COPY_KIND.BITMAP,
    sourceColorSpace: (straight ? image.colorSpace : image.source.colorSpace) ?? 'srgb',
    targetColorSpace: destination.colorSpace ?? 'srgb', opaque: false,
    premultiplied: Boolean(destination.premultipliedAlpha),
    imageWidth: image.width, imageHeight: image.height, originClean: Boolean(image.originClean), depth,
  };
  const { core, input } = copyInput(device, description);
  const status = core.gpu_canvas_copy_check(input.byteOffset);
  const error = COPY_ERRORS.get(status);
  if (error) throw new DOMException(`${member}: ${error[0]}`, error[1]);
  if (status === CANVAS_COPY_STATUS.EMPTY) return true;
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
  readTextureRegion(device, texture, width, height, format, 0, 0,
    format === 'rgba16float' ? CANVAS_FORMAT_RGBA16FLOAT : CANVAS_FORMAT_RGBA8UNORM, {
    reply({ core, readbackState }, formatIndex) {
      const pointer = new DataView(core.memory.buffer).getUint32(readbackState + CANVAS.READBACK_BYTES, true);
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
  const format = imageData.pixelFormat === 'rgba-float16' ? CANVAS_FORMAT_RGBA16FLOAT : CANVAS_FORMAT_RGBA8UNORM;
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
  readTextureRegion(device, texture, width, height, texture.format, 0, 0, CANVAS_FORMAT_RGBA8UNORM, {
    reply({ core, readbackState }) {
      let samples;
      try {
        const pointer = core.gpu_canvas_encode_pixels(readbackState, jpeg ? 1 : 0, opaque ? 1 : 0);
        const descriptor = new DataView(core.memory.buffer, pointer, CANVAS.ENCODE_SIZE);
        const pixelsAt = descriptor.getUint32(CANVAS.ENCODE_PIXELS, true);
        const length = descriptor.getUint32(CANVAS.ENCODE_LENGTH, true);
        const bitDepth = descriptor.getUint32(CANVAS.ENCODE_BIT_DEPTH, true);
        const pixels = bitDepth === 16
          ? new Uint16Array(core.memory.buffer, pixelsAt, length / Uint16Array.BYTES_PER_ELEMENT)
          : new Uint8Array(core.memory.buffer, pixelsAt, length);
        samples = { pixels, bitDepth, channelLayout: descriptor.getUint32(CANVAS.ENCODE_CHANNELS, true) === 3 ? 'rgb' : 'rgba' };
      } catch (error) {
        operation.throw(error);
        return;
      }
      operation.reply(samples);
    },
    throw(error) { operation.throw(error); },
  });
}
