// The script processing model of one document: script preparation and
// execution (HTML Standard, 4.12.1.1), the parser's handling of a script
// end tag (13.2.6.4.8, "text" insertion mode), the end of parsing (13.2.7),
// and dynamic markup insertion (8.4).
//
// Sandom owns the order and the times; the host classic-script session
// evaluates each classic script in the document realm, and the host
// resource session delivers each external script. No timer or poll advances
// the parser: a delivered script, a settled style sheet or a finished script
// does.
import { validateCompletion } from "../host/contract.js";
import { enterComponentCode } from "./component-code.js";
import { beginHTMLDocumentParse } from "./html.js";
import { DocumentTimers } from "./document-timers.js";
import { fixDocumentClock } from "./document-clock.js";
import { microtaskCheckpoint } from "./microtask-checkpoint.js";
import {
  createEvent,
  createEventUsing,
  dispatchEvent,
  dispatchWindowEventWithDocumentTarget,
  SDErrorEvent,
  SDPromiseRejectionEvent,
} from "./events.js";
import {
  activateHandlerElements,
  activateParsedEventHandlers,
  eraseEventListenersAndHandlers,
  eventHandlerAttributeChanged,
  hasEventHandlerAttributes,
} from "./event-handlers.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The parameter names of an event handler by SCRIPT_HANDLER_* code.
const HANDLER_PARAMETERS = Object.freeze([
  ["event"],
  ["event", "source", "lineno", "colno", "error"],
  ["evt"],
]);

// The decisions of script-elements.watpart.
const SCRIPT_RESULT_MASK = layoutConstant("SCRIPT_RESULT_MASK");
const SCRIPT_RESULT_NONE = layoutConstant("SCRIPT_RESULT_NONE");
const SCRIPT_RESULT_ERROR_EVENT = layoutConstant("SCRIPT_RESULT_ERROR_EVENT");
const SCRIPT_RESULT_IMPORTMAP = layoutConstant("SCRIPT_RESULT_IMPORTMAP");
const SCRIPT_RESULT_FETCH_CLASSIC = layoutConstant("SCRIPT_RESULT_FETCH_CLASSIC");
const SCRIPT_RESULT_MODULE_EXTERNAL = layoutConstant("SCRIPT_RESULT_MODULE_EXTERNAL");
const SCRIPT_RESULT_CLASSIC_INLINE = layoutConstant("SCRIPT_RESULT_CLASSIC_INLINE");
const SCRIPT_EXECUTE_NOW = layoutConstant("SCRIPT_EXECUTE_NOW");
const SCRIPT_READY_NOTIFY = layoutConstant("SCRIPT_READY_NOTIFY");
const SCRIPT_READY_IN_ORDER = layoutConstant("SCRIPT_READY_IN_ORDER");
const SCRIPT_READY_ASAP = layoutConstant("SCRIPT_READY_ASAP");
const SCRIPT_EXECUTE_SKIP = layoutConstant("SCRIPT_EXECUTE_SKIP");
const SCRIPT_EXECUTE_ERROR_EVENT = layoutConstant("SCRIPT_EXECUTE_ERROR_EVENT");
const SCRIPT_EXECUTE_MODULE = layoutConstant("SCRIPT_EXECUTE_MODULE");
const SCRIPT_EXECUTE_EXTERNAL = layoutConstant("SCRIPT_EXECUTE_EXTERNAL");
const SCRIPT_EXECUTE_CURRENT = layoutConstant("SCRIPT_EXECUTE_CURRENT");
const SCRIPT_LIST_AFTER_PARSING = layoutConstant("SCRIPT_LIST_AFTER_PARSING");
const SCRIPT_LIST_BLOCKING = layoutConstant("SCRIPT_LIST_BLOCKING");
const SCRIPT_MUTATION_CHILDREN = layoutConstant("SCRIPT_MUTATION_CHILDREN");
const SCRIPT_MUTATION_INSERTED = layoutConstant("SCRIPT_MUTATION_INSERTED");
const CALLBACK_EFFECT_SCRIPT_CHILDREN = layoutConstant("CALLBACK_EFFECT_SCRIPT_CHILDREN");
const CALLBACK_EFFECT_SCRIPT_INSERTED = layoutConstant("CALLBACK_EFFECT_SCRIPT_INSERTED");
const CALLBACK_EFFECT_SCRIPT_SRC = layoutConstant("CALLBACK_EFFECT_SCRIPT_SRC");
const CALLBACK_EFFECT_EVENT_HANDLER = layoutConstant("CALLBACK_EFFECT_EVENT_HANDLER");
const SCRIPT_MUTATION_SRC = layoutConstant("SCRIPT_MUTATION_SRC");
const SCRIPT_MARKUP_OPEN = layoutConstant("SCRIPT_MARKUP_OPEN");
const SCRIPT_MARKUP_CLOSE = layoutConstant("SCRIPT_MARKUP_CLOSE");
const SCRIPT_MARKUP_WRITE = layoutConstant("SCRIPT_MARKUP_WRITE");

// Fetch, "should response to request be blocked due to its MIME type?"
// (script_blocked_media_type).
function blockedScriptMediaType(core, mediaType) {
  return mediaType !== null && core.status("script_blocked_media_type", ...core.input(mediaType)) !== 0;
}

// The child text content of the element (node_child_text).
function childTextContent(element) {
  return element._domCore.string("node_child_text", element._coreHandle);
}

// The host values of each script element: its result once it is ready
// (null on failure) and the input position of its text. The core keeps its
// flags and lists (script-elements.watpart). The records are keyed by the
// element's core handle, never by its wrapper: the core holds a wrapper
// weakly, so a collection between a script's fetch and its execution
// gives the element a new wrapper.
function scriptRecord(records, element) {
  let record = records.get(element._coreHandle);
  if (record === undefined) {
    record = { result: undefined, position: null };
    records.set(element._coreHandle, record);
  }
  return record;
}

// Fragment parsing (innerHTML, insertAdjacentHTML, DOMParser fragments)
// marks its scripts "already started", so inserting them runs nothing.
export function markScriptsAlreadyStarted(root) {
  root._domCore.status("script_mark_started", root._coreHandle);
}

// The "async" IDL attribute of a script element.
export function scriptElementAsync(element) {
  return element._domCore.status("script_async", element._coreHandle) === 1;
}

export function setScriptElementAsync(element, value) {
  element._domCore.status("script_async_set", element._coreHandle);
  if (value) element.setAttribute("async", "");
  else element.removeAttribute("async");
}

// The location an error event reports, from the V8 stack of an Error: the
// syntax error position V8 puts first, else the first frame outside the
// runtime's and Sandom's own code (a DOM method that throws is native code
// in a browser, so the script's call site is the location). A compile
// error that names no position (Deno's `node:vm` gives a SyntaxError none)
// reports `line`, the first line of its script.
const SANDOM_SOURCE = new URL("../", import.meta.url).href;

function exceptionLocation(error, url, line = 0, inline = null) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const lines = stack.split("\n");
  const syntax = /^(.*):(\d+)$/.exec(lines[0] ?? "");
  if (syntax !== null && (syntax[1] === url || syntax[1] === inline?.from)) {
    const caret = lines.slice(1, 4).find((text) => /^\s*\^/.test(text));
    const offset = syntax[1] === url ? 0 : inline.lineOffset;
    return { filename: url, lineno: Number(syntax[2]) + offset, colno: caret ? caret.indexOf("^") + 1 : 0 };
  }
  for (const text of lines) {
    const frame = /(?:\(|at )([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(text);
    if (frame === null || /^(?:node|ext):/.test(frame[1]) || frame[1].startsWith(SANDOM_SOURCE)) continue;
    if (inline !== null && frame[1] === inline.from) {
      const lineno = Number(frame[2]);
      const colno = Number(frame[3]) + (lineno === 1 ? inline.columnOffset : 0);
      return { filename: url, lineno: lineno + inline.lineOffset, colno };
    }
    return { filename: frame[1], lineno: Number(frame[2]), colno: Number(frame[3]) };
  }
  return { filename: url, lineno: line, colno: 0 };
}

function exceptionMessage(error) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      if (typeof error.name === "string" && typeof error.message === "string") {
        return `Uncaught ${error.name}: ${error.message}`;
      }
    } catch {
      // A throwing accessor leaves the generic message.
    }
    return "Uncaught [object]";
  }
  return `Uncaught ${String(error)}`;
}

// URL Standard, "percent-decode" of a string (url_percent_decode).
function percentDecode(core, text) {
  core.status("url_percent_decode", ...core.input(text));
  const pointer = core.exports.abi_output_pointer();
  return core.refreshBytes().slice(pointer, pointer + core.exports.abi_output_length());
}

// "Erase all event listeners and handlers" for each shadow-including
// inclusive descendant of `root`.
function eraseShadowIncludingListeners(root) {
  const core = root._domCore;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    eraseEventListenersAndHandlers(node, core);
    if (node._shadowRoot) pending.push(node._shadowRoot);
    for (let child = node.lastChild; child !== null; child = child.previousSibling) pending.push(child);
  }
}

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

class DocumentScripts {
  constructor(document) {
    this.document = document;
    this.scripting = document._resources.scriptingEnabled && document._enterRealm !== null;
    this.parser = null;
    this.parserLoopRunning = false;
    this.scriptNestingLevel = 0;
    this.parserPause = false;
    this.readyState = "complete";
    // HTML "completely loaded": the end of a load fired the window's load
    // event. A document that loads no input is completely loaded.
    this.completelyLoaded = true;
    this.currentScript = null;
    this.ignoreDestructiveWrites = 0;
    this.importMaps = [];
    // Core handle → script record (scriptRecord).
    this.scriptRecords = new Map();
    this.moduleScriptCount = 0;
    this.executeModule = null;
    this.inputURL = document.URL;
    this.diagnosticRecords = [];
    this.waiters = new Set();
    this.taskDepth = 0;
    this.tasks = [];
    this.runningTasks = false;
    this.idleWaiters = [];
    this.timers = null;
    this.pendingJavaScriptURLs = [];
    this.reporting = false;
    this.released = false;
    this.loading = null;
  }

  get diagnostics() {
    return this.diagnosticRecords;
  }

  diagnose(record) {
    this.diagnosticRecords.push(Object.freeze({ severity: "warning", recoverable: true, ...record }));
  }

  // Waiting is event driven: every change that can satisfy a waiter calls
  // notify.
  notify() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  async until(predicate) {
    while (!predicate()) {
      if (this.released) throw invalidState(`The document ${this.document.URL} was released`);
      await new Promise((resolve) => this.waiters.add(resolve));
    }
  }

  // The document's task queue. Tasks run one at a time in the order they
  // were queued, each after a microtask checkpoint. While the parser runs
  // its input, or the end of parsing runs, a queued task waits, as a task
  // of the event loop waits for the parser task. While either waits for a
  // resource, the queue runs ("spin the event loop"): as in a browser, a
  // zero-delay timer then runs before a script that the host has not
  // delivered yet.
  enterTask() {
    this.taskDepth += 1;
  }

  leaveTask() {
    this.taskDepth -= 1;
    if (this.taskDepth === 0) this.runTasks();
  }

  // Queues a task after the timers that are due by now, which entered the
  // queue when they became due. Returns a promise that settles when the
  // task has run, or when the document is released.
  queueTask(task) {
    this.timers?.releaseDue();
    return this.enqueue(task);
  }

  enqueue(task) {
    if (this.released) return Promise.resolve();
    return new Promise((resolve) => {
      this.tasks.push({ task, resolve });
      this.runTasks();
    });
  }

  async runTasks() {
    if (this.runningTasks) return;
    this.runningTasks = true;
    try {
      while (this.tasks.length > 0 && this.taskDepth === 0 && !this.released) {
        await microtaskCheckpoint();
        if (this.taskDepth > 0 || this.released || this.tasks.length === 0) break;
        const { task, resolve } = this.tasks.shift();
        try {
          this.runTask(task);
        } finally {
          resolve();
        }
      }
    } finally {
      this.runningTasks = false;
      this.settleIdleWaiters();
    }
  }

  // Settles once the task queue is empty and the microtasks of its last
  // task ran: a host that drives the document's frames (a test harness on a
  // virtual clock) runs the next frame only after the page's work of the
  // previous one, whatever order the host delivers its macrotasks in.
  whenTasksIdle() {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.settleIdleWaiters();
    });
  }

  // A drain that runs later tasks settles the waiters when it ends.
  settleIdleWaiters() {
    const busy = () => !this.released && (this.runningTasks || this.tasks.length > 0);
    if (this.idleWaiters.length === 0 || busy()) return;
    microtaskCheckpoint().then(() => {
      if (busy()) return;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    });
  }

  runTask(task) {
    this.enterTask();
    try {
      task();
    } catch (error) {
      this.reportException(error, this.document.URL);
    } finally {
      this.leaveTask();
    }
  }

  // Waits outside the current task for a resource or for the document's
  // own tasks, so that the document's tasks run meanwhile.
  async outsideTask(wait) {
    this.leaveTask();
    try {
      return await wait();
    } finally {
      this.enterTask();
    }
  }

  realm() {
    const realm = this.document._enterRealm?.(
      this.document,
      (globalObject) => this.installTimers(globalObject),
      (reason, promise) => this.reportUnhandledRejection(reason, promise),
    ) ?? null;
    if (realm === null) {
      throw invalidState(`The host ${this.document._resources.backend} evaluates no classic script`);
    }
    return realm;
  }

  // The task sources of the document realm: the window timers, and a
  // microtask that reports the exception it throws, as every callback does.
  installTimers(globalObject) {
    const hostQueueMicrotask = globalObject.queueMicrotask ?? globalThis.queueMicrotask;
    this.installWindowTimers(globalObject);
    Object.defineProperties(globalObject, {
      queueMicrotask: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (callback) => {
          if (typeof callback !== "function") {
            throw new TypeError(
              "Failed to execute 'queueMicrotask' on 'Window': parameter 1 is not of type 'Function'.",
            );
          }
          Reflect.apply(hostQueueMicrotask, globalThis, [() => {
            try {
              Reflect.apply(callback, undefined, []);
            } catch (error) {
              this.reportException(error, this.document.URL);
            }
          }]);
        },
      },
    });
  }

  // The document's timers: one set per document, whatever window shows
  // them, due on the document's clock (document-timers.js).
  documentTimers() {
    if (this.timers === null) {
      this.timers = new DocumentTimers(this.document, fixDocumentClock(this.document), (task) => this.enqueue(task));
      this.document._documentTimers = this.timers;
    }
    return this.timers;
  }

  // The window timers of `globalObject`: timer ids that the document owns,
  // whose tasks enter the document's task queue. `callbackError(error)`,
  // when given, hears the exception that a timer's function throws instead
  // of the document's script exception reporting.
  installWindowTimers(globalObject, callbackError = null) {
    const timers = this.documentTimers();
    // The handler argument is a Function or, converted when the timer is
    // set, a string of script source.
    const timerCallback = (handler, parameters) => {
      if (typeof handler === "function") {
        if (callbackError === null) return () => Reflect.apply(handler, globalObject, parameters);
        return () => {
          try {
            Reflect.apply(handler, globalObject, parameters);
          } catch (error) {
            callbackError(error);
          }
        };
      }
      const source = `${handler}`;
      return () => this.runClassicSource(source, this.document.URL, 1);
    };
    const bindings = {
      setTimeout(handler, timeout = 0, ...parameters) {
        return timers.setTimer(timerCallback(handler, parameters), timeout, false);
      },
      setInterval(handler, timeout = 0, ...parameters) {
        return timers.setTimer(timerCallback(handler, parameters), timeout, true);
      },
      clearTimeout(id = 0) {
        timers.clear(id);
      },
      clearInterval(id = 0) {
        timers.clear(id);
      },
    };
    Object.defineProperties(
      globalObject,
      Object.fromEntries(
        Object.entries(bindings).map(([name, value]) => [name, { configurable: true, enumerable: true, writable: true, value }]),
      ),
    );
  }

  window() {
    return this.document.defaultView;
  }

  fire(target, type, init = {}, fields = {}) {
    const event = createEvent(type, init, fields);
    dispatchEvent(target, event, { reportException: (error) => this.reportException(error, this.document.URL) });
    return event;
  }

  // An event at the window whose target is the document.
  fireAtWindowForDocument(window, event) {
    dispatchWindowEventWithDocumentTarget(
      window,
      event,
      this.document,
      (error) => this.reportException(error, this.document.URL),
    );
  }

  // "Report an exception": an error event at the window; when no handler
  // cancels it, a diagnostic record of the render.
  reportException(error, url, line = 0, inline = null) {
    const location = exceptionLocation(error, url, line, inline);
    const message = exceptionMessage(error);
    const window = this.window();
    let canceled = false;
    if (window !== null && !this.reporting) {
      this.reporting = true;
      try {
        const event = createEventUsing(SDErrorEvent, "error", {
          message,
          filename: location.filename,
          lineno: location.lineno,
          colno: location.colno,
          error,
          cancelable: true,
        });
        dispatchEvent(window, event, { reportException: () => {} });
        canceled = event.defaultPrevented;
      } finally {
        this.reporting = false;
      }
    }
    if (!canceled) {
      this.diagnose({
        code: "script-exception",
        message: `${message} (${location.filename}:${location.lineno}:${location.colno})`,
        filename: location.filename,
        lineno: location.lineno,
        colno: location.colno,
      });
    }
  }

  // An unhandled promise rejection: an unhandledrejection event at the
  // window; when no handler cancels it, a diagnostic record of the render,
  // as Chrome logs "Uncaught (in promise)".
  reportUnhandledRejection(reason, promise) {
    if (this.released) return;
    const window = this.window();
    let canceled = false;
    if (window !== null) {
      const event = createEventUsing(SDPromiseRejectionEvent, "unhandledrejection", { cancelable: true, promise, reason });
      dispatchEvent(window, event, { reportException: (error) => this.reportException(error, this.document.URL) });
      canceled = event.defaultPrevented;
    }
    if (canceled) return;
    const location = exceptionLocation(reason, this.document.URL);
    const message = exceptionMessage(reason).replace(/^Uncaught /, "Uncaught (in promise) ");
    this.diagnose({
      code: "script-unhandled-rejection",
      message: `${message} (${location.filename}:${location.lineno}:${location.colno})`,
      filename: location.filename,
      lineno: location.lineno,
      colno: location.colno,
    });
  }

  // "Run a classic script", as the document's code (component-code.js): a
  // promise it rejects reports for the document.
  runClassicSource(source, url, line, column = 0) {
    const realm = this.realm();
    const completion = validateCompletion(
      enterComponentCode(this.document, realm.session.evaluateScript, realm.session,
        [{ source, url, line, column, globalObject: realm.globalObject }]),
      this.document._resources.backend,
      "evaluateScript",
    );
    if (completion.type === "throw") this.reportException(completion.value, url, line);
    return completion;
  }

  // "Prepare the script element" (script_prepare): the core decides; the
  // host obtains the result and executes the script at once or as the
  // core's lists say. The linked style sheets that block a parser-inserted
  // script are reconciled first.
  prepare(element) {
    const core = this.document._domCore;
    const document = element.ownerDocument;
    this.document._styleSystem.reconcileLinkedSheets();
    const action = core.status(
      "script_prepare",
      element._coreHandle,
      this.document._coreHandle,
      Number(this.scripting),
      this.scriptNestingLevel,
    );
    const result = action & SCRIPT_RESULT_MASK;
    if (result === SCRIPT_RESULT_NONE) return;
    if (result === SCRIPT_RESULT_ERROR_EVENT) {
      this.queueTask(() => this.fire(element, "error"));
      return;
    }
    if (result === SCRIPT_RESULT_IMPORTMAP) {
      this.importMaps.push(Object.freeze({ text: childTextContent(element), baseURL: document.baseURI }));
      return;
    }
    const position = scriptRecord(this.scriptRecords, element).position;
    if (result === SCRIPT_RESULT_FETCH_CLASSIC) {
      this.fetchClassicScript(element, element.getAttribute("src"));
    } else if (result === SCRIPT_RESULT_MODULE_EXTERNAL) {
      this.moduleScriptCount += 1;
      this.markReady(element, { module: { reference: element.getAttribute("src"), baseURL: document.baseURI, source: null } });
    } else if (result === SCRIPT_RESULT_CLASSIC_INLINE) {
      this.markReady(element, {
        source: childTextContent(element),
        url: document.URL,
        line: position?.line ?? 1,
        column: position?.column ?? 0,
      });
    } else {
      this.moduleScriptCount += 1;
      // An inline module has a stable synthetic identity under the
      // document locator.
      const moduleURL = new URL(this.inputURL);
      moduleURL.pathname += `.inline-${this.moduleScriptCount}.js`;
      moduleURL.hash = `inline-module-${this.moduleScriptCount}`;
      this.markReady(element, {
        module: {
          reference: moduleURL.href,
          baseURL: document.baseURI,
          source: new TextEncoder().encode(childTextContent(element)),
        },
      });
    }
    if ((action & SCRIPT_EXECUTE_NOW) !== 0) this.executeScriptElement(element);
  }

  // The script's result is ready (script_ready): wake the parser or the
  // end of parsing, run the in-order list, or execute an
  // as-soon-as-possible script.
  markReady(element, result) {
    const core = this.document._domCore;
    scriptRecord(this.scriptRecords, element).result = result;
    const followUp = core.status("script_ready", element._coreHandle, Number(result === null));
    if (followUp === SCRIPT_READY_NOTIFY) {
      this.notify();
    } else if (followUp === SCRIPT_READY_IN_ORDER) {
      this.queueTask(() => this.runInOrderAsap());
    } else if (followUp === SCRIPT_READY_ASAP) {
      this.queueTask(() => {
        const finished = () => {
          core.status("script_list_remove", element._coreHandle);
          this.notify();
        };
        const execution = this.executeScriptElement(element);
        if (execution) execution.then(finished, (error) => this.failLoading(error));
        else finished();
      });
    }
  }

  // "Fetch a classic script": a demand to the host resource session.
  fetchClassicScript(element, reference) {
    const crossOrigin = element.getAttribute("crossorigin");
    const corsMode = crossOrigin === null ? null : crossOrigin.toLowerCase() === "use-credentials" ? "include" : "same-origin";
    const charset = element.getAttribute("charset");
    this.document._resources.resolveResource({
      requestedURL: reference,
      authoredURL: reference,
      baseURL: this.document.baseURI,
      kind: "classic-script",
      mode: corsMode === null ? "no-cors" : "cors",
      credentials: corsMode ?? "include",
    }).then((resource) => {
      if (blockedScriptMediaType(this.document._domCore, resource.mediaType)) {
        throw new TypeError(
          `The script ${resource.finalURL} has media type ${resource.mediaType}, which a script must not have`,
        );
      }
      let decoder;
      try {
        decoder = new TextDecoder(charset ?? "utf-8");
      } catch {
        decoder = new TextDecoder("utf-8");
      }
      this.markReady(element, { source: decoder.decode(resource.bytes), url: resource.finalURL, line: 1 });
    }).catch((error) => {
      if (this.released) return;
      this.diagnose({
        code: "script-resource-unavailable",
        message: `Script ${reference} against ${this.document.baseURI} is unavailable: ${error?.message ?? String(error)}`,
        resource: Object.freeze({ kind: "classic-script", reference }),
        cause: Object.freeze({ name: error?.name ?? "Error", code: error?.code ?? null, message: error?.message ?? String(error) }),
      });
      this.markReady(element, null);
    });
  }

  // "Execute the script element" (script_execute). A module script
  // returns the promise of its host module evaluation.
  executeScriptElement(element) {
    const core = this.document._domCore;
    const action = core.status("script_execute", element._coreHandle, this.document._coreHandle);
    // A script executes at most once; its record ends here.
    const record = scriptRecord(this.scriptRecords, element);
    this.scriptRecords.delete(element._coreHandle);
    const kind = action & 3;
    if (kind === SCRIPT_EXECUTE_SKIP) return undefined;
    if (kind === SCRIPT_EXECUTE_ERROR_EVENT) {
      this.fire(element, "error");
      return undefined;
    }
    const external = (action & SCRIPT_EXECUTE_EXTERNAL) !== 0;
    if (kind === SCRIPT_EXECUTE_MODULE) return this.executeModuleScript(element, record, external);
    if (external) this.ignoreDestructiveWrites += 1;
    const previousScript = this.currentScript;
    this.currentScript = (action & SCRIPT_EXECUTE_CURRENT) !== 0 ? element : null;
    try {
      this.runClassicSource(record.result.source, record.result.url, record.result.line, record.result.column ?? 0);
    } finally {
      this.currentScript = previousScript;
      if (external) this.ignoreDestructiveWrites -= 1;
    }
    if (external) this.fire(element, "load");
    return undefined;
  }

  // A module that throws (or does not parse) reports its exception, as an
  // error event at the window, and the render continues; a module graph
  // that the host cannot obtain fires error at the element, as a failed
  // fetch does in Chrome.
  async executeModuleScript(element, record, external) {
    if (this.executeModule === null) {
      this.diagnose({
        code: "module-script-not-run",
        message: `A module script of ${this.document.URL} needs a host module session, and this document has none`,
      });
      return;
    }
    // A module script evaluates in the realm of the document's classic
    // scripts. When that realm is Sandom's own, the host module session
    // evaluates the graph there already; a realm of the document's own goes
    // with the request, and the host evaluates the graph in it. Sandom's
    // own realm becomes the document's window first when its global can
    // take the document's bindings, as a dedicated worker's can, so the
    // module's globalThis is its window; a browser window's global keeps
    // its own document, and its modules see the document's globals while
    // they evaluate (input-preprocessors.js, withComponentGlobals).
    const session = this.document._resources.classicScriptSession;
    const ownRealm = session !== null && session.globalObject === globalThis;
    if (ownRealm && Object.getOwnPropertyDescriptor(globalThis, "document")?.configurable !== false) this.realm();
    const realm = session !== null && !ownRealm ? this.realm() : null;
    this.ignoreDestructiveWrites += 1;
    const previousScript = this.currentScript;
    this.currentScript = null;
    try {
      // The module runs as the document's code, as a classic script does.
      await enterComponentCode(this.document, this.executeModule, this, [{
        ...record.result.module,
        preprocessor: "javascript",
        importMaps: this.importMaps,
        realm,
      }]);
    } catch (error) {
      const { reference, baseURL } = record.result.module;
      const url = external ? new URL(reference, baseURL).href : this.document.URL;
      if (error?.code === "module-evaluation-failure") {
        // An inline module is evaluated under a synthetic locator; its
        // exception names the document, at the document's line, as in Chrome.
        this.reportException(error.cause, url, 0, external ? null : {
          from: reference,
          lineOffset: (record.position?.line ?? 1) - 1,
          columnOffset: record.position?.column ?? 0,
        });
      } else {
        this.diagnose({
          code: "script-resource-unavailable",
          message: `Module script ${url} is unavailable: ${error?.message ?? String(error)}`,
          cause: error,
        });
        this.fire(element, "error");
        return;
      }
    } finally {
      this.currentScript = previousScript;
      this.ignoreDestructiveWrites -= 1;
    }
    if (external) this.fire(element, "load");
  }

  // "The list of scripts that will execute in order as soon as possible"
  // (script_in_order_next: its first script, when ready).
  runInOrderAsap() {
    const core = this.document._domCore;
    for (;;) {
      const handle = core.handle("script_in_order_next", this.document._coreHandle);
      if (handle === 0n) return;
      const execution = this.executeScriptElement(core.wrapperFor(handle));
      if (execution) {
        execution.then(() => {
          core.status("script_list_remove", handle);
          this.notify();
          this.queueTask(() => this.runInOrderAsap());
        }, (error) => this.failLoading(error));
        return;
      }
      core.status("script_list_remove", handle);
      this.notify();
    }
  }

  failLoading(error) {
    this.loadFailure ??= error;
    this.document._domCore.status("script_load_failed", this.document._coreHandle);
    this.notify();
  }

  // The first script of a list of the document (script_list_first), 0n
  // for none.
  firstScript(list) {
    return this.document._domCore.handle("script_list_first", this.document._coreHandle, list);
  }

  scriptReady(handle) {
    return this.document._domCore.status("script_is_ready", handle) === 1;
  }

  setReadyState(state) {
    this.readyState = state;
    this.fire(this.document, "readystatechange");
  }

  // One run of the parser. The parser inserts nodes without a mutation
  // notification, so the linked style sheets and fonts owe a reconcile, the
  // new images start to load, and the event handler attributes of the new
  // elements activate here, before a script that the run paused at can see
  // them. Their window is the realm's, so the realm comes first.
  runParserStretch(parser, toInsertionPoint) {
    const result = parser.run({ toInsertionPoint });
    this.document._styleSystem.reconcileSoon();
    if (result.handlers.length > 0 && this.scripting) {
      this.realm();
      activateHandlerElements(result.handlers);
    }
    this.document._imagesParsed();
    return result;
  }

  // A script end tag in the "text" insertion mode.
  // `position` is where the script's text starts in the input.
  scriptEndTag(element, position = null) {
    const parser = this.parser;
    this.document._domCore.status("script_parser_inserted", element._coreHandle, this.document._coreHandle);
    scriptRecord(this.scriptRecords, element).position = position;
    const oldInsertionPoint = parser.insertionPoint;
    parser.markInsertionPoint();
    this.scriptNestingLevel += 1;
    try {
      this.prepare(element);
    } finally {
      this.scriptNestingLevel -= 1;
    }
    if (this.scriptNestingLevel === 0) this.parserPause = false;
    if (parser.active) parser.insertionPoint = oldInsertionPoint;
    if (this.firstScript(SCRIPT_LIST_BLOCKING) !== 0n && this.scriptNestingLevel > 0) {
      this.parserPause = true;
    }
  }

  // The parser's own loop: the input that the network delivered, or that
  // document.write and document.close gave a script-created parser.
  async runParser() {
    if (this.parserLoopRunning) return;
    this.parserLoopRunning = true;
    const parser = this.parser;
    let finished = false;
    this.enterTask();
    try {
      for (;;) {
        if (parser !== this.parser || !parser.active || this.released) return;
        const blocking = this.firstScript(SCRIPT_LIST_BLOCKING);
        if (blocking !== 0n) {
          await this.outsideTask(async () => {
            await this.until(() => this.scriptReady(blocking) || this.released || parser !== this.parser);
            await this.document._styleSystem.linkedSheetsSettled();
          });
          if (parser !== this.parser || !parser.active || this.released) return;
          this.document._domCore.status("script_list_remove", blocking);
          parser.markInsertionPoint();
          this.scriptNestingLevel += 1;
          try {
            this.executeScriptElement(this.document._domCore.wrapperFor(blocking));
          } finally {
            this.scriptNestingLevel -= 1;
          }
          this.parserPause = false;
          if (parser.active) parser.insertionPoint = null;
          await microtaskCheckpoint();
          continue;
        }
        const result = this.runParserStretch(parser, false);
        if (result.status === "script") {
          this.scriptEndTag(result.script, result);
          await microtaskCheckpoint();
          continue;
        }
        if (result.status === "finished") {
          finished = true;
          break;
        }
        // A script-created parser waits for document.write or
        // document.close.
        return;
      }
    } finally {
      this.parserLoopRunning = false;
      this.leaveTask();
    }
    if (finished && parser === this.parser) await this.theEnd(parser);
  }

  // "The end" (13.2.7). The end of the input reaches the parser as a task
  // of its own, as it does in Chrome, so the timers that became due while
  // the parser ran come first. The end then runs as one task, from
  // "interactive" through the window load event, except while it waits for
  // a script, a style sheet, a font or an image.
  async theEnd(parser) {
    await this.queueTask(() => {});
    if (this.parser !== parser || this.released) return;
    this.enterTask();
    try {
      await this.runTheEnd();
    } finally {
      this.leaveTask();
    }
  }

  async runTheEnd() {
    this.parser = null;
    this.setReadyState("interactive");
    await microtaskCheckpoint();
    for (;;) {
      const handle = this.firstScript(SCRIPT_LIST_AFTER_PARSING);
      if (handle === 0n) break;
      if (!this.scriptReady(handle)) await this.outsideTask(() => this.until(() => this.scriptReady(handle)));
      // Sandom's own step: the document's declared fonts load before a
      // deferred or module script runs (stylesheet.js, sheetsAndFontsSettled).
      await this.outsideTask(() => this.document._styleSystem.sheetsAndFontsSettled());
      if (this.released || this.parser !== null) return;
      const execution = this.executeScriptElement(this.document._domCore.wrapperFor(handle));
      if (execution) await execution;
      this.document._domCore.status("script_list_remove", handle);
      await microtaskCheckpoint();
    }
    if (this.parser !== null || this.released) return;
    this.fire(this.document, "DOMContentLoaded", { bubbles: true });
    await microtaskCheckpoint();
    const scriptsDone = () => this.document._domCore.status("script_scripts_done", this.document._coreHandle) === 1;
    if (!scriptsDone()) await this.outsideTask(() => this.until(scriptsDone));
    if (this.loadFailure !== undefined) throw this.loadFailure;
    // Linked style sheets, fonts and images delay the load event; a failed
    // one does not stop it. An image's request delays it until the task
    // that fires the image's load or error event has run.
    try {
      await this.outsideTask(() => this.document._readyForRendering());
    } catch {
      // The render reports failed resources itself.
    }
    await this.outsideTask(() => this.until(() => !this.document._imagesDelayLoadEvent));
    if (this.parser !== null || this.released) return;
    this.setReadyState("complete");
    const window = this.window();
    if (window !== null) {
      // Both carry the legacy target override: their target is the
      // document. pageshow is a page transition event.
      this.fireAtWindowForDocument(window, createEvent("load"));
      this.fireAtWindowForDocument(
        window,
        createEvent("pageshow", { bubbles: true, cancelable: true }, { persisted: false }),
      );
    }
    this.completelyLoaded = true;
    await microtaskCheckpoint();
  }

  // Loads the document from its complete input.
  async load(text, { inputURL, executeModule }) {
    this.inputURL = new URL(inputURL).href;
    this.executeModule = executeModule;
    if (this.scripting) {
      this.document._styleSystem.enableScripting();
      this.document._reportException ??= (error) => this.reportException(error, this.document.URL);
    }
    this.parser = beginHTMLDocumentParse(this.document, { scripting: this.scripting });
    this.readyState = "loading";
    this.completelyLoaded = false;
    this.parser.append(text);
    this.parser.end();
    this.loading = this.runParser();
    await this.loading;
  }

  // document.open() (8.4.1, "document open steps").
  open() {
    const document = this.document;
    document._domCore.statusRaw("script_dynamic_markup_allowed", document._coreHandle, SCRIPT_MARKUP_OPEN);
    if (this.parser !== null && this.parser.active && this.scriptNestingLevel > 0) return document;
    if (this.parser !== null && this.parser.active) {
      // A document that is still loading stops loading first.
      this.parser.abort();
    }
    this.parser = null;
    document._domCore.status("script_lists_reset", document._coreHandle);
    // Every node and the window lose their listeners and handlers.
    eraseShadowIncludingListeners(document);
    const window = document.defaultView;
    if (window !== null && window !== undefined && window.document === document) {
      eraseEventListenersAndHandlers(window, document._domCore);
    }
    document.replaceChildren();
    this.parser = beginHTMLDocumentParse(document, { scripting: this.scripting });
    this.parser.scriptCreated = true;
    this.parser.markInsertionPoint();
    this.setReadyState("loading");
    return document;
  }

  // document.close().
  close() {
    const document = this.document;
    document._domCore.statusRaw("script_dynamic_markup_allowed", document._coreHandle, SCRIPT_MARKUP_CLOSE);
    if (this.parser === null || !this.parser.active || !this.parser.scriptCreated) return;
    this.parser.end();
    if (this.firstScript(SCRIPT_LIST_BLOCKING) !== 0n) return;
    this.loading = this.runParser();
    this.loading.catch((error) => this.reportException(error, document.URL));
  }

  // document.write() and document.writeln() (8.4.3).
  write(text) {
    const document = this.document;
    document._domCore.statusRaw("script_dynamic_markup_allowed", document._coreHandle, SCRIPT_MARKUP_WRITE);
    if (this.parser === null || !this.parser.active || this.parser.insertionPoint === null) {
      if (this.ignoreDestructiveWrites > 0) return;
      this.open();
    }
    const parser = this.parser;
    parser.insert(text);
    if (this.firstScript(SCRIPT_LIST_BLOCKING) !== 0n) return;
    this.enterTask();
    try {
      for (;;) {
        if (parser !== this.parser || !parser.active) return;
        const result = this.runParserStretch(parser, true);
        if (result.status !== "script") break;
        this.scriptEndTag(result.script, result);
        if (this.parserPause || this.firstScript(SCRIPT_LIST_BLOCKING) !== 0n) break;
      }
    } finally {
      this.leaveTask();
    }
    // A script-created parser at script nesting level zero continues on its
    // own once a parser-blocking script it met is delivered.
    if (this.firstScript(SCRIPT_LIST_BLOCKING) !== 0n && this.scriptNestingLevel === 0) {
      this.loading = this.runParser();
      this.loading.catch((error) => this.reportException(error, document.URL));
    }
  }

  // A tree mutation outside the parser: the insertion, children-changed
  // and src-attribute steps of script elements (script_mutation_prepares)
  // and event handler content attributes, as the callback record's
  // effects request.
  mutation(node, effects, record) {
    if (!this.scripting || this.released) return;
    const core = this.document._domCore;
    const prepareListed = (handle, mutation, oldPresent = 0) => {
      for (const script of core.outputNodes(core.status("script_mutation_prepares", handle, mutation, oldPresent))) {
        this.prepare(script);
      }
    };
    if (effects & CALLBACK_EFFECT_SCRIPT_CHILDREN) prepareListed(node._coreHandle, SCRIPT_MUTATION_CHILDREN);
    if (effects & CALLBACK_EFFECT_SCRIPT_INSERTED) {
      for (const added of record.addedNodes) prepareListed(added._coreHandle, SCRIPT_MUTATION_INSERTED);
    }
    if (effects & CALLBACK_EFFECT_SCRIPT_SRC) {
      prepareListed(node._coreHandle, SCRIPT_MUTATION_SRC, Number(record.oldValue !== null));
    }
    if (effects & CALLBACK_EFFECT_EVENT_HANDLER) {
      const name = record.attributeName;
      this.realm();
      eventHandlerAttributeChanged(node, name, node.getAttribute(name), this.handlerPosition());
    }
  }

  // Where a handler that a script or fragment parsing sets gets its source
  // position, as in Chrome: the position of the document's parser while it
  // parses, else the start of the document.
  handlerPosition() {
    return this.parser?.active ? this.parser.position() : { line: 1, column: 0 };
  }

  // The content-attribute handlers of the elements that fragment parsing
  // created under `root`.
  activateParsedHandlers(root) {
    if (!this.scripting || !hasEventHandlerAttributes(root)) return;
    this.realm();
    activateParsedEventHandlers(root, this.handlerPosition());
  }

  // Compiles one internal raw uncompiled handler in the document realm
  // (HTML, "getting the current value of the event handler").
  compileEventHandler(target, type, raw) {
    if (!this.scripting || this.released) return null;
    const realm = this.realm();
    const window = this.window();
    const core = this.document._domCore;
    const element = target === window ? null : raw.element;
    const formOwner = element === null ? null : core.wrapperFor(core.handle("script_handler_form", element._coreHandle));
    const parameters = HANDLER_PARAMETERS[
      core.status("script_handler_parameters", element?._coreHandle ?? 0n, Number(type === "error"))
    ];
    const completion = validateCompletion(
      realm.session.compileEventHandler({
        name: `on${type}`,
        parameters,
        body: raw.body,
        scopes: [element, formOwner, element === null ? null : this.document],
        url: raw.url,
        line: raw.line,
        column: raw.column,
        globalObject: realm.globalObject,
      }),
      this.document._resources.backend,
      "compileEventHandler",
    );
    if (completion.type === "throw") {
      this.reportException(completion.value, raw.url, raw.line);
      return null;
    }
    return completion.value;
  }

  // A click whose default action reaches a hyperlink: a javascript: URL
  // runs; Sandom performs no other navigation.
  followHyperlink(target) {
    if (!this.scripting || this.released) return;
    const core = this.document._domCore;
    const link = core.wrapperFor(core.handle("script_hyperlink", target._coreHandle));
    if (link === null) return;
    const url = URL.parse(link.getAttribute("href"), this.document.baseURI);
    if (url === null) return;
    if (core.status("script_url_is_javascript", ...core.input(url.href)) === 1) this.queueJavaScriptURL(url.href);
  }

  // "Evaluate a javascript: URL" as a task of the document: the decoded
  // source runs as a classic script, and a string result replaces the
  // document. As in Chrome, the javascript: URLs that a task navigates to
  // run in one task, queued with the first: on Chrome 151 a page that sets
  // timers between two of them runs both URLs before those timers.
  queueJavaScriptURL(href) {
    if (!this.scripting || this.released) return;
    this.pendingJavaScriptURLs.push(href);
    if (this.pendingJavaScriptURLs.length > 1) return;
    this.queueTask(() => {
      for (const url of this.pendingJavaScriptURLs.splice(0)) {
        if (this.released) return;
        try {
          this.runJavaScriptURL(url);
        } catch (error) {
          this.reportException(error, this.document.URL);
        }
      }
    });
  }

  runJavaScriptURL(href) {
    const encoded = href.slice("javascript:".length);
    let source;
    try {
      source = new TextDecoder().decode(percentDecode(this.document._domCore, encoded));
    } catch {
      return;
    }
    const completion = this.runClassicSource(source, this.document.URL, 1);
    if (completion.type === "normal" && typeof completion.value === "string") {
      this.open();
      this.write(completion.value);
      this.close();
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.parser?.abort?.();
    this.parser = null;
    this.notify();
    this.timers?.release();
    if (this.document._documentTimers === this.timers) this.document._documentTimers = null;
    for (const { resolve } of this.tasks.splice(0)) resolve();
    const realm = this.document._realm;
    if (realm) realm.release();
  }
}

// The script processing of `document`, created on first use.
export function documentScripts(document) {
  document._scriptProcessing ??= new DocumentScripts(document);
  return document._scriptProcessing;
}

// Parses and loads one HTML document with its scripts: the parser stops at
// each script end tag, scripts run in the standard's order, and the
// promise settles after the window load event.
export async function loadHTMLDocument(document, text, options) {
  await documentScripts(document).load(text, options);
}

// A document whose host evaluates no classic script keeps its classic
// scripts inert, as a browser with scripting disabled does, and says so.
export function reportScriptingDisabled(document) {
  const count = document._domCore.status("script_classic_count", document._coreHandle);
  if (count === 0) return;
  documentScripts(document).diagnose({
    code: "scripting-disabled",
    message: `The host ${document._resources.backend} evaluates no classic script; ${count} classic script(s) of ${document.URL} did not run`,
  });
}

export function documentWrite(document, strings, newline) {
  let text = "";
  for (const string of strings) text += String(string);
  if (newline) text += "\n";
  documentScripts(document).write(text);
}

export function documentOpen(document) {
  return documentScripts(document).open();
}

export function documentClose(document) {
  documentScripts(document).close();
}

export function documentReadyState(document) {
  return document._scriptProcessing?.readyState ?? "complete";
}

export function documentCompletelyLoaded(document) {
  return document._scriptProcessing?.completelyLoaded ?? true;
}

export function documentCurrentScript(document) {
  return document._scriptProcessing?.currentScript ?? null;
}
