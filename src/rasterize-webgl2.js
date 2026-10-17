// WebGL 2 degraded raster backend (PLAN-webgl-2-degraded-backend.md).
//
// Interprets the same native numeric raster plan as the WebGPU backend and
// produces the same tightly packed straight-alpha RGBA pixels. Every shader
// below is a hand-maintained
// OpenGL ES Shading Language 3.00 port of the corresponding WGSL program
// in src/rasterize.js — the two families MUST stay in sync; each port
// keeps the original's structure so a diff against the WGSL source is
// mechanical.
//
// Systematic translation rules (decision record, 2026-08-11):
// - COORDINATES: WebGPU's framebuffer row 0 is the TOP; OpenGL's row 0 is
//   the BOTTOM. Every vertex shader here therefore emits
//   clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0 (the SIGN-FLIPPED
//   form of the WGSL original). With that one flip, texel row 0 of every
//   framebuffer texture holds the image's TOP row, texture v coordinates
//   equal pixelPos.y / resolution.y exactly as in the WGSL shaders, and
//   readPixels returns rows in top-to-bottom order with no CPU flip.
// - STORAGE BUFFERS: WebGL 2 has none (OpenGL ES 3.0 base). The gradient
//   record/stop arrays ride two RGBA32F textures read with texelFetch
//   (creation of float textures is core WebGL 2; only RENDERING to float
//   needs an extension, which this backend never does). Records use 3
//   texels each, stops 2 texels each, addressed linearly through a
//   fixed-width texture (see DATA_TEXTURE_WIDTH).
// - UNIFORM BUFFERS: replaced by plain uniforms (no std140 packing to
//   get wrong). The clip list is one vec4[MAX_SHADER_CLIP_ENTRIES * 5]
//   array — 40 vec4s, far inside the ES 3.0 minimum of 224 fragment
//   uniform vectors.
// - BLENDING: the fixed-function state (src-alpha / one-minus-src-alpha,
//   alpha one / one-minus-src-alpha) maps 1:1 onto blendFuncSeparate.
// - EXECUTION MODEL: GL executes immediately (no deferred command
//   encoder), so the WebGPU backend's pooled-buffer hazard does not
//   exist here; instance data is uploaded with bufferData per draw.

import { createNativeWebgl2Context } from "./native-webgl2-adapter.js";
import { hostNow } from "./host-clock.js";

import {
  BLEND_NORMAL,
  CMD_BOX_SHADOW,
  CMD_DAMAGE,
  CMD_IMAGE,
  CMD_POP_BACKDROP_FILTER,
  CMD_POP_BACKGROUND,
  CMD_POP_BLEND_LAYER,
  CMD_POP_CLIP,
  CMD_POP_MASK_LAYER,
  CMD_POP_OPACITY,
  CMD_PUSH_BACKDROP_FILTER,
  CMD_PUSH_BACKGROUND,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_CLIP,
  CMD_PUSH_MASK,
  CMD_PUSH_MASK_LAYER,
  CMD_PUSH_OPACITY,
  CMD_RECT,
  CMD_SET_NODE,
  CMD_SET_SCROLL,
  CMD_SVG_PATH,
  CMD_TEXT,
  RASTER_PLAN_PASS_BOX_BLUR_H,
  RASTER_PLAN_PASS_BOX_BLUR_V,
  RASTER_PLAN_PASS_DROP_SHADOW,
  RASTER_PLAN_PASS_MATRIX,
} from "./wasm/layout.js";
import {
  BOX_SHADOW_INSTANCE_FLOATS,
  clipUniformFloats,
  createRasterPlanCursor,
  EMPTY_CLIP_STATE,
  filterPassReaches,
  filterRegionPadding,
  MAX_SHADER_CLIP_ENTRIES,
  RECT_INSTANCE_FLOATS,
} from "./raster-plan.js";
import { STANDARD_WORKING_COLOR_ENCODING } from "./color.js";
import { createRasterRetention } from "./gpu-raster-binding.js";

// Fixed width (texels) of the two gradient data textures. 4096 records ×
// 3 texels = 12288 texels = 12 rows at this width; ES 3.0 guarantees a
// maximum texture size of at least 2048, so 1024 is portable.
const DATA_TEXTURE_WIDTH = 1024;

const MAX_INSTANCES = 4096;

// --------------------------------------------------------------------------
// Shared GLSL fragments (ports of CLIP_STRUCT_WGSL / CLIP_EVAL_WGSL and the
// per-shader SDF helpers).
// --------------------------------------------------------------------------

// Clip uniforms: 5 vec4 per entry — rect(minX,minY,maxX,maxY), radiiX,
// radiiY, invA(a,b,c,d), invB(e,f,mode,axisBits) — same packing
// clipUniformFloats produces.
const CLIP_UNIFORMS_GLSL = `
uniform vec2 resolution;
uniform float clipCount;
uniform vec4 clips[${MAX_SHADER_CLIP_ENTRIES * 5}];
`;

// Port of CLIP_EVAL_WGSL. Expects `vPixelPos` (vec2 varying) and the
// shader's own roundedRectSDF. Produces `clipCoverage` and discards
// fully-clipped fragments.
const CLIP_EVAL_GLSL = `
  float clipCoverage = 1.0;
  int clipEntryCount = int(clipCount);
  for (int clipIndex = 0; clipIndex < ${MAX_SHADER_CLIP_ENTRIES}; clipIndex++) {
    if (clipIndex >= clipEntryCount) { break; }
    vec4 clipRect = clips[clipIndex * 5 + 0];
    vec4 clipRadiiX = clips[clipIndex * 5 + 1];
    vec4 clipRadiiY = clips[clipIndex * 5 + 2];
    vec4 clipInvA = clips[clipIndex * 5 + 3];
    vec4 clipInvB = clips[clipIndex * 5 + 4];
    float clipMode = clipInvB.z;
    if (clipMode < 0.5) { continue; }
    if (clipMode < 1.5) {
      // Hard axis-aligned screen-space clip — binary, no AA.
      float clipAxisBits = clipInvB.w;
      if (clipAxisBits == 1.0 || clipAxisBits == 3.0) {
        if (vPixelPos.x < clipRect.x || vPixelPos.x > clipRect.z) { clipCoverage = 0.0; }
      }
      if (clipAxisBits == 2.0 || clipAxisBits == 3.0) {
        if (vPixelPos.y < clipRect.y || vPixelPos.y > clipRect.w) { clipCoverage = 0.0; }
      }
    } else if (clipMode < 2.5) {
      // SDF mode: rounded and/or oriented — evaluate in the entry's own
      // local space, antialias over ~1 screen pixel via fwidth.
      vec2 clipLocalP = vec2(
        clipInvA.x * vPixelPos.x + clipInvA.z * vPixelPos.y + clipInvB.x,
        clipInvA.y * vPixelPos.x + clipInvA.w * vPixelPos.y + clipInvB.y);
      vec2 clipCenter = (clipRect.xy + clipRect.zw) * 0.5;
      vec2 clipHalfSize = (clipRect.zw - clipRect.xy) * 0.5;
      float clipD = roundedRectSDF(clipLocalP - clipCenter, clipHalfSize, clipRadiiX, clipRadiiY);
      float clipAa = fwidth(clipD) * 0.5;
      clipCoverage = clipCoverage * (1.0 - smoothstep(-clipAa, clipAa, clipD));
    } else {
      // Area axis-aligned screen-space clip (an SVG viewport, a color
      // glyph's clip box): the fraction of the fragment's own pixel inside
      // the rect on each axis (CLIP_EVAL_WGSL's exact pixel square).
      float clipAxisBits = clipInvB.w;
      vec2 clipPixel = floor(gl_FragCoord.xy);
      vec2 clipInside = clamp(
        min(clipPixel + 1.0, clipRect.zw) - max(clipPixel, clipRect.xy),
        vec2(0.0), vec2(1.0));
      if (clipAxisBits == 1.0 || clipAxisBits == 3.0) { clipCoverage = clipCoverage * clipInside.x; }
      if (clipAxisBits == 2.0 || clipAxisBits == 3.0) { clipCoverage = clipCoverage * clipInside.y; }
    }
  }
  if (clipCoverage < 0.001) { discard; }
`;

// Same per-corner elliptical rounded-rect SDF as the WGSL shaders.
const SDF_HELPERS_GLSL = `
float cornerSelect(vec2 p, vec4 v) {
  return p.y > 0.0
    ? (p.x > 0.0 ? v.z : v.w)
    : (p.x > 0.0 ? v.y : v.x);
}

float roundedRectSDF(vec2 localP, vec2 halfSize, vec4 radiiX, vec4 radiiY) {
  float rx = cornerSelect(localP, radiiX);
  float ry = cornerSelect(localP, radiiY);
  vec2 q = abs(localP) - halfSize + vec2(rx, ry);
  float circD = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rx;
  float cornerD = (length(q / vec2(max(rx, 1e-6), max(ry, 1e-6))) - 1.0) * min(rx, ry);
  float edgeD = max(q.x - rx, q.y - ry);
  float ellipseD = (q.x > 0.0 && q.y > 0.0) ? cornerD : edgeD;
  return abs(rx - ry) < 1e-4 ? circD : ellipseD;
}
`;

const APPLY_TRANSFORM_GLSL = `
vec2 applyTransform(vec2 p, mat3x2 t) {
  return vec2(
    t[0][0] * p.x + t[1][0] * p.y + t[2][0],
    t[0][1] * p.x + t[1][1] * p.y + t[2][1]
  );
}
`;

// Gradient record/stop access — the storage-buffer replacement. Records:
// texel triplet (header: hasGradient, kind, stopStart, stopCount as
// floats; geom0..3; geom4..7). Stops: texel pair (color; position).
const GRADIENT_FETCH_GLSL = `
uniform highp sampler2D gradientRecordsTex;
uniform highp sampler2D gradientStopsTex;

vec4 fetchGradientTexel(highp sampler2D tex, int index) {
  return texelFetch(tex, ivec2(index % ${DATA_TEXTURE_WIDTH}, index / ${DATA_TEXTURE_WIDTH}), 0);
}

vec4 gradientStopColor(int stopIndex) {
  return fetchGradientTexel(gradientStopsTex, stopIndex * 2);
}

float gradientStopPosition(int stopIndex) {
  return fetchGradientTexel(gradientStopsTex, stopIndex * 2 + 1).x;
}
`;

// Ports of the WGSL gradient sampling functions (see RECT_SHADER's own
// derivation comments — kept structurally identical). The record fields
// arrive as locals; the stop walk fetches through the stop texture.
const GRADIENT_SAMPLING_GLSL = `
vec4 mixPremultiplied(vec4 a, vec4 b, float t) {
  vec4 premultA = vec4(a.rgb * a.a, a.a);
  vec4 premultB = vec4(b.rgb * b.a, b.a);
  vec4 premultMixed = mix(premultA, premultB, t);
  if (premultMixed.a < 1e-6) { return vec4(0.0); }
  return vec4(premultMixed.rgb / premultMixed.a, premultMixed.a);
}

float repeatWrapT(float t, int stopStart, int stopCount) {
  float firstPos = gradientStopPosition(stopStart);
  float lastPos = gradientStopPosition(stopStart + stopCount - 1);
  float span = max(lastPos - firstPos, 1e-6);
  float rel = (t - firstPos) / span;
  return firstPos + fract(rel) * span;
}

vec4 walkGradientStops(float rawT, int stopStart, int stopCount, bool isRepeating) {
  if (stopCount == 0) { return vec4(0.0); }
  if (stopCount == 1) { return gradientStopColor(stopStart); }
  float t = isRepeating ? repeatWrapT(rawT, stopStart, stopCount) : rawT;
  vec4 prevColor = gradientStopColor(stopStart);
  float prevPosition = gradientStopPosition(stopStart);
  int cap = min(stopCount, 64);
  for (int i = 1; i < 64; i++) {
    if (i >= cap) { break; }
    vec4 stopColor = gradientStopColor(stopStart + i);
    float stopPosition = gradientStopPosition(stopStart + i);
    if (t <= stopPosition) {
      float span = max(stopPosition - prevPosition, 1e-6);
      float localT = clamp((t - prevPosition) / span, 0.0, 1.0);
      return mixPremultiplied(prevColor, stopColor, localT);
    }
    prevColor = stopColor;
    prevPosition = stopPosition;
  }
  return prevColor;
}

vec4 sampleLinearGradient(vec2 posO, vec2 originSize, vec4 geomA, int stopStart, int stopCount, bool isRepeating) {
  float rawT = 0.5 + dot(posO - originSize * 0.5, vec2(geomA.x, geomA.y)) / max(geomA.z, 1e-6);
  float t = isRepeating ? rawT : clamp(rawT, 0.0, 1.0);
  return walkGradientStops(t, stopStart, stopCount, isRepeating);
}

vec4 sampleRadialGradient(vec2 posO, vec4 geomA, int stopStart, int stopCount, bool isRepeating) {
  vec2 centerRelPos = posO - vec2(geomA.x, geomA.y);
  float dx = centerRelPos.x / max(geomA.z, 1e-6);
  float dy = centerRelPos.y / max(geomA.w, 1e-6);
  float rawT = sqrt(dx * dx + dy * dy);
  float t = isRepeating ? rawT : clamp(rawT, 0.0, 1.0);
  return walkGradientStops(t, stopStart, stopCount, isRepeating);
}

vec4 sampleConicGradient(vec2 posO, vec4 geomA, int stopStart, int stopCount, bool isRepeating) {
  vec2 centerRelPos = posO - vec2(geomA.x, geomA.y);
  float pointAngle = atan(centerRelPos.y, centerRelPos.x) + 1.5707963267948966;
  float rawT = (pointAngle - geomA.z) / 6.283185307179586;
  float t = rawT - floor(rawT);
  return walkGradientStops(t, stopStart, stopCount, isRepeating);
}

// COLRv1 gradients, a port of svg-path.wgsl's sampleColrGradient (see its
// comments): geomA and geomB.xy are the affine to the canonical space,
// geomB.zw the kind's parameters.
float colrWrap(float rawT, int stopStart, int stopCount, uint extendBits) {
  if (extendBits == 0u || stopCount < 2) { return rawT; }
  float firstPos = gradientStopPosition(stopStart);
  float lastPos = gradientStopPosition(stopStart + stopCount - 1);
  float span = max(lastPos - firstPos, 1e-6);
  float rel = (rawT - firstPos) / span;
  if ((extendBits & 0x80u) != 0u) { return firstPos + fract(rel) * span; }
  return firstPos + (1.0 - abs(fract(rel * 0.5) * 2.0 - 1.0)) * span;
}

vec4 sampleColrGradient(vec2 posO, vec4 geomA, vec4 geomB, uint kind, uint extendBits, int stopStart, int stopCount) {
  vec2 u = vec2(
    geomA.x * posO.x + geomA.z * posO.y + geomB.x,
    geomA.y * posO.x + geomA.w * posO.y + geomB.y);
  float t = u.x;
  if (kind == 5u || kind == 6u) {
    float r0 = geomB.z;
    float dr = geomB.w - geomB.z;
    float cx = kind == 5u ? 1.0 : 0.0;
    float a = cx * cx - dr * dr;
    float b = u.x * cx + r0 * dr;
    float c = dot(u, u) - r0 * r0;
    if (abs(a) < 1e-9) {
      if (abs(b) < 1e-9) { return vec4(0.0); }
      t = c / (2.0 * b);
      if (r0 + t * dr < 0.0) { return vec4(0.0); }
    } else {
      float discriminant = b * b - a * c;
      if (discriminant < 0.0) { return vec4(0.0); }
      float root = sqrt(discriminant);
      float high = max((b + root) / a, (b - root) / a);
      float low = min((b + root) / a, (b - root) / a);
      if (r0 + high * dr >= 0.0) {
        t = high;
      } else if (r0 + low * dr >= 0.0) {
        t = low;
      } else {
        return vec4(0.0);
      }
    }
  } else if (kind == 7u) {
    float angle = atan(u.y, u.x);
    if (angle < 0.0) { angle = angle + 6.283185307179586; }
    float sweep = geomB.w - geomB.z;
    t = abs(sweep) < 1e-9 ? 0.0 : (angle - geomB.z) / sweep;
  }
  return walkGradientStops(colrWrap(t, stopStart, stopCount, extendBits), stopStart, stopCount, false);
}
`;

// Shared quad vertex positions — identical to the WebGPU backend's.
const QUAD_VERTICES = new Float32Array([
  0,
  0,
  1,
  0,
  0,
  1,
  0,
  1,
  1,
  0,
  1,
  1,
]);

// --------------------------------------------------------------------------
// Rect program (port of RECT_SHADER).
// --------------------------------------------------------------------------

const RECT_VERTEX_GLSL = `#version 300 es
precision highp float;
${CLIP_UNIFORMS_GLSL}
${APPLY_TRANSFORM_GLSL}
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 rectPos;
layout(location = 2) in vec2 rectSize;
layout(location = 3) in vec4 fillColor;
layout(location = 4) in vec4 borderColorTop;
layout(location = 5) in vec4 borderColorRight;
layout(location = 6) in vec4 borderColorBottom;
layout(location = 7) in vec4 borderColorLeft;
layout(location = 8) in vec4 borderWidths;
layout(location = 9) in vec4 radiiX;
layout(location = 10) in vec4 radiiY;
layout(location = 11) in vec2 transformCol0;
layout(location = 12) in vec2 transformCol1;
layout(location = 13) in vec2 transformCol2;
layout(location = 14) in vec2 paintModeAndBorderStyles;

out vec2 vLocalPos;
out vec2 vHalfSize;
out vec4 vFillColor;
out vec4 vBorderColorTop;
out vec4 vBorderColorRight;
out vec4 vBorderColorBottom;
out vec4 vBorderColorLeft;
out vec4 vBorderWidths;
out vec4 vRadiiX;
out vec4 vRadiiY;
out vec2 vPixelPos;
out float vPaintMode;
flat out int vInstanceIndex;
flat out float vIsAxisAligned;
flat out uint vBorderStyles;

void main() {
  vec2 expandedPos = rectPos - 1.5;
  vec2 expandedSize = rectSize + 3.0;
  vec2 localPixelPos = expandedPos + quadVertex * expandedSize;

  mat3x2 transform = mat3x2(transformCol0, transformCol1, transformCol2);
  vec2 pixelPos = applyTransform(localPixelPos, transform);
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;

  vec2 center = rectPos + rectSize * 0.5;

  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vLocalPos = localPixelPos - center;
  vHalfSize = rectSize * 0.5;
  vFillColor = fillColor;
  vBorderColorTop = borderColorTop;
  vBorderColorRight = borderColorRight;
  vBorderColorBottom = borderColorBottom;
  vBorderColorLeft = borderColorLeft;
  vBorderWidths = borderWidths;
  vRadiiX = radiiX;
  vRadiiY = radiiY;
  vPixelPos = pixelPos;
  vIsAxisAligned = (transformCol0.y == 0.0 && transformCol1.x == 0.0) ? 1.0 : 0.0;
  vPaintMode = paintModeAndBorderStyles.x;
  vBorderStyles = uint(paintModeAndBorderStyles.y);
  vInstanceIndex = gl_InstanceID;
}
`;

const RECT_FRAGMENT_GLSL = `#version 300 es
precision highp float;
precision highp int;
${CLIP_UNIFORMS_GLSL}
${GRADIENT_FETCH_GLSL}
in vec2 vLocalPos;
in vec2 vHalfSize;
in vec4 vFillColor;
in vec4 vBorderColorTop;
in vec4 vBorderColorRight;
in vec4 vBorderColorBottom;
in vec4 vBorderColorLeft;
in vec4 vBorderWidths;
in vec4 vRadiiX;
in vec4 vRadiiY;
in vec2 vPixelPos;
in float vPaintMode;
flat in int vInstanceIndex;
flat in float vIsAxisAligned;
flat in uint vBorderStyles;
out vec4 fragColor;

${SDF_HELPERS_GLSL}
${GRADIENT_SAMPLING_GLSL}

// The rounded-rect SDF of the border box inset PER SIDE (see WGSL
// insetRectSDF — css-backgrounds-3 §5.3 inner-contour construction).
float insetRectSDF(vec2 localPos, vec2 halfSize, vec4 radiiX, vec4 radiiY, vec4 insets) {
  vec2 centerOffset = vec2((insets.w - insets.y) * 0.5, (insets.x - insets.z) * 0.5);
  vec2 half_ = max(halfSize - vec2((insets.w + insets.y) * 0.5, (insets.x + insets.z) * 0.5), vec2(0.0));
  vec4 rX = max(radiiX - vec4(insets.w, insets.y, insets.y, insets.w), vec4(0.0));
  vec4 rY = max(radiiY - vec4(insets.x, insets.x, insets.z, insets.z), vec4(0.0));
  return roundedRectSDF(localPos - centerOffset, half_, rX, rY);
}

// Distance from v (both >= 0) to the ellipse of semi-axes e (see WGSL
// ellipseDistanceQ1: Eberly's bisection, fixed trip count).
float ellipseDistanceQ1(vec2 v, vec2 e) {
  bool swapAxes = e.x < e.y;
  vec2 y = swapAxes ? v.yx : v;
  vec2 a = swapAxes ? e.yx : e;
  if (a.x == a.y) { return abs(length(y) - a.x); }
  vec2 z = y / a;
  float r0 = (a.x / a.y) * (a.x / a.y);
  float n0 = r0 * z.x;
  float s0 = z.y - 1.0;
  float s1 = dot(z, z) < 1.0 ? 0.0 : length(vec2(n0, z.y)) - 1.0;
  for (int i = 0; i < 40; i++) {
    float s = 0.5 * (s0 + s1);
    vec2 ratio = vec2(n0 / (s + r0), z.y / (s + 1.0));
    bool above = dot(ratio, ratio) > 1.0;
    s0 = above ? s : s0;
    s1 = above ? s1 : s;
  }
  float s = 0.5 * (s0 + s1);
  float x0 = r0 * y.x / (s + r0);
  float x1 = s + 1.0 > 0.01 ? y.y / (s + 1.0) : a.y * sqrt(max(1.0 - (x0 / a.x) * (x0 / a.x), 0.0));
  return length(vec2(x0, x1) - y);
}

// The SVG stroke ring's outer (x) and inner (y) contour SDFs: offsets of
// the midline at half the width (see WGSL svgStrokeRingSDF).
const uint SVG_STROKE_BIT = 0x20000u;
vec2 svgStrokeRingSDF(vec2 localP, vec2 halfSize, vec4 radiiX, vec4 radiiY, float width) {
  float halfWidth = width * 0.5;
  vec2 h = max(halfSize - vec2(halfWidth), vec2(0.0));
  vec2 grown = max(vec2(cornerSelect(localP, radiiX), cornerSelect(localP, radiiY)) - vec2(halfWidth), vec2(0.0));
  vec2 r = (grown.x > 0.0 && grown.y > 0.0) ? grown : vec2(0.0);
  vec2 p = abs(localP);
  vec2 v = p - (h - r);
  float nearest = min(length(vec2(max(v.x, 0.0), p.y - h.y)), length(vec2(p.x - h.x, max(v.y, 0.0))));
  bool beyondArc = false;
  if (v.x > 0.0 && v.y > 0.0 && r.x > 0.0) {
    nearest = min(nearest, ellipseDistanceQ1(v, r));
    beyondArc = dot(v / r, v / r) > 1.0;
  }
  bool inside = p.x <= h.x && p.y <= h.y && !beyondArc;
  float s = inside ? -nearest : nearest;
  return vec2(s - halfWidth, s + halfWidth);
}

// Exact pixel-area coverage of the half-plane d < 0 (see WGSL
// halfPlaneCoverage): the box filter's trapezoid along the screen normal.
const uint AREA_COVERAGE_BIT = 0x10000u;
float halfPlaneCoverage(float d, vec2 grad) {
  float gradLength = length(grad);
  if (gradLength < 1e-6) { return d < 0.0 ? 1.0 : 0.0; }
  vec2 n = abs(grad) / gradLength;
  float wide = max(n.x, n.y);
  float narrow = min(n.x, n.y);
  float inside = -d / gradLength;
  float distance_ = abs(inside);
  float linearEnd = 0.5 * (wide - narrow);
  float support = 0.5 * (wide + narrow);
  float beyond = 0.0;
  if (distance_ < linearEnd) {
    beyond = 0.5 - distance_ / wide;
  } else if (distance_ < support) {
    float remaining = support - distance_;
    beyond = remaining * remaining / (2.0 * wide * narrow);
  }
  return inside > 0.0 ? 1.0 - beyond : beyond;
}

// border-style inset/outset/groove/ridge colors — Blink's exact rules
// (see the WGSL originals for the extraction notes).
vec3 borderColorDark(vec3 c) {
  float v = max(c.r, max(c.g, c.b));
  if (v == 0.0) { return vec3(0.0); }
  return c * max(0.0, (v - 0.33) / v);
}
vec3 borderColorLight(vec3 c) {
  float v = max(c.r, max(c.g, c.b));
  if (v == 0.0) { return vec3(84.0 / 255.0); }
  return c * (min(1.0, v + 0.33) / v);
}
float relativeLuminance(vec3 c) {
  vec3 linearized = mix(
    pow((c + vec3(0.055)) / 1.055, vec3(2.4)),
    c / 12.92,
    vec3(lessThanEqual(c, vec3(0.04045))));
  return dot(linearized, vec3(0.2126, 0.7152, 0.0722));
}
vec3 insetOutsetColor(bool isDarken, vec3 c) {
  float luminance = relativeLuminance(c);
  if (luminance <= 0.014443844) {
    vec3 light = borderColorLight(c);
    if (isDarken) { return light; }
    return borderColorLight(light);
  }
  if (isDarken) { return borderColorDark(c); }
  if (luminance > 0.83077) { return c; }
  return borderColorLight(c);
}
vec4 styledSideColor(vec4 base, uint style, uint side, float outerHalfness) {
  if (style == 4u || style == 5u) {  // BORDER_STYLE_INSET / _OUTSET
    bool isDarken = ((side == 0u || side == 3u) == (style == 4u));
    return vec4(insetOutsetColor(isDarken, base.rgb), base.a);
  }
  if (style == 6u || style == 7u) {  // BORDER_STYLE_GROOVE / _RIDGE
    bool outerActsInset = (style == 6u);
    bool darkenOuter = ((side == 0u || side == 3u) == outerActsInset);
    vec3 outerColor = insetOutsetColor(darkenOuter, base.rgb);
    vec3 innerColor = insetOutsetColor(!darkenOuter, base.rgb);
    return vec4(mix(innerColor, outerColor, outerHalfness), base.a);
  }
  return base;
}

// border-style dashed/dotted — Blink's dash sizing (see the WGSL original
// for the full derivation and measurement notes; ported line for line).
float dashDotInkCoverage(uint style, float w, float sideLength, float s, float across, float aa) {
  if (style == 3u && w > 3.0) {
    float alongRadius = w * 0.5 - 0.25;
    float acrossRadius = w * 0.5 - 0.25;
    if (sideLength < 2.0 * w) {
      float d = length(vec2((s - w * 0.5) * (acrossRadius / alongRadius), across)) - acrossRadius;
      return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
    }
    float minDots = floor((sideLength + w) / (2.0 * w));
    float maxDots = minDots + 1.0;
    float minGap = (sideLength - minDots * w) / (minDots - 1.0);
    float maxGap = (sideLength - maxDots * w) / (maxDots - 1.0);
    float gap = minGap;
    float dotCount = minDots;
    if (maxGap > 0.0 && abs(maxGap - w) < abs(minGap - w)) { gap = maxGap; dotCount = maxDots; }
    float period = gap + w;
    float dotIndex = clamp(round((s - w * 0.5) / period), 0.0, dotCount - 1.0);
    float center = w * 0.5 + dotIndex * period;
    float d = length(vec2((s - center) * (acrossRadius / alongRadius), across)) - acrossRadius;
    return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
  }
  float dashLength = w;
  float gapLength = w;
  if (style == 2u) {
    dashLength = w * (w >= 3.0 ? 2.0 : 3.0);
    gapLength = w * (w >= 3.0 ? 1.0 : 2.0);
  }
  if (sideLength <= 2.0 * dashLength) { return 1.0; }  // no room: solid
  float gap = gapLength;
  if (sideLength <= 2.0 * dashLength + gapLength) {
    float scale = sideLength / (2.0 * dashLength + gapLength);
    dashLength = dashLength * scale;
    gap = gapLength * scale;
  } else if (style == 2u) {
    float minDashes = floor((sideLength + gapLength) / (dashLength + gapLength));
    float maxDashes = minDashes + 1.0;
    float minGap = (sideLength - minDashes * dashLength) / (minDashes - 1.0);
    float maxGap = (sideLength - maxDashes * dashLength) / (maxDashes - 1.0);
    gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - gapLength) < abs(minGap - gapLength)) { gap = maxGap; }
  }
  float lineStart = 0.0;
  float lineEnd = 1e9;
  float startDotEnd = -1.0;
  float endDotStart = 1e9;
  if (style == 3u && sideLength > 2.0 * dashLength + gapLength) {
    float mod2 = sideLength - 2.0 * floor(sideLength / 2.0);
    float mod4 = sideLength - 4.0 * floor(sideLength / 4.0);
    float mod6 = sideLength - 6.0 * floor(sideLength / 6.0);
    bool useStartDot = false;
    float startDotGrowth = 0.0;
    float startLineOffset = 0.0;
    bool useEndDot = false;
    float endDotGrowth = 0.0;
    if ((w == 1.0 && mod2 == 0.0) || (w == 3.0 && mod6 == 0.0)) {
      useStartDot = true; startDotGrowth = 1.0; startLineOffset = 1.0;
    }
    if ((w == 2.0 && (mod4 == 0.0 || mod4 == 1.0)) || (w == 3.0 && (mod6 == 1.0 || mod6 == 2.0))) {
      useStartDot = true; startLineOffset = -1.0;
    }
    if ((w == 2.0 && mod4 == 0.0) || (w == 3.0 && mod6 == 1.0)) {
      useEndDot = true;
    }
    if ((w == 2.0 && mod4 == 3.0) || (w == 3.0 && (mod6 == 4.0 || mod6 == 5.0))) {
      useStartDot = true; startLineOffset = 1.0;
    }
    if (w == 3.0 && mod6 == 5.0) {
      useEndDot = true;
    } else if (w == 3.0 && mod6 == 0.0) {
      useEndDot = true; endDotGrowth = 1.0;
    }
    if (useStartDot) {
      startDotEnd = w + startDotGrowth;
      lineStart = 2.0 * w + startLineOffset;
    }
    if (useEndDot) {
      endDotStart = sideLength - w - endDotGrowth;
      lineEnd = sideLength - (w + endDotGrowth + 1.0);
    }
  }
  float period = dashLength + gap;
  float sInLine = s - lineStart;
  float coverage = 0.0;
  float periodIndex = floor(sInLine / period);
  for (int neighbor = -1; neighbor <= 1; neighbor++) {
    float base = (periodIndex + float(neighbor)) * period;
    float startQuantized = round(base * 4.0) / 4.0;
    float endQuantized = round((base + dashLength) * 4.0) / 4.0;
    float d = max(startQuantized - sInLine, sInLine - endQuantized);
    coverage = max(coverage, clamp(0.5 - d / (2.0 * aa), 0.0, 1.0));
  }
  if (s < lineStart || s >= lineEnd) { coverage = 0.0; }
  if (s < startDotEnd) { coverage = 1.0; }
  if (s >= endDotStart) { coverage = 1.0; }
  return coverage;
}

float quarterArcLength(float rx, float ry) {
  float total = 0.0;
  float step_ = 1.5707963 / 8.0;
  for (int sample_ = 0; sample_ < 8; sample_++) {
    float t = (float(sample_) + 0.5) * step_;
    total = total + sqrt(rx * rx * cos(t) * cos(t) + ry * ry * sin(t) * sin(t)) * step_;
  }
  return total;
}

float arcLengthTo(float rx, float ry, float tEnd) {
  float total = 0.0;
  float step_ = tEnd / 8.0;
  for (int sample_ = 0; sample_ < 8; sample_++) {
    float t = (float(sample_) + 0.5) * step_;
    total = total + sqrt(rx * rx * cos(t) * cos(t) + ry * ry * sin(t) * sin(t)) * step_;
  }
  return total;
}

vec2 closedCenterlinePosition(vec2 localPos, vec2 halfSize, vec4 widths,
                              vec4 radiiX, vec4 radiiY, uint sideFirst) {
  float mx0 = -halfSize.x + widths.w * 0.5;
  float mx1 = halfSize.x - widths.y * 0.5;
  float my0 = -halfSize.y + widths.x * 0.5;
  float my1 = halfSize.y - widths.z * 0.5;
  float rTLx = max(radiiX.x - widths.w * 0.5, 0.0); float rTLy = max(radiiY.x - widths.x * 0.5, 0.0);
  float rTRx = max(radiiX.y - widths.y * 0.5, 0.0); float rTRy = max(radiiY.y - widths.x * 0.5, 0.0);
  float rBRx = max(radiiX.z - widths.y * 0.5, 0.0); float rBRy = max(radiiY.z - widths.z * 0.5, 0.0);
  float rBLx = max(radiiX.w - widths.w * 0.5, 0.0); float rBLy = max(radiiY.w - widths.z * 0.5, 0.0);
  float arcTR = quarterArcLength(rTRx, rTRy);
  float arcBR = quarterArcLength(rBRx, rBRy);
  float arcBL = quarterArcLength(rBLx, rBLy);
  float arcTL = quarterArcLength(rTLx, rTLy);
  float topLength = (mx1 - rTRx) - (mx0 + rTLx);
  float rightLength = (my1 - rBRy) - (my0 + rTRy);
  float bottomLength = (mx1 - rBRx) - (mx0 + rBLx);
  float leftLength = (my1 - rTLy) - (my0 + rBLy);
  float pathLength = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + leftLength + arcTL;
  vec2 cTR = vec2(mx1 - rTRx, my0 + rTRy);
  vec2 cBR = vec2(mx1 - rBRx, my1 - rBRy);
  vec2 cBL = vec2(mx0 + rBLx, my1 - rBLy);
  vec2 cTL = vec2(mx0 + rTLx, my0 + rTLy);
  float s = 0.0;
  if (localPos.x >= cTR.x && localPos.y <= cTR.y && arcTR > 0.0) {
    float t = clamp(atan(max(localPos.x - cTR.x, 0.0) / max(rTRx, 1e-6),
                         max(cTR.y - localPos.y, 0.0) / max(rTRy, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcLengthTo(rTRx, rTRy, t);
  } else if (localPos.x >= cBR.x && localPos.y >= cBR.y && arcBR > 0.0) {
    float t = clamp(atan(max(localPos.y - cBR.y, 0.0) / max(rBRy, 1e-6),
                         max(localPos.x - cBR.x, 0.0) / max(rBRx, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcLengthTo(rBRx, rBRy, t);
  } else if (localPos.x <= cBL.x && localPos.y >= cBL.y && arcBL > 0.0) {
    float t = clamp(atan(max(cBL.x - localPos.x, 0.0) / max(rBLx, 1e-6),
                         max(localPos.y - cBL.y, 0.0) / max(rBLy, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcLengthTo(rBLx, rBLy, t);
  } else if (localPos.x <= cTL.x && localPos.y <= cTL.y && arcTL > 0.0) {
    float t = clamp(atan(max(cTL.y - localPos.y, 0.0) / max(rTLy, 1e-6),
                         max(cTL.x - localPos.x, 0.0) / max(rTLx, 1e-6)), 0.0, 1.5707963);
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + leftLength + arcLengthTo(rTLx, rTLy, t);
  } else if (sideFirst == 0u) {
    s = clamp(localPos.x - (mx0 + rTLx), 0.0, topLength);
  } else if (sideFirst == 1u) {
    s = topLength + arcTR + clamp(localPos.y - (my0 + rTRy), 0.0, rightLength);
  } else if (sideFirst == 2u) {
    s = topLength + arcTR + rightLength + arcBR + clamp((mx1 - rBRx) - localPos.x, 0.0, bottomLength);
  } else {
    s = topLength + arcTR + rightLength + arcBR + bottomLength + arcBL + clamp((my1 - rBLy) - localPos.y, 0.0, leftLength);
  }
  return vec2(s, pathLength);
}

float closedDashDotCoverage(uint style, float w, float pathLengthExact, float s, float across, float aa) {
  float pathLength = floor(pathLengthExact);
  if (style == 3u && w > 3.0) {
    float minDots = floor(pathLength / (2.0 * w));
    if (minDots < 1.0) { return 1.0; }
    float maxDots = minDots + 1.0;
    float minGap = (pathLength - minDots * w) / minDots;
    float maxGap = (pathLength - maxDots * w) / maxDots;
    float gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - w) < abs(minGap - w)) { gap = maxGap; }
    float period = gap + w;
    float center = round(s / period) * period;
    float alongRadius = w * 0.5 - 0.25;
    float d = length(vec2(s - center, across)) - alongRadius;
    return clamp(0.5 - d / (2.0 * aa), 0.0, 1.0);
  }
  float dashLength = w;
  float gapLength = w;
  if (style == 2u) {
    dashLength = w * (w >= 3.0 ? 2.0 : 3.0);
    gapLength = w * (w >= 3.0 ? 1.0 : 2.0);
  }
  if (pathLength <= 2.0 * dashLength) { return 1.0; }
  float gap = gapLength;
  if (pathLength <= 2.0 * dashLength + 2.0 * gapLength) {
    float scale = pathLength / (2.0 * dashLength + 2.0 * gapLength);
    dashLength = dashLength * scale;
    gap = gapLength * scale;
  } else if (style == 2u) {
    float minDashes = floor(pathLength / (dashLength + gapLength));
    float maxDashes = minDashes + 1.0;
    float minGap = (pathLength - minDashes * dashLength) / minDashes;
    float maxGap = (pathLength - maxDashes * dashLength) / maxDashes;
    gap = minGap;
    if (maxGap > 0.0 && abs(maxGap - gapLength) < abs(minGap - gapLength)) { gap = maxGap; }
  }
  float period = dashLength + gap;
  float periodIndex = floor(s / period);
  float coverage = 0.0;
  for (int neighbor = -1; neighbor <= 1; neighbor++) {
    float base = (periodIndex + float(neighbor)) * period;
    float d = max(base - s, s - (base + dashLength));
    coverage = max(coverage, clamp(0.5 - d / (2.0 * aa), 0.0, 1.0));
  }
  return coverage;
}

float sidePatternCoverage(uint side, uint style, float tSide,
                          vec2 localPos, vec2 halfSize, vec4 widths,
                          float aaX, float aaY) {
  float sideLength = 2.0 * halfSize.x;
  float s = localPos.x + halfSize.x;
  float aa = aaX;
  if (side == 1u || side == 3u) {
    sideLength = 2.0 * halfSize.y;
    s = localPos.y + halfSize.y;
    aa = aaY;
  }
  float w = widths[side];
  float across = tSide * w - w * 0.5;
  return dashDotInkCoverage(style, w, sideLength, s, across, aa);
}

void main() {
  // Derivatives FIRST, unconditionally — same uniform-control-flow rule
  // the WGSL original documents (GLSL derivatives after a non-uniform
  // discard are equally undefined).
  bool isSvgStroke = (vBorderStyles & SVG_STROKE_BIT) != 0u;
  vec2 svgRing = vec2(0.0);
  if (isSvgStroke) {
    svgRing = svgStrokeRingSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY, vBorderWidths.x);
  }
  float d = isSvgStroke ? svgRing.x : roundedRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY);
  float aa = fwidth(d) * 0.5;
  vec2 localPerScreen = abs(vec2(dFdx(vLocalPos.x), dFdy(vLocalPos.y)));
  vec2 screenPerLocal = 1.0 / max(localPerScreen, vec2(1e-6));

  vec4 widths = vBorderWidths;  // x=top, y=right, z=bottom, w=left
  float dInner = isSvgStroke ? svgRing.y : insetRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY, widths);
  float aaInner = fwidth(dInner) * 0.5;
  vec2 dGrad = vec2(dFdx(d), dFdy(d));
  vec2 dInnerGrad = vec2(dFdx(dInner), dFdy(dInner));

  vec4 doubleThirds = floor((widths + vec4(1.0)) / 3.0);
  float dStripeOuter = insetRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY, doubleThirds);
  float aaStripeOuter = fwidth(dStripeOuter) * 0.5;
  float dStripeInner = insetRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY, widths - doubleThirds);
  float aaStripeInner = fwidth(dStripeInner) * 0.5;

  float dHalfBand = insetRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY, widths * 0.5);
  float outerHalfness = smoothstep(-fwidth(dHalfBand) * 0.5, fwidth(dHalfBand) * 0.5, dHalfBand);

  float dashAaX = fwidth(vLocalPos.x) * 0.5;
  float dashAaY = fwidth(vLocalPos.y) * 0.5;

  float tTop = widths.x > 0.0 ? (vLocalPos.y + vHalfSize.y) / widths.x : 1e9;
  float tRight = widths.y > 0.0 ? (vHalfSize.x - vLocalPos.x) / widths.y : 1e9;
  float tBottom = widths.z > 0.0 ? (vHalfSize.y - vLocalPos.y) / widths.z : 1e9;
  float tLeft = widths.w > 0.0 ? (vLocalPos.x + vHalfSize.x) / widths.w : 1e9;
  float tFirst = tTop;
  vec4 colorFirst = vBorderColorTop;
  uint sideFirst = 0u;
  float tSecond = 1e9;
  vec4 colorSecond = vBorderColorTop;
  uint sideSecond = 0u;
  if (tRight < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tRight; colorFirst = vBorderColorRight; sideFirst = 1u; }
  else if (tRight < tSecond) { tSecond = tRight; colorSecond = vBorderColorRight; sideSecond = 1u; }
  if (tBottom < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tBottom; colorFirst = vBorderColorBottom; sideFirst = 2u; }
  else if (tBottom < tSecond) { tSecond = tBottom; colorSecond = vBorderColorBottom; sideSecond = 2u; }
  if (tLeft < tFirst) { tSecond = tFirst; colorSecond = colorFirst; sideSecond = sideFirst; tFirst = tLeft; colorFirst = vBorderColorLeft; sideFirst = 3u; }
  else if (tLeft < tSecond) { tSecond = tLeft; colorSecond = vBorderColorLeft; sideSecond = 3u; }
  colorFirst = styledSideColor(colorFirst,
    (vBorderStyles >> (4u * sideFirst)) & 0xFu, sideFirst, outerHalfness);
  colorSecond = styledSideColor(colorSecond,
    (vBorderStyles >> (4u * sideSecond)) & 0xFu, sideSecond, outerHalfness);
  float seamDistance = tSecond - tFirst;
  float seamAa = max(fwidth(seamDistance) * 0.5, 1e-6);
  float seamBlend = clamp(seamDistance / (2.0 * seamAa) + 0.5, 0.5, 1.0);
  vec4 borderColor = mix(colorSecond, colorFirst, seamBlend);

${CLIP_EVAL_GLSL}

  bool isFillOnly = vPaintMode > 0.5 && vPaintMode < 1.5;
  bool isBorderOnly = vPaintMode > 1.5;

  // Gradient (P4): record header texel — hasGradient flags, kind,
  // stopStart, stopCount, all small ints stored as exact floats.
  vec4 gradHeader = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3);
  uint gradFlags = uint(gradHeader.x);
  uint gradKindBits = uint(gradHeader.y);
  int gradStopStart = int(gradHeader.z);
  int gradStopCount = int(gradHeader.w);
  uint gradKind = gradKindBits & 0x7Fu;
  bool gradIsRepeating = (gradKindBits & 0x80u) != 0u;
  vec4 resolvedFillColor = vFillColor;
  if (gradFlags != 0u) {
    vec4 geomA = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3 + 1);
    vec4 geomB = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3 + 2);
    vec2 gradOriginSize = max(vec2(geomB.z, geomB.w), vec2(1e-6));
    vec2 gradPosO = vLocalPos + vHalfSize - vec2(geomB.x, geomB.y);
    if ((gradFlags & 2u) != 0u) {
      gradPosO = gradPosO - floor(gradPosO / gradOriginSize) * gradOriginSize;
    }
    if (gradKind == 1u) {
      resolvedFillColor = sampleLinearGradient(gradPosO, gradOriginSize, geomA, gradStopStart, gradStopCount, gradIsRepeating);
    } else if (gradKind == 2u) {
      resolvedFillColor = sampleRadialGradient(gradPosO, geomA, gradStopStart, gradStopCount, gradIsRepeating);
    } else if (gradKind == 3u) {
      resolvedFillColor = sampleConicGradient(gradPosO, geomA, gradStopStart, gradStopCount, gradIsRepeating);
    }
  }

  if (!isBorderOnly && vIsAxisAligned > 0.5 && vRadiiX == vec4(0.0) && vRadiiY == vec4(0.0) && widths == vec4(0.0)) {
    vec2 halfPixel = localPerScreen * 0.5;
    vec2 overlap = max(
      min(vLocalPos + halfPixel, vHalfSize) - max(vLocalPos - halfPixel, -vHalfSize),
      vec2(0.0));
    vec2 axisCoverage = clamp(overlap * screenPerLocal, vec2(0.0), vec2(1.0));
    float coverage = axisCoverage.x * axisCoverage.y;
    if (resolvedFillColor.a * clipCoverage * coverage < 0.001) { discard; }
    fragColor = vec4(resolvedFillColor.rgb, resolvedFillColor.a * clipCoverage * coverage);
    return;
  }

  // SVG geometry (bit 16 of the styles word) takes exact area coverage;
  // CSS boxes keep the smoothstep ramp (see the WGSL original).
  bool areaCoverage = (vBorderStyles & AREA_COVERAGE_BIT) != 0u;
  float outerAlpha = areaCoverage ? halfPlaneCoverage(d, dGrad) : 1.0 - smoothstep(-aa, aa, d);
  float innerAlpha = isFillOnly ? outerAlpha
    : areaCoverage ? halfPlaneCoverage(dInner, dInnerGrad) : 1.0 - smoothstep(-aaInner, aaInner, dInner);
  float ringCoverage = max(outerAlpha - innerAlpha, 0.0);

  float stripeOuterAlpha = 1.0 - smoothstep(-aaStripeOuter, aaStripeOuter, dStripeOuter);
  float stripeInnerAlpha = 1.0 - smoothstep(-aaStripeInner, aaStripeInner, dStripeInner);
  float doubleInk = max(outerAlpha - stripeOuterAlpha, 0.0) + max(stripeInnerAlpha - innerAlpha, 0.0);

  uint sideStyle = (vBorderStyles >> (4u * sideFirst)) & 0xFu;
  uint styleOfSecond = (vBorderStyles >> (4u * sideSecond)) & 0xFu;
  bool boxIsRounded = any(greaterThan(vRadiiX, vec4(0.0))) || any(greaterThan(vRadiiY, vec4(0.0)));
  vec2 pathPosition = vec2(0.0, 0.0);
  if (boxIsRounded && (sideStyle == 2u || sideStyle == 3u || styleOfSecond == 2u || styleOfSecond == 3u)) {
    pathPosition = closedCenterlinePosition(
      vLocalPos, vHalfSize, widths, vRadiiX, vRadiiY, sideFirst);
  }
  float closedAa = max(dashAaX, dashAaY);
  float inkFirst = ringCoverage;
  if (sideStyle == 1u) { inkFirst = doubleInk; }
  else if (sideStyle == 2u || sideStyle == 3u) {
    if (boxIsRounded) {
      inkFirst = ringCoverage * closedDashDotCoverage(
        sideStyle, widths[sideFirst], pathPosition.y, pathPosition.x, abs(dHalfBand), closedAa);
    } else {
      inkFirst = ringCoverage * sidePatternCoverage(
        sideFirst, sideStyle, tFirst,
        vLocalPos, vHalfSize, widths, dashAaX, dashAaY);
    }
  }
  float inkSecond = ringCoverage;
  if (styleOfSecond == 1u) { inkSecond = doubleInk; }
  else if (styleOfSecond == 2u || styleOfSecond == 3u) {
    if (boxIsRounded) {
      inkSecond = ringCoverage * closedDashDotCoverage(
        styleOfSecond, widths[sideSecond], pathPosition.y, pathPosition.x, abs(dHalfBand), closedAa);
    } else {
      inkSecond = ringCoverage * sidePatternCoverage(
        sideSecond, styleOfSecond, tSecond,
        vLocalPos, vHalfSize, widths, dashAaX, dashAaY);
    }
  }
  float borderInkCoverage = mix(inkSecond, inkFirst, seamBlend);
  if ((sideStyle == 2u || sideStyle == 3u) && styleOfSecond == sideStyle
      && tSecond <= 1.0 && colorSecond == colorFirst && !boxIsRounded) {
    borderInkCoverage = max(inkFirst, inkSecond);
  }
  float gapCoverage = max(ringCoverage - borderInkCoverage, 0.0);

  float backgroundA = isBorderOnly ? 0.0 : resolvedFillColor.a;
  float borderA = borderColor.a;
  float ringA = borderA + backgroundA * (1.0 - borderA);
  vec3 ringRGBWeighted = borderColor.rgb * borderA + resolvedFillColor.rgb * backgroundA * (1.0 - borderA);

  float unclippedAlpha = (innerAlpha + gapCoverage) * backgroundA + borderInkCoverage * ringA;
  float totalAlpha = unclippedAlpha * clipCoverage;
  if (totalAlpha < 0.001) { discard; }

  vec3 colorWeighted = resolvedFillColor.rgb * (innerAlpha + gapCoverage) * backgroundA + ringRGBWeighted * borderInkCoverage;
  vec3 color = colorWeighted / unclippedAlpha;

  fragColor = vec4(color, totalAlpha);
}
`;

// --------------------------------------------------------------------------
// Composite program (port of COMPOSITE_SHADER) — opacity groups, blend
// modes, color-matrix filters, clip-path masks, mask layers, and the
// matrix-overwrite pass (same program, blend disabled at draw time).
// --------------------------------------------------------------------------

const COMPOSITE_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 rectPos;
layout(location = 2) in vec2 rectSize;
out vec2 vUv;
out vec2 vPixelPos;
void main() {
  vec2 pixelPos = rectPos + quadVertex * rectSize;
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;
  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vUv = pixelPos / resolution;
  vPixelPos = pixelPos;
}
`;

const COMPOSITE_FRAGMENT_GLSL = `#version 300 es
precision highp float;
precision highp int;
${CLIP_UNIFORMS_GLSL}
uniform float opacity;
uniform float blendMode;
uniform float hasMatrix;
uniform float outputPremultiplied;
// A Porter-Duff operator (layout.js COMPOSITE_*); 0 is source-over with
// the blend mode. Drawn with blending disabled over the backdrop copy.
uniform float porterDuff;
uniform vec4 matrixR;
uniform vec4 matrixG;
uniform vec4 matrixB;
uniform vec4 matrixA;
uniform vec4 matrixConst;
uniform vec4 pathMaskInfo;
uniform vec4 pathMaskRect;
uniform vec4 pathMaskBbox;
uniform vec4 pathMaskUv;
// The mask's linear map from screen pixels to its local space, and in xy
// its translation: local = invA (pixel - translation).
uniform vec4 pathMaskInvA;
uniform vec4 pathMaskTranslation;
uniform vec4 maskInfo;
uniform sampler2D srcTex;
uniform sampler2D backdropTex;
uniform sampler2D pathMaskTex;
uniform sampler2D maskTex;
in vec2 vUv;
in vec2 vPixelPos;
out vec4 fragColor;

${SDF_HELPERS_GLSL}

const float BLEND_MULTIPLY = 1.0;
const float BLEND_SCREEN = 2.0;
const float BLEND_OVERLAY = 3.0;
const float BLEND_DARKEN = 4.0;
const float BLEND_LIGHTEN = 5.0;
const float BLEND_COLOR_DODGE = 6.0;
const float BLEND_COLOR_BURN = 7.0;
const float BLEND_HARD_LIGHT = 8.0;
const float BLEND_SOFT_LIGHT = 9.0;
const float BLEND_DIFFERENCE = 10.0;
const float BLEND_EXCLUSION = 11.0;
const float BLEND_HUE = 12.0;
const float BLEND_SATURATION = 13.0;
const float BLEND_COLOR = 14.0;
const float BLEND_LUMINOSITY = 15.0;

float blendMultiplyChannel(float cb, float cs) { return cb * cs; }
float blendScreenChannel(float cb, float cs) { return cb + cs - cb * cs; }
float blendDarkenChannel(float cb, float cs) { return min(cb, cs); }
float blendLightenChannel(float cb, float cs) { return max(cb, cs); }
float blendHardLightChannel(float cb, float cs) {
  if (cs <= 0.5) { return blendMultiplyChannel(cb, 2.0 * cs); }
  return blendScreenChannel(cb, 2.0 * cs - 1.0);
}
float blendOverlayChannel(float cb, float cs) { return blendHardLightChannel(cs, cb); }
float blendColorDodgeChannel(float cb, float cs) {
  if (cb <= 0.0) { return 0.0; }
  if (cs >= 1.0) { return 1.0; }
  return min(1.0, cb / (1.0 - cs));
}
float blendColorBurnChannel(float cb, float cs) {
  if (cb >= 1.0) { return 1.0; }
  if (cs <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - cb) / cs);
}
float blendSoftLightChannel(float cb, float cs) {
  if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
  float d;
  if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
  else { d = sqrt(cb); }
  return cb + (2.0 * cs - 1.0) * (d - cb);
}
float blendDifferenceChannel(float cb, float cs) { return abs(cb - cs); }
float blendExclusionChannel(float cb, float cs) { return cb + cs - 2.0 * cb * cs; }

vec3 blendSeparable(float mode, vec3 cb, vec3 cs) {
  if (mode == BLEND_MULTIPLY) {
    return vec3(blendMultiplyChannel(cb.r, cs.r), blendMultiplyChannel(cb.g, cs.g), blendMultiplyChannel(cb.b, cs.b));
  }
  if (mode == BLEND_SCREEN) {
    return vec3(blendScreenChannel(cb.r, cs.r), blendScreenChannel(cb.g, cs.g), blendScreenChannel(cb.b, cs.b));
  }
  if (mode == BLEND_OVERLAY) {
    return vec3(blendOverlayChannel(cb.r, cs.r), blendOverlayChannel(cb.g, cs.g), blendOverlayChannel(cb.b, cs.b));
  }
  if (mode == BLEND_DARKEN) {
    return vec3(blendDarkenChannel(cb.r, cs.r), blendDarkenChannel(cb.g, cs.g), blendDarkenChannel(cb.b, cs.b));
  }
  if (mode == BLEND_LIGHTEN) {
    return vec3(blendLightenChannel(cb.r, cs.r), blendLightenChannel(cb.g, cs.g), blendLightenChannel(cb.b, cs.b));
  }
  if (mode == BLEND_COLOR_DODGE) {
    return vec3(blendColorDodgeChannel(cb.r, cs.r), blendColorDodgeChannel(cb.g, cs.g), blendColorDodgeChannel(cb.b, cs.b));
  }
  if (mode == BLEND_COLOR_BURN) {
    return vec3(blendColorBurnChannel(cb.r, cs.r), blendColorBurnChannel(cb.g, cs.g), blendColorBurnChannel(cb.b, cs.b));
  }
  if (mode == BLEND_HARD_LIGHT) {
    return vec3(blendHardLightChannel(cb.r, cs.r), blendHardLightChannel(cb.g, cs.g), blendHardLightChannel(cb.b, cs.b));
  }
  if (mode == BLEND_SOFT_LIGHT) {
    return vec3(blendSoftLightChannel(cb.r, cs.r), blendSoftLightChannel(cb.g, cs.g), blendSoftLightChannel(cb.b, cs.b));
  }
  if (mode == BLEND_DIFFERENCE) {
    return vec3(blendDifferenceChannel(cb.r, cs.r), blendDifferenceChannel(cb.g, cs.g), blendDifferenceChannel(cb.b, cs.b));
  }
  // BLEND_EXCLUSION
  return vec3(blendExclusionChannel(cb.r, cs.r), blendExclusionChannel(cb.g, cs.g), blendExclusionChannel(cb.b, cs.b));
}

float lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  vec3 result = c;
  if (n < 0.0) {
    result = l + (result - l) * (l / (l - n));
  }
  if (x > 1.0) {
    result = l + (result - l) * ((1.0 - l) / (x - l));
  }
  return result;
}

vec3 setLum(vec3 c, float l) {
  float d = l - lum(c);
  return clipColor(c + vec3(d, d, d));
}

float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 setSat(vec3 c, float s) {
  float cmin = min(c.r, min(c.g, c.b));
  float cmax = max(c.r, max(c.g, c.b));
  if (cmax <= cmin) { return vec3(0.0, 0.0, 0.0); }
  float cmid = c.r + c.g + c.b - cmin - cmax;
  float newMid = (cmid - cmin) * s / (cmax - cmin);
  if (c.r == cmax) {
    if (c.g == cmin) { return vec3(s, 0.0, newMid); }
    return vec3(s, newMid, 0.0);
  }
  if (c.g == cmax) {
    if (c.r == cmin) { return vec3(0.0, s, newMid); }
    return vec3(newMid, s, 0.0);
  }
  // c.b == cmax
  if (c.r == cmin) { return vec3(0.0, newMid, s); }
  return vec3(newMid, 0.0, s);
}

vec3 blendNonSeparable(float mode, vec3 cb, vec3 cs) {
  if (mode == BLEND_HUE) { return setLum(setSat(cs, sat(cb)), lum(cb)); }
  if (mode == BLEND_SATURATION) { return setLum(setSat(cb, sat(cs)), lum(cb)); }
  if (mode == BLEND_COLOR) { return setLum(cs, lum(cb)); }
  // BLEND_LUMINOSITY
  return setLum(cb, lum(cs));
}

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

// COMPOSITE_SHADER's targetTexel (see its comments): a target-sized
// texture is read at the fragment's own texel.
vec4 targetTexel(sampler2D source) {
  if (vec2(textureSize(source, 0)) == resolution) {
    return texelFetch(source, ivec2(gl_FragCoord.xy), 0);
  }
  return textureLod(source, vUv, 0.0);
}

// COMPOSITE_SHADER's pathMaskTexel (see its comments): the mask path's
// bitmap read bilinearly by hand at a position in its own texels.
vec4 pathMaskTexel(ivec2 origin, ivec2 size, vec2 texelPos) {
  vec2 corner = texelPos - 0.5;
  vec2 base = floor(corner);
  vec2 weight = corner - base;
  ivec2 low = clamp(ivec2(base), ivec2(0), size - 1) + origin;
  ivec2 high = clamp(ivec2(base) + 1, ivec2(0), size - 1) + origin;
  vec4 top = mix(
    texelFetch(pathMaskTex, low, 0),
    texelFetch(pathMaskTex, ivec2(high.x, low.y), 0),
    weight.x);
  vec4 bottom = mix(
    texelFetch(pathMaskTex, ivec2(low.x, high.y), 0),
    texelFetch(pathMaskTex, high, 0),
    weight.x);
  return mix(top, bottom, weight.y);
}

const int BOX_GRID = 4;
vec2 boxCentre(int i) {
  return (vec2(float(i % BOX_GRID), float(i / BOX_GRID)) + 0.5) / float(BOX_GRID) - 0.5;
}

// Porter-Duff factors (Fa, Fb): result = Fa * source + Fb * destination
// (composite.wgsl porterDuffFactors).
vec2 porterDuffFactors(float op, float sa, float da) {
  if (op < 1.5) { return vec2(0.0, 0.0); }
  if (op < 2.5) { return vec2(1.0, 0.0); }
  if (op < 3.5) { return vec2(0.0, 1.0); }
  if (op < 4.5) { return vec2(1.0 - da, 1.0); }
  if (op < 5.5) { return vec2(da, 0.0); }
  if (op < 6.5) { return vec2(0.0, sa); }
  if (op < 7.5) { return vec2(1.0 - da, 0.0); }
  if (op < 8.5) { return vec2(0.0, 1.0 - sa); }
  if (op < 9.5) { return vec2(da, 1.0 - sa); }
  if (op < 10.5) { return vec2(1.0 - da, sa); }
  if (op < 11.5) { return vec2(1.0 - da, 1.0 - sa); }
  return vec2(1.0, 1.0);
}

void main() {
${CLIP_EVAL_GLSL}

  bool isPorterDuff = porterDuff > 0.5;
  vec4 src = targetTexel(srcTex);
  if (src.a < 0.001 && !isPorterDuff) { discard; }
  src.rgb = max(src.rgb, vec3(0.0)) / max(src.a, 1e-6);
  if (pathMaskInfo.x > 0.5) {
    // COMPOSITE_SHADER's path mask (see its comments).
    vec2 fromTranslation = gl_FragCoord.xy - pathMaskTranslation.xy;
    vec2 localPos = vec2(
      pathMaskInvA.x * fromTranslation.x + pathMaskInvA.z * fromTranslation.y,
      pathMaskInvA.y * fromTranslation.x + pathMaskInvA.w * fromTranslation.y);
    vec2 pathPos = (localPos - pathMaskRect.xy) / pathMaskInfo.y;
    vec2 bboxSize = pathMaskBbox.zw - pathMaskBbox.xy;
    vec2 normalized = (pathPos - pathMaskBbox.xy) / bboxSize;
    bool insidePathBounds = all(greaterThanEqual(normalized, vec2(0.0))) && all(lessThanEqual(normalized, vec2(1.0)));
    ivec2 bitmapOrigin = ivec2(round(pathMaskUv.xy * vec2(textureSize(pathMaskTex, 0))));
    vec2 bitmapSize = pathMaskUv.zw;
    ivec2 bitmapTexels = ivec2(bitmapSize);
    float padding = pathMaskInfo.w;
    vec2 insetSize = bitmapSize - 2.0 * padding;
    vec2 texelPos = padding + clamp(normalized, vec2(0.0), vec2(1.0)) * insetSize;
    float sampledCoverage = 0.0;
    if (pathMaskInfo.z == 0.0) {
      sampledCoverage = pathMaskTexel(bitmapOrigin, bitmapTexels, texelPos).r;
    } else {
      vec2 texelPerLocal = insetSize / (bboxSize * pathMaskInfo.y);
      vec2 texeldx = pathMaskInvA.xy * texelPerLocal;
      vec2 texeldy = pathMaskInvA.zw * texelPerLocal;
      float coverage = 0.0;
      for (int i = 0; i < BOX_GRID * BOX_GRID; i++) {
        vec2 o = boxCentre(i);
        vec2 boxPos = clamp(texelPos + texeldx * o.x + texeldy * o.y, vec2(padding), bitmapSize - padding);
        vec4 m = pathMaskTexel(bitmapOrigin, bitmapTexels, boxPos);
        float distance = (median(m.r, m.g, m.b) - 0.5) * pathMaskInfo.z;
        coverage += clamp(distance * float(BOX_GRID) + 0.5, 0.0, 1.0);
      }
      sampledCoverage = coverage / float(BOX_GRID * BOX_GRID);
    }
    float pathCoverage = insidePathBounds ? sampledCoverage : 0.0;
    src.a = src.a * pathCoverage;
    if (src.a < 0.001 && !isPorterDuff) { discard; }
  }
  if (maskInfo.x > 0.5) {
    src.a = src.a * targetTexel(maskTex).a;
    if (src.a < 0.001 && !isPorterDuff) { discard; }
  }

  if (hasMatrix > 0.5) {
    vec4 rgba = vec4(src.r, src.g, src.b, src.a);
    vec4 filtered = vec4(
      dot(matrixR, rgba) + matrixConst.r,
      dot(matrixG, rgba) + matrixConst.g,
      dot(matrixB, rgba) + matrixConst.b,
      dot(matrixA, rgba) + matrixConst.a);
    src = vec4(clamp(filtered.rgb, vec3(0.0), vec3(1.0)), clamp(filtered.a, 0.0, 1.0));
  }

  vec4 color = src;
  if (blendMode != ${BLEND_NORMAL}.0) {
    vec4 backdrop = targetTexel(backdropTex);
    vec3 backdropColor = backdrop.a > 0.0
      ? max(backdrop.rgb, vec3(0.0)) / max(backdrop.a, 1e-6)
      : vec3(0.0);
    vec3 blended;
    if (blendMode <= BLEND_EXCLUSION) {
      blended = blendSeparable(blendMode, backdropColor, src.rgb);
    } else {
      blended = blendNonSeparable(blendMode, backdropColor, src.rgb);
    }
    blended = max(blended, vec3(0.0));
    vec3 mixed = mix(src.rgb, blended, backdrop.a);
    color = vec4(mixed, src.a);
  }
  if (isPorterDuff) {
    vec4 destination = targetTexel(backdropTex);
    float alpha = color.a * opacity;
    vec2 factors = porterDuffFactors(porterDuff, alpha, destination.a);
    vec4 composed = min(vec4(color.rgb * alpha, alpha) * factors.x + destination * factors.y, vec4(1.0));
    fragColor = mix(destination, composed, clipCoverage);
    return;
  }
  float alpha = color.a * opacity * clipCoverage;
  if (outputPremultiplied > 0.5) {
    fragColor = vec4(color.rgb * alpha, alpha);
    return;
  }
  fragColor = vec4(color.rgb, alpha);
}
`;

// --------------------------------------------------------------------------
// Mask-combine program (port of MASK_COMBINE_SHADER). The composite
// operator is fixed-function blend state, set per draw (see
// MASK_COMPOSITE_BLEND_GL below).
// --------------------------------------------------------------------------

const MASK_COMBINE_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 rectPos;
layout(location = 2) in vec2 rectSize;
out vec2 vUv;
void main() {
  vec2 pixelPos = rectPos + quadVertex * rectSize;
  gl_Position = vec4(
    (pixelPos.x / resolution.x) * 2.0 - 1.0,
    (pixelPos.y / resolution.y) * 2.0 - 1.0,
    0.0, 1.0);
  vUv = quadVertex;
}
`;

const MASK_COMBINE_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform float maskMode;
uniform sampler2D layerTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 layer = texture(layerTex, vUv);
  float coverage = layer.a;
  if (maskMode > 1.5) {
    coverage = (0.2126 * layer.r + 0.7152 * layer.g + 0.0722 * layer.b) * layer.a;
  }
  fragColor = vec4(0.0, 0.0, 0.0, coverage);
}
`;

// --------------------------------------------------------------------------
// Box-blur program (port of BOX_BLUR_SHADER) — one box-blur pass along a
// single axis; the JS driver runs 3 passes per axis.
// --------------------------------------------------------------------------

const FULLSCREEN_VERTEX_GLSL = `#version 300 es
precision highp float;
layout(location = 0) in vec2 quadVertex;
out vec2 vUv;
void main() {
  gl_Position = vec4(quadVertex.x * 2.0 - 1.0, quadVertex.y * 2.0 - 1.0, 0.0, 1.0);
  vUv = quadVertex;
}
`;

const BOX_BLUR_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform vec2 direction;
uniform float boxWidth;
uniform sampler2D srcTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 texelSize = direction / resolution;
  float radius = floor(boxWidth / 2.0);
  vec4 sum = vec4(0.0);
  float count = 0.0;
  for (float i = -radius; i <= radius; i = i + 1.0) {
    vec2 sampleUv = vUv + texelSize * i;
    if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
      continue;
    }
    sum = sum + textureLod(srcTex, sampleUv, 0.0);
    count = count + 1.0;
  }
  fragColor = sum / max(count, 1.0);
}
`;

// --------------------------------------------------------------------------
// Drop-shadow program (port of DROP_SHADOW_SHADER).
// --------------------------------------------------------------------------

const DROP_SHADOW_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform vec2 shadowOffset;
uniform vec4 shadowColor;
uniform sampler2D blurredAlphaTex;
uniform sampler2D currentTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 offsetUv = vUv - shadowOffset / resolution;
  float shadowAlpha = 0.0;
  if (offsetUv.x >= 0.0 && offsetUv.x <= 1.0 && offsetUv.y >= 0.0 && offsetUv.y <= 1.0) {
    shadowAlpha = textureLod(blurredAlphaTex, offsetUv, 0.0).a;
  }
  float shadowAlphaOut = shadowColor.a * shadowAlpha;
  vec4 shadow = vec4(shadowColor.rgb * shadowAlphaOut, shadowAlphaOut);
  vec4 current = texture(currentTex, vUv);
  fragColor = current + shadow * (1.0 - current.a);
}
`;

// --------------------------------------------------------------------------
// Filter-window program (port of FILTER_WINDOW_SHADER) — pads a group
// target into its filter region and crops the filtered region back.
// Texel row 0 holds the image's top row here too, so the WGSL shift
// applies to gl_FragCoord unchanged.
// --------------------------------------------------------------------------

const FILTER_WINDOW_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform vec2 shift; // whole texels; the native adapter sets float uniforms
uniform sampler2D srcTex;
out vec4 fragColor;
void main() {
  ivec2 last = textureSize(srcTex, 0) - ivec2(1);
  ivec2 texel = clamp(ivec2(gl_FragCoord.xy) + ivec2(shift), ivec2(0), last);
  fragColor = texelFetch(srcTex, texel, 0);
}
`;

// --------------------------------------------------------------------------
// Downsample program (port of DOWNSAMPLE_SHADER) — mip-chain generation.
// --------------------------------------------------------------------------

const DOWNSAMPLE_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform sampler2D srcTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(srcTex, vUv);
}
`;

// --------------------------------------------------------------------------
// Text program (port of TEXT_SHADER) — MSDF glyph quads with the
// Chrome-on-macOS coverage model.
// --------------------------------------------------------------------------

const TEXT_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
${APPLY_TRANSFORM_GLSL}
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 glyphPos;
layout(location = 2) in vec2 glyphSize;
layout(location = 3) in vec2 uvPos;
layout(location = 4) in vec2 uvSize;
layout(location = 5) in vec4 color;
layout(location = 6) in vec2 params;
layout(location = 7) in vec2 transformCol0;
layout(location = 8) in vec2 transformCol1;
layout(location = 9) in vec2 transformCol2;
out vec2 vUv;
out vec4 vColor;
out float vPxRange;
out vec2 vPixelPos;
out vec2 vLocalPerUv;
void main() {
  vec2 localPixelPos = glyphPos + quadVertex * glyphSize;
  mat3x2 transform = mat3x2(transformCol0, transformCol1, transformCol2);
  vec2 pixelPos = applyTransform(localPixelPos, transform);
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;
  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vUv = uvPos + quadVertex * uvSize;
  vColor = color;
  vPxRange = params.x;
  vPixelPos = pixelPos;
  vLocalPerUv = glyphSize / uvSize;
}
`;

const TEXT_FRAGMENT_GLSL = `#version 300 es
precision highp float;
${CLIP_UNIFORMS_GLSL}
// Pixel area coverage of the outline with optional per-polarity outline
// dilation in screen px (textThickening; 0 draws the exact outline). Kept
// in sync with the WebGPU text shader.
uniform float dilateLight;
uniform float dilateDark;
uniform sampler2D atlasTex;
in vec2 vUv;
in vec4 vColor;
in float vPxRange;
in vec2 vPixelPos;
in vec2 vLocalPerUv;
out vec4 fragColor;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

${SDF_HELPERS_GLSL}

// Centres of the four half-pixel boxes that tile a pixel, in pixel units.
const vec2 SUBPIXEL_BOX_CENTRES[4] = vec2[4](
  vec2(-0.25, -0.25), vec2(0.25, -0.25),
  vec2(-0.25, 0.25), vec2(0.25, 0.25));

void main() {
${CLIP_EVAL_GLSL}

  vec2 uvdx = dFdx(vUv);
  vec2 uvdy = dFdy(vUv);
  // Pixel area coverage from four half-pixel boxes, screen distances
  // through the uv Jacobian (see the WebGPU text shader).
  float luma = dot(vColor.rgb, vec3(0.299, 0.587, 0.114));
  float dilate = mix(dilateDark, dilateLight, luma);
  float boxDistances[4];
  for (int i = 0; i < 4; i++) {
    vec2 o = SUBPIXEL_BOX_CENTRES[i];
    vec4 m = textureLod(atlasTex, vUv + uvdx * o.x + uvdy * o.y, 0.0);
    boxDistances[i] = (median(m.r, m.g, m.b) - 0.5) * vPxRange;
  }
  vec2 gradient = vec2(
    (boxDistances[1] + boxDistances[3]) - (boxDistances[0] + boxDistances[2]),
    (boxDistances[2] + boxDistances[3]) - (boxDistances[0] + boxDistances[1]));
  vec2 localPerScreenX = uvdx * vLocalPerUv;
  vec2 localPerScreenY = uvdy * vLocalPerUv;
  float determinant = abs(localPerScreenX.x * localPerScreenY.y - localPerScreenX.y * localPerScreenY.x);
  float gradientLength = length(gradient);
  vec2 inverseTransposeGradient = vec2(
    localPerScreenY.y * gradient.x - localPerScreenX.y * gradient.y,
    localPerScreenX.x * gradient.y - localPerScreenY.x * gradient.x);
  float screenPerLocal = gradientLength > 1e-6
    ? length(inverseTransposeGradient) / max(determinant * gradientLength, 1e-12)
    : inversesqrt(max(determinant, 1e-12));
  float cov = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = boxDistances[i] * screenPerLocal + dilate;
    cov += clamp(d * 2.0 + 0.5, 0.0, 1.0);
  }
  float alpha = cov * 0.25;
  if (alpha < 0.001) { discard; }
  fragColor = vec4(vColor.rgb, vColor.a * alpha * clipCoverage);
}
`;

// --------------------------------------------------------------------------
// SVG path program (port of SVG_PATH_SHADER) — MSDF path fills with
// optional gradient fill (single-instance draws; the gradient record
// rides the same data textures at record index 0).
// --------------------------------------------------------------------------

const SVG_PATH_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
${APPLY_TRANSFORM_GLSL}
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 destPos;
layout(location = 2) in vec2 destSize;
layout(location = 3) in vec2 uvPos;
layout(location = 4) in vec2 uvSize;
layout(location = 5) in vec4 color;
layout(location = 6) in float pxRange;
layout(location = 7) in vec2 transformCol0;
layout(location = 8) in vec2 transformCol1;
layout(location = 9) in vec2 transformCol2;
layout(location = 10) in vec2 gradRectPos;
layout(location = 11) in vec2 gradRectSize;
// SVG_PATH_SHADER's per-fragment local position (see its comments): flat
// per-draw values, the fragment's position from gl_FragCoord.
flat out vec4 vUvRect;
flat out vec4 vColor;
flat out float vPxRange;
out vec2 vPixelPos;
flat out vec4 vLocalOrigins;
flat out vec2 vGradHalfSize;
flat out int vInstanceIndex;
flat out vec2 vDestSize;
flat out vec4 vInverseLinear;
flat out vec2 vTranslation;
void main() {
  vec2 localPixelPos = destPos + quadVertex * destSize;
  mat3x2 transform = mat3x2(transformCol0, transformCol1, transformCol2);
  vec2 pixelPos = applyTransform(localPixelPos, transform);
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;
  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vUvRect = vec4(uvPos, uvSize);
  vColor = color;
  vPxRange = pxRange;
  vPixelPos = pixelPos;
  vLocalOrigins = vec4(destPos, gradRectPos + gradRectSize * 0.5);
  vGradHalfSize = gradRectSize * 0.5;
  vInstanceIndex = gl_InstanceID;
  vDestSize = destSize;
  float determinant = transformCol0.x * transformCol1.y - transformCol1.x * transformCol0.y;
  float inverseDeterminant = determinant != 0.0 ? 1.0 / determinant : 0.0;
  vInverseLinear = vec4(
    transformCol1.y * inverseDeterminant,
    -transformCol0.y * inverseDeterminant,
    -transformCol1.x * inverseDeterminant,
    transformCol0.x * inverseDeterminant);
  vTranslation = transformCol2;
}
`;

const SVG_PATH_FRAGMENT_GLSL = `#version 300 es
precision highp float;
precision highp int;
${CLIP_UNIFORMS_GLSL}
${GRADIENT_FETCH_GLSL}
uniform sampler2D atlasTex;
flat in vec4 vUvRect;
flat in vec4 vColor;
flat in float vPxRange;
in vec2 vPixelPos;
flat in vec4 vLocalOrigins;
flat in vec2 vGradHalfSize;
flat in int vInstanceIndex;
flat in vec2 vDestSize;
flat in vec4 vInverseLinear;
flat in vec2 vTranslation;
out vec4 fragColor;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

// SVG_PATH_SHADER's BOX_GRID × BOX_GRID boxes that tile a pixel (see its
// comments), in pixel units.
const int BOX_GRID = 4;
vec2 boxCentre(int i) {
  return (vec2(float(i % BOX_GRID), float(i / BOX_GRID)) + 0.5) / float(BOX_GRID) - 0.5;
}

// SVG_PATH_SHADER's bitmapTexel (see its comments): the path's bitmap read
// bilinearly by hand at a position in its own texels, clamped to it.
vec4 bitmapTexel(ivec2 origin, ivec2 size, vec2 texelPos) {
  vec2 corner = texelPos - 0.5;
  vec2 base = floor(corner);
  vec2 weight = corner - base;
  ivec2 low = clamp(ivec2(base), ivec2(0), size - 1) + origin;
  ivec2 high = clamp(ivec2(base) + 1, ivec2(0), size - 1) + origin;
  vec4 top = mix(
    texelFetch(atlasTex, low, 0),
    texelFetch(atlasTex, ivec2(high.x, low.y), 0),
    weight.x);
  vec4 bottom = mix(
    texelFetch(atlasTex, ivec2(low.x, high.y), 0),
    texelFetch(atlasTex, high, 0),
    weight.x);
  return mix(top, bottom, weight.y);
}

${SDF_HELPERS_GLSL}
${GRADIENT_SAMPLING_GLSL}

void main() {
${CLIP_EVAL_GLSL}

  vec2 fromTranslation = gl_FragCoord.xy - vTranslation;
  vec2 localPixelPos = vec2(
    vInverseLinear.x * fromTranslation.x + vInverseLinear.z * fromTranslation.y,
    vInverseLinear.y * fromTranslation.x + vInverseLinear.w * fromTranslation.y);
  vec2 atlasSize = vec2(textureSize(atlasTex, 0));
  ivec2 bitmapOrigin = ivec2(round(vUvRect.xy * atlasSize));
  vec2 bitmapSize = round(vUvRect.zw * atlasSize);
  ivec2 bitmapTexels = ivec2(bitmapSize);
  vec2 texelPerLocal = bitmapSize / max(vDestSize, vec2(1e-6));
  vec2 texelPos = (localPixelPos - vLocalOrigins.xy) * texelPerLocal;
  vec2 gradLocalPos = localPixelPos - vLocalOrigins.zw;
  vec4 msdf = bitmapTexel(bitmapOrigin, bitmapTexels, texelPos);
  // SVG_PATH_SHADER's box grid, its texel distances read in screen pixels
  // through the texel Jacobian (see its comments).
  vec2 texelPerScreenX = vInverseLinear.xy * texelPerLocal;
  vec2 texelPerScreenY = vInverseLinear.zw * texelPerLocal;
  float texelRange = vPxRange * max(bitmapSize.x, bitmapSize.y) / max(max(vDestSize.x, vDestSize.y), 1e-6);
  float boxDistances[BOX_GRID * BOX_GRID];
  vec2 gradient = vec2(0.0);
  for (int i = 0; i < BOX_GRID * BOX_GRID; i++) {
    vec2 o = boxCentre(i);
    vec4 m = bitmapTexel(bitmapOrigin, bitmapTexels, texelPos + texelPerScreenX * o.x + texelPerScreenY * o.y);
    boxDistances[i] = (median(m.r, m.g, m.b) - 0.5) * texelRange;
    gradient += boxDistances[i] * o;
  }
  float determinant = abs(texelPerScreenX.x * texelPerScreenY.y - texelPerScreenX.y * texelPerScreenY.x);
  float gradientLength = length(gradient);
  vec2 inverseTransposeGradient = vec2(
    texelPerScreenY.y * gradient.x - texelPerScreenX.y * gradient.y,
    texelPerScreenX.x * gradient.y - texelPerScreenY.x * gradient.x);
  float screenPerTexel = gradientLength > 1e-6
    ? length(inverseTransposeGradient) / max(determinant * gradientLength, 1e-12)
    : inversesqrt(max(determinant, 1e-12));
  float cov = 0.0;
  for (int i = 0; i < BOX_GRID * BOX_GRID; i++) {
    cov += clamp(boxDistances[i] * screenPerTexel * float(BOX_GRID) + 0.5, 0.0, 1.0);
  }
  float alpha = vPxRange == 0.0 ? msdf.r : cov / float(BOX_GRID * BOX_GRID);

  if (alpha < 0.001) { discard; }

  vec4 gradHeader = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3);
  uint gradFlags = uint(gradHeader.x);
  uint gradKindBits = uint(gradHeader.y);
  int gradStopStart = int(gradHeader.z);
  int gradStopCount = int(gradHeader.w);
  uint gradKind = gradKindBits & 0x3Fu;
  bool gradIsRepeating = (gradKindBits & 0x80u) != 0u;
  vec4 resolvedColor = vColor;
  if (gradFlags != 0u) {
    vec4 geomA = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3 + 1);
    vec4 geomB = fetchGradientTexel(gradientRecordsTex, vInstanceIndex * 3 + 2);
    vec2 gradOriginSize = max(vec2(geomB.z, geomB.w), vec2(1e-6));
    vec2 gradPosO = gradLocalPos + vGradHalfSize - vec2(geomB.x, geomB.y);
    if ((gradFlags & 2u) != 0u) {
      gradPosO = gradPosO - floor(gradPosO / gradOriginSize) * gradOriginSize;
    }
    if (gradKind >= 4u) {
      resolvedColor = sampleColrGradient(gradLocalPos + vGradHalfSize, geomA, geomB, gradKind,
        gradKindBits & 0xC0u, gradStopStart, gradStopCount);
    } else if (gradKind == 1u) {
      resolvedColor = sampleLinearGradient(gradPosO, gradOriginSize, geomA, gradStopStart, gradStopCount, gradIsRepeating);
    } else if (gradKind == 2u) {
      resolvedColor = sampleRadialGradient(gradPosO, geomA, gradStopStart, gradStopCount, gradIsRepeating);
    }
    // Conic (kind==3u) never reaches here — writeGradientStops throws for
    // a conic svgFillGradient before emission (S7 ruling).
  }

  fragColor = vec4(resolvedColor.rgb, resolvedColor.a * alpha * clipCoverage);
}
`;

// --------------------------------------------------------------------------
// Image program (port of IMAGE_SHADER) — textured quads with exact edge
// coverage and Chrome-compatible explicit mip LOD selection.
// --------------------------------------------------------------------------

const IMAGE_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
${APPLY_TRANSFORM_GLSL}
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 destPos;
layout(location = 2) in vec2 destSize;
layout(location = 3) in vec2 uvPos;
layout(location = 4) in vec2 uvSize;
layout(location = 5) in vec2 transformCol0;
layout(location = 6) in vec2 transformCol1;
layout(location = 7) in vec2 transformCol2;
layout(location = 8) in vec4 abutSides;
out vec2 vUv;
out vec2 vPixelPos;
out vec2 vLocalPos;
out vec2 vHalfSize;
flat out vec4 vCoverageRect;
flat out float vIsAxisAligned;
flat out vec4 vUvRect;
void main() {
  vec2 expandedPos = destPos - 1.5;
  vec2 expandedSize = destSize + 3.0;
  vec2 localPixelPos = expandedPos + quadVertex * expandedSize;
  mat3x2 transform = mat3x2(transformCol0, transformCol1, transformCol2);
  vec2 pixelPos = applyTransform(localPixelPos, transform);
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;

  vec2 uvUnit = (localPixelPos - destPos) / max(destSize, vec2(1e-6));
  vec2 destMin = applyTransform(destPos, transform);
  vec2 destMax = applyTransform(destPos + destSize, transform);

  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vUv = uvPos + uvUnit * uvSize;
  vPixelPos = pixelPos;
  vLocalPos = localPixelPos - (destPos + destSize * 0.5);
  vHalfSize = destSize * 0.5;
  vec2 rawMin = min(destMin, destMax);
  vec2 rawMax = max(destMin, destMax);
  bvec2 flipped = lessThan(destMax, destMin);
  vec2 abutMin = mix(abutSides.xy, abutSides.zw, vec2(flipped));
  vec2 abutMax = mix(abutSides.zw, abutSides.xy, vec2(flipped));
  vCoverageRect = vec4(
    mix(rawMin, ceil(rawMin - 0.5), abutMin),
    mix(rawMax, ceil(rawMax - 0.5), abutMax));
  vIsAxisAligned = (transformCol0.y == 0.0 && transformCol1.x == 0.0) ? 1.0 : 0.0;
  vUvRect = vec4(min(uvPos, uvPos + uvSize), max(uvPos, uvPos + uvSize));
}
`;

const IMAGE_FRAGMENT_GLSL = `#version 300 es
precision highp float;
${CLIP_UNIFORMS_GLSL}
uniform sampler2D imageTex;
// IMAGE_SHADER's GROUP_STRAIGHT_COLOR: 1 for a color glyph cache page.
uniform float groupStraightColor;
in vec2 vUv;
in vec2 vPixelPos;
in vec2 vLocalPos;
in vec2 vHalfSize;
flat in vec4 vCoverageRect;
flat in float vIsAxisAligned;
flat in vec4 vUvRect;
out vec4 fragColor;

${SDF_HELPERS_GLSL}

// Exact area of the unit pixel square centred on p that falls inside the
// screen-space rect r (minX, minY, maxX, maxY).
float boxCoverage(vec2 p, vec4 r) {
  vec2 span = clamp(min(r.zw, p + 0.5) - max(r.xy, p - 0.5), vec2(0.0), vec2(1.0));
  return span.x * span.y;
}

void main() {
  // Derivatives FIRST, unconditionally — same uniformity rule as the
  // WGSL original.
  float d = roundedRectSDF(vLocalPos, vHalfSize, vec4(0.0), vec4(0.0));
  float aa = fwidth(d) * 0.5;
  // Chrome/Skia chooses the mip level from the LESS-minified principal
  // axis — smaller singular value of the screen-to-texel Jacobian.
  vec2 textureSizeTexels = vec2(textureSize(imageTex, 0));
  vec2 uvDxTexels = dFdx(vUv) * textureSizeTexels;
  vec2 uvDyTexels = dFdy(vUv) * textureSizeTexels;
  float jacobianXX = dot(uvDxTexels, uvDxTexels);
  float jacobianXY = dot(uvDxTexels, uvDyTexels);
  float jacobianYY = dot(uvDyTexels, uvDyTexels);
  float discriminant = sqrt(max(
    (jacobianXX - jacobianYY) * (jacobianXX - jacobianYY) +
      4.0 * jacobianXY * jacobianXY,
    0.0));
  float minimumScaleSquared = max(
    0.5 * (jacobianXX + jacobianYY - discriminant),
    1.0);
  float imageLod = 0.5 * log2(minimumScaleSquared);

${CLIP_EVAL_GLSL}

  float edgeCoverage = vIsAxisAligned > 0.5
    ? boxCoverage(vPixelPos, vCoverageRect)
    : 1.0 - smoothstep(-aa, aa, d);

  vec2 halfTexel = 0.5 / vec2(textureSize(imageTex, 0));
  vec2 lo = vUvRect.xy + halfTexel;
  vec2 hi = vUvRect.zw - halfTexel;
  vec2 uv = clamp(vUv, min(lo, hi), max(lo, hi));

  // Same EMPIRICAL -0.25 bias as the WGSL original (see its comment).
  vec4 premultipliedColor = textureLod(imageTex, uv, imageLod - 0.25);
  float sampledAlpha = premultipliedColor.a;
  if (sampledAlpha < 0.001) { discard; }
  // IMAGE_SHADER's straight color (see its comments).
  vec3 straightColor = groupStraightColor > 0.5
    ? clamp(premultipliedColor.rgb / max(sampledAlpha, 1e-6), vec3(0.0), vec3(1.0))
    : premultipliedColor.rgb / sampledAlpha;
  float alpha = sampledAlpha * clipCoverage * edgeCoverage;
  if (alpha < 0.001) { discard; }
  fragColor = vec4(straightColor, alpha);
}
`;

// --------------------------------------------------------------------------
// Box-shadow program (port of BOX_SHADOW_SHADER) — Evan Wallace analytic
// rounded-rect Gaussian shadow, extended to per-corner elliptical radii.
// --------------------------------------------------------------------------

const BOX_SHADOW_VERTEX_GLSL = `#version 300 es
precision highp float;
uniform vec2 resolution;
${APPLY_TRANSFORM_GLSL}
layout(location = 0) in vec2 quadVertex;
layout(location = 1) in vec2 rectPos;
layout(location = 2) in vec2 rectSize;
layout(location = 3) in vec4 color;
layout(location = 4) in vec4 radiiX;
layout(location = 5) in vec4 radiiY;
layout(location = 6) in vec2 transformCol0;
layout(location = 7) in vec2 transformCol1;
layout(location = 8) in vec2 transformCol2;
layout(location = 9) in float blurSigma;
layout(location = 10) in float isInset;
layout(location = 11) in vec2 borderBoxPos;
layout(location = 12) in vec2 borderBoxSize;
layout(location = 13) in vec4 borderBoxRadiiX;
layout(location = 14) in vec4 borderBoxRadiiY;
out vec2 vLocalPos;
out vec2 vHalfSize;
out vec4 vColor;
out vec4 vRadiiX;
out vec4 vRadiiY;
out vec2 vPixelPos;
out float vBlurSigma;
out float vIsInset;
out vec2 vBorderBoxLocalCenter;
out vec2 vBorderBoxHalfSize;
out vec4 vBorderBoxRadiiX;
out vec4 vBorderBoxRadiiY;
void main() {
  bool insetQuad = isInset > 0.5 && isInset < 1.5;
  vec2 quadPos = insetQuad ? borderBoxPos : rectPos;
  vec2 quadSize = insetQuad ? borderBoxSize : rectSize;

  float skirt = max(1.5, 3.0 * blurSigma);
  vec2 expandedPos = quadPos - skirt;
  vec2 expandedSize = quadSize + skirt * 2.0;
  vec2 localPixelPos = expandedPos + quadVertex * expandedSize;

  mat3x2 transform = mat3x2(transformCol0, transformCol1, transformCol2);
  vec2 pixelPos = applyTransform(localPixelPos, transform);
  float clipX = (pixelPos.x / resolution.x) * 2.0 - 1.0;
  float clipY = (pixelPos.y / resolution.y) * 2.0 - 1.0;

  vec2 center = rectPos + rectSize * 0.5;
  vec2 localPos = localPixelPos - center;
  vec2 borderBoxCenter = borderBoxPos + borderBoxSize * 0.5;

  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  vLocalPos = localPos;
  vHalfSize = rectSize * 0.5;
  vColor = color;
  vRadiiX = radiiX;
  vRadiiY = radiiY;
  vPixelPos = pixelPos;
  vBlurSigma = blurSigma;
  vIsInset = isInset;
  vBorderBoxLocalCenter = borderBoxCenter - center;
  vBorderBoxHalfSize = borderBoxSize * 0.5;
  vBorderBoxRadiiX = borderBoxRadiiX;
  vBorderBoxRadiiY = borderBoxRadiiY;
}
`;

const BOX_SHADOW_FRAGMENT_GLSL = `#version 300 es
precision highp float;
${CLIP_UNIFORMS_GLSL}
in vec2 vLocalPos;
in vec2 vHalfSize;
in vec4 vColor;
in vec4 vRadiiX;
in vec4 vRadiiY;
in vec2 vPixelPos;
in float vBlurSigma;
in float vIsInset;
in vec2 vBorderBoxLocalCenter;
in vec2 vBorderBoxHalfSize;
in vec4 vBorderBoxRadiiX;
in vec4 vBorderBoxRadiiY;
out vec4 fragColor;

${SDF_HELPERS_GLSL}

// Evan Wallace's own polynomial erf() approximation (CC0), verbatim.
vec4 erf(vec4 x) {
  vec4 s = sign(x);
  vec4 a = abs(x);
  vec4 t = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  t *= t;
  t *= t;
  return s - s / t;
}

float gaussian(float x, float sigma) {
  float pi = 3.141592653589793;
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (sqrt(2.0 * pi) * sigma);
}

float curvedExtent(float halfSizeX, float halfSizeY, float rx, float ry, float y) {
  float delta = min(halfSizeY - ry - abs(y), 0.0);
  float ryClamped = max(ry, 1e-6);
  float t = max(0.0, 1.0 - (delta / ryClamped) * (delta / ryClamped));
  float dx = rx * sqrt(t);
  return halfSizeX - rx + dx;
}

float roundedBoxShadowXPerCorner(float x, float y, float sigma, vec2 halfSize, vec4 radiiX, vec4 radiiY) {
  bool isBottom = y > 0.0;
  float leftRx = isBottom ? radiiX.w : radiiX.x;
  float leftRy = isBottom ? radiiY.w : radiiY.x;
  float rightRx = isBottom ? radiiX.z : radiiX.y;
  float rightRy = isBottom ? radiiY.z : radiiY.y;

  float curvedLeft = curvedExtent(halfSize.x, halfSize.y, leftRx, leftRy, y);
  float curvedRight = curvedExtent(halfSize.x, halfSize.y, rightRx, rightRy, y);

  float scale = sqrt(0.5) / sigma;
  float lo = 0.5 + 0.5 * erf(vec4((x + curvedLeft) * scale, 0.0, 0.0, 0.0)).x;
  float hi = 0.5 + 0.5 * erf(vec4((x - curvedRight) * scale, 0.0, 0.0, 0.0)).x;
  return lo - hi;
}

float roundedBoxShadow(vec2 halfSize, vec2 point, float sigma, vec4 radiiX, vec4 radiiY) {
  float low = point.y - halfSize.y;
  float high = point.y + halfSize.y;
  float start = clamp(-3.0 * sigma, low, high);
  float end = clamp(3.0 * sigma, low, high);
  float step_ = (end - start) / 4.0;
  float y = start + step_ * 0.5;
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += roundedBoxShadowXPerCorner(point.x, point.y - y, sigma, halfSize, radiiX, radiiY) * gaussian(y, sigma) * step_;
    y += step_;
  }
  return value;
}

void main() {
${CLIP_EVAL_GLSL}

  bool isInset = vIsInset > 0.5 && vIsInset < 1.5;
  bool excludesBorderBox = vIsInset > 1.5;

  bool isCoincidentOutset = excludesBorderBox
    && vBlurSigma <= 0.0
    && all(equal(vBorderBoxLocalCenter, vec2(0.0)))
    && all(equal(vHalfSize, vBorderBoxHalfSize))
    && all(equal(vRadiiX, vBorderBoxRadiiX))
    && all(equal(vRadiiY, vBorderBoxRadiiY));
  if (isCoincidentOutset) { discard; }

  float bd = roundedRectSDF(vLocalPos - vBorderBoxLocalCenter, vBorderBoxHalfSize, vBorderBoxRadiiX, vBorderBoxRadiiY);
  float bAa = fwidth(bd) * 0.5;
  float borderBoxCoverage = 1.0;
  if (isInset) {
    if (bd > bAa) { discard; }
    borderBoxCoverage = 1.0 - smoothstep(-bAa, bAa, bd);
  } else if (excludesBorderBox) {
    if (bd < -1.0) { discard; }
  }

  float d = roundedRectSDF(vLocalPos, vHalfSize, vRadiiX, vRadiiY);
  float aa = fwidth(d) * 0.5;
  float coverage;
  if (vBlurSigma <= 0.0) {
    coverage = 1.0 - smoothstep(-aa, aa, d);
  } else {
    coverage = clamp(roundedBoxShadow(vHalfSize, vLocalPos, vBlurSigma, vRadiiX, vRadiiY), 0.0, 1.0);
  }
  float finalCoverage = (isInset ? 1.0 - coverage : coverage) * borderBoxCoverage;
  float alpha = vColor.a * finalCoverage * clipCoverage;
  if (alpha < 0.001) { discard; }
  fragColor = vec4(vColor.rgb, alpha);
}
`;

// --------------------------------------------------------------------------
// Context creation.
// --------------------------------------------------------------------------

function compileProgram(gl, name, vertexSource, fragmentSource) {
  function compileStage(kind, source) {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(
        `WebGL 2 shader compilation failed (${name}, ${
          kind === gl.VERTEX_SHADER ? "vertex" : "fragment"
        }):\n${log}`,
      );
    }
    return shader;
  }
  const vertexShader = compileStage(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileStage(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL 2 program link failed (${name}):\n${log}`);
  }
  return program;
}

function uniformLocations(gl, program, names) {
  const locations = {};
  for (const uniformName of names) {
    locations[uniformName] = gl.getUniformLocation(program, uniformName);
  }
  return locations;
}

// One VAO wiring the shared quad (location 0) plus an instanced attribute
// layout over the shared instance buffer. attributes: [size, ...] in
// consecutive locations starting at 1, all float, tightly packed at
// `strideFloats`.
function makeInstancedVertexArray(
  gl,
  quadBuffer,
  instanceBuffer,
  attributeSizes,
  strideFloats,
) {
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  let offsetFloats = 0;
  for (let i = 0; i < attributeSizes.length; i++) {
    const location = 1 + i;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      attributeSizes[i],
      gl.FLOAT,
      false,
      strideFloats * 4,
      offsetFloats * 4,
    );
    gl.vertexAttribDivisor(location, 1);
    offsetFloats += attributeSizes[i];
  }
  gl.bindVertexArray(null);
  if (offsetFloats !== strideFloats) {
    throw new Error(
      `WebGL 2 vertex layout mismatch: attributes cover ${offsetFloats} floats, stride is ${strideFloats}`,
    );
  }
  return vertexArray;
}

function createCanvasTexture(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(
      `WebGL 2 framebuffer incomplete: status 0x${status.toString(16)}`,
    );
  }
  return { texture, framebuffer, width, height };
}

function createDataTexture(gl, rows) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, DATA_TEXTURE_WIDTH, rows);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, rows };
}

// Upload `texels` RGBA32F texels (Float32Array, 4 floats per texel) into a
// data texture, padding the trailing partial row.
function uploadDataTexture(gl, dataTexture, floats, texelCount) {
  const rows = Math.ceil(texelCount / DATA_TEXTURE_WIDTH);
  if (rows === 0) return;
  if (rows > dataTexture.rows) {
    throw new Error(
      `WebGL 2 data texture overflow: need ${rows} rows, have ${dataTexture.rows}`,
    );
  }
  const paddedLength = rows * DATA_TEXTURE_WIDTH * 4;
  let upload = floats;
  if (floats.length < paddedLength) {
    upload = new Float32Array(paddedLength);
    upload.set(floats);
  }
  // Bind on the stops texture unit (7), NOT whatever unit is active —
  // binding on the active unit silently replaced a draw's own texture
  // (unit 0's MSDF atlas in the svg-path draw), which the parity harness
  // caught as 26-44% structural diffs on every Tier B SVG scene. Every
  // consumer rebinds units 6/7 through bindGradientTextures AFTER the
  // uploads, so clobbering unit 7 here is safe.
  gl.activeTexture(gl.TEXTURE7);
  gl.bindTexture(gl.TEXTURE_2D, dataTexture.texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    DATA_TEXTURE_WIDTH,
    rows,
    gl.RGBA,
    gl.FLOAT,
    upload,
  );
}

const CLIP_UNIFORM_NAMES = ["resolution", "clipCount", "clips"];

// One shared GL context for EVERY WebGL 2 render context. This backend
// never draws to the canvas's default framebuffer — every render target
// is a framebuffer-object texture — so the canvas size is irrelevant and
// one GL context serves surfaces of every size. Sharing is REQUIRED, not
// an optimization: browsers force-lose the oldest WebGL context past a
// small per-page cap (~16 in Chrome), so one-context-per-surface breaks
// as soon as a page renders many scene sizes (observed as blank frames
// and FRAMEBUFFER_UNSUPPORTED in the parity harness before this change).
const defaultSharedStateOwner = {};

async function createSharedWebgl2State() {
  // The browser canvas or native EGL pbuffer is never presented. Every
  // Sandom surface renders into its own framebuffer-object texture.
  let canvas = null;
  let gl;
  let backendInfo;
  if (typeof OffscreenCanvas !== "undefined") {
    const candidate = new OffscreenCanvas(4, 4);
    if (typeof candidate.getContext === "function") canvas = candidate;
  }
  if (canvas === null && typeof document !== "undefined") {
    const candidate = document.createElement("canvas");
    if (typeof candidate.getContext === "function") {
      canvas = candidate;
    }
  }
  if (canvas !== null) {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (gl) {
      canvas.width = 4;
      canvas.height = 4;
      backendInfo = Object.freeze({
        host: "browser",
        implementation: "WebGL 2",
        version: gl.getParameter(gl.VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
      });
    }
  }
  if (!gl) {
    gl = await createNativeWebgl2Context(4, 4);
    backendInfo = gl.backendInfo;
  }

  // Context loss: this backend fails loudly rather than restoring — every
  // frame's source data is re-uploadable, but a silent partial restore is
  // worse than a clear error (plan's own contract: never present a
  // partially restored frame).
  let contextLost = false;
  canvas?.addEventListener?.("webglcontextlost", () => {
    contextLost = true;
  });

  // --- Capability probe (measured, not assumed) ---
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxVertexAttributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
  const maxFragmentUniformVectors = gl.getParameter(
    gl.MAX_FRAGMENT_UNIFORM_VECTORS,
  );
  const failures = [];
  if (maxTextureSize < DATA_TEXTURE_WIDTH) {
    failures.push(
      `maximum texture size ${maxTextureSize} < ${DATA_TEXTURE_WIDTH}`,
    );
  }
  if (maxVertexAttributes < 16) {
    failures.push(`maximum vertex attributes ${maxVertexAttributes} < 16`);
  }
  // The clip array (40 vec4) plus scalars must fit; 64 is a comfortable
  // bound far under the composite shader's real count.
  if (maxFragmentUniformVectors < 64) {
    failures.push(
      `maximum fragment uniform vectors ${maxFragmentUniformVectors} < 64`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `WebGL 2 capability probe failed:\n  ${failures.join("\n  ")}`,
    );
  }

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  // GL dithers RGBA8 output by default; WebGPU never dithers — parity
  // requires turning it off.
  gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

  // --- Programs ---
  const rectProgram = compileProgram(
    gl,
    "rect",
    RECT_VERTEX_GLSL,
    RECT_FRAGMENT_GLSL,
  );
  const compositeProgram = compileProgram(
    gl,
    "composite",
    COMPOSITE_VERTEX_GLSL,
    COMPOSITE_FRAGMENT_GLSL,
  );
  const maskCombineProgram = compileProgram(
    gl,
    "maskCombine",
    MASK_COMBINE_VERTEX_GLSL,
    MASK_COMBINE_FRAGMENT_GLSL,
  );
  const boxBlurProgram = compileProgram(
    gl,
    "boxBlur",
    FULLSCREEN_VERTEX_GLSL,
    BOX_BLUR_FRAGMENT_GLSL,
  );
  const dropShadowProgram = compileProgram(
    gl,
    "dropShadow",
    FULLSCREEN_VERTEX_GLSL,
    DROP_SHADOW_FRAGMENT_GLSL,
  );
  const filterWindowProgram = compileProgram(
    gl,
    "filterWindow",
    FULLSCREEN_VERTEX_GLSL,
    FILTER_WINDOW_FRAGMENT_GLSL,
  );
  const downsampleProgram = compileProgram(
    gl,
    "downsample",
    FULLSCREEN_VERTEX_GLSL,
    DOWNSAMPLE_FRAGMENT_GLSL,
  );
  const textProgram = compileProgram(
    gl,
    "text",
    TEXT_VERTEX_GLSL,
    TEXT_FRAGMENT_GLSL,
  );
  const svgPathProgram = compileProgram(
    gl,
    "svgPath",
    SVG_PATH_VERTEX_GLSL,
    SVG_PATH_FRAGMENT_GLSL,
  );
  const imageProgram = compileProgram(
    gl,
    "image",
    IMAGE_VERTEX_GLSL,
    IMAGE_FRAGMENT_GLSL,
  );
  const boxShadowProgram = compileProgram(
    gl,
    "boxShadow",
    BOX_SHADOW_VERTEX_GLSL,
    BOX_SHADOW_FRAGMENT_GLSL,
  );

  const programs = {
    rect: {
      program: rectProgram,
      uniforms: uniformLocations(gl, rectProgram, [
        ...CLIP_UNIFORM_NAMES,
        "gradientRecordsTex",
        "gradientStopsTex",
      ]),
    },
    composite: {
      program: compositeProgram,
      uniforms: uniformLocations(gl, compositeProgram, [
        ...CLIP_UNIFORM_NAMES,
        "opacity",
        "blendMode",
        "hasMatrix",
        "outputPremultiplied",
        "porterDuff",
        "matrixR",
        "matrixG",
        "matrixB",
        "matrixA",
        "matrixConst",
        "pathMaskInfo",
        "pathMaskRect",
        "pathMaskBbox",
        "pathMaskUv",
        "pathMaskInvA",
        "pathMaskTranslation",
        "maskInfo",
        "srcTex",
        "backdropTex",
        "pathMaskTex",
        "maskTex",
      ]),
    },
    maskCombine: {
      program: maskCombineProgram,
      uniforms: uniformLocations(gl, maskCombineProgram, [
        "resolution",
        "maskMode",
        "layerTex",
      ]),
    },
    boxBlur: {
      program: boxBlurProgram,
      uniforms: uniformLocations(gl, boxBlurProgram, [
        "resolution",
        "direction",
        "boxWidth",
        "srcTex",
      ]),
    },
    dropShadow: {
      program: dropShadowProgram,
      uniforms: uniformLocations(gl, dropShadowProgram, [
        "resolution",
        "shadowOffset",
        "shadowColor",
        "blurredAlphaTex",
        "currentTex",
      ]),
    },
    filterWindow: {
      program: filterWindowProgram,
      uniforms: uniformLocations(gl, filterWindowProgram, ["shift", "srcTex"]),
    },
    downsample: {
      program: downsampleProgram,
      uniforms: uniformLocations(gl, downsampleProgram, ["srcTex"]),
    },
    text: {
      program: textProgram,
      uniforms: uniformLocations(gl, textProgram, [
        ...CLIP_UNIFORM_NAMES,
        "dilateLight",
        "dilateDark",
        "atlasTex",
      ]),
    },
    svgPath: {
      program: svgPathProgram,
      uniforms: uniformLocations(gl, svgPathProgram, [
        ...CLIP_UNIFORM_NAMES,
        "atlasTex",
        "gradientRecordsTex",
        "gradientStopsTex",
      ]),
    },
    image: {
      program: imageProgram,
      uniforms: uniformLocations(gl, imageProgram, [
        ...CLIP_UNIFORM_NAMES,
        "imageTex",
        "groupStraightColor",
      ]),
    },
    boxShadow: {
      program: boxShadowProgram,
      uniforms: uniformLocations(gl, boxShadowProgram, CLIP_UNIFORM_NAMES),
    },
  };

  // --- Buffers and vertex arrays ---
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

  // One shared instance buffer, re-uploaded per draw with bufferData — GL
  // executes draws immediately, so the WebGPU deferred-encoder hazard does
  // not apply.
  const instanceBuffer = gl.createBuffer();

  const vertexArrays = {
    rect: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 2, 2, 2, 2],
      RECT_INSTANCE_FLOATS,
    ),
    composite: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2],
      4,
    ),
    text: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2, 2, 2, 4, 2, 2, 2, 2],
      20,
    ),
    svgPath: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2, 2, 2, 4, 1, 2, 2, 2, 2, 2],
      23,
    ),
    image: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2, 2, 2, 2, 2, 2, 4],
      18,
    ),
    boxShadow: makeInstancedVertexArray(
      gl,
      quadBuffer,
      instanceBuffer,
      [2, 2, 4, 4, 4, 2, 2, 2, 1, 1, 2, 2, 4, 4],
      BOX_SHADOW_INSTANCE_FLOATS,
    ),
  };
  // Fullscreen passes reuse the composite VAO's quad slot only — a
  // dedicated VAO with just the quad attribute.
  const fullscreenVertexArray = gl.createVertexArray();
  gl.bindVertexArray(fullscreenVertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.bindVertexArray(null);

  // --- Gradient data textures (the storage-buffer replacement) ---
  const gradientRecordRows = Math.ceil(MAX_INSTANCES * 3 / DATA_TEXTURE_WIDTH);
  const gradientRecordsTexture = createDataTexture(gl, gradientRecordRows);
  // 4096 stops × 2 texels = 8 rows. The stop count is bounded per batch by
  // the walker's own data; a scene exceeding this throws loudly in
  // uploadDataTexture (declared limit, per the plan's overflow contract).
  const gradientStopsTexture = createDataTexture(
    gl,
    Math.ceil(4096 * 2 / DATA_TEXTURE_WIDTH),
  );

  // Blit framebuffers for texture-to-texture copies.
  const blitReadFramebuffer = gl.createFramebuffer();
  const blitDrawFramebuffer = gl.createFramebuffer();

  // 1x1 opaque-white placeholder for never-sampled composite slots.
  const placeholderTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, placeholderTexture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Cross-frame caches. Atlas textures: one GL texture per (atlas,
  // revision), the same rule as the WebGPU backend's
  // WasmAtlas.deviceTexture — held here rather than on the atlas because a
  // GL texture belongs to this context and must be deleted with it.
  const atlasTextures = new Map();
  const premultipliedImagePixelCache = new WeakMap();

  const shared = {
    gl,
    canvas,
    backendInfo,
    programs,
    vertexArrays,
    fullscreenVertexArray,
    quadBuffer,
    instanceBuffer,
    gradientRecordsTexture,
    gradientStopsTexture,
    blitReadFramebuffer,
    blitDrawFramebuffer,
    placeholderTexture,
    atlasTextures,
    premultipliedImagePixelCache,
    capabilities: Object.freeze({
      maxTextureSize,
      maxVertexAttributes,
      maxFragmentUniformVectors,
    }),
    get contextLost() {
      return contextLost || gl.isContextLost();
    },
  };

  // --- Self-test: draw a known rect through the real rect program and
  // read the pixel back (the probe must test operations, not just limits).
  probeSelfTest(shared);

  return shared;
}

export async function releaseSharedWebgl2State(
  stateOwner = defaultSharedStateOwner,
) {
  const sharedStatePromise = stateOwner.webgl2;
  if (sharedStatePromise === undefined) return;
  delete stateOwner.webgl2;
  const shared = await sharedStatePromise;
  const { gl } = shared;
  gl.activate?.();
  for (const { program } of Object.values(shared.programs)) {
    gl.deleteProgram(program);
  }
  for (const vertexArray of Object.values(shared.vertexArrays)) {
    gl.deleteVertexArray(vertexArray);
  }
  gl.deleteVertexArray(shared.fullscreenVertexArray);
  gl.deleteBuffer(shared.instanceBuffer);
  gl.deleteBuffer(shared.quadBuffer);
  gl.deleteTexture(shared.gradientRecordsTexture.texture);
  gl.deleteTexture(shared.gradientStopsTexture.texture);
  gl.deleteTexture(shared.placeholderTexture);
  for (const entry of shared.atlasTextures.values()) entry.close();
  shared.atlasTextures.clear();
  gl.deleteFramebuffer(shared.blitReadFramebuffer);
  gl.deleteFramebuffer(shared.blitDrawFramebuffer);
  gl.destroy?.();
}

// Create one WebGL 2 render context for a width x height surface. In a browser
// this uses WebGL2RenderingContext. Deno, Node, and Bun load the optional
// native-gles host only when selection reaches WebGL 2.
export async function createRenderContextWebgl2(options) {
  // Match the native texture extent conversion before deriving any CPU
  // readback dimensions or publishing the render context's size.
  const width = Math.trunc(options.width);
  const height = Math.trunc(options.height);
  const stateOwner = options.sharedStateOwner ?? defaultSharedStateOwner;
  const shared = await (stateOwner.webgl2 ??= createSharedWebgl2State());
  shared.gl.activate?.();
  if (shared.capabilities.maxTextureSize < Math.max(width, height)) {
    throw new Error(
      `WebGL 2 capability probe failed: maximum texture size ` +
        `${shared.capabilities.maxTextureSize} is smaller than the surface ${width}x${height}`,
    );
  }
  const mainTarget = createCanvasTexture(shared.gl, width, height);
  let frameCount = 0;
  let rasterRetention = null;
  return {
    kind: "webgl2",
    backendInfo: shared.backendInfo,
    // The degraded backend composites eight-bit sRGB; the output boundary
    // uses this to reject wide-gamut and high-dynamic-range requests.
    renderPrecision: "rgba8unorm",
    shared,
    width,
    height,
    mainTarget,
    capabilities: shared.capabilities,
    get contextLost() {
      return shared.contextLost;
    },
    get frameCount() {
      return frameCount;
    },
    incrementFrameCount() {
      frameCount++;
    },
    rasterRetentionFor(core) {
      return rasterRetention ??= createRasterRetention(core, width, height, 4);
    },
    destroy() {
      rasterRetention?.destroy();
      shared.gl.deleteFramebuffer(mainTarget.framebuffer);
      shared.gl.deleteTexture(mainTarget.texture);
    },
  };
}

// A page of the color glyph cache (src/color-glyph-cache.js): an RGBA8
// texture of the shared GL context that the entries a render with
// readback "none" left in a source context's main target are copied into,
// sampled texel for texel.
export function createWebgl2ColorGlyphCachePage(context, width, height) {
  const { gl } = context.shared;
  gl.activate?.();
  const target = createCanvasTexture(gl, width, height);
  gl.bindTexture(gl.TEXTURE_2D, target.texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    texture: target.texture,
    width,
    height,
    copyFrom(sourceContext, rects) {
      gl.activate?.();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceContext.mainTarget.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      for (const rect of rects) {
        const right = rect.x + rect.width;
        const bottom = rect.y + rect.height;
        gl.blitFramebuffer(
          rect.x,
          rect.y,
          right,
          bottom,
          rect.x,
          rect.y,
          right,
          bottom,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    },
    destroy() {
      gl.activate?.();
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    },
  };
}

function probeSelfTest(shared) {
  const { gl } = shared;
  const target = createCanvasTexture(gl, 4, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, 4, 4);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );
  const rect = shared.programs.rect;
  gl.useProgram(rect.program);
  gl.uniform2f(rect.uniforms.resolution, 4, 4);
  gl.uniform1f(rect.uniforms.clipCount, 0);
  gl.uniform4fv(
    rect.uniforms.clips,
    new Float32Array(MAX_SHADER_CLIP_ENTRIES * 5 * 4),
  );
  gl.uniform1i(rect.uniforms.gradientRecordsTex, 0);
  gl.uniform1i(rect.uniforms.gradientStopsTex, 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, shared.gradientRecordsTexture.texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, shared.gradientStopsTexture.texture);
  // Zero the first record so the probe rect takes the solid-fill path.
  uploadDataTexture(gl, shared.gradientRecordsTexture, new Float32Array(12), 3);
  const instance = new Float32Array(RECT_INSTANCE_FLOATS);
  instance.set([0, 0, 4, 4, 1, 0, 0, 1]); // x,y,w,h, fill rgba = opaque red
  instance[36] = 1; // identity transform a
  instance[39] = 1; // identity transform d
  gl.bindBuffer(gl.ARRAY_BUFFER, shared.instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instance, gl.DYNAMIC_DRAW);
  gl.bindVertexArray(shared.vertexArrays.rect);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
  gl.bindVertexArray(null);
  const pixel = new Uint8Array(4);
  gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (pixel[0] < 250 || pixel[1] > 5 || pixel[2] > 5 || pixel[3] < 250) {
    throw new Error(
      `WebGL 2 capability self-test failed: rect draw read back [${
        pixel.join(", ")
      }], expected opaque red`,
    );
  }
}

// --------------------------------------------------------------------------
// Frame execution interprets the same numeric plan as src/rasterize.js; see
// that file for the paint-order and effect-stack design comments.
// --------------------------------------------------------------------------

// mask-composite operators as fixed-function blend factors — same
// Porter-Duff table as MASK_COMPOSITE_BLEND in the WebGPU backend
// (add = source-over, subtract = source-out, intersect = source-in,
// exclude = xor), indexed by layout.js's MASK_COMPOSITE_* enum.
function maskCompositeBlendFactors(gl, compositeOperator) {
  switch (compositeOperator) {
    case 0:
      return [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    case 1:
      return [gl.ONE_MINUS_DST_ALPHA, gl.ZERO];
    case 2:
      return [gl.DST_ALPHA, gl.ZERO];
    case 3:
      return [gl.ONE_MINUS_DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA];
    default:
      throw new Error(
        `render: unknown mask-composite operator ${compositeOperator}`,
      );
  }
}

export function renderWebgl2(context, options = {}) {
  const {
    background = { r: 0, g: 0, b: 0, a: 0 },
    svgPathAtlas = null,
    planReader,
    atlasForIdentity,
    images = null,
    dirtyTiles = null,
    deferReadback = false,
    readback = "float32",
    textThickening = { darkInk: 0, lightInk: 0 },
    glyphPerformance = null,
  } = options;
  const { width, height, mainTarget } = context;
  const {
    gl,
    programs,
    vertexArrays,
    fullscreenVertexArray,
    instanceBuffer,
    gradientRecordsTexture,
    gradientStopsTexture,
    placeholderTexture,
    atlasTextures,
    premultipliedImagePixelCache,
  } = context.shared;
  gl.activate?.();

  if (context.contextLost) {
    throw new Error(
      "render: the WebGL 2 context was lost; this backend does not restore — create a new render context",
    );
  }

  const incremental = dirtyTiles !== null;

  if (planReader == null) {
    throw new TypeError("renderWebgl2: options.planReader is required");
  }
  const opacityStack = [];
  const backgroundStack = [];
  const blendLayerStack = [];
  const maskStack = [];
  const maskLayerStack = [];
  const batch = createRasterPlanCursor(planReader, options.rasterPlan.exports, {
    atlasForIdentity,
    svgPathAtlas,
    images,
  });

  // Per-frame GL objects deleted at the end of the frame (mirrors the
  // WebGPU backend's texturesToDestroy).
  const targetsToDestroy = [];
  const texturesToDestroy = [];
  const framebuffersToDestroy = [];

  function makeCanvasTarget(targetWidth = width, targetHeight = height) {
    const target = createCanvasTexture(gl, targetWidth, targetHeight);
    targetsToDestroy.push(target);
    return target;
  }

  function setStandardBlend() {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
  }

  let currentTarget = mainTarget;
  let currentDamage = null;
  function bindTarget(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    if (currentDamage && target === mainTarget) {
      gl.enable(gl.SCISSOR_TEST);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  // One instanced quad draw with the bound program and state. Dependency
  // groups render their complete source; only the retained destination is
  // scissored, once per dirty rect the draw reaches: a selected draw
  // (`reach` true) only for the rects its plan bounds overlap, any other
  // draw for every rect (the WebGPU backend's drawCurrentPass rule).
  function drawInstanced(vertexArray, count, reach = false) {
    gl.bindVertexArray(vertexArray);
    if (currentDamage && currentTarget === mainTarget) {
      for (const rect of currentDamage.rects) {
        if (reach && !batch.reaches(rect.x, rect.y, rect.w, rect.h)) continue;
        gl.scissor(rect.x, rect.y, rect.w, rect.h);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      }
    } else {
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }
    gl.bindVertexArray(null);
  }

  function clearTargetTransparent(target) {
    bindTarget(target);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Copy one canvas-sized target's pixels into a fresh texture (the
  // copyTextureToTexture mirror).
  function snapshotTarget(sourceTarget) {
    const destination = makeCanvasTarget();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceTarget.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination.framebuffer);
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      0,
      width,
      height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return destination;
  }

  function uploadInstances(data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  function setClipUniforms(programInfo, clipState) {
    gl.uniform2f(programInfo.uniforms.resolution, width, height);
    gl.uniform1f(programInfo.uniforms.clipCount, clipState.entries.length);
    gl.uniform4fv(
      programInfo.uniforms.clips,
      new Float32Array(clipUniformFloats(clipState)),
    );
  }

  // Each context acknowledges its own native change stream. Retained native
  // revisions keep displaced textures alive until their final plan releases.
  function cachedAtlasTexture(atlas) {
    const owner = atlas.graphicsOwner;
    let entry = atlasTextures.get(owner);
    if (!entry) {
      entry = { texture: null, revision: 0, identity: 0, sequence: 0, records: new Map() };
      entry.consumer = owner.createUploadConsumer((identity) => {
        const record = entry.records.get(identity);
        if (!record) throw new Error(`Native atlas texture ${identity} is absent from its WebGL context`);
        entry.records.delete(identity);
        gl.activate?.();
        gl.deleteTexture(record.texture);
      });
      entry.close = () => {
        if (!entry.consumer) return;
        atlasTextures.delete(owner);
        entry.unsubscribeDestroy();
        if (entry.identity) owner.retireUploadTexture(entry.consumer, entry.revision, entry.identity);
        owner.closeUploadConsumer(entry.consumer);
        entry.consumer = 0;
        gl.activate?.();
      };
      entry.unsubscribeDestroy = owner.onDestroy(entry.close);
      atlasTextures.set(owner, entry);
    }
    if (entry.revision === atlas.revision) return entry.texture;
    for (const record of entry.records.values()) {
      if (record.revision === atlas.revision) return record.texture;
    }
    const changes = atlas.uploadChanges(entry.consumer);
    let texture = entry.texture;
    if (changes.replace) {
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, atlas.atlasWidth, atlas.atlasHeight);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    try {
      for (const rectangle of changes.rectangles) {
        const { data, bytesPerRow } = atlas.uploadRegion(rectangle);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, bytesPerRow / 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, rectangle.x, rectangle.y, rectangle.width, rectangle.height,
          gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    }
    const previousIdentity = entry.identity;
    const previousRevision = entry.revision;
    entry.texture = texture;
    entry.revision = atlas.revision;
    if (changes.replace) {
      entry.identity = ++entry.sequence;
      entry.records.set(entry.identity, { texture, revision: atlas.revision });
    } else {
      entry.records.get(entry.identity).revision = atlas.revision;
    }
    atlas.acknowledgeUpload(entry.consumer);
    if (changes.replace && previousIdentity) owner.retireUploadTexture(entry.consumer, previousRevision, previousIdentity);
    gl.activate?.();
    return texture;
  }

  function pathAtlasTexture(atlas) {
    const hasAtlas = atlas && atlas.atlasWidth > 0 && atlas.atlasHeight > 0;
    if (!hasAtlas) return placeholderTexture;
    return cachedAtlasTexture(atlas);
  }

  // Upload native raster-plan gradient spans. WebGL data textures encode the
  // record's integer header as exact floats; stop colors come from each
  // 48-byte stop's precomputed sRGB copy at byte 32.
  function uploadGradients(gradients, count) {
    const recordFloats = new Float32Array(count * 12);
    let stopCount = 0;
    for (let i = 0; i < count; i++) {
      const gradient = gradients[i];
      if (gradient === null) continue;
      const source = new DataView(
        gradient.record.buffer,
        gradient.record.byteOffset,
        gradient.record.byteLength,
      );
      const base = i * 12;
      recordFloats[base] = source.getUint32(0, true);
      recordFloats[base + 1] = source.getUint32(4, true);
      recordFloats[base + 2] = stopCount;
      recordFloats[base + 3] = gradient.stopCount;
      for (let component = 0; component < 8; component++) {
        recordFloats[base + 4 + component] = source.getFloat32(
          16 + component * 4,
          true,
        );
      }
      stopCount += gradient.stopCount;
    }
    uploadDataTexture(gl, gradientRecordsTexture, recordFloats, count * 3);
    if (stopCount === 0) return;
    const stopFloats = new Float32Array(stopCount * 8);
    let destination = 0;
    for (const gradient of gradients) {
      if (gradient === null) continue;
      const source = new DataView(
        gradient.stops.buffer,
        gradient.stops.byteOffset,
        gradient.stops.byteLength,
      );
      for (let stopIndex = 0; stopIndex < gradient.stopCount; stopIndex++) {
        const sourceBase = stopIndex * 48;
        const destinationBase = destination * 8;
        for (let component = 0; component < 4; component++) {
          stopFloats[destinationBase + component] = source.getFloat32(
            sourceBase + 32 + component * 4,
            true,
          );
        }
        stopFloats[destinationBase + 4] = source.getFloat32(
          sourceBase + 16,
          true,
        );
        destination++;
      }
    }
    uploadDataTexture(
      gl,
      gradientStopsTexture,
      stopFloats,
      stopCount * 2,
    );
  }

  function bindGradientTextures(programInfo) {
    gl.uniform1i(programInfo.uniforms.gradientRecordsTex, 6);
    gl.uniform1i(programInfo.uniforms.gradientStopsTex, 7);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, gradientRecordsTexture.texture);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, gradientStopsTexture.texture);
    gl.activeTexture(gl.TEXTURE0);
  }

  const pathMaskAtlasTexture = batch.pathMaskInUse
    ? pathAtlasTexture(svgPathAtlas)
    : placeholderTexture;

  // --- Frame start: clear (full) or clear dirty tiles (incremental) ---
  bindTarget(mainTarget);
  setStandardBlend();
  gl.disable(gl.SCISSOR_TEST);
  if (!incremental) {
    gl.clearColor(background.r, background.g, background.b, background.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  } else {
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(background.r, background.g, background.b, background.a);
    for (const { x, y, w, h } of options.damageRectangles) {
      gl.scissor(x, y, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // --- Composite helpers (ports of applyMatrixSegment / applyBlurSegment /
  // applyDropShadowSegment / compositeTexture) ---

  const ZERO_MATRIX_ROWS = new Float32Array(4);
  const ZERO_VEC4 = new Float32Array(4);

  // Set every composite uniform to its neutral value; call sites override
  // the few they need. srcTexture/backdropTexture/maskTexture are GL
  // textures; clipState may be null for "no clip".
  function setCompositeUniforms({
    opacity = 1,
    blendMode = BLEND_NORMAL,
    hasMatrix = 0,
    outputPremultiplied = 0,
    porterDuff = 0,
    matrixRows = null,
    pathMaskUniforms = null,
    hasMask = 0,
    clipState = EMPTY_CLIP_STATE,
    srcTexture,
    backdropTexture,
    maskTexture = null,
  }) {
    const composite = programs.composite;
    gl.useProgram(composite.program);
    setClipUniforms(composite, clipState);
    gl.uniform1f(composite.uniforms.opacity, opacity);
    gl.uniform1f(composite.uniforms.blendMode, blendMode);
    gl.uniform1f(composite.uniforms.hasMatrix, hasMatrix);
    gl.uniform1f(composite.uniforms.outputPremultiplied, outputPremultiplied);
    gl.uniform1f(composite.uniforms.porterDuff, porterDuff);
    gl.uniform4fv(
      composite.uniforms.matrixR,
      matrixRows ? matrixRows.subarray(0, 4) : ZERO_MATRIX_ROWS,
    );
    gl.uniform4fv(
      composite.uniforms.matrixG,
      matrixRows ? matrixRows.subarray(4, 8) : ZERO_MATRIX_ROWS,
    );
    gl.uniform4fv(
      composite.uniforms.matrixB,
      matrixRows ? matrixRows.subarray(8, 12) : ZERO_MATRIX_ROWS,
    );
    gl.uniform4fv(
      composite.uniforms.matrixA,
      matrixRows ? matrixRows.subarray(12, 16) : ZERO_MATRIX_ROWS,
    );
    gl.uniform4fv(
      composite.uniforms.matrixConst,
      matrixRows ? matrixRows.subarray(16, 20) : ZERO_MATRIX_ROWS,
    );
    const pathMask = pathMaskUniforms ?? [];
    gl.uniform4fv(
      composite.uniforms.pathMaskInfo,
      pathMask.length ? new Float32Array(pathMask.slice(0, 4)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.pathMaskRect,
      pathMask.length ? new Float32Array(pathMask.slice(4, 8)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.pathMaskBbox,
      pathMask.length ? new Float32Array(pathMask.slice(8, 12)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.pathMaskUv,
      pathMask.length ? new Float32Array(pathMask.slice(12, 16)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.pathMaskInvA,
      pathMask.length ? new Float32Array(pathMask.slice(16, 20)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.pathMaskTranslation,
      pathMask.length ? new Float32Array(pathMask.slice(20, 24)) : ZERO_VEC4,
    );
    gl.uniform4fv(
      composite.uniforms.maskInfo,
      new Float32Array([hasMask, 0, 0, 0]),
    );
    gl.uniform1i(composite.uniforms.srcTex, 0);
    gl.uniform1i(composite.uniforms.backdropTex, 1);
    gl.uniform1i(composite.uniforms.pathMaskTex, 2);
    gl.uniform1i(composite.uniforms.maskTex, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, backdropTexture ?? srcTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pathMaskAtlasTexture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture ?? pathMaskAtlasTexture);
    gl.activeTexture(gl.TEXTURE0);
  }

  function drawCompositeQuad() {
    uploadInstances(new Float32Array([0, 0, width, height]));
    drawInstanced(vertexArrays.composite, 1);
  }

  // Filter passes mirror the WebGPU backend's: each writes a target the
  // size of the one it reads (the frame, or the padded filter region of
  // applyFilterPasses), scissored to the part of that region a later pass
  // still reads. The scissor is set after the clear, which it would
  // otherwise bound.
  function enableFilterScissor(outputTarget, reachX, reachY) {
    const padX = (outputTarget.width - width) / 2;
    const padY = (outputTarget.height - height) / 2;
    const x = Math.max(0, padX - reachX);
    const y = Math.max(0, padY - reachY);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      x,
      y,
      Math.min(outputTarget.width, padX + width + reachX) - x,
      Math.min(outputTarget.height, padY + height + reachY) - y,
    );
  }

  function applyWindowPass(
    sourceTarget,
    outputWidth,
    outputHeight,
    shiftX,
    shiftY,
  ) {
    const outputTarget = makeCanvasTarget(outputWidth, outputHeight);
    bindTarget(outputTarget);
    gl.disable(gl.BLEND);
    const filterWindow = programs.filterWindow;
    gl.useProgram(filterWindow.program);
    gl.uniform2f(filterWindow.uniforms.shift, shiftX, shiftY);
    gl.uniform1i(filterWindow.uniforms.srcTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTarget.texture);
    gl.bindVertexArray(fullscreenVertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    setStandardBlend();
    return outputTarget;
  }

  function applyMatrixPass(sourceTarget, matrixRows, reachX, reachY) {
    const outputTarget = makeCanvasTarget(
      sourceTarget.width,
      sourceTarget.height,
    );
    clearTargetTransparent(outputTarget);
    enableFilterScissor(outputTarget, reachX, reachY);
    // Pure overwrite of associated color — no blending (see the WebGPU
    // matrixOverwritePipeline comment). The frame-sized composite quad
    // covers a padded target whole (see the WebGPU applyMatrixPass).
    gl.disable(gl.BLEND);
    setCompositeUniforms({
      hasMatrix: 1,
      outputPremultiplied: 1,
      matrixRows,
      srcTexture: sourceTarget.texture,
    });
    drawCompositeQuad();
    gl.disable(gl.SCISSOR_TEST);
    setStandardBlend();
    return outputTarget;
  }

  function applyBlurPass(sourceTarget, uniform, reachX, reachY) {
    gl.disable(gl.BLEND);
    const boxBlur = programs.boxBlur;
    gl.useProgram(boxBlur.program);
    gl.uniform2f(
      boxBlur.uniforms.resolution,
      sourceTarget.width,
      sourceTarget.height,
    );
    gl.uniform1i(boxBlur.uniforms.srcTex, 0);
    gl.bindVertexArray(fullscreenVertexArray);
    const passTarget = makeCanvasTarget(
      sourceTarget.width,
      sourceTarget.height,
    );
    bindTarget(passTarget);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    enableFilterScissor(passTarget, reachX, reachY);
    gl.uniform2f(boxBlur.uniforms.direction, uniform[1], uniform[2]);
    gl.uniform1f(boxBlur.uniforms.boxWidth, uniform[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTarget.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    setStandardBlend();
    return passTarget;
  }

  function applyDropShadowPass(
    blurredAlphaTarget,
    sourceTarget,
    uniform,
    reachX,
    reachY,
  ) {
    const outputTarget = makeCanvasTarget(
      sourceTarget.width,
      sourceTarget.height,
    );
    bindTarget(outputTarget);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    enableFilterScissor(outputTarget, reachX, reachY);
    gl.disable(gl.BLEND);
    const dropShadow = programs.dropShadow;
    gl.useProgram(dropShadow.program);
    gl.uniform2f(
      dropShadow.uniforms.resolution,
      sourceTarget.width,
      sourceTarget.height,
    );
    gl.uniform2f(
      dropShadow.uniforms.shadowOffset,
      uniform[0],
      uniform[1],
    );
    gl.uniform4f(
      dropShadow.uniforms.shadowColor,
      uniform[3],
      uniform[4],
      uniform[5],
      uniform[6],
    );
    gl.uniform1i(dropShadow.uniforms.blurredAlphaTex, 0);
    gl.uniform1i(dropShadow.uniforms.currentTex, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, blurredAlphaTarget.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sourceTarget.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(fullscreenVertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    setStandardBlend();
    return outputTarget;
  }

  // The filter region: see the WebGPU backend's applyFilterPasses.
  function applyFilterPasses(sourceTarget, passes) {
    const reaches = filterPassReaches(passes);
    const maxExtent = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const padX = filterRegionPadding(reaches[0], width, maxExtent);
    const padY = filterRegionPadding(reaches[1], height, maxExtent);
    const padded = padX > 0 || padY > 0;
    let target = padded
      ? applyWindowPass(
        sourceTarget,
        width + 2 * padX,
        height + 2 * padY,
        -padX,
        -padY,
      )
      : sourceTarget;
    let blurSource = target;
    let blurPassIndex = 0;
    for (let index = 0; index < passes.length; index++) {
      const pass = passes[index];
      const reachX = reaches[2 * index + 2];
      const reachY = reaches[2 * index + 3];
      if (pass.kind === RASTER_PLAN_PASS_MATRIX) {
        target = applyMatrixPass(target, pass.uniform, reachX, reachY);
        blurPassIndex = 0;
      } else if (
        pass.kind === RASTER_PLAN_PASS_BOX_BLUR_H ||
        pass.kind === RASTER_PLAN_PASS_BOX_BLUR_V
      ) {
        if (blurPassIndex === 0) blurSource = target;
        target = applyBlurPass(target, pass.uniform, reachX, reachY);
        blurPassIndex = (blurPassIndex + 1) % 6;
      } else if (pass.kind === RASTER_PLAN_PASS_DROP_SHADOW) {
        target = applyDropShadowPass(
          target,
          blurSource,
          pass.uniform,
          reachX,
          reachY,
        );
        blurPassIndex = 0;
      } else {
        throw new Error(`render: unknown native filter pass ${pass.kind}`);
      }
    }
    return padded
      ? applyWindowPass(target, width, height, padX, padY)
      : target;
  }

  function compositeTexture(sourceTarget, blendMode, backdropTarget) {
    bindTarget(currentTarget);
    setStandardBlend();
    setCompositeUniforms({
      blendMode,
      srcTexture: sourceTarget.texture,
      backdropTexture: backdropTarget ? backdropTarget.texture : null,
    });
    drawCompositeQuad();
  }

  // --- Second pass: execute batches ---
  for (let entryIndex = 0; entryIndex < batch.entryCount; entryIndex++) {
    // One draw per span of mergeable records; see createRasterPlanCursor
    // and design/interaction.md, "Invalidation split".
    const recordIndex = batch.selectEntry(entryIndex);
    switch (planReader.kind(recordIndex)) {
      case CMD_DAMAGE:
        currentDamage = { rects: batch.rects };
        continue;
      case CMD_RECT: {
      if (batch.instances.length === 0) break;
      bindTarget(currentTarget);
      setStandardBlend();
      const rect = programs.rect;
      gl.useProgram(rect.program);
      setClipUniforms(rect, batch.clipState);
      uploadGradients(batch.gradients, batch.count);
      bindGradientTextures(rect);
      uploadInstances(batch.instances);
      drawInstanced(vertexArrays.rect, batch.count, true);
        break;
      }
      case CMD_BOX_SHADOW: {
      if (batch.instances.length === 0) break;
      bindTarget(currentTarget);
      setStandardBlend();
      const boxShadow = programs.boxShadow;
      gl.useProgram(boxShadow.program);
      setClipUniforms(boxShadow, batch.clipState);
      uploadInstances(batch.instances);
      drawInstanced(vertexArrays.boxShadow, batch.count, true);
        break;
      }
      case CMD_TEXT: {
      if (batch.instances.length === 0) break;
      bindTarget(currentTarget);
      setStandardBlend();
      const glyphUploadStartedAt = glyphPerformance ? hostNow() : 0;
      const atlasTexture = cachedAtlasTexture(batch.atlas);
      if (glyphPerformance) {
        glyphPerformance.phaseMilliseconds.gpuUploadMilliseconds +=
          hostNow() - glyphUploadStartedAt;
      }
      const text = programs.text;
      gl.useProgram(text.program);
      setClipUniforms(text, batch.clipState);
      gl.uniform1f(text.uniforms.dilateLight, textThickening.lightInk);
      gl.uniform1f(text.uniforms.dilateDark, textThickening.darkInk);
      gl.uniform1i(text.uniforms.atlasTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      uploadInstances(batch.instances);
      drawInstanced(vertexArrays.text, batch.count, true);
        break;
      }
      case CMD_SVG_PATH: {
      if (batch.instances.length === 0) break;
      bindTarget(currentTarget);
      setStandardBlend();
      const atlasTexture = cachedAtlasTexture(batch.atlas);
      const svgPath = programs.svgPath;
      gl.useProgram(svgPath.program);
      setClipUniforms(svgPath, batch.clipState);
      gl.uniform1i(svgPath.uniforms.atlasTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      uploadGradients([batch.gradient], 1);
      bindGradientTextures(svgPath);
      uploadInstances(batch.instances);
      drawInstanced(vertexArrays.svgPath, batch.count, true);
        break;
      }
      case CMD_IMAGE: {
      if (batch.instances.length === 0) break;
      if (batch.image.kind === "color-glyph-cache-page") {
        // A color glyph cache page (src/color-glyph-cache.js): rendered
        // entries, premultiplied, each drawn texel for texel.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, batch.image.texture);
        bindTarget(currentTarget);
        setStandardBlend();
        const image = programs.image;
        gl.useProgram(image.program);
        setClipUniforms(image, batch.clipState);
        gl.uniform1i(image.uniforms.imageTex, 0);
        gl.uniform1f(image.uniforms.groupStraightColor, 1);
        uploadInstances(batch.instances);
        drawInstanced(vertexArrays.image, batch.count, true);
        break;
      }
      const { width: imageWidth, height: imageHeight, pixels } = batch.image;
      const mipLevelCount = 1 +
        Math.floor(Math.log2(Math.max(imageWidth, imageHeight)));
      let premultipliedPixels = premultipliedImagePixelCache.get(pixels);
      if (!premultipliedPixels) {
        premultipliedPixels = new Uint8Array(pixels.length);
        for (
          let pixelOffset = 0;
          pixelOffset < pixels.length;
          pixelOffset += 4
        ) {
          const alpha = pixels[pixelOffset + 3];
          premultipliedPixels[pixelOffset] = Math.round(
            pixels[pixelOffset] * alpha / 255,
          );
          premultipliedPixels[pixelOffset + 1] = Math.round(
            pixels[pixelOffset + 1] * alpha / 255,
          );
          premultipliedPixels[pixelOffset + 2] = Math.round(
            pixels[pixelOffset + 2] * alpha / 255,
          );
          premultipliedPixels[pixelOffset + 3] = alpha;
        }
        premultipliedImagePixelCache.set(pixels, premultipliedPixels);
      }
      const imageTexture = gl.createTexture();
      texturesToDestroy.push(imageTexture);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.texStorage2D(
        gl.TEXTURE_2D,
        mipLevelCount,
        gl.RGBA8,
        imageWidth,
        imageHeight,
      );
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        imageWidth,
        imageHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        premultipliedPixels,
      );
      // Mip chain: render each level from the previous with the shared
      // 2x2 box-filter downsample shader (same algorithm as the WebGPU
      // backend — parity over gl.generateMipmap, whose filter is
      // driver-defined). BASE/MAX_LEVEL pin the sampled level so
      // rendering INTO the next level is not a feedback loop.
      if (mipLevelCount > 1) {
        gl.disable(gl.BLEND);
        const downsample = programs.downsample;
        gl.useProgram(downsample.program);
        gl.uniform1i(downsample.uniforms.srcTex, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const mipFramebuffer = gl.createFramebuffer();
        framebuffersToDestroy.push(mipFramebuffer);
        gl.bindVertexArray(fullscreenVertexArray);
        for (let level = 1; level < mipLevelCount; level++) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 1);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
          gl.bindFramebuffer(gl.FRAMEBUFFER, mipFramebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            imageTexture,
            level,
          );
          const levelWidth = Math.max(1, imageWidth >> level);
          const levelHeight = Math.max(1, imageHeight >> level);
          gl.viewport(0, 0, levelWidth, levelHeight);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.bindVertexArray(null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MAX_LEVEL,
          mipLevelCount - 1,
        );
      }
      // Per-draw sampling state (mirrors the WebGPU per-draw samplers).
      const uvW = batch.instances[6], uvH = batch.instances[7];
      const needsWrap = uvW > 1 || uvH > 1;
      const wrapMode = needsWrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
      if (batch.pixelated) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.NEAREST_MIPMAP_NEAREST,
        );
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, 0);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, 0);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
      }
      bindTarget(currentTarget);
      setStandardBlend();
      const image = programs.image;
      gl.useProgram(image.program);
      setClipUniforms(image, batch.clipState);
      gl.uniform1i(image.uniforms.imageTex, 0);
      gl.uniform1f(image.uniforms.groupStraightColor, 0);
      uploadInstances(batch.instances);
      drawInstanced(vertexArrays.image, batch.count, true);
        break;
      }
      case CMD_PUSH_OPACITY: {
      const offscreenTarget = makeCanvasTarget();
      clearTargetTransparent(offscreenTarget);
      opacityStack.push({
        target: offscreenTarget,
        opacity: batch.opacity,
        blendMode: batch.blendMode,
        filterPasses: batch.filterPasses,
        clipState: batch.clipState,
        hasMask: batch.hasMask,
        previousTarget: currentTarget,
      });
      currentTarget = offscreenTarget;
        break;
      }
      case CMD_POP_OPACITY: {
      const entry = opacityStack.pop();
      currentTarget = entry.previousTarget;

      const filteredTarget = applyFilterPasses(
        entry.target,
        entry.filterPasses,
      );

      const nativeComposite = batch.nativeComposite;
      const blendMode = nativeComposite?.[1] ??
        entry.blendMode ?? BLEND_NORMAL;
      const clipState = nativeComposite
        ? {
          packedFloats: nativeComposite.subarray(54),
          entryCount: nativeComposite[3],
          entries: [],
        }
        : entry.clipState ?? EMPTY_CLIP_STATE;
      const pathMaskUniforms = nativeComposite
        ? nativeComposite.subarray(26, 50)
        : entry.pathMaskUniforms ?? null;
      const maskTarget = entry.hasMask ? maskStack.pop() : null;
      if (entry.hasMask && !maskTarget) {
        throw new Error(
          "render: CMD_PUSH_OPACITY carried the mask flag but no mask accumulator was pushed",
        );
      }
      let backdropTarget = null;
      if (batch.needsBackdropCopy || blendMode !== BLEND_NORMAL) {
        backdropTarget = snapshotTarget(currentTarget);
      }
      bindTarget(currentTarget);
      // A Porter-Duff operator (composite uniform float 7) writes its
      // result over the backdrop copy itself: blending off.
      const porterDuff = nativeComposite?.[5] ?? 0;
      if (porterDuff) gl.disable(gl.BLEND);
      else setStandardBlend();
      setCompositeUniforms({
        opacity: nativeComposite?.[0] ?? entry.opacity,
        blendMode,
        hasMatrix: nativeComposite?.[2] ?? 0,
        porterDuff,
        matrixRows: nativeComposite?.subarray(6, 26) ?? null,
        pathMaskUniforms,
        hasMask: nativeComposite?.[50] ?? (maskTarget ? 1 : 0),
        clipState,
        srcTexture: filteredTarget.texture,
        backdropTexture: backdropTarget ? backdropTarget.texture : null,
        maskTexture: maskTarget ? maskTarget.texture : null,
      });
      drawCompositeQuad();
      if (porterDuff) setStandardBlend();
        break;
      }
      case CMD_PUSH_BACKGROUND: {
      const accumulator = makeCanvasTarget();
      clearTargetTransparent(accumulator);
      backgroundStack.push({
        target: accumulator,
        previousTarget: currentTarget,
      });
      currentTarget = accumulator;
        break;
      }
      case CMD_POP_BACKGROUND: {
      const entry = backgroundStack.pop();
      if (!entry) {
        throw new Error("render: CMD_POP_BACKGROUND with no matching push");
      }
      currentTarget = entry.previousTarget;
      compositeTexture(entry.target, BLEND_NORMAL, null);
        break;
      }
      case CMD_PUSH_BLEND_LAYER: {
      const scratch = makeCanvasTarget();
      clearTargetTransparent(scratch);
      blendLayerStack.push({
        target: scratch,
        previousTarget: currentTarget,
        blendMode: batch.blendMode,
      });
      currentTarget = scratch;
        break;
      }
      case CMD_POP_BLEND_LAYER: {
      const layer = blendLayerStack.pop();
      if (!layer) {
        throw new Error("render: CMD_POP_BLEND_LAYER with no matching push");
      }
      currentTarget = layer.previousTarget;
      const backdropTarget = snapshotTarget(currentTarget);
      compositeTexture(layer.target, layer.blendMode, backdropTarget);
        break;
      }
      case CMD_PUSH_MASK: {
      const accumulator = makeCanvasTarget();
      clearTargetTransparent(accumulator);
      maskStack.push(accumulator);
        break;
      }
      case CMD_PUSH_MASK_LAYER: {
      const scratch = makeCanvasTarget();
      clearTargetTransparent(scratch);
      maskLayerStack.push({
        target: scratch,
        previousTarget: currentTarget,
        mode: batch.mode,
        composite: batch.composite,
      });
      currentTarget = scratch;
        break;
      }
      case CMD_POP_MASK_LAYER: {
      const layer = maskLayerStack.pop();
      currentTarget = layer.previousTarget;
      const accumulator = maskStack[maskStack.length - 1];
      bindTarget(accumulator);
      const [sourceFactor, destinationFactor] = maskCompositeBlendFactors(
        gl,
        layer.composite,
      );
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(sourceFactor, destinationFactor);
      const maskCombine = programs.maskCombine;
      gl.useProgram(maskCombine.program);
      gl.uniform2f(maskCombine.uniforms.resolution, width, height);
      gl.uniform1f(maskCombine.uniforms.maskMode, layer.mode);
      gl.uniform1i(maskCombine.uniforms.layerTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.target.texture);
      uploadInstances(new Float32Array([0, 0, width, height]));
      gl.bindVertexArray(vertexArrays.composite);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      gl.bindVertexArray(null);
      setStandardBlend();
        break;
      }
      case CMD_PUSH_BACKDROP_FILTER: {
      const snapshot = snapshotTarget(currentTarget);
      const filteredTarget = applyFilterPasses(
        snapshot,
        batch.filterPasses,
      );
      bindTarget(currentTarget);
      setStandardBlend();
      setCompositeUniforms({
        clipState: batch.ownClipState ?? EMPTY_CLIP_STATE,
        srcTexture: filteredTarget.texture,
      });
      drawCompositeQuad();
    }
      break;
    case CMD_PUSH_CLIP:
    case CMD_POP_CLIP:
    case CMD_POP_BACKDROP_FILTER:
    case CMD_SET_NODE:
    case CMD_SET_SCROLL:
      break;
    default:
      throw new Error(
        `render: unknown raster-plan record kind 0x${
          planReader.kind(recordIndex).toString(16)
        } at index ${recordIndex}`,
      );
  }
  }
  gl.disable(gl.SCISSOR_TEST);

  // --- Frame end: readback and cleanup ---
  function destroyFrameObjects() {
    for (const target of targetsToDestroy) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    for (const texture of texturesToDestroy) gl.deleteTexture(texture);
    for (const framebuffer of framebuffersToDestroy) {
      gl.deleteFramebuffer(framebuffer);
    }
  }

  if (readback !== "float32" && readback !== "none") {
    throw new Error(
      `render: readback must be "float32" or "none", got ${
        JSON.stringify(readback)
      }`,
    );
  }
  if (readback === "none") {
    destroyFrameObjects();
    context.incrementFrameCount();
    return {
      backend: "webgl2",
      gl,
      textureImage: {
        texture: mainTarget.texture,
        width,
        height,
        format: "rgba8unorm",
        colorEncoding: STANDARD_WORKING_COLOR_ENCODING,
        alphaMode: "premultiplied",
      },
      width,
      height,
      dirtyRects: [{ x: 0, y: 0, w: width, h: height }],
    };
  }

  const dirtyRects = options.rasterFrame.dirtyRectangles();

  // readPixels is synchronous; the y-flipped clip-space convention above
  // makes framebuffer row 0 the image's TOP row, so the returned rows are
  // already in top-to-bottom order.
  const bytes = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, mainTarget.framebuffer);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  destroyFrameObjects();
  context.incrementFrameCount();

  // The degraded backend renders eight-bit encoded sRGB, which IS
  // standard mode's working encoding - normalize into the shared float32
  // readback descriptor so both backends return one contract.
  const pixels = new Float32Array(width * height * 4);
  for (let i = 0; i < bytes.length; i++) pixels[i] = bytes[i] / 255;
  const result = {
    width,
    height,
    rowStride: width * 16,
    pixels,
    channelLayout: "rgba",
    sampleType: "float32",
    bitsPerSample: 32,
    colorEncoding: STANDARD_WORKING_COLOR_ENCODING,
    alphaMode: "premultiplied",
    metadata: {},
    dirtyRects,
  };
  if (!deferReadback) return result;
  // Deferred-readback shape parity with the WebGPU backend: the pixels
  // are already on the CPU, so collect()/finish() are immediate.
  return {
    deferred: true,
    collect: () => Promise.resolve({ finish: () => result }),
  };
}
