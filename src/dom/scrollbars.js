import { layoutConstant } from "../wasm/layout-table.js";
import { withScrollGeometry } from "./scroll-core.js";
import { scrollbarColors } from "./scrollbar-paint.js";
const SIDES = new Map([["BOTTOM", "bottom"], ["LEFT", "left"], ["RIGHT", "right"]]
  .map(([name, side]) => [layoutConstant(`SCROLLBAR_SIDE_${name}`), side]));
const SLOT = Object.freeze(Object.fromEntries(["VALUE", "MINIMUM", "MAXIMUM", "RANGE", "VIEWPORT_LENGTH", "SCROLL_LENGTH",
  "THICKNESS", "TRACK", "THUMB", "CLIP", "HAS_CLIP", "AXIS", "SIDE", "RESIZER"].map((name) => [name, layoutConstant(`SCROLLBAR_SLOT_${name}`)])));
function describe(core, record, element, viewport, root, style) {
  try {
    const value = (slot) => core.status("scrollbar_value", record, slot);
    const rectangle = (slot) => ({ x: value(slot), y: value(slot + 1), width: value(slot + 2), height: value(slot + 3) });
    const isViewport = element === viewport;
    const owner = isViewport ? root : element;
    return {
      element, orientation: value(SLOT.AXIS) ? "vertical" : "horizontal", value: value(SLOT.VALUE), minimum: value(SLOT.MINIMUM),
      maximum: value(SLOT.MAXIMUM), range: value(SLOT.RANGE), viewportLength: value(SLOT.VIEWPORT_LENGTH),
      scrollLength: value(SLOT.SCROLL_LENGTH), thickness: value(SLOT.THICKNESS), track: rectangle(SLOT.TRACK),
      thumb: rectangle(SLOT.THUMB), side: SIDES.get(value(SLOT.SIDE)), resizer: value(SLOT.RESIZER), colors: scrollbarColors(owner, isViewport, style),
      role: "scrollbar", ...(isViewport ? {} : { clip: value(SLOT.HAS_CLIP) ? rectangle(SLOT.CLIP) : null }),
    };
  } finally { core.status("scrollbar_release", record); }
}
// Every scrollbar of a geometry snapshot (viewport first, then elements in
// flat-tree order), predicted for the pending scroll capture when given.
// `style` ("overlay" or "classic") selects the palette.
export function snapshotScrollbars(root, viewport, core, snapshot, capture = 0n, style = "overlay") {
  const count = core.status("scrollbars_build", snapshot, capture, root._coreHandle);
  const descriptors = new Array(count);
  for (let index = 0; index < count; index++) {
    const record = core.handle("selector_result_handle", index);
    const node = core.status("scrollbar_node", record);
    descriptors[index] = describe(core, record, node ? core.wrapperFor(node) : viewport, viewport, root, style);
  }
  return descriptors;
}
// First-frame path: no presented snapshot yet, so one is built from boxes.
export function computeScrollbars(serialized, boxes, viewport = null, style = "overlay") {
  const root = viewport?._surface?._root ?? serialized.indexOf.keys().next().value;
  if (!root) return [];
  return withScrollGeometry(root, viewport, boxes, serialized, (core, snapshot) => snapshotScrollbars(root, viewport, core, snapshot, 0n, style));
}
