// The local command host: file and data: resources, the `--asset-root`
// mapping, and file module graphs. It has no network provider and refuses
// every http: and https: reference before any request.
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath, sep as pathSeparator } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bytesBody,
  createResourceResponse,
  resolveDemandURL,
  SandomHostError,
} from "./contract.js";
import { dataURLResponse } from "./data-url.js";
import { createModuleGraphSession } from "./module-graph-session.js";
import { createDefaultClassicScriptSession } from "./default-classic-scripts.js";

export const LOCAL_COMMAND_HOST_BACKEND = "local-command";

const MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".jsx": "text/jsx",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jxl": "image/jxl",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
});

const CAPABILITIES = Object.freeze(["file-read", "data-decode", "file-module-graph"]);

function mediaTypeForPath(path) {
  const slash = path.lastIndexOf("/");
  const period = path.lastIndexOf(".");
  if (period <= slash) return null;
  return MEDIA_TYPE_BY_EXTENSION[path.slice(period).toLowerCase()] ?? null;
}

function normalizeRoot(root) {
  const path = root instanceof URL || String(root).startsWith("file:")
    ? fileURLToPath(root)
    : String(root);
  if (!path.startsWith("/")) {
    throw new TypeError(`Authorized root ${JSON.stringify(path)} must be an absolute path or file URL`);
  }
  return resolvePath(path);
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(pathSeparator) ? root : `${root}${pathSeparator}`);
}

let freshModuleSequence = 0;

// Evaluates one file module graph with the runtime module loader. The entry
// is a short-lived sibling copy of the supplied bytes: the copy keeps static
// relative imports and import.meta.url resolution, and each evaluation is a
// new module instance.
async function importFileModuleGraph(entryURL, bytes) {
  const sourceURL = new URL(entryURL);
  const extensionIndex = sourceURL.pathname.lastIndexOf(".");
  const slashIndex = sourceURL.pathname.lastIndexOf("/");
  const extension = extensionIndex > slashIndex
    ? sourceURL.pathname.slice(extensionIndex)
    : ".js";
  const identifier = `${Date.now()}-${++freshModuleSequence}-${crypto.randomUUID()}`;
  const temporaryURL = new URL(
    `.sandom-module-${identifier}${extension}`,
    new URL(".", sourceURL),
  );
  await writeFile(temporaryURL, bytes);
  let evaluationError = null;
  try {
    return await import(temporaryURL.href);
  } catch (error) {
    evaluationError = error;
    throw error;
  } finally {
    try {
      await unlink(temporaryURL);
    } catch (cleanupError) {
      const releaseFailure = new SandomHostError(
        "host-release-failure",
        `Temporary module ${temporaryURL.href} for ${sourceURL.href} could not be removed: ${cleanupError.message}`,
        { cause: cleanupError },
      );
      if (evaluationError) {
        // deno-lint-ignore no-unsafe-finally
        throw new AggregateError(
          [evaluationError, releaseFailure],
          `Module evaluation and temporary module cleanup failed for ${sourceURL.href}`,
        );
      }
      // deno-lint-ignore no-unsafe-finally
      throw releaseFailure;
    }
  }
}

// `authorizedRoots` lists the directories whose files the host may read.
// `assetRoot` maps a root-relative reference of a file document, such as
// `/assets/logo.png`, below that directory.
export function createLocalSandomHost({ authorizedRoots, assetRoot = null } = {}) {
  if (!Array.isArray(authorizedRoots) || authorizedRoots.length === 0) {
    throw new TypeError(
      `createLocalSandomHost requires a non-empty authorizedRoots array; received ${String(authorizedRoots)}`,
    );
  }
  const roots = authorizedRoots.map(normalizeRoot);
  const normalizedAssetRoot = assetRoot === null ? null : normalizeRoot(assetRoot);
  let realRoots = null;

  const authorize = async (path, url) => {
    if (!roots.some((root) => within(path, root))) {
      throw new SandomHostError(
        "unauthorized-file-path",
        `File ${path} is outside the authorized roots ${roots.join(", ")}`,
        { details: { path, url } },
      );
    }
    let real;
    try {
      real = await realpath(path);
    } catch (cause) {
      if (cause?.code === "ENOENT" || cause?.name === "NotFound") {
        throw new SandomHostError("resource-unavailable", `File ${path} does not exist`, {
          cause,
          details: { path, url },
        });
      }
      throw cause;
    }
    realRoots ??= await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
    if (!realRoots.some((root) => within(real, root))) {
      throw new SandomHostError(
        "unauthorized-file-path",
        `File ${path} resolves to ${real}, outside the authorized roots ${roots.join(", ")}`,
        { details: { path, url, realPath: real } },
      );
    }
    return real;
  };

  const readAuthorizedFile = async (url) => {
    const path = fileURLToPath(url);
    const real = await authorize(path, url.href);
    return { path, bytes: new Uint8Array(await readFile(real)) };
  };

  const routeLocator = (url) => {
    if (url.protocol === "http:" || url.protocol === "https:") {
      throw new SandomHostError(
        "missing-host-capability",
        `The local command host has no network provider; it refuses ${url.href}`,
        { details: { capability: "network", url: url.href } },
      );
    }
    if (url.protocol !== "file:" && url.protocol !== "data:") {
      throw new SandomHostError(
        "unsupported-resource-scheme",
        `The local command host serves file: and data: locators; ${url.protocol} in ${url.href} has no provider`,
        { details: { scheme: url.protocol } },
      );
    }
  };

  const fileResponse = async (requestedURL, fileURL) => {
    const { path, bytes } = await readAuthorizedFile(fileURL);
    return createResourceResponse({
      requestedURL,
      finalURL: fileURL.href,
      mediaType: mediaTypeForPath(path),
      body: bytesBody(bytes),
      byteLength: bytes.byteLength,
      provenance: { provider: "file", path },
      capabilities: CAPABILITIES,
    });
  };

  const request = async (demand) => {
    const requestedURL = resolveDemandURL(demand);
    routeLocator(requestedURL);
    if (requestedURL.protocol === "data:") return dataURLResponse(requestedURL.href);
    const reference = demand.reference;
    if (
      normalizedAssetRoot !== null &&
      reference.startsWith("/") && !reference.startsWith("//") &&
      new URL(demand.baseURL).protocol === "file:"
    ) {
      const serverPath = decodeURIComponent(new URL(reference, "file:///").pathname);
      const mappedPath = resolvePath(normalizedAssetRoot, `.${serverPath}`);
      if (!within(mappedPath, normalizedAssetRoot)) {
        throw new SandomHostError(
          "unauthorized-file-path",
          `Asset path ${reference} escapes the asset root ${normalizedAssetRoot}`,
          { details: { reference, assetRoot: normalizedAssetRoot } },
        );
      }
      return await fileResponse(requestedURL.href, pathToFileURL(mappedPath));
    }
    return await fileResponse(requestedURL.href, requestedURL);
  };

  // Script fetch of a local document: file: and data: locators only.
  const scriptFetch = async (input, init = {}) => {
    const locator = new URL(String(input?.url ?? input));
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    routeLocator(locator);
    if (method !== "GET" && method !== "HEAD") {
      throw new SandomHostError(
        "unauthorized-method",
        `The local command host serves GET and HEAD; ${method} ${locator.href} is refused`,
        { details: { method } },
      );
    }
    let bytes;
    let mediaType;
    if (locator.protocol === "data:") {
      const response = dataURLResponse(locator.href);
      bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
      mediaType = response.mediaType;
    } else {
      const file = await readAuthorizedFile(locator);
      bytes = file.bytes;
      mediaType = mediaTypeForPath(file.path);
    }
    return new Response(method === "HEAD" ? null : bytes, {
      status: 200,
      headers: mediaType === null ? {} : { "content-type": mediaType },
    });
  };

  return Object.freeze({
    backend: LOCAL_COMMAND_HOST_BACKEND,
    capabilities: CAPABILITIES,
    authorizedRoots: Object.freeze([...roots]),
    assetRoot: normalizedAssetRoot,
    openResourceSession() {
      return Object.freeze({
        request,
        fetch: scriptFetch,
        release() {},
      });
    },
    // A module script of a document whose scripts run in a realm of their
    // own (`scriptRealm`) evaluates in that realm, through a module graph
    // session; the runtime's module loader evaluates only in the caller's
    // realm.
    openModuleSession(context) {
      const { requestModule } = context;
      let realmGraphs = null;
      return Object.freeze({
        async execute(request) {
          if (request.scriptRealm !== undefined && request.scriptRealm !== null) {
            realmGraphs ??= createModuleGraphSession(context);
            return await realmGraphs.execute(request);
          }
          const { reference, baseURL, source } = request;
          let entryURL;
          try {
            entryURL = new URL(reference, baseURL);
          } catch (cause) {
            throw new SandomHostError(
              "module-resolution-failure",
              `Module entry ${JSON.stringify(reference)} does not resolve against ${baseURL}`,
              { cause },
            );
          }
          let bytes = source;
          if (bytes === null) {
            const resource = await requestModule({ reference, baseURL });
            entryURL = new URL(resource.finalURL);
            bytes = resource.bytes;
          }
          if (entryURL.protocol !== "file:") {
            throw new SandomHostError(
              "module-resolution-failure",
              `The local command host evaluates file module graphs; entry ${entryURL.href} is not a file: locator`,
              { details: { url: entryURL.href } },
            );
          }
          await authorize(fileURLToPath(new URL(".", entryURL)), entryURL.href);
          try {
            return await importFileModuleGraph(entryURL, bytes);
          } catch (cause) {
            if (cause instanceof SandomHostError) throw cause;
            throw new SandomHostError(
              "module-evaluation-failure",
              `Module ${entryURL.href} failed: ${cause?.message ?? String(cause)}`,
              { cause },
            );
          }
        },
        release() {
          realmGraphs?.release();
        },
      });
    },
    // Local documents are trusted: their classic scripts run on the
    // caller's thread, in a global scope of the document's own.
    openClassicScriptSession() {
      return createDefaultClassicScriptSession();
    },
  });
}
