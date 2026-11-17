// Exact outline coverage of the text in a display list, and the envelope
// of coverage Sandom may draw around it (design/parity-methodology.md, "Text truth checks");
// the same for SVG fills (plans/PLAN-svg-source-truth.md).
//
// The coverage comes from core/build/text-ink-reference.wat. For text it
// shares only the HarfBuzz outline decode with the renderer
// (src/shaping.js); it never reads the MSDF atlas, the glyph fields, or
// the GPU, so a defect in the renderer's glyph path is visible against it.
// For SVG fills the module parses the path data itself.
//
// Glyphs sit where the display list places them: the text command's
// baseline and each glyph's position and ink height above the baseline
// (its HarfBuzz y offset), unrounded, in the renderer's f32 arithmetic,
// under the command's affine when it carries one (SVG text, CSS
// transforms).

import { instantiate } from "../wasm/text-ink-reference-binary.js";
import * as textInkReferenceBinary from "../wasm/text-ink-reference-binary.js";
import * as textInkCheckBinary from "../wasm/text-ink-check-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";
import { createGlyphOutlineSource } from "../shaping.js";

// The reference outline is the true curve: chords stay within 1/256 of a
// device pixel of it, so a pixel's coverage differs from the curve's by at
// most 1/256 — the 8-bit resolution of the raster. Coverage converges on
// the exact union area at a quarter of the error per quarter of this
// tolerance (Inter at 32 px, density 2).
export const REFERENCE_CHORD_TOLERANCE_PIXELS = 1 / 256;

const checkConstant = moduleLayoutConstants(textInkCheckBinary, "text ink check");
// The edge, corner vertex and source layer records of the reference
// module (text-ink-reference-body.watpart), by WAT name.
const referenceConstant = moduleLayoutConstants(textInkReferenceBinary, "text ink reference");
const EDGE = Object.freeze(Object.fromEntries(["X0", "Y0", "X1", "Y1", "PART", "RADIUS"]
  .map((name) => [name, referenceConstant(`EDGE_${name}`)])));
const VERTEX = Object.freeze(Object.fromEntries(["X", "Y", "REACH", "OUTER"]
  .map((name) => [name, referenceConstant(`VERTEX_${name}`)])));
const LAYER = Object.freeze(Object.fromEntries(["SIZE", "LOWER", "UPPER", "ALPHA"]
  .map((name) => [name, referenceConstant(`LAYER_${name}`)])));

// Status tables of `status_template`.
export const STATUS_TABLE = Object.freeze({
  reference: checkConstant("STATUS_TABLE_REFERENCE"),
  advance: checkConstant("STATUS_TABLE_ADVANCE"),
  paint: checkConstant("STATUS_TABLE_PAINT"),
});
export const STATUS_ALLOCATION_FAILED = checkConstant("STATUS_ALLOCATION_FAILED");
export const UNMAPPED_GLYPH_TEMPLATE = checkConstant("UNMAPPED_GLYPH_TEMPLATE");
const TEMPLATE_PATHS_NOT_ARRAY = checkConstant("TEMPLATE_PATHS_NOT_ARRAY");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ERROR_CLASSES = [Error, TypeError, RangeError];

// The glyph placement, the text ink verdict, and the argument checks and
// messages of the references (core/engine/text-ink-check.wat).
export function createTextInkCheck() {
  return textInkCheckBinary.instantiate({}).exports;
}

// The error of message template `template` with the arguments as text.
export function checkError(check, template, ...argumentTexts) {
  const encoded = argumentTexts.map((text) => encoder.encode(String(text)));
  const input = check.message_input(4 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0));
  if (input === 0) throw new Error(`text ink check: the module could not grow its memory for message ${template}`);
  const view = new DataView(check.memory.buffer);
  view.setUint32(input, encoded.length, true);
  let at = input + 4;
  for (const bytes of encoded) {
    view.setUint32(at, bytes.length, true);
    new Uint8Array(check.memory.buffer, at + 4, bytes.length).set(bytes);
    at += 4 + bytes.length;
  }
  const length = check.message(template);
  if (length < 0) throw new Error(`text ink check: the module could not grow its memory for message ${template}`);
  const text = decoder.decode(new Uint8Array(check.memory.buffer, check.message_output(), length));
  return new ERROR_CLASSES[check.message_kind(template)](text);
}

// Throws the error of a nonzero check result.
export function throwCheck(check, template, ...argumentTexts) {
  if (template !== 0) throw checkError(check, template, ...argumentTexts);
}

export function statusError(check, table, status, context, subject) {
  return checkError(check, check.status_template(table, status), subject, context);
}

// Writes keyword texts one after another at keyword_input; returns their
// byte lengths.
export function writeKeywords(check, ...keywords) {
  let at = check.keyword_input();
  return keywords.map((keyword) => {
    const bytes = encoder.encode(typeof keyword === "string" ? keyword : "").subarray(0, 128);
    new Uint8Array(check.memory.buffer, at, bytes.length).set(bytes);
    at += bytes.length;
    return bytes.length;
  });
}

function beginRaster(exports, check, width, height, subject) {
  const began = exports.reference_begin(width, height);
  if (began !== 0) throw statusError(check, STATUS_TABLE.reference, began, `raster ${width}x${height}`, subject);
}

function configureEnvelope(exports, check, mechanisms, subject) {
  const {
    lineRadius, curveRadius, curvatureK, curvatureCap, cornerInner, cornerOuter, cornerTurnDegrees, subRows, foldCosine,
  } = mechanisms;
  throwCheck(check, check.corner_turn_check(Number(cornerTurnDegrees)), subject, "", cornerTurnDegrees);
  const configured = exports.envelope_configure(
    lineRadius, curveRadius, curvatureK, curvatureCap, cornerInner, cornerOuter,
    Math.cos(cornerTurnDegrees * Math.PI / 180), subRows, foldCosine,
  );
  if (configured !== 0) throw statusError(check, STATUS_TABLE.reference, configured, JSON.stringify(mechanisms), subject);
}

function raster(exports, base, width, height) {
  return new Float32Array(exports.memory.buffer, base, width * height).slice();
}

// The transform that places a glyph and the key of its distance field in
// the renderer's atlas (`glyph_placement`).
function glyphPlacement(check, command, deviceScale, upem, glyphIndex) {
  const { x: textX, y: textY, baseline } = command.geometry;
  const transform = command.transform ?? [0, 0, 0, 0, 0, 0];
  check.glyph_placement(
    command.fontSize, deviceScale, upem, command.fontStyle === "italic" && command.font.style !== "italic" ? 1 : 0,
    textX, textY, baseline, command.glyphPositions[glyphIndex], command.glyphInkY[glyphIndex],
    command.transform === null ? 0 : 1, ...transform,
  );
  const output = new Float64Array(check.memory.buffer, check.output_base(), 8);
  return {
    transform: [...output.subarray(0, 6)],
    fieldKey: { msdfSize: output[6], minimumUnitsPerTexel: output[7] },
  };
}

/**
 * The key of the distance field of a text command's glyphs in the
 * renderer's atlas at `deviceScale` (`glyph_placement`): the field size and
 * the minimum font units per field texel. It does not depend on the glyph.
 */
export function textCommandFieldKey(command, deviceScale, upem) {
  return glyphPlacement(createTextInkCheck(), command, deviceScale, upem, 0).fieldKey;
}

// The variation coordinates of a text command's glyph outlines, in CSS
// terms: the base pairs `coordinates` of the face, 'opsz' at the command's
// optical size unless font-optical-sizing is none, then each pair of its
// font-variation-settings, which replaces the value of the axis it names
// (CSS Fonts 4, "Font Feature and Variation Resolution").
export function textCommandVariations(command, coordinates) {
  const axes = new Map(coordinates);
  if (command.opticalSizing !== "none") axes.set("opsz", command.opticalSize);
  for (const [tag, value] of command.variationSettings) axes.set(tag, value);
  return [...axes];
}

export function createTextInkReference() {
  const exports = instantiate({}).exports;
  const check = createTextInkCheck();
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
      throwCheck(check, check.text_command_check(command.textShadow ? 1 : 0, command.font === null ? 1 : 0),
        "text ink reference", label);
      const fontBytes = resolveFontBytes(command.font);
      if (!(fontBytes instanceof Uint8Array)) {
        throw new TypeError(`text ink reference: resolveFontBytes returned no bytes for ${label} (${JSON.stringify(command.font)})`);
      }
      const variations = textCommandVariations(command, [
        ["wght", command.fontWeight],
        ["slnt", command.font.slant],
        ["wdth", command.font.stretch],
      ]);
      for (let glyphIndex = 0; glyphIndex < command.glyphIds.length; glyphIndex++) {
        const glyphId = command.glyphIds[glyphIndex];
        if (glyphId === 0xFFFF) continue;
        const { verbs, upem } = await outlineFor(fontBytes, variations, glyphId);
        if (verbs.length === 0) continue;
        const { transform, fieldKey } = glyphPlacement(check, command, deviceScale, upem, glyphIndex);
        yield { label: `${label}, glyph ${glyphId}`, verbs, transform, fieldKey };
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
    if (pointer === 0) throw inkStatusError(STATUS_ALLOCATION_FAILED, glyph.label);
    new Uint8Array(exports.memory.buffer, pointer, glyph.verbs.length).set(glyph.verbs);
  }

  function inkStatusError(status, context) {
    return statusError(check, STATUS_TABLE.reference, status, context, "text ink reference");
  }

  function begin(width, height) {
    beginRaster(exports, check, width, height, "text ink reference");
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
      if (added < 0) throw inkStatusError(added, glyph.label);
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
    configureEnvelope(exports, check, mechanisms, "text ink reference");
    for await (const glyph of placedGlyphs(textCommands(displayList, commandIndices), deviceScale, resolveFontBytes)) {
      copyVerbs(glyph);
      const added = exports.envelope_add_glyph(glyph.verbs.length, ...glyph.transform, chordTolerance,
        glyph.fieldKey.msdfSize, glyph.fieldKey.minimumUnitsPerTexel);
      if (added < 0) throw inkStatusError(added, glyph.label);
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

/**
 * The outline parts of a stroke, as the module numbers them on each outline
 * edge (plans/PLAN-svg-source-truth.md, slice 2), with the outline part
 * class the stress report names and the mechanism whose band they carry.
 */
export const SVG_STROKE_PARTS = Object.freeze(new Map([
  ["SIDE", { name: "side", part: "side", mechanism: "sandomEdge" }],
  ["CURVE_SIDE", { name: "curve side", part: "curve", mechanism: "sandomCurvature" }],
  ["BUTT_END", { name: "butt end", part: "cap", mechanism: "sandomEdge" }],
  ["ROUND_CAP", { name: "round cap", part: "cap", mechanism: "sandomCurvature" }],
  ["SQUARE_CAP", { name: "square cap", part: "cap", mechanism: "sandomEdge" }],
  ["ROUND_JOIN", { name: "round join", part: "join", mechanism: "sandomCurvature" }],
  ["BEVEL_EDGE", { name: "bevel edge", part: "join", mechanism: "sandomEdge" }],
  ["MITER_EDGE", { name: "miter edge", part: "join", mechanism: "sandomEdge" }],
].map(([part, record]) => [referenceConstant(`SVG_PART_${part}`), Object.freeze(record)])));

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
 *
 * A path may instead be a glyph, `{ glyph: { verbs, fieldKey }, transform,
 * label }`: a glyph outline's verbs (glyphOutline() of src/shaping.js, font
 * units, y-up) with the transform from font units to raster pixels, and
 * for an envelope the key of its distance field (`msdfSize`,
 * `minimumUnitsPerTexel`, as the text reference's glyph placement gives
 * it). It takes the glyph coverage and the glyph envelope of the text
 * reference, field ridge included, so SVG text fills composite with SVG
 * paths in one raster.
 */
export function createSvgReference() {
  const exports = instantiate({}).exports;
  const check = createTextInkCheck();
  const subject = "SVG reference";

  function pathError(status, bytes, label) {
    const offset = exports.path_error_offset();
    check.svg_path_error_window(offset);
    const [start, end] = new Uint32Array(check.memory.buffer, check.output_base(), 2);
    const near = JSON.stringify(decoder.decode(bytes.subarray(start, end)));
    return checkError(check, check.svg_path_error(status, exports.path_error_byte(), offset), subject, label, near);
  }

  function strokeArguments(stroke, label) {
    const { width, linecap = "butt", linejoin = "miter", miterlimit = 4, dasharray = [], dashoffset = 0 } = stroke;
    const [capLength, joinLength] = writeKeywords(check, linecap, linejoin);
    const dashes = Array.isArray(dasharray) && dasharray.length <= 256 ? dasharray : [];
    new Float64Array(check.memory.buffer, check.dash_input(), dashes.length)
      .set(dashes.map((value) => typeof value === "number" ? value : NaN));
    throwCheck(
      check,
      check.svg_stroke_check(
        typeof width === "number" ? width : NaN, capLength, joinLength, typeof miterlimit === "number" ? miterlimit : NaN,
        Array.isArray(dasharray) ? 1 : 0, Array.isArray(dasharray) ? dasharray.length : 0,
        typeof dashoffset === "number" ? dashoffset : NaN,
      ),
      subject, label, width, JSON.stringify(linecap), JSON.stringify(linejoin), miterlimit, JSON.stringify(dasharray), dashoffset,
    );
    const [cap, join] = new Int32Array(check.memory.buffer, check.output_base(), 2);
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
      const part = view.getInt32(at + EDGE.PART, true);
      if (part === 0) continue;
      edges.push({
        x0: view.getFloat64(at + EDGE.X0, true), y0: view.getFloat64(at + EDGE.Y0, true),
        x1: view.getFloat64(at + EDGE.X1, true), y1: view.getFloat64(at + EDGE.Y1, true),
        part, radius: view.getFloat64(at + EDGE.RADIUS, true),
      });
    }
    const vertices = [];
    const vertexBase = exports.vertex_base(), vertexStride = exports.vertex_stride();
    for (let index = 0; index < exports.vertex_count(); index++) {
      const at = vertexBase + index * vertexStride;
      vertices.push({
        x: view.getFloat64(at + VERTEX.X, true), y: view.getFloat64(at + VERTEX.Y, true),
        reach: view.getFloat64(at + VERTEX.REACH, true), outer: view.getInt32(at + VERTEX.OUTER, true) === 1,
      });
    }
    return { label, edges, vertices };
  }

  function addGlyph(path, label, chordTolerance, envelope) {
    const { transform, glyph } = path;
    const values = Array.isArray(transform) && transform.length === 6 ? transform : [];
    if (values.length !== 6 || !values.every(Number.isFinite) || !(glyph.verbs instanceof Uint8Array) ||
      (envelope && !(Number.isFinite(glyph.fieldKey?.msdfSize) && Number.isFinite(glyph.fieldKey?.minimumUnitsPerTexel)))) {
      throw new TypeError(`${subject}: the glyph ${label} needs a transform of six finite numbers, its verbs and, for an envelope, its field key`);
    }
    const pointer = exports.reference_verb_buffer(glyph.verbs.length);
    if (pointer === 0) throw statusError(check, STATUS_TABLE.reference, STATUS_ALLOCATION_FAILED, label, subject);
    new Uint8Array(exports.memory.buffer, pointer, glyph.verbs.length).set(glyph.verbs);
    const added = envelope
      ? exports.envelope_add_glyph(glyph.verbs.length, ...transform, chordTolerance, glyph.fieldKey.msdfSize, glyph.fieldKey.minimumUnitsPerTexel)
      : exports.reference_add_glyph(glyph.verbs.length, ...transform, chordTolerance);
    if (added < 0) throw statusError(check, STATUS_TABLE.reference, added, label, subject);
  }

  function addPaths(paths, chordTolerance, envelope) {
    throwCheck(check, Array.isArray(paths) ? 0 : TEMPLATE_PATHS_NOT_ARRAY, subject);
    const outlines = [];
    paths.forEach((path, index) => {
      const label = path.label ?? `path ${index}`;
      if (path.glyph !== undefined) {
        addGlyph(path, label, chordTolerance, envelope);
        if (envelope) outlines.push(strokeOutline(label));
        return;
      }
      const { transform } = path;
      const values = Array.isArray(transform) && transform.length === 6
        ? transform.map((value) => typeof value === "number" ? value : NaN)
        : [NaN, NaN, NaN, NaN, NaN, NaN];
      throwCheck(
        check,
        check.svg_path_check(
          typeof path.d === "string" ? 1 : 0, Array.isArray(transform) ? 1 : 0, Array.isArray(transform) ? transform.length : 0,
          ...values, path.stroke !== undefined ? 1 : 0, path.fillRule !== undefined ? 1 : 0,
        ),
        subject, label, JSON.stringify(transform),
      );
      const bytes = encoder.encode(path.d);
      let added;
      if (path.stroke !== undefined) {
        const stroke = strokeArguments(path.stroke, label);
        const pointer = exports.reference_verb_buffer(bytes.length);
        if (pointer === 0) throw statusError(check, STATUS_TABLE.reference, STATUS_ALLOCATION_FAILED, label, subject);
        new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
        added = (envelope ? exports.envelope_add_stroke : exports.reference_add_stroke)(
          bytes.length, ...transform, chordTolerance, ...stroke,
        );
        if (added < 0) throw pathError(added, bytes, label);
        if (envelope) outlines.push(strokeOutline(label));
      } else {
        const [ruleLength] = writeKeywords(check, path.fillRule);
        const rule = check.svg_fill_rule(ruleLength);
        throwCheck(check, rule < 0 ? -rule : 0, subject, label, JSON.stringify(path.fillRule));
        const pointer = exports.reference_verb_buffer(bytes.length);
        if (pointer === 0) throw statusError(check, STATUS_TABLE.reference, STATUS_ALLOCATION_FAILED, label, subject);
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
    beginRaster(exports, check, width, height, subject);
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
    beginRaster(exports, check, width, height, subject);
    configureEnvelope(exports, check, mechanisms, subject);
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
    beginRaster(exports, check, 1, 1, subject);
    addPaths([stroke === undefined ? { d, transform, fillRule: "nonzero", label } : { d, transform, stroke, label }], chordTolerance, false);
    const values = new Float64Array(exports.memory.buffer, exports.outline_bounds(), 4);
    return [values[0], values[1], values[2] - values[0], values[3] - values[1]];
  }

  return Object.freeze({ render, envelope, bounds, exports });
}

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
  const check = createTextInkCheck();
  const subject = "SVG paint reference";

  function checked(status, what) {
    if (status < 0) throw statusError(check, STATUS_TABLE.paint, status, what, subject);
    return status;
  }

  function alloc(bytes, what) {
    const pointer = exports.paint_alloc(bytes);
    if (pointer === 0) throw statusError(check, STATUS_TABLE.paint, STATUS_ALLOCATION_FAILED, what, subject);
    return pointer;
  }

  /** A zeroed plane over `rect`, filled from `data` (Float32Array) when given. */
  function plane(rect, data = null) {
    const { x, y, width, height } = rect;
    const number = (value) => typeof value === "number" ? value : NaN;
    throwCheck(check, check.svg_plane_check(number(x), number(y), number(width), number(height)), subject, "", JSON.stringify(rect));
    const pointer = alloc(width * height * 4, `a ${width}x${height} plane`);
    if (data !== null) {
      throwCheck(check, check.svg_plane_data_check(data.length, width, height), subject, "", data.length, width, height);
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
    const table = alloc(layers.length * LAYER.SIZE, "the source layer table");
    const view = new DataView(exports.memory.buffer);
    layers.forEach(({ lo, hi, alpha }, index) => {
      view.setInt32(table + index * LAYER.SIZE + LAYER.LOWER, lo.pointer, true);
      view.setInt32(table + index * LAYER.SIZE + LAYER.UPPER, hi.pointer, true);
      view.setFloat64(table + index * LAYER.SIZE + LAYER.ALPHA, alpha, true);
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
    if (distance < 0) throw statusError(check, STATUS_TABLE.paint, STATUS_ALLOCATION_FAILED, "the box and Gaussian kernels", subject);
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
    const [kindLength, spreadLength] = writeKeywords(check, kind, spread);
    const matrixValues = Array.isArray(matrix) && matrix.length === 6
      ? matrix.map((value) => typeof value === "number" ? value : NaN)
      : [NaN, NaN, NaN, NaN, NaN, NaN];
    throwCheck(check, check.svg_gradient_check(kindLength, spreadLength, stops?.length ?? NaN, matrix?.length ?? NaN, ...matrixValues),
      subject, label);
    const [kindNumber, spreadNumber] = new Int32Array(check.memory.buffer, check.output_base(), 2);
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
