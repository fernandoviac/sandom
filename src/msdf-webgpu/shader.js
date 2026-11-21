// WGSL port of msdfgen 1.13's MSDF generation tail for the WebGPU glyph
// distance-field generator.
//
// The port covers exactly what runs after the prepared-geometry boundary
// (design/prepared-glyph-geometry.md):
//   pass_field:             generateMSDF's distance pass —
//                           MultiDistanceSelector + OverlappingContourCombiner
//                           (overlapSupport=true, the production config).
//   pass_protect:           error correction EDGE_PRIORITY protection —
//                           protectCorners + protectEdges.
//   pass_find_errors_base:  MSDFErrorCorrection::findErrors (stencil-only
//                           BaseArtifactClassifier).
//   pass_find_errors_shape: MSDFErrorCorrection::findErrors with the
//                           ShapeDistanceChecker (CHECK_DISTANCE_AT_EDGE runs
//                           it after protectAll, so every texel is protected).
//   pass_pack:              apply (median where ERROR) + the production u8
//                           quantization, row flip, and RGBA packing.
//
// Sources ported: core/edge-segments.cpp, core/edge-selectors.cpp,
// core/contour-combiners.cpp, core/equation-solver.cpp, core/msdfgen.cpp,
// core/MSDFErrorCorrection.cpp, core/msdf-error-correction.cpp.
//
// Deviations, all inherent to the mechanism and adjudicated by the
// comparison suite (never hidden):
// - f32 arithmetic instead of f64.
// - Every edge is evaluated at every texel: msdfgen's EdgeCache scanline
//   gating (isEdgeRelevant) is a sequential-scan optimization designed to
//   be exact, so dropping it changes work, not results.
// - Selector state is reset per texel instead of carried between texels
//   (same exactness argument: the carry is a pruning bound).

export const WORKGROUP_SIZE = 64;

// Stencil bits (MSDFErrorCorrection.h).
const STENCIL_ERROR = 1;
const STENCIL_PROTECTED = 2;

export const MSDF_COMPUTE_WGSL = /* wgsl */ `
const CACHED_CONTOURS: u32 = 16u;
const STENCIL_ERROR: u32 = ${STENCIL_ERROR}u;
const STENCIL_PROTECTED: u32 = ${STENCIL_PROTECTED}u;
const DISTANCE_DELTA_FACTOR: f32 = 1.001;
const ARTIFACT_T_EPSILON: f32 = 0.01;
const MIN_IMPROVE_RATIO: f32 = 1.11111111111111111;
const HUGE_DISTANCE: f32 = 1e30;
const PI: f32 = 3.14159265358979323846;

// GlyphRecord mirrors generator.js's packGlyphRecord — keep in sync.
struct GlyphRecord {
  contourStart: u32,
  contourCount: u32,
  width: u32,
  height: u32,
  fieldOffset: u32,   // texel index into field/stencil space
  outputOffset: u32,  // u32 index into output (RGBA per texel)
  flipY: u32,
  pad0: u32,
  scale: f32,
  translateX: f32,
  translateY: f32,
  invRangeWidth: f32, // 1 / (rangeUpper - rangeLower), shape units
  hSpan: f32,         // minDeviationRatio * invRangeWidth / scale
  dSpan: f32,         // hSpan * sqrt(2)
  hRadius: f32,       // 1.001 * invRangeWidth / scale
  dRadius: f32,       // hRadius * sqrt(2)
}

// Contour record: edgeStart (absolute), edgeCount, winding+1 (0|1|2), pad.
@group(0) @binding(0) var<storage, read> glyphs: array<GlyphRecord>;
@group(0) @binding(1) var<storage, read> contours: array<vec4<u32>>;
// Edge meta: x = type (1 linear, 2 quadratic, 3 cubic), y = color mask.
@group(0) @binding(2) var<storage, read> edgeMeta: array<vec2<u32>>;
// Edge points: 8 f32 per edge (x0,y0,x1,y1,x2,y2,x3,y3).
@group(0) @binding(3) var<storage, read> edgePoints: array<f32>;
// Per-texel glyph index for the whole batch.
@group(0) @binding(4) var<storage, read> texelGlyph: array<u32>;
// Raw field, 3 f32 per texel, bitmap orientation (row 0 = shape bottom).
@group(0) @binding(5) var<storage, read_write> field: array<f32>;
// Stencil, 1 u32 per texel.
@group(0) @binding(6) var<storage, read_write> stencil: array<u32>;
// Output, RGBA packed u32 per texel, output orientation (row 0 = top when
// flipY is set, matching the wasm generator's packing).
@group(0) @binding(7) var<storage, read_write> output: array<u32>;

struct Params {
  totalTexels: u32,
  // Linear index stride of one dispatch row: workgroupsPerRow * 64.
  // Dispatches are 2D so a batch is not capped by
  // maxComputeWorkgroupsPerDimension in x alone.
  dispatchRowStride: u32,
  pad1: u32,
  pad2: u32,
}
@group(0) @binding(8) var<uniform> params: Params;

fn linearIndex(gid: vec3<u32>) -> u32 {
  return gid.y * params.dispatchRowStride + gid.x;
}

// ---- arithmetic helpers (core/arithmetics.hpp) ----

fn med3(a: f32, b: f32, c: f32) -> f32 {
  return max(min(a, b), min(max(a, b), c));
}

fn crossp(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

fn nonZeroSign(n: f32) -> f32 {
  return select(-1.0, 1.0, n > 0.0);
}

// Vector2::normalize(allowZero=true): zero vector stays zero.
fn normalizeAllowZero(v: vec2f) -> vec2f {
  let len = length(v);
  if (len == 0.0) { return vec2f(0.0, 0.0); }
  return v / len;
}

// Vector2::normalize(allowZero=false): zero vector becomes (0, 1)
// (msdfgen Vector2.hpp returns Vector2(0, !polarity=... ) — for the
// default it yields (0, 1) via its zero branch).
fn normalizeStrict(v: vec2f) -> vec2f {
  let len = length(v);
  if (len == 0.0) { return vec2f(0.0, 1.0); }
  return v / len;
}

fn getOrthonormalFalse(v: vec2f) -> vec2f {
  // Vector2::getOrthonormal(polarity=false): (y, -x)/len; zero -> (0, -1).
  let len = length(v);
  if (len == 0.0) { return vec2f(0.0, -1.0); }
  return vec2f(v.y, -v.x) / len;
}

// ---- equation solver (core/equation-solver.cpp) ----

struct Roots {
  count: i32,
  x: vec3f,
}

fn solveQuadratic(a: f32, b: f32, c: f32) -> Roots {
  var r: Roots;
  r.count = 0;
  r.x = vec3f(0.0);
  if (a == 0.0 || abs(b) > 1e12 * abs(a)) {
    if (b == 0.0) {
      if (c == 0.0) { r.count = -1; }
      return r;
    }
    r.x.x = -c / b;
    r.count = 1;
    return r;
  }
  var dscr = b * b - 4.0 * a * c;
  if (dscr > 0.0) {
    dscr = sqrt(dscr);
    r.x.x = (-b + dscr) / (2.0 * a);
    r.x.y = (-b - dscr) / (2.0 * a);
    r.count = 2;
  } else if (dscr == 0.0) {
    r.x.x = -b / (2.0 * a);
    r.count = 1;
  }
  return r;
}

fn solveCubicNormed(aIn: f32, b: f32, c: f32) -> Roots {
  var r: Roots;
  r.x = vec3f(0.0);
  var a = aIn;
  let a2 = a * a;
  var q = (1.0 / 9.0) * (a2 - 3.0 * b);
  let rr = (1.0 / 54.0) * (a * (2.0 * a2 - 9.0 * b) + 27.0 * c);
  let r2 = rr * rr;
  let q3 = q * q * q;
  a *= 1.0 / 3.0;
  if (r2 < q3) {
    var t = rr / sqrt(q3);
    t = clamp(t, -1.0, 1.0);
    t = acos(t);
    q = -2.0 * sqrt(q);
    r.x.x = q * cos((1.0 / 3.0) * t) - a;
    r.x.y = q * cos((1.0 / 3.0) * (t + 2.0 * PI)) - a;
    r.x.z = q * cos((1.0 / 3.0) * (t - 2.0 * PI)) - a;
    r.count = 3;
    return r;
  }
  let u = select(-1.0, 1.0, rr < 0.0) * pow(abs(rr) + sqrt(r2 - q3), 1.0 / 3.0);
  let v = select(q / u, 0.0, u == 0.0);
  r.x.x = (u + v) - a;
  if (u == v || abs(u - v) < 1e-12 * abs(u + v)) {
    r.x.y = -0.5 * (u + v) - a;
    r.count = 2;
    return r;
  }
  r.count = 1;
  return r;
}

fn solveCubic(a: f32, b: f32, c: f32, d: f32) -> Roots {
  if (a != 0.0) {
    let bn = b / a;
    if (abs(bn) < 1e6) {
      return solveCubicNormed(bn, c / a, d / a);
    }
  }
  return solveQuadratic(b, c, d);
}

// ---- edge access ----

fn edgePt(edgeIndex: u32, i: u32) -> vec2f {
  let base = edgeIndex * 8u + i * 2u;
  return vec2f(edgePoints[base], edgePoints[base + 1u]);
}

fn edgeType(edgeIndex: u32) -> u32 { return edgeMeta[edgeIndex].x; }
fn edgeColor(edgeIndex: u32) -> u32 { return edgeMeta[edgeIndex].y; }

// EdgeSegment::point(0|1) — the segment endpoints.
fn edgeEndpoint(edgeIndex: u32, end: u32) -> vec2f {
  let t = edgeType(edgeIndex);
  if (end == 0u) { return edgePt(edgeIndex, 0u); }
  return edgePt(edgeIndex, t); // index 1, 2, or 3 = last point
}

// EdgeSegment::direction(param) at param 0 or 1 (edge-segments.cpp).
fn edgeDirectionAtEnd(edgeIndex: u32, end: u32) -> vec2f {
  let t = edgeType(edgeIndex);
  let p0 = edgePt(edgeIndex, 0u);
  let p1 = edgePt(edgeIndex, 1u);
  if (t == 1u) {
    return p1 - p0;
  }
  let p2 = edgePt(edgeIndex, 2u);
  if (t == 2u) {
    var tangent = p1 - p0;
    if (end == 1u) { tangent = p2 - p1; }
    if (all(tangent == vec2f(0.0))) { return p2 - p0; }
    return tangent;
  }
  let p3 = edgePt(edgeIndex, 3u);
  var tangent = p1 - p0;
  if (end == 1u) { tangent = p3 - p2; }
  if (all(tangent == vec2f(0.0))) {
    if (end == 0u) { return p2 - p0; }
    return p3 - p1;
  }
  return tangent;
}

// SignedDistance: x = distance, y = dot. Comparison: SignedDistance.hpp.
fn sdLess(a: vec2f, b: vec2f) -> bool {
  return abs(a.x) < abs(b.x) || (abs(a.x) == abs(b.x) && a.y < b.y);
}

struct EdgeDistance {
  sd: vec2f,
  param: f32,
}

// LinearSegment::signedDistance (edge-segments.cpp:173).
fn linearSignedDistance(p0: vec2f, p1: vec2f, origin: vec2f) -> EdgeDistance {
  var r: EdgeDistance;
  let aq = origin - p0;
  let ab = p1 - p0;
  r.param = dot(aq, ab) / dot(ab, ab);
  var eq = p1 - origin;
  if (r.param <= 0.5) { eq = p0 - origin; }
  let endpointDistance = length(eq);
  if (r.param > 0.0 && r.param < 1.0) {
    let orthoDistance = dot(getOrthonormalFalse(ab), aq);
    if (abs(orthoDistance) < endpointDistance) {
      r.sd = vec2f(orthoDistance, 0.0);
      return r;
    }
  }
  r.sd = vec2f(
    nonZeroSign(crossp(aq, ab)) * endpointDistance,
    abs(dot(normalizeStrict(ab), normalizeStrict(eq))),
  );
  return r;
}

// QuadraticSegment::signedDistance (edge-segments.cpp:187).
fn quadraticSignedDistance(p0: vec2f, p1: vec2f, p2: vec2f, origin: vec2f) -> EdgeDistance {
  var r: EdgeDistance;
  let qa = p0 - origin;
  let ab = p1 - p0;
  let br = p2 - p1 - ab;
  let a = dot(br, br);
  let b = 3.0 * dot(ab, br);
  let c = 2.0 * dot(ab, ab) + dot(qa, br);
  let d = dot(qa, ab);
  let roots = solveCubic(a, b, c, d);

  var epDir = ab; // direction(0) for a quadratic with distinct points
  // direction(0): mix(p1-p0, p2-p1, 0) = p1-p0; zero -> p2-p0.
  if (all(epDir == vec2f(0.0))) { epDir = p2 - p0; }
  var minDistance = nonZeroSign(crossp(epDir, qa)) * length(qa);
  r.param = -dot(qa, epDir) / dot(epDir, epDir);
  {
    var epDir1 = p2 - p1; // direction(1); zero -> p2-p0.
    if (all(epDir1 == vec2f(0.0))) { epDir1 = p2 - p0; }
    let distance = length(p2 - origin);
    if (distance < abs(minDistance)) {
      minDistance = nonZeroSign(crossp(epDir1, p2 - origin)) * distance;
      r.param = dot(origin - p1, epDir1) / dot(epDir1, epDir1);
    }
  }
  for (var i = 0; i < 3; i++) {
    if (i >= roots.count) { break; }
    let t = roots.x[i];
    if (t > 0.0 && t < 1.0) {
      let qe = qa + 2.0 * t * ab + t * t * br;
      let distance = length(qe);
      if (distance <= abs(minDistance)) {
        minDistance = nonZeroSign(crossp(ab + t * br, qe)) * distance;
        r.param = t;
      }
    }
  }

  if (r.param >= 0.0 && r.param <= 1.0) {
    r.sd = vec2f(minDistance, 0.0);
    return r;
  }
  var dirEnd = p1 - p0;
  if (all(dirEnd == vec2f(0.0))) { dirEnd = p2 - p0; }
  var endVec = qa;
  if (r.param >= 0.5) {
    dirEnd = p2 - p1;
    if (all(dirEnd == vec2f(0.0))) { dirEnd = p2 - p0; }
    endVec = p2 - origin;
  }
  r.sd = vec2f(minDistance, abs(dot(normalizeStrict(dirEnd), normalizeStrict(endVec))));
  return r;
}

// CubicSegment::direction(param) for arbitrary param (edge-segments.cpp:132).
fn cubicDirection(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, param: f32) -> vec2f {
  let tangent = mix(mix(p1 - p0, p2 - p1, param), mix(p2 - p1, p3 - p2, param), param);
  if (all(tangent == vec2f(0.0))) {
    if (param == 0.0) { return p2 - p0; }
    if (param == 1.0) { return p3 - p1; }
  }
  return tangent;
}

// CubicSegment::signedDistance (edge-segments.cpp:228).
// MSDFGEN_CUBIC_SEARCH_STARTS = 4, MSDFGEN_CUBIC_SEARCH_STEPS = 4.
fn cubicSignedDistance(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, origin: vec2f) -> EdgeDistance {
  var r: EdgeDistance;
  let qa = p0 - origin;
  let ab = p1 - p0;
  let br = p2 - p1 - ab;
  let as_ = (p3 - p2) - (p2 - p1) - br;

  var epDir = cubicDirection(p0, p1, p2, p3, 0.0);
  var minDistance = nonZeroSign(crossp(epDir, qa)) * length(qa);
  r.param = -dot(qa, epDir) / dot(epDir, epDir);
  {
    let epDir1 = cubicDirection(p0, p1, p2, p3, 1.0);
    let distance = length(p3 - origin);
    if (distance < abs(minDistance)) {
      minDistance = nonZeroSign(crossp(epDir1, p3 - origin)) * distance;
      r.param = dot(epDir1 - (p3 - origin), epDir1) / dot(epDir1, epDir1);
    }
  }
  for (var i = 0; i <= 4; i++) {
    var t = 0.25 * f32(i);
    var qe = qa + 3.0 * t * ab + 3.0 * t * t * br + t * t * t * as_;
    var d1 = 3.0 * ab + 6.0 * t * br + 3.0 * t * t * as_;
    var d2 = 6.0 * br + 6.0 * t * as_;
    var improvedT = t - dot(qe, d1) / (dot(d1, d1) + dot(qe, d2));
    if (improvedT > 0.0 && improvedT < 1.0) {
      var remainingSteps = 4;
      loop {
        t = improvedT;
        qe = qa + 3.0 * t * ab + 3.0 * t * t * br + t * t * t * as_;
        d1 = 3.0 * ab + 6.0 * t * br + 3.0 * t * t * as_;
        remainingSteps -= 1;
        if (remainingSteps == 0) { break; }
        d2 = 6.0 * br + 6.0 * t * as_;
        improvedT = t - dot(qe, d1) / (dot(d1, d1) + dot(qe, d2));
        if (!(improvedT > 0.0 && improvedT < 1.0)) { break; }
      }
      let distance = length(qe);
      if (distance < abs(minDistance)) {
        minDistance = nonZeroSign(crossp(d1, qe)) * distance;
        r.param = t;
      }
    }
  }

  if (r.param >= 0.0 && r.param <= 1.0) {
    r.sd = vec2f(minDistance, 0.0);
    return r;
  }
  if (r.param < 0.5) {
    let dir0 = cubicDirection(p0, p1, p2, p3, 0.0);
    r.sd = vec2f(minDistance, abs(dot(normalizeStrict(dir0), normalizeStrict(qa))));
  } else {
    let dir1 = cubicDirection(p0, p1, p2, p3, 1.0);
    r.sd = vec2f(minDistance, abs(dot(normalizeStrict(dir1), normalizeStrict(p3 - origin))));
  }
  return r;
}

fn edgeSignedDistance(edgeIndex: u32, origin: vec2f) -> EdgeDistance {
  let t = edgeType(edgeIndex);
  let p0 = edgePt(edgeIndex, 0u);
  let p1 = edgePt(edgeIndex, 1u);
  if (t == 1u) { return linearSignedDistance(p0, p1, origin); }
  let p2 = edgePt(edgeIndex, 2u);
  if (t == 2u) { return quadraticSignedDistance(p0, p1, p2, origin); }
  let p3 = edgePt(edgeIndex, 3u);
  return cubicSignedDistance(p0, p1, p2, p3, origin);
}

// EdgeSegment::distanceToPerpendicularDistance (edge-segments.cpp:28).
fn distanceToPerpendicularDistance(edgeIndex: u32, sdIn: vec2f, origin: vec2f, param: f32) -> vec2f {
  var sd = sdIn;
  if (param < 0.0) {
    let dir = normalizeStrict(edgeDirectionAtEnd(edgeIndex, 0u));
    let aq = origin - edgeEndpoint(edgeIndex, 0u);
    let ts = dot(aq, dir);
    if (ts < 0.0) {
      let perpendicularDistance = crossp(aq, dir);
      if (abs(perpendicularDistance) <= abs(sd.x)) {
        sd = vec2f(perpendicularDistance, 0.0);
      }
    }
  } else if (param > 1.0) {
    let dir = normalizeStrict(edgeDirectionAtEnd(edgeIndex, 1u));
    let bq = origin - edgeEndpoint(edgeIndex, 1u);
    let ts = dot(bq, dir);
    if (ts > 0.0) {
      let perpendicularDistance = crossp(bq, dir);
      if (abs(perpendicularDistance) <= abs(sd.x)) {
        sd = vec2f(perpendicularDistance, 0.0);
      }
    }
  }
  return sd;
}

// ---- perpendicular distance selector (core/edge-selectors.cpp) ----

struct PerpSel {
  minTrue: vec2f,     // SignedDistance
  nearEdgePlusOne: u32, // 0 = none
  nearParam: f32,
  minNeg: f32,
  minPos: f32,
}

fn perpSelInit() -> PerpSel {
  var s: PerpSel;
  s.minTrue = vec2f(-HUGE_DISTANCE, 0.0);
  s.nearEdgePlusOne = 0u;
  s.nearParam = 0.0;
  s.minNeg = -HUGE_DISTANCE;
  s.minPos = HUGE_DISTANCE;
  return s;
}

fn perpSelAddTrue(s: ptr<function, PerpSel>, edgeIndex: u32, sd: vec2f, param: f32) {
  if (sdLess(sd, (*s).minTrue)) {
    (*s).minTrue = sd;
    (*s).nearEdgePlusOne = edgeIndex + 1u;
    (*s).nearParam = param;
  }
}

fn perpSelAddPerp(s: ptr<function, PerpSel>, distance: f32) {
  if (distance <= 0.0 && distance > (*s).minNeg) { (*s).minNeg = distance; }
  if (distance >= 0.0 && distance < (*s).minPos) { (*s).minPos = distance; }
}

fn perpSelMerge(s: ptr<function, PerpSel>, other: PerpSel) {
  if (sdLess(other.minTrue, (*s).minTrue)) {
    (*s).minTrue = other.minTrue;
    (*s).nearEdgePlusOne = other.nearEdgePlusOne;
    (*s).nearParam = other.nearParam;
  }
  if (other.minNeg > (*s).minNeg) { (*s).minNeg = other.minNeg; }
  if (other.minPos < (*s).minPos) { (*s).minPos = other.minPos; }
}

fn perpSelComputeDistance(s: PerpSel, p: vec2f) -> f32 {
  var minDistance = s.minPos;
  if (s.minTrue.x < 0.0) { minDistance = s.minNeg; }
  if (s.nearEdgePlusOne != 0u) {
    let sd = distanceToPerpendicularDistance(s.nearEdgePlusOne - 1u, s.minTrue, p, s.nearParam);
    if (abs(sd.x) < abs(minDistance)) {
      minDistance = sd.x;
    }
  }
  return minDistance;
}

// getPerpendicularDistance (edge-selectors.cpp:42): returns the improved
// distance in .y when .x > 0.
fn getPerpendicularDistance(current: f32, ep: vec2f, edgeDir: vec2f) -> vec2f {
  let ts = dot(ep, edgeDir);
  if (ts > 0.0) {
    let perpendicularDistance = crossp(ep, edgeDir);
    if (abs(perpendicularDistance) < abs(current)) {
      return vec2f(1.0, perpendicularDistance);
    }
  }
  return vec2f(0.0, current);
}

// MultiDistanceSelector::addEdge without the EdgeCache gate
// (edge-selectors.cpp:174). prevIndex/nextIndex are the ring neighbors
// within the contour.
fn multiSelAddEdge(
  r: ptr<function, PerpSel>, g: ptr<function, PerpSel>, b: ptr<function, PerpSel>,
  p: vec2f, prevIndex: u32, edgeIndex: u32, nextIndex: u32,
) {
  let color = edgeColor(edgeIndex);
  let ed = edgeSignedDistance(edgeIndex, p);
  if ((color & 1u) != 0u) { perpSelAddTrue(r, edgeIndex, ed.sd, ed.param); }
  if ((color & 2u) != 0u) { perpSelAddTrue(g, edgeIndex, ed.sd, ed.param); }
  if ((color & 4u) != 0u) { perpSelAddTrue(b, edgeIndex, ed.sd, ed.param); }

  let ap = p - edgeEndpoint(edgeIndex, 0u);
  let bp = p - edgeEndpoint(edgeIndex, 1u);
  let aDir = normalizeAllowZero(edgeDirectionAtEnd(edgeIndex, 0u));
  let bDir = normalizeAllowZero(edgeDirectionAtEnd(edgeIndex, 1u));
  let prevDir = normalizeAllowZero(edgeDirectionAtEnd(prevIndex, 1u));
  let nextDir = normalizeAllowZero(edgeDirectionAtEnd(nextIndex, 0u));
  let add = dot(ap, normalizeAllowZero(prevDir + aDir));
  let bdd = -dot(bp, normalizeAllowZero(bDir + nextDir));
  if (add > 0.0) {
    let res = getPerpendicularDistance(ed.sd.x, ap, -aDir);
    if (res.x > 0.0) {
      let pd = -res.y;
      if ((color & 1u) != 0u) { perpSelAddPerp(r, pd); }
      if ((color & 2u) != 0u) { perpSelAddPerp(g, pd); }
      if ((color & 4u) != 0u) { perpSelAddPerp(b, pd); }
    }
  }
  if (bdd > 0.0) {
    let res = getPerpendicularDistance(ed.sd.x, bp, bDir);
    if (res.x > 0.0) {
      let pd = res.y;
      if ((color & 1u) != 0u) { perpSelAddPerp(r, pd); }
      if ((color & 2u) != 0u) { perpSelAddPerp(g, pd); }
      if ((color & 4u) != 0u) { perpSelAddPerp(b, pd); }
    }
  }
}

// PerpendicularDistanceSelector::addEdge (single channel, colors ignored).
fn perpSelAddEdgeAllColors(
  s: ptr<function, PerpSel>,
  p: vec2f, prevIndex: u32, edgeIndex: u32, nextIndex: u32,
) {
  let ed = edgeSignedDistance(edgeIndex, p);
  perpSelAddTrue(s, edgeIndex, ed.sd, ed.param);

  let ap = p - edgeEndpoint(edgeIndex, 0u);
  let bp = p - edgeEndpoint(edgeIndex, 1u);
  let aDir = normalizeAllowZero(edgeDirectionAtEnd(edgeIndex, 0u));
  let bDir = normalizeAllowZero(edgeDirectionAtEnd(edgeIndex, 1u));
  let prevDir = normalizeAllowZero(edgeDirectionAtEnd(prevIndex, 1u));
  let nextDir = normalizeAllowZero(edgeDirectionAtEnd(nextIndex, 0u));
  let add = dot(ap, normalizeAllowZero(prevDir + aDir));
  let bdd = -dot(bp, normalizeAllowZero(bDir + nextDir));
  if (add > 0.0) {
    let res = getPerpendicularDistance(ed.sd.x, ap, -aDir);
    if (res.x > 0.0) { perpSelAddPerp(s, -res.y); }
  }
  if (bdd > 0.0) {
    let res = getPerpendicularDistance(ed.sd.x, bp, bDir);
    if (res.x > 0.0) { perpSelAddPerp(s, res.y); }
  }
}

// ---- overlapping contour combiner (core/contour-combiners.cpp:78) ----

struct MultiState {
  r: PerpSel,
  g: PerpSel,
  b: PerpSel,
}

fn multiStateDistance(s: MultiState, p: vec2f) -> vec3f {
  return vec3f(
    perpSelComputeDistance(s.r, p),
    perpSelComputeDistance(s.g, p),
    perpSelComputeDistance(s.b, p),
  );
}

// Each channel merges in a variable of its own: a pointer argument to a
// member of dst needs WGSL's unrestricted_pointer_parameters, which
// naga's SPIR-V output does not implement (it panics on such a call).
fn multiStateMerge(dst: ptr<function, MultiState>, src: MultiState) {
  var r = (*dst).r;
  var g = (*dst).g;
  var b = (*dst).b;
  perpSelMerge(&r, src.r);
  perpSelMerge(&g, src.g);
  perpSelMerge(&b, src.b);
  (*dst).r = r;
  (*dst).g = g;
  (*dst).b = b;
}

fn resolveMulti(d: vec3f) -> f32 {
  return med3(d.x, d.y, d.z);
}

fn contourWinding(contourIndex: u32) -> i32 {
  return i32(contours[contourIndex].z) - 1;
}

// One contour's MSDF selector state at shape-space point p.
fn msdfContourState(contourIndex: u32, p: vec2f) -> MultiState {
  // WGSL forbids pointer arguments into one variable (Chrome rejects the
  // module: "invalid aliased pointer argument"): each channel selector
  // is a variable of its own until the contour's edges are added.
  var r = perpSelInit();
  var g = perpSelInit();
  var b = perpSelInit();
  let contour = contours[contourIndex];
  let edgeStart = contour.x;
  let edgeCount = contour.y;
  for (var e = 0u; e < edgeCount; e++) {
    let edgeIndex = edgeStart + e;
    let prevIndex = edgeStart + select(e - 1u, edgeCount - 1u, e == 0u);
    let nextIndex = edgeStart + select(e + 1u, 0u, e + 1u == edgeCount);
    multiSelAddEdge(&r, &g, &b, p, prevIndex, edgeIndex, nextIndex);
  }
  var st: MultiState;
  st.r = r;
  st.g = g;
  st.b = b;
  return st;
}

// Evaluates the production MSDF distance (MultiDistance, overlap support)
// at shape-space point p for glyph gRec. Ring evaluation per contour, then
// the exact OverlappingContourCombiner::distance() selection. A glyph may
// have any number of contours: the first loop merges each contour's state
// as it is computed and keeps the distances of the first CACHED_CONTOURS
// contours; the selection recomputes the distance of any later contour.
// One three-phase loop holds the only call to msdfContourState, so GPU
// compilers inline the contour's edge loop once: phase 0 merges every
// contour; phase 1 selects among the contours of the selected winding;
// phase 2 among the others, against the distance phase 1 selected.
fn msdfDistanceAt(glyphIndex: u32, p: vec2f) -> vec3f {
  let gRec = glyphs[glyphIndex];
  var contourDistances: array<vec3f, CACHED_CONTOURS>;
  let contourCount = gRec.contourCount;

  var shapeState: MultiState;
  shapeState.r = perpSelInit();
  shapeState.g = perpSelInit();
  shapeState.b = perpSelInit();
  var innerState = shapeState;
  var outerState = shapeState;
  var shapeDistance: vec3f;
  var distance: vec3f;
  var winding = 0;
  var opposite = 0.0;
  for (var phase = 0u; phase < 3u; phase++) {
    for (var ci = 0u; ci < contourCount; ci++) {
      let contourWindingValue = contourWinding(gRec.contourStart + ci);
      if (phase > 0u && (contourWindingValue == winding) != (phase == 1u)) { continue; }
      var st: MultiState;
      var cd: vec3f;
      if (phase == 0u || ci >= CACHED_CONTOURS) {
        st = msdfContourState(gRec.contourStart + ci, p);
        cd = multiStateDistance(st, p);
      } else {
        cd = contourDistances[ci];
      }
      let resolved = resolveMulti(cd);
      if (phase == 0u) {
        if (ci < CACHED_CONTOURS) { contourDistances[ci] = cd; }
        multiStateMerge(&shapeState, st);
        if (contourWindingValue > 0 && resolved >= 0.0) { multiStateMerge(&innerState, st); }
        if (contourWindingValue < 0 && resolved <= 0.0) { multiStateMerge(&outerState, st); }
      } else {
        let current = resolveMulti(distance);
        if (phase == 1u) {
          if (abs(resolved) < abs(opposite) && select((resolved < current), (resolved > current), (winding > 0))) {
            distance = cd;
          }
        } else if (resolved * current >= 0.0 && abs(resolved) < abs(current)) {
          distance = cd;
        }
      }
    }
    if (phase == 0u) {
      shapeDistance = multiStateDistance(shapeState, p);
      let innerDistance = multiStateDistance(innerState, p);
      let outerDistance = multiStateDistance(outerState, p);
      let innerScalar = resolveMulti(innerDistance);
      let outerScalar = resolveMulti(outerDistance);
      if (innerScalar >= 0.0 && abs(innerScalar) <= abs(outerScalar)) {
        distance = innerDistance;
        winding = 1;
        opposite = outerScalar;
      } else if (outerScalar <= 0.0 && abs(outerScalar) < abs(innerScalar)) {
        distance = outerDistance;
        winding = -1;
        opposite = innerScalar;
      } else {
        return shapeDistance;
      }
    }
  }
  if (resolveMulti(distance) == resolveMulti(shapeDistance)) {
    distance = shapeDistance;
  }
  return distance;
}

// One contour's single-channel selector state at shape-space point p.
fn psdfContourState(contourIndex: u32, p: vec2f) -> PerpSel {
  var st = perpSelInit();
  let contour = contours[contourIndex];
  let edgeStart = contour.x;
  let edgeCount = contour.y;
  for (var e = 0u; e < edgeCount; e++) {
    let edgeIndex = edgeStart + e;
    let prevIndex = edgeStart + select(e - 1u, edgeCount - 1u, e == 0u);
    let nextIndex = edgeStart + select(e + 1u, 0u, e + 1u == edgeCount);
    perpSelAddEdgeAllColors(&st, p, prevIndex, edgeIndex, nextIndex);
  }
  return st;
}

// Single-channel PSDF distance (PerpendicularDistanceSelector +
// OverlappingContourCombiner) for the shape distance checker, with the
// contour handling and the single call site of msdfDistanceAt.
fn psdfDistanceAt(glyphIndex: u32, p: vec2f) -> f32 {
  let gRec = glyphs[glyphIndex];
  var contourDistances: array<f32, CACHED_CONTOURS>;
  let contourCount = gRec.contourCount;

  var shapeState = perpSelInit();
  var innerState = perpSelInit();
  var outerState = perpSelInit();
  var distance = 0.0;
  var winding = 0;
  var opposite = 0.0;
  for (var phase = 0u; phase < 3u; phase++) {
    for (var ci = 0u; ci < contourCount; ci++) {
      let contourWindingValue = contourWinding(gRec.contourStart + ci);
      if (phase > 0u && (contourWindingValue == winding) != (phase == 1u)) { continue; }
      var st: PerpSel;
      var cd: f32;
      if (phase == 0u || ci >= CACHED_CONTOURS) {
        st = psdfContourState(gRec.contourStart + ci, p);
        cd = perpSelComputeDistance(st, p);
      } else {
        cd = contourDistances[ci];
      }
      if (phase == 0u) {
        if (ci < CACHED_CONTOURS) { contourDistances[ci] = cd; }
        perpSelMerge(&shapeState, st);
        if (contourWindingValue > 0 && cd >= 0.0) { perpSelMerge(&innerState, st); }
        if (contourWindingValue < 0 && cd <= 0.0) { perpSelMerge(&outerState, st); }
      } else if (phase == 1u) {
        if (abs(cd) < abs(opposite) && select((cd < distance), (cd > distance), (winding > 0))) { distance = cd; }
      } else if (cd * distance >= 0.0 && abs(cd) < abs(distance)) {
        distance = cd;
      }
    }
    if (phase == 0u) {
      let shapeDistance = perpSelComputeDistance(shapeState, p);
      let innerDistance = perpSelComputeDistance(innerState, p);
      let outerDistance = perpSelComputeDistance(outerState, p);
      if (innerDistance >= 0.0 && abs(innerDistance) <= abs(outerDistance)) {
        distance = innerDistance;
        winding = 1;
        opposite = outerDistance;
      } else if (outerDistance <= 0.0 && abs(outerDistance) < abs(innerDistance)) {
        distance = outerDistance;
        winding = -1;
        opposite = innerDistance;
      } else {
        return shapeDistance;
      }
    }
  }
  return distance;
}

// ---- texel addressing ----

struct TexelContext {
  glyphIndex: u32,
  x: u32,
  y: u32, // bitmap row (0 = shape bottom)
  local: u32,
}

fn texelContext(globalIndex: u32) -> TexelContext {
  var ctx: TexelContext;
  ctx.glyphIndex = texelGlyph[globalIndex];
  let gRec = glyphs[ctx.glyphIndex];
  ctx.local = globalIndex - gRec.fieldOffset;
  ctx.x = ctx.local % gRec.width;
  ctx.y = ctx.local / gRec.width;
  return ctx;
}

fn fieldTexel(gRec: GlyphRecord, x: u32, y: u32) -> vec3f {
  let base = (gRec.fieldOffset + y * gRec.width + x) * 3u;
  return vec3f(field[base], field[base + 1u], field[base + 2u]);
}

fn unproject(gRec: GlyphRecord, coord: vec2f) -> vec2f {
  return coord / gRec.scale - vec2f(gRec.translateX, gRec.translateY);
}

// DistanceMapping(Range(width)): value = distance / width + 0.5.
fn mapDistance(gRec: GlyphRecord, d: f32) -> f32 {
  return d * gRec.invRangeWidth + 0.5;
}

// ---- pass 1: distance field ----

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pass_field(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = linearIndex(gid);
  if (index >= params.totalTexels) { return; }
  let ctx = texelContext(index);
  let gRec = glyphs[ctx.glyphIndex];
  let p = unproject(gRec, vec2f(f32(ctx.x) + 0.5, f32(ctx.y) + 0.5));
  let d = msdfDistanceAt(ctx.glyphIndex, p);
  let base = index * 3u;
  field[base] = mapDistance(gRec, d.x);
  field[base + 1u] = mapDistance(gRec, d.y);
  field[base + 2u] = mapDistance(gRec, d.z);
  stencil[index] = 0u;
}

// ---- pass 2: protection (protectCorners + protectEdges) ----

// edgeBetweenTexelsChannel (MSDFErrorCorrection.cpp:154).
fn edgeBetweenTexelsChannel(a: vec3f, b: vec3f, channel: u32) -> bool {
  let t = (a[channel] - 0.5) / (a[channel] - b[channel]);
  if (t > 0.0 && t < 1.0) {
    let c = mix(a, b, t);
    return med3(c.x, c.y, c.z) == c[channel];
  }
  return false;
}

fn edgeBetweenTexels(a: vec3f, b: vec3f) -> u32 {
  var mask = 0u;
  if (edgeBetweenTexelsChannel(a, b, 0u)) { mask |= 1u; }
  if (edgeBetweenTexelsChannel(a, b, 1u)) { mask |= 2u; }
  if (edgeBetweenTexelsChannel(a, b, 2u)) { mask |= 4u; }
  return mask;
}

// protectExtremeChannels for MY texel (MSDFErrorCorrection.cpp:180).
fn extremeChannelsProtected(msd: vec3f, m: f32, mask: u32) -> bool {
  return ((mask & 1u) != 0u && msd.x != m) ||
    ((mask & 2u) != 0u && msd.y != m) ||
    ((mask & 4u) != 0u && msd.z != m);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pass_protect(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = linearIndex(gid);
  if (index >= params.totalTexels) { return; }
  let ctx = texelContext(index);
  let gRec = glyphs[ctx.glyphIndex];
  let x = i32(ctx.x);
  let y = i32(ctx.y);
  let w = i32(gRec.width);
  let h = i32(gRec.height);
  var protectedFlag = false;

  // protectCorners: for each color-change corner, the four texels around
  // the projected corner point are protected. Reformulated per texel.
  for (var ci = 0u; ci < gRec.contourCount && !protectedFlag; ci++) {
    let contour = contours[gRec.contourStart + ci];
    let edgeStart = contour.x;
    let edgeCount = contour.y;
    for (var e = 0u; e < edgeCount; e++) {
      let edgeIndex = edgeStart + e;
      let prevIndex = edgeStart + select(e - 1u, edgeCount - 1u, e == 0u);
      let commonColor = edgeColor(prevIndex) & edgeColor(edgeIndex);
      if ((commonColor & (commonColor - 1u)) == 0u) {
        let corner = edgeEndpoint(edgeIndex, 0u);
        let projected = gRec.scale * (corner + vec2f(gRec.translateX, gRec.translateY));
        let l = i32(floor(projected.x - 0.5));
        let b = i32(floor(projected.y - 0.5));
        if ((x == l || x == l + 1) && (y == b || y == b + 1)) {
          protectedFlag = true;
          break;
        }
      }
    }
  }

  // protectEdges: horizontal, vertical, and diagonal texel pairs. Each
  // pair marks BOTH endpoints; evaluate every pair this texel belongs to.
  let c = fieldTexel(gRec, ctx.x, ctx.y);
  let cm = med3(c.x, c.y, c.z);
  let radiusH = gRec.hRadius;
  let radiusD = gRec.dRadius;

  // Horizontal neighbors.
  if (!protectedFlag && x > 0) {
    let n = fieldTexel(gRec, ctx.x - 1u, ctx.y);
    let nm = med3(n.x, n.y, n.z);
    if (abs(nm - 0.5) + abs(cm - 0.5) < radiusH) {
      let mask = edgeBetweenTexels(n, c);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  if (!protectedFlag && x < w - 1) {
    let n = fieldTexel(gRec, ctx.x + 1u, ctx.y);
    let nm = med3(n.x, n.y, n.z);
    if (abs(cm - 0.5) + abs(nm - 0.5) < radiusH) {
      let mask = edgeBetweenTexels(c, n);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  // Vertical neighbors (same radius as horizontal: isotropic scale).
  if (!protectedFlag && y > 0) {
    let n = fieldTexel(gRec, ctx.x, ctx.y - 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(nm - 0.5) + abs(cm - 0.5) < radiusH) {
      let mask = edgeBetweenTexels(n, c);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  if (!protectedFlag && y < h - 1) {
    let n = fieldTexel(gRec, ctx.x, ctx.y + 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(cm - 0.5) + abs(nm - 0.5) < radiusH) {
      let mask = edgeBetweenTexels(c, n);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  // Diagonal pairs: (lb,rt) and (rb,lt) per 2x2 block; this texel takes
  // part in up to four blocks, in each as one diagonal endpoint.
  if (!protectedFlag && x > 0 && y > 0) {
    let n = fieldTexel(gRec, ctx.x - 1u, ctx.y - 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(nm - 0.5) + abs(cm - 0.5) < radiusD) {
      let mask = edgeBetweenTexels(n, c);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  if (!protectedFlag && x < w - 1 && y > 0) {
    let n = fieldTexel(gRec, ctx.x + 1u, ctx.y - 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(nm - 0.5) + abs(cm - 0.5) < radiusD) {
      let mask = edgeBetweenTexels(n, c);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  if (!protectedFlag && x > 0 && y < h - 1) {
    let n = fieldTexel(gRec, ctx.x - 1u, ctx.y + 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(nm - 0.5) + abs(cm - 0.5) < radiusD) {
      let mask = edgeBetweenTexels(n, c);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }
  if (!protectedFlag && x < w - 1 && y < h - 1) {
    let n = fieldTexel(gRec, ctx.x + 1u, ctx.y + 1u);
    let nm = med3(n.x, n.y, n.z);
    if (abs(cm - 0.5) + abs(nm - 0.5) < radiusD) {
      let mask = edgeBetweenTexels(c, n);
      protectedFlag = extremeChannelsProtected(c, cm, mask);
    }
  }

  if (protectedFlag) {
    stencil[index] = stencil[index] | STENCIL_PROTECTED;
  }
}

// ---- artifact classification (MSDFErrorCorrection.cpp) ----

fn interpolatedMedianLinear(a: vec3f, b: vec3f, t: f32) -> f32 {
  let c = mix(a, b, t);
  return med3(c.x, c.y, c.z);
}

fn interpolatedMedianBilinear(a: vec3f, l: vec3f, q: vec3f, t: f32) -> f32 {
  let c = t * (t * q + l) + a;
  return med3(c.x, c.y, c.z);
}

// BaseArtifactClassifier::rangeTest. Returns flag bits:
// 1 = candidate, 2 = artifact.
fn rangeTest(at: f32, bt: f32, xt: f32, am: f32, bm: f32, xm: f32, span: f32, isProtected: bool) -> u32 {
  if ((am > 0.5 && bm > 0.5 && xm <= 0.5) || (am < 0.5 && bm < 0.5 && xm >= 0.5) ||
      (!isProtected && med3(am, bm, xm) != xm)) {
    let axSpan = (xt - at) * span;
    let bxSpan = (bt - xt) * span;
    if (!(xm >= am - axSpan && xm <= am + axSpan && xm >= bm - bxSpan && xm <= bm + bxSpan)) {
      return 3u;
    }
    return 1u;
  }
  return 0u;
}

// ShapeDistanceChecker::ArtifactClassifier::evaluate's expensive branch
// (MSDFErrorCorrection.cpp:58). direction is the neighbor offset in texel
// space; msd is the current texel's channels; sdfCoord/shapeCoord are the
// current texel's centers in texel/shape space.
fn shapeCheckArtifact(
  glyphIndex: u32, msd: vec3f,
  sdfCoord: vec2f, shapeCoord: vec2f,
  direction: vec2f, t: f32,
) -> bool {
  let gRec = glyphs[glyphIndex];
  let tVector = t * direction;

  // interpolate(oldMSD, sdf, sdfCoord + tVector) — bitmap-interpolation.hpp.
  var pos = sdfCoord + tVector;
  pos.x = clamp(pos.x, 0.0, f32(gRec.width));
  pos.y = clamp(pos.y, 0.0, f32(gRec.height));
  pos -= vec2f(0.5);
  var l = i32(floor(pos.x));
  var b = i32(floor(pos.y));
  let lr = pos.x - f32(l);
  let bt = pos.y - f32(b);
  var r = l + 1;
  var t2 = b + 1;
  l = clamp(l, 0, i32(gRec.width) - 1);
  r = clamp(r, 0, i32(gRec.width) - 1);
  b = clamp(b, 0, i32(gRec.height) - 1);
  t2 = clamp(t2, 0, i32(gRec.height) - 1);
  let lb = fieldTexel(gRec, u32(l), u32(b));
  let rb = fieldTexel(gRec, u32(r), u32(b));
  let lt = fieldTexel(gRec, u32(l), u32(t2));
  let rt = fieldTexel(gRec, u32(r), u32(t2));
  let oldMSD = mix(mix(lb, rb, lr), mix(lt, rt, lr), bt);

  let aWeight = (1.0 - abs(tVector.x)) * (1.0 - abs(tVector.y));
  let aPSD = med3(msd.x, msd.y, msd.z);
  let newMSD = oldMSD + aWeight * (vec3f(aPSD) - msd);

  let oldPSD = med3(oldMSD.x, oldMSD.y, oldMSD.z);
  let newPSD = med3(newMSD.x, newMSD.y, newMSD.z);
  // texelSize = unprojectVector((1,1)) = 1/scale per axis.
  let refPSD = mapDistance(gRec, psdfDistanceAt(glyphIndex, shapeCoord + tVector / gRec.scale));
  return MIN_IMPROVE_RATIO * abs(newPSD - refPSD) < abs(oldPSD - refPSD);
}

// hasLinearArtifactInner, base classifier variant.
fn hasLinearArtifactInnerBase(am: f32, bm: f32, a: vec3f, b: vec3f, dA: f32, dB: f32, span: f32, isProtected: bool) -> bool {
  let t = dA / (dA - dB);
  if (t > ARTIFACT_T_EPSILON && t < 1.0 - ARTIFACT_T_EPSILON) {
    let xm = interpolatedMedianLinear(a, b, t);
    return (rangeTest(0.0, 1.0, t, am, bm, xm, span, isProtected) & 2u) != 0u;
  }
  return false;
}

fn hasLinearArtifactBase(am: f32, a: vec3f, b: vec3f, span: f32, isProtected: bool) -> bool {
  let bm = med3(b.x, b.y, b.z);
  return abs(am - 0.5) >= abs(bm - 0.5) && (
    hasLinearArtifactInnerBase(am, bm, a, b, a.y - a.x, b.y - b.x, span, isProtected) ||
    hasLinearArtifactInnerBase(am, bm, a, b, a.z - a.y, b.z - b.y, span, isProtected) ||
    hasLinearArtifactInnerBase(am, bm, a, b, a.x - a.z, b.x - b.z, span, isProtected)
  );
}

// hasDiagonalArtifactInner, base classifier variant.
fn hasDiagonalArtifactInnerBase(
  am: f32, dm: f32, a: vec3f, l: vec3f, q: vec3f,
  dA: f32, dBC: f32, dD: f32, tEx0: f32, tEx1: f32,
  span: f32, isProtected: bool,
) -> bool {
  let roots = solveQuadratic(dD - dBC + dA, dBC - dA - dA, dA);
  for (var i = 0; i < 2; i++) {
    if (i >= roots.count) { break; }
    let t = roots.x[i];
    if (t > ARTIFACT_T_EPSILON && t < 1.0 - ARTIFACT_T_EPSILON) {
      let xm = interpolatedMedianBilinear(a, l, q, t);
      var rangeFlags = rangeTest(0.0, 1.0, t, am, dm, xm, span, isProtected);
      if (tEx0 > 0.0 && tEx0 < 1.0) {
        var tEnd0 = 0.0; var tEnd1 = 1.0;
        var em0 = am; var em1 = dm;
        let em = interpolatedMedianBilinear(a, l, q, tEx0);
        if (tEx0 > t) { tEnd1 = tEx0; em1 = em; } else { tEnd0 = tEx0; em0 = em; }
        rangeFlags |= rangeTest(tEnd0, tEnd1, t, em0, em1, xm, span, isProtected);
      }
      if (tEx1 > 0.0 && tEx1 < 1.0) {
        var tEnd0 = 0.0; var tEnd1 = 1.0;
        var em0 = am; var em1 = dm;
        let em = interpolatedMedianBilinear(a, l, q, tEx1);
        if (tEx1 > t) { tEnd1 = tEx1; em1 = em; } else { tEnd0 = tEx1; em0 = em; }
        rangeFlags |= rangeTest(tEnd0, tEnd1, t, em0, em1, xm, span, isProtected);
      }
      if ((rangeFlags & 2u) != 0u) { return true; }
    }
  }
  return false;
}

fn hasDiagonalArtifactBase(am: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f, span: f32, isProtected: bool) -> bool {
  let dm = med3(d.x, d.y, d.z);
  if (abs(am - 0.5) >= abs(dm - 0.5)) {
    let abc = a - b - c;
    let l = -a - abc;
    let q = d + abc;
    let tEx = -0.5 * l / q;
    return (
      hasDiagonalArtifactInnerBase(am, dm, a, l, q, a.y - a.x, b.y - b.x + c.y - c.x, d.y - d.x, tEx.x, tEx.y, span, isProtected) ||
      hasDiagonalArtifactInnerBase(am, dm, a, l, q, a.z - a.y, b.z - b.y + c.z - c.y, d.z - d.y, tEx.y, tEx.z, span, isProtected) ||
      hasDiagonalArtifactInnerBase(am, dm, a, l, q, a.x - a.z, b.x - b.z + c.x - c.z, d.x - d.z, tEx.z, tEx.x, span, isProtected)
    );
  }
  return false;
}

// Shape-checked classification: the classifier finds up to two candidate
// positions per channel along a neighbor direction, with their rangeTest
// flags. The artifact flag decides at once; the candidate flag needs the
// expensive distance evaluation (evaluate at MSDFErrorCorrection.cpp:58).
// Every texel is protected in this pass (CHECK_DISTANCE_AT_EDGE runs
// protectAll first). pass_find_errors_shape calls shapeCheckArtifact from
// one site: GPU compilers inline every call, and one inlined copy of the
// glyph distance evaluation per neighbor, channel and root made this
// pipeline take seconds to compile.
struct ArtifactCandidates {
  t: array<f32, 2>,
  flags: array<u32, 2>,
  count: i32,
}

// hasLinearArtifactInner's candidate.
fn linearArtifactCandidates(am: f32, bm: f32, a: vec3f, b: vec3f, dA: f32, dB: f32, span: f32) -> ArtifactCandidates {
  var result: ArtifactCandidates;
  result.count = 0;
  let t = dA / (dA - dB);
  if (t > ARTIFACT_T_EPSILON && t < 1.0 - ARTIFACT_T_EPSILON) {
    let xm = interpolatedMedianLinear(a, b, t);
    result.t[0] = t;
    result.flags[0] = rangeTest(0.0, 1.0, t, am, bm, xm, span, true);
    result.count = 1;
  }
  return result;
}

// hasDiagonalArtifactInner's candidates.
fn diagonalArtifactCandidates(
  am: f32, dm: f32, a: vec3f, l: vec3f, q: vec3f,
  dA: f32, dBC: f32, dD: f32, tEx0: f32, tEx1: f32, span: f32,
) -> ArtifactCandidates {
  var result: ArtifactCandidates;
  result.count = 0;
  let roots = solveQuadratic(dD - dBC + dA, dBC - dA - dA, dA);
  for (var i = 0; i < 2; i++) {
    if (i >= roots.count) { break; }
    let t = roots.x[i];
    if (t > ARTIFACT_T_EPSILON && t < 1.0 - ARTIFACT_T_EPSILON) {
      let xm = interpolatedMedianBilinear(a, l, q, t);
      var rangeFlags = rangeTest(0.0, 1.0, t, am, dm, xm, span, true);
      if (tEx0 > 0.0 && tEx0 < 1.0) {
        var tEnd0 = 0.0; var tEnd1 = 1.0;
        var em0 = am; var em1 = dm;
        let em = interpolatedMedianBilinear(a, l, q, tEx0);
        if (tEx0 > t) { tEnd1 = tEx0; em1 = em; } else { tEnd0 = tEx0; em0 = em; }
        rangeFlags |= rangeTest(tEnd0, tEnd1, t, em0, em1, xm, span, true);
      }
      if (tEx1 > 0.0 && tEx1 < 1.0) {
        var tEnd0 = 0.0; var tEnd1 = 1.0;
        var em0 = am; var em1 = dm;
        let em = interpolatedMedianBilinear(a, l, q, tEx1);
        if (tEx1 > t) { tEnd1 = tEx1; em1 = em; } else { tEnd0 = tEx1; em0 = em; }
        rangeFlags |= rangeTest(tEnd0, tEnd1, t, em0, em1, xm, span, true);
      }
      result.t[result.count] = t;
      result.flags[result.count] = rangeFlags;
      result.count++;
    }
  }
  return result;
}

// ---- pass 3: findErrors, stencil-only classifier ----

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pass_find_errors_base(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = linearIndex(gid);
  if (index >= params.totalTexels) { return; }
  let ctx = texelContext(index);
  let gRec = glyphs[ctx.glyphIndex];
  let x = i32(ctx.x);
  let y = i32(ctx.y);
  let w = i32(gRec.width);
  let h = i32(gRec.height);
  let c = fieldTexel(gRec, ctx.x, ctx.y);
  let cm = med3(c.x, c.y, c.z);
  let isProtected = (stencil[index] & STENCIL_PROTECTED) != 0u;
  let hSpan = gRec.hSpan;
  let dSpan = gRec.dSpan;

  var l = vec3f(0.0); var b = vec3f(0.0); var r = vec3f(0.0); var t = vec3f(0.0);
  if (x > 0) { l = fieldTexel(gRec, ctx.x - 1u, ctx.y); }
  if (y > 0) { b = fieldTexel(gRec, ctx.x, ctx.y - 1u); }
  if (x < w - 1) { r = fieldTexel(gRec, ctx.x + 1u, ctx.y); }
  if (y < h - 1) { t = fieldTexel(gRec, ctx.x, ctx.y + 1u); }

  let hasError =
    (x > 0 && hasLinearArtifactBase(cm, c, l, hSpan, isProtected)) ||
    (y > 0 && hasLinearArtifactBase(cm, c, b, hSpan, isProtected)) ||
    (x < w - 1 && hasLinearArtifactBase(cm, c, r, hSpan, isProtected)) ||
    (y < h - 1 && hasLinearArtifactBase(cm, c, t, hSpan, isProtected)) ||
    (x > 0 && y > 0 && hasDiagonalArtifactBase(cm, c, l, b, fieldTexel(gRec, ctx.x - 1u, ctx.y - 1u), dSpan, isProtected)) ||
    (x < w - 1 && y > 0 && hasDiagonalArtifactBase(cm, c, r, b, fieldTexel(gRec, ctx.x + 1u, ctx.y - 1u), dSpan, isProtected)) ||
    (x > 0 && y < h - 1 && hasDiagonalArtifactBase(cm, c, l, t, fieldTexel(gRec, ctx.x - 1u, ctx.y + 1u), dSpan, isProtected)) ||
    (x < w - 1 && y < h - 1 && hasDiagonalArtifactBase(cm, c, r, t, fieldTexel(gRec, ctx.x + 1u, ctx.y + 1u), dSpan, isProtected));

  if (hasError) {
    stencil[index] = stencil[index] | STENCIL_ERROR;
  }
}

// ---- pass 4: findErrors with the shape distance checker ----

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pass_find_errors_shape(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = linearIndex(gid);
  if (index >= params.totalTexels) { return; }
  if ((stencil[index] & STENCIL_ERROR) != 0u) { return; }
  let ctx = texelContext(index);
  let gRec = glyphs[ctx.glyphIndex];
  let x = i32(ctx.x);
  let y = i32(ctx.y);
  let w = i32(gRec.width);
  let h = i32(gRec.height);
  let c = fieldTexel(gRec, ctx.x, ctx.y);
  let cm = med3(c.x, c.y, c.z);
  let hSpan = gRec.hSpan;
  let dSpan = gRec.dSpan;
  let sdfCoord = vec2f(f32(ctx.x) + 0.5, f32(ctx.y) + 0.5);
  let shapeCoord = unproject(gRec, sdfCoord);
  let gi = ctx.glyphIndex;

  // Neighbors: left, bottom, right, top, then the four diagonals.
  let offsets = array<vec2i, 8>(vec2i(-1, 0), vec2i(0, -1), vec2i(1, 0), vec2i(0, 1),
    vec2i(-1, -1), vec2i(1, -1), vec2i(-1, 1), vec2i(1, 1));
  var hasError = false;
  for (var neighbor = 0u; neighbor < 8u && !hasError; neighbor++) {
    let offset = offsets[neighbor];
    let nx = x + offset.x;
    let ny = y + offset.y;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) { continue; }
    let diagonal = neighbor >= 4u;
    // a is this texel; b the horizontal neighbor; c the vertical one; d
    // the diagonal one. A linear direction uses a and b only.
    let b = fieldTexel(gRec, u32(nx), select(ctx.y, u32(ny), !diagonal));
    let cVertical = fieldTexel(gRec, ctx.x, u32(ny));
    let d = fieldTexel(gRec, u32(nx), u32(ny));
    let far = select(b, d, diagonal);
    let farMedian = med3(far.x, far.y, far.z);
    if (abs(cm - 0.5) < abs(farMedian - 0.5)) { continue; }
    let abc = c - b - cVertical;
    let l = -c - abc;
    let q = d + abc;
    let tEx = -0.5 * l / q;
    let direction = vec2f(offset);
    for (var channel = 0u; channel < 3u && !hasError; channel++) {
      let i0 = channel;
      let i1 = (channel + 1u) % 3u;
      var candidates: ArtifactCandidates;
      if (diagonal) {
        candidates = diagonalArtifactCandidates(cm, farMedian, c, l, q, c[i1] - c[i0],
          b[i1] - b[i0] + cVertical[i1] - cVertical[i0], d[i1] - d[i0], tEx[i0], tEx[i1], dSpan);
      } else {
        candidates = linearArtifactCandidates(cm, farMedian, c, b, c[i1] - c[i0], b[i1] - b[i0], hSpan);
      }
      for (var candidate = 0; candidate < candidates.count && !hasError; candidate++) {
        let flags = candidates.flags[candidate];
        if ((flags & 1u) != 0u) {
          hasError = (flags & 2u) != 0u ||
            shapeCheckArtifact(gi, c, sdfCoord, shapeCoord, direction, candidates.t[candidate]);
        }
      }
    }
  }

  if (hasError) {
    stencil[index] = stencil[index] | STENCIL_ERROR;
  }
}

// ---- pass 5: apply + quantize + pack ----

@compute @workgroup_size(${WORKGROUP_SIZE})
fn pass_pack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = linearIndex(gid);
  if (index >= params.totalTexels) { return; }
  let ctx = texelContext(index);
  let gRec = glyphs[ctx.glyphIndex];
  var texel = fieldTexel(gRec, ctx.x, ctx.y);
  if ((stencil[index] & STENCIL_ERROR) != 0u) {
    let m = med3(texel.x, texel.y, texel.z);
    texel = vec3f(m);
  }
  // Production quantization (glyph_msdf.cpp packing loop): clamp to [0,1],
  // *255 + 0.5, truncate.
  let q = vec3<u32>(clamp(texel, vec3f(0.0), vec3f(1.0)) * 255.0 + vec3f(0.5));
  var outRow = ctx.y;
  if (gRec.flipY != 0u) { outRow = gRec.height - 1u - ctx.y; }
  let outIndex = gRec.outputOffset + outRow * gRec.width + ctx.x;
  output[outIndex] = q.x | (q.y << 8u) | (q.z << 16u) | (255u << 24u);
}
`;

// Copies the packed per-glyph output buffer into the canonical production
// atlas texture. One placement record corresponds to one prepared glyph:
// source texel offset, width, height, destination x, destination y. The
// destination is rgba8unorm so this pass is the production field-to-texture
// boundary; no GPU-to-CPU copy exists on this path.
export const MSDF_ATLAS_POPULATION_WGSL = /* wgsl */ `
struct Placement {
  sourceOffset: u32,
  width: u32,
  height: u32,
  destinationX: u32,
  destinationY: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

struct PopulationParams {
  placementCount: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

@group(0) @binding(0) var<storage, read> packedOutput: array<u32>;
@group(0) @binding(1) var<storage, read> placements: array<Placement>;
@group(0) @binding(2) var destination: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> populationParams: PopulationParams;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn populate_atlas(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let placementIndex = invocation.y;
  if (placementIndex >= populationParams.placementCount) { return; }
  let placement = placements[placementIndex];
  let localIndex = invocation.x;
  let texelCount = placement.width * placement.height;
  if (localIndex >= texelCount) { return; }
  let x = localIndex % placement.width;
  let y = localIndex / placement.width;
  let packed = packedOutput[placement.sourceOffset + localIndex];
  textureStore(
    destination,
    vec2u(placement.destinationX + x, placement.destinationY + y),
    vec4f(
      f32(packed & 255u) / 255.0,
      f32((packed >> 8u) & 255u) / 255.0,
      f32((packed >> 16u) & 255u) / 255.0,
      1.0,
    ),
  );
}
`;
