import { readPackageAsset } from "../package-assets.js";

// Isolated workers seed the bytes through the reviewed module graph; other
// hosts resolve the package through the library import map (Deno maps the
// prefix to the sibling checkouts, the website to its served copies).
const COLOR_WASM = "@sandom/color/color.wasm";

const colorWasmBytes = globalThis[Symbol.for("sandom.colorBytes")] ??
  await readPackageAsset(new URL(import.meta.resolve(COLOR_WASM)));

let runtime;

const ENUM_EXPORTS = Object.freeze({
  primaries: Object.freeze({
    srgb: "color_primaries_srgb",
    "display-p3": "color_primaries_display_p3",
    rec2020: "color_primaries_rec2020",
    "a98-rgb": "color_primaries_a98_rgb",
    "prophoto-rgb": "color_primaries_prophoto_rgb",
    "xyz-d50": "color_primaries_xyz_d50",
    "xyz-d65": "color_primaries_xyz_d65",
  }),
  transfer: Object.freeze({
    srgb: "color_transfer_srgb",
    linear: "color_transfer_linear",
    gamma: "color_transfer_gamma",
    pq: "color_transfer_pq",
    hlg: "color_transfer_hlg",
    rec2020: "color_transfer_rec2020",
    "prophoto-rgb": "color_transfer_prophoto_rgb",
    icc: "color_transfer_icc",
  }),
  sample: Object.freeze({
    uint8: "color_sample_uint8",
    uint16: "color_sample_uint16",
    float16: "color_sample_float16",
    float32: "color_sample_float32",
  }),
  layout: Object.freeze({
    gray: "color_layout_gray",
    "gray-alpha": "color_layout_gray_alpha",
    rgb: "color_layout_rgb",
    rgba: "color_layout_rgba",
  }),
  alpha: Object.freeze({
    opaque: "color_alpha_opaque",
    straight: "color_alpha_straight",
    premultiplied: "color_alpha_premultiplied",
  }),
  white: Object.freeze({ d50: "color_white_d50", d65: "color_white_d65" }),
  range: Object.freeze({
    standard: "color_range_standard",
    high: "color_range_high",
    adaptive: "color_range_adaptive",
  }),
  tone: Object.freeze({ bt2390: "color_tone_bt2390", none: "color_tone_none" }),
  working: Object.freeze({
    standard: "color_working_standard",
    "high-dynamic-range": "color_working_high_dynamic_range",
  }),
  gamut: Object.freeze({ "css-color-4": "color_gamut_css_color_4" }),
});

const ERROR_EXPORTS = Object.freeze({
  "enum-version": "color_error_enum_version",
  "span-dimensions": "color_error_span_dimensions",
  "numeric-parameter": "color_error_numeric_parameter",
  allocation: "color_error_allocation",
  "profile-malformed": "color_error_profile_malformed",
  "profile-unsupported": "color_error_profile_unsupported",
  "handle-stale": "color_error_handle_stale",
  "output-capacity": "color_error_output_capacity",
  "profile-reverse": "color_error_profile_reverse",
  "profile-cmyk": "color_error_profile_cmyk",
  "profile-gray": "color_error_profile_gray",
  "profile-n-channel": "color_error_profile_n_channel",
  "profile-mpet": "color_error_profile_mpet",
  "profile-intent": "color_error_profile_intent",
  "profile-black-point": "color_error_profile_black_point",
  "profile-chad": "color_error_profile_chad",
});

const CSS_FORM_EXPORTS = Object.freeze({
  hex: "color_css_form_hex",
  rgb: "color_css_form_rgb",
  hsl: "color_css_form_hsl",
  hwb: "color_css_form_hwb",
  lab: "color_css_form_lab",
  lch: "color_css_form_lch",
  oklab: "color_css_form_oklab",
  oklch: "color_css_form_oklch",
  color: "color_css_form_color",
});

const CSS_ERROR_EXPORTS = Object.freeze({
  "unrecognized color form": "color_css_error_unrecognized",
  "malformed number": "color_css_error_number",
  "wrong unit for this component": "color_css_error_unit",
  "bad component structure": "color_css_error_structure",
  "unknown color space": "color_css_error_space",
  "trailing bytes after the color": "color_css_error_trailing",
  "bad hex color": "color_css_error_hex",
});

const REQUIRED_FUNCTIONS = Object.freeze([
  "color_abi_version", "color_init", "color_error_code", "color_error_field",
  "color_alloc", "color_free", "color_policy_init", "color_validate_policy",
  "color_transform_output", "color_profile_compile", "color_profile_info",
  "color_profile_release", "color_profile_transform_xyz", "color_profile_convert_srgb",
  "color_profile_prepare", "color_pack_signal", "color_pack_half", "color_unpack_half",
  "color_expand_samples", "color_packing_size", "color_pack_image",
  "color_source_degraded", "color_source_linear", "color_source_working",
  "color_float_to_half", "color_half_to_float", "color_matrix_read", "color_working_code",
  "color_convert_tagged_to_working", "color_convert_tagged_to_standard", "color_parse_css",
]);

function globalValue(exports, name) {
  const global = exports[name];
  if (!(global instanceof WebAssembly.Global)) throw new Error(`@sandom/color ABI missing global ${name}`);
  return global.value;
}

function enumRecord(exports, names) {
  return Object.freeze(Object.fromEntries(Object.entries(names).map(([label, name]) => [label, globalValue(exports, name)])));
}

function fields(exports, prefix, names) {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, globalValue(exports, `${prefix}_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`)])));
}

function loadAbi(exports) {
  const version = globalValue(exports, "color_abi_version_value");
  if (version !== 2 || exports.color_abi_version() !== version) {
    throw new Error(`@sandom/color ABI v2 required, got ${exports.color_abi_version()}`);
  }
  const errors = Object.create(null);
  const errorCodes = Object.create(null);
  for (const [label, name] of Object.entries(ERROR_EXPORTS)) {
    const code = globalValue(exports, name);
    errors[code] = label;
    errorCodes[label] = code;
  }
  return Object.freeze({
    version,
    enums: Object.freeze(Object.fromEntries(Object.entries(ENUM_EXPORTS).map(([name, values]) => [name, enumRecord(exports, values)]))),
    errors: Object.freeze(errors),
    errorCodes: Object.freeze(errorCodes),
    depthCodes: Object.freeze({
      float16: globalValue(exports, "color_depth_float16"),
      float32: globalValue(exports, "color_depth_float32"),
    }),
    cssForms: enumRecord(exports, CSS_FORM_EXPORTS),
    cssErrors: Object.freeze(Object.fromEntries(Object.entries(CSS_ERROR_EXPORTS).map(([label, name]) => [globalValue(exports, name), label]))),
    records: Object.freeze({
      policy: Object.freeze({ size: globalValue(exports, "color_policy_size"), fields: fields(exports, "color_policy", ["version", "primaries", "transfer", "depth", "alpha", "tone", "range", "sourcePeak", "targetPeak", "white", "referenceWhite", "gamut", "masteringPresent", "sourceMin"]) }),
      capability: Object.freeze({ size: globalValue(exports, "color_capability_size"), fields: fields(exports, "color_capability", ["version", "depthMask", "encodingLow", "encodingHigh", "alpha", "flags"]) }),
      source: Object.freeze({ size: globalValue(exports, "color_source_size"), fields: fields(exports, "color_source", ["src", "length", "width", "height", "stride", "sample", "bits", "layout", "alpha", "transfer", "primaries", "mode", "gamma", "referenceWhite"]) }),
      profileInfo: Object.freeze({ size: globalValue(exports, "color_profile_info_size"), fields: fields(exports, "color_profile_info", ["handle", "kind", "srgbLike", "identity", "revision"]) }),
      parse: Object.freeze({
        vecOffset: globalValue(exports, "color_vec_offset"),
        inputOffset: globalValue(exports, "color_parse_input_offset"),
        inputCapacity: globalValue(exports, "color_parse_input_capacity"),
        resultOffset: globalValue(exports, "color_parse_result_offset"),
        resultSize: globalValue(exports, "color_parse_result_size"),
        fields: fields(exports, "color_parse", ["components", "alpha", "missing", "alphaMissing", "primaries", "transfer", "gamma", "form", "authoredMissing", "white", "alphaMode", "referenceWhite"]),
      }),
    }),
    profileError: Object.freeze({
      sampleBits: globalValue(exports, "color_profile_error_sample_bits"),
      sampleMask: globalValue(exports, "color_profile_error_sample_mask"),
      channelBits: globalValue(exports, "color_profile_error_channel_bits"),
      channelMask: globalValue(exports, "color_profile_error_channel_mask"),
    }),
  });
}

export function colorRuntime() {
  if (runtime) return runtime;
  const module = new WebAssembly.Module(colorWasmBytes);
  const { exports } = new WebAssembly.Instance(module, {});
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof exports[name] !== "function") throw new Error(`@sandom/color ABI missing operation ${name}`);
  }
  const abi = loadAbi(exports);
  exports.color_init();
  const memory = exports.memory;
  const check = (status) => {
    if (status === 0) return;
    const code = exports.color_error_code();
    const field = exports.color_error_field();
    const error = new Error(`color: ${abi.errors[code] ?? "native error"} (code ${code}, field ${field})`);
    error.domain = "color";
    error.code = code;
    error.field = field;
    throw error;
  };
  const alloc = (size) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > 268435424) throw new RangeError("color allocation size exceeds memory ceiling");
    const pointer = exports.color_alloc(Math.max(1, size));
    if (!pointer) check(exports.color_error_code());
    return pointer;
  };
  const free = (pointer) => { if (pointer) check(exports.color_free(pointer)); };
  const copyIn = (source) => {
    const pointer = alloc(source.byteLength);
    new Uint8Array(memory.buffer, pointer, source.byteLength).set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return pointer;
  };
  const copyOut = (pointer, length, Constructor = Uint8Array) => {
    const count = length / Constructor.BYTES_PER_ELEMENT;
    if (!Number.isInteger(count)) throw new RangeError("color result sample alignment");
    return new Constructor(new Constructor(memory.buffer, pointer, count));
  };
  runtime = Object.freeze({ exports, memory, abi, alloc, free, copyIn, copyOut, check });
  return runtime;
}
