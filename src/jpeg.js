/**
 * JPEG decoder — bytes to RGBA8 pixels.
 *
 * JPEG sample decoding uses the @sandom/image-codecs JPEG module (zune-jpeg).
 * PNG dispatch uses the separately owned @sandom/png codec; neither has a JS
 * fallback.
 *
 * Returns the same { width, height, pixels } shape decodePNG does, so the
 * image pipeline in examples/render-scene.js branches on format exactly
 * once (decodeImage below) and nowhere downstream.
 */

import { convertToSrgb, isSrgbLike, parseIccProfile, releaseIccProfile } from './color-profile.js';
import { srgbRgba8ImageDescriptor } from './image-data.js';
import { readPackageAsset } from './package-assets.js';
import {
  imageFormat, imageMediaType, jpegExifOrientation, jpegIccProfile, orientPixels, unrecognizedImageError,
} from './image-container.js';
import { createPngCodec } from './png-codec.js';
import { encodePngOutputWithCodec } from './output/png.js';

// Sandom's binding for the @sandom/image-codecs JPEG module. The library
// import map resolves the package (a sibling checkout locally, the reviewed
// library set or the installed npm package otherwise).
const JPEG_WASM = '@sandom/image-codecs/jpeg.wasm';

// The module imports NOTHING (verified: WebAssembly.Module.imports() is
// empty) — no WASI, no env, no emscripten glue, unlike hb.wasm next door
// which needs an env import object. So instantiation takes no imports and
// there is no __wasm_call_ctors to run.
const defaultJpegState = { instance: null, loading: null };

// Concurrent first decodes (a frame's images decode at once) share one
// instantiation. A failed instantiation is not kept.
async function ensureJpeg(state, getJpegBytes) {
  if (state.instance) return state.instance;
  state.loading ??= (async () => {
    const wasmBytes = getJpegBytes
      ? await getJpegBytes()
      : await readPackageAsset(new URL(import.meta.resolve(JPEG_WASM)));
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    state.instance = instance;
    return instance;
  })().finally(() => {
    state.loading = null;
  });
  return await state.loading;
}

/**
 * Decodes JPEG bytes into { width, height, pixels } where pixels is a
 * tightly-packed Uint8Array of RGBA8 (4 bytes/pixel, row-major, no
 * padding). Alpha is always 255 — JPEG has no alpha channel.
 *
 * Baseline, progressive, and grayscale sources all decode; grayscale is
 * expanded to RGBA by the decoder, not passed through as one channel.
 *
 * Exif orientation IS applied, matching `image-orientation: from-image`,
 * which is the CSS initial value and therefore what a browser does unless
 * a page opts out. The returned width/height are the ORIENTED ones (5..8
 * transpose), because they feed replaced-box sizing.
 */
async function decodeJpegWithState(bytes, state, getJpegBytes) {
  const wasm = await ensureJpeg(state, getJpegBytes);
  const { alloc, decode, width, height, pixels, release, memory } = wasm.exports;

  const inputPtr = alloc(bytes.length);
  new Uint8Array(memory.buffer, inputPtr, bytes.length).set(bytes);

  const status = decode();
  if (status !== 0) {
    const text = new TextDecoder().decode(
      new Uint8Array(memory.buffer, wasm.exports.status_message(status), wasm.exports.status_message_length(status)));
    release();
    throw new Error(`decodeJPEG failed (${status}): ${text}`);
  }

  const w = width();
  const h = height();
  // Copied out, not viewed in place: the returned pixels outlive release()
  // below, and any later decode's alloc can grow (and therefore detach)
  // this memory's backing buffer.
  const out = new Uint8Array(new Uint8Array(memory.buffer, pixels(), w * h * 4));
  release();

  // Colour first, geometry second: the ICC transform is per-pixel and
  // order-independent, but running it on the smaller pre-rotation buffer
  // touches the same bytes with better locality, and keeps the rotation
  // as a pure move. The source profile bytes travel in metadata so the
  // floating-point upload path (work package 4) can convert from source
  // precision instead of this baked sRGB.
  const profileBytes = jpegIccProfile(bytes);
  if (profileBytes) {
    const profile = parseIccProfile(profileBytes);
    try {
      if (!isSrgbLike(profile)) convertToSrgb(out, profile);
    } finally {
      releaseIccProfile(profile);
    }
  }

  // Exif orientation applies, matching `image-orientation: from-image`.
  const oriented = orientPixels(out, w, h, jpegExifOrientation(bytes));
  const metadata = { orientation: 1 };
  if (profileBytes) metadata.iccProfile = profileBytes;
  return srgbRgba8ImageDescriptor(oriented.width, oriented.height, oriented.pixels, metadata);
}

export async function decodeJPEG(bytes) {
  return await decodeJpegWithState(bytes, defaultJpegState);
}

function adaptiveDisplayBoost(options) {
  if (options === undefined) return null;
  if (options === null || typeof options !== 'object') {
    throw new Error('decodeImage options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'displayBoost') {
      throw new Error(`decodeImage: unknown option ${JSON.stringify(key)}`);
    }
  }
  if (options.displayBoost === undefined) return null;
  if (!Number.isFinite(options.displayBoost) || options.displayBoost <= 0) {
    throw new Error('decodeImage: displayBoost must be finite and positive');
  }
  return options.displayBoost;
}

export function createImageCodecRuntime({
  getJpegBytes = null,
  getPngBytes = null,
  decodeWebP = null,
  decodeJXL = null,
  encodeJxlOutput = null,
} = {}) {
  const jpegState = { instance: null, loading: null };
  const pngCodec = createPngCodec({ getPngBytes });
  return Object.freeze({
    async decodeJPEG(bytes) {
      return await decodeJpegWithState(bytes, jpegState, getJpegBytes);
    },
    async decodeImage(bytes, options) {
      const displayBoost = adaptiveDisplayBoost(options);
      const format = imageFormat(bytes);
      if (format === 'jpeg') {
        if (displayBoost !== null) {
          const module = await import('./output/jpeg-gain-map.js');
          if (module.inspectGainMapJpeg(bytes).isGainMap) {
            return await module.reconstructGainMapJpeg(bytes, displayBoost, {
              decodeJpeg: (jpegBytes) =>
                decodeJpegWithState(jpegBytes, jpegState, getJpegBytes),
            });
          }
        }
        return await decodeJpegWithState(bytes, jpegState, getJpegBytes);
      }
      if (format === 'png') {
        return await pngCodec.decode(bytes);
      }
      if (format === 'webp') {
        if (!decodeWebP) {
          const module = await import('./webp.js');
          return await module.decodeWebP(bytes);
        }
        return await decodeWebP(bytes);
      }
      if (format === 'jxl') {
        if (!decodeJXL) {
          const module = await import('./jpeg-xl.js');
          return await module.decodeJXL(bytes);
        }
        return await decodeJXL(bytes);
      }
      throw unrecognizedImageError('decodeImage', bytes);
    },
    imageMimeType,
    encodeJxlOutput,
    encodePngOutput: (descriptor, request) => encodePngOutputWithCodec(pngCodec, descriptor, request),
    instanceIdentity() {
      return jpegState.instance;
    },
  });
}

// The source of an SVG document, or null. The container module tests the
// bytes; an SVG or XML result decodes as UTF-8, which throws on invalid
// bytes.
export function svgImageSource(bytes) {
  const format = imageFormat(bytes);
  if (format !== 'svg' && format !== 'xml') return null;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return format === 'svg' ? source : null;
}

/**
 * Decodes the image the bytes hold, by the format the image container
 * module (core/engine/image-container.wat) finds in them, never by a file
 * extension.
 */
export async function decodeImage(bytes, options) {
  const displayBoost = adaptiveDisplayBoost(options);
  const format = imageFormat(bytes);
  if (format === 'jpeg') {
    if (displayBoost !== null) {
      const module = await import('./output/jpeg-gain-map.js');
      if (module.inspectGainMapJpeg(bytes).isGainMap) {
        return await module.reconstructGainMapJpeg(bytes, displayBoost);
      }
    }
    return await decodeJPEG(bytes);
  }
  if (format === 'png') {
    const { decodePNG } = await import('./images.js');
    return await decodePNG(bytes);
  }
  if (format === 'webp') {
    const { decodeWebP } = await import('./webp.js');
    return await decodeWebP(bytes);
  }
  if (format === 'jxl') {
    const { decodeJXL } = await import('./jpeg-xl.js');
    return await decodeJXL(bytes);
  }
  throw unrecognizedImageError('decodeImage', bytes);
}

/**
 * The MIME type for a data: URI carrying these bytes (image_media_type of
 * the image container module). An SVG source must decode as UTF-8.
 */
export function imageMimeType(bytes) {
  const mime = imageMediaType(bytes);
  if (mime === null) throw unrecognizedImageError('imageMimeType', bytes);
  if (mime === 'image/svg+xml') svgImageSource(bytes);
  return mime;
}
