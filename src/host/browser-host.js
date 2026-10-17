// The browser host: native browser Fetch, once for each demand. Browser
// Fetch already applies redirects, credentials, cookies, caching,
// Cross-Origin Resource Sharing, and response filtering, so no other Fetch
// engine runs above it.
import {
  bytesBody,
  createResourceResponse,
  resolveDemandURL,
  SandomHostError,
} from "./contract.js";
import { createModuleGraphSession } from "./module-graph-session.js";
import { createDefaultClassicScriptSession } from "./default-classic-scripts.js";

export const BROWSER_HOST_BACKEND = "browser-fetch";

const CAPABILITIES = Object.freeze(["browser-fetch", "module-graph"]);

// Native Fetch gives no internal response: a filtered no-cors response has no
// readable body, so the host reads every demand in CORS mode, and a
// cross-origin resource needs the server's CORS grant.
function browserRequestMode(demand) {
  return demand.mode === "same-origin" ? "same-origin" : "cors";
}

export function createBrowserSandomHost({ fetch: nativeFetch = globalThis.fetch } = {}) {
  if (typeof nativeFetch !== "function") {
    throw new TypeError(`createBrowserSandomHost requires the native fetch function; received ${typeof nativeFetch}`);
  }
  const request = async (demand) => {
    const requestedURL = resolveDemandURL(demand);
    let response;
    try {
      response = await nativeFetch(requestedURL.href, {
        mode: browserRequestMode(demand),
        credentials: demand.credentials,
        referrerPolicy: demand.referrerPolicy,
        integrity: demand.integrity,
        priority: demand.priority,
        signal: demand.signal,
      });
    } catch (cause) {
      if (demand.signal.aborted) throw demand.signal.reason;
      throw new SandomHostError(
        "resource-unavailable",
        `Browser fetch of ${requestedURL.href} failed: ${cause?.message ?? String(cause)}`,
        { cause },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SandomHostError(
        "resource-unavailable",
        `Browser fetch of ${requestedURL.href} returned HTTP ${response.status}`,
        { details: { status: response.status, url: response.url } },
      );
    }
    const contentLength = response.headers.get("content-length");
    const encoded = response.headers.get("content-encoding");
    return createResourceResponse({
      requestedURL: requestedURL.href,
      finalURL: response.url || requestedURL.href,
      mediaType: response.headers.get("content-type"),
      body: response.body ?? bytesBody(new Uint8Array(0)),
      byteLength: contentLength !== null && encoded === null ? Number(contentLength) : null,
      provenance: {
        provider: "browser-fetch",
        status: response.status,
        redirected: response.redirected,
        responseType: response.type,
      },
      capabilities: CAPABILITIES,
    });
  };
  return Object.freeze({
    backend: BROWSER_HOST_BACKEND,
    capabilities: CAPABILITIES,
    openResourceSession() {
      return Object.freeze({
        request,
        fetch: (input, init) => nativeFetch(input, init),
        release() {},
      });
    },
    openModuleSession(context) {
      return createModuleGraphSession(context);
    },
    openClassicScriptSession() {
      return createDefaultClassicScriptSession();
    },
  });
}
