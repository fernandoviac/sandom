import createMsdfgenModule from "../../vendor/msdfgen.mjs";
import { DomCore } from "../dom-wasm/core.js";
import { readPackageAsset } from "../package-assets.js";
import { loadEngine } from "./loader.js";
import { layoutConstant } from "./layout-table.js";

// The generator output header and metrics block of glyph-atlas.watpart, and
// the four f32 fill bounds that the generator measures for a path.
const MSDF_OUTPUT_WIDTH = layoutConstant("MSDF_OUTPUT_WIDTH");
const MSDF_OUTPUT_HEIGHT = layoutConstant("MSDF_OUTPUT_HEIGHT");
const MSDF_OUTPUT_TEXELS = layoutConstant("MSDF_OUTPUT_TEXELS");
const MSDF_METRICS_SIZE = layoutConstant("MSDF_METRICS_SIZE");
const PATH_FILL_BOUNDS_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;

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
  const generatorMetrics = generator._wasm_alloc(MSDF_METRICS_SIZE);
  const nativeMetrics = native.abi_malloc(MSDF_METRICS_SIZE);
  function output(width, height = width) {
    const bytes = native.atlas_msdf_output_bytes(width, height);
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
    const header = new DataView(generator.HEAPU8.buffer, generatorOutput, MSDF_OUTPUT_TEXELS);
    const bytes = native.atlas_msdf_output_bytes(header.getUint32(MSDF_OUTPUT_WIDTH, true), header.getUint32(MSDF_OUTPUT_HEIGHT, true));
    if (bytes > generatorCapacity) throw new Error(`Generator output ${bytes} exceeds caller span ${generatorCapacity}; repair the generator size contract`);
    if (bytes > nativeCapacity) {
      native.abi_free(nativeOutput);
      nativeOutput = native.abi_malloc(bytes);
      nativeCapacity = bytes;
    }
    new Uint8Array(memory.buffer, nativeOutput, bytes).set(generator.HEAPU8.subarray(generatorOutput, generatorOutput + bytes));
    new Uint8Array(memory.buffer, nativeMetrics, MSDF_METRICS_SIZE)
      .set(generator.HEAPU8.subarray(generatorMetrics, generatorMetrics + MSDF_METRICS_SIZE));
    native.atlas_entry_publish(atlas, slot, nativeOutput, nativeMetrics);
  }
  function insertGlyph(atlas, glyph, weight, optical, size, verbs, length, advance) {
    const slot = native.atlas_glyph_reserve(atlas, glyph, weight, optical, size);
    if (!native.atlas_entry_generation_needed(atlas, slot, 0)) return slot;
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
    if (!native.atlas_entry_generation_needed(atlas, slot, 0)) return slot;
    native.atlas_entry_publish_prepared(atlas, slot, prepared, length, advance);
    return slot;
  }
  function hydrateGlyph(atlas, glyph, weight, optical, size, prepared, length, advance) {
    const slot = native.atlas_lookup_glyph(atlas, glyph, weight, optical, size);
    if (!native.atlas_entry_generation_needed(atlas, slot, 1)) return slot;
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
    if (!native.atlas_entry_generation_needed(atlas, slot, 0)) return slot;
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
  // Publishes the device raster that the generator wrote for device index
  // `index` as its tiles that hold coverage, each its own atlas entry
  // (atlas_path_device_tile_find), and records them in the core
  // (svg_path_device_tiles_set): a thin stroke across a large path covers
  // a small part of its raster's bounds. Returns the tiles' slots.
  function publishDeviceTiles(atlas, index) {
    const tile = native.svg_path_device_tile_size();
    const header = new DataView(generator.HEAPU8.buffer, generatorOutput, MSDF_OUTPUT_TEXELS);
    const width = header.getUint32(MSDF_OUTPUT_WIDTH, true);
    const height = header.getUint32(MSDF_OUTPUT_HEIGHT, true);
    const pixels = generator.HEAPU8.subarray(generatorOutput + MSDF_OUTPUT_TEXELS, generatorOutput + MSDF_OUTPUT_TEXELS + width * height * 3);
    const tileBytes = native.atlas_msdf_output_bytes(tile, tile);
    if (tileBytes > nativeCapacity) {
      native.abi_free(nativeOutput);
      nativeOutput = native.abi_malloc(tileBytes);
      nativeCapacity = tileBytes;
    }
    const codes = [];
    const slots = [];
    for (let tileY = 0; tileY * tile < height; tileY++) {
      const top = tileY * tile;
      const tileHeight = Math.min(tile, height - top);
      for (let tileX = 0; tileX * tile < width; tileX++) {
        const left = tileX * tile;
        const rowBytes = Math.min(tile, width - left) * 3;
        let covered = false;
        for (let row = 0; row < tileHeight && !covered; row++) {
          const start = ((top + row) * width + left) * 3;
          for (let at = start; at < start + rowBytes; at += 3) {
            if (pixels[at] !== 0) { covered = true; break; }
          }
        }
        if (!covered) continue;
        const code = tileX | (tileY << 16);
        const slot = native.atlas_path_device_tile_find(atlas, index, code, 1);
        if (slot < 0) throw new Error(`Path atlas has no room for tile ${tileX},${tileY} of device coverage index ${index}; release unused atlas resources`);
        const view = new DataView(memory.buffer, nativeOutput, tileBytes);
        view.setUint32(MSDF_OUTPUT_WIDTH, rowBytes / 3, true);
        view.setUint32(MSDF_OUTPUT_HEIGHT, tileHeight, true);
        const target = new Uint8Array(memory.buffer, nativeOutput + MSDF_OUTPUT_TEXELS, rowBytes * tileHeight);
        for (let row = 0; row < tileHeight; row++) {
          const start = ((top + row) * width + left) * 3;
          target.set(pixels.subarray(start, start + rowBytes), row * rowBytes);
        }
        const metrics = new Float32Array(memory.buffer, nativeMetrics, MSDF_METRICS_SIZE / 4);
        metrics.set(new Float32Array(generator.HEAPU8.buffer, generatorMetrics, MSDF_METRICS_SIZE / 4));
        metrics[5] = rowBytes / 3; metrics[6] = tileHeight; metrics[7] = rowBytes / 3; metrics[8] = tileHeight;
        native.atlas_entry_publish(atlas, slot, nativeOutput, nativeMetrics);
        codes.push(code);
        slots.push(slot);
      }
    }
    const codesPointer = native.abi_malloc(Math.max(4, codes.length * 4));
    try {
      new Uint32Array(memory.buffer, codesPointer, codes.length).set(codes);
      if (!native.svg_path_device_tiles_set(index, codesPointer, codes.length)) {
        throw new Error(`The core refused the ${codes.length} tiles of device coverage index ${index}`);
      }
    } finally {
      native.abi_free(codesPointer);
    }
    return slots;
  }
  // A device coverage entry (core/dom/path-device-coverage.watpart): the
  // stroke of the path that device index `index` names, filled into a
  // width × height raster under `matrix` (six f32 values from the core's
  // definition), and its non-scaling stroke scale (device pixels per host
  // pixel for a non-scaling stroke, else 0). Returns the slots of its
  // covered tiles.
  function ensureDevicePath(atlas, index, path, length, strokeWidth, cap, join, miter, dashes, dashCount, phase, matrix, width, height,
    nonScalingStrokeScale) {
    const source = input(path, length);
    const dashSource = dashCount ? input(dashes, dashCount * 4) : 0;
    const matrixSource = generator._wasm_alloc(24);
    try {
      generator.HEAPF32.set(matrix, matrixSource / 4);
      generator._generate_path_stroke_device_coverage(source, length, strokeWidth, cap, join, miter, dashSource, dashCount, phase,
        matrixSource, width, height, output(width, height), generatorMetrics, nonScalingStrokeScale);
      return publishDeviceTiles(atlas, index);
    } finally {
      generator._wasm_dealloc(matrixSource, 24);
      if (dashSource) generator._wasm_dealloc(dashSource, dashCount * 4);
      generator._wasm_dealloc(source, length || 1);
    }
  }
  // A device coverage entry of a fill: the path that device index `index`
  // names, filled with its rule (`evenOdd`) into a width × height raster
  // under `matrix`, for a fill whose parts are thinner than its field holds.
  // Returns the slots of its covered tiles.
  function ensureDeviceFill(atlas, index, path, length, evenOdd, matrix, width, height) {
    const source = input(path, length);
    const matrixSource = generator._wasm_alloc(24);
    try {
      generator.HEAPF32.set(matrix, matrixSource / 4);
      generator._generate_path_fill_device_coverage(source, length, evenOdd, matrixSource, width, height,
        output(width, height), generatorMetrics);
      return publishDeviceTiles(atlas, index);
    } finally {
      generator._wasm_dealloc(matrixSource, 24);
      generator._wasm_dealloc(source, length || 1);
    }
  }
  function lookupPath(...arguments_) {
    return native.atlas_path_find(...arguments_, false);
  }
  function measurePath(path, length, fill, destination) {
    const source = input(path, length);
    try {
      generator._measure_path_fill_bounds(source, length, fill, generatorMetrics);
      new Uint8Array(memory.buffer, destination, PATH_FILL_BOUNDS_BYTES)
        .set(generator.HEAPU8.subarray(generatorMetrics, generatorMetrics + PATH_FILL_BOUNDS_BYTES));
    } finally {
      generator._wasm_dealloc(source, length || 1);
    }
  }
  return Object.freeze({
    engine, exports: native, memory, generator, insertGlyph, insertPreparedGlyph, hydrateGlyph, prepareOutline, ensurePath,
    ensureDevicePath, ensureDeviceFill, lookupPath, measurePath,
  });
}
