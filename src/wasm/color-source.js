// Host-memory source conversion through @sandom/color's standalone ABI.
import { STANDARD_WORKING_COLOR_ENCODING, WORKING_COLOR_ENCODING } from "../color.js";
import { colorRuntime } from "./color-runtime.js";

const ARRAYS = Object.freeze({ uint8: Uint8Array, uint16: Uint16Array, float16: Uint16Array, float32: Float32Array });

function enumValue(runtime, name, value) {
  const result = runtime.abi.enums[name][value];
  if (result === undefined) throw new RangeError(`color source: unknown ${name} ${value}`);
  return result;
}

function unsigned(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`color source ${field} must be an unsigned-32-bit integer`);
  }
  return value;
}

function prepare(descriptor, operation, bytesPerPixel, Constructor, renderMode = "standard", destinationPrimaries = null) {
  const { pixels, width, height, rowStride, sampleType, bitsPerSample, channelLayout, alphaMode, colorEncoding } = descriptor;
  if (!Object.hasOwn(ARRAYS, sampleType) || !(pixels instanceof ARRAYS[sampleType])) {
    throw new TypeError("color source sample type does not match its typed array");
  }
  unsigned(width, "width");
  unsigned(height, "height");
  unsigned(rowStride, "rowStride");
  unsigned(bitsPerSample, "bitsPerSample");
  const byteLength = width * height * bytesPerPixel;
  const runtime = colorRuntime();
  const source = runtime.abi.records.source;
  const sample = enumValue(runtime, "sample", sampleType);
  const layout = enumValue(runtime, "layout", channelLayout);
  const alpha = enumValue(runtime, "alpha", alphaMode);
  const transfer = enumValue(runtime, "transfer", colorEncoding.transferFunction);
  const primaries = enumValue(runtime, "primaries", colorEncoding.primaries);
  const mode = enumValue(runtime, "working", renderMode);
  let input = 0;
  let record = 0;
  let output = 0;
  try {
    input = runtime.copyIn(pixels);
    record = runtime.alloc(source.size);
    output = runtime.alloc(byteLength);
    const view = new DataView(runtime.memory.buffer, record, source.size);
    const fields = source.fields;
    view.setUint32(fields.src, input, true);
    view.setUint32(fields.length, pixels.byteLength, true);
    view.setUint32(fields.width, width, true);
    view.setUint32(fields.height, height, true);
    view.setUint32(fields.stride, rowStride, true);
    view.setUint32(fields.sample, sample, true);
    view.setUint32(fields.bits, bitsPerSample, true);
    view.setUint32(fields.layout, layout, true);
    view.setUint32(fields.alpha, alpha, true);
    view.setUint32(fields.transfer, transfer, true);
    view.setUint32(fields.primaries, primaries, true);
    view.setUint32(fields.mode, mode, true);
    view.setFloat64(fields.gamma, colorEncoding.transferFunction === "gamma" ? colorEncoding.transferFunctionParameters : 1, true);
    view.setFloat64(fields.referenceWhite, colorEncoding.referenceWhiteLuminance, true);
    const args = destinationPrimaries === null
      ? [record, output, byteLength]
      : [record, enumValue(runtime, "primaries", destinationPrimaries), output, byteLength];
    runtime.check(runtime.exports[operation](...args));
    return runtime.copyOut(output, byteLength, Constructor);
  } finally {
    runtime.free(output);
    runtime.free(record);
    runtime.free(input);
  }
}

export function degradedSrgbPixels(descriptor) {
  return prepare(descriptor, "color_source_degraded", 4, Uint8Array);
}

// Straight sRGB RGBA8 for an 8-bit display surface (color_source_srgb8).
export function srgb8Pixels(descriptor) {
  return prepare(descriptor, "color_source_srgb8", 4, Uint8Array);
}

// Gain-map base calculations require destination-linear Rec.2020 explicitly;
// the package no longer has a policy-bearing "base" operation.
export function baseCalculationPixelsNative(descriptor) {
  return prepare(descriptor, "color_source_linear", 24, Float64Array, "standard", "rec2020");
}

export function prepareSourceWorking(descriptor, renderMode) {
  const pixels = prepare(descriptor, "color_source_working", 16, Float32Array, renderMode);
  return {
    ...descriptor,
    pixels,
    rowStride: descriptor.width * 16,
    sampleType: "float32",
    bitsPerSample: 32,
    channelLayout: "rgba",
    alphaMode: "premultiplied",
    colorEncoding: renderMode === "high-dynamic-range" ? WORKING_COLOR_ENCODING : STANDARD_WORKING_COLOR_ENCODING,
  };
}
