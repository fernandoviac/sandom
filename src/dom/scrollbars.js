// The scrollbars of a frame. The core builds them from a geometry snapshot
// (scrollbars_tail) as the geometry tail that the frame's presented
// geometry takes; this module copies the tail and reads one descriptor per
// bar from it for the surface's `scrollbars`.
import { layoutConstant } from "../wasm/layout-table.js";
import { EMPTY_SCROLLBAR_TAIL } from "./geometry.js";
import { withScrollGeometry } from "./scroll-core.js";
const SIDES = new Map([["BOTTOM", "bottom"], ["LEFT", "left"], ["RIGHT", "right"]]
  .map(([name, side]) => [layoutConstant(`SCROLLBAR_SIDE_${name}`), side]));
const BLOCK = Object.freeze(Object.fromEntries(["SIZE", "TRACK", "CLIP", "HAS_CLIP", "VERTICAL", "TARGET", "VALUES", "SIDE", "THUMB",
  "RESIZER"].map((name) => [name, layoutConstant(`GEOMETRY_SCROLLBAR_${name}`)])));
const TAIL_HEADER_SIZE = layoutConstant("GEOMETRY_TAIL_HEADER_SIZE");
const VALUE_NAMES = ["value", "minimum", "maximum", "range", "viewportLength", "scrollLength", "thickness"];

function rectangle(view, at) {
  return { x: view.getFloat64(at, true), y: view.getFloat64(at + 8, true), width: view.getFloat64(at + 16, true), height: view.getFloat64(at + 24, true) };
}

// The descriptor of each bar of geometry tail `tail`: its scroller (the
// viewport object for the viewport's bars), orientation, values, track,
// thumb, side, resize corner and, for an element's bar, the clip of its
// scroller's clipping ancestors (null for none).
export function tailScrollbars(core, tail, viewport) {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const count = (tail.byteLength - TAIL_HEADER_SIZE) / BLOCK.SIZE;
  const descriptors = new Array(count);
  for (let index = 0; index < count; index++) {
    const at = TAIL_HEADER_SIZE + index * BLOCK.SIZE;
    const target = view.getBigUint64(at + BLOCK.TARGET, true);
    const descriptor = {
      element: target === 0n ? viewport : core.wrapperFor(target),
      orientation: view.getUint32(at + BLOCK.VERTICAL, true) === 1 ? "vertical" : "horizontal",
    };
    VALUE_NAMES.forEach((name, slot) => descriptor[name] = view.getFloat64(at + BLOCK.VALUES + slot * 8, true));
    descriptor.track = rectangle(view, at + BLOCK.TRACK);
    descriptor.thumb = rectangle(view, at + BLOCK.THUMB);
    descriptor.side = SIDES.get(view.getUint32(at + BLOCK.SIDE, true));
    descriptor.resizer = view.getFloat64(at + BLOCK.RESIZER, true);
    descriptor.role = "scrollbar";
    if (target !== 0n) descriptor.clip = view.getUint32(at + BLOCK.HAS_CLIP, true) === 1 ? rectangle(view, at + BLOCK.CLIP) : null;
    descriptors[index] = descriptor;
  }
  return descriptors;
}

// The scrollbars of a geometry snapshot (viewport first, then elements in
// flat-tree order), predicted for the pending scroll capture when given:
// { tail, scrollbars }, the geometry tail and its descriptors.
export function snapshotScrollbars(root, viewport, core, snapshot, capture = 0n) {
  core.status("scrollbars_tail", snapshot, capture, root._coreHandle);
  const tail = core.outputBytes("scrollbars_tail");
  return { tail, scrollbars: tailScrollbars(core, tail, viewport) };
}
// First-frame path: no presented snapshot yet, so one is built from boxes.
export function computeScrollbars(serialized, boxes, viewport = null) {
  const root = viewport?._surface?._root ?? serialized.indexOf.keys().next().value;
  if (!root) return { tail: EMPTY_SCROLLBAR_TAIL, scrollbars: [] };
  return withScrollGeometry(root, viewport, boxes, serialized, (core, snapshot) => snapshotScrollbars(root, viewport, core, snapshot, 0n));
}
