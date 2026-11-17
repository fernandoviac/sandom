// createSandomDOM: one Sandom document and the backend object a host drives
// it through. The public facade (dom.js) re-exports it; the document
// session and the component renderer import it from here, so neither
// imports the facade that re-exports them (test/dom-core/module_graph_test.js).
import { validateClosedRecord } from "../closed-record.js";
import { SDDocument } from "./node.js";
import { enterDocumentRealm } from "./document-realm.js";
import * as layoutGetters from "./layout-getters.js";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "./live-geometry.js";
import { documentClockFromOptions } from "./document-clock.js";
import { createSyntheticEvent, eventIntrinsics } from "./events.js";
import { createRenderSurface } from "./render-surface.js";
import { SandomViewport } from "./viewport.js";
import { createInputController, hostDoubleClickInterval, hostEditingPlatform } from "./input-controller.js";
import { setDocumentSpellchecker } from "./spellcheck.js";
import { setDocumentContextMenu } from "./field-menu.js";
import { setDocumentEyeDropper } from "./eyedropper.js";
import { setDocumentPickers } from "./host-picker.js";
import { assertTimeZone } from "./local-time.js";
import { attachDocument } from "./attach.js";

// The layout-getter family, keyed by the EXACT property names swarm.js
// routes through getProperty (swarm.js:153-172) — a plain lookup table
// so getProperty's own body doesn't need a long if/else chain.
const LAYOUT_GETTER_PROPERTIES = {
  offsetWidth: layoutGetters.offsetWidth,
  offsetHeight: layoutGetters.offsetHeight,
  offsetTop: layoutGetters.offsetTop,
  offsetLeft: layoutGetters.offsetLeft,
  clientWidth: layoutGetters.clientWidth,
  clientHeight: layoutGetters.clientHeight,
  scrollTop: layoutGetters.scrollTop,
  scrollLeft: layoutGetters.scrollLeft,
  scrollWidth: layoutGetters.scrollWidth,
  scrollHeight: layoutGetters.scrollHeight,
};

// Layout getters require an explicit viewport. The default matches the
// established Sandom oracle viewport and callers can override it.
const DOM_OPTION_NAMES = new Set([
  "viewportW",
  "viewportH",
  "deviceScale",
  "glyphResourceManager",
  "document",
  "sceneRendererRuntime",
  "fontRegistry",
  "editingPlatform",
  "doubleClickInterval",
  "host",
  "url",
  "now",
  "requestFrame",
  "cancelFrame",
  "timeOrigin",
  "timeZone",
]);

const FORCED_STATE_NAMES = new Set(["hover", "active", "focus", "focusVisible", "focusWithin"]);
const PREFERENCE_VALUES = Object.freeze({
  colorScheme: ["light", "dark"],
  reducedMotion: ["no-preference", "reduce"],
  forcedColors: ["none", "light", "dark"],
});
const PREFERENCE_NAMES = new Set(Object.keys(PREFERENCE_VALUES));

export function createSandomDOM(options = {}) {
  validateClosedRecord(options, DOM_OPTION_NAMES, "createSandomDOM options");
  let {
    viewportW = DEFAULT_VIEWPORT_WIDTH,
    viewportH = DEFAULT_VIEWPORT_HEIGHT,
    deviceScale = 1,
    glyphResourceManager,
    document = null,
    sceneRendererRuntime = null,
    fontRegistry = null,
    editingPlatform = hostEditingPlatform(),
    // The longest time in milliseconds between two mouse presses that
    // count as a double click: the host's system setting where the host
    // can read it, else the platform's default (input-controller.js).
    doubleClickInterval = hostDoubleClickInterval(editingPlatform),
    host,
    url,
    // The IANA time zone of the document's local date and time
    // (src/dom/local-time.js), UTC without one; the date and time inputs
    // take today from it.
    timeZone,
  } = options;
  // `now`, `requestFrame`, `cancelFrame` and `timeOrigin` are the
  // document's clock (src/dom/document-clock.js): of the new document, or
  // of a supplied document whose page has not begun (a `DOMParser`
  // document before `installComponentGlobals`). Without them the
  // document's page takes the clock of its surfaces, or the host's real
  // clock, when it begins. Pass `timeOrigin` with `now`: it is the page's
  // date at time 0, and without it the page's `Date` starts at the Unix
  // epoch.
  const clock = documentClockFromOptions(options, "createSandomDOM options");
  if (document !== null && (host !== undefined || url !== undefined)) {
    throw new TypeError(
      "createSandomDOM: host and url describe a new document; a supplied document already has its own",
    );
  }
  if (document !== null && clock !== null) {
    if (document._clock) {
      throw new TypeError(
        `createSandomDOM: the supplied document ${document.URL} already has its clock (it was given one, or its page began); give the clock where the document is created`,
      );
    }
    document._clock = clock;
  }
  sceneRendererRuntime ??= document?._sandomSceneRendererRuntime ?? null;
  fontRegistry ??= sceneRendererRuntime?.fontRegistry;
  document ??= new SDDocument({
    core: sceneRendererRuntime?.core,
    fontRegistry,
    enterRealm: enterDocumentRealm,
    clock,
    ...(host === undefined ? {} : { host }),
    ...(url === undefined ? {} : { url }),
  });
  if (sceneRendererRuntime && document._domCore !== sceneRendererRuntime.core) {
    throw new TypeError("The document belongs to a different renderer core");
  }
  document._sandomSceneRendererRuntime = sceneRendererRuntime;
  if (fontRegistry) {
    if (fontRegistry.core !== document._domCore) {
      throw new TypeError("The font registry belongs to a different renderer core");
    }
    document._sandomFontRegistry = fontRegistry;
  }
  // The document's lengths and its synchronous layout resolve against this
  // viewport, also when another document shares its core.
  document._setViewport(viewportW, viewportH, deviceScale);
  if (timeZone !== undefined) document._timeZone = assertTimeZone(timeZone, "createSandomDOM options");
  const layoutOptions = { viewportW, viewportH };
  const viewport = new SandomViewport({
    width: viewportW,
    height: viewportH,
    deviceScale,
  });
  const eventListenerWrappers = new WeakMap();
  const input = createInputController(layoutOptions, editingPlatform, document, doubleClickInterval);
  const { pointerController, ...inputBindings } = input;
  // The text editor of Document.execCommand (src/dom/editing-commands.js).
  document._editingCommands = input;

  return {
    ...inputBindings,
    viewport,
    document,
    createElement(tag) {
      const element = document.createElement(tag);
      element._pointerController = pointerController;
      element._layoutOptions = layoutOptions;
      return element;
    },
    createElementNS(namespace, tag) {
      const element = document.createElementNS(namespace, tag);
      element._pointerController = pointerController;
      element._layoutOptions = layoutOptions;
      return element;
    },
    createTextNode(text) {
      return document.createTextNode(text);
    },
    createComment(text) {
      return document.createComment(text);
    },
    createDocumentFragment() {
      return document.createDocumentFragment();
    },

    appendChild(parent, child) {
      parent.appendChild(child);
    },
    removeChild(parent, child) {
      parent.removeChild(child);
    },
    insertBefore(parent, node, ref) {
      parent.insertBefore(node, ref);
    },
    replaceChild(parent, newChild, old) {
      parent.replaceChild(newChild, old);
    },
    cloneNode(node, deep) {
      return node.cloneNode(deep);
    },

    getProperty(node, name) {
      if (name === "children") return Array.from(node.children);
      if (name in LAYOUT_GETTER_PROPERTIES) {
        return LAYOUT_GETTER_PROPERTIES[name](node, layoutOptions);
      }
      return node[name];
    },
    setProperty(node, name, value) {
      node[name] = value;
    },

    // A real handler, not routed through getProperty (swarm.js:309 calls
    // backend.getBoundingClientRect(node) directly) — matches the
    // browser backend's own separate method (frontend-iris.js:91-95).
    getBoundingClientRect(node) {
      return layoutGetters.getBoundingClientRect(node, layoutOptions);
    },

    // The surface draws into the DOM's viewport; its size, raster scale and
    // density options apply to that viewport.
    createRenderSurface(root, options = {}) {
      if (options.viewport === undefined || options.viewport === null) {
        viewport.resizeTo(
          options.viewportWidth ?? viewport.width,
          options.viewportHeight ?? viewport.height,
          options.deviceScale ?? viewport.deviceScale,
          options.density === undefined ? viewport._density : options.density,
        );
      }
      return createRenderSurface(root, {
        ...options,
        viewport: options.viewport ?? viewport,
        ...(glyphResourceManager !== undefined &&
            options.glyphResourceManager === undefined
          ? { glyphResourceManager }
          : {}),
      });
    },

    getAttribute(node, name) {
      return node.getAttribute(name);
    },
    setAttribute(node, name, value) {
      node.setAttribute(name, value);
    },
    removeAttribute(node, name) {
      node.removeAttribute(name);
    },
    hasAttribute(node, name) {
      return node.hasAttribute(name);
    },

    getStyle(node) {
      return node.style;
    },

    getClassList(node) {
      return node.classList;
    },

    // Interactivity — real passthroughs.
    focus(node) {
      node.focus();
    },
    blur(node) {
      node.blur();
    },
    select(node) {
      node.select();
    },
    click(node) {
      node.click();
    },
    scrollIntoView(node, options) {
      node.scrollIntoView(options);
    },
    // Forces the user action pseudo-classes of `element` (hover, active,
    // focus, focusVisible, focusWithin; each a boolean, absent false), as a
    // developer tool's "force element state" does. A forced state adds to
    // the real one; it changes selector matching only, and moves no focus.
    forceElementState(element, states) {
      if (element?.nodeType !== 1 || element.ownerDocument !== document) {
        throw new TypeError(
          `forceElementState: element must be an element of this document, received ${String(element)}`,
        );
      }
      validateClosedRecord(states, FORCED_STATE_NAMES, "forceElementState states");
      for (const [name, value] of Object.entries(states)) {
        if (typeof value !== "boolean") {
          throw new TypeError(`forceElementState: ${name} must be a boolean, received ${String(value)}`);
        }
      }
      if (element._domCore.setForcedState(element._coreHandle, states)) {
        element._notifyMutation("state", "forced");
      }
    },
    // The user's preferences, as the host's media queries report them:
    // colorScheme ("light" or "dark", prefers-color-scheme), reducedMotion
    // ("no-preference" or "reduce", prefers-reduced-motion) and forcedColors
    // ("none", or the palette "light" or "dark" of forced colors mode).
    // Absent keys stay. Styles and MediaQueryLists follow; a render surface
    // owes a frame.
    setPreferences(preferences) {
      validateClosedRecord(preferences, PREFERENCE_NAMES, "setPreferences preferences");
      const environment = {};
      for (const [name, value] of Object.entries(preferences)) {
        if (!PREFERENCE_VALUES[name].includes(value)) {
          throw new RangeError(`setPreferences: ${name} is ${JSON.stringify(value)}; expected ${PREFERENCE_VALUES[name].join(" or ")}`);
        }
        environment[name] = name === "reducedMotion" ? value === "reduce" : value;
      }
      document._styleSystem.setEnvironment(environment);
      document._reevaluateMediaQueryLists?.();
    },
    // The host's spellchecker for the document's text and search fields,
    // or null for none (src/dom/spellcheck.js).
    setSpellchecker(checker) {
      setDocumentSpellchecker(document, checker);
    },
    // The labels and the clipboard of the document's text field context
    // menus (src/dom/field-menu.js).
    setContextMenu(options) {
      setDocumentContextMenu(document, options);
    },
    // Puts the document into one place of the host: its frames there and
    // the host's input in it (src/dom/attach.js). Resolves to the view once
    // its first frame is presented.
    attach(target, options) {
      return attachDocument(this, target, options);
    },
    // The host's screen eyedropper for the colour picker, or null for the
    // page eyedropper only (src/dom/eyedropper.js).
    setEyeDropper(eyeDropper) {
      setDocumentEyeDropper(document, eyeDropper);
    },
    // The host's date and time pickers and colour picker, drawn in place
    // of Sandom's, or null for Sandom's (src/dom/host-picker.js).
    setPickers(pickers) {
      setDocumentPickers(document, pickers);
    },
    // The element under a host pointer: the presented frame's, as the input
    // path hit-tests it.
    elementFromPoint(root, x, y) {
      return layoutGetters.presentedElementFromPoint(root, x, y, layoutOptions);
    },
    inspectScrolling(root, target = root._renderSurface?.viewport) {
      const surface = root._renderSurface;
      if (!surface) {
        throw new Error("inspectScrolling: root has no live render surface");
      }
      return surface.inspectScrolling(target);
    },
    getScrollbars(root) {
      return Object.freeze(
        (root._renderSurface?.scrollbars ?? []).map((scrollbar) =>
          Object.freeze({
            role: "scrollbar",
            orientation: scrollbar.orientation,
            valueMinimum: scrollbar.minimum,
            valueMaximum: scrollbar.maximum,
            valueNow: scrollbar.value,
            controls: scrollbar.element,
            track: Object.freeze({ ...scrollbar.track }),
            thumb: Object.freeze({ ...scrollbar.thumb }),
          })
        ),
      );
    },
    setSelectionRange(node, start, end, direction) {
      node.setSelectionRange(start, end, direction);
    },

    // §3, RULED BUILD NOW — real passthroughs (closest returns the
    // SDElement or null; the cap's ensureElementHandle handles
    // wrapping/null, same as any other node-returning backend call).
    matches(node, selector) {
      return node.matches(selector);
    },
    closest(node, selector) {
      return node.closest(selector);
    },

    addEventListener(node, type, callback) {
      let wrapper = eventListenerWrappers.get(callback);
      if (!wrapper) {
        wrapper = (event) => callback(eventIntrinsics(event));
        eventListenerWrappers.set(callback, wrapper);
      }
      node.addEventListener(type, wrapper);
    },
    removeEventListener(node, type, callback) {
      const wrapper = eventListenerWrappers.get(callback);
      if (wrapper) node.removeEventListener(type, wrapper);
    },
    // A dispatch of the node's dispatchEvent(), as a script's: its event is
    // untrusted (DOM "dispatchEvent(event)").
    dispatchEvent(node, name, detail) {
      return node.dispatchEvent(createSyntheticEvent(name, { detail, bubbles: true }));
    },
  };
}
