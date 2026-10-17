import { sharedDomCore } from "./dom-wasm/core.js";

export const FONT_METRICS_PACKAGE_VERSION = "0.1.0";
const metricsByBytes = new WeakMap();
const decoder = new TextDecoder();

function readResult(pointer) {
  const view = new DataView(sharedDomCore.refreshBytes().buffer);
  return Object.freeze({
    upem: view.getUint32(pointer + 4, true),
    ascender: view.getInt32(pointer + 8, true),
    descender: view.getInt32(pointer + 12, true),
    lineGap: view.getInt32(pointer + 16, true),
    underlinePosition: view.getInt32(pointer + 20, true),
    underlineThickness: view.getInt32(pointer + 24, true),
    strikeoutPosition: view.getInt32(pointer + 28, true),
    strikeoutThickness: view.getInt32(pointer + 32, true),
    zeroAdvanceRatio: view.getFloat64(pointer + 40, true),
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
    faceIndex === undefined ? 0 : typeof faceIndex === "number" ? 1 : 2) >>> 0;
  let cachedByFace = metricsByBytes.get(bytes);
  const cached = cachedByFace?.get(index);
  if (cached) return cached;

  const succeeded = sharedDomCore.status("font_metrics_inspect",
    ...sharedDomCore.byteInput(bytes), index);
  const pointer = sharedDomCore.exports.abi_output_pointer();
  if (succeeded === 0) {
    const memory = sharedDomCore.refreshBytes();
    const view = new DataView(memory.buffer, pointer);
    const error = new Error(decoder.decode(memory.subarray(pointer + 8,
      pointer + sharedDomCore.exports.abi_output_length())));
    error.fontMetricsCode = view.getUint32(0, true);
    error.fontMetricsField = view.getUint32(4, true);
    throw error;
  }
  const metrics = readResult(pointer);
  if (!cachedByFace) {
    cachedByFace = new Map();
    metricsByBytes.set(bytes, cachedByFace);
  }
  cachedByFace.set(index, metrics);
  return metrics;
}
