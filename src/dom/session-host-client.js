// The browser session host client: one factory that mounts a session into
// the session host worker, transfers the screen canvas, and returns a
// session handle (plans/PLAN-browser-session-host.md, extracted from
// Sandtable's render-pane createEmbedSession of 2026-09-01).
//
// Warm realm reuse (protocol v2): spawning a worker per session pays the
// engine module import and parse per worker realm (~665ms cold against
// 2-4ms steady frames, plan's Cold start section). The factory therefore
// keeps one warm worker per workerURL: release() ends the session on the
// worker (protocol END/ENDED) and parks the worker; the next
// createSessionHost for the same workerURL re-mounts into it, importing
// nothing. Reuse is the default because the teardown contract is proven
// at the source (test/surfaces-and-hosts/session_host_reuse_test.js: custom elements,
// globals, observers, and stylesheets from a previous session are
// unreachable; fonts and module registries are retained by design), and
// because every reuse failure is loud: a failed or overdue END degrades
// to a hard worker.terminate() and rejects both release() and the
// handle's failure promise, so the next session simply spawns cold.
// Reuse is an optimization, never a correctness trade; reuse: false opts
// a handle out entirely.
//
// terminate() stays the hard teardown: it kills the worker immediately
// and never parks it.
//
// Failure is loud, never silent: the worker's failed message, a worker
// error event, and a protocol version mismatch each reject every in-flight
// request waiter AND the handle's failure promise; a pre-start failure
// rejects the started promise. terminate() and release() reject every
// in-flight waiter, so no promise this handle returns pends forever.
//
// Module resolution stays the caller's duty: the caller supplies
// worker-reachable module URLs (module, contractModule), because workers
// do not read document import maps.

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

// The real display's capabilities, measured where they are observable -
// the page realm. The worker cannot see the display; without this
// declaration the session's media queries answer standard/sRGB and HDR
// content self-selects SDR. Callers override for pinned-appearance uses
// (deterministic capture wants declared, not ambient, capabilities).
export function measureDisplay() {
  const matches = (query) =>
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(query).matches;
  const colorGamut = matches("(color-gamut: rec2020)")
    ? "rec2020"
    : matches("(color-gamut: p3)")
    ? "p3"
    : "srgb";
  const dynamicRange = matches("(dynamic-range: high)") ? "high" : "standard";
  return { colorGamut, dynamicRange };
}
// One parked worker per workerURL, module-wide: a page hosts many
// sessions over its life but they share the worker script, so one warm
// realm per script is the whole win. The map value is { worker, unpark };
// unpark removes the parked eviction handlers before handing the worker
// to a new handle. Tests inject their own map through the warmPool
// option.
const defaultWarmPool = new Map();

export function createSessionHost({
  canvas,
  module,
  component,
  schema,
  instance,
  contractModule,
  fonts = [],
  stylesheets = [],
  width,
  height,
  deviceScale = globalThis.devicePixelRatio || 1,
  display = measureDisplay(),
  workerURL,
  workerName,
  Worker: WorkerConstructor = globalThis.Worker,
  onPresentationMode = null,
  onStep = null,
  reuse = true,
  warmPool = defaultWarmPool,
  // release() must not pend forever on a wedged worker: an END whose
  // ENDED acknowledgment misses this deadline is a teardown the client
  // cannot trust, so it degrades loudly to a hard terminate.
  releaseDeadlineMilliseconds = 5000,
}) {
  if (!canvas || typeof canvas !== "object") {
    throw new TypeError("createSessionHost requires a canvas");
  }
  if (typeof module !== "string" || module.length === 0) {
    throw new TypeError("createSessionHost requires a module locator");
  }
  if (typeof component !== "string" || component.length === 0) {
    throw new TypeError("createSessionHost requires a component tag name");
  }
  if (typeof contractModule !== "string" || contractModule.length === 0) {
    throw new TypeError("createSessionHost requires a contract module locator");
  }
  if (!(Number.isFinite(width) && width > 0) ||
    !(Number.isFinite(height) && height > 0)) {
    throw new RangeError("createSessionHost requires a positive viewport");
  }
  if (typeof WorkerConstructor !== "function") {
    throw new Error("createSessionHost requires Worker support");
  }
  // A screen canvas element transfers here; an OffscreenCanvas the caller
  // already holds passes through unchanged.
  const offscreen = typeof canvas.transferControlToOffscreen === "function"
    ? canvas.transferControlToOffscreen()
    : canvas;
  const resolvedWorkerURL = workerURL ??
    new URL("./session-host-worker.js", import.meta.url);
  const workerKey = String(resolvedWorkerURL);
  // Draw the warm worker for this script when one is parked; otherwise
  // spawn cold. A drawn worker entered the pool only through a clean
  // ENDED acknowledgment, so its realm retains fonts and module
  // registries and nothing else.
  let worker = null;
  let reused = false;
  if (reuse) {
    const parked = warmPool.get(workerKey);
    if (parked !== undefined) {
      warmPool.delete(workerKey);
      parked.unpark();
      worker = parked.worker;
      reused = true;
    }
  }
  if (worker === null) {
    worker = new WorkerConstructor(resolvedWorkerURL, {
      type: "module",
      name: workerName ?? `sandom-session-host-${component}`,
    });
  }
  let settled = false;
  let terminated = false;
  let currentDeviceScale = deviceScale;
  const waiters = { capture: null, input: null, inspect: null };
  const rejectWaiters = (error) => {
    for (const slot of Object.keys(waiters)) {
      waiters[slot]?.reject(error);
      waiters[slot] = null;
    }
  };
  let failed = null;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const routeFailure = (error) => {
    // A mount failure on a drawn warm worker names the reuse: the realm
    // retains fonts and module registries, so a component that fails
    // here but would mount on a fresh realm is a broken teardown
    // contract, not a component defect. The caller evicts the worker by
    // terminating or releasing the handle either way.
    const routed = reused && !settled
      ? new Error(
        `Warm session host mount failed on a reused worker: ${error.message}`,
        { cause: error },
      )
      : error;
    if (!settled) {
      settled = true;
      rejectStarted(routed);
    }
    rejectWaiters(routed);
    if (failed === null) {
      failed = routed;
      rejectFailure(routed);
    }
  };
  worker.onmessage = (event) => {
    const message = event.data;
    if (message?.version !== SESSION_HOST_PROTOCOL_VERSION) {
      routeFailure(
        new Error(
          `Session host protocol version mismatch: the worker sent ${
            JSON.stringify(message?.version)
          }, this client speaks ${SESSION_HOST_PROTOCOL_VERSION}`,
        ),
      );
      return;
    }
    if (message.kind === SESSION_HOST_STARTED_KIND) {
      settled = true;
      resolveStarted();
      return;
    }
    if (message.kind === SESSION_HOST_FAILED_KIND) {
      routeFailure(new Error(message.message));
      return;
    }
    if (message.kind === SESSION_HOST_CAPTURE_FRAME_KIND) {
      waiters.capture?.resolve(message);
      waiters.capture = null;
      return;
    }
    if (message.kind === SESSION_HOST_INSPECT_RESULT_KIND) {
      waiters.inspect?.resolve(message);
      waiters.inspect = null;
      return;
    }
    if (message.kind === SESSION_HOST_INPUT_RESULT_KIND) {
      waiters.input?.resolve(message);
      waiters.input = null;
      return;
    }
    if (message.kind === SESSION_HOST_PRESENTATION_MODE_KIND) {
      onPresentationMode?.({
        extended: message.extended,
        dynamicRange: message.dynamicRange,
      });
      return;
    }
    if (message.kind === SESSION_HOST_STEP_KIND) {
      onStep?.(message.name);
      return;
    }
    routeFailure(
      new RangeError(
        `Unhandled session host reply ${JSON.stringify(message.kind)}`,
      ),
    );
  };
  worker.onerror = (event) => {
    routeFailure(
      new Error(
        `session host worker error: ${event.message ?? "unknown"} ` +
          `(${event.filename ?? "?"}:${event.lineno ?? "?"})`,
      ),
    );
  };
  const post = (message, transfer = []) => {
    if (terminated) throw new Error("The session host is terminated");
    worker.postMessage(message, transfer);
  };
  const request = (slot, message) =>
    new Promise((resolve, reject) => {
      if (terminated) {
        reject(new Error("The session host is terminated"));
        return;
      }
      if (waiters[slot] !== null) {
        reject(new Error(`One session host ${slot} request is in flight`));
        return;
      }
      waiters[slot] = { resolve, reject };
      worker.postMessage(message);
    });
  post({
    kind: SESSION_HOST_START_KIND,
    version: SESSION_HOST_PROTOCOL_VERSION,
    canvas: offscreen,
    width,
    height,
    deviceScale,
    module,
    component,
    schema,
    instance,
    contractModule,
    fonts: [...fonts],
    stylesheets: [...stylesheets],
    display: { ...display },
  }, [offscreen]);
  return {
    started,
    failure,
    present(enabled) {
      post({
        kind: SESSION_HOST_PRESENT_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        enabled: enabled === true,
      });
    },
    input(records) {
      return request("input", {
        kind: SESSION_HOST_INPUT_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        records,
      });
    },
    inspect() {
      return request("inspect", {
        kind: SESSION_HOST_INSPECT_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
      });
    },
    setNodeStyle(identifier, property, value) {
      post({
        kind: SESSION_HOST_STYLE_SET_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        identifier,
        property,
        value,
      });
    },
    capture() {
      return request("capture", {
        kind: SESSION_HOST_CAPTURE_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
      });
    },
    resize(viewport) {
      const nextDeviceScale = viewport.deviceScale ?? currentDeviceScale;
      post({
        kind: SESSION_HOST_RESIZE_KIND,
        version: SESSION_HOST_PROTOCOL_VERSION,
        width: viewport.width,
        height: viewport.height,
        deviceScale: nextDeviceScale,
      });
      currentDeviceScale = nextDeviceScale;
    },
    // reused: whether this session mounted into a drawn warm worker
    // (false means a cold spawn). Callers use it for measurement and
    // reporting only; the handle behaves identically either way.
    reused,
    terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
      const error = new Error("The session host is terminated");
      if (!settled) {
        settled = true;
        rejectStarted(error);
      }
      rejectWaiters(error);
    },
    // Warm teardown: end the session on the worker and park the worker
    // for the next same-script session. Resolves once the worker is
    // parked (or hard-terminated by pool policy). Rejects - and rejects
    // the failure promise - when the worker cannot prove a clean
    // teardown: a failed END, an unexpected reply, a worker error, or a
    // missed acknowledgment deadline each hard-terminate the worker, so
    // the next session spawns cold. That is degraded reuse: loud, never
    // a correctness trade.
    release() {
      if (terminated) {
        return Promise.reject(new Error("The session host is terminated"));
      }
      terminated = true;
      const releaseError = new Error("The session host is released");
      if (!settled) {
        settled = true;
        rejectStarted(releaseError);
      }
      rejectWaiters(releaseError);
      if (!reuse) {
        worker.terminate();
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const degrade = (cause) => {
          clearTimeout(deadline);
          worker.terminate();
          const degraded = new Error(
            "Degraded session host reuse: the warm teardown failed and " +
              "the worker is terminated; the next session spawns cold",
            { cause },
          );
          if (failed === null) {
            failed = degraded;
            rejectFailure(degraded);
          }
          reject(degraded);
        };
        const deadline = setTimeout(
          () =>
            degrade(
              new Error(
                "The end-session acknowledgment did not arrive within " +
                  `${releaseDeadlineMilliseconds}ms`,
              ),
            ),
          releaseDeadlineMilliseconds,
        );
        worker.onmessage = (event) => {
          const reply = event.data;
          if (reply?.version !== SESSION_HOST_PROTOCOL_VERSION) {
            degrade(
              new Error(
                `Session host protocol version mismatch: the worker sent ${
                  JSON.stringify(reply?.version)
                }, this client speaks ${SESSION_HOST_PROTOCOL_VERSION}`,
              ),
            );
            return;
          }
          if (reply.kind === SESSION_HOST_ENDED_KIND) {
            clearTimeout(deadline);
            if (warmPool.has(workerKey)) {
              // Pool policy, not a failure: one warm worker per script
              // is the whole win, a second one is just a leak.
              worker.terminate();
              resolve();
              return;
            }
            // Parked eviction: a worker that errors or speaks while
            // parked is not trustworthy; evict and terminate it, then
            // rethrow so the defect surfaces as an unhandled error
            // instead of vanishing with the pool entry.
            const evict = (cause) => {
              warmPool.delete(workerKey);
              worker.terminate();
              throw new Error(
                "A parked session host worker failed; evicted from the " +
                  "warm pool",
                { cause },
              );
            };
            worker.onmessage = (parkedEvent) =>
              evict(
                new Error(
                  `unexpected parked reply ${
                    JSON.stringify(parkedEvent.data?.kind)
                  }`,
                ),
              );
            worker.onerror = (parkedEvent) =>
              evict(new Error(String(parkedEvent.message ?? "worker error")));
            warmPool.set(workerKey, {
              worker,
              unpark() {
                worker.onmessage = null;
                worker.onerror = null;
              },
            });
            resolve();
            return;
          }
          if (reply.kind === SESSION_HOST_FAILED_KIND) {
            // This FAILED can also belong to a request that raced the
            // END, not to the teardown itself; degrading on it is the
            // safe direction (hard terminate, cold respawn), and loud.
            degrade(new Error(reply.message));
            return;
          }
          if (
            reply.kind === SESSION_HOST_STEP_KIND ||
            reply.kind === SESSION_HOST_PRESENTATION_MODE_KIND ||
            reply.kind === SESSION_HOST_CAPTURE_FRAME_KIND ||
            reply.kind === SESSION_HOST_INSPECT_RESULT_KIND ||
            reply.kind === SESSION_HOST_INPUT_RESULT_KIND
          ) {
            // Late breadcrumbs and replies to requests that were in
            // flight when release() rejected their waiters: the worker
            // processes messages in order, so these precede the END's
            // own acknowledgment and are harmless.
            return;
          }
          degrade(
            new RangeError(
              `Unhandled session host reply ${JSON.stringify(reply.kind)} ` +
                "while awaiting the end-session acknowledgment",
            ),
          );
        };
        worker.onerror = (event) =>
          degrade(
            new Error(
              `session host worker error: ${event.message ?? "unknown"}`,
            ),
          );
        worker.postMessage({
          kind: SESSION_HOST_END_KIND,
          version: SESSION_HOST_PROTOCOL_VERSION,
        });
      });
    },
  };
}
