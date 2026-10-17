import { hostClearTimeout, hostSetTimeout } from "../host-clock.js";
import { fixDocumentClock } from "./document-clock.js";
import { installPageClock } from "./page-clock.js";
import { SVGMatrix, SVGRect } from "./svg-geometry.js";
import {
  Attr,
  additionalElementInterfaces,
  SDHTMLDocument,
  SDXMLDocument,
  SDDocument,
  SDDocumentFragment,
  SDComment,
  SDCDATASection,
  SDProcessingInstruction,
  SDDocumentType,
  SDElement,
  SDHTMLButtonElement,
  SDHTMLCanvasElement,
  SDHTMLElement,
  SDHTMLFieldSetElement,
  SDHTMLFormElement,
  SDHTMLIFrameElement,
  SDHTMLImageElement,
  SDHTMLLabelElement,
  SDHTMLDataListElement,
  SDHTMLTableElement,
  SDHTMLTableRowElement,
  SDHTMLMapElement,
  SDHTMLAnchorElement,
  SDCharacterData,
  SDHTMLOptionElement,
  SDHTMLOutputElement,
  SDHTMLInputElement,
  SDHTMLScriptElement,
  SDHTMLSelectElement,
  SDHTMLSourceElement,
  SDHTMLTextAreaElement,
  SDHTMLTemplateElement,
  SDNode,
  SDShadowRoot,
  SDSVGElement,
  SDTextNode,
} from "./node.js";
import { unsignedLongAttributeValue } from "./images.js";
import { createDOMParserClass } from "./dom-parser.generated.js";
import { parseHTMLDocument } from "./html.js";
import { parseXMLDocument } from "./xml.js";
import { SDAbstractRange, SDRange, SDSelection } from "./selection.js";
import { CanvasGradient } from "./canvas-2d-gradient.js";
import { SandomGPUCanvasContext } from "./canvas.js";
import { gpuFacadeInterfaces } from "./webgpu-facade.js";
import { CanvasRenderingContext2D, ImageData, Path2D } from "./canvas-2d.js";
import { HTMLCollection, HTMLFormControlsCollection, HTMLOptionsCollection, NodeList, RadioNodeList } from "./form-dom.js";
import { DOMTokenList, NamedNodeMap } from "./node-collections.js";
import { CanvasPattern } from "./canvas-2d-pattern.js";
import { createImageBitmap, ImageBitmap } from "./canvas-image-bitmap.js";
import { offscreenCanvasConstructor, OffscreenCanvasRenderingContext2D } from "./offscreen-canvas.js";
import {
  CustomElementRegistry,
  CustomStateSet,
  ElementInternals,
} from "./custom-elements.js";
import {
  addEventListener as addComponentEventListener,
  dispatchEvent as dispatchComponentEvent,
  removeEventListener as removeComponentEventListener,
  registerEventTargetWrapper,
  SDAnimationEvent,
  SDAnimationPlaybackEvent,
  SDEventTarget,
  SDClipboardEvent,
  SDDataTransfer,
  SDFocusEvent,
  SDKeyboardEvent,
  SDMouseEvent,
  SDPointerEvent,
  SDSubmitEvent,
  SDToggleEvent,
  SDTransitionEvent,
} from "./events.js";
import {
  CSS,
  CSSFontFaceRule,
  CSSFontFeatureValuesRule,
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
import { scheduleFocusFixup } from "./input-activation.js";
import { installWindowEventHandlers } from "./event-handlers.js";
import {
  componentCodeClosed,
  componentCodeDocument,
  enterComponentCode,
  recordComponentTask,
} from "./component-code.js";
import { Animation, CSSAnimation, CSSTransition } from "./animation.js";

// WebIDL "length" of the interface objects whose Sandom class takes
// internal constructor arguments: the number of required arguments of the
// interface's constructor, 0 for an interface without a constructor
// (Web IDL, "interface object", and the pinned Chrome).
const INTERFACE_OBJECT_LENGTHS = Object.freeze({
  Animation: 0, CSSAnimation: 0, CSSTransition: 0, CSSFontFaceRule: 0, CSSGroupingRule: 0,
  CSSRule: 0, CSSStyleDeclaration: 0, CSSStyleRule: 0, CanvasPattern: 0,
  CanvasRenderingContext2D: 0, CustomStateSet: 0, Element: 0, ElementInternals: 0,
  GPUCanvasContext: 0, HTMLElement: 0, History: 0, ImageBitmap: 0, ImageData: 2,
  Location: 0, MediaQueryList: 0, MutationRecord: 0, Navigator: 0, Node: 0,
  PointerEvent: 1, SVGElement: 0, Screen: 0, ScreenOrientation: 0, Selection: 0, Text: 0,
  CharacterData: 0, HTMLAnchorElement: 0,
});

const animationFrameOwnerFinalizer = new FinalizationRegistry(
  ({ coreReference, owner }) => {
    coreReference.deref()?.status("animation_frame_surface_discard", owner);
  },
);

// Whether a window event is a runtime's report of an exception: a
// cancelable `error` ErrorEvent or `unhandledrejection` event. A page's own
// `new ErrorEvent("error")` is not cancelable, and reports nothing.
function reportsException(event) {
  if (!event.cancelable) return false;
  if (event.type === "error") return typeof ErrorEvent === "function" && event instanceof ErrorEvent;
  return event.type === "unhandledrejection";
}

// window.scrollX and scrollY (and the visual viewport's page offsets): the
// effective offset, slot 2 left or 3 top, of the component surface's
// viewport. These reads update layout in Chrome, so they run the focus
// check (scheduleFocusFixup).
function viewportScrollOffset(document, slot) {
  scheduleFocusFixup(document);
  const surface = document._componentRenderSurface;
  return surface ? scrollRead(surface.viewport, slot) : 0;
}

// The owners of each realm's global object, keyed by that global object, so
// a DOM layer evaluated in several realms keeps one record per realm. A
// component session owns a global exclusively; file preparations take it
// in turn; a document realm holds it for the lifetime of a document whose
// classic scripts run there (src/dom/document-realm.js).
const realmOwnerships = new WeakMap();

function realmOwnership(realmGlobal) {
  let ownership = realmOwnerships.get(realmGlobal);
  if (ownership === undefined) {
    ownership = {
      component: null,
      filePreparationCount: 0,
      filePreparationTail: Promise.resolve(),
      document: null,
    };
    realmOwnerships.set(realmGlobal, ownership);
  }
  return ownership;
}

function descriptorsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set;
}

// The document whose window bindings the realm global holds, or null.
export function realmDocument(realmGlobal) {
  return realmOwnerships.get(realmGlobal)?.document ?? null;
}

// Claims `realmGlobal` for the window of `document` until the returned
// release runs.
export function claimRealmForDocument(realmGlobal, document) {
  const ownership = realmOwnership(realmGlobal);
  if (ownership.document !== null) {
    throw new Error(
      `The realm already holds the window of ${ownership.document.URL}; release that document before ${document.URL} runs scripts in the same realm`,
    );
  }
  if (ownership.component !== null || ownership.filePreparationCount > 0) {
    throw new Error(
      `Cannot install the window of ${document.URL} while another owner of the realm's globals is active`,
    );
  }
  ownership.document = document;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownership.document = null;
  };
}

export async function acquireAmbientGlobalOwnership(kind, realmGlobal = globalThis) {
  if (!["component-session", "file-preparation"].includes(kind)) {
    throw new TypeError(`Unknown ambient global owner ${JSON.stringify(kind)}`);
  }

  const ownership = realmOwnership(realmGlobal);
  if (ownership.document !== null) {
    throw new Error(
      `Cannot install ambient globals while the realm holds the window of ${ownership.document.URL}`,
    );
  }
  const owner = Symbol(kind);
  if (kind === "component-session") {
    if (ownership.component !== null || ownership.filePreparationCount > 0) {
      throw new Error(
        "Cannot start an ambient component session while another ambient owner is active",
      );
    }
    ownership.component = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (ownership.component !== owner) {
        throw new Error("Ambient component ownership changed unexpectedly");
      }
      ownership.component = null;
    };
  }

  if (ownership.component !== null) {
    throw new Error(
      "Cannot prepare a file while an ambient component session is active",
    );
  }
  ownership.filePreparationCount += 1;
  const previousPreparation = ownership.filePreparationTail;
  let releasePreparation;
  ownership.filePreparationTail = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  await previousPreparation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownership.filePreparationCount -= 1;
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

// The legacy factory function Image(width, height) of a window: an img of
// the window's document with the given dimension attributes.
function legacyImageFactory(document) {
  function Image(width = undefined, height = undefined) {
    if (new.target === undefined) {
      throw new TypeError(
        "Failed to construct 'Image': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      );
    }
    const image = document.createElement("img");
    if (width !== undefined) image.setAttribute("width", unsignedLongAttributeValue(width));
    if (height !== undefined) image.setAttribute("height", unsignedLongAttributeValue(height));
    return image;
  }
  Object.defineProperty(Image, "prototype", { value: SDHTMLImageElement.prototype, writable: false });
  return Image;
}

// The interface object and engine instances share the interface prototype.
// The closure binds constructor allocation to this component document.
function documentInterfaceConstructor(name, engineConstructor, convertArguments = null) {
  const constructor = {
    [name]: function (...arguments_) {
      if (!new.target || convertArguments === null) throw new TypeError(`Illegal ${name} constructor`);
      return Reflect.construct(engineConstructor, convertArguments(arguments_), new.target);
    },
  }[name];
  Object.defineProperty(constructor, "prototype", { value: engineConstructor.prototype, writable: false });
  return constructor;
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
    ...additionalElementInterfaces,
    ...gpuFacadeInterfaces,
    SVGMatrix,
    SVGRect,
    HTMLDocument: documentInterfaceConstructor("HTMLDocument", SDHTMLDocument),
    XMLDocument: documentInterfaceConstructor("XMLDocument", SDXMLDocument),
    AbstractRange: documentInterfaceConstructor("AbstractRange", SDAbstractRange),
    Comment: documentInterfaceConstructor("Comment", SDComment, ([data = ""]) => [`${data}`, document]),
    CDATASection: documentInterfaceConstructor("CDATASection", SDCDATASection),
    ProcessingInstruction: documentInterfaceConstructor("ProcessingInstruction", SDProcessingInstruction),
    DocumentType: documentInterfaceConstructor("DocumentType", SDDocumentType),
    EventTarget: SDEventTarget,
    DOMTokenList,
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
    CanvasGradient,
    CanvasRenderingContext2D,
    ImageData,
    Path2D,
    CanvasPattern,
    ImageBitmap,
    OffscreenCanvas: document._offscreenCanvasConstructor ??= offscreenCanvasConstructor(document),
    OffscreenCanvasRenderingContext2D,
    HTMLTemplateElement: SDHTMLTemplateElement,
    HTMLInputElement: SDHTMLInputElement,
    HTMLFormElement: SDHTMLFormElement,
    HTMLOptionElement: SDHTMLOptionElement,
    HTMLSelectElement: SDHTMLSelectElement,
    HTMLTextAreaElement: SDHTMLTextAreaElement,
    HTMLFieldSetElement: SDHTMLFieldSetElement,
    HTMLOutputElement: SDHTMLOutputElement,
    HTMLLabelElement: SDHTMLLabelElement,
    HTMLDataListElement: SDHTMLDataListElement,
    HTMLTableElement: SDHTMLTableElement,
    HTMLTableRowElement: SDHTMLTableRowElement,
    HTMLMapElement: SDHTMLMapElement,
    HTMLAnchorElement: SDHTMLAnchorElement,
    CharacterData: SDCharacterData,
    NodeList,
    HTMLCollection,
    NamedNodeMap,
    Attr,
    HTMLFormControlsCollection,
    HTMLOptionsCollection,
    RadioNodeList,
    HTMLScriptElement: SDHTMLScriptElement,
    HTMLIFrameElement: SDHTMLIFrameElement,
    HTMLImageElement: SDHTMLImageElement,
    HTMLSourceElement: SDHTMLSourceElement,
    Image: legacyImageFactory(document),
    Document: documentInterfaceConstructor("Document", SDDocument, () => [{ core: document._domCore, xmlDocument: true }]),
    Range: documentInterfaceConstructor("Range", SDRange, () => [document]),
    Selection: SDSelection,
    DocumentFragment: documentInterfaceConstructor("DocumentFragment", SDDocumentFragment, () => [document]),
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
    CSSFontFeatureValuesRule,
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
    Animation,
    CSSAnimation,
    CSSTransition,
    AnimationEvent: SDAnimationEvent,
    AnimationPlaybackEvent: SDAnimationPlaybackEvent,
    TransitionEvent: SDTransitionEvent,
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
  // Window.createImageBitmap (src/dom/canvas-image-bitmap.js).
  Object.defineProperty(target, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: {
      createImageBitmap(image, ...rest) {
        return createImageBitmap(document, arguments.length, image, ...rest);
      },
    }.createImageBitmap,
  });
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
      constructor(callback, options = undefined) {
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
      get: () => {
        scheduleFocusFixup(document);
        return document._componentRenderSurface?.viewport.width ?? 0;
      },
    },
    height: {
      enumerable: true,
      get: () => {
        scheduleFocusFixup(document);
        return document._componentRenderSurface?.viewport.height ?? 0;
      },
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
    // A closed page runs no animation frame callback.
    if (componentCodeClosed(document)) return 0;
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
        const timeoutIdentifier = hostSetTimeout(
          () => invoke(timeMilliseconds),
          1,
        );
        record.cancelHost = () => hostClearTimeout(timeoutIdentifier);
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
          enterComponentCode(document, authoredCallback, undefined, [timeMilliseconds]);
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
        // No live surface: a frame of the document clock's own source, at
        // that frame's time; the document's exception sink hears a throw.
        const clock = fixDocumentClock(document);
        const frameRequest = clock.requestFrame((timeMilliseconds) => {
          clock.frame(timeMilliseconds);
          try {
            invoke(timeMilliseconds);
          } catch (error) {
            if (document._reportException) document._reportException(error);
            else throw error;
          }
        });
        record.cancelHost = () => clock.cancelFrame(frameRequest);
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
  const cancelAnimationFrame = (identifier) => {
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
  target.cancelAnimationFrame = cancelAnimationFrame;
  // The window's animation frame callbacks are the page's tasks: the close of
  // the component code (component-code.js) cancels every pending one. A
  // collected window has released its animation frame owner.
  const animationFrameWindow = new WeakRef(target);
  recordComponentTask(document, () => {
    if (animationFrameWindow.deref() === undefined) return;
    for (const identifier of [...animationFrameCallbacks.keys()]) cancelAnimationFrame(identifier);
  });
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
  // window.scroll, scrollTo and scrollBy (CSSOM View) scroll the viewport:
  // the live surface's, else the document's scrolling element.
  const viewportScroller = () => document._componentRenderSurface?.viewport ?? document.scrollingElement;
  for (const name of ["scroll", "scrollTo", "scrollBy"]) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        [name](_first = undefined, _second = undefined) {
          const scroller = viewportScroller();
          if (scroller) Reflect.apply(scroller[name], scroller, arguments);
        },
      }[name],
    });
  }
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
  registerEventTargetWrapper(target);
  // (type, callback, optional options): length 2.
  target.addEventListener = (type, callback, options = undefined) =>
    addComponentEventListener(target, type, callback, options);
  target.removeEventListener = (type, callback, options = undefined) =>
    removeComponentEventListener(target, type, callback, options);
  // Deno reports an uncaught exception, an unhandled rejection and
  // reportError() by dispatching a cancelable `error` or
  // `unhandledrejection` event on the global, which is this window. The
  // page's listeners hear it first (HTML "report an exception"). When
  // component code of this document raised it (src/dom/component-code.js)
  // and the listeners leave it uncanceled, it belongs to the document: it is
  // canceled, so that the runtime keeps running, and its error goes to the
  // document's exception sink (renderComponent's reportException). An
  // exception of host code stays the runtime's.
  target.dispatchEvent = (event) => {
    const result = dispatchComponentEvent(target, event);
    if (!reportsException(event) || componentCodeDocument() !== document) return result;
    if (!event.defaultPrevented && document._reportException) {
      event.preventDefault();
      document._reportException(
        event.type === "error" ? event.error ?? new Error(event.message) : event.reason,
      );
    }
    return !event.defaultPrevented;
  };
  // The window's time interfaces and timers on the document's clock.
  installPageClock(target, document, Object.keys(constructors));
  // A timer that component code sets runs component code. The runtime
  // reports the throw of a timer callback after the callback returns, outside
  // the component's code, so the callback reports its own throw at this
  // window, as the runtime does. An exception that nothing cancels there,
  // such as one after disposal restores the realm's own dispatchEvent, goes
  // back to the runtime. A timer of host code stays the host's.
  const reportTimerException = (error) => {
    if (!document._reportException) throw error;
    const event = new ErrorEvent("error", {
      cancelable: true,
      error,
      message: error instanceof Error ? error.message : String(error),
    });
    if (target.dispatchEvent(event)) throw error;
  };
  function runComponentTimer(callback, argumentsList) {
    try {
      return Reflect.apply(callback, this, argumentsList);
    } catch (error) {
      reportTimerException(error);
    }
  }
  // A timer or an immediate that component code sets runs component code,
  // and the window records it until it runs or the page clears it. When the
  // component code closes (component-code.js), the window clears every one
  // that has not run, and clears one that the code sets after that at once.
  // The realm's own functions keep running every timer, and the descriptors
  // keep their attributes. A realm whose function is non-configurable keeps
  // it as it is.
  const pendingTimers = new Map();
  const pendingImmediates = new Map();
  for (const [setName, clearName, pending, repeats] of [
    ["setTimeout", "clearTimeout", pendingTimers, false],
    ["setInterval", "clearInterval", pendingTimers, true],
    // setImmediate is not a window API: only a realm that has it keeps it.
    ["setImmediate", "clearImmediate", pendingImmediates, false],
  ]) {
    const realmSet = target[setName];
    const realmClear = target[clearName];
    if (typeof realmSet !== "function" || typeof realmClear !== "function") continue;
    const setDescriptor = Object.getOwnPropertyDescriptor(target, setName);
    const clearDescriptor = Object.getOwnPropertyDescriptor(target, clearName);
    if (setDescriptor?.configurable === false || clearDescriptor?.configurable === false) continue;
    Object.defineProperty(target, setName, {
      configurable: true,
      enumerable: setDescriptor?.enumerable ?? true,
      writable: setDescriptor?.writable ?? true,
      value(handler, ...arguments_) {
        if (componentCodeDocument() !== document) {
          return Reflect.apply(realmSet, target, [handler, ...arguments_]);
        }
        let forget = null;
        if (typeof handler === "function") {
          const callback = handler;
          handler = function (...argumentsList) {
            if (!repeats) forget?.();
            return enterComponentCode(document, runComponentTimer, this, [callback, argumentsList]);
          };
        }
        const handle = Reflect.apply(realmSet, target, [handler, ...arguments_]);
        const cancel = () => Reflect.apply(realmClear, target, [handle]);
        if (componentCodeClosed(document)) {
          cancel();
          return handle;
        }
        const forgetTask = recordComponentTask(document, cancel);
        forget = () => {
          pending.delete(handle);
          forgetTask();
        };
        pending.set(handle, forget);
        return handle;
      },
    });
    Object.defineProperty(target, clearName, {
      configurable: true,
      enumerable: clearDescriptor?.enumerable ?? true,
      writable: clearDescriptor?.writable ?? true,
      value(...arguments_) {
        pending.get(arguments_[0])?.();
        return Reflect.apply(realmClear, target, arguments_);
      },
    });
  }
  // The ports of a message channel that component code creates close when
  // the component code closes, as the ports of a closed page do: a message
  // that has not arrived does not arrive. A runtime can still deliver the
  // message that it already received (Deno does), so the first listener of
  // each port stops a message of a closed page. The window holds the ports
  // weakly: a port that the runtime collects has no listener left to run.
  const RealmMessageChannel = target.MessageChannel;
  const messageChannelDescriptor = Object.getOwnPropertyDescriptor(target, "MessageChannel");
  if (typeof RealmMessageChannel === "function" && messageChannelDescriptor?.configurable !== false) {
    const forgetCollectedPort = new FinalizationRegistry((forget) => forget());
    const stopClosedPageMessage = (event) => {
      if (componentCodeClosed(document)) event.stopImmediatePropagation();
    };
    Object.defineProperty(target, "MessageChannel", {
      configurable: true,
      enumerable: messageChannelDescriptor?.enumerable ?? false,
      writable: messageChannelDescriptor?.writable ?? true,
      value: new Proxy(RealmMessageChannel, {
        construct(Channel, argumentsList, newTarget) {
          const channel = Reflect.construct(Channel, argumentsList, newTarget);
          if (componentCodeDocument() !== document) return channel;
          for (const port of [channel.port1, channel.port2]) {
            if (componentCodeClosed(document)) {
              port.close();
              continue;
            }
            port.addEventListener("message", stopClosedPageMessage);
            const reference = new WeakRef(port);
            forgetCollectedPort.register(port, recordComponentTask(document, () => reference.deref()?.close()));
          }
          return channel;
        },
      }),
    });
  }
  // queueMicrotask is the realm's own, or the host's for a window without
  // one: a microtask cannot be cancelled. One that component code queued runs
  // while disposal awaits its teardown, before the session restores the
  // realm's globals.
  if (typeof target.queueMicrotask !== "function") {
    const hostQueueMicrotask = globalThis.queueMicrotask;
    Object.defineProperty(target, "queueMicrotask", {
      configurable: true,
      enumerable: true,
      writable: true,
      // queueMicrotask(callback): length 1.
      value(_callback) {
        return Reflect.apply(hostQueueMicrotask, globalThis, arguments);
      },
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
  installWindowEventHandlers(target);
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
  for (const [name, length] of Object.entries(INTERFACE_OBJECT_LENGTHS)) {
    if (typeof target[name] === "function" && target[name].length !== length) {
      Object.defineProperty(target[name], "length", { value: length, writable: false, enumerable: false, configurable: true });
    }
  }
  return target;
}
