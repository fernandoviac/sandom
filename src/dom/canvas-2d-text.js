// Canvas 2D text (plans/dom/PLAN-canvas-2d.md, slice 5;
// docs/specifications/canvas-2d.md, "Text").
//
// The text attributes, the font, measureText() and the glyph runs of
// fillText() and strokeText(). The context's text state lives in
// src/wasm/canvas-2d-text.watpart; this module parses the authored values
// as Chrome parses them and shapes text through the renderer engine.
//
// Shaping is Sandom's one text path. A detached element of the canvas's
// document carries the canvas font as its inline style, and the renderer
// engine lays it out alone (shapeStandaloneTextSync, src/scene-renderer.js):
// the document's fonts and @font-face rules, the font stack and fallback
// faces, bidi levels, OpenType features, kerning and letter-spacing are
// those of CSS text. From the shaped glyphs this module computes what
// Chrome's canvas computes from its own: Blink's PlainTextNode splits the
// text into bidi runs and words and shapes each word alone, ShapeResult
// sums 16.16 fixed-point advances, TextMetrics sums the words in single
// precision and unites glyph bounds. Those rules are ported here, so the
// values a script reads equal Chrome's for the same glyph advances.
import { serializeToScene } from "./serialize.js";
import { glyphOutlinesSync, shapeStandaloneTextSync } from "../scene-renderer.js";

const f32 = Math.fround;
const FIXED = 65536;
const TEXT_METRICS_CONSTRUCTION = Symbol("TextMetrics construction");

// ------------------------------------------------------------- numbers

// WTF::String::Number(float): six significant digits, trailing zeros
// removed unless the exponent form is used ("1.00000e-7"), no "+" in an
// exponent.
export function formatCanvasNumber(value) {
  const number = f32(value);
  if (Number.isInteger(number) && Math.abs(number) < 1e6) return String(number === 0 ? 0 : number);
  const text = number.toPrecision(6);
  if (text.includes("e")) return text.replace("e+", "e");
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

// ------------------------------------------------------------ tokenizer
//
// The CSS Syntax tokens a font shorthand and a spacing value use.

const isDigit = (code) => code >= 48 && code <= 57;
const isNameStart = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 0x80;
const isName = (code) => isNameStart(code) || isDigit(code) || code === 45;
const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

function validEscape(text, index) {
  return text.charCodeAt(index) === 92 && index + 1 < text.length && text.charCodeAt(index + 1) !== 10;
}

function startsIdentifier(text, index) {
  const code = text.charCodeAt(index);
  if (code === 45) {
    const next = text.charCodeAt(index + 1);
    return isNameStart(next) || next === 45 || validEscape(text, index + 1);
  }
  return isNameStart(code) || validEscape(text, index);
}

function startsNumber(text, index) {
  let code = text.charCodeAt(index);
  if (code === 43 || code === 45) code = text.charCodeAt(++index);
  if (isDigit(code)) return true;
  return code === 46 && isDigit(text.charCodeAt(index + 1));
}

function consumeEscape(text, state) {
  state.index++;
  let code = text.codePointAt(state.index);
  if (code === undefined) return "\uFFFD";
  if (/[0-9a-fA-F]/.test(text[state.index])) {
    let hex = "";
    while (hex.length < 6 && /[0-9a-fA-F]/.test(text[state.index] ?? "")) hex += text[state.index++];
    if (isSpace(text.charCodeAt(state.index))) state.index++;
    code = parseInt(hex, 16);
    return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? "\uFFFD" : String.fromCodePoint(code);
  }
  state.index += code > 0xFFFF ? 2 : 1;
  return String.fromCodePoint(code);
}

function consumeName(text, state) {
  let name = "";
  for (;;) {
    const code = text.charCodeAt(state.index);
    if (state.index < text.length && isName(code)) {
      name += text[state.index++];
    } else if (validEscape(text, state.index)) {
      name += consumeEscape(text, state);
    } else {
      return name;
    }
  }
}

function tokenize(text) {
  const tokens = [];
  const state = { index: 0 };
  while (state.index < text.length) {
    const start = state.index;
    const code = text.charCodeAt(state.index);
    if (isSpace(code)) {
      while (state.index < text.length && isSpace(text.charCodeAt(state.index))) state.index++;
      tokens.push({ type: "space" });
    } else if (code === 34 || code === 39) {
      state.index++;
      let value = "";
      for (;;) {
        if (state.index >= text.length) break;
        const next = text.charCodeAt(state.index);
        if (next === code) {
          state.index++;
          break;
        }
        if (next === 10) return null;
        if (next === 92) {
          if (state.index + 1 >= text.length) {
            state.index++;
          } else if (text.charCodeAt(state.index + 1) === 10) {
            state.index += 2;
          } else {
            value += consumeEscape(text, state);
          }
          continue;
        }
        value += text[state.index++];
      }
      tokens.push({ type: "string", value });
    } else if (startsNumber(text, state.index)) {
      const match = /^[+-]?(\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(state.index));
      state.index += match[0].length;
      const value = Number(match[0]);
      if (text.charCodeAt(state.index) === 37) {
        state.index++;
        tokens.push({ type: "percentage", value });
      } else if (startsIdentifier(text, state.index)) {
        tokens.push({ type: "dimension", value, unit: consumeName(text, state).toLowerCase() });
      } else {
        tokens.push({ type: "number", value, integer: !/[.eE]/.test(match[0]) });
      }
    } else if (startsIdentifier(text, state.index)) {
      const name = consumeName(text, state);
      if (text.charCodeAt(state.index) === 40) {
        state.index++;
        tokens.push({ type: "function", name: name.toLowerCase() });
      } else {
        tokens.push({ type: "ident", value: name });
      }
    } else {
      state.index++;
      tokens.push({ type: "delim", value: text[start] });
    }
  }
  return tokens;
}

// --------------------------------------------------------------- lengths

const ABSOLUTE_UNITS = Object.freeze({
  px: 1,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  in: 96,
  pt: 96 / 72,
  pc: 16,
});
const FONT_RELATIVE_UNITS = new Set(["em", "rem", "ex", "rex", "ch", "rch", "cap", "rcap", "ic", "ric", "lh", "rlh"]);
const VIEWPORT_UNITS = new Set([
  "vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin", "svmax", "lvw", "lvh", "lvi", "lvb",
  "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax",
]);

function isLengthUnit(unit) {
  return Object.hasOwn(ABSOLUTE_UNITS, unit) || FONT_RELATIVE_UNITS.has(unit) || VIEWPORT_UNITS.has(unit);
}

// The px of `value` `unit` for a font size: `context` holds the parent font
// size (em, ex, ch, cap, ic, lh), the root font size (rem and the other r
// units) and the viewport. Units of the parent font's metrics take the
// ratios of a font without metrics: ex and cap 0.5em, ch 0.5em, ic 1em,
// lh 1.2em (docs/specifications/canvas-2d.md, "Text").
function fontSizeUnitPx(value, unit, context) {
  if (Object.hasOwn(ABSOLUTE_UNITS, unit)) return value * ABSOLUTE_UNITS[unit];
  const parent = context.parentSize;
  const root = context.rootSize;
  switch (unit) {
    case "em": return value * parent;
    case "rem": return value * root;
    case "ex": case "cap": case "ch": return value * parent * 0.5;
    case "rex": case "rcap": case "rch": return value * root * 0.5;
    case "ic": return value * parent;
    case "ric": return value * root;
    case "lh": return value * parent * 1.2;
    case "rlh": return value * root * 1.2;
  }
  const { width, height } = context.viewport;
  const axis = unit.replace(/^(?:s|l|d|cq)?v?/, "");
  if (unit.startsWith("cq")) {
    const small = { w: width, h: height, i: width, b: height, min: Math.min(width, height), max: Math.max(width, height) };
    return value * small[axis] / 100;
  }
  const sizes = { w: width, h: height, i: width, b: height, min: Math.min(width, height), max: Math.max(width, height) };
  return value * sizes[axis] / 100;
}

// A calc() sum of lengths, percentages and numbers. Returns { px, number }
// with one of them null, or null for an invalid expression.
function parseCalc(tokens, start, context) {
  let index = start;
  const skip = () => {
    while (tokens[index]?.type === "space") index++;
  };
  const value = () => {
    skip();
    const token = tokens[index];
    if (token === undefined) return null;
    if (token.type === "number") {
      index++;
      return { px: null, number: token.value };
    }
    if (token.type === "percentage") {
      index++;
      return { px: token.value / 100 * context.percentBasis, number: null };
    }
    if (token.type === "dimension") {
      if (!isLengthUnit(token.unit)) return null;
      index++;
      return { px: fontSizeUnitPx(token.value, token.unit, context), number: null };
    }
    if ((token.type === "function" && token.name === "calc") || (token.type === "delim" && token.value === "(")) {
      index++;
      const inner = sum();
      skip();
      if (inner === null || tokens[index]?.type !== "delim" || tokens[index].value !== ")") return null;
      index++;
      return inner;
    }
    return null;
  };
  const product = () => {
    let left = value();
    for (;;) {
      if (left === null) return null;
      const before = index;
      skip();
      const operator = tokens[index];
      if (operator?.type !== "delim" || (operator.value !== "*" && operator.value !== "/")) {
        index = before;
        return left;
      }
      index++;
      const right = value();
      if (right === null) return null;
      if (operator.value === "*") {
        if (left.number !== null) left = right.number !== null
          ? { px: null, number: left.number * right.number }
          : { px: right.px * left.number, number: null };
        else if (right.number !== null) left = { px: left.px * right.number, number: null };
        else return null;
      } else {
        if (right.number === null || right.number === 0) return null;
        left = left.number !== null ? { px: null, number: left.number / right.number } : { px: left.px / right.number, number: null };
      }
    }
  };
  const sum = () => {
    let left = product();
    for (;;) {
      if (left === null) return null;
      const before = index;
      // + and - need white space on both sides.
      if (tokens[index]?.type !== "space") return left;
      skip();
      const operator = tokens[index];
      if (operator?.type !== "delim" || (operator.value !== "+" && operator.value !== "-")) {
        index = before;
        return left;
      }
      index++;
      if (tokens[index]?.type !== "space") return null;
      const right = product();
      if (right === null || (left.number === null) !== (right.number === null)) return null;
      const sign = operator.value === "+" ? 1 : -1;
      left = left.number !== null
        ? { px: null, number: left.number + sign * right.number }
        : { px: left.px + sign * right.px, number: null };
    }
  };
  const result = sum();
  skip();
  if (result === null || tokens[index]?.type !== "delim" || tokens[index].value !== ")") return null;
  return { result, next: index + 1 };
}

// --------------------------------------------------------------- the font

const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "cursive", "fantasy", "monospace", "system-ui", "math", "emoji", "fangsong", "ui-serif",
  "ui-sans-serif", "ui-monospace", "ui-rounded", "-webkit-body", "-webkit-pictograph", "-webkit-standard",
]);
export const FONT_STRETCHES = Object.freeze([
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded",
  "extra-expanded", "ultra-expanded",
]);
const STRETCH_PERCENTAGES = Object.freeze([50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200]);
const ABSOLUTE_SIZES = Object.freeze({
  "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48,
});
// Chrome 151 on macOS resolves every system font keyword to 16px Arial,
// and -webkit-small-control to 13.3333px Arial (measured 2026-10-12).
const SYSTEM_FONTS = Object.freeze({
  caption: 16, icon: 16, menu: 16, "message-box": 16, "small-caption": 16, "status-bar": 16,
  "-webkit-small-control": 13 + 1 / 3,
});
const ITALIC_SLOPE = 14;

function lower(token) {
  return token?.type === "ident" ? token.value.toLowerCase() : null;
}

function isIdentifier(name) {
  let index = 0;
  if (name.charCodeAt(0) === 45) index++;
  if (index >= name.length) return false;
  const first = name.codePointAt(index);
  if (!isNameStart(first) && !(first === 45 && index === 1)) return false;
  for (index++; index < name.length; index++) {
    if (!isName(name.charCodeAt(index))) return false;
  }
  return true;
}

function serializeString(name) {
  let text = "\"";
  for (const character of name) {
    const code = character.codePointAt(0);
    if (character === "\"" || character === "\\") text += `\\${character}`;
    else if (code < 0x20 || code === 0x7F) text += `\\${code.toString(16)} `;
    else text += character;
  }
  return `${text}"`;
}

// Blink's SerializeFontFamily: a name that is one CSS identifier, and not
// a keyword, stays unquoted; a generic family is its keyword.
function serializeFamily(family) {
  if (family.generic) return family.name;
  const name = family.name;
  const lowered = name.toLowerCase();
  if (isIdentifier(name) && !CSS_WIDE_KEYWORDS.has(lowered) && !GENERIC_FAMILIES.has(lowered)) return name;
  return serializeString(name);
}

function bolder(weight) {
  if (weight < 350) return 400;
  if (weight < 550) return 700;
  if (weight < 900) return 900;
  return weight;
}

function lighter(weight) {
  if (weight < 100) return weight;
  if (weight < 550) return 100;
  if (weight < 750) return 400;
  return 700;
}

// Parses a CSS font shorthand as Chrome's canvas font setter does.
// `context`: { parentSize, parentWeight, rootSize, viewport }. Returns null
// for a value Chrome ignores, else { size, weight, slope, style, caps,
// stretch, families, serialization, familyOffset }.
export function parseCanvasFont(text, context) {
  const tokens = tokenize(String(text));
  if (tokens === null) return null;
  while (tokens[0]?.type === "space") tokens.shift();
  while (tokens.at(-1)?.type === "space") tokens.pop();
  if (tokens.some((token) => token.type === "function" && token.name !== "calc")) return null;
  if (tokens.length === 1 && Object.hasOwn(SYSTEM_FONTS, lower(tokens[0]))) {
    return fontResult({
      size: SYSTEM_FONTS[lower(tokens[0])], weight: 400, slope: 0, style: 0, caps: 0, stretch: 4,
      families: [{ name: "Arial", generic: false }],
    });
  }
  let index = 0;
  const skip = () => {
    while (tokens[index]?.type === "space") index++;
  };
  let style = null, slope = 0, weight = null, caps = null, stretch = null, normals = 0;
  for (let count = 0; count < 4; count++) {
    skip();
    const token = tokens[index];
    const keyword = lower(token);
    if (keyword === "normal") {
      normals++;
    } else if (keyword === "italic" && style === null) {
      style = 1;
      slope = ITALIC_SLOPE;
    } else if (keyword === "oblique" && style === null) {
      style = 2;
      slope = ITALIC_SLOPE;
      let next = index + 1;
      while (tokens[next]?.type === "space") next++;
      const angle = tokens[next];
      if (angle?.type === "dimension" && ["deg", "grad", "rad", "turn"].includes(angle.unit)) {
        const degrees = angle.unit === "deg" ? angle.value
          : angle.unit === "grad" ? angle.value * 0.9
          : angle.unit === "rad" ? angle.value * 180 / Math.PI
          : angle.value * 360;
        if (degrees < -90 || degrees > 90) return null;
        slope = degrees;
        index = next;
      }
    } else if (keyword === "small-caps" && caps === null) {
      caps = 1;
    } else if (FONT_STRETCHES.includes(keyword) && stretch === null) {
      stretch = FONT_STRETCHES.indexOf(keyword);
    } else if ((keyword === "bold" || keyword === "bolder" || keyword === "lighter") && weight === null) {
      weight = keyword === "bold" ? 700 : keyword === "bolder" ? bolder(context.parentWeight) : lighter(context.parentWeight);
    } else if (token?.type === "number" && weight === null && token.value >= 1 && token.value <= 1000) {
      weight = token.value;
    } else {
      break;
    }
    index++;
  }
  if (normals + (style !== null) + (weight !== null) + (caps !== null) + (stretch !== null) > 4) return null;
  skip();
  // font-size
  const sizeToken = tokens[index];
  const sizeContext = { ...context, percentBasis: context.parentSize };
  let size;
  const sizeKeyword = lower(sizeToken);
  if (sizeKeyword !== null && Object.hasOwn(ABSOLUTE_SIZES, sizeKeyword)) {
    size = ABSOLUTE_SIZES[sizeKeyword];
    index++;
  } else if (sizeKeyword === "larger" || sizeKeyword === "smaller") {
    size = sizeKeyword === "larger" ? context.parentSize * 1.2 : context.parentSize / 1.2;
    index++;
  } else if (sizeToken?.type === "dimension" && isLengthUnit(sizeToken.unit)) {
    if (sizeToken.value < 0) return null;
    size = fontSizeUnitPx(sizeToken.value, sizeToken.unit, sizeContext);
    index++;
  } else if (sizeToken?.type === "percentage") {
    if (sizeToken.value < 0) return null;
    size = sizeToken.value / 100 * context.parentSize;
    index++;
  } else if (sizeToken?.type === "number" && sizeToken.value === 0) {
    size = 0;
    index++;
  } else if (sizeToken?.type === "function" && sizeToken.name === "calc") {
    const calc = parseCalc(tokens, index + 1, sizeContext);
    if (calc === null || calc.result.px === null) return null;
    size = Math.max(0, calc.result.px);
    index = calc.next;
  } else {
    return null;
  }
  skip();
  // / line-height
  if (tokens[index]?.type === "delim" && tokens[index].value === "/") {
    index++;
    skip();
    const lineHeight = tokens[index];
    if (lower(lineHeight) === "normal" || lineHeight?.type === "number" || lineHeight?.type === "percentage" ||
      (lineHeight?.type === "dimension" && isLengthUnit(lineHeight.unit))) {
      if (lineHeight.type !== "ident" && lineHeight.value < 0) return null;
      index++;
    } else if (lineHeight?.type === "function" && lineHeight.name === "calc") {
      const calc = parseCalc(tokens, index + 1, { ...sizeContext, percentBasis: size });
      if (calc === null) return null;
      index = calc.next;
    } else {
      return null;
    }
  }
  // font-family
  const families = [];
  for (;;) {
    skip();
    const token = tokens[index];
    if (token?.type === "string") {
      families.push({ name: token.value, generic: false });
      index++;
    } else if (token?.type === "ident") {
      const words = [];
      while (tokens[index]?.type === "ident") {
        words.push(tokens[index].value);
        index++;
        if (tokens[index]?.type === "space" && tokens[index + 1]?.type === "ident") index++;
      }
      const loweredWords = words.map((word) => word.toLowerCase());
      if (loweredWords.some((word) => CSS_WIDE_KEYWORDS.has(word))) return null;
      if (words.length === 1 && GENERIC_FAMILIES.has(loweredWords[0])) {
        families.push({ name: loweredWords[0], generic: true });
      } else {
        families.push({ name: words.join(" "), generic: false });
      }
    } else {
      return null;
    }
    skip();
    if (index >= tokens.length) break;
    if (tokens[index].type !== "delim" || tokens[index].value !== ",") return null;
    index++;
  }
  return fontResult({
    size: Math.min(size, 10000), weight: weight ?? 400, slope, style: style ?? 0, caps: caps ?? 0, stretch: stretch ?? 4,
    families,
  });
}

// The serialization without "small-caps": the font getter inserts it for
// the current fontVariantCaps (canvasFontText).
function fontResult(font) {
  const size = f32(font.size);
  let prefix = "";
  if (font.slope === ITALIC_SLOPE) prefix += "italic ";
  if (font.weight === 700) prefix += "bold ";
  else if (font.weight !== 400) prefix += `${Math.trunc(f32(font.weight))} `;
  prefix += `${formatCanvasNumber(size)}px `;
  const family = font.families.map(serializeFamily).join(", ");
  return { ...font, size, serialization: prefix + family, familyOffset: new TextEncoder().encode(prefix).length };
}

// Blink's font getter: the stored serialization with "small-caps" before
// the size when fontVariantCaps is small-caps.
export function canvasFontText(state) {
  if (state.fontVariantCaps !== 1) return state.font;
  const familyStart = state.font.length - state.family.length;
  const sizeStart = familyStart - `${formatCanvasNumber(state.size)}px `.length;
  return `${state.font.slice(0, sizeStart)}small-caps ${state.font.slice(sizeStart)}`;
}

// ------------------------------------------------------------- spacings

// CSSPrimitiveValue::UnitTypeToString for the length units.
const UNIT_NAMES = Object.freeze([
  "px", "cm", "mm", "q", "in", "pt", "pc", "em", "rem", "ex", "rex", "ch", "rch", "cap", "rcap", "ic", "ric", "lh",
  "rlh", ...VIEWPORT_UNITS,
]);

// letterSpacing and wordSpacing: one dimension token with a length unit,
// as Blink's StringToNumWithUnit reads it. Returns { number, unit,
// serialization } or null.
export function parseCanvasSpacing(text) {
  const tokens = tokenize(String(text));
  if (tokens === null || tokens.length !== 1) return null;
  const [token] = tokens;
  if (token.type !== "dimension" || !isLengthUnit(token.unit)) return null;
  const number = f32(token.value);
  const unit = UNIT_NAMES.indexOf(token.unit);
  return { number, unit, serialization: `${formatCanvasNumber(number)}${token.unit}` };
}

// The px of a spacing for the font size `size`, as Blink converts it
// without an element: em and rem are the font size; viewport and line
// height units are 0. `atFontChange`: the font setter converts with a
// font without metrics, which makes ch 0 (measured on Chrome 151).
export function canvasSpacingPx(number, unit, size, atFontChange) {
  const name = UNIT_NAMES[unit];
  if (Object.hasOwn(ABSOLUTE_UNITS, name)) return f32(number * ABSOLUTE_UNITS[name]);
  switch (name) {
    case "em": case "rem": case "ic": case "ric": return f32(number * size);
    case "ex": case "rex": case "cap": case "rcap": return f32(number * size * 0.5);
    case "ch": case "rch": return atFontChange ? 0 : f32(number * size * 0.5);
  }
  return 0;
}

// ------------------------------------------------------------ text style

export const TEXT_ALIGNS = Object.freeze(["start", "end", "left", "right", "center"]);
export const TEXT_BASELINES = Object.freeze(["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"]);
export const DIRECTIONS = Object.freeze(["ltr", "rtl", "inherit"]);
export const FONT_KERNINGS = Object.freeze(["auto", "normal", "none"]);
export const FONT_VARIANT_CAPS = Object.freeze([
  "normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps",
]);
export const TEXT_RENDERINGS = Object.freeze(["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"]);
const TEXT_RENDERING_CSS = Object.freeze(["auto", "optimizespeed", "optimizelegibility", "geometricprecision"]);

// Reads the text state at `pointer` of the core's memory
// (src/wasm/canvas-2d-text.watpart, "Text state").
export function readTextState(memory, pointer) {
  const view = new DataView(memory.buffer, pointer, 2496);
  const bytes = new Uint8Array(memory.buffer, pointer, 2496);
  const decoder = new TextDecoder();
  const text = (offset, lengthOffset) => decoder.decode(bytes.subarray(offset, offset + view.getInt32(lengthOffset, true)));
  const serialization = text(448, 0);
  const familyOffset = view.getInt32(4, true);
  return {
    font: serialization,
    family: decoder.decode(bytes.subarray(448 + familyOffset, 448 + view.getInt32(0, true))),
    authoredFont: text(1472, 36),
    size: view.getFloat64(8, true),
    weight: view.getFloat64(16, true),
    slope: view.getFloat64(24, true),
    style: view.getInt32(32, true),
    textAlign: view.getInt32(40, true),
    textBaseline: view.getInt32(44, true),
    direction: view.getInt32(48, true),
    fontKerning: view.getInt32(52, true),
    fontStretch: view.getInt32(56, true),
    fontVariantCaps: view.getInt32(60, true),
    textRendering: view.getInt32(64, true),
    letterSpacing: { number: view.getFloat64(72, true), px: view.getFloat64(80, true), unit: view.getInt32(104, true) },
    wordSpacing: { number: view.getFloat64(88, true), px: view.getFloat64(96, true), unit: view.getInt32(108, true) },
    letterSpacingText: text(128, 112),
    wordSpacingText: text(160, 116),
    lang: text(192, 120),
  };
}

// ---------------------------------------------------------------- shaping

// The canvas element's resolved direction and language and its font.
export function canvasTextEnvironment(canvas) {
  const document = canvas.ownerDocument;
  if (!canvas.isConnected) {
    return { direction: 0, language: "", parentSize: 10, parentWeight: 400, rootSize: 16, viewport: viewportOf(canvas) };
  }
  const computed = document.getComputedStyle(canvas);
  const root = document.documentElement;
  const rootSize = root === null ? 16 : parseFloat(document.getComputedStyle(root).fontSize) || 16;
  return {
    direction: computed.direction === "rtl" ? 1 : 0,
    language: languageOf(canvas),
    parentSize: parseFloat(computed.fontSize) || 16,
    parentWeight: parseFloat(computed.fontWeight) || 400,
    rootSize,
    viewport: viewportOf(canvas),
  };
}

function languageOf(element) {
  for (let node = element; node !== null && node.nodeType === 1; node = node.parentElement) {
    const language = node.getAttribute("lang") ?? node.getAttributeNS?.("http://www.w3.org/XML/1998/namespace", "lang");
    if (language !== null && language !== undefined) return language;
  }
  return "";
}

// The viewport of the canvas: its surface's, or its document's.
function viewportOf(canvas) {
  let root = canvas;
  while (root.parentElement) root = root.parentElement;
  const viewport = root._renderSurface?.viewport ?? canvas.ownerDocument._viewport;
  return { width: viewport.width, height: viewport.height };
}

// The detached element of each document that carries the canvas font.
const measurementElements = new WeakMap();

function measurementElement(document) {
  let element = measurementElements.get(document);
  if (element === undefined) {
    element = document.createElement("div");
    measurementElements.set(document, element);
  }
  return element;
}

// HTML "text preparation algorithm" step 2 and Blink's
// IsNormalizedCanvasSpaceCharacter: ASCII white space becomes U+0020.
function prepareText(text) {
  return String(text).replace(/[\t\n\f\r]/g, " ");
}

function styleText(style, size) {
  const caps = FONT_VARIANT_CAPS[style.fontVariantCaps];
  const fontStyle = style.slope === 0 ? "normal" : style.style === 1 && style.slope === ITALIC_SLOPE ? "italic" : `oblique ${style.slope}deg`;
  // `all: initial` keeps author rules that match the detached element out;
  // every declaration is important, so none can override it.
  return [
    "all: initial",
    "display: block",
    "white-space: pre",
    "line-height: normal",
    "text-spacing-trim: space-all",
    `font-family: ${style.families}`,
    `font-size: ${size}px`,
    `font-style: ${fontStyle}`,
    `font-weight: ${style.weight}`,
    `font-stretch: ${STRETCH_PERCENTAGES[style.fontStretch]}%`,
    `font-variant-caps: ${caps}`,
    `font-kerning: ${FONT_KERNINGS[style.fontKerning]}`,
    `text-rendering: ${TEXT_RENDERING_CSS[style.textRendering]}`,
    // The spacings are added here, not by the engine; a letter-spacing
    // turns common and contextual ligatures off, as Blink does.
    `font-variant-ligatures: ${style.letterSpacingPx !== 0 ? "no-common-ligatures no-contextual" : "normal"}`,
    `direction: ${style.direction === 1 ? "rtl" : "ltr"}`,
    "unicode-bidi: normal",
  ].map((declaration) => `${declaration} !important`).join("; ");
}

// Shapes `text` with the resolved text style through the renderer engine.
// Blink's PlainTextNode shapes each word of each bidi run on its own
// (SegmentWord), so no kerning, ligature or contextual form crosses a
// word end: every word is a text node of its own, at the levels the
// engine resolves over the whole text. The engine shapes adjacent text
// nodes of one font as one run, as Blink's InlineNode does; a
// vertical-align other than baseline breaks such a run, so each word is
// in a span with `vertical-align: 0px`, which moves no glyph and changes
// no level. Returns the glyphs in logical order, each with the UTF-16
// index of its cluster (`character`), and the primary face.
function shapeWithEngine(canvas, style, text) {
  const document = canvas.ownerDocument;
  const element = measurementElement(document);
  element.setAttribute("style", styleText(style, style.size));
  if (style.lang === "") element.removeAttribute("lang");
  else element.setAttribute("lang", style.lang);
  const starts = [0, ...wordEnds(text, 0, text.length)];
  if (starts.length === 1) starts.push(0);
  const words = [];
  for (let index = 1; index < starts.length; index++) words.push(document.createTextNode(text.slice(starts[index - 1], starts[index])));
  element.replaceChildren(...words.map((word) => {
    const span = document.createElement("span");
    span.setAttribute("style", "vertical-align: 0px");
    span.append(word);
    return span;
  }));
  const runtime = document._sandomSceneRendererRuntime ?? null;
  const shape = runtime?.shapeStandaloneTextSync ?? shapeStandaloneTextSync;
  const serialized = serializeToScene(element, { viewportWidth: style.viewport.width, viewportHeight: style.viewport.height });
  try {
    const shaped = shape({
      width: style.viewport.width,
      height: style.viewport.height,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    }, words.map((word) => serialized.indexOf.get(word)));
    const glyphs = [];
    shaped.nodes.forEach((nodeGlyphs, node) => {
      const start = starts[node];
      const offsets = utf8Offsets(words[node].data);
      for (const glyph of nodeGlyphs) {
        glyph.character = start + (offsets[glyph.cluster] ?? words[node].data.length);
        glyphs.push(glyph);
      }
    });
    return {
      glyphs,
      primary: shaped.primary,
      synthesizedSize: shaped.synthesizedSize,
      outlines: runtime?.shapingRuntime.glyphOutlinesSync ?? glyphOutlinesSync,
    };
  } finally {
    serialized.release();
  }
}

// UTF-8 byte offset to UTF-16 index of `text`.
function utf8Offsets(text) {
  const offsets = [];
  let index = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    for (let byte = 0; byte < bytes; byte++) offsets.push(index);
    index += character.length;
  }
  offsets.push(index);
  return offsets;
}

function isCjkOrEmoji(code) {
  return (code >= 0x1100 && code <= 0x11FF) || (code >= 0x2E80 && code <= 0xA4CF) || (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) || (code >= 0xFF00 && code <= 0xFFEF) ||
    (code >= 0x1F000 && code <= 0x1FAFF) || (code >= 0x20000 && code <= 0x3FFFD);
}

// Blink's NextWordEndIndex (PlainTextNode): a space or a tab is a word of
// its own; other words end at one; a CJK or emoji character is a word of
// its own.
function wordEnds(text, start, end) {
  const ends = [];
  let index = start;
  while (index < end) {
    const code = text.codePointAt(index);
    let next = index + (code > 0xFFFF ? 2 : 1);
    if (code === 32 || code === 9 || code === 0x200B || next >= end || isCjkOrEmoji(code)) {
      ends.push(next);
      index = next;
      continue;
    }
    while (next < end) {
      const following = text.codePointAt(next);
      if (following === 32 || following === 9 || following === 0x200B || isCjkOrEmoji(following)) break;
      next += following > 0xFFFF ? 2 : 1;
    }
    ends.push(next);
    index = next;
  }
  return ends;
}

// gfx::RectF with its single-precision arithmetic: x, y, width, height.
function rectUnion(a, b) {
  if (a === null || a.width <= 0 || a.height <= 0) return b;
  if (b === null || b.width <= 0 || b.height <= 0) return a;
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(f32(a.x + a.width), f32(b.x + b.width));
  const bottom = Math.max(f32(a.y + a.height), f32(b.y + b.height));
  return { x: left, y: top, width: f32(right - left), height: f32(bottom - top) };
}

// The control box of a glyph outline in font units, y up, or null for an
// empty outline (verbs of src/wasm/glyph-outlines.watpart). `skew` slants
// the points first: x + skew × y.
function outlineBox(verbs, skew) {
  const view = new DataView(verbs.buffer, verbs.byteOffset, verbs.byteLength);
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  const POINTS = [1, 1, 2, 3, 0];
  for (let offset = 0; offset < verbs.length;) {
    const verb = verbs[offset++];
    for (let point = 0; point < POINTS[verb]; point++, offset += 8) {
      const y = view.getFloat32(offset + 4, true);
      const x = f32(view.getFloat32(offset, true) + f32(skew * y));
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  return xMin === Infinity ? null : { xMin, yMin, xMax, yMax };
}

// Skia's slant of a synthesized oblique (SK_Scalar1 / 4).
export const SYNTHETIC_OBLIQUE_SKEW = 0.25;

// Skia's bounds of a glyph at `size` px, as a gfx::RectF in px with y
// down: the control box of its outline, each coordinate times
// f32(size / upem) in single precision (measured exact for upem 2048; see
// docs/specifications/canvas-2d.md, "Text"). Null for a glyph without
// ink. Cached for each face, size, slant and glyph.
const glyphBoundsCache = new WeakMap();
function glyphBounds(face, size, glyphId, outlines, oblique) {
  let bySize = glyphBoundsCache.get(face);
  if (bySize === undefined) glyphBoundsCache.set(face, bySize = new Map());
  const key = oblique ? -size : size;
  let byGlyph = bySize.get(key);
  if (byGlyph === undefined) bySize.set(key, byGlyph = new Map());
  if (!byGlyph.has(glyphId)) {
    const verbs = outlines(face.fontIndex, variationsOf(face, size), [glyphId])[0];
    const box = outlineBox(verbs, oblique ? SYNTHETIC_OBLIQUE_SKEW : 0);
    let bounds = null;
    if (box !== null) {
      const scale = f32(size / face.upem);
      const left = f32(box.xMin * scale);
      const top = f32(-box.yMax * scale);
      const width = f32(f32(box.xMax * scale) - left);
      const height = f32(f32(-box.yMin * scale) - top);
      if (width > 0 && height > 0) bounds = { x: left, y: top, width, height };
    }
    byGlyph.set(glyphId, bounds);
  }
  return byGlyph.get(glyphId);
}

// Whether Chrome synthesizes the slant of `style` for `face`: a style
// italic by Blink's kItalicThreshold (a slope of 14deg or more; italic is
// 14deg) on a face that is neither italic nor slanted by a 'slnt' axis.
// A smaller or negative oblique angle draws the face upright.
function syntheticOblique(face, style) {
  return style.slope >= ITALIC_SLOPE && !face.italic && face.variationSlant === 0;
}

function variationsOf(face, size) {
  const variations = [["opsz", size], ["slnt", face.variationSlant]];
  if (face.weight !== 0) variations.push(["wght", face.weight]);
  if (face.variationWidth !== 0) variations.push(["wdth", face.variationWidth]);
  return variations;
}

// One shaping of `text` with the resolved `style`: the items of Blink's
// PlainTextNode in visual order, each with its glyphs, 16.16 advances,
// width and ink bounds.
// A glyph's advance in TextRunLayoutUnit (HarfBuzz 16.16) as Blink's
// shaper makes it. Skia's width of the glyph, hmtx units × size / upem
// rounded once to single precision, is truncated to 16.16
// (SkiaScalarToHarfBuzzPosition); HarfBuzz adds the GPOS adjustment at the
// font's 16.16 scale, rounded by hb_font_t::em_mult. The engine's advance
// carries hmtx and GPOS together in the primary face's subdivided units
// ($shapeTextRun rescales a fallback face's, rounded, which a face of no
// more units per em undoes exactly); for a static face the hmtx advance
// read from the bytes separates them. A variable face's deltas are the
// engine's own, so its whole advance scales as a width.
function shapedAdvance(glyph, size, primary) {
  const face = glyph.face;
  const width = (units, upem) => Math.trunc(f32(units * size / upem) * FIXED);
  let advance = glyph.advance;
  let upem = primary.subdividedUpem;
  if (face.fontIndex !== primary.fontIndex) {
    if (face.subdividedUpem > upem) return width(advance, upem);
    advance = Math.round(advance * face.subdividedUpem / upem);
    upem = face.subdividedUpem;
  }
  const tables = tablesOf(face);
  const units = advance * face.upem / upem;
  const base = tables.variable || !Number.isInteger(units) ? null : hmtxAdvance(tables, glyph.id);
  if (base === null || advance === 0) return width(advance, upem);
  const delta = units - base;
  if (delta === 0) return width(base, face.upem);
  const multiplier = Math.trunc(Math.trunc(size * FIXED) * FIXED / face.upem);
  return width(base, face.upem) + Math.floor((delta * multiplier + 32768) / FIXED);
}

export function layoutCanvasText(canvas, style, text) {
  const prepared = prepareText(text);
  const shaped = shapeWithEngine(canvas, style, prepared);
  const { glyphs, primary } = shaped;
  const size = f32(style.size);
  // A synthesized small capital (font-variant-caps on a face without its
  // features) is a glyph of the face at the synthesized size; the engine
  // gives its unscaled advance in the shaping face's own units.
  const synthesizedSize = f32(shaped.synthesizedSize);
  const sizeOf = (glyph) => (glyph.synthesized ? synthesizedSize : size);
  // Spacing per grapheme cluster end and per space (ShapeResultSpacing),
  // in TextRunLayoutUnit.
  const letterRaw = Math.trunc(f32(f32(style.letterSpacingPx) * FIXED));
  const wordRaw = Math.trunc(f32(f32(style.wordSpacingPx) * FIXED));
  const spaced = letterRaw !== 0 || wordRaw !== 0;
  const count = glyphs.length;
  const characters = new Array(count);
  const advances = new Array(count);
  for (let index = 0; index < count; index++) {
    const glyph = glyphs[index];
    characters[index] = glyph.character;
    advances[index] = glyph.synthesized
      ? shapedAdvance({ ...glyph, advance: glyph.unscaledAdvance }, synthesizedSize, glyph.face)
      : shapedAdvance(glyph, size, primary);
  }
  if (spaced) {
    for (let index = 0; index < count; index++) {
      if (index + 1 < count && characters[index + 1] === characters[index]) continue;
      const code = prepared.charCodeAt(characters[index]);
      let spacing = 0;
      if (code !== 0x200B && code !== 0xFEFF) spacing += letterRaw;
      if ((code === 32 || code === 0xA0) && (characters[index] !== 0 || code === 0xA0)) spacing += wordRaw;
      advances[index] += spacing;
    }
  }
  // Bidi runs from the level bytes, in visual order (UAX #9 L2); each run
  // splits into words, which a right-to-left run takes in reverse.
  const levelOf = (index) => glyphs[index].level & 0x7F;
  const runs = [];
  for (let start = 0; start < count;) {
    let end = start + 1;
    while (end < count && levelOf(end) === levelOf(start)) end++;
    runs.push({ start, end, level: levelOf(start) });
    start = end;
  }
  const maximum = runs.reduce((value, run) => Math.max(value, run.level), 0);
  const lowestOdd = runs.reduce((value, run) => (run.level % 2 === 1 ? Math.min(value, run.level) : value), Infinity);
  for (let level = maximum; level >= lowestOdd && level > 0; level--) {
    for (let start = 0; start < runs.length;) {
      if (runs[start].level < level) {
        start++;
        continue;
      }
      let end = start;
      while (end < runs.length && runs[end].level >= level) end++;
      runs.splice(start, end - start, ...runs.slice(start, end).reverse());
      start = end;
    }
  }
  const items = [];
  for (const run of runs) {
    const rtl = run.level % 2 === 1;
    const firstCharacter = characters[run.start];
    const lastCharacter = run.end < count ? characters[run.end] : prepared.length;
    const ends = wordEnds(prepared, firstCharacter, Math.max(lastCharacter, firstCharacter + 1));
    const words = [];
    let glyph = run.start;
    for (const wordEnd of ends) {
      const first = glyph;
      while (glyph < run.end && characters[glyph] < wordEnd) glyph++;
      if (glyph > first) words.push({ start: first, end: glyph });
    }
    if (rtl) words.reverse();
    for (const word of words) items.push(itemOf(word, rtl));
  }

  function itemOf(word, rtl) {
    // Glyphs in visual order; a run of one face is one ShapeResultRun.
    const order = [];
    for (let index = word.start; index < word.end; index++) order.push(index);
    if (rtl) order.reverse();
    let width = 0;
    let runAdvance = 0;
    let bounds = null;
    const positions = new Array(order.length);
    let itemRaw = 0;
    for (let start = 0; start < order.length;) {
      let end = start + 1;
      while (
        end < order.length && glyphs[order[end]].face === glyphs[order[start]].face &&
        glyphs[order[end]].synthesized === glyphs[order[start]].synthesized
      ) end++;
      let runRaw = 0;
      for (let index = start; index < end; index++) runRaw += advances[order[index]];
      // InlineLayoutUnit::FromFloatCeil(run_advance), then the glyph
      // origins in fixed point.
      let origin = Math.ceil(f32(runAdvance * FIXED));
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      for (let index = start; index < end; index++) {
        const glyph = glyphs[order[index]];
        positions[index] = { glyph: order[index], raw: itemRaw };
        const box = glyphBox(glyph);
        if (box !== null) {
          const originPx = f32(origin / FIXED);
          const x = f32(box.x + originPx);
          const right = f32(x + box.width);
          const bottom = f32(box.y + box.height);
          if (minX === 0 && maxX === 0) {
            minX = x;
            maxX = right;
            minY = box.y;
            maxY = bottom;
          } else {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, right);
            minY = Math.min(minY, box.y);
            maxY = Math.max(maxY, bottom);
          }
        }
        origin += advances[order[index]];
        itemRaw += advances[order[index]];
      }
      bounds = rectUnion(bounds, { x: minX, y: minY, width: f32(maxX - minX), height: f32(maxY - minY) });
      const runWidth = spaced ? f32(runRaw) / FIXED : f32(Math.max(0, runRaw)) / FIXED;
      runAdvance = f32(runAdvance + f32(runWidth));
      width = f32(width + f32(runWidth));
      start = end;
    }
    return { glyphs: positions, width, bounds };
  }

  function glyphBox(glyph) {
    return glyphBounds(glyph.face, sizeOf(glyph), glyph.id, shaped.outlines, syntheticOblique(glyph.face, style));
  }

  // TextMetrics::MeasureRuns: the items' widths summed in single
  // precision, their ink bounds united at those positions.
  let xpos = 0;
  let inkBounds = null;
  for (const item of items) {
    item.x = xpos;
    if (item.bounds !== null) {
      inkBounds = rectUnion(inkBounds, { ...item.bounds, x: f32(item.bounds.x + xpos) });
    }
    xpos = f32(xpos + item.width);
  }
  return { width: xpos, inkBounds, items, glyphs, primary, size, synthesizedSize, style, outlines: shaped.outlines };
}

// --------------------------------------------------------------- metrics

// The engine's $fontMetricPx (src/wasm/engine-layout.watpart): the scale
// truncated to 16.16 fixed point, then rounded half up. `units` are
// subdivided font units and `scale` is f32(size / subdivided upem).
function fontMetricPx(units, scale) {
  const fixed = Math.floor(scale * 33554432);
  return f32(Math.floor(units * fixed / 33554432 + 0.5));
}

// What this module reads from a face's bytes itself (Blink reads these
// tables without variations): OS/2 sTypoAscender and sTypoDescender, or
// null; the hmtx advances; whether the face is variable.
const faceTables = new WeakMap();
function tablesOf(face) {
  let tables = faceTables.get(face.bytes);
  if (tables !== undefined) return tables;
  const bytes = face.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let directory = 0;
  if (view.getUint32(0) === 0x74746366) directory = view.getUint32(12 + face.faceIndex * 4);
  const records = new Map();
  const count = view.getUint16(directory + 4);
  for (let index = 0; index < count; index++) {
    const record = directory + 12 + index * 16;
    records.set(view.getUint32(record), { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  const os2 = records.get(0x4F532F32);
  const hhea = records.get(0x68686561);
  const hmtx = records.get(0x686D7478);
  tables = {
    typo: os2 !== undefined && os2.length >= 72 ? { ascender: view.getInt16(os2.offset + 68), descender: view.getInt16(os2.offset + 70) } : null,
    variable: records.has(0x66766172),
    view,
    hmtx: hmtx?.offset ?? 0,
    horizontalMetrics: hhea !== undefined && hmtx !== undefined ? view.getUint16(hhea.offset + 34) : 0,
  };
  faceTables.set(face.bytes, tables);
  return tables;
}

// The hmtx advance of `glyphId` in font units, or null.
function hmtxAdvance(tables, glyphId) {
  if (tables.horizontalMetrics === 0) return null;
  return tables.view.getUint16(tables.hmtx + Math.min(glyphId, tables.horizontalMetrics - 1) * 4);
}

// SimpleFontData::NormalizedTypoAscentAndDescent, in LayoutUnit (1/64 px).
function normalizedTypo(face, size, ascent, descent) {
  const normalize = (asc, height) => {
    if (!(height > 0) || asc < 0 || asc > height) return null;
    const ascentLu = Math.round(f32(f32(f32(asc) * size) / f32(height)) * 64);
    return { ascent: ascentLu, descent: Math.round(f32(size * 64)) - ascentLu };
  };
  const typo = tablesOf(face).typo;
  if (typo !== null && typo.ascender > 0) {
    const normalized = normalize(typo.ascender, typo.ascender - typo.descender);
    if (normalized !== null) return normalized;
  }
  return normalize(ascent, f32(ascent + descent)) ?? { ascent: 0, descent: 0 };
}

// TextMetrics::GetFontBaseline.
function fontBaseline(baseline, primary) {
  const { ascent, descent } = primary;
  switch (TEXT_BASELINES[baseline]) {
    case "top": return f32(primary.typo.ascent / 64);
    case "hanging": return f32(ascent * 80 / 100);
    case "middle": return f32(f32(f32(primary.typo.ascent / 64) - f32(primary.typo.descent / 64)) / 2);
    case "ideographic": return f32(-descent);
    case "bottom": return f32(-primary.typo.descent / 64);
  }
  return 0;
}

// The primary face's metrics at `size`: ascent, descent and line gap
// rounded as Chrome rounds them (the engine's $fontMetricPx), and the
// normalized typographic ascent and descent.
export function primaryMetrics(layout) {
  const face = layout.primary;
  const scale = f32(layout.size / face.subdividedUpem);
  const ascent = fontMetricPx(face.ascender, scale);
  const descent = fontMetricPx(-face.descender, scale);
  const lineGap = fontMetricPx(face.lineGap, scale);
  return { ascent, descent, lineGap, typo: normalizedTypo(face, layout.size, ascent, descent) };
}

// Where text goes relative to the fillText() point: the x of its left end
// (textAlign with the resolved direction: alignFactor 0, 0.5 or 1 of the
// width) and the y of its alphabetic baseline (textBaseline).
export function textPlacement(layout, style) {
  let alignFactor = 0;
  const align = TEXT_ALIGNS[style.textAlign];
  const rtl = style.direction === 1;
  if (align === "center") alignFactor = 0.5;
  else if (align === "right" || (align === "start" && rtl) || (align === "end" && !rtl)) alignFactor = 1;
  const metrics = primaryMetrics(layout);
  return {
    alignFactor,
    anchorX: -alignFactor * layout.width,
    baselineY: fontBaseline(style.textBaseline, metrics),
  };
}

// Blink's bounds of a fillText() or strokeText() draw in user space
// (BaseRenderingContext2D::DrawTextInternal), from the location of the
// left end of its alphabetic baseline and the drawn width (the smaller of
// the width and maxWidth): the line box around it, a half font height
// wider on each side. The alpha reset of an opaque canvas covers them.
export function textDrawBounds(layout, locationX, locationY, width) {
  const { ascent, descent, lineGap } = primaryMetrics(layout);
  const height = ascent + descent;
  return {
    x: f32(locationX - height / 2),
    y: f32(locationY - ascent - lineGap),
    width: f32(width + height),
    height: ascent + descent + lineGap,
  };
}

export class TextMetrics {
  #values;

  constructor(token, values) {
    if (token !== TEXT_METRICS_CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#values = values;
  }

  // Chrome's prototype lists the attributes, then the constructor, then
  // the string tag.
  static {
    const constructor = Object.getOwnPropertyDescriptor(this.prototype, "constructor");
    delete this.prototype.constructor;
    for (const name of [
      "width", "actualBoundingBoxLeft", "actualBoundingBoxRight", "fontBoundingBoxAscent", "fontBoundingBoxDescent",
      "actualBoundingBoxAscent", "actualBoundingBoxDescent", "hangingBaseline", "alphabeticBaseline", "ideographicBaseline",
    ]) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        enumerable: true,
        get: {
          [name]() {
            return this.#values[name];
          },
        }[name],
      });
    }
    Object.defineProperty(this.prototype, "constructor", constructor);
    Object.defineProperty(this.prototype, Symbol.toStringTag, { configurable: true, value: "TextMetrics" });
  }
}

// TextMetrics::Update for the shaped `layout` and the context `style`.
export function measureCanvasText(layout, style) {
  const width = layout.width;
  let dx = 0;
  const align = TEXT_ALIGNS[style.textAlign];
  const rtl = style.direction === 1;
  if (align === "center") dx = f32(width / 2);
  else if (align === "right" || (align === "start" && rtl) || (align === "end" && !rtl)) dx = width;
  const metrics = primaryMetrics(layout);
  const baselineY = fontBaseline(style.textBaseline, metrics);
  const bounds = layout.inkBounds ?? { x: 0, y: 0, width: 0, height: 0 };
  return new TextMetrics(TEXT_METRICS_CONSTRUCTION, Object.freeze({
    width,
    actualBoundingBoxLeft: f32(-bounds.x + dx),
    actualBoundingBoxRight: f32(f32(bounds.x + bounds.width) - dx),
    fontBoundingBoxAscent: f32(metrics.ascent - baselineY),
    fontBoundingBoxDescent: f32(metrics.descent + baselineY),
    actualBoundingBoxAscent: f32(-bounds.y - baselineY),
    actualBoundingBoxDescent: f32(f32(bounds.y + bounds.height) + baselineY),
    hangingBaseline: f32(f32(metrics.ascent * 80 / 100) - baselineY),
    alphabeticBaseline: f32(-baselineY),
    ideographicBaseline: f32(-metrics.descent - baselineY),
  }));
}

// The glyph run of `layout` for fillText() and strokeText(): every glyph's
// origin relative to the left end of the alphabetic baseline, and its face
// with what a glyph atlas and an outline need.
export function canvasGlyphRun(layout) {
  const fonts = [];
  const fontIndexes = new Map();
  const glyphs = [];
  for (const item of layout.items) {
    for (const position of item.glyphs) {
      const glyph = layout.glyphs[position.glyph];
      const fontSize = glyph.synthesized ? layout.synthesizedSize : layout.size;
      let byFace = fontIndexes.get(glyph.face);
      if (byFace === undefined) fontIndexes.set(glyph.face, byFace = new Map());
      let font = byFace.get(fontSize);
      if (font === undefined) {
        font = fonts.length;
        byFace.set(fontSize, font);
        fonts.push(fontDescriptor(glyph.face, layout, fontSize));
      }
      glyphs.push({ font, id: glyph.id, x: f32(item.x + f32(position.raw / FIXED)), y: 0 });
    }
  }
  return { glyphs, fonts };
}

// One descriptor per face, size and slant, shared by every layout that
// uses them, so a flush can group glyphs by descriptor identity. A
// synthesized small capital draws at its `fontSize` with the optical size
// of the layout's size, as Blink's SmallCapsFontData keeps the variations
// of its face.
const fontDescriptors = new WeakMap();
function fontDescriptor(face, layout, fontSize) {
  let bySize = fontDescriptors.get(face);
  if (bySize === undefined) fontDescriptors.set(face, bySize = new Map());
  const oblique = syntheticOblique(face, layout.style);
  const key = `${layout.size} ${fontSize} ${oblique}`;
  let descriptor = bySize.get(key);
  if (descriptor === undefined) {
    const variations = variationsOf(face, layout.size);
    const outlines = layout.outlines;
    descriptor = Object.freeze({
      fontIndex: face.fontIndex,
      bytes: face.bytes,
      faceIndex: face.faceIndex,
      weight: face.weight || 400,
      variationWidth: face.variationWidth,
      variationSlant: face.variationSlant,
      opticalSize: layout.size,
      fontSize,
      upem: face.upem,
      syntheticOblique: oblique,
      outline: (glyphId) => outlines(face.fontIndex, variations, [glyphId])[0],
    });
    bySize.set(key, descriptor);
  }
  return descriptor;
}
