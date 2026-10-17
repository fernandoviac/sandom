// CanvasRenderingContext2D of a Sandom document (plans/dom/PLAN-canvas-2d.md,
// slice 2; docs/specifications/canvas-2d.md).
//
// This object is a facade. It converts and validates arguments as Chrome's
// bindings do and forwards them to src/wasm/canvas-2d.wat, which holds the
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
  canvasFontText,
  canvasGlyphRun,
  canvasSpacingPx,
  canvasTextEnvironment,
  DIRECTIONS,
  FONT_KERNINGS,
  FONT_STRETCHES,
  FONT_VARIANT_CAPS,
  layoutCanvasText,
  measureCanvasText,
  parseCanvasFont,
  parseCanvasSpacing,
  readTextState,
  TEXT_ALIGNS,
  TEXT_BASELINES,
  TEXT_RENDERINGS,
  textDrawBounds,
  textPlacement,
} from "./canvas-2d-text.js";
import { getWasmBytes } from "../wasm/canvas-2d-binary.js";
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
import { createGradient, GRADIENT_CONICAL, GRADIENT_LINEAR, GRADIENT_SWEEP } from "./canvas-2d-gradient.js";
import {
  FILTER_DROP_SHADOW_ONLY,
  filterWords,
  parseCanvasFilter,
  resolveCanvasFilter,
  UnsupportedFilter,
} from "./canvas-2d-filter.js";
import { CanvasPattern, createCanvasPattern, patternRepetition } from "./canvas-2d-pattern.js";
import { matrixFromInit } from "./canvas-2d-matrix-init.js";
import { encodeJpegRgbaWithCompletion, initializeJpegEncoder } from "../output/jpeg-encoder.js";
import { defaultPngCodec } from "../png-codec.js";
import { imageCanvasSource } from "./images.js";
import { convertCanvasColor, SOURCE_CONVERSION_NONE, sourceConversion } from "./canvas-2d-color-space.js";
import { buildDisplayP3Profile } from "../output/icc-profile.js";
import { createDefaultGpuDeviceSync, getDefaultGpu } from "../gpu-thread.js";

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
const CLIP_ENTRY_SIZE = 32;
const MASK_SIZE = 32;
// Chrome 151 draws the canvas focus ring (drawFocusIfNeeded) 5 user units
// wide with round joins in #005fcc (measured 2026-10-10).
const FOCUS_RING_WIDTH = 5;
const FOCUS_RING_COLOR = Object.freeze({ r: 0, g: 95 / 255, b: 204 / 255, a: 1 });
const CONSTRUCTION = Symbol("CanvasRenderingContext2D construction");
const IMAGE_DATA_CONSTRUCTION = Symbol("ImageData construction");
const STYLE_FILL = 0;
const STYLE_STROKE = 1;
const STYLE_SHADOW = 2;
const DEFAULT_JPEG_QUALITY = 0.92;
// The [[TypedArrayName]] of a typed array of any realm: a page script's
// array belongs to the document's realm, not to Sandom's.
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
).get;

let compiledModule = null;

// WebAssembly has no trigonometry; the core imports these (arcs, SVG arcs,
// round joins).
const CORE_IMPORTS = Object.freeze({
  math: Object.freeze({ sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, acos: Math.acos }),
});

function instantiateCore() {
  compiledModule ??= new WebAssembly.Module(getWasmBytes());
  return new WebAssembly.Instance(compiledModule, CORE_IMPORTS).exports;
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

// A color component to 8 bits as the core stores a canvas color
// ($component8 and $alpha8 of canvas-2d-core.watpart): components round
// half up, alpha rounds in single precision.
function component8(value) {
  return Math.min(Math.max(Math.floor(value * 255 + 0.500000001), 0), 255);
}

function alpha8(value) {
  const f32 = Math.fround;
  return Math.min(Math.max(Math.floor(f32(f32(f32(value) * 255) + 0.5)), 0), 255);
}

// A parsed color (`parsed`: encoded sRGB r, g, b, a) at the precision that
// Chrome keeps for its authored `text`: a legacy sRGB color (hex, named,
// rgb(), hsl(), hwb()) has an 8-bit alpha; rgb(), hex and named colors
// have 8-bit components, hsl() and hwb() keep their precision; any other
// color keeps its precision (measured on the pinned Chrome: hsl(90 30% 55%
// / 0.6) fills with blue 105, its float component, not 106).
function colorPrecision(text, { r, g, b, a }) {
  const syntax = /^\s*(#|[a-z-]+\s*$|rgba?\(|hsla?\(|hwb\()/i.exec(text)?.[1].toLowerCase() ?? "";
  const legacy = syntax !== "";
  const alpha = legacy ? alpha8(a) / 255 : a;
  const color = legacy && !/^(?:hsla?|hwb)\($/.test(syntax)
    ? [component8(r) / 255, component8(g) / 255, component8(b) / 255, alpha]
    : [r, g, b, alpha];
  return { color, legacy };
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

// The typed array of each ImageData pixelFormat.
const PIXEL_FORMAT_ARRAYS = Object.freeze({ "rgba-unorm8": "Uint8ClampedArray", "rgba-float16": "Float16Array" });

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
      const arrayType = Reflect.apply(typedArrayName, first, []);
      if (!Object.values(PIXEL_FORMAT_ARRAYS).includes(arrayType)) {
        throw notSupported("ImageData", "pixel data other than a Uint8ClampedArray or a Float16Array");
      }
      const settings = imageDataSettings(fourth);
      const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
      if (PIXEL_FORMAT_ARRAYS[pixelFormat] !== arrayType) {
        throw new DOMException(`ImageData: ${arrayType} must use ${pixelFormatOf(arrayType)} pixelFormat.`, "InvalidStateError");
      }
      const length = first.length;
      if (length === 0) throw new DOMException("ImageData: The input data has zero elements.", "IndexSizeError");
      if (length % 4 !== 0) {
        throw new DOMException("ImageData: The input data length is not a multiple of 4.", "InvalidStateError");
      }
      const width = Number(second) >>> 0;
      if (width === 0) {
        throw new DOMException("ImageData: The source width is zero or not a number.", "IndexSizeError");
      }
      if (length % (4 * width) !== 0) {
        throw new DOMException("ImageData: The input data length is not a multiple of (4 * width).", "IndexSizeError");
      }
      const rows = length / (4 * width);
      if (third !== undefined && (Number(third) >>> 0) !== rows) {
        throw new DOMException(
          "ImageData: The input data length is not equal to (4 * width * height).",
          "IndexSizeError",
        );
      }
      this.#width = width;
      this.#height = rows;
      this.#data = first;
      this.#colorSpace = settings.colorSpace ?? "srgb";
      this.#pixelFormat = pixelFormat;
      return;
    }
    const settings = imageDataSettings(third);
    const width = Number(first) >>> 0;
    const height = Number(second) >>> 0;
    if (width === 0) {
      throw new DOMException("ImageData: The source width is zero or not a number.", "IndexSizeError");
    }
    if (height === 0) {
      throw new DOMException("ImageData: The source height is zero or not a number.", "IndexSizeError");
    }
    this.#width = width;
    this.#height = height;
    this.#pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    this.#data = allocateImageData("ImageData", width, height, this.#pixelFormat);
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

  get [Symbol.toStringTag]() {
    return "ImageData";
  }

  static {
    isImageData = (value) => value !== null && typeof value === "object" && #width in value;
  }
}

function pixelFormatOf(arrayType) {
  return Object.keys(PIXEL_FORMAT_ARRAYS).find((format) => PIXEL_FORMAT_ARRAYS[format] === arrayType);
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
    : enumValue("ImageData", "pixelFormat", pixelFormatValue, Object.keys(PIXEL_FORMAT_ARRAYS), "rgba-unorm8");
  return { colorSpace, pixelFormat };
}

function allocateImageData(member, width, height, pixelFormat) {
  const length = width * height * 4;
  if (!Number.isSafeInteger(length) || length > 0x7fffffff) {
    throw new RangeError(`${member}: Out of memory at ImageData creation.`);
  }
  return pixelFormat === "rgba-float16" ? new Float16Array(length) : new Uint8ClampedArray(length);
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
  get [Symbol.toStringTag]() {
    return "DOMMatrix";
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

function pathResult(member, result) {
  if (result === -1) throw new RangeError(`${member}: the path cannot grow`);
}

function negativeRadius(member, label, value) {
  return new DOMException(`${member}: The ${label} provided (${value}) is negative.`, "IndexSizeError");
}

// roundRect radii (HTML "roundRect" steps 2 to 5, Blink's messages): four
// corners, upper-left, upper-right, lower-right, lower-left, each x and y;
// or null when a radius is infinite or NaN (the call does nothing).
function roundRectRadii(member, radii) {
  let list;
  if (radii === undefined) list = [0];
  else if (radii !== null && typeof radii === "object" && typeof radii[Symbol.iterator] === "function") list = [...radii];
  else list = [radii];
  if (list.length < 1 || list.length > 4) {
    throw new RangeError(`${member}: ${list.length} radii provided. Between one and four radii are necessary.`);
  }
  const corners = [];
  for (const radius of list) {
    if (radius !== null && typeof radius === "object") {
      const x = Math.fround(Number(radius.x ?? 0));
      const y = Math.fround(Number(radius.y ?? 0));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < 0) throw new RangeError(`${member}: X-radius value ${x} is negative.`);
      if (y < 0) throw new RangeError(`${member}: Y-radius value ${y} is negative.`);
      corners.push([x, y]);
    } else {
      const value = Math.fround(Number(radius));
      if (!Number.isFinite(value)) return null;
      if (value < 0) throw new RangeError(`${member}: Radius value ${value} is negative.`);
      corners.push([value, value]);
    }
  }
  const [first, second, third, fourth] = corners;
  if (corners.length === 1) return [first, first, first, first];
  if (corners.length === 2) return [first, second, first, second];
  if (corners.length === 3) return [first, second, third, second];
  return [first, second, third, fourth];
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
    case "arcTo": {
      const [x1, y1, x2, y2, radius] = numbers;
      if ([x1, y1, x2, y2, radius].every(Number.isFinite) && radius < 0) {
        throw negativeRadius(member, "radius", Math.fround(radius));
      }
      return pathResult(member, core.arc_to(x1, y1, x2, y2, radius));
    }
    case "rect":
      return pathResult(member, core.rect(...numbers.slice(0, 4)));
    case "roundRect": {
      const radii = roundRectRadii(member, values[4]);
      if (radii === null || !numbers.slice(0, 4).every(Number.isFinite)) return;
      new Float64Array(memory.buffer, core.input_pointer(), 8).set(radii.flat());
      return pathResult(member, core.round_rect(...numbers.slice(0, 4)));
    }
    case "arc": {
      const [x, y, radius, start, end] = numbers;
      if ([x, y, radius, start, end].every(Number.isFinite) && radius < 0) {
        throw negativeRadius(member, "radius", Math.fround(radius));
      }
      return pathResult(member, core.arc(x, y, radius, start, end, values[5] ? 1 : 0));
    }
    case "ellipse": {
      const [x, y, radiusX, radiusY, rotation, start, end] = numbers;
      if ([x, y, radiusX, radiusY, rotation, start, end].every(Number.isFinite)) {
        if (radiusX < 0) throw negativeRadius(member, "major-axis radius", Math.fround(radiusX));
        if (radiusY < 0) throw negativeRadius(member, "minor-axis radius", Math.fround(radiusY));
      }
      return pathResult(member, core.ellipse(x, y, radiusX, radiusY, rotation, start, end, values[7] ? 1 : 0));
    }
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
    builderCore.context_reset(0);
  }
  return builderCore;
}

// The transport bytes of slot `slot` of `core`.
function exportPath(core, memory, slot) {
  const headerSize = core.path_header_size();
  const count = core.path_data_count(slot);
  const bytes = new Uint8Array(headerSize + count * 8);
  bytes.set(new Uint8Array(memory.buffer, core.path_header_pointer(slot), headerSize));
  if (count > 0) bytes.set(new Uint8Array(memory.buffer, core.path_data_pointer(slot), count * 8), headerSize);
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
    core.path_clear(0);
    const encoded = new TextEncoder().encode(text);
    const pointer = core.import_buffer(encoded.length);
    if (pointer === 0) throw new RangeError("Path2D: the path cannot grow");
    new Uint8Array(builderMemory.buffer, pointer, encoded.length).set(encoded);
    pathResult("Path2D", core.parse_svg_path(encoded.length));
  }

  get [Symbol.toStringTag]() {
    return "Path2D";
  }

  // Makes this path the builder's slot 0.
  #resident() {
    const core = builder();
    if (residentPath === this) return core;
    if (residentPath !== null) residentPath.#bytes = exportPath(core, builderMemory, 0);
    core.reset_transform();
    importPath("Path2D", core, builderMemory, 0, this.#bytes);
    residentPath = this;
    return core;
  }

  addPath(path, transform = undefined) {
    requireArgumentsOf("Path2D", "addPath", 1, arguments.length);
    if (!isPath2D(path)) throw new TypeError("Path2D.addPath: parameter 1 is not of type 'Path2D'.");
    const matrix = matrixFromInit(transform, "Path2D.addPath");
    const bytes = path2DBytes(path);
    const core = this.#resident();
    this.#version++;
    importPath("Path2D.addPath", core, builderMemory, 1, bytes);
    pathResult("Path2D.addPath", core.path_add_path(...matrix));
  }

  static {
    isPath2D = (value) => value !== null && typeof value === "object" && #bytes in value;
    path2DBytes = (path) => (residentPath === path ? exportPath(builder(), builderMemory, 0) : path.#bytes);
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

// The composite operations, indexed as the core stores them
// (src/wasm/canvas-2d-composite.watpart). Chrome also accepts "clear"
// (Skia's kClear), and "normal" as source-over; it ignores every other
// value and compares case-sensitively (measured on the pinned Chrome).
const COMPOSITE_OPERATIONS = [
  "source-over", "source-in", "source-out", "source-atop", "destination-over", "destination-in",
  "destination-out", "destination-atop", "lighter", "copy", "xor", "multiply", "screen", "overlay",
  "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity", "clear",
];

const IMAGE_SMOOTHING_QUALITIES = ["low", "medium", "high"];

// Blink keeps shadow offsets and blur as float (ClampTo<float>).
function clampToFloat(value) {
  return Math.fround(Math.min(Math.max(value, -3.4028234663852886e38), 3.4028234663852886e38));
}

// The enumerated text attributes: their values and their offset in the
// core's text state (src/wasm/canvas-2d-text.watpart).
const TEXT_ENUMS = Object.freeze({
  textAlign: { values: TEXT_ALIGNS, offset: 40 },
  textBaseline: { values: TEXT_BASELINES, offset: 44 },
  fontKerning: { values: FONT_KERNINGS, offset: 52 },
  fontStretch: { values: FONT_STRETCHES, offset: 56 },
  fontVariantCaps: { values: FONT_VARIANT_CAPS, offset: 60 },
  textRendering: { values: TEXT_RENDERINGS, offset: 64 },
});
const TEXT_DIRECTION_OFFSET = 48;
// Layouts of measured and drawn text kept for each context.
const TEXT_LAYOUT_CACHE_SIZE = 256;

const LINE_CAPS = ["butt", "round", "square"];
const LINE_JOINS = ["miter", "round", "bevel"];

// Chrome slants a font that it synthesizes italic for (Skia's fake
// italic): x' = x - 0.25 y about each glyph origin, y down.
function obliqueSkew(font) {
  return font.syntheticOblique ? -0.25 : 0;
}

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
    if (width === 0 || height === 0) throw sizeError(member, use, width, "canvasSize");
    return canvasElementSource(value, width, height, device);
  }
  const offscreen = offscreenCanvasState(value);
  if (offscreen !== undefined) {
    const { width, height, context } = offscreen;
    if (width === 0 || height === 0) throw sizeError(member, use, width, "offscreenSize");
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

function encodingOptions(type, quality) {
  const jpeg = (type === undefined ? "image/png" : `${type}`).toLowerCase() === "image/jpeg";
  return {
    jpeg,
    type: jpeg ? "image/jpeg" : "image/png",
    quality: Math.round((typeof quality === "number" && quality >= 0 && quality <= 1
      ? quality : DEFAULT_JPEG_QUALITY) * 100),
  };
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
  #originClean = true;
  #shutdown = false;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();
  // The Path2D in core slot 1 and its version, or null.
  #slotPath = null;
  #slotVersion = 0;
  // The paint styles (CanvasGradient, CanvasPattern) that the core's state
  // names by handle (src/wasm/canvas-2d-paint.watpart), both ways.
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

  // The resolved filters (src/dom/canvas-2d-filter.js) that the core's
  // state names by handle (src/wasm/canvas-2d-filter.watpart). A handle
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
    this.#core.context_reset(settings.alpha ? 0 : 1);
    const core = canvas._domCore;
    const bitmapDevice = () => this.#bitmap?.device ?? null;
    this.paintSource = Object.freeze({
      kind: "canvas",
      sourceIdentifier: core.resourceId(resourceHandle),
      resourceHandle,
      get width() {
        return core.canvasResourceDimension(resourceHandle, 0);
      },
      get height() {
        return core.canvasResourceDimension(resourceHandle, 1);
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

  get [Symbol.toStringTag]() {
    return INTERFACE;
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
    this.#core.context_reset(this.#settings.alpha ? 0 : 1);
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
    const radians = Number(angle);
    this.#core.rotate(Math.cos(radians), Math.sin(radians));
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
      core.set_transform(...matrixFromInit(values[0], `${INTERFACE}.setTransform`));
      return;
    }
    if (values.length < 6) {
      throw new TypeError(`${INTERFACE}.setTransform: 6 arguments required, but only ${values.length} present.`);
    }
    core.set_transform(...values.slice(0, 6).map(Number));
  }

  getTransform() {
    const pointer = this.#core.transform_pointer();
    return new SandomDOMMatrix(Array.from(new Float64Array(this.#memory.buffer, pointer, 6)));
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
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return;
    const length = values.length % 2 === 1 ? values.length * 2 : values.length;
    if (length > 64) {
      throw notSupported(`${INTERFACE}.setLineDash`, `a dash list of ${length} values (at most 64)`);
    }
    const core = this.#core;
    new Float64Array(this.#memory.buffer, core.input_pointer(), values.length).set(values);
    core.set_line_dash(values.length);
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
    const number = Number(value);
    if (Number.isFinite(number)) this.#core.set_shadow_offset_x(clampToFloat(number));
  }

  get shadowOffsetY() {
    return this.#core.shadow_offset_y();
  }

  set shadowOffsetY(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.#core.set_shadow_offset_y(clampToFloat(number));
  }

  get shadowBlur() {
    return this.#core.shadow_blur();
  }

  set shadowBlur(value) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) this.#core.set_shadow_blur(clampToFloat(number));
  }

  get globalCompositeOperation() {
    return COMPOSITE_OPERATIONS[this.#core.global_composite_operation()];
  }

  set globalCompositeOperation(value) {
    if (typeof value === "symbol") {
      throw new TypeError(
        "Failed to set the 'globalCompositeOperation' property on 'CanvasRenderingContext2D': Cannot convert a Symbol value to a string",
      );
    }
    const text = String(value);
    const index = text === "normal" ? 0 : COMPOSITE_OPERATIONS.indexOf(text);
    if (index >= 0) this.#core.set_global_composite_operation(index);
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
    let functions;
    try {
      functions = parseCanvasFilter(text, {
        fontSize,
        rootFontSize: () => this.#rootFontSize(),
        parseColor: (color) => this.#filterColor(color),
      });
    } catch (error) {
      if (error instanceof UnsupportedFilter) {
        throw notSupported(`${INTERFACE}.filter`, `the value ${text} (${error.message})`);
      }
      throw error;
    }
    if (functions === null) return;
    if (this.#filters.size >= 32) {
      for (const old of this.#filters.keys()) {
        if (core.filter_handle_in_use(old) === 0) this.#filters.delete(old);
      }
    }
    const serial = this.#nextFilterHandle++;
    const next = functions.length === 0 ? -serial : serial;
    this.#filters.set(next, Object.freeze({ ...resolveCanvasFilter(text, functions), fontSize }));
    core.set_filter_handle(next);
  }

  // A drop-shadow() color: encoded components 0 to 1 in the canvas's color
  // space, "currentColor", or null. A legacy sRGB color keeps 8-bit
  // components, its alpha included (measured: drop-shadow(… rgba(0, 0, 0,
  // 0.7)) draws as alpha 179/255).
  #filterColor(text) {
    const core = this.#canvas._domCore;
    const parsed = core.parseColor(text, { r: 0, g: 0, b: 0, a: 1 });
    if (parsed === null || parsed === "currentColor") return parsed;
    const a = core.parsedColorText() !== null ? parsed.a : Math.round(parsed.a * 255) / 255;
    const [r, g, b] = convertCanvasColor(parsed.r, parsed.g, parsed.b, "srgb", this.#settings.colorSpace);
    return { r, g, b, a };
  }

  // The font size of the canvas font in pixels, for em.
  #filterFontSize() {
    return this.#textState().size;
  }

  // The root element's font size in pixels, for rem.
  #rootFontSize() {
    const document = this.#canvas.ownerDocument;
    const root = document?.documentElement;
    if (!root || !this.#canvas.isConnected) return 16;
    const size = Number.parseFloat(document.getComputedStyle(root).fontSize);
    return Number.isFinite(size) ? size : 16;
  }

  // Writes the filter block of the current filter into this flush's
  // paints for the next draw, or names the block already written; with a
  // shadow, also the block of the shadow's layer: the filter, then Blink's
  // shadow-only drop shadow of the shadow parameters (canvas-2d-shadow.
  // watpart). Blink shadows a fill or stroke with a pattern the same way
  // without a filter (Canvas2DRecorderContext::
  // ShouldUseDropShadowPaintFilter: a pattern is a kNonOpaqueImage), so
  // `style` (STYLE_FILL, STYLE_STROKE, or undefined for an image) with a
  // pattern stages that block alone. A filter with a drop shadow of
  // currentcolor taints the canvas, as Chrome's filter resolution at the
  // draw does.
  #stageFilter(style = undefined) {
    const core = this.#core;
    const handle = core.filter_handle();
    let filter = null;
    if (handle > 0) {
      filter = this.#filters.get(handle);
      if (filter.taints) this.#originClean = false;
      this.#stageFilterBlock(0, `${handle}`, () => filter.words);
    } else {
      const paint = style === undefined ? 0 : core.paint_handle(style);
      if (paint === 0 || !(this.#paints.get(paint) instanceof CanvasPattern)) return;
    }
    if (core.shadow_drawn() === 0) return;
    const color = core.shadow_color();
    const offsetX = Math.fround(core.shadow_offset_x());
    const offsetY = Math.fround(core.shadow_offset_y());
    const deviation = Math.fround(Math.fround(core.shadow_blur()) * 0.5);
    const key = `${filter === null ? 0 : handle} ${offsetX} ${offsetY} ${deviation} ${color}`;
    this.#stageFilterBlock(1, key, () =>
      filterWords([...(filter?.steps ?? []), {
        kind: FILTER_DROP_SHADOW_ONLY,
        offsetX,
        offsetY,
        deviation,
        color: {
          r: (color & 0xff) / 255,
          g: ((color >>> 8) & 0xff) / 255,
          b: ((color >>> 16) & 0xff) / 255,
          a: (color >>> 24) / 255,
        },
      }]));
  }

  // Names the filter block `key` of this flush for the next draw ($which
  // 0) or its shadow (1), writing its words first when the flush has none.
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

  // The color `text` names, as encoded sRGB components and the text the
  // style serializes from, or null when `text` is not a color. A color
  // outside the legacy sRGB forms carries Chrome's serialization of it; a
  // legacy one serializes from its 8-bit components.
  #resolveColor(text) {
    const core = this.#canvas._domCore;
    // currentcolor, alone or inside a color-mix(), is the canvas element's
    // computed color. It is resolved before `text` is parsed: the core keeps
    // the serialization of the last parse only.
    const current = /currentcolor/i.test(text) ? this.#currentColor() : null;
    const parsed = core.parseColor(text, current);
    if (parsed === null) return null;
    if (parsed === "currentColor") return { color: current, text };
    return { color: parsed, text: core.parsedColorText() ?? text };
  }

  // The canvas element's computed color, black outside a document.
  #currentColor() {
    const canvas = this.#canvas;
    const black = { r: 0, g: 0, b: 0, a: 1 };
    if (!canvas.isConnected) return black;
    // An element without an authored color reports "": the initial color, black.
    const computed = canvas.ownerDocument.getComputedStyle(canvas).color;
    if (!computed) return black;
    const resolved = canvas._domCore.parseColor(computed);
    return resolved === null || resolved === "currentColor" ? black : resolved;
  }

  #setStyle(member, which, value) {
    if (which !== STYLE_SHADOW && isCanvasPaint(value)) {
      this.#setPaint(which, value);
      return;
    }
    const text = String(value);
    const resolved = this.#resolveColor(text);
    if (resolved === null) return;
    const { color } = resolved;
    const core = this.#core;
    const input = new Uint8Array(this.#memory.buffer, core.input_pointer(), core.input_capacity());
    const { written } = this.#encoder.encodeInto(resolved.text, input);
    // Draws use the color at Chrome's precision (currentcolor as a named
    // color), in the canvas's color space; the getter serializes the
    // parsed color.
    const [red, green, blue, alpha] = colorPrecision(text, color).color;
    const [drawRed, drawGreen, drawBlue] = convertCanvasColor(red, green, blue, "srgb", this.#settings.colorSpace);
    const result = core.set_style(which, color.r, color.g, color.b, color.a, drawRed, drawGreen, drawBlue, alpha, written);
    if (result === -2) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
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
    if (taintingPaints.has(paint)) this.#originClean = false;
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
    return createGradient(GRADIENT_LINEAR, geometry, this.#stopColorParser());
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    void this.#core;
    requireArguments("createRadialGradient", 6, arguments.length);
    const geometry = finiteArguments("createRadialGradient", [x0, y0, r0, x1, y1, r1]);
    for (const [label, radius] of [["r0", geometry[2]], ["r1", geometry[5]]]) {
      if (radius < 0) {
        throw new DOMException(
          `${INTERFACE}.createRadialGradient: The ${label} provided is less than 0.`,
          "IndexSizeError",
        );
      }
    }
    return createGradient(GRADIENT_CONICAL, geometry, this.#stopColorParser());
  }

  createConicGradient(startAngle, x, y) {
    void this.#core;
    requireArguments("createConicGradient", 3, arguments.length);
    const geometry = finiteArguments("createConicGradient", [startAngle, x, y]);
    return createGradient(GRADIENT_SWEEP, geometry, this.#stopColorParser());
  }

  // A gradient stop color as Blink parses it (ParseCanvasColorString):
  // currentcolor is black, and the color has Chrome's precision
  // (colorPrecision). A color other than a legacy sRGB color makes the
  // gradient interpolate in OKLab, where Blink hands Skia each stop
  // converted to OKLab and back to sRGB (`oklabColor`), and the first
  // stop's own sRGB at offset 0 (`oklabPadding`; Gradient::FillSkiaStops).
  #stopColorParser() {
    const core = this.#canvas._domCore;
    return (text) => {
      const parsed = core.parseColor(text, { r: 0, g: 0, b: 0, a: 1 });
      if (parsed === null) return null;
      if (parsed === "currentColor") {
        // Black is exact through OKLab.
        return { color: [0, 0, 0, 1], oklabColor: [0, 0, 0, 1], oklabPadding: [0, 0, 0, 1], legacy: true };
      }
      const { color, legacy } = colorPrecision(text, parsed);
      const alpha = color[3];
      const { stop, own } = core.parsedOklabStop(color[0], color[1], color[2]);
      return { color, oklabColor: [...stop, alpha], oklabPadding: [...own, alpha], legacy };
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
      return new ImageData(
        IMAGE_DATA_CONSTRUCTION,
        first.width,
        first.height,
        allocateImageData(`${INTERFACE}.createImageData`, first.width, first.height, first.pixelFormat),
        first.colorSpace,
        first.pixelFormat,
      );
    }
    const width = Math.abs(toLong(first));
    const height = Math.abs(toLong(second));
    if (width === 0) {
      throw new DOMException(`${INTERFACE}.createImageData: The source width is zero or not a number.`, "IndexSizeError");
    }
    if (height === 0) {
      throw new DOMException(`${INTERFACE}.createImageData: The source height is zero or not a number.`, "IndexSizeError");
    }
    // Without a color space in the settings, the data takes the canvas's,
    // as in Chrome; without a pixel format, rgba-unorm8, also on a float16
    // canvas (measured on Chrome 151).
    const settings = imageDataSettings(third);
    const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    return new ImageData(
      IMAGE_DATA_CONSTRUCTION,
      width,
      height,
      allocateImageData(`${INTERFACE}.createImageData`, width, height, pixelFormat),
      settings.colorSpace ?? this.#settings.colorSpace,
      pixelFormat,
    );
  }

  getImageData(sx, sy, sw, sh) {
    requireArguments("getImageData", 4, arguments.length);
    const values = [sx, sy, sw, sh].map((value) => toEnforcedLong("getImageData", value));
    const settings = imageDataSettings(arguments[4]);
    if (values[2] === 0 || values[3] === 0) {
      throw new DOMException(`${INTERFACE}.getImageData: The source ${values[2] === 0 ? "width" : "height"} is 0.`, "IndexSizeError");
    }
    if (!this.#originClean) {
      throw new DOMException(
        `${INTERFACE}.getImageData: The canvas has been tainted by cross-origin data.`,
        "SecurityError",
      );
    }
    const intersects = this.#core.get_image_data_region(...values, this.#canvas.width, this.#canvas.height);
    const region = new Uint32Array(this.#memory.buffer, this.#core.output_pointer(), 8).slice();
    const pixelFormat = settings.pixelFormat ?? "rgba-unorm8";
    const imageData = new ImageData(IMAGE_DATA_CONSTRUCTION, region[0], region[1],
      allocateImageData(`${INTERFACE}.getImageData`, region[0], region[1], pixelFormat),
      settings.colorSpace ?? this.#settings.colorSpace, pixelFormat);
    if (!intersects) return imageData;
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
    const region = count === 3
      ? [0, 0, imageData.width, imageData.height]
      : [dirtyX, dirtyY, dirtyWidth, dirtyHeight].map((value) => toEnforcedLong(member, value));
    const data = imageData.data;
    if (data.buffer.detached) {
      throw new DOMException(`${INTERFACE}.putImageData: The source data has been detached.`, "InvalidStateError");
    }
    const core = this.#core;
    if (
      !core.put_image_data_region(
        imageData.width,
        imageData.height,
        destinationX,
        destinationY,
        ...region,
        this.#canvas.width,
        this.#canvas.height,
      )
    ) return;
    const [sourceX, sourceY, width, height] = new Int32Array(this.#memory.buffer, core.output_pointer(), 4);
    const pixels = allocateImageData(`${INTERFACE}.putImageData`, width, height, imageData.pixelFormat);
    for (let row = 0; row < height; row++) {
      const start = ((sourceY + row) * imageData.width + sourceX) * 4;
      pixels.set(data.subarray(start, start + width * 4), row * width * 4);
    }
    // The bitmap stores the canvas's color space; the rasterizer converts
    // the data into it as it premultiplies, in single precision (sRGB red
    // put into a display-p3 canvas reads 234, 51, 35).
    const conversion = sourceConversion({ colorSpace: imageData.colorSpace }, this.#settings.colorSpace);
    const index = this.#payloads.length;
    const result = core.record_put_image_data(index, conversion);
    if (result === 1) this.#payloads.push(imageDataPayload(imageData, pixels, width, height));
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
    const numbers = values.map(Number);
    const { source, width, height } = resolved;
    let sx = 0, sy = 0, sw = width, sh = height, dx, dy, dw, dh;
    if (count === 3) {
      [dx, dy] = numbers;
      dw = width;
      dh = height;
    } else if (count === 5) {
      [dx, dy, dw, dh] = numbers;
    } else {
      [sx, sy, sw, sh, dx, dy, dw, dh] = numbers;
    }
    if (!resolved.originClean) this.#originClean = false;
    const index = this.#sources.length;
    this.#stageFilter();
    const conversion = sourceConversion(source, this.#settings.colorSpace);
    const result = this.#core.draw_image(index, resolved.opaque ? 1 : 0, conversion, width, height, sx, sy, sw, sh, dx, dy, dw, dh);
    if (result === 1) this.#sources.push(retainSource(source));
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
    const tiles = patternRepetition(text);
    if (tiles === null) {
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
    if (width === 0 || height === 0) {
      discardSource(source);
      return null;
    }
    retainSource(source);
    const pattern = createCanvasPattern(source, width, height, tiles);
    patternSources.register(pattern, source);
    if (!resolved.originClean) taintingPaints.add(pattern);
    return pattern;
  }

  // ------------------------------------------------------- text state
  //
  // The text attributes live in the core's text state
  // (src/wasm/canvas-2d-text.watpart); src/dom/canvas-2d-text.js parses
  // the authored values as Chrome does.

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
    return canvasFontText(this.#textState());
  }

  // Chrome ignores an authored string equal to the last one it took, and a
  // value that does not parse. A font sets fontVariantCaps and fontStretch
  // and converts the spacings again for its size.
  set font(value) {
    const member = `${INTERFACE}.font`;
    const text = `${value}`;
    const authored = this.#encoder.encode(text);
    const core = this.#core;
    if (authored.length <= 1024 && this.#input(authored) >= 0 && core.font_unchanged(authored.length) === 1) return;
    const font = parseCanvasFont(text, canvasTextEnvironment(this.#canvas));
    if (font === null) return;
    const state = this.#textState();
    const serialization = this.#encoder.encode(font.serialization);
    if (serialization.length > 1024 || authored.length > 1024) {
      throw notSupported(member, "a font of more than 1024 bytes");
    }
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
      canvasSpacingPx(state.letterSpacing.number, state.letterSpacing.unit, font.size, true),
      canvasSpacingPx(state.wordSpacing.number, state.wordSpacing.unit, font.size, true),
    );
    if (result === -1) throw new RangeError(`${member}: the text state cannot grow`);
  }

  // Chrome 151 reflects the resolved direction: "inherit" reads as the
  // canvas element's direction.
  get direction() {
    const direction = this.#textState().direction;
    if (direction !== 2) return DIRECTIONS[direction];
    return DIRECTIONS[canvasTextEnvironment(this.#canvas).direction];
  }

  set direction(value) {
    const index = DIRECTIONS.indexOf(`${value}`);
    if (index >= 0) this.#setTextEnum(TEXT_DIRECTION_OFFSET, index);
  }

  #setTextEnum(offset, index) {
    if (this.#core.set_text_enum(offset, index) === -1) {
      throw new RangeError(`${INTERFACE}: the text state cannot grow`);
    }
  }

  get letterSpacing() {
    return this.#textState().letterSpacingText;
  }

  set letterSpacing(value) {
    this.#setSpacing("letterSpacing", 0, value);
  }

  get wordSpacing() {
    return this.#textState().wordSpacingText;
  }

  set wordSpacing(value) {
    this.#setSpacing("wordSpacing", 1, value);
  }

  // A spacing equal to the current serialization, a value that is not one
  // length, and the current number and unit change nothing.
  #setSpacing(member, which, value) {
    const text = `${value}`;
    const state = this.#textState();
    if (text === (which === 0 ? state.letterSpacingText : state.wordSpacingText)) return;
    const spacing = parseCanvasSpacing(text);
    if (spacing === null) return;
    const serialization = this.#encoder.encode(spacing.serialization);
    if (this.#input(serialization) < 0) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
    const px = canvasSpacingPx(spacing.number, spacing.unit, state.size, false);
    const result = this.#core.set_spacing(which, spacing.number, spacing.unit, px, serialization.length);
    if (result === -1) throw new RangeError(`${INTERFACE}.${member}: the text state cannot grow`);
    if (result === -2) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
  }

  get lang() {
    return this.#textState().lang;
  }

  set lang(value) {
    const text = `${value}`;
    if (text === this.#textState().lang) return;
    const bytes = this.#encoder.encode(text);
    const result = bytes.length > 256 ? -2 : this.#core.set_lang(this.#input(bytes));
    if (result === -1) throw new RangeError(`${INTERFACE}.lang: the text state cannot grow`);
    if (result === -2) throw notSupported(`${INTERFACE}.lang`, "a lang of more than 256 bytes");
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
      direction: state.direction === 2 ? environment.direction : state.direction,
      lang: state.lang === "inherit" ? environment.language : state.lang,
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
    const begun = this.#core.text_draw_begin(
      left,
      top,
      layout.alignFactor,
      layout.baselineY,
      layout.width,
      width,
      hasMaxWidth ? 1 : 0,
    );
    if (begun !== 1) return;
    // Blink's bounds of the draw, from the location of the text (single
    // precision, as gfx::PointF holds it).
    const drawn = hasMaxWidth && width < layout.width ? width : layout.width;
    const bounds = textDrawBounds(
      layout.layout,
      Math.fround(Math.fround(left) - layout.alignFactor * drawn),
      Math.fround(top + layout.baselineY),
      drawn,
    );
    const style = member === "fillText" ? STYLE_FILL : STYLE_STROKE;
    this.#stagePaint(style);
    this.#stageFilter(style);
    if (style === STYLE_FILL) this.#fillGlyphs(layout, bounds);
    else this.#strokeGlyphs(layout, bounds);
  }

  // One glyph run for each font of the text, its glyphs in order, all in
  // one import buffer. Fonts that the flush does not list yet join its font
  // list when the draw records.
  #fillGlyphs(layout, bounds) {
    const core = this.#core;
    const { glyphs, fonts } = layout;
    const counts = new Uint32Array(fonts.length);
    for (const glyph of glyphs) counts[glyph.font] += 1;
    let length = 0;
    for (const count of counts) if (count > 0) length += 16 + count * 12;
    // Text without glyphs still draws (canvas-2d-glyphs.watpart, $textResult).
    const pointer = length === 0 ? -1 : core.import_buffer(length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}.fillText: the command list cannot grow`);
    const view = new DataView(this.#memory.buffer, Math.max(pointer, 0), length);
    const added = [];
    let skew = 0;
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
      skew = Math.min(skew, obliqueSkew(descriptor));
      view.setUint32(at, reference, true);
      view.setUint32(at + 4, count, true);
      view.setFloat32(at + 8, descriptor.fontSize, true);
      view.setFloat32(at + 12, obliqueSkew(descriptor), true);
      at += 16;
      for (const glyph of glyphs) {
        if (glyph.font !== font) continue;
        view.setFloat32(at, glyph.x, true);
        view.setFloat32(at + 4, glyph.y, true);
        view.setUint32(at + 8, glyph.id, true);
        at += 12;
      }
    }
    // The ink bounds in text space, widened by a synthetic oblique's slant
    // (x' = x + skew * y, skew below 0).
    const ink = layout.layout.inkBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const result = core.fill_text(
      length,
      ink.x + skew * Math.max(ink.y + ink.height, 0),
      ink.y,
      ink.x + ink.width - skew * Math.max(-ink.y, 0),
      ink.y + ink.height,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    );
    if (result === 1) {
      for (const descriptor of added) {
        this.#fontIndices.set(descriptor, this.#fonts.length);
        this.#fonts.push(descriptor);
      }
    }
    this.#record(result);
  }

  // The glyph outlines, each with its origin, its scale from font units to
  // px and its slant, stroked as one path. The outlines take core path
  // slot 1, so the Path2D that it held is imported again on its next use.
  #strokeGlyphs(layout, bounds) {
    const { glyphs, fonts } = layout;
    const outlines = glyphs.map((glyph) => fonts[glyph.font].outline(glyph.id));
    let length = 0;
    for (const outline of outlines) if (outline.length > 0) length += 20 + outline.length;
    const core = this.#core;
    const pointer = length === 0 ? -1 : core.import_buffer(length);
    if (pointer === 0) throw new RangeError(`${INTERFACE}.strokeText: the path cannot grow`);
    const bytes = new Uint8Array(this.#memory.buffer, Math.max(pointer, 0), length);
    const view = new DataView(this.#memory.buffer, Math.max(pointer, 0), length);
    let at = 0;
    for (let index = 0; index < glyphs.length; index++) {
      const outline = outlines[index];
      if (outline.length === 0) continue;
      const glyph = glyphs[index];
      const font = fonts[glyph.font];
      view.setFloat32(at, glyph.x, true);
      view.setFloat32(at + 4, glyph.y, true);
      view.setFloat32(at + 8, font.fontSize / font.upem, true);
      view.setFloat32(at + 12, obliqueSkew(font), true);
      view.setUint32(at + 16, outline.length, true);
      bytes.set(outline, at + 20);
      at += 20 + outline.length;
    }
    this.#slotPath = null;
    this.#record(core.stroke_text(length, bounds.x, bounds.y, bounds.width, bounds.height));
  }

  // ------------------------------------------------------------- paths

  beginPath() {
    this.#core.path_clear(0);
  }

  // The core slot of a fill, stroke, clip or hit test: 0 the current path,
  // 1 the Path2D `path`, imported unless slot 1 holds it unchanged.
  #pathSlot(member, path) {
    if (path === null) return 0;
    if (path === this.#slotPath && path2DVersion(path) === this.#slotVersion) return 1;
    this.#slotPath = null;
    importPath(`${INTERFACE}.${member}`, this.#core, this.#memory, 1, path2DBytes(path));
    this.#slotPath = path;
    this.#slotVersion = path2DVersion(path);
    return 1;
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
    if (result === -1) throw new RangeError(`${member}: the clipping region cannot grow`);
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
    if (result === -1) throw new RangeError(`${member}: the path cannot grow`);
    return result === 1;
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
    if (result === -1) throw new RangeError(`${member}: the path cannot grow`);
    return result === 1;
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
    if (element.ownerDocument?.activeElement !== element || element === canvas || !canvas.contains(element)) return;
    const core = this.#core;
    if (core.save() < 0) throw new RangeError(`${INTERFACE}.drawFocusIfNeeded: the save stack cannot grow`);
    try {
      this.#applyFocusRingStyle();
      this.#record(core.stroke_path(this.#pathSlot("drawFocusIfNeeded", withPath ? first : null)));
    } finally {
      core.restore();
    }
  }

  // The focus ring of Chrome 151: FOCUS_RING_COLOR, FOCUS_RING_WIDTH
  // device pixels wide, centered on the path, round joins, solid.
  #applyFocusRingStyle() {
    const core = this.#core;
    core.set_global_alpha(1);
    core.set_line_cap(0);
    core.set_line_join(1);
    core.set_line_dash(0);
    core.set_line_width(FOCUS_RING_WIDTH);
    // Chrome draws the ring straight onto the canvas, without the filter.
    core.set_filter_handle(0);
    const color = FOCUS_RING_COLOR;
    const [drawRed, drawGreen, drawBlue] = convertCanvasColor(color.r, color.g, color.b, "srgb", this.#settings.colorSpace);
    core.set_style(STYLE_STROKE, color.r, color.g, color.b, color.a, drawRed, drawGreen, drawBlue, color.a, 0);
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
    if (result === -1) throw new RangeError(`${INTERFACE}: the command list cannot grow`);
    if (result === 1) this.#recorded();
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
    canvas._domCore.resourceUpdate(this.#resourceHandle, 1, canvas.width, canvas.height, contentChanged, 0);
  }

  // The pending commands as views of the core's memory: the command
  // records, the geometry of path commands and glyph runs, the clip
  // entries, the clip masks with their geometry, and the paint blocks.
  #commandList() {
    const core = this.#core;
    const buffer = this.#memory.buffer;
    return {
      bytes: new Uint8Array(buffer, core.command_pointer(), core.command_count() * COMMAND_SIZE),
      geometry: new Uint8Array(buffer, core.geometry_pointer(), core.geometry_count() * 8),
      clips: new Uint8Array(buffer, core.clip_entry_pointer(), core.clip_entry_count() * CLIP_ENTRY_SIZE),
      masks: new Uint8Array(buffer, core.mask_pointer(), core.mask_count() * MASK_SIZE),
      maskGeometry: new Uint8Array(buffer, core.mask_geometry_pointer(), core.mask_geometry_count() * 8),
      paints: new Uint8Array(buffer, core.paint_pointer(), core.paint_count() * 16),
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
    this.#originClean = true;
    this.#core.context_reset(this.#settings.alpha ? 0 : 1);
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
      originClean: this.#originClean,
      naturalDimensions: true,
    };
  }

  static {
    contextImage = (context, device = null) => context.#image(device);
  }

  get _originClean() {
    return this.#originClean;
  }

  // Asynchronous exports retain the bitmap state at the call boundary.
  _encodeBitmap(member, type, quality) {
    const encoding = encodingOptions(type, quality);
    if (!this.#originClean) {
      throw new DOMException(`${member}: Tainted canvases may not be exported.`, "SecurityError");
    }
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    if (width === 0 || height === 0) return Promise.resolve(null);
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
    if (!this.#originClean) {
      throw new DOMException("HTMLCanvasElement.toDataURL: Tainted canvases may not be exported.", "SecurityError");
    }
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    if (width === 0 || height === 0) return "data:,";
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
  recorderCore.context_reset(0);
  return recorderCore;
}

function recordedSource(core, width, height, sources, payloads, colorSpace, format) {
  const buffer = core.memory.buffer;
  const list = {
    bytes: new Uint8Array(buffer, core.command_pointer(), core.command_count() * COMMAND_SIZE).slice(),
    geometry: new Uint8Array(buffer, core.geometry_pointer(), core.geometry_count() * 8).slice(),
    clips: new Uint8Array(buffer, core.clip_entry_pointer(), core.clip_entry_count() * CLIP_ENTRY_SIZE).slice(),
    masks: new Uint8Array(buffer, core.mask_pointer(), core.mask_count() * MASK_SIZE).slice(),
    maskGeometry: new Uint8Array(buffer, core.mask_geometry_pointer(), core.mask_geometry_count() * 8).slice(),
    paints: new Uint8Array(buffer, core.paint_pointer(), core.paint_count() * 16).slice(),
    sources: sources.map(retainSource),
    payloads,
    fonts: [],
  };
  core.commands_clear();
  return { kind: "commands", width, height, opaque: false, persistent: true, colorSpace, format, list, references: 0 };
}

// The `width` x `height` image of `crop` ([sx, sy, sw, sh] in the pixels
// of `image`, a resolved source, also beyond its edges, which are
// transparent), flipped vertically when `flipY`, sampled for `quality`
// ("pixelated", "low", "medium" or "high") as drawImage() samples with
// those smoothing settings.
export function derivedImageSource(image, crop, width, height, flipY, quality) {
  const core = recorder();
  if (flipY) core.set_transform(1, 0, 0, -1, 0, height);
  if (quality === "pixelated") core.set_image_smoothing_enabled(0);
  else core.set_image_smoothing_quality(IMAGE_SMOOTHING_QUALITIES.indexOf(quality));
  // The list draws in the source's own color space (recordedSource).
  const result = core.draw_image(0, image.opaque ? 1 : 0, SOURCE_CONVERSION_NONE, image.width, image.height, ...crop, 0, 0, width, height);
  if (result === -1) throw new RangeError("ImageBitmap: the command list cannot grow");
  // The bitmap keeps its source's color space and format (a canvas's; an
  // image's is 8-bit sRGB).
  const colorSpace = image.source.colorSpace ?? "srgb";
  const format = image.source.kind === "image" ? BITMAP_FORMAT : image.source.format;
  return recordedSource(core, width, height, result === 1 ? [image.source] : [], [], colorSpace, format);
}

// The image of an ImageData: its bytes, premultiplied as putImageData()
// premultiplies them.
export function imageDataSource(imageData) {
  const core = recorder();
  const { width, height } = imageData;
  core.put_image_data_region(width, height, 0, 0, 0, 0, width, height, width, height);
  // The list draws in the data's own color space (recordedSource).
  const result = core.record_put_image_data(0, SOURCE_CONVERSION_NONE);
  if (result === -1) throw new RangeError("ImageBitmap: the command list cannot grow");
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
