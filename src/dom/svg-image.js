// External SVG paint servers stay in the DOM and use native row lowering.
// Image-local clip definitions become CSS path() authoring input. The core
// finds the definitions and checks the references (svg_image_definitions)
// and computes an objectBoundingBox clip's matrix from its target's leaf
// bounds (svg_clip_target_matrix); the host removes the elements, measures
// the bounds of path leaves with the path atlas, and sets the clip-path.
import { hostNow } from "../host-clock.js";
import { serializeToScene } from "./serialize.js";
import { layoutConstant } from "../wasm/layout-table.js";

// `count` f64 values of the output of $operation.
function float64Output(core, operation, count) {
  const view = core.output(operation);
  return Array.from({ length: count }, (_, index) => view.getFloat64(index * Float64Array.BYTES_PER_ELEMENT, true));
}

// The `count` u64 handles of the output of $operation from byte `offset`.
function handleOutput(core, operation, offset, count) {
  if (count === 0) return [];
  const view = core.output(operation);
  return Array.from({ length: count }, (_, index) => view.getBigUint64(offset + index * BigUint64Array.BYTES_PER_ELEMENT, true));
}

const SVG_CLIP_OBJECT_BOUNDING_BOX = layoutConstant("SVG_CLIP_OBJECT_BOUNDING_BOX");
const SVG_CLIP_EVENODD = layoutConstant("SVG_CLIP_EVENODD");
const SVG_CLIP_PERCENTAGE_GEOMETRY = layoutConstant("SVG_CLIP_PERCENTAGE_GEOMETRY");
const SVG_CLIP_LEAF = Object.freeze(Object.fromEntries(["SIZE", "HANDLE", "X_MIN", "Y_MIN", "X_MAX", "Y_MAX"]
  .map((name) => [name, layoutConstant(`SVG_CLIP_LEAF_${name}`)])));

// Clip export $operation failed: its output is the failure's message.
function clipFailure(core, operation, locator) {
  throw new Error(`SVG image ${locator}: ${core.outputString(operation)}`);
}

const identity = [1, 0, 0, 1, 0, 0];

// A path transformed by a matrix (svg_clip_path_transform).
function transformPath(core, path, matrix, locator) {
  const result = core.status("svg_clip_path_transform", ...core.input(path), ...matrix);
  if (result < 0) clipFailure(core, "svg_clip_path_transform", locator);
  return core.outputString("svg_clip_path_transform");
}

// The clip path of a clipPath element, its definition transforms baked in
// (svg_clip_definition).
function clipDefinition(element, locator) {
  const core = element._domCore;
  const result = core.status("svg_clip_definition", element._coreHandle);
  if (result < 0) clipFailure(core, "svg_clip_definition", locator);
  return {
    units: result & SVG_CLIP_OBJECT_BOUNDING_BOX ? "objectBoundingBox" : "userSpaceOnUse",
    d: core.outputString("svg_clip_definition"),
    fillRule: result & SVG_CLIP_EVENODD ? "evenodd" : "nonzero",
  };
}

// The bounds of a basic shape (svg_shape_bounds); null for a path shape.
function shapeBounds(element, node, locator) {
  const core = element._domCore;
  const result = core.status("svg_shape_bounds", element._coreHandle);
  if (result === 0) {
    if (!node.d) throw new Error(`SVG ${element.localName} has no path geometry`);
    return null;
  }
  if (result === SVG_CLIP_PERCENTAGE_GEOMETRY) throw new Error(core.outputString("svg_shape_bounds"));
  if (result < 0) clipFailure(core, "svg_shape_bounds", locator);
  const [xMin, yMin, xMax, yMax] = float64Output(core, "svg_shape_bounds", 4);
  return { xMin, yMin, xMax, yMax };
}

async function pathBoundsFor(pathDef, fillRule, runtime, cache, timings) {
  const key = `${fillRule}\0${pathDef}`;
  let bounds = cache.get(key);
  if (bounds) return bounds;
  const startedAt = timings ? hostNow() : 0;
  bounds = await runtime.sharedSvgPathAtlas.measurePathBounds(pathDef, fillRule);
  if (timings) {
    timings.pathPreparationMilliseconds += hostNow() - startedAt;
  }
  cache.set(key, bounds);
  return bounds;
}

// The objectBoundingBox matrix of the clip of `element`: the bounds of each
// rendered leaf of its target (a basic shape's from its attributes, a
// path's from the path atlas), which svg_clip_target_matrix combines.
async function clipTargetMatrix(element, serialized, runtime, cache, locator, timings) {
  const core = element._domCore;
  const leaves = handleOutput(core, "svg_clip_target_leaves", 0, core.status("svg_clip_target_leaves", element._coreHandle));
  const rows = [];
  for (const handle of leaves) {
    const leaf = core.wrapperFor(handle);
    const index = serialized.indexOf.get(leaf);
    if (index == null) continue;
    const node = serialized.nodes[index];
    const bounds = shapeBounds(leaf, node, locator) ?? await pathBoundsFor(
      node.d, node._coreSvgRequest?.fillRule ?? "nonzero", runtime, cache, timings);
    rows.push([handle, bounds]);
  }
  const bytes = new Uint8Array(rows.length * SVG_CLIP_LEAF.SIZE);
  const view = new DataView(bytes.buffer);
  rows.forEach(([handle, bounds], index) => {
    const row = index * SVG_CLIP_LEAF.SIZE;
    view.setBigUint64(row + SVG_CLIP_LEAF.HANDLE, handle, true);
    view.setFloat64(row + SVG_CLIP_LEAF.X_MIN, bounds.xMin, true);
    view.setFloat64(row + SVG_CLIP_LEAF.Y_MIN, bounds.yMin, true);
    view.setFloat64(row + SVG_CLIP_LEAF.X_MAX, bounds.xMax, true);
    view.setFloat64(row + SVG_CLIP_LEAF.Y_MAX, bounds.yMax, true);
  });
  const [pointer] = core.byteInput(bytes);
  if (core.status("svg_clip_target_matrix", element._coreHandle, pointer, rows.length) < 0) {
    clipFailure(core, "svg_clip_target_matrix", locator);
  }
  return float64Output(core, "svg_clip_target_matrix", 6);
}

export function prepareSvgImageDefinitions(root, core, locator, timings = null) {
  if (core.status("svg_image_definitions", root._coreHandle) < 0) clipFailure(core, "svg_image_definitions", locator);
  const output = core.output("svg_image_definitions");
  const removeCount = output.getUint32(0, true);
  const pairCount = output.getUint32(Uint32Array.BYTES_PER_ELEMENT, true);
  const handles = handleOutput(core, "svg_image_definitions", 2 * Uint32Array.BYTES_PER_ELEMENT, removeCount + 2 * pairCount);
  const removed = handles.slice(0, removeCount).map((handle) => core.wrapperFor(handle));
  const pairs = Array.from({ length: pairCount }, (_, index) => [
    core.wrapperFor(handles[removeCount + 2 * index]),
    core.wrapperFor(handles[removeCount + 2 * index + 1]),
  ]);
  for (const element of removed) element.parentNode.removeChild(element);
  const clipped = new Map();
  const resolvedClips = new Map();
  for (const [element, definition] of pairs) {
    let resolved = resolvedClips.get(definition);
    if (!resolved) {
      resolved = clipDefinition(definition, locator);
      resolvedClips.set(definition, resolved);
    }
    clipped.set(element, resolved);
  }
  const pathBounds = new Map();
  return async (serialized, runtime) => {
    if (clipped.size === 0) return serialized;
    try {
      for (const [element, clip] of clipped) {
        if (serialized.indexOf.get(element) == null) {
          throw new Error(`SVG image ${locator}: unpaintable clipped ${element.localName}`);
        }
        const matrix = clip.units === "objectBoundingBox"
          ? await clipTargetMatrix(element, serialized, runtime, pathBounds, locator, timings)
          : identity;
        const path = transformPath(core, clip.d, matrix, locator);
        if (!path.trim()) {
          throw new Error(`SVG image ${locator}: empty clip-path definition`);
        }
        element.style.setProperty("clip-path", `path(${clip.fillRule}, ${JSON.stringify(path)})`);
      }
      return serializeToScene(root);
    } finally {
      serialized.release();
    }
  };
}
