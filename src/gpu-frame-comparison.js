// The GPU frame comparison binding (docs/specifications/gpu-command-stream.md#frame-comparison).
// Renderer-core (core/engine/gpu-frame-comparison.watpart) owns validation,
// byte budgets, damage partition, pass order, the ring, the record layout,
// and resource lifetimes. This module transports options and damage bytes,
// executes the records on the binding's device, and delivers each mapped
// record to the result callback.
import { composeShaderBytes } from "./shaders/compose.js";
import { layoutConstant } from "./wasm/layout-table.js";

const constant = (name) => layoutConstant(`GPU_COMPARISON_${name}`);
const ERROR = Object.freeze(Object.fromEntries(["CODE", "OBSERVED", "LIMIT"].map((name) => [name, constant(`ERROR_${name}`)])));
const RECORD = Object.freeze(Object.fromEntries(
  ["FRAME", "EPOCH", "CHANGED", "CHANGED_PIXELS", "ACCEPTED", "COMPARED_PIXELS", "COVERAGE", "SKIPPED", "BOUNDS", "TILES"]
    .map((name) => [name, constant(`RECORD_${name}`)])));
const FORMATS = Object.freeze({ rgba8unorm: constant("FORMAT_RGBA8UNORM"), rgba16float: constant("FORMAT_RGBA16FLOAT") });
const POLICIES = Object.freeze({ wait: constant("POLICY_WAIT"), drop: constant("POLICY_DROP") });
const COVERAGE = new Map([
  [constant("COVERAGE_DAMAGE"), "damage"], [constant("COVERAGE_FULL"), "full"], [constant("COVERAGE_EMPTY"), "empty"],
]);
const CANDIDATE = new Map([
  [constant("CANDIDATE_RECORDED"), "recorded"], [constant("CANDIDATE_DROPPED"), "dropped"], [constant("CANDIDATE_REFUSED"), "refused"],
]);
const DAMAGE_UNKNOWN = constant("DAMAGE_UNKNOWN");
const STATISTICS = Object.freeze({ gpuCopyBytes: constant("STATISTIC_GPU_COPY_BYTES"),
  workgroups: constant("STATISTIC_WORKGROUPS"), hostBytes: constant("STATISTIC_HOST_BYTES") });
const ERRORS = new Map([
  [constant("ERROR_BUDGET"), ["budget-exceeded", "GPU bytes", "raise the byte budget, or reduce the history slots, the ring depth, or the image size"]],
  [constant("ERROR_BINDING_SIZE"), ["binding-size-exceeded", "bytes in one storage binding",
    "request a device with a larger maxStorageBufferBindingSize, or reduce the history slots or the image size"]],
  [constant("ERROR_BUFFER_SIZE"), ["buffer-size-exceeded", "bytes in one buffer",
    "request a device with a larger maxBufferSize, or reduce the history slots or the image size"]],
  [constant("ERROR_WORKGROUPS"), ["workgroups-exceeded", "workgroups in one dimension", "reduce the image size"]],
  [constant("ERROR_WAIT_SLOTS"), ["wait-history-too-small", "history slots",
    "under the wait policy, give at least the ring depth plus two history slots"]],
  [constant("ERROR_CAPACITY"), ["capacity-exceeded", "bytes in a buffer allocated at creation",
    "create a comparison owner for the larger image"]],
  [constant("ERROR_GPU"), ["gpu-failure", "failure status", "create a new comparison owner on a working device"]],
  [constant("ERROR_NOT_RETAINED"), ["not-retained", "epoch requested, current epoch is the limit",
    "read an accepted image of the current epoch with a sequence above 0"]],
  [constant("ERROR_REGION"), ["region-outside-image", "right or bottom edge, image extent is the limit",
    "read a rectangle inside the image"]],
]);
const READ = Object.freeze(Object.fromEntries(["READY", "EVICTED", "FAILED", "HEADER", "IMAGE", "MASK"]
  .map((name) => [name, constant(`READ_${name}`)])));

export class GpuFrameComparisonError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "GpuFrameComparisonError";
    this.code = code;
    this.details = details;
  }
}

// Creates a comparison owner on `binding` (src/gpu-binding.js) for
// width x height images in `format`. `result(record)` receives each record in
// candidate order; `failure(error)` receives the error that ends the owner.
export function createGpuFrameComparison(binding, {
  device, width, height, format, tileSize, historySlots, ringDepth, policy, budget, result, failure, firstEpoch = 1, skipped = 0,
}) {
  if (FORMATS[format] === undefined) throw new TypeError(`frame comparison format ${format} is unsupported; use rgba8unorm or rgba16float`);
  if (POLICIES[policy] === undefined) throw new TypeError(`frame comparison policy ${policy} is unknown; use wait or drop`);
  if (typeof result !== "function" || typeof failure !== "function") {
    throw new TypeError("frame comparison needs result and failure callbacks");
  }
  const core = binding.core;
  const shader = composeShaderBytes(core, "frame-comparison");
  const state = core.gpu_comparison_create(binding.stream, shader.pointer, shader.length, width, height, FORMATS[format],
    tileSize, historySlots, ringDepth, POLICIES[policy], budget, device.limits.maxStorageBufferBindingSize,
    device.limits.maxBufferSize, device.limits.maxComputeWorkgroupsPerDimension, firstEpoch, skipped);
  const refusal = errorOf(core, state);
  if (refusal !== null) {
    core.gpu_comparison_destroy(state);
    throw refusal;
  }
  binding.execute();
  const outstanding = new Set();
  const entryWaiters = [];
  let broken = null;
  let destroying = null;
  let unreportedReceiver = null;
  let destroyed = false;

  function requireUsable() {
    if (destroyed || destroying !== null) throw new GpuFrameComparisonError("destroyed", "the comparison owner is destroyed");
    if (broken !== null) throw broken;
  }
  function fail(error) {
    if (broken !== null) return;
    broken = error;
    for (const waiter of entryWaiters.splice(0)) waiter.throw(error);
    failure(error);
  }
  function deliver() {
    for (;;) {
      const pointer = core.gpu_comparison_next(state);
      if (pointer === 0) break;
      const length = core.gpu_comparison_delivered_length(state);
      const words = new Uint32Array(core.memory.buffer.slice(pointer, pointer + length));
      try {
        result(Object.freeze({
          frameSequence: words[RECORD.FRAME],
          epoch: words[RECORD.EPOCH],
          changed: words[RECORD.CHANGED] !== 0,
          changedPixels: words[RECORD.CHANGED_PIXELS],
          acceptedSequence: words[RECORD.ACCEPTED],
          comparedPixels: words[RECORD.COMPARED_PIXELS],
          coverage: COVERAGE.get(words[RECORD.COVERAGE]),
          skipped: words[RECORD.SKIPPED],
          bounds: Object.freeze({ x: words[RECORD.BOUNDS], y: words[RECORD.BOUNDS + 1],
            width: words[RECORD.BOUNDS + 2], height: words[RECORD.BOUNDS + 3] }),
          changedTiles: words.slice(RECORD.TILES),
        }));
      } finally {
        core.gpu_comparison_release(state);
      }
    }
    while (entryWaiters.length && core.gpu_comparison_free_entries(state) > 0) entryWaiters.shift().reply();
  }
  function settle(token) {
    outstanding.delete(token);
    deliver();
    if (destroying !== null && outstanding.size === 0) finishDestroy();
  }
  function finishDestroy() {
    const operation = destroying;
    destroying = null;
    destroyed = true;
    try {
      unreportedReceiver?.(core.gpu_comparison_skipped(state));
      core.gpu_comparison_destroy(state);
      if (!binding.closed) binding.execute();
    } catch (error) {
      operation.throw(error);
      return;
    }
    operation.reply();
  }

  return Object.freeze({
    // Starts a new epoch for a changed image: dimensions, format, device
    // scale, color encoding, or alpha mode.
    epoch(nextWidth, nextHeight, nextFormat) {
      requireUsable();
      if (FORMATS[nextFormat] === undefined) throw new TypeError(`frame comparison format ${nextFormat} is unsupported`);
      if (!core.gpu_comparison_epoch(state, nextWidth, nextHeight, FORMATS[nextFormat])) throw errorOf(core, state);
    },
    // Records the comparison of `texture` on `encoder`. `damage` is null for
    // unknown damage, or an array of [x, y, width, height] rectangles since
    // the previous candidate. The result is "recorded", "dropped", or
    // "refused" (wait policy, full ring: render the frame again after
    // whenEntryFree).
    candidate(encoder, texture, frameSequence, damage) {
      requireUsable();
      let input = 0;
      let count = DAMAGE_UNKNOWN;
      if (damage !== null) {
        count = damage.length;
        const view = binding.input(Math.max(count, 1) * 16);
        input = view.byteOffset;
        for (let index = 0; index < count; index++) {
          for (let field = 0; field < 4; field++) view.setUint32(index * 16 + field * 4, damage[index][field], true);
        }
      }
      return CANDIDATE.get(core.gpu_comparison_candidate(state, encoder, binding.importResource(texture), frameSequence, input, count));
    },
    // The same with damage already in renderer-core memory: `count`
    // rectangles of four u32 words at `pointer` (the raster retention's
    // damage span), -1 for unknown damage.
    candidateSpan(encoder, texture, frameSequence, pointer, count) {
      requireUsable();
      return CANDIDATE.get(core.gpu_comparison_candidate(state, encoder, binding.importResource(texture), frameSequence, pointer, count));
    },
    policy,
    binding,
    // Cumulative work since creation: GPU-local copy bytes, compute
    // workgroups, and bytes mapped to the host.
    statistics() {
      return Object.freeze(Object.fromEntries(Object.entries(STATISTICS)
        .map(([name, which]) => [name, core.gpu_comparison_statistic(state, which)])));
    },
    // Requests the record map; call it after the candidate's encoder
    // submission is recorded and before the next candidate.
    submit() {
      const token = core.gpu_comparison_submit(state);
      if (token === 0) return;
      outstanding.add(token);
      binding.completion(token, {
        reply: () => {
          // A refused epoch leaves its capacity error; only a GPU failure
          // ends the owner.
          const error = errorOf(core, state);
          if (error?.code === "gpu-failure") fail(error);
          settle(token);
        },
        throw: (error) => {
          fail(error);
          settle(token);
        },
      });
    },
    // Reads a rectangle of accepted image `sequence` of `epoch`: "image"
    // replies { words } (packed working-format words, rows of width x
    // words-per-pixel), "mask" replies { bits } (rows of ceil(width / 32)
    // words, bit 0 the rectangle's left pixel). A slot that a later accepted
    // image overwrote throws not-retained.
    read(kind, { epoch, sequence, x, y, width: readWidth, height: readHeight }, operation) {
      requireUsable();
      const token = core.gpu_comparison_read(state, epoch, sequence, kind === "mask" ? READ.MASK : READ.IMAGE,
        x, y, readWidth, readHeight);
      if (token === 0) throw errorOf(core, state);
      binding.execute();
      outstanding.add(token);
      binding.completion(token, {
        reply: () => {
          let reply;
          try {
            const status = core.gpu_comparison_read_status(state, token);
            const pointer = core.gpu_comparison_read_pointer(state, token);
            const length = core.gpu_comparison_read_length(state, token);
            const words = new Uint32Array(core.memory.buffer.slice(pointer, pointer + length));
            core.gpu_comparison_read_release(state, token);
            if (!binding.closed) binding.execute();
            const data = words.slice(READ.HEADER / 4);
            if (status === READ.READY) reply = () => operation.reply(kind === "mask" ? { bits: data } : { words: data });
            else if (status === READ.EVICTED) {
              reply = () => operation.throw(new GpuFrameComparisonError("not-retained",
                `epoch ${epoch} sequence ${sequence}: its slot holds epoch ${words[0]} sequence ${words[1]}; ` +
                `raise the history slots above ${historySlots} to keep it`, { found: { epoch: words[0], sequence: words[1] } }));
            } else reply = () => operation.throw(errorOf(core, state));
          } catch (error) {
            reply = () => operation.throw(error);
          }
          settle(token);
          reply();
        },
        throw: (error) => {
          fail(error);
          settle(token);
          operation.throw(error);
        },
      });
    },
    // Replies when a ring entry is free for the next candidate.
    whenEntryFree(operation) {
      requireUsable();
      if (core.gpu_comparison_free_entries(state) > 0) operation.reply();
      else entryWaiters.push(operation);
    },
    // Test inspection only: the GPU history buffer, mask buffer, or state
    // buffer handle.
    buffer(which) {
      return binding.resource(core.gpu_comparison_buffer(state, ["history", "masks", "state"].indexOf(which)));
    },
    // Releases the owner after every requested map completes.
    // `unreported(skipped)` receives the dropped results that no delivered
    // record counted, before the owner's state is freed.
    destroy(operation, unreported = null) {
      if (destroyed || destroying !== null) throw new GpuFrameComparisonError("destroyed", "the comparison owner is destroyed");
      destroying = operation;
      unreportedReceiver = unreported;
      for (const waiter of entryWaiters.splice(0)) waiter.throw(new GpuFrameComparisonError("destroyed", "the comparison owner is destroyed"));
      if (outstanding.size === 0) finishDestroy();
    },
  });
}

function errorOf(core, state) {
  const view = new DataView(core.memory.buffer, state);
  const code = view.getUint32(ERROR.CODE, true);
  if (code === 0) return null;
  const observed = view.getUint32(ERROR.OBSERVED, true);
  const limit = view.getUint32(ERROR.LIMIT, true);
  const [name, unit, remedy] = ERRORS.get(code) ?? [`error-${code}`, "units", "update the host and renderer-core together"];
  return new GpuFrameComparisonError(name, `observed ${observed} ${unit}, limit ${limit}; ${remedy}`, { observed, limit });
}

// A comparison attached to a renderer across its render contexts. Each
// WebGPU render context (one image size, density, and format) gets its own
// owner when it first renders; the owners continue one epoch sequence, so a
// context change starts a new epoch. `ready` replies when the first owner
// exists, or throws its creation error.
export function createFrameComparisonSession({
  budget, historySlots, ringDepth, policy, tileSize, result, failure, ready,
}) {
  if (POLICIES[policy] === undefined) throw new TypeError(`frame comparison policy ${policy} is unknown; use wait or drop`);
  if (typeof result !== "function" || typeof failure !== "function") {
    throw new TypeError("frame comparison needs result and failure callbacks");
  }
  let nextEpoch = 1;
  // Results that a released owner dropped and never reported.
  let carriedSkips = 0;
  let current = null;
  let currentEpoch = 0;
  let readyOperation = ready;
  let broken = null;
  function fail(error) {
    if (broken !== null) return;
    broken = error;
    if (readyOperation !== null) {
      const operation = readyOperation;
      readyOperation = null;
      operation.throw(error);
    }
    failure(error);
  }
  function requireCurrent() {
    if (broken !== null) throw broken;
    if (current === null) throw new GpuFrameComparisonError("not-retained", "no render context holds a comparison owner; render a frame first");
    return current;
  }
  const session = {
    // For the render context: the owner of `binding`'s context, created on
    // its first frame. Null after a failure; frames then render uncompared.
    ownerFor(binding, { device, width, height, format }) {
      if (broken !== null) return null;
      if (current?.binding === binding) return current;
      try {
        current = createGpuFrameComparison(binding, {
          device, width, height, format, tileSize, historySlots, ringDepth, policy, budget,
          result, failure: fail, firstEpoch: nextEpoch, skipped: carriedSkips,
        });
        carriedSkips = 0;
      } catch (error) {
        fail(error);
        return null;
      }
      currentEpoch = nextEpoch++;
      if (readyOperation !== null) {
        const operation = readyOperation;
        readyOperation = null;
        operation.reply();
      }
      return current;
    },
    // For the render context: releases `owner` before its binding closes.
    release(owner) {
      if (current === owner) current = null;
      // The owner reports its unreported drops after its last record
      // arrived; the next owner's first record counts them.
      return new Promise((reply, reject) => owner.destroy({ reply, throw: reject },
        (skipped) => { carriedSkips += skipped; }));
    },
    get failed() { return broken !== null; },
    // For the renderer: a render context whose backend has no GPU comparison.
    rejectBackend(kind) {
      fail(new GpuFrameComparisonError("unsupported-backend",
        `the ${kind} backend has no GPU frame comparison; render with the webgpu graphics backend`));
    },
    // The current owner's cumulative work (owner.statistics).
    statistics() {
      return requireCurrent().statistics();
    },
    readImage(request, operation) {
      requireCurrent().read("image", request, operation);
    },
    readMask(request, operation) {
      requireCurrent().read("mask", request, operation);
    },
    // The current epoch's GPU buffers for a GPU consumer on the renderer's
    // device: history slots, masks, and state (sequence and slot tags).
    gpuResources() {
      const owner = requireCurrent();
      return Object.freeze({ epoch: currentEpoch, history: owner.buffer("history"), masks: owner.buffer("masks"),
        state: owner.buffer("state") });
    },
  };
  return session;
}
