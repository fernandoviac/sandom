// The default classic-script session of the local, supplied-resource and
// browser hosts. It is a scope, not an isolation layer: scripts run on the
// caller's thread, and the DOM objects they reach belong to the caller's
// realm. A host that renders untrusted documents supplies a session of its
// own whose `globalObject` belongs to a realm it created
// (design/classic-scripts.md, "Document realm").
//
// Where `node:vm` is available (Deno), each document gets a context of its
// own, created when the document's first script runs. Its global object
// starts with the caller's global bindings that a new context lacks (`URL`,
// `TextEncoder`, `structuredClone` and the rest of the platform's), Sandom
// installs the document's window bindings on it, and the document's scripts
// share its global scope: a top-level `let` of one script is visible to the
// next, and a later document starts with none of them. The module scripts
// of the document evaluate in the same context, through the host module
// session (`scriptRealm` in src/host/module-graph-session.js).
//
// The caller's own global object is never written. In Deno it would answer
// `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `process`
// and `window` from one of two stores, chosen by the code that asks: code
// that `node:vm` compiles in the main context reads Node's, all other code
// reads Deno's (`ext/node/global.rs`, v2.7.7). A context's global object is
// an ordinary V8 global with one store, so a page script reads the timers
// that Sandom installs on it.
//
// Elsewhere (a browser window or worker) scripts evaluate in the caller's
// realm through indirect eval, and a top-level `let`, `const` or `class` is
// local to its script.
import { normalCompletion, throwCompletion } from "./contract.js";

// The function a handler body compiles to: its scope chain is the element,
// its form owner and its document, in that order from the innermost, then
// the global environment (HTML Standard, "getting the current value of the
// event handler"). Each `with` takes its object when the enclosing function
// is called, so the source holds no object. The body starts on the head's
// line, so a location in it counts from the handler's source position.
function handlerHead(name, parameters) {
  return "(function () { with (arguments[0]) { return function () { with (arguments[0]) {" +
    " return function () { with (arguments[0]) { return function " + name + "(" +
    parameters.join(", ") + ") {";
}

const HANDLER_TAIL = "\n}; } }; } }; } })";

const emptyScope = Object.freeze(Object.create(null));

function createSession(globalObject, evaluate, trackUnhandledRejections, releaseRealm) {
  let released = false;
  const requireOpen = (operation) => {
    if (released) {
      throw new TypeError(`The classic-script session has been released; ${operation} cannot run`);
    }
  };
  return Object.freeze({
    globalObject,
    evaluateScript({ source, url, line = 1, column = 0 }) {
      requireOpen("evaluateScript");
      try {
        return normalCompletion(evaluate(String(source), url, line, column));
      } catch (error) {
        return throwCompletion(error);
      }
    },
    compileEventHandler({ name, parameters, body, scopes, url, line = 1, column = 0 }) {
      requireOpen("compileEventHandler");
      const [element, form, document] = scopes;
      try {
        const head = handlerHead(name, parameters);
        const factory = evaluate(head + String(body) + HANDLER_TAIL, url, line, column - head.length);
        return normalCompletion(factory(document ?? emptyScope)(form ?? emptyScope)(element ?? emptyScope));
      } catch (error) {
        return throwCompletion(error);
      }
    },
    ...(trackUnhandledRejections === null ? {} : { trackUnhandledRejections }),
    release() {
      if (released) return;
      released = true;
      releaseRealm();
    },
  });
}

// The documents whose contexts are open, in the order their realms began
// tracking rejections. The isolate has one rejection tracker, and Deno
// dispatches every unhandled rejection at the caller's global object, in
// the async context of the code that rejected the promise. A promise of a
// document's context goes to that document. A promise of the caller's realm
// (a DOM operation such as `fetch`) goes to the document whose code
// rejected it (`owns`); any other is the caller's own, and keeps Deno's
// default.
const rejectionTrackers = [];

function onCallerUnhandledRejection(event) {
  const promise = event.promise;
  let tracker = null;
  for (let index = rejectionTrackers.length - 1; index >= 0; index -= 1) {
    if (promise instanceof rejectionTrackers[index].Promise) {
      tracker = rejectionTrackers[index];
      break;
    }
  }
  tracker ??= rejectionTrackers.findLast((candidate) => candidate.owns?.() === true);
  if (tracker === undefined) return;
  event.preventDefault();
  tracker.report(event.reason, promise);
}

function addRejectionTracker(tracker) {
  if (typeof globalThis.addEventListener !== "function") return () => {};
  if (rejectionTrackers.length === 0) {
    globalThis.addEventListener("unhandledrejection", onCallerUnhandledRejection);
  }
  rejectionTrackers.push(tracker);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    rejectionTrackers.splice(rejectionTrackers.indexOf(tracker), 1);
    if (rejectionTrackers.length === 0) {
      globalThis.removeEventListener("unhandledrejection", onCallerUnhandledRejection);
    }
  };
}

// The caller's binding `name` as a binding of a context's global object.
// An accessor reads and writes the caller's own value; a binding that names
// the caller's global object itself (Deno's `global`) is not copied, so a
// page script cannot write the caller's globals through it.
function copiedDescriptor(name) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if ("value" in descriptor) {
    if (descriptor.value === globalThis) return null;
    return { value: descriptor.value, writable: true, enumerable: descriptor.enumerable, configurable: true };
  }
  const { get, set } = descriptor;
  return {
    get: get === undefined ? undefined : () => Reflect.apply(get, globalThis, []),
    set: set === undefined ? undefined : (value) => Reflect.apply(set, globalThis, [value]),
    enumerable: descriptor.enumerable,
    configurable: true,
  };
}

function createDocumentContextSession(vm) {
  let context = vm.createContext({});
  // The context's global proxy, not the object it was created from: a
  // value a host function returns (`document.defaultView`, an event's
  // `currentTarget`) is then the object that `globalThis` names inside.
  const globalObject = vm.runInContext("globalThis", context);
  for (const name of Reflect.ownKeys(globalThis)) {
    if (typeof name !== "string" || Object.hasOwn(globalObject, name)) continue;
    const descriptor = copiedDescriptor(name);
    if (descriptor !== null) Object.defineProperty(globalObject, name, descriptor);
  }
  const RealmPromise = vm.runInContext("Promise", context);
  const stops = new Set();
  return createSession(
    globalObject,
    (source, url, line, column) =>
      vm.runInContext(source, context, { filename: url, lineOffset: line - 1, columnOffset: column }),
    (report, owns) => {
      const stop = addRejectionTracker({ Promise: RealmPromise, report, owns });
      stops.add(stop);
      return () => {
        stops.delete(stop);
        stop();
      };
    },
    () => {
      for (const stop of stops) stop();
      stops.clear();
      context = null;
    },
  );
}

function createCallerRealmSession() {
  const indirectEval = globalThis.eval;
  return createSession(
    globalThis,
    (source, url) => indirectEval(`${source}\n//# sourceURL=${url}`),
    null,
    () => {},
  );
}

export function createDefaultClassicScriptSession() {
  const vm = globalThis.process?.getBuiltinModule?.("node:vm");
  if (typeof vm?.createContext === "function") return createDocumentContextSession(vm);
  return createCallerRealmSession();
}
