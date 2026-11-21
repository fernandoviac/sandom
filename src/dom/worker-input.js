// The input of a Sandom document that runs in a worker
// (plans/PLAN-sandom-embedding.md, "A DOM in a worker"). The page keeps the
// canvas element, which receives the pointer, the keys and the clipboard;
// the worker keeps the document. One MessagePort joins them:
//
//   page:   const input = bindWorkerInput(canvas);
//           const offscreen = canvas.transferControlToOffscreen();
//           worker.postMessage({ canvas: offscreen, input: input.port }, [offscreen, input.port]);
//   worker: const view = await dom.attach({ canvas }, { input });
//
// The page side is bindProjectedInput's page half (bindDocumentInput) with a
// remote document port. The worker side (serveWorkerInput, which attach
// calls) delivers each record to the document and answers with the state
// the page side reads at once: the cursor, whether a text control has focus
// and where its caret is. Copy and cut fire the document's clipboard event
// in the worker; the page writes the text the worker returns to the
// system clipboard (navigator.clipboard), within the key press's user
// activation. The page also sends the canvas's layout size and pixel
// density, which an OffscreenCanvas does not have.
//
// Messages, page to worker: { kind: "size", width, height, deviceScale },
// { kind: "input", method, arguments_ }, { kind: "preferences", preferences },
// { kind: "clipboard", method: "copy" | "cut" }. Worker to page:
// { kind: "state", cursor, textControlFocused, caret }, { kind: "clipboard",
// text }, { kind: "failed", message, stack }.
import { bindDocumentInput, layoutBoxSize, localDocumentPort, projectOntoRectangle } from "./projected-surface.js";

// The page side. `canvas` is the HTMLCanvasElement whose control the page
// transfers to the worker. Returns { port, dispose }: the page transfers
// `port` to the worker for attach's `input` option. The document's viewport
// is the canvas's layout box, or `viewport` ({ width, height } in CSS
// pixels) for a document of a fixed size that the canvas scales; the input
// maps the canvas box onto it. The density is the display's; with
// `viewport`, it is the canvas's physical pixels for each viewport pixel, so
// a canvas that the page shows larger or smaller renders at its displayed
// size, and each change of that size reaches the worker. `deviceScale`
// replaces either.
export function bindWorkerInput(canvas, { deviceScale = null, viewport = null, label = "Sandom document" } = {}) {
  if (typeof globalThis.HTMLCanvasElement !== "function" || !(canvas instanceof globalThis.HTMLCanvasElement)) {
    throw new TypeError(`bindWorkerInput takes the page's HTMLCanvasElement; it received ${canvas}`);
  }
  if (!canvas.isConnected) {
    throw new Error("bindWorkerInput: insert the canvas into the page first; its layout box sets the document's viewport");
  }
  if (viewport !== null && !(viewport.width > 0 && viewport.height > 0)) {
    throw new RangeError(`bindWorkerInput viewport must have a positive width and height in CSS pixels; it is ${JSON.stringify(viewport)}`);
  }
  const channel = new MessageChannel();
  const port = channel.port1;
  const scale = () => {
    if (deviceScale !== null) return deviceScale;
    const displayDensity = globalThis.devicePixelRatio ?? 1;
    if (viewport === null) return displayDensity;
    // A hidden canvas has no box: its document keeps the last density.
    const displayedWidth = canvas.getBoundingClientRect().width;
    return displayedWidth > 0 ? displayDensity * (displayedWidth / viewport.width) : density ?? displayDensity;
  };
  const layoutSize = () => viewport === null ? layoutBoxSize(canvas, "bindWorkerInput") : { width: viewport.width, height: viewport.height };
  let size = layoutSize();
  let density = null;
  density = scale();
  let projection = projectOntoRectangle(canvas, size);
  const sendSize = () => port.postMessage({ kind: "size", width: size.width, height: size.height, deviceScale: density });
  sendSize();

  // The worker document's state, as its last answer gives it.
  const state = { cursor: null, textControlFocused: false, caret: null };
  const frameListeners = new Set();
  port.onmessage = ({ data }) => {
    if (data.kind === "state") {
      state.cursor = data.cursor;
      state.textControlFocused = data.textControlFocused;
      state.caret = data.caret;
      for (const listener of [...frameListeners]) listener();
    } else if (data.kind === "clipboard") {
      if (data.text !== null) {
        navigator.clipboard.writeText(data.text).catch((error) => {
          globalThis.reportError(new Error(`bindWorkerInput: the system clipboard refused the copied text: ${error.message}`, { cause: error }));
        });
      }
    } else if (data.kind === "failed") {
      const error = new Error(`The worker's Sandom document failed an input record: ${data.message}`);
      error.stack = data.stack;
      globalThis.reportError(error);
    } else {
      throw new Error(`bindWorkerInput: the worker sent an unknown message kind ${JSON.stringify(data.kind)}`);
    }
  };
  const remote = Object.freeze({
    deliver: (method, ...arguments_) => port.postMessage({ kind: "input", method, arguments_ }),
    setPreferences: (preferences) => port.postMessage({ kind: "preferences", preferences }),
    cursorAt: () => state.cursor,
    // The worker fires the clipboard event and returns the text, which the
    // page writes; the browser's own clipboard event carries none.
    copy() {
      port.postMessage({ kind: "clipboard", method: "copy" });
      return null;
    },
    cut() {
      port.postMessage({ kind: "clipboard", method: "cut" });
      return null;
    },
    textControlFocused: () => state.textControlFocused,
    caret: () => state.caret,
    onFrame(callback) {
      frameListeners.add(callback);
      return () => frameListeners.delete(callback);
    },
    dispatchInputRecords() {
      throw new Error("bindWorkerInput: releaseWheelAtBoundary needs the document's scroll result at once, which a worker cannot give");
    },
  });
  const binding = bindDocumentInput({
    host: canvas,
    target: Object.freeze({ backend: null, root: remote, port: remote }),
    project: (event) => projection(event),
    unproject: (point) => projection.unproject(point),
    label,
  });

  const resize = () => {
    const next = layoutSize();
    const nextDensity = scale();
    if (next.width === size.width && next.height === size.height && nextDensity === density) return;
    size = next;
    density = nextDensity;
    projection = projectOntoRectangle(canvas, size);
    sendSize();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  let densityQuery = null;
  const watchDensity = () => {
    densityQuery?.removeEventListener("change", onDensity);
    densityQuery = deviceScale === null ? globalThis.matchMedia(`(resolution: ${globalThis.devicePixelRatio ?? 1}dppx)`) : null;
    densityQuery?.addEventListener("change", onDensity);
  };
  function onDensity() {
    resize();
    watchDensity();
  }
  watchDensity();

  return Object.freeze({
    port: channel.port2,
    dispose() {
      binding.dispose();
      resizeObserver.disconnect();
      densityQuery?.removeEventListener("change", onDensity);
      port.close();
    },
  });
}

// The worker side, for attach: resolves to the page's first size, then
// serves the port. `connect(size)` creates the view's surface at that size
// and returns { backend, root, surface }. `onInput()`, when given, runs
// after each input or clipboard record reaches the document.
export function serveWorkerInput(port, connect, onInput = null) {
  return new Promise((resolve, reject) => {
    let served = null;
    let controls = new WeakMap();
    let controlCount = 0;
    const controlId = (control) => {
      let id = controls.get(control);
      if (id === undefined) controls.set(control, id = ++controlCount);
      return id;
    };
    const sendState = (cursorPoint) => {
      const { backend, root, local } = served;
      const caret = local.caret();
      port.postMessage({
        kind: "state",
        cursor: cursorPoint === null ? null : backend.resolveCursor(root, cursorPoint.x, cursorPoint.y),
        textControlFocused: local.textControlFocused(),
        caret: caret === null ? null : { control: controlId(caret.control), point: caret.point },
      });
    };
    let lastPoint = null;
    port.onmessage = ({ data }) => {
      try {
        if (data.kind === "size") {
          if (served === null) {
            const view = connect(data);
            served = { ...view, local: localDocumentPort(view.backend, view.root) };
            served.surface.onFrame(() => sendState(lastPoint));
            resolve(Object.freeze({
              resize: (next) => served.surface.viewport.resizeTo(next.width, next.height, next.deviceScale),
              close() {
                port.close();
                controls = new WeakMap();
              },
            }));
          } else {
            served.surface.viewport.resizeTo(data.width, data.height, data.deviceScale);
          }
          return;
        }
        if (served === null) throw new Error(`the page sent ${data.kind} before the canvas size`);
        if (data.kind === "input") {
          if (typeof served.backend[data.method] !== "function") {
            throw new Error(`the document's input has no method ${JSON.stringify(data.method)}`);
          }
          served.backend[data.method](served.root, ...data.arguments_);
          if (["pointerDown", "pointerMove", "pointerUp", "wheel"].includes(data.method)) {
            lastPoint = { x: data.arguments_[0], y: data.arguments_[1] };
          } else if (data.method === "pointerLeave" || data.method === "pointerCancel") {
            lastPoint = null;
          }
          sendState(lastPoint);
          onInput?.();
        } else if (data.kind === "preferences") {
          served.backend.setPreferences(data.preferences);
        } else if (data.kind === "clipboard") {
          const text = served.backend[data.method](served.root);
          port.postMessage({ kind: "clipboard", text });
          sendState(lastPoint);
          onInput?.();
        } else {
          throw new Error(`the page sent an unknown message kind ${JSON.stringify(data.kind)}`);
        }
      } catch (error) {
        if (served === null) reject(error);
        port.postMessage({ kind: "failed", message: error.message, stack: error.stack });
        throw error;
      }
    };
  });
}
