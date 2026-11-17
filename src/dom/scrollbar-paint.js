// Sandom's own scrollbar design (design/scrollbars.md, "Drawing";
// design/interaction.md, "Scrollbars"). The descriptor (scroll.watpart
// $scrollbarBuild) gives the bar's box at rest and the thumb's place along
// the axis; this module turns a descriptor and its visibility record into the
// painted parts, and resolves the colours.
//
// - Overlay: a slim, fully rounded thumb inside a 12 px box (10 px thin).
//   Under the pointer the box widens to 16 px (14 px thin) away from the
//   scroller's edge, the thumb widens with it, and a track with a 1 px edge
//   line on the content side fades in.
// - Classic: a 15 px bar (11 px thin) in the space the scroller reserved: an
//   opaque track with a 1 px edge line next to the content, and a rounded
//   thumb inset in the bar. The thumb is darker under the pointer and darker
//   again while it is pressed. The bar does not widen. Two bars of one
//   scroller fill their corner with the track colour.
//
// The palette follows the backdrop: the composited background colour of the
// scroller and its ancestors over the white canvas (for the viewport, the
// root's background, else the body's). As in Chrome, an HSL lightness of 0.5
// or less is a dark backdrop, which takes light bars. The palette does not
// read the element color scheme, so the backdrop is the only input.
// `scrollbar-color` replaces the thumb colour in every state and the track
// colour, and removes the edge line.
// The backdrop, the palettes, the colour choice and the parts are
// core/dom/scrollbar-paint.watpart.
import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The width an overlay box gains under the pointer, in CSS px.
export const OVERLAY_SCROLLBAR_EXPANSION = 4;

const COLOR_RGBA = Object.freeze(Object.fromEntries(["SIZE", "R", "G", "B", "A"]
  .map((name) => [name, layoutConstant(`COLOR_RGBA_${name}`)])));
const SCROLL_BAR_COLORS_AUTHORED = layoutConstant("SCROLL_BAR_COLORS_AUTHORED");

const channels = (color) => color ? [color.r, color.g, color.b, color.a] : [0, 0, 0, 0];

// The colours of a scroller's bars: { thumb, hover, pressed, track, edge }
// (scroll_bar_colors). `element` is the scroller, or the root element for
// the viewport's bars.
export function scrollbarColors(element, isViewport, style) {
  const core = element._domCore;
  const source = core.status("scroll_bar_colors", element._coreHandle, isViewport ? 1 : 0, style === "classic" ? 1 : 0);
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), 5 * COLOR_RGBA.SIZE);
  const color = (index) => {
    const at = index * COLOR_RGBA.SIZE;
    return {
      r: view.getFloat64(at + COLOR_RGBA.R, true),
      g: view.getFloat64(at + COLOR_RGBA.G, true),
      b: view.getFloat64(at + COLOR_RGBA.B, true),
      a: view.getFloat64(at + COLOR_RGBA.A, true),
    };
  };
  return {
    thumb: color(0), hover: color(1), pressed: color(2), track: color(3),
    edge: source === SCROLL_BAR_COLORS_AUTHORED ? null : color(4),
  };
}

const PART_ROLES = new Map([["CORNER", "corner"], ["TRACK", "track"], ["EDGE", "edge"], ["THUMB", "thumb"]]
  .map(([name, role]) => [layoutConstant(`SCROLL_BAR_PART_${name}`), role]));
const PART_FIRST = layoutConstant("SCROLL_BAR_PART_FIRST");
const PART_SLOTS = layoutConstant("SCROLL_BAR_PART_SLOTS");
const POINTER_CODES = new Map([
  [null, layoutConstant("SCROLL_BAR_POINTER_NONE")],
  ["hover", layoutConstant("SCROLL_BAR_POINTER_HOVER")],
  ["pressed", layoutConstant("SCROLL_BAR_POINTER_PRESSED")],
]);

// The painted parts of one bar, back to front, in CSS px of the viewport:
// [{ role, x, y, width, height, radius, color }] with role "corner",
// "track", "edge" or "thumb" (scroll_bar_paint). `horizontal` is the
// scroller's horizontal bar beside a vertical `bar`, whose corner a classic
// bar paints.
function barParts(bar, style, horizontal) {
  const { thumbAlpha, trackAlpha, expansion, pointer } = bar.visibility;
  const { colors, track, thumb } = bar;
  const values = [
    style === "overlay" ? 1 : 0,
    bar.orientation === "vertical" ? 1 : 0,
    bar.side === "left" ? 1 : 0,
    bar.thickness,
    track.x, track.y, track.width, track.height,
    thumb.x, thumb.y, thumb.width, thumb.height,
    thumbAlpha, trackAlpha, expansion, POINTER_CODES.get(pointer ?? null),
    colors.edge ? 1 : 0,
    ...channels(colors.thumb), ...channels(colors.hover), ...channels(colors.pressed),
    ...channels(colors.track), ...channels(colors.edge),
    horizontal ? 1 : 0, horizontal?.track.y ?? 0, horizontal?.track.height ?? 0,
    bar.resizer ?? 0,
  ];
  const core = sharedDomCore;
  // 41 numbers as f64 bytes: a host value list encodes each number with its
  // text and JSON, which cost more than the paint itself on each frame.
  const count = core.status("scroll_bar_paint", ...core.byteInput(new Uint8Array(new Float64Array(values).buffer)));
  const value = (part, field) => core.exports.scroll_bar_value(PART_FIRST + part * PART_SLOTS + field);
  const parts = new Array(count);
  for (let part = 0; part < count; part++) {
    parts[part] = {
      role: PART_ROLES.get(value(part, 0)),
      x: value(part, 1),
      y: value(part, 2),
      width: value(part, 3),
      height: value(part, 4),
      radius: value(part, 5),
      color: { r: value(part, 6), g: value(part, 7), b: value(part, 8), a: value(part, 9) },
    };
  }
  return parts;
}

// Every bar's painted parts: [{ bar, parts }] in descriptor order; a classic
// corner belongs to the scroller's vertical bar.
export function paintScrollbars(scrollbars, style) {
  const horizontals = new Map();
  for (const bar of scrollbars) {
    if (bar.orientation !== "vertical") horizontals.set(bar.element, bar);
  }
  return scrollbars.map((bar) => ({
    bar,
    parts: barParts(bar, style, bar.orientation === "vertical" ? horizontals.get(bar.element) : null),
  }));
}
