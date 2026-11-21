import { sharedDomCore as core } from "./dom-wasm/core.js";
import { layoutConstant } from "./wasm/layout-table.js";

// The records of font-comparison.watpart, by WAT name without the
// TEXT_COMPARE_ prefix.
const COMPARE = Object.freeze(Object.fromEntries([
  "RUN_SIZE", "RUN_FLAGS", "RUN_SHADOW", "RUN_NAME", "RUN_TEXT", "RUN_FAMILY", "RUN_ADVANCES", "RUN_GLYPHS",
  "RUN_FONT_SIZE", "RUN_UNITS_PER_EM", "RUN_X", "RUN_Y", "SPAN_POINTER", "SPAN_LENGTH",
  "HEADER_SIZE", "HEADER_COUNT", "HEADER_CHROME_COUNT", "HEADER_SANDOM_COUNT", "HEADER_MATCHES",
  "PAIR_SIZE", "PAIR_CHROME", "PAIR_SANDOM", "PAIR_FLAGS", "PAIR_CHROME_GLYPHS", "PAIR_SANDOM_GLYPHS",
  "PAIR_DIFFERENCE_COUNT", "PAIR_TOLERANCE", "PAIR_TOTAL_TOLERANCE", "PAIR_CHROME_TOTAL", "PAIR_SANDOM_TOTAL",
  "PAIR_DIFFERENCES", "PAIR_CHROME_LENGTH", "PAIR_SANDOM_LENGTH", "PAIR_CHROME_FAMILY", "PAIR_SANDOM_FAMILY",
  "PAIR_CHROME_X", "PAIR_SANDOM_X",
  "DIFFERENCE_SIZE", "DIFFERENCE_INDEX", "DIFFERENCE_EXPECTED", "DIFFERENCE_ACTUAL", "DIFFERENCE_DIFFERENCE",
  "RUN_IS_RECORD", "RUN_HAS_ADVANCES", "RUN_HAS_GLYPHS", "RUN_HAS_BOUNDS", "RUN_NAMED", "RUN_HAS_X", "RUN_HAS_Y",
  "RUN_JOINABLE", "RUN_JOINED", "CHROME_RECORD", "CHROME_RUNS", "SANDOM_RECORD", "SANDOM_COMMANDS",
  "MISMATCH_RUN_COUNT", "MISMATCH_CHARACTER_COUNT", "MISMATCH_GLYPH_COUNT", "MISMATCH_CUMULATIVE_ADVANCE",
  "MISMATCH_ADVANCE_SEQUENCE", "MISMATCH_GLYPH_IDENTITY", "MISMATCH_FONT_IDENTITY", "MISMATCH_RUN_POSITION",
].map((name) => [name, layoutConstant(`TEXT_COMPARE_${name}`)])));

// The union of the flags whose condition holds: [[condition, flag], ...].
const bits = (pairs) => pairs.reduce((value, [condition, flag]) => condition ? value | flag : value, 0);

const decoder = new TextDecoder();
const recordType = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => value !== null && value !== undefined;

function utf16Input(value) {
  if (!present(value)) return [0, 0];
  const text = String(value);
  const pointer = core.exports.abi_allocate(text.length * Uint16Array.BYTES_PER_ELEMENT);
  const units = new Uint16Array(core.refreshBytes().buffer, pointer, text.length);
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
  return [pointer, text.length];
}

function textInput(value) {
  return present(value) ? core.input(String(value)) : [0, 0];
}

function transportRuns(records, sandom) {
  const pointer = core.exports.abi_allocate(records.length * COMPARE.RUN_SIZE);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const name = textInput(record?.name);
    const text = utf16Input(record?.text);
    const family = textInput(record?.font?.family);
    const advances = Array.isArray(record?.advances) ? record.advances : [];
    const advancePointer = core.exports.abi_allocate(advances.length * Float64Array.BYTES_PER_ELEMENT);
    const numbers = new Float64Array(core.refreshBytes().buffer, advancePointer, advances.length);
    for (let item = 0; item < advances.length; item++) numbers[item] = typeof advances[item] === "number" ? advances[item] : NaN;
    // Join text is a transport encoding of the host collection, including its
    // null and nested-array conversion. Native code compares the encodings.
    const joinable = typeof record?.glyphIds?.join === "function";
    const joined = joinable ? record.glyphIds.join(",") : undefined;
    const glyphs = textInput(joined);
    const bounds = sandom ? record?.geometry : record?.bounds;
    const flags = bits([[recordType(record), COMPARE.RUN_IS_RECORD], [Array.isArray(record?.advances), COMPARE.RUN_HAS_ADVANCES],
      [Array.isArray(record?.glyphIds), COMPARE.RUN_HAS_GLYPHS], [Boolean(bounds), COMPARE.RUN_HAS_BOUNDS],
      [typeof record?.name === "string", COMPARE.RUN_NAMED], [present(bounds?.x), COMPARE.RUN_HAS_X],
      [present(bounds?.y), COMPARE.RUN_HAS_Y], [joinable, COMPARE.RUN_JOINABLE], [typeof joined === "string", COMPARE.RUN_JOINED]]);
    const row = pointer + index * COMPARE.RUN_SIZE;
    const view = new DataView(core.refreshBytes().buffer);
    view.setUint32(row + COMPARE.RUN_FLAGS, flags, true);
    view.setUint32(row + COMPARE.RUN_SHADOW, Number(record?.textShadow === true), true);
    const spans = [[COMPARE.RUN_NAME, name], [COMPARE.RUN_TEXT, text], [COMPARE.RUN_FAMILY, family],
      [COMPARE.RUN_ADVANCES, [advancePointer, advances.length]], [COMPARE.RUN_GLYPHS, glyphs]];
    for (const [field, [spanPointer, spanLength]] of spans) {
      view.setUint32(row + field + COMPARE.SPAN_POINTER, spanPointer, true);
      view.setUint32(row + field + COMPARE.SPAN_LENGTH, spanLength, true);
    }
    view.setFloat64(row + COMPARE.RUN_FONT_SIZE, sandom ? Number(record?.fontSize) : 0, true);
    view.setFloat64(row + COMPARE.RUN_UNITS_PER_EM, sandom ? Number(record?.unitsPerEm) : 0, true);
    view.setFloat64(row + COMPARE.RUN_X, Number(bounds?.x), true);
    view.setFloat64(row + COMPARE.RUN_Y, Number(bounds?.y), true);
  }
  return pointer;
}

export function compareTextRendering(chromeMeasurement, sandomDisplayList) {
  const chromeRuns = Array.isArray(chromeMeasurement?.runs) ? chromeMeasurement.runs : [];
  const commands = Array.isArray(sandomDisplayList?.commands) ? sandomDisplayList.commands : [];
  const chromePointer = transportRuns(chromeRuns, false);
  const sandomPointer = transportRuns(commands, true);
  const types = bits([[recordType(chromeMeasurement), COMPARE.CHROME_RECORD],
    [Array.isArray(chromeMeasurement?.runs), COMPARE.CHROME_RUNS], [recordType(sandomDisplayList), COMPARE.SANDOM_RECORD],
    [Array.isArray(sandomDisplayList?.commands), COMPARE.SANDOM_COMMANDS]]);
  const count = core.status("font_compare_text", chromePointer, chromeRuns.length, sandomPointer, commands.length, types);
  const comparison = core.output("font_compare_text");
  const view = comparison.memory();
  const output = comparison.pointer;
  const runs = new Array(count);
  const nativeText = (field) =>
    view.memoryText(decoder, view.getUint32(field + COMPARE.SPAN_POINTER, true), view.getUint32(field + COMPARE.SPAN_LENGTH, true));
  for (let index = 0; index < count; index++) {
    const row = output + COMPARE.HEADER_SIZE + index * COMPARE.PAIR_SIZE;
    const word = (field) => view.getUint32(row + field, true);
    const number = (field) => view.getFloat64(row + field, true);
    const chromeIndex = view.getInt32(row + COMPARE.PAIR_CHROME, true);
    const sandomIndex = view.getInt32(row + COMPARE.PAIR_SANDOM, true);
    const chrome = chromeRuns[chromeIndex];
    const sandom = commands[sandomIndex];
    const flags = word(COMPARE.PAIR_FLAGS);
    const mismatches = [];
    const mismatch = (kind, expected, actual, tolerance) => mismatches.push(Object.freeze({kind, expected, actual, tolerance}));
    const tolerance = number(COMPARE.PAIR_TOLERANCE);
    if (flags & COMPARE.MISMATCH_RUN_COUNT) mismatch("run-count", Number(chromeIndex >= 0), Number(sandomIndex >= 0), 0);
    if (flags & COMPARE.MISMATCH_CHARACTER_COUNT) mismatch("character-count", word(COMPARE.PAIR_CHROME_LENGTH), word(COMPARE.PAIR_SANDOM_LENGTH), 0);
    if (flags & COMPARE.MISMATCH_GLYPH_COUNT) mismatch("glyph-count", word(COMPARE.PAIR_CHROME_GLYPHS), word(COMPARE.PAIR_SANDOM_GLYPHS), 0);
    if (flags & COMPARE.MISMATCH_CUMULATIVE_ADVANCE) {
      mismatch("cumulative-advance", number(COMPARE.PAIR_CHROME_TOTAL), number(COMPARE.PAIR_SANDOM_TOTAL),
        number(COMPARE.PAIR_TOTAL_TOLERANCE));
    }
    if (flags & COMPARE.MISMATCH_ADVANCE_SEQUENCE) {
      const differences = new Array(word(COMPARE.PAIR_DIFFERENCE_COUNT));
      const pointer = word(COMPARE.PAIR_DIFFERENCES);
      for (let item = 0; item < differences.length; item++) {
        const difference = pointer + item * COMPARE.DIFFERENCE_SIZE;
        differences[item] = Object.freeze({
          index: view.getUint32(difference + COMPARE.DIFFERENCE_INDEX, true),
          expected: view.getFloat64(difference + COMPARE.DIFFERENCE_EXPECTED, true),
          actual: view.getFloat64(difference + COMPARE.DIFFERENCE_ACTUAL, true),
          difference: view.getFloat64(difference + COMPARE.DIFFERENCE_DIFFERENCE, true),
        });
      }
      mismatches.push(Object.freeze({kind: "advance-sequence", tolerance, differences: Object.freeze(differences)}));
    }
    if (flags & COMPARE.MISMATCH_GLYPH_IDENTITY) mismatch("glyph-identity", chrome.glyphIds, sandom.glyphIds, 0);
    if (flags & COMPARE.MISMATCH_FONT_IDENTITY) {
      mismatch("font-identity", nativeText(row + COMPARE.PAIR_CHROME_FAMILY), nativeText(row + COMPARE.PAIR_SANDOM_FAMILY), 0);
    }
    if (flags & COMPARE.MISMATCH_RUN_POSITION) {
      mismatch("run-position", {x: number(COMPARE.PAIR_CHROME_X)}, {x: number(COMPARE.PAIR_SANDOM_X)}, tolerance);
    }
    runs[index] = Object.freeze({
      index,
      chromeText: flags & 1 ? chrome?.text ?? null : chrome.text,
      sandomText: flags & 1 ? sandom?.text ?? null : sandom.text,
      matches: flags === 0,
      mismatches: Object.freeze(mismatches),
    });
  }
  return Object.freeze({
    matches: view.getUint32(output + COMPARE.HEADER_MATCHES, true) !== 0,
    chromeRunCount: view.getUint32(output + COMPARE.HEADER_CHROME_COUNT, true),
    sandomRunCount: view.getUint32(output + COMPARE.HEADER_SANDOM_COUNT, true),
    runs: Object.freeze(runs),
  });
}
