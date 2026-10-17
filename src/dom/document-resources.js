// The document side of the host resource session.
//
// A document declares each resource demand here: stylesheets, @import
// rules, fonts, images, module scripts, and script fetch. The loader builds
// the demand record, sends it to the host resource session, reads the
// returned body, and keeps the resource records. It has no provider of its
// own: a document without a host uses the no-resource host, which refuses
// the first demand with a typed host-capability error.
import {
  createResourceDemand,
  noResourceHost,
  originOf,
  receiveResourceResponse,
  SandomHostError,
  validateClassicScriptSession,
  validateModuleSession,
  validateResourceSession,
  sha256Digest,
  validateSandomHost,
} from "../host/contract.js";

const DESTINATION_BY_KIND = Object.freeze({
  document: "document",
  stylesheet: "style",
  font: "font",
  image: "image",
  module: "script",
  "classic-script": "script",
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let nextResourceGeneration = 1;

function releaseError(backend, url, cause) {
  return new SandomHostError(
    "host-release-failure",
    `Host ${backend} failed to release ${url}: ${cause?.message ?? String(cause)}`,
    { cause },
  );
}

// The key under which a renderer runtime keeps what it derives from a
// resource (an image's decode and IMAGE_TABLE index, src/scene-renderer.js).
// A runtime outlives the document and serves documents of other hosts and
// generations, where one URL can deliver other bytes: the key names the
// bytes as well as the URL.
function resourceCacheKey(finalURL, digest) {
  return `${digest} ${finalURL}`;
}

export function createDocumentResourceLoader({
  host = noResourceHost,
  documentURL,
  topLevelOrigin = null,
}) {
  validateSandomHost(host, "Document resource loading");
  const normalizedDocumentURL = new URL(documentURL).href;
  const clientOrigin = originOf(normalizedDocumentURL);
  const generation = nextResourceGeneration++;
  const abortController = new AbortController();
  const resourcesByURL = new Map();
  const suppliedStylesheetSources = new Map();
  const hostReleases = new Set();
  // One demand for each image URL, also a failed one: the DOM image loading
  // (src/dom/images.js) and the scene renderer request an image through
  // the same demand, so the host fetches it once.
  const imageDemands = new Map();
  let resourceSession = null;
  let moduleSession = null;
  let classicScriptSession = null;
  let cachedRecords = null;
  let released = false;

  const session = () => {
    if (released) {
      throw new SandomHostError(
        "stale-resource-generation",
        `Resource generation ${generation} of ${normalizedDocumentURL} has been released`,
        { details: { generation } },
      );
    }
    resourceSession ??= validateResourceSession(
      host.openResourceSession(Object.freeze({
        documentURL: normalizedDocumentURL,
        clientOrigin,
        topLevelOrigin: topLevelOrigin ?? clientOrigin,
        generation,
        signal: abortController.signal,
      })),
      host.backend,
    );
    return resourceSession;
  };

  // The internal demand of the renderer: `requestedURL` is the reference
  // the renderer resolved for its cache identity, `authoredURL` the text
  // the author wrote, `baseURL` the base Sandom selected.
  const resolveResource = (demand) => {
    if (demand.kind !== "image" || demand.signal !== undefined) return requestResource(demand);
    const requestedFinalURL = URL.parse(
      demand.requestedURL,
      demand.baseURL ?? normalizedDocumentURL,
    )?.href ?? null;
    if (requestedFinalURL === null) return requestResource(demand);
    let pending = imageDemands.get(requestedFinalURL);
    if (pending === undefined) {
      pending = requestResource(demand);
      imageDemands.set(requestedFinalURL, pending);
    }
    return pending;
  };

  const requestResource = async ({
    requestedURL,
    authoredURL = requestedURL,
    baseURL: resourceBaseURL,
    kind,
    signal: demandSignal,
    initiator = null,
    mode,
    credentials,
  }) => {
    const resourceSessionForDemand = session();
    const destination = DESTINATION_BY_KIND[kind];
    if (destination === undefined) {
      throw new TypeError(`Unknown resource kind ${JSON.stringify(kind)}`);
    }
    const baseURL = resourceBaseURL ?? normalizedDocumentURL;
    let requestedFinalURL = null;
    try {
      requestedFinalURL = new URL(requestedURL, baseURL).href;
    } catch {
      // The host resolves the reference and reports its own failure.
    }
    if (requestedFinalURL !== null) {
      const cached = resourcesByURL.get(requestedFinalURL);
      if (cached) return cached;
      const suppliedSource = kind === "stylesheet"
        ? suppliedStylesheetSources.get(requestedFinalURL)
        : undefined;
      if (suppliedSource !== undefined) {
        const bytes = textEncoder.encode(suppliedSource);
        const digest = await sha256Digest(bytes);
        return remember(Object.freeze({
          bytes,
          source: suppliedSource,
          requestedFinalURL,
          finalURL: requestedFinalURL,
          cacheKey: resourceCacheKey(requestedFinalURL, digest),
          mediaType: "text/css",
          byteLength: bytes.byteLength,
          digest,
          provenance: Object.freeze({ backend: "supplied-stylesheet" }),
          opaque: false,
          kind,
        }), requestedFinalURL);
      }
    }
    const signal = demandSignal
      ? AbortSignal.any([abortController.signal, demandSignal])
      : abortController.signal;
    const demand = createResourceDemand({
      reference: authoredURL ?? requestedURL,
      baseURL,
      destination,
      initiator,
      clientOrigin,
      topLevelOrigin: topLevelOrigin ?? clientOrigin,
      mode,
      credentials,
      generation,
      signal,
    });
    const response = await resourceSessionForDemand.request(demand);
    let received;
    try {
      received = await receiveResourceResponse(
        response,
        host.backend,
        requestedFinalURL ?? demand.reference,
      );
    } catch (error) {
      if (typeof response?.release === "function") {
        await response.release();
      }
      throw error;
    }
    if (released || signal.aborted) {
      // A late result never enters a later generation: the host resource
      // goes back to the host at once.
      if (received.release) {
        try {
          await received.release();
        } catch (cause) {
          throw releaseError(host.backend, received.finalURL, cause);
        }
      }
      if (!released && demandSignal?.aborted) throw demandSignal.reason;
      throw new SandomHostError(
        "stale-resource-generation",
        `The ${kind} ${received.finalURL} arrived after resource generation ${generation} of ${normalizedDocumentURL} was released`,
        { details: { generation } },
      );
    }
    if (received.release) hostReleases.add(received);
    const resource = Object.freeze({
      bytes: received.bytes,
      source: kind === "stylesheet" ? textDecoder.decode(received.bytes) : undefined,
      requestedFinalURL: received.requestedURL,
      finalURL: received.finalURL,
      cacheKey: resourceCacheKey(received.finalURL, received.digest),
      mediaType: received.mediaType,
      byteLength: received.byteLength,
      digest: received.digest,
      provenance: received.provenance,
      // The host's internal response of an opaque response: every value
      // derived from it keeps the mark (a stylesheet is not origin-clean, a
      // canvas that draws the image is tainted).
      opaque: received.provenance.responseType === "opaque",
      kind,
    });
    return remember(resource, requestedFinalURL);
  };

  function remember(resource, requestedFinalURL) {
    if (requestedFinalURL !== null) resourcesByURL.set(requestedFinalURL, resource);
    resourcesByURL.set(resource.requestedFinalURL, resource);
    resourcesByURL.set(resource.finalURL, resource);
    cachedRecords = null;
    return resource;
  }

  // Script fetch of the document environment. The host decides whether it
  // has a script fetch provider; Sandom has none.
  const fetch = (input, init) => {
    const fetchSession = session();
    if (typeof fetchSession.fetch !== "function") {
      return Promise.reject(
        new SandomHostError(
          "missing-host-capability",
          `Host ${host.backend} has no script fetch capability for ${String(input?.url ?? input)}`,
          { details: { capability: "script fetch" } },
        ),
      );
    }
    return fetchSession.fetch(input, init);
  };

  // The host module session of this document. It requests every module
  // through this loader, so each module is a recorded resource demand.
  const openModuleSession = () => {
    const resourceSessionForModules = session();
    moduleSession ??= validateModuleSession(
      host.openModuleSession(Object.freeze({
        documentURL: normalizedDocumentURL,
        clientOrigin,
        generation,
        signal: abortController.signal,
        resourceSession: resourceSessionForModules,
        requestModule: ({ reference, baseURL, signal }) =>
          resolveResource({
            requestedURL: reference,
            authoredURL: reference,
            baseURL,
            kind: "module",
            signal,
          }),
        fetch,
      })),
      host.backend,
    );
    return moduleSession;
  };

  // The host classic-script session of this document, or null when the
  // host evaluates no classic script: the document then has scripting
  // disabled.
  const openClassicScriptSession = () => {
    if (classicScriptSession !== null) return classicScriptSession;
    if (host.openClassicScriptSession === undefined) return null;
    session();
    classicScriptSession = validateClassicScriptSession(
      host.openClassicScriptSession(Object.freeze({
        documentURL: normalizedDocumentURL,
        clientOrigin,
        generation,
        signal: abortController.signal,
      })),
      host.backend,
    );
    return classicScriptSession;
  };

  return Object.freeze({
    host,
    generation,
    get backend() {
      return host.backend;
    },
    get resourceSession() {
      return session();
    },
    get moduleSession() {
      return openModuleSession();
    },
    get scriptingEnabled() {
      return host.openClassicScriptSession !== undefined;
    },
    get classicScriptSession() {
      return openClassicScriptSession();
    },
    resolveResource,
    fetch,
    supplyStylesheetSource(url, source) {
      if (released) session();
      suppliedStylesheetSources.set(new URL(url).href, source);
    },
    get records() {
      if (cachedRecords) return cachedRecords;
      cachedRecords = Object.freeze(
        [...new Set(resourcesByURL.values())]
          .map((resource) =>
            Object.freeze({
              requestedFinalURL: resource.requestedFinalURL,
              finalURL: resource.finalURL,
              mediaType: resource.mediaType,
              byteLength: resource.byteLength,
              digest: resource.digest,
              kind: resource.kind,
              provenance: resource.provenance,
            })
          ),
      );
      return cachedRecords;
    },
    async release() {
      if (released) return;
      released = true;
      abortController.abort(
        new SandomHostError(
          "stale-resource-generation",
          `Resource generation ${generation} of ${normalizedDocumentURL} was released`,
          { details: { generation } },
        ),
      );
      const errors = [];
      for (const resource of hostReleases) {
        try {
          await resource.release();
        } catch (cause) {
          errors.push(releaseError(host.backend, resource.finalURL, cause));
        }
      }
      hostReleases.clear();
      if (moduleSession !== null) {
        try {
          await moduleSession.release();
        } catch (cause) {
          errors.push(releaseError(host.backend, `module session of ${normalizedDocumentURL}`, cause));
        }
      }
      if (classicScriptSession !== null) {
        try {
          await classicScriptSession.release();
        } catch (cause) {
          errors.push(releaseError(host.backend, `classic-script session of ${normalizedDocumentURL}`, cause));
        }
      }
      if (resourceSession !== null) {
        try {
          await resourceSession.release();
        } catch (cause) {
          errors.push(releaseError(host.backend, normalizedDocumentURL, cause));
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `${errors.length} host resource releases failed`);
      }
    },
  });
}
