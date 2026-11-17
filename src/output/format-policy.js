// Codec/container capability policy belongs to Sandom, not @sandom/color.
// The output formats module (core/build/output-formats.wat) holds each
// format's contract and validates output requests; this binding calls it
// and reads its contracts into frozen records.
import * as outputFormatsBinary from "../wasm/output-formats-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";

const formats = outputFormatsBinary.instantiate({}).exports;
const formatsConstant = moduleLayoutConstants(outputFormatsBinary, "output formats");
const formatsConstants = (prefix, names) =>
  Object.freeze(Object.fromEntries(names.map((name) => [name, formatsConstant(`${prefix}${name}`)])));
// The contract and request check outputs of output-formats.watpart.
const CONTRACT = formatsConstants("FORMAT_CONTRACT_", ["NAME", "DEPTH_COUNT", "DEPTHS", "DEPTH_SIZE", "DEPTH_NUMBER",
  "DEPTH_PIECE", "ENCODING_COUNT", "ENCODINGS", "ENCODING_SIZE", "ENCODING_PRIMARIES", "ENCODING_TRANSFER",
  "ALPHA_COUNT", "ALPHAS", "ALPHA_SIZE", "MASTERING"]);
export const REQUEST_CHECK = formatsConstants("REQUEST_CHECK_", ["DYNAMIC_RANGE", "BIT_DEPTH", "BIT_DEPTH_PIECE",
  "ALPHA_MODE", "TONE_MAP", "GAMUT_MAP", "PEAK_SOURCE", "PEAK"]);
export const REQUEST_PEAK = formatsConstants("REQUEST_PEAK_", ["REQUEST", "NULL", "DEFAULT"]);
// The file encoders of output_encoder_request, and the Display P3 answer of
// output_png_profile.
export const ENCODER_FORMAT = formatsConstants("ENCODER_FORMAT_", ["PNG", "BMP", "PPM"]);
export const OUTPUT_PNG_DISPLAY_P3 = formatsConstant("OUTPUT_PNG_DISPLAY_P3");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const texts = new Map();

// Calls an export of the output formats module with `inputs` (byte arrays)
// copied into its input buffer, each passed as address and length after
// `leading`. Throws the module's Error; returns the call's output bytes.
export function callOutputFormats(name, leading, inputs) {
  const pointer = formats.input_buffer(inputs.reduce((sum, bytes) => sum + bytes.length, 0));
  const addresses = [];
  let at = pointer;
  for (const bytes of inputs) {
    new Uint8Array(formats.memory.buffer, at, bytes.length).set(bytes);
    addresses.push(at, bytes.length);
    at += bytes.length;
  }
  const result = formats[name](...leading, ...addresses);
  if (formats.error_length() !== 0) {
    throw new Error(decoder.decode(new Uint8Array(formats.memory.buffer, formats.error_address(), formats.error_length())));
  }
  return { result, output: new Uint8Array(formats.memory.buffer, formats.output_address(), formats.output_length()).slice() };
}

export function encodeText(text) {
  return encoder.encode(text);
}

// A text of the output formats module, by piece.
export function outputRequestText(piece) {
  if (!texts.has(piece)) texts.set(piece, decoder.decode(callOutputFormats("output_request_text", [piece], []).output));
  return texts.get(piece);
}

// A bit depth as a request holds it: the number, or the text piece's text
// when the number is NaN.
export function outputBitDepth(number, piece) {
  return Number.isNaN(number) ? outputRequestText(piece) : number;
}

function contract(format) {
  const view = new DataView(callOutputFormats("output_format_contract", [format], []).output.buffer);
  const list = (countOffset, firstOffset, stride, read) =>
    Object.freeze(Array.from({ length: view.getUint32(countOffset, true) }, (_, index) => read(firstOffset + index * stride)));
  return [outputRequestText(view.getUint32(CONTRACT.NAME, true)), Object.freeze({
    bitDepths: list(CONTRACT.DEPTH_COUNT, CONTRACT.DEPTHS, CONTRACT.DEPTH_SIZE, (at) =>
      outputBitDepth(view.getFloat64(at + CONTRACT.DEPTH_NUMBER, true), view.getUint32(at + CONTRACT.DEPTH_PIECE, true))),
    encodings: list(CONTRACT.ENCODING_COUNT, CONTRACT.ENCODINGS, CONTRACT.ENCODING_SIZE, (at) =>
      Object.freeze([outputRequestText(view.getUint32(at + CONTRACT.ENCODING_PRIMARIES, true)),
        outputRequestText(view.getUint32(at + CONTRACT.ENCODING_TRANSFER, true))])),
    alphaModes: list(CONTRACT.ALPHA_COUNT, CONTRACT.ALPHAS, CONTRACT.ALPHA_SIZE, (at) => outputRequestText(view.getUint32(at, true))),
    requiresMastering: view.getUint32(CONTRACT.MASTERING, true) === 1,
  })];
}

export const FORMAT_CAPABILITIES = Object.freeze(Object.fromEntries(
  Array.from({ length: formats.output_format_count() }, (_, format) => contract(format)),
));
