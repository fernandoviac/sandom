// The layout-getter family (plans/dom/README.md):
// getBoundingClientRect,
// offsetWidth/offsetHeight/offsetTop/offsetLeft, clientWidth/
// clientHeight, scrollWidth/scrollHeight/scrollTop/scrollLeft. All
// answered by ONE mechanism — the live layout pass (live-geometry.js):
// serializeToScene the live tree, run a real layout pass
// (layoutTreeBoxesSync, examples/render-scene.js), and read back the
// requested node's own computed box — reshaped per property into the
// units/reference-frame each one actually uses.
//
// SYNCHRONOUS by ruling — these must match a real browser's synchronous
// property getters exactly. Registry-backed fonts are either runtime faces
// whose bytes are already present or deterministic local assets that Deno can
// register synchronously. Resources that still require asynchronous work
// (browser font fetches, images, and SVG-path module initialization) throw
// clearly rather than blocking or returning guessed geometry.

import { attachKnownScrollState, elementScrollSource, isQuirksMode, scrollIntoViewCore } from "./scroll-core.js";
import { buildGeometry, geometryCaretPosition, geometryClientRects, geometryHits, geometryRect } from "./geometry.js";
import { withLiveGeometry } from "./live-geometry.js";
import { SDCaretPosition } from "./selection.js";
import { hitTestSnapshot } from "./presented-frame.js";
import { scheduleFocusFixup } from "./input-activation.js";
import { flatTreeParent } from "./shadow.js";
import { createLayoutGeometryBindings } from "./dom-bindings.generated.js";

// getBoundingClientRect: viewport-relative border-box, matching the
// browser backend's own plainified shape exactly (frontend-iris.js:91-95
// — a real DOMRect's getters are on the prototype, not own-enumerable,
// so it must be plainified before crossing any capability boundary;
// sandom's box is already a plain object, but the SAME flat shape is
// used here for drop-in parity).
function queryRect(node, options) {
  return withCulledText(node, options, ({ core, handle }) =>
    geometryRect(core, handle, node._coreHandle));
}

// getClientRects: one viewport-relative rectangle per fragment of a box
// broken across columns or lines (a block box around a spanner, an inline
// box's line boxes), else the border box, each through its transforms. A
// culled inline box gives its children's rectangles.
function queryClientRects(node, options) {
  return withCulledText(node, options, ({ core, handle }) =>
    geometryClientRects(core, handle, node._coreHandle));
}

// `read` over a live geometry snapshot, with text geometry when the core
// finds `node` a culled inline box (geometry_culled_inline): its
// rectangles are those of its children's text fragments.
function withCulledText(node, options, read) {
  const culled = Symbol("culled");
  const value = withLiveGeometry(node, options, (geometry) =>
    geometry.core.status("geometry_culled_inline", geometry.handle, node._coreHandle) ? culled : read(geometry));
  return value === culled ? withLiveGeometry(node, options, read, true) : value;
}

// Reuses a layout that the caller already produced. Batch renderers must use
// this path instead of triggering one complete layout pass per element.
export function getBoundingClientRectFromLayout(node, layout) {
  let root = node;
  while (root.parentElement) root = root.parentElement;
  const geometry = buildGeometry({ ...layout, root,
    viewport: layout.viewport ?? root._renderSurface?.viewport ?? { ...root.ownerDocument._viewport, deviceScale: 1 } });
  try {
    return geometryRect(geometry.core, geometry.handle, node._coreHandle);
  } finally {
    geometry.release();
  }
}

// offsetWidth/offsetHeight: border-box dimensions (content + padding +
// border, no margin) — exactly the box buffer's own border-box fields.
// scrollLeft (8) and scrollTop (9) read the scroller the element's scroll
// position belongs to (elementScrollSource): the viewport's for the root
// element, whose overflow the viewport takes, and 0 for none.
// CSSOM View gives the element whose scroll position is the viewport's
// (the root element in standards mode, the body in quirks mode while it
// is not potentially scrollable) the viewport's client size (14, 15) and
// the viewport scrolling area, at least the viewport, as its scroll size
// (10, 11). The root element of a quirks-mode document reports its own
// boxes: its client size is its padding box, not the viewport's.
function liveValue(node, options, field) {
  let target = node._coreHandle;
  const source = elementScrollSource(node);
  const viewportOwned = source !== null && source !== node;
  if (field === 8 || field === 9) {
    if (source === null) return 0;
    attachKnownScrollState(source);
    if (viewportOwned) target = source._coreHandle ?? 0n;
    const surface = node._renderSurface;
    if (surface?._scrollOwner) {
      const value = node._domCore.status("scroll_current_value", surface._scrollOwner, target, field - 8,
        surface.viewport.width, surface.viewport.height);
      if (!Number.isNaN(value)) return value;
    }
  }
  if (viewportOwned && (field === 10 || field === 11 || field === 14 || field === 15)) {
    target = source._coreHandle ?? 0n;
  }
  const quirksRoot = node === node.ownerDocument?.documentElement && isQuirksMode(node.ownerDocument);
  return withLiveGeometry(node, options, ({ core, handle }) => {
    if (OFFSET_FIELDS.has(field)) return offsetValue(core, handle, node, field);
    const value = (valueField) => core.status("geometry_value", handle, target, valueField);
    // Client and scroll sizes are whole pixels (geometry_css_value).
    const cssValue = (valueField) => core.status("geometry_css_value", handle, target, valueField);
    if (viewportOwned && (field === 10 || field === 11)) return Math.max(cssValue(field), cssValue(field + 4));
    if (quirksRoot && (field === 14 || field === 15)) {
      // The padding box: the border box less clientLeft or clientTop and
      // the right or bottom border.
      return field === 14 ? value(2) - value(34) - value(38) : value(3) - value(35) - value(39);
    }
    return cssValue(field);
  });
}

// The offset getters (CSSOM View): zero for an element without a box, and
// offsetLeft and offsetTop zero for the body. Chrome gives whole pixels in
// the element's unzoomed CSS pixels (geometry_css_value): offsetLeft and
// offsetTop rounded, offsetWidth and offsetHeight snapped to the rounded
// edges from the offset parent.
const OFFSET_FIELDS = new Set([2, 3, 32, 33]);
function offsetValue(core, handle, node, field) {
  if (!elementHasBox(core, handle, node)) return 0;
  if ((field === 32 || field === 33) && node === node.ownerDocument.body) return 0;
  return core.status("geometry_css_value", handle, node._coreHandle, field);
}

function elementHasBox(core, handle, node) {
  return (core.status("element_rendered_state", node._coreHandle) & 1) === 0 &&
    core.status("geometry_index", handle, node._coreHandle) >= 0;
}

// offsetParent (CSSOM View, as Chrome's LayoutObject::OffsetParent): null
// for the root and body elements and an element without a box; else the
// record that offsetLeft and offsetTop measure from
// (geometry_offset_parent), and the body when that is the root. A fixed
// element has a parent only when an ancestor contains fixed boxes.
export function offsetParent(node, options) {
  const document = node.ownerDocument;
  if (node === document.documentElement || node === document.body || !node.isConnected) return null;
  return withLiveGeometry(node, options, ({ core, handle }) => {
    if (!elementHasBox(core, handle, node)) return null;
    const container = core.wrapperFor(core.status("geometry_offset_parent", handle, node._coreHandle));
    if (container === null || container === document.documentElement) {
      return document.getComputedStyle(node).position === "fixed" ? null : document.body;
    }
    return container;
  });
}

// checkVisibility (CSSOM View): false for an element without a box or in
// skipped contents; the options add the visibility and opacity checks.
export function checkVisibility(node, options = {}) {
  const state = node._domCore.status("element_rendered_state", node._coreHandle);
  if (state & 3) return false;
  if ((options?.checkVisibilityCSS || options?.visibilityProperty) && (state & 4)) return false;
  if (options?.checkOpacity || options?.opacityProperty) {
    for (let element = node; element !== null && element.nodeType === 1; element = flatTreeParent(element)) {
      if (Number(node.ownerDocument.getComputedStyle(element).opacity) === 0) return false;
    }
  }
  return true;
}

export const {
  getBoundingClientRect, getClientRects, elementFromPoint, elementsFromPoint, offsetWidth, offsetHeight,
  offsetTop, offsetLeft, clientTop, clientLeft, clientWidth, clientHeight,
  scrollTop, scrollLeft, scrollWidth, scrollHeight,
} = createLayoutGeometryBindings({ queryValue: liveValue, queryRect, queryClientRects, queryHit, queryHits });

export function scrollIntoView(node, options = {}, layoutOptions) {
  return scrollIntoViewCore(node, options, layoutOptions);
}

// A surface-owned tree is hit-tested against the frame the host is looking
// at — the same geometry the pointer path targets
// (src/dom/input-controller.js's snapshotFor, design/interaction.md's
// ruling that input addresses the last PRESENTED frame). Answering
// "what is at this point?" from a fresh synchronous layout instead made
// elementFromPoint disagree with pointerDown about the same point, and
// paid a whole re-layout to do it — plus every layout-side capacity guard
// that layout can raise, which is how the call came to throw
// `RuntimeError: unreachable` on a live document
// (BUG-element-from-point-traps-on-live-document, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md). With no
// surface, or before its first frame, the live layout IS the only geometry
// and still answers.
function queryHit(root, x, y, options) {
  const presented = root._renderSurface?.presentedFrame ?? null;
  if (presented !== null) {
    // A hit test updates layout in Chrome: it runs the focus check, as the
    // live layout below does.
    scheduleFocusFixup(root);
    return hitTestSnapshot(presented, x, y);
  }
  return withLiveGeometry(root, options, ({ core, handle }) =>
    core.wrapperFor(core.status("geometry_hit_test", handle, x, y)));
}

// elementsFromPoint: the same geometry as elementFromPoint, every element
// at the point, topmost first, the root element last.
function queryHits(root, x, y, options) {
  const presented = root._renderSurface?.presentedFrame ?? null;
  if (presented !== null) {
    scheduleFocusFixup(root);
    return geometryHits(presented.geometryCore, presented.geometryHandle, x, y);
  }
  return withLiveGeometry(root, options, ({ core, handle }) => geometryHits(core, handle, x, y));
}

// caretPositionFromPoint (CSSOM View): a synchronous layout with the text
// geometry of every laid-out text node, as Chrome lays the document out
// for it, then the caret position at the point
// (src/dom-wasm/geometry-range.watpart), or null without an element there.
export function caretPositionFromPoint(root, x, y, options) {
  const position = withLiveGeometry(root, options, ({ core, handle }) =>
    geometryCaretPosition(core, handle, x, y), true);
  return position === null ? null : new SDCaretPosition(root.ownerDocument, position.node, position.offset);
}
