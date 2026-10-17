import { colorRuntime } from "./wasm/color-runtime.js";

// Color contract constants and validators.
//
// Normative source: docs/specifications/color-and-image-data.md.
// Runtime code uses only the identifiers named there. Every validator throws
// with one precise reason; nothing is inferred from file extensions,
// typed-array classes, or displays. Conversion maths is in @sandom/color;
// src/wasm/color-kernel.js calls it.

export const PRIMARIES = Object.freeze([
  'srgb',
  'display-p3',
  'rec2020',
  'a98-rgb',
  'prophoto-rgb',
  'xyz-d50',
  'xyz-d65',
]);

export const TRANSFER_FUNCTIONS = Object.freeze([
  'srgb',
  'linear',
  'gamma',
  'pq',
  'hlg',
  'rec2020',
  'prophoto-rgb',
  'icc',
]);

export const WHITE_POINTS = Object.freeze(['d50', 'd65']);

export const RENDER_MODES = Object.freeze(['standard', 'high-dynamic-range']);
export const DEFAULT_RENDER_MODE = 'standard';

export const RENDER_PRECISIONS = Object.freeze(['rgba16float', 'rgba8unorm']);
export const DEFAULT_RENDER_PRECISION = 'rgba16float';

// Reference white for the working encodings and all CSS colors, in candelas
// per square metre. A working channel value of 1 equals this luminance in
// linear terms.
export const REFERENCE_WHITE_LUMINANCE = 203;

// Standard mode's working encoding: extended sign-mirrored encoded sRGB,
// so blending and resampling match Blink exactly.
export const STANDARD_WORKING_COLOR_ENCODING = Object.freeze({
  primaries: 'srgb',
  transferFunction: 'srgb',
  transferFunctionParameters: null,
  whitePoint: 'd65',
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

// High-dynamic-range mode's working encoding: linear Rec. 2020.
export const WORKING_COLOR_ENCODING = Object.freeze({
  primaries: 'rec2020',
  transferFunction: 'linear',
  transferFunctionParameters: null,
  whitePoint: 'd65',
  referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
  profile: null,
});

export function validateRenderMode(renderMode) {
  if (!RENDER_MODES.includes(renderMode)) {
    throw new Error(`Unknown render mode "${renderMode}"`);
  }
  return renderMode;
}

// Closed operation set for tools/probe-color-capabilities.js results.
export const PROBE_OPERATIONS = Object.freeze([
  'rgba16float-render-attachment',
  'rgba16float-source-over-blend',
  'rgba16float-filtered-sample',
  'rgba16float-buffer-copy',
  'half-float-readback-above-one',
  'canvas-srgb',
  'canvas-display-p3',
  'canvas-rgba16float',
  'canvas-tone-mapping-standard',
  'canvas-tone-mapping-extended',
]);

export function validateColorEncoding(encoding) {
  if (encoding === null || typeof encoding !== 'object') {
    throw new Error('ColorEncoding must be an object');
  }
  const {
    primaries,
    transferFunction,
    transferFunctionParameters,
    whitePoint,
    referenceWhiteLuminance,
    profile,
  } = encoding;
  if (!PRIMARIES.includes(primaries)) {
    throw new Error(`ColorEncoding: unknown primaries "${primaries}"`);
  }
  if (!TRANSFER_FUNCTIONS.includes(transferFunction)) {
    throw new Error(`ColorEncoding: unknown transfer function "${transferFunction}"`);
  }
  if (transferFunction === 'gamma') {
    if (
      typeof transferFunctionParameters !== 'number' ||
      !Number.isFinite(transferFunctionParameters) ||
      transferFunctionParameters <= 0
    ) {
      throw new Error(
        'ColorEncoding: the gamma transfer function requires one positive finite exponent',
      );
    }
  } else if (transferFunctionParameters !== null) {
    throw new Error(
      `ColorEncoding: transferFunctionParameters must be null for "${transferFunction}"`,
    );
  }
  if (!WHITE_POINTS.includes(whitePoint)) {
    throw new Error(`ColorEncoding: unknown white point "${whitePoint}"`);
  }
  if (
    typeof referenceWhiteLuminance !== 'number' ||
    !Number.isFinite(referenceWhiteLuminance) ||
    referenceWhiteLuminance <= 0
  ) {
    throw new Error('ColorEncoding: referenceWhiteLuminance must be a positive finite number');
  }
  if (transferFunction === 'icc') {
    if (!(profile instanceof Uint8Array) || profile.length === 0) {
      throw new Error(
        'ColorEncoding: an icc transfer function requires the original profile bytes',
      );
    }
  } else if (profile !== null) {
    throw new Error(`ColorEncoding: profile must be null for "${transferFunction}"`);
  }
  return encoding;
}

export function validateRenderPrecision(renderPrecision) {
  if (!RENDER_PRECISIONS.includes(renderPrecision)) {
    throw new Error(`Unknown render precision "${renderPrecision}"`);
  }
  return renderPrecision;
}

export function validateTaggedColor(taggedColor) {
  if (taggedColor === null || typeof taggedColor !== 'object') {
    throw new Error('TaggedColor must be an object');
  }
  const { components, missingComponents, alpha, alphaIsMissing, colorEncoding, alphaMode } =
    taggedColor;
  if (!Array.isArray(components) || components.length !== 3) {
    throw new Error('TaggedColor: components must be an array of three entries');
  }
  if (!Number.isInteger(missingComponents) || missingComponents < 0 || missingComponents > 0b111) {
    throw new Error('TaggedColor: missingComponents must be a three-bit mask');
  }
  for (let index = 0; index < 3; index += 1) {
    const component = components[index];
    const maskBit = (missingComponents >> index) & 1;
    if (component === null) {
      if (maskBit !== 1) {
        throw new Error(
          `TaggedColor: component ${index} is null but its missingComponents bit is clear`,
        );
      }
    } else if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new Error(`TaggedColor: component ${index} must be a finite number or null`);
    } else if (maskBit !== 0) {
      throw new Error(
        `TaggedColor: component ${index} is present but its missingComponents bit is set`,
      );
    }
  }
  if (alpha !== null && (typeof alpha !== 'number' || !Number.isFinite(alpha))) {
    throw new Error('TaggedColor: alpha must be a finite number or null');
  }
  if (alphaIsMissing !== (alpha === null)) {
    throw new Error('TaggedColor: alphaIsMissing must be true exactly when alpha is null');
  }
  if (alphaMode !== 'straight') {
    throw new Error('TaggedColor: alphaMode must be "straight" at the parse boundary');
  }
  validateColorEncoding(colorEncoding);
  return taggedColor;
}

// Shader matrices are copied from @sandom/color's WAT-owned table. Index order
// is the package kernel contract; Sandom does not keep a second value table.
export const KERNEL_MATRIX_INDEX = Object.freeze({
  srgbToXyz: 0,
  xyzToSrgb: 1,
  displayP3ToXyz: 2,
  xyzToDisplayP3: 3,
  rec2020ToXyz: 4,
  xyzToRec2020: 5,
  a98RgbToXyz: 6,
  xyzToA98Rgb: 7,
  prophotoRgbToXyz: 8,
  xyzToProphotoRgb: 9,
  adaptD50ToD65: 10,
  adaptD65ToD50: 11,
  xyzD65ToOklabLms: 12,
  oklabLmsToXyzD65: 13,
  oklabLmsToLab: 14,
  oklabLabToLms: 15,
});

function readKernelMatrices() {
  const runtime = colorRuntime();
  const pointer = runtime.alloc(72);
  try {
    return Object.freeze(Object.values(KERNEL_MATRIX_INDEX).map((index) => {
      if (runtime.exports.color_matrix_read(index, pointer, 72) !== 1) {
        throw new Error(`@sandom/color rejected matrix index ${index}`);
      }
      const values = runtime.copyOut(pointer, 72, Float64Array);
      return Object.freeze([
        Object.freeze(Array.from(values.subarray(0, 3))),
        Object.freeze(Array.from(values.subarray(3, 6))),
        Object.freeze(Array.from(values.subarray(6, 9))),
      ]);
    }));
  } finally {
    runtime.free(pointer);
  }
}

export const KERNEL_MATRICES = readKernelMatrices();

// The D50 reference white of @sandom/color's Lab conversion, copied for
// shaders: Lab (100, 0, 0) converts exactly to the XYZ D50 white.
function readKernelWhiteD50() {
  const { exports, memory, abi } = colorRuntime();
  const offset = abi.records.parse.vecOffset;
  new Float64Array(memory.buffer, offset, 3).set([100, 0, 0]);
  exports.lab_to_xyz_d50();
  return Object.freeze(Array.from(new Float64Array(memory.buffer, offset, 3)));
}

export const XYZ_WHITE_D50 = readKernelWhiteD50();
