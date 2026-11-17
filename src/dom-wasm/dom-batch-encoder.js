// Encodes authoring batches (docs/specifications/dom-authoring-bytecode.md)
// from the generated layout.
import {
  DomBatchHeaderSize,
  domBatchLayout,
  writeDomBatchHeader,
} from "./record-readers.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";

export const BATCH_HANDLE_BIT = layoutConstant("DOM_BATCH_HANDLE_BIT");
export const BATCH_NONE = layoutConstant("DOM_BATCH_NONE") >>> 0;

const encoder = new TextEncoder();

// `identifiedNodes`: the handle table holds durable node identifiers
// (node_identifier) instead of node handles, and existing() takes an
// identifier.
export class BatchEncoder {
  constructor({ identifiedNodes = false } = {}) {
    this.flags = identifiedNodes ? domBatchLayout.flags.identifiedNodes : 0;
    this.handles = [];
    this.handleIndices = new Map();
    this.words = [];
    this.operationCount = 0;
    this.localCount = 0;
    this.strings = [];
    this.stringOffsets = new Map();
    this.stringBytes = 0;
    this.fontCatalog = 0n;
  }

  local() {
    return this.localCount++;
  }

  existing(handle) {
    const entry = BigInt(handle);
    let index = this.handleIndices.get(entry);
    if (index === undefined) {
      index = this.handles.length;
      this.handles.push(entry);
      this.handleIndices.set(entry, index);
    }
    return (BATCH_HANDLE_BIT | index) >>> 0;
  }

  string(value) {
    let offset = this.stringOffsets.get(value);
    const bytes = encoder.encode(value);
    if (offset === undefined) {
      offset = this.stringBytes;
      this.strings.push(bytes);
      this.stringOffsets.set(value, offset);
      this.stringBytes += bytes.byteLength;
    }
    return [offset, bytes.byteLength];
  }

  // An index-path operand: the u32 indices in the string arena, then
  // their offset and count.
  indexPath(indices) {
    const bytes = new Uint8Array(indices.length * 4);
    const view = new DataView(bytes.buffer);
    indices.forEach((index, position) => view.setUint32(position * 4, index, true));
    const offset = this.stringBytes;
    this.strings.push(bytes);
    this.stringBytes += bytes.byteLength;
    return [offset, indices.length];
  }

  // Appends one record. A string operand is a JavaScript string, an
  // index-path operand an array of indices; every other operand is the
  // encoded u32.
  operation(name, ...operands) {
    const opcode = domBatchLayout.opcodes[name];
    if (!opcode) throw new Error(`unknown batch opcode ${name}`);
    if (operands.length !== opcode.operands.length) {
      throw new Error(`${name} takes ${opcode.operands.length} operands, not ${operands.length}`);
    }
    this.words.push((opcode.code | (opcode.bytes << 16)) >>> 0);
    opcode.operands.forEach((kind, index) => {
      if (kind === "string") this.words.push(...this.string(operands[index]));
      else if (kind === "index-path") this.words.push(...this.indexPath(operands[index]));
      else this.words.push(operands[index] >>> 0);
    });
    this.operationCount++;
    return this;
  }

  encode() {
    const operationBytes = this.words.length * 4;
    const length = DomBatchHeaderSize + this.handles.length * 8 + operationBytes + this.stringBytes;
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    writeDomBatchHeader(view, 0, {
      magic: domBatchLayout.magic,
      version: domBatchLayout.version,
      headerBytes: DomBatchHeaderSize,
      flags: this.flags,
      handleCount: this.handles.length,
      localCount: this.localCount,
      operationCount: this.operationCount,
      operationBytes,
      stringBytes: this.stringBytes,
      fontCatalog: this.fontCatalog,
    });
    let offset = DomBatchHeaderSize;
    for (const handle of this.handles) {
      view.setBigUint64(offset, handle, true);
      offset += 8;
    }
    for (const word of this.words) {
      view.setUint32(offset, word, true);
      offset += 4;
    }
    for (const string of this.strings) {
      bytes.set(string, offset);
      offset += string.byteLength;
    }
    return bytes;
  }
}
