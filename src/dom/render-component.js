import {
  acquireAmbientGlobalOwnership,
  installComponentGlobals,
  restoreAmbientGlobalDescriptors,
  snapshotAmbientGlobalDescriptors,
} from "./component-globals.js";
import {
  createComponentEnvironment,
  normalizeComponentEnvironmentOptions,
} from "./component-environment.js";
import { closeComponentCode, enterComponentCode } from "./component-code.js";
import { createSandomDOM } from "./sandom-dom.js";
import { documentClockFromOptions } from "./document-clock.js";
import { normalizeInputBatch } from "./interaction.js";
import { createPreparedDocument } from "./prepared-document.js";
import { SandomViewport } from "./viewport.js";
import { buildAccessibilitySnapshot } from "./accessibility.js";
import { prepareNativeWebgl2Host } from "../native-webgl2-adapter.js";
import { createSceneRenderer } from "../scene-renderer.js";
import { validateClosedRecord } from "../closed-record.js";
import { validateSandomHost } from "../host/contract.js";
import { eraseEventListenersAndHandlers } from "./event-handlers.js";
import { hostNow } from "../host-clock.js";

function positiveDimension(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return number;
}

function readinessPromise(value, name) {
  if (value === undefined) return null;
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null || typeof value.then !== "function"
  ) {
    throw new TypeError(`${name} must be a promise`);
  }
  return Promise.resolve(value);
}

function validateMountResult(result) {
  if (result === undefined) {
    return Object.freeze({ ready: null, dispose: null });
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("mount must return undefined or an object");
  }
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !["ready", "dispose"].includes(key)) {
      throw new TypeError(`Unknown mount result field ${String(key)}`);
    }
  }
  if (result.dispose !== undefined && typeof result.dispose !== "function") {
    throw new TypeError("mount result dispose must be a function");
  }
  return Object.freeze({
    ready: readinessPromise(result.ready, "mount result ready"),
    dispose: result.dispose ?? null,
  });
}

function cleanupAggregate(primaryError, cleanupErrors, message) {
  if (cleanupErrors.length === 0) return primaryError;
  return new AggregateError([primaryError, ...cleanupErrors], message);
}
function collectCleanupError(errors, error) {
  errors.push(...(error instanceof AggregateError ? error.errors : [error]));
}

const PREFERENCE_VALUES = Object.freeze({
  colorScheme: ["light", "dark"],
  reducedMotion: ["no-preference", "reduce"],
});

// The user's preferences, as prefers-color-scheme and prefers-reduced-motion
// name them, to style-environment values. Absent keys stay unchanged.
function preferenceEnvironment(preferences, name) {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new TypeError(`${name} must be an object`);
  }
  const environment = {};
  for (const [key, value] of Object.entries(preferences)) {
    const allowed = PREFERENCE_VALUES[key];
    if (allowed === undefined) {
      throw new TypeError(`${name} contains unknown field ${key}; expected colorScheme or reducedMotion`);
    }
    if (!allowed.includes(value)) {
      throw new RangeError(`${name}.${key} is ${JSON.stringify(value)}; expected ${allowed.map((entry) => JSON.stringify(entry)).join(" or ")}`);
    }
    if (key === "colorScheme") environment.colorScheme = value;
    else environment.reducedMotion = value === "reduce";
  }
  return environment;
}

const COMPONENT_OPTION_NAMES = new Set([
  "mount",
  "width",
  "height",
  "deviceScale",
  "ready",
  "url",
  "stylesheets",
  "graphicsBackend",
  "presentFrame",
  "display",
  "preferences",
  "reportException",
  "environment",
  "host",
  "now",
  "requestFrame",
  "cancelFrame",
  "timeOrigin",
]);

export async function renderComponent(
  options,
  { createSandomDOM: createRuntimeDOM = createSandomDOM, core, fontRegistry } = {},
) {
  validateClosedRecord(options, COMPONENT_OPTION_NAMES, "renderComponent options");
  validateSandomHost(options.host, "renderComponent");
  if (typeof options.mount !== "function") {
    throw new TypeError("renderComponent mount must be a function");
  }
  const mount = options.mount;
  const width = positiveDimension(options.width, "width");
  const height = positiveDimension(options.height, "height");
  const deviceScale = positiveDimension(
    options.deviceScale ?? 1,
    "deviceScale",
  );
  const optionReady = readinessPromise(options.ready, "ready");
  const documentURL = new URL(options.url ?? "about:blank").href;
  const stylesheets = options.stylesheets ?? [];
  const graphicsBackend = options.graphicsBackend ?? "auto";
  const presentFrame = options.presentFrame ?? null;
  if (presentFrame !== null && typeof presentFrame !== "function") {
    throw new TypeError("renderComponent presentFrame must be a function");
  }
  // The host's declaration of the real display: the session's media
  // queries answer (color-gamut) and (dynamic-range) from these, and a
  // high dynamic range switches the render pipeline to its HDR working
  // mode so components' extended values survive to presentation. The
  // engine cannot observe the display from inside a worker realm - only
  // the host can, so silence here means the truthful defaults (p3 gamut,
  // standard range) and HDR content self-selects SDR.
  const display = options.display ?? {};
  if (typeof display !== "object" || Array.isArray(display)) {
    throw new TypeError("renderComponent display must be an object");
  }
  for (const key of Object.keys(display)) {
    if (key !== "colorGamut" && key !== "dynamicRange") {
      throw new TypeError(`Unknown display option ${String(key)}`);
    }
  }
  const displayColorGamut = display.colorGamut ?? null;
  if (
    displayColorGamut !== null &&
    !["srgb", "p3", "rec2020"].includes(displayColorGamut)
  ) {
    throw new RangeError(
      `Unknown display.colorGamut ${JSON.stringify(displayColorGamut)}`,
    );
  }
  const displayDynamicRange = display.dynamicRange ?? null;
  if (
    displayDynamicRange !== null &&
    !["standard", "high"].includes(displayDynamicRange)
  ) {
    throw new RangeError(
      `Unknown display.dynamicRange ${JSON.stringify(displayDynamicRange)}`,
    );
  }
  // The user's preferences that media queries read (prefers-color-scheme,
  // prefers-reduced-motion); light and no-preference when absent.
  const initialPreferences = preferenceEnvironment(
    options.preferences ?? {},
    "renderComponent preferences",
  );
  const callerReportException = options.reportException ?? null;
  if (
    callerReportException !== null &&
    typeof callerReportException !== "function"
  ) {
    throw new TypeError("renderComponent reportException must be a function");
  }
  // Background exceptions - custom-element lifecycle failures, throwing
  // animation-frame callbacks, rejected loop-scheduled renders - have no
  // awaiting caller. Left unrouted they surface only as a host error
  // event: a crash in Deno, silence in a browser worker (proven by an
  // Exactas plot whose colour resolution threw during initialization and
  // left the session mute). By default the first one becomes a sticky
  // session failure: setup throws it, and every later session operation
  // rejects naming it. A caller-supplied reportException takes ownership
  // instead. The session claims only exceptions of component code that it
  // enters (src/dom/component-code.js); the host program's own exceptions
  // stay the runtime's.
  let backgroundException = null;
  const reportSessionException = callerReportException ?? ((error) => {
    backgroundException ??= error;
  });
  const thrownBackgroundException = () =>
    new Error(
      "The component session reported an unhandled background exception",
      { cause: backgroundException },
    );
  const normalizedEnvironment = normalizeComponentEnvironmentOptions(
    options.environment,
    globalThis,
  );
  if (!["auto", "webgpu", "webgl2"].includes(graphicsBackend)) {
    throw new RangeError(
      `Unknown graphicsBackend ${JSON.stringify(graphicsBackend)}`,
    );
  }
  // The session's clock: the document's clock (src/dom/document-clock.js),
  // which its surface and its page read; the host's real clock when
  // omitted. Pass `timeOrigin` with `now`: it is the page's date at time 0,
  // and without it the page's `Date` starts at the Unix epoch; page scripts
  // may need the current date.
  const clock = documentClockFromOptions(options, "renderComponent options");

  const lifecycleSpans = [];
  const recordSpan = async (name, operation) => {
    const startTime = hostNow();
    try {
      const value = await operation();
      const endTime = hostNow();
      lifecycleSpans.push(Object.freeze({
        name,
        startTime,
        endTime,
        duration: endTime - startTime,
        outcome: "fulfilled",
      }));
      return value;
    } catch (error) {
      const endTime = hostNow();
      lifecycleSpans.push(Object.freeze({
        name,
        startTime,
        endTime,
        duration: endTime - startTime,
        outcome: "rejected",
      }));
      throw error;
    }
  };

  if (graphicsBackend === "webgl2") await prepareNativeWebgl2Host();

  const releaseAmbientOwnership = await acquireAmbientGlobalOwnership(
    "component-session",
  );
  const previousGlobalDescriptors = snapshotAmbientGlobalDescriptors();
  const abortController = new AbortController();
  let preparedDocument = null;
  let surface = null;
  let mountDispose = null;
  let globalsInstalled = false;
  let componentEnvironment = null;
  let currentFrame = null;
  let documentRevision = 0;
  let interactionRevision = 0;
  let presentationRevision = 0;
  let accessibilityRevision = 0;
  let nextNodeIdentifier = 1;
  const nodeIdentifiers = new WeakMap();
  const publishedFrames = new WeakMap();
  let precedingAccessibilitySnapshot = null;
  let ownershipReleased = false;

  try {
    preparedDocument = await recordSpan(
      "document creation",
      () =>
        createPreparedDocument({
          core,
          fontRegistry,
          url: documentURL,
          host: options.host,
          windowTarget: null,
          clock,
          reportException: reportSessionException,
        }),
    );
    const document = preparedDocument.document;
    if (displayColorGamut !== null || displayDynamicRange !== null) {
      document._styleSystem.setEnvironment({
        ...(displayColorGamut === null ? {} : { colorGamut: displayColorGamut }),
        ...(displayDynamicRange === null
          ? {}
          : { dynamicRange: displayDynamicRange }),
      });
    }
    // Before the first style resolution: matchMedia during mount answers
    // for the preferences.
    document._styleSystem.setEnvironment(initialPreferences);
    const html = document.createElement("html");
    const head = document.createElement("head");
    const body = document.createElement("body");
    document.appendChild(html);
    html.append(head, body);
    const container = document.createElement("div");
    container.setAttribute("data-sandom-component-root", "");
    body.appendChild(container);
    const componentViewport = new SandomViewport({
      width,
      height,
      deviceScale,
    });
    const backend = createRuntimeDOM({
      viewportW: width,
      viewportH: height,
      deviceScale,
      document,
    });
    componentEnvironment = createComponentEnvironment({
      document,
      url: documentURL,
      viewport: componentViewport,
      target: globalThis,
      options: normalizedEnvironment,
    });
    await recordSpan("global installation", () => {
      globalsInstalled = true;
      installComponentGlobals(
        globalThis,
        preparedDocument.document,
        componentEnvironment,
      );
    });
    surface = backend.createRenderSurface(document.documentElement, {
      capturePaintArtifact: true,
      graphicsBackend,
      viewport: componentViewport,
      initializePersistentRenderer: false,
      // A high-dynamic-range display switches the working encoding to the
      // HDR pipeline so extended component values survive to presentFrame.
      ...(displayDynamicRange === "high"
        ? { renderMode: "high-dynamic-range" }
        : {}),
      // Presentation delivery (zero-copy): every frame is the renderer's
      // texture image plus device (webgpu) or an explicit pixel frame (the
      // webgl2 fallback). Pixels are an explicit request through
      // session.render({ pixels: true }).
      presentFrame,
      createPersistentRenderer: (rendererOptions) =>
        (document._sandomSceneRendererRuntime?.createSceneRenderer ??
          createSceneRenderer)({
          ...rendererOptions,
          graphicsDevice: document._preferredCanvasDevice ?? undefined,
        }),
    });
    surface.stop();
    const identifyNode = (node) => {
      let identifier = nodeIdentifiers.get(node);
      if (!identifier) {
        identifier = `node-${nextNodeIdentifier++}`;
        nodeIdentifiers.set(node, identifier);
      }
      return identifier;
    };
    // Lazily published inspection fields (frame-incrementality): the
    // accessibility snapshot, interactive text geometry, and control-state
    // diff are inspection surfaces consumers read on demand, not per
    // frame. Each published frame computes them on first access and
    // caches the result on the frame; the inputs that are per-frame state
    // (the interaction snapshot, the revisions, the preceding baseline)
    // are captured at publication. The DOM itself is read at resolution
    // time - a consumer that reads immediately after the operation
    // resolves sees exactly what an eager snapshot held.
    //
    // A delivery is a publication. The surface re-delivers the presented
    // frame object when nothing changed (a retained delivery), and each
    // delivery still advances the revisions and takes its own baseline;
    // the memo only pairs the listener's publication with the same
    // delivery's renderNow() result.
    const accessibilityResolvers = new WeakMap();
    const publishFrame = (frame, { delivery = false } = {}) => {
      const existing = publishedFrames.get(frame);
      if (existing && !delivery) return existing;
      documentRevision += 1;
      presentationRevision += 1;
      accessibilityRevision += 1;
      const publishedRevisions = {
        documentRevision,
        interactionRevision,
        presentationRevision,
        accessibilityRevision,
      };
      const presentedFrame = surface.presentedFrame;
      const precedingAccessibility = precedingAccessibilitySnapshot;
      precedingAccessibilitySnapshot = null;
      let accessibilityRecord = null;
      const resolveAccessibility = () => {
        accessibilityRecord ??= buildAccessibilitySnapshot({
          root: document.documentElement,
          presentedFrame,
          identify: identifyNode,
          ...publishedRevisions,
        });
        return accessibilityRecord;
      };
      let interactiveTextGeometry = null;
      let changedControlStates = null;
      const published = Object.freeze(Object.defineProperties({
        ...frame,
        ...publishedRevisions,
        focusIdentifier: document._focusedElement
          ? identifyNode(document._focusedElement)
          : null,
      }, {
        accessibility: {
          enumerable: true,
          get: () => resolveAccessibility().snapshot,
        },
        interactiveTextGeometry: {
          enumerable: true,
          get: () => {
            interactiveTextGeometry ??= Object.freeze(
              [...presentedFrame.textGeometryByElement].map(
                ([element, geometry]) =>
                  Object.freeze({
                    nodeIdentifier: identifyNode(element),
                    caretStops: geometry.caretStops,
                    selectionStart: geometry.selectionStart,
                    selectionEnd: geometry.selectionEnd,
                    selectionRectangles: presentedFrame.selectionRectanglesByElement.get(element) ?? Object.freeze([]),
                  }),
              ),
            );
            return interactiveTextGeometry;
          },
        },
        changedControlStates: {
          enumerable: true,
          get: () => {
            if (changedControlStates === null) {
              const precedingByIdentifier = new Map(
                (precedingAccessibility?.nodes ?? []).map((node) => [
                  node.identifier,
                  node,
                ]),
              );
              changedControlStates = Object.freeze(
                resolveAccessibility().snapshot.nodes.flatMap(
                  (node) => {
                    const preceding = precedingByIdentifier.get(
                      node.identifier,
                    );
                    const changed = !preceding ||
                      preceding.value !== node.value ||
                      preceding.checked !== node.checked ||
                      preceding.pressed !== node.pressed ||
                      preceding.expanded !== node.expanded ||
                      preceding.selected !== node.selected ||
                      preceding.disabled !== node.disabled ||
                      preceding.focused !== node.focused;
                    return changed
                      ? [Object.freeze({
                        nodeIdentifier: node.identifier,
                        value: node.value,
                        checked: node.checked,
                        pressed: node.pressed,
                        expanded: node.expanded,
                        selected: node.selected,
                        disabled: node.disabled,
                        focused: node.focused,
                      })]
                      : [];
                  },
                ),
              );
            }
            return changedControlStates;
          },
        },
      }));
      accessibilityResolvers.set(published, resolveAccessibility);
      publishedFrames.set(frame, published);
      return published;
    };
    surface.onFrame((frame) => {
      currentFrame = publishFrame(frame, { delivery: true });
    });

    await recordSpan("stylesheet attachment and parse", async () => {
      preparedDocument.attachStylesheets(stylesheets);
      await preparedDocument.ready();
    });

    let mountResult;
    await recordSpan("component mount", async () => {
      mountResult = await enterComponentCode(document, mount, undefined, [
        Object.freeze({
          window: globalThis,
          document,
          container,
          signal: abortController.signal,
        }),
      ]);
    });
    if (
      mountResult && typeof mountResult === "object" &&
      typeof mountResult.dispose === "function"
    ) {
      mountDispose = mountResult.dispose;
    }
    const validatedMountResult = validateMountResult(mountResult);
    mountDispose = validatedMountResult.dispose;

    await recordSpan("explicit readiness", async () => {
      await Promise.all(
        [optionReady, validatedMountResult.ready].filter((ready) => ready),
      );
    });
    await recordSpan(
      "document resource readiness",
      () => preparedDocument.ready(),
    );
    if (backgroundException !== null) throw thrownBackgroundException();

    let disposeRequested = false;
    let disposalPromise = null;
    let disposalRestoreAmbientGlobals = null;
    let operationChain = Promise.resolve();
    let firstFrameRecorded = false;

    const runOperation = (operation) => {
      if (disposeRequested) {
        return Promise.reject(new Error("The component session is disposed"));
      }
      if (backgroundException !== null) {
        return Promise.reject(thrownBackgroundException());
      }
      const result = operationChain.then(operation, operation);
      operationChain = result.then(() => undefined, () => undefined);
      return result;
    };

    const renderCurrentSurface = async ({ pixels = false } = {}) => {
      surface.stop();
      await surface.whenIdle();
      // Input handlers schedule follow-up work on zero-delay tasks (Radix
      // moves focus from a timer); one task turn lets it land so the frame
      // after a dispatch reflects it. A full raster's device awaits used to
      // provide that turn by accident; a retained delivery has none.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const render = () => surface.renderNow({ pixels });
        const frame = firstFrameRecorded
          ? await recordSpan("capture or inspection", render)
          : await recordSpan(
            "first layout",
            () => recordSpan("first paint", render),
          );
        firstFrameRecorded = true;
        if (!frame) {
          throw new Error("The live component surface did not produce a frame");
        }
        currentFrame = publishFrame(frame);
        if (backgroundException !== null) throw thrownBackgroundException();
        return currentFrame;
      } finally {
        if (!disposeRequested && document.visibilityState === "visible") surface.start();
      }
    };

    const dispatchRecords = async (records, ready) => {
      if (!currentFrame) await renderCurrentSurface();
      // The changed-control-state baseline is control state BEFORE this
      // dispatch's input applies. Resolving the current frame's lazy
      // accessibility snapshot here (cached on the frame) captures it
      // ahead of any backend mutation below.
      const dispatchBaselineAccessibility = currentFrame.accessibility;
      const normalizedRecords = normalizeInputBatch(records);
      for (const record of normalizedRecords) {
        if (record.kind !== "accessibility-action") continue;
        if (
          record.accessibilityRevision !== currentFrame.accessibilityRevision
        ) {
          throw new Error(
            `Stale accessibility revision: expected ${currentFrame.accessibilityRevision}, received ${record.accessibilityRevision}`,
          );
        }
        const semanticNode = currentFrame.accessibility.nodes.find((node) =>
          node.identifier === record.nodeIdentifier
        );
        if (!semanticNode) {
          throw new RangeError(
            `Unknown semantic node: ${record.nodeIdentifier}`,
          );
        }
        if (!semanticNode.actions.includes(record.action)) {
          throw new RangeError(
            `Semantic node ${record.nodeIdentifier} does not support ${record.action}`,
          );
        }
      }
      const root = document.documentElement;
      const inputRecords = normalizedRecords.map((record) => {
        if (record.kind !== "accessibility-action") return record;
        const target = accessibilityResolvers.get(currentFrame)()
          .nodeByIdentifier.get(record.nodeIdentifier);
        if (!target) {
          throw new RangeError(
            `Unknown semantic node: ${record.nodeIdentifier}`,
          );
        }
        return { ...record, target };
      });
      backend.dispatchInputRecords(root, inputRecords);
      if (ready) await ready;
      precedingAccessibilitySnapshot = dispatchBaselineAccessibility;
      interactionRevision += 1;
      try {
        return await renderCurrentSurface();
      } catch (error) {
        interactionRevision -= 1;
        precedingAccessibilitySnapshot = null;
        throw error;
      }
    };

    const session = Object.freeze({
      render(request = {}) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          return Promise.reject(
            new TypeError("render request must be an object"),
          );
        }
        for (const key of Reflect.ownKeys(request)) {
          if (key !== "pixels") {
            return Promise.reject(
              new TypeError(`Unknown render request option ${String(key)}`),
            );
          }
        }
        if (request.pixels !== undefined && typeof request.pixels !== "boolean") {
          return Promise.reject(
            new TypeError("render request pixels must be a boolean"),
          );
        }
        return runOperation(() =>
          renderCurrentSurface({ pixels: request.pixels === true })
        );
      },
      inspect(request = {}) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          return Promise.reject(
            new TypeError("inspect request must be an object"),
          );
        }
        return runOperation(async () => {
          const frame = await renderCurrentSurface();
          return frame.inspection;
        });
      },
      // The display-list artifact of the current frame: every paint command
      // with its geometry, and each text command's glyphs, font and color.
      displayList() {
        return runOperation(async () => {
          await renderCurrentSurface();
          return await surface.createDisplayListArtifact();
        });
      },
      dispatch(records, request = {}) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          return Promise.reject(
            new TypeError("dispatch settlement options must be an object"),
          );
        }
        for (const key of Reflect.ownKeys(request)) {
          if (key !== "ready") {
            return Promise.reject(
              new TypeError(
                `Unknown dispatch settlement option ${String(key)}`,
              ),
            );
          }
        }
        let ready;
        try {
          ready = readinessPromise(request.ready, "dispatch ready");
        } catch (error) {
          return Promise.reject(error);
        }
        return runOperation(() => dispatchRecords(records, ready));
      },
      resize(environment) {
        return runOperation(async () => {
          if (
            !environment || typeof environment !== "object" ||
            Array.isArray(environment)
          ) {
            throw new TypeError("resize environment must be an object");
          }
          const nextWidth = positiveDimension(environment.width, "width");
          const nextHeight = positiveDimension(environment.height, "height");
          const nextDeviceScale = positiveDimension(
            environment.deviceScale ?? surface.viewport.deviceScale,
            "deviceScale",
          );
          surface.viewport.resizeTo(
            nextWidth,
            nextHeight,
            nextDeviceScale,
          );
          enterComponentCode(document, () => {
            componentEnvironment.viewportDidResize();
            globalThis.dispatchEvent(new Event("resize"));
            globalThis.visualViewport.dispatchEvent(new Event("resize"));
          }, undefined, []);
          return await renderCurrentSurface();
        });
      },
      // The user's preferences change, as when the user switches the
      // system to dark mode: the styles follow, and each MediaQueryList
      // whose result changes reads the new state and fires `change`.
      setPreferences(preferences) {
        return runOperation(async () => {
          document._styleSystem.setEnvironment(
            preferenceEnvironment(preferences, "setPreferences preferences"),
          );
          document._reevaluateMediaQueryLists?.();
          return await renderCurrentSurface();
        });
      },
      // Page visibility, as a browser tab: a hidden document runs no
      // animation frames, and its live loop stays stopped. An operation
      // still renders its frame on request. The page hears
      // visibilitychange. The page's timers keep running on the session's
      // clock.
      setVisibility(state) {
        return runOperation(async () => {
          document._setVisibilityState(state);
          if (state === "hidden") {
            surface.stop();
            await surface.whenIdle();
          } else {
            surface.start();
          }
        });
      },
      // The motion of the current state, after a frame renders it: the
      // render surface's motion inspection (classification, finite
      // duration).
      inspectMotion() {
        return runOperation(async () => {
          await renderCurrentSurface();
          return surface.inspectMotion();
        });
      },
      // Captures the current motion on its own clock, as the render
      // surface's captureFrames does: onFrame receives each frame, whose
      // pixels are borrowed until the next frame, and its return value is
      // ignored. The operation settles when the capture ends, with the
      // document's time at the motion's end; no other operation interleaves.
      captureFrames(request) {
        return runOperation(async () => {
          if (!request || typeof request !== "object" || Array.isArray(request)) {
            throw new TypeError("captureFrames request must be an object");
          }
          const { frameBudget, durationMilliseconds, onFrame } = request;
          if (typeof onFrame !== "function") {
            throw new TypeError("captureFrames onFrame must be a function");
          }
          await renderCurrentSurface();
          surface.stop();
          await surface.whenIdle();
          try {
            for await (const frame of surface.captureFrames({ frameBudget, durationMilliseconds })) {
              onFrame(frame);
            }
          } finally {
            if (!disposeRequested && document.visibilityState === "visible") surface.start();
          }
          if (backgroundException !== null) throw thrownBackgroundException();
        });
      },
      subscribe(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("subscribe listener must be a function");
        }
        if (disposeRequested) {
          throw new Error("The component session is disposed");
        }
        return surface.onFrame((frame) => listener(publishFrame(frame)));
      },
      get resources() {
        return preparedDocument.resources;
      },
      get diagnostics() {
        return Object.freeze([
          ...preparedDocument.diagnostics,
          ...componentEnvironment.observations,
        ]);
      },
      get lifecycle() {
        return Object.freeze([...lifecycleSpans]);
      },
      async dispose(candidate = {}) {
        if (
          !candidate || typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          throw new TypeError("Component disposal options must be an object");
        }
        for (const key of Reflect.ownKeys(candidate)) {
          if (key !== "restoreAmbientGlobals") {
            throw new TypeError(
              `Unknown component disposal option ${String(key)}`,
            );
          }
        }
        if (
          candidate.restoreAmbientGlobals !== undefined &&
          typeof candidate.restoreAmbientGlobals !== "boolean"
        ) {
          throw new TypeError("restoreAmbientGlobals must be a boolean");
        }
        const restoreAmbientGlobals = candidate.restoreAmbientGlobals ?? true;
        if (disposalPromise) {
          if (restoreAmbientGlobals !== disposalRestoreAmbientGlobals) {
            throw new Error(
              "Component disposal already uses a different global policy",
            );
          }
          return await disposalPromise;
        }
        disposalRestoreAmbientGlobals = restoreAmbientGlobals;
        disposeRequested = true;
        disposalPromise = (async () => {
          await operationChain;
          const cleanupErrors = [];
          const disposeStartedAt = hostNow();
          abortController.abort();
          if (mountDispose) {
            try {
              await mountDispose();
            } catch (error) {
              collectCleanupError(cleanupErrors, error);
            }
          }
          // The page closes: no task that its component code scheduled
          // runs after this (src/dom/component-code.js).
          try {
            closeComponentCode(preparedDocument.document);
          } catch (error) {
            collectCleanupError(cleanupErrors, error);
          }
          if (surface) {
            try {
              surface.stop();
              await surface.whenIdle();
              await surface.shutdown();
            } catch (error) {
              collectCleanupError(cleanupErrors, error);
            }
          }
          // The realm's global object outlives the session's window: the
          // listeners and handlers the page put on its window go with the
          // session, so the next session's window starts with none.
          if (globalsInstalled) {
            try {
              eraseEventListenersAndHandlers(globalThis, preparedDocument.document._domCore);
            } catch (error) {
              collectCleanupError(cleanupErrors, error);
            }
          }
          try {
            await preparedDocument.document._shutdownCanvasContexts();
          } catch (error) {
            collectCleanupError(cleanupErrors, error);
          }
          try {
            await preparedDocument.release();
          } catch (error) {
            collectCleanupError(cleanupErrors, error);
          }
          if (componentEnvironment) {
            try {
              componentEnvironment.dispose();
            } catch (error) {
              collectCleanupError(cleanupErrors, error);
            }
          }
          if (globalsInstalled && restoreAmbientGlobals) {
            try {
              restoreAmbientGlobalDescriptors(previousGlobalDescriptors);
            } catch (error) {
              collectCleanupError(cleanupErrors, error);
            }
          }
          try {
            releaseAmbientOwnership();
            ownershipReleased = true;
          } catch (error) {
            collectCleanupError(cleanupErrors, error);
          }
          const disposeEndedAt = hostNow();
          lifecycleSpans.push(Object.freeze({
            name: "disposal",
            startTime: disposeStartedAt,
            endTime: disposeEndedAt,
            duration: disposeEndedAt - disposeStartedAt,
            outcome: cleanupErrors.length === 0 ? "fulfilled" : "rejected",
          }));
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              cleanupErrors,
              `${cleanupErrors.length} component session cleanup stage(s) failed`,
            );
          }
        })();
        return await disposalPromise;
      },
    });
    return session;
  } catch (setupError) {
    abortController.abort();
    const cleanupErrors = [];
    if (mountDispose) {
      try {
        await mountDispose();
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (preparedDocument) {
      try {
        closeComponentCode(preparedDocument.document);
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (surface) {
      try {
        surface.stop();
        await surface.whenIdle();
        await surface.shutdown();
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (preparedDocument) {
      try {
        await preparedDocument.document._shutdownCanvasContexts();
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (globalsInstalled && preparedDocument) {
      try {
        eraseEventListenersAndHandlers(globalThis, preparedDocument.document._domCore);
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (preparedDocument) {
      try {
        await preparedDocument.release();
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (componentEnvironment) {
      try {
        componentEnvironment.dispose();
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (globalsInstalled) {
      try {
        restoreAmbientGlobalDescriptors(previousGlobalDescriptors);
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    if (!ownershipReleased) {
      try {
        releaseAmbientOwnership();
        ownershipReleased = true;
      } catch (error) {
        collectCleanupError(cleanupErrors, error);
      }
    }
    throw cleanupAggregate(
      setupError,
      cleanupErrors,
      "Component setup and cleanup failed",
    );
  }
}
