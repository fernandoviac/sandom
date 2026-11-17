// Adapter from Sandom's color API to @sandom/color's standalone kernel.
import { colorRuntime } from "./color-runtime.js";
import {
  KERNEL_MATRIX_INDEX,
  validateTaggedColor,
} from '../color.js';


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

  // Runs the kernel operation `run` with the primaries code of `primaries`;
  // the kernel returns 0 for primaries the operation has no matrix for.
  function primariesOperation(name, primaries, run) {
    const code = abi.enums.primaries[primaries];
    if (code === undefined || run(code) !== 1) {
      throw new Error(`${name}: no kernel matrix for primaries "${primaries}"`);
    }
  }

  function applyMatrix(index, vector) {
    return vectorOperation(vector, () => exports.apply_matrix(index));
  }

  // Linear-light RGB in a named primary set into XYZ at that set's own
  // white point, and back.
  function convertLinearRgbToXyz(primaries, rgb) {
    return vectorOperation(rgb, () => primariesOperation("convertLinearRgbToXyz", primaries, exports.color_linear_to_xyz));
  }

  function convertXyzToLinearRgb(primaries, xyz) {
    return vectorOperation(xyz, () => primariesOperation("convertXyzToLinearRgb", primaries, exports.color_xyz_to_linear));
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
    // One 3x3 matrix by rows from a source primary set into a linear-light
    // destination primary set, for GPU uniforms (color_primaries_matrix).
    linearRgbToWorkingMatrix(sourcePrimaries, destinationPrimaries) {
      const pointer = runtime.alloc(72);
      try {
        const source = abi.enums.primaries[sourcePrimaries];
        const destination = abi.enums.primaries[destinationPrimaries];
        if (source === undefined || destination === undefined ||
            exports.color_primaries_matrix(source, destination, pointer, 72) !== 1) {
          throw new Error(
            `linearRgbToWorkingMatrix: no matrix from "${sourcePrimaries}" to "${destinationPrimaries}"`,
          );
        }
        const values = runtime.copyOut(pointer, 72, Float64Array);
        return [0, 3, 6].map((start) => Array.from(values.subarray(start, start + 3)));
      } finally {
        runtime.free(pointer);
      }
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
      return vectorOperation(rgb, () =>
        primariesOperation("convertLinearRgbToWorking", primaries, exports.color_linear_to_working));
    },
    // Working linear Rec. 2020 -> a destination primary set's linear RGB,
    // WITHOUT a gamut map: out-of-destination-gamut input produces
    // extended (negative or above-one) components on purpose.
    convertWorkingToDestinationLinearRgb(destinationPrimaries, rgb) {
      return vectorOperation(rgb, () =>
        primariesOperation("convertWorkingToDestinationLinearRgb", destinationPrimaries, exports.color_working_to_linear));
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

    // Piecewise transfer functions of the BT.2020 signal of a tagged
    // source and of color(prophoto-rgb).
    decodeRec2020Transfer: exports.rec2020_decode,
    encodeRec2020Transfer: exports.rec2020_encode,
    decodeProphotoTransfer: exports.prophoto_decode,
    encodeProphotoTransfer: exports.prophoto_encode,
    gamutMapCssColor4(workingRgb, destinationPrimaries) {
      return vectorOperation(workingRgb, () =>
        primariesOperation("gamut_map", destinationPrimaries, exports.color_gamut_map_css_color_4));
    },
  };
}
