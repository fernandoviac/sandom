import { sharedDomCore } from "../dom-wasm/core.js";
import {
  acquireAmbientGlobalOwnership,
  installComponentGlobals,
} from "./component-globals.js";
import { parseHTMLDocument } from "./html.js";
import { loadHTMLDocument, reportScriptingDisabled } from "./scripts.js";
import { parseXMLDocument } from "./xml.js";
import { exceedsInputBound } from "./interaction.js";
import { SDDocument } from "./node.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const stringTrim = String.prototype.trim;
const stringLastIndexOf = String.prototype.lastIndexOf;
const stringSlice = String.prototype.slice;
const stringCharCodeAt = String.prototype.charCodeAt;

function preprocessorText(operation, text, ...parameters) {
  return sharedDomCore.status(
    operation,
    ...sharedDomCore.input(text),
    ...parameters,
  );
}

// Method lookup, receiver conversion, and non-intrinsic calls are observable.
// Native offsets are UTF-16; materialize from the original string so lone
// surrogates and slices through surrogate pairs are not replaced by UTF-8.
function preprocessorTrim(value) {
  const method = value.trim;
  if (method !== stringTrim) return Reflect.apply(method, value, []);
  const text = `${value}`;
  const range = preprocessorText("input_preprocessor_trim", text);
  return Reflect.apply(stringSlice, text, [
    Number(range & 0xffff_ffffn),
    Number(range >> 32n),
  ]);
}
function preprocessorLastIndex(value, character, delimiter) {
  const method = value.lastIndexOf;
  if (method !== stringLastIndexOf) {
    return Reflect.apply(method, value, [character]);
  }
  return preprocessorText(
    "input_preprocessor_last_index",
    `${value}`,
    delimiter,
  );
}

function preprocessorSlice(value, start) {
  const method = value.slice;
  if (method !== stringSlice) return Reflect.apply(method, value, [start]);
  const text = `${value}`;
  const offset = preprocessorText("input_preprocessor_slice_start", text, +start);
  return Reflect.apply(stringSlice, text, [offset]);
}

function preprocessorHasExtension(period, slash) {
  // Shared relational transport preserves custom-result ToPrimitive ordering;
  // normalized string, Number, and BigInt comparisons all execute natively.
  if (typeof period !== "number" || typeof slash !== "number") {
    return exceedsInputBound(period, slash);
  }
  return sharedDomCore.status("input_preprocessor_has_extension", period, slash);
}

function preprocessorEmpty(value) {
  return typeof value === "string" &&
    preprocessorText("input_preprocessor_empty", value);
}

function preprocessorUniqueCount(values) {
  // The map result may have a custom iterator yielding arbitrary values.
  // Only opaque object/symbol identities stay here; native compares strings,
  // numbers (SameValueZero), bigint text, and the normalized identity tokens.
  const identities = new Map();
  const records = [];
  let bytes = 0;
  for (const value of values) {
    let tag;
    let payload;
    switch (typeof value) {
      case "string":
      case "bigint": {
        tag = typeof value === "string" ? 1 : 3;
        const text = typeof value === "string" ? value : `${value}`;
        payload = new Uint8Array(text.length * 2);
        const view = new DataView(payload.buffer);
        for (let index = 0; index < text.length; index++) {
          view.setUint16(index * 2, Reflect.apply(stringCharCodeAt, text, [index]), true);
        }
        break;
      }
      case "number":
        tag = 2;
        payload = new Uint8Array(8);
        new DataView(payload.buffer).setFloat64(0, value, true);
        break;
      case "undefined":
        tag = 5;
        payload = new Uint8Array(0);
        break;
      case "boolean":
        tag = value ? 7 : 8;
        payload = new Uint8Array(0);
        break;
      default:
        if (value === null) {
          tag = 6;
          payload = new Uint8Array(0);
          break;
        }
        tag = 4;
        if (!identities.has(value)) identities.set(value, identities.size);
        payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, identities.get(value), true);
    }
    records.push([tag, payload]);
    bytes += 8 + payload.byteLength;
  }
  const block = new Uint8Array(bytes);
  const view = new DataView(block.buffer);
  let offset = 0;
  for (const [tag, payload] of records) {
    view.setUint32(offset, tag, true);
    view.setUint32(offset + 4, payload.byteLength, true);
    block.set(payload, offset + 8);
    offset += 8 + payload.byteLength;
  }
  return sharedDomCore.status(
    "input_preprocessor_unique_count",
    ...sharedDomCore.byteInput(block),
    records.length,
  );
}

function createHTMLStructure(document) {
  const html = document.createElement("html");
  const head = document.createElement("head");
  const body = document.createElement("body");
  document.appendChild(html);
  html.append(head, body);
}

function descriptorsForAmbientWindow(window) {
  return Reflect.ownKeys(window)
    .filter((name) => name !== "globalThis")
    .map((name) => [
      name,
      Object.getOwnPropertyDescriptor(window, name),
    ]);
}

// Installs the document window as the ambient realm globals for one host
// module evaluation and restores the prior globals afterwards. The host
// module session evaluates; Sandom only supplies the environment.
async function withComponentGlobals(window, evaluate) {
  const releaseOwnership = await acquireAmbientGlobalOwnership(
    "file-preparation",
  );
  const ambientGlobal = globalThis;

  const ambientDescriptors = descriptorsForAmbientWindow(window);
  const priorDescriptors = new Map();
  const installedNames = [];
  let evaluationError = null;
  const restorationErrors = [];
  let moduleExports;
  try {
    for (const [name, descriptor] of ambientDescriptors) {
      priorDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(ambientGlobal, name),
      );
      Object.defineProperty(ambientGlobal, name, descriptor);
      installedNames.push(name);
    }
    moduleExports = await evaluate();
  } catch (error) {
    evaluationError = error;
  } finally {
    for (let index = installedNames.length - 1; index >= 0; index--) {
      const name = installedNames[index];
      try {
        const priorDescriptor = priorDescriptors.get(name);
        if (priorDescriptor) {
          Object.defineProperty(ambientGlobal, name, priorDescriptor);
        } else if (!delete ambientGlobal[name]) {
          restorationErrors.push(
            new TypeError(`Cannot restore absent global ${String(name)}`),
          );
        }
      } catch (error) {
        restorationErrors.push(error);
      }
    }
    releaseOwnership();
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      evaluationError
        ? [evaluationError, ...restorationErrors]
        : restorationErrors,
      "Failed to restore ambient JavaScript globals",
    );
  }
  if (evaluationError) throw evaluationError;
  return moduleExports;
}

function validateModuleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("executeModule requires a { reference, baseURL, source, preprocessor } object");
  }
  if (typeof request.reference !== "string" || request.reference.length === 0) {
    throw new TypeError(
      `executeModule reference must be a non-empty string; received ${String(request.reference)}`,
    );
  }
  const source = request.source ?? null;
  if (source !== null && !(source instanceof Uint8Array)) {
    throw new TypeError("executeModule source must be a Uint8Array or null");
  }
  return Object.freeze({
    reference: request.reference,
    baseURL: new URL(request.baseURL).href,
    source,
    preprocessor: request.preprocessor ?? "javascript",
    importMaps: Object.freeze((request.importMaps ?? []).map(({ text, baseURL }) =>
      Object.freeze({ text: String(text), baseURL: new URL(baseURL).href })
    )),
  });
}

// Asks the document's host module session to execute one module entry
// against the document window. The host resolves, requests, links, and
// evaluates the module graph. `request.realm` is the document realm when
// the document's scripts run in a realm of their own: the host evaluates
// the graph in it, where the window bindings already are.
function executeDocumentModule(document, window, request, signal) {
  const moduleRequest = validateModuleRequest(request);
  const moduleSession = document._resources.moduleSession;
  const realm = request.realm ?? null;
  if (realm !== null) {
    return moduleSession.execute(Object.freeze({
      ...moduleRequest,
      globalEnvironment: realm.globalObject,
      scriptRealm: realm.session,
      signal,
    }));
  }
  // Once the document's classic scripts hold the module realm's global
  // object, a module evaluates against it as it is.
  if (document._realm && document._realm.globalObject === globalThis) {
    return moduleSession.execute(Object.freeze({
      ...moduleRequest,
      globalEnvironment: globalThis,
      signal,
    }));
  }
  return withComponentGlobals(
    window,
    () =>
      moduleSession.execute(Object.freeze({
        ...moduleRequest,
        globalEnvironment: window,
        signal,
      })),
  );
}

// Evaluates one component module with the host of `document`. `input` is
// the module locator, or `{ url, bytes }` with the entry source supplied.
export async function evaluateComponentModule(input, document) {
  if (!(document instanceof SDDocument)) {
    throw new TypeError("evaluateComponentModule requires a SandomDocument");
  }

  let request;
  if (input instanceof URL || typeof input === "string") {
    const moduleURL = new URL(input).href;
    request = { reference: moduleURL, baseURL: moduleURL, source: null };
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    const moduleURL = new URL(input.url).href;
    if (input.bytes !== undefined && !(input.bytes instanceof Uint8Array)) {
      throw new TypeError("input.bytes must be a Uint8Array");
    }
    request = {
      reference: moduleURL,
      baseURL: moduleURL,
      source: input.bytes ?? null,
    };
  } else {
    throw new TypeError(
      "input must be a URL, absolute URL string, or { url, bytes } object",
    );
  }
  const preprocessor = new URL(request.reference).pathname.endsWith(".jsx")
    ? "jsx"
    : "javascript";

  const window = document.defaultView ?? installComponentGlobals({}, document);
  if (
    window.document !== document ||
    window.customElements !== document.customElements
  ) {
    throw new TypeError(
      "SandomDocument defaultView must belong to the evaluated document",
    );
  }
  return await executeDocumentModule(
    document,
    window,
    { ...request, preprocessor },
    undefined,
  );
}

export const htmlPreprocessor = Object.freeze({
  name: "html",
  extensions: Object.freeze([".html", ".htm"]),
  async prepare({ input, document, executeModule }) {
    const text = textDecoder.decode(input.bytes);
    // A host with a classic-script session gives the document scripting:
    // the parser stops at each script, and classic, module and inserted
    // scripts run in the standard's order (src/dom/scripts.js).
    if (document._resources.scriptingEnabled) {
      await loadHTMLDocument(document, text, { inputURL: input.url, executeModule });
      return;
    }
    parseHTMLDocument(text, () => document);
    reportScriptingDisabled(document);
    // Import maps are document declarations; the host module session
    // applies them.
    const importMapScripts = document.querySelectorAll('script[type="importmap"]');
    const importMaps = [];
    for (let index = 0; index < importMapScripts.length; index += 1) {
      importMaps.push({
        text: importMapScripts[index].textContent,
        baseURL: document.baseURI,
      });
    }
    const moduleScripts = document.querySelectorAll('script[type="module"]');
    for (let index = 0; index < moduleScripts.length; index += 1) {
      const script = moduleScripts[index];
      const source = script.getAttribute("src");
      if (source !== null) {
        await executeModule({
          reference: source,
          baseURL: document.baseURI,
          source: null,
          preprocessor: "javascript",
          importMaps,
        });
        continue;
      }
      // An inline module has a stable synthetic identity under the
      // document locator.
      const moduleURL = new URL(input.url);
      moduleURL.pathname += `.inline-${index + 1}.js`;
      moduleURL.hash = `inline-module-${index + 1}`;
      await executeModule({
        reference: moduleURL.href,
        baseURL: document.baseURI,
        source: textEncoder.encode(script.textContent),
        preprocessor: "javascript",
        importMaps,
      });
    }
  },
});

export const javascriptPreprocessor = Object.freeze({
  name: "javascript",
  extensions: Object.freeze([".js", ".mjs"]),
  async prepare({ input, document, executeModule }) {
    createHTMLStructure(document);
    await executeModule({
      reference: input.url.href,
      baseURL: input.url.href,
      source: input.bytes,
      preprocessor: "javascript",
    });
  },
});

export const jsxPreprocessor = Object.freeze({
  name: "jsx",
  extensions: Object.freeze([".jsx"]),
  async prepare({ input, document, executeModule }) {
    createHTMLStructure(document);
    await executeModule({
      reference: input.url.href,
      baseURL: input.url.href,
      source: input.bytes,
      preprocessor: "jsx",
    });
  },
});

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// A standalone SVG document: the XML tree with the svg element as the
// document element, as a browser opens an image/svg+xml file.
export const svgPreprocessor = Object.freeze({
  name: "svg",
  extensions: Object.freeze([".svg"]),
  prepare({ input, document }) {
    parseXMLDocument(
      textDecoder.decode(input.bytes),
      "image/svg+xml",
      () => document,
    );
    const diagnostic = document._domCore.xmlParseDiagnostic();
    if (diagnostic !== null) {
      throw new SyntaxError(
        `SVG input ${input.url.href} is not well-formed XML: ${diagnostic.message} at line ${diagnostic.line}, column ${diagnostic.column}`,
      );
    }
    const root = document.documentElement;
    if (root?.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
      throw new TypeError(
        `SVG input ${input.url.href} has document element ${
          root === null
            ? "null"
            : JSON.stringify(`{${root.namespaceURI}}${root.localName}`)
        }; expected an svg element in the ${SVG_NAMESPACE} namespace`,
      );
    }
  },
});

export const builtInPreprocessors = Object.freeze([
  htmlPreprocessor,
  javascriptPreprocessor,
  jsxPreprocessor,
  svgPreprocessor,
]);

function validatePreprocessor(candidate, source) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${source} preprocessor must be an object`);
  }
  if (typeof candidate.name !== "string" || preprocessorEmpty(preprocessorTrim(candidate.name))) {
    throw new TypeError(
      `${source} preprocessor name must be a non-empty string`,
    );
  }
  if (candidate.name !== preprocessorTrim(candidate.name)) {
    throw new TypeError(
      `${source} preprocessor name must not contain outer whitespace`,
    );
  }
  if (
    !Array.isArray(candidate.extensions) || candidate.extensions.length === 0
  ) {
    throw new TypeError(
      `${source} preprocessor extensions must be a non-empty array`,
    );
  }
  const extensions = candidate.extensions.map((extension) => {
    if (
      typeof extension !== "string" ||
      !preprocessorText("input_preprocessor_extension_valid", extension)
    ) {
      throw new TypeError(
        `${source} preprocessor extension ${
          JSON.stringify(extension)
        } must be exact lower-case text that starts with a period`,
      );
    }
    return extension;
  });
  if (preprocessorUniqueCount(extensions) !== extensions.length) {
    throw new TypeError(`${source} preprocessor has a duplicate extension`);
  }
  if (typeof candidate.prepare !== "function") {
    throw new TypeError(`${source} preprocessor prepare must be a function`);
  }
  return Object.freeze({
    name: candidate.name,
    extensions: Object.freeze(extensions),
    prepare: candidate.prepare,
  });
}

export function createPreprocessorRegistry(additionalPreprocessors = []) {
  if (!Array.isArray(additionalPreprocessors)) {
    throw new TypeError("preprocessors must be an array");
  }
  const preprocessors = [
    ...builtInPreprocessors.map((preprocessor) =>
      validatePreprocessor(preprocessor, "Built-in")
    ),
    ...additionalPreprocessors.map((preprocessor, index) =>
      validatePreprocessor(preprocessor, `Caller-supplied index ${index}`)
    ),
  ];
  const byName = new Map();
  const byExtension = new Map();
  for (const preprocessor of preprocessors) {
    if (byName.has(preprocessor.name)) {
      throw new TypeError(
        `Duplicate preprocessor name ${JSON.stringify(preprocessor.name)}`,
      );
    }
    byName.set(preprocessor.name, preprocessor);
    for (const extension of preprocessor.extensions) {
      const previous = byExtension.get(extension);
      if (previous) {
        throw new TypeError(
          `Duplicate preprocessor extension ${JSON.stringify(extension)} for ${
            JSON.stringify(previous.name)
          } and ${JSON.stringify(preprocessor.name)}`,
        );
      }
      byExtension.set(extension, preprocessor);
    }
  }
  return Object.freeze({
    byName,
    byExtension,
    preprocessors: Object.freeze(preprocessors),
  });
}

export function selectPreprocessor(registry, inputURL, explicitName) {
  if (explicitName !== undefined && explicitName !== null) {
    if (typeof explicitName !== "string" || preprocessorEmpty(explicitName)) {
      throw new TypeError("preprocessor must be a non-empty string");
    }
    const selected = registry.byName.get(explicitName);
    if (selected) return selected;
    throw new RangeError(
      `Unsupported preprocessor ${
        JSON.stringify(explicitName)
      } for ${inputURL.href}; available preprocessors: ${
        registry.preprocessors.map(({ name }) => name).join(", ")
      }`,
    );
  }
  const slashIndex = preprocessorLastIndex(inputURL.pathname, "/", 47);
  const periodIndex = preprocessorLastIndex(inputURL.pathname, ".", 46);
  const extension = preprocessorHasExtension(periodIndex, slashIndex)
    ? preprocessorSlice(inputURL.pathname, periodIndex)
    : "";
  const selected = registry.byExtension.get(extension);
  if (selected) return selected;
  throw new RangeError(
    `Unsupported input ${inputURL.href}; available preprocessors: ${
      registry.preprocessors.map(({ name }) => name).join(", ")
    }`,
  );
}

export function createInputWindow(document) {
  return installComponentGlobals({}, document);
}

export function createModuleExecutor(document, window, signal) {
  return (request) => executeDocumentModule(document, window, request, signal);
}
