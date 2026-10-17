import { sharedDomCore } from "./dom-wasm/core.js";

export async function decodeWebFont(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("decodeWebFont requires Uint8Array bytes");
  }
  const codec = sharedDomCore.status("font_bytes_codec",
    ...sharedDomCore.byteInput(bytes.subarray(0, 4)));
  if (codec === 0) return bytes;
  const packageSpecifier = typeof Deno === "object"
    ? "npm:woff-lib@0.0.3/decode"
    : "woff-lib/decode";
  const { woffDecode, woff2Decode } = await import(packageSpecifier);
  return await [woffDecode, woff2Decode][codec - 1](bytes);
}
