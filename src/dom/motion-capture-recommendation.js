// Motion capture recommendation. The core decides
// (output-motion.watpart): it classifies the motion facts, proves a shared
// period or a finite bound, and plans the samples. Its recurrence proof and
// sample schedule run in the motion-capture module; this binding performs
// each operation that the core requests and builds the record from the
// core's decision.

import * as motionCaptureBinary from "../wasm/motion-capture-binary.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant, moduleLayoutConstants } from "../wasm/layout-table.js";

const instantiateMotionCapture = motionCaptureBinary.instantiate;

// The facts, request and result records of output-motion.watpart, by WAT
// name without the MOTION_ prefix.
const MOTION = Object.freeze(Object.fromEntries([
  "FACTS_COUNT", "FACTS_DURATION", "FACTS_INSPECTED", "FACTS_EFFECTS",
  "EFFECT_SIZE", "EFFECT_FLAGS", "EFFECT_PLAYBACK_RATE", "EFFECT_ORDER", "EFFECT_ITERATION_COUNT", "EFFECT_DURATION",
  "EFFECT_ITERATION_INDEX", "EFFECT_ITERATION_PROGRESS", "EFFECT_START_TIME", "EFFECT_DELAY", "EFFECT_TEXTS",
  "EFFECT_PROPERTY_COUNT", "EFFECT_PROPERTY_NAMES", "EFFECT_KEYFRAME_COUNT", "EFFECT_KEYFRAMES", "EFFECT_OFFSET_COUNT",
  "EFFECT_OFFSETS",
  "FLAG_OUTPUT_FALSE", "FLAG_OUTPUT_NULL", "FLAG_MEMBERSHIP_TRUE", "FLAG_MEMBERSHIP_FALSE", "FLAG_MEMBERSHIP_TRUTHY",
  "FLAG_UNDERLYING_FALSE", "FLAG_UNDERLYING_TRUE",
  "TEXT_SIZE", "TEXT_OFFSET", "TEXT_LENGTH", "KEYFRAME_OFFSET", "KEYFRAME_SIGNATURES",
  "SIGNATURE_SIZE", "SIGNATURE_OFFSET", "SIGNATURE_LENGTH", "SIGNATURE_PRESENT",
  "REQUEST_A", "REQUEST_B", "REQUEST_ARGUMENTS",
  "RESULT_KIND", "RESULT_CONFIDENCE", "RESULT_REASON", "RESULT_SHAPE", "RESULT_REASON_EFFECT",
  "RESULT_CONDITION_KIND", "RESULT_CONDITION_VALUE", "RESULT_RETURNS", "RESULT_DURATION", "RESULT_PERIOD",
  "RESULT_NUMERATOR", "RESULT_DENOMINATOR", "RESULT_SAMPLING", "RESULT_REQUIRED_SAMPLE_COUNT", "RESULT_FRAME_BUDGET",
  "RESULT_MANDATORY_COUNT", "RESULT_RECOMMENDED_COUNT", "RESULT_CONTRIBUTING_COUNT", "RESULT_PREFERRED_FRAME_RATE",
  "RESULT_MAXIMUM_FRAME_RATE", "RESULT_MAXIMUM_FRAME_COUNT", "RESULT_MAXIMUM_PERIOD", "RESULT_TIMES",
].map((name) => [name, layoutConstant(`MOTION_${name}`)])));
const MOTION_DECIDED = layoutConstant("MOTION_DECIDED");
// The motion-capture operations the core requests, by WAT name without
// the MOTION_OPERATION_ prefix.
const OPERATION = Object.freeze(Object.fromEntries([
  "RECURRENCE_PREPARE", "RECURRENCE_ADD", "RECURRENCE_PERIOD", "MOTION_ADD", "SCHEDULE_PREPARE", "SCHEDULE_ADD_EFFECT",
  "SCHEDULE_ADD_KEYFRAME", "SCHEDULE_TIMES", "SCHEDULE_BUDGET", "SCHEDULE_FINALIZE",
].map((name) => [name, layoutConstant(`MOTION_OPERATION_${name}`)])));
// The decision's reason shapes, condition kinds, returns and sampling text
// (output-motion.watpart), and the effect flag of the motion-capture module.
const DECISION = Object.freeze(Object.fromEntries([
  "SHAPE_CODE", "SHAPE_EFFECT_OR_NULL", "SHAPE_MAXIMUM_PERIOD", "SHAPE_CONTRIBUTING", "SHAPE_CONDITION",
  "CONDITION_TEXT", "CONDITION_TIMELINE", "CONDITION_DIRECTION", "CONDITION_PHASE", "CONDITION_NUMBER",
  "CONDITION_CLASSIFICATION", "RETURNS_TRUE", "RETURNS_NULL", "TEXT_SAMPLING_STRATEGY",
].map((name) => [name, layoutConstant(`MOTION_${name}`)])));
const MOTION_EFFECT_PROGRESSING = moduleLayoutConstants(motionCaptureBinary, "motion capture")("MOTION_EFFECT_PROGRESSING");
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const TEXT_FIELDS = ["playState", "timeline", "direction", "phase", "kind", "fill"];

const numberOrNaN = (value) => typeof value === "number" ? value : NaN;
const text = (value) => typeof value === "string" ? value : "";

// The facts in the core's layout, with offsets relative to the start.
function encodeFacts(effects, finiteDuration, inspectedAt) {
  const encoder = new TextEncoder();
  const tail = [];
  let tailLength = 0;
  const base = MOTION.FACTS_EFFECTS + effects.length * MOTION.EFFECT_SIZE;
  const append = (bytes) => {
    const offset = base + tailLength;
    tail.push(bytes);
    tailLength += bytes.byteLength;
    return offset;
  };
  const appendText = (value) => {
    const bytes = encoder.encode(value);
    return [append(bytes), bytes.byteLength];
  };
  const head = new DataView(new ArrayBuffer(base));
  head.setUint32(MOTION.FACTS_COUNT, effects.length, true);
  head.setFloat64(MOTION.FACTS_DURATION, Number(finiteDuration), true);
  head.setFloat64(MOTION.FACTS_INSPECTED, Number(inspectedAt), true);
  effects.forEach((effect, index) => {
    const row = MOTION.FACTS_EFFECTS + index * MOTION.EFFECT_SIZE;
    head.setUint32(row + MOTION.EFFECT_FLAGS,
      (effect.changesRenderedOutput === false ? MOTION.FLAG_OUTPUT_FALSE : 0) |
      (effect.changesRenderedOutput === null ? MOTION.FLAG_OUTPUT_NULL : 0) |
      (effect.effectMembershipAtInspection === true ? MOTION.FLAG_MEMBERSHIP_TRUE : 0) |
      (effect.effectMembershipAtInspection === false ? MOTION.FLAG_MEMBERSHIP_FALSE : 0) |
      (effect.effectMembershipAtInspection ? MOTION.FLAG_MEMBERSHIP_TRUTHY : 0) |
      (effect.changesUnderlyingState === false ? MOTION.FLAG_UNDERLYING_FALSE : 0) |
      (effect.changesUnderlyingState === true ? MOTION.FLAG_UNDERLYING_TRUE : 0), true);
    head.setFloat64(row + MOTION.EFFECT_PLAYBACK_RATE, Number(effect.playbackRate), true);
    head.setFloat64(row + MOTION.EFFECT_ORDER, numberOrNaN(effect.effectOrder), true);
    head.setFloat64(row + MOTION.EFFECT_ITERATION_COUNT, Number(effect.iterationCount), true);
    head.setFloat64(row + MOTION.EFFECT_DURATION, Number(effect.durationMilliseconds), true);
    head.setFloat64(row + MOTION.EFFECT_ITERATION_INDEX, numberOrNaN(effect.iterationIndex), true);
    head.setFloat64(row + MOTION.EFFECT_ITERATION_PROGRESS, numberOrNaN(effect.iterationProgress), true);
    head.setFloat64(row + MOTION.EFFECT_START_TIME, Number(effect.startTimeMilliseconds), true);
    head.setFloat64(row + MOTION.EFFECT_DELAY, Number(effect.delayMilliseconds), true);
    // A text is an (offset, length) pair; the effect holds one per field.
    const writeText = (view, at, value) => {
      const [offset, length] = appendText(value);
      view.setUint32(at + MOTION.TEXT_OFFSET, offset, true);
      view.setUint32(at + MOTION.TEXT_LENGTH, length, true);
    };
    TEXT_FIELDS.forEach((field, fieldIndex) =>
      writeText(head, row + MOTION.EFFECT_TEXTS + fieldIndex * MOTION.TEXT_SIZE, text(effect[field])));
    const propertyNames = effect.propertyNames ?? [];
    const names = new DataView(new ArrayBuffer(propertyNames.length * MOTION.TEXT_SIZE));
    propertyNames.forEach((name, nameIndex) => writeText(names, nameIndex * MOTION.TEXT_SIZE, text(name)));
    head.setUint32(row + MOTION.EFFECT_PROPERTY_COUNT, propertyNames.length, true);
    head.setUint32(row + MOTION.EFFECT_PROPERTY_NAMES, append(new Uint8Array(names.buffer)), true);
    const keyframes = effect.keyframes ?? [];
    const keyframeBytes = MOTION.KEYFRAME_SIGNATURES + propertyNames.length * MOTION.SIGNATURE_SIZE;
    const keyframeView = new DataView(new ArrayBuffer(keyframes.length * keyframeBytes));
    keyframes.forEach((keyframe, keyframeIndex) => {
      const at = keyframeIndex * keyframeBytes;
      keyframeView.setFloat64(at + MOTION.KEYFRAME_OFFSET, numberOrNaN(keyframe.offset), true);
      propertyNames.forEach((name, nameIndex) => {
        const signature = keyframe.valueSignatures?.[name];
        const [offset, length] = appendText(signature === undefined ? "" : String(signature));
        const entry = at + MOTION.KEYFRAME_SIGNATURES + nameIndex * MOTION.SIGNATURE_SIZE;
        keyframeView.setUint32(entry + MOTION.SIGNATURE_OFFSET, offset, true);
        keyframeView.setUint32(entry + MOTION.SIGNATURE_LENGTH, length, true);
        keyframeView.setUint32(entry + MOTION.SIGNATURE_PRESENT, signature === undefined ? 0 : 1, true);
      });
    });
    head.setUint32(row + MOTION.EFFECT_KEYFRAME_COUNT, keyframes.length, true);
    head.setUint32(row + MOTION.EFFECT_KEYFRAMES, append(new Uint8Array(keyframeView.buffer)), true);
    const offsets = effect.keyframeOffsets ?? [];
    head.setUint32(row + MOTION.EFFECT_OFFSET_COUNT, offsets.length, true);
    head.setUint32(row + MOTION.EFFECT_OFFSETS, append(new Uint8Array(new Float64Array(offsets.map(Number)).buffer)), true);
  });
  const bytes = new Uint8Array(base + tailLength);
  bytes.set(new Uint8Array(head.buffer), 0);
  let cursor = base;
  for (const chunk of tail) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return bytes;
}

// Performs the motion-capture operation that the core requests and answers
// it.
function performRequest(session, code, motion) {
  const output = core.exports.abi_output_pointer();
  const view = new DataView(core.refreshBytes().buffer);
  const a = view.getInt32(output + MOTION.REQUEST_A, true);
  const b = view.getInt32(output + MOTION.REQUEST_B, true);
  const integer = (index) => view.getBigInt64(output + MOTION.REQUEST_ARGUMENTS + index * F64, true);
  const number = (index) => view.getFloat64(output + MOTION.REQUEST_ARGUMENTS + index * F64, true);
  let value = 0;
  let numerator = 0n;
  let denominator = 0n;
  let times = [];
  if (code === OPERATION.RECURRENCE_PREPARE) value = motion.recurrence_prepare(integer(0));
  else if (code === OPERATION.RECURRENCE_ADD) value = motion.recurrence_add_effect_period(...[0, 1, 2, 3, 4].map(integer));
  else if (code === OPERATION.RECURRENCE_PERIOD) {
    numerator = motion.recurrence_period_numerator();
    denominator = motion.recurrence_period_denominator();
  } else if (code === OPERATION.MOTION_ADD) {
    if (a) motion.motion_reset();
    value = motion.motion_add_effect(MOTION_EFFECT_PROGRESSING, ...[0, 1, 2, 3, 4].map(number));
  } else if (code === OPERATION.SCHEDULE_PREPARE) value = motion.schedule_prepare(number(0), number(1), a);
  else if (code === OPERATION.SCHEDULE_ADD_EFFECT) value = motion.schedule_add_effect(a);
  else if (code === OPERATION.SCHEDULE_ADD_KEYFRAME) value = motion.schedule_add_keyframe(a, number(0), b);
  else if (code === OPERATION.SCHEDULE_TIMES) {
    times = Array.from({ length: motion.schedule_count() }, (_, index) => motion.schedule_time(index));
  } else if (code === OPERATION.SCHEDULE_BUDGET) value = motion.schedule_set_frame_budget(a);
  else if (code === OPERATION.SCHEDULE_FINALIZE) value = motion.schedule_finalize();
  else throw new Error(`The motion capture recommendation requested unknown operation ${code}`);
  const [timesPointer] = core.byteInput(new Uint8Array(new Float64Array(times).buffer));
  core.status("output_motion_session_answer", session, value, motion.motion_error(), numerator, denominator,
    timesPointer, times.length);
}

function motionText(id) {
  core.status("output_motion_text", id);
  return core.outputString();
}

function freezeRecommendation(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeRecommendation(entry)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          freezeRecommendation(entry),
        ]),
      ),
    );
  }
  return value;
}

export function recommendMotionCapture(motionInspection, options = {}) {
  const effects = Array.isArray(motionInspection?.effects) ? motionInspection.effects : [];
  const optionValues = [options.preferredFrameRate, options.maximumFrameRate, options.maximumFrameCount,
    options.maximumPeriodMilliseconds];
  const [kindPointer, kindLength] = core.input(text(motionInspection?.kind));
  const facts = encodeFacts(effects, motionInspection?.finiteDurationMilliseconds,
    motionInspection?.inspectedAtMilliseconds);
  const [factsPointer] = core.byteInput(facts);
  const session = core.statusRaw("output_motion_session_create", kindPointer, kindLength,
    numberOrNaN(motionInspection?.version), Array.isArray(motionInspection?.effects) ? 1 : 0,
    optionValues.reduce((present, value, index) => present | (value == null ? 0 : 1 << index), 0),
    ...optionValues.map((value) => value == null ? NaN : Number(value)), factsPointer, facts.byteLength);
  try {
    let motion = null;
    let request;
    while ((request = core.status("output_motion_session_next", session)) !== MOTION_DECIDED) {
      motion ??= instantiateMotionCapture({}).exports;
      performRequest(session, request, motion);
    }
    core.status("output_motion_session_result", session);
    const output = core.exports.abi_output_pointer();
    const view = new DataView(core.refreshBytes().buffer);
    const word = (field) => view.getUint32(output + field, true);
    const float = (field) => view.getFloat64(output + field, true);
    const kind = word(MOTION.RESULT_KIND);
    const confidence = word(MOTION.RESULT_CONFIDENCE);
    const reasonCode = word(MOTION.RESULT_REASON);
    const shape = word(MOTION.RESULT_SHAPE);
    const reasonEffect = effects[view.getInt32(output + MOTION.RESULT_REASON_EFFECT, true)];
    const conditionKind = word(MOTION.RESULT_CONDITION_KIND);
    const conditionValue = view.getInt32(output + MOTION.RESULT_CONDITION_VALUE, true);
    const returns = word(MOTION.RESULT_RETURNS);
    const duration = float(MOTION.RESULT_DURATION);
    const period = float(MOTION.RESULT_PERIOD);
    const numerator = view.getBigInt64(output + MOTION.RESULT_NUMERATOR, true);
    const denominator = view.getBigInt64(output + MOTION.RESULT_DENOMINATOR, true);
    const sampled = word(MOTION.RESULT_SAMPLING);
    const requiredSampleCount = word(MOTION.RESULT_REQUIRED_SAMPLE_COUNT);
    const recommendedFrameBudget = word(MOTION.RESULT_FRAME_BUDGET);
    const mandatoryCount = word(MOTION.RESULT_MANDATORY_COUNT);
    const recommendedCount = word(MOTION.RESULT_RECOMMENDED_COUNT);
    const contributingCount = word(MOTION.RESULT_CONTRIBUTING_COUNT);
    const preferredFrameRate = float(MOTION.RESULT_PREFERRED_FRAME_RATE);
    const maximumFrameRate = float(MOTION.RESULT_MAXIMUM_FRAME_RATE);
    const maximumFrameCount = float(MOTION.RESULT_MAXIMUM_FRAME_COUNT);
    const maximumPeriodMilliseconds = float(MOTION.RESULT_MAXIMUM_PERIOD);
    let cursor = output + MOTION.RESULT_TIMES;
    const readTimes = (count) => Array.from({ length: count }, (_, index) => view.getFloat64(cursor + index * F64, true));
    const mandatorySampleTimesMilliseconds = readTimes(mandatoryCount);
    cursor += mandatoryCount * F64;
    const recommendedSampleTimesMilliseconds = readTimes(recommendedCount);
    cursor += recommendedCount * F64;
    const contributing = Array.from({ length: contributingCount }, (_, index) =>
      effects[view.getUint32(cursor + index * U32, true)]);
    const conditions = new Map([
      [DECISION.CONDITION_TEXT, () => motionText(conditionValue)],
      [DECISION.CONDITION_TIMELINE, () => reasonEffect.timeline],
      [DECISION.CONDITION_DIRECTION, () => reasonEffect.direction ?? null],
      [DECISION.CONDITION_PHASE, () => reasonEffect.phase ?? "unknown"],
      [DECISION.CONDITION_NUMBER, () => conditionValue],
      [DECISION.CONDITION_CLASSIFICATION, () => motionInspection.classification],
    ]);
    const condition = () => conditions.get(conditionKind)();
    const code = motionText(reasonCode);
    const reason = shape === DECISION.SHAPE_CODE
      ? { code }
      : shape === DECISION.SHAPE_CONTRIBUTING
      ? { code, contributingEffectOrders: contributing.map((effect) => effect.effectOrder) }
      : shape === DECISION.SHAPE_CONDITION
      ? { code, effectOrder: null, animationName: null, condition: condition() }
      : {
        code,
        effectOrder: shape === DECISION.SHAPE_EFFECT_OR_NULL ? reasonEffect.effectOrder ?? null : reasonEffect.effectOrder,
        animationName: reasonEffect.animationName || null,
        condition: condition(),
        ...(shape === DECISION.SHAPE_MAXIMUM_PERIOD ? { maximumPeriodMilliseconds } : {}),
      };
    return freezeRecommendation({
      version: 1,
      kind: motionText(kind),
      durationMilliseconds: Number.isNaN(duration) ? null : duration,
      periodMilliseconds: Number.isNaN(period) ? null : period,
      periodRational: denominator === 0n ? null : {
        numerator: numerator.toString(),
        denominator: denominator.toString(),
      },
      returnsToInitialState: returns === DECISION.RETURNS_NULL ? null : returns === DECISION.RETURNS_TRUE,
      confidence: motionText(confidence),
      reason,
      sampling: sampled === 0 ? null : {
        strategy: motionText(DECISION.TEXT_SAMPLING_STRATEGY),
        preferredFrameRate,
        maximumFrameRate,
        maximumFrameCount,
        requiredSampleCount,
        recommendedFrameBudget,
        mandatorySampleTimesMilliseconds,
        recommendedSampleTimesMilliseconds,
      },
    });
  } finally {
    core.status("output_motion_session_release", session);
  }
}
