import { elementTransform, serializeToScene } from "./serialize.js";
import { SandomHostError } from "../host/contract.js";
import { validateClosedRecord } from "../closed-record.js";
import { microtaskCheckpoint } from "./microtask-checkpoint.js";
import { hostClearTimeout, hostNow, hostSetTimeout, hostTimeOrigin } from "../host-clock.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { createFrameComparisonSession } from "../gpu-frame-comparison.js";
import { readDocumentOutline } from "./document-outline.js";
import { findNext, findText, setErrorRanges, setTargetText } from "./highlights.js";
import { assertClockOptions, DocumentClock, documentTimeline, realClockSource } from "./document-clock.js";
import {
  openSceneRenderer,
  engineCounters,
  hostGraphicsDevice,
  layoutTreeBoxes,
} from "../scene-renderer.js";
import {
  deliverRenderingObservers,
  documentHasRenderingObservers,
  observerLayout,
} from "./rendering-observers.js";
import {
  animationsForElement,
  createDOMAnimation,
  cssAnimationTiming,
  CSSAnimation,
  CSSTransition,
  removeReplacedAnimations,
  takePendingAnimations,
} from "./animation.js";
import { isPseudoElementTarget, pseudoElementTarget } from "./pseudo-element-target.js";
import { sendSpellcheckRequests } from "./spellcheck.js";
import { sendPickerRequest } from "./host-picker.js";
import { createEvent, createEventUsing, dispatchEvent, SDAnimationPlaybackEvent } from "./events.js";
import { scheduleFocusFixup } from "./input-activation.js";
import { computeLayoutBoxes } from "./live-geometry.js";
import { SandomViewport } from "./viewport.js";
import { snapshotScrollbars } from "./scrollbars.js";
import { paintScrollbars } from "./scrollbar-paint.js";
import { assertScrollbarStyle, ScrollbarVisibility } from "./scrollbar-visibility.js";
import { sampleScrollTimeline } from "./scroll-timeline.js";
import { pageBox, pageCounters, pageMarginBoxes, parsePageRules, releasePageRules } from "./page-rules.js";
import { pageOfPoint, pointOfPage } from "./page-stack.js";
import {
  NativeScrollCapture,
  NativeScrollCollection,
  SCROLL_COLLECTION,
  SCROLL_SUPPRESS,
  NativeScrollMotions,
  NativeScrollSuppression,
  scrollCore,
  elementScrollRead,
  scrollRead,
  scrollRequest,
  scrollState,
  withScrollGeometry,
} from "./scroll-core.js";
import {
  BOX_SNAPSHOT,
  boxesEqual,
  boxesReadOnly,
  freezeBoxes,
  releaseBoxSnapshot,
} from "../dom-wasm/geometry-wire.js";
import { buildInteractionSnapshot, deriveRestyleBasis } from "./presented-frame.js";
import { buildGeometryFrameSuccessor, selectionRectangles } from "./geometry.js";
import { recordUnanimatedProperty } from "./style.js";
import {
  cssAnimationSlots,
  CSS_PLAN_KEEP,
  CSS_PLAN_UPDATE,
  AnimationValue,
  deferAnimationBinding,
  animationFillMode,
  keyframeMember,
  KEYFRAME_MEMBER,
  keyframePropertyNames,
  placeCSSAnimation,
  planCSSAnimations,
  reconcileAnimationDefinitions,
  contentAnimationFrameStart,
  contentAnimationTimes,
  stackedAnimationContent,
  setAnimationDependencyTime,
  transitionCoversAnimationDependency,
} from "../dom-wasm/animation.js";
import { normalizeOffsets } from "../animations.js";
import * as motionCaptureBinary from "../wasm/motion-capture-binary.js";
import { createFrameBindings } from "./dom-bindings.generated.js";
import { layoutConstant, moduleLayoutConstants } from "../wasm/layout-table.js";
import { nodeMember } from "./node-members.js";

const instantiateMotionCapture = motionCaptureBinary.instantiate;
const motionCaptureConstant = moduleLayoutConstants(motionCaptureBinary, "motion capture");

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const ANIMATION_RENDERED_CHANGE_CHANGES = layoutConstant("ANIMATION_RENDERED_CHANGE_CHANGES");
const ANIMATION_RENDERED_CHANGE_UNKNOWN = layoutConstant("ANIMATION_RENDERED_CHANGE_UNKNOWN");
const ANIMATION_VALUE_CURRENT_TIME = layoutConstant("ANIMATION_VALUE_CURRENT_TIME");
const ANIMATION_VALUE_TRACK_GENERATION = layoutConstant("ANIMATION_VALUE_TRACK_GENERATION");
const ANIMATION_VALUE_ENGINE_START_TIME = layoutConstant("ANIMATION_VALUE_ENGINE_START_TIME");
const ANIMATION_VALUE_DURATION = layoutConstant("ANIMATION_VALUE_DURATION");
const ANIMATION_VALUE_DELAY = layoutConstant("ANIMATION_VALUE_DELAY");
const ANIMATION_VALUE_REVERSED = layoutConstant("ANIMATION_VALUE_REVERSED");
const FRAME_ROOT_NULL = layoutConstant("FRAME_ROOT_NULL");
const FRAME_ROOT_UNDEFINED = layoutConstant("FRAME_ROOT_UNDEFINED");
const FRAME_ROOT_PRIMITIVE = layoutConstant("FRAME_ROOT_PRIMITIVE");
const FRAME_ROOT_OBJECT = layoutConstant("FRAME_ROOT_OBJECT");
const FRAME_ROOT_NODE = layoutConstant("FRAME_ROOT_NODE");
const FRAME_ROOT_DOCUMENT_ELEMENT = layoutConstant("FRAME_ROOT_DOCUMENT_ELEMENT");
const FRAME_BOX_X = layoutConstant("FRAME_BOX_X");
const FRAME_BOX_Y = layoutConstant("FRAME_BOX_Y");
const FRAME_BOX_WIDTH = layoutConstant("FRAME_BOX_WIDTH");
const FRAME_BOX_HEIGHT = layoutConstant("FRAME_BOX_HEIGHT");
const FRAME_OUTCOME_DONE = layoutConstant("FRAME_OUTCOME_DONE");
const FRAME_FACT_GEOMETRY_CHANGED = layoutConstant("FRAME_FACT_GEOMETRY_CHANGED");
const FRAME_FACT_OBSERVER_MUTATION = layoutConstant("FRAME_FACT_OBSERVER_MUTATION");
const FRAME_FACT_RESIZE_SKIPPED = layoutConstant("FRAME_FACT_RESIZE_SKIPPED");
const FRAME_FACT_PREPARATION_CHANGED = layoutConstant("FRAME_FACT_PREPARATION_CHANGED");
const SCROLL_MOTION_MOMENTUM = layoutConstant("SCROLL_MOTION_MOMENTUM");
const SCROLL_MOTION_INTERACTION = layoutConstant("SCROLL_MOTION_INTERACTION");
const SCROLL_SMOOTH_PENDING = layoutConstant("SCROLL_SMOOTH_PENDING");
const GEOMETRY_SCROLL_MIN_LEFT = layoutConstant("GEOMETRY_SCROLL_MIN_LEFT");
const GEOMETRY_SCROLL_MAX_LEFT = layoutConstant("GEOMETRY_SCROLL_MAX_LEFT");
const GEOMETRY_SCROLL_MIN_TOP = layoutConstant("GEOMETRY_SCROLL_MIN_TOP");
const GEOMETRY_SCROLL_MAX_TOP = layoutConstant("GEOMETRY_SCROLL_MAX_TOP");
const SCROLL_SCROLLED_DIRECTION = layoutConstant("SCROLL_SCROLLED_DIRECTION");
const CONTAINER_SCROLLABLE_LEFT = layoutConstant("CONTAINER_SCROLLABLE_LEFT");
const CONTAINER_STUCK_LEFT = layoutConstant("CONTAINER_STUCK_LEFT");
const CONTAINER_SNAPPED_X = layoutConstant("CONTAINER_SNAPPED_X");
const CONTAINER_SNAPPED_Y = layoutConstant("CONTAINER_SNAPPED_Y");
const CONTAINER_SCROLLED_LEFT = layoutConstant("CONTAINER_SCROLLED_LEFT");
const GEOMETRY_SCROLL_WIDTH = layoutConstant("GEOMETRY_SCROLL_WIDTH");
const GEOMETRY_SCROLL_HEIGHT = layoutConstant("GEOMETRY_SCROLL_HEIGHT");
const SCENE_BOX_TEXT = layoutConstant("SCENE_BOX_TEXT");
const SYNC_LAYOUT_OFFER = layoutConstant("SYNC_LAYOUT_OFFER");
const SYNC_LAYOUT_PEEK = layoutConstant("SYNC_LAYOUT_PEEK");
const SYNC_LAYOUT_TAKE = layoutConstant("SYNC_LAYOUT_TAKE");
// The restyle counters a frame reports, in the order of its counts.
const FRAME_RESTYLE_COUNTS = Object.freeze(["RESTYLE_COUNT_ELEMENTS", "RESTYLE_COUNT_PSEUDO_ELEMENTS",
  "RESTYLE_COUNT_PUBLICATION_ROWS", "RESTYLE_COUNT_SCENE_ELEMENTS", "RESTYLE_COUNT_SCENE_BOXES",
  "RESTYLE_COUNT_ELEMENTS_UNCHANGED", "RESTYLE_COUNT_SCENE_SUBTREES_REPLAYED"].map((name) => layoutConstant(name)));
const SCROLL_INPUT_EFFECT_SNAP_CHECK = layoutConstant("SCROLL_INPUT_EFFECT_SNAP_CHECK");
const SCROLL_INPUT_EFFECT_DIRTY = layoutConstant("SCROLL_INPUT_EFFECT_DIRTY");
const SCROLL_INPUT_EFFECT_SCHEDULE = layoutConstant("SCROLL_INPUT_EFFECT_SCHEDULE");
const FRAME_CARET_ACTIVE = layoutConstant("FRAME_CARET_ACTIVE");
const FRAME_CARET_PHASE_CHANGED = layoutConstant("FRAME_CARET_PHASE_CHANGED");
const FRAME_LOOP_GATES = layoutConstant("FRAME_LOOP_GATES");
const FRAME_LOOP_WORK = layoutConstant("FRAME_LOOP_WORK");
const FRAME_GATE_TRANSACTION = layoutConstant("FRAME_GATE_TRANSACTION");
const FRAME_GATE_STOPPED = layoutConstant("FRAME_GATE_STOPPED");
const FRAME_GATE_SHUTDOWN = layoutConstant("FRAME_GATE_SHUTDOWN");
const FRAME_GATE_RENDERING = layoutConstant("FRAME_GATE_RENDERING");
const FRAME_GATE_CLOCK_ADVANCING = layoutConstant("FRAME_GATE_CLOCK_ADVANCING");
const FRAME_GATE_REQUESTED = layoutConstant("FRAME_GATE_REQUESTED");
const FRAME_WORK_ANIMATION_FRAME = layoutConstant("FRAME_WORK_ANIMATION_FRAME");
const FRAME_WORK_DIRTY = layoutConstant("FRAME_WORK_DIRTY");
const FRAME_WORK_CARET = layoutConstant("FRAME_WORK_CARET");
const FRAME_WORK_SCROLLBAR = layoutConstant("FRAME_WORK_SCROLLBAR");
const FRAME_WORK_SCROLL_END = layoutConstant("FRAME_WORK_SCROLL_END");
const FRAME_WORK_SNAP_CHECK = layoutConstant("FRAME_WORK_SNAP_CHECK");
const FRAME_WORK_SCROLL_INTERACTION = layoutConstant("FRAME_WORK_SCROLL_INTERACTION");
const FRAME_WORK_TIMERS = layoutConstant("FRAME_WORK_TIMERS");
const FRAME_WORK_FOLLOW = layoutConstant("FRAME_WORK_FOLLOW");
const FRAME_CLOCK_FRAMES_NOW = layoutConstant("FRAME_CLOCK_FRAMES_NOW");
const FRAME_CLOCK_TIMERS_AWAIT_FRAME = layoutConstant("FRAME_CLOCK_TIMERS_AWAIT_FRAME");
const FRAME_RETAINED_CLEAN_SCENE_REUSE = layoutConstant("FRAME_RETAINED_CLEAN_SCENE_REUSE");
const FRAME_RETAINED_PIXEL_READBACK = layoutConstant("FRAME_RETAINED_PIXEL_READBACK");
const FRAME_RETAINED_CURRENT_PAGE = layoutConstant("FRAME_RETAINED_CURRENT_PAGE");
const FRAME_RETAINED_PAGE_TARGET_STALE = layoutConstant("FRAME_RETAINED_PAGE_TARGET_STALE");
const FRAME_RETAINED_CURRENT_TOOL_HIGHLIGHTS = layoutConstant("FRAME_RETAINED_CURRENT_TOOL_HIGHLIGHTS");
const FRAME_RETAINED_NO_TRANSACTION = layoutConstant("FRAME_RETAINED_NO_TRANSACTION");
const FRAME_RETAINED_RENDERED = layoutConstant("FRAME_RETAINED_RENDERED");
const FRAME_RETAINED_PRESENTED = layoutConstant("FRAME_RETAINED_PRESENTED");
const FRAME_RETAINED_DELIVERED = layoutConstant("FRAME_RETAINED_DELIVERED");
const FRAME_RETAINED_UNCHANGED_INPUTS = layoutConstant("FRAME_RETAINED_UNCHANGED_INPUTS");
const FRAME_RETAINED_ANIMATION_WORK = layoutConstant("FRAME_RETAINED_ANIMATION_WORK");
const FRAME_RETAINED_MOMENTUM = layoutConstant("FRAME_RETAINED_MOMENTUM");
const FRAME_RETAINED_RESULT_ANIMATES = layoutConstant("FRAME_RETAINED_RESULT_ANIMATES");
const FRAME_RETAINED_NO_PENDING_DECLARATIONS = layoutConstant("FRAME_RETAINED_NO_PENDING_DECLARATIONS");
const FRAME_RETAINED_RESULT_ARTIFACT = layoutConstant("FRAME_RETAINED_RESULT_ARTIFACT");
const FRAME_RETAINED_WANTS_ARTIFACT = layoutConstant("FRAME_RETAINED_WANTS_ARTIFACT");
const FRAME_RETAINED_RESULT_PIXELS = layoutConstant("FRAME_RETAINED_RESULT_PIXELS");
const FRAME_RETAINED_WEBGL2 = layoutConstant("FRAME_RETAINED_WEBGL2");
const FRAME_CAPTURE_SURFACE = layoutConstant("FRAME_CAPTURE_SURFACE");
const FRAME_CAPTURE_MOTION = layoutConstant("FRAME_CAPTURE_MOTION");
const FRAME_CAPTURE_SCHEDULE = layoutConstant("FRAME_CAPTURE_SCHEDULE");
const MOTION_SCHEDULE_PREPARE = layoutConstant("MOTION_SCHEDULE_PREPARE");
const MOTION_SCHEDULE_EFFECT = layoutConstant("MOTION_SCHEDULE_EFFECT");
const MOTION_SCHEDULE_KEYFRAME = layoutConstant("MOTION_SCHEDULE_KEYFRAME");
// The text geometry capture and store of geometry-text-capture.watpart and
// geometry-text-store.watpart, by WAT name.
const TEXT_CAPTURE_OPERATION_COUNT = layoutConstant("TEXT_CAPTURE_OPERATION_COUNT");
const TEXT_STORE = Object.freeze(Object.fromEntries(["COUNT", "ENTRIES", "ENTRY_SIZE", "ENTRY_OWNER", "ENTRY_KIND",
  "KIND_CONTROL"].map((name) => [name, layoutConstant(`TEXT_STORE_${name}`)])));

// A page of a page frame as surface.page describes it.
function describePage({ index, name, side, blank, groups, box }) {
  return {
    index,
    name,
    side,
    blank,
    groups: Object.freeze(groups.map((group) => Object.freeze({ ...group }))),
    width: box.width,
    height: box.height,
    margin: Object.freeze({ ...box.margin }),
    area: Object.freeze({ ...box.area }),
  };
}

// The stage counter of each reason a restyled frame's geometry was built
// instead of derived from the presented frame's (presented-frame.js).
const restyleRefusalCounters = Object.freeze({
  viewport: "geometryRestyleRefusedViewport",
  text: "geometryRestyleRefusedText",
  tree: "geometryRestyleRefusedTree",
  rows: "geometryRestyleRefusedRows",
  fragments: "geometryRestyleRefusedFragments",
});

// The inspection keywords of the motion capture codes.
const MOTION_CLASSIFICATIONS = new Map(["STATIC", "FINITE", "UNBOUNDED", "EXTERNAL"]
  .map((name) => [motionCaptureConstant(`MOTION_${name}`), name.toLowerCase()]));
// A motion value: a canonical animation value reports its CSS text.
function freezeMotionValue(value) {
  if (value instanceof AnimationValue) return value.text;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeMotionValue(entry)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          freezeMotionValue(entry),
        ]),
      ),
    );
  }
  return value;
}

// The mutation kinds of the surface (frame_surface_mutation) and the
// effects the core answers.
const FRAME_MUTATION_KINDS = new Map([
  ["structure", "STRUCTURE"], ["attribute", "ATTRIBUTE"], ["class", "CLASS"], ["text", "TEXT"], ["state", "STATE"],
  ["property", "PROPERTY"], ["selection", "SELECTION"], ["style", "STYLE"], ["canvas-paint", "CANVAS_PAINT"],
  ["canvas-size", "CANVAS_SIZE"], ["font", "FONT"], ["stylesheet", "STYLESHEET"],
].map(([kind, name]) => [kind, layoutConstant(`FRAME_MUTATION_${name}`)]));
const FRAME_MUTATION_EFFECT = Object.freeze(Object.fromEntries(["MARK_NODE", "TRANSFORM_ONLY", "NOT_TRANSFORM",
  "NOT_RESTYLE_STATE", "SELECTION", "DELIVER_STATE", "FORCE_GENERATION", "FULL_INVALIDATION", "SNAP_CHECK",
  "SCROLL_SUPPRESS"].map((name) => [name, layoutConstant(`FRAME_MUTATION_EFFECT_${name}`)])));

// The frameStageCounters counter of each frame_restyle_retained refusal.
const ENGINE_RESTYLE_DONE = layoutConstant("ENGINE_RESTYLE_DONE");
const SCENE_RESTYLE_REFUSALS = new Map([
  ["MUTATION", "sceneRestyleRefusedMutation"],
  ["VIEWPORT", "sceneRestyleRefusedViewport"],
  ["BUILD", "sceneRestyleRefusedBuild"],
  ["LIST", "sceneRestyleRefusedList"],
  ["GENERATION", "sceneRestyleRefusedGeneration"],
  ["OVERFLOW", "sceneRestyleRefusedOverflow"],
  ["ROOT", "sceneRestyleRefusedRoot"],
  ["CONTENTS", "sceneRestyleRefusedContents"],
  ["STRUCTURE", "sceneRestyleRefusedStructure"],
].map(([name, counter]) => [layoutConstant(`ENGINE_RESTYLE_REFUSED_${name}`), counter]));
const FRAME_MODE = Object.freeze(Object.fromEntries(["FULL", "PURE_SCROLL", "TRANSFORM", "CLEAN", "RESTYLE"]
  .map((name) => [name, layoutConstant(`FRAME_MODE_${name}`)])));
const FRAME_DAMAGE_FULL = layoutConstant("FRAME_DAMAGE_FULL");
const FRAME_STAGE = Object.freeze(Object.fromEntries(["PREPARE", "SCENE", "LAYOUT", "SCROLL_ANCHORING",
  "SCROLL_TIMELINES", "OBSERVERS", "DAMAGE", "RENDER", "OBSERVER_LIMIT"]
  .map((name) => [name, layoutConstant(`FRAME_STAGE_${name}`)])));
const FRAME_INVALIDATE_VIEWPORT = layoutConstant("FRAME_INVALIDATE_VIEWPORT");
const FRAME_DAMAGE_PURE_SCROLL = layoutConstant("FRAME_DAMAGE_PURE_SCROLL");
const FRAME_PAGE_REQUEST_FULL = layoutConstant("FRAME_PAGE_REQUEST_FULL");
const FRAME_LOOP_STOP = layoutConstant("FRAME_LOOP_STOP");
const ACTIVE_OWNER_SMOOTH = layoutConstant("SCROLL_ACTIVE_OWNER_SMOOTH");
const ACTIVE_OWNER_REQUEST = layoutConstant("SCROLL_ACTIVE_OWNER_REQUEST");
const FRAME_VISIBLE_RECTANGLE_SAME = layoutConstant("FRAME_VISIBLE_RECTANGLE_SAME");

// Each presented frame's reading of the engine's layout work
// (layout_compute_total) when its boxes were read; absent for a frame
// whose renderer reports none.
const presentedLayoutWork = new WeakMap();

function motionValueSignature(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => motionValueSignature(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((name) =>
        `${JSON.stringify(name)}:${motionValueSignature(value[name])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function normalizeMotionKeyframes(keyframes) {
  return Object.freeze(keyframes.map((keyframe) => {
    const values = Object.fromEntries(
      Object.entries(keyframe).filter(([name]) => keyframeMember(name) === KEYFRAME_MEMBER.PROPERTY)
        .map(([name, value]) => [name, freezeMotionValue(value)]),
    );
    return Object.freeze({
      offset: keyframe.offset,
      easing: keyframe.easing ?? null,
      composite: keyframe.composite ?? null,
      values: Object.freeze(values),
      valueSignatures: Object.freeze(
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            motionValueSignature(value),
          ]),
        ),
      ),
    });
  }));
}

// Whether keyframes change the rendered output: true, false, or null when
// a property has fewer than two values (animation_rendered_change).
function renderedChangeFromKeyframes(propertyNames, keyframes) {
  const values = [];
  for (const propertyName of propertyNames) {
    const signatures = keyframes.flatMap((keyframe) =>
      propertyName in keyframe.valueSignatures ? [keyframe.valueSignatures[propertyName]] : []
    );
    values.push(signatures.length, ...signatures);
  }
  const change = sharedDomCore.status("animation_rendered_change", ...sharedDomCore.valueListInput(values));
  return change === ANIMATION_RENDERED_CHANGE_UNKNOWN ? null : change === ANIMATION_RENDERED_CHANGE_CHANGES;
}

// The phase, membership and iteration of an effect at an inspection
// (motion_effect_phase); NaN reads are null.
const MOTION_PHASES = new Map(["BEFORE", "ACTIVE", "AFTER", "EXTERNAL"]
  .map((name) => [motionCaptureConstant(`MOTION_PHASE_${name}`), name.toLowerCase()]));
const MOTION_PHASE_VALUE = Object.freeze(Object.fromEntries(["MEMBERSHIP", "ITERATION_INDEX", "ITERATION_PROGRESS"]
  .map((name) => [name, motionCaptureConstant(`MOTION_PHASE_VALUE_${name}`)])));
function effectPhase(exports, external, activeTimeMilliseconds, durationMilliseconds, iterationCount, fill) {
  const phase = exports.motion_effect_phase(
    external ? 1 : 0,
    activeTimeMilliseconds,
    durationMilliseconds,
    iterationCount,
    animationFillMode(fill),
  );
  const iterationIndex = exports.motion_phase_value(MOTION_PHASE_VALUE.ITERATION_INDEX);
  const iterationProgress = exports.motion_phase_value(MOTION_PHASE_VALUE.ITERATION_PROGRESS);
  return {
    phase: MOTION_PHASES.get(phase),
    effectMembershipAtInspection: exports.motion_phase_value(MOTION_PHASE_VALUE.MEMBERSHIP) === 1,
    iterationIndex: Number.isNaN(iterationIndex) ? null : iterationIndex,
    iterationProgress: Number.isNaN(iterationProgress) ? null : iterationProgress,
  };
}

function createMotionModel(surface) {
  if (surface._preparedState === null) {
    throw new Error("inspectMotion() requires prepared render state");
  }
  const exports = instantiateMotionCapture({}).exports;
  exports.motion_reset();
  const effects = [];
  const scheduleEffects = [];

  for (const animation of surface._animations) {
    if (animation.playState === "idle" || animation.playState === "finished") {
      continue;
    }
    const timing = animation.effect.getComputedTiming();
    const keyframes = normalizeOffsets(animation._canonicalKeyframes);
    const propertyNames = [...new Set(keyframes.flatMap(keyframePropertyNames))];
    const normalizedKeyframes = normalizeMotionKeyframes(keyframes);
    const changesRenderedOutput = renderedChangeFromKeyframes(
      propertyNames,
      normalizedKeyframes,
    );
    const external = animation._isScrollDriven();
    const progressing = exports.motion_effect_progressing(
      animation.playState === "running" ? 1 : 0,
      animation.playbackRate,
      changesRenderedOutput === false ? 1 : 0,
    ) === 1;
    const startTimeMilliseconds = exports.motion_effect_start_time(
      animation.startTime == null ? 0 : 1,
      animation.startTime ?? 0,
      surface.currentTime,
      animation.currentTime ?? 0,
      animation.playbackRate,
    );
    const delayMilliseconds = Number(timing.delay ?? 0);
    const durationMilliseconds = Number(timing.duration ?? 0);
    const iterationCount = Number(timing.iterations ?? 1);
    const localTimeMilliseconds =
      (surface.currentTime - startTimeMilliseconds) * animation.playbackRate;
    const activeTimeMilliseconds = localTimeMilliseconds - delayMilliseconds;
    const fill = timing.fill ?? "none";
    const { phase, effectMembershipAtInspection, iterationIndex, iterationProgress } =
      effectPhase(exports, external, activeTimeMilliseconds, durationMilliseconds, iterationCount, fill);
    const effectIndex = exports.motion_add_effect(
      (progressing ? 1 : 0) | (external ? 2 : 0),
      startTimeMilliseconds,
      delayMilliseconds,
      durationMilliseconds,
      iterationCount,
      animation.playbackRate,
    );
    if (effectIndex < 0) {
      throw new Error(
        `Cannot inspect motion: WebAssembly error ${exports.motion_error()}`,
      );
    }
    const endTime = exports.motion_effect_end(effectIndex);
    const record = Object.freeze({
      kind: animation._cssAnimationName ? "css-animation" : "web-animation",
      element: animation._element,
      propertyNames: Object.freeze(propertyNames),
      animationName: animation._cssAnimationName ?? "",
      effectOrder: effects.length,
      startTimeMilliseconds,
      delayMilliseconds,
      durationMilliseconds,
      iterationCount,
      endTimeMilliseconds: Number.isFinite(endTime) ? endTime : null,
      keyframeOffsets: Object.freeze(
        keyframes.map((keyframe) => keyframe.offset),
      ),
      keyframes: normalizedKeyframes,
      direction: timing.direction ?? "normal",
      fill,
      easing: timing.easing ?? "linear",
      composite: timing.composite ?? "replace",
      playState: animation.playState,
      playbackRate: animation.playbackRate,
      timeline: external ? "external" : "time",
      phase,
      localTimeMilliseconds,
      activeTimeMilliseconds,
      iterationIndex,
      iterationProgress,
      effectMembershipAtInspection,
      changesRenderedOutput,
      changesUnderlyingState: false,
    });
    effects.push(record);
    scheduleEffects.push({
      effectIndex,
      progressing,
      external,
      keyframes,
      discrete: propertyNames.includes("visibility"),
    });
  }

  for (const pseudoElements of surface._pseudoContentAnimations.values()) {
    for (const records of pseudoElements.values()) {
      for (const record of records) {
        const { timing, keyframes } = record.definition;
        if (record.definition.paused) continue;
        const normalizedKeyframes = normalizeMotionKeyframes(keyframes);
        const changesRenderedOutput = renderedChangeFromKeyframes(
          ["content"],
          normalizedKeyframes,
        );
        const delayMilliseconds = Number(timing.delay ?? 0);
        const durationMilliseconds = Number(timing.duration ?? 0);
        const iterationCount = Number(timing.iterations ?? 1);
        const localTimeMilliseconds = surface.currentTime - record.startTimeMilliseconds;
        const activeTimeMilliseconds = localTimeMilliseconds - delayMilliseconds;
        const fill = timing.fill ?? "none";
        const { phase, effectMembershipAtInspection, iterationIndex, iterationProgress } =
          effectPhase(exports, false, activeTimeMilliseconds, durationMilliseconds, iterationCount, fill);
        const effectIndex = exports.motion_add_effect(
          changesRenderedOutput === false ? 0 : 1,
          record.startTimeMilliseconds,
          delayMilliseconds,
          durationMilliseconds,
          iterationCount,
          1,
        );
        if (effectIndex < 0) {
          throw new Error(
            `Cannot inspect generated content motion: WebAssembly error ${exports.motion_error()}`,
          );
        }
        const endTime = exports.motion_effect_end(effectIndex);
        effects.push(Object.freeze({
          kind: "css-animation",
          element: record.element,
          propertyNames: Object.freeze(["content"]),
          animationName: record.definition.name,
          effectOrder: effects.length,
          startTimeMilliseconds: record.startTimeMilliseconds,
          delayMilliseconds,
          durationMilliseconds,
          iterationCount,
          endTimeMilliseconds: Number.isFinite(endTime) ? endTime : null,
          keyframeOffsets: Object.freeze(
            keyframes.map((frame) => frame.offset),
          ),
          keyframes: normalizedKeyframes,
          direction: timing.direction ?? "normal",
          fill,
          easing: timing.easing ?? "linear",
          composite: timing.composite ?? "replace",
          playState: "running",
          playbackRate: 1,
          timeline: "time",
          pseudoElement: record.pseudoElement,
          phase,
          localTimeMilliseconds,
          activeTimeMilliseconds,
          iterationIndex,
          iterationProgress,
          effectMembershipAtInspection,
          changesRenderedOutput,
          changesUnderlyingState: false,
        }));
        scheduleEffects.push({
          effectIndex,
          progressing: changesRenderedOutput !== false,
          external: false,
          keyframes,
          discrete: true,
        });
      }
    }
  }

  for (const timings of surface._transitionRecords.values()) {
    for (const [propertyName, timing] of timings) {
      // The track's timing at inspection: a paused transition's start
      // follows the clock, so its local time holds.
      const animation = timing.animation;
      const startTimeMilliseconds = animation._value(ANIMATION_VALUE_ENGINE_START_TIME);
      const delayMilliseconds = animation._value(ANIMATION_VALUE_DELAY);
      const durationMilliseconds = animation._value(ANIMATION_VALUE_DURATION);
      const progressing = animation._trackAdvances();
      const effectIndex = exports.motion_add_effect(
        progressing ? 1 : 0,
        startTimeMilliseconds,
        delayMilliseconds,
        durationMilliseconds,
        1,
        1,
      );
      if (effectIndex < 0) {
        throw new Error(
          `Cannot inspect motion: WebAssembly error ${exports.motion_error()}`,
        );
      }
      const endTime = exports.motion_effect_end(effectIndex);
      const localTimeMilliseconds = surface.currentTime - startTimeMilliseconds;
      const activeTimeMilliseconds = localTimeMilliseconds - delayMilliseconds;
      const { phase, effectMembershipAtInspection, iterationIndex, iterationProgress } =
        effectPhase(exports, false, activeTimeMilliseconds, durationMilliseconds, 1, "none");
      effects.push(Object.freeze({
        kind: "transition",
        element: timing.animation._element,
        propertyNames: Object.freeze([propertyName]),
        animationName: "",
        effectOrder: effects.length,
        startTimeMilliseconds,
        delayMilliseconds,
        durationMilliseconds,
        iterationCount: 1,
        endTimeMilliseconds: endTime,
        keyframeOffsets: Object.freeze([0, 1]),
        keyframes: normalizeMotionKeyframes([
          { offset: 0, [propertyName]: timing.startValue },
          { offset: 1, [propertyName]: timing.endValue },
        ]),
        direction: "normal",
        fill: "none",
        easing: timing.easing ?? "linear",
        composite: "replace",
        playState: animation.playState,
        playbackRate: animation.playbackRate,
        timeline: "time",
        pseudoElement: timing.animation._pseudoElement,
        phase,
        localTimeMilliseconds,
        activeTimeMilliseconds,
        iterationIndex,
        iterationProgress,
        effectMembershipAtInspection,
        changesRenderedOutput: true,
        changesUnderlyingState: true,
      }));
      scheduleEffects.push({
        effectIndex,
        progressing,
        external: false,
        keyframes: [{ offset: 0 }, { offset: 1 }],
        discrete: propertyName === "visibility",
      });
    }
  }

  const classification =
    MOTION_CLASSIFICATIONS.get(exports.motion_classification());
  const finiteDuration = exports.motion_finite_duration(surface.currentTime);
  const inspection = Object.freeze({
    classification,
    inspectedAtMilliseconds: surface.currentTime,
    finiteDurationMilliseconds: Number.isNaN(finiteDuration) ? null : finiteDuration,
    effects: Object.freeze(effects),
  });
  return { exports, inspection, scheduleEffects };
}
// The kind of a value offered as a surface root (frame_surface_root).
function rootKind(root) {
  if (root === null) return FRAME_ROOT_NULL;
  if (root === undefined) return FRAME_ROOT_UNDEFINED;
  if (typeof root !== "object") return FRAME_ROOT_PRIMITIVE;
  return root._domCore ? FRAME_ROOT_NODE : FRAME_ROOT_OBJECT;
}
// The document whose stylesheets style a surface root: the root itself for a
// document, else its owner document, whether or not the root is attached.
function surfaceDocument(root) {
  const document = nodeMember(root, "nodeType") === 9 ? root : nodeMember(root, "ownerDocument");
  if (!document) {
    throw new Error(`render surface: root <${nodeMember(root, "nodeName")}> has no owner document, so no stylesheet can reach it`);
  }
  return document;
}

// A surface renders one element's box tree. A document is the root a host
// rendering a whole page has, so it resolves to its document element — which
// is also what makes a host-owned top element unnecessary. Anything else is
// refused here, by type (frame_surface_root), rather than by a statistic
// from the first frame's animation-candidate scan.
function resolveSurfaceRoot(root, operation) {
  const kind = rootKind(root);
  const resolved = sharedDomCore.statusRaw(
    "frame_surface_root",
    kind,
    kind === FRAME_ROOT_NODE ? nodeMember(root, "nodeType") : 0,
    kind === FRAME_ROOT_NODE && nodeMember(root, "nodeType") === 9 && root.documentElement ? 1 : 0,
    ...sharedDomCore.valueListInput([operation, typeof root]),
  );
  return resolved === FRAME_ROOT_DOCUMENT_ELEMENT ? root.documentElement : root;
}

// A broken image paints nothing, as in Chrome. The document keeps one
// recoverable diagnostic for each URL, owner and property; a prepared
// document gives it to the host with its font diagnostics.
const GENERATED_BOX_PSEUDO_ELEMENTS = {
  [layoutConstant("SCENE_BOX_BEFORE")]: "::before",
  [layoutConstant("SCENE_BOX_AFTER")]: "::after",
  [layoutConstant("SCENE_BOX_FIRST_LETTER")]: "::first-letter",
};
function recordBrokenImageDiagnostic(element, node, property, requestedURL, failure, error) {
  const document = nodeMember(element, "ownerDocument");
  const pseudoElement = GENERATED_BOX_PSEUDO_ELEMENTS[node._coreBox & 0xff] ?? "";
  const id = nodeMember(element, "id");
  const ownerElement = `${nodeMember(element, "localName")}${id ? `#${id}` : ""}${pseudoElement}`;
  const requestedFinalURL = URL.parse(requestedURL, document.baseURI)?.href ?? requestedURL;
  const key = `${requestedFinalURL} ${ownerElement} ${property}`;
  if (document._brokenImageDiagnostics.has(key)) return;
  const cause = error.cause ?? error;
  const causeMessage = cause?.message ?? String(cause);
  document._brokenImageDiagnostics.set(key, Object.freeze({
    code: "image-resource-broken",
    severity: "warning",
    recoverable: true,
    message: `Image ${requestedFinalURL} for ${property} of ${ownerElement} failed to ${
      failure === "fetch" ? "load" : "decode"
    } and paints nothing: ${causeMessage}`,
    failure,
    owner: Object.freeze({ element: ownerElement, property }),
    resource: Object.freeze({ kind: "image", requestedFinalURL }),
    cause: Object.freeze({ name: cause?.name ?? "Error", message: causeMessage }),
  }));
}

// A raster backdrop: a frozen { r, g, b, a }, or undefined for the
// renderer's default. `label` names the caller in the error.
function surfaceBackground(background, label) {
  if (background === undefined) return undefined;
  const { r, g, b, a } = background ?? {};
  if (
    !Number.isFinite(r) || !Number.isFinite(g) ||
    !Number.isFinite(b) || !Number.isFinite(a) || a < 0 || a > 1
  ) {
    throw new TypeError(
      `${label}: background requires finite r, g, b, a components with alpha between 0 and 1`,
    );
  }
  return Object.freeze({ r, g, b, a });
}

export function createRenderSurface(root, options = {}) {
  return new DOMRenderSurface(root, options);
}

let frameTransactionSequence = 0;
export function createFrameTransaction() {
  return {
    id: ++frameTransactionSequence,
    surfaces: new Set(),
    targets: new Map(),
    instances: new Map(),
    created: new Set(),
    retired: new Set(),
    workingSurfaces: new Map(),
    committed: false,
  };
}

// A session prepares all targets while every public surface/target still
// exposes its predecessor. The synchronous commit below invokes no authored
// callbacks; notification is a separate phase after all state is visible.
export async function commitFrameTransaction(transaction) {
  for (const [target, publication] of transaction.targets) {
    if (target._frameTransaction !== transaction || publication === null) {
      throw new Error("Frame transaction target is not prepared");
    }
  }
  const groups = new Map();
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    if (!staged) continue;
    surface._frameCore.status(
      "frame_validate_commit",
      staged.handle,
      staged.revision,
    );
    const entries = groups.get(surface._frameCore) ?? [];
    entries.push(staged);
    groups.set(surface._frameCore, entries);
  }
  const packets = [];
  for (const [core, entries] of groups) {
    packets.push({
      core,
      pointer: core.frameCommitGroupInput(entries),
      count: entries.length,
    });
  }
  for (const { core, pointer, count } of packets) {
    core.status("frame_commit_group", pointer, count);
  }
  for (const surface of transaction.created) {
    const registry = surface._root._renderSurfaces;
    const previous = registry.get(surface._canonicalEnvironmentKey);
    if (previous && previous !== surface) {
      registry.delete(surface._canonicalEnvironmentKey);
      previous._environmentKey =
        `${surface._canonicalEnvironmentKey}#retired:${transaction.id}`;
      registry.set(previous._environmentKey, previous);
      transaction.retired.add(previous);
      for (const surfaces of transaction.workingSurfaces.values()) {
        const index = surfaces.indexOf(previous);
        if (index !== -1) surfaces[index] = undefined;
      }
      if (surface._root._renderSurface === previous) {
        previous._disconnectSubtree(surface._root);
        surface._connectSubtree(surface._root);
      }
    }
    registry.delete(surface._environmentKey);
    surface._environmentKey = surface._canonicalEnvironmentKey;
    registry.set(surface._environmentKey, surface);
  }
  for (const surface of transaction.surfaces) surface._stagedFrame?.publish();
  for (const [instance, publication] of transaction.instances) {
    Object.assign(instance, publication);
  }
  for (const [target, publication] of transaction.targets) {
    Object.assign(target, publication);
    target._frameTransaction = null;
  }
  transaction.committed = true;
  const errors = [];
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    surface._stagedFrame = null;
    surface._frameTransaction = null;
    try {
      await staged?.present?.();
      staged?.notify();
    } catch (error) {
      errors.push(error);
    } finally {
      staged?.dispose();
      surface._schedule();
    }
  }
  for (const surface of transaction.retired) {
    surface.shutdown().catch((error) =>
      surface._reportBackgroundException(error)
    );
  }
  if (errors.length) {
    throw new AggregateError(errors, "Frame transaction listener errors");
  }
}

export async function abortFrameTransaction(transaction) {
  for (const surface of transaction.surfaces) {
    const staged = surface._stagedFrame;
    surface._stagedFrame = null;
    surface._frameTransaction = null;
    staged?.rollback();
    staged?.dispose();
  }
  for (const target of transaction.targets.keys()) {
    if (target._frameTransaction === transaction) {
      target._frameTransaction = null;
    }
  }
  for (const surface of transaction.created) await surface.shutdown();
  for (const surface of transaction.surfaces) surface._schedule();
}

// The device-pixel rectangle of a box, or null (frame_box_rectangle).
function boxRectangle(box, deviceScale) {
  if (!box) return null;
  const exports = sharedDomCore.exports;
  if (!exports.frame_box_rectangle(box.x, box.y, box.w, box.h, deviceScale)) return null;
  return {
    x: exports.frame_box_value(FRAME_BOX_X),
    y: exports.frame_box_value(FRAME_BOX_Y),
    width: exports.frame_box_value(FRAME_BOX_WIDTH),
    height: exports.frame_box_value(FRAME_BOX_HEIGHT),
  };
}

// A frame of another sample type always differs. Uint8 frames compare one
// pixel per 32-bit word.
function pixelsDifferInRectangles(previous, current, width, rectangles) {
  if (!previous || previous.length !== current.length || previous.constructor !== current.constructor) return true;
  if (current instanceof Uint8Array && current.byteOffset % 4 === 0 && previous.byteOffset % 4 === 0) {
    previous = new Uint32Array(previous.buffer, previous.byteOffset, previous.length / 4);
    current = new Uint32Array(current.buffer, current.byteOffset, current.length / 4);
    for (const rectangle of rectangles) {
      const right = Math.min(width, rectangle.x + rectangle.width);
      const bottom = Math.min(current.length / width, rectangle.y + rectangle.height);
      for (let y = Math.max(0, rectangle.y); y < bottom; y++) {
        const end = y * width + right;
        for (let offset = y * width + Math.max(0, rectangle.x); offset < end; offset++) {
          if (previous[offset] !== current[offset]) return true;
        }
      }
    }
    return false;
  }
  for (const rectangle of rectangles) {
    const right = Math.min(width, rectangle.x + rectangle.width);
    const bottom = Math.min(
      current.length / 4 / width,
      rectangle.y + rectangle.height,
    );
    for (let y = Math.max(0, rectangle.y); y < bottom; y++) {
      let offset = (y * width + Math.max(0, rectangle.x)) * 4;
      const end = (y * width + right) * 4;
      for (; offset < end; offset++) {
        if (previous[offset] !== current[offset]) return true;
      }
    }
  }
  return false;
}

// Layout box kind names by the scene's box kind code, from the core
// (scene_box_kind_name). The names are fixed, so one map serves every core.
const layoutBoxKindNames = new Map();
function layoutBoxKindName(core, kind) {
  let name = layoutBoxKindNames.get(kind);
  if (name === undefined) {
    name = core.status("scene_box_kind_name", kind) ? core.outputString() : null;
    layoutBoxKindNames.set(kind, name);
  }
  return name;
}

// What identifies a planned transition across reads: its endpoints and
// timing. A read that plans the same transition again keeps its pending
// CSSTransition.
function transitionPlanKey({ definition, startValue, endValue }) {
  return JSON.stringify([definition.duration, definition.delay, definition.easing, startValue, endValue]);
}

// The before-change style a read keeps of a target the last frame did not
// render (an element, or a ::before or ::after): the node's record copy
// and the CSS transform list, what transition planning reads of a previous
// node. A node that declares transitions carries both; another's are
// copied from its publication.
function readBaseline(node, target) {
  if (node._coreRecord !== undefined) return { _coreRecord: node._coreRecord, transform: node.transform };
  const publication = node._corePublication;
  const box = publication.boxes[node._corePublicationIndex];
  return {
    _coreRecord: publication.core.engineRecordAfterChange(box.stableId, box.sourceRevision),
    transform: isPseudoElementTarget(target) ? elementTransform(target.element, target.kind) : elementTransform(target),
  };
}

// The animation target at each scene row of a serialization's maps: the
// element of an element's row, and the pseudo-element-target.js identity
// of a ::before or ::after row. Built once per pair of maps, as
// nodesAtRow is.
const targetsAtRowByPseudoIndexMap = new WeakMap();
function targetsAtRow(indexOf, pseudoIndexOf) {
  let targets = targetsAtRowByPseudoIndexMap.get(pseudoIndexOf);
  if (targets === undefined) {
    targets = [];
    for (const [node, index] of indexOf) if (index !== null) targets[index] = node;
    for (const [target, index] of pseudoIndexOf) targets[index] = target;
    Object.freeze(targets);
    targetsAtRowByPseudoIndexMap.set(pseudoIndexOf, targets);
  }
  return targets;
}

// The node at each scene row of a serialization, built once per index map:
// every frame that reuses the scene (scroll-only, transform-only, clean)
// shares the serialization's map and so shares this array. Frozen: it is
// published as the surface's elementAtIndex.
const nodesAtRowByIndexMap = new WeakMap();
function nodesAtRow(serialized) {
  let nodes = nodesAtRowByIndexMap.get(serialized.indexOf);
  if (nodes === undefined) {
    nodes = new Array(serialized.nodes.length).fill(null);
    for (const [node, index] of serialized.indexOf) nodes[index] = node;
    Object.freeze(nodes);
    nodesAtRowByIndexMap.set(serialized.indexOf, nodes);
  }
  return nodes;
}

const SURFACE_OPTION_NAMES = new Set([
  "viewportWidth",
  "viewportHeight",
  "deviceScale",
  "density",
  "viewport",
  "now",
  "requestFrame",
  "cancelFrame",
  "createPersistentRenderer",
  "initializePersistentRenderer",
  "renderMode",
  "renderPrecision",
  "background",
  "presentFrame",
  "capturePaintArtifact",
  "textSelection",
  "graphicsBackend",
  "glyphResourceManager",
  "frameTransaction",
  "cursorTarget",
  "touchPanning",
  "textThickening",
  "scrollbarStyle",
]);

// scroll_surface_active_owner and scroll_surface_snap_plan results.
const ACTIVE_OWNER_KINDS = new Map([["SMOOTH", "smooth"], ["MOMENTUM", "momentum"], ["INTERACTION", "interaction"],
  ["REQUEST", "request"]].map(([name, kind]) => [layoutConstant(`SCROLL_ACTIVE_OWNER_${name}`), kind]));
const ACTIVE_OWNER_NONE = layoutConstant("SCROLL_ACTIVE_OWNER_NONE");
const SNAP_PLAN_NONE = layoutConstant("SCROLL_SNAP_PLAN_NONE");
const SNAP_PLAN_WALK = layoutConstant("SCROLL_SNAP_PLAN_WALK");
const SNAP_PLAN_NEEDS_CONTAINERS = layoutConstant("SCROLL_SNAP_PLAN_NEEDS_CONTAINERS");

// frame_clock_surface_source results.
const CLOCK_SOURCE_REAL = layoutConstant("SURFACE_CLOCK_REAL");
const CLOCK_SOURCE_OPTIONS = layoutConstant("SURFACE_CLOCK_OPTIONS");

// `now` and `requestFrame` are one clock (assertClockOptions). A surface
// over a document whose clock is fixed runs on that clock: it takes it when
// the caller supplies none, and refuses another one, so a page never reads
// one clock while its surface renders on another (frame_clock_surface_source).
function surfaceClockSource(options, ownerDocument) {
  const documentClock = ownerDocument?._clock ?? null;
  const source = sharedDomCore.statusRaw(
    "frame_clock_surface_source",
    documentClock === null ? 0 : 1,
    options.now === undefined ? 0 : 1,
    options.now === documentClock?.source.now ? 1 : 0,
    documentClock?.real ? 1 : 0,
  );
  if (source === CLOCK_SOURCE_REAL) return { ...realClockSource, real: true };
  if (source === CLOCK_SOURCE_OPTIONS) {
    return { now: options.now, requestFrame: options.requestFrame, cancelFrame: options.cancelFrame ?? (() => {}), real: false };
  }
  return { ...documentClock.source, real: documentClock.real };
}

class DOMRenderSurface {
  constructor(root, options = {}) {
    validateClosedRecord(options, SURFACE_OPTION_NAMES, "render surface options");
    assertClockOptions(options, "render surface options");
    const {
      viewportWidth = 1280,
      viewportHeight = 720,
      deviceScale = 1,
      // The device pixel ratio the document sees (SandomViewport); null
      // follows deviceScale, the raster scale.
      density = null,
      viewport = null,
      // The persistent renderer shares the document runtime's scene
      // renderer (one WASM engine, glyph manager, and WebGPU device across
      // every surface of that runtime) with a per-surface renderer and
      // render context. A caller-supplied factory returns a renderer at
      // once, as openSceneRenderer does: its engine side works before its
      // graphics context is `ready`.
      createPersistentRenderer = null,
      initializePersistentRenderer = true,
      renderMode = undefined,
      renderPrecision = undefined,
      background = undefined,
      presentFrame = null,
      capturePaintArtifact = false,
      textSelection = true,
      graphicsBackend = "auto",
      glyphResourceManager = null,
      frameTransaction = null,
      // An element whose `style.cursor` follows the document under the
      // pointer. Every flat-canvas host wants this; a host that projects
      // the document into a scene resolves cursors itself, because the
      // point has to be unprojected first, and passes nothing here.
      cursorTarget = null,
      // A primary touch-pointer drag pans the scroll container under it.
      // Off by default: a drag never scrolls, whatever the pointer type. A
      // host turns it on when the device takes touch input.
      touchPanning = false,
      // Optional glyph thickening in device pixels, per ink polarity
      // (design/text-rendering.md, "Glyph edge coverage"). Unset draws the
      // exact outline.
      textThickening = undefined,
      // "overlay" (the default) or "classic"
      // (design/scrollbars.md, decision 1). An overlay bar takes
      // no layout space and shows only while the scroller moves or the
      // pointer is in it; a classic bar is always shown and takes its
      // thickness from the scroller's content box.
      scrollbarStyle = "overlay",
    } = options;
    this.scrollbarStyle = assertScrollbarStyle(scrollbarStyle, "render surface options");
    if (typeof touchPanning !== "boolean") {
      throw new TypeError(
        `render surface options: touchPanning must be a boolean, received ${String(touchPanning)}`,
      );
    }
    // The raster backdrop belongs to the surface, not the root's box.
    // Keep one snapshot for every frame, including dirty-tile and resize frames.
    this._background = surfaceBackground(background, "render surface options");
    this._textThickening = undefined;
    if (textThickening !== undefined) {
      const { darkInk, lightInk } = textThickening ?? {};
      if (!(darkInk >= 0) || !(lightInk >= 0) || !Number.isFinite(darkInk) || !Number.isFinite(lightInk)) {
        throw new TypeError(
          `render surface options: textThickening requires finite, non-negative darkInk and lightInk device pixels, received ${JSON.stringify(textThickening)}`,
        );
      }
      this._textThickening = Object.freeze({ darkInk, lightInk });
    }
    root = resolveSurfaceRoot(root, "createRenderSurface");
    if (nodeMember(root, "parentElement")) {
      const documentElement = nodeMember(root, "ownerDocument")?.documentElement;
      if (!documentElement?.contains(root)) {
        throw new Error(
          "createRenderSurface: root must be a detached DOM tree root or belong to a document",
        );
      }
      root = documentElement;
    }
    const clock = surfaceClockSource(options, nodeMember(root, "ownerDocument"));
    this.viewport = viewport ?? new SandomViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScale,
      density,
    });
    if (!(this.viewport instanceof SandomViewport) || this.viewport._surface) {
      throw new Error(
        "createRenderSurface: viewport must be an unattached SandomViewport",
      );
    }
    this.viewport._surface = this;
    this.viewport.root = root;
    const ownerDocument = nodeMember(root, "ownerDocument");
    // The scrollbar style is part of the style environment: a classic bar
    // takes layout space, so a change re-lowers every record.
    ownerDocument?._styleSystem?.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
      scrollbarStyle: this.scrollbarStyle,
    });
    // An environment change outside the surface (forced colors, the media
    // type) owes a frame.
    this._environmentListener = () => {
      this._dirty = true;
      this._schedule();
    };
    ownerDocument?._styleSystem?.environmentListeners.add(this._environmentListener);
    if (ownerDocument?._reevaluateMediaQueryLists) {
      // Component documents keep single-valued window semantics
      // (window.innerWidth, requestAnimationFrame, visualViewport) bound to
      // ONE surface — the first live one. Additional surfaces coexist as
      // followers; shutdown promotes a remaining surface into this slot.
      ownerDocument._componentRenderSurface ??= this;
    }
    // Keyed surface registry: many live surfaces coexist over one root,
    // one per environment (width x height @ deviceScale) — mirroring
    // DocumentSession.layout()'s per-(root, environment) worlds. The first
    // surface to claim the node slots is the primary: it owns every node's
    // _renderSurface pointer (interaction targeting, layout getters, and
    // scrolling address exactly one surface). Followers receive mutation
    // fanout through the primary (_broadcastMutation and
    // _broadcastDisconnectSubtree below). Two surfaces at the SAME
    // (root, environment) never coexist: the second construction rejects
    // loudly; DocumentSession.render() serializes by shutting the existing
    // occupant down before creating a replacement.
    this._environmentKey =
      `${this.viewport.width}x${this.viewport.height}@${this.viewport.deviceScale}`;
    const surfaceRegistry = root._renderSurfaces ??= new Map();
    this._canonicalEnvironmentKey = this._environmentKey;
    if (frameTransaction) {
      this._environmentKey +=
        `#staged:${frameTransaction.id}:${frameTransaction.created.size}`;
    }
    if (surfaceRegistry.has(this._environmentKey)) {
      throw new Error(
        `createRenderSurface: root already has a live render surface for ` +
          `environment ${this._environmentKey}`,
      );
    }
    if (
      surfaceRegistry.size > 0 &&
      ownerDocument?._environmentObservations?.size > 0
    ) {
      throw new Error(
        `The document observed ${
          [...ownerDocument._environmentObservations].join(", ")
        }; one root cannot render under multiple environments.`,
      );
    }
    surfaceRegistry.set(this._environmentKey, this);
    // Every live surface over a tree of this document, attached to it or
    // not: a stylesheet change reaches each one (SDDocument._invalidateStyles).
    this._document = surfaceDocument(root);
    (this._document._liveRenderSurfaces ??= new Set()).add(this);
    this._now = clock.now;
    // A surface on the host's real clock lets the document's page timers
    // arm a host timer instead of waiting for this surface's frames
    // (src/dom/document-timers.js).
    this._nowIsHostTime = clock.real;
    this._requestFrame = clock.requestFrame;
    this._cancelFrame = clock.cancelFrame;
    this._glyphResourceManager = glyphResourceManager;
    const sceneRendererRuntime = ownerDocument?._sandomSceneRendererRuntime ??
      null;
    // A caller-supplied factory chooses its own device. Otherwise a device
    // the host gave the runtime (useGraphicsDevice) renders: the host owns
    // the realm's device, and the renderer draws the document's canvases
    // from theirs. Without one, the renderer adopts the device the
    // document's canvases already use (a WebGPU context's configured device,
    // or the one a Canvas 2D toBlob() requested before the first paint),
    // read when the renderer is created, as render-component does, so a
    // canvas bitmap and the renderer that paints it are on one device. A
    // document without one adopts the renderer's (_startPersistentRenderer).
    const sceneRendererFactory = sceneRendererRuntime?.openSceneRenderer ??
      openSceneRenderer;
    const runtimeHostDevice = sceneRendererRuntime?.hostGraphicsDevice ??
      hostGraphicsDevice;
    const persistentRendererFactory = createPersistentRenderer ??
      ((rendererOptions) =>
        sceneRendererFactory({
          ...rendererOptions,
          graphicsDevice: runtimeHostDevice() ?? this._document._preferredCanvasDevice ?? undefined,
        }));
    const layoutScene = sceneRendererRuntime?.layoutTreeBoxes ??
      layoutTreeBoxes;
    this._engineCounters = sceneRendererRuntime?.engineCounters ??
      engineCounters;
    if (presentFrame !== null && typeof presentFrame !== "function") {
      throw new TypeError("presentFrame must be a function or null");
    }
    this._presentFrame = presentFrame;
    this._persistentRenderer = null;
    this._createPersistentRenderer = persistentRendererFactory;
    this._persistentRendererOptions = Object.freeze({
      graphicsBackend,
      ...(renderMode === undefined ? {} : { renderMode }),
      ...(renderPrecision === undefined ? {} : { renderPrecision }),
      ...(glyphResourceManager === null ? {} : { glyphResourceManager }),
    });
    this._animationEventUnsubscribe = null;
    this._persistentRendererPromise = null;
    if (initializePersistentRenderer) this._startPersistentRenderer(this.viewport);
    // The surface demands images through its document's host resource
    // session; it has no provider of its own.
    this._resolveResource =
      (nodeMember(root, "nodeType") === 9 ? root : ownerDocument)?._resolveResource ?? null;
    // A broken image is a diagnostic of the render. Its error event is the
    // DOM image loading's (src/dom/images.js), not the render's.
    this._onImageLoadError = ({ node, property, requestedURL, failure, error }) => {
      if (
        error.cause instanceof SandomHostError &&
        error.cause.code === "invalid-host-response"
      ) {
        throw error.cause;
      }
      // A ::before or ::after box has no element handle: its owner is the
      // box at generatedOwnerIndex. A layout pass outside a render frame has
      // no element index; the scene renderer reports the cached failure
      // again on the next frame, which records it.
      const element = node._coreHandle === undefined
        ? this._eventElementAtIndex?.[node.generatedOwnerIndex]
        : this._eventElementAtIndex?.find((candidate) =>
          candidate?._coreHandle === BigInt(node._coreHandle)
        );
      if (!element) return;
      recordBrokenImageDiagnostic(element, node, property, requestedURL, failure, error);
    };
    this._capturePaintArtifact = capturePaintArtifact;
    this._textSelectionEnabled = Boolean(textSelection);
    // Set when the presented text geometry carries a viewport offset the
    // engine since clamped; the next frame rebuilds it.
    this._textGeometryStale = false;
    this._touchPanning = touchPanning;
    this._layoutTreeBoxes = async (scene) => {
      this._stageCounters.layoutPasses++;
      // Over the tree this surface renders, under its own claim: the
      // engine relayouts only the rows whose records changed and keeps the
      // rows for the frame that follows (scene-renderer's syncLayoutWrite).
      const engineWriteOwner = this._persistentRenderer?.engineWriteToken ??
        null;
      const boxes = await layoutScene(scene, {
        resolveResource: this._resolveResource,
        onImageLoadError: this._onImageLoadError,
        ...(engineWriteOwner === null ? {} : { engineWriteOwner }),
      });
      this._stageCounters.nodesLaidOut +=
        this._engineCounters().layoutComputeCount;
      return boxes;
    };
    // Permanent frame-stage counters (presented-frame refactor verification
    // contract): a scroll-only frame MUST NOT advance serializations or
    // layoutPasses. Live checks inspect these instead of trusting a small
    // dirty rectangle.
    this._stageCounters = {
      serializations: 0,
      layoutPasses: 0,
      scrollOnlyFrames: 0,
      // Scroll-only frames whose presented geometry was derived from the
      // previous frame's instead of walking the tree again.
      geometrySuccessorFrames: 0,
      // The geometries a frame built from its boxes (geometry_build): its
      // observer checkpoint's, its scrollbars' when no restyle basis or
      // checkpoint geometry gives them, and its interaction snapshot's when
      // it derived none. A derived geometry is not counted.
      geometryBuilds: 0,
      // Frames whose interaction snapshot was derived from the geometry the
      // frame built for its observer checkpoint (geometry_frame_successor),
      // and the frames whose checkpoint geometry was refused, by cause.
      geometryFrameSuccessorFrames: 0,
      geometryFrameRefusedEnvelope: 0,
      geometryFrameRefusedRevisions: 0,
      // Frames whose frame geometry derived from a synchronous layout
      // read's live geometry (geometry_frame_successor) instead of a build.
      geometryReadSuccessorFrames: 0,
      // Frames whose presented geometry was derived from the previous
      // frame's after a restyle that inserted, removed and laid out no row
      // (geometry_restyle_successor), the element records whose facts
      // those derivations built again, and the derivations that walked the
      // flat tree to prove it unchanged (their predecessor was not proven).
      geometryRestyleFrames: 0,
      geometryRestyleRecordsRebuilt: 0,
      geometryRestyleTreeWalks: 0,
      // The work of every derived geometry snapshot (scroll and restyle
      // successors): elements resolved, records copied with the record
      // pages they shared with the predecessor, records derived, and box
      // rows compared with the records (none when the frame presents the
      // predecessor's box snapshot).
      geometrySuccessorElementsResolved: 0,
      geometrySuccessorRecordsCopied: 0,
      geometrySuccessorRecordsDerived: 0,
      geometrySuccessorBoxRowsRead: 0,
      // Restyle derivations refused, by reason; each such frame built its
      // geometry. Viewport: another viewport size, scale or viewport row.
      // Text: text geometry other than the previous frame's (translations
      // aside). Tree, rows, fragments: the core found another flat tree,
      // another row, or another fragment count.
      geometryRestyleRefusedViewport: 0,
      geometryRestyleRefusedText: 0,
      geometryRestyleRefusedTree: 0,
      geometryRestyleRefusedRows: 0,
      geometryRestyleRefusedFragments: 0,
      retainedTransformFrames: 0,
      retainedCleanFrames: 0,
      // Frames that restyled the retained publication in place instead of
      // building the scene (frame mode 4, engine_record_restyle), and the
      // mode 4 frames that built it, by reason. Mutation: a mutation since
      // the last frame other than a state change that only restyles
      // (FRAME_MUTATION_EFFECT_NOT_RESTYLE_STATE). Viewport:
      // another viewport size or scale than the retained scene's. The
      // others are the core's refusals: build (the publication is not the
      // last scene build's), list (the restyle list describes another
      // publication), generation (cascade, font table or face index),
      // overflow (of the restyle list), root (the root or a child of it
      // restyled), contents (a restyled display: contents element) and
      // structure (a record changed more than paint-only properties, or a
      // pseudo-element started or stopped generating content). Rows read:
      // the publication rows those restyles read the serial of (the rows of
      // the restyled elements and of the descendants they changed).
      sceneRestyleFrames: 0,
      sceneRestyleRowsRead: 0,
      sceneRestyleRefusedMutation: 0,
      sceneRestyleRefusedViewport: 0,
      sceneRestyleRefusedBuild: 0,
      sceneRestyleRefusedList: 0,
      sceneRestyleRefusedGeneration: 0,
      sceneRestyleRefusedOverflow: 0,
      sceneRestyleRefusedRoot: 0,
      sceneRestyleRefusedContents: 0,
      sceneRestyleRefusedStructure: 0,
      retainedDeliveries: 0,
      deliveredFrames: 0,
      // Snap applications that walked the tree for snap containers.
      snapTreeWalks: 0,
      // Reused text geometry entries a frame wrote a translation into. A
      // frame that scrolls only the viewport shifts the reused geometry as
      // a whole and writes only its text controls' entries.
      translatedTextGeometryEntries: 0,
      // The text geometry grouping's work: the text operations of the
      // command stream it visited, and the text owners it asked the core
      // for a scroll shift of.
      textGeometryOperationsGrouped: 0,
      textGeometryOwnersGrouped: 0,
      // Work counters, totals over the surface's frames. Restyles are the
      // core's element and pseudo-element records resolved during a frame;
      // scene rows those of the frame's scene builds, lowered rows those its
      // publications lowered anew; changed rows the engine rows the renderer
      // published; nodes laid out those every layout pass computed; command
      // bytes those a paint walk wrote; retained patches the nodes whose
      // paint fields a retained transaction changed; command blocks the
      // blocks it emitted again and spliced in, block commands the commands
      // in them. Commands decoded are the commands the renderer read for the
      // paint artifact, the text geometry, the glyph and path resources and
      // the highlighted stream; replanned ranges and commands those the
      // raster plan planned again (a preparation or a rescroll plans the
      // whole stream as one range). Text batches are the
      // text preparations the renderer ran, text rows the rows they
      // prepared; kept and rebuilt text runs the republished rows whose run
      // a patch kept or re-prepared. Raster damage is the device pixels the
      // raster painted, damage selections the frames whose raster replayed
      // the plan's damage selection (raster_plan_select).
      elementsRestyled: 0,
      // Of elementsRestyled, the records that came out identical to the
      // record they replaced.
      elementsRestyledUnchanged: 0,
      // The elements the frame's scene builds walked, the boxes they made
      // and the subtrees they took from the subtree cache
      // (computed_restyle_counts).
      sceneElementsVisited: 0,
      sceneBoxesMade: 0,
      sceneSubtreesReplayed: 0,
      pseudoElementsRestyled: 0,
      sceneRowsBuilt: 0,
      rowsLowered: 0,
      rowsChanged: 0,
      nodesLaidOut: 0,
      paintWalks: 0,
      commandBytesEmitted: 0,
      retainedCommandPatches: 0,
      commandBlocksEmitted: 0,
      blockCommandsEmitted: 0,
      commandsDecoded: 0,
      rasterPlanRangesReplanned: 0,
      rasterPlanCommandsReplanned: 0,
      textBatchesPrepared: 0,
      textRowsPrepared: 0,
      textRunsKept: 0,
      textRunsRebuilt: 0,
      rasterDamagePixels: 0,
      rasterDamageSelections: 0,
      currentStage: "idle",
    };
    this._frameListeners = [];
    this._frameRequest = null;
    this._caretTimer = null;
    // The host timeout that wakes the loop for a held spin half's next step.
    this._spinTimer = null;
    this._frameTransaction = frameTransaction;
    this._stagedFrame = null;
    this._frameSequence = 0;
    this._viewportRevision = 0n;
    this._eventElementAtIndex = null;
    // The animation target at each row of the frame (targetsAtRow).
    this._eventTargetAtIndex = null;
    this._dirty = true;
    this._rendering = false;
    // The frame's animation microtask checkpoint runs (_render).
    this._animationCheckpoint = false;
    this._animationPromisesSettled = false;
    // Synchronous layout and DOM removal defer engine events until a frame.
    this._animationEventDeferralDepth = 0;
    this._deferredAnimationEvents = [];
    this._running = true;
    this._idleWaiters = [];
    this._shutdown = false;
    this._lastPixels = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._indexOfElement = new Map();
    this._indexOfPseudoTarget = new Map();
    // The rows a synchronous layout moved the tracks from, by its rows
    // (_moveTracksToLayoutRows), until _runSyncLayout moves them back.
    this._layoutRowsReturn = null;
    // Script animations whose targets a remap left without a row
    // (_parkHiddenAnimations), until the next frame sets the rows.
    this._parkedAnimations = null;
    this._elementAtIndex = [];
    this._computedSamples = root._domCore.status("computed_samples_create");
    this._lastBoxes = [];
    // Paged media: the page index setPage() selected, or null for the
    // continuous document; and the last rendered frame's page record.
    this._page = null;
    this._pageFrame = null;
    // The page boxes of the last count, { key, boxes }, and whether the last
    // page frame targeted another box than its page's.
    this._pageBoxes = null;
    this._pageTargetStale = false;
    // The JSON of the page-margin boxes the DOM core holds.
    this._pageMarginsKey = "null";
    // The page index the last rendered frame requested.
    this._renderedPage = null;
    this._presentedFrame = null;
    // The element whose cursor follows the document, and the value last
    // written there so an unchanged cursor is not re-assigned.
    this._cursorTarget = cursorTarget;
    this._appliedCursor = null;
    this._preparedState = null;
    // The box tree layoutTree() built, and the prepared frame it is for.
    this._layoutTree = null;
    this._layoutTreeFor = null;
    this._syncLayout = null;
    // The serialization of the last transition planning, for the layout
    // read that follows it (_takePlannedSerialization), or null.
    this._plannedSerialization = null;
    // A synchronous getter's layout of the page this surface shows
    // (_offerSyncPageLayout): another getter reads it; frames do not, as
    // its boxes lie in the space of the pages.
    this._syncPageLayout = null;
    // Style-generation checkpoints (frame-incrementality): the style system
    // bumps its generation on EVERY DOM mutation and on stylesheet, font,
    // and environment changes - the same key its per-element resolution
    // cache trusts. An unchanged generation therefore proves the CSS
    // animation-definition scan and the serialized scene are both current.
    // Canvas draws (canvas-paint/canvas-size) bypass the style system by
    // design; they invalidate through _mutatedNodes, never through these.
    this._animationSyncStyleGeneration = -1;
    this._serializedStyleGeneration = -1;
    // The serialized scene is viewport-shaped; a resize invalidates it even
    // when the style environment (width x height only) already caught it.
    this._serializedViewportWidth = -1;
    this._serializedViewportHeight = -1;
    this._serializedViewportScale = -1;
    // Observer delivery is owed only while an observation registered since
    // the last delivery pass awaits its initial entry. Every later
    // notification requires a geometry change, and a clean frame reuses
    // both the retained scene and the retained boxes, so its signature
    // diff is a proven no-op.
    this._pendingObserverDelivery = true;
    this._mutatedNodes = new Set();
    this._forcedGenerationNodes = new Set();
    this._selectionChanged = false;
    this._transformOnlyMutations = new Set();
    this._hasNonTransformMutation = false;
    // Whether a mutation since the last frame was anything but a state
    // change that only restyles (FRAME_MUTATION_EFFECT_NOT_RESTYLE_STATE);
    // only a frame without one may restyle the retained scene (frame mode 4).
    this._hasNonStateMutation = false;
    this._scrollOwner = root._domCore.status("scroll_owner_create");
    root._domCore.status(
      "scroll_owner_bind",
      this._scrollOwner,
      root._coreHandle,
    );
    this._scrollAnchors = new NativeScrollCollection(this, SCROLL_COLLECTION.ANCHORS);
    this._anchoringSuppressionProperties = new NativeScrollSuppression(this, SCROLL_SUPPRESS.ANCHORING);
    this._positionSuppressionNodes = new NativeScrollSuppression(this, SCROLL_SUPPRESS.POSITION);
    this._forceFullInvalidation = false;
    // A forced rebuild that also repaints the whole target. A structural
    // mutation rebuilds the scene and owes only the damage the engine
    // derives from its rows (the predecessor of each row pairs a moved
    // row with its old place).
    this._forceFullDamage = false;
    this._preservedScrollMetrics = null;
    // Visible-region rasterization (raster-scale plan, slice 3): the
    // CSS-px rectangle of the scene the raster target covers; null
    // covers the full scene.
    this._visibleRectangle = null;
    this._selectedRoot = null;
    this._selectedLayer = null;
    this._forceStateDelivery = false;
    this._currentTime = 0;
    this._activeTransitionCount = 0;
    this._transitionTimings = new WeakMap();
    this._transitionRecords = new Map();
    // The time the renderer last ticked the engine's tracks at: every
    // transition that time reached the end of has ended by then.
    this._transitionTickMilliseconds = null;
    // The transitions that a read between frames (getAnimations()) found
    // a style change to start, by element and property. Each is a pending
    // CSSTransition until the next frame declares its track
    // (_startStyleChangeAnimations, _registerStartedTransition). A
    // cancelled one stays until then, so that the frame starts nothing in
    // its place. The key holds the frame sequence and style generation
    // that the transitions were planned for.
    this._pendingTransitions = new Map();
    // The before-change style of each element that a read saw and the last
    // frame did not render (_planPendingTransitions), and the ones the
    // frame in progress plans from.
    this._readBaselines = new Map();
    this._frameReadBaselines = null;
    this._pendingTransitionsKey = null;
    this._styleChangeAnimationsKey = null;
    // The provisional tracks by animation identity (_setProvisionalTrack).
    this._provisionalTracks = new Map();
    // The pending transitions of the frame in progress.
    this._frameHeldTransitions = null;
    this._animations = [];
    // Animations this surface adopted from a document's pending timeline
    // (element.animate() before any surface existed). They hold until the
    // first frame gives them a time to start from.
    this._animationsAwaitingTimeline = new Set();
    // Pause-pending animations: the next frame commits their pauses.
    this._animationsPausePending = new Set();
    this._animationCancelingThroughEngine = null;
    this._cssAnimations = new Map();
    this._pseudoContentAnimations = new Map();
    this._pendingScrollSources = new NativeScrollCollection(this, SCROLL_COLLECTION.SOURCES);
    this._pendingScrollEndTargets = new NativeScrollCollection(this, SCROLL_COLLECTION.END_TARGETS);
    this._capturingFrames = false;
    this._advancingDocumentClock = false;
    this._pendingSnapOrigins = new NativeScrollCollection(this, SCROLL_COLLECTION.SNAP_ORIGINS);
    this._snappedTargets = new NativeScrollCollection(this, SCROLL_COLLECTION.SNAPPED);
    this._snapCheckPending = false;
    // A layout consequence owes a snap-container check; the frame that
    // renders it asks the core, which resolved every box element, and only
    // a tree with snap containers keeps a snap frame scheduled or walks
    // the tree for them after a scroll (_snapContainersInLastBuild).
    this._snapCheckOwed = false;
    this._snapContainersPresent = false;
    this._snapContainersBuild = -1;
    this._smoothScrolls = new NativeScrollMotions(this);
    this._scrollbars = [];
    // Overlay scrollbar visibility on the surface clock (decision 2 of
    // design/scrollbars.md). Each published descriptor carries
    // the visibility it was painted with.
    this._scrollbarVisibility = new ScrollbarVisibility(this.scrollbarStyle);
    // Tool overlay (an inspector's highlight): rectangles painted above
    // the document and its scrollbars. `Rendered` is the list the last
    // rendered frame painted.
    this._toolHighlights = Object.freeze([]);
    this._toolHighlightsRendered = this._toolHighlights;
    this._pendingAnimationDeclarations = [];
    this._animationFrameCore = root._domCore;
    this._animationFrameOwner = this._animationFrameCore.status(
      "animation_frame_surface_create",
    );
    this._frameCore = root._domCore;
    this._frameOwner = this._frameCore.status(
      "frame_surface_create",
      root._coreHandle,
    );
    this._frameBindings = createFrameBindings(this._frameCore);
    this._animationFrameCallbacks = new Map();
    this._root = root;
    if (frameTransaction) {
      frameTransaction.created.add(this);
      frameTransaction.surfaces.add(this);
    }
    this._snapCheckOwed = true;
    if (root._renderSurfaces.size === 1) this._connectSubtree(root);
    this._schedule();
    // The document's page timers now follow this surface's clock when it
    // drives the document.
    if (ownerDocument?._componentRenderSurface === this) {
      ownerDocument._documentTimers?.driverChanged();
    }
  }

  get root() {
    return this._root;
  }

  get currentTime() {
    return this._currentTime;
  }

  get indexOfElement() {
    return this._indexOfElement;
  }

  get elementAtIndex() {
    return this._elementAtIndex;
  }

  // The generation of the document's styles: it changes when a computed
  // style of the document may have changed (a style sheet, an attribute, a
  // state such as :hover), so a tool that reads computed styles reads them
  // again only then.
  get styleGeneration() {
    return this._root.ownerDocument?._styleSystem?.generation ?? 0;
  }

  // The box tree of the last prepared frame, for inspection: one entry per
  // layout box in tree order, as laid out. Each entry is { index, parent
  // (an index, or -1), children (indices), kind, display, node (the DOM
  // node the box comes from, the originating element of a ::before or
  // ::after box, or null for an anonymous box), text (a text box's text),
  // rect, content, page, fragments }. `kind` names the box: "element", "text", "anonymous
  // inline", "::before", "::after", "::before text", "::after text", "line
  // feed", "form value", "placeholder", "list marker", "marker wrapper",
  // "contents root", "anonymous table box" or "viewport". `rect` and
  // `content` are the border and content boxes in viewport CSS pixels of
  // the frame as scrolled, without transforms. A text node's box takes the
  // union of its glyph runs in the presented frame; generated text, which
  // has no node of its own, has a null rect. In a paged frame, `fragments`
  // lists the box's fragment on each page that holds part of it, in page
  // order, each { page, rect, content }; the fragment on the page shown is
  // the entry's own rect and content, and a box off the shown page has a
  // null rect. `page` is the first fragment's page, null for a box on no
  // page. A continuous frame has null `fragments` and `page`. The same
  // frame returns the same frozen array.
  layoutTree() {
    const prepared = this._preparedState;
    if (prepared === null) return Object.freeze([]);
    if (this._layoutTreeFor === prepared) return this._layoutTree;
    const { nodes } = prepared.serialized;
    const boxes = this._lastBoxes;
    const parents = new Array(nodes.length).fill(-1);
    for (let index = 0; index < nodes.length; index++) {
      for (const child of nodes[index].children ?? []) parents[child] = index;
    }
    const entries = new Array(nodes.length);
    const frame = this._presentedFrame;
    // Nodes on other pages have no geometry on this one.
    const offPage = new Set(this._pageFrame?.offPageNodes ?? []);
    const nodeFragments = this._pageFrame?.nodeFragments ?? null;
    const shownPage = this._pageFrame?.index ?? null;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const box = offPage.has(index) ? null : boxes[index];
      const parent = parents[index];
      // A scene node without a core box (a hand-authored scene) is a text
      // box by its display, else it has no box kind (0).
      const kindCode = (node._coreBox ?? (node.display === "text" ? SCENE_BOX_TEXT : 0)) & 0xff;
      const kind = layoutBoxKindName(this._frameCore, kindCode);
      if (kind === null) {
        throw new Error(`layoutTree: box ${index} has kind ${kindCode}, which has no name; name it in scene_box_kind_name`);
      }
      let domNode = this._elementAtIndex[index] ?? null;
      if (domNode === null && node.generatedOwnerIndex !== undefined) {
        domNode = this._elementAtIndex[node.generatedOwnerIndex] ?? null;
      }
      const rectangle = (x, y, w, h) => Object.freeze({ x, y, width: w, height: h });
      let rect = null;
      let content = null;
      if (node.display !== "text" || (domNode?.nodeType !== 3 && box && box.w > 0 && box.h > 0)) {
        if (box) {
          rect = rectangle(box.x, box.y, box.w, box.h);
          content = rectangle(box.cx, box.cy, box.cw, box.ch);
        }
      } else if (domNode?.nodeType === 3 && frame !== null && domNode.length > 0) {
        const runs = selectionRectangles(frame, [{ node: domNode, start: 0, end: domNode.length }]);
        if (runs.length > 0) {
          const left = Math.min(...runs.map((run) => run.x));
          const top = Math.min(...runs.map((run) => run.y));
          const right = Math.max(...runs.map((run) => run.x + run.width));
          const bottom = Math.max(...runs.map((run) => run.y + run.height));
          rect = content = rectangle(left, top, right - left, bottom - top);
        }
      }
      // The engine's computed box of a text node is not its glyph runs:
      // the fragment on the page shown takes the entry's own geometry.
      let fragments = nodeFragments?.[index] ?? null;
      if (fragments !== null && rect !== null) {
        fragments = Object.freeze(fragments.map((fragment) =>
          fragment.page === shownPage ? Object.freeze({ page: fragment.page, rect, content }) : fragment
        ));
      }
      if (nodeFragments !== null && fragments === null) fragments = Object.freeze([]);
      entries[index] = Object.freeze({
        index,
        parent,
        children: Object.freeze([...(node.children ?? [])]),
        kind,
        display: node.display,
        node: domNode,
        text: node.display === "text" ? node.text : null,
        rect,
        content,
        page: fragments?.[0]?.page ?? null,
        fragments,
      });
    }
    this._layoutTreeFor = prepared;
    this._layoutTree = Object.freeze(entries);
    return this._layoutTree;
  }

  // The document outline of the surface's root (document-outline.js), with
  // each bookmark-label resolved to text (its counters, attr(), content()
  // and target functions) and the state "open" or "closed". The outline
  // reads the current styles; read it again after a change. In a paged
  // frame each entry also has `page`, the first page that holds its
  // element's box (layoutTree()), null for an element on no page; in a
  // continuous frame `page` is null.
  documentOutline() {
    const outline = readDocumentOutline(this._root);
    const pages = new Map();
    for (const box of this.layoutTree()) {
      if (box.kind === "element" && box.page !== null && !pages.has(box.node)) pages.set(box.node, box.page);
    }
    const paginate = (entries) => {
      for (const entry of entries) {
        entry.page = pages.get(entry.element) ?? null;
        paginate(entry.children);
      }
    };
    paginate(outline);
    return outline;
  }

  // The ranges of the highlight overlays that the program supplies (CSS
  // Pseudo 4 §3.1, src/dom/highlights.js). setTargetText(directive)
  // highlights the first match of a text directive as ::target-text and
  // returns its Range (null clears it, or when nothing matches).
  // find(text, { caseSensitive }) highlights every match as ::search-text,
  // the first as the current match (::search-text:current), and returns
  // them; findNext({ backwards }) moves the current match. Ranges given to
  // setSpellingErrors() and setGrammarErrors() become ::spelling-error and
  // ::grammar-error.
  setTargetText(directive) {
    return setTargetText(this._root.ownerDocument, directive);
  }
  find(text, options = {}) {
    return findText(this._root.ownerDocument, text, options);
  }
  findNext(options = {}) {
    return findNext(this._root.ownerDocument, options);
  }
  setSpellingErrors(ranges) {
    setErrorRanges(this._root.ownerDocument, "spelling", ranges, "setSpellingErrors");
  }
  setGrammarErrors(ranges) {
    setErrorRanges(this._root.ownerDocument, "grammar", ranges, "setGrammarErrors");
  }

  // The immutable presented-frame interaction snapshot for the last
  // DELIVERED frame (design/interaction.md).
  // Host input targeting and presented scroll-range reads consume this; it
  // is null until the first frame delivers.
  get presentedFrame() {
    return this._presentedFrame;
  }

  // Adds one render's work (scene-renderer's performance.preparation and
  // performance.rasterPreparation) to the surface's work counters. A
  // renderer without the record (a test double) reports none.
  _countRenderWork(performance) {
    const preparation = performance?.preparation;
    if (preparation?.writtenRowCount === undefined) return;
    const counters = this._stageCounters;
    counters.rowsChanged += preparation.writtenRowCount;
    counters.nodesLaidOut += preparation.nodesLaidOut;
    if (preparation.paintWalked) counters.paintWalks++;
    counters.commandBytesEmitted += preparation.commandBytesEmitted;
    counters.retainedCommandPatches += preparation.retainedCommandPatches;
    counters.commandBlocksEmitted += preparation.commandBlocksEmitted;
    counters.blockCommandsEmitted += preparation.blockCommandsEmitted;
    counters.commandsDecoded += preparation.commandsDecoded;
    counters.rasterPlanRangesReplanned += preparation.rasterPlanRangesReplanned;
    counters.rasterPlanCommandsReplanned +=
      preparation.rasterPlanCommandsReplanned;
    counters.textBatchesPrepared += preparation.textBatchesPrepared;
    counters.textRowsPrepared += preparation.textRowsPrepared;
    counters.textRunsKept += preparation.textRunsKept;
    counters.textRunsRebuilt += preparation.textRunsRebuilt;
    counters.rasterDamagePixels += preparation.rasterDamagePixels;
    if (performance.rasterPreparation?.damageSelected) {
      counters.rasterDamageSelections++;
    }
  }

  // Permanent frame-stage counters (Slice 2 verification contract). Frozen
  // copy: consumers inspect, never mutate.
  get frameStageCounters() {
    return Object.freeze({ ...this._stageCounters });
  }

  get scrollbars() {
    return this._scrollbars;
  }
  inspectScrolling(target = this.viewport) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (target !== this.viewport && target._renderSurface !== this) {
      throw new Error(
        "inspectScrolling: target is not connected to this render surface",
      );
    }
    const snapshot = this._presentedFrame;
    const node = target === this.viewport ? 0n : target._coreHandle;
    const fact = (field) =>
      snapshot?.geometryHandle
        ? this._root._domCore.status(
          "geometry_value",
          snapshot.geometryHandle,
          node,
          field,
        )
        : 0;
    const owner = this._root._domCore.exports.scroll_surface_active_owner(
      this._smoothScrolls.has(target) ? 1 : 0,
      this._scrollMomentum && this._scrollMomentumTarget === target ? 1 : 0,
      this._scrollInteractionActive && this._scrollInteractionTarget === target ? 1 : 0,
      this._pendingScrollSources.has(target) ? 1 : 0,
    );
    const activeOwner = owner === ACTIVE_OWNER_NONE ? null : Object.freeze({
      kind: ACTIVE_OWNER_KINDS.get(owner),
      source: owner === ACTIVE_OWNER_SMOOTH
        ? this._smoothScrolls.get(target).source
        : owner === ACTIVE_OWNER_REQUEST
        ? this._pendingScrollSources.get(target)
        : "pointer",
    });
    return Object.freeze({
      requestedLeft: target === this.viewport
        ? target._requestedLeft
        : target._requestedScrollLeft,
      requestedTop: target === this.viewport
        ? target._requestedTop
        : target._requestedScrollTop,
      effectiveLeft: target === this.viewport
        ? target.scrollX
        : target._scrollLeft,
      effectiveTop: target === this.viewport
        ? target.scrollY
        : target._scrollTop,
      minimumLeft: fact(GEOMETRY_SCROLL_MIN_LEFT),
      maximumLeft: fact(GEOMETRY_SCROLL_MAX_LEFT),
      minimumTop: fact(GEOMETRY_SCROLL_MIN_TOP),
      maximumTop: fact(GEOMETRY_SCROLL_MAX_TOP),
      scrollWidth: fact(GEOMETRY_SCROLL_WIDTH),
      scrollHeight: fact(GEOMETRY_SCROLL_HEIGHT),
      activeOwner,
      pendingScroll: this._pendingScrollSources.has(target),
      pendingScrollEnd: this._pendingScrollEndTargets.has(target),
    });
  }

  // Attaches a GPU frame comparison (README.md, "Frame comparison"):
  // each rendered frame is compared on the GPU with the latest accepted
  // image. `result(record)` receives each frame's record and
  // `failure(error)` the error that ends the comparison. `operation`
  // replies with the comparison, once its first owner exists, or throws its
  // creation error. Options: budget (GPU bytes), historySlots, ringDepth,
  // policy ("wait" or "drop"), tileSize (physical pixels).
  attachFrameComparison(options, operation) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (this._frameComparison !== undefined && this._frameComparison !== null) {
      throw new Error("render surface already has a frame comparison; detach it first");
    }
    let comparison = null;
    const session = createFrameComparisonSession({
      ...options,
      ready: { reply: () => operation.reply(comparison), throw: (error) => operation.throw(error) },
    });
    comparison = Object.freeze({
      readImage: (request, readOperation) => session.readImage(request, readOperation),
      readMask: (request, readOperation) => session.readMask(request, readOperation),
      gpuResources: () => session.gpuResources(),
      statistics: () => session.statistics(),
      detach: (detachOperation) => {
        if (this._frameComparison !== session) throw new Error("the frame comparison is detached");
        this._frameComparison = null;
        this._persistentRenderer.detachFrameComparison().then(() => detachOperation.reply(), (error) => detachOperation.throw(error));
      },
    });
    this._frameComparison = session;
    if (!this._persistentRendererPromise) this._startPersistentRenderer(this.viewport);
    // The baseline: the next frame renders, with full damage, even when
    // nothing changed; a retained frame would re-deliver the presented one
    // and render nothing.
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._persistentRendererPromise
      .then((renderer) => renderer.attachFrameComparison(session))
      .then(() => this._schedule(), (error) => operation.throw(error));
  }
  onFrame(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onFrame callback must be a function");
    }
    if (this._shutdown) throw new Error("render surface is shut down");
    this._frameListeners.push(callback);
    return () => {
      const index = this._frameListeners.indexOf(callback);
      if (index !== -1) this._frameListeners.splice(index, 1);
    };
  }
  _connectSubtree(node) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const pendingNodes = [node];
    while (pendingNodes.length > 0) {
      const current = pendingNodes.pop();
      if (current._renderSurface && current._renderSurface !== this) {
        throw new Error("node belongs to another live render surface");
      }
      current._renderSurface = this;
      this._adoptPendingAnimations(current);
      if (current._shadowRoot) pendingNodes.push(current._shadowRoot);
      const children = current.childNodes;
      for (let index = children.length - 1; index >= 0; index--) pendingNodes.push(children[index]);
    }
  }
  // The animations `node` collected while it had no surface become this
  // surface's, in creation order, the moment it claims the node. Their start
  // times are still unresolved: this surface's timeline has no time until it
  // renders, and _render resolves them on its next frame.
  _adoptPendingAnimations(node) {
    const pending = takePendingAnimations(node);
    if (pending === null) return;
    for (const animation of pending) {
      animation._surface = this;
      this._animations.push(animation);
      if (animation._timelinePending && !animation._timelineCleared) this._animationsAwaitingTimeline.add(animation);
      else animation._restoreEngineBinding();
    }
    this._scheduleAnimationFrame(node);
  }
  _disconnectSubtree(node) {
    const pendingNodes = [node];
    while (pendingNodes.length > 0) {
      const current = pendingNodes.pop();
      if (current._renderSurface !== this) continue;
      this._forgetNodeState(current);
      if (current._scrollState) {
        current._domCore.status("scroll_detach", current._scrollState);
      }
      current._renderSurface = null;
      if (current._shadowRoot) pendingNodes.push(current._shadowRoot);
      const children = current.childNodes;
      for (let index = children.length - 1; index >= 0; index--) pendingNodes.push(children[index]);
    }
  }
  // Per-surface bookkeeping cleanup for one removed node — shared between
  // the primary's slot-releasing disconnect above and the follower fanout
  // below, which must never touch the primary's _renderSurface slots.
  _forgetNodeState(node) {
    // A synchronous layout can reuse this node's row before another frame.
    // Release both provisional and bound effects while the row still belongs
    // to this node; script animation state keeps its document timeline.
    // An element's ::before and ::after transitions go with it.
    const targets = node.nodeType === 1
      ? [node, pseudoElementTarget(node, "::before"), pseudoElementTarget(node, "::after")]
      : [node];
    this._animationEventDeferralDepth++;
    try {
      for (let index = this._animations.length - 1; index >= 0; index--) {
        const animation = this._animations[index];
        if (animation._element !== node) continue;
        this._dropProvisionalTrack(animation._animationId);
        if (animation instanceof CSSAnimation) animation._cancelByUserAgent();
        else {
          animation._detachFromSurface();
          this._removeAnimation(animation);
        }
      }
      // Reconnection must reconcile fresh CSS effects, not reuse cancelled records.
      this._cssAnimations.delete(node);
      for (const target of targets) {
        const transitions = this._transitionRecords.get(target);
        if (transitions) for (const record of [...transitions.values()]) record.animation.cancel();
        const pendingTransitions = this._pendingTransitions.get(target);
        if (pendingTransitions) for (const animation of [...pendingTransitions.values()]) animation.cancel();
      }
    } finally {
      this._animationEventDeferralDepth--;
    }
    for (const target of targets) {
      this._pendingTransitions.delete(target);
      this._indexOfPseudoTarget.delete(target);
    }
    this._indexOfElement.delete(node);
    for (let index = this._pendingAnimationDeclarations.length - 1; index >= 0; index--) {
      const declaration = this._pendingAnimationDeclarations[index];
      if (!targets.includes(declaration.target)) continue;
      declaration.release?.();
      this._pendingAnimationDeclarations.splice(index, 1);
    }
    if (this._computedSamples) {
      node._domCore.status("computed_samples_remove_node", this._computedSamples, node._coreHandle);
    }
    this._mutatedNodes.delete(node);
    this._forcedGenerationNodes.delete(node);
    this._scrollAnchors.delete(node);
    for (const [container, state] of this._scrollAnchors) {
      if (state.element === node) this._scrollAnchors.delete(container);
    }
    this._anchoringSuppressionProperties.delete(node);
    this._positionSuppressionNodes.delete(node);
    this._pendingScrollSources.delete(node);
    this._pendingScrollEndTargets.delete(node);
    this._pendingSnapOrigins.delete(node);
    this._smoothScrolls.delete(node);
    this._snappedTargets.delete(node);
    for (const [container, targets] of this._snappedTargets) {
      if (targets.horizontal === node || targets.vertical === node) {
        this._snappedTargets.delete(container);
      }
    }
  }
  _forgetSubtreeState(node) {
    const pendingNodes = [node];
    while (pendingNodes.length > 0) {
      const current = pendingNodes.pop();
      this._forgetNodeState(current);
      if (current._shadowRoot) pendingNodes.push(current._shadowRoot);
      const children = current.childNodes;
      for (let index = children.length - 1; index >= 0; index--) pendingNodes.push(children[index]);
    }
  }
  // Mutation fanout: the DOM layer holds one _renderSurface pointer per
  // node (the primary); these broadcasts deliver the notification to every
  // live surface registered over the same root.
  _broadcastMutation(kind, node, detail) {
    const registry = this._root._renderSurfaces;
    if (!registry || registry.size <= 1) {
      this._recordMutation(kind, node, detail);
      return;
    }
    for (const surface of registry.values()) {
      surface._recordMutation(kind, node, detail);
    }
  }
  _broadcastDisconnectSubtree(node) {
    const registry = this._root._renderSurfaces;
    if (registry && registry.size > 1) {
      for (const surface of registry.values()) {
        if (surface !== this) surface._forgetSubtreeState(node);
      }
    }
    this._disconnectSubtree(node);
  }
  _broadcastReplaceAnimationBase(element, propertyName, target) {
    const registry = this._root._renderSurfaces;
    if (!registry || registry.size <= 1) {
      this._replaceAnimationBase(element, propertyName, target);
      return;
    }
    for (const surface of registry.values()) {
      surface._replaceAnimationBase(element, propertyName, target);
    }
  }
  get _mutationConsequence() {
    return this._frameCore.status(
      "frame_surface_consequence",
      this._frameOwner,
    );
  }

  // The frame flags are frame_loop_flags of these facts.
  _frameFlags(rasterize, deliverObservers, pixelReadback) {
    const document = this._root.ownerDocument;
    const style = document?._styleSystem;
    const core = this._frameCore;
    return core.status("frame_loop_flags", ...core.valueListInput([
      this._preparedState !== null ? 1 : 0,
      this._presentedFrame !== null ? 1 : 0,
      this._pendingScrollSources.size,
      this._animations.length,
      this._cssAnimations.size,
      this._pseudoContentAnimations.size,
      this._activeTransitionCount,
      this._pendingAnimationDeclarations.length,
      documentHasRenderingObservers(document) ? 1 : 0,
      this._pendingObserverDelivery ? 1 : 0,
      this._forceFullInvalidation ? 1 : 0,
      this._forceFullDamage ? 1 : 0,
      style !== undefined ? 1 : 0,
      this._serializedStyleGeneration ?? NaN,
      style?.generation ?? NaN,
      this._serializedViewportWidth ?? NaN,
      this.viewport.width,
      this._serializedViewportHeight ?? NaN,
      this.viewport.height,
      this._serializedViewportScale ?? NaN,
      this.viewport.deviceScale,
      rasterize ? 1 : 0,
      pixelReadback ? 1 : 0,
      this._persistentRenderer?.graphicsBackend === "webgl2" ? 1 : 0,
      this._lastRendered?.pixels ? 1 : 0,
      this._scrollAnchors.size,
      this._animations.some((animation) => animation._isScrollDriven()) ? 1 : 0,
      deliverObservers ? 1 : 0,
      this._lastBoxes.length,
      this._lastPixels !== null ? 1 : 0,
      this._frameSequence,
    ]));
  }

  // Frame mode 4: restyles the retained publication in place
  // (engine_record_restyle) instead of building the scene. Answers whether
  // it did; a frame it refuses builds the scene, and the refusal is counted
  // by its reason.
  _restyleRetainedPublication(core, frameViewport, styleSystem) {
    const counters = this._stageCounters;
    // Sampled before the restyle, as a serialization samples it before its
    // walk.
    const styleGeneration = styleSystem === undefined
      ? -1
      : styleSystem.generation;
    const refusal = core.status(
      "frame_restyle_retained",
      this._preparedState.serialized.publication,
      this._root._coreHandle,
      this._hasNonStateMutation ? 1 : 0,
      this._serializedViewportWidth ?? NaN,
      this._serializedViewportHeight ?? NaN,
      this._serializedViewportScale ?? NaN,
      frameViewport.width,
      frameViewport.height,
      frameViewport.deviceScale,
    );
    if (refusal !== ENGINE_RESTYLE_DONE) {
      const counter = SCENE_RESTYLE_REFUSALS.get(refusal);
      if (counter === undefined) {
        throw new Error(`frame_restyle_retained answered ${refusal}`);
      }
      counters[counter]++;
      return false;
    }
    this._serializedStyleGeneration = styleGeneration;
    counters.sceneRestyleFrames++;
    return true;
  }

  // The retained serialization after its publication was restyled in
  // place: the scene nodes of the restyled rows are copies, and a box that
  // declares transitions takes its new record copy (the renderer's
  // transition endpoint), since the previous one keeps the old.
  _restyledSerialization(core) {
    const previous = this._preparedState.serialized;
    const loweredRows = core.engineRecordLowered(previous.publication);
    const changedRows = core.engineRecordChanged(previous.publication);
    const nodes = previous.nodes.slice();
    for (const index of loweredRows) {
      const node = { ...nodes[index] };
      if (node._coreRecord !== undefined) {
        const box = previous.geometryBoxes[index];
        node._coreRecord = core.engineRecordAfterChange(box.stableId, box.sourceRevision);
      }
      nodes[index] = node;
    }
    return {
      ...previous,
      nodes,
      loweredRows,
      changedRows,
      reusedRows: core.engineRecordReused(previous.publication),
    };
  }

  _frameClaim(frame, expected, bindings = this._frameBindings) {
    const action = bindings.frame_next(frame);
    if (action !== expected) {
      throw new Error(
        `Frame executor expected ${expected}, received ${action}`,
      );
    }
    return bindings.frame_token(frame);
  }

  _frameResume(
    frame,
    token,
    facts = 0,
    depth = -1,
    bindings = this._frameBindings,
  ) {
    return bindings.frame_resume(frame, token, FRAME_OUTCOME_DONE, facts, depth);
  }

  // The core classifies the mutation and invalidates the surface
  // (frame_surface_mutation); the surface keeps the per-node sets and
  // performs the effects.
  _recordMutation(kind, node, detail) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const core = this._frameCore;
    const effects = core.status("frame_surface_mutation", this._frameOwner, FRAME_MUTATION_KINDS.get(kind),
      ...core.input(detail ?? ""));
    if (node && (effects & FRAME_MUTATION_EFFECT.MARK_NODE)) this._mutatedNodes.add(node);
    if (node && (effects & FRAME_MUTATION_EFFECT.TRANSFORM_ONLY)) this._transformOnlyMutations.add(node);
    else this._hasNonTransformMutation = true;
    if (effects & FRAME_MUTATION_EFFECT.NOT_RESTYLE_STATE) this._hasNonStateMutation = true;
    if (effects & FRAME_MUTATION_EFFECT.SELECTION) this._selectionChanged = true;
    if (effects & FRAME_MUTATION_EFFECT.FULL_INVALIDATION) this._forceFullInvalidation = true;
    if (effects & FRAME_MUTATION_EFFECT.SCROLL_SUPPRESS) {
      node._domCore.status("scroll_suppress", this._scrollOwner, node._coreHandle, ...node._domCore.input(detail));
    }
    // Frame listeners observe interaction state as well as pixels.
    if (effects & FRAME_MUTATION_EFFECT.DELIVER_STATE) this._forceStateDelivery = true;
    if (effects & FRAME_MUTATION_EFFECT.FORCE_GENERATION) this._forcedGenerationNodes.add(node);
    this._dirty = true;
    if (effects & FRAME_MUTATION_EFFECT.SNAP_CHECK) {
      this._preservedScrollMetrics = null;
      this._snapCheckOwed = true;
    }
    this._schedule();
  }

  _advanceSmoothScrolls(timeMilliseconds) {
    if (
      this._root._domCore.status(
        "scroll_step",
        this._scrollOwner,
        timeMilliseconds,
      )
    ) {
      this._dirty = true;
    }
  }

  _captureScrollRequests() {
    return new NativeScrollCapture(this);
  }

  // CSS Conditional 5 §7: each accepted frame snapshots the scroll state
  // of its query containers (container_scroll_state_set) in physical
  // directions, 1 left, 2 right, 4 top, 8 bottom, at the bit of each
  // state: whether it can scroll there, where its sticky offset holds it,
  // which axes snap to it, and its last relative scroll on each axis. A
  // changed state restyles the document in the next frame.
  _snapshotScrollStates(serialized, boxes, geometryHandle) {
    if (serialized.scrollStateContainers.length === 0) return;
    const core = this._root._domCore;
    const snapped = new Map();
    for (const [, { horizontal, vertical }] of this._snappedTargets) {
      if (horizontal) snapped.set(horizontal, (snapped.get(horizontal) ?? 0) | CONTAINER_SNAPPED_X);
      if (vertical) snapped.set(vertical, (snapped.get(vertical) ?? 0) | CONTAINER_SNAPPED_Y);
    }
    let changed = false;
    for (const { row, handle } of serialized.scrollStateContainers) {
      const box = boxes[row];
      if (box === undefined) continue;
      const element = core.wrapperFor(handle);
      const range = (field) => geometryHandle ? core.status("geometry_value", geometryHandle, handle, field) : 0;
      let scrollable = 0;
      if (box.scrollLeft > range(GEOMETRY_SCROLL_MIN_LEFT)) scrollable |= 1;
      if (box.scrollLeft < range(GEOMETRY_SCROLL_MAX_LEFT)) scrollable |= 2;
      if (box.scrollTop > range(GEOMETRY_SCROLL_MIN_TOP)) scrollable |= 4;
      if (box.scrollTop < range(GEOMETRY_SCROLL_MAX_TOP)) scrollable |= 8;
      const stuck = (box.stickyLeft > 0 ? 1 : box.stickyLeft < 0 ? 2 : 0) | (box.stickyTop > 0 ? 4 : box.stickyTop < 0 ? 8 : 0);
      const flags = scrollable * CONTAINER_SCROLLABLE_LEFT | stuck * CONTAINER_STUCK_LEFT | (snapped.get(element) ?? 0) |
        elementScrollRead(element, SCROLL_SCROLLED_DIRECTION) * CONTAINER_SCROLLED_LEFT;
      if (core.status("container_scroll_state_set", handle, flags) === 1) changed = true;
    }
    if (changed) {
      this._dirty = true;
      this._schedule();
    }
  }

  _acceptScrollFeedback(serialized, effectiveBoxes, requestGenerations) {
    const changed = [];
    for (const [target, { generation }] of requestGenerations) {
      const index = target === this.viewport
        ? serialized.viewportIndex
        : serialized.indexOf.get(target);
      const box = index == null ? null : effectiveBoxes[index];
      if (!box) continue;
      if (
        scrollCore(target).status(
          "scroll_accept",
          scrollState(target),
          generation,
          box.scrollLeft,
          box.scrollTop,
        )
      ) changed.push(target);
      if (!scrollRead(target, SCROLL_SMOOTH_PENDING)) this._pendingScrollSources.delete(target);
    }
    // A viewport no request moved this frame can still lose scroll range:
    // new content, a resize. Its presented box carries the engine's
    // clamped offset, which is what painted. Accept it, so scrollTop and
    // the next input step use that offset, and render again: this frame's
    // text and caret geometry, which pointer selection hit-tests, was built
    // at the old offset.
    const viewport = this.viewport;
    const viewportBox = requestGenerations.has(viewport)
      ? null
      : effectiveBoxes[serialized.viewportIndex];
    if (
      viewportBox && viewport._scrollState &&
      scrollCore(viewport).status(
        "scroll_surface_viewport_accept",
        scrollState(viewport),
        viewportBox.scrollLeft,
        viewportBox.scrollTop,
      )
    ) {
      changed.push(viewport);
      this._dirty = true;
      this._textGeometryStale = true;
      // Re-emit every row, so the rebuild frame captures every text
      // operation; a replayed emission captures none.
      this._forceFullInvalidation = true;
      this._forceFullDamage = true;
      this._schedule();
    }
    return changed;
  }

  // The focused text control's pending caret reveal runs over the presented
  // geometry (core/dom/text-control-scroll.watpart); the scroll it requests
  // paints in the next frame.
  _revealFocusedCaret(geometryHandle) {
    if (!geometryHandle) return;
    if (this._root._domCore.status("scroll_text_control_reveal", this._scrollOwner, geometryHandle, this._root._coreHandle)) {
      this._dirty = true;
      this._schedule();
    }
  }

  // The open suggestion popup of a text field takes its place over the
  // presented geometry (core/dom/datalist-popup.watpart): under or over its
  // field. A new place, or the end of the popup's measuring frame, paints
  // in the next frame.
  _placeSuggestionPopup(geometryHandle) {
    if (!geometryHandle) return;
    if (this._root._domCore.status("datalist_popup_place", this._scrollOwner, geometryHandle, this._root._coreHandle)) {
      this._dirty = true;
      this._schedule();
    }
  }

  _requestElementScroll(element, left, top, source, behavior = "instant") {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (!scrollRequest(element, left, top, behavior, source)) return;
    this._snapCheckPending = true;
    this._dirty = true;
    this._schedule();
  }

  _requestViewportScroll(left, top, source, behavior = "auto") {
    this._requestElementScroll(this.viewport, left, top, source, behavior);
  }

  _scrollViewport(left, top, source) {
    this._requestViewportScroll(left, top, source, "instant");
  }

  _requestDocumentAnimationFrame(callback, onDiscard = null) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const identifier = this._animationFrameCore.status(
      "animation_frame_request",
      this._animationFrameOwner,
    );
    this._animationFrameCallbacks.set(identifier, { callback, onDiscard });
    this._schedule();
    return identifier;
  }

  _cancelDocumentAnimationFrame(identifier) {
    if (this._shutdown) return;
    if (
      this._animationFrameCore.status(
        "animation_frame_cancel",
        this._animationFrameOwner,
        identifier,
      )
    ) {
      const record = this._animationFrameCallbacks.get(identifier);
      this._animationFrameCallbacks.delete(identifier);
      record.onDiscard?.();
    }
  }

  _releaseDocumentAnimationFrameCheckpoint(checkpoint) {
    const core = this._animationFrameCore;
    const owner = this._animationFrameOwner;
    for (;;) {
      const identifier = core.status(
        "animation_frame_checkpoint_abort_next",
        owner,
        checkpoint,
      );
      if (!identifier) break;
      const record = this._animationFrameCallbacks.get(identifier);
      this._animationFrameCallbacks.delete(identifier);
      record?.onDiscard?.();
    }
    core.status("animation_frame_checkpoint_release", owner, checkpoint);
  }

  // "Update animations and send events" (HTML, the rendering steps of a
  // frame, before its animation frame callbacks): the document timeline
  // takes the frame's time, so that the animations' current times follow
  // it in the animation frame callbacks (Web Animations 1, section 4.4.4),
  // and the replaced script animations leave the effect stack, each firing
  // `remove` (section 5.5), in composite order.
  _updateAnimationsAndSendEvents(timeMilliseconds) {
    if (this._shutdown) return;
    this._currentTime = timeMilliseconds;
    // The document's log keeps the time of a frame that follows its
    // entries, so a replay renders its frames at the same times
    // (core/dom/document-log.watpart document_log_frame).
    const document = this._root.nodeType === 9 ? this._root : this._root.ownerDocument;
    if (document) document._domCore.status("document_log_frame", document._coreHandle, timeMilliseconds);
    const removed = removeReplacedAnimations(this._animations, timeMilliseconds);
    if (removed.length === 0) return;
    const timelineTime = documentTimeline(this._root.ownerDocument)?.currentTime ?? null;
    const events = removed.map((animation) => {
      const currentTime = animation._core.status("animation_value", animation._animationId, ANIMATION_VALUE_CURRENT_TIME, timeMilliseconds);
      return createEventUsing(SDAnimationPlaybackEvent, "remove", {
        currentTime: Number.isNaN(currentTime) ? null : currentTime,
        timelineTime,
      });
    });
    for (let index = 0; index < removed.length; index++) {
      try {
        dispatchEvent(removed[index], events[index]);
      } catch (error) {
        this._reportBackgroundException(error);
      }
    }
  }

  // The animation frame callbacks of the frame, each followed by a microtask
  // checkpoint (HTML, "clean up after running script"): the promise
  // continuations of a callback run before the next callback and before the
  // frame's style update, so that they see and change the style that frame
  // renders.
  async _runDocumentAnimationFrameCheckpoint(timeMilliseconds) {
    const core = this._animationFrameCore;
    const owner = this._animationFrameOwner;
    const checkpoint = core.status("animation_frame_checkpoint_begin", owner);
    if (!checkpoint) return;
    try {
      for (;;) {
        const token = core.status(
          "animation_frame_checkpoint_next",
          owner,
          checkpoint,
        );
        if (!token) break;
        const identifier = core.status(
          "animation_frame_checkpoint_callback",
          owner,
          checkpoint,
          token,
        );
        const callback = this._animationFrameCallbacks.get(identifier).callback;
        this._animationFrameCallbacks.delete(identifier);
        try {
          callback(timeMilliseconds);
        } catch (error) {
          this._reportBackgroundException(error);
        } finally {
          core.status(
            "animation_frame_checkpoint_complete",
            owner,
            checkpoint,
            token,
          );
        }
        await microtaskCheckpoint();
      }
    } finally {
      this._releaseDocumentAnimationFrameCheckpoint(checkpoint);
    }
  }

  _recordViewportResize(previousEnvironment = null) {
    if (this._shutdown) throw new Error("render surface is shut down");
    this._viewportRevision++;
    this._frameCore.status("frame_surface_invalidate", this._frameOwner, FRAME_INVALIDATE_VIEWPORT);
    const registry = this._root._renderSurfaces;
    const nextEnvironmentKey =
      `${this.viewport.width}x${this.viewport.height}@${this.viewport.deviceScale}`;
    if (nextEnvironmentKey !== this._environmentKey) {
      const occupying = registry?.get(nextEnvironmentKey);
      if (occupying && occupying !== this) {
        throw new Error(
          `viewport resize: root already has a live render surface for ` +
            `environment ${nextEnvironmentKey}`,
        );
      }
      registry?.delete(this._environmentKey);
      registry?.set(nextEnvironmentKey, this);
      this._environmentKey = nextEnvironmentKey;
    }
    const densityOnlyResize = this._frameCore.exports.frame_resize_density_only(
      previousEnvironment?.width ?? NaN,
      previousEnvironment?.height ?? NaN,
      previousEnvironment?.deviceScale ?? NaN,
      this.viewport.width,
      this.viewport.height,
      this.viewport.deviceScale,
    ) !== 0;
    if (
      densityOnlyResize &&
      this._preservedScrollMetrics === null &&
      this._lastBoxes.length > 0
    ) {
      this._preservedScrollMetrics = this._lastBoxes.map((box) => ({
        scrollWidth: box.scrollWidth,
        scrollHeight: box.scrollHeight,
      }));
      for (const scrollbar of this._scrollbars) {
        const index = scrollbar.element === this.viewport
          ? 0
          : this._indexOfElement.get(scrollbar.element);
        if (index === undefined || index === null) continue;
        const metrics = this._preservedScrollMetrics[index];
        if (!metrics) continue;
        if (scrollbar.orientation === "vertical") {
          metrics.scrollHeight = scrollbar.scrollLength;
        } else {
          metrics.scrollWidth = scrollbar.scrollLength;
        }
      }
      this._lastBoxes = this._lastBoxes.map((box, index) => ({
        ...box,
        ...this._preservedScrollMetrics[index],
      }));
    } else if (!densityOnlyResize) {
      this._preservedScrollMetrics = null;
    }
    const ownerDocument = this._root.ownerDocument;
    ownerDocument?._styleSystem?.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
      scrollbarStyle: this.scrollbarStyle,
    });
    ownerDocument?._reevaluateMediaQueryLists?.();
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._pendingScrollSources.set(this.viewport, "resize");
    this._dirty = true;
    this._schedule();
  }

  /** Selects the CSS-px rectangle of the scene the raster target
   * covers, or the full scene with null. Raster-only: layout and the
   * display list are unaffected; the next frame re-rasters the region.
   */
  setVisibleRectangle(rectangle) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const core = this._root._domCore;
    const previous = this._visibleRectangle;
    const request = core.statusRaw("frame_visible_rectangle_request", ...core.valueListInput([
      previous?.x ?? null, previous?.y ?? null, previous?.width ?? null, previous?.height ?? null,
      ...(rectangle === null ? [null, null, null, null] : [rectangle?.x ?? NaN, rectangle?.y ?? NaN, rectangle?.width ?? NaN, rectangle?.height ?? NaN]),
    ]));
    if (request === FRAME_VISIBLE_RECTANGLE_SAME) return;
    this._visibleRectangle = rectangle === null ? null : {
      x: Number(rectangle.x),
      y: Number(rectangle.y),
      width: Number(rectangle.width),
      height: Number(rectangle.height),
    };
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._schedule();
  }

  /** Selects the node whose subtree the raster draws, as it draws in place
   * with its ancestors' clips, transforms, and group effects, or the whole
   * document with null. Raster-only: layout and the paint walk still cover
   * the document. A node with no scene row fails the next frame.
   */
  setSelectedRoot(node) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (node === this._selectedRoot) return;
    this._selectedRoot = node;
    if (node !== null) this._selectedLayer = null;
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._schedule();
  }

  /** Selects the compositing layer that the raster draws, by its paint
   * group index in the frame's paint record, with all it holds and the
   * clips and groups around it, or none with null. It replaces a selected
   * root. A layer past the frame's groups fails the next frame.
   */
  setSelectedLayer(layer) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (layer !== null && !(Number.isInteger(layer) && layer >= 0)) {
      throw new RangeError(`setSelectedLayer: a layer is a paint group index from 0, or null; received ${layer}`);
    }
    if (layer === this._selectedLayer) return;
    this._selectedLayer = layer;
    if (layer !== null) this._selectedRoot = null;
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._schedule();
  }

  // The selected root (setSelectedRoot) and layer (setSelectedLayer), the
  // visible rectangle (setVisibleRectangle), and the raster backdrop
  // (background; undefined for the renderer's default).
  get selectedRoot() {
    return this._selectedRoot;
  }

  get selectedLayer() {
    return this._selectedLayer;
  }

  get visibleRectangle() {
    return this._visibleRectangle;
  }

  get background() {
    return this._background;
  }

  /** Sets the raster backdrop: { r, g, b, a }, or undefined for the
   * renderer's default. The next frame rasters every tile. */
  setBackground(background) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const next = surfaceBackground(background, "setBackground");
    const previous = this._background;
    if (
      next?.r === previous?.r && next?.g === previous?.g &&
      next?.b === previous?.b && next?.a === previous?.a
    ) return;
    this._background = next;
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._schedule();
  }

  /** Tool overlay: paints `rectangles` above the document and its
   * scrollbars, as a browser's developer tools paint their highlight. Each
   * is { x, y, width, height, color: { r, g, b, a } } in viewport CSS
   * pixels, colour channels 0 to 1. An empty list paints none.
   */
  setToolHighlights(rectangles) {
    const core = this._root._domCore;
    core.statusRaw("frame_tool_highlights_check", Array.isArray(rectangles) ? 1 : 0, ...core.valueListInput([typeof rectangles]));
    this._toolHighlights = Object.freeze(rectangles.map((rectangle, index) => {
      const { x, y, width, height, color } = rectangle ?? {};
      const fields = [x, y, width, height, color?.r, color?.g, color?.b, color?.a];
      if (core.status("frame_tool_highlight_valid", ...core.valueListInput(fields)) !== 1) {
        core.statusRaw("frame_tool_highlight_error", index, ...core.valueListInput([String(JSON.stringify(rectangle))]));
      }
      return Object.freeze({ x, y, width, height, color: Object.freeze({ r: color.r, g: color.g, b: color.b, a: color.a }) });
    }));
    this._dirty = true;
    this._schedule();
  }

  /** Paged media: lays the document out in pages the size of the
   * viewport and shows page `index` (0 for the first). null shows the
   * continuous document. The engine decides every break
   * (design/fragmentation.md); `page` reports whether a later page follows.
   */
  setPage(index) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const core = this._root._domCore;
    // Entering or leaving paged media changes how the viewport scrolls and
    // takes a full frame (frame_page_request). Another page of a paged
    // document reuses the retained scene (frame mode 3): the renderer keeps
    // the rows the engine holds and seeks the page from the starts it
    // recorded while it counted the pages. The presented frame shows
    // another page, so it is not delivered again (_retainedDeliveryPossible).
    const request = core.statusRaw("frame_page_request", ...core.valueListInput([index, String(index), this._page]));
    if (request === 0) return;
    if (request & FRAME_PAGE_REQUEST_FULL) {
      this._forceFullInvalidation = true;
      this._forceFullDamage = true;
    }
    this._page = index;
    this._dirty = true;
    this._schedule();
  }

  /** The page the last frame showed, or null for a continuous frame:
   * { index, count, name, side, blank, groups, width, height, margin, area }.
   * count is the document's page count; name the page's name (CSS Paged
   * Media 3, 7.1; "" for the unnamed page); side "right" or "left" (the
   * first page is a right page); blank whether the page is left blank for a
   * side break; groups the page groups the page is in (CSS Generated Content
   * for Paged Media 3, 3.2), outermost first, each { name, position } with
   * the page's position in it from 1. width and height are the page box's size from the
   * document's @page rules (the viewport's when it declares none), margin
   * its page margins and area the page area inside them, where the page's
   * content lays out; all in CSS pixels. The frame's target is the page
   * box. */
  get page() {
    if (this._pageFrame === null) return null;
    return Object.freeze({ ...describePage(this._pageFrame), count: this._pageFrame.count });
  }

  /** Every page of the last page frame's count, in order, each as `page`
   * describes the page shown, without count; or null for a continuous
   * frame. */
  get pages() {
    if (this._pageFrame === null) return null;
    return Object.freeze(this._pageFrame.pages.map((page) => Object.freeze(describePage(page))));
  }

  /** The page of a point of a paged surface and the point on it: the
   * surface's coordinate space holds the page boxes one below the other,
   * their left edges aligned, with the page area of the page shown at
   * (0, 0), and every geometry operation answers in it
   * (src/dom/page-stack.js). Returns { page, x, y }, the point from that
   * page's page box top left corner in CSS pixels; a point above the first
   * page or below the last takes that page. null for a continuous frame. */
  pagePoint(x, y) {
    if (this._pageFrame === null) return null;
    return Object.freeze(pageOfPoint(this._pageFrame.pages, this._pageFrame.index, x, y));
  }

  /** pagePoint, inverted: the surface point of the point (x, y) on page
   * `page`, from its page box's top left corner, as { x, y }; null for a
   * continuous frame. */
  surfacePoint(page, x, y) {
    if (this._pageFrame === null) return null;
    return Object.freeze(pointOfPage(this._pageFrame.pages, this._pageFrame.index, page, x, y));
  }

  // The page option of a synchronous layout of the page this surface
  // shows, as a page frame's (renderOptions.page), for a viewport of
  // `viewport`'s size; null when it shows the continuous document.
  _syncPageOption(viewport) {
    if (this._page === null) return null;
    const rules = this._pageRules({ width: viewport.width, height: viewport.height });
    return {
      height: viewport.height,
      index: this._page,
      rulesKey: rules.key,
      box: (page) => pageBox(rules.rules, page, rules.defaultSize),
    };
  }

  // The document's @page rules for a page frame: parsed rules, a key that
  // changes with them and with the default page size, and that size (the
  // viewport's).
  _pageRules(defaultSize) {
    const rules = this._root.ownerDocument?._styleSystem?.pageRules() ?? [];
    const key = JSON.stringify([defaultSize.width, defaultSize.height, rules]);
    if (this._pageRuleCache?.key !== key) {
      const next = { rules: parsePageRules(rules), key, defaultSize };
      if (this._pageRuleCache) releasePageRules(this._pageRuleCache.rules);
      this._pageRuleCache = next;
    }
    return this._pageRuleCache;
  }

  // The raster region of a page frame: the page box, with the page area's
  // origin at the box's margins. The box is the one the last count gave the
  // page under the same rules; a page not counted yet takes its box from
  // its index alone, and a frame whose page box then differs renders again
  // (_pageTargetStale).
  _pageTargetRegion(index, pageRules) {
    const counted = this._pageBoxes !== null && this._pageBoxes.key === pageRules.key
      ? this._pageBoxes.pages[Math.min(index, this._pageBoxes.pages.length - 1)].box
      : undefined;
    const box = counted ?? pageBox(pageRules.rules, {
      index,
      name: "",
      side: this._root._domCore.string("frame_page_side", index),
      blank: false,
    }, pageRules.defaultSize);
    return { x: -box.margin.left, y: -box.margin.top, width: box.width, height: box.height };
  }

  // The page boxes of page `index` (src/dom/page-rules.js pageMarginBoxes:
  // its page-margin boxes and page background), or null for a continuous
  // frame or a page that generates none. The page, its box and its
  // counters come from the last count under the same rules; a page not
  // counted yet takes its description from its index alone and the count
  // from the index, and the frame then renders again (_pageTargetStale).
  _pageMarginBoxesFor(index, defaultSize) {
    if (index === null) return null;
    const pageRules = this._pageRules(defaultSize);
    const pages = this._pageBoxes !== null && this._pageBoxes.key === pageRules.key
      ? this._pageBoxes.pages
      : Array.from({ length: index + 1 }, (_, pageIndex) => ({
        index: pageIndex,
        name: "",
        side: this._root._domCore.string("frame_page_side", pageIndex),
        blank: false,
      }));
    const page = pages[Math.min(index, pages.length - 1)];
    const counters = pageCounters(pageRules.rules, pages);
    const boxes = pageMarginBoxes(pageRules.rules, page, { page: counters.values[page.index], pages: counters.pages },
      page.box ?? pageBox(pageRules.rules, page, pageRules.defaultSize));
    return boxes.every((box) => box.content === "none") ? null : boxes;
  }

  // Gives the DOM core the margin boxes `boxes` of this surface's root
  // (null for none). A paged surface gives them at every frame, as another
  // paged surface on the same core replaces them; the core skips a repeat.
  // Returns whether they differ from the ones this surface gave last.
  _applyPageMargins(core, boxes) {
    const key = JSON.stringify(boxes);
    if (boxes !== null || key !== this._pageMarginsKey) core.setPageMargins(this._root._coreHandle, boxes);
    if (key === this._pageMarginsKey) return false;
    this._pageMarginsKey = key;
    return true;
  }

  get _scrollMomentum() {
    return !!this._scrollOwner &&
      !!this._root._domCore.status("scroll_momentum_active", this._scrollOwner);
  }

  get _scrollMomentumTarget() {
    if (!this._scrollMomentum) return null;
    const node = this._root._domCore.status(
      "scroll_motion_target",
      this._scrollOwner,
      SCROLL_MOTION_MOMENTUM,
    );
    return node ? this._root._domCore.wrapperFor(node) : this.viewport;
  }

  get _scrollInteractionActive() {
    return !!this._scrollOwner &&
      !!this._root._domCore.status(
        "scroll_interaction_active",
        this._scrollOwner,
      );
  }

  get _scrollInteractionTarget() {
    if (!this._scrollInteractionActive) return null;
    const node = this._root._domCore.status(
      "scroll_motion_target",
      this._scrollOwner,
      SCROLL_MOTION_INTERACTION,
    );
    return node ? this._root._domCore.wrapperFor(node) : this.viewport;
  }

  // An input run executed scroll action `action` on this surface's scroll
  // owner (core/dom/input-run.watpart state 9): 7 chain and 11
  // scrollbar, which owe a frame and a snap check when they moved; 9 the
  // end of an interaction; 10 momentum, which owes frames while it runs.
  _inputScrolled(action, changed) {
    const effects = this._root._domCore.exports.scroll_surface_input_effect(action, changed ? 1 : 0);
    if (effects & SCROLL_INPUT_EFFECT_SNAP_CHECK) this._snapCheckPending = true;
    if (effects & SCROLL_INPUT_EFFECT_DIRTY) this._dirty = true;
    if (effects & SCROLL_INPUT_EFFECT_SCHEDULE) this._schedule();
  }

  _interruptScrolling() {
    this._smoothScrolls.clear();
  }

  _applyScrollAnchoring(serialized, boxes, capturedScrollRequests) {
    if (!this._scrollAnchors.size || !boxes.length) return false;
    return withScrollGeometry(
      this._root,
      this.viewport,
      boxes,
      serialized,
      (core, snapshot) => {
        const changed = !!core.status(
          "scroll_anchor_apply",
          this._scrollOwner,
          snapshot,
          capturedScrollRequests.handle,
        );
        if (!changed) return false;
        for (const [target, request] of capturedScrollRequests) {
          const index = target === this.viewport
            ? serialized.viewportIndex
            : serialized.indexOf.get(target);
          if (index == null) continue;
          serialized.nodes[index].scrollLeft = request.left;
          serialized.nodes[index].scrollTop = request.top;
          if (target !== this.viewport) this._mutatedNodes.add(target);
        }
        this._restateScroll(serialized, capturedScrollRequests);
        return true;
      },
    );
  }

  // The core's copy of a restatement: the publication's scroll record takes
  // the capture's requested offsets on the same rows, and `serialized`
  // names the row revision its rows now hold. A scene made from it passes
  // that revision to engine_direct_publish_scene; a scene made before a
  // later restatement holds other rows and goes through the host encoder.
  _restateScroll(serialized, capturedScrollRequests) {
    const publication = serialized.nodes[0]?._corePublication;
    if (publication === undefined) return;
    serialized.rowRevision = publication.core.status(
      "engine_record_scroll_restate",
      publication.handle,
      capturedScrollRequests.handle,
    );
  }

  _refreshScrollAnchors(serialized, boxes, geometryHandle) {
    const core = this._root._domCore;
    const focused = this._root._activeElement;
    const focusedHandle = focused &&
        core.status("scroll_surface_anchor_focus", ...core.valueListInput([nodeMember(focused, "localName")])) === 1
      ? focused._coreHandle
      : 0n;
    if (geometryHandle) {
      core.status(
        "scroll_anchor_refresh",
        this._scrollOwner,
        geometryHandle,
        this._root._coreHandle,
        focusedHandle,
      );
      return;
    }
    withScrollGeometry(
      this._root,
      this.viewport,
      boxes,
      serialized,
      (geometryCore, snapshot) =>
        geometryCore.status(
          "scroll_anchor_refresh",
          this._scrollOwner,
          snapshot,
          this._root._coreHandle,
          focusedHandle,
        ),
    );
  }

  // The elements of the rendered tree whose stored scroll-snap-type is not
  // none: the core's list over the records the last build resolved.
  _snapContainers() {
    const containers = [];
    for (
      const element of this._root._domCore.snapContainers(
        this._root._coreHandle,
      )
    ) {
      if (this._indexOfElement.has(element)) containers.push(element);
    }
    return containers;
  }

  // Whether the last build's tree has a snap container, counted once per
  // serialization: only a serialization writes the stored fields the list
  // reads.
  _snapContainersInLastBuild() {
    const build = this._stageCounters.serializations;
    if (this._snapContainersBuild !== build) {
      this._snapContainersPresent = this._snapContainers().length > 0;
      this._snapContainersBuild = build;
    }
    return this._snapContainersPresent;
  }

  _applyScrollSnapping() {
    // A pending check re-snaps every snap container of the tree, which is a
    // walk of every element; scroll_surface_snap_plan decides whether a
    // frame owes it. Scrollers already snapped or owing a snap take theirs
    // either way.
    const exports = this._root._domCore.exports;
    const facts = [
      this._scrollInteractionActive ? 1 : 0,
      this._scrollMomentum ? 1 : 0,
      this._presentedFrame?.geometryHandle ? 1 : 0,
      this._snapCheckPending ? 1 : 0,
    ];
    const stylesChanged = this._root.ownerDocument?._styleSystem?.generation !== this._serializedStyleGeneration ? 1 : 0;
    let plan = exports.scroll_surface_snap_plan(...facts, -1, stylesChanged);
    if (plan === SNAP_PLAN_NEEDS_CONTAINERS) {
      plan = exports.scroll_surface_snap_plan(...facts, this._snapContainersInLastBuild() ? 1 : 0, stylesChanged);
    }
    if (plan === SNAP_PLAN_NONE) return false;
    const walkTree = plan === SNAP_PLAN_WALK;
    if (walkTree) this._stageCounters.snapTreeWalks++;
    const changed = !!this._root._domCore.status(
      "scroll_snap_apply",
      this._scrollOwner,
      this._presentedFrame.geometryHandle,
      this._root._coreHandle,
      walkTree ? 1 : 0,
      0,
    );
    this._snapCheckPending = false;
    if (changed) {
      this._dirty = true;
      this._schedule();
    } else if (this._preparedState !== null) {
      // A snap that only changes the snapped targets renders nothing: the
      // presented frame's scroll state takes them now.
      this._snapshotScrollStates(this._preparedState.serialized, this._preparedState.boxes, this._presentedFrame.geometryHandle);
    }
    return changed;
  }

  _beginFrameTransaction(transaction) {
    if (this._frameTransaction && this._frameTransaction !== transaction) {
      throw new Error("Render surface already belongs to a frame transaction");
    }
    this._frameTransaction = transaction;
    transaction.surfaces.add(this);
  }

  get _candidatePresentedFrame() {
    return this._stagedFrame?.snapshot ?? this._presentedFrame;
  }

  _flushScrollEndEvents() {
    const core = this._root._domCore;
    const checkpoint = core.status("scroll_end_begin", this._scrollOwner);
    if (!checkpoint) return;
    try {
      for (;;) {
        const token = core.status("scroll_end_next", checkpoint);
        if (!token) break;
        const node = core.status("scroll_end_target", checkpoint, token);
        try {
          dispatchEvent(
            node ? core.wrapperFor(node) : this.viewport,
            createEvent("scrollend"),
          );
        } finally {
          core.status("scroll_end_ack", checkpoint, token);
        }
      }
    } finally {
      core.status("scroll_end_release", checkpoint);
    }
  }

  // A caret is on screen when the presented frame carries one. On an
  // injected clock the surface keeps asking for frames, the way a running
  // animation does, so the blink phase can flip. On the host's real clock
  // it asks for no frame until the phase flips: a host timer waits for
  // that moment (_caretWork). The frame that flips it changes nothing that
  // feeds serialization, so it reuses the retained scene.
  _caretBlinkActive() {
    return (this._frameCore.status("frame_caret_state", this._frameOwner, 0) & FRAME_CARET_ACTIVE) !== 0;
  }

  // The caret's share of the work a frame owes: FRAME_WORK_CARET while the
  // blink needs a frame now. On the real clock a caret whose phase flips
  // later arms one host timer for the flip, which schedules again.
  _caretWork() {
    if (!this._nowIsHostTime) return this._caretBlinkActive() ? FRAME_WORK_CARET : 0;
    const delay = this._frameCore.status("frame_caret_flip_delay", this._frameOwner, this._now());
    if (delay === 0) return FRAME_WORK_CARET;
    if (delay > 0 && this._caretTimer === null) {
      this._caretTimer = hostSetTimeout(() => {
        this._caretTimer = null;
        this._schedule();
      }, delay);
    }
    return 0;
  }

  _cancelCaretTimer() {
    if (this._caretTimer === null) return;
    hostClearTimeout(this._caretTimer);
    this._caretTimer = null;
  }

  // A held spin half of a number field steps again after a delay
  // (core/dom/input-number.watpart): its step is a task of the frame that
  // is due by then (_runSpinRepeat). With a host clock a timeout wakes the
  // loop for it; under a caller's clock each frame checks it.
  _spinWork() {
    const input = this._root.ownerDocument?._editingCommands;
    if (!input?.spinRepeatDelay || this._root._domCore.exports.input_spin_held() === 0) return 0;
    const delay = input.spinRepeatDelay(this._root, this._now());
    if (delay < 0) return 0;
    if (delay === 0 || !this._nowIsHostTime) return FRAME_WORK_TIMERS;
    if (this._spinTimer === null) {
      this._spinTimer = hostSetTimeout(() => {
        this._spinTimer = null;
        this._schedule();
      }, delay);
    }
    return 0;
  }

  _runSpinRepeat(timeMilliseconds) {
    this._root.ownerDocument?._editingCommands?.spinRepeat?.(this._root, timeMilliseconds);
  }

  _cancelSpinTimer() {
    if (this._spinTimer === null) return;
    hostClearTimeout(this._spinTimer);
    this._spinTimer = null;
  }

  _caretBlinkDue(timeMilliseconds) {
    return (this._frameCore.status(
      "frame_caret_state", this._frameOwner, timeMilliseconds,
    ) & FRAME_CARET_PHASE_CHANGED) !== 0;
  }

  // The CSS cursor the engine resolves at a document point, written to the
  // host's element. Called from input dispatch, which is the only moment
  // the answer can change: the pointer moved, or what is under it did.
  _applyCursor(x, y) {
    const target = this._cursorTarget;
    if (!target || this._shutdown || !this._presentedFrame) return;
    const cursor = this._presentedFrame.geometryCore.string(
      "input_pointer_cursor",
      this._presentedFrame.geometryHandle,
      x,
      y,
    );
    if (cursor === this._appliedCursor) return;
    this._appliedCursor = cursor;
    if (target.style) target.style.cursor = cursor;
  }

  // Input dispatch names the scrollbar descriptor under the pointer, or
  // null, and the bar whose thumb a pointer pressed (null on release,
  // undefined for no change). A change that paints differently (an overlay
  // bar shows, a thumb changes colour) requests a frame; that frame applies
  // it at its own time.
  _noteScrollbarPointer(scrollbar, pressed = undefined) {
    if (this._shutdown) return;
    if (this._scrollbarVisibility.notePointer(scrollbar, pressed)) {
      this._dirty = true;
      this._schedule();
    }
  }

  // Whether the loop requests a frame is frame_loop_schedule: the gates
  // first, then the work a frame owes. The frame's animation microtask
  // checkpoint belongs to the frame in flight.
  _schedule() {
    const exports = this._root._domCore.exports;
    const gates = (this._frameTransaction ? FRAME_GATE_TRANSACTION : 0) | (this._running ? 0 : FRAME_GATE_STOPPED) |
      (this._shutdown ? FRAME_GATE_SHUTDOWN : 0) |
      // The frame held after a presented change is requested while that
      // frame finishes: the host's next change lands in the next frame's
      // callbacks, which the request must already be in.
      ((this._rendering && !this._followFrame) || this._animationCheckpoint ? FRAME_GATE_RENDERING : 0) |
      (this._advancingDocumentClock ? FRAME_GATE_CLOCK_ADVANCING : 0) | (this._frameRequest !== null ? FRAME_GATE_REQUESTED : 0);
    if (exports.frame_loop_schedule(FRAME_LOOP_GATES, gates) === 0) return;
    const work =
      (this._animationFrameCore.status("animation_frame_pending", this._animationFrameOwner) ? FRAME_WORK_ANIMATION_FRAME : 0) |
      (this._dirty ? FRAME_WORK_DIRTY : 0) | this._caretWork() | this._spinWork() |
      (this._scrollbarVisibility.active ? FRAME_WORK_SCROLLBAR : 0) |
      (this._pendingScrollEndTargets.size > 0 ? FRAME_WORK_SCROLL_END : 0) | (this._snapCheckPending ? FRAME_WORK_SNAP_CHECK : 0) |
      (this._scrollInteractionActive ? FRAME_WORK_SCROLL_INTERACTION : 0) | (this._documentTimersAwaitFrame() ? FRAME_WORK_TIMERS : 0) |
      (this._followFrame ? FRAME_WORK_FOLLOW : 0);
    if (!exports.frame_loop_schedule(FRAME_LOOP_WORK, work)) return;
    const runFrame = (frameTimeMilliseconds) => {
      if (this._shutdown) return null;
      // A held spin half's due step is a task before the frame's rendering.
      this._runSpinRepeat(frameTimeMilliseconds);
      // The page timers that are due by the frame's time are tasks, and
      // tasks run before the frame's rendering steps.
      const advancing = this._advanceDocumentClock(frameTimeMilliseconds);
      if (advancing === null) return this._frame(frameTimeMilliseconds);
      this._advancingDocumentClock = true;
      return advancing
        .finally(() => {
          this._advancingDocumentClock = false;
        })
        .then(() => this._shutdown ? null : this._frame(frameTimeMilliseconds))
        .catch((error) => this._reportBackgroundException(error));
    };
    this._frameRequest = this._requestFrame((timeMilliseconds) => {
      this._frameRequest = null;
      const frameTimeMilliseconds = timeMilliseconds ?? this._now();
      // A held frame that arrives while the frame before it finishes runs
      // when that frame is done.
      if (this._rendering || this._animationCheckpoint) {
        return this.whenIdle().then(() => runFrame(frameTimeMilliseconds));
      }
      return runFrame(frameTimeMilliseconds);
    });
  }

  // The overlays that change with time alone: a caret whose blink phase
  // flips, and an overlay bar that starts or continues to fade or that a
  // pointer entered or left. Each makes the frame at `timeMilliseconds`
  // differ from the presented one without a DOM change.
  _markOverlaysDue(timeMilliseconds) {
    if (this._caretBlinkDue(timeMilliseconds)) this._dirty = true;
    if (this._scrollbarVisibility.due(timeMilliseconds)) this._dirty = true;
  }

  // The rendering steps of one loop-scheduled frame.
  async _frame(frameTimeMilliseconds) {
    // The style update at the start of a frame checks the focus (focus
    // fixup, input-activation.js), before the animation frame callbacks.
    scheduleFocusFixup(this._root);
    // Native snapshots detach before invoking. Exceptions still reach the
    // realm sink without preventing the remaining callbacks or the render.
    this._updateAnimationsAndSendEvents(frameTimeMilliseconds);
    // The callbacks and their microtask checkpoints belong to this
    // rendering update, a task of its own: the document's queued tasks
    // (timers among them) wait until it is done.
    const scripts = this._root.ownerDocument?._scriptProcessing ?? null;
    scripts?.enterTask();
    try {
      await this._runDocumentAnimationFrameCheckpoint(frameTimeMilliseconds);
    } finally {
      scripts?.leaveTask();
    }
    if (this._shutdown) return null;
    this._markOverlaysDue(frameTimeMilliseconds);
    // A frame held after a presented change (_followFrame) may run before
    // the host's own animation frame callback of the same frame, where the
    // host makes its next change: it looks again after one task, which
    // runs after all of this frame's callbacks.
    if (!this._dirty && this._followFrame) {
      await microtaskCheckpoint();
      if (this._shutdown) return null;
    }
    if (!this._dirty) {
      // A held frame that found no change releases the hold: the loop
      // idles until the next one.
      this._followFrame = false;
      if (this._applyScrollSnapping()) return null;
      this._flushScrollEndEvents();
      this._schedule();
      return null;
    }
    const forceStateDelivery = this._forceStateDelivery;
    this._forceStateDelivery = false;
    // Nothing awaits a loop-scheduled render (the host animation frame
    // discards this return value), so a rejection here is otherwise an
    // unobserved promise rejection: a crash in Deno, silence in a
    // browser worker. Route it to the exception sink.
    // A frame that fails leaves the surface dirty, so the loop would render
    // and fail again every frame. After three failures in a row the loop
    // stops and reports why; start() resumes it.
    // The frame the loop renders: only its presentation holds the next
    // frame (FRAME_WORK_FOLLOW); a host that calls renderNow drives its
    // own frames.
    this._loopFrameRendering = true;
    return this._renderOpportunity(
      frameTimeMilliseconds,
      forceStateDelivery,
    ).finally(() => {
      this._loopFrameRendering = false;
    }).then((result) => {
      this._failedLoopFrames = 0;
      return result;
    }, (error) => {
      const failures = this._root._domCore.exports.frame_loop_failure(this._failedLoopFrames ?? 0);
      if (failures === FRAME_LOOP_STOP) {
        this._failedLoopFrames = 0;
        this.stop();
        const core = this._root._domCore;
        this._reportBackgroundException(new Error(
          core.string("frame_loop_stop_message", ...core.valueListInput([String(error?.message ?? error)])),
          { cause: error },
        ));
        return;
      }
      this._failedLoopFrames = failures;
      this._reportBackgroundException(error);
    });
  }

  // The document clock of this surface's own clock, for a document that
  // fixes its clock while this surface drives it (fixDocumentClock).
  _clockForDocument() {
    return new DocumentClock({
      now: this._now,
      requestFrame: this._requestFrame,
      cancelFrame: this._cancelFrame,
      timeOrigin: sharedDomCore.exports.frame_clock_surface_origin(this._nowIsHostTime ? 1 : 0, hostTimeOrigin),
      real: this._nowIsHostTime,
    });
  }

  // Whether this surface's frames drive the document's page: it is the
  // document's surface, and it runs on the document's clock.
  _drivesDocumentClock() {
    const document = this._root.ownerDocument;
    return document?._componentRenderSurface === this &&
      (!document._clock || document._clock.source.now === this._now);
  }

  // Whether this surface's frames come now (frame_clock_surface_frames).
  // While they do not, the document's page timers ask the document
  // clock's frame source for frames themselves.
  _framesAdvanceDocumentClock() {
    return !!sharedDomCore.exports.frame_clock_surface_frames(FRAME_CLOCK_FRAMES_NOW, this._shutdown ? 1 : 0, this._running ? 1 : 0,
      this._capturingFrames ? 1 : 0, 0, 0, 0);
  }

  // A frame or capture sample of this surface at `timeMilliseconds`: when it
  // drives the document, the document's time reaches the frame's time, and
  // the page timers due by then run first. Null when none is due, else a
  // promise that settles after they ran.
  _advanceDocumentClock(timeMilliseconds) {
    if (!this._drivesDocumentClock()) return null;
    const document = this._root.ownerDocument;
    document._clock?.frame(timeMilliseconds);
    return document._documentTimers?.advance() ?? null;
  }

  // An injected clock advances only through frames, so while this surface
  // drives the document, a pending page timer keeps a frame requested
  // (frame_clock_surface_frames).
  _documentTimersAwaitFrame() {
    const document = this._root.ownerDocument;
    return !!sharedDomCore.exports.frame_clock_surface_frames(FRAME_CLOCK_TIMERS_AWAIT_FRAME, 0, 0, 0,
      document?._clock?.real === false ? 1 : 0, this._drivesDocumentClock() ? 1 : 0,
      document?._documentTimers?.hasPending ? 1 : 0);
  }

  // Background exceptions (animation-frame callbacks, loop-scheduled
  // renders) have no awaiting caller. A component session installs a
  // sink on its document and fails loudly through the session API; any
  // other host falls back to the realm's reportError so the error
  // surfaces instead of vanishing.
  _reportBackgroundException(error) {
    const ownerDocument = this._root.ownerDocument;
    const report = ownerDocument?._reportException;
    if (report) {
      report(error);
      return;
    }
    if (typeof globalThis.reportError === "function") {
      globalThis.reportError(error);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  _scheduleObserverFrame() {
    this._pendingObserverDelivery = true;
    this._dirty = true;
    this._schedule();
  }

  // The presented frame is reusable verbatim when the scene is retained
  // (frame mode 3: the serialization inputs and the viewport are unchanged,
  // no pending scroll, no forced invalidation) AND nothing the scene reuse
  // does not already cover changed: no host-state/selection/canvas
  // consequence, no mutated or forced-generation node, no animation or
  // transition sampling this frame, the same resources, the same capture
  // requirements, the same page, and a retained raster result to
  // re-deliver. A pixel capture and a staged transaction always render.
  _retainedDeliveryPossible(
    cleanSceneReuse,
    pixelReadback,
    sourceRevisions,
    mutatedNodes,
    forcedGenerationNodes,
    capturedScrollRequests,
    continuation,
  ) {
    const rendered = this._lastRendered;
    const presented = this._presentedFrame;
    const facts = (cleanSceneReuse ? FRAME_RETAINED_CLEAN_SCENE_REUSE : 0) | (pixelReadback ? FRAME_RETAINED_PIXEL_READBACK : 0) |
      (this._renderedPage === this._page ? FRAME_RETAINED_CURRENT_PAGE : 0) |
      (this._pageTargetStale ? FRAME_RETAINED_PAGE_TARGET_STALE : 0) |
      (this._toolHighlightsRendered === this._toolHighlights ? FRAME_RETAINED_CURRENT_TOOL_HIGHLIGHTS : 0) |
      (this._frameTransaction === null ? FRAME_RETAINED_NO_TRANSACTION : 0) |
      (rendered !== null ? FRAME_RETAINED_RENDERED : 0) | (presented !== null ? FRAME_RETAINED_PRESENTED : 0) |
      (this._lastDeliveredFrame !== null ? FRAME_RETAINED_DELIVERED : 0) |
      (mutatedNodes.size === 0 && forcedGenerationNodes.size === 0 && capturedScrollRequests.size === 0
        ? FRAME_RETAINED_UNCHANGED_INPUTS : 0) |
      (this._hasActiveAnimationWork() ? FRAME_RETAINED_ANIMATION_WORK : 0) | (this._scrollMomentum ? FRAME_RETAINED_MOMENTUM : 0) |
      (rendered?.animationActive ? FRAME_RETAINED_RESULT_ANIMATES : 0) |
      (this._pendingAnimationDeclarations.length === 0 ? FRAME_RETAINED_NO_PENDING_DECLARATIONS : 0) |
      (rendered !== null && (rendered.paintArtifact !== undefined || rendered.textCapture !== undefined)
        ? FRAME_RETAINED_RESULT_ARTIFACT : 0) |
      (this._capturePaintArtifact || (this._textSelectionEnabled && this._preparedState?.serialized.textBoxes > 0)
        ? FRAME_RETAINED_WANTS_ARTIFACT : 0) |
      (rendered?.pixels !== undefined ? FRAME_RETAINED_RESULT_PIXELS : 0) |
      (this._persistentRenderer?.graphicsBackend === "webgl2" ? FRAME_RETAINED_WEBGL2 : 0);
    return !!this._frameCore.status(
      "frame_retained_delivery",
      continuation,
      presented?.geometryHandle ?? 0n,
      sourceRevisions.resource,
      facts,
    );
  }

  _notifyFrameListeners(frame, resizeObserverLoopError) {
    const errors = [];
    for (const listener of [...this._frameListeners]) {
      try {
        listener(frame);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} render-surface frame listener(s) threw`,
      );
    }
    if (resizeObserverLoopError) {
      throw new Error(
        "ResizeObserver loop completed with undelivered notifications",
      );
    }
  }

  // A transition the renderer declared for this frame's scene enters the
  // registry as it is declared, before any of its own events: a reversal
  // of a transition that has not progressed has no duration left, and it
  // starts and ends in the tick of the frame that declares it. Its
  // CSSTransition takes over the track the renderer declared; the
  // transitions one frame declares share a transition generation. A
  // pending CSSTransition that a read created for the same change is that
  // object; when a script cancelled it, the change starts no transition.
  _registerStartedTransition(transition) {
    const target = this._eventTargetAtIndex[transition.nodeIndex];
    if (!target) return;
    const element = isPseudoElementTarget(target) ? target.element : target;
    this._transitionTimings.get(target)?.get(transition.propertyName)?.animation
      ?._settleReplaced();
    const held = this._frameHeldTransitions?.get(target)?.get(transition.propertyName);
    this._frameHeldTransitions?.get(target)?.delete(transition.propertyName);
    if (held?.playState === "idle") {
      transition.engineHandle.cancelSilently();
      return;
    }
    const timing = {
      duration: transition.duration,
      delay: transition.delay,
      easing: transition.easing,
      startTimeMilliseconds: transition.startTime,
      startValue: transition.startValue,
      endValue: transition.endValue,
      trackStartValue: transition.trackStartValue,
      animationId: transition.animationId,
      engineHandle: transition.engineHandle,
    };
    if (held === undefined) {
      timing.animation = new CSSTransition(
        this,
        target,
        transition.propertyName,
        timing,
        this._frameSequence,
      );
    } else {
      timing.animation = held;
      held._adoptDeclaredTrack(timing, this._frameSequence);
    }
    this._registerTransitionAnimation(timing.animation);
    // css-transitions-1 section 6.1: a created transition reports
    // transitionrun, with the time its delay skipped.
    dispatchEvent(element, createEvent("transitionrun", {
      bubbles: true,
      propertyName: transition.propertyName,
      elapsedTime: Math.min(Math.max(-transition.delay, 0), transition.duration) / 1000,
      pseudoElement: isPseudoElementTarget(target) ? target.pseudoElement : "",
    }));
  }

  // The identity and timing that the frame declares the track of a pending
  // CSSTransition with: the transition's start time resolves at this
  // frame (Web Animations 1, section 4.4.4), and the track runs at the
  // start time, playback rate and generation that the object then holds.
  // Null when no running pending transition holds the change.
  _heldTransitionDeclaration(nodeIndex, propertyName) {
    const target = this._eventTargetAtIndex[nodeIndex];
    const animation = target ? this._frameHeldTransitions?.get(target)?.get(propertyName) : undefined;
    if (animation === undefined || animation.playState === "idle") return null;
    animation._resolveTimeline();
    return {
      animationId: animation._animationId,
      trackGeneration: animation._value(ANIMATION_VALUE_TRACK_GENERATION),
      timing: {
        startTime: animation._value(ANIMATION_VALUE_ENGINE_START_TIME),
        duration: animation._value(ANIMATION_VALUE_DURATION),
        delay: animation._value(ANIMATION_VALUE_DELAY),
        direction: animation._value(ANIMATION_VALUE_REVERSED) ? "reverse" : "normal",
      },
    };
  }

  // Whether an element of the presented scene declares a transition that
  // starts in computed resolution (transitionCoversAnimationDependency).
  _declaresDependencyTransitions() {
    const nodes = this._preparedState?.serialized?.nodes;
    if (!nodes) return false;
    return nodes.some((node) => node.transitionDefinitions?.some(({ propertyName }) =>
      transitionCoversAnimationDependency(propertyName)));
  }

  // A read between frames that updates the style (getComputedStyle, a
  // geometry read, getAnimations()) runs the style change event of that
  // update (CSS Animations 1, CSS Transitions 1): the CSS animations and
  // the transitions that the style change since the last frame starts
  // exist from then on, and stay pending until the next frame starts
  // them. A read under the style generation and frame of the last update
  // has nothing new to start.
  _startStyleChangeAnimations() {
    if (this._shutdown || this._rendering) return;
    const styleSystem = this._root.ownerDocument?._styleSystem;
    if (!styleSystem) return;
    const key = this._styleChangeAnimationsKey;
    if (key?.frameSequence === this._frameSequence && key.styleGeneration === styleSystem.generation) return;
    this._prepareStyleSystem(styleSystem);
    this._synchronizeCSSAnimations(this._frameCore, styleSystem, null);
    this._planPendingTransitions(styleSystem);
    this._styleChangeAnimationsKey = { frameSequence: this._frameSequence, styleGeneration: styleSystem.generation };
  }

  // Multi-environment coexistence: serialization and style-driven
  // animation sync read styles under THIS surface's viewport environment.
  // setEnvironment bumps the style generation only on an actual change,
  // so the single-surface path stays free.
  _prepareStyleSystem(styleSystem) {
    styleSystem.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
      scrollbarStyle: this.scrollbarStyle,
    });
    // Answered before any element of the update resolves, and before the
    // style generation is sampled (answers can advance it).
    styleSystem.answerDeclaredFontFamilies(this._root);
  }

  // The animation-definition reconciliation resolves definitions for the
  // elements whose cascade names an animation. Its inputs are exactly the
  // style system's cascade output plus tree membership, and every change
  // to either bumps the style generation - the same key the per-element
  // resolution cache trusts. An unchanged generation owes no scan.
  // Recorded BEFORE the scan: a scan whose side effects mutate the DOM
  // re-scans next frame. The core lists the candidates
  // (animation_candidates: a native walk over its resolved records); an
  // element that stopped being one has its animations cancelled here,
  // exactly as an empty definition list would. Without a @keyframes rule
  // in a scope of the root's tree (the document's or a shadow root's) no
  // element has a definition, so the walk, which
  // resolves every element, is skipped and every element counts as a
  // non-candidate. A frame passes its time; a read between frames passes
  // null: its CSS animations are pending (_createAnimation), and its
  // ::before and ::after content animations start at the next frame.
  _synchronizeCSSAnimations(core, styleSystem, timeMilliseconds) {
    if (this._animationSyncStyleGeneration === styleSystem.generation) return;
    this._animationSyncStyleGeneration = styleSystem.generation;
    core.mediaEnvironmentSet(styleSystem.environment);
    // Keyframes that follow their element follow the style change.
    for (const animation of this._animations) animation._refreshElementDependentKeyframes();
    const declaresKeyframes = styleSystem.treeDeclaresKeyframes(this._root);
    const activeElements = new Set(
      declaresKeyframes
        ? core.animationCandidates(this._root._coreHandle, 0)
        : [],
    );
    // Resolving natively can raise font-family requests; answering them
    // bumps the style generation, which must land before serialization
    // samples its checkpoint or the next frame re-serializes for nothing.
    styleSystem.answerFontFamilyRequests();
    for (const [element, records] of this._cssAnimations) {
      if (activeElements.has(element)) continue;
      for (const record of records) record.animation._cancelByUserAgent();
      this._cssAnimations.delete(element);
    }
    for (const element of activeElements) {
      const previousRecords = this._cssAnimations.get(element) ?? [];
      // The core plans which previous animations continue, are updated in
      // place or are cancelled, and which definitions create one
      // (animation_css_plan).
      const { desired, cancelled } = planCSSAnimations(
        element,
        styleSystem.animationDefinitions(element),
        previousRecords,
      );
      // The places of the previous animations in the surface's list before
      // the cancellations; an idle one has none.
      const previousPositions = previousRecords.map((record) => this._animations.indexOf(record.animation));
      for (const record of cancelled) record.animation._cancelByUserAgent();

      const nextRecords = desired.map((record) =>
        record.retained < 0 ? null : { ...record, animation: previousRecords[record.retained].animation }
      );
      for (let definitionIndex = 0; definitionIndex < desired.length; definitionIndex++) {
        const record = desired[definitionIndex];
        if (record.kind === CSS_PLAN_KEEP) {
          nextRecords[definitionIndex] = previousRecords[record.retained];
          continue;
        }
        if (record.kind === CSS_PLAN_UPDATE) {
          const retained = previousRecords[record.retained];
          retained.animation._updateFromStyle(record.definition, retained.definition);
          continue;
        }
        const { insertionIndex, before } = placeCSSAnimation(
          definitionIndex,
          desired,
          nextRecords.map((next) => next ? this._animations.indexOf(next.animation) : -1),
          previousPositions,
          this._animations.length,
        );
        const animation = this._createAnimation(
          element,
          record.definition.keyframes,
          cssAnimationTiming(record.definition),
          {
            insertionIndex,
            beforeEngineHandles: before.map((index) => nextRecords[index].animation._engineHandle),
            diagnosticAnimationName: record.definition.name,
            implicitKeyframe: record.definition.implicitKeyframe,
          },
        );
        animation._followPlayState(false, record.definition.paused);
        nextRecords[definitionIndex] = { ...record, animation };
      }
      for (let recordIndex = 0; recordIndex < nextRecords.length; recordIndex++) {
        nextRecords[recordIndex].animation._engineDeclarationOptions.beforeEngineHandles = nextRecords
          .slice(recordIndex + 1).map((record) => record.animation._engineHandle);
      }
      if (nextRecords.length === 0) {
        this._cssAnimations.delete(element);
        continue;
      }
      // The core gives the element's live CSS animations their places in
      // the surface's list (animation_css_slots).
      const slots = cssAnimationSlots(nextRecords.map((record) => this._animations.indexOf(record.animation)));
      for (let recordIndex = 0; recordIndex < nextRecords.length; recordIndex++) {
        if (slots[recordIndex] >= 0) this._animations[slots[recordIndex]] = nextRecords[recordIndex].animation;
      }
      this._cssAnimations.set(element, nextRecords);
    }

    const nextPseudoContentAnimations = new Map();
    for (const pseudoElement of ["::before", "::after"]) {
      if (!declaresKeyframes) break;
      for (
        const element of core.animationCandidates(
          this._root._coreHandle,
          pseudoElement === "::before" ? 1 : 2,
        )
      ) {
        const contentDefinitions = styleSystem.animationDefinitions(
          element,
          pseudoElement,
        ).filter((definition) => {
          const propertyNames = new Set(definition.keyframes.flatMap(keyframePropertyNames));
          return propertyNames.size === 1 && propertyNames.has("content");
        });
        if (contentDefinitions.length === 0) continue;
        const unsupportedContentDefinition = contentDefinitions.find((
          definition,
        ) => definition.composition !== "replace");
        if (unsupportedContentDefinition) {
          const cause = new TypeError(
            "content only supports replace composition",
          );
          throw new TypeError(
            `CSS animation "${unsupportedContentDefinition.name}" declaration failed: ${cause.message}`,
            { cause },
          );
        }
        const previousContentRecords =
          this._pseudoContentAnimations.get(element)
            ?.get(pseudoElement) ?? [];
        const desiredRecords = reconcileAnimationDefinitions(
          contentDefinitions,
          previousContentRecords,
        );
        // The core gives each record its start time and held time
        // (animation_content_times): a record of the same name and
        // occurrence continues with the new definition.
        const nextRecords = desiredRecords.map((desired) => {
          if (desired.reusable) return desired.reusable;
          const { previous, reusable: _reusable, ...retained } = desired;
          const times = contentAnimationTimes(previous, desired.definition.paused, timeMilliseconds, this._currentTime);
          return { ...retained, element, pseudoElement, ...times };
        });
        let pseudoElements = nextPseudoContentAnimations.get(element);
        if (!pseudoElements) {
          pseudoElements = new Map();
          nextPseudoContentAnimations.set(element, pseudoElements);
        }
        pseudoElements.set(pseudoElement, nextRecords);
      }
    }
    this._pseudoContentAnimations = nextPseudoContentAnimations;
  }

  // The transitions that the style change since the last frame starts,
  // planned by the renderer from the last rendered scene and a scene of
  // the current style, as pending CSSTransitions. A transition planned
  // again for the same change stays the same object; one that a later
  // change no longer starts is cancelled. The read serializes the tree
  // only: it lays nothing out, so the geometry that later reads answer
  // from stays the frame's.
  //
  // A read is a style change event (CSS Transitions 1, "before-change
  // style"): an element that the last frame did not render keeps, in
  // _readBaselines, its style at the last read that started none of its
  // transitions, whether or not it declared transitions then. Once a read
  // starts transitions the baseline stays until the next frame renders the
  // element: later reads plan the same transitions, and the frame plans
  // from the same baseline, so it declares the transitions the reads held.
  _planPendingTransitions(styleSystem) {
    const renderer = this._persistentRenderer;
    if (!renderer) return;
    const core = this._frameCore;
    const generation = styleSystem.generation;
    if (generation === this._serializedStyleGeneration) return;
    const key = this._pendingTransitionsKey;
    if (key?.frameSequence === this._frameSequence && key.styleGeneration === generation) return;
    this._pendingTransitionsKey = { frameSequence: this._frameSequence, styleGeneration: generation };
    this._dropPlannedSerialization();
    const viewport = this.viewport;
    const serialized = serializeToScene(this._root, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        deviceScale: viewport.deviceScale ?? 1,
        density: viewport.density,
        _requestedLeft: viewport._requestedLeft,
        _requestedTop: viewport._requestedTop,
      },
    });
    const planned = new Map();
    let planningComplete = false;
    try {
      const targetAtRow = targetsAtRow(serialized.indexOf, serialized.pseudoIndexOf);
      const nodes = serialized.nodes;
      for (let index = 0; index < nodes.length; index++) {
        const target = targetAtRow[index];
        if (target === undefined || (!isPseudoElementTarget(target) && target.nodeType !== 1)) continue;
        const node = nodes[index];
        const previousIndex = this._targetIndex(target);
        let transitions = [];
        if (previousIndex !== undefined) {
          if (!node.transitionDefinitions?.length) continue;
          transitions = renderer.planStyleChangeTransitions(previousIndex, node);
        } else {
          const baseline = this._readBaselines.get(target);
          if (baseline !== undefined && node.transitionDefinitions?.length) {
            transitions = renderer.planTransitionsFrom(baseline, node);
          }
          if (baseline === undefined || (transitions.length === 0 && !this._pendingTransitions.has(target))) {
            this._readBaselines.set(target, readBaseline(node, target));
          }
        }
        if (transitions.length > 0) {
          planned.set(target, new Map(transitions.map((transition) => [transition.propertyName, transition])));
        }
      }
      planningComplete = true;
    } finally {
      // The layout read that started this planning lays out the same tree
      // next (computeLayoutBoxes): it takes this serialization while the
      // document's revisions hold (_takePlannedSerialization).
      if (planningComplete && this._page === null && this._pseudoContentAnimations.size === 0) {
        const domCore = this._root._domCore;
        this._plannedSerialization = {
          serialized,
          styleGeneration: domCore.status("document_style_generation", this._root.ownerDocument._coreHandle) >>> 0,
          resourceRevision: domCore.status("resource_revision") >>> 0,
          width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale ?? 1,
          requestedLeft: viewport._requestedLeft, requestedTop: viewport._requestedTop,
        };
      } else {
        serialized.release();
        core.releaseSceneResources(serialized.nodes);
      }
    }
    for (const [element, transitions] of this._pendingTransitions) {
      for (const [propertyName, animation] of transitions) {
        const transition = planned.get(element)?.get(propertyName);
        if (transition !== undefined && animation._styleChangePlan === transitionPlanKey(transition)) {
          planned.get(element).delete(propertyName);
          continue;
        }
        transitions.delete(propertyName);
        animation.cancel();
      }
      if (transitions.size === 0) this._pendingTransitions.delete(element);
    }
    for (const [target, transitions] of planned) {
      for (const [propertyName, transition] of transitions) {
        const record = {
          duration: transition.definition.duration,
          delay: transition.definition.delay,
          easing: transition.definition.easing,
          startTimeMilliseconds: NaN,
          startValue: transition.startValue,
          endValue: transition.endValue,
          trackStartValue: transition.startValue,
        };
        record.animation = new CSSTransition(this, target, propertyName, record, this._frameSequence);
        record.animation._styleChangePlan = transitionPlanKey(transition);
        let held = this._pendingTransitions.get(target);
        if (held === undefined) {
          held = new Map();
          this._pendingTransitions.set(target, held);
        }
        held.set(propertyName, record.animation);
        this._scheduleAnimationFrame(record.animation._element);
      }
    }
  }

  // The pending transitions a frame did not declare: a later style change
  // that no read saw no longer starts them, and it cancels them.
  _cancelUndeclaredTransitions() {
    const held = this._frameHeldTransitions;
    this._frameHeldTransitions = null;
    for (const transitions of held?.values() ?? []) {
      for (const animation of transitions.values()) animation.cancel();
    }
  }

  // Whether an animation, a CSS animation, an animated ::before or ::after
  // content, a transition or a declared animation that awaits its first
  // frame runs on this surface.
  _animating() {
    return this._animations.length + this._cssAnimations.size + this._pseudoContentAnimations.size +
      this._activeTransitionCount + this._pendingAnimationDeclarations.length > 0;
  }

  // The registry holds each running or paused transition of an element
  // under its property; one whose property a newer transition took stays
  // out.
  _registerTransitionAnimation(animation) {
    const target = animation._target;
    const propertyName = animation._transitionProperty;
    let timings = this._transitionTimings.get(target);
    if (!timings) {
      timings = new Map();
      this._transitionTimings.set(target, timings);
    }
    if (timings.has(propertyName)) return;
    timings.set(propertyName, animation._transitionRecord);
    let records = this._transitionRecords.get(target);
    if (!records) {
      records = new Map();
      this._transitionRecords.set(target, records);
    }
    records.set(propertyName, animation._transitionRecord);
    this._activeTransitionCount++;
  }

  _unregisterTransition(animation) {
    const target = animation._target;
    const timings = this._transitionTimings.get(target);
    if (timings?.get(animation._transitionProperty)?.animation !== animation) return;
    timings.delete(animation._transitionProperty);
    const records = this._transitionRecords.get(target);
    records?.delete(animation._transitionProperty);
    if (records?.size === 0) this._transitionRecords.delete(target);
    if (this._activeTransitionCount > 0) this._activeTransitionCount--;
  }

  // The animations getAnimations() chooses from: this surface's animations,
  // its registered transitions and its pending transitions. A pending
  // transition takes the place of the registered transition of its
  // property: the style change that started it cancels that one.
  _animationCandidates() {
    const candidates = [...this._animations];
    for (const [element, records] of this._transitionRecords) {
      const pending = this._pendingTransitions.get(element);
      for (const [propertyName, record] of records) {
        if (!pending?.has(propertyName)) candidates.push(record.animation);
      }
    }
    for (const transitions of this._pendingTransitions.values()) {
      candidates.push(...transitions.values());
    }
    return candidates;
  }

  // Creates the persistent renderer at the viewport's size. A document whose
  // canvases have no device yet takes the renderer's: a Canvas 2D toBlob()
  // while the renderer starts waits for it (_preferredCanvasDevicePending)
  // instead of requesting a second device.
  _startPersistentRenderer({ width, height, deviceScale }) {
    const renderer = this._createPersistentRenderer({
      width,
      height,
      deviceScale,
      ...this._persistentRendererOptions,
    });
    if (typeof renderer?.then === "function" || typeof renderer?.ready?.then !== "function") {
      throw new TypeError(
        "createPersistentRenderer must return a renderer at once with a `ready` promise, as openSceneRenderer does; " +
          "an async factory such as createSceneRenderer or createPersistentSceneRenderer returns a promise",
      );
    }
    // The engine side serves reads and animation declarations before the
    // first frame; frames wait for the graphics context.
    this._persistentRenderer = renderer;
    this._animationEventUnsubscribe = renderer.onAnimationEvent(
      (record) => this._dispatchEngineAnimationEvent(record),
    );
    const promise = renderer.ready.then(() => renderer);
    this._persistentRendererPromise = promise;
    const document = this._document;
    if (document._preferredCanvasDevice || document._preferredCanvasDevicePending) return;
    const pending = promise.then(
      (renderer) => {
        const device = renderer.graphicsDevice ?? null;
        if (device !== null) document._preferredCanvasDevice ??= device;
      },
      () => {},
    ).finally(() => {
      if (document._preferredCanvasDevicePending === pending) {
        document._preferredCanvasDevicePending = null;
      }
    });
    document._preferredCanvasDevicePending = pending;
  }

  // An engine track's start, iteration end or cancel, dispatched at the
  // element of its node; the animation or transition that owns the track
  // acknowledges it.
  _dispatchEngineAnimationEvent(record) {
    // A provisional track reports no lifecycle (_setProvisionalTrack): the
    // frame that declares its animation's own track starts it.
    if (this._provisionalTracks.has(record.animationId)) return;
    const target = (this._eventTargetAtIndex ?? targetsAtRow(this._indexOfElement, this._indexOfPseudoTarget))[
      record.nodeIndex
    ];
    if (!target) {
      throw new RangeError(
        `No DOM element for animated layout index ${record.nodeIndex}`,
      );
    }
    // A ::before or ::after reports its events at its element.
    const pseudoElement = isPseudoElementTarget(target) ? target.pseudoElement : "";
    const element = pseudoElement ? target.element : target;
    const transitionAnimation = this._transitionTimings.get(target)
      ?.get(record.propertyName)?.animation;
    const matchingAnimation =
      this._animationCancelingThroughEngine?._ownsEngineAnimationId(record.animationId)
        ? this._animationCancelingThroughEngine
        : transitionAnimation?._ownsEngineAnimationId(record.animationId)
        ? transitionAnimation
        : this._animations.find((animation) =>
          animation._animationId === record.animationId
        );
    const ends = record.type === "transitionend" ||
      record.type === "transitioncancel";
    const feedback = matchingAnimation?._beginEngineLifecycle(record);
    // An owned event is dispatched once: never when already reported, or
    // when it comes from a track its animation has replaced. A script
    // animation's track reports its lifecycle to the animation only: CSS
    // animation and transition events belong to CSS-declared animations.
    const scriptAnimation = matchingAnimation !== undefined &&
      !(matchingAnimation instanceof CSSAnimation) && !(matchingAnimation instanceof CSSTransition);
    if (!matchingAnimation || feedback) {
      try {
        if (!scriptAnimation) {
          const event = createEvent(record.type, {
            bubbles: true,
            propertyName: record.propertyName,
            animationName: matchingAnimation?._cssAnimationName ?? "",
            elapsedTime: matchingAnimation
              ? matchingAnimation._elapsedTimeForEvent(record.type)
              : 0,
            pseudoElement,
          });
          // Synchronous layout and DOM removal defer events until the next
          // animation update. An event of the frame in progress waits for
          // its end (_render's finally block): its listeners run as script
          // after the frame, never inside it.
          if (this._animationEventDeferralDepth > 0) {
            this._deferredAnimationEvents.push({ element, event });
            if (!this._rendering) this._scheduleAnimationFrame(element);
          } else if (this._rendering) {
            this._deferredAnimationEvents.push({ element, event });
          } else dispatchEvent(element, event);
        }
      } finally {
        if (feedback) matchingAnimation._completeEngineLifecycle(feedback);
      }
    }
    // A transition whose track ended or was cancelled leaves the registry,
    // whether or not its event was still owed.
    if (ends && matchingAnimation instanceof CSSTransition) {
      this._unregisterTransition(matchingAnimation);
    }
  }

  // The renderer ends a transition's track in the first tick whose time
  // reaches its end, and that tick reports the end to the registry. A
  // transition still registered after such a tick is one whose end the
  // registry missed; it would keep every later frame rebuilding the scene.
  _requireEndedTransitionsUnregistered() {
    const tickMilliseconds = this._transitionTickMilliseconds;
    if (tickMilliseconds === null) return;
    for (const timings of this._transitionRecords.values()) {
      for (const [propertyName, timing] of timings) {
        // A paused or held transition's track does not end, and one its
        // CSSTransition declared or seeked since that tick has not run.
        if (!timing.animation._trackAdvances() || timing.trackAwaitsTick) continue;
        // The engine's own test (engine-layout.watpart, tick) over the
        // timing the track was written with (writeAnimationTrack).
        const activeStartMilliseconds = timing.startTimeMilliseconds +
          (timing.delay ?? 0);
        if (tickMilliseconds - activeStartMilliseconds < timing.duration) {
          continue;
        }
        const element = timing.animation._element;
        const elementLabel = `${element.localName}${
          element.id ? `#${element.id}` : ""
        }${timing.animation._pseudoElement}`;
        throw new Error(
          `The render surface still counts the ${propertyName} transition of ${elementLabel} as running after the frame at ${tickMilliseconds} ms, which reached its end at ${
            activeStartMilliseconds + timing.duration
          } ms (start ${timing.startTimeMilliseconds} ms, delay ${timing.delay} ms, duration ${timing.duration} ms). The renderer ended its track without the registry removing it, and every later frame would rebuild the scene; a transition must enter the registry when the renderer declares it and leave it at its transitionend or transitioncancel.`,
        );
      }
    }
  }

  // A registered transition's track advances on the clock unless it is
  // paused or has a zero playback rate.
  _transitionsNeedFrames() {
    for (const timings of this._transitionRecords.values()) {
      for (const timing of timings.values()) {
        if (timing.animation._trackAdvances()) return true;
      }
    }
    return false;
  }

  _hasActiveAnimationWork() {
    if (this._shutdown) return false;
    const exports = this._root._domCore.exports;
    const pseudoContentIsActive = [...this._pseudoContentAnimations.values()]
      .some((pseudoElements) =>
        [...pseudoElements.values()].some((records) =>
          records.some((record) => {
            const { duration, delay = 0, iterations = 1 } = record.definition.timing;
            return exports.animation_content_active(
              record.definition.paused ? 1 : 0,
              record.startTimeMilliseconds,
              delay,
              duration,
              iterations,
              this._currentTime,
            ) === 1;
          })
        )
      );
    return this._smoothScrolls.size > 0 ||
      this._transitionsNeedFrames() ||
      pseudoContentIsActive ||
      this._animations.some((animation) => animation._needsFrame());
  }

  _renderOpportunity(
    timeMilliseconds,
    forceDelivery,
    snapshotPixels = true,
    pixelReadback = false,
    transaction = null,
  ) {
    if (this._frameTransaction && this._frameTransaction !== transaction) {
      return Promise.resolve(this._lastDeliveredFrame);
    }
    this._currentTime = timeMilliseconds;
    scheduleFocusFixup(this._root);
    // The suggestion popup's rows, placement and top layer entry follow its
    // state before the frame reads the tree (core/dom/datalist-popup.watpart).
    this._root._runTreeOperation(() => this._root._domCore.status("datalist_popup_prepare", this._root._coreHandle));
    this._advanceSmoothScrolls(timeMilliseconds);
    if (this._hasActiveAnimationWork()) {
      this._dirty = true;
      for (const animation of this._animations) {
        if (animation._needsFrame()) this._mutatedNodes.add(animation._element);
      }
      for (const timings of this._transitionRecords.values()) {
        for (const timing of timings.values()) this._mutatedNodes.add(timing.animation._element);
      }
      if (this._pseudoContentAnimations.size > 0) {
        this._forceFullInvalidation = true;
        this._forceFullDamage = true;
      }
    }
    return this._render(
      timeMilliseconds,
      forceDelivery,
      snapshotPixels,
      true,
      true,
      pixelReadback,
    ).then((frame) => {
      // The last step of the rendering opportunity: the pending top layer
      // removals leave the top layer (CSS Positioned Layout 4, "process
      // top layer removals"; core/dom/top-layer.watpart).
      if (this._shutdown) return frame;
      const document = this._root.ownerDocument ?? this._root;
      document._domCore.status("top_layer_process_removals", document._coreHandle);
      return frame;
    });
  }

  _createAnimation(
    element,
    keyframes,
    options,
    {
      insertionIndex = this._animations.length,
      beforeEngineHandles = [],
      diagnosticAnimationName = null,
      implicitKeyframe = {},
    } = {},
  ) {
    if (this._shutdown) throw new Error("render surface is shut down");
    // An animation created between frames is pending: the next frame's
    // time is its start time (Web Animations 1, section 4.4.4), and that
    // frame declares its engine track. One that a frame creates starts at
    // that frame.
    const animation = createDOMAnimation(this, element, keyframes, options, {
      beforeEngineHandles,
      diagnosticAnimationName,
      implicitKeyframe,
      timelinePending: !this._rendering,
    });
    this._animations.splice(insertionIndex, 0, animation);
    if (animation._timelinePending) {
      this._animationsAwaitingTimeline.add(animation);
    } else {
      animation._resolveReady(animation);
    }
    this._scheduleAnimationFrame(element);
    return animation;
  }

  _declareAnimation(
    element,
    keyframes,
    timing,
    {
      beforeEngineHandles = [],
      diagnosticAnimationName = null,
      animationId,
      trackGeneration,
    } = {},
  ) {
    const declarationOptions = {
      beforeTrackIndices: beforeEngineHandles.flatMap((handle) =>
        handle.trackIndices
      ),
      // An animation composites over the tracks before it; it never
      // cancels another animation's or a transition's track.
      preserveReplacedTracks: true,
      animationId,
      trackGeneration,
    };
    const declareEngineAnimation = (renderer, animationNodeIndex) => {
      try {
        return renderer.animate(
          animationNodeIndex,
          keyframes,
          timing,
          declarationOptions,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (diagnosticAnimationName === null) throw error;
        throw new TypeError(
          `CSS animation "${diagnosticAnimationName}" declaration failed: ${error.message}`,
          { cause: error },
        );
      }
    };
    return this._declareEngineEffect(element, declareEngineAnimation);
  }
  // A CSSTransition's track declared again over its endpoints.
  _declareTransitionTrack(element, propertyName, keyframes, timing, declarationOptions) {
    return this._declareEngineEffect(element, (renderer, nodeIndex) =>
      renderer.declareTransitionTrack(nodeIndex, propertyName, keyframes, timing, declarationOptions)
    );
  }
  // A provisional track applies the effect of a pending animation that has
  // no track of its own before the frame that declares it: a pending
  // transition's (CSSTransition._refreshProvisionalTrack), and that of an
  // animation of an element that no frame has rendered
  // (_declareUnrenderedEffects). Each runs under its animation's identity,
  // over the element's other tracks, reports no lifecycle, and leaves at
  // the start of the next frame.
  // An animation whose timeline script cleared waits for no frame; one
  // given the document timeline again starts at the next frame.
  _suspendTimeline(animation) {
    this._animationsAwaitingTimeline.delete(animation);
  }
  _resumeTimeline(animation) {
    if (!animation._timelinePending) return;
    this._animationsAwaitingTimeline.add(animation);
    this._scheduleAnimationFrame(animation._element);
  }
  _setProvisionalTrack(animationId, track) {
    this._dropProvisionalTrack(animationId);
    this._provisionalTracks.set(animationId, track);
  }
  _dropProvisionalTrack(animationId) {
    const track = this._provisionalTracks.get(animationId);
    if (track === undefined) return;
    track.cancelSilently();
    this._provisionalTracks.delete(animationId);
  }
  // The node index of animation target `target` (an element, or a
  // pseudo-element-target.js identity) in a serialization's maps: by
  // default the last frame's.
  _targetIndex(target, indexOf = this._indexOfElement, pseudoIndexOf = this._indexOfPseudoTarget) {
    return isPseudoElementTarget(target) ? pseudoIndexOf.get(target) : indexOf.get(target);
  }
  // The provisional track of a pending transition over its target's row
  // of the last frame; null when the renderer has no row for the target.
  _declareProvisionalTransitionTrack(target, propertyName, keyframes, timing, animationId) {
    const nodeIndex = this._targetIndex(target);
    if (!this._persistentRenderer || nodeIndex === undefined) return null;
    return this._persistentRenderer.declareTransitionTrack(nodeIndex, propertyName, keyframes, timing,
      { animationId, preserveReplacedTracks: true });
  }
  // Runs a synchronous layout between frames: the engine events of its
  // tick wait for the next frame. Tracks that the layout moved to its own
  // rows (_moveTracksToLayoutRows) move back to the last frame's rows.
  _runSyncLayout(layout) {
    this._animationEventDeferralDepth++;
    try {
      return layout();
    } finally {
      this._animationEventDeferralDepth--;
      const back = this._layoutRowsReturn;
      this._layoutRowsReturn = null;
      if (back) this._persistentRenderer?.remapAnimations(back);
    }
  }
  // A synchronous layout between frames writes the rows of the elements
  // that no frame has rendered; `indexOf` gives their nodes. Before it
  // samples the tracks, the animations of those elements take provisional
  // tracks there: a pending animation holds at its current time, and its
  // effect applies the value at that time (Web Animations 1, "The current
  // time of an animation"). Their own tracks wait for the frame that
  // writes the rows (_declareEngineEffect). The computed samples of the
  // layout's tick then follow the layout's rows, so a computed style read
  // of such an element includes the effect.
  _declareUnrenderedEffects(indexOf, pseudoIndexOf) {
    const renderer = this._persistentRenderer;
    if (!renderer || this._shutdown || this._rendering) return;
    const back = this._moveTracksToLayoutRows(renderer, indexOf, pseudoIndexOf);
    for (const animation of this._unrenderedEffectCandidates()) {
      // A parked animation's track waits for the next frame; meanwhile a
      // layout that has the target's row gives it a provisional one.
      if (this._targetIndex(animation._target) !== undefined && !this._parkedAnimations?.has(animation)) continue;
      const nodeIndex = this._targetIndex(animation._target, indexOf, pseudoIndexOf);
      if (nodeIndex === undefined) continue;
      this._dropProvisionalTrack(animation._animationId);
      const track = animation._declareProvisionalTrack(renderer, nodeIndex);
      if (track === null) continue;
      this._provisionalTracks.set(animation._animationId, track);
      // A provisional track stays over the layout's row.
      back?.set(nodeIndex, nodeIndex);
    }
    // Each layout binds its own rows' animation targets: an earlier
    // layout's binding names other rows. The generated boxes carry their
    // elements in the scene (generatedBoxRows).
    if (!this._computedSamples) return;
    renderer.engineWriteToken.bindComputedSamples({
      core: this._root._domCore,
      owner: this._computedSamples,
      targets: targetsAtRow(indexOf, pseudoIndexOf),
    });
  }
  // A synchronous layout of a tree that changed since the last frame
  // numbers its rows anew, while the tracks of the rendered elements name
  // the frame's rows: sampled as they are, they would apply to other rows
  // or to rows the layout does not have. Before the layout samples them they
  // move to the layout's rows, as a frame's full serialization moves them,
  // and _runSyncLayout moves them back after it, so the next frame finds
  // the rows of the last one. The tracks of elements that the layout has
  // no row for are cancelled, as that frame would cancel them, and the
  // provisional tracks of earlier layouts are dropped; the layout declares
  // its own. Returns the map back, which the caller extends with its
  // provisional tracks, or null when every row stayed.
  _moveTracksToLayoutRows(renderer, indexOf, pseudoIndexOf) {
    const forward = new Map();
    const back = new Map();
    let moved = false;
    const follow = (frameRows, layoutRows) => {
      for (const [target, frameIndex] of frameRows) {
        const layoutIndex = layoutRows.get(target);
        if (layoutIndex !== frameIndex) moved = true;
        if (layoutIndex === undefined) continue;
        forward.set(frameIndex, layoutIndex);
        back.set(layoutIndex, frameIndex);
      }
    };
    follow(this._indexOfElement, indexOf);
    follow(this._indexOfPseudoTarget, pseudoIndexOf);
    if (!moved) return null;
    for (const animationId of [...this._provisionalTracks.keys()]) this._dropProvisionalTrack(animationId);
    this._parkHiddenAnimations(indexOf, pseudoIndexOf);
    renderer.remapAnimations(forward);
    this._layoutRowsReturn = back;
    return back;
  }
  // A script animation (element.animate(), new Animation()) keeps its state
  // while its target has no box (Web Animations 1: an effect whose target
  // is not rendered stays in its animation): before a remap omits the
  // target's row, its track ends silently, so the remap cancels nothing,
  // and the animation waits in _parkedAnimations. The next frame that sets
  // the surface's rows declares its track again at its state
  // (_redeclareParkedAnimations), deferred to the frame that renders the
  // target again; until then a layout read gives it a provisional track
  // (_declareUnrenderedEffects). CSS animations and transitions end with
  // display: none (CSS Animations 1 §3, CSS Transitions 1 §3) and keep
  // their cancellation.
  _parkHiddenAnimations(indexOf, pseudoIndexOf) {
    this._parkedAnimations ??= new Set();
    for (const animation of this._animations) {
      if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
      if (this._parkedAnimations.has(animation)) continue;
      if (this._targetIndex(animation._target, indexOf, pseudoIndexOf) !== undefined) continue;
      if (animation.playState === "idle") continue;
      animation._engineHandle.cancelSilently();
      this._parkedAnimations.add(animation);
    }
    return this._parkedAnimations;
  }
  _redeclareParkedAnimations() {
    const parked = this._parkedAnimations;
    this._parkedAnimations = null;
    if (!parked) return;
    for (const animation of parked) {
      if (this._animations.includes(animation) && animation.playState !== "idle") animation._redeclareTrack();
    }
  }
  // Whether an animation of an element that no frame has rendered applies
  // an effect: a computed style read runs the synchronous layout that
  // declares its provisional track (_declareUnrenderedEffects).
  _hasUnrenderedEffects() {
    if (!this._persistentRenderer || this._shutdown || this._rendering) return false;
    for (const animation of this._unrenderedEffectCandidates()) {
      if (animation._element?.isConnected && this._targetIndex(animation._target) === undefined) return true;
    }
    return false;
  }
  // The animations whose effects a synchronous layout applies to elements
  // that no frame has rendered: the surface's animations and the pending
  // transitions that reads started.
  *_unrenderedEffectCandidates() {
    yield* this._animations;
    for (const transitions of this._pendingTransitions.values()) yield* transitions.values();
  }
  // Declares through the renderer, or, before the renderer has the
  // target's row, defers the declaration to the frame that writes it.
  _declareEngineEffect(target, declare) {
    const nodeIndex = this._targetIndex(target);
    if (this._persistentRenderer && nodeIndex !== undefined) {
      return declare(this._persistentRenderer, nodeIndex);
    }
    const deferred = deferAnimationBinding(declare);
    this._pendingAnimationDeclarations.push({
      target,
      bind: deferred.bind,
      release: deferred.release,
    });
    return deferred.handle;
  }
  _replaceAnimationBase(element, propertyName, target) {
    const nodeIndex = this._indexOfElement.get(element);
    if (!this._persistentRenderer || nodeIndex === undefined) return false;
    return this._persistentRenderer.replaceAnimationBase(
      nodeIndex,
      propertyName,
      target,
    );
  }

  _animationsForElement(element, subtree) {
    this._startStyleChangeAnimations();
    return animationsForElement(this._animationCandidates(), element, subtree);
  }

  _removeAnimation(animation) {
    const index = this._animations.indexOf(animation);
    if (index >= 0) this._animations.splice(index, 1);
    this._animationsAwaitingTimeline.delete(animation);
    this._animationsPausePending.delete(animation);
  }

  _restoreAnimation(animation) {
    if (!this._animations.includes(animation)) this._animations.push(animation);
  }

  // A synchronous layout getter's serialization, offered by
  // computeLayoutBoxes (src/dom/live-geometry.js): the next frame under
  // the same style generation, resource revision and viewport takes it
  // instead of serializing again. One is held at a time; a newer offer
  // or a mismatch releases it.
  _offerSyncLayout(layout, styleGeneration, resourceRevision, scrollRevision) {
    if (this._shutdown || this._pseudoContentAnimations.size > 0) return false;
    const held = this._syncLayout;
    if (held !== null) {
      // Under the same generation the held one already describes this
      // tree, so the new one is dropped. Under a new generation the held
      // one is stale and the new one takes its place: its lowered rows are
      // relative to the held publication rather than the frame's last, so
      // the renderer's provenance check sends that frame to a full row
      // write, but the frame still skips serializing and laying out again
      // (frame_sync_layout).
      const core = this._root._domCore;
      if (core.status("frame_sync_layout", SYNC_LAYOUT_OFFER, ...core.valueListInput([
        held.styleGeneration, held.resourceRevision, held.scrollRevision,
        styleGeneration, resourceRevision, scrollRevision,
      ])) === 1) return false;
      this._releaseSyncLayout();
    }
    this._syncLayout = {
      layout,
      styleGeneration,
      resourceRevision,
      scrollRevision,
      frameSequence: this._frameSequence,
      timeMilliseconds: this._now(),
      // The time the layout sampled the surface's animations at
      // (computeLayoutBoxes, src/dom/live-geometry.js), and the animation
      // controller's revision then.
      sampleTime: this._currentTime,
      animationRevision: this._persistentRenderer?.engineWriteToken?.revision ?? -1,
    };
    return true;
  }
  // The held layout for another synchronous getter, left held: it answers
  // while the style generation, resource revision, scroll positions and
  // viewport are unchanged, no frame has rendered since (a frame samples
  // the engine's animation tracks, which the layout inherits), and, while
  // something animates, the surface's time is the one the layout sampled
  // and no track or time changed since (the controller's revision).
  _peekSyncLayout(styleGeneration, viewport, resourceRevision, scrollRevision) {
    const held = this._syncLayout;
    if (held === null) return null;
    const heldViewport = held.layout.viewport;
    const core = this._root._domCore;
    const answers = core.status("frame_sync_layout", SYNC_LAYOUT_PEEK, ...core.valueListInput([
      this._animations.length, this._cssAnimations.size, this._pseudoContentAnimations.size,
      this._activeTransitionCount, this._pendingAnimationDeclarations.length, this._pendingScrollSources.size,
      held.styleGeneration, held.resourceRevision, held.scrollRevision, held.frameSequence,
      styleGeneration, resourceRevision, scrollRevision, this._frameSequence,
      heldViewport.width, heldViewport.height, heldViewport.deviceScale ?? 1, heldViewport._requestedLeft, heldViewport._requestedTop,
      viewport.width, viewport.height, viewport.deviceScale ?? 1, viewport._requestedLeft, viewport._requestedTop,
      held.sampleTime, this._currentTime,
      held.animationRevision, this._persistentRenderer?.engineWriteToken?.revision ?? -1,
    ]));
    return answers === 1 ? held.layout : null;
  }
  _takeSyncLayout(styleGeneration, viewport, resourceRevision) {
    const held = this._syncLayout;
    if (held === null) return null;
    this._syncLayout = null;
    // A frame's own layout is the presented frame's: the next frame does
    // not take it.
    if (held.layout.borrowed) {
      this._releaseSyncLayoutState(held.layout);
      return null;
    }
    const { layout, timeMilliseconds } = held;
    const core = this._root._domCore;
    if (core.status("frame_sync_layout", SYNC_LAYOUT_TAKE, ...core.valueListInput([
      held.styleGeneration, held.resourceRevision, styleGeneration, resourceRevision,
      layout.viewport.width, layout.viewport.height, layout.viewport.deviceScale ?? 1,
      viewport.width, viewport.height, viewport.deviceScale ?? 1,
    ])) === 1) {
      // The frame takes the layout with its getters' geometry, which the
      // frame derives its own from and releases (_render, readGeometry).
      layout.transitionChangeTimeMilliseconds = timeMilliseconds;
      return layout;
    }
    this._releaseSyncLayoutState(layout);
    return null;
  }
  // A frame of a document with query containers takes the layout of a
  // synchronous getter (computeLayoutBoxes, src/dom/live-geometry.js),
  // which serializes and lays out until the size of every container
  // settles. A paged surface and animated ::before or ::after content
  // have no such layout to take, so their frames refuse query containers.
  _settleQueryContainers(viewport, generatedContent) {
    if (this._page !== null || generatedContent !== null) {
      throw new Error(
        `A ${this._page !== null ? "paged surface" : "frame with animated ::before or ::after content"} ` +
          "cannot lay out size query containers (container-type: size or inline-size): their sizes settle only in " +
          "a continuous synchronous layout. Remove the container type or render the document continuously.",
      );
    }
    computeLayoutBoxes(this._root);
    const core = this._root._domCore;
    this._serializedStyleGeneration = this._root.ownerDocument?._styleSystem?.generation ?? -1;
    const layout = this._takeSyncLayout(this._serializedStyleGeneration, viewport, core.status("resource_revision"));
    if (layout === null) {
      throw new Error(
        "The synchronous layout that settled the query containers did not reach the frame: the surface " +
          `refused its offer or its viewport differs from the frame's (${viewport.width}x${viewport.height}).`,
      );
    }
    return layout;
  }
  _releaseSyncLayout() {
    const held = this._syncLayout;
    if (held !== null) {
      this._syncLayout = null;
      this._releaseSyncLayoutState(held.layout);
    }
    this._releaseSyncPageLayout();
  }
  // A synchronous getter's page layout (src/dom/live-geometry.js), offered
  // for the getters that follow it: one is held at a time.
  _offerSyncPageLayout(layout, styleGeneration, resourceRevision, scrollRevision) {
    if (this._shutdown) return false;
    this._releaseSyncPageLayout();
    this._syncPageLayout = {
      layout,
      styleGeneration,
      resourceRevision,
      scrollRevision,
      frameSequence: this._frameSequence,
      page: this._page,
    };
    return true;
  }
  // The held page layout for another getter, left held: it answers while
  // the page shown and its @page rules, the style generation, resource
  // revision, scroll positions and viewport are those it was laid out
  // under, no frame has rendered since and nothing animates. A stale one
  // is released.
  _peekSyncPageLayout(styleGeneration, viewport, resourceRevision, scrollRevision, rulesKey) {
    const held = this._syncPageLayout;
    if (held === null) return null;
    const heldViewport = held.layout.viewport;
    if (
      this._animations.length + this._cssAnimations.size + this._pseudoContentAnimations.size +
          this._activeTransitionCount + this._pendingAnimationDeclarations.length > 0 ||
      this._pendingScrollSources.size > 0 ||
      held.page !== this._page ||
      held.layout.pageRulesKey !== rulesKey ||
      held.styleGeneration !== styleGeneration ||
      held.resourceRevision !== resourceRevision ||
      held.scrollRevision !== scrollRevision ||
      held.frameSequence !== this._frameSequence ||
      heldViewport.width !== viewport.width ||
      heldViewport.height !== viewport.height ||
      (heldViewport.deviceScale ?? 1) !== (viewport.deviceScale ?? 1)
    ) {
      this._releaseSyncPageLayout();
      return null;
    }
    return held.layout;
  }
  _releaseSyncPageLayout() {
    const held = this._syncPageLayout;
    if (held === null) return;
    this._syncPageLayout = null;
    this._releaseSyncLayoutState(held.layout);
  }
  _releaseSyncLayoutState(layout) {
    this._releaseRetainedGeometry(layout);
    if (layout.borrowed) return;
    layout.serialized.release();
    this._root._domCore.releaseSceneResources(layout.serialized.nodes);
    releaseBoxSnapshot(layout.boxes);
  }
  // The layout of the frame just presented, held for the synchronous
  // getters that follow it: its observers' callbacks read layout before
  // anything changes, and each read laid the document out again. The
  // layout borrows the frame's serialization and boxes, which the frame
  // releases when the next one supersedes it (publish drops the held
  // layout first); it answers while the frame's revisions, the scroll
  // positions and the surface's time hold (_peekSyncLayout).
  _offerFrameLayout(serialized, boxes, sourceRevisions) {
    const viewport = this.viewport;
    const layout = {
      boxes, indexOf: serialized.indexOf, root: this._root,
      viewport: {
        width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale ?? 1,
        density: viewport.density, _requestedLeft: viewport._requestedLeft, _requestedTop: viewport._requestedTop,
      },
      viewportIndex: serialized.viewportIndex, publication: serialized.publication, serialized,
      ownedBySurface: true, textStore: 0, paging: null, pageRulesKey: null, borrowed: true,
    };
    // A held layout predates this frame, so the frame's replaces it.
    this._releaseSyncLayout();
    this._offerSyncLayout(layout, Number(sourceRevisions.document) >>> 0, Number(sourceRevisions.resource) >>> 0,
      this._root._domCore.status("scroll_revision") >>> 0);
  }
  _releaseRetainedGeometry(layout) {
    layout.retainedGeometry?.release();
    layout.retainedGeometry = undefined;
  }
  _dropPlannedSerialization() {
    const held = this._plannedSerialization;
    if (held === null) return;
    this._plannedSerialization = null;
    held.serialized.release();
    this._root._domCore.releaseSceneResources(held.serialized.nodes);
  }
  // The serialization of the last transition planning, for a layout read of
  // the same tree: taken while the document's style generation, the
  // resource revision and the viewport are the ones it serialized under;
  // else dropped, and null.
  _takePlannedSerialization(styleGeneration, resourceRevision, viewport) {
    const held = this._plannedSerialization;
    if (held === null) return null;
    this._plannedSerialization = null;
    if (held.styleGeneration === styleGeneration && held.resourceRevision === resourceRevision &&
        held.width === viewport.width && held.height === viewport.height &&
        held.deviceScale === (viewport.deviceScale ?? 1) &&
        held.requestedLeft === viewport._requestedLeft && held.requestedTop === viewport._requestedTop) {
      return held.serialized;
    }
    held.serialized.release();
    this._root._domCore.releaseSceneResources(held.serialized.nodes);
    return null;
  }
  // The text of every animated ::before/::after at `timeMilliseconds`,
  // for the core's scene build of a frame or of a synchronous layout
  // (computeLayoutBoxes): an entry per element and pseudo-element whose
  // content animations have an effect; null without a record. The
  // animations replace, in animation-name order (Web Animations 1 §5.4.4,
  // "the effect stack"), so the last one with an effect shows; one
  // outside its active interval without a fill, or at an implicit
  // keyframe, leaves the content beneath it.
  _animatedGeneratedContent(timeMilliseconds) {
    if (this._pseudoContentAnimations.size === 0) return null;
    const overrides = [];
    for (const [element, pseudoElements] of this._pseudoContentAnimations) {
      for (const [pseudoElement, records] of pseudoElements) {
        const text = stackedAnimationContent(records, timeMilliseconds);
        if (text === undefined) continue;
        overrides.push({ element, pseudoElement, text });
      }
    }
    return overrides;
  }

  // An animation's own state change (declaration, seek, play, pause, cancel,
  // finish) re-samples exactly one element. The retained scene carries the
  // engine's tracks, not their samples, so the element must enter the
  // mutation set: it is what damages its rect and what refreshes its row's
  // generation so the engine re-emits it. A running animation's per-frame
  // progression enters the same set through _renderOpportunity.
  _scheduleAnimationFrame(element = null) {
    if (element) this._mutatedNodes.add(element);
    this._dirty = true;
    this._schedule();
  }

  async _render(
    timeMilliseconds,
    forceDelivery,
    snapshotPixels = true,
    rasterize = true,
    deliverObservers = true,
    pixelReadback = false,
    continuation = null,
  ) {
    if (this._shutdown) return null;
    if (this._stagedFrame) return this._stagedFrame.frame;
    // A scheduled render in flight absorbs a later scheduled render: the
    // surface stays dirty and the loop renders again. A forced render
    // (renderNow, prepareNow, captureFrames) waits for the render in
    // flight, then renders its own frame, so its caller always gets one.
    if (this._rendering || this._animationCheckpoint) {
      if (!forceDelivery) {
        this._dirty = true;
        return null;
      }
      while (this._rendering || this._animationCheckpoint) await this.whenIdle();
      if (this._shutdown) return null;
      if (this._stagedFrame) return this._stagedFrame.frame;
    }
    if (!this._dirty && !forceDelivery) return null;
    // The frame's restyle counters start before the style change event,
    // whose resolutions are this frame's work.
    const frameRestyleCounts = continuation === null
      ? FRAME_RESTYLE_COUNTS.map((kind) => this._frameCore.status("computed_restyle_counts", kind))
      : null;
    // When a presented element declares a transition of a property that
    // computed resolution animates (font-size), the style change since the
    // last frame starts its CSS animations and transitions before this
    // frame resolves styles, as a read between frames does: the transition
    // then applies at this frame's scene build.
    if (this._declaresDependencyTransitions()) this._startStyleChangeAnimations();
    // A document with resize observers lays its style change out as a read
    // between frames does: the layout starts the change's transitions and
    // samples them (computeLayoutBoxes), and this frame takes that layout.
    // The frame's observer stage then reads the sizes the frame presents,
    // not a transition's end value, which the frame's own layout would
    // give before its render starts the transition. A change of state
    // alone (hover, focus) restyles the retained scene instead.
    if (this._page === null && this._hasNonStateMutation &&
        this._root.ownerDocument?._resizeObservers?.size > 0 &&
        this._root.ownerDocument._styleSystem !== undefined &&
        this._serializedStyleGeneration !== this._root.ownerDocument._styleSystem.generation) {
      computeLayoutBoxes(this._root);
    }
    this._requireEndedTransitionsUnregistered();
    this._rendering = true;
    this._dirty = false;
    this._currentTime = timeMilliseconds;
    this._animationPromisesSettled = false;
    // The provisional tracks leave before this frame resolves the pending
    // animations, remaps the tracks and plans the transitions of the style
    // change (_setProvisionalTrack).
    for (const track of this._provisionalTracks.values()) track.cancelSilently();
    this._provisionalTracks.clear();
    // An adopted animation's timeline had no time until now. This frame's
    // time is its first, so it starts here and samples from its first
    // keyframe instead of from a clock it never saw.
    if (this._animationsAwaitingTimeline.size > 0) {
      const awaiting = [...this._animationsAwaitingTimeline];
      this._animationsAwaitingTimeline.clear();
      for (const animation of awaiting) animation._resolveTimeline();
    }
    // The pending pause tasks hold each pause-pending animation at this
    // frame's time.
    if (this._animationsPausePending.size > 0) {
      const pending = [...this._animationsPausePending];
      this._animationsPausePending.clear();
      for (const animation of pending) animation._commitPendingPause();
    }
    // The frame's time updates the finished state of each animation and
    // transition (Web Animations 1, section 4.4.16) before its tick
    // samples their tracks.
    for (const animation of this._animations) animation._updateFinishedState();
    for (const records of this._transitionRecords.values()) {
      for (const record of records.values()) record.animation._updateFinishedState();
    }
    // The frame's time is the time of the effects that computed resolution
    // applies (font-size): an element whose effect moved resolves again.
    setAnimationDependencyTime(this._root.ownerDocument ?? this._root, timeMilliseconds);
    // The microtask checkpoint of "update animations and send events"
    // (HTML §8.1.7.3; Web Animations 1 §4.4.18): the reactions to the
    // promises that the update settled run as script between frames, so a
    // read in them updates the style and starts its animations. A macrotask
    // turn drains the whole microtask queue. The outermost call holds it
    // when the update settled a promise (_animationPromisesSettled);
    // an observer restart renders within the frame. No other frame starts
    // meanwhile (_animationCheckpoint), and the provisional tracks that the
    // reads made leave before the frame remaps the tracks.
    // The animation events that a synchronous layout since the last frame
    // queued are sent after that checkpoint, still as script: the reactions
    // to their listeners run before the frame resumes.
    const deferredEvents = this._deferredAnimationEvents;
    this._deferredAnimationEvents = [];
    if (continuation === null && (this._animationPromisesSettled || deferredEvents.length > 0)) {
      this._rendering = false;
      this._animationCheckpoint = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const { element, event } of deferredEvents) dispatchEvent(element, event);
        if (deferredEvents.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        this._animationCheckpoint = false;
        this._rendering = true;
      }
      if (this._shutdown) {
        this._rendering = false;
        for (const resolve of this._idleWaiters.splice(0)) resolve();
        return null;
      }
      for (const track of this._provisionalTracks.values()) track.cancelSilently();
      this._provisionalTracks.clear();
    } else {
      for (const { element, event } of deferredEvents) dispatchEvent(element, event);
    }
    // A running ::before or ::after content animation that a read between
    // frames started, or played on from its held time, begins at this
    // frame, at that held time.
    for (const pseudoElements of this._pseudoContentAnimations.values()) {
      for (const records of pseudoElements.values()) {
        for (const record of records) Object.assign(record, contentAnimationFrameStart(record, timeMilliseconds));
      }
    }
    this._stageCounters.currentStage = "prepare";
    let resizeObserverLoopError = false;
    const renderStartedAt = hostNow();
    // Image decoding may happen in the preparation layout pass, before the
    // persistent renderer receives its options. Share one collector across
    // both paths so the delivered frame owns every first-use SVG stage.
    const svgImageTimings = [];
    let rasterStartedAt = null;
    let rendererReadyAt = null;
    let rendererResizedAt = null;
    let visibleRectangleSetAt = null;
    let rasterFinishedAt = null;
    let pendingPresentation = null;
    const ownsContinuation = continuation === null;
    // The transitions that reads since the last frame created are pending
    // until this frame declares them (_registerStartedTransition); the
    // frame cancels the rest (_cancelUndeclaredTransitions).
    if (ownsContinuation) {
      this._frameHeldTransitions = this._pendingTransitions;
      this._pendingTransitions = new Map();
      this._pendingTransitionsKey = null;
      this._styleChangeAnimationsKey = null;
      this._frameReadBaselines = this._readBaselines;
      this._readBaselines = new Map();
    }
    const core = this._frameCore;
    const frameOwner = this._frameOwner;
    const frameBindings = this._frameBindings;
    // The frame's restyle work: the core's record counters before the frame
    // (and its style change event) and after it, taken by the outermost
    // call only (an observer restart renders within this call).
    const restyleCountsBefore = ownsContinuation ? frameRestyleCounts : null;
    continuation ??= core.status(
      "frame_begin",
      frameOwner,
      timeMilliseconds,
      this._frameFlags(rasterize, deliverObservers, pixelReadback),
      BigInt(this._root.ownerDocument?._styleSystem?.generation ?? 0),
      BigInt(core.status("resource_revision")),
      this._viewportRevision,
    );
    let accepted = false;
    let frameMutatedNodes = null;
    let frameForcedGenerationNodes = null;
    let capturedScrollRequests = null;
    let releaseUnpublishedSuccessor = null;
    let transitionChangeTimeMilliseconds = timeMilliseconds;
    // Set once this frame restyled the retained publication in place.
    let publicationRestyled = false;
    const previousPublication = {
      presentedFrame: this._presentedFrame,
      preparedState: this._preparedState,
      lastBoxes: this._lastBoxes,
      lastPixels: this._lastPixels,
      indexOfElement: this._indexOfElement,
      indexOfPseudoTarget: this._indexOfPseudoTarget,
      elementAtIndex: this._elementAtIndex,
      scrollbars: this._scrollbars,
    };
    const rollback = () => {
      core.status("frame_abort", continuation);
      if (this._frameCore !== core || this._frameOwner !== frameOwner) return;
      if (frameMutatedNodes) {
        for (const node of frameMutatedNodes) this._mutatedNodes.add(node);
        for (const node of frameForcedGenerationNodes) {
          this._forcedGenerationNodes.add(node);
        }
      }
      this._presentedFrame = previousPublication.presentedFrame;
      this._preparedState = previousPublication.preparedState;
      this._lastBoxes = previousPublication.lastBoxes;
      this._lastPixels = previousPublication.lastPixels;
      this._indexOfElement = previousPublication.indexOfElement;
      this._indexOfPseudoTarget = previousPublication.indexOfPseudoTarget;
      this._elementAtIndex = previousPublication.elementAtIndex;
      this._scrollbars = previousPublication.scrollbars;
      this._serializedStyleGeneration = -1;
      this._hasNonStateMutation = true;
      // The retained publication holds this frame's restyled rows, which
      // the renderer may not have received: a new cascade generation makes
      // the next publication lower and change every row.
      if (publicationRestyled) {
        core.styleInvalidate(this._root.ownerDocument._coreHandle);
      }
      this._dirty = true;
    };
    // The renderer's text geometry capture and this frame's text geometry
    // store (geometry_text_store), which the frame's snapshot holds.
    let frameTextCapture = 0;
    let frameTextStore = 0;
    // A frame that laid out again derives its geometry from the presented
    // snapshot once, before it rasters (deriveRestyleBasis): its scrollbars
    // read that geometry, and its interaction snapshot derives from it; the
    // frame releases it.
    let restyleBasis = null;
    let restyleBasisRefusal = null;
    // The geometry of this frame's tree for its boxes (frameGeometryFor),
    // with the box list, publication and viewport it describes: its
    // observer checkpoint reads it, its scrollbars read it when no restyle
    // basis gives them, and its interaction snapshot derives from it. The
    // frame releases it.
    let checkpointLayout = null;
    // The live geometry of the synchronous layout read whose layout this
    // frame took, with that layout's boxes, publication and viewport, or
    // null: the frame geometry derives from it instead of a build. The
    // frame releases it.
    let readGeometry = null;
    try {
      const observerDocument = this._root.ownerDocument;
      this._dropPlannedSerialization();
      // Whether an animation ran when the frame began: the engine samples
      // it while it renders, so the observer stage before the render saw
      // none of its sizes, and the frame in which it ends still owes its
      // end value (the notify below, which also takes the animations the
      // render started).
      const animatedAtStart = this._animating();
      const styleSystem = observerDocument?._styleSystem;
      let preparationToken = this._frameClaim(continuation, FRAME_STAGE.PREPARE, frameBindings);
      for (;;) {
        const resourceRevision = core.status("resource_revision");
        await observerDocument?._readyForRendering();
        const changed = core.status("resource_revision") !== resourceRevision;
        if (!changed) break;
        this._frameResume(
          continuation,
          preparationToken,
          FRAME_FACT_PREPARATION_CHANGED,
          -1,
          frameBindings,
        );
        preparationToken = this._frameClaim(continuation, FRAME_STAGE.PREPARE, frameBindings);
      }
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback),
      );
      let scrollOnly = core.status("frame_mode", continuation) === FRAME_MODE.PURE_SCROLL;
      let transformOnly = core.status("frame_mode", continuation) === FRAME_MODE.TRANSFORM;
      if (styleSystem && !scrollOnly) {
        this._prepareStyleSystem(styleSystem);
        // The core's media environment is shared by every document; the
        // record writer reads it (print-color-adjust, forced colors), so
        // each frame installs this surface's.
        core.mediaEnvironmentSet(styleSystem.environment);
        // Forced colors and the media type act on used values in the
        // record writer, not on computed styles: a change rewrites every
        // record.
        const usedValueMedia = `${styleSystem.environment.forcedColors}\u0000${styleSystem.environment.mediaType}`;
        if (this._usedValueMedia !== undefined && this._usedValueMedia !== usedValueMedia) {
          this._releaseSyncLayout();
          this._forceFullInvalidation = true;
          this._forceFullDamage = true;
        }
        this._usedValueMedia = usedValueMedia;
        this._synchronizeCSSAnimations(core, styleSystem, timeMilliseconds);
      }
      if (this._applyPageMargins(core, this._pageMarginBoxesFor(this._page, {
        width: this.viewport.width,
        height: this.viewport.height,
      }))) {
        // The scene's margin boxes changed: the frame builds the scene.
        this._releaseSyncLayout();
        this._forceFullInvalidation = true;
        this._forceFullDamage = true;
      }
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback),
      );
      this._frameResume(continuation, preparationToken, 0, -1, frameBindings);
      const frameMode = core.status("frame_mode", continuation);
      scrollOnly = frameMode === FRAME_MODE.PURE_SCROLL;
      transformOnly = frameMode === FRAME_MODE.TRANSFORM;
      const cleanSceneReuse = frameMode === FRAME_MODE.CLEAN;
      const sceneToken = this._frameClaim(continuation, FRAME_STAGE.SCENE, frameBindings);
      capturedScrollRequests = this._captureScrollRequests();
      const capturedViewportScroll = capturedScrollRequests.get(this.viewport);
      const frameViewport = {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScale: this.viewport.deviceScale,
        density: this.viewport.density,
        _requestedLeft: capturedViewportScroll?.left ??
          this.viewport._requestedLeft,
        _requestedTop: capturedViewportScroll?.top ??
          this.viewport._requestedTop,
      };
      // A viewport offset the engine clamped without a request (see
      // _acceptScrollFeedback) leaves the presented text geometry
      // translated by the old offset; this frame rebuilds it.
      const textGeometryStale = this._textGeometryStale;
      this._textGeometryStale = false;
      const reuseTextGeometry = this._textSelectionEnabled &&
        !textGeometryStale &&
        (
          scrollOnly ||
          (
            this._selectionChanged &&
            cleanSceneReuse &&
            this._mutatedNodes.size === 0
          )
        );
      // A frame that reuses the presented text geometry still captures it:
      // a replayed emission keeps the renderer's artifact at no cost, and
      // commands emitted under another capture mode are not replayable, so
      // switching the mode walks the paint tree and writes every row in
      // the frame after. Such a frame reads no coordinates from the
      // artifact, so the engine also replays commands whose sticky scopes
      // moved (textGeometryArtifactRead).
      let captureTextGeometry = this._textSelectionEnabled;
      // Frame mode 4: the retained scene with its restyled rows, or null
      // when the frame builds the scene after all.
      publicationRestyled = frameMode === FRAME_MODE.RESTYLE &&
        this._restyleRetainedPublication(core, frameViewport, styleSystem);
      const restyledScene = publicationRestyled
        ? this._restyledSerialization(core)
        : null;
      let serialized;
      let declaredChangedNodeIndices = null;
      // A frame that takes a getter's serialization also takes the rows the
      // getter wrote into the engine and the boxes it read: the rows whose
      // scroll offsets this frame restates (the capture, after anchoring)
      // are the only ones the renderer publishes again, and the pre-render
      // layout (scroll anchoring, scroll timelines) reads the getter's
      // boxes instead of laying out again.
      let syncLayoutSource = null;
      let syncLayoutBoxes = null;
      if (scrollOnly) {
        // Reuse the retained scene. Only the scrolled nodes' offset fields
        // change; the renderer receives the changed indices as a declared
        // set, so no full-scene signature pass runs either.
        serialized = {
          ...this._preparedState.serialized,
          nodes: this._preparedState.serialized.nodes.slice(),
        };
        declaredChangedNodeIndices = new Set();
        for (const [target, request] of capturedScrollRequests) {
          const index = target === this.viewport
            ? serialized.viewportIndex
            : serialized.indexOf.get(target);
          if (index === undefined || index === null) continue;
          const node = serialized.nodes[index] = { ...serialized.nodes[index] };
          node.scrollLeft = request.left;
          node.scrollTop = request.top;
          declaredChangedNodeIndices.add(index);
        }
        this._restateScroll(serialized, capturedScrollRequests);
        this._stageCounters.scrollOnlyFrames++;
      } else if (transformOnly) {
        serialized = {
          ...this._preparedState.serialized,
          nodes: this._preparedState.serialized.nodes.slice(),
        };
        declaredChangedNodeIndices = new Set();
        const publication = serialized.nodes[0]?._corePublication;
        for (const element of this._transformOnlyMutations) {
          const index = serialized.indexOf.get(element);
          if (!Number.isInteger(index)) continue;
          // The core writes the row's transform from the element's style
          // (engine_record_transform_restate); the node keeps the
          // transform list for the transition diff.
          serialized.rowRevision = publication.core.status(
            "engine_record_transform_restate", publication.handle, index,
          );
          serialized.nodes[index] = { ...serialized.nodes[index], transform: elementTransform(element) };
          declaredChangedNodeIndices.add(index);
        }
        this._stageCounters.retainedTransformFrames++;
      } else if (cleanSceneReuse) {
        // Nothing that feeds serialization changed: reuse the retained
        // scene verbatim. The empty declared set skips the engine's
        // full-scene signature pass; canvas damage still merges in through
        // the mutation and forced-generation node indices below.
        serialized = { ...this._preparedState.serialized };
        declaredChangedNodeIndices = new Set();
        this._stageCounters.retainedCleanFrames++;
      } else if (restyledScene !== null) {
        // The renderer receives the restyled rows as the declared change
        // set.
        serialized = restyledScene;
        declaredChangedNodeIndices = new Set(serialized.changedRows);
        this._stageCounters.rowsLowered += serialized.loweredRows.length;
      } else {
        this._stageCounters.serializations++;
        this._stageCounters.currentStage = "serialize";
        // Sampled BEFORE the walk: a mutation landing during serialization
        // bumps the generation past this checkpoint, so the next frame
        // re-serializes instead of trusting a torn scene.
        this._serializedStyleGeneration = styleSystem === undefined
          ? -1
          : styleSystem.generation;
        this._serializedViewportWidth = frameViewport.width;
        this._serializedViewportHeight = frameViewport.height;
        this._serializedViewportScale = frameViewport.deviceScale;
        const generatedContent = this._animatedGeneratedContent(
          timeMilliseconds,
        );
        let syncLayout = generatedContent === null
          ? this._takeSyncLayout(
            this._serializedStyleGeneration,
            frameViewport,
            core.status("resource_revision"),
          )
          : null;
        if (syncLayout === null) {
          serialized = serializeToScene(this._root, {
            viewportWidth: frameViewport.width,
            viewportHeight: frameViewport.height,
            generatedContent,
            viewport: frameViewport,
          });
          this._stageCounters.sceneRowsBuilt += serialized.nodes.length;
          this._stageCounters.rowsLowered += serialized.loweredRows.length;
          // Query containers take their sizes from a synchronous layout,
          // which serializes and lays out until the sizes settle
          // (computeLayoutBoxes); the frame takes that layout.
          if (serialized.queryContainers.length > 0) {
            serialized.release();
            core.releaseSceneResources(serialized.nodes);
            syncLayout = this._settleQueryContainers(frameViewport, generatedContent);
          }
        }
        if (syncLayout !== null) {
          if (syncLayout.retainedGeometry !== undefined) {
            const { viewport } = syncLayout;
            readGeometry = {
              geometry: syncLayout.retainedGeometry, boxes: syncLayout.boxes, publication: syncLayout.publication,
              width: viewport.width, height: viewport.height, deviceScale: viewport.deviceScale ?? 1,
            };
            syncLayout.retainedGeometry = undefined;
          }
          transitionChangeTimeMilliseconds =
            syncLayout.transitionChangeTimeMilliseconds;
          serialized = syncLayout.serialized;
          syncLayoutSource = serialized.nodes;
          syncLayoutBoxes = syncLayout.boxes;
          // The getter serialized before this frame's scroll requests were
          // captured: restate them on the rows, as a scroll-only frame does.
          if (capturedScrollRequests.size > 0) {
            serialized = { ...serialized, nodes: serialized.nodes.slice() };
            core.shareSceneResources(
              syncLayout.serialized.nodes,
              serialized.nodes,
            );
            for (const [target, request] of capturedScrollRequests) {
              const index = target === this.viewport
                ? serialized.viewportIndex
                : serialized.indexOf.get(target);
              if (index === undefined || index === null) continue;
              const node = serialized.nodes[index] = {
                ...serialized.nodes[index],
              };
              node.scrollLeft = request.left;
              node.scrollTop = request.top;
            }
            this._restateScroll(serialized, capturedScrollRequests);
            core.releaseSceneResources(syncLayout.serialized.nodes);
          }
        }
      }
      // Every mode but a full serialization keeps the retained scene; a
      // restyle the core refused serialized in full.
      const retainedScene = frameMode !== FRAME_MODE.FULL &&
        (frameMode !== FRAME_MODE.RESTYLE || restyledScene !== null);
      if (scrollOnly || transformOnly || restyledScene !== null) {
        core.shareSceneResources(
          this._preparedState.serialized.nodes,
          serialized.nodes,
        );
      }
      // The paint artifact exists for text geometry; a scene without text
      // boxes reads nothing from it, and building it walks every command.
      if (serialized.textBoxes === 0) captureTextGeometry = false;
      if (
        !retainedScene && this._persistentRenderer &&
        this._indexOfElement.size > 0
      ) {
        const remappedIndices = new Map();
        for (const [element, previousIndex] of this._indexOfElement) {
          const nextIndex = serialized.indexOf.get(element);
          if (nextIndex !== undefined) {
            remappedIndices.set(previousIndex, nextIndex);
          }
        }
        for (const [target, previousIndex] of this._indexOfPseudoTarget) {
          const nextIndex = serialized.pseudoIndexOf.get(target);
          if (nextIndex !== undefined) remappedIndices.set(previousIndex, nextIndex);
        }
        const parked = this._parkHiddenAnimations(serialized.indexOf, serialized.pseudoIndexOf);
        this._persistentRenderer.remapAnimations(remappedIndices);
        for (const animation of [...this._animations]) {
          if (parked.has(animation)) continue;
          if (this._targetIndex(animation._target, serialized.indexOf, serialized.pseudoIndexOf) === undefined) {
            this._removeAnimation(animation);
          }
        }
      }
      // Visible-region rasterization (raster-scale plan, slice 3): the
      // raster target covers the visible rectangle at the raster scale.
      // Damage rectangles are produced in full-scene device
      // coordinates; toTargetRectangle shifts them into target space.
      // A page frame's target is its page box (_pageTargetRegion); the
      // host's visible rectangle applies to continuous frames.
      const framePageRules = this._page === null
        ? null
        : this._pageRules({ width: frameViewport.width, height: frameViewport.height });
      const visibleRegion = this._page === null
        ? this._visibleRectangle
        : this._pageTargetRegion(this._page, framePageRules);
      const originDeviceX = (visibleRegion?.x ?? 0) *
        frameViewport.deviceScale;
      const originDeviceY = (visibleRegion?.y ?? 0) *
        frameViewport.deviceScale;
      // Damage uses the same integer extent as the native raster allocation;
      // the origin and device scale remain in unrounded device coordinates.
      const physicalWidth = core.exports.frame_device_extent(
        visibleRegion?.width ?? frameViewport.width,
        frameViewport.deviceScale,
      );
      const physicalHeight = core.exports.frame_device_extent(
        visibleRegion?.height ?? frameViewport.height,
        frameViewport.deviceScale,
      );
      const toTargetRectangle = (rectangle) => ({
        ...rectangle,
        x: rectangle.x - originDeviceX,
        y: rectangle.y - originDeviceY,
      });
      let boxes = syncLayoutBoxes ?? (retainedScene ? this._lastBoxes : []);
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback),
      );
      const sourceRevisions = {
        document: BigInt(
          core.status(
            "document_style_generation",
            observerDocument._coreHandle,
          ),
        ),
        style: BigInt(styleSystem?.generation ?? 0),
        resource: BigInt(core.status("resource_revision")),
        viewport: this._viewportRevision,
        scene: BigInt(this._frameSequence + 1),
        presentation: BigInt(this._frameSequence + 1),
      };
      serialized.sourceRevisions = sourceRevisions;
      serialized.root = this._root;
      // The geometry of this frame's tree for `frameBoxes`: the one the frame
      // has when its boxes are equal (boxesEqual) under the same publication
      // and viewport; else derived from the synchronous layout read's live
      // geometry under the same terms (geometry_frame_successor); else built.
      const frameGeometryFor = (frameBoxes) => {
        const describes = (held) =>
          held !== null && held.publication === serialized.publication &&
          held.width === this.viewport.width && held.height === this.viewport.height &&
          held.deviceScale === this.viewport.deviceScale && boxesEqual(held.boxes, frameBoxes);
        if (describes(checkpointLayout)) return checkpointLayout.geometry;
        let geometry;
        if (describes(readGeometry) &&
          core.status("scroll_geometry_current", readGeometry.geometry.handle, observerDocument._coreHandle) === 1) {
          ({ geometry } = buildGeometryFrameSuccessor({
            predecessor: readGeometry.geometry, root: this._root, boxes: frameBoxes, revision: 0,
            scrollbars: [], textStore: 0, sourceRevisions,
          }));
          this._stageCounters.geometryReadSuccessorFrames++;
        } else {
          geometry = observerLayout(serialized, frameBoxes, this.viewport);
          this._stageCounters.geometryBuilds++;
        }
        checkpointLayout?.geometry.release();
        checkpointLayout = {
          boxes: frameBoxes, publication: serialized.publication,
          width: this.viewport.width, height: this.viewport.height, deviceScale: this.viewport.deviceScale,
          geometry,
        };
        return geometry;
      };
      core.status(
        "frame_sources",
        continuation,
        sourceRevisions.style,
        sourceRevisions.resource,
        sourceRevisions.viewport,
      );
      this._frameResume(continuation, sceneToken, 0, -1, frameBindings);
      frameMutatedNodes = this._mutatedNodes;
      frameForcedGenerationNodes = this._forcedGenerationNodes;
      this._mutatedNodes = new Set();
      this._forcedGenerationNodes = new Set();
      this._transformOnlyMutations = new Set();
      this._hasNonTransformMutation = false;
      this._hasNonStateMutation = false;
      this._forceFullInvalidation = false;
      this._forceFullDamage = false;
      this._selectionChanged = false;
      this._eventElementAtIndex = nodesAtRow(serialized);
      this._eventTargetAtIndex = targetsAtRow(serialized.indexOf, serialized.pseudoIndexOf);
      for (;;) {
        const action = core.status("frame_stage", continuation);
        if (action === FRAME_STAGE.DAMAGE) break;
        const token = this._frameClaim(continuation, action, frameBindings);
        let facts = 0;
        let depth = -1;
        switch (action) {
          case FRAME_STAGE.LAYOUT:
            if (
              boxes !== syncLayoutBoxes ||
              boxes.length !== serialized.nodes.length
            ) {
              boxes = await this._layoutTreeBoxes({
                width: frameViewport.width,
                height: frameViewport.height,
                nodes: serialized.nodes,
                generatedBoxRows: serialized.generatedBoxRows,
                imageSources: serialized.imageSources,
                rowRevision: serialized.rowRevision ?? 0,
              });
            }
            break;
          case FRAME_STAGE.SCROLL_ANCHORING:
            facts = this._applyScrollAnchoring(
                serialized,
                boxes,
                capturedScrollRequests,
              )
              ? FRAME_FACT_GEOMETRY_CHANGED
              : 0;
            break;
          case FRAME_STAGE.SCROLL_TIMELINES:
            for (const animation of this._animations) {
              if (!animation._isScrollDriven()) continue;
              const progress = sampleScrollTimeline(
                animation,
                this._root,
                this.viewport,
                serialized,
                boxes,
              );
              if (animation._sampleScrollTimeline(progress)) {
                this._mutatedNodes.add(animation._element);
              }
            }
            break;
          case FRAME_STAGE.OBSERVERS: {
            this._pendingObserverDelivery = false;
            const delivery = deliverRenderingObservers(
              observerDocument,
              serialized,
              boxes,
              timeMilliseconds,
              core.status("frame_depth", continuation),
              () => frameGeometryFor(boxes),
            );
            facts = (this._dirty ? FRAME_FACT_OBSERVER_MUTATION : 0) | (delivery.skippedResize ? FRAME_FACT_RESIZE_SKIPPED : 0);
            depth = Number.isFinite(delivery.shallowestResizeDepth)
              ? delivery.shallowestResizeDepth
              : -1;
            break;
          }
          case FRAME_STAGE.OBSERVER_LIMIT:
            break;
          default:
            throw new Error(`Unsupported frame action ${action}`);
        }
        this._frameResume(continuation, token, facts, depth, frameBindings);
        if (core.status("frame_stage", continuation) === FRAME_STAGE.PREPARE) {
          for (const node of frameMutatedNodes) this._mutatedNodes.add(node);
          for (const node of frameForcedGenerationNodes) {
            this._forcedGenerationNodes.add(node);
          }
          this._rendering = false;
          const result = await this._render(
            timeMilliseconds,
            forceDelivery,
            snapshotPixels,
            rasterize,
            deliverObservers,
            pixelReadback,
            continuation,
          );
          accepted = true;
          return result;
        }
      }
      // The getter's boxes predate this frame's scroll requests. They stand
      // in for the pre-render layout (anchoring, scroll timelines), not for
      // the presented geometry a renderer without boxes of its own reads
      // below: that geometry must carry the requested offsets.
      if (boxes === syncLayoutBoxes && capturedScrollRequests.size > 0) {
        releaseBoxSnapshot(boxes);
        boxes = [];
      }
      resizeObserverLoopError =
        core.status("frame_loop_error", continuation) !== 0;
      // Retained delivery: every input the raster, the overlays and the
      // interaction snapshot read is unchanged since the presented frame,
      // so this frame IS the presented frame. Nothing is rebuilt; a forced
      // delivery re-presents the retained result (texture or pixels) under
      // the presented frame's sequence. Decided AFTER the observer stages:
      // an observer mutation restarts preparation above and re-decides.
      // A caret whose blink phase is due to flip is an overlay input that
      // HAS changed, so the retained result is not this frame: the caret
      // has to appear or disappear. Without this the fast path re-presents
      // the previous texture forever and the caret never blinks.
      const caretBlinkFlipDue = this._caretBlinkDue(timeMilliseconds);
      if (
        // Retained delivery re-presents the last raster frame. A prepare-only
        // frame (prepareNow) has no raster stage and returns the prepared
        // scene, so it takes the prepare path below.
        rasterize &&
        !caretBlinkFlipDue &&
        // Text geometry built at a viewport offset since clamped has to be
        // rebuilt, so the presented frame is not this one.
        !textGeometryStale &&
        // A scrollbar whose visibility changes is an overlay input too.
        !this._scrollbarVisibility.due(timeMilliseconds) &&
        this._retainedDeliveryPossible(
          cleanSceneReuse,
          pixelReadback,
          sourceRevisions,
          frameMutatedNodes,
          frameForcedGenerationNodes,
          capturedScrollRequests,
          continuation,
        )
      ) {
        for (const stage of [8, 9, 10]) {
          this._frameResume(
            continuation,
            this._frameClaim(continuation, stage, frameBindings),
            0,
            -1,
            frameBindings,
          );
        }
        core.status("frame_finish", continuation);
        accepted = true;
        this._stageCounters.retainedDeliveries++;
        if (!forceDelivery) return null;
        const frame = this._lastDeliveredFrame;
        if (this._presentFrame !== null) {
          this._presentingFrame = true;
          try {
            await this._presentFrame(frame);
          } finally {
            this._presentingFrame = false;
          }
        }
        this._notifyFrameListeners(frame, resizeObserverLoopError);
        return frame;
      }
      const damageToken = this._frameClaim(continuation, FRAME_STAGE.DAMAGE, frameBindings);
      const damageMode = core.status(
        "frame_damage_begin",
        continuation,
        physicalWidth,
        physicalHeight,
      );
      const pureScrollMutation = damageMode === FRAME_DAMAGE_PURE_SCROLL;
      let requestedDirtyRectangles = damageMode === FRAME_DAMAGE_FULL
        ? core.frameDamageRectangles(continuation)
        : [];
      let dirtyTiles = damageMode === 0 ? null : new Uint8Array(0);
      for (const target of capturedScrollRequests.keys()) {
        const index = target === this.viewport
          ? serialized.viewportIndex
          : serialized.indexOf.get(target);
        if (index === undefined || index === null) continue;
        const rectangle = boxRectangle(
          this._lastBoxes[index],
          frameViewport.deviceScale,
        );
        if (!rectangle) continue;
        const translated = toTargetRectangle(rectangle);
        core.status(
          "frame_damage_rect",
          continuation,
          1,
          translated.x,
          translated.y,
          translated.width,
          translated.height,
        );
      }
      // A frame of another page than the last rendered one replaces the
      // whole target.
      const framePage = this._page;
      if (damageMode !== 0 && framePage !== this._renderedPage) {
        core.status(
          "frame_damage_rect",
          continuation,
          0,
          0,
          0,
          physicalWidth,
          physicalHeight,
        );
      }

      // A frame that only prepares (prepareNow) and has no engine baseline
      // yet takes one layout pass for its boxes.
      if (!rasterize && this._lastBoxes.length === 0 && boxes.length === 0) {
        boxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          generatedBoxRows: serialized.generatedBoxRows,
          imageSources: serialized.imageSources,
          rowRevision: serialized.rowRevision ?? 0,
        });
      }
      // The presented snapshot (the engine's boxes, the same family the
      // delivered pixels paint) describes the PREVIOUS frame; THIS frame's
      // pending scroll deltas are known exactly, so the core predicts the
      // scrollbars of this frame natively from it (snapshotScrollbars).
      const snapshot = this._presentedFrame;
      // Scrollbar descriptors describe the layout this frame paints. The
      // renderer asks for their parts after it laid the frame out and
      // before it rasterizes (scene-renderer's scrollbarParts), with the
      // engine's layout work so far. When no node was laid out since the
      // presented frame's layout (a scroll, a paint change) and no row the
      // frame lowered anew is or was a scroll container, the frame keeps
      // that layout and those scrollers, and its descriptors come from the
      // presented snapshot with that prediction. Otherwise (a script
      // changed an overflow, the content grew, a layout getter ran, the
      // first frame) they are built from the frame's own boxes: the
      // presented snapshot still holds the previous ranges, classic bar
      // space and overflow. An overflow change in overlay mode moves no
      // box, so only its row shows it.
      const scrollbarInputsChanged = () => {
        if (scrollOnly || !serialized.changedRows?.length) return false;
        const elementAtRow = nodesAtRow(serialized);
        const presented = new Set(this._scrollbars.map((scrollbar) => scrollbar.element));
        for (const index of serialized.changedRows) {
          const element = elementAtRow[index];
          if (element?.nodeType !== 1) continue;
          if (presented.has(element)) return true;
          // An overflow that scrolls, whatever the display.
          if (element._domCore.status("scroll_overflow_scrolls", element._coreHandle) === 1) return true;
        }
        return false;
      };
      let scrollbars = null;
      let frameLayoutWork = null;
      // Without a presented frame, or when the core refuses the derivation,
      // the scrollbars of a frame that laid out again come from a geometry
      // built from its boxes.
      const laidOutScrollbars = (frameBoxes) => {
        if (snapshot !== null && !scrollOnly) {
          ({ basis: restyleBasis, refusal: restyleBasisRefusal } = deriveRestyleBasis(snapshot, {
            root: this._root, viewport: frameViewport, viewportIndex: serialized.viewportIndex ?? 0,
            boxes: frameBoxes, publication: serialized.publication, revision: this._frameSequence + 1, sourceRevisions,
          }));
        }
        if (restyleBasis !== null) {
          return snapshotScrollbars(this._root, this.viewport, restyleBasis.geometryCore, restyleBasis.geometryHandle, 0n, this.scrollbarStyle);
        }
        const geometry = frameGeometryFor(frameBoxes);
        return snapshotScrollbars(this._root, this.viewport, geometry.core, geometry.handle, 0n, this.scrollbarStyle);
      };
      const describeScrollbars = (frameBoxes, laidOut) => {
        scrollbars = snapshot && !laidOut
          ? snapshotScrollbars(
            this._root,
            this.viewport,
            snapshot.geometryCore,
            snapshot.geometryHandle,
            capturedScrollRequests.size > 0 ? capturedScrollRequests.handle : 0n,
            this.scrollbarStyle,
          )
          : laidOutScrollbars(frameBoxes);
        // Each descriptor carries the visibility it paints with; a hidden
        // overlay bar emits nothing, a fading one scales its colors' alpha.
        const scrollbarVisibility = this._scrollbarVisibility.advance(
          scrollbars,
          timeMilliseconds,
        );
        for (const [index, scrollbar] of scrollbars.entries()) {
          scrollbar.visibility = scrollbarVisibility[index];
        }
      };
      // Sandom's scrollbar design (src/dom/scrollbar-paint.js): each bar's
      // track, edge line, rounded thumb and classic corner in viewport CSS
      // px, under its scroller's scene index (-1 for the viewport). The
      // engine paints them at its scroller's scrollbar marker, inside the
      // clips over the scroller, and repaints what changed.
      //
      // One frame has one set of bars. The first call describes them; a
      // later call (a caller that renders this frame's render options
      // again) paints the same descriptors. The frame's scroll capture,
      // which the prediction reads, is released when the frame ends, and
      // the bars' visibility advances once per frame.
      const scrollbarParts = (frameBoxes, layoutWork) => {
        if (scrollbars === null) {
          frameLayoutWork = layoutWork;
          describeScrollbars(
            frameBoxes,
            snapshot === null || presentedLayoutWork.get(snapshot) !== layoutWork ||
              scrollbarInputsChanged(),
          );
        }
        const parts = [];
        for (const { bar, parts: barParts } of paintScrollbars(scrollbars, this.scrollbarStyle)) {
          const ownerIndex = bar.element === this.viewport
            ? -1
            : serialized.indexOf.get(bar.element);
          if (ownerIndex === undefined) continue;
          for (const part of barParts) {
            parts.push({
              ownerIndex,
              x: part.x,
              y: part.y,
              width: part.width,
              height: part.height,
              radius: part.radius,
              color: part.color,
            });
          }
        }
        // The tool overlay paints at the viewport's marker after its bars,
        // so above everything.
        for (const highlight of this._toolHighlights) {
          parts.push({ ownerIndex: -1, ...highlight, radius: 0 });
        }
        this._toolHighlightsRendered = this._toolHighlights;
        return parts;
      };
      // The caret, the selection bands and the scrollbars are the
      // renderer's damage.
      if (dirtyTiles !== null) {
        for (const rectangle of requestedDirtyRectangles) {
          core.status(
            "frame_damage_rect",
            continuation,
            0,
            rectangle.x,
            rectangle.y,
            rectangle.width,
            rectangle.height,
          );
        }
        requestedDirtyRectangles = core.frameDamageRectangles(continuation);
        dirtyTiles = core.frameDamageTiles(
          continuation,
          physicalWidth,
          physicalHeight,
          64,
        );
      }
      const scene = {
        width: frameViewport.width,
        height: frameViewport.height,
        nodes: serialized.nodes,
        generatedBoxRows: serialized.generatedBoxRows,
        imageSources: serialized.imageSources,
        // The row revision the rows hold; the core publishes the rows as
        // that revision restated them (engine_direct_publish_scene).
        rowRevision: serialized.rowRevision ?? 0,
        styleGeneration: serialized.styleGeneration,
        changedRows: serialized.changedRows,
        publicationRevision: serialized.publicationRevision,
        previousPublicationRevision: serialized.previousPublicationRevision,
        syncLayoutSource,
        syncLayoutScrollIndices: null,
      };
      // Only a pure-scroll frame keeps its declared JS tiles authoritative
      // (the engine's scroll table localizes within them). Every mutation
      // frame merges the engine's generation-derived tile map in; JS tiles
      // there carry only overlay scrollbar damage.
      const authoritativeDirtyTiles = dirtyTiles !== null && pureScrollMutation;
      let mutationNodeIndices = null;
      if (!this._dirty) {
        this._anchoringSuppressionProperties.clear();
        this._positionSuppressionNodes.clear();
      }
      this._frameResume(continuation, damageToken, 0, -1, frameBindings);
      let forceGenerationNodeIndices = null;
      if (frameMutatedNodes.size > 0) {
        mutationNodeIndices = new Set();
        forceGenerationNodeIndices = new Set();
        for (const node of frameMutatedNodes) {
          const index = serialized.indexOf.get(node);
          if (Number.isInteger(index)) mutationNodeIndices.add(index);
          if (
            frameForcedGenerationNodes.has(node) && Number.isInteger(index)
          ) {
            forceGenerationNodeIndices.add(index);
          }
        }
      }
      // Native changedRows describes lowered style, not host scroll requests.
      // A mixed scroll/paint frame serializes anew instead of taking the
      // scroll-only branch, but still owes the renderer every requested offset.
      for (const target of capturedScrollRequests.keys()) {
        const index = target === this.viewport
          ? serialized.viewportIndex
          : serialized.indexOf.get(target);
        if (!Number.isInteger(index)) continue;
        mutationNodeIndices ??= new Set();
        mutationNodeIndices.add(index);
        if (syncLayoutSource !== null) {
          scene.syncLayoutScrollIndices ??= new Set();
          scene.syncLayoutScrollIndices.add(index);
        }
      }
      const renderOptions = {
        // The frame this render publishes, for its frame comparison record.
        frameSequence: this._frameSequence + 1,
        ...(dirtyTiles
          ? {
            authoritativeDirtyTiles,
            dirtyTiles,
            tileSize: 64,
          }
          : {}),
        ...(scrollOnly && declaredChangedNodeIndices !== null
          ? { scrollOnlyNodeIndices: declaredChangedNodeIndices }
          : {}),
        scrollbarParts,
        selectionFrameOwner: this._frameOwner,
        selectionPixelReadback: Boolean(pixelReadback),
        ...(pixelReadback === "rgba8" ? { readback: "rgba8" } : {}),
        ...(declaredChangedNodeIndices !== null
          ? { declaredChangedNodeIndices }
          : {}),
        ...(mutationNodeIndices?.size ? { mutationNodeIndices } : {}),
        ...(forceGenerationNodeIndices?.size
          ? { forceGenerationNodeIndices }
          : {}),
        timeMilliseconds,
        readBaseline: (nodeIndex) => {
          const target = this._eventTargetAtIndex?.[nodeIndex];
          return target ? this._frameReadBaselines?.get(target) ?? null : null;
        },
        transitionChangeTimeMilliseconds,
        heldTransition: (nodeIndex, propertyName) =>
          this._heldTransitionDeclaration(nodeIndex, propertyName),
        onTransitionStarted: (transition) =>
          this._registerStartedTransition(transition),
        onTransitionPropertyUnanimated: ({ nodeIndex, propertyName }) => {
          const target = this._eventTargetAtIndex[nodeIndex];
          if (target) {
            recordUnanimatedProperty(isPseudoElementTarget(target) ? target.element : target, propertyName,
              "transition-property");
          }
        },
        computedSamples: {
          core: this._root._domCore,
          owner: this._computedSamples,
          targets: this._eventTargetAtIndex,
        },
        ...(this._glyphResourceManager === null
          ? {}
          : { glyphResourceManager: this._glyphResourceManager }),
        ...(this._pendingAnimationDeclarations.length > 0
          ? {
            prepareEngine: () => {
              for (const declaration of this._pendingAnimationDeclarations) {
                const nodeIndex = this._targetIndex(declaration.target, serialized.indexOf, serialized.pseudoIndexOf);
                if (nodeIndex !== undefined) {
                  declaration.bind(this._persistentRenderer, nodeIndex);
                }
              }
              this._pendingAnimationDeclarations.length = 0;
            },
          }
          : {}),
        ...(this._resolveResource
          ? { resolveResource: this._resolveResource }
          : {}),
        onImageLoadError: this._onImageLoadError,
        svgImageTimings,
        ...(this._capturePaintArtifact
          ? { capturePaintArtifact: true, textCapture: true }
          : captureTextGeometry
          ? {
            captureTextGeometry: true,
            textGeometryArtifactRead: !reuseTextGeometry,
            textCapture: true,
          }
          : {}),
      };
      if (framePage !== null) {
        renderOptions.page = {
          height: scene.height,
          index: framePage,
          rulesKey: framePageRules.key,
          box: (page) => pageBox(framePageRules.rules, page, framePageRules.defaultSize),
        };
      }
      if (this._background !== undefined) {
        renderOptions.background = this._background;
      }
      if (this._selectedRoot !== null && this._selectedRoot !== undefined) {
        const selectedSceneIndex = serialized.indexOf.get(this._selectedRoot);
        if (selectedSceneIndex === undefined) {
          throw new RangeError("The selected root has no scene row: it renders nothing.");
        }
        renderOptions.selectedSceneIndex = selectedSceneIndex;
      }
      if (this._selectedLayer !== null) renderOptions.selectedLayer = this._selectedLayer;
      if (this._textThickening !== undefined) {
        renderOptions.textThickening = this._textThickening;
      }
      if (!rasterize) {
        this._indexOfElement = serialized.indexOf;
        this._indexOfPseudoTarget = serialized.pseudoIndexOf;
        this._redeclareParkedAnimations();
        this._elementAtIndex = nodesAtRow(serialized);
        this._lastBoxes = boxes;
        const supersededSerialized = this._preparedState?.serialized ?? null;
        this._preparedState = Object.freeze({
          scene: Object.freeze({
            width: scene.width,
            height: scene.height,
            nodes: Object.freeze(scene.nodes),
            imageSources: scene.imageSources,
          }),
          serialized,
          boxes: freezeBoxes(boxes),
          // The page the scene was laid out for (scene-renderer's page
          // option), or null for a continuous document.
          page: renderOptions.page ?? null,
        });
        if (
          supersededSerialized !== null &&
          supersededSerialized.publication !== serialized.publication
        ) supersededSerialized.release();
        const publicationToken = this._frameClaim(
          continuation,
          10,
          frameBindings,
        );
        this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
        core.status("frame_finish", continuation);
        accepted = true;
        return this._preparedState;
      }
      const renderToken = this._frameClaim(continuation, FRAME_STAGE.RENDER, frameBindings);
      if (!this._persistentRendererPromise) this._startPersistentRenderer(frameViewport);
      this._stageCounters.currentStage = "raster";
      rasterStartedAt = hostNow();
      const renderer = await this._persistentRendererPromise;
      rendererReadyAt = hostNow();
      await renderer.resize(
        frameViewport.width,
        frameViewport.height,
        frameViewport.deviceScale,
      );
      rendererResizedAt = hostNow();
      if (renderer.setVisibleRectangle) {
        await renderer.setVisibleRectangle(visibleRegion);
      }
      visibleRectangleSetAt = hostNow();
      // Texture delivery is the default: the renderer returns the live GPU
      // texture image plus device, exactly what createCanvasPresenter.present
      // consumes, and no CPU readback happens. Only the webgpu backend can
      // produce it - the webgl2 backend has no GPU texture image to hand
      // over, so it always delivers pixel frames. A pixel capture
      // (renderNow({ pixels: true })) reads back this one frame without
      // presenting it; the finally block schedules a presentation frame so
      // a presenter catches up.
      const textureDelivery = !pixelReadback &&
        renderer.graphicsBackend !== "webgl2";
      // The animation events of this frame's tick wait until the frame
      // ends (the finally block below): their listeners and the reactions
      // to them run as script after the frame, where a read updates the
      // style and starts animations.
      this._animationEventDeferralDepth++;
      let rendered;
      try {
        rendered = textureDelivery
          ? await renderer.renderTexture(scene, renderOptions)
          : await renderer.render(scene, renderOptions);
      } finally {
        this._animationEventDeferralDepth--;
      }
      rasterFinishedAt = hostNow();
      frameTextCapture = rendered.textCapture ?? 0;
      if (this._shutdown) {
        return null;
      }
      this._countRenderWork(rendered.performance);
      this._pageFrame = rendered.page ?? null;
      this._pageTargetStale = false;
      if (this._pageFrame !== null) {
        this._pageBoxes = { key: this._pageFrame.rulesKey, pages: this._pageFrame.pages };
        const { box } = this._pageFrame;
        // A page box this frame did not target (a page not counted before,
        // or rules that changed its box) is rendered again at its own box:
        // renderNow renders once more, and a loop frame is scheduled.
        if (box.width !== visibleRegion.width || box.height !== visibleRegion.height ||
          -box.margin.left !== visibleRegion.x || -box.margin.top !== visibleRegion.y) {
          this._pageTargetStale = true;
          this._forceFullInvalidation = true;
          this._forceFullDamage = true;
          this._dirty = true;
        }
        // Margin boxes whose content this frame did not show (counters of
        // pages not counted before) render again with the counted pages.
        const counted = this._pageMarginBoxesFor(framePage, framePageRules.defaultSize);
        if (JSON.stringify(counted) !== this._pageMarginsKey) {
          this._pageTargetStale = true;
          this._forceFullInvalidation = true;
          this._forceFullDamage = true;
          this._dirty = true;
        }
      }
      this._renderedPage = framePage;
      this._frameResume(continuation, renderToken, 0, -1, frameBindings);
      const publicationToken = this._frameClaim(
        continuation,
        10,
        frameBindings,
      );
      if (rendered.animationTickMilliseconds != null) {
        this._transitionTickMilliseconds = rendered.animationTickMilliseconds;
        // That tick sampled every transition track declared so far.
        for (const timings of this._transitionRecords.values()) {
          for (const timing of timings.values()) timing.trackAwaitsTick = false;
        }
      }
      for (const animation of this._animations) {
        // animationiteration is a CSS animation event.
        if (!(animation instanceof CSSAnimation)) continue;
        for (const elapsedTime of animation._iterationEventsAtCurrentTime()) {
          dispatchEvent(
            animation._element,
            createEvent("animationiteration", {
              bubbles: true,
              animationName: animation._cssAnimationName ?? "",
              elapsedTime,
              pseudoElement: "",
            }),
          );
        }
      }
      // Effective scroll state owner: the engine's clamped offsets from
      // THIS render. Requested state re-syncs to effective at publication,
      // so an idle target's requested offsets always equal its effective
      // offsets and the next input step accumulates on truth.
      //
      // A caller-supplied renderer reports no boxes; scroll sync and the
      // snapshot then need one JS layout pass for current geometry.
      if (!rendered.boxes?.length && boxes.length === 0) {
        boxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          generatedBoxRows: serialized.generatedBoxRows,
          imageSources: serialized.imageSources,
          rowRevision: serialized.rowRevision ?? 0,
        });
      }
      const effectiveBoxes = rendered.boxes?.length ? rendered.boxes : boxes;
      // A caller-supplied renderer that paints no scrollbars never asks for
      // their parts; the frame still publishes its descriptors.
      if (scrollbars === null) describeScrollbars(effectiveBoxes, true);

      const dirtyRectangles = !authoritativeDirtyTiles &&
          rendered.dirtyRects?.length
        ? rendered.dirtyRects.map((rectangle) =>
          Object.freeze({
            x: rectangle.x,
            y: rectangle.y,
            width: rectangle.width ?? rectangle.w,
            height: rectangle.height ?? rectangle.h,
          })
        )
        : requestedDirtyRectangles.map((rectangle) => Object.freeze(rectangle));
      // Change detection follows the rendered result: a pixel frame diffs
      // the readback against the retained snapshot; a texture frame has no
      // CPU pixels, so the renderer's damage is the change — no dirty
      // rectangle means the texture is byte-identical to the presented one
      // and a loop frame delivers nothing.
      const pixelsChanged = rendered.pixels
        ? pixelsDifferInRectangles(
          this._lastPixels,
          rendered.pixels,
          rendered.width,
          dirtyRectangles,
        )
        : dirtyRectangles.length > 0;
      const elementAtIndex = nodesAtRow(serialized);
      // ONE geometry family: the engine's returned boxes (physical layout
      // divided by device scale) are the paint-truth records for scroll
      // facts, scrollbar descriptors, snap, anchoring, and the interaction
      // snapshot. A caller-supplied renderer that reports no boxes keeps
      // the JS layout boxes for this frame instead.
      // The renderer's boxes carry the core's native snapshot of the rows
      // they were read from; the sliced copy keeps it so the presented
      // geometry build joins that snapshot instead of uploading every box
      // again. A host adjustment below (preserved scroll metrics) changes
      // the values and drops it.
      let boxSnapshot = null;
      if (rendered.boxes?.length) {
        // The pre-render layout pass (scroll anchoring, observers) left
        // its own snapshot on `boxes`; the renderer's replaces it.
        if (
          boxes !== rendered.boxes &&
          boxes[BOX_SNAPSHOT] !== rendered.boxes[BOX_SNAPSHOT]
        ) releaseBoxSnapshot(boxes);
        boxes = rendered.boxes.length === serialized.nodes.length
          ? rendered.boxes
          : rendered.boxes.slice(0, serialized.nodes.length);
        const attached = rendered.boxes[BOX_SNAPSHOT];
        if (attached !== undefined && attached.count === boxes.length) {
          boxSnapshot = attached;
        }
        if (
          this._preservedScrollMetrics !== null &&
          this._preservedScrollMetrics.length === boxes.length &&
          this._animations.length === 0 &&
          this._cssAnimations.size === 0 &&
          this._pseudoContentAnimations.size === 0 &&
          this._activeTransitionCount === 0
        ) {
          boxes = boxes.map((box, index) => ({
            ...box,
            ...this._preservedScrollMetrics[index],
          }));
          boxSnapshot = null;
        }
      }
      let presentedBoxes = boxes;
      if (presentedBoxes.length === 0) {
        // A caller-supplied renderer that reports no boxes still presents a
        // frame; the snapshot needs geometry, so run the layout pass here.
        presentedBoxes = await this._layoutTreeBoxes({
          width: frameViewport.width,
          height: frameViewport.height,
          nodes: serialized.nodes,
          generatedBoxRows: serialized.generatedBoxRows,
          imageSources: serialized.imageSources,
          rowRevision: serialized.rowRevision ?? 0,
        });
      }
      const laidOutHere = presentedBoxes !== boxes;
      if (laidOutHere) {
        presentedBoxes = presentedBoxes
          .slice(0, serialized.nodes.length)
          .map((box, index) => Object.freeze({ ...boxes[index], ...box }));
      } else if (
        presentedBoxes !== rendered.boxes || !boxesReadOnly(presentedBoxes)
      ) {
        // The renderer's box objects are complete when it returns them
        // (fragments and SVG path rectangles included) and nothing writes
        // them after, so they are published frozen as they are: a copy of
        // every box on every frame was a measured share of the frame and
        // of its garbage. The renderer's own box list (readEngineBoxes)
        // makes each box, frozen, on its first read and refuses writes; it
        // is published itself, since slicing or freezing it would make
        // every box.
        presentedBoxes = presentedBoxes.slice(0, serialized.nodes.length);
        for (const box of presentedBoxes) Object.freeze(box);
      }
      if (
        boxSnapshot !== null && !laidOutHere &&
        boxSnapshot.count === presentedBoxes.length &&
        presentedBoxes[BOX_SNAPSHOT] !== boxSnapshot
      ) {
        presentedBoxes[BOX_SNAPSHOT] = boxSnapshot;
      }
      freezeBoxes(presentedBoxes);
      // The frame's text geometry store (geometry_text_store), from the
      // renderer's capture and the presented frame's store, whose entries
      // it keeps where their values hold: a text node none of whose rows
      // was lowered anew keeps its glyphs and caret stops while its painted
      // line rectangles keep their sizes, a uniform move becoming its
      // translation. A retained scene with unchanged text carries the
      // presented store: a translation holds no scroll (the geometry records
      // carry it), so a scroll changes none of it.
      const presentedTextStore = this._presentedFrame?.textStore ?? 0;
      const textCarried = this._presentedFrame != null &&
        (reuseTextGeometry || (this._textSelectionEnabled && rendered.performance?.preparation?.retained));
      if (textCarried) {
        if (presentedTextStore !== 0) {
          frameTextStore = core.status("geometry_text_store_carry", presentedTextStore);
        }
      } else if (frameTextCapture !== 0) {
        const keep = serialized.loweredRows !== undefined && !textGeometryStale;
        const rows = keep ? Uint32Array.from(serialized.loweredRows) : null;
        const [rowPointer, rowBytes] = rows === null || rows.length === 0
          ? [0, 0]
          : core.byteInput(new Uint8Array(rows.buffer));
        frameTextStore = core.status("geometry_text_store", frameTextCapture, presentedTextStore,
          rowPointer, rowBytes / Uint32Array.BYTES_PER_ELEMENT, keep ? 1 : 0);
        this._stageCounters.textGeometryOperationsGrouped +=
          new DataView(core.refreshBytes().buffer).getUint32(frameTextCapture + TEXT_CAPTURE_OPERATION_COUNT, true);
      }
      if (frameTextCapture !== 0) {
        core.status("geometry_text_release", frameTextCapture);
        frameTextCapture = 0;
      }
      // A text control's entry carries its live selection.
      if (frameTextStore !== 0) {
        const view = new DataView(core.refreshBytes().buffer);
        const count = view.getUint32(frameTextStore + TEXT_STORE.COUNT, true);
        if (!textCarried) this._stageCounters.textGeometryOwnersGrouped += count;
        for (let index = 0; index < count; index++) {
          const entry = frameTextStore + TEXT_STORE.ENTRIES + index * TEXT_STORE.ENTRY_SIZE;
          if (view.getUint32(entry + TEXT_STORE.ENTRY_KIND, true) !== TEXT_STORE.KIND_CONTROL) continue;
          const control = core.wrapperFor(view.getBigUint64(entry + TEXT_STORE.ENTRY_OWNER, true));
          const start = control.selectionStart ?? control.value.length;
          core.status("geometry_text_store_select", frameTextStore, index, start, control.selectionEnd ?? start);
          if (textCarried) this._stageCounters.translatedTextGeometryEntries++;
        }
      }
      // A frame that reuses the scene's rows for the same page (a tool
      // highlight, a caret, a selection) lays nothing out again: it keeps
      // the prepared state, so layoutTree() and everything keyed on it
      // stay as they are.
      const previousState = this._preparedState;
      const preparedState = previousState !== null &&
          previousState.scene.nodes === scene.nodes &&
          (previousState.page?.index ?? null) === (renderOptions.page?.index ?? null)
        ? previousState
        : Object.freeze({
          scene: Object.freeze({
            width: scene.width,
            height: scene.height,
            nodes: Object.freeze(scene.nodes),
            imageSources: scene.imageSources,
          }),
          serialized,
          boxes: freezeBoxes(boxes),
          page: renderOptions.page ?? null,
        });
      const acceptState = (geometryHandle) => {
        const completedScrollTargets = this._acceptScrollFeedback(
          serialized,
          effectiveBoxes,
          capturedScrollRequests,
        );
        this._scrollbars = scrollbars;
        this._indexOfElement = serialized.indexOf;
        this._indexOfPseudoTarget = serialized.pseudoIndexOf;
        this._redeclareParkedAnimations();
        this._elementAtIndex = elementAtIndex;
        this._refreshScrollAnchors(serialized, boxes, geometryHandle);
        this._lastBoxes = boxes;
        this._snapshotScrollStates(serialized, effectiveBoxes, geometryHandle ?? this._presentedFrame?.geometryHandle);
        this._preparedState = preparedState;
        return completedScrollTargets;
      };
      // A frame that rebuilt stale text geometry publishes it: its pixels
      // match the presented frame, its selection geometry does not.
      if (!forceDelivery && !pixelsChanged && !textGeometryStale) {
        this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
        core.status("frame_finish", continuation);
        accepted = true;
        for (const target of acceptState()) {
          dispatchEvent(target, createEvent("scroll"));
          this._pendingScrollEndTargets.add(target);
        }
        this._revealFocusedCaret(this._presentedFrame?.geometryHandle);
        this._placeSuggestionPopup(this._presentedFrame?.geometryHandle);
        if (resizeObserverLoopError) {
          throw new Error(
            "ResizeObserver loop completed with undelivered notifications",
          );
        }
        return null;
      }

      // A texture delivery publishes no CPU pixels: rendered.pixels is
      // absent and the retained _lastPixels (a prior on-demand capture)
      // describes an older frame, never this one.
      let retainedPixels = this._lastPixels;
      let pixels = rendered.pixels ? retainedPixels : null;
      if (pixelsChanged && rendered.pixels) {
        if (snapshotPixels || retainedPixels === null || retainedPixels.constructor !== rendered.pixels.constructor) {
          retainedPixels = rendered.pixels.slice();
        } else {
          for (const rectangle of dirtyRectangles) {
            const left = Math.max(0, rectangle.x);
            const top = Math.max(0, rectangle.y);
            const right = Math.min(
              rendered.width,
              rectangle.x + rectangle.width,
            );
            const bottom = Math.min(
              rendered.height,
              rectangle.y + rectangle.height,
            );
            for (let row = top; row < bottom; row++) {
              const start = (row * rendered.width + left) * 4;
              retainedPixels.set(
                rendered.pixels.subarray(start, start + (right - left) * 4),
                start,
              );
            }
          }
        }
        pixels = snapshotPixels ? retainedPixels : rendered.pixels;
      }
      if (this._shutdown) return null;
      // A frame whose renderer published only its changed rows, into the
      // previous frame's rows, and laid out no node restyled what the
      // presented frame shows: its geometry derives from that frame's when
      // the core proves the flat tree, the rows and the fragments unchanged
      // (geometry_restyle_successor), and is built otherwise.
      const renderPreparation = rendered.performance?.preparation;
      const restyledInPlace = !scrollOnly &&
        renderPreparation?.rowsPatched === true &&
        renderPreparation.nodesLaidOut === 0;
      const successor = buildInteractionSnapshot({
        sourceRevisions,
        publication: serialized.publication,
        root: this._root,
        viewport: frameViewport,
        viewportIndex: serialized.viewportIndex ?? 0,
        revision: this._frameSequence + 1,
        boxes: presentedBoxes,
        scrollbars,
        timeMilliseconds,
        previousTextGeometry: this._presentedFrame?.textGeometryByNode ?? null,
        textStore: frameTextStore,
        // A frame that only scrolled derives its geometry from the
        // presented one: only boxes, scrollbars and text translations move.
        scrollPredecessor: scrollOnly ? this._presentedFrame : null,
        restyleBasis,
        restyleBasisRefusal,
        restylePredecessor: restyledInPlace ? this._presentedFrame : null,
        frameGeometry: checkpointLayout === null ? null : {
          geometry: checkpointLayout.geometry,
          geometryCore: checkpointLayout.geometry.core, geometryHandle: checkpointLayout.geometry.handle,
          _root: this._root, _publication: checkpointLayout.publication,
          _viewportIndex: serialized.viewportIndex ?? 0, _inputBoxes: checkpointLayout.boxes,
          viewport: { width: checkpointLayout.width, height: checkpointLayout.height, deviceScale: checkpointLayout.deviceScale },
        },
      });
      if (successor._derivation === null) this._stageCounters.geometryBuilds++;
      if (successor._derivation === "frame") this._stageCounters.geometryFrameSuccessorFrames++;
      if (successor._frameGeometryRefusal === "envelope") this._stageCounters.geometryFrameRefusedEnvelope++;
      if (successor._frameGeometryRefusal === "revisions") this._stageCounters.geometryFrameRefusedRevisions++;
      if (successor._derivation === "scroll") {
        this._stageCounters.geometrySuccessorFrames++;
      }
      if (successor._derivation === "restyle") {
        this._stageCounters.geometryRestyleFrames++;
        this._stageCounters.geometryRestyleRecordsRebuilt +=
          successor._successorWork.rebuiltRecords;
        if (successor._successorWork.treeWalked) {
          this._stageCounters.geometryRestyleTreeWalks++;
        }
      }
      if (successor._successorWork !== null) {
        const work = successor._successorWork;
        this._stageCounters.geometrySuccessorElementsResolved += work.elementsResolved;
        this._stageCounters.geometrySuccessorRecordsCopied += work.recordsCopied;
        this._stageCounters.geometrySuccessorRecordsDerived += work.recordsDerived;
        this._stageCounters.geometrySuccessorBoxRowsRead += work.boxRowsRead;
      }
      if (successor._restyleRefusal !== null) {
        this._stageCounters[
          restyleRefusalCounters[successor._restyleRefusal]
        ]++;
      }
      let successorPublished = false;
      releaseUnpublishedSuccessor = () => {
        if (!successorPublished) {
          successor.geometry.release();
          successor.textGeometryByNode.release();
        }
      };
      core.status("frame_publish", continuation, successor.geometryHandle);
      this._frameResume(continuation, publicationToken, 0, -1, frameBindings);
      const framePreparedAt = hostNow();
      // A texture frame carries the renderer's live texture image and
      // device and no pixels; a pixel capture carries the retained snapshot.
      // Encoding is the consumer's explicit request (encodeImage).
      const frame = Object.freeze(
        {
          pixels,
          rowStride: rendered.rowStride,
          channelLayout: rendered.channelLayout,
          sampleType: rendered.sampleType,
          bitsPerSample: rendered.bitsPerSample,
          colorEncoding: rendered.colorEncoding,
          alphaMode: rendered.alphaMode,
          metadata: rendered.metadata,
          width: rendered.width,
          height: rendered.height,
          deviceScale: frameViewport.deviceScale,
          // The CSS-px rectangle of the scene the frame covers, or null for
          // the whole scene (setVisibleRectangle, a page's box): a host
          // places the frame there, as the frame arrives.
          region: visibleRegion === null ? null : Object.freeze({ ...visibleRegion }),
          graphicsBackend: rendered.graphicsBackend,
          graphicsBackendInfo: rendered.graphicsBackendInfo,
          dirtyRectangles,
          pixelRegions: Object.freeze(
            (rendered.pixelRegions ?? []).map((region) =>
              Object.freeze({ ...region })
            ),
          ),
          readbackByteLength: rendered.readbackByteLength,
          frameSequence: this._frameSequence + 1,
          scrollbars: Object.freeze(
            scrollbars.map((scrollbar) => Object.freeze({ ...scrollbar })),
          ),
          timeMilliseconds,
          renderTimings: Object.freeze({
            svgImages: Object.freeze(svgImageTimings),
            preparationMilliseconds: rasterStartedAt - renderStartedAt,
            rendererWaitMilliseconds: rendererReadyAt === null
              ? 0
              : rendererReadyAt - rasterStartedAt,
            resizeMilliseconds: rendererResizedAt === null
              ? 0
              : rendererResizedAt - rendererReadyAt,
            visibleRectangleMilliseconds: visibleRectangleSetAt === null
              ? 0
              : visibleRectangleSetAt - rendererResizedAt,
            rasterMilliseconds: rasterFinishedAt -
              (visibleRectangleSetAt ?? rasterStartedAt),
            postprocessMilliseconds: framePreparedAt - rasterFinishedAt,
            // The part of rasterMilliseconds after layout and the paint
            // walk: resources, the raster plan, and the GPU raster.
            rendererRasterMilliseconds: rendered.performance?.rasterMilliseconds ?? 0,
          }),
          ...(this._capturePaintArtifact
            ? {
              inspection: Object.freeze({
                sceneNodes: Object.freeze(serialized.nodes),
                elementAtIndex: Object.freeze(elementAtIndex),
                layoutBoxes: Object.freeze(
                  rendered.boxes
                    .slice(0, serialized.nodes.length)
                    .map((box) => Object.freeze({ ...box })),
                ),
                paintArtifact: rendered.paintArtifact,
              }),
            }
            : {}),
          textureImage: rendered.textureImage ?? null,
          device: rendered.device ?? null,
        },
      );
      if (this._presentFrame !== null && !pixelReadback) {
        this._stageCounters.currentStage = "present";
        pendingPresentation = () => this._presentFrame(frame);
      }
      let completedScrollTargets = [];
      const publish = () => {
        // Native frame state is released when superseded, not when the
        // collector notices: a geometry snapshot and a publication are
        // megabytes each on a text-bearing page, and WebAssembly memory
        // exerts no pressure on the JavaScript heap.
        const superseded = this._presentedFrame;
        const supersededSerialized = this._preparedState?.serialized ?? null;
        // The held layout of the superseded frame borrows what this frame
        // releases below.
        if (this._syncLayout?.layout.borrowed) this._releaseSyncLayout();
        this._lastPixels = retainedPixels;
        this._lastDeliveredFrame = frame;
        this._lastRendered = rendered;
        this._presentedFrame = successor;
        if (frameLayoutWork !== null) presentedLayoutWork.set(successor, frameLayoutWork);
        successorPublished = true;
        core.status(
          "scroll_presented",
          this._scrollOwner,
          successor.geometryHandle,
        );
        completedScrollTargets = acceptState(successor.geometryHandle);
        this._revealFocusedCaret(successor.geometryHandle);
        this._placeSuggestionPopup(successor.geometryHandle);
        if (superseded !== null && superseded !== successor) {
          superseded.geometry.release();
          superseded.textGeometryByNode.release();
          const supersededSnapshot = superseded._inputBoxes?.[BOX_SNAPSHOT];
          if (
            supersededSnapshot !== undefined &&
            supersededSnapshot !== successor._inputBoxes[BOX_SNAPSHOT] &&
            supersededSnapshot !== boxes[BOX_SNAPSHOT]
          ) {
            releaseBoxSnapshot(superseded._inputBoxes);
          }
        }
        if (
          supersededSerialized !== null &&
          supersededSerialized.publication !== serialized.publication
        ) {
          supersededSerialized.release();
          if (supersededSerialized.nodes !== serialized.nodes) {
            core.releaseSceneResources(supersededSerialized.nodes);
          }
        }
        this._frameSequence = frame.frameSequence;
        this._stageCounters.deliveredFrames++;
      };
      const notify = () => {
        for (const target of completedScrollTargets) {
          dispatchEvent(target, createEvent("scroll"));
          this._pendingScrollEndTargets.add(target);
        }
        // The rendering observers of an animated frame take the sizes and
        // positions it presents: the presented geometry holds the samples
        // the render applied. Their callbacks' changes schedule the next
        // frame, which presents them.
        if (framePage === null) this._offerFrameLayout(serialized, presentedBoxes, sourceRevisions);
        if ((animatedAtStart || this._animating()) && deliverObservers && documentHasRenderingObservers(observerDocument)) {
          deliverRenderingObservers(observerDocument, serialized, presentedBoxes, timeMilliseconds, 0,
            () => successor.geometry);
        }
        this._notifyFrameListeners(frame, resizeObserverLoopError);
      };
      if (this._frameTransaction) {
        this._stagedFrame = {
          handle: continuation,
          revision: BigInt(frame.frameSequence),
          snapshot: successor,
          frame,
          publish,
          notify,
          present: pendingPresentation,
          rollback,
          scrollCapture: capturedScrollRequests,
          dispose: () => {
            capturedScrollRequests.release();
            core.status("frame_dispose", continuation);
            releaseUnpublishedSuccessor();
          },
        };
        accepted = true;
      } else {
        core.status("frame_commit", continuation, BigInt(frame.frameSequence));
        accepted = true;
        publish();
        this._presentingFrame = true;
        try {
          await pendingPresentation?.();
        } finally {
          this._presentingFrame = false;
        }
        // A shutdown during the presentation (the presenter's own callback
        // may shut the surface down) released what notify reads.
        if (!this._shutdown) {
          notify();
          // The next frame is held for the host's next change, which a
          // host that changes the document in its animation frame
          // callbacks makes in the next frame's callbacks
          // (FRAME_WORK_FOLLOW); a held frame that finds none releases it.
          if (this._loopFrameRendering) {
            this._followFrame = true;
            this._schedule();
          }
        }
      }
      return frame;
    } finally {
      if (frameTextCapture !== 0) core.status("geometry_text_release", frameTextCapture);
      if (frameTextStore !== 0) core.status("geometry_text_store_release", frameTextStore);
      restyleBasis?.geometry.release();
      checkpointLayout?.geometry.release();
      readGeometry?.geometry.release();
      if (!accepted) rollback();
      if (!accepted) releaseUnpublishedSuccessor?.();
      if (ownsContinuation && !this._stagedFrame) {
        core.status("frame_dispose", continuation);
      }
      if (capturedScrollRequests !== this._stagedFrame?.scrollCapture) {
        capturedScrollRequests?.release();
      }
      if (restyleCountsBefore !== null && this._frameCore === core) {
        const restyled = (index) =>
          (core.status("computed_restyle_counts", FRAME_RESTYLE_COUNTS[index]) - restyleCountsBefore[index]) >>> 0;
        this._stageCounters.elementsRestyled += restyled(0);
        this._stageCounters.pseudoElementsRestyled += restyled(1);
        this._stageCounters.sceneRestyleRowsRead += restyled(2);
        this._stageCounters.sceneElementsVisited += restyled(3);
        this._stageCounters.sceneBoxesMade += restyled(4);
        this._stageCounters.elementsRestyledUnchanged += restyled(5);
        this._stageCounters.sceneSubtreesReplayed += restyled(6);
      }
      if (ownsContinuation) {
        this._cancelUndeclaredTransitions();
        this._frameReadBaselines = null;
      }
      this._eventElementAtIndex = null;
      this._eventTargetAtIndex = null;
      this._stageCounters.currentStage = "idle";
      this._rendering = false;
      // A shutdown during this frame's presentation does not wait for the
      // frame (shutdown()), and it released the surface's native state:
      // the frame ends by settling its idle waiters.
      if (this._shutdown) {
        for (const resolve of this._idleWaiters.splice(0)) resolve();
      } else {
        if (ownsContinuation) {
          const frameEvents = this._deferredAnimationEvents;
          this._deferredAnimationEvents = [];
          for (const { element, event } of frameEvents) dispatchEvent(element, event);
          // The fields whose value changed in this frame go to the host's
          // spellchecker (src/dom/spellcheck.js).
          if (accepted) sendSpellcheckRequests(this._root.ownerDocument ?? this._root);
          // A picker that opened in this frame goes to the host that draws
          // its kind (src/dom/host-picker.js).
          if (accepted) sendPickerRequest(this._root.ownerDocument ?? this._root, this._root);
        }
        // A native change that landed after this frame sealed its scene (a
        // font face or an image its own layout pass loaded) belongs to the
        // next frame, and no host mutation callback reports it: only the
        // frame surface holds it. That frame follows now, instead of the next
        // input's frame paying for it.
        if (accepted && !this._dirty && this._mutationConsequence > 0) this._dirty = true;
        if (this._snapCheckOwed && !this._dirty) {
          this._snapCheckOwed = false;
          this._snapCheckPending = this._snapCheckPending ||
            this._snappedTargets.size > 0 || this._snapContainersInLastBuild();
        }
        const idleWaiters = this._idleWaiters.splice(0);
        for (const resolve of idleWaiters) resolve();
        if (this._deferredAnimationEvents.length > 0 || this._hasActiveAnimationWork() || this._scrollMomentum) {
          this._dirty = true;
        }
        if (pixelReadback && this._presentFrame !== null) {
          // The capture bypassed presentation delivery; schedule one
          // presentation frame so the presenter shows the captured state.
          // The engine is clean after the capture, so that frame reuses the
          // retained texture (webgpu) or re-delivers pixels (webgl2).
          this._dirty = true;
        }
        this._schedule();
      }
    }
  }
  inspectMotion() {
    if (this._shutdown) throw new Error("render surface is shut down");
    return createMotionModel(this).inspection;
  }

  prepareNow({ deliverObservers = true } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (this._frameTransaction) return Promise.resolve(this._preparedState);
    return this._render(
      this._currentTime,
      true,
      false,
      false,
      deliverObservers,
    );
  }

  async *captureFrames({
    frameBudget,
    durationMilliseconds,
  } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    const core = this._root._domCore;
    core.status("frame_capture_check", FRAME_CAPTURE_SURFACE, ...core.valueListInput([
      this._running || this._frameRequest !== null ? 1 : 0,
      this._capturingFrames ? 1 : 0,
      frameBudget,
    ]));
    const model = createMotionModel(this);
    // The schedule holds at most this many samples; a larger budget
    // cannot be filled.
    const sampleLimit = model.exports.schedule_sample_limit();
    if (frameBudget > sampleLimit) {
      throw new RangeError(
        `frameBudget ${frameBudget} exceeds the capture schedule limit of ${sampleLimit} samples; ` +
          `use a frameBudget of at most ${sampleLimit}`,
      );
    }
    const captureDuration = durationMilliseconds ??
      model.inspection.finiteDurationMilliseconds;
    const captures = core.status("frame_capture_check", FRAME_CAPTURE_MOTION, ...core.valueListInput([
      model.inspection.classification,
      captureDuration,
    ]));
    if (captures === 0) return;
    // A failed schedule operation throws the Error that WAT gives for it.
    const scheduleFailure = (operation, effectIndex) =>
      core.status("frame_capture_check", FRAME_CAPTURE_SCHEDULE, ...core.valueListInput([
        operation,
        model.exports.motion_error(),
        effectIndex,
      ]));
    const startTime = this.currentTime;
    const endTime = startTime + captureDuration;
    if (!model.exports.schedule_prepare(startTime, endTime, frameBudget)) {
      scheduleFailure(MOTION_SCHEDULE_PREPARE, 0);
    }
    for (const effect of model.scheduleEffects) {
      if (!effect.progressing || effect.external) continue;
      if (!model.exports.schedule_add_effect(effect.effectIndex)) {
        scheduleFailure(MOTION_SCHEDULE_EFFECT, effect.effectIndex);
      }
      for (const keyframe of effect.keyframes) {
        if (
          !model.exports.schedule_add_keyframe(
            effect.effectIndex,
            keyframe.offset,
            effect.discrete ? 1 : 0,
          )
        ) {
          scheduleFailure(MOTION_SCHEDULE_KEYFRAME, effect.effectIndex);
        }
      }
    }
    if (!model.exports.schedule_finalize()) {
      const requiredMinimum = model.exports.schedule_count();
      throw new RangeError(
        `frameBudget ${frameBudget} is below the ${requiredMinimum} mandatory samples`,
      );
    }

    // The capture drives the document's clock: a page timer runs when the
    // capture's time passes its due time, and the document's time is held
    // at the latest sample's time until its clock passes it.
    this._capturingFrames = true;
    if (this._drivesDocumentClock()) this._root.ownerDocument._documentTimers?.driverChanged();
    try {
      const sampleCount = model.exports.schedule_count();
      for (let sequence = 0; sequence + 1 < sampleCount; sequence++) {
        const timeMilliseconds = model.exports.schedule_time(sequence);
        const nextTimeMilliseconds = model.exports.schedule_time(sequence + 1);
        await this._advanceDocumentClock(timeMilliseconds);
        this._updateAnimationsAndSendEvents(timeMilliseconds);
        const frame = await this._renderOpportunity(
          timeMilliseconds,
          true,
          false,
          true,
        );
        yield Object.freeze({
          sequence,
          timeMilliseconds,
          durationMilliseconds: nextTimeMilliseconds - timeMilliseconds,
          width: frame?.width ?? core.exports.frame_device_extent(
            this._visibleRectangle?.width ?? this.viewport.width,
            this.viewport.deviceScale,
          ),
          height: frame?.height ?? core.exports.frame_device_extent(
            this._visibleRectangle?.height ?? this.viewport.height,
            this.viewport.deviceScale,
          ),
          pixels: frame?.pixels ?? this._lastPixels,
          dirtyRectangles: frame?.dirtyRectangles ?? Object.freeze([]),
          pixelStorage: "borrowed",
          readbackByteLength: frame?.readbackByteLength ?? 0,
        });
      }
      await this._advanceDocumentClock(endTime);
      this._updateAnimationsAndSendEvents(endTime);
      await this._renderOpportunity(endTime, true, false, true);
    } finally {
      this._capturingFrames = false;
      if (this._drivesDocumentClock()) this._root.ownerDocument._documentTimers?.driverChanged();
    }
  }

  whenIdle() {
    if (!this._rendering && !this._animationCheckpoint) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  // The display list of the last prepared frame; of a paged document, the
  // list of the page that frame shows, and `page` names it as
  // `surface.page` does (null for a continuous document). A frame that
  // publishes releases the serialization of the scene it supersedes. The
  // artifact reads the prepared scene when no frame is in flight and queues
  // its engine operation in the same turn, so a later frame publishes, and
  // releases this scene, only after the artifact.
  async createDisplayListArtifact() {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (this._preparedState === null) {
      throw new Error(
        "createDisplayListArtifact requires one completed render frame",
      );
    }
    const renderer = await this._persistentRendererPromise;
    while (this._rendering || this._animationCheckpoint) await this.whenIdle();
    if (this._shutdown) throw new Error("render surface is shut down");
    const { scene, page: pageOption } = this._preparedState;
    const page = pageOption === null ? null : this.page;
    const artifact = await renderer.createDisplayListArtifact(scene, { page: pageOption });
    return { ...artifact, page };
  }

  // The one render entry. Delivers the renderer's GPU texture frame on
  // WebGPU (no readback); `pixels: true` reads this frame back into a
  // retained CPU snapshot of float32 samples for encoding or inspection, and
  // `pixels: "rgba8"` of the rgba8unorm render precision's uint8 samples.
  // WebGL 2 always delivers pixels.
  renderNow({ pixels = false, _transaction = null } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (pixels !== false && pixels !== true && pixels !== "rgba8") {
      throw new TypeError(`renderNow: pixels must be false, true, or "rgba8", got ${JSON.stringify(pixels)}`);
    }
    const timeMilliseconds = this._now();
    const render = () => this._renderOpportunity(timeMilliseconds, true, true, pixels, _transaction);
    // A page frame that targeted another box than its page's (the page's
    // box was not known before its count) renders again at its own box.
    // The count is recorded by then, so the second frame knows the box.
    return this._afterDocumentClock(timeMilliseconds, async () => {
      this._updateAnimationsAndSendEvents(timeMilliseconds);
      const frame = await render();
      if (!this._pageTargetStale) return frame;
      const again = await render();
      if (this._pageTargetStale) {
        throw new Error(
          `page ${this._pageFrame.index + 1} rendered twice without its page box ${this._pageFrame.box.width} x ${this._pageFrame.box.height} px as the target`,
        );
      }
      return again;
    });
  }

  tick(timeMilliseconds) {
    if (this._shutdown) throw new Error("render surface is shut down");
    return this._afterDocumentClock(timeMilliseconds, () => {
      this._updateAnimationsAndSendEvents(timeMilliseconds);
      this._markOverlaysDue(timeMilliseconds);
      return this._renderOpportunity(timeMilliseconds, false);
    });
  }

  // Renders at `timeMilliseconds` after the page timers due by then ran.
  _afterDocumentClock(timeMilliseconds, render) {
    const advancing = this._advanceDocumentClock(timeMilliseconds);
    if (advancing === null) return render();
    return advancing.then(() => {
      if (this._shutdown) throw new Error("render surface is shut down");
      return render();
    });
  }

  // Whether the live loop renders frames (start() and stop()), and the
  // sequence number of the last delivered frame.
  get running() {
    return this._running;
  }

  get frameSequence() {
    return this._frameSequence;
  }

  start() {
    if (this._shutdown) throw new Error("render surface is shut down");
    this._running = true;
    this._schedule();
    if (this._drivesDocumentClock()) this._root.ownerDocument._documentTimers?.driverChanged();
  }

  stop() {
    if (this._shutdown) return;
    this._running = false;
    if (this._frameRequest !== null) {
      this._cancelFrame(this._frameRequest);
      this._frameRequest = null;
    }
    this._cancelCaretTimer();
    this._cancelSpinTimer();
    if (this._drivesDocumentClock()) this._root.ownerDocument._documentTimers?.driverChanged();
  }

  replaceRoot(nextRoot) {
    if (this._shutdown) throw new Error("render surface is shut down");
    nextRoot = resolveSurfaceRoot(nextRoot, "replaceRoot");
    if (nextRoot.parentElement) {
      throw new Error("replaceRoot: next root must be detached");
    }
    if (nextRoot._renderSurface && nextRoot._renderSurface !== this) {
      throw new Error("replaceRoot: next root belongs to another live surface");
    }
    const nextRegistry = nextRoot._renderSurfaces ??= new Map();
    const nextOccupant = nextRegistry.get(this._environmentKey);
    if (nextOccupant && nextOccupant !== this) {
      throw new Error(
        `replaceRoot: next root already has a live render surface for ` +
          `environment ${this._environmentKey}`,
      );
    }
    if (this._persistentRenderer && this._indexOfElement.size > 0) {
      this._persistentRenderer.remapAnimations(new Map());
      this._animations.length = 0;
      this._animationsAwaitingTimeline.clear();
      this._animationsPausePending.clear();
    }
    const previousRegistry = this._root._renderSurfaces;
    const wasPrimary = this._root._renderSurface === this;
    this._disconnectSubtree(this._root);
    previousRegistry?.delete(this._environmentKey);
    if (wasPrimary) {
      previousRegistry?.values().next().value?._connectSubtree(this._root);
    }
    this._frameCore.status("frame_surface_dispose", this._frameOwner);
    this._frameCore.status("scroll_owner_release", this._scrollOwner);
    this._frameCore = nextRoot._domCore;
    this._frameOwner = this._frameCore.status(
      "frame_surface_create",
      nextRoot._coreHandle,
    );
    this._frameBindings = createFrameBindings(this._frameCore);
    this._scrollOwner = this._frameCore.status("scroll_owner_create");
    this._frameCore.status(
      "scroll_owner_bind",
      this._scrollOwner,
      nextRoot._coreHandle,
    );
    this._scrollGeometry = null;
    this._root = nextRoot;
    nextRegistry.set(this._environmentKey, this);
    this._document._liveRenderSurfaces.delete(this);
    this._document = surfaceDocument(nextRoot);
    (this._document._liveRenderSurfaces ??= new Set()).add(this);
    // The new root demands its images through its own document's host.
    this._resolveResource = this._document._resolveResource ?? null;
    this._connectSubtree(nextRoot);
    this.viewport.root = nextRoot;
    this._indexOfElement = new Map();
    this._indexOfPseudoTarget = new Map();
    this._elementAtIndex = [];
    this._presentedFrame = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._selectionChanged = false;
    this._preservedScrollMetrics = null;
    this._scrollAnchors.clear();
    this._anchoringSuppressionProperties.clear();
    this._positionSuppressionNodes.clear();
    this._pendingSnapOrigins.clear();
    this._snappedTargets.clear();
    this._snapCheckPending = false;
    this._snapCheckOwed = true;
    this._smoothScrolls.clear();
    this._forceFullInvalidation = true;
    this._forceFullDamage = true;
    this._dirty = true;
    this._schedule();
  }

  async shutdown() {
    if (this._shutdown) return;
    this.stop();
    this._shutdown = true;
    if (!this._presentingFrame) await this.whenIdle();
    this._root.ownerDocument?._styleSystem?.environmentListeners.delete(this._environmentListener);
    if (this._pageRuleCache) {
      releasePageRules(this._pageRuleCache.rules);
      this._pageRuleCache = null;
    }
    this._scrollbarVisibility.release();
    this._scrollAnchors.clear();
    this._anchoringSuppressionProperties.clear();
    this._positionSuppressionNodes.clear();
    this._animationEventUnsubscribe?.();
    // The root's later scene builds, from any surface, have no margin boxes.
    this._applyPageMargins(this._root._domCore, null);
    // Chrome cancels the CSS animations and transitions of an element that
    // leaves the rendering: they become idle and reject `finished`. A
    // script animation keeps its current time without a timeline.
    for (const animation of [...this._animations]) {
      if (animation instanceof CSSAnimation) animation._cancelByUserAgent();
      else animation._moveToPendingTimeline();
    }
    for (const records of [...this._transitionRecords.values()]) {
      for (const record of [...records.values()]) record.animation.cancel();
    }
    for (const transitions of [...this._pendingTransitions.values()]) {
      for (const animation of [...transitions.values()]) animation.cancel();
    }
    this._pendingTransitions.clear();
    this._readBaselines.clear();
    this._animations.length = 0;
    this._animationsAwaitingTimeline.clear();
    this._animationsPausePending.clear();
    const surfaceRegistry = this._root._renderSurfaces;
    const wasPrimary = this._root._renderSurface === this;
    this._disconnectSubtree(this._root);
    surfaceRegistry?.delete(this._environmentKey);
    this._document._liveRenderSurfaces.delete(this);
    if (wasPrimary) {
      // Promote any remaining surface over this root to primary: it claims
      // the node _renderSurface slots the shutdown just released.
      surfaceRegistry?.values().next().value?._connectSubtree(this._root);
    }
    const ownerDocument = this._root.ownerDocument;
    if (ownerDocument?._componentRenderSurface === this) {
      ownerDocument._componentRenderSurface =
        surfaceRegistry?.values().next().value ?? null;
      ownerDocument._documentTimers?.driverChanged();
    }
    const animationFrameCheckpoint = this._animationFrameCore.status(
      "animation_frame_surface_dispose",
      this._animationFrameOwner,
    );
    if (animationFrameCheckpoint) {
      this._releaseDocumentAnimationFrameCheckpoint(animationFrameCheckpoint);
    }
    this._frameCore.status("frame_surface_dispose", this._frameOwner);
    this.viewport._surface = null;
    this.viewport.root = null;
    this._activeTransitionCount = 0;
    this._frameListeners.length = 0;
    this._indexOfElement = new Map();
    this._indexOfPseudoTarget = new Map();
    this._lastPixels = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._lastBoxes = [];
    this._presentedFrame = null;
    this._mutatedNodes.clear();
    this._forcedGenerationNodes.clear();
    this._selectionChanged = false;
    this._transformOnlyMutations.clear();
    this._hasNonTransformMutation = false;
    this._hasNonStateMutation = false;
    this._pendingSnapOrigins.clear();
    this._snappedTargets.clear();
    this._snapCheckPending = false;
    this._forceStateDelivery = false;
    this._pendingScrollSources.clear();
    this._pendingScrollEndTargets.clear();
    this._smoothScrolls.clear();
    this._scrollGeometry?.imported.release();
    this._scrollGeometry = null;
    this._root._domCore.status("scroll_owner_release", this._scrollOwner);
    this._scrollOwner = 0n;
    // The renderer releases its engine side even when its graphics context
    // failed to start.
    if (this._persistentRenderer) await this._persistentRenderer.shutdown();
    this._root._domCore.status("computed_samples_release", this._computedSamples);
    this._computedSamples = 0;
    this._releaseSyncLayout();
    this._dropPlannedSerialization();
    this._frameCore.releaseSceneResources(
      this._preparedState?.serialized?.nodes,
    );
    this._preparedState?.serialized?.release?.();
    this._preparedState = null;
    this._scrollbars = [];
    for (const declaration of this._pendingAnimationDeclarations) {
      declaration.release?.();
    }
    this._pendingAnimationDeclarations.length = 0;
  }
}
