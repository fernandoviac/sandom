import { sharedDomCore } from "../dom-wasm/core.js";
import { createEventBindings } from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";

// Language identities and invocation transport only. Native records own
// registration, snapshots, propagation, removal, and invocation lifetime.
const dispatchStateByEvent = new WeakMap();
// A realm target can acquire a new document/core while an old dispatch still
// owns its path. Never reuse that owner's handles or callbacks in the new core.
const bindingsByCore = new WeakMap();
const targetsByCore = new WeakMap();
const hostListenerDetailsByCallback = new WeakMap();
// A node wrapper is weak (DomCore.wrapperFor), but its listeners' callbacks
// and its event-handler records live in JavaScript state keyed by that
// wrapper. A collected wrapper would lose them while the native target keeps
// the listeners, and a new wrapper of the node would dispatch identities it
// does not know. A node wrapper with a registered listener therefore stays
// alive until its last registration is released: by removal, or by the
// disposal of its document.
const listenedNodesByCore = new WeakMap();
let nextCallbackIdentity = 1;
let nextEventIdentity = 1n;
const targetFinalizer = new FinalizationRegistry(({ core, handle }) => {
  targetsByCore.get(core)?.delete(handle);
  core.status("event_target_release", handle);
});

function targetCore(target) {
  return target._domCore ?? target.document?._domCore ?? sharedDomCore;
}

function targetBinding(target, core = targetCore(target)) {
  let bindings = bindingsByCore.get(core);
  let binding = bindings?.get(target);
  if (binding) return binding;
  if (!bindings) bindingsByCore.set(core, bindings = new WeakMap());
  const handle = core.handle("event_target_acquire", target._coreHandle ?? 0n);
  binding = {
    core,
    handle,
    target,
    identities: new Map(),
    callbacks: new Map(),
    registrations: new Map(),
  };
  bindings.set(target, binding);
  let targets = targetsByCore.get(core);
  if (!targets) targetsByCore.set(core, targets = new Map());
  targets.set(handle, new WeakRef(target));
  targetFinalizer.register(target, { core, handle });
  core.eventDisposalHandler ??= prepareEventDisposal;
  return binding;
}

function releaseRegistration(binding, handle) {
  const entry = binding.registrations.get(handle);
  if (!entry) return;
  binding.registrations.delete(handle);
  if (binding.registrations.size === 0) listenedNodesByCore.get(binding.core)?.delete(binding.target);
  const identity = binding.callbacks.get(entry.identity);
  identity.references--;
  if (identity.references === 0) {
    binding.callbacks.delete(entry.identity);
    binding.identities.delete(identity.callback);
  }
  if (entry.signal && entry.abortHandler) {
    entry.signal.removeEventListener("abort", entry.abortHandler);
  }
}

function prepareEventDisposal(core, documentHandle) {
  const retained = [];
  for (const [handle, reference] of targetsByCore.get(core) ?? []) {
    const target = reference.deref();
    if (
      target && core.handle("event_target_document", handle) === documentHandle
    ) {
      retained.push(bindingsByCore.get(core).get(target));
    }
  }
  // Native disposal clears registrations before any signal-removal hook can
  // reenter. A currently invoked callback is retained in its invocation closure.
  return () => {
    for (const binding of retained) {
      for (const handle of binding.registrations.keys()) {
        releaseRegistration(binding, handle);
      }
    }
  };
}

export function normalizeListenerOptions(options) {
  if (typeof options === "boolean") {
    return { capture: options, once: false, passive: false, signal: null };
  }
  return {
    capture: Boolean(options?.capture),
    once: Boolean(options?.once),
    passive: Boolean(options?.passive),
    signal: options?.signal ?? null,
  };
}
export function markHostEventListener(callback, details) {
  if (
    typeof callback !== "function" ||
    details === null ||
    typeof details !== "object" ||
    details.participant === null ||
    details.participant === undefined ||
    typeof details.runHostOperation !== "function"
  ) {
    throw new TypeError("Host event listener details are invalid");
  }
  hostListenerDetailsByCallback.set(
    callback,
    Object.freeze({
      participant: details.participant,
      runHostOperation: details.runHostOperation,
    }),
  );
}

function addListener(target, eventType, callback, normalized) {
  const binding = targetBinding(target);
  let identity = binding.identities.get(callback);
  if (identity === undefined) {
    if (nextCallbackIdentity > 0xffffffff) {
      throw new RangeError("Event callback identities exhausted");
    }
    identity = nextCallbackIdentity++;
  }
  const handle = binding.core.handle(
    "listener_add",
    binding.handle,
    ...binding.core.input(eventType),
    identity,
    (normalized.capture ? 1 : 0) | (normalized.once ? 2 : 0) |
      (normalized.passive ? 4 : 0),
  );
  if (handle === 0n) return;
  const retained = binding.callbacks.get(identity) ??
    { callback, references: 0 };
  retained.references++;
  binding.callbacks.set(identity, retained);
  binding.identities.set(callback, identity);
  const entry = { identity, type: eventType, capture: normalized.capture, signal: normalized.signal, abortHandler: null };
  binding.registrations.set(handle, entry);
  if (target._coreHandle) {
    let listenedNodes = listenedNodesByCore.get(binding.core);
    if (!listenedNodes) listenedNodesByCore.set(binding.core, listenedNodes = new Set());
    listenedNodes.add(target);
  }
  if (entry.signal) {
    entry.abortHandler = () =>
      removeEventListener(target, eventType, callback, {
        capture: normalized.capture,
      });
    try {
      entry.signal.addEventListener("abort", entry.abortHandler, {
        once: true,
      });
    } catch (error) {
      removeEventListener(target, eventType, callback, {
        capture: normalized.capture,
      });
      throw error;
    }
  }
}

function removeListener(binding, eventType, callback, capture) {
  const identity = binding.identities.get(callback);
  if (identity === undefined) return;
  const handle = binding.core.handle(
    "listener_remove",
    binding.handle,
    ...binding.core.input(eventType),
    identity,
    capture ? 1 : 0,
  );
  if (handle !== 0n) releaseRegistration(binding, handle);
}

// Removes every listener of `target`: the HTML Standard's "erase all event
// listeners and handlers" for document.open(), and the release of a
// document whose window is a global object that outlives it.
export function removeAllEventListeners(target, core = targetCore(target)) {
  const binding = bindingsByCore.get(core)?.get(target);
  if (!binding) return;
  for (const entry of [...binding.registrations.values()]) {
    const retained = binding.callbacks.get(entry.identity);
    if (retained) removeListener(binding, entry.type, retained.callback, entry.capture);
  }
}

// Event.timeStamp on the page's clock (DOM, §2.2 "Interface Event": event
// creation sets it to the relative high resolution time of the event's
// relevant global). A window's event constructors stamp an event when the
// page creates it (src/dom/page-clock.js); an event that Sandom or the host
// created takes the time when it is first dispatched to a node or window of
// a document whose page has a clock.
const eventTimeClocks = new WeakMap();

export function stampEventTime(event, clock) {
  Object.defineProperty(event, "timeStamp", { configurable: true, value: clock.now() });
  eventTimeClocks.set(event, clock);
}

function instrumentEvent(event) {
  let state = dispatchStateByEvent.get(event);
  if (state) return state;
  if (nextEventIdentity > 0xffffffffffffffffn) {
    throw new RangeError("Event identities exhausted");
  }
  const nativePreventDefault = event.preventDefault.bind(event);
  const nativeStopPropagation = event.stopPropagation.bind(event);
  const nativeStopImmediatePropagation = event.stopImmediatePropagation.bind(
    event,
  );
  state = {
    target: null,
    originalTarget: null,
    relatedTarget: "relatedTarget" in event ? event.relatedTarget : null,
    currentTarget: null,
    currentRelatedTarget: null,
    eventPhase: Event.NONE,
    path: [],
    visiblePath: [],
    handle: 0n,
    core: null,
    identity: nextEventIdentity++,
    passive: false,
  };
  Object.defineProperties(event, {
    target: { configurable: true, get: () => state.target },
    currentTarget: { configurable: true, get: () => state.currentTarget },
    eventPhase: { configurable: true, get: () => state.eventPhase },
    composedPath: { configurable: true, value: () => [...state.visiblePath] },
    preventDefault: {
      configurable: true,
      value: () => {
        if (!state.passive) {
          nativePreventDefault();
          if (state.handle && event.defaultPrevented) {
            state.core.status("event_dispatch_flags", state.handle, 4);
          }
        }
      },
    },
    stopPropagation: {
      configurable: true,
      value: () => {
        if (state.handle) {
          state.core.status("event_dispatch_flags", state.handle, 1);
        }
        nativeStopPropagation();
      },
    },
    stopImmediatePropagation: {
      configurable: true,
      value: () => {
        if (state.handle) {
          state.core.status("event_dispatch_flags", state.handle, 3);
        }
        nativeStopImmediatePropagation();
      },
    },
  });
  if ("relatedTarget" in event) {
    Object.defineProperty(event, "relatedTarget", {
      configurable: true,
      get: () =>
        state.currentTarget ? state.currentRelatedTarget : state.relatedTarget,
    });
  }
  dispatchStateByEvent.set(event, state);
  return state;
}

function isNode(value) {
  return value !== null && typeof value === "object" &&
    value._coreHandle !== undefined;
}

function decodeDispatchPath(core, handle) {
  const count = core.status("event_dispatch_path", handle);
  const view = new DataView(
    core.memory.buffer,
    core.exports.abi_output_pointer(),
    count * 48,
  );
  // Copy numeric values before wrapper materialization can allocate/grow memory.
  const records = Array.from({ length: count }, (_, index) => {
    const offset = index * 48;
    return {
      identity: view.getBigUint64(offset, true),
      node: view.getBigUint64(offset + 8, true),
      target: view.getBigUint64(offset + 16, true),
      related: view.getBigUint64(offset + 40, true),
    };
  });
  return records.map((record) => {
    const node = record.node
      ? core.wrapperFor(record.node)
      : targetsByCore.get(core)?.get(record.identity)?.deref();
    if (!node) {
      throw new Error("Event target identity was released during dispatch");
    }
    const binding = targetBinding(node, core);
    return {
      node,
      binding,
      target: record.target ? core.wrapperFor(record.target) : node,
      related: record.related ? core.wrapperFor(record.related) : null,
    };
  });
}

function dispatchCoordinator(core, handle, path) {
  const count = core.status("event_dispatch_listeners", handle);
  const view = new DataView(
    core.memory.buffer,
    core.exports.abi_output_pointer(),
    count * 8,
  );
  let coordinator = null;
  for (let index = 0; index < count; index++) {
    const binding = path[view.getUint32(index * 8, true)].binding;
    const identity = view.getUint32(index * 8 + 4, true);
    const callback = binding.callbacks.get(identity)
      ?.callback;
    const details = hostListenerDetailsByCallback.get(callback);
    if (!details) continue;
    if (coordinator !== null && coordinator !== details.runHostOperation) {
      throw new Error(
        "One event path cannot span multiple host reaction coordinators",
      );
    }
    coordinator = details.runHostOperation;
  }
  return coordinator;
}

// A listener: a function, called with the current target as `this`, or an
// object with handleEvent.
function invokeListener(callback, event) {
  return typeof callback === "function"
    ? callback.call(this, event)
    : callback.handleEvent(event);
}

// `targetOverride` is the HTML Standard's "legacy target override flag": the
// window's load event reports the document as its target.
function dispatch(target, event, reportException, targetOverride = null) {
  const state = instrumentEvent(event);
  const binding = targetBinding(target);
  const core = binding.core;
  const document = target.nodeType === 9 ? target : target.ownerDocument;
  const windowDocument = document ?? (target.document?.defaultView === target ? target.document : null);
  const pageClock = windowDocument?._clock ?? null;
  if (pageClock !== null && eventTimeClocks.get(event) !== pageClock) stampEventTime(event, pageClock);
  // The document whose node, window or media query list the event targets.
  // Its listeners run as its component code (src/dom/component-code.js).
  const listenerDocument = windowDocument ?? target._document ?? null;
  // A listener exception goes to the reporter of that document (its scripts
  // report it as an error event at the window), else to the realm's
  // reportError.
  reportException ??= listenerDocument?._reportException ?? globalThis.reportError;
  if (document?.defaultView) {
    core.status(
      "event_target_window_set",
      targetBinding(document, core).handle,
      targetBinding(document.defaultView, core).handle,
    );
  }
  const relatedOpaque = state.relatedTarget && !isNode(state.relatedTarget) &&
      (typeof state.relatedTarget === "object" ||
        typeof state.relatedTarget === "function")
    ? targetBinding(state.relatedTarget, core).handle
    : 0n;
  const handle = core.handle(
    "event_dispatch_begin",
    binding.handle,
    state.identity,
    ...core.input(event.type),
    event.bubbles ? 1 : 0,
    event.composed ? 1 : 0,
    isNode(state.relatedTarget) ? state.relatedTarget._coreHandle : 0n,
    event.defaultPrevented ? 1 : 0,
    relatedOpaque,
  );
  state.handle = handle;
  state.core = core;
  state.originalTarget = targetOverride ?? target;
  state.target = state.originalTarget;
  let completed = false;
  const finish = () => {
    if (!completed) core.status("event_dispatch_abort", handle);
    state.handle = 0n;
    state.currentTarget = null;
    state.target = state.originalTarget;
    state.eventPhase = Event.NONE;
    state.path = [];
    state.visiblePath = [];
    state.passive = false;
  };
  try {
    const path = decodeDispatchPath(core, handle);
    state.path = path.map((entry) => entry.node);
    state.visiblePath = state.path;
    const coordinator = dispatchCoordinator(core, handle, path);
    const advance = () => {
      for (;;) {
        const token = core.handle("event_dispatch_next", handle);
        if (token === 0n) {
          const accepted = core.status("event_dispatch_complete", handle) !== 0;
          completed = true;
          return accepted;
        }
        core.status("event_dispatch_invocation", handle);
        const view = new DataView(
          core.memory.buffer,
          core.exports.abi_output_pointer(),
          24,
        );
        const listener = view.getBigUint64(0, true);
        const identity = view.getUint32(8, true);
        const index = view.getUint32(12, true);
        const phase = view.getUint32(16, true);
        const flags = view.getUint32(20, true);
        const current = path[index];
        const currentBinding = current.binding;
        const callback = currentBinding.callbacks.get(identity).callback;
        state.currentTarget = current.node;
        state.target = targetOverride ?? current.target;
        state.currentRelatedTarget = isNode(state.relatedTarget)
          ? current.related
          : state.relatedTarget;
        state.eventPhase = phase;
        const visibleCount = core.status(
          "event_dispatch_visible_path",
          handle,
          index,
        );
        const visible = new DataView(
          core.memory.buffer,
          core.exports.abi_output_pointer(),
          visibleCount * 4,
        );
        state.visiblePath = Array.from(
          { length: visibleCount },
          (_, offset) => path[visible.getUint32(offset * 4, true)].node,
        );
        if (flags & 2) releaseRegistration(currentBinding, listener);
        state.passive = (flags & 4) !== 0;
        let result;
        let outcome = 0;
        try {
          result = enterComponentCode(listenerDocument, invokeListener, current.node, [callback, event]);
        } catch (error) {
          outcome = 1;
          reportException(error);
        }
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).then(
            () => {
              state.passive = false;
              core.status("event_dispatch_resume", handle, token, outcome);
              return advance();
            },
            (error) => {
              state.passive = false;
              core.status("event_dispatch_resume", handle, token, 1);
              throw error;
            },
          );
        }
        state.passive = false;
        core.status("event_dispatch_resume", handle, token, outcome);
      }
    };
    const result = coordinator === null ? advance() : coordinator(advance);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          finish();
          return value;
        },
        (error) => {
          finish();
          throw error;
        },
      );
    }
    finish();
    // A click that no listener canceled reaches the activation behavior of
    // the hyperlink around its target (src/dom/scripts.js).
    if (event.type === "click" && !event.defaultPrevented && document?._scriptProcessing) {
      document._scriptProcessing.followHyperlink(target);
    }
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

export const { addEventListener, removeEventListener, dispatchEvent } =
  createEventBindings({
    listenerOptions: normalizeListenerOptions,
    lookupTarget: (target) => bindingsByCore.get(targetCore(target))?.get(target),
    exceptionReporter: ({ reportException }) => reportException,
    eventIdentity: (event) => {
      if (!(event instanceof Event)) {
        throw new TypeError("dispatchEvent expects an Event");
      }
      return event;
    },
    addListener,
    removeListener,
    dispatch,
  });

const eventTargetBrands = new WeakSet();

// Wrapper materialization does not invoke JavaScript constructors.
export function registerEventTargetWrapper(target) {
  eventTargetBrands.add(target);
}

function requireEventTarget(target) {
  if (!eventTargetBrands.has(target)) throw new TypeError("Illegal EventTarget receiver");
}

// WebIDL receiver and argument conversion; the existing native event transport
// owns registrations, propagation, cancellation and callback lifetime.
export const SDEventTarget = class EventTarget {
  constructor() {
    registerEventTargetWrapper(this);
  }
  addEventListener(type, callback, options = undefined) {
    requireEventTarget(this);
    if (arguments.length < 2) throw new TypeError("addEventListener requires two arguments");
    if (typeof type === "symbol") throw new TypeError("An event type cannot be a Symbol");
    const eventType = String(type);
    if (callback != null && typeof callback !== "object" && typeof callback !== "function") {
      throw new TypeError("An event listener must be an object or null");
    }
    addEventListener(this, eventType, callback, options);
  }
  removeEventListener(type, callback, options = undefined) {
    requireEventTarget(this);
    if (arguments.length < 2) throw new TypeError("removeEventListener requires two arguments");
    if (typeof type === "symbol") throw new TypeError("An event type cannot be a Symbol");
    const eventType = String(type);
    if (callback != null && typeof callback !== "object" && typeof callback !== "function") {
      throw new TypeError("An event listener must be an object or null");
    }
    removeEventListener(this, eventType, callback, options);
  }
  dispatchEvent(event) {
    requireEventTarget(this);
    if (arguments.length < 1) throw new TypeError("dispatchEvent requires an event");
    return dispatchEvent(this, event);
  }
};
Object.defineProperty(SDEventTarget.prototype, Symbol.toStringTag, {
  value: "EventTarget", configurable: true,
});
for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  Object.defineProperty(SDEventTarget.prototype, name, { enumerable: true });
}

// Fires `event` at a document's window with the legacy target override:
// listeners see the document as the event's target.
export function dispatchWindowEventWithDocumentTarget(window, event, document, reportException) {
  if (!(event instanceof Event)) throw new TypeError("dispatchEvent expects an Event");
  return dispatch(window, event, reportException, document);
}

function defineEventFields(event, init) {
  for (const [name, value] of Object.entries(init)) {
    if (name === "bubbles" || name === "cancelable" || name === "composed") {
      continue;
    }
    Object.defineProperty(event, name, {
      configurable: true,
      enumerable: true,
      value,
    });
  }
}

export class SDKeyboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, init);
  }
}

export class SDMouseEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, {
      button: 0,
      buttons: 0,
      clientX: 0,
      clientY: 0,
      screenX: 0,
      screenY: 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...init,
    });
  }
}
export class SDFocusEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, init);
  }
}

// A DataTransfer's text data store. Formats compare ASCII-case-insensitively;
// "text" names text/plain and "url" names text/uri-list, read back as its
// first URL.
function dataTransferFormat(format) {
  const normalized = String(format).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (normalized === "text") return ["text/plain", false];
  if (normalized === "url") return ["text/uri-list", true];
  return [normalized, false];
}

export class SDDataTransfer {
  #data = new Map();
  get types() {
    return Object.freeze([...this.#data.keys()]);
  }
  getData(format) {
    const [type, firstURL] = dataTransferFormat(format);
    const data = this.#data.get(type) ?? "";
    if (!firstURL) return data;
    return data.split(/\r\n|\n|\r/).find((line) => line !== "" && !line.startsWith("#")) ?? "";
  }
  setData(format, data) {
    const [type] = dataTransferFormat(format);
    this.#data.delete(type);
    this.#data.set(type, String(data));
  }
  clearData(format) {
    if (format === undefined) this.#data.clear();
    else this.#data.delete(dataTransferFormat(format)[0]);
  }
}

export class SDClipboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, { clipboardData: null, ...init });
  }
}

// A form's submit event; submitter is the button that submitted it, null
// when the form submitted itself.
export class SDSubmitEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, { submitter: null, ...init });
  }
}

// HTML's ToggleEvent: the state a details element or popover had before a
// toggle and the state it has after it, "open" or "closed".
export class SDToggleEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, { oldState: String(init.oldState ?? ""), newState: String(init.newState ?? "") });
  }
}

// CSS Animations' AnimationEvent: exactly animationName, elapsedTime and
// pseudoElement.
export class SDAnimationEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, {
      animationName: String(init.animationName ?? ""),
      elapsedTime: Number(init.elapsedTime ?? 0),
      pseudoElement: String(init.pseudoElement ?? ""),
    });
  }
}

// CSS Transitions' TransitionEvent: exactly propertyName, elapsedTime and
// pseudoElement.
export class SDTransitionEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, {
      propertyName: String(init.propertyName ?? ""),
      elapsedTime: Number(init.elapsedTime ?? 0),
      pseudoElement: String(init.pseudoElement ?? ""),
    });
  }
}
// Web Animations' AnimationPlaybackEvent: exactly currentTime and
// timelineTime, null when unresolved. Animations dispatch it (remove). Its
// constructor has the interface's name, as in a browser.
export const SDAnimationPlaybackEvent = class AnimationPlaybackEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    defineEventFields(this, {
      currentTime: init.currentTime == null ? null : Number(init.currentTime),
      timelineTime: init.timelineTime == null ? null : Number(init.timelineTime),
    });
  }
};
const ANIMATION_EVENT_TYPES = new Set(["animationstart", "animationiteration", "animationend", "animationcancel"]);
const TRANSITION_EVENT_TYPES = new Set(["transitionrun", "transitionstart", "transitionend", "transitioncancel"]);

export class SDPointerEvent extends SDMouseEvent {}

export function createEvent(type, init = {}, fields = {}) {
  const nativeInit = {
    bubbles: Boolean(init.bubbles),
    cancelable: Boolean(init.cancelable),
    composed: Boolean(init.composed),
    ...init,
    ...fields,
  };
  if (
    type === "focus" || type === "blur" || type === "focusin" ||
    type === "focusout"
  ) {
    return new SDFocusEvent(type, nativeInit);
  }
  if (String(type).startsWith("key")) {
    return new SDKeyboardEvent(type, nativeInit);
  }
  if (String(type).startsWith("pointer")) {
    return new SDPointerEvent(type, nativeInit);
  }
  if (type === "copy" || type === "cut" || type === "paste") {
    return new SDClipboardEvent(type, nativeInit);
  }
  if (type === "submit") {
    return new SDSubmitEvent(type, nativeInit);
  }
  if (type === "toggle" || type === "beforetoggle") {
    return new SDToggleEvent(type, nativeInit);
  }
  if (ANIMATION_EVENT_TYPES.has(type)) {
    return new SDAnimationEvent(type, nativeInit);
  }
  if (TRANSITION_EVENT_TYPES.has(type)) {
    return new SDTransitionEvent(type, nativeInit);
  }
  if (
    String(type).startsWith("mouse") || type === "click" ||
    type === "dblclick" || type === "contextmenu"
  ) {
    return new SDMouseEvent(type, nativeInit);
  }
  if (Object.hasOwn(init, "detail")) {
    const event = new CustomEvent(type, {
      bubbles: nativeInit.bubbles,
      cancelable: nativeInit.cancelable,
      composed: nativeInit.composed,
      detail: init.detail,
    });
    defineEventFields(event, fields);
    return event;
  }
  const event = new Event(type, nativeInit);
  defineEventFields(event, { ...init, ...fields });
  return event;
}

export function eventIntrinsics(event) {
  const intrinsics = {
    type: event.type,
    target: event.target,
    currentTarget: event.currentTarget,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    timeStamp: event.timeStamp,
    detail: event.detail,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    stopImmediatePropagation: () => event.stopImmediatePropagation(),
  };
  for (
    const name of [
      "key",
      "code",
      "shiftKey",
      "altKey",
      "ctrlKey",
      "metaKey",
      "clientX",
      "clientY",
      "button",
      "buttons",
      "pointerId",
      "pointerType",
      "deltaX",
      "deltaY",
      "deltaMode",
      "propertyName",
      "animationName",
      "elapsedTime",
      "pseudoElement",
      "clipboardData",
      "oldState",
      "newState",
      "submitter",
    ]
  ) {
    if (name in event) intrinsics[name] = event[name];
  }
  return intrinsics;
}
