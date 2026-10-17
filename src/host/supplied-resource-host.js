// The supplied-resource host: one caller-owned resource map and nothing
// else. It performs no file or network operation. Tests, browser workers
// with transferred resources, and embedded applications with a complete
// resource set use it.
import {
  bytesBody,
  createResourceResponse,
  normalizeMediaType,
  resolveDemandURL,
  SandomHostError,
} from "./contract.js";
import { dataURLResponse } from "./data-url.js";
import { createModuleGraphSession } from "./module-graph-session.js";
import { createDefaultClassicScriptSession } from "./default-classic-scripts.js";

export const SUPPLIED_RESOURCE_HOST_BACKEND = "supplied-resources";

const CAPABILITIES = Object.freeze(["supplied-resources", "data-decode", "module-graph"]);

function normalizeEntry(url, entry) {
  const record = entry instanceof Uint8Array ? { bytes: entry } : entry;
  if (!record || !(record.bytes instanceof Uint8Array)) {
    throw new TypeError(`Supplied resource ${url} must be Uint8Array bytes or { bytes, mediaType, finalURL }`);
  }
  return Object.freeze({
    bytes: record.bytes,
    mediaType: normalizeMediaType(record.mediaType ?? null),
    finalURL: new URL(record.finalURL ?? url).href,
  });
}

// `resources` maps an absolute locator to Uint8Array bytes or to
// `{ bytes, mediaType, finalURL }`. A Map, an object, or an iterable of
// `[url, entry]` pairs is accepted.
export function createSuppliedResourceHost({ resources }) {
  const entries = resources instanceof Map
    ? resources.entries()
    : resources && typeof resources[Symbol.iterator] === "function"
    ? resources
    : Object.entries(resources ?? {});
  const resourcesByURL = new Map();
  for (const [url, entry] of entries) {
    const normalizedURL = new URL(url).href;
    resourcesByURL.set(normalizedURL, normalizeEntry(normalizedURL, entry));
  }

  const lookup = (url) => {
    if (url.protocol === "data:") return null;
    const entry = resourcesByURL.get(url.href);
    if (!entry) {
      throw new SandomHostError(
        "resource-unavailable",
        `The supplied-resource host has no resource ${url.href}`,
        { details: { url: url.href } },
      );
    }
    return entry;
  };

  // The host contract returns promises; the answers are synchronous, and
  // Promise.try turns a throw into a rejection as an async function does.
  const respond = (demand) => {
    const requestedURL = resolveDemandURL(demand);
    if (requestedURL.protocol === "data:") return dataURLResponse(requestedURL.href);
    const entry = lookup(requestedURL);
    return createResourceResponse({
      requestedURL: requestedURL.href,
      finalURL: entry.finalURL,
      mediaType: entry.mediaType,
      body: bytesBody(entry.bytes),
      byteLength: entry.bytes.byteLength,
      provenance: { provider: "supplied" },
      capabilities: CAPABILITIES,
    });
  };
  const request = (demand) => Promise.try(respond, demand);

  const fetchNow = (input, init = {}) => {
    const locator = new URL(String(input?.url ?? input));
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new SandomHostError(
        "unauthorized-method",
        `The supplied-resource host serves GET and HEAD; ${method} ${locator.href} is refused`,
        { details: { method } },
      );
    }
    if (locator.protocol === "data:") {
      const response = dataURLResponse(locator.href);
      return new Response(method === "HEAD" ? null : response.body, {
        headers: { "content-type": response.mediaType },
      });
    }
    const entry = lookup(locator);
    return new Response(method === "HEAD" ? null : entry.bytes, {
      headers: entry.mediaType === null ? {} : { "content-type": entry.mediaType },
    });
  };
  const scriptFetch = (input, init = {}) => Promise.try(fetchNow, input, init);

  return Object.freeze({
    backend: SUPPLIED_RESOURCE_HOST_BACKEND,
    capabilities: CAPABILITIES,
    openResourceSession() {
      return Object.freeze({ request, fetch: scriptFetch, release() {} });
    },
    openModuleSession(context) {
      return createModuleGraphSession(context);
    },
    // The caller supplies every byte, so it vouches for the scripts: they
    // run on the caller's thread, in a global scope of the document's own.
    openClassicScriptSession() {
      return createDefaultClassicScriptSession();
    },
  });
}
