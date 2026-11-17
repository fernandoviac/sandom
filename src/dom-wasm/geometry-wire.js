// Primitive geometry wire encoding; no DOM implementation or renderer imports.
import { hostNow } from "../host-clock.js";
import { layoutConstant } from "../wasm/layout-table.js";
const boxNames = [
  "x",
  "y",
  "w",
  "h",
  "cx",
  "cy",
  "cw",
  "ch",
  "scrollLeft",
  "scrollTop",
  "scrollWidth",
  "scrollHeight",
  "stickyLeft",
  "stickyTop",
];
const noFragments = Object.freeze([]);

// The box snapshot layout (geometry-build.watpart): a 24-byte header
// (magic, row count, fragment count, SVG path-reference rows, serial),
// rows of the fourteen box values, the classic scrollbar space in the
// box's padding (top, right, bottom, left f64 CSS px) @112, u32 first
// fragment @144, u32 fragment count @148, u32 scroll owner @152 (the row
// of the innermost scroller whose scroll moves the box, + 1, or 0 for
// none), 4 reserved bytes and the effective scroll offsets (x, y f64 CSS
// px) @160, inline-start scrollable line overflow f64 @176, used margins
// and padding TRBL (eight f64 CSS px) @184, then the fragments. A fragment
// is a border box (x, y, w, h f64 CSS px) relative to its box's border box origin; the geometry wire
// (geometry.watpart) carries the same fragments after its glyph block. A
// box object carries no scroll owner: an upload of box objects has none,
// and its geometry holds client positions.
export const BOX_SNAPSHOT_HEADER_SIZE = layoutConstant("GEOMETRY_BOXES_HEADER_SIZE");
export const BOX_SNAPSHOT_ROW_SIZE = layoutConstant("GEOMETRY_BOXES_ROW_SIZE");
const BOX_SNAPSHOT_MAGIC = layoutConstant("GEOMETRY_BOXES_MAGIC");
const BOX_HEADER_MAGIC = layoutConstant("GEOMETRY_BOXES_HEADER_MAGIC");
const BOX_HEADER_COUNT = layoutConstant("GEOMETRY_BOXES_HEADER_COUNT");
const BOX_HEADER_FRAGMENTS = layoutConstant("GEOMETRY_BOXES_HEADER_FRAGMENTS");
const BOX_HEADER_SVG = layoutConstant("GEOMETRY_BOXES_HEADER_SVG");
const BOX_ROW_SCROLLBAR_SPACE = layoutConstant("GEOMETRY_BOXES_ROW_SCROLLBAR_SPACE");
const BOX_ROW_FIRST_FRAGMENT = layoutConstant("GEOMETRY_BOXES_ROW_FIRST_FRAGMENT");
const BOX_ROW_FRAGMENT_COUNT = layoutConstant("GEOMETRY_BOXES_ROW_FRAGMENT_COUNT");
const BOX_ROW_SCROLL_OWNER = layoutConstant("GEOMETRY_BOXES_ROW_SCROLL_OWNER");
const BOX_ROW_START_OVERFLOW_X = layoutConstant("GEOMETRY_BOXES_ROW_START_OVERFLOW_X");
const BOX_ROW_USED_EDGES = layoutConstant("GEOMETRY_BOXES_ROW_USED_EDGES");
const SVG_HEADER_SIZE = layoutConstant("GEOMETRY_SVG_HEADER_SIZE");
const SVG_ROW_SIZE = layoutConstant("GEOMETRY_SVG_ROW_SIZE");
export const GEOMETRY_FRAGMENT_SIZE = layoutConstant("GEOMETRY_FRAGMENT_SIZE");
const FRAGMENT_FIELDS = ["X", "Y", "WIDTH", "HEIGHT"].map((name) => layoutConstant(`GEOMETRY_FRAGMENT_${name}`));
export const GEOMETRY_RECORD_SIZE = layoutConstant("GEOMETRY_RECORD_SIZE");
const GEOMETRY_SCROLLBAR_SIZE = layoutConstant("GEOMETRY_SCROLLBAR_SIZE");
const SCROLLBAR = Object.fromEntries(["TRACK", "CLIP", "HAS_CLIP", "VERTICAL", "TARGET", "VALUES", "THUMB"]
  .map((name) => [name, layoutConstant(`GEOMETRY_SCROLLBAR_${name}`)]));
const GEOMETRY_TAIL_HEADER_SIZE = layoutConstant("GEOMETRY_TAIL_HEADER_SIZE");
const GEOMETRY_TAIL_SCROLLBARS = layoutConstant("GEOMETRY_TAIL_SCROLLBARS");

// Writes the fragment { x, y, w, h } at `at`, its origin moved by `origin`.
function writeFragment(view, at, { x, y, w, h }, origin = { x: 0, y: 0 }) {
  [x - origin.x, y - origin.y, w, h].forEach((value, index) => view.setFloat64(at + FRAGMENT_FIELDS[index], value, true));
}

// A box's fragments: none, or two and more for a box broken across
// columns or lines.
function boxFragments(box) {
  const fragments = box?.fragments ?? noFragments;
  if (fragments.length === 1) {
    throw new Error("A box has one fragment; a box in one piece has none and a broken box two or more");
  }
  return fragments;
}

// A boxes array carries a retained core snapshot of its values (the
// engine's box buffer is transient across host awaits). The engine's boxes
// are read as a box list over a copy of the core's snapshot of its rows
// (readEngineBoxes), which outlives the native snapshot's explicit release
// (8fdda7e9; docs/design/dom-webassembly-core.md). An array without an
// attached snapshot uploads its values on demand in the same row shape.
export const BOX_SNAPSHOT = Symbol.for("sandom.geometry.boxSnapshot");
const boxSnapshotFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_boxes_release(handle);
});
const measurementKey = Symbol.for("sandom.domCore.measurement");
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const BOX_ROW_VALUES = layoutConstant("GEOMETRY_BOXES_ROW_VALUES");
// A snapshot row in f64 words: the fourteen box values, then the u32 first
// fragment and fragment count; a fragment in f64 words.
export const BOX_SNAPSHOT_ROW_WORDS = BOX_SNAPSHOT_ROW_SIZE / F64;
const FRAGMENT_WORDS = GEOMETRY_FRAGMENT_SIZE / F64;

function attach(boxes, core, handle) {
  const snapshot = { core, handle, count: boxes.length, references: 1 };
  boxSnapshotFinalizer.register(snapshot, { core, handle }, snapshot);
  boxes[BOX_SNAPSHOT] = snapshot;
  return boxes;
}

// The rows behind each box list: its copy of the snapshot body (rows, then
// fragments), which outlives the native snapshot, and how many boxes the
// list has made.
const boxListRows = new WeakMap();

// The boxes of the first `count` engine rows, read through a new core
// snapshot of them (engine_boxes_snapshot). The result is an array whose
// box objects are made, frozen, on their first read, from a copy of the
// snapshot's rows: a frame reads a few boxes (scroll feedback, overlays),
// so it pays for those, not for one object per node. A box the engine broke
// across columns or lines has its `fragments`. Native snapshots give an SVG
// element inside an svg its object bounding box in the viewport's CSS px.
//
// The list refuses writes, as a frozen array does, but reports itself
// extensible until an operation that lists its properties (ownKeys, a
// property descriptor, a write, freezing) makes every box and freezes it:
// freezeBoxes and boxesReadOnly answer for it without that.
export function readEngineBoxes(core, count, deviceScale) {
  const measurement = globalThis[measurementKey];
  const start = measurement ? hostNow() : 0;
  const handle = core.status("engine_boxes_snapshot", count, deviceScale);
  const bytes = core.refreshBytes();
  const header = new DataView(bytes.buffer, handle, BOX_SNAPSHOT_HEADER_SIZE);
  if (header.getUint32(BOX_HEADER_MAGIC, true) !== BOX_SNAPSHOT_MAGIC || header.getUint32(BOX_HEADER_COUNT, true) !== count) {
    throw new Error(`Box snapshot ${handle} does not hold ${count} rows`);
  }
  const fragmentCount = header.getUint32(BOX_HEADER_FRAGMENTS, true);
  const bodyStart = handle + BOX_SNAPSHOT_HEADER_SIZE;
  const body = bytes.slice(
    bodyStart,
    bodyStart + count * BOX_SNAPSHOT_ROW_SIZE + fragmentCount * GEOMETRY_FRAGMENT_SIZE,
  );
  const svgPointer = header.getUint32(BOX_HEADER_SVG, true);
  const svgCount = svgPointer === 0 ? 0 : new DataView(bytes.buffer).getUint32(svgPointer, true);
  const svgRows = svgPointer + SVG_HEADER_SIZE;
  const svg = svgCount === 0 ? null : bytes.slice(svgRows, svgRows + svgCount * SVG_ROW_SIZE);
  const boxes = boxList(core, handle, body, count, fragmentCount, svg, svgCount);
  measurement?.record({
    category: "geometry",
    operation: "boxes.decode",
    direction: "engine-to-host",
    bytes: body.byteLength + (svg?.byteLength ?? 0),
    allocations: svg === null ? 2 : 3,
    allocationBytes: body.byteLength + (svg?.byteLength ?? 0),
    milliseconds: hostNow() - start,
  });
  return boxes;
}

function boxList(core, handle, body, count, fragmentCount, svg, svgCount) {
  const values = new Float64Array(body.buffer);
  const words = new Uint32Array(body.buffer, 0, count * BOX_SNAPSHOT_ROW_SIZE / U32);
  const fragmentBase = count * BOX_SNAPSHOT_ROW_WORDS;
  const target = new Array(count);
  // A list over a host-made body (boxesWithPageFragments) has no native
  // snapshot: boxSnapshotFor imports its rows.
  if (handle !== 0n) attach(target, core, handle);
  const rows = { core, body, count, fragmentCount, svg, svgCount, made: 0 };
  const boxAt = (index) => {
    const made = target[index];
    if (made !== undefined) return made;
    rows.made++;
    return target[index] = rowBox(values, words, fragmentBase, index);
  };
  let complete = false;
  const completeAll = () => {
    if (complete) return;
    for (let index = 0; index < count; index++) boxAt(index);
    Object.freeze(target);
    complete = true;
  };
  const boxes = new Proxy(target, {
    get(target, key, receiver) {
      const index = typeof key === "string" ? rowIndex(key, count) : -1;
      return index < 0 ? Reflect.get(target, key, receiver) : boxAt(index);
    },
    has(target, key) {
      return (typeof key === "string" && rowIndex(key, count) >= 0) || Reflect.has(target, key);
    },
    ownKeys(target) {
      completeAll();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      completeAll();
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    defineProperty(target, key, descriptor) {
      completeAll();
      return Reflect.defineProperty(target, key, descriptor);
    },
    set(target, key, value, receiver) {
      completeAll();
      return Reflect.set(target, key, value, receiver);
    },
    deleteProperty(target, key) {
      completeAll();
      return Reflect.deleteProperty(target, key);
    },
    preventExtensions(target) {
      completeAll();
      return Reflect.preventExtensions(target);
    },
  });
  boxListRows.set(boxes, rows);
  return boxes;
}

// The box list `boxes` (an engine box list) with the rows of `edits`
// replaced: a Map from row index to { border, content, fragments }, each
// rectangle { x, y, w, h } in the coordinates of the other rows, and
// `fragments` none or two and more border boxes. The row takes `border`
// and `content`, the fragments relative to `border`'s origin, and no
// scroll owner or scroll offsets: its rectangles are client positions.
// Every other row, and the SVG rows, are the engine's.
export function boxesWithPageFragments(boxes, edits) {
  const rows = boxListRows.get(boxes);
  if (rows === undefined) throw new Error("boxesWithPageFragments needs an engine box list (readEngineBoxes)");
  let added = 0;
  for (const edit of edits.values()) {
    if (edit.fragments.length === 1) {
      throw new Error("A page-fragmented box has one fragment; a box in one piece has none and a broken box two or more");
    }
    added += edit.fragments.length;
  }
  const rowBytes = rows.count * BOX_SNAPSHOT_ROW_SIZE;
  const fragmentCount = rows.fragmentCount + added;
  const body = new Uint8Array(rowBytes + fragmentCount * GEOMETRY_FRAGMENT_SIZE);
  body.set(rows.body);
  const view = new DataView(body.buffer);
  let fragment = rows.fragmentCount;
  for (const [index, { border, content, fragments }] of edits) {
    const row = index * BOX_SNAPSHOT_ROW_SIZE;
    const values = [border.x, border.y, border.w, border.h, content.x, content.y, content.w, content.h];
    for (let field = 0; field < values.length; field++) view.setFloat64(row + BOX_ROW_VALUES + field * F64, values[field], true);
    view.setUint32(row + BOX_ROW_FIRST_FRAGMENT, fragments.length === 0 ? 0 : fragment, true);
    view.setUint32(row + BOX_ROW_FRAGMENT_COUNT, fragments.length, true);
    for (let at = BOX_ROW_SCROLL_OWNER; at < BOX_ROW_START_OVERFLOW_X; at += U32) view.setUint32(row + at, 0, true);
    for (const { x, y, w, h } of fragments) {
      const at = rowBytes + fragment * GEOMETRY_FRAGMENT_SIZE;
      writeFragment(view, at, { x, y, w, h }, border);
      fragment++;
    }
  }
  return boxList(rows.core, 0n, body, rows.count, fragmentCount, rows.svg, rows.svgCount);
}

// How many box objects `boxes` holds: every one of an array, the ones a
// box list has made so far.
export function boxesMade(boxes) {
  return boxListRows.get(boxes)?.made ?? boxes.length;
}

// Whether two engine box lists (readEngineBoxes, boxesWithPageFragments)
// hold the same rows, fragments and SVG rows, byte for byte: a geometry
// built from one is the geometry of the other. The renderer reads a new
// list after each layout, so lists of one layout compare equal by content,
// never by identity. A list that is not an engine box list compares equal
// only to itself.
export function boxesEqual(a, b) {
  if (a === b) return true;
  const left = boxListRows.get(a);
  const right = boxListRows.get(b);
  if (left === undefined || right === undefined) return false;
  if (left.count !== right.count || left.fragmentCount !== right.fragmentCount || left.svgCount !== right.svgCount) {
    return false;
  }
  return bytesEqual(left.body, right.body) && (left.svg === null || bytesEqual(left.svg, right.svg));
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  // A body is its own buffer from offset 0 (a slice or a new array), so
  // its whole words compare as one 32-bit view and its tail byte by byte.
  const words = a.byteLength >>> 2;
  const left = new Uint32Array(a.buffer, a.byteOffset, words);
  const right = new Uint32Array(b.buffer, b.byteOffset, words);
  for (let index = 0; index < words; index++) if (left[index] !== right[index]) return false;
  for (let index = words << 2; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}

// The row a property key names: a canonical array index below `count`,
// else -1.
function rowIndex(key, count) {
  const length = key.length;
  if (length === 0 || length > 10 || (length > 1 && key.charCodeAt(0) === 48)) return -1;
  let index = 0;
  for (let at = 0; at < length; at++) {
    const digit = key.charCodeAt(at) - 48;
    if (digit < 0 || digit > 9) return -1;
    index = index * 10 + digit;
  }
  return index < count ? index : -1;
}

function rowBox(values, words, fragmentBase, index) {
  const at = index * BOX_SNAPSHOT_ROW_WORDS;
  const box = {
    x: values[at],
    y: values[at + 1],
    w: values[at + 2],
    h: values[at + 3],
    cx: values[at + 4],
    cy: values[at + 5],
    cw: values[at + 6],
    ch: values[at + 7],
    scrollLeft: values[at + 8],
    scrollTop: values[at + 9],
    scrollWidth: values[at + 10],
    scrollHeight: values[at + 11],
    stickyLeft: values[at + 12],
    stickyTop: values[at + 13],
  };
  // The classic scrollbar space (top, right, bottom, left), only when the
  // box reserves some, so that a copied box keeps it.
  const space = at + BOX_ROW_SCROLLBAR_SPACE / 8;
  if (values[space] !== 0 || values[space + 1] !== 0 || values[space + 2] !== 0 || values[space + 3] !== 0) {
    box.scrollbarSpace = Object.freeze([values[space], values[space + 1], values[space + 2], values[space + 3]]);
  }
  if (values[at + BOX_ROW_START_OVERFLOW_X / 8] !== 0) {
    box.startOverflowX = values[at + BOX_ROW_START_OVERFLOW_X / 8];
  }
  const edges = values.subarray(at + BOX_ROW_USED_EDGES / 8, at + BOX_ROW_USED_EDGES / 8 + 8);
  if (edges.some((value) => value !== 0)) box.usedEdges = Object.freeze(Array.from(edges));
  const fragmentCount = words[at * 2 + BOX_ROW_FRAGMENT_COUNT / 4];
  if (fragmentCount !== 0) {
    const first = words[at * 2 + BOX_ROW_FIRST_FRAGMENT / 4];
    const fragments = [];
    for (let offset = 0; offset < fragmentCount; offset++) {
      const fragment = fragmentBase + (first + offset) * FRAGMENT_WORDS;
      fragments.push(Object.freeze({
        x: values[fragment],
        y: values[fragment + 1],
        w: values[fragment + 2],
        h: values[fragment + 3],
      }));
    }
    box.fragments = Object.freeze(fragments);
  }
  return Object.freeze(box);
}

// Freezes a box array. A box list refuses writes already; freezing it would
// make every box.
export function freezeBoxes(boxes) {
  return boxListRows.has(boxes) ? boxes : Object.freeze(boxes);
}

// Whether `boxes` can no longer change: a frozen array or a box list.
export function boxesReadOnly(boxes) {
  return boxListRows.has(boxes) || Object.isFrozen(boxes);
}

// Retained renderers and independently returned frames share one immutable
// geometry snapshot. The finalizer still releases once if callers rely on GC.
export function retainBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (attached?.handle) attached.references++;
  return boxes;
}

// Releases the native snapshot behind `boxes` now rather than at collection.
// A later boxSnapshotFor over the same array uploads its values (a box
// list's rows) instead.
export function releaseBoxSnapshot(boxes) {
  const attached = boxes?.[BOX_SNAPSHOT];
  if (!attached || attached.handle === 0n) return;
  if (--attached.references > 0) return;
  boxSnapshotFinalizer.unregister(attached);
  attached.core.exports.geometry_boxes_release(attached.handle);
  attached.handle = 0n;
}

function importBoxSnapshot(boxes, core) {
  let fragmentCount = 0;
  for (const box of boxes) fragmentCount += boxFragments(box).length;
  const size = boxes.length * BOX_SNAPSHOT_ROW_SIZE + fragmentCount * GEOMETRY_FRAGMENT_SIZE;
  const pointer = core.status("abi_allocate", size);
  const view = new DataView(core.refreshBytes().buffer, pointer, size);
  const fragmentBase = boxes.length * BOX_SNAPSHOT_ROW_SIZE;
  let fragment = 0;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const row = index * BOX_SNAPSHOT_ROW_SIZE;
    for (let field = 0; field < boxNames.length; field++) {
      view.setFloat64(row + BOX_ROW_VALUES + field * F64, box?.[boxNames[field]] ?? 0, true);
    }
    // A host box carries the classic scrollbar space a box list gave it.
    for (let side = 0; side < 4; side++) {
      view.setFloat64(row + BOX_ROW_SCROLLBAR_SPACE + side * F64, box?.scrollbarSpace?.[side] ?? 0, true);
    }
    const fragments = boxFragments(box);
    view.setUint32(row + BOX_ROW_FIRST_FRAGMENT, fragments.length === 0 ? 0 : fragment, true);
    view.setUint32(row + BOX_ROW_FRAGMENT_COUNT, fragments.length, true);
    // No scroll owner, no effective scroll offsets.
    for (let at = BOX_ROW_SCROLL_OWNER; at < BOX_SNAPSHOT_ROW_SIZE; at += U32) view.setUint32(row + at, 0, true);
    view.setFloat64(row + BOX_ROW_START_OVERFLOW_X, box?.startOverflowX ?? 0, true);
    for (let edge = 0; edge < 8; edge++) {
      view.setFloat64(row + BOX_ROW_USED_EDGES + edge * F64, box?.usedEdges?.[edge] ?? 0, true);
    }
    for (const { x, y, w, h } of fragments) {
      const at = fragmentBase + fragment * GEOMETRY_FRAGMENT_SIZE;
      writeFragment(view, at, { x, y, w, h });
      fragment++;
    }
  }
  return core.status("geometry_boxes_import", boxes.length, fragmentCount, pointer, 0, 0);
}

// Reacquire the same immutable rows and native SVG identities after release.
function importBoxRows(core, rows) {
  if (rows.svgCount !== 0 && rows.core.exports !== core.exports) {
    throw new Error("SVG box rows belong to another core; render the document in the destination core");
  }
  const pointer = core.status("abi_allocate", rows.body.byteLength + (rows.svg?.byteLength ?? 0));
  const bytes = core.refreshBytes();
  bytes.set(rows.body, pointer);
  if (rows.svg !== null) bytes.set(rows.svg, pointer + rows.body.byteLength);
  return core.status("geometry_boxes_import", rows.count, rows.fragmentCount, pointer, rows.svgCount, pointer + rows.body.byteLength);
}

// A snapshot handle for `boxes` in `core`: the attached one when it is
// this core's and covers the array, else an upload of the array's values.
// The returned release() is a no-op for an attached snapshot.
export function boxSnapshotFor(boxes, core) {
  const attached = boxes[BOX_SNAPSHOT];
  if (
    attached && attached.handle !== 0n && attached.core === core &&
    attached.count === boxes.length
  ) {
    return { handle: attached.handle, release() {} };
  }
  const rows = boxListRows.get(boxes);
  const handle = rows === undefined
    ? importBoxSnapshot(boxes, core)
    : importBoxRows(core, rows);
  return {
    handle,
    release() {
      core.status("geometry_boxes_release", handle);
    },
  };
}

// One wire scrollbar block at `offset`.
function writeScrollbar(view, offset, scrollbar) {
  for (const [index, name] of ["x", "y", "width", "height"].entries()) {
    view.setFloat64(offset + SCROLLBAR.TRACK + index * F64, scrollbar.track[name], true);
    view.setFloat64(offset + SCROLLBAR.CLIP + index * F64, scrollbar.clip?.[name] ?? 0, true);
    view.setFloat64(offset + SCROLLBAR.THUMB + index * F64, scrollbar.thumb?.[name] ?? 0, true);
  }
  view.setUint32(offset + SCROLLBAR.HAS_CLIP, scrollbar.clip ? 1 : 0, true);
  view.setUint32(offset + SCROLLBAR.VERTICAL, scrollbar.orientation === "vertical" ? 1 : 0, true);
  view.setBigUint64(offset + SCROLLBAR.TARGET, scrollbar.element?._coreHandle ?? scrollbar.targetHandle ?? 0n, true);
  ["value", "minimum", "maximum", "range", "viewportLength", "scrollLength", "thickness"].forEach((name, index) =>
    view.setFloat64(offset + SCROLLBAR.VALUES + index * F64, scrollbar[name] ?? 0, true)
  );
}

// The host tail of a geometry build, or of a successor (geometry-build.watpart
// geometry_scroll_successor, geometry_restyle_successor): the scrollbar
// count in a GEOMETRY_TAIL header, then the wire scrollbar blocks. The
// carets, glyphs and text come from the text geometry store.
function encodeTail(scrollbars) {
  const bytes = new Uint8Array(GEOMETRY_TAIL_HEADER_SIZE + scrollbars.length * GEOMETRY_SCROLLBAR_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(GEOMETRY_TAIL_SCROLLBARS, scrollbars.length, true);
  let offset = GEOMETRY_TAIL_HEADER_SIZE;
  for (const scrollbar of scrollbars) {
    writeScrollbar(view, offset, scrollbar);
    offset += GEOMETRY_SCROLLBAR_SIZE;
  }
  return bytes;
}
export function encodeGeometryTail({ scrollbars = [] }) {
  return encodeTail(scrollbars);
}
export function encodeGeometrySuccessorTail({ scrollbars }) {
  return encodeTail(scrollbars);
}
