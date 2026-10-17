// The protocol between CanvasRenderingContext2D (src/dom/canvas-2d.js) and
// its paint styles, CanvasGradient and CanvasPattern (plans/dom/PLAN-canvas-2d.md,
// slice 4).
//
// A paint style implements [PAINT_DEFINITION](context). The 2D context calls
// it before each draw that uses the paint as its fill or stroke style, because
// a draw reads the paint as it is when the draw is made. It returns the
// paint's definition as a Float32Array; its first word names the paint kind.
// The core copies the words after the current transform into the draw's
// paint block (src/wasm/canvas-2d-paint.watpart), which the rasterizer
// (src/shaders/canvas-raster.wgsl) evaluates. `context.addSource(source)` keeps a
// texture or command-list source alive for the flush and returns its index in
// the command list's sources, as drawImage() records its source.
// `context.colorSpace()` is the color space of the canvas that draws.
export const PAINT_DEFINITION = Symbol("Sandom Canvas 2D paint definition");

export function isCanvasPaint(value) {
  return value !== null && typeof value === "object" && typeof value[PAINT_DEFINITION] === "function";
}
