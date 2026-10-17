import { readPackageAsset } from "./package-assets.js";

const RUNTIME_OPTION_KEYS = new Set(["assets", "resolveSystemFontFamily", "bundledSystemFonts"]);
const ASSET_KEYS = new Set(["harfbuzz", "msdfgen", "codecs"]);
const CODEC_KEYS = new Set(["png", "jpeg", "webp", "jpegXl"]);

function assertRecord(value, name) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function rejectUnknownKeys(record, allowedKeys, name) {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(`Unknown ${name} field ${String(key)}`);
    }
  }
}

function normalizeAssetSource(source, name) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof URL) return new URL(source.href);
  if (typeof source === "string") {
    try {
      return new URL(source);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new TypeError(`${name} must be an absolute URL`);
    }
  }
  throw new TypeError(
    `${name} must be a Uint8Array, ArrayBuffer, or absolute URL`,
  );
}

export async function assetBytes(source) {
  return source instanceof Uint8Array ? source : await readPackageAsset(source);
}

export function lazyAssetBytes(source, name) {
  let promise = null;
  return () => {
    if (source === null) {
      throw new Error(`Optional runtime asset ${name} was not supplied`);
    }
    promise ??= assetBytes(source);
    return promise;
  };
}

export async function prepareSandomRuntimeOptions(options = {}) {
  assertRecord(options, "createSandomRuntime options");
  rejectUnknownKeys(options, RUNTIME_OPTION_KEYS, "createSandomRuntime option");
  if (
    options.resolveSystemFontFamily !== undefined &&
    typeof options.resolveSystemFontFamily !== "function"
  ) {
    throw new TypeError("resolveSystemFontFamily must be a function");
  }
  // The generic faces of the runtime's font registry: the result of
  // loadBundledSystemFonts() (src/system-fonts.js).
  if (
    options.bundledSystemFonts !== undefined &&
    typeof options.bundledSystemFonts?.familyFor !== "function"
  ) {
    throw new TypeError(
      `bundledSystemFonts must be the result of loadBundledSystemFonts(); it is ${options.bundledSystemFonts}`,
    );
  }
  const explicitAssets = options.assets !== undefined;
  let harfbuzzSource = null;
  let msdfgenSource = null;
  const codecSources = { png: null, jpeg: null, webp: null, jpegXl: null };

  if (explicitAssets) {
    assertRecord(options.assets, "assets");
    rejectUnknownKeys(options.assets, ASSET_KEYS, "asset");
    if (options.assets.harfbuzz === undefined) {
      throw new TypeError("assets.harfbuzz is required");
    }
    if (options.assets.msdfgen === undefined) {
      throw new TypeError("assets.msdfgen is required");
    }
    harfbuzzSource = normalizeAssetSource(
      options.assets.harfbuzz,
      "assets.harfbuzz",
    );
    msdfgenSource = normalizeAssetSource(
      options.assets.msdfgen,
      "assets.msdfgen",
    );
    const codecs = options.assets.codecs ?? {};
    assertRecord(codecs, "assets.codecs");
    rejectUnknownKeys(codecs, CODEC_KEYS, "codec asset");
    for (const key of CODEC_KEYS) {
      if (codecs[key] !== undefined) {
        codecSources[key] = normalizeAssetSource(
          codecs[key],
          `assets.codecs.${key}`,
        );
      }
    }
  }

  let harfbuzzBytes = null;
  let msdfgenBytes = null;
  if (explicitAssets) {
    [harfbuzzBytes, msdfgenBytes] = await Promise.all([
      assetBytes(harfbuzzSource),
      assetBytes(msdfgenSource),
    ]);
  }

  return Object.freeze({
    explicitAssets,
    resolveSystemFontFamily: options.resolveSystemFontFamily ?? null,
    bundledSystemFonts: options.bundledSystemFonts ?? null,
    harfbuzzSource,
    msdfgenSource,
    codecSources: Object.freeze(codecSources),
    harfbuzzBytes,
    msdfgenBytes,
  });
}
