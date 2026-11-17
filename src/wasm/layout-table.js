// The layout constants of a WebAssembly module, read from its custom
// section "sandom.layout" (plans/PLAN-wat-host-logic-removal.md, "One
// source for each format constant"): u32 row count, then for each row u16
// name length, the UTF-8 name and its f64 value. The module's WAT globals
// are the source; the core build (core/tools/layout-section.js) writes the section
// from them. A host reads each record constant and each code that it
// passes to or reads from WAT by name.
import * as rendererCore from "./renderer-core-binary.js";

let rows = null;

// The build supplies the rows of the sources it composes before it reads
// layout.js, so a changed constant takes effect in the same build.
export function useLayoutRows(map) {
  if (rows !== null) throw new Error("The layout rows are already read; supply them before the first layoutConstant()");
  rows = map;
}

function readSection(module, label) {
  const sections = WebAssembly.Module.customSections(module, "sandom.layout");
  if (sections.length !== 1) {
    throw new Error(`${label} has ${sections.length} "sandom.layout" sections; rebuild it with deno task wasm`);
  }
  const view = new DataView(sections[0]);
  const decoder = new TextDecoder();
  const table = new Map();
  let at = 4;
  for (let index = 0; index < view.getUint32(0, true); index++) {
    const length = view.getUint16(at, true);
    const name = decoder.decode(new Uint8Array(sections[0], at + 2, length));
    table.set(name, view.getFloat64(at + 2 + length, true));
    at += 2 + length + 8;
  }
  return table;
}

function constantOf(table, name, label) {
  const value = table.get(name);
  if (value === undefined) {
    throw new Error(`${label} defines no layout constant ${name}; define it as an upper-case i32 global of the component that owns it`);
  }
  return value;
}

// The value of the renderer core's layout constant `name`.
export function layoutConstant(name) {
  rows ??= readSection(rendererCore.getRendererCoreModule(), "renderer-core.wasm");
  return constantOf(rows, name, "renderer-core.wasm");
}

// The layout constants of another module: `binary` is its loader
// (src/wasm/<name>-binary.js) and `label` names it in errors. The result
// reads one constant by name.
export function moduleLayoutConstants(binary, label) {
  const table = readSection(binary.getModule(), label);
  return (name) => constantOf(table, name, label);
}
