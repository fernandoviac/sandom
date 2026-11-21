import {
  addImplicitKeyframes,
  animationKeyframeContext,
  canonicalizeAnimationKeyframes,
  recordUnanimatedProperty,
} from "./style.js";
import { parseCSSEasing, serializeAnimationEasing } from "../dom-wasm/easing.js";
import {
  ANIMATION_DEPENDENCY_CUSTOM,
  animationComputedTiming,
  animationProperty,
  AnimationValue,
  recordKeyframesFollowElement,
  deferAnimationBinding,
  arrangeKeyframes,
  keyframePropertyNames,
  isAnimationDependency,
  normalizeAnimationOffsets,
  setAnimationDependency,
} from "../dom-wasm/animation.js";
import { addEventListener, dispatchEventFromScript, removeEventListener } from "./events.js";
import {
  installAnimationBindings,
  installCSSAnimationBindings,
  installCSSTransitionBindings,
  createAnimationEffectBindings,
} from "./dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { documentTimeline, isDocumentTimeline } from "./document-clock.js";
import { isPseudoElementTarget, PSEUDO_ELEMENT_NAMES } from "./pseudo-element-target.js";

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const ANIMATION_ENUMERATION_PLAY_STATE = layoutConstant("ANIMATION_ENUMERATION_PLAY_STATE");
const ANIMATION_TIMELINE_KIND_DOCUMENT = layoutConstant("ANIMATION_TIMELINE_KIND_DOCUMENT");
const ANIMATION_TIMELINE_KIND_NONE = layoutConstant("ANIMATION_TIMELINE_KIND_NONE");
const ACTION = Object.freeze(Object.fromEntries(["CANCEL_SILENTLY", "DECLARE", "PAUSE", "RESUME", "REJOIN_HOST", "LEAVE_HOST",
  "REJECT_FINISHED", "RESOLVE_FINISHED", "FRAME", "RESET_FINISHED", "CANCEL_THROUGH_ENGINE", "SEEK", "RESOLVE_READY",
  "RESET_READY", "REJECT_READY", "NOTIFY_FINISHED", "PEND_PAUSE"].map((name) => [name, layoutConstant(`ANIMATION_ACTION_${name}`)])));
const PROMISE_SETTLING_ACTIONS = ACTION.RESOLVE_READY | ACTION.REJECT_READY | ACTION.RESOLVE_FINISHED |
  ACTION.REJECT_FINISHED | ACTION.NOTIFY_FINISHED;
const TIMING_DEFAULTS = Object.freeze(Object.fromEntries(["SIZE", "DURATION", "FILL"]
  .map((name) => [name, layoutConstant(`ANIMATION_TIMING_DEFAULTS_${name}`)])));
const ORDER = Object.freeze(Object.fromEntries([
  "SIZE", "ELEMENT", "CLASS", "NAME_POSITION", "SEQUENCE", "GENERATION", "PROPERTY_POINTER", "PROPERTY_LENGTH", "PSEUDO",
  "TRANSITION", "CSS_ANIMATION", "SCRIPT",
].map((name) => [name, layoutConstant(`ANIMATION_ORDER_${name}`)])));
const REPLACED = Object.freeze(Object.fromEntries(["SIZE", "HANDLE", "PROPERTIES", "END_DELAY", "FILL"]
  .map((name) => [name, layoutConstant(`ANIMATION_REPLACED_${name}`)])));
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const ANIMATION_ENUMERATION_FILL = layoutConstant("ANIMATION_ENUMERATION_FILL");
const ANIMATION_ENUMERATION_REPLACE_STATE = layoutConstant("ANIMATION_ENUMERATION_REPLACE_STATE");
const ANIMATION_CONTROL_CANCEL = layoutConstant("ANIMATION_CONTROL_CANCEL");
const ANIMATION_STYLE_EFFECT_CHANGED = layoutConstant("ANIMATION_STYLE_EFFECT_CHANGED");
const ANIMATION_STYLE_EFFECT_REDECLARE = layoutConstant("ANIMATION_STYLE_EFFECT_REDECLARE");
const ANIMATION_CONTROL_SCROLL_PROGRESS = layoutConstant("ANIMATION_CONTROL_SCROLL_PROGRESS");
const ANIMATION_CONTROL_CANCEL_GENERATION = layoutConstant("ANIMATION_CONTROL_CANCEL_GENERATION");
const ANIMATION_CONTROL_ITERATION_DURATION = layoutConstant("ANIMATION_CONTROL_ITERATION_DURATION");
const ANIMATION_CONTROL_PERSIST = layoutConstant("ANIMATION_CONTROL_PERSIST");
const ANIMATION_CONTROL_RESOLVE_TIMELINE = layoutConstant("ANIMATION_CONTROL_RESOLVE_TIMELINE");
const ANIMATION_CONTROL_PEND_TIMELINE = layoutConstant("ANIMATION_CONTROL_PEND_TIMELINE");
const ANIMATION_CONTROL_COMMIT_PAUSE = layoutConstant("ANIMATION_CONTROL_COMMIT_PAUSE");
const ANIMATION_VALUE_PLAYBACK_RATE = layoutConstant("ANIMATION_VALUE_PLAYBACK_RATE");
const ANIMATION_VALUE_PLAY_STATE = layoutConstant("ANIMATION_VALUE_PLAY_STATE");
const ANIMATION_VALUE_PROMISE_GENERATION = layoutConstant("ANIMATION_VALUE_PROMISE_GENERATION");
const ANIMATION_VALUE_TRACK_GENERATION = layoutConstant("ANIMATION_VALUE_TRACK_GENERATION");
const ANIMATION_VALUE_ENGINE_START_TIME = layoutConstant("ANIMATION_VALUE_ENGINE_START_TIME");
const ANIMATION_VALUE_DURATION = layoutConstant("ANIMATION_VALUE_DURATION");
const ANIMATION_VALUE_DELAY = layoutConstant("ANIMATION_VALUE_DELAY");
const ANIMATION_VALUE_REVERSED = layoutConstant("ANIMATION_VALUE_REVERSED");
const ANIMATION_VALUE_NEEDS_FRAME = layoutConstant("ANIMATION_VALUE_NEEDS_FRAME");
const ANIMATION_VALUE_SCROLL_TIME = layoutConstant("ANIMATION_VALUE_SCROLL_TIME");
const ANIMATION_VALUE_CONTROL_GENERATION = layoutConstant("ANIMATION_VALUE_CONTROL_GENERATION");
const ANIMATION_VALUE_REPLACE_STATE = layoutConstant("ANIMATION_VALUE_REPLACE_STATE");
const ANIMATION_VALUE_TIMELINE_PENDING = layoutConstant("ANIMATION_VALUE_TIMELINE_PENDING");
const ANIMATION_VALUE_PENDING = layoutConstant("ANIMATION_VALUE_PENDING");
const ANIMATION_VALUE_EFFECT_WITHHELD = layoutConstant("ANIMATION_VALUE_EFFECT_WITHHELD");
const ANIMATION_VALUE_TRACK_ITERATIONS = layoutConstant("ANIMATION_VALUE_TRACK_ITERATIONS");
const ANIMATION_PLAY_STATE_RUNNING = layoutConstant("ANIMATION_PLAY_STATE_RUNNING");
const ANIMATION_PLAY_STATE_PAUSED = layoutConstant("ANIMATION_PLAY_STATE_PAUSED");
const ANIMATION_PLAY_STATE_IDLE = layoutConstant("ANIMATION_PLAY_STATE_IDLE");
const ANIMATION_PLAY_STATE_FINISHED = layoutConstant("ANIMATION_PLAY_STATE_FINISHED");
const ANIMATION_REPLACE_STATE_REMOVED = layoutConstant("ANIMATION_REPLACE_STATE_REMOVED");

const MEASUREMENT = Symbol.for("sandom.domCore.measurement");
const animationFinalizer = new FinalizationRegistry(({ core, handle, keyframes }) => {
  core.status("animation_release", handle);
  core.status("animation_keyframes_release", keyframes);
});

// A single NUL prefix tags a non-JSON number; doubling authored NUL prefixes
// makes the transport reversible without reserving any authored object keys.
// A canonical animation value travels whole under the key NUL, which no
// keyframe member has.
function encodeCanonicalNumber(_key, value) {
  if (value instanceof AnimationValue) {
    return { "\0": [value.propertyId, value.kind, value.tag, value.values, value.components, value.text] };
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return `\0${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  return typeof value === "string" && value.startsWith("\0") ? `\0${value}` : value;
}
function decodeCanonicalNumber(_key, value) {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "\0")) return new AnimationValue(...value["\0"]);
  if (typeof value !== "string" || !value.startsWith("\0")) return value;
  return value.startsWith("\0\0") ? value.slice(1) : Number(value.slice(1));
}
// Animations created by script sort by creation in composite order.
let nextAnimationSequence = 0;

// The CSS text of an effect or keyframe easing, a string or a parsed record.
function easingText(easing) {
  return easing === undefined ? "linear" : serializeAnimationEasing(easing);
}

// Web Animations 1, section 6.6.1 "process a keyframes argument": the
// keyframes of an array or of a property-indexed object, each with its
// offset (null when absent), easing, composite and property values.
function processKeyframes(keyframes) {
  if (keyframes === null || keyframes === undefined) return [];
  if (typeof keyframes !== "object") throw new TypeError("keyframes must be an object or an array");
  if (Array.isArray(keyframes)) {
    return keyframes.map(({ offset = null, easing = "linear", composite = "auto", ...values }) =>
      ({ offset, easing, composite, values }));
  }
  const { offset: offsets = [], easing: easings = [], composite: composites = [], ...properties } = keyframes;
  const list = (value) => Array.isArray(value) ? value : [value];
  const pairs = Object.keys(properties).map((name) => [name, list(properties[name])]);
  const offsetList = list(offsets), easingList = list(easings), compositeList = list(composites);
  const { frames, assignments } = arrangeKeyframes(pairs, offsetList.length, easingList.length, compositeList.length);
  const result = frames.map(({ offsetIndex, easingIndex, compositeIndex }) => ({
    offset: offsetIndex < 0 ? null : offsetList[offsetIndex],
    easing: easingIndex < 0 ? "linear" : easingList[easingIndex],
    composite: compositeIndex < 0 ? "auto" : compositeList[compositeIndex],
    values: {},
  }));
  for (const [pairIndex, valueIndex, frameIndex] of assignments) {
    result[frameIndex].values[pairs[pairIndex][0]] = pairs[pairIndex][1][valueIndex];
  }
  return result;
}
// A processed keyframe in the shape canonicalizeAnimationKeyframes reads:
// absent members stay absent.
function engineKeyframe({ offset, easing, composite, values }) {
  return {
    ...(offset === null ? {} : { offset }),
    ...(easing === "linear" ? {} : { easing }),
    ...(composite === "auto" ? {} : { composite }),
    ...values,
  };
}

// Whether the animation-timeline value or timeline option `timeline` names
// a scroll timeline rather than the document timeline.
function isScrollTimeline(core, timeline) {
  return core.exports.animation_timeline_scroll_driven(...core.input(String(timeline))) !== 0;
}

// The script-visible Animation interface (Web Animations 1, section 6.4).
export class Animation {
  // `target` is an element, or for a CSS transition of a ::before or
  // ::after its pseudo-element-target.js identity: the surface finds the
  // target's scene node by it, and the element owns the animation.
  constructor(surface, target, keyframes, timing, engineDeclarationOptions = {}) {
    const pseudo = isPseudoElementTarget(target);
    const element = pseudo ? target.element : target;
    this._surface = surface;
    this._target = target;
    this._element = element;
    this._pseudoElement = pseudo ? target.pseudoElement : "";
    this._core = element._domCore;
    this._sequence = nextAnimationSequence++;
    // Script cleared the timeline (_setTimeline).
    this._timelineCleared = false;
    // A pending animation holds at its current time until a frame of its
    // surface resolves its start time: one created between frames, and one
    // created before any surface claimed the element (a
    // PendingAnimationTimeline is not a timeline). The core keeps the
    // pending state; `ready` settles when it leaves it.
    this._resetReadyPromise();
    this._assignKeyframes(keyframes, engineDeclarationOptions.implicitKeyframe);
    const canonicalKeyframes = this._computeCanonicalKeyframes();
    const scroll = this._assignTiming(timing);
    this._engineDeclarationOptions = engineDeclarationOptions;
    const startTime = Number(this._timing.startTime ?? engineDeclarationOptions.startTime ?? surface.currentTime);
    try {
      this._animationId = this._core.statusRaw("animation_create", element._coreHandle,
        this._timing.duration, this._timing.delay, Number(this._timing.iterations), this._timing.endDelay, startTime,
        scroll ? 1 : 0, engineDeclarationOptions.timelinePending === true ? 1 : 0, surface.currentTime);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new error.constructor(`The animation timing (duration ${this._timing.duration}, delay ${this._timing.delay}, ` +
        `end delay ${this._timing.endDelay}, iterations ${this._timing.iterations}, start time ${startTime}): ${error.message}`,
        { cause: error });
    }
    try {
      this._recordKeyframesFollowElement();
      this._keyframesText = JSON.stringify(canonicalKeyframes, encodeCanonicalNumber);
      this._keyframesHandle = this._core.handle("animation_keyframes_create", ...this._core.input(this._keyframesText));
      this._resetFinishedPromise();
      this.effect = Object.freeze(createAnimationEffectBindings({
        reportKeyframes: () => this._reportedKeyframes(),
        reportTiming: () => this._effectTiming(),
        readTarget: () => this._element,
        readPseudoElement: () => this._pseudoElement || null,
        readComposite: () => this._timing.composite ?? "replace",
        computeTiming: () => this._computedTiming(),
      }));
      this._replaceEngineHandle();
      this._engineHandle.captureSamples(this._surface.currentTime);
    } catch (error) {
      if (this._keyframesHandle) this._core.status("animation_keyframes_release", this._keyframesHandle);
      this._core.status("animation_release", this._animationId);
      throw error;
    }
    // The finalizer reads the keyframes handle of this record when it runs:
    // a refresh replaces it in place.
    this._finalized = { core: this._core, handle: this._animationId, keyframes: this._keyframesHandle };
    animationFinalizer.register(this, this._finalized);
  }

  // The processed keyframes of `keyframes`, and the implicit keyframe of a
  // CSS animation.
  _assignKeyframes(keyframes, implicitKeyframe = {}) {
    this._processedKeyframes = processKeyframes(keyframes);
    this._implicitKeyframe = implicitKeyframe;
  }
  // Records in the core whether the keyframes follow the element
  // (animation_keyframes_follow_element_set): their values, and their
  // property names, of which a logical longhand follows the element's
  // writing mode and direction.
  _recordKeyframesFollowElement() {
    recordKeyframesFollowElement(this._core, this._animationId,
      this._processedKeyframes.flatMap(({ values }) => [...Object.values(values), ...Object.keys(values)]));
  }

  // The effect timing of `timing`, a duration or the options of animate()
  // with their timeline and range members, with its defaults; true when
  // the timeline is a scroll timeline. getTiming() reports the authored
  // duration and fill; "auto" stands for an absent member.
  _assignTiming(timing) {
    this._timing = typeof timing === "number" ? { duration: timing } : { ...timing };
    this._timelineOption = this._timing.timeline;
    this._rangeStartOption = this._timing.rangeStart;
    this._rangeEndOption = this._timing.rangeEnd;
    delete this._timing.timeline;
    delete this._timing.rangeStart;
    delete this._timing.rangeEnd;
    this._authoredDuration = this._timing.duration ?? "auto";
    this._authoredFill = this._timing.fill ?? "auto";
    this._timing.duration = this._authoredDuration === "auto" ? 0 : Number(this._authoredDuration);
    this._timing.delay = Number(this._timing.delay ?? 0);
    this._timing.endDelay = Number(this._timing.endDelay ?? 0);
    this._timing.iterations = this._timing.iterations ?? 1;
    const scroll = this._isScrollDriven();
    this._core.status("animation_timing_defaults", this._timing.duration, scroll ? 1 : 0);
    const defaultView = this._core.output("animation_timing_defaults");
    this._timing.duration = defaultView.getFloat64(TIMING_DEFAULTS.DURATION, true);
    const defaultFill = defaultView.getUint32(TIMING_DEFAULTS.FILL, true);
    const measurement = globalThis[MEASUREMENT];
    if (measurement) measurement.record({
      category: "animation", operation: "animation.timing-defaults",
      direction: "core-to-host", bytes: TIMING_DEFAULTS.SIZE, allocations: 1,
    });
    if (defaultFill && this._timing.fill === undefined) {
      this._timing.fill = this._core.string("animation_enumeration_name", ANIMATION_ENUMERATION_FILL, defaultFill);
    }
    return scroll;
  }

  // The engine's keyframes: computed values of the element, with the
  // implicit keyframes of the underlying values. A CSS animation's implicit
  // keyframe takes its timing function and replaces the underlying value;
  // a script animation's is linear.
  _computeCanonicalKeyframes() {
    const element = this._element;
    const context = animationKeyframeContext(element);
    try {
      return addImplicitKeyframes(
        canonicalizeAnimationKeyframes(this._processedKeyframes.map(engineKeyframe),
          (property) => recordUnanimatedProperty(element, property, "keyframes"), context),
        context,
        this._implicitKeyframe,
      );
    } finally {
      context.release();
    }
  }
  // A keyframe value with a substitution function computes from the
  // element's current computed values (CSS Values 5 §7.1), and one with a
  // tree-counting function from its current siblings (§8.1): after a
  // style change the core decides whether the keyframes compute again
  // (animation_keyframes_follow_element), and a track whose values changed
  // is declared again at the animation's state.
  _refreshElementDependentKeyframes() {
    if (this._core.status("animation_keyframes_follow_element", this._animationId,
      this._element.isConnected ? 1 : 0) === 0) return;
    if (this._replaceKeyframes(this._computeCanonicalKeyframes())) this._redeclareTrack();
  }
  // The engine's keyframes become `keyframes`; false when they are the
  // ones it has.
  _replaceKeyframes(keyframes) {
    const text = JSON.stringify(keyframes, encodeCanonicalNumber);
    if (text === this._keyframesText) return false;
    const handle = this._core.handle("animation_keyframes_create", ...this._core.input(text));
    this._core.status("animation_keyframes_release", this._keyframesHandle);
    this._keyframesHandle = handle;
    this._finalized.keyframes = handle;
    this._keyframesText = text;
    this._targetPropertyBits = undefined;
    return true;
  }
  // The animation's track is declared again, at its state, with its
  // keyframes and timing.
  _redeclareTrack() {
    this._applyActions(ACTION.CANCEL_SILENTLY | ACTION.DECLARE |
      (this._value(ANIMATION_VALUE_PLAY_STATE) === ANIMATION_PLAY_STATE_PAUSED ? ACTION.PAUSE : 0));
  }

  get _canonicalKeyframes() {
    return JSON.parse(this._core.string("animation_keyframes_export", this._keyframesHandle), decodeCanonicalNumber);
  }
  // getKeyframes() of a script animation: the processed keyframes with
  // their specified values and computed offsets (Web Animations 1, 6.6.3).
  _reportedKeyframes() {
    const computedOffsets = [];
    for (const { offset, index } of normalizeAnimationOffsets(
      this._processedKeyframes.map(({ offset }, index) => ({ offset, index })),
    )) computedOffsets[index] = offset;
    return this._processedKeyframes.map(({ offset, easing, composite, values }, index) => {
      const frame = { offset, easing: easingText(easing), composite };
      for (const name of Object.keys(values).sort()) frame[name] = String(values[name]);
      frame.computedOffset = computedOffsets[index];
      return frame;
    });
  }
  // The EffectTiming dictionary of getTiming() (Web Animations 1, section 6.5).
  _effectTiming() {
    const timing = this._timing;
    return {
      delay: timing.delay,
      direction: timing.direction ?? "normal",
      duration: this._authoredDuration,
      easing: easingText(timing.easing),
      endDelay: timing.endDelay,
      fill: this._authoredFill,
      iterationStart: Number(timing.iterationStart ?? 0),
      iterations: timing.iterations,
    };
  }
  // The ComputedEffectTiming dictionary of getComputedTiming(): the effect
  // timing with "auto" resolved, then the core's computed timing.
  _computedTiming() {
    const timing = this._effectTiming();
    timing.duration = timing.duration === "auto" ? 0 : timing.duration;
    timing.fill = timing.fill === "auto" ? "none" : timing.fill;
    const easing = typeof this._timing.easing === "string" ? parseCSSEasing(this._timing.easing) : this._timing.easing;
    return {
      ...timing,
      ...animationComputedTiming(this._animationId, this._surface.currentTime, { ...timing, easing: easing ?? "linear" }),
    };
  }

  _value(field) {
    return this._core.status("animation_value", this._animationId, field, this._surface.currentTime);
  }
  _resetFinishedPromise() {
    this._promiseGeneration = this._value(ANIMATION_VALUE_PROMISE_GENERATION);
    this._finishedPromise = new Promise((resolve, reject) => {
      this._resolveFinished = resolve;
      this._rejectFinished = reject;
    });
    // Cancelling rejects `finished` whether or not anyone awaits it (a CSS
    // animation whose declaration goes away is cancelled by the surface);
    // an unobserved rejection must not become a host-level failure.
    this._finishedPromise.catch(() => {});
  }
  // Web Animations 1, section 5.5: the replace state, which the frame
  // that removes a replaced animation sets (removeReplacedAnimations).
  get replaceState() {
    return this._core.string("animation_enumeration_name", ANIMATION_ENUMERATION_REPLACE_STATE, this._value(ANIMATION_VALUE_REPLACE_STATE));
  }
  persist() { this._control(ANIMATION_CONTROL_PERSIST); }
  // An animation is the event target of its playback events (finish,
  // cancel, remove), with an event handler attribute for each.
  get onfinish() { return this._eventHandler("finish"); }
  set onfinish(callback) { this._setEventHandler("finish", callback); }
  get oncancel() { return this._eventHandler("cancel"); }
  set oncancel(callback) { this._setEventHandler("cancel", callback); }
  get onremove() { return this._eventHandler("remove"); }
  set onremove(callback) { this._setEventHandler("remove", callback); }
  _eventHandler(type) { return this._eventHandlers?.get(type) ?? null; }
  _setEventHandler(type, callback) {
    this._eventHandlers ??= new Map();
    const previous = this._eventHandlers.get(type);
    if (previous) this.removeEventListener(type, previous);
    if (typeof callback === "function") {
      this._eventHandlers.set(type, callback);
      this.addEventListener(type, callback);
    } else this._eventHandlers.delete(type);
  }
  addEventListener(type, callback, options) { addEventListener(this, type, callback, options); }
  removeEventListener(type, callback, options) { removeEventListener(this, type, callback, options); }
  dispatchEvent(event) { return dispatchEventFromScript(this, event); }
  // The bits of the animation property ids that the effect targets.
  get _targetProperties() {
    if (this._targetPropertyBits === undefined) {
      let bits = 0n;
      for (const keyframe of this._canonicalKeyframes) {
        for (const name of keyframePropertyNames(keyframe)) {
          const property = animationProperty(name);
          if (property === null) {
            throw new TypeError(`A keyframe of the animation targets ${name}, which the core does not animate`);
          }
          bits |= 1n << BigInt(property.id);
        }
      }
      this._targetPropertyBits = bits;
    }
    return this._targetPropertyBits;
  }
  // A replaced animation that the frame removed: its effect leaves the
  // effect stack, and its engine track with it. commitStyles() then writes
  // the values that it had as the frame removed it.
  _removeFromEffectStack() {
    this._engineHandle.cancelSilently();
    this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
  }
  // For each target property, its canonical name and the value of the
  // effect stack composed through this animation at `now`: the engine's
  // tracks, and the core's effects on the dependency properties
  // (animation_dependency_commit); null when no renderer lays out the
  // target.
  _committedValues(now) {
    const surface = this._surface;
    const renderer = surface._persistentRenderer;
    if (!renderer || surface._shutdown || surface._targetIndex(this._target) === undefined) return null;
    const values = this._engineHandle.trackIndices.map((track) => renderer.sampleAnimationThrough(track, now))
      .filter(({ propertyName }) => !isAnimationDependency(animationProperty(propertyName).id));
    for (const property of this._dependencyProperties(this._canonicalKeyframes)) {
      const value = this._core.statusRaw("animation_dependency_commit", this._animationId, property.id);
      if (Number.isFinite(value)) values.push({ propertyName: property.name, value: `${value}px` });
    }
    return values;
  }
  // Web Animations 1, section 6.4: the animation's value of each target
  // property goes into the target's inline style.
  commitStyles() {
    // Web Animations 1 §6.4: a pseudo-element target has no inline style.
    if (this._pseudoElement) {
      throw new DOMException(`commitStyles() cannot write the style of ${this._pseudoElement}`, "NoModificationAllowedError");
    }
    const values = this._value(ANIMATION_VALUE_REPLACE_STATE) === ANIMATION_REPLACE_STATE_REMOVED ?
      this._removedValues : this._committedValues(this._surface.currentTime);
    if (values === null) {
      throw new DOMException("commitStyles() needs a rendered target element", "InvalidStateError");
    }
    for (const { propertyName, value } of values) {
      this._element.style.setProperty(propertyName, String(value));
    }
  }
  _replaceEngineHandle() {
    const keyframes = this._canonicalKeyframes;
    this._setDependencyEffects(keyframes);
    if (this._value(ANIMATION_VALUE_EFFECT_WITHHELD) !== 0) {
      this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
      return;
    }
    this._engineHandle = this._surface._declareAnimation(this._target, keyframes, this._engineTiming(), {
      ...this._engineDeclarationOptions,
      animationId: this._animationId,
      trackGeneration: this._value(ANIMATION_VALUE_TRACK_GENERATION),
    });
  }
  // The properties of the keyframes whose values other values of the
  // element depend on (font-size): the core's computed resolution applies
  // their effects (animation_dependency_set). Their engine tracks hold the
  // timing and send the lifecycle events, and write no value.
  _dependencyProperties(keyframes) {
    const names = new Set(keyframes.flatMap(keyframePropertyNames));
    return [...names].map((name) => ({ name, id: animationProperty(name)?.id }))
      .filter(({ id }) => id !== undefined && isAnimationDependency(id));
  }
  _setDependencyEffects(keyframes) {
    const order = compositeClass(this) * 2 ** 32 + this._sequence;
    for (const property of this._dependencyProperties(keyframes)) {
      const frames = keyframes.filter((keyframe) => keyframe[property.name] !== undefined).map((keyframe) => ({
        offset: keyframe.offset, easing: keyframe.easing, composite: keyframe.composite,
        value: keyframe[property.name].values[0],
      }));
      setAnimationDependency({
        animationId: this._animationId, element: this._element, property, order, now: this._surface.currentTime,
        timing: this._timing, frames,
      });
    }
    // A custom property animates discretely from its specified values; a
    // missing keyframe at offset 0 or 1 takes the underlying value.
    const offsets = [];
    for (const { offset, index } of normalizeAnimationOffsets(
      this._processedKeyframes.map(({ offset }, index) => ({ offset, index })),
    )) offsets[index] = offset;
    const customNames = new Set(this._processedKeyframes.flatMap(({ values }) =>
      Object.keys(values).filter((name) => name.startsWith("--"))));
    for (const name of customNames) {
      const frames = this._processedKeyframes.flatMap(({ easing, composite, values }, index) =>
        values[name] === undefined ? [] : [{ offset: offsets[index], easing, composite, value: String(values[name]) }]);
      if (frames[0].offset !== 0) frames.unshift({ offset: 0, easing: "linear", composite: "auto", value: null });
      if (frames.at(-1).offset !== 1) frames.push({ offset: 1, easing: "linear", composite: "auto", value: null });
      setAnimationDependency({
        animationId: this._animationId, element: this._element, property: { id: ANIMATION_DEPENDENCY_CUSTOM, name },
        order, now: this._surface.currentTime, timing: this._timing, frames,
      });
    }
  }
  // The timing of the engine track at the animation's state.
  _engineTiming() {
    const reversed = this._value(ANIMATION_VALUE_REVERSED) ? 1 : 0;
    const direction = this._core.string("animation_track_direction",
      ...this._core.input(String(this._timing.direction ?? "normal")), reversed) || undefined;
    const fill = this._core.string("animation_track_fill",
      ...this._core.input(String(this._timing.fill ?? "none")), reversed);
    return {
      ...this._timing,
      direction,
      fill,
      easing: typeof this._timing.easing === "string" ? parseCSSEasing(this._timing.easing) : this._timing.easing,
      duration: this._value(ANIMATION_VALUE_DURATION), delay: this._value(ANIMATION_VALUE_DELAY),
      iterations: this._value(ANIMATION_VALUE_TRACK_ITERATIONS),
      startTime: this._value(ANIMATION_VALUE_ENGINE_START_TIME),
    };
  }
  // A provisional track (DOMRenderSurface._declareUnrenderedEffects) at
  // the animation's state on node `nodeIndex` of `renderer`, over the
  // element's other tracks; null when the animation applies no effect.
  _declareProvisionalTrack(renderer, nodeIndex) {
    const state = this._value(ANIMATION_VALUE_PLAY_STATE);
    if (state === 0 || this._value(ANIMATION_VALUE_EFFECT_WITHHELD) !== 0) return null;
    const track = renderer.animate(nodeIndex, this._canonicalKeyframes, this._engineTiming(),
      { animationId: this._animationId, preserveReplacedTracks: true });
    if (state === ANIMATION_PLAY_STATE_PAUSED) track.pause(this._surface.currentTime);
    return track;
  }
  // The finish notification steps (Web Animations 1, section 4.4.15): the
  // finished promise resolves and the `finish` event, with the animation's
  // current time, waits for the next frame's update.
  _notifyFinished(resolve) {
    resolve(this);
    this._surface._queuePlaybackEvent(this, "finish", this.currentTime);
  }
  _applyActions(actions) {
    // A settled promise gives the frame's animation update a microtask
    // checkpoint to run its reactions in (RenderSurface._render).
    if (actions & PROMISE_SETTLING_ACTIONS) this._surface._animationPromisesSettled = true;
    if (actions & ACTION.RESET_READY) this._resetReadyPromise();
    if (actions & ACTION.RESET_FINISHED) this._resetFinishedPromise();
    if (actions & ACTION.PEND_PAUSE) this._surface._animationsPausePending.add(this);
    // The animation's own track replaces or ends the provisional track that
    // applied its effect before a frame declared it.
    if (actions & (ACTION.DECLARE | ACTION.CANCEL_THROUGH_ENGINE | ACTION.CANCEL_SILENTLY)) {
      this._surface._dropProvisionalTrack(this._animationId);
    }
    if (actions & ACTION.CANCEL_THROUGH_ENGINE) {
      const generation = this._value(ANIMATION_VALUE_CONTROL_GENERATION);
      this._surface._animationCancelingThroughEngine = this;
      try { this._engineHandle.cancel(); }
      finally { this._surface._animationCancelingThroughEngine = null; }
      this._applyActions(this._core.statusRaw("animation_control", this._animationId, ANIMATION_CONTROL_CANCEL_GENERATION,
        generation, this._surface.currentTime));
    }
    if (actions & ACTION.CANCEL_SILENTLY) this._engineHandle.cancelSilently();
    if (actions & ACTION.REJOIN_HOST) this._rejoinHost();
    if (actions & ACTION.DECLARE) this._replaceEngineHandle();
    if (actions & ACTION.PAUSE) this._engineHandle.pause(this._surface.currentTime);
    if (actions & ACTION.RESUME) this._engineHandle.resume(this._surface.currentTime);
    if (actions & ACTION.SEEK) this._engineHandle.seek(this._value(ANIMATION_VALUE_SCROLL_TIME), this._surface.currentTime);
    // The computed style follows a declared, paused, resumed or seeked
    // track at once, before the next frame (CSSOM getComputedStyle
    // updates the style of the element it reads).
    if (actions & (ACTION.DECLARE | ACTION.PAUSE | ACTION.RESUME | ACTION.SEEK)) {
      this._engineHandle.captureSamples(this._surface.currentTime);
    }
    if (actions & ACTION.LEAVE_HOST) this._leaveHost();
    if (actions & ACTION.REJECT_FINISHED) {
      this._rejectFinished(new DOMException("Animation canceled", "AbortError"));
      this._surface._queuePlaybackEvent(this, "cancel", null);
    }
    if (actions & ACTION.REJECT_READY) {
      this._rejectReady(new DOMException("Animation canceled", "AbortError"));
      this._ready = Promise.resolve(this);
    }
    if (actions & ACTION.RESOLVE_FINISHED) this._notifyFinished(this._resolveFinished);
    if (actions & ACTION.NOTIFY_FINISHED) {
      // The core decides in a microtask whether the promise of this
      // generation still resolves (animation_finish_notify).
      const generation = this._value(ANIMATION_VALUE_PROMISE_GENERATION);
      const resolve = this._resolveFinished;
      queueMicrotask(() => {
        if (this._core.status("animation_finish_notify", this._animationId, generation) !== 0) this._notifyFinished(resolve);
      });
    }
    if (actions & ACTION.FRAME) this._surface._scheduleAnimationFrame(this._element);
    if (actions & ACTION.RESOLVE_READY) this._resolveReady(this);
    return actions !== 0;
  }
  // Runs control operation `operation` with `value` through the core
  // export `exportName` (animation_control, or animation_script_control
  // for script's operations on a CSS animation) and applies its actions.
  _control(operation, value = 0, exportName = "animation_control") {
    let actions;
    try {
      actions = this._core.statusRaw(exportName, this._animationId, operation, value, this._surface.currentTime);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new error.constructor(`Animation control operation ${operation} with value ${value}: ${error.message}`, { cause: error });
    }
    return this._applyActions(actions);
  }
  // An operation of the programming interface: play(), pause(), cancel(),
  // finish(), reverse() and the currentTime, startTime and playbackRate
  // setters. Its result takes the pending style changes into account.
  _scriptControl(operation, value = 0) {
    this._applyPendingStyleChanges();
    return this._control(operation, value);
  }
  // The style changes since the last style update that this animation's
  // state depends on. A script animation's state does not follow style; a
  // CSS animation's does (CSSAnimation._applyPendingStyleChanges).
  _applyPendingStyleChanges() {}
  // The user agent cancels the animation: the CSS animation of an element
  // that leaves the document or the rendering, or of an animation-name that
  // goes away. It is part of a style update, so no pending style change
  // applies first, as it does for script's cancel().
  _cancelByUserAgent() { this._control(ANIMATION_CONTROL_CANCEL); }
  _leaveHost() { this._surface._removeAnimation(this); }
  _rejoinHost() { this._surface._restoreAnimation(this); }
  // Whether an engine event with this animation id is one of this
  // animation's tracks.
  _ownsEngineAnimationId(animationId) { return animationId === this._animationId; }
  get _timelinePending() { return this._value(ANIMATION_VALUE_TIMELINE_PENDING) !== 0; }
  // The surface that adopted this animation has reached a frame, so its
  // timeline finally has a time.
  _resolveTimeline() { this._control(ANIMATION_CONTROL_RESOLVE_TIMELINE); }
  _commitPendingPause() { this._control(ANIMATION_CONTROL_COMMIT_PAUSE); }
  // Detachment drops rendering resources, not the document timeline. The
  // weakly held per-element host keeps the clock without retaining removed
  // targets from the live surface.
  // Script cleared or set the animation's timeline. Without a timeline it
  // holds its current time and stays pending (ANIMATION_CONTROL_PEND_TIMELINE),
  // and no frame starts it; the document timeline again lets the next
  // frame of its surface start it.
  _setTimeline(timeline) {
    const cleared = timeline === null;
    if (cleared === this._timelineCleared) return;
    this._timelineCleared = cleared;
    if (!cleared) {
      this._surface._resumeTimeline(this);
      return;
    }
    this._surface._suspendTimeline(this);
    if (!this._timelinePending) {
      this._engineHandle.cancelSilently();
      this._control(ANIMATION_CONTROL_PEND_TIMELINE, this._surface.currentTime);
    }
  }
  _detachFromSurface() {
    this._engineHandle.cancelSilently();
    let timeline = detachedAnimationTimelines.get(this._element);
    if (timeline === undefined) {
      timeline = new PendingAnimationTimeline(this._surface);
      detachedAnimationTimelines.set(this._element, timeline);
    }
    this._surface = timeline;
    timeline._adoptAnimation(this);
    this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
  }
  _restoreEngineBinding() {
    const state = this._value(ANIMATION_VALUE_PLAY_STATE);
    if (state === ANIMATION_PLAY_STATE_IDLE) return;
    this._applyActions(ACTION.DECLARE | (state === ANIMATION_PLAY_STATE_PAUSED ? ACTION.PAUSE : 0));
  }
  // The surface shut down. The animation moves to its document's pending
  // timeline, where the next surface that claims its element adopts it.
  _moveToPendingTimeline() {
    const previousTime = this._surface.currentTime;
    this._engineHandle.cancelSilently();
    const timeline = elementAnimationHost(this._element, null);
    this._surface = timeline;
    timeline._adoptAnimation(this);
    this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
    this._control(ANIMATION_CONTROL_PEND_TIMELINE, previousTime);
  }
  _resetReadyPromise() {
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // As with `finished`, an unobserved rejection is not a host failure.
    this._ready.catch(() => {});
  }
  // A script animation's timeline and range come from its options alone:
  // the document timeline and the range normal without them (Web
  // Animations 1 §4.4, Web Animations 2 §6.4). A CSS animation takes the
  // element's (CSSAnimation).
  _timelineValue() {
    return this._timelineOption ?? "auto";
  }
  _timelineRangeStart() {
    return this._rangeStartOption ?? "normal";
  }
  _timelineRangeEnd() {
    return this._rangeEndOption ?? "normal";
  }
  _isScrollDriven() { return isScrollTimeline(this._core, this._timelineValue()); }
  _sampleScrollTimeline(progress) {
    return this._control(ANIMATION_CONTROL_SCROLL_PROGRESS, progress === null ? NaN : progress);
  }
  _needsFrame() { return this._value(ANIMATION_VALUE_NEEDS_FRAME) !== 0; }
  // The frame's update of the finished state (animation_update_finished):
  // the animation finishes when its time reaches its effect end.
  _updateFinishedState() {
    this._applyActions(this._core.status("animation_update_finished", this._animationId, this._surface.currentTime));
  }
  *_iterationEventsAtCurrentTime() {
    for (;;) {
      const elapsed = this._core.status("animation_iteration_next", this._animationId, this._surface.currentTime);
      if (Number.isNaN(elapsed)) return;
      yield elapsed;
    }
  }
  _beginEngineLifecycle(record) {
    const handle = this._core.handle("animation_feedback_begin", this._animationId,
      record.trackGeneration, this._lifecycleKind(record.type), this._surface.currentTime);
    if (!handle) return null;
    return { handle, token: this._core.handle("animation_feedback_next", handle) };
  }
  _completeEngineLifecycle(feedback) {
    try {
      this._applyActions(this._core.status("animation_feedback_complete", feedback.handle, feedback.token, this._surface.currentTime));
    } finally { this._core.status("animation_feedback_release", feedback.handle); }
  }
  _elapsedTimeForEvent(type) {
    return this._core.status("animation_elapsed", this._animationId, this._lifecycleKind(type), this._surface.currentTime);
  }
  _lifecycleKind(type) {
    return this._core.exports.animation_lifecycle_kind(...this._core.input(String(type)));
  }
}
// The getters of the animation's times, play state, pending state and
// promises answer after the pending style changes apply (CSS Animations 2
// §6.2).
installAnimationBindings({
  readTime(animation, field) {
    animation._applyPendingStyleChanges();
    const value = animation._value(field);
    return Number.isNaN(value) ? null : value;
  },
  readState(animation) {
    animation._applyPendingStyleChanges();
    return animation._core.string("animation_enumeration_name", ANIMATION_ENUMERATION_PLAY_STATE, animation._value(ANIMATION_VALUE_PLAY_STATE));
  },
  // An animation is pending until the frame that resolves its start time.
  readPending(animation) {
    animation._applyPendingStyleChanges();
    return animation._value(ANIMATION_VALUE_PENDING) !== 0;
  },
  // A style change that plays or pauses a CSS animation replaces its ready
  // promise.
  readReady(animation) {
    animation._applyPendingStyleChanges();
    return animation._ready;
  },
  readFinished(animation) {
    animation._applyPendingStyleChanges();
    return animation._finishedPromise;
  },
  // The animation's timeline (animation_timeline_kind): the document
  // timeline, none, or a scroll timeline, which has no script object.
  readTimeline(animation) {
    animation._applyPendingStyleChanges();
    if (animation._timelineCleared) return null;
    const value = String(animation._timelineValue());
    const kind = animation._core.exports.animation_timeline_kind(...animation._core.input(value));
    if (kind === ANIMATION_TIMELINE_KIND_DOCUMENT) return documentTimeline(animation._element.ownerDocument);
    if (kind === ANIMATION_TIMELINE_KIND_NONE) return null;
    throw new DOMException(`Animation.timeline: the scroll timeline ${value} has no script object in Sandom`, "NotSupportedError");
  },
  // Setting the timeline (Web Animations 1, "Setting the timeline of an
  // animation"): a document timeline or null.
  writeTimeline(animation, value) {
    if (value !== null && !isDocumentTimeline(value)) {
      throw new TypeError(`Animation.timeline: ${Object.prototype.toString.call(value)} is not an AnimationTimeline`);
    }
    animation._applyPendingStyleChanges();
    animation._setTimeline(value);
  },
  currentTimeInput(value) {
    if (value === null) throw new TypeError("currentTime cannot be null");
    const time = Number(value);
    if (!Number.isFinite(time)) throw new TypeError("currentTime must be finite");
    return time;
  },
  startTimeInput(value) {
    const time = value === null ? NaN : Number(value);
    if (value !== null && !Number.isFinite(time)) throw new TypeError("startTime must be finite or null");
    return time;
  },
  rateInput(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate)) throw new TypeError("playbackRate must be finite");
    return rate;
  },
}, Animation.prototype);

// The timing of the CSS animation of an animation definition
// (StyleSystem.animationDefinitions), with its animation-composition.
export function cssAnimationTiming(definition) {
  return { ...definition.timing, composite: definition.composition };
}
// The parts of an animation definition that make up a CSS animation's
// effect: all but its name and play state.
function cssAnimationEffectText({ keyframes, implicitKeyframe, composition, timing }) {
  return JSON.stringify({ keyframes, implicitKeyframe, composition, timing });
}

// A CSS animation: the animation a keyframes rule names in an element's
// animation-name list (css-animations-2 §4.1).
export class CSSAnimation extends Animation {
  constructor(surface, element, keyframes, timing, engineDeclarationOptions) {
    super(surface, element, keyframes, timing, engineDeclarationOptions);
    this._cssAnimationName = engineDeclarationOptions.diagnosticAnimationName;
  }
  // The element's first animation-timeline, animation-range-start and
  // animation-range-end items (computed_field_list_text).
  _firstListText(field, fallback) {
    return this._element._domCore.string("computed_field_list_text", this._element._coreHandle, ...this._element._domCore.input(field), 0) ?? fallback;
  }
  _timelineValue() {
    return this._timelineOption ?? this._firstListText("animationTimeline", "auto");
  }
  _timelineRangeStart() {
    return this._rangeStartOption ?? this._firstListText("animationRangeStart", "normal");
  }
  _timelineRangeEnd() {
    return this._rangeEndOption ?? this._firstListText("animationRangeEnd", "normal");
  }
  // The style update that the read or operation of script needs (CSS
  // Animations 2 §6.2): it starts, updates and cancels the element's CSS
  // animations, this one among them.
  _applyPendingStyleChanges() { this._surface._startStyleChangeAnimations(); }
  // A script operation, which may override animation-play-state
  // (animation_script_control).
  _scriptControl(operation, value = 0) {
    this._applyPendingStyleChanges();
    return this._control(operation, value, "animation_script_control");
  }
  // A change of the animation-* properties updates the CSS animation in
  // place (css-animations-2 §2): the core decides whether its effect
  // changed and whether it is declared again
  // (animation_style_effect_actions), and what its play state does
  // (animation_style_play_state).
  _updateFromStyle(definition, previousDefinition) {
    const effect = this._core.status("animation_style_effect_actions", this._animationId,
      ...this._core.input(cssAnimationEffectText(previousDefinition)), ...this._core.input(cssAnimationEffectText(definition)));
    if (effect & ANIMATION_STYLE_EFFECT_CHANGED) {
      this._assignKeyframes(definition.keyframes, definition.implicitKeyframe);
      this._recordKeyframesFollowElement();
      const scroll = this._assignTiming(cssAnimationTiming(definition));
      const actions = this._core.statusRaw("animation_timing_set", this._animationId, this._timing.duration,
        this._timing.delay, Number(this._timing.iterations), this._timing.endDelay, scroll ? 1 : 0,
        this._surface.currentTime);
      // The effects on the properties that other values depend on are
      // registered again for the new keyframes as the track is declared.
      if (this._replaceKeyframes(this._computeCanonicalKeyframes())) {
        this._core.status("animation_dependency_clear", this._animationId);
      }
      const redeclare = (effect & ANIMATION_STYLE_EFFECT_REDECLARE) !== 0;
      this._applyActions(actions | (redeclare ? ACTION.FRAME : 0));
      if (redeclare) this._redeclareTrack();
    }
    this._followPlayState(previousDefinition.paused, definition.paused);
  }
  // animation-play-state going from `previousPaused` to `paused`
  // (animation_style_play_state).
  _followPlayState(previousPaused, paused) {
    this._applyActions(this._core.statusRaw("animation_style_play_state", this._animationId,
      previousPaused ? 1 : 0, paused ? 1 : 0, this._surface.currentTime));
  }
  // A CSS animation reports its keyframes with computed values
  // (css-animations-2 section 4.1): the core's canonical values.
  _reportedKeyframes() {
    return this._canonicalKeyframes.map(({ offset, easing, composite = "auto", ...values }) => {
      const frame = { offset, easing: easingText(easing), composite };
      for (const [propertyName, value] of Object.entries(values)) {
        frame[idlName(propertyName)] = String(value);
      }
      frame.computedOffset = offset;
      return frame;
    });
  }
}
installCSSAnimationBindings({}, CSSAnimation.prototype);

function idlName(propertyName) {
  return propertyName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

// A CSS transition (css-transitions-2 §6.1): the Web Animations object over
// the track the renderer declared for it. Its timing is the core's
// animation record; its controls drive that same engine track. A record
// without an engine handle is a transition that a read between frames
// found a style change to start: it is pending, and its handle queues the
// host's commands for the track that the next frame declares
// (_adoptDeclaredTrack). Until that frame, a provisional track applies its
// effect (_refreshProvisionalTrack).
export class CSSTransition extends Animation {
  constructor(surface, target, propertyName, record, generation) {
    const transitionTrack = {
      propertyName,
      easing: record.easing,
      keyframes: [
        { offset: 0, value: record.trackStartValue },
        { offset: 1, value: record.endValue },
      ],
    };
    super(surface, target, [], {
      delay: record.delay,
      direction: "normal",
      duration: record.duration,
      easing: record.easing,
      endDelay: 0,
      fill: "backwards",
      iterationStart: 0,
      iterations: 1,
    }, record.engineHandle === undefined
      ? { timelinePending: true, awaitingDeclaration: true, transitionTrack }
      : { startTime: record.startTimeMilliseconds, adoptedEngineHandle: record.engineHandle, transitionTrack });
    this._transitionProperty = propertyName;
    this._transitionRecord = record;
    this._transitionGeneration = generation;
    this._trackAnimationId = record.animationId;
    this._setDependencyEffects();
    // The frame that declares a transition starts it.
    if (!this._timelinePending) this._resolveReady(this);
    if (this._awaitingDeclaration) this._refreshProvisionalTrack();
  }
  // A pending transition holds at its current time, and its effect applies
  // the value at that time (Web Animations 1, "The current time of an
  // animation"): the start value, at current time 0. Until the frame that
  // declares the transition's track, a provisional track at the
  // transition's state applies that effect over the element's other
  // tracks (DOMRenderSurface._setProvisionalTrack).
  _refreshProvisionalTrack() {
    const surface = this._surface;
    surface._dropProvisionalTrack(this._animationId);
    const state = this._value(ANIMATION_VALUE_PLAY_STATE);
    if (!this._awaitingDeclaration || surface._rendering || state === 0) return;
    const { transitionTrack } = this._engineDeclarationOptions;
    const now = surface.currentTime;
    const track = surface._declareProvisionalTransitionTrack(this._target, transitionTrack.propertyName,
      transitionTrack.keyframes, this._provisionalTiming(), this._animationId);
    if (track === null) return;
    if (state === ANIMATION_PLAY_STATE_PAUSED) track.pause(now);
    track.captureSamples(now);
    surface._setProvisionalTrack(this._animationId, track);
  }
  // The provisional track of a pending transition of an element that no
  // frame has rendered, on node `nodeIndex` of the synchronous layout
  // (DOMRenderSurface._declareUnrenderedEffects); null when it applies no
  // effect.
  _declareProvisionalTrack(renderer, nodeIndex) {
    const state = this._value(ANIMATION_VALUE_PLAY_STATE);
    if (!this._awaitingDeclaration || state === 0) return null;
    const { transitionTrack } = this._engineDeclarationOptions;
    const track = renderer.declareTransitionTrack(nodeIndex, transitionTrack.propertyName, transitionTrack.keyframes,
      this._provisionalTiming(), { animationId: this._animationId, preserveReplacedTracks: true });
    if (state === ANIMATION_PLAY_STATE_PAUSED) track.pause(this._surface.currentTime);
    return track;
  }
  _provisionalTiming() {
    return {
      duration: this._value(ANIMATION_VALUE_DURATION), delay: this._value(ANIMATION_VALUE_DELAY),
      startTime: this._value(ANIMATION_VALUE_ENGINE_START_TIME), fill: "backwards",
      easing: this._engineDeclarationOptions.transitionTrack.easing,
      direction: this._value(ANIMATION_VALUE_REVERSED) ? "reverse" : "normal",
    };
  }
  // The frame that starts a pending transition declared its track with this
  // object's identity and timing (DOMRenderSurface._heldTransitionDeclaration).
  // The transition runs on that track from now on, with the start value
  // that the engine took and the duration that the declaration gave it (a
  // reversal shortens it); the commands queued while it was pending reach
  // the track.
  _adoptDeclaredTrack(record, generation) {
    const { transitionTrack } = this._engineDeclarationOptions;
    transitionTrack.keyframes = [
      { offset: 0, value: record.trackStartValue },
      { offset: 1, value: record.endValue },
    ];
    this._engineDeclarationOptions = { transitionTrack };
    this._transitionRecord = record;
    this._transitionGeneration = generation;
    this._trackAnimationId = record.animationId;
    // The core holds the iteration duration; the duration field is it over
    // the rate.
    if (record.duration !== this._value(ANIMATION_VALUE_DURATION)) {
      this._core.statusRaw("animation_control", this._animationId, ANIMATION_CONTROL_ITERATION_DURATION,
        record.duration * (Math.abs(this._value(ANIMATION_VALUE_PLAYBACK_RATE)) || 1), this._surface.currentTime);
    }
    const binding = this._declarationBinding;
    this._declarationBinding = null;
    this._engineHandle = record.engineHandle;
    binding.bind(null, 0);
    this._setDependencyEffects();
  }
  // A transition of a property that other values depend on (font-size)
  // applies in the core's computed resolution, in the transition origin:
  // after every animation and over important declarations. Its engine
  // track holds the timing and sends the events.
  _setDependencyEffects() {
    // The base constructor declares before this transition holds its record.
    if (this._transitionRecord === undefined) return;
    const property = animationProperty(this._transitionProperty);
    if (property === null || !isAnimationDependency(property.id)) return;
    // The renderer starts no transition of such a property on a ::before
    // or ::after (scene-renderer.js planNodeTransitions).
    if (this._pseudoElement) {
      throw new Error(`A ${this._transitionProperty} transition of ${this._pseudoElement} reached computed resolution, which applies it to the element`);
    }
    const record = this._transitionRecord;
    setAnimationDependency({
      animationId: this._animationId, element: this._element, property, order: 3 * 2 ** 32 + this._sequence,
      now: this._surface.currentTime, timing: this._timing, transition: true,
      frames: [
        { offset: 0, easing: "linear", composite: "auto", value: record.trackStartValue.values[0] },
        { offset: 1, easing: "linear", composite: "auto", value: record.endValue.values[0] },
      ],
    });
  }
  // A transition's keyframes are its start and end values; its timing
  // function is the effect's easing.
  _reportedKeyframes() {
    const record = this._transitionRecord;
    return [record.trackStartValue, record.endValue].map((value, index) => ({
      offset: index, easing: "linear", composite: "auto",
      [idlName(this._transitionProperty)]: String(value),
      computedOffset: index,
    }));
  }
  _timelineValue() { return "auto"; }
  // Whether the transition's track still moves on the clock: running at a
  // nonzero rate, or finished and awaiting the tick that ends its track.
  _trackAdvances() { return this._needsFrame() || this._value(ANIMATION_VALUE_PLAY_STATE) === ANIMATION_PLAY_STATE_FINISHED; }
  _ownsEngineAnimationId(animationId) {
    return animationId === this._animationId || animationId === this._trackAnimationId;
  }
  // The renderer's own track serves the first declaration; a change of
  // time, rate or direction declares the transition's track again. Until
  // the frame declares a pending transition's track, a deferred binding
  // queues the commands for it.
  _replaceEngineHandle() {
    this._setDependencyEffects();
    const { adoptedEngineHandle, awaitingDeclaration, transitionTrack } = this._engineDeclarationOptions;
    if (awaitingDeclaration) {
      this._declarationBinding = deferAnimationBinding(() => this._transitionRecord.engineHandle);
      this._engineHandle = this._declarationBinding.handle;
      return;
    }
    if (adoptedEngineHandle) {
      this._engineDeclarationOptions = { transitionTrack };
      this._engineHandle = adoptedEngineHandle;
      return;
    }
    this._engineHandle = this._surface._declareTransitionTrack(
      this._target, transitionTrack.propertyName, transitionTrack.keyframes, {
        duration: this._value(ANIMATION_VALUE_DURATION), delay: this._value(ANIMATION_VALUE_DELAY),
        startTime: this._value(ANIMATION_VALUE_ENGINE_START_TIME),
        easing: transitionTrack.easing, direction: this._value(ANIMATION_VALUE_REVERSED) ? "reverse" : "normal",
      }, { animationId: this._animationId, trackGeneration: this._value(ANIMATION_VALUE_TRACK_GENERATION) },
    );
  }
  // A pending transition is in the surface's pending transitions, not in
  // its registry, until the frame declares its track.
  get _awaitingDeclaration() { return this._engineDeclarationOptions.awaitingDeclaration === true; }
  _leaveHost() { this._surface._unregisterTransition(this); }
  _rejoinHost() { if (!this._awaitingDeclaration) this._surface._registerTransitionAnimation(this); }
  _applyActions(actions) {
    const applied = super._applyActions(actions);
    // The registry holds the timing the track runs: a running or paused
    // transition is registered (play() after its end registers it again),
    // at the start, duration and delay of its current track.
    const state = this._value(ANIMATION_VALUE_PLAY_STATE);
    if (!this._awaitingDeclaration && (state === ANIMATION_PLAY_STATE_RUNNING || state === ANIMATION_PLAY_STATE_PAUSED)) {
      this._surface._registerTransitionAnimation(this);
    }
    const record = this._transitionRecord;
    record.startTimeMilliseconds = this._value(ANIMATION_VALUE_ENGINE_START_TIME);
    record.duration = this._value(ANIMATION_VALUE_DURATION);
    record.delay = this._value(ANIMATION_VALUE_DELAY);
    // A track declared, resumed or seeked now runs from the next tick.
    if (actions & (ACTION.DECLARE | ACTION.RESUME | ACTION.SEEK)) record.trackAwaitsTick = true;
    // A control call on a pending transition changes the effect of its
    // provisional track.
    if (this._awaitingDeclaration && (actions & (ACTION.CANCEL_SILENTLY | ACTION.DECLARE | ACTION.PAUSE | ACTION.RESUME |
      ACTION.CANCEL_THROUGH_ENGINE | ACTION.SEEK))) this._refreshProvisionalTrack();
    return applied;
  }
  // The engine replaced this transition's track before the registry saw
  // its cancel: settle the record as cancelled without touching a track.
  _settleReplaced() {
    this._core.statusRaw("animation_control", this._animationId, ANIMATION_CONTROL_CANCEL, 0, this._surface.currentTime);
    this._applyActions(this._core.statusRaw("animation_control", this._animationId, ANIMATION_CONTROL_CANCEL_GENERATION,
      this._value(ANIMATION_VALUE_CONTROL_GENERATION), this._surface.currentTime));
  }
}
installCSSTransitionBindings({}, CSSTransition.prototype);
// Each interface prototype's class string (Web IDL §3.7.3).
for (const [name, Interface] of Object.entries({ Animation, CSSAnimation, CSSTransition })) {
  Object.defineProperty(Interface.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

export function createDOMAnimation(surface, element, keyframes, timing, engineDeclarationOptions = {}) {
  return engineDeclarationOptions.diagnosticAnimationName == null
    ? new Animation(surface, element, keyframes, timing, engineDeclarationOptions)
    : new CSSAnimation(surface, element, keyframes, timing, engineDeclarationOptions);
}

function compositeClass(animation) {
  return animation instanceof CSSTransition ? ORDER.TRANSITION : animation instanceof CSSAnimation ? ORDER.CSS_ANIMATION : ORDER.SCRIPT;
}
// Web Animations composite order as Chrome orders getAnimations()
// (animation_composite_order).
function sortInCompositeOrder(animations) {
  if (animations.length < 2) return animations;
  const native = animations[0]._element._domCore;
  const properties = animations.map((animation) => native.input(String(animation._transitionProperty ?? "")));
  const rows = native.exports.abi_allocate(animations.length * ORDER.SIZE);
  const view = new DataView(native.refreshBytes().buffer);
  for (let index = 0; index < animations.length; index++) {
    const animation = animations[index];
    const row = rows + index * ORDER.SIZE;
    view.setBigUint64(row + ORDER.ELEMENT, BigInt(animation._element._coreHandle ?? 0n), true);
    view.setUint32(row + ORDER.PSEUDO, PSEUDO_ELEMENT_NAMES.indexOf(animation._pseudoElement), true);
    view.setUint32(row + ORDER.CLASS, compositeClass(animation), true);
    view.setInt32(row + ORDER.NAME_POSITION, animation._surface._cssAnimations?.get(animation._element)
      ?.findIndex((record) => record.animation === animation) ?? -1, true);
    view.setFloat64(row + ORDER.SEQUENCE, Number(animation._sequence), true);
    view.setFloat64(row + ORDER.GENERATION, Number(animation._transitionGeneration), true);
    view.setUint32(row + ORDER.PROPERTY_POINTER, properties[index][0], true);
    view.setUint32(row + ORDER.PROPERTY_LENGTH, properties[index][1], true);
  }
  const count = native.status("animation_composite_order", rows, animations.length);
  const order = count === 0 ? null : native.output("animation_composite_order");
  const sorted = Array.from({ length: count }, (_, index) => animations[order.getUint32(index * U32, true)]);
  for (let index = 0; index < count; index++) animations[index] = sorted[index];
  return animations;
}

// An animation getAnimations() reports (animation_reported). A transition
// fills backwards, so its end leaves it out.
function reportedAnimation(animation) {
  return animation._core.status("animation_reported", animation._animationId,
    ...animation._core.input(String(animation._timing.fill))) !== 0;
}

// Removing replaced animations (Web Animations 1, section 5.5) at `now`:
// the script animations among `animations` that later script animations
// of the same target replace. The core decides which, one target at a
// time (animation_remove_replaced); their effects leave the effect stack.
// CSS animations and transitions are neither replaced nor replace others.
// Returns the removed animations in composite order.
export function removeReplacedAnimations(animations, now) {
  const byTarget = new Map();
  for (const animation of animations) {
    if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
    let list = byTarget.get(animation._target);
    if (list === undefined) byTarget.set(animation._target, list = []);
    list.push(animation);
  }
  const removed = [];
  for (const list of byTarget.values()) {
    list.sort((first, second) => first._sequence - second._sequence);
    const input = new DataView(new ArrayBuffer(list.length * REPLACED.SIZE));
    for (let index = 0; index < list.length; index++) {
      const animation = list[index];
      const entry = index * REPLACED.SIZE;
      input.setBigUint64(entry + REPLACED.HANDLE, animation._animationId, true);
      input.setBigUint64(entry + REPLACED.PROPERTIES, animation._targetProperties, true);
      input.setFloat64(entry + REPLACED.END_DELAY, animation._timing.endDelay, true);
      input.setUint32(entry + REPLACED.FILL,
        animation._core.exports.animation_fill_mode(...animation._core.input(String(animation._timing.fill))), true);
    }
    const core = list[0]._core;
    const [pointer] = core.byteInput(new Uint8Array(input.buffer));
    const count = core.status("animation_remove_replaced", pointer, list.length, now);
    const view = count === 0 ? null : core.output("animation_remove_replaced");
    for (let index = 0; index < count; index++) removed.push(list[view.getUint32(index * U32, true)]);
  }
  // commitStyles() of a removed animation writes the values it had here;
  // each is sampled before any removed track leaves its stack.
  for (const animation of removed) animation._removedValues = animation._committedValues(now);
  for (const animation of removed) animation._removeFromEffectStack();
  return removed.sort((first, second) => first._sequence - second._sequence);
}

// The animations of `element`; with `subtree` also those of its ::before
// and ::after and of its descendants and theirs (Web Animations 1 §6.6).
export function animationsForElement(animations, element, subtree) {
  return sortInCompositeOrder(animations.filter((animation) => {
    if (!reportedAnimation(animation)) return false;
    if (animation._element === element) return subtree || !animation._pseudoElement;
    if (!subtree) return false;
    for (
      let node = animation._element.parentElement;
      node;
      node = node.parentElement
    ) {
      if (node === element) return true;
    }
    return false;
  }));
}

// document.getAnimations(): the animations of every element of the
// document, from the surface that owns each element (the primary surface
// of its root) or the document's pending timeline. Each surface updates
// its style first, as the element form does.
export function documentAnimations(document) {
  const candidates = [];
  for (const surface of document._liveRenderSurfaces ?? []) {
    if (surface._shutdown || surface._root._renderSurface !== surface) continue;
    surface._startStyleChangeAnimations();
    candidates.push(...surface._animationCandidates());
  }
  const pending = pendingAnimationTimelines.get(document);
  if (pending !== undefined) candidates.push(...pending._animations);
  return sortInCompositeOrder(candidates.filter((animation) =>
    reportedAnimation(animation) && animation._element.isConnected &&
    animation._element.ownerDocument === document
  ));
}


// `element.animate()` does not require a render surface: the Web Animations
// API has none of that, and a host that builds a whole animating document
// before rendering it must not lose the document to an exception. Until a
// surface claims the element, its animations live on this per-document
// timeline, which has no clock: each one holds at its current time the way a
// play-pending animation does in Chrome, and the surface that adopts the
// element resolves their start times on its next frame
// (DOMRenderSurface._adoptPendingAnimations and Animation._resolveTimeline).
const pendingAnimationTimelines = new WeakMap();
const detachedAnimationTimelines = new WeakMap();

// An animation on a timeline without a renderer, or a removed one, has a
// deferred binding as its engine handle, which queues the host's commands
// natively; the frame that resolves a pending animation's start time, and
// persist() on a removed one, declare the real track from the core's own
// state, so this is never reached.
function declareWithoutRenderer() {
  throw new Error("a pending animation has no renderer to declare against");
}

class PendingAnimationTimeline {
  constructor(clock = null) {
    this._clock = clock;
    this._animations = [];
    this._animationsByElement = new Map();
    // _applyActions writes this slot while cancelling through the engine.
    this._animationCancelingThroughEngine = null;
  }
  get currentTime() {
    return this._clock?.currentTime ?? 0;
  }
  _createAnimation(element, keyframes, options) {
    const animation = createDOMAnimation(this, element, keyframes, options, { timelinePending: true });
    this._adoptAnimation(animation);
    return animation;
  }
  _adoptAnimation(animation) {
    this._animations.push(animation);
    const forElement = this._animationsByElement.get(animation._element);
    if (forElement === undefined) {
      this._animationsByElement.set(animation._element, [animation]);
    } else {
      forElement.push(animation);
    }
  }
  _animationsForElement(element, subtree) {
    return animationsForElement(this._animations, element, subtree);
  }
  // No style update runs on a timeline without a renderer: the surface
  // that adopts the element brings its CSS animations up to date.
  _startStyleChangeAnimations() {}
  // A timeline without a renderer has no frame to send events in: an
  // animation's finish and cancel events wait on it for the surface that
  // adopts its element (DOMRenderSurface._adoptPendingAnimations).
  _queuePlaybackEvent(animation, type, currentTime) {
    (animation._heldPlaybackEvents ??= []).push({ type, currentTime });
  }
  _removeAnimation(animation) {
    const index = this._animations.indexOf(animation);
    if (index >= 0) this._animations.splice(index, 1);
    const forElement = this._animationsByElement.get(animation._element);
    const elementIndex = forElement?.indexOf(animation) ?? -1;
    if (elementIndex >= 0) forElement.splice(elementIndex, 1);
    if (forElement?.length === 0) {
      this._animationsByElement.delete(animation._element);
    }
  }
  _restoreAnimation(animation) {
    if (!this._animations.includes(animation)) this._adoptAnimation(animation);
  }
  // Nothing renders yet; the adopting surface schedules the first frame.
  _scheduleAnimationFrame() {}
  // Without a renderer there is no provisional track.
  _dropProvisionalTrack() {}
  // An animation on this timeline waits for the surface that adopts its
  // element, with a timeline or without one.
  _suspendTimeline() {}
  _resumeTimeline() {}
  // Without a renderer, an animation's effect has no track to declare yet,
  // nor a provisional one.
  _declareAnimation() { return deferAnimationBinding(declareWithoutRenderer).handle; }
  _declareProvisionalTransitionTrack() { return null; }
  _dropProvisionalTrack() {}
  _takeAnimationsFor(element) {
    const taken = this._animationsByElement.get(element);
    if (taken === undefined) return null;
    this._animationsByElement.delete(element);
    for (const animation of taken) {
      const index = this._animations.indexOf(animation);
      if (index >= 0) this._animations.splice(index, 1);
    }
    return taken;
  }
}

// The `animate`/`getAnimations` binding hook: the element's live surface owns
// its animations, and its document's pending timeline holds them until one
// does.
export function elementAnimationHost(element, surface) {
  if (surface) return surface;
  const detached = detachedAnimationTimelines.get(element);
  if (detached !== undefined) return detached;
  const owner = element.ownerDocument ?? element;
  let timeline = pendingAnimationTimelines.get(owner);
  if (timeline === undefined) {
    timeline = new PendingAnimationTimeline();
    pendingAnimationTimelines.set(owner, timeline);
  }
  return timeline;
}

// The animations a surface must adopt as it claims `node`, or null.
export function takePendingAnimations(node) {
  const detached = detachedAnimationTimelines.get(node);
  const detachedAnimations = detached?._takeAnimationsFor(node) ?? null;
  detachedAnimationTimelines.delete(node);
  const timeline = pendingAnimationTimelines.get(node.ownerDocument ?? node);
  const pending = timeline?._takeAnimationsFor(node) ?? null;
  if (detachedAnimations === null) return pending;
  if (pending === null) return detachedAnimations.sort((first, second) => first._sequence - second._sequence);
  return [...pending, ...detachedAnimations].sort((first, second) => first._sequence - second._sequence);
}
