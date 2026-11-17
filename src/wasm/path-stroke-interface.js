// The host records of a stroke batch (atlas-strokes.watpart STROKE_*), read
// from the renderer core's layout table.
import { layoutConstant } from "./layout-table.js";

const constant = (name) => layoutConstant(`STROKE_${name}`);

export const FLAG_PRESENT = constant("FLAG_PRESENT");
export const FLAG_WIDTH = constant("FLAG_WIDTH");
export const FLAG_CAP = constant("FLAG_CAP");
export const FLAG_JOIN = constant("FLAG_JOIN");
export const FLAG_MITER_LIMIT = constant("FLAG_MITER_LIMIT");
export const FLAG_DASH_PHASE = constant("FLAG_DASH_PHASE");
export const ERROR_BATCH = constant("ERROR_BATCH");
export const ERROR_STATE = constant("ERROR_STATE");
export const FIELD_DASH_START = constant("FIELD_DASH_START");
export const INPUT_SIZE = constant("INPUT_SIZE");
export const INPUT_FLAGS_OFFSET = constant("INPUT_FLAGS");
export const INPUT_WIDTH_OFFSET = constant("INPUT_WIDTH");
export const INPUT_CAP_OFFSET = constant("INPUT_CAP");
export const INPUT_JOIN_OFFSET = constant("INPUT_JOIN");
export const INPUT_MITER_LIMIT_OFFSET = constant("INPUT_MITER_LIMIT");
export const INPUT_DASH_PHASE_OFFSET = constant("INPUT_DASH_PHASE");
export const INPUT_DASH_START_OFFSET = constant("INPUT_DASH_START");
export const INPUT_DASH_COUNT_OFFSET = constant("INPUT_DASH_COUNT");
const CANONICAL_SIZE = constant("CANONICAL_SIZE");
const CANONICAL = Object.freeze(Object.fromEntries([
  "PRESENT", "WIDTH", "CAP", "JOIN", "MITER_LIMIT", "DASH_PHASE", "DASH_OFFSET", "DASH_COUNT",
].map((name) => [name, constant(`CANONICAL_${name}`)])));
const OUTPUT_VERSION = constant("OUTPUT_VERSION");
const OUTPUT_ALIGNMENT = constant("OUTPUT_ALIGNMENT");
export const OUTPUT_BATCH_SIZE = constant("OUTPUT_SIZE");
const OUTPUT_VERSION_OFFSET = constant("OUTPUT_VERSION_FIELD");
const OUTPUT_COUNT_OFFSET = constant("OUTPUT_COUNT");
const OUTPUT_ENTRIES_OFFSET = constant("OUTPUT_ENTRIES");
const OUTPUT_BYTE_LENGTH_OFFSET = constant("OUTPUT_BYTE_LENGTH");
export const OUTPUT_ENTRY_SIZE = constant("OUTPUT_ENTRY_SIZE");
const OUTPUT_ENTRY_OFFSET_OFFSET = constant("OUTPUT_ENTRY_OFFSET");
const OUTPUT_ENTRY_BYTE_LENGTH_OFFSET = constant("OUTPUT_ENTRY_BYTE_LENGTH");
const ERROR_CODE_OFFSET = constant("ERROR_CODE");
const ERROR_RECORD_INDEX_OFFSET = constant("ERROR_RECORD_INDEX");
const ERROR_FIELD_OFFSET = constant("ERROR_FIELD");

function requireRecord(view, pointer, size, name) {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > view.byteLength - size) {
    throw new RangeError(`${name} at ${pointer} does not fit ${size} bytes in a ${view.byteLength}-byte view`);
  }
}

function readCanonical(view, pointer) {
  requireRecord(view, pointer, CANONICAL_SIZE, "Canonical");
  return {
    present: view.getUint32(pointer + CANONICAL.PRESENT, true),
    width: view.getFloat32(pointer + CANONICAL.WIDTH, true),
    cap: view.getUint32(pointer + CANONICAL.CAP, true),
    join: view.getUint32(pointer + CANONICAL.JOIN, true),
    miterLimit: view.getFloat32(pointer + CANONICAL.MITER_LIMIT, true),
    dashPhase: view.getFloat32(pointer + CANONICAL.DASH_PHASE, true),
    dashOffset: view.getUint32(pointer + CANONICAL.DASH_OFFSET, true),
    dashCount: view.getUint32(pointer + CANONICAL.DASH_COUNT, true),
  };
}
export function readOutputEntry(view, pointer) {
  requireRecord(view, pointer, OUTPUT_ENTRY_SIZE, "OutputEntry");
  return {
    offset: view.getUint32(pointer + OUTPUT_ENTRY_OFFSET_OFFSET, true),
    byteLength: view.getUint32(pointer + OUTPUT_ENTRY_BYTE_LENGTH_OFFSET, true),
  };
}
export function readError(view, pointer) {
  requireRecord(view, pointer, ERROR_FIELD_OFFSET + 4, "Error");
  return {
    code: view.getUint32(pointer + ERROR_CODE_OFFSET, true),
    recordIndex: view.getUint32(pointer + ERROR_RECORD_INDEX_OFFSET, true),
    field: view.getUint32(pointer + ERROR_FIELD_OFFSET, true),
  };
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
      return local.getFloat32(CANONICAL_SIZE + index * Float32Array.BYTES_PER_ELEMENT, true);
    },
  };
}
export function readStrokeOutput(view, pointer, byteLength) {
  const bytes = strokeSpan(view, pointer, byteLength);
  const local = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  if (byteLength) {
    requireRecord(local, 0, OUTPUT_BATCH_SIZE, "OutputBatch");
    const version = local.getUint32(OUTPUT_VERSION_OFFSET, true);
    count = local.getUint32(OUTPUT_COUNT_OFFSET, true);
    const entriesOffset = local.getUint32(OUTPUT_ENTRIES_OFFSET, true);
    const headerByteLength = local.getUint32(OUTPUT_BYTE_LENGTH_OFFSET, true);
    let cursor = OUTPUT_BATCH_SIZE + count * OUTPUT_ENTRY_SIZE;
    if (version !== OUTPUT_VERSION || !count || headerByteLength !== byteLength ||
        entriesOffset !== OUTPUT_BATCH_SIZE || cursor > byteLength) {
      throw new RangeError("Invalid stroke output header");
    }
    for (let i = 0; i < count; i++) {
      const entry = readOutputEntry(local, OUTPUT_BATCH_SIZE + i * OUTPUT_ENTRY_SIZE);
      const aligned = Math.ceil(cursor / OUTPUT_ALIGNMENT) * OUTPUT_ALIGNMENT;
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
