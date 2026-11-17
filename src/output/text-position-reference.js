// The glyph-position check (design/parity-methodology.md, "Text truth checks", check 2):
// every glyph advance and position of a display list against the font's
// own data.
//
// Truth. Each glyph's advance is the hmtx advance plus its HVAR delta at
// the text command's instance, with the OpenType 2.14 coordinate
// normalization (core/engine/text-advance-reference.wat). Kerning, cursive
// attachment and mark offsets are HarfBuzz's GPOS result for the run,
// called directly: the kerning of a glyph is its advance with the `kern`
// and `curs` features minus its advance without them.
//
// Sandom's position format, the one rule between the truth and the
// display list: the shaper stores each advance, each kerning value and
// each HarfBuzz x and y offset in whole 1/512 font units
// (FONT_UNIT_SUBDIVISION), each rounded to nearest on its own, and the
// painter accumulates pen positions in f64 font units. A glyph's position
// is its pen plus its x offset in font units, rounded to f32; its ink
// height above the baseline is its y offset in f32 font units.
// Letter spacing adds truncated 1/512-font-unit steps to each advance,
// with the same f32 conversion as the shaper. Collapsed spaces and the
// standalone ellipsis marker have no added spacing. Sandom's shaper holds
// each unscaled advance in f32 before it scales it, so an exact value
// within 1/32 step of a rounding tie may round either way (measured
// 2026-09-28: the 80 Inter glyphs that round the other way lie within
// 0.031 step of a tie; the shift is at most 0.00003 CSS px per glyph).
// A glyph passes only when Sandom's advance and position equal the truth
// under that rule exactly. `run_check` of the reference module applies
// the rule; this binding shapes the runs and copies the records.

import * as textAdvanceReferenceBinary from "../wasm/text-advance-reference-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";
import { shapeFontText } from "../shaping.js";
import {
  checkError, createTextInkCheck, STATUS_ALLOCATION_FAILED, STATUS_TABLE, statusError as checkStatusError, textCommandVariations, throwCheck,
  UNMAPPED_GLYPH_TEMPLATE,
} from "./text-ink-reference.js";

const { instantiate } = textAdvanceReferenceBinary;
const ELLIPSIS = "\u2026";
// The glyph record of run_check (text-advance-reference.wat RUN_*): the
// field count, each field's index and the unmapped glyph status.
const referenceConstant = moduleLayoutConstants(textAdvanceReferenceBinary, "text advance reference");
const RUN = Object.freeze(Object.fromEntries([
  "FIELDS", "GLYPH", "SANDOM_ADVANCE", "SANDOM_POSITION", "KERNED_ADVANCE", "UNKERNED_ADVANCE", "KERNED_X",
  "SOURCE_BYTE", "KERNED_Y", "TRUTH_ADVANCE", "TRUTH_POSITION", "EXACT_ADVANCE", "PASSES", "SANDOM_INK", "TRUTH_INK",
  "UNMAPPED_GLYPH",
].map((name) => [name, referenceConstant(`RUN_${name}`)])));
export const FONT_UNIT_SUBDIVISION = referenceConstant("FONT_UNIT_SUBDIVISION");
const check = createTextInkCheck();

function statusError(status, context) {
  return checkStatusError(check, STATUS_TABLE.advance, status, context, "text advance reference");
}

function tagName(tag) {
  return String.fromCharCode((tag >>> 24) & 255, (tag >>> 16) & 255, (tag >>> 8) & 255, tag & 255);
}

// The exact advances, in f64 font units, of glyphs at a user-coordinate
// instance of a font.
export function createTextAdvanceReference() {
  const exports = instantiate({}).exports;
  let loaded = null;

  function load(fontBytes, label) {
    if (loaded === fontBytes) return;
    const pointer = exports.font_buffer(fontBytes.length);
    if (pointer === 0) throw statusError(STATUS_ALLOCATION_FAILED, label);
    new Uint8Array(exports.memory.buffer, pointer, fontBytes.length).set(fontBytes);
    const status = exports.font_load();
    if (status < 0) throw statusError(status, label);
    loaded = fontBytes;
  }

  /**
   * @param {Uint8Array} fontBytes
   * @param {Record<string, number>} coordinates user coordinates by axis tag;
   *   axes the font lacks are ignored, axes it has and the map omits sit
   *   at their default
   * @param {number[]} glyphIds
   * @param {string} [label] names the run in errors
   * @returns {{upem: number, advances: number[], normalized: Record<string, number>}}
   */
  function advances(fontBytes, coordinates, glyphIds, label = "font") {
    instance(fontBytes, coordinates, label);
    return {
      upem: exports.units_per_em(),
      normalized: normalizedCoordinates(),
      advances: glyphIds.map((glyphId) => {
        const advance = exports.advance(glyphId);
        if (Number.isNaN(advance)) throw unmappedGlyphError(glyphId, label);
        return advance;
      }),
    };
  }

  function instance(fontBytes, coordinates, label) {
    load(fontBytes, label);
    const axisCount = exports.font_load();
    for (let index = 0; index < axisCount; index++) {
      const tag = tagName(exports.axis_tag(index));
      if (Object.hasOwn(coordinates, tag)) {
        const status = exports.axis_set(index, coordinates[tag]);
        if (status < 0) throw statusError(status, `${label}, axis ${tag}`);
      }
    }
  }

  function normalizedCoordinates() {
    const normalized = {};
    const axisCount = exports.font_load();
    for (let index = 0; index < axisCount; index++) {
      normalized[tagName(exports.axis_tag(index))] = exports.axis_normalized(index) / 16384;
    }
    return normalized;
  }

  // Writes a run's glyph records into the run workspace of the loaded font.
  function run(fontBytes, label, records) {
    load(fontBytes, label);
    const pointer = exports.run_buffer(records.length / RUN.FIELDS);
    if (pointer < 0) throw statusError(pointer, label);
    new Float64Array(exports.memory.buffer, pointer, records.length).set(records);
  }

  return Object.freeze({ advances, instance, run, exports });
}

function unmappedGlyphError(glyphId, label) {
  return checkError(check, UNMAPPED_GLYPH_TEMPLATE, "text advance reference", label, glyphId);
}

/**
 * Compares every glyph advance and position of a display list with the
 * font's data under Sandom's position format.
 *
 * @param {object} options
 * @param {object} options.displayList createDisplayListArtifact(scene)
 * @param {(font: object) => Uint8Array} options.resolveFontBytes
 * @returns {Promise<{pass: boolean, glyphs: number, failures: object[]}>}
 *   each failure names the text command, glyph index and id, and Sandom's
 *   and the truth's advance, position and ink height in CSS pixels
 */
export async function textPositionTruthDiff({ displayList, resolveFontBytes }) {
  const reference = createTextAdvanceReference();
  const failures = [];
  let glyphs = 0;
  for (const command of displayList.commands) {
    if (command.name !== "text" || command.glyphIds.length === 0) continue;
    const label = `text command ${command.commandIndex} "${command.text}"`;
    const fontBytes = resolveFontBytes(command.font);
    if (!(fontBytes instanceof Uint8Array)) {
      throw new TypeError(`textPositionTruthDiff: resolveFontBytes returned no bytes for ${label}`);
    }
    const base = [["wght", command.fontWeight]];
    if (Number.isFinite(command.font.slant)) base.push(["slnt", command.font.slant]);
    if (Number.isFinite(command.font.stretch)) base.push(["wdth", command.font.stretch]);
    const variations = textCommandVariations(command, base);
    const coordinates = Object.fromEntries(variations);
    // The run's glyphs were shaped in the node's whole text: a line
    // fragment's glyphs take their context (contextual alternates, kerning
    // into the next line) from it. Shape the whole text and keep the
    // fragment's clusters.
    const clusterStart = Math.min(...command.clusters.map((cluster) => cluster.start));
    const clusterEnd = Math.max(...command.clusters.map((cluster) => cluster.end));
    const shape = async (features) => {
      const shaped = await shapeFontText(fontBytes, command.sourceText, command.fontSize, { variations, features, unitScale: FONT_UNIT_SUBDIVISION });
      return { ...shaped, glyphs: shaped.glyphs.filter((glyph) => glyph.cl >= clusterStart && glyph.cl < clusterEnd) };
    };
    const kerned = await shape(command.features);
    const unkerned = await shape([...command.features, ["kern", 0], ["curs", 0]]);
    const shapedIds = kerned.glyphs.map((glyph) => glyph.g);
    // A run truncated by text-overflow: ellipsis holds a prefix of its
    // shaped glyphs and then the marker, which is shaped alone and starts
    // at the prefix's width ceiled to a LayoutUnit (Blink's LineTruncator).
    const markerId = command.text.endsWith(ELLIPSIS)
      ? (await shapeFontText(fontBytes, ELLIPSIS, command.fontSize, { variations, unitScale: FONT_UNIT_SUBDIVISION })).glyphs[0].g
      : -1;
    const sourceBytes = new TextEncoder().encode(command.sourceText);
    const records = new Float64Array(command.glyphIds.length * RUN.FIELDS);
    for (let index = 0; index < command.glyphIds.length; index++) {
      const record = index * RUN.FIELDS;
      records[record + RUN.GLYPH] = command.glyphIds[index];
      records[record + RUN.SANDOM_ADVANCE] = command.advances[index];
      records[record + RUN.SANDOM_POSITION] = command.glyphPositions[index];
      records[record + RUN.KERNED_ADVANCE] = kerned.glyphs[index]?.ax ?? NaN;
      records[record + RUN.UNKERNED_ADVANCE] = unkerned.glyphs[index]?.ax ?? NaN;
      records[record + RUN.KERNED_X] = kerned.glyphs[index]?.dx ?? NaN;
      records[record + RUN.SOURCE_BYTE] = sourceBytes[command.clusters[index].start] ?? NaN;
      records[record + RUN.KERNED_Y] = kerned.glyphs[index]?.dy ?? NaN;
      records[record + RUN.SANDOM_INK] = command.glyphInkY[index];
    }
    const glyphIds = check.glyph_ids_input(command.glyphIds.length, shapedIds.length);
    if (glyphIds === 0) throw new Error(`textPositionTruthDiff: the check module could not grow its memory for ${label}`);
    new Int32Array(check.memory.buffer, glyphIds, command.glyphIds.length + shapedIds.length).set([...command.glyphIds, ...shapedIds]);
    const match = check.glyph_shape_match(markerId);
    throwCheck(check, match < 0 ? -match : 0, "", label, JSON.stringify(shapedIds), JSON.stringify(command.glyphIds));
    reference.instance(fontBytes, coordinates, label);
    reference.run(fontBytes, label, records);
    const failed = reference.exports.run_check(command.fontSize, command.letterSpacing ?? 0, match);
    if (failed === RUN.UNMAPPED_GLYPH) throw unmappedGlyphError(reference.exports.failed_glyph(), label);
    const upem = reference.exports.units_per_em();
    throwCheck(check, check.units_per_em_check(command.unitsPerEm, upem), "", label, command.unitsPerEm, upem);
    glyphs += command.glyphIds.length;
    if (failed === 0) continue;
    const checked = new Float64Array(reference.exports.memory.buffer, reference.exports.run_buffer(command.glyphIds.length), records.length);
    for (let index = 0; index < command.glyphIds.length; index++) {
      const record = index * RUN.FIELDS;
      if (checked[record + RUN.PASSES] === 1) continue;
      failures.push({
        command: command.commandIndex, text: command.text, index, glyphId: command.glyphIds[index],
        sandom: { advance: command.advances[index], position: command.glyphPositions[index], inkY: command.glyphInkY[index] },
        truth: {
          advance: checked[record + RUN.TRUTH_ADVANCE], position: checked[record + RUN.TRUTH_POSITION],
          exactAdvance: checked[record + RUN.EXACT_ADVANCE], inkY: checked[record + RUN.TRUTH_INK],
        },
      });
    }
  }
  return { pass: failures.length === 0, glyphs, failures };
}
