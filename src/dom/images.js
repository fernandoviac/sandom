// The host effects of image loading (docs/design/dom-webassembly-core.md,
// "Images and forms"): the DOM core keeps each img element's request and
// decides each step (image-elements.watpart); this module resolves URLs,
// fetches and decodes, registers the decoded image, queues tasks and
// fires events, and settles decode() promises. The order of events and
// the member values follow Chrome, as the parity pages of
// test/images/image_dom_test.js measure.
//
// An image is a demand of the document's host resource session
// (document._resolveResource). The loader keeps one demand for each image
// URL and src/image-decode.js one decode for each resource, so the scene
// renderer that paints the image later takes the same fetch and the same
// decode.
import { decodeImageResource, UndecodableImageError } from "../image-decode.js";
import { defaultImageRuntime } from "../scene-renderer.js";
import { SandomHostError } from "../host/contract.js";
import { documentScripts } from "./scripts.js";
import { withLiveGeometry } from "./live-geometry.js";
import { layoutConstant } from "../wasm/layout-table.js";
const IMAGE_AXIS_WIDTH = layoutConstant("IMAGE_AXIS_WIDTH");
const IMAGE_AXIS_HEIGHT = layoutConstant("IMAGE_AXIS_HEIGHT");

const IMAGE_ACTION_AVAILABLE = layoutConstant("IMAGE_ACTION_AVAILABLE");
const IMAGE_ACTION_AWAIT_STABLE = layoutConstant("IMAGE_ACTION_AWAIT_STABLE");
const IMAGE_ACTION_FETCH = layoutConstant("IMAGE_ACTION_FETCH");
const IMAGE_ACTION_ERROR_EVENT = layoutConstant("IMAGE_ACTION_ERROR_EVENT");
const IMAGE_ACTION_FAIL_SILENT = layoutConstant("IMAGE_ACTION_FAIL_SILENT");
const IMAGE_ACTION_LOAD_EVENT = layoutConstant("IMAGE_ACTION_LOAD_EVENT");
const IMAGE_MUTATION_ATTRIBUTE = layoutConstant("IMAGE_MUTATION_ATTRIBUTE");
const IMAGE_MUTATION_ADOPTED = layoutConstant("IMAGE_MUTATION_ADOPTED");
const IMAGE_MUTATION_CLONED = layoutConstant("IMAGE_MUTATION_CLONED");
const IMAGE_DECODE_WAIT = layoutConstant("IMAGE_DECODE_WAIT");
const IMAGE_DECODE_SETTLE = layoutConstant("IMAGE_DECODE_SETTLE");
const IMAGE_STATE_COMPLETE = layoutConstant("IMAGE_STATE_COMPLETE");
const IMAGE_STATE_BROKEN = layoutConstant("IMAGE_STATE_BROKEN");

// The image entries of the decoded images (the canvas image and the
// resource), by the entry number that the core keeps for each request and
// available image.
const imageEntries = new Map();
let nextImageEntry = 1;

// A document loads images for its DOM when it has a browsing context: a
// document with a window. A document from DOMParser or createHTMLDocument
// has none, as in a browser.
function activeFlag(document) {
  return Number(document?.defaultView != null);
}

function encodingError() {
  return new DOMException("The source image cannot be decoded.", "EncodingError");
}

// The src attribute resolved against the document base URL; the empty
// string when it does not parse.
function resolvedSource(element) {
  return URL.parse(element.getAttribute("src"), element.ownerDocument.baseURI)?.href ?? "";
}

// The decode() requests that wait for the element's request.
function decodeRequests(element) {
  element._imageDecodeRequests ??= [];
  return element._imageDecodeRequests;
}

function rejectDecodeRequests(element) {
  const requests = decodeRequests(element);
  element._imageDecodeRequests = [];
  for (const request of requests) request.reject(encodingError());
}

// Wakes the script processing of the document that the last image export
// left without a delaying request.
function wakeReleasedDocument(core) {
  core.wrapperFor(core.handle("image_released_document"))?._scriptProcessing?.notify();
}

function queueElementTask(element, task) {
  documentScripts(element.ownerDocument).queueTask(task);
}

// The task of the load or error event of the request of `generation`.
function queueImageEvent(element, generation, type) {
  queueElementTask(element, () => {
    const core = element._domCore;
    if (core.status("image_event_task", element._coreHandle, generation) === 0) return;
    documentScripts(element.ownerDocument).fire(element, type);
    wakeReleasedDocument(core);
  });
}

// The renderer runtime of the document: its synchronous layout is the one
// of the layout getters (live-geometry.js).
function rendererRuntime(document) {
  return document._sandomSceneRendererRuntime ?? defaultImageRuntime;
}

// The codec runtime that decodes the document's images (an image Blob of
// createImageBitmap() too).
export function imageCodecRuntime(document) {
  return rendererRuntime(document).codecRuntime;
}

// A task of the document's event loop (createImageBitmap() settles in one).
export function queueDocumentTask(document, task) {
  documentScripts(document).queueTask(task);
}

// The decoded image enters the renderer runtime under the element's
// resource record: the record gets the readiness and size that layout
// reads, and the renderer the registration that it paints. Returns a
// promise when the registration waits (an SVG image rasterizes first).
function registerImage(element, resource) {
  const handle = element._domCore.sceneResourceNode(element._coreHandle);
  if (handle === 0n) return null;
  return rendererRuntime(element.ownerDocument).registerDecodedImage(handle, resource);
}

// "Update the image data" (HTML Standard 4.8.4.3.5).
export function updateImageData(element) {
  const core = element._domCore;
  const document = element.ownerDocument;
  const action = core.status("image_update", element._coreHandle, activeFlag(document), ...core.input(resolvedSource(element)));
  wakeReleasedDocument(core);
  if (action !== IMAGE_ACTION_AVAILABLE && action !== IMAGE_ACTION_AWAIT_STABLE) return;
  // A decode() of the previous request does not see this one.
  rejectDecodeRequests(element);
  const generation = core.status("image_generation", element._coreHandle);
  if (action === IMAGE_ACTION_AVAILABLE) {
    const entry = imageEntries.get(core.status("image_entry", element._coreHandle));
    registerImage(element, entry.resource)?.catch((error) => document._reportException?.(error));
    queueImageEvent(element, generation, "load");
    return;
  }
  queueMicrotask(() => continueUpdate(element, generation));
}

function performFailure(element, generation, action) {
  wakeReleasedDocument(element._domCore);
  rejectDecodeRequests(element);
  if (action === IMAGE_ACTION_ERROR_EVENT) queueImageEvent(element, generation, "error");
}

function fetchFailed(element, generation) {
  const action = element._domCore.status("image_fetch_failed", element._coreHandle, generation);
  if (action === IMAGE_ACTION_ERROR_EVENT) performFailure(element, generation, action);
}

// The steps after "await a stable state".
async function continueUpdate(element, generation) {
  const core = element._domCore;
  const current = () => core.status("image_current", element._coreHandle, generation) === 1;
  if (!current()) return;
  const document = element.ownerDocument;
  const action = core.status("image_continue", element._coreHandle, generation, ...core.input(resolvedSource(element)));
  if (action === IMAGE_ACTION_ERROR_EVENT || action === IMAGE_ACTION_FAIL_SILENT) {
    performFailure(element, generation, action);
    return;
  }
  if (action !== IMAGE_ACTION_FETCH) return;
  const src = element.getAttribute("src");
  let resource;
  let decoded;
  try {
    // The demand carries the reference as authored, which resolves against
    // the document base URL, as the core's requested URL did.
    resource = await document._resolveResource({ requestedURL: src, kind: "image" });
    decoded = await decodeImageResource(resource, rendererRuntime(document).codecRuntime);
  } catch (error) {
    if (!current()) return;
    // A host failure (a refused or failed fetch) and bytes that do not
    // decode both break the image. Any other error is a Sandom bug, which
    // the document reports.
    if (!(error instanceof UndecodableImageError) && !(error instanceof SandomHostError)) {
      document._reportException?.(error);
    }
    fetchFailed(element, generation);
    return;
  }
  if (!current()) return;
  let rendererEntry;
  try {
    await registerImage(element, resource);
    // The decoded image of a canvas that draws this element: the
    // renderer's entry of the same decode (an SVG image's raster).
    rendererEntry = await rendererRuntime(document).canvasImageEntry(resource);
    if (rendererEntry === null) throw new Error(`Image ${src}: the decoded image has no renderer entry`);
  } catch (error) {
    if (!current()) return;
    document._reportException?.(error);
    fetchFailed(element, generation);
    return;
  }
  const entry = nextImageEntry;
  nextImageEntry += 1;
  imageEntries.set(entry, {
    resource,
    canvasImage: Object.freeze({
      entry: rendererEntry,
      // An opaque response taints a canvas that draws the image
      // (src/dom/document-resources.js).
      opaque: resource.opaque === true,
      // An SVG image whose root gives no width or height has the default
      // object size as its natural size, and no natural dimensions.
      naturalDimensions: decoded.kind !== "svg" || decoded.naturalDimensions !== false,
    }),
  });
  const completed = core.status(
    "image_fetch_complete",
    element._coreHandle,
    generation,
    decoded.naturalWidth,
    decoded.naturalHeight,
    entry,
  );
  if (completed !== IMAGE_ACTION_LOAD_EVENT) return;
  queueImageEvent(element, generation, "load");
  // A decode() that waited for the request settles in the task after the
  // load event, as Chrome orders them.
  const waiting = decodeRequests(element);
  element._imageDecodeRequests = [];
  queueElementTask(element, () => {
    for (const request of waiting) request.resolve(undefined);
  });
}

function mutationUpdates(element, mutation, name = "") {
  const core = element._domCore;
  return core.status("image_mutation_updates", element._coreHandle, mutation, ...core.input(name)) === 1;
}

// The relevant mutations of an img (HTML Standard 4.8.4.3.6) that Sandom
// sees: its src attribute changes, the parser or fragment parsing makes it,
// it is cloned, or it is adopted into a document.
export function imageAttributeChanged(element, name) {
  if (mutationUpdates(element, IMAGE_MUTATION_ATTRIBUTE, name)) updateImageData(element);
}

export function imageAdopted(element) {
  if (mutationUpdates(element, IMAGE_MUTATION_ADOPTED)) updateImageData(element);
}

export function imageCloned(clone) {
  if (mutationUpdates(clone, IMAGE_MUTATION_CLONED)) updateImageData(clone);
}

// The images that the parser or fragment parsing made under `root` (a
// document or a fragment) start to load.
export function imagesParsed(root) {
  const core = root._domCore;
  for (const element of core.statusNodes("image_parsed_elements", root._coreHandle)) {
    updateImageData(element);
  }
}

// The end of parsing waits for this to be false before the window load
// event (src/dom/scripts.js); a change wakes it.
export function imagesDelayLoadEvent(document) {
  return document._domCore.status("image_delays_load", document._coreHandle) === 1;
}

// HTMLImageElement members.

export function imageComplete(element) {
  return element._domCore.status("image_complete", element._coreHandle) === 1;
}

export function imageNaturalWidth(element) {
  return element._domCore.status("image_natural_size", element._coreHandle, IMAGE_AXIS_WIDTH);
}

export function imageNaturalHeight(element) {
  return element._domCore.status("image_natural_size", element._coreHandle, IMAGE_AXIS_HEIGHT);
}

export function imageCurrentSrc(element) {
  return element._domCore.string("image_current_src", element._coreHandle);
}

// The image of an img as a canvas image source.
export function imageCanvasSource(element) {
  const core = element._domCore;
  const state = core.status("image_canvas_state", element._coreHandle);
  if (state === IMAGE_STATE_BROKEN) return { state: "broken" };
  if (state !== IMAGE_STATE_COMPLETE) return { state: "unavailable" };
  return {
    state: "complete",
    width: imageNaturalWidth(element),
    height: imageNaturalHeight(element),
    ...imageEntries.get(core.status("image_entry", element._coreHandle)).canvasImage,
  };
}

export function imageDecode(element) {
  return new Promise((resolve, reject) => {
    const core = element._domCore;
    const answer = core.status("image_decode", element._coreHandle, activeFlag(element.ownerDocument));
    if (answer === IMAGE_DECODE_WAIT) {
      decodeRequests(element).push({ resolve, reject });
      return;
    }
    if (answer !== IMAGE_DECODE_SETTLE) {
      reject(encodingError());
      return;
    }
    // A complete image settles in a task queued after a microtask.
    const generation = core.status("image_generation", element._coreHandle);
    queueMicrotask(() => {
      queueElementTask(element, () => {
        if (core.status("image_decode_settles", element._coreHandle, generation) === 1) resolve(undefined);
        else reject(encodingError());
      });
    });
  });
}

// The width (axis 0) and height (axis 1) IDL attributes.
export function imageDimension(element, axis) {
  const core = element._domCore;
  if (core.status("image_dimension_rendered", element._coreHandle) === 0) {
    return core.status("image_dimension", 0n, element._coreHandle, axis);
  }
  return withLiveGeometry(element, undefined, ({ handle }) => core.status("image_dimension", handle, element._coreHandle, axis));
}

// The content attribute value that the width and height setters of an img
// write.
export function unsignedLongAttributeValue(core, value) {
  return String(core.status("image_dimension_value", Number(value)));
}
