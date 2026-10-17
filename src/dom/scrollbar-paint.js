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
// or less is a dark backdrop, which takes light bars. Sandom does not resolve
// the `color-scheme` property, so the backdrop is the only input.
// `scrollbar-color` replaces the thumb colour in every state and the track
// colour, and removes the edge line.
import { resolvedElementFields } from "./style.js";

// The width an overlay box gains under the pointer, in CSS px.
export const OVERLAY_SCROLLBAR_EXPANSION = 4;

const rgba = (r, g, b, a = 1) => Object.freeze({ r: r / 255, g: g / 255, b: b / 255, a });

export const SCROLLBAR_PALETTES = Object.freeze({
  overlay: Object.freeze({
    light: Object.freeze({
      thumb: rgba(0, 0, 0, 0.45),
      hover: rgba(0, 0, 0, 0.56),
      pressed: rgba(0, 0, 0, 0.7),
      track: rgba(250, 250, 250, 0.9),
      edge: rgba(0, 0, 0, 0.12),
    }),
    dark: Object.freeze({
      thumb: rgba(255, 255, 255, 0.45),
      hover: rgba(255, 255, 255, 0.58),
      pressed: rgba(255, 255, 255, 0.74),
      track: rgba(28, 28, 28, 0.9),
      edge: rgba(255, 255, 255, 0.14),
    }),
  }),
  classic: Object.freeze({
    light: Object.freeze({
      thumb: rgba(194, 194, 194),
      hover: rgba(168, 168, 168),
      pressed: rgba(140, 140, 140),
      track: rgba(246, 246, 246),
      edge: rgba(226, 226, 226),
    }),
    dark: Object.freeze({
      thumb: rgba(110, 110, 110),
      hover: rgba(134, 134, 134),
      pressed: rgba(160, 160, 160),
      track: rgba(42, 42, 42),
      edge: rgba(59, 59, 59),
    }),
  }),
});

// Cross-axis inset of the thumb in its box, in CSS px, at rest and expanded
// alike: an overlay thumb is 4 px wide at rest and 8 px expanded; a classic
// thumb is 7 px wide (5 px thin).
const THUMB_INSET = Object.freeze({ regular: 4, thin: 3 });

function parentOf(node) {
  const parent = node.parentNode;
  return parent?.nodeType === 11 ? parent.host ?? null : parent ?? null;
}

const transparent = (color) => !color || color.a === 0;

// "light" or "dark": the backdrop of a scroller's bars. `element` is the
// scroller, or the root element for the viewport's bars.
export function scrollbarBackdrop(element, isViewport) {
  const layers = [];
  if (isViewport) {
    let color = resolvedElementFields(element).bg;
    if (transparent(color) && element.tagName === "HTML") {
      const body = element.ownerDocument?.body;
      if (body) color = resolvedElementFields(body).bg;
    }
    if (!transparent(color)) layers.push(color);
  } else {
    for (let node = element; node && node.nodeType === 1; node = parentOf(node)) {
      const color = resolvedElementFields(node).bg;
      if (transparent(color)) continue;
      layers.push(color);
      if (color.a >= 1) break;
    }
  }
  // Composite the layers, outermost first, over the white canvas.
  let r = 1;
  let g = 1;
  let b = 1;
  for (let index = layers.length - 1; index >= 0; index--) {
    const { r: lr, g: lg, b: lb, a } = layers[index];
    r = lr * a + r * (1 - a);
    g = lg * a + g * (1 - a);
    b = lb * a + b * (1 - a);
  }
  const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  return lightness <= 0.5 ? "dark" : "light";
}

// The colours of a scroller's bars: { thumb, hover, pressed, track, edge }.
export function scrollbarColors(element, isViewport, style) {
  const authored = resolvedElementFields(element).scrollbarColor;
  if (authored && authored !== "auto") {
    const [thumb, track] = authored;
    return { thumb, hover: thumb, pressed: thumb, track, edge: null };
  }
  return SCROLLBAR_PALETTES[style][scrollbarBackdrop(element, isViewport)];
}

const mix = (from, to, amount) => amount === 0 ? from : {
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
  a: from.a + (to.a - from.a) * amount,
};
const faded = (color, alpha) => alpha === 1 ? color : { ...color, a: color.a * alpha };

// The painted parts of one bar, back to front, in CSS px of the viewport:
// [{ role, x, y, width, height, radius, color }] with role "track", "edge"
// or "thumb". A hidden overlay bar has none.
export function scrollbarParts(bar, style) {
  const { thumbAlpha, trackAlpha, expansion, pointer } = bar.visibility;
  if (thumbAlpha === 0 && trackAlpha === 0) return [];
  const vertical = bar.orientation === "vertical";
  const overlay = style === "overlay";
  const thin = bar.thickness < (overlay ? 12 : 15);
  const inset = THUMB_INSET[thin ? "thin" : "regular"];
  const grow = overlay ? OVERLAY_SCROLLBAR_EXPANSION * expansion : 0;
  const size = bar.thickness + grow;
  // The box keeps its outer edge and widens toward the content. A vertical
  // bar on the left (a right-to-left scroller) has its content on the right.
  const contentAfter = vertical && bar.side === "left";
  const box = vertical
    ? { x: contentAfter ? bar.track.x : bar.track.x - grow, y: bar.track.y, width: size, height: bar.track.height }
    : { x: bar.track.x, y: bar.track.y - grow, width: bar.track.width, height: size };
  const colors = bar.colors;
  const parts = [];
  if (trackAlpha > 0) {
    parts.push({ role: "track", ...box, radius: 0, color: faded(colors.track, trackAlpha) });
    if (colors.edge) {
      parts.push({
        role: "edge",
        ...(vertical
          ? { x: contentAfter ? box.x + box.width - 1 : box.x, y: box.y, width: 1, height: box.height }
          : { x: box.x, y: box.y, width: box.width, height: 1 }),
        radius: 0,
        color: faded(colors.edge, trackAlpha),
      });
    }
  }
  const length = vertical ? bar.thumb.height : bar.thumb.width;
  const across = size - 2 * inset;
  if (thumbAlpha > 0 && length > 0 && across > 0) {
    const color = pointer === "pressed"
      ? colors.pressed
      : overlay
      ? mix(colors.thumb, colors.hover, expansion)
      : pointer === "hover"
      ? colors.hover
      : colors.thumb;
    parts.push({
      role: "thumb",
      ...(vertical
        ? { x: box.x + inset, y: bar.thumb.y, width: across, height: length }
        : { x: bar.thumb.x, y: box.y + inset, width: length, height: across }),
      radius: Math.min(across, length) / 2,
      color: faded(color, thumbAlpha),
    });
  }
  return parts;
}

// The corner square of a classic scroller with both bars, in the track
// colour, or null.
export function scrollbarCorner(vertical, horizontal, style) {
  if (style !== "classic" || !vertical || !horizontal) return null;
  return {
    role: "corner",
    x: vertical.track.x,
    y: horizontal.track.y,
    width: vertical.track.width,
    height: horizontal.track.height,
    radius: 0,
    color: vertical.colors.track,
  };
}

// Every bar's painted parts: [{ bar, parts }] in descriptor order; a classic
// corner belongs to the scroller's vertical bar.
export function paintScrollbars(scrollbars, style) {
  const verticals = new Map();
  const horizontals = new Map();
  for (const bar of scrollbars) {
    (bar.orientation === "vertical" ? verticals : horizontals).set(bar.element, bar);
  }
  return scrollbars.map((bar) => {
    const parts = scrollbarParts(bar, style);
    if (bar.orientation === "vertical") {
      const corner = scrollbarCorner(bar, horizontals.get(bar.element), style);
      if (corner) parts.unshift(corner);
    }
    return { bar, parts };
  });
}
