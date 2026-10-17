import { readPackageAsset } from "../package-assets.js";
import createMozJpegModule from "../../vendor/jsquash-jpeg/mozjpeg_enc.js";
import { initEmscriptenModule } from "../../vendor/jsquash-jpeg/utils.js";

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
// absent }.
function encodingRequest(image, options) {
  if (image === null || typeof image !== "object") {
    throw new Error("JPEG encoder: image must be an object");
  }
  if (!Number.isInteger(image.width) || image.width <= 0 ||
    !Number.isInteger(image.height) || image.height <= 0) {
    throw new Error("JPEG encoder: width and height must be positive integers");
  }
  if (!(image.pixels instanceof Uint8Array || image.pixels instanceof Uint8ClampedArray) ||
    image.pixels.length !== image.width * image.height * 4) {
    throw new Error("JPEG encoder: pixels must be a tightly packed RGBA8 array");
  }
  if (options === null || typeof options !== "object" ||
    Object.keys(options).some((key) => key !== "quality" && key !== "profile")) {
    throw new Error("JPEG encoder: options accept only quality and profile");
  }
  const profile = options.profile;
  if (profile !== undefined && !(profile instanceof Uint8Array && profile.length > 0)) {
    throw new Error("JPEG encoder: profile must be a non-empty Uint8Array");
  }
  const quality = options.quality;
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new Error("JPEG encoder: quality must be an integer from 0 through 100");
  }
  return { image, profile, quality };
}

function encodeReady({ image, profile, quality }) {
  if (encoder === null) throw new Error("JPEG encoder: initializeJpegEncoder() must complete before synchronous encoding");
  const encoded = encoder.encode(image.pixels, image.width, image.height, {
    quality,
    baseline: true,
    progressive: false,
    arithmetic: false,
    optimize_coding: true,
    smoothing: 0,
    color_space: 3,
    quant_table: 3,
    trellis_multipass: false,
    trellis_opt_zero: false,
    trellis_opt_table: false,
    trellis_loops: 1,
    auto_subsample: true,
    chroma_subsample: 2,
    separate_chroma_quality: false,
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

// The largest ICC profile chunk of one APP2 segment: the segment length
// (16 bits, itself included) less its length field, the "ICC_PROFILE\0"
// identifier and the chunk number and count.
const ICC_CHUNK_CAPACITY = 0xffff - 2 - 12 - 2;
const ICC_IDENTIFIER = new TextEncoder().encode("ICC_PROFILE\0");

// `jpeg` with `profile` in APP2 segments (ICC.1, annex B.4) after its JFIF
// APP0 segment, as Chrome writes the JPEG of a display-p3 canvas.
function withIccProfile(jpeg, profile) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("JPEG encoder: the encoded image does not start with SOI");
  let insertAt = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) insertAt = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const count = Math.ceil(profile.length / ICC_CHUNK_CAPACITY);
  if (count > 255) throw new Error(`JPEG encoder: an ICC profile of ${profile.length} bytes needs more than 255 APP2 segments`);
  const segments = [];
  for (let index = 0; index < count; index++) {
    const chunk = profile.subarray(index * ICC_CHUNK_CAPACITY, (index + 1) * ICC_CHUNK_CAPACITY);
    const length = 2 + ICC_IDENTIFIER.length + 2 + chunk.length;
    const segment = new Uint8Array(2 + length);
    segment.set([0xff, 0xe2, length >> 8, length & 0xff]);
    segment.set(ICC_IDENTIFIER, 4);
    segment.set([index + 1, count], 4 + ICC_IDENTIFIER.length);
    segment.set(chunk, 4 + ICC_IDENTIFIER.length + 2);
    segments.push(segment);
  }
  const size = segments.reduce((total, segment) => total + segment.length, jpeg.length);
  const result = new Uint8Array(size);
  result.set(jpeg.subarray(0, insertAt));
  let at = insertAt;
  for (const segment of segments) {
    result.set(segment, at);
    at += segment.length;
  }
  result.set(jpeg.subarray(insertAt), at);
  return result;
}
