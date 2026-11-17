import { defaultPngCodec } from '../png-codec.js';
import { transformImageForOutput } from './color-transform.js';
import { buildDisplayP3Profile } from './icc-profile.js';
import { callOutputFormats, ENCODER_FORMAT, OUTPUT_PNG_DISPLAY_P3 } from './format-policy.js';
import { encodeHostValues } from '../wasm/host-values.js';

/** One central color transform, then native-precision PNG sample packing. */
export async function encodePngOutput(descriptor, request) {
  return await encodePngOutputWithCodec(defaultPngCodec, descriptor, request);
}

// The request facts come from output_encoder_request and output_png_profile
// of core/build/output-formats.wat.
export async function encodePngOutputWithCodec(codec, descriptor, request) {
  callOutputFormats('output_encoder_request', [ENCODER_FORMAT.PNG], [encodeHostValues([request?.format])]);
  const { pixels, width, height } = transformImageForOutput(descriptor, request);
  const displayP3 = callOutputFormats('output_png_profile', [],
    [encodeHostValues([request.colorEncoding.primaries])]).result === OUTPUT_PNG_DISPLAY_P3;
  return await codec.encode(pixels, width, height, {
    bitDepth: request.bitDepth,
    colorEncoding: request.colorEncoding,
    compressionLevel: request.codecOptions.compressionLevel,
    profile: displayP3 ? buildDisplayP3Profile() : null,
    masteringDisplay: request.masteringDisplay,
    contentLightLevel: request.contentLightLevel,
  });
}
