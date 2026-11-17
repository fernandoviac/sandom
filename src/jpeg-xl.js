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
import * as jpegXlRulesBinary from './wasm/jpeg-xl-container-binary.js';
import { encodeHostValues } from './wasm/host-values.js';
import { moduleLayoutConstants } from './wasm/layout-table.js';

const rulesConstant = moduleLayoutConstants(jpegXlRulesBinary, 'jpeg-xl container');
const SAMPLE_UINT8 = rulesConstant('SAMPLE_UINT8');
const SAMPLE_UINT16 = rulesConstant('SAMPLE_UINT16');
const SAMPLE_FLOAT32 = rulesConstant('SAMPLE_FLOAT32');
const rulesConstants = (prefix, names) =>
  Object.freeze(Object.fromEntries(names.map((name) => [name, rulesConstant(`${prefix}${name}`)])));
// The rule outputs of jpeg-xl-container.wat, by WAT name.
const SETTINGS = rulesConstants('SETTINGS_', ['COLOR_SPACE', 'EXPONENT_BITS', 'BITS', 'ACTION', 'SAMPLE_KIND']);
const DECODED_COLOR = rulesConstants('DECODED_COLOR_', ['PRIMARIES', 'TRANSFER', 'PARAMETER', 'WHITE_POINT', 'PROFILE',
  'LUMINANCE']);
const SETTINGS_ACTION = rulesConstants('SETTINGS_ACTION_', ['PACK', 'HALF']);
const FRAME_META = rulesConstants('FRAME_META_', ['DURATION', 'X', 'Y', 'WIDTH', 'HEIGHT', 'BLEND_MODE', 'BLEND_SOURCE',
  'SAVE_AS_REFERENCE']);
const ANIMATION = rulesConstants('ANIMATION_', ['TICKS_PER_SECOND', 'EXACT', 'LOOPS', 'WORST_ERROR', 'BOX_COUNT', 'BOXES',
  'BOX_SIZE', 'BOX_TYPE', 'BOX_COMPRESSED']);
const BOX_TYPE_PIECE = rulesConstant('BOX_TYPE_PIECE');

// The JPEG XL rules module (core/build/jpeg-xl-container.wat): color
// encodings, status messages, blend mode names, encoding settings and the
// animation request.
const rules = jpegXlRulesBinary.instantiate({}).exports;
const ruleDecoder = new TextDecoder();
const ruleTexts = new Map();

// Calls rule `name` with host values `values` (or none) as its first two
// arguments; throws the module's error; returns its output bytes.
function callRules(name, values, ...rest) {
  const leading = [];
  if (values !== null) {
    const bytes = encodeHostValues(values, { compositeJson: false });
    const pointer = rules.input_buffer(bytes.length);
    new Uint8Array(rules.memory.buffer, pointer, bytes.length).set(bytes);
    leading.push(pointer, bytes.length);
  }
  const result = rules[name](...leading, ...rest);
  if (rules.error_length() !== 0) {
    throw new Error(ruleDecoder.decode(new Uint8Array(rules.memory.buffer, rules.error_address(), rules.error_length())));
  }
  return { result, output: new Uint8Array(rules.memory.buffer, rules.output_address(), rules.output_length()).slice() };
}

function ruleText(piece) {
  if (!ruleTexts.has(piece)) ruleTexts.set(piece, ruleDecoder.decode(callRules('jxl_text', null, piece).output));
  return ruleTexts.get(piece);
}

// Codec calls of jxl_check, and the operation name pieces of
// jxl_decoded_color.
const CALL = rulesConstants('JXL_CALL_', ['DECODE', 'DECODE_SEQUENCE', 'BOXES', 'ENCODE', 'SESSION_OPEN', 'SESSION_BOX',
  'SESSION_FRAME', 'SESSION_FINISH']);
const LABEL = rulesConstants('JXL_LABEL_', ['DECODE', 'DECODE_SEQUENCE']);

function checkStatus(call, status, detail = 0) {
  return callRules('jxl_check', null, call, status, detail).result;
}

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

const SAMPLE_KINDS = [
  { sampleType: 'uint8', arrayConstructor: Uint8Array, bytesPerSample: 1 },
  { sampleType: 'uint16', arrayConstructor: Uint16Array, bytesPerSample: 2 },
  { sampleType: 'float32', arrayConstructor: Float32Array, bytesPerSample: 4 },
];

// Builds the color record of the decoded stream, as the rules module
// selects it: the encoded (enum) profile when the stream carries a
// supported one, else the DATA-target ICC profile bytes. Reads the
// module's memory, so it must run before the matching release call.
function readDecodedColor(e, label) {
  const iccSize = e.jxl_icc_size();
  const icc = iccSize > 0
    ? new Uint8Array(new Uint8Array(e.memory.buffer, e.jxl_icc_ptr(), iccSize))
    : null;
  const { output } = callRules('jxl_decoded_color', null, label,
    e.jxl_have_encoded_profile(), e.jxl_encoded_primaries(), e.jxl_encoded_transfer(),
    e.jxl_encoded_white_point(), e.jxl_encoded_gamma(), icc === null ? 0 : 1);
  const view = new DataView(output.buffer);
  const parameter = view.getFloat64(DECODED_COLOR.PARAMETER, true);
  const colorEncoding = {
    transferFunctionParameters: Number.isNaN(parameter) ? null : [parameter],
    whitePoint: ruleText(view.getUint32(DECODED_COLOR.WHITE_POINT, true)),
    referenceWhiteLuminance: view.getFloat64(DECODED_COLOR.LUMINANCE, true),
    profile: view.getUint32(DECODED_COLOR.PROFILE, true) === 1 ? icc : null,
    primaries: ruleText(view.getUint32(DECODED_COLOR.PRIMARIES, true)),
    transferFunction: ruleText(view.getUint32(DECODED_COLOR.TRANSFER, true)),
  };
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
  checkStatus(CALL.DECODE, status, e.jxl_animation_frames());

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
    color = readDecodedColor(e, LABEL.DECODE);
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

// The name of a frame's JxlBlendMode.
function blendModeName(mode) {
  return ruleDecoder.decode(callRules('jxl_blend_mode', null, mode).output);
}

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
  if (checkStatus(CALL.DECODE_SEQUENCE, status) === 1) return { kind: 'still', image: await decodeJXL(bytes) };

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
  let durationMilliseconds = 0;
  try {
    const color = readDecodedColor(e, LABEL.DECODE_SEQUENCE);
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
    // The frames' times from their duration ticks (jxl_sequence_times).
    const durations = Array.from({ length: frameCount }, (_, index) => meta[index * stride + FRAME_META.DURATION]);
    const times = new Float64Array(
      callRules('jxl_sequence_times', [durations], numerator, denominator).output.buffer,
    );
    for (let index = 0; index < frameCount; index++) {
      const word = index * stride;
      const pixels = new kind.arrayConstructor(
        new kind.arrayConstructor(
          e.memory.buffer,
          pixelsPtr + index * frameSamples * kind.bytesPerSample,
          frameSamples,
        ),
      );
      frames.push({
        index,
        durationTicks: durations[index],
        durationMilliseconds: times[index * 2],
        presentationTimeMilliseconds: times[index * 2 + 1],
        rectangle: {
          x: signedMeta[word + FRAME_META.X],
          y: signedMeta[word + FRAME_META.Y],
          width: meta[word + FRAME_META.WIDTH],
          height: meta[word + FRAME_META.HEIGHT],
        },
        blendMode: blendModeName(meta[word + FRAME_META.BLEND_MODE]),
        blendSource: meta[word + FRAME_META.BLEND_SOURCE],
        saveAsReference: meta[word + FRAME_META.SAVE_AS_REFERENCE],
        descriptor: buildFrameDescriptor({
          width,
          height,
          kind,
          pixels,
          alphaPremultiplied,
          ...color,
        }),
      });
    }
    durationMilliseconds = times[frameCount * 2];
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
    // codestream (jxl_repetition_infinite); the two cases stay distinct
    // here.
    repetitionCount: rules.jxl_repetition_infinite(loops) === 1 ? 'infinite' : loops,
    durationMilliseconds,
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
  checkStatus(CALL.BOXES, status);

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

// The sample type a settings record reads: every array other than
// Float32Array and Uint16Array reads as uint8.
function sampleType(samples) {
  return samples instanceof Float32Array ? SAMPLE_FLOAT32 : samples instanceof Uint16Array ? SAMPLE_UINT16 : SAMPLE_UINT8;
}

// The encoding settings the rules module writes (jxl_encode_settings).
function readSettings(view) {
  return {
    colorSpace: view.getInt32(SETTINGS.COLOR_SPACE, true),
    exponentBits: view.getInt32(SETTINGS.EXPONENT_BITS, true),
    bits: view.getFloat64(SETTINGS.BITS, true),
    action: view.getInt32(SETTINGS.ACTION, true),
    sampleKind: view.getInt32(SETTINGS.SAMPLE_KIND, true),
  };
}

// The codec's input samples in the settings' depth class: float samples
// packed to the declared integer bits, rounded to binary16, or as given.
function prepareEncodeSamples(samples, settings) {
  if (settings.action === SETTINGS_ACTION.PACK) {
    const packed = packSignal(samples, settings.bits);
    return settings.sampleKind === SAMPLE_UINT8 ? packed : new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
  }
  if (settings.action === SETTINGS_ACTION.HALF) return unpackHalf(packHalf(samples));
  return samples;
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
  const { output: settingsBytes } = callRules('jxl_encode_settings',
    [colorEncoding.primaries, colorEncoding.transferFunction, bitDepth], sampleType(samples));
  const settings = readSettings(new DataView(settingsBytes.buffer));
  const input = prepareEncodeSamples(samples, settings);
  const wasm = await ensureJxl();
  const e = wasm.exports;
  const inputPtr = e.jxl_alloc_input(input.byteLength);
  new Uint8Array(e.memory.buffer, inputPtr, input.byteLength).set(
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  );
  const status = e.jxl_encode(
    width,
    height,
    settings.sampleKind,
    settings.bits,
    settings.exponentBits,
    settings.colorSpace,
    lossless ? 1 : 0,
    rules.jxl_distance_code(distance),
    effort,
  );
  checkStatus(CALL.ENCODE, status);
  const output = new Uint8Array(
    new Uint8Array(e.memory.buffer, e.jxl_output_ptr(), e.jxl_output_size()),
  );
  e.jxl_release_output();
  return output;
}

// A metadata box as the rules module reads it: an object's own fields
// with its payload replaced by whether it is a non-empty Uint8Array.
function boxFacts(box) {
  if (box === null || typeof box !== 'object' || Array.isArray(box)) return box;
  return Object.fromEntries(Object.keys(box).map((key) =>
    [key, key === 'payload' ? box.payload instanceof Uint8Array && box.payload.length > 0 : box[key]]));
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
  const { output } = callRules('jxl_animation_request', [
    Array.isArray(frames) ? frames.map((frame) => [frame.length, frame.constructor.name]) : null,
    frameDurations,
    frameDurations?.length,
    repetitionCount,
    timebase,
    colorEncoding.primaries,
    colorEncoding.transferFunction,
    bitDepth,
    Array.isArray(metadataBoxes) ? metadataBoxes.map(boxFacts) : metadataBoxes,
    width,
    height,
  ], Array.isArray(frames) && frames.length > 0 ? sampleType(frames[0]) : SAMPLE_UINT8);
  const view = new DataView(output.buffer);
  const settings = readSettings(view);
  const ticksPerSecond = view.getFloat64(ANIMATION.TICKS_PER_SECOND, true);
  const exactTiming = view.getInt32(ANIMATION.EXACT, true) === 1;
  const loops = view.getUint32(ANIMATION.LOOPS, true);
  const worstErrorMilliseconds = view.getFloat64(ANIMATION.WORST_ERROR, true);
  const boxCount = view.getUint32(ANIMATION.BOX_COUNT, true);
  const boxes = Array.from({ length: boxCount }, (_, index) => {
    const row = ANIMATION.BOXES + index * ANIMATION.BOX_SIZE;
    const typeIndex = view.getInt32(row + ANIMATION.BOX_TYPE, true);
    return {
      typeIndex,
      type: ruleText(BOX_TYPE_PIECE + typeIndex),
      payload: metadataBoxes[index].payload,
      compressed: view.getInt32(row + ANIMATION.BOX_COMPRESSED, true) === 1,
    };
  });
  const ticksAt = ANIMATION.BOXES + boxCount * ANIMATION.BOX_SIZE;
  const frameTicks = Array.from({ length: frames.length },
    (_, index) => view.getUint32(ticksAt + index * Uint32Array.BYTES_PER_ELEMENT, true));
  const prepared = frames.map((samples) => prepareEncodeSamples(samples, settings));

  const wasm = await ensureJxl();
  const e = wasm.exports;
  let bytes;
  try {
    let status = e.jxl_encode_begin(
      width,
      height,
      settings.sampleKind,
      settings.bits,
      settings.exponentBits,
      settings.colorSpace,
      lossless ? 1 : 0,
      rules.jxl_distance_code(distance),
      effort,
      ticksPerSecond,
      1,
      loops,
      boxes.length > 0 ? 1 : 0,
    );
    checkStatus(CALL.SESSION_OPEN, status);
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
      checkStatus(CALL.SESSION_BOX, status, box.typeIndex);
    }
    for (let index = 0; index < prepared.length; index++) {
      const input = prepared[index];
      const framePtr = e.jxl_alloc_input(input.byteLength);
      new Uint8Array(e.memory.buffer, framePtr, input.byteLength).set(
        new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
      );
      status = e.jxl_encode_add_frame(frameTicks[index]);
      checkStatus(CALL.SESSION_FRAME, status, index);
    }
    status = e.jxl_encode_finish();
    checkStatus(CALL.SESSION_FINISH, status);
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
    timebase: ticksPerSecond,
    frameTicks,
    repetitionCount,
    exactTiming,
    cumulativeErrorMilliseconds: worstErrorMilliseconds,
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
