// The host transports reviewed WGSL bytes and constants. Renderer-core owns
// fragment selection, Canvas variants, substitution, and immutable results.
import { SHADER_SOURCES } from "./sources.js";
import { instantiateRendererCore } from "../wasm/renderer-core-binary.js";
import { layoutConstant } from "../wasm/layout-table.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sources = Object.entries(SHADER_SOURCES).map(([name, source]) => [encoder.encode(name), encoder.encode(source)]);
const libraries = new WeakMap();
let defaultCore;
// The shader composition records (gpu-shaders.watpart SHADER_*), keyed by
// their name without the prefix.
const SHADER = Object.freeze(Object.fromEntries([
  "ENTRY_SIZE", "ENTRY_NAME", "ENTRY_NAME_LENGTH", "ENTRY_VALUE", "ENTRY_VALUE_LENGTH",
  "LIBRARY_NAMES", "LIBRARY_NAME_COUNT", "LIBRARY_ERROR", "LIBRARY_ERROR_SUBJECT", "LIBRARY_ERROR_SUBJECT_LENGTH",
  "CODE", "CODE_LENGTH", "NAME_SIZE", "NAME_POINTER", "NAME_LENGTH",
  "ERROR_UNKNOWN_SHADER", "ERROR_MISSING_SOURCE", "ERROR_UNRESOLVED_PLACEHOLDER",
].map((name) => [name, layoutConstant(`SHADER_${name}`)])));

function writeEntries(core, entries, prefix = new Uint8Array(0)) {
  const prefixLength = (prefix.length + 3) & ~3;
  const tableLength = entries.length * SHADER.ENTRY_SIZE;
  const length = prefixLength + tableLength + entries.reduce((sum, [name, value]) => sum + name.length + value.length, 0);
  // A retained block: the library owns its source table until
  // gpu_shaders_destroy frees it, and a composition input is freed below.
  // A transient abi_allocate block would also be freed at the next DOM core
  // operation, a second free of memory that another owner then holds.
  const pointer = core.abi_malloc(length);
  if (pointer === 0) throw new Error(`renderer-core could not allocate ${length} bytes of shader input`);
  const bytes = new Uint8Array(core.memory.buffer);
  const view = new DataView(core.memory.buffer);
  bytes.set(prefix, pointer);
  let offset = pointer + prefixLength + tableLength;
  for (let index = 0; index < entries.length; index++) {
    const [name, value] = entries[index];
    const entry = pointer + prefixLength + index * SHADER.ENTRY_SIZE;
    view.setUint32(entry + SHADER.ENTRY_NAME, offset, true);
    view.setUint32(entry + SHADER.ENTRY_NAME_LENGTH, name.length, true);
    view.setUint32(entry + SHADER.ENTRY_VALUE, offset + name.length, true);
    view.setUint32(entry + SHADER.ENTRY_VALUE_LENGTH, value.length, true);
    bytes.set(name, offset);
    offset += name.length;
    bytes.set(value, offset);
    offset += value.length;
  }
  return { pointer, table: pointer + prefixLength };
}

function compositionError(core, state, name) {
  const view = new DataView(core.memory.buffer);
  const status = view.getUint32(state + SHADER.LIBRARY_ERROR, true);
  if (status === 0) return;
  const subject = decoder.decode(new Uint8Array(core.memory.buffer, view.getUint32(state + SHADER.LIBRARY_ERROR_SUBJECT, true),
    view.getUint32(state + SHADER.LIBRARY_ERROR_SUBJECT_LENGTH, true)));
  if (status === SHADER.ERROR_UNKNOWN_SHADER) throw new RangeError(`unknown shader ${JSON.stringify(subject)}`);
  if (status === SHADER.ERROR_MISSING_SOURCE) {
    throw new Error(`shader source is missing ${subject}; restore the WGSL source and rebuild its embedding`);
  }
  if (status === SHADER.ERROR_UNRESOLVED_PLACEHOLDER) throw new Error(`shader ${name} has unresolved placeholder ${subject}`);
  throw new Error(`shader composition status ${status} is unknown; update the host and renderer-core together`);
}

export function shaderLibraryFor(core) {
  let state = libraries.get(core);
  if (state !== undefined) return state;
  const input = writeEntries(core, sources);
  state = core.gpu_shaders_create(input.pointer, sources.length);
  try {
    compositionError(core, state, "");
  } catch (error) {
    core.gpu_shaders_destroy(state);
    throw error;
  }
  libraries.set(core, state);
  return state;
}

export function composeShaderBytes(core, name, constants = {}) {
  const state = shaderLibraryFor(core);
  const nameBytes = encoder.encode(name);
  const entries = Object.entries(constants).map(([key, value]) => [encoder.encode(key), encoder.encode(String(value))]);
  const input = writeEntries(core, entries, nameBytes);
  try {
    const identity = core.gpu_shader_compose(state, input.pointer, nameBytes.length, input.table, entries.length);
    compositionError(core, state, name);
    const view = new DataView(core.memory.buffer);
    return { identity, pointer: view.getUint32(identity + SHADER.CODE, true), length: view.getUint32(identity + SHADER.CODE_LENGTH, true) };
  } finally {
    core.abi_free(input.pointer);
  }
}

function sharedCore() {
  return defaultCore ??= instantiateRendererCore().exports;
}

export function composeShader(name, constants = {}) {
  const core = sharedCore();
  const { pointer, length } = composeShaderBytes(core, name, constants);
  return decoder.decode(new Uint8Array(core.memory.buffer, pointer, length));
}

function names() {
  const core = sharedCore();
  const state = shaderLibraryFor(core);
  const view = new DataView(core.memory.buffer);
  const table = view.getUint32(state + SHADER.LIBRARY_NAMES, true);
  return Array.from({ length: view.getUint32(state + SHADER.LIBRARY_NAME_COUNT, true) }, (_, index) => {
    const row = table + index * SHADER.NAME_SIZE;
    return decoder.decode(new Uint8Array(core.memory.buffer, view.getUint32(row + SHADER.NAME_POINTER, true),
      view.getUint32(row + SHADER.NAME_LENGTH, true)));
  });
}

export const shaderNames = Object.freeze(names());
