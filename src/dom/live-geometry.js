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
//
// A surface that shows a page (setPage) answers in the coordinate space of
// its pages (src/dom/page-stack.js): the layout is that page's, and every
// box with a fragment on another page takes its fragments where their
// pages lie in that space.

import { serializeToScene } from "./serialize.js";
import { layoutPageBoxesSync, layoutTextGeometrySync, layoutTreeBoxesSync } from "../scene-renderer.js";
import { buildGeometry, currentGeometryRevisions, layoutRootOf } from "./geometry.js";
import { boxesWithPageFragments, releaseBoxSnapshot } from "../dom-wasm/geometry-wire.js";
import { pageAreaOffset } from "./page-stack.js";
import { scheduleFocusFixup } from "./input-activation.js";
import { nodeMember } from "./node-members.js";

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// Runs one shared layout pass over `node`'s whole tree and returns
// { boxes, indexOf, root } — every layout-getter is a cheap
// re-shape of this. Exported for callers that need multiple properties
// off the SAME layout pass without re-running it (e.g. a batch read);
// most callers should reach for the single-property helpers in
// layout-getters.js. With `withText` the layout also holds the text
// geometry store of every laid-out text node (layoutTextGeometrySync,
// geometry_text_store_of_query; the caller releases it), and
// it neither takes nor gives the layout a live surface holds: that layout
// has no text geometry. On a paged surface the text is the page shown's;
// `withText` may be a function (paging, indexOf) that names the other
// pages whose text the question reads (pagesOfNodes, pageOfPoint): each is
// laid out and its text joins at its page's place, and the page shown is
// laid out again last, as the frames that follow find the engine.
export function computeLayoutBoxes(node, { viewportW, viewportH } = {}, withText = false) {
  const root = layoutRootOf(node);
  const document = nodeMember(root, "ownerDocument");
  const core = document._domCore;
  const runtime = document._sandomSceneRendererRuntime ?? null;
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
    density: surfaceViewport?.density ?? 1,
    _requestedLeft: surfaceViewport?._requestedLeft,
    _requestedTop: surfaceViewport?._requestedTop,
  };
  // The page the surface shows, as a page frame lays it out, or null.
  const page = surface?._syncPageOption?.(viewport) ?? null;
  const layoutOf = withText
    ? runtime?.layoutTextGeometrySync ?? layoutTextGeometrySync
    : page !== null
    ? runtime?.layoutPageBoxesSync ?? layoutPageBoxesSync
    : runtime?.layoutTreeBoxesSync ?? layoutTreeBoxesSync;
  // The engine events of the layout's tick wait for the surface's next
  // frame (_runSyncLayout).
  const runtimeLayout = surface?._runSyncLayout
    ? (scene, options) => surface._runSyncLayout(() => layoutOf(scene, options))
    : layoutOf;
  // A synchronous layout is a style and layout update: it checks the focus
  // (the focus fixup, input-activation.js), as Chrome's forced layout does,
  // and its style change event starts the CSS animations and transitions
  // of the change, whose effects the layout includes.
  scheduleFocusFixup(document);
  surface?._startStyleChangeAnimations();
  // Passes that a query container's changed size started: each settles
  // one level of nested containers (plans/css/PLAN-container-queries.md,
  // "The style and layout loop").
  let containerPasses = 0;
  for (;;) {
    const style = core.status("document_style_generation", document._coreHandle) >>> 0;
    const resource = core.status("resource_revision") >>> 0;
    const scroll = core.status("scroll_revision") >>> 0;
    // An unchanged document answers from the layout the surface holds: a
    // continuous layout that frames share, or a getter's page layout.
    if (surfaceViewport !== undefined && !withText) {
      const held = page === null
        ? surface._peekSyncLayout?.(style, viewport, resource, scroll)
        : surface._peekSyncPageLayout?.(style, viewport, resource, scroll, page.rulesKey);
      if (held) return held;
    }
    // Animated ::before and ::after content takes its text at the
    // surface's time, as the layout samples the tracks there. The
    // transition planning just above serialized the same tree; its
    // serialization serves while the revisions hold.
    const serialized = (surfaceViewport !== undefined && page === null
      ? surface._takePlannedSerialization?.(style, resource, viewport) : null) ?? serializeToScene(root, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewport: surfaceViewport ? viewport : undefined,
      generatedContent: surface?._animatedGeneratedContent(surface.currentTime) ?? null,
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
      generatedBoxRows: serialized.generatedBoxRows,
      imageSources: serialized.imageSources,
    };
    // The layout samples the surface's tracks at the surface's time: a
    // frame without a running animation does not tick them, and a track
    // that a read since then declared starts at that time. The animations
    // of elements that no frame has rendered take provisional tracks over
    // the rows this layout writes.
    const layoutOptions = engineWriteOwner === null ? {} : {
      engineWriteOwner,
      sampleTimeMilliseconds: surface.currentTime,
      prepareEngine: () => surface._declareUnrenderedEffects(serialized.indexOf, serialized.pseudoIndexOf),
    };
    let laidOut = runtimeLayout(scene, { ...layoutOptions, ...(page === null ? {} : { page }) });
    const paging = withText || page !== null ? laidOut.paging : null;
    let textCapture = withText ? laidOut.textCapture : 0;
    if (paging !== null && typeof withText === "function") {
      const others = [...new Set(withText(paging, serialized.indexOf))]
        .filter((other) => other !== paging.index && other >= 0 && other < paging.count)
        .sort((first, second) => first - second);
      if (others.length > 0) {
        releaseBoxSnapshot(laidOut.boxes);
        if (textCapture !== 0) core.status("geometry_text_release", textCapture);
        textCapture = 0;
        for (const other of others) {
          const otherLayout = runtimeLayout(scene, { ...layoutOptions, page: { ...page, index: other },
            textOffset: pageAreaOffset(paging.pages, paging.index, other) });
          releaseBoxSnapshot(otherLayout.boxes);
          textCapture = joinTextCaptures(core, textCapture, otherLayout.textCapture);
        }
        laidOut = runtimeLayout(scene, { ...layoutOptions, page });
        textCapture = joinTextCaptures(core, textCapture, laidOut.textCapture);
      }
    }
    const textStore = textCapture === 0 ? 0 : core.status("geometry_text_store_of_query", textCapture);
    const engineBoxes = withText || page !== null ? laidOut.boxes : laidOut;
    const boxes = paging === null ? engineBoxes : stackPageBoxes(engineBoxes, paging);
    // Each query container takes its content-box size from this layout. A
    // changed size restyles the document, and the revision check below
    // serializes and lays out again with it.
    let resizedContainer = null;
    for (const { row, handle } of serialized.queryContainers) {
      const box = boxes[row];
      if (box === undefined) continue;
      if (core.status("container_size_set", handle, box.cw, box.ch) === 1) resizedContainer ??= handle;
    }
    if (resizedContainer !== null) {
      containerPasses += 1;
      if (containerPasses > serialized.queryContainers.length + 1) {
        const element = core.wrapperFor(resizedContainer);
        throw new Error(
          `Query container <${element.localName}${element.id ? `#${element.id}` : ""}> changed its size on ` +
            `${containerPasses} layouts in a row; nested query containers settle in at most one layout per level ` +
            `(${serialized.queryContainers.length} containers). Its size depends on its contents: give it size ` +
            "containment on the axes it queries.",
        );
      }
    }
    // A cold font can invalidate both resource and computed-style generations.
    // Keep the original envelope; only fresh serialization and layout can
    // establish that all boxes use the newly resolved metrics.
    if (
      revisions.document !== (core.status("document_style_generation", document._coreHandle) >>> 0) ||
      revisions.resource !== (core.status("resource_revision") >>> 0)
    ) {
      core.releaseSceneResources(serialized.nodes);
      if (textStore !== 0) core.status("geometry_text_store_release", textStore);
      continue;
    }
    const layout = { boxes, indexOf: serialized.indexOf, root, viewport,
      viewportIndex: serialized.viewportIndex, publication: serialized.publication, serialized, ownedBySurface: false,
      textStore, paging, pageRulesKey: page?.rulesKey ?? null };
    // A live surface takes the serialization: its next frame reuses it
    // instead of serializing the same tree again (the "scrollTop =
    // scrollHeight" pattern paid two serializations per line appended).
    // A page layout serves the getters that follow it.
    if (surfaceViewport !== undefined && !withText && (page === null
      ? root._renderSurface?._offerSyncLayout?.(layout, revisions.document, resource, scroll)
      : root._renderSurface?._offerSyncPageLayout?.(layout, revisions.document, resource, scroll))) {
      layout.ownedBySurface = true;
    }
    return layout;
  }
}

// One text geometry capture of `first` then `second` (either may be 0, an
// emit without commands); geometry_text_capture_join takes both.
function joinTextCaptures(core, first, second) {
  if (first === 0) return second;
  if (second === 0) return first;
  return core.status("geometry_text_capture_join", first, second);
}

// The pages from the first fragment of the first of `nodes` to the last
// fragment of the last: the pages that hold the document between them
// (a withText function of computeLayoutBoxes). A node without a box adds
// none.
export function pagesOfNodes(paging, indexOf, nodes) {
  let first = Infinity;
  let last = -Infinity;
  for (const node of nodes) {
    const fragments = paging.nodeFragments[indexOf.get(node)] ?? null;
    if (fragments === null || fragments.length === 0) continue;
    first = Math.min(first, fragments[0].page);
    last = Math.max(last, fragments[fragments.length - 1].page);
  }
  const pages = [];
  for (let page = first; page <= last; page++) pages.push(page);
  return pages;
}

// The boxes of a page layout in the space of the paged surface: the engine
// boxes of the page laid out (`paging.index`), and for each node with a
// fragment on another page, or none on that page, the union of its
// fragments where their pages lie (pageAreaOffset), broken into one
// fragment per page when there are two or more. A fragment on the page
// laid out is the engine's box, or the engine's fragments of a box it broke
// there (columns, lines).
function stackPageBoxes(boxes, paging) {
  const { index: shown, pages, nodeFragments } = paging;
  const offPage = new Set(paging.offPageNodes);
  const edits = new Map();
  for (let node = 0; node < nodeFragments.length; node++) {
    const fragments = nodeFragments[node];
    if (fragments === null) continue;
    const onShown = !offPage.has(node) && fragments.some((fragment) => fragment.page === shown);
    if (onShown && fragments.length === 1) continue;
    const borders = [];
    const contents = [];
    for (const fragment of fragments) {
      if (fragment.page === shown) {
        if (!onShown) continue;
        const box = boxes[node];
        const parts = box.fragments?.length ? box.fragments.map((part) => ({ x: box.x + part.x, y: box.y + part.y, w: part.w, h: part.h }))
          : [{ x: box.x, y: box.y, w: box.w, h: box.h }];
        borders.push(...parts);
        contents.push({ x: box.cx, y: box.cy, w: box.cw, h: box.ch });
        continue;
      }
      const offset = pageAreaOffset(pages, shown, fragment.page);
      borders.push({ x: fragment.rect.x + offset.x, y: fragment.rect.y + offset.y, w: fragment.rect.width, h: fragment.rect.height });
      contents.push({ x: fragment.content.x + offset.x, y: fragment.content.y + offset.y, w: fragment.content.width, h: fragment.content.height });
    }
    if (borders.length === 0) continue;
    edits.set(node, { border: union(borders), content: union(contents), fragments: borders.length > 1 ? borders : [] });
  }
  if (edits.size === 0) return boxes;
  const stacked = boxesWithPageFragments(boxes, edits);
  releaseBoxSnapshot(boxes);
  return stacked;
}

function union(rectangles) {
  const left = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const top = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.w));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// The geometry snapshot of a live layout for `callback`. With `withText`
// the layout holds the text geometry store of every laid-out text node
// (computeLayoutBoxes, geometry_text_store_of_query) and the snapshot their
// glyphs and caret stops, which the operations over glyphs read
// (Range.getClientRects, caretPositionFromPoint;
// core/dom/geometry-range.watpart).
export function withLiveGeometry(node, options, callback, withText = false) {
  const document = nodeMember(node, "ownerDocument");
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
      : buildGeometry(layout);
    core.status("geometry_live_ack", request, token, geometry.handle);
    return callback(geometry);
  } finally {
    // A synchronous getter's own publication, box snapshot and geometry are
    // this call's alone: release them here, not at collection (a getter
    // per frame on a text page held megabytes per call until the next GC).
    if (layout !== null && !layout.ownedBySurface) {
      if (layout.textStore !== 0) core.status("geometry_text_store_release", layout.textStore);
      geometry?.release();
      layout.serialized.release();
      core.releaseSceneResources(layout.serialized.nodes);
      releaseBoxSnapshot(layout.boxes);
    }
    core.status("geometry_live_abort", request);
  }
}

// The source revisions a geometry records (geometry_revision fields 0 to
// 5), in buildGeometry's names.
const GEOMETRY_REVISION_NAMES = ["document", "style", "resource", "viewport", "scene", "presentation"];

// `callback` over an input snapshot of the paged surface `root` shows, for
// a batch whose points lie on `pages`: a geometry of the page shown and of
// those pages' text where their pages lie, presented under the presented
// frame's revisions, as input requires (geometry_presented). The frame
// shows the same document; it holds only its own page.
export function withPresentedPageGeometry(root, options, pages, callback) {
  const document = nodeMember(root, "ownerDocument");
  const core = document._domCore;
  const presented = root._renderSurface.presentedFrame;
  const sourceRevisions = Object.fromEntries(GEOMETRY_REVISION_NAMES.map((name, field) =>
    [name, core.status("geometry_revision", presented.geometryHandle, field)]));
  const layout = computeLayoutBoxes(root, options, () => pages);
  let geometry = null;
  try {
    geometry = buildGeometry({ ...layout, presented: true, revision: presented.revision, sourceRevisions });
    return callback({ geometryCore: geometry.core, geometryHandle: geometry.handle, scrollbars: [] });
  } finally {
    geometry?.release();
    if (layout.textStore !== 0) core.status("geometry_text_store_release", layout.textStore);
    layout.serialized.release();
    core.releaseSceneResources(layout.serialized.nodes);
    releaseBoxSnapshot(layout.boxes);
  }
}
