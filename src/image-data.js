// Image descriptor contract constants and validators.
//
// Normative source: docs/specifications/color-and-image-data.md.
// One descriptor shape serves decoded images, readback, and encoder input.
// Every validator throws with one precise reason.

import {
  REFERENCE_WHITE_LUMINANCE,
  validateColorEncoding,
  validateRenderMode,
} from './color.js';
import { loadColorKernel } from './wasm/color-kernel.js';

const { linearRgbToWorkingMatrix } = loadColorKernel();

// Sample types with their required typed-array constructor and the byte size
// of one sample. float16 carries IEEE 754 binary16 bits in Uint16Array
// elements.
export const SAMPLE_TYPES = Object.freeze({
  uint8: Object.freeze({ arrayConstructor: Uint8Array, bytesPerSample: 1, maximumBits: 8 }),
  uint16: Object.freeze({ arrayConstructor: Uint16Array, bytesPerSample: 2, maximumBits: 16 }),
  float16: Object.freeze({ arrayConstructor: Uint16Array, bytesPerSample: 2, maximumBits: 16 }),
  float32: Object.freeze({ arrayConstructor: Float32Array, bytesPerSample: 4, maximumBits: 32 }),
});

export const CHANNEL_LAYOUTS = Object.freeze({
  gray: Object.freeze({ channelCount: 1, hasAlpha: false }),
  'gray-alpha': Object.freeze({ channelCount: 2, hasAlpha: true }),
  rgb: Object.freeze({ channelCount: 3, hasAlpha: false }),
  rgba: Object.freeze({ channelCount: 4, hasAlpha: true }),
});

export const ALPHA_MODES = Object.freeze(['opaque', 'straight', 'premultiplied']);

// Closed set of recognized metadata records on an ImageDescriptor.
export const METADATA_KEYS = Object.freeze([
  'orientation',
  'iccProfile',
  'codedColorVolume',
  'masteringDisplayColorVolume',
  'contentLightLevel',
  'codecState',
]);

export function validateImageDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new Error('ImageDescriptor must be an object');
  }
  const {
    width,
    height,
    rowStride,
    pixels,
    channelLayout,
    sampleType,
    bitsPerSample,
    colorEncoding,
    alphaMode,
    metadata,
  } = descriptor;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`ImageDescriptor: width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`ImageDescriptor: height must be a positive integer, got ${height}`);
  }
  const sample = SAMPLE_TYPES[sampleType];
  if (sample === undefined) {
    throw new Error(`ImageDescriptor: unknown sample type "${sampleType}"`);
  }
  if (!(pixels instanceof sample.arrayConstructor)) {
    throw new Error(
      `ImageDescriptor: sample type "${sampleType}" requires ${sample.arrayConstructor.name} pixels`,
    );
  }
  const layout = CHANNEL_LAYOUTS[channelLayout];
  if (layout === undefined) {
    throw new Error(`ImageDescriptor: unknown channel layout "${channelLayout}"`);
  }
  if (!Number.isInteger(bitsPerSample) || bitsPerSample <= 0 || bitsPerSample > sample.maximumBits) {
    throw new Error(
      `ImageDescriptor: bitsPerSample must be a positive integer through ${sample.maximumBits}, got ${bitsPerSample}`,
    );
  }
  const minimumRowBytes = width * layout.channelCount * sample.bytesPerSample;
  if (!Number.isInteger(rowStride) || rowStride < minimumRowBytes) {
    throw new Error(
      `ImageDescriptor: rowStride ${rowStride} is below the minimum ${minimumRowBytes} bytes for ${width} pixels`,
    );
  }
  if (rowStride % sample.bytesPerSample !== 0) {
    throw new Error(
      `ImageDescriptor: rowStride ${rowStride} is not a multiple of the ${sample.bytesPerSample}-byte sample size`,
    );
  }
  const expectedByteLength = rowStride * height;
  if (pixels.byteLength !== expectedByteLength) {
    throw new Error(
      `ImageDescriptor: pixel buffer holds ${pixels.byteLength} bytes but rowStride * height is ${expectedByteLength}`,
    );
  }
  if (!ALPHA_MODES.includes(alphaMode)) {
    throw new Error(`ImageDescriptor: unknown alpha mode "${alphaMode}"`);
  }
  if (!layout.hasAlpha && alphaMode !== 'opaque') {
    throw new Error(
      `ImageDescriptor: channel layout "${channelLayout}" has no alpha channel and requires alphaMode "opaque"`,
    );
  }
  if (metadata === null || typeof metadata !== 'object') {
    throw new Error('ImageDescriptor: metadata must be an object');
  }
  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.includes(key)) {
      throw new Error(`ImageDescriptor: unrecognized metadata record "${key}"`);
    }
  }
  validateColorEncoding(colorEncoding);
  return descriptor;
}

// Shared descriptor assembly for the eight-bit sRGB decoders (JPEG, WebP).
export function srgbRgba8ImageDescriptor(width, height, pixels, metadata = {}) {
  return validateImageDescriptor({
    width,
    height,
    rowStride: width * 4,
    pixels,
    channelLayout: 'rgba',
    sampleType: 'uint8',
    bitsPerSample: 8,
    colorEncoding: {
      primaries: 'srgb',
      transferFunction: 'srgb',
      transferFunctionParameters: null,
      whitePoint: 'd65',
      referenceWhiteLuminance: 203,
      profile: null,
    },
    alphaMode: 'straight',
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Eight-bit sRGB flattener. NOT part of the color-managed render path: the
// renderer uploads native precision (imageUploadRepresentation +
// sourceConversionPlan below). This serves the two places whose contract is
// genuinely eight-bit sRGB — pixel comparisons against eight-bit Chrome
// screenshots, and the degraded WebGL 2 backend's input boundary. It throws
// on any descriptor that cannot be represented losslessly-in-kind as
// eight-bit sRGB rather than silently flattening wide or high-dynamic-range
// content.
// ---------------------------------------------------------------------------

import { convertToSrgb, isSrgbLike, parseIccProfile, releaseIccProfile, prepareProfileImage } from './color-profile.js';
import { expandImageSamples } from './output/packing.js';
import { degradedSrgbPixels } from './wasm/color-source.js';


export function toSrgbRgba8(descriptor) {
  validateImageDescriptor(descriptor);
  const { width, height, sampleType, colorEncoding } = descriptor;
  if (sampleType === 'float16' || sampleType === 'float32') {
    throw new Error('toSrgbRgba8: floating-point descriptors are not expressible as eight-bit sRGB');
  }
  const transfer = colorEncoding.transferFunction;
  if (!['srgb', 'gamma', 'icc'].includes(transfer)) {
    throw new Error(`toSrgbRgba8: transfer function "${transfer}" is not expressible as eight-bit sRGB`);
  }
  if (transfer !== 'icc' && colorEncoding.primaries !== 'srgb') {
    throw new Error(`toSrgbRgba8: primaries "${colorEncoding.primaries}" are not expressible as eight-bit sRGB`);
  }
  const pixels = degradedSrgbPixels(descriptor);
  if (transfer === 'icc') {
    const profile = parseIccProfile(colorEncoding.profile);
    try { if (!isSrgbLike(profile)) convertToSrgb(pixels, profile); }
    finally { releaseIccProfile(profile); }
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Native-precision texture upload (wide-color plan, package 4).
//
// The renderer uploads each descriptor's own samples and converts them into
// the selected mode's working encoding on the graphics processing unit.
// JavaScript only reshapes channel layouts into a WebGPU-uploadable RGBA
// form (a layout shuffle, not color math) and derives the per-image
// conversion parameters; every per-pixel color operation runs in the
// conversion shader (src/rasterize.js).
// ---------------------------------------------------------------------------

// Channel-expand a descriptor into an uploadable RGBA texture payload.
// sampleKind selects the conversion-shader variant: 'float' binds the
// texture as texture_2d<f32> (unorm and float formats), 'uint' as
// texture_2d<u32> (sixteen-bit integer samples).
export function imageUploadRepresentation(descriptor) {
  validateImageDescriptor(descriptor);
  const { width, sampleType } = descriptor;
  return {
    format: { uint8: 'rgba8unorm', uint16: 'rgba16uint', float16: 'rgba16float', float32: 'rgba32float' }[sampleType],
    sampleKind: sampleType === 'uint16' ? 'uint' : 'float',
    data: expandImageSamples(descriptor),
    bytesPerRow: width * 4 * SAMPLE_TYPES[sampleType].bytesPerSample,
  };
}

// ICC lookup-table work cannot be expressed by the active upload shader.
// Only this CPU-required path evaluates profiles before the GPU upload.
export function prepareImageProfile(descriptor) {
  validateImageDescriptor(descriptor);
  if (descriptor.colorEncoding.transferFunction !== 'icc') return descriptor;
  const profile = parseIccProfile(descriptor.colorEncoding.profile);
  try { return prepareProfileImage(profile, descriptor); }
  finally { releaseIccProfile(profile); }
}

// Conversion-shader transfer identifiers. A shared contract with
// SOURCE_CONVERT_SHADER in src/rasterize.js.
export const CONVERSION_TRANSFER_IDS = Object.freeze({
  linear: 0,
  srgb: 1,
  gamma: 2,
  pq: 3,
  hlg: 4,
  rec2020: 5,
  'prophoto-rgb': 6,
});

// Per-image parameters for the source-to-working conversion shader.
// The matrix maps source-linear RGB into the mode's linear working
// primaries (sRGB for standard mode, Rec. 2020 for high-dynamic-range
// mode); standard mode re-encodes with the extended sign-mirrored sRGB
// transfer after the matrix. ICC-tagged descriptors are rejected here:
// the registration boundary must have already replaced them (uint8
// profiles convert through src/color-profile.js; anything else needs the
// source-to-working transform module, package 4 step 5).
export function sourceConversionPlan(descriptor, renderMode) {
  validateRenderMode(renderMode);
  const { colorEncoding, alphaMode, sampleType, bitsPerSample } = descriptor;
  const transfer = colorEncoding.transferFunction;
  if (transfer === 'icc') {
    throw new Error(
      'sourceConversionPlan: ICC-tagged descriptors must be converted before upload',
    );
  }
  const transferId = CONVERSION_TRANSFER_IDS[transfer];
  if (transferId === undefined) {
    throw new Error(`sourceConversionPlan: unknown transfer function "${transfer}"`);
  }
  const destinationPrimaries = renderMode === 'high-dynamic-range' ? 'rec2020' : 'srgb';
  const rows = linearRgbToWorkingMatrix(colorEncoding.primaries, destinationPrimaries);
  // Three rows padded to vec4 columns for the WGSL uniform layout.
  const matrix = new Float32Array(12);
  for (let row = 0; row < 3; row++) {
    matrix[row * 4] = rows[row][0];
    matrix[row * 4 + 1] = rows[row][1];
    matrix[row * 4 + 2] = rows[row][2];
  }
  // PQ and HLG carry absolute luminance in their own decode; every other
  // transfer scales diffuse white by the source's stated reference white
  // against the 203-candela working white.
  const linearScale = transfer === 'pq' || transfer === 'hlg'
    ? 1
    : colorEncoding.referenceWhiteLuminance / REFERENCE_WHITE_LUMINANCE;
  // Integer samples normalize by the coded maximum of their meaningful
  // bits (rgba8unorm normalizes in hardware; sixteen-bit integer loads
  // arrive raw).
  const sourceScale = sampleType === 'uint16' ? 1 / ((1 << bitsPerSample) - 1) : 1;
  return {
    transferId,
    gammaExponent: transfer === 'gamma' ? colorEncoding.transferFunctionParameters : 1,
    matrix,
    linearScale,
    sourceScale,
    encodeSrgbOutput: renderMode === 'standard' ? 1 : 0,
    alphaSourceMode: alphaMode === 'opaque' ? 1 : alphaMode === 'premultiplied' ? 2 : 0,
  };
}
