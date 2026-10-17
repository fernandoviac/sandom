// The data: provider of Sandom hosts. It decodes the body of a data:
// locator as the Fetch Standard's data: URL processor does, without any
// network or file effect.
import { bytesBody, createResourceResponse, SandomHostError } from "./contract.js";

function percentDecode(text) {
  const bytes = [];
  const encoded = new TextEncoder().encode(text);
  for (let index = 0; index < encoded.length; index++) {
    const byte = encoded[index];
    if (byte === 0x25 && index + 2 < encoded.length) {
      const hex = String.fromCharCode(encoded[index + 1], encoded[index + 2]);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

export function decodeDataURL(url) {
  const locator = new URL(url);
  if (locator.protocol !== "data:") {
    throw new TypeError(`decodeDataURL requires a data: URL; received ${locator.href}`);
  }
  const body = locator.href.slice("data:".length).replace(/#.*$/s, "");
  const comma = body.indexOf(",");
  if (comma === -1) {
    throw new SandomHostError(
      "resource-unavailable",
      `Data URL ${locator.href.slice(0, 64)} has no comma`,
    );
  }
  let mediaType = body.slice(0, comma).trim();
  let bytes = percentDecode(body.slice(comma + 1));
  if (/;\s*base64$/i.test(mediaType)) {
    mediaType = mediaType.replace(/;\s*base64$/i, "");
    const text = new TextDecoder().decode(bytes).replace(/[\t\n\f\r ]/g, "");
    let binary;
    try {
      binary = atob(text);
    } catch (cause) {
      throw new SandomHostError(
        "resource-unavailable",
        `Data URL ${locator.href.slice(0, 64)} has invalid base64`,
        { cause },
      );
    }
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (mediaType.startsWith(";")) mediaType = `text/plain${mediaType}`;
  if (mediaType === "") mediaType = "text/plain;charset=US-ASCII";
  return { bytes, mediaType };
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
