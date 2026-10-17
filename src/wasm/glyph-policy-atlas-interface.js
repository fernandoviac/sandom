// Handwritten binding for glyph-policy-atlas-interface.json.
export const ABI_VERSION = 1;
export const STATE_WRITABLE = 1;
export const STATE_PUBLISHED = 2;
export const ERROR_NONE = 0;
export const ERROR_MODE = 1;
export const ERROR_COUNT_OVERFLOW = 2;
export const ERROR_CAPACITY = 3;
export const ERROR_STALE_BATCH = 4;
export const ERROR_STATE = 5;
export const ERROR_ATLAS = 6;
export const ERROR_NUMBER = 7;
export const ERROR_NULL_TAG = 8;
export const FIELD_NONE = 0;
export const FIELD_GLYPH_ID = 1;
export const FIELD_WEIGHT = 2;
export const FIELD_OPTICAL_SIZE = 3;
export const FIELD_DEVICE_PIXEL_SIZE = 4;
export const FIELD_OPTICAL_SIZE_PRESENT = 5;
export const FIELD_DEVICE_PIXEL_SIZE_PRESENT = 6;
export const FIELD_COUNT = 7;
export const FIELD_MODE = 8;
export const FIELD_BATCH = 9;
export const FIELD_ATLAS = 10;
export const MODE_KEYS = 1;
export const MODE_RESIDENCY = 2;
export const MODE_PLACEMENTS = 4;
export const INPUT_SIZE = 40;
export const INPUT_GLYPH_ID_OFFSET = 0;
export const INPUT_WEIGHT_OFFSET = 8;
export const INPUT_OPTICAL_SIZE_OFFSET = 16;
export const INPUT_DEVICE_PIXEL_SIZE_OFFSET = 24;
export const INPUT_OPTICAL_SIZE_PRESENT_OFFSET = 32;
export const INPUT_DEVICE_PIXEL_SIZE_PRESENT_OFFSET = 36;
export const CANONICAL_KEY_SIZE = 24;
export const CANONICAL_KEY_GLYPH_ID_OFFSET = 0;
export const CANONICAL_KEY_WEIGHT_OFFSET = 4;
export const CANONICAL_KEY_OPTICAL_SIZE_OFFSET = 8;
export const CANONICAL_KEY_SIZE_CLASS_OFFSET = 16;
export const CANONICAL_KEY_HASH_OFFSET = 20;
export const RESIDENCY_SIZE = 96;
export const RESIDENCY_KEY_OFFSET = 0;
export const RESIDENCY_KEY_COUNT = 24;
export const RESIDENCY_SLOT_OFFSET = 24;
export const RESIDENCY_PRESENT_OFFSET = 28;
export const RESIDENCY_INFORMATION_OFFSET = 32;
export const RESIDENCY_INFORMATION_COUNT = 15;
export const RESIDENCY_RESERVED_ZERO_OFFSET = 92;
export const PLACEMENT_SIZE = 16;
export const PLACEMENT_SLOT_OFFSET = 0;
export const PLACEMENT_PRESENT_OFFSET = 4;
export const PLACEMENT_X_OFFSET = 8;
export const PLACEMENT_Y_OFFSET = 12;
export const ERROR_SIZE = 16;
export const ERROR_CODE_OFFSET = 0;
export const ERROR_RECORD_INDEX_OFFSET = 4;
export const ERROR_FIELD_OFFSET = 8;
export const ERROR_RESERVED_ZERO_OFFSET = 12;
export function readInput(view, pointer) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 40) throw new RangeError("Input out of bounds");
  return {
    glyphId: view.getFloat64(pointer + 0, true),
    weight: view.getFloat64(pointer + 8, true),
    opticalSize: view.getFloat64(pointer + 16, true),
    devicePixelSize: view.getFloat64(pointer + 24, true),
    opticalSizePresent: view.getUint32(pointer + 32, true),
    devicePixelSizePresent: view.getUint32(pointer + 36, true),
  };
}
export function writeInput(view, pointer, value) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 40) throw new RangeError("Input out of bounds");
  view.setFloat64(pointer + 0, value.glyphId, true);
  view.setFloat64(pointer + 8, value.weight, true);
  view.setFloat64(pointer + 16, value.opticalSize, true);
  view.setFloat64(pointer + 24, value.devicePixelSize, true);
  view.setUint32(pointer + 32, value.opticalSizePresent, true);
  view.setUint32(pointer + 36, value.devicePixelSizePresent, true);
}
export function readCanonicalKey(view, pointer) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 24) throw new RangeError("CanonicalKey out of bounds");
  return {
    glyphId: view.getUint32(pointer + 0, true),
    weight: view.getFloat32(pointer + 4, true),
    opticalSize: view.getFloat64(pointer + 8, true),
    sizeClass: view.getUint32(pointer + 16, true),
    hash: view.getUint32(pointer + 20, true),
  };
}
export function writeCanonicalKey(view, pointer, value) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 24) throw new RangeError("CanonicalKey out of bounds");
  view.setUint32(pointer + 0, value.glyphId, true);
  view.setFloat32(pointer + 4, value.weight, true);
  view.setFloat64(pointer + 8, value.opticalSize, true);
  view.setUint32(pointer + 16, value.sizeClass, true);
  view.setUint32(pointer + 20, value.hash, true);
}
export function readResidency(view, pointer) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 96) throw new RangeError("Residency out of bounds");
  return {
    key: [view.getUint8(pointer + 0, true), view.getUint8(pointer + 1, true), view.getUint8(pointer + 2, true), view.getUint8(pointer + 3, true), view.getUint8(pointer + 4, true), view.getUint8(pointer + 5, true), view.getUint8(pointer + 6, true), view.getUint8(pointer + 7, true), view.getUint8(pointer + 8, true), view.getUint8(pointer + 9, true), view.getUint8(pointer + 10, true), view.getUint8(pointer + 11, true), view.getUint8(pointer + 12, true), view.getUint8(pointer + 13, true), view.getUint8(pointer + 14, true), view.getUint8(pointer + 15, true), view.getUint8(pointer + 16, true), view.getUint8(pointer + 17, true), view.getUint8(pointer + 18, true), view.getUint8(pointer + 19, true), view.getUint8(pointer + 20, true), view.getUint8(pointer + 21, true), view.getUint8(pointer + 22, true), view.getUint8(pointer + 23, true)],
    slot: view.getInt32(pointer + 24, true),
    present: view.getUint32(pointer + 28, true),
    information: [view.getFloat32(pointer + 32, true), view.getFloat32(pointer + 36, true), view.getFloat32(pointer + 40, true), view.getFloat32(pointer + 44, true), view.getFloat32(pointer + 48, true), view.getFloat32(pointer + 52, true), view.getFloat32(pointer + 56, true), view.getFloat32(pointer + 60, true), view.getFloat32(pointer + 64, true), view.getFloat32(pointer + 68, true), view.getFloat32(pointer + 72, true), view.getFloat32(pointer + 76, true), view.getFloat32(pointer + 80, true), view.getFloat32(pointer + 84, true), view.getFloat32(pointer + 88, true)],
    reservedZero: view.getUint32(pointer + 92, true),
  };
}
export function writeResidency(view, pointer, value) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 96) throw new RangeError("Residency out of bounds");
  for (let index = 0; index < 24; index++) view.setUint8(pointer + 0 + index * 1, value.key[index], true);
  view.setInt32(pointer + 24, value.slot, true);
  view.setUint32(pointer + 28, value.present, true);
  for (let index = 0; index < 15; index++) view.setFloat32(pointer + 32 + index * 4, value.information[index], true);
  view.setUint32(pointer + 92, value.reservedZero, true);
}
export function readPlacement(view, pointer) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Placement out of bounds");
  return {
    slot: view.getInt32(pointer + 0, true),
    present: view.getUint32(pointer + 4, true),
    x: view.getUint32(pointer + 8, true),
    y: view.getUint32(pointer + 12, true),
  };
}
export function writePlacement(view, pointer, value) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Placement out of bounds");
  view.setInt32(pointer + 0, value.slot, true);
  view.setUint32(pointer + 4, value.present, true);
  view.setUint32(pointer + 8, value.x, true);
  view.setUint32(pointer + 12, value.y, true);
}
export function readError(view, pointer) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Error out of bounds");
  return {
    code: view.getUint32(pointer + 0, true),
    recordIndex: view.getUint32(pointer + 4, true),
    field: view.getUint32(pointer + 8, true),
    reservedZero: view.getUint32(pointer + 12, true),
  };
}
export function writeError(view, pointer, value) {
  if (!(view instanceof DataView)) throw new TypeError("view must be a DataView");
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > view.byteLength - 16) throw new RangeError("Error out of bounds");
  view.setUint32(pointer + 0, value.code, true);
  view.setUint32(pointer + 4, value.recordIndex, true);
  view.setUint32(pointer + 8, value.field, true);
  view.setUint32(pointer + 12, value.reservedZero, true);
}
