// Provider-neutral Sandom host contract.
//
// Sandom declares resource needs and asks for module evaluation. A host
// owns every effect: Uniform Resource Locator resolution, scheme routing,
// file and network authority, provider selection, the module map, and
// evaluation. This module defines the records that cross that boundary and
// performs no input or output itself. docs/specifications/host-boundary.md
// is the maintained contract.

export const HOST_CONTRACT_VERSION = 1;

export const HOST_ERROR_CODES = Object.freeze([
  "missing-host-capability",
  "unsupported-resource-scheme",
  "unauthorized-file-path",
  "unauthorized-network-origin",
  "unauthorized-method",
  "unauthorized-private-network",
  "invalid-network-url",
  "response-media-type",
  "resource-unavailable",
  "resource-limit",
  "sandsurf-fetch-failure",
  "module-resolution-failure",
  "module-evaluation-failure",
  "stale-resource-generation",
  "host-release-failure",
  "invalid-host-response",
]);

const hostErrorCodes = new Set(HOST_ERROR_CODES);

// One typed host failure. Sandom never retries a failed demand through
// another provider, so the code names the boundary that refused it.
export class SandomHostError extends Error {
  constructor(code, message, { cause, details = {} } = {}) {
    if (!hostErrorCodes.has(code)) {
      throw new TypeError(`Unknown Sandom host error code ${JSON.stringify(code)}`);
    }
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SandomHostError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// Fetch destinations that Sandom demands. A module script uses `script`.
export const RESOURCE_DESTINATIONS = Object.freeze([
  "document",
  "style",
  "font",
  "image",
  "script",
]);

const resourceDestinations = new Set(RESOURCE_DESTINATIONS);
const requestModes = new Set(["navigate", "cors", "no-cors", "same-origin"]);
const credentialsModes = new Set(["omit", "same-origin", "include"]);

// The Fetch Standard defaults of each destination that Sandom demands.
const destinationDefaults = Object.freeze({
  document: Object.freeze({ mode: "navigate", credentials: "include" }),
  style: Object.freeze({ mode: "no-cors", credentials: "include" }),
  font: Object.freeze({ mode: "cors", credentials: "same-origin" }),
  image: Object.freeze({ mode: "no-cors", credentials: "include" }),
  script: Object.freeze({ mode: "cors", credentials: "same-origin" }),
});

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function; received ${describe(value)}`);
  }
}

function describe(value) {
  if (value === null) return "null";
  if (typeof value === "function") return `function ${value.name || "(anonymous)"}`;
  if (typeof value === "object") return `object ${Object.prototype.toString.call(value)}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

// Checks the host shape before Sandom opens a session. A host has a backend
// identity, the resource and module session openers, and, when it evaluates
// classic scripts, a classic-script session opener. A host without that
// opener renders documents with scripting disabled.
export function validateSandomHost(host, operation) {
  if (host === null || typeof host !== "object") {
    throw new TypeError(`${operation} requires a Sandom host; received ${describe(host)}`);
  }
  if (typeof host.backend !== "string" || host.backend.length === 0) {
    throw new TypeError(
      `${operation} host backend must be a non-empty string; received ${describe(host.backend)}`,
    );
  }
  requireFunction(host.openResourceSession, `${operation} host openResourceSession`);
  requireFunction(host.openModuleSession, `${operation} host openModuleSession`);
  if (host.openClassicScriptSession !== undefined) {
    requireFunction(host.openClassicScriptSession, `${operation} host openClassicScriptSession`);
  }
  return host;
}

export function validateResourceSession(session, backend) {
  if (session === null || typeof session !== "object") {
    throw new TypeError(
      `Host ${backend} openResourceSession must return a session object; received ${describe(session)}`,
    );
  }
  requireFunction(session.request, `Host ${backend} resource session request`);
  requireFunction(session.release, `Host ${backend} resource session release`);
  if (session.fetch !== undefined) {
    requireFunction(session.fetch, `Host ${backend} resource session fetch`);
  }
  return session;
}

export function validateModuleSession(session, backend) {
  if (session === null || typeof session !== "object") {
    throw new TypeError(
      `Host ${backend} openModuleSession must return a session object; received ${describe(session)}`,
    );
  }
  requireFunction(session.execute, `Host ${backend} module session execute`);
  requireFunction(session.release, `Host ${backend} module session release`);
  return session;
}

// A classic-script session evaluates in one realm: `globalObject` is the
// global object of that realm, where Sandom installs the document's window
// bindings. `evaluateScript` and `compileEventHandler` are synchronous and
// return completion records. `trackUnhandledRejections(report, owns)` is
// optional: the session calls `report(reason, promise)` for each promise
// rejection that the realm leaves unhandled, instead of the realm's default,
// until the function it returns runs. `owns()` tells whether the code that
// runs is the document's: a session that hears the rejections of another
// realm reports one only when the document's code rejected it. A session
// without it leaves Sandom to hear the `unhandledrejection` event of
// `globalObject`.
export function validateClassicScriptSession(session, backend) {
  if (session === null || typeof session !== "object") {
    throw new TypeError(
      `Host ${backend} openClassicScriptSession must return a session object; received ${describe(session)}`,
    );
  }
  if (session.globalObject === null || typeof session.globalObject !== "object") {
    throw new TypeError(
      `Host ${backend} classic-script session globalObject must be an object; received ${describe(session.globalObject)}`,
    );
  }
  requireFunction(session.evaluateScript, `Host ${backend} classic-script session evaluateScript`);
  requireFunction(session.compileEventHandler, `Host ${backend} classic-script session compileEventHandler`);
  requireFunction(session.release, `Host ${backend} classic-script session release`);
  if (session.trackUnhandledRejections !== undefined) {
    requireFunction(
      session.trackUnhandledRejections,
      `Host ${backend} classic-script session trackUnhandledRejections`,
    );
  }
  return session;
}

// The completion record of one classic evaluation, as ECMAScript defines
// it for the two outcomes a script can have: a value, or a thrown value.
export function normalCompletion(value) {
  return Object.freeze({ type: "normal", value });
}

export function throwCompletion(value) {
  return Object.freeze({ type: "throw", value });
}

export function validateCompletion(completion, backend, operation) {
  if (
    completion === null || typeof completion !== "object" ||
    (completion.type !== "normal" && completion.type !== "throw")
  ) {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} ${operation} must return a completion record { type: "normal" | "throw", value }; received ${describe(completion)}`,
    );
  }
  return completion;
}

// The serialized origin of a document locator, as the URL Standard defines
// it: "null" for an opaque origin such as file: and about:blank.
export function originOf(url) {
  return new URL(url).origin;
}

// Builds one frozen resource-demand record. Sandom selects the base; the
// host resolves the reference with its own URL implementation.
export function createResourceDemand({
  reference,
  baseURL,
  destination,
  initiator = null,
  clientOrigin,
  topLevelOrigin = clientOrigin,
  mode,
  credentials,
  referrerPolicy = "",
  integrity = "",
  priority = "auto",
  generation,
  signal,
}) {
  if (typeof reference !== "string") {
    throw new TypeError(`Resource demand reference must be a string; received ${describe(reference)}`);
  }
  if (!resourceDestinations.has(destination)) {
    throw new TypeError(`Unknown resource destination ${JSON.stringify(destination)}`);
  }
  const defaults = destinationDefaults[destination];
  const selectedMode = mode ?? defaults.mode;
  const selectedCredentials = credentials ?? defaults.credentials;
  if (!requestModes.has(selectedMode)) {
    throw new TypeError(`Unknown resource request mode ${JSON.stringify(selectedMode)}`);
  }
  if (!credentialsModes.has(selectedCredentials)) {
    throw new TypeError(`Unknown resource credentials mode ${JSON.stringify(selectedCredentials)}`);
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError(`Resource demand generation must be a positive integer; received ${describe(generation)}`);
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError(`Resource demand signal must be an AbortSignal; received ${describe(signal)}`);
  }
  return Object.freeze({
    reference,
    baseURL: new URL(baseURL).href,
    destination,
    initiator,
    clientOrigin,
    topLevelOrigin,
    mode: selectedMode,
    credentials: selectedCredentials,
    referrerPolicy,
    integrity,
    priority,
    generation,
    signal,
  });
}

// Resolves a demand reference against its base. Hosts call this; Sandom
// does not route on the result.
export function resolveDemandURL(demand) {
  try {
    return new URL(demand.reference, demand.baseURL);
  } catch (cause) {
    throw new SandomHostError(
      "invalid-network-url",
      `Resource reference ${JSON.stringify(demand.reference)} does not resolve against ${demand.baseURL}`,
      { cause },
    );
  }
}

// The response media type without parameters, in lower case, or null.
export function normalizeMediaType(contentType) {
  if (contentType === null || contentType === undefined) return null;
  const essence = String(contentType).split(";", 1)[0].trim().toLowerCase();
  return essence.length === 0 ? null : essence;
}

export function bytesBody(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function sha256Digest(bytes) {
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let text = "sha256:";
  for (const byte of digestBytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

// One host resource response. Hosts build it; Sandom validates and reads it.
export function createResourceResponse({
  requestedURL,
  finalURL = requestedURL,
  mediaType = null,
  body,
  byteLength = null,
  digest = null,
  provenance,
  capabilities = [],
  release = null,
}) {
  return Object.freeze({
    requestedURL: new URL(requestedURL).href,
    finalURL: new URL(finalURL).href,
    mediaType: normalizeMediaType(mediaType),
    body,
    byteLength,
    digest,
    provenance: Object.freeze({ ...provenance }),
    capabilities: Object.freeze([...capabilities]),
    release,
  });
}

export async function collectResourceBody(body, { maximumBytes = Infinity, url } = {}) {
  if (!(body instanceof ReadableStream)) {
    throw new SandomHostError(
      "invalid-host-response",
      `Host response body for ${url} must be a ReadableStream; received ${describe(body)}`,
    );
  }
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new SandomHostError(
          "invalid-host-response",
          `Host response body for ${url} produced a ${describe(value)} chunk; expected Uint8Array`,
        );
      }
      length += value.byteLength;
      if (length > maximumBytes) {
        throw new SandomHostError(
          "resource-limit",
          `Host response body for ${url} exceeds ${maximumBytes} bytes`,
          { details: { maximumBytes } },
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Validates one host response for one demand and reads its complete body.
export async function receiveResourceResponse(response, backend, demandURL) {
  if (response === null || typeof response !== "object") {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} returned ${describe(response)} for ${demandURL}; expected a resource response`,
    );
  }
  let requestedURL;
  let finalURL;
  try {
    requestedURL = new URL(response.requestedURL).href;
    finalURL = new URL(response.finalURL).href;
  } catch (cause) {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} response for ${demandURL} has requestedURL ${describe(response.requestedURL)} and finalURL ${describe(response.finalURL)}; both must be absolute URLs`,
      { cause },
    );
  }
  if (response.release !== null && typeof response.release !== "function") {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} response release for ${finalURL} must be a function or null; received ${describe(response.release)}`,
    );
  }
  const bytes = await collectResourceBody(response.body, { url: finalURL });
  if (response.byteLength !== null && response.byteLength !== bytes.byteLength) {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} response for ${finalURL} declared ${response.byteLength} bytes and delivered ${bytes.byteLength}`,
    );
  }
  const digest = await sha256Digest(bytes);
  if (response.digest !== null && response.digest !== digest) {
    throw new SandomHostError(
      "invalid-host-response",
      `Host ${backend} response for ${finalURL} declared digest ${response.digest} and delivered ${digest}`,
    );
  }
  return Object.freeze({
    requestedURL,
    finalURL,
    mediaType: normalizeMediaType(response.mediaType),
    bytes,
    byteLength: bytes.byteLength,
    digest,
    provenance: Object.freeze({ backend, ...response.provenance }),
    capabilities: Object.freeze([...(response.capabilities ?? [])]),
    release: response.release ?? null,
  });
}

function missingCapability(capability, subject) {
  return new SandomHostError(
    "missing-host-capability",
    `The no-resource host has no ${capability} capability; ${subject}`,
    { details: { capability } },
  );
}

// A host for a pure Document Object Model tree. Its first external demand
// fails with a typed host-capability error.
export function createNoResourceHost() {
  return Object.freeze({
    backend: "no-resource",
    openResourceSession() {
      return Object.freeze({
        request(demand) {
          return Promise.reject(missingCapability(
            "resource",
            `the ${demand.destination} demand ${JSON.stringify(demand.reference)} against ${demand.baseURL} has no provider`,
          ));
        },
        fetch(input) {
          return Promise.reject(
            missingCapability("script fetch", `fetch(${JSON.stringify(String(input?.url ?? input))}) has no provider`),
          );
        },
        release() {},
      });
    },
    openModuleSession() {
      return Object.freeze({
        execute(request) {
          return Promise.reject(missingCapability(
            "module",
            `module ${JSON.stringify(request.reference)} against ${request.baseURL} has no module session`,
          ));
        },
        release() {},
      });
    },
  });
}

export const noResourceHost = createNoResourceHost();
