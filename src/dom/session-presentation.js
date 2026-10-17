// Presentation delivery for a component session's presentFrame stream: the
// policy that turns each renderer delivery (live GPU texture image plus
// device, or the WebGL 2 float pixel fallback) into pixels on one caller
// canvas. Extracted from the session host worker so consumers whose mounts
// the host protocol cannot express yet (Studio Preview's document worker)
// share one delivery rule instead of duplicating presenter wiring.
//
// The module is side-effect-free: no top-level canvas or GPU access.
// Everything flows through the factory arguments; the extended-range probe
// and presenter creation run only inside the returned deliver function, on
// the first texture delivery and on a device change.
//
// What stays caller-side, deliberately: suppression predicates (whether to
// present at all right now) and last-delivery replay. The caller gates
// deliveries before calling deliver and re-calls it with a retained
// delivery when presentation re-enables; deliver itself never gates.

import { createCanvasPresenter } from "../canvas-presentation.js";
import { quantizeWorkingPixels } from "../output/color-transform.js";

// The host's own OffscreenCanvas and ImageData, taken before a component
// realm on this global installs Sandom's (src/dom/component-globals.js).
const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const HostImageData = globalThis.ImageData;

// Wide gamut and HDR only when the platform grants them: probe rgba16float
// canvas configuration on a THROWAWAY canvas. A canvas grants one context
// kind for life, and Firefox throws on rgba16float canvases — the format
// selects the refusal, so the probe must never touch the real screen
// canvas. A platform without OffscreenCanvas refuses the same way.
export function probeExtendedRange(device) {
  try {
    const probe = new HostOffscreenCanvas(1, 1);
    const context = probe.getContext("webgpu");
    context.configure({
      device,
      format: "rgba16float",
      colorSpace: "display-p3",
      toneMapping: { mode: "extended" },
    });
    context.unconfigure();
    return true;
  } catch {
    return false;
  }
}

// The delivery factory. Returns deliver(delivery) -> { width, height }, the
// presented device-pixel dimensions, so the caller posts its own frame
// messages.
//
// - canvas: the presentation target (HTMLCanvasElement or OffscreenCanvas).
//   Both paths resize it to the delivery's device-pixel dimensions when
//   they differ, so a reconfigured session never presents into a stale
//   surface size.
// - renderMode: "standard" | "high-dynamic-range", forwarded to
//   createCanvasPresenter.
// - alphaMode: optional createCanvasPresenter override. Omitted, the
//   presenter's own default applies (premultiplied in standard mode,
//   opaque in high-dynamic-range); a caller compositing alpha over its own
//   window chrome forces "premultiplied" here.
// - wantExtended: caller policy. The effective presenter extended flag is
//   wantExtended AND probeExtendedRange(device); a false policy
//   short-circuits and skips the probe entirely. The host presents wide
//   gamut whenever the platform grants it (true); Studio only when its
//   surface is configured for HDR.
// - onMode: optional ({ extended, dynamicRange }) callback, fired at every
//   presenter creation — the first texture delivery and each device
//   change. The host posts its presentation-mode message from it.
// - createPresenter: the presenter factory, defaulting to the real
//   createCanvasPresenter. The parameterization point for environments
//   without a GPU canvas (Deno policy tests inject a recording factory).
//
// The policy options are factory-static: renderMode, alphaMode, and
// wantExtended bind at creation and never re-read. A caller changing
// presenter policy on a live surface creates a fresh delivery instance
// (device recreation alone needs no new instance; it is automatic).
//
// Texture deliveries cache the presenter per device and RECREATE it (old
// one destroyed) when delivery.device changes: a renderer that replaced
// its GPUDevice killed the presenter's pipeline with it. Pixel deliveries
// (the WebGL 2 fallback) present through a cached 2d context, quantized by
// the engine's one byte-domain rule (quantizeWorkingPixels).
export function createPresentationDelivery({
  canvas,
  renderMode = "standard",
  alphaMode = undefined,
  wantExtended = true,
  onMode = null,
  createPresenter = createCanvasPresenter,
}) {
  let presenter = null;
  let presenterDevice = null;
  let fallbackContext = null;
  return function deliver(delivery) {
    const { width, height } = delivery;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (delivery.textureImage !== undefined) {
      if (presenter === null || presenterDevice !== delivery.device) {
        presenter?.destroy();
        const extended = wantExtended === true &&
          probeExtendedRange(delivery.device);
        presenter = createPresenter({
          canvas,
          device: delivery.device,
          renderMode,
          extended,
          ...(alphaMode !== undefined ? { alphaMode } : {}),
        });
        presenterDevice = delivery.device;
        if (onMode !== null) {
          onMode({ extended, dynamicRange: presenter.dynamicRange ?? null });
        }
      }
      presenter.present(delivery.textureImage);
      return { width, height };
    }
    fallbackContext ??= canvas.getContext("2d");
    const quantized = quantizeWorkingPixels(delivery.pixels);
    const encoded = quantized instanceof Uint8ClampedArray
      ? quantized
      : new Uint8ClampedArray(
        quantized.buffer,
        quantized.byteOffset,
        quantized.length,
      );
    fallbackContext.putImageData(new (HostImageData ?? ImageData)(encoded, width, height), 0, 0);
    return { width, height };
  };
}
