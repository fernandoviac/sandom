# Live list

A release checklist drawn by Sandom on one canvas, changed while it is shown:
two tabs with counts, an add form, and an open and a done list whose items
check off, expand, reorder, and delete. Beside the canvas, a panel in the
page's own HTML shows what each action cost: the frames it rendered, their
damage, how much of the pipeline ran again, and how many nodes the example
created.

## Pattern

A live interface on a canvas, as in the Performance section of the package
README:

- One `createSandomDOM`, one render surface, and one `GPUDevice` for the
  page's life. `createCanvasPresenter` draws each frame's texture to the
  canvas; `bindProjectedInput` with `projectOntoRectangle` routes the
  canvas's pointer, wheel, and keyboard events into the document; the
  surface's loop decides when to render. The device scale is chosen once,
  and a window resize goes through `surface.viewport.resizeTo`.
- The tree is built once and the nodes that change are kept. Each item's
  record holds its `<li>`, checkbox, title button, and control buttons, so
  every action changes only the nodes it is about: checking an item moves the same
  `<li>` to the other list with `insertBefore`; ↑ and ↓ move the same node;
  × removes it; the title toggles one class that shows its details; a tab
  count is one text node whose `data` is set. Nothing is rebuilt.
- Adding a task builds exactly one item subtree, 18 nodes, with the same
  builder as the seed items. The builder counts every node it creates; the
  panel's nodes column is that count, not an estimate.
- Both tab panels stay mounted. Switching tabs toggles `hidden` on the two
  panels and a class on the two tabs, so switching back costs the toggle,
  not a rebuild, and each list keeps its nodes and its scroll position.
- Interaction states change paint-only properties. A button's `:hover`
  changes `color` and `background-color`; the field's focus ring is an
  `outline`. Sandom restyles the retained scene in place for `color`,
  `background-color`, `opacity`, `cursor`, `outline`, and
  `text-decoration`; a `border-color` or a size in a `:hover` or `:focus`
  rule builds the scene again on every pointer crossing.
- One delegated `click` listener and one `change` listener on the root
  handle every item and tab. Each handler names its action before changing
  anything, and the frames that follow are counted against that name.
- The cost panel is outside the rendered document. `presentFrame` records
  each frame's `dirtyRectangles`, `renderTimings`, the host time from the
  surface's `requestFrame` callback to delivery, and the change in
  `surface.frameStageCounters`, then schedules the panel; the panel is
  written at most once per host animation frame. Writing any of it into the
  document from `presentFrame` would dirty the frame just presented and the
  loop would render without end.
- An action that changes nothing renders nothing. ↑ on the first item
  writes a panel row with zero frames, and so does a pointer move that
  crosses no `:hover` rule.

`globalThis.example` exposes read-only state for automation and the
console: the open and done titles and ids in order, the expanded ids, the
active tab, the tab counts, the field's value, the focused element, frame
and node counts, the surface's stage counters, the per-action log, the
presented frames with their damage and timings (`framesAfter(frame)`),
whether every listed `<li>` is the node built for its id
(`identityIntact`), and `rect(selectorOrId)`, a control's document
rectangle with its centre in client coordinates.

## Run

Serve this directory with any static server and open it in a browser with
WebGPU (Chrome or Edge 113 or later, Safari 26):

```sh
npx serve .
# or
python3 -m http.server 8000
```

Sandom and its WebAssembly dependencies load from jsDelivr through the
import map in `index.html`; the Inter face loads from the package's
`test-assets/` directory.

## Expected result

The left of the window is a light checklist, 520 pixels wide: the title
"Release checklist", the Open (22) and Done (3) tabs, a field with an Add
button, and the open list, which scrolls. The right is a dark panel: a
totals line, a line for caret blinks and other frames that reuse the
retained scene, and one row per action, newest first, with its frames,
dirty rectangle count and area in device pixels, the serializations,
layout passes, retained clean frames, in-place restyles, and scroll-only
frames it caused, the nodes the example created, and the last frame's
raster, preparation, and host milliseconds.

Measured in Chrome on an Apple silicon Mac at device scale 1 with a 520 by
820 document, by `test/probes/public-example-live-list.js` in the Sandom
repository, which drives every action with real input (four runs; times
are the range):

| Action | Frames | Dirty rectangles | Serializations | Nodes created | Raster ms |
| --- | ---: | --- | ---: | ---: | ---: |
| First render | 1 | the viewport | 1 | 476 | 169–187 |
| Wheel over the list | 1 | the list's box | 0 (1 scroll-only) | 0 | 2–4 |
| Pointer onto ↑ or ↓ | 1 | four 64-pixel tiles | 0 (1 in-place restyle) | 0 | 1–2 |
| Caret blink | 1 per blink | one tile | 0 (1 retained clean) | 0 | 0.5–1.3 |
| Typing in the field | 1 | the field's tiles | 1 | 0 | 1–4 |
| Tab switch | 1 | 107 of the canvas's 117 tiles | 1 | 0 | 3–14 |
| Expand or collapse | 1 | the list from the item down | 1 | 0 | 3–6 |
| ↓, ×, Add, or the checkbox | 1 | one rectangle, the viewport | 1 | 0, Add 18 | 2–5 |
| ↑ on the first item | 0 | none | 0 | 0 | – |

Layout passes stay at 0 after the first frame: with `createSceneRenderer`
the engine lays out inside its frame and returns the boxes, and
`layoutPasses` counts the surface's separate layout passes. A press that
moves focus to a button can add a frame of its own for the focus change,
with few or no dirty tiles.

The first expand of an item takes 78–93 ms of raster, where collapsing it
and expanding it again take 3–6 ms: it is the first frame that draws that
details text and the title's heavier weight.

Three costs come from the engine rather than the example, and the panel
shows them as they are:

- A tree change (`insertBefore`, `remove`, an added item) repaints the whole
  viewport: the frame's one dirty rectangle is the canvas.
- An element that gains or loses its box, as the details block does on
  expand and collapse, also marks the 64-pixel tile at the document's top
  left corner.
- The first paint-only restyle after a scene build or a scroll-only frame
  builds the scene once (`sceneRestyleRefusedBuild` in the stage counters);
  later ones restyle in place.

Without WebGPU the page shows a one-line notice instead.

## Licences

The example code is under Apache-2.0, the `sandom` package's licence.
Inter, by Rasmus Andersson, is under the SIL Open Font License 1.1; the page
loads it from the package's `test-assets/` directory.
