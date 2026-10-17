// The coverage index of the registry fallback families
// (design/font-fallback.md, font stack decision 2). tools/generate-font-coverage.js
// writes it from the `cmap` table of each face; createFontRegistry reads it
// (the fallbackFamilies option) and loads its ranges into the renderer
// engine, which looks up the first scalar of each range that no face of the
// authored stack covers.
//
// The index is a rebuildable reflection of the faces it names: a loader that
// finds another format version throws and names the rebuild command, and
// never migrates. Binary, little-endian:
//
//   u32 magic "SFCI", u32 format version,
//   u32 family count, u32 language count,
//   u32 default range count, u32 language range count,
//   the family names, then the language tags: each a u16 UTF-8 byte length
//   and the bytes, then zero padding to a multiple of 4,
//   the ranges, 12 bytes each: u32 first scalar, u32 last scalar,
//   u16 family (0-based), u16 language (0 for a default range, else the
//   1-based index of a language tag).
//
// The default ranges come first, sorted by first scalar, and do not overlap:
// each scalar maps to the first family of the generator's list that covers
// it. A language range maps a scalar to a later family whose lang list names
// the language. Language ranges follow the generator's family order, and
// the first language range that holds a scalar for a language wins.

import { sharedDomCore } from "./dom-wasm/core.js";

export const FONT_COVERAGE_MAGIC = 0x49434653; // "SFCI"
export const FONT_COVERAGE_VERSION = 1;
export const FONT_COVERAGE_RANGE_SIZE = 12;
export const FONT_COVERAGE_REBUILD_COMMAND =
  "deno run --allow-read --allow-write tools/generate-font-coverage.js <configuration.json>";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFontCoverage({ families, languages, defaultRanges, languageRanges }) {
  const [strings] = coverageStringTable([...families, ...languages]);
  const ranges = [...defaultRanges, ...languageRanges];
  const pointer = sharedDomCore.exports.abi_allocate(ranges.length * FONT_COVERAGE_RANGE_SIZE);
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  for (const [index, range] of ranges.entries()) {
    const row = pointer + index * FONT_COVERAGE_RANGE_SIZE;
    view.setUint32(row, range.first, true);
    view.setUint32(row + 4, range.last, true);
    view.setUint16(row + 8, range.family, true);
    view.setUint16(row + 10, range.language, true);
  }
  sharedDomCore.status("font_coverage_encode", strings, families.length, languages.length,
    pointer, defaultRanges.length, languageRanges.length);
  return coverageByteOutput();
}

function coverageByteOutput() {
  return new Uint8Array(sharedDomCore.refreshBytes().buffer, sharedDomCore.exports.abi_output_pointer(),
    sharedDomCore.exports.abi_output_length()).slice();
}

// The families, the language tags, the count of default ranges, and the
// range bytes (a view into `bytes`) of a coverage index. Throws for bytes
// that are not an index of this format version, and for ranges that break
// the order or name an unknown family or language.
export function decodeFontCoverage(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`A font coverage index must be a Uint8Array; it is ${Object.prototype.toString.call(bytes)}`);
  }
  sharedDomCore.status("font_coverage_decode", ...sharedDomCore.byteInput(bytes));
  const pointer = sharedDomCore.exports.abi_output_pointer();
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  const familyCount = view.getUint32(pointer, true);
  const languageCount = view.getUint32(pointer + 4, true);
  const strings = Array.from({ length: familyCount + languageCount }, (_, index) => {
    const row = pointer + 16 + index * 8;
    const offset = view.getUint32(row, true);
    return utf8Decoder.decode(bytes.subarray(offset, offset + view.getUint32(row + 4, true)));
  });
  return {
    families: strings.slice(0, familyCount),
    languages: strings.slice(familyCount),
    defaultCount: view.getUint32(pointer + 8, true),
    ranges: bytes.subarray(view.getUint32(pointer + 12, true)),
  };
}

function coverageStringTable(values) {
  const strings = values.map((value) => utf8Encoder.encode(value));
  const length = strings.length * 8 + strings.reduce((sum, bytes) => sum + bytes.length, 0);
  const pointer = sharedDomCore.exports.abi_allocate(length);
  if (!pointer && length) sharedDomCore.throwIfError();
  const bytes = sharedDomCore.refreshBytes();
  const view = new DataView(bytes.buffer);
  let cursor = pointer + strings.length * 8;
  for (const [index, string] of strings.entries()) {
    view.setUint32(pointer + index * 8, cursor, true);
    view.setUint32(pointer + index * 8 + 4, string.length, true);
    bytes.set(string, cursor);
    cursor += string.length;
  }
  return [pointer, strings.length];
}

// The 1-based index of the language of `coverage` (a decodeFontCoverage
// result) that the content language `lang` selects, or 0: the first tag
// that equals `lang` or is a prefix of it that ends before a "-", compared
// ASCII case-insensitively, as the engine matches ($coverageLanguage).
export function fontCoverageLanguage(coverage, lang) {
  return sharedDomCore.status("font_coverage_language", ...coverageStringTable(coverage.languages),
    ...sharedDomCore.input(String(lang)), Number(Boolean(lang)));
}

// The family that `coverage` selects for `scalar` in text of the 1-based
// coverage language `language` (0 for none), or null: a language range of
// that language first, then the default range that holds `scalar`, as the
// engine looks up ($coverageFamily).
export function fontCoverageFamily(coverage, scalar, language) {
  const index = sharedDomCore.status("font_coverage_family", ...sharedDomCore.byteInput(coverage.ranges),
    coverage.defaultCount, scalar, language);
  return index < 0 ? null : coverage.families[index];
}

function coverageRangeTable(ranges) {
  const pointer = sharedDomCore.exports.abi_allocate(ranges.length * 8);
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  for (const [index, [first, last]] of ranges.entries()) {
    view.setUint32(pointer + index * 8, first, true);
    view.setUint32(pointer + index * 8 + 4, last, true);
  }
  return [pointer, ranges.length];
}

function coverageRangeOutput(count) {
  const pointer = sharedDomCore.exports.abi_output_pointer();
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  return Array.from({ length: count }, (_, index) => [
    view.getUint32(pointer + index * 8, true), view.getUint32(pointer + index * 8 + 4, true),
  ]);
}

// The sorted, disjoint [first, last] scalar ranges that the `cmap` table of
// the font at `bytes` maps to a glyph other than 0. Reads the Unicode
// subtables: format 12 (full repertoire) before format 4 (BMP).
export function fontCmapRanges(bytes, faceIndex) {
  const index = sharedDomCore.status("font_face_index",
    typeof faceIndex === "number" ? faceIndex : 0,
    faceIndex === undefined ? 0 : typeof faceIndex === "number" ? 1 : 2) >>> 0;
  return coverageRangeOutput(sharedDomCore.status("font_cmap_ranges",
    ...sharedDomCore.byteInput(bytes), index));
}

// [first, last] ranges of `ranges` that `covered` (sorted, disjoint) does
// not cover.
export function subtractRanges(ranges, covered) {
  return coverageRangeOutput(sharedDomCore.status("font_ranges_subtract",
    ...coverageRangeTable(ranges), ...coverageRangeTable(covered)));
}

// The index of `families`, each { family, coverage: sorted disjoint
// [first, last] ranges, lang: [tags] }, in priority order. The language
// tags are ordered longest first: the engine selects the first tag that
// equals the content language or is a prefix of it, so "zh-TW" must come
// before "zh".
export function buildFontCoverage(families) {
  const rows = families.map((family) => ({
    name: sharedDomCore.byteInput(utf8Encoder.encode(family.family)),
    ranges: coverageRangeTable(family.coverage),
    languages: coverageStringTable(Array.isArray(family.lang) ? family.lang : []),
    languageKind: family.lang === undefined ? 0 : Array.isArray(family.lang) ? 1 : 2,
  }));
  const pointer = sharedDomCore.exports.abi_allocate(rows.length * 32);
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  for (const [index, row] of rows.entries()) {
    const offset = pointer + index * 32;
    view.setUint32(offset, row.name[0], true);
    view.setUint32(offset + 4, row.name[1], true);
    view.setUint32(offset + 8, row.ranges[0], true);
    view.setUint32(offset + 12, row.ranges[1], true);
    view.setUint32(offset + 16, row.languages[0], true);
    view.setUint32(offset + 20, row.languages[1], true);
    view.setUint32(offset + 24, row.languageKind, true);
  }
  sharedDomCore.status("font_coverage_build", pointer, rows.length);
  return coverageByteOutput();
}
