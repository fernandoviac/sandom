// Canvas 2D text (plans/dom/PLAN-canvas-2d.md, slice 5;
// docs/specifications/canvas-2d.md, "Text").
//
// The text attributes, the font, measureText() and the glyph runs of
// fillText() and strokeText(). The context's text state lives in
// core/engine/canvas-2d-text.watpart; this module lays the text out through
// the renderer engine.
//
// Shaping is Sandom's one text path. A detached element of the canvas's
// document carries the canvas font as its inline style, one text node for
// each of Blink's words (canvas_text_word_ends), and the renderer engine
// lays it out alone (layoutCanvasTextSync, src/scene-renderer.js): the
// document's fonts and @font-face rules, the font stack and fallback
// faces, bidi levels, OpenType features and kerning are those of CSS text.
// The engine then computes from the shaped glyphs what Chrome's canvas
// computes from its own (canvas_text_layout and canvas_text_measure,
// core/engine/canvas-text-layout.watpart).
import { serializeToScene } from "./serialize.js";
import { canvasTextGlyphOutlineSync, canvasTextWordsSync, layoutCanvasTextSync } from "../scene-renderer.js";
import { layoutRootOf } from "./geometry.js";
import { layoutConstant, moduleLayoutConstants } from "../wasm/layout-table.js";
import * as canvas2dBinary from "../wasm/canvas-2d-binary.js";

const canvasCoreConstant = moduleLayoutConstants(canvas2dBinary, "canvas 2d");
// The text state of canvas-2d-text.watpart, by WAT name.
const TEXT_STATE = Object.freeze(Object.fromEntries([
  "SIZE", "FONT_LENGTH", "FAMILY_OFFSET", "FONT_SIZE", "FONT_WEIGHT", "FONT_SLOPE", "FONT_STYLE", "AUTHORED_LENGTH",
  "TEXT_ALIGN", "TEXT_BASELINE", "DIRECTION", "FONT_KERNING", "FONT_STRETCH", "FONT_VARIANT_CAPS", "TEXT_RENDERING",
  "LETTER_NUMBER", "LETTER_PX", "WORD_NUMBER", "WORD_PX", "LETTER_UNIT", "WORD_UNIT", "LETTER_TEXT_LENGTH",
  "WORD_TEXT_LENGTH", "LANG_LENGTH", "LETTER_TEXT", "WORD_TEXT", "LANG", "FONT", "AUTHORED",
].map((name) => [name, canvasCoreConstant(`TEXT_STATE_${name}`)])));

const CANVAS_TEXT_MEASURE_ALIGN_FACTOR = layoutConstant("CANVAS_TEXT_MEASURE_ALIGN_FACTOR");
const CANVAS_TEXT_MEASURE_BASELINE_Y = layoutConstant("CANVAS_TEXT_MEASURE_BASELINE_Y");

const TEXT_METRICS_CONSTRUCTION = Symbol("TextMetrics construction");

// --------------------------------------------------------------- the font

export const FONT_STRETCHES = Object.freeze([
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded",
  "extra-expanded", "ultra-expanded",
]);

// ------------------------------------------------------------ text style

export const TEXT_ALIGNS = Object.freeze(["start", "end", "left", "right", "center"]);
export const TEXT_BASELINES = Object.freeze(["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"]);
export const DIRECTIONS = Object.freeze(["ltr", "rtl", "inherit"]);
export const FONT_KERNINGS = Object.freeze(["auto", "normal", "none"]);
export const FONT_VARIANT_CAPS = Object.freeze([
  "normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps",
]);
export const TEXT_RENDERINGS = Object.freeze(["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"]);

// Reads the text state at `pointer` of the core's memory
// (core/engine/canvas-2d-text.watpart, "Text state").
export function readTextState(memory, pointer) {
  const view = new DataView(memory.buffer, pointer, TEXT_STATE.SIZE);
  const bytes = new Uint8Array(memory.buffer, pointer, TEXT_STATE.SIZE);
  const decoder = new TextDecoder();
  const text = (offset, lengthOffset) => decoder.decode(bytes.subarray(offset, offset + view.getInt32(lengthOffset, true)));
  const serialization = text(TEXT_STATE.FONT, TEXT_STATE.FONT_LENGTH);
  const familyOffset = view.getInt32(TEXT_STATE.FAMILY_OFFSET, true);
  return {
    font: serialization,
    family: decoder.decode(bytes.subarray(TEXT_STATE.FONT + familyOffset,
      TEXT_STATE.FONT + view.getInt32(TEXT_STATE.FONT_LENGTH, true))),
    authoredFont: text(TEXT_STATE.AUTHORED, TEXT_STATE.AUTHORED_LENGTH),
    size: view.getFloat64(TEXT_STATE.FONT_SIZE, true),
    weight: view.getFloat64(TEXT_STATE.FONT_WEIGHT, true),
    slope: view.getFloat64(TEXT_STATE.FONT_SLOPE, true),
    style: view.getInt32(TEXT_STATE.FONT_STYLE, true),
    textAlign: view.getInt32(TEXT_STATE.TEXT_ALIGN, true),
    textBaseline: view.getInt32(TEXT_STATE.TEXT_BASELINE, true),
    direction: view.getInt32(TEXT_STATE.DIRECTION, true),
    fontKerning: view.getInt32(TEXT_STATE.FONT_KERNING, true),
    fontStretch: view.getInt32(TEXT_STATE.FONT_STRETCH, true),
    fontVariantCaps: view.getInt32(TEXT_STATE.FONT_VARIANT_CAPS, true),
    textRendering: view.getInt32(TEXT_STATE.TEXT_RENDERING, true),
    letterSpacing: {
      number: view.getFloat64(TEXT_STATE.LETTER_NUMBER, true), px: view.getFloat64(TEXT_STATE.LETTER_PX, true),
      unit: view.getInt32(TEXT_STATE.LETTER_UNIT, true),
    },
    wordSpacing: {
      number: view.getFloat64(TEXT_STATE.WORD_NUMBER, true), px: view.getFloat64(TEXT_STATE.WORD_PX, true),
      unit: view.getInt32(TEXT_STATE.WORD_UNIT, true),
    },
    letterSpacingText: text(TEXT_STATE.LETTER_TEXT, TEXT_STATE.LETTER_TEXT_LENGTH),
    wordSpacingText: text(TEXT_STATE.WORD_TEXT, TEXT_STATE.WORD_TEXT_LENGTH),
    lang: text(TEXT_STATE.LANG, TEXT_STATE.LANG_LENGTH),
  };
}

// ---------------------------------------------------------------- shaping

// The canvas element's resolved direction and language and its computed
// font values for canvas_font_parse, which takes the defaults of a canvas
// outside a document and of values the host cannot compute (NaN).
export function canvasTextEnvironment(canvas) {
  const document = canvas.ownerDocument;
  if (!canvas.isConnected) {
    return {
      connected: false, direction: 0, language: "", parentSize: NaN, parentWeight: NaN, rootSize: NaN,
      viewport: viewportOf(canvas),
    };
  }
  const computed = document.getComputedStyle(canvas);
  const root = document.documentElement;
  const dom = canvas._domCore;
  dom.status("canvas_language", canvas._coreHandle);
  return {
    connected: true,
    direction: computed.direction === "rtl" ? 1 : 0,
    language: dom.outputString(),
    parentSize: parseFloat(computed.fontSize),
    parentWeight: parseFloat(computed.fontWeight),
    rootSize: root === null ? NaN : parseFloat(document.getComputedStyle(root).fontSize),
    viewport: viewportOf(canvas),
  };
}

// The viewport of the canvas: its surface's, or its document's.
function viewportOf(canvas) {
  const root = layoutRootOf(canvas);
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

// The measurement element's inline style for `style`
// (canvas_measurement_style).
function styleText(dom, style) {
  dom.status("canvas_measurement_style", ...dom.input(style.families), style.size, style.slope, style.style,
    style.weight, style.fontStretch, style.fontVariantCaps, style.fontKerning, style.textRendering,
    style.letterSpacingPx, style.direction);
  return dom.outputString();
}

// Lays `text` out with the resolved text style through the renderer
// engine. Blink's PlainTextNode shapes each word of each bidi run on its
// own (SegmentWord), so no kerning, ligature or contextual form crosses a
// word end: every word is a text node of its own, at the levels the
// engine resolves over the whole text. The engine shapes adjacent text
// nodes of one font as one run, as Blink's InlineNode does; a
// vertical-align other than baseline breaks such a run, so each word is
// in a span with `vertical-align: 0px`, which moves no glyph and changes
// no level. Returns the layout of layoutCanvasTextSync.
export function layoutCanvasText(canvas, style, text) {
  const document = canvas.ownerDocument;
  const runtime = document._sandomSceneRendererRuntime ?? null;
  const words = (runtime?.canvasTextWordsSync ?? canvasTextWordsSync)(String(text));
  const element = measurementElement(document);
  element.setAttribute("style", styleText(canvas._domCore, style));
  if (style.lang === "") element.removeAttribute("lang");
  else element.setAttribute("lang", style.lang);
  const nodes = words.map((word) => document.createTextNode(word));
  element.replaceChildren(...nodes.map((node) => {
    const span = document.createElement("span");
    span.setAttribute("style", "vertical-align: 0px");
    span.append(node);
    return span;
  }));
  const serialized = serializeToScene(element, { viewportWidth: style.viewport.width, viewportHeight: style.viewport.height });
  try {
    const layout = (runtime?.layoutCanvasTextSync ?? layoutCanvasTextSync)({
      width: style.viewport.width,
      height: style.viewport.height,
      nodes: serialized.nodes,
      generatedBoxRows: serialized.generatedBoxRows,
      imageSources: serialized.imageSources,
    }, nodes.map((node) => serialized.indexOf.get(node)), {
      size: style.size,
      letterSpacingPx: style.letterSpacingPx,
      wordSpacingPx: style.wordSpacingPx,
      slope: style.slope,
    });
    layout.outlines = runtime?.canvasTextGlyphOutlineSync ?? canvasTextGlyphOutlineSync;
    return layout;
  } finally {
    serialized.release();
  }
}

// Where text goes relative to the fillText() point: the align factor (0,
// 0.5 or 1 of the width) and the y of its alphabetic baseline
// (canvas_text_measure).
export function textPlacement(layout, style) {
  const values = layout.measure(style.textAlign, style.textBaseline, style.direction);
  return { alignFactor: values[CANVAS_TEXT_MEASURE_ALIGN_FACTOR / 8], baselineY: values[CANVAS_TEXT_MEASURE_BASELINE_Y / 8] };
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

// TextMetrics::Update for `layout` and the context `style`
// (canvas_text_measure).
const METRIC_NAMES = Object.freeze([
  "width", "actualBoundingBoxLeft", "actualBoundingBoxRight", "fontBoundingBoxAscent", "fontBoundingBoxDescent",
  "actualBoundingBoxAscent", "actualBoundingBoxDescent", "hangingBaseline", "alphabeticBaseline", "ideographicBaseline",
]);
export function measureCanvasText(layout, style) {
  const values = layout.measure(style.textAlign, style.textBaseline, style.direction);
  return new TextMetrics(TEXT_METRICS_CONSTRUCTION, Object.freeze(Object.fromEntries(
    METRIC_NAMES.map((name, index) => [name, values[index]]),
  )));
}

// The glyph run of `layout` for fillText() and strokeText(): every glyph's
// origin relative to the left end of the alphabetic baseline, and its face
// with what a glyph atlas and an outline need.
export function canvasGlyphRun(layout) {
  const fonts = [];
  const glyphs = [];
  // Each run font (canvas_text_layout's CANVAS_TEXT_GLYPH_RUN_FONT) takes
  // its descriptor from its first glyph; a synthesized glyph reads the
  // layout's synthesized size.
  for (const glyph of layout.glyphs) {
    if (fonts[glyph.runFont] === undefined) {
      const fontSize = glyph.synthesized ? layout.synthesizedSize : layout.size;
      fonts[glyph.runFont] = fontDescriptor(glyph.face, layout, fontSize, glyph.oblique);
    }
    glyphs.push({ font: glyph.runFont, id: glyph.id, x: glyph.x, y: 0 });
  }
  return { glyphs, fonts };
}

// One descriptor per face, size and slant, shared by every layout that
// uses them, so a flush can group glyphs by descriptor identity. A
// synthesized small capital draws at its `fontSize` with the optical size
// of the layout's size, as Blink's SmallCapsFontData keeps the variations
// of its face.
const fontDescriptors = new WeakMap();
function fontDescriptor(face, layout, fontSize, oblique) {
  let bySize = fontDescriptors.get(face);
  if (bySize === undefined) fontDescriptors.set(face, bySize = new Map());
  const key = `${layout.size} ${fontSize} ${oblique}`;
  let descriptor = bySize.get(key);
  if (descriptor === undefined) {
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
      outline: (glyphId) => outlines(face.fontIndex, layout.size, glyphId),
    });
    bySize.set(key, descriptor);
  }
  return descriptor;
}
