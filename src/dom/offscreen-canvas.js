// OffscreenCanvas, OffscreenCanvasRenderingContext2D and
// HTMLCanvasElement.transferControlToOffscreen() of a Sandom document
// (plans/dom/PLAN-canvas-2d.md, slice 6; docs/specifications/canvas-2d.md,
// "OffscreenCanvas").
//
// An OffscreenCanvas draws with the CanvasRenderingContext2D of
// src/dom/canvas-2d.js through a host object that has the members of a
// canvas element that the context reads; the context's `canvas` is the
// OffscreenCanvas. Its bitmap is a canvas resource of the DOM core that no
// node shows, or, after transferControlToOffscreen(), the resource of the
// placeholder canvas element, which paints the bitmap. Scripts, the
// renderer and the bitmap share one thread and one GPU device, as for a
// canvas element.
//
// The members, their arguments and their errors follow Chrome (measured on
// the pinned Chrome 151, test/canvas/canvas_2d_image_parity_test.js). Sandom gives
// an OffscreenCanvas a 2D context only: getContext() with "webgpu",
// "webgl", "webgl2" or "bitmaprenderer" returns null.
import {
  CanvasRenderingContext2D,
  convertCanvas2DSettings,
  createCanvasRenderingContext2D,
  registerOffscreenCanvasState,
  releaseSource,
} from "./canvas-2d.js";
import { createImageBitmapOf } from "./canvas-image-bitmap.js";

const INTERFACE = "OffscreenCanvas";
const CONTEXT_TYPES = ["2d", "bitmaprenderer", "webgl", "webgl2", "webgpu"];
// The document of the window whose OffscreenCanvas constructor made the
// canvas (offscreenCanvasConstructor).
const OWNER_DOCUMENT = Symbol("OffscreenCanvas document");
const PLACEHOLDER = Symbol("OffscreenCanvas placeholder construction");

let canvasState;
let nextOffscreenIdentifier = 1;

// WebIDL [EnforceRange] unsigned long long, as Chrome words its errors.
function enforcedDimension(prefix, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${prefix}: Value is not of type 'unsigned long'.`);
  const truncated = Math.trunc(number);
  if (truncated < 0 || truncated > 0xffffffff) {
    throw new TypeError(`${prefix}: Value is outside the 'unsigned long' value range.`);
  }
  return truncated;
}

export class OffscreenCanvas extends EventTarget {
  #document;
  #width;
  #height;
  #context = null;
  #contextType = null;
  // The canvas element that shows this canvas's bitmap, or null.
  #placeholder;
  #resourceHandle = null;
  #handlers = { contextlost: null, contextrestored: null };

  constructor(width, height, placeholder = undefined) {
    const count = arguments.length;
    super();
    const document = new.target?.[OWNER_DOCUMENT];
    if (document === undefined) throw new TypeError("Failed to construct 'OffscreenCanvas': Illegal constructor");
    if (count < 2) {
      throw new TypeError(`Failed to construct 'OffscreenCanvas': 2 arguments required, but only ${count} present.`);
    }
    const prefix = "Failed to construct 'OffscreenCanvas'";
    this.#width = enforcedDimension(prefix, width);
    this.#height = enforcedDimension(prefix, height);
    this.#document = document;
    this.#placeholder = placeholder?.token === PLACEHOLDER ? placeholder.element : null;
  }

  get width() {
    return this.#width;
  }

  set width(value) {
    this.#width = enforcedDimension(`${INTERFACE}.width`, value);
    this.#context?._resetForSize();
  }

  get height() {
    return this.#height;
  }

  set height(value) {
    this.#height = enforcedDimension(`${INTERFACE}.height`, value);
    this.#context?._resetForSize();
  }

  get oncontextlost() {
    return this.#handlers.contextlost;
  }

  set oncontextlost(value) {
    this.#handlers.contextlost = typeof value === "function" || (typeof value === "object" && value !== null)
      ? value
      : null;
  }

  get oncontextrestored() {
    return this.#handlers.contextrestored;
  }

  set oncontextrestored(value) {
    this.#handlers.contextrestored = typeof value === "function" || (typeof value === "object" && value !== null)
      ? value
      : null;
  }

  getContext(contextId, options = undefined) {
    if (arguments.length < 1) {
      throw new TypeError(`${INTERFACE}.getContext: 1 argument required, but only 0 present.`);
    }
    const type = String(contextId);
    if (!CONTEXT_TYPES.includes(type)) {
      throw new TypeError(
        `${INTERFACE}.getContext: The provided value '${type}' is not a valid enum value of type OffscreenRenderingContextType.`,
      );
    }
    if (type !== "2d") return null;
    const member = `${INTERFACE}.getContext`;
    const settings = convertCanvas2DSettings(options, member);
    if (this.#contextType === "2d") return this.#context;
    this.#contextType = "2d";
    this.#context = this.#createContext(settings);
    return this.#context;
  }

  // The context draws into the placeholder's canvas resource, or into a
  // resource of its own that no node shows.
  #createContext(settings) {
    const width = () => this.#width;
    const height = () => this.#height;
    const placeholder = this.#placeholder;
    const core = this.#document._domCore;
    let resourceHandle;
    if (placeholder !== null) {
      const element = placeholder._canvasContext;
      resourceHandle = element.webgpuContext._resourceHandle;
      this.#document._canvasContexts?.delete(element.webgpuContext);
    } else {
      resourceHandle = core.resourceRegister(2, `offscreen:${nextOffscreenIdentifier++}`);
      core.resourceUpdate(resourceHandle, 0, this.#width, this.#height);
    }
    this.#resourceHandle = resourceHandle;
    const host = Object.freeze({
      get width() {
        return width();
      },
      get height() {
        return height();
      },
      _domCore: core,
      ownerDocument: this.#document,
      isConnected: false,
      parentElement: null,
      _coreHandle: placeholder?._coreHandle,
      _notifyCanvasPaint: () => placeholder?._notifyCanvasPaint(),
      _notifyCanvasSize: () => placeholder?._notifyCanvasSize(),
    });
    const context = createCanvasRenderingContext2D(host, settings, resourceHandle, this);
    Object.setPrototypeOf(context, offscreenContextPrototype());
    this.#document._canvasContexts?.add(context);
    return context;
  }

  convertToBlob(options = undefined) {
    const member = `${INTERFACE}.convertToBlob`;
    let type = "image/png";
    let quality;
    if (options !== undefined && options !== null) {
      if (typeof options !== "object" && typeof options !== "function") {
        return Promise.reject(new TypeError(`${member}: The provided value is not of type 'ImageEncodeOptions'.`));
      }
      quality = options.quality === undefined ? undefined : Number(options.quality);
      if (options.type !== undefined) type = String(options.type);
    }
    const context = this.#context;
    if (context !== null && !context._originClean) {
      return Promise.reject(new DOMException(`${member}: Tainted "OffscreenCanvas" may not be exported.`, "SecurityError"));
    }
    if (context === null) {
      return Promise.reject(new DOMException(`${member}: "OffscreenCanvas" has no rendering context.`, "InvalidStateError"));
    }
    if (this.#width === 0 || this.#height === 0) {
      return Promise.reject(new DOMException(`${member}: The size of "OffscreenCanvas" is zero.`, "IndexSizeError"));
    }
    try {
      return context._encodeBitmap(member, type, quality);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  transferToImageBitmap() {
    const member = `${INTERFACE}.transferToImageBitmap`;
    if (this.#context === null) {
      throw new DOMException(
        `${member}: Cannot transfer an ImageBitmap from an OffscreenCanvas with no context`,
        "InvalidStateError",
      );
    }
    if (this.#width === 0 || this.#height === 0) {
      throw new DOMException(`${member}: ImageBitmap construction failed`, "UnknownError");
    }
    const image = this.#context._transferImage();
    const bitmap = createImageBitmapOf(image);
    releaseSource(image.source);
    return bitmap;
  }

  get [Symbol.toStringTag]() {
    return INTERFACE;
  }

  static {
    canvasState = (value) =>
      #width in value ? { width: value.#width, height: value.#height, context: value.#context } : undefined;
  }
}

// The state of an OffscreenCanvas for resolveImageSource() (src/dom/
// canvas-2d.js): its size and its 2D context or null; undefined when
// `value` is not an OffscreenCanvas.
export function offscreenCanvasState(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return canvasState(value);
}
registerOffscreenCanvasState(offscreenCanvasState);

// The OffscreenCanvas constructor of the window of `document`: a function,
// so that a call without `new` throws Chrome's error.
export function offscreenCanvasConstructor(document) {
  // The parameters give the constructor Chrome's length (2); Reflect.construct
  // reads them from `arguments`.
  function OffscreenCanvas(_width, _height) {
    if (new.target === undefined) {
      throw new TypeError(
        "Failed to construct 'OffscreenCanvas': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      );
    }
    return Reflect.construct(OffscreenCanvasBase, arguments, new.target);
  }
  Object.defineProperty(OffscreenCanvas, OWNER_DOCUMENT, { value: document });
  Object.defineProperty(OffscreenCanvas, "prototype", { value: OffscreenCanvasBase.prototype, writable: false });
  Object.setPrototypeOf(OffscreenCanvas, OffscreenCanvasBase);
  return OffscreenCanvas;
}

const OffscreenCanvasBase = OffscreenCanvas;

// ------------------------------------------- OffscreenCanvasRenderingContext2D
//
// The members of CanvasRenderingContext2D except drawFocusIfNeeded(), as
// Chrome has them, on a prototype of its own: a context of an
// OffscreenCanvas is not an instance of CanvasRenderingContext2D.

let offscreenPrototype = null;

export function OffscreenCanvasRenderingContext2D() {
  throw new TypeError("Failed to construct 'OffscreenCanvasRenderingContext2D': Illegal constructor");
}

function offscreenContextPrototype() {
  if (offscreenPrototype !== null) return offscreenPrototype;
  const descriptors = Object.getOwnPropertyDescriptors(CanvasRenderingContext2D.prototype);
  delete descriptors.drawFocusIfNeeded;
  delete descriptors.constructor;
  descriptors[Symbol.toStringTag] = { configurable: true, get: () => "OffscreenCanvasRenderingContext2D" };
  offscreenPrototype = OffscreenCanvasRenderingContext2D.prototype;
  Object.defineProperties(offscreenPrototype, descriptors);
  return offscreenPrototype;
}

// ------------------------------------------------ transferControlToOffscreen

// HTMLCanvasElement.transferControlToOffscreen(): `canvas` becomes the
// placeholder of a new OffscreenCanvas of its size. The element keeps its
// canvas resource, so layout and paint go on through it; the resource's
// bitmap is the OffscreenCanvas's once that has a 2D context. The element
// takes no context afterwards, and a width or height assignment through
// its IDL attributes throws.
export function transferControlToOffscreen(canvas) {
  const member = "HTMLCanvasElement.transferControlToOffscreen";
  if (canvas._canvasContextType === "placeholder") {
    throw new DOMException(`${member}: Cannot transfer control from a canvas for more than one time.`, "InvalidStateError");
  }
  if (canvas._canvasContextType !== null) {
    throw new DOMException(`${member}: Cannot transfer control from a canvas that has a rendering context.`, "InvalidStateError");
  }
  const document = canvas.ownerDocument;
  const Constructor = document._offscreenCanvasConstructor ??= offscreenCanvasConstructor(document);
  const offscreen = new Constructor(canvas.width, canvas.height, { token: PLACEHOLDER, element: canvas });
  // The element's WebGPU context keeps the canvas resource until the
  // OffscreenCanvas takes a 2D context.
  const webgpuContext = canvas._canvasContext;
  canvas._canvasContext = Object.freeze({
    webgpuContext,
    get offscreenContext() {
      const state = offscreenCanvasState(offscreen);
      return state.context;
    },
    get paintSource() {
      return this.offscreenContext?.paintSource ?? webgpuContext.paintSource;
    },
    get _resourceHandle() {
      return webgpuContext._resourceHandle;
    },
    // The element's own width and height do not change the bitmap.
    attributeChanged() {},
    resetBitmap() {},
    shutdown() {
      return this.offscreenContext === null ? webgpuContext.shutdown() : undefined;
    },
  });
  canvas._canvasContextType = "placeholder";
  return offscreen;
}
