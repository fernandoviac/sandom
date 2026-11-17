import { layoutConstant } from "../wasm/layout-table.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REQUEST = Object.fromEntries(["SIZE", "DISPLAY", "FAMILY", "STYLE", "FLAGS", "WEIGHT", "STRETCH", "SLOPE",
  "FONT_SIZE", "SCALE", "HAS_NATIVE_ROW", "HAS_INLINE_CONTEXT", "HAS_TEXTAREA", "HAS_WEIGHT", "HAS_STRETCH",
  "HAS_SLOPE", "HAS_FAMILY", "HAS_STYLE", "HAS_SCALE", "NULL_WEIGHT"]
  .map((name) => [name, layoutConstant(`FONT_REQUEST_${name}`)]));
const TEXT_ROW_SIZE = layoutConstant("TEXT_ROW_SIZE");
const TEXT_ROW_POINTER = layoutConstant("TEXT_ROW_POINTER");
const TEXT_ROW_LENGTH = layoutConstant("TEXT_ROW_LENGTH");

// Raw values and presence bits only. Native code owns eligibility, defaults,
// validation, request identity and glyph collection.
export function createFontRequestPlan(core, instances, mode) {
  const rows = instances.map((instance) => {
    const strings = [instance?.display, instance?.fontFamily, instance?.fontStyle]
      .map((value) => encoder.encode(value == null ? "" : String(value)));
    const presence = [
      [instance?._coreBox !== undefined, REQUEST.HAS_NATIVE_ROW],
      [Boolean(instance?.inlineCtx), REQUEST.HAS_INLINE_CONTEXT],
      [Boolean(instance?._coreTextarea), REQUEST.HAS_TEXTAREA],
      [instance?.fontWeight !== undefined, REQUEST.HAS_WEIGHT],
      [instance?.fontStretch != null, REQUEST.HAS_STRETCH],
      [instance?.fontSlope != null, REQUEST.HAS_SLOPE],
      [instance?.fontFamily != null, REQUEST.HAS_FAMILY],
      [instance?.fontStyle != null, REQUEST.HAS_STYLE],
      [instance?.deviceScale != null, REQUEST.HAS_SCALE],
      [instance?.fontWeight === null, REQUEST.NULL_WEIGHT],
    ];
    const flags = presence.reduce((value, [present, flag]) => present ? value | flag : value, 0);
    return { strings, flags, numbers: [instance?.fontWeight, instance?.fontStretch,
      instance?.fontSlope, instance?.fontSize, instance?.deviceScale].map(Number) };
  });
  const length = rows.length * REQUEST.SIZE + rows.reduce((sum, row) =>
    sum + row.strings.reduce((total, bytes) => total + bytes.length, 0), 0);
  const pointer = core.exports.abi_allocate(length);
  if (!pointer && length) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  let cursor = pointer + rows.length * REQUEST.SIZE;
  for (const [index, row] of rows.entries()) {
    const at = pointer + index * REQUEST.SIZE;
    for (const [field, text] of row.strings.entries()) {
      view.setUint32(at + field * TEXT_ROW_SIZE + TEXT_ROW_POINTER, cursor, true);
      view.setUint32(at + field * TEXT_ROW_SIZE + TEXT_ROW_LENGTH, text.length, true);
      bytes.set(text, cursor);
      cursor += text.length;
    }
    view.setUint32(at + REQUEST.FLAGS, row.flags, true);
    [REQUEST.WEIGHT, REQUEST.STRETCH, REQUEST.SLOPE, REQUEST.FONT_SIZE, REQUEST.SCALE].forEach((field, position) =>
      view.setFloat64(at + field, row.numbers[position], true));
  }
  const handle = core.status("font_requests_create", pointer, rows.length, mode);
  try {
    const count = core.status("font_requests_rows", handle);
    const output = core.exports.abi_output_pointer();
    const memory = core.refreshBytes();
    const result = new DataView(memory.buffer);
    const text = (at) => {
      const start = result.getUint32(at + TEXT_ROW_POINTER, true);
      return decoder.decode(memory.subarray(start, start + result.getUint32(at + TEXT_ROW_LENGTH, true)));
    };
    const requests = Array.from({ length: count }, (_, index) => {
      const at = output + index * REQUEST.SIZE;
      return {
        family: text(at + REQUEST.FAMILY), style: text(at + REQUEST.STYLE), familyKind: result.getUint32(at + REQUEST.FLAGS, true),
        weight: result.getFloat64(at + REQUEST.WEIGHT, true), stretch: result.getFloat64(at + REQUEST.STRETCH, true),
        slope: result.getFloat64(at + REQUEST.SLOPE, true), size: result.getFloat64(at + REQUEST.FONT_SIZE, true),
      };
    });
    const indexCount = core.status("font_requests_indices", handle);
    const indices = new Int32Array(core.refreshBytes().buffer,
      core.exports.abi_output_pointer(), indexCount).slice();
    return { handle, requests, indices };
  } catch (error) {
    core.status("font_requests_release", handle);
    throw error;
  }
}
