/**
 * JPEG XL codec - libjxl compiled to WebAssembly (vendor/jpeg-xl.wasm,
 * built by vendor/jpeg-xl-wasm/build.sh from the pinned libjxl v0.11.2).
 *
 * Decode: a single still image at its own native precision - uint8,
 * uint16, or float32 samples - as a working `ImageDescriptor` whose
 * color encoding is the stream's encoded (enum) profile when one exists
 * (sRGB, Display P3, Rec. 2100 PQ or HLG, linear, or a pure gamma
 * curve), else the DATA-target ICC profile bytes. Animation and extra
 * channels beyond one alpha channel are rejected with precise errors;
 * the animation error names the frame count.
 *
 * Sequence decode: `decodeJXLSequence` returns one discriminated record -
 * `kind: "still"` with the image, or `kind: "animated"` with every frame,
 * its duration, rectangle, blend mode, and disposal, plus the sequence
 * timebase and repetition count. A caller can never mistake an
 * animation's first frame for the whole image.
 *
 * Container walk: `decodeJXLBoxes` returns the container's boxes and the
 * payloads of its metadata boxes WITHOUT decoding a frame, so embedded
 * metadata is readable from the container alone.
 *
 * Encode: `encodeJXL` takes interleaved RGBA samples plus the validated
 * output request contract fields and returns the codestream bytes. The
 * central output transform (src/output/image.js) owns request
 * validation and color conversion; this module only drives the codec.
 * `encodeJXLAnimation` takes one frame sequence plus the closed animation
 * record (`@sandom/jpeg-xl` plans/PLAN-jpeg-xl-animation-output.md) and returns one
 * animated container with the timing it selected.
 */

import { isJXL } from './jpeg-xl-signature.js';
import { validateImageDescriptor } from './image-data.js';
import { readPackageAsset } from './package-assets.js';
import { transformImageForOutput } from './output/color-transform.js';
import { packSignal, packHalf, unpackHalf } from './output/packing.js';

export function createJpegXlCodec({
  jpegXlBytes,
  getJpegXlBytes = null,
} = {}) {
let jxlInstance = null;

async function ensureJxl() {
  if (jxlInstance) return jxlInstance;
  const wasmBytes = getJpegXlBytes
    ? await getJpegXlBytes()
    : jpegXlBytes ??
      await readPackageAsset(new URL('../vendor/jpeg-xl.wasm', import.meta.url));
  // The module is a standalone-WASM reactor: the only imports are the C
  // runtime's minimal WASI surface (never exercised on the paths this
  // shim uses - no files, no stdio) plus emscripten's memory-growth
  // notification. Each stub throws so a silent dependency can never
  // creep in unnoticed.
  const wasiStub = (name) => () => {
    throw new Error(`jpeg-xl.wasm called unexpected WASI import ${name}`);
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: {
      proc_exit: wasiStub('proc_exit'),
      fd_close: wasiStub('fd_close'),
      fd_write: wasiStub('fd_write'),
      fd_seek: wasiStub('fd_seek'),
    },
  });
  instance.exports._initialize();
  jxlInstance = instance;
  return instance;
}

// JxlPrimaries / JxlTransferFunction / JxlWhitePoint enum values
// (lib/include/jxl/color_encoding.h, libjxl v0.11.2).
const JXL_PRIMARIES = { 1: 'srgb', 9: 'rec2020', 11: 'display-p3' };
const JXL_TRANSFERS = {
  1: 'rec2020', // BT.709 camera curve - the repository's "rec2020" family
  8: 'linear',
  13: 'srgb',
  16: 'pq',
  18: 'hlg',
};
const JXL_TRANSFER_GAMMA = 65535;
const JXL_WHITE_POINT_D65 = 1;

const DECODE_ERRORS = {
  '1': 'not a JPEG XL stream',
  '2': 'the codestream is corrupt or uses an unsupported feature',
  '5': 'the decoder ran out of memory',
};

const SAMPLE_KINDS = [
  { sampleType: 'uint8', arrayConstructor: Uint8Array, bytesPerSample: 1 },
  { sampleType: 'uint16', arrayConstructor: Uint16Array, bytesPerSample: 2 },
  { sampleType: 'float32', arrayConstructor: Float32Array, bytesPerSample: 4 },
];

// Builds the color record of the decoded stream: the encoded (enum)
// profile when the stream carries a supported one, else the DATA-target
// ICC profile bytes. Reads the module's memory, so it must run before
// the matching release call.
function readDecodedColor(e, label) {
  const iccSize = e.jxl_icc_size();
  const icc = iccSize > 0
    ? new Uint8Array(new Uint8Array(e.memory.buffer, e.jxl_icc_ptr(), iccSize))
    : null;
  const haveEncoded = e.jxl_have_encoded_profile() === 1;
  const encodedPrimaries = e.jxl_encoded_primaries();
  const encodedTransfer = e.jxl_encoded_transfer();
  const encodedWhitePoint = e.jxl_encoded_white_point();
  const encodedGamma = e.jxl_encoded_gamma();

  const base = {
    transferFunctionParameters: null,
    whitePoint: 'd65',
    referenceWhiteLuminance: 203,
    profile: null,
  };
  let colorEncoding = null;
  if (haveEncoded && encodedWhitePoint === JXL_WHITE_POINT_D65) {
    const primaries = JXL_PRIMARIES[encodedPrimaries];
    if (primaries !== undefined) {
      if (encodedTransfer === JXL_TRANSFER_GAMMA && encodedGamma > 0) {
        colorEncoding = {
          ...base,
          primaries,
          transferFunction: 'gamma',
          transferFunctionParameters: [1 / encodedGamma],
        };
      } else if (JXL_TRANSFERS[encodedTransfer] !== undefined) {
        colorEncoding = {
          ...base,
          primaries,
          transferFunction: JXL_TRANSFERS[encodedTransfer],
        };
      }
    }
  }
  if (colorEncoding === null) {
    if (icc === null) {
      throw new Error(
        `${label}: the stream carries neither a supported encoded color profile nor ICC profile bytes`,
      );
    }
    colorEncoding = {
      ...base,
      primaries: 'srgb',
      transferFunction: 'icc',
      profile: icc,
    };
  }
  return { colorEncoding, icc };
}

// One decoded frame as a working `ImageDescriptor`. Every frame of a
// sequence shares one color record and one ICC profile instance: a
// sequence carries exactly one color encoding.
function buildFrameDescriptor({
  width,
  height,
  kind,
  pixels,
  colorEncoding,
  icc,
  alphaPremultiplied,
}) {
  const metadata = { orientation: 1 };
  if (icc !== null) metadata.iccProfile = icc;
  return validateImageDescriptor({
    width,
    height,
    rowStride: width * 4 * kind.bytesPerSample,
    pixels,
    channelLayout: 'rgba',
    sampleType: kind.sampleType,
    // libjxl scales integer output to the container's full range (a
    // 10-bit-coded image arrives as full-scale uint16), so the
    // descriptor's meaningful precision is the container width, never
    // the coded depth.
    bitsPerSample: kind.bytesPerSample * 8,
    colorEncoding,
    alphaMode: alphaPremultiplied ? 'premultiplied' : 'straight',
    metadata,
  });
}

/**
 * Decodes JPEG XL bytes into a native-precision `ImageDescriptor`.
 */
async function decodeJXL(bytes) {
  const wasm = await ensureJxl();
  const e = wasm.exports;

  const inputPtr = e.jxl_alloc_input(bytes.length);
  new Uint8Array(e.memory.buffer, inputPtr, bytes.length).set(bytes);
  const status = e.jxl_decode(bytes.length);
  if (status === 3) {
    const frames = e.jxl_animation_frames();
    throw new Error(
      `decodeJXL: animated JPEG XL is not supported in a still-image decoder (the stream carries ${frames} frames)`,
    );
  }
  if (status === 4) {
    throw new Error(
      'decodeJXL: extra channels beyond one alpha channel are not supported',
    );
  }
  if (status !== 0) {
    throw new Error(
      `decodeJXL failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`,
    );
  }

  const width = e.jxl_width();
  const height = e.jxl_height();
  const kind = SAMPLE_KINDS[e.jxl_sample_kind()];
  const pixelBytes = e.jxl_pixels_size();
  // Copied out, not viewed in place: the returned pixels outlive
  // jxl_release, and a later call's allocation can grow (and detach)
  // this memory's backing buffer.
  const pixels = new kind.arrayConstructor(
    new kind.arrayConstructor(
      e.memory.buffer,
      e.jxl_pixels_ptr(),
      pixelBytes / kind.bytesPerSample,
    ),
  );
  const alphaPremultiplied = e.jxl_alpha_premultiplied() === 1;
  let color;
  try {
    color = readDecodedColor(e, 'decodeJXL');
  } finally {
    e.jxl_release();
  }

  return buildFrameDescriptor({
    width,
    height,
    kind,
    pixels,
    alphaPremultiplied,
    ...color,
  });
}

// JxlBlendMode enum values (lib/include/jxl/codestream_header.h).
const JXL_BLEND_MODES = ['replace', 'add', 'blend', 'muladd', 'mul'];

const ticksToMilliseconds = (ticks, numerator, denominator) =>
  ticks * 1000 * denominator / numerator;

/**
 * Decodes JPEG XL bytes as one sequence, with an explicit discriminant
 * separating a still image from an animation.
 *
 * A still stream returns `{ kind: "still", image }` where `image` is
 * exactly what `decodeJXL` returns. An animated stream returns
 * `{ kind: "animated", ... }` with every frame - never only the first -
 * carrying its duration in ticks and milliseconds, its presentation
 * time, its frame rectangle, its blend mode, its reference disposition,
 * and its decoded `ImageDescriptor`, beside the sequence's timebase and
 * repetition count.
 */
async function decodeJXLSequence(bytes) {
  const wasm = await ensureJxl();
  const e = wasm.exports;

  const inputPtr = e.jxl_alloc_input(bytes.length);
  new Uint8Array(e.memory.buffer, inputPtr, bytes.length).set(bytes);
  const status = e.jxl_decode_animation(bytes.length);
  if (status === 6) return { kind: 'still', image: await decodeJXL(bytes) };
  if (status === 4) {
    throw new Error(
      'decodeJXLSequence: extra channels beyond one alpha channel are not supported',
    );
  }
  if (status !== 0) {
    throw new Error(
      `decodeJXLSequence failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`,
    );
  }

  const width = e.jxl_width();
  const height = e.jxl_height();
  const kind = SAMPLE_KINDS[e.jxl_sample_kind()];
  const frameCount = e.jxl_anim_frame_count();
  const numerator = e.jxl_anim_tps_numerator();
  const denominator = e.jxl_anim_tps_denominator();
  const loops = e.jxl_anim_num_loops();
  const alphaPremultiplied = e.jxl_alpha_premultiplied() === 1;
  const frameSamples = width * height * 4;
  const stride = e.jxl_anim_meta_words();
  const frames = [];
  try {
    const color = readDecodedColor(e, 'decodeJXLSequence');
    // Copied out before any descriptor is built: the pixel and metadata
    // allocations are released at the end of this call.
    const meta = new Uint32Array(
      new Uint32Array(
        e.memory.buffer,
        e.jxl_anim_meta_ptr(),
        frameCount * stride,
      ),
    );
    const signedMeta = new Int32Array(meta.buffer);
    const pixelsPtr = e.jxl_anim_pixels_ptr();
    let presentationTicks = 0;
    for (let index = 0; index < frameCount; index++) {
      const word = index * stride;
      const durationTicks = meta[word];
      const pixels = new kind.arrayConstructor(
        new kind.arrayConstructor(
          e.memory.buffer,
          pixelsPtr + index * frameSamples * kind.bytesPerSample,
          frameSamples,
        ),
      );
      frames.push({
        index,
        durationTicks,
        durationMilliseconds: ticksToMilliseconds(durationTicks, numerator, denominator),
        presentationTimeMilliseconds: ticksToMilliseconds(presentationTicks, numerator, denominator),
        rectangle: {
          x: signedMeta[word + 1],
          y: signedMeta[word + 2],
          width: meta[word + 3],
          height: meta[word + 4],
        },
        blendMode: JXL_BLEND_MODES[meta[word + 5]] ?? `unknown-${meta[word + 5]}`,
        blendSource: meta[word + 6],
        saveAsReference: meta[word + 7],
        descriptor: buildFrameDescriptor({
          width,
          height,
          kind,
          pixels,
          alphaPremultiplied,
          ...color,
        }),
      });
      presentationTicks += durationTicks;
    }
  } finally {
    e.jxl_release_animation();
  }

  return {
    kind: 'animated',
    width,
    height,
    frameCount,
    // Ticks per second as the codestream carries it: one rational for
    // the complete sequence.
    timebase: { numerator, denominator },
    // A zero loop count means "repeat without a limit" in the
    // codestream; the two cases stay distinct here.
    repetitionCount: loops === 0 ? 'infinite' : loops,
    durationMilliseconds: frames.reduce(
      (total, frame) => total + frame.durationMilliseconds,
      0,
    ),
    frames,
  };
}

/**
 * Walks a JPEG XL container and returns its boxes WITHOUT decoding any
 * frame: embedded metadata is a container fact, so a consumer reads it
 * by walking the container alone.
 *
 * Every box reports its four-character type and its raw size in the
 * file. A metadata box also reports its payload, decompressed when the
 * container stored it as a Brotli `brob` box. A codestream box (`jxlc`,
 * `jxlp`) reports a null payload: its contents are the frame data, and
 * they are never even copied. A bare codestream carries no boxes and
 * returns an empty list. A container that ends mid-box is one precise
 * error, not a partial list.
 */
async function decodeJXLBoxes(bytes) {
  const wasm = await ensureJxl();
  const e = wasm.exports;

  const inputPtr = e.jxl_alloc_input(bytes.length);
  new Uint8Array(e.memory.buffer, inputPtr, bytes.length).set(bytes);
  const status = e.jxl_walk_boxes(bytes.length);
  if (status !== 0) {
    throw new Error(
      `decodeJXLBoxes failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`,
    );
  }

  const boxes = [];
  try {
    const count = e.jxl_box_count();
    for (let index = 0; index < count; index++) {
      const payloadPtr = e.jxl_box_payload_ptr(index);
      const payloadSize = e.jxl_box_payload_size(index);
      boxes.push({
        type: String.fromCharCode(
          ...new Uint8Array(e.memory.buffer, e.jxl_box_type_ptr(index), 4),
        ),
        rawSize: e.jxl_box_raw_size(index),
        payload: payloadPtr === 0
          ? null
          : new Uint8Array(
            new Uint8Array(e.memory.buffer, payloadPtr, payloadSize),
          ),
      });
    }
  } finally {
    e.jxl_release_boxes();
  }
  return boxes;
}

// Color-space enum shared with the shim (vendor/jpeg-xl-wasm/src/jxl_shim.c).
const ENCODE_COLOR_SPACES = {
  'srgb/srgb': 0,
  'display-p3/srgb': 1,
  'rec2020/pq': 2,
  'rec2020/hlg': 3,
};

function resolveEncodeColorSpace(colorEncoding, label) {
  const key = `${colorEncoding.primaries}/${colorEncoding.transferFunction}`;
  const colorSpace = ENCODE_COLOR_SPACES[key];
  if (colorSpace === undefined) {
    throw new Error(`${label}: unsupported color encoding ${key}`);
  }
  return colorSpace;
}

function resolveEncodeDepth(bitDepth) {
  return bitDepth === 'float16'
    ? { bits: 16, exponentBits: 5 }
    : bitDepth === 'float32'
    ? { bits: 32, exponentBits: 8 }
    : { bits: bitDepth, exponentBits: 0 };
}

// The codec's input samples MUST match the declared depth class for
// lossless coding: integer declarations take integer samples scaled
// to the declared range, float declarations take float samples. A
// float32 signal buffer (the central transform's output) converts
// here - directly to the declared depth, never through eight bits.
function prepareEncodeSamples(samples, depth) {
  let input = samples;
  let sampleKind = samples instanceof Float32Array
    ? 2
    : samples instanceof Uint16Array
    ? 1
    : 0;
  if (depth.exponentBits === 0 && samples instanceof Float32Array) {
    const packed = packSignal(samples, depth.bits);
    input = depth.bits === 8 ? packed : new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
    sampleKind = depth.bits === 8 ? 0 : 1;
  }
  if (depth.exponentBits === 5 && samples instanceof Float32Array) {
    // A float16 declaration stores binary16 samples: round the float32
    // input to binary16 precision first, so lossless coding is
    // well-defined (libjxl rejects float16-lossless input it cannot
    // represent exactly).
    input = unpackHalf(packHalf(samples));
  }
  return { input, sampleKind };
}

/**
 * Encodes interleaved RGBA samples as a JPEG XL codestream.
 *
 * `samples` is a Uint8Array, Uint16Array, or Float32Array of
 * width * height * 4 interleaved RGBA values already in the requested
 * signal encoding. `colorEncoding` names one of the supported
 * primaries/transfer pairs. `bitDepth` is the DECLARED image depth -
 * 8, 10, 12, or 16 integer bits, or "float16"/"float32" - independent
 * of the input sample type (the codec quantizes float input to an
 * integer declaration). `lossless` selects modular lossless coding;
 * otherwise `distance` is the Butteraugli distance (default 1).
 */
async function encodeJXL(samples, width, height, {
  colorEncoding,
  bitDepth = 8,
  lossless = false,
  distance = 1,
  effort = 7,
}) {
  const colorSpace = resolveEncodeColorSpace(colorEncoding, 'encodeJXL');
  const depth = resolveEncodeDepth(bitDepth);
  const { input, sampleKind } = prepareEncodeSamples(samples, depth);
  const wasm = await ensureJxl();
  const e = wasm.exports;
  const inputPtr = e.jxl_alloc_input(input.byteLength);
  new Uint8Array(e.memory.buffer, inputPtr, input.byteLength).set(
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  );
  const status = e.jxl_encode(
    width,
    height,
    sampleKind,
    depth.bits,
    depth.exponentBits,
    colorSpace,
    lossless ? 1 : 0,
    Math.round(distance * 1000),
    effort,
  );
  if (status !== 0) {
    throw new Error(
      `encodeJXL failed (${status}): ${status === 5 ? 'the encoder ran out of memory' : 'encoder error'}`,
    );
  }
  const output = new Uint8Array(
    new Uint8Array(e.memory.buffer, e.jxl_output_ptr(), e.jxl_output_size()),
  );
  e.jxl_release_output();
  return output;
}

// Animation timing (`@sandom/jpeg-xl` plans/PLAN-jpeg-xl-animation-output.md, timing
// model). One integer timebase carries the complete sequence. The
// candidates are the millisecond grid and its decimal refinements down
// to one microsecond; the codestream's own bound on the tick rate is
// 2^30 ticks per second.
const JXL_AUTO_TIMEBASES = [1000, 10000, 100000, 1000000];
const JXL_MAX_TICKS_PER_SECOND = 1 << 30;
const JXL_MAX_DURATION_TICKS = 0xFFFFFFFF;
// The documented cumulative error limit: the coded presentation time of
// every frame boundary stays within half a millisecond of the requested
// presentation time.
const JXL_TIMEBASE_ERROR_LIMIT_MS = 0.5;

// Binary floating point cannot hold most decimal millisecond counts
// exactly, so "lands on a tick" is a relative comparison, not ===.
function isIntegerTicks(value) {
  return Math.abs(value - Math.round(value)) <=
    1e-9 * Math.max(1, Math.abs(value));
}

// Converts one millisecond schedule into integer tick counts at a fixed
// tick rate. Rounds the CUMULATIVE presentation time rather than each
// duration, so the coded timeline never drifts more than half a tick
// from the requested timeline however long the sequence runs. A frame
// that rounds to zero ticks is a rejection: an animation frame with a
// zero duration is not displayed on its own, so coding one would drop
// the frame silently.
function scheduleTicks(frameDurations, ticksPerSecond) {
  const ticks = new Array(frameDurations.length);
  let cumulativeMilliseconds = 0;
  let codedTicks = 0;
  let exact = true;
  let worstErrorMilliseconds = 0;
  for (let index = 0; index < frameDurations.length; index++) {
    cumulativeMilliseconds += frameDurations[index];
    const exactTicks = cumulativeMilliseconds * ticksPerSecond / 1000;
    const frameTicks = Math.round(exactTicks) - codedTicks;
    if (!isIntegerTicks(exactTicks)) exact = false;
    if (frameTicks < 1) {
      return {
        rejection:
          `frame ${index} lasts ${frameDurations[index]} ms, which rounds to zero ticks at ${ticksPerSecond} ticks per second`,
      };
    }
    if (frameTicks > JXL_MAX_DURATION_TICKS) {
      return {
        rejection:
          `frame ${index} lasts ${frameDurations[index]} ms, which overflows the 32-bit tick field at ${ticksPerSecond} ticks per second`,
      };
    }
    codedTicks += frameTicks;
    ticks[index] = frameTicks;
    const errorMilliseconds = Math.abs(codedTicks - exactTicks) * 1000 /
      ticksPerSecond;
    if (errorMilliseconds > worstErrorMilliseconds) {
      worstErrorMilliseconds = errorMilliseconds;
    }
  }
  return {
    ticksPerSecond,
    ticks,
    exact,
    worstErrorMilliseconds,
    rejection: null,
  };
}

// Selects the coarsest candidate tick rate that represents every
// mandatory boundary exactly; failing that, the candidate with the
// smallest boundary error, checked against the documented limit. An
// explicit tick rate is used as given and checked the same way.
function resolveAnimationTiming(frameDurations, timebase) {
  if (!Array.isArray(frameDurations) || frameDurations.length === 0) {
    throw new Error(
      'encodeJXLAnimation: frameDurations must be a non-empty array of millisecond durations',
    );
  }
  for (const duration of frameDurations) {
    if (
      typeof duration !== 'number' || !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error(
        `encodeJXLAnimation: every frame duration must be a positive finite millisecond count, got ${JSON.stringify(duration)}`,
      );
    }
  }
  if (timebase !== 'auto') {
    if (
      !Number.isInteger(timebase) || timebase < 1 ||
      timebase > JXL_MAX_TICKS_PER_SECOND
    ) {
      throw new Error(
        `encodeJXLAnimation: timebase must be "auto" or an integer tick rate in 1..${JXL_MAX_TICKS_PER_SECOND}, got ${JSON.stringify(timebase)}`,
      );
    }
    const schedule = scheduleTicks(frameDurations, timebase);
    if (schedule.rejection !== null) {
      throw new Error(`encodeJXLAnimation: ${schedule.rejection}`);
    }
    if (schedule.worstErrorMilliseconds > JXL_TIMEBASE_ERROR_LIMIT_MS) {
      throw new Error(
        `encodeJXLAnimation: timebase ${timebase} drifts ${schedule.worstErrorMilliseconds} ms from the requested schedule, past the ${JXL_TIMEBASE_ERROR_LIMIT_MS} ms limit`,
      );
    }
    return schedule;
  }
  let best = null;
  let rejection = null;
  for (const candidate of JXL_AUTO_TIMEBASES) {
    const schedule = scheduleTicks(frameDurations, candidate);
    if (schedule.rejection !== null) {
      rejection = schedule.rejection;
      continue;
    }
    if (schedule.exact) return schedule;
    if (
      best === null ||
      schedule.worstErrorMilliseconds < best.worstErrorMilliseconds
    ) {
      best = schedule;
    }
  }
  if (best === null) {
    throw new Error(
      `encodeJXLAnimation: no timebase in ${JXL_AUTO_TIMEBASES.join(', ')} ticks per second can carry this schedule: ${rejection}`,
    );
  }
  if (best.worstErrorMilliseconds > JXL_TIMEBASE_ERROR_LIMIT_MS) {
    throw new Error(
      `encodeJXLAnimation: the closest timebase (${best.ticksPerSecond} ticks per second) drifts ${best.worstErrorMilliseconds} ms from the requested schedule, past the ${JXL_TIMEBASE_ERROR_LIMIT_MS} ms limit`,
    );
  }
  return best;
}

// A zero loop count means "repeat without a limit" in the codestream.
// The field has no default: a finite non-returning animation must not
// gain an implicit loop from a defaulted request.
function resolveRepetition(repetitionCount) {
  if (repetitionCount === 'infinite') return 0;
  if (
    Number.isInteger(repetitionCount) && repetitionCount >= 1 &&
    repetitionCount <= JXL_MAX_DURATION_TICKS
  ) {
    return repetitionCount;
  }
  throw new Error(
    `encodeJXLAnimation: repetitionCount must be "infinite" or a positive integer play count, got ${JSON.stringify(repetitionCount)}`,
  );
}

// The closed metadata-box type set (`@sandom/jpeg-xl` plans/PLAN-jpeg-xl-animation-output.md).
// "Exif", "xml ", and "jumb" are the container format's own metadata
// types; "sdrr" carries Sandom's typed render receipt. Closing the set
// keeps Sandom out of the jxl-prefixed types the format reserves and out
// of unregistered application types.
const JXL_METADATA_BOX_TYPES = ['Exif', 'xml ', 'jumb', 'sdrr'];
const JXL_METADATA_BOX_KEYS = ['type', 'payload', 'compressed'];

function validateMetadataBoxes(metadataBoxes) {
  if (!Array.isArray(metadataBoxes)) {
    throw new Error(
      'encodeJXLAnimation: metadataBoxes must be an array of box records',
    );
  }
  return metadataBoxes.map((box, index) => {
    if (box === null || typeof box !== 'object') {
      throw new Error(
        `encodeJXLAnimation: metadata box ${index} must be an object`,
      );
    }
    for (const key of Object.keys(box)) {
      if (!JXL_METADATA_BOX_KEYS.includes(key)) {
        throw new Error(
          `encodeJXLAnimation: metadata box ${index} accepts only [${JXL_METADATA_BOX_KEYS.join(', ')}], got "${key}"`,
        );
      }
    }
    if (!JXL_METADATA_BOX_TYPES.includes(box.type)) {
      throw new Error(
        `encodeJXLAnimation: metadata box ${index} type ${JSON.stringify(box.type)} is outside the closed set ${JXL_METADATA_BOX_TYPES.map((type) => JSON.stringify(type)).join(', ')}`,
      );
    }
    if (!(box.payload instanceof Uint8Array) || box.payload.length === 0) {
      throw new Error(
        `encodeJXLAnimation: metadata box ${index} requires a non-empty Uint8Array payload`,
      );
    }
    const compressed = box.compressed ?? false;
    if (typeof compressed !== 'boolean') {
      throw new Error(
        `encodeJXLAnimation: metadata box ${index} compressed must be a boolean`,
      );
    }
    return { type: box.type, payload: box.payload, compressed };
  });
}

const SESSION_ERRORS = {
  '5': 'the encoder ran out of memory',
  '6': 'the encode session was driven out of order',
  '7': 'a frame of an animated sequence carries a zero duration',
};

function sessionError(operation, status) {
  const reason = SESSION_ERRORS[String(status)] ??
    (status >= 100 ? `libjxl encoder error ${status - 100}` : 'encoder error');
  return new Error(`encodeJXLAnimation: ${operation} failed (${status}): ${reason}`);
}

/**
 * Encodes one frame sequence as a single animated JPEG XL container.
 *
 * `frames` holds one interleaved RGBA sample buffer per frame, every
 * buffer the same length and the same array type. `frameDurations` holds
 * one positive millisecond duration per frame. `repetitionCount` is
 * "infinite" or a positive integer play count and has no default.
 * `timebase` is "auto" (select the coarsest tick rate that carries the
 * schedule exactly) or an explicit integer tick rate. `metadataBoxes`
 * holds the closed metadata-box records; every box is written before the
 * codestream, so a consumer reads them by walking the container alone.
 *
 * Returns the encoded bytes beside the timing the encoder committed to:
 * the selected timebase, the coded tick count of every frame, and the
 * worst cumulative boundary error the selection accepted.
 */
async function encodeJXLAnimation({
  frames,
  width,
  height,
  frameDurations,
  repetitionCount,
  timebase = 'auto',
  colorEncoding,
  bitDepth = 8,
  lossless = false,
  distance = 1,
  effort = 7,
  metadataBoxes = [],
}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('encodeJXLAnimation: frames must be a non-empty array of sample buffers');
  }
  if (frames.length !== frameDurations?.length) {
    throw new Error(
      `encodeJXLAnimation: ${frames.length} frames need ${frames.length} durations, got ${frameDurations?.length ?? 0}`,
    );
  }
  const colorSpace = resolveEncodeColorSpace(colorEncoding, 'encodeJXLAnimation');
  const depth = resolveEncodeDepth(bitDepth);
  const timing = resolveAnimationTiming(frameDurations, timebase);
  const loops = resolveRepetition(repetitionCount);
  const boxes = validateMetadataBoxes(metadataBoxes);

  // One sequence contract for every frame: same length, same sample
  // type. A frame that disagrees is rejected before the encoder opens.
  const expectedLength = width * height * 4;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index].length !== expectedLength) {
      throw new Error(
        `encodeJXLAnimation: frame ${index} carries ${frames[index].length} samples, the sequence contract is ${expectedLength}`,
      );
    }
    if (frames[index].constructor !== frames[0].constructor) {
      throw new Error(
        `encodeJXLAnimation: frame ${index} is a ${frames[index].constructor.name}, the sequence contract is ${frames[0].constructor.name}`,
      );
    }
  }
  const prepared = frames.map((samples) => prepareEncodeSamples(samples, depth));

  const wasm = await ensureJxl();
  const e = wasm.exports;
  let bytes;
  try {
    let status = e.jxl_encode_begin(
      width,
      height,
      prepared[0].sampleKind,
      depth.bits,
      depth.exponentBits,
      colorSpace,
      lossless ? 1 : 0,
      Math.round(distance * 1000),
      effort,
      timing.ticksPerSecond,
      1,
      loops,
      boxes.length > 0 ? 1 : 0,
    );
    if (status !== 0) throw sessionError('opening the sequence', status);
    // Boxes first: libjxl writes frames and boxes in the one order they
    // were queued, so adding every box before the first frame puts them
    // ahead of the codestream.
    for (const box of boxes) {
      const total = 4 + box.payload.length;
      const boxPtr = e.jxl_alloc_input(total);
      const staging = new Uint8Array(e.memory.buffer, boxPtr, total);
      for (let character = 0; character < 4; character++) {
        staging[character] = box.type.charCodeAt(character);
      }
      staging.set(box.payload, 4);
      status = e.jxl_encode_add_box(box.payload.length, box.compressed ? 1 : 0);
      if (status !== 0) throw sessionError(`adding the ${box.type} box`, status);
    }
    for (let index = 0; index < prepared.length; index++) {
      const { input } = prepared[index];
      const framePtr = e.jxl_alloc_input(input.byteLength);
      new Uint8Array(e.memory.buffer, framePtr, input.byteLength).set(
        new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
      );
      status = e.jxl_encode_add_frame(timing.ticks[index]);
      if (status !== 0) throw sessionError(`adding frame ${index}`, status);
    }
    status = e.jxl_encode_finish();
    if (status !== 0) throw sessionError('finishing the sequence', status);
    bytes = new Uint8Array(
      new Uint8Array(e.memory.buffer, e.jxl_output_ptr(), e.jxl_output_size()),
    );
    e.jxl_release_output();
  } finally {
    // A failed session call already released its native state; this
    // covers a throw between calls and is a no-op after a finish.
    e.jxl_encode_abort();
  }

  return {
    bytes,
    frameCount: frames.length,
    timebase: timing.ticksPerSecond,
    frameTicks: timing.ticks,
    repetitionCount,
    exactTiming: timing.exact,
    cumulativeErrorMilliseconds: timing.worstErrorMilliseconds,
  };
}

/**
 * Output adapter (wide-color plan, slice 3): a working `ImageDescriptor`
 * through the central transform into a JPEG XL codestream, driven by a
 * VALIDATED `OutputRequest` with format "jpeg-xl" (src/output/image.js
 * owns the closed contract). The transform produces the signal-domain
 * float32 samples; the codec declares the requested bit depth and
 * quantizes internally, so no eight-bit intermediate ever exists.
 */
async function encodeJxlOutput(descriptor, request) {
  if (request?.format !== 'jpeg-xl') {
    throw new Error('encodeJxlOutput requires a validated OutputRequest with format "jpeg-xl"');
  }
  const { width, height } = descriptor;
  const { pixels: signal } = transformImageForOutput(descriptor, request);
  return await encodeJXL(signal, width, height, {
    colorEncoding: request.colorEncoding,
    bitDepth: request.bitDepth,
    lossless: request.codecOptions.lossless ?? false,
    distance: request.codecOptions.distance ?? 1,
  });
}

  return Object.freeze({
    decodeJXL,
    decodeJXLSequence,
    decodeJXLBoxes,
    encodeJXL,
    encodeJXLAnimation,
    encodeJxlOutput,
    isJXL,
    instanceIdentity() {
      return jxlInstance;
    },
  });
}

const defaultJpegXlCodec = createJpegXlCodec();

export const decodeJXL = (...arguments_) =>
  defaultJpegXlCodec.decodeJXL(...arguments_);
export const encodeJXL = (...arguments_) =>
  defaultJpegXlCodec.encodeJXL(...arguments_);
export const encodeJxlOutput = (...arguments_) =>
  defaultJpegXlCodec.encodeJxlOutput(...arguments_);
export const decodeJXLSequence = (...arguments_) =>
  defaultJpegXlCodec.decodeJXLSequence(...arguments_);
export const decodeJXLBoxes = (...arguments_) =>
  defaultJpegXlCodec.decodeJXLBoxes(...arguments_);
export const encodeJXLAnimation = (...arguments_) =>
  defaultJpegXlCodec.encodeJXLAnimation(...arguments_);
export { isJXL };
