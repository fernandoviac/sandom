import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { acquireFontByteSource } from "./dom-wasm/font-byte-binding.js";
import { loadEngine } from "./wasm/loader.js";
import { layoutConstant } from "./wasm/layout-table.js";

const OPTIONAL_ABSENT = layoutConstant("OPTIONAL_ABSENT");
const OPTIONAL_PRESENT = layoutConstant("OPTIONAL_PRESENT");
const OPTIONAL_OTHER = layoutConstant("OPTIONAL_OTHER");
// The tag rows of font-shaping-input.watpart and the shape result of
// glyph-outlines.watpart, by WAT name.
const FONT_TAG = Object.freeze(Object.fromEntries(["SIZE", "UNITS", "LENGTH", "TYPES", "VALUE", "STRING", "NUMBER"]
  .map((name) => [name, layoutConstant(`FONT_TAG_${name}`)])));
const SHAPE = Object.freeze(Object.fromEntries([
  "RESULT_COUNT", "RESULT_UPEM", "RESULT_GLYPHS", "GLYPH_SIZE", "GLYPH_ID", "GLYPH_CLUSTER", "GLYPH_X_ADVANCE",
  "GLYPH_Y_ADVANCE", "GLYPH_X_OFFSET", "GLYPH_Y_OFFSET",
].map((name) => [name, layoutConstant(`SHAPE_${name}`)])));
const OUTLINE_METADATA = Object.freeze(Object.fromEntries(["SIZE", "UPEM", "HAS_OPSZ", "OPSZ_MINIMUM", "OPSZ_DEFAULT",
  "OPSZ_MAXIMUM"].map((name) => [name, layoutConstant(`OUTLINE_METADATA_${name}`)])));

const textEncoder = new TextEncoder();

// Byte marshalling only. HarfBuzz calls, glyph collection, and outline encoding live in WAT.
export function createShapingRuntime({
  engine: suppliedEngine = null,
  core = suppliedEngine?.core ?? new DomCore(),
} = {}) {
  let engine = suppliedEngine;
  let loading = null;

  async function preload() {
    if (!engine) {
      loading ??= loadEngine({ core });
      engine = await loading;
    }
    return engine;
  }

  function allocate(byteLength) {
    if (byteLength === 0) return 0;
    const pointer = engine.exports.abi_malloc(byteLength);
    if (pointer === 0) {
      throw new RangeError(`Native font transport allocation failed for ${byteLength} bytes; reduce the request size`);
    }
    return pointer;
  }

  function fontIndexFor(fontBytes, faceIndex, mode) {
    if (Number.isInteger(fontBytes)) return fontBytes;
    if (!(fontBytes instanceof Uint8Array)) {
      throw new TypeError("Native font operations require a registered font index or Uint8Array font bytes");
    }
    return acquireFontByteSource(core, fontBytes, "font_outline_acquire", [
      typeof faceIndex === "number" ? faceIndex : 0,
      faceIndex === undefined ? OPTIONAL_ABSENT : typeof faceIndex === "number" ? OPTIONAL_PRESENT : OPTIONAL_OTHER,
      mode,
    ]);
  }

  function encodeTags(records, features = false) {
    const pointer = allocate(records.length * FONT_TAG.SIZE);
    try {
      const view = new DataView(engine.memory.buffer);
      for (let index = 0; index < records.length; index++) {
        const [tag, value] = records[index];
        const offset = pointer + index * FONT_TAG.SIZE;
        const string = typeof tag === "string";
        const number = typeof value === "number";
        for (let unit = 0; unit < 4; unit++) {
          view.setUint16(offset + FONT_TAG.UNITS + unit * Uint16Array.BYTES_PER_ELEMENT, string ? tag.charCodeAt(unit) : 0, true);
        }
        view.setUint32(offset + FONT_TAG.LENGTH, string ? tag.length : 0, true);
        view.setUint32(offset + FONT_TAG.TYPES, (string ? FONT_TAG.STRING : 0) | (number ? FONT_TAG.NUMBER : 0), true);
        view.setFloat64(offset + FONT_TAG.VALUE, number ? value : NaN, true);
      }
      core.status("font_tags_encode", pointer, records.length, Number(features));
      return pointer;
    } catch (error) {
      engine.exports.abi_free(pointer);
      throw error;
    }
  }

  async function shapeFontText(fontBytes, text, _fontSize, {
    variations = [], features = [], unitScale, faceIndex,
  } = {}) {
    unitScale = core.status("font_shape_scale", typeof unitScale === "number" ? unitScale : 0,
      unitScale === undefined ? OPTIONAL_ABSENT : typeof unitScale === "number" ? OPTIONAL_PRESENT : OPTIONAL_OTHER);
    await preload();
    const fontIndex = fontIndexFor(fontBytes, faceIndex, 0);
    const encodedText = textEncoder.encode(text);
    let textPointer = 0;
    let variationPointer = 0;
    let featurePointer = 0;
    let outputPointer = 0;
    try {
      textPointer = allocate(encodedText.length);
      new Uint8Array(engine.memory.buffer, textPointer, encodedText.length).set(encodedText);
      variationPointer = encodeTags(variations);
      featurePointer = encodeTags(features, true);
      outputPointer = engine.exports.font_shape_text(fontIndex, textPointer, encodedText.length,
        variationPointer, variations.length, featurePointer, features.length, unitScale, 0);
      const view = new DataView(engine.memory.buffer);
      const count = view.getUint32(outputPointer + SHAPE.RESULT_COUNT, true);
      const glyphs = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = outputPointer + SHAPE.RESULT_GLYPHS + index * SHAPE.GLYPH_SIZE;
        glyphs[index] = {
          g: view.getUint32(row + SHAPE.GLYPH_ID, true), cl: view.getUint32(row + SHAPE.GLYPH_CLUSTER, true),
          ax: view.getInt32(row + SHAPE.GLYPH_X_ADVANCE, true), ay: view.getInt32(row + SHAPE.GLYPH_Y_ADVANCE, true),
          dx: view.getInt32(row + SHAPE.GLYPH_X_OFFSET, true), dy: view.getInt32(row + SHAPE.GLYPH_Y_OFFSET, true),
        };
      }
      return { glyphs, upem: view.getUint32(outputPointer + SHAPE.RESULT_UPEM, true) };
    } finally {
      engine.exports.abi_free(outputPointer);
      engine.exports.abi_free(featurePointer);
      engine.exports.abi_free(variationPointer);
      engine.exports.abi_free(textPointer);
    }
  }

  function shapeGlyphIds(fontIndex, text, variations = []) {
    if (!engine) throw new Error("Native glyph shaping requires preload before synchronous use");
    const encodedText = textEncoder.encode(text);
    let textPointer = 0;
    let variationPointer = 0;
    let outputPointer = 0;
    try {
      textPointer = allocate(encodedText.length);
      new Uint8Array(engine.memory.buffer, textPointer, encodedText.length).set(encodedText);
      variationPointer = encodeTags(variations);
      outputPointer = engine.exports.font_shape_glyph_ids(fontIndex, textPointer, encodedText.length,
        variationPointer, variations.length);
      const count = new DataView(engine.memory.buffer).getUint32(outputPointer + SHAPE.RESULT_COUNT, true);
      return new Uint32Array(engine.memory.buffer, outputPointer + SHAPE.RESULT_GLYPHS, count).slice();
    } finally {
      engine.exports.abi_free(outputPointer);
      engine.exports.abi_free(variationPointer);
      engine.exports.abi_free(textPointer);
    }
  }

  async function createGlyphOutlineSource(fontBytes, { faceIndex } = {}) {
    await preload();
    return createGlyphOutlineSourceSync(fontBytes, { faceIndex });
  }

  function createGlyphOutlineSourceSync(fontBytes, { faceIndex } = {}) {
    if (!engine) throw new Error("Native glyph outlines require preload before synchronous use");
    const fontIndex = fontIndexFor(fontBytes, faceIndex, 1);
    const metadataPointer = allocate(OUTLINE_METADATA.SIZE);
    engine.exports.font_outline_metadata(fontIndex, metadataPointer);
    const metadata = new DataView(engine.memory.buffer, metadataPointer, OUTLINE_METADATA.SIZE);
    const upem = metadata.getUint32(OUTLINE_METADATA.UPEM, true);
    const opszAxis = metadata.getUint32(OUTLINE_METADATA.HAS_OPSZ, true) === 0 ? null : {
      min: metadata.getFloat32(OUTLINE_METADATA.OPSZ_MINIMUM, true),
      default: metadata.getFloat32(OUTLINE_METADATA.OPSZ_DEFAULT, true),
      max: metadata.getFloat32(OUTLINE_METADATA.OPSZ_MAXIMUM, true),
    };
    let active = true;
    return {
      upem, opszAxis, fontIndex,
      createFont(variations = []) {
        if (!active) throw new Error("Cannot create an outline font after releasing its source");
        const variationPointer = encodeTags(variations);
        let font;
        try {
          font = engine.exports.glyph_outline_font_create(fontIndex, variationPointer, variations.length, true);
        } finally {
          engine.exports.abi_free(variationPointer);
        }
        return {
          glyphOutline(glyphId) {
            if (!font) throw new Error("Cannot extract an outline after releasing its font");
            const pointer = engine.exports.glyph_outline_extract(font, glyphId);
            const length = engine.exports.glyph_outline_length();
            // The native collector reuses its buffer. Own this span before any generator await.
            const verbs = new Uint8Array(engine.memory.buffer, pointer, length).slice();
            return { verbs, advance: engine.exports.glyph_outline_advance() };
          },
          destroy() {
            if (font) engine.exports.glyph_outline_font_destroy(font);
            font = 0;
          },
        };
      },
      destroy() {
        if (active) engine.exports.abi_free(metadataPointer);
        active = false;
      },
    };
  }

  return Object.freeze({ preload, shapeFontText, shapeGlyphIds, createGlyphOutlineSource, createGlyphOutlineSourceSync,
    instanceIdentity: () => engine?.hb ?? null,
  });
}

const defaultShapingRuntime = createShapingRuntime({ core: sharedDomCore });
export const shapeFontText = (...arguments_) => defaultShapingRuntime.shapeFontText(...arguments_);
export const createGlyphOutlineSource = (...arguments_) => defaultShapingRuntime.createGlyphOutlineSource(...arguments_);
