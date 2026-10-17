// Sandom's handwritten ABI constants for @sandom/png, ABI version 1. Mirrors
// the package's src/abi.json (fields as byte offsets, index × 4, plus
// recordBytes); test/images/png_decode_test.js holds the two equal.
export const PNG_ABI = Object.freeze({
  "version": 1,
  "endianness": "little",
  "alignment": 4,
  "limits": {
    "inputBytes": 67108864,
    "decodedBytes": 268435456,
    "profileBytes": 4194304,
    "outputBytes": 285212672,
    "retainedBytes": 536870912,
    "maximumPages": 16384
  },
  "enums": {
    "primaries": [
      "srgb",
      "display-p3",
      "rec2020",
      "a98-rgb",
      "prophoto-rgb",
      "xyz-d50",
      "xyz-d65"
    ],
    "transfer": [
      "srgb",
      "linear",
      "gamma",
      "pq",
      "hlg",
      "rec2020",
      "prophoto-rgb",
      "icc"
    ],
    "sampleType": [
      "uint8",
      "uint16",
      "float16",
      "float32"
    ],
    "channelLayout": [
      "gray",
      "gray-alpha",
      "rgb",
      "rgba"
    ],
    "alphaMode": [
      "opaque",
      "straight",
      "premultiplied"
    ],
    "whitePoint": [
      "d50",
      "d65"
    ]
  },
  "fields": {
    "version": 0,
    "width": 4,
    "height": 8,
    "rowStride": 12,
    "sampleType": 16,
    "bitsPerSample": 20,
    "channelLayout": 24,
    "alphaMode": 28,
    "primaries": 32,
    "transfer": 36,
    "whitePoint": 40,
    "flags": 44,
    "gammaLow": 48,
    "gammaHigh": 52,
    "pixelOffset": 56,
    "pixelLength": 60,
    "profileOffset": 64,
    "profileLength": 68,
    "primariesCode": 72,
    "transferCode": 76,
    "redX": 80,
    "redY": 84,
    "greenX": 88,
    "greenY": 92,
    "blueX": 96,
    "blueY": 100,
    "whiteX": 104,
    "whiteY": 108,
    "maximumLuminance": 112,
    "minimumLuminance": 116,
    "maximumContentLightLevel": 120,
    "maximumFrameAverageLightLevel": 124,
    "mode": 128,
    "pixelHandle": 132,
    "profileHandle": 136,
    "compressionLevel": 140,
    "masteringMaxLow": 144,
    "masteringMaxHigh": 148,
    "masteringMinLow": 152,
    "masteringMinHigh": 156,
    "contentMaxLow": 160,
    "contentMaxHigh": 164,
    "frameAverageLow": 168,
    "frameAverageHigh": 172
  },
  "flags": {
    "assumedSrgb": 1,
    "assumedSrgbTransfer": 2,
    "iccProfile": 4,
    "codedColorVolume": 8,
    "masteringDisplay": 16,
    "contentLightLevel": 32
  },
  "status": {
    "ok": 0,
    "malformed": 1,
    "unsupported": 2,
    "invalidRequest": 3,
    "resourceLimit": 4,
    "allocationFailure": 5,
    "abiMismatch": 6,
    "invalidHandle": 7,
    "internalFailure": 8
  },
  "errorRecord": [
    "status",
    "domain",
    "field",
    "offset"
  ],
  "errorDomains": {
    "abi": 0,
    "pngChunk": 1,
    "sample": 2,
    "request": 3
  },
  "ownership": "Monotonic non-reused handles scoped to one module instance; role-checked input/result allocations. Public host handles are private owner-branded objects (JS) or encapsulated store-bound IDs (Rust), checked before dispatch. Raw numeric ABI callers must maintain their own instance identity and never transfer an integer handle between stores; native checks role/liveness. Inputs borrowed for one synchronous call. Retained result owns record/pixel/profile bytes until png_release. All views reacquired after calls; public hosts copy before release. Release of absent handle rejects. Offset/length input spans are relative to named input handle; result spans are absolute module offsets.",
  "validationOrder": [
    "ABI version and handle roles",
    "input limit",
    "signature",
    "chunk bounds/type/CRC in file order",
    "IHDR and chunk ordering/length/duplicates",
    "required chunks and no trailing file data",
    "color conflict",
    "bounded profile inflate",
    "bounded exact scanlines inflate",
    "filter/sample reconstruction",
    "color precedence"
  ],
  "parserRules": {
    "trailingFileBytes": "reject",
    "trailingZlibBytes": "reject",
    "idat": "one contiguous sequence",
    "colorChunks": "before IDAT; cICP/gAMA/cHRM/iCCP/sRGB also before PLTE",
    "unknownAncillary": "ignore after CRC validation",
    "unknownCritical": "reject",
    "apng": "ancillary chunks ignored; no animation semantics",
    "nonPaletteTrns": "unsupported",
    "reservedTypeBit": "must be uppercase"
  },
  "compression": {
    "implementation": "miniz_oxide 0.8.9",
    "level": 6,
    "windowBits": 15,
    "strategy": 0,
    "flush": "Finish",
    "filter": "Sub",
    "idatChunks": 1,
    "compressionLevel": "validate integer 0..9; all select this same pinned configuration",
    "chunkOrder": [
      "IHDR",
      "sRGB or iCCP or cICP or none",
      "mDCv if present",
      "cLLi if present",
      "IDAT",
      "IEND"
    ]
  },
  "recordBytes": 176
});
