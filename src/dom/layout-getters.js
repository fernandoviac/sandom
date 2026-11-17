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

import { attachKnownScrollState, elementScrollSource, elementScrollsViewport, isQuirksMode, scrollIntoViewCore } from "./scroll-core.js";
import { buildGeometry, geometryCaretPosition, geometryClientRects, geometryHits, geometryRect, layoutRootOf } from "./geometry.js";
import { withLiveGeometry } from "./live-geometry.js";
import { pageOfPoint } from "./page-stack.js";
import { SDCaretPosition } from "./selection.js";
import { hitTestSnapshot } from "./presented-frame.js";
import { flatTreeParent } from "./shadow.js";
import { createLayoutGeometryBindings } from "./dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { nodeMember } from "./node-members.js";

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const GEOMETRY_OFFSET_WIDTH = layoutConstant("GEOMETRY_OFFSET_WIDTH");
const GEOMETRY_OFFSET_HEIGHT = layoutConstant("GEOMETRY_OFFSET_HEIGHT");
const GEOMETRY_SCROLL_LEFT = layoutConstant("GEOMETRY_SCROLL_LEFT");
const GEOMETRY_SCROLL_TOP = layoutConstant("GEOMETRY_SCROLL_TOP");
const GEOMETRY_SCROLL_WIDTH = layoutConstant("GEOMETRY_SCROLL_WIDTH");
const GEOMETRY_SCROLL_HEIGHT = layoutConstant("GEOMETRY_SCROLL_HEIGHT");
const GEOMETRY_CLIENT_WIDTH = layoutConstant("GEOMETRY_CLIENT_WIDTH");
const GEOMETRY_CLIENT_HEIGHT = layoutConstant("GEOMETRY_CLIENT_HEIGHT");
const GEOMETRY_OFFSET_LEFT = layoutConstant("GEOMETRY_OFFSET_LEFT");
const GEOMETRY_OFFSET_TOP = layoutConstant("GEOMETRY_OFFSET_TOP");
const GEOMETRY_CLIENT_LEFT = layoutConstant("GEOMETRY_CLIENT_LEFT");
const GEOMETRY_CLIENT_TOP = layoutConstant("GEOMETRY_CLIENT_TOP");
const GEOMETRY_BORDER_RIGHT = layoutConstant("GEOMETRY_BORDER_RIGHT");
const GEOMETRY_BORDER_BOTTOM = layoutConstant("GEOMETRY_BORDER_BOTTOM");
const RENDERED_STATE_NO_BOX = layoutConstant("RENDERED_STATE_NO_BOX");
const RENDERED_STATE_ANCESTOR_SKIPS = layoutConstant("RENDERED_STATE_ANCESTOR_SKIPS");
const RENDERED_STATE_INVISIBLE = layoutConstant("RENDERED_STATE_INVISIBLE");

// getBoundingClientRect: viewport-relative border-box, matching the
// browser backend's own plainified shape exactly (frontend-iris.js:91-95
// — a real DOMRect's getters are on the prototype, not own-enumerable,
// so it must be plainified before crossing any capability boundary;
// sandom's box is already a plain object, but the SAME flat shape is
// used here for drop-in parity).
function queryRect(node, options) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    geometryRect(core, handle, node._coreHandle));
}

// getClientRects: one viewport-relative rectangle per fragment of a box
// broken across columns or lines (a block box around a spanner, an inline
// box's line boxes, CSSOM View §6), else the border box, each through its
// transforms.
function queryClientRects(node, options) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    geometryClientRects(core, handle, node._coreHandle));
}

// Reuses a layout that the caller already produced. Batch renderers must use
// this path instead of triggering one complete layout pass per element.
export function getBoundingClientRectFromLayout(node, layout) {
  const root = layoutRootOf(node);
  const geometry = buildGeometry({ ...layout, root,
    viewport: layout.viewport ?? root._renderSurface?.viewport ?? { ...nodeMember(root, "ownerDocument")._viewport, deviceScale: 1 } });
  try {
    return geometryRect(geometry.core, geometry.handle, node._coreHandle);
  } finally {
    geometry.release();
  }
}

// offsetWidth/offsetHeight: border-box dimensions (content + padding +
// border, no margin) — exactly the box buffer's own border-box fields.
// scrollLeft and scrollTop read the scroller the element's scroll position
// belongs to (elementScrollSource): the viewport's for the root element,
// whose overflow the viewport takes, and 0 for none.
// CSSOM View gives the element whose scroll position is the viewport's
// (the root element in standards mode, the body in quirks mode while it
// is not potentially scrollable) the viewport's client size and the
// viewport scrolling area, at least the viewport, as its scroll size. The
// root element of a quirks-mode document reports its own boxes: its
// client size is its padding box, not the viewport's.
function liveValue(node, options, field) {
  let target = node._coreHandle;
  const source = elementScrollSource(node);
  const viewportOwned = source !== null && source !== node;
  const scrollSize = field === GEOMETRY_SCROLL_WIDTH || field === GEOMETRY_SCROLL_HEIGHT;
  const clientSize = field === GEOMETRY_CLIENT_WIDTH || field === GEOMETRY_CLIENT_HEIGHT;
  if (field === GEOMETRY_SCROLL_LEFT || field === GEOMETRY_SCROLL_TOP) {
    if (source === null) return 0;
    attachKnownScrollState(source);
    if (viewportOwned) target = source._coreHandle ?? 0n;
    const surface = node._renderSurface;
    if (surface?._scrollOwner) {
      const value = node._domCore.status("scroll_current_value", surface._scrollOwner, target,
        field === GEOMETRY_SCROLL_TOP ? 1 : 0, surface.viewport.width, surface.viewport.height);
      if (!Number.isNaN(value)) return value;
    }
  }
  if (viewportOwned && (scrollSize || clientSize)) {
    target = source._coreHandle ?? 0n;
  }
  // Without a surface the viewport is the layout's: the document's or the
  // caller's viewport size.
  const unsurfacedViewport = source === null && (scrollSize || clientSize) && elementScrollsViewport(node);
  const document = nodeMember(node, "ownerDocument");
  const viewportSize = unsurfacedViewport
    ? (field === GEOMETRY_CLIENT_WIDTH || field === GEOMETRY_SCROLL_WIDTH
      ? options?.viewportW ?? document._viewport.width
      : options?.viewportH ?? document._viewport.height)
    : 0;
  if (unsurfacedViewport && clientSize) return Math.round(viewportSize);
  const quirksRoot = node === document?.documentElement && isQuirksMode(document);
  return withLiveGeometry(node, options, ({ core, handle }) => {
    if (OFFSET_FIELDS.has(field)) return offsetValue(core, handle, node, field);
    const value = (valueField) => core.status("geometry_value", handle, target, valueField);
    // Client and scroll sizes are whole pixels (geometry_css_value).
    const cssValue = (valueField) => core.status("geometry_css_value", handle, target, valueField);
    if (unsurfacedViewport) return Math.max(cssValue(field), Math.round(viewportSize));
    if (viewportOwned && scrollSize) {
      return Math.max(cssValue(field),
        cssValue(field === GEOMETRY_SCROLL_WIDTH ? GEOMETRY_CLIENT_WIDTH : GEOMETRY_CLIENT_HEIGHT));
    }
    if (quirksRoot && clientSize) {
      // The padding box: the border box less clientLeft or clientTop and
      // the right or bottom border.
      return field === GEOMETRY_CLIENT_WIDTH
        ? value(GEOMETRY_OFFSET_WIDTH) - value(GEOMETRY_CLIENT_LEFT) - value(GEOMETRY_BORDER_RIGHT)
        : value(GEOMETRY_OFFSET_HEIGHT) - value(GEOMETRY_CLIENT_TOP) - value(GEOMETRY_BORDER_BOTTOM);
    }
    return cssValue(field);
  });
}

// The offset getters (CSSOM View): zero for an element without a box, and
// offsetLeft and offsetTop zero for the body. Chrome gives whole pixels in
// the element's unzoomed CSS pixels (geometry_css_value): offsetLeft and
// offsetTop rounded, offsetWidth and offsetHeight snapped to the rounded
// edges from the offset parent.
const OFFSET_FIELDS = new Set([GEOMETRY_OFFSET_WIDTH, GEOMETRY_OFFSET_HEIGHT, GEOMETRY_OFFSET_LEFT, GEOMETRY_OFFSET_TOP]);
function offsetValue(core, handle, node, field) {
  if (!elementHasBox(core, handle, node)) return 0;
  if ((field === GEOMETRY_OFFSET_LEFT || field === GEOMETRY_OFFSET_TOP) && node === nodeMember(node, "ownerDocument").body) return 0;
  return core.status("geometry_css_value", handle, node._coreHandle, field);
}

function elementHasBox(core, handle, node) {
  return (core.status("element_rendered_state", node._coreHandle) & RENDERED_STATE_NO_BOX) === 0 &&
    core.status("geometry_index", handle, node._coreHandle) >= 0;
}

// offsetParent (CSSOM View, as Chrome's LayoutObject::OffsetParent): null
// for the root and body elements and an element without a box; else the
// record that offsetLeft and offsetTop measure from
// (geometry_offset_parent), and the body when that is the root. A fixed
// element has a parent only when an ancestor contains fixed boxes.
export function offsetParent(node, options) {
  const document = nodeMember(node, "ownerDocument");
  if (node === document.documentElement || node === document.body || !nodeMember(node, "isConnected")) return null;
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
  if (state & (RENDERED_STATE_NO_BOX | RENDERED_STATE_ANCESTOR_SKIPS)) return false;
  if ((options?.checkVisibilityCSS || options?.visibilityProperty) && (state & RENDERED_STATE_INVISIBLE)) return false;
  if (options?.checkOpacity || options?.opacityProperty) {
    const document = nodeMember(node, "ownerDocument");
    for (let element = node; element !== null && nodeMember(element, "nodeType") === 1; element = flatTreeParent(element)) {
      if (Number(document.getComputedStyle(element).opacity) === 0) return false;
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

// A script's elementFromPoint and elementsFromPoint (CSSOM View) hit-test
// the document as it is: the live layout of the current tree, as
// getBoundingClientRect measures it, so a script finds an element that it
// inserted in the same task. A hit test needs no text geometry, so a
// surface's retained layout answers repeated calls. An element of a
// shadow tree retargets to the document tree (node_retarget), so a
// control's user-agent parts answer as the control.
function queryHit(root, x, y, options) {
  return withLiveGeometry(root, options, ({ core, handle }) => {
    const hit = core.status("geometry_hit_test", handle, x, y);
    return core.wrapperFor(hit === 0n ? hit : core.status("node_retarget", hit, 0n));
  });
}

// elementsFromPoint: the same geometry as elementFromPoint, every element
// at the point, topmost first, the root element last; each retargets to
// the document tree, once.
function queryHits(root, x, y, options) {
  return withLiveGeometry(root, options, ({ core, handle }) =>
    [...new Set(geometryHits(core, handle, x, y).map((element) =>
      core.wrapperFor(core.status("node_retarget", element._coreHandle, 0n))))]);
}

// The element that a host's pointer at (x, y) addresses: the topmost
// element of the frame the user sees (the presented frame), as the input
// path targets it (design/interaction.md); with no presented frame for the
// point, the live layout's.
export function presentedElementFromPoint(root, x, y, options) {
  const presented = presentedFrameAt(root, x, y);
  if (presented === null) return elementFromPoint(root, x, y, options);
  return hitTestSnapshot(presented, x, y);
}

// The presented frame of `root`'s surface when it shows the point (x, y):
// a continuous frame shows every point, a page frame those of its page.
function presentedFrameAt(root, x, y) {
  const surface = root._renderSurface;
  const presented = surface?.presentedFrame ?? null;
  if (presented === null) return null;
  const page = surface.page;
  if (page === null) return presented;
  return surface.pagePoint(x, y).page === page.index ? presented : null;
}

// caretPositionFromPoint (CSSOM View): a synchronous layout with the text
// geometry of every laid-out text node, as Chrome lays the document out
// for it, then the caret position at the point
// (core/dom/geometry-range.watpart), or null without an element there.
// On a paged surface the layout holds the text of the point's page.
export function caretPositionFromPoint(root, x, y, options) {
  const position = withLiveGeometry(root, options, ({ core, handle }) =>
    geometryCaretPosition(core, handle, x, y), (paging) => [pageOfPoint(paging.pages, paging.index, x, y).page]);
  return position === null ? null : new SDCaretPosition(nodeMember(root, "ownerDocument"), position.node, position.offset);
}
