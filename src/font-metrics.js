import { sharedDomCore } from "./dom-wasm/core.js";
import { layoutConstant } from "./wasm/layout-table.js";

export const FONT_METRICS_PACKAGE_VERSION = "0.1.0";
const metricsByBytes = new WeakMap();
const decoder = new TextDecoder();
const OPTIONAL_ABSENT = layoutConstant("OPTIONAL_ABSENT");
const OPTIONAL_PRESENT = layoutConstant("OPTIONAL_PRESENT");
const OPTIONAL_OTHER = layoutConstant("OPTIONAL_OTHER");
const FAILURE = Object.freeze(Object.fromEntries(["CODE", "FIELD", "TEXT"]
  .map((name) => [name, layoutConstant(`FONT_METRICS_FAILURE_${name}`)])));

// The metric record of the @sandom/font-metrics library, which exports the
// offset of each field (font_metrics_result_<field>_offset).
function resultOffset(field) {
  return sharedDomCore.exports[`font_metrics_result_${field}_offset`].value;
}

// The scalar record in the output of font_metrics_inspect.
function readResult(view) {
  const signed = (field) => view.getInt32(resultOffset(field), true);
  return Object.freeze({
    upem: view.getUint32(resultOffset("upem"), true),
    ascender: signed("ascender"),
    descender: signed("descender"),
    lineGap: signed("line_gap"),
    underlinePosition: signed("underline_position"),
    underlineThickness: signed("underline_thickness"),
    strikeoutPosition: signed("strikeout_position"),
    strikeoutThickness: signed("strikeout_thickness"),
    zeroAdvanceRatio: view.getFloat64(resultOffset("zero_advance_ratio"), true),
  });
}

// Native code validates the face index, reads the composed metric library,
// and returns either its scalar record or its diagnostic envelope.
export function readFontMetrics(bytes, { faceIndex } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Font metric input must be a Uint8Array");
  }
  const index = sharedDomCore.status("font_face_index",
    typeof faceIndex === "number" ? faceIndex : 0,
    faceIndex === undefined ? OPTIONAL_ABSENT : typeof faceIndex === "number" ? OPTIONAL_PRESENT : OPTIONAL_OTHER) >>> 0;
  let cachedByFace = metricsByBytes.get(bytes);
  const cached = cachedByFace?.get(index);
  if (cached) return cached;

  const succeeded = sharedDomCore.status("font_metrics_inspect",
    ...sharedDomCore.byteInput(bytes), index);
  const output = sharedDomCore.output("font_metrics_inspect");
  if (succeeded === 0) {
    const error = new Error(output.text(decoder, FAILURE.TEXT));
    error.fontMetricsCode = output.getUint32(FAILURE.CODE, true);
    error.fontMetricsField = output.getUint32(FAILURE.FIELD, true);
    throw error;
  }
  const metrics = readResult(output);
  if (!cachedByFace) {
    cachedByFace = new Map();
    metricsByBytes.set(bytes, cachedByFace);
  }
  cachedByFace.set(index, metrics);
  return metrics;
}
