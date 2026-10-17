// Adapter from Sandom's color API to @sandom/color's standalone kernel.
import { colorRuntime } from "./color-runtime.js";
import {
  KERNEL_MATRIX_INDEX,
  validateTaggedColor,
} from '../color.js';


// destination primaries -> [xyzToDest, destToXyz, destIsD50] kernel indices.
const GAMUT_DESTINATIONS = Object.freeze({
  srgb: [KERNEL_MATRIX_INDEX.xyzToSrgb, KERNEL_MATRIX_INDEX.srgbToXyz, 0],
  'display-p3': [KERNEL_MATRIX_INDEX.xyzToDisplayP3, KERNEL_MATRIX_INDEX.displayP3ToXyz, 0],
  rec2020: [KERNEL_MATRIX_INDEX.xyzToRec2020, KERNEL_MATRIX_INDEX.rec2020ToXyz, 0],
  'a98-rgb': [KERNEL_MATRIX_INDEX.xyzToA98Rgb, KERNEL_MATRIX_INDEX.a98RgbToXyz, 0],
  'prophoto-rgb': [KERNEL_MATRIX_INDEX.xyzToProphotoRgb, KERNEL_MATRIX_INDEX.prophotoRgbToXyz, 1],
});

// Primaries whose kernel path needs D50-to-D65 adaptation on the way in.
const SOURCE_IS_D50 = Object.freeze({ 'prophoto-rgb': true, 'xyz-d50': true });

export function loadColorKernel() {
  const runtime = colorRuntime();
  const { exports, abi } = runtime;
  let buffer;
  let view;
  let bytes;
  let int32;
  function refreshViews() {
    if (buffer !== exports.memory.buffer) {
      buffer = exports.memory.buffer;
      view = new Float64Array(buffer);
      bytes = new Uint8Array(buffer);
      int32 = new Int32Array(buffer);
    }
  }
  const textEncoder = new TextEncoder();
  const parse = abi.records.parse;
  const vecBase = parse.vecOffset / 8;
  const enumName = (values, code) =>
    Object.entries(values).find(([, value]) => value === code)?.[0];

  function writeVec(vector) {
    refreshViews();
    view[vecBase] = vector[0];
    view[vecBase + 1] = vector[1];
    view[vecBase + 2] = vector[2];
  }

  function readVec() {
    refreshViews();
    return [view[vecBase], view[vecBase + 1], view[vecBase + 2]];
  }

  function vectorOperation(vector, run) {
    writeVec(vector);
    run();
    return readVec();
  }

  function applyMatrix(index, vector) {
    return vectorOperation(vector, () => exports.apply_matrix(index));
  }

  function primaryMatrices(primaries) {
    const matrices = GAMUT_DESTINATIONS[primaries];
    if (matrices === undefined) throw new Error(`No kernel matrix for primaries "${primaries}"`);
    return matrices;
  }

  // Linear-light RGB in a named primary set into XYZ at that set's own
  // white point, and back.
  function convertLinearRgbToXyz(primaries, rgb) {
    return applyMatrix(primaryMatrices(primaries)[1], rgb);
  }

  function convertXyzToLinearRgb(primaries, xyz) {
    return applyMatrix(primaryMatrices(primaries)[0], xyz);
  }

  function convertXyzD50ToXyzD65(xyz) {
    return applyMatrix(KERNEL_MATRIX_INDEX.adaptD50ToD65, xyz);
  }

  return {
    // Transfer functions.
    decodeSrgbTransfer: exports.srgb_decode,
    encodeSrgbTransfer: exports.srgb_encode,
    decodeGammaTransfer: exports.gamma_decode,
    encodeGammaTransfer: exports.gamma_encode,
    pqSignalToLuminance: exports.pq_signal_to_luminance,
    luminanceToPqSignal: exports.luminance_to_pq_signal,
    decodePqToWorkingScale: exports.pq_to_working,
    encodeWorkingScaleToPq: exports.working_to_pq,
    hlgSignalToSceneLight: exports.hlg_signal_to_scene,
    sceneLightToHlgSignal: exports.scene_to_hlg_signal,

    // Vector transforms.
    applyMatrix,
    convertLinearRgbToXyz,
    convertXyzToLinearRgb,
    convertXyzD50ToXyzD65,
    // One 3x3 matrix from a source primary set into a linear-light
    // destination primary set, for GPU uniforms. Each basis vector goes
    // through the kernel matrices: source to XYZ, Bradford adaptation of a
    // D50 source to D65, Bradford adaptation to D50 for a D50 destination
    // (prophoto-rgb), then XYZ to the destination.
    linearRgbToWorkingMatrix(sourcePrimaries, destinationPrimaries) {
      const destination = GAMUT_DESTINATIONS[destinationPrimaries];
      if (destination === undefined) {
        throw new Error(
          `linearRgbToWorkingMatrix: unsupported destination "${destinationPrimaries}"`,
        );
      }
      const columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((basis) => {
        if (sourcePrimaries === destinationPrimaries) return basis;
        let xyz = basis;
        if (sourcePrimaries !== 'xyz-d65' && sourcePrimaries !== 'xyz-d50') {
          xyz = convertLinearRgbToXyz(sourcePrimaries, basis);
        }
        if (SOURCE_IS_D50[sourcePrimaries]) xyz = convertXyzD50ToXyzD65(xyz);
        if (destination[2] === 1) xyz = applyMatrix(KERNEL_MATRIX_INDEX.adaptD65ToD50, xyz);
        return convertXyzToLinearRgb(destinationPrimaries, xyz);
      });
      return [
        [columns[0][0], columns[1][0], columns[2][0]],
        [columns[0][1], columns[1][1], columns[2][1]],
        [columns[0][2], columns[1][2], columns[2][2]],
      ];
    },
    convertXyzD65ToOklab(xyz) {
      return vectorOperation(xyz, () => exports.xyz_d65_to_oklab());
    },
    convertOklabToXyzD65(oklab) {
      return vectorOperation(oklab, () => exports.oklab_to_xyz_d65());
    },
    convertLabToXyzD50(lab) {
      return vectorOperation(lab, () => exports.lab_to_xyz_d50());
    },
    convertXyzD50ToLab(xyz) {
      return vectorOperation(xyz, () => exports.xyz_d50_to_lab());
    },
    decodeHlgRgbToWorkingScale(rgbSignal) {
      return vectorOperation(rgbSignal, () => exports.hlg_rgb_to_working());
    },
    convertLinearRgbToWorking(primaries, rgb) {
      if (primaries === 'rec2020') return [rgb[0], rgb[1], rgb[2]];
      let vector = rgb;
      if (primaries !== 'xyz-d65' && primaries !== 'xyz-d50') {
        const toXyz = GAMUT_DESTINATIONS[primaries]?.[1];
        if (toXyz === undefined) throw new Error(`No kernel matrix for primaries "${primaries}"`);
        vector = applyMatrix(toXyz, vector);
      }
      if (SOURCE_IS_D50[primaries]) {
        vector = applyMatrix(KERNEL_MATRIX_INDEX.adaptD50ToD65, vector);
      }
      return applyMatrix(KERNEL_MATRIX_INDEX.xyzToRec2020, vector);
    },
    // Working linear Rec. 2020 -> a destination primary set's linear RGB,
    // WITHOUT a gamut map: out-of-destination-gamut input produces
    // extended (negative or above-one) components on purpose.
    convertWorkingToDestinationLinearRgb(destinationPrimaries, rgb) {
      if (destinationPrimaries === 'rec2020') return [rgb[0], rgb[1], rgb[2]];
      const destination = GAMUT_DESTINATIONS[destinationPrimaries];
      if (destination === undefined) {
        throw new Error(`No kernel matrix for primaries "${destinationPrimaries}"`);
      }
      let vector = applyMatrix(KERNEL_MATRIX_INDEX.rec2020ToXyz, rgb);
      if (destination[2] === 1) {
        vector = applyMatrix(KERNEL_MATRIX_INDEX.adaptD65ToD50, vector);
      }
      return applyMatrix(destination[0], vector);
    },
    // TaggedColor -> working linear Rec. 2020 on the 203-candela scale.
    convertTaggedColorToWorking(taggedColor) {
      const { colorEncoding } = taggedColor;
      writeVec(taggedColor.components.map((component) => component ?? 0));
      const primaries = abi.enums.primaries[colorEncoding.primaries];
      const transfer = abi.enums.transfer[colorEncoding.transferFunction];
      const gamma = colorEncoding.transferFunction === "gamma"
        ? colorEncoding.transferFunctionParameters
        : 1;
      if (primaries === undefined || transfer === undefined ||
          exports.color_convert_tagged_to_working(
            primaries,
            transfer,
            gamma,
            taggedColor.missingComponents,
          ) === 0) {
        throw new Error(`No kernel conversion for ${colorEncoding.primaries}/${colorEncoding.transferFunction}`);
      }
      return readVec();
    },
    toneMapBt2390(rgb, sourcePeakLuminance, targetPeakLuminance) {
      return vectorOperation(rgb, () =>
        exports.tone_map_bt2390(sourcePeakLuminance, targetPeakLuminance),
      );
    },
    parseCssColor(text) {
      const encoded = textEncoder.encode(text);
      if (encoded.length > parse.inputCapacity) {
        throw new Error(`CSS color value longer than ${parse.inputCapacity} bytes`);
      }
      refreshViews();
      bytes.set(encoded, parse.inputOffset);
      const status = exports.color_parse_css(encoded.length);
      if (status !== 0) {
        throw new Error(`CSS color "${text}": ${abi.cssErrors[status] ?? `error ${status}`}`);
      }
      const fields = parse.fields;
      refreshViews();
      const result = parse.resultOffset;
      const componentBase = (result + fields.components) / 8;
      const missingComponents = int32[(result + fields.missing) / 4];
      const authoredMissing = int32[(result + fields.authoredMissing) / 4];
      const alphaIsMissing = int32[(result + fields.alphaMissing) / 4] === 1;
      const primaries = enumName(abi.enums.primaries, int32[(result + fields.primaries) / 4]);
      const transferFunction = enumName(abi.enums.transfer, int32[(result + fields.transfer) / 4]);
      const form = enumName(abi.cssForms, int32[(result + fields.form) / 4]);
      const components = [0, 1, 2].map((index) =>
        (missingComponents >> index) & 1 ? null : view[componentBase + index]
      );
      const taggedColor = {
        components,
        missingComponents,
        alpha: alphaIsMissing ? null : view[(result + fields.alpha) / 8],
        alphaIsMissing,
        colorEncoding: {
          primaries,
          transferFunction,
          transferFunctionParameters:
            transferFunction === "gamma" ? view[(result + fields.gamma) / 8] : null,
          whitePoint: enumName(abi.enums.white, int32[(result + fields.white) / 4]),
          referenceWhiteLuminance: view[(result + fields.referenceWhite) / 8],
          profile: null,
        },
        alphaMode: enumName(abi.enums.alpha, int32[(result + fields.alphaMode) / 4]),
      };
      validateTaggedColor(taggedColor);
      return { taggedColor, sourceForm: { form, authoredMissing } };
    },

    // Piecewise transfer functions for color(rec2020) and color(prophoto-rgb).
    decodeRec2020Transfer: exports.rec2020_decode,
    encodeRec2020Transfer: exports.rec2020_encode,
    decodeProphotoTransfer: exports.prophoto_decode,
    encodeProphotoTransfer: exports.prophoto_encode,
    gamutMapCssColor4(workingRgb, destinationPrimaries) {
      const destination = GAMUT_DESTINATIONS[destinationPrimaries];
      if (destination === undefined) {
        throw new Error(`No gamut-map destination for primaries "${destinationPrimaries}"`);
      }
      return vectorOperation(workingRgb, () =>
        exports.gamut_map_css_color_4(destination[0], destination[1], destination[2]),
      );
    },
  };
}
