// Rasterizer — reads binary command buffer, issues WebGPU draw calls,
// produces raw RGBA pixels.
//
// Handles: rect (with borders, rounded corners), push/pop clip,
// push/pop opacity (offscreen compositing).

import { hostNow } from "./host-clock.js";
import {
  openRasterPlan,
  rasterPlanAtlasResources,
} from "./raster-plan.js";
import {
  createRenderContextWebgl2,
  releaseSharedWebgl2State,
  renderWebgl2,
} from "./rasterize-webgl2.js";
import { getDefaultGpu } from "./gpu-thread.js";
// WebGPU's constants, which a server runtime without WebGPU lacks as globals.
import { GPUTextureUsage } from "./dom/webgpu-facade.js";
// The host realm's navigator, captured at module load without reading its
// `gpu` getter (a permissions:none worker would request GPU access).
const hostNavigator = globalThis.navigator ?? null;
// The GPU-thread capability where this realm can host one; a browser main
// thread renders with its own native capability.
const defaultGpu = () => getDefaultGpu() ?? hostNavigator?.gpu ?? null;
export { releaseSharedWebgl2State };
import {
  DEFAULT_RENDER_MODE,
  DEFAULT_RENDER_PRECISION,
  STANDARD_WORKING_COLOR_ENCODING,
  validateRenderMode,
  validateRenderPrecision,
  WORKING_COLOR_ENCODING,
} from "./color.js";
import { imageUploadRepresentation } from "./image-data.js";
import { imageConversionUniform } from "./image-conversion.js";
import { createGpuPipelineLibrary } from "./gpu-pipeline-library.js";
import { canvasUnpremultiplyTable } from "./canvas-unpremultiply.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";
import { createGpuBinding } from "./gpu-binding.js";
import { createGpuSceneResources } from "./gpu-scene-binding.js";
import { createRasterRetention, readbackResult } from "./gpu-raster-binding.js";
import { layoutConstant } from "./wasm/layout-table.js";
import { gpuPassTimingFeatures } from "./gpu-pass-timing.js";



// The mode's working encoding for readback descriptors and texture
// results (docs/specifications/color-and-image-data.md).
function workingColorEncoding(renderMode) {
  return renderMode === "high-dynamic-range"
    ? WORKING_COLOR_ENCODING
    : STANDARD_WORKING_COLOR_ENCODING;
}

// A readback result IS a working ImageDescriptor (rgba, tightly packed,
// premultiplied, the mode's working encoding) plus the render extras
// (dirtyRects, readbackByteLength): float32 samples, or for an "rgba8"
// readback the rgba8unorm target's uint8 samples.
function workingRenderResult(pixels, width, height, renderMode, extra) {
  const bytes = pixels instanceof Uint8Array;
  return {
    width,
    height,
    rowStride: width * (bytes ? 4 : 16),
    pixels,
    channelLayout: "rgba",
    sampleType: bytes ? "uint8" : "float32",
    bitsPerSample: bytes ? 8 : 32,
    colorEncoding: workingColorEncoding(renderMode),
    alphaMode: "premultiplied",
    metadata: {},
    ...extra,
  };
}

// The native readback format of a target format and readback request.
const READBACK_FORMAT_RGBA8_FLOAT = layoutConstant("READBACK_FORMAT_RGBA8_FLOAT");
const READBACK_FORMAT_RGBA16_FLOAT = layoutConstant("READBACK_FORMAT_RGBA16_FLOAT");
const READBACK_FORMAT_RGBA8 = layoutConstant("READBACK_FORMAT_RGBA8");
function readbackFormat(colorFormat, readback) {
  if (colorFormat === "rgba16float") return READBACK_FORMAT_RGBA16_FLOAT;
  return readback === "rgba8" ? READBACK_FORMAT_RGBA8 : READBACK_FORMAT_RGBA8_FLOAT;
}

function textureRenderResult(context) {
  return {
    backend: context.kind,
    ...(context.kind === "webgl2" ? { gl: context.shared.gl } : { device: context.device }),
    textureImage: {
      texture: context.kind === "webgl2" ? context.mainTarget.texture : context.mainTexture,
      width: context.width, height: context.height,
      format: context.colorFormat ?? "rgba8unorm",
      colorEncoding: workingColorEncoding(context.renderMode),
      alphaMode: "premultiplied",
    },
    width: context.width, height: context.height,
  };
}

function workingReadback(gpu, slot, context) {
  const result = readbackResult(gpu, slot);
  return { deferred: true, discard: () => result.discard(), async collect() {
    const collected = await result.collect();
    return { finish() {
      const output = collected.finish();
      return workingRenderResult(output.pixels, context.width, context.height, context.renderMode, output);
    } };
  } };
}

// Reads a direct texture result (`readback: "none"`, the frame a presenter
// receives) back into the same working ImageDescriptor a float32 readback
// produces. The texture is left intact; the caller owns its lifetime.
export async function readbackTextureImage(device, textureImage) {
  const { texture, width, height, format } = textureImage;
  const core = instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device, { label: "texture readback" });
  try {
    const frame = core.gpu_readback_frame(gpu.stream, width, height, readbackFormat(format, "float32"));
    const encoder = core.gpu_encoder_create(gpu.stream);
    const slot = core.gpu_readback_copy(gpu.stream, frame, encoder, gpu.importResource(texture), readbackFormat(format, "float32"));
    const result = readbackResult(gpu, slot);
    core.gpu_frame_submit(gpu.stream, encoder, 0, 0);
    core.gpu_readback_submit(gpu.stream, slot);
    gpu.execute();
    const pixels = (await result.collect()).finish();
    const renderMode = textureImage.colorEncoding === WORKING_COLOR_ENCODING ? "high-dynamic-range" : "standard";
    return workingRenderResult(pixels.pixels, width, height, renderMode, {
      dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
      readbackByteLength: pixels.readbackByteLength,
    });
  } finally { await gpu.destroy(); }
}

// A reader of direct texture results on `device` that keeps up to three
// readbacks in flight: read(textureImage) copies the texture now and
// resolves to its working ImageDescriptor once the GPU map completes. The
// device runs submissions in order, so a later frame may render into the
// texture before the read resolves. `format` "rgba8" reads rgba8unorm
// textures as their uint8 samples; "float32" reads any texture as working
// float32 samples. One binding and one core instance serve every read.
export const TEXTURE_READS_IN_FLIGHT = 3;
export function createTextureReader(device, { format = "float32" } = {}) {
  if (format !== "float32" && format !== "rgba8") {
    throw new TypeError(`createTextureReader: format must be "float32" or "rgba8", got ${JSON.stringify(format)}`);
  }
  const core = instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device, { label: "texture reader" });
  let inFlight = 0;
  let destroyed = false;
  return Object.freeze({
    get inFlight() { return inFlight; },
    read(textureImage) {
      if (destroyed) throw new Error("createTextureReader: the reader is destroyed");
      const { texture, width, height, format: textureFormat } = textureImage;
      if (format === "rgba8" && textureFormat !== "rgba8unorm") {
        throw new Error(`createTextureReader: "rgba8" reads rgba8unorm textures; this texture is ${textureFormat}. Render with renderPrecision "rgba8unorm" or read "float32"`);
      }
      if (inFlight >= TEXTURE_READS_IN_FLIGHT) {
        throw new Error(`createTextureReader: ${inFlight} reads are in flight; await one before reading another texture`);
      }
      const readFormat = readbackFormat(textureFormat, format);
      const frame = core.gpu_readback_frame(gpu.stream, width, height, readFormat);
      const encoder = core.gpu_encoder_create(gpu.stream);
      const slot = core.gpu_readback_copy(gpu.stream, frame, encoder, gpu.importResource(texture), readFormat);
      if (!slot) {
        core.raster_retention_release(frame);
        throw new Error("createTextureReader: the GPU readback ring is full");
      }
      const result = readbackResult(gpu, slot);
      core.gpu_frame_submit(gpu.stream, encoder, 0, 0);
      core.gpu_readback_submit(gpu.stream, slot);
      gpu.execute();
      inFlight += 1;
      const renderMode = textureImage.colorEncoding === WORKING_COLOR_ENCODING ? "high-dynamic-range" : "standard";
      return result.collect().then((collected) => {
        const pixels = collected.finish();
        return workingRenderResult(pixels.pixels, width, height, renderMode, {
          dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
          readbackByteLength: pixels.readbackByteLength,
        });
      }).finally(() => {
        inFlight -= 1;
        if (!destroyed) core.raster_retention_release(frame);
      });
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await gpu.destroy();
    },
  });
}

// Copies a direct texture result into `target` (a GPUTexture of the same
// format with COPY_DST usage) at (`x`, `y`): one raster placed in a shared
// texture, with no readback. The source stays intact.
export async function copyTextureImageInto(device, textureImage, target, x, y) {
  const { texture, width, height, format } = textureImage;
  if (target.format !== format) {
    throw new TypeError(`The target texture has format ${target.format}; the raster has ${format}.`);
  }
  if (x + width > target.width || y + height > target.height) {
    throw new RangeError(
      `A ${width} x ${height} raster at (${x}, ${y}) does not fit the ${target.width} x ${target.height} target texture.`,
    );
  }
  const core = instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device, { label: "texture placement" });
  try {
    core.gpu_texture_place(gpu.stream, gpu.importResource(texture), gpu.importResource(target), width, height, x, y);
    gpu.execute();
  } finally { await gpu.destroy(); }
}

// Render contexts that this process requested. Every raster target, GPU
// submission, readback, and encode needs one, so an unchanged count shows
// that an operation did no raster work.
let renderContextRequests = 0;
export function renderContextRequestCount() {
  return renderContextRequests;
}

// Backend selection (PLAN-webgl-2-degraded-backend.md): `graphicsBackend`
// is a closed option — "webgpu", "webgl2", or "auto" (the default).
// `auto` requests WebGPU first. When the host has no WebGPU (no GPU object,
// or no adapter), it probes WebGL 2; when both are unavailable, it throws
// one error carrying both reasons. Any other WebGPU failure, such as a
// device request that fails or a closed GPU-thread binding, is a fault of
// an available backend: it throws, so it never hides behind WebGL 2. The
// selection happens ONCE at context creation — there is no fallback after
// rendering starts.
export async function createRenderContext(options) {
  renderContextRequests += 1;
  const suppliedDevice = (options.sharedStateOwner ?? defaultWebgpuStateOwner).webgpuDevice ?? null;
  const graphicsBackend = options.graphicsBackend ?? "auto";
  if (graphicsBackend === "webgpu") return createRenderContextWebgpu(options);
  if (graphicsBackend === "webgl2") return createRenderContextWebgl2(options);
  if (graphicsBackend !== "auto") {
    throw new Error(
      `createRenderContext: unknown graphicsBackend "${graphicsBackend}" (expected "webgpu", "webgl2", or "auto")`,
    );
  }
  let webgpuAbsence;
  // The HOST's WebGPU capability, read at call time from the real global
  // unless a component environment has shadowed `navigator` — ambient
  // component code may deliberately see no GPU, but the raster backend
  // always belongs to the host realm.
  if (suppliedDevice !== null || defaultGpu()) {
    try {
      return await createRenderContextWebgpu(options);
    } catch (error) {
      if (!(error instanceof WebgpuUnavailableError)) throw error;
      webgpuAbsence = error;
    }
  } else {
    webgpuAbsence = new WebgpuUnavailableError("navigator.gpu is absent");
  }
  try {
    return await createRenderContextWebgl2(options);
  } catch (webglFailure) {
    throw new Error(
      `createRenderContext: no raster backend available.\n` +
        `  WebGPU: ${webgpuAbsence.message}\n` +
        `  WebGL 2: ${webglFailure.message}`,
    );
  }
}

// The host offers no WebGPU at all; the only WebGPU failure that `auto`
// answers with WebGL 2.
class WebgpuUnavailableError extends Error {
  name = "WebgpuUnavailableError";
}

// One WebGPU adapter, device, and pipeline library per shared state owner
// and color format — the WebGPU analogue of the WebGL 2 backend's one
// shared GL context (rasterize-webgl2.js). Devices and pipelines are
// immutable and safe to share across render contexts; every mutable
// per-frame resource (instance buffer, uniform pools, readback ring, render
// target) stays per-context. The state owner is the caller's
// sharedStateOwner (the scene-renderer runtime's graphicsStateOwner), so a
// module realm — e.g. one worker — owns exactly one device per format and
// releaseSharedWebgpuStates() releases it deliberately once every context
// is destroyed.
const defaultWebgpuStateOwner = {};

async function createSharedWebgpuState(
  colorFormat,
  suppliedDevice = null,
) {
  let adapter = null;
  let device = suppliedDevice;
  const ownsDevice = device === null;
  if (ownsDevice) {
    adapter = await defaultGpu().requestAdapter();
    if (!adapter) throw new WebgpuUnavailableError("WebGPU not available: no adapter found");
    device = await adapter.requestDevice({ requiredFeatures: gpuPassTimingFeatures(adapter) });
    // A validation or out-of-memory error, or the loss of the device,
    // otherwise leaves every later frame blank without a word: report each
    // as the page's error.
    device.addEventListener("uncapturederror", (event) => {
      globalThis.reportError(new Error(`Sandom WebGPU raster device: ${event.error.constructor.name}: ${event.error.message}`));
    });
    device.lost.then((information) => {
      if (information.reason !== "destroyed") {
        globalThis.reportError(new Error(`Sandom WebGPU raster device lost (${information.reason}): ${information.message}`));
      }
    });
  }
  const library = await createGpuPipelineLibrary(device, colorFormat);
  // fragmentContentsOpaque's unpremultiply table: r8uint, 256 values by
  // 256 alphas (src/canvas-unpremultiply.js).
  let unpremultiplyTable = null;
  let disposed = false;
  return {
    adapter,
    device,
    ownsDevice,
    library,
    quadBuffer: library.quadBuffer,
    tileClearPipeline: library.pipeline(layoutConstant("GPU_PIPELINE_TILE_CLEAR")),
    placeholderTexture: () => library.placeholderTexture,
    unpremultiplyTable() {
      if (unpremultiplyTable === null) {
        unpremultiplyTable = device.createTexture({
          label: "Sandom canvas unpremultiply table",
          size: { width: 256, height: 256 },
          format: "r8uint",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: unpremultiplyTable },
          canvasUnpremultiplyTable(),
          { bytesPerRow: 256 },
          { width: 256, height: 256 },
        );
      }
      return unpremultiplyTable;
    },
    liveContextCount: 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      library.destroy();
      unpremultiplyTable?.destroy();
    },
  };
}

// Deliberate device release for a long-lived embedder: destroys the shared
// device of every state whose contexts have all been destroyed. States with
// live contexts are left untouched.
export async function releaseSharedWebgpuStates(
  stateOwner = defaultWebgpuStateOwner,
) {
  const sharedStates = stateOwner.webgpu;
  if (!sharedStates) return;
  for (const [key, sharedPromise] of [...sharedStates]) {
    const shared = await sharedPromise;
    if (shared.liveContextCount > 0) continue;
    sharedStates.delete(key);
    await shared.device.queue.onSubmittedWorkDone();
    shared.dispose?.();
    if (shared.ownsDevice) shared.device.destroy();
  }
}

// The shared WebGPU state of `stateOwner` for `colorFormat`, created on
// first use. Its reactions live as long as the device, so they close over
// this function's scope only: a closure of a render context's scope would
// keep that context, its renderer's last scene and that scene's document
// for the device's lifetime.
function sharedWebgpuState(stateOwner, colorFormat) {
  const sharedStates = stateOwner.webgpu ??= new Map();
  const existing = sharedStates.get(colorFormat);
  if (existing) return existing;
  const sharedPromise = createSharedWebgpuState(
    colorFormat,
    stateOwner.webgpuDevice ?? null,
  );
  sharedStates.set(colorFormat, sharedPromise);
  sharedPromise.then(
    // A lost device, such as one that a GPU-thread close destroyed,
    // serves no later context: the next context creates a new state.
    (shared) => shared.device.lost.then(() => {
      if (sharedStates.get(colorFormat) === sharedPromise) sharedStates.delete(colorFormat);
    }),
    () => {
      // A failed boot must not stick to the owner; the next caller retries.
      // The awaiting caller still observes the rejection itself.
      if (sharedStates.get(colorFormat) === sharedPromise) {
        sharedStates.delete(colorFormat);
      }
    },
  );
  return sharedPromise;
}

async function createRenderContextWebgpu(options) {
  // Native texture extents truncate fractional requests. Resolve that once
  // here so textures, readback buffers, row strides, and metadata agree.
  const width = Math.trunc(options.width);
  const height = Math.trunc(options.height);
  // Rendering mode and render precision (docs/specifications/
  // color-and-image-data.md, "Rendering modes and render precisions").
  // Standard mode stores encoded sRGB components, so every existing
  // shader and blend state is already correct; the precision selects
  // only texture width. The eight-bit precision exists only inside
  // standard mode.
  const renderMode = validateRenderMode(
    options.renderMode ?? DEFAULT_RENDER_MODE,
  );
  const renderPrecision = validateRenderPrecision(
    options.renderPrecision ?? DEFAULT_RENDER_PRECISION,
  );
  if (renderMode === "high-dynamic-range" && renderPrecision === "rgba8unorm") {
    throw new Error(
      "createRenderContext: the rgba8unorm speed precision exists only in standard mode",
    );
  }
  const colorFormat = renderPrecision;
  const colorTexelBytes = colorFormat === "rgba16float" ? 8 : 4;
  const stateOwner = options.sharedStateOwner ?? defaultWebgpuStateOwner;
  const shared = await sharedWebgpuState(stateOwner, colorFormat);
  const { device } = shared;
  let contextDestroyed = false;

  let gpuBinding = null;
  let sceneResources = null;
  // The raster target, created by the first frame that draws into it: a
  // renderer that replaces this context for another size before a frame
  // (a visible region set after its viewport) allocates nothing for it.
  let mainTexture = null;
  const mainTextureNow = () => mainTexture ??= device.createTexture({
    size: { width, height },
    format: colorFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });

  let rasterRetention = null;
  // An attached frame comparison session (src/gpu-frame-comparison.js) and
  // this context's owner, created on its first frame.
  let comparison = null;
  let comparisonOwner = null;

  // Cross-frame GPU texture cache (see placeholderTexture below), owned by
  // the context and outliving any one render() call, unlike every per-frame
  // texture, which render() destroys. Atlas textures are owned by their
  // atlas instead (WasmAtlas.deviceTexture).
  // Per-image upload representation and conversion parameters, derived
  // once per registered descriptor per context (the conversion plan
  // depends on this context's rendering mode). Replaces the pre-cutover
  // CPU premultiply cache: premultiplication now happens in the
  // conversion shader.
  const imageConversionCache = new WeakMap();
  const imageConversionUniformCache = new WeakMap();
  function imageConversionUniformFor(descriptor) {
    let uniformData = imageConversionUniformCache.get(descriptor);
    if (!uniformData) {
      uniformData = imageConversionUniform(descriptor, renderMode);
      imageConversionUniformCache.set(descriptor, uniformData);
    }
    return uniformData;
  }
  function imageConversionFor(entry) {
    let cached = imageConversionCache.get(entry.descriptor);
    if (!cached) {
      cached = {
        upload: imageUploadRepresentation(entry.descriptor),
        uniformData: imageConversionUniformFor(entry.descriptor),
      };
      imageConversionCache.set(entry.descriptor, cached);
    }
    return cached;
  }

  // The svg path atlas as a GPU texture, or the placeholder when the scene
  // has none. The atlas uploads once per (device, revision)
  // (WasmAtlas.deviceTexture) and outlives the frame.
  function pathAtlasTexture(svgPathAtlas) {
    const hasAtlas = svgPathAtlas && svgPathAtlas.atlasWidth > 0 &&
      svgPathAtlas.atlasHeight > 0;
    if (!hasAtlas) return shared.placeholderTexture();
    return svgPathAtlas.deviceTexture(device);
  }

  shared.liveContextCount++;
  return {
    kind: "webgpu",
    backendInfo: Object.freeze({
      host: "webgpu",
      implementation: "WebGPU",
    }),
    shared,
    device,
    gpuBindingFor(core) {
      if (gpuBinding === null) {
        gpuBinding = createGpuBinding(core, device, {
          label: "scene",
          pipeline: shared.library.pipeline,
          unpremultiplyTable: shared.unpremultiplyTable,
        });
        sceneResources = createGpuSceneResources(gpuBinding, width, height, colorFormat);
      }
      return gpuBinding;
    },
    get mainTexture() { return mainTextureNow(); },
    quadBuffer: shared.quadBuffer,
    renderMode,
    renderPrecision,
    colorFormat,
    colorTexelBytes,
    tileClearPipeline: shared.tileClearPipeline,
    get sceneResources() { return sceneResources; },
    imageConversionFor,
    imageConversionUniformFor,
    width,
    height,
    rasterRetentionFor(core) {
      return rasterRetention ??= createRasterRetention(core, width, height, colorTexelBytes);
    },
    attachComparison(session) {
      comparison = session;
    },
    // An attached comparison whose owner has no first candidate yet.
    get comparisonNeedsBaseline() {
      return comparison !== null && comparisonOwner === null;
    },
    async detachComparison() {
      const owner = comparisonOwner;
      comparison = null;
      comparisonOwner = null;
      if (owner !== null) await owner.session.release(owner.owner);
    },
    // The comparison owner of this context's binding, or null.
    comparisonFor(binding) {
      if (comparison === null) return null;
      if (comparisonOwner === null) {
        const owner = comparison.ownerFor(binding, { device, width, height, format: colorFormat });
        if (owner === null) return null;
        comparisonOwner = { session: comparison, owner };
      }
      return comparisonOwner.owner;
    },
    pathAtlasTexture,
    placeholderTexture: shared.placeholderTexture,
    // Release every per-context GPU resource. The shared device, shader
    // modules, and pipelines stay with the state owner; see
    // releaseSharedWebgpuStates for the deliberate device release.
    async destroy() {
      if (contextDestroyed) return;
      contextDestroyed = true;
      try {
        if (comparisonOwner !== null) await comparisonOwner.session.release(comparisonOwner.owner);
        comparisonOwner = null;
        await gpuBinding?.destroy();
      }
      finally {
        mainTexture?.destroy();
        rasterRetention?.destroy();
        shared.liveContextCount--;
      }
    },
  };
}

export async function render(context, options = {}) {
  if (
    options.rasterPlan?.memory instanceof WebAssembly.Memory !== true ||
    !Number.isInteger(options.rasterPlan.plan) ||
    options.rasterPlan.plan <= 0 ||
    options.rasterPlan.exports == null
  ) {
    throw new TypeError(
      "render: options.rasterPlan with memory, positive plan handle, and exports is required",
    );
  }
  const core = context.kind === "webgl2"
    ? options.rasterPlan.exports
    : context.gpuBindingFor(options.rasterPlan.exports).core;
  const resources = {
    ...options,
    ...rasterPlanAtlasResources(options.rasterPlan),
    rasterPlan: openRasterPlan(options.rasterPlan, options.rasterPlan.plan),
    rasterPlanDescriptor: options.rasterPlan,
    renderMode: context.renderMode ?? "standard",
    damageSelection: context.kind === "webgl2",
  };
  const frame = context.rasterRetentionFor(core).prepare(resources);
  const readback = options.readback ?? "float32";
  const finish = (result) => {
    try {
      result.dirtyRects = frame.dirtyRectangles();
      result.rasterPreparation = frame.statistics;
      if (context.kind === "webgl2" && result.pixels && !frame.reuse) frame.storePixels(result.pixels);
      frame.commit();
      return result;
    } finally { frame.release(); }
  };
  try {
    if (readback !== "float32" && readback !== "rgba8" && readback !== "none") {
      throw new Error(`render: readback must be "float32", "rgba8" or "none", got ${JSON.stringify(readback)}`);
    }
    if (readback === "rgba8" && (context.kind !== "webgpu" || context.colorFormat !== "rgba8unorm")) {
      throw new Error(`render: readback "rgba8" requires a WebGPU context with the rgba8unorm render precision; this is ${context.kind} ${context.colorFormat ?? ""}`.trim());
    }
    if (context.contextLost) {
      throw new Error("render: the WebGL 2 context was lost; create a new render context");
    }
    if (frame.reuse) {
      if (readback === "none") {
        if (context.kind === "webgpu" && context.comparisonNeedsBaseline) await compareReusedBaseline(context, options);
        return finish({ ...textureRenderResult(context), readbackByteLength: 0 });
      }
      if (context.kind === "webgl2") {
        const result = finish(workingRenderResult(frame.cachedPixels(), context.width, context.height, context.renderMode, { readbackByteLength: 0 }));
        return options.deferReadback ? { deferred: true, collect: () => Promise.resolve({ finish: () => result }) } : result;
      }
    }
    const result = await renderFrame(context, {
      ...options,
      atlasForIdentity: resources.atlasForIdentity,
      svgPathAtlas: resources.svgPathAtlas,
      rasterFrame: frame,
      ...(context.kind === "webgl2"
        ? { dirtyTiles: frame.dirtyTiles, damageRectangles: frame.damageRectangles() }
        : {}),
      planReader: frame.planReader,
    });
    if (!result.deferred) return finish(result);
    return {
      deferred: true,
      collect: async () => {
        try {
          const collected = await result.collect();
          return { finish: () => finish(collected.finish()) };
        } catch (error) {
          frame.release();
          throw error;
        }
      },
    };
  } catch (error) {
    frame.release();
    throw error;
  }
}

// The frame comparison owner of a WebGPU context, or null. Under the wait
// policy, a full result ring holds the frame here until the host releases an
// entry: each rendered frame must be a compared candidate, or the next
// frame's damage would not describe its change from the accepted image.
// An owner's first candidate on a retained frame: the full image, on its
// own encoder and submission.
function compareBaseline(context, gpu, comparison, frameSequence) {
  gpu.beginFrame();
  const encoder = gpu.core.gpu_encoder_create(gpu.stream);
  requireCandidate(comparison.candidateSpan(encoder, context.mainTexture, frameSequence ?? 0, 0, -1));
  gpu.core.gpu_frame_submit(gpu.stream, encoder, 0, 0);
  comparison.submit();
  gpu.execute();
}

// The baseline of a retained frame without readback, which renderFrame
// never sees.
async function compareReusedBaseline(context, options) {
  const gpu = context.gpuBindingFor(options.rasterPlan.exports);
  const comparison = context.comparisonFor(gpu);
  if (comparison === null) return;
  await whenComparisonReady(comparison);
  compareBaseline(context, gpu, comparison, options.frameSequence);
}

async function whenComparisonReady(comparison) {
  if (comparison.policy === "wait") {
    await new Promise((reply, reject) => comparison.whenEntryFree({ reply, throw: reject }));
  }
}

function requireCandidate(status) {
  if (status === "refused") {
    throw new Error("frame comparison refused a candidate after its ring entry was free; the owner failed or another frame took the entry");
  }
}

// Interpret a native raster plan and issue backend draw calls.
async function renderFrame(context, options = {}) {
  // WebGL 2 cannot sample a WebGPU texture. Materialize each live canvas
  // source through its bounded readback path before interpreting the plan.
  if (context.kind === "webgl2") {
    const resolvedImages = options.images ? new Map(options.images) : null;
    if (resolvedImages) {
      // Only the canvases this plan draws: the image map holds every image
      // of the runtime, the canvases of other documents included.
      const drawn = new Set(options.planReader.imageResources());
      for (const [imageIndex, entry] of resolvedImages) {
        if (entry?.kind !== "canvas") continue;
        if (!drawn.has(imageIndex)) {
          resolvedImages.delete(imageIndex);
          continue;
        }
        const capture = entry.captureForRender(null);
        let descriptor;
        try {
          descriptor = await capture.resolve();
        } finally {
          capture.release();
        }
        if (descriptor === null) {
          resolvedImages.delete(imageIndex);
          continue;
        }
        resolvedImages.set(imageIndex, {
          width: descriptor.width,
          height: descriptor.height,
          descriptor,
          pixels: descriptor.pixels,
        });
      }
    }
    // WebGL 2 draws and reads back in one synchronous call.
    const result = renderWebgl2(context, {
      ...options,
      images: resolvedImages,
    });
    options.onSubmitted?.();
    return result;
  }
  const {
    background = { r: 0, g: 0, b: 0, a: 0 },
    atlasForIdentity,
    svgPathAtlas = null,
    // Slice P5a: imageIndex -> { width, height, pixels } (RGBA8), the decoded
    // pixel cache the engine itself never sees (IMAGE_TABLE only carries
    // width/height for layout) — see examples/render-scene.js's
    // imagePixelsFor.
    images = null,
    deferReadback = false,
    // Readback contract (wide-color plan, package 5): "float32" returns a
    // working ImageDescriptor; "rgba8" returns it with the rgba8unorm
    // target's uint8 samples; "none" returns a direct textureImage. The
    // pre-cutover boolean contract is rejected loudly below.
    readback = "float32",
    // Optional glyph thickening (design/text-rendering.md, "Platform font
    // smoothing"): each glyph edge moves outward by
    // mix(darkInk, lightInk, textLuma) device pixels, like macOS browser
    // font smoothing. The default draws the exact outline.
    textThickening = { darkInk: 0, lightInk: 0 },
    glyphPerformance = null,
    // Called once, right after the frame's command buffers go to the queue
    // (WebGL 2: after the frame is drawn and read back). The frame has then
    // read all of its raster plan and its resources: it only waits for the
    // GPU and copies the readback.
    onSubmitted = null,
  } = options;
  const gpu = context.gpuBindingFor(options.rasterPlan.exports);
  const sceneResources = context.sceneResources;
  // A retained frame draws nothing, so it is no candidate: its image is the
  // accepted one, unless no owner holds a baseline yet. Without a
  // comparison the frame takes no extra turn: a frame's await points order
  // its animation events.
  const comparison = options.rasterFrame.reuse && !context.comparisonNeedsBaseline
    ? null
    : context.comparisonFor?.(gpu) ?? null;
  if (comparison !== null) await whenComparisonReady(comparison);
  gpu.beginFrame();
  const {
    device,
    mainTexture,
    quadBuffer,
    imageConversionFor,
    imageConversionUniformFor,
    renderMode,
    tileClearPipeline,
    colorFormat,
    pathAtlasTexture,
    placeholderTexture,
  } = context;
  const gpuCore = gpu.core;
  const gpuStream = gpu.stream;

  const frame = options.rasterFrame;
  if (frame.reuse) {
    if (comparison !== null) compareBaseline(context, gpu, comparison, options.frameSequence);
    const slot = gpuCore.gpu_readback_copy(gpuStream, frame.pointer, 0, 0, readbackFormat(colorFormat, readback));
    if (!slot) throw new Error("GPU readback ring has 4 outstanding frames; finish a readback before submitting another");
    const result = workingReadback(gpu, slot, context);
    gpuCore.gpu_readback_submit(gpuStream, slot);
    gpu.execute();
    return deferReadback ? result : (await result.collect()).finish();
  }
  sceneResources.begin();
  // The caller's clear color bypasses plan preparation, so the plan's native
  // color export converts this one host-authored value.
  let clearColor = background;
  if (renderMode === "high-dynamic-range") {
    const rasterExports = options.rasterPlan?.exports;
    if (rasterExports == null) {
      throw new TypeError(
        "renderFrame: options.rasterPlan.exports is required for HDR clear-color conversion",
      );
    }
    const colorPointer = rasterExports.abi_malloc(32);
    if (colorPointer === 0) {
      throw new Error("raster_convert_color4 could not allocate 32 bytes");
    }
    try {
      const colors = new Float32Array(
        rasterExports.memory.buffer,
        colorPointer,
        8,
      );
      colors.set([background.r, background.g, background.b, background.a]);
      rasterExports.raster_convert_color4(colorPointer, colorPointer + 16);
      clearColor = {
        r: colors[4],
        g: colors[5],
        b: colors[6],
        a: colors[7],
      };
    } finally {
      rasterExports.abi_free(colorPointer);
    }
  }
  const commandEncoderHandle = gpuCore.gpu_encoder_create(gpuStream);
  gpu.execute();
  let submitted = false;
  const submitFrame = (readbackSlot = 0) => {
    // The comparison reads the complete working image, after every pass.
    if (comparison !== null) {
      requireCandidate(comparison.candidateSpan(commandEncoderHandle, mainTexture, options.frameSequence ?? 0,
        frame.damagePointer, frame.damageCount));
    }
    gpuCore.gpu_frame_submit(
      gpuStream, commandEncoderHandle,
      sceneResources.detachedEncoder(), sceneResources.resourceEncoder(),
    );
    if (comparison !== null) comparison.submit();
    if (readbackSlot) gpuCore.gpu_readback_submit(gpuStream, readbackSlot);
    gpu.execute();
    submitted = true;
    sceneResources.end(true);
  };
  const planReader = options.planReader;
  if (planReader == null) {
    throw new TypeError("renderFrame: options.planReader is required");
  }
  const canvasImageLeases = [];
  const resolvedImages = images ? new Map(images) : null;
  const unavailableCanvasImageIndices = new Set();
  const plan = sceneResources.planPointer(planReader);
  const sequence = sceneResources.sequence(plan, textThickening);
  try {
    if (resolvedImages) {
      const drawn = new Set(planReader.imageResources());
      for (const [imageIndex, image] of resolvedImages) {
        if (image?.kind !== "canvas") continue;
        if (!drawn.has(imageIndex)) {
          resolvedImages.delete(imageIndex);
          continue;
        }
        const capture = image.captureForRender(device);
        canvasImageLeases.push(capture);
        const resolved = await capture.resolve();
        if (resolved === null) {
          resolvedImages.delete(imageIndex);
          unavailableCanvasImageIndices.add(imageIndex);
        } else if (resolved.kind === "gpu-texture") {
          resolvedImages.set(imageIndex, resolved);
        } else {
          resolvedImages.set(imageIndex, {
            width: resolved.width,
            height: resolved.height,
            descriptor: resolved,
            pixels: resolved.pixels,
          });
        }
      }
    }

    // The composite shader's bind group always needs SOMETHING at bindings
    // 4 and 6, but the overwhelmingly common frame has neither a clip-path
    // mask nor a mask layer. Before this was cached, every frame of every
    // scene created a texture and uploaded the ENTIRE svg path atlas —
    // caught by batching_alloc_test.js's "0 texture allocs in steady state"
    // assertion (BUG-path-mask-atlas-allocated-every-frame, resolved; see
    // activity/reports/REPORT-2026-10-09-resolved-bug-records.md), but the
    // real cost was the per-frame full-atlas upload, not the allocation.
    const pathMaskAtlasTexture = sequence.pathMaskInUse
      ? pathAtlasTexture(svgPathAtlas)
      : placeholderTexture();

    // The RGBA clear color as four f64 values.
    const clear = gpu.input(4 * Float64Array.BYTES_PER_ELEMENT);
    [clearColor.r, clearColor.g, clearColor.b, clearColor.a]
      .forEach((channel, index) => clear.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, channel, true));
    const mainPassHandle = gpuCore.gpu_raster_pass(
      gpuStream, frame.pointer, commandEncoderHandle, gpu.importResource(mainTexture),
      gpu.importResource(tileClearPipeline), gpu.importResource(quadBuffer), clear.byteOffset,
    );
    gpu.execute();
    sceneResources.beginGroups(plan, commandEncoderHandle, mainTexture, mainPassHandle,
      quadBuffer, pathMaskAtlasTexture, device.limits.maxTextureDimension2D,
      frame.damagePointer, frame.damageCount);
    sceneResources.drawEntries(sequence.count, {
      images, resolvedImages, unavailableImages: unavailableCanvasImageIndices,
      atlasForIdentity, imageConversionFor, imageConversionUniformFor,
      atlasTexture(atlas) {
        const startedAt = glyphPerformance ? hostNow() : 0;
        const texture = atlas.deviceTexture(device);
        if (glyphPerformance) glyphPerformance.phaseMilliseconds.gpuUploadMilliseconds += hostNow() - startedAt;
        return texture;
      },
    });
    sceneResources.finishGroups();

    if (readback === "none") {
      submitFrame();
      onSubmitted?.();
      return textureRenderResult(context);
    }
    const slot = gpuCore.gpu_readback_copy(gpuStream, frame.pointer, commandEncoderHandle,
      gpu.importResource(mainTexture), readbackFormat(colorFormat, readback));
    if (!slot) throw new Error("GPU readback ring has 4 outstanding frames; finish a readback before submitting another");
    const result = workingReadback(gpu, slot, context);
    submitFrame(slot);
    try { onSubmitted?.(); }
    catch (error) {
      try { await result.discard(); }
      catch (readbackError) { throw new AggregateError([error, readbackError], "Submission callback and readback both failed"); }
      throw error;
    }
    return deferReadback ? result : (await result.collect()).finish();
  } finally {
    for (const lease of canvasImageLeases) lease.release();
    if (!submitted) sceneResources.end(false);
  }
}
