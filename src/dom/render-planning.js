// Render planning. The core resolves each field of the plan and records
// its decision (output-plan.watpart); this binding performs the viewport
// recommendation, the inspection and the motion recommendation between the
// core's steps, and builds the plan, warning and refusal records.

import {
  inspectPreparedInput,
  prepareRenderInput,
} from "./render-animation.js";
import { assertScrollbarStyle } from "./scrollbar-visibility.js";
import { DocumentSession } from "./document-session.js";
import { recommendMotionCapture } from "./motion-capture-recommendation.js";
import { recommendViewport } from "./viewport-recommendation.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The codes, texts and result record of output-plan.watpart, by WAT name
// without the OUTPUT_PLAN_ prefix.
const PLAN = Object.freeze(Object.fromEntries([
  "TEXT_FIELD_DURATION", "TEXT_FIELD_SAMPLING", "TEXT_FIELD_PROGRESS_SCHEDULE", "TEXT_SOURCE_BOUNDED_FALLBACK",
  "TEXT_VIEWPORT_FALLBACK_CODE", "TEXT_VIEWPORT_FALLBACK_MESSAGE", "TEXT_DURATION_FALLBACK_CODE",
  "TEXT_DURATION_FALLBACK_MESSAGE", "TEXT_REFUSAL_EXTERNAL", "TEXT_REFUSAL_INDETERMINATE", "TEXT_REFUSAL_NO_SCHEDULE",
  "TEXT_FORMATS", "TEXT_SAMPLING_STRATEGY", "FORMAT_JPEG_GAIN_MAP", "REPETITION_INFINITE", "REPETITION_CALLER",
  "REFUSAL_EXTERNAL_MOTION", "REFUSAL_NO_SCHEDULE", "WARNING_VIEWPORT", "WARNING_DURATION",
  "VIEWPORT_AUTO", "VIEWPORT_NOT_OBJECT", "VIEWPORT_OBJECT", "RECOMMENDATION_NONE_VALID",
  "RECOMMENDATION_SELECTED", "RECOMMENDATION_INVALID", "REFUSED",
  "RESULT_FORMAT", "RESULT_REPETITION", "RESULT_SAMPLING_FALLBACK", "RESULT_CONFIDENCE", "RESULT_REFUSAL",
  "RESULT_WARNINGS", "RESULT_DECISION_COUNT", "RESULT_VIEWPORT_WIDTH", "RESULT_VIEWPORT_HEIGHT",
  "RESULT_DEVICE_SCALE", "RESULT_DURATION", "RESULT_FALLBACK_SAMPLING", "RESULT_DECISIONS",
  "DECISION_SIZE", "DECISION_FIELD", "DECISION_SOURCE", "DECISION_CODE", "DECISION_MESSAGE", "DYNAMIC_TEXT",
].map((name) => [name, layoutConstant(`OUTPUT_PLAN_${name}`)])));

export const STANDARD_RENDER_VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
});
export const INDETERMINATE_MOTION_FALLBACK_DURATION_MILLISECONDS = 3000;

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreeze(entry)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, deepFreeze(entry)]),
    ));
  }
  return value;
}

export class RenderPlanningError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RenderPlanningError";
    this.details = deepFreeze(details);
  }
}

function planText(id) {
  core.status("output_plan_text", id);
  return core.outputString("output_plan_text");
}

const isAuto = (value) => value === undefined || value === "auto";
const textOf = (value) => typeof value === "string" ? value : "";
const jsonText = (value) => String(JSON.stringify(value));

// The core's plan: its fields and decisions.
function readPlan(session) {
  core.status("output_plan_result", session);
  const view = core.output("output_plan_result");
  const word = (offset) => view.getUint32(offset, true);
  const number = (offset) => view.getFloat64(offset, true);
  const plan = {
    format: word(PLAN.RESULT_FORMAT),
    repetition: word(PLAN.RESULT_REPETITION),
    samplingFallback: word(PLAN.RESULT_SAMPLING_FALLBACK) !== 0,
    confidence: word(PLAN.RESULT_CONFIDENCE),
    refusal: word(PLAN.RESULT_REFUSAL),
    warnings: word(PLAN.RESULT_WARNINGS),
    viewport: {
      width: number(PLAN.RESULT_VIEWPORT_WIDTH),
      height: number(PLAN.RESULT_VIEWPORT_HEIGHT),
      deviceScale: number(PLAN.RESULT_DEVICE_SCALE),
    },
    durationMilliseconds: number(PLAN.RESULT_DURATION),
    fallbackSampling: [0, 1, 2, 3].map((index) =>
      number(PLAN.RESULT_FALLBACK_SAMPLING + index * Float64Array.BYTES_PER_ELEMENT)),
    decisions: [],
  };
  const entries = Array.from({ length: word(PLAN.RESULT_DECISION_COUNT) }, (_, index) =>
    [PLAN.DECISION_FIELD, PLAN.DECISION_SOURCE, PLAN.DECISION_CODE, PLAN.DECISION_MESSAGE]
      .map((offset) => word(PLAN.RESULT_DECISIONS + index * PLAN.DECISION_SIZE + offset)));
  const dynamic = PLAN.DYNAMIC_TEXT >>> 0;
  const text = (id) => {
    if (id < dynamic) return planText(id);
    core.status("output_plan_dynamic_text", session, id - dynamic);
    return core.outputString("output_plan_dynamic_text");
  };
  plan.decisions = entries.map(([field, source, code, message]) => ({
    field: text(field),
    source: text(source),
    reason: { code: text(code), message: text(message) },
  }));
  return plan;
}

// Records the viewport recommendation in the session.
function submitRecommendation(session, recommendation) {
  const outcome = recommendation.classification === "none-valid"
    ? PLAN.RECOMMENDATION_NONE_VALID
    : recommendation.classification === "selected" && recommendation.viewport !== null
    ? PLAN.RECOMMENDATION_SELECTED
    : PLAN.RECOMMENDATION_INVALID;
  const reasons = outcome === PLAN.RECOMMENDATION_SELECTED ? recommendation.reasons : [];
  const encoder = new TextEncoder();
  const encoded = reasons.map((reason) => encoder.encode(String(reason)));
  const packed = new Uint8Array(Math.max(4, encoded.reduce((sum, bytes) => sum + 4 + bytes.byteLength, 0)));
  const packedView = new DataView(packed.buffer);
  let cursor = 0;
  for (const bytes of encoded) {
    packedView.setUint32(cursor, bytes.byteLength, true);
    packed.set(bytes, cursor + 4);
    cursor += 4 + bytes.byteLength;
  }
  const [confidencePointer, confidenceLength] = core.input(textOf(recommendation.confidence));
  const [reasonsPointer] = core.byteInput(packed);
  core.statusRaw("output_plan_automatic_viewport", session, outcome,
    Number(recommendation.viewport?.width), Number(recommendation.viewport?.height),
    confidencePointer, confidenceLength, reasonsPointer, encoded.length);
}

function viewportWarning(recommendation) {
  return {
    field: "viewport",
    source: "standard-viewport",
    reason: { code: planText(PLAN.TEXT_VIEWPORT_FALLBACK_CODE), message: planText(PLAN.TEXT_VIEWPORT_FALLBACK_MESSAGE) },
    evidence: {
      classification: recommendation.classification,
      recommendationReason: recommendation.reason,
      rejections: recommendation.rejections,
    },
  };
}

export function planAutomaticViewport(recommendation, deviceScale = 1) {
  const [backendPointer, backendLength] = core.input("auto");
  const session = core.statusRaw("output_plan_begin", backendPointer, backendLength, 0, 0, 1);
  try {
    const scale = Number(deviceScale);
    if (!(scale > 0)) throw new RangeError("deviceScale must be positive");
    core.statusRaw("output_plan_viewport", session, 0, scale, 0, NaN, NaN);
    submitRecommendation(session, recommendation);
    const plan = readPlan(session);
    const fallback = recommendation.classification === "none-valid";
    return deepFreeze({
      viewport: plan.viewport,
      confidence: fallback ? "fallback" : recommendation.confidence,
      decision: plan.decisions.at(-1),
      warning: fallback ? viewportWarning(recommendation) : null,
    });
  } finally {
    core.status("output_plan_release", session);
  }
}

function effectSummaries(motion) {
  return motion.effects.map((effect) => ({
    effectOrder: effect.effectOrder,
    animationName: effect.animationName || null,
    kind: effect.kind,
  }));
}

export async function planRenderInput(preparedInput, request = {}) {
  const graphicsBackend = request.graphicsBackend ?? "auto";
  const [backendPointer, backendLength] = core.input(textOf(graphicsBackend));
  const [backendJsonPointer, backendJsonLength] = core.input(jsonText(graphicsBackend));
  const session = core.statusRaw("output_plan_begin", backendPointer, backendLength,
    backendJsonPointer, backendJsonLength, request.scrollbarStyle === undefined ? 1 : 0);
  try {
    const scrollbarStyle = assertScrollbarStyle(
      request.scrollbarStyle ?? "overlay",
      "render planning request",
    );
    const viewportDeviceScale = request.viewport !== null &&
        typeof request.viewport === "object"
      ? request.viewport.deviceScale
      : undefined;
    const requestedDeviceScale = viewportDeviceScale ?? request.deviceScale ?? 1;
    const viewportKind = request.viewport === "auto" || request.viewport === undefined
      ? PLAN.VIEWPORT_AUTO
      : request.viewport === null || typeof request.viewport !== "object"
      ? PLAN.VIEWPORT_NOT_OBJECT
      : PLAN.VIEWPORT_OBJECT;
    const explicit = core.statusRaw("output_plan_viewport", session,
      requestedDeviceScale === "auto" ? 1 : 0,
      requestedDeviceScale === "auto" ? 1 : Number(requestedDeviceScale), viewportKind,
      viewportKind === PLAN.VIEWPORT_OBJECT ? Number(request.viewport.width) : NaN,
      viewportKind === PLAN.VIEWPORT_OBJECT ? Number(request.viewport.height) : NaN);
    let recommendation = null;
    if (!explicit) {
      recommendation = await recommendViewport(
        preparedInput,
        { ...request.viewportRecommendation, scrollbarStyle },
      );
      submitRecommendation(session, recommendation);
    }
    const provisional = readPlan(session).viewport;

    const inspection = await inspectPreparedInput(preparedInput, {
      mode: "observed",
      viewport: provisional,
      scrollbarStyle,
    });
    const requestedCapture = request.capture ?? {};
    const durationOverride = requestedCapture.durationMilliseconds;
    const repetitionOverride = requestedCapture.repetition;
    const preferredFrameRateOverride = requestedCapture.preferredFrameRate;
    const motionRecommendation = recommendMotionCapture(inspection.motion, {
      preferredFrameRate: isAuto(preferredFrameRateOverride) ? undefined : preferredFrameRateOverride,
      maximumFrameRate: requestedCapture.maximumFrameRate,
      maximumFrameCount: requestedCapture.maximumFrameCount,
      maximumPeriodMilliseconds: requestedCapture.maximumPeriodMilliseconds,
    });

    const requestedOutput = request.output ?? "auto";
    const outputOptions = request.outputOptions ?? {};
    const optionsObject = outputOptions !== null && typeof outputOptions === "object" &&
      !Array.isArray(outputOptions);
    const inputs = [
      textOf(motionRecommendation.kind), textOf(motionRecommendation.confidence),
      textOf(motionRecommendation.reason?.code), textOf(requestedOutput), jsonText(requestedOutput),
      textOf(repetitionOverride?.kind),
    ].map((value) => core.input(value));
    const outcome = core.statusRaw("output_plan_capture", session,
      ...inputs[0], ...inputs[1], ...inputs[2],
      motionRecommendation.durationMilliseconds ?? NaN, motionRecommendation.sampling === null ? 0 : 1,
      requestedOutput === "auto" ? 0 : 1, ...inputs[3], ...inputs[4],
      optionsObject ? 1 : 0, optionsObject ? Object.keys(outputOptions).length : 0,
      isAuto(durationOverride) ? 0 : 1, isAuto(durationOverride) ? NaN : Number(durationOverride),
      isAuto(repetitionOverride) ? 0 : 1, ...inputs[5],
      typeof repetitionOverride?.count === "number" ? repetitionOverride.count : NaN,
      isAuto(preferredFrameRateOverride) ? 0 : 1,
      isAuto(preferredFrameRateOverride) ? NaN : Number(preferredFrameRateOverride),
      requestedCapture.maximumFrameCount == null ? 0 : 1, Number(requestedCapture.maximumFrameCount),
      requestedCapture.maximumFrameRate == null ? 0 : 1, Number(requestedCapture.maximumFrameRate));
    const plan = readPlan(session);
    if (outcome === PLAN.REFUSED) {
      if (plan.refusal === PLAN.REFUSAL_NO_SCHEDULE) {
        throw new RenderPlanningError(planText(PLAN.TEXT_REFUSAL_NO_SCHEDULE), {
          kind: "render-planning-refusal",
          version: 1,
          unresolvedField: planText(PLAN.TEXT_FIELD_SAMPLING),
          inspectionClassification: inspection.motion.classification,
          reason: motionRecommendation.reason,
          acceptedCallerConstraints: [planText(PLAN.TEXT_FIELD_DURATION)],
          effects: [],
        });
      }
      const external = plan.refusal === PLAN.REFUSAL_EXTERNAL_MOTION;
      const field = planText(external ? PLAN.TEXT_FIELD_PROGRESS_SCHEDULE : PLAN.TEXT_FIELD_DURATION);
      const message = planText(external ? PLAN.TEXT_REFUSAL_EXTERNAL : PLAN.TEXT_REFUSAL_INDETERMINATE);
      throw new RenderPlanningError(message, {
        kind: "render-planning-refusal",
        version: 1,
        unresolvedField: field,
        inspectionClassification: inspection.motion.classification,
        reason: { code: motionRecommendation.reason.code, message },
        acceptedCallerConstraints: [field],
        effects: effectSummaries(inspection.motion),
      });
    }
    const warnings = [];
    if (plan.warnings & PLAN.WARNING_VIEWPORT) warnings.push(viewportWarning(recommendation));
    if (plan.warnings & PLAN.WARNING_DURATION) {
      warnings.push({
        field: planText(PLAN.TEXT_FIELD_DURATION),
        source: planText(PLAN.TEXT_SOURCE_BOUNDED_FALLBACK),
        reason: { code: planText(PLAN.TEXT_DURATION_FALLBACK_CODE), message: planText(PLAN.TEXT_DURATION_FALLBACK_MESSAGE) },
        evidence: {
          inspectionClassification: inspection.motion.classification,
          recommendationReason: motionRecommendation.reason,
          effects: effectSummaries(inspection.motion),
        },
      });
    }
    const [preferredFrameRate, maximumFrameRate, maximumFrameCount, recommendedFrameBudget] = plan.fallbackSampling;
    const sampling = plan.samplingFallback
      ? {
        strategy: planText(PLAN.TEXT_SAMPLING_STRATEGY),
        preferredFrameRate,
        maximumFrameRate,
        maximumFrameCount,
        requiredSampleCount: null,
        recommendedFrameBudget,
        mandatorySampleTimesMilliseconds: null,
        recommendedSampleTimesMilliseconds: null,
      }
      : motionRecommendation.sampling;
    const format = PLAN.TEXT_FORMATS + plan.format * 3;
    return deepFreeze({
      kind: "render-plan",
      version: 1,
      output: {
        format: planText(format),
        mediaType: planText(format + 1),
        extension: planText(format + 2),
        ...(plan.format === PLAN.FORMAT_JPEG_GAIN_MAP ? { codecOptions: { ...outputOptions } } : {}),
      },
      graphicsBackend,
      scrollbarStyle,
      viewport: plan.viewport,
      capture: {
        kind: motionRecommendation.kind,
        durationMilliseconds: plan.durationMilliseconds,
        repetition: plan.repetition === PLAN.REPETITION_CALLER
          ? repetitionOverride
          : plan.repetition === PLAN.REPETITION_INFINITE
          ? { kind: "infinite" }
          : { kind: "count", count: 1 },
        sampling,
        periodMilliseconds: motionRecommendation.periodMilliseconds,
        periodRational: motionRecommendation.periodRational,
        returnsToInitialState: motionRecommendation.returnsToInitialState,
      },
      confidence: planText(plan.confidence),
      decisions: plan.decisions,
      warnings,
    });
  } finally {
    core.status("output_plan_release", session);
  }
}

export async function renderInput(input, options = {}) {
  const {
    preprocessors = [],
    preprocessor,
    host,
    ...planningRequest
  } = options;
  const preparedInput = await prepareRenderInput(input, {
    preprocessors,
    preprocessor,
    host,
  });
  const session = new DocumentSession(preparedInput);
  try {
    const plan = await session.plan(planningRequest);
    return await session.renderOnce(plan);
  } finally {
    await session.dispose();
  }
}
