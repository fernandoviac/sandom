// One host-memory output boundary. Sandom supplies codec/container capability;
// @sandom/color validates and performs the color transform.
import { colorRuntime } from "../wasm/color-runtime.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { FORMAT_CAPABILITIES } from "./format-policy.js";
import { packSignal } from "./packing.js";

function enumValue(runtime, name, value) {
  const result = runtime.abi.enums[name][value];
  if (result === undefined) throw new Error(`color: unknown ${name} ${JSON.stringify(value)}`);
  return result;
}

// The record bytes the library operation `build` writes into `size` bytes
// of its own memory.
function nativeRecord(runtime, size, build) {
  const pointer = runtime.alloc(size);
  try {
    build(pointer, new DataView(runtime.memory.buffer, pointer, size));
    return runtime.copyOut(pointer, size, Uint8Array);
  } finally {
    runtime.free(pointer);
  }
}

// The output policy of `request`: the library's defaults for its transfer
// (color_policy_init) with the request's own values over them.
export function outputPolicyBytes(request) {
  const runtime = colorRuntime();
  const { size, fields } = runtime.abi.records.policy;
  const { colorEncoding, masteringDisplay } = request;
  return nativeRecord(runtime, size, (pointer, view) => {
    runtime.check(runtime.exports.color_policy_init(pointer, enumValue(runtime, "transfer", colorEncoding.transferFunction)));
    view.setUint32(fields.primaries, enumValue(runtime, "primaries", colorEncoding.primaries), true);
    view.setUint32(fields.depth, runtime.abi.depthCodes[request.bitDepth] ?? request.bitDepth, true);
    view.setUint32(fields.alpha, enumValue(runtime, "alpha", request.alphaMode), true);
    view.setUint32(fields.tone, enumValue(runtime, "tone", request.toneMap), true);
    if (request.dynamicRange != null) view.setUint32(fields.range, enumValue(runtime, "range", request.dynamicRange), true);
    if (masteringDisplay?.maxLuminance != null) view.setFloat64(fields.sourcePeak, masteringDisplay.maxLuminance, true);
    if (request.targetPeakLuminance != null) view.setFloat64(fields.targetPeak, request.targetPeakLuminance, true);
    view.setUint32(fields.white, enumValue(runtime, "white", colorEncoding.whitePoint), true);
    view.setFloat64(fields.referenceWhite, colorEncoding.referenceWhiteLuminance, true);
    view.setUint32(fields.gamut, enumValue(runtime, "gamut", request.gamutMap), true);
    view.setUint32(fields.masteringPresent, masteringDisplay == null ? 0 : 1, true);
    if (masteringDisplay?.minLuminance != null) view.setFloat64(fields.sourceMin, masteringDisplay.minLuminance, true);
  });
}

// The capability of the request's output format (FORMAT_CAPABILITIES):
// its depths, encodings, the request's alpha mode and the mastering flag.
export function outputCapabilityBytes(request) {
  const contract = FORMAT_CAPABILITIES[request.format];
  if (!contract) throw new Error(`color: unknown output format ${JSON.stringify(request.format)}`);
  if (!contract.alphaModes.includes(request.alphaMode)) {
    throw new Error(`color: ${request.format} cannot represent ${request.alphaMode} alpha`);
  }
  const runtime = colorRuntime();
  const { exports } = runtime;
  return nativeRecord(runtime, runtime.abi.records.capability.size, (pointer) => {
    runtime.check(exports.color_capability_init(pointer, enumValue(runtime, "alpha", request.alphaMode), contract.requiresMastering ? 1 : 0));
    for (const depth of contract.bitDepths) {
      runtime.check(exports.color_capability_accept_depth(pointer, runtime.abi.depthCodes[depth] ?? depth));
    }
    for (const [primaries, transfer] of contract.encodings) {
      runtime.check(exports.color_capability_accept_encoding(pointer,
        enumValue(runtime, "primaries", primaries), enumValue(runtime, "transfer", transfer)));
    }
  });
}

export function validateNativeOutputPolicy(request) {
  const native = colorRuntime();
  const policy = native.copyIn(outputPolicyBytes(request));
  const capability = native.copyIn(outputCapabilityBytes(request));
  try {
    native.check(native.exports.color_validate_policy(policy, capability));
  } finally {
    native.free(capability);
    native.free(policy);
  }
  return request;
}

export function transformImageForOutput(descriptor, request) {
  const { width, height, colorEncoding } = descriptor;
  const pixels = workingPixels(descriptor);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || width * height > 16777214) throw new Error("output transform dimensions exceed color memory ceiling");
  const native = colorRuntime();
  const working = native.exports.color_working_code(
    enumValue(native, "primaries", colorEncoding.primaries),
    enumValue(native, "transfer", colorEncoding.transferFunction),
  );
  if (working < 0) throw new Error(`output transform: descriptor encoding ${colorEncoding.primaries}/${colorEncoding.transferFunction} is not a working encoding`);
  let input = 0;
  let policy = 0;
  let capability = 0;
  let output = 0;
  try {
    input = native.copyIn(pixels);
    policy = native.copyIn(outputPolicyBytes(request));
    capability = native.copyIn(outputCapabilityBytes(request));
    output = native.alloc(width * height * 16);
    native.check(native.exports.color_transform_output(input, pixels.byteLength, width, height,
      pixels === descriptor.pixels ? descriptor.rowStride ?? width * 16 : width * 16, working, enumValue(native, "alpha", descriptor.alphaMode),
      policy, capability, output, width * height * 16));
    return { pixels: native.copyOut(output, width * height * 16, Float32Array), width, height };
  } finally {
    native.free(output);
    native.free(capability);
    native.free(policy);
    native.free(input);
  }
}

// The float32 working samples of `descriptor`: its own, or those of an
// rgba8 readback (working_samples_from_unorm8 in
// core/dom/image-conversion.watpart).
function workingPixels(descriptor) {
  const { pixels, width } = descriptor;
  if (pixels instanceof Float32Array) return pixels;
  if (!(pixels instanceof Uint8Array)) {
    throw new Error(`output transform takes Float32Array or Uint8Array (rgba8) pixels; it received ${pixels?.constructor?.name ?? pixels}`);
  }
  if ((descriptor.rowStride ?? width * 4) !== width * 4) {
    throw new Error(`output transform takes rgba8 rows of ${width * 4} bytes; this descriptor's rows are ${descriptor.rowStride} bytes`);
  }
  const core = sharedDomCore;
  const [source, count] = core.byteInput(pixels);
  if (core.exports.working_samples_from_unorm8(source, count) !== 1) {
    throw new Error(`output transform: ${count} rgba8 samples exceed the 32-bit working memory; encode a smaller frame`);
  }
  return new Float32Array(core.outputBytes("working_samples_from_unorm8", 0, count * 4).buffer);
}

export function quantizeWorkingPixels(pixels) {
  return pixels instanceof Float32Array ? packSignal(pixels) : pixels;
}
