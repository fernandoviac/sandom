// CanvasRenderingContext2D of a Sandom document (plans/dom/PLAN-canvas-2d.md,
// slice 2; docs/specifications/canvas-2d.md).
//
// This object is a facade. It converts and validates arguments as Chrome's
// bindings do and forwards them to core/build/canvas-2d.wat, which holds the
// drawing state, the save stack and the command list. Drawing records
// commands and does no GPU work. A flush rasterizes the pending commands
// into the bitmap texture (renderer-core, src/dom/canvas-gpu-binding.js) when paint samples
// the canvas, when another canvas draws this one, and when toBlob() reads
// it.
//
// The bitmap is a texture on the device that first flushes it: the
// renderer's device for a painted canvas. A canvas that has no bitmap when
// another canvas draws it is copied as its command list; the destination
// rasterizes that list on its own device. Thus a canvas that is never
// painted needs no device of its own.
//
// A flush prepares CPU glyph fields and submits its commands synchronously.
// Copies take their place in native queue order before this call returns.
// GPU completion for a synchronous read is delivered from the GPU thread.
import {
  canvasGlyphRun,
  canvasTextEnvironment,
  DIRECTIONS,
  FONT_KERNINGS,
  FONT_STRETCHES,
  FONT_VARIANT_CAPS,
  layoutCanvasText,
  measureCanvasText,
  readTextState,
  TEXT_ALIGNS,
  TEXT_BASELINES,
  TEXT_RENDERINGS,
  textPlacement,
} from "./canvas-2d-text.js";
import * as canvas2dBinary from "../wasm/canvas-2d-binary.js";
import {
  BITMAP_FORMAT,
  BITMAP_FORMATS,
  bytesPerPixel,
  COMMAND_SIZE,
  copyBitmapTexture,
  createBitmapTexture,
  rasterizeCommands,
  readCanvasEncodingPixels,
  readCanvasImageData,
  registerSandomImageSources,
} from "./canvas-gpu-binding.js";
import { isCanvasPaint, PAINT_DEFINITION } from "./canvas-2d-paint.js";
import { createGradient } from "./canvas-2d-gradient.js";
import { CanvasPattern, createCanvasPattern } from "./canvas-2d-pattern.js";
import { matrixFromInit } from "./canvas-2d-matrix-init.js";
import { encodeJpegRgbaWithCompletion, initializeJpegEncoder } from "../output/jpeg-encoder.js";
import { defaultPngCodec } from "../png-codec.js";
import { imageCanvasSource } from "./images.js";
import { buildDisplayP3Profile } from "../output/icc-profile.js";
import { createDefaultGpuDeviceSync, getDefaultGpu } from "../gpu-thread.js";
import { layoutConstant, moduleLayoutConstants } from "../wasm/layout-table.js";
import * as outputFormatsBinary from "../wasm/output-formats-binary.js";
import { callOutputFormats, encodeText } from "../output/format-policy.js";

const canvasCoreConstant = moduleLayoutConstants(canvas2dBinary, "canvas 2d");
const SPACING_LETTER = canvasCoreConstant("SPACING_LETTER");
const PATH_SLOT_CURRENT = canvasCoreConstant("PATH_SLOT_CURRENT");
const PATH_SLOT_PATH2D = canvasCoreConstant("PATH_SLOT_PATH2D");
const SPACING_WORD = canvasCoreConstant("SPACING_WORD");
const SOURCE_CONVERSION_NONE = canvasCoreConstant("SOURCE_CONVERSION_NONE");

// The source color space conversion (source_conversion of canvas core
// `core`) of `source` (a resolved image source, or { colorSpace } of an
// ImageData) drawn into a canvas of `colorSpace`.
function sourceConversion(core, source, colorSpace) {
  return core.source_conversion(source.kind === "image" ? 1 : 0, source.colorSpace === "display-p3" ? 1 : 0,
    colorSpace === "display-p3" ? 1 : 0);
}
// The records this facade exchanges with the canvas core and the DOM core,
// by WAT name.
const CANVAS_CORE = Object.freeze(Object.fromEntries([
  "GRADIENT_STOP_SIZE", "GRADIENT_STOP_OFFSET", "GRADIENT_STOP_LEGACY", "GRADIENT_STOP_COLOR", "GRADIENT_STOP_OKLAB",
  "GRADIENT_STOP_OKLAB_PADDING", "PATH_DATA_SIZE", "CURRENT_TRANSFORM_COUNT", "GEOMETRY_VERTEX_SIZE",
  "PAINT_VECTOR_SIZE", "TEXT_RUN_HEADER_SIZE", "TEXT_RUN_FONT", "TEXT_RUN_COUNT", "TEXT_RUN_FONT_SIZE", "TEXT_RUN_OBLIQUE",
  "TEXT_GLYPH_SIZE", "TEXT_GLYPH_X", "TEXT_GLYPH_Y", "TEXT_GLYPH_ID", "OUTLINE_HEADER_SIZE", "OUTLINE_X", "OUTLINE_Y",
  "OUTLINE_OBLIQUE", "OUTLINE_LENGTH", "OUTLINE_FONT_SIZE", "OUTLINE_UPEM",
].map((name) => [name, canvasCoreConstant(name)])));
const F32 = Float32Array.BYTES_PER_ELEMENT;
const DOM_CORE = Object.freeze(Object.fromEntries([
  "COLOR_RGBA_R", "COLOR_RGBA_G", "COLOR_RGBA_B", "COLOR_RGBA_A", "COLOR_RGBA_SIZE",
  "CANVAS_COLOR_SIZE", "CANVAS_COLOR_PARSED", "CANVAS_COLOR_DRAWN",
  "CANVAS_FONT_SIZE", "CANVAS_FONT_WEIGHT", "CANVAS_FONT_SLOPE", "CANVAS_FONT_STYLE", "CANVAS_FONT_CAPS",
  "CANVAS_FONT_STRETCH", "CANVAS_FONT_FAMILY_OFFSET", "CANVAS_FONT_SERIALIZATION",
  "CANVAS_SPACING_NUMBER", "CANVAS_SPACING_UNIT", "CANVAS_SPACING_SERIALIZATION",
].map((name) => [name, layoutConstant(name)])));
// The r, g, b and a of the COLOR_RGBA record at `offset` of `view`.
function colorComponents(view, offset) {
  return [DOM_CORE.COLOR_RGBA_R, DOM_CORE.COLOR_RGBA_G, DOM_CORE.COLOR_RGBA_B, DOM_CORE.COLOR_RGBA_A]
    .map((field) => view.getFloat64(offset + field, true));
}

// Synchronous toBlob/toDataURL encoding needs initialized codecs. A realm
// that cannot read a codec (a restricted worker, a bundle without the
// vendor files) still loads this module; encoding then reports the failure.
await Promise.all([defaultPngCodec.initialize(), initializeJpegEncoder()]).catch(() => {});

// The ImageBitmap and OffscreenCanvas modules (src/dom/canvas-image-bitmap.js,
// src/dom/offscreen-canvas.js) import this one and register how they
// recognize their objects, so this module has no import cycle with them.
// Until a module loads, no object of its kind exists.
let imageBitmapState = () => undefined;
let offscreenCanvasState = () => undefined;

export function registerImageBitmapState(state) {
  imageBitmapState = state;
}

export function registerOffscreenCanvasState(state) {
  offscreenCanvasState = state;
}

const INTERFACE = "CanvasRenderingContext2D";
// The renderer core's codes that this file passes, by the names of their
// WAT globals.
const RESOURCE_READY = layoutConstant("RESOURCE_READY");
const CANVAS_BITMAP_WIDTH = layoutConstant("CANVAS_BITMAP_WIDTH");
const CANVAS_BITMAP_HEIGHT = layoutConstant("CANVAS_BITMAP_HEIGHT");
const CLIP_ENTRY_SIZE = canvasCoreConstant("CLIP_ENTRY_SIZE");
const MASK_SIZE = canvasCoreConstant("MASK_SIZE");
const DASH_CAPACITY = canvasCoreConstant("DASH_CAPACITY");
const PATH_NEGATIVE_RADIUS_X = canvasCoreConstant("PATH_NEGATIVE_RADIUS_X");
const PATH_NEGATIVE_RADIUS_Y = canvasCoreConstant("PATH_NEGATIVE_RADIUS_Y");
const PATH_RADII_COUNT = canvasCoreConstant("PATH_RADII_COUNT");
// The results of the canvas core's exports.
const RESULT_DONE = canvasCoreConstant("RESULT_DONE");
const RESULT_FULL = canvasCoreConstant("RESULT_FULL");
const RESULT_UNSUPPORTED = canvasCoreConstant("RESULT_UNSUPPORTED");
const GRADIENT_LINEAR = canvasCoreConstant("GRADIENT_LINEAR");
const GRADIENT_CONICAL = canvasCoreConstant("GRADIENT_CONICAL");
const GRADIENT_SWEEP = canvasCoreConstant("GRADIENT_SWEEP");
const GRADIENT_NEGATIVE_R0 = canvasCoreConstant("GRADIENT_NEGATIVE_R0");
export const EXPORT_TAINTED = canvasCoreConstant("EXPORT_TAINTED");
export const EXPORT_EMPTY = canvasCoreConstant("EXPORT_EMPTY");
const IMAGE_DATA_TAINTED = canvasCoreConstant("IMAGE_DATA_TAINTED");
// The canvas core's ImageBitmap geometry (canvas-2d-layer.watpart).
export const BITMAP = Object.freeze(Object.fromEntries([
  "CROP_WIDTH_ZERO", "CROP_HEIGHT_ZERO", "RESIZE_ZERO", "SOURCE_WIDTH_ZERO", "SOURCE_HEIGHT_ZERO", "NO_NATURAL_SIZE",
  "WHOLE", "DERIVED",
].map((name) => [name, canvasCoreConstant(`BITMAP_${name}`)])));
const BITMAP_DERIVED = BITMAP.DERIVED;
const BITMAP_CROP_X = canvasCoreConstant("BITMAP_CROP_X");
const BITMAP_CROP_Y = canvasCoreConstant("BITMAP_CROP_Y");
const BITMAP_CROP_WIDTH = canvasCoreConstant("BITMAP_CROP_WIDTH");
const BITMAP_CROP_HEIGHT = canvasCoreConstant("BITMAP_CROP_HEIGHT");
const BITMAP_WIDTH = canvasCoreConstant("BITMAP_WIDTH");
const BITMAP_HEIGHT = canvasCoreConstant("BITMAP_HEIGHT");
const FILTER_STAGE_FILTER = canvasCoreConstant("FILTER_STAGE_FILTER");
const FILTER_STAGE_SHADOW = canvasCoreConstant("FILTER_STAGE_SHADOW");
const FILTER_BLOCK_DRAW = canvasCoreConstant("FILTER_BLOCK_DRAW");
const FILTER_BLOCK_SHADOW = canvasCoreConstant("FILTER_BLOCK_SHADOW");
const FILTER_SHADOW = Object.freeze(Object.fromEntries(["OFFSET_X", "OFFSET_Y", "DEVIATION", "COLOR", "SIZE"]
  .map((name) => [name, canvasCoreConstant(`FILTER_SHADOW_${name}`)])));
// The canvas core's ImageData shapes and regions (canvas-2d-core.watpart).
const IMAGE_DATA_NO_ELEMENTS = canvasCoreConstant("IMAGE_DATA_NO_ELEMENTS");
const IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_FOUR = canvasCoreConstant("IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_FOUR");
const IMAGE_DATA_WIDTH_ZERO = canvasCoreConstant("IMAGE_DATA_WIDTH_ZERO");
const IMAGE_DATA_HEIGHT_ZERO = canvasCoreConstant("IMAGE_DATA_HEIGHT_ZERO");
const IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_ROW = canvasCoreConstant("IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_ROW");
const IMAGE_DATA_HEIGHT_MISMATCH = canvasCoreConstant("IMAGE_DATA_HEIGHT_MISMATCH");
const IMAGE_DATA_TOO_LARGE = canvasCoreConstant("IMAGE_DATA_TOO_LARGE");
const IMAGE_DATA_FORMAT_MISMATCH = canvasCoreConstant("IMAGE_DATA_FORMAT_MISMATCH");
const IMAGE_DATA_FORM_DATA = canvasCoreConstant("IMAGE_DATA_FORM_DATA");
const IMAGE_DATA_FORM_SIZE = canvasCoreConstant("IMAGE_DATA_FORM_SIZE");
const IMAGE_DATA_FORM_CREATE = canvasCoreConstant("IMAGE_DATA_FORM_CREATE");
const IMAGE_DATA_RGBA_UNORM8 = canvasCoreConstant("IMAGE_DATA_RGBA_UNORM8");
const IMAGE_DATA_RGBA_FLOAT16 = canvasCoreConstant("IMAGE_DATA_RGBA_FLOAT16");
const IMAGE_DATA_SHAPE_WIDTH = canvasCoreConstant("IMAGE_DATA_SHAPE_WIDTH");
const IMAGE_DATA_SHAPE_HEIGHT = canvasCoreConstant("IMAGE_DATA_SHAPE_HEIGHT");
const IMAGE_DATA_SHAPE_LENGTH = canvasCoreConstant("IMAGE_DATA_SHAPE_LENGTH");
const IMAGE_DATA_REGION_WIDTH = canvasCoreConstant("IMAGE_DATA_REGION_WIDTH");
const IMAGE_DATA_REGION_HEIGHT = canvasCoreConstant("IMAGE_DATA_REGION_HEIGHT");
const IMAGE_DATA_REGION_SIZE = canvasCoreConstant("IMAGE_DATA_REGION_SIZE");
const PUT_IMAGE_DATA = Object.freeze(Object.fromEntries(["SOURCE_X", "SOURCE_Y", "WIDTH", "HEIGHT"]
  .map((name) => [name, canvasCoreConstant(`PUT_IMAGE_DATA_${name}`)])));
const DRAW_IMAGE_FORMS = Object.freeze({
  3: canvasCoreConstant("DRAW_IMAGE_AT"),
  5: canvasCoreConstant("DRAW_IMAGE_SCALED"),
  9: canvasCoreConstant("DRAW_IMAGE_CROPPED"),
});
// The DOM core's canvas color and filter statuses.
const CANVAS_COLOR_LEGACY = layoutConstant("CANVAS_COLOR_LEGACY");
const CANVAS_COLOR_CURRENT = layoutConstant("CANVAS_COLOR_CURRENT");
const CANVAS_COLOR_NEEDS_CURRENT = layoutConstant("CANVAS_COLOR_NEEDS_CURRENT");
const CANVAS_FILTER_NONE = layoutConstant("CANVAS_FILTER_NONE");
const CANVAS_FILTER_UNSUPPORTED = layoutConstant("CANVAS_FILTER_UNSUPPORTED");
const CANVAS_FILTER_NEEDS_ROOT_FONT_SIZE = layoutConstant("CANVAS_FILTER_NEEDS_ROOT_FONT_SIZE");
const CONSTRUCTION = Symbol("CanvasRenderingContext2D construction");
const IMAGE_DATA_CONSTRUCTION = Symbol("ImageData construction");
const STYLE_FILL = canvasCoreConstant("STYLE_FILL");
const STYLE_STROKE = canvasCoreConstant("STYLE_STROKE");
const STYLE_SHADOW = canvasCoreConstant("STYLE_SHADOW");
const CANVAS_ENCODING_PNG = moduleLayoutConstants(outputFormatsBinary, "output formats")("CANVAS_ENCODING_PNG");
// The [[TypedArrayName]] of a typed array of any realm: a page script's
// array belongs to the document's realm, not to Sandom's.
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
).get;

// WebAssembly has no trigonometry; the core imports these (arcs, SVG arcs,
// round joins).
const CORE_IMPORTS = Object.freeze({
  math: Object.freeze({
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, acos: Math.acos, cbrt: Math.cbrt,
  }),
});

function instantiateCore() {
  return new WebAssembly.Instance(canvas2dBinary.getModule(), CORE_IMPORTS).exports;
}

function notSupported(member, detail = "this member") {
  return new DOMException(`${member}: Sandom does not support ${detail}`, "NotSupportedError");
}

function requireArguments(member, required, actual) {
  if (actual < required) {
    throw new TypeError(
      `${INTERFACE}.${member}: ${required} argument${required === 1 ? "" : "s"} required, but only ${actual} present.`,
    );
  }
}

// WebIDL `double` arguments, converted in order: the first value that is
// not finite throws.
function finiteArguments(member, values) {
  return values.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${INTERFACE}.${member}: The provided double value is non-finite.`);
    return number;
  });
}

// WebIDL `long`: ToInt32 of the number.
function toLong(value) {
  return Number(value) | 0;
}

// WebIDL `[EnforceRange] long`.
function toEnforcedLong(member, value) {
  const number = +value;
  if (!Number.isFinite(number)) {
    throw new TypeError(`${INTERFACE}.${member}: Value is not of type 'long'.`);
  }
  const integer = Math.trunc(number);
  if (integer < -2147483648 || integer > 2147483647) {
    throw new TypeError(`${INTERFACE}.${member}: Value is outside the 'long' value range.`);
  }
  return integer;
}

function enumValue(member, name, value, values, fallback) {
  if (value === undefined) return fallback;
  const text = String(value);
  if (!values.includes(text)) {
    throw new TypeError(
      `${member}: The provided value '${text}' is not a valid enum value for ${name}.`,
    );
  }
  return text;
}

// CanvasRenderingContext2DSettings, read in dictionary order. A value that
// is not an object gives the defaults, as in Chrome. Chrome 151 validates
// toneMapping.mode and keeps "standard": getContextAttributes() reports
// it for { mode: "extended" } too.
export function convertCanvas2DSettings(options, member = "HTMLCanvasElement.getContext") {
  const source = options !== null && (typeof options === "object" || typeof options === "function")
    ? options
    : {};
  const alpha = source.alpha === undefined ? true : Boolean(source.alpha);
  const colorSpace = enumValue(member, "colorSpace", source.colorSpace, ["srgb", "display-p3"], "srgb");
  const colorType = enumValue(member, "colorType", source.colorType, ["unorm8", "float16"], "unorm8");
  const desynchronized = Boolean(source.desynchronized);
  const toneMappingSource = source.toneMapping;
  if (toneMappingSource !== undefined && toneMappingSource !== null) {
    if (typeof toneMappingSource !== "object" && typeof toneMappingSource !== "function") {
      throw new TypeError(`${member}: toneMapping is not an object.`);
    }
    enumValue(member, "toneMapping.mode", toneMappingSource.mode, ["standard", "extended"], "standard");
  }
  const willReadFrequently = enumValue(
    member,
    "willReadFrequently",
    source.willReadFrequently,
    ["true", "false", "undefined"],
    "undefined",
  ) === "true";
  return Object.freeze({ alpha, colorSpace, colorType, desynchronized, toneMapping: "standard", willReadFrequently });
}

// ------------------------------------------------------------------ ImageData

let isImageData;

// The ImageData pixelFormat values and the typed array of each, by the
// canvas core's IMAGE_DATA_RGBA_* code.
const PIXEL_FORMATS = Object.freeze({
  [IMAGE_DATA_RGBA_UNORM8]: Object.freeze({ name: "rgba-unorm8", array: "Uint8ClampedArray", create: (length) => new Uint8ClampedArray(length) }),
  [IMAGE_DATA_RGBA_FLOAT16]: Object.freeze({ name: "rgba-float16", array: "Float16Array", create: (length) => new Float16Array(length) }),
});
const pixelFormatCode = (name) => Number(Object.keys(PIXEL_FORMATS).find((code) => PIXEL_FORMATS[code].name === name));
const arrayFormatCode = (array) => Object.keys(PIXEL_FORMATS).find((code) => PIXEL_FORMATS[code].array === array);

// The shape of an ImageData from the canvas core (image_data_shape), with
// Blink's error for each failure: { width, height, length }.
function imageDataShape(member, form, width, hasHeight, height, length = 0, arrayFormat = 0, pixelFormat = 0) {
  const core = builder();
  const result = core.image_data_shape(form, width, hasHeight, height, length, arrayFormat, pixelFormat);
  if (result === RESULT_DONE) {
    const view = new DataView(builderMemory.buffer, core.output_pointer(), IMAGE_DATA_SHAPE_LENGTH + 8);
    return {
      width: view.getFloat64(IMAGE_DATA_SHAPE_WIDTH, true),
      height: view.getFloat64(IMAGE_DATA_SHAPE_HEIGHT, true),
      length: view.getFloat64(IMAGE_DATA_SHAPE_LENGTH, true),
    };
  }
  const failures = {
    [IMAGE_DATA_FORMAT_MISMATCH]: [
      `${PIXEL_FORMATS[arrayFormat].array} must use ${PIXEL_FORMATS[arrayFormat].name} pixelFormat.`, "InvalidStateError"],
    [IMAGE_DATA_NO_ELEMENTS]: ["The input data has zero elements.", "IndexSizeError"],
    [IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_FOUR]: ["The input data length is not a multiple of 4.", "InvalidStateError"],
    [IMAGE_DATA_WIDTH_ZERO]: ["The source width is zero or not a number.", "IndexSizeError"],
    [IMAGE_DATA_HEIGHT_ZERO]: ["The source height is zero or not a number.", "IndexSizeError"],
    [IMAGE_DATA_LENGTH_NOT_MULTIPLE_OF_ROW]: ["The input data length is not a multiple of (4 * width).", "IndexSizeError"],
    [IMAGE_DATA_HEIGHT_MISMATCH]: ["The input data length is not equal to (4 * width * height).", "IndexSizeError"],
  };
  if (result === IMAGE_DATA_TOO_LARGE) throw new RangeError(`${member}: Out of memory at ImageData creation.`);
  const [text, name] = failures[result];
  throw new DOMException(`${member}: ${text}`, name);
}

export class ImageData {
  #width;
  #height;
  #data;
  #colorSpace;
  #pixelFormat;

  constructor(first, second, third, fourth, fifth, sixth) {
    if (first === IMAGE_DATA_CONSTRUCTION) {
      this.#width = second;
      this.#height = third;
      this.#data = fourth;
      this.#colorSpace = fifth;
      this.#pixelFormat = sixth;
      return;
    }
    const count = arguments.length;
    if (count < 2) {
      throw new TypeError(`ImageData: 2 arguments required, but only ${count} present.`);
    }
    if (ArrayBuffer.isView(first)) {
      const arrayFormat = arrayFormatCode(Reflect.apply(typedArrayName, first, []));
      if (arrayFormat === undefined) {
        throw notSupported("ImageData", "pixel data other than a Uint8ClampedArray or a Float16Array");
      }
      const width = Number(second) >>> 0;
      const height = third === undefined ? 0 : Number(third) >>> 0;
      const settings = imageDataSettings(fourth);
      const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
      const shape = imageDataShape("ImageData", IMAGE_DATA_FORM_DATA, width, third !== undefined, height, first.length,
        Number(arrayFormat), pixelFormatCode(pixelFormat));
      this.#width = shape.width;
      this.#height = shape.height;
      this.#data = first;
      this.#colorSpace = settings.colorSpace ?? "srgb";
      this.#pixelFormat = pixelFormat;
      return;
    }
    const width = Number(first) >>> 0;
    const height = Number(second) >>> 0;
    const settings = imageDataSettings(third);
    const shape = imageDataShape("ImageData", IMAGE_DATA_FORM_SIZE, width, true, height);
    this.#width = shape.width;
    this.#height = shape.height;
    this.#pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    this.#data = allocateImageData(shape, this.#pixelFormat);
    this.#colorSpace = settings.colorSpace ?? "srgb";
  }

  get width() {
    return this.#width;
  }

  get height() {
    return this.#height;
  }

  get data() {
    return this.#data;
  }

  get colorSpace() {
    return this.#colorSpace;
  }

  get pixelFormat() {
    return this.#pixelFormat;
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "ImageData", configurable: true });
    isImageData = (value) => value !== null && typeof value === "object" && #width in value;
  }
}

// The color space and pixel format that `settings` (ImageDataSettings)
// names; each is undefined when the settings do not name it.
function imageDataSettings(settings) {
  if (settings === undefined || settings === null) return { colorSpace: undefined, pixelFormat: undefined };
  if (typeof settings !== "object" && typeof settings !== "function") {
    throw new TypeError("ImageData: settings is not an object.");
  }
  const colorSpaceValue = settings.colorSpace;
  const colorSpace = colorSpaceValue === undefined
    ? undefined
    : enumValue("ImageData", "colorSpace", colorSpaceValue, ["srgb", "display-p3"], "srgb");
  const pixelFormatValue = settings.pixelFormat;
  const pixelFormat = pixelFormatValue === undefined
    ? undefined
    : enumValue("ImageData", "pixelFormat", pixelFormatValue, Object.values(PIXEL_FORMATS).map((format) => format.name),
      "rgba-unorm8");
  return { colorSpace, pixelFormat };
}

// The typed array of `shape` (imageDataShape) in `pixelFormat`.
function allocateImageData(shape, pixelFormat) {
  return PIXEL_FORMATS[pixelFormatCode(pixelFormat)].create(shape.length);
}

// The putImageData() payload of `data` (`imageData`'s data, or a region of
// it, `width` x `height`): its bytes and their texture format.
function imageDataPayload(imageData, data, width, height) {
  const format = imageData.pixelFormat === "rgba-float16" ? BITMAP_FORMATS.float16 : BITMAP_FORMAT;
  return { width, height, format, bytes: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
}

// ------------------------------------------------------------------ DOMMatrix

// The value of getTransform(): the 2D members of Chrome's DOMMatrix.
class SandomDOMMatrix {
  #values;

  constructor(values) {
    this.#values = values;
  }

  get a() {
    return this.#values[0];
  }
  get b() {
    return this.#values[1];
  }
  get c() {
    return this.#values[2];
  }
  get d() {
    return this.#values[3];
  }
  get e() {
    return this.#values[4];
  }
  get f() {
    return this.#values[5];
  }
  get m11() {
    return this.#values[0];
  }
  get m12() {
    return this.#values[1];
  }
  get m13() {
    return 0;
  }
  get m14() {
    return 0;
  }
  get m21() {
    return this.#values[2];
  }
  get m22() {
    return this.#values[3];
  }
  get m23() {
    return 0;
  }
  get m24() {
    return 0;
  }
  get m31() {
    return 0;
  }
  get m32() {
    return 0;
  }
  get m33() {
    return 1;
  }
  get m34() {
    return 0;
  }
  get m41() {
    return this.#values[4];
  }
  get m42() {
    return this.#values[5];
  }
  get m43() {
    return 0;
  }
  get m44() {
    return 1;
  }
  get is2D() {
    return true;
  }
  get isIdentity() {
    const [a, b, c, d, e, f] = this.#values;
    return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
  }
  toFloat64Array() {
    const [a, b, c, d, e, f] = this.#values;
    return new Float64Array([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]);
  }
  toFloat32Array() {
    return new Float32Array(this.toFloat64Array());
  }
  toJSON() {
    const result = {};
    for (
      const name of [
        "a", "b", "c", "d", "e", "f", "m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24",
        "m31", "m32", "m33", "m34", "m41", "m42", "m43", "m44", "is2D", "isIdentity",
      ]
    ) {
      result[name] = this[name];
    }
    return result;
  }
  toString() {
    return `matrix(${this.#values.join(", ")})`;
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "DOMMatrix", configurable: true });
  }
}

// ------------------------------------------------------------ CanvasPath
//
// The building methods that CanvasRenderingContext2D and Path2D share
// (HTML "CanvasPath"). They convert the arguments as Chrome's bindings do,
// throw Chrome's errors, and forward to the core, which builds the path.

const FILL_RULES = ["nonzero", "evenodd"];

function fillRuleValue(member, value) {
  if (value === undefined) return 0;
  const text = String(value);
  const index = FILL_RULES.indexOf(text);
  if (index < 0) {
    throw new TypeError(`${member}: The provided value '${text}' is not a valid enum value of type CanvasFillRule.`);
  }
  return index;
}

// The core's result of a path call. A negative radius throws Blink's
// error for the member, with the radius in single precision that the core
// reports.
function pathResult(member, result, core = null, memory = null, count = 0) {
  if (result === RESULT_FULL) throw new RangeError(`${member}: the path cannot grow`);
  if (result >= 0) return;
  if (result === PATH_RADII_COUNT) {
    throw new RangeError(`${member}: ${count} radii provided. Between one and four radii are necessary.`);
  }
  const radius = new Float64Array(memory.buffer, core.output_pointer(), 1)[0];
  if (member.endsWith(".roundRect")) {
    const label = result === PATH_NEGATIVE_RADIUS_X ? "X-radius value"
      : result === PATH_NEGATIVE_RADIUS_Y ? "Y-radius value" : "Radius value";
    throw new RangeError(`${member}: ${label} ${radius} is negative.`);
  }
  const label = result === PATH_NEGATIVE_RADIUS_X ? "major-axis radius"
    : result === PATH_NEGATIVE_RADIUS_Y ? "minor-axis radius" : "radius";
  throw new DOMException(`${member}: The ${label} provided (${radius}) is negative.`, "IndexSizeError");
}

// Writes the roundRect radii (a (unrestricted double or DOMPointInit) or a
// sequence of them) into the core's import buffer as the core reads them
// (round_rect): 1 and the point's x and y, or 0 and the number. Returns
// their count.
function writeRoundRectRadii(member, core, memory, radii) {
  let list;
  if (radii === undefined) list = [0];
  else if (radii !== null && typeof radii === "object" && typeof radii[Symbol.iterator] === "function") list = [...radii];
  else list = [radii];
  const entries = list.flatMap((radius) =>
    radius !== null && typeof radius === "object"
      ? [1, Number(radius.x ?? 0), Number(radius.y ?? 0)]
      : [0, Number(radius), 0]
  );
  if (entries.length === 0) return 0;
  const pointer = core.import_buffer(entries.length * Float64Array.BYTES_PER_ELEMENT);
  if (pointer === 0) throw new RangeError(`${member}: the path cannot grow`);
  new Float64Array(memory.buffer, pointer, entries.length).set(entries);
  return list.length;
}

// One CanvasPath call on `core`: `name` and the converted `values`.
function buildPath(interfaceName, core, memory, name, values) {
  const member = `${interfaceName}.${name}`;
  const numbers = values.map(Number);
  switch (name) {
    case "closePath":
      return pathResult(member, core.close_path());
    case "moveTo":
      return pathResult(member, core.move_to(numbers[0], numbers[1]));
    case "lineTo":
      return pathResult(member, core.line_to(numbers[0], numbers[1]));
    case "quadraticCurveTo":
      return pathResult(member, core.quadratic_curve_to(...numbers.slice(0, 4)));
    case "bezierCurveTo":
      return pathResult(member, core.bezier_curve_to(...numbers.slice(0, 6)));
    case "arcTo":
      return pathResult(member, core.arc_to(...numbers.slice(0, 5)), core, memory);
    case "rect":
      return pathResult(member, core.rect(...numbers.slice(0, 4)));
    case "roundRect": {
      const count = writeRoundRectRadii(member, core, memory, values[4]);
      return pathResult(member, core.round_rect(...numbers.slice(0, 4), count), core, memory, count);
    }
    case "arc":
      return pathResult(member, core.arc(...numbers.slice(0, 5), values[5] ? 1 : 0), core, memory);
    case "ellipse":
      return pathResult(member, core.ellipse(...numbers.slice(0, 7), values[7] ? 1 : 0), core, memory);
  }
  throw new Error(`${member}: unknown path call`);
}

// The CanvasPath methods with their required argument counts.
const CANVAS_PATH_METHODS = Object.freeze({
  closePath: 0,
  moveTo: 2,
  lineTo: 2,
  quadraticCurveTo: 4,
  bezierCurveTo: 6,
  arcTo: 5,
  rect: 4,
  roundRect: 4,
  arc: 5,
  ellipse: 7,
});

// --------------------------------------------------------------- Path2D
//
// A Path2D keeps its path as the core's transport bytes (the slot header
// and the verb stream). One core instance in the realm builds every
// Path2D: the Path2D it last built stays in that core's slot 0, so a run of
// calls on one Path2D copies nothing. A context imports the bytes into its
// own core's slot 1 for a fill, stroke, clip or hit test, unless that slot
// already holds this Path2D unchanged (its version counts its changes), so
// the core keeps the path's flattening between calls.

let builderCore = null;
let builderMemory = null;
let residentPath = null;
let path2DBytes;
let path2DVersion;
let isPath2D;

function builder() {
  if (builderCore === null) {
    builderCore = instantiateCore();
    builderMemory = builderCore.memory;
    builderCore.context_reset(false);
  }
  return builderCore;
}

// The definition words of a gradient in a canvas of `colorSpace`
// (gradient_definition, core/engine/canvas-2d-gradient.watpart), computed in
// the shared builder core: the stops are written as records of 64 bytes,
// the offset (f64), 1 for a legacy sRGB color (i32 at 8), the color, the
// OKLab stop and the OKLab padding (f32 at 16, 32 and 48).
function gradientWords(kind, geometry, stops, colorSpace) {
  const core = builder();
  const pointer = core.gradient_stops(stops.length);
  if (pointer === 0) throw new RangeError("CanvasGradient: the gradient cannot grow");
  const view = new DataView(builderMemory.buffer, pointer, stops.length * CANVAS_CORE.GRADIENT_STOP_SIZE);
  stops.forEach((stop, index) => {
    const at = index * CANVAS_CORE.GRADIENT_STOP_SIZE;
    view.setFloat64(at + CANVAS_CORE.GRADIENT_STOP_OFFSET, stop.offset, true);
    view.setInt32(at + CANVAS_CORE.GRADIENT_STOP_LEGACY, stop.legacy ? 1 : 0, true);
    for (let component = 0; component < 4; component++) {
      view.setFloat32(at + CANVAS_CORE.GRADIENT_STOP_COLOR + component * F32, stop.color[component], true);
      view.setFloat32(at + CANVAS_CORE.GRADIENT_STOP_OKLAB + component * F32, stop.oklabColor[component], true);
      view.setFloat32(at + CANVAS_CORE.GRADIENT_STOP_OKLAB_PADDING + component * F32, stop.oklabPadding[component], true);
    }
  });
  const count = core.gradient_definition(kind, ...geometry, ...new Array(6 - geometry.length).fill(0),
    colorSpace === "display-p3");
  const words = core.gradient_words();
  return new Float32Array(builderMemory.buffer.slice(words, words + count * 4));
}

// The canvas core's gradient (src/dom/canvas-2d-gradient.js).
const GRADIENT_CORE = Object.freeze({
  offsetValid: (offset) => builder().gradient_stop_offset_valid(offset) === 1,
  words: gradientWords,
});

// The canvas core's pattern (src/dom/canvas-2d-pattern.js). A pattern whose
// transform the core cannot invert paints nothing and keeps no source in
// the flush.
const PATTERN_CORE = Object.freeze({
  matrixFromInit: (value, member) => matrixFromInit(value, member, builder()),
  words(context, source, width, height, repetition, matrix) {
    const core = builder();
    const invertible = core.pattern_inverse(...matrix) === 1;
    const inverse = Array.from(new Float64Array(builderMemory.buffer, core.output_pointer(), 6));
    const index = invertible ? context.addSource(source) : 0;
    const conversion = invertible ? sourceConversion(core, source, context.colorSpace()) : 0;
    const count = core.pattern_definition(invertible, repetition, index, conversion, width, height, ...inverse);
    const pointer = core.output_pointer();
    return new Float32Array(builderMemory.buffer.slice(pointer, pointer + count * Float32Array.BYTES_PER_ELEMENT));
  },
});

// The transport bytes of slot `slot` of `core`.
function exportPath(core, memory, slot) {
  const headerSize = core.path_header_size();
  const count = core.path_data_count(slot);
  const bytes = new Uint8Array(headerSize + count * CANVAS_CORE.PATH_DATA_SIZE);
  bytes.set(new Uint8Array(memory.buffer, core.path_header_pointer(slot), headerSize));
  if (count > 0) {
    bytes.set(new Uint8Array(memory.buffer, core.path_data_pointer(slot), count * CANVAS_CORE.PATH_DATA_SIZE), headerSize);
  }
  return bytes;
}

// Loads transport bytes (or an empty path for null) into slot `slot`.
function importPath(member, core, memory, slot, bytes) {
  if (bytes === null) {
    core.path_clear(slot);
    return;
  }
  const pointer = core.import_buffer(bytes.length);
  if (pointer === 0) throw new RangeError(`${member}: the path cannot grow`);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  pathResult(member, core.path_load(slot, bytes.length));
}

export class Path2D {
  #bytes = null;
  #version = 0;

  constructor(path = undefined) {
    if (path === undefined) return;
    if (isPath2D(path)) {
      this.#bytes = path2DBytes(path);
      return;
    }
    const text = String(path);
    const core = this.#resident();
    core.path_clear(PATH_SLOT_CURRENT);
    const encoded = new TextEncoder().encode(text);
    const pointer = core.import_buffer(encoded.length);
    if (pointer === 0) throw new RangeError("Path2D: the path cannot grow");
    new Uint8Array(builderMemory.buffer, pointer, encoded.length).set(encoded);
    pathResult("Path2D", core.parse_svg_path(encoded.length));
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "Path2D", configurable: true });
  }

  // Makes this path the builder's slot 0.
  #resident() {
    const core = builder();
    if (residentPath === this) return core;
    if (residentPath !== null) residentPath.#bytes = exportPath(core, builderMemory, PATH_SLOT_CURRENT);
    core.reset_transform();
    importPath("Path2D", core, builderMemory, PATH_SLOT_CURRENT, this.#bytes);
    residentPath = this;
    return core;
  }

  addPath(path, transform = undefined) {
    requireArgumentsOf("Path2D", "addPath", 1, arguments.length);
    if (!isPath2D(path)) throw new TypeError("Path2D.addPath: parameter 1 is not of type 'Path2D'.");
    const matrix = matrixFromInit(transform, "Path2D.addPath", builder());
    const bytes = path2DBytes(path);
    const core = this.#resident();
    this.#version++;
    importPath("Path2D.addPath", core, builderMemory, PATH_SLOT_PATH2D, bytes);
    pathResult("Path2D.addPath", core.path_add_path(...matrix));
  }

  static {
    isPath2D = (value) => value !== null && typeof value === "object" && #bytes in value;
    path2DBytes = (path) => (residentPath === path ? exportPath(builder(), builderMemory, PATH_SLOT_CURRENT) : path.#bytes);
    path2DVersion = (path) => path.#version;
    for (const [name, required] of Object.entries(CANVAS_PATH_METHODS)) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        writable: true,
        value: {
          [name](...values) {
            requireArgumentsOf("Path2D", name, required, values.length);
            const core = this.#resident();
            this.#version++;
            buildPath("Path2D", core, builderMemory, name, values);
          },
        }[name],
      });
    }
  }
}

function requireArgumentsOf(interfaceName, member, required, actual) {
  if (actual < required) {
    throw new TypeError(
      `${interfaceName}.${member}: ${required} argument${required === 1 ? "" : "s"} required, but only ${actual} present.`,
    );
  }
}

// ----------------------------------------------------------------- attributes

const IMAGE_SMOOTHING_QUALITIES = ["low", "medium", "high"];

// The enumerated text attributes: their values and their field in the
// core's text state (core/engine/canvas-2d-text.watpart).
const TEXT_ENUMS = Object.freeze({
  textAlign: { values: TEXT_ALIGNS, offset: canvasCoreConstant("TEXT_STATE_TEXT_ALIGN") },
  textBaseline: { values: TEXT_BASELINES, offset: canvasCoreConstant("TEXT_STATE_TEXT_BASELINE") },
  fontKerning: { values: FONT_KERNINGS, offset: canvasCoreConstant("TEXT_STATE_FONT_KERNING") },
  fontStretch: { values: FONT_STRETCHES, offset: canvasCoreConstant("TEXT_STATE_FONT_STRETCH") },
  fontVariantCaps: { values: FONT_VARIANT_CAPS, offset: canvasCoreConstant("TEXT_STATE_FONT_VARIANT_CAPS") },
  textRendering: { values: TEXT_RENDERINGS, offset: canvasCoreConstant("TEXT_STATE_TEXT_RENDERING") },
});
const TEXT_DIRECTION_OFFSET = canvasCoreConstant("TEXT_STATE_DIRECTION");
// Layouts of measured and drawn text kept for each context.
const TEXT_LAYOUT_CACHE_SIZE = 256;

const LINE_CAPS = ["butt", "round", "square"];
const LINE_JOINS = ["miter", "round", "bevel"];

// ------------------------------------------------------------ sources
//
// A drawImage() or pattern source (src/dom/canvas-gpu-binding.js,
// rasterizeCommands): a "texture", a "commands" list or a decoded "image".
// A source counts its references; a new source starts with none, and its
// first user retains it.

function retainSource(source) {
  source.references += 1;
  return source;
}

// Each immutable source owns its snapshot and any copies on other devices.
function releaseSource(source) {
  source.references -= 1;
  if (source.references > 0) return;
  if (source.kind === "texture") {
    source.texture.destroy();
  } else if (source.kind === "commands") {
    for (const nested of source.list.sources) releaseSource(nested);
  }
  for (const texture of source.textures?.values() ?? []) texture.destroy();
}

// Releases a source that no user retained.
function discardSource(source) {
  if (source.references > 0) return;
  source.references = 1;
  releaseSource(source);
}

// A pattern keeps its source until the pattern is collected.
const patternSources = new FinalizationRegistry(releaseSource);
// The paint styles that clear a canvas's origin-clean flag when a context
// takes them as its fill or stroke style, as Chrome does (Blink
// setFillStyle and setStrokeStyle): patterns of a source that was not
// origin-clean when the pattern was made (a tainted canvas, an image of an
// opaque response, an ImageBitmap of either).
const taintingPaints = new WeakSet();

// The source of a canvas whose bitmap is blank: one without a context, or
// a WebGPU canvas without a current texture. It is transparent black.
function blankSource(width, height) {
  const empty = new Uint8Array(0);
  return {
    kind: "commands",
    width,
    height,
    opaque: false,
    format: BITMAP_FORMAT,
    list: {
      bytes: empty,
      geometry: empty,
      clips: empty,
      masks: empty,
      maskGeometry: empty,
      paints: empty,
      sources: [],
      payloads: [],
      fonts: [],
    },
    references: 0,
  };
}

const IMAGE_SOURCE_TYPE =
  "(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)";

function isSandomCanvas(value) {
  return value !== null && typeof value === "object" && value.localName === "canvas" &&
    "_canvasContextType" in value;
}

function isSandomImage(value) {
  return value !== null && typeof value === "object" && value.localName === "img" &&
    value.namespaceURI === "http://www.w3.org/1999/xhtml" && "_coreHandle" in value;
}

// The Sandom element of a CanvasImageSource form that Sandom does not draw.
function unsupportedImageSource(value) {
  if (value === null || typeof value !== "object" || typeof value.localName !== "string") return null;
  if (!("_coreHandle" in value)) return null;
  if (value.localName === "video") return "an HTMLVideoElement source";
  if (value.localName === "image" && value.namespaceURI === "http://www.w3.org/2000/svg") {
    return "an SVGImageElement source";
  }
  return null;
}

// The texts of the errors that a source of each use throws, as Chrome
// words them: drawImage(), createPattern() ("draw", "pattern") and
// createImageBitmap() ("bitmap").
const SOURCE_ERRORS = Object.freeze({
  draw: {
    detached: "The image source is detached",
    canvasSize: "The image argument is a canvas element with a width or height of 0.",
    offscreenSize: "The image argument is an OffscreenCanvas element with a width or height of 0.",
  },
  bitmap: {
    detached: "The image source is not usable.",
    canvasSize: null,
    offscreenSize: null,
  },
});

// Whether a source of `width` x `height` has no pixels (export_check of
// the canvas core: a zero side).
function sourceEmpty(width, height) {
  return builder().export_check(width, height, true) === EXPORT_EMPTY;
}

function sizeError(member, use, width, kind) {
  const text = SOURCE_ERRORS[use === "bitmap" ? "bitmap" : "draw"][kind] ??
    `The image source's ${width === 0 ? "width" : "height"} is 0.`;
  return new DOMException(`${member}: ${text}`, "InvalidStateError");
}

// resolveImageSource() of an img whose request failed: each member throws
// its own InvalidStateError at its own step.
export const BROKEN_IMAGE = Symbol("broken image");

// A CanvasImageSource for `use` ("draw", "pattern" or "bitmap"), checked
// as Chrome checks it (HTML "check the usability of the image argument"):
// throws the error that Chrome throws for the source's size or a closed
// ImageBitmap; returns BROKEN_IMAGE for a broken img, null for an image
// that is not fully decodable (drawImage() draws nothing, createPattern()
// returns null), else { source, width, height, opaque, originClean,
// naturalDimensions } with `source` not yet retained. A value that is not a
// CanvasImageSource returns undefined. With `device` (a copy into a WebGPU
// texture), a 2D canvas without a bitmap first takes its bitmap there.
export function resolveImageSource(member, value, use, device = null) {
  if (isSandomCanvas(value)) {
    const { width, height } = value;
    if (sourceEmpty(width, height)) throw sizeError(member, use, width, "canvasSize");
    return canvasElementSource(value, width, height, device);
  }
  const offscreen = offscreenCanvasState(value);
  if (offscreen !== undefined) {
    const { width, height, context } = offscreen;
    if (sourceEmpty(width, height)) throw sizeError(member, use, width, "offscreenSize");
    return context === null ? blankImage(width, height) : contextImage(context, device);
  }
  const bitmap = imageBitmapState(value);
  if (bitmap !== undefined) {
    if (bitmap === null) {
      throw new DOMException(
        `${member}: ${SOURCE_ERRORS[use === "bitmap" ? "bitmap" : "draw"].detached}`,
        "InvalidStateError",
      );
    }
    return bitmap;
  }
  if (isSandomImage(value)) {
    const image = imageCanvasSource(value);
    if (image.state === "broken") return BROKEN_IMAGE;
    if (image.state !== "complete") return null;
    return {
      source: { kind: "image", image: image.entry, references: 0 },
      width: image.width,
      height: image.height,
      opaque: image.entry.descriptor.alphaMode === "opaque",
      originClean: !image.opaque,
      naturalDimensions: image.naturalDimensions,
    };
  }
  const unsupported = unsupportedImageSource(value);
  if (unsupported !== null) throw notSupported(member, unsupported);
  return undefined;
}

function blankImage(width, height) {
  return { source: blankSource(width, height), width, height, opaque: false, originClean: true, naturalDimensions: true };
}

// The image of a canvas element: its 2D context's bitmap, its WebGPU
// context's current texture, the bitmap of the OffscreenCanvas that
// controls a placeholder canvas, or the blank bitmap.
function canvasElementSource(canvas, width, height, device) {
  const type = canvas._canvasContextType;
  if (type === "2d") return contextImage(canvas._canvasContext, device);
  if (type === "placeholder") {
    const context = canvas._canvasContext.offscreenContext;
    return context === null ? blankImage(width, height) : contextImage(context, device);
  }
  if (type === "webgpu") {
    const frame = canvas._canvasContext._imageSource();
    if (frame !== null) return { source: frame, width: frame.width, height: frame.height, opaque: frame.opaque, originClean: true, naturalDimensions: true };
  }
  return blankImage(width, height);
}

// The document's canvas device. A render surface whose renderer is still
// starting publishes the renderer's device when it is ready; toBlob() waits
// for it rather than requesting a second device.
async function sessionDevice(document) {
  if (!document?._preferredCanvasDevice && document?._preferredCanvasDevicePending) {
    await document._preferredCanvasDevicePending;
  }
  if (document?._preferredCanvasDevice) return document._preferredCanvasDevice;
  const adapter = await getDefaultGpu()?.requestAdapter();
  if (document?._preferredCanvasDevice) return document._preferredCanvasDevice;
  if (!adapter) throw new Error("Canvas 2D toBlob: WebGPU has no adapter on this host");
  const device = await adapter.requestDevice();
  if (document?._preferredCanvasDevice) {
    device.destroy();
    return document._preferredCanvasDevice;
  }
  if (document) document._preferredCanvasDevice ??= device;
  return document?._preferredCanvasDevice ?? device;
}

// The file encoding of an export (canvas_encoding of the output formats
// module): { jpeg, type, quality in percent }. `quality` is `any`: only a
// number counts.
function encodingOptions(type, quality) {
  const hasType = type !== undefined;
  const hasQuality = typeof quality === "number";
  const { result, output } = callOutputFormats("canvas_encoding", [hasType, hasQuality ? quality : 0, hasQuality],
    [encodeText(hasType ? `${type}` : "")]);
  const jpeg = result !== CANVAS_ENCODING_PNG;
  return { jpeg, type: new TextDecoder().decode(output), quality: jpeg ? result : 0 };
}

function encodePixels(samples, width, height, colorSpace, encoding, operation) {
  const profile = colorSpace === "display-p3" ? buildDisplayP3Profile() : null;
  if (encoding.jpeg) {
    encodeJpegRgbaWithCompletion({ width, height, pixels: samples.pixels }, {
      quality: encoding.quality, ...(profile === null ? {} : { profile }),
    }, operation);
  } else {
    defaultPngCodec.encodeWithCompletion(samples.pixels, width, height, {
      bitDepth: samples.bitDepth,
      channelLayout: samples.channelLayout,
      ...(profile === null ? {} : {
        colorEncoding: { primaries: "display-p3", transferFunction: "srgb" }, profile,
      }),
    }, operation);
  }
}

function encodeTexture(device, texture, width, height, opaque, colorSpace, encoding, operation) {
  readCanvasEncodingPixels(device, texture, width, height, encoding.jpeg, opaque, {
    reply(samples) { encodePixels(samples, width, height, colorSpace, encoding, operation); },
    throw(error) { operation.throw(error); },
  });
}

function reportCallbackError(error) {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else queueMicrotask(() => {
    throw error;
  });
}

// The bitmap of a context as a CanvasImageSource (resolveImageSource),
// which the context's static block defines.
let contextImage;

// ------------------------------------------------------------ the context

export class CanvasRenderingContext2D {
  // The canvas whose bitmap this context draws: a canvas element, or the
  // host of an OffscreenCanvas (src/dom/offscreen-canvas.js), with the
  // element's internal members that the context reads. #publicCanvas is
  // the object of the `canvas` attribute.
  #canvas;
  #publicCanvas;
  #core;
  #memory;
  #settings;
  #resourceHandle;
  #sources = [];
  #payloads = [];
  // The fonts of the pending glyph runs (a run's command names its index)
  // and the index of each font.
  #fonts = [];
  #fontIndices = new Map();
  #bitmap = null;
  #clearBitmap = true;
  #dirty = false;
  #snapshot = null;
  #shutdown = false;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();
  // The Path2D in core slot 1 and its version, or null.
  #slotPath = null;
  #slotVersion = 0;
  // The paint styles (CanvasGradient, CanvasPattern) that the core's state
  // names by handle (core/engine/canvas-2d-paint.watpart), both ways.
  #paints = new Map();
  #paintHandles = new WeakMap();
  #nextPaintHandle = 1;
  #paintContext = Object.freeze({
    addSource: (source) => this.#addSource(source),
    colorSpace: () => this.#settings.colorSpace,
  });

  // The bitmap texture format of the colorType setting.
  get #format() {
    return BITMAP_FORMATS[this.#settings.colorType];
  }

  // The resolved filters (canvas_filter_resolve, src/dom-wasm/canvas-
  // filter.watpart) that the core's state names by handle
  // (core/engine/canvas-2d-filter.watpart): the text, the font sizes it
  // resolved against and its filter block. A handle
  // below 0 names a value without filter functions (none), kept for the
  // getter's text. #filterBlocks: the filter block of each handle drawn in
  // this flush.
  #filters = new Map();
  #nextFilterHandle = 1;
  #filterBlocks = new Map();
  // Text layouts by style and text (#layoutFor).
  #textLayouts = new Map();

  constructor(token, canvas, settings, resourceHandle, publicCanvas = canvas) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#canvas = canvas;
    this.#publicCanvas = publicCanvas;
    this.#settings = settings;
    this.#resourceHandle = resourceHandle;
    this.#core = instantiateCore();
    this.#memory = this.#core.memory;
    this.#core.context_reset(!settings.alpha);
    const core = canvas._domCore;
    const bitmapDevice = () => this.#bitmap?.device ?? null;
    this.paintSource = Object.freeze({
      kind: "canvas",
      sourceIdentifier: core.resourceId(resourceHandle),
      resourceHandle,
      get width() {
        return core.canvasResourceDimension(resourceHandle, CANVAS_BITMAP_WIDTH);
      },
      get height() {
        return core.canvasResourceDimension(resourceHandle, CANVAS_BITMAP_HEIGHT);
      },
      get revision() {
        return core.resourceContentGeneration(resourceHandle);
      },
      get readbackCount() {
        return 0;
      },
      get preferredDevice() {
        return bitmapDevice();
      },
      captureForRender: (targetDevice) => this.#captureForRender(targetDevice),
    });
    this.#updateResource(true);
  }

  get _resourceHandle() {
    return this.#resourceHandle;
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: INTERFACE, configurable: true });
  }

  get canvas() {
    return this.#publicCanvas;
  }

  getContextAttributes() {
    const settings = this.#settings;
    return {
      alpha: settings.alpha,
      colorSpace: settings.colorSpace,
      colorType: settings.colorType,
      desynchronized: settings.desynchronized,
      toneMapping: { mode: settings.toneMapping },
      willReadFrequently: settings.willReadFrequently,
    };
  }

  isContextLost() {
    void this.#core;
    return false;
  }

  // -------------------------------------------------------------- state

  save() {
    if (this.#core.save() < 0) throw new RangeError(`${INTERFACE}.save: the save stack cannot grow`);
  }

  restore() {
    this.#core.restore();
  }

  reset() {
    this.#discardCommands();
    this.#core.context_reset(!this.#settings.alpha);
    this.#slotPath = null;
    this.#paints.clear();
    this.#filters.clear();
    this.#clearBitmap = true;
    this.#recorded();
  }

  // ---------------------------------------------------------- transforms

  scale(x, y) {
    requireArguments("scale", 2, arguments.length);
    this.#core.scale(Number(x), Number(y));
  }

  rotate(angle) {
    requireArguments("rotate", 1, arguments.length);
    this.#core.rotate(Number(angle));
  }

  translate(x, y) {
    requireArguments("translate", 2, arguments.length);
    this.#core.translate(Number(x), Number(y));
  }

  transform(a, b, c, d, e, f) {
    requireArguments("transform", 6, arguments.length);
    this.#core.transform(Number(a), Number(b), Number(c), Number(d), Number(e), Number(f));
  }

  setTransform(...values) {
    const core = this.#core;
    if (values.length <= 1) {
      core.set_transform(...matrixFromInit(values[0], `${INTERFACE}.setTransform`, core));
      return;
    }
    if (values.length < 6) {
      throw new TypeError(`${INTERFACE}.setTransform: 6 arguments required, but only ${values.length} present.`);
    }
    core.set_transform(...values.slice(0, 6).map(Number));
  }

  getTransform() {
    const pointer = this.#core.transform_pointer();
    return new SandomDOMMatrix(Array.from(new Float64Array(this.#memory.buffer, pointer, CANVAS_CORE.CURRENT_TRANSFORM_COUNT)));
  }

  resetTransform() {
    this.#core.reset_transform();
  }

  // ---------------------------------------------------------- styles

  get globalAlpha() {
    return this.#core.global_alpha();
  }

  set globalAlpha(value) {
    this.#core.set_global_alpha(Number(value));
  }

  get lineWidth() {
    return this.#core.line_width();
  }

  set lineWidth(value) {
    this.#core.set_line_width(Number(value));
  }

  get lineCap() {
    return LINE_CAPS[this.#core.line_cap()];
  }

  set lineCap(value) {
    const index = LINE_CAPS.indexOf(String(value));
    if (index >= 0) this.#core.set_line_cap(index);
  }

  get lineJoin() {
    return LINE_JOINS[this.#core.line_join()];
  }

  set lineJoin(value) {
    const index = LINE_JOINS.indexOf(String(value));
    if (index >= 0) this.#core.set_line_join(index);
  }

  get miterLimit() {
    return this.#core.miter_limit();
  }

  set miterLimit(value) {
    this.#core.set_miter_limit(Number(value));
  }

  get lineDashOffset() {
    return this.#core.line_dash_offset();
  }

  set lineDashOffset(value) {
    this.#core.set_line_dash_offset(Number(value));
  }

  setLineDash(segments) {
    requireArguments("setLineDash", 1, arguments.length);
    if (segments === null || typeof segments !== "object" || typeof segments[Symbol.iterator] !== "function") {
      throw new TypeError(`${INTERFACE}.setLineDash: The provided value cannot be converted to a sequence.`);
    }
    const values = Array.from(segments, Number);
    const core = this.#core;
    const pointer = values.length === 0 ? -1 : core.import_buffer(values.length * Float64Array.BYTES_PER_ELEMENT);
    if (pointer === 0) throw new RangeError(`${INTERFACE}.setLineDash: the dash list cannot grow`);
    if (pointer > 0) new Float64Array(this.#memory.buffer, pointer, values.length).set(values);
    if (core.set_line_dash(values.length) === RESULT_UNSUPPORTED) {
      const length = new Int32Array(this.#memory.buffer, core.output_pointer(), 1)[0];
      throw notSupported(`${INTERFACE}.setLineDash`, `a dash list of ${length} values (at most ${DASH_CAPACITY})`);
    }
  }

  getLineDash() {
    const core = this.#core;
    return Array.from(new Float64Array(this.#memory.buffer, core.line_dash_pointer(), core.line_dash_count()));
  }

  get fillStyle() {
    return this.#style(STYLE_FILL);
  }

  set fillStyle(value) {
    this.#setStyle("fillStyle", STYLE_FILL, value);
  }

  get strokeStyle() {
    return this.#style(STYLE_STROKE);
  }

  set strokeStyle(value) {
    this.#setStyle("strokeStyle", STYLE_STROKE, value);
  }

  get shadowColor() {
    return this.#styleText(STYLE_SHADOW);
  }

  set shadowColor(value) {
    this.#setStyle("shadowColor", STYLE_SHADOW, value);
  }

  get shadowOffsetX() {
    return this.#core.shadow_offset_x();
  }

  set shadowOffsetX(value) {
    this.#core.set_shadow_offset_x(Number(value));
  }

  get shadowOffsetY() {
    return this.#core.shadow_offset_y();
  }

  set shadowOffsetY(value) {
    this.#core.set_shadow_offset_y(Number(value));
  }

  get shadowBlur() {
    return this.#core.shadow_blur();
  }

  set shadowBlur(value) {
    this.#core.set_shadow_blur(Number(value));
  }

  get globalCompositeOperation() {
    const length = this.#core.global_composite_operation();
    return this.#decoder.decode(new Uint8Array(this.#memory.buffer, this.#core.output_pointer(), length));
  }

  set globalCompositeOperation(value) {
    if (typeof value === "symbol") {
      throw new TypeError(
        "Failed to set the 'globalCompositeOperation' property on 'CanvasRenderingContext2D': Cannot convert a Symbol value to a string",
      );
    }
    this.#core.set_global_composite_operation(this.#input(this.#encoder.encode(String(value))));
  }

  get imageSmoothingEnabled() {
    return this.#core.image_smoothing_enabled() === 1;
  }

  set imageSmoothingEnabled(value) {
    this.#core.set_image_smoothing_enabled(value ? 1 : 0);
  }

  get imageSmoothingQuality() {
    return IMAGE_SMOOTHING_QUALITIES[this.#core.image_smoothing_quality()];
  }

  set imageSmoothingQuality(value) {
    const index = IMAGE_SMOOTHING_QUALITIES.indexOf(String(value));
    if (index >= 0) this.#core.set_image_smoothing_quality(index);
  }

  get filter() {
    const handle = this.#core.filter_handle();
    return handle === 0 ? "none" : this.#filters.get(handle).text;
  }

  // Chrome parses the value as the CSS filter property and ignores an
  // invalid value (Canvas2DRecorderContext::setFilter). The value resolves
  // against the canvas font when it is set.
  set filter(value) {
    if (value === null) return;
    const text = String(value);
    const core = this.#core;
    const handle = core.filter_handle();
    const fontSize = this.#filterFontSize();
    const current = handle === 0 ? null : this.#filters.get(handle);
    if (current !== null && current.text === text && current.fontSize === fontSize) return;
    const resolved = this.#resolveFilter(text, fontSize, null);
    if (resolved === null) return;
    if (this.#filters.size >= 32) {
      for (const old of this.#filters.keys()) {
        if (core.filter_handle_in_use(old) === 0) this.#filters.delete(old);
      }
    }
    const serial = this.#nextFilterHandle++;
    const next = (resolved.status & CANVAS_FILTER_NONE) !== 0 ? -serial : serial;
    this.#filters.set(next, Object.freeze({
      text,
      fontSize,
      rootFontSize: resolved.rootFontSize,
      words: resolved.words,
    }));
    core.set_filter_handle(next);
  }

  // The filter value resolved by the DOM core (canvas_filter_resolve):
  // { status, words, rootFontSize }, or null for an invalid value. The
  // root font size is null until the core asks for it. `shadow` appends
  // Blink's shadow-only drop shadow of the shadow parameters.
  #resolveFilter(text, fontSize, rootFontSize, shadow = null) {
    const dom = this.#canvas._domCore;
    for (;;) {
      const status = dom.status("canvas_filter_resolve", ...dom.input(text), fontSize, rootFontSize ?? NaN,
        rootFontSize !== null, this.#settings.colorSpace === "display-p3", shadow !== null,
        shadow?.offsetX ?? 0, shadow?.offsetY ?? 0, shadow?.deviation ?? 0, shadow?.color ?? 0);
      if (status === CANVAS_FILTER_NEEDS_ROOT_FONT_SIZE) {
        rootFontSize = this.#rootFontSize();
        continue;
      }
      if (status === CANVAS_FILTER_UNSUPPORTED) {
        throw notSupported(`${INTERFACE}.filter`, `the value ${text} (${dom.outputString("canvas_filter_resolve")})`);
      }
      if (status === 0) return null;
      const words = new Float32Array(dom.outputBytes("canvas_filter_resolve").buffer);
      return { status, words, rootFontSize };
    }
  }

  // The font size of the canvas font in pixels, for em.
  #filterFontSize() {
    return this.#textState().size;
  }

  // The root element's computed font size in pixels, for rem; NaN when the
  // canvas is outside a document or the document has no root element.
  #rootFontSize() {
    const document = this.#canvas.ownerDocument;
    const root = document?.documentElement;
    if (!root || !this.#canvas.isConnected) return NaN;
    return Number.parseFloat(document.getComputedStyle(root).fontSize);
  }

  // Writes the filter block of the current filter into this flush's
  // paints for the next draw, or names the block already written; with a
  // shadow, also the block of the shadow's layer: the filter, then Blink's
  // shadow-only drop shadow of the shadow parameters. The core plans which
  // blocks a draw stages (filter_stage_plan); `style` (STYLE_FILL,
  // STYLE_STROKE, or undefined for an image) tells it whether the paint is
  // a pattern.
  #stageFilter(style = undefined) {
    const core = this.#core;
    const handle = core.filter_handle();
    const paint = style === undefined ? 0 : core.paint_handle(style);
    const plan = core.filter_stage_plan(this.#paints.get(paint) instanceof CanvasPattern);
    const view = new DataView(this.#memory.buffer, core.output_pointer(), FILTER_SHADOW.SIZE);
    const shadow = (plan & FILTER_STAGE_SHADOW) === 0 ? null : {
      offsetX: view.getFloat64(FILTER_SHADOW.OFFSET_X, true),
      offsetY: view.getFloat64(FILTER_SHADOW.OFFSET_Y, true),
      deviation: view.getFloat64(FILTER_SHADOW.DEVIATION, true),
      color: view.getInt32(FILTER_SHADOW.COLOR, true),
    };
    const filter = (plan & FILTER_STAGE_FILTER) === 0 ? null : this.#filters.get(handle);
    if (filter !== null) {
      this.#stageFilterBlock(FILTER_BLOCK_DRAW, `${handle}`, () => filter.words);
    }
    if (shadow === null) return;
    const key = `${filter === null ? 0 : handle} ${shadow.offsetX} ${shadow.offsetY} ${shadow.deviation} ${shadow.color}`;
    this.#stageFilterBlock(FILTER_BLOCK_SHADOW, key, () =>
      this.#resolveFilter(filter?.text ?? "none", filter?.fontSize ?? 0, filter?.rootFontSize ?? null, shadow).words);
  }

  // Names the filter block `key` of this flush for the next draw ($which
  // FILTER_BLOCK_DRAW) or its shadow (FILTER_BLOCK_SHADOW), writing its
  // words first when the flush has none.
  #stageFilterBlock(which, key, words) {
    const core = this.#core;
    const block = this.#filterBlocks.get(key);
    if (block !== undefined) {
      core.filter_reuse(which, block);
      return;
    }
    const values = words();
    const first = core.paint_count();
    const pointer = core.filter_block(which, values.length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}: the filter cannot grow`);
    new Float32Array(this.#memory.buffer, pointer, values.length).set(values);
    this.#filterBlocks.set(key, first + 1);
  }

  // The fill or stroke style: its paint object, or its color's text.
  #style(which) {
    const handle = this.#core.paint_handle(which);
    return handle === 0 ? this.#styleText(which) : this.#paints.get(handle);
  }

  #styleText(which) {
    const length = this.#core.style_text(which);
    return this.#decoder.decode(new Uint8Array(this.#memory.buffer, this.#core.output_pointer(), length));
  }

  // The canvas color of `text` (canvas_color_resolve): { color (the parsed
  // encoded sRGB), draw ([r, g, b, a] at Chrome's precision in the
  // canvas's color space), text (the getter's serialization: Chrome's for
  // a color outside the legacy sRGB forms; a legacy one serializes from
  // its 8-bit components), legacy }, or null when `text` is not a color.
  // The core asks for the canvas element's color when the text names
  // currentcolor.
  #resolveColor(text) {
    const core = this.#canvas._domCore;
    const displayP3 = this.#settings.colorSpace === "display-p3";
    let status = core.status("canvas_color_resolve", ...core.input(text), false, NaN, NaN, NaN, NaN, displayP3);
    if (status === CANVAS_COLOR_NEEDS_CURRENT) {
      const current = this.#currentColor();
      status = core.status("canvas_color_resolve", ...core.input(text), true, current.r, current.g, current.b, current.a,
        displayP3);
    }
    if (status === 0) return null;
    const view = core.output("canvas_color_resolve");
    const [r, g, b, a] = colorComponents(view, DOM_CORE.CANVAS_COLOR_PARSED);
    const color = { r, g, b, a };
    const draw = colorComponents(view, DOM_CORE.CANVAS_COLOR_DRAWN);
    const serialized = (status & CANVAS_COLOR_CURRENT) !== 0 ? text : core.parsedColorText() ?? text;
    return { color, draw, text: serialized, legacy: (status & CANVAS_COLOR_LEGACY) !== 0 };
  }

  // The canvas element's computed color; NaN components when the canvas
  // is outside a document or the element has no color the host can parse
  // (the core takes black).
  #currentColor() {
    const canvas = this.#canvas;
    const unknown = { r: NaN, g: NaN, b: NaN, a: NaN };
    if (!canvas.isConnected) return unknown;
    const computed = canvas.ownerDocument.getComputedStyle(canvas).color;
    const resolved = computed ? canvas._domCore.parseColor(computed) : null;
    return resolved === null || resolved === "currentColor" ? unknown : resolved;
  }

  #setStyle(member, which, value) {
    if (which !== STYLE_SHADOW && isCanvasPaint(value)) {
      this.#setPaint(which, value);
      return;
    }
    const text = String(value);
    const resolved = this.#resolveColor(text);
    if (resolved === null) return;
    const { color, draw } = resolved;
    const core = this.#core;
    const input = new Uint8Array(this.#memory.buffer, core.input_pointer(), core.input_capacity());
    const { written } = this.#encoder.encodeInto(resolved.text, input);
    // Draws use the color at Chrome's precision (currentcolor as a named
    // color), in the canvas's color space; the getter serializes the
    // parsed color.
    const result = core.set_style(which, color.r, color.g, color.b, color.a, draw[0], draw[1], draw[2], draw[3], written);
    if (result === RESULT_UNSUPPORTED) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
  }

  // Makes `paint` the fill or stroke style. A paint keeps one handle; the
  // handles that no state names any more are dropped as the table grows.
  #setPaint(which, paint) {
    let handle = this.#paintHandles.get(paint);
    if (handle === undefined || this.#paints.get(handle) !== paint) {
      if (this.#paints.size >= 32) {
        for (const old of this.#paints.keys()) {
          if (this.#core.paint_handle_in_use(old) === 0) this.#paints.delete(old);
        }
      }
      handle = this.#nextPaintHandle++;
      this.#paintHandles.set(paint, handle);
      this.#paints.set(handle, paint);
    }
    if (taintingPaints.has(paint)) this.#core.taint();
    this.#core.set_paint(which, handle);
  }

  // Stages the definition of the paint that a draw with the fill or stroke
  // style reads (src/dom/canvas-2d-paint.js).
  #stagePaint(which) {
    const core = this.#core;
    const handle = core.paint_handle(which);
    if (handle === 0) return;
    const words = this.#paints.get(handle)[PAINT_DEFINITION](this.#paintContext);
    const pointer = core.paint_stage(words.length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}: the paint cannot grow`);
    new Float32Array(this.#memory.buffer, pointer, words.length).set(words);
  }

  // A drawImage() or pattern source for this flush: its index in the
  // command list's sources.
  #addSource(source) {
    this.#sources.push(retainSource(source));
    return this.#sources.length - 1;
  }

  // ---------------------------------------------------------- gradients

  createLinearGradient(x0, y0, x1, y1) {
    void this.#core;
    requireArguments("createLinearGradient", 4, arguments.length);
    const geometry = finiteArguments("createLinearGradient", [x0, y0, x1, y1]);
    return createGradient(GRADIENT_LINEAR, geometry, this.#stopColorParser(), GRADIENT_CORE);
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    const core = this.#core;
    requireArguments("createRadialGradient", 6, arguments.length);
    const geometry = finiteArguments("createRadialGradient", [x0, y0, r0, x1, y1, r1]);
    const negative = core.gradient_negative_radius(geometry[2], geometry[5]);
    if (negative !== 0) {
      throw new DOMException(
        `${INTERFACE}.createRadialGradient: The ${negative === GRADIENT_NEGATIVE_R0 ? "r0" : "r1"} provided is less than 0.`,
        "IndexSizeError",
      );
    }
    return createGradient(GRADIENT_CONICAL, geometry, this.#stopColorParser(), GRADIENT_CORE);
  }

  createConicGradient(startAngle, x, y) {
    void this.#core;
    requireArguments("createConicGradient", 3, arguments.length);
    const geometry = finiteArguments("createConicGradient", [startAngle, x, y]);
    return createGradient(GRADIENT_SWEEP, geometry, this.#stopColorParser(), GRADIENT_CORE);
  }

  // A gradient stop color as Blink parses it (ParseCanvasColorString):
  // currentcolor is black, and the color has Chrome's precision in sRGB
  // (canvas_color_resolve). A color other than a legacy sRGB color makes
  // the gradient interpolate in OKLab, where Blink hands Skia each stop
  // converted to OKLab and back to sRGB (`oklabColor`), and the first
  // stop's own sRGB at offset 0 (`oklabPadding`; Gradient::FillSkiaStops).
  #stopColorParser() {
    const core = this.#canvas._domCore;
    return (text) => {
      const status = core.status("canvas_color_resolve", ...core.input(text), true, 0, 0, 0, 1, false);
      if (status === 0) return null;
      if ((status & CANVAS_COLOR_CURRENT) !== 0) {
        // Black is exact through OKLab.
        return { color: [0, 0, 0, 1], oklabColor: [0, 0, 0, 1], oklabPadding: [0, 0, 0, 1], legacy: true };
      }
      const view = core.output("canvas_color_resolve");
      const color = colorComponents(view, DOM_CORE.CANVAS_COLOR_DRAWN);
      const alpha = color[3];
      const { stop, own } = core.parsedOklabStop(color[0], color[1], color[2]);
      return { color, oklabColor: [...stop, alpha], oklabPadding: [...own, alpha], legacy: (status & CANVAS_COLOR_LEGACY) !== 0 };
    };
  }

  // -------------------------------------------------------- rectangles

  fillRect(x, y, width, height) {
    requireArguments("fillRect", 4, arguments.length);
    this.#stagePaint(STYLE_FILL);
    this.#stageFilter(STYLE_FILL);
    this.#record(this.#core.fill_rect(Number(x), Number(y), Number(width), Number(height)));
  }

  strokeRect(x, y, width, height) {
    requireArguments("strokeRect", 4, arguments.length);
    this.#stagePaint(STYLE_STROKE);
    this.#stageFilter(STYLE_STROKE);
    this.#record(this.#core.stroke_rect(Number(x), Number(y), Number(width), Number(height)));
  }

  clearRect(x, y, width, height) {
    requireArguments("clearRect", 4, arguments.length);
    this.#record(this.#core.clear_rect(Number(x), Number(y), Number(width), Number(height)));
  }

  // -------------------------------------------------------- pixel data

  createImageData(first, second, third) {
    requireArguments("createImageData", 1, arguments.length);
    if (arguments.length === 1) {
      if (!isImageData(first)) {
        throw new TypeError(`${INTERFACE}.createImageData: parameter 1 is not of type 'ImageData'.`);
      }
      const shape = imageDataShape(`${INTERFACE}.createImageData`, IMAGE_DATA_FORM_SIZE, first.width, true, first.height);
      return new ImageData(IMAGE_DATA_CONSTRUCTION, shape.width, shape.height,
        allocateImageData(shape, first.pixelFormat), first.colorSpace, first.pixelFormat);
    }
    const width = toLong(first);
    const height = toLong(second);
    // Without a color space in the settings, the data takes the canvas's,
    // as in Chrome; without a pixel format, rgba-unorm8, also on a float16
    // canvas (measured on Chrome 151).
    const settings = imageDataSettings(third);
    const shape = imageDataShape(`${INTERFACE}.createImageData`, IMAGE_DATA_FORM_CREATE, width, true, height);
    const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    return new ImageData(IMAGE_DATA_CONSTRUCTION, shape.width, shape.height, allocateImageData(shape, pixelFormat),
      settings.colorSpace ?? this.#settings.colorSpace, pixelFormat);
  }

  getImageData(sx, sy, sw, sh) {
    requireArguments("getImageData", 4, arguments.length);
    const values = [sx, sy, sw, sh].map((value) => toEnforcedLong("getImageData", value));
    const settings = imageDataSettings(arguments[4]);
    const intersects = this.#core.get_image_data_region(...values, this.#canvas.width, this.#canvas.height);
    if (intersects === IMAGE_DATA_WIDTH_ZERO || intersects === IMAGE_DATA_HEIGHT_ZERO) {
      throw new DOMException(
        `${INTERFACE}.getImageData: The source ${intersects === IMAGE_DATA_WIDTH_ZERO ? "width" : "height"} is 0.`,
        "IndexSizeError",
      );
    }
    if (intersects === IMAGE_DATA_TAINTED) {
      throw new DOMException(
        `${INTERFACE}.getImageData: The canvas has been tainted by cross-origin data.`,
        "SecurityError",
      );
    }
    const region = new Uint32Array(this.#memory.buffer, this.#core.output_pointer(),
      IMAGE_DATA_REGION_SIZE / Uint32Array.BYTES_PER_ELEMENT).slice();
    const regionView = new DataView(region.buffer);
    const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    const shape = imageDataShape(`${INTERFACE}.getImageData`, IMAGE_DATA_FORM_SIZE,
      regionView.getUint32(IMAGE_DATA_REGION_WIDTH, true), true, regionView.getUint32(IMAGE_DATA_REGION_HEIGHT, true));
    const imageData = new ImageData(IMAGE_DATA_CONSTRUCTION, shape.width, shape.height,
      allocateImageData(shape, pixelFormat), settings.colorSpace ?? this.#settings.colorSpace, pixelFormat);
    if (intersects === 0) return imageData;
    const document = this.#canvas.ownerDocument;
    const device = this.#bitmap?.device ?? document?._preferredCanvasDevice ?? createDefaultGpuDeviceSync();
    if (document) document._preferredCanvasDevice ??= device;
    this.#flush(device);
    let result;
    readCanvasImageData(device, this.#bitmap.texture, region, this.#settings.colorSpace, !this.#settings.alpha, imageData, {
      reply(value) { result = value; },
      throw(error) { throw error; },
    });
    return result;
  }

  putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight) {
    const count = arguments.length;
    requireArguments("putImageData", 3, count);
    if (count !== 3 && count < 7) {
      throw new TypeError(`${INTERFACE}.putImageData: 7 arguments required, but only ${count} present.`);
    }
    if (!isImageData(imageData)) {
      throw new TypeError(`${INTERFACE}.putImageData: parameter 1 is not of type 'ImageData'.`);
    }
    const member = "putImageData";
    const destinationX = toEnforcedLong(member, dx);
    const destinationY = toEnforcedLong(member, dy);
    const hasDirty = count !== 3;
    const region = hasDirty
      ? [dirtyX, dirtyY, dirtyWidth, dirtyHeight].map((value) => toEnforcedLong(member, value))
      : [0, 0, 0, 0];
    const data = imageData.data;
    if (data.buffer.detached) {
      throw new DOMException(`${INTERFACE}.putImageData: The source data has been detached.`, "InvalidStateError");
    }
    const core = this.#core;
    if (
      !core.put_image_data_region(imageData.width, imageData.height, destinationX, destinationY, hasDirty, ...region,
        this.#canvas.width, this.#canvas.height)
    ) return;
    const view = new DataView(this.#memory.buffer, core.output_pointer(), PUT_IMAGE_DATA.HEIGHT + 4);
    const sourceX = view.getInt32(PUT_IMAGE_DATA.SOURCE_X, true);
    const sourceY = view.getInt32(PUT_IMAGE_DATA.SOURCE_Y, true);
    const width = view.getInt32(PUT_IMAGE_DATA.WIDTH, true);
    const height = view.getInt32(PUT_IMAGE_DATA.HEIGHT, true);
    // The region's rows, copied out of the data's RGBA pixels.
    const shape = imageDataShape(`${INTERFACE}.putImageData`, IMAGE_DATA_FORM_SIZE, width, true, height);
    const pixels = allocateImageData(shape, imageData.pixelFormat);
    for (let row = 0; row < height; row++) {
      const start = ((sourceY + row) * imageData.width + sourceX) * 4;
      pixels.set(data.subarray(start, start + width * 4), row * width * 4);
    }
    // The bitmap stores the canvas's color space; the rasterizer converts
    // the data into it as it premultiplies, in single precision (sRGB red
    // put into a display-p3 canvas reads 234, 51, 35).
    const conversion = sourceConversion(core, { colorSpace: imageData.colorSpace }, this.#settings.colorSpace);
    const index = this.#payloads.length;
    const result = core.record_put_image_data(index, conversion);
    if (result === RESULT_DONE) this.#payloads.push(imageDataPayload(imageData, pixels, width, height));
    this.#record(result);
  }

  // ------------------------------------------------------------ images

  drawImage(image, ...values) {
    const count = arguments.length;
    const member = `${INTERFACE}.drawImage`;
    requireArguments("drawImage", 3, count);
    if (count !== 3 && count !== 5 && count !== 9) {
      throw new TypeError(`${member}: Overload resolution failed.`);
    }
    const resolved = resolveImageSource(member, image, "draw");
    if (resolved === undefined) {
      throw new TypeError(`${member}: The provided value is not of type '${IMAGE_SOURCE_TYPE}'.`);
    }
    if (resolved === BROKEN_IMAGE) {
      throw new DOMException(`${member}: The HTMLImageElement provided is in the 'broken' state.`, "InvalidStateError");
    }
    if (resolved === null) return;
    if (!resolved.originClean) this.#core.taint();
    const { source, width, height } = resolved;
    const index = this.#sources.length;
    this.#stageFilter();
    const conversion = sourceConversion(this.#core, source, this.#settings.colorSpace);
    const numbers = [...values.map(Number), ...new Array(9 - count).fill(0)];
    const result = this.#core.draw_image(index, resolved.opaque ? 1 : 0, conversion, width, height,
      DRAW_IMAGE_FORMS[count], ...numbers);
    if (result === RESULT_DONE) this.#sources.push(retainSource(source));
    else discardSource(source);
    this.#record(result);
  }

  // ---------------------------------------------------------- patterns

  // createPattern(image, repetition), in the order of Chrome's checks:
  // the source type and its size (a canvas or OffscreenCanvas of zero size,
  // a closed ImageBitmap), the repetition, then the source's state (a broken
  // image throws; an image that is not fully decodable or that has a zero
  // size gives null). The pattern takes the source's bitmap now.
  createPattern(image, repetition) {
    requireArguments("createPattern", 2, arguments.length);
    const member = `${INTERFACE}.createPattern`;
    const resolved = resolveImageSource(member, image, "pattern");
    if (resolved === undefined) {
      throw new TypeError(`${member}: The provided value is not of type '${IMAGE_SOURCE_TYPE}'.`);
    }
    const text = repetition === null ? "" : String(repetition);
    const tiles = this.#core.pattern_repetition(this.#input(this.#encoder.encode(text)));
    if (tiles < 0) {
      if (resolved !== null && resolved !== BROKEN_IMAGE) discardSource(resolved.source);
      throw new DOMException(
        `${member}: The provided type ('${text}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`,
        "SyntaxError",
      );
    }
    if (resolved === BROKEN_IMAGE) {
      throw new DOMException(`${member}: Source image is in the 'broken' state.`, "InvalidStateError");
    }
    if (resolved === null) return null;
    const { source, width, height } = resolved;
    if (sourceEmpty(width, height)) {
      discardSource(source);
      return null;
    }
    retainSource(source);
    const pattern = createCanvasPattern(source, width, height, tiles, PATTERN_CORE);
    patternSources.register(pattern, source);
    if (!resolved.originClean) taintingPaints.add(pattern);
    return pattern;
  }

  // ------------------------------------------------------- text state
  //
  // The text attributes live in the core's text state
  // (core/engine/canvas-2d-text.watpart); the DOM core parses the authored
  // values as Chrome does (canvas_font_parse, canvas_spacing_parse).

  #textState() {
    const pointer = this.#core.text_state_pointer();
    if (pointer === 0) throw new RangeError(`${INTERFACE}: the text state cannot grow`);
    return readTextState(this.#memory, pointer);
  }

  // Copies `parts` into the core's input area; returns their length, or
  // -1 beyond its capacity.
  #input(...parts) {
    const core = this.#core;
    const input = new Uint8Array(this.#memory.buffer, core.input_pointer(), core.input_capacity());
    let length = 0;
    for (const part of parts) {
      if (length + part.length > input.length) return -1;
      input.set(part, length);
      length += part.length;
    }
    return length;
  }

  get font() {
    const core = this.#core;
    const length = core.font_text();
    if (length === RESULT_FULL) throw new RangeError(`${INTERFACE}.font: the text state cannot grow`);
    return this.#decoder.decode(new Uint8Array(this.#memory.buffer, core.font_text_pointer(), length));
  }

  // Chrome ignores an authored string equal to the last one it took, and a
  // value that does not parse. A font sets fontVariantCaps and fontStretch
  // and converts the spacings again for its size.
  set font(value) {
    const member = `${INTERFACE}.font`;
    const text = `${value}`;
    const authored = this.#encoder.encode(text);
    const core = this.#core;
    if (core.font_unchanged(this.#input(authored)) === 1) return;
    const font = this.#parseFont(text);
    if (font === null) return;
    const state = this.#textState();
    const serialization = font.serialization;
    this.#input(serialization, authored);
    const result = core.set_font(
      serialization.length,
      font.familyOffset,
      authored.length,
      font.size,
      font.weight,
      font.slope,
      font.style,
      font.caps,
      font.stretch,
      this.#spacingPx(state.letterSpacing.number, state.letterSpacing.unit, font.size, true),
      this.#spacingPx(state.wordSpacing.number, state.wordSpacing.unit, font.size, true),
    );
    if (result === RESULT_FULL) throw new RangeError(`${member}: the text state cannot grow`);
    if (result === RESULT_UNSUPPORTED) throw notSupported(member, "a font of more than 1024 bytes");
  }

  // The font value as Chrome's canvas setter parses it (canvas_font_parse)
  // against the canvas element's font, the root font and the viewport:
  // { size, weight, slope, style, caps, stretch, familyOffset,
  // serialization (UTF-8, without small-caps) }, or null.
  #parseFont(text) {
    const environment = canvasTextEnvironment(this.#canvas);
    const dom = this.#canvas._domCore;
    const status = dom.status("canvas_font_parse", ...dom.input(text), environment.connected, environment.parentSize,
      environment.parentWeight, environment.rootSize, environment.viewport.width, environment.viewport.height);
    if (status === 0) return null;
    const bytes = dom.outputBytes("canvas_font_parse");
    const view = new DataView(bytes.buffer);
    return {
      size: view.getFloat64(DOM_CORE.CANVAS_FONT_SIZE, true),
      weight: view.getFloat64(DOM_CORE.CANVAS_FONT_WEIGHT, true),
      slope: view.getFloat64(DOM_CORE.CANVAS_FONT_SLOPE, true),
      style: view.getInt32(DOM_CORE.CANVAS_FONT_STYLE, true),
      caps: view.getInt32(DOM_CORE.CANVAS_FONT_CAPS, true),
      stretch: view.getInt32(DOM_CORE.CANVAS_FONT_STRETCH, true),
      familyOffset: view.getInt32(DOM_CORE.CANVAS_FONT_FAMILY_OFFSET, true),
      serialization: bytes.subarray(DOM_CORE.CANVAS_FONT_SERIALIZATION),
    };
  }

  // The px of a spacing for a font size (canvas_spacing_px).
  #spacingPx(number, unit, size, atFontChange) {
    return this.#canvas._domCore.status("canvas_spacing_px", number, unit, size, atFontChange ? 1 : 0);
  }

  // Chrome 151 reflects the resolved direction: "inherit" reads as the
  // canvas element's direction.
  get direction() {
    if (this.#core.text_direction_inherits() === 1) return DIRECTIONS[canvasTextEnvironment(this.#canvas).direction];
    return DIRECTIONS[this.#textState().direction];
  }

  set direction(value) {
    const index = DIRECTIONS.indexOf(`${value}`);
    if (index >= 0) this.#setTextEnum(TEXT_DIRECTION_OFFSET, index);
  }

  #setTextEnum(offset, index) {
    if (this.#core.set_text_enum(offset, index) === RESULT_FULL) {
      throw new RangeError(`${INTERFACE}: the text state cannot grow`);
    }
  }

  get letterSpacing() {
    return this.#textState().letterSpacingText;
  }

  set letterSpacing(value) {
    this.#setSpacing("letterSpacing", SPACING_LETTER, value);
  }

  get wordSpacing() {
    return this.#textState().wordSpacingText;
  }

  set wordSpacing(value) {
    this.#setSpacing("wordSpacing", SPACING_WORD, value);
  }

  // A spacing equal to the current serialization, a value that is not one
  // length, and the current number and unit change nothing.
  #setSpacing(member, which, value) {
    const text = `${value}`;
    const state = this.#textState();
    if (text === (which === 0 ? state.letterSpacingText : state.wordSpacingText)) return;
    const dom = this.#canvas._domCore;
    if (dom.status("canvas_spacing_parse", ...dom.input(text)) === 0) return;
    const bytes = dom.outputBytes("canvas_spacing_parse");
    const view = new DataView(bytes.buffer);
    const number = view.getFloat64(DOM_CORE.CANVAS_SPACING_NUMBER, true);
    const unit = view.getInt32(DOM_CORE.CANVAS_SPACING_UNIT, true);
    const serialization = bytes.subarray(DOM_CORE.CANVAS_SPACING_SERIALIZATION);
    if (this.#input(serialization) < 0) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
    const px = this.#spacingPx(number, unit, state.size, false);
    const result = this.#core.set_spacing(which, number, unit, px, serialization.length);
    if (result === RESULT_FULL) throw new RangeError(`${INTERFACE}.${member}: the text state cannot grow`);
    if (result === RESULT_UNSUPPORTED) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
  }

  get lang() {
    return this.#textState().lang;
  }

  set lang(value) {
    const text = `${value}`;
    if (text === this.#textState().lang) return;
    const bytes = this.#encoder.encode(text);
    const result = this.#core.set_lang(this.#input(bytes));
    if (result === RESULT_FULL) throw new RangeError(`${INTERFACE}.lang: the text state cannot grow`);
    if (result === RESULT_UNSUPPORTED) throw notSupported(`${INTERFACE}.lang`, "a lang of more than 256 bytes");
  }

  static {
    for (const [name, { values, offset }] of Object.entries(TEXT_ENUMS)) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        enumerable: true,
        get: {
          [name]() {
            return values[this.#textState()[name]];
          },
        }[name],
        set: {
          [name](value) {
            const index = values.indexOf(`${value}`);
            if (index >= 0) this.#setTextEnum(offset, index);
          },
        }[name],
      });
    }
  }

  // The resolved text style of the current state: the font, the spacings
  // in px, the direction and language the canvas element gives "inherit",
  // and the viewport for the measurement element.
  #textStyle() {
    const state = this.#textState();
    const environment = canvasTextEnvironment(this.#canvas);
    return {
      families: state.family,
      size: state.size,
      weight: state.weight,
      slope: state.slope,
      style: state.style,
      fontStretch: state.fontStretch,
      fontVariantCaps: state.fontVariantCaps,
      fontKerning: state.fontKerning,
      textRendering: state.textRendering,
      letterSpacingPx: state.letterSpacing.px,
      wordSpacingPx: state.wordSpacing.px,
      direction: this.#core.text_direction_inherits() === 1 ? environment.direction : state.direction,
      lang: this.#core.text_lang_inherits() === 1 ? environment.language : state.lang,
      textAlign: state.textAlign,
      textBaseline: state.textBaseline,
      viewport: environment.viewport,
    };
  }

  // The shaped text for `style`; the layout depends on the style's font,
  // spacings, direction and language and on the document's fonts.
  #layoutFor(style, text) {
    const document = this.#canvas.ownerDocument;
    const key = JSON.stringify([
      style.families, style.size, style.weight, style.slope, style.style, style.fontStretch, style.fontVariantCaps,
      style.fontKerning, style.textRendering, style.letterSpacingPx, style.wordSpacingPx, style.direction, style.lang,
      document._sandomFontRegistry?.revision ?? 0, document._domCore.status("resource_revision") >>> 0, text,
    ]);
    let layout = this.#textLayouts.get(key);
    if (layout === undefined) {
      layout = layoutCanvasText(this.#canvas, style, text);
      if (this.#textLayouts.size >= TEXT_LAYOUT_CACHE_SIZE) this.#textLayouts.delete(this.#textLayouts.keys().next().value);
      this.#textLayouts.set(key, layout);
    }
    return layout;
  }

  measureText(text) {
    requireArguments("measureText", 1, arguments.length);
    const string = `${text}`;
    const style = this.#textStyle();
    return measureCanvasText(this.#layoutFor(style, string), style);
  }

  // The glyph run that fillText() and strokeText() draw: its width, its
  // alignment factor (Chrome's textAlign with the resolved direction; with
  // a maxWidth below the width Chrome aligns maxWidth instead), the offset
  // of its alphabetic baseline from the given y, every glyph's origin and
  // font, and the layout for its bounds.
  #layoutText(text) {
    const style = this.#textStyle();
    const layout = this.#layoutFor(style, text);
    const placement = textPlacement(layout, style);
    const run = canvasGlyphRun(layout);
    return {
      layout,
      width: layout.width,
      alignFactor: placement.alignFactor,
      baselineY: placement.baselineY,
      glyphs: run.glyphs,
      fonts: run.fonts,
    };
  }

  // -------------------------------------------------------------- text
  //
  // fillText and strokeText draw the glyphs that #layoutText shapes
  // (src/dom/canvas-2d-text.js) with the fill or stroke style, as fill()
  // and stroke() draw a path; the core places them as Chrome does and
  // records them (canvas-2d-glyphs.watpart).

  fillText(text, x, y, maxWidth = undefined) {
    requireArguments("fillText", 3, arguments.length);
    this.#drawText("fillText", text, x, y, maxWidth);
  }

  strokeText(text, x, y, maxWidth = undefined) {
    requireArguments("strokeText", 3, arguments.length);
    this.#drawText("strokeText", text, x, y, maxWidth);
  }

  // WebIDL converts the arguments in order before the call; an undefined
  // maxWidth is absent.
  #drawText(member, text, x, y, maxWidth) {
    const string = `${text}`;
    const left = Number(x);
    const top = Number(y);
    const hasMaxWidth = maxWidth !== undefined;
    const width = hasMaxWidth ? Number(maxWidth) : 0;
    const layout = this.#layoutText(string);
    const metrics = layout.layout;
    const begun = this.#core.text_draw_begin(left, top, layout.alignFactor, layout.baselineY, layout.width, width,
      hasMaxWidth ? 1 : 0, metrics.ascent, metrics.descent, metrics.lineGap);
    if (begun !== 1) return;
    const style = member === "fillText" ? STYLE_FILL : STYLE_STROKE;
    this.#stagePaint(style);
    this.#stageFilter(style);
    if (style === STYLE_FILL) this.#fillGlyphs(layout);
    else this.#strokeGlyphs(layout);
  }

  // One glyph run for each font of the text, its glyphs in order, all in
  // one import buffer. Fonts that the flush does not list yet join its font
  // list when the draw records.
  #fillGlyphs(layout) {
    const core = this.#core;
    const { glyphs, fonts } = layout;
    const counts = new Uint32Array(fonts.length);
    for (const glyph of glyphs) counts[glyph.font] += 1;
    let length = 0;
    for (const count of counts) if (count > 0) length += CANVAS_CORE.TEXT_RUN_HEADER_SIZE + count * CANVAS_CORE.TEXT_GLYPH_SIZE;
    // Text without glyphs still draws (canvas-2d-glyphs.watpart, $textResult).
    const pointer = length === 0 ? -1 : core.import_buffer(length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}.fillText: the command list cannot grow`);
    const view = new DataView(this.#memory.buffer, Math.max(pointer, 0), length);
    const added = [];
    let at = 0;
    for (let font = 0; font < fonts.length; font++) {
      const count = counts[font];
      if (count === 0) continue;
      const descriptor = fonts[font];
      let reference = this.#fontIndices.get(descriptor);
      if (reference === undefined) {
        reference = this.#fonts.length + added.length;
        added.push(descriptor);
      }
      view.setUint32(at + CANVAS_CORE.TEXT_RUN_FONT, reference, true);
      view.setUint32(at + CANVAS_CORE.TEXT_RUN_COUNT, count, true);
      view.setFloat32(at + CANVAS_CORE.TEXT_RUN_FONT_SIZE, descriptor.fontSize, true);
      view.setUint32(at + CANVAS_CORE.TEXT_RUN_OBLIQUE, descriptor.syntheticOblique ? 1 : 0, true);
      at += CANVAS_CORE.TEXT_RUN_HEADER_SIZE;
      for (const glyph of glyphs) {
        if (glyph.font !== font) continue;
        view.setFloat32(at + CANVAS_CORE.TEXT_GLYPH_X, glyph.x, true);
        view.setFloat32(at + CANVAS_CORE.TEXT_GLYPH_Y, glyph.y, true);
        view.setUint32(at + CANVAS_CORE.TEXT_GLYPH_ID, glyph.id, true);
        at += CANVAS_CORE.TEXT_GLYPH_SIZE;
      }
    }
    const ink = layout.layout.ink;
    const result = core.fill_text(length, ink.x, ink.y, ink.width, ink.height);
    if (result === RESULT_DONE) {
      for (const descriptor of added) {
        this.#fontIndices.set(descriptor, this.#fonts.length);
        this.#fonts.push(descriptor);
      }
    }
    this.#record(result);
  }

  // The glyph outlines, each with its origin, its font size, its face's
  // units per em and whether it slants, stroked as one path. The outlines
  // take core path slot 1, so the Path2D that it held is imported again on
  // its next use.
  #strokeGlyphs(layout) {
    const { glyphs, fonts } = layout;
    const outlines = glyphs.map((glyph) => fonts[glyph.font].outline(glyph.id));
    let length = 0;
    for (const outline of outlines) length += CANVAS_CORE.OUTLINE_HEADER_SIZE + outline.length;
    const core = this.#core;
    const pointer = length === 0 ? -1 : core.import_buffer(length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}.strokeText: the path cannot grow`);
    const bytes = new Uint8Array(this.#memory.buffer, Math.max(pointer, 0), length);
    const view = new DataView(this.#memory.buffer, Math.max(pointer, 0), length);
    let at = 0;
    for (let index = 0; index < glyphs.length; index++) {
      const outline = outlines[index];
      const glyph = glyphs[index];
      const font = fonts[glyph.font];
      view.setFloat32(at + CANVAS_CORE.OUTLINE_X, glyph.x, true);
      view.setFloat32(at + CANVAS_CORE.OUTLINE_Y, glyph.y, true);
      view.setUint32(at + CANVAS_CORE.OUTLINE_OBLIQUE, font.syntheticOblique ? 1 : 0, true);
      view.setUint32(at + CANVAS_CORE.OUTLINE_LENGTH, outline.length, true);
      view.setFloat64(at + CANVAS_CORE.OUTLINE_FONT_SIZE, font.fontSize, true);
      view.setFloat64(at + CANVAS_CORE.OUTLINE_UPEM, font.upem, true);
      bytes.set(outline, at + CANVAS_CORE.OUTLINE_HEADER_SIZE);
      at += CANVAS_CORE.OUTLINE_HEADER_SIZE + outline.length;
    }
    this.#slotPath = null;
    this.#record(core.stroke_text(length));
  }

  // ------------------------------------------------------------- paths

  beginPath() {
    this.#core.path_clear(PATH_SLOT_CURRENT);
  }

  // The core slot of a fill, stroke, clip or hit test: the current path,
  // or the Path2D `path`, imported unless its slot holds it unchanged.
  #pathSlot(member, path) {
    if (path === null) return PATH_SLOT_CURRENT;
    if (path === this.#slotPath && path2DVersion(path) === this.#slotVersion) return PATH_SLOT_PATH2D;
    this.#slotPath = null;
    importPath(`${INTERFACE}.${member}`, this.#core, this.#memory, PATH_SLOT_PATH2D, path2DBytes(path));
    this.#slotPath = path;
    this.#slotVersion = path2DVersion(path);
    return PATH_SLOT_PATH2D;
  }

  fill(first = undefined, second = undefined) {
    const member = `${INTERFACE}.fill`;
    const path = isPath2D(first) ? first : null;
    const rule = fillRuleValue(member, path === null ? first : second);
    const slot = this.#pathSlot("fill", path);
    this.#stagePaint(STYLE_FILL);
    this.#stageFilter(STYLE_FILL);
    this.#record(this.#core.fill_path(slot, rule));
  }

  stroke(path = undefined) {
    if (path !== undefined && !isPath2D(path)) {
      throw new TypeError(`${INTERFACE}.stroke: parameter 1 is not of type 'Path2D'.`);
    }
    const slot = this.#pathSlot("stroke", path ?? null);
    this.#stagePaint(STYLE_STROKE);
    this.#stageFilter(STYLE_STROKE);
    this.#record(this.#core.stroke_path(slot));
  }

  clip(first = undefined, second = undefined) {
    const member = `${INTERFACE}.clip`;
    const path = isPath2D(first) ? first : null;
    const rule = fillRuleValue(member, path === null ? first : second);
    const result = this.#core.clip_path(this.#pathSlot("clip", path), rule);
    if (result === RESULT_FULL) throw new RangeError(`${member}: the clipping region cannot grow`);
  }

  isPointInPath(first, second, third = undefined, fourth = undefined) {
    requireArguments("isPointInPath", 2, arguments.length);
    const member = `${INTERFACE}.isPointInPath`;
    let result;
    if (isPath2D(first)) {
      requireArguments("isPointInPath", 3, arguments.length);
      const x = Number(second);
      const y = Number(third);
      const rule = fillRuleValue(member, fourth);
      result = this.#core.is_point_in_path(this.#pathSlot("isPointInPath", first), x, y, rule);
    } else {
      const x = Number(first);
      const y = Number(second);
      const rule = fillRuleValue(member, third);
      result = this.#core.is_point_in_path(0, x, y, rule);
    }
    if (result === RESULT_FULL) throw new RangeError(`${member}: the path cannot grow`);
    return result === RESULT_DONE;
  }

  isPointInStroke(first, second, third = undefined) {
    requireArguments("isPointInStroke", 2, arguments.length);
    const member = `${INTERFACE}.isPointInStroke`;
    let result;
    if (isPath2D(first)) {
      requireArguments("isPointInStroke", 3, arguments.length);
      result = this.#core.is_point_in_stroke(this.#pathSlot("isPointInStroke", first), Number(second), Number(third));
    } else {
      result = this.#core.is_point_in_stroke(0, Number(first), Number(second));
    }
    if (result === RESULT_FULL) throw new RangeError(`${member}: the path cannot grow`);
    return result === RESULT_DONE;
  }

  // drawFocusIfNeeded(element) and drawFocusIfNeeded(path, element): a
  // focused fallback element of this canvas draws the focus ring along
  // the path, as Chrome draws it.
  drawFocusIfNeeded(first, second = undefined) {
    requireArguments("drawFocusIfNeeded", 1, arguments.length);
    const withPath = arguments.length >= 2;
    if (withPath && !isPath2D(first)) {
      throw new TypeError(`${INTERFACE}.drawFocusIfNeeded: parameter 1 is not of type 'Path2D'.`);
    }
    const element = withPath ? second : first;
    if (element === null || typeof element !== "object" || element.nodeType !== 1) {
      throw new TypeError(
        `${INTERFACE}.drawFocusIfNeeded: parameter ${withPath ? 2 : 1} is not of type 'Element'.`,
      );
    }
    const canvas = this.#canvas;
    // An element of another DOM core is in another document: never this
    // canvas's descendant.
    if (element._domCore !== canvas._domCore) return;
    if (canvas._domCore.status("canvas_focus_ring_drawn", canvas._coreHandle, element._coreHandle) === 0) return;
    const core = this.#core;
    if (core.save() < 0) throw new RangeError(`${INTERFACE}.drawFocusIfNeeded: the save stack cannot grow`);
    try {
      this.#applyFocusRingStyle();
      this.#record(core.stroke_path(this.#pathSlot("drawFocusIfNeeded", withPath ? first : null)));
    } finally {
      core.restore();
    }
  }

  // The focus ring of Chrome 151: its color from the DOM core in the
  // canvas's color space, its stroke state from the canvas core.
  #applyFocusRingStyle() {
    const dom = this.#canvas._domCore;
    dom.status("canvas_focus_ring_color", this.#settings.colorSpace === "display-p3");
    const view = dom.output("canvas_focus_ring_color");
    this.#core.focus_ring_style(...colorComponents(view, DOM_CORE.CANVAS_COLOR_PARSED),
      ...colorComponents(view, DOM_CORE.CANVAS_COLOR_DRAWN));
  }

  // ------------------------------------------------------ path methods

  static {
    for (const [name, required] of Object.entries(CANVAS_PATH_METHODS)) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        writable: true,
        value: {
          [name](...values) {
            requireArguments(name, required, values.length);
            buildPath(INTERFACE, this.#core, this.#memory, name, values);
          },
        }[name],
      });
    }
  }

  // ----------------------------------------------------------- recording

  #record(result) {
    if (result === RESULT_FULL) throw new RangeError(`${INTERFACE}: the command list cannot grow`);
    if (result === RESULT_DONE) this.#recorded();
  }

  // The bitmap changes at the next flush: copies of the current state and
  // paint must see it.
  #recorded() {
    this.#dropSnapshot();
    if (this.#dirty) return;
    this.#dirty = true;
    this.#updateResource(true);
    this.#canvas._notifyCanvasPaint();
  }

  #dropSnapshot() {
    if (this.#snapshot === null) return;
    releaseSource(this.#snapshot);
    this.#snapshot = null;
  }

  #discardCommands() {
    this.#core.commands_clear();
    for (const source of this.#sources) releaseSource(source);
    this.#sources = [];
    this.#payloads = [];
    this.#filterBlocks.clear();
    this.#fonts = [];
    this.#fontIndices = new Map();
  }

  #updateResource(contentChanged) {
    const canvas = this.#canvas;
    canvas._domCore.resourceUpdate(this.#resourceHandle, RESOURCE_READY, canvas.width, canvas.height, contentChanged, 0);
  }

  // The pending commands as views of the core's memory: the command
  // records, the geometry of path commands and glyph runs, the clip
  // entries, the clip masks with their geometry, and the paint blocks.
  #commandList() {
    const core = this.#core;
    const buffer = this.#memory.buffer;
    return {
      bytes: new Uint8Array(buffer, core.command_pointer(), core.command_count() * COMMAND_SIZE),
      geometry: new Uint8Array(buffer, core.geometry_pointer(), core.geometry_count() * CANVAS_CORE.GEOMETRY_VERTEX_SIZE),
      clips: new Uint8Array(buffer, core.clip_entry_pointer(), core.clip_entry_count() * CLIP_ENTRY_SIZE),
      masks: new Uint8Array(buffer, core.mask_pointer(), core.mask_count() * MASK_SIZE),
      maskGeometry: new Uint8Array(buffer, core.mask_geometry_pointer(),
        core.mask_geometry_count() * CANVAS_CORE.GEOMETRY_VERTEX_SIZE),
      paints: new Uint8Array(buffer, core.paint_pointer(), core.paint_count() * CANVAS_CORE.PAINT_VECTOR_SIZE),
      sources: this.#sources,
      payloads: this.#payloads,
      fonts: this.#fonts,
    };
  }


  // Submitted GPU work retains the texture until its native use completes.
  #retireBitmap() {
    const bitmap = this.#bitmap;
    if (bitmap === null) return;
    this.#bitmap = null;
    bitmap.texture.destroy();
  }

  // A source for drawImage() and exports. Existing bitmaps flush and copy
  // synchronously; a canvas without a bitmap supplies its command list.
  #snapshotForCopy() {
    if (this.#snapshot !== null) return this.#snapshot;
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    let snapshot;
    if (this.#bitmap !== null) {
      const { device } = this.#bitmap;
      this.#flush(device);
      const bitmap = this.#bitmap;
      snapshot = {
        kind: "texture",
        device,
        texture: copyBitmapTexture(device, bitmap.texture, width, height),
        width,
        height,
        opaque: !this.#settings.alpha,
        colorSpace: this.#settings.colorSpace,
        format: this.#format,
        references: 1,
      };
    } else {
      const list = this.#commandList();
      snapshot = {
        kind: "commands",
        width,
        height,
        opaque: !this.#settings.alpha,
        colorSpace: this.#settings.colorSpace,
        format: this.#format,
        list: {
          bytes: list.bytes.slice(),
          geometry: list.geometry.slice(),
          clips: list.clips.slice(),
          masks: list.masks.slice(),
          maskGeometry: list.maskGeometry.slice(),
          paints: list.paints.slice(),
          sources: list.sources.map(retainSource),
          payloads: list.payloads.slice(),
          fonts: list.fonts.slice(),
        },
        references: 1,
      };
    }
    this.#snapshot = snapshot;
    return snapshot;
  }

  // A bitmap keeps its device. Consumers on another device read its source
  // through the GPU-thread transfer boundary.
  #flush(device) {
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    device = this.#bitmap?.device ?? device;
    if (this.#bitmap !== null && (this.#bitmap.width !== width || this.#bitmap.height !== height)) {
      this.#retireBitmap();
    }
    if (this.#bitmap === null) {
      const limit = device.limits.maxTextureDimension2D;
      if (width > limit || height > limit) {
        throw new RangeError(`Canvas 2D bitmap ${width}x${height} exceeds maxTextureDimension2D ${limit}`);
      }
      this.#bitmap = {
        device,
        width,
        height,
        texture: createBitmapTexture(device, width, height, this.#format),
      };
      this.#clearBitmap = true;
    }
    this.#dirty = false;
    const list = this.#commandList();
    if (list.bytes.length === 0 && !this.#clearBitmap) return;
    const target = {
      texture: this.#bitmap.texture,
      width,
      height,
      opaque: !this.#settings.alpha,
      colorSpace: this.#settings.colorSpace,
    };
    const clear = this.#clearBitmap;
    this.#clearBitmap = false;
    rasterizeCommands(device, target, list, clear);
    this.#discardCommands();
  }

  #captureForRender(targetDevice) {
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    const absent = this.#shutdown || width === 0 || height === 0;
    let source = null;
    if (!absent) {
      if (targetDevice === null) {
        throw new Error(
          "Canvas 2D paints only through the WebGPU renderer: the WebGL 2 renderer cannot sample the bitmap texture without a readback",
        );
      }
      this.#flush(targetDevice);
      source = Object.freeze({
        kind: "gpu-texture",
        width,
        height,
        device: this.#bitmap.device,
        texture: this.#bitmap.texture,
        format: this.#format,
        descriptor: Object.freeze({
          width,
          height,
          rowStride: width * bytesPerPixel(this.#format),
          channelLayout: "rgba",
          // A float16 bitmap holds half floats, also outside [0, 1].
          sampleType: this.#settings.colorType === "float16" ? "float16" : "uint8",
          bitsPerSample: this.#settings.colorType === "float16" ? 16 : 8,
          colorEncoding: Object.freeze({
            // The bitmap holds encoded components of the canvas's color
            // space; paint converts them into its working space.
            primaries: this.#settings.colorSpace,
            transferFunction: "srgb",
            whitePoint: "D65",
            referenceWhiteLuminance: 203,
          }),
          alphaMode: "premultiplied",
          canvasToneMapping: "standard",
          metadata: Object.freeze({}),
        }),
        toneMapping: "standard",
        // An opaque canvas is an opaque layer in Chrome: drawn to whole
        // pixels, its quad is composited without blending, so the stored
        // texel, alpha included, replaces the backdrop (measured on the
        // pinned Chrome 2026-10-12: stored [15, 60, 100, 128] over a white
        // page screenshots as [30, 120, 199, 128]). src/rasterize.js,
        // IMAGE_VARIANT_CONTENTS_OPAQUE.
        contentsOpaque: !this.#settings.alpha,
      });
    }
    const revision = this.paintSource.revision;
    return Object.freeze({
      readiness: absent ? "absent" : "ready",
      owner: source,
      width,
      height,
      bitmapRevision: revision,
      device: source?.device ?? null,
      resolve: () => Promise.resolve(source),
      release() {},
    });
  }

  // -------------------------------------------------- canvas element hooks

  resetBitmap(sizeChanged = true) {
    this.#canvas._domCore.canvasBitmapReset(
      this.#canvas._coreHandle,
      sizeChanged,
      (request) => this.#resetForBitmap(request),
    );
  }

  attributeChanged(name, namespaceURI, removed, wasPresent) {
    this.#canvas._domCore.canvasBitmapAttribute(
      this.#canvas._coreHandle,
      name,
      namespaceURI !== null,
      removed,
      wasPresent,
      (request) => this.#resetForBitmap(request),
    );
  }

  // A width or height assignment, also to the same value, resets the
  // bitmap and all state, and makes the canvas origin-clean again, as in
  // Chrome.
  #resetForBitmap(request) {
    this.#discardCommands();
    this.#dropSnapshot();
    this.#core.origin_clean_reset();
    this.#core.context_reset(!this.#settings.alpha);
    this.#slotPath = null;
    this.#paints.clear();
    this.#filters.clear();
    this.#retireBitmap();
    this.#clearBitmap = true;
    this.#dirty = false;
    this.#updateResource(true);
    if (request.sizeChanged) this.#canvas._notifyCanvasSize();
    else this.#canvas._notifyCanvasPaint();
  }

  // An OffscreenCanvas width or height assignment.
  _resetForSize() {
    this.#resetForBitmap({ sizeChanged: true });
  }

  // OffscreenCanvas.transferToImageBitmap(): the bitmap, with its pending
  // commands, goes to the ImageBitmap; the canvas starts a new blank (or
  // opaque black) bitmap and keeps the context's state and its
  // origin-clean flag (measured on the pinned Chrome).
  _transferImage() {
    const image = this.#image();
    retainSource(image.source);
    this.#discardCommands();
    this.#dropSnapshot();
    this.#retireBitmap();
    this.#clearBitmap = true;
    this.#dirty = false;
    this.#updateResource(true);
    this.#canvas._notifyCanvasPaint();
    return image;
  }

  // The bitmap as a CanvasImageSource (resolveImageSource). With `device`,
  // a canvas without a bitmap takes its bitmap on that device first, so
  // that later copies there draw only the commands after this one.
  #image(device = null) {
    if (device !== null && this.#bitmap === null && !this.#shutdown) {
      this.#dropSnapshot();
      this.#flush(device);
    }
    return {
      source: this.#snapshotForCopy(),
      width: this.#canvas.width,
      height: this.#canvas.height,
      opaque: !this.#settings.alpha,
      originClean: this.#core.origin_clean() === 1,
      naturalDimensions: true,
    };
  }

  static {
    contextImage = (context, device = null) => context.#image(device);
  }

  // The canvas core's check of an export of the bitmap (export_check):
  // RESULT_DONE, EXPORT_TAINTED or EXPORT_EMPTY.
  _exportCheck(ignoreTaint = false) {
    return this.#core.export_check(this.#canvas.width, this.#canvas.height, ignoreTaint);
  }

  // Asynchronous exports retain the bitmap state at the call boundary.
  _encodeBitmap(member, type, quality) {
    const encoding = encodingOptions(type, quality);
    const checked = this._exportCheck();
    if (checked === EXPORT_TAINTED) {
      throw new DOMException(`${member}: Tainted canvases may not be exported.`, "SecurityError");
    }
    if (checked === EXPORT_EMPTY) return Promise.resolve(null);
    const snapshot = retainSource(this.#snapshotForCopy());
    const document = this.#canvas.ownerDocument;
    return (async () => {
      try {
        const device = snapshot.kind === "texture" ? snapshot.device : await sessionDevice(document);
        let bytes;
        encodeSnapshot(snapshot, device, encoding, {
          reply(value) { bytes = value; },
          throw(error) { throw error; },
        });
        return new Blob([bytes], { type: encoding.type });
      } finally {
        releaseSource(snapshot);
      }
    })();
  }

  // HTMLCanvasElement.toBlob for this context.
  _toBlob(callback, type, quality) {
    const encoded = this._encodeBitmap("HTMLCanvasElement.toBlob", type, quality);
    void (async () => {
      let blob = null;
      try {
        blob = await encoded;
      } catch (error) {
        reportCallbackError(error);
      }
      try {
        callback.call(undefined, blob);
      } catch (error) {
        reportCallbackError(error);
      }
    })();
  }

  _toDataURL(encoding) {
    const checked = this._exportCheck();
    if (checked === EXPORT_TAINTED) {
      throw new DOMException("HTMLCanvasElement.toDataURL: Tainted canvases may not be exported.", "SecurityError");
    }
    if (checked === EXPORT_EMPTY) return "data:,";
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    const document = this.#canvas.ownerDocument;
    const device = this.#bitmap?.device ?? document?._preferredCanvasDevice ?? createDefaultGpuDeviceSync();
    if (document) document._preferredCanvasDevice ??= device;
    this.#flush(device);
    let bytes;
    encodeTexture(device, this.#bitmap.texture, width, height, !this.#settings.alpha, this.#settings.colorSpace, encoding, {
      reply(value) { bytes = value; },
      throw(error) { throw error; },
    });
    return `data:${encoding.type};base64,${bytes.toBase64()}`;
  }

  shutdown() {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#discardCommands();
    this.#dropSnapshot();
    this.#retireBitmap();
    // An OffscreenCanvas without a placeholder has no node.
    if (this.#canvas._coreHandle !== undefined) this.#canvas._domCore.resourceNodeDetach(this.#canvas._coreHandle);
    this.#canvas._domCore.resourceRelease(this.#resourceHandle);
  }
}

function encodeSnapshot(snapshot, device, encoding, operation) {
  const texture = snapshot.kind === "texture" ? snapshot.texture
    : createBitmapTexture(device, snapshot.width, snapshot.height, snapshot.format);
  try {
    if (snapshot.kind !== "texture") {
      rasterizeCommands(
        device,
        { texture, width: snapshot.width, height: snapshot.height, opaque: snapshot.opaque, colorSpace: snapshot.colorSpace },
        snapshot.list,
        true,
      );
    }
    encodeTexture(device, texture, snapshot.width, snapshot.height, snapshot.opaque, snapshot.colorSpace, encoding, operation);
  } finally {
    if (snapshot.kind !== "texture") texture.destroy();
  }
}

// ------------------------------------------------------ derived images
//
// The image of an ImageBitmap (src/dom/canvas-image-bitmap.js) that is not
// its source's image as it is: a crop, a resize or a flip of a source, or
// an ImageData. It is the command list that draws it, recorded by an
// internal core as drawImage() and putImageData() record. A canvas that
// draws the bitmap rasterizes the list on its own device, once for each
// device (`persistent`; src/dom/canvas-gpu-binding.js), as it rasterizes the
// list of a canvas without a bitmap.

let recorderCore = null;

function recorder() {
  recorderCore ??= instantiateCore();
  recorderCore.context_reset(false);
  return recorderCore;
}

function recordedSource(core, width, height, sources, payloads, colorSpace, format) {
  const buffer = core.memory.buffer;
  const list = {
    bytes: new Uint8Array(buffer, core.command_pointer(), core.command_count() * COMMAND_SIZE).slice(),
    geometry: new Uint8Array(buffer, core.geometry_pointer(), core.geometry_count() * CANVAS_CORE.GEOMETRY_VERTEX_SIZE).slice(),
    clips: new Uint8Array(buffer, core.clip_entry_pointer(), core.clip_entry_count() * CLIP_ENTRY_SIZE).slice(),
    masks: new Uint8Array(buffer, core.mask_pointer(), core.mask_count() * MASK_SIZE).slice(),
    maskGeometry: new Uint8Array(buffer, core.mask_geometry_pointer(),
      core.mask_geometry_count() * CANVAS_CORE.GEOMETRY_VERTEX_SIZE).slice(),
    paints: new Uint8Array(buffer, core.paint_pointer(), core.paint_count() * CANVAS_CORE.PAINT_VECTOR_SIZE).slice(),
    sources: sources.map(retainSource),
    payloads,
    fonts: [],
  };
  core.commands_clear();
  return { kind: "commands", width, height, opaque: false, persistent: true, colorSpace, format, list, references: 0 };
}

// The ResizeQuality values, in the enumeration order the canvas core
// reads (BITMAP_RESIZE_PIXELATED first).
export const RESIZE_QUALITIES = Object.freeze(["pixelated", "low", "medium", "high"]);

// The canvas core's ImageBitmap checks (bitmap_options_check): null, or
// the BITMAP_ failure.
export function bitmapOptionsCheck(crop, options) {
  const result = builder().bitmap_options_check(crop !== null, crop?.[2] ?? 0, crop?.[3] ?? 0,
    options.resizeWidth !== undefined, options.resizeWidth ?? 0, options.resizeHeight !== undefined, options.resizeHeight ?? 0);
  return result === RESULT_DONE ? null : result;
}

// The ImageBitmap of a resolved `image` with `crop` ([sx, sy, sw, sh] or
// null) and `options` (bitmap_geometry): { result: BITMAP_WHOLE, or a
// BITMAP_ failure }, or { result: BITMAP_DERIVED, source, width, height }
// with the source not yet retained.
export function imageBitmapGeometry(image, crop, options) {
  const flipY = options.imageOrientation === "flipY";
  const geometryCore = builder();
  const result = geometryCore.bitmap_geometry(image.width, image.height, image.naturalDimensions, crop !== null,
    ...(crop ?? [0, 0, 0, 0]), options.resizeWidth !== undefined, options.resizeWidth ?? 0,
    options.resizeHeight !== undefined, options.resizeHeight ?? 0, flipY);
  if (result !== BITMAP_DERIVED) return { result };
  const geometry = new Float64Array(builderMemory.buffer, geometryCore.output_pointer(), BITMAP_HEIGHT / 8 + 1).slice();
  const width = geometry[BITMAP_WIDTH / 8];
  const height = geometry[BITMAP_HEIGHT / 8];
  const core = recorder();
  // The list draws in the source's own color space (recordedSource).
  const recorded = core.bitmap_record(image.opaque, SOURCE_CONVERSION_NONE, image.width, image.height,
    geometry[BITMAP_CROP_X / 8], geometry[BITMAP_CROP_Y / 8], geometry[BITMAP_CROP_WIDTH / 8],
    geometry[BITMAP_CROP_HEIGHT / 8], width, height, flipY, RESIZE_QUALITIES.indexOf(options.resizeQuality));
  if (recorded === RESULT_FULL) throw new RangeError("ImageBitmap: the command list cannot grow");
  // The bitmap keeps its source's color space and format (a canvas's; an
  // image's is 8-bit sRGB).
  const colorSpace = image.source.colorSpace ?? "srgb";
  const format = image.source.kind === "image" ? BITMAP_FORMAT : image.source.format;
  const source = recordedSource(core, width, height, recorded === RESULT_DONE ? [image.source] : [], [], colorSpace, format);
  return { result, source, width, height };
}

// The image of an ImageData: its bytes, premultiplied as putImageData()
// premultiplies them.
export function imageDataSource(imageData) {
  const core = recorder();
  const { width, height } = imageData;
  core.put_image_data_region(width, height, 0, 0, false, 0, 0, 0, 0, width, height);
  // The list draws in the data's own color space (recordedSource).
  const result = core.record_put_image_data(0, SOURCE_CONVERSION_NONE);
  if (result === RESULT_FULL) throw new RangeError("ImageBitmap: the command list cannot grow");
  const payloads = [imageDataPayload(imageData, imageData.data, width, height)];
  return recordedSource(core, width, height, [], payloads, imageData.colorSpace, payloads[0].format);
}

export function isImageDataObject(value) {
  return isImageData(value);
}

// The Sandom sources of GPUQueue.copyExternalImageToTexture()
// (src/dom/canvas-gpu-binding.js): the CanvasImageSource forms and ImageData.
// An ImageData copies its straight bytes, as Chrome uploads it.
registerSandomImageSources({
  test: (value) =>
    isSandomCanvas(value) || isSandomImage(value) || isImageData(value) ||
    offscreenCanvasState(value) !== undefined || imageBitmapState(value) !== undefined ||
    unsupportedImageSource(value) !== null,
  resolve(member, value, device) {
    if (isImageData(value)) {
      if (value.data.buffer.detached) {
        throw new DOMException(`${member}: The source data has been detached.`, "InvalidStateError");
      }
      const payload = imageDataPayload(value, value.data, value.width, value.height);
      const image = {
        width: value.width,
        height: value.height,
        originClean: true,
        bytes: payload.bytes,
        format: payload.format,
        colorSpace: value.colorSpace,
      };
      return { image, upload: "straight" };
    }
    // Chrome's copy words a closed ImageBitmap and a canvas without a
    // context in its own way.
    if (imageBitmapState(value) === null) {
      throw new DOMException(`${member}: ImageBitmap has been detached.`, "InvalidStateError");
    }
    if (isSandomCanvas(value) && value._canvasContextType === null) {
      throw new DOMException(
        `${member}: CopyExternalImageToTexture doesn't support canvas without rendering context`,
        "OperationError",
      );
    }
    const resolved = resolveImageSource(member, value, "draw", device);
    if (resolved === BROKEN_IMAGE) {
      throw new DOMException(`${member}: The HTMLImageElement provided is in the 'broken' state.`, "InvalidStateError");
    }
    return { image: resolved, upload: "premultiplied" };
  },
  retain: retainSource,
  release: releaseSource,
});

export { discardSource, releaseSource, retainSource };

// Creates the 2D context of `canvas`. The canvas resource that the element
// registered (src/dom/canvas.js) carries the bitmap into paint.
// `publicCanvas` is the object of the context's `canvas` attribute when
// `canvas` is the host of an OffscreenCanvas.
export function createCanvasRenderingContext2D(canvas, settings, resourceHandle, publicCanvas = canvas) {
  return new CanvasRenderingContext2D(CONSTRUCTION, canvas, settings, resourceHandle, publicCanvas);
}

function encodeBlank(width, height, encoding, operation) {
  encodePixels({ pixels: new Uint8Array(width * height * 4), bitDepth: 8, channelLayout: "rgba" },
    width, height, "srgb", encoding, operation);
}

export function canvasToDataURL(canvas, type, quality) {
  const encoding = encodingOptions(type, quality);
  const contextType = canvas._canvasContextType;
  const context = contextType === "2d" ? canvas._canvasContext
    : contextType === "placeholder" ? canvas._canvasContext.offscreenContext : null;
  if (context !== null) return context._toDataURL(encoding);
  if (canvas.width === 0 || canvas.height === 0) return "data:,";
  if (contextType !== null && contextType !== "placeholder") {
    throw notSupported("HTMLCanvasElement.toDataURL", `a ${contextType} canvas`);
  }
  let bytes;
  encodeBlank(canvas.width, canvas.height, encoding, {
    reply(value) { bytes = value; },
    throw(error) { throw error; },
  });
  return `data:${encoding.type};base64,${bytes.toBase64()}`;
}

// HTMLCanvasElement.toBlob(callback, type, quality).
export function canvasToBlob(canvas, argumentCount, callback, type, quality) {
  if (argumentCount < 1) {
    throw new TypeError("HTMLCanvasElement.toBlob: 1 argument required, but only 0 present.");
  }
  if (typeof callback !== "function") {
    throw new TypeError("HTMLCanvasElement.toBlob: parameter 1 is not of type 'Function'.");
  }
  type = type === undefined ? "image/png" : `${type}`;
  const contextType = canvas._canvasContextType;
  // A placeholder canvas gives the bitmap of the OffscreenCanvas that
  // controls it, once that has a 2D context.
  const context = contextType === "2d"
    ? canvas._canvasContext
    : contextType === "placeholder"
    ? canvas._canvasContext.offscreenContext
    : null;
  if (context !== null) {
    context._toBlob(callback, type, quality);
    return;
  }
  if (contextType !== null && contextType !== "placeholder") {
    throw notSupported("HTMLCanvasElement.toBlob", `a ${contextType} canvas`);
  }
  // A canvas without a context has a transparent black bitmap.
  let blob = null;
  let failure = null;
  if (canvas.width !== 0 && canvas.height !== 0) {
    const encoding = encodingOptions(type, quality);
    encodeBlank(canvas.width, canvas.height, encoding, {
      reply(bytes) { blob = new Blob([bytes], { type: encoding.type }); },
      throw(error) { failure = error; },
    });
  }
  queueMicrotask(() => {
    if (failure !== null) reportCallbackError(failure);
    try { callback.call(undefined, blob); }
    catch (error) { reportCallbackError(error); }
  });
}
