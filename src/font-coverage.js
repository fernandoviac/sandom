// The coverage index of the registry fallback families
// (plans/PLAN-font-fallback.md, decision 2). tools/generate-font-coverage.js
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

export const FONT_COVERAGE_MAGIC = 0x49434653; // "SFCI"
export const FONT_COVERAGE_VERSION = 1;
export const FONT_COVERAGE_RANGE_SIZE = 12;
export const FONT_COVERAGE_REBUILD_COMMAND =
  "deno run --allow-read --allow-write tools/generate-font-coverage.js <configuration.json>";

const HEADER_SIZE = 24;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFontCoverage({ families, languages, defaultRanges, languageRanges }) {
  const strings = [...families, ...languages].map((value) => utf8Encoder.encode(value));
  for (const [index, bytes] of strings.entries()) {
    if (bytes.length > 0xFFFF) {
      throw new RangeError(`Coverage string ${index} is ${bytes.length} bytes; the limit is 65535`);
    }
  }
  if (families.length > 0xFFFF || languages.length >= 0xFFFF) {
    throw new RangeError(
      `Coverage index has ${families.length} families and ${languages.length} languages; the limit is 65535 each`,
    );
  }
  const stringBytes = strings.reduce((sum, bytes) => sum + 2 + bytes.length, 0);
  const rangeOffset = HEADER_SIZE + Math.ceil(stringBytes / 4) * 4;
  const ranges = [...defaultRanges, ...languageRanges];
  const bytes = new Uint8Array(rangeOffset + ranges.length * FONT_COVERAGE_RANGE_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, FONT_COVERAGE_MAGIC, true);
  view.setUint32(4, FONT_COVERAGE_VERSION, true);
  view.setUint32(8, families.length, true);
  view.setUint32(12, languages.length, true);
  view.setUint32(16, defaultRanges.length, true);
  view.setUint32(20, languageRanges.length, true);
  let offset = HEADER_SIZE;
  for (const string of strings) {
    view.setUint16(offset, string.length, true);
    bytes.set(string, offset + 2);
    offset += 2 + string.length;
  }
  offset = rangeOffset;
  for (const { first, last, family, language = 0 } of ranges) {
    view.setUint32(offset, first, true);
    view.setUint32(offset + 4, last, true);
    view.setUint16(offset + 8, family, true);
    view.setUint16(offset + 10, language, true);
    offset += FONT_COVERAGE_RANGE_SIZE;
  }
  return bytes;
}

// The families, the language tags, the count of default ranges, and the
// range bytes (a view into `bytes`) of a coverage index. Throws for bytes
// that are not an index of this format version, and for ranges that break
// the order or name an unknown family or language.
export function decodeFontCoverage(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`A font coverage index must be a Uint8Array; it is ${Object.prototype.toString.call(bytes)}`);
  }
  if (bytes.length < HEADER_SIZE) {
    throw new RangeError(`A font coverage index has at least ${HEADER_SIZE} bytes; this one has ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== FONT_COVERAGE_MAGIC) {
    throw new Error(
      `Bytes are not a font coverage index: magic 0x${magic.toString(16)}, expected 0x${FONT_COVERAGE_MAGIC.toString(16)}`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== FONT_COVERAGE_VERSION) {
    throw new Error(
      `Font coverage index format version ${version} is not the supported version ${FONT_COVERAGE_VERSION}; ` +
        `rebuild the index with: ${FONT_COVERAGE_REBUILD_COMMAND}`,
    );
  }
  const familyCount = view.getUint32(8, true);
  const languageCount = view.getUint32(12, true);
  const defaultCount = view.getUint32(16, true);
  const languageRangeCount = view.getUint32(20, true);
  const strings = [];
  let offset = HEADER_SIZE;
  for (let index = 0; index < familyCount + languageCount; index++) {
    if (offset + 2 > bytes.length) throw new RangeError(`Font coverage index string ${index} starts past its end`);
    const length = view.getUint16(offset, true);
    if (offset + 2 + length > bytes.length) throw new RangeError(`Font coverage index string ${index} ends past its end`);
    strings.push(utf8Decoder.decode(bytes.subarray(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  const rangeOffset = Math.ceil(offset / 4) * 4;
  const rangeCount = defaultCount + languageRangeCount;
  const rangeBytes = rangeCount * FONT_COVERAGE_RANGE_SIZE;
  if (rangeOffset + rangeBytes !== bytes.length) {
    throw new RangeError(
      `Font coverage index has ${bytes.length} bytes; its header states ${rangeOffset + rangeBytes}`,
    );
  }
  let previousLast = -1;
  for (let index = 0; index < rangeCount; index++) {
    const at = rangeOffset + index * FONT_COVERAGE_RANGE_SIZE;
    const first = view.getUint32(at, true);
    const last = view.getUint32(at + 4, true);
    const family = view.getUint16(at + 8, true);
    const language = view.getUint16(at + 10, true);
    const isDefault = index < defaultCount;
    if (first > last || last > 0x10FFFF || family >= familyCount ||
      (isDefault ? language !== 0 : language === 0 || language > languageCount) ||
      (isDefault && first <= previousLast)) {
      throw new RangeError(
        `Font coverage index range ${index} (U+${first.toString(16)}..U+${last.toString(16)}, family ${family}, ` +
          `language ${language}) is out of order or names an unknown family or language`,
      );
    }
    if (isDefault) previousLast = last;
  }
  return {
    families: strings.slice(0, familyCount),
    languages: strings.slice(familyCount),
    defaultCount,
    ranges: bytes.subarray(rangeOffset),
  };
}

// The 1-based index of the language of `coverage` (a decodeFontCoverage
// result) that the content language `lang` selects, or 0: the first tag
// that equals `lang` or is a prefix of it that ends before a "-", compared
// ASCII case-insensitively, as the engine matches ($coverageLanguage).
export function fontCoverageLanguage(coverage, lang) {
  if (!lang) return 0;
  const tag = lang.toLowerCase();
  const index = coverage.languages.findIndex((candidate) => {
    const prefix = candidate.toLowerCase();
    return tag === prefix || tag.startsWith(`${prefix}-`);
  });
  return index + 1;
}

// The family that `coverage` selects for `scalar` in text of the 1-based
// coverage language `language` (0 for none), or null: a language range of
// that language first, then the default range that holds `scalar`, as the
// engine looks up ($coverageFamily).
export function fontCoverageFamily(coverage, scalar, language) {
  const view = new DataView(coverage.ranges.buffer, coverage.ranges.byteOffset, coverage.ranges.byteLength);
  const rangeCount = coverage.ranges.byteLength / FONT_COVERAGE_RANGE_SIZE;
  for (let index = coverage.defaultCount; language !== 0 && index < rangeCount; index++) {
    const offset = index * FONT_COVERAGE_RANGE_SIZE;
    if (view.getUint16(offset + 10, true) === language &&
      scalar >= view.getUint32(offset, true) && scalar <= view.getUint32(offset + 4, true)) {
      return coverage.families[view.getUint16(offset + 8, true)];
    }
  }
  let low = 0;
  let high = coverage.defaultCount - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const offset = middle * FONT_COVERAGE_RANGE_SIZE;
    if (scalar < view.getUint32(offset, true)) high = middle - 1;
    else if (scalar > view.getUint32(offset + 4, true)) low = middle + 1;
    else return coverage.families[view.getUint16(offset + 8, true)];
  }
  return null;
}

// The sorted, disjoint [first, last] scalar ranges that the `cmap` table of
// the font at `bytes` maps to a glyph other than 0. Reads the Unicode
// subtables: format 12 (full repertoire) before format 4 (BMP).
export function fontCmapRanges(bytes, faceIndex = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let directory = 0;
  if (view.getUint32(0) === 0x74746366) { // "ttcf"
    const count = view.getUint32(8);
    if (faceIndex >= count) throw new RangeError(`Font collection has ${count} faces; face ${faceIndex} requested`);
    directory = view.getUint32(12 + faceIndex * 4);
  }
  const tableCount = view.getUint16(directory + 4);
  let cmap = -1;
  for (let index = 0; index < tableCount; index++) {
    const record = directory + 12 + index * 16;
    if (view.getUint32(record) === 0x636D6170) cmap = view.getUint32(record + 8); // "cmap"
  }
  if (cmap < 0) throw new Error("Font has no cmap table");
  const subtables = [];
  for (let index = 0; index < view.getUint16(cmap + 2); index++) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (format === 12 || format === 4)) subtables.push({ format, offset });
  }
  const chosen = subtables.find((table) => table.format === 12) ?? subtables.find((table) => table.format === 4);
  if (!chosen) throw new Error("Font has no Unicode cmap subtable of format 4 or 12");
  const ranges = [];
  const add = (first, last) => {
    const previous = ranges.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else ranges.push([first, last]);
  };
  if (chosen.format === 12) {
    const groups = view.getUint32(chosen.offset + 12);
    for (let index = 0; index < groups; index++) {
      const group = chosen.offset + 16 + index * 12;
      const first = view.getUint32(group);
      const last = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      // A group that starts at glyph 0 maps its first scalar to .notdef.
      if (glyph === 0) {
        if (first < last) add(first + 1, last);
      } else {
        add(first, last);
      }
    }
  } else {
    const segments = view.getUint16(chosen.offset + 6) / 2;
    const ends = chosen.offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment++) {
      const first = view.getUint16(starts + segment * 2);
      const last = view.getUint16(ends + segment * 2);
      if (first === 0xFFFF) continue;
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
      for (let scalar = first; scalar <= last; scalar++) {
        let glyph;
        if (rangeOffset === 0) {
          glyph = (scalar + delta) & 0xFFFF;
        } else {
          const at = rangeOffsets + segment * 2 + rangeOffset + (scalar - first) * 2;
          glyph = view.getUint16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
        }
        if (glyph !== 0) add(scalar, scalar);
      }
    }
  }
  return ranges;
}

// [first, last] ranges of `ranges` that `covered` (sorted, disjoint) does
// not cover.
export function subtractRanges(ranges, covered) {
  const result = [];
  let cursor = 0;
  for (let [first, last] of ranges) {
    while (cursor < covered.length && covered[cursor][1] < first) cursor++;
    let index = cursor;
    while (first <= last) {
      const block = covered[index];
      if (!block || block[0] > last) {
        result.push([first, last]);
        break;
      }
      if (block[0] > first) result.push([first, block[0] - 1]);
      first = Math.max(first, block[1] + 1);
      index++;
    }
  }
  return result;
}

function unionRanges(left, right) {
  const all = [...left, ...right].sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [first, last] of all) {
    const previous = result.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else result.push([first, last]);
  }
  return result;
}

// The index of `families`, each { family, coverage: sorted disjoint
// [first, last] ranges, lang: [tags] }, in priority order. The language
// tags are ordered longest first: the engine selects the first tag that
// equals the content language or is a prefix of it, so "zh-TW" must come
// before "zh".
export function buildFontCoverage(families) {
  const names = families.map(({ family }) => family);
  if (new Set(names).size !== names.length) throw new Error(`Coverage families repeat a name: ${names.join(", ")}`);
  const languages = [...new Set(families.flatMap(({ lang = [] }) => lang))].sort((a, b) => b.length - a.length);
  let covered = [];
  const defaults = [];
  const owned = [];
  for (const [family, { coverage }] of families.entries()) {
    const pieces = subtractRanges(coverage, covered);
    owned.push(pieces);
    for (const [first, last] of pieces) defaults.push({ first, last, family, language: 0 });
    covered = unionRanges(covered, pieces);
  }
  defaults.sort((a, b) => a.first - b.first);
  const languageRanges = [];
  for (const [family, { coverage, lang = [] }] of families.entries()) {
    const preferred = subtractRanges(coverage, owned[family]);
    for (const tag of lang) {
      const language = languages.indexOf(tag) + 1;
      for (const [first, last] of preferred) languageRanges.push({ first, last, family, language });
    }
  }
  return encodeFontCoverage({ families: names, languages, defaultRanges: defaults, languageRanges });
}
