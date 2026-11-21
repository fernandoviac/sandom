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
import { layoutConstant } from "./wasm/layout-table.js";

const SVG_IMAGE_SIZE = Object.fromEntries(["WIDTH", "HEIGHT", "RATIO", "NATURAL_DIMENSIONS", "DEFAULT_SIZED"]
  .map((name) => [name, layoutConstant(`SVG_IMAGE_SIZE_${name}`)]));

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

// The natural size of an SVG image's document (svg_image_natural_size):
// naturalWidth and naturalHeight, naturalDimensions (whether the size does
// not come from the default object size; createImageBitmap() needs one),
// defaultSized (neither a width nor a height: CSS sizes it by the default
// sizing algorithm, CSS Images 3 §5.2) and naturalRatio (width / height of
// its viewBox, or null). null when the document element is not an SVG svg
// element.
function svgNaturalSize(document) {
  const core = document._domCore;
  if (core.status("svg_image_natural_size", document._coreHandle) === 0) return null;
  const view = core.output("svg_image_natural_size");
  const ratio = view.getFloat64(SVG_IMAGE_SIZE.RATIO, true);
  return {
    naturalWidth: view.getFloat64(SVG_IMAGE_SIZE.WIDTH, true),
    naturalHeight: view.getFloat64(SVG_IMAGE_SIZE.HEIGHT, true),
    naturalDimensions: view.getUint32(SVG_IMAGE_SIZE.NATURAL_DIMENSIONS, true) === 1,
    defaultSized: view.getUint32(SVG_IMAGE_SIZE.DEFAULT_SIZED, true) === 1,
    naturalRatio: Number.isNaN(ratio) ? null : ratio,
  };
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
  const size = svgNaturalSize(document);
  if (size === null) {
    throw new UndecodableImageError(`Invalid SVG image at ${locator}: expected an SVG root`);
  }
  return Object.freeze({ kind: "svg", source, ...size });
}
