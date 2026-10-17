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
import { isJXL } from './jpeg-xl-signature.js';
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

// Mirrors the shim's return codes (jpeg-wasm-rs/src/lib.rs in
// @sandom/image-codecs). Spelled out here rather than reported as a bare
// number because the three cases mean genuinely different things to
// whoever hits them.
const DECODE_ERRORS = {
  '-1': 'internal error: decode() called before alloc()',
  '-2': 'not a decodable JPEG (truncated, corrupt, or an unsupported variant such as 12-bit or arithmetic-coded)',
  '-3': 'internal error: decoder returned a buffer that is not width*height*4 RGBA bytes',
};

/**
 * Extracts an embedded ICC profile from APP2, or null when the file
 * carries none.
 *
 * A profile larger than a single 64 KB marker is SPLIT across several
 * APP2 segments, each stamped with a 1-based sequence number and the
 * total count. They must be reassembled in sequence order, not in the
 * order they happen to appear — a real camera profile routinely needs
 * two or three chunks, so concatenating as-found is a bug that only
 * shows up on large profiles.
 */
export function parseIccProfileBytes(bytes) {
  const MARKER = [0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45, 0x00]; // "ICC_PROFILE\0"
  const chunks = [];
  let expectedTotal = 0;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xFF) break;
    const marker = bytes[offset + 1];
    if (marker === 0xDA || marker === 0xD9) break;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { offset += 2; continue; }

    const segLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segLength < 2) break;
    const segStart = offset + 4;
    const segEnd = segStart + segLength - 2;
    if (segEnd > bytes.length) break;

    if (marker === 0xE2 && segEnd - segStart >= MARKER.length + 2) {
      let matches = true;
      for (let i = 0; i < MARKER.length; i++) {
        if (bytes[segStart + i] !== MARKER[i]) { matches = false; break; }
      }
      if (matches) {
        const sequence = bytes[segStart + MARKER.length];
        const total = bytes[segStart + MARKER.length + 1];
        expectedTotal = total;
        chunks.push({ sequence, data: bytes.subarray(segStart + MARKER.length + 2, segEnd) });
      }
    }
    offset = segEnd;
  }

  if (chunks.length === 0) return null;
  if (chunks.length !== expectedTotal) {
    throw new Error(`JPEG declares an ICC profile in ${expectedTotal} chunks but ${chunks.length} are present — the profile is incomplete`);
  }

  chunks.sort((a, b) => a.sequence - b.sequence);
  let total = 0;
  for (const c of chunks) total += c.data.length;
  const profile = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { profile.set(c.data, at); at += c.data.length; }
  return profile;
}

/**
 * Walks JPEG marker segments for an APP1/Exif block and returns its
 * Orientation tag (1..8), or 1 when there is no tag to honour.
 *
 * This lives in JS rather than in the wasm shim on purpose: it is a
 * metadata parse with no relationship to the codec, it needs no wasm
 * rebuild to change, and it is far easier to test from here.
 */
export function parseExifOrientation(bytes) {
  // Markers run from just past SOI. Each has a 2-byte big-endian length
  // that INCLUDES the length field itself. Standalone markers (RSTn, SOI,
  // EOI, TEM) carry no length and must not be read as though they do.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xFF) break;
    const marker = bytes[offset + 1];
    // SOS (0xDA) begins entropy-coded scan data, which is not marker
    // structured — any Exif block would have appeared before it.
    if (marker === 0xDA || marker === 0xD9) break;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { offset += 2; continue; }

    const segLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segLength < 2) break;
    const segStart = offset + 4;
    const segEnd = segStart + segLength - 2;
    if (segEnd > bytes.length) break;

    if (marker === 0xE1 && segEnd - segStart >= 14 &&
        bytes[segStart] === 0x45 && bytes[segStart + 1] === 0x78 &&
        bytes[segStart + 2] === 0x69 && bytes[segStart + 3] === 0x66 &&
        bytes[segStart + 4] === 0x00 && bytes[segStart + 5] === 0x00) {
      const orientation = readOrientationFromTiff(bytes, segStart + 6, segEnd);
      if (orientation !== null) return orientation;
    }
    offset = segEnd;
  }
  return 1;
}

// The Exif payload is a TIFF stream whose byte order is declared by its
// own first two bytes, so nothing here may assume an endianness.
function readOrientationFromTiff(bytes, base, end) {
  if (base + 8 > end) return null;
  const littleEndian = bytes[base] === 0x49 && bytes[base + 1] === 0x49;
  const bigEndian = bytes[base] === 0x4D && bytes[base + 1] === 0x4D;
  if (!littleEndian && !bigEndian) return null;

  const u16 = (o) => (littleEndian ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o) => (littleEndian
    ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
    : (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0));

  if (u16(base + 2) !== 42) return null;
  const ifdOffset = u32(base + 4);
  const ifd = base + ifdOffset;
  if (ifd + 2 > end) return null;

  const entryCount = u16(ifd);
  for (let i = 0; i < entryCount; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) !== 0x0112) continue;
    // Type 3 (SHORT) with count 1 fits inline in the value field, which is
    // where every real writer puts it.
    if (u16(entry + 2) !== 3) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/**
 * Applies an Exif orientation to an RGBA8 buffer, returning the corrected
 * buffer and its dimensions. Orientations 5-8 transpose the image, so
 * width and height SWAP — callers must use the returned pair rather than
 * the decoder's, since replaced-box sizing is driven by it.
 */
export function applyExifOrientation(pixels, width, height, orientation) {
  if (orientation === 1) return { width, height, pixels };

  const transposed = orientation >= 5;
  const outW = transposed ? height : width;
  const outH = transposed ? width : height;
  const out = new Uint8Array(outW * outH * 4);

  // Destination-to-source mapping, one per Exif orientation value. Written
  // this way (rather than as a rotate/flip composition) so each case is
  // independently readable against the spec's own diagram.
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx, sy;
      switch (orientation) {
        case 2: sx = width - 1 - x; sy = y; break;                      // mirror horizontal
        case 3: sx = width - 1 - x; sy = height - 1 - y; break;         // rotate 180
        case 4: sx = x; sy = height - 1 - y; break;                     // mirror vertical
        case 5: sx = y; sy = x; break;                                  // transpose
        case 6: sx = y; sy = height - 1 - x; break;                     // rotate 90 CW
        case 7: sx = width - 1 - y; sy = height - 1 - x; break;         // transverse
        case 8: sx = width - 1 - y; sy = x; break;                      // rotate 90 CCW
        default: sx = x; sy = y; break;
      }
      const s = (sy * width + sx) * 4;
      const d = (y * outW + x) * 4;
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = pixels[s + 3];
    }
  }
  return { width: outW, height: outH, pixels: out };
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
    release();
    throw new Error(`decodeJPEG failed (${status}): ${DECODE_ERRORS[String(status)] ?? 'unknown decoder status'}`);
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
  const profileBytes = parseIccProfileBytes(bytes);
  if (profileBytes) {
    const profile = parseIccProfile(profileBytes);
    try {
      if (!isSrgbLike(profile)) convertToSrgb(out, profile);
    } finally {
      releaseIccProfile(profile);
    }
  }

  const oriented = applyExifOrientation(out, w, h, parseExifOrientation(bytes));
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
      if (isJPEG(bytes)) {
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
      if (isPNG(bytes)) {
        return await pngCodec.decode(bytes);
      }
      if (isWebP(bytes)) {
        if (!decodeWebP) {
          const module = await import('./webp.js');
          return await module.decodeWebP(bytes);
        }
        return await decodeWebP(bytes);
      }
      if (isJXL(bytes)) {
        if (!decodeJXL) {
          const module = await import('./jpeg-xl.js');
          return await module.decodeJXL(bytes);
        }
        return await decodeJXL(bytes);
      }
      const head = Array.from(
        bytes.slice(0, 4),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(' ');
      throw new Error(
        `decodeImage: unrecognized image format (first bytes: ${head})`,
      );
    },
    imageMimeType,
    encodeJxlOutput,
    encodePngOutput: (descriptor, request) => encodePngOutputWithCodec(pngCodec, descriptor, request),
    instanceIdentity() {
      return jpegState.instance;
    },
  });
}

// Magic-byte tests, one per format. Factored out because decodeImage and
// imageMimeType below must agree by construction: the old shape inlined
// the same byte comparisons in both, and a third format would have made
// that six copies of two invariants.
//
// SOI marker. Every JPEG (JFIF, Exif, raw) starts FF D8; the third byte
// varies by container flavour, so it is deliberately not checked.
const isJPEG = (b) => b.length >= 2 && b[0] === 0xFF && b[1] === 0xD8;

const isPNG = (b) => b.length >= 8 &&
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;

// RIFF container: "RIFF" then a 4-byte little-endian size then "WEBP".
// The size field is NOT checked — it is the RIFF chunk length, a fact
// about the file rather than about the format, and a truncated file
// should fail in the decoder with a real message instead of being
// reported here as an unrecognized format.
const isWebP = (b) => b.length >= 12 &&
  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

// SVG is an XML image, not a magic-byte container. Only decode text when
// the prefix could be XML; parse the full source in the SVG DOM path.
export function svgImageSource(bytes) {
  let offset = 0;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    offset = 3;
  }
  while (
    offset < bytes.length &&
    (bytes[offset] === 0x20 || bytes[offset] === 0x09 ||
      bytes[offset] === 0x0A || bytes[offset] === 0x0D)
  ) offset++;
  if (bytes[offset] !== 0x3C) return null;
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const svgRoot =
    /^(?:\uFEFF?\s*(?:<\?xml\b[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE\s+svg\b[\s\S]*?>\s*))*\uFEFF?\s*<(?:[A-Za-z_][\w.-]*:)?svg(?:\s|\/?>)/i;
  return svgRoot.test(source) ? source : null;
}

// Both JPEG XL signatures (bare codestream and ISOBMFF container) live in
// src/jpeg-xl.js beside their decoder, imported statically so this sniff
// and that module cannot disagree.

/**
 * Sniffs the container from its magic bytes and dispatches. This is the
 * ONLY place in the codebase that decides an image's format — callers pass
 * bytes and get RGBA8 back.
 *
 * Sniffing beats trusting the file extension: the bytes are authoritative,
 * a mislabelled .png that is really a JPEG is a real thing on the web, and
 * decoded scene images also arrive from places with no filename at all.
 */
export async function decodeImage(bytes, options) {
  const displayBoost = adaptiveDisplayBoost(options);
  if (isJPEG(bytes)) {
    if (displayBoost !== null) {
      const module = await import('./output/jpeg-gain-map.js');
      if (module.inspectGainMapJpeg(bytes).isGainMap) {
        return await module.reconstructGainMapJpeg(bytes, displayBoost);
      }
    }
    return await decodeJPEG(bytes);
  }
  if (isPNG(bytes)) {
    const { decodePNG } = await import('./images.js');
    return await decodePNG(bytes);
  }
  if (isWebP(bytes)) {
    const { decodeWebP } = await import('./webp.js');
    return await decodeWebP(bytes);
  }
  if (isJXL(bytes)) {
    const { decodeJXL } = await import('./jpeg-xl.js');
    return await decodeJXL(bytes);
  }
  const head = Array.from(bytes.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`decodeImage: unrecognized image format (first bytes: ${head})`);
}

/**
 * The MIME type for a data: URI carrying these bytes. Raster containers
 * share decodeImage's predicates; XML SVG uses the renderer's SVG path.
 *
 * This does NOT change what Chrome renders today, and it is worth being
 * precise about that rather than claiming a bug fix: measured against the
 * CDP oracle, Chrome sniffs the image bytes and renders this JPEG
 * identically whether the URI announces image/jpeg, image/png, or even
 * application/octet-stream — byte-identical pixels in all three. The
 * declared type is simply a fact about the bytes, and a data: URI that
 * lies about it is wrong whether or not the current consumer forgives it.
 */
export function imageMimeType(bytes) {
  if (isJPEG(bytes)) return 'image/jpeg';
  if (isPNG(bytes)) return 'image/png';
  if (isWebP(bytes)) return 'image/webp';
  if (isJXL(bytes)) return 'image/jxl';
  if (svgImageSource(bytes) !== null) return 'image/svg+xml';
  const head = Array.from(bytes.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`imageMimeType: unrecognized image format (first bytes: ${head})`);
}
