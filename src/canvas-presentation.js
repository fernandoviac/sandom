// The canvas presentation binding (docs/specifications/gpu-command-stream.md).
// Renderer-core (src/wasm/gpu-presentation.watpart) selects the
// presentation shader mode, the color matrix, the pipeline, and each
// frame's pass. This module configures the canvas, imports the working and
// canvas textures, and executes the records on the presenter's device.
import { createGpuBinding } from "./gpu-binding.js";
import { composeShaderBytes } from "./shaders/compose.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";

const TEXTURE_FORMATS = Object.freeze({
  rgba8unorm: 0,
  rgba16float: 1,
  bgra8unorm: 7,
});
let presentationCore;

export function createCanvasPresenter({
  canvas,
  device,
  renderMode = "standard",
  extended = false,
  colorSpace = extended ? "display-p3" : "srgb",
  alphaMode = renderMode === "high-dynamic-range" ? "opaque" : "premultiplied",
}) {
  const isHTMLCanvas = typeof HTMLCanvasElement !== "undefined" &&
    canvas instanceof HTMLCanvasElement;
  const isOffscreenCanvas = typeof OffscreenCanvas !== "undefined" &&
    canvas instanceof OffscreenCanvas;
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

  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error(
      "createCanvasPresenter: the browser did not provide a WebGPU canvas",
    );
  }
  const format = extended
    ? "rgba16float"
    : navigator.gpu.getPreferredCanvasFormat();
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

  return Object.freeze({
    format,
    dynamicRange: extended ? "high-dynamic-range" : "standard",
    present(textureImage) {
      if (destroyed) throw new Error("canvas presenter is destroyed");
      if (!textureImage?.texture) {
        throw new TypeError("canvas presenter requires a GPU texture image");
      }
      gpu.beginFrame();
      core.gpu_presentation_present(
        state,
        gpu.importResource(textureImage.texture),
        gpu.importResource(context.getCurrentTexture()),
      );
      gpu.execute();
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
