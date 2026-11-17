import { sharedDomCore } from "../dom-wasm/core.js";
import { buildGeometry } from "./geometry.js";
import { withLiveGeometry } from "./live-geometry.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { nodeMember } from "./node-members.js";

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const SCROLL_REQUESTED_LEFT = layoutConstant("SCROLL_REQUESTED_LEFT");
const SCROLL_REQUESTED_TOP = layoutConstant("SCROLL_REQUESTED_TOP");
const SCROLL_SMOOTH_ACTIVE = layoutConstant("SCROLL_SMOOTH_ACTIVE");
const SCROLL_SMOOTH_SOURCE = layoutConstant("SCROLL_SMOOTH_SOURCE");
const SCROLL_CAPTURE_GENERATION = layoutConstant("SCROLL_CAPTURE_GENERATION");
const SCROLL_INTO_VIEW_STEPPED = layoutConstant("SCROLL_INTO_VIEW_STEPPED");
const SCROLL_CAPTURE_LEFT = layoutConstant("SCROLL_CAPTURE_LEFT");
const SCROLL_CAPTURE_TOP = layoutConstant("SCROLL_CAPTURE_TOP");
const DOCUMENT_MODE_QUIRKS = layoutConstant("DOCUMENT_MODE_QUIRKS");
// The scroll collections of a render surface (scroll.watpart).
export const SCROLL_COLLECTION = Object.freeze({
  SOURCES: layoutConstant("SCROLL_COLLECTION_SOURCES"),
  END_TARGETS: layoutConstant("SCROLL_COLLECTION_END_TARGETS"),
  SNAP_ORIGINS: layoutConstant("SCROLL_COLLECTION_SNAP_ORIGINS"),
  SNAPPED: layoutConstant("SCROLL_COLLECTION_SNAPPED"),
  ANCHORS: layoutConstant("SCROLL_COLLECTION_ANCHORS"),
});
// The suppression bits of a node (scroll.watpart).
export const SCROLL_SUPPRESS = Object.freeze({
  ANCHORING: layoutConstant("SCROLL_SUPPRESS_ANCHORING"),
  POSITION: layoutConstant("SCROLL_SUPPRESS_POSITION"),
});

export const SCROLL_SOURCES = Object.freeze({ property: 1, scroll: 2, scrollTo: 3, scrollBy: 4, wheel: 5, keyboard: 6, pointer: 7, snap: 8, anchor: 9, scrollIntoView: 10, resize: 11, scrollbar: 12, momentum: 13 });
const sourceNames = Object.keys(SCROLL_SOURCES);
const states = new FinalizationRegistry(({ core, handle }) => core.status("scroll_state_release", handle));
const captures = new FinalizationRegistry(({ core, handle }) => core.status("scroll_capture_release", handle));
function knownScrollState(target) {
  if (target._scrollState) return target._scrollState;
  const core = scrollCore(target);
  const surface = target._surface ?? target._renderSurface;
  const handle = surface?._scrollOwner ? core.status("scroll_find", surface._scrollOwner, target._coreHandle ?? 0n) : 0n;
  if (handle) {
    target._scrollState = core.status("scroll_state_retain", handle);
    states.register(target, { core, handle });
  }
  return handle;
}
export function scrollCore(target) { return target._domCore ?? target._surface?._root._domCore ?? sharedDomCore; }
export function scrollState(target) {
  const core = scrollCore(target);
  const surface = target._surface ?? target._renderSurface;
  if (!knownScrollState(target)) {
    target._scrollState = core.status("scroll_state_create", target._coreHandle ?? 0n);
    states.register(target, { core, handle: target._scrollState });
  }
  if (surface?._scrollOwner) core.status("scroll_attach", surface._scrollOwner, target._scrollState);
  return target._scrollState;
}
// Reparenting retains the state but releases its old surface owner. Queries
// attach an existing state before serialization reads the native owner list.
export function attachKnownScrollState(target) {
  return knownScrollState(target) ? scrollState(target) : 0n;
}
export function scrollRead(target, slot) {
  const state = attachKnownScrollState(target);
  if (!state) return 0;
  return scrollCore(target).status("scroll_value", state, slot);
}
export function scrollStore(target, slot, value) {
  if (!target._scrollState && value === 0) return;
  scrollCore(target).status("scroll_store", scrollState(target), slot, value);
}

export function isQuirksMode(document) {
  return document._domCore.documentMode(document._coreHandle) === DOCUMENT_MODE_QUIRKS;
}

const SCROLL_SOURCE_ELEMENT = layoutConstant("SCROLL_SOURCE_ELEMENT");
const SCROLL_SOURCE_VIEWPORT = layoutConstant("SCROLL_SOURCE_VIEWPORT");

// The scroller whose position an element's scrollLeft, scrollTop, scroll(),
// scrollTo() and scrollBy() read and move (scroll_element_source): the
// element itself, the viewport of the document element's surface, or null
// when the element reads 0 and ignores writes.
export function elementScrollSource(element) {
  const source = element._domCore.status("scroll_element_source", element._coreHandle);
  if (source === SCROLL_SOURCE_ELEMENT) return element;
  return source === SCROLL_SOURCE_VIEWPORT
    ? nodeMember(element, "ownerDocument").documentElement._renderSurface?.viewport ?? null
    : null;
}

// Whether `element` is the one whose scroll position is the viewport's
// (scroll_element_source), with or without a rendering surface.
export function elementScrollsViewport(element) {
  return element._domCore.status("scroll_element_source", element._coreHandle) === SCROLL_SOURCE_VIEWPORT;
}

// CSSOM View `scrollingElement` (scroll_scrolling_element).
export function documentScrollingElement(document) {
  return document._domCore.nodeHandle("scroll_scrolling_element", document._coreHandle);
}

// Viewport and element scroll states share the slots (SCROLL_REQUESTED_*,
// SCROLL_ACCEPTED_*).
export function elementScrollRead(element, slot) {
  const source = elementScrollSource(element);
  return source === null ? 0 : scrollRead(source, slot);
}

export function scrollRequest(target, left, top, behavior, source) {
  const core = scrollCore(target);
  const state = scrollState(target);
  const surface = target._surface ?? target._renderSurface;
  const sourceCode = SCROLL_SOURCES[source] ?? 0;
  const smooth = surface ? core.status("scroll_request_behavior", state, surface._root._coreHandle, { auto: 0, smooth: 1, instant: 2 }[behavior]) : 0;
  if (surface && smooth && core.status("scroll_requires_live", sourceCode)) {
    const node = target === surface.viewport ? surface._root : target;
    return withLiveGeometry(node, undefined, ({ handle }) =>
      core.status("scroll_request_live", state, handle, surface._root._coreHandle, left, top, 1, sourceCode));
  }
  return core.status("scroll_request", state, left, top, smooth, sourceCode);
}
export class NativeScrollMotions {
  constructor(surface) { this.surface = surface; }
  *entries() {
    const surface = this.surface, core = surface._root._domCore;
    for (let index = 0;; index++) {
      const state = core.status("scroll_owner_state", surface._scrollOwner, index);
      if (!state) break;
      if (!core.status("scroll_value", state, SCROLL_SMOOTH_ACTIVE)) continue;
      const node = core.status("scroll_state_node", state);
      const target = node ? core.wrapperFor(node) : surface.viewport;
      yield [target, { source: sourceNames[core.status("scroll_value", state, SCROLL_SMOOTH_SOURCE) - 1] }];
    }
  }
  [Symbol.iterator]() { return this.entries(); }
  get size() { return this.surface._root._domCore.status("scroll_smooth_count", this.surface._scrollOwner); }
  has(target) { return scrollRead(target, SCROLL_SMOOTH_ACTIVE) !== 0; }
  get(target) { return this.has(target) ? { source: sourceNames[scrollRead(target, SCROLL_SMOOTH_SOURCE) - 1] } : undefined; }
  delete(target) { if (target._scrollState) scrollCore(target).status("scroll_cancel", target._scrollState); }
  clear() { this.surface._root._domCore.status("scroll_interrupt", this.surface._scrollOwner); }
}

// The option checks and codes are scroll_into_view_options.
export function scrollIntoViewCore(node, options = {}, layoutOptions) {
  const values = typeof options === "boolean"
    ? [options]
    : [options.block ?? "start", options.inline ?? "nearest", options.behavior ?? "auto", options.container ?? "all"].map(String);
  const codes = node._domCore.status("scroll_into_view_options", ...node._domCore.valueListInput(values));
  const surface = node._renderSurface;
  const core = node._domCore;
  const root = surface?._root ?? nodeMember(node, "getRootNode").call(node);
  const owner = surface?._scrollOwner ?? core.status("scroll_owner_create");
  if (!surface) {
    for (let ancestor = nodeMember(node, "parentElement"); ancestor; ancestor = nodeMember(ancestor, "parentElement")) {
      core.status("scroll_attach", owner, scrollState(ancestor));
    }
  }
  const operation = core.status("scroll_into_view_begin", owner, node._coreHandle,
    (nodeMember(root, "nodeType") === 9 ? root.documentElement : root)._coreHandle, codes);
  try {
    for (;;) {
      const result = withLiveGeometry(node, layoutOptions, ({ handle }) => core.status("scroll_into_view_step", operation, handle));
      if (result !== SCROLL_INTO_VIEW_STEPPED) break;
      if (surface) {
        surface._snapCheckPending = true;
        surface._dirty = true;
        surface._schedule();
      } else {
        for (let index = 0;; index++) {
          const state = core.status("scroll_owner_state", owner, index);
          if (!state) break;
          const targetHandle = core.status("scroll_state_node", state);
          if (!targetHandle) continue;
          const target = core.wrapperFor(targetHandle);
          target._setScrollPosition(core.status("scroll_value", state, SCROLL_REQUESTED_LEFT),
            core.status("scroll_value", state, SCROLL_REQUESTED_TOP), "scrollIntoView", "instant");
        }
      }
    }
  } finally {
    core.status("scroll_into_view_release", operation);
    if (!surface) core.status("scroll_owner_release", owner);
  }
}

export function withScrollGeometry(root, viewport, boxes, serialized, callback) {
  const surface = viewport?._surface ?? root._renderSurface;
  const core = root._domCore;
  const documentHandle = nodeMember(root, "ownerDocument")._coreHandle;
  const matches = (handle) => core.status("scroll_geometry_current", handle, documentHandle) === 1;
  if (surface?._lastBoxes === boxes && surface._presentedFrame?.geometryHandle && matches(surface._presentedFrame.geometryHandle)) {
    return callback(surface._presentedFrame.geometryCore, surface._presentedFrame.geometryHandle);
  }
  if (surface?._scrollGeometry?.boxes === boxes && matches(surface._scrollGeometry.imported.handle) &&
      surface._scrollGeometry.width === viewport?.width && surface._scrollGeometry.height === viewport?.height &&
      surface._scrollGeometry.scale === viewport?.deviceScale) {
    return callback(surface._scrollGeometry.imported.core, surface._scrollGeometry.imported.handle);
  }
  const imported = buildGeometry({
    root, viewport, boxes, publication: serialized.publication, viewportIndex: serialized.viewportIndex, presented: false,
  });
  if (surface) {
    surface._scrollGeometry?.imported.release();
    surface._scrollGeometry = { boxes, imported, width: viewport?.width, height: viewport?.height, scale: viewport?.deviceScale };
    return callback(imported.core, imported.handle);
  }
  try { return callback(imported.core, imported.handle); }
  finally { imported.release(); }
}

// Collection views contain no requested state, motion policy, or pending queue.
// They only intern the node identities returned by the owner's native records.
export class NativeScrollCollection {
  constructor(surface, kind) { this.surface = surface; this.kind = kind; }
  *keys() {
    const core = this.surface._root._domCore;
    for (let index = 0;; index++) {
      const state = core.status("scroll_collection_entry", this.surface._scrollOwner, this.kind, index);
      if (!state) break;
      const node = core.status("scroll_state_node", state);
      const target = node ? core.wrapperFor(node) : this.surface.viewport;
      yield target;
    }
  }
  *entries() { for (const target of this.keys()) yield [target, this.get(target)]; }
  [Symbol.iterator]() { return this.kind === SCROLL_COLLECTION.END_TARGETS ? this.keys() : this.entries(); }
  get size() { return this.surface._root._domCore.status("scroll_collection_count", this.surface._scrollOwner, this.kind); }
  has(target) {
    const state = knownScrollState(target);
    return !!state && !!scrollCore(target).status("scroll_collection_has", state, this.kind);
  }
  get(target) {
    if (!this.has(target)) return undefined;
    const core = scrollCore(target), state = scrollState(target);
    const value = (axis) => core.status("scroll_collection_value", state, this.kind, axis);
    const node = (axis) => { const handle = core.status("scroll_collection_node", state, this.kind, axis); return handle ? core.wrapperFor(handle) : null; };
    if (this.kind === SCROLL_COLLECTION.SOURCES) return sourceNames[value(0) - 1] ?? "scroll";
    if (this.kind === SCROLL_COLLECTION.END_TARGETS) return target;
    if (this.kind === SCROLL_COLLECTION.SNAP_ORIGINS) return { left: value(0), top: value(1) };
    if (this.kind === SCROLL_COLLECTION.SNAPPED) return { horizontal: node(0), vertical: node(1) };
    return { element: node(0), offset: value(0), axis: value(1) ? "y" : "x" };
  }
  set(target, value) {
    const core = scrollCore(target), state = scrollState(target);
    const kind = this.kind;
    core.status("scroll_attach", this.surface._scrollOwner, state);
    core.status("scroll_collection_set", state, kind,
      kind === SCROLL_COLLECTION.SOURCES ? SCROLL_SOURCES[value] ?? 0
        : kind === SCROLL_COLLECTION.SNAP_ORIGINS ? value.left : kind === SCROLL_COLLECTION.ANCHORS ? value.offset : 0,
      kind === SCROLL_COLLECTION.SNAP_ORIGINS ? value.top : kind === SCROLL_COLLECTION.ANCHORS ? (value.axis === "y" ? 1 : 0) : 0,
      kind === SCROLL_COLLECTION.SNAPPED ? value.horizontal?._coreHandle ?? 0n
        : kind === SCROLL_COLLECTION.ANCHORS ? value.element?._coreHandle ?? 0n : 0n,
      kind === SCROLL_COLLECTION.SNAPPED ? value.vertical?._coreHandle ?? 0n : 0n);
    return this;
  }
  add(target) { return this.set(target, target); }
  delete(target) {
    if (!this.has(target)) return false;
    scrollCore(target).status("scroll_collection_delete", scrollState(target), this.kind);
    return true;
  }
  clear() { this.surface._root._domCore.status("scroll_collection_clear", this.surface._scrollOwner, this.kind); }
}

export class NativeScrollSuppression {
  constructor(surface, flag) { this.surface = surface; this.flag = flag; }
  delete(node) { this.surface._root._domCore.status("scroll_suppression_clear", this.surface._scrollOwner, node._coreHandle, this.flag); }
  clear() { this.surface._root._domCore.status("scroll_suppression_clear", this.surface._scrollOwner, 0n, this.flag); }
}

export class NativeScrollCapture {
  constructor(surface) {
    this.surface = surface;
    this.core = surface._root._domCore;
    this.handle = this.core.status("scroll_capture", surface._scrollOwner);
    captures.register(this, { core: this.core, handle: this.handle }, this);
  }
  get size() { return this.core.status("scroll_capture_count", this.handle); }
  has(target) { return !!this.core.status("scroll_capture_has", this.handle, target._coreHandle ?? 0n); }
  get(target) {
    if (!this.has(target)) return undefined;
    const value = (slot) => this.core.status("scroll_capture_value", this.handle, target._coreHandle ?? 0n, slot);
    return { generation: value(SCROLL_CAPTURE_GENERATION), left: value(SCROLL_CAPTURE_LEFT), top: value(SCROLL_CAPTURE_TOP) };
  }
  *keys() {
    const count = this.size;
    for (let index = 0; index < count; index++) {
      const node = this.core.status("scroll_capture_node", this.handle, index);
      const target = node ? this.core.wrapperFor(node) : this.surface.viewport;
      yield target;
    }
  }
  *entries() { for (const target of this.keys()) yield [target, this.get(target)]; }
  [Symbol.iterator]() { return this.entries(); }
  release() {
    if (!this.handle) return;
    this.core.status("scroll_capture_release", this.handle);
    this.handle = 0n;
    captures.unregister(this);
  }
}
