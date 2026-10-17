// CanvasPattern of a Sandom document (plans/dom/PLAN-canvas-2d.md, slice 4;
// docs/specifications/canvas-2d.md).
//
// createPattern() (src/dom/canvas-2d.js) takes the source image when it is
// called, as Chrome does: a pattern of a 2D canvas keeps the canvas's
// bitmap of that time, the same snapshot that drawImage() records. The
// pattern keeps its snapshot until the pattern is collected.
//
// Chrome's pattern (Blink ImagePattern) is an image shader with the
// pattern transform as its local matrix: a repeated axis tiles, the other
// axis is decal (transparent outside the image). The rasterizer
// (src/shaders/canvas-raster.wgsl, patternColor) ports Graphite's image
// shader for these tile modes.
import { PAINT_DEFINITION } from "./canvas-2d-paint.js";
import { matrixFromInit } from "./canvas-2d-matrix-init.js";
import { sourceConversion } from "./canvas-2d-color-space.js";

const INTERFACE = "CanvasPattern";
const CONSTRUCTION = Symbol("CanvasPattern construction");

// The paint kind of a pattern in the paint block (canvas-2d-paint.watpart);
// gradients take kinds 1 to 3.
export const PATTERN_PAINT_KIND = 4;
export const PATTERN_REPEAT_X = 1;
export const PATTERN_REPEAT_Y = 2;
// A pattern whose transform is not invertible paints transparent black, as
// in Chrome (measured 2026-10-12, also under globalCompositeOperation
// "copy").
export const PATTERN_EMPTY = 4;
// The words of a pattern's definition: kind, tile modes, source index,
// source color space conversion (canvas-2d-color-space.js); width, height,
// 1 / width, 1 / height (float); the inverse of the pattern transform (a,
// b, c, d, e, f), 0, 0.
export const PATTERN_WORDS = 16;

const REPETITIONS = Object.freeze({
  "": PATTERN_REPEAT_X | PATTERN_REPEAT_Y,
  repeat: PATTERN_REPEAT_X | PATTERN_REPEAT_Y,
  "repeat-x": PATTERN_REPEAT_X,
  "repeat-y": PATTERN_REPEAT_Y,
  "no-repeat": 0,
});

// The tile modes of a repetition (Blink CanvasPattern::ParseRepetitionType),
// or null when the repetition is not one of them. `value` is the converted
// DOMString ([LegacyNullToEmptyString]: null is "").
export function patternRepetition(value) {
  return Object.hasOwn(REPETITIONS, value) ? REPETITIONS[value] : null;
}

// The inverse of the affine matrix [a, b, c, d, e, f] as Skia's
// SkMatrix::invert computes the pattern's local matrix inverse (float
// entries; a scale and translate in float, else in double from the
// double determinant), or null when it is not invertible.
function inverseOf(matrix) {
  const f = Math.fround;
  const [a, b, c, d, e, g] = matrix.map(f);
  if (b === 0 && c === 0) {
    if (a === 1 && d === 1) return Number.isFinite(e) && Number.isFinite(g) ? [1, 0, 0, 1, f(-e), f(-g)] : null;
    const invX = f(1 / a);
    const invY = f(1 / d);
    const inverse = [invX, 0, 0, invY, f(-e * invX), f(-g * invY)];
    return inverse.every(Number.isFinite) ? inverse : null;
  }
  const determinant = a * d - c * b;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const scale = 1 / determinant;
  const inverse = [d * scale, -b * scale, -c * scale, a * scale, (c * g - d * e) * scale, (b * e - a * g) * scale].map(f);
  return inverse.every(Number.isFinite) ? inverse : null;
}

export class CanvasPattern {
  #source;
  #width;
  #height;
  #repetition;
  #inverse = [1, 0, 0, 1, 0, 0];

  constructor(token, source, width, height, repetition) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#source = source;
    this.#width = width;
    this.#height = height;
    this.#repetition = repetition;
  }

  get [Symbol.toStringTag]() {
    return INTERFACE;
  }

  setTransform(transform = undefined) {
    if (!(#inverse in this)) throw new TypeError("Illegal invocation");
    const matrix = matrixFromInit(transform, `${INTERFACE}.setTransform`);
    this.#inverse = inverseOf(matrix);
  }

  [PAINT_DEFINITION](context) {
    const words = new Float32Array(PATTERN_WORDS);
    words[0] = PATTERN_PAINT_KIND;
    if (this.#inverse === null) {
      words[1] = PATTERN_EMPTY;
      return words;
    }
    words[1] = this.#repetition;
    words[2] = context.addSource(this.#source);
    words[3] = sourceConversion(this.#source, context.colorSpace());
    words[4] = this.#width;
    words[5] = this.#height;
    words[6] = 1 / this.#width;
    words[7] = 1 / this.#height;
    words.set(this.#inverse, 8);
    return words;
  }
}

export function createCanvasPattern(source, width, height, repetition) {
  return new CanvasPattern(CONSTRUCTION, source, width, height, repetition);
}
