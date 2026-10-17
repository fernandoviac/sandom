import { serializeToScene } from "./serialize.js";
import { SandomHostError } from "../host/contract.js";
import { validateClosedRecord } from "../closed-record.js";
import { hostNow, hostTimeOrigin } from "../host-clock.js";
import { assertClockOptions, DocumentClock, documentTimeline, realClockSource } from "./document-clock.js";
import {
  createSceneRenderer,
  engineCounters,
  layoutTreeBoxes,
} from "../scene-renderer.js";
import {
  deliverRenderingObservers,
  documentHasRenderingObservers,
} from "./rendering-observers.js";
import {
  animationsForElement,
  createDOMAnimation,
  CSSAnimation,
  CSSTransition,
  removeReplacedAnimations,
  takePendingAnimations,
} from "./animation.js";
import { createEvent, dispatchEvent, SDAnimationPlaybackEvent } from "./events.js";
import { scheduleFocusFixup } from "./input-activation.js";
import { SandomViewport } from "./viewport.js";
import { computeScrollbars, snapshotScrollbars } from "./scrollbars.js";
import { paintScrollbars } from "./scrollbar-paint.js";
import { assertScrollbarStyle, ScrollbarVisibility } from "./scrollbar-visibility.js";
import { sampleScrollTimeline } from "./scroll-timeline.js";
import { pageBox, pageCounters, pageMarginBoxes, parsePageRules, releasePageRules } from "./page-rules.js";
import { PAGE_MARGIN_BOXES } from "../wasm/layout.js";
import {
  NativeScrollCapture,
  NativeScrollCollection,
  NativeScrollMotions,
  NativeScrollSuppression,
  scrollCore,
  scrollRead,
  scrollRequest,
  scrollState,
  withScrollGeometry,
} from "./scroll-core.js";
import {
  BOX_SNAPSHOT,
  boxesReadOnly,
  freezeBoxes,
  releaseBoxSnapshot,
} from "../dom-wasm/geometry-wire.js";
import { buildInteractionSnapshot } from "./presented-frame.js";
import {
  keptTextGeometryFor,
  sameTextGeometryValues,
  selectionRectangles,
  TextGeometryView,
  uniqueCaretStops,
} from "./geometry.js";
import { recordUnanimatedProperty, resolvedElementFields, resolvedOverflowAxes } from "./style.js";
import {
  animationCSSInsertion,
  deferAnimationBinding,
  reconcileAnimationDefinitions,
  sampleAnimationContent as pseudoContentAt,
} from "../dom-wasm/animation.js";
import { normalizeOffsets } from "../animations.js";
import { instantiate as instantiateMotionCapture } from "../wasm/motion-capture-binary.js";
import { createFrameBindings } from "./dom-bindings.generated.js";
import { shadowIncludingParent } from "./shadow.js";

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

// Root membership for many nodes: a walk stops at the
// first node an earlier walk passed, and every node it passes takes the
// answer, so a frame's text owners cost one walk per distinct ancestor
// rather than one per text operation.
function shadowIncludingInclusiveDescendantTest(ancestor) {
  const verdicts = new Map([[ancestor, true]]);
  const walked = [];
  return (node) => {
    let verdict = false;
    for (let current = node; current !== null; current = shadowIncludingParent(current)) {
      const known = verdicts.get(current);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      walked.push(current);
    }
    for (const passed of walked) verdicts.set(passed, verdict);
    walked.length = 0;
    return verdict;
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

const MOTION_CLASSIFICATIONS = ["static", "finite", "unbounded", "external"];
function freezeMotionValue(value) {
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

// The pseudo-class states whose change only restyles: the scene build
// reads no other state of them. Checkedness and selectedness are not
// among them (a menulist's label is its selected option's), nor are
// custom states and definedness.
const RESTYLE_STATES = new Set([
  "hover",
  "active",
  "focus",
  "focus-within",
]);

// The frameStageCounters counter of each engine_record_restyle refusal,
// by its result.
const SCENE_RESTYLE_REFUSALS = [
  undefined,
  "sceneRestyleRefusedBuild",
  "sceneRestyleRefusedList",
  "sceneRestyleRefusedGeneration",
  "sceneRestyleRefusedOverflow",
  "sceneRestyleRefusedRoot",
  "sceneRestyleRefusedContents",
  "sceneRestyleRefusedStructure",
];

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
      Object.entries(keyframe).filter(([name]) =>
        name !== "offset" && name !== "easing" && name !== "composite"
      ).map(([name, value]) => [name, freezeMotionValue(value)]),
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

function renderedChangeFromKeyframes(propertyNames, keyframes) {
  let hasUnknownProperty = false;
  for (const propertyName of propertyNames) {
    const signatures = keyframes.flatMap((keyframe) =>
      propertyName in keyframe.valueSignatures
        ? [keyframe.valueSignatures[propertyName]]
        : []
    );
    if (new Set(signatures).size > 1) return true;
    if (signatures.length < 2) hasUnknownProperty = true;
  }
  return hasUnknownProperty ? null : false;
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
    const propertyNames = [
      ...new Set(
        keyframes.flatMap((keyframe) =>
          Object.keys(keyframe).filter((name) =>
            name !== "offset" && name !== "easing" && name !== "composite"
          )
        ),
      ),
    ];
    const normalizedKeyframes = normalizeMotionKeyframes(keyframes);
    const changesRenderedOutput = renderedChangeFromKeyframes(
      propertyNames,
      normalizedKeyframes,
    );
    const external = animation._isScrollDriven();
    const progressing = animation.playState === "running" &&
      animation.playbackRate !== 0 && changesRenderedOutput !== false;
    const startTimeMilliseconds = animation.startTime ??
      surface.currentTime -
        (animation.currentTime ?? 0) / (Math.abs(animation.playbackRate) || 1);
    const delayMilliseconds = Number(timing.delay ?? 0);
    const durationMilliseconds = Number(timing.duration ?? 0);
    const iterationCount = Number(timing.iterations ?? 1);
    const localTimeMilliseconds =
      (surface.currentTime - startTimeMilliseconds) * animation.playbackRate;
    const activeTimeMilliseconds = localTimeMilliseconds - delayMilliseconds;
    const activeDurationMilliseconds = durationMilliseconds * iterationCount;
    const phase = external
      ? "external"
      : activeTimeMilliseconds < 0
      ? "before"
      : activeTimeMilliseconds < activeDurationMilliseconds
      ? "active"
      : "after";
    const fill = timing.fill ?? "none";
    const effectMembershipAtInspection = phase === "active" ||
      (phase === "before" && (fill === "backwards" || fill === "both")) ||
      (phase === "after" && (fill === "forwards" || fill === "both"));
    const iterationIndex = phase === "active" && durationMilliseconds > 0
      ? Math.floor(activeTimeMilliseconds / durationMilliseconds)
      : null;
    const iterationProgress = iterationIndex === null
      ? null
      : (activeTimeMilliseconds -
        iterationIndex * durationMilliseconds) / durationMilliseconds;
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
        const activeTimeMilliseconds = surface.currentTime -
          record.startTimeMilliseconds - delayMilliseconds;
        const activeDurationMilliseconds = durationMilliseconds *
          iterationCount;
        const phase = activeTimeMilliseconds < 0
          ? "before"
          : activeTimeMilliseconds < activeDurationMilliseconds
          ? "active"
          : "after";
        const fill = timing.fill ?? "none";
        const effectMembershipAtInspection = phase === "active" ||
          (phase === "before" && (fill === "backwards" || fill === "both")) ||
          (phase === "after" && (fill === "forwards" || fill === "both"));
        const iterationIndex = phase === "active" && durationMilliseconds > 0
          ? Math.floor(activeTimeMilliseconds / durationMilliseconds)
          : null;
        const iterationProgress = iterationIndex === null
          ? null
          : (activeTimeMilliseconds -
            iterationIndex * durationMilliseconds) / durationMilliseconds;
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
          localTimeMilliseconds: surface.currentTime -
            record.startTimeMilliseconds,
          activeTimeMilliseconds,
          iterationIndex,
          iterationProgress,
          effectMembershipAtInspection,
          changesRenderedOutput,
          changesUnderlyingState: false,
          initialGeneratedContent: freezeMotionValue(record.initialContent),
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

  for (const [element, timings] of surface._transitionRecords) {
    for (const [propertyName, timing] of timings) {
      // The track's timing at inspection: a paused transition's start
      // follows the clock, so its local time holds.
      const animation = timing.animation;
      const startTimeMilliseconds = animation._value(6);
      const delayMilliseconds = animation._value(8);
      const durationMilliseconds = animation._value(7);
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
      const activeTimeMilliseconds = surface.currentTime -
        startTimeMilliseconds - delayMilliseconds;
      const phase = activeTimeMilliseconds < 0
        ? "before"
        : activeTimeMilliseconds < durationMilliseconds
        ? "active"
        : "after";
      effects.push(Object.freeze({
        kind: "transition",
        element,
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
        phase,
        localTimeMilliseconds: surface.currentTime - startTimeMilliseconds,
        activeTimeMilliseconds,
        iterationIndex: phase === "active" ? 0 : null,
        iterationProgress: phase === "active" && durationMilliseconds > 0
          ? activeTimeMilliseconds / durationMilliseconds
          : null,
        effectMembershipAtInspection: phase === "active",
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
    MOTION_CLASSIFICATIONS[exports.motion_classification()];
  const finiteEnd = exports.motion_finite_end();
  const inspection = Object.freeze({
    classification,
    inspectedAtMilliseconds: surface.currentTime,
    finiteDurationMilliseconds: classification === "finite"
      ? Math.max(0, finiteEnd - surface.currentTime)
      : null,
    effects: Object.freeze(effects),
  });
  return { exports, inspection, scheduleEffects };
}
const NODE_DESCRIPTIONS = {
  1: "an element",
  3: "a text node",
  4: "a CDATA section",
  7: "a processing instruction",
  8: "a comment node",
  9: "a document",
  10: "a document type",
  11: "a document fragment",
};
function describeRoot(root) {
  if (root === null || root === undefined) return String(root);
  if (typeof root !== "object") return `a ${typeof root}`;
  if (!root._domCore) return "an object that is not a DOM node";
  return NODE_DESCRIPTIONS[root.nodeType] ?? `a node of type ${root.nodeType}`;
}
// The document whose stylesheets style a surface root: the root itself for a
// document, else its owner document, whether or not the root is attached.
function surfaceDocument(root) {
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  if (!document) {
    throw new Error(`render surface: root <${root.nodeName}> has no owner document, so no stylesheet can reach it`);
  }
  return document;
}

// A surface renders one element's box tree. A document is the root a host
// rendering a whole page has, so it resolves to its document element — which
// is also what makes a host-owned top element unnecessary. Anything else is
// refused here, by type, rather than by a statistic from the first frame's
// animation-candidate scan.
function resolveSurfaceRoot(root, operation) {
  const nodeType = root?._domCore ? root.nodeType : 0;
  if (nodeType === 9) {
    const documentElement = root.documentElement;
    if (!documentElement) {
      throw new TypeError(
        `${operation}: root must be an element or a document with a document ` +
          `element, received a document with no document element`,
      );
    }
    return documentElement;
  }
  if (nodeType !== 1) {
    throw new TypeError(
      `${operation}: root must be an element or a document, received ${
        describeRoot(root)
      }`,
    );
  }
  return root;
}

// A broken image paints nothing, as in Chrome. The document keeps one
// recoverable diagnostic for each URL, owner and property; a prepared
// document gives it to the host with its font diagnostics.
const GENERATED_BOX_PSEUDO_ELEMENTS = { 14: "::before", 15: "::after" };
function recordBrokenImageDiagnostic(element, node, property, requestedURL, failure, error) {
  const document = element.ownerDocument;
  const pseudoElement = GENERATED_BOX_PSEUDO_ELEMENTS[node._coreBox & 0xff] ?? "";
  const ownerElement = `${element.localName}${element.id ? `#${element.id}` : ""}${pseudoElement}`;
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

function boxRectangle(box, deviceScale) {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  return {
    x: Math.floor(box.x * deviceScale),
    y: Math.floor(box.y * deviceScale),
    width: Math.ceil(box.w * deviceScale),
    height: Math.ceil(box.h * deviceScale),
  };
}

function pixelsDifferInRectangles(previous, current, width, rectangles) {
  if (!previous || previous.length !== current.length) return true;
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

// Layout box kinds by the scene's box kind code (scene-build.watpart).
const LAYOUT_BOX_KINDS = Object.freeze([
  undefined, "element", "text", "anonymous inline", "::before text", "::after text",
  "line feed", "form value", "placeholder", "list marker", "marker wrapper",
  "contents root", "anonymous table box", "viewport", "::before", "::after",
  "alternative text container", "broken image icon",
  ...Array(14),
  // Page boxes (32-48) and their text (64-80): the page-margin boxes in
  // PAGE_MARGIN_BOXES order, then the page background.
  ...PAGE_MARGIN_BOXES.map((name) => `@${name}`), "@page",
  ...Array(15),
  ...PAGE_MARGIN_BOXES.map((name) => `@${name} text`), "@page text",
]);

// What identifies a planned transition across reads: its endpoints and
// timing. A read that plans the same transition again keeps its pending
// CSSTransition.
function transitionPlanKey({ definition, startValue, endValue }) {
  return JSON.stringify([definition.duration, definition.delay, definition.easing, startValue, endValue]);
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

// `now` and `requestFrame` are one clock (assertClockOptions). A surface
// over a document whose clock is fixed runs on that clock: it takes it when
// the caller supplies none, and refuses another one, so a page never reads
// one clock while its surface renders on another.
function surfaceClockSource(options, ownerDocument) {
  const documentClock = ownerDocument?._clock ?? null;
  if (documentClock === null) {
    return options.now === undefined
      ? { ...realClockSource, real: true }
      : { now: options.now, requestFrame: options.requestFrame, cancelFrame: options.cancelFrame ?? (() => {}), real: false };
  }
  if (options.now !== undefined && options.now !== documentClock.source.now) {
    throw new TypeError(
      `render surface options: the document of this root runs on the ${documentClock.real ? "host's real clock" : "clock its host injected"}, and a surface over it runs on that clock; omit now, requestFrame and cancelFrame, or give the clock to the document when you create it (renderComponent, prepareRenderInput or createSandomDOM: now, requestFrame, cancelFrame, timeOrigin)`,
    );
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
      viewport = null,
      // The persistent renderer shares the document runtime's scene
      // renderer (one WASM engine, glyph manager, and WebGPU device across
      // every surface of that runtime) with a per-surface renderer and
      // render context. Callers needing full isolation (fresh engine and
      // device) pass createPersistentSceneRenderer here explicitly.
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
    this._background = undefined;
    if (background !== undefined) {
      const { r, g, b, a } = background ?? {};
      if (
        !Number.isFinite(r) || !Number.isFinite(g) ||
        !Number.isFinite(b) || !Number.isFinite(a) || a < 0 || a > 1
      ) {
        throw new TypeError(
          "render surface options: background requires finite r, g, b, a components with alpha between 0 and 1",
        );
      }
      this._background = Object.freeze({ r, g, b, a });
    }
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
    if (root.parentElement) {
      const documentElement = root.ownerDocument?.documentElement;
      if (!documentElement?.contains(root)) {
        throw new Error(
          "createRenderSurface: root must be a detached DOM tree root or belong to a document",
        );
      }
      root = documentElement;
    }
    const clock = surfaceClockSource(options, root.ownerDocument);
    this.viewport = viewport ?? new SandomViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScale,
    });
    if (!(this.viewport instanceof SandomViewport) || this.viewport._surface) {
      throw new Error(
        "createRenderSurface: viewport must be an unattached SandomViewport",
      );
    }
    this.viewport._surface = this;
    this.viewport.root = root;
    const ownerDocument = root.ownerDocument;
    // The scrollbar style is part of the style environment: a classic bar
    // takes layout space, so a change re-lowers every record.
    ownerDocument?._styleSystem?.setEnvironment({
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
      scrollbarStyle: this.scrollbarStyle,
    });
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
    // A caller-supplied factory chooses its own device. Otherwise the
    // renderer adopts the device the document's canvases already use (a
    // WebGPU context's configured device, or the one a Canvas 2D toBlob()
    // requested before the first paint), read when the renderer is created,
    // as render-component does, so a canvas bitmap and the renderer that
    // paints it are on one device. A document without one adopts the
    // renderer's (_startPersistentRenderer).
    const sceneRendererFactory = sceneRendererRuntime?.createSceneRenderer ??
      createSceneRenderer;
    const persistentRendererFactory = createPersistentRenderer ??
      ((rendererOptions) =>
        sceneRendererFactory({
          ...rendererOptions,
          graphicsDevice: this._document._preferredCanvasDevice ?? undefined,
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
      (root.nodeType === 9 ? root : ownerDocument)?._resolveResource ?? null;
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
      // the last frame other than a RESTYLE_STATES state change. Viewport:
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
    this._frameTransaction = frameTransaction;
    this._stagedFrame = null;
    this._frameSequence = 0;
    this._viewportRevision = 0n;
    this._eventElementAtIndex = null;
    this._dirty = true;
    this._rendering = false;
    this._running = true;
    this._idleWaiters = [];
    this._shutdown = false;
    this._lastPixels = null;
    this._lastDeliveredFrame = null;
    this._lastRendered = null;
    this._indexOfElement = new Map();
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
    // Whether a mutation since the last frame was anything but a change of
    // one of RESTYLE_STATES; only a frame without one may restyle the
    // retained scene (frame mode 4).
    this._hasNonStateMutation = false;
    // Tree mutations recorded under the root (insertions, removals, shadow
    // roots attached). The text geometry grouping keeps its owner
    // classification (_textOwnerKinds) until the next one.
    this._structureMutations = 0;
    this._textOwnerKinds = null;
    this._scrollOwner = root._domCore.status("scroll_owner_create");
    root._domCore.status(
      "scroll_owner_bind",
      this._scrollOwner,
      root._coreHandle,
    );
    this._scrollAnchors = new NativeScrollCollection(this, 4);
    this._anchoringSuppressionProperties = new NativeScrollSuppression(this, 1);
    this._positionSuppressionNodes = new NativeScrollSuppression(this, 2);
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
    this._pendingTransitionsKey = null;
    // The pending transitions of the frame in progress.
    this._frameHeldTransitions = null;
    this._animations = [];
    // Animations this surface adopted from a document's pending timeline
    // (element.animate() before any surface existed). They hold until the
    // first frame gives them a time to start from.
    this._animationsAwaitingTimeline = new Set();
    this._animationCancelingThroughEngine = null;
    this._cssAnimations = new Map();
    this._pseudoContentAnimations = new Map();
    this._pendingScrollSources = new NativeScrollCollection(this, 0);
    this._pendingScrollEndTargets = new NativeScrollCollection(this, 1);
    this._capturingFrames = false;
    this._advancingDocumentClock = false;
    this._pendingSnapOrigins = new NativeScrollCollection(this, 2);
    this._snappedTargets = new NativeScrollCollection(this, 3);
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

  // The box tree of the last prepared frame, for inspection: one entry per
  // layout box in tree order, as laid out. Each entry is { index, parent
  // (an index, or -1), children (indices), kind, display, node (the DOM
  // node the box comes from, the originating element of a ::before or
  // ::after box, or null for an anonymous box), text (a text box's text),
  // rect, content }. `kind` names the box: "element", "text", "anonymous
  // inline", "::before", "::after", "::before text", "::after text", "line
  // feed", "form value", "placeholder", "list marker", "marker wrapper",
  // "contents root", "anonymous table box" or "viewport". `rect` and
  // `content` are the border and content boxes in viewport CSS pixels of
  // the frame as scrolled, without transforms. A text node's box takes the
  // union of its glyph runs in the presented frame; generated text, which
  // has no node of its own, has a null rect. The same frame returns the same
  // frozen array.
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
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const box = offPage.has(index) ? null : boxes[index];
      const parent = parents[index];
      const kindCode = (node._coreBox ?? (node.display === "text" ? 2 : 0)) & 0xff;
      const kind = LAYOUT_BOX_KINDS[kindCode];
      if (kind === undefined) {
        throw new Error(`layoutTree: box ${index} has kind ${kindCode}, which has no name; add it to LAYOUT_BOX_KINDS`);
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
      });
    }
    this._layoutTreeFor = prepared;
    this._layoutTree = Object.freeze(entries);
    return this._layoutTree;
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
    const smoothMotion = this._smoothScrolls.get(target);
    const activeOwner = smoothMotion
      ? Object.freeze({ kind: "smooth", source: smoothMotion.source })
      : this._scrollMomentum && this._scrollMomentumTarget === target
      ? Object.freeze({ kind: "momentum", source: "pointer" })
      : this._scrollInteractionActive &&
          this._scrollInteractionTarget === target
      ? Object.freeze({ kind: "interaction", source: "pointer" })
      : this._pendingScrollSources.has(target)
      ? Object.freeze({
        kind: "request",
        source: this._pendingScrollSources.get(target),
      })
      : null;
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
      minimumLeft: fact(16),
      maximumLeft: fact(17),
      minimumTop: fact(18),
      maximumTop: fact(19),
      scrollWidth: fact(10),
      scrollHeight: fact(11),
      activeOwner,
      pendingScroll: this._pendingScrollSources.has(target),
      pendingScrollEnd: this._pendingScrollEndTargets.has(target),
    });
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
    if (node._renderSurface && node._renderSurface !== this) {
      throw new Error("node belongs to another live render surface");
    }
    node._renderSurface = this;
    this._adoptPendingAnimations(node);
    for (const child of node.childNodes) this._connectSubtree(child);
    if (node._shadowRoot) this._connectSubtree(node._shadowRoot);
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
      this._animationsAwaitingTimeline.add(animation);
    }
    this._scheduleAnimationFrame(node);
  }
  _disconnectSubtree(node) {
    if (node._renderSurface !== this) return;
    this._forgetNodeState(node);
    if (node._scrollState) {
      node._domCore.status("scroll_detach", node._scrollState);
    }
    node._renderSurface = null;
    for (const child of node.childNodes) this._disconnectSubtree(child);
    if (node._shadowRoot) this._disconnectSubtree(node._shadowRoot);
  }
  // Per-surface bookkeeping cleanup for one removed node — shared between
  // the primary's slot-releasing disconnect above and the follower fanout
  // below, which must never touch the primary's _renderSurface slots.
  _forgetNodeState(node) {
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
    this._forgetNodeState(node);
    for (const child of node.childNodes) this._forgetSubtreeState(child);
    if (node._shadowRoot) this._forgetSubtreeState(node._shadowRoot);
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

  _frameFlags(rasterize, deliverObservers, pixelReadback) {
    const document = this._root.ownerDocument;
    const style = document?._styleSystem;
    return 1 |
      (this._preparedState !== null && this._presentedFrame !== null ? 2 : 0) |
      (this._pendingScrollSources.size > 0 ? 4 : 0) |
      (this._animations.length + this._cssAnimations.size +
            this._pseudoContentAnimations.size + this._activeTransitionCount +
            this._pendingAnimationDeclarations.length > 0
        ? 8
        : 0) |
      // An animation sample the retained scene cannot carry, and only that,
      // owes a re-serialization. Every declared animation and transition is
      // an engine track sampled natively from the retained rows, so a frame
      // whose only change is such a sample reuses the scene; animated
      // generated content is authored INTO the serialized rows here
      // (_animatedGeneratedContent), and an unbound declaration still needs
      // a scene to take its node index from.
      (this._pseudoContentAnimations.size > 0 ||
          this._pendingAnimationDeclarations.length > 0
        ? 131072
        : 0) |
      (documentHasRenderingObservers(document) ? 16 : 0) |
      (this._pendingObserverDelivery ? 32 : 0) |
      (this._forceFullInvalidation ? 64 : 0) |
      (this._forceFullDamage ? 262144 : 0) |
      (style !== undefined &&
          this._serializedStyleGeneration === style.generation &&
          this._serializedViewportWidth === this.viewport.width &&
          this._serializedViewportHeight === this.viewport.height &&
          this._serializedViewportScale === this.viewport.deviceScale
        ? 128
        : 0) |
      (rasterize ? 256 : 0) |
      // A pixel capture after a texture delivery cannot merge into the
      // retained pixel snapshot (the texture frames changed tiles it never
      // saw), so it reads the whole target back; consecutive pixel frames
      // stay incremental.
      (pixelReadback &&
          this._persistentRenderer?.graphicsBackend !== "webgl2" &&
          !this._lastRendered?.pixels
        ? 512
        : 0) |
      (this._scrollAnchors.size > 0 ? 2048 : 0) |
      (this._animations.some((animation) => animation._isScrollDriven())
        ? 4096
        : 0) |
      (deliverObservers ? 8192 : 0) |
      (this._lastBoxes.length > 0 ? 16384 : 0) |
      (this._lastPixels !== null || this._frameSequence > 0 ? 65536 : 0);
  }

  // Frame mode 4: restyles the retained publication in place
  // (engine_record_restyle) instead of building the scene. Answers whether
  // it did; a frame it refuses builds the scene, and the refusal is counted
  // by its reason.
  _restyleRetainedPublication(core, frameViewport, styleSystem) {
    const counters = this._stageCounters;
    if (this._hasNonStateMutation) {
      counters.sceneRestyleRefusedMutation++;
      return false;
    }
    if (
      this._serializedViewportWidth !== frameViewport.width ||
      this._serializedViewportHeight !== frameViewport.height ||
      this._serializedViewportScale !== frameViewport.deviceScale
    ) {
      counters.sceneRestyleRefusedViewport++;
      return false;
    }
    // Sampled before the restyle, as a serialization samples it before its
    // walk.
    const styleGeneration = styleSystem === undefined
      ? -1
      : styleSystem.generation;
    const refusal = core.status(
      "engine_record_restyle",
      this._preparedState.serialized.publication,
      this._root._coreHandle,
    );
    if (refusal !== 0) {
      const counter = SCENE_RESTYLE_REFUSALS[refusal];
      if (counter === undefined) {
        throw new Error(`engine_record_restyle answered ${refusal}`);
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
        node._coreRecord = core.engineRecordCopy(
          box.stableId,
          box.sourceRevision,
        );
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
    return bindings.frame_resume(frame, token, 0, facts, depth);
  }

  _recordMutation(kind, node, detail) {
    if (this._shutdown) throw new Error("render surface is shut down");
    if (node && kind !== "selection") this._mutatedNodes.add(node);
    if (kind === "style" && detail === "transform" && node) {
      this._transformOnlyMutations.add(node);
    } else {
      this._hasNonTransformMutation = true;
    }
    if (kind !== "state" || !RESTYLE_STATES.has(detail)) {
      this._hasNonStateMutation = true;
    }
    if (kind === "structure") this._structureMutations++;
    if (kind === "selection") this._selectionChanged = true;
    // Native records classify DOM fields before callback delivery. Only
    // host-owned bitmap and interaction changes enter as normalized facts.
    if (kind === "state" || kind === "selection" || kind === "canvas-paint") {
      this._frameCore.status("frame_surface_invalidate", this._frameOwner, 1);
    } else if (kind === "canvas-size") {
      this._frameCore.status("frame_surface_invalidate", this._frameOwner, 2);
    }
    const consequence = this._mutationConsequence;
    if (consequence === 3) this._forceFullInvalidation = true;
    if (kind === "style") {
      node._domCore.status(
        "scroll_suppress",
        this._scrollOwner,
        node._coreHandle,
        ...node._domCore.input(detail),
      );
    }
    // Frame listeners observe interaction state as well as pixels. Preserve
    // a state-only checkpoint even when focus does not change the raster.
    if (kind === "state") this._forceStateDelivery = true;
    if (kind === "canvas-paint" || kind === "canvas-size") {
      this._forcedGenerationNodes.add(node);
    }
    this._dirty = true;
    // A paint-only mutation cannot move boxes, so it cannot owe a snap
    // re-check; a layout or structural consequence owes one, which the
    // frame answers from the core's snap-container list.
    if (consequence >= 2) {
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
      if (!scrollRead(target, 5)) this._pendingScrollSources.delete(target);
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
      (viewportBox.scrollLeft !== scrollRead(viewport, 2) ||
        viewportBox.scrollTop !== scrollRead(viewport, 3)) &&
      scrollCore(viewport).status(
        "scroll_accept",
        scrollState(viewport),
        scrollRead(viewport, 7),
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
  // frame, before its animation frame callbacks): the replaced script
  // animations leave the effect stack, and each fires `remove` (Web
  // Animations 1, section 5.5), in composite order.
  _updateAnimationsAndSendEvents(timeMilliseconds) {
    if (this._shutdown) return;
    const removed = removeReplacedAnimations(this._animations, timeMilliseconds);
    if (removed.length === 0) return;
    const timelineTime = documentTimeline(this._root.ownerDocument)?.currentTime ?? null;
    const events = removed.map((animation) => {
      const currentTime = animation._core.status("animation_value", animation._animationId, 0, timeMilliseconds);
      return new SDAnimationPlaybackEvent("remove", {
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

  _runDocumentAnimationFrameCheckpoint(timeMilliseconds) {
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
      }
    } finally {
      this._releaseDocumentAnimationFrameCheckpoint(checkpoint);
    }
  }

  _recordViewportResize(previousEnvironment = null) {
    if (this._shutdown) throw new Error("render surface is shut down");
    this._viewportRevision++;
    this._frameCore.status("frame_surface_invalidate", this._frameOwner, 2);
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
    const densityOnlyResize = previousEnvironment !== null &&
      previousEnvironment.width === this.viewport.width &&
      previousEnvironment.height === this.viewport.height &&
      previousEnvironment.deviceScale !== this.viewport.deviceScale;
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
    if (rectangle !== null) {
      const { x, y, width, height } = rectangle;
      if (
        !(width > 0) || !(height > 0) || !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        throw new RangeError(
          "visibleRectangle requires finite x/y and positive width/height",
        );
      }
    }
    const previous = this._visibleRectangle;
    if (
      previous === rectangle ||
      (previous !== null && rectangle !== null &&
        previous.x === rectangle.x && previous.y === rectangle.y &&
        previous.width === rectangle.width &&
        previous.height === rectangle.height)
    ) return;
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

  /** Tool overlay: paints `rectangles` above the document and its
   * scrollbars, as a browser's developer tools paint their highlight. Each
   * is { x, y, width, height, color: { r, g, b, a } } in viewport CSS
   * pixels, colour channels 0 to 1. An empty list paints none.
   */
  setToolHighlights(rectangles) {
    if (!Array.isArray(rectangles)) {
      throw new TypeError(`setToolHighlights takes an array of rectangles, not ${typeof rectangles}`);
    }
    this._toolHighlights = Object.freeze(rectangles.map((rectangle, index) => {
      const { x, y, width, height, color } = rectangle ?? {};
      if (![x, y, width, height, color?.r, color?.g, color?.b, color?.a].every(Number.isFinite)) {
        throw new TypeError(
          `setToolHighlights rectangle ${index} needs finite x, y, width, height and color { r, g, b, a }: ${JSON.stringify(rectangle)}`,
        );
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
    if (index !== null && !(Number.isInteger(index) && index >= 0)) {
      throw new RangeError(`setPage needs a page index of 0 or more, or null; got ${index}`);
    }
    if (index === this._page) return;
    // Entering or leaving paged media changes how the viewport scrolls and
    // takes a full frame. Another page of a paged document reuses the
    // retained scene (frame mode 3): the renderer keeps the rows the engine
    // holds and seeks the page from the starts it recorded while it counted
    // the pages. The presented frame shows another page, so it is not
    // delivered again (_retainedDeliveryPossible).
    if ((index === null) !== (this._page === null)) {
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
      side: index % 2 === 0 ? "right" : "left",
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
        side: pageIndex % 2 === 0 ? "right" : "left",
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
      0,
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
      1,
    );
    return node ? this._root._domCore.wrapperFor(node) : this.viewport;
  }

  // An input run executed scroll action `action` on this surface's scroll
  // owner (src/dom-wasm/input-run.watpart state 9): 7 chain and 11
  // scrollbar, which owe a frame and a snap check when they moved; 9 the
  // end of an interaction; 10 momentum, which owes frames while it runs.
  _inputScrolled(action, changed) {
    if (action === 7 || action === 11) {
      if (!changed) return;
      this._snapCheckPending = true;
      this._dirty = true;
      this._schedule();
    } else if (action === 9) {
      this._schedule();
    } else if (action === 10) {
      this._dirty ||= changed;
      this._schedule();
    }
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
    const focusedHandle =
      focused && (focused.localName === "input" || focused.localName === "textarea")
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
    if (
      this._scrollInteractionActive || this._scrollMomentum ||
      !this._presentedFrame?.geometryHandle
    ) return false;
    // A pending check re-snaps every snap container of the tree, which is a
    // walk of every element. A tree whose last build had none owes no walk,
    // unless styles changed since that build. Scrollers already snapped or
    // owing a snap take theirs either way.
    const walkTree = this._snapCheckPending &&
      (this._snapContainersInLastBuild() ||
        this._root.ownerDocument?._styleSystem?.generation !==
          this._serializedStyleGeneration);
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

  // A caret is on screen when the presented frame carries one. The surface
  // then keeps asking for frames, the way a running animation does, so the
  // blink phase can flip; the frame that flips it changes nothing that
  // feeds serialization, so it reuses the retained scene.
  _caretBlinkActive() {
    return (this._frameCore.status("frame_caret_state", this._frameOwner, 0) & 1) !== 0;
  }

  _caretBlinkDue(timeMilliseconds) {
    return (this._frameCore.status(
      "frame_caret_state", this._frameOwner, timeMilliseconds,
    ) & 2) !== 0;
  }

  // The CSS cursor the engine resolves at a document point, written to the
  // host's element. Called from input dispatch, which is the only moment
  // the answer can change: the pointer moved, or what is under it did.
  _applyCursor(x, y) {
    const target = this._cursorTarget;
    if (!target || this._shutdown || !this._presentedFrame) return;
    let cursor;
    try {
      cursor = this._presentedFrame.geometryCore.string(
        "input_pointer_cursor",
        this._presentedFrame.geometryHandle,
        x,
        y,
      );
    } catch {
      // A cursor query against geometry that has just been released is not
      // a host error; the next pointer event asks again.
      return;
    }
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

  _schedule() {
    if (
      this._frameTransaction ||
      !this._running || this._shutdown || this._rendering ||
      this._advancingDocumentClock ||
      (!this._animationFrameCore.status(
        "animation_frame_pending",
        this._animationFrameOwner,
      ) &&
        !this._dirty &&
        !this._caretBlinkActive() &&
        !this._scrollbarVisibility.active &&
        ((this._pendingScrollEndTargets.size === 0 &&
          !this._snapCheckPending) ||
          this._scrollInteractionActive) &&
        !this._documentTimersAwaitFrame()) ||
      this._frameRequest !== null
    ) return;
    this._frameRequest = this._requestFrame((timeMilliseconds) => {
      this._frameRequest = null;
      const frameTimeMilliseconds = timeMilliseconds ?? this._now();
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
    });
  }

  // The rendering steps of one loop-scheduled frame.
  _frame(frameTimeMilliseconds) {
    // The style update at the start of a frame checks the focus (focus
    // fixup, input-activation.js), before the animation frame callbacks.
    scheduleFocusFixup(this._root);
    // Native snapshots detach before invoking. Exceptions still reach the
    // realm sink without preventing the remaining callbacks or the render.
    this._updateAnimationsAndSendEvents(frameTimeMilliseconds);
    this._runDocumentAnimationFrameCheckpoint(frameTimeMilliseconds);
    if (this._caretBlinkDue(frameTimeMilliseconds)) {
      this._dirty = true;
    }
    // An overlay bar that starts or continues to fade, or a pointer that
    // entered or left a bar, changes the overlay without a DOM change.
    if (
      this._scrollbarVisibility.due(this._scrollbars, frameTimeMilliseconds)
    ) {
      this._dirty = true;
    }
    if (!this._dirty) {
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
    return this._renderOpportunity(
      frameTimeMilliseconds,
      forceStateDelivery,
    ).then((result) => {
      this._failedLoopFrames = 0;
      return result;
    }, (error) => {
      this._failedLoopFrames = (this._failedLoopFrames ?? 0) + 1;
      if (this._failedLoopFrames >= 3) {
        this._failedLoopFrames = 0;
        this.stop();
        this._reportBackgroundException(new Error(
          `The render surface stopped its frame loop after 3 failed frames in a row; call start() after fixing the cause. Last failure: ${error?.message ?? error}`,
          { cause: error },
        ));
        return;
      }
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
      timeOrigin: this._nowIsHostTime ? hostTimeOrigin : 0,
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

  // Whether this surface's frames come now: its loop runs, or a capture
  // samples. While they do not, the document's page timers ask the
  // document clock's frame source for frames themselves.
  _framesAdvanceDocumentClock() {
    return !this._shutdown && (this._running || this._capturingFrames);
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
  // drives the document, a pending page timer keeps a frame requested.
  _documentTimersAwaitFrame() {
    const document = this._root.ownerDocument;
    return document?._clock?.real === false && this._drivesDocumentClock() &&
      (document._documentTimers?.hasPending ?? false);
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
    return cleanSceneReuse && !pixelReadback &&
      this._renderedPage === this._page &&
      !this._pageTargetStale &&
      this._toolHighlightsRendered === this._toolHighlights &&
      this._frameTransaction === null &&
      rendered !== null && presented !== null &&
      this._lastDeliveredFrame !== null &&
      this._frameCore.status("frame_consequence", continuation) === 0 &&
      mutatedNodes.size === 0 && forcedGenerationNodes.size === 0 &&
      capturedScrollRequests.size === 0 &&
      !this._hasActiveAnimationWork() && !this._scrollMomentum &&
      !rendered.animationActive &&
      this._pendingAnimationDeclarations.length === 0 &&
      this._frameCore.status(
          "geometry_revision",
          presented.geometryHandle,
          2,
        ) === sourceRevisions.resource &&
      (rendered.paintArtifact !== undefined ||
          rendered.textGeometryArtifact !== undefined) ===
        (this._capturePaintArtifact ||
          (this._textSelectionEnabled &&
            this._preparedState.serialized.textBoxes > 0)) &&
      (rendered.pixels !== undefined) ===
        (this._persistentRenderer?.graphicsBackend === "webgl2");
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
    const element = this._eventElementAtIndex[transition.nodeIndex];
    if (!element) return;
    this._transitionTimings.get(element)?.get(transition.propertyName)?.animation
      ?._settleReplaced();
    const held = this._frameHeldTransitions?.get(element)?.get(transition.propertyName);
    this._frameHeldTransitions?.get(element)?.delete(transition.propertyName);
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
        element,
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
      pseudoElement: "",
    }));
  }

  // The identity and timing that the frame declares the track of a pending
  // CSSTransition with: the transition's start time resolves at this
  // frame (Web Animations 1, section 4.4.4), and the track runs at the
  // start time, playback rate and generation that the object then holds.
  // Null when no running pending transition holds the change.
  _heldTransitionDeclaration(nodeIndex, propertyName) {
    const element = this._eventElementAtIndex[nodeIndex];
    const animation = element ? this._frameHeldTransitions?.get(element)?.get(propertyName) : undefined;
    if (animation === undefined || animation.playState === "idle") return null;
    animation._resolveTimeline();
    return {
      animationId: animation._animationId,
      trackGeneration: animation._value(5),
      timing: {
        startTime: animation._value(6),
        duration: animation._value(7),
        delay: animation._value(8),
        direction: animation._value(9) ? "reverse" : "normal",
      },
    };
  }

  // A read between frames that reports animations (getAnimations())
  // updates the style first, as Chrome does: the CSS animations and the
  // transitions that the style change since the last frame starts exist
  // from then on, and stay pending until the next frame starts them.
  _startStyleChangeAnimations() {
    if (this._shutdown || this._rendering) return;
    const styleSystem = this._root.ownerDocument?._styleSystem;
    if (!styleSystem) return;
    this._prepareStyleSystem(styleSystem);
    this._synchronizeCSSAnimations(this._frameCore, styleSystem, null);
    this._planPendingTransitions(styleSystem);
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
  // in the root's scope no element has a definition, so the walk, which
  // resolves every element, is skipped and every element counts as a
  // non-candidate. A frame passes its time; a read between frames passes
  // null: its CSS animations are pending (_createAnimation), and its
  // ::before and ::after content animations start at the next frame.
  _synchronizeCSSAnimations(core, styleSystem, timeMilliseconds) {
    if (this._animationSyncStyleGeneration === styleSystem.generation) return;
    this._animationSyncStyleGeneration = styleSystem.generation;
    core.mediaEnvironmentSet(styleSystem.environment);
    const declaresKeyframes = styleSystem.declaresKeyframes(this._root);
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
      for (const record of records) record.animation.cancel();
      this._cssAnimations.delete(element);
    }
    for (const element of activeElements) {
      const previousRecords = this._cssAnimations.get(element) ?? [];
      const desiredDefinitions = reconcileAnimationDefinitions(
        styleSystem.animationDefinitions(element),
        previousRecords,
      );
      const previousAnimationIndices = new Map(
        previousRecords.map((record) => [
          record.identity,
          this._animations.indexOf(record.animation),
        ]),
      );
      const reusableByIdentity = new Map();
      for (const desired of desiredDefinitions) {
        if (desired.reusable) {
          reusableByIdentity.set(desired.identity, desired.reusable);
        }
      }
      for (const previous of previousRecords) {
        if (reusableByIdentity.get(previous.identity) !== previous) {
          previous.animation.cancel();
        }
      }

      const nextRecords = [];
      for (
        let definitionIndex = 0;
        definitionIndex < desiredDefinitions.length;
        definitionIndex++
      ) {
        const desired = desiredDefinitions[definitionIndex];
        const reusable = reusableByIdentity.get(desired.identity);
        if (reusable) {
          nextRecords.push(reusable);
          continue;
        }
        const followingReusableRecords = desiredDefinitions.slice(
          definitionIndex + 1,
        ).map((following) => reusableByIdentity.get(following.identity))
          .filter(Boolean);
        const followingAnimationIndex = followingReusableRecords.length > 0
          ? this._animations.indexOf(
            followingReusableRecords[0].animation,
          )
          : -1;
        const precedingAnimationIndex = nextRecords.length > 0
          ? this._animations.indexOf(nextRecords.at(-1).animation)
          : -1;
        const previousAnimationIndex = previousAnimationIndices.get(
          desired.identity,
        );
        const firstPreviousAnimationIndex = previousAnimationIndices.size >
            0
          ? Math.min(...previousAnimationIndices.values())
          : this._animations.length;
        const insertionIndex = animationCSSInsertion(
          followingAnimationIndex,
          precedingAnimationIndex,
          previousAnimationIndex,
          firstPreviousAnimationIndex,
          this._animations.length,
        );
        const animation = this._createAnimation(
          element,
          desired.definition.keyframes,
          {
            ...desired.definition.timing,
            composite: desired.definition.composition,
          },
          {
            insertionIndex,
            beforeEngineHandles: followingReusableRecords.map((record) =>
              record.animation._engineHandle
            ),
            diagnosticAnimationName: desired.definition.name,
            implicitKeyframe: desired.definition.implicitKeyframe,
          },
        );
        animation._cascadingStyleSheetsAnimationIdentity = desired.identity;
        if (desired.definition.paused) animation.pause();
        nextRecords.push({
          ...desired,
          animation,
        });
      }
      for (
        let recordIndex = 0;
        recordIndex < nextRecords.length;
        recordIndex++
      ) {
        nextRecords[recordIndex].animation._engineDeclarationOptions
          .beforeEngineHandles = nextRecords.slice(recordIndex + 1).map(
            (record) => record.animation._engineHandle,
          );
      }
      if (nextRecords.length === 0) {
        this._cssAnimations.delete(element);
        continue;
      }
      const cascadingStyleSheetsAnimationSlots = [];
      for (
        let animationIndex = 0;
        animationIndex < this._animations.length;
        animationIndex++
      ) {
        const animation = this._animations[animationIndex];
        if (
          animation._element === element &&
          animation._cascadingStyleSheetsAnimationIdentity !== undefined
        ) {
          cascadingStyleSheetsAnimationSlots.push(animationIndex);
        }
      }
      for (
        let recordIndex = 0;
        recordIndex < nextRecords.length;
        recordIndex++
      ) {
        this._animations[cascadingStyleSheetsAnimationSlots[recordIndex]] =
          nextRecords[recordIndex].animation;
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
          const propertyNames = new Set(
            definition.keyframes.flatMap((keyframe) =>
              Object.keys(keyframe).filter((name) =>
                name !== "offset" && name !== "easing" &&
                name !== "composite"
              )
            ),
          );
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
        const nextRecords = desiredRecords.map((desired) => {
          if (desired.reusable) return desired.reusable;
          return {
            ...desired,
            element,
            pseudoElement,
            startTimeMilliseconds: timeMilliseconds,
            initialContent: desired.definition.keyframes[0]?.content,
          };
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
  _planPendingTransitions(styleSystem) {
    const renderer = this._persistentRenderer;
    if (!renderer || this._presentedFrame === null) return;
    const core = this._frameCore;
    const generation = styleSystem.generation;
    if (generation === this._serializedStyleGeneration) return;
    const key = this._pendingTransitionsKey;
    if (key?.frameSequence === this._frameSequence && key.styleGeneration === generation) return;
    this._pendingTransitionsKey = { frameSequence: this._frameSequence, styleGeneration: generation };
    const viewport = this.viewport;
    const serialized = serializeToScene(this._root, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        deviceScale: viewport.deviceScale ?? 1,
        _requestedLeft: viewport._requestedLeft,
        _requestedTop: viewport._requestedTop,
      },
    });
    const planned = new Map();
    try {
      const elementAtRow = nodesAtRow(serialized);
      const nodes = serialized.nodes;
      for (let index = 0; index < nodes.length; index++) {
        if (!nodes[index].transitionDefinitions?.length) continue;
        const element = elementAtRow[index];
        const previousIndex = this._indexOfElement.get(element);
        if (previousIndex === undefined) continue;
        const transitions = renderer.planStyleChangeTransitions(previousIndex, nodes[index]);
        if (transitions.length > 0) {
          planned.set(element, new Map(transitions.map((transition) => [transition.propertyName, transition])));
        }
      }
    } finally {
      serialized.release();
      core.releaseSceneResources(serialized.nodes);
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
    for (const [element, transitions] of planned) {
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
        record.animation = new CSSTransition(this, element, propertyName, record, this._frameSequence);
        record.animation._styleChangePlan = transitionPlanKey(transition);
        let held = this._pendingTransitions.get(element);
        if (held === undefined) {
          held = new Map();
          this._pendingTransitions.set(element, held);
        }
        held.set(propertyName, record.animation);
        this._scheduleAnimationFrame(element);
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

  // The registry holds each running or paused transition of an element
  // under its property; one whose property a newer transition took stays
  // out.
  _registerTransitionAnimation(animation) {
    const element = animation._element;
    const propertyName = animation._transitionProperty;
    let timings = this._transitionTimings.get(element);
    if (!timings) {
      timings = new Map();
      this._transitionTimings.set(element, timings);
    }
    if (timings.has(propertyName)) return;
    timings.set(propertyName, animation._transitionRecord);
    let records = this._transitionRecords.get(element);
    if (!records) {
      records = new Map();
      this._transitionRecords.set(element, records);
    }
    records.set(propertyName, animation._transitionRecord);
    this._activeTransitionCount++;
  }

  _unregisterTransition(animation) {
    const element = animation._element;
    const timings = this._transitionTimings.get(element);
    if (timings?.get(animation._transitionProperty)?.animation !== animation) return;
    timings.delete(animation._transitionProperty);
    const records = this._transitionRecords.get(element);
    records?.delete(animation._transitionProperty);
    if (records?.size === 0) this._transitionRecords.delete(element);
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
    const promise = this._createPersistentRenderer({
      width,
      height,
      deviceScale,
      ...this._persistentRendererOptions,
    }).then((renderer) => {
      this._persistentRenderer = renderer;
      this._animationEventUnsubscribe = renderer.onAnimationEvent(
        (record) => this._dispatchEngineAnimationEvent(record),
      );
      return renderer;
    });
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
    const element = (this._eventElementAtIndex ?? this._elementAtIndex)[
      record.nodeIndex
    ];
    if (!element) {
      throw new RangeError(
        `No DOM element for animated layout index ${record.nodeIndex}`,
      );
    }
    const transitionAnimation = this._transitionTimings.get(element)
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
        if (!scriptAnimation) dispatchEvent(
          element,
          createEvent(record.type, {
            bubbles: true,
            propertyName: record.propertyName,
            animationName: matchingAnimation?._cssAnimationName ?? "",
            elapsedTime: matchingAnimation
              ? matchingAnimation._elapsedTimeForEvent(record.type)
              : 0,
            pseudoElement: "",
          }),
        );
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
    for (const [element, timings] of this._transitionRecords) {
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
        const elementLabel = `${element.localName}${
          element.id ? `#${element.id}` : ""
        }`;
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
    const pseudoContentIsActive = [...this._pseudoContentAnimations.values()]
      .some((pseudoElements) =>
        [...pseudoElements.values()].some((records) =>
          records.some((record) => {
            if (record.definition.paused) return false;
            const { duration, delay = 0, iterations = 1 } =
              record.definition.timing;
            const endTimeMilliseconds = record.startTimeMilliseconds + delay +
              duration * iterations;
            return !Number.isFinite(endTimeMilliseconds) ||
              this._currentTime < endTimeMilliseconds;
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
    this._advanceSmoothScrolls(timeMilliseconds);
    if (this._hasActiveAnimationWork()) {
      this._dirty = true;
      for (const animation of this._animations) {
        if (animation._needsFrame()) this._mutatedNodes.add(animation._element);
      }
      for (const [element] of this._transitionRecords) {
        this._mutatedNodes.add(element);
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
    );
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
  // Declares through the renderer, or, before the renderer has the
  // element's row, defers the declaration to the frame that writes it.
  _declareEngineEffect(element, declare) {
    const nodeIndex = this._indexOfElement.get(element);
    if (this._persistentRenderer && nodeIndex !== undefined) {
      return declare(this._persistentRenderer, nodeIndex);
    }
    const deferred = deferAnimationBinding(declare);
    this._pendingAnimationDeclarations.push({
      element,
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
  }

  _restoreAnimation(animation) {
    if (!this._animations.includes(animation)) this._animations.push(animation);
  }

  // The current text of every animated ::before/::after, for the core's
  // scene build: an entry per element and pseudo-element whose content
  // animation has a record.
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
      // write, but the frame still skips serializing and laying out again.
      if (
        held.styleGeneration === styleGeneration &&
        held.resourceRevision === resourceRevision &&
        held.scrollRevision === scrollRevision
      ) return false;
      this._releaseSyncLayout();
    }
    this._syncLayout = {
      layout,
      styleGeneration,
      resourceRevision,
      scrollRevision,
      frameSequence: this._frameSequence,
      timeMilliseconds: this._now(),
    };
    return true;
  }
  // The held layout for another synchronous getter, left held: it answers
  // while the style generation, resource revision, scroll positions and
  // viewport are unchanged, no frame has rendered since (a frame samples
  // the engine's animation tracks, which the layout inherits), and nothing
  // animates.
  _peekSyncLayout(styleGeneration, viewport, resourceRevision, scrollRevision) {
    const held = this._syncLayout;
    if (
      held === null ||
      this._animations.length + this._cssAnimations.size + this._pseudoContentAnimations.size +
          this._activeTransitionCount + this._pendingAnimationDeclarations.length > 0 ||
      this._pendingScrollSources.size > 0 ||
      held.styleGeneration !== styleGeneration ||
      held.resourceRevision !== resourceRevision ||
      held.scrollRevision !== scrollRevision ||
      held.frameSequence !== this._frameSequence
    ) return null;
    const heldViewport = held.layout.viewport;
    if (
      heldViewport.width !== viewport.width ||
      heldViewport.height !== viewport.height ||
      (heldViewport.deviceScale ?? 1) !== (viewport.deviceScale ?? 1) ||
      heldViewport._requestedLeft !== viewport._requestedLeft ||
      heldViewport._requestedTop !== viewport._requestedTop
    ) return null;
    return held.layout;
  }
  _takeSyncLayout(styleGeneration, viewport, resourceRevision) {
    const held = this._syncLayout;
    if (held === null) return null;
    this._syncLayout = null;
    const { layout, timeMilliseconds } = held;
    if (
      held.styleGeneration === styleGeneration &&
      held.resourceRevision === resourceRevision &&
      layout.viewport.width === viewport.width &&
      layout.viewport.height === viewport.height &&
      (layout.viewport.deviceScale ?? 1) === (viewport.deviceScale ?? 1)
    ) {
      // The frame takes the layout alone; getters' geometry stays behind.
      this._releaseRetainedGeometry(layout);
      layout.transitionChangeTimeMilliseconds = timeMilliseconds;
      return layout;
    }
    this._releaseSyncLayoutState(layout);
    return null;
  }
  _releaseSyncLayout() {
    const held = this._syncLayout;
    if (held === null) return;
    this._syncLayout = null;
    this._releaseSyncLayoutState(held.layout);
  }
  _releaseSyncLayoutState(layout) {
    this._releaseRetainedGeometry(layout);
    layout.serialized.release();
    this._root._domCore.releaseSceneResources(layout.serialized.nodes);
    releaseBoxSnapshot(layout.boxes);
  }
  _releaseRetainedGeometry(layout) {
    layout.retainedGeometry?.release();
    layout.retainedGeometry = undefined;
  }
  _animatedGeneratedContent(timeMilliseconds) {
    if (this._pseudoContentAnimations.size === 0) return null;
    const overrides = [];
    for (const [element, pseudoElements] of this._pseudoContentAnimations) {
      for (const [pseudoElement, records] of pseudoElements) {
        if (!records?.length) continue;
        const text = pseudoContentAt(records.at(-1), timeMilliseconds);
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
    if (this._rendering) {
      if (!forceDelivery) {
        this._dirty = true;
        return null;
      }
      while (this._rendering) await this.whenIdle();
      if (this._shutdown) return null;
      if (this._stagedFrame) return this._stagedFrame.frame;
    }
    if (!this._dirty && !forceDelivery) return null;
    this._requireEndedTransitionsUnregistered();
    this._rendering = true;
    this._dirty = false;
    this._currentTime = timeMilliseconds;
    // An adopted animation's timeline had no time until now. This frame's
    // time is its first, so it starts here and samples from its first
    // keyframe instead of from a clock it never saw.
    if (this._animationsAwaitingTimeline.size > 0) {
      const awaiting = [...this._animationsAwaitingTimeline];
      this._animationsAwaitingTimeline.clear();
      for (const animation of awaiting) animation._resolveTimeline();
    }
    // A ::before or ::after content animation that a read between frames
    // started begins at this frame.
    for (const pseudoElements of this._pseudoContentAnimations.values()) {
      for (const records of pseudoElements.values()) {
        for (const record of records) record.startTimeMilliseconds ??= timeMilliseconds;
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
    }
    const core = this._frameCore;
    const frameOwner = this._frameOwner;
    const frameBindings = this._frameBindings;
    // The frame's restyle work: the core's record counters before the frame
    // and after it, taken by the outermost call only (an observer restart
    // renders within this call).
    const restyleCountsBefore = ownsContinuation
      ? [
        core.status("computed_restyle_counts", 0),
        core.status("computed_restyle_counts", 1),
        core.status("computed_restyle_counts", 2),
      ]
      : null;
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
    try {
      const observerDocument = this._root.ownerDocument;
      const styleSystem = observerDocument?._styleSystem;
      let preparationToken = this._frameClaim(continuation, 1, frameBindings);
      for (;;) {
        const resourceRevision = core.status("resource_revision");
        await observerDocument?._readyForRendering();
        const changed = core.status("resource_revision") !== resourceRevision;
        if (!changed) break;
        this._frameResume(
          continuation,
          preparationToken,
          16,
          -1,
          frameBindings,
        );
        preparationToken = this._frameClaim(continuation, 1, frameBindings);
      }
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback) | 32768,
      );
      let scrollOnly = core.status("frame_mode", continuation) === 1;
      let transformOnly = core.status("frame_mode", continuation) === 2;
      if (styleSystem && !scrollOnly) {
        this._prepareStyleSystem(styleSystem);
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
        this._frameFlags(rasterize, deliverObservers, pixelReadback) | 32768,
      );
      this._frameResume(continuation, preparationToken, 0, -1, frameBindings);
      const frameMode = core.status("frame_mode", continuation);
      scrollOnly = frameMode === 1;
      transformOnly = frameMode === 2;
      const cleanSceneReuse = frameMode === 3;
      const sceneToken = this._frameClaim(continuation, 2, frameBindings);
      capturedScrollRequests = this._captureScrollRequests();
      const capturedViewportScroll = capturedScrollRequests.get(this.viewport);
      const frameViewport = {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScale: this.viewport.deviceScale,
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
      publicationRestyled = frameMode === 4 &&
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
          // (engine_record_transform_restate); the node keeps the resolved
          // fields for the host's own readers.
          serialized.rowRevision = publication.core.status(
            "engine_record_transform_restate", publication.handle, index,
          );
          const fields = resolvedElementFields(element);
          serialized.nodes[index] = {
            ...serialized.nodes[index],
            transform: fields.transform,
            transformOrigin: fields.transformOrigin,
          };
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
        const syncLayout = generatedContent === null
          ? this._takeSyncLayout(
            this._serializedStyleGeneration,
            frameViewport,
            core.status("resource_revision"),
          )
          : null;
        if (syncLayout !== null) {
          transitionChangeTimeMilliseconds =
            syncLayout.transitionChangeTimeMilliseconds;
        }
        if (syncLayout !== null) {
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
        } else {
          serialized = serializeToScene(this._root, {
            viewportWidth: frameViewport.width,
            viewportHeight: frameViewport.height,
            generatedContent,
            viewport: frameViewport,
          });
          this._stageCounters.sceneRowsBuilt += serialized.nodes.length;
          this._stageCounters.rowsLowered += serialized.loweredRows.length;
        }
      }
      // Every mode but a full serialization keeps the retained scene; a
      // restyle the core refused serialized in full.
      const retainedScene = frameMode !== 0 &&
        (frameMode !== 4 || restyledScene !== null);
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
        this._persistentRenderer.remapAnimations(remappedIndices);
        for (const animation of [...this._animations]) {
          if (!serialized.indexOf.has(animation._element)) {
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
      const physicalWidth = Math.trunc(
        (visibleRegion?.width ?? frameViewport.width) *
          frameViewport.deviceScale,
      );
      const physicalHeight = Math.trunc(
        (visibleRegion?.height ?? frameViewport.height) *
          frameViewport.deviceScale,
      );
      const toTargetRectangle = (rectangle) =>
        originDeviceX === 0 && originDeviceY === 0 ? rectangle : {
          ...rectangle,
          x: rectangle.x - originDeviceX,
          y: rectangle.y - originDeviceY,
        };
      let boxes = syncLayoutBoxes ?? (retainedScene ? this._lastBoxes : []);
      core.status(
        "frame_configure",
        continuation,
        this._frameFlags(rasterize, deliverObservers, pixelReadback) |
          32768,
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
      for (;;) {
        const action = core.status("frame_stage", continuation);
        if (action === 8) break;
        const token = this._frameClaim(continuation, action, frameBindings);
        let facts = 0;
        let depth = -1;
        switch (action) {
          case 3:
            if (
              boxes !== syncLayoutBoxes ||
              boxes.length !== serialized.nodes.length
            ) {
              boxes = await this._layoutTreeBoxes({
                width: frameViewport.width,
                height: frameViewport.height,
                nodes: serialized.nodes,
                imageSources: serialized.imageSources,
                rowRevision: serialized.rowRevision ?? 0,
              });
            }
            break;
          case 5:
            facts = this._applyScrollAnchoring(
                serialized,
                boxes,
                capturedScrollRequests,
              )
              ? 1
              : 0;
            break;
          case 6:
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
          case 7: {
            this._pendingObserverDelivery = false;
            const delivery = deliverRenderingObservers(
              observerDocument,
              serialized,
              boxes,
              this.viewport,
              timeMilliseconds,
              core.status("frame_depth", continuation),
            );
            facts = (this._dirty ? 2 : 0) | (delivery.skippedResize ? 4 : 0);
            depth = Number.isFinite(delivery.shallowestResizeDepth)
              ? delivery.shallowestResizeDepth
              : -1;
            break;
          }
          case 11:
            break;
          default:
            throw new Error(`Unsupported frame action ${action}`);
        }
        this._frameResume(continuation, token, facts, depth, frameBindings);
        if (core.status("frame_stage", continuation) === 1) {
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
        !this._scrollbarVisibility.due(this._scrollbars, timeMilliseconds) &&
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
      const damageToken = this._frameClaim(continuation, 8, frameBindings);
      const damageMode = core.status(
        "frame_damage_begin",
        continuation,
        physicalWidth,
        physicalHeight,
      );
      const pureScrollMutation = damageMode === 2;
      let requestedDirtyRectangles = damageMode === 0
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
          const { x, y } = resolvedOverflowAxes(resolvedElementFields(element));
          if ((x !== "visible" && x !== "clip") || (y !== "visible" && y !== "clip")) return true;
        }
        return false;
      };
      let scrollbars = null;
      let frameLayoutWork = null;
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
          : computeScrollbars(serialized, frameBoxes, this.viewport, this.scrollbarStyle);
        // Each descriptor carries the visibility it paints with; a hidden
        // overlay bar emits nothing, a fading one scales its colors' alpha.
        const scrollbarVisibility = this._scrollbarVisibility.advance(
          scrollbars,
          this._scrollbars,
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
        selectionPixelReadback: pixelReadback,
        ...(declaredChangedNodeIndices !== null
          ? { declaredChangedNodeIndices }
          : {}),
        ...(mutationNodeIndices?.size ? { mutationNodeIndices } : {}),
        ...(forceGenerationNodeIndices?.size
          ? { forceGenerationNodeIndices }
          : {}),
        timeMilliseconds,
        transitionChangeTimeMilliseconds,
        heldTransition: (nodeIndex, propertyName) =>
          this._heldTransitionDeclaration(nodeIndex, propertyName),
        onTransitionStarted: (transition) =>
          this._registerStartedTransition(transition),
        onTransitionPropertyUnanimated: ({ nodeIndex, propertyName }) => {
          const element = this._eventElementAtIndex[nodeIndex];
          if (element) recordUnanimatedProperty(element, propertyName, "transition-property");
        },
        computedSamples: {
          core: this._root._domCore,
          owner: this._computedSamples,
          elements: this._eventElementAtIndex,
        },
        ...(this._glyphResourceManager === null
          ? {}
          : { glyphResourceManager: this._glyphResourceManager }),
        ...(this._pendingAnimationDeclarations.length > 0
          ? {
            prepareEngine: () => {
              for (const declaration of this._pendingAnimationDeclarations) {
                const nodeIndex = serialized.indexOf.get(declaration.element);
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
          ? { capturePaintArtifact: true }
          : captureTextGeometry
          ? {
            captureTextGeometry: true,
            textGeometryArtifactRead: !reuseTextGeometry,
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
      if (this._textThickening !== undefined) {
        renderOptions.textThickening = this._textThickening;
      }
      if (!rasterize) {
        this._indexOfElement = serialized.indexOf;
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
      const renderToken = this._frameClaim(continuation, 9, frameBindings);
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
      const rendered = textureDelivery
        ? await renderer.renderTexture(scene, renderOptions)
        : await renderer.render(scene, renderOptions);
      rasterFinishedAt = hostNow();
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
      const textGeometryByElement = new Map();
      let textGeometryByNode = new Map();
      // A retained scene with unchanged text keeps the presented frame's
      // glyph and caret geometry. A translation holds no scroll (the
      // geometry records carry it), so a scroll changes none of it. Those
      // entries are frozen and already complete, so the paint artifact's
      // text operations (present whenever the surface captures paint
      // artifacts) must not be accumulated onto them again.
      const reusedTextGeometry = (reuseTextGeometry ||
          (this._textSelectionEnabled &&
            rendered.performance?.preparation?.retained))
        ? this._presentedFrame?.textGeometryByNode ?? null
        : null;
      // A text node's reused geometry is final: its caret stops were made
      // unique when it was built, and keeping the same frozen stop array is
      // what lets the geometry build reuse the node's encoded wire blocks
      // (textWireBlocks is keyed on it). Running it through the unique-stop
      // pass again copied every stop array on every scroll frame, which
      // re-encoded every text node's blocks. A text control still takes
      // that pass: its selection rectangles follow the live selection.
      // The entries still to be finished below (made unique, frozen, a text
      // control's selection added); a kept entry is final.
      const unfinishedTextGeometry = [];
      if (reusedTextGeometry !== null) {
        // A view over the reused entries, whatever scrolled: only a text
        // control's entry is made, for its live selection. The text
        // controls among the reused entries: a frame keys each control's
        // entry under textGeometryByElement as well, and every other entry
        // is a text node's.
        const reusedControls = this._presentedFrame.textGeometryByElement;
        textGeometryByNode = new TextGeometryView(
          reusedTextGeometry instanceof TextGeometryView
            ? reusedTextGeometry.base
            : reusedTextGeometry,
          textGeometryByElement,
        );
        unfinishedTextGeometry.push(...reusedControls.keys());
        this._stageCounters.translatedTextGeometryEntries +=
          reusedControls.size;
      }
      const textOperations = reusedTextGeometry === null
        ? rendered.textGeometryArtifact?.operations ??
          rendered.paintArtifact?.operations ?? []
        : [];
      // A text node whose row was not lowered anew (same text, same
      // record) keeps the previous frame's glyph and caret geometry: those
      // objects are functions of the shaped run and the line boxes only.
      // The command stream paints in unscrolled coordinates (the raster
      // applies the scroll table), so the geometry stays valid while the
      // node's painted line rectangles keep their size, and a node whose
      // lines all moved by the same delta - the line above it was removed,
      // a paragraph was inserted before it - keeps them with that delta as
      // its translation. `anchors` carries the rectangles the glyph
      // coordinates were captured against, so the delta is measured from
      // the capture and never accumulates. This unscrolled line displacement
      // is combined with the absolute scroll shift of the published frame.
      const previousTextGeometry = textOperations.length > 0
        ? this._presentedFrame?.textGeometryByNode ?? null
        : null;
      const loweredRows = textOperations.length === 0 ||
          serialized.loweredRows === undefined
        ? null
        : new Set(serialized.loweredRows);
      // One eager pass: the operations of each text owner, in paint order.
      // Reading operation.glyphs builds a frozen object per glyph, so the
      // grouping uses the eager glyphCount and only a rebuild pays for it.
      const operationsByOwner = new Map();
      // An owner's kind (0 no text owner, 1 a text control, 2 a text node
      // under the root) is a function of the node and of the tree. The
      // surface keeps the kinds, and the ancestry verdicts behind them,
      // until a tree mutation under the root: an insertion or a removal
      // is the only change that moves a node's shadow-including ancestry,
      // and either one reaches the surface (its target is under the root
      // before a removal and after an insertion). A frame then classifies
      // only the owners it has not met, instead of walking every owner's
      // ancestry and reading its node type through the core again.
      if (this._textOwnerKinds?.structureMutations !== this._structureMutations) {
        this._textOwnerKinds = {
          structureMutations: this._structureMutations,
          kinds: new Map(),
          isDocumentText: shadowIncludingInclusiveDescendantTest(this._root),
        };
      }
      const { kinds: ownerKinds, isDocumentText } = this._textOwnerKinds;
      this._stageCounters.textGeometryOperationsGrouped += textOperations.length;
      for (const operation of textOperations) {
        if (operation.kind !== "text" || operation.glyphCount === 0) continue;
        const sourceNode = serialized.nodes[operation.nodeIndex];
        const generated = sourceNode?.generatedOwnerIndex !== undefined;
        const owner = elementAtIndex[
          sourceNode?.generatedOwnerIndex ??
            operation.nodeIndex
        ];
        if (owner == null) continue;
        let ownerKind = ownerKinds.get(owner);
        if (ownerKind === undefined) {
          const ownerType = owner.nodeType;
          ownerKind = ownerType === 1 &&
              (owner.localName === "input" || owner.localName === "textarea")
            ? 1
            : ownerType === 3 && isDocumentText(owner)
            ? 2
            : 0;
          ownerKinds.set(owner, ownerKind);
        }
        // Generated text belongs to its element, never a text owner.
        if (ownerKind === 0 || (ownerKind === 2 && generated)) continue;
        const entry = operationsByOwner.get(owner);
        if (entry === undefined) {
          operationsByOwner.set(owner, {
            operations: [operation],
            keepable: ownerKind === 2 && loweredRows !== null &&
              !textGeometryStale && !loweredRows.has(operation.nodeIndex),
          });
          continue;
        }
        entry.operations.push(operation);
        entry.keepable = entry.keepable &&
          !loweredRows.has(operation.nodeIndex);
      }
      // Captured line coordinates are unscrolled, and so is a translation:
      // the geometry records carry each scroll.
      const owners = [...operationsByOwner.keys()];
      this._stageCounters.textGeometryOwnersGrouped += owners.length;
      for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex++) {
        const owner = owners[ownerIndex];
        const { operations, keepable } = operationsByOwner.get(owner);
        const previous = previousTextGeometry?.get(owner);
        const kept = keepable && previous !== undefined
          ? keptTextGeometryFor(previous, operations)
          : null;
        if (kept !== null) {
          // The presented entry itself when the translation did not move
          // either, so the snapshot can keep the presented text block.
          textGeometryByNode.set(
            owner,
            Object.is(kept.translationX ?? 0, previous.translationX ?? 0) &&
              Object.is(kept.translationY ?? 0, previous.translationY ?? 0)
              ? previous
              : kept,
          );
          continue;
        }
        const anchors = new Float64Array(operations.length * 4);
        const geometry = {
          caretStops: [],
          glyphs: [],
          anchors,
          translationX: 0,
          translationY: 0,
        };
        textGeometryByNode.set(owner, geometry);
        unfinishedTextGeometry.push(owner);
        for (let index = 0; index < operations.length; index++) {
          const operation = operations[index];
          const rectangle = operation.logicalRectangle;
          anchors[index * 4] = rectangle.x;
          anchors[index * 4 + 1] = rectangle.y;
          anchors[index * 4 + 2] = rectangle.width;
          anchors[index * 4 + 3] = rectangle.height;
          const top = rectangle.y;
          const bottom = top + rectangle.height;
          for (const glyph of operation.glyphs) {
            geometry.glyphs.push(Object.freeze({
              sourceStart: glyph.sourceStart,
              sourceEnd: glyph.sourceEnd,
              x: glyph.x,
              width: glyph.width,
              top,
              bottom,
            }));
            geometry.caretStops.push(
              Object.freeze({
                sourceOffset: glyph.rtl ? glyph.sourceEnd : glyph.sourceStart,
                x: glyph.x,
                top,
                bottom,
                affinity: glyph.rtl ? "upstream" : "downstream",
              }),
              Object.freeze({
                sourceOffset: glyph.rtl ? glyph.sourceStart : glyph.sourceEnd,
                x: glyph.x + glyph.width,
                top,
                bottom,
                affinity: glyph.rtl ? "downstream" : "upstream",
              }),
            );
          }
        }
      }
      // A rebuilt entry whose values are the presented frame's entry's
      // keeps that frozen entry: a restyle that lowered a text row without
      // moving a glyph (a color or underline hover) rebuilds the row's
      // operations into the same caret stops and glyphs, and the snapshot
      // can keep the presented text block only for the same objects
      // (presented-frame.js sameTextObjects).
      const presentedTextGeometry = this._presentedFrame?.textGeometryByNode ??
        null;
      for (const node of unfinishedTextGeometry) {
        const geometry = textGeometryByNode.get(node);
        const uniqueStops = uniqueCaretStops(node, geometry.caretStops);
        const baseGeometry = {
          caretStops: Object.freeze(uniqueStops),
          glyphs: Object.freeze(geometry.glyphs),
          anchors: geometry.anchors,
          translationX: geometry.translationX ?? 0,
          translationY: geometry.translationY ?? 0,
        };
        const previous = presentedTextGeometry?.get(node);
        const sameValues = previous !== undefined &&
          sameTextGeometryValues(previous, baseGeometry);
        if (node.nodeType === 3) {
          textGeometryByNode.set(
            node,
            sameValues ? previous : Object.freeze(baseGeometry),
          );
          continue;
        }
        const selectionStart = node.selectionStart ?? node.value.length;
        const selectionEnd = node.selectionEnd ?? selectionStart;
        // A control's entry carries its selection; its selection
        // rectangles depend on its scroll too, so the frame's geometry
        // answers them (controlSelectionRectangles).
        const controlGeometry = sameValues &&
            previous.selectionStart === selectionStart &&
            previous.selectionEnd === selectionEnd
          ? previous
          : Object.freeze({ ...baseGeometry, selectionStart, selectionEnd });
        // A view reads a control's entry from textGeometryByElement.
        if (textGeometryByNode instanceof Map) {
          textGeometryByNode.set(node, controlGeometry);
        }
        textGeometryByElement.set(node, controlGeometry);
      }
      const preparedState = Object.freeze({
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
        this._elementAtIndex = elementAtIndex;
        this._refreshScrollAnchors(serialized, boxes, geometryHandle);
        this._lastBoxes = boxes;
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
        if (snapshotPixels || retainedPixels === null) {
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
        textGeometryByElement,
        textGeometryByNode,
        // A frame that only scrolled derives its geometry from the
        // presented one: only boxes, scrollbars and text translations move.
        scrollPredecessor: scrollOnly ? this._presentedFrame : null,
        restylePredecessor: restyledInPlace ? this._presentedFrame : null,
      });
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
        if (!successorPublished) successor.geometry.release();
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
        if (superseded !== null && superseded !== successor) {
          superseded.geometry.release();
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
        notify();
      }
      return frame;
    } finally {
      if (!accepted) rollback();
      if (!accepted) releaseUnpublishedSuccessor?.();
      if (ownsContinuation && !this._stagedFrame) {
        core.status("frame_dispose", continuation);
      }
      if (capturedScrollRequests !== this._stagedFrame?.scrollCapture) {
        capturedScrollRequests?.release();
      }
      if (restyleCountsBefore !== null && this._frameCore === core) {
        this._stageCounters.elementsRestyled +=
          (core.status("computed_restyle_counts", 0) - restyleCountsBefore[0]) >>> 0;
        this._stageCounters.pseudoElementsRestyled +=
          (core.status("computed_restyle_counts", 1) - restyleCountsBefore[1]) >>> 0;
        this._stageCounters.sceneRestyleRowsRead +=
          (core.status("computed_restyle_counts", 2) - restyleCountsBefore[2]) >>> 0;
      }
      if (ownsContinuation) this._cancelUndeclaredTransitions();
      this._eventElementAtIndex = null;
      this._stageCounters.currentStage = "idle";
      this._rendering = false;
      // A native change that landed after this frame sealed its scene (a
      // font face or an image its own layout pass loaded) belongs to the
      // next frame, and no host mutation callback reports it: only the
      // frame surface holds it. That frame follows now, instead of the next
      // input's frame paying for it.
      if (
        accepted && !this._dirty && !this._shutdown &&
        this._mutationConsequence > 0
      ) this._dirty = true;
      if (this._snapCheckOwed && !this._dirty) {
        this._snapCheckOwed = false;
        this._snapCheckPending = this._snapCheckPending ||
          this._snappedTargets.size > 0 || this._snapContainersInLastBuild();
      }
      const idleWaiters = this._idleWaiters.splice(0);
      for (const resolve of idleWaiters) resolve();
      if (this._hasActiveAnimationWork() || this._scrollMomentum) {
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
    if (this._running || this._frameRequest !== null) {
      throw new Error("captureFrames() requires a stopped render surface");
    }
    if (this._capturingFrames) {
      throw new Error("captureFrames() is already active");
    }
    if (!Number.isInteger(frameBudget) || frameBudget <= 0) {
      throw new RangeError("frameBudget must be a positive integer");
    }
    const model = createMotionModel(this);
    if (model.inspection.classification === "external") {
      throw new Error(
        "captureFrames() requires a progress schedule for an external timeline",
      );
    }
    if (model.inspection.classification === "static") return;
    const captureDuration = durationMilliseconds ??
      model.inspection.finiteDurationMilliseconds;
    if (!Number.isFinite(captureDuration) || captureDuration <= 0) {
      throw new RangeError(
        "durationMilliseconds must bound an unbounded animation",
      );
    }
    const startTime = this.currentTime;
    const endTime = startTime + captureDuration;
    if (!model.exports.schedule_prepare(startTime, endTime, frameBudget)) {
      throw new Error(
        `Cannot prepare frame schedule: WebAssembly error ${model.exports.motion_error()}`,
      );
    }
    for (const effect of model.scheduleEffects) {
      if (!effect.progressing || effect.external) continue;
      if (!model.exports.schedule_add_effect(effect.effectIndex)) {
        throw new Error(
          `Cannot add effect schedule: WebAssembly error ${model.exports.motion_error()}`,
        );
      }
      for (const keyframe of effect.keyframes) {
        if (
          !model.exports.schedule_add_keyframe(
            effect.effectIndex,
            keyframe.offset,
            effect.discrete ? 1 : 0,
          )
        ) {
          throw new Error(
            `Cannot add keyframe schedule: WebAssembly error ${model.exports.motion_error()}`,
          );
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
          width: frame?.width ?? Math.trunc(
            (this._visibleRectangle?.width ?? this.viewport.width) *
              this.viewport.deviceScale,
          ),
          height: frame?.height ?? Math.trunc(
            (this._visibleRectangle?.height ?? this.viewport.height) *
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
    if (!this._rendering) return Promise.resolve();
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
    while (this._rendering) await this.whenIdle();
    if (this._shutdown) throw new Error("render surface is shut down");
    const { scene, page: pageOption } = this._preparedState;
    const page = pageOption === null ? null : this.page;
    const artifact = await renderer.createDisplayListArtifact(scene, { page: pageOption });
    return { ...artifact, page };
  }

  // The one render entry. Delivers the renderer's GPU texture frame on
  // WebGPU (no readback); `pixels: true` reads this frame back into a
  // retained CPU snapshot for encoding or inspection. WebGL 2 always
  // delivers pixels.
  renderNow({ pixels = false, _transaction = null } = {}) {
    if (this._shutdown) throw new Error("render surface is shut down");
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
    // Text ownership memoizes ancestry against the surface root.
    this._textOwnerKinds = null;
    nextRegistry.set(this._environmentKey, this);
    this._document._liveRenderSurfaces.delete(this);
    this._document = surfaceDocument(nextRoot);
    (this._document._liveRenderSurfaces ??= new Set()).add(this);
    // The new root demands its images through its own document's host.
    this._resolveResource = this._document._resolveResource ?? null;
    this._connectSubtree(nextRoot);
    this.viewport.root = nextRoot;
    this._indexOfElement = new Map();
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
    if (this._pageRuleCache) {
      releasePageRules(this._pageRuleCache.rules);
      this._pageRuleCache = null;
    }
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
      if (animation instanceof CSSAnimation) animation.cancel();
      else animation._moveToPendingTimeline();
    }
    for (const records of [...this._transitionRecords.values()]) {
      for (const record of [...records.values()]) record.animation.cancel();
    }
    for (const transitions of [...this._pendingTransitions.values()]) {
      for (const animation of [...transitions.values()]) animation.cancel();
    }
    this._pendingTransitions.clear();
    this._animations.length = 0;
    this._animationsAwaitingTimeline.clear();
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
    if (this._persistentRendererPromise) {
      await (await this._persistentRendererPromise).shutdown();
    }
    this._root._domCore.status("computed_samples_release", this._computedSamples);
    this._computedSamples = 0;
    this._releaseSyncLayout();
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
