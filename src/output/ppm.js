// output_ppm_frame frames the samples; @sandom/color supplies generic RGB quantization.
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { callOutputFormats, ENCODER_FORMAT } from "./format-policy.js";
import { transformImageForOutput } from "./color-transform.js";
import { packSignal } from "./packing.js";
import { encodeHostValues } from "../wasm/host-values.js";

export function encodePPM(descriptor, request) {
  callOutputFormats("output_encoder_request", [ENCODER_FORMAT.PPM], [encodeHostValues([request?.format])]);
  const { pixels } = transformImageForOutput(descriptor, request);
  const [rgb] = core.byteInput(packSignal(pixels, 8, 3));
  core.status("output_ppm_frame", rgb, descriptor.width, descriptor.height);
  return core.outputBytes("output_ppm_frame");
}
