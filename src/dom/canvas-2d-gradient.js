// CanvasGradient (HTML "Fill and stroke styles"). A gradient is a paint
// style (src/dom/canvas-2d-paint.js); the canvas core checks its stops and
// computes its definition, the shader that Chrome's GPU canvas builds for
// it (core/engine/canvas-2d-gradient.watpart). This object keeps the geometry
// and the stops; the DOM core parses each stop color in Chrome's
// precision.
import { PAINT_DEFINITION } from "./canvas-2d-paint.js";

const INTERFACE = "CanvasGradient";
const CONSTRUCTION = Symbol("CanvasGradient construction");

function nonFinite(member) {
  return new TypeError(`${INTERFACE}.${member}: The provided double value is non-finite.`);
}

export class CanvasGradient {
  #kind;
  #geometry;
  #parseColor;
  #core;
  #stops = [];
  // The definition words by canvas color space.
  #words = new Map();

  // Not constructible from scripts, as in Chrome; createGradient() makes
  // one. `parseColor(text)` returns { color, oklabColor, oklabPadding:
  // [r, g, b, a] in Chrome's precision (the stop of an sRGB gradient, of
  // an OKLab gradient, and the stop an OKLab gradient adds at 0), legacy:
  // whether it is a legacy sRGB color }, or null. `core` is the canvas
  // core's gradient: `offsetValid(offset)` and `words(kind, geometry,
  // stops, colorSpace)`, the definition words.
  constructor(...values) {
    const [token, kind, geometry, parseColor, core] = values;
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#kind = kind;
    this.#geometry = geometry;
    this.#parseColor = parseColor;
    this.#core = core;
  }

  addColorStop(offset, color) {
    const stops = this.#stops;
    if (arguments.length < 2) {
      throw new TypeError(
        `${INTERFACE}.addColorStop: 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    const value = Number(offset);
    if (!Number.isFinite(value)) throw nonFinite("addColorStop");
    const text = String(color);
    if (!this.#core.offsetValid(value)) {
      throw new DOMException(
        `${INTERFACE}.addColorStop: The provided value (${value}) is outside the range (0.0, 1.0).`,
        "IndexSizeError",
      );
    }
    const parsed = this.#parseColor(text);
    if (parsed === null) {
      throw new DOMException(
        `${INTERFACE}.addColorStop: The value provided ('${text}') could not be parsed as a color.`,
        "SyntaxError",
      );
    }
    stops.push(Object.freeze({ offset: value, ...parsed }));
    this.#words.clear();
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: INTERFACE, configurable: true });
  }

  [PAINT_DEFINITION](context) {
    const space = context.colorSpace();
    let words = this.#words.get(space);
    if (words === undefined) {
      words = this.#core.words(this.#kind, this.#geometry, this.#stops, space);
      this.#words.set(space, words);
    }
    return words;
  }
}

// A gradient of `kind` (the canvas core's GRADIENT_LINEAR: x0, y0, x1, y1;
// GRADIENT_CONICAL: x0, y0, r0, x1, y1, r1; GRADIENT_SWEEP: start angle,
// x, y), for CanvasRenderingContext2D.
export function createGradient(kind, geometry, parseColor, core) {
  return new CanvasGradient(CONSTRUCTION, kind, geometry, parseColor, core);
}
