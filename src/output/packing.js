// Generic sample packing through @sandom/color; core/engine/sample-packing.wat
// checks the arguments. Container framing stays local.
import { colorRuntime } from "../wasm/color-runtime.js";
import { instantiate } from "../wasm/sample-packing-binary.js";

const numberOrNaN = (value) => typeof value === "number" ? value : NaN;
let checks = null;

// Throws the RangeError of a nonzero check result (its message length).
function check(name, ...parameters) {
  checks ??= instantiate({}).exports;
  const length = checks[name](...parameters);
  if (length !== 0) {
    throw new RangeError(new TextDecoder().decode(new Uint8Array(checks.memory.buffer, checks.message_address(), length)));
  }
  return checks;
}

const SAMPLE_TYPES = Object.freeze({
  uint8: Uint8Array,
  uint16: Uint16Array,
  float16: Uint16Array,
  float32: Float32Array,
});

function dimensions(width, height) {
  check("dimensions_check", numberOrNaN(width), numberOrNaN(height));
}

function floatSamples(pixels) {
  if (!(pixels instanceof Float32Array)) throw new TypeError("color packing requires Float32Array samples");
}

function packedBuffer(source, byteLength, Constructor, operation, parameters) {
  const runtime = colorRuntime();
  let input = 0;
  let output = 0;
  try {
    input = runtime.copyIn(source);
    output = runtime.alloc(byteLength);
    runtime.check(runtime.exports[operation](input, ...parameters, output, byteLength));
    return runtime.copyOut(output, byteLength, Constructor);
  } finally {
    runtime.free(output);
    runtime.free(input);
  }
}

export function float32ToFloat16Bits(value) {
  return colorRuntime().exports.color_float_to_half(value);
}

export function float16BitsToFloat32(bits) {
  return colorRuntime().exports.color_half_to_float(bits);
}

export function packSignal(pixels, bits = 8, channels = 4) {
  floatSamples(pixels);
  const byteLength = check("signal_check", pixels.length, numberOrNaN(bits), numberOrNaN(channels)).packed_length();
  return packedBuffer(pixels, byteLength, Uint8Array, "color_pack_signal", [pixels.length, bits, channels]);
}

export function packHalf(pixels) {
  floatSamples(pixels);
  return packedBuffer(pixels, pixels.length * 2, Uint16Array, "color_pack_half", [pixels.length]);
}

export function unpackHalf(words) {
  if (!(words instanceof Uint16Array)) throw new TypeError("half unpacking requires Uint16Array words");
  return packedBuffer(words, words.length * 4, Float32Array, "color_unpack_half", [words.length]);
}

export function expandImageSamples(descriptor) {
  const { pixels, width, height, rowStride, sampleType, channelLayout } = descriptor;
  dimensions(width, height);
  const ArrayConstructor = SAMPLE_TYPES[sampleType];
  const runtime = colorRuntime();
  const sample = runtime.abi.enums.sample[sampleType];
  const layout = runtime.abi.enums.layout[channelLayout];
  if (!Object.hasOwn(SAMPLE_TYPES, sampleType) || sample === undefined || layout === undefined) {
    throw new RangeError("unknown color sample type or channel layout");
  }
  if (!(pixels instanceof ArrayConstructor)) throw new TypeError("color sample type does not match its typed array");
  check("row_stride_check", numberOrNaN(rowStride));
  return packedBuffer(pixels, width * height * 4 * ArrayConstructor.BYTES_PER_ELEMENT,
    ArrayConstructor, "color_expand_samples", [pixels.byteLength, width, height, rowStride, sample, layout]);
}

export function packBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("color byte packing requires Uint8Array");
  const runtime = colorRuntime();
  const byteLength = runtime.exports.color_packing_size(bytes.byteLength, 1, 1);
  check("bytes_check", byteLength, bytes.byteLength);
  return packedBuffer(bytes, byteLength, Uint8Array, "color_pack_image", [bytes.byteLength]);
}
