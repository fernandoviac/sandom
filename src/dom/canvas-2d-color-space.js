// Colors between the predefined color spaces of a Canvas 2D bitmap
// ("srgb", "display-p3"). Both spaces share the sRGB transfer function,
// extended point-symmetrically below 0 and above 1, so a conversion decodes
// the transfer, applies the matrix between the linear spaces and encodes
// the transfer again. Chrome converts the same way: sRGB red is
// (234, 51, 35) in a display-p3 canvas, and an sRGB pixel (0, 128, 255)
// drawn into one is (55, 126, 247) (measured on Chrome 151).
//
// The matrix is Skia's: through XYZ D50 with skcms's named gamuts
// (SkNamedGamut::kSRGB, kDisplayP3). It differs from the CSS Color 4 matrix
// (through XYZ D65) by about 1e-4, which moves a gradient pixel by one level.
import { loadColorKernel } from "../wasm/color-kernel.js";

const { decodeSrgbTransfer, encodeSrgbTransfer } = loadColorKernel();

// Linear RGB to XYZ D50, by rows (skcms).
const TO_XYZ_D50 = Object.freeze({
  "srgb": [
    [0.436065674, 0.385147095, 0.143066406],
    [0.222488403, 0.716873169, 0.060607910],
    [0.013916016, 0.097076416, 0.714096069],
  ],
  "display-p3": [
    [0.515102, 0.291965, 0.157153],
    [0.241182, 0.692236, 0.0665819],
    [-0.00104941, 0.0418818, 0.784378],
  ],
});

function inverse([[a, b, c], [d, e, f], [g, h, i]]) {
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ].map((row) => row.map((value) => value / determinant));
}

function product(left, right) {
  return left.map((row) => [0, 1, 2].map((column) => row[0] * right[0][column] + row[1] * right[1][column] + row[2] * right[2][column]));
}

// Source color space → destination color space → matrix.
const matrices = new Map();

// The matrix, by rows, from linear `source` to linear `destination`, both
// canvas color spaces.
export function canvasGamutRows(source, destination) {
  let bySource = matrices.get(source);
  if (bySource === undefined) {
    bySource = new Map();
    matrices.set(source, bySource);
  }
  let matrix = bySource.get(destination);
  if (matrix === undefined) {
    const from = TO_XYZ_D50[source];
    const to = TO_XYZ_D50[destination];
    if (from === undefined || to === undefined) {
      throw new Error(`Canvas 2D color space conversion from ${source} to ${destination}: expected "srgb" or "display-p3"`);
    }
    matrix = product(inverse(to), from);
    bySource.set(destination, matrix);
  }
  return matrix;
}

// The source color space conversion of a draw image or put image data
// record (record offset 92, canvas-2d-image.watpart) or a pattern (word
// 3): the shader samples the source in its own color space and converts
// the sample, as Skia filters an image before its color space transform.
export const SOURCE_CONVERSION_NONE = 0;
export const SOURCE_CONVERSION_SRGB_TO_DISPLAY_P3 = 1;
export const SOURCE_CONVERSION_DISPLAY_P3_TO_SRGB = 2;

// The conversion of a source (a resolved image source of
// src/dom/canvas-2d.js, or { colorSpace } of an ImageData) drawn into a
// canvas of `colorSpace`. A decoded image is uploaded in the canvas's
// color space already.
export function sourceConversion(source, colorSpace) {
  if (source.kind === "image") return SOURCE_CONVERSION_NONE;
  const sourceSpace = source.colorSpace ?? "srgb";
  if (sourceSpace === colorSpace) return SOURCE_CONVERSION_NONE;
  return sourceSpace === "srgb" ? SOURCE_CONVERSION_SRGB_TO_DISPLAY_P3 : SOURCE_CONVERSION_DISPLAY_P3_TO_SRGB;
}

// The encoded components [red, green, blue] of a color in `source`, as
// encoded components in `destination`. The result is not clamped.
export function convertCanvasColor(red, green, blue, source, destination) {
  if (source === destination) return [red, green, blue];
  const matrix = canvasGamutRows(source, destination);
  const linear = [decodeSrgbTransfer(red), decodeSrgbTransfer(green), decodeSrgbTransfer(blue)];
  return matrix.map((row) =>
    encodeSrgbTransfer(row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])
  );
}
