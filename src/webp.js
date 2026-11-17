/**
 * WebP decoder — bytes to RGBA8 pixels.
 *
 * Same shape and same reasoning as src/jpeg.js: WebP is a real codec (VP8
 * for lossy, an entirely separate VP8L for lossless), so it is vendored
 * rather than hand-written — the @sandom/image-codecs WebP module
 * (image-webp behind a thin shim, see the package's webp-wasm-rs/).
 *
 * Returns the same { width, height, pixels } shape decodePNG and
 * decodeJPEG do, so the image pipeline branches on format exactly once
 * (decodeImage in src/jpeg.js) and nowhere downstream.
 *
 * The images epic (plans/images/README.md) owns the format decisions; the
 * ground rules there forbid decoding an animated file as a still.
 */

import { srgbRgba8ImageDescriptor } from './image-data.js';
import { readPackageAsset } from './package-assets.js';

// Sandom's binding for the @sandom/image-codecs WebP module. The library
// import map resolves the package (a sibling checkout locally, the reviewed
// library set or the installed npm package otherwise).
const WEBP_WASM = '@sandom/image-codecs/webp.wasm';

// The module imports NOTHING (verified: WebAssembly.Module.imports() is
// empty) even though it is a std build, so instantiation takes no imports
// and there is no __wasm_call_ctors to run — same as the JPEG module.
export function createWebPDecoder({ webpBytes, getWebPBytes = null } = {}) {
let webpInstance = null;

async function ensureWebp() {
  if (webpInstance) return webpInstance;

  const wasmBytes = getWebPBytes
    ? await getWebPBytes()
    : webpBytes ??
      await readPackageAsset(new URL(import.meta.resolve(WEBP_WASM)));

  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  webpInstance = instance;
  return instance;
}

/**
 * Decodes a still WebP — lossy (VP8) or lossless (VP8L), with or without
 * alpha — to RGBA8.
 *
 * Throws on an animated WebP naming its frame count. That is the ground
 * rule of plans/images/README.md: rendering frame 1 of an animation as
 * though it were a still is forbidden, and animation belongs to
 * plans/images/PLAN-animated-images.md.
 */
async function decodeWebP(bytes) {
  const wasm = await ensureWebp();
  const { alloc, decode, width, height, pixels, frames, release, memory } = wasm.exports;

  const inputPtr = alloc(bytes.length);
  new Uint8Array(memory.buffer, inputPtr, bytes.length).set(bytes);

  const status = decode();
  if (status !== 0) {
    // -4 is an animated WebP: a valid image whose animation Sandom does not
    // decode, so its message names the frame count.
    const frameCount = status === -4 ? frames() : 0;
    const text = new TextDecoder().decode(
      new Uint8Array(memory.buffer, wasm.exports.status_message(status), wasm.exports.status_message_length(status)));
    release();
    if (status === -4) {
      throw new Error(`decodeWebP: animated WebP (${frameCount} frames) is not supported — animation is plans/images/PLAN-animated-images.md, and decoding frame 1 as a still would be silently wrong`);
    }
    throw new Error(`decodeWebP failed (${status}): ${text}`);
  }

  const w = width();
  const h = height();
  // Copied out, not viewed in place: the returned pixels outlive release()
  // below, and any later decode's alloc can grow (and therefore detach)
  // this memory's backing buffer.
  const out = new Uint8Array(new Uint8Array(memory.buffer, pixels(), w * h * 4));
  release();

  // No ICC/EXIF pass here, unlike decodeJPEG. WebP CAN carry both in
  // optional chunks, and this decoder ignores them — see the slice notes
  // in plans/images/README.md rather than assuming it is handled.
  return srgbRgba8ImageDescriptor(w, h, out);
}

  return Object.freeze({
    decodeWebP,
    instanceIdentity() {
      return webpInstance;
    },
  });
}

const defaultWebPDecoder = createWebPDecoder();

export const decodeWebP = (...arguments_) =>
  defaultWebPDecoder.decodeWebP(...arguments_);
