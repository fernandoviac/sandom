import { readPackageAsset } from "../package-assets.js";
import createMozJpegModule from "../../vendor/jsquash-jpeg/mozjpeg_enc.js";
import { initEmscriptenModule } from "../../vendor/jsquash-jpeg/utils.js";
import * as jpegContainerBinary from "../wasm/jpeg-container-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";

const { instantiate } = jpegContainerBinary;

let container = null;
const encoder8 = new TextEncoder();
const numberOrNaN = (value) => typeof value === "number" ? value : NaN;
// The MozJPEG settings of every encode (MOZJPEG_* of the container module).
const containerConstant = moduleLayoutConstants(jpegContainerBinary, "jpeg container");
const MOZJPEG = Object.fromEntries(["BASELINE", "PROGRESSIVE", "ARITHMETIC", "OPTIMIZE_CODING", "SMOOTHING", "COLOR_SPACE",
  "QUANT_TABLE", "TRELLIS_MULTIPASS", "TRELLIS_OPT_ZERO", "TRELLIS_OPT_TABLE", "TRELLIS_LOOPS", "AUTO_SUBSAMPLE",
  "CHROMA_SUBSAMPLE", "SEPARATE_CHROMA_QUALITY"].map((name) => [name, containerConstant(`MOZJPEG_${name}`)]));

// The JPEG container module (core/engine/jpeg-container.wat).
function containerExports() {
  container ??= instantiate({}).exports;
  return container;
}

function containerInput(exports, bytes) {
  const pointer = exports.input_buffer(bytes.length);
  if (pointer === 0) throw new Error(`JPEG encoder: the container module could not grow its memory for ${bytes.length} bytes`);
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
}

// Throws the error of a nonzero container result (its message length).
function containerCheck(exports, length) {
  if (length < 0) throw new Error("JPEG encoder: the container module could not grow its memory");
  if (length > 0) {
    throw new Error(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.message_address(), length)));
  }
}

let encoderInitialization = null;
let encoder = null;

export async function initializeJpegEncoder() {
  if (encoderInitialization === null) {
    encoderInitialization = (async () => {
      const bytes = await readPackageAsset(
        new URL("../../vendor/jsquash-jpeg/mozjpeg_enc.wasm", import.meta.url),
      );
      const module = await WebAssembly.compile(bytes);
      encoder = await initEmscriptenModule(createMozJpegModule, module);
    })();
  }
  await encoderInitialization;
}

export const JPEG_ENCODER_OPTIONS = Object.freeze({
  quality: Object.freeze({ minimum: 0, maximum: 100 }),
});

// options: { quality: integer 0 to 100, profile: an ICC profile (Uint8Array)
// that APP2 "ICC_PROFILE" segments carry after the JFIF segment, or
// absent }. request_check of the container module applies the rules.
function encodingRequest(image, options) {
  if (image === null || typeof image !== "object") {
    throw new Error("JPEG encoder: image must be an object");
  }
  const exports = containerExports();
  const pixelBytes = image.pixels instanceof Uint8Array || image.pixels instanceof Uint8ClampedArray;
  const optionsRecord = options !== null && typeof options === "object";
  const keys = optionsRecord ? Object.keys(options) : [];
  const profile = optionsRecord ? options.profile : undefined;
  const quality = optionsRecord ? options.quality : undefined;
  containerInput(exports, encoder8.encode(keys.map((key) => `${key}\0`).join("")));
  containerCheck(exports, exports.request_check(
    numberOrNaN(image.width), numberOrNaN(image.height), pixelBytes ? 1 : 0, pixelBytes ? image.pixels.length : NaN,
    optionsRecord ? 1 : 0, keys.length, profile !== undefined ? 1 : 0, profile instanceof Uint8Array ? 1 : 0,
    profile instanceof Uint8Array ? profile.length : NaN, numberOrNaN(quality),
  ));
  return { image, profile, quality };
}

function encodeReady({ image, profile, quality }) {
  if (encoder === null) throw new Error("JPEG encoder: initializeJpegEncoder() must complete before synchronous encoding");
  const encoded = encoder.encode(image.pixels, image.width, image.height, {
    quality,
    baseline: MOZJPEG.BASELINE === 1,
    progressive: MOZJPEG.PROGRESSIVE === 1,
    arithmetic: MOZJPEG.ARITHMETIC === 1,
    optimize_coding: MOZJPEG.OPTIMIZE_CODING === 1,
    smoothing: MOZJPEG.SMOOTHING,
    color_space: MOZJPEG.COLOR_SPACE,
    quant_table: MOZJPEG.QUANT_TABLE,
    trellis_multipass: MOZJPEG.TRELLIS_MULTIPASS === 1,
    trellis_opt_zero: MOZJPEG.TRELLIS_OPT_ZERO === 1,
    trellis_opt_table: MOZJPEG.TRELLIS_OPT_TABLE === 1,
    trellis_loops: MOZJPEG.TRELLIS_LOOPS,
    auto_subsample: MOZJPEG.AUTO_SUBSAMPLE === 1,
    chroma_subsample: MOZJPEG.CHROMA_SUBSAMPLE,
    separate_chroma_quality: MOZJPEG.SEPARATE_CHROMA_QUALITY === 1,
    chroma_quality: quality,
  });
  return profile === undefined ? encoded : withIccProfile(encoded, profile);
}

export async function encodeJpegRgba(image, options) {
  const request = encodingRequest(image, options);
  await initializeJpegEncoder();
  return encodeReady(request);
}

export function encodeJpegRgbaWithCompletion(image, options, operation) {
  let bytes;
  try { bytes = encodeReady(encodingRequest(image, options)); }
  catch (error) { operation.throw(error); return; }
  operation.reply(bytes);
}

// `jpeg` with `profile` in APP2 segments (ICC.1, annex B.4) after its JFIF
// APP0 segment (icc_insert of the container module).
function withIccProfile(jpeg, profile) {
  const exports = containerExports();
  const input = new Uint8Array(jpeg.length + profile.length);
  input.set(jpeg);
  input.set(profile, jpeg.length);
  containerInput(exports, input);
  containerCheck(exports, exports.icc_insert(jpeg.length, profile.length));
  return new Uint8Array(exports.memory.buffer, exports.output_address(), exports.output_length()).slice();
}
