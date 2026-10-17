import createMsdfgenModule from "../../vendor/msdfgen.mjs";
import { DomCore } from "../dom-wasm/core.js";
import { readPackageAsset } from "../package-assets.js";
import { loadEngine } from "./loader.js";

// The two modules own separate memories. This binding transports bounded input
// and output spans; keys, budgets, placements and publication belong to WAT.
export async function createAtlasDriver({ engine, msdfgenBytes } = {}) {
  // The engine's shaping and glyph bindings call native font operations
  // through the DOM core binding of its memory.
  engine ??= await loadEngine({ core: new DomCore() });
  const wasmBinary = msdfgenBytes ?? await readPackageAsset(new URL("../../vendor/msdfgen.wasm", import.meta.url));
  const generator = await createMsdfgenModule({
    instantiateWasm(imports, receiveInstance) {
      receiveInstance(new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), imports));
    },
  });
  const native = engine.exports;
  const memory = engine.memory;
  let generatorOutput = 0;
  let generatorCapacity = 0;
  let nativeOutput = 0;
  let nativeCapacity = 0;
  const generatorMetrics = generator._wasm_alloc(36);
  const nativeMetrics = native.abi_malloc(36);
  function output(size) {
    const bytes = 8 + size * size * 3;
    if (bytes > generatorCapacity) {
      if (generatorOutput) generator._wasm_dealloc(generatorOutput, generatorCapacity);
      generatorOutput = generator._wasm_alloc(bytes);
      generatorCapacity = bytes;
    }
    return generatorOutput;
  }
  function input(pointer, length) {
    const destination = generator._wasm_alloc(length || 1);
    generator.HEAPU8.set(new Uint8Array(memory.buffer, pointer, length), destination);
    return destination;
  }
  function publish(atlas, slot) {
    const header = new DataView(generator.HEAPU8.buffer, generatorOutput, 8);
    const bytes = 8 + header.getUint32(0, true) * header.getUint32(4, true) * 3;
    if (bytes > generatorCapacity) throw new Error(`Generator output ${bytes} exceeds caller span ${generatorCapacity}; repair the generator size contract`);
    if (bytes > nativeCapacity) {
      native.abi_free(nativeOutput);
      nativeOutput = native.abi_malloc(bytes);
      nativeCapacity = bytes;
    }
    new Uint8Array(memory.buffer, nativeOutput, bytes).set(generator.HEAPU8.subarray(generatorOutput, generatorOutput + bytes));
    new Uint8Array(memory.buffer, nativeMetrics, 36).set(generator.HEAPU8.subarray(generatorMetrics, generatorMetrics + 36));
    native.atlas_entry_publish(atlas, slot, nativeOutput, nativeMetrics);
  }
  function insertGlyph(atlas, glyph, weight, optical, size, verbs, length, advance) {
    const slot = native.atlas_glyph_reserve(atlas, glyph, weight, optical, size);
    if (slot < 0 || native.atlas_entry_ready(atlas, slot)) return slot;
    const source = input(verbs, length);
    try {
      const budget = native.atlas_glyph_msdf_size(atlas, size);
      if (!generator._glyph_msdf_render(source, length, budget, native.atlas_msdf_range(),
        native.atlas_glyph_minimum_shape_units_per_texel(atlas, size), advance, output(budget), generatorMetrics)) {
        throw new Error(`MSDF generation rejected glyph ${glyph} with ${length} outline bytes; supply a valid native outline`);
      }
      publish(atlas, slot);
      return slot;
    } finally {
      generator._wasm_dealloc(source, length || 1);
    }
  }
  function insertPreparedGlyph(atlas, glyph, weight, optical, size, prepared, length, advance) {
    const slot = native.atlas_glyph_reserve(atlas, glyph, weight, optical, size);
    if (slot < 0 || native.atlas_entry_ready(atlas, slot)) return slot;
    native.atlas_entry_publish_prepared(atlas, slot, prepared, length, advance);
    return slot;
  }
  function hydrateGlyph(atlas, glyph, weight, optical, size, prepared, length, advance) {
    const slot = native.atlas_lookup_glyph(atlas, glyph, weight, optical, size);
    if (slot < 0 || native.atlas_entry_has_pixels(atlas, slot)) return slot;
    const source = input(prepared, length);
    try {
      if (!generator._generate_msdf_from_prepared(source, length, advance,
        output(native.atlas_glyph_msdf_size(atlas, size)), generatorMetrics)) {
        throw new Error(`MSDF hydration rejected glyph ${glyph} with ${length} prepared bytes; repair the prepared record`);
      }
      publish(atlas, slot);
      return slot;
    } finally {
      generator._wasm_dealloc(source, length || 1);
    }
  }
  function prepareOutline(verbs, length, size, range, minimumUnits, destination, capacity) {
    const source = input(verbs, length);
    const prepared = generator._wasm_alloc(capacity);
    try {
      const bytes = generator._prepare_outline_msdf_geometry(source, length, size, range, minimumUnits, prepared, capacity);
      if (bytes && bytes <= capacity) {
        new Uint8Array(memory.buffer, destination, bytes).set(generator.HEAPU8.subarray(prepared, prepared + bytes));
      }
      return bytes;
    } finally {
      generator._wasm_dealloc(prepared, capacity);
      generator._wasm_dealloc(source, length || 1);
    }
  }
  function ensurePath(atlas, path, length, fill, screenSize, stroke, width, cap, join, miter, dashes, dashCount, phase, coverage) {
    const slot = native.atlas_path_find(atlas, path, length, fill, screenSize, stroke, width, cap, join, miter, dashes, dashCount, phase, coverage, 1);
    if (slot < 0 || native.atlas_entry_ready(atlas, slot)) return slot;
    const source = input(path, length);
    const dashSource = dashCount ? input(dashes, dashCount * 4) : 0;
    try {
      const size = native.atlas_path_msdf_size(screenSize, coverage);
      const destination = output(size);
      let accepted;
      if (stroke) {
        const render = coverage ? generator._generate_path_stroke_coverage_var : generator._generate_path_stroke_msdf_var;
        accepted = render(source, length, fill, width, cap, join, miter, dashSource, dashCount, phase, size, native.atlas_msdf_range(), destination, generatorMetrics);
      } else {
        const render = coverage ? generator._generate_path_coverage_var : generator._generate_path_msdf_var;
        accepted = render(source, length, fill, size, native.atlas_msdf_range(), destination, generatorMetrics);
      }
      if (!accepted) throw new Error(`Path generator rejected ${length} bytes at ${size} texels; supply valid path geometry`);
      publish(atlas, slot);
      return slot;
    } finally {
      if (dashSource) generator._wasm_dealloc(dashSource, dashCount * 4);
      generator._wasm_dealloc(source, length || 1);
    }
  }
  function lookupPath(...arguments_) {
    return native.atlas_path_find(...arguments_, 0);
  }
  function measurePath(path, length, fill, destination) {
    const source = input(path, length);
    try {
      generator._measure_path_fill_bounds(source, length, fill, generatorMetrics);
      new Uint8Array(memory.buffer, destination, 16).set(generator.HEAPU8.subarray(generatorMetrics, generatorMetrics + 16));
    } finally {
      generator._wasm_dealloc(source, length || 1);
    }
  }
  return Object.freeze({ engine, exports: native, memory, generator, insertGlyph, insertPreparedGlyph, hydrateGlyph, prepareOutline, ensurePath, lookupPath, measurePath });
}
