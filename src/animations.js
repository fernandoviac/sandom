import {
  normalizeAnimationOffsets,
  animationNumber,
  createAnimationTrackTable,
  releaseAnimationTrackTable,
  bindAnimationTrack,
  animationTrackIdentity,
  animationTrackAnimationId,
  animationTrackCount,
  animationTrackSlots,
  settleAnimationTracks,
  animationTrackBatchLive,
  endAnimationTrackBatch,
  nextAnimationReplacement,
  normalizeAnimationEasing as normalizeEasing,
  animationPropertyFrames,
  animationTransitionProperties,
  animationTransitionNameOrder,
  animationProperty,
  animationDirectionMode,
  animationFillMode,
  throwAnimationDeclarationError,
  animationEventName,
  canonicalAnimationValue,
  composeAnimationValue,
  animationPropertyName,
  animationTrackKind,
  checkAnimationTrack,
  keyframePropertyNames,
  isAnimationDependency,
} from "./dom-wasm/animation.js";
import { boxSnapshotFor } from "./dom-wasm/geometry-wire.js";
import {
  ANIMATION_EVENT_ENTRY_SIZE,
  ANIMATION_EVENT_QUEUE_BASE,
  ANIMATION_EVENT_QUEUE_SIZE,
  ANIMATION_RECORD_SIZE,
  ANIMATION_RESULT_BASE,
  SHADOW_ENTRY_SIZE,
  SHADOW_OFFSET_BLUR,
  SHADOW_OFFSET_COLOR,
  SHADOW_OFFSET_INSET,
  SHADOW_OFFSET_OFFSET_X,
  SHADOW_OFFSET_OFFSET_Y,
  SHADOW_OFFSET_SPREAD,
} from "./wasm/layout.js";
import { layoutConstant } from "./wasm/layout-table.js";
import { isPseudoElementTarget } from "./dom/pseudo-element-target.js";

// The animation codes of the engine and the DOM core, by the names of
// their WAT globals.
const ANIMATION_KIND_TRANSFORM = layoutConstant("ANIMATION_KIND_TRANSFORM");
const ANIMATION_KIND_SHADOW = layoutConstant("ANIMATION_KIND_SHADOW");
const ANIMATION_NO_STACK = layoutConstant("ANIMATION_NO_STACK");
const ANIMATION_TRACK_NODE_LIMIT = layoutConstant("ANIMATION_TRACK_NODE_LIMIT");
const EASING_KIND_LINEAR = layoutConstant("EASING_KIND_LINEAR");
const TRANSFORM_COMPONENT_MATRIX = layoutConstant("TRANSFORM_COMPONENT_MATRIX");
// The engine kinds of a shadow list's components.
const SHADOW_COMPONENT_GEOMETRY = layoutConstant("SHADOW_COMPONENT_GEOMETRY");
const SHADOW_COMPONENT_COLOR = layoutConstant("SHADOW_COMPONENT_COLOR");
// The fields of an engine animation record, by the names of its globals
// (engine-constants.watpart).
const animationRecord = (prefix, fields) =>
  Object.freeze(Object.fromEntries(fields.map((field) => [field, layoutConstant(`${prefix}_${field}`)])));
const PROPERTY_LAYOUT = animationRecord("ANIMATION_PROPERTY_LAYOUT", ["SIZE", "VALUE", "TAG", "PERCENTAGE", "KIND"]);
const BASE = animationRecord("ANIMATION_BASE", ["SIZE", "TAG", "VALUES"]);
const START = animationRecord("ANIMATION_START", ["SIZE", "TAG", "VALUES", "SHADOW_SPAN", "SHADOW_COUNT"]);
const EASING = animationRecord("ANIMATION_EASING",
  ["KIND", "PAYLOAD", "POINT_COUNT", "POINTS", "POINT_SIZE", "POINT_INPUT", "POINT_OUTPUT"]);
const COMPONENT = animationRecord("ANIMATION_COMPONENT", ["SIZE", "KIND", "PARAMETERS"]);
const DECLARATION = animationRecord("ANIMATION_DECLARATION", ["SIZE", "NODE", "PROPERTY", "FILL", "DIRECTION",
  "TRANSITION", "COMPOSITE", "VALUE_KIND", "FRAME_COUNT", "START", "DURATION", "DELAY", "ITERATIONS", "EASING",
  "BASE_TAG", "BASE_VALUES", "STACK", "PRECEDES_COUNT", "OWNER", "FRAMES", "PRECEDES", "FLAGS", "DEFERRED_BASE"]);
const FRAME = animationRecord("ANIMATION_FRAME", ["SIZE", "OFFSET", "EASING", "VALUES", "COMPONENT_COUNT", "COMPONENTS", "COMPOSITE"]);
const BEGIN = animationRecord("ANIMATION_BEGIN", ["SIZE", "STACK", "NODE", "PROPERTY", "KIND", "TIME", "FLAGS",
  "TARGET_COUNT", "TARGET", "CALLER_VALUES", "HAS_CALLER_VALUES", "ROWS_OWNED"]);
const PLAN = animationRecord("ANIMATION_PLAN", ["INPUT_SIZE", "PREVIOUS", "PREVIOUS_LENGTH", "NEXT", "NEXT_LENGTH",
  "BOX_WIDTH", "BOX_HEIGHT", "CARRIES_TRANSFORM", "PREVIOUS_COMPONENT_COUNT", "PREVIOUS_COMPONENTS",
  "NEXT_COMPONENT_COUNT", "NEXT_COMPONENTS", "DEFINITION_COUNT", "DEFINITIONS"]);
const PLAN_DEFINITION = animationRecord("ANIMATION_PLAN_DEFINITION", ["SIZE", "PROPERTY", "DURATION", "DELAY"]);
const PLAN_ENTRY = animationRecord("ANIMATION_PLAN_ENTRY",
  ["SIZE", "DEFINITION", "START", "END", "TAG", "BASE", "TARGET_COUNT", "TARGET"]);
const PLAN_FRAME = animationRecord("ANIMATION_PLAN_FRAME", ["VALUES", "COMPONENT_COUNT", "COMPONENTS"]);
const ANIMATION_RECORD_DURATION = layoutConstant("ANIMATION_RECORD_DURATION");
const PENDING = animationRecord("ANIMATION_PENDING", ["STATE", "SAMPLED", "START"]);
const RESULT = animationRecord("ANIMATION_RESULT", ["WRITES", "TRANSFORM_SAMPLES", "LIVE_TRACKS", "EVENTS"]);
const EVENT = animationRecord("ANIMATION_EVENT", ["NODE", "PROPERTY", "TYPE", "SLOT"]);
const REMAP = animationRecord("ANIMATION_REMAP", ["SIZE", "PREVIOUS", "NEXT"]);
const RECORD = animationRecord("ANIMATION_RECORD", ["NODE", "PROPERTY"]);
const F32 = Float32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
// Writes an ANIMATION_COMPONENT (kind, six f32 parameters) at `at`.
function writeComponent(input, at, component) {
  input.setUint32(at + COMPONENT.KIND, component.kind, true);
  for (let parameter = 0; parameter < 6; parameter++) {
    input.setFloat32(at + COMPONENT.PARAMETERS + parameter * F32, component.parameters[parameter], true);
  }
}

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
  // they grow (core/engine/engine-animation-pools.watpart): each address is
  // read from the engine when it is used.
  const trackAddress = (trackIndex) => engine.exports.animation_table_base() + trackIndex * ANIMATION_RECORD_SIZE;
  let sampleTime = null;
  let computedSamples = null;
  function bindComputedSamples(binding) {
    computedSamples = binding;
  }
  // The element handle and pseudo-element kind (0 the element, 1 ::before,
  // 2 ::after) of animation target `target` (an element, or a
  // pseudo-element-target.js identity) whose samples `core` keeps; null
  // for another core's or no target.
  function sampledTarget(target, core) {
    if (!target) return null;
    const pseudo = isPseudoElementTarget(target);
    const element = pseudo ? target.element : target;
    if (element._domCore !== core) return null;
    return { handle: element._coreHandle, pseudo: pseudo ? target.kind : 0 };
  }
  function captureComputedSamples() {
    if (!computedSamples || sampleTime === null) return;
    const { core, owner, targets } = computedSamples;
    for (const slot of animationTrackSlots(trackTable)) {
      const identity = animationTrackIdentity(trackTable, slot);
      const address = trackAddress(slot);
      const index = view.getUint16(address + RECORD.NODE, true);
      const target = sampledTarget(targets[index], core);
      if (target === null) continue;
      const property = propertyWithId(view.getUint16(address + RECORD.PROPERTY, true));
      core.captureComputedSample(engine, owner, identity,
        target.handle, target.pseudo, index, address, property, sampleTime);
    }
  }
  // `generatedRows`: the rows of the scene's ::before and ::after boxes,
  // or undefined for a scene that does not list them.
  function captureComputedPseudos(nodes, boxes, generatedRows) {
    if (!computedSamples) return;
    const { core, owner } = computedSamples;
    core.captureComputedPseudos(engine, owner, nodes, boxes, generatedRows);
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
  // The tracks this controller holds, their identities and the batches of
  // their events being delivered (animation-track-table.watpart).
  const trackTable = createAnimationTrackTable();
  // This controller's effect stack on a node's property, or null
  // (animation_owner_stack).
  function stackOf(nodeIndex, propertyId) {
    const index = engine.exports.animation_owner_stack(owner, nodeIndex, propertyId);
    return index === ANIMATION_NO_STACK ? null : { index };
  }

  // An animation property from the core's table, by its id: its canonical
  // name, its value kind and where its value lies in a node row.
  function propertyWithId(id) {
    const layout = new DataView(engine.memory.buffer, engine.exports.animation_property_layout(id), PROPERTY_LAYOUT.SIZE);
    const property = {
      id,
      valueOffset: layout.getUint32(PROPERTY_LAYOUT.VALUE, true),
      tagOffset: layout.getUint32(PROPERTY_LAYOUT.TAG, true),
      percentageOffset: layout.getUint32(PROPERTY_LAYOUT.PERCENTAGE, true),
      kind: layout.getUint32(PROPERTY_LAYOUT.KIND, true),
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
  // Each acquisition counts: every change of the tracks or their time
  // acquires first, so an unchanged count proves the samples unchanged
  // (`revision`, which a held synchronous layout keeps).
  let revision = 0;
  function acquire() {
    revision++;
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
    engine.exports.animation_stack_write_base(stack.index, writeBase(base));
  }

  // An ANIMATION_BASE record of $base in engine input.
  function writeBase(base) {
    const { pointer, input } = engineInput(BASE.SIZE);
    input.setUint32(BASE.TAG, base.tag, true);
    for (let index = 0; index < 6; index++) {
      input.setFloat32(BASE.VALUES + index * F32, base.values[index] ?? 0, true);
    }
    return pointer;
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
    const slots = animationTrackSlots(trackTable);
    const identities = slots.map((slot) => animationTrackIdentity(trackTable, slot));
    slots.forEach((trackIndex, index) => {
      if (animationTrackIdentity(trackTable, trackIndex) !== identities[index]) return;
      acquire();
      writeCount += cancelTrack(trackIndex);
    });
    // A controller without tracks releases the table.
    if (animationTrackCount(trackTable) === 0) engine.exports.animation_owner_release(owner);
    return writeCount;
  }
  // The node's value beneath every effect, as the engine reads it from the
  // node row (animation_node_base, engine-animation-tracks.watpart).
  function snapshotBase(nodeIndex, property) {
    const pointer = engine.exports.animation_node_base(nodeIndex, property.id);
    const base = new DataView(engine.memory.buffer, pointer, BASE.SIZE);
    return {
      tag: base.getUint32(BASE.TAG, true),
      values: [0, 1, 2, 3, 4, 5].map((index) => base.getFloat32(BASE.VALUES + index * F32, true)),
    };
  }

  // Takes what the last engine operation queued: its events, each naming
  // its track, and the tracks it ended, which the engine has already freed.
  // The ended tracks leave this controller before any host code runs, so
  // a slot the engine frees is never declared again while this controller
  // still holds it. The events are delivered as one batch; a track that
  // host code ends during the delivery has its later events in it dropped
  // (animation_tracks_settle). `sampled`: the ended tracks were sampled by
  // a tick, whose computed samples stay readable.
  function settle(sampled) {
    const eventCount = view.getUint32(ANIMATION_RESULT_BASE + RESULT.EVENTS, true);
    const queued = [];
    for (let index = 0; index < eventCount; index++) {
      const eventAddress = engine.exports.animation_event_queue_base() + index * ANIMATION_EVENT_ENTRY_SIZE;
      queued.push({ nodeIndex: view.getUint16(eventAddress + EVENT.NODE, true),
        propertyId: view.getUint16(eventAddress + EVENT.PROPERTY, true),
        type: view.getUint8(eventAddress + EVENT.TYPE), slot: view.getUint16(eventAddress + EVENT.SLOT, true) });
    }
    view.setUint32(ANIMATION_RESULT_BASE + RESULT.EVENTS, 0, true);
    const endedCount = engine.exports.animation_ended_count();
    const ended = [];
    for (let index = 0; index < endedCount; index++) ended.push(engine.exports.animation_ended_track(index));
    engine.exports.animation_ended_clear();
    const deliver = !suppressEvents;
    const settled = settleAnimationTracks(trackTable, queued, ended, deliver);
    if (!sampled) for (const identity of settled.ended) forgetComputedSample(identity);
    if (!deliver) return;
    try {
      const events = queued.map(({ nodeIndex, propertyId, type, slot }, index) => ({
        nodeIndex, propertyId, propertyName: animationPropertyName(propertyId),
        trackIndex: slot, type: animationEventName(type), ...settled.events[index],
      }));
      events.forEach((event, index) => {
        if (animationTrackBatchLive(trackTable, index)) options.onEvent?.(event);
      });
    } finally {
      endAnimationTrackBatch(trackTable);
    }
  }

  // The tracks of this controller's effect stack on the node's property, in
  // chain order: the only tracks a new effect there can replace.
  function stackTracks(nodeIndex, propertyId) {
    const stack = stackOf(nodeIndex, propertyId);
    const tracks = [];
    if (stack === null) return tracks;
    for (let track = engine.exports.animation_stack_first_track(stack.index); track !== ANIMATION_NO_STACK;
      track = engine.exports.animation_stack_next_track(track)) tracks.push(track);
    return tracks;
  }

  function cancelReplacedTracks(nodeIndex, propertyId) {
    let cursor = 0;
    for (;;) {
      const candidates = stackTracks(nodeIndex, propertyId);
      const trackIndex = nextAnimationReplacement(engine, trackTable, ANIMATION_RECORD_SIZE, candidates, nodeIndex, propertyId, cursor);
      if (trackIndex < 0) return;
      cursor = trackIndex + 1;
      cancelTrack(trackIndex);
    }
  }

  // A track record, its effect stack entry and its events store the node
  // index in 16 bits.
  function requireRecordNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex > ANIMATION_TRACK_NODE_LIMIT) {
      throw new RangeError(
        `nodeIndex ${nodeIndex} does not fit the 16-bit node field of an animation track`,
      );
    }
  }

  // A box size's keyframes between a size keyword and a length interpolate
  // as calc-size() (CSS Sizing 4 §7.2-7.3) when the engine pairs each span
  // (animation_calc_size_span): the element's interpolate-size allows it,
  // and the bases match. A keyword is the canonical keyword value (kind 5,
  // its tag); each span's end frame takes the span's pairing, so the
  // track's frames are lengths. Otherwise the frames stay as declared and
  // the keyword changes discretely.
  function calcSizeFrames(nodeIndex, property, frames) {
    if (property.kind !== 2 || frames.length < 2 || !frames.some((frame) => frame.value.kind === 5)) return frames;
    const endpoint = ({ value }) => {
      if (value.kind === 5) return [0, 0, 0, 1, value.tag + 1, -1];
      if (value.kind === 2) return [value.values[0], value.values[1], value.values[0], 0, 0, 0];
      return null;
    };
    const paired = [];
    for (let index = 0; index + 1 < frames.length; index++) {
      const start = endpoint(frames[index]);
      const end = endpoint(frames[index + 1]);
      if (start === null || end === null) return frames;
      const { pointer, input } = engineInput(12 * F64);
      [...start, ...end].forEach((number, at) => input.setFloat64(at * F64, number, true));
      if (!engine.exports.animation_calc_size_span(nodeIndex, property.id, pointer)) return frames;
      const result = new DataView(engine.memory.buffer, pointer, 12 * F64);
      const values = (from) => Array.from({ length: 6 }, (_, at) => result.getFloat64((from + at) * F64, true));
      const spanStart = values(0);
      const spanEnd = values(6);
      // A span between two lengths stays a length span: mixed spans change
      // discretely.
      if (spanEnd[4] === 0) return frames;
      if (index === 0) paired.push(spanStart);
      paired.push(spanEnd);
    }
    return frames.map((frame, index) => ({
      ...frame,
      value: composeAnimationValue(property, { tag: 5, values: paired[index] }),
    }));
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
    const declaredFrames = declarationOptions.normalizedFrames ?? normalizeOffsets(rawFrames).map((frame) => ({
      offset: frame.offset,
      easing: normalizeEasing(frame.easing ?? "linear"),
      composite: frame.composite === undefined || frame.composite === "auto" ? 0 :
        checkAnimationTrack(nodeIndex, engine.exports.node_capacity(), property, propertyName, frame.composite) + 1,
      value: canonicalAnimationValue(property, frame.value),
    }));
    const frames = declarationOptions.normalizedFrames ? declaredFrames : calcSizeFrames(nodeIndex, property, declaredFrames);
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
      stackIndex: stack?.index ?? ANIMATION_NO_STACK,
      beforeTrackIndices: [...(beforeTrackIndices ?? [])],
      deferredBase: !stack && !rowsOwned,
    });
    if (change) engine.exports.animation_transition_apply(envelope);
    const trackIndex = engine.exports.animation_track_declare(envelope);
    if (trackIndex < 0) throwAnimationDeclarationError(trackIndex);
    if (change) {
      if (view.getUint32(pending + PENDING.STATE, true) === PENDING.SAMPLED) {
        change.start = startValueAt(property, pending + PENDING.START);
      }
      engine.exports.animation_transition_commit(trackIndex, writeBase(change.base));
    }
    bindAnimationTrack(trackTable, trackIndex, declarationOptions.animationId, declarationOptions.trackGeneration);
    return trackIndex;
  }


  // The declaration envelope of animation_track_declare
  // (core/engine/engine-animation-tracks.watpart).
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
    const easingPoints = (easing) => easing.kind === EASING_KIND_LINEAR ? easing.points.length : 0;
    const frameBytes = frames.length * FRAME.SIZE;
    const before = declaration.beforeTrackIndices;
    let extraBytes = easingPoints(declaration.easing) * EASING.POINT_SIZE + before.length * 4;
    for (const frame of frames) {
      extraBytes += easingPoints(frame.easing) * EASING.POINT_SIZE + (frame.value.components?.length ?? 0) * COMPONENT.SIZE;
    }
    const { pointer, input } = engineInput(DECLARATION.SIZE + frameBytes + extraBytes);
    let extra = DECLARATION.SIZE + frameBytes;
    const writeEasingBlock = (at, easing) => {
      input.setUint32(at + EASING.KIND, easing.kind, true);
      for (let index = 0; index < 4; index++) {
        input.setFloat32(at + EASING.PAYLOAD + index * F32,
          easing.kind === EASING_KIND_LINEAR ? 0 : easing.payload?.[index] ?? 0, true);
      }
      const count = easingPoints(easing);
      input.setUint32(at + EASING.POINT_COUNT, count, true);
      input.setUint32(at + EASING.POINTS, pointer + extra, true);
      for (let index = 0; index < count; index++) {
        input.setFloat32(extra + EASING.POINT_INPUT, easing.points[index].input, true);
        input.setFloat32(extra + EASING.POINT_OUTPUT, easing.points[index].output, true);
        extra += EASING.POINT_SIZE;
      }
    };
    input.setUint32(DECLARATION.NODE, declaration.nodeIndex, true);
    input.setUint32(DECLARATION.PROPERTY, declaration.propertyId, true);
    input.setUint32(DECLARATION.FILL, fillMode, true);
    input.setUint32(DECLARATION.DIRECTION, directionMode, true);
    input.setUint32(DECLARATION.TRANSITION, declaration.transition ? 1 : 0, true);
    input.setUint32(DECLARATION.COMPOSITE, declaration.composite, true);
    input.setUint32(DECLARATION.VALUE_KIND, declaration.effectiveKind, true);
    input.setUint32(DECLARATION.FRAME_COUNT, frames.length, true);
    input.setFloat64(DECLARATION.START, startTime, true);
    input.setFloat64(DECLARATION.DURATION, duration, true);
    input.setFloat64(DECLARATION.DELAY, delay, true);
    input.setFloat64(DECLARATION.ITERATIONS, iterations, true);
    writeEasingBlock(DECLARATION.EASING, declaration.easing);
    input.setUint32(DECLARATION.BASE_TAG, declaration.base.tag, true);
    for (let index = 0; index < 6; index++) {
      input.setFloat32(DECLARATION.BASE_VALUES + index * F32, declaration.base.values[index] ?? 0, true);
    }
    input.setUint32(DECLARATION.STACK, declaration.stackIndex, true);
    input.setUint32(DECLARATION.PRECEDES_COUNT, before.length, true);
    input.setUint32(DECLARATION.OWNER, owner, true);
    input.setUint32(DECLARATION.FRAMES, pointer + DECLARATION.SIZE, true);
    input.setUint32(DECLARATION.PRECEDES, pointer + extra, true);
    for (const trackIndex of before) {
      input.setUint32(extra, trackIndex, true);
      extra += 4;
    }
    input.setUint32(DECLARATION.FLAGS, declaration.deferredBase ? DECLARATION.DEFERRED_BASE : 0, true);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      const at = DECLARATION.SIZE + frameIndex * FRAME.SIZE;
      input.setFloat64(at + FRAME.OFFSET, frame.offset, true);
      writeEasingBlock(at + FRAME.EASING, frame.easing);
      input.setUint32(at + FRAME.COMPOSITE, frame.composite ?? 0, true);
      for (let index = 0; index < 6; index++) {
        input.setFloat64(at + FRAME.VALUES + index * F64, frame.value.values[index] ?? 0, true);
      }
      const components = frame.value.components ?? [];
      input.setUint32(at + FRAME.COMPONENT_COUNT, components.length, true);
      input.setUint32(at + FRAME.COMPONENTS, pointer + extra, true);
      for (const component of components) {
        writeComponent(input, extra, component);
        extra += COMPONENT.SIZE;
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
    const properties = new Set(keyframes.flatMap(keyframePropertyNames));
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
            timing,
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
        normalized.components[0].kind === TRANSFORM_COMPONENT_MATRIX
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
    if (property.kind === ANIMATION_KIND_SHADOW) return false;
    // A base given as a function computes once a stack takes it.
    const normalized = canonicalAnimationValue(property, typeof target === "function" ? target() : target);
    const baseValues = property.kind === ANIMATION_KIND_TRANSFORM
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
  // it (u32 tag, f32 values[6], then the shadow entries' pointer and
  // count), as a canonical value (animation_value_compose).
  function startValueAt(property, pointer) {
    const start = new DataView(engine.memory.buffer, pointer, START.SIZE);
    const span = start.getUint32(START.SHADOW_SPAN, true);
    const components = [];
    for (let index = 0; index < start.getUint32(START.SHADOW_COUNT, true); index++) {
      const entry = span + index * SHADOW_ENTRY_SIZE;
      components.push(
        { kind: SHADOW_COMPONENT_GEOMETRY | view.getUint8(entry + SHADOW_OFFSET_INSET),
          parameters: [SHADOW_OFFSET_OFFSET_X, SHADOW_OFFSET_OFFSET_Y, SHADOW_OFFSET_BLUR, SHADOW_OFFSET_SPREAD, null, null]
            .map((field) => field === null ? 0 : view.getFloat32(entry + field, true)) },
        { kind: SHADOW_COMPONENT_COLOR,
          parameters: [0, 1, 2, 3, null, null].map((channel) => channel === null ? 0 : view.getFloat32(entry + SHADOW_OFFSET_COLOR + channel * F32, true)) },
      );
    }
    return composeAnimationValue(property, {
      tag: start.getUint32(START.TAG, true),
      values: [0, 1, 2, 3, 4, 5].map((index) => start.getFloat32(START.VALUES + index * F32, true)),
      components,
    });
  }

  // The engine takes a transition's start and its reversing shortening at
  // the change's time (animation_transition_begin), before the tracks the
  // transition replaces are cancelled. Returns the pending change.
  function beginTransition(nodeIndex, property, propertyName, change) {
    const stack = stackOf(nodeIndex, property.id);
    const rowsOwned = ownsRows();
    const { pointer, input } = engineInput(BEGIN.SIZE);
    new Uint8Array(engine.memory.buffer, pointer, BEGIN.SIZE).fill(0);
    input.setUint32(BEGIN.STACK, stack?.index ?? ANIMATION_NO_STACK, true);
    input.setUint32(BEGIN.NODE, nodeIndex, true);
    input.setUint32(BEGIN.PROPERTY, property.id, true);
    input.setUint32(BEGIN.KIND, property.kind, true);
    input.setFloat64(BEGIN.TIME, change.time, true);
    input.setUint32(BEGIN.FLAGS, (change.callerValues ? BEGIN.HAS_CALLER_VALUES : 0) | (rowsOwned ? BEGIN.ROWS_OWNED : 0), true);
    input.setUint32(BEGIN.TARGET_COUNT, change.reversalTarget.length, true);
    for (let index = 0; index < change.reversalTarget.length; index++) {
      input.setFloat64(BEGIN.TARGET + index * F64, change.reversalTarget[index], true);
    }
    for (let index = 0; index < (change.callerValues?.length ?? 0); index++) {
      input.setFloat64(BEGIN.CALLER_VALUES + index * F64, change.callerValues[index], true);
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
    const baseTarget = canonicalAnimationValue(property, timing.baseTarget ?? target);
    const baseValues = property.kind === ANIMATION_KIND_TRANSFORM ? transformAffineValues(baseTarget) : baseTarget.values;
    const change = {
      time: finite(timing.startTime ?? 0, "transition start time"),
      callerValues: callerStart ? canonicalAnimationValue(property, timing.startValue).values : null,
      reversalTarget: property.kind === ANIMATION_KIND_TRANSFORM ? baseValues : canonicalAnimationValue(property, target).values,
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
      duration: view.getFloat64(trackAddress(trackIndex) + ANIMATION_RECORD_DURATION, true),
      // The value the track starts from: the caller's before-change value,
      // or the value the engine took at the change's time.
      start: change.start ?? timing.startValue,
      // The identity the track's events carry.
      animationId: animationTrackAnimationId(trackTable, trackIndex),
    });
  }


  // The transitions a style change starts on one node
  // (animation_transition_plan, engine-animation-transitions.watpart):
  // the before-change and after-change records, the last layout's box, the
  // CSS transform list both serializations carry, and the node's
  // transition definitions. A name the core does not animate starts no
  // transition, as in a browser, and is listed in `unanimated`. So is a
  // property whose effect computed resolution applies (font-size) on a
  // ::before or ::after (`change.pseudoElement`): that resolution applies
  // effects to elements only. The transitions are declared in
  // property-name order, their composite order, so their tracks and
  // events follow it (animation_transition_name_order).
  function planTransitions(change) {
    const listed = [];
    const unanimated = [];
    for (const definition of change.definitions) {
      const propertyNames = animationTransitionProperties(definition.propertyName);
      if (propertyNames.length === 0) unanimated.push(definition.propertyName);
      for (const propertyName of propertyNames) {
        const property = propertyNamed(propertyName);
        if (!property) {
          throw new TypeError(`The core expands transition-property ${definition.propertyName} to ${propertyName}, which it does not know`);
        }
        if (change.pseudoElement && isAnimationDependency(property.id)) {
          unanimated.push(propertyName);
          continue;
        }
        listed.push({ property, propertyName, definition });
      }
    }
    const definitions = animationTransitionNameOrder(listed.map((entry) => entry.propertyName))
      .map((index) => listed[index]);
    const carriesTransform = change.previousTransform !== undefined && change.nextTransform !== undefined;
    const previousComponents = carriesTransform ? change.previousTransform.components : [];
    const nextComponents = carriesTransform ? change.nextTransform.components : [];
    for (const entry of definitions) {
      entry.duration = animationNumber(entry.definition.duration, `The ${entry.propertyName} transition duration`);
      entry.delay = animationNumber(entry.definition.delay, `The ${entry.propertyName} transition delay`);
    }
    const linear = normalizeEasing("linear");
    const byteLength = PLAN.INPUT_SIZE + change.previousRecord.byteLength + change.nextRecord.byteLength +
      (previousComponents.length + nextComponents.length) * COMPONENT.SIZE + definitions.length * PLAN_DEFINITION.SIZE;
    const { pointer, input } = engineInput(byteLength);
    const bytes = new Uint8Array(engine.memory.buffer, pointer, byteLength);
    bytes.fill(0, 0, PLAN.INPUT_SIZE);
    let cursor = PLAN.INPUT_SIZE;
    const place = (source) => {
      bytes.set(source, cursor);
      const at = pointer + cursor;
      cursor += source.byteLength;
      return at;
    };
    input.setUint32(PLAN.PREVIOUS, place(change.previousRecord), true);
    input.setUint32(PLAN.PREVIOUS_LENGTH, change.previousRecord.byteLength, true);
    input.setUint32(PLAN.NEXT, place(change.nextRecord), true);
    input.setUint32(PLAN.NEXT_LENGTH, change.nextRecord.byteLength, true);
    input.setFloat32(PLAN.BOX_WIDTH, change.box?.w ?? 0, true);
    input.setFloat32(PLAN.BOX_HEIGHT, change.box?.h ?? 0, true);
    input.setUint32(PLAN.CARRIES_TRANSFORM, carriesTransform ? 1 : 0, true);
    const placeComponents = (components) => {
      const at = pointer + cursor;
      for (const component of components) {
        writeComponent(input, cursor, component);
        cursor += COMPONENT.SIZE;
      }
      return at;
    };
    input.setUint32(PLAN.PREVIOUS_COMPONENT_COUNT, previousComponents.length, true);
    input.setUint32(PLAN.PREVIOUS_COMPONENTS, placeComponents(previousComponents), true);
    input.setUint32(PLAN.NEXT_COMPONENT_COUNT, nextComponents.length, true);
    input.setUint32(PLAN.NEXT_COMPONENTS, placeComponents(nextComponents), true);
    input.setUint32(PLAN.DEFINITION_COUNT, definitions.length, true);
    input.setUint32(PLAN.DEFINITIONS, pointer + cursor, true);
    for (const { property, duration, delay } of definitions) {
      input.setUint32(cursor + PLAN_DEFINITION.PROPERTY, property.id, true);
      input.setFloat64(cursor + PLAN_DEFINITION.DURATION, duration, true);
      input.setFloat64(cursor + PLAN_DEFINITION.DELAY, delay, true);
      cursor += PLAN_DEFINITION.SIZE;
    }
    const count = engine.exports.animation_transition_plan(pointer);
    if (count === -1) {
      throw new RangeError(`A style change starts more than 64 transitions on one element (${definitions.length} definitions)`);
    }
    const output = engine.exports.animation_transition_plan_output();
    const plan = new DataView(engine.memory.buffer);
    const frameAt = (at) => {
      const values = Array.from({ length: 6 }, (_, index) => plan.getFloat64(at + PLAN_FRAME.VALUES + index * F64, true));
      const componentCount = plan.getUint32(at + PLAN_FRAME.COMPONENT_COUNT, true);
      const componentAt = plan.getUint32(at + PLAN_FRAME.COMPONENTS, true);
      const components = Array.from({ length: componentCount }, (_, index) => ({
        kind: plan.getUint32(componentAt + index * COMPONENT.SIZE + COMPONENT.KIND, true),
        parameters: Array.from({ length: 6 }, (_, parameter) =>
          plan.getFloat32(componentAt + index * COMPONENT.SIZE + COMPONENT.PARAMETERS + parameter * F32, true)),
      }));
      return { values, components };
    };
    // Every plan entry is read before the values are composed: the core
    // calls may grow the engine's memory and detach `plan`.
    const entries = [];
    for (let index = 0; index < count; index++) {
      const entry = output + index * PLAN_ENTRY.SIZE;
      const planned = definitions[plan.getUint32(entry + PLAN_ENTRY.DEFINITION, true)];
      entries.push({
        ...planned,
        start: frameAt(entry + PLAN_ENTRY.START),
        end: frameAt(entry + PLAN_ENTRY.END),
        tag: plan.getUint32(entry + PLAN_ENTRY.TAG, true),
        baseValues: Array.from({ length: 6 }, (_, value) => plan.getFloat32(entry + PLAN_ENTRY.BASE + value * F32, true)),
        reversalTarget: Array.from({ length: plan.getUint32(entry + PLAN_ENTRY.TARGET_COUNT, true) }, (_, value) =>
          plan.getFloat64(entry + PLAN_ENTRY.TARGET + value * F64, true)),
      });
    }
    const transitions = entries.map(({ property, propertyName, definition, start, end, tag, baseValues, reversalTarget }) => {
      // A transform frame's functions take their names after the before- or
      // after-change transform list.
      const startValue = composeAnimationValue(property, { tag, ...start }, change.previousTransform ?? null);
      const endValue = composeAnimationValue(property, { tag, ...end }, change.nextTransform ?? null);
      return {
        propertyName,
        definition,
        frames: [
          { offset: 0, easing: linear, value: startValue },
          { offset: 1, easing: linear, value: endValue },
        ],
        startValue,
        endValue,
        base: { tag, values: baseValues },
        reversalTarget,
      };
    });
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
      duration: view.getFloat64(trackAddress(trackIndex) + ANIMATION_RECORD_DURATION, true),
      start: change.start ?? planned.startValue,
      animationId: animationTrackAnimationId(trackTable, trackIndex),
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
    const identities = new Map(trackIndices.map((slot) => [slot, animationTrackIdentity(trackTable, slot)]));
    // Whether this controller still holds the track this handle declared,
    // and not a later track in its reused slot.
    const holds = (trackIndex) => animationTrackIdentity(trackTable, trackIndex) === identities.get(trackIndex);
    return Object.freeze({
      trackIndices: [...trackIndices],
      cancel() {
        for (const identity of identities.values()) forgetComputedSample(identity);
        let writeCount = 0;
        for (const trackIndex of trackIndices) {
          if (!holds(trackIndex)) continue;
          acquire();
          writeCount += cancelTrack(trackIndex);
        }
        return writeCount;
      },
      cancelSilently() {
        for (const identity of identities.values()) forgetComputedSample(identity);
        suppressEvents = true;
        try {
          let writeCount = 0;
          for (const trackIndex of trackIndices) {
            if (!holds(trackIndex)) continue;
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
          if (!holds(trackIndex)) continue;
          acquire();
          engine.exports.pause_animation(
            trackIndex,
            finite(time, "pause time"),
          );
        }
      },
      resume(time) {
        for (const trackIndex of trackIndices) {
          if (!holds(trackIndex)) continue;
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
          if (!holds(trackIndex)) continue;
          acquire();
          engine.exports.seek_animation(trackIndex, resolvedLocalTime, resolvedSampleTime);
        }
      },
      // The computed samples of the handle's tracks at `time`, each with
      // the effects of its stack composed (animation_track_stack_row): a
      // control call that declared, paused, resumed or seeked the tracks
      // between frames changes the computed style at once, as a frame
      // would. The table, the rows and the events stay as they are.
      captureSamples(time) {
        if (!computedSamples) return;
        const { core, owner, targets } = computedSamples;
        const resolvedTime = finite(time, "animation sample time");
        for (const trackIndex of trackIndices) {
          if (!holds(trackIndex)) continue;
          const address = trackAddress(trackIndex);
          const index = view.getUint16(address + RECORD.NODE, true);
          const target = sampledTarget(targets[index], core);
          if (target === null) continue;
          const property = propertyWithId(view.getUint16(address + RECORD.PROPERTY, true));
          acquire();
          const row = engine.exports.animation_track_stack_row(trackIndex, resolvedTime, ownsRows() ? 1 : 0);
          if (row === 0) continue;
          core.captureComputedSample(engine, owner, identities.get(trackIndex),
            target.handle, target.pseudo, index, trackAddress(trackIndex), property, resolvedTime, row);
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
    for (const trackIndex of animationTrackSlots(trackTable)) {
      const nextNodeIndex = indexMap.get(view.getUint16(trackAddress(trackIndex) + RECORD.NODE, true));
      if (nextNodeIndex !== undefined) requireRecordNodeIndex(nextNodeIndex);
    }
    computedSamples?.core.remapComputedSamples(computedSamples.owner, indexMap);
    acquire();
    const { pointer, input } = engineInput(Math.max(REMAP.SIZE, indexMap.size * REMAP.SIZE));
    let offset = 0;
    for (const [previousNodeIndex, nextNodeIndex] of indexMap) {
      input.setUint32(offset + REMAP.PREVIOUS, previousNodeIndex, true);
      input.setUint32(offset + REMAP.NEXT, nextNodeIndex, true);
      offset += REMAP.SIZE;
    }
    const writeCount = engine.exports.animation_owner_remap(owner, pointer, indexMap.size, ownsRows());
    settle(false);
    return writeCount;
  }

  function tick(time) {
    acquire();
    sampleTime = time;
    const resultAddress = engine.exports.tick(finite(time, "tick time"));
    const result = {
      writeCount: view.getUint32(resultAddress + RESULT.WRITES, true),
      transformSampleCount: view.getUint32(resultAddress + RESULT.TRANSFORM_SAMPLES, true),
      liveTrackCount: view.getUint32(resultAddress + RESULT.LIVE_TRACKS, true),
      eventCount: view.getUint32(resultAddress + RESULT.EVENTS, true),
    };
    captureComputedSamples();
    settle(true);
    return result;
  }
  // Samples this controller's tracks onto its rows, which the caller has
  // just written to the engine, at `time`: by default the time of the last
  // tick. The layout that follows reads the table and the bases, so both
  // are prepared even when there is nothing to sample.
  function resample(time = sampleTime) {
    prepareLayout();
    if (time !== null && animationTrackCount(trackTable) !== 0) return tick(time);
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
    if (animationTrackIdentity(trackTable, trackIndex) === 0n) {
      throw new RangeError(`Track ${trackIndex} is not a track of this controller`);
    }
    acquire();
    const address = trackAddress(trackIndex);
    const propertyId = view.getUint16(address + RECORD.PROPERTY, true);
    const property = propertyWithId(propertyId);
    const pointer = engine.exports.animation_stack_sample_through(
      trackIndex, finite(time, "sample time"), ownsRows() ? 1 : 0);
    if (pointer === 0) {
      throw new Error(`Track ${trackIndex} has no laid-out row to sample: render its renderer first`);
    }
    return { propertyName: animationPropertyName(propertyId), value: startValueAt(property, pointer) };
  }

  // Ends the controller: its view stops following the engine's memory, and
  // its track table is released. The owner cancels the tracks it still
  // holds first (cancelAll).
  function dispose() {
    removeViewRefresh();
    releaseAnimationTrackTable(trackTable);
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
    get revision() {
      return revision;
    },
  });
}
