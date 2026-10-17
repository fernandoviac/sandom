const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Raw values and presence bits only. Native code owns eligibility, defaults,
// validation, request identity and glyph collection.
export function createFontRequestPlan(core, instances, mode) {
  const rows = instances.map((instance) => {
    const strings = [instance?.display, instance?.fontFamily, instance?.fontStyle]
      .map((value) => encoder.encode(value == null ? "" : String(value)));
    const flags = Number(instance?._coreBox !== undefined) |
      (Number(Boolean(instance?.inlineCtx)) << 1) |
      (Number(Boolean(instance?._coreTextarea)) << 2) |
      (Number(instance?.fontWeight !== undefined) << 3) |
      (Number(instance?.fontStretch != null) << 4) |
      (Number(instance?.fontSlope != null) << 5) |
      (Number(instance?.fontFamily != null) << 6) |
      (Number(instance?.fontStyle != null) << 7) |
      (Number(instance?.deviceScale != null) << 8) |
      (Number(instance?.fontWeight === null) << 9);
    return { strings, flags, numbers: [instance?.fontWeight, instance?.fontStretch,
      instance?.fontSlope, instance?.fontSize, instance?.deviceScale].map(Number) };
  });
  const length = rows.length * 80 + rows.reduce((sum, row) =>
    sum + row.strings.reduce((total, bytes) => total + bytes.length, 0), 0);
  const pointer = core.exports.abi_allocate(length);
  if (!pointer && length) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  let cursor = pointer + rows.length * 80;
  for (const [index, row] of rows.entries()) {
    const at = pointer + index * 80;
    for (const [field, text] of row.strings.entries()) {
      view.setUint32(at + field * 8, cursor, true);
      view.setUint32(at + field * 8 + 4, text.length, true);
      bytes.set(text, cursor);
      cursor += text.length;
    }
    view.setUint32(at + 24, row.flags, true);
    for (const [field, value] of row.numbers.entries()) {
      view.setFloat64(at + 32 + field * 8, value, true);
    }
  }
  const handle = core.status("font_requests_create", pointer, rows.length, mode);
  try {
    const count = core.status("font_requests_rows", handle);
    const output = core.exports.abi_output_pointer();
    const memory = core.refreshBytes();
    const result = new DataView(memory.buffer);
    const text = (at) => {
      const start = result.getUint32(at, true);
      return decoder.decode(memory.subarray(start, start + result.getUint32(at + 4, true)));
    };
    const requests = Array.from({ length: count }, (_, index) => {
      const at = output + index * 80;
      return {
        family: text(at + 8), style: text(at + 16), familyKind: result.getUint32(at + 24, true),
        weight: result.getFloat64(at + 32, true), stretch: result.getFloat64(at + 40, true),
        slope: result.getFloat64(at + 48, true), size: result.getFloat64(at + 56, true),
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
