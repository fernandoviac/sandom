// Shared command-buffer WRITERS — the single source of truth for hand-writing
// draw commands, the way commandByteSize (layout.js) is the single source of
// truth for walking them. Before Slice P2 every consumer (five test files +
// the text-streaming demo) hand-rolled its own writeRect/writePushClip against
// the raw offsets; that is the same N-independent-copies bug class that bit
// writeNode (Slice 8A), nodeCss (8C), and the command walkers (the
// text-under-clip bug) — a format change silently strands the copies. All
// writers return the number of bytes written so callers can advance a cursor.
//
// Color values are {r, g, b, a} floats in [0, 1]; positions/sizes are px.

import {
  CMD_RECT, CMD_RECT_SIZE,
  CMD_RECT_OFFSET_FLAGS, CMD_RECT_OFFSET_X, CMD_RECT_OFFSET_Y,
  CMD_RECT_OFFSET_W, CMD_RECT_OFFSET_H, CMD_RECT_OFFSET_FILL,
  CMD_RECT_OFFSET_BORDER_COLOR_TOP, CMD_RECT_OFFSET_BORDER_COLOR_RIGHT,
  CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM, CMD_RECT_OFFSET_BORDER_COLOR_LEFT,
  CMD_RECT_OFFSET_BORDER_TOP, CMD_RECT_OFFSET_BORDER_RIGHT,
  CMD_RECT_OFFSET_BORDER_BOTTOM, CMD_RECT_OFFSET_BORDER_LEFT,
  CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X, CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y,
  CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X, CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X, CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y,
  CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X, CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y,
  CMD_RECT_OFFSET_XFORM,
  CMD_RECT_FLAG_FILL, CMD_RECT_FLAG_BORDER, CMD_RECT_FLAG_GRADIENT, CMD_RECT_FLAG_TRANSFORM,
  CMD_RECT_GRADIENT_OFFSET_KIND,
  CMD_RECT_GRADIENT_OFFSET_STOP_COUNT, CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET,
  CMD_RECT_GRADIENT_OFFSET_GEOM,
  CMD_PUSH_CLIP, CMD_PUSH_CLIP_HEADER_SIZE, CMD_PUSH_CLIP_OFFSET_FLAGS,
  CMD_PUSH_CLIP_OFFSET_COUNT, cmdPushClipSize,
  CLIP_ENTRY_SIZE, CLIP_ENTRY_OFFSET_FLAGS,
  CLIP_ENTRY_OFFSET_X, CLIP_ENTRY_OFFSET_Y,
  CLIP_ENTRY_OFFSET_W, CLIP_ENTRY_OFFSET_H,
  CLIP_ENTRY_OFFSET_RADII, CLIP_ENTRY_OFFSET_AFFINE,
  CLIP_ENTRY_FLAG_ENABLED_X, CLIP_ENTRY_FLAG_ENABLED_Y, CLIP_ENTRY_FLAG_AFFINE,
  CMD_POP_CLIP, CMD_POP_CLIP_SIZE,
  CMD_PUSH_OPACITY,
  CMD_PUSH_OPACITY_OFFSET_FLAGS, CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT,
  CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT, CMD_PUSH_OPACITY_OFFSET_ALPHA,
  CMD_PUSH_OPACITY_OFFSET_SEGMENTS, CMD_PUSH_OPACITY_SEGMENT_SIZE,
  CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND, CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD,
  CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX, CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR,
  CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW,
  cmdPushOpacitySize,
  CMD_POP_OPACITY, CMD_POP_OPACITY_SIZE,
  CMD_PUSH_BACKDROP_FILTER, CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT,
  CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS, cmdPushBackdropFilterSize,
  cmdPushBackdropFilterOwnShapeOffset,
  CMD_POP_BACKDROP_FILTER, CMD_POP_BACKDROP_FILTER_SIZE,
  cmdRectGradientOffset, cmdRectSize,
} from './layout.js';
import { layoutConstant } from './layout-table.js';

const CMD_HEADER_FLAGS = layoutConstant('CMD_HEADER_FLAGS');
const CMD_HEADER_WORD = layoutConstant('CMD_HEADER_WORD');
const CLIP_ENTRY_OFFSET_SCROLL_REF = layoutConstant('CLIP_ENTRY_OFFSET_SCROLL_REF');
const FILTER_PAYLOAD = Object.freeze(Object.fromEntries(['BLUR_SIGMA_X', 'BLUR_SIGMA_Y', 'SHADOW_DX', 'SHADOW_DY',
  'SHADOW_SIGMA_X', 'SHADOW_COLOR', 'SHADOW_SIGMA_Y'].map((name) => [name, layoutConstant(`CMD_FILTER_${name}`)])));

const F32 = Float32Array.BYTES_PER_ELEMENT;

// A color as four f32 components: r, g, b, a.
function writeColor(view, offset, color) {
  [color.r, color.g, color.b, color.a].forEach((component, index) =>
    view.setFloat32(offset + index * F32, component ?? 0, true));
}

// rect: { x, y, w, h, flags?,
//   fr, fg, fb, fa                — fill rgba (floats, default 0)
//   bcr, bcg, bcb, bca            — uniform border color for all four sides
//   borderColorTop/Right/Bottom/Left — {r,g,b,a}, overrides the uniform color per side
//   bt, br, bb, bl                — border widths per side (default 0)
//   radius                        — uniform CIRCULAR corner radius (rx=ry) for all corners
//   radiusTopLeft/TopRight/BottomRight/BottomLeft — per-corner override, a
//     plain number (circular, rx=ry) OR {rx, ry} (elliptical, P10)
//   transform                     — [a,b,c,d,e,f], sets the TRANSFORM flag
//   gradient                      — { kind (0=linear,1=radial,2=conic, bit7
//     repeating), stopCount, stopOffset (byte offset into
//     GRADIENT_STOP_POOL_BASE), geom: [4 numbers] }, sets the GRADIENT flag
//     and appends the 24 B extension AFTER the transform block (present or
//     not) — mirrors layout.js's cmdRectGradientOffset() (P4, layout
//     plumbing only — no shader reads this extension yet) }
function radiusXY(cornerOverride, uniform) {
  const v = cornerOverride ?? uniform ?? 0;
  if (typeof v === 'object') return [v.rx ?? 0, v.ry ?? 0];
  return [v, v];
}
export function writeRect(view, offset, rect) {
  const hasTransform = Array.isArray(rect.transform);
  const hasGradient = !!rect.gradient;
  view.setUint8(offset, CMD_RECT);
  // Default flags cover BOTH fill and border (the ordinary "one atomic
  // draw" case every real caller wants) — pass an explicit `flags` to opt
  // into a fill-only/border-only split draw (P5c border-order fix).
  view.setUint8(offset + CMD_RECT_OFFSET_FLAGS,
    (rect.flags ?? (CMD_RECT_FLAG_FILL | CMD_RECT_FLAG_BORDER))
      | (hasTransform ? CMD_RECT_FLAG_TRANSFORM : 0)
      | (hasGradient ? CMD_RECT_FLAG_GRADIENT : 0));
  // border styles (P7): the header word holds them, packed 4 bits per side
  // (top | right<<4 | bottom<<8 | left<<12), BORDER_STYLE_* values; 0 = all
  // solid.
  view.setUint16(offset + CMD_HEADER_WORD, rect.borderStyles ?? 0, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_X, rect.x, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_Y, rect.y, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_W, rect.w, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_H, rect.h, true);
  writeColor(view, offset + CMD_RECT_OFFSET_FILL,
    { r: rect.fr, g: rect.fg, b: rect.fb, a: rect.fa });
  const uniformBorderColor = { r: rect.bcr, g: rect.bcg, b: rect.bcb, a: rect.bca };
  writeColor(view, offset + CMD_RECT_OFFSET_BORDER_COLOR_TOP, rect.borderColorTop ?? uniformBorderColor);
  writeColor(view, offset + CMD_RECT_OFFSET_BORDER_COLOR_RIGHT, rect.borderColorRight ?? uniformBorderColor);
  writeColor(view, offset + CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM, rect.borderColorBottom ?? uniformBorderColor);
  writeColor(view, offset + CMD_RECT_OFFSET_BORDER_COLOR_LEFT, rect.borderColorLeft ?? uniformBorderColor);
  view.setFloat32(offset + CMD_RECT_OFFSET_BORDER_TOP, rect.bt ?? 0, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_BORDER_RIGHT, rect.br ?? 0, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_BORDER_BOTTOM, rect.bb ?? 0, true);
  view.setFloat32(offset + CMD_RECT_OFFSET_BORDER_LEFT, rect.bl ?? 0, true);
  {
    const [tlX, tlY] = radiusXY(rect.radiusTopLeft, rect.radius);
    const [trX, trY] = radiusXY(rect.radiusTopRight, rect.radius);
    const [brX, brY] = radiusXY(rect.radiusBottomRight, rect.radius);
    const [blX, blY] = radiusXY(rect.radiusBottomLeft, rect.radius);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X, tlX, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y, tlY, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X, trX, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y, trY, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X, brX, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y, brY, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X, blX, true);
    view.setFloat32(offset + CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y, blY, true);
  }
  if (hasTransform) {
    for (let i = 0; i < 6; i++) {
      view.setFloat32(offset + CMD_RECT_OFFSET_XFORM + i * F32, rect.transform[i], true);
    }
  }
  if (hasGradient) {
    const gradExtOffset = offset + cmdRectGradientOffset(hasTransform);
    const g = rect.gradient;
    view.setUint8(gradExtOffset + CMD_RECT_GRADIENT_OFFSET_KIND, g.kind ?? 0);
    view.setUint8(gradExtOffset + CMD_RECT_GRADIENT_OFFSET_STOP_COUNT, g.stopCount ?? 0);
    view.setUint32(gradExtOffset + CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET, g.stopOffset ?? 0, true);
    const geom = g.geom ?? [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      view.setFloat32(gradExtOffset + CMD_RECT_GRADIENT_OFFSET_GEOM + i * F32, geom[i] ?? 0, true);
    }
  }
  return cmdRectSize(hasTransform, hasGradient);
}

// clip (oriented-clip redesign — a push carries the COMPLETE clip state,
// which REPLACES the rasterizer's current one; there is no intersect-on-
// push or ABSOLUTE flag anymore, see layout.js's CMD_PUSH_CLIP doc):
//   EITHER one entry directly: { x, y, w, h, clipX?, clipY?, radius?,
//     radii?, affine? }
//   OR an explicit list:       { entries: [entry, ...] }  (entries: []
//     pushes the empty "no clip at all" state)
// Per entry:
//   radius  — uniform CIRCULAR corner radius (rx = ry) for all corners
//   radii   — per-corner ellipses, overrides radius:
//             { topLeft: {rx, ry}, topRight: {rx, ry},
//               bottomRight: {rx, ry}, bottomLeft: {rx, ry} }
//             (missing corners are square, 0/0)
//   affine  — [a, b, c, d, e, f] mapping the entry's local space to
//             screen pixels (the rect/radii are then local-space values)
const CLIP_ENTRY_CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

// Shared by writePushClip (N entries) and writePushBackdropFilter's own
// trailing own-shape entry (always exactly 1) — the single CLIP_ENTRY
// (80-byte) record writer.
function writeClipEntry(view, entryOffset, entry) {
  const hasAffine = Array.isArray(entry.affine);
  view.setUint32(entryOffset + CLIP_ENTRY_OFFSET_FLAGS,
    (entry.clipX ? CLIP_ENTRY_FLAG_ENABLED_X : 0)
      | (entry.clipY ? CLIP_ENTRY_FLAG_ENABLED_Y : 0)
      | (hasAffine ? CLIP_ENTRY_FLAG_AFFINE : 0),
    true);
  view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_X, entry.x, true);
  view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_Y, entry.y, true);
  view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_W, entry.w, true);
  view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_H, entry.h, true);
  const uniform = { rx: entry.radius ?? 0, ry: entry.radius ?? 0 };
  for (let corner = 0; corner < 4; corner++) {
    const cornerRadii = entry.radii ? (entry.radii[CLIP_ENTRY_CORNERS[corner]] ?? { rx: 0, ry: 0 }) : uniform;
    // Each corner is an (rx, ry) pair of f32.
    view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_RADII + corner * 2 * F32, cornerRadii.rx ?? 0, true);
    view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_RADII + (corner * 2 + 1) * F32, cornerRadii.ry ?? 0, true);
  }
  for (let component = 0; component < 6; component++) {
    view.setFloat32(entryOffset + CLIP_ENTRY_OFFSET_AFFINE + component * F32,
      hasAffine ? entry.affine[component] : 0, true);
  }
  view.setUint32(entryOffset + CLIP_ENTRY_OFFSET_SCROLL_REF, 0, true);
}

export function writePushClip(view, offset, clip) {
  const entries = clip.entries ?? [clip];
  view.setUint8(offset, CMD_PUSH_CLIP);
  view.setUint8(offset + CMD_PUSH_CLIP_OFFSET_FLAGS, 0);
  view.setUint16(offset + CMD_PUSH_CLIP_OFFSET_COUNT, entries.length, true);
  for (let i = 0; i < entries.length; i++) {
    writeClipEntry(view, offset + CMD_PUSH_CLIP_HEADER_SIZE + i * CLIP_ENTRY_SIZE, entries[i]);
  }
  return cmdPushClipSize(entries.length);
}

export function writePopClip(view, offset) {
  view.setUint8(offset, CMD_POP_CLIP);
  view.setUint8(offset + CMD_HEADER_FLAGS, 0);
  view.setUint16(offset + CMD_HEADER_WORD, 0, true);
  return CMD_POP_CLIP_SIZE;
}

// op: { opacity, blendMode? (BLEND_* enum), filterSegments? (P8) }
// filterSegments: [{ kind: 'matrix', matrix: f32[20] row-major 4x5 } |
//                  { kind: 'blur', sigma: number } |
//                  { kind: 'drop-shadow', dx, dy, sigma, color: {r,g,b,a} }],
// sigma in CSS px, written as both the horizontal and the vertical standard
// deviation (the wire carries both; only a non-uniformly scaling transform,
// which $composeFilterSegments maps, makes them differ),
// in APPLICATION order (matches $composeFilterSegments' own
// list-order-is-application-order convention — a filter list's
// contiguous color-matrix runs fold into ONE matrix segment each, a
// blur() or drop-shadow() breaks the fold into its own segment; see
// design/paint-coverage.md's P8 blur/drop-shadow design notes).
// Shared by writePushOpacity and writePushBackdropFilter — both wire
// formats carry the identical segment-list extension (same KIND enum, same
// per-segment payload layout; backdrop-filter's own command just omits the
// alpha/blendMode header fields).
function writeFilterSegments(view, segmentsBase, segments) {
  segments.forEach((segment, i) => {
    const segBase = segmentsBase + i * CMD_PUSH_OPACITY_SEGMENT_SIZE;
    if (segment.kind === 'matrix') {
      view.setUint8(segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND, CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX);
      for (let j = 0; j < 20; j++) {
        view.setFloat32(segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD + j * F32, segment.matrix[j], true);
      }
    } else if (segment.kind === 'blur') {
      view.setUint8(segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND, CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR);
      const payloadOffset = segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD;
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.BLUR_SIGMA_X, segment.sigma, true);
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.BLUR_SIGMA_Y, segment.sigma, true);
    } else if (segment.kind === 'drop-shadow') {
      view.setUint8(segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND, CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW);
      const payloadOffset = segBase + CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD;
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.SHADOW_DX, segment.dx, true);
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.SHADOW_DY, segment.dy, true);
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.SHADOW_SIGMA_X, segment.sigma, true);
      writeColor(view, payloadOffset + FILTER_PAYLOAD.SHADOW_COLOR, segment.color);
      view.setFloat32(payloadOffset + FILTER_PAYLOAD.SHADOW_SIGMA_Y, segment.sigma, true);
    } else {
      throw new Error(`writeFilterSegments: unknown filter segment kind "${segment.kind}"`);
    }
  });
}

export function writePushOpacity(view, offset, op) {
  const segments = op.filterSegments ?? [];
  view.setUint8(offset, CMD_PUSH_OPACITY);
  view.setUint8(offset + CMD_PUSH_OPACITY_OFFSET_FLAGS,
    (op.blendMode ?? 0) << CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT);
  view.setUint16(offset + CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT, segments.length, true);
  view.setFloat32(offset + CMD_PUSH_OPACITY_OFFSET_ALPHA, op.opacity ?? 1, true);
  writeFilterSegments(view, offset + CMD_PUSH_OPACITY_OFFSET_SEGMENTS, segments);
  return cmdPushOpacitySize(segments.length);
}

export function writePopOpacity(view, offset) {
  view.setUint8(offset, CMD_POP_OPACITY);
  view.setUint8(offset + CMD_HEADER_FLAGS, 0);
  view.setUint16(offset + CMD_HEADER_WORD, 0, true);
  return CMD_POP_OPACITY_SIZE;
}

// backdrop-filter (P8b): { filterSegments?, ownShape } — filterSegments is
// the same segment shape as writePushOpacity's own op.filterSegments, no
// opacity/blendMode fields at all (backdrop-filter has neither of its
// own). ownShape is REQUIRED — one CLIP_ENTRY-format entry (same shape
// writePushClip's own per-entry object takes: { x, y, w, h, clipX?,
// clipY?, radius?, radii?, affine? }) giving the element's own border box.
// Unlike CMD_PUSH_CLIP's entry list, this does NOT ride the shared
// clip-list/CLIP_ARENA — see layout.js's own CMD_PUSH_BACKDROP_FILTER doc
// comment for why (backdrop-filter clips its own composite-back, never
// its descendants).
export function writePushBackdropFilter(view, offset, op) {
  const segments = op?.filterSegments ?? [];
  view.setUint8(offset, CMD_PUSH_BACKDROP_FILTER);
  view.setUint8(offset + CMD_HEADER_FLAGS, 0);
  view.setUint16(offset + CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT, segments.length, true);
  writeFilterSegments(view, offset + CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS, segments);
  const ownShapeOffset = offset + cmdPushBackdropFilterOwnShapeOffset(segments.length);
  writeClipEntry(view, ownShapeOffset, { clipX: true, clipY: true, ...op.ownShape });
  return cmdPushBackdropFilterSize(segments.length);
}

export function writePopBackdropFilter(view, offset) {
  view.setUint8(offset, CMD_POP_BACKDROP_FILTER);
  view.setUint8(offset + CMD_HEADER_FLAGS, 0);
  view.setUint16(offset + CMD_HEADER_WORD, 0, true);
  return CMD_POP_BACKDROP_FILTER_SIZE;
}
