// Automatic viewport recommendation. The core decides
// (output-viewport.watpart): it asks for each candidate layout, measures
// the facts that come back as one trial, and selects a trial or rejects
// them all. This binding performs the layouts and builds the result
// records from the core's trials, in attempt order, so a caller can render
// the decision.

import { inspectPreparedInput } from "./render-animation.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The records of output-viewport.watpart, by WAT name without the
// VIEWPORT_ prefix.
const VIEWPORT = Object.freeze(Object.fromEntries([
  "ROW_SIZE", "ROW_NODE", "ROW_FLAGS", "ROW_X", "ROW_Y", "ROW_WIDTH", "ROW_HEIGHT", "ROW_DECLARED_WIDTH",
  "ROW_DECLARED_HEIGHT", "ROW_INTRINSIC_WIDTH", "ROW_INTRINSIC_HEIGHT", "ROW_NAME_POINTER", "ROW_NAME_LENGTH",
  "ROW_DISPLAY_POINTER", "ROW_DISPLAY_LENGTH", "ROW_LAYS_OUT", "ROW_TEXT", "ROW_IMAGE", "ROW_BACKGROUND",
  "ROW_VIEWPORT_SIZED", "ROW_NO_PARENT", "ROW_INTRINSIC",
  "REQUEST_WIDTH", "REQUEST_HEIGHT",
  "RESULT_SELECTED", "RESULT_CONFIDENCE", "RESULT_FIRST_REASON", "RESULT_REASON_COUNT",
  "TRIAL_BOUNDS", "TRIAL_OUTER_SPACE", "TRIAL_OCCUPANCY", "TRIAL_SOURCE", "TRIAL_FLAGS", "TRIAL_LINE_COUNT",
  "TRIAL_CONSTRAINT_COUNT", "TRIAL_CONSTRAINTS", "TRIAL_VALID", "TRIAL_OVERFLOW", "TRIAL_WRAPPING",
  "TRIAL_CONTROL_OVERLAP", "CONSTRAINT_CODE", "CONSTRAINT_MESSAGE", "CONSTRAINT_NODE_COUNT", "CONSTRAINT_NODES",
].map((name) => [name, layoutConstant(`VIEWPORT_${name}`)])));
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const VIEWPORT_SESSION_LAYOUT = layoutConstant("VIEWPORT_SESSION_LAYOUT");
const VIEWPORT_SESSION_SELECTED = layoutConstant("VIEWPORT_SESSION_SELECTED");

function viewportText(id) {
  core.status("output_viewport_text", id);
  return core.outputString();
}

// The facts of one inspected layout as the core's submission rows.
function submitInspection(session, layout) {
  const encoder = new TextEncoder();
  const names = layout.nodes.map((node) => encoder.encode(node.nodeName ?? ""));
  const displays = layout.nodes.map((node) => encoder.encode(node.display ?? ""));
  const textBytes = names.reduce((sum, bytes) => sum + bytes.byteLength, 0) +
    displays.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const rowBytes = layout.nodes.length * VIEWPORT.ROW_SIZE;
  const lineBytes = layout.textLineBoxes.length * U32;
  const byteLength = Math.max(8, rowBytes + lineBytes + textBytes);
  const pointer = core.exports.abi_allocate(byteLength);
  if (!pointer) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  let text = pointer + rowBytes + lineBytes;
  const place = (encoded) => {
    bytes.set(encoded, text);
    const at = text;
    text += encoded.byteLength;
    return at;
  };
  layout.nodes.forEach((node, index) => {
    const row = pointer + index * VIEWPORT.ROW_SIZE;
    const box = node.borderBox;
    view.setUint32(row + VIEWPORT.ROW_NODE, node.nodeIndex, true);
    view.setUint32(row + VIEWPORT.ROW_FLAGS,
      (node.participatesInLayout ? VIEWPORT.ROW_LAYS_OUT : 0) | (node.hasText ? VIEWPORT.ROW_TEXT : 0) |
      (node.hasImage ? VIEWPORT.ROW_IMAGE : 0) | (node.hasBackground ? VIEWPORT.ROW_BACKGROUND : 0) |
      (node.viewportSizedBackground ? VIEWPORT.ROW_VIEWPORT_SIZED : 0) |
      (node.parentIndex === null ? VIEWPORT.ROW_NO_PARENT : 0) | (node.intrinsicDimensions ? VIEWPORT.ROW_INTRINSIC : 0),
      true);
    view.setFloat64(row + VIEWPORT.ROW_X, box?.x ?? 0, true);
    view.setFloat64(row + VIEWPORT.ROW_Y, box?.y ?? 0, true);
    view.setFloat64(row + VIEWPORT.ROW_WIDTH, box?.width ?? 0, true);
    view.setFloat64(row + VIEWPORT.ROW_HEIGHT, box?.height ?? 0, true);
    view.setFloat64(row + VIEWPORT.ROW_DECLARED_WIDTH, node.declaredWidth ?? NaN, true);
    view.setFloat64(row + VIEWPORT.ROW_DECLARED_HEIGHT, node.declaredHeight ?? NaN, true);
    view.setFloat64(row + VIEWPORT.ROW_INTRINSIC_WIDTH, node.intrinsicDimensions?.width ?? NaN, true);
    view.setFloat64(row + VIEWPORT.ROW_INTRINSIC_HEIGHT, node.intrinsicDimensions?.height ?? NaN, true);
    view.setUint32(row + VIEWPORT.ROW_NAME_POINTER, place(names[index]), true);
    view.setUint32(row + VIEWPORT.ROW_NAME_LENGTH, names[index].byteLength, true);
    view.setUint32(row + VIEWPORT.ROW_DISPLAY_POINTER, place(displays[index]), true);
    view.setUint32(row + VIEWPORT.ROW_DISPLAY_LENGTH, displays[index].byteLength, true);
  });
  layout.textLineBoxes.forEach((line, index) =>
    view.setUint32(pointer + rowBytes + index * U32, line.nodeIndex, true));
  core.status("output_viewport_session_submit", session,
    pointer, layout.nodes.length, pointer + rowBytes, layout.textLineBoxes.length,
    layout.viewport.width, layout.viewport.height,
    layout.overflow.left, layout.overflow.top, layout.overflow.right, layout.overflow.bottom,
    layout.documentScrollBounds.width, layout.documentScrollBounds.height);
}

// The core's record of trial `sequence`, with the failed constraints that
// name nodes of its layout.
function readTrial(session, sequence, inspection) {
  core.status("output_viewport_session_trial", session, sequence);
  const output = core.exports.abi_output_pointer();
  const view = new DataView(core.refreshBytes().buffer);
  const numbers = (field, count) =>
    Array.from({ length: count }, (_, index) => view.getFloat64(output + field + index * F64, true));
  const word = (field) => view.getUint32(output + field, true);
  const record = {
    bounds: numbers(VIEWPORT.TRIAL_BOUNDS, 4),
    outerSpace: numbers(VIEWPORT.TRIAL_OUTER_SPACE, 4),
    occupancy: numbers(VIEWPORT.TRIAL_OCCUPANCY, 3),
    source: word(VIEWPORT.TRIAL_SOURCE),
    flags: word(VIEWPORT.TRIAL_FLAGS),
    lineCount: word(VIEWPORT.TRIAL_LINE_COUNT),
    constraints: [],
  };
  let cursor = output + VIEWPORT.TRIAL_CONSTRAINTS;
  for (let index = word(VIEWPORT.TRIAL_CONSTRAINT_COUNT); index > 0; index--) {
    const nodeCount = view.getUint32(cursor + VIEWPORT.CONSTRAINT_NODE_COUNT, true);
    const nodes = cursor + VIEWPORT.CONSTRAINT_NODES;
    record.constraints.push({
      code: view.getUint32(cursor + VIEWPORT.CONSTRAINT_CODE, true),
      message: view.getUint32(cursor + VIEWPORT.CONSTRAINT_MESSAGE, true),
      nodeIndices: Array.from({ length: nodeCount }, (_, node) => view.getUint32(nodes + node * U32, true)),
    });
    cursor = nodes + nodeCount * U32;
  }
  const factsByIndex = new Map(inspection.layout.nodes.map((node) => [node.nodeIndex, node]));
  const viewport = inspection.layout.viewport;
  const [x, y, width, height] = record.bounds;
  const [left, top, right, bottom] = record.outerSpace;
  return {
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    constraints: Object.freeze(record.constraints.map(({ code, message, nodeIndices }) =>
      Object.freeze({
        code: viewportText(code),
        message: viewportText(message),
        nodes: Object.freeze(nodeIndices.map((nodeIndex) => {
          const node = factsByIndex.get(nodeIndex);
          return Object.freeze({ nodeIndex, nodeName: node?.nodeName ?? null, id: node?.id ?? null });
        })),
      })
    )),
    trial: Object.freeze({
      sequence,
      viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
      source: viewportText(record.source),
      valid: (record.flags & VIEWPORT.TRIAL_VALID) !== 0,
      contentBounds: Object.freeze({ x, y, width, height }),
      outerSpace: Object.freeze({ left, top, right, bottom }),
      occupancy: Object.freeze({
        horizontal: record.occupancy[0],
        vertical: record.occupancy[1],
        area: record.occupancy[2],
      }),
      controlOverlap: (record.flags & VIEWPORT.TRIAL_CONTROL_OVERLAP) !== 0,
      documentScrollBounds: Object.freeze({ ...inspection.layout.documentScrollBounds }),
      overflow: (record.flags & VIEWPORT.TRIAL_OVERFLOW) !== 0,
      avoidableWrapping: (record.flags & VIEWPORT.TRIAL_WRAPPING) !== 0,
      textLineCount: record.lineCount,
      failedConstraints: null,
    }),
  };
}

export async function recommendViewportFromInspection(
  inspectLayout,
  options = {},
) {
  if (typeof inspectLayout !== "function") {
    throw new TypeError("inspectLayout must be a function");
  }
  const initialViewport = options.initialViewport ??
    { width: 1280, height: 720 };
  const limits = options.limits ?? {};
  const limitValues = [limits.minimumWidth, limits.minimumHeight, limits.maximumWidth, limits.maximumHeight];
  const session = core.handle("output_viewport_session_create",
    limitValues.reduce((present, value, index) => present | (value == null ? 0 : 1 << index), 0),
    ...limitValues.map((value) => value == null ? NaN : Number(value)),
    Number(initialViewport.width), Number(initialViewport.height));
  try {
    const inspections = [];
    let action;
    while ((action = core.status("output_viewport_session_next", session)) === VIEWPORT_SESSION_LAYOUT) {
      const output = core.exports.abi_output_pointer();
      const view = new DataView(core.refreshBytes().buffer);
      const width = view.getFloat64(output + VIEWPORT.REQUEST_WIDTH, true);
      const height = view.getFloat64(output + VIEWPORT.REQUEST_HEIGHT, true);
      const inspection = await inspectLayout({ width, height });
      inspections.push(inspection);
      submitInspection(session, inspection.layout);
    }
    core.status("output_viewport_session_result", session);
    const output = core.exports.abi_output_pointer();
    const resultView = new DataView(core.refreshBytes().buffer);
    const [selectedIndex, confidenceText, firstReason, reasonCount] =
      [VIEWPORT.RESULT_SELECTED, VIEWPORT.RESULT_CONFIDENCE, VIEWPORT.RESULT_FIRST_REASON, VIEWPORT.RESULT_REASON_COUNT]
        .map((field) => resultView.getUint32(output + field, true));
    const records = inspections.map((inspection, sequence) => readTrial(session, sequence, inspection));
    const trials = Object.freeze(records.map(({ trial, constraints }) =>
      Object.freeze({ ...trial, failedConstraints: Object.freeze(constraints.map(({ code }) => code)) })
    ));
    const reasons = Array.from({ length: reasonCount }, (_, index) => viewportText(firstReason + index));
    if (action === VIEWPORT_SESSION_SELECTED) {
      return Object.freeze({
        kind: "viewport-recommendation",
        version: 1,
        classification: "selected",
        viewport: records[selectedIndex].viewport,
        confidence: viewportText(confidenceText),
        trials,
        reasons: Object.freeze(reasons),
      });
    }
    return Object.freeze({
      kind: "viewport-recommendation",
      version: 1,
      classification: "none-valid",
      viewport: null,
      confidence: "unavailable",
      rejections: Object.freeze(records.map(({ viewport, constraints }) =>
        Object.freeze({ viewport, constraints }))),
      trials,
      reason: reasons[0],
    });
  } finally {
    core.status("output_viewport_session_release", session);
  }
}

// `scrollbarStyle` selects the scrollbar style of every analytical trial
// (design/scrollbars.md, decision 1); the other options go to
// recommendViewportFromInspection.
export async function recommendViewport(
  preparedInput,
  { scrollbarStyle = "overlay", ...options } = {},
) {
  return await recommendViewportFromInspection(
    (viewport) =>
      inspectPreparedInput(preparedInput, {
        mode: "analytical-layout",
        viewport,
        scrollbarStyle,
      }),
    options,
  );
}
