import { quantizeWorkingPixels } from "./color-transform.js";
import { instantiate } from "../wasm/pixel-diff-binary.js";

// The classification, verdict and arc check run in core/engine/pixel-diff.wat;
// ray directions use the host's Math.cos and Math.sin.
let module = null;
function diffModule() {
  module ??= instantiate({ math: { cos: Math.cos, sin: Math.sin } }).exports;
  return module;
}

function moduleText(exports, length) {
  return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.text_address(), length));
}

// Copies the two pixel buffers (and optional f64 records after them, at an
// eight-byte boundary) into the module's input buffer.
function writePixels(exports, sandom, chrome, records = null) {
  const recordOffset = Math.ceil((sandom.length + chrome.length) / 8) * 8;
  const pointer = exports.input_buffer(recordOffset + (records === null ? 0 : records.byteLength));
  new Uint8Array(exports.memory.buffer, pointer, sandom.length).set(sandom);
  new Uint8Array(exports.memory.buffer, pointer + sandom.length, chrome.length).set(chrome);
  if (records !== null) new Float64Array(exports.memory.buffer, pointer + recordOffset, records.length).set(records);
}

// Canonical RGBA pixel comparison — the SINGLE source of truth for both the
// browser gallery (examples/layout-gallery.js) and the headless parity test
// (test/layout-flow/layout_pixel_test.js). Both import classifyDiff from here so the test
// can never pass while the gallery shows a difference, or vice versa.
//
// Why classify instead of just count: two correct raster engines never agree
// pixel-for-pixel on EDGES — each anti-aliases its own way, so an edge pixel is
// blended slightly differently (empirically Δ ≤ ~40 per channel). That is NOT a
// bug. A STRUCTURAL difference — wrong fill colour, wrong paint order, a missing
// or misplaced box — flips whole regions to a different colour entirely (large
// Δ). So we bucket each pixel by per-channel delta magnitude:
//   Δ ≤ AA_TOL          → identical (same pixel)
//   AA_TOL < Δ < STRUCT → edge anti-aliasing, expected
//   Δ ≥ STRUCT          → structural, a real difference
// Parity passes iff structuralCount === 0.
//
// Text is out of scope here: glyph pixels take the text truth check
// (src/output/text-ink-envelope.js and text-position-reference.js), which
// compares Sandom's glyph ink with the font's exact outline.
//
// This module is pure (no DOM, no Deno APIs): it operates on two RGBA byte
// arrays of equal length. The browser supplies pixels via canvas getImageData;
// the test supplies the very same browser-captured pixels (it asks the page to
// run its rasterizer, so the test uses the real browser raster, not a Deno
// reimplementation). Identical inputs + identical classifier ⇒ identical verdict.

// Thresholds. Tuned from measurement, re-checked 2026-07-06 after two
// Slice P1.5 follow-up fixes to rasterize.js's fragmentMain: (1) tightening
// the fill/border SDF antialiasing band, and (2) adding antialiasing to the
// overflow-clip discard, which was previously a hard binary cutoff with NO
// blending at all (a separate bug from the band-width one — see
// design/layout-debugging.md). Both measured directly against
// Chrome: the `border` scene (straight/inner SDF edge) improved maxDelta
// 56→28; the `overflow-cards` scene (rounded CLIP corner, the case the old
// STRUCT=60 was actually sized for) improved maxDelta 98→14, dropping to 0
// structural pixels with no exemption needed at all. The remaining worst
// case is `transform-cards` (rotated/scaled fill edge, a different code
// path, out of scope here) at maxDelta 104-112 — but those pixels are
// covered by the geometric TRANSFORM_EDGE_AA_TOLERANCE exemption, not by
// STRUCT, so they don't constrain this threshold. With the clip fix in
// place, the honest new ceiling for "expected AA disagreement, no
// geometric exemption" is Δ28 (border); STRUCT=40 sits safely above that
// with margin and well below the wrong-fill floor (Δ100+).
export const AA_TOL = 12;
export const STRUCT = 40;
// A real structural difference (wrong fill / paint order / missing box) is a
// REGION — hundreds to thousands of contiguous pixels (the negative control is
// 40112). A handful of scattered pixels at box CORNERS, where two rasterizers'
// corner-coverage anti-aliasing disagrees by just over STRUCT, is not a bug.
// So the pass verdict tolerates up to STRUCT_FLOOR isolated structural pixels;
// anything above that is a genuine divergence. (Corner AA empirically ≤ ~8 px
// per scene; real bugs are 100×+ that.)
export const STRUCT_FLOOR = 24;

// Image-scene structural floor (Slice P5b): bilinear-resampled photo
// content — fill/contain/cover/scale-down all involve sandom's GPU
// sampler and Chrome's Canvas2D/CSS image scaler each rounding a
// resampled pixel slightly differently, which STRUCT_FLOOR's 24 was
// never sized for (it was measured against SDF corner-AA, a completely
// different mechanism). Measured directly (examples/object-fit-demo.js's
// wide-box photo scene, 620x160, 5 modes): 62 scattered structural px,
// maxΔ 47, ALL four resampled modes (fill/contain/cover/scale-down)
// affected, the ONE mode with zero resampling (object-fit:none, a 1:1
// pixel crop with no scaling) measuring EXACTLY 0 — proof this is a
// resampling artifact, not a real rendering bug (confirmed via the
// project's own load-bearing-proof convention: forcing this floor back
// to STRUCT_FLOOR reproduces the exact 62-pixel failure; raising it
// clears it with real headroom, not a blind bump). A true bug (wrong
// crop, wrong position, wrong color) fails by hundreds to thousands of
// contiguous pixels, same as STRUCT_FLOOR's own reasoning — this floor
// is sized with margin above the measured 62, not tuned to just clear it.
export const IMAGE_STRUCT_FLOOR = 100;

// Compare two equal-length RGBA buffers. Returns counts + a visual diff image
// (gray = identical, blue = edge-AA, magenta = structural). `aa`/`struct` let a
// caller override thresholds but default to the shared constants so both sides
// match by default.
export function classifyDiff(
  rawSandom,
  chrome,
  width,
  height,
  { aa = AA_TOL, struct = STRUCT, structFloor = STRUCT_FLOOR } = {},
) {
  // The sandom side may be a float32 working-encoding readback; comparing
  // against an eight-bit oracle is a byte-domain operation, so quantize
  // at this sink, explicitly.
  const sandom = quantizeWorkingPixels(rawSandom);
  const exports = diffModule();
  const mismatch = exports.length_check(sandom.length, chrome.length);
  if (mismatch !== 0) throw new Error(moduleText(exports, mismatch));
  const total = width * height;
  writePixels(exports, sandom, chrome);
  exports.classify(total, sandom.length, aa, struct, structFloor);
  return {
    width,
    height,
    total,
    identical: exports.identical(),
    edgeAA: exports.edge(),
    structural: exports.structural(),
    maxDelta: exports.max_delta(),
    diffImage: new Uint8Array(exports.memory.buffer, exports.diff_image_address(), sandom.length).slice(),
    ok: exports.ok() === 1,
  };
}

// Compares two read-back rasters ({ width, height, pixels, deviceScale,
// colorEncoding, alphaMode }) as facts: pixel counts by delta class, the
// largest channel delta, and the diff image. It gives no verdict. Rasters of
// another size, device scale, color encoding, or alpha mode throw.
export function compareRasters(left, right) {
  const exports = diffModule();
  const sameEncoding = left.colorEncoding === right.colorEncoding;
  const sameAlpha = left.alphaMode === right.alphaMode;
  const failure = exports.raster_compare_check(
    left.width, left.height, right.width, right.height,
    left.deviceScale, right.deviceScale, sameEncoding ? 1 : 0, sameAlpha ? 1 : 0,
  );
  if (failure !== 0) {
    // An encoding or alpha message ends with "received "; the names follow.
    const message = moduleText(exports, failure);
    const names = !message.endsWith("received ")
      ? ""
      : sameEncoding
      ? `${left.alphaMode} and ${right.alphaMode}.`
      : `${left.colorEncoding} and ${right.colorEncoding}.`;
    throw new RangeError(message + names);
  }
  const { ok: _verdict, ...facts } = classifyDiff(left.pixels, quantizeWorkingPixels(right.pixels), left.width, left.height);
  return facts;
}

// One-line verdict — same wording the gallery badge uses.
export function diffSummary(r) {
  const exports = diffModule();
  return moduleText(exports, exports.summary(r.ok ? 1 : 0, r.structural, r.maxDelta, r.edgeAA));
}

// =========================================================================
// Geometric arc-crossing check (Slice P1.5)
// =========================================================================
//
// classifyDiff is color-delta only, and that gives it a proven blind spot:
// a wrong CONTOUR whose two sides happen to be similar colors classifies as
// "edge AA" no matter how the thresholds are tuned. Proven directly: with
// the deviceScale-2 borderRadius scaling bug re-introduced (a visibly SQUARE
// corner on a card specified round), classifyDiff still reported 0
// structural pixels — the square corner's fringe pixel vs Chrome's white
// differed by Δ35, comfortably sub-STRUCT. See
// design/layout-debugging.md.
//
// This check is shape-aware instead: for each EXPECTED rounded-corner arc
// (center, radius, angular quadrant — computed by the caller from the scene
// spec + engine boxes), cast radial rays outward through the contour and
// find where the actual color transition sits in each raster, by
// linear-interpolating the crossing of the inside→outside color midpoint
// between sub-pixel bilinear samples. Chrome is the ground truth: a ray
// only counts when Chrome shows a clean, well-placed edge along it (this
// naturally skips corners that are occluded or blend into same-colored
// background in BOTH images — no scene-specific knowledge needed). The
// verdict compares CROSSING DISTANCES, not colors, so a square corner where
// a round one belongs diverges by ~0.41r at the 45° ray regardless of how
// gentle the color difference is.
//
// Angle convention: screen coordinates, y down — angle 0 points +x, π/2
// points +y (downward). A top-left corner's outward quadrant is [π, 1.5π].
//
// core/engine/pixel-diff.wat samples every 0.25 px along each ray, measures a
// ray only when Chrome's inside and outside reference colours differ by at
// least 32 on some channel (otherwise the ground truth shows no edge), and
// only when Chrome's own crossing lies within 2.5 px of the expected radius
// (otherwise another feature crossed the ray). Sandom's crossing is not
// gated: a wrong Sandom contour is what the check measures.

// Compare the two rasters' actual contour positions along every expected
// arc. `arcs`: [{cx, cy, r, a0, a1, label}] in the rasters' own pixel space.
// Returns { measured, skipped, maxDivergence, worst } — maxDivergence is in
// pixels, the largest |sandomCrossing - chromeCrossing| over all measured
// rays. A sandom contour that never crosses inside the scan window reports
// the window edge (a LOWER BOUND on its divergence), so a missing contour
// still fails loudly rather than skipping.
export function compareArcCrossings(rawSandom, chrome, width, height, arcs) {
  const sandom = quantizeWorkingPixels(rawSandom);
  const exports = diffModule();
  writePixels(exports, sandom, chrome, new Float64Array(arcs.flatMap(({ cx, cy, r, a0, a1 }) => [cx, cy, r, a0, a1])));
  exports.arcs(sandom.length, width, height, arcs.length);
  const worstArc = exports.worst_arc();
  return {
    measured: exports.measured(),
    skipped: exports.skipped(),
    maxDivergence: exports.max_divergence(),
    worst: worstArc < 0 ? null : {
      label: arcs[worstArc].label,
      angleDeg: exports.worst_angle(),
      chromeT: exports.worst_chrome(),
      sandomT: exports.worst_sandom(),
    },
  };
}
