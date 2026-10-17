import {
  normalizeAnimationOffsets,
  animationNumber,
  createAnimationTrackIdentity,
  releaseAnimationTrackIdentity,
  nextAnimationReplacement,
  normalizeAnimationValue as normalizeValue,
  normalizeAnimationEasing as normalizeEasing,
  animationPropertyFrames,
  animationTransitionProperties,
  animationProperty,
  animationDirectionMode,
  animationEnumerationName,
  animationFillMode,
  throwAnimationDeclarationError,
  animationEventName,
  transformFrameComponents,
  animationPropertyName,
  animationTrackKind,
  checkAnimationTrack,
} from "./dom-wasm/animation.js";
import { boxSnapshotFor } from "./dom-wasm/geometry-wire.js";
import {
  ANIMATION_EVENT_ENTRY_SIZE,
  ANIMATION_EVENT_QUEUE_BASE,
  ANIMATION_EVENT_QUEUE_SIZE,
  ANIMATION_RECORD_SIZE,
  ANIMATION_RESULT_BASE,
  SHADOW_ENTRY_SIZE,
  SHADOW_OFFSET_COLOR,
  SHADOW_OFFSET_INSET,
} from "./wasm/layout.js";

const animationMeasurementKey = Symbol.for("sandom.domCore.measurement");

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export const normalizeOffsets = normalizeAnimationOffsets;

export function createAnimationController(engine, options = {}) {
  // Long-lived view over the shared engine+HarfBuzz memory — re-derived
  // on HarfBuzz heap growth (the one refresh rule, src/wasm/loader.js).
  const measurement = globalThis[animationMeasurementKey];
  const measurementOptions = measurement ? {
    module: "animation", category: "animation",
    ranges: [{ start: ANIMATION_EVENT_QUEUE_BASE, end: ANIMATION_EVENT_QUEUE_BASE + ANIMATION_EVENT_QUEUE_SIZE, category: "lifecycle" }],
  } : null;
  let view = new DataView(engine.memory.buffer);
  // The track table, the effect stack table and the event queue move when
  // they grow (src/wasm/engine-animation-pools.watpart): each address is
  // read from the engine when it is used.
  const trackAddress = (trackIndex) => engine.exports.animation_table_base() + trackIndex * ANIMATION_RECORD_SIZE;
  let sampleTime = null;
  let computedSamples = null;
  function bindComputedSamples(binding) {
    computedSamples = binding;
  }
  function captureComputedSamples() {
    if (!computedSamples || sampleTime === null) return;
    const { core, owner, elements } = computedSamples;
    for (const [slot, allocation] of allocations) {
      const address = trackAddress(slot);
      const index = view.getUint16(address, true);
      const element = elements[index];
      if (!element || element._domCore !== core) continue;
      const property = propertyWithId(view.getUint16(address + 2, true));
      core.captureComputedSample(engine, owner, allocation.identity,
        element._coreHandle, index, address, property, sampleTime);
    }
  }
  // `generatedRows`: the rows of the scene's ::before and ::after boxes,
  // or undefined for a scene that does not list them.
  function captureComputedPseudos(nodes, boxes, generatedRows) {
    if (!computedSamples) return;
    const { core, owner, elements } = computedSamples;
    core.captureComputedPseudos(engine, owner, nodes, elements, boxes, generatedRows);
  }
  function captureComputedGeometry(boxes) {
    if (!computedSamples) return;
    const { core, owner } = computedSamples;
    const snapshot = boxSnapshotFor(boxes, core);
    try {
      core.status("computed_samples_geometry", owner, snapshot.handle);
    } finally {
      snapshot.release();
    }
  }
  function forgetComputedSample(identity) {
    if (computedSamples) computedSamples.core.status(
      "computed_samples_cancel", computedSamples.owner, identity);
  }
  if (measurement) {
    measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
    view = measurement.wrapDataView(view, measurementOptions);
  }
  // A controller ends before a shared engine does: dispose() removes this
  // listener, which otherwise retains the controller and its owner's scene.
  const removeViewRefresh = engine.onMemoryGrowth(() => {
    view = new DataView(engine.memory.buffer);
    if (measurement) {
      measurement.record({ category: "animation", operation: "engine-view.create", direction: "host", allocations: 1 });
      view = measurement.wrapDataView(view, measurementOptions);
    }
  });
  const allocations = new Map();
  // This controller's effect stack on a node's property, or null
  // (animation_owner_stack).
  function stackOf(nodeIndex, propertyId) {
    const index = engine.exports.animation_owner_stack(owner, nodeIndex, propertyId);
    return index === 0xffff ? null : { index };
  }

  // An animation property from the core's table, by its id: its canonical
  // name, its value kind and where its value lies in a node row.
  function propertyWithId(id) {
    const layout = new DataView(engine.memory.buffer, engine.exports.animation_property_layout(id), 16);
    const property = {
      id,
      valueOffset: layout.getUint32(0, true),
      tagOffset: layout.getUint32(4, true),
      percentageOffset: layout.getUint32(8, true),
      kind: layout.getUint32(12, true),
    };
    property.name = animationPropertyName(id);
    return property;
  }

  // An animation property by its CSS or IDL name, or null for a name the
  // core does not know.
  function propertyNamed(propertyName) {
    const property = animationProperty(String(propertyName));
    return property === null ? null : propertyWithId(property.id);
  }
  let suppressEvents = false;
  // This controller's identity in the engine: its tracks and stacks carry
  // it, and the engine orders them by it.
  const owner = engine.exports.animation_owner_create();

  // Every operation that publishes a track or ticks the table acquires the
  // table first, in the same synchronous turn: the engine publishes one
  // owner's tracks at a time and suspends the others' (animation_acquire).
  // An acquisition does not hold across an await: another controller can
  // acquire the table meanwhile.
  function acquire() {
    engine.exports.animation_acquire(owner);
  }

  // Layout-row ownership (shared-engine renderer coexistence). Renderers
  // that share one engine also share its layout buffer, and each frame
  // fills it with the rows of one scene. A track's base is its node's value
  // in this controller's own scene, so it is read from those rows and
  // restored into them only while they fill the buffer. A controller alone
  // on its engine always owns the rows.
  const ownsLayoutRows = options.ownsLayoutRows ?? (() => true);
  // A stack declared while another scene's rows fill the buffer waits for
  // its base until this controller's rows are back (envelope flag 1); the
  // engine reads it then (animation_owner_read_bases). Until then a cancel
  // restores nothing, and every tick and layout of this controller's rows
  // comes after the read.
  const NO_BASE = Object.freeze({ tag: 0, values: Object.freeze([]) });

  // An engine input block of $byteLength bytes and a view over it. The
  // allocation can grow the memory, so the view is taken after it.
  function engineInput(byteLength) {
    const pointer = engine.exports.abi_allocate(byteLength);
    if (pointer === 0) throw new RangeError(`Cannot allocate ${byteLength} bytes of animation input`);
    return { pointer, input: new DataView(engine.memory.buffer, pointer, byteLength) };
  }

  function writeStackBase(stack, base) {
    const { pointer, input } = engineInput(28);
    input.setUint32(0, base.tag, true);
    for (let index = 0; index < 6; index++) {
      input.setFloat32(4 + index * 4, base.values[index] ?? 0, true);
    }
    engine.exports.animation_stack_write_base(stack.index, pointer);
  }

  // The caller guarantees that this controller's rows fill the buffer.
  function readDeferredBases() {
    engine.exports.animation_owner_read_bases(owner);
  }

  // Whether this controller's rows fill the buffer. Owning them, the
  // controller first reads every base it deferred.
  function ownsRows() {
    if (!ownsLayoutRows()) return false;
    readDeferredBases();
    return true;
  }

  // A cancelled track restores its base into this controller's rows. While
  // another scene's rows fill the buffer it restores nothing: those rows are
  // not this controller's to write, and the next frame of this controller
  // writes every row of its scene again after that foreign write.
  // The engine ends and frees the track; its cancel event is delivered.
  function cancelTrack(trackIndex) {
    const writes = engine.exports.cancel_animation(trackIndex, ownsRows() ? 1 : 0);
    settle(false);
    return writes;
  }

  // The layout that follows reads the table and this controller's rows,
  // which the caller guarantees fill the buffer.
  function prepareLayout() {
    acquire();
    readDeferredBases();
  }

  function cancelAll() {
    if (computedSamples) computedSamples.core.status("computed_samples_clear", computedSamples.owner);
    let writeCount = 0;
    for (const [trackIndex, owned] of [...allocations]) {
      if (allocations.get(trackIndex) !== owned) continue;
      acquire();
      writeCount += cancelTrack(trackIndex);
    }
    // A controller without tracks releases the table.
    if (allocations.size === 0) engine.exports.animation_owner_release(owner);
    return writeCount;
  }
  // The node's value beneath every effect, as the engine reads it from the
  // node row (animation_node_base, engine-animation-tracks.watpart).
  function snapshotBase(nodeIndex, property) {
    const pointer = engine.exports.animation_node_base(nodeIndex, property.id);
    const base = new DataView(engine.memory.buffer, pointer, 28);
    return {
      tag: base.getUint32(0, true),
      values: [0, 1, 2, 3, 4, 5].map((index) => base.getFloat32(4 + index * 4, true)),
    };
  }

  // The identities of each event batch being delivered. A track that host
  // code ends during a delivery leaves every batch: its later events in
  // that batch are not delivered.
  const deliveringBatches = new Set();

  // Takes what the last engine operation queued: its events, each naming
  // its track, and the tracks it ended, which the engine has already freed.
  // The ended tracks leave this controller before any host code runs, so
  // a slot the engine frees is never declared again while this controller
  // still holds it. `sampled`: the ended tracks were sampled by a tick,
  // whose computed samples stay readable.
  function settle(sampled) {
    const eventCount = view.getUint32(ANIMATION_RESULT_BASE + 12, true);
    const events = [];
    for (let index = 0; index < eventCount; index++) {
      const eventAddress = engine.exports.animation_event_queue_base() + index * ANIMATION_EVENT_ENTRY_SIZE;
      const trackIndex = view.getUint16(eventAddress + 6, true);
      const allocation = allocations.get(trackIndex);
      const type = animationEventName(view.getUint8(eventAddress + 4));
      if (!allocation) {
        throw new Error(`The engine queued ${type} for track ${trackIndex}, which this controller does not hold`);
      }
      const propertyId = view.getUint16(eventAddress + 2, true);
      events.push({ nodeIndex: view.getUint16(eventAddress, true), propertyId, propertyName: animationPropertyName(propertyId),
        trackIndex, type, animationId: allocation.animationId,
        trackGeneration: allocation.trackGeneration, identity: allocation.identity });
    }
    view.setUint32(ANIMATION_RESULT_BASE + 12, 0, true);
    const endedCount = engine.exports.animation_ended_count();
    const ended = [];
    for (let index = 0; index < endedCount; index++) ended.push(engine.exports.animation_ended_track(index));
    engine.exports.animation_ended_clear();
    for (const trackIndex of ended) releaseTrack(trackIndex, sampled);
    if (suppressEvents) return;
    const batch = new Set(events.map((event) => event.identity));
    deliveringBatches.add(batch);
    try {
      for (const event of events) {
        if (batch.has(event.identity)) options.onEvent?.(event);
      }
    } finally {
      deliveringBatches.delete(batch);
    }
  }

  function cancelReplacedTracks(nodeIndex, propertyId) {
    let cursor = 0;
    for (;;) {
      const trackIndex = nextAnimationReplacement(view, allocations, engine.exports.animation_table_base(),
        ANIMATION_RECORD_SIZE, nodeIndex, propertyId, cursor);
      if (trackIndex < 0) return;
      cursor = trackIndex + 1;
      cancelTrack(trackIndex);
    }
  }

  // Lets go of a track the engine has ended and freed.
  function releaseTrack(trackIndex, sampled) {
    const owned = allocations.get(trackIndex);
    if (!owned) {
      throw new Error(`The engine ended track ${trackIndex}, which this controller does not hold`);
    }
    if (!sampled) forgetComputedSample(owned.identity);
    allocations.delete(trackIndex);
    for (const batch of deliveringBatches) batch.delete(owned.identity);
    releaseAnimationTrackIdentity(owned.identity);
  }

  // A track record, its effect stack entry and its events store the node
  // index in 16 bits.
  function requireRecordNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex > 0xffff) {
      throw new RangeError(
        `nodeIndex ${nodeIndex} does not fit the 16-bit node field of an animation track`,
      );
    }
  }

  function declareTrack(
    nodeIndex,
    propertyName,
    rawFrames,
    timing = {},
    transition = false,
    declarationOptions = {},
  ) {
    // The declaration reads the node's row. The layout buffer holds the
    // engine's live node capacity, which grows with the scene
    // (node_tables_reserve); the caller reserves the scene's rows first.
    const property = propertyNamed(propertyName);
    const composite = checkAnimationTrack(nodeIndex, engine.exports.node_capacity(), property, propertyName,
      timing.composite ?? "replace");
    // An engine-planned transition gives its frames normalized.
    const frames = declarationOptions.normalizedFrames ?? normalizeOffsets(rawFrames).map((frame) => ({
      offset: frame.offset,
      easing: normalizeEasing(frame.easing ?? "linear"),
      value: normalizeValue(property, frame.value),
    }));
    const effectiveKind = animationTrackKind(property.kind, composite, frames);

    // The declared track publishes immediately, and its replaced tracks
    // publish their cancellation. A transition takes its start and its
    // shortening while the effect it replaces still runs.
    acquire();
    const change = declarationOptions.change;
    const pending = change ? beginTransition(nodeIndex, property, propertyName, change) : 0;
    if (composite === 0 && !declarationOptions.preserveReplacedTracks) {
      cancelReplacedTracks(nodeIndex, property.id);
    }
    const stack = stackOf(nodeIndex, property.id);
    const rowsOwned = ownsRows();
    const base = stack || !rowsOwned ? NO_BASE : snapshotBase(nodeIndex, property);
    const beforeTrackIndices = declarationOptions.beforeTrackIndices;
    const envelope = writeDeclaration({
      nodeIndex,
      propertyId: property.id,
      timing,
      transition,
      composite,
      effectiveKind,
      frames,
      easing: normalizeEasing(timing.easing ?? "linear"),
      base,
      stackIndex: stack?.index ?? 0xffff,
      beforeTrackIndices: [...(beforeTrackIndices ?? [])],
      deferredBase: !stack && !rowsOwned,
    });
    if (change) engine.exports.animation_transition_apply(envelope);
    const trackIndex = engine.exports.animation_track_declare(envelope);
    if (trackIndex < 0) throwAnimationDeclarationError(trackIndex);
    if (change) {
      if (view.getUint32(pending + 12, true) === 1) change.start = startValueAt(property, pending + 168);
      const { pointer, input } = engineInput(28);
      input.setUint32(0, change.base.tag, true);
      for (let index = 0; index < 6; index++) {
        input.setFloat32(4 + index * 4, change.base.values[index] ?? 0, true);
      }
      engine.exports.animation_transition_commit(trackIndex, pointer);
    }
    const identity = createAnimationTrackIdentity(declarationOptions.animationId);
    allocations.set(trackIndex, {
      identity,
      animationId: declarationOptions.animationId ?? identity,
      trackGeneration: declarationOptions.trackGeneration ?? 1,
    });
    return trackIndex;
  }


  // The declaration envelope of animation_track_declare
  // (src/wasm/engine-animation-tracks.watpart).
  function writeDeclaration(declaration) {
    const { frames, timing } = declaration;
    // The core validates the numbers; its calls can recycle transient
    // blocks, so they run before the envelope is allocated.
    const startTime = animationNumber(timing.startTime ?? 0, "The start time");
    const duration = animationNumber(timing.duration ?? 0, "The duration");
    const delay = animationNumber(timing.delay ?? 0, "The delay");
    const iterations = animationNumber(timing.iterations ?? 1, "The iteration count", 2);
    const fillMode = animationFillMode(timing.fill);
    const directionMode = animationDirectionMode(timing.direction);
    const easingPoints = (easing) => easing.kind === 3 ? easing.points.length : 0;
    const frameBytes = frames.length * 104;
    const before = declaration.beforeTrackIndices;
    let extraBytes = easingPoints(declaration.easing) * 8 + before.length * 4;
    for (const frame of frames) {
      extraBytes += easingPoints(frame.easing) * 8 + (frame.value.components?.length ?? 0) * 28;
    }
    const { pointer, input } = engineInput(144 + frameBytes + extraBytes);
    let extra = 144 + frameBytes;
    const writeEasingBlock = (at, easing) => {
      input.setUint32(at, easing.kind, true);
      for (let index = 0; index < 4; index++) {
        input.setFloat32(at + 4 + index * 4, easing.kind === 3 ? 0 : easing.payload?.[index] ?? 0, true);
      }
      const count = easingPoints(easing);
      input.setUint32(at + 20, count, true);
      input.setUint32(at + 24, pointer + extra, true);
      for (let index = 0; index < count; index++) {
        input.setFloat32(extra, easing.points[index].input, true);
        input.setFloat32(extra + 4, easing.points[index].output, true);
        extra += 8;
      }
    };
    input.setUint32(0, declaration.nodeIndex, true);
    input.setUint32(4, declaration.propertyId, true);
    input.setUint32(8, fillMode, true);
    input.setUint32(12, directionMode, true);
    input.setUint32(16, declaration.transition ? 1 : 0, true);
    input.setUint32(20, declaration.composite, true);
    input.setUint32(24, declaration.effectiveKind, true);
    input.setUint32(28, frames.length, true);
    input.setFloat64(32, startTime, true);
    input.setFloat64(40, duration, true);
    input.setFloat64(48, delay, true);
    input.setFloat64(56, iterations, true);
    writeEasingBlock(64, declaration.easing);
    input.setUint32(92, declaration.base.tag, true);
    for (let index = 0; index < 6; index++) {
      input.setFloat32(96 + index * 4, declaration.base.values[index] ?? 0, true);
    }
    input.setUint32(120, declaration.stackIndex, true);
    input.setUint32(124, before.length, true);
    input.setUint32(128, owner, true);
    input.setUint32(132, pointer + 144, true);
    input.setUint32(136, pointer + extra, true);
    for (const trackIndex of before) {
      input.setUint32(extra, trackIndex, true);
      extra += 4;
    }
    input.setUint32(140, declaration.deferredBase ? 1 : 0, true);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      const at = 144 + frameIndex * 104;
      input.setFloat64(at, frame.offset, true);
      writeEasingBlock(at + 8, frame.easing);
      for (let index = 0; index < 6; index++) {
        input.setFloat64(at + 40 + index * 8, frame.value.values[index] ?? 0, true);
      }
      const components = frame.value.components ?? [];
      input.setUint32(at + 88, components.length, true);
      input.setUint32(at + 92, pointer + extra, true);
      for (const component of components) {
        input.setUint32(extra, component.kind, true);
        for (let parameter = 0; parameter < 6; parameter++) {
          input.setFloat32(extra + 4 + parameter * 4, component.parameters[parameter], true);
        }
        extra += 28;
      }
    }
    return pointer;
  }

  // One track per property of $keyframes. The offsets are computed over
  // all the keyframes; each track takes the keyframes that hold a value of
  // its property, which must include offsets 0 and 1 (the DOM adds the
  // implicit keyframes of the underlying value, src/dom/animation.js).
  function animate(
    nodeIndex,
    keyframes,
    timing = {},
    declarationOptions = {},
  ) {
    if (!Array.isArray(keyframes)) {
      throw new TypeError("keyframes must be an array");
    }
    const reserved = new Set(["offset", "easing", "composite"]);
    const properties = new Set(
      keyframes.flatMap((frame) =>
        Object.keys(frame).filter((key) => !reserved.has(key))
      ),
    );
    const beforeTrackIndices = new Set(
      declarationOptions.beforeTrackIndices ?? [],
    );
    const offsetKeyframes = normalizeOffsets(keyframes);
    const trackIndices = [];
    try {
      for (const propertyName of properties) {
        const propertyFrames = animationPropertyFrames(offsetKeyframes, propertyName);
        trackIndices.push(
          declareTrack(
            nodeIndex,
            propertyName,
            propertyFrames,
            {
              ...timing,
              composite: propertyFrames.at(-1).composite ?? timing.composite,
            },
            false,
            {
              beforeTrackIndices,
              animationId: declarationOptions.animationId,
              trackGeneration: declarationOptions.trackGeneration,
              preserveReplacedTracks:
                declarationOptions.preserveReplacedTracks === true,
            },
          ),
        );
      }
    } catch (error) {
      for (const trackIndex of trackIndices) cancelTrack(trackIndex);
      throw error;
    }
    return animationHandle(trackIndices);
  }

  // A transform value's own 6-float affine, when it is one matrix()
  // function. Every other transform is a function list whose numbers live
  // in its components, not in the 6-value vector: a track's base and the
  // reversing-shortening rule both need the affine, never the list.
  function transformAffineValues(normalized) {
    return normalized.components?.length === 1 &&
        normalized.components[0].kind === 5
      ? normalized.components[0].parameters
      : normalized.values;
  }

  function replaceBase(nodeIndex, propertyName, target) {
    const property = propertyNamed(propertyName);
    if (!property) {
      throw new TypeError(
        `Property is not registered for animation: ${propertyName}`,
      );
    }
    const stack = stackOf(nodeIndex, property.id);
    if (!stack) return false;
    // A shadow track's base is the node's own span, which the engine
    // captures at the sample write (the row's pointer is not known here).
    if (property.kind === 7) return false;
    const normalized = normalizeValue(property, target);
    const baseValues = property.kind === 4
      ? transformAffineValues(normalized)
      : normalized.values;
    writeStackBase(stack, { tag: normalized.tag, values: [...baseValues] });
    return true;
  }

  // Copies the rows and box sizes of this controller's effect stacks for
  // the samples of later style changes (animation_owner_capture). The
  // caller guarantees that the rows are this controller's, laid out and
  // with their post-layout transforms resolved.
  function captureLiveValues() {
    engine.exports.animation_owner_capture(owner);
  }

  // The value a transition starts from, in the base form the engine gives
  // it (u32 tag, f32 values[6], then the shadow entries' pointer and count),
  // as the transition reports it.
  function startValueAt(property, pointer) {
    const start = new DataView(engine.memory.buffer, pointer, 36);
    const values = [0, 1, 2, 3, 4, 5].map((index) => start.getFloat32(4 + index * 4, true));
    if (property.kind === 2) return { kind: "lengthPercentage", pixels: values[0], percentage: values[1] };
    if (property.kind === 1) return { kind: "scalar", value: values[0] };
    if (property.kind === 3) return { kind: "color", value: values.slice(0, 4) };
    if (property.kind === 6) return animationEnumerationName(5, values[0] ? 1 : 0);
    if (property.kind === 7) return shadowListAt(start.getUint32(28, true), start.getUint32(32, true));
    if (property.kind === 8) {
      return { kind: "lineHeight", value: values[0], unit: animationEnumerationName(4, start.getUint32(0, true)) };
    }
    if (property.kind === 10) return { kind: "scale", x: values[0], y: values[1] };
    if (property.kind === 9) {
      return {
        kind: "translate",
        x: { pixels: values[0], percentage: values[1] },
        y: { pixels: values[2], percentage: values[3] },
      };
    }
    return { kind: "transform", components: [{ kind: "matrix", value: values }] };
  }

  function shadowListAt(span, count) {
    const shadows = [];
    for (let index = 0; index < count; index++) {
      const entry = span + index * SHADOW_ENTRY_SIZE;
      shadows.push({
        offsetX: view.getFloat32(entry, true),
        offsetY: view.getFloat32(entry + 4, true),
        blur: view.getFloat32(entry + 8, true),
        spread: view.getFloat32(entry + 12, true),
        color: [0, 1, 2, 3].map((k) => view.getFloat32(entry + SHADOW_OFFSET_COLOR + k * 4, true)),
        inset: view.getUint8(entry + SHADOW_OFFSET_INSET) === 1,
      });
    }
    return { kind: "shadowList", shadows };
  }

  // The engine takes a transition's start and its reversing shortening at
  // the change's time (animation_transition_begin), before the tracks the
  // transition replaces are cancelled. Returns the pending change.
  function beginTransition(nodeIndex, property, propertyName, change) {
    const stack = stackOf(nodeIndex, property.id);
    const rowsOwned = ownsRows();
    const { pointer, input } = engineInput(128);
    new Uint8Array(engine.memory.buffer, pointer, 128).fill(0);
    input.setUint32(0, stack?.index ?? 0xffff, true);
    input.setUint32(4, nodeIndex, true);
    input.setUint32(8, property.id, true);
    input.setUint32(12, property.kind, true);
    input.setFloat64(16, change.time, true);
    input.setUint32(24, (change.callerValues ? 1 : 0) | (rowsOwned ? 2 : 0), true);
    input.setUint32(28, change.reversalTarget.length, true);
    for (let index = 0; index < change.reversalTarget.length; index++) {
      input.setFloat64(32 + index * 8, change.reversalTarget[index], true);
    }
    for (let index = 0; index < (change.callerValues?.length ?? 0); index++) {
      input.setFloat64(80 + index * 8, change.callerValues[index], true);
    }
    const pending = engine.exports.animation_transition_begin(pointer);
    if (pending === 0) {
      throw new Error(
        `Cannot start the ${propertyName} transition of node ${nodeIndex}: another scene's layout rows fill the engine, and ${stack ? "the running effect has not been laid out in this renderer's rows" : "no start value was given"}. Render this renderer first${change.callerValues ? "" : " or pass timing.startValue"}.`,
      );
    }
    return pending;
  }

  // css-transitions-1 §3. A change that interrupts a running effect starts
  // from the effect's value at the change's time; otherwise the caller's
  // before-change value is the start (timing.startValue), or the node's
  // row. The buffer is shared with synchronous layout getters, which
  // rewrite it with the after-change scene before this frame runs; a start
  // read from it then equals the end and the transition snaps. For the
  // transform the caller's value also keeps the CSS function list: a start
  // list that matches the end list is what makes a rotate() transition
  // interpolate its angle instead of its matrix.
  function transition(nodeIndex, propertyName, target, timing = {}) {
    const property = propertyNamed(propertyName);
    if (!property) {
      throw new TypeError(
        `Property is not registered for transition: ${propertyName}`,
      );
    }
    const callerStart = timing.startValue !== undefined;
    // The end the stack keeps as its base, and the vector the reversal
    // test compares: a transform list carries no numbers in its vector, so
    // the transform compares affines, the end value's resolved matrix.
    const baseTarget = normalizeValue(property, timing.baseTarget ?? target);
    const baseValues = property.kind === 4 ? transformAffineValues(baseTarget) : baseTarget.values;
    const change = {
      time: finite(timing.startTime ?? 0, "transition start time"),
      callerValues: callerStart ? normalizeValue(property, timing.startValue).values : null,
      reversalTarget: property.kind === 4 ? baseValues : normalizeValue(property, target).values,
      base: { tag: baseTarget.tag, values: [...baseValues] },
      start: null,
    };
    const trackIndex = declareTrack(
      nodeIndex,
      propertyName,
      [
        { offset: 0, value: callerStart ? timing.startValue : target },
        { offset: 1, value: target },
      ],
      timing,
      true,
      { change },
    );
    return Object.freeze({
      ...animationHandle([trackIndex]),
      // The track's duration: the requested one times the reversing
      // shortening factor.
      duration: view.getFloat64(trackAddress(trackIndex) + 32, true),
      // The value the track starts from: the caller's before-change value,
      // or the value the engine took at the change's time.
      start: change.start ?? timing.startValue,
      // The identity the track's events carry.
      animationId: allocations.get(trackIndex).animationId,
    });
  }

  // A frame value of the engine (f64 values, then 28-byte components:
  // u32 kind, f32 parameters[6]) as an animation value object.
  function frameValueObject(property, values, components) {
    if (property.kind === 2) return { kind: "lengthPercentage", pixels: values[0], percentage: values[1] };
    if (property.kind === 1) return { kind: "scalar", value: values[0] };
    if (property.kind === 3) return { kind: "color", value: values.slice(0, 4) };
    if (property.kind === 6) return { kind: "keyword", keyword: animationEnumerationName(5, values[0] ? 1 : 0) };
    if (property.kind === 8) return { kind: "lineHeight", value: values[0], unit: animationEnumerationName(4, values[1]) };
    if (property.kind === 10) return { kind: "scale", x: values[0], y: values[1] };
    if (property.kind === 9) {
      return {
        kind: "translate",
        x: { pixels: values[0], percentage: values[1] },
        y: { pixels: values[2], percentage: values[3] },
      };
    }
    if (property.kind === 7) {
      const shadows = [];
      for (let index = 0; index + 1 < components.length; index += 2) {
        const [geometry, color] = [components[index], components[index + 1]];
        shadows.push({
          offsetX: geometry.parameters[0],
          offsetY: geometry.parameters[1],
          blur: geometry.parameters[2],
          spread: geometry.parameters[3],
          color: color.parameters.slice(0, 4),
          inset: (geometry.kind & 1) === 1,
        });
      }
      return { kind: "shadowList", shadows };
    }
    return { kind: "transform", components: transformFrameComponents(components, [], null) };
  }

  // The script value of a transition frame, its transform functions named
  // after the before- or after-change transform list ($source, normalized
  // to $normalized; animation_transform_frame_names).
  function namedTransformFrame(property, frame, source, normalized) {
    const value = frameValueObject(property, frame.values, frame.components);
    if (value.kind !== "transform" || source === undefined) return value;
    return {
      kind: "transform",
      components: transformFrameComponents(frame.components, normalized.map((component) => component.kind),
        normalized.map((_, index) => source.components[index]?.kind)),
    };
  }

  // The transitions a style change starts on one node
  // (animation_transition_plan, engine-animation-transitions.watpart):
  // the before-change and after-change records, the last layout's box, the
  // CSS transform list both serializations carry, and the node's
  // transition definitions. A name the core does not animate starts no
  // transition, as in a browser, and is listed in `unanimated`.
  function planTransitions(change) {
    const definitions = [];
    const unanimated = [];
    for (const definition of change.definitions) {
      const propertyNames = animationTransitionProperties(definition.propertyName);
      if (propertyNames.length === 0) unanimated.push(definition.propertyName);
      for (const propertyName of propertyNames) {
        const property = propertyNamed(propertyName);
        if (!property) {
          throw new TypeError(`The core expands transition-property ${definition.propertyName} to ${propertyName}, which it does not know`);
        }
        definitions.push({ property, propertyName, definition });
      }
    }
    const transformProperty = propertyNamed("transform");
    const transformComponents = (transform) =>
      normalizeValue(transformProperty, {
        kind: "transform",
        components: transform.cssText === "none" ? [] : transform.components ?? [],
      }).components;
    const carriesTransform = change.previousTransform !== undefined && change.nextTransform !== undefined;
    // The core's calls can recycle transient blocks, so they run before
    // the input is allocated.
    const previousComponents = carriesTransform ? transformComponents(change.previousTransform) : [];
    const nextComponents = carriesTransform ? transformComponents(change.nextTransform) : [];
    for (const entry of definitions) {
      entry.duration = animationNumber(entry.definition.duration, `The ${entry.propertyName} transition duration`);
      entry.delay = animationNumber(entry.definition.delay, `The ${entry.propertyName} transition delay`);
    }
    const linear = normalizeEasing("linear");
    const byteLength = 56 + change.previousRecord.byteLength + change.nextRecord.byteLength +
      (previousComponents.length + nextComponents.length) * 28 + definitions.length * 24;
    const { pointer, input } = engineInput(byteLength);
    const bytes = new Uint8Array(engine.memory.buffer, pointer, byteLength);
    bytes.fill(0, 0, 56);
    let cursor = 56;
    const place = (source) => {
      bytes.set(source, cursor);
      const at = pointer + cursor;
      cursor += source.byteLength;
      return at;
    };
    input.setUint32(0, place(change.previousRecord), true);
    input.setUint32(4, change.previousRecord.byteLength, true);
    input.setUint32(8, place(change.nextRecord), true);
    input.setUint32(12, change.nextRecord.byteLength, true);
    input.setFloat32(16, change.box?.w ?? 0, true);
    input.setFloat32(20, change.box?.h ?? 0, true);
    input.setUint32(24, carriesTransform ? 1 : 0, true);
    const placeComponents = (components) => {
      const at = pointer + cursor;
      for (const component of components) {
        input.setUint32(cursor, component.kind, true);
        for (let index = 0; index < 6; index++) {
          input.setFloat32(cursor + 4 + index * 4, component.parameters[index], true);
        }
        cursor += 28;
      }
      return at;
    };
    input.setUint32(28, previousComponents.length, true);
    input.setUint32(32, placeComponents(previousComponents), true);
    input.setUint32(36, nextComponents.length, true);
    input.setUint32(40, placeComponents(nextComponents), true);
    input.setUint32(48, definitions.length, true);
    input.setUint32(52, pointer + cursor, true);
    for (const { property, duration, delay } of definitions) {
      input.setUint32(cursor, property.id, true);
      input.setFloat64(cursor + 8, duration, true);
      input.setFloat64(cursor + 16, delay, true);
      cursor += 24;
    }
    const count = engine.exports.animation_transition_plan(pointer);
    if (count === -1) {
      throw new RangeError(`A style change starts more than 64 transitions on one element (${definitions.length} definitions)`);
    }
    const output = engine.exports.animation_transition_plan_output();
    const plan = new DataView(engine.memory.buffer);
    const frameAt = (at, property) => {
      const kindCount = property.kind === 4 ? 0 : property.kind === 2 ? 3 : property.kind === 3 ? 4
        : property.kind === 7 ? 6 : property.kind === 8 ? 2 : property.kind === 9 ? 4 : property.kind === 10 ? 2 : 1;
      const values = Array.from({ length: kindCount }, (_, index) => plan.getFloat64(at + index * 8, true));
      const componentCount = plan.getUint32(at + 48, true);
      const componentAt = plan.getUint32(at + 52, true);
      const components = Array.from({ length: componentCount }, (_, index) => ({
        kind: plan.getUint32(componentAt + index * 28, true),
        parameters: Array.from({ length: 6 }, (_, parameter) =>
          plan.getFloat32(componentAt + index * 28 + 4 + parameter * 4, true)),
      }));
      return { values, components };
    };
    const transitions = [];
    for (let index = 0; index < count; index++) {
      const entry = output + index * 200;
      const { property, propertyName, definition } = definitions[plan.getUint32(entry + 4, true)];
      const start = frameAt(entry + 8, property);
      const end = frameAt(entry + 64, property);
      const tag = plan.getUint32(entry + 120, true);
      const frameValue = (frame) => ({
        kind: property.kind,
        tag,
        values: frame.values,
        ...(property.kind === 4 || property.kind === 7 ? { components: frame.components } : {}),
      });
      transitions.push({
        propertyName,
        definition,
        frames: [
          { offset: 0, easing: linear, value: frameValue(start) },
          { offset: 1, easing: linear, value: frameValue(end) },
        ],
        startValue: namedTransformFrame(property, start, change.previousTransform, previousComponents),
        endValue: namedTransformFrame(property, end, change.nextTransform, nextComponents),
        base: {
          tag,
          values: Array.from({ length: 6 }, (_, value) => plan.getFloat32(entry + 124 + value * 4, true)),
        },
        reversalTarget: Array.from({ length: plan.getUint32(entry + 148, true) }, (_, value) =>
          plan.getFloat64(entry + 152 + value * 8, true)),
      });
    }
    return { transitions, unanimated };
  }

  // Declares a transition planned by planTransitions. The change's time
  // (`changeTime`, the track's start time when absent) is when the running
  // effects the transition interrupts are sampled; `animationId` and
  // `trackGeneration` give the track the identity of the object that holds
  // it.
  function startPlannedTransition(nodeIndex, planned, timing, { changeTime, animationId, trackGeneration } = {}) {
    const change = {
      time: finite(changeTime ?? timing.startTime ?? 0, "transition change time"),
      callerValues: planned.frames[0].value.values,
      reversalTarget: planned.reversalTarget,
      base: planned.base,
      start: null,
    };
    const trackIndex = declareTrack(nodeIndex, planned.propertyName, null, timing, true, {
      change,
      normalizedFrames: planned.frames,
      animationId,
      trackGeneration,
    });
    return Object.freeze({
      ...animationHandle([trackIndex]),
      duration: view.getFloat64(trackAddress(trackIndex) + 32, true),
      start: change.start ?? planned.startValue,
      animationId: allocations.get(trackIndex).animationId,
    });
  }

  // A transition track declared again over its own endpoints (a
  // CSSTransition whose time, rate or direction changed): the keyframes
  // and the transition's events, with no reversing shortening and no new
  // base, which the first declaration already wrote.
  function declareTransitionTrack(nodeIndex, propertyName, keyframes, timing, declarationOptions = {}) {
    return animationHandle([
      declareTrack(nodeIndex, propertyName, keyframes, timing, true, declarationOptions),
    ]);
  }

  function animationHandle(trackIndices) {
    const identities = new Map(trackIndices.map((slot) => [slot, allocations.get(slot)]));
    return Object.freeze({
      trackIndices: [...trackIndices],
      cancel() {
        for (const owned of identities.values()) forgetComputedSample(owned.identity);
        let writeCount = 0;
        for (const trackIndex of trackIndices) {
          const owned = identities.get(trackIndex);
          if (allocations.get(trackIndex) !== owned) continue;
          acquire();
          writeCount += cancelTrack(trackIndex);
        }
        return writeCount;
      },
      cancelSilently() {
        for (const owned of identities.values()) forgetComputedSample(owned.identity);
        suppressEvents = true;
        try {
          let writeCount = 0;
          for (const trackIndex of trackIndices) {
            const owned = identities.get(trackIndex);
            if (allocations.get(trackIndex) !== owned) continue;
            acquire();
            writeCount += cancelTrack(trackIndex);
          }
          return writeCount;
        } finally {
          suppressEvents = false;
        }
      },
      pause(time) {
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          engine.exports.pause_animation(
            trackIndex,
            finite(time, "pause time"),
          );
        }
      },
      resume(time) {
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          engine.exports.resume_animation(
            trackIndex,
            finite(time, "resume time"),
          );
        }
      },
      seek(localTime, sampleTime) {
        const resolvedLocalTime = finite(localTime, "animation local time");
        const resolvedSampleTime = finite(sampleTime, "animation sample time");
        for (const trackIndex of trackIndices) {
          if (allocations.get(trackIndex) !== identities.get(trackIndex)) continue;
          acquire();
          engine.exports.seek_animation(trackIndex, resolvedLocalTime, resolvedSampleTime);
        }
      },
    });
  }

  function remapNodes(indexMap) {
    if (!(indexMap instanceof Map)) {
      throw new TypeError("indexMap must be a Map");
    }
    // Check every new index before any state changes. The next frame's
    // row write reserves the node tables for the remapped scene.
    for (const trackIndex of allocations.keys()) {
      const nextNodeIndex = indexMap.get(view.getUint16(trackAddress(trackIndex), true));
      if (nextNodeIndex !== undefined) requireRecordNodeIndex(nextNodeIndex);
    }
    computedSamples?.core.remapComputedSamples(computedSamples.owner, indexMap);
    acquire();
    const { pointer, input } = engineInput(Math.max(8, indexMap.size * 8));
    let offset = 0;
    for (const [previousNodeIndex, nextNodeIndex] of indexMap) {
      input.setUint32(offset, previousNodeIndex, true);
      input.setUint32(offset + 4, nextNodeIndex, true);
      offset += 8;
    }
    const writeCount = engine.exports.animation_owner_remap(owner, pointer, indexMap.size, ownsRows() ? 1 : 0);
    settle(false);
    return writeCount;
  }

  function tick(time) {
    acquire();
    sampleTime = time;
    const resultAddress = engine.exports.tick(finite(time, "tick time"));
    const result = {
      writeCount: view.getUint32(resultAddress, true),
      transformSampleCount: view.getUint32(resultAddress + 4, true),
      liveTrackCount: view.getUint32(resultAddress + 8, true),
      eventCount: view.getUint32(resultAddress + 12, true),
    };
    captureComputedSamples();
    settle(true);
    return result;
  }
  // Samples this controller's tracks onto its rows, which the caller has
  // just written to the engine. The layout that follows reads the table
  // and the bases, so both are prepared even when there is nothing to
  // sample.
  function resample() {
    prepareLayout();
    if (sampleTime !== null && allocations.size !== 0) return tick(sampleTime);
    return null;
  }

  // Whether this controller runs an effect on the node's property: a
  // transition declared there interrupts it.
  function hasEffect(nodeIndex, propertyName) {
    const property = propertyNamed(propertyName);
    if (!property) {
      throw new TypeError(`Property is not registered for animation: ${propertyName}`);
    }
    return stackOf(nodeIndex, property.id) !== null;
  }

  // Brings the running transitions to the time of a style change before it
  // declares new ones (css-transitions-1 §3: the change sees them updated
  // to its own time, not to the last frame). A transition whose end that
  // time reaches has completed: it reports transitionend and leaves its
  // effect stack, so the change starts a new transition from its end value
  // instead of cancelling and reversing it. While this controller's rows
  // fill the buffer, the tick also leaves each running track's value at
  // that time in its node's row, where an interrupting transition reads
  // its start and a reversal its progress. Another scene's rows take no
  // sample; the value after this controller's last layout stands in for a
  // running one, and a completed one is finished without touching them.
  function advance(time) {
    acquire();
    if (ownsRows()) return tick(time);
    finite(time, "advance time");
    // The engine ends the running transitions that time reaches, without
    // sampling them; paused and filled tracks do not end.
    engine.exports.animation_advance(time);
    settle(false);
    return null;
  }

  // The value that the effect stack of a track gives its property at
  // `time`, composed through that track (commitStyles(), Web Animations 1,
  // section 6.4): its property's canonical name and value object.
  function sampleThrough(trackIndex, time) {
    if (!allocations.has(trackIndex)) {
      throw new RangeError(`Track ${trackIndex} is not a track of this controller`);
    }
    acquire();
    const address = trackAddress(trackIndex);
    const propertyId = view.getUint16(address + 2, true);
    const property = propertyWithId(propertyId);
    const pointer = engine.exports.animation_stack_sample_through(
      trackIndex, finite(time, "sample time"), ownsRows() ? 1 : 0);
    if (pointer === 0) {
      throw new Error(`Track ${trackIndex} has no laid-out row to sample: render its renderer first`);
    }
    return { propertyName: animationPropertyName(propertyId), value: startValueAt(property, pointer) };
  }

  // Ends the controller: its view stops following the engine's memory.
  // The owner cancels the tracks it still holds first (cancelAll).
  function dispose() {
    removeViewRefresh();
  }

  return Object.freeze({
    bindComputedSamples,
    captureComputedSamples,
    captureLiveValues,
    captureComputedGeometry,
    captureComputedPseudos,
    animate,
    transition,
    planTransitions,
    startPlannedTransition,
    declareTransitionTrack,
    declareTrack,
    tick,
    advance,
    sampleThrough,
    hasEffect,
    resample,
    remapNodes,
    replaceBase,
    prepareLayout,
    cancelAll,
    dispose,
  });
}
