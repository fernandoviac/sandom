// A code editor rendered entirely by Sandom.
//
// Everything inside the canvas is one Sandom document: the gutter, the
// code, the caret, the selection highlight, the scrollbar and the status
// line. The page's own DOM holds the canvas and a notice for the case where
// there is no WebGPU to render with. Nothing is simulated: a keystroke goes
// through `bindProjectedInput` to the document, and what comes back is the
// engine's editing.
//
// The construction is the web's two-layer editor, because Sandom's editable
// text is the form control and a control cannot carry per-token spans. A
// highlighted <pre> paints the colours; a <textarea> with
// `color: transparent` sits exactly on top of it and owns the caret, the
// selection and the keys. The control's glyphs vanish under
// `color: transparent`, the two layers land on the same pixels, and the
// caret paints the authored `caret-color`.
//
// The control is not the scroller. The highlighted layer must scroll with
// it, so the control is sized to its text and an ordinary block scrolls
// both layers together, which also puts the wheel on Sandom's own scroll
// path.

import {
  bindProjectedInput,
  createCanvasPresenter,
  createRenderSurface,
  createSandomDOM,
  createSceneRenderer,
  loadFont,
  projectOntoRectangle,
} from "sandom";
import { highlightLines } from "./highlight.js";

// The document under edit is this file. It is served beside the page, so
// the fetch works from any static server, and real source is the text an
// editor has to be readable on.
const SOURCE_URL = new URL("./main.js", import.meta.url);

const FONT_SIZE = 13;
const LINE_HEIGHT = 20;
// IBM Plex Mono advances every glyph, upright and italic, 600 of its 1000
// units per em. The stack is sized from it so the control never soft-wraps:
// a wrapped control and an unwrapped ink layer would disagree about every
// line below the wrap.
const ADVANCE = FONT_SIZE * 0.6;
const GUTTER_WIDTH = 64;
const PADDING = 14;
const BAR_HEIGHT = 34;
const STATUS_HEIGHT = 26;

const notice = document.getElementById("notice");
const fail = (message) => {
  notice.textContent = message;
  throw new Error(message);
};

if (!navigator.gpu) {
  fail("This example needs WebGPU, which this browser does not offer.");
}

// Sandom has no system fonts: the faces the stylesheet names are loaded
// from the package's own assets before the first render. Comments are set
// in the italic, so it is a real face rather than a slanted regular.
const fontAsset = (file) =>
  new URL("../test-assets/" + file, import.meta.resolve("sandom"));

const [device, sourceText] = await Promise.all([
  navigator.gpu.requestAdapter().then((adapter) => {
    if (adapter === null) fail("No WebGPU adapter is available.");
    return adapter.requestDevice();
  }),
  fetch(SOURCE_URL).then((response) => {
    if (!response.ok) {
      fail("The document request failed with HTTP " + response.status);
    }
    return response.text();
  }),
  loadFont("IBM Plex Mono", fontAsset("IBMPlexMono-Regular.ttf")),
  loadFont("IBM Plex Mono", fontAsset("IBMPlexMono-Italic.ttf"), {
    style: "italic",
  }),
]);

const canvas = document.createElement("canvas");
document.body.append(canvas);
notice.remove();

// Chosen once for the surface's life: a slow frame needs smaller changes,
// not fewer pixels.
const deviceScale = Math.min(globalThis.devicePixelRatio || 1, 2);
let viewportWidth = Math.max(320, Math.floor(globalThis.innerWidth));
let viewportHeight = Math.max(240, Math.floor(globalThis.innerHeight));

const dom = createSandomDOM({
  viewportW: viewportWidth,
  viewportH: viewportHeight,
  deviceScale,
});

const STYLESHEET = `
  main {
    display: block;
    width: 100%;
    height: 100%;
    background-color: #0b0f14;
    font-family: "IBM Plex Mono";
  }

  .shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  /* The chrome does not shrink. Its flex base is its height, and the body
     below it holds a document thousands of pixels tall: left flexible, the
     shrink algorithm takes it out of the two small items first and the bar
     collapses to its line box. */
  .bar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 14px;
    height: ${BAR_HEIGHT}px;
    padding: 0 14px;
    background-color: #10161e;
    border-bottom: 1px solid #1c242f;
    color: #e6edf3;
    font-size: 12px;
  }

  .bar .path { color: #79c0ff; }
  .bar .hint { margin-left: auto; color: #6e7681; }

  /* One scroller, holding the numbers and the code side by side. Inside
     the scroller the numbers move with the code in the same frame, for no
     JavaScript at all, and sticky positioning keeps them in place when a
     long line scrolls the code sideways. */
  .body {
    display: flex;
    /* Basis 0, not auto: the content is the whole document, and an auto
       basis makes this item's flex base thousands of pixels tall. */
    flex: 1 1 0;
    min-height: 0;
  }

  .pane {
    display: flex;
    align-items: flex-start;
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: #30363d #0b0f14;
  }

  .numbers {
    position: sticky;
    left: 0;
    display: block;
    flex: 0 0 ${GUTTER_WIDTH}px;
    width: ${GUTTER_WIDTH}px;
    padding-top: ${PADDING}px;
    background-color: #0d131a;
    border-right: 1px solid #1c242f;
  }

  .number {
    display: block;
    height: ${LINE_HEIGHT}px;
    padding-right: 12px;
    color: #4d5866;
    font-size: ${FONT_SIZE}px;
    line-height: ${LINE_HEIGHT}px;
    text-align: right;
  }

  .number.current { color: #e6edf3; background-color: #161d26; }

  .stack {
    position: relative;
    display: block;
  }

  /* The caret's line, painted under both text layers. */
  .current-line {
    position: absolute;
    left: 0;
    display: block;
    height: ${LINE_HEIGHT}px;
    background-color: #161d26;
  }

  .ink, .control {
    position: absolute;
    left: 0;
    top: ${PADDING}px;
    display: block;
    margin: 0;
    padding: 0 ${PADDING}px;
    border: 0;
    /* Both layers are sized to the same box as the stack they sit in, so
       the padding cannot push one of them wider than the other. */
    box-sizing: border-box;
    background-color: transparent;
    font-family: "IBM Plex Mono";
    font-size: ${FONT_SIZE}px;
    line-height: ${LINE_HEIGHT}px;
    white-space: pre;
  }

  .ink { color: #c9d1d9; }

  /* The control carries no ink of its own: the layer beneath it is the text
     a reader sees, and two layers painting the same glyphs is visible as a
     hollow, embossed letter. It keeps the caret, which the document
     colours: without an authored caret-color the caret takes the element's
     own colour, and a transparent control has none, so the caret would be
     invisible on a dark editor. */
  .control {
    color: transparent;
    caret-color: #58a6ff;
    outline: none;
    resize: none;
    overflow: hidden;
  }

  /* One element per line, exactly one line tall: the ink layer's lines and
     the control's own line boxes have to agree, or a glyph sits beside the
     caret that is supposed to be in front of it. */
  .line {
    display: block;
    height: ${LINE_HEIGHT}px;
  }

  .t-keyword { color: #ff7b72; }
  .t-number { color: #79c0ff; }
  .t-string { color: #a5d6ff; }
  .t-comment { color: #8b949e; font-style: italic; }
  .t-function { color: #d2a8ff; }
  .t-punct { color: #8b949e; }
  .t-css .t-selector { color: #7ee787; }
  .t-css .t-property { color: #79c0ff; }
  .t-css .t-value { color: #a5d6ff; }

  .status {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 18px;
    height: ${STATUS_HEIGHT}px;
    padding: 0 14px;
    background-color: #10161e;
    border-top: 1px solid #1c242f;
    color: #8b949e;
    font-size: 11px;
  }

  .status .cost { margin-left: auto; }
  .status .slow { color: #ffa657; }
`;

const element = (tag, className, parent) => {
  const node = dom.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
};

// The root joins the document before the sheet goes in: a <style> applies
// only to a connected tree.
const root = dom.createElement("main");
dom.document.appendChild(root);
element("style", null, root).textContent = STYLESHEET;

const shell = element("div", "shell", root);

const bar = element("div", "bar", shell);
element("span", "path", bar).textContent = "main.js";
element("span", "hint", bar).textContent =
  "click to place the caret; every keystroke is the engine's";

const body = element("div", "body", shell);
const pane = element("div", "pane", body);
const numbers = element("div", "numbers", pane);
const stack = element("div", "stack", pane);
const currentLine = element("div", "current-line", stack);
const ink = element("pre", "ink", stack);
const control = element("textarea", "control", stack);

const status = element("div", "status", shell);
const caretReadout = element("span", "caret", status);
const selectionReadout = element("span", "selection", status);
const documentReadout = element("span", "document", status);
const costReadout = element("span", "cost", status);

// The gutter's line numbers. Changed only when the line count changes: an
// edit inside a line must not rewrite a thousand nodes.
let numberCount = 0;
const numberNodes = [];
function fitNumbers(lineCount) {
  for (let i = numberCount; i < lineCount; i++) {
    const node = element("div", "number", numbers);
    node.textContent = String(i + 1);
    numberNodes.push(node);
  }
  for (let i = lineCount; i < numberCount; i++) {
    numberNodes[i].remove();
  }
  if (lineCount < numberCount) numberNodes.length = lineCount;
  numberCount = lineCount;
}

let currentNumber = null;

// The ink layer is one element per line, and an edit rewrites only the
// lines that changed. Rebuilding the whole highlighted layer per keystroke
// would make every character cost the whole file. The diff is a common
// prefix and suffix with the middle spliced, so typing inside a line
// touches one element and inserting a line touches two.
const lineNodes = [];
let lineHtml = [];

function applyLines(html) {
  let prefix = 0;
  while (
    prefix < html.length && prefix < lineHtml.length &&
    html[prefix] === lineHtml[prefix]
  ) prefix++;
  let suffix = 0;
  while (
    suffix < html.length - prefix && suffix < lineHtml.length - prefix &&
    html[html.length - 1 - suffix] === lineHtml[lineHtml.length - 1 - suffix]
  ) suffix++;
  const oldMiddle = lineHtml.length - prefix - suffix;
  const newMiddle = html.length - prefix - suffix;
  const shared = Math.min(oldMiddle, newMiddle);
  for (let i = 0; i < shared; i++) {
    lineNodes[prefix + i].innerHTML = html[prefix + i];
  }
  if (newMiddle > oldMiddle) {
    const before = lineNodes[prefix + shared] ?? null;
    const added = [];
    for (let i = shared; i < newMiddle; i++) {
      const node = dom.createElement("div");
      node.className = "line";
      node.innerHTML = html[prefix + i];
      ink.insertBefore(node, before);
      added.push(node);
    }
    lineNodes.splice(prefix + shared, 0, ...added);
  } else if (oldMiddle > newMiddle) {
    const removed = lineNodes.splice(prefix + shared, oldMiddle - newMiddle);
    for (const node of removed) node.remove();
  }
  lineHtml = html;
}

// One edit's worth of work: re-highlight, resize the layers, renumber.
// The control's value is the source of truth; the engine owns it.
function synchronize() {
  const text = control.value;
  const lines = text.split("\n");
  let longest = 0;
  for (const line of lines) if (line.length > longest) longest = line.length;
  const contentWidth = Math.ceil(longest * ADVANCE) + PADDING * 2 + 2;
  const contentHeight = lines.length * LINE_HEIGHT;

  applyLines(highlightLines(text));
  ink.style.width = `${contentWidth}px`;
  ink.style.height = `${contentHeight}px`;
  // The control is sized to its text, never scrolled: the pane scrolls.
  control.style.width = `${contentWidth}px`;
  control.style.height = `${contentHeight}px`;
  stack.style.width = `${contentWidth}px`;
  stack.style.height = `${contentHeight + PADDING * 2}px`;
  currentLine.style.width = `${contentWidth}px`;

  fitNumbers(lines.length);
  return lines.length;
}

// Where the caret is, in the engine's answer. `selectionStart` is the
// control's own state, so the line and column below are what the engine
// believes, not what the page hoped.
function caretPosition(text) {
  const offset = control.selectionStart ?? 0;
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

function markCaretLine(line) {
  currentLine.style.top = `${PADDING + line * LINE_HEIGHT}px`;
  const node = numberNodes[line] ?? null;
  if (node === currentNumber) return;
  currentNumber?.classList.remove("current");
  node?.classList.add("current");
  currentNumber = node;
}

// Runs after every input record, but only an edit or a caret or selection
// change is news. Hover, wheel and key releases arrive here too, and the
// status line is part of the document: rewriting it per pointer move would
// render a frame per move.
let lastText = null;
let lastStart = -1;
let lastEnd = -1;
let caret = { line: 0, column: 0 };
let statusWrites = 0;
function refresh() {
  const text = control.value;
  const start = control.selectionStart ?? 0;
  const end = control.selectionEnd ?? 0;
  if (text === lastText && start === lastStart && end === lastEnd) return;
  lastStart = start;
  lastEnd = end;
  if (text !== lastText) {
    lastText = text;
    documentReadout.textContent = `${synchronize()} lines`;
  }
  caret = caretPosition(text);
  markCaretLine(caret.line);
  const selectionLength = Math.abs(end - start);
  caretReadout.textContent = `line ${caret.line + 1}, column ${caret.column + 1}`;
  selectionReadout.textContent = selectionLength === 0
    ? "no selection"
    : `${selectionLength} selected`;
  writeCostReadout();
  statusWrites++;
}

control.value = sourceText;

// Presentation: the frame's texture is drawn straight to the canvas on the
// device Sandom renders with. No pixels are read back.
const presenter = createCanvasPresenter({ canvas, device });
let frames = 0;
let lastFrameMilliseconds = 0;
let lastDirtyRectangles = 0;
let renderStarted = 0;

function present(frame) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  presenter.present(frame.textureImage);
  frames++;
  lastFrameMilliseconds = performance.now() - renderStarted;
  lastDirtyRectangles = frame.dirtyRectangles.length;
  // Deliberately not written to the status line here. The status line is
  // part of the rendered document, so reporting a frame's cost from inside
  // the delivery would dirty the document the report describes, and the
  // loop would render without end. The readout is written from the input
  // handler instead, in the same change as the caret it sits beside.
}

function writeCostReadout() {
  if (frames === 0) return;
  costReadout.className = lastFrameMilliseconds > 16 ? "cost slow" : "cost";
  costReadout.textContent = `${lastFrameMilliseconds.toFixed(1)} ms · ${lastDirtyRectangles} ${
    lastDirtyRectangles === 1 ? "rect" : "rects"
  } · frame ${frames}`;
}

const surface = createRenderSurface(root, {
  viewportWidth,
  viewportHeight,
  deviceScale,
  createPersistentRenderer: (options) =>
    createSceneRenderer({ ...options, graphicsDevice: device }),
  presentFrame: present,
  // Host time for the cost readout: from the frame callback to delivery.
  requestFrame: (callback) =>
    requestAnimationFrame((time) => {
      renderStarted = performance.now();
      callback(time);
    }),
  cancelFrame: (request) => cancelAnimationFrame(request),
});

// Input. The canvas is the viewport, so the projection is its client box
// scaled to the document's viewport; it is rebuilt when the viewport is.
let projection = projectOntoRectangle(canvas, {
  width: viewportWidth,
  height: viewportHeight,
});

const input = bindProjectedInput({
  host: canvas,
  backend: dom,
  root,
  project: (event) => projection(event),
  unproject: (point, target) => projection.unproject(point, target),
  onInput: refresh,
  label: "Code editor",
});

// A focused editor from the first frame: the caret is the page's own
// indication that typing goes somewhere.
input.focus();
control.focus();
control.setSelectionRange(0, 0);
refresh();

renderStarted = performance.now();
await surface.renderNow();
surface.start();

// One surface for the page's life: a resize changes its viewport, never
// replaces it.
globalThis.addEventListener("resize", () => {
  const width = Math.max(320, Math.floor(globalThis.innerWidth));
  const height = Math.max(240, Math.floor(globalThis.innerHeight));
  if (width === viewportWidth && height === viewportHeight) return;
  viewportWidth = width;
  viewportHeight = height;
  projection = projectOntoRectangle(canvas, { width, height });
  surface.viewport.resizeTo(width, height, deviceScale);
});

// Read-only state of the Sandom document, read by automation and handy in
// the console.
globalThis.example = Object.freeze({
  get text() {
    return control.value;
  },
  // One-based, as the status line shows them.
  get line() {
    return caret.line + 1;
  },
  get column() {
    return caret.column + 1;
  },
  get caretReadout() {
    return caretReadout.textContent;
  },
  inkLine: (number) => lineNodes[number - 1]?.textContent ?? null,
  get scrollTop() {
    return pane.scrollTop;
  },
  get frames() {
    return frames;
  },
  // Times the status line was rewritten: input that changes nothing leaves
  // it, and the document, alone.
  get statusWrites() {
    return statusWrites;
  },
});
