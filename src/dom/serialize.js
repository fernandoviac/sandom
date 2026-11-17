// Tree-to-scene serializer: a live SDElement tree (src/dom/node.js) walked
// into a flat scene node array, the shape test/fixtures/scenes.js's hand-authored
// scenes use, so the renderScenePixels/sandomTreeBoxes pipeline
// consumes a DOM-backed tree unchanged.
//
// The DOM core builds the box tree (scene_build): box kinds, display
// codes, formatting flags, generated and form text, markers, anonymous
// table boxes, order, font faces, and text-run style. Every box's engine
// record is published from its typed native SceneBuildBox; a scene node here
// carries only what the host adds: the box reference, its display name,
// text, host resources (image sources, canvas paint sources), and scroll
// requests. SVG diagnostics read retained native path definitions and bounds.
// An element or a ::before or ::after that declares transitions keeps its
// resolved transition definitions and CSS transform for the renderer's
// transition diff.

import { animationProperty, animationTransitionDefinitions, animationValueFromText } from "../dom-wasm/animation.js";
import { PSEUDO_ELEMENT_NAMES, pseudoElementTarget } from "./pseudo-element-target.js";
import { readSceneRowStyle, recordSceneStyleGeneration } from "../dom-wasm/scene-style.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { nodeMember } from "./node-members.js";

const SCROLL_REQUESTED_LEFT = layoutConstant("SCROLL_REQUESTED_LEFT");
const SCROLL_REQUESTED_TOP = layoutConstant("SCROLL_REQUESTED_TOP");

// The scene display name of an svg shape box (scene display 22) by its
// tag: sandom's synthetic display:'svg-*' values (examples/render-scene.js,
// design/svg-rendering.md). The core rejects any other SVG tag.
const SVG_SHAPE_DISPLAY = {
  rect: "svg-rect",
  circle: "svg-circle",
  ellipse: "svg-ellipse",
  line: "svg-line",
  g: "svg-group",
  use: "svg-group",
  path: "svg-path",
  polygon: "svg-polygon",
  polyline: "svg-polyline",
};

// The scene box kinds, box flags, host bits and display codes of the
// core's build records (core/dom/scene-build.watpart).
const SCENE = Object.freeze(Object.fromEntries([
  "BOX_ELEMENT", "BOX_TEXT", "BOX_ANONYMOUS_INLINE", "BOX_BEFORE_TEXT", "BOX_AFTER_TEXT", "BOX_LINE_FEED",
  "BOX_FORM_VALUE", "BOX_PLACEHOLDER", "BOX_LIST_MARKER", "BOX_MARKER_WRAPPER", "BOX_CONTENTS_ROOT",
  "BOX_ANONYMOUS_TABLE", "BOX_VIEWPORT", "BOX_BEFORE", "BOX_AFTER", "BOX_ALTERNATIVE_TEXT", "BOX_BROKEN_IMAGE_ICON",
  "BOX_USE_INSTANCE", "BOX_BACKDROP", "BOX_FIRST_LETTER", "BOX_FIRST_LETTER_TEXT", "BOX_FIRST_LINE",
  "BOX_FIRST_LINE_ELEMENT", "BOX_FIRST_LINE_TEXT", "BOX_FIRST_LINE_BEFORE", "BOX_FIRST_LINE_AFTER",
  "BOX_FIRST_LINE_LETTER", "BOX_BEFORE_IMAGE", "BOX_AFTER_IMAGE", "BOX_FILE_SELECTOR_BUTTON",
  "BOX_FILE_SELECTOR_BUTTON_TEXT", "BOX_PAGE_FIRST", "BOX_PAGE_LAST", "BOX_PAGE_TEXT_FIRST", "BOX_PAGE_TEXT_LAST",
  "BOX_FLAG_INLINE_CONTEXT", "BOX_FLAG_BFC", "BOX_FLAG_TRANSITIONS", "HOST_RESOURCE", "HOST_IMAGE_LAYERS",
  "DISPLAY_SVG_SHAPE", "DISPLAY_TEXT", "DISPLAY_COUNT", "WHITE_SPACE_COUNT",
].map((name) => [name, layoutConstant(`SCENE_${name}`)])));
const RESOURCE_TYPE_IMAGE = layoutConstant("RESOURCE_TYPE_IMAGE");
const RESOURCE_TYPE_CANVAS = layoutConstant("RESOURCE_TYPE_CANVAS");
// The scene display names and white-space keywords by their codes.
const DISPLAY_CODE_NAMES = Object.freeze(Array.from({ length: SCENE.DISPLAY_COUNT },
  (_, code) => sharedDomCore.string("scene_display_name", code)));
const WHITE_SPACE_NAMES = Object.freeze(Array.from({ length: SCENE.WHITE_SPACE_COUNT },
  (_, code) => sharedDomCore.string("scene_white_space_name", code)));
const BOX_INLINE_CONTEXT = SCENE.BOX_FLAG_INLINE_CONTEXT;
const BOX_BFC = SCENE.BOX_FLAG_BFC;
const BOX_TRANSITIONS = SCENE.BOX_FLAG_TRANSITIONS;

// The element's transform for the transition diff, as a canonical value
// of the transform property (animation_value_from_text) computed against
// the element from the computed list text the core keeps
// (computed_field_text). An element that declares transitions and no
// transform has `none`: the renderer's transition diff needs a transform
// on every serialization of such a box.
export function elementTransform(element, pseudo = 0) {
  const core = element._domCore;
  const cssText = pseudo === 0
    ? core.string("computed_field_text", element._coreHandle, ...core.input("transform"))
    : core.string("computed_pseudo_field_text", element._coreHandle, pseudo, ...core.input("transform"));
  return animationValueFromText(animationProperty("transform"), cssText ?? "none", element);
}


// The core builds the box tree (core/dom/scene-build.watpart): which
// flat-tree children participate, anonymous inline runs, generated content,
// br's forced break, form values and placeholders, list markers, anonymous
// table boxes, and order-modified document order, in the flat breadth-first
// order the engine consumes. This walk fills each box's fields from the
// element's resolved style and the host state the core does not hold (image
// sources, canvas paint sources, scroll requests, SVG attributes).
// The native build row (stable id, source revision) a scene node was
// serialized from, for test access to its unrelocated record: the build's
// rows hang off the publication reference every node of the build shares.
const jsonAbsent = () => undefined;

export function sceneNodeProvenance(node) {
  return node?._corePublication?.boxes?.[node._corePublicationIndex] ?? null;
}

// A face the cascade selected with no source the renderer can load: the
// core names the failing build row; the error names the computed
// font-family, the first element that needs it, and every remedy
// (font_unsupplied_message). A render throws it (unboundFontError) and
// inspection reports it (inspectHTML).
export function unsuppliedFontFaceMessage(core, family, element) {
  return core.string("font_unsupplied_message", ...core.input(family), element?._coreHandle ?? 0n);
}

function unboundFontError(core, box, cause) {
  if (!box) throw cause;
  const node = core.wrapperFor(box.handle);
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const family = box.font ? core.string("font_face_css", box.font) : "";
  return new Error(unsuppliedFontFaceMessage(core, family, element), { cause });
}

// Prepares the document of `root` for a scene build: the viewport its
// lengths resolve against (SDDocument._setViewport), the media environment,
// and the declared font families.
export function prepareSceneDocument(root, { viewportWidth, viewportHeight, deviceScale } = {}) {
  const core = root._domCore;
  const document = nodeMember(root, "nodeType") === 9 ? root : nodeMember(root, "ownerDocument");
  const styleSystem = document._styleSystem;
  if (viewportWidth !== undefined || viewportHeight !== undefined) {
    document._setViewport(viewportWidth ?? document._viewport.width, viewportHeight ?? document._viewport.height,
      deviceScale);
  }
  if (styleSystem) {
    core.mediaEnvironmentSet(styleSystem.environment);
    styleSystem.answerDeclaredFontFamilies(root);
  }
}

// Publishes the engine records of the scene of `root` without the scene
// node tree: the build answers the font family requests it raises, then the
// core lowers every row. Returns the publication handle; the caller
// releases it (engine_record_release).
export function publishSceneRecords(root) {
  const core = root._domCore;
  const document = nodeMember(root, "nodeType") === 9 ? root : nodeMember(root, "ownerDocument");
  const styleSystem = document._styleSystem;
  core.status("scene_build", root._coreHandle);
  while (styleSystem && core.fontFamilyRequests(document).length) {
    styleSystem.answerFontFamilyRequests();
    core.status("scene_build", root._coreHandle);
  }
  document._sandomFontRegistry?.prepareNativeFontPublication(root);
  return core.engineRecordPublish(root._coreHandle, 0, 0, 0n);
}

// The query containers among `entries` (core.sceneQueryContainers) with a
// container type in `typeMask`, each as its element handle and scene row.
function containerRows(core, indexOf, entries, typeMask) {
  const rows = [];
  for (const { handle, types } of entries) {
    if ((types & typeMask) === 0) continue;
    const row = indexOf.get(core.wrapperFor(handle));
    if (row !== undefined && row !== null) rows.push({ handle, row });
  }
  return rows;
}

// `viewportWidth` and `viewportHeight` set the viewport of the root's
// document, which its lengths resolve against (SDDocument._setViewport);
// without them the document keeps its viewport.
export function serializeToScene(
  root,
  {
    viewportWidth,
    viewportHeight,
    generatedContent = null,
    viewport: renderViewport = null,
  } = {},
) {
  const core = root._domCore;
  const document = nodeMember(root, "nodeType") === 9 ? root : nodeMember(root, "ownerDocument");
  const styleSystem = document._styleSystem;
  // The document's lengths and line widths take the viewport's density, not
  // its raster scale (SandomViewport).
  prepareSceneDocument(root, {
    viewportWidth, viewportHeight, deviceScale: renderViewport?.density ?? renderViewport?.deviceScale,
  });
  if (generatedContent) {
    for (const { element, pseudoElement, text } of generatedContent) {
      core.sceneGeneratedOverride(
        element._coreHandle,
        pseudoElement === "::before" ? 1 : 2,
        text,
      );
    }
  }
  // The font registry whose catalog binds the faces of the publication: a
  // renderer lays it out only with that registry's engine sources.
  const ownerDocument = nodeMember(root, "nodeType") === 9 ? root : nodeMember(root, "ownerDocument");
  const publicationRef = {
    core,
    handle: 0,
    boxes: null,
    fontRegistry: ownerDocument?._sandomFontRegistry ?? null,
    documentURL: ownerDocument?.URL ?? null,
    documentHandle: ownerDocument?._coreHandle ?? 0n,
    toJSON: jsonAbsent,
  };
  // The scroll owner whose states give this build's rows their requested
  // offsets: the core records them in the publication as this build reads
  // them (engine_record_publish), and publishes them from there.
  const scrollOwner = root._renderSurface?._scrollOwner ?? 0n;
  let { boxes, expansions, rootContext } = core.sceneBuild(
    root._coreHandle,
    renderViewport !== null,
    publicationRef,
  );
  // Resolving one family may expose another inherited/descendant value on
  // the next build. Drain the native request queue before publishing boxes.
  while (styleSystem && core.fontFamilyRequests(ownerDocument).length) {
    styleSystem.answerFontFamilyRequests();
    ({ boxes, expansions, rootContext } = core.sceneBuild(
      root._coreHandle,
      renderViewport !== null,
      publicationRef,
    ));
  }
  const rootWriting = rootContext;
  // The query containers of this build: a synchronous layout hands each
  // size container's content-box size to the core, which restyles the
  // document when one changed (live-geometry.js); each frame snapshots
  // the scroll state of each scroll-state container (render-surface.js).
  const queryContainerEntries = core.sceneQueryContainers();
  const canvasBackground = core.sceneCanvasBackground();
  // Every box is lowered natively now, under this serialization's media
  // environment, into one core-retained publication. Frames relocate its
  // rows (engine_record_frame); the serialization owns the handle and
  // releases it when replaced or collected. Nodes reference it through one
  // shared object that never enters the renderer's JSON node signature.
  ownerDocument?._sandomFontRegistry?.prepareNativeFontPublication(root);
  let publication;
  try {
    publication = core.engineRecordPublish(
      root._coreHandle,
      renderViewport?.width ?? 0,
      renderViewport?.height ?? 0,
      scrollOwner,
    );
  } catch (error) {
    if (!error?.fontFailure) throw error;
    throw unboundFontError(core, boxes[error.sceneRow], error);
  }
  // Every scene node of this build holds this reference, and the
  // publication it names must outlive them: a caller keeps `nodes` and
  // drops the wrapper this function returns (`const { nodes } =
  // serializeToScene(root)` is the shape every direct renderer call
  // uses), so the collection backstop below hangs off the reference, not
  // off the wrapper. It hung off the wrapper, and a render whose scene
  // outlived its serialization object failed mid-frame with "Invalid
  // resource state" when the collector got there first.
  publicationRef.handle = publication;
  publicationRef.boxes = boxes;
  Object.freeze(publicationRef);
  publications.register(publicationRef, { core, publication }, publicationRef);
  // The rows this publication lowered anew; every other row took the
  // previous publication's bytes for its identity, so nothing the engine
  // reads of that node changed. The rows changed at their index (lowered
  // anew, or reused from another index after an earlier sibling was
  // inserted or removed) are the renderer's change set: its per-index
  // state belongs to whatever sat at the index last frame.
  const loweredRows = core.engineRecordLowered(publication);
  const changedRows = core.engineRecordChanged(publication);
  const reusedRows = core.engineRecordReused(publication);
  const nodes = new Array(boxes.length);
  const indexOf = new Map();
  // The rows of the ::before and ::after boxes that declare transitions,
  // by their animation target (pseudo-element-target.js).
  const pseudoIndexOf = new Map();
  // The ::before and ::after boxes, each as its row and its originating
  // element: the scene keeps the list, so a frame's layout-used
  // pseudo-element capture reads those rows only, with the elements of
  // this serialization.
  const generatedBoxRows = [];
  let textBoxes = 0;
  // Capture each face's CSS family value for scene inspection.
  const faceCss = new Map();
  const faceCssOf = (face) => {
    let css = faceCss.get(face);
    if (css === undefined) {
      css = core.string("font_face_css", face);
      faceCss.set(face, css);
    }
    return css;
  };
  const imageSources = new Map();
  for (const handle of expansions) indexOf.set(core.wrapperFor(handle), null);
  // Requested scroll offsets live in the surface's scroll states. Read them
  // once from the owner rather than searching it per element: an element
  // without a state (nearly all of them) requests nothing.
  const scrollRequests = new Map();
  for (let index = 0; scrollOwner; index += 1) {
    const state = core.status("scroll_owner_state", scrollOwner, index);
    if (!state) break;
    const node = core.status("scroll_state_node", state);
    if (!node) continue;
    const left = core.status("scroll_value", state, SCROLL_REQUESTED_LEFT);
    const top = core.status("scroll_value", state, SCROLL_REQUESTED_TOP);
    if (left !== 0 || top !== 0) scrollRequests.set(Number(node), [left, top]);
  }

  const childrenOf = (box) =>
    box.children.length ? { children: box.children } : {};
  // The core writes a box's engine record from its kind, flags, and scene
  // display code (writeNode) and from the element the record derives
  // from: the box's own element, or the context element a text box
  // inherits from.
  const coreBox = (box) => ({
    _coreBox: box.kind | (box.flags << 8) | (box.display << 24),
    _corePublication: publicationRef,
    _coreFont: box.font,
    _coreFontCss: faceCssOf(box.font),
  });
  const textBox = (box) => {
    textBoxes += 1;
    const node = { display: "text" };
    // A text root without a parent element has no core record.
    if (box.context !== 0n) {
      node.whiteSpace = WHITE_SPACE_NAMES[box.whiteSpace];
      node.letterSpacing = box.letterSpacing;
      if (box.owner !== undefined) node.generatedOwnerIndex = box.owner;
      node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
      node._corePublication = publicationRef;
      node._coreFont = box.font;
      node._coreFontCss = faceCssOf(box.font);
      node._coreBoxHandle = Number(box.context);
    }
    Object.defineProperty(node, "text", {
      enumerable: true,
      get: () => box.text ?? "",
    });
    return node;
  };
  // The generated image a list marker or an image box of ::before or
  // ::after content shows (scene_resource_generated): its source and core
  // resource, which the frame's image preparation loads with the request
  // of its url(). A marker shows its text until the image resolves.
  const generatedImage = (node, box) => {
    const resource = core.sceneResourceGenerated(box.stableId, box.sourceRevision);
    if (resource === 0n) return;
    node.src = core.resourceKey(resource);
    node.resourceIdentifier = core.resourceId(resource);
  };

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    switch (box.kind) {
      case SCENE.BOX_ELEMENT: {
        const element = core.wrapperFor(box.handle);
        indexOf.set(element, index);
        nodes[index] = elementScene(element, box, index);
        break;
      }
      case SCENE.BOX_USE_INSTANCE: {
        const element = core.wrapperFor(box.context);
        const node = elementScene(element, box, index);
        node.generatedOwnerIndex = box.owner;
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_TEXT: {
        const node = core.wrapperFor(box.handle);
        indexOf.set(node, index);
        nodes[index] = textBox(box);
        break;
      }
      case SCENE.BOX_ANONYMOUS_INLINE:
      case SCENE.BOX_MARKER_WRAPPER: {
        // An anonymous inline run, or the wrapper an outside marker's
        // inline content moves into: a block holding an inline
        // formatting context. Field by field like the text and element
        // paths: a justified article's runs are a large share of its boxes.
        const node = { display: "block", inlineCtx: true };
        if (box.children.length) node.children = box.children;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = Number(box.context);
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_BEFORE_TEXT:
      case SCENE.BOX_AFTER_TEXT:
      case SCENE.BOX_LINE_FEED:
      case SCENE.BOX_FORM_VALUE:
      case SCENE.BOX_PLACEHOLDER:
      case SCENE.BOX_FIRST_LETTER_TEXT:
      case SCENE.BOX_FIRST_LINE_TEXT:
      case SCENE.BOX_FILE_SELECTOR_BUTTON_TEXT:
        nodes[index] = textBox(box);
        break;
      case SCENE.BOX_LIST_MARKER: {
        const node = textBox(box);
        if (box.host & SCENE.HOST_RESOURCE) generatedImage(node, box);
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_BEFORE_IMAGE:
      case SCENE.BOX_AFTER_IMAGE: {
        // An image of ::before or ::after content: an inline replaced box
        // that the core lays out from a record it synthesizes; its identity
        // is the originating element's, as the pseudo-element's is.
        const node = { display: DISPLAY_CODE_NAMES[box.display] };
        node.generatedOwnerIndex = box.owner;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = Number(box.context);
        if (box.host & SCENE.HOST_RESOURCE) generatedImage(node, box);
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_CONTENTS_ROOT:
        // A display:contents root's formatting root.
        nodes[index] = {
          display: "block",
          bfc: true,
          ...childrenOf(box),
          ...coreBox(box),
          _coreHandle: Number(box.handle),
        };
        break;
      case SCENE.BOX_ANONYMOUS_TABLE: {
        const node = { display: DISPLAY_CODE_NAMES[box.display] };
        if (box.children.length) node.children = box.children;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = 0;
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_VIEWPORT:
        nodes[index] = {
          display: "block",
          bfc: true,
          width: renderViewport.width,
          height: renderViewport.height,
          ...rootWriting,
          _coreBox: SCENE.BOX_VIEWPORT,
          _corePublication: publicationRef,
          scrollLeft: renderViewport._requestedLeft,
          scrollTop: renderViewport._requestedTop,
          ...childrenOf(box),
        };
        break;
      case SCENE.BOX_BEFORE:
      case SCENE.BOX_AFTER:
      case SCENE.BOX_BACKDROP:
      case SCENE.BOX_FIRST_LETTER:
      case SCENE.BOX_FIRST_LINE:
      case SCENE.BOX_FIRST_LINE_ELEMENT:
      case SCENE.BOX_FIRST_LINE_BEFORE:
      case SCENE.BOX_FIRST_LINE_AFTER:
      case SCENE.BOX_FIRST_LINE_LETTER:
      case SCENE.BOX_FILE_SELECTOR_BUTTON: {
        // A ::before, ::after, ::backdrop, ::first-letter or
        // ::file-selector-button box, or a first line's ::first-line box or
        // variant of an inline box: the core lays it out from its record;
        // its identity is the originating element, or the original box's
        // for a variant. Its url() background layers bind under the
        // element's handle and the pseudo-element (scene_box_pseudo_kind).
        const node = { display: DISPLAY_CODE_NAMES[box.display] };
        if (box.kind === SCENE.BOX_BEFORE || box.kind === SCENE.BOX_AFTER) {
          // The node of a ::before or ::after is its animations' target;
          // one that declares transitions carries its lists, record and
          // transform as an element's node does (elementScene).
          const element = core.wrapperFor(box.handle);
          const pseudo = core.status("scene_box_pseudo_kind", box.kind);
          node.pseudoElement = PSEUDO_ELEMENT_NAMES[pseudo];
          pseudoIndexOf.set(pseudoElementTarget(element, node.pseudoElement), index);
          generatedBoxRows.push({ row: index, element });
          if (box.flags & BOX_TRANSITIONS) {
            node.transitionDefinitions = animationTransitionDefinitions(element, pseudo);
            node._coreRecord = core.engineRecordAfterChange(box.stableId, box.sourceRevision);
            node.transform = elementTransform(element, pseudo);
          }
        }
        if (box.flags & BOX_BFC) node.bfc = true;
        if (box.flags & BOX_INLINE_CONTEXT) node.inlineCtx = true;
        if (box.children.length) node.children = box.children;
        if (box.host & SCENE.HOST_IMAGE_LAYERS) {
          const imageLayers = core.sceneResourceLayers(box.handle, core.status("scene_box_pseudo_kind", box.kind));
          if (imageLayers) Object.assign(node, imageLayers);
        }
        node.generatedOwnerIndex = box.owner;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = Number(box.context);
        nodes[index] = node;
        break;
      }
      case SCENE.BOX_ALTERNATIVE_TEXT:
      case SCENE.BOX_BROKEN_IMAGE_ICON: {
        // The alternative text container or broken image icon of an img or
        // an image input: the core lays both out from records it
        // synthesizes. The icon paints the renderer's broken image icon.
        const node = { display: DISPLAY_CODE_NAMES[box.display], bfc: true };
        if (box.flags & BOX_INLINE_CONTEXT) node.inlineCtx = true;
        if (box.children.length) node.children = box.children;
        if (box.kind === SCENE.BOX_BROKEN_IMAGE_ICON) node.brokenImageIcon = true;
        node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
        node._corePublication = publicationRef;
        node._coreFont = box.font;
        node._coreFontCss = faceCssOf(box.font);
        node._coreBoxHandle = Number(box.context);
        nodes[index] = node;
        break;
      }
      default:
        if (box.kind >= SCENE.BOX_PAGE_FIRST && box.kind <= SCENE.BOX_PAGE_LAST) {
          // A page box (CSS Paged Media 3, 3 and 5): a page-margin box or the
          // page background. The core lays it out from the root element's
          // page-box pseudo-element record; the engine places it.
          const node = { display: DISPLAY_CODE_NAMES[box.display] };
          if (box.flags & BOX_BFC) node.bfc = true;
          if (box.flags & BOX_INLINE_CONTEXT) node.inlineCtx = true;
          if (box.children.length) node.children = box.children;
          // Its url() background layers bind under the root element's
          // handle and the page box's pseudo kind.
          if (box.host & SCENE.HOST_IMAGE_LAYERS) {
            const imageLayers = core.sceneResourceLayers(box.handle, core.status("scene_box_pseudo_kind", box.kind));
            if (imageLayers) Object.assign(node, imageLayers);
          }
          node.generatedOwnerIndex = box.owner;
          node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
          node._corePublication = publicationRef;
          node._coreFont = box.font;
          node._coreFontCss = faceCssOf(box.font);
          node._coreBoxHandle = Number(box.context);
          nodes[index] = node;
          break;
        }
        // A page box's text.
        if (box.kind >= SCENE.BOX_PAGE_TEXT_FIRST && box.kind <= SCENE.BOX_PAGE_TEXT_LAST) {
          nodes[index] = textBox(box);
          break;
        }
        throw new Error(`serializeToScene: unknown box kind ${box.kind}`);
    }
    nodes[index]._corePublication = publicationRef;
    nodes[index]._corePublicationIndex = index;
  }

  function elementScene(el, box, index) {
    // An SVG row's engine record decides its display: a pattern template
    // (engine display none, painted only by its shape) has no SVG style.
    const nativeSvg = box.display === SCENE.DISPLAY_SVG_SHAPE
      ? readSceneRowStyle(core, { _corePublication: publicationRef, _corePublicationIndex: index }).svg ?? null
      : null;
    const display = box.display === SCENE.DISPLAY_SVG_SHAPE
      ? nativeSvg === null ? "none" : nativeSvg.path ? "svg-path" : SVG_SHAPE_DISPLAY[el.localName]
      : DISPLAY_CODE_NAMES[box.display];
    // background-image url() layers are host resources: the renderer
    // resolves each URL to an image index and writes it into the record's
    // layer entries. Gradient and none layers stay in the core's record.
    // CSS backgrounds do not paint on an svg shape box, whose one record
    // layer is its gradient stroke (core/dom/engine-paint.watpart).
    const imageLayers = box.host & SCENE.HOST_IMAGE_LAYERS && box.display !== SCENE.DISPLAY_SVG_SHAPE
      ? core.sceneResourceLayers(el._coreHandle, core.status("scene_box_pseudo_kind", box.kind))
      : null;
    let pathDefinition = null;
    if (nativeSvg?.path) {
      pathDefinition = {
        d: nativeSvg.path.pathDef,
        identity: box.stableId.toString(),
        resourceRevision: core.status("resource_revision"),
        fillRule: nativeSvg.path.fillRule,
        stroke: nativeSvg.strokeParameters ?? null,
      };
    }
    const resource = box.host & SCENE.HOST_RESOURCE ? core.sceneResourceNode(el._coreHandle) : 0n;
    const resourceInfo = resource === 0n ? null : core.resourceInfo(resource);
    // Built field by field: this runs once per element per serialization,
    // and object spreads here were a measurable share of the frame.
    const node = {};
    // A box that declares transitions also keeps an owned copy of its
    // unrelocated record: the renderer reads transition endpoints from the
    // previous and next serialization, never from the shared engine buffer.
    // The copy leaves out the effects of the running transitions that
    // computed resolution applies (engine_record_after_change).
    //
    // The record carries the transform list already folded into one affine
    // (engine-transform.watpart), which CSS cannot interpolate: matching
    // function lists interpolate component-wise (an angle for rotate()),
    // matrices only as the mismatched-list fallback. So the CSS form comes
    // along too, per serialization and immutable like the record — the same
    // resolved-fields shape the render surface's transform-only frames
    // already put on a retained node.
    if (box.flags & BOX_TRANSITIONS) {
      node.transitionDefinitions = animationTransitionDefinitions(el);
      node._coreRecord = core.engineRecordAfterChange(box.stableId, box.sourceRevision);
      node.transform = elementTransform(el);
    }
    if (el === root) Object.assign(node, rootWriting);
    node.display = display;
    // The element behind the box, for the core's engine record. Handles
    // are (generation << 32 | index) and fit a double exactly.
    node._coreHandle = Number(el._coreHandle);
    node._coreBox = box.kind | (box.flags << 8) | (box.display << 24);
    node._corePublication = publicationRef;
    node._coreFont = box.font;
    node._coreFontCss = faceCssOf(box.font);
    // A textarea needs its face for rows/cols intrinsic sizing even when
    // display:block gives it no inline formatting context.
    if (el.localName === "textarea") node._coreTextarea = true;
    if (box.flags & BOX_BFC) node.bfc = true;
    if (box.flags & BOX_INLINE_CONTEXT) node.inlineCtx = true;
    if (resourceInfo !== null) {
      if (resourceInfo.kind === RESOURCE_TYPE_IMAGE) node.src = core.resourceKey(resource);
      if (resourceInfo.kind === RESOURCE_TYPE_CANVAS) {
        imageSources.set(resourceInfo.id, el._canvasContext.paintSource);
        node.canvasSourceIdentifier = resourceInfo.id;
      }
      node.resourceIdentifier = resourceInfo.id;
    }
    if (box.display === SCENE.DISPLAY_TEXT) {
      Object.defineProperty(node, "text", {
        enumerable: true,
        get: () => box.text ?? "",
      });
    }
    if (pathDefinition !== null) {
      node.d = pathDefinition.d;
      node._coreSvgRequest = pathDefinition;
    }
    if (imageLayers) Object.assign(node, imageLayers);
    if (scrollOwner && !el._scrollState) {
      const request = scrollRequests.get(node._coreHandle);
      node.scrollLeft = request === undefined ? 0 : request[0];
      node.scrollTop = request === undefined ? 0 : request[1];
    } else {
      // A state the element already holds may predate the surface and
      // attaches to it on this read.
      node.scrollLeft = el._requestedScrollLeft;
      node.scrollTop = el._requestedScrollTop;
    }
    if (box.children.length) node.children = box.children;
    return node;
  }

  core.attachSceneResources(nodes, root._coreHandle);
  recordSceneStyleGeneration(nodes, styleSystem?.generation ?? 0);
  let released = false;
  const serialized = {
    nodes,
    geometryBoxes: boxes,
    ...(renderViewport === null ? {} : { viewportIndex: 0 }),
    indexOf,
    pseudoIndexOf,
    // Text geometry (carets, glyphs) is read back from the paint artifact;
    // a scene without text boxes has none to read.
    textBoxes,
    generatedBoxRows,
    // Each size query container as its element handle and scene row, then
    // each scroll-state query container.
    queryContainers: containerRows(core, indexOf, queryContainerEntries, 3),
    scrollStateContainers: containerRows(core, indexOf, queryContainerEntries, 4),
    loweredRows,
    changedRows,
    // Rows that took the previous publication's lowered bytes.
    reusedRows,
    canvasBackground,
    imageSources,
    // A DOM-backed box's scene node carries no style; the style system's
    // generation tells the persistent renderer when core records may have
    // changed.
    styleGeneration: styleSystem?.generation ?? 0,
    publication,
    // Sparse row lists are relative to this exact native predecessor, not
    // merely the last scene rendered by a surface. Revisions survive handle
    // reuse after a foreign publication has been released.
    publicationRevision: core.engineRecordRevision(publication),
    previousPublicationRevision: core.engineRecordPrevious(publication),
    // The wrapper keeps the reference alive too, so a caller that holds
    // only the wrapper (a layout getter's envelope) keeps the publication.
    publicationRef,
    release() {
      if (released) return;
      released = true;
      publications.unregister(publicationRef);
      core.engineRecordRelease(publication);
    },
  };
  return serialized;
}

// Publications are freed when their serialization is replaced (release())
// or, as a backstop, when the reference every node of the scene holds is
// collected.
const publications = new FinalizationRegistry(({ core, publication }) => {
  try {
    core.engineRecordRelease(publication);
  } catch { /* released or disposed */ }
});
