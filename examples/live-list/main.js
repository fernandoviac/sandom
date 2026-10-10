// A live task list rendered by Sandom, with its cost beside it.
//
// Everything inside the canvas is one Sandom document: the header, the two
// tabs with their counts, the add form, and the two lists. Every action is
// real input on the canvas, routed by `bindProjectedInput` to the document,
// where ordinary DOM event listeners change the nodes the action touched
// and nothing else. The surface's loop renders the frame that change asks
// for, and an action that changes nothing renders nothing.
//
// The panel to the right is the page's own DOM, outside the rendered
// document. It shows, per action, the frames the action cost: their damage,
// how much of the pipeline ran again, how many nodes the example created,
// and the last frame's timings.

import {
  bindProjectedInput,
  createCanvasPresenter,
  createRenderSurface,
  createSandomDOM,
  createSceneRenderer,
  loadFont,
  projectOntoRectangle,
} from "sandom";
import { SEED_TASKS } from "./tasks.js";

// The document is a fixed-width column; its height follows the window.
const DOCUMENT_WIDTH = 520;
// Rows kept in the cost panel; the whole log stays in `example.log`.
const PANEL_ROWS = 16;
const LOG_LIMIT = 500;

const notice = document.getElementById("notice");
const fail = (message) => {
  notice.textContent = message;
  throw new Error(message);
};

if (!navigator.gpu) {
  fail("This example needs WebGPU, which this browser does not offer.");
}

// Sandom has no system fonts: the face the stylesheet names is loaded from
// the package's own assets before the first render. Inter is variable, so
// one file covers 400 and 600.
const fontAsset = (file) =>
  new URL("../test-assets/" + file, import.meta.resolve("sandom"));

const [device] = await Promise.all([
  navigator.gpu.requestAdapter().then((adapter) => {
    if (adapter === null) fail("No WebGPU adapter is available.");
    return adapter.requestDevice();
  }),
  loadFont("Inter", fontAsset("Inter-Variable.ttf"), { weight: [100, 900] }),
]);

const costPanel = document.getElementById("cost");
const canvas = document.createElement("canvas");
costPanel.before(canvas);
notice.remove();

// Chosen once for the surface's life: a slow frame needs smaller changes,
// not fewer pixels.
const deviceScale = Math.min(globalThis.devicePixelRatio || 1, 2);
const viewportWidth = DOCUMENT_WIDTH;
let viewportHeight = Math.max(320, Math.floor(globalThis.innerHeight));

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
    background-color: #f6f8fa;
    color: #1f2328;
    font-family: "Inter";
    font-size: 14px;
  }

  .app {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  .top {
    flex: 0 0 auto;
    padding: 16px 18px 0;
    background-color: #ffffff;
    border-bottom: 1px solid #d8dee4;
  }

  h1 {
    margin: 0 0 10px;
    font-size: 18px;
    font-weight: 600;
  }

  .tabs {
    display: flex;
    gap: 4px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background-color: transparent;
    color: #59636e;
    font-family: "Inter";
    font-size: 14px;
  }

  .tab:hover { color: #1f2328; }

  .tab.selected {
    color: #1f2328;
    font-weight: 600;
    border-bottom-color: #fd8c73;
  }

  .count {
    padding: 1px 7px;
    border-radius: 10px;
    background-color: #eff2f5;
    font-size: 12px;
    font-weight: 600;
  }

  .add {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    margin: 0;
    padding: 12px 18px;
    background-color: #ffffff;
    border-bottom: 1px solid #d8dee4;
  }

  /* No authored color: Sandom paints the placeholder in the control's own
     authored color when it has one, and placeholder gray otherwise. */
  .field {
    flex: 1 1 0;
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background-color: #ffffff;
    caret-color: #0969da;
    font-family: "Inter";
    font-size: 14px;
  }

  /* An outline, not a border-color: outline is paint-only, so focusing
     and leaving the field restyles the retained scene in place. */
  .field:focus { outline: 2px solid #0969da; }

  .submit {
    height: 34px;
    padding: 0 16px;
    border: 0;
    border-radius: 6px;
    background-color: #1f883d;
    color: #ffffff;
    font-family: "Inter";
    font-size: 14px;
    font-weight: 600;
  }

  .submit:hover { background-color: #1a7f37; }

  /* Each tab's list is its own scroller, so each keeps its scroll
     position while the other is shown. */
  .panel {
    display: block;
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
  }

  /* An authored display would override the user agent's [hidden] rule. */
  .panel[hidden] { display: none; }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: block;
    background-color: #ffffff;
    border-bottom: 1px solid #eaeef2;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 12px 0 18px;
  }

  .check {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0 4px 0 0;
    accent-color: #0969da;
  }

  .title {
    flex: 1 1 0;
    min-width: 0;
    padding: 0;
    border: 0;
    background-color: transparent;
    color: #1f2328;
    font-family: "Inter";
    font-size: 14px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
  }

  .item.expanded .title { font-weight: 600; }
  .done-list .title { color: #818b98; text-decoration: line-through; }

  .move {
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background-color: transparent;
    color: #59636e;
    font-family: "Inter";
    font-size: 15px;
  }

  /* Hover changes paint-only properties (color, background-color), so the
     engine restyles the retained scene in place. A border-color here
     would rebuild the scene on every pointer crossing. */
  .move:hover {
    background-color: #eff2f5;
    color: #1f2328;
  }

  .remove:hover { color: #cf222e; }

  .details {
    display: none;
    padding: 0 18px 12px 46px;
    color: #59636e;
    font-size: 13px;
    line-height: 20px;
  }

  .item.expanded .details { display: block; }
`;

// Every node the example creates goes through these two, so the count of
// nodes an action created is the example's own, not an estimate.
let nodesCreated = 0;
let current = null;
const element = (tag, className, parent) => {
  const node = dom.createElement(tag);
  nodesCreated++;
  if (current !== null) current.nodes++;
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
};
const text = (data, parent) => {
  const node = dom.createTextNode(data);
  nodesCreated++;
  if (current !== null) current.nodes++;
  parent.appendChild(node);
  return node;
};

// ---------------------------------------------------------------- cost log

// One entry per action, opened by the handler that performs it. Presented
// frames and the surface's stage counters are attributed to the entry open
// when they arrive. Frames that reuse the retained scene verbatim (a caret
// blink) go to the ambient entry instead, so a blinking caret does not
// inflate the action typed before it.
const COUNTERS = [
  "serializations",
  "layoutPasses",
  "retainedCleanFrames",
  "sceneRestyleFrames",
  "scrollOnlyFrames",
];
const newEntry = (action) => ({
  action,
  frames: 0,
  dirtyRectangleCount: 0,
  dirtyArea: 0,
  dirtyRectangles: [],
  counters: Object.fromEntries(COUNTERS.map((name) => [name, 0])),
  nodes: 0,
  rasterMilliseconds: null,
  preparationMilliseconds: null,
  hostMilliseconds: null,
});
const log = [];
// The last presented frames, one record each, for automation.
const frameLog = [];
const FRAME_LOG_LIMIT = 200;
const ambient = newEntry("caret blink and other retained-scene frames");
let surface = null;
let lastCounters = null;
let panelScheduled = false;

// Stage counters accumulated since the last reading, into `entry`.
function attributeCounters(entry, counters = surface?.frameStageCounters) {
  if (counters === undefined) return null;
  const delta = {};
  for (const name of COUNTERS) {
    delta[name] = counters[name] - (lastCounters?.[name] ?? 0);
    if (entry !== null) entry.counters[name] += delta[name];
  }
  lastCounters = counters;
  return delta;
}

// Opens the entry for an action. Consecutive pointer, scroll, and typing
// records are one gesture and share one entry.
function begin(action, { coalesce = false } = {}) {
  if (coalesce && current?.action === action) return;
  attributeCounters(current);
  current = newEntry(action);
  log.push(current);
  if (log.length > LOG_LIMIT) log.shift();
  schedulePanel();
}

// The exact area covered by a frame's damage, overlaps counted once.
function unionArea(rectangles) {
  if (rectangles.length === 0) return 0;
  const xs = [...new Set(rectangles.flatMap((r) => [r.x, r.x + r.width]))]
    .sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const spans = rectangles
      .filter((r) => r.x <= xs[i] && r.x + r.width >= xs[i + 1])
      .map((r) => [r.y, r.y + r.height])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let top = spans.length > 0 ? spans[0][0] : 0;
    let bottom = top;
    for (const [y0, y1] of spans) {
      if (y0 > bottom) {
        covered += bottom - top;
        top = y0;
        bottom = y1;
      } else if (y1 > bottom) bottom = y1;
    }
    covered += bottom - top;
    area += covered * (xs[i + 1] - xs[i]);
  }
  return area;
}

// ---------------------------------------------------------------- document

// The root joins the document before the sheet goes in: a <style> applies
// only to a connected tree.
begin("first render");
const root = element("main");
dom.document.appendChild(root);
text(STYLESHEET, element("style", null, root));

const app = element("div", "app", root);
const top = element("header", "top", app);
text("Release checklist", element("h1", null, top));
const tabs = element("div", "tabs", top);
tabs.setAttribute("role", "tablist");

// A tab's count is one text node; a count change sets its data.
function buildTab(label, selected) {
  const tab = element("button", selected ? "tab selected" : "tab", tabs);
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(selected));
  text(label, element("span", null, tab));
  const count = text("0", element("span", "count", tab));
  return { tab, count };
}
const openTab = buildTab("Open", true);
const doneTab = buildTab("Done", false);

const form = element("form", "add", app);
const field = element("input", "field", form);
field.type = "text";
field.setAttribute("placeholder", "Add a task and press Enter");
field.setAttribute("aria-label", "Task title");
const submit = element("button", "submit", form);
submit.type = "submit";
text("Add", submit);

// Both panels stay mounted for the page's life: a tab switch toggles
// `hidden`, so switching back costs the switch, not a rebuild.
const buildPanel = (className, hidden) => {
  const panel = element("section", "panel", app);
  panel.setAttribute("role", "tabpanel");
  panel.hidden = hidden;
  return { panel, list: element("ul", "list " + className, panel) };
};
const { panel: openPanel, list: openList } = buildPanel("open-list", false);
const { panel: donePanel, list: doneList } = buildPanel("done-list", true);

// Each item is built once and kept. The record holds the nodes later
// actions change, so no action looks them up or rebuilds them.
const items = new Map(); // <li> -> record
const itemsById = new Map();
let nextId = 1;
function buildItem({ title, owner, due, note, done }) {
  const id = nextId++;
  const li = element("li", "item");
  li.dataset.id = String(id);
  const row = element("div", "row", li);
  const check = element("input", "check", row);
  check.type = "checkbox";
  check.checked = done;
  check.setAttribute("aria-label", "Done");
  const titleButton = element("button", "title", row);
  titleButton.type = "button";
  text(title, titleButton);
  const control = (className, glyph, label) => {
    const button = element("button", className, row);
    button.type = "button";
    button.setAttribute("aria-label", label);
    text(glyph, button);
    return button;
  };
  const up = control("move up", "↑", "Move up");
  const down = control("move down", "↓", "Move down");
  const remove = control("move remove", "×", "Remove");
  const details = element("div", "details", li);
  for (const line of [`Owner: ${owner}`, `Due: ${due}`, note]) {
    text(line, element("div", null, details));
  }
  const record = { id, title, li, check, titleButton, up, down, remove };
  items.set(li, record);
  itemsById.set(id, record);
  return record;
}

for (const task of SEED_TASKS) {
  (task.done ? doneList : openList).appendChild(buildItem(task).li);
}

const countTabs = () => {
  for (const [{ count }, list] of [[openTab, openList], [doneTab, doneList]]) {
    const value = String(list.childElementCount);
    if (count.data !== value) count.data = value;
  }
};
countTabs();

// ---------------------------------------------------------------- actions

let activeTab = "open";
function showTab(name) {
  activeTab = name;
  for (const [{ tab }, panel, tabName] of [
    [openTab, openPanel, "open"],
    [doneTab, donePanel, "done"],
  ]) {
    const selected = tabName === name;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
    panel.hidden = !selected;
  }
}

function selectTab(name) {
  if (name === activeTab) {
    begin(`tab ${name} (already shown)`);
    return;
  }
  begin(`tab ${name}`);
  showTab(name);
}

// Checking moves the same <li> to the top of the other list; its title
// style follows from the list it sits in.
function setDone(record, done) {
  begin(done ? "complete" : "reopen");
  const list = done ? doneList : openList;
  list.insertBefore(record.li, list.firstElementChild);
  countTabs();
}

function toggleExpanded(record) {
  const expanded = !record.li.classList.contains("expanded");
  begin(expanded ? "expand" : "collapse");
  record.li.classList.toggle("expanded", expanded);
}

// Reordering moves the same node; an item already at the end stays, and
// that action renders nothing.
function moveUp(record) {
  const previous = record.li.previousElementSibling;
  begin(previous ? "move up" : "move up (already first)");
  if (previous) record.li.parentNode.insertBefore(record.li, previous);
}

function moveDown(record) {
  const next = record.li.nextElementSibling;
  begin(next ? "move down" : "move down (already last)");
  if (next) record.li.parentNode.insertBefore(record.li, next.nextElementSibling);
}

function removeItem(record) {
  begin("remove");
  record.li.remove();
  items.delete(record.li);
  itemsById.delete(record.id);
  countTabs();
}

// One delegated listener for every click in the document.
root.addEventListener("click", (event) => {
  const target = event.target.nodeType === 1
    ? event.target
    : event.target.parentElement;
  const tab = target?.closest(".tab");
  if (tab) {
    selectTab(tab === openTab.tab ? "open" : "done");
    return;
  }
  const button = target?.closest("button");
  const record = button && items.get(button.closest(".item"));
  if (!record) return;
  if (button === record.titleButton) toggleExpanded(record);
  else if (button === record.up) moveUp(record);
  else if (button === record.down) moveDown(record);
  else if (button === record.remove) removeItem(record);
});

root.addEventListener("change", (event) => {
  const record = items.get(event.target.closest?.(".item"));
  if (record && event.target === record.check) setDone(record, record.check.checked);
});

// Enter in the field submits the form, as the Add button does. The added
// item is one subtree built by the same builder as the seed items.
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = field.value.trim();
  begin(title ? "add" : "add (empty)");
  if (!title) return;
  const record = buildItem({
    title,
    owner: "you",
    due: "not set",
    note: "Added from the form.",
    done: false,
  });
  openList.insertBefore(record.li, openList.firstElementChild);
  field.value = "";
  // Sandom keeps the selection offsets when a script sets `value`, where
  // the HTML standard moves them to the end of the value just set; without
  // this the caret would sit inside the placeholder.
  field.setSelectionRange(0, 0);
  countTabs();
  if (activeTab !== "open") showTab("open");
});

// Records that are not example actions still get an entry, so the panel
// shows what a pointer move, a wheel turn, or typing cost on their own.
root.addEventListener("pointerover", () => begin("pointer", { coalesce: true }));
root.addEventListener("focusin", (event) => {
  if (event.target === field) begin("focus field");
});
field.addEventListener("input", () => begin("type", { coalesce: true }));
// The wheel opens the entry before the frame that scrolls; the scroll
// event, which a frame dispatches, covers a scrollbar drag.
root.addEventListener("wheel", () => begin("scroll", { coalesce: true }), { passive: true });
for (const panel of [openPanel, donePanel]) {
  panel.addEventListener("scroll", () => begin("scroll", { coalesce: true }));
}

// ---------------------------------------------------------------- frames

// Presentation: the frame's texture is drawn straight to the canvas on the
// device Sandom renders with. No pixels are read back.
const presenter = createCanvasPresenter({ canvas, device });
let frames = 0;
let frameStartedAt = 0;

// Records the frame's cost and schedules the panel. Never writes to the
// rendered document: a change here dirties the frame just presented and
// the loop renders without end.
function present(frame) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  presenter.present(frame.textureImage);
  const hostMilliseconds = performance.now() - frameStartedAt;
  frames++;
  // A frame whose only stage was reusing the retained scene is a caret
  // blink or a scrollbar fade, not the work of the open action.
  const counters = surface.frameStageCounters;
  const retainedOnly =
    counters.retainedCleanFrames > (lastCounters?.retainedCleanFrames ?? 0) &&
    COUNTERS.every((name) =>
      name === "retainedCleanFrames" ||
      counters[name] === (lastCounters?.[name] ?? 0)
    );
  const entry = retainedOnly ? ambient : current;
  const delta = attributeCounters(entry, counters);
  const { rasterMilliseconds, preparationMilliseconds } = frame.renderTimings;
  entry.frames++;
  entry.dirtyRectangleCount += frame.dirtyRectangles.length;
  entry.dirtyArea += unionArea(frame.dirtyRectangles);
  for (const rectangle of frame.dirtyRectangles) {
    if (entry.dirtyRectangles.length < 64) entry.dirtyRectangles.push(rectangle);
  }
  entry.rasterMilliseconds = rasterMilliseconds;
  entry.preparationMilliseconds = preparationMilliseconds;
  entry.hostMilliseconds = hostMilliseconds;
  frameLog.push({
    frame: frames,
    action: entry.action,
    dirtyRectangles: frame.dirtyRectangles,
    counters: delta,
    renderTimings: frame.renderTimings,
    hostMilliseconds,
  });
  if (frameLog.length > FRAME_LOG_LIMIT) frameLog.shift();
  schedulePanel();
}

surface = createRenderSurface(root, {
  viewportWidth,
  viewportHeight,
  deviceScale,
  createPersistentRenderer: (options) =>
    createSceneRenderer({ ...options, graphicsDevice: device }),
  presentFrame: present,
  // Host time for the panel: from the frame callback to delivery.
  requestFrame: (callback) =>
    requestAnimationFrame((time) => {
      frameStartedAt = performance.now();
      callback(time);
    }),
  cancelFrame: (request) => cancelAnimationFrame(request),
});

// ---------------------------------------------------------------- panel

// The panel is page DOM, written at most once per host animation frame
// however many frames and actions arrived since the last write.
const totals = document.getElementById("totals");
const ambientLine = document.getElementById("ambient");
const tableRows = [];
for (let i = 0; i < PANEL_ROWS; i++) {
  const row = document.createElement("tr");
  const cells = [];
  for (let j = 0; j < 13; j++) cells.push(row.appendChild(document.createElement("td")));
  row.hidden = true;
  document.getElementById("rows").append(row);
  tableRows.push(cells);
}
const milliseconds = (value) => value === null ? "–" : value.toFixed(1);
const setCell = (cell, value) => {
  const content = String(value);
  if (cell.textContent !== content) cell.textContent = content;
  const zero = value === 0 || value === "–";
  if (cell.classList.contains("zero") !== zero) cell.classList.toggle("zero", zero);
};

function schedulePanel() {
  if (panelScheduled) return;
  panelScheduled = true;
  requestAnimationFrame(writePanel);
}

function writePanel() {
  panelScheduled = false;
  const counters = surface.frameStageCounters;
  totals.textContent = `${frames} frames · ${counters.serializations} serializations · ` +
    `${counters.layoutPasses} layout passes · ${counters.retainedCleanFrames} retained clean · ` +
    `${counters.sceneRestyleFrames} restyled in place · ${counters.scrollOnlyFrames} scroll-only · ` +
    `${nodesCreated} nodes created`;
  ambientLine.textContent = `Caret blink and other retained-scene frames: ${ambient.frames}` +
    (ambient.frames === 0 ? "" : `, last raster ${milliseconds(ambient.rasterMilliseconds)} ms, ` +
      `host ${milliseconds(ambient.hostMilliseconds)} ms`);
  const shown = log.slice(-PANEL_ROWS).reverse();
  tableRows.forEach((cells, index) => {
    const entry = shown[index];
    cells[0].parentElement.hidden = entry === undefined;
    if (entry === undefined) return;
    const values = [
      entry.action,
      entry.frames,
      entry.dirtyRectangleCount,
      entry.dirtyArea,
      entry.counters.serializations,
      entry.counters.layoutPasses,
      entry.counters.retainedCleanFrames,
      entry.counters.sceneRestyleFrames,
      entry.counters.scrollOnlyFrames,
      entry.nodes,
      milliseconds(entry.rasterMilliseconds),
      milliseconds(entry.preparationMilliseconds),
      milliseconds(entry.hostMilliseconds),
    ];
    values.forEach((value, column) => setCell(cells[column], value));
  });
}

// ---------------------------------------------------------------- input

// The canvas is the viewport, so the projection is its client box scaled
// to the document's viewport; it is rebuilt when the viewport is.
let projection = projectOntoRectangle(canvas, {
  width: viewportWidth,
  height: viewportHeight,
});

bindProjectedInput({
  host: canvas,
  backend: dom,
  root,
  project: (event) => projection(event),
  unproject: (point, target) => projection.unproject(point, target),
  label: "Release checklist",
});

costPanel.hidden = false;
frameStartedAt = performance.now();
await surface.renderNow();
surface.start();

// One surface for the page's life: a resize changes its viewport, never
// replaces it.
globalThis.addEventListener("resize", () => {
  const height = Math.max(320, Math.floor(globalThis.innerHeight));
  if (height === viewportHeight) return;
  viewportHeight = height;
  projection = projectOntoRectangle(canvas, { width: viewportWidth, height });
  surface.viewport.resizeTo(viewportWidth, height, deviceScale);
});

// ---------------------------------------------------------------- state

const titlesOf = (list) => [...list.children].map((li) => items.get(li).title);
const idsOf = (list) => [...list.children].map((li) => items.get(li).id);
const copyEntry = (entry) => ({
  ...entry,
  counters: { ...entry.counters },
  dirtyRectangles: entry.dirtyRectangles.map((r) => ({ ...r })),
});

// Read-only state of the Sandom document and its cost, read by automation
// and handy in the console.
globalThis.example = Object.freeze({
  get open() {
    return titlesOf(openList);
  },
  get done() {
    return titlesOf(doneList);
  },
  get openIds() {
    return idsOf(openList);
  },
  get doneIds() {
    return idsOf(doneList);
  },
  get expanded() {
    return [...items.values()]
      .filter((record) => record.li.classList.contains("expanded"))
      .map((record) => record.id);
  },
  get activeTab() {
    return activeTab;
  },
  get fieldValue() {
    return field.value;
  },
  // The document's focused element, as `tag.class`, or null.
  get focused() {
    const active = dom.document.activeElement;
    if (!active || active === root || active.localName === "body") return null;
    return active.localName + (active.className ? "." + active.className.split(" ").join(".") : "");
  },
  get counts() {
    return { open: openTab.count.data, done: doneTab.count.data };
  },
  get scrollTop() {
    return { open: openPanel.scrollTop, done: donePanel.scrollTop };
  },
  get frames() {
    return frames;
  },
  get nodesCreated() {
    return nodesCreated;
  },
  get counters() {
    return { ...surface.frameStageCounters };
  },
  get log() {
    return log.map(copyEntry);
  },
  get ambient() {
    return copyEntry(ambient);
  },
  // Presented frames after `frame`: action, damage, counter deltas, and
  // timings of each.
  framesAfter(frame) {
    return frameLog
      .filter((record) => record.frame > frame)
      .map((record) => ({
        ...record,
        dirtyRectangles: record.dirtyRectangles.map((r) => ({ ...r })),
        counters: { ...record.counters },
        renderTimings: { ...record.renderTimings, svgImages: undefined },
      }));
  },
  // Every <li> in both lists is the node built for its id: no action
  // replaced one.
  get identityIntact() {
    return [...openList.children, ...doneList.children].every((li) =>
      itemsById.get(items.get(li)?.id)?.li === li &&
      li.dataset.id === String(items.get(li).id)
    );
  },
  // A control's document rectangle in CSS pixels, and its centre in client
  // coordinates. `target` is a selector, or an item id for the whole row;
  // an item's controls are `[data-id="3"] .up` and so on.
  rect(target) {
    const node = typeof target === "number"
      ? itemsById.get(target)?.li
      : root.querySelector(target);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const centre = projection.unproject({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    });
    return {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
      clientX: centre?.x ?? null,
      clientY: centre?.y ?? null,
    };
  },
});
