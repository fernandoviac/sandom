// Binding of the image container module (core/engine/image-container.wat):
// the format of encoded image bytes, the ICC profile and Exif orientation
// of a JPEG, and the pixel move of an orientation.
import * as imageContainerBinary from "./wasm/image-container-binary.js";
import { moduleLayoutConstants } from "./wasm/layout-table.js";

const containerConstant = moduleLayoutConstants(imageContainerBinary, "image container");
const ICC_PROFILE_ABSENT = containerConstant("ICC_PROFILE_ABSENT");
const ICC_PROFILE_INVALID = containerConstant("ICC_PROFILE_INVALID");
const ORIENT_MEMORY_FAILED = containerConstant("ORIENT_MEMORY_FAILED");
const ORIENT_UNCHANGED = containerConstant("ORIENT_UNCHANGED");
const FORMAT_NAMES = new Map([
  ["FORMAT_UNKNOWN", "unknown"], ["FORMAT_JPEG", "jpeg"], ["FORMAT_PNG", "png"], ["FORMAT_WEBP", "webp"],
  ["FORMAT_JXL", "jxl"], ["FORMAT_SVG", "svg"], ["FORMAT_XML", "xml"],
].map(([constant, name]) => [containerConstant(constant), name]));

let container = null;
function exports() {
  container ??= imageContainerBinary.instantiate({}).exports;
  return container;
}

function input(module, bytes) {
  const pointer = module.input_buffer(bytes.length);
  if (pointer === 0) {
    throw new Error(`image container: the module could not grow its memory for ${bytes.length} input bytes`);
  }
  new Uint8Array(module.memory.buffer, pointer, bytes.length).set(bytes);
}

// "jpeg", "png", "webp", "jxl", "svg" (an SVG document; the caller decodes
// the bytes as UTF-8), "xml" (other bytes that open with "<") or "unknown".
export function imageFormat(bytes) {
  const module = exports();
  input(module, bytes);
  return FORMAT_NAMES.get(module.image_format(bytes.length));
}

// The media type of the bytes ("image/jpeg", ..., "image/svg+xml"), or
// null for XML and unknown bytes.
export function imageMediaType(bytes) {
  const module = exports();
  input(module, bytes);
  const length = module.image_media_type(module.image_format(bytes.length));
  if (length === 0) return null;
  return new TextDecoder().decode(new Uint8Array(module.memory.buffer, module.output_address(), length));
}

// The error of operation `operation` for bytes no decoder takes.
export function unrecognizedImageError(operation, bytes) {
  const module = exports();
  input(module, bytes);
  const length = module.unrecognized_message(bytes.length);
  return new Error(`${operation}: ${new TextDecoder().decode(new Uint8Array(module.memory.buffer, module.message_address(), length))}`);
}

// The JPEG's embedded ICC profile, or null.
export function jpegIccProfile(bytes) {
  const module = exports();
  input(module, bytes);
  const status = module.jpeg_icc_profile(bytes.length);
  if (status === ICC_PROFILE_ABSENT) return null;
  if (status === ICC_PROFILE_INVALID) {
    throw new Error(new TextDecoder().decode(
      new Uint8Array(module.memory.buffer, module.message_address(), module.message_length()),
    ));
  }
  return new Uint8Array(new Uint8Array(module.memory.buffer, module.output_address(), module.output_length()));
}

// The JPEG's Exif orientation, 1 through 8.
export function jpegExifOrientation(bytes) {
  const module = exports();
  input(module, bytes);
  return module.jpeg_exif_orientation(bytes.length);
}

// RGBA8 pixels in Exif orientation `orientation`: { width, height, pixels }.
export function orientPixels(pixels, width, height, orientation) {
  const module = exports();
  input(module, pixels);
  const status = module.orient(width, height, orientation);
  if (status === ORIENT_UNCHANGED) return { width, height, pixels };
  if (status === ORIENT_MEMORY_FAILED) {
    throw new Error(`image container: the module could not grow its memory to orient ${width} x ${height} pixels`);
  }
  return {
    width: module.output_width(),
    height: module.output_height(),
    pixels: new Uint8Array(new Uint8Array(module.memory.buffer, module.output_address(), module.output_length())),
  };
}
