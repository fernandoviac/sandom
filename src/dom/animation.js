import {
  addImplicitKeyframes,
  animationKeyframeContext,
  canonicalizeAnimationKeyframes,
  recordUnanimatedProperty,
  resolvedElementFields,
} from "./style.js";
import { parseCSSEasing, serializeAnimationEasing } from "../dom-wasm/easing.js";
import {
  animationComputedTiming,
  animationProperty,
  deferAnimationBinding,
  arrangeKeyframes,
  keyframeValueText,
  normalizeAnimationOffsets,
} from "../dom-wasm/animation.js";
import { addEventListener, dispatchEvent, removeEventListener } from "./events.js";
import {
  installAnimationBindings,
  installCSSAnimationBindings,
  installCSSTransitionBindings,
  createAnimationEffectBindings,
} from "./dom-bindings.generated.js";

const MEASUREMENT = Symbol.for("sandom.domCore.measurement");
const animationFinalizer = new FinalizationRegistry(({ core, handle, keyframes }) => {
  core.status("animation_release", handle);
  core.status("animation_keyframes_release", keyframes);
});

// A single NUL prefix tags a non-JSON number; doubling authored NUL prefixes
// makes the transport reversible without reserving any authored object keys.
function encodeCanonicalNumber(_key, value) {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return `\0${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  return typeof value === "string" && value.startsWith("\0") ? `\0${value}` : value;
}
function decodeCanonicalNumber(_key, value) {
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

// The script-visible Animation interface (Web Animations 1, section 6.4).
export class Animation {
  constructor(surface, element, keyframes, timing, engineDeclarationOptions = {}) {
    this._surface = surface;
    this._element = element;
    this._core = element._domCore;
    this._sequence = nextAnimationSequence++;
    // A pending animation holds at its current time until a frame of its
    // surface resolves its start time: one created between frames, and one
    // created before any surface claimed the element (a
    // PendingAnimationTimeline is not a timeline). `ready` settles then.
    // Its current time is the one at the time of its timeline when it
    // became pending.
    this._timelinePending = engineDeclarationOptions.timelinePending === true;
    this._pendingSince = surface.currentTime;
    this._resetReadyPromise();
    this._processedKeyframes = processKeyframes(keyframes);
    // The engine's keyframes: computed values of the element, with the
    // implicit keyframes of the underlying values. A CSS animation's
    // implicit keyframe takes its timing function and replaces the
    // underlying value; a script animation's is linear.
    const context = animationKeyframeContext(element);
    let canonicalKeyframes;
    try {
      canonicalKeyframes = addImplicitKeyframes(
        canonicalizeAnimationKeyframes(this._processedKeyframes.map(engineKeyframe),
          (property) => recordUnanimatedProperty(element, property, "keyframes"), context),
        context,
        engineDeclarationOptions.implicitKeyframe ?? {},
      );
    } finally {
      context.release();
    }
    this._timing = typeof timing === "number" ? { duration: timing } : { ...timing };
    this._timelineOption = this._timing.timeline;
    this._rangeStartOption = this._timing.rangeStart;
    this._rangeEndOption = this._timing.rangeEnd;
    delete this._timing.timeline;
    delete this._timing.rangeStart;
    delete this._timing.rangeEnd;
    this._engineDeclarationOptions = engineDeclarationOptions;
    // getTiming() reports the authored duration and fill; "auto" stands for
    // an absent member.
    this._authoredDuration = this._timing.duration ?? "auto";
    this._authoredFill = this._timing.fill ?? "auto";
    this._timing.duration = this._authoredDuration === "auto" ? 0 : Number(this._authoredDuration);
    this._timing.delay = Number(this._timing.delay ?? 0);
    this._timing.iterations = this._timing.iterations ?? 1;
    const scroll = this._isScrollDriven();
    const defaults = this._core.status("animation_timing_defaults", this._timing.duration, scroll ? 1 : 0);
    const defaultView = new DataView(this._core.refreshBytes().buffer);
    this._timing.duration = defaultView.getFloat64(defaults, true);
    const defaultFill = defaultView.getUint32(defaults + 8, true);
    const measurement = globalThis[MEASUREMENT];
    if (measurement) measurement.record({
      category: "animation", operation: "animation.timing-defaults",
      direction: "core-to-host", bytes: 12, allocations: 1,
    });
    if (defaultFill && this._timing.fill === undefined) {
      this._timing.fill = this._core.string("animation_enumeration_name", 1, defaultFill);
    }
    const startTime = Number(this._timing.startTime ?? engineDeclarationOptions.startTime ?? surface.currentTime);
    try {
      this._animationId = this._core.statusRaw("animation_create", element._coreHandle,
        this._timing.duration, this._timing.delay, Number(this._timing.iterations), startTime, scroll ? 1 : 0);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new error.constructor(`The animation timing (duration ${this._timing.duration}, delay ${this._timing.delay}, ` +
        `iterations ${this._timing.iterations}, start time ${startTime}): ${error.message}`, { cause: error });
    }
    try {
      this._keyframesHandle = this._core.handle("animation_keyframes_create",
        ...this._core.input(JSON.stringify(canonicalKeyframes, encodeCanonicalNumber)));
      this._resetFinishedPromise();
      this.effect = Object.freeze(createAnimationEffectBindings({
        reportKeyframes: () => this._reportedKeyframes(),
        reportTiming: () => this._effectTiming(),
        readTarget: () => this._element,
        readComposite: () => this._timing.composite ?? "replace",
        computeTiming: () => this._computedTiming(),
      }));
      this._replaceEngineHandle();
    } catch (error) {
      if (this._keyframesHandle) this._core.status("animation_keyframes_release", this._keyframesHandle);
      this._core.status("animation_release", this._animationId);
      throw error;
    }
    animationFinalizer.register(this, {
      core: this._core, handle: this._animationId, keyframes: this._keyframesHandle,
    });
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
      endDelay: Number(timing.endDelay ?? 0),
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
    this._promiseGeneration = this._value(4);
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
  get replaceState() { return this._core.string("animation_enumeration_name", 2, this._value(13)); }
  persist() { this._control(12); }
  // An animation is the event target of its playback events (remove).
  get onremove() { return this._onremove ?? null; }
  set onremove(callback) {
    if (this._onremove) this.removeEventListener("remove", this._onremove);
    this._onremove = typeof callback === "function" ? callback : null;
    if (this._onremove) this.addEventListener("remove", this._onremove);
  }
  addEventListener(type, callback, options) { addEventListener(this, type, callback, options); }
  removeEventListener(type, callback, options) { removeEventListener(this, type, callback, options); }
  dispatchEvent(event) { return dispatchEvent(this, event); }
  // The bits of the animation property ids that the effect targets.
  get _targetProperties() {
    if (this._targetPropertyBits === undefined) {
      let bits = 0n;
      for (const keyframe of this._canonicalKeyframes) {
        for (const name of Object.keys(keyframe)) {
          if (name === "offset" || name === "easing" || name === "composite") continue;
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
  // effect stack composed through this animation's track at `now`; null
  // when no renderer lays out the target.
  _committedValues(now) {
    const surface = this._surface;
    const renderer = surface._persistentRenderer;
    if (!renderer || surface._shutdown || surface._indexOfElement?.get(this._element) === undefined) return null;
    return this._engineHandle.trackIndices.map((track) => renderer.sampleAnimationThrough(track, now));
  }
  // Web Animations 1, section 6.4: the animation's value of each target
  // property goes into the target's inline style.
  commitStyles() {
    const values = this._value(13) === 1 ? this._removedValues : this._committedValues(this._surface.currentTime);
    if (values === null) {
      throw new DOMException("commitStyles() needs a rendered target element", "InvalidStateError");
    }
    for (const { propertyName, value } of values) {
      this._element.style.setProperty(propertyName, keyframeValueText(value, propertyName));
    }
  }
  _replaceEngineHandle() {
    if (this._timelinePending || this._value(13) === 1) {
      this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
      return;
    }
    const reversed = this._value(9) ? 1 : 0;
    const direction = this._core.string("animation_track_direction",
      ...this._core.input(String(this._timing.direction ?? "normal")), reversed) || undefined;
    this._engineHandle = this._surface._declareAnimation(this._element, this._canonicalKeyframes, {
      ...this._timing,
      direction,
      easing: typeof this._timing.easing === "string" ? parseCSSEasing(this._timing.easing) : this._timing.easing,
      duration: this._value(7), delay: this._value(8), startTime: this._value(6),
    }, { ...this._engineDeclarationOptions, animationId: this._animationId, trackGeneration: this._value(5) });
  }
  _applyActions(actions) {
    if (actions & 512) this._resetFinishedPromise();
    if (actions & 1024) {
      const generation = this._value(12);
      this._surface._animationCancelingThroughEngine = this;
      try { this._engineHandle.cancel(); }
      finally { this._surface._animationCancelingThroughEngine = null; }
      this._applyActions(this._core.statusRaw("animation_control", this._animationId, 10, generation, this._surface.currentTime));
    }
    if (actions & 1) this._engineHandle.cancelSilently();
    if (actions & 16) this._rejoinHost();
    if (actions & 2) this._replaceEngineHandle();
    if (actions & 4) this._engineHandle.pause(this._surface.currentTime);
    if (actions & 8) this._engineHandle.resume(this._surface.currentTime);
    if (actions & 2048) this._engineHandle.seek(this._value(11), this._surface.currentTime);
    if (actions & 32) this._leaveHost();
    if (actions & 64) {
      this._rejectFinished(new DOMException("Animation canceled", "AbortError"));
      // Cancelling a pending animation rejects its ready promise; an idle
      // animation's ready promise is a resolved one (Web Animations 1,
      // section 4.4.14).
      if (this._timelinePending) {
        this._timelinePending = false;
        this._rejectReady(new DOMException("Animation canceled", "AbortError"));
        this._ready = Promise.resolve(this);
      }
    }
    if (actions & 128) this._resolveFinished(this);
    if (actions & 256) this._surface._scheduleAnimationFrame(this._element);
    return actions !== 0;
  }
  _control(operation, value = 0) {
    let actions;
    try {
      actions = this._core.statusRaw("animation_control", this._animationId, operation, value, this._surface.currentTime);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new error.constructor(`Animation control operation ${operation} with value ${value}: ${error.message}`, { cause: error });
    }
    return this._applyActions(actions);
  }
  _leaveHost() { this._surface._removeAnimation(this); }
  _rejoinHost() { this._surface._restoreAnimation(this); }
  // Whether an engine event with this animation id is one of this
  // animation's tracks.
  _ownsEngineAnimationId(animationId) { return animationId === this._animationId; }
  // The surface that adopted this animation has reached a frame, so its
  // timeline finally has a time. The animation held at the current time it
  // reached while pending (0 unless the host seeked or paused it), so
  // replaying that time against the live clock starts it at exactly that
  // sample and declares the engine track the pending binding stood in for.
  _resolveTimeline() {
    this._timelinePending = false;
    this._resolveReady(this);
    const state = this._value(3);
    if (state === 0) return;
    const held = this._core.status("animation_value", this._animationId, 0, this._pendingSince);
    this._control(1, Number.isNaN(held) ? 0 : held);
    if (state === 3) this._control(7);
  }
  // The surface shut down. Chrome keeps a script animation whose element
  // has no timeline (an element of a detached document) at its current
  // time, pending: the animation moves to its document's pending timeline,
  // where the next surface that claims its element adopts it.
  _moveToPendingTimeline() {
    const state = this._value(3);
    const time = this._value(0);
    this._engineHandle.cancelSilently();
    const timeline = elementAnimationHost(this._element, null);
    this._surface = timeline;
    this._pendingSince = timeline.currentTime;
    timeline._adoptAnimation(this);
    this._engineHandle = deferAnimationBinding(declareWithoutRenderer).handle;
    if (state !== 1 && state !== 2) return;
    this._timelinePending = true;
    this._resetReadyPromise();
    // A scroll-driven animation's time is unresolved without its scroller.
    if (!Number.isNaN(time)) this._control(1, time);
  }
  _resetReadyPromise() {
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // As with `finished`, an unobserved rejection is not a host failure.
    this._ready.catch(() => {});
  }
  _timelineValue() {
    return this._timelineOption ?? resolvedElementFields(this._element).animationTimeline?.[0] ?? "auto";
  }
  _timelineRangeStart() {
    return this._rangeStartOption ?? resolvedElementFields(this._element).animationRangeStart?.[0] ?? "normal";
  }
  _timelineRangeEnd() {
    return this._rangeEndOption ?? resolvedElementFields(this._element).animationRangeEnd?.[0] ?? "normal";
  }
  _isScrollDriven() {
    return this._core.exports.animation_timeline_scroll_driven(...this._core.input(String(this._timelineValue()))) !== 0;
  }
  _sampleScrollTimeline(progress) { return this._control(9, progress === null ? NaN : progress); }
  _needsFrame() { return this._value(10) !== 0; }
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
installAnimationBindings({
  readTime(animation, field) {
    // Field 1 is the start time. Without a timeline there is no time to
    // report one in, so a pending animation reports it unresolved, as a
    // play-pending animation does in Chrome.
    if (field === 1 && animation._timelinePending) return null;
    const value = animation._value(field);
    return Number.isNaN(value) ? null : value;
  },
  readState(animation) { return animation._core.string("animation_enumeration_name", 0, animation._value(3)); },
  // An animation is pending until the frame that resolves its start time.
  readPending(animation) { return animation._timelinePending && animation._value(3) !== 0; },
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

// A CSS animation: the animation a keyframes rule names in an element's
// animation-name list (css-animations-2 §4.1).
export class CSSAnimation extends Animation {
  constructor(surface, element, keyframes, timing, engineDeclarationOptions) {
    super(surface, element, keyframes, timing, engineDeclarationOptions);
    this._cssAnimationName = engineDeclarationOptions.diagnosticAnimationName;
  }
  // A CSS animation reports its keyframes with computed values
  // (css-animations-2 section 4.1): the core's canonical values.
  _reportedKeyframes() {
    return this._canonicalKeyframes.map(({ offset, easing, composite = "auto", ...values }) => {
      const frame = { offset, easing: easingText(easing), composite };
      for (const [propertyName, value] of Object.entries(values)) {
        frame[idlName(propertyName)] = keyframeValueText(value, propertyName);
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
// (_adoptDeclaredTrack).
export class CSSTransition extends Animation {
  constructor(surface, element, propertyName, record, generation) {
    const transitionTrack = {
      propertyName,
      easing: record.easing,
      keyframes: [
        { offset: 0, value: record.trackStartValue },
        { offset: 1, value: record.endValue },
      ],
    };
    super(surface, element, [], {
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
    // The frame that declares a transition starts it.
    if (!this._timelinePending) this._resolveReady(this);
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
    // The core holds the iteration duration; field 7 is it over the rate.
    if (record.duration !== this._value(7)) {
      this._core.statusRaw("animation_control", this._animationId, 11,
        record.duration * (Math.abs(this._value(2)) || 1), this._surface.currentTime);
    }
    const binding = this._declarationBinding;
    this._declarationBinding = null;
    this._engineHandle = record.engineHandle;
    binding.bind(null, 0);
  }
  // A transition's keyframes are its start and end values; its timing
  // function is the effect's easing.
  _reportedKeyframes() {
    const record = this._transitionRecord;
    return [record.trackStartValue, record.endValue].map((value, index) => ({
      offset: index, easing: "linear", composite: "auto",
      [idlName(this._transitionProperty)]: keyframeValueText(value, this._transitionProperty),
      computedOffset: index,
    }));
  }
  _timelineValue() { return "auto"; }
  // Whether the transition's track still moves on the clock: running at a
  // nonzero rate, or finished and awaiting the tick that ends its track.
  _trackAdvances() { return this._needsFrame() || this._value(3) === 3; }
  _ownsEngineAnimationId(animationId) {
    return animationId === this._animationId || animationId === this._trackAnimationId;
  }
  // The renderer's own track serves the first declaration; a change of
  // time, rate or direction declares the transition's track again. Until
  // the frame declares a pending transition's track, a deferred binding
  // queues the commands for it.
  _replaceEngineHandle() {
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
      this._element, transitionTrack.propertyName, transitionTrack.keyframes, {
        duration: this._value(7), delay: this._value(8), startTime: this._value(6),
        easing: transitionTrack.easing, direction: this._value(9) ? "reverse" : "normal",
      }, { animationId: this._animationId, trackGeneration: this._value(5) },
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
    const state = this._value(3);
    if (!this._awaitingDeclaration && (state === 1 || state === 2)) this._surface._registerTransitionAnimation(this);
    const record = this._transitionRecord;
    record.startTimeMilliseconds = this._value(6);
    record.duration = this._value(7);
    record.delay = this._value(8);
    // A track declared, resumed or seeked now runs from the next tick.
    if (actions & (2 | 8 | 2048)) record.trackAwaitsTick = true;
    return applied;
  }
  // The engine replaced this transition's track before the registry saw
  // its cancel: settle the record as cancelled without touching a track.
  _settleReplaced() {
    this._core.statusRaw("animation_control", this._animationId, 6, 0, this._surface.currentTime);
    this._applyActions(this._core.statusRaw("animation_control", this._animationId, 10, this._value(12), this._surface.currentTime));
  }
}
installCSSTransitionBindings({}, CSSTransition.prototype);

export function createDOMAnimation(surface, element, keyframes, timing, engineDeclarationOptions = {}) {
  return engineDeclarationOptions.diagnosticAnimationName == null
    ? new Animation(surface, element, keyframes, timing, engineDeclarationOptions)
    : new CSSAnimation(surface, element, keyframes, timing, engineDeclarationOptions);
}

function compositeClass(animation) {
  return animation instanceof CSSTransition ? 0 : animation instanceof CSSAnimation ? 1 : 2;
}
// Web Animations composite order as Chrome orders getAnimations()
// (animation_composite_order).
function sortInCompositeOrder(animations) {
  if (animations.length < 2) return animations;
  const native = animations[0]._element._domCore;
  const properties = animations.map((animation) => native.input(String(animation._transitionProperty ?? "")));
  const rows = native.exports.abi_allocate(animations.length * 40);
  const view = new DataView(native.refreshBytes().buffer);
  for (let index = 0; index < animations.length; index++) {
    const animation = animations[index];
    const row = rows + index * 40;
    view.setBigUint64(row, BigInt(animation._element._coreHandle ?? 0n), true);
    view.setUint32(row + 8, compositeClass(animation), true);
    view.setInt32(row + 12, animation._surface._cssAnimations?.get(animation._element)
      ?.findIndex((record) => record.animation === animation) ?? -1, true);
    view.setFloat64(row + 16, Number(animation._sequence), true);
    view.setFloat64(row + 24, Number(animation._transitionGeneration), true);
    view.setUint32(row + 32, properties[index][0], true);
    view.setUint32(row + 36, properties[index][1], true);
  }
  const count = native.status("animation_composite_order", rows, animations.length);
  const output = native.exports.abi_output_pointer();
  const order = new DataView(native.refreshBytes().buffer);
  const sorted = Array.from({ length: count }, (_, index) => animations[order.getUint32(output + index * 4, true)]);
  for (let index = 0; index < count; index++) animations[index] = sorted[index];
  return animations;
}

// An animation getAnimations() reports (Web Animations §5.1, relevant
// animations): one that is not idle or removed, and once finished only
// while its fill keeps it in effect. A transition fills backwards, so its
// end leaves it out.
function reportedAnimation(animation) {
  const state = animation.playState;
  if (state === "idle" || animation._value(13) === 1) return false;
  if (state !== "finished") return true;
  const fill = animation._timing.fill;
  return fill === "both" ||
    fill === (animation.playbackRate < 0 ? "backwards" : "forwards");
}

// Removing replaced animations (Web Animations 1, section 5.5) at `now`:
// the script animations among `animations` that later script animations
// of the same target replace. The core decides which, one target at a
// time (animation_remove_replaced); their effects leave the effect stack.
// CSS animations and transitions are neither replaced nor replace others,
// and a pending animation has no time on its timeline yet. Returns the
// removed animations in composite order.
export function removeReplacedAnimations(animations, now) {
  const byTarget = new Map();
  for (const animation of animations) {
    if (animation instanceof CSSAnimation || animation instanceof CSSTransition || animation._timelinePending) continue;
    let list = byTarget.get(animation._element);
    if (list === undefined) byTarget.set(animation._element, list = []);
    list.push(animation);
  }
  const removed = [];
  for (const list of byTarget.values()) {
    // Measured in Chrome: an animation without target properties is
    // removed under a later replaceable animation, never alone.
    if (list.length < 2) continue;
    list.sort((first, second) => first._sequence - second._sequence);
    const input = new DataView(new ArrayBuffer(list.length * 32));
    for (let index = 0; index < list.length; index++) {
      const animation = list[index];
      input.setBigUint64(index * 32, animation._animationId, true);
      input.setBigUint64(index * 32 + 8, animation._targetProperties, true);
      input.setFloat64(index * 32 + 16, Number(animation._timing.endDelay ?? 0), true);
      input.setUint32(index * 32 + 24,
        animation._core.exports.animation_fill_mode(...animation._core.input(String(animation._timing.fill))), true);
    }
    const core = list[0]._core;
    const [pointer] = core.byteInput(new Uint8Array(input.buffer));
    const count = core.status("animation_remove_replaced", pointer, list.length, now);
    const output = core.exports.abi_output_pointer();
    const view = new DataView(core.refreshBytes().buffer);
    for (let index = 0; index < count; index++) removed.push(list[view.getUint32(output + index * 4, true)]);
  }
  // commitStyles() of a removed animation writes the values it had here;
  // each is sampled before any removed track leaves its stack.
  for (const animation of removed) animation._removedValues = animation._committedValues(now);
  for (const animation of removed) animation._removeFromEffectStack();
  return removed.sort((first, second) => first._sequence - second._sequence);
}

export function animationsForElement(animations, element, subtree) {
  return sortInCompositeOrder(animations.filter((animation) => {
    if (!reportedAnimation(animation)) return false;
    if (animation._element === element) return true;
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

// A pending or removed animation's engine handle is a deferred binding,
// which queues the host's commands natively; the frame that resolves a
// pending animation's start time, and persist() on a removed one, declare
// the real track from the core's own state, so this is never reached.
function declareWithoutRenderer() {
  throw new Error("a pending animation has no renderer to declare against");
}

class PendingAnimationTimeline {
  constructor() {
    this._animations = [];
    this._animationsByElement = new Map();
    // _applyActions writes this slot while cancelling through the engine.
    this._animationCancelingThroughEngine = null;
  }
  get currentTime() {
    return 0;
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
    if (!this._animations.includes(animation)) this._animations.push(animation);
  }
  // Nothing renders yet; the adopting surface schedules the first frame.
  _scheduleAnimationFrame() {}
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
  const timeline = pendingAnimationTimelines.get(node.ownerDocument ?? node);
  return timeline === undefined ? null : timeline._takeAnimationsFor(node);
}
