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
  constructable stylesheets, and event dispatch; classic and `type="module"`
  scripts in HTML inputs; the `canvas` element with the WebGPU and Canvas 2D
  contexts, `OffscreenCanvas` and `ImageBitmap`.
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

Not implemented: CSS Nesting, container queries, counters, relative color
syntax, and `light-dark()`; `backdrop-filter`, masks, `border-image`,
`clip-path` shapes, `text-shadow`, `background-blend-mode`, and `isolation`
on the HTML and CSS path; vertical writing modes, 3D transforms, subgrid, and
`flex-wrap: wrap-reverse`; `<use>`, patterns, markers, filters, and masks in
inline SVG; `contenteditable` editing hosts, `<dialog>`, popovers, and the
date, time, number, range, color, and file input types; WebGL canvas
contexts and Canvas 2D `getImageData()` and `toDataURL()`; GIF and AVIF
decoding; video output.

## Install

```sh
npm install sandom webgpu      # Node
bun  add     sandom bun-webgpu # Bun
```

## Use

```javascript
import "sandom/gpu"; // mounts navigator.gpu on Node and Bun; no-op elsewhere
import { loadFont } from "sandom/font-registry";
import { createLocalSandomHost } from "sandom/host/local";
import { createRenderSurface, createSandomDOM } from "sandom/dom";
import { encodeImage } from "sandom/output";

const font = await loadFont(
  "IBM Plex Mono",
  new URL(
    "../test-assets/IBMPlexMono-Regular.ttf",
    import.meta.resolve("sandom"),
  ),
  // A locator source goes through a host that may read it.
  { host: createLocalSandomHost({ authorizedRoots: [new URL("../test-assets/", import.meta.resolve("sandom"))] }) },
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
`bun-webgpu`, and the Deno and default entries verify that the host already
provides `navigator.gpu`.

Sandom's GPU devices live on a GPU thread, a worker that performs the GPU
effects that Sandom's WebAssembly requests. Page script and components see
those devices through a WebGPU facade, so synchronous Canvas reads such as
`getImageData()` can wait for the GPU. On Node and Bun the GPU thread imports
the `sandom/gpu` entry that mounted the GPU, so import it before any other
Sandom module. A browser runs Sandom in a worker of a cross-origin-isolated
page (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`).

A host that supplies its own devices passes a provider module, which runs on
the GPU thread:

```javascript
// device-provider.js, loaded on the GPU thread
export function provideDevice({ adapter, descriptor, options }, operation) {
  adapter.requestDevice({ ...descriptor, label: options.label })
    .then(operation.reply, operation.throw);
}
```

```javascript
import { createGpuThread } from "sandom";

createGpuThread(
  { provider: { module: new URL("./device-provider.js", import.meta.url).href, options: { label: "host" } } },
  { reply(thread) { /* thread.gpu is the facade's GPU */ }, throw(error) { throw error; } },
);
```

The provider replies with a native `GPUDevice` of the GPU thread. A scene
renderer also draws on a native device of the script thread
(`createSceneRenderer({ graphicsDevice })`). Canvas contexts and component
WebGPU take GPU-thread devices only, because their synchronous reads block
on the GPU thread.

For a server bundle, supply final runtime resources instead of package-relative
URLs:

```javascript
import { createSandomRuntime } from "sandom/runtime";
import { createSuppliedResourceHost } from "sandom/host/supplied-resources";

const runtime = await createSandomRuntime({
  assets: {
    harfbuzz: harfbuzzBytes,
    msdfgen: msdfgenBytes,
  },
});
// The runtime owns its font registry: load into that, not the module-level
// registry, so each runtime keeps separate font and glyph state.
await runtime.loadFont("Inter", interFontURL, {
  host: createSuppliedResourceHost({ resources: { [interFontURL]: interFontBytes } }),
});
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
`resolveSystemFontFamily` and `bundledSystemFonts` are the other accepted
options; there are no built-in document fonts, so a document's families come
from `loadFont`, `@font-face`, a system font resolver, or the generic faces of
`bundledSystemFonts`. A runtime owns its font registry, so give it the generic
faces of the bundled font set at creation:

```javascript
import { createSandomRuntime } from "sandom/runtime";
import { loadBundledSystemFonts } from "sandom/system-fonts";

const runtime = await createSandomRuntime({
  bundledSystemFonts: await loadBundledSystemFonts(),
});
```

Each runtime owns separate WebAssembly instances, font and glyph
state, path and image caches, and renderer contexts, and releases the last of
those with `runtime.releaseRenderContexts()`.

The renderer core composes the `@sandom/font-metrics` 0.1.0 WAT reader.
Native font operations validate collection-face indices, read scalar metrics,
and return diagnostics. The host loads font bytes and transports native records.

PNG decoding and encoding run in the exact `@sandom/png@0.1.0` dependency.
Sandom owns the binding that copies bytes in and out; the package has no
JavaScript and Sandom has no fallback PNG codec.

JPEG and WebP decoding run in the exact `@sandom/image-codecs@0.1.0`
dependency. Sandom owns the bindings; the package has no JavaScript and Sandom
has no fallback JPEG or WebP decoder.

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

## Component adapters

The Vite, Next.js, and compiled-application adapters are in the separate
`@sandom/adapters` package. Root package imports do not load adapter or
framework code.

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
import { noResourceHost } from "sandom/host";

const component = await renderComponent({
  host: noResourceHost, // the component loads no resource
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
  `OUTPUT_FORMATS`, `validateOutputRequest`, `createGifRecorder`,
  `quantizeWorkingPixels`, and `createGlyphOutlineSource` (the glyph
  outlines of a font's bytes, from the shaper Sandom renders with). The
  rectangle commands of `createDisplayListArtifact` carry their `paint`:
  fill, border widths, corner radii and whether a transform places them.
- `sandom/runtime` — the bundler-safe `createSandomRuntime` entry.
- `sandom/dom` — the public DOM facade: `createSandomRuntime`,
  `createSandomDOM`, `createRenderSurface`, `renderComponent`, document
  sessions, render planning, inspection, browser-worker rendering,
  `DOMParser`, `createInputWindow` (the window that a document's classic
  scripts run against), and `caretRectangle` and `selectionRectangles` (the
  caret and selection geometry of a surface's presented frame).
- `sandom/font-registry` — `loadFont` and the font family registry.
- `sandom/system-fonts` — the bundled font set: `loadBundledSystemFonts`,
  `installBundledSystemFonts`, `loadFontSetFallbackFamilies` and
  `installFontSetFallbackFamilies`.
- `sandom/host`, `sandom/host/local`, `sandom/host/supplied-resources`,
  `sandom/host/browser` — the resource hosts; `sandom/host/browser` exports
  `createBrowserSandomHost`.
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
- `sandom/dom/node` — `DOMParser` and document helpers for `@sandom/adapters`.
- `sandom/dom-wasm/core` — the shared DOM core for `@sandom/adapters`.
- `sandom/src/*.js` — direct module access, identical to the CDN layout.

## Project status

Sandom renders the documents described in Coverage, and its maintained tests
hold that coverage to a pinned Chrome build. Unsupported records and invalid
public inputs fail loudly instead of producing a partial result.
