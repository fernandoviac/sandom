import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { acquireFontByteSource } from "./dom-wasm/font-byte-binding.js";
import { loadEngine } from "./wasm/loader.js";

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
      faceIndex === undefined ? 0 : typeof faceIndex === "number" ? 1 : 2,
      mode,
    ]);
  }

  function encodeTags(records, features = false) {
    const pointer = allocate(records.length * 24);
    try {
      const view = new DataView(engine.memory.buffer);
      for (let index = 0; index < records.length; index++) {
        const [tag, value] = records[index];
        const offset = pointer + index * 24;
        const string = typeof tag === "string";
        const number = typeof value === "number";
        for (let unit = 0; unit < 4; unit++) {
          view.setUint16(offset + unit * 2, string ? tag.charCodeAt(unit) : 0, true);
        }
        view.setUint32(offset + 8, string ? tag.length : 0, true);
        view.setUint32(offset + 12, Number(string) | (Number(number) << 1), true);
        view.setFloat64(offset + 16, number ? value : NaN, true);
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
      unitScale === undefined ? 0 : typeof unitScale === "number" ? 1 : 2);
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
      const count = view.getUint32(outputPointer, true);
      const glyphs = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = outputPointer + 8 + index * 24;
        glyphs[index] = {
          g: view.getUint32(row, true), cl: view.getUint32(row + 4, true),
          ax: view.getInt32(row + 8, true), ay: view.getInt32(row + 12, true),
          dx: view.getInt32(row + 16, true), dy: view.getInt32(row + 20, true),
        };
      }
      return { glyphs, upem: view.getUint32(outputPointer + 4, true) };
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
      const count = new DataView(engine.memory.buffer).getUint32(outputPointer, true);
      return new Uint32Array(engine.memory.buffer, outputPointer + 8, count).slice();
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
    const metadataPointer = allocate(20);
    engine.exports.font_outline_metadata(fontIndex, metadataPointer);
    const metadata = new DataView(engine.memory.buffer, metadataPointer, 20);
    const upem = metadata.getUint32(0, true);
    const opszAxis = metadata.getUint32(4, true) === 0 ? null : {
      min: metadata.getFloat32(8, true), default: metadata.getFloat32(12, true), max: metadata.getFloat32(16, true),
    };
    let active = true;
    return {
      upem, opszAxis, fontIndex,
      createFont(variations = []) {
        if (!active) throw new Error("Cannot create an outline font after releasing its source");
        const variationPointer = encodeTags(variations);
        let font;
        try {
          font = engine.exports.glyph_outline_font_create(fontIndex, variationPointer, variations.length, 1);
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

  // The outlines of `glyphIds` of the registered font `fontIndex` at
  // `variations`, as glyph_outline_extract's verb streams. Synchronous: it
  // needs an engine that is already loaded, as the renderer's is when it
  // has shaped the glyphs (Canvas 2D text, src/dom/canvas-2d-text.js).
  function glyphOutlinesSync(fontIndex, variations, glyphIds) {
    if (!engine) throw new Error("glyphOutlinesSync needs a loaded engine");
    const variationPointer = encodeTags(variations);
    let font;
    try {
      font = engine.exports.glyph_outline_font_create(fontIndex, variationPointer, variations.length, 1);
    } finally {
      engine.exports.abi_free(variationPointer);
    }
    try {
      return glyphIds.map((glyphId) => {
        const pointer = engine.exports.glyph_outline_extract(font, glyphId);
        return new Uint8Array(engine.memory.buffer, pointer, engine.exports.glyph_outline_length()).slice();
      });
    } finally {
      engine.exports.glyph_outline_font_destroy(font);
    }
  }

  return Object.freeze({ preload, shapeFontText, shapeGlyphIds, createGlyphOutlineSource, createGlyphOutlineSourceSync, glyphOutlinesSync,
    instanceIdentity: () => engine?.hb ?? null,
  });
}

const defaultShapingRuntime = createShapingRuntime({ core: sharedDomCore });
export const shapeFontText = (...arguments_) => defaultShapingRuntime.shapeFontText(...arguments_);
export const createGlyphOutlineSource = (...arguments_) => defaultShapingRuntime.createGlyphOutlineSource(...arguments_);
