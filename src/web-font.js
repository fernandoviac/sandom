import { sharedDomCore } from "./dom-wasm/core.js";
import { layoutConstant } from "./wasm/layout-table.js";

const FONT_CODEC_RAW = layoutConstant("FONT_CODEC_RAW");
const FONT_CODEC_WOFF = layoutConstant("FONT_CODEC_WOFF");

export async function decodeWebFont(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("decodeWebFont requires Uint8Array bytes");
  }
  const codec = sharedDomCore.status("font_bytes_codec",
    ...sharedDomCore.byteInput(bytes.subarray(0, 4)));
  if (codec === FONT_CODEC_RAW) return bytes;
  const packageSpecifier = typeof Deno === "object"
    ? "npm:woff-lib@0.0.3/decode"
    : "woff-lib/decode";
  const { woffDecode, woff2Decode } = await import(packageSpecifier);
  return await (codec === FONT_CODEC_WOFF ? woffDecode : woff2Decode)(bytes);
}
