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

const SAMPLE = Object.freeze({ uint8: 0, uint16: 1, float32: 2 });
const LAYOUT = Object.freeze({ rgb: 0, rgba: 1 });
const COMPATIBILITY = Object.freeze([
  "ordinary-jpeg",
  "iso-only",
  "ultra-hdr-only",
  "iso-and-ultra-hdr",
]);

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
  const names = [
    "success",
    "not initialized",
    "memory span",
    "alignment",
    "dimensions",
    "layout",
    "sample type",
    "numeric value",
    "record",
    "capacity",
    "allocation",
    "stale allocation",
    "ISO version",
    "ISO flags",
    "truncated input",
    "rational",
    "XMP",
    "JPEG",
    "MPF",
    "adaptive profile",
    "metadata contradiction",
    "JPEG codec",
    "integer overflow",
    "trailing bytes",
    "duplicate metadata",
    "unsupported feature",
  ];
  const detail = names[code] ?? `error ${code}`;
  const legacy = code === 20
    ? "ISO 21496-1 and Ultra HDR metadata contradict each other"
    : code === 18
    ? "MPF entry offset or length is invalid"
    : code === 17
    ? "JPEG APP segment or entropy structure is invalid"
    : detail;
  const error = new Error(
    `${operation}: ${legacy} (gain-map error ${code}, field ${field})`,
  );
  error.gainMapCode = code;
  error.gainMapField = field;
  return error;
}

function status(operation, value) {
  if (value !== 0) throw operationError(operation);
}

function writeImageRecord(arena, descriptor) {
  const data = arena.bytes(descriptor.pixels);
  const record = arena.allocate(32);
  const view = new DataView(wasm.memory.buffer);
  const sample = SAMPLE[descriptor.sampleType];
  const layout = LAYOUT[descriptor.channelLayout];
  if (sample === undefined || layout === undefined) {
    throw new Error(
      `@sandom/gain-map: unsupported ${descriptor.sampleType}/${descriptor.channelLayout} image`,
    );
  }
  view.setUint32(record, data.pointer, true);
  view.setUint32(record + 4, data.length, true);
  view.setUint32(record + 8, descriptor.width, true);
  view.setUint32(record + 12, descriptor.height, true);
  view.setUint32(record + 16, descriptor.rowStride, true);
  view.setUint32(record + 20, sample, true);
  view.setUint32(record + 24, layout, true);
  let flags = descriptor.colorEncoding?.transferFunction === "srgb" ? 1 : 0;
  if (descriptor.alphaMode === "opaque") flags |= 2;
  view.setUint32(record + 28, flags, true);
  return Object.freeze({ record, data: data.pointer, length: data.length });
}

function writeOutputRecord(arena, length) {
  const data = arena.allocate(length);
  const record = arena.allocate(32);
  const view = new DataView(wasm.memory.buffer);
  view.setUint32(record, data, true);
  view.setUint32(record + 4, length, true);
  return Object.freeze({ record, data, length });
}

function readOutputImage(output, colorEncoding, alphaMode) {
  const view = new DataView(wasm.memory.buffer);
  const width = view.getUint32(output.record + 8, true);
  const height = view.getUint32(output.record + 12, true);
  const rowStride = view.getUint32(output.record + 16, true);
  const layout = view.getUint32(output.record + 24, true) === 0
    ? "rgb"
    : "rgba";
  const samples = rowStride * height / 4;
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
  const pointer = arena.allocate(152);
  const view = new DataView(wasm.memory.buffer);
  for (
    const [offset, field] of [
      [0, "gainMapMin"],
      [24, "gainMapMax"],
      [48, "gainMapGamma"],
      [72, "baseOffset"],
      [96, "alternateOffset"],
    ]
  ) {
    for (let channel = 0; channel < 3; channel++) {
      view.setFloat64(
        pointer + offset + channel * 8,
        metadata[field][channel],
        true,
      );
    }
  }
  view.setFloat64(pointer + 120, metadata.minimumDisplayHeadroom, true);
  view.setFloat64(pointer + 128, metadata.maximumDisplayHeadroom, true);
  view.setUint32(
    pointer + 136,
    metadata.useBaseColorSpace === false ? 0 : 1,
    true,
  );
  view.setUint32(
    pointer + 140,
    metadata.profile === "iso-21496-1"
      ? 1
      : metadata.profile === "ultra-hdr-v1"
      ? 2
      : 0,
    true,
  );
  view.setUint32(pointer + 144, metadata.channelCount ?? 3, true);
  view.setUint32(pointer + 148, metadata.writerVersion ?? 0, true);
  return pointer;
}

function readMetadata(pointer, source = "generated") {
  const view = new DataView(wasm.memory.buffer);
  const array = (offset) =>
    Object.freeze(
      [0, 1, 2].map((channel) =>
        view.getFloat64(pointer + offset + channel * 8, true)
      ),
    );
  return Object.freeze({
    profile: source,
    ...(source === "iso-21496-1"
      ? {
        minimumVersion: 0,
        writerVersion: view.getUint32(pointer + 148, true),
      }
      : {}),
    channelCount: view.getUint32(pointer + 144, true),
    useBaseColorSpace: view.getUint32(pointer + 136, true) === 1,
    gainMapMin: array(0),
    gainMapMax: array(24),
    gainMapGamma: array(48),
    baseOffset: array(72),
    alternateOffset: array(96),
    minimumDisplayHeadroom: view.getFloat64(pointer + 120, true),
    maximumDisplayHeadroom: view.getFloat64(pointer + 128, true),
    baseRenditionIsHighDynamicRange: false,
  });
}

function readSummary(pointer) {
  const view = new DataView(wasm.memory.buffer);
  return Object.freeze({
    maximumAbsoluteChannelError: view.getFloat64(pointer, true),
    meanAbsoluteChannelError: view.getFloat64(pointer + 8, true),
    rootMeanSquareChannelError: view.getFloat64(pointer + 16, true),
    meanRelativeLuminanceError: view.getFloat64(pointer + 24, true),
    clippedPixelCount: view.getUint32(pointer + 32, true),
    channelOrderErrorCount: view.getUint32(pointer + 36, true),
  });
}

export function generateWithWasm(descriptor, options, sourcePeak, encodings) {
  const arena = new Arena();
  try {
    const alternate = writeImageRecord(arena, descriptor);
    const baseOutput = writeOutputRecord(
      arena,
      descriptor.width * descriptor.height * 16,
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
    const optionRecord = arena.allocate(104);
    status(
      "gain map option initialization",
      wasm.gain_map_options_init(optionRecord),
    );
    const view = new DataView(wasm.memory.buffer);
    view.setUint32(optionRecord, options.gainMapScale, true);
    view.setUint32(optionRecord + 4, options.baseQuality, true);
    view.setUint32(optionRecord + 8, options.gainMapQuality, true);
    for (
      const [offset, values] of [[16, options.mapGamma], [
        40,
        options.baseOffset,
      ], [64, options.alternateOffset]]
    ) {
      for (let channel = 0; channel < 3; channel++) {
        view.setFloat64(
          optionRecord + offset + channel * 8,
          values[channel],
          true,
        );
      }
    }
    view.setFloat64(optionRecord + 88, options.maximumDisplayBoost, true);
    const mapWidth = Math.ceil(descriptor.width / options.gainMapScale);
    const mapHeight = Math.ceil(descriptor.height / options.gainMapScale);
    const gainOutput = writeOutputRecord(arena, mapWidth * mapHeight * 12);
    const metadataPointer = arena.allocate(152);
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
    const summary = arena.allocate(40);
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
      baseImage.width * baseImage.height * 16,
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
    const summary = arena.allocate(40);
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
    const summary = arena.allocate(40);
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
    const inspection = arena.allocate(64);
    const metadataPointer = arena.allocate(152);
    const isoMetadataPointer = arena.allocate(152);
    const ultraHdrMetadataPointer = arena.allocate(152);
    const metadataPresencePointer = arena.allocate(4);
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
    const adaptive = view.getUint32(inspection, true) === 1;
    const compatibility = view.getUint32(inspection + 4, true);
    const sourceCode = view.getUint32(inspection + 8, true);
    const primaryImage = Object.freeze({
      offset: view.getUint32(inspection + 12, true),
      byteLength: view.getUint32(inspection + 16, true),
      width: view.getUint32(inspection + 20, true),
      height: view.getUint32(inspection + 24, true),
      channelCount: view.getUint32(inspection + 28, true),
    });
    const mpfCount = view.getUint32(inspection + 52, true);
    let packageIndex = null;
    if (mpfCount > 0) {
      const payloadOffset = view.getUint32(inspection + 56, true);
      const payloadLength = view.getUint32(inspection + 60, true);
      const entriesPointer = arena.allocate(mpfCount * 16);
      const countPointer = arena.allocate(4);
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
          const pointer = entriesPointer + index * 16;
          return Object.freeze({
            index,
            attributes: view.getUint32(pointer, true),
            byteLength: view.getUint32(pointer + 4, true),
            dataOffset: view.getUint32(pointer + 8, true),
            absoluteOffset: view.getUint32(pointer + 12, true),
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
        compatibilityProfile: COMPATIBILITY[0],
        primaryImage,
        packageIndex,
      });
    }
    const source = sourceCode === 1 ? "iso-21496-1" : "ultra-hdr-v1";
    const metadata = readMetadata(metadataPointer, source);
    const gainMapImage = Object.freeze({
      offset: view.getUint32(inspection + 32, true),
      byteLength: view.getUint32(inspection + 36, true),
      width: view.getUint32(inspection + 40, true),
      height: view.getUint32(inspection + 44, true),
      channelCount: view.getUint32(inspection + 48, true),
    });
    const metadataPresence = view.getUint32(metadataPresencePointer, true);
    const isoMetadata = (metadataPresence & 1) !== 0
      ? readMetadata(isoMetadataPointer, "iso-21496-1")
      : null;
    const ultraHdrMetadata = (metadataPresence & 2) !== 0
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
