// Geometry snapshots are built in the core (geometry_build): it walks the
// flat tree, joins each node's resolved fields with the frame's box snapshot
// and the serialization's publication rows, and derives every coordinate.
// The host supplies only what it alone knows: the frame's text geometry
// store (geometry-text-store.watpart), scrollbar descriptors, revisions and
// the viewport. The live layout pass that feeds a synchronous read lives
// in live-geometry.js.
import { boxSnapshotFor, GEOMETRY_FRAGMENT_SIZE } from "../dom-wasm/geometry-wire.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { nodeMember } from "./node-members.js";

// The codes that this file reads from WAT, by the names of their WAT
// globals.
const TEXT_OWNER_CONTROL = layoutConstant("TEXT_OWNER_CONTROL");
const BOX_FIELDS = ["GEOMETRY_BOX_X", "GEOMETRY_BOX_Y", "GEOMETRY_OFFSET_WIDTH", "GEOMETRY_OFFSET_HEIGHT"].map(layoutConstant);
const BOUNDS_FIELDS = ["GEOMETRY_BOUNDS_X", "GEOMETRY_BOUNDS_Y", "GEOMETRY_BOUNDS_WIDTH", "GEOMETRY_BOUNDS_HEIGHT"]
  .map(layoutConstant);
// The text geometry store fields (geometry-text-store.watpart TEXT_STORE_*),
// keyed by their name without the prefix.
const TEXT_STORE = Object.freeze(Object.fromEntries([
  "COUNT", "ENTRIES", "ENTRY_SIZE", "ENTRY_OWNER", "ENTRY_KIND", "ENTRY_DATA", "ENTRY_TRANSLATION_X",
  "ENTRY_TRANSLATION_Y", "ENTRY_SELECTION_START", "ENTRY_SELECTION_END", "ENTRY_SAME",
  "DATA_LINE_COUNT", "DATA_GLYPH_COUNT", "DATA_CARET_COUNT", "DATA_LINES", "LINE_SIZE",
  "GLYPH_SIZE", "GLYPH_SOURCE_START", "GLYPH_SOURCE_END", "GLYPH_X", "GLYPH_WIDTH", "GLYPH_TOP", "GLYPH_BOTTOM",
  "CARET_SIZE", "CARET_SOURCE_OFFSET", "CARET_X", "CARET_TOP", "CARET_BOTTOM", "CARET_AFFINITY", "AFFINITY_UPSTREAM",
].map((name) => [name, layoutConstant(`TEXT_STORE_${name}`)])));
// The other geometry records that this file reads or writes, by WAT name.
const GEOMETRY = Object.freeze(Object.fromEntries([
  "GEOMETRY_REVISIONS_SIZE", "GEOMETRY_WORK_SIZE", "GEOMETRY_WORK_REBUILT_RECORDS", "GEOMETRY_WORK_TREE_WALKED",
  "GEOMETRY_WORK_ELEMENTS_RESOLVED", "GEOMETRY_WORK_RECORDS_COPIED", "GEOMETRY_WORK_RECORDS_DERIVED",
  "GEOMETRY_WORK_BOX_ROWS_READ", "GEOMETRY_FRAGMENT_X", "GEOMETRY_FRAGMENT_Y", "GEOMETRY_FRAGMENT_WIDTH",
  "GEOMETRY_FRAGMENT_HEIGHT", "GEOMETRY_CARET_POSITION_SIZE", "GEOMETRY_CARET_POSITION_NODE",
  "GEOMETRY_CARET_POSITION_OFFSET", "GEOMETRY_SPAN_SIZE", "GEOMETRY_SPAN_NODE", "GEOMETRY_SPAN_START",
  "GEOMETRY_SPAN_END", "GEOMETRY_SPAN_DELTA_X", "GEOMETRY_SPAN_DELTA_Y", "GEOMETRY_SELECTION_RECTANGLE_SIZE",
  "GEOMETRY_SELECTION_RECTANGLE_X", "GEOMETRY_SELECTION_RECTANGLE_Y", "GEOMETRY_SELECTION_RECTANGLE_WIDTH",
  "GEOMETRY_SELECTION_RECTANGLE_HEIGHT",
].map((name) => [name, layoutConstant(name)])));

const measurement = Symbol.for("sandom.domCore.measurement");
const geometryFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_release(handle);
});

// The revisions a snapshot is stamped with. Callers on a frame pass the
// frame's; a standalone query reads the current ones.
export function currentGeometryRevisions(document, revision = 0) {
  const core = document._domCore;
  const style = core.status("document_style_generation", document._coreHandle) >>> 0;
  return { document: style, style, resource: core.status("resource_revision") >>> 0, viewport: revision, scene: revision, presentation: revision };
}

// The element whose tree a layout of `node` serializes: the last element of
// `node`'s shadow-including ancestors (DOM). A node in a shadow tree climbs
// past its shadow root to the host, so its layout is the layout of the
// tree that the document or surface paints, not of its shadow tree alone.
export function layoutRootOf(node) {
  let root = node;
  for (;;) {
    const parent = nodeMember(root, "parentElement") ?? nodeMember(root, "parentNode")?.host ?? null;
    if (parent === null) return root;
    root = parent;
  }
}

const textStoreFinalizer = new FinalizationRegistry(({ core, store }) => {
  core.exports.geometry_text_store_release(store);
});

// The text geometry of a frame: its text geometry store
// (geometry-text-store.watpart), read through the read-only Map interface
// and keyed by owner node. An entry holds the owner's caret stops, glyphs,
// captured line rectangles (`anchors`) and translation, and a text
// control's selection (`selectionStart`, `selectionEnd`); it is decoded on
// its first read. An entry the store marks as the previous store's is the
// `previous` view's decoded object, and an entry over the previous store's
// data (a kept text node with a new translation) shares its decoded caret
// stops, glyphs and anchors, so readers can compare entries of consecutive
// frames by identity. The view holds a reference to the store until
// `release()` (or until it is collected); an entry not decoded before then
// cannot be read. `controls()` gives the view of the text controls alone.
export class TextStoreGeometry {
  #state;
  #kind;

  constructor(core, store, previous = null, state = null, kind = 0) {
    this.#kind = kind;
    if (state !== null) {
      this.#state = state;
      return;
    }
    const entries = new Map();
    if (store !== 0) {
      core.status("geometry_text_store_retain", store);
      const view = new DataView(core.refreshBytes().buffer);
      const count = view.getUint32(store + TEXT_STORE.COUNT, true);
      for (let index = 0; index < count; index++) {
        const entry = store + TEXT_STORE.ENTRIES + index * TEXT_STORE.ENTRY_SIZE;
        entries.set(view.getBigUint64(entry + TEXT_STORE.ENTRY_OWNER, true), {
          entry,
          kind: view.getUint32(entry + TEXT_STORE.ENTRY_KIND, true),
          data: view.getUint32(entry + TEXT_STORE.ENTRY_DATA, true),
          same: view.getUint32(entry + TEXT_STORE.ENTRY_SAME, true) === 1,
        });
      }
    }
    // Decoded entries by node, and decoded runs by store data.
    this.#state = { core, store, entries, nodes: null, decoded: new Map(), runs: new Map(), released: false };
    if (store !== 0) textStoreFinalizer.register(this.#state, { core, store }, this.#state);
    if (previous !== null) {
      const data = new Set();
      for (const entry of entries.values()) data.add(entry.data);
      for (const [node, geometry] of previous.#state.decoded) {
        if (entries.get(node._coreHandle)?.same) this.#state.decoded.set(node, geometry);
      }
      for (const [pointer, run] of previous.#state.runs) {
        if (data.has(pointer)) this.#state.runs.set(pointer, run);
      }
    }
  }

  // Drops the view's reference to its store.
  release() {
    const state = this.#state;
    if (state.store === 0 || state.released) return;
    state.released = true;
    textStoreFinalizer.unregister(state);
    state.core.status("geometry_text_store_release", state.store);
  }

  controls() {
    return new TextStoreGeometry(null, 0, null, this.#state, TEXT_OWNER_CONTROL);
  }

  #nodes() {
    const state = this.#state;
    state.nodes ??= [...state.entries].map(([handle, entry]) => [state.core.wrapperFor(handle), entry]);
    return this.#kind === 0 ? state.nodes : state.nodes.filter(([, entry]) => entry.kind === this.#kind);
  }

  #entry(node) {
    const entry = this.#state.entries.get(node?._coreHandle);
    return entry !== undefined && (this.#kind === 0 || entry.kind === this.#kind) ? entry : undefined;
  }

  #decode(node, entry) {
    const state = this.#state;
    let geometry = state.decoded.get(node);
    if (geometry !== undefined) return geometry;
    const view = new DataView(state.core.refreshBytes().buffer);
    if (state.released) {
      throw new Error(`text geometry: the text store of node ${node._coreHandle}'s frame was released; read it from a live frame`);
    }
    const value = (at) => view.getFloat64(at, true);
    let run = state.runs.get(entry.data);
    if (run === undefined) {
      const data = entry.data;
      const lineCount = view.getUint32(data + TEXT_STORE.DATA_LINE_COUNT, true);
      const glyphCount = view.getUint32(data + TEXT_STORE.DATA_GLYPH_COUNT, true);
      const caretCount = view.getUint32(data + TEXT_STORE.DATA_CARET_COUNT, true);
      // Per line: x, y, width and height, then its glyph count.
      const anchors = new Float64Array(lineCount * 4);
      for (let index = 0; index < anchors.length; index++) {
        anchors[index] = value(data + TEXT_STORE.DATA_LINES + Math.floor(index / 4) * TEXT_STORE.LINE_SIZE + (index % 4) * 8);
      }
      const glyphBase = data + TEXT_STORE.DATA_LINES + lineCount * TEXT_STORE.LINE_SIZE;
      const glyphs = new Array(glyphCount);
      for (let index = 0; index < glyphCount; index++) {
        const at = glyphBase + index * TEXT_STORE.GLYPH_SIZE;
        glyphs[index] = Object.freeze({
          sourceStart: value(at + TEXT_STORE.GLYPH_SOURCE_START), sourceEnd: value(at + TEXT_STORE.GLYPH_SOURCE_END),
          x: value(at + TEXT_STORE.GLYPH_X), width: value(at + TEXT_STORE.GLYPH_WIDTH),
          top: value(at + TEXT_STORE.GLYPH_TOP), bottom: value(at + TEXT_STORE.GLYPH_BOTTOM),
        });
      }
      const caretBase = glyphBase + glyphCount * TEXT_STORE.GLYPH_SIZE;
      const caretStops = new Array(caretCount);
      for (let index = 0; index < caretCount; index++) {
        const at = caretBase + index * TEXT_STORE.CARET_SIZE;
        caretStops[index] = Object.freeze({
          sourceOffset: value(at + TEXT_STORE.CARET_SOURCE_OFFSET), x: value(at + TEXT_STORE.CARET_X),
          top: value(at + TEXT_STORE.CARET_TOP), bottom: value(at + TEXT_STORE.CARET_BOTTOM),
          affinity: value(at + TEXT_STORE.CARET_AFFINITY) === TEXT_STORE.AFFINITY_UPSTREAM ? "upstream" : "downstream",
        });
      }
      run = { caretStops: Object.freeze(caretStops), glyphs: Object.freeze(glyphs), anchors };
      state.runs.set(data, run);
    }
    geometry = {
      caretStops: run.caretStops,
      glyphs: run.glyphs,
      anchors: run.anchors,
      translationX: value(entry.entry + TEXT_STORE.ENTRY_TRANSLATION_X),
      translationY: value(entry.entry + TEXT_STORE.ENTRY_TRANSLATION_Y),
    };
    if (entry.kind === TEXT_OWNER_CONTROL) {
      geometry.selectionStart = value(entry.entry + TEXT_STORE.ENTRY_SELECTION_START);
      geometry.selectionEnd = value(entry.entry + TEXT_STORE.ENTRY_SELECTION_END);
    }
    Object.freeze(geometry);
    state.decoded.set(node, geometry);
    return geometry;
  }

  get size() {
    return this.#kind === 0 ? this.#state.entries.size : this.#nodes().length;
  }

  has(node) {
    return this.#entry(node) !== undefined;
  }

  get(node) {
    const entry = this.#entry(node);
    return entry === undefined ? undefined : this.#decode(node, entry);
  }

  *keys() {
    for (const [node] of this.#nodes()) yield node;
  }

  *values() {
    for (const [node, entry] of this.#nodes()) yield this.#decode(node, entry);
  }

  *entries() {
    for (const [node, entry] of this.#nodes()) yield [node, this.#decode(node, entry)];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArgument) {
    for (const [node, geometry] of this.entries()) callback.call(thisArgument, geometry, node, this);
  }
}

const revisionNames = ["document", "style", "resource", "viewport", "scene", "presentation"];

// A snapshot handle carries its continuation slot's top bit, so a
// geometry_restyle_successor result below it is a refusal, not a handle.
const GEOMETRY_HANDLE_MINIMUM = 0x80000000n;
const restyleRefusals = [null, "tree", "rows", "fragments"];

// Builds through `buildOnce(pointer)`, `pointer` holding the six frame
// revisions (or 0 without them) and then `tail`. Native resolution can
// raise font-family requests. The host answers them (bumping the style
// generation) and builds again, so a live snapshot's revisions are current
// when its consumers query it - the same loop the host resolver ran before
// it stamped revisions. A refusal is final: the successor refuses before it
// resolves anything.
function buildAnsweringFontFamilies(document, revisions, tail, buildOnce) {
  const core = document._domCore;
  const styleSystem = document._styleSystem;
  const once = () => {
    // One transient block: the arena can move on a second allocation.
    const pointer = core.status("abi_allocate", GEOMETRY.GEOMETRY_REVISIONS_SIZE + tail.byteLength);
    const bytes = core.refreshBytes();
    if (revisions) {
      const revisionView = new DataView(bytes.buffer, pointer, GEOMETRY.GEOMETRY_REVISIONS_SIZE);
      for (const [index, name] of revisionNames.entries()) {
        revisionView.setBigUint64(index * BigUint64Array.BYTES_PER_ELEMENT, BigInt(revisions[name] ?? 0), true);
      }
    }
    bytes.set(tail, pointer + GEOMETRY.GEOMETRY_REVISIONS_SIZE);
    return buildOnce(pointer);
  };
  let handle;
  for (let attempt = 0;; attempt++) {
    handle = once();
    if (handle < GEOMETRY_HANDLE_MINIMUM || !styleSystem || attempt > 8 || core.fontFamilyRequests(document).length === 0) break;
    core.status("geometry_release", handle);
    styleSystem.answerFontFamilyRequests();
  }
  return handle;
}

function ownedGeometry(core, handle, operation, tail) {
  const collector = globalThis[measurement];
  if (typeof collector?.record === "function") collector.record({ category: "geometry", operation, direction: "host-to-core", bytes: tail.byteLength, allocations: 1, allocationBytes: tail.byteLength });
  const result = { core, handle, release() {
    if (this.handle === 0n) return;
    core.status("geometry_release", this.handle);
    this.handle = 0n;
    geometryFinalizer.unregister(this);
  } };
  geometryFinalizer.register(result, { core, handle }, result);
  return result;
}

// The geometry tail of a frame without scrollbars: a header that counts
// none. A frame's scrollbars come from the core as a tail of their own
// (scrollbars_tail, src/dom/scrollbars.js).
export const EMPTY_SCROLLBAR_TAIL = new Uint8Array(layoutConstant("GEOMETRY_TAIL_HEADER_SIZE"));

// `textStore` (a geometry_text_store, or 0) gives the snapshot's carets and
// glyphs; the snapshot holds a reference to it. `scrollbarTail` is the
// geometry tail of the snapshot's scrollbars.
export function buildGeometry({ root, boxes, publication, viewport, viewportIndex, revision = 0, scrollbarTail = EMPTY_SCROLLBAR_TAIL, textStore = 0, presented = false, sourceRevisions }) {
  const document = nodeMember(root, "ownerDocument");
  const core = document._domCore;
  const revisions = sourceRevisions ? { ...sourceRevisions, presentation: revision } : null;
  const tail = scrollbarTail;
  const snapshot = boxSnapshotFor(boxes, core);
  // The document element with a live surface is the viewport's client.
  const viewportClient = document.documentElement === root && Boolean(root._renderSurface);
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, revisions, tail, (pointer) =>
      core.status("geometry_build", document._coreHandle, publication ?? 0, root._coreHandle, snapshot.handle,
        viewport.width, viewport.height, viewport.density ?? viewport.deviceScale ?? 1, presented ? 1 : 0, viewportClient ? 1 : 0,
        viewportIndex ?? -1, revisions ? pointer : 0, BigInt(revision), pointer + GEOMETRY.GEOMETRY_REVISIONS_SIZE,
        tail.byteLength, textStore));
  } finally {
    snapshot.release();
  }
  return ownedGeometry(core, handle, "geometry_build", tail);
}

// The work a successor reported (its standard output, six u32): element
// records whose facts it built again, whether the restyle walked the flat
// tree, elements resolved, records copied with the pages they shared,
// records derived and box rows compared.
function successorWork(core, operation) {
  const output = core.output(operation);
  return Object.freeze({
    rebuiltRecords: output.getUint32(GEOMETRY.GEOMETRY_WORK_REBUILT_RECORDS, true),
    treeWalked: output.getUint32(GEOMETRY.GEOMETRY_WORK_TREE_WALKED, true) === 1,
    elementsResolved: output.getUint32(GEOMETRY.GEOMETRY_WORK_ELEMENTS_RESOLVED, true),
    recordsCopied: output.getUint32(GEOMETRY.GEOMETRY_WORK_RECORDS_COPIED, true),
    recordsDerived: output.getUint32(GEOMETRY.GEOMETRY_WORK_RECORDS_DERIVED, true),
    boxRowsRead: output.getUint32(GEOMETRY.GEOMETRY_WORK_BOX_ROWS_READ, true),
  });
}

// The presented geometry of a frame that only scrolled, derived natively
// from its predecessor (geometry_scroll_successor): the geometry
// buildGeometry produces when the predecessor's tree, publication, element
// facts and text geometry still hold, which the caller establishes
// (geometry_text_store_holds). Only the boxes, the scrollbars and the text
// translations of `textStore` are this frame's; a store with the
// predecessor's translations keeps the predecessor's carets and glyphs. A
// translation holds no scroll: the geometry records carry it. Returns the
// geometry and the successor's `work`.
export function buildGeometrySuccessor(options) {
  return successorOf("geometry_scroll_successor", options);
}

// The presented geometry of a frame derived from the geometry the frame
// built of its tree before it rasterized (its rendering observers'
// checkpoint), with the frame's boxes, scrollbars, revisions and text
// store (geometry_frame_successor): no record reads the text store, so the
// records stay the frame's, and the text block is the store's. The caller
// establishes the envelope and the revisions (presented-frame.js).
export function buildGeometryFrameSuccessor(options) {
  return successorOf("geometry_frame_successor", options);
}

function successorOf(operation, { predecessor, root, boxes, revision, scrollbarTail, textStore = 0, sourceRevisions }) {
  const document = nodeMember(root, "ownerDocument");
  const core = document._domCore;
  const tail = scrollbarTail;
  const snapshot = boxSnapshotFor(boxes, core);
  let work = null;
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, { ...sourceRevisions, presentation: revision }, tail, (pointer) => {
      const result = core.status(operation, document._coreHandle, predecessor.handle, snapshot.handle,
        pointer, pointer + GEOMETRY.GEOMETRY_REVISIONS_SIZE, tail.byteLength, textStore);
      work = successorWork(core, operation);
      return result;
    });
  } finally {
    snapshot.release();
  }
  return { geometry: ownedGeometry(core, handle, operation, tail), work };
}

// The presented geometry of a frame that restyled elements and kept its
// flat tree, rows and fragments, derived natively from its predecessor
// (geometry_restyle_successor): the predecessor's records with this
// frame's boxes, scrollbars and revisions, and the facts of each element
// whose record the restyle changed built again. The caller establishes
// that the viewport and the text geometry are the predecessor's, at most
// with other translations (`textStore` as for buildGeometrySuccessor). The
// core proves the tree, the rows and the fragment counts; when one differs
// it refuses, and this returns no geometry and the refusal ("tree", "rows"
// or "fragments") for the caller to build instead. `work`: the
// successor's work (successorWork), null after a refusal.
export function buildGeometryRestyleSuccessor({ predecessor, root, boxes, publication, viewportIndex, revision, scrollbarTail, textStore = 0, sourceRevisions }) {
  const document = nodeMember(root, "ownerDocument");
  const core = document._domCore;
  const tail = scrollbarTail;
  const snapshot = boxSnapshotFor(boxes, core);
  // The document element with a live surface is the viewport's client.
  const viewportClient = document.documentElement === root && Boolean(root._renderSurface);
  let work = null;
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, { ...sourceRevisions, presentation: revision }, tail, (pointer) => {
      const result = core.status("geometry_restyle_successor", document._coreHandle, predecessor.handle,
        publication ?? 0, root._coreHandle, snapshot.handle, viewportClient ? 1 : 0, viewportIndex ?? -1,
        pointer, pointer + GEOMETRY.GEOMETRY_REVISIONS_SIZE, tail.byteLength, textStore);
      if (result >= GEOMETRY_HANDLE_MINIMUM) work = successorWork(core, "geometry_restyle_successor");
      return result;
    });
  } finally {
    snapshot.release();
  }
  if (handle < GEOMETRY_HANDLE_MINIMUM) {
    return { geometry: null, refusal: restyleRefusals[Number(handle)], work: null };
  }
  return { geometry: ownedGeometry(core, handle, "geometry_restyle_successor", tail), refusal: null, work };
}

// A node's untransformed border box in the snapshot, or null when the
// snapshot has no record for it (a node with no box or outside the tree).
export function geometryBox(core, handle, node) {
  if (core.status("geometry_index", handle, node) < 0) return null;
  const values = BOX_FIELDS.map((field) => core.status("geometry_value", handle, node, field));
  if (!(values[2] > 0 || values[3] > 0)) return null;
  return { x: values[0], y: values[1], w: values[2], h: values[3] };
}

function rectangle(x, y, width, height) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

export function geometryRect(core, handle, node) {
  const values = BOUNDS_FIELDS.map((field) => core.status("geometry_value", handle, node, field));
  return rectangle(values[0], values[1], values[2], values[3]);
}

// A node's client rectangles: one per fragment of a box broken across
// columns or lines, else its border box, each transformed; none without
// a box.
export function geometryClientRects(core, handle, node) {
  const count = core.status("geometry_client_rects", handle, node);
  // Without a rectangle the operation produces no output.
  if (count === 0) return [];
  const view = core.output("geometry_client_rects");
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const at = index * GEOMETRY_FRAGMENT_SIZE;
    rectangles.push(rectangle(
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_X, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_Y, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_WIDTH, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_HEIGHT, true),
    ));
  }
  return rectangles;
}

// The rectangles of `range` (Range.getClientRects), or with `bounding` its
// bounding rectangle (Range.getBoundingClientRect), from a snapshot with
// text geometry (live-geometry.js withLiveTextGeometry).
export function geometryRangeRects(core, handle, range, bounding) {
  const count = core.status("geometry_range_rects", handle, range._handle, bounding ? 1 : 0);
  const view = count === 0 ? null : core.output("geometry_range_rects");
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const at = index * GEOMETRY_FRAGMENT_SIZE;
    rectangles.push(rectangle(
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_X, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_Y, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_WIDTH, true),
      view.getFloat64(at + GEOMETRY.GEOMETRY_FRAGMENT_HEIGHT, true),
    ));
  }
  return bounding ? rectangles[0] : rectangles;
}

// The caret position at viewport point (x, y) (caretPositionFromPoint)
// from a snapshot with text geometry: { node, offset }, or null when no
// element is at the point. The handle is copied out before the wrapper is
// made, since making one can run another core operation.
export function geometryCaretPosition(core, handle, x, y) {
  if (core.status("geometry_caret_position", handle, x, y) === 0) return null;
  const view = core.output("geometry_caret_position");
  const node = view.getBigUint64(GEOMETRY.GEOMETRY_CARET_POSITION_NODE, true);
  const offset = view.getFloat64(GEOMETRY.GEOMETRY_CARET_POSITION_OFFSET, true);
  return { node: core.wrapperFor(node), offset };
}

// The nodes at a viewport point, topmost first, the root element last
// (geometry_hits_test). The handles are copied out before any wrapper is
// made, since making one can run another core operation.
export function geometryHits(core, handle, x, y) {
  const count = core.status("geometry_hits_test", handle, x, y);
  // Without a node at the point the operation produces no output.
  if (count === 0) return [];
  const view = core.output("geometry_hits_test");
  const handles = [];
  for (let index = 0; index < count; index++) handles.push(view.getBigUint64(index * BigUint64Array.BYTES_PER_ELEMENT, true));
  return handles.map((node) => core.wrapperFor(node));
}

const noSelectionRectangles = Object.freeze([]);

function writeSelectionSpan(view, offset, span) {
  view.setBigUint64(offset + GEOMETRY.GEOMETRY_SPAN_NODE, span.node._coreHandle, true);
  view.setFloat64(offset + GEOMETRY.GEOMETRY_SPAN_START, span.start, true);
  view.setFloat64(offset + GEOMETRY.GEOMETRY_SPAN_END, span.end, true);
  view.setFloat64(offset + GEOMETRY.GEOMETRY_SPAN_DELTA_X, span.deltaX ?? 0, true);
  view.setFloat64(offset + GEOMETRY.GEOMETRY_SPAN_DELTA_Y, span.deltaY ?? 0, true);
}

function readSelectionRectangles(core, operation, count) {
  if (count === 0) return noSelectionRectangles;
  const size = GEOMETRY.GEOMETRY_SELECTION_RECTANGLE_SIZE;
  const view = core.output(operation);
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const offset = index * size;
    rectangles.push(Object.freeze({
      x: view.getFloat64(offset + GEOMETRY.GEOMETRY_SELECTION_RECTANGLE_X, true),
      y: view.getFloat64(offset + GEOMETRY.GEOMETRY_SELECTION_RECTANGLE_Y, true),
      width: view.getFloat64(offset + GEOMETRY.GEOMETRY_SELECTION_RECTANGLE_WIDTH, true),
      height: view.getFloat64(offset + GEOMETRY.GEOMETRY_SELECTION_RECTANGLE_HEIGHT, true),
    }));
  }
  return Object.freeze(rectangles);
}

// The rectangles of text spans `spans` ({ node, start, end }; a text node or
// a text control with offsets into its value) in presented frame `snapshot`
// (a surface's `presentedFrame`): viewport CSS px, or device px with
// `physical`. A public export of `sandom/dom`.
export function selectionRectangles(snapshot, spans, {
  physical = false, deviceScale = snapshot?.viewport.deviceScale ?? 1,
} = {}) {
  if (!snapshot) return noSelectionRectangles;
  const core = snapshot.geometryCore;
  const pointer = core.status("abi_allocate", spans.length * GEOMETRY.GEOMETRY_SPAN_SIZE);
  const view = new DataView(core.refreshBytes().buffer, pointer, spans.length * GEOMETRY.GEOMETRY_SPAN_SIZE);
  for (let index = 0; index < spans.length; index++) {
    writeSelectionSpan(view, index * GEOMETRY.GEOMETRY_SPAN_SIZE, spans[index]);
  }
  const count = core.status("geometry_selection_rects", snapshot.geometryHandle,
    pointer, spans.length, physical ? 1 : 0, deviceScale);
  return readSelectionRectangles(core, "geometry_selection_rects", count);
}

// The caret rectangle at `position` in `node` (a text node or a text
// control) in presented frame `snapshot`, in viewport device px, or null
// where the frame has no caret position. A public export of `sandom/dom`.
export function caretRectangle(snapshot, node, position, {
  deltaX = 0, deltaY = 0, deviceScale = snapshot?.viewport.deviceScale ?? 1,
} = {}) {
  if (!snapshot) return null;
  const core = snapshot.geometryCore;
  const count = core.status("geometry_caret_rect", snapshot.geometryHandle,
    node._coreHandle, position, deltaX, deltaY, deviceScale);
  return count === 0 ? null : readSelectionRectangles(core, "geometry_caret_rect", count)[0];
}

// The selection rectangles of text control `element` in presented frame
// `frame`, for its text geometry entry `geometry` (which carries the
// control's selection): CSS px, with the control's scroll and its
// ancestors' scrolls, as the frame's geometry answers them.
export function controlSelectionRectangles(frame, element, geometry) {
  const start = geometry.selectionStart;
  const end = geometry.selectionEnd;
  if (start === end) return noSelectionRectangles;
  return selectionRectangles(frame, [
    { node: element, start: Math.min(start, end), end: Math.max(start, end) },
  ]);
}
