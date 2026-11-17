// CSS Custom Highlight API 1: Highlight, the setlike of the ranges that one
// ::highlight(name) styles, and HighlightRegistry, the maplike behind
// CSS.highlights. The registry gives the core its document's overlays in
// painting order (core/dom/highlights.watpart highlight_registry_set); the
// core reads a live Range's boundary points at each frame.
import { SDAbstractRange, SDRange, SDStaticRange } from "./selection.js";
import { findTextDirective, searchRanges } from "./text-search.js";
import { CSS } from "./stylesheet.js";
import { layoutConstant } from "../wasm/layout-table.js";

const HIGHLIGHT_RECORD_SIZE = layoutConstant("HIGHLIGHT_RECORD_SIZE");
const HIGHLIGHT_RANGE_LIVE = layoutConstant("HIGHLIGHT_RANGE_LIVE");
const HIGHLIGHT_RANGE_STATIC = layoutConstant("HIGHLIGHT_RANGE_STATIC");
const HIGHLIGHT_TYPES = new Set(["highlight", "spelling-error", "grammar-error"]);
const registryToken = Symbol("HighlightRegistry");

function requireAbstractRange(range, method, interfaceName) {
  if (!(range instanceof SDAbstractRange)) {
    throw new TypeError(`Failed to execute '${method}' on '${interfaceName}': parameter 1 is not of type 'AbstractRange'.`);
  }
}

// WebIDL long: ToNumber, then modulo 2^32 into the signed range.
function toLong(value) {
  return Number(value) | 0;
}

export class Highlight {
  #ranges = new Set();
  #priority = 0;
  #type = "highlight";
  constructor(...initialRanges) {
    // The registries that hold this highlight, each with its names.
    this._registries = new Set();
    for (const range of initialRanges) this.add(range);
  }
  get priority() {
    return this.#priority;
  }
  set priority(value) {
    this.#priority = toLong(value);
    this._changed();
  }
  get type() {
    return this.#type;
  }
  set type(value) {
    // An enumeration attribute ignores a value outside the enumeration.
    const type = String(value);
    if (HIGHLIGHT_TYPES.has(type)) this.#type = type;
  }
  get size() {
    return this.#ranges.size;
  }
  has(range) {
    return this.#ranges.has(range);
  }
  add(range) {
    requireAbstractRange(range, "add", "Highlight");
    if (!this.#ranges.has(range)) {
      this.#ranges.add(range);
      if (this._registries.size > 0) range._highlightCount += 1;
      this._changed();
    }
    return this;
  }
  delete(range) {
    if (!this.#ranges.delete(range)) return false;
    if (this._registries.size > 0) range._highlightCount -= 1;
    this._changed();
    return true;
  }
  clear() {
    if (this.#ranges.size === 0) return;
    if (this._registries.size > 0) for (const range of this.#ranges) range._highlightCount -= 1;
    this.#ranges.clear();
    this._changed();
  }
  forEach(callback, thisArgument = undefined) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to execute 'forEach' on 'Highlight': parameter 1 is not of type 'Function'.");
    }
    for (const range of this.#ranges) callback.call(thisArgument, range, range, this);
  }
  values() {
    return this.#ranges.values();
  }
  keys() {
    return this.#ranges.values();
  }
  entries() {
    return this.#ranges.entries();
  }
  [Symbol.iterator]() {
    return this.#ranges.values();
  }
  // Registration in a registry counts this highlight's ranges as
  // highlighted while any registry holds it.
  _register(registry) {
    if (this._registries.size === 0) for (const range of this.#ranges) range._highlightCount += 1;
    this._registries.add(registry);
  }
  _unregister(registry) {
    this._registries.delete(registry);
    if (this._registries.size === 0) for (const range of this.#ranges) range._highlightCount -= 1;
  }
  _changed() {
    for (const registry of this._registries) registry._changed();
  }
}

export class HighlightRegistry {
  #entries = new Map();
  #document;
  constructor(token = undefined, document = undefined) {
    if (token !== registryToken) throw new TypeError("Illegal constructor");
    this.#document = document;
  }
  get size() {
    return this.#entries.size;
  }
  has(name) {
    return this.#entries.has(String(name));
  }
  get(name) {
    return this.#entries.get(String(name));
  }
  set(name, highlight) {
    const key = String(name);
    if (!(highlight instanceof Highlight)) {
      throw new TypeError("Failed to execute 'set' on 'HighlightRegistry': parameter 2 is not of type 'Highlight'.");
    }
    const previous = this.#entries.get(key);
    if (previous === highlight) return this;
    this.#entries.set(key, highlight);
    if (previous && !this.#holds(previous)) previous._unregister(this);
    if (!highlight._registries.has(this)) highlight._register(this);
    this._changed();
    return this;
  }
  delete(name) {
    const key = String(name);
    const highlight = this.#entries.get(key);
    if (!highlight) return false;
    this.#entries.delete(key);
    if (!this.#holds(highlight)) highlight._unregister(this);
    this._changed();
    return true;
  }
  clear() {
    if (this.#entries.size === 0) return;
    const highlights = new Set(this.#entries.values());
    this.#entries.clear();
    for (const highlight of highlights) highlight._unregister(this);
    this._changed();
  }
  forEach(callback, thisArgument = undefined) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to execute 'forEach' on 'HighlightRegistry': parameter 1 is not of type 'Function'.");
    }
    for (const [name, highlight] of this.#entries) callback.call(thisArgument, highlight, name, this);
  }
  keys() {
    return this.#entries.keys();
  }
  values() {
    return this.#entries.values();
  }
  entries() {
    return this.#entries.entries();
  }
  [Symbol.iterator]() {
    return this.#entries.entries();
  }

  // The highlights whose ranges cover the point (x, y) of the viewport, by
  // descending effective priority, each with the ranges that cover it
  // (CSS Custom Highlight API 1 §6). A range in a shadow tree counts only
  // when options.shadowRoots names its shadow root.
  highlightsFromPoint(x, y, options = {}) {
    const pointX = Number(x);
    const pointY = Number(y);
    const shadowRoots = new Set(options?.shadowRoots ?? []);
    const results = [];
    for (const { highlight } of this.#paintingOrder().reverse()) {
      const ranges = [];
      for (const range of highlight) {
        const root = range.startContainer.getRootNode();
        if (root.nodeType === 11 && root.host && !shadowRoots.has(root)) continue;
        if (rangeRectangles(this.#document, range).some((rectangle) =>
          pointX >= rectangle.left && pointX < rectangle.right && pointY >= rectangle.top && pointY < rectangle.bottom
        )) ranges.push(range);
      }
      if (ranges.length > 0) results.push({ highlight, ranges });
    }
    return results;
  }

  #holds(highlight) {
    for (const value of this.#entries.values()) if (value === highlight) return true;
    return false;
  }

  // The entries from the bottom of the painting order to the top: by
  // priority, the later registered over the earlier at equal priority
  // (CSS Custom Highlight API 1 §4.2.5).
  #paintingOrder() {
    return [...this.#entries].map(([name, highlight], order) => ({ name, highlight, order }))
      .sort((a, b) => a.highlight.priority - b.highlight.priority || a.order - b.order);
  }

  // The custom highlight overlays in painting order, each { kind, range }.
  _overlays() {
    const document = this.#document;
    const core = document._domCore;
    const records = [];
    for (const { name, highlight } of this.#paintingOrder()) {
      const kind = core.status("highlight_name_kind", ...core.input(name));
      // A name that is no <custom-ident> matches no ::highlight() rule.
      if (kind === 0) continue;
      for (const range of highlight) {
        if (range._document !== document) continue;
        records.push({ kind, range });
      }
    }
    return records;
  }

  _changed() {
    publishHighlightOverlays(this.#document);
  }
}

// The pseudo-element kinds of the overlays whose ranges the program gives
// the document (core/dom/highlights.watpart).
const TARGET_TEXT = 10;
const SPELLING_ERROR = 12;
const GRAMMAR_ERROR = 13;
const SEARCH_CURRENT = 14;
const SEARCH_OTHER = 15;

// The ranges of a document's ::target-text, ::search-text,
// ::spelling-error and ::grammar-error overlays.
function documentOverlayRanges(document) {
  document._overlayRanges ??= { target: null, search: [], searchCurrent: -1, spelling: [], grammar: [] };
  return document._overlayRanges;
}

// Gives the core every overlay of the document in painting order (CSS
// Pseudo 4 §3.6.1): the custom highlights, ::grammar-error,
// ::spelling-error and ::target-text under the selection, the search
// matches over it; then repaints.
export function publishHighlightOverlays(document) {
  const core = document._domCore;
  const overlays = documentOverlayRanges(document);
  const records = [
    ...(document._cssNamespace?.highlights._overlays() ?? []),
    ...overlays.grammar.map((range) => ({ kind: GRAMMAR_ERROR, range })),
    ...overlays.spelling.map((range) => ({ kind: SPELLING_ERROR, range })),
    ...(overlays.target ? [{ kind: TARGET_TEXT, range: overlays.target }] : []),
    ...overlays.search.map((range, index) => ({
      kind: index === overlays.searchCurrent ? SEARCH_CURRENT : SEARCH_OTHER,
      range,
    })),
  ];
  const size = Math.max(1, records.length) * HIGHLIGHT_RECORD_SIZE;
  const pointer = core.exports.abi_allocate(size);
  if (!pointer) core.throwIfError();
  const view = new DataView(core.refreshBytes().buffer, pointer, size);
  records.forEach(({ kind, range }, index) => {
    const at = index * HIGHLIGHT_RECORD_SIZE;
    view.setUint32(at, kind, true);
    if (range instanceof SDRange) {
      view.setUint32(at + 4, HIGHLIGHT_RANGE_LIVE, true);
      view.setBigUint64(at + 8, range._handle, true);
    } else {
      const [start, startOffset, end, endOffset] = range._boundaries();
      view.setUint32(at + 4, HIGHLIGHT_RANGE_STATIC, true);
      view.setBigUint64(at + 16, BigInt(start._coreHandle), true);
      view.setFloat64(at + 24, startOffset, true);
      view.setBigUint64(at + 32, BigInt(end._coreHandle), true);
      view.setFloat64(at + 40, endOffset, true);
    }
  });
  core.status("highlight_registry_set", document._coreHandle, pointer, records.length);
  document._repaintHighlights();
}

function requireRangeList(ranges, method) {
  const list = [...ranges];
  for (const range of list) {
    if (!(range instanceof SDAbstractRange)) {
      throw new TypeError(`Failed to execute '${method}': every entry must be a Range or a StaticRange.`);
    }
  }
  return list;
}

// Replaces the document's ::spelling-error or ::grammar-error ranges.
export function setErrorRanges(document, kind, ranges, method) {
  const list = requireRangeList(ranges, method);
  const overlays = documentOverlayRanges(document);
  for (const range of overlays[kind]) range._highlightCount -= 1;
  for (const range of list) range._highlightCount += 1;
  overlays[kind] = list;
  publishHighlightOverlays(document);
}

// Highlights the first match of a text directive (URL Fragment Text
// Directives, "text=[prefix-,]start[,end][,-suffix]") as ::target-text
// and returns its range, or null when nothing matches; null clears it.
export function setTargetText(document, directive) {
  const overlays = documentOverlayRanges(document);
  if (overlays.target) overlays.target._highlightCount -= 1;
  overlays.target = directive === null ? null : findTextDirective(document, String(directive));
  if (overlays.target) overlays.target._highlightCount += 1;
  publishHighlightOverlays(document);
  return overlays.target;
}

// Highlights every match of $text as ::search-text, the first as the
// current match, and returns the matches; an empty text clears them.
export function findText(document, text, { caseSensitive = false } = {}) {
  const overlays = documentOverlayRanges(document);
  for (const range of overlays.search) range._highlightCount -= 1;
  const query = String(text ?? "");
  overlays.search = query === "" ? [] : searchRanges(document, query, caseSensitive);
  for (const range of overlays.search) range._highlightCount += 1;
  overlays.searchCurrent = overlays.search.length > 0 ? 0 : -1;
  publishHighlightOverlays(document);
  return [...overlays.search];
}

// Moves the current search match to the next one, or with backwards to
// the previous one, wrapping around; returns it, or null without matches.
export function findNext(document, { backwards = false } = {}) {
  const overlays = documentOverlayRanges(document);
  const count = overlays.search.length;
  if (count === 0) return null;
  overlays.searchCurrent = (overlays.searchCurrent + (backwards ? count - 1 : 1)) % count;
  publishHighlightOverlays(document);
  return overlays.search[overlays.searchCurrent];
}

// Each interface's class string (WebIDL §3.7.6).
for (const [constructor, name] of [[Highlight, "Highlight"], [HighlightRegistry, "HighlightRegistry"]]) {
  Object.defineProperty(constructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

// The client rectangles of a range; a static range measures through a live
// range over the same boundary points while they fit the tree.
function rangeRectangles(document, range) {
  if (range instanceof SDRange) return [...range.getClientRects()];
  if (!(range instanceof SDStaticRange)) return [];
  const live = document.createRange();
  try {
    const [start, startOffset, end, endOffset] = range._boundaries();
    live.setStart(start, startOffset);
    live.setEnd(end, endOffset);
    return [...live.getClientRects()];
  } catch (error) {
    if (error?.name === "IndexSizeError") return [];
    throw error;
  } finally {
    live.detach();
  }
}

// The CSS namespace of a document's global: CSS.supports and CSS.escape,
// and CSS.highlights, the document's highlight registry.
export function cssNamespaceFor(document) {
  document._cssNamespace ??= Object.freeze(Object.create(CSS, {
    highlights: { value: new HighlightRegistry(registryToken, document), enumerable: true },
  }));
  return document._cssNamespace;
}
