// The binding of retained transitions
// (docs/design/component-rendering.md#retained-transitions) to the renderer
// core's revision records (core/engine/component-revisions.watpart).
//
// The core owns every decision: the queue order of steps, which step runs,
// whether a step publishes, fails, or was cancelled, the settlement limit,
// and every message. This binding retains the caller's applicator and
// callbacks for each step handle, runs the step that the core names, and
// reports to the core what the step did. Completion arrives through
// onPublished, onReady, and onFailed; a returned Promise signals nothing.
import { layoutConstant } from "../wasm/layout-table.js";
import { identifyCore } from "./core-identity.js";

const constant = (name) => layoutConstant(`REVISION_${name}`);
const STEP_TRANSITION = constant("STEP_TRANSITION");
const STEP_RESET = constant("STEP_RESET");
const CAUSE_APPLICATOR = constant("CAUSE_APPLICATOR");
const REPORT_FAILED = constant("REPORT_FAILED");
const REPORT_PUBLISHED = constant("REPORT_PUBLISHED");
const CAUSE_SETTLEMENT = constant("CAUSE_SETTLEMENT");
const RECORD = Object.freeze({
  HANDLE: constant("RECORD_HANDLE"),
  INSTANCE: constant("RECORD_INSTANCE"),
  ORDINAL: constant("RECORD_ORDINAL"),
  RESETS: constant("RECORD_RESETS"),
  SINCE_RESET: constant("RECORD_SINCE_RESET"),
});
const FINISH = Object.freeze({
  HEADER_SIZE: constant("FINISH_HEADER_SIZE"),
  INSTANCE: constant("FINISH_INSTANCE"),
  ORDINAL: constant("FINISH_ORDINAL"),
  COUNT: constant("FINISH_COUNT"),
  ENTRY_SIZE: constant("FINISH_ENTRY_SIZE"),
  STEP: constant("FINISH_STEP"),
  KIND: constant("FINISH_KIND"),
  CAUSE: constant("FINISH_CAUSE"),
  LIMIT: constant("FINISH_LIMIT"),
});
const SELECTION_DOCUMENT = layoutConstant("SELECTION_DOCUMENT");
const SELECTION_SUBTREE = layoutConstant("SELECTION_SUBTREE");
const SELECTION_LAYER = layoutConstant("SELECTION_LAYER");
const SELECTION_KIND_NAMES = new Map([
  [SELECTION_DOCUMENT, "document"],
  [SELECTION_SUBTREE, "subtree"],
  [SELECTION_LAYER, "layer"],
]);
const OBSERVATION_KINDS = new Map([
  ["structure", layoutConstant("OBSERVATION_STRUCTURE")],
  ["metrics", layoutConstant("OBSERVATION_METRICS")],
  ["paint", layoutConstant("OBSERVATION_PAINT")],
  ["raster", layoutConstant("OBSERVATION_RASTER")],
]);
const PROVENANCE = Object.freeze(Object.fromEntries([
  "OBSERVATION", "REVISION", "ARTIFACT", "SELECTION", "NODE", "INSTANCE", "ORDINAL", "RESETS",
  "SINCE_RESET", "SELECTION_KIND", "WIDTH", "HEIGHT", "DEVICE_SCALE", "TRAVERSAL",
  "PLACEMENT", "RASTER_WIDTH", "RASTER_HEIGHT",
].map((name) => [name, layoutConstant(`PROVENANCE_${name}`)])));
const TRAVERSAL_NAMES = new Map([
  [layoutConstant("TRAVERSAL_MOUNT"), "mount"],
  [layoutConstant("TRAVERSAL_RETAINED"), "retained"],
  [layoutConstant("TRAVERSAL_RESET"), "reset"],
]);

// The timer of the settlement limit is the host's, never a component
// realm's recorded timer.
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);

// The revision record in the output of $operation.
function readRevision(core, operation) {
  const view = core.output(operation);
  return Object.freeze({
    handle: view.getBigInt64(RECORD.HANDLE, true),
    instance: view.getUint32(RECORD.INSTANCE, true),
    ordinal: view.getUint32(RECORD.ORDINAL, true),
    resets: view.getUint32(RECORD.RESETS, true),
    transitionsSinceReset: view.getUint32(RECORD.SINCE_RESET, true),
  });
}

// The steps that operation $operation ended, each with the message that
// the core writes for it.
function readFinishList(core, operation) {
  const view = core.output(operation);
  const instance = view.getUint32(FINISH.INSTANCE, true);
  const ordinal = view.getUint32(FINISH.ORDINAL, true);
  const entries = [];
  for (let index = 0; index < view.getUint32(FINISH.COUNT, true); index++) {
    const at = FINISH.HEADER_SIZE + index * FINISH.ENTRY_SIZE;
    entries.push([
      view.getBigInt64(at + FINISH.STEP, true),
      view.getUint32(at + FINISH.KIND, true),
      view.getUint32(at + FINISH.CAUSE, true),
      view.getUint32(at + FINISH.LIMIT, true),
    ]);
  }
  return entries.map(([step, kind, cause, limit]) => {
    core.statusRaw("revision_step_message", instance, ordinal, step, kind, cause, limit);
    return { step, message: core.outputString("revision_step_message") };
  });
}

// The provenance that $operation wrote for a captured artifact.
function readProvenance(core, kind, operation) {
  const view = core.output(operation);
  return Object.freeze({
    observation: view.getBigInt64(PROVENANCE.OBSERVATION, true),
    kind,
    instance: view.getUint32(PROVENANCE.INSTANCE, true),
    revision: Object.freeze({
      handle: view.getBigInt64(PROVENANCE.REVISION, true),
      ordinal: view.getUint32(PROVENANCE.ORDINAL, true),
      resets: view.getUint32(PROVENANCE.RESETS, true),
      transitionsSinceReset: view.getUint32(PROVENANCE.SINCE_RESET, true),
    }),
    selection: Object.freeze({
      handle: view.getBigInt64(PROVENANCE.SELECTION, true),
      kind: SELECTION_KIND_NAMES.get(view.getUint32(PROVENANCE.SELECTION_KIND, true)),
    }),
    environment: Object.freeze({
      width: view.getFloat64(PROVENANCE.WIDTH, true),
      height: view.getFloat64(PROVENANCE.HEIGHT, true),
      deviceScale: view.getFloat64(PROVENANCE.DEVICE_SCALE, true),
    }),
    traversal: TRAVERSAL_NAMES.get(view.getUint32(PROVENANCE.TRAVERSAL, true)),
    // A raster names its placement and its size in device pixels.
    placement: kind === "raster"
      ? Object.freeze({
        handle: view.getBigInt64(PROVENANCE.PLACEMENT, true),
        width: view.getUint32(PROVENANCE.RASTER_WIDTH, true),
        height: view.getUint32(PROVENANCE.RASTER_HEIGHT, true),
      })
      : null,
  });
}

function optionalCallback(value, name) {
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError(`${name} must be a function; received ${typeof value}`);
  }
  return value;
}

// One retained instance of `core` after its mount.
//
// - `runOperation(operation)` enters the session's ordered operation chain
//   and returns its result Promise.
// - `apply(applicator, context)` calls the caller's applicator on the live
//   instance, synchronously, in the instance's component code.
// - `replace()` replaces the instance from its source; it settles when the
//   new instance is ready, and throws when it cannot make one.
// - `stepStarted()` and `stepEnded()` bracket each step for the session.
// - `capture(kind, { root, environment, placement })` captures the
//   "structure", "metrics", or "paint" record of the live instance for
//   `root` (null for the document) and returns its facade. For "raster" it
//   rasters `root` at `placement` ({ rectangle (null for the root's border
//   box), backdrop, offset }) and returns the raster artifact, whose
//   `width` and `height` are device pixels.
export function createRetainedInstance({
  core,
  runOperation,
  apply,
  replace,
  capture,
  stepStarted = () => {},
  stepEnded = () => {},
}) {
  // The root node of each selection that this instance made, by handle,
  // and the raster options of each placement.
  const selectionRoots = new Map();
  const placements = new Map();
  let documentSelection = null;
  identifyCore(core);
  const handle = core.statusRaw("revision_instance_create");
  let revision = readRevision(core, "revision_instance_create");
  let disposed = false;
  // The callbacks of each step that has not ended, by step handle.
  const steps = new Map();

  const pump = () => {
    if (disposed) return;
    const step = core.statusRaw("revision_step_next", handle);
    if (step === 0n) return;
    let started = false;
    runOperation(() => {
      started = true;
      return runStep(step);
    }).then(undefined, (error) => {
      if (!started) {
        // The session refused the operation. A disposal has ended and
        // reported the step already; after a session failure, the step
        // ends as cancelled, with the refusal as its cause.
        if (disposed) return;
        if (core.statusRaw("revision_step_cancel", handle, step) === 1) {
          endSteps(readFinishList(core, "revision_step_cancel"), step, error);
          return;
        }
      }
      // A throw inside a started step is a defect of the binding or of a
      // caller callback: it stays loud.
      queueMicrotask(() => {
        throw error;
      });
    });
  };

  // Removes an ended step, releases its wait, and starts the next step.
  const release = (step) => {
    const entry = steps.get(step);
    if (!entry) {
      throw new Error(`The core ended step ${step}, which this instance does not hold`);
    }
    steps.delete(step);
    entry.release();
    pump();
    return entry;
  };

  // Delivers onFailed for each ended step; `cause` is the error of
  // `causeStep` that the host reported.
  const endSteps = (entries, causeStep, cause) => {
    for (const { step, message } of entries) {
      const entry = release(step);
      const error = step === causeStep && cause !== undefined
        ? new Error(message, { cause })
        : new Error(message);
      entry.onFailed?.(error);
    }
  };

  const published = (step, operation) => {
    revision = readRevision(core, operation);
    const entry = release(step);
    (entry.kind === STEP_RESET ? entry.onReady : entry.onPublished)?.(revision);
  };

  const fail = (step, cause, error) => {
    if (core.statusRaw("revision_step_fail", handle, step, cause) === 0) return;
    endSteps(readFinishList(core, "revision_step_fail"), step, error);
  };

  const runReset = async (step) => {
    stepStarted();
    try {
      await replace();
    } catch (error) {
      stepEnded();
      fail(step, CAUSE_APPLICATOR, error);
      return;
    }
    stepEnded();
    if (core.statusRaw("revision_step_applied", handle, step, 0) === REPORT_PUBLISHED) published(step, "revision_step_applied");
  };

  const runTransition = async (step) => {
    const entry = steps.get(step);
    let limit = 0;
    const context = Object.freeze({
      // Asks for settlement: the step publishes when `settle()` runs, and
      // fails when `fail(error)` runs or the settlement limit passes.
      deferSettlement() {
        limit = core.statusRaw("revision_step_defer", handle, step);
        return Object.freeze({
          settle() {
            if (core.statusRaw("revision_step_settle", handle, step) === REPORT_PUBLISHED) published(step, "revision_step_settle");
          },
          fail(error) {
            fail(step, CAUSE_SETTLEMENT, error);
          },
        });
      },
    });
    stepStarted();
    try {
      let result;
      try {
        result = apply(entry.applicator, context);
      } catch (error) {
        fail(step, CAUSE_APPLICATOR, error);
        return;
      }
      // The core decides what the return value means: a thenable fails
      // the step, because only settlement signals completion.
      const applied = core.statusRaw(
        "revision_step_applied",
        handle,
        step,
        typeof result?.then === "function" ? 1 : 0,
      );
      if (applied === REPORT_FAILED) {
        endSteps(readFinishList(core, "revision_step_applied"));
        return;
      }
      if (applied === REPORT_PUBLISHED) {
        published(step, "revision_step_applied");
        return;
      }
      // Ended while its applicator ran (a cancellation): nothing waits.
      if (!steps.has(step)) return;
      // The step waits for its settlement and holds the session's chain
      // until it ends.
      await new Promise((resolve) => {
        const timer = hostSetTimeout(() => {
          if (core.statusRaw("revision_step_timeout", handle, step) === 0) return;
          endSteps(readFinishList(core, "revision_step_timeout"));
        }, limit);
        entry.release = () => {
          hostClearTimeout(timer);
          resolve();
        };
      });
    } finally {
      stepEnded();
    }
  };

  // A step that a cancellation or a disposal ended before its operation
  // started does not run.
  const runStep = (step) => {
    const entry = steps.get(step);
    if (!entry) return;
    return entry.kind === STEP_RESET ? runReset(step) : runTransition(step);
  };

  const enqueue = (kind, entry, settlementLimitMilliseconds) => {
    const step = core.statusRaw("revision_step_enqueue", handle, kind, settlementLimitMilliseconds);
    steps.set(step, { kind, release: () => {}, ...entry });
    pump();
    return step;
  };

  return Object.freeze({
    // The published revision: its handle, the instance serial, its ordinal
    // in the instance, the resets, and the transitions since the last
    // reset or the mount.
    get revision() {
      return revision;
    },

    transition(applicator, { onPublished, onFailed, settlementLimitMilliseconds = 0 } = {}) {
      if (typeof applicator !== "function") {
        throw new TypeError(`transition applicator must be a function; received ${typeof applicator}`);
      }
      const step = enqueue(STEP_TRANSITION, {
        applicator,
        onPublished: optionalCallback(onPublished, "transition onPublished"),
        onFailed: optionalCallback(onFailed, "transition onFailed"),
      }, settlementLimitMilliseconds);
      return Object.freeze({
        handle: step,
        // Cancels the step if it has not ended: a queued step never runs,
        // and a running step publishes nothing. Returns whether it ended
        // the step.
        cancel() {
          if (core.statusRaw("revision_step_cancel", handle, step) === 0) return false;
          endSteps(readFinishList(core, "revision_step_cancel"));
          return true;
        },
      });
    },

    reset({ onReady, onFailed } = {}) {
      return Object.freeze({
        handle: enqueue(STEP_RESET, {
          onReady: optionalCallback(onReady, "reset onReady"),
          onFailed: optionalCallback(onFailed, "reset onFailed"),
        }, 0),
      });
    },

    // Throws unless `revisionHandle` names the published revision of this
    // live instance.
    requireCurrentRevision(revisionHandle) {
      core.statusRaw("revision_require_current", handle, revisionHandle);
    },

    // Names what to observe: the document (root null) or the subtree of
    // one node of the live document. The selection lives until release()
    // or the end of the instance.
    select(root = null) {
      const selection = core.statusRaw(
        "revision_selection_create",
        handle,
        root === null ? SELECTION_DOCUMENT : SELECTION_SUBTREE,
        root === null ? 0n : root._coreHandle,
      );
      selectionRoots.set(selection, root);
      return Object.freeze({
        handle: selection,
        release() {
          core.statusRaw("revision_selection_release", selection);
          selectionRoots.delete(selection);
        },
      });
    },

    // Names one compositing layer to raster: the paint group at `index` in
    // the paint record of a frame, with all it holds. Only a raster
    // observes it. The selection lives until release() or the end of the
    // instance.
    selectLayer(index) {
      const selection = core.statusRaw("revision_selection_create", handle, SELECTION_LAYER, BigInt(index));
      selectionRoots.set(selection, { layer: index });
      return Object.freeze({
        handle: selection,
        release() {
          core.statusRaw("revision_selection_release", selection);
          selectionRoots.delete(selection);
        },
      });
    },

    // Names how to raster a selection: the layout `environment` ({ width,
    // height, deviceScale }), the world `rectangle` ({ x, y, width, height }
    // in document CSS pixels; null for the selection's border box), the
    // `backdrop` color ({ r, g, b, a } from 0 to 1; transparent by default),
    // and the `offset` ({ x, y } device pixels) of the raster in a shared
    // target. The placement lives until release() or the end of the
    // instance.
    place(selection, { environment, rectangle = null, backdrop = { r: 0, g: 0, b: 0, a: 0 }, offset = { x: 0, y: 0 } } = {}) {
      const placement = core.statusRaw(
        "revision_placement_create",
        selection?.handle,
        environment?.width,
        environment?.height,
        environment?.deviceScale ?? 1,
        rectangle === null ? NaN : rectangle.x,
        rectangle === null ? NaN : rectangle.y,
        rectangle === null ? NaN : rectangle.width,
        rectangle === null ? NaN : rectangle.height,
        backdrop.r,
        backdrop.g,
        backdrop.b,
        backdrop.a,
        offset.x,
        offset.y,
      );
      placements.set(placement, Object.freeze({
        selection: selection.handle,
        environment: Object.freeze({ width: environment.width, height: environment.height, deviceScale: environment.deviceScale ?? 1 }),
        rectangle: rectangle === null ? null : Object.freeze({ x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height }),
        backdrop: Object.freeze({ r: backdrop.r, g: backdrop.g, b: backdrop.b, a: backdrop.a }),
        offset: Object.freeze({ x: offset.x, y: offset.y }),
      }));
      return Object.freeze({
        handle: placement,
        release() {
          core.statusRaw("revision_placement_release", placement);
          placements.delete(placement);
        },
      });
    },

    // Requests one projection of a published revision and returns its
    // handle at once: { kind, selection, environment } for "structure",
    // "metrics", and "paint", and { kind: "raster", placement } for a
    // raster. The request runs in the instance's ordered operations;
    // completion arrives through onCaptured({ artifact, provenance }) or
    // onFailed(error). The revision must still be published when the
    // request runs.
    project(revision, { kind, selection, environment, placement } = {}, { onCaptured, onFailed } = {}) {
      const kindCode = OBSERVATION_KINDS.get(kind);
      if (kindCode === undefined) {
        throw new TypeError(`project kind must be "structure", "metrics", "paint", or "raster"; received ${JSON.stringify(kind)}`);
      }
      optionalCallback(onCaptured, "project onCaptured");
      optionalCallback(onFailed, "project onFailed");
      const revisionHandle = typeof revision === "bigint" ? revision : revision?.handle;
      const raster = kind === "raster";
      let observation;
      let options = null;
      if (raster) {
        observation = core.statusRaw("revision_observation_request_raster", handle, revisionHandle, placement?.handle);
        options = placements.get(placement.handle);
        selection = { handle: options.selection };
        environment = options.environment;
      } else {
        selection ??= (documentSelection ??= this.select(null));
        observation = core.statusRaw(
          "revision_observation_request",
          handle,
          revisionHandle,
          selection.handle,
          kindCode,
          environment?.width,
          environment?.height,
          environment?.deviceScale ?? 1,
        );
      }
      const target = selectionRoots.get(selection.handle) ?? null;
      const layer = target?.layer ?? null;
      const root = layer === null ? target : null;
      const deliver = (callback, value) => {
        try {
          callback?.(value);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      };
      let started = false;
      runOperation(async () => {
        started = true;
        // The core ends the observation when it refuses to begin or to
        // record the capture; a throw of the capture itself ends it here.
        core.statusRaw("revision_observation_begin", handle, observation);
        let artifact;
        try {
          artifact = await capture(kind, {
            root,
            layer,
            environment: { width: environment.width, height: environment.height, deviceScale: environment.deviceScale ?? 1 },
            placement: options,
          });
        } catch (error) {
          core.statusRaw("revision_observation_fail", handle, observation);
          throw error;
        }
        if (raster) core.statusRaw("revision_observation_rastered", handle, observation, artifact.width, artifact.height);
        else core.statusRaw("revision_observation_captured", handle, observation, artifact.handle);
        return Object.freeze({
          artifact,
          provenance: readProvenance(core, kind, raster ? "revision_observation_rastered" : "revision_observation_captured"),
        });
      }).then(
        (captured) => deliver(onCaptured, captured),
        (error) => {
          // Before the operation started, the session refused it: a
          // disposal has ended the observation in the core already.
          if (!started && !disposed) core.statusRaw("revision_observation_fail", handle, observation);
          deliver(onFailed, error);
        },
      );
      return Object.freeze({ handle: observation });
    },

    // Ends every step as cancelled and ends the instance. A second call
    // throws.
    dispose() {
      core.statusRaw("revision_instance_dispose", handle);
      disposed = true;
      endSteps(readFinishList(core, "revision_instance_dispose"));
    },
  });
}
