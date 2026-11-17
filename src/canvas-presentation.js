// The canvas presentation binding (docs/specifications/gpu-command-stream.md).
// Renderer-core (core/engine/gpu-presentation.watpart) selects the
// presentation shader mode, the color matrix, the pipeline, and each
// frame's pass. This module configures the canvas, imports the working and
// canvas textures, and executes the records on the presenter's device.
//
// The presenter sizes the canvas to each presented texture. With a
// GPU-thread device (src/gpu-thread.js), as a browser worker's renderer has,
// it takes the OffscreenCanvas: it transfers it to the GPU thread, which
// presents from that device, and sizes it there. The host does not use the
// canvas afterwards.
import { createGpuBinding } from "./gpu-binding.js";
import { composeShaderBytes } from "./shaders/compose.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";
import { adoptGpuThreadCanvas, flushGpuThread, gpuThreadResource, sizeGpuThreadCanvas } from "./dom/webgpu-facade.js";

const TEXTURE_FORMATS = Object.freeze({
  rgba8unorm: 0,
  rgba16float: 1,
  bgra8unorm: 7,
});
let presentationCore;
// The host's canvas types and WebGPU, taken when the module loads:
// renderComponent() replaces these globals in its realm, and a host presents
// onto its own canvas, such as one that a page transferred to the worker.
const HostHTMLCanvasElement = globalThis.HTMLCanvasElement;
const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const hostGpu = globalThis.navigator?.gpu;

export function createCanvasPresenter({
  canvas,
  device,
  renderMode = "standard",
  extended = false,
  colorSpace = extended ? "display-p3" : "srgb",
  alphaMode = renderMode === "high-dynamic-range" ? "opaque" : "premultiplied",
}) {
  const isHTMLCanvas = HostHTMLCanvasElement !== undefined &&
    canvas instanceof HostHTMLCanvasElement;
  const isOffscreenCanvas = HostOffscreenCanvas !== undefined &&
    canvas instanceof HostOffscreenCanvas;
  if (!isHTMLCanvas && !isOffscreenCanvas) {
    throw new TypeError(
      "createCanvasPresenter: canvas must be an HTMLCanvasElement or OffscreenCanvas",
    );
  }
  if (!device || typeof device.createShaderModule !== "function") {
    throw new TypeError("createCanvasPresenter: device must be a GPUDevice");
  }
  if (renderMode !== "standard" && renderMode !== "high-dynamic-range") {
    throw new RangeError(
      `createCanvasPresenter: unknown render mode "${renderMode}"`,
    );
  }
  if (renderMode === "high-dynamic-range" && !extended) {
    throw new Error(
      "createCanvasPresenter: high-dynamic-range rendering requires an extended rgba16float canvas",
    );
  }
  const threadDevice = gpuThreadResource(device) !== null;
  if (threadDevice && !isOffscreenCanvas) {
    throw new TypeError(
      "createCanvasPresenter: a GPU-thread device presents onto an OffscreenCanvas, which the presenter transfers to the GPU thread; give it one, such as from transferControlToOffscreen()",
    );
  }

  const context = threadDevice ? adoptGpuThreadCanvas(device, canvas) : canvas.getContext("webgpu");
  if (!context) {
    throw new Error(
      "createCanvasPresenter: the browser did not provide a WebGPU canvas",
    );
  }
  const format = extended
    ? "rgba16float"
    : hostGpu.getPreferredCanvasFormat();
  const formatIndex = TEXTURE_FORMATS[format];
  if (formatIndex === undefined) {
    throw new Error(
      `createCanvasPresenter: canvas format "${format}" is not rgba8unorm, bgra8unorm, or rgba16float`,
    );
  }
  if (colorSpace !== "srgb" && colorSpace !== "display-p3") {
    throw new RangeError(
      `createCanvasPresenter: unknown canvas color space "${colorSpace}"`,
    );
  }
  context.configure({
    device,
    format,
    colorSpace,
    alphaMode,
    toneMapping: { mode: extended ? "extended" : "standard" },
  });

  const core = presentationCore ??= instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device);
  const shader = composeShaderBytes(core, "canvas-presentation");
  const state = core.gpu_presentation_create(
    gpu.stream,
    shader.pointer,
    shader.length,
    formatIndex,
    renderMode === "high-dynamic-range" ? 1 : 0,
    colorSpace === "display-p3" ? 1 : 0,
  );
  gpu.execute();
  let destroyed = false;
  // The canvas's size, on the GPU thread for an adopted canvas.
  let canvasWidth = 0;
  let canvasHeight = 0;

  return Object.freeze({
    format,
    dynamicRange: extended ? "high-dynamic-range" : "standard",
    present(textureImage) {
      if (destroyed) throw new Error("canvas presenter is destroyed");
      if (!textureImage?.texture) {
        throw new TypeError("canvas presenter requires a GPU texture image");
      }
      const { width, height } = textureImage.texture;
      if (width !== canvasWidth || height !== canvasHeight) {
        if (threadDevice) sizeGpuThreadCanvas(context, width, height);
        else {
          canvas.width = width;
          canvas.height = height;
        }
        canvasWidth = width;
        canvasHeight = height;
      }
      gpu.beginFrame();
      core.gpu_presentation_present(
        state,
        gpu.importResource(textureImage.texture),
        gpu.importResource(context.getCurrentTexture()),
      );
      gpu.execute();
      // The submit waits in the GPU thread's queue until a request carries
      // it; no request follows a presentation.
      if (threadDevice) flushGpuThread(device);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      core.gpu_presentation_destroy(state);
      gpu.close();
      context.unconfigure();
    },
  });
}
