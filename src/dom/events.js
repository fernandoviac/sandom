import { sharedDomCore } from "../dom-wasm/core.js";
import { createEventBindings } from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { nodeMember } from "./node-members.js";

// The flags of event-state.watpart, by WAT name without the EVENT_STATE_
// prefix.
const EVENT_STATE = Object.freeze(Object.fromEntries([
  "BUBBLES", "CANCELABLE", "COMPOSED", "TRUSTED", "CANCELED", "STOP_PROPAGATION", "STOP_IMMEDIATE_PROPAGATION",
].map((name) => [name, layoutConstant(`EVENT_STATE_${name}`)])));
const EVENT_LISTENER_RETURNED = layoutConstant("EVENT_LISTENER_RETURNED");
const EVENT_LISTENER_THREW = layoutConstant("EVENT_LISTENER_THREW");
// The listener invocation and listener flags of event-dispatch.watpart.
const EVENT_INVOCATION = Object.freeze(Object.fromEntries(["SIZE", "LISTENER", "IDENTITY", "INDEX", "PHASE", "FLAGS"]
  .map((name) => [name, layoutConstant(`EVENT_INVOCATION_${name}`)])));
const EVENT_LISTENER_CAPTURE = layoutConstant("EVENT_LISTENER_CAPTURE");
const EVENT_LISTENER_ONCE = layoutConstant("EVENT_LISTENER_ONCE");
const EVENT_LISTENER_PASSIVE = layoutConstant("EVENT_LISTENER_PASSIVE");

// Language identities and invocation transport only. Native records own
// registration, snapshots, propagation, removal, and invocation lifetime.
// A realm target can acquire a new document/core while an old dispatch still
// owns its path. Never reuse that owner's handles or callbacks in the new core.
const bindingsByCore = new WeakMap();
const targetsByCore = new WeakMap();
const hostListenerDetailsByCallback = new WeakMap();
// The wrapper of a detached node is weak (DomCore.wrapperFor; a connected
// node's wrapper lives with its document's tree,
// DomCore.connectedWrappersByDocument), but its listeners' callbacks
// and its event-handler records live in JavaScript state keyed by that
// wrapper. A collected wrapper would lose them while the native target keeps
// the listeners, and a new wrapper of the node would dispatch identities it
// does not know. A node wrapper with a registered listener therefore stays
// alive while its document wrapper does, until its last registration is
// released: by removal, or by the disposal of its document. Every node
// wrapper keeps its document wrapper (_documentRetention), so a document that
// nothing else reaches is collected with its listened nodes, and its
// finalizer disposes it.
const listenedNodesByDocument = new WeakMap();
function listenedNodeDocument(target) {
  return target._documentRetention ?? target;
}
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
  if (binding.registrations.size === 0) listenedNodesByDocument.get(listenedNodeDocument(binding.target))?.delete(binding.target);
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

// Adoption gives a node wrapper another document: a listened node moves to
// the listened nodes of that document.
export function moveListenedNode(target, previousDocument, document) {
  const previous = listenedNodesByDocument.get(previousDocument ?? target);
  if (!previous?.delete(target)) return;
  const owner = document ?? target;
  let listenedNodes = listenedNodesByDocument.get(owner);
  if (!listenedNodes) listenedNodesByDocument.set(owner, listenedNodes = new Set());
  listenedNodes.add(target);
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
    (normalized.capture ? EVENT_LISTENER_CAPTURE : 0) | (normalized.once ? EVENT_LISTENER_ONCE : 0) |
      (normalized.passive ? EVENT_LISTENER_PASSIVE : 0),
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
    const document = listenedNodeDocument(target);
    let listenedNodes = listenedNodesByDocument.get(document);
    if (!listenedNodes) listenedNodesByDocument.set(document, listenedNodes = new Set());
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
// relevant global). An event takes the host's high resolution time when it
// is created; a window's event constructors stamp an event on the page's
// clock when the page creates it (src/dom/page-clock.js); an event that
// Sandom or the host created takes the time when it is first dispatched to
// a node or window of a document whose page has a clock.
const hostPerformance = globalThis.performance;

export function stampEventTime(event, clock) {
  const state = eventState(event);
  state.timeStamp = clock.now();
  state.clock = clock;
}

// The state of each Sandom event (DOM §2.2 "Interface Event"): the core's
// event state record (event-state.watpart), which holds its flags and phase
// and decides every change of them, and the type, time stamp and targets,
// which the host holds. While it is dispatched, `handle` is the dispatch
// record of `core`. Only the constructors and the dispatch algorithm of
// this module write it.
const eventStates = new WeakMap();
const stateCore = sharedDomCore;
const eventStateFinalizer = new FinalizationRegistry((handle) => stateCore.status("event_state_release", handle));

function eventState(event) {
  const state = eventStates.get(event);
  if (state === undefined) throw new TypeError("Illegal invocation: the receiver is not an Event");
  return state;
}

// Whether `value` is an Event of Sandom (any of its interfaces).
export function isSandomEvent(value) {
  return eventStates.has(value);
}

// Whether the core's event state of `state` has EVENT_STATE_* flag `flag`.
function hasFlag(state, flag) {
  return (stateCore.status("event_state_flags", state.stateHandle) & flag) !== 0;
}

// Forwards the event_dispatch_flags mask that an event state operation
// returned to the dispatch record of the event's dispatch.
function forwardDispatchFlags(state, mask) {
  if (mask !== 0) state.core.status("event_dispatch_flags", state.handle, mask);
}

// The isTrusted attribute (DOM §2.2) is [LegacyUnforgeable]: an own,
// non-configurable accessor of each event, the same getter for all.
const isTrustedGetter = Object.getOwnPropertyDescriptor({
  get isTrusted() {
    return hasFlag(eventState(this), EVENT_STATE.TRUSTED);
  },
}, "isTrusted").get;

// DOM "inner event creation steps" and "initialize": the state of a new
// event of `type` (a converted DOMString) with the converted EventInit
// members of `init`.
function createEventState(event, type, init) {
  if (nextEventIdentity > 0xffffffffffffffffn) {
    throw new RangeError("Event identities exhausted");
  }
  const stateHandle = stateCore.handle("event_state_create", init.bubbles ? 1 : 0, init.cancelable ? 1 : 0,
    init.composed ? 1 : 0);
  eventStates.set(event, {
    stateHandle,
    type,
    timeStamp: hostPerformance.now(),
    clock: null,
    target: null,
    originalTarget: null,
    relatedTarget: null,
    currentTarget: null,
    currentRelatedTarget: null,
    path: [],
    visiblePath: [],
    handle: 0n,
    core: null,
    identity: nextEventIdentity++,
  });
  eventStateFinalizer.register(event, stateHandle);
  Object.defineProperty(event, "isTrusted", { get: isTrustedGetter, enumerable: true, configurable: false });
}

// DOM "set the canceled flag" (event_state_cancel).
function setCanceledFlag(state) {
  forwardDispatchFlags(state, stateCore.status("event_state_cancel", state.stateHandle));
}

// The stop propagation flag, with the stop immediate propagation flag when
// `immediate` (event_state_stop).
function setStopPropagationFlag(state, immediate = false) {
  forwardDispatchFlags(state, stateCore.status("event_state_stop", state.stateHandle, immediate ? 1 : 0));
}

// The trusted flag of `event`, and the canceled flag of a host event that
// the host canceled (event_state_trust).
function trustEvent(event, trusted = true, canceled = false) {
  stateCore.status("event_state_trust", eventState(event).stateHandle, trusted ? 1 : 0, canceled ? 1 : 0);
}

function isNode(value) {
  return value !== null && typeof value === "object" &&
    value._coreHandle !== undefined;
}

// The dispatch path entries and listener records of event-dispatch.watpart,
// by WAT name without the EVENT_ prefix.
const EVENT = Object.freeze(Object.fromEntries([
  "PATH_SIZE", "PATH_IDENTITY", "PATH_NODE", "PATH_TARGET", "PATH_RELATED",
  "LISTENER_SIZE", "LISTENER_PATH_INDEX", "LISTENER_CALLBACK",
].map((name) => [name, layoutConstant(`EVENT_${name}`)])));

function decodeDispatchPath(core, handle) {
  const count = core.status("event_dispatch_path", handle);
  const view = count === 0 ? null : core.output("event_dispatch_path");
  // Copy numeric values before wrapper materialization can allocate/grow memory.
  const records = Array.from({ length: count }, (_, index) => {
    const offset = index * EVENT.PATH_SIZE;
    return {
      identity: view.getBigUint64(offset + EVENT.PATH_IDENTITY, true),
      node: view.getBigUint64(offset + EVENT.PATH_NODE, true),
      target: view.getBigUint64(offset + EVENT.PATH_TARGET, true),
      related: view.getBigUint64(offset + EVENT.PATH_RELATED, true),
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
  const view = count === 0 ? null : core.output("event_dispatch_listeners");
  let coordinator = null;
  for (let index = 0; index < count; index++) {
    const at = index * EVENT.LISTENER_SIZE;
    const binding = path[view.getUint32(at + EVENT.LISTENER_PATH_INDEX, true)].binding;
    const identity = view.getUint32(at + EVENT.LISTENER_CALLBACK, true);
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

// The activation events of input runs (core/dom/input-run.watpart): the run
// follows the hyperlink of such a click itself.
const runActivationEvents = new WeakSet();
export function markRunActivationEvent(event) {
  runActivationEvents.add(event);
}

// `targetOverride` is the HTML Standard's "legacy target override flag": the
// window's load event reports the document as its target.
function dispatch(target, event, reportException, targetOverride = null) {
  const state = eventState(event);
  const binding = targetBinding(target);
  const core = binding.core;
  // A form's controls can shadow its members (form-dom.js, nodeMember).
  const document = nodeMember(target, "nodeType") === 9 ? target : nodeMember(target, "ownerDocument");
  const windowDocument = document ?? (target.document?.defaultView === target ? target.document : null);
  const pageClock = windowDocument?._clock ?? null;
  if (pageClock !== null && state.clock !== pageClock) stampEventTime(event, pageClock);
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
  const flags = stateCore.status("event_state_flags", state.stateHandle);
  const handle = core.handle(
    "event_dispatch_begin",
    binding.handle,
    state.identity,
    ...core.input(state.type),
    (flags & EVENT_STATE.BUBBLES) !== 0 ? 1 : 0,
    (flags & EVENT_STATE.COMPOSED) !== 0 ? 1 : 0,
    isNode(state.relatedTarget) ? state.relatedTarget._coreHandle : 0n,
    (flags & EVENT_STATE.CANCELED) !== 0 ? 1 : 0,
    relatedOpaque,
  );
  state.handle = handle;
  state.core = core;
  state.originalTarget = targetOverride ?? target;
  state.target = state.originalTarget;
  // The stop flags that the event has before its dispatch stop it before
  // its first listener (event_state_dispatch_begin).
  forwardDispatchFlags(state, stateCore.status("event_state_dispatch_begin", state.stateHandle));
  let completed = false;
  // DOM "dispatch", steps 11 and 12 (event_state_dispatch_end).
  const finish = () => {
    if (!completed) core.status("event_dispatch_abort", handle);
    stateCore.status("event_state_dispatch_end", state.stateHandle);
    state.handle = 0n;
    state.currentTarget = null;
    state.target = state.originalTarget;
    state.path = [];
    state.visiblePath = [];
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
        const view = core.output("event_dispatch_invocation");
        const listener = view.getBigUint64(EVENT_INVOCATION.LISTENER, true);
        const identity = view.getUint32(EVENT_INVOCATION.IDENTITY, true);
        const index = view.getUint32(EVENT_INVOCATION.INDEX, true);
        const phase = view.getUint32(EVENT_INVOCATION.PHASE, true);
        const flags = view.getUint32(EVENT_INVOCATION.FLAGS, true);
        const current = path[index];
        const currentBinding = current.binding;
        const callback = currentBinding.callbacks.get(identity).callback;
        state.currentTarget = current.node;
        state.target = targetOverride ?? current.target;
        state.currentRelatedTarget = isNode(state.relatedTarget)
          ? current.related
          : state.relatedTarget;
        stateCore.status("event_state_listener", state.stateHandle, phase, flags);
        const visibleCount = core.status(
          "event_dispatch_visible_path",
          handle,
          index,
        );
        const visible = visibleCount === 0 ? null : core.output("event_dispatch_visible_path");
        state.visiblePath = Array.from(
          { length: visibleCount },
          (_, offset) => path[visible.getUint32(offset * Uint32Array.BYTES_PER_ELEMENT, true)].node,
        );
        if (flags & EVENT_LISTENER_ONCE) releaseRegistration(currentBinding, listener);
        let result;
        let outcome = EVENT_LISTENER_RETURNED;
        try {
          result = enterComponentCode(listenerDocument, invokeListener, current.node, [callback, event]);
        } catch (error) {
          outcome = EVENT_LISTENER_THREW;
          reportException(error);
        }
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).then(
            () => {
              stateCore.status("event_state_listener", state.stateHandle, -1, 0);
              core.status("event_dispatch_resume", handle, token, outcome);
              return advance();
            },
            (error) => {
              stateCore.status("event_state_listener", state.stateHandle, -1, 0);
              core.status("event_dispatch_resume", handle, token, EVENT_LISTENER_THREW);
              throw error;
            },
          );
        }
        stateCore.status("event_state_listener", state.stateHandle, -1, 0);
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
    // the hyperlink around its target (event_state_follows_hyperlink,
    // src/dom/scripts.js). The click of an input run reaches it through
    // the run (INPUT_EFFECT_HYPERLINK, src/dom/input-activation.js).
    if (document?._scriptProcessing && !runActivationEvents.has(event) &&
      stateCore.status("event_state_follows_hyperlink", state.stateHandle, ...stateCore.input(state.type)) !== 0) {
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
      if (!eventStates.has(event)) {
        throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
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
    return dispatchEventFromScript(this, event);
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
  if (!eventStates.has(event)) throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
  return dispatch(window, event, reportException, document);
}

// Sandom's event interfaces (DOM §2.2 Event, §2.4 CustomEvent; UI Events;
// HTML; CSS Animations and Transitions; Web Animations). They are
// independent of the host's Event: a window exposes them to its page, the
// user agent creates its events from them, and every event that Sandom
// dispatches is one of them. Each constructor converts its arguments as
// Web IDL does: the type, then the members of its dictionary, the
// inherited dictionary's first, each dictionary's in lexicographic order.

function missingArgument(interfaceName) {
  return new TypeError(`Failed to construct '${interfaceName}': 1 argument required, but only 0 present.`);
}

// A dictionary argument: undefined and null are an empty dictionary.
function dictionaryArgument(interfaceName, value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError(`Failed to construct '${interfaceName}': The provided value is not of type '${interfaceName}Init'.`);
  }
  return value;
}

// Web IDL conversions of a dictionary member, given its default.
const toDOMString = (value, fallback = "") => value === undefined ? fallback : `${value}`;
const toLong = (value) => value === undefined ? 0 : Number(value) | 0;
const toUnsignedLong = (value) => value === undefined ? 0 : Number(value) >>> 0;
const toShort = (value) => value === undefined ? 0 : (Number(value) << 16) >> 16;
const toUnsignedShort = (value) => value === undefined ? 0 : Number(value) & 0xffff;
function toDouble(interfaceName, member, value, fallback = 0) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`Failed to construct '${interfaceName}': The provided double value of '${member}' is non-finite.`);
  }
  return number;
}
// Web IDL §3.2.6 (float): the single precision value closest to a finite
// double, ties to even; a double whose closest single is infinite throws.
function toFloat(interfaceName, member, value, fallback = 0) {
  const single = Math.fround(toDouble(interfaceName, member, value, fallback));
  if (!Number.isFinite(single)) {
    throw new TypeError(`Failed to construct '${interfaceName}': The provided float value of '${member}' is outside the range of a float.`);
  }
  return single;
}
const toNullable = (value) => value ?? null;
// A Window? member: null, or a window (the global object of a document,
// whose document's defaultView it is).
function toWindow(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && value.nodeType === undefined && value.document?.defaultView === value) return value;
  throw new TypeError("Failed to construct 'UIEvent': member view is not of type Window.");
}

// Web IDL's interface members are enumerable, and its prototype's class
// string is the interface's name. A constant is on the interface object
// and on its prototype.
function defineEventInterface(Interface, name, constants = {}) {
  for (const key of Reflect.ownKeys(Interface.prototype)) {
    if (key !== "constructor") Object.defineProperty(Interface.prototype, key, { enumerable: true });
  }
  Object.defineProperty(Interface.prototype, Symbol.toStringTag, { value: name, configurable: true });
  for (const [constant, value] of Object.entries(constants)) {
    for (const holder of [Interface, Interface.prototype]) {
      Object.defineProperty(holder, constant, { value, enumerable: true });
    }
  }
}

// DOM "initialize" of initEvent() and initCustomEvent(): the core leaves an
// event that is dispatched as it is (false) and resets the flags of another
// (event_state_initialize), whose type and target the host then sets.
function reinitializeEvent(state, type, bubbles, cancelable) {
  if (stateCore.status("event_state_initialize", state.stateHandle, bubbles ? 1 : 0, cancelable ? 1 : 0) === 0) {
    return false;
  }
  state.target = null;
  state.originalTarget = null;
  state.type = type;
  return true;
}

export const SDEvent = class Event {
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("Event");
    const eventType = `${type}`;
    const init = dictionaryArgument("Event", eventInitDict);
    createEventState(this, eventType, {
      bubbles: Boolean(init.bubbles),
      cancelable: Boolean(init.cancelable),
      composed: Boolean(init.composed),
    });
  }
  get type() {
    return eventState(this).type;
  }
  get target() {
    return eventState(this).target;
  }
  get srcElement() {
    return eventState(this).target;
  }
  get currentTarget() {
    return eventState(this).currentTarget;
  }
  composedPath() {
    return [...eventState(this).visiblePath];
  }
  get eventPhase() {
    return stateCore.status("event_state_phase", eventState(this).stateHandle);
  }
  stopPropagation() {
    setStopPropagationFlag(eventState(this));
  }
  get cancelBubble() {
    return hasFlag(eventState(this), EVENT_STATE.STOP_PROPAGATION);
  }
  set cancelBubble(value) {
    const state = eventState(this);
    if (value) setStopPropagationFlag(state);
  }
  stopImmediatePropagation() {
    setStopPropagationFlag(eventState(this), true);
  }
  get bubbles() {
    return hasFlag(eventState(this), EVENT_STATE.BUBBLES);
  }
  get cancelable() {
    return hasFlag(eventState(this), EVENT_STATE.CANCELABLE);
  }
  get returnValue() {
    return !hasFlag(eventState(this), EVENT_STATE.CANCELED);
  }
  set returnValue(value) {
    const state = eventState(this);
    if (!value) setCanceledFlag(state);
  }
  preventDefault() {
    setCanceledFlag(eventState(this));
  }
  get defaultPrevented() {
    return hasFlag(eventState(this), EVENT_STATE.CANCELED);
  }
  get composed() {
    return hasFlag(eventState(this), EVENT_STATE.COMPOSED);
  }
  get timeStamp() {
    return eventState(this).timeStamp;
  }
  initEvent(type, bubbles = false, cancelable = false) {
    const state = eventState(this);
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'initEvent' on 'Event': 1 argument required, but only 0 present.");
    }
    const eventType = `${type}`;
    reinitializeEvent(state, eventType, Boolean(bubbles), Boolean(cancelable));
  }
};
defineEventInterface(SDEvent, "Event", { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });

export const SDCustomEvent = class CustomEvent extends SDEvent {
  #detail;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("CustomEvent");
    const init = dictionaryArgument("CustomEvent", eventInitDict);
    super(type, init);
    this.#detail = init.detail === undefined ? null : init.detail;
  }
  get detail() {
    return this.#detail;
  }
  initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
    if (!(#detail in this)) throw new TypeError("Illegal invocation: the receiver is not a CustomEvent");
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'initCustomEvent' on 'CustomEvent': 1 argument required, but only 0 present.");
    }
    const eventType = `${type}`;
    const state = eventState(this);
    if (reinitializeEvent(state, eventType, Boolean(bubbles), Boolean(cancelable))) this.#detail = detail;
  }
};
defineEventInterface(SDCustomEvent, "CustomEvent");

export const SDUIEvent = class UIEvent extends SDEvent {
  #detail;
  #view;
  #which;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("UIEvent");
    const init = dictionaryArgument("UIEvent", eventInitDict);
    super(type, init);
    this.#detail = toLong(init.detail);
    this.#view = toWindow(init.view);
    this.#which = toUnsignedLong(init.which);
  }
  get view() {
    return this.#view;
  }
  get detail() {
    return this.#detail;
  }
  get which() {
    return this.#which;
  }
};
defineEventInterface(SDUIEvent, "UIEvent");

// UI Events' EventModifierInit, by key of getModifierState().
const MODIFIER_MEMBERS = Object.freeze([
  ["Alt", "altKey"], ["Control", "ctrlKey"], ["Meta", "metaKey"], ["AltGraph", "modifierAltGraph"],
  ["CapsLock", "modifierCapsLock"], ["Fn", "modifierFn"], ["FnLock", "modifierFnLock"], ["Hyper", "modifierHyper"],
  ["NumLock", "modifierNumLock"], ["ScrollLock", "modifierScrollLock"], ["Super", "modifierSuper"],
  ["Symbol", "modifierSymbol"], ["SymbolLock", "modifierSymbolLock"], ["Shift", "shiftKey"],
]);

// The modifier keys of an EventModifierInit, read in its members' order.
function modifierKeys(init) {
  const keys = new Set();
  for (const [key, member] of MODIFIER_MEMBERS) if (init[member]) keys.add(key);
  return keys;
}

// The relatedTarget of a FocusEvent or a MouseEvent: during its dispatch,
// the one retargeted against the current target (DOM "dispatch").
function eventRelatedTarget(event) {
  const state = eventState(event);
  return state.currentTarget ? state.currentRelatedTarget : state.relatedTarget;
}

export const SDFocusEvent = class FocusEvent extends SDUIEvent {
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("FocusEvent");
    const init = dictionaryArgument("FocusEvent", eventInitDict);
    super(type, init);
    eventState(this).relatedTarget = toNullable(init.relatedTarget);
  }
  get relatedTarget() {
    return eventRelatedTarget(this);
  }
};
defineEventInterface(SDFocusEvent, "FocusEvent");

export const SDMouseEvent = class MouseEvent extends SDUIEvent {
  #modifiers;
  #button;
  #buttons;
  #clientX;
  #clientY;
  #screenX;
  #screenY;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("MouseEvent");
    const init = dictionaryArgument("MouseEvent", eventInitDict);
    super(type, init);
    this.#modifiers = modifierKeys(init);
    this.#button = toShort(init.button);
    this.#buttons = toUnsignedShort(init.buttons);
    this.#clientX = toDouble("MouseEvent", "clientX", init.clientX);
    this.#clientY = toDouble("MouseEvent", "clientY", init.clientY);
    eventState(this).relatedTarget = toNullable(init.relatedTarget);
    this.#screenX = toDouble("MouseEvent", "screenX", init.screenX);
    this.#screenY = toDouble("MouseEvent", "screenY", init.screenY);
  }
  get screenX() {
    return this.#screenX;
  }
  get screenY() {
    return this.#screenY;
  }
  get clientX() {
    return this.#clientX;
  }
  get clientY() {
    return this.#clientY;
  }
  get ctrlKey() {
    return this.#modifiers.has("Control");
  }
  get shiftKey() {
    return this.#modifiers.has("Shift");
  }
  get altKey() {
    return this.#modifiers.has("Alt");
  }
  get metaKey() {
    return this.#modifiers.has("Meta");
  }
  get button() {
    return this.#button;
  }
  get buttons() {
    return this.#buttons;
  }
  get relatedTarget() {
    return eventRelatedTarget(this);
  }
  getModifierState(keyArg) {
    const modifiers = this.#modifiers;
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'getModifierState' on 'MouseEvent': 1 argument required, but only 0 present.");
    }
    return modifiers.has(`${keyArg}`);
  }
};
defineEventInterface(SDMouseEvent, "MouseEvent");

// input_pointer_orientation's output and given bits (input-pointer.watpart),
// by WAT name without the INPUT_POINTER_ORIENTATION_ prefix.
const POINTER_ORIENTATION = Object.freeze(Object.fromEntries([
  "SIZE", "TILT_X", "TILT_Y", "ALTITUDE", "AZIMUTH", "GIVEN_TILT_X", "GIVEN_TILT_Y", "GIVEN_ALTITUDE", "GIVEN_AZIMUTH",
].map((name) => [name, layoutConstant(`INPUT_POINTER_ORIENTATION_${name}`)])));

export const SDPointerEvent = class PointerEvent extends SDMouseEvent {
  #altitudeAngle;
  #azimuthAngle;
  #height;
  #isPrimary;
  #pointerId;
  #pointerType;
  #pressure;
  #tangentialPressure;
  #tiltX;
  #tiltY;
  #twist;
  #width;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("PointerEvent");
    const init = dictionaryArgument("PointerEvent", eventInitDict);
    super(type, init);
    this.#height = toDouble("PointerEvent", "height", init.height, 1);
    this.#isPrimary = Boolean(init.isPrimary);
    this.#pointerId = toLong(init.pointerId);
    this.#pointerType = toDOMString(init.pointerType);
    this.#pressure = toFloat("PointerEvent", "pressure", init.pressure);
    this.#tangentialPressure = toFloat("PointerEvent", "tangentialPressure", init.tangentialPressure);
    // The orientation members that the init gives, converted to their IDL
    // types; the core gives the four members (Pointer Events 3 §4.1.5).
    const given = (init.tiltX === undefined ? 0 : POINTER_ORIENTATION.GIVEN_TILT_X) |
      (init.tiltY === undefined ? 0 : POINTER_ORIENTATION.GIVEN_TILT_Y) |
      (init.altitudeAngle === undefined ? 0 : POINTER_ORIENTATION.GIVEN_ALTITUDE) |
      (init.azimuthAngle === undefined ? 0 : POINTER_ORIENTATION.GIVEN_AZIMUTH);
    stateCore.status("input_pointer_orientation", toLong(init.tiltX), toLong(init.tiltY),
      toDouble("PointerEvent", "altitudeAngle", init.altitudeAngle), toDouble("PointerEvent", "azimuthAngle", init.azimuthAngle), given);
    const orientation = stateCore.output("input_pointer_orientation");
    this.#tiltX = orientation.getInt32(POINTER_ORIENTATION.TILT_X, true);
    this.#tiltY = orientation.getInt32(POINTER_ORIENTATION.TILT_Y, true);
    this.#altitudeAngle = orientation.getFloat64(POINTER_ORIENTATION.ALTITUDE, true);
    this.#azimuthAngle = orientation.getFloat64(POINTER_ORIENTATION.AZIMUTH, true);
    this.#twist = toLong(init.twist);
    this.#width = toDouble("PointerEvent", "width", init.width, 1);
  }
  get pointerId() {
    return this.#pointerId;
  }
  get width() {
    return this.#width;
  }
  get height() {
    return this.#height;
  }
  get pressure() {
    return this.#pressure;
  }
  get tangentialPressure() {
    return this.#tangentialPressure;
  }
  get tiltX() {
    return this.#tiltX;
  }
  get tiltY() {
    return this.#tiltY;
  }
  get twist() {
    return this.#twist;
  }
  get altitudeAngle() {
    return this.#altitudeAngle;
  }
  get azimuthAngle() {
    return this.#azimuthAngle;
  }
  get pointerType() {
    return this.#pointerType;
  }
  get isPrimary() {
    return this.#isPrimary;
  }
};
defineEventInterface(SDPointerEvent, "PointerEvent");

export const SDKeyboardEvent = class KeyboardEvent extends SDUIEvent {
  #modifiers;
  #charCode;
  #code;
  #isComposing;
  #key;
  #keyCode;
  #location;
  #repeat;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("KeyboardEvent");
    const init = dictionaryArgument("KeyboardEvent", eventInitDict);
    super(type, init);
    this.#modifiers = modifierKeys(init);
    this.#charCode = toUnsignedLong(init.charCode);
    this.#code = toDOMString(init.code);
    this.#isComposing = Boolean(init.isComposing);
    this.#key = toDOMString(init.key);
    this.#keyCode = toUnsignedLong(init.keyCode);
    this.#location = toUnsignedLong(init.location);
    this.#repeat = Boolean(init.repeat);
  }
  get key() {
    return this.#key;
  }
  get code() {
    return this.#code;
  }
  get location() {
    return this.#location;
  }
  get ctrlKey() {
    return this.#modifiers.has("Control");
  }
  get shiftKey() {
    return this.#modifiers.has("Shift");
  }
  get altKey() {
    return this.#modifiers.has("Alt");
  }
  get metaKey() {
    return this.#modifiers.has("Meta");
  }
  get repeat() {
    return this.#repeat;
  }
  get isComposing() {
    return this.#isComposing;
  }
  get charCode() {
    return this.#charCode;
  }
  get keyCode() {
    return this.#keyCode;
  }
  getModifierState(keyArg) {
    const modifiers = this.#modifiers;
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'getModifierState' on 'KeyboardEvent': 1 argument required, but only 0 present.");
    }
    return modifiers.has(`${keyArg}`);
  }
};
defineEventInterface(SDKeyboardEvent, "KeyboardEvent", {
  DOM_KEY_LOCATION_STANDARD: 0, DOM_KEY_LOCATION_LEFT: 1, DOM_KEY_LOCATION_RIGHT: 2, DOM_KEY_LOCATION_NUMPAD: 3,
});

export const SDClipboardEvent = class ClipboardEvent extends SDEvent {
  #clipboardData;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("ClipboardEvent");
    const init = dictionaryArgument("ClipboardEvent", eventInitDict);
    super(type, init);
    this.#clipboardData = toNullable(init.clipboardData);
  }
  get clipboardData() {
    return this.#clipboardData;
  }
};
defineEventInterface(SDClipboardEvent, "ClipboardEvent");

// A form's submit event; submitter is the button that submitted it, null
// when the form submitted itself.
export const SDSubmitEvent = class SubmitEvent extends SDEvent {
  #submitter;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("SubmitEvent");
    const init = dictionaryArgument("SubmitEvent", eventInitDict);
    super(type, init);
    this.#submitter = toNullable(init.submitter);
  }
  get submitter() {
    return this.#submitter;
  }
};
defineEventInterface(SDSubmitEvent, "SubmitEvent");

// HTML's ToggleEvent: the state a details element, a dialog or a popover
// had before a toggle and the state it has after it, "open" or "closed",
// and the element that caused it.
export const SDToggleEvent = class ToggleEvent extends SDEvent {
  #newState;
  #oldState;
  #source;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("ToggleEvent");
    const init = dictionaryArgument("ToggleEvent", eventInitDict);
    super(type, init);
    this.#newState = toDOMString(init.newState);
    this.#oldState = toDOMString(init.oldState);
    this.#source = toNullable(init.source);
  }
  get oldState() {
    return this.#oldState;
  }
  get newState() {
    return this.#newState;
  }
  get source() {
    return this.#source;
  }
};
defineEventInterface(SDToggleEvent, "ToggleEvent");

// CSS Animations' AnimationEvent: animationName, elapsedTime and
// pseudoElement.
export const SDAnimationEvent = class AnimationEvent extends SDEvent {
  #animationName;
  #elapsedTime;
  #pseudoElement;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("AnimationEvent");
    const init = dictionaryArgument("AnimationEvent", eventInitDict);
    super(type, init);
    this.#animationName = toDOMString(init.animationName);
    this.#elapsedTime = toDouble("AnimationEvent", "elapsedTime", init.elapsedTime);
    this.#pseudoElement = toDOMString(init.pseudoElement);
  }
  get animationName() {
    return this.#animationName;
  }
  get elapsedTime() {
    return this.#elapsedTime;
  }
  get pseudoElement() {
    return this.#pseudoElement;
  }
};
defineEventInterface(SDAnimationEvent, "AnimationEvent");

// CSS Transitions' TransitionEvent: propertyName, elapsedTime and
// pseudoElement.
export const SDTransitionEvent = class TransitionEvent extends SDEvent {
  #elapsedTime;
  #propertyName;
  #pseudoElement;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("TransitionEvent");
    const init = dictionaryArgument("TransitionEvent", eventInitDict);
    super(type, init);
    this.#elapsedTime = toDouble("TransitionEvent", "elapsedTime", init.elapsedTime);
    this.#propertyName = toDOMString(init.propertyName);
    this.#pseudoElement = toDOMString(init.pseudoElement);
  }
  get propertyName() {
    return this.#propertyName;
  }
  get elapsedTime() {
    return this.#elapsedTime;
  }
  get pseudoElement() {
    return this.#pseudoElement;
  }
};
defineEventInterface(SDTransitionEvent, "TransitionEvent");

// Web Animations' AnimationPlaybackEvent: currentTime and timelineTime,
// null when unresolved. Animations dispatch it (remove).
export const SDAnimationPlaybackEvent = class AnimationPlaybackEvent extends SDEvent {
  #currentTime;
  #timelineTime;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("AnimationPlaybackEvent");
    const init = dictionaryArgument("AnimationPlaybackEvent", eventInitDict);
    super(type, init);
    this.#currentTime = init.currentTime == null ? null : toDouble("AnimationPlaybackEvent", "currentTime", init.currentTime);
    this.#timelineTime = init.timelineTime == null ? null : toDouble("AnimationPlaybackEvent", "timelineTime", init.timelineTime);
  }
  get currentTime() {
    return this.#currentTime;
  }
  get timelineTime() {
    return this.#timelineTime;
  }
};
defineEventInterface(SDAnimationPlaybackEvent, "AnimationPlaybackEvent");

// HTML's ErrorEvent: the error event of "report an exception".
export const SDErrorEvent = class ErrorEvent extends SDEvent {
  #colno;
  #error;
  #filename;
  #lineno;
  #message;
  constructor(type, eventInitDict = undefined) {
    if (arguments.length < 1) throw missingArgument("ErrorEvent");
    const init = dictionaryArgument("ErrorEvent", eventInitDict);
    super(type, init);
    this.#colno = toUnsignedLong(init.colno);
    this.#error = init.error === undefined ? null : init.error;
    this.#filename = toDOMString(init.filename);
    this.#lineno = toUnsignedLong(init.lineno);
    this.#message = toDOMString(init.message);
  }
  get message() {
    return this.#message;
  }
  get filename() {
    return this.#filename;
  }
  get lineno() {
    return this.#lineno;
  }
  get colno() {
    return this.#colno;
  }
  get error() {
    return this.#error;
  }
};
defineEventInterface(SDErrorEvent, "ErrorEvent");

// HTML's PromiseRejectionEvent: the unhandledrejection event of a rejected
// promise that no handler handled.
export const SDPromiseRejectionEvent = class PromiseRejectionEvent extends SDEvent {
  #promise;
  #reason;
  constructor(type, eventInitDict) {
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'PromiseRejectionEvent': 2 arguments required, but only ${arguments.length} present.`);
    }
    const init = dictionaryArgument("PromiseRejectionEvent", eventInitDict);
    super(type, init);
    if (init.promise === null || (typeof init.promise !== "object" && typeof init.promise !== "function")) {
      throw new TypeError("Failed to construct 'PromiseRejectionEvent': member promise is not an object.");
    }
    this.#promise = init.promise;
    this.#reason = init.reason;
  }
  get promise() {
    return this.#promise;
  }
  get reason() {
    return this.#reason;
  }
};
defineEventInterface(SDPromiseRejectionEvent, "PromiseRejectionEvent");

// The interface objects of Sandom's events that a window exposes, by name.
export const eventInterfaces = Object.freeze({
  Event: SDEvent,
  CustomEvent: SDCustomEvent,
  UIEvent: SDUIEvent,
  FocusEvent: SDFocusEvent,
  MouseEvent: SDMouseEvent,
  PointerEvent: SDPointerEvent,
  KeyboardEvent: SDKeyboardEvent,
  ClipboardEvent: SDClipboardEvent,
  SubmitEvent: SDSubmitEvent,
  ToggleEvent: SDToggleEvent,
  AnimationEvent: SDAnimationEvent,
  TransitionEvent: SDTransitionEvent,
  AnimationPlaybackEvent: SDAnimationPlaybackEvent,
  ErrorEvent: SDErrorEvent,
  PromiseRejectionEvent: SDPromiseRejectionEvent,
});

// The dispatchEvent() method: it initializes the event's isTrusted to false
// before it dispatches it (DOM "dispatchEvent(event)"). An event that is
// being dispatched keeps it: its dispatch throws InvalidStateError first.
export function dispatchEventFromScript(target, event) {
  if (eventStates.has(event)) stateCore.status("event_state_script_dispatch", eventState(event).stateHandle);
  return dispatchEvent(target, event);
}

// An event that the user agent creates and dispatches (DOM "fire an
// event"): its isTrusted is true. The type names the interface: the
// interface's members come from `init` and `fields` (constructEvent).
export function createEvent(type, init = {}, fields = {}) {
  const event = constructEvent(type, init, fields);
  trustEvent(event);
  return event;
}

// An event that the user agent creates on behalf of a script, such as the
// click of click() (HTML "fire a synthetic pointer event" with the not
// trusted flag): its isTrusted is false.
export function createSyntheticEvent(type, init = {}, fields = {}) {
  return constructEvent(type, init, fields);
}

// An event of `Interface`, one of Sandom's event interfaces, that the user
// agent creates and dispatches (DOM "fire an event" using
// eventConstructor): its isTrusted is true.
export function createEventUsing(Interface, type, init = {}) {
  const event = new Interface(type, init);
  trustEvent(event);
  return event;
}

// Sandom's event interfaces by the core's EVENT_INTERFACE_* codes.
const EVENT_INTERFACE_CLASSES = new Map([
  ["EVENT", SDEvent], ["CUSTOM", SDCustomEvent], ["FOCUS", SDFocusEvent], ["KEYBOARD", SDKeyboardEvent],
  ["POINTER", SDPointerEvent], ["CLIPBOARD", SDClipboardEvent], ["SUBMIT", SDSubmitEvent], ["TOGGLE", SDToggleEvent],
  ["ANIMATION", SDAnimationEvent], ["TRANSITION", SDTransitionEvent], ["MOUSE", SDMouseEvent],
].map(([name, Interface]) => [layoutConstant(`EVENT_INTERFACE_${name}`), Interface]));

// An event of `type` that the user agent creates: the core chooses its
// interface (event_interface_for_type) and whether the members of `init`
// and `fields` that the interface does not have become properties of the
// event (event_interface_exact).
function constructEvent(type, init, fields) {
  const eventType = String(type);
  const members = { ...init, ...fields };
  const code = stateCore.status("event_interface_for_type", ...stateCore.input(eventType),
    Object.hasOwn(init, "detail") ? 1 : 0);
  const Interface = EVENT_INTERFACE_CLASSES.get(code);
  if (Interface === undefined) throw new Error(`The core named event interface ${code} for "${eventType}", which Sandom does not have`);
  const event = new Interface(eventType, members);
  if (stateCore.status("event_interface_exact", code) !== 0) return event;
  for (const [name, value] of Object.entries(members)) {
    if (!(name in event)) Object.defineProperty(event, name, { configurable: true, enumerable: true, value });
  }
  return event;
}

// The host's Event and its subclasses of runtime reports, taken before a
// window can replace the globals.
const HostEvent = globalThis.Event;
const HostErrorEvent = globalThis.ErrorEvent;
const HostPromiseRejectionEvent = globalThis.PromiseRejectionEvent;

// Whether `value` is an event of the host, not of Sandom.
export function isHostEvent(value) {
  return typeof HostEvent === "function" && value instanceof HostEvent && !eventStates.has(value);
}

// The Sandom event for `hostEvent`, an event of the host that the host
// dispatches at a window: in Deno, the runtime reports an exception, an
// unhandled rejection and its load and unload events through the global
// object's dispatchEvent, and that global object can be a window. It has
// the host event's type, flags and fields, and the host's isTrusted.
export function sandomEventForHostEvent(hostEvent) {
  const init = { bubbles: hostEvent.bubbles, cancelable: hostEvent.cancelable, composed: hostEvent.composed };
  let event;
  if (typeof HostErrorEvent === "function" && hostEvent instanceof HostErrorEvent) {
    event = new SDErrorEvent(hostEvent.type, {
      ...init,
      message: hostEvent.message,
      filename: hostEvent.filename,
      lineno: hostEvent.lineno,
      colno: hostEvent.colno,
      error: hostEvent.error,
    });
  } else if (typeof HostPromiseRejectionEvent === "function" && hostEvent instanceof HostPromiseRejectionEvent) {
    event = new SDPromiseRejectionEvent(hostEvent.type, { ...init, promise: hostEvent.promise, reason: hostEvent.reason });
  } else {
    event = new SDEvent(hostEvent.type, init);
  }
  trustEvent(event, hostEvent.isTrusted === true, hostEvent.defaultPrevented === true);
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
