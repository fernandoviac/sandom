// The constant values of the shared scene shaders. The JavaScript pipeline
// library and the native shader bundle (tools/build-shaders.js) compose
// with these values. Matrices mirror src/color.js's kernel matrices in WGSL
// column order.
import {
  KERNEL_MATRICES,
  KERNEL_MATRIX_INDEX,
  XYZ_WHITE_D50,
} from "../color.js";
import { MAX_SHADER_CLIP_ENTRIES } from "../gpu-composition-clip.js";

function wgslMat3(matrix) {
  const columns = [0, 1, 2].map((column) =>
    [0, 1, 2].map((row) => matrix[row][column]).join(", ")
  );
  return `mat3x3f(${columns.join(", ")})`;
}

export const SHADER_CONSTANTS = Object.freeze({
  MAX_SHADER_CLIP_ENTRIES,
  GRAD_SRGB_TO_XYZ: wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.srgbToXyz]),
  GRAD_XYZ_TO_SRGB: wgslMat3(KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToSrgb]),
  GRAD_XYZ_TO_REC2020: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToRec2020],
  ),
  GRAD_XYZ_TO_DISPLAY_P3: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.xyzToDisplayP3],
  ),
  GRAD_ADAPT_D50_TO_D65: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.adaptD50ToD65],
  ),
  GRAD_DISPLAY_P3_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.displayP3ToXyz],
  ),
  GRAD_A98_RGB_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.a98RgbToXyz],
  ),
  GRAD_PROPHOTO_RGB_TO_XYZ_D50: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.prophotoRgbToXyz],
  ),
  GRAD_REC2020_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.rec2020ToXyz],
  ),
  GRAD_OKLAB_LAB_TO_LMS: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLabToLms],
  ),
  GRAD_OKLAB_LMS_TO_XYZ: wgslMat3(
    KERNEL_MATRICES[KERNEL_MATRIX_INDEX.oklabLmsToXyzD65],
  ),
  GRAD_D50_WHITE: XYZ_WHITE_D50.join(", "),
  GRAD_LAB_EPSILON: 216 / 24389,
  GRAD_LAB_KAPPA: 24389 / 27,
});

// The source-convert variants: float sources and sixteen-bit integer
// sources normalized by alphaParams.y.
export const SOURCE_CONVERT_CONSTANTS = Object.freeze({
  float: Object.freeze({
    SOURCE_TEXTURE_TYPE: "texture_2d<f32>",
    SOURCE_FETCH: "textureLoad(srcTex, texel, 0)",
  }),
  uint: Object.freeze({
    SOURCE_TEXTURE_TYPE: "texture_2d<u32>",
    SOURCE_FETCH: "vec4f(textureLoad(srcTex, texel, 0)) * uniforms.alphaParams.y",
  }),
});

// The shader sources of core/engine/gpu-pipelines.watpart, in its order.
export const PIPELINE_LIBRARY_SHADERS = Object.freeze([
  ["rect", {}],
  ["tile-clear", {}],
  ["composite", {}],
  ["mask-combine", {}],
  ["box-blur", {}],
  ["drop-shadow", {}],
  ["text", {}],
  ["svg-path", {}],
  ["image", {}],
  ["box-shadow", {}],
  ["downsample", {}],
  ["source-convert", SOURCE_CONVERT_CONSTANTS.float],
  ["source-convert", SOURCE_CONVERT_CONSTANTS.uint],
]);
