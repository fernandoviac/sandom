// CanvasPattern of a Sandom document (plans/dom/PLAN-canvas-2d.md, slice 4;
// docs/specifications/canvas-2d.md).
//
// createPattern() (src/dom/canvas-2d.js) takes the source image when it is
// called, as Chrome does: a pattern of a 2D canvas keeps the canvas's
// bitmap of that time, the same snapshot that drawImage() records. The
// pattern keeps its snapshot until the pattern is collected. The canvas
// core reads the repetition, inverts the transform and writes the paint
// definition (core/engine/canvas-2d-paint.watpart, "patterns").
import { PAINT_DEFINITION } from "./canvas-2d-paint.js";

const INTERFACE = "CanvasPattern";
const CONSTRUCTION = Symbol("CanvasPattern construction");

export class CanvasPattern {
  #source;
  #width;
  #height;
  #repetition;
  #core;
  // The pattern transform (a, b, c, d, e, f).
  #matrix = [1, 0, 0, 1, 0, 0];

  // `core` is the canvas core's pattern: `matrixFromInit(value, member)`
  // and `words(context, source, width, height, repetition, matrix)`, the
  // definition words of a draw of `context`.
  constructor(token, source, width, height, repetition, core) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#source = source;
    this.#width = width;
    this.#height = height;
    this.#repetition = repetition;
    this.#core = core;
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: INTERFACE, configurable: true });
  }

  setTransform(transform = undefined) {
    if (!(#matrix in this)) throw new TypeError("Illegal invocation");
    this.#matrix = this.#core.matrixFromInit(transform, `${INTERFACE}.setTransform`);
  }

  [PAINT_DEFINITION](context) {
    return this.#core.words(context, this.#source, this.#width, this.#height, this.#repetition, this.#matrix);
  }
}

export function createCanvasPattern(source, width, height, repetition, core) {
  return new CanvasPattern(CONSTRUCTION, source, width, height, repetition, core);
}
