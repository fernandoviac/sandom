// CanvasGradient (plans/dom/PLAN-canvas-2d.md, slice 4; HTML "Fill and stroke
// styles"). A gradient is a paint style (src/dom/canvas-2d-paint.js): its
// definition is the shader that Chrome's GPU canvas (Graphite) builds for
// it, computed here as Chrome computes it, and the rasterizer
// (gradientColor in src/shaders/canvas-raster.wgsl) evaluates it per pixel.
//
// The definition follows Chrome through three layers:
//
//   Blink (platform/graphics/gradient.cc): stops sort by offset, stably; a
//     gradient with no stops is one transparent black stop; the first stop
//     repeats at offset 0 and the last at offset 1 when they are not there.
//     A linear gradient with equal points and a radial gradient with equal
//     circles draw nothing. A conic gradient is a sweep from 0 to 360
//     degrees, rotated by its start angle.
//   Skia (src/shaders/gradients): nearly degenerate geometry becomes a solid
//     color or a simpler gradient; stops that are evenly spaced within
//     1/4096 become exactly even; three or more stops at one offset keep
//     only the first and the last. Each gradient maps local coordinates to
//     its unit space with a matrix, computed in single precision.
//   Graphite (KeyHelpers.cpp, sksl_graphite_frag.sksl): up to 4 and up to 8
//     stops are evaluated by an unrolled search, more stops by a binary
//     search; colors interpolate unpremultiplied, then premultiply; the
//     paint alpha (globalAlpha) multiplies the color; the result is
//     dithered into the 8-bit canvas with Skia's 8x8 ordered-dither table.
//     A solid color is not dithered.
//
// Colors interpolate in sRGB when every stop is a legacy sRGB color (hex,
// named, rgb(), hsl(), hwb()); one stop of another syntax (color(), lab(),
// oklch(), ...) makes Blink interpolate the whole gradient in OKLab
// (Color::GetColorInterpolationSpace). Blink converts each stop to OKLab
// and back to sRGB in single precision before it hands it to Skia
// (Gradient::FillSkiaStops, Color::ToGradientStopSkColor4f; the DOM
// core's color_parsed_oklab_stop). Skia then converts each stop to
// linear sRGB with its raster pipeline's approximate power function and
// to OKLab, and the shader converts back and encodes sRGB.
//
// Stop colors keep Chrome's precision: rgb(), hex and named colors are
// 8-bit components (rgb(127.6 0 0) is 128), hsl() and hwb() keep their
// floating-point components, and alpha of a legacy color has 8 bits
// (measured on the pinned Chrome, 2026-10-12).
import { PAINT_DEFINITION } from "./canvas-2d-paint.js";

const INTERFACE = "CanvasGradient";
const CONSTRUCTION = Symbol("CanvasGradient construction");

// Paint kinds of the definition (src/dom/canvas-2d-paint.js): Graphite's
// linear, two-point conical (radial included) and sweep gradients.
export const GRADIENT_LINEAR = 1;
export const GRADIENT_CONICAL = 2;
export const GRADIENT_SWEEP = 3;

// Interpolation spaces (Graphite's colorSpace uniform, reduced to the ones
// a canvas gradient uses).
const SPACE_SRGB = 0;
const SPACE_OKLAB = 1;

// The definition's header, in words: kind, stop count, solid (1: a solid
// color, not dithered), interpolation space; the gradient matrix (scale x,
// skew y, skew x, scale y; translate x, translate y, 0, 0); four
// parameters of the kind. The offsets follow (padded to 4, 8 or a
// multiple of 4), then the colors in the interpolation space.
const HEADER_WORDS = 16;

const f32 = Math.fround;
// SkGradientBaseShader::kDegenerateThreshold and SK_ScalarNearlyZero.
const DEGENERATE = 1 / (1 << 15);
const NEARLY_ZERO = 1 / (1 << 12);
const TRANSPARENT = Object.freeze([0, 0, 0, 0]);

function nearlyZero(value, tolerance = NEARLY_ZERO) {
  return Math.abs(value) <= tolerance;
}

function nearlyEqual(a, b, tolerance = NEARLY_ZERO) {
  return Math.abs(a - b) <= tolerance;
}

// SkPoint::Length in single precision.
function length(dx, dy) {
  const squared = f32(f32(dx * dx) + f32(dy * dy));
  if (Number.isFinite(squared)) return f32(Math.sqrt(squared));
  return f32(Math.sqrt(dx * dx + dy * dy));
}

// ------------------------------------------------------------- SkMatrix
//
// The affine subset of SkMatrix that gradients use, in single precision,
// with the type masks whose fast paths decide the rounding. m holds
// scale x, skew x, translate x, skew y, scale y, translate y.

const TRANSLATE_MASK = 1;
const SCALE_MASK = 2;
const AFFINE_MASK = 4;
const UNKNOWN_MASK = 0x80;

function matrix(m, mask = UNKNOWN_MASK) {
  return { m: m.map(f32), mask };
}

const IDENTITY = matrix([1, 0, 0, 0, 1, 0], 0);

function computeType(m) {
  let mask = 0;
  if (m[2] !== 0 || m[5] !== 0) mask |= TRANSLATE_MASK;
  if (m[1] !== 0 || m[3] !== 0) mask |= AFFINE_MASK | SCALE_MASK;
  else if (m[0] !== 1 || m[4] !== 1) mask |= SCALE_MASK;
  return mask;
}

function typeOf(matrix) {
  if (matrix.mask & UNKNOWN_MASK) matrix.mask = computeType(matrix.m);
  return matrix.mask;
}

function triviallyIdentity(matrix) {
  return (matrix.mask & UNKNOWN_MASK) === 0 && (matrix.mask & 0xf) === 0;
}

function translation(dx, dy) {
  return matrix([1, 0, dx, 0, 1, dy], dx !== 0 || dy !== 0 ? TRANSLATE_MASK : 0);
}

function scaling(sx, sy) {
  return matrix([sx, 0, 0, 0, sy, 0], sx === 1 && sy === 1 ? 0 : SCALE_MASK);
}

// a * b in double precision, rounded once.
function mulAddMul(a, b, c, d) {
  return f32(a * b + c * d);
}

// SkMatrix::setConcat: a after b.
function concat(a, b) {
  const aType = typeOf(a);
  const bType = typeOf(b);
  if (triviallyIdentity(a)) return { m: [...b.m], mask: b.mask };
  if (triviallyIdentity(b)) return { m: [...a.m], mask: a.mask };
  const [as, ak, at, ay, ac, au] = a.m;
  const [bs, bk, bt, by, bc, bu] = b.m;
  if (((aType | bType) & AFFINE_MASK) === 0) {
    return matrix([f32(as * bs), 0, f32(f32(as * bt) + at), 0, f32(ac * bc), f32(f32(ac * bu) + au)]);
  }
  return matrix([
    mulAddMul(as, bs, ak, by),
    mulAddMul(as, bk, ak, bc),
    f32(mulAddMul(as, bt, ak, bu) + at),
    mulAddMul(ay, bs, ac, by),
    mulAddMul(ay, bk, ac, bc),
    f32(mulAddMul(ay, bt, ac, bu) + au),
  ]);
}

function postConcat(target, other) {
  return typeOf(other) === 0 ? target : concat(other, target);
}

function preConcat(target, other) {
  return typeOf(other) === 0 ? target : concat(target, other);
}

function postTranslate(target, dx, dy) {
  const m = [...target.m];
  m[2] = f32(m[2] + dx);
  m[5] = f32(m[5] + dy);
  let mask = target.mask;
  if (m[2] !== 0 || m[5] !== 0) mask |= TRANSLATE_MASK;
  else mask &= ~TRANSLATE_MASK;
  return { m, mask };
}

function postScale(target, sx, sy) {
  if (sx === 1 && sy === 1) return target;
  return postConcat(target, scaling(sx, sy));
}

// SkMatrix::setSinCos about (px, py).
function sinCos(sin, cos, px, py) {
  const oneMinusCos = f32(1 - cos);
  return matrix([
    cos, f32(-sin), f32(f32(sin * py) + f32(oneMinusCos * px)),
    sin, cos, f32(f32(-sin * px) + f32(oneMinusCos * py)),
  ]);
}

// SkMatrix::setRotate(degrees, px, py), sines snapped to zero below 2^-16.
function rotation(degrees, px, py) {
  const radians = f32(degrees * f32(f32(3.14159265) / 180));
  const snap = (value) => (Math.abs(value) <= 1 / (1 << 16) ? 0 : value);
  return sinCos(snap(f32(Math.sin(radians))), snap(f32(Math.cos(radians))), px, py);
}

// SkMatrix::invert of an affine matrix; null when it is not invertible.
function invert(target) {
  const type = typeOf(target);
  if (type === 0) return target;
  const [s, k, t, y, c, u] = target.m;
  if ((type & ~(SCALE_MASK | TRANSLATE_MASK)) === 0) {
    if (type & SCALE_MASK) {
      const inverseX = f32(1 / s);
      const inverseY = f32(1 / c);
      if (!Number.isFinite(inverseX) || !Number.isFinite(inverseY)) return null;
      const tx = f32(-t * inverseX);
      const ty = f32(-u * inverseY);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
      return { m: [inverseX, 0, tx, 0, inverseY, ty], mask: type };
    }
    if (!Number.isFinite(t) || !Number.isFinite(u)) return null;
    return translation(-t, -u);
  }
  const determinant = s * c - k * y;
  if (nearlyZero(f32(determinant), NEARLY_ZERO * NEARLY_ZERO * NEARLY_ZERO)) return null;
  const inverse = 1 / determinant;
  const m = [
    f32(c * inverse),
    f32(-k * inverse),
    f32((k * u - c * t) * inverse),
    f32(-y * inverse),
    f32(s * inverse),
    f32((y * t - s * u) * inverse),
  ];
  if (!m.every(Number.isFinite)) return null;
  return { m, mask: type };
}

// SkMatrix::PolyToPoly of two points onto (0, 0) and (1, 0).
function mapToUnitX(x0, y0, x1, y1) {
  const poly = (ax, ay, bx, by) =>
    matrix([f32(by - ay), f32(bx - ax), ax, f32(ax - bx), f32(by - ay), ay]);
  const inverse = invert(poly(x0, y0, x1, y1));
  if (inverse === null) return null;
  return concat(poly(0, 0, 1, 0), inverse);
}

// --------------------------------------------------------------- stops

// Blink's Gradient::FillSkiaStops: positions and unpremultiplied sRGB
// colors that start at 0 and end at 1, and the interpolation space. In
// OKLab each stop is its color through OKLab and back to sRGB, and a
// stop added at 0 is the first stop's own sRGB.
function blinkStops(stops) {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const space = sorted.every((stop) => stop.legacy) ? SPACE_SRGB : SPACE_OKLAB;
  const oklab = space === SPACE_OKLAB;
  const positions = [];
  const colors = [];
  if (sorted.length === 0) {
    positions.push(0);
    colors.push(TRANSPARENT);
  } else if (sorted[0].offset > 0) {
    positions.push(0);
    colors.push(oklab ? sorted[0].oklabPadding : sorted[0].color);
  }
  for (const stop of sorted) {
    positions.push(stop.offset);
    colors.push(oklab ? stop.oklabColor : stop.color);
  }
  if (positions.at(-1) < 1) {
    positions.push(1);
    colors.push(colors.at(-1));
  }
  return { positions, colors, space };
}

// SkGradientBaseShader's stops for positions that start at 0 and end at 1:
// monotonic positions, implicit (null) when evenly spaced within 1/4096,
// and runs of three or more equal positions reduced to their first and
// last stop.
function skiaStops({ positions, colors, space }) {
  const count = positions.length;
  const pinned = [0];
  let previous = 0;
  let uniform = true;
  const step = f32(positions[1] - previous);
  for (let index = 1; index < count; index++) {
    const current = Math.min(Math.max(positions[index], previous), 1);
    uniform &&= nearlyEqual(step, f32(current - previous));
    pinned.push(current);
    previous = current;
  }
  if (uniform) return { positions: null, colors, space };
  const keptPositions = [];
  const keptColors = [];
  let first = 0;
  for (let index = 1; index <= count; index++) {
    if (index === count || pinned[first] !== pinned[index]) {
      keptPositions.push(pinned[first]);
      keptColors.push(colors[first]);
      if (index - first > 1) {
        keptPositions.push(pinned[index - 1]);
        keptColors.push(colors[index - 1]);
      }
      first = index;
    }
  }
  return { positions: keptPositions, colors: keptColors, space };
}

// -------------------------------------------------------------- colors

// SkRasterPipeline's approximate log2 and pow2 (SkRasterPipeline_opts.h,
// ARM64: mad and nmad fuse, round is to nearest even).
const bits = new DataView(new ArrayBuffer(4));

function fused(a, b, c) {
  return f32(a * b + c);
}

function approximateLog2(x) {
  bits.setFloat32(0, x);
  const word = bits.getUint32(0);
  const e = f32(f32(word) * f32(1 / (1 << 23)));
  bits.setUint32(0, (word & 0x007fffff) | 0x3f000000);
  const m = bits.getFloat32(0);
  return f32(fused(-m, f32(1.498030302), f32(e - f32(124.225514990))) -
    f32(f32(1.725879990) / f32(f32(0.3520887068) + m)));
}

function approximatePow2(x) {
  const fraction = f32(x - Math.floor(x));
  let approximation = fused(-fraction, f32(1.490129070), f32(x + f32(121.274057500)));
  approximation = f32(approximation + f32(f32(27.728023300) / f32(f32(4.84252568) - fraction)));
  approximation = f32(approximation * (1 << 23));
  approximation = Math.min(Math.max(approximation, 0), 0x7f800000);
  const rounded = Math.round(approximation);
  const even = rounded - approximation === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
  bits.setUint32(0, even);
  return bits.getFloat32(0);
}

function approximatePow(x, y) {
  if (x === 0 || x === 1) return x;
  return approximatePow2(f32(approximateLog2(x) * y));
}

// skcms's sRGB transfer function, applied by the raster pipeline's
// parametric stage.
const SRGB_TRANSFER = Object.freeze({
  g: f32(2.4), a: f32(1 / 1.055), b: f32(0.055 / 1.055), c: f32(1 / 12.92), d: f32(0.04045), e: 0, f: 0,
});

function linearize(value) {
  const { g, a, b, c, d, e, f } = SRGB_TRANSFER;
  const sign = value < 0 || Object.is(value, -0) ? -1 : 1;
  const v = Math.abs(value);
  const result = v <= d ? fused(c, v, f) : f32(approximatePow(fused(a, v, b), g) + e);
  return sign * result;
}

// Skia's lin_srgb_to_oklab, in single precision.
function oklab([red, green, blue, alpha]) {
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const sum3 = (x, y, z) => f32(f32(x + y) + z);
  const l = f32(Math.cbrt(sum3(f32(f32(0.4122214708) * r), f32(f32(0.5363325363) * g), f32(f32(0.0514459929) * b))));
  const m = f32(Math.cbrt(sum3(f32(f32(0.2119034982) * r), f32(f32(0.6806995451) * g), f32(f32(0.1073969566) * b))));
  const s = f32(Math.cbrt(sum3(f32(f32(0.0883024619) * r), f32(f32(0.2817188376) * g), f32(f32(0.6299787005) * b))));
  return [
    f32(f32(f32(f32(0.2104542553) * l) + f32(f32(0.7936177850) * m)) - f32(f32(0.0040720468) * s)),
    f32(f32(f32(f32(1.9779984951) * l) - f32(f32(2.4285922050) * m)) + f32(f32(0.4505937099) * s)),
    f32(f32(f32(f32(0.0259040371) * l) + f32(f32(0.7827717662) * m)) - f32(f32(0.8086757660) * s)),
    alpha,
  ];
}

// ----------------------------------------------------------- definition

// The definition words of a gradient: kind, the matrix from local
// coordinates to the gradient's unit space, the kind's parameters and the
// stops as Graphite's uniforms hold them.
function definitionWords(kind, unit, parameters, { positions, colors, space }, solid = false) {
  const count = colors.length;
  // Graphite rounds up to 4 or 8 stops, repeating the last; more stops are
  // searched in a buffer of exactly `count`.
  const padded = count <= 4 ? 4 : count <= 8 ? 8 : Math.ceil(count / 4) * 4;
  const words = new Float32Array(HEADER_WORDS + padded * 5);
  words[0] = kind;
  words[1] = count;
  words[2] = solid ? 1 : 0;
  words[3] = space;
  const [s, k, t, y, c, u] = unit.m;
  words.set([s, y, k, c, t, u], 4);
  words.set(parameters, 12);
  const converted = space === SPACE_OKLAB ? colors.map(oklab) : colors;
  const colorBase = HEADER_WORDS + padded;
  for (let index = 0; index < padded; index++) {
    const source = Math.min(index, count - 1);
    words[HEADER_WORDS + index] = positions !== null ? positions[source] : count === 1 ? 0 : f32(source / (count - 1));
    words.set(converted[source], colorBase + index * 4);
  }
  return words;
}

// A solid color: Skia's degenerate gradient, drawn as a color, or Blink's
// empty shader (transparent).
function solidWords(color) {
  return definitionWords(GRADIENT_LINEAR, matrix([0, 0, 0, 0, 0, 0], 0), [0, 0, 0, 0], {
    positions: null,
    colors: [color],
    space: SPACE_SRGB,
  }, true);
}

function linearWords(geometry, stops) {
  const [x0, y0, x1, y1] = geometry;
  if (x0 === x1 && y0 === y1) return solidWords(TRANSPARENT);
  const dx = f32(x1 - x0);
  const dy = f32(y1 - y0);
  const magnitude = length(dx, dy);
  if (!Number.isFinite(magnitude)) return solidWords(TRANSPARENT);
  if (nearlyZero(magnitude, DEGENERATE)) return solidWords(stops.colors.at(-1));
  // SkLinearGradient's pts_to_unit_matrix.
  const inverse = magnitude ? f32(1 / magnitude) : 0;
  const vx = f32(dx * inverse);
  const vy = f32(dy * inverse);
  let unit = sinCos(f32(-vy), vx, x0, y0);
  unit = postTranslate(unit, f32(-x0), f32(-y0));
  unit = postScale(unit, inverse, inverse);
  return definitionWords(GRADIENT_LINEAR, unit, [0, 0, 0, 0], skiaStops(stops));
}

// SkRadialGradient as Graphite's conical radial case: t = |p| * 1 - 0.
function radialWords(cx, cy, radius, stops) {
  if (nearlyZero(radius, DEGENERATE)) return solidWords(stops.colors.at(-1));
  const unit = postScale(translation(f32(-cx), f32(-cy)), f32(1 / radius), f32(1 / radius));
  return definitionWords(GRADIENT_CONICAL, unit, [0, 1, 0, 1], skiaStops(stops));
}

function conicalWords(geometry, stops) {
  const [x0, y0, r0Input, x1, y1, r1Input] = geometry;
  const r0 = Math.max(r0Input, 0);
  const r1 = Math.max(r1Input, 0);
  if (x0 === x1 && y0 === y1 && r0 === r1) return solidWords(TRANSPARENT);
  // SkShaders::TwoPointConicalGradient.
  const centerDistance = length(f32(x0 - x1), f32(y0 - y1));
  if (nearlyZero(centerDistance, DEGENERATE)) {
    if (nearlyEqual(r0, r1, DEGENERATE)) {
      if (r1 > DEGENERATE) {
        // An infinitely thin ring: the first color inside, the last outside.
        const first = stops.colors[0];
        return radialWords(x0, y0, r1, {
          positions: [0, 1, 1],
          colors: [first, first, stops.colors.at(-1)],
          space: stops.space,
        });
      }
      return solidWords(stops.colors.at(-1));
    }
    if (nearlyZero(r0, DEGENERATE)) return radialWords(x0, y0, r1, stops);
  }
  // SkConicalGradient::Create with Graphite's matrices and uniforms.
  let unit;
  let radius0;
  let radius1;
  const radial = nearlyZero(centerDistance);
  if (radial) {
    if (nearlyZero(Math.max(r0, r1)) || nearlyEqual(r0, r1)) return solidWords(TRANSPARENT);
    const difference = f32(r1 - r0);
    const scale = f32(1 / difference);
    unit = postScale(translation(f32(-x0), f32(-y0)), scale, scale);
    radius0 = f32(r0 / difference);
    radius1 = f32(r1 / difference);
  } else {
    unit = mapToUnitX(x0, y0, x1, y1);
    if (unit === null) return solidWords(TRANSPARENT);
    radius0 = f32(r0 / centerDistance);
    radius1 = f32(r1 / centerDistance);
  }
  let deltaRadius = f32(radius1 - radius0);
  let a = 0;
  let inverseA = 1;
  if (centerDistance < NEARLY_ZERO) {
    deltaRadius = radius0 > 0 ? 1 : -1;
  } else {
    a = f32(1 - f32(deltaRadius * deltaRadius));
    if (Math.abs(a) > NEARLY_ZERO) {
      inverseA = f32(1 / (2 * a));
    } else {
      a = 0;
      inverseA = 0;
    }
  }
  return definitionWords(GRADIENT_CONICAL, unit, [radius0, deltaRadius, a, inverseA], skiaStops(stops));
}

function sweepWords(geometry, stops) {
  const [startAngle, cx, cy] = geometry;
  // Blink: the start angle in degrees plus 90; Skia's sweep starts on the
  // x axis, so the shader rotates by that angle minus 90 about the center.
  const degrees = f32(f32(startAngle * f32(180 / f32(Math.PI))) + 90);
  const turn = f32(degrees - 90);
  let unit = translation(f32(-cx), f32(-cy));
  if (turn !== 0) {
    const local = invert(preConcat(IDENTITY, rotation(turn, cx, cy)));
    if (local === null) return solidWords(TRANSPARENT);
    unit = postConcat(local, unit);
  }
  // SkSweepGradient from 0 to 360 degrees: bias -0, scale 1.
  return definitionWords(GRADIENT_SWEEP, unit, [-0, 1, 0, 0], skiaStops(stops));
}

// ------------------------------------------------------------- interface

function nonFinite(member) {
  return new TypeError(`${INTERFACE}.${member}: The provided double value is non-finite.`);
}

export class CanvasGradient {
  #kind;
  #geometry;
  #parseColor;
  #stops = [];
  #words = null;

  // Not constructible from scripts, as in Chrome; createGradient() makes
  // one. `parseColor(text)` returns { color, oklabColor, oklabPadding:
  // [r, g, b, a] in Chrome's precision (the stop of an sRGB gradient, of
  // an OKLab gradient, and the stop an OKLab gradient adds at 0), legacy:
  // whether it is a legacy sRGB color }, or null.
  constructor(...values) {
    const [token, kind, geometry, parseColor] = values;
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#kind = kind;
    this.#geometry = geometry.map(f32);
    this.#parseColor = parseColor;
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
    if (!(value >= 0 && value <= 1)) {
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
    stops.push({
      offset: f32(value),
      color: parsed.color.map(f32),
      oklabColor: parsed.oklabColor.map(f32),
      oklabPadding: parsed.oklabPadding.map(f32),
      legacy: parsed.legacy,
    });
    this.#words = null;
  }

  get [Symbol.toStringTag]() {
    return INTERFACE;
  }

  // Word 11 (after the unit matrix's translate) is 1 when the canvas that
  // draws the gradient is display-p3: Chrome interpolates the stops in
  // sRGB and converts each pixel into the canvas's color space.
  [PAINT_DEFINITION](context) {
    if (this.#words === null) {
      const stops = blinkStops(this.#stops);
      const geometry = this.#geometry;
      if (this.#kind === GRADIENT_LINEAR) this.#words = linearWords(geometry, stops);
      else if (this.#kind === GRADIENT_CONICAL) this.#words = conicalWords(geometry, stops);
      else this.#words = sweepWords(geometry, stops);
    }
    if (context.colorSpace() === "srgb") return this.#words;
    const words = this.#words.slice();
    words[11] = 1;
    return words;
  }
}

// A gradient of `kind` (GRADIENT_LINEAR: x0, y0, x1, y1; GRADIENT_CONICAL:
// x0, y0, r0, x1, y1, r1; GRADIENT_SWEEP: start angle, x, y), for
// CanvasRenderingContext2D.
export function createGradient(kind, geometry, parseColor) {
  return new CanvasGradient(CONSTRUCTION, kind, geometry, parseColor);
}
