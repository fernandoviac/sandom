// The live layout pass behind every synchronous geometry read (the
// layout-getter family, scroll reads and scrollIntoView, a computed style
// value that depends on layout): serializeToScene the live tree, run a real
// layout pass (layoutTreeBoxesSync, examples/render-scene.js), and build the
// geometry snapshot the read answers from.
//
// This module sits above geometry.js and below its readers
// (layout-getters.js, scroll-core.js, stylesheet.js). geometry.js and
// presented-frame.js therefore import nothing that waits on the default
// scene renderer's top-level await, and no import cycle passes through that
// await (test/dom-core/module_graph_test.js).
//
// Running layout needs a VIEWPORT SIZE: the caller's viewportW/viewportH
// pair, a live surface's viewport, or else the viewport of the node's
// document (SDDocument._viewport), which its lengths resolve against.

import { serializeToScene } from "./serialize.js";
import { layoutTextGeometrySync, layoutTreeBoxesSync } from "../scene-renderer.js";
import { buildGeometry, currentGeometryRevisions, uniqueCaretStops } from "./geometry.js";
import { releaseBoxSnapshot } from "../dom-wasm/geometry-wire.js";
import { scheduleFocusFixup } from "./input-activation.js";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// Runs one shared layout pass over `node`'s whole tree and returns
// { boxes, indexOf, root } — every layout-getter is a cheap
// re-shape of this. Exported for callers that need multiple properties
// off the SAME layout pass without re-running it (e.g. a batch read);
// most callers should reach for the single-property helpers in
// layout-getters.js. With `withText` the layout also holds the text
// operations of every laid-out text node (layoutTextGeometrySync), and
// it neither takes nor gives the layout a live surface holds: that layout
// has no text geometry.
export function computeLayoutBoxes(node, { viewportW, viewportH } = {}, withText = false) {
  let root = node;
  while (root.parentElement) root = root.parentElement;
  const document = root.ownerDocument;
  const core = document._domCore;
  const runtime = document._sandomSceneRendererRuntime ?? null;
  const runtimeLayout = withText
    ? runtime?.layoutTextGeometrySync ?? layoutTextGeometrySync
    : runtime?.layoutTreeBoxesSync ?? layoutTreeBoxesSync;
  const surface = root._renderSurface ?? null;
  const surfaceViewport = surface?.viewport;
  // The engine holds this surface's last frame of THIS tree: the
  // analytical layout inherits it and relayouts only what changed (and
  // hands the claim back, so the next frame keeps its incremental node
  // set). Without a live surface the engine holds whatever another caller
  // last wrote, and the layout must stand alone.
  const engineWriteOwner = surface?._persistentRenderer?.engineWriteToken ??
    null;
  const viewport = {
    width: surfaceViewport?.width ?? viewportW ?? document._viewport.width,
    height: surfaceViewport?.height ?? viewportH ?? document._viewport.height,
    deviceScale: surfaceViewport?.deviceScale ?? 1,
    _requestedLeft: surfaceViewport?._requestedLeft,
    _requestedTop: surfaceViewport?._requestedTop,
  };
  // A synchronous layout is a style and layout update: it checks the focus
  // (the focus fixup, input-activation.js), as Chrome's forced layout does.
  scheduleFocusFixup(document);
  for (;;) {
    const style = core.status("document_style_generation", document._coreHandle) >>> 0;
    const resource = core.status("resource_revision") >>> 0;
    const scroll = core.status("scroll_revision") >>> 0;
    // An unchanged document answers from the layout the surface holds.
    if (surfaceViewport !== undefined && !withText) {
      const held = surface._peekSyncLayout?.(style, viewport, resource, scroll);
      if (held) return held;
    }
    const serialized = serializeToScene(root, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewport: surfaceViewport ? viewport : undefined,
    });
    const revisions = currentGeometryRevisions(document);
    // Resolving a previously unseen style or resource can invalidate records
    // already serialized earlier in the traversal. Rebuild those records.
    if (revisions.document !== style || revisions.resource !== resource) {
      core.releaseSceneResources(serialized.nodes);
      continue;
    }
    const scene = {
      width: viewport.width,
      height: viewport.height,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    };
    const laidOut = runtimeLayout(
      scene,
      engineWriteOwner === null ? {} : { engineWriteOwner },
    );
    const boxes = withText ? laidOut.boxes : laidOut;
    // A cold font can invalidate both resource and computed-style generations.
    // Keep the original envelope; only fresh serialization and layout can
    // establish that all boxes use the newly resolved metrics.
    if (
      revisions.document !== (core.status("document_style_generation", document._coreHandle) >>> 0) ||
      revisions.resource !== (core.status("resource_revision") >>> 0)
    ) {
      core.releaseSceneResources(serialized.nodes);
      continue;
    }
    const layout = { boxes, indexOf: serialized.indexOf, root, viewport,
      viewportIndex: serialized.viewportIndex, publication: serialized.publication, serialized, ownedBySurface: false,
      textOperations: withText ? laidOut.textOperations : null };
    // A live surface takes the serialization: its next frame reuses it
    // instead of serializing the same tree again (the "scrollTop =
    // scrollHeight" pattern paid two serializations per line appended).
    if (surfaceViewport !== undefined && !withText &&
      root._renderSurface?._offerSyncLayout?.(layout, revisions.document, resource, scroll)) {
      layout.ownedBySurface = true;
    }
    return layout;
  }
}

// The geometry snapshot of a live layout for `callback`. With `withText`
// the layout holds the text operations of every laid-out text node
// (computeLayoutBoxes) and the snapshot their glyphs and caret stops
// (liveTextGeometry), which the operations over glyphs read
// (Range.getClientRects, caretPositionFromPoint;
// src/dom-wasm/geometry-range.watpart).
export function withLiveGeometry(node, options, callback, withText = false) {
  const document = node.ownerDocument;
  const core = document._domCore;
  const request = core.status("geometry_live_begin", document._coreHandle);
  let geometry;
  let layout = null;
  try {
    const token = core.status("geometry_live_token", request);
    layout = computeLayoutBoxes(node, options, withText);
    // A surface-held layout keeps its geometry for the next getter; the
    // surface releases both together.
    geometry = layout.ownedBySurface
      ? (layout.retainedGeometry ??= buildGeometry(layout))
      : buildGeometry(withText ? { ...layout, textGeometryByNode: liveTextGeometry(layout) } : layout);
    core.status("geometry_live_ack", request, token, geometry.handle);
    return callback(geometry);
  } finally {
    // A synchronous getter's own publication, box snapshot and geometry are
    // this call's alone: release them here, not at collection (a getter
    // per frame on a text page held megabytes per call until the next GC).
    if (layout !== null && !layout.ownedBySurface) {
      geometry?.release();
      layout.serialized.release();
      core.releaseSceneResources(layout.serialized.nodes);
      releaseBoxSnapshot(layout.boxes);
    }
    core.status("geometry_live_abort", request);
  }
}

// The text geometry of a layout with text operations, keyed by text node:
// each glyph on its text box and two caret stops per glyph on its line
// box, at the DOM's UTF-16 offsets. The positions are in scroll space, as
// the geometry records hold their boxes, and the translation is 0: a
// reader adds the scroll of the glyph's or caret's record
// ($geometryTextTranslation). A text control's value and generated text
// are no text node's.
function liveTextGeometry({ serialized, textOperations }) {
  const nodes = new Array(serialized.nodes.length).fill(null);
  for (const [node, index] of serialized.indexOf) nodes[index] = node;
  const entries = new Map();
  for (const operation of textOperations) {
    const node = nodes[operation.nodeIndex];
    if (node?.nodeType !== 3) continue;
    let entry = entries.get(node);
    if (entry === undefined) {
      entry = { units: utf16Offsets(node.data), caretStops: [], glyphs: [] };
      entries.set(node, entry);
    }
    const textBottom = operation.textTop + operation.textHeight;
    const lineBottom = operation.lineTop + operation.lineHeight;
    for (const glyph of operation.glyphs) {
      const sourceStart = entry.units(glyph.start);
      const sourceEnd = entry.units(glyph.end);
      entry.glyphs.push({ sourceStart, sourceEnd, x: glyph.x, width: glyph.width, top: operation.textTop, bottom: textBottom });
      entry.caretStops.push(
        { sourceOffset: operation.rtl ? sourceEnd : sourceStart, x: glyph.x, top: operation.lineTop, bottom: lineBottom },
        { sourceOffset: operation.rtl ? sourceStart : sourceEnd, x: glyph.x + glyph.width, top: operation.lineTop, bottom: lineBottom },
      );
    }
  }
  const geometry = new Map();
  for (const [node, entry] of entries) {
    geometry.set(node, {
      caretStops: uniqueCaretStops(node, entry.caretStops),
      glyphs: entry.glyphs,
      translationX: 0,
      translationY: 0,
    });
  }
  return geometry;
}

// The UTF-16 offset of `text` at each UTF-8 byte offset that starts a code
// point (a prepared text run maps its clusters to these authored offsets).
function utf16Offsets(text) {
  let ascii = true;
  for (let index = 0; index < text.length && ascii; index++) ascii = text.charCodeAt(index) < 0x80;
  if (ascii) {
    return (offset) => {
      if (offset > text.length) throw new RangeError(`text geometry: byte offset ${offset} is past the ${text.length} bytes of its text node`);
      return offset;
    };
  }
  const table = [];
  let unit = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const bytes = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    table.push(unit);
    for (let index = 1; index < bytes; index++) table.push(null);
    unit += character.length;
  }
  table.push(unit);
  return (offset) => {
    const value = table[offset];
    if (value === undefined || value === null) {
      throw new RangeError(`text geometry: byte offset ${offset} does not start a code point of its ${table.length - 1}-byte text node`);
    }
    return value;
  };
}
