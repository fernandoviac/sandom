// Geometry snapshots are built in the core (geometry_build): it walks the
// flat tree, joins each node's resolved fields with the frame's box snapshot
// and the serialization's publication rows, and derives every coordinate.
// The host supplies only what it alone knows: text geometry (carets and
// glyphs), scrollbar descriptors, revisions and the viewport. The live
// layout pass that feeds a synchronous read lives in live-geometry.js.
import { boxSnapshotFor, encodeGeometrySuccessorTail, encodeGeometryTail, GEOMETRY_FRAGMENT_SIZE, textWireBlocks } from "../dom-wasm/geometry-wire.js";

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

// Every text geometry a snapshot carries, in wire order: the text nodes'
// and text controls' entries, a control's entry being its element-keyed
// one. A surface frame keys each control's entry under both maps, so its
// node map already is that; only element entries of their own need the
// merged map.
export function snapshotTextGeometry(textGeometryByNode, textGeometryByElement) {
  for (const [element, geometry] of textGeometryByElement) {
    if (textGeometryByNode.get(element) !== geometry) {
      return new Map([...textGeometryByNode, ...textGeometryByElement]);
    }
  }
  return textGeometryByNode;
}

// The text geometry of a frame that kept every text node's geometry (it
// only scrolled, or restyled without moving text): the text geometry
// `base` of an earlier frame, with `overrides` holding the entries the
// frame finished itself (a text control's, with its live selection), read
// in place of the base entry. A translation holds no scroll (the geometry
// records carry it), so a scroll needs no new entry. It answers the
// read-only Map interface.
export class TextGeometryView {
  constructor(base, overrides) {
    this.base = base;
    this.overrides = overrides;
    Object.freeze(this);
  }

  get size() {
    return this.base.size;
  }

  has(node) {
    return this.base.has(node);
  }

  get(node) {
    return this.overrides.get(node) ?? this.base.get(node);
  }

  keys() {
    return this.base.keys();
  }

  *values() {
    for (const node of this.base.keys()) yield this.get(node);
  }

  *entries() {
    for (const node of this.base.keys()) yield [node, this.get(node)];
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
    const pointer = core.status("abi_allocate", 48 + tail.byteLength);
    const bytes = core.refreshBytes();
    if (revisions) {
      const revisionView = new DataView(bytes.buffer, pointer, 48);
      for (const [index, name] of revisionNames.entries()) {
        revisionView.setBigUint64(index * 8, BigInt(revisions[name] ?? 0), true);
      }
    }
    bytes.set(tail, pointer + 48);
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

export function buildGeometry({ root, boxes, publication, viewport, viewportIndex, revision = 0, scrollbars = [], textGeometryByNode = new Map(), textGeometryByElement = new Map(), presented = false, sourceRevisions }) {
  const document = root.ownerDocument;
  const core = document._domCore;
  const revisions = sourceRevisions ? { ...sourceRevisions, presentation: revision } : null;
  const textBlocks = [];
  for (const [node, geometry] of snapshotTextGeometry(textGeometryByNode, textGeometryByElement)) {
    textBlocks.push({
      blocks: textWireBlocks(node, geometry),
      translationX: geometry.translationX ?? 0,
      translationY: geometry.translationY ?? 0,
    });
  }
  const tail = encodeGeometryTail({ scrollbars, textBlocks });
  const snapshot = boxSnapshotFor(boxes, core);
  // The document element with a live surface is the viewport's client.
  const viewportClient = document.documentElement === root && Boolean(root._renderSurface);
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, revisions, tail, (pointer) =>
      core.status("geometry_build", document._coreHandle, publication ?? 0, root._coreHandle, snapshot.handle,
        viewport.width, viewport.height, viewport.deviceScale ?? 1, presented ? 1 : 0, viewportClient ? 1 : 0,
        viewportIndex ?? -1, revisions ? pointer : 0, BigInt(revision), pointer + 48, tail.byteLength));
  } finally {
    snapshot.release();
  }
  return ownedGeometry(core, handle, "geometry_build", tail);
}

// The host tail of a successor: this frame's scrollbars, and without
// `shareText` each text node's translation in the text geometry's order.
function successorTail(scrollbars, textGeometry, shareText) {
  const textTranslations = [];
  if (!shareText) {
    for (const [node, geometry] of textGeometry) {
      textTranslations.push({
        handle: node._coreHandle,
        translationX: geometry.translationX ?? 0,
        translationY: geometry.translationY ?? 0,
      });
    }
  }
  return encodeGeometrySuccessorTail({ scrollbars, textTranslations, shareText });
}

// The work a successor reported (its standard output, six u32): element
// records whose facts it built again, whether the restyle walked the flat
// tree, elements resolved, records copied with the pages they shared,
// records derived and box rows compared.
function successorWork(core) {
  const output = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 24);
  return Object.freeze({
    rebuiltRecords: output.getUint32(0, true),
    treeWalked: output.getUint32(4, true) === 1,
    elementsResolved: output.getUint32(8, true),
    recordsCopied: output.getUint32(12, true),
    recordsDerived: output.getUint32(16, true),
    boxRowsRead: output.getUint32(20, true),
  });
}

// The presented geometry of a frame that only scrolled, derived natively
// from its predecessor (geometry_scroll_successor): the geometry
// buildGeometry produces when the predecessor's tree, publication, element
// facts and text geometry still hold, which the caller establishes. Only
// the boxes, the scrollbars and the text translations are this frame's.
// With `shareText` the snapshot keeps the predecessor's carets and glyphs
// (the frame's text geometry is the predecessor's); without it each text
// node's translation is written. A translation holds no scroll: the
// geometry records carry it. Returns the geometry and the successor's
// `work`.
export function buildGeometrySuccessor({ predecessor, root, boxes, revision, scrollbars, textGeometry, shareText = false, sourceRevisions }) {
  const document = root.ownerDocument;
  const core = document._domCore;
  const tail = successorTail(scrollbars, textGeometry, shareText);
  const snapshot = boxSnapshotFor(boxes, core);
  let work = null;
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, { ...sourceRevisions, presentation: revision }, tail, (pointer) => {
      const result = core.status("geometry_scroll_successor", document._coreHandle, predecessor.handle, snapshot.handle,
        pointer, pointer + 48, tail.byteLength);
      work = successorWork(core);
      return result;
    });
  } finally {
    snapshot.release();
  }
  return { geometry: ownedGeometry(core, handle, "geometry_scroll_successor", tail), work };
}

// The presented geometry of a frame that restyled elements and kept its
// flat tree, rows and fragments, derived natively from its predecessor
// (geometry_restyle_successor): the predecessor's records with this
// frame's boxes, scrollbars and revisions, and the facts of each element
// whose record the restyle changed built again. The caller establishes
// that the viewport and the text geometry are the predecessor's, at most
// with other translations (`shareText` as for buildGeometrySuccessor). The core
// proves the tree, the rows and the fragment counts; when one differs it
// refuses, and this returns no geometry and the refusal ("tree", "rows" or
// "fragments") for the caller to build instead. `work`: the successor's
// work (successorWork), null after a refusal.
export function buildGeometryRestyleSuccessor({ predecessor, root, boxes, publication, viewportIndex, revision, scrollbars, textGeometry, shareText = false, sourceRevisions }) {
  const document = root.ownerDocument;
  const core = document._domCore;
  const tail = successorTail(scrollbars, textGeometry, shareText);
  const snapshot = boxSnapshotFor(boxes, core);
  // The document element with a live surface is the viewport's client.
  const viewportClient = document.documentElement === root && Boolean(root._renderSurface);
  let work = null;
  let handle;
  try {
    handle = buildAnsweringFontFamilies(document, { ...sourceRevisions, presentation: revision }, tail, (pointer) => {
      const result = core.status("geometry_restyle_successor", document._coreHandle, predecessor.handle,
        publication ?? 0, root._coreHandle, snapshot.handle, viewportClient ? 1 : 0, viewportIndex ?? -1,
        pointer, pointer + 48, tail.byteLength);
      if (result >= GEOMETRY_HANDLE_MINIMUM) work = successorWork(core);
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
  const values = [0, 1, 2, 3].map((field) => core.status("geometry_value", handle, node, field));
  if (!(values[2] > 0 || values[3] > 0)) return null;
  return { x: values[0], y: values[1], w: values[2], h: values[3] };
}

function rectangle(x, y, width, height) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

export function geometryRect(core, handle, node) {
  const values = [28, 29, 30, 31].map((field) => core.status("geometry_value", handle, node, field));
  return rectangle(values[0], values[1], values[2], values[3]);
}

// A node's client rectangles: one per fragment of a box broken across
// columns or lines, else its border box, each transformed; none without
// a box.
export function geometryClientRects(core, handle, node) {
  const count = core.status("geometry_client_rects", handle, node);
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), count * GEOMETRY_FRAGMENT_SIZE);
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const at = index * GEOMETRY_FRAGMENT_SIZE;
    rectangles.push(rectangle(
      view.getFloat64(at, true),
      view.getFloat64(at + 8, true),
      view.getFloat64(at + 16, true),
      view.getFloat64(at + 24, true),
    ));
  }
  return rectangles;
}

// The rectangles of `range` (Range.getClientRects), or with `bounding` its
// bounding rectangle (Range.getBoundingClientRect), from a snapshot with
// text geometry (live-geometry.js withLiveTextGeometry).
export function geometryRangeRects(core, handle, range, bounding) {
  const count = core.status("geometry_range_rects", handle, range._handle, bounding ? 1 : 0);
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * GEOMETRY_FRAGMENT_SIZE);
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const at = index * GEOMETRY_FRAGMENT_SIZE;
    rectangles.push(rectangle(
      view.getFloat64(at, true),
      view.getFloat64(at + 8, true),
      view.getFloat64(at + 16, true),
      view.getFloat64(at + 24, true),
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
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 16);
  const node = view.getBigUint64(0, true);
  const offset = view.getFloat64(8, true);
  return { node: core.wrapperFor(node), offset };
}

// The nodes at a viewport point, topmost first, the root element last
// (geometry_hits_test). The handles are copied out before any wrapper is
// made, since making one can run another core operation.
export function geometryHits(core, handle, x, y) {
  const count = core.status("geometry_hits_test", handle, x, y);
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), count * 8);
  const handles = [];
  for (let index = 0; index < count; index++) handles.push(view.getBigUint64(index * 8, true));
  return handles.map((node) => core.wrapperFor(node));
}

const noSelectionRectangles = Object.freeze([]);

function writeSelectionSpan(view, offset, span) {
  view.setBigUint64(offset, span.node._coreHandle, true);
  view.setFloat64(offset + 8, span.start, true);
  view.setFloat64(offset + 16, span.end, true);
  view.setFloat64(offset + 24, span.deltaX ?? 0, true);
  view.setFloat64(offset + 32, span.deltaY ?? 0, true);
}

function readSelectionRectangles(core, count) {
  if (count === 0) return noSelectionRectangles;
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 32);
  const rectangles = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 32;
    rectangles.push(Object.freeze({
      x: view.getFloat64(offset, true),
      y: view.getFloat64(offset + 8, true),
      width: view.getFloat64(offset + 16, true),
      height: view.getFloat64(offset + 24, true),
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
  const pointer = core.status("abi_allocate", spans.length * 40);
  const view = new DataView(core.refreshBytes().buffer, pointer, spans.length * 40);
  for (let index = 0; index < spans.length; index++) {
    writeSelectionSpan(view, index * 40, spans[index]);
  }
  const count = core.status("geometry_selection_rects", snapshot.geometryHandle,
    pointer, spans.length, physical ? 1 : 0, deviceScale);
  return readSelectionRectangles(core, count);
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
  return count === 0 ? null : readSelectionRectangles(core, count)[0];
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

// A text node's glyph and caret geometry from the previous frame, valid
// for this frame's painted line rectangles, or null when it has to be
// rebuilt. The captured rectangles (`anchors`, one x/y/width/height
// quadruple per painted line) must still describe the same lines at the
// same sizes; a uniform move becomes the geometry's translation, measured
// from the capture so it never accumulates.
export function keptTextGeometryFor(previous, operations) {
  const anchors = previous.anchors;
  if (anchors === undefined || anchors.length !== operations.length * 4) {
    return null;
  }
  const deltaX = operations[0].logicalRectangle.x - anchors[0];
  const deltaY = operations[0].logicalRectangle.y - anchors[1];
  for (let index = 0; index < operations.length; index++) {
    const rectangle = operations[index].logicalRectangle;
    if (
      rectangle.x - anchors[index * 4] !== deltaX ||
      rectangle.y - anchors[index * 4 + 1] !== deltaY ||
      rectangle.width !== anchors[index * 4 + 2] ||
      rectangle.height !== anchors[index * 4 + 3]
    ) {
      return null;
    }
  }
  if (
    deltaX === 0 && deltaY === 0 && (previous.translationX ?? 0) === 0 &&
    (previous.translationY ?? 0) === 0
  ) {
    return previous;
  }
  return Object.freeze({
    ...previous,
    translationX: deltaX,
    translationY: deltaY,
  });
}

// Whether two text geometries of a node hold the same values: caret stops,
// glyphs, captured line rectangles and translation, field for field.
// Object.is keeps -0 apart from +0, as a snapshot's bytes do.
export function sameTextGeometryValues(previous, geometry) {
  if (
    !Object.is(previous.translationX ?? 0, geometry.translationX ?? 0) ||
    !Object.is(previous.translationY ?? 0, geometry.translationY ?? 0)
  ) return false;
  const anchors = geometry.anchors;
  if (previous.anchors === undefined || previous.anchors.length !== anchors.length) return false;
  for (let index = 0; index < anchors.length; index++) {
    if (!Object.is(previous.anchors[index], anchors[index])) return false;
  }
  if (previous.glyphs.length !== geometry.glyphs.length) return false;
  for (let index = 0; index < geometry.glyphs.length; index++) {
    const before = previous.glyphs[index];
    const glyph = geometry.glyphs[index];
    if (
      !Object.is(before.sourceStart, glyph.sourceStart) || !Object.is(before.sourceEnd, glyph.sourceEnd) ||
      !Object.is(before.x, glyph.x) || !Object.is(before.width, glyph.width) ||
      !Object.is(before.top, glyph.top) || !Object.is(before.bottom, glyph.bottom)
    ) return false;
  }
  if (previous.caretStops.length !== geometry.caretStops.length) return false;
  for (let index = 0; index < geometry.caretStops.length; index++) {
    const before = previous.caretStops[index];
    const stop = geometry.caretStops[index];
    if (
      !Object.is(before.sourceOffset, stop.sourceOffset) || !Object.is(before.x, stop.x) ||
      !Object.is(before.top, stop.top) || !Object.is(before.bottom, stop.bottom) ||
      before.affinity !== stop.affinity
    ) return false;
  }
  return true;
}

export function uniqueCaretStops(node, stops) {
  const core = node._domCore;
  const pointer = core.status("abi_allocate", stops.length * 24);
  const view = new DataView(core.refreshBytes().buffer, pointer, stops.length * 24);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    view.setFloat64(index * 24, stop.sourceOffset, true);
    view.setFloat64(index * 24 + 8, stop.x, true);
    view.setFloat64(index * 24 + 16, stop.top, true);
  }
  const count = core.status("geometry_unique_carets", node._coreHandle, pointer, stops.length);
  const ordinals = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 4);
  const result = [];
  for (let index = 0; index < count; index++) {
    result.push(stops[ordinals.getUint32(index * 4, true)]);
  }
  return result;
}
