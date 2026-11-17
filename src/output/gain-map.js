import { REFERENCE_WHITE_LUMINANCE } from "../color.js";
import { validateImageDescriptor } from "../image-data.js";
import {
  GAIN_MAP_ERROR,
  generateWithWasm,
  measureGenerationWithWasm,
  measureWithWasm,
  METADATA,
  reconstructWithWasm,
} from "./gain-map-wasm.js";

export const DEFAULT_ADAPTIVE_CODEC_OPTIONS = Object.freeze({
  baseQuality: 90,
  gainMapQuality: 90,
  gainMapScale: 1,
  metadataCompatibility: "iso-and-ultra-hdr",
  mapGamma: 1,
  baseOffset: 1 / 64,
  alternateOffset: 1 / 64,
});

export const GAIN_MAP_CALCULATION_COLOR_ENCODING = Object.freeze({
  primaries: "rec2020",
  transferFunction: "linear",
  transferFunctionParameters: null,
  whitePoint: "d65",
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

const SRGB_OUTPUT_ENCODING = Object.freeze({
  primaries: "srgb",
  transferFunction: "srgb",
  transferFunctionParameters: null,
  whitePoint: "d65",
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

function positiveChannelOption(value) {
  const values = Array.isArray(value) ? value : [value];
  return (values.length === 1 || values.length === 3) && values.every((entry) =>
    typeof entry === "number" && Number.isFinite(entry) && entry > 0
  );
}

const adaptiveCodecOptionValidators = Object.freeze({
  baseQuality: (value) => Number.isInteger(value) && value >= 0 && value <= 100,
  gainMapQuality: (value) => Number.isInteger(value) && value >= 0 && value <= 100,
  gainMapScale: (value) => [1, 2, 4, 8].includes(value),
  metadataCompatibility: (value) => value === "iso-and-ultra-hdr",
  mapGamma: positiveChannelOption,
  baseOffset: positiveChannelOption,
  alternateOffset: positiveChannelOption,
});

export function validateAdaptiveCodecOptions(codecOptions = {}) {
  if (codecOptions === null || typeof codecOptions !== "object" || Array.isArray(codecOptions)) {
    throw new Error("adaptive JPEG codec options must be an object");
  }
  for (const [key, value] of Object.entries(codecOptions)) {
    const validate = adaptiveCodecOptionValidators[key];
    if (validate === undefined) {
      throw new Error(`adaptive JPEG codec options accept only [${Object.keys(adaptiveCodecOptionValidators).join(", ")}], got "${key}"`);
    }
    if (!validate(value)) throw new Error(`invalid adaptive JPEG codec option ${key}=${JSON.stringify(value)}`);
  }
  return Object.freeze({ ...DEFAULT_ADAPTIVE_CODEC_OPTIONS, ...codecOptions });
}

function threeValues(value, field) {
  const values = Array.isArray(value) ? value : [value, value, value];
  if (values.length !== 3 || values.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`gain map generator: ${field} must contain three finite values`);
  }
  return Object.freeze(values.map(Number));
}

function validateGeneratorInput(descriptor) {
  validateImageDescriptor(descriptor);
  if (descriptor.colorEncoding.primaries !== "rec2020" ||
    descriptor.colorEncoding.transferFunction !== "linear" ||
    descriptor.sampleType !== "float32" || descriptor.channelLayout !== "rgba") {
    throw new Error("gain map generator requires a float32 RGBA linear Rec. 2020 working image");
  }
  for (let pixelIndex = 0; pixelIndex < descriptor.width * descriptor.height; pixelIndex++) {
    const alpha = descriptor.pixels[pixelIndex * 4 + 3];
    if (alpha !== 1) {
      throw new Error(`gain map generator: JPEG compatibility output requires opaque input; alpha at pixel ${pixelIndex} is ${alpha}`);
    }
  }
}

export function generateAdaptiveImage(descriptor, request = {}) {
  validateGeneratorInput(descriptor);
  const options = validateAdaptiveCodecOptions(request.codecOptions);
  // The base rendition tone-maps only a declared mastering peak; content
  // without one is treated as reference-white SDR (identity), matching
  // transformImageForOutput. The headroom metadata still advertises the
  // default 4x boost so readers can apply the recovered gain.
  const masteringPeak = request.masteringDisplay?.maxLuminance;
  const sourcePeak = Math.max(REFERENCE_WHITE_LUMINANCE, masteringPeak ?? REFERENCE_WHITE_LUMINANCE);
  const boostPeak = Math.max(REFERENCE_WHITE_LUMINANCE, masteringPeak ?? 4 * REFERENCE_WHITE_LUMINANCE);
  const normalized = Object.freeze({
    ...options,
    mapGamma: threeValues(options.mapGamma, "mapGamma"),
    baseOffset: threeValues(options.baseOffset, "baseOffset"),
    alternateOffset: threeValues(options.alternateOffset, "alternateOffset"),
    maximumDisplayBoost: Math.max(1, boostPeak / REFERENCE_WHITE_LUMINANCE),
  });
  const generated = generateWithWasm(
    descriptor,
    normalized,
    sourcePeak,
    Object.freeze({ base: SRGB_OUTPUT_ENCODING, gain: GAIN_MAP_CALCULATION_COLOR_ENCODING }),
  );
  const minimumDisplayHeadroom = generated.metadata.minimumDisplayHeadroom;
  const maximumDisplayHeadroom = generated.metadata.maximumDisplayHeadroom;
  const verificationBoosts = generated.verificationBoosts;
  return Object.freeze({
    baseImage: generated.baseImage,
    alternateImage: generated.alternateImage,
    gainMapImage: generated.gainMapImage,
    baseColorEncoding: generated.baseImage.colorEncoding,
    alternateColorEncoding: descriptor.colorEncoding,
    gainMapMin: generated.metadata.gainMapMin,
    gainMapMax: generated.metadata.gainMapMax,
    gainMapGamma: generated.metadata.gainMapGamma,
    baseOffset: generated.metadata.baseOffset,
    alternateOffset: generated.metadata.alternateOffset,
    minimumDisplayHeadroom,
    maximumDisplayHeadroom,
    baseRenditionIsHighDynamicRange: false,
    generationOptions: Object.freeze({
      baseQuality: normalized.baseQuality,
      gainMapQuality: normalized.gainMapQuality,
      gainMapScale: normalized.gainMapScale,
      metadataCompatibility: normalized.metadataCompatibility,
      mapGamma: normalized.mapGamma,
      baseOffset: normalized.baseOffset,
      alternateOffset: normalized.alternateOffset,
      verificationBoosts,
    }),
    errorSummary: generated.errorSummary,
  });
}

export function reconstructAdaptiveImage({ baseImage, gainMapImage, metadata, displayBoost }) {
  validateImageDescriptor(baseImage);
  validateImageDescriptor(gainMapImage);
  if (!Number.isFinite(displayBoost) || displayBoost <= 0) {
    throw new Error("gain map reconstruction: displayBoost must be finite and positive");
  }
  return reconstructWithWasm(
    baseImage,
    gainMapImage,
    metadata,
    displayBoost,
    GAIN_MAP_CALCULATION_COLOR_ENCODING,
  );
}

export function measureAdaptiveImageError(referenceImage, reconstructedImage) {
  validateImageDescriptor(referenceImage);
  validateImageDescriptor(reconstructedImage);
  if (referenceImage.width !== reconstructedImage.width || referenceImage.height !== reconstructedImage.height) {
    throw new Error("gain map error measurement requires equal image dimensions");
  }
  return measureWithWasm(referenceImage, reconstructedImage);
}

export function adaptiveImageMetadata(record) {
  return Object.freeze({
    gainMapMin: record.gainMapMin,
    gainMapMax: record.gainMapMax,
    gainMapGamma: record.gainMapGamma,
    baseOffset: record.baseOffset,
    alternateOffset: record.alternateOffset,
    minimumDisplayHeadroom: record.minimumDisplayHeadroom,
    maximumDisplayHeadroom: record.maximumDisplayHeadroom,
    baseRenditionIsHighDynamicRange: record.baseRenditionIsHighDynamicRange,
  });
}

function equalColorEncoding(left, right) {
  return left !== null && right !== null &&
    left.primaries === right.primaries &&
    left.transferFunction === right.transferFunction &&
    left.whitePoint === right.whitePoint &&
    left.referenceWhiteLuminance === right.referenceWhiteLuminance &&
    left.profile === right.profile;
}

function adaptiveRecordError(error, metadata) {
  const code = error?.gainMapCode;
  const field = error?.gainMapField;
  const detail = `; ${error.message}`;
  const channelFields = [
    [METADATA.MIN, "gainMapMin", "finite"],
    [METADATA.MAX, "gainMapMax", "finite"],
    [METADATA.GAMMA, "gainMapGamma", "finite and greater than zero"],
    [METADATA.BASE, "baseOffset", "finite and greater than zero"],
    [METADATA.ALTERNATE, "alternateOffset", "finite and greater than zero"],
  ];
  if (code === GAIN_MAP_ERROR.NUMERIC) {
    for (const [offset, name, requirement] of channelFields) {
      const channel = (field - offset) / Float64Array.BYTES_PER_ELEMENT;
      if (Number.isInteger(channel) && channel >= 0 && channel < 3) {
        return new Error(
          `AdaptiveImageRecord: ${name}[${channel}] must be ${requirement}, got ${metadata[name][channel]}${detail}`,
        );
      }
    }
    if (field === METADATA.HEADROOM_MIN) {
      return new Error(`AdaptiveImageRecord: minimumDisplayHeadroom must be finite and nonnegative${detail}`);
    }
    if (field === METADATA.HEADROOM_MAX) {
      return new Error(`AdaptiveImageRecord: maximumDisplayHeadroom must be finite and nonnegative${detail}`);
    }
  }
  const maximumChannel = (field - METADATA.MAX) / Float64Array.BYTES_PER_ELEMENT;
  if (code === GAIN_MAP_ERROR.RECORD && Number.isInteger(maximumChannel) && maximumChannel >= 0 && maximumChannel < 3) {
    return new Error(
      `AdaptiveImageRecord: gainMapMax[${maximumChannel}] ${metadata.gainMapMax[maximumChannel]} is below gainMapMin[${maximumChannel}] ${metadata.gainMapMin[maximumChannel]}${detail}`,
    );
  }
  if (code === GAIN_MAP_ERROR.RECORD && field === METADATA.HEADROOM_MIN) {
    return new Error(
      `AdaptiveImageRecord: maximumDisplayHeadroom must exceed minimumDisplayHeadroom${detail}`,
    );
  }
  return error;
}


export function validateAdaptiveImageRecord(record) {
  if (record === null || typeof record !== "object") {
    throw new Error("AdaptiveImageRecord must be an object");
  }
  for (const field of ["baseImage", "alternateImage", "gainMapImage"]) {
    try {
      validateImageDescriptor(record[field]);
    } catch (error) {
      throw new Error(`AdaptiveImageRecord: invalid ${field}: ${error.message}`);
    }
  }
  if (!equalColorEncoding(record.baseImage.colorEncoding, record.baseColorEncoding)) {
    throw new Error("AdaptiveImageRecord: baseImage color encoding does not match baseColorEncoding");
  }
  if (!equalColorEncoding(record.alternateImage.colorEncoding, record.alternateColorEncoding)) {
    throw new Error("AdaptiveImageRecord: alternateImage color encoding does not match alternateColorEncoding");
  }
  if (record.baseImage.colorEncoding.primaries !== "srgb" ||
    record.baseImage.colorEncoding.transferFunction !== "srgb") {
    throw new Error("AdaptiveImageRecord: baseImage must use encoded sRGB");
  }
  if (record.alternateImage.colorEncoding.primaries !== "rec2020" ||
    record.alternateImage.colorEncoding.transferFunction !== "linear") {
    throw new Error("AdaptiveImageRecord: alternateImage must use linear Rec. 2020 calculation color");
  }
  if (record.gainMapImage.colorEncoding.primaries !== "rec2020" ||
    record.gainMapImage.colorEncoding.transferFunction !== "linear") {
    throw new Error("AdaptiveImageRecord: gainMapImage must use linear Rec. 2020 calculation color");
  }
  if (record.baseRenditionIsHighDynamicRange !== false) {
    throw new Error("AdaptiveImageRecord: JPEG compatibility output requires an SDR base rendition");
  }
  if (record.generationOptions === null || typeof record.generationOptions !== "object") {
    throw new Error("AdaptiveImageRecord: generationOptions must be an object");
  }
  if (record.errorSummary === null || typeof record.errorSummary !== "object") {
    throw new Error("AdaptiveImageRecord: errorSummary must be an object");
  }
  const metadata = adaptiveImageMetadata(record);
  try {
    measureGenerationWithWasm(
      record.baseImage,
      record.alternateImage,
      record.gainMapImage,
      metadata,
      2 ** metadata.minimumDisplayHeadroom,
    );
  } catch (error) {
    throw adaptiveRecordError(error, metadata);
  }
  return record;
}
