// Accepted pixels and this immutable native handle are published together.
// The host owns wrapper identity/decoding; geometry.watpart owns targeting,
// transforms, clips, stacking, scroll facts and generation-safe retention.
// Host-side records are decoded on demand: hit testing, scrolling and
// anchoring query the native snapshot directly, so a frame that nobody
// inspects materializes no JavaScript records.
import { buildGeometry, buildGeometryRestyleSuccessor, buildGeometrySuccessor, controlSelectionRectangles, snapshotTextGeometry, TextGeometryView } from "./geometry.js";
import { GEOMETRY_RECORD_SIZE } from "../dom-wasm/geometry-wire.js";

const axis = (value, sign) => Object.freeze({ axis: value === 0 ? "x" : "y", startAtHigh: sign < 0 });
const overscroll = ["auto", "contain", "none"];

function decodeRecord(core, handle, index) {
  core.status("geometry_record_export", handle, index);
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), GEOMETRY_RECORD_SIZE);
  const value = (field) => view.getFloat64(32 + field * 8, true);
  const flags = view.getUint32(16, true);
  const nodeHandle = view.getBigUint64(0, true);
  const parentIndex = view.getInt32(8, true);
  const engineIndex = view.getInt32(12, true);
  const box = flags & 1 ? Object.freeze({ x: value(0), y: value(1), w: value(2), h: value(3), cx: value(4), cy: value(5), cw: value(6), ch: value(7), scrollLeft: value(8), scrollTop: value(9), scrollWidth: value(10), scrollHeight: value(11), stickyLeft: value(12), stickyTop: value(13) }) : null;
  const matrix = Object.freeze(Array.from({ length: 6 }, (_, i) => view.getFloat64(464 + i * 8, true)));
  const clip = view.getUint32(20, true) || view.getUint32(24, true) ? Object.freeze({ left: view.getFloat64(512, true), top: view.getFloat64(520, true), right: view.getFloat64(528, true), bottom: view.getFloat64(536, true) }) : null;
  const scroll = box && (value(20) || value(21) || (flags & 64)) ? Object.freeze({ userX: Boolean(value(20) || (flags & 64)), userY: Boolean(value(21) || (flags & 64)), blockAxis: axis(value(24), value(25)), inlineAxis: axis(value(26), value(27)), left: value(8), top: value(9), minLeft: value(16), maxLeft: value(17), minTop: value(18), maxTop: value(19), clientWidth: value(14), clientHeight: value(15) }) : null;
  const element = nodeHandle === 0n ? null : core.wrapperFor(nodeHandle);
  return { nodeHandle, element, parentIndex, engineIndex, viewport: Boolean(flags & 64), order: index, box, hitable: Boolean(flags & 2), zIndex: view.getFloat64(544, true), matrix, clip, overscrollX: overscroll[value(22)], overscrollY: overscroll[value(23)], scroll };
}

// Every record of the snapshot, decoded once and memoized on the frame.
function decodeAll(frame) {
  const { geometryCore: core, geometryHandle: handle } = frame;
  const allRecords = [];
  const records = [];
  const recordOf = new Map();
  let viewportScroll = null;
  const boxes = frame._inputBoxes.slice();
  for (let i = 0, count = core.status("geometry_count", handle); i < count; i++) {
    const record = decodeRecord(core, handle, i);
    record.parent = record.parentIndex < 0 ? null : allRecords[record.parentIndex];
    allRecords.push(Object.freeze(record));
    if (record.engineIndex >= 0) boxes[record.engineIndex] = record.box;
    if (record.viewport) viewportScroll = record.scroll;
    if (record.element?.nodeType !== 1) continue;
    records.push(record);
    recordOf.set(record.element, record);
  }
  return Object.freeze({ records: Object.freeze(records), recordOf, boxes: Object.freeze(boxes), viewportScroll });
}

const successorRevisionNames = ["document", "style", "resource", "viewport"];

// The text geometry a snapshot's text block was written from: a view's
// base, or the map itself.
function textGeometryBase(textGeometry) {
  return textGeometry instanceof TextGeometryView ? textGeometry.base : textGeometry;
}

// Whether two text geometries of a node cover the same caret stops and
// glyphs, whatever their translations.
function sameTextRun(previous, geometry) {
  if (previous === undefined || previous.glyphs !== geometry.glyphs) return false;
  if (previous.caretStops === geometry.caretStops) return true;
  if (previous.caretStops.length !== geometry.caretStops.length) return false;
  for (let index = 0; index < geometry.caretStops.length; index++) {
    if (previous.caretStops[index] !== geometry.caretStops[index]) return false;
  }
  return true;
}

// Whether `textGeometry` covers the predecessor's text block: the same
// entries in the same order over the same caret stops and glyphs, whatever
// their translations. A view over the predecessor's base shares that
// base's entries; only the ones it finished itself are compared.
function textRunsHold(predecessor, textGeometry) {
  const previousText = snapshotTextGeometry(predecessor.textGeometryByNode, predecessor.textGeometryByElement);
  if (previousText.size !== textGeometry.size) return false;
  if (textGeometry instanceof TextGeometryView && textGeometry.base === textGeometryBase(previousText)) {
    for (const node of textGeometry.overrides.keys()) {
      if (!sameTextRun(previousText.get(node), textGeometry.get(node))) return false;
    }
    return true;
  }
  const previousEntries = previousText.entries();
  for (const [node, geometry] of textGeometry) {
    const [previousNode, previous] = previousEntries.next().value;
    if (previousNode !== node || !sameTextRun(previous, geometry)) return false;
  }
  return true;
}

// Whether a frame that only scrolled can take its geometry from the
// presented `predecessor`: the same root, publication, viewport and box
// rows, revisions that still hold (the predecessor's element facts were
// resolved under them), and text geometry that differs at most in its
// translation (textRunsHold).
function scrollSuccessorHolds(predecessor, { root, viewport, viewportIndex, boxes, publication, sourceRevisions, textGeometry }) {
  if (
    predecessor._root !== root || predecessor._publication !== publication ||
    predecessor._viewportIndex !== viewportIndex || predecessor._inputBoxes.length !== boxes.length ||
    predecessor.viewport.width !== viewport.width || predecessor.viewport.height !== viewport.height ||
    predecessor.viewport.deviceScale !== viewport.deviceScale || !sourceRevisions
  ) return false;
  const document = root.ownerDocument;
  const core = predecessor.geometryCore;
  for (const [field, name] of successorRevisionNames.entries()) {
    if (core.status("geometry_revision", predecessor.geometryHandle, field) !== BigInt(sourceRevisions[name])) return false;
  }
  if (
    BigInt(core.status("document_style_generation", document._coreHandle)) !== BigInt(sourceRevisions.document) ||
    BigInt(core.status("resource_revision")) !== BigInt(sourceRevisions.resource) ||
    BigInt(document._styleSystem?.generation ?? 0) !== BigInt(sourceRevisions.style)
  ) return false;
  return textRunsHold(predecessor, textGeometry);
}

// Why a restyled frame cannot take its geometry from the presented
// `predecessor`, as far as the host knows it, or null: "viewport" for
// another root, viewport size, device scale or viewport row (the successor
// keeps the predecessor's envelope) or a frame without revisions; "text"
// for text geometry that is not the predecessor's at most translated
// (textRunsHold). The core proves the tree, the rows and the fragments.
function restyleRefusal(predecessor, { root, viewport, viewportIndex, sourceRevisions, textGeometry }) {
  if (
    predecessor._root !== root || predecessor._viewportIndex !== viewportIndex ||
    predecessor.viewport.width !== viewport.width || predecessor.viewport.height !== viewport.height ||
    predecessor.viewport.deviceScale !== viewport.deviceScale || !sourceRevisions
  ) return "viewport";
  return textRunsHold(predecessor, textGeometry) ? null : "text";
}

// Whether every text geometry entry of a frame is the predecessor's own
// object, in the predecessor's order, and the predecessor's node map is
// the text geometry its text block was written from. The frame's snapshot
// then shares that block, and the frame keeps the predecessor's node map.
function sameTextObjects(predecessor, textGeometry) {
  const previousText = predecessor.textGeometryByNode;
  if (
    previousText.size !== textGeometry.size ||
    snapshotTextGeometry(previousText, predecessor.textGeometryByElement) !== previousText
  ) return false;
  const previousEntries = previousText.entries();
  for (const [node, geometry] of textGeometry) {
    const [previousNode, previous] = previousEntries.next().value;
    if (previousNode !== node || previous !== geometry) return false;
  }
  return true;
}

// Whether a successor keeps its predecessor's carets and glyphs: the
// frame's text geometry is a view over the base the predecessor's text
// block was written from, and each entry the view finished itself has the
// run and the translation of the predecessor's entry. A translation holds
// no scroll, so a scroll keeps every entry.
function sharedText(predecessor, textGeometry) {
  if (!(textGeometry instanceof TextGeometryView)) return false;
  const previousText = snapshotTextGeometry(predecessor.textGeometryByNode, predecessor.textGeometryByElement);
  if (textGeometryBase(previousText) !== textGeometry.base) return false;
  for (const node of textGeometry.overrides.keys()) {
    const previous = previousText.get(node);
    const geometry = textGeometry.get(node);
    if (
      !sameTextRun(previous, geometry) ||
      !Object.is(previous.translationX ?? 0, geometry.translationX ?? 0) ||
      !Object.is(previous.translationY ?? 0, geometry.translationY ?? 0)
    ) return false;
  }
  return true;
}

// `scrollPredecessor`: the presented frame this one only scrolled from, or
// null. When its geometry still describes this frame apart from boxes,
// scrollbars and text translations, the snapshot is derived from it.
// `restylePredecessor`: the presented frame this one restyled from without
// inserting, removing or laying out a row (the renderer's report), or
// null. When the viewport and the text geometry are its own, the core
// derives the snapshot from it (geometry_restyle_successor), or refuses and
// the snapshot is built. The frame names the derivation (`_derivation`:
// "scroll", "restyle" or null), a refusal (`_restyleRefusal`) and the
// derivation's work (`_successorWork`, geometry.js successorWork; null for
// a built snapshot).
export function buildInteractionSnapshot({ root, viewport, viewportIndex = 0, revision, boxes, publication, scrollbars, timeMilliseconds, textGeometryByElement = new Map(), textGeometryByNode = new Map(), sourceRevisions, scrollPredecessor = null, restylePredecessor = null }) {
  const textGeometry = snapshotTextGeometry(textGeometryByNode, textGeometryByElement);
  let derivation = null;
  let refusal = null;
  let work = null;
  let shareText = false;
  let keptTextGeometry = textGeometryByNode;
  let geometry = null;
  if (scrollPredecessor !== null && scrollSuccessorHolds(scrollPredecessor, { root, viewport, viewportIndex, boxes, publication, sourceRevisions, textGeometry })) {
    shareText = sharedText(scrollPredecessor, textGeometry);
    if (!shareText && sameTextObjects(scrollPredecessor, textGeometry)) {
      shareText = true;
      keptTextGeometry = scrollPredecessor.textGeometryByNode;
    }
    ({ geometry, work } = buildGeometrySuccessor({ predecessor: scrollPredecessor.geometry, root, boxes, revision, scrollbars, textGeometry, shareText, sourceRevisions }));
    derivation = "scroll";
  } else if (restylePredecessor !== null) {
    refusal = restyleRefusal(restylePredecessor, { root, viewport, viewportIndex, sourceRevisions, textGeometry });
    if (refusal === null) {
      shareText = sharedText(restylePredecessor, textGeometry);
      if (!shareText && sameTextObjects(restylePredecessor, textGeometry)) {
        shareText = true;
        keptTextGeometry = restylePredecessor.textGeometryByNode;
      }
      const derived = buildGeometryRestyleSuccessor({ predecessor: restylePredecessor.geometry, root, boxes, publication, viewportIndex, revision, scrollbars, textGeometry, shareText, sourceRevisions });
      refusal = derived.refusal;
      if (derived.geometry !== null) {
        geometry = derived.geometry;
        work = derived.work;
        derivation = "restyle";
      }
    }
  }
  if (geometry === null) {
    keptTextGeometry = textGeometryByNode;
    geometry = buildGeometry({ root, viewport, viewportIndex, revision, boxes, publication, scrollbars, textGeometryByElement, textGeometryByNode, sourceRevisions, presented: true });
  }
  const frameTextGeometryByNode = keptTextGeometry;
  let decoded = null;
  const frame = {
    kind: "presented-interaction-frame", version: 1, revision, timeMilliseconds,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale }),
    geometry, geometryCore: geometry.core, geometryHandle: geometry.handle,
    _derivedFromPredecessor: derivation !== null,
    _derivation: derivation,
    _restyleRefusal: refusal,
    _successorWork: work,
    _inputBoxes: boxes, _root: root, _publication: publication, _viewportIndex: viewportIndex,
    textGeometryByElement, textGeometryByNode: frameTextGeometryByNode,
    scrollbars: Object.freeze(scrollbars.map((scrollbar) => Object.freeze({ ...scrollbar, track: Object.freeze({ ...scrollbar.track }), clip: scrollbar.clip ? Object.freeze({ ...scrollbar.clip }) : null }))),
  };
  // Each text control's selection rectangles (selectionRectanglesByElement),
  // answered by this frame's geometry while it is live: they depend on the
  // control's scroll and its ancestors'.
  const selectionRectanglesByElement = new Map();
  for (const [element, entry] of textGeometryByElement) {
    if (entry.selectionStart === undefined) continue;
    selectionRectanglesByElement.set(element, controlSelectionRectangles(frame, element, entry));
  }
  frame.selectionRectanglesByElement = selectionRectanglesByElement;
  const lazy = (name) => ({ enumerable: true, get() { decoded ??= decodeAll(frame); return decoded[name]; } });
  Object.defineProperties(frame, { records: lazy("records"), recordOf: lazy("recordOf"), boxes: lazy("boxes"), viewportScroll: lazy("viewportScroll") });
  return Object.freeze(frame);
}

export function hitTestSnapshot(snapshot, x, y) {
  const core = snapshot.geometryCore;
  return core.wrapperFor(core.status("geometry_hit_test", snapshot.geometryHandle, x, y));
}

export function scrollbarAtPoint(snapshot, x, y) {
  const index = snapshot.geometryCore.status("geometry_scrollbar_hit", snapshot.geometryHandle, x, y);
  return index < 0 ? null : snapshot.scrollbars[index];
}
