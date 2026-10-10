import {
  SDDocument,
  SDDocumentFragment,
  SDElement,
  SDHTMLButtonElement,
  SDHTMLCanvasElement,
  SDHTMLElement,
  SDHTMLFormElement,
  SDHTMLIFrameElement,
  SDHTMLInputElement,
  SDHTMLScriptElement,
  SDHTMLSelectElement,
  SDHTMLTemplateElement,
  SDNode,
  SDShadowRoot,
  SDSVGElement,
  SDTextNode,
} from "./node.js";
import { createDOMParserClass } from "./dom-parser.generated.js";
import { parseHTMLDocument } from "./html.js";
import { parseXMLDocument } from "./xml.js";
import { SDRange, SDSelection } from "./selection.js";
import { SandomGPUCanvasContext } from "./canvas.js";
import { CanvasRenderingContext2D, ImageData } from "./canvas-2d.js";
import {
  CustomElementRegistry,
  CustomStateSet,
  ElementInternals,
} from "./custom-elements.js";
import {
  addEventListener as addComponentEventListener,
  dispatchEvent as dispatchComponentEvent,
  removeEventListener as removeComponentEventListener,
  SDClipboardEvent,
  SDDataTransfer,
  SDFocusEvent,
  SDKeyboardEvent,
  SDMouseEvent,
  SDPointerEvent,
  SDSubmitEvent,
  SDToggleEvent,
} from "./events.js";
import {
  CSS,
  CSSFontFaceRule,
  CSSGroupingRule,
  CSSKeyframeRule,
  CSSKeyframesRule,
  CSSMediaRule,
  CSSRule,
  CSSStyleRule,
  CSSStyleSheet,
  CSSSupportsRule,
  SDStyleDeclaration as CSSStyleDeclaration,
} from "./stylesheet.js";
import { MediaQueryList } from "./media-query-list.js";
import {
  DocumentMutationObserver,
  MutationRecord,
} from "./mutation-observer.js";
import {
  DocumentIntersectionObserver,
  DocumentResizeObserver,
} from "./rendering-observers.js";
import {
  createImplicitComponentEnvironment,
  HashChangeEvent,
  History,
  Location,
  Navigator,
  PopStateEvent,
  Screen,
  ScreenOrientation,
} from "./component-environment.js";
import { scrollRead } from "./scroll-core.js";

const animationFrameOwnerFinalizer = new FinalizationRegistry(
  ({ coreReference, owner }) => {
    coreReference.deref()?.status("animation_frame_surface_discard", owner);
  },
);

// window.scrollX and scrollY (and the visual viewport's page offsets): the
// effective offset, slot 2 left or 3 top, of the component surface's
// viewport.
function viewportScrollOffset(document, slot) {
  const surface = document._componentRenderSurface;
  return surface ? scrollRead(surface.viewport, slot) : 0;
}

let ambientComponentOwnership = null;
let ambientFilePreparationCount = 0;
let ambientFilePreparationTail = Promise.resolve();

function descriptorsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set;
}

export async function acquireAmbientGlobalOwnership(kind) {
  if (!["component-session", "file-preparation"].includes(kind)) {
    throw new TypeError(`Unknown ambient global owner ${JSON.stringify(kind)}`);
  }

  const ownership = Symbol(kind);
  if (kind === "component-session") {
    if (
      ambientComponentOwnership !== null || ambientFilePreparationCount > 0
    ) {
      throw new Error(
        "Cannot start an ambient component session while another ambient owner is active",
      );
    }
    ambientComponentOwnership = ownership;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (ambientComponentOwnership !== ownership) {
        throw new Error("Ambient component ownership changed unexpectedly");
      }
      ambientComponentOwnership = null;
    };
  }

  if (ambientComponentOwnership !== null) {
    throw new Error(
      "Cannot prepare a file while an ambient component session is active",
    );
  }
  ambientFilePreparationCount += 1;
  const previousPreparation = ambientFilePreparationTail;
  let releasePreparation;
  ambientFilePreparationTail = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  await previousPreparation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ambientFilePreparationCount -= 1;
    releasePreparation();
  };
}

export function snapshotAmbientGlobalDescriptors() {
  return new Map(
    Reflect.ownKeys(globalThis).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
}

export function restoreAmbientGlobalDescriptors(previousDescriptors) {
  if (!(previousDescriptors instanceof Map)) {
    throw new TypeError("Ambient global descriptor snapshot must be a Map");
  }
  const errors = [];
  for (const name of Reflect.ownKeys(globalThis).reverse()) {
    if (previousDescriptors.has(name)) continue;
    try {
      if (!delete globalThis[name]) {
        throw new TypeError(`Cannot remove installed global ${String(name)}`);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [name, descriptor] of previousDescriptors) {
    if (
      descriptorsEqual(
        descriptor,
        Object.getOwnPropertyDescriptor(globalThis, name),
      )
    ) continue;
    try {
      Object.defineProperty(globalThis, name, descriptor);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore ambient globals");
  }
}

export function installComponentGlobals(
  target,
  document,
  componentEnvironment = createImplicitComponentEnvironment(target, document),
) {
  if (componentEnvironment.document !== document) {
    throw new TypeError(
      "The component environment document does not match the installed document",
    );
  }
  if (componentEnvironment.target !== target) {
    throw new TypeError(
      "The component environment target does not match the selected realm",
    );
  }
  const constructors = {
    Node: SDNode,
    Element: SDElement,
    HTMLElement: SDHTMLElement,
    SVGElement: SDSVGElement,
    ClipboardEvent: SDClipboardEvent,
    DataTransfer: SDDataTransfer,
    FocusEvent: SDFocusEvent,
    KeyboardEvent: SDKeyboardEvent,
    MouseEvent: SDMouseEvent,
    PointerEvent: SDPointerEvent,
    SubmitEvent: SDSubmitEvent,
    ToggleEvent: SDToggleEvent,
    HTMLButtonElement: SDHTMLButtonElement,
    HTMLCanvasElement: SDHTMLCanvasElement,
    GPUCanvasContext: SandomGPUCanvasContext,
    CanvasRenderingContext2D,
    ImageData,
    HTMLTemplateElement: SDHTMLTemplateElement,
    HTMLInputElement: SDHTMLInputElement,
    HTMLFormElement: SDHTMLFormElement,
    HTMLOptionElement: SDHTMLElement,
    HTMLSelectElement: SDHTMLSelectElement,
    HTMLTextAreaElement: SDHTMLElement,
    HTMLScriptElement: SDHTMLScriptElement,
    HTMLIFrameElement: SDHTMLIFrameElement,
    Document: class Document extends SDDocument {
      constructor(options = {}) {
        super({ ...options, core: document._domCore });
      }
      static [Symbol.hasInstance](value) {
        return value instanceof SDDocument;
      }
    },
    Range: class Range extends SDRange {
      constructor() {
        super(document);
      }
      static [Symbol.hasInstance](value) {
        return value instanceof SDRange;
      }
    },
    Selection: SDSelection,
    DocumentFragment: class DocumentFragment extends SDDocumentFragment {
      constructor() {
        super(document);
      }
      static [Symbol.hasInstance](value) {
        return value instanceof SDDocumentFragment;
      }
    },
    ShadowRoot: SDShadowRoot,
    Text: SDTextNode,
    DOMParser: createDOMParserClass({
      createDocument: () => new SDDocument({ core: document._domCore }),
      parseHTMLDocument,
      parseXMLDocument,
    }),
    CustomElementRegistry: class extends CustomElementRegistry {
      constructor(options = {}) {
        super({ ...options, core: document._domCore });
      }
      static [Symbol.hasInstance](value) {
        return value instanceof CustomElementRegistry;
      }
    },
    ElementInternals,
    CustomStateSet,
    CSSStyleSheet: class extends CSSStyleSheet {
      constructor(options = {}) {
        super({ ...options, document, core: document._domCore });
      }
      static [Symbol.hasInstance](value) {
        return value instanceof CSSStyleSheet;
      }
    },
    CSSRule,
    CSSStyleRule,
    CSSGroupingRule,
    CSSMediaRule,
    CSSSupportsRule,
    CSSFontFaceRule,
    CSSKeyframesRule,
    CSSKeyframeRule,
    CSSStyleDeclaration,
    MediaQueryList,
    MutationRecord,
    Location,
    History,
    Navigator,
    Screen,
    ScreenOrientation,
    PopStateEvent,
    HashChangeEvent,
  };
  constructors.NodeFilter = Object.freeze({
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
    SHOW_ALL: 0xFFFFFFFF,
    SHOW_ELEMENT: 0x1,
    SHOW_ATTRIBUTE: 0x2,
    SHOW_TEXT: 0x4,
    SHOW_CDATA_SECTION: 0x8,
    SHOW_ENTITY_REFERENCE: 0x10,
    SHOW_ENTITY: 0x20,
    SHOW_PROCESSING_INSTRUCTION: 0x40,
    SHOW_COMMENT: 0x80,
    SHOW_DOCUMENT: 0x100,
    SHOW_DOCUMENT_TYPE: 0x200,
    SHOW_DOCUMENT_FRAGMENT: 0x400,
    SHOW_NOTATION: 0x800,
  });
  for (const [name, constructor] of Object.entries(constructors)) {
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: constructor,
    });
  }
  Object.defineProperty(target, "MutationObserver", {
    configurable: true,
    writable: true,
    value: class MutationObserver extends DocumentMutationObserver {
      constructor(callback) {
        super(document, callback);
      }
    },
  });
  Object.defineProperty(target, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class ResizeObserver extends DocumentResizeObserver {
      constructor(callback) {
        super(document, callback);
      }
    },
  });
  Object.defineProperty(target, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class IntersectionObserver extends DocumentIntersectionObserver {
      constructor(callback, options) {
        super(document, callback, options);
      }
    },
  });
  const animationFrameCore = document._domCore;
  const animationFrameOwner = animationFrameCore.status(
    "animation_frame_surface_create",
  );
  animationFrameOwnerFinalizer.register(target, {
    coreReference: new WeakRef(animationFrameCore),
    owner: animationFrameOwner,
  });
  // Only authored callback identity and host timer/surface cancellation handles
  // live here. Native registrations decide whether a callback remains pending.
  const animationFrameCallbacks = new Map();
  const mediaQueryLists = new Set();
  const visualViewport = new EventTarget();
  Object.defineProperties(visualViewport, {
    width: {
      enumerable: true,
      get: () => document._componentRenderSurface?.viewport.width ?? 0,
    },
    height: {
      enumerable: true,
      get: () => document._componentRenderSurface?.viewport.height ?? 0,
    },
    offsetLeft: { enumerable: true, value: 0 },
    offsetTop: { enumerable: true, value: 0 },
    pageLeft: {
      enumerable: true,
      get: () => viewportScrollOffset(document, 2),
    },
    pageTop: {
      enumerable: true,
      get: () => viewportScrollOffset(document, 3),
    },
    scale: { enumerable: true, value: 1 },
  });
  Object.defineProperty(target, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });
  target.requestAnimationFrame = (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("requestAnimationFrame callback must be a function");
    }
    const identifier = animationFrameCore.status(
      "animation_frame_request",
      animationFrameOwner,
    );
    const record = { callback, cancelHost: null };
    animationFrameCallbacks.set(identifier, record);
    const invoke = (timeMilliseconds) => {
      if (
        !animationFrameCore.status(
          "animation_frame_request_pending",
          animationFrameOwner,
          identifier,
        )
      ) return;
      if (document._suppressAuthoredCallbacks) {
        const timeoutIdentifier = setTimeout(
          () => invoke(timeMilliseconds),
          1,
        );
        record.cancelHost = () => clearTimeout(timeoutIdentifier);
        return;
      }
      const checkpoint = animationFrameCore.status(
        "animation_frame_checkpoint_take",
        animationFrameOwner,
        identifier,
      );
      if (!checkpoint) return;
      try {
        const token = animationFrameCore.status(
          "animation_frame_checkpoint_next",
          animationFrameOwner,
          checkpoint,
        );
        const callbackIdentifier = animationFrameCore.status(
          "animation_frame_checkpoint_callback",
          animationFrameOwner,
          checkpoint,
          token,
        );
        const authoredCallback =
          animationFrameCallbacks.get(callbackIdentifier).callback;
        animationFrameCallbacks.delete(callbackIdentifier);
        try {
          authoredCallback(timeMilliseconds);
        } finally {
          animationFrameCore.status(
            "animation_frame_checkpoint_complete",
            animationFrameOwner,
            checkpoint,
            token,
          );
        }
      } finally {
        for (;;) {
          const discarded = animationFrameCore.status(
            "animation_frame_checkpoint_abort_next",
            animationFrameOwner,
            checkpoint,
          );
          if (!discarded) break;
          animationFrameCallbacks.delete(discarded);
        }
        animationFrameCore.status(
          "animation_frame_checkpoint_release",
          animationFrameOwner,
          checkpoint,
        );
      }
    };
    try {
      const surface = document._componentRenderSurface;
      if (surface) {
        const surfaceIdentifier = surface._requestDocumentAnimationFrame(
          invoke,
          () => {
            animationFrameCore.status(
              "animation_frame_cancel",
              animationFrameOwner,
              identifier,
            );
            animationFrameCallbacks.delete(identifier);
          },
        );
        record.cancelHost = () =>
          surface._cancelDocumentAnimationFrame(surfaceIdentifier);
      } else {
        // No live surface: the host supplies a timer boundary and exception sink.
        const timeoutIdentifier = setTimeout(() => {
          try {
            invoke(performance.now());
          } catch (error) {
            if (document._reportException) document._reportException(error);
            else throw error;
          }
        }, 0);
        record.cancelHost = () => clearTimeout(timeoutIdentifier);
      }
    } catch (error) {
      animationFrameCore.status(
        "animation_frame_cancel",
        animationFrameOwner,
        identifier,
      );
      animationFrameCallbacks.delete(identifier);
      throw error;
    }
    return identifier;
  };
  target.cancelAnimationFrame = (identifier) => {
    identifier = Number(identifier);
    if (
      !animationFrameCore.status(
        "animation_frame_cancel",
        animationFrameOwner,
        identifier,
      )
    ) return;
    const record = animationFrameCallbacks.get(identifier);
    animationFrameCallbacks.delete(identifier);
    record.cancelHost?.();
  };
  target.matchMedia = (query) => {
    componentEnvironment.observe(
      "Window",
      `matchMedia(${String(query)})`,
      "default",
      false,
    );
    const list = new MediaQueryList(document, query);
    mediaQueryLists.add(list);
    return list;
  };
  Object.defineProperties(target, {
    innerWidth: {
      configurable: true,
      get: () => {
        componentEnvironment.observe(
          "Window",
          "innerWidth",
          "default",
          false,
        );
        return document._componentRenderSurface?.viewport.width ??
          document.documentElement?.clientWidth ?? 0;
      },
    },
    innerHeight: {
      configurable: true,
      get: () => {
        componentEnvironment.observe(
          "Window",
          "innerHeight",
          "default",
          false,
        );
        return document._componentRenderSurface?.viewport.height ??
          document.documentElement?.clientHeight ?? 0;
      },
    },
    pageXOffset: {
      configurable: true,
      get: () => viewportScrollOffset(document, 2),
    },
    pageYOffset: {
      configurable: true,
      get: () => viewportScrollOffset(document, 3),
    },
    scrollX: {
      configurable: true,
      get: () => viewportScrollOffset(document, 2),
    },
    scrollY: {
      configurable: true,
      get: () => viewportScrollOffset(document, 3),
    },
  });
  // devicePixelRatio follows the live session deviceScale the same way
  // Screen geometry follows the viewport: reads track resize() because
  // the getter reads the surface's viewport directly. A realm whose
  // ambient devicePixelRatio is non-configurable (a window realm) keeps
  // its own, matching the globalThis collision treatment below.
  if (
    Object.getOwnPropertyDescriptor(target, "devicePixelRatio")
      ?.configurable !== false
  ) {
    Object.defineProperty(target, "devicePixelRatio", {
      configurable: true,
      get: () => {
        componentEnvironment.observe(
          "Window",
          "devicePixelRatio",
          "default",
          false,
        );
        return document._componentRenderSurface?.viewport.deviceScale ??
          componentEnvironment.viewport.deviceScale ?? 1;
      },
    });
  }
  document._reevaluateMediaQueryLists = () => {
    for (const list of mediaQueryLists) list._reevaluate();
  };
  target.addEventListener = (type, callback, options) =>
    addComponentEventListener(target, type, callback, options);
  target.removeEventListener = (type, callback, options) =>
    removeComponentEventListener(target, type, callback, options);
  target.dispatchEvent = (event) => dispatchComponentEvent(target, event);
  const hostFunctions = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    queueMicrotask: globalThis.queueMicrotask,
  };
  for (const [name, hostFunction] of Object.entries(hostFunctions)) {
    if (typeof target[name] === "function") continue;
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...arguments_) {
        return Reflect.apply(hostFunction, globalThis, arguments_);
      },
    });
  }
  if (!("performance" in target)) {
    Object.defineProperty(target, "performance", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: globalThis.performance,
    });
  }
  if (componentEnvironment.fetch) {
    const providedFetch = componentEnvironment.fetch;
    Object.defineProperty(target, "fetch", {
      configurable: true,
      writable: true,
      value(input, init) {
        const requestedURL = String(input?.url ?? input);
        try {
          const result = providedFetch(input, init);
          if (result && typeof result.then === "function") {
            return result.catch((error) => {
              componentEnvironment.observe("Window", "fetch", "caller", true, {
                requestedURL,
                missingHandler: null,
              });
              throw error;
            });
          }
          componentEnvironment.observe("Window", "fetch", "caller", false);
          return result;
        } catch (error) {
          componentEnvironment.observe("Window", "fetch", "caller", true, {
            requestedURL,
            missingHandler: null,
          });
          throw error;
        }
      },
    });
  }
  if (componentEnvironment.createWebSocket) {
    const createWebSocket = componentEnvironment.createWebSocket;
    class ComponentWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url, protocols = undefined) {
        const requestedURL = new URL(String(url), document.URL).href;
        try {
          const socket = createWebSocket(requestedURL, protocols);
          if (!socket || typeof socket !== "object") {
            throw new TypeError(
              "environment.createWebSocket must return a WebSocket object",
            );
          }
          componentEnvironment.observe(
            "Window",
            "WebSocket",
            "caller",
            false,
          );
          return socket;
        } catch (error) {
          componentEnvironment.observe("Window", "WebSocket", "caller", true, {
            requestedURL,
            missingHandler: null,
          });
          throw error;
        }
      }
    }
    Object.defineProperty(target, "WebSocket", {
      configurable: true,
      writable: true,
      value: ComponentWebSocket,
    });
  } else {
    const existingWebSocket = Object.getOwnPropertyDescriptor(
      target,
      "WebSocket",
    );
    if (existingWebSocket?.configurable) {
      delete target.WebSocket;
    } else if (existingWebSocket) {
      throw new DOMException(
        "The selected realm WebSocket cannot be removed without environment.createWebSocket",
        "NotSupportedError",
      );
    }
  }
  Object.defineProperties(target, {
    document: {
      configurable: true,
      enumerable: true,
      value: document,
    },
    location: {
      configurable: true,
      enumerable: true,
      get: () => componentEnvironment.locationObject,
      set: (value) => componentEnvironment.locationObject.assign(value),
    },
    history: {
      configurable: true,
      enumerable: true,
      get: () => componentEnvironment.historyObject,
    },
    navigator: {
      configurable: true,
      enumerable: true,
      get: () => componentEnvironment.navigatorObject,
    },
    screen: {
      configurable: true,
      enumerable: true,
      get: () => componentEnvironment.screenObject,
    },
  });
  Object.defineProperty(document, "location", {
    configurable: true,
    enumerable: true,
    get: () => componentEnvironment.locationObject,
    set: (value) => componentEnvironment.locationObject.assign(value),
  });
  target.customElements = document.customElements;
  target.getComputedStyle = (element, pseudoElement = null) =>
    document.getComputedStyle(element, pseudoElement);
  target.CSS = CSS;
  target.window = target;
  if (target.self !== target) target.self = target;
  if (
    target.globalThis !== target &&
    Object.getOwnPropertyDescriptor(target, "globalThis")?.configurable !==
      false
  ) {
    target.globalThis = target;
  }
  document.defaultView = target;
  return target;
}
