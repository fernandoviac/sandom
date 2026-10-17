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
import { createEvent, dispatchEvent, dispatchWindowEventWithDocumentTarget } from "./events.js";
import {
  activateHandlerElements,
  activateParsedEventHandlers,
  eraseEventListenersAndHandlers,
  eventHandlerAttributeChanged,
  hasEventHandlerAttributes,
} from "./event-handlers.js";

const FORM_ASSOCIATED = new Set(["button", "fieldset", "input", "object", "output", "select", "textarea"]);

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// MIME Sniffing, "JavaScript MIME type".
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Fetch, "should response to request be blocked due to its MIME type?".
function blockedScriptMediaType(mediaType) {
  return mediaType !== null && (
    mediaType.startsWith("audio/") || mediaType.startsWith("image/") ||
    mediaType.startsWith("video/") || mediaType === "text/csv"
  );
}

const ASCII_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

function isScriptElement(node) {
  return node?.nodeType === 1 && node.localName === "script" &&
    (node.namespaceURI === HTML_NS || node.namespaceURI === SVG_NS);
}

// "The script block's type string" and the script's type (4.12.1.1,
// "prepare the script element", steps 8 to 10): "classic", "module",
// "importmap", or null for a data block.
function scriptType(element) {
  const type = element.getAttribute("type");
  const language = element.getAttribute("language");
  let typeString;
  if (type === "" || (type === null && (language === null || language === ""))) {
    typeString = "text/javascript";
  } else if (type !== null) {
    typeString = type.replace(ASCII_WHITESPACE, "");
  } else {
    typeString = `text/${language}`;
  }
  const lower = typeString.toLowerCase();
  if (JAVASCRIPT_MIME_TYPES.has(lower)) return "classic";
  if (lower === "module") return "module";
  if (lower === "importmap") return "importmap";
  return null;
}

// The child text content of the element: its Text children, in order.
function childTextContent(element) {
  let text = "";
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 3) text += child.data;
  }
  return text;
}

// The per-element flags of the HTML Standard: "already started", "parser
// document", "force async", "preparation-time document", "from an external
// file", and the script's result once it is ready (null on failure).
const elementStates = new WeakMap();

function stateOf(element) {
  let state = elementStates.get(element);
  if (state === undefined) {
    state = {
      alreadyStarted: false,
      parserDocument: null,
      forceAsync: true,
      preparationTimeDocument: null,
      type: null,
      external: false,
      ready: false,
      result: undefined,
      onReady: null,
    };
    elementStates.set(element, state);
  }
  return state;
}

// Fragment parsing (innerHTML, insertAdjacentHTML, DOMParser fragments)
// marks its scripts "already started", so inserting them runs nothing.
export function markScriptsAlreadyStarted(root) {
  for (const element of root.querySelectorAll("script")) {
    stateOf(element).alreadyStarted = true;
  }
}

// The "async" IDL attribute of a script element.
export function scriptElementAsync(element) {
  return stateOf(element).forceAsync || element.hasAttribute("async");
}

export function setScriptElementAsync(element, value) {
  stateOf(element).forceAsync = false;
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

// URL Standard, "percent-decode" of a string.
function percentDecode(text) {
  const bytes = new TextEncoder().encode(text);
  const decoded = new Uint8Array(bytes.length);
  const hex = (byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x25 && index + 2 < bytes.length && hex(bytes[index + 1]) && hex(bytes[index + 2])) {
      decoded[length++] = Number.parseInt(String.fromCharCode(bytes[index + 1], bytes[index + 2]), 16);
      index += 2;
    } else {
      decoded[length++] = byte;
    }
  }
  return decoded.subarray(0, length);
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

// The realm's MessageChannel, taken before a component session can replace
// the global one: the document's task queue is not component code, and its
// ports do not close with the component's (component-globals.js).
const RealmMessageChannel = globalThis.MessageChannel;

// One macrotask hop: every microtask queued so far, and every microtask
// they queue, runs before it ("perform a microtask checkpoint" after a
// script runs with an empty execution context stack).
function microtaskCheckpoint() {
  return new Promise((resolve) => {
    const channel = new RealmMessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

class DocumentScripts {
  constructor(document) {
    this.document = document;
    this.scripting = document._resources.scriptingEnabled && document._enterRealm !== null;
    this.parser = null;
    this.parserLoopRunning = false;
    this.scriptNestingLevel = 0;
    this.parserPause = false;
    this.pendingParsingBlockingScript = null;
    this.afterParsing = [];
    this.inOrderAsap = [];
    this.asapSet = new Set();
    this.readyState = "complete";
    this.currentScript = null;
    this.ignoreDestructiveWrites = 0;
    this.throwOnDynamicMarkupInsertion = 0;
    this.importMaps = [];
    this.moduleScriptCount = 0;
    this.executeModule = null;
    this.inputURL = document.URL;
    this.diagnosticRecords = [];
    this.waiters = new Set();
    this.taskDepth = 0;
    this.tasks = [];
    this.runningTasks = false;
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
    }
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
        const event = new ErrorEvent("error", {
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
      const event = createEvent("unhandledrejection", { cancelable: true }, { promise, reason });
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

  // "Prepare the script element".
  prepare(element) {
    const state = stateOf(element);
    if (state.alreadyStarted) return;
    const parserDocument = state.parserDocument;
    state.parserDocument = null;
    if (parserDocument !== null && !element.hasAttribute("async")) state.forceAsync = true;
    const sourceText = childTextContent(element);
    const hasSource = element.hasAttribute("src");
    if (!hasSource && sourceText === "") return;
    if (!element.isConnected) return;
    const type = scriptType(element);
    if (type === null) return;
    if (parserDocument !== null) {
      state.parserDocument = parserDocument;
      state.forceAsync = false;
    }
    state.alreadyStarted = true;
    const document = element.ownerDocument;
    state.preparationTimeDocument = document;
    if (parserDocument !== null && parserDocument !== document) return;
    if (!this.scripting) return;
    if (type === "classic" && element.hasAttribute("nomodule")) return;
    if (type === "classic" && element.hasAttribute("event") && element.hasAttribute("for")) {
      const forValue = element.getAttribute("for").replace(ASCII_WHITESPACE, "").toLowerCase();
      const eventValue = element.getAttribute("event").replace(ASCII_WHITESPACE, "").toLowerCase();
      if (forValue !== "window" || (eventValue !== "onload" && eventValue !== "onload()")) return;
    }
    state.type = type;
    if (type === "importmap") {
      if (hasSource) {
        this.queueTask(() => this.fire(element, "error"));
        return;
      }
      this.importMaps.push(Object.freeze({ text: sourceText, baseURL: document.baseURI }));
      return;
    }
    if (hasSource) {
      const reference = element.getAttribute("src");
      if (reference === "") {
        this.queueTask(() => this.fire(element, "error"));
        return;
      }
      state.external = true;
      if (!URL.canParse(reference, document.baseURI)) {
        this.queueTask(() => this.fire(element, "error"));
        return;
      }
      if (type === "classic") {
        this.fetchClassicScript(element, state, reference);
      } else {
        this.moduleScriptCount += 1;
        this.markReady(state, { module: { reference, baseURL: document.baseURI, source: null } });
      }
    } else if (type === "classic") {
      this.markReady(state, {
        source: sourceText,
        url: document.URL,
        line: state.position?.line ?? 1,
        column: state.position?.column ?? 0,
      });
    } else {
      this.moduleScriptCount += 1;
      // An inline module has a stable synthetic identity under the
      // document locator.
      const moduleURL = new URL(this.inputURL);
      moduleURL.pathname += `.inline-${this.moduleScriptCount}.js`;
      moduleURL.hash = `inline-module-${this.moduleScriptCount}`;
      this.markReady(state, {
        module: {
          reference: moduleURL.href,
          baseURL: document.baseURI,
          source: new TextEncoder().encode(sourceText),
        },
      });
    }

    const parserInserted = state.parserDocument !== null;
    const isAsync = element.hasAttribute("async");
    const fetched = (type === "classic" && hasSource) || type === "module";
    if (
      (type === "classic" && hasSource && element.hasAttribute("defer") && parserInserted && !isAsync) ||
      (type === "module" && parserInserted && !isAsync)
    ) {
      this.afterParsing.push(element);
      state.onReady = () => this.notify();
    } else if (type === "classic" && hasSource && parserInserted && !isAsync) {
      this.pendingParsingBlockingScript = element;
      state.onReady = () => this.notify();
    } else if (fetched && !isAsync && !state.forceAsync) {
      this.inOrderAsap.push(element);
      state.onReady = () => this.queueTask(() => this.runInOrderAsap());
      if (state.ready) state.onReady();
    } else if (fetched) {
      this.asapSet.add(element);
      state.onReady = () =>
        this.queueTask(() => {
          const finished = () => {
            this.asapSet.delete(element);
            this.notify();
          };
          const execution = this.executeScriptElement(element);
          if (execution) execution.then(finished, (error) => this.failLoading(error));
          else finished();
        });
      if (state.ready) state.onReady();
    } else if (
      parserInserted && type === "classic" && this.scriptNestingLevel <= 1 &&
      this.document._styleSystem.hasLoadingLinkedSheets()
    ) {
      this.pendingParsingBlockingScript = element;
      state.onReady = () => this.notify();
    } else {
      this.executeScriptElement(element);
    }
  }

  markReady(state, result) {
    state.result = result;
    state.ready = true;
    state.onReady?.();
  }

  // "Fetch a classic script": a demand to the host resource session.
  fetchClassicScript(element, state, reference) {
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
      if (blockedScriptMediaType(resource.mediaType)) {
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
      this.markReady(state, { source: decoder.decode(resource.bytes), url: resource.finalURL, line: 1 });
    }).catch((error) => {
      if (this.released) return;
      this.diagnose({
        code: "script-resource-unavailable",
        message: `Script ${reference} against ${this.document.baseURI} is unavailable: ${error?.message ?? String(error)}`,
        resource: Object.freeze({ kind: "classic-script", reference }),
        cause: Object.freeze({ name: error?.name ?? "Error", code: error?.code ?? null, message: error?.message ?? String(error) }),
      });
      this.markReady(state, null);
    });
  }

  // "Execute the script element". A module script returns the promise of
  // its host module evaluation.
  executeScriptElement(element) {
    const state = stateOf(element);
    const document = element.ownerDocument;
    if (state.preparationTimeDocument !== document || document !== this.document) return undefined;
    if (state.result === null) {
      this.fire(element, "error");
      return undefined;
    }
    if (state.type === "module") return this.executeModuleScript(element, state);
    if (state.external) this.ignoreDestructiveWrites += 1;
    const previousScript = this.currentScript;
    this.currentScript = element.getRootNode() === document ? element : null;
    try {
      this.runClassicSource(state.result.source, state.result.url, state.result.line, state.result.column ?? 0);
    } finally {
      this.currentScript = previousScript;
      if (state.external) this.ignoreDestructiveWrites -= 1;
    }
    if (state.external) this.fire(element, "load");
    return undefined;
  }

  // A module that throws (or does not parse) reports its exception, as an
  // error event at the window, and the render continues; a module graph
  // that the host cannot obtain fires error at the element, as a failed
  // fetch does in Chrome.
  async executeModuleScript(element, state) {
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
    // with the request, and the host evaluates the graph in it.
    const session = this.document._resources.classicScriptSession;
    const realm = session !== null && session.globalObject !== globalThis ? this.realm() : null;
    this.ignoreDestructiveWrites += 1;
    const previousScript = this.currentScript;
    this.currentScript = null;
    try {
      // The module runs as the document's code, as a classic script does.
      await enterComponentCode(this.document, this.executeModule, this, [{
        ...state.result.module,
        preprocessor: "javascript",
        importMaps: this.importMaps,
        realm,
      }]);
    } catch (error) {
      const { reference, baseURL } = state.result.module;
      const url = state.external ? new URL(reference, baseURL).href : this.document.URL;
      if (error?.code === "module-evaluation-failure") {
        // An inline module is evaluated under a synthetic locator; its
        // exception names the document, at the document's line, as in Chrome.
        this.reportException(error.cause, url, 0, state.external ? null : {
          from: reference,
          lineOffset: (state.position?.line ?? 1) - 1,
          columnOffset: state.position?.column ?? 0,
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
    if (state.external) this.fire(element, "load");
  }

  // "The list of scripts that will execute in order as soon as possible".
  runInOrderAsap() {
    while (this.inOrderAsap.length > 0 && stateOf(this.inOrderAsap[0]).ready) {
      const element = this.inOrderAsap[0];
      const execution = this.executeScriptElement(element);
      if (execution) {
        execution.then(() => {
          this.inOrderAsap.shift();
          this.notify();
          this.queueTask(() => this.runInOrderAsap());
        }, (error) => this.failLoading(error));
        return;
      }
      this.inOrderAsap.shift();
      this.notify();
    }
  }

  failLoading(error) {
    this.loadFailure ??= error;
    this.notify();
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
    const state = stateOf(element);
    state.parserDocument = this.document;
    state.forceAsync = false;
    state.position = position;
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
    if (this.pendingParsingBlockingScript !== null && this.scriptNestingLevel > 0) {
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
        if (this.pendingParsingBlockingScript !== null) {
          const element = this.pendingParsingBlockingScript;
          const state = stateOf(element);
          await this.outsideTask(async () => {
            await this.until(() => state.ready || this.released || parser !== this.parser);
            await this.document._styleSystem.linkedSheetsSettled();
          });
          if (parser !== this.parser || !parser.active || this.released) return;
          this.pendingParsingBlockingScript = null;
          parser.markInsertionPoint();
          this.scriptNestingLevel += 1;
          try {
            this.executeScriptElement(element);
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
    while (this.afterParsing.length > 0) {
      const element = this.afterParsing[0];
      const state = stateOf(element);
      if (!state.ready) await this.outsideTask(() => this.until(() => state.ready));
      await this.outsideTask(() => this.document._styleSystem.linkedSheetsSettled());
      if (this.released || this.parser !== null) return;
      const execution = this.executeScriptElement(element);
      if (execution) await execution;
      this.afterParsing.shift();
      await microtaskCheckpoint();
    }
    if (this.parser !== null || this.released) return;
    this.fire(this.document, "DOMContentLoaded", { bubbles: true });
    await microtaskCheckpoint();
    const scriptsDone = () =>
      this.loadFailure !== undefined || (this.asapSet.size === 0 && this.inOrderAsap.length === 0);
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
    this.parser.append(text);
    this.parser.end();
    this.loading = this.runParser();
    await this.loading;
  }

  // document.open() (8.4.1, "document open steps").
  open() {
    const document = this.document;
    if (document._xmlDocument) throw invalidState("document.open() is not supported in an XML document");
    if (this.throwOnDynamicMarkupInsertion > 0) {
      throw invalidState("document.open() cannot run while the parser constructs a custom element");
    }
    if (this.parser !== null && this.parser.active && this.scriptNestingLevel > 0) return document;
    if (this.parser !== null && this.parser.active) {
      // A document that is still loading stops loading first.
      this.parser.abort();
    }
    this.parser = null;
    this.pendingParsingBlockingScript = null;
    this.afterParsing = [];
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
    if (document._xmlDocument) throw invalidState("document.close() is not supported in an XML document");
    if (this.throwOnDynamicMarkupInsertion > 0) {
      throw invalidState("document.close() cannot run while the parser constructs a custom element");
    }
    if (this.parser === null || !this.parser.active || !this.parser.scriptCreated) return;
    this.parser.end();
    if (this.pendingParsingBlockingScript !== null) return;
    this.loading = this.runParser();
    this.loading.catch((error) => this.reportException(error, document.URL));
  }

  // document.write() and document.writeln() (8.4.3).
  write(text) {
    const document = this.document;
    if (document._xmlDocument) throw invalidState("document.write() is not supported in an XML document");
    if (this.throwOnDynamicMarkupInsertion > 0) {
      throw invalidState("document.write() cannot run while the parser constructs a custom element");
    }
    if (this.parser === null || !this.parser.active || this.parser.insertionPoint === null) {
      if (this.ignoreDestructiveWrites > 0) return;
      this.open();
    }
    const parser = this.parser;
    parser.insert(text);
    if (this.pendingParsingBlockingScript !== null) return;
    this.enterTask();
    try {
      for (;;) {
        if (parser !== this.parser || !parser.active) return;
        const result = this.runParserStretch(parser, true);
        if (result.status !== "script") break;
        this.scriptEndTag(result.script, result);
        if (this.parserPause || this.pendingParsingBlockingScript !== null) break;
      }
    } finally {
      this.leaveTask();
    }
    // A script-created parser at script nesting level zero continues on its
    // own once a parser-blocking script it met is delivered.
    if (this.pendingParsingBlockingScript !== null && this.scriptNestingLevel === 0) {
      this.loading = this.runParser();
      this.loading.catch((error) => this.reportException(error, document.URL));
    }
  }

  // A tree mutation outside the parser: the insertion, children-changed
  // and src-attribute steps of script elements.
  mutation(node, kind, detail, record) {
    if (!this.scripting || this.released) return;
    if (kind === "structure") {
      if (isScriptElement(node) && node.isConnected && stateOf(node).parserDocument === null) {
        this.prepare(node);
      }
      for (const added of record?.addedNodes ?? []) {
        if (added.nodeType !== 1 || !added.isConnected) continue;
        if (isScriptElement(added)) {
          if (stateOf(added).parserDocument === null) this.prepare(added);
          continue;
        }
        for (const script of added.querySelectorAll("script")) {
          if (script.isConnected && stateOf(script).parserDocument === null) this.prepare(script);
        }
      }
      return;
    }
    if (kind !== "attribute") return;
    const name = record?.attributeName ?? detail;
    if (typeof name !== "string") return;
    if (
      name === "src" && isScriptElement(node) && node.isConnected &&
      record?.oldValue === null && stateOf(node).parserDocument === null && node.hasAttribute("src")
    ) {
      this.prepare(node);
      return;
    }
    if (name.startsWith("on")) {
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
    const element = target === window ? null : raw.element;
    const formOwner = element !== null && FORM_ASSOCIATED.has(element.localName) && element.namespaceURI === HTML_NS
      ? element.form ?? null
      : null;
    let parameters = ["event"];
    if (type === "error" && target === window) parameters = ["event", "source", "lineno", "colno", "error"];
    else if (element?.namespaceURI === SVG_NS) parameters = ["evt"];
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
    const element = target.nodeType === 1 ? target : target.parentElement;
    const link = element?.closest?.("a[href], area[href]") ?? null;
    if (link === null) return;
    let url;
    try {
      url = new URL(link.getAttribute("href"), this.document.baseURI);
    } catch {
      return;
    }
    if (url.protocol === "javascript:") this.queueJavaScriptURL(url.href);
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
      source = new TextDecoder().decode(percentDecode(encoded));
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
  let count = 0;
  for (const element of document.querySelectorAll("script")) {
    if (scriptType(element) === "classic") count += 1;
  }
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

export function documentCurrentScript(document) {
  return document._scriptProcessing?.currentScript ?? null;
}
