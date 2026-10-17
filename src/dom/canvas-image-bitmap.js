// ImageBitmap and createImageBitmap() of a Sandom document
// (plans/dom/PLAN-canvas-2d.md, slice 6; docs/specifications/canvas-2d.md,
// "Images and bitmaps").
//
// An ImageBitmap holds the image of its source as a Canvas 2D source
// (src/dom/canvas-2d.js, resolveImageSource): the source's own image when
// the bitmap takes it whole, else the command list that draws its crop,
// resize or flip (derivedImageSource). Nothing is drawn or read when the
// bitmap is made: a canvas that draws the bitmap rasterizes its image on
// its own device. An image Blob decodes through the renderer's codec, the
// decoder of every image of the document.
//
// The arguments, the options and the errors follow Chrome (measured on the
// pinned Chrome 151, test/canvas/canvas_2d_image_parity_test.js).
import {
  BROKEN_IMAGE,
  derivedImageSource,
  discardSource,
  imageDataSource,
  isImageDataObject,
  releaseSource,
  registerImageBitmapState,
  resolveImageSource,
  retainSource,
} from "./canvas-2d.js";
import { imageCodecRuntime, queueDocumentTask } from "./images.js";
import { decodeImageResource, UndecodableImageError } from "../image-decode.js";
import { prepareImageProfile } from "../image-data.js";

const CONSTRUCTION = Symbol("ImageBitmap construction");
const MEMBER = "Window.createImageBitmap";
const SOURCE_TYPE =
  "(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)";

let bitmapImage;

export class ImageBitmap {
  // { source, width, height, opaque, originClean, naturalDimensions }, or
  // null once closed. The bitmap holds one reference to `source`.
  #image;

  constructor(token, image) {
    if (token !== CONSTRUCTION) throw new TypeError("Failed to construct 'ImageBitmap': Illegal constructor");
    this.#image = image;
  }

  get width() {
    return this.#image?.width ?? 0;
  }

  get height() {
    return this.#image?.height ?? 0;
  }

  close() {
    if (this.#image === null) return;
    releaseSource(this.#image.source);
    this.#image = null;
  }

  get [Symbol.toStringTag]() {
    return "ImageBitmap";
  }

  static {
    bitmapImage = (value) => #image in value ? value.#image : undefined;
  }
}

// The image of an ImageBitmap for resolveImageSource(): undefined when
// `value` is not an ImageBitmap, null when it is closed.
export function imageBitmapState(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return bitmapImage(value);
}
registerImageBitmapState(imageBitmapState);

// An ImageBitmap that takes `image` (a resolved source whose source it
// retains).
export function createImageBitmapOf(image) {
  retainSource(image.source);
  return new ImageBitmap(CONSTRUCTION, Object.freeze({ ...image }));
}

// ---------------------------------------------------------------- options

const ORIENTATIONS = ["from-image", "flipY", "none"];
const PREMULTIPLY = ["none", "premultiply", "default"];
const COLOR_SPACE_CONVERSIONS = ["none", "default"];
const RESIZE_QUALITIES = ["pixelated", "low", "medium", "high"];

function enumOption(options, name, values, type, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  const text = String(value);
  if (!values.includes(text)) {
    throw new TypeError(
      `${MEMBER}: Failed to read the '${name}' property from 'ImageBitmapOptions': The provided value '${text}' is not a valid enum value of type ${type}.`,
    );
  }
  return text;
}

// WebIDL [EnforceRange] unsigned long.
function enforcedUnsignedLong(options, name) {
  const value = options[name];
  if (value === undefined) return undefined;
  const number = Number(value);
  const prefix = `${MEMBER}: Failed to read the '${name}' property from 'ImageBitmapOptions':`;
  if (!Number.isFinite(number)) throw new TypeError(`${prefix} Value is not of type 'unsigned long'.`);
  const truncated = Math.trunc(number);
  if (truncated < 0 || truncated > 0xffffffff) {
    throw new TypeError(`${prefix} Value is outside the 'unsigned long' value range.`);
  }
  return truncated;
}

// ImageBitmapOptions, read in dictionary order (alphabetical, as WebIDL
// reads a dictionary). colorSpaceConversion and premultiplyAlpha are read
// and validated; they do not change what a canvas draws (see the
// specification).
function bitmapOptions(value) {
  if (value === undefined || value === null) {
    return { imageOrientation: "from-image", resizeWidth: undefined, resizeHeight: undefined, resizeQuality: "low" };
  }
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError(`${MEMBER}: The provided value is not of type 'ImageBitmapOptions'.`);
  }
  enumOption(value, "colorSpaceConversion", COLOR_SPACE_CONVERSIONS, "ColorSpaceConversion", "default");
  const imageOrientation = enumOption(value, "imageOrientation", ORIENTATIONS, "ImageOrientation", "from-image");
  enumOption(value, "premultiplyAlpha", PREMULTIPLY, "PremultiplyAlpha", "default");
  const resizeHeight = enforcedUnsignedLong(value, "resizeHeight");
  const resizeQuality = enumOption(value, "resizeQuality", RESIZE_QUALITIES, "ResizeQuality", "low");
  const resizeWidth = enforcedUnsignedLong(value, "resizeWidth");
  return { imageOrientation, resizeWidth, resizeHeight, resizeQuality };
}

// WebIDL long (no [EnforceRange]).
function toLong(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number | 0 : 0;
}

// ---------------------------------------------------------- the factory

function rejection(name, message) {
  return Promise.reject(name === "TypeError" ? new TypeError(message) : name === "RangeError"
    ? new RangeError(message)
    : new DOMException(message, name));
}

function isBlob(value) {
  return typeof Blob === "function" && value instanceof Blob;
}

// The bitmap's size and its crop of a `width` x `height` source (Blink
// ImageBitmap::ParseOptions): a crop rect with a negative side extends the
// other way; a resize of one side scales the other in proportion, rounded
// up in single precision.
function bitmapGeometry(width, height, crop, options) {
  const rect = crop ?? [0, 0, width, height];
  const cropWidth = rect[2];
  const cropHeight = rect[3];
  const f32 = Math.fround;
  let outputWidth = cropWidth;
  let outputHeight = cropHeight;
  if (options.resizeWidth !== undefined && options.resizeHeight !== undefined) {
    outputWidth = options.resizeWidth;
    outputHeight = options.resizeHeight;
  } else if (options.resizeWidth !== undefined) {
    outputWidth = options.resizeWidth;
    outputHeight = Math.ceil(f32(f32(f32(options.resizeWidth) / cropWidth) * cropHeight));
  } else if (options.resizeHeight !== undefined) {
    outputHeight = options.resizeHeight;
    outputWidth = Math.ceil(f32(f32(f32(options.resizeHeight) / cropHeight) * cropWidth));
  }
  return { crop: rect, width: outputWidth, height: outputHeight };
}

// The ImageBitmap of a resolved `image` with `crop` and `options`; the
// bitmap takes `image.source` whole when nothing changes it.
function bitmapOf(image, crop, options) {
  const geometry = bitmapGeometry(image.width, image.height, crop, options);
  const [sx, sy, sw, sh] = geometry.crop;
  const whole = sx === 0 && sy === 0 && sw === image.width && sh === image.height &&
    geometry.width === image.width && geometry.height === image.height && options.imageOrientation !== "flipY";
  if (whole) return createImageBitmapOf(image);
  const source = derivedImageSource(
    image,
    geometry.crop,
    geometry.width,
    geometry.height,
    options.imageOrientation === "flipY",
    options.resizeQuality,
  );
  discardSource(image.source);
  return createImageBitmapOf({
    source,
    width: geometry.width,
    height: geometry.height,
    opaque: false,
    originClean: image.originClean,
    naturalDimensions: true,
  });
}

// The decoded image of an image Blob: a raster image only (Chrome does not
// decode an SVG Blob).
async function blobImage(document, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let decoded;
  try {
    decoded = await decodeImageResource({ bytes, cacheKey: "blob:" }, imageCodecRuntime(document));
  } catch (error) {
    if (!(error instanceof UndecodableImageError)) throw error;
    decoded = null;
  }
  if (decoded === null || decoded.kind !== "raster") {
    throw new DOMException("The source image could not be decoded.", "InvalidStateError");
  }
  const descriptor = prepareImageProfile(decoded.descriptor);
  const entry = Object.freeze({ width: descriptor.width, height: descriptor.height, descriptor });
  return {
    source: { kind: "image", image: entry, references: 0 },
    width: entry.width,
    height: entry.height,
    opaque: descriptor.alphaMode === "opaque",
    originClean: true,
    naturalDimensions: true,
  };
}

// createImageBitmap(image, options) and createImageBitmap(image, sx, sy,
// sw, sh, options) of the window of `document`. The bitmap's image is
// taken when the call is made; the promise settles in a task.
export function createImageBitmap(document, argumentCount, image, ...rest) {
  if (argumentCount < 1) {
    return rejection("TypeError", `${MEMBER}: 1 argument required, but only 0 present.`);
  }
  if (argumentCount === 3 || argumentCount === 4) {
    return rejection("TypeError", `${MEMBER}: Overload resolution failed.`);
  }
  const blob = isBlob(image);
  const imageData = !blob && isImageDataObject(image);
  let resolved;
  let crop = null;
  let options;
  try {
    if (!blob && !imageData) {
      resolved = resolveImageSource(MEMBER, image, "bitmap");
      if (resolved === undefined) throw new TypeError(`${MEMBER}: The provided value is not of type '${SOURCE_TYPE}'.`);
    }
    if (argumentCount >= 5) {
      crop = rest.slice(0, 4).map(toLong);
      options = bitmapOptions(rest[4]);
    } else {
      options = bitmapOptions(rest[0]);
    }
  } catch (error) {
    if (resolved && resolved !== BROKEN_IMAGE) discardSource(resolved.source);
    return Promise.reject(error);
  }
  const fail = (name, message) => {
    if (resolved && resolved !== BROKEN_IMAGE) discardSource(resolved.source);
    return rejection(name, `${MEMBER}: ${message}`);
  };
  if (crop !== null) {
    if (crop[2] === 0 || crop[3] === 0) return fail("RangeError", `The crop rect ${crop[2] === 0 ? "width" : "height"} is 0.`);
    // A crop rect with a negative side extends the other way.
    if (crop[2] < 0) crop = [crop[0] + crop[2], crop[1], -crop[2], crop[3]];
    if (crop[3] < 0) crop = [crop[0], crop[1] + crop[3], crop[2], -crop[3]];
  }
  if (options.resizeWidth === 0) return fail("InvalidStateError", "The resize width dimension is equal to 0.");
  // Chrome names the width for a zero height as well.
  if (options.resizeHeight === 0) return fail("InvalidStateError", "The resize width dimension is equal to 0.");
  let pending;
  if (blob) {
    pending = blobImage(document, image).then((decoded) => bitmapOf(decoded, crop, options));
  } else {
    if (imageData) {
      if (image.data.buffer.detached) return fail("InvalidStateError", "The source data has been detached.");
      resolved = {
        source: imageDataSource(image),
        width: image.width,
        height: image.height,
        opaque: false,
        originClean: true,
        naturalDimensions: true,
      };
    }
    if (resolved === BROKEN_IMAGE) return fail("InvalidStateError", "The HTMLImageElement provided is in the 'broken' state.");
    if (resolved === null) return fail("InvalidStateError", "The image source is not usable.");
    if (resolved.width === 0 || resolved.height === 0) {
      return fail("InvalidStateError", `The image source's ${resolved.width === 0 ? "width" : "height"} is 0.`);
    }
    if (!resolved.naturalDimensions && (options.resizeWidth === undefined || options.resizeHeight === undefined)) {
      return fail(
        "InvalidStateError",
        "The image element contains an SVG image without natural dimensions, and no resize options are specified.",
      );
    }
    let bitmap;
    try {
      bitmap = bitmapOf(resolved, crop, options);
    } catch (error) {
      return Promise.reject(error);
    }
    pending = Promise.resolve(bitmap);
  }
  // The promise settles in a task of the document, as Chrome settles it
  // after the work it posts.
  return pending.then((bitmap) =>
    new Promise((resolve) => queueDocumentTask(document, () => resolve(bitmap)))
  );
}
