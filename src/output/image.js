// OutputRequest validation and encoder dispatch (wide-color plan,
// package 6; contract in docs/specifications/color-and-image-data.md).
//
// `validateOutputRequest` normalizes a caller's request against the closed
// per-format contract and rejects every documented invalid combination.
// `encodeImage` runs the central transform (src/output/color-transform.js)
// and dispatches the still-image encoder. Animated GIF output has its own
// recorder (`src/output/gif.js`); Sandom offers no video output — see
// `@sandom/vp9-webm` (`../sandom-vp9-webm/plans/PLAN-native-vp9-webm-output.md`).

import {
  REFERENCE_WHITE_LUMINANCE,
  validateColorEncoding,
} from "../color.js";
import { encodeHostValues } from "../wasm/host-values.js";
import { transformImageForOutput, validateNativeOutputPolicy } from "./color-transform.js";
import {
  callOutputFormats,
  encodeText,
  FORMAT_CAPABILITIES,
  outputBitDepth,
  outputRequestText,
  REQUEST_CHECK,
  REQUEST_PEAK,
} from "./format-policy.js";
import { encodePngOutput } from "./png.js";
import { encodeRaw } from "./raw.js";
import { encodeBMP } from "./bmp.js";
import { encodePPM } from "./ppm.js";
import { encodeJxlOutput } from "../jpeg-xl.js";
import {
  DEFAULT_ADAPTIVE_CODEC_OPTIONS,
  generateAdaptiveImage,
} from "./gain-map.js";
import { encodeGainMapJpegPackage } from "./jpeg-gain-map.js";

export const OUTPUT_FORMATS = Object.freeze(Object.keys(FORMAT_CAPABILITIES));

// The default output encoding of a format, one frozen record per
// primaries, transfer function and white point.
const defaultEncodings = new Map();
function defaultEncoding(primaries, transferFunction, whitePoint) {
  const key = `${primaries} ${transferFunction} ${whitePoint}`;
  if (!defaultEncodings.has(key)) {
    defaultEncodings.set(key, Object.freeze({
      primaries,
      transferFunction,
      transferFunctionParameters: null,
      whitePoint,
      referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
      profile: null,
    }));
  }
  return defaultEncodings.get(key);
}

/**
 * Validates an `OutputRequest` against the closed per-format contract and
 * returns the complete request with documented defaults filled in
 * (output-request.watpart).
 *
 * `format` is always required. `colorEncoding`, `bitDepth`, `alphaMode`,
 * `toneMap`, `gamutMap`, and `targetPeakLuminance` default to the format's
 * documented standard-dynamic-range sRGB (or linear Rec. 2020) contract; a
 * wide-gamut or high-dynamic-range output always requires the caller to
 * name it.
 *
 * Pass `renderPrecision` when the render context is known: the
 * `rgba8unorm` speed mode rejects wide-gamut and high-dynamic-range
 * requests here, before any encoder runs.
 */
export function validateOutputRequest(request, { renderPrecision } = {}) {
  if (request === null || typeof request !== "object") {
    throw new Error("OutputRequest must be an object");
  }
  const found = callOutputFormats("output_request_format", [], [
    encodeText(typeof request.format === "string" ? request.format : ""), encodeText(String(JSON.stringify(request.format))),
  ]);
  const format = found.result;
  const [, hasDefaultCodecOptions, primaries, transfer, whitePoint] = new Uint32Array(found.output.buffer);
  const colorEncoding = request.colorEncoding ??
    defaultEncoding(outputRequestText(primaries), outputRequestText(transfer), outputRequestText(whitePoint));
  validateColorEncoding(colorEncoding);
  const masteringDisplay = request.masteringDisplay ?? null;
  const contentLightLevel = request.contentLightLevel ?? null;
  const masteringRecord = typeof masteringDisplay === "object" && masteringDisplay !== null;
  const codecOptions = {
    ...(hasDefaultCodecOptions ? DEFAULT_ADAPTIVE_CODEC_OPTIONS : {}),
    ...(request.codecOptions ?? {}),
  };
  const entries = Object.entries(codecOptions);
  const checked = callOutputFormats("output_request_check", [format], [encodeHostValues([
    colorEncoding.primaries, colorEncoding.transferFunction, request.dynamicRange, renderPrecision, request.bitDepth,
    request.alphaMode, request.toneMap, request.gamutMap, request.targetPeakLuminance, masteringDisplay,
    masteringRecord ? masteringDisplay.maxLuminance : undefined, masteringRecord ? masteringDisplay.minLuminance : undefined,
    contentLightLevel, contentLightLevel?.maxContentLightLevel, contentLightLevel?.maxFrameAverageLightLevel,
    entries.length, ...entries.flat(),
  ])]);
  const output = new DataView(checked.output.buffer);
  const peakSource = output.getUint32(REQUEST_CHECK.PEAK_SOURCE, true);
  return validateNativeOutputPolicy(Object.freeze({
    format: request.format,
    colorEncoding,
    dynamicRange: outputRequestText(output.getUint32(REQUEST_CHECK.DYNAMIC_RANGE, true)),
    bitDepth: outputBitDepth(output.getFloat64(REQUEST_CHECK.BIT_DEPTH, true), output.getUint32(REQUEST_CHECK.BIT_DEPTH_PIECE, true)),
    alphaMode: outputRequestText(output.getUint32(REQUEST_CHECK.ALPHA_MODE, true)),
    toneMap: outputRequestText(output.getUint32(REQUEST_CHECK.TONE_MAP, true)),
    gamutMap: outputRequestText(output.getUint32(REQUEST_CHECK.GAMUT_MAP, true)),
    targetPeakLuminance: peakSource === REQUEST_PEAK.REQUEST ? request.targetPeakLuminance
      : peakSource === REQUEST_PEAK.NULL ? null : output.getFloat64(REQUEST_CHECK.PEAK, true),
    masteringDisplay,
    contentLightLevel,
    codecOptions: Object.freeze({ ...codecOptions }),
  }), { renderPrecision });
}

/**
 * Encodes a working `ImageDescriptor` for one still-image output request.
 * Validates the request, runs the central transform, and dispatches the
 * encoder. Stream formats reject: their recorders own frame delivery.
 */
export async function encodeImage(descriptor, request, options = {}) {
  const validated = validateOutputRequest(request, options);
  if (validated.format === "png") {
    return await (options.encodePngOutput ?? encodePngOutput)(descriptor, validated);
  }
  if (validated.format === "jpeg-xl") {
    return await (
      options.encodeJxlOutput ?? encodeJxlOutput
    )(descriptor, validated);
  }
  if (validated.format === "jpeg-gain-map") {
    const record = generateAdaptiveImage(descriptor, validated);
    return (await encodeGainMapJpegPackage(record)).bytes;
  }
  if (validated.format === "raw") {
    return encodeRaw(descriptor, validated);
  }
  if (validated.format === "bmp") {
    return encodeBMP(descriptor, validated);
  }
  if (validated.format === "ppm") {
    return encodePPM(descriptor, validated);
  }
  throw new Error(
    `encodeImage: ${validated.format} is a stream format; use its recorder`,
  );
}

export { transformImageForOutput };
