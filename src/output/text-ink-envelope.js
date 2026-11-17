// The glyph-ink check (design/parity-methodology.md, "Text truth checks", check 1):
// Sandom's pixels against the truth image, with every approved difference
// named by its mechanism.
//
// The truth image is Chrome's rendering of the page with its text removed
// (TEXT_FREE_CSS), with the exact outline coverage of every text command
// composited over it in the command's color. Chrome supplies everything
// the page draws except glyph ink; the font supplies the glyphs.
//
// Each mechanism is a measured freedom of Sandom's glyph raster around the
// outline. It is a function of the outline, size and position only and
// reads no pixels, so a disparity cannot widen its own envelope.

import { checkError, createTextInkCheck, createTextInkReference } from "./text-ink-reference.js";

// Applied to the oracle's page: Chrome paints every box, border and
// decoration, and no glyph.
export const TEXT_FREE_CSS = "*, *::before, *::after, *::marker { -webkit-text-fill-color: transparent !important; }";

// Horizontal lines per pixel row that sample the envelope band. The band's
// area in a pixel is exact in x and within 1 / ENVELOPE_SUB_ROWS in y.
export const ENVELOPE_SUB_ROWS = 256;

// Sandom's raster holds 8-bit channels: a value is within half a step of
// the color it encodes.
export const INK_QUANTIZATION = 0.5 / 255;

// The approval of a pixel that several mechanisms each approve alone:
// removing any one of them leaves it inside the envelope.
export const OVERLAPPING = "overlapping";

/**
 * @typedef {object} Mechanism
 * @property {string} name
 * @property {number} value raster pixels (sandomCurvature: square pixels; sandomFieldRidge: a cosine)
 * @property {string} model what Sandom's raster does
 * @property {string} measurement the evidence that sets the value
 * @property {string} decision the operator's judgment
 */

/** @type {readonly Mechanism[]} */
export const TEXT_INK_MECHANISMS = Object.freeze([
  Object.freeze({
    name: "sandomEdge",
    value: 0.08,
    model: "The MSDF field places every edge within this distance of the outline.",
    measurement: "Off, 40301 pixels of the 240 calibration specimens fail. At 0.06, 0 to 11 pixels per family fail on the light specimens; at 0.08 only the sites listed in the plan fail.",
    decision: "Approved with the calibration overlay, 2026-09-28.",
  }),
  Object.freeze({
    name: "sandomCurvature",
    value: 0.5,
    model: "The bilinear field erodes a convex curve of radius R by up to K / R, at most the inner corner width.",
    measurement: "Off, at least 336 pixels fail. Comfortaa's round terminals (R about 2.5 px) sit 0.2 px inside the outline; K = 0.5 takes Comfortaa from 69 failing pixels to 2, K = 0.4 leaves 19.",
    decision: "Approved with the calibration overlay, 2026-09-28.",
  }),
  Object.freeze({
    name: "sandomInnerCorner",
    value: 2.5,
    model: "At a notch or a junction of overlapping contours the field cannot resolve a wedge narrower than W: within W / (2 tan(θ / 2)) of the apex for interior angle θ, at least W and at most the shorter side. A crossing apex of a stroke's union outline has no 'at least W' floor: its reach is W / (2 tan(θ / 2)), at most the shorter side. Where an SVG fill's outline crosses itself, each sector of the crossing whose two sides separate fill from no fill is a corner, classed as a join is; at an evenodd crossing all four wedges meet, and each is an inner junction.",
    measurement: "The Roboto Slab 32 px '4' counter tip needs W above 2.3 px; W = 2.5 passes every inner join of the calibration specimens. Fill crossings (test/svg/svg_test.js, self-intersecting outlines, density 2): without crossing corners exactly 12 device pixels fail, 4 at the evenodd pentagram's centre corners as <polygon> and as <path> (Sandom 173, 160, 96, 96 against truth 139, 199, 136, 136) and 4 at the evenodd overlapping loop's crossings (181, 8, 79, 230 against 108, 0, 121, 255); with them this mechanism approves exactly those pixels.",
    decision: "Approved 2026-09-28 from the Roboto Slab 32 px '4' counter tip (38/255) and a Roboto Slab 24 px notch (6/255), then from the four largest inner-join differences W = 2.5 approves (Roboto Slab 32 px 'v' crotch, 88/255; IBM Plex Mono 32 px, 82/255; Roboto Slab 32 px, 74/255; Roboto Slab 16 px, 69/255): none is visible at natural size. Stroke crossing apexes approved by the operator 2026-10-05 from the committed martini (martini-neon.svg, density 2): device pixels (398, 798) and (561, 798) next to the 9.5° base crossings, Sandom [222,242,245] against truth [233,253,255], are acceptable at natural size. The distance field under-covers behind a shallow self-crossing of a stroke; this approval is for this case only, and the operator reviews each new shallow self-crossing case, which may not be acceptable. Fill crossings approved by the operator 2026-10-14 from the scrubbable Chrome and Sandom comparison of the self-intersecting outlines (evenodd and nonzero pentagram as <polygon> and <path>, overlapping loop, figure eight, nested squares; 160 device pixels): the 12 crossing pixels this approves, 4 per evenodd pentagram and 4 at the evenodd overlapping loop, are acceptable.",
  }),
  Object.freeze({
    name: "sandomOuterCorner",
    value: 2.5,
    model: "At a point of the silhouette (ink inside the wedge, none outside) the field cannot resolve a wedge narrower than W, as for inner joins.",
    measurement: "The Inter 11 and 13 px 'Q' tail, where it leaves the bowl, needs W above 1.5 px; W = 2.5 passes it.",
    decision: "Approved 2026-09-28 from the Inter 11 and 13 px 'Q' tail (5 and 6/255), then from the four largest outer-point differences W = 2.5 approves (Roboto Slab 32 px, 33/255; Roboto Slab 13 px, 31/255; IBM Plex Mono 32 px, 27/255; IBM Plex Mono 11 px, 24/255): none is visible at natural size.",
  }),
  Object.freeze({
    name: "sandomFieldRidge",
    value: -0.9,
    model: "The renderer reads a glyph's distance field bilinearly between texel centres, and the atlas keys the field by the CSS font size, so at density 2 a texel spans 0.64 to 0.78 device pixels. Across a stroke or a gap thinner than about two texels the true distance folds between two texels, and the interpolation reads it nearer the outline: a thin stroke loses ink, a thin gap fills. At a box whose texel cell holds two distance directions with a cosine below this value, and no texel nearest a corner within a texel, the box reads the bilinear true distance of the field's texel grid (core/build/text-ink-reference.wat, \"Field ridge\"), shifted by ±sandomEdge. The value is a cosine, not a radius.",
    measurement: "The STIX Two Math '3' exponent of <msup><mi>x</mi><mn>3</mn></msup> at 11.2 px, density 2, fails device pixel (408, 13), Sandom coverage 0.686 against 0.701 to 0.981; the model reads 0.677. probes/glyph-field-ridge-probe.js rebuilds the field with vendor/msdfgen.wasm and matches Sandom's pixels within 0.0045 coverage on seven MathML pages; with the model off the failures are exactly (408, 13).",
    decision: "Approved by the operator 2026-10-07 from the scrubbable review of the seven MathML pages (glyph-field-ridge-probe.js --review), over keying glyph fields by the device font size.",
  }),
]);

/**
 * Measured freedoms of Sandom's SVG paint beyond the glyph mechanisms
 * (plans/PLAN-svg-source-truth.md, slice 4). The SVG truth check
 * (test/helpers/svg-truth.js) reads them here; the reference module
 * (core/build/text-ink-reference.wat, "SVG paint") builds each envelope.
 * @type {readonly Mechanism[]}
 */
export const SVG_PAINT_MECHANISMS = Object.freeze([
  Object.freeze({
    name: "filterBoxGaussian",
    value: 3 * Math.sqrt(2 * Math.PI) / 4,
    model: "Sandom blurs a filter (blur(), drop-shadow()) with three centred box passes per axis of 2 floor(d / 2) + 1 taps, d = floor(value × s + 1/2) in f32 for the deviation s in device pixels, instead of the Gaussian. Each bound of a blur is the hull of the Gaussian and the box blur of the bound: the box kernel is non-negative, so Sandom's blur of any image between the bounds lies between their box blurs. The predictor is that box blur's difference from the Gaussian; over all inputs in [0, 1] it is at most half the L1 distance of the two kernels (0.030 to 0.037 from 8 to 136 device pixels).",
    measurement: "Calibration (.test-evidence/svg-filter-box-gaussian/run-2, probes/svg-filter-box-gaussian-calibration.js): the committed martini glow (16, 56 and 136 device pixels) and one disk under drop-shadow() at 0.5, 1, 2, 4, 8, 16 and 32 device pixels all pass with the mechanism. Off, the exact Gaussian fails 5,704 martini pixels and 300, 928, 1,480, 2,444, 2,416, 0 and 160 sweep pixels; Sandom's largest channel difference from the exact Gaussian is 13 on the martini and 21 to 1 on the sweep.",
    decision: "Approved by the operator 2026-10-07 from the scrubbable comparison of the calibration set (.test-evidence/svg-filter-box-gaussian/run-2): the martini's difference from the exact Gaussian (13/255) is virtually invisible.",
  }),
]);

export const CORNER_TURN_DEGREES = 15;

// The envelope parameters with the named mechanism off; ALL_MECHANISMS
// turns every mechanism off, leaving the exact coverage. The SVG truth
// check (test/helpers/svg-truth.js) configures its envelopes through the
// same function, so both checks read one set of values.
const ALL_MECHANISMS = Symbol("all mechanisms");

export function mechanismsOf(disabled) {
  const value = (name) =>
    disabled === ALL_MECHANISMS || name === disabled
      ? 0
      : TEXT_INK_MECHANISMS.find((entry) => entry.name === name).value;
  const edge = value("sandomEdge");
  return {
    lineRadius: edge, curveRadius: edge,
    curvatureK: value("sandomCurvature"),
    curvatureCap: TEXT_INK_MECHANISMS.find((entry) => entry.name === "sandomInnerCorner").value,
    cornerInner: value("sandomInnerCorner"),
    cornerOuter: value("sandomOuterCorner"),
    cornerTurnDegrees: CORNER_TURN_DEGREES,
    subRows: ENVELOPE_SUB_ROWS,
    // -1 turns the field ridge off: no two directions are more opposed.
    foldCosine: disabled === ALL_MECHANISMS || disabled === "sandomFieldRidge"
      ? -1
      : TEXT_INK_MECHANISMS.find((entry) => entry.name === "sandomFieldRidge").value,
  };
}

// The text commands with glyphs, each with the clip entries active where it
// paints (every entry of every open push-clip).
function textCommands(displayList) {
  const stack = [];
  const commands = [];
  for (const command of displayList.commands) {
    if (command.name === "push-clip") stack.push(command.clipEntries);
    else if (command.name === "pop-clip") stack.pop();
    else if (command.name === "text" && command.glyphIds.length > 0) commands.push({ command, clips: stack.flat() });
  }
  return commands;
}

// Region ids of core/engine/text-ink-check.wat.
const REGION = Object.freeze({
  textFree: 0, sandom: 1, reach: 2, colors: 3, layerLower: 4, layerUpper: 5, lowBound: 6, highBound: 7,
  truth: 8, list: 9, clips: 10, envelopeLower: 11, envelopeUpper: 12, approvals: 15,
});
const CLIP_FIELDS = 14;
const MODE_FULL = 0;
const MODE_BASE = 1;
const APPROVAL_OVERLAPPING = 255;
// Message template of core/engine/text-ink-check.wat.
const UNSUPPORTED_CLIP = 147;

function region(check, id, Type, length) {
  return new Type(check.memory.buffer, check.check_region(id), length);
}

// Writes the clip entries active where a command paints and computes their
// coverage; returns false when the command paints inside no clip.
function clipCoverage(check, clips, deviceScale, label) {
  if (clips.length === 0) return false;
  const records = region(check, REGION.clips, Float64Array, clips.length * CLIP_FIELDS);
  clips.forEach((clip, index) => {
    records.set([clip.x, clip.y, clip.width, clip.height, clip.affine !== null ? 1 : 0, clip.pathMask ? 1 : 0, ...clip.radii],
      index * CLIP_FIELDS);
  });
  if (check.check_clip_coverage(clips.length, deviceScale) < 0) throw checkError(check, UNSUPPORTED_CLIP, "", label);
  return true;
}

// Copies each layer's envelope `key` into the layer regions.
function writeLayers(check, layers, key, pixels) {
  layers.forEach((layer, index) => {
    region(check, REGION.layerLower, Float32Array, pixels * layers.length).set(layer.envelopes[key].lower, index * pixels);
    region(check, REGION.layerUpper, Float32Array, pixels * layers.length).set(layer.envelopes[key].upper, index * pixels);
  });
}

function listed(check, count) {
  return [...region(check, REGION.list, Uint32Array, count)];
}

/**
 * Compares Sandom's glyph ink with the truth image.
 *
 * @param {object} options
 * @param {object} options.displayList Sandom's createDisplayListArtifact(scene)
 * @param {number} options.width device pixels
 * @param {number} options.height device pixels
 * @param {number} options.deviceScale
 * @param {Uint8Array|Uint8ClampedArray} options.sandom Sandom's RGBA8 sRGB pixels
 * @param {Uint8Array|Uint8ClampedArray} options.textFree Chrome's RGBA8 sRGB
 *   pixels of the same page with TEXT_FREE_CSS applied
 * @param {(font: object) => Uint8Array} options.resolveFontBytes
 * @returns {Promise<object>} `truth` (RGBA8 truth image), `glyphPixels`
 *   (1 where a glyph's envelope reaches), `lowBound`/`highBound` (RGBA8
 *   channel limits: a channel below or above fails), `failures` (glyph
 *   pixels outside the envelope, with Sandom's color and the limits),
 *   `approvedBy` (mechanism name → pixel indices that fail when that
 *   mechanism alone is off), `approvals` (pixel index → the first such
 *   mechanism, or OVERLAPPING), and `pass`. Pixels outside `glyphPixels`
 *   belong to the page's other comparisons.
 */
export async function textInkTruthDiff(options) {
  const checker = createTextInkTruthChecker();
  try {
    return await checker.compare(options);
  } finally {
    checker.dispose();
  }
}

// A retained timeline reuses outline envelopes, never pixel verdicts.
// Current command geometry, font identity and clips determine each entry.
export function createTextInkTruthChecker() {
  const reference = createTextInkReference();
  const check = createTextInkCheck();
  const cachedEnvelopes = new Map();
  let previous = null;
  const equalPixels = (left, right) => {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  };
  async function compare({
    displayList, width, height, deviceScale, sandom, textFree, resolveFontBytes,
  }) {
  for (const [name, pixels] of [["sandom", sandom], ["textFree", textFree]]) {
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) {
      throw new TypeError(`textInkTruthDiff: ${name} must be ${width}×${height} RGBA8 pixels, got ${pixels?.constructor?.name} of ${pixels?.length}`);
    }
  }
    const commands = textCommands(displayList);
    if (commands.length === 0) {
      return {
        pass: true, truth: textFree, glyphPixels: new Float32Array(width * height),
        lowBound: textFree, highBound: textFree, failures: [], approvals: new Map(),
        approvedBy: Object.fromEntries(TEXT_INK_MECHANISMS.map(({ name }) => [name, new Set()])),
      };
    }
    const identity = JSON.stringify({ width, height, deviceScale, commands });
    const fonts = commands.map(({ command }) => resolveFontBytes(command.font));
    if (previous !== null && previous.identity === identity &&
        fonts.every((bytes, index) => bytes === previous.fonts[index]) &&
        equalPixels(sandom, previous.sandom) && equalPixels(textFree, previous.textFree)) {
      return previous.verdict;
    }
    const pixels = width * height;
    const clipCount = Math.max(0, ...commands.map(({ clips }) => clips.length));
    const began = check.check_begin(width, height, commands.length, clipCount);
    if (began !== 0) throw new Error(`textInkTruthDiff: the check module could not grow its memory for ${width}×${height} pixels`);
    const layers = [];
    const usedEnvelopes = new Set();
    for (const { command, clips } of commands) {
      const common = {
        displayList, width, height, deviceScale, resolveFontBytes, commandIndices: [command.commandIndex],
      };
      const cacheKey = JSON.stringify({
        width, height, deviceScale, command: { ...command, color: undefined }, clips,
      });
      usedEnvelopes.add(cacheKey);
      const cached = cachedEnvelopes.get(cacheKey);
      if (cached !== undefined && cached.fontBytes === resolveFontBytes(command.font)) {
        layers.push({ color: command.color, envelopes: cached.envelopes });
        continue;
      }
      const clipped = clipCoverage(check, clips, deviceScale, `text command ${command.commandIndex} "${command.text}"`);
      const envelopes = {};
      for (const [key, disabled] of [
        ["full", null], ["base", ALL_MECHANISMS],
        ...TEXT_INK_MECHANISMS.map((mechanism) => [mechanism.name, mechanism.name]),
      ]) {
        const envelope = await reference.envelope({ ...common, mechanisms: mechanismsOf(disabled) });
        if (clipped) {
          region(check, REGION.envelopeLower, Float32Array, pixels).set(envelope.lower);
          region(check, REGION.envelopeUpper, Float32Array, pixels).set(envelope.upper);
          check.check_clip_envelope();
          envelope.lower.set(region(check, REGION.envelopeLower, Float32Array, pixels));
          envelope.upper.set(region(check, REGION.envelopeUpper, Float32Array, pixels));
        }
        envelopes[key] = envelope;
      }
      cachedEnvelopes.set(cacheKey, { fontBytes: resolveFontBytes(command.font), envelopes });
      layers.push({ color: command.color, envelopes });
    }
    for (const key of cachedEnvelopes.keys()) {
      if (!usedEnvelopes.has(key)) cachedEnvelopes.delete(key);
    }
    region(check, REGION.textFree, Uint8Array, pixels * 4).set(textFree);
    region(check, REGION.sandom, Uint8Array, pixels * 4).set(sandom);
    region(check, REGION.colors, Float64Array, layers.length * 4).set(layers.flatMap((layer) => layer.color));
    // Only glyph pixels: the page's other pixels have their own comparisons.
    // The verdict returns the full envelope's bounds and the truth image for
    // every pixel; the other envelopes are read at glyph pixels alone.
    writeLayers(check, layers, "full", pixels);
    check.check_reach();
    const reach = region(check, REGION.reach, Float32Array, pixels).slice();
    const failed = listed(check, check.check_outside(MODE_FULL));
    const lowBound = region(check, REGION.lowBound, Uint8Array, pixels * 4).slice();
    const highBound = region(check, REGION.highBound, Uint8Array, pixels * 4).slice();
    const failures = failed.map((pixel) => ({
      x: pixel % width,
      y: Math.floor(pixel / width),
      sandom: [...sandom.subarray(pixel * 4, pixel * 4 + 3)],
      low: [...lowBound.subarray(pixel * 4, pixel * 4 + 3)],
      high: [...highBound.subarray(pixel * 4, pixel * 4 + 3)],
    }));
    writeLayers(check, layers, "base", pixels);
    const overlapping = listed(check, check.check_outside(MODE_BASE));
    // The truth image: exact coverage, which is the zero-mechanism envelope.
    check.check_truth();
    const truth = region(check, REGION.truth, Uint8Array, pixels * 4).slice();
    const approvedBy = {};
    TEXT_INK_MECHANISMS.forEach((mechanism, index) => {
      writeLayers(check, layers, mechanism.name, pixels);
      approvedBy[mechanism.name] = new Set(listed(check, check.check_outside(MODE_BASE + 1 + index)));
    });
    const approvalCodes = region(check, REGION.approvals, Uint8Array, pixels);
    const approvals = new Map(overlapping.map((pixel) => [
      pixel,
      approvalCodes[pixel] === APPROVAL_OVERLAPPING ? OVERLAPPING : TEXT_INK_MECHANISMS[approvalCodes[pixel] - 1].name,
    ]));
    const verdict = {
      pass: failures.length === 0, truth, glyphPixels: reach,
      lowBound, highBound, failures, approvals, approvedBy,
    };
    previous = { identity, fonts, sandom: sandom.slice(), textFree: textFree.slice(), verdict };
    return verdict;
  }
  return {
    compare,
    dispose() {
      cachedEnvelopes.clear();
      previous = null;
      reference.dispose();
    },
  };
}
