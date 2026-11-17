import { readPackageAsset } from "../package-assets.js";

const GAIN_MAP_WASM =
  "@sandom/gain-map/gain-map.wasm";

const gainMapWasm = globalThis[Symbol.for("sandom.gainMapBytes")] ??
  await readPackageAsset(new URL(import.meta.resolve(GAIN_MAP_WASM)));

const module = new WebAssembly.Module(gainMapWasm);
const instance = new WebAssembly.Instance(module, {
  gain_map: {
    jpeg_encode() {
      throw new Error(
        "@sandom/gain-map: direct codec callback is not used by Sandom's async JPEG adapter",
      );
    },
    jpeg_decode() {
      throw new Error(
        "@sandom/gain-map: direct codec callback is not used by Sandom's async JPEG adapter",
      );
    },
  },
});
const wasm = instance.exports;
if (wasm.gain_map_init() !== 0 || wasm.gain_map_abi_version() !== 1) {
  throw new Error("@sandom/gain-map ABI version 1 failed to initialize");
}

// The record layouts and codes of the library's ABI, read from its exported
// globals (src/gain-map-abi.watpart in @sandom/gain-map).
const abi = (name) => wasm[`gain_map_${name}`].value;
const abiRecord = (prefix, names) =>
  Object.freeze(Object.fromEntries(Object.entries(names).map(([key, name]) => [key, abi(`${prefix}${name}`)])));
const IMAGE = abiRecord("image_", {
  SIZE: "size", DATA: "data_offset", DATA_LENGTH: "data_length_offset", WIDTH: "width_offset",
  HEIGHT: "height_offset", ROW_STRIDE: "row_stride_offset", SAMPLE_TYPE: "sample_type_offset",
  CHANNEL_LAYOUT: "channel_layout_offset", FLAGS: "flags_offset",
});
const IMAGE_FLAG = abiRecord("image_flag_", { SRGB: "srgb", OPAQUE: "opaque" });
const SAMPLE = Object.freeze({ uint8: abi("sample_u8"), uint16: abi("sample_u16"), float32: abi("sample_f32") });
const LAYOUT = Object.freeze({ rgb: abi("layout_rgb"), rgba: abi("layout_rgba") });
export const METADATA = abiRecord("metadata_", {
  SIZE: "size", MIN: "min_offset", MAX: "max_offset", GAMMA: "gamma_offset", BASE: "base_offset",
  ALTERNATE: "alternate_offset", HEADROOM_MIN: "headroom_min_offset", HEADROOM_MAX: "headroom_max_offset",
  FLAGS: "flags_offset", PROFILE: "profile_offset", CHANNEL_COUNT: "channel_count_offset",
  WRITER_VERSION: "writer_version_offset", FLAG_BASE_COLOR_SPACE: "flag_base_color_space",
  PRESENCE_ISO: "presence_iso", PRESENCE_ULTRA_HDR: "presence_ultra_hdr",
});
// The error codes whose field names a metadata record offset.
export const GAIN_MAP_ERROR = abiRecord("error_", { NUMERIC: "numeric", RECORD: "record" });
const PROFILE = abiRecord("profile_", { GENERATED: "generated", ISO: "iso", ULTRA_HDR: "ultra_hdr" });
const OPTIONS = abiRecord("options_", {
  SIZE: "size", SCALE: "scale_offset", BASE_QUALITY: "base_quality_offset", MAP_QUALITY: "map_quality_offset",
  GAMMA: "gamma_offset", BASE: "base_offset", ALTERNATE: "alternate_offset",
  MAXIMUM_DISPLAY_BOOST: "maximum_display_boost_offset",
});
const SUMMARY = abiRecord("error_", {
  SIZE: "summary_size", MAXIMUM: "maximum_offset", MEAN: "mean_offset", RMS: "rms_offset",
  LUMINANCE: "luminance_offset", CLIPPED: "clipped_offset", CHANNEL_ORDER: "channel_order_offset",
});
const INSPECTION = abiRecord("inspection_", {
  SIZE: "size", IS_GAIN_MAP: "is_gain_map_offset", COMPATIBILITY: "compatibility_offset",
  METADATA_SOURCE: "metadata_source_offset", PRIMARY: "primary_offset", PRIMARY_LENGTH: "primary_length_offset",
  PRIMARY_WIDTH: "primary_width_offset", PRIMARY_HEIGHT: "primary_height_offset",
  PRIMARY_CHANNELS: "primary_channels_offset", MAP: "map_offset", MAP_LENGTH: "map_length_offset",
  MAP_WIDTH: "map_width_offset", MAP_HEIGHT: "map_height_offset", MAP_CHANNELS: "map_channels_offset",
  MPF_COUNT: "mpf_count_offset", MPF_PAYLOAD: "mpf_payload_offset", MPF_PAYLOAD_LENGTH: "mpf_payload_length_offset",
});
const MPF_ENTRY = abiRecord("mpf_entry_", {
  SIZE: "size", ATTRIBUTES: "attributes_offset", BYTE_LENGTH: "byte_length_offset",
  DATA_OFFSET: "data_offset_offset", ABSOLUTE_OFFSET: "absolute_offset_offset",
});
const COMPATIBILITY = Object.freeze(Object.fromEntries([
  [abi("compatibility_ordinary"), "ordinary-jpeg"],
  [abi("compatibility_iso"), "iso-only"],
  [abi("compatibility_ultra_hdr"), "ultra-hdr-only"],
  [abi("compatibility_dual"), "iso-and-ultra-hdr"],
]));
const F32 = Float32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;

class Arena {
  #pointers = [];

  allocate(length) {
    const pointer = wasm.gain_map_alloc(length);
    if (pointer === 0) throw operationError("allocation");
    this.#pointers.push(pointer);
    return pointer;
  }

  bytes(value) {
    const source = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const pointer = this.allocate(source.byteLength);
    new Uint8Array(wasm.memory.buffer, pointer, source.byteLength).set(source);
    return Object.freeze({ pointer, length: source.byteLength });
  }

  close() {
    for (let index = this.#pointers.length - 1; index >= 0; index--) {
      wasm.gain_map_free(this.#pointers[index]);
    }
    this.#pointers.length = 0;
  }
}

function operationError(operation) {
  const code = wasm.gain_map_error_code();
  const field = wasm.gain_map_error_field();
  const pointer = wasm.gain_map_error_text(code);
  const text = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, pointer, wasm.gain_map_error_text_length()));
  const error = new Error(`${operation}: ${text} (gain-map error ${code}, field ${field})`);
  error.gainMapCode = code;
  error.gainMapField = field;
  return error;
}

function status(operation, value) {
  if (value !== 0) throw operationError(operation);
}

// The eight-bit codestream input (gain_map_quantize_rgba8) of an f32 image
// with `channels` (3 or 4) channels per pixel: RGBA8, alpha 255.
export function quantizeRgba8WithWasm(image, channels) {
  const arena = new Arena();
  try {
    const count = image.width * image.height;
    const source = arena.bytes(image.pixels.subarray(0, count * channels));
    const target = arena.allocate(count * 4);
    status("gain map quantization", wasm.gain_map_quantize_rgba8(source.pointer, count, channels, target));
    return new Uint8ClampedArray(new Uint8Array(wasm.memory.buffer, target, count * 4));
  } finally {
    arena.close();
  }
}

// The decoded eight-bit gain map's RGBA8 pixels as f32 RGB
// (gain_map_dequantize_rgb).
export function dequantizeRgbWithWasm(pixels, count) {
  const arena = new Arena();
  try {
    const source = arena.bytes(pixels.subarray(0, count * 4));
    const target = arena.allocate(count * 12);
    status("gain map dequantization", wasm.gain_map_dequantize_rgb(source.pointer, count, target));
    return new Float32Array(new Float32Array(wasm.memory.buffer, target, count * 3));
  } finally {
    arena.close();
  }
}

function writeImageRecord(arena, descriptor) {
  const data = arena.bytes(descriptor.pixels);
  const record = arena.allocate(IMAGE.SIZE);
  const view = new DataView(wasm.memory.buffer);
  const sample = SAMPLE[descriptor.sampleType];
  const layout = LAYOUT[descriptor.channelLayout];
  if (sample === undefined || layout === undefined) {
    throw new Error(
      `@sandom/gain-map: unsupported ${descriptor.sampleType}/${descriptor.channelLayout} image`,
    );
  }
  view.setUint32(record + IMAGE.DATA, data.pointer, true);
  view.setUint32(record + IMAGE.DATA_LENGTH, data.length, true);
  view.setUint32(record + IMAGE.WIDTH, descriptor.width, true);
  view.setUint32(record + IMAGE.HEIGHT, descriptor.height, true);
  view.setUint32(record + IMAGE.ROW_STRIDE, descriptor.rowStride, true);
  view.setUint32(record + IMAGE.SAMPLE_TYPE, sample, true);
  view.setUint32(record + IMAGE.CHANNEL_LAYOUT, layout, true);
  let flags = descriptor.colorEncoding?.transferFunction === "srgb" ? IMAGE_FLAG.SRGB : 0;
  if (descriptor.alphaMode === "opaque") flags |= IMAGE_FLAG.OPAQUE;
  view.setUint32(record + IMAGE.FLAGS, flags, true);
  return Object.freeze({ record, data: data.pointer, length: data.length });
}

function writeOutputRecord(arena, length) {
  const data = arena.allocate(length);
  const record = arena.allocate(IMAGE.SIZE);
  const view = new DataView(wasm.memory.buffer);
  view.setUint32(record + IMAGE.DATA, data, true);
  view.setUint32(record + IMAGE.DATA_LENGTH, length, true);
  return Object.freeze({ record, data, length });
}

function readOutputImage(output, colorEncoding, alphaMode) {
  const view = new DataView(wasm.memory.buffer);
  const width = view.getUint32(output.record + IMAGE.WIDTH, true);
  const height = view.getUint32(output.record + IMAGE.HEIGHT, true);
  const rowStride = view.getUint32(output.record + IMAGE.ROW_STRIDE, true);
  const layout = view.getUint32(output.record + IMAGE.CHANNEL_LAYOUT, true) === LAYOUT.rgb
    ? "rgb"
    : "rgba";
  const samples = rowStride * height / F32;
  const pixels = new Float32Array(samples);
  pixels.set(new Float32Array(wasm.memory.buffer, output.data, samples));
  return Object.freeze({
    width,
    height,
    rowStride,
    pixels,
    channelLayout: layout,
    sampleType: "float32",
    bitsPerSample: 32,
    colorEncoding,
    alphaMode,
    metadata: Object.freeze({}),
  });
}

function writeMetadata(arena, metadata) {
  const pointer = arena.allocate(METADATA.SIZE);
  const view = new DataView(wasm.memory.buffer);
  for (
    const [offset, field] of [
      [METADATA.MIN, "gainMapMin"],
      [METADATA.MAX, "gainMapMax"],
      [METADATA.GAMMA, "gainMapGamma"],
      [METADATA.BASE, "baseOffset"],
      [METADATA.ALTERNATE, "alternateOffset"],
    ]
  ) {
    for (let channel = 0; channel < 3; channel++) {
      view.setFloat64(
        pointer + offset + channel * F64,
        metadata[field][channel],
        true,
      );
    }
  }
  view.setFloat64(pointer + METADATA.HEADROOM_MIN, metadata.minimumDisplayHeadroom, true);
  view.setFloat64(pointer + METADATA.HEADROOM_MAX, metadata.maximumDisplayHeadroom, true);
  view.setUint32(
    pointer + METADATA.FLAGS,
    metadata.useBaseColorSpace === false ? 0 : METADATA.FLAG_BASE_COLOR_SPACE,
    true,
  );
  view.setUint32(
    pointer + METADATA.PROFILE,
    metadata.profile === "iso-21496-1"
      ? PROFILE.ISO
      : metadata.profile === "ultra-hdr-v1"
      ? PROFILE.ULTRA_HDR
      : PROFILE.GENERATED,
    true,
  );
  view.setUint32(pointer + METADATA.CHANNEL_COUNT, metadata.channelCount ?? 3, true);
  view.setUint32(pointer + METADATA.WRITER_VERSION, metadata.writerVersion ?? 0, true);
  return pointer;
}

function readMetadata(pointer, source = "generated") {
  const view = new DataView(wasm.memory.buffer);
  const array = (offset) =>
    Object.freeze(
      [0, 1, 2].map((channel) =>
        view.getFloat64(pointer + offset + channel * F64, true)
      ),
    );
  return Object.freeze({
    profile: source,
    ...(source === "iso-21496-1"
      ? {
        minimumVersion: 0,
        writerVersion: view.getUint32(pointer + METADATA.WRITER_VERSION, true),
      }
      : {}),
    channelCount: view.getUint32(pointer + METADATA.CHANNEL_COUNT, true),
    useBaseColorSpace: view.getUint32(pointer + METADATA.FLAGS, true) === METADATA.FLAG_BASE_COLOR_SPACE,
    gainMapMin: array(METADATA.MIN),
    gainMapMax: array(METADATA.MAX),
    gainMapGamma: array(METADATA.GAMMA),
    baseOffset: array(METADATA.BASE),
    alternateOffset: array(METADATA.ALTERNATE),
    minimumDisplayHeadroom: view.getFloat64(pointer + METADATA.HEADROOM_MIN, true),
    maximumDisplayHeadroom: view.getFloat64(pointer + METADATA.HEADROOM_MAX, true),
    baseRenditionIsHighDynamicRange: false,
  });
}

function readSummary(pointer) {
  const view = new DataView(wasm.memory.buffer);
  return Object.freeze({
    maximumAbsoluteChannelError: view.getFloat64(pointer + SUMMARY.MAXIMUM, true),
    meanAbsoluteChannelError: view.getFloat64(pointer + SUMMARY.MEAN, true),
    rootMeanSquareChannelError: view.getFloat64(pointer + SUMMARY.RMS, true),
    meanRelativeLuminanceError: view.getFloat64(pointer + SUMMARY.LUMINANCE, true),
    clippedPixelCount: view.getUint32(pointer + SUMMARY.CLIPPED, true),
    channelOrderErrorCount: view.getUint32(pointer + SUMMARY.CHANNEL_ORDER, true),
  });
}

export function generateWithWasm(descriptor, options, sourcePeak, encodings) {
  const arena = new Arena();
  try {
    const alternate = writeImageRecord(arena, descriptor);
    const baseOutput = writeOutputRecord(
      arena,
      descriptor.width * descriptor.height * 4 * F32,
    );
    status(
      "gain map base preparation",
      wasm.gain_map_prepare_base(
        alternate.record,
        sourcePeak,
        baseOutput.record,
      ),
    );
    const baseImage = readOutputImage(baseOutput, encodings.base, "straight");
    const base = writeImageRecord(arena, baseImage);
    const optionRecord = arena.allocate(OPTIONS.SIZE);
    status(
      "gain map option initialization",
      wasm.gain_map_options_init(optionRecord),
    );
    const view = new DataView(wasm.memory.buffer);
    view.setUint32(optionRecord + OPTIONS.SCALE, options.gainMapScale, true);
    view.setUint32(optionRecord + OPTIONS.BASE_QUALITY, options.baseQuality, true);
    view.setUint32(optionRecord + OPTIONS.MAP_QUALITY, options.gainMapQuality, true);
    for (
      const [offset, values] of [[OPTIONS.GAMMA, options.mapGamma], [
        OPTIONS.BASE,
        options.baseOffset,
      ], [OPTIONS.ALTERNATE, options.alternateOffset]]
    ) {
      for (let channel = 0; channel < 3; channel++) {
        view.setFloat64(
          optionRecord + offset + channel * F64,
          values[channel],
          true,
        );
      }
    }
    view.setFloat64(optionRecord + OPTIONS.MAXIMUM_DISPLAY_BOOST, options.maximumDisplayBoost, true);
    const mapWidth = wasm.gain_map_map_extent(descriptor.width, options.gainMapScale);
    const mapHeight = wasm.gain_map_map_extent(descriptor.height, options.gainMapScale);
    const gainOutput = writeOutputRecord(arena, mapWidth * mapHeight * 3 * F32);
    const metadataPointer = arena.allocate(METADATA.SIZE);
    status(
      "gain map generation",
      wasm.gain_map_generate(
        base.record,
        alternate.record,
        optionRecord,
        gainOutput.record,
        metadataPointer,
      ),
    );
    const summary = arena.allocate(SUMMARY.SIZE);
    const metadata = readMetadata(metadataPointer);
    const minimumDisplayHeadroom = metadata.minimumDisplayHeadroom;
    const maximumDisplayHeadroom = metadata.maximumDisplayHeadroom;
    const verificationBoosts = Object.freeze([
      1,
      2 ** minimumDisplayHeadroom,
      2 ** ((minimumDisplayHeadroom + maximumDisplayHeadroom) / 2),
      2 ** maximumDisplayHeadroom,
      2 ** (maximumDisplayHeadroom + 1),
    ]);
    const byDisplayBoost = Object.freeze(
      verificationBoosts.map((displayBoost) => {
        status(
          "gain map generation error measurement",
          wasm.gain_map_measure_generation_error(
            base.record,
            alternate.record,
            gainOutput.record,
            metadataPointer,
            displayBoost,
            summary,
          ),
        );
        return Object.freeze({ displayBoost, ...readSummary(summary) });
      }),
    );
    return Object.freeze({
      baseImage,
      alternateImage: descriptor,
      gainMapImage: readOutputImage(gainOutput, encodings.gain, "opaque"),
      metadata,
      verificationBoosts,
      errorSummary: Object.freeze({
        stage: "eight-bit-map-quantization",
        byDisplayBoost,
      }),
    });
  } finally {
    arena.close();
  }
}

export function reconstructWithWasm(
  baseImage,
  gainMapImage,
  metadata,
  displayBoost,
  outputEncoding,
) {
  const arena = new Arena();
  try {
    const base = writeImageRecord(arena, baseImage);
    const gain = writeImageRecord(arena, gainMapImage);
    const metadataPointer = writeMetadata(arena, metadata);
    const output = writeOutputRecord(
      arena,
      baseImage.width * baseImage.height * 4 * F32,
    );
    status(
      "gain map reconstruction",
      wasm.gain_map_reconstruct(
        base.record,
        gain.record,
        metadataPointer,
        displayBoost,
        output.record,
      ),
    );
    return readOutputImage(output, outputEncoding, "straight");
  } finally {
    arena.close();
  }
}

export function measureGenerationWithWasm(
  baseImage,
  alternateImage,
  gainMapImage,
  metadata,
  displayBoost,
) {
  const arena = new Arena();
  try {
    const base = writeImageRecord(arena, baseImage);
    const alternate = writeImageRecord(arena, alternateImage);
    const gain = writeImageRecord(arena, gainMapImage);
    const metadataPointer = writeMetadata(arena, metadata);
    const summary = arena.allocate(SUMMARY.SIZE);
    status(
      "gain map generation error measurement",
      wasm.gain_map_measure_generation_error(
        base.record,
        alternate.record,
        gain.record,
        metadataPointer,
        displayBoost,
        summary,
      ),
    );
    return readSummary(summary);
  } finally {
    arena.close();
  }
}

export function measureWithWasm(referenceImage, reconstructedImage) {
  const arena = new Arena();
  try {
    const reference = writeImageRecord(arena, referenceImage);
    const reconstructed = writeImageRecord(arena, reconstructedImage);
    const summary = arena.allocate(SUMMARY.SIZE);
    status(
      "gain map error measurement",
      wasm.gain_map_measure_error(
        reference.record,
        reconstructed.record,
        summary,
      ),
    );
    return readSummary(summary);
  } finally {
    arena.close();
  }
}

export function inspectWithWasm(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("JPEG gain map inspection requires Uint8Array bytes");
  }
  const arena = new Arena();
  try {
    const input = arena.bytes(bytes);
    const inspection = arena.allocate(INSPECTION.SIZE);
    const metadataPointer = arena.allocate(METADATA.SIZE);
    const isoMetadataPointer = arena.allocate(METADATA.SIZE);
    const ultraHdrMetadataPointer = arena.allocate(METADATA.SIZE);
    const metadataPresencePointer = arena.allocate(U32);
    status(
      "JPEG gain map inspection",
      wasm.gain_map_inspect_profiles(
        input.pointer,
        input.length,
        inspection,
        metadataPointer,
        isoMetadataPointer,
        ultraHdrMetadataPointer,
        metadataPresencePointer,
      ),
    );
    let view = new DataView(wasm.memory.buffer);
    const adaptive = view.getUint32(inspection + INSPECTION.IS_GAIN_MAP, true) === 1;
    const compatibility = view.getUint32(inspection + INSPECTION.COMPATIBILITY, true);
    const sourceCode = view.getUint32(inspection + INSPECTION.METADATA_SOURCE, true);
    const primaryImage = Object.freeze({
      offset: view.getUint32(inspection + INSPECTION.PRIMARY, true),
      byteLength: view.getUint32(inspection + INSPECTION.PRIMARY_LENGTH, true),
      width: view.getUint32(inspection + INSPECTION.PRIMARY_WIDTH, true),
      height: view.getUint32(inspection + INSPECTION.PRIMARY_HEIGHT, true),
      channelCount: view.getUint32(inspection + INSPECTION.PRIMARY_CHANNELS, true),
    });
    const mpfCount = view.getUint32(inspection + INSPECTION.MPF_COUNT, true);
    let packageIndex = null;
    if (mpfCount > 0) {
      const payloadOffset = view.getUint32(inspection + INSPECTION.MPF_PAYLOAD, true);
      const payloadLength = view.getUint32(inspection + INSPECTION.MPF_PAYLOAD_LENGTH, true);
      const entriesPointer = arena.allocate(mpfCount * MPF_ENTRY.SIZE);
      const countPointer = arena.allocate(U32);
      status(
        "JPEG MPF inspection",
        wasm.gain_map_mpf_inspect(
          input.pointer,
          input.length,
          0,
          entriesPointer,
          mpfCount,
          countPointer,
        ),
      );
      view = new DataView(wasm.memory.buffer);
      const imageCount = view.getUint32(countPointer, true);
      const entries = Object.freeze(
        Array.from({ length: imageCount }, (_, index) => {
          const pointer = entriesPointer + index * MPF_ENTRY.SIZE;
          return Object.freeze({
            index,
            attributes: view.getUint32(pointer + MPF_ENTRY.ATTRIBUTES, true),
            byteLength: view.getUint32(pointer + MPF_ENTRY.BYTE_LENGTH, true),
            dataOffset: view.getUint32(pointer + MPF_ENTRY.DATA_OFFSET, true),
            absoluteOffset: view.getUint32(pointer + MPF_ENTRY.ABSOLUTE_OFFSET, true),
          });
        }),
      );
      packageIndex = Object.freeze({
        segment: Object.freeze({
          marker: 0xe2,
          markerOffset: payloadOffset - 4,
          payloadOffset,
          payloadLength,
        }),
        imageCount,
        entries,
      });
    }
    if (!adaptive) {
      return Object.freeze({
        isGainMap: false,
        compatibilityProfile: COMPATIBILITY[abi("compatibility_ordinary")],
        primaryImage,
        packageIndex,
      });
    }
    const source = sourceCode === PROFILE.ISO ? "iso-21496-1" : "ultra-hdr-v1";
    const metadata = readMetadata(metadataPointer, source);
    const gainMapImage = Object.freeze({
      offset: view.getUint32(inspection + INSPECTION.MAP, true),
      byteLength: view.getUint32(inspection + INSPECTION.MAP_LENGTH, true),
      width: view.getUint32(inspection + INSPECTION.MAP_WIDTH, true),
      height: view.getUint32(inspection + INSPECTION.MAP_HEIGHT, true),
      channelCount: view.getUint32(inspection + INSPECTION.MAP_CHANNELS, true),
    });
    const metadataPresence = view.getUint32(metadataPresencePointer, true);
    const isoMetadata = (metadataPresence & METADATA.PRESENCE_ISO) !== 0
      ? readMetadata(isoMetadataPointer, "iso-21496-1")
      : null;
    const ultraHdrMetadata = (metadataPresence & METADATA.PRESENCE_ULTRA_HDR) !== 0
      ? readMetadata(ultraHdrMetadataPointer, "ultra-hdr-v1")
      : null;
    return Object.freeze({
      isGainMap: true,
      compatibilityProfile: COMPATIBILITY[compatibility],
      selectedMetadataSource: source,
      metadata,
      isoMetadata,
      ultraHdrMetadata,
      primaryImage,
      gainMapImage,
      packageIndex,
    });
  } finally {
    arena.close();
  }
}

export function packageWithWasm(baseJpeg, gainJpeg, metadata) {
  const arena = new Arena();
  try {
    const base = arena.bytes(baseJpeg);
    const gain = arena.bytes(gainJpeg);
    const metadataPointer = writeMetadata(arena, metadata);
    let capacity = base.length + gain.length + 8192;
    let output = arena.allocate(capacity);
    let length = wasm.gain_map_package(
      base.pointer,
      base.length,
      gain.pointer,
      gain.length,
      metadataPointer,
      output,
      capacity,
    );
    if (
      length === 0 &&
      wasm.gain_map_error_code() === wasm.gain_map_error_capacity.value
    ) {
      capacity = wasm.gain_map_required_size();
      output = arena.allocate(capacity);
      length = wasm.gain_map_package(
        base.pointer,
        base.length,
        gain.pointer,
        gain.length,
        metadataPointer,
        output,
        capacity,
      );
    }
    if (length === 0) throw operationError("JPEG gain map packaging");
    return new Uint8Array(wasm.memory.buffer, output, length).slice();
  } finally {
    arena.close();
  }
}
