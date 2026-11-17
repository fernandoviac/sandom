// The data: provider of Sandom hosts. The data URL module
// (core/engine/data-url.wat) decodes the body of a data: locator as the Fetch
// Standard's data: URL processor does, without any network or file
// effect.
import { bytesBody, createResourceResponse, SandomHostError } from "./contract.js";
import * as dataUrlBinary from "../wasm/data-url-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";

const dataUrlConstant = moduleLayoutConstants(dataUrlBinary, "data URL");
const DATA_URL_DECODED = dataUrlConstant("DATA_URL_DECODED");
const DATA_URL_NO_COMMA = dataUrlConstant("DATA_URL_NO_COMMA");

let dataUrl = null;

export function decodeDataURL(url) {
  const locator = new URL(url);
  if (locator.protocol !== "data:") {
    throw new TypeError(`decodeDataURL requires a data: URL; received ${locator.href}`);
  }
  dataUrl ??= dataUrlBinary.instantiate({}).exports;
  const href = new TextEncoder().encode(locator.href);
  const pointer = dataUrl.input_buffer(href.length);
  if (pointer === 0) {
    throw new Error(`data URL: the module could not grow its memory for a ${href.length}-byte URL`);
  }
  new Uint8Array(dataUrl.memory.buffer, pointer, href.length).set(href);
  const status = dataUrl.data_url_decode(href.length);
  if (status !== DATA_URL_DECODED) {
    const problem = status === DATA_URL_NO_COMMA ? "has no comma" : "has invalid base64";
    throw new SandomHostError("resource-unavailable", `Data URL ${locator.href.slice(0, 64)} ${problem}`);
  }
  const memory = dataUrl.memory.buffer;
  return {
    bytes: new Uint8Array(new Uint8Array(memory, dataUrl.body_address(), dataUrl.body_length())),
    mediaType: new TextDecoder().decode(new Uint8Array(memory, dataUrl.media_type_address(), dataUrl.media_type_length())),
  };
}

export function dataURLResponse(requestedURL) {
  const { bytes, mediaType } = decodeDataURL(requestedURL);
  return createResourceResponse({
    requestedURL,
    finalURL: requestedURL,
    mediaType,
    body: bytesBody(bytes),
    byteLength: bytes.byteLength,
    provenance: { provider: "data" },
    capabilities: ["data-decode"],
  });
}
