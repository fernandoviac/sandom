// Automatic viewport recommendation.
//
// The algorithm is a fitting check, not a search. It trusts direct
// measurement and verifies each candidate with one real layout:
//
//   1. A declared root size is the author's answer. Select it.
//   2. One intrinsic-size visual root (an image or an SVG) names its own
//      size. Select it when the content fits.
//   3. Otherwise the measured content bounds at the initial viewport give
//      the candidate size. Verify with one layout at that size; when the
//      content moved (viewport-relative layout), follow the new bounds,
//      at most three steps.
//   4. When no fitted size verifies, keep the initial viewport if the
//      content fits inside it.
//
// Every candidate the algorithm lays out becomes one trial in the
// result, in attempt order, so a caller can render the decision.

import { inspectPreparedInput } from "./render-animation.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";

const CONTROL_NAMES = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "PROGRESS",
  "METER",
]);
const VECTOR_DISPLAYS = new Set([
  "svg",
  "svg-path",
  "svg-rect",
  "svg-circle",
  "svg-ellipse",
  "svg-line",
  "svg-polyline",
  "svg-polygon",
  "svg-text",
]);
const MAXIMUM_FIT_STEPS = 3;

function measureTrial(inspection, baselineTextLines) {
  const { layout } = inspection;
  const nodes = layout.nodes.filter((node) =>
    node.participatesInLayout &&
    (node.hasText || node.hasImage || CONTROL_NAMES.has(node.nodeName) ||
      VECTOR_DISPLAYS.has(node.display) ||
      (node.hasBackground && !node.viewportSizedBackground))
  );
  const boxes = nodes
    .map((node) => node.borderBox)
    .filter((box) => box.width > 0 && box.height > 0);
  const bounds = boxes.length === 0
    ? { x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0 }
    : {
      x: Math.min(...boxes.map((box) => box.x)),
      y: Math.min(...boxes.map((box) => box.y)),
      right: Math.max(...boxes.map((box) => box.x + box.width)),
      bottom: Math.max(...boxes.map((box) => box.y + box.height)),
    };
  bounds.width = Math.max(0, bounds.right - bounds.x);
  bounds.height = Math.max(0, bounds.bottom - bounds.y);
  const viewport = layout.viewport;
  const outerSpace = {
    left: bounds.x,
    top: bounds.y,
    right: viewport.width - bounds.right,
    bottom: viewport.height - bounds.bottom,
  };
  const controlOverlapNodeIndices = new Set();
  const controls = nodes.filter((node) => CONTROL_NAMES.has(node.nodeName));
  for (let firstIndex = 0; firstIndex < controls.length; firstIndex++) {
    const first = controls[firstIndex].borderBox;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < controls.length;
      secondIndex++
    ) {
      const second = controls[secondIndex].borderBox;
      if (
        first.x < second.x + second.width &&
        first.x + first.width > second.x &&
        first.y < second.y + second.height &&
        first.y + first.height > second.y
      ) {
        controlOverlapNodeIndices.add(controls[firstIndex].nodeIndex);
        controlOverlapNodeIndices.add(controls[secondIndex].nodeIndex);
      }
    }
  }
  const lineCountByNode = new Map();
  for (const line of layout.textLineBoxes) {
    lineCountByNode.set(
      line.nodeIndex,
      (lineCountByNode.get(line.nodeIndex) ?? 0) + 1,
    );
  }
  const lineCount = layout.textLineBoxes.length;
  // Fit is judged by meaningful content only: the nodes measured for the
  // bounds. Whitespace-only text runs and decorative full-bleed
  // backgrounds lay out real boxes but show nothing; they must not fail
  // a fitting trial.
  const overflowNodeIndices = nodes.filter((node) =>
    node.borderBox.width > 0 && node.borderBox.height > 0 &&
    (node.borderBox.x < -0.5 || node.borderBox.y < -0.5 ||
      node.borderBox.x + node.borderBox.width > viewport.width + 0.5 ||
      node.borderBox.y + node.borderBox.height > viewport.height + 0.5)
  ).map((node) => node.nodeIndex);
  const documentOverflow = layout.overflow.left > 0.5 ||
    layout.overflow.top > 0.5 ||
    layout.overflow.right > 0.5 ||
    layout.overflow.bottom > 0.5;
  const overflow = documentOverflow || overflowNodeIndices.length > 0;
  const avoidableWrapping = baselineTextLines !== null &&
    lineCount > baselineTextLines.lineCount;
  const avoidableWrappingNodeIndices = avoidableWrapping
    ? [...lineCountByNode].filter(([nodeIndex, count]) =>
      count > (baselineTextLines.lineCountByNode.get(nodeIndex) ?? 0)
    ).map(([nodeIndex]) => nodeIndex)
    : [];
  const controlOverlap = controlOverlapNodeIndices.size > 0;
  const valid = !overflow && !avoidableWrapping && !controlOverlap;
  const area = viewport.width * viewport.height;
  return {
    inspection,
    nodes,
    bounds,
    outerSpace,
    lineCount,
    lineCountByNode,
    overflow,
    documentOverflow,
    overflowNodeIndices,
    avoidableWrapping,
    avoidableWrappingNodeIndices,
    valid,
    controlOverlap,
    controlOverlapNodeIndices: [...controlOverlapNodeIndices],
    occupiedWidthRatio: bounds.width / viewport.width,
    occupiedHeightRatio: bounds.height / viewport.height,
    occupiedAreaRatio: area === 0 ? 0 : bounds.width * bounds.height / area,
  };
}

function rejectionConstraint(trial, code, message, nodeIndices = []) {
  const factsByIndex = new Map(
    trial.inspection.layout.nodes.map((node) => [node.nodeIndex, node]),
  );
  return Object.freeze({
    code,
    message,
    nodes: Object.freeze(nodeIndices.map((nodeIndex) => {
      const node = factsByIndex.get(nodeIndex);
      return Object.freeze({
        nodeIndex,
        nodeName: node?.nodeName ?? null,
        id: node?.id ?? null,
      });
    })),
  });
}

function failedConstraints(trial) {
  const constraints = [];
  if (trial.overflow) {
    constraints.push(rejectionConstraint(
      trial,
      trial.documentOverflow ? "document-scroll-overflow" : "document-overflow",
      trial.documentOverflow
        ? "The document scroll extent exceeds the viewport"
        : "Content extends beyond the viewport",
      trial.overflowNodeIndices,
    ));
  }
  if (trial.avoidableWrapping) {
    constraints.push(rejectionConstraint(
      trial,
      "avoidable-text-wrapping",
      "Text wraps into more lines than the initial layout",
      trial.avoidableWrappingNodeIndices,
    ));
  }
  if (trial.controlOverlap) {
    constraints.push(rejectionConstraint(
      trial,
      "control-overlap",
      "Interactive controls overlap",
      trial.controlOverlapNodeIndices,
    ));
  }
  return Object.freeze(constraints);
}

function publicTrial(trial, sequence) {
  const viewport = trial.inspection.layout.viewport;
  return Object.freeze({
    sequence,
    viewport: Object.freeze({
      width: viewport.width,
      height: viewport.height,
    }),
    source: trial.source,
    valid: trial.valid,
    contentBounds: Object.freeze({
      x: trial.bounds.x,
      y: trial.bounds.y,
      width: trial.bounds.width,
      height: trial.bounds.height,
    }),
    outerSpace: Object.freeze({ ...trial.outerSpace }),
    occupancy: Object.freeze({
      horizontal: trial.occupiedWidthRatio,
      vertical: trial.occupiedHeightRatio,
      area: trial.occupiedAreaRatio,
    }),
    controlOverlap: trial.controlOverlap,
    documentScrollBounds: Object.freeze({
      ...trial.inspection.layout.documentScrollBounds,
    }),
    overflow: trial.overflow,
    avoidableWrapping: trial.avoidableWrapping,
    textLineCount: trial.lineCount,
    failedConstraints: Object.freeze(
      failedConstraints(trial).map((constraint) => constraint.code),
    ),
  });
}

export async function recommendViewportFromInspection(
  inspectLayout,
  options = {},
) {
  if (typeof inspectLayout !== "function") {
    throw new TypeError("inspectLayout must be a function");
  }
  const initialViewport = options.initialViewport ??
    { width: 1280, height: 720 };
  const limits = options.limits ?? {};
  const limitValues = [limits.minimumWidth, limits.minimumHeight, limits.maximumWidth, limits.maximumHeight];
  const output = core.status("output_viewport_limits",
    limitValues.reduce((present, value, index) => present | (value == null ? 0 : 1 << index), 0),
    ...limitValues.map((value) => value == null ? NaN : Number(value)),
    Number(initialViewport.width), Number(initialViewport.height));
  const limitView = new DataView(core.refreshBytes().buffer, output, 48);
  const [minimumWidth, minimumHeight, maximumWidth, maximumHeight, initialWidth, initialHeight] =
    [0, 1, 2, 3, 4, 5].map((index) => limitView.getFloat64(index * 8, true));
  const clampWidth = (value) => core.exports.output_viewport_clamp(minimumWidth, maximumWidth, value);
  const clampHeight = (value) => core.exports.output_viewport_clamp(minimumHeight, maximumHeight, value);

  const trials = [];
  const trialByKey = new Map();
  const layoutAt = async (width, height, source) => {
    const key = `${width}x${height}`;
    const existing = trialByKey.get(key);
    if (existing) return existing;
    const inspection = await inspectLayout({ width, height });
    const trial = measureTrial(
      inspection,
      trials.length === 0 ? null : {
        lineCount: trials[0].lineCount,
        lineCountByNode: trials[0].lineCountByNode,
      },
    );
    trial.source = source;
    trialByKey.set(key, trial);
    trials.push(trial);
    return trial;
  };
  const selected = (trial, confidence, reasons) =>
    Object.freeze({
      kind: "viewport-recommendation",
      version: 1,
      classification: "selected",
      viewport: Object.freeze({
        width: trial.inspection.layout.viewport.width,
        height: trial.inspection.layout.viewport.height,
      }),
      confidence,
      trials: Object.freeze(
        trials.map((entry, sequence) => publicTrial(entry, sequence)),
      ),
      reasons: Object.freeze(reasons),
    });

  const initialTrial = await layoutAt(initialWidth, initialHeight, "initial");

  // 1. A declared root size is the author's answer.
  const documentRoot = initialTrial.inspection.layout.nodes.find((node) =>
    node.nodeName === "HTML" && node.parentIndex === null
  );
  if (documentRoot?.declaredWidth && documentRoot?.declaredHeight) {
    const declaredTrial = await layoutAt(
      clampWidth(documentRoot.declaredWidth),
      clampHeight(documentRoot.declaredHeight),
      "declared-root-size",
    );
    return selected(declaredTrial, "high", [
      "The document declares a complete root size",
    ]);
  }

  // 2. One intrinsic-size visual root names its own size.
  const intrinsicContent = initialTrial.nodes.filter((node) =>
    node.hasImage || node.nodeName?.toLowerCase() === "svg"
  );
  if (intrinsicContent.length === 1) {
    const node = intrinsicContent[0];
    const width = node.intrinsicDimensions?.width ?? node.declaredWidth;
    const height = node.intrinsicDimensions?.height ?? node.declaredHeight;
    if (width && height) {
      const intrinsicTrial = await layoutAt(
        clampWidth(width),
        clampHeight(height),
        "intrinsic-content-size",
      );
      if (intrinsicTrial.valid) {
        return selected(intrinsicTrial, "high", [
          "The document has one intrinsic-size visual root",
          "The content fits that size without clipping or overflow",
        ]);
      }
    }
  }

  // 3. The measured content bounds give the candidate. Follow the bounds
  //    when the content moves under the new viewport.
  let bounds = initialTrial.bounds;
  let extentTrial = initialTrial;
  for (
    let step = 0;
    step < MAXIMUM_FIT_STEPS && bounds.width > 0 && bounds.height > 0;
    step++
  ) {
    const width = clampWidth(Math.max(
      bounds.right,
      extentTrial.inspection.layout.overflow.right > 0.5
        ? extentTrial.inspection.layout.documentScrollBounds.width
        : 0,
    ));
    const height = clampHeight(Math.max(
      bounds.bottom,
      extentTrial.inspection.layout.overflow.bottom > 0.5
        ? extentTrial.inspection.layout.documentScrollBounds.height
        : 0,
    ));
    const fittedTrial = await layoutAt(width, height, "fitted-bounds");
    if (fittedTrial.valid) {
      const responsiveToViewport =
        Math.abs(fittedTrial.bounds.width - initialTrial.bounds.width) > 0.5 ||
        Math.abs(fittedTrial.bounds.height - initialTrial.bounds.height) > 0.5;
      if (initialTrial.valid && responsiveToViewport) {
        return selected(initialTrial, "medium", [
          "The content changes size with the viewport",
          "The initial viewport is the stable caller policy for responsive content",
        ]);
      }
      const anchored = bounds.x <= 0.5 && bounds.y <= 0.5;
      return selected(fittedTrial, anchored ? "high" : "medium", [
        "The viewport is the measured content extent",
        "The content fits without clipping or unintended overflow",
      ]);
    }
    const nextBounds = fittedTrial.bounds;
    const nextWidth = clampWidth(Math.max(
      nextBounds.right,
      fittedTrial.inspection.layout.overflow.right > 0.5
        ? fittedTrial.inspection.layout.documentScrollBounds.width
        : 0,
    ));
    const nextHeight = clampHeight(Math.max(
      nextBounds.bottom,
      fittedTrial.inspection.layout.overflow.bottom > 0.5
        ? fittedTrial.inspection.layout.documentScrollBounds.height
        : 0,
    ));
    if (nextWidth === width && nextHeight === height) {
      break;
    }
    bounds = nextBounds;
    extentTrial = fittedTrial;
  }

  // 4. The initial viewport itself, when the content already fits there.
  if (initialTrial.valid) {
    return selected(initialTrial, "medium", [
      "No fitted size verifies; the content fits the initial viewport",
    ]);
  }

  const rejections = trials.map((trial) =>
    Object.freeze({
      viewport: Object.freeze({
        width: trial.inspection.layout.viewport.width,
        height: trial.inspection.layout.viewport.height,
      }),
      constraints: failedConstraints(trial),
    })
  );
  return Object.freeze({
    kind: "viewport-recommendation",
    version: 1,
    classification: "none-valid",
    viewport: null,
    confidence: "unavailable",
    rejections: Object.freeze(rejections),
    trials: Object.freeze(
      trials.map((entry, sequence) => publicTrial(entry, sequence)),
    ),
    reason:
      "No candidate satisfies the viewport constraints within the configured limits",
  });
}

// `scrollbarStyle` selects the scrollbar style of every analytical trial
// (design/scrollbars.md, decision 1); the other options go to
// recommendViewportFromInspection.
export async function recommendViewport(
  preparedInput,
  { scrollbarStyle = "overlay", ...options } = {},
) {
  return await recommendViewportFromInspection(
    (viewport) =>
      inspectPreparedInput(preparedInput, {
        mode: "analytical-layout",
        viewport,
        scrollbarStyle,
      }),
    options,
  );
}
