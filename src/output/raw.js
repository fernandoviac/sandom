// SRAW v1 is Sandom's rebuildable reflection format. output_sraw_frame and
// output_sraw_check own its framing and validation; @sandom/color supplies
// the binary16 conversion.
import { WORKING_COLOR_ENCODING } from "../color.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { transformImageForOutput } from "./color-transform.js";
import { packHalf, unpackHalf } from "./packing.js";
import { layoutConstant } from "../wasm/layout-table.js";

const HEADER_SIZE = layoutConstant("SRAW_HEADER_SIZE");

export function encodeRaw(descriptor, request) {
  if (request?.format !== "raw") {
    throw new Error('encodeRaw requires a validated OutputRequest with format "raw"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const payload = packHalf(pixels);
  const [pointer, length] = core.byteInput(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  core.status("output_sraw_frame", pointer, length, descriptor.width, descriptor.height);
  const output = core.exports.abi_output_pointer();
  return core.refreshBytes().slice(output, output + core.exports.abi_output_length());
}

export function decodeRaw(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("raw input requires Uint8Array bytes");
  try {
    core.status("output_sraw_check", ...core.byteInput(bytes));
  } catch (error) {
    error.domain = "sraw";
    error.field = core.exports.output_sraw_error_field();
    throw error;
  }
  const [width, height] = new Uint32Array(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 2);
  const payload = bytes.slice(HEADER_SIZE);
  const pixels = unpackHalf(new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2));
  return {
    pixels,
    width,
    height,
    rowStride: width * 16,
    channelLayout: "rgba",
    sampleType: "float32",
    bitsPerSample: 16,
    alphaMode: "premultiplied",
    colorEncoding: WORKING_COLOR_ENCODING,
    metadata: {},
  };
}
