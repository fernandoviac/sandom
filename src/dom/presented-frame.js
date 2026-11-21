// Accepted pixels and this immutable native handle are published together.
// The host owns wrapper identity/decoding; geometry.watpart owns targeting,
// transforms, clips, stacking, scroll facts and generation-safe retention.
// Host-side records are decoded on demand: hit testing, scrolling and
// anchoring query the native snapshot directly, so a frame that nobody
// inspects materializes no JavaScript records.
import { buildGeometry, buildGeometryFrameSuccessor, buildGeometryRestyleSuccessor, buildGeometrySuccessor, controlSelectionRectangles, EMPTY_SCROLLBAR_TAIL, geometryRect, TextStoreGeometry } from "./geometry.js";
import { GEOMETRY_RECORD_SIZE } from "../dom-wasm/geometry-wire.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The geometry record fields and public box values of geometry.watpart.
const RECORD = Object.freeze(Object.fromEntries(["HANDLE", "PARENT", "ENGINE_INDEX", "FLAGS", "OVERFLOW_X", "OVERFLOW_Y",
  "BOX", "COMPOSED", "CLIP", "Z_INDEX"].map((name) => [name, layoutConstant(`GEOMETRY_RECORD_${name}`)])));
const FLAG = Object.freeze(Object.fromEntries(["BOX", "HITABLE", "VIEWPORT"]
  .map((name) => [name, layoutConstant(`GEOMETRY_FLAG_${name}`)])));
const FIELD = Object.freeze(Object.fromEntries([
  "BOX_X", "BOX_Y", "OFFSET_WIDTH", "OFFSET_HEIGHT", "CONTENT_X", "CONTENT_Y", "CONTENT_WIDTH", "CONTENT_HEIGHT",
  "SCROLL_LEFT", "SCROLL_TOP", "SCROLL_WIDTH", "SCROLL_HEIGHT", "STICKY_LEFT", "STICKY_TOP", "CLIENT_WIDTH",
  "CLIENT_HEIGHT", "SCROLL_MIN_LEFT", "SCROLL_MAX_LEFT", "SCROLL_MIN_TOP", "SCROLL_MAX_TOP", "USER_SCROLL_X",
  "USER_SCROLL_Y", "OVERSCROLL_BEHAVIOR_X", "OVERSCROLL_BEHAVIOR_Y", "BLOCK_AXIS", "BLOCK_AXIS_SIGN", "INLINE_AXIS",
  "INLINE_AXIS_SIGN",
].map((name) => [name, layoutConstant(`GEOMETRY_${name}`)])));
const F64 = Float64Array.BYTES_PER_ELEMENT;

const axis = (value, sign) => Object.freeze({ axis: value === 0 ? "x" : "y", startAtHigh: sign < 0 });
const overscroll = ["auto", "contain", "none"];

function decodeRecord(core, handle, index) {
  core.status("geometry_record_export", handle, index);
  const view = core.output("geometry_record_export");
  const value = (name) => view.getFloat64(RECORD.BOX + FIELD[name] * F64, true);
  const flags = view.getUint32(RECORD.FLAGS, true);
  const nodeHandle = view.getBigUint64(RECORD.HANDLE, true);
  const parentIndex = view.getInt32(RECORD.PARENT, true);
  const engineIndex = view.getInt32(RECORD.ENGINE_INDEX, true);
  const box = flags & FLAG.BOX ? Object.freeze({
    x: value("BOX_X"), y: value("BOX_Y"), w: value("OFFSET_WIDTH"), h: value("OFFSET_HEIGHT"),
    cx: value("CONTENT_X"), cy: value("CONTENT_Y"), cw: value("CONTENT_WIDTH"), ch: value("CONTENT_HEIGHT"),
    scrollLeft: value("SCROLL_LEFT"), scrollTop: value("SCROLL_TOP"), scrollWidth: value("SCROLL_WIDTH"),
    scrollHeight: value("SCROLL_HEIGHT"), stickyLeft: value("STICKY_LEFT"), stickyTop: value("STICKY_TOP"),
  }) : null;
  const matrix = Object.freeze(Array.from({ length: 6 }, (_, i) => view.getFloat64(RECORD.COMPOSED + i * F64, true)));
  const clip = view.getUint32(RECORD.OVERFLOW_X, true) || view.getUint32(RECORD.OVERFLOW_Y, true) ? Object.freeze({
    left: view.getFloat64(RECORD.CLIP, true), top: view.getFloat64(RECORD.CLIP + F64, true),
    right: view.getFloat64(RECORD.CLIP + 2 * F64, true), bottom: view.getFloat64(RECORD.CLIP + 3 * F64, true),
  }) : null;
  const viewport = Boolean(flags & FLAG.VIEWPORT);
  const scroll = box && (value("USER_SCROLL_X") || value("USER_SCROLL_Y") || viewport) ? Object.freeze({
    userX: Boolean(value("USER_SCROLL_X") || viewport), userY: Boolean(value("USER_SCROLL_Y") || viewport),
    blockAxis: axis(value("BLOCK_AXIS"), value("BLOCK_AXIS_SIGN")),
    inlineAxis: axis(value("INLINE_AXIS"), value("INLINE_AXIS_SIGN")),
    left: value("SCROLL_LEFT"), top: value("SCROLL_TOP"), minLeft: value("SCROLL_MIN_LEFT"),
    maxLeft: value("SCROLL_MAX_LEFT"), minTop: value("SCROLL_MIN_TOP"), maxTop: value("SCROLL_MAX_TOP"),
    clientWidth: value("CLIENT_WIDTH"), clientHeight: value("CLIENT_HEIGHT"),
  }) : null;
  const element = nodeHandle === 0n ? null : core.wrapperFor(nodeHandle);
  return {
    nodeHandle, element, parentIndex, engineIndex, viewport, order: index, box, hitable: Boolean(flags & FLAG.HITABLE),
    zIndex: view.getFloat64(RECORD.Z_INDEX, true), matrix, clip,
    overscrollX: overscroll[value("OVERSCROLL_BEHAVIOR_X")], overscrollY: overscroll[value("OVERSCROLL_BEHAVIOR_Y")], scroll,
  };
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


// Whether a frame's text geometry store holds the predecessor's text: the
// same owners in the same order over the same data, whatever their
// translations (geometry_text_store_holds).
function textRunsHold(predecessor, textStore) {
  return predecessor.geometryCore.status("geometry_text_store_holds", predecessor.geometryHandle, textStore) !== 0;
}

// Whether the predecessor's envelope holds for a frame
// (frame_successor_envelope): the same root and, for a scroll successor,
// the same publication and box row count; the same viewport row, size and
// device scale; and the frame has source revisions.
function envelopeHolds(predecessor, { root, viewport, viewportIndex, boxes, publication, sourceRevisions }, scroll) {
  return predecessor.geometryCore.exports.frame_successor_envelope(
    predecessor._root === root ? 1 : 0,
    !scroll || predecessor._publication === publication ? 1 : 0,
    sourceRevisions ? 1 : 0,
    predecessor._viewportIndex,
    viewportIndex,
    predecessor._inputBoxes.length,
    scroll ? boxes.length : -1,
    predecessor.viewport.width,
    predecessor.viewport.height,
    predecessor.viewport.deviceScale,
    viewport.width,
    viewport.height,
    viewport.deviceScale,
  ) === 1;
}

// Why a frame that only scrolled cannot take its geometry from the
// presented `predecessor`, or null when it can: "envelope" for another
// root, publication, row count or viewport (envelopeHolds); "revisions"
// when a source revision moved (frame_successor_revisions; the
// predecessor's element facts were resolved under them); "text" for text
// geometry that is not the predecessor's at most translated
// (textRunsHold).
function scrollRefusal(predecessor, frame) {
  if (!envelopeHolds(predecessor, frame, true)) return "envelope";
  if (!sourceRevisionsHold(predecessor, frame)) return "revisions";
  return textRunsHold(predecessor, frame.textStore) ? null : "text";
}

// Whether the source revisions under which `predecessor`'s element facts
// were resolved are the frame's and current (frame_successor_revisions).
function sourceRevisionsHold(predecessor, { root, sourceRevisions }) {
  const document = root.ownerDocument;
  return predecessor.geometryCore.status(
    "frame_successor_revisions",
    predecessor.geometryHandle,
    document._coreHandle,
    BigInt(sourceRevisions.document),
    BigInt(sourceRevisions.style),
    BigInt(sourceRevisions.resource),
    BigInt(sourceRevisions.viewport),
    BigInt(document._styleSystem?.generation ?? 0),
  ) === 1;
}

// Why a frame cannot take its geometry from the geometry it built of its
// tree before it rasterized (`frameGeometry`, shaped as a presented frame:
// its rendering observers' checkpoint), or null when it can: "envelope" or
// "revisions" as scrollRefusal gives them. The text needs no check: the
// derived snapshot's text block is the frame's text store
// (geometry_frame_successor).
function frameGeometryRefusal(frameGeometry, frame) {
  if (!envelopeHolds(frameGeometry, frame, true)) return "envelope";
  return sourceRevisionsHold(frameGeometry, frame) ? null : "revisions";
}

// Why a restyled frame cannot take its geometry from the presented
// `predecessor`, as far as the host knows it, or null: "viewport" for
// another root, viewport size, device scale or viewport row (the successor
// keeps the predecessor's envelope) or a frame without revisions; "text"
// for text geometry that is not the predecessor's at most translated
// (textRunsHold). The core proves the tree, the rows and the fragments.
function restyleRefusal(predecessor, frame) {
  if (!envelopeHolds(predecessor, frame, false)) return "viewport";
  return textRunsHold(predecessor, frame.textStore) ? null : "text";
}

// A restyled frame's geometry derived from the presented `predecessor`
// before the frame rasters (geometry_restyle_successor), for the frame's
// scrollbars, which the raster paints: the predecessor's text store and no
// scrollbars. The frame's interaction snapshot then derives from it as a
// scroll successor with the frame's scrollbars and text store
// (buildInteractionSnapshot `restyleBasis`), so the frame builds no
// snapshot of its own for its scrollbars. Returns { basis, refusal }: the
// basis (shaped as a presented frame for scrollRefusal, holding `geometry`
// and the restyle `work`) or null and the refusal as restyleRefusal gives
// it. The caller releases `basis.geometry`.
export function deriveRestyleBasis(predecessor, { root, viewport, viewportIndex, boxes, publication, revision, sourceRevisions }) {
  const textStore = predecessor.textStore;
  const refusal = restyleRefusal(predecessor, { root, viewport, viewportIndex, sourceRevisions, textStore });
  if (refusal !== null) return { basis: null, refusal };
  const derived = buildGeometryRestyleSuccessor({
    predecessor: predecessor.geometry, root, boxes, publication, viewportIndex, revision, scrollbarTail: EMPTY_SCROLLBAR_TAIL, textStore, sourceRevisions,
  });
  if (derived.geometry === null) return { basis: null, refusal: derived.refusal };
  return {
    basis: {
      geometry: derived.geometry, geometryCore: derived.geometry.core, geometryHandle: derived.geometry.handle,
      work: derived.work, textStore, viewport: predecessor.viewport,
      _root: root, _publication: publication, _viewportIndex: viewportIndex, _inputBoxes: boxes,
    },
    refusal: null,
  };
}

// `scrollPredecessor`: the presented frame this one only scrolled from, or
// null. When its geometry still describes this frame apart from boxes,
// scrollbars and text translations, the snapshot is derived from it.
// `restyleBasis`: this frame's restyle basis (deriveRestyleBasis), or null;
// the snapshot derives from it as a scroll successor when the frame's boxes,
// revisions and text still hold for it. `restylePredecessor`: the presented
// frame this one restyled from without inserting, removing or laying out a
// row (the renderer's report), or null. When the viewport and the text
// geometry are its own, the core derives the snapshot from it
// (geometry_restyle_successor), or refuses and the snapshot is built.
// `textStore`: the frame's text geometry store (geometry_text_store, or
// 0), which the snapshot holds; the frame reads it as `textGeometryByNode`
// and its text controls' entries as `textGeometryByElement`
// (TextStoreGeometry), sharing the decoded entries the store keeps from
// `previousTextGeometry`, the presented frame's. The frame names the
// derivation (`_derivation`: "scroll", "restyle", "frame" or null), a refusal
// (`_scrollRefusal`, `_restyleRefusal`, `_frameGeometryRefusal`) and the
// derivation's work (`_successorWork`, geometry.js successorWork; null for a
// built snapshot; a restyle basis's restyle work). `restyleBasisRefusal`: why
// the frame has no restyle basis (deriveRestyleBasis), or null.
// `frameGeometry`: the geometry this frame built of its tree before it
// rasterized, shaped as a presented frame, or null; a snapshot that no
// predecessor gives derives from it (geometry_frame_successor).
export function buildInteractionSnapshot({ root, viewport, viewportIndex = 0, revision, boxes, publication, scrollbars, scrollbarTail, timeMilliseconds, textStore = 0, previousTextGeometry = null, sourceRevisions, scrollPredecessor = null, restyleBasis = null, restyleBasisRefusal = null, restylePredecessor = null, frameGeometry = null }) {
  let derivation = null;
  let refusal = null;
  let work = null;
  let geometry = null;
  const scrollRefused = scrollPredecessor === null ? null
    : scrollRefusal(scrollPredecessor, { root, viewport, viewportIndex, boxes, publication, sourceRevisions, textStore });
  const basisRefused = restyleBasis === null ? null
    : scrollRefusal(restyleBasis, { root, viewport, viewportIndex, boxes, publication, sourceRevisions, textStore });
  if (scrollPredecessor !== null && scrollRefused === null) {
    ({ geometry, work } = buildGeometrySuccessor({ predecessor: scrollPredecessor.geometry, root, boxes, revision, scrollbarTail, textStore, sourceRevisions }));
    derivation = "scroll";
  } else if (restyleBasis !== null && basisRefused === null) {
    ({ geometry } = buildGeometrySuccessor({ predecessor: restyleBasis.geometry, root, boxes, revision, scrollbarTail, textStore, sourceRevisions }));
    work = restyleBasis.work;
    derivation = "restyle";
  } else if (restylePredecessor !== null) {
    refusal = restyleRefusal(restylePredecessor, { root, viewport, viewportIndex, sourceRevisions, textStore });
    if (refusal === null) {
      const derived = buildGeometryRestyleSuccessor({ predecessor: restylePredecessor.geometry, root, boxes, publication, viewportIndex, revision, scrollbarTail, textStore, sourceRevisions });
      refusal = derived.refusal;
      if (derived.geometry !== null) {
        geometry = derived.geometry;
        work = derived.work;
        derivation = "restyle";
      }
    }
  }
  let frameRefused = null;
  if (geometry === null && frameGeometry !== null) {
    frameRefused = frameGeometryRefusal(frameGeometry, { root, viewport, viewportIndex, boxes, publication, sourceRevisions });
    if (frameRefused === null) {
      ({ geometry, work } = buildGeometryFrameSuccessor({ predecessor: frameGeometry.geometry, root, boxes, revision, scrollbarTail, textStore, sourceRevisions }));
      derivation = "frame";
    }
  }
  if (geometry === null) {
    geometry = buildGeometry({ root, viewport, viewportIndex, revision, boxes, publication, scrollbarTail, textStore, sourceRevisions, presented: true });
  }
  let decoded = null;
  const textGeometryByNode = new TextStoreGeometry(geometry.core, textStore, previousTextGeometry);
  const textGeometryByElement = textGeometryByNode.controls();
  const frame = {
    kind: "presented-interaction-frame", version: 1, revision, timeMilliseconds,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale }),
    // Inspection overlays must describe the delivered pixels, without
    // triggering a fresh live layout or decoding every geometry record.
    getBoundingClientRect(element) {
      if (element?._domCore !== geometry.core || element.nodeType !== 1) {
        throw new TypeError("Presented bounds require an element from this DOM core");
      }
      return geometryRect(geometry.core, geometry.handle, element._coreHandle);
    },
    geometry, geometryCore: geometry.core, geometryHandle: geometry.handle,
    // The text geometry store the snapshot holds.
    textStore,
    // A scroll or restyle successor of the presented frame; a "frame"
    // derivation comes from this frame's own geometry, not a predecessor.
    _derivedFromPredecessor: derivation === "scroll" || derivation === "restyle",
    _derivation: derivation,
    _scrollRefusal: scrollRefused,
    _restyleRefusal: refusal,
    // Why the frame's restyle basis did not give the snapshot: the basis's
    // own refusal (deriveRestyleBasis) or the scroll successor's from it.
    _restyleBasisRefusal: restyleBasis === null ? restyleBasisRefusal : basisRefused,
    // Why the frame geometry did not give the snapshot, or null.
    _frameGeometryRefusal: frameRefused,
    _successorWork: work,
    _inputBoxes: boxes, _root: root, _publication: publication, _viewportIndex: viewportIndex,
    textGeometryByElement, textGeometryByNode,
    // The scrollbars and the geometry tail that holds them.
    scrollbarTail,
    scrollbars: Object.freeze(scrollbars.map((scrollbar) => Object.freeze({ ...scrollbar, track: Object.freeze({ ...scrollbar.track }), clip: scrollbar.clip ? Object.freeze({ ...scrollbar.clip }) : null }))),
  };
  // Each text control's selection rectangles (selectionRectanglesByElement),
  // answered by this frame's geometry while it is live: they depend on the
  // control's scroll and its ancestors'.
  const selectionRectanglesByElement = new Map();
  for (const [element, entry] of textGeometryByElement) {
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
