// Handwritten binding for path-stroke-interface.json.
export const ABI_VERSION = 1;
export const ALIGNMENT = 8;
export const FLAG_PRESENT = 1;
export const FLAG_WIDTH = 2;
export const FLAG_CAP = 4;
export const FLAG_JOIN = 8;
export const FLAG_MITER_LIMIT = 16;
export const FLAG_DASH_PHASE = 32;
export const ERROR_NONE = 0;
export const ERROR_CAPACITY = 1;
export const ERROR_BATCH = 2;
export const ERROR_STATE = 3;
export const ERROR_INPUT = 4;
export const FIELD_NONE = 0;
export const FIELD_COUNT = 1;
export const FIELD_DASH_COUNT = 2;
export const FIELD_FLAGS = 3;
export const FIELD_DASH_START = 4;
export const FIELD_OUTPUT = 5;
export const FIELD_ALLOCATION = 6;
export const INPUT_SIZE = 64;
export const INPUT_FLAGS_OFFSET = 0;
export const INPUT_RESERVED0_OFFSET = 4;
export const INPUT_WIDTH_OFFSET = 8;
export const INPUT_CAP_OFFSET = 16;
export const INPUT_JOIN_OFFSET = 24;
export const INPUT_MITER_LIMIT_OFFSET = 32;
export const INPUT_DASH_PHASE_OFFSET = 40;
export const INPUT_DASH_START_OFFSET = 48;
export const INPUT_DASH_COUNT_OFFSET = 52;
export const INPUT_RESERVED1_OFFSET = 56;
export const CANONICAL_SIZE = 32;
export const CANONICAL_PRESENT_OFFSET = 0;
export const CANONICAL_WIDTH_OFFSET = 4;
export const CANONICAL_CAP_OFFSET = 8;
export const CANONICAL_JOIN_OFFSET = 12;
export const CANONICAL_MITER_LIMIT_OFFSET = 16;
export const CANONICAL_DASH_PHASE_OFFSET = 20;
export const CANONICAL_DASH_OFFSET_OFFSET = 24;
export const CANONICAL_DASH_COUNT_OFFSET = 28;
export const OUTPUT_BATCH_SIZE = 16;
export const OUTPUT_BATCH_VERSION_OFFSET = 0;
export const OUTPUT_BATCH_COUNT_OFFSET = 4;
export const OUTPUT_BATCH_ENTRIES_OFFSET_OFFSET = 8;
export const OUTPUT_BATCH_BYTE_LENGTH_OFFSET = 12;
export const OUTPUT_ENTRY_SIZE = 8;
export const OUTPUT_ENTRY_OFFSET_OFFSET = 0;
export const OUTPUT_ENTRY_BYTE_LENGTH_OFFSET = 4;
export const ERROR_SIZE = 16;
export const ERROR_CODE_OFFSET = 0;
export const ERROR_RECORD_INDEX_OFFSET = 4;
export const ERROR_FIELD_OFFSET = 8;
export const ERROR_RESERVED_ZERO_OFFSET = 12;
export function readInput(view, pointer) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 64) throw new RangeError("Input out of bounds");
  return {
    flags: view.getUint32(pointer + 0, true),
    reserved0: view.getUint32(pointer + 4, true),
    width: view.getFloat64(pointer + 8, true),
    cap: view.getFloat64(pointer + 16, true),
    join: view.getFloat64(pointer + 24, true),
    miterLimit: view.getFloat64(pointer + 32, true),
    dashPhase: view.getFloat64(pointer + 40, true),
    dashStart: view.getUint32(pointer + 48, true),
    dashCount: view.getUint32(pointer + 52, true),
    reserved1: view.getBigUint64(pointer + 56, true),
  };
}
export function writeInput(view, pointer, value) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 64) throw new RangeError("Input out of bounds");
  view.setUint32(pointer + 0, value.flags, true);
  view.setUint32(pointer + 4, value.reserved0, true);
  view.setFloat64(pointer + 8, value.width, true);
  view.setFloat64(pointer + 16, value.cap, true);
  view.setFloat64(pointer + 24, value.join, true);
  view.setFloat64(pointer + 32, value.miterLimit, true);
  view.setFloat64(pointer + 40, value.dashPhase, true);
  view.setUint32(pointer + 48, value.dashStart, true);
  view.setUint32(pointer + 52, value.dashCount, true);
  view.setBigUint64(pointer + 56, value.reserved1, true);
}
export function readCanonical(view, pointer) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 32) throw new RangeError("Canonical out of bounds");
  return {
    present: view.getUint32(pointer + 0, true),
    width: view.getFloat32(pointer + 4, true),
    cap: view.getUint32(pointer + 8, true),
    join: view.getUint32(pointer + 12, true),
    miterLimit: view.getFloat32(pointer + 16, true),
    dashPhase: view.getFloat32(pointer + 20, true),
    dashOffset: view.getUint32(pointer + 24, true),
    dashCount: view.getUint32(pointer + 28, true),
  };
}
export function writeCanonical(view, pointer, value) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 32) throw new RangeError("Canonical out of bounds");
  view.setUint32(pointer + 0, value.present, true);
  view.setFloat32(pointer + 4, value.width, true);
  view.setUint32(pointer + 8, value.cap, true);
  view.setUint32(pointer + 12, value.join, true);
  view.setFloat32(pointer + 16, value.miterLimit, true);
  view.setFloat32(pointer + 20, value.dashPhase, true);
  view.setUint32(pointer + 24, value.dashOffset, true);
  view.setUint32(pointer + 28, value.dashCount, true);
}
export function readOutputBatch(view, pointer) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("OutputBatch out of bounds");
  return {
    version: view.getUint32(pointer + 0, true),
    count: view.getUint32(pointer + 4, true),
    entriesOffset: view.getUint32(pointer + 8, true),
    byteLength: view.getUint32(pointer + 12, true),
  };
}
export function writeOutputBatch(view, pointer, value) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("OutputBatch out of bounds");
  view.setUint32(pointer + 0, value.version, true);
  view.setUint32(pointer + 4, value.count, true);
  view.setUint32(pointer + 8, value.entriesOffset, true);
  view.setUint32(pointer + 12, value.byteLength, true);
}
export function readOutputEntry(view, pointer) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 8) throw new RangeError("OutputEntry out of bounds");
  return {
    offset: view.getUint32(pointer + 0, true),
    byteLength: view.getUint32(pointer + 4, true),
  };
}
export function writeOutputEntry(view, pointer, value) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 8) throw new RangeError("OutputEntry out of bounds");
  view.setUint32(pointer + 0, value.offset, true);
  view.setUint32(pointer + 4, value.byteLength, true);
}
export function readError(view, pointer) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Error out of bounds");
  return {
    code: view.getUint32(pointer + 0, true),
    recordIndex: view.getUint32(pointer + 4, true),
    field: view.getUint32(pointer + 8, true),
    reservedZero: view.getUint32(pointer + 12, true),
  };
}
export function writeError(view, pointer, value) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Error out of bounds");
  view.setUint32(pointer + 0, value.code, true);
  view.setUint32(pointer + 4, value.recordIndex, true);
  view.setUint32(pointer + 8, value.field, true);
  view.setUint32(pointer + 12, value.reservedZero, true);
}

function strokeSpan(view, pointer, byteLength) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || !Number.isInteger(byteLength) ||
      byteLength < 0 || byteLength > 0xffffffff || pointer > view.byteLength - byteLength) {
    throw new RangeError("Stroke span out of bounds");
  }
  return new Uint8Array(view.buffer, view.byteOffset + pointer, byteLength);
}
export function readCanonicalBlob(view, pointer, byteLength) {
  const bytes = strokeSpan(view, pointer, byteLength);
  const local = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const canonical = readCanonical(local, 0);
  if (canonical.present > 1 || byteLength !== CANONICAL_SIZE + 4 * canonical.dashCount ||
      canonical.dashOffset !== (canonical.dashCount ? CANONICAL_SIZE : 0) ||
      (!canonical.present && bytes.some((byte) => byte !== 0))) {
    throw new RangeError("Invalid canonical stroke blob");
  }
  return {
    canonical,
    bytes,
    dash(index) {
      if (!Number.isInteger(index) || index < 0 || index >= canonical.dashCount) throw new RangeError("Stroke dash out of bounds");
      return local.getFloat32(CANONICAL_SIZE + index * 4, true);
    },
  };
}
export function readStrokeOutput(view, pointer, byteLength) {
  const bytes = strokeSpan(view, pointer, byteLength);
  const local = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  if (byteLength) {
    const header = readOutputBatch(local, 0);
    count = header.count;
    let cursor = OUTPUT_BATCH_SIZE + count * OUTPUT_ENTRY_SIZE;
    if (header.version !== ABI_VERSION || !count || header.byteLength !== byteLength ||
        header.entriesOffset !== OUTPUT_BATCH_SIZE || cursor > byteLength) {
      throw new RangeError("Invalid stroke output header");
    }
    for (let i = 0; i < count; i++) {
      const entry = readOutputEntry(local, OUTPUT_BATCH_SIZE + i * OUTPUT_ENTRY_SIZE);
      const aligned = Math.ceil(cursor / ALIGNMENT) * ALIGNMENT;
      if (entry.offset !== aligned || entry.byteLength < CANONICAL_SIZE ||
          entry.offset > byteLength - entry.byteLength) throw new RangeError("Invalid stroke output entry");
      for (; cursor < aligned; cursor++) {
        if (bytes[cursor] !== 0) throw new RangeError("Invalid stroke output padding");
      }
      readCanonicalBlob(local, entry.offset, entry.byteLength);
      cursor = entry.offset + entry.byteLength;
    }
    if (cursor !== byteLength) throw new RangeError("Trailing stroke output bytes");
  }
  return {
    bytes,
    count,
    blob(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError("Stroke output index out of bounds");
      const entry = readOutputEntry(local, OUTPUT_BATCH_SIZE + index * OUTPUT_ENTRY_SIZE);
      return readCanonicalBlob(local, entry.offset, entry.byteLength);
    },
  };
}
