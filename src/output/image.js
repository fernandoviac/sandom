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
import { transformImageForOutput, validateNativeOutputPolicy } from "./color-transform.js";
import { FORMAT_CAPABILITIES } from "./format-policy.js";
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

const SRGB_OUTPUT_ENCODING = Object.freeze({
  primaries: "srgb",
  transferFunction: "srgb",
  transferFunctionParameters: null,
  whitePoint: "d65",
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

const BT709_OUTPUT_ENCODING = Object.freeze({
  ...SRGB_OUTPUT_ENCODING,
  transferFunction: "rec2020",
});

const LINEAR_REC2020_ENCODING = Object.freeze({
  ...SRGB_OUTPUT_ENCODING,
  primaries: "rec2020",
  transferFunction: "linear",
});

function positiveChannelOption(value) {
  const values = Array.isArray(value) ? value : [value];
  return (values.length === 1 || values.length === 3) &&
    values.every((entry) =>
      typeof entry === "number" && Number.isFinite(entry) && entry > 0
    );
}

// One closed contract row per format: allowed bit depths, allowed output
// encodings (primaries/transfer pairs), whether the format can persist
// high dynamic range, the alpha modes the container supports, and the
// codec-option schema (closed key set with per-key validation).
const CODEC_CONTRACTS = Object.freeze({
  png: {
    codecOptions: {
      // Validated per the closed schema; the CompressionStream deflate
      // backend has one fixed level, so the value is advisory.
      compressionLevel: (value) =>
        Number.isInteger(value) && value >= 0 && value <= 9,
    },
  },
  "jpeg-xl": {
    codecOptions: {
      lossless: (value) => typeof value === "boolean",
      distance: (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    },
  },
  "jpeg-gain-map": {
    defaultCodecOptions: DEFAULT_ADAPTIVE_CODEC_OPTIONS,
    codecOptions: {
      baseQuality: (value) =>
        Number.isInteger(value) && value >= 0 && value <= 100,
      gainMapQuality: (value) =>
        Number.isInteger(value) && value >= 0 && value <= 100,
      gainMapScale: (value) => [1, 2, 4, 8].includes(value),
      metadataCompatibility: (value) => value === "iso-and-ultra-hdr",
      mapGamma: positiveChannelOption,
      baseOffset: positiveChannelOption,
      alternateOffset: positiveChannelOption,
    },
  },
  raw: {
    codecOptions: {},
  },
  bmp: {
  },
  ppm: {
  },
  canvas: {
    codecOptions: {
      canvasFormat: (value) =>
        value === "rgba8unorm" || value === "bgra8unorm" ||
        value === "rgba16float",
    },
  },
});

const DEFAULT_ENCODINGS = Object.freeze({
  srgb: SRGB_OUTPUT_ENCODING,
  bt709: BT709_OUTPUT_ENCODING,
  "linear-rec2020": LINEAR_REC2020_ENCODING,
});

const FORMAT_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(FORMAT_CAPABILITIES).map(([format, capability]) => [format, Object.freeze({
    ...capability,
    ...CODEC_CONTRACTS[format],
    codecOptions: CODEC_CONTRACTS[format].codecOptions ?? {},
    defaultEncoding: DEFAULT_ENCODINGS[capability.defaultEncoding],
  })]),
));

export const OUTPUT_FORMATS = Object.freeze(Object.keys(FORMAT_CONTRACTS));

/**
 * Validates an `OutputRequest` against the closed per-format contract and
 * returns the complete request with documented defaults filled in.
 *
 * `format` is always required. `colorEncoding`, `bitDepth`, `alphaMode`,
 * `toneMap`, `gamutMap`, and `targetPeakLuminance` default to the format's
 * documented standard-dynamic-range sRGB (or BT.709, or linear Rec. 2020)
 * contract; a wide-gamut or high-dynamic-range output always requires the
 * caller to name it.
 *
 * Pass `renderPrecision` when the render context is known: the
 * `rgba8unorm` speed mode rejects wide-gamut and high-dynamic-range
 * requests here, before any encoder runs.
 */
export function validateOutputRequest(request, { renderPrecision } = {}) {
  if (request === null || typeof request !== "object") {
    throw new Error("OutputRequest must be an object");
  }
  const contract = FORMAT_CONTRACTS[request.format];
  if (!contract) {
    throw new Error(
      `OutputRequest: unknown format ${JSON.stringify(request.format)}; ` +
        `supported formats are ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  const colorEncoding = request.colorEncoding ?? contract.defaultEncoding;
  validateColorEncoding(colorEncoding);
  const pair = [colorEncoding.primaries, colorEncoding.transferFunction];
  if (
    !contract.encodings.some(([p, t]) => p === pair[0] && t === pair[1])
  ) {
    throw new Error(
      `OutputRequest: ${request.format} cannot represent the output encoding ` +
        `${pair[0]}/${pair[1]}`,
    );
  }
  const highDynamicRangeEncoding = pair[1] === "pq" || pair[1] === "hlg";
  const dynamicRange = request.dynamicRange ??
    (request.format === "jpeg-gain-map"
      ? "adaptive"
      : highDynamicRangeEncoding
      ? "high"
      : "standard");
  if (!["standard", "high", "adaptive"].includes(dynamicRange)) {
    throw new Error(
      `OutputRequest: dynamicRange must be "standard", "high", or "adaptive", got ${
        JSON.stringify(dynamicRange)
      }`,
    );
  }
  if ((dynamicRange === "adaptive") !== (request.format === "jpeg-gain-map")) {
    throw new Error(
      'OutputRequest: dynamicRange "adaptive" is available only for jpeg-gain-map',
    );
  }
  if (highDynamicRangeEncoding && dynamicRange !== "high") {
    throw new Error(
      `OutputRequest: the ${pair[1]} transfer function requires a high-dynamic-range request`,
    );
  }
  if (dynamicRange === "high" && !contract.highDynamicRange) {
    throw new Error(
      `OutputRequest: ${request.format} is an eight-bit-only encoder and cannot persist high dynamic range`,
    );
  }
  if (dynamicRange === "high" && !highDynamicRangeEncoding) {
    throw new Error(
      `OutputRequest: a high-dynamic-range request requires a pq or hlg output encoding, got ${
        pair[1]
      }`,
    );
  }
  const wideGamut = pair[0] !== "srgb";
  if (
    renderPrecision === "rgba8unorm" &&
    (wideGamut || dynamicRange === "high" || dynamicRange === "adaptive")
  ) {
    throw new Error(
      "OutputRequest: the rgba8unorm speed mode rejects wide-gamut, high-dynamic-range, and adaptive output",
    );
  }
  const bitDepth = request.bitDepth ?? contract.defaultBitDepth;
  if (!contract.bitDepths.includes(bitDepth)) {
    throw new Error(
      `OutputRequest: ${request.format} supports bit depths ${
        contract.bitDepths.join(", ")
      }, got ${JSON.stringify(bitDepth)}`,
    );
  }
  if (dynamicRange === "high" && bitDepth === 8) {
    throw new Error(
      "OutputRequest: a high-dynamic-range request cannot use eight-bit output",
    );
  }
  const alphaMode = request.alphaMode ?? contract.defaultAlphaMode;
  if (!contract.alphaModes.includes(alphaMode)) {
    throw new Error(
      `OutputRequest: ${request.format} supports ${contract.alphaModes.join(", ")} alpha, got ${
        JSON.stringify(alphaMode)
      }`,
    );
  }
  const toneMap = request.toneMap ??
    (dynamicRange === "high" ? "none" : "bt2390");
  if ((dynamicRange === "standard" || dynamicRange === "adaptive") && toneMap !== "bt2390") {
    throw new Error(
      `OutputRequest: a ${dynamicRange}-dynamic-range request selects the "bt2390" tone map`,
    );
  }
  if (dynamicRange === "high" && toneMap !== "none") {
    throw new Error(
      'OutputRequest: a high-dynamic-range request selects the "none" tone map',
    );
  }
  const gamutMap = request.gamutMap ?? "css-color-4";
  if (gamutMap !== "css-color-4") {
    throw new Error(
      `OutputRequest: gamutMap must be "css-color-4", got ${JSON.stringify(gamutMap)}`,
    );
  }
  const targetPeakLuminance = request.targetPeakLuminance ??
    (dynamicRange === "high" ? null : REFERENCE_WHITE_LUMINANCE);
  if (dynamicRange !== "high") {
    if (
      typeof targetPeakLuminance !== "number" ||
      !Number.isFinite(targetPeakLuminance) || targetPeakLuminance <= 0
    ) {
      throw new Error(
        `OutputRequest: a ${dynamicRange}-dynamic-range request supplies a positive targetPeakLuminance`,
      );
    }
  }
  const masteringDisplay = request.masteringDisplay ?? null;
  const masteringDisplayRequired = dynamicRange === "high" &&
    request.format !== "canvas";
  if (masteringDisplayRequired || masteringDisplay !== null) {
    if (
      masteringDisplay === null || typeof masteringDisplay !== "object" ||
      typeof masteringDisplay.maxLuminance !== "number" ||
      !Number.isFinite(masteringDisplay.maxLuminance) ||
      masteringDisplay.maxLuminance <= 0 ||
      typeof masteringDisplay.minLuminance !== "number" ||
      !Number.isFinite(masteringDisplay.minLuminance) ||
      masteringDisplay.minLuminance < 0
    ) {
      throw new Error(
        "OutputRequest: mastering metadata requires positive maxLuminance and nonnegative minLuminance",
      );
    }
  }
  const contentLightLevel = request.contentLightLevel ?? null;
  if (contentLightLevel !== null) {
    if (
      typeof contentLightLevel.maxContentLightLevel !== "number" ||
      typeof contentLightLevel.maxFrameAverageLightLevel !== "number"
    ) {
      throw new Error(
        "OutputRequest: contentLightLevel requires maxContentLightLevel and maxFrameAverageLightLevel",
      );
    }
  }
  const codecOptions = {
    ...(contract.defaultCodecOptions ?? {}),
    ...(request.codecOptions ?? {}),
  };
  for (const [key, value] of Object.entries(codecOptions)) {
    const check = contract.codecOptions[key];
    if (!check) {
      throw new Error(
        `OutputRequest: ${request.format} codec options accept only [${
          Object.keys(contract.codecOptions).join(", ")
        }], got "${key}"`,
      );
    }
    if (!check(value)) {
      throw new Error(
        `OutputRequest: invalid ${request.format} codec option ${key}=${
          JSON.stringify(value)
        }`,
      );
    }
  }
  // Format-specific exclusivity: JPEG XL lossless excludes distance.
  if (
    request.format === "jpeg-xl" && codecOptions.lossless === true &&
    codecOptions.distance !== undefined
  ) {
    throw new Error(
      "OutputRequest: jpeg-xl lossless excludes distance",
    );
  }
  return validateNativeOutputPolicy(Object.freeze({
    format: request.format,
    colorEncoding,
    dynamicRange,
    bitDepth,
    alphaMode,
    toneMap,
    gamutMap,
    targetPeakLuminance,
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
