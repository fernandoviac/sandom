import { sharedDomCore as core } from "./dom-wasm/core.js";

const decoder = new TextDecoder();
const recordType = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => value !== null && value !== undefined;

function utf16Input(value) {
  if (!present(value)) return [0, 0];
  const text = String(value);
  const pointer = core.exports.abi_allocate(text.length * 2);
  const units = new Uint16Array(core.refreshBytes().buffer, pointer, text.length);
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
  return [pointer, text.length];
}

function textInput(value) {
  return present(value) ? core.input(String(value)) : [0, 0];
}

function transportRuns(records, sandom) {
  const pointer = core.exports.abi_allocate(records.length * 128);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const name = textInput(record?.name);
    const text = utf16Input(record?.text);
    const family = textInput(record?.font?.family);
    const advances = Array.isArray(record?.advances) ? record.advances : [];
    const advancePointer = core.exports.abi_allocate(advances.length * 8);
    const numbers = new Float64Array(core.refreshBytes().buffer, advancePointer, advances.length);
    for (let item = 0; item < advances.length; item++) numbers[item] = typeof advances[item] === "number" ? advances[item] : NaN;
    // Join text is a transport encoding of the host collection, including its
    // null and nested-array conversion. Native code compares the encodings.
    const joinable = typeof record?.glyphIds?.join === "function";
    const joined = joinable ? record.glyphIds.join(",") : undefined;
    const glyphs = textInput(joined);
    const bounds = sandom ? record?.geometry : record?.bounds;
    const flags = Number(recordType(record)) | (Number(Array.isArray(record?.advances)) << 1) |
      (Number(Array.isArray(record?.glyphIds)) << 2) | (Number(Boolean(bounds)) << 3) |
      (Number(typeof record?.name === "string") << 6) | (Number(present(bounds?.x)) << 7) |
      (Number(present(bounds?.y)) << 8) | (Number(joinable) << 9) | (Number(typeof joined === "string") << 10);
    const row = pointer + index * 128;
    const view = new DataView(core.refreshBytes().buffer);
    view.setUint32(row, flags, true);
    view.setUint32(row + 4, Number(record?.textShadow === true), true);
    for (const [offset, span] of [[8, name], [16, text], [24, family], [32, [advancePointer, advances.length]], [40, glyphs]]) {
      view.setUint32(row + offset, span[0], true);
      view.setUint32(row + offset + 4, span[1], true);
    }
    view.setFloat64(row + 48, sandom ? Number(record?.fontSize) : 0, true);
    view.setFloat64(row + 56, sandom ? Number(record?.unitsPerEm) : 0, true);
    view.setFloat64(row + 64, Number(bounds?.x), true);
    view.setFloat64(row + 72, Number(bounds?.y), true);
  }
  return pointer;
}

export function compareTextRendering(chromeMeasurement, sandomDisplayList) {
  const chromeRuns = Array.isArray(chromeMeasurement?.runs) ? chromeMeasurement.runs : [];
  const commands = Array.isArray(sandomDisplayList?.commands) ? sandomDisplayList.commands : [];
  const chromePointer = transportRuns(chromeRuns, false);
  const sandomPointer = transportRuns(commands, true);
  const types = Number(recordType(chromeMeasurement)) | (Number(Array.isArray(chromeMeasurement?.runs)) << 1) |
    (Number(recordType(sandomDisplayList)) << 2) | (Number(Array.isArray(sandomDisplayList?.commands)) << 3);
  const count = core.status("font_compare_text", chromePointer, chromeRuns.length, sandomPointer, commands.length, types);
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  const output = core.exports.abi_output_pointer();
  const runs = new Array(count);
  const nativeText = offset => decoder.decode(bytes.subarray(view.getUint32(offset, true),
    view.getUint32(offset, true) + view.getUint32(offset + 4, true)));
  for (let index = 0; index < count; index++) {
    const row = output + 16 + index * 104;
    const chromeIndex = view.getInt32(row, true);
    const sandomIndex = view.getInt32(row + 4, true);
    const chrome = chromeRuns[chromeIndex];
    const sandom = commands[sandomIndex];
    const flags = view.getUint32(row + 8, true);
    const mismatches = [];
    const mismatch = (kind, expected, actual, tolerance) => mismatches.push(Object.freeze({kind, expected, actual, tolerance}));
    const tolerance = view.getFloat64(row + 24, true);
    if (flags & 1) mismatch("run-count", Number(chromeIndex >= 0), Number(sandomIndex >= 0), 0);
    if (flags & 2) mismatch("character-count", view.getUint32(row + 60, true), view.getUint32(row + 64, true), 0);
    if (flags & 4) mismatch("glyph-count", view.getUint32(row + 12, true), view.getUint32(row + 16, true), 0);
    if (flags & 8) mismatch("cumulative-advance", view.getFloat64(row + 40, true), view.getFloat64(row + 48, true), view.getFloat64(row + 32, true));
    if (flags & 16) {
      const differences = new Array(view.getUint32(row + 20, true));
      const pointer = view.getUint32(row + 56, true);
      for (let item = 0; item < differences.length; item++) {
        const difference = pointer + item * 32;
        differences[item] = Object.freeze({
          index: view.getUint32(difference, true), expected: view.getFloat64(difference + 8, true),
          actual: view.getFloat64(difference + 16, true), difference: view.getFloat64(difference + 24, true),
        });
      }
      mismatches.push(Object.freeze({kind: "advance-sequence", tolerance, differences: Object.freeze(differences)}));
    }
    if (flags & 32) mismatch("glyph-identity", chrome.glyphIds, sandom.glyphIds, 0);
    if (flags & 64) mismatch("font-identity", nativeText(row + 68), nativeText(row + 76), 0);
    if (flags & 128) mismatch("run-position", {x: view.getFloat64(row + 88, true)}, {x: view.getFloat64(row + 96, true)}, tolerance);
    runs[index] = Object.freeze({
      index,
      chromeText: flags & 1 ? chrome?.text ?? null : chrome.text,
      sandomText: flags & 1 ? sandom?.text ?? null : sandom.text,
      matches: flags === 0,
      mismatches: Object.freeze(mismatches),
    });
  }
  return Object.freeze({
    matches: view.getUint32(output + 12, true) !== 0,
    chromeRunCount: view.getUint32(output + 4, true),
    sandomRunCount: view.getUint32(output + 8, true),
    runs: Object.freeze(runs),
  });
}
