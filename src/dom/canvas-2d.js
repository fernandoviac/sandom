// CanvasRenderingContext2D of a Sandom document (plans/PLAN-canvas-2d.md,
// slice 2; docs/specifications/canvas-2d.md).
//
// This object is a facade. It converts and validates arguments as Chrome's
// bindings do and forwards them to src/wasm/canvas-2d.wat, which holds the
// drawing state, the save stack and the command list. Drawing records
// commands and does no GPU work. A flush rasterizes the pending commands
// into the bitmap texture (src/dom/canvas-2d-raster.js) when paint samples
// the canvas, when another canvas draws this one, and when toBlob() reads
// it.
//
// The bitmap is a texture on the device that first flushes it: the
// renderer's device for a painted canvas. A canvas that has no bitmap when
// another canvas draws it is copied as its command list; the destination
// rasterizes that list on its own device. Thus a canvas that is never
// painted needs no device of its own.
import { getWasmBytes } from "../wasm/canvas-2d-binary.js";
import {
  BITMAP_FORMAT,
  copyBitmapTexture,
  createBitmapTexture,
  rasterizeCommands,
  readBitmapTexture,
} from "./canvas-2d-raster.js";
import { encodeJpegRgba } from "../output/jpeg-encoder.js";
import { defaultPngCodec } from "../png-codec.js";

const INTERFACE = "CanvasRenderingContext2D";
const COMMAND_SIZE = 80;
const CONSTRUCTION = Symbol("CanvasRenderingContext2D construction");
const IMAGE_DATA_CONSTRUCTION = Symbol("ImageData construction");
const STYLE_FILL = 0;
const STYLE_STROKE = 1;
const STYLE_SHADOW = 2;
const DEFAULT_JPEG_QUALITY = 0.92;

let compiledModule = null;

function instantiateCore() {
  compiledModule ??= new WebAssembly.Module(getWasmBytes());
  return new WebAssembly.Instance(compiledModule, {}).exports;
}

function hostName() {
  return typeof globalThis.Deno === "object" ? "Deno" : "browser";
}

function notSupported(member, detail = "this member") {
  return new DOMException(`${member}: Sandom does not support ${detail}`, "NotSupportedError");
}

export function readMemberNotSupported(member) {
  return notSupported(member, `this member on the ${hostName()} host: a synchronous pixel read cannot wait for the GPU`);
}

function requireArguments(member, required, actual) {
  if (actual < required) {
    throw new TypeError(
      `${INTERFACE}.${member}: ${required} argument${required === 1 ? "" : "s"} required, but only ${actual} present.`,
    );
  }
}

// WebIDL `long`: ToInt32 of the number.
function toLong(value) {
  return Number(value) | 0;
}

// WebIDL `[EnforceRange] long`.
function toEnforcedLong(member, value) {
  const number = Number(value);
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
// is not an object gives the defaults, as in Chrome. Sandom supports the
// settings of slice 2; "display-p3", "float16" and extended tone mapping
// belong to slice 7.
export function convertCanvas2DSettings(options) {
  const member = "HTMLCanvasElement.getContext";
  const source = options !== null && (typeof options === "object" || typeof options === "function")
    ? options
    : {};
  const alpha = source.alpha === undefined ? true : Boolean(source.alpha);
  const colorSpace = enumValue(member, "colorSpace", source.colorSpace, ["srgb", "display-p3"], "srgb");
  const colorType = enumValue(member, "colorType", source.colorType, ["unorm8", "float16"], "unorm8");
  const desynchronized = Boolean(source.desynchronized);
  const toneMappingSource = source.toneMapping;
  let toneMapping = "standard";
  if (toneMappingSource !== undefined && toneMappingSource !== null) {
    if (typeof toneMappingSource !== "object" && typeof toneMappingSource !== "function") {
      throw new TypeError(`${member}: toneMapping is not an object.`);
    }
    toneMapping = enumValue(member, "toneMapping.mode", toneMappingSource.mode, ["standard", "extended"], "standard");
  }
  const willReadFrequently = enumValue(
    member,
    "willReadFrequently",
    source.willReadFrequently,
    ["true", "false", "undefined"],
    "undefined",
  ) === "true";
  return Object.freeze({ alpha, colorSpace, colorType, desynchronized, toneMapping, willReadFrequently });
}

export function assertCanvas2DSettingsSupported(settings) {
  const member = "HTMLCanvasElement.getContext";
  if (settings.colorSpace !== "srgb") throw notSupported(member, `the colorSpace ${settings.colorSpace}`);
  if (settings.colorType !== "unorm8") throw notSupported(member, `the colorType ${settings.colorType}`);
  if (settings.toneMapping !== "standard") {
    throw notSupported(member, `the toneMapping mode ${settings.toneMapping}`);
  }
}

// ------------------------------------------------------------------ ImageData

let isImageData;

export class ImageData {
  #width;
  #height;
  #data;

  constructor(first, second, third, fourth) {
    if (first === IMAGE_DATA_CONSTRUCTION) {
      this.#width = second;
      this.#height = third;
      this.#data = fourth;
      return;
    }
    const count = arguments.length;
    if (count < 2) {
      throw new TypeError(`ImageData: 2 arguments required, but only ${count} present.`);
    }
    if (ArrayBuffer.isView(first)) {
      if (!(first instanceof Uint8ClampedArray)) {
        throw notSupported("ImageData", "pixel data other than a Uint8ClampedArray");
      }
      imageDataSettings(fourth);
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
      return;
    }
    imageDataSettings(third);
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
    this.#data = allocateImageBytes("ImageData", width, height);
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
    // Asserts the receiver.
    void this.#width;
    return "srgb";
  }

  get pixelFormat() {
    void this.#width;
    return "rgba-unorm8";
  }

  get [Symbol.toStringTag]() {
    return "ImageData";
  }

  static {
    isImageData = (value) => value !== null && typeof value === "object" && #width in value;
  }
}

function imageDataSettings(settings) {
  if (settings === undefined || settings === null) return;
  if (typeof settings !== "object" && typeof settings !== "function") {
    throw new TypeError("ImageData: settings is not an object.");
  }
  const colorSpace = enumValue("ImageData", "colorSpace", settings.colorSpace, ["srgb", "display-p3"], "srgb");
  if (colorSpace !== "srgb") throw notSupported("ImageData", `the colorSpace ${colorSpace}`);
  const pixelFormat = enumValue(
    "ImageData",
    "pixelFormat",
    settings.pixelFormat,
    ["rgba-unorm8", "rgba-float16"],
    "rgba-unorm8",
  );
  if (pixelFormat !== "rgba-unorm8") throw notSupported("ImageData", `the pixelFormat ${pixelFormat}`);
}

function allocateImageBytes(member, width, height) {
  const length = width * height * 4;
  if (!Number.isSafeInteger(length) || length > 0x7fffffff) {
    throw new RangeError(`${member}: Out of memory at ImageData creation.`);
  }
  return new Uint8ClampedArray(length);
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

// DOMMatrix2DInit with the WebIDL "validate and fixup (2D)" steps.
function matrixFromInit(value) {
  const member = `${INTERFACE}.setTransform`;
  if (value === undefined || value === null) return [1, 0, 0, 1, 0, 0];
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError(`${member}: The provided value is not of type 'DOMMatrix2DInit'.`);
  }
  const read = (name) => (value[name] === undefined ? undefined : Number(value[name]));
  const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map(read);
  const [m11, m12, m21, m22, m41, m42] = ["m11", "m12", "m21", "m22", "m41", "m42"].map(read);
  const pair = (short, long, fallback) => {
    if (short !== undefined && long !== undefined && !(short === long || (Number.isNaN(short) && Number.isNaN(long)))) {
      throw new TypeError(`${member}: Property mismatch on matrix initialization.`);
    }
    return long ?? short ?? fallback;
  };
  return [pair(a, m11, 1), pair(b, m12, 0), pair(c, m21, 0), pair(d, m22, 1), pair(e, m41, 0), pair(f, m42, 0)];
}

// ----------------------------------------------------------------- attributes

const COMPOSITE_OPERATIONS = [
  "source-over", "source-in", "source-out", "source-atop", "destination-over", "destination-in",
  "destination-out", "destination-atop", "lighter", "copy", "xor", "multiply", "screen", "overlay",
  "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity",
];

// Attributes of later slices: the initial value Chrome returns, the
// conversion, and the values Chrome ignores. A value equal to the initial
// value changes no output and is accepted.
const LATER_ATTRIBUTES = Object.freeze({
  lang: { initial: "inherit", type: "string" },
  font: { initial: "10px sans-serif", type: "string" },
  textAlign: { initial: "start", type: "enum", values: ["start", "end", "left", "right", "center"] },
  textBaseline: {
    initial: "alphabetic",
    type: "enum",
    values: ["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"],
  },
  direction: { initial: "inherit", type: "enum", values: ["ltr", "rtl", "inherit"] },
  fontKerning: { initial: "auto", type: "enum", values: ["auto", "normal", "none"] },
  fontStretch: {
    initial: "normal",
    type: "enum",
    values: [
      "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded",
      "expanded", "extra-expanded", "ultra-expanded",
    ],
  },
  fontVariantCaps: {
    initial: "normal",
    type: "enum",
    values: ["normal", "small-caps", "all-small-caps", "petite-caps", "all-petite-caps", "unicase", "titling-caps"],
  },
  letterSpacing: { initial: "0px", type: "string" },
  textRendering: {
    initial: "auto",
    type: "enum",
    values: ["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"],
  },
  wordSpacing: { initial: "0px", type: "string" },
  globalCompositeOperation: { initial: "source-over", type: "enum", values: COMPOSITE_OPERATIONS },
  filter: { initial: "none", type: "string" },
  imageSmoothingQuality: { initial: "low", type: "enum", values: ["low", "medium", "high"] },
  lineCap: { initial: "butt", type: "enum", values: ["butt", "round", "square"] },
  lineJoin: { initial: "miter", type: "enum", values: ["round", "bevel", "miter"] },
  imageSmoothingEnabled: { initial: true, type: "boolean" },
  shadowOffsetX: { initial: 0, type: "number" },
  shadowOffsetY: { initial: 0, type: "number" },
  shadowBlur: { initial: 0, type: "number", ignored: (value) => value < 0 },
  miterLimit: { initial: 10, type: "number", ignored: (value) => value <= 0 },
  lineDashOffset: { initial: 0, type: "number" },
});

// Methods of CanvasRenderingContext2D.prototype in Chrome 151 that a later
// slice implements.
const LATER_METHODS = Object.freeze([
  "arc", "arcTo", "beginPath", "bezierCurveTo", "clip", "closePath", "createConicGradient",
  "createLinearGradient", "createPattern", "createRadialGradient", "drawFocusIfNeeded", "ellipse",
  "fill", "fillText", "getLineDash", "isPointInPath", "isPointInStroke", "lineTo", "measureText",
  "moveTo", "quadraticCurveTo", "rect", "roundRect", "setLineDash", "stroke", "strokeText",
]);

function convertAttribute(description, value) {
  if (description.type === "boolean") return Boolean(value);
  if (description.type === "number") return Number(value);
  return String(value);
}

// ------------------------------------------------------------ sources

function retainSource(source) {
  source.references += 1;
  return source;
}

function releaseSource(source) {
  source.references -= 1;
  if (source.references > 0) return;
  if (source.kind === "texture") {
    source.texture.destroy();
  } else {
    for (const nested of source.list.sources) releaseSource(nested);
  }
}

function isSandomCanvas(value) {
  return value !== null && typeof value === "object" && value.localName === "canvas" &&
    "_canvasContextType" in value;
}

// The Sandom element that a later slice accepts as a drawImage() source.
function laterImageSource(value) {
  if (value === null || typeof value !== "object" || typeof value.localName !== "string") return null;
  if (!("_coreHandle" in value)) return null;
  if (value.localName === "img") return "an HTMLImageElement source";
  if (value.localName === "video") return "an HTMLVideoElement source";
  if (value.localName === "image" && value.namespaceURI === "http://www.w3.org/2000/svg") {
    return "an SVGImageElement source";
  }
  return null;
}

async function sessionDevice(document) {
  if (document?._preferredCanvasDevice) return document._preferredCanvasDevice;
  const adapter = await globalThis.navigator?.gpu?.requestAdapter?.();
  if (!adapter) throw new Error("Canvas 2D toBlob: WebGPU has no adapter on this host");
  const device = await adapter.requestDevice();
  if (document) document._preferredCanvasDevice ??= device;
  return document?._preferredCanvasDevice ?? device;
}

// Chrome unpremultiplies a canvas read with Skia's float raster pipeline:
// each byte times float32(1/255), the color times float32(1/alpha), then
// value * 255 rounded half to even. Measured exact for every premultiplied
// value and alpha (2026-10-10). The table holds the result for value and
// alpha, indexed alpha * 256 + value.
let unpremultiplyTable = null;

function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function unpremultiplied(value, alpha) {
  const inverse255 = Math.fround(1 / 255);
  const scale = Math.fround(1 / Math.fround(alpha * inverse255));
  const color = Math.min(1, Math.fround(Math.fround(value * inverse255) * scale));
  return roundHalfToEven(Math.fround(color * 255));
}

function unpremultipliedPixels(premultiplied) {
  if (unpremultiplyTable === null) {
    unpremultiplyTable = new Uint8Array(256 * 256);
    for (let alpha = 1; alpha < 256; alpha++) {
      for (let value = 0; value < 256; value++) {
        unpremultiplyTable[alpha * 256 + value] = unpremultiplied(value, alpha);
      }
    }
  }
  const pixels = new Uint8Array(premultiplied.length);
  for (let offset = 0; offset < premultiplied.length; offset += 4) {
    const alpha = premultiplied[offset + 3];
    if (alpha === 0) continue;
    const row = alpha * 256;
    pixels[offset] = unpremultiplyTable[row + premultiplied[offset]];
    pixels[offset + 1] = unpremultiplyTable[row + premultiplied[offset + 1]];
    pixels[offset + 2] = unpremultiplyTable[row + premultiplied[offset + 2]];
    pixels[offset + 3] = alpha;
  }
  return pixels;
}

// A JPEG has no alpha: the bitmap composites onto opaque black, which is
// its premultiplied color.
function opaqueOverBlack(premultiplied) {
  const pixels = premultiplied.slice();
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  return pixels;
}

function reportCallbackError(error) {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else queueMicrotask(() => {
    throw error;
  });
}

// ------------------------------------------------------------ the context

export class CanvasRenderingContext2D {
  #canvas;
  #core;
  #memory;
  #settings;
  #resourceHandle;
  #sources = [];
  #payloads = [];
  #bitmap = null;
  #clearBitmap = true;
  #dirty = false;
  #snapshot = null;
  #originClean = true;
  #shutdown = false;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();

  constructor(token, canvas, settings, resourceHandle) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#canvas = canvas;
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
    return this.#canvas;
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
      core.set_transform(...matrixFromInit(values[0]));
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

  get fillStyle() {
    return this.#styleText(STYLE_FILL);
  }

  set fillStyle(value) {
    this.#setStyle("fillStyle", STYLE_FILL, value);
  }

  get strokeStyle() {
    return this.#styleText(STYLE_STROKE);
  }

  set strokeStyle(value) {
    this.#setStyle("strokeStyle", STYLE_STROKE, value);
  }

  // A shadow color is state of slice 4. A transparent color draws no
  // shadow, so it is accepted and kept.
  get shadowColor() {
    return this.#styleText(STYLE_SHADOW);
  }

  set shadowColor(value) {
    this.#setStyle("shadowColor", STYLE_SHADOW, value);
  }

  #styleText(which) {
    const length = this.#core.style_text(which);
    return this.#decoder.decode(new Uint8Array(this.#memory.buffer, this.#core.output_pointer(), length));
  }

  #resolveColor(text) {
    const parsed = this.#canvas._domCore.parseColor(text);
    if (parsed !== "currentColor") return parsed;
    // currentcolor is the canvas element's computed color, black outside a document.
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
    const text = String(value);
    const color = this.#resolveColor(text);
    if (color === null) return;
    if (which === STYLE_SHADOW && Math.floor(Math.fround(Math.fround(color.a) * 255) + 0.5) !== 0) {
      throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
    }
    const core = this.#core;
    const input = new Uint8Array(this.#memory.buffer, core.input_pointer(), core.input_capacity());
    const { written } = this.#encoder.encodeInto(text, input);
    const result = core.set_style(which, color.r, color.g, color.b, color.a, written);
    if (result === -2) throw notSupported(`${INTERFACE}.${member}`, `the value ${text}`);
  }

  // -------------------------------------------------------- rectangles

  fillRect(x, y, width, height) {
    requireArguments("fillRect", 4, arguments.length);
    this.#record(this.#core.fill_rect(Number(x), Number(y), Number(width), Number(height)));
  }

  strokeRect(x, y, width, height) {
    requireArguments("strokeRect", 4, arguments.length);
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
        allocateImageBytes(`${INTERFACE}.createImageData`, first.width, first.height),
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
    imageDataSettings(third);
    return new ImageData(
      IMAGE_DATA_CONSTRUCTION,
      width,
      height,
      allocateImageBytes(`${INTERFACE}.createImageData`, width, height),
    );
  }

  getImageData() {
    void this.#core;
    throw readMemberNotSupported(`${INTERFACE}.getImageData`);
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
    const bytes = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((sourceY + row) * imageData.width + sourceX) * 4;
      bytes.set(data.subarray(start, start + width * 4), row * width * 4);
    }
    const index = this.#payloads.length;
    const result = core.record_put_image_data(index);
    if (result === 1) this.#payloads.push({ width, height, bytes });
    this.#record(result);
  }

  // ------------------------------------------------------------ images

  drawImage(image, ...values) {
    const count = arguments.length;
    requireArguments("drawImage", 3, count);
    if (count !== 3 && count !== 5 && count !== 9) {
      throw new TypeError(`${INTERFACE}.drawImage: Overload resolution failed.`);
    }
    if (!isSandomCanvas(image)) {
      const later = laterImageSource(image);
      if (later !== null) throw notSupported(`${INTERFACE}.drawImage`, later);
      throw new TypeError(
        `${INTERFACE}.drawImage: The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.`,
      );
    }
    const numbers = values.map(Number);
    const width = image.width;
    const height = image.height;
    if (width === 0 || height === 0) {
      throw new DOMException(
        `${INTERFACE}.drawImage: The image argument is a canvas element with a width or height of 0.`,
        "InvalidStateError",
      );
    }
    if (image._canvasContextType === null) return;
    if (image._canvasContextType !== "2d") {
      throw notSupported(`${INTERFACE}.drawImage`, `a ${image._canvasContextType} HTMLCanvasElement source`);
    }
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
    const sourceContext = image._canvasContext;
    if (!sourceContext.#originClean) this.#originClean = false;
    const source = sourceContext.#snapshotForCopy();
    const index = this.#sources.length;
    const result = this.#core.draw_image(index, width, height, sx, sy, sw, sh, dx, dy, dw, dh);
    if (result === 1) this.#sources.push(retainSource(source));
    this.#record(result);
  }

  // -------------------------------------------------- later slices

  static {
    for (const name of LATER_METHODS) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        writable: true,
        value: {
          [name]() {
            void this.#core;
            throw notSupported(`${INTERFACE}.${name}`);
          },
        }[name],
      });
    }
    for (const [name, description] of Object.entries(LATER_ATTRIBUTES)) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        get() {
          void this.#core;
          return description.initial;
        },
        set(value) {
          void this.#core;
          const converted = convertAttribute(description, value);
          if (description.type === "enum" && !description.values.includes(converted)) return;
          if (description.type === "number" && (!Number.isFinite(converted) || description.ignored?.(converted))) {
            return;
          }
          if (converted === description.initial) return;
          throw notSupported(`${INTERFACE}.${name}`, `the value ${String(value)}`);
        },
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
  }

  #updateResource(contentChanged) {
    const canvas = this.#canvas;
    canvas._domCore.resourceUpdate(this.#resourceHandle, 1, canvas.width, canvas.height, contentChanged, 0);
  }

  // The pending commands as an independent list.
  #commandList() {
    const count = this.#core.command_count();
    const pointer = this.#core.command_pointer();
    return {
      bytes: new Uint8Array(this.#memory.buffer, pointer, count * COMMAND_SIZE),
      sources: this.#sources,
      payloads: this.#payloads,
    };
  }

  // A source for drawImage() and toBlob() with the current bitmap. A canvas
  // with a bitmap flushes and copies the texture on its device; a canvas
  // without one gives its blank bitmap and its command list.
  #snapshotForCopy() {
    if (this.#snapshot !== null) return this.#snapshot;
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    let snapshot;
    if (this.#bitmap !== null) {
      const { device } = this.#bitmap;
      const bitmap = this.#flush(device);
      snapshot = {
        kind: "texture",
        device,
        texture: copyBitmapTexture(device, bitmap.texture, width, height, "Sandom Canvas 2D copy"),
        width,
        height,
        references: 1,
      };
    } else {
      const list = this.#commandList();
      snapshot = {
        kind: "commands",
        width,
        height,
        opaque: !this.#settings.alpha,
        list: {
          bytes: list.bytes.slice(),
          sources: list.sources.map(retainSource),
          payloads: list.payloads.slice(),
        },
        references: 1,
      };
    }
    this.#snapshot = snapshot;
    return snapshot;
  }

  // Rasterizes the pending commands into the bitmap on `device`.
  #flush(device) {
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    if (this.#bitmap !== null && this.#bitmap.device !== device) {
      throw new Error(
        "Canvas 2D bitmap is on another GPUDevice than the one that paints or copies it; Sandom does not read a canvas bitmap back to move it",
      );
    }
    if (this.#bitmap !== null && (this.#bitmap.width !== width || this.#bitmap.height !== height)) {
      this.#bitmap.texture.destroy();
      this.#bitmap = null;
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
        texture: createBitmapTexture(device, width, height, `Sandom Canvas 2D ${this.paintSource.sourceIdentifier}`),
      };
      this.#clearBitmap = true;
    }
    const list = this.#commandList();
    if (list.bytes.length > 0 || this.#clearBitmap) {
      rasterizeCommands(
        device,
        { texture: this.#bitmap.texture, width, height, opaque: !this.#settings.alpha },
        list,
        this.#clearBitmap,
      );
      this.#discardCommands();
      this.#clearBitmap = false;
    }
    this.#dirty = false;
    return this.#bitmap;
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
      const bitmap = this.#flush(targetDevice);
      source = Object.freeze({
        kind: "gpu-texture",
        width,
        height,
        device: targetDevice,
        texture: bitmap.texture,
        format: BITMAP_FORMAT,
        descriptor: Object.freeze({
          width,
          height,
          rowStride: width * 4,
          channelLayout: "rgba",
          sampleType: "uint8",
          bitsPerSample: 8,
          colorEncoding: Object.freeze({
            primaries: "srgb",
            transferFunction: "srgb",
            whitePoint: "D65",
            referenceWhiteLuminance: 203,
          }),
          alphaMode: "premultiplied",
          canvasToneMapping: "standard",
          metadata: Object.freeze({}),
        }),
        toneMapping: "standard",
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
  // bitmap and all state.
  #resetForBitmap(request) {
    this.#discardCommands();
    this.#dropSnapshot();
    this.#core.context_reset(this.#settings.alpha ? 0 : 1);
    this.#bitmap?.texture.destroy();
    this.#bitmap = null;
    this.#clearBitmap = true;
    this.#dirty = false;
    this.#updateResource(true);
    if (request.sizeChanged) this.#canvas._notifyCanvasSize();
    else this.#canvas._notifyCanvasPaint();
  }

  // HTMLCanvasElement.toBlob for this context. The bitmap state is taken
  // when the call is made; the read completes through mapAsync.
  _toBlob(callback, type, quality) {
    if (!this.#originClean) {
      throw new DOMException("HTMLCanvasElement.toBlob: Tainted canvases may not be exported.", "SecurityError");
    }
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    const jpeg = String(type).toLowerCase() === "image/jpeg";
    const jpegQuality = typeof quality === "number" && quality >= 0 && quality <= 1
      ? quality
      : DEFAULT_JPEG_QUALITY;
    const snapshot = width === 0 || height === 0 ? null : retainSource(this.#snapshotForCopy());
    const document = this.#canvas.ownerDocument;
    void (async () => {
      let blob = null;
      try {
        if (snapshot !== null) {
          const premultiplied = await readSnapshot(snapshot, document);
          const bytes = jpeg
            ? await encodeJpegRgba({ width, height, pixels: opaqueOverBlack(premultiplied) }, {
              quality: Math.round(jpegQuality * 100),
            })
            : await defaultPngCodec.encode(unpremultipliedPixels(premultiplied), width, height);
          blob = new Blob([bytes], { type: jpeg ? "image/jpeg" : "image/png" });
        }
      } catch (error) {
        reportCallbackError(error);
      } finally {
        if (snapshot !== null) releaseSource(snapshot);
      }
      try {
        callback.call(undefined, blob);
      } catch (error) {
        reportCallbackError(error);
      }
    })();
  }

  shutdown() {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#discardCommands();
    this.#dropSnapshot();
    this.#bitmap?.texture.destroy();
    this.#bitmap = null;
    this.#canvas._domCore.resourceNodeDetach(this.#canvas._coreHandle);
    this.#canvas._domCore.resourceRelease(this.#resourceHandle);
  }
}

async function readSnapshot(snapshot, document) {
  if (snapshot.kind === "texture") {
    return await readBitmapTexture(snapshot.device, snapshot.texture, snapshot.width, snapshot.height);
  }
  const device = await sessionDevice(document);
  const texture = createBitmapTexture(device, snapshot.width, snapshot.height, "Sandom Canvas 2D toBlob");
  try {
    rasterizeCommands(
      device,
      { texture, width: snapshot.width, height: snapshot.height, opaque: snapshot.opaque },
      snapshot.list,
      true,
    );
    return await readBitmapTexture(device, texture, snapshot.width, snapshot.height);
  } finally {
    texture.destroy();
  }
}

// Creates the 2D context of `canvas`. The canvas resource that the element
// registered (src/dom/canvas.js) carries the bitmap into paint.
export function createCanvasRenderingContext2D(canvas, settings, resourceHandle) {
  return new CanvasRenderingContext2D(CONSTRUCTION, canvas, settings, resourceHandle);
}

// HTMLCanvasElement.toBlob(callback, type, quality).
export function canvasToBlob(canvas, argumentCount, callback, type, quality) {
  if (argumentCount < 1) {
    throw new TypeError("HTMLCanvasElement.toBlob: 1 argument required, but only 0 present.");
  }
  if (typeof callback !== "function") {
    throw new TypeError("HTMLCanvasElement.toBlob: parameter 1 is not of type 'Function'.");
  }
  const contextType = canvas._canvasContextType;
  if (contextType === "2d") {
    canvas._canvasContext._toBlob(callback, type, quality);
    return;
  }
  if (contextType !== null) {
    throw notSupported("HTMLCanvasElement.toBlob", `a ${contextType} canvas`);
  }
  // A canvas without a context has a transparent black bitmap.
  const width = canvas.width;
  const height = canvas.height;
  const jpeg = String(type).toLowerCase() === "image/jpeg";
  const jpegQuality = typeof quality === "number" && quality >= 0 && quality <= 1 ? quality : DEFAULT_JPEG_QUALITY;
  void (async () => {
    let blob = null;
    try {
      if (width > 0 && height > 0) {
        const blank = new Uint8Array(width * height * 4);
        const bytes = jpeg
          ? await encodeJpegRgba({ width, height, pixels: opaqueOverBlack(blank) }, {
            quality: Math.round(jpegQuality * 100),
          })
          : await defaultPngCodec.encode(blank, width, height);
        blob = new Blob([bytes], { type: jpeg ? "image/jpeg" : "image/png" });
      }
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
