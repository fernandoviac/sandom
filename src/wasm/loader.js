// WASM engine loader.
//
// ONE WebAssembly.Memory shared by the renderer core and HarfBuzz
// (design/memory-map.md). The engine's fixed layout owns pages 0–803 and
// never grows; vendor/hb.wasm is linked with IMPORTED_MEMORY, GLOBAL_BASE at
// that boundary and -sMALLOC=none, so its static data and stack occupy
// pages 804–863 and every HarfBuzz allocation comes from the DOM core's
// allocator; the DOM core owns pages 864 upward and is the ONLY grower.
// Renderer-core calls HarfBuzz through its native function table, and
// HarfBuzz calls the DOM allocator directly: pointers are plain offsets
// into the one shared memory.
//
// Growth detaches every ArrayBuffer view over the shared memory. The one
// refresh rule: the DOM core reports growth synchronously after the
// growing call (src/dom-wasm/core.js observeMemoryGrowth); every module
// holding a long-lived view registers one listener (this loader's own
// bytes/u32/f32, src/scene-renderer.js, src/animations.js).

import { readPackageAsset } from '../package-assets.js';
import { createTextPreparationRuntime } from '../text-preparation.js';
import { createAllocatorCore, observeMemoryGrowth } from '../dom-wasm/core.js';
import {
  ACTUAL_INITIAL_PAGES,
  HB_INITIAL_PAGES,
  verifyLayout,
} from './layout.js';

// The HarfBuzz static-data base baked into vendor/hb.wasm at link time
// (-sGLOBAL_BASE). MUST equal the layout reservation boundary; the
// assertion in loadEngine rejects a drifted rebuild before either module
// initializer runs.
export const HB_BASE_BYTES = ACTUAL_INITIAL_PAGES * 65536;

// The engine's fail-loud nets are `unreachable`, which carries no message:
// a caller saw only `RuntimeError: unreachable` and had to disassemble the
// wasm offsets to learn which guard fired (that is how
// BUG-exclusion-level-capacity-trap and
// BUG-element-from-point-traps-on-live-document were filed — same
// signature, no name; both resolved, see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md). The engine
// writes $trapSite plus, for a capacity
// net, the observed value and the budget it exceeded; the layout entry
// points read them back out here and rethrow a named error. Keep in step
// with $trapSite's own doc comment in engine.wat.
const TRAP_SITE_NAMES = new Map([
  [1, "corrective relayout re-derived a different gap"],
  [2, "vertical-fit retry budget (first loop)"],
  [3, "vertical-fit retry budget (separated-stage loop)"],
  [4, "BFC level stack exhausted and ungrowable"],
  [5, "exclusions per BFC level exhausted"],
  [6, "no next float edge below the probe"],
  [7, "shelf index past the rebuilt shelf list"],
  [8, "no next shelf edge below the probe"],
  [9, "glyph buffer exhausted"],
  [10, "inline-state scratch exhausted"],
  [11, "flex items past this level's record budget"],
  [12, "flex scratch ungrowable"],
  [13, "layout-cache hit on a collapsed table with moved pristine positions"],
  [14, "multi-column fragment pool exhausted"],
  [15, "color glyph paint operation without a command"],
  [16, "command space exhausted: a command writer needs more bytes than the command buffer (or the stream it writes) holds"],
  [17, "color glyph path slots exhausted"],
  [18, "color glyph bitmap slots exhausted"],
  [19, "page break state ungrowable"],
  [20, "page made no progress: it ends at the break it started from"],
  [21, "page groups nested past the page group limit"],
  [22, "a box's face is not in the font table; register its face with register_font"],
  [23, "a table has more columns than u16 column indices hold; split the table"],
  [24, "the allocator refused the table scratch for the largest table; free memory or split the table"],
  [25, "a table has more rows than u16 row ordinals hold; split the table"],
  [27, "a table is larger than the table scratch that layout entry sized ($tableScratchEnsure missed it)"],
  [28, "a collapsed-border table needs more edge records than the collapsed arena holds; reserve more node tables"],
  [29, "the paint walk nested past the scroll save stack's frames; the page nests too many clipping or scrolling boxes"],
]);

// Trap site 15 carries the glyph in trap_value and the operation in
// trap_limit (engine-color-glyph.watpart $COLOR_GLYPH_OP_*): from 100 a
// composite mode, from 356 a CBDT image format, 400 an sbix graphic type.
const COLOR_GLYPH_OPERATION_NAMES = new Map([
  [3, "color without a clip glyph"],
  [4, "gradient without a clip glyph"],
  [5, "radial_gradient"],
  [6, "sweep_gradient"],
  [7, "image"],
  [8, "unbalanced transform, clip or group"],
]);
const COMPOSITE_MODE_NAMES = [
  "CLEAR", "SRC", "DEST", "SRC_OVER", "DEST_OVER", "SRC_IN", "DEST_IN", "SRC_OUT",
  "DEST_OUT", "SRC_ATOP", "DEST_ATOP", "XOR", "PLUS", "SCREEN", "OVERLAY", "DARKEN",
  "LIGHTEN", "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT", "SOFT_LIGHT", "DIFFERENCE",
  "EXCLUSION", "MULTIPLY", "HSL_HUE", "HSL_SATURATION", "HSL_COLOR", "HSL_LUMINOSITY",
];

function trapMessage(name, site, observed, limit) {
  if (site === 22) {
    return `sandom engine trap in ${name}: a box's face is font index ${observed}, ` +
      `but the font table holds ${limit} face(s); register the face with register_font (trap site 22)`;
  }
  if (site === 15) {
    const operation = limit === 400
      ? "an sbix graphic type other than 'png ' (and 'dupe')"
      : limit >= 356
      ? `CBDT image format ${limit - 356} (only the PNG formats 17, 18 and 19 have a command)`
      : limit >= 100
      ? `pop_group with composite mode ${COMPOSITE_MODE_NAMES[limit - 100] ?? limit - 100}`
      : COLOR_GLYPH_OPERATION_NAMES.get(limit) ?? `operation ${limit}`;
    return `sandom engine trap in ${name}: color glyph ${observed} paints ${operation}, ` +
      "which no command expresses (trap site 15); see plans/text/PLAN-color-glyphs.md";
  }
  return `sandom engine trap in ${name}: ${
    TRAP_SITE_NAMES.get(site) ?? "unnamed guard"
  } (trap site ${site}${
    limit === 0 ? "" : `, observed ${observed}, budget ${limit}`
  })`;
}

function attributeEngineTraps(exports) {
  const attributed = { ...exports };
  for (const name of ["layout", "emit_commands", "scene_layout", "scene_emit_commands", "page_advance"]) {
    const call = exports[name];
    attributed[name] = function () {
      try {
        return call.apply(null, arguments);
      } catch (error) {
        if (!(error instanceof WebAssembly.RuntimeError)) throw error;
        const site = exports.trap_site();
        if (site === 0) throw error;
        const observed = exports.trap_value();
        const limit = exports.trap_limit();
        throw new Error(trapMessage(name, site, observed, limit), { cause: error });
      }
    };
  }
  return Object.freeze(attributed);
}

// hb.wasm is a full Emscripten build without an allocator, so it needs the
// handful of runtime imports Emscripten always generates (proc_exit,
// timers, abort) plus the C allocator, which the DOM core exports.
export function makeHbImports(memory, allocator) {
  const timers = {};
  return {
    wasi_snapshot_preview1: {
      proc_exit: (code) => { throw new Error(`hb.wasm proc_exit(${code})`); },
    },
    env: {
      memory,
      malloc: allocator.abi_malloc,
      free: allocator.abi_free,
      calloc: allocator.abi_calloc,
      realloc: allocator.abi_realloc,
      _abort_js: () => { throw new Error('hb.wasm aborted'); },
      _emscripten_runtime_keepalive_clear: () => {},
      _setitimer_js: (which, timeoutMs) => {
        if (timers[which]) { clearTimeout(timers[which]); delete timers[which]; }
        if (!timeoutMs) return 0;
        timers[which] = setTimeout(() => { delete timers[which]; }, timeoutMs);
        return 0;
      },
    },
  };
}

// Links an hb.wasm instance to renderer-core exports, from the interface the
// core publishes itself: renderer_hb_names names the hb.wasm export of each
// renderer_hb_table entry, and harfbuzz_callback_table holds the core
// functions HarfBuzz calls back. Returns the HarfBuzz function-table index of
// the first callback, for harfbuzz_callbacks_initialize after init.
export function linkHarfBuzz(coreExports, hb, memory) {
  const count = coreExports.renderer_hb_names();
  const names = new TextDecoder().decode(new Uint8Array(memory.buffer,
    coreExports.abi_output_pointer(), coreExports.abi_output_length())).split("\0");
  if (names.length !== count) {
    throw new Error(`renderer_hb_names lists ${names.length} names for ${count} renderer_hb_table entries`);
  }
  for (const [index, name] of names.entries()) {
    const binding = hb.exports[name];
    if (typeof binding !== "function") throw new Error(`vendor/hb.wasm does not export ${name}, renderer_hb_table entry ${index}`);
    coreExports.renderer_hb_table.set(index, binding);
  }
  const callbacks = coreExports.harfbuzz_callback_table;
  const hbTable = hb.exports.__indirect_function_table;
  const base = hbTable.length;
  hbTable.grow(callbacks.length);
  for (let index = 0; index < callbacks.length; index++) hbTable.set(base + index, callbacks.get(index));
  return base;
}

export async function loadHb(memory, allocator, harfbuzzBytes) {
  const wasmBytes = harfbuzzBytes ??
    globalThis[Symbol.for('sandom.hbBytes')] ??
    await readPackageAsset(new URL('../../vendor/hb.wasm', import.meta.url));

  const module = await WebAssembly.compile(
    wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes),
  );
  const imports = WebAssembly.Module.imports(module);
  const memoryImports = imports.filter((entry) => entry.kind === 'memory');
  if (memoryImports.length !== 1) {
    throw new Error(
      `vendor/hb.wasm must import exactly one memory (found ${memoryImports.length}) — rebuild it with -sIMPORTED_MEMORY (vendor/README-hb-wasm.md)`,
    );
  }
  if (imports.some((entry) => entry.name === 'emscripten_resize_heap')) {
    throw new Error(
      'vendor/hb.wasm carries its own heap — rebuild it with -sMALLOC=none (vendor/README-hb-wasm.md)',
    );
  }
  const instance = new WebAssembly.Instance(module, makeHbImports(memory, allocator));
  instance.exports.__wasm_call_ctors();
  return instance;
}

// Initialization is owned by the memory, just like the native engine state.
// Retain a failed initialization too: repeating HarfBuzz constructors or
// engine init on partially initialized live memory would corrupt its state.
const engineLoads = new WeakMap();

// The DOM and engine exports belong to the same instance. HarfBuzz is linked
// once to that instance's raw allocator and called through its native table.
export async function loadEngine({ harfbuzzBytes, core = createAllocatorCore() } = {}) {
  const resource = harfbuzzBytes ?? globalThis[Symbol.for('sandom.hbBytes')] ?? null;
  const previous = engineLoads.get(core.memory);
  if (previous) {
    if (previous.core !== core || previous.resource !== resource) {
      throw new TypeError('Renderer core already has an engine with different core or HarfBuzz resources');
    }
    return await previous.promise;
  }
  const promise = initializeEngine(core, resource);
  engineLoads.set(core.memory, { core, resource, promise });
  return await promise;
}

async function initializeEngine(core, harfbuzzBytes) {
  const memory = core.memory;
  if (memory.buffer.byteLength < HB_INITIAL_PAGES * 65536) {
    throw new Error(`shared memory has ${memory.buffer.byteLength} bytes; HarfBuzz needs ${HB_INITIAL_PAGES} pages`);
  }
  // Direct WAT-to-WAT allocator binding: the raw exports, not the
  // growth-observing wrappers. Growth from these paths is observed at the
  // engine or core export the host called into.
  const allocator = core.rawExports;
  const hb = await loadHb(memory, allocator, harfbuzzBytes);

  // Boundary assertion: the allocator serving HarfBuzz must hand out
  // addresses above the layout reservation and HarfBuzz's static pages.
  const probePtr = allocator.abi_malloc(16);
  allocator.abi_free(probePtr);
  if (probePtr < HB_INITIAL_PAGES * 65536) {
    throw new Error(
      `DOM allocator heap starts at ${probePtr}, inside the engine or HarfBuzz reservation (< ${HB_INITIAL_PAGES * 65536}) — design/memory-map.md`,
    );
  }

  const callbackBase = linkHarfBuzz(allocator, hb, memory);
  const observed = observeMemoryGrowth(memory, allocator, () => core.notifyGrowth());
  const measurement = globalThis[Symbol.for("sandom.domCore.measurement")];
  const exports = attributeEngineTraps(
    measurement ? measurement.wrapExports(observed, "engine") : observed,
  );

  exports.init();
  verifyLayout(exports);
  exports.harfbuzz_callbacks_initialize(callbackBase);

  const engine = {
    memory,
    exports,
    bytes: new Uint8Array(memory.buffer),
    u32: new Uint32Array(memory.buffer),
    f32: new Float32Array(memory.buffer),
    hb,
    allocator,
    // The memory's allocator authority; the DOM core itself for the default
    // runtime, so the core can snapshot this engine's buffers in place.
    core,
    // The one refresh rule: register a listener that re-derives every
    // long-lived view over the shared memory. Fired synchronously after
    // the core or engine call that grew it returns. Returns the function
    // that removes the listener (DomCore.onMemoryGrowth).
    onMemoryGrowth(listener) { return core.onMemoryGrowth(listener); },
  };
  core.onMemoryGrowth(() => {
    engine.bytes = new Uint8Array(memory.buffer);
    engine.u32 = new Uint32Array(memory.buffer);
    engine.f32 = new Float32Array(memory.buffer);
  });
  engine.textPreparation = createTextPreparationRuntime(engine);
  return engine;
}
