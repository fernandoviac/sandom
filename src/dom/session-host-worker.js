// The browser session host worker: a module Worker that owns one Sandom
// component session at a time (plans/PLAN-browser-session-host.md,
// extracted from Sandtable's proven embed-session-worker of 2026-09-01).
// The worker imports Sandom relatively (./dom.js, ./session-presentation.js,
// ../font-registry.js), so it works served from any route without an import
// map. Everything host-application-specific arrives as start-message data:
// font registrations, the component and contract module locators (pre-mapped
// by the caller to worker-reachable URLs, because workers cannot read the
// document import map), and the ordered stylesheet list.
//
// Presentation is zero-copy: the caller transfers this session's canvas in
// the start message, and the session's presentFrame delivery (the renderer's
// live texture and device) presents onto it GPU-to-GPU through the shared
// presentation-delivery module (./session-presentation.js), which also
// carries the WebGL 2 pixel fallback through a 2d context. CPU readback
// runs only for a capture request.
//
// Message kinds and the protocol version live in
// ./session-host-protocol.js; both sides import it, and a version mismatch
// fails loudly.
//
// Warm realm reuse (protocol v2): an END message disposes the live session
// completely - the document, its custom-element registry, component
// globals, observers, animation loops, GPU surfaces, and the inspection
// registry all die with it - and answers ENDED, after which this worker
// accepts a new START. The realm deliberately retains two resources
// across sessions: registered fonts (immutable realm resources, loaded
// once per family+url) and the ES module cache. A cached component module
// never re-runs its top-level customElements.define calls, so END
// snapshots the session registry's definitions and a later same-module
// START replays them into the fresh registry (constructors are
// module-level state the realm retains by design). A teardown failure
// poisons the realm: every later START fails loudly naming it, and the
// client falls back to a fresh worker.
//
// Browser verification recipe (Deno cannot transfer a canvas or run the
// presenter; adapt of the blob-worker probe in Sandtable's
// local-data/probe-browser-perf.md): evaluate in a page of a server that
// serves this file and its relative imports (Sandtable's loop server serves
// them under /worker-code/):
//
//   const manifest = /* decode the base64url line of a
//     sandtable-component-embed .sandscript file, as in the probe */;
//   const canvas = document.body.appendChild(document.createElement("canvas"));
//   const offscreen = canvas.transferControlToOffscreen();
//   const worker = new Worker(
//     "/worker-code/sandom/src/dom/session-host-worker.js",
//     { type: "module" },
//   );
//   worker.onmessage = (event) => console.log(event.data);
//   worker.postMessage({
//     kind: "sandom/session-host-start", version: 2,
//     canvas: offscreen, width: 640, height: 640, deviceScale: 1,
//     module: "/worker-code/exactas/public/plot-fullscreen.js",
//     component: "plot-fullscreen",
//     schema: manifest.schema, instance: manifest.instance,
//     contractModule: "/worker-code/web-component-contract/mod.js",
//     fonts: [
//       { family: "Inter", url: "/worker-code/sandom/test-assets/Inter-Variable.ttf" },
//       { family: "sans-serif", url: "/worker-code/sandom/test-assets/Inter-Variable.ttf" },
//       { family: "monospace", url: "/fonts/IBMPlexMono-Regular.ttf" },
//     ],
//     stylesheets: [{ locator: "/code/exactas/public/style.css" }],
//   }, [offscreen]);
//   // Expect step messages, then started; post
//   // { kind: "sandom/session-host-present", version: 2, enabled: true }
//   // and expect a presentation-mode message plus pixels on the canvas;
//   // a capture message answers with a capture-frame bitmap.

import {
  SESSION_HOST_CAPTURE_FRAME_KIND,
  SESSION_HOST_CAPTURE_KIND,
  SESSION_HOST_END_KIND,
  SESSION_HOST_ENDED_KIND,
  SESSION_HOST_FAILED_KIND,
  SESSION_HOST_INPUT_KIND,
  SESSION_HOST_INPUT_RESULT_KIND,
  SESSION_HOST_INSPECT_KIND,
  SESSION_HOST_INSPECT_RESULT_KIND,
  SESSION_HOST_PRESENT_KIND,
  SESSION_HOST_PRESENTATION_MODE_KIND,
  SESSION_HOST_PROTOCOL_VERSION,
  SESSION_HOST_RESIZE_KIND,
  SESSION_HOST_START_KIND,
  SESSION_HOST_STARTED_KIND,
  SESSION_HOST_STEP_KIND,
  SESSION_HOST_STYLE_SET_KIND,
} from "./session-host-protocol.js";
import { createBrowserSandomHost } from "../host/browser-host.js";
import { createResourceDemand, originOf, receiveResourceResponse } from "../host/contract.js";
import { sharedDomCore } from "../dom-wasm/core.js";

// This worker is a browser host: native browser Fetch obtains its fonts and
// stylesheet locators.
const browserHost = createBrowserSandomHost();
// The worker's own OffscreenCanvas and ImageData, taken before a session
// installs Sandom's on this global (src/dom/component-globals.js).
const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const HostImageData = globalThis.ImageData;
let stylesheetGeneration = 0;

async function readBrowserStylesheet(locator) {
  const session = browserHost.openResourceSession();
  const demand = createResourceDemand({
    reference: locator,
    baseURL: location.href,
    destination: "style",
    clientOrigin: originOf(location.href),
    mode: "cors",
    generation: ++stylesheetGeneration,
    signal: new AbortController().signal,
  });
  try {
    return await receiveResourceResponse(
      await session.request(demand),
      browserHost.backend,
      locator,
    );
  } finally {
    session.release();
  }
}

// Locator stylesheets fetch by URL so their own relative url() references
// resolve against the real stylesheet location. Their @font-face rules are
// dropped: the host's caller registers its faces through the start
// message's fonts list, and a site-absolute font URL (for example an
// exactas /assets/fonts/... reference) resolves to a host-server 404 whose
// body Sandom would register as font bytes. Native filtering matches the
// case-sensitive rule name and removes through its next closing brace.
// Every locator stylesheet passes through this removal.
export function removeFontFaceBlocks(source) {
  if (typeof source !== "string") throw new TypeError("Stylesheet source must be a string");
  const pointer = sharedDomCore.exports.abi_allocate(source.length * 2);
  const units = new Uint16Array(sharedDomCore.refreshBytes().buffer, pointer, source.length);
  for (let index = 0; index < source.length; index++) units[index] = source.charCodeAt(index);
  const count = sharedDomCore.status("font_stylesheet_filter", pointer, source.length);
  const spans = new Uint32Array(sharedDomCore.refreshBytes().buffer, sharedDomCore.exports.abi_output_pointer(), count * 2);
  const parts = new Array(count);
  for (let index = 0; index < count; index++) parts[index] = source.slice(spans[index * 2], spans[index * 2 + 1]);
  return parts.join("");
}

function serializeStyleDeclaration(declaration) {
  const entries = [];
  for (let index = 0; index < declaration.length; index += 1) {
    const property = declaration.item(index);
    entries.push([property, declaration.getPropertyValue(property)]);
  }
  return entries;
}

// One inspection registry: stable per-element identifiers for the session's
// life, the element lookup a style-set record names, and the inspection
// snapshot serializer. The snapshot is the serialized element tree with
// inline and computed styles, and the analytical layout box of every
// element in the frame, keyed by the stable identifier. The client rebuilds
// its document rail and node panel from this record; a style edit comes
// back as a style-set record naming the identifier.
export function createInspectionRegistry() {
  let nextIdentifier = 1;
  const identifiers = new WeakMap();
  let elementByIdentifier = new Map();
  const identifierFor = (node) => {
    let identifier = identifiers.get(node);
    if (identifier === undefined) {
      identifier = nextIdentifier++;
      identifiers.set(node, identifier);
    }
    return identifier;
  };
  return {
    identifierFor,
    elementFor(identifier) {
      return elementByIdentifier.get(identifier);
    },
    serializeInspection(document, frame) {
      elementByIdentifier = new Map();
      const serializeNode = (node) => {
        if (node.nodeType === 3) {
          return { kind: "text", text: String(node.data ?? "") };
        }
        if (node.nodeType !== 1) return null;
        const identifier = identifierFor(node);
        elementByIdentifier.set(identifier, node);
        let computed = [];
        try {
          computed = serializeStyleDeclaration(
            document.getComputedStyle(node),
          );
        } catch {
          // A node the layout has not reached yet has no computed record;
          // the panel presents its inline styles alone.
        }
        return {
          kind: "element",
          identifier,
          tag: String(node.tagName ?? "?").toLowerCase(),
          id: node.id ?? "",
          inline: serializeStyleDeclaration(node.style),
          computed,
          shadow: node.shadowRoot
            ? [...node.shadowRoot.childNodes].map(serializeNode)
              .filter(Boolean)
            : null,
          children: [...node.childNodes].map(serializeNode).filter(Boolean),
        };
      };
      const boxes = [];
      const { layoutBoxes, elementAtIndex } = frame.inspection;
      for (let index = 0; index < layoutBoxes.length; index += 1) {
        const box = layoutBoxes[index];
        const target = elementAtIndex[index];
        if (!box || !target || target.nodeType !== 1) continue;
        boxes.push([
          identifierFor(target),
          { left: box.x, top: box.y, width: box.w, height: box.h },
        ]);
      }
      return {
        tree: [...document.body.childNodes]
          .map(serializeNode)
          .filter(Boolean),
        boxes,
      };
    },
  };
}

let session = null;
let starting = false;
let presenting = false;
let lastDelivery = null;
let presentDelivery = null;
let sessionDocument = null;
let sessionModule = null;
let screen = null;
let inspection = createInspectionRegistry();
// A teardown that cannot guarantee a clean realm poisons warm reuse for
// this worker's whole life: every later START fails loudly naming the
// teardown failure, and the client spawns a fresh worker instead.
let teardownFailure = null;
// Fonts are immutable realm resources: one loadFont per family+url pair
// for the worker's life. A re-load would append a duplicate face record
// per warm re-mount (loadFont registers a fresh owner each call).
const loadedSessionFonts = new Map();
// Definitions a session's module graph registered, keyed by the start
// message's module locator. A warm re-start of the same module hits the
// ES module cache, so its top-level customElements.define calls never
// re-run; the replay below re-defines the recorded constructors into the
// fresh session registry. Recorded at END, while the session document is
// still alive, so lazily-defined elements are captured too.
const replayableDefinitionsByModule = new Map();

function replayModuleDefinitions(document, module) {
  const recorded = replayableDefinitionsByModule.get(module);
  if (!recorded) return;
  for (const { name, constructor, extendedTag } of recorded) {
    if (document.customElements.get(name) !== undefined) continue;
    document.customElements.define(
      name,
      constructor,
      extendedTag ? { extends: extendedTag } : {},
    );
  }
}

function encodePixelFrame(frame) {
  const encoded = new Uint8ClampedArray(frame.width * frame.height * 4);
  const pixels = frame.pixels;
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = Math.max(
      0,
      Math.min(255, Math.round(pixels[index] * 255)),
    );
  }
  const staging = new HostOffscreenCanvas(frame.width, frame.height);
  staging.getContext("2d").putImageData(
    new HostImageData(encoded, frame.width, frame.height),
    0,
    0,
  );
  return staging.transferToImageBitmap();
}

// The deepest layout box containing the point names the input target the
// client reports, mirroring the drone path's hit answer.
function hitTarget(frame, x, y) {
  if (!frame?.inspection) return null;
  const { layoutBoxes, elementAtIndex } = frame.inspection;
  let deepest = null;
  for (let index = 0; index < layoutBoxes.length; index += 1) {
    const box = layoutBoxes[index];
    if (!box || x < box.x || y < box.y) continue;
    if (x > box.x + box.w || y > box.y + box.h) continue;
    const tagName = elementAtIndex[index]?.tagName;
    if (typeof tagName === "string") deepest = tagName.toLowerCase();
  }
  return deepest;
}

// Debug breadcrumbs for the start path; a client may ignore step messages,
// so a stalled start names its last completed stage in a debug harness.
function step(name) {
  postMessage({
    kind: SESSION_HOST_STEP_KIND,
    version: SESSION_HOST_PROTOCOL_VERSION,
    name,
  });
}

async function start(message) {
  step("importing sandom");
  const [
    { renderComponent },
    { applyWebComponentInstance },
    { createPresentationDelivery, probeExtendedRange },
    { loadFont },
    { installFontSetFallbackFamilies },
  ] = await Promise.all([
    import("./dom.js"),
    import(message.contractModule),
    import("./session-presentation.js"),
    import("../font-registry.js"),
    import("../system-fonts.js"),
  ]);
  screen = message.canvas;
  screen.width = message.width * message.deviceScale;
  screen.height = message.height * message.deviceScale;
  step("modules imported");
  // Caller-named faces resolve through the registry API, not @font-face:
  // the engine has no system resolver, and component chrome reaches for
  // sans-serif/monospace before any author style lands, so the caller
  // names real faces for the generic families here. Loading starts now
  // and settles inside the mount readiness chain, in parallel with the
  // component module import; a face already loaded in this realm is a
  // cache hit (fonts are retained across warm re-mounts by design). A
  // failed load leaves the cache so the next start retries it.
  // The Noto fallback families of the sandom-fonts set
  // (design/font-fallback.md) paint each script that the
  // caller's faces do not cover; a face loads when a text needs it.
  const fontsLoaded = Promise.all([
    ...(message.fonts ?? []).map(({ family, url }) => {
      const face = `${family}\u0000${url}`;
      let loading = loadedSessionFonts.get(face);
      if (loading === undefined) {
        loading = loadFont(family, new URL(url, location.href), { host: browserHost });
        loadedSessionFonts.set(face, loading);
        loading.catch(() => loadedSessionFonts.delete(face));
      }
      return loading;
    }),
    installFontSetFallbackFamilies(),
  ]).then(() => step("fonts loaded"));
  // Zero-copy presentation onto the transferred canvas: the shared
  // presentation-delivery module (./session-presentation.js) presents
  // each presentFrame delivery - the renderer's live GPU texture through
  // a per-device canvas presenter (recreated when the renderer replaces
  // its device, extended range probed on a throwaway canvas), or the
  // WebGL 2 float-pixel fallback through a 2d context and the engine's
  // quantize rule. The host's policy is the module's defaults: wide
  // gamut whenever the platform grants it, standard render mode,
  // presenter-default alpha. Suppression (the present toggle) and
  // last-delivery replay stay here, caller-side.
  // The start message's display declaration (measured by the client in
  // the page realm - a worker cannot observe the display) selects the
  // session's dynamic range: HDR displays get the HDR working pipeline
  // and the presenter's HDR mode, so extended component values reach
  // the screen instead of self-selecting SDR through media queries.
  const requestedDisplay = message.display ?? {};
  // An HDR declaration only holds if this realm's canvases grant the
  // extended configuration (Firefox refuses rgba16float canvases even
  // where the display is HDR). Demote to standard up front - the
  // presentation-mode message names the effective range, so the demotion
  // is visible, never a mid-delivery throw.
  let display = requestedDisplay;
  if (requestedDisplay.dynamicRange === "high") {
    const adapter = await navigator.gpu?.requestAdapter?.();
    const probeDevice = adapter ? await adapter.requestDevice() : null;
    const granted = probeDevice !== null && probeExtendedRange(probeDevice);
    probeDevice?.destroy();
    if (!granted) display = { ...requestedDisplay, dynamicRange: "standard" };
  }
  const deliver = createPresentationDelivery({
    canvas: screen,
    ...(display.dynamicRange === "high"
      ? { renderMode: "high-dynamic-range" }
      : {}),
    onMode: ({ extended, dynamicRange }) => {
      postMessage({
        kind: SESSION_HOST_PRESENTATION_MODE_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        extended,
        dynamicRange,
      });
    },
  });
  presentDelivery = (delivery) => {
    lastDelivery = delivery;
    if (!presenting) return;
    deliver(delivery);
  };
  // The start message's stylesheets list is ordered; the cascade applies
  // entries in list order. A { url, source } entry applies as supplied. A
  // { locator } entry is a style demand of the browser host and passes the
  // documented @font-face removal above.
  const stylesheets = await Promise.all(
    (message.stylesheets ?? []).map(async (entry) => {
      if (entry.locator === undefined) {
        return { url: entry.url, source: entry.source };
      }
      const stylesheet = await readBrowserStylesheet(entry.locator);
      return {
        url: stylesheet.finalURL,
        source: removeFontFaceBlocks(new TextDecoder().decode(stylesheet.bytes)),
      };
    }),
  );
  step("stylesheets fetched");
  let element = null;
  sessionModule = message.module;
  session = await renderComponent({
    width: message.width,
    height: message.height,
    deviceScale: message.deviceScale,
    host: browserHost,
    display,
    presentFrame: (delivery) => presentDelivery(delivery),
    stylesheets,
    mount({ document, container }) {
      sessionDocument = document;
      const ready = (async () => {
        await import(message.module);
        // A warm re-start of a cached module: replay the definitions the
        // previous same-module session registered (see
        // replayableDefinitionsByModule above). The loud did-not-define
        // check below still guards: a module that neither defines nor
        // has a recorded definition fails the start.
        replayModuleDefinitions(document, message.module);
        if (document.customElements.get(message.component) === undefined) {
          throw new Error(
            `Component module ${message.module} did not define ` +
              `<${message.component}>`,
          );
        }
        element = document.createElement(message.component);
        applyWebComponentInstance(element, message.schema, message.instance);
        container.appendChild(element);
        step("element applied");
        if (element.ready) await element.ready;
        step("element ready");
      })();
      return { ready: Promise.all([ready, fontsLoaded]) };
    },
  });
  step("session created");
  postMessage({
    kind: SESSION_HOST_STARTED_KIND,
    version: SESSION_HOST_PROTOCOL_VERSION,
  });
  await session.render();
}

globalThis.onmessage = (event) => {
  const message = event.data;
  (async () => {
    if (message?.version !== SESSION_HOST_PROTOCOL_VERSION) {
      throw new RangeError(
        `Unsupported session host request version ${
          JSON.stringify(message?.version)
        }; this host speaks version ${SESSION_HOST_PROTOCOL_VERSION}`,
      );
    }
    if (message.kind === SESSION_HOST_START_KIND) {
      if (teardownFailure !== null) {
        throw new Error(
          "A previous session's teardown failed in this realm; " +
            "spawn a fresh worker",
          { cause: teardownFailure },
        );
      }
      if (starting || session !== null) {
        throw new Error(
          "A session is already active; end it before starting another",
        );
      }
      starting = true;
      try {
        await start(message);
      } finally {
        starting = false;
      }
      return;
    }
    if (message.kind === SESSION_HOST_END_KIND) {
      if (session === null) throw new Error("The session is not started");
      // Snapshot before dispose, while the session document is alive, so
      // lazily-defined elements are captured for a same-module replay.
      replayableDefinitionsByModule.set(
        sessionModule,
        sessionDocument.customElements.snapshotDefinitions(),
      );
      const endingSession = session;
      session = null;
      sessionModule = null;
      // Presenting stops now, but the delivery closure stays alive until
      // dispose settles: the session's render loop may still deliver an
      // in-flight frame, and presentDelivery records it (suppressed by
      // the presenting gate) instead of crashing the teardown.
      presenting = false;
      inspection = createInspectionRegistry();
      try {
        // dispose() restores the ambient globals and releases the realm's
        // ambient component ownership; without that release no second
        // renderComponent can ever start here.
        await endingSession.dispose();
      } catch (error) {
        teardownFailure = error;
        throw error;
      }
      sessionDocument = null;
      lastDelivery = null;
      presentDelivery = null;
      screen = null;
      postMessage({
        kind: SESSION_HOST_ENDED_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
      });
      return;
    }
    if (message.kind === SESSION_HOST_PRESENT_KIND) {
      presenting = message.enabled === true;
      if (presenting && lastDelivery !== null) presentDelivery(lastDelivery);
      return;
    }
    if (message.kind === SESSION_HOST_CAPTURE_KIND) {
      if (session === null) throw new Error("The session is not started");
      const frame = await session.render({ pixels: true });
      const bitmap = encodePixelFrame(frame);
      postMessage(
        {
          kind: SESSION_HOST_CAPTURE_FRAME_KIND,
          version: SESSION_HOST_PROTOCOL_VERSION,
          bitmap,
          width: frame.width,
          height: frame.height,
        },
        [bitmap],
      );
      return;
    }
    if (message.kind === SESSION_HOST_INPUT_KIND) {
      if (session === null) throw new Error("The session is not started");
      const frame = await session.dispatch(message.records);
      const pointer = message.records.find(
        (record) => typeof record.x === "number",
      );
      const target = pointer ? hitTarget(frame, pointer.x, pointer.y) : null;
      postMessage({
        kind: SESSION_HOST_INPUT_RESULT_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        target,
        cursor: ["button", "a"].includes(target)
          ? "pointer"
          : ["input", "textarea"].includes(target)
          ? "text"
          : "default",
      });
      return;
    }
    if (message.kind === SESSION_HOST_INSPECT_KIND) {
      if (session === null) throw new Error("The session is not started");
      const frame = await session.render();
      postMessage({
        kind: SESSION_HOST_INSPECT_RESULT_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        ...inspection.serializeInspection(sessionDocument, frame),
      });
      return;
    }
    if (message.kind === SESSION_HOST_STYLE_SET_KIND) {
      if (session === null) throw new Error("The session is not started");
      const target = inspection.elementFor(message.identifier);
      if (target === undefined) {
        throw new RangeError(
          `Unknown inspection node ${String(message.identifier)}`,
        );
      }
      if (message.value === "" || message.value === null) {
        target.style.removeProperty(message.property);
      } else {
        target.style.setProperty(message.property, String(message.value));
      }
      await session.render();
      return;
    }
    if (message.kind === SESSION_HOST_RESIZE_KIND) {
      if (session === null) throw new Error("The session is not started");
      screen.width = message.width * message.deviceScale;
      screen.height = message.height * message.deviceScale;
      await session.resize({
        width: message.width,
        height: message.height,
        deviceScale: message.deviceScale,
      });
      return;
    }
    throw new RangeError(
      `Unhandled session host message ${JSON.stringify(message.kind)}`,
    );
  })().catch((error) => {
    postMessage({
      kind: SESSION_HOST_FAILED_KIND,
      version: SESSION_HOST_PROTOCOL_VERSION,
      message: String(error?.stack ?? error),
    });
  });
};
