// output_bmp_frame frames the samples; @sandom/color supplies generic RGB quantization.
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";

export function encodeBMP(descriptor, request) {
  if (request?.format !== "bmp") {
    throw new Error('encodeBMP requires a validated OutputRequest with format "bmp"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const [rgb] = core.byteInput(packSignal(pixels, 8, 3));
  core.status("output_bmp_frame", rgb, descriptor.width, descriptor.height);
  const pointer = core.exports.abi_output_pointer();
  return core.refreshBytes().slice(pointer, pointer + core.exports.abi_output_length());
}
