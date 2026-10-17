// The host transports reviewed WGSL bytes and constants. Renderer-core owns
// fragment selection, Canvas variants, substitution, and immutable results.
import { SHADER_SOURCES } from "./sources.js";
import { instantiateRendererCore } from "../wasm/renderer-core-binary.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sources = Object.entries(SHADER_SOURCES).map(([name, source]) => [encoder.encode(name), encoder.encode(source)]);
const libraries = new WeakMap();
let defaultCore;

function writeEntries(core, entries, prefix = new Uint8Array(0)) {
  const prefixLength = (prefix.length + 3) & ~3;
  const tableLength = entries.length * 16;
  const length = prefixLength + tableLength + entries.reduce((sum, [name, value]) => sum + name.length + value.length, 0);
  const pointer = core.abi_allocate(length);
  const bytes = new Uint8Array(core.memory.buffer);
  const words = new Uint32Array(core.memory.buffer, pointer + prefixLength, entries.length * 4);
  bytes.set(prefix, pointer);
  let offset = pointer + prefixLength + tableLength;
  for (let index = 0; index < entries.length; index++) {
    const [name, value] = entries[index];
    words.set([offset, name.length, offset + name.length, value.length], index * 4);
    bytes.set(name, offset);
    offset += name.length;
    bytes.set(value, offset);
    offset += value.length;
  }
  return { pointer, table: pointer + prefixLength };
}

function compositionError(core, state, name) {
  const fields = new Uint32Array(core.memory.buffer, state + 40, 3);
  if (fields[0] === 0) return;
  const subject = decoder.decode(new Uint8Array(core.memory.buffer, fields[1], fields[2]));
  if (fields[0] === 1) throw new RangeError(`unknown shader ${JSON.stringify(subject)}`);
  if (fields[0] === 2) throw new Error(`shader source is missing ${subject}; restore the WGSL source and rebuild its embedding`);
  if (fields[0] === 3) throw new Error(`shader ${name} has unresolved placeholder ${subject}`);
  throw new Error(`shader composition status ${fields[0]} is unknown; update the host and renderer-core together`);
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
    const span = new Uint32Array(core.memory.buffer, identity + 20, 2);
    return { identity, pointer: span[0], length: span[1] };
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
  const fields = new Uint32Array(core.memory.buffer, state + 12, 2);
  const entries = new Uint32Array(core.memory.buffer, fields[0], fields[1] * 2);
  return Array.from({ length: fields[1] }, (_, index) =>
    decoder.decode(new Uint8Array(core.memory.buffer, entries[index * 2], entries[index * 2 + 1])));
}

export const shaderNames = Object.freeze(names());
