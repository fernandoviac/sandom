# Code editor

A code editor drawn entirely by Sandom on one canvas: a line-number gutter,
syntax-highlighted code, the caret and selection, a scrollbar, and a status
line. The file it edits is its own `main.js`, fetched from beside the page.

## Pattern

A live interface on a canvas, as in the Performance section of the package
README:

- One render surface for the page's life. `createCanvasPresenter` draws each
  frame's texture to the canvas on the same `GPUDevice` Sandom renders with;
  no pixels are read back.
- `bindProjectedInput` with `projectOntoRectangle` routes the canvas's
  pointer, wheel, and keyboard events into the document. Typing, caret
  movement, selection, and scrolling are Sandom's own editing in a
  `<textarea>`; the page only reacts to what the control's value and
  selection became.
- Two layers: a highlighted `<pre>` paints the colours, and a transparent
  `<textarea>` on top of it owns the caret, selection, and keys. Both are
  sized to the text, so the control never wraps or scrolls, and one ordinary
  scroll container moves both layers and the gutter in the same frame.
- Only changed nodes are rewritten. The ink layer is one element per line;
  an edit diffs the highlighted lines by common prefix and suffix, so typing
  inside a line rewrites one element. Gutter numbers change only when the
  line count does, and the current-line marker is a style and a class.
- The status line is written only when the text, caret, or selection
  changes. Pointer moves, wheel turns, and key releases change nothing, so
  they render nothing.
- The cost readout (host milliseconds from the frame callback to delivery,
  and the frame's `dirtyRectangles` count) is recorded in `presentFrame` and
  written to the document from the input handler. Writing it inside
  `presentFrame` would dirty the frame just presented and render without
  end.
- The device scale is chosen once; a window resize goes through
  `surface.viewport.resizeTo(width, height, deviceScale)` on the kept
  surface.

`globalThis.example` exposes read-only state of the document (text, caret
line and column, status text, ink line text, scroll offset, frame count,
and how many times the status line was rewritten) for automation and the
console.

## Run

Serve this directory with any static server and open it in a browser with
WebGPU (Chrome or Edge 113 or later, Safari 26):

```sh
npx serve .
# or
python3 -m http.server 8000
```

Sandom, its WebAssembly dependencies, and the IBM Plex Mono faces load from
jsDelivr through the import map in `index.html`.

## Expected result

A dark editor fills the window. `main.js` appears with line numbers, red
keywords, purple function names, blue strings and numbers, grey italic
comments, and green selectors inside the CSS template. The caret blinks at
line 1, column 1, and the status line reads `line 1, column 1`,
`no selection`, and the line count.

Click a line and type: the characters appear in the highlighted text, the
gutter number and the line background follow the caret, and the status line
shows the caret position and the last frame's cost. The wheel scrolls the
code and the gutter together; a thin scrollbar shows the position. Without
WebGPU the page shows a one-line notice instead.

## Licences

The example code is under Apache-2.0, the `sandom` package's licence. IBM
Plex Mono, by IBM, is under the SIL Open Font License 1.1; the page loads
its regular and italic faces from the package's `test-assets/` directory.
