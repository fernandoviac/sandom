// The metrics projection (core/engine/metrics-projection.watpart): the layer
// metrics of one revision as a retained record. The facade gives the
// metrics artifact's fields (kind "document-layer-metrics", version 3) and
// builds them on the first read. Its owner releases it; a later read throws.
import { layoutConstant } from "../wasm/layout-table.js";
import { identifyCore } from "./core-identity.js";
import { registerProjectionFacade } from "./native-projections.js";

const KIND_METRICS = layoutConstant("PROJECTION_KIND_METRICS");
const metrics = (name) => layoutConstant(`METRICS_${name}`);
const fields = (prefix, names) => Object.freeze(Object.fromEntries(names.map((name) => [name, metrics(`${prefix}_${name}`)])));
const INPUT = fields("INPUT", [
  "HEADER_SIZE", "NODE_COUNT", "NODES", "CHILDREN", "CHILD_COUNT", "SELECTION", "SELECTION_COUNT", "SCENE_MAP",
  "SCENE_COUNT", "SIZING_SOURCE", "SIZING_SOURCE_LENGTH", "WORLD_KEY", "WORLD_KEY_LENGTH", "PAINT", "WIDTH", "HEIGHT",
  "NODE_SIZE", "NODE_IDENTIFIER", "NODE_IDENTIFIER_LENGTH", "NODE_CHILD_FIRST", "NODE_CHILD_COUNT",
  "NODE_HAS_RECTANGLE", "NODE_X", "NODE_Y", "NODE_WIDTH", "NODE_HEIGHT",
]);
const HEADER = fields("HEADER", [
  "TOTAL", "NODE_COUNT", "NODES", "CHILDREN", "SELECTION", "SELECTION_COUNT", "CHUNK_COUNT", "CHUNKS", "NODE_CHUNKS",
  "ADVANCES", "SIZING_SOURCE", "SIZING_SOURCE_LENGTH", "WORLD_KEY", "WORLD_KEY_LENGTH", "WIDTH", "HEIGHT",
]);
const NODE = fields("NODE", [
  "SIZE", "IDENTIFIER", "IDENTIFIER_LENGTH", "CHILD_FIRST", "CHILD_COUNT", "HAS_RECTANGLE", "CHUNK_FIRST",
  "CHUNK_COUNT", "X", "Y", "WIDTH", "HEIGHT",
]);
const CHUNK = fields("CHUNK", [
  "SIZE", "NODE", "TEXT", "TEXT_LENGTH", "ADVANCE_FIRST", "ADVANCE_COUNT", "FONT_SIZE", "LINE_HEIGHT", "ASCENT",
  "DESCENT", "BASELINE_X", "BASELINE_Y",
]);
const ARTIFACT_VERSION = metrics("ARTIFACT_VERSION");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function metricsFacade(core, handle, onRelease) {
  let artifact = null;
  const record = () => {
    const block = core.status("projection_block", handle, KIND_METRICS);
    return { block, view: new DataView(core.refreshBytes().buffer) };
  };
  const materialize = () => {
    if (artifact !== null) {
      record();
      return artifact;
    }
    const { block, view } = record();
    const at = (field) => block + view.getUint32(block + field, true);
    // The string whose block-relative offset is at `row + field` and whose
    // byte length is at `row + lengthField`.
    const string = (row, field, lengthField) =>
      decoder.decode(new Uint8Array(view.buffer, block + view.getUint32(row + field, true),
        view.getUint32(row + lengthField, true)));
    const nodesBase = at(HEADER.NODES);
    const childrenBase = at(HEADER.CHILDREN);
    const selectionBase = at(HEADER.SELECTION);
    const chunksBase = at(HEADER.CHUNKS);
    const nodeChunksBase = at(HEADER.NODE_CHUNKS);
    const advancesBase = at(HEADER.ADVANCES);
    const nodeCount = view.getUint32(block + HEADER.NODE_COUNT, true);
    const identifiers = Array.from({ length: nodeCount }, (_, index) =>
      string(nodesBase + index * NODE.SIZE, NODE.IDENTIFIER, NODE.IDENTIFIER_LENGTH));
    const textChunks = Array.from({ length: view.getUint32(block + HEADER.CHUNK_COUNT, true) }, (_, index) => {
      const row = chunksBase + index * CHUNK.SIZE;
      const advanceFirst = view.getUint32(row + CHUNK.ADVANCE_FIRST, true);
      return Object.freeze({
        nodeIdentifier: identifiers[view.getUint32(row + CHUNK.NODE, true)],
        text: string(row, CHUNK.TEXT, CHUNK.TEXT_LENGTH),
        fontSize: view.getFloat64(row + CHUNK.FONT_SIZE, true),
        lineHeight: view.getFloat64(row + CHUNK.LINE_HEIGHT, true),
        ascent: view.getFloat64(row + CHUNK.ASCENT, true),
        descent: view.getFloat64(row + CHUNK.DESCENT, true),
        baseline: Object.freeze({
          x: view.getFloat64(row + CHUNK.BASELINE_X, true),
          y: view.getFloat64(row + CHUNK.BASELINE_Y, true),
        }),
        glyphAdvances: Object.freeze(Array.from(
          { length: view.getUint32(row + CHUNK.ADVANCE_COUNT, true) },
          (_, glyph) => view.getFloat64(advancesBase + (advanceFirst + glyph) * 8, true),
        )),
      });
    });
    const nodes = identifiers.map((nodeIdentifier, index) => {
      const row = nodesBase + index * NODE.SIZE;
      const childFirst = view.getUint32(row + NODE.CHILD_FIRST, true);
      const chunkFirst = view.getUint32(row + NODE.CHUNK_FIRST, true);
      return Object.freeze({
        nodeIdentifier,
        childIdentifiers: Object.freeze(Array.from({ length: view.getUint32(row + NODE.CHILD_COUNT, true) },
          (_, child) => identifiers[view.getUint32(childrenBase + (childFirst + child) * 4, true)])),
        rectangle: view.getUint32(row + NODE.HAS_RECTANGLE, true)
          ? Object.freeze({
            x: view.getFloat64(row + NODE.X, true),
            y: view.getFloat64(row + NODE.Y, true),
            width: view.getFloat64(row + NODE.WIDTH, true),
            height: view.getFloat64(row + NODE.HEIGHT, true),
          })
          : null,
        textChunks: Object.freeze(Array.from({ length: view.getUint32(row + NODE.CHUNK_COUNT, true) },
          (_, chunk) => textChunks[view.getUint32(nodeChunksBase + (chunkFirst + chunk) * 4, true)])),
      });
    });
    artifact = {
      sizingSource: string(block, HEADER.SIZING_SOURCE, HEADER.SIZING_SOURCE_LENGTH),
      worldKey: string(block, HEADER.WORLD_KEY, HEADER.WORLD_KEY_LENGTH),
      viewport: Object.freeze({
        width: view.getFloat64(block + HEADER.WIDTH, true),
        height: view.getFloat64(block + HEADER.HEIGHT, true),
      }),
      nodeIdentifiers: Object.freeze(Array.from({ length: view.getUint32(block + HEADER.SELECTION_COUNT, true) },
        (_, index) => identifiers[view.getUint32(selectionBase + index * 4, true)])),
      includedNodeIdentifiers: Object.freeze(identifiers),
      nodes: Object.freeze(nodes),
      textChunks: Object.freeze(textChunks),
    };
    return artifact;
  };
  const field = (name) => ({ get: () => materialize()[name], enumerable: true });
  const facade = Object.defineProperties({}, {
    kind: { value: "document-layer-metrics", enumerable: true },
    version: { value: ARTIFACT_VERSION, enumerable: true },
    sizingSource: field("sizingSource"),
    worldKey: field("worldKey"),
    viewport: field("viewport"),
    nodeIdentifiers: field("nodeIdentifiers"),
    includedNodeIdentifiers: field("includedNodeIdentifiers"),
    nodes: field("nodes"),
    textChunks: field("textChunks"),
    handle: { value: handle },
    // A copy of the record's bytes: the record holds only offsets from its
    // own start, so loadMetrics() in any core of this build loads them.
    bytes: {
      value() {
        const { block, view } = record();
        return new Uint8Array(view.buffer, block, view.getUint32(block + HEADER.TOTAL, true)).slice();
      },
    },
    // Frees the record; a later read throws.
    release: {
      value() {
        core.status("projection_release", handle, KIND_METRICS);
        onRelease?.(facade);
      },
    },
  });
  Object.freeze(facade);
  registerProjectionFacade(facade, core, handle, KIND_METRICS);
  return facade;
}

// Captures the metrics record of one report: `nodes` in report order, each
// `{ identifier, childIndices, rectangle }` (rectangle null without a box),
// `selection` (node indices), `sceneNodes` (for each scene row of `paint`,
// its report node index or -1), the paint record of the same revision, the
// sizing source, the layout world key, and the viewport.
export function captureMetrics(core, {
  nodes,
  selection,
  sceneNodes,
  paint,
  sizingSource,
  worldKey,
  viewport,
  onRelease,
}) {
  identifyCore(core);
  const identifiers = nodes.map((node) => encoder.encode(node.identifier));
  const sizing = encoder.encode(sizingSource);
  const key = encoder.encode(worldKey);
  const childCount = nodes.reduce((total, node) => total + node.childIndices.length, 0);
  const nodesOffset = INPUT.HEADER_SIZE;
  const childrenOffset = nodesOffset + nodes.length * INPUT.NODE_SIZE;
  const selectionOffset = childrenOffset + childCount * 4;
  const sceneOffset = selectionOffset + selection.length * 4;
  let stringOffset = sceneOffset + sceneNodes.length * 4;
  const stringLength = identifiers.reduce((total, bytes) => total + bytes.length, sizing.length + key.length);
  const input = core.exports.abi_allocate(stringOffset + stringLength);
  if (!input) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  const placeString = (row, field, lengthField, value) => {
    bytes.set(value, input + stringOffset);
    view.setUint32(row + field, input + stringOffset, true);
    view.setUint32(row + lengthField, value.length, true);
    stringOffset += value.length;
  };
  view.setUint32(input + INPUT.NODE_COUNT, nodes.length, true);
  view.setUint32(input + INPUT.NODES, input + nodesOffset, true);
  view.setUint32(input + INPUT.CHILDREN, input + childrenOffset, true);
  view.setUint32(input + INPUT.CHILD_COUNT, childCount, true);
  view.setUint32(input + INPUT.SELECTION, input + selectionOffset, true);
  view.setUint32(input + INPUT.SELECTION_COUNT, selection.length, true);
  view.setUint32(input + INPUT.SCENE_MAP, input + sceneOffset, true);
  view.setUint32(input + INPUT.SCENE_COUNT, sceneNodes.length, true);
  placeString(input, INPUT.SIZING_SOURCE, INPUT.SIZING_SOURCE_LENGTH, sizing);
  placeString(input, INPUT.WORLD_KEY, INPUT.WORLD_KEY_LENGTH, key);
  view.setBigInt64(input + INPUT.PAINT, BigInt.asIntN(64, paint.handle), true);
  view.setFloat64(input + INPUT.WIDTH, viewport.width, true);
  view.setFloat64(input + INPUT.HEIGHT, viewport.height, true);
  let childCursor = 0;
  nodes.forEach((node, index) => {
    const row = input + nodesOffset + index * INPUT.NODE_SIZE;
    placeString(row, INPUT.NODE_IDENTIFIER, INPUT.NODE_IDENTIFIER_LENGTH, identifiers[index]);
    view.setUint32(row + INPUT.NODE_CHILD_FIRST, childCursor, true);
    view.setUint32(row + INPUT.NODE_CHILD_COUNT, node.childIndices.length, true);
    for (const child of node.childIndices) {
      view.setUint32(input + childrenOffset + childCursor * 4, child, true);
      childCursor += 1;
    }
    view.setUint32(row + INPUT.NODE_HAS_RECTANGLE, node.rectangle === null ? 0 : 1, true);
    view.setFloat64(row + INPUT.NODE_X, node.rectangle?.x ?? 0, true);
    view.setFloat64(row + INPUT.NODE_Y, node.rectangle?.y ?? 0, true);
    view.setFloat64(row + INPUT.NODE_WIDTH, node.rectangle?.width ?? 0, true);
    view.setFloat64(row + INPUT.NODE_HEIGHT, node.rectangle?.height ?? 0, true);
  });
  selection.forEach((index, position) => view.setUint32(input + selectionOffset + position * 4, index, true));
  sceneNodes.forEach((index, row) => view.setInt32(input + sceneOffset + row * 4, index, true));
  return metricsFacade(core, core.status("metrics_capture", input), onRelease);
}

// Loads `bytes` that a metrics record's bytes() gave as a metrics record of
// `core`. The core checks the record version and the layout and throws a
// RangeError that names the first field that breaks it.
export function loadMetrics(core, bytes, { onRelease } = {}) {
  identifyCore(core);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`loadMetrics takes a Uint8Array that a metrics record's bytes() gave; received ${bytes === null ? "null" : typeof bytes}`);
  }
  const input = core.exports.abi_allocate(bytes.length);
  if (!input) core.throwIfError();
  core.refreshBytes().set(bytes, input);
  return metricsFacade(core, core.status("metrics_load", input, bytes.length), onRelease);
}

export { KIND_METRICS };
