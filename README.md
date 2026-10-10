# Sandom

Sandom is a web rendering engine that runs inside your process. It accepts a
mutable DOM tree, runs the CSS cascade and layout in WebAssembly, rasterizes
with WebGPU or WebGL 2, and delivers each frame as a GPU texture or, on
request, as float32 working pixels. It does not start or retain a browser
process.

The canonical distribution is the immutable ES module set at
`https://cdn.urania-libs.com`. This npm package is a convenience distribution of
the same plain ES modules for Node and Bun hosts.

## Requirements

- A WebGPU adapter for pixel or texture output.
- Node 22 or later with the optional peer dependency `webgpu`, or
- Bun 1.3 or later with the optional peer dependency `bun-webgpu`, or
- Deno 2 or a current browser, which provide WebGPU natively.

## Coverage

Sandom is measured against Chrome: more than ninety maintained test files
compare its layout boxes, pixels, glyph advances, computed styles, or event
records with a pinned Chrome 151 build, and seeded fuzz corpora hold inline,
flex, grid, table, and stacking layout to Chrome's boxes.

- **Documents and DOM:** an HTML parser with templates and declarative shadow
  DOM; a WebAssembly DOM core; shadow DOM, custom elements, observers,
  constructable stylesheets, and event dispatch; `type="module"` scripts in
  HTML inputs.
- **CSS:** custom properties, `calc()`, `@media`, `@supports`, `@layer`,
  `@font-face`, `@keyframes`, `@import`; selectors including `:has()`,
  `:is()`, `:where()`, `:nth-child(An+B of S)`, and `:focus-visible`.
- **Layout:** block, inline, flexbox, grid, tables, floats, relative,
  absolute, fixed, and sticky positioning, overflow and scrolling, stacking
  contexts, 2D transforms, multicolumn, bidirectional text, and MathML Core.
- **Text:** HarfBuzz shaping; TrueType, OpenType, WOFF, and WOFF2;
  `unicode-range`; per-cluster font fallback; COLR, CBDT, and sbix color
  glyphs; OpenType features; East Asian line breaking.
- **Paint:** backgrounds, borders and radii, box shadows, linear, radial,
  conic, and repeating gradients, CSS filters, `mix-blend-mode`, opacity,
  clipping, and SVG; the scene renderer also paints `backdrop-filter`, masks,
  `border-image`, `clip-path` shapes, and `text-shadow`.
- **Images and color:** PNG, JPEG, WebP, and JPEG XL decoding; ICC profiles;
  CSS Color 4 spaces and `color-mix()`; wide-gamut and high-dynamic-range
  rendering.
- **Interaction and animation:** pointer, wheel, keyboard, and IME input;
  focus; text editing and selection; form controls; scrolling with snap and
  scrollbars; an accessibility snapshot; CSS transitions and animations,
  scroll-driven timelines, `element.animate()`, and `getAnimations()`.
- **Output:** GPU textures or float32 pixels; PNG, JPEG XL, gain-map JPEG,
  raw, BMP, PPM, and animated GIF.

Not implemented: CSS Nesting, container queries, `min()`, `max()`, `clamp()`,
counters, relative color syntax, and `light-dark()`; `backdrop-filter`, masks,
`border-image`, `clip-path` shapes, `text-shadow`, `background-blend-mode`, and
`isolation` on the HTML and CSS path; vertical writing modes, 3D transforms,
subgrid, and `flex-wrap: wrap-reverse`; `<use>`, patterns, markers, filters,
and masks in inline SVG; `contenteditable` editing hosts, `<dialog>`,
popovers, and the date, time, number, range, color, and file input types;
classic scripts in HTML inputs; Canvas 2D and WebGL canvas contexts; GIF and
AVIF decoding; video output.

## Install

```sh
npm install sandom webgpu      # Node
bun  add     sandom bun-webgpu # Bun
```

## Use

```javascript
import "sandom/gpu"; // mounts navigator.gpu on Node and Bun; no-op elsewhere
import { loadFont } from "sandom/font-registry";
import { createRenderSurface, createSandomDOM } from "sandom/dom";
import { encodeImage } from "sandom/output";

const font = await loadFont(
  "IBM Plex Mono",
  new URL(
    "../test-assets/IBMPlexMono-Regular.ttf",
    import.meta.resolve("sandom"),
  ),
);
const dom = createSandomDOM({ viewportW: 320, viewportH: 180 });
const root = dom.createElement("main");
root.style.width = "320px";
root.style.height = "180px";
// Declare the family that was loaded. Without this the element inherits
// `sans-serif`, which has no system font resolver on a server, and the
// render throws rather than picking a font nobody asked for.
root.style.fontFamily = "IBM Plex Mono";
root.appendChild(dom.createTextNode("DOM in. Pixels out."));

const surface = createRenderSurface(root, {
  viewportWidth: 320,
  viewportHeight: 180,
});
surface.stop(); // no host frame loop; render on demand
const frame = await surface.renderNow({ pixels: true });
const png = await encodeImage(frame, { format: "png" });
await surface.shutdown();
font.unload();
```

Mutate `root` and call `surface.renderNow` again for the next frame: the
surface retains layout, glyphs, and the GPU target, so the second frame costs
what changed. `renderNow()` without `{ pixels: true }` delivers the WebGPU
texture and performs no readback.

`sandom/gpu` resolves per runtime through conditional exports: the Node entry
mounts Google Dawn from the `webgpu` package, the Bun entry mounts Dawn from
`bun-webgpu`, and the default entry verifies that the host already provides
`navigator.gpu`.

For a server bundle, supply final runtime resources instead of package-relative
URLs:

```javascript
import { createSandomRuntime } from "sandom/runtime";

const runtime = await createSandomRuntime({
  assets: {
    harfbuzz: harfbuzzBytes,
    msdfgen: msdfgenBytes,
  },
});
// The runtime owns its font registry: load into that, not the module-level
// registry, so each runtime keeps separate font and glyph state.
await runtime.loadFont("Inter", interFontURL);
const dom = runtime.createSandomDOM({ viewportW: 800, viewportH: 600 });
const root = dom.createElement("main");
root.style.fontFamily = "Inter";
root.appendChild(dom.createTextNode("Rendered by Sandom."));
const surface = dom.createRenderSurface(root, {
  viewportWidth: 800,
  viewportHeight: 600,
});
```

Asset values must be `Uint8Array`, `ArrayBuffer`, or absolute URLs. The two
engine assets are `harfbuzz` and `msdfgen`; JPEG, PNG, WebP and JPEG XL bytes
go under `assets.codecs` and stay lazy. Supplying `assets` at all means
supplying every asset the document needs — the runtime stops resolving
package-relative URLs and reports `runtime.assets.mode === "explicit"`.
`resolveSystemFontFamily` is the only other accepted option; there are no
built-in document fonts, so a document's families come from `loadFont` or
`@font-face`. Each runtime owns separate WebAssembly instances, font and glyph
state, path and image caches, and renderer contexts, and releases the last of
those with `runtime.releaseRenderContexts()`.

OpenType scalar metrics come from the exact `@sandom/font-metrics@0.1.0`
dependency. Sandom owns font loading, collection-face selection, WASM
marshalling, and the renderer/registry error policies; it contains no fallback
font-table parser.

## Performance

A render surface retains layout, glyph resources, the damage map, engine
animations, and the GPU target between frames. Keep the surface for as long as
the document is shown and change only the nodes that change: the next frame
then costs what changed. A new surface, a new document, a remounted component,
or a rebuilt tree pays for the whole document again.

| Use case | API |
| --- | --- |
| A still image of a DOM you build | `createRenderSurface`, `surface.stop()`, `renderNow({ pixels: true })`, `encodeImage`, as in Use |
| Many images from one template | One surface; change the template's nodes, then `renderNow({ pixels: true })` per image |
| An HTML, JavaScript, JSX, or SVG file to a PNG or GIF | `renderInput`; `renderInBrowserWorker` in a browser |
| A live interface on a canvas | One surface with `presentFrame` and `createCanvasPresenter` on the surface's `GPUDevice`; `bindProjectedInput` for input |
| A document inside a three.js or WebGPU scene | `createTexturePresenter({ device, onTexture }).presentFrame` on the scene's `GPUDevice`; `bindProjectedInput` with the scene's projection |
| Motion | CSS animations and transitions in the document; the surface's loop advances them. `surface.captureFrames()` or `createGifRecorder` for files |
| A compiled framework application that reads `document` and `window` | `renderComponent`, mounted once and kept; see Component sessions |
| Typed scene records without a DOM | `createSceneRenderer` |

A live interface in a browser keeps one surface, presents its texture without
a readback, and routes input through `bindProjectedInput`:

```javascript
import {
  bindProjectedInput,
  createCanvasPresenter,
  createRenderSurface,
  createSceneRenderer,
  projectOntoRectangle,
} from "sandom";

// `dom` and `root` are a createSandomDOM result and the tree built with it.
const device = await (await navigator.gpu.requestAdapter()).requestDevice();
const presenter = createCanvasPresenter({ canvas, device });
const surface = createRenderSurface(root, {
  viewportWidth: 640,
  viewportHeight: 400,
  deviceScale: devicePixelRatio,
  createPersistentRenderer: (options) =>
    createSceneRenderer({ ...options, graphicsDevice: device }),
  presentFrame: (frame) => presenter.present(frame.textureImage),
});
await surface.renderNow(); // input needs a presented frame
const projection = projectOntoRectangle(canvas, { width: 640, height: 400 });
bindProjectedInput({
  host: canvas,
  backend: dom,
  root,
  project: projection,
  unproject: projection.unproject,
});
// Event handlers change nodes; the loop presents each changed frame.
```

One row's text changed in a 300-row list at 800 by 600, timed to the
completion of the frame's GPU work; medians of five runs on an Apple M4 under
heavy load:

| Update path | Median range, ms |
| --- | ---: |
| Kept render surface, one text node changed | 36–73 |
| Kept `renderComponent` session, one text node changed | 34–51 |
| Kept render surface, the whole list rebuilt | 159–200 |
| `renderComponent` mount, render, and dispose per change | 202–221 |
| New `createSandomDOM` and `createRenderSurface` per change | 195–277 |

- Build the tree once and keep references to the nodes that change. Set a
  text node's `data`, an element's `style` property, or a class; do not
  replace the subtree around them.
- Keep one surface per shown document, and resize it through
  `surface.viewport.resizeTo(width, height, deviceScale)`.
- Let the surface's loop decide when to render. After `surface.start()` it
  requests a host animation frame only when the document changed, an
  animation runs, a caret blinks, or a scrollbar fades; an idle document
  renders nothing.
- Never change the rendered document from `presentFrame` or `onFrame`. The
  change dirties the frame just presented and the loop renders without end.
- Request `{ pixels: true }` only for files and CPU consumers. Each pixel
  request reads the texture back; on Deno a readback waits on a `mapAsync`
  poll of about 13 ms.
- Create one runtime per process or page and one `GPUDevice` shared by
  Sandom, its presenter, and any host scene.
- Choose the device scale once for the surface's life. A slow frame needs
  smaller changes, not fewer pixels during a gesture.

Every frame carries `renderTimings` (preparation, renderer wait, resize,
visible rectangle, raster, and postprocess milliseconds) and
`dirtyRectangles`, the damage it repainted. `surface.frameStageCounters`
accumulates `serializations` and `layoutPasses`, which grow on frames that
serialized or laid out the document again, and `retainedCleanFrames`, which
grows on frames that reused the retained scene. For host time, record
`performance.now()` in the surface's `requestFrame` callback and again in
`presentFrame`, and show it outside the rendered document.

## Examples

Complete programs that follow the Performance patterns live in the
repository's
[`examples/`](https://github.com/fernandoviac/sandom/tree/main/examples)
directory. Each imports only this package and pinned public CDNs, and its
README says how to run it and what it produces.

- [`book`](https://github.com/fernandoviac/sandom/tree/main/examples/book)
  — books with physics-turned pages in a WebGPU scene, printed from a live
  HTML and CSS document you can edit, replace, and type into on the paper.
- [`live-list`](https://github.com/fernandoviac/sandom/tree/main/examples/live-list)
  — a task list on a canvas whose items are inserted, removed, reordered,
  and expanded while shown, with each change's measured cost beside it.
- [`code-editor`](https://github.com/fernandoviac/sandom/tree/main/examples/code-editor)
  — a live editor on a canvas: texture presentation and projected input.
- [`wikipedia-scroll`](https://github.com/fernandoviac/sandom/tree/main/examples/wikipedia-scroll)
  — a long, scrolling document on a mesh in a three.js WebGPU scene.
- [`shatter`](https://github.com/fernandoviac/sandom/tree/main/examples/shatter)
  — one live, animated document split across many meshes in a three.js scene.
- [`still-image`](https://github.com/fernandoviac/sandom/tree/main/examples/still-image)
  — one PNG from a DOM built in the process, then more from the same kept
  surface, on Node or Deno.
- [`motion-gif`](https://github.com/fernandoviac/sandom/tree/main/examples/motion-gif)
  — a CSS animation captured to an animated GIF by the surface's own clock.
- [`react-session`](https://github.com/fernandoviac/sandom/tree/main/examples/react-session)
  — a React application mounted once in a kept component session.

## Vite component adapter

Install Vite only when the project uses the optional adapter:

```sh
npm install sandom vite
```

The adapter requires Vite `>=8.2.0 <9` and Deno 2. It validates the installed
Vite version during adapter creation.

```javascript
import { createViteComponentAdapter } from "sandom/adapters/vite";

const adapter = await createViteComponentAdapter({
  vite: {
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  },
  entry: "/src/mount-entry.jsx",
  stylesheet: "/src/styles.css?inline",
  revision: { module: "/src/revision.js", export: "SOURCE_REVISION" },
  resources: [{
    module: "/src/resources.js",
    export: "fontURL",
    kind: "font",
  }],
});

const result = await adapter.render({ revision: "source-1" });
await adapter.dispose();
```

The entry module exports `mount(context)`. The adapter imports that module only
after the Deno realm installs Sandom globals.

Each render uses a fresh Deno process. The result has kind
`sandom/component-adapter-result` and version 1. The adapter serves review and
test renders; a live view keeps one component session instead of paying for a
process per render.

Pass `server` instead of `vite` creation options to use a caller server. That
server must have a documented `DevEnvironment` with the selected environment
name.

Root package imports do not load Vite or adapter code.

## Compiled application adapter

Use the generic entry for a public compiled browser application:

```javascript
import {
  createCompiledApplicationAdapter,
} from "sandom/adapters/compiled-application";

const adapter = await createCompiledApplicationAdapter({
  documentURL: "http://127.0.0.1:3000/component-review",
  readiness: {
    selector: "html",
    attribute: "data-application-ready",
  },
});

const result = await adapter.render({ revision: "source-1" });
await adapter.dispose();
```

The adapter fetches one public document and a finite resource set.
It executes selected classic scripts in document order.
It transfers assets, resources, pixels, and images as raw bytes.
Application console calls return as structured diagnostics.
The realm reserves standard output for protocol frames.
The realm owns application timers and WebSockets.
Terminal disposal cancels timers and closes sockets.
It then emits evidence and destroys the process without global restoration.

Each render uses a fresh Deno process.
The process receives an empty environment.
The host command does not require environment-variable permission.
The adapter rejects missing readiness, unlisted scripts, missing resources,
incomplete disposal, standard-error output, and an inexact exit.

## Next.js component adapter

Install Next.js only when the project uses the optional entry:

```sh
npm install sandom next react react-dom
```

The adapter requires Next.js `>=16.3.1 <17` and Deno 2.
It validates the installed Next.js version during adapter creation.

```javascript
import { createNextComponentAdapter } from "sandom/adapters/next";

const adapter = await createNextComponentAdapter({
  documentURL: "http://127.0.0.1:3000/component-review",
  serverEnvironmentURL:
    "http://127.0.0.1:3000/api/server-environment",
});

const result = await adapter.render({
  revision: "source-1",
  interaction: {
    target: { selector: "[data-component-action]" },
  },
});
await adapter.dispose();
```

The adapter uses public Next.js HTML, scripts, resources, and the development
middleware manifest.
It supplies a real WebSocket to the isolated realm.

The server environment endpoint returns global descriptors, Sandom global
names, and one process identifier.
The adapter requires this record to stay unchanged.

The Next.js entry does not use a private compiler registry.
It does not call a production build.
It creates a fresh realm after incremental compilation.

Root package imports do not load compiled-application or Next.js adapter code.


## Bun

No JavaScriptCore feature flag is needed: Sandom's engine and HarfBuzz share one
WebAssembly memory, so Bun compiles the engine binary with default settings.

On Bun, WGSL compilation errors do not surface: `bun-webgpu` does not implement
`getCompilationInfo`, so `sandom/gpu` stubs it.

## Component sessions

`renderComponent()` returns one live component session. Sandom installs DOM
globals before it awaits `mount`, so the mount callback can run compiled
application code that reads `document` and `window`, such as a React or Vue
build. The session accepts closed pointer, wheel, key, composition, and
accessibility-action records.

Use a session for such application code, or when you need its accessibility
snapshots and semantic actions. Mount once and keep the session; `render()`
on a kept session costs what a kept surface costs, and a session per change
costs three to seven times as much (Performance). One session owns the
realm's DOM globals until it is disposed. Code that builds its own tree with
`createSandomDOM` needs no globals and uses `createRenderSurface`.

```javascript
import { renderComponent } from "sandom/dom";

const component = await renderComponent({
  width: 320,
  height: 180,
  mount({ document, container }) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "Example checkbox");
    container.appendChild(checkbox);
  },
});

const initial = await component.render();
const checkbox = initial.accessibility.nodes.find((node) =>
  node.role === "checkbox"
);
const successor = await component.dispatch([{
  kind: "accessibility-action",
  accessibilityRevision: initial.accessibilityRevision,
  nodeIdentifier: checkbox.identifier,
  action: "press",
}]);
await component.dispose();
```

Each accepted frame is a texture frame and contains focus, changed control
states, interactive text geometry, and one matching accessibility snapshot.
`component.render({ pixels: true })` reads the current state back as pixels.

The maintained defaults cover button, text input, textarea, checkbox, radio,
select, option, label, and `<details>` controls, and form submission events.
The session protocol carries no clipboard records. Form validation, file
input, document drag and drop, context menus, auxiliary click, double-click
defaults, and cross-document navigation are not implemented.

## Entry points

- `sandom` — the public surface, one entry per job: `createRenderSurface`,
  `createSandomDOM`, `createSandomRuntime`, `createSceneRenderer`,
  `createPersistentSceneRenderer`, `createLayoutArtifact`,
  `createDisplayListArtifact`, `createInvalidationArtifact`,
  `GlyphResourceManager`, `DEFAULT_GLYPH_RESOURCE_LIMITS`,
  `releaseRenderContexts`, `createDocumentSession`, `DocumentSession`,
  `SandomDocument`, `evaluateComponentModule`, `renderComponent`,
  `renderInput`, `renderInBrowserWorker`, `planAutomaticViewport`,
  `recommendMotionCapture`, `RenderPlanningError`, `loadFont`,
  `createCanvasPresenter`, `createTexturePresenter`, `bindProjectedInput`,
  `projectOntoRectangle`, `createGpuCompositor`, `encodeImage`,
  `OUTPUT_FORMATS`, `validateOutputRequest`, `createGifRecorder`, and
  `quantizeWorkingPixels`.
- `sandom/runtime` — the bundler-safe `createSandomRuntime` entry.
- `sandom/dom` — the public DOM facade: `createSandomRuntime`,
  `createSandomDOM`, `createRenderSurface`, `renderComponent`, document
  sessions, render planning, inspection, and browser-worker rendering.
- `sandom/web-component` — the `<sandom-renderer>` browser component.
- `sandom/font-registry` — `loadFont` and the font family registry.
- `sandom/gpu-compositor` — `createGpuCompositor`, the same-device texture and
  text compositor.
- `sandom/adaptive-jpeg` — the focused gain-map JPEG encoder, inspector, and
  reconstruction.
- `sandom/output` — `encodeImage`, `OUTPUT_FORMATS`, and
  `validateOutputRequest`.
- `sandom/color-transform` — `quantizeWorkingPixels` and the output color
  transform.
- `sandom/jsx-runtime` — the JSX automatic runtime for Sandom documents.
- `sandom/gpu` — runtime-conditional `navigator.gpu` mounting.
- `sandom/adapters/vite` — the optional Vite development adapter.
- `sandom/adapters/compiled-application` — the public browser-application
  adapter.
- `sandom/adapters/next` — the optional Next.js development adapter.
- `sandom/component-adapter-result` — the shared result validator.
- `sandom/component-adapter-realm-protocol` — the versioned realm protocol.
- `sandom/src/*.js` — direct module access, identical to the CDN layout.

## Project status

Sandom renders the documents described in Coverage, and its maintained tests
hold that coverage to a pinned Chrome build. Unsupported records and invalid
public inputs fail loudly instead of producing a partial result.
