// The glyph-position check (plans/text/PLAN-text-ink-approval.md, "Check 2"):
// every glyph advance and position of a display list against the font's
// own data.
//
// Truth. Each glyph's advance is the hmtx advance plus its HVAR delta at
// the text command's instance, with the OpenType 2.14 coordinate
// normalization (src/wasm/text-advance-reference.wat). Kerning and mark
// offsets are HarfBuzz's GPOS result for the run, called directly: the
// kerning of a glyph is its advance with the `kern` feature minus its
// advance without it.
//
// Sandom's position format, the one rule between the truth and the
// display list: the shaper stores each advance and each kerning value in
// whole 1/512 font units (FONT_UNIT_SUBDIVISION), each rounded to nearest
// on its own, and the painter accumulates pen positions in f32 font units.
// Letter spacing adds truncated 1/512-font-unit steps to each advance,
// with the same f32 conversion as the shaper. Collapsed spaces and the
// standalone ellipsis marker have no added spacing.
// A glyph passes only when Sandom's advance and position equal the truth
// under that rule exactly.

import { instantiate } from "../wasm/text-advance-reference-binary.js";
import { shapeFontText } from "../shaping.js";

// Sandom's shaper holds each unscaled advance in f32 before scaling it to
// 1/512 font units, so an exact value within this many steps of a rounding
// tie may round either way. Measured 2026-09-28: the 80 Inter glyphs that
// round the other way lie within 0.031 step of a tie (f32 resolution at
// about 1,250 font units is 1/16 of a step). Approved as part of the
// format: the shift is at most 0.00003 CSS px per glyph.
const NEAR_TIE_STEPS = 1 / 32;

export const FONT_UNIT_SUBDIVISION = 512;

const STATUS_MESSAGES = new Map([
  [-1, "the bytes are not a TrueType or OpenType font"],
  [-2, "the advance module could not grow its memory"],
  [-3, "a required table (hhea, hmtx, head) is missing"],
  [-4, "a variable font has no HVAR table; the reference does not read gvar phantom points"],
  [-5, "a table lies outside the font"],
  [-6, "an axis index is out of range"],
]);

const f32 = Math.fround;
const ELLIPSIS = "\u2026";
// Space, tab and line feed: the characters white-space collapsing removes.
const COLLAPSIBLE_BYTES = new Set([0x20, 0x09, 0x0A]);

function statusError(status, context) {
  return new Error(`text advance reference: ${STATUS_MESSAGES.get(status) ?? `unknown status ${status}`} (${context})`);
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
    if (pointer === 0) throw statusError(-2, label);
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
    load(fontBytes, label);
    const axisCount = exports.font_load();
    const normalized = {};
    for (let index = 0; index < axisCount; index++) {
      const tag = tagName(exports.axis_tag(index));
      if (Object.hasOwn(coordinates, tag)) {
        const status = exports.axis_set(index, coordinates[tag]);
        if (status < 0) throw statusError(status, `${label}, axis ${tag}`);
      }
      normalized[tag] = exports.axis_normalized(index) / 16384;
    }
    return {
      upem: exports.units_per_em(),
      normalized,
      advances: glyphIds.map((glyphId) => {
        const advance = exports.advance(glyphId);
        if (Number.isNaN(advance)) {
          throw new Error(`text advance reference: the HVAR mapping of glyph ${glyphId} names an item outside the variation store (${label})`);
        }
        return advance;
      }),
    };
  }

  return Object.freeze({ advances });
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
 *   and the truth's advance and position in CSS pixels
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
    const coordinates = { wght: command.fontWeight, opsz: command.fontSize };
    if (Number.isFinite(command.font.slant)) coordinates.slnt = command.font.slant;
    if (Number.isFinite(command.font.stretch)) coordinates.wdth = command.font.stretch;
    const variations = Object.entries(coordinates);
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
    const unkerned = await shape([...command.features, ["kern", 0]]);
    const shapedIds = kerned.glyphs.map((glyph) => glyph.g);
    // A run truncated by text-overflow: ellipsis holds a prefix of its
    // shaped glyphs and then the marker, which is shaped alone and starts
    // at the prefix's width ceiled to a LayoutUnit (Blink's LineTruncator).
    const whole = shapedIds.length === command.glyphIds.length &&
      shapedIds.every((id, index) => id === command.glyphIds[index]);
    const kept = command.glyphIds.length - 1;
    const markerId = command.text.endsWith(ELLIPSIS)
      ? (await shapeFontText(fontBytes, ELLIPSIS, command.fontSize, { variations, unitScale: FONT_UNIT_SUBDIVISION })).glyphs[0].g
      : null;
    const truncated = !whole && markerId !== null && command.glyphIds.at(-1) === markerId &&
      command.glyphIds.slice(0, kept).every((id, index) => id === shapedIds[index]);
    if (!whole && !truncated) {
      throw new Error(`textPositionTruthDiff: ${label} shapes to glyphs ${JSON.stringify(shapedIds)} in its node's text but the display list holds ${JSON.stringify(command.glyphIds)}; the check needs the run's own glyphs`);
    }
    const { upem, advances } = reference.advances(fontBytes, coordinates, command.glyphIds, label);
    if (upem !== command.unitsPerEm) {
      throw new Error(`textPositionTruthDiff: ${label} names ${command.unitsPerEm} units per em; the font's head table holds ${upem}`);
    }
    // The artifact converts f32 font units to pixels as value * fontSize / upem.
    const pixels = (value) => value * command.fontSize / upem;
    const sourceBytes = new TextEncoder().encode(command.sourceText);
    let cursor = 0;
    for (let index = 0; index < command.glyphIds.length; index++) {
      glyphs++;
      const marker = truncated && index === kept;
      // White-space collapsing (a layout decision the layout tests check)
      // removes a space's advance: the truth for a collapsed space is zero.
      const collapsed = !marker && command.advances[index] === 0 &&
        COLLAPSIBLE_BYTES.has(sourceBytes[command.clusters[index].start]);
      const kerning = marker || collapsed ? 0 : kerned.glyphs[index].ax - unkerned.glyphs[index].ax;
      const spacing = marker || collapsed ? 0 : Math.trunc(f32(
        f32(f32(command.letterSpacing ?? 0) * f32(upem * FONT_UNIT_SUBDIVISION)) / command.fontSize,
      ));
      const scaled = collapsed ? 0 : advances[index] * FONT_UNIT_SUBDIVISION;
      // Near a rounding tie either neighbouring step is the format's value
      // (NEAR_TIE_STEPS); the pen then follows the step Sandom stored.
      const nearest = Math.round(scaled);
      const other = scaled < nearest ? nearest - 1 : nearest + 1;
      const nearTie = Math.abs(scaled - Math.floor(scaled) - 0.5) <= NEAR_TIE_STEPS;
      const candidates = nearTie ? [nearest, other] : [nearest];
      const truthPosition = marker
        ? Math.ceil(pixels(cursor) * 64) / 64
        : pixels(f32(cursor + kerned.glyphs[index].dx / FONT_UNIT_SUBDIVISION));
      const chosen = candidates.find((steps) => pixels(f32((steps + kerning + spacing) / FONT_UNIT_SUBDIVISION)) === command.advances[index]);
      const advance = f32(((chosen ?? nearest) + kerning + spacing) / FONT_UNIT_SUBDIVISION);
      const truthAdvance = pixels(advance);
      // The marker's stored position passes through f32 font units, so it
      // matches the snapped LayoutUnit at f32 precision.
      const positionMatches = marker
        ? f32(command.glyphPositions[index]) === f32(truthPosition)
        : command.glyphPositions[index] === truthPosition;
      if (chosen === undefined || !positionMatches) {
        failures.push({
          command: command.commandIndex, text: command.text, index, glyphId: command.glyphIds[index],
          sandom: { advance: command.advances[index], position: command.glyphPositions[index] },
          truth: { advance: truthAdvance, position: truthPosition, exactAdvance: pixels(advances[index] + (kerning + spacing) / FONT_UNIT_SUBDIVISION) },
        });
      }
      cursor = f32(cursor + advance);
    }
  }
  return { pass: failures.length === 0, glyphs, failures };
}
