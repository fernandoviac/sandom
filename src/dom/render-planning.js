import {
  inspectPreparedInput,
  prepareRenderInput,
} from "./render-animation.js";
import { assertScrollbarStyle } from "./scrollbar-visibility.js";
import { DocumentSession } from "./document-session.js";
import { recommendMotionCapture } from "./motion-capture-recommendation.js";
import { recommendViewport } from "./viewport-recommendation.js";

export const STANDARD_RENDER_VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
});
export const INDETERMINATE_MOTION_FALLBACK_DURATION_MILLISECONDS = 3000;

const OUTPUTS = Object.freeze({
  png: Object.freeze({
    format: "png",
    mediaType: "image/png",
    extension: ".png",
  }),
  gif: Object.freeze({
    format: "gif",
    mediaType: "image/gif",
    extension: ".gif",
  }),
  "jpeg-xl": Object.freeze({
    format: "jpeg-xl",
    mediaType: "image/jxl",
    extension: ".jxl",
  }),
  "jpeg-gain-map": Object.freeze({
    format: "jpeg-gain-map",
    mediaType: "image/jpeg",
    extension: ".gain-map.jpg",
  }),
});

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

function decision(field, source, code, message) {
  return { field, source, reason: { code, message } };
}

export class RenderPlanningError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RenderPlanningError";
    this.details = deepFreeze(details);
  }
}

function planningRefusal(field, motion, reason, acceptedCallerConstraints) {
  throw new RenderPlanningError(reason.message, {
    kind: "render-planning-refusal",
    version: 1,
    unresolvedField: field,
    inspectionClassification: motion.classification,
    reason,
    acceptedCallerConstraints,
    effects: motion.effects.map((effect) => ({
      effectOrder: effect.effectOrder,
      animationName: effect.animationName || null,
      kind: effect.kind,
    })),
  });
}

function explicitViewport(value, deviceScale) {
  if (value === "auto" || value === undefined) return null;
  if (value === null || typeof value !== "object") {
    throw new TypeError("viewport must be auto or an object");
  }
  const width = Number(value.width);
  const height = Number(value.height);
  const scaleValue = value.deviceScale ?? deviceScale ?? "auto";
  const scale = scaleValue === "auto" ? 1 : Number(scaleValue);
  if (!(width > 0) || !(height > 0) || !(scale > 0)) {
    throw new RangeError(
      "viewport width, height, and deviceScale must be positive",
    );
  }
  return { width, height, deviceScale: scale };
}

export function planAutomaticViewport(recommendation, deviceScale = 1) {
  const scale = Number(deviceScale);
  if (!(scale > 0)) {
    throw new RangeError("deviceScale must be positive");
  }
  if (recommendation.classification === "none-valid") {
    const reason = {
      code: "no-valid-viewport-standard-fallback",
      message:
        "No recommended viewport satisfies every analytical constraint; policy selected the standard 1280 by 720 viewport",
    };
    return deepFreeze({
      viewport: { ...STANDARD_RENDER_VIEWPORT, deviceScale: scale },
      confidence: "fallback",
      decision: decision(
        "viewport",
        "standard-viewport",
        reason.code,
        reason.message,
      ),
      warning: {
        field: "viewport",
        source: "standard-viewport",
        reason,
        evidence: {
          classification: recommendation.classification,
          recommendationReason: recommendation.reason,
          rejections: recommendation.rejections,
        },
      },
    });
  }
  if (
    recommendation.classification === "selected" &&
    recommendation.viewport !== null
  ) {
    return deepFreeze({
      viewport: { ...recommendation.viewport, deviceScale: scale },
      confidence: recommendation.confidence,
      decision: decision(
        "viewport",
        "recommendation",
        "recommended-viewport",
        recommendation.reasons.join("; "),
      ),
      warning: null,
    });
  }
  throw new TypeError("Viewport recommendation has an invalid outcome");
}

export async function planRenderInput(preparedInput, request = {}) {
  const decisions = [];
  const warnings = [];
  const graphicsBackend = request.graphicsBackend ?? "auto";
  if (!["auto", "webgpu", "webgl2"].includes(graphicsBackend)) {
    throw new RangeError(
      `Unsupported graphics backend ${JSON.stringify(graphicsBackend)}`,
    );
  }
  decisions.push(decision(
    "graphicsBackend",
    graphicsBackend === "auto" ? "default" : "caller",
    graphicsBackend === "auto"
      ? "automatic-graphics-backend"
      : "caller-graphics-backend",
    graphicsBackend === "auto"
      ? "The runtime selects the first available graphics backend"
      : "The caller supplied the graphics backend",
  ));
  const scrollbarStyle = assertScrollbarStyle(
    request.scrollbarStyle ?? "overlay",
    "render planning request",
  );
  decisions.push(decision(
    "scrollbarStyle",
    request.scrollbarStyle === undefined ? "default" : "caller",
    request.scrollbarStyle === undefined
      ? "default-scrollbar-style"
      : "caller-scrollbar-style",
    request.scrollbarStyle === undefined
      ? "Scrollbars use the overlay style"
      : "The caller supplied the scrollbar style",
  ));
  const viewportDeviceScale = request.viewport !== null &&
      typeof request.viewport === "object"
    ? request.viewport.deviceScale
    : undefined;
  const requestedDeviceScale = viewportDeviceScale ?? request.deviceScale ?? 1;
  const provisionalDeviceScale = requestedDeviceScale === "auto"
    ? 1
    : Number(requestedDeviceScale);
  if (!(provisionalDeviceScale > 0)) {
    throw new RangeError("deviceScale must be auto or a positive number");
  }
  const requestedViewport = explicitViewport(
    request.viewport,
    provisionalDeviceScale,
  );
  let viewport;
  let viewportConfidence;
  if (requestedViewport) {
    viewport = requestedViewport;
    viewportConfidence = "caller";
    decisions.push(decision(
      "viewport",
      "caller",
      "caller-viewport",
      "The caller supplied the viewport",
    ));
  } else {
    const viewportPlan = planAutomaticViewport(
      await recommendViewport(
        preparedInput,
        { ...request.viewportRecommendation, scrollbarStyle },
      ),
      provisionalDeviceScale,
    );
    viewport = viewportPlan.viewport;
    viewportConfidence = viewportPlan.confidence;
    decisions.push(viewportPlan.decision);
    if (viewportPlan.warning) warnings.push(viewportPlan.warning);
  }

  const inspection = await inspectPreparedInput(preparedInput, {
    mode: "observed",
    viewport,
    scrollbarStyle,
  });
  const requestedCapture = request.capture ?? {};
  const durationOverride = requestedCapture.durationMilliseconds;
  const repetitionOverride = requestedCapture.repetition;
  const preferredFrameRateOverride = requestedCapture.preferredFrameRate;
  const motionRecommendation = recommendMotionCapture(inspection.motion, {
    preferredFrameRate: preferredFrameRateOverride === "auto" ||
        preferredFrameRateOverride === undefined
      ? 30
      : preferredFrameRateOverride,
    maximumFrameRate: requestedCapture.maximumFrameRate ?? 60,
    maximumFrameCount: requestedCapture.maximumFrameCount ?? 300,
    maximumPeriodMilliseconds: requestedCapture.maximumPeriodMilliseconds ??
      60000,
  });

  const requestedOutput = request.output ?? "auto";
  const outputOptions = request.outputOptions ?? {};
  if (outputOptions === null || typeof outputOptions !== "object" || Array.isArray(outputOptions)) {
    throw new TypeError("outputOptions must be an object");
  }
  let format;
  if (requestedOutput !== "auto") {
    if (!Object.hasOwn(OUTPUTS, requestedOutput)) {
      throw new RangeError(
        `Unsupported output format ${JSON.stringify(requestedOutput)}`,
      );
    }
    format = requestedOutput;
    decisions.push(decision(
      "output.format",
      "caller",
      "caller-output-format",
      "The caller supplied the output format",
    ));
  } else if (motionRecommendation.kind === "still") {
    format = "png";
    decisions.push(decision(
      "output.format",
      "inspection",
      "still-motion-uses-png",
      "No progressing rendered effect exists",
    ));
  } else if (
    ["finite", "periodic", "bounded-but-not-returning"].includes(
      motionRecommendation.kind,
    )
  ) {
    format = "gif";
    decisions.push(decision(
      "output.format",
      "recommendation",
      "bounded-motion-uses-gif",
      "The selected scene has a bounded automatic capture",
    ));
  } else if (motionRecommendation.kind === "indeterminate") {
    format = "gif";
    decisions.push(decision(
      "output.format",
      durationOverride !== undefined && durationOverride !== "auto"
        ? "caller"
        : "bounded-fallback",
      durationOverride !== undefined && durationOverride !== "auto"
        ? "caller-bounded-motion-uses-gif"
        : "indeterminate-motion-bounded-fallback-uses-gif",
      durationOverride !== undefined && durationOverride !== "auto"
        ? "The caller supplied a bound for indeterminate motion"
        : "Policy bounded indeterminate motion with a short capture duration",
    ));
  } else {
    planningRefusal(
      motionRecommendation.kind === "externally-driven"
        ? "capture.progressSchedule"
        : "capture.durationMilliseconds",
      inspection.motion,
      {
        code: motionRecommendation.reason.code,
        message: motionRecommendation.kind === "externally-driven"
          ? "External motion requires a caller progress schedule"
          : "Indeterminate motion requires a caller duration",
      },
      motionRecommendation.kind === "externally-driven"
        ? ["capture.progressSchedule"]
        : ["capture.durationMilliseconds"],
    );
  }
  const resolvedDeviceScale = requestedDeviceScale === "auto"
    ? format === "gif" ? 1 : 2
    : provisionalDeviceScale;
  viewport = { ...viewport, deviceScale: resolvedDeviceScale };
  decisions.push(decision(
    "viewport.deviceScale",
    requestedDeviceScale === "auto" ? "output-policy" : "caller",
    requestedDeviceScale === "auto"
      ? format === "gif"
        ? "animated-output-device-scale"
        : "still-output-device-scale"
      : "caller-device-scale",
    requestedDeviceScale === "auto"
      ? format === "gif"
        ? "Animated output uses device scale 1"
        : "Still output uses device scale 2"
      : "The caller supplied the device scale",
  ));
  if (format !== "jpeg-gain-map" && Object.keys(outputOptions).length > 0) {
    throw new RangeError("outputOptions are available only for jpeg-gain-map");
  }

  let durationMilliseconds = motionRecommendation.durationMilliseconds;
  if (durationOverride !== undefined && durationOverride !== "auto") {
    durationMilliseconds = Number(durationOverride);
    if (!(durationMilliseconds > 0) || !Number.isFinite(durationMilliseconds)) {
      throw new RangeError(
        "capture durationMilliseconds must be positive and finite",
      );
    }
    decisions.push(decision(
      "capture.durationMilliseconds",
      "caller",
      "caller-capture-duration",
      "The caller supplied the capture duration",
    ));
  } else if (motionRecommendation.kind === "indeterminate") {
    durationMilliseconds = INDETERMINATE_MOTION_FALLBACK_DURATION_MILLISECONDS;
    const reason = {
      code: "indeterminate-motion-bounded-duration-fallback",
      message:
        `Motion duration is indeterminate; policy bounded capture at ${INDETERMINATE_MOTION_FALLBACK_DURATION_MILLISECONDS} milliseconds`,
    };
    decisions.push(decision(
      "capture.durationMilliseconds",
      "bounded-fallback",
      reason.code,
      reason.message,
    ));
    warnings.push({
      field: "capture.durationMilliseconds",
      source: "bounded-fallback",
      reason,
      evidence: {
        inspectionClassification: inspection.motion.classification,
        recommendationReason: motionRecommendation.reason,
        effects: inspection.motion.effects.map((effect) => ({
          effectOrder: effect.effectOrder,
          animationName: effect.animationName || null,
          kind: effect.kind,
        })),
      },
    });
  } else {
    decisions.push(decision(
      "capture.durationMilliseconds",
      "recommendation",
      motionRecommendation.reason.code,
      "Motion inspection determined the capture duration",
    ));
  }

  let repetition = motionRecommendation.kind === "periodic"
    ? { kind: "infinite" }
    : { kind: "count", count: 1 };
  if (repetitionOverride !== undefined && repetitionOverride !== "auto") {
    repetition = repetitionOverride;
    decisions.push(decision(
      "capture.repetition",
      "caller",
      "caller-repetition",
      "The caller supplied repetition",
    ));
  } else {
    decisions.push(decision(
      "capture.repetition",
      "recommendation",
      motionRecommendation.kind === "periodic"
        ? "proven-periodic-repetition"
        : "bounded-one-play",
      motionRecommendation.kind === "periodic"
        ? "The scene has a proven shared period"
        : "The bounded scene plays once",
    ));
  }

  if (
    repetition?.kind !== "infinite" &&
    !(repetition?.kind === "count" && Number.isInteger(repetition.count) &&
      repetition.count > 0)
  ) {
    throw new RangeError(
      "capture repetition must be infinite or a positive count",
    );
  }
  if (format !== "gif" && motionRecommendation.kind !== "still") {
    throw new RangeError(`${format} does not support animated capture`);
  }

  let sampling = motionRecommendation.sampling;
  if (sampling === null && motionRecommendation.kind === "indeterminate") {
    const preferredFrameRate = preferredFrameRateOverride === undefined ||
        preferredFrameRateOverride === "auto"
      ? 30
      : Number(preferredFrameRateOverride);
    const maximumFrameCount = Number(requestedCapture.maximumFrameCount ?? 300);
    if (!(preferredFrameRate > 0) || !Number.isFinite(preferredFrameRate)) {
      throw new RangeError("capture preferredFrameRate must be positive");
    }
    if (!(Number.isInteger(maximumFrameCount) && maximumFrameCount > 0)) {
      throw new RangeError(
        "capture maximumFrameCount must be a positive integer",
      );
    }
    sampling = {
      strategy: "adaptive",
      preferredFrameRate,
      maximumFrameRate: Number(requestedCapture.maximumFrameRate ?? 60),
      maximumFrameCount,
      requiredSampleCount: null,
      recommendedFrameBudget: Math.min(
        maximumFrameCount,
        Math.ceil(durationMilliseconds * preferredFrameRate / 1000) + 1,
      ),
      mandatorySampleTimesMilliseconds: null,
      recommendedSampleTimesMilliseconds: null,
    };
  }
  if (format === "gif" && sampling === null) {
    throw new RenderPlanningError("Animated output has no capture schedule", {
      kind: "render-planning-refusal",
      version: 1,
      unresolvedField: "capture.sampling",
      inspectionClassification: inspection.motion.classification,
      reason: motionRecommendation.reason,
      acceptedCallerConstraints: ["capture.durationMilliseconds"],
      effects: [],
    });
  }
  decisions.push(decision(
    "capture.sampling",
    preferredFrameRateOverride === undefined ||
      preferredFrameRateOverride === "auto"
      ? "recommendation"
      : "caller",
    "adaptive-motion-boundaries",
    "Adaptive sampling preserves mandatory motion boundaries",
  ));
  return deepFreeze({
    kind: "render-plan",
    version: 1,
    output: {
      ...OUTPUTS[format],
      ...(format === "jpeg-gain-map"
        ? { codecOptions: { ...outputOptions } }
        : {}),
    },
    graphicsBackend,
    scrollbarStyle,
    viewport,
    capture: {
      kind: motionRecommendation.kind,
      durationMilliseconds,
      repetition,
      sampling,
      periodMilliseconds: motionRecommendation.periodMilliseconds,
      periodRational: motionRecommendation.periodRational,
      returnsToInitialState: motionRecommendation.returnsToInitialState,
    },
    confidence: viewportConfidence === "fallback" || warnings.length > 0
      ? "fallback"
      : motionRecommendation.confidence === "proven"
      ? viewportConfidence === "high" || viewportConfidence === "caller"
        ? "high"
        : "medium"
      : "indeterminate",
    decisions,
    warnings,
  });
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
