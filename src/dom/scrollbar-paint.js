// Sandom's own scrollbar design (design/scrollbars.md, "Drawing";
// design/interaction.md, "Scrollbars"). The core paints the bars of a
// frame (core/dom/scrollbar-paint.watpart, scroll_bars_paint): from the
// frame's geometry tail and the visibility that its bar set gave each bar,
// it gives each painted part as a raster plan scrollbar row with the bar
// and the role of the part. This module copies them.
import { layoutConstant } from "../wasm/layout-table.js";

const ROW_SIZE = layoutConstant("RASTER_PLAN_SCROLLBAR_ROW_SIZE");
const INFO = Object.freeze(Object.fromEntries(["SIZE", "BAR", "ROLE"]
  .map((name) => [name, layoutConstant(`SCROLL_BAR_PART_INFO_${name}`)])));
const PART_ROLES = new Map([["CORNER", "corner"], ["TRACK", "track"], ["EDGE", "edge"], ["THUMB", "thumb"]]
  .map(([name, role]) => [layoutConstant(`SCROLL_BAR_PART_${name}`), role]));

// The painted parts of the bars of geometry tail `tail` (bytes) at the
// visibility of bar set `set`, back to front: [{ barIndex, role, row, x, y,
// width, height, radius, color }] in CSS px of the viewport, with role
// "corner", "track", "edge" or "thumb" and `row` the publication row of the
// bar's scroller (-1 for the viewport's bars). `root` is the surface's root
// element, whose style the viewport's bars take; `publication` is the
// frame's DOM publication.
export function paintScrollbars(core, set, tail, root, publication) {
  const count = core.status("scroll_bars_paint", set, ...core.byteInput(tail), root._coreHandle, publication);
  const view = count === 0 ? null : core.output("scroll_bars_paint");
  const parts = new Array(count);
  for (let part = 0; part < count; part++) {
    const row = part * ROW_SIZE;
    const info = count * ROW_SIZE + part * INFO.SIZE;
    const float = (index) => view.getFloat32(row + index * 4, true);
    parts[part] = {
      barIndex: view.getUint32(info + INFO.BAR, true),
      role: PART_ROLES.get(view.getUint32(info + INFO.ROLE, true)),
      row: float(0),
      x: float(1),
      y: float(2),
      width: float(3),
      height: float(4),
      color: { r: float(5), g: float(6), b: float(7), a: float(8) },
      radius: float(9),
    };
  }
  return parts;
}
