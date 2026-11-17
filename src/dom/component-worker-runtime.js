// canvas-presentation.js reads the host's navigator.gpu, HTMLCanvasElement
// and OffscreenCanvas when it loads. It loads before installComponentGlobals
// replaces them with the component's.
import "../canvas-presentation.js";
import { parseHTMLDocument } from "./html.js";
import { installComponentGlobals } from "./component-globals.js";
import { createSandomRuntime } from "../runtime.js";

let document = null;
let dom = null;
let surface = null;
let runtime = null;

async function onMessage(event) {
  const { identifier, operation, arguments: argumentsValue = {} } = event.data;
  try {
    let value;
    if (operation === "initialize") {
      dom = runtime.createSandomDOM();
      document = parseHTMLDocument(argumentsValue.html, () => dom.document);
      document.contentType = "text/html";
      installComponentGlobals(globalThis, document);
      // The embedder owns fonts: each supplied face registers under its
      // authored family name (generic names included), so worker-side CSS
      // resolves without a system font resolver in this realm.
      for (const font of argumentsValue.fonts ?? []) {
        if (!(font.bytes instanceof Uint8Array)) {
          throw new TypeError("Runtime font bytes must be a Uint8Array");
        }
        await runtime.loadFont(font.family, font.bytes, {
          weight: font.weight ?? 400,
          style: font.style ?? "normal",
        });
      }
      const componentLoader =
        globalThis[Symbol.for("sandom.componentLoader")] ??
          (() => import(argumentsValue.moduleSpecifier));
      delete globalThis[Symbol.for("sandom.componentLoader")];
      await componentLoader();
      if (globalThis.__ready) await globalThis.__ready;
      value = globalThis.__results ?? null;
    } else if (operation === "render") {
      if (!document?.documentElement) {
        throw new Error("Component host is not initialized");
      }
      if (!surface) {
        dom.viewport.resizeTo(
          argumentsValue.viewportWidth,
          argumentsValue.viewportHeight,
        );
        surface = await dom.createRenderSurface(document.documentElement);
      }
      let frame;
      let deliveredFrame;
      let resolveDeliveredFrame;
      const delivery = new Promise((resolve) =>
        resolveDeliveredFrame = resolve
      );
      const unsubscribe = surface.onFrame((candidate) => {
        deliveredFrame = candidate;
        resolveDeliveredFrame();
      });
      try {
        // The host boundary transfers bytes; a GPU texture cannot cross it.
        frame = await surface.renderNow({ pixels: true });
        if (!frame) {
          await delivery;
          frame = deliveredFrame;
        }
      } catch (error) {
        throw new Error(`Rendering component frame failed: ${error.message}`);
      } finally {
        unsubscribe();
      }
      value = {
        dirtyRectangles: frame.dirtyRectangles,
        pixels: frame.pixels,
        width: frame.width,
        height: frame.height,
        deviceScale: frame.deviceScale,
        frameSequence: frame.frameSequence,
      };
    } else if (operation === "callGlobal") {
      const callable = globalThis[argumentsValue.name];
      if (typeof callable !== "function") {
        throw new TypeError(`Global "${argumentsValue.name}" is not callable`);
      }
      value = await callable(...argumentsValue.arguments);
    } else if (operation === "global") {
      const candidate = globalThis[argumentsValue.name];
      value = candidate instanceof Promise ? await candidate : candidate;
    } else if (operation === "shutdown") {
      surface?.shutdown();
      surface = null;
      value = true;
    } else {
      throw new TypeError(`Unknown component host operation "${operation}"`);
    }
    self.postMessage({ identifier, value });
  } catch (error) {
    self.postMessage({
      identifier,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      },
    });
  }
}

export async function installComponentWorker(options = {}) {
  runtime = await createSandomRuntime(options);
  self.onmessage = onMessage;
  self.postMessage({ operation: "ready" });
}
