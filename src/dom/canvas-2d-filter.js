// The filter attribute of the Canvas 2D context (plans/dom/PLAN-canvas-2d.md,
// slice 4): parsing, resolution and the filter block that the rasterizer
// reads.
//
// Chrome parses the value as the CSS `filter` property
// (CSSParser::ParseSingleValue). An invalid value, a CSS-wide keyword
// included, is ignored. The getter returns the text that was set. Chrome
// resolves the value against the canvas font of the time the value was set
// (em) and the document (rem), with currentcolor as black
// (CanvasRenderingContext2DState::GetFilter). Each function becomes one
// filter effect of Blink's FilterEffectBuilder, in sRGB:
//   grayscale(), sepia(), saturate(), hue-rotate()  FEColorMatrix, a Skia
//     matrix color filter on unpremultiplied color, clamped;
//   invert(), opacity(), brightness(), contrast()   FEComponentTransfer, a
//     Skia table color filter: four 256-entry tables of bytes;
//   blur(), drop-shadow()                           a Gaussian blur and a
//     drop shadow.
// Sandom resolves those numbers here as Blink computes them, in the same
// precision, so that the rasterizer applies exactly Chrome's tables and
// matrices.
//
// A value that Chrome accepts and Sandom cannot draw throws
// NotSupportedError: an SVG filter reference (url()), a length in a unit
// that needs font metrics, the viewport or a container, and a math function
// other than calc().

const f32 = Math.fround;

// The kinds of a filter step in the filter block.
export const FILTER_MATRIX = 1;
export const FILTER_TABLE = 2;
export const FILTER_BLUR = 3;
export const FILTER_DROP_SHADOW = 4;
// The shadow of a draw with a filter and a shadow (Blink's shadow-only drop
// shadow filter after the filter, Canvas2DRecorderContext::CompositedDraw).
export const FILTER_DROP_SHADOW_ONLY = 5;


const NUMBER_FUNCTIONS = new Set(["brightness", "contrast", "grayscale", "invert", "opacity", "saturate", "sepia"]);
// The functions whose amount Chrome clamps to 1 (ShouldClampFilterFunctionArgument).
const CLAMPED_FUNCTIONS = new Set(["grayscale", "invert", "opacity", "sepia"]);
const FILTER_FUNCTIONS = new Set([...NUMBER_FUNCTIONS, "blur", "drop-shadow", "hue-rotate"]);

const ABSOLUTE_LENGTHS = { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, in: 96, pt: 96 / 72, pc: 16 };
// Lengths that Chrome resolves and Sandom does not: font metrics, the
// viewport and containers.
const UNSUPPORTED_LENGTHS = new Set([
  "ex", "ch", "cap", "ic", "lh", "rlh", "rex", "rch", "rcap", "ric",
  "vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin", "svmax", "lvw", "lvh", "lvi",
  "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax", "cqw", "cqh", "cqi", "cqb", "cqmin",
  "cqmax",
]);
const ANGLES = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const MATH_FUNCTIONS = new Set([
  "min", "max", "clamp", "round", "mod", "rem", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow", "sqrt",
  "hypot", "log", "exp", "abs", "sign",
]);

// A value that Chrome accepts and Sandom cannot draw.
export class UnsupportedFilter extends Error {}

class Invalid extends Error {}

function invalid() {
  return new Invalid("invalid filter");
}

// ------------------------------------------------------------- tokens

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^-?(?:[a-zA-Z_]|[\u0080-\uffff])(?:[\w-]|[\u0080-\uffff])*/;

// CSS component values: { type: "number" | "percentage" | "dimension" |
// "ident" | "hash" | "function" | "url" | "space" | "delim" | "string",
// text (the source), value, unit, name, args (component values) }.
function tokenize(text) {
  let at = 0;
  const readList = (closing) => {
    const list = [];
    for (;;) {
      if (at >= text.length) {
        if (closing) return list;
        return list;
      }
      const start = at;
      const rest = text.slice(at);
      if (rest.startsWith("/*")) {
        const end = text.indexOf("*/", at + 2);
        at = end < 0 ? text.length : end + 2;
        continue;
      }
      const character = text[at];
      if (/\s/.test(character)) {
        while (at < text.length && /\s/.test(text[at])) at++;
        list.push({ type: "space", text: text.slice(start, at) });
        continue;
      }
      if (character === ")") {
        if (!closing) throw invalid();
        at++;
        return list;
      }
      if (character === "(" || character === "[" || character === "{" || character === "\\") throw invalid();
      if (character === '"' || character === "'") {
        const end = text.indexOf(character, at + 1);
        if (end < 0) throw invalid();
        at = end + 1;
        list.push({ type: "string", text: text.slice(start, at), value: text.slice(start + 1, end) });
        continue;
      }
      if (character === "#") {
        const name = /^#[\w-]+/.exec(rest);
        if (!name) throw invalid();
        at += name[0].length;
        list.push({ type: "hash", text: name[0] });
        continue;
      }
      const number = NUMBER.exec(rest);
      if (number) {
        at += number[0].length;
        const value = Number(number[0]);
        if (text[at] === "%") {
          at++;
          list.push({ type: "percentage", text: text.slice(start, at), value });
          continue;
        }
        const unit = NAME.exec(text.slice(at));
        if (unit) {
          at += unit[0].length;
          list.push({ type: "dimension", text: text.slice(start, at), value, unit: unit[0].toLowerCase() });
          continue;
        }
        list.push({ type: "number", text: text.slice(start, at), value });
        continue;
      }
      const name = NAME.exec(rest);
      if (name) {
        at += name[0].length;
        if (text[at] !== "(") {
          list.push({ type: "ident", text: name[0], value: name[0].toLowerCase() });
          continue;
        }
        at++;
        const lower = name[0].toLowerCase();
        if (lower === "url") {
          const close = text.indexOf(")", at);
          if (close < 0) throw invalid();
          at = close + 1;
          list.push({ type: "url", text: text.slice(start, at) });
          continue;
        }
        const args = readList(true);
        list.push({ type: "function", text: text.slice(start, at), name: lower, args });
        continue;
      }
      at++;
      list.push({ type: "delim", text: character, value: character });
    }
  };
  return readList(false);
}

function trimmed(list) {
  return list.filter((token) => token.type !== "space");
}

// ------------------------------------------------------------- calc()

// A numeric value: { type: "number" | "percentage" | "length" | "angle",
// value (px for a length, degrees for an angle), calc }.
function numeric(token, context) {
  if (token.type === "number") return { type: "number", value: token.value, zero: token.value === 0 };
  if (token.type === "percentage") return { type: "percentage", value: token.value };
  if (token.type === "dimension") {
    const unit = token.unit;
    if (unit in ANGLES) return { type: "angle", value: token.value * ANGLES[unit] };
    if (unit in ABSOLUTE_LENGTHS) return { type: "length", value: token.value * ABSOLUTE_LENGTHS[unit] };
    if (unit === "em") return { type: "length", value: token.value * context.fontSize, font: true };
    if (unit === "rem") return { type: "length", value: token.value * context.rootFontSize() };
    if (UNSUPPORTED_LENGTHS.has(unit)) return { type: "length", unsupported: `the unit ${unit}` };
    throw invalid();
  }
  if (token.type === "function") {
    if (token.name === "calc") return { ...calc(token.args, context), calc: true };
    if (MATH_FUNCTIONS.has(token.name)) {
      return { type: "unknown", unsupported: `the math function ${token.name}()` };
    }
  }
  throw invalid();
}

// Evaluates the arguments of calc(): sums and products, parenthesized
// groups as nested calc().
function calc(args, context) {
  const tokens = args;
  let at = 0;
  const skip = () => {
    while (at < tokens.length && tokens[at].type === "space") at++;
  };
  const unsupported = (...values) => values.find((value) => value.unsupported)?.unsupported;
  const factor = () => {
    skip();
    const token = tokens[at++];
    if (!token) throw invalid();
    if (token.type === "ident") {
      const constants = { pi: Math.PI, e: Math.E, infinity: Infinity, "-infinity": -Infinity, nan: NaN };
      if (token.value in constants) return { type: "number", value: constants[token.value] };
      throw invalid();
    }
    return numeric(token, context);
  };
  const product = () => {
    let left = factor();
    for (;;) {
      const before = at;
      skip();
      const token = tokens[at];
      if (!token || token.type !== "delim" || (token.value !== "*" && token.value !== "/")) {
        at = before;
        return left;
      }
      at++;
      const right = factor();
      const reason = unsupported(left, right);
      if (token.value === "*") {
        if (left.type !== "number" && right.type !== "number") throw invalid();
        const type = left.type === "number" ? right.type : left.type;
        left = { type, value: left.value * right.value, unsupported: reason };
      } else {
        if (right.type !== "number") throw invalid();
        left = { type: left.type, value: left.value / right.value, unsupported: reason };
      }
    }
  };
  const sum = () => {
    let left = product();
    for (;;) {
      const before = at;
      const spaced = at < tokens.length && tokens[at].type === "space";
      skip();
      const token = tokens[at];
      if (!token) return left;
      if (token.type !== "delim" || (token.value !== "+" && token.value !== "-")) {
        at = before;
        return left;
      }
      // + and - need white space on both sides.
      if (!spaced || tokens[at + 1]?.type !== "space") throw invalid();
      at++;
      const right = product();
      if (left.type !== right.type && left.type !== "unknown" && right.type !== "unknown") throw invalid();
      left = {
        type: left.type === "unknown" ? right.type : left.type,
        value: token.value === "+" ? left.value + right.value : left.value - right.value,
        unsupported: unsupported(left, right),
      };
    }
  };
  const result = sum();
  skip();
  if (at !== tokens.length) throw invalid();
  return result;
}

// ------------------------------------------------------------ parsing

function requireSupported(value) {
  if (value.unsupported) throw new UnsupportedFilter(value.unsupported);
  return value;
}

// One numeric argument of `allowed` types, or null for no argument.
function singleArgument(args) {
  const list = trimmed(args);
  if (list.length > 1) throw invalid();
  return list[0] ?? null;
}

function lengthOf(token, context, nonNegative) {
  const value = numeric(token, context);
  if (value.type === "unknown") return value;
  if (value.type === "number" && value.zero && !value.calc) return { type: "length", value: 0 };
  if (value.type !== "length") throw invalid();
  if (nonNegative && !value.calc && value.value < 0) throw invalid();
  // calc() clamps a value outside the range.
  if (nonNegative && value.calc && value.value < 0) return { ...value, value: 0 };
  return value;
}

function parseFunction(token, context) {
  const name = token.name;
  if (name === "drop-shadow") return parseDropShadow(token.args, context);
  const argument = singleArgument(token.args);
  if (name === "blur") {
    if (argument === null) return { name, deviation: 0 };
    const length = requireSupported(lengthOf(argument, context, true));
    return { name, deviation: length.value };
  }
  if (name === "hue-rotate") {
    if (argument === null) return { name, amount: 0 };
    const value = requireSupported(numeric(argument, context));
    if (value.type === "number" && value.zero && !value.calc) return { name, amount: 0 };
    if (value.type !== "angle" && value.type !== "unknown") throw invalid();
    return { name, amount: value.value };
  }
  if (argument === null) return { name, amount: 1 };
  const value = numeric(argument, context);
  if (value.type !== "number" && value.type !== "percentage" && value.type !== "unknown") throw invalid();
  requireSupported(value);
  if (!value.calc && value.value < 0) throw invalid();
  let amount = value.type === "percentage" ? value.value / 100 : value.value;
  if (value.calc && amount < 0) amount = 0;
  if (CLAMPED_FUNCTIONS.has(name)) amount = Math.min(amount, 1);
  return { name, amount };
}

// drop-shadow( <color>? <length>{2} <length [0,∞]>? <color>? ), one color.
function parseDropShadow(args, context) {
  const list = trimmed(args);
  let at = 0;
  let color = null;
  const isLength = (token) => {
    if (!token) return false;
    if (token.type === "dimension") return !(token.unit in ANGLES);
    if (token.type === "number") return token.value === 0;
    return token.type === "function" && (token.name === "calc" || MATH_FUNCTIONS.has(token.name));
  };
  if (list.length === 0) throw invalid();
  if (!isLength(list[0])) {
    color = list[at++];
  }
  const lengths = [];
  while (lengths.length < 3 && isLength(list[at])) {
    lengths.push(requireSupported(lengthOf(list[at++], context, lengths.length === 2)));
  }
  if (lengths.length < 2) throw invalid();
  if (at < list.length) {
    if (color !== null) throw invalid();
    color = list[at++];
  }
  if (at !== list.length) throw invalid();
  let resolved = { r: 0, g: 0, b: 0, a: 1 };
  // A drop shadow whose color is currentcolor (also by default, or inside
  // color-mix()) taints the canvas when it draws (FEDropShadow), measured.
  let currentColor = color === null;
  if (color !== null) {
    const parsed = context.parseColor(color.text);
    if (parsed === null) throw invalid();
    currentColor = /currentcolor/i.test(color.text);
    // currentcolor resolves to black (FilterEffectBuilder's current color).
    if (parsed !== "currentColor") resolved = parsed;
  }
  return {
    name: "drop-shadow",
    offsetX: lengths[0].value,
    offsetY: lengths[1].value,
    deviation: lengths[2]?.value ?? 0,
    color: resolved,
    currentColor,
  };
}

// Parses a filter value. Returns the list of functions ([] for none), or
// null for an invalid value. Throws UnsupportedFilter for a value that
// Sandom cannot draw. context: { fontSize, rootFontSize(), parseColor(text) }.
export function parseCanvasFilter(text, context) {
  let tokens;
  try {
    tokens = trimmed(tokenize(text));
    if (tokens.length === 0) return null;
    if (tokens.length === 1 && tokens[0].type === "ident") {
      return tokens[0].value === "none" ? [] : null;
    }
    const functions = [];
    for (const token of tokens) {
      if (token.type === "url") throw new UnsupportedFilter("an SVG filter reference");
      if (token.type !== "function" || !FILTER_FUNCTIONS.has(token.name)) return null;
      functions.push(parseFunction(token, context));
    }
    return functions;
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

// ---------------------------------------------------------- resolution

function clampToFloat(value) {
  return f32(Math.min(Math.max(value, -3.4028234663852886e38), 3.4028234663852886e38));
}

// Blink's ClampToU8: the value clamped to [0, 255], truncated.
function toByte(value) {
  return Math.trunc(Math.min(Math.max(value, 0), 255));
}

function identityTable() {
  return Array.from({ length: 256 }, (_, index) => index);
}

// FEComponentTransfer's table function.
function tableFunction(values) {
  const n = values.length;
  return Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    const k = Math.trunc(c * (n - 1));
    const v1 = values[k];
    const v2 = values[Math.min(k + 1, n - 1)];
    return toByte(255 * (v1 + (c * (n - 1) - k) * (v2 - v1)));
  });
}

// FEComponentTransfer's linear function, in single precision.
function linearFunction(slope, intercept) {
  return Array.from({ length: 256 }, (_, i) => toByte(f32(f32(slope * i) + f32(255 * intercept))));
}

// FilterEffectBuilder's grayscale and sepia matrices: double, then float.
function amountMatrix(amount, rows) {
  const o = Math.min(Math.max(1 - amount, 0), 1);
  return rows.map(([base, scale]) => clampToFloat(base + scale * o));
}

function grayscaleMatrix(amount) {
  return amountMatrix(amount, [
    [0.2126, 0.7874], [0.7152, -0.7152], [0.0722, -0.0722],
    [0.2126, -0.2126], [0.7152, 0.2848], [0.0722, -0.0722],
    [0.2126, -0.2126], [0.7152, -0.7152], [0.0722, 0.9278],
  ]);
}

function sepiaMatrix(amount) {
  return amountMatrix(amount, [
    [0.393, 0.607], [0.769, -0.769], [0.189, -0.189],
    [0.349, -0.349], [0.686, 0.314], [0.168, -0.168],
    [0.272, -0.272], [0.534, -0.534], [0.131, 0.869],
  ]);
}

// FEColorMatrix's saturate matrix, in single precision.
function saturateMatrix(amount) {
  const s = clampToFloat(amount);
  const entry = (base, scale) => f32(f32(base) + f32(f32(scale) * s));
  return [
    entry(0.213, 0.787), entry(0.715, -0.715), entry(0.072, -0.072),
    entry(0.213, -0.213), entry(0.715, 0.285), entry(0.072, -0.072),
    entry(0.213, -0.213), entry(0.715, -0.715), entry(0.072, 0.928),
  ];
}

// FEColorMatrix's hue rotation matrix, in single precision.
function hueRotateMatrix(degrees) {
  const radians = f32(clampToFloat(degrees) * f32(f32(Math.PI) / 180));
  const cos = f32(Math.cos(radians));
  const sin = f32(Math.sin(radians));
  const entry = (base, cosScale, sinScale) => f32(f32(f32(base) + f32(cos * f32(cosScale))) + f32(sin * f32(sinScale)));
  return [
    entry(0.213, 0.787, -0.213), entry(0.715, -0.715, -0.715), entry(0.072, -0.072, 0.928),
    entry(0.213, -0.213, 0.143), entry(0.715, 0.285, 0.140), entry(0.072, -0.072, -0.283),
    entry(0.213, -0.213, -0.787), entry(0.715, -0.715, 0.715), entry(0.072, 0.928, 0.072),
  ];
}

// One filter step of a parsed function.
function filterStep(fn) {
  switch (fn.name) {
    case "grayscale":
      return { kind: FILTER_MATRIX, matrix: grayscaleMatrix(fn.amount) };
    case "sepia":
      return { kind: FILTER_MATRIX, matrix: sepiaMatrix(fn.amount) };
    case "saturate":
      return { kind: FILTER_MATRIX, matrix: saturateMatrix(fn.amount) };
    case "hue-rotate":
      return { kind: FILTER_MATRIX, matrix: hueRotateMatrix(fn.amount) };
    case "invert": {
      const table = tableFunction([clampToFloat(fn.amount), clampToFloat(1 - fn.amount)]);
      return { kind: FILTER_TABLE, tables: [table, table, table, identityTable()] };
    }
    case "opacity": {
      const identity = identityTable();
      return { kind: FILTER_TABLE, tables: [identity, identity, identity, tableFunction([0, clampToFloat(fn.amount)])] };
    }
    case "brightness": {
      const table = linearFunction(clampToFloat(fn.amount), 0);
      return { kind: FILTER_TABLE, tables: [table, table, table, identityTable()] };
    }
    case "contrast": {
      const slope = clampToFloat(fn.amount);
      const table = linearFunction(slope, f32(-0.5 * slope + 0.5));
      return { kind: FILTER_TABLE, tables: [table, table, table, identityTable()] };
    }
    case "blur": {
      const deviation = f32(fn.deviation);
      return { kind: FILTER_BLUR, deviationX: deviation, deviationY: deviation };
    }
    case "drop-shadow":
      return {
        kind: FILTER_DROP_SHADOW,
        offsetX: f32(fn.offsetX),
        offsetY: f32(fn.offsetY),
        deviation: f32(fn.deviation),
        color: fn.color,
      };
  }
  throw new Error(`Canvas 2D filter: unknown function ${fn.name}`);
}

// Whether a step is a color step (Skia composes runs of them into one
// color filter).
function isColorStep(step) {
  return step?.kind === FILTER_MATRIX || step?.kind === FILTER_TABLE;
}

// The filter block of a filter (vec4 units, f32):
//   vec4 the run head (below) of the color steps at the end, with the
//        number of blur and drop-shadow steps in z: (count, offset, K, 0)
//   K vec4: for each blur or drop-shadow step, in order, the run head of
//        the color steps before it
//   each step: vec4 (kind, p1, p2, p3), then its data:
//     matrix   p1: 1 when the product accumulates green first; 3 vec4: the
//              columns for red, green and blue (w 0)
//     table    p1: the texel coordinate's offset 0.5/256; 1 vec4: its
//              scale 255/256 for each channel; then 256 vec4: entry i of
//              the red, green, blue and alpha tables, each byte / 255 in
//              single precision
//     blur     p1, p2: the standard deviations
//     drop-shadow, drop-shadow only  p1, p2: the offset; p3: the standard
//              deviation; 1 vec4: the color (r, g, b encoded sRGB 0..1,
//              alpha), not premultiplied
// A run head is (the number of color steps in the run, the vec4 of its
// first step from the head, 0, 0); its w is 0, which the shader uses as a
// zero it cannot know. The rasterizer applies each run before a blur or
// drop shadow in a pass over the layer, as Skia resolves a color filter
// before it blurs, and the run at the end as the layer is composited.
// Offsets, deviations and lengths are device pixels: Chrome filters the
// layer in device space.
export function filterWords(steps) {
  const spatial = steps.filter((step) => !isColorStep(step)).length;
  const vec4s = [];
  const offsets = [];
  steps.forEach((step, index) => {
    offsets.push(1 + spatial + vec4s.length);
    if (step.kind === FILTER_MATRIX) {
      // Chrome's compiled shader accumulates a matrix product red first
      // when the matrix is alone in its run of color steps or comes first
      // before a table, green first otherwise (measured on 65,536 colors
      // through seven compositions).
      const greenFirst = isColorStep(steps[index - 1]) || steps[index + 1]?.kind === FILTER_MATRIX ? 1 : 0;
      const m = step.matrix;
      vec4s.push([FILTER_MATRIX, greenFirst, 0, 0], [m[0], m[3], m[6], 0], [m[1], m[4], m[7], 0], [m[2], m[5], m[8], 0]);
    } else if (step.kind === FILTER_TABLE) {
      vec4s.push([FILTER_TABLE, 0.5 / 256, 0, 0], [255 / 256, 255 / 256, 255 / 256, 255 / 256]);
      const [r, g, b, a] = step.tables;
      for (let i = 0; i < 256; i++) vec4s.push([r[i] / 255, g[i] / 255, b[i] / 255, a[i] / 255]);
    } else if (step.kind === FILTER_BLUR) {
      vec4s.push([FILTER_BLUR, step.deviationX, step.deviationY, 0]);
    } else {
      const { r, g, b, a } = step.color;
      const kind = step.kind === FILTER_DROP_SHADOW_ONLY ? FILTER_DROP_SHADOW_ONLY : FILTER_DROP_SHADOW;
      vec4s.push([kind, step.offsetX, step.offsetY, step.deviation], [r, g, b, a]);
    }
  });
  // The run of color steps that ends before step `end`, as a head at vec4
  // `at` of the block.
  const runHead = (end, at) => {
    let start = end;
    while (start > 0 && isColorStep(steps[start - 1])) start--;
    return [end - start, end > start ? offsets[start] - at : 0, 0, 0];
  };
  const words = new Float32Array(4 * (1 + spatial + vec4s.length));
  words.set([...runHead(steps.length, 0).slice(0, 2), spatial, 0]);
  let head = 1;
  steps.forEach((step, index) => {
    if (isColorStep(step)) return;
    words.set(runHead(index, head), head * 4);
    head++;
  });
  vec4s.forEach((vec4, index) => words.set(vec4, 4 * (1 + spatial + index)));
  return words;
}

function stepLength(kind) {
  if (kind === FILTER_MATRIX) return 4;
  if (kind === FILTER_TABLE) return 258;
  if (kind === FILTER_BLUR) return 1;
  return 2;
}

// The blur and drop-shadow steps of the filter block at vec4 `block` of
// `paints` (a Float32Array of vec4s), in order: { kind, offsetX, offsetY,
// deviationX, deviationY, color (r, g, b, a not premultiplied), head (the
// vec4 of the run head of the color steps before it) }, and the vec4 of
// the trailing run head (the block itself).
export function filterChain(paints, block) {
  const at = (index) => paints.subarray((block + index) * 4, (block + index) * 4 + 4);
  const spatialCount = at(0)[2];
  let colorSteps = at(0)[0];
  for (let i = 1; i <= spatialCount; i++) colorSteps += at(i)[0];
  const steps = [];
  let index = 1 + spatialCount;
  for (let n = 0; n < spatialCount + colorSteps; n++) {
    const [kind, p1, p2, p3] = at(index);
    if (kind === FILTER_BLUR) {
      steps.push({ kind, deviationX: p1, deviationY: p2, head: block + 1 + steps.length });
    } else if (kind === FILTER_DROP_SHADOW || kind === FILTER_DROP_SHADOW_ONLY) {
      steps.push({
        kind,
        offsetX: p1,
        offsetY: p2,
        deviationX: p3,
        deviationY: p3,
        color: Array.from(at(index + 1)),
        colorAt: block + index + 1,
        head: block + 1 + steps.length,
      });
    }
    index += stepLength(kind);
  }
  return { steps, trailingHead: block };
}

// A resolved filter: the text the getter returns, the steps and the filter
// block's words.
export function resolveCanvasFilter(text, functions) {
  const steps = functions.map(filterStep);
  return Object.freeze({
    text,
    steps,
    words: filterWords(steps),
    // A drop shadow of currentcolor taints the canvas when it draws.
    taints: functions.some((fn) => fn.currentColor === true),
  });
}
