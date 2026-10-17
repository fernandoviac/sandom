// output_ppm_frame frames the samples; @sandom/color supplies generic RGB quantization.
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";

export function encodePPM(descriptor, request) {
  if (request?.format !== "ppm") {
    throw new Error('encodePPM requires a validated OutputRequest with format "ppm"');
  }
  const { pixels } = transformImageForOutput(descriptor, request);
  const [rgb] = core.byteInput(packSignal(pixels, 8, 3));
  core.status("output_ppm_frame", rgb, descriptor.width, descriptor.height);
  const pointer = core.exports.abi_output_pointer();
  return core.refreshBytes().slice(pointer, pointer + core.exports.abi_output_length());
}
