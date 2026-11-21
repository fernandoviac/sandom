// The uniform of the source conversion shader for an image descriptor
// (image_conversion_uniform in core/dom/image-conversion.watpart).
import { validateRenderMode } from './color.js';
import { sharedDomCore } from './dom-wasm/core.js';
import { colorRuntime } from './wasm/color-runtime.js';

// Twenty f32 words for `descriptor` drawn in `renderMode`, into a canvas
// bitmap of `canvasColorSpace` ("srgb" or "display-p3") when one is given.
export function imageConversionUniform(descriptor, renderMode, canvasColorSpace = null) {
  validateRenderMode(renderMode);
  const { enums } = colorRuntime().abi;
  const { colorEncoding } = descriptor;
  const canvasSpace = canvasColorSpace === null ? -1 : enums.primaries[canvasColorSpace];
  if (canvasSpace === undefined) throw new RangeError(`image conversion: unknown canvas color space "${canvasColorSpace}"`);
  const core = sharedDomCore;
  const status = core.status(
    "image_conversion_uniform",
    enums.sample[descriptor.sampleType],
    descriptor.bitsPerSample,
    enums.alpha[descriptor.alphaMode],
    enums.transfer[colorEncoding.transferFunction],
    enums.primaries[colorEncoding.primaries],
    colorEncoding.transferFunction === 'gamma' ? colorEncoding.transferFunctionParameters : 1,
    colorEncoding.referenceWhiteLuminance,
    descriptor.sampleType === 'float16' && descriptor.canvasToneMapping === 'standard',
    renderMode === 'high-dynamic-range',
    canvasSpace,
  );
  if (status !== 1) {
    throw new Error(
      `image conversion: ${colorEncoding.transferFunction === 'icc' ? 'ICC-tagged descriptors must be converted before upload' : 'no conversion for this descriptor'}`,
    );
  }
  return new Float32Array(core.outputBytes("image_conversion_uniform", 0, 80).buffer);
}
