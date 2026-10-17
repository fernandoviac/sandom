// The realm of a document's scripts.
//
// The host classic-script session names the realm by its global object: a
// realm the session created for the document (the default in Deno, a
// `node:vm` context), or the caller's own global object. Sandom installs
// the document's window bindings on that global object when the first
// script of the document runs, so a document without scripts never touches
// it, and removes them when the document is released. The DOM layer keeps
// no module-level state for one realm: everything below is a property of
// the document or keyed by the realm's global object.
import { claimRealmForDocument, installComponentGlobals } from "./component-globals.js";
import { eraseEventListenersAndHandlers, installWindowEventHandlers } from "./event-handlers.js";
import { componentCodeDocument } from "./component-code.js";

// Script fetch belongs to the host; the realm's own fetch would bypass the
// host's authority. A relative URL resolves against the document base URL,
// as the realm's API base URL does in a browser.
export function installDocumentFetch(window, document) {
  Object.defineProperty(window, "fetch", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: (input, init) =>
      document._resources.fetch(
        typeof input === "string" || input instanceof URL
          ? new URL(input, document.baseURI).href
          : input,
        init,
      ),
  });
}

// The realm record of `document`, installed on first use, or null when the
// document's host evaluates no classic script. `installTasks(globalObject)`
// installs the document's task sources (timers) on the global object;
// `reportRejection(reason, promise)` hears every promise rejection that the
// realm leaves unhandled while the document holds it.
export function enterDocumentRealm(document, installTasks, reportRejection) {
  if (document._realm !== undefined) return document._realm;
  const session = document._resources.classicScriptSession;
  if (session === null) {
    document._realm = null;
    return null;
  }
  const globalObject = session.globalObject;
  const releaseClaim = claimRealmForDocument(globalObject, document);
  const previous = new Map(
    Reflect.ownKeys(globalObject).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalObject, name),
    ]),
  );
  // An unhandled rejection reaches the realm's global object (in Deno, by
  // default, ending the process). While the document holds the realm the
  // document reports it instead, as a browser reports a page's unhandled
  // rejection, and cancels the realm's default. A session that tracks the
  // realm's rejections itself reports them; otherwise the realm's global
  // object hears them. A browser realm dispatches the event to its own
  // event target, which the window bindings do not replace; Deno's caller
  // realm dispatches it through the global object's dispatchEvent, which
  // they do. Every path ends in `reportRejection`.
  const nativeAddEventListener = globalObject.addEventListener;
  const nativeRemoveEventListener = globalObject.removeEventListener;
  const RealmPromiseRejectionEvent = globalObject.PromiseRejectionEvent;
  const onUnhandledRejection = (event) => {
    event.preventDefault();
    reportRejection(event.reason, event.promise);
  };
  let stopRejectionTracking = null;
  const stopRejectionListening = () => {
    if (stopRejectionTracking === null) return;
    const stop = stopRejectionTracking;
    stopRejectionTracking = null;
    stop();
  };
  try {
    if (typeof session.trackUnhandledRejections === "function") {
      // A rejected promise of the caller's realm is the document's when the
      // document's code rejected it (component-code.js).
      stopRejectionTracking = session.trackUnhandledRejections(reportRejection,
        () => componentCodeDocument() === document);
    } else if (typeof nativeAddEventListener === "function" && typeof nativeRemoveEventListener === "function") {
      Reflect.apply(nativeAddEventListener, globalObject, ["unhandledrejection", onUnhandledRejection]);
      stopRejectionTracking = () =>
        Reflect.apply(nativeRemoveEventListener, globalObject, ["unhandledrejection", onUnhandledRejection]);
    }
    installComponentGlobals(globalObject, document);
    if (typeof session.trackUnhandledRejections !== "function" && typeof RealmPromiseRejectionEvent === "function") {
      const windowDispatchEvent = globalObject.dispatchEvent;
      globalObject.dispatchEvent = function dispatchEvent(event) {
        if (event instanceof RealmPromiseRejectionEvent && event.type === "unhandledrejection") {
          onUnhandledRejection(event);
          return false;
        }
        return Reflect.apply(windowDispatchEvent, this, [event]);
      };
    }
    installWindowEventHandlers(globalObject, { replace: true });
    installDocumentFetch(globalObject, document);
    installTasks(globalObject);
  } catch (error) {
    stopRejectionListening();
    restoreGlobals(globalObject, previous, installedNames(globalObject, previous));
    releaseClaim();
    throw error;
  }
  const installed = installedNames(globalObject, previous);
  document._realm = Object.freeze({
    globalObject,
    session,
    // The global object outlives the document: the listeners and handlers
    // that the document's scripts put on its window go with the document,
    // so the next document's window starts with none, as a new Window does.
    release() {
      try {
        eraseEventListenersAndHandlers(globalObject, document._domCore);
        restoreGlobals(globalObject, previous, installed);
      } finally {
        stopRejectionListening();
        releaseClaim();
      }
    },
  });
  return document._realm;
}

function installedNames(globalObject, previous) {
  const names = [];
  for (const name of Reflect.ownKeys(globalObject)) {
    const before = previous.get(name);
    const after = Object.getOwnPropertyDescriptor(globalObject, name);
    if (
      before === undefined || before.value !== after.value ||
      before.get !== after.get || before.set !== after.set
    ) names.push(name);
  }
  for (const name of previous.keys()) {
    if (!Object.hasOwn(globalObject, name)) names.push(name);
  }
  return names;
}

// Puts back the bindings the installation replaced or added. A global that a
// script created stays: the realm is the script's realm.
function restoreGlobals(globalObject, previous, names) {
  const errors = [];
  for (const name of names) {
    try {
      const descriptor = previous.get(name);
      if (descriptor !== undefined) Object.defineProperty(globalObject, name, descriptor);
      else delete globalObject[name];
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore the realm's global bindings");
  }
}
