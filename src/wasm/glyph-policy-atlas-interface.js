// The host records of a glyph key batch (glyph-atlas.watpart GLYPH_KEYS_*),
// read from the renderer core's layout table.
import { layoutConstant } from "./layout-table.js";

const constant = (name) => layoutConstant(`GLYPH_KEYS_${name}`);

export const MODE_KEYS = constant("MODE_KEYS");
export const MODE_RESIDENCY = constant("MODE_RESIDENCY");
export const ERROR_NUMBER = constant("ERROR_NUMBER");
export const FIELD_DEVICE_PIXEL_SIZE = constant("FIELD_DEVICE_PIXEL_SIZE");
export const INPUT_SIZE = constant("INPUT_SIZE");
export const INPUT_GLYPH_ID_OFFSET = constant("INPUT_GLYPH_ID");
export const INPUT_WEIGHT_OFFSET = constant("INPUT_WEIGHT");
export const INPUT_OPTICAL_SIZE_OFFSET = constant("INPUT_OPTICAL_SIZE");
export const INPUT_DEVICE_PIXEL_SIZE_OFFSET = constant("INPUT_DEVICE_PIXEL_SIZE");
export const INPUT_OPTICAL_SIZE_PRESENT_OFFSET = constant("INPUT_OPTICAL_SIZE_PRESENT");
export const INPUT_DEVICE_PIXEL_SIZE_PRESENT_OFFSET = constant("INPUT_DEVICE_PIXEL_SIZE_PRESENT");
export const CANONICAL_KEY_SIZE = constant("KEY_SIZE");
const CANONICAL_KEY_GLYPH_ID_OFFSET = constant("KEY_GLYPH_ID");
const CANONICAL_KEY_WEIGHT_OFFSET = constant("KEY_WEIGHT");
const CANONICAL_KEY_OPTICAL_SIZE_OFFSET = constant("KEY_OPTICAL_SIZE");
const CANONICAL_KEY_SIZE_CLASS_OFFSET = constant("KEY_SIZE_CLASS");
const CANONICAL_KEY_HASH_OFFSET = constant("KEY_HASH");
export const RESIDENCY_SIZE = constant("RESIDENCY_SIZE");
export const RESIDENCY_SLOT_OFFSET = constant("RESIDENCY_SLOT");
export const RESIDENCY_INFORMATION_COUNT = constant("RESIDENCY_INFORMATION_COUNT");
const ERROR_CODE_OFFSET = constant("ERROR_CODE");
const ERROR_RECORD_INDEX_OFFSET = constant("ERROR_RECORD_INDEX");
const ERROR_FIELD_OFFSET = constant("ERROR_FIELD");

function requireRecord(view, pointer, size, name) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - size) {
    throw new RangeError(`${name} at ${pointer} does not fit ${size} bytes in a ${view.byteLength}-byte view`);
  }
}

export function writeInput(view, pointer, value) {
  requireRecord(view, pointer, INPUT_SIZE, "Input");
  view.setFloat64(pointer + INPUT_GLYPH_ID_OFFSET, value.glyphId, true);
  view.setFloat64(pointer + INPUT_WEIGHT_OFFSET, value.weight, true);
  view.setFloat64(pointer + INPUT_OPTICAL_SIZE_OFFSET, value.opticalSize, true);
  view.setFloat64(pointer + INPUT_DEVICE_PIXEL_SIZE_OFFSET, value.devicePixelSize, true);
  view.setUint32(pointer + INPUT_OPTICAL_SIZE_PRESENT_OFFSET, value.opticalSizePresent, true);
  view.setUint32(pointer + INPUT_DEVICE_PIXEL_SIZE_PRESENT_OFFSET, value.devicePixelSizePresent, true);
}

export function readCanonicalKey(view, pointer) {
  requireRecord(view, pointer, CANONICAL_KEY_SIZE, "CanonicalKey");
  return {
    glyphId: view.getUint32(pointer + CANONICAL_KEY_GLYPH_ID_OFFSET, true),
    weight: view.getFloat32(pointer + CANONICAL_KEY_WEIGHT_OFFSET, true),
    opticalSize: view.getFloat64(pointer + CANONICAL_KEY_OPTICAL_SIZE_OFFSET, true),
    sizeClass: view.getUint32(pointer + CANONICAL_KEY_SIZE_CLASS_OFFSET, true),
    hash: view.getUint32(pointer + CANONICAL_KEY_HASH_OFFSET, true),
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
