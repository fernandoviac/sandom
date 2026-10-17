// The image loading of the DOM: the state of each img element that a
// script sees, the HTML Standard "update the image data" steps, the load
// and error events, decode(), and the delay of the window load event
// (docs/design/dom-webassembly-core.md, "Images and forms"). The order of
// events and the member values follow Chrome, as the parity pages of
// test/images/image_dom_test.js measure.
//
// An image is a demand of the document's host resource session
// (document._resolveResource). The loader keeps one demand for each image
// URL and src/image-decode.js one decode for each resource, so the scene
// renderer that paints the image later takes the same fetch and the same
// decode. When an image completes, its readiness and natural size go into
// the element's resource record in the DOM core, where layout reads them.
import { decodeImageResource, UndecodableImageError } from "../image-decode.js";
import { defaultImageRuntime } from "../scene-renderer.js";
import { SandomHostError } from "../host/contract.js";
import { documentScripts } from "./scripts.js";
import { withLiveGeometry } from "./live-geometry.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

function isImageElement(node) {
  return node.nodeType === 1 && node.localName === "img" && node.namespaceURI === HTML_NAMESPACE;
}

// A document loads images for its DOM when it has a browsing context: a
// document with a window. A document from DOMParser or createHTMLDocument
// has none, as in a browser.
function activeDocument(document) {
  return document !== null && document !== undefined && document.defaultView != null;
}

function encodingError() {
  return new DOMException("The source image cannot be decoded.", "EncodingError");
}

// The image loading record of a document: the list of available images
// (URL -> natural size and record size), the count of image requests that
// delay its load event, and the elements that have an image state. The
// state lives on the element's wrapper, which the DOM core holds weakly:
// the document keeps the wrapper, so that every later read of the element
// gets the same wrapper and its state.
function documentImages(document) {
  document._imageLoading ??= { available: new Map(), delaying: 0, elements: new Set() };
  return document._imageLoading;
}

// The end of parsing waits for this to be false before the window load
// event (src/dom/scripts.js); a change wakes it.
export function imagesDelayLoadEvent(document) {
  return (document._imageLoading?.delaying ?? 0) > 0;
}

function releaseLoadEvent(document) {
  const images = documentImages(document);
  images.delaying -= 1;
  if (images.delaying === 0) document._scriptProcessing?.notify();
}

// The image state of an element: its current request (state, URL, natural
// size and, once complete, the decoded image that a canvas draws); whether
// an update of the image data waits for its request, and the decode()
// requests that wait with it; the document whose load event the update
// delays until the update's event has run; and the generation that each
// update advances, so that the result of an older update is ignored.
function imageState(element) {
  if (element._image === undefined) {
    element._image = {
      generation: 0,
      state: "unavailable",
      currentURL: "",
      naturalWidth: 0,
      naturalHeight: 0,
      canvasImage: null,
      pending: false,
      decodeRequests: [],
      delayedDocument: null,
    };
    documentImages(element.ownerDocument).elements.add(element);
  }
  return element._image;
}

function rejectDecodeRequests(state) {
  const requests = state.decodeRequests;
  state.decodeRequests = [];
  for (const request of requests) request.reject(encodingError());
}

// An update delays the load event of its document until its event has
// run, or until a later update replaces it.
function delayLoadEvent(state, document) {
  state.delayedDocument = document;
  documentImages(document).delaying += 1;
}

function releaseDelay(state) {
  const document = state.delayedDocument;
  state.delayedDocument = null;
  if (document !== null) releaseLoadEvent(document);
}

function queueElementTask(element, task) {
  documentScripts(element.ownerDocument).queueTask(task);
}

function fireImageEvent(element, type) {
  documentScripts(element.ownerDocument).fire(element, type);
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

// The element's resource record in the DOM core, while the record's key is
// still the requested src, else null.
function resourceRecord(element, src) {
  if (element.getAttribute("src") !== src) return null;
  const handle = element._domCore.sceneResourceNode(element._coreHandle);
  return handle === 0n ? null : handle;
}

// The decoded image enters the renderer runtime under the element's
// resource record: the record gets the readiness and size that layout
// reads, and the renderer the registration that it paints. Returns null
// when that is done, else a promise (an SVG image rasterizes first).
function registerImage(element, src, resource) {
  const handle = resourceRecord(element, src);
  if (handle === null) return null;
  return rendererRuntime(element.ownerDocument).registerDecodedImage(handle, resource);
}

function markBroken(element, src) {
  const handle = resourceRecord(element, src);
  if (handle !== null) element._domCore.resourceUpdate(handle, 2, 0, 0, false, 1);
}

// "Update the image data" (HTML Standard 4.8.4.3.5), for an img without
// srcset or picture: Sandom paints neither.
export function updateImageData(element) {
  const document = element.ownerDocument;
  if (!activeDocument(document)) return;
  const state = imageState(element);
  const generation = state.generation += 1;
  // A decode() of the previous request does not see this one.
  rejectDecodeRequests(state);
  state.pending = false;
  releaseDelay(state);
  const src = element.getAttribute("src");
  if (src !== null && src !== "") {
    const url = URL.parse(src, document.baseURI);
    const available = url === null ? undefined : documentImages(document).available.get(url.href);
    if (available !== undefined) {
      // The list of available images has the URL: the image is complete
      // at once, and its load event is a task, which the window load event
      // waits for, as in Chrome.
      state.state = "complete";
      state.currentURL = url.href;
      state.naturalWidth = available.naturalWidth;
      state.naturalHeight = available.naturalHeight;
      state.canvasImage = available.canvasImage;
      registerImage(element, src, available.resource)?.catch((error) => document._reportException?.(error));
      delayLoadEvent(state, document);
      queueElementTask(element, () => {
        if (state.generation !== generation) return;
        fireImageEvent(element, "load");
        releaseDelay(state);
      });
      return;
    }
  }
  state.pending = true;
  delayLoadEvent(state, document);
  queueMicrotask(() => continueUpdate(element, state, generation));
}

function failRequest(element, state, generation, currentURL, fire) {
  state.state = "broken";
  state.currentURL = currentURL;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.canvasImage = null;
  state.pending = false;
  rejectDecodeRequests(state);
  if (!fire) {
    releaseDelay(state);
    return;
  }
  queueElementTask(element, () => {
    if (state.generation !== generation) return;
    fireImageEvent(element, "error");
    releaseDelay(state);
  });
}

// The steps after "await a stable state".
async function continueUpdate(element, state, generation) {
  if (state.generation !== generation) return;
  const document = element.ownerDocument;
  const src = element.getAttribute("src");
  if (src === null || src === "") {
    // No selected source: an empty src fires error, a missing one nothing.
    failRequest(element, state, generation, "", src === "");
    return;
  }
  const url = URL.parse(src, document.baseURI);
  if (url === null) {
    failRequest(element, state, generation, src, true);
    return;
  }
  // The request of the new URL replaces the current request at once, as
  // in Chrome: until it completes, the image has no natural size and no
  // current URL.
  state.state = "unavailable";
  state.currentURL = "";
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.canvasImage = null;
  let resource;
  let decoded;
  try {
    // The demand carries the reference as authored, which resolves against
    // the document base URL, as `url` did.
    resource = await document._resolveResource({ requestedURL: src, kind: "image" });
    decoded = await decodeImageResource(resource, rendererRuntime(document).codecRuntime);
  } catch (error) {
    if (state.generation !== generation) return;
    // A host failure (a refused or failed fetch) and bytes that do not
    // decode both break the image. Any other error is a Sandom bug, which
    // the document reports.
    if (!(error instanceof UndecodableImageError) && !(error instanceof SandomHostError)) {
      document._reportException?.(error);
    }
    markBroken(element, src);
    failRequest(element, state, generation, url.href, true);
    return;
  }
  if (state.generation !== generation) return;
  let entry;
  try {
    await registerImage(element, src, resource);
    // The decoded image of a canvas that draws this element: the
    // renderer's entry of the same decode (an SVG image's raster).
    entry = await rendererRuntime(document).canvasImageEntry(resource);
    if (entry === null) throw new Error(`Image ${url.href}: the decoded image has no renderer entry`);
  } catch (error) {
    if (state.generation !== generation) return;
    document._reportException?.(error);
    markBroken(element, src);
    failRequest(element, state, generation, url.href, true);
    return;
  }
  if (state.generation !== generation) return;
  state.state = "complete";
  state.currentURL = url.href;
  state.naturalWidth = Math.round(decoded.naturalWidth);
  state.naturalHeight = Math.round(decoded.naturalHeight);
  state.canvasImage = Object.freeze({
    entry,
    // An opaque response taints a canvas that draws the image
    // (src/dom/document-resources.js).
    opaque: resource.opaque === true,
    // An SVG image whose root gives no width or height has the default
    // object size as its natural size, and no natural dimensions.
    naturalDimensions: decoded.kind !== "svg" || decoded.naturalDimensions !== false,
  });
  state.pending = false;
  documentImages(document).available.set(url.href, {
    naturalWidth: state.naturalWidth,
    naturalHeight: state.naturalHeight,
    canvasImage: state.canvasImage,
    resource,
  });
  queueElementTask(element, () => {
    if (state.generation !== generation) return;
    fireImageEvent(element, "load");
    releaseDelay(state);
  });
  // A decode() that waited for the request settles in the task after the
  // load event, as Chrome orders them.
  const decodeRequests = state.decodeRequests;
  state.decodeRequests = [];
  if (decodeRequests.length > 0) {
    queueElementTask(element, () => {
      for (const request of decodeRequests) request.resolve(undefined);
    });
  }
}

// The relevant mutations of an img (HTML Standard 4.8.4.3.6) that Sandom
// sees: its src attribute changes, the parser or fragment parsing makes it,
// it is cloned, or it is adopted into a document.
export function imageAttributeChanged(element, name) {
  if (name === "src" && isImageElement(element)) updateImageData(element);
}

export function imageAdopted(element, newDocument) {
  if (isImageElement(element) && activeDocument(newDocument)) updateImageData(element);
}

export function imageCloned(clone) {
  if (isImageElement(clone) && clone.hasAttribute("src")) updateImageData(clone);
}

// The images that the parser or fragment parsing made under `root` (a
// document or a fragment): each one with a src and no image state yet
// starts to load.
export function imagesParsed(root) {
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  if (!activeDocument(document)) return;
  const images = root.nodeType === 9 ? root.getElementsByTagName("img") : root.querySelectorAll("img");
  for (let index = 0; index < images.length; index += 1) {
    const element = images[index];
    if (element._image === undefined && isImageElement(element) && element.hasAttribute("src")) {
      updateImageData(element);
    }
  }
}

// HTMLImageElement members.

export function imageComplete(element) {
  const src = element.getAttribute("src");
  if (src === null || src === "") return true;
  const state = element._image;
  if (state === undefined) return false;
  return !state.pending && (state.state === "complete" || state.state === "broken");
}

export function imageNaturalWidth(element) {
  return element._image?.naturalWidth ?? 0;
}

export function imageNaturalHeight(element) {
  return element._image?.naturalHeight ?? 0;
}

export function imageCurrentSrc(element) {
  return element._image?.currentURL ?? "";
}

// The image of an img as a canvas image source (HTML "check the usability
// of the image argument"): "broken" when a request for a URL failed (the
// state in which Chrome throws; an img without src, or with an empty src,
// is not broken there), "complete" with its natural size and decoded image,
// else "unavailable" (a canvas draws nothing).
export function imageCanvasSource(element) {
  const state = element._image;
  if (state === undefined) return { state: "unavailable" };
  if (state.state === "broken") return { state: state.currentURL === "" ? "unavailable" : "broken" };
  if (state.state !== "complete" || state.canvasImage === null) return { state: "unavailable" };
  return {
    state: "complete",
    width: state.naturalWidth,
    height: state.naturalHeight,
    ...state.canvasImage,
  };
}

export function imageDecode(element) {
  return new Promise((resolve, reject) => {
    const state = element._image;
    if (!activeDocument(element.ownerDocument) || state === undefined) {
      reject(encodingError());
      return;
    }
    if (state.pending) {
      state.decodeRequests.push({ resolve, reject });
      return;
    }
    if (state.state !== "complete") {
      reject(encodingError());
      return;
    }
    // A complete image settles in a task queued after a microtask.
    const generation = state.generation;
    queueMicrotask(() => {
      queueElementTask(element, () => {
        if (state.generation === generation && state.state === "complete") resolve(undefined);
        else reject(encodingError());
      });
    });
  });
}

// "Rules for parsing non-negative integers".
function parseNonNegativeInteger(value) {
  if (value === null) return null;
  const match = /^[\t\n\f\r ]*\+?(\d+)/.exec(value);
  return match === null ? null : Number(match[1]);
}

// Geometry values (geometry.watpart, geometry_value): client width and
// height, padding top, right, bottom and left, and whether the node has a
// box.
const CLIENT_WIDTH = 14;
const CLIENT_HEIGHT = 15;
const PADDING_TOP = 40;
const PADDING_RIGHT = 41;
const PADDING_BOTTOM = 42;
const PADDING_LEFT = 43;
const HAS_BOX = 45;

// The content box size of the element in CSS pixels from one layout pass,
// or null when the element is not being rendered.
function renderedContentSize(element) {
  if (!element.isConnected) return null;
  // The geometry of an element with display: none keeps a row with a box.
  if (element.ownerDocument.getComputedStyle(element).display === "none") return null;
  return withLiveGeometry(element, undefined, ({ core, handle }) => {
    const value = (field) => core.status("geometry_value", handle, element._coreHandle, field);
    if (value(HAS_BOX) === 0) return null;
    return [
      value(CLIENT_WIDTH) - value(PADDING_LEFT) - value(PADDING_RIGHT),
      value(CLIENT_HEIGHT) - value(PADDING_TOP) - value(PADDING_BOTTOM),
    ];
  });
}

// The width (axis 0) and height (axis 1) IDL attributes: the rendered size
// when the image is being rendered, else the dimension attribute when it
// parses, else the natural size of an available image, else 0 (Chrome's
// order).
export function imageDimension(element, axis) {
  const rendered = renderedContentSize(element);
  if (rendered !== null) return Math.round(rendered[axis]);
  const attribute = parseNonNegativeInteger(element.getAttribute(axis === 0 ? "width" : "height"));
  if (attribute !== null) return attribute;
  return axis === 0 ? imageNaturalWidth(element) : imageNaturalHeight(element);
}

// The content attribute value of an unsigned long reflected attribute: a
// value above 2147483647 sets 0.
export function unsignedLongAttributeValue(value) {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.trunc(number) : 0;
  const unsigned = ((integer % 2 ** 32) + 2 ** 32) % 2 ** 32;
  return String(unsigned > 2147483647 ? 0 : unsigned);
}
