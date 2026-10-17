import { validateSandomHost } from "../host/contract.js";
import { installComponentGlobals } from "./component-globals.js";
import { enterDocumentRealm, installDocumentFetch } from "./document-realm.js";
import { SDDocument } from "./node.js";

function normalizeStylesheets(stylesheets, documentURL) {
  if (!Array.isArray(stylesheets)) {
    throw new TypeError("stylesheets must be an array");
  }
  const sourcesByURL = new Map();
  return Object.freeze(stylesheets.map((stylesheet) => {
    if (
      !stylesheet || typeof stylesheet !== "object" ||
      Array.isArray(stylesheet)
    ) {
      throw new TypeError("Each stylesheet must be a { url, source } object");
    }
    const keys = Reflect.ownKeys(stylesheet);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => !["url", "source"].includes(key)) ||
      !keys.includes("url") || !keys.includes("source")
    ) {
      throw new TypeError("Each stylesheet must contain only url and source");
    }
    if (typeof stylesheet.source !== "string") {
      throw new TypeError("stylesheet.source must be a string");
    }
    const url = new URL(stylesheet.url, documentURL).href;
    const previousSource = sourcesByURL.get(url);
    if (previousSource !== undefined && previousSource !== stylesheet.source) {
      throw new Error(`Conflicting generated stylesheet sources for ${url}`);
    }
    sourcesByURL.set(url, stylesheet.source);
    return Object.freeze({ url, source: stylesheet.source });
  }));
}

// Every MathML element's unsupported MathML, as recoverable warnings that
// name the element (docs/design/mathml-layout.md, Diagnostics).
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
function mathmlDiagnostics(document) {
  const diagnostics = [];
  for (const element of document.querySelectorAll("*")) {
    if (element.namespaceURI !== MATHML_NAMESPACE) continue;
    for (const { code, message } of element._domCore.mathmlDiagnostics(element._coreHandle)) {
      diagnostics.push(Object.freeze({
        code,
        severity: "warning",
        recoverable: true,
        message,
        owner: Object.freeze({ element: `${element.localName}${element.id ? `#${element.id}` : ""}` }),
      }));
    }
  }
  return diagnostics;
}

// Creates one document whose every resource demand goes to `host`. The
// host is mandatory: Sandom has no provider of its own. `clock` is the
// document's clock (src/dom/document-clock.js), or null for the host's
// real clock. The document is made synchronously; the promise keeps the
// contract, and a throw becomes its rejection.
export function createPreparedDocument(options) {
  return Promise.try(preparedDocument, options);
}

function preparedDocument({
  url = "about:blank",
  host,
  windowTarget = {},
  reportException = null,
  core,
  fontRegistry,
  clock = null,
} = {}) {
  validateSandomHost(host, "createPreparedDocument");
  const documentURL = new URL(url).href;
  if (reportException !== null && typeof reportException !== "function") {
    throw new TypeError("reportException must be a function or null");
  }
  let released = false;

  const document = new SDDocument({
    core,
    fontRegistry,
    url: documentURL,
    host,
    reportException,
    enterRealm: enterDocumentRealm,
    clock,
  });
  const resources = document._resources;
  const window = windowTarget === null
    ? null
    : installComponentGlobals(windowTarget, document);
  if (window !== null) installDocumentFetch(window, document);

  return Object.freeze({
    document,
    window,
    host,
    resolveResource: document._resolveResource,
    attachStylesheets(stylesheets) {
      if (released) throw new Error("prepared document has been released");
      if (!document.head) {
        throw new Error("Generated stylesheets require a document head");
      }
      const normalized = normalizeStylesheets(stylesheets, documentURL);
      for (const stylesheet of normalized) {
        resources.supplyStylesheetSource(stylesheet.url, stylesheet.source);
        const link = document.createElement("link");
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("href", stylesheet.url);
        document.head.appendChild(link);
      }
      return normalized;
    },
    async ready() {
      if (released) throw new Error("prepared document has been released");
      await document._readyForRendering();
    },
    get resources() {
      return resources.records;
    },
    get diagnostics() {
      return Object.freeze([
        ...document._styleSystem.resourceDiagnostics,
        ...document._brokenImageDiagnostics.values(),
        ...[...document._unanimatedPropertyDiagnostics.values()].flatMap((properties) => [...properties.values()]),
        ...mathmlDiagnostics(document),
        ...(document._scriptProcessing?.diagnostics ?? []),
      ]);
    },
    async release() {
      if (released) return;
      released = true;
      const errors = [];
      // The document's scripts stop, and its window bindings leave the
      // realm that holds them.
      try {
        document._scriptProcessing?.release();
      } catch (error) {
        errors.push(...(error instanceof AggregateError ? error.errors : [error]));
      }
      try {
        document._styleSystem.releaseFonts();
      } catch (error) {
        errors.push(error);
      }
      try {
        await resources.release();
      } catch (error) {
        errors.push(...(error instanceof AggregateError ? error.errors : [error]));
      }
      // The document's nodes give back the resources they bind now, rather
      // than when the garbage collector finalizes the document, so a
      // long-lived renderer can reclaim their image indices at once.
      try {
        document._domCore.releaseDocumentResourceBindings(document._coreHandle);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `${errors.length} prepared-document resource release(s) failed`,
        );
      }
    },
  });
}
