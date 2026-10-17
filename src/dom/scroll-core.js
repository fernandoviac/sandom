import { sharedDomCore } from "../dom-wasm/core.js";
import { buildGeometry } from "./geometry.js";
import { withLiveGeometry } from "./live-geometry.js";
import { resolvedElementFields, resolvedOverflowAxes } from "./style.js";

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

// CSSOM View gives the viewport's scroll position to the root element in
// standards mode and to the body element in quirks mode while the body is not
// potentially scrollable; the root element in quirks mode reads 0 and ignores
// writes. The root element's overflow, or the body's when the root's is
// visible, belongs to the viewport (CSS Overflow 3, "Overflow Viewport
// Propagation"), and the element it comes from does not scroll.
function isScrollContainer(element) {
  const fields = resolvedElementFields(element);
  if (fields.display === "none" || fields.display === "contents") return false;
  const overflow = resolvedOverflowAxes(fields);
  return !(["visible", "clip"].includes(overflow.x) && ["visible", "clip"].includes(overflow.y));
}

export function isQuirksMode(document) {
  return document._domCore.documentMode(document._coreHandle) === 1;
}

// The scroller whose position an element's scrollLeft, scrollTop, scroll(),
// scrollTo() and scrollBy() read and move: the element itself, the viewport
// of the document element's surface, or null when the element reads 0 and
// ignores writes (the root element in quirks mode, or a document whose root
// element has no surface). A body in quirks mode scrolls itself while it is
// potentially scrollable: it and the root element are both scroll
// containers, so its overflow stays its own.
export function elementScrollSource(element) {
  const document = element.ownerDocument;
  if (!document) return element;
  const root = document.documentElement;
  if (element === root) {
    if (isQuirksMode(document)) return null;
  } else if (element.localName !== "body" || element !== document.body || !isQuirksMode(document) ||
    (isScrollContainer(root) && isScrollContainer(element))) {
    return element;
  }
  return root._renderSurface?.viewport ?? null;
}

// CSSOM View `scrollingElement`: the root element in standards mode; in
// quirks mode the body element unless it is potentially scrollable (it and
// the root element are both scroll containers), otherwise null.
export function documentScrollingElement(document) {
  const root = document.documentElement;
  if (!isQuirksMode(document)) return root;
  const body = document.body;
  if (body === null) return null;
  return isScrollContainer(root) && isScrollContainer(body) ? null : body;
}

// Viewport and element scroll states share the slots: 0 and 1 requested,
// 2 and 3 effective.
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
      if (!core.status("scroll_value", state, 4)) continue;
      const node = core.status("scroll_state_node", state);
      const target = node ? core.wrapperFor(node) : surface.viewport;
      yield [target, { source: sourceNames[core.status("scroll_value", state, 6) - 1] }];
    }
  }
  [Symbol.iterator]() { return this.entries(); }
  get size() { return this.surface._root._domCore.status("scroll_smooth_count", this.surface._scrollOwner); }
  has(target) { return scrollRead(target, 4) !== 0; }
  get(target) { return this.has(target) ? { source: sourceNames[scrollRead(target, 6) - 1] } : undefined; }
  delete(target) { if (target._scrollState) scrollCore(target).status("scroll_cancel", target._scrollState); }
  clear() { this.surface._root._domCore.status("scroll_interrupt", this.surface._scrollOwner); }
}

export function scrollIntoViewCore(node, options = {}, layoutOptions) {
  const normalized = typeof options === "boolean"
    ? { block: options ? "start" : "end", inline: "nearest", behavior: "auto", container: "all" }
    : { block: options.block ?? "start", inline: options.inline ?? "nearest", behavior: options.behavior ?? "auto", container: options.container ?? "all" };
  if (!["auto", "instant", "smooth"].includes(normalized.behavior)) throw new Error(`scrollIntoView: unknown behavior "${normalized.behavior}"`);
  if (!["all", "nearest"].includes(normalized.container)) throw new Error(`scrollIntoView: unknown container "${normalized.container}"`);
  const alignments = { nearest: 0, start: 1, end: 2, center: 3 };
  for (const alignment of [normalized.block, normalized.inline]) {
    if (!(alignment in alignments)) throw new Error(`scrollIntoView: unknown alignment "${alignment}"`);
  }
  const surface = node._renderSurface;
  const core = node._domCore;
  const root = surface?._root ?? node.getRootNode();
  const owner = surface?._scrollOwner ?? core.status("scroll_owner_create");
  if (!surface) {
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) core.status("scroll_attach", owner, scrollState(ancestor));
  }
  const operation = core.status("scroll_into_view_begin", owner, node._coreHandle, (root.nodeType === 9 ? root.documentElement : root)._coreHandle, alignments[normalized.block], alignments[normalized.inline], { auto: 0, smooth: 1, instant: 2 }[normalized.behavior], normalized.container === "nearest" ? 1 : 0);
  try {
    for (;;) {
      const result = withLiveGeometry(node, layoutOptions, ({ handle }) => core.status("scroll_into_view_step", operation, handle));
      if (result !== 1) break;
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
          target._setScrollPosition(core.status("scroll_value", state, 0), core.status("scroll_value", state, 1), "scrollIntoView", "instant");
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
  const styleRevision = core.status("document_style_generation", root.ownerDocument._coreHandle);
  const resourceRevision = core.status("resource_revision");
  const matches = (handle) => core.status("geometry_revision", handle, 0) === BigInt(styleRevision) &&
    core.status("geometry_revision", handle, 2) === BigInt(resourceRevision);
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
  [Symbol.iterator]() { return this.kind === 1 ? this.keys() : this.entries(); }
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
    if (this.kind === 0) return sourceNames[value(0) - 1] ?? "scroll";
    if (this.kind === 1) return target;
    if (this.kind === 2) return { left: value(0), top: value(1) };
    if (this.kind === 3) return { horizontal: node(0), vertical: node(1) };
    return { element: node(0), offset: value(0), axis: value(1) ? "y" : "x" };
  }
  set(target, value) {
    const core = scrollCore(target), state = scrollState(target);
    core.status("scroll_attach", this.surface._scrollOwner, state);
    core.status("scroll_collection_set", state, this.kind,
      this.kind === 0 ? SCROLL_SOURCES[value] ?? 0 : this.kind === 2 ? value.left : this.kind === 4 ? value.offset : 0,
      this.kind === 2 ? value.top : this.kind === 4 ? (value.axis === "y" ? 1 : 0) : 0,
      this.kind === 3 ? value.horizontal?._coreHandle ?? 0n : this.kind === 4 ? value.element?._coreHandle ?? 0n : 0n,
      this.kind === 3 ? value.vertical?._coreHandle ?? 0n : 0n);
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
    return { generation: value(0), left: value(1), top: value(2) };
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
