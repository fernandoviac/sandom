// GPU time of render passes, a diagnostic. After enableGpuPassTiming(), a
// device created from an adapter with the timestamp-query feature requests
// it (gpuPassTimingFeatures), and each render pass that a GPU binding
// begins on that device writes its start and end timestamps. Each
// submission resolves its passes' timestamps and reads them back; the GPU
// time adds up by the label of the binding that began the pass
// (createGpuBinding's effects.label) and, within a label, by the purpose
// of the pass (the purpose word of records 5 and 34,
// docs/specifications/gpu-command-stream.md). takeGpuPassTiming() returns
// the totals since its last call. Without enableGpuPassTiming() no device
// requests the feature and no pass carries timestamp writes.

// WebGPU's constants, which a server runtime without WebGPU lacks as globals.
import { GPUBufferUsage, GPUMapMode } from "./dom/webgpu-facade.js";

const PASSES_PER_SUBMISSION = 256;

// The names of the pass purposes, by the code that the renderer core
// writes ($GPU_PASS_* in core/engine/gpu-execution.watpart).
export const GPU_PASS_PURPOSES = Object.freeze([
  undefined, "tile clear", "main", "group content", "filter blur",
  "filter color matrix", "filter drop shadow", "mask", "image conversion",
  "presentation", "compositor", "canvas", "filter resample",
]);

// The name of pass purpose `code`; a code the core does not define throws.
export function gpuPassPurposeName(code) {
  const name = GPU_PASS_PURPOSES[code];
  if (name === undefined) {
    throw new Error(`GPU pass purpose ${code} is not one of 1..${GPU_PASS_PURPOSES.length - 1}; the writer of the pass record must set its purpose ($GPU_PASS_* in core/engine/gpu-execution.watpart)`);
  }
  return name;
}

let enabled = false;
let listPasses = false;
let textureStacks = false;
const recorders = new WeakMap();
let totals = new Map();
let submissions = [];
let textureOperations = [];

// Records one texture creation or texture write of a GPU binding while the
// timing is on, as { label, operation: "create" | "write", width, height,
// format, bytes, stack } (bytes 0 for a creation; stack null unless
// enableGpuPassTiming({ textureStacks: true })).
export function noteGpuTextureOperation(label, operation, width, height, format, bytes) {
  if (enabled) {
    textureOperations.push({ label, operation, width, height, format, bytes, stack: textureStacks ? new Error().stack : null });
  }
}

// `passes: true` also keeps the passes of each submission, with the start
// and end of each, until takeGpuPassTiming() returns them. `textureStacks:
// true` keeps the call stack of each texture operation.
export function enableGpuPassTiming({ passes = false, textureStacks: stacks = false } = {}) {
  enabled = true;
  listPasses = passes;
  textureStacks = stacks;
}

// The features that a device from `adapter` requests for the timing.
export function gpuPassTimingFeatures(adapter) {
  return enabled && adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
}

// The GPU time since the last call, by label:
// { labels: { label: { passes, unended, submissions, milliseconds, purposes:
// { purpose: { passes, unended, milliseconds } } } }, submissions,
// pendingSubmissions }.
// A tile-based GPU overlaps consecutive passes, so a pass's own interval
// includes its neighbours' work. A label's milliseconds are each
// submission's span, from the earliest pass start to the latest pass end
// of the label's passes in it. A purpose's milliseconds add up the own
// intervals of its passes; passes that overlap count their overlap more
// than once. `unended` counts the passes whose end timestamp the device
// did not write; they add no time. `submissions` is empty unless
// enableGpuPassTiming({ passes: true }): then each entry lists the passes
// of one submission in their order, { label, purpose, start, end }, in
// milliseconds from the submission's earliest pass start (end null for an
// unended pass). `pendingSubmissions` counts the submissions whose
// timestamps have not been read back yet. `textures` lists the texture
// creations and writes since the last call (noteGpuTextureOperation).
export function takeGpuPassTiming() {
  const taken = Object.fromEntries([...totals].map(([label, total]) => [label, {
    ...total,
    purposes: Object.fromEntries([...total.purposes].map(([purpose, sum]) => [purpose, { ...sum }])),
  }]));
  const takenSubmissions = submissions;
  const takenTextures = textureOperations;
  totals = new Map();
  submissions = [];
  textureOperations = [];
  return { labels: taken, submissions: takenSubmissions, textures: takenTextures, pendingSubmissions: readbacks.size };
}

// takeGpuPassTiming() once the timestamps of every submission made so far
// have been read back: the timing of whole frames, for a bench.
export async function takeSettledGpuPassTiming() {
  await Promise.all(readbacks);
  return takeGpuPassTiming();
}

// The readbacks of submitted timestamps in flight.
const readbacks = new Set();

function recorderOf(device) {
  if (!enabled || !device.features?.has("timestamp-query")) return null;
  let recorder = recorders.get(device);
  if (recorder === undefined) {
    recorder = createRecorder(device);
    recorders.set(device, recorder);
  }
  return recorder;
}

// The timestampWrites of a render pass with purpose name `purpose` that
// binding `label` begins on `device`, or undefined when the timing is off
// for it.
export function gpuPassTimestampWrites(device, label, purpose) {
  return recorderOf(device)?.pass(label, purpose);
}

// Submits `commandBuffers` on `device` with the resolution of the passes
// they timed, then reads the timestamps back.
export function submitTimed(device, commandBuffers) {
  const recorder = recorderOf(device);
  if (recorder === null || recorder.passes.length === 0) {
    device.queue.submit(commandBuffers);
    return;
  }
  recorder.submit(commandBuffers);
}

function createRecorder(device) {
  const recorder = {
    passes: [],
    querySet: null,
    pass(label, purpose) {
      if (this.passes.length === PASSES_PER_SUBMISSION) {
        throw new Error(`GPU pass timing holds ${PASSES_PER_SUBMISSION} render passes a submission; a submission began more. Submit sooner or raise PASSES_PER_SUBMISSION in src/gpu-pass-timing.js.`);
      }
      this.querySet ??= device.createQuerySet({ type: "timestamp", count: PASSES_PER_SUBMISSION * 2 });
      const index = this.passes.length;
      this.passes.push({ label, purpose });
      return { querySet: this.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 };
    },
    submit(commandBuffers) {
      const { passes, querySet } = this;
      const listed = listPasses;
      this.passes = [];
      this.querySet = null;
      const bytes = passes.length * 16;
      const resolved = device.createBuffer({ size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(querySet, 0, passes.length * 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, bytes);
      device.queue.submit([...commandBuffers, encoder.finish()]);
      const reading = readback.mapAsync(GPUMapMode.READ).then(() => {
        const stamps = new BigUint64Array(readback.getMappedRange());
        const spans = new Map();
        let first = stamps[0];
        passes.forEach(({ label, purpose }, index) => {
          const start = stamps[index * 2];
          const end = stamps[index * 2 + 1];
          // An end before the start was not written: wgpu on Metal leaves
          // the end of some passes unwritten (Deno 2.7). The pass counts as
          // unended, and its start alone bounds the span.
          const ended = end >= start;
          if (start < first) first = start;
          let span = spans.get(label);
          if (span === undefined) {
            span = { start, end: start, passes: 0, unended: 0, purposes: new Map() };
            spans.set(label, span);
          }
          if (start < span.start) span.start = start;
          if (ended && end > span.end) span.end = end;
          span.passes += 1;
          const sum = span.purposes.get(purpose) ?? { passes: 0, unended: 0, milliseconds: 0 };
          sum.passes += 1;
          if (ended) sum.milliseconds += Number(end - start) / 1e6;
          else {
            sum.unended += 1;
            span.unended += 1;
          }
          span.purposes.set(purpose, sum);
        });
        for (const [label, span] of spans) {
          const total = totals.get(label) ?? { passes: 0, unended: 0, submissions: 0, milliseconds: 0, purposes: new Map() };
          total.passes += span.passes;
          total.unended += span.unended;
          total.submissions += 1;
          total.milliseconds += Number(span.end - span.start) / 1e6;
          for (const [purpose, sum] of span.purposes) {
            const purposeTotal = total.purposes.get(purpose) ?? { passes: 0, unended: 0, milliseconds: 0 };
            purposeTotal.passes += sum.passes;
            purposeTotal.unended += sum.unended;
            purposeTotal.milliseconds += sum.milliseconds;
            total.purposes.set(purpose, purposeTotal);
          }
          totals.set(label, total);
        }
        if (listed) {
          submissions.push({
            passes: passes.map(({ label, purpose }, index) => {
              const start = stamps[index * 2];
              const end = stamps[index * 2 + 1];
              return { label, purpose, start: Number(start - first) / 1e6, end: end >= start ? Number(end - first) / 1e6 : null };
            }),
          });
        }
        readback.unmap();
      }).finally(() => {
        readbacks.delete(reading);
        readback.destroy();
        resolved.destroy();
        querySet.destroy();
      });
      readbacks.add(reading);
    },
  };
  return recorder;
}
