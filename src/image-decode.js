// The one decode of each fetched image resource. The DOM image loading
// (src/dom/images.js) and the scene renderer both decode an image through
// decodeImageResource, so the bytes of a resource record decode once: the
// first caller starts the decode and every later caller gets the same
// promise. The renderer makes its texture from the decoded pixels; nothing
// reads pixels back.
//
// A raster image decodes to its pixel descriptor. An SVG image has no pixel
// decode: this step parses and checks the SVG document and gives its
// natural size, and the renderer paints the vector source at that size.
import { svgImageSource } from "./jpeg.js";

// The bytes do not decode: the image is broken, as in a browser.
export class UndecodableImageError extends Error {}

const decodes = new WeakMap();

// resource: a record with `bytes` (a Uint8Array) from a document resource
// loader or a renderer resolver. codecRuntime: the codec runtime of the
// caller (createImageCodecRuntime). Settles to
//   { kind: "raster", descriptor, naturalWidth, naturalHeight }
//   { kind: "svg", source, naturalWidth, naturalHeight, naturalDimensions,
//     defaultSized, naturalRatio }
// or rejects with an UndecodableImageError. Any other rejection is a Sandom
// bug or a codec runtime failure; it is not kept, so a later call decodes
// again.
export function decodeImageResource(resource, codecRuntime) {
  let decoded = decodes.get(resource);
  if (decoded === undefined) {
    decoded = decode(resource.bytes, resource.finalURL ?? resource.cacheKey, codecRuntime);
    decodes.set(resource, decoded);
    decoded.catch((error) => {
      if (!(error instanceof UndecodableImageError) && decodes.get(resource) === decoded) {
        decodes.delete(resource);
      }
    });
  }
  return decoded;
}

async function decode(bytes, locator, codecRuntime) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("An image resource must carry Uint8Array bytes");
  }
  let svgSource;
  try {
    svgSource = svgImageSource(bytes);
  } catch (cause) {
    // The bytes start like XML text but are not UTF-8.
    throw new UndecodableImageError(`Image ${locator}: ${cause.message}`, { cause });
  }
  if (svgSource !== null) return await svgImage(svgSource, locator);
  let descriptor;
  try {
    descriptor = await codecRuntime.decodeImage(bytes);
  } catch (cause) {
    // A raster decoder rejects bytes it cannot decode with an Error or a
    // codec error. A TypeError or a ReferenceError is a Sandom bug.
    if (cause instanceof TypeError || cause instanceof ReferenceError) throw cause;
    throw new UndecodableImageError(`Image ${locator}: ${cause.message}`, { cause });
  }
  return Object.freeze({
    kind: "raster",
    descriptor,
    naturalWidth: descriptor.width,
    naturalHeight: descriptor.height,
  });
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// CSS pixels per unit of an absolute length, and of the font-relative
// lengths at the initial font size of an SVG image (16px). A viewport
// length is 0: an image has no viewport of its own.
const PIXELS_PER_UNIT = Object.freeze({
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 4 / 3,
  pc: 16,
  em: 16,
  rem: 16,
  ex: 8,
  ch: 8,
  vw: 0,
  vh: 0,
  vmin: 0,
  vmax: 0,
});

// A width or height attribute of the root as a natural dimension in CSS
// pixels: null for a percentage, "auto" or a value that does not parse; a
// negative length is 0, as Chrome measures.
function naturalDimension(value) {
  if (value === null) return null;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)\s*$/.exec(value);
  if (match === null) return null;
  const scale = PIXELS_PER_UNIT[match[2].toLowerCase()];
  if (scale === undefined) return null;
  return Math.max(0, Number(match[1]) * scale);
}

function viewBoxRatio(value) {
  if (value === null) return null;
  const numbers = value.trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) return null;
  const [, , width, height] = numbers;
  return width > 0 && height > 0 ? width / height : null;
}

// The natural size of an SVG image, as Chrome gives it: the root's width
// and height attributes; a missing one from the viewBox ratio, else from
// the default object size (300 x 150); with a ratio only, the ratio
// contained in the default object size. naturalDimensions tells whether
// the image has natural dimensions: a size that does not come from the
// default object size (createImageBitmap() needs one). defaultSized tells
// that the image has neither a natural width nor a natural height: CSS
// sizes it by the default sizing algorithm (CSS Images 3 §5.2), with the
// natural ratio of its viewBox (naturalRatio, width / height, or null).
function svgNaturalSize(root) {
  const width = naturalDimension(root.getAttribute("width"));
  const height = naturalDimension(root.getAttribute("height"));
  const ratio = viewBoxRatio(root.getAttribute("viewBox"));
  const size = (naturalWidth, naturalHeight, naturalDimensions) => ({
    naturalWidth,
    naturalHeight,
    naturalDimensions,
    defaultSized: width === null && height === null,
    naturalRatio: ratio,
  });
  if (width !== null && height !== null) return size(width, height, true);
  if (width !== null) return ratio === null ? size(width, 150, false) : size(width, width / ratio, true);
  if (height !== null) return ratio === null ? size(300, height, false) : size(height * ratio, height, true);
  if (ratio === null) return size(300, 150, false);
  return ratio >= 2 ? size(300, 300 / ratio, false) : size(150 * ratio, 150, false);
}

async function svgImage(source, locator) {
  const [{ SDDocument }, { parseXMLDocument }] = await Promise.all([
    import("./dom/node.js"),
    import("./dom/xml.js"),
  ]);
  const document = parseXMLDocument(
    source,
    "image/svg+xml",
    () => new SDDocument({ url: new URL(locator ?? "about:blank", "file:///").href }),
  );
  const root = document.documentElement;
  if (root?.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
    throw new UndecodableImageError(`Invalid SVG image at ${locator}: expected an SVG root`);
  }
  return Object.freeze({ kind: "svg", source, ...svgNaturalSize(root) });
}
