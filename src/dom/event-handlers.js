// Event handlers (HTML Standard, 8.1.8): the IDL attributes (`onclick`)
// and the content attributes (`onclick="…"`) of elements, documents and
// windows. A content attribute stores its internal raw uncompiled handler;
// the handler compiles in the document realm, with the scope chain of
// element, form owner and document, when its event first fires or a script
// reads the IDL attribute.
import { addEventListener, removeAllEventListeners, removeEventListener } from "./events.js";

// GlobalEventHandlers, with the pointer, animation, transition and
// selection handlers that Chrome supports.
export const GLOBAL_EVENT_HANDLER_TYPES = Object.freeze([
  "abort", "animationcancel", "animationend", "animationiteration", "animationstart",
  "auxclick", "beforeinput", "beforematch", "beforetoggle", "blur", "cancel",
  "canplay", "canplaythrough", "change", "click", "close", "contextlost",
  "contextmenu", "contextrestored", "copy", "cuechange", "cut", "dblclick",
  "drag", "dragend", "dragenter", "dragleave", "dragover", "dragstart", "drop",
  "durationchange", "emptied", "ended", "error", "focus", "formdata",
  "gotpointercapture", "input", "invalid", "keydown", "keypress", "keyup",
  "load", "loadeddata", "loadedmetadata", "loadstart", "lostpointercapture",
  "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout",
  "mouseover", "mouseup", "paste", "pause", "play", "playing",
  "pointercancel", "pointerdown", "pointerenter", "pointerleave",
  "pointermove", "pointerout", "pointerover", "pointerup", "progress",
  "ratechange", "reset", "resize", "scroll", "scrollend",
  "securitypolicyviolation", "seeked", "seeking", "select",
  "selectionchange", "selectstart", "slotchange", "stalled", "submit",
  "suspend", "timeupdate", "toggle", "transitioncancel", "transitionend",
  "transitionrun", "transitionstart", "volumechange", "waiting", "wheel",
]);

// WindowEventHandlers.
export const WINDOW_EVENT_HANDLER_TYPES = Object.freeze([
  "afterprint", "beforeprint", "beforeunload", "hashchange", "languagechange",
  "message", "messageerror", "offline", "online", "pagehide", "pagereveal",
  "pageshow", "pageswap", "popstate", "rejectionhandled", "storage",
  "unhandledrejection", "unload",
]);

const globalTypes = new Set(GLOBAL_EVENT_HANDLER_TYPES);
const windowTypes = new Set(WINDOW_EVENT_HANDLER_TYPES);

// The handlers of a body or frameset element that the Window owns.
const windowReflectingTypes = new Set([
  ...WINDOW_EVENT_HANDLER_TYPES, "blur", "error", "focus", "load", "resize", "scroll",
]);

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

const handlerRecords = new WeakMap();

function isWindow(target) {
  return target?.nodeType === undefined && target?.document?.defaultView === target;
}

function documentOf(target) {
  if (target.nodeType === 9) return target;
  if (target.nodeType !== undefined) return target.ownerDocument;
  return target.document ?? null;
}

// The event handler of `target` that a content attribute named `name` on
// `element` sets, or null when the attribute is no event handler there.
function contentAttributeTarget(element, name) {
  if (name.length < 3 || !name.startsWith("on")) return null;
  if (element.namespaceURI !== HTML_NS && element.namespaceURI !== SVG_NS) return null;
  const type = name.slice(2);
  const local = element.localName;
  if ((local === "body" || local === "frameset") && element.namespaceURI === HTML_NS && windowReflectingTypes.has(type)) {
    const window = element.ownerDocument?.defaultView ?? null;
    return window === null ? null : { target: window, type };
  }
  return globalTypes.has(type) ? { target: element, type } : null;
}

// "Getting the current value of the event handler".
function currentValue(target, type, record) {
  if (record.raw !== null) {
    const raw = record.raw;
    record.raw = null;
    record.value = null;
    const document = raw.document;
    const compiled = document._scriptProcessing?.compileEventHandler(target, type, raw) ?? null;
    record.value = compiled;
  }
  return record.value;
}

function invokeHandler(record, target, type, event) {
  const callback = currentValue(target, type, record);
  if (typeof callback !== "function") return;
  // A Window's onerror receives the error event's fields, and true cancels.
  if (type === "error" && isWindow(target) && event instanceof ErrorEvent) {
    const result = callback.call(target, event.message, event.filename, event.lineno, event.colno, event.error);
    if (result === true) event.preventDefault();
    return;
  }
  const result = callback.call(target, event);
  const core = target._domCore;
  if (core !== undefined) {
    if (core.status("event_handler_result", typeof result === "boolean" ? 1 : 0, result ? 1 : 0)) {
      event.preventDefault();
    }
  } else if (result === false) {
    event.preventDefault();
  }
}

function activate(target, type) {
  let records = handlerRecords.get(target);
  if (!records) {
    records = new Map();
    handlerRecords.set(target, records);
  }
  let record = records.get(type);
  if (record) return record;
  record = {
    value: null,
    raw: null,
    listener(event) {
      invokeHandler(record, target, type, event);
    },
  };
  records.set(type, record);
  addEventListener(target, type, record.listener);
  return record;
}

function deactivate(target, type) {
  const records = handlerRecords.get(target);
  const record = records?.get(type);
  if (!record) return;
  removeEventListener(target, type, record.listener);
  records.delete(type);
  if (records.size === 0) handlerRecords.delete(target);
}

// The IDL attribute getter.
export function getEventHandler(target, type) {
  const record = handlerRecords.get(target)?.get(type);
  return record ? currentValue(target, type, record) : null;
}

// The IDL attribute setter: a function, or null for anything else.
export function setEventHandler(target, type, candidate) {
  const value = typeof candidate === "function" ? candidate : null;
  if (value === null) {
    deactivate(target, type);
    return;
  }
  const record = activate(target, type);
  record.raw = null;
  record.value = value;
}

// "Erase all event listeners and handlers" given `target`.
export function eraseEventListenersAndHandlers(target, core) {
  removeAllEventListeners(target, core);
  handlerRecords.delete(target);
}

// A content attribute changed: `value` is the new attribute value, or null
// when the attribute was removed. `position` is where Chrome puts the
// handler's source: just after the start tag for an attribute the parser
// created, the parser's position for one a script set while the document
// parses, else the start of the document (1-based line, 0-based column).
export function eventHandlerAttributeChanged(element, name, value, position = DOCUMENT_START) {
  scannedElements.add(element);
  const destination = contentAttributeTarget(element, name);
  if (destination === null) return;
  const { target, type } = destination;
  if (value === null) {
    deactivate(target, type);
    return;
  }
  const document = documentOf(element);
  if (document === null) return;
  const record = activate(target, type);
  record.value = null;
  record.raw = Object.freeze({
    body: value,
    element,
    document,
    url: document.URL,
    line: position.line,
    column: position.column,
  });
}

const DOCUMENT_START = Object.freeze({ line: 1, column: 0 });

// The elements with event handler content attributes that a document parse
// created, each with the position after its start tag (html.js `run`).
export function activateHandlerElements(entries) {
  for (const { element, line, column } of entries) {
    if (scannedElements.has(element)) continue;
    const position = { line, column };
    for (const name of element.getAttributeNames()) {
      if (name.startsWith("on")) eventHandlerAttributeChanged(element, name, element.getAttribute(name), position);
    }
  }
}

// The content-attribute handlers of every element under `root` that
// fragment parsing created: the parser sets attributes without a mutation
// notification. An element whose handlers a script or an earlier walk
// already set keeps them.
const scannedElements = new WeakSet();
const handlerSelector = [...globalTypes, ...windowTypes].map((type) => `[on${type}]`).join(",");

export function hasEventHandlerAttributes(root) {
  return root.querySelector(handlerSelector) !== null;
}

export function activateParsedEventHandlers(root, position) {
  for (const element of root.querySelectorAll(handlerSelector)) {
    if (scannedElements.has(element)) continue;
    for (const name of element.getAttributeNames()) {
      if (name.startsWith("on")) eventHandlerAttributeChanged(element, name, element.getAttribute(name), position);
    }
    scannedElements.add(element);
  }
}

// The IDL attributes of a Window: GlobalEventHandlers and
// WindowEventHandlers. A realm global keeps a handler attribute it already
// has (a worker's `onmessage`) unless `replace` is set; a document realm
// replaces them while it holds the document's window.
export function installWindowEventHandlers(window, { replace = false } = {}) {
  for (const type of [...GLOBAL_EVENT_HANDLER_TYPES, ...WINDOW_EVENT_HANDLER_TYPES]) {
    const name = `on${type}`;
    if (!replace && name in window) continue;
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => getEventHandler(window, type),
      set: (value) => setEventHandler(window, type, value),
    });
  }
}

// The handlers of a Document: GlobalEventHandlers and the document's own.
export const DOCUMENT_EVENT_HANDLER_TYPES = Object.freeze([
  ...GLOBAL_EVENT_HANDLER_TYPES, "readystatechange", "visibilitychange",
]);

export function installPrototypeEventHandlers(prototype, types) {
  for (const type of types) {
    Object.defineProperty(prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() {
        return getEventHandler(this, type);
      },
      set(value) {
        setEventHandler(this, type, value);
      },
    });
  }
}
