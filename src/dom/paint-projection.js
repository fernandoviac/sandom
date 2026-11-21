// The paint projection (core/engine/paint-projection.watpart): the core decodes
// one frame's paint command stream into a retained record; the facade gives
// the paint artifact's fields ({ kind: "paint", viewport, boxes,
// operations, compositingGroups }) and builds them on the first read.
//
// The frame that captured a record holds its facade. The record lives
// until the facade is collected: a caller that keeps a frame keeps its
// paint artifact readable. `release()` frees it earlier.
import { BLEND_MODE_NAMES } from "../wasm/layout.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { identifyCore } from "./core-identity.js";
import { projectionHandle, registerProjectionFacade } from "./native-projections.js";

const KIND_PAINT = layoutConstant("PROJECTION_KIND_PAINT");
const paint = (name) => layoutConstant(`PAINT_${name}`);
const fields = (prefix, names) => Object.freeze(Object.fromEntries(names.map((name) => [name, paint(`${prefix}_${name}`)])));
const INPUT = fields("INPUT", [
  "HEADER_SIZE", "COMMANDS", "COMMAND_LENGTH", "GLYPHS", "GLYPH_LENGTH", "NODE_COUNT", "NODES", "WIDTH", "HEIGHT",
  "SCENE_ROWS", "SCENE_ROW_COUNT", "SCENE_CHILDREN", "SCENE_CHILD_COUNT", "NODE_SIZE", "NODE_RUN", "NODE_RUN_LENGTH",
  "NODE_RUN_SOURCE", "NODE_SCENE_SOURCE",
]);
const SCENE_ROW = fields("SCENE_ROW", ["SIZE", "FIRST", "COUNT"]);
const HEADER = fields("HEADER", [
  "OPERATION_COUNT", "OPERATIONS", "GROUP_COUNT", "GROUPS", "CLIP_SETS", "CLIP_ENTRIES", "STATES", "MEMBERS",
  "GLYPHS", "TEXT", "WIDTH", "HEIGHT", "COMMAND_COUNT",
]);
const OPERATION = fields("OPERATION", [
  "SIZE", "COMMAND", "KIND", "NODE", "CLIP_SET", "STATE", "HAS_AFFINE", "X", "Y", "WIDTH", "HEIGHT", "AFFINE", "TEXT",
  "TEXT_LENGTH", "GLYPH_FIRST", "GLYPH_COUNT", "FONT_SIZE", "LINE_HEIGHT", "ASCENT", "DESCENT", "BASELINE_X",
  "BASELINE_Y", "HAS_TEXT", "INDEX",
]);
const GROUP = fields("GROUP", [
  "SIZE", "KIND", "NODE", "START_COMMAND", "END_COMMAND", "START_OPERATION", "END_OPERATION", "OPACITY", "BLEND",
  "STACKING", "HAS_OPACITY", "INDEX", "OUTSIDE",
]);
const CLIP = fields("CLIP", ["SET_SIZE", "SET_FIRST", "SET_COUNT", "SIZE", "FLAGS", "X", "RADII", "AFFINE"]);
const STATE = fields("STATE", [
  "SIZE", "MEMBER_FIRST", "MEMBER_COUNT", "STACKING_FIRST", "STACKING_COUNT", "OPACITY", "BLEND",
]);
const GLYPH = fields("GLYPH", ["SIZE", "X", "WIDTH", "SOURCE_START", "SOURCE_END", "RTL"]);
const CLIP_ENTRY_FLAG_AFFINE = layoutConstant("CLIP_ENTRY_FLAG_AFFINE");
const CLIP_ENTRY_FLAG_PATH_MASK = layoutConstant("CLIP_ENTRY_FLAG_PATH_MASK");

const OPERATION_KIND_NAMES = new Map([
  [paint("KIND_RECTANGLE"), "rectangle"],
  [paint("KIND_TEXT"), "text"],
  [paint("KIND_TEXT_SHADOW"), "text-shadow"],
  [paint("KIND_IMAGE"), "image"],
  [paint("KIND_SVG_PATH"), "svg-path"],
  [paint("KIND_BOX_SHADOW"), "box-shadow"],
]);
const SHAPE_KINDS = new Set([paint("KIND_RECTANGLE"), paint("KIND_IMAGE"), paint("KIND_SVG_PATH")]);
const GROUP_KIND_NAMES = new Map([
  [paint("GROUP_OPACITY_KIND"), "opacity"],
  [paint("GROUP_BACKDROP_FILTER"), "backdrop-filter"],
  [paint("GROUP_MASK_LAYER"), "mask-layer"],
  [paint("GROUP_BLEND_LAYER"), "blend-layer"],
  [paint("GROUP_BACKGROUND"), "background"],
]);
const BLEND_NAMES = new Map(Object.entries(BLEND_MODE_NAMES).map(([name, value]) => [value, name]));

const decoder = new TextDecoder();
const groupIdentifier = (index) => `paint-group-${index}`;

// Frees the record of a collected facade. A record that the caller
// released already is skipped.
const collected = new FinalizationRegistry((held) => {
  if (held.released) return;
  held.released = true;
  held.core.status("projection_release", held.handle, KIND_PAINT);
});

function paintFacade(core, handle) {
  const held = { core, handle, released: false };
  let materialized = null;
  const record = () => {
    const block = core.status("projection_block", handle, KIND_PAINT);
    return { block, view: core.resultMemory("projection_block") };
  };
  const materialize = () => {
    if (materialized !== null) {
      record();
      return materialized;
    }
    const { block, view } = record();
    const at = (field) => block + view.getUint32(block + field, true);
    const operationsBase = at(HEADER.OPERATIONS);
    const groupsBase = at(HEADER.GROUPS);
    const clipSetsBase = at(HEADER.CLIP_SETS);
    const clipEntriesBase = at(HEADER.CLIP_ENTRIES);
    const statesBase = at(HEADER.STATES);
    const membersBase = at(HEADER.MEMBERS);
    const glyphsBase = at(HEADER.GLYPHS);
    const textBase = at(HEADER.TEXT);
    const f32 = (address) => view.getFloat32(address, true);

    const compositingGroups = new Array(view.getUint32(block + HEADER.GROUP_COUNT, true));
    const outsideCompositingGroups = [];
    for (let index = 0; index < compositingGroups.length; index++) {
      const row = groupsBase + index * GROUP.SIZE;
      const kind = view.getUint32(row + GROUP.KIND, true);
      const node = view.getInt32(row + GROUP.NODE, true);
      const group = {
        identifier: groupIdentifier(view.getUint32(row + GROUP.INDEX, true)),
        kind: GROUP_KIND_NAMES.get(kind),
        nodeIndex: node < 0 ? null : node,
        startCommandIndex: view.getInt32(row + GROUP.START_COMMAND, true),
        endCommandIndex: view.getInt32(row + GROUP.END_COMMAND, true),
        startOperationIndex: view.getInt32(row + GROUP.START_OPERATION, true),
        endOperationIndex: view.getInt32(row + GROUP.END_OPERATION, true),
      };
      const blend = view.getInt32(row + GROUP.BLEND, true);
      if (view.getUint32(row + GROUP.HAS_OPACITY, true)) group.opacity = view.getFloat64(row + GROUP.OPACITY, true);
      if (blend >= 0) group.blendMode = BLEND_NAMES.get(blend);
      group.stackingContext = view.getUint32(row + GROUP.STACKING, true) !== 0;
      compositingGroups[index] = group;
      if (view.getUint32(row + GROUP.OUTSIDE, true) !== 0) outsideCompositingGroups.push(group);
    }

    // Clip sets and group states are shared by the operations that point
    // at them, as the decoded stream shared them.
    const emptyClips = [];
    const clipSets = new Map();
    const clipSet = (index) => {
      if (index < 0) return emptyClips;
      let entries = clipSets.get(index);
      if (entries !== undefined) return entries;
      const set = clipSetsBase + index * CLIP.SET_SIZE;
      const first = view.getUint32(set + CLIP.SET_FIRST, true);
      entries = new Array(view.getUint32(set + CLIP.SET_COUNT, true));
      for (let entry = 0; entry < entries.length; entry++) {
        const row = clipEntriesBase + (first + entry) * CLIP.SIZE;
        const flags = view.getUint32(row + CLIP.FLAGS, true);
        entries[entry] = {
          flags,
          x: f32(row + CLIP.X),
          y: f32(row + CLIP.X + 4),
          width: f32(row + CLIP.X + 8),
          height: f32(row + CLIP.X + 12),
          radii: Array.from({ length: 8 }, (_, radius) => f32(row + CLIP.RADII + radius * 4)),
          affine: (flags & CLIP_ENTRY_FLAG_AFFINE) !== 0
            ? Array.from({ length: 6 }, (_, component) => f32(row + CLIP.AFFINE + component * 4))
            : null,
          pathMask: (flags & CLIP_ENTRY_FLAG_PATH_MASK) !== 0,
        };
      }
      clipSets.set(index, entries);
      return entries;
    };
    const states = new Map();
    const groupState = (index) => {
      let state = states.get(index);
      if (state !== undefined) return state;
      const row = statesBase + index * STATE.SIZE;
      const list = (firstField, countField) =>
        Array.from(
          { length: view.getUint32(row + countField, true) },
          (_, member) => groupIdentifier(view.getUint32(membersBase + (view.getUint32(row + firstField, true) + member) * 4, true)),
        );
      const blend = view.getInt32(row + STATE.BLEND, true);
      state = {
        opacity: view.getFloat64(row + STATE.OPACITY, true),
        blendMode: blend < 0 ? "normal" : BLEND_NAMES.get(blend),
        compositingGroupIdentifiers: list(STATE.MEMBER_FIRST, STATE.MEMBER_COUNT),
        stackingContextIdentifiers: list(STATE.STACKING_FIRST, STATE.STACKING_COUNT),
      };
      states.set(index, state);
      return state;
    };

    const operations = new Array(view.getUint32(block + HEADER.OPERATION_COUNT, true));
    const boxes = [];
    for (let index = 0; index < operations.length; index++) {
      const row = operationsBase + index * OPERATION.SIZE;
      const kind = view.getUint32(row + OPERATION.KIND, true);
      const logicalRectangle = {
        x: view.getFloat64(row + OPERATION.X, true),
        y: view.getFloat64(row + OPERATION.Y, true),
        width: view.getFloat64(row + OPERATION.WIDTH, true),
        height: view.getFloat64(row + OPERATION.HEIGHT, true),
      };
      const affine = view.getUint32(row + OPERATION.HAS_AFFINE, true)
        ? Array.from({ length: 6 }, (_, component) => view.getFloat64(row + OPERATION.AFFINE + component * 8, true))
        : null;
      const state = groupState(view.getUint32(row + OPERATION.STATE, true));
      const common = {
        operationIndex: view.getUint32(row + OPERATION.INDEX, true),
        commandIndex: view.getUint32(row + OPERATION.COMMAND, true),
        kind: OPERATION_KIND_NAMES.get(kind),
        nodeIndex: view.getInt32(row + OPERATION.NODE, true),
        logicalRectangle,
      };
      let operation;
      if (view.getUint32(row + OPERATION.HAS_TEXT, true)) {
        const textOffset = view.getUint32(row + OPERATION.TEXT, true);
        operation = {
          ...common,
          text: view.memoryText(decoder, textBase + textOffset, view.getUint32(row + OPERATION.TEXT_LENGTH, true)),
          fontSize: view.getFloat64(row + OPERATION.FONT_SIZE, true),
          lineHeight: view.getFloat64(row + OPERATION.LINE_HEIGHT, true),
          ascent: view.getFloat64(row + OPERATION.ASCENT, true),
          descent: view.getFloat64(row + OPERATION.DESCENT, true),
          baseline: {
            x: view.getFloat64(row + OPERATION.BASELINE_X, true),
            y: view.getFloat64(row + OPERATION.BASELINE_Y, true),
          },
          affine,
          clipEntries: clipSet(view.getInt32(row + OPERATION.CLIP_SET, true)),
          opacity: state.opacity,
          blendMode: state.blendMode,
          compositingGroupIdentifiers: state.compositingGroupIdentifiers,
          stackingContextIdentifiers: state.stackingContextIdentifiers,
        };
        defineGlyphs(operation, view.getUint32(row + OPERATION.GLYPH_FIRST, true),
          view.getUint32(row + OPERATION.GLYPH_COUNT, true));
      } else {
        operation = {
          ...common,
          affine,
          clipEntries: clipSet(view.getInt32(row + OPERATION.CLIP_SET, true)),
          opacity: state.opacity,
          blendMode: state.blendMode,
          compositingGroupIdentifiers: state.compositingGroupIdentifiers,
          stackingContextIdentifiers: state.stackingContextIdentifiers,
        };
      }
      operations[index] = operation;
      if (SHAPE_KINDS.has(kind)) boxes.push({ kind: "shape", box: logicalRectangle, affine });
      else if (kind === paint("KIND_TEXT")) boxes.push({ kind: "text-run", box: logicalRectangle, affine });
    }
    materialized = {
      viewport: {
        width: view.getFloat64(block + HEADER.WIDTH, true),
        height: view.getFloat64(block + HEADER.HEIGHT, true),
      },
      boxes,
      operations,
      compositingGroups,
      outsideCompositingGroups,
    };
    return materialized;
  };
  // glyphs and glyphAdvances of a text operation, built on first read
  // and then plain data properties.
  const defineGlyphs = (operation, first, count) => {
    const build = () => {
      const { block, view } = record();
      const base = block + view.getUint32(block + HEADER.GLYPHS, true);
      const glyphAdvances = new Array(count);
      const glyphs = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = base + (first + index) * GLYPH.SIZE;
        const width = view.getFloat64(row + GLYPH.WIDTH, true);
        glyphAdvances[index] = width;
        glyphs[index] = Object.freeze({
          x: view.getFloat64(row + GLYPH.X, true),
          width,
          sourceStart: view.getUint32(row + GLYPH.SOURCE_START, true),
          sourceEnd: view.getUint32(row + GLYPH.SOURCE_END, true),
          rtl: view.getUint32(row + GLYPH.RTL, true) !== 0,
        });
      }
      Object.defineProperties(operation, {
        glyphAdvances: { value: glyphAdvances, enumerable: true, writable: true, configurable: true },
        glyphs: { value: Object.freeze(glyphs), enumerable: true, writable: true, configurable: true },
      });
    };
    Object.defineProperties(operation, {
      glyphCount: { value: count, enumerable: true, configurable: true },
      glyphAdvances: {
        get() {
          build();
          return operation.glyphAdvances;
        },
        enumerable: true,
        configurable: true,
      },
      glyphs: {
        get() {
          build();
          return operation.glyphs;
        },
        enumerable: true,
        configurable: true,
      },
    });
  };
  const facade = Object.defineProperties({}, {
    kind: { value: "paint", enumerable: true },
    viewport: { get: () => materialize().viewport, enumerable: true },
    boxes: { get: () => materialize().boxes, enumerable: true },
    operations: { get: () => materialize().operations, enumerable: true },
    compositingGroups: { get: () => materialize().compositingGroups, enumerable: true },
    // The groups of a selected record whose node is outside the selection:
    // the groups around it.
    outsideCompositingGroups: { get: () => materialize().outsideCompositingGroups },
    // The command count that the decoder walked.
    commandCount: {
      get() {
        const { block, view } = record();
        return view.getUint32(block + HEADER.COMMAND_COUNT, true);
      },
    },
    handle: { value: handle },
    // Frees the record; a later read throws.
    release: {
      value() {
        core.status("projection_release", handle, KIND_PAINT);
        held.released = true;
        collected.unregister(held);
      },
    },
  });
  Object.freeze(facade);
  collected.register(facade, held, held);
  registerProjectionFacade(facade, core, handle, KIND_PAINT);
  return facade;
}

// Captures the paint command record of one frame: its command bytes, its
// glyph entries, the scene nodes it emitted, their prepared text runs (null
// for a node without one), the scene tree (`sceneChildren`: the child scene
// rows of each scene row), and the scene size. A span is either bytes that
// the host copies into the core once, or `{ pointer, length }` of bytes
// already in the core's memory; a run carries its `sourceId`. The core
// decodes them.
export function capturePaintRecord(core, { commands, glyphs, nodes, textRuns, sceneChildren, width, height }) {
  identifyCore(core);
  const nodeCount = nodes.length;
  const lengthOf = (span) => span instanceof Uint8Array ? span.byteLength : span.length;
  let copiedLength = 0;
  for (const span of [commands, glyphs, ...textRuns.map((run) => run?.bytes)]) {
    if (span instanceof Uint8Array) copiedLength += span.byteLength;
  }
  const childCount = sceneChildren.reduce((total, children) => total + children.length, 0);
  const nodesOffset = INPUT.HEADER_SIZE;
  const sceneRowsOffset = nodesOffset + nodeCount * INPUT.NODE_SIZE;
  const sceneChildrenOffset = sceneRowsOffset + sceneChildren.length * SCENE_ROW.SIZE;
  let copyOffset = sceneChildrenOffset + childCount * 4;
  const input = core.exports.abi_allocate(copyOffset + copiedLength);
  if (!input) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  // The core address of a span, copying it in when it is host bytes.
  const place = (span) => {
    if (!(span instanceof Uint8Array)) return span.pointer;
    const pointer = input + copyOffset;
    bytes.set(span, pointer);
    copyOffset += span.byteLength;
    return pointer;
  };
  view.setUint32(input + INPUT.COMMANDS, place(commands), true);
  view.setUint32(input + INPUT.COMMAND_LENGTH, lengthOf(commands), true);
  view.setUint32(input + INPUT.GLYPHS, place(glyphs), true);
  view.setUint32(input + INPUT.GLYPH_LENGTH, lengthOf(glyphs), true);
  view.setUint32(input + INPUT.NODE_COUNT, nodeCount, true);
  view.setUint32(input + INPUT.NODES, input + nodesOffset, true);
  view.setFloat64(input + INPUT.WIDTH, width, true);
  view.setFloat64(input + INPUT.HEIGHT, height, true);
  view.setUint32(input + INPUT.SCENE_ROWS, input + sceneRowsOffset, true);
  view.setUint32(input + INPUT.SCENE_ROW_COUNT, sceneChildren.length, true);
  view.setUint32(input + INPUT.SCENE_CHILDREN, input + sceneChildrenOffset, true);
  view.setUint32(input + INPUT.SCENE_CHILD_COUNT, childCount, true);
  let childCursor = 0;
  sceneChildren.forEach((children, row) => {
    const sceneRow = input + sceneRowsOffset + row * SCENE_ROW.SIZE;
    view.setUint32(sceneRow + SCENE_ROW.FIRST, childCursor, true);
    view.setUint32(sceneRow + SCENE_ROW.COUNT, children.length, true);
    for (const child of children) {
      view.setUint32(input + sceneChildrenOffset + childCursor * 4, child, true);
      childCursor += 1;
    }
  });
  for (let index = 0; index < nodeCount; index++) {
    const row = input + nodesOffset + index * INPUT.NODE_SIZE;
    const run = textRuns[index] ?? null;
    view.setUint32(row + INPUT.NODE_RUN, run === null ? 0 : place(run.bytes), true);
    view.setInt32(row + INPUT.NODE_RUN_LENGTH, run === null ? -1 : lengthOf(run.bytes), true);
    view.setInt32(row + INPUT.NODE_RUN_SOURCE, run === null ? -1 : run.sourceId, true);
    view.setInt32(row + INPUT.NODE_SCENE_SOURCE, nodes[index]?._inspectionSourceNodeIndex ?? -1, true);
  }
  return paintFacade(core, core.status("paint_capture", input));
}

// The paint record of the subtrees of the scene rows `sceneRows` in
// `record`: the operations of their nodes and the compositing groups of
// those nodes or around them, each keeping its index in the frame. The core
// builds it.
export function selectPaintRecord(record, sceneRows) {
  const { core, handle } = projectionHandle(record, KIND_PAINT, "selectPaintRecord");
  const rows = Uint32Array.from(sceneRows);
  return paintFacade(core, core.statusRaw("paint_select", handle, ...core.byteInput(new Uint8Array(rows.buffer))));
}

export { KIND_PAINT };
