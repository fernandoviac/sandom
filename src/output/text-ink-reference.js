// Exact outline coverage of the text in a display list, and the envelope
// of coverage Sandom may draw around it (plans/text/PLAN-text-ink-approval.md);
// the same for SVG fills (plans/PLAN-svg-source-truth.md).
//
// The coverage comes from src/wasm/text-ink-reference.wat. For text it
// shares only the HarfBuzz outline decode with the renderer
// (src/shaping.js); it never reads the MSDF atlas, the glyph fields, or
// the GPU, so a defect in the renderer's glyph path is visible against it.
// For SVG fills the module parses the path data itself.
//
// Glyphs sit where the display list places them: the text command's
// baseline and each glyph's position, unrounded, in the renderer's f32
// arithmetic, under the command's affine when it carries one (SVG text,
// CSS transforms).

import { instantiate } from "../wasm/text-ink-reference-binary.js";
import { createGlyphOutlineSource } from "../shaping.js";

const STATUS_MESSAGES = new Map([
  [-1, "an outline holds an unknown verb"],
  [-2, "the reference module could not grow its memory"],
  [-3, "a pixel row crosses more than 4096 outline segments"],
  [-4, "a pixel row needs more than 65536 sub-band breaks"],
  [-5, "the raster is not 1 to 16384 pixels on each side"],
  [-6, "the chord tolerance is not a positive finite number of pixels"],
  [-7, "a curve needs more than 65536 chords at the chord tolerance"],
  [-8, "a glyph has more than 16384 corner vertices"],
  [-10, "a sample line crosses more than 16384 segments or bands"],
  [-11, "the envelope radii are not finite and non-negative, the corner cosine is outside [-1, 1], or the sample line count is outside 1 to 4096"],
  [-15, "the fill rule is not 0 (nonzero) or 1 (evenodd)"],
]);

// The path commands the module reads, in either case.
const SVG_PATH_COMMANDS = "M, L, H, V, C, S, Q, T, A and Z";

// Fill rules as the module numbers them.
const SVG_FILL_RULES = new Map([["nonzero", 0], ["evenodd", 1]]);

// The reference outline is the true curve: chords stay within 1/256 of a
// device pixel of it, so a pixel's coverage differs from the curve's by at
// most 1/256 — the 8-bit resolution of the raster. Coverage converges on
// the exact union area at a quarter of the error per quarter of this
// tolerance (Inter at 32 px, density 2).
export const REFERENCE_CHORD_TOLERANCE_PIXELS = 1 / 256;

const SYNTHETIC_OBLIQUE_SKEW = 0.25;

const f32 = Math.fround;

function statusError(status, context, subject = "text ink reference") {
  const message = STATUS_MESSAGES.get(status) ?? `unknown status ${status}`;
  return new Error(`${subject}: ${message} (${context})`);
}

function beginRaster(exports, width, height, subject) {
  const began = exports.reference_begin(width, height);
  if (began !== 0) throw statusError(began, `raster ${width}x${height}`, subject);
}

function configureEnvelope(exports, mechanisms, subject) {
  const {
    lineRadius, curveRadius, curvatureK, curvatureCap, cornerInner, cornerOuter, cornerTurnDegrees, subRows, foldCosine,
  } = mechanisms;
  if (!(cornerTurnDegrees >= 0 && cornerTurnDegrees <= 180)) {
    throw new RangeError(`${subject}: cornerTurnDegrees must be in [0, 180], got ${cornerTurnDegrees}`);
  }
  const configured = exports.envelope_configure(
    lineRadius, curveRadius, curvatureK, curvatureCap, cornerInner, cornerOuter,
    Math.cos(cornerTurnDegrees * Math.PI / 180), subRows, foldCosine,
  );
  if (configured !== 0) throw statusError(configured, JSON.stringify(mechanisms), subject);
}

// The key of a glyph's distance field in the renderer's atlas, as
// src/wasm/glyph-atlas.watpart computes it from the text
// command's CSS font size: the size class, its field size
// (atlas_glyph_msdf_size) and its minimum texel in font units
// (atlas_glyph_minimum_shape_units_per_texel).
const MSDF_RANGE = 6;
const TEXT_FIELD_REACH_PX = 0.95;
function glyphFieldKey(cssFontSize, unitsPerEm) {
  const sizeClass = Math.ceil(4 * Math.log2(Math.max(cssFontSize, 1)));
  return {
    msdfSize: Math.round(Math.min(256, Math.max(48, 2 ** Math.floor((sizeClass + 3) / 4) + 2 * MSDF_RANGE))),
    minimumUnitsPerTexel: TEXT_FIELD_REACH_PX / (0.5 * MSDF_RANGE) * unitsPerEm / 2 ** ((sizeClass - 1) / 4),
  };
}

function raster(exports, base, width, height) {
  return new Float32Array(exports.memory.buffer, base, width * height).slice();
}

// The command affine [a, b, c, d, e, f] (translation in CSS px) after a
// device-space placement [a, b, c, d, e, f]: a point p maps to
// command(placement(p)).
function composeAffine([a, b, c, d, e, f], deviceScale, [pa, pb, pc, pd, pe, pf]) {
  return [
    a * pa + c * pb, b * pa + d * pb,
    a * pc + c * pd, b * pc + d * pd,
    a * pe + c * pf + f32(e * deviceScale), b * pe + d * pf + f32(f * deviceScale),
  ];
}

export function createTextInkReference() {
  const exports = instantiate({}).exports;
  const outlineSources = new Map();
  const outlines = new Map();

  async function outlineFor(fontBytes, variations, glyphId) {
    let source = outlineSources.get(fontBytes);
    if (source === undefined) {
      source = { handle: await createGlyphOutlineSource(fontBytes), fonts: new Map() };
      outlineSources.set(fontBytes, source);
    }
    const instanceKey = JSON.stringify(variations);
    let instance = source.fonts.get(instanceKey);
    if (instance === undefined) {
      instance = source.handle.createFont(variations);
      source.fonts.set(instanceKey, instance);
    }
    let byGlyph = outlines.get(instance);
    if (byGlyph === undefined) {
      byGlyph = new Map();
      outlines.set(instance, byGlyph);
    }
    let verbs = byGlyph.get(glyphId);
    if (verbs === undefined) {
      verbs = instance.glyphOutline(glyphId).verbs;
      byGlyph.set(glyphId, verbs);
    }
    return { verbs, upem: source.handle.upem };
  }

  // Every drawn glyph of the given text commands, with the transform that
  // places it: the glyph's placement in the run at device scale, then the
  // command's affine, as the renderer applies it to each glyph instance
  // (its translation scaled to device pixels in f32).
  async function* placedGlyphs(commands, deviceScale, resolveFontBytes) {
    if (typeof resolveFontBytes !== "function") {
      throw new TypeError("text ink reference: resolveFontBytes must be a function of a text command's font identity");
    }
    for (const command of commands) {
      const label = `text command ${command.commandIndex} "${command.text}"`;
      if (command.textShadow) {
        throw new Error(`text ink reference: ${label} is a text shadow; the reference has no shadow model`);
      }
      if (command.font === null) {
        throw new Error(`text ink reference: ${label} names no registered font`);
      }
      const fontBytes = resolveFontBytes(command.font);
      if (!(fontBytes instanceof Uint8Array)) {
        throw new TypeError(`text ink reference: resolveFontBytes returned no bytes for ${label} (${JSON.stringify(command.font)})`);
      }
      const variations = [
        ["wght", command.fontWeight],
        ["opsz", command.fontSize],
        ["slnt", command.font.slant],
        ["wdth", command.font.stretch],
      ];
      const syntheticOblique = command.fontStyle === "italic" && command.font.style !== "italic";
      const { x: textX, y: textY, baseline } = command.geometry;
      const baselineY = f32(f32(f32(textY * deviceScale)) + f32(baseline * deviceScale));
      const deviceTextX = f32(textX * deviceScale);
      for (let glyphIndex = 0; glyphIndex < command.glyphIds.length; glyphIndex++) {
        const glyphId = command.glyphIds[glyphIndex];
        if (glyphId === 0xFFFF) continue;
        const { verbs, upem } = await outlineFor(fontBytes, variations, glyphId);
        if (verbs.length === 0) continue;
        const scale = command.fontSize * deviceScale / upem;
        // Font units are y-up; the raster is y-down. A synthetic oblique
        // skews about the baseline: x gains 0.25 of the height above it.
        const placement = [
          scale, 0, syntheticOblique ? SYNTHETIC_OBLIQUE_SKEW * scale : 0, -scale,
          f32(deviceTextX + f32(command.glyphPositions[glyphIndex] * deviceScale)), baselineY,
        ];
        const transform = command.transform === null ? placement : composeAffine(command.transform, deviceScale, placement);
        yield { label: `${label}, glyph ${glyphId}`, verbs, transform, fieldKey: glyphFieldKey(command.fontSize, upem) };
      }
    }
  }

  function textCommands(displayList, commandIndices) {
    const commands = displayList.commands.filter((command) => command.name === "text");
    if (commandIndices === undefined) return commands;
    const wanted = new Set(commandIndices);
    return commands.filter((command) => wanted.has(command.commandIndex));
  }

  function copyVerbs(glyph) {
    const pointer = exports.reference_verb_buffer(glyph.verbs.length);
    if (pointer === 0) throw statusError(-2, glyph.label);
    new Uint8Array(exports.memory.buffer, pointer, glyph.verbs.length).set(glyph.verbs);
  }

  function begin(width, height) {
    beginRaster(exports, width, height, "text ink reference");
  }

  /**
   * Coverage of the text commands of a display-list artifact, composited
   * glyph by glyph, one f32 per device pixel (row-major).
   *
   * @param {object} options
   * @param {object} options.displayList createDisplayListArtifact(scene)
   * @param {number} options.width raster width in device pixels
   * @param {number} options.height raster height in device pixels
   * @param {number} options.deviceScale device pixels per CSS pixel
   * @param {(font: object) => Uint8Array} options.resolveFontBytes
   *   bytes of the face a text command names (its `font` identity)
   * @param {number[]} [options.commandIndices] only these text commands
   * @param {number} [options.chordTolerance] device pixels
   * @returns {Promise<{width: number, height: number, coverage: Float32Array}>}
   */
  async function render({
    displayList, width, height, deviceScale, resolveFontBytes, commandIndices,
    chordTolerance = REFERENCE_CHORD_TOLERANCE_PIXELS,
  }) {
    begin(width, height);
    for await (const glyph of placedGlyphs(textCommands(displayList, commandIndices), deviceScale, resolveFontBytes)) {
      copyVerbs(glyph);
      const added = exports.reference_add_glyph(glyph.verbs.length, ...glyph.transform, chordTolerance);
      if (added < 0) throw statusError(added, glyph.label);
    }
    return { width, height, coverage: raster(exports, exports.raster_base(), width, height) };
  }

  /**
   * The lowest and highest coverage the renderer may draw: the exact
   * coverage with every edge free to move within the mechanism radii.
   *
   * @param {object} options the render options, plus:
   * @param {{lineRadius: number, curveRadius: number, curvatureK: number,
   *   curvatureCap: number, cornerInner: number, cornerOuter: number,
   *   cornerTurnDegrees: number, subRows: number, foldCosine: number}} options.mechanisms raster
   *   pixels (curvatureK: px²; foldCosine: the field ridge's fold cosine, -1 off)
   * @returns {Promise<{width: number, height: number, lower: Float32Array, upper: Float32Array}>}
   */
  async function envelope({
    displayList, width, height, deviceScale, resolveFontBytes, commandIndices, mechanisms,
    chordTolerance = REFERENCE_CHORD_TOLERANCE_PIXELS,
  }) {
    begin(width, height);
    configureEnvelope(exports, mechanisms, "text ink reference");
    for await (const glyph of placedGlyphs(textCommands(displayList, commandIndices), deviceScale, resolveFontBytes)) {
      copyVerbs(glyph);
      const added = exports.envelope_add_glyph(glyph.verbs.length, ...glyph.transform, chordTolerance,
        glyph.fieldKey.msdfSize, glyph.fieldKey.minimumUnitsPerTexel);
      if (added < 0) throw statusError(added, glyph.label);
    }
    return {
      width,
      height,
      lower: raster(exports, exports.lower_base(), width, height),
      upper: raster(exports, exports.upper_base(), width, height),
    };
  }

  function dispose() {
    for (const source of outlineSources.values()) {
      for (const instance of source.fonts.values()) instance.destroy();
      source.handle.destroy();
    }
    outlineSources.clear();
    outlines.clear();
  }

  return Object.freeze({ render, envelope, dispose });
}

// Stroke parameters as the module numbers them.
const SVG_LINECAPS = new Map([["butt", 0], ["round", 1], ["square", 2]]);
const SVG_LINEJOINS = new Map([["miter", 0], ["round", 1], ["bevel", 2]]);
const SVG_MAX_DASHES = 256;

/**
 * The outline parts of a stroke, as the module numbers them on each outline
 * edge (plans/PLAN-svg-source-truth.md, slice 2), with the outline part
 * class the stress report names and the mechanism whose band they carry.
 */
export const SVG_STROKE_PARTS = Object.freeze(new Map([
  [1, Object.freeze({ name: "side", part: "side", mechanism: "sandomEdge" })],
  [2, Object.freeze({ name: "curve side", part: "curve", mechanism: "sandomCurvature" })],
  [3, Object.freeze({ name: "butt end", part: "cap", mechanism: "sandomEdge" })],
  [4, Object.freeze({ name: "round cap", part: "cap", mechanism: "sandomCurvature" })],
  [5, Object.freeze({ name: "square cap", part: "cap", mechanism: "sandomEdge" })],
  [6, Object.freeze({ name: "round join", part: "join", mechanism: "sandomCurvature" })],
  [7, Object.freeze({ name: "bevel edge", part: "join", mechanism: "sandomEdge" })],
  [8, Object.freeze({ name: "miter edge", part: "join", mechanism: "sandomEdge" })],
]));

/**
 * Exact coverage of SVG fills and strokes, and the envelope around it
 * (plans/PLAN-svg-source-truth.md, slices 1 and 2), from the same module
 * and integrator as the glyph coverage. The module parses each path's data
 * and constructs each stroke itself; nothing here reads the renderer's SVG
 * parser, stroke expander, msdfgen, or Skia.
 *
 * A path is `{ d, transform, label }` with either `fillRule` (`"nonzero"`
 * or `"evenodd"`) for a fill, or `stroke` for a stroke:
 * `{ width, linecap, linejoin, miterlimit, dasharray, dashoffset }` in user
 * units, with SVG's keywords (`miter`, `round`, `bevel`; `butt`, `round`,
 * `square`) and `dasharray` a list of non-negative lengths (empty: solid).
 * The transform `[a, b, c, d, e, f]` maps user units to raster pixels
 * (X = a x + c y + e, Y = b x + d y + f); it applies in f64 before any curve
 * is flattened, and after a stroke is constructed in user units. An
 * optional label names the path in errors. Paths composite in order with
 * source-over coverage.
 */
export function createSvgReference() {
  const exports = instantiate({}).exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const subject = "SVG reference";

  function pathError(status, bytes, label) {
    const offset = exports.path_error_offset();
    const byte = exports.path_error_byte();
    const found = byte < 0
      ? "the end of the path data"
      : byte > 0x20 && byte < 0x7F ? `"${String.fromCharCode(byte)}"` : `byte 0x${byte.toString(16).padStart(2, "0")}`;
    const near = JSON.stringify(decoder.decode(bytes.subarray(Math.max(0, offset - 16), offset + 16)));
    if (status === -12) {
      return new Error(
        `${subject}: ${label} uses the path command ${found} at byte ${offset} (near ${near}), which the reference does not read; ` +
          `it reads ${SVG_PATH_COMMANDS}, absolute or relative: rewrite that segment with these commands`,
      );
    }
    if (status === -13) {
      return new Error(
        `${subject}: ${label} has malformed path data at byte ${offset}, at ${found} (near ${near}); ` +
          "give each command the arguments it takes, as SVG path grammar numbers and arc flags",
      );
    }
    if (status === -14) {
      return new Error(`${subject}: ${label} path data begins with ${found}, not a moveto; begin it with M or m`);
    }
    if (status === -16) {
      return new Error(
        `${subject}: ${label} strokes a curve with a cusp, where the stroke's normal is undefined; ` +
          "split the curve at the cusp into two segments",
      );
    }
    if (status === -18) {
      return new Error(`${subject}: ${label} needs more than 1400 points in one stroke region or 1000000 dash steps; shorten the dash pattern relative to the path`);
    }
    if (status === -19) {
      return new Error(`${subject}: ${label} strokes more than 512 subpaths; split it into several paths`);
    }
    return statusError(status, label, subject);
  }

  function strokeArguments(stroke, label) {
    const { width, linecap = "butt", linejoin = "miter", miterlimit = 4, dasharray = [], dashoffset = 0 } = stroke;
    if (!(Number.isFinite(width) && width > 0)) {
      throw new TypeError(`${subject}: ${label} has the stroke width ${width}; give a positive finite user length (a zero width paints no stroke: omit the stroke)`);
    }
    const cap = SVG_LINECAPS.get(linecap);
    if (cap === undefined) throw new TypeError(`${subject}: ${label} has the linecap ${JSON.stringify(linecap)}; give butt, round, or square`);
    const join = SVG_LINEJOINS.get(linejoin);
    if (join === undefined) {
      throw new TypeError(`${subject}: ${label} has the linejoin ${JSON.stringify(linejoin)}; the reference constructs miter, round, and bevel joins`);
    }
    if (!(Number.isFinite(miterlimit) && miterlimit >= 0)) {
      throw new TypeError(`${subject}: ${label} has the miter limit ${miterlimit}; give a non-negative finite number`);
    }
    if (!Array.isArray(dasharray) || dasharray.length > SVG_MAX_DASHES || !dasharray.every((value) => Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`${subject}: ${label} has the dash array ${JSON.stringify(dasharray)}; give at most ${SVG_MAX_DASHES} non-negative finite user lengths`);
    }
    if (!Number.isFinite(dashoffset)) throw new TypeError(`${subject}: ${label} has the dash offset ${dashoffset}; give a finite user length`);
    new Float64Array(exports.memory.buffer, exports.stroke_dash_buffer(), dasharray.length).set(dasharray);
    return [width, cap, join, miterlimit, dasharray.length, dashoffset];
  }

  // The outline edges and corners that the last envelope added.
  function strokeOutline(label) {
    const view = new DataView(exports.memory.buffer);
    const edges = [];
    const edgeBase = exports.edge_base(), edgeStride = exports.edge_stride();
    for (let index = 0; index < exports.edge_count(); index++) {
      const at = edgeBase + index * edgeStride;
      const part = view.getInt32(at + 36, true);
      if (part === 0) continue;
      edges.push({
        x0: view.getFloat64(at, true), y0: view.getFloat64(at + 8, true),
        x1: view.getFloat64(at + 16, true), y1: view.getFloat64(at + 24, true),
        part, radius: view.getFloat64(at + 40, true),
      });
    }
    const vertices = [];
    const vertexBase = exports.vertex_base(), vertexStride = exports.vertex_stride();
    for (let index = 0; index < exports.vertex_count(); index++) {
      const at = vertexBase + index * vertexStride;
      vertices.push({
        x: view.getFloat64(at, true), y: view.getFloat64(at + 8, true),
        reach: view.getFloat64(at + 48, true), outer: view.getInt32(at + 56, true) === 1,
      });
    }
    return { label, edges, vertices };
  }

  function addPaths(paths, chordTolerance, envelope) {
    if (!Array.isArray(paths)) throw new TypeError(`${subject}: paths must be an array of { d, transform, fillRule } or { d, transform, stroke }`);
    const outlines = [];
    paths.forEach((path, index) => {
      const label = path.label ?? `path ${index}`;
      if (typeof path.d !== "string") throw new TypeError(`${subject}: ${label} has no path data string`);
      const { transform } = path;
      if (!Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite)) {
        throw new TypeError(`${subject}: ${label} needs a transform of six finite numbers [a, b, c, d, e, f], got ${JSON.stringify(transform)}`);
      }
      if ((path.stroke === undefined) === (path.fillRule === undefined)) {
        throw new TypeError(`${subject}: ${label} needs exactly one of fillRule (a fill) and stroke (a stroke)`);
      }
      const bytes = encoder.encode(path.d);
      let added;
      if (path.stroke !== undefined) {
        const stroke = strokeArguments(path.stroke, label);
        const pointer = exports.reference_verb_buffer(bytes.length);
        if (pointer === 0) throw statusError(-2, label, subject);
        new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
        added = (envelope ? exports.envelope_add_stroke : exports.reference_add_stroke)(
          bytes.length, ...transform, chordTolerance, ...stroke,
        );
        if (added < 0) throw pathError(added, bytes, label);
        if (envelope) outlines.push(strokeOutline(label));
      } else {
        const rule = SVG_FILL_RULES.get(path.fillRule);
        if (rule === undefined) {
          throw new TypeError(`${subject}: ${label} has the fill rule ${JSON.stringify(path.fillRule)}; give "nonzero" or "evenodd"`);
        }
        const pointer = exports.reference_verb_buffer(bytes.length);
        if (pointer === 0) throw statusError(-2, label, subject);
        new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
        added = (envelope ? exports.envelope_add_path : exports.reference_add_path)(bytes.length, ...transform, chordTolerance, rule);
        if (added < 0) throw pathError(added, bytes, label);
        if (envelope) outlines.push(strokeOutline(label));
      }
    });
    return outlines;
  }

  /**
   * Coverage of the paths, one f32 per raster pixel (row-major).
   *
   * @param {object} options
   * @param {number} options.width raster width in pixels
   * @param {number} options.height raster height in pixels
   * @param {object[]} options.paths fills and strokes (see createSvgReference)
   * @param {number} [options.chordTolerance] raster pixels
   * @returns {{width: number, height: number, coverage: Float32Array}}
   */
  function render({ width, height, paths, chordTolerance = REFERENCE_CHORD_TOLERANCE_PIXELS }) {
    beginRaster(exports, width, height, subject);
    addPaths(paths, chordTolerance, false);
    return { width, height, coverage: raster(exports, exports.raster_base(), width, height) };
  }

  /**
   * The lowest and highest coverage the renderer may draw around the
   * paths, with the glyph envelope's mechanism parameters.
   *
   * @param {object} options the render options, plus `mechanisms` as the
   *   text reference's envelope takes them
   * @returns {{width: number, height: number, lower: Float32Array, upper: Float32Array, outlines: object[]}}
   *   `outlines` holds each path's outline edges (raster pixels, part
   *   number of SVG_STROKE_PARTS, band radius) and corner vertices (reach,
   *   outer point or inner notch); a fill's edges are sides (1) and curve
   *   chords (2)
   */
  function envelope({ width, height, paths, mechanisms, chordTolerance = REFERENCE_CHORD_TOLERANCE_PIXELS }) {
    beginRaster(exports, width, height, subject);
    configureEnvelope(exports, mechanisms, subject);
    const outlines = addPaths(paths, chordTolerance, true);
    return {
      width,
      height,
      lower: raster(exports, exports.lower_base(), width, height),
      upper: raster(exports, exports.upper_base(), width, height),
      outlines,
    };
  }

  /**
   * The bounds [x, y, width, height] of a path's outline (its fill, or its
   * stroke with `stroke`, flattened within the chord tolerance) under the
   * transform.
   */
  function bounds({ d, transform, label = "path", stroke = undefined, chordTolerance = REFERENCE_CHORD_TOLERANCE_PIXELS }) {
    beginRaster(exports, 1, 1, subject);
    addPaths([stroke === undefined ? { d, transform, fillRule: "nonzero", label } : { d, transform, stroke, label }], chordTolerance, false);
    const values = new Float64Array(exports.memory.buffer, exports.outline_bounds(), 4);
    return [values[0], values[1], values[2] - values[0], values[3] - values[1]];
  }

  return Object.freeze({ render, envelope, bounds, exports });
}

// Gradient kinds and spread methods as paint_gradient numbers them.
const GRADIENT_KINDS = new Map([["linear", 1], ["radial", 2]]);
const GRADIENT_SPREADS = new Map([["pad", 0], ["reflect", 1], ["repeat", 2]]);

/** Judge program operations (paint_judge). */
export const PAINT_OPERATIONS = Object.freeze({ layer: 1, open: 2, close: 3 });

/** Judge verdicts per pixel (paint_judge). */
export const PAINT_VERDICTS = Object.freeze({
  unjudged: 0, pass: 1, fail: 2, unresolved: 3, notBackgrounds: 4, tooManyLayers: 5, translucent: 6,
});

/**
 * The SVG paint contracts of plans/PLAN-svg-source-truth.md, slice 4, on
 * their own instance of the reference module: blur and drop-shadow chains
 * on coverage bounds, gradient colour intervals, and the joint compositing
 * check. Planes are f32 per device pixel over a rectangle
 * `{ x, y, width, height }` in the instance's memory; reservations are a
 * stack (`top`, `release`) that `reset` empties.
 */
export function createSvgPaintReference() {
  const exports = instantiate({}).exports;
  const subject = "SVG paint reference";

  function checked(status, what) {
    if (status < 0) {
      if (status === -20) throw new Error(`${subject}: ${what} has a singular radial gradient transform`);
      throw statusError(status, what, subject);
    }
    return status;
  }

  function alloc(bytes, what) {
    const pointer = exports.paint_alloc(bytes);
    if (pointer === 0) throw statusError(-2, what, subject);
    return pointer;
  }

  /** A zeroed plane over `rect`, filled from `data` (Float32Array) when given. */
  function plane(rect, data = null) {
    const { x, y, width, height } = rect;
    if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1) {
      throw new RangeError(`${subject}: a plane needs an integer rectangle of at least one pixel, got ${JSON.stringify(rect)}`);
    }
    const pointer = alloc(width * height * 4, `a ${width}x${height} plane`);
    if (data !== null) {
      if (data.length !== width * height) throw new RangeError(`${subject}: plane data holds ${data.length} values for ${width}x${height}`);
      new Float32Array(exports.memory.buffer, pointer, data.length).set(data);
    }
    return { x, y, width, height, pointer };
  }

  function read(planeValue) {
    return new Float32Array(exports.memory.buffer, planeValue.pointer, planeValue.width * planeValue.height).slice();
  }

  /** A copy of `data` (bytes) in the instance's memory; returns its address. */
  function bytes(data) {
    const pointer = alloc(data.length, `${data.length} bytes`);
    new Uint8Array(exports.memory.buffer, pointer, data.length).set(data);
    return pointer;
  }

  /**
   * The alpha bounds of a source graphic on `rect` from its layers'
   * coverage bounds (`{ lo, hi }` planes on `rect`) and paint alphas.
   */
  function sourceAlpha(layers, rect) {
    const table = alloc(layers.length * 16, "the source layer table");
    const view = new DataView(exports.memory.buffer);
    layers.forEach(({ lo, hi, alpha }, index) => {
      view.setInt32(table + index * 16, lo.pointer, true);
      view.setInt32(table + index * 16 + 4, hi.pointer, true);
      view.setFloat64(table + index * 16 + 8, alpha, true);
    });
    const lo = plane(rect), hi = plane(rect);
    exports.paint_source_alpha(table, layers.length, rect.width * rect.height, lo.pointer, hi.pointer);
    return { lo, hi };
  }

  /**
   * One drop-shadow() of a chain: from the input alpha bounds `input`
   * (`{ lo, hi }` planes on one rectangle), the shadow alpha bounds and the
   * merged alpha bounds on `rect`. Deviations and offsets in device pixels
   * (offsets whole); a `boxFactor` above 0 (filterBoxGaussian's value)
   * widens each bound to Sandom's box blur; `raise` bounds the input
   * outside its planes. Returns `{ shadow, output, outside }`, `outside`
   * the bound of the output alpha outside its reach.
   */
  function shadowStage({ input, rect, sigmaX, sigmaY, offsetX, offsetY, floodAlpha, boxFactor, raise }) {
    const shadow = { lo: plane(rect), hi: plane(rect) }, output = { lo: plane(rect), hi: plane(rect) };
    const a = input.lo;
    checked(exports.paint_shadow_stage(
      input.lo.pointer, input.hi.pointer, a.x, a.y, a.width, a.height,
      shadow.lo.pointer, shadow.hi.pointer, output.lo.pointer, output.hi.pointer,
      rect.x, rect.y, rect.width, rect.height, sigmaX, sigmaY, offsetX, offsetY, floodAlpha, boxFactor, raise,
    ), "a drop-shadow stage");
    return { shadow, output, outside: exports.paint_stage_outside() };
  }

  /** One blur() of a chain on `rect`: `{ shadow, outside }` as shadowStage. */
  function blurStage({ input, rect, sigmaX, sigmaY, boxFactor, raise }) {
    const shadow = { lo: plane(rect), hi: plane(rect) };
    const a = input.lo;
    checked(exports.paint_blur_stage(
      input.lo.pointer, input.hi.pointer, a.x, a.y, a.width, a.height,
      shadow.lo.pointer, shadow.hi.pointer, rect.x, rect.y, rect.width, rect.height, sigmaX, sigmaY, boxFactor, raise,
    ), "a blur stage");
    return { shadow, outside: exports.paint_stage_outside() };
  }

  /** The Gaussian bounds of a blur of `input` on `rect` (paint_gaussian). */
  function gaussian({ input, rect, sigmaX, sigmaY }) {
    const out = { lo: plane(rect), hi: plane(rect) };
    const a = input.lo;
    checked(exports.paint_gaussian(input.lo.pointer, input.hi.pointer, a.x, a.y, a.width, a.height,
      out.lo.pointer, out.hi.pointer, rect.x, rect.y, rect.width, rect.height, sigmaX, sigmaY), "a Gaussian blur");
    return out;
  }

  /** Sandom's box blur of one plane on `rect` (paint_box_blur). */
  function box({ input, rect, sigmaX, sigmaY, boxFactor }) {
    const out = plane(rect);
    checked(exports.paint_box_blur(input.pointer, input.x, input.y, input.width, input.height,
      out.pointer, rect.x, rect.y, rect.width, rect.height, sigmaX, sigmaY, boxFactor), "a box blur");
    return out;
  }

  function kernelRadius(sigma) {
    return checked(exports.paint_kernel_radius(sigma), `the Gaussian taps of deviation ${sigma}`);
  }

  function boxGaussianDistance(sigmaX, sigmaY, boxFactor) {
    const distance = exports.paint_box_gaussian_distance(sigmaX, sigmaY, boxFactor);
    if (distance < 0) throw statusError(-2, "the box and Gaussian kernels", subject);
    return distance;
  }

  /**
   * The colour intervals of a gradient over a `width` × `height` region
   * (paint_gradient): `kind` linear or radial, `spread` pad, reflect or
   * repeat, `stops` [{ offset, rgb }] (opaque, encoded sRGB [0, 1],
   * offsets non-decreasing in [0, 1]), `matrix` [ma, mb, mc, md, me, mf]
   * from region pixels to the gradient parameter space. Returns the
   * address of 12 f32 per pixel.
   */
  function gradient({ kind, spread, stops, matrix, label }, width, height) {
    const kindNumber = GRADIENT_KINDS.get(kind), spreadNumber = GRADIENT_SPREADS.get(spread);
    if (kindNumber === undefined || spreadNumber === undefined || stops.length < 1 || matrix.length !== 6 || !matrix.every(Number.isFinite)) {
      throw new TypeError(`${subject}: ${label} is not a linear or radial gradient with pad, reflect or repeat, stops and a finite matrix`);
    }
    const table = alloc(stops.length * 32, "the gradient stops");
    const values = new Float64Array(exports.memory.buffer, table, stops.length * 4);
    stops.forEach(({ offset, rgb }, index) => values.set([offset, ...rgb], index * 4));
    const out = alloc(width * height * 48, `the colour of ${label}`);
    checked(exports.paint_gradient(kindNumber, spreadNumber, table, stops.length, ...matrix, width, height, out), label);
    return out;
  }

  /**
   * A judge program (paint_judge): `layers` [{ lo, hi, alpha, gradient, rgb }]
   * (planes on the region, `gradient` a paint_gradient address or 0),
   * `operations` [[PAINT_OPERATIONS code, argument, plane]] in paint order,
   * `outer` { opacity, backgrounds: rgb, remaining } or null, `margin`,
   * `backdrop` and `observed` (region RGBA8 addresses), `width`, `height`,
   * `quantization`, `perChannel`, `mask` (address or 0).
   */
  function program(spec) {
    const { layers, operations } = spec;
    const slots = new Float64Array(16 + layers.length * 8 + operations.length * 4);
    slots.set([
      layers.length, operations.length, spec.outer === null ? 0 : 1, spec.outer?.opacity ?? 0,
      ...(spec.outer?.backgrounds ?? [0, 0, 0]), spec.outer?.remaining ?? 1, spec.margin, spec.backdrop, spec.observed,
      spec.width, spec.height, spec.quantization, spec.perChannel ? 1 : 0, spec.mask,
    ]);
    layers.forEach((layer, index) => {
      slots.set([layer.lo.pointer, layer.hi.pointer, layer.alpha, layer.gradient, ...layer.rgb, 0], 16 + index * 8);
    });
    operations.forEach(([code, argument, planeValue], index) => {
      slots.set([code, argument, planeValue?.pointer ?? 0, 0], 16 + layers.length * 8 + index * 4);
    });
    const pointer = alloc(slots.byteLength, "a judge program");
    new Float64Array(exports.memory.buffer, pointer, slots.length).set(slots);
    return pointer;
  }

  /** Verdicts of every masked pixel of a program's region (PAINT_VERDICTS). */
  function judge(programPointer, count) {
    const verdicts = alloc(count, "the verdicts");
    checked(exports.paint_judge(programPointer, verdicts), "a judgement");
    return new Uint8Array(exports.memory.buffer, verdicts, count).slice();
  }

  /** The per-channel range of one region pixel over its whole box. */
  function pixelRange(programPointer, pixel) {
    const out = alloc(48, "a pixel range");
    const status = checked(exports.paint_judge_bounds(programPointer, pixel, out), "a pixel range");
    const values = new Float64Array(exports.memory.buffer, out, 6);
    return { status, low: [values[0], values[1], values[2]], high: [values[3], values[4], values[5]] };
  }

  /** The composite at the middle of every interval, RGBA8. */
  function composite(programPointer, count) {
    const out = alloc(count * 4, "the composite");
    checked(exports.paint_composite(programPointer, out), "a composite");
    return new Uint8ClampedArray(exports.memory.buffer, out, count * 4).slice();
  }

  return Object.freeze({
    reset: () => exports.paint_reset(), top: () => exports.paint_top(), release: (top) => exports.paint_release(top),
    plane, read, bytes, sourceAlpha, shadowStage, blurStage, gaussian, box, kernelRadius,
    boxRadius: (sigma, boxFactor) => exports.paint_box_radius(sigma, boxFactor), boxGaussianDistance, gradient, program, judge, pixelRange,
    composite, exports,
  });
}
