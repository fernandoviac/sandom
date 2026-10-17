import { createRenderSurface as createDOMRenderSurface } from "./render-surface.js";
import { CustomElementRegistry } from "./custom-elements.js";
import { markHostEventListener, normalizeListenerOptions } from "./events.js";
import { SDDocument } from "./node.js";
import { isStyleDeclaration, supportsStyleProperty } from "./style.js";

const MEMBERS = Object.freeze({
  document: {
    data: new Set([
      "documentElement", "head", "body", "activeElement", "styleSheets",
      "URL", "documentURI", "baseURI", "textContent", "firstChild",
      "lastChild", "childNodes", "children",
    ]),
    writable: new Set(["textContent"]),
    methods: new Set([
      "createElement", "createElementNS", "createTextNode", "createComment",
      "createDocumentFragment", "querySelector", "querySelectorAll",
      "getElementById", "getElementsByTagName", "adoptNode", "importNode",
      "appendChild",
      "removeChild", "insertBefore", "replaceChild", "contains",
    ]),
  },
  element: {
    data: new Set([
      "nodeType", "nodeName", "tagName", "localName", "namespaceURI",
      "ownerDocument", "parentNode", "parentElement", "firstChild",
      "lastChild", "nextSibling", "previousSibling", "childNodes", "children",
      "firstElementChild", "lastElementChild", "nextElementSibling",
      "previousElementSibling", "childElementCount", "textContent", "isConnected",
      "id", "className", "hidden", "autofocus", "innerHTML", "innerText",
      "shadowRoot",
      "assignedSlot", "slot", "style", "classList", "attributes", "role",
      "value", "checked", "disabled", "name", "type", "src", "charset",
      "width", "height",
      "scrollTop", "scrollLeft", "scrollWidth", "scrollHeight", "clientWidth",
      "clientHeight", "offsetWidth", "offsetHeight", "offsetTop", "offsetLeft",
      "onclick", "onload", "onerror",
    ]),
    writable: new Set([
      "textContent", "id", "className", "hidden", "autofocus", "innerHTML",
      "innerText",
      "slot", "role", "value", "checked", "disabled", "name", "type", "src",
      "charset",
      "width", "height", "scrollTop", "scrollLeft", "onclick", "onload",
      "onerror",
    ]),
    methods: new Set([
      "appendChild", "removeChild", "insertBefore", "replaceChild", "cloneNode",
      "contains", "getRootNode", "append", "prepend", "replaceChildren", "remove",
      "querySelector", "querySelectorAll", "getElementsByTagName", "matches",
      "closest", "setAttribute",
      "getAttribute", "hasAttribute", "removeAttribute", "toggleAttribute",
      "setAttributeNS", "getAttributeNS", "hasAttributeNS", "removeAttributeNS",
      "attachShadow", "attachInternals", "focus", "blur", "click",
      "scrollIntoView", "getBoundingClientRect", "getClientRects",
      "assignedNodes", "assignedElements", "addEventListener",
      "removeEventListener", "dispatchEvent",
    ]),
  },
  "text-node": {
    data: new Set([
      "nodeType", "nodeName", "ownerDocument", "parentNode", "parentElement",
      "nextSibling", "previousSibling", "textContent", "data", "length",
      "isConnected",
    ]),
    writable: new Set(["textContent", "data"]),
    methods: new Set([
      "remove", "cloneNode", "contains", "getRootNode", "substringData",
      "appendData", "insertData", "deleteData", "replaceData", "splitText",
    ]),
  },
  "comment-node": {
    data: new Set([
      "nodeType", "nodeName", "ownerDocument", "parentNode", "parentElement",
      "nextSibling", "previousSibling", "textContent", "data", "length",
      "isConnected",
    ]),
    writable: new Set(["textContent", "data"]),
    methods: new Set(["remove", "cloneNode", "contains", "getRootNode"]),
  },
  "document-fragment": {
    data: new Set([
      "nodeType", "nodeName", "ownerDocument", "firstChild", "lastChild",
      "childNodes", "children", "textContent",
    ]),
    writable: new Set(["textContent"]),
    methods: new Set([
      "appendChild", "removeChild", "insertBefore", "replaceChild", "cloneNode",
      "contains", "getRootNode", "append", "prepend", "replaceChildren",
      "querySelector", "querySelectorAll",
    ]),
  },
  "shadow-root": {
    data: new Set([
      "nodeType", "nodeName", "ownerDocument", "firstChild", "lastChild",
      "childNodes", "children", "textContent", "host", "mode",
      "delegatesFocus", "slotAssignment", "adoptedStyleSheets", "activeElement",
    ]),
    writable: new Set(["textContent", "adoptedStyleSheets"]),
    methods: new Set([
      "appendChild", "removeChild", "insertBefore", "replaceChild", "cloneNode",
      "contains", "getRootNode", "append", "prepend", "replaceChildren",
      "querySelector", "querySelectorAll", "getElementById", "addEventListener",
      "removeEventListener", "dispatchEvent",
    ]),
  },
  "style-declaration": {
    data: new Set(["cssText", "length"]),
    writable: new Set(["cssText"]),
    methods: new Set([
      "getPropertyValue", "getPropertyPriority", "setProperty", "removeProperty",
      "item",
    ]),
  },
  "token-list": {
    data: new Set(["length", "value"]),
    writable: new Set(["value"]),
    methods: new Set(["add", "remove", "contains", "toggle", "replace", "item", "supports", "toString"]),
  },
  "element-internals": {
    data: new Set([
      "shadowRoot", "states", "form", "labels", "validity", "validationMessage",
      "willValidate",
    ]),
    writable: new Set(),
    methods: new Set([
      "setFormValue", "setValidity", "checkValidity", "reportValidity",
      "setAriaLabel", "setAriaRole",
    ]),
  },
  "custom-state-set": {
    data: new Set(["size"]),
    writable: new Set(),
    methods: new Set(["add", "delete", "has", "clear", "values", "keys", "entries"]),
  },
  stylesheet: {
    data: new Set(["cssRules", "disabled", "href", "media", "ownerNode", "title"]),
    writable: new Set(["disabled"]),
    methods: new Set(["insertRule", "deleteRule", "replace", "replaceSync"]),
  },
  event: {
    data: new Set([
      "type", "target", "currentTarget", "eventPhase", "bubbles", "cancelable",
      "composed", "defaultPrevented", "timeStamp", "detail", "key", "code",
      "button", "buttons", "clientX", "clientY", "dataTransfer",
    ]),
    writable: new Set(),
    methods: new Set([
      "preventDefault", "stopPropagation", "stopImmediatePropagation", "composedPath",
    ]),
  },
  file: {
    data: new Set(["name", "size", "type", "lastModified"]),
    writable: new Set(),
    methods: new Set(["arrayBuffer", "bytes", "slice", "stream", "text"]),
  },
  "readable-stream": {
    data: new Set(["locked"]),
    writable: new Set(),
    methods: new Set(["cancel", "getReader", "pipeThrough", "pipeTo", "tee"]),
  },
  "readable-stream-reader": {
    data: new Set(["closed"]),
    writable: new Set(),
    methods: new Set(["cancel", "read", "releaseLock"]),
  },
});

function resourceType(resource) {
  const constructorName = resource?.constructor?.name;
  if (resource?.nodeType === 9) return "document";
  if (resource?.nodeType === 3) return "text-node";
  if (isStyleDeclaration(resource)) return "style-declaration";
  if (resource?.nodeType === 11) return resource.host ? "shadow-root" : "document-fragment";
  if (resource?.nodeType === 1) return "element";
  if (constructorName === "DOMTokenList") return "token-list";
  if (constructorName === "ElementInternals") return "element-internals";
  if (constructorName === "CustomStateSet") return "custom-state-set";
  if (constructorName?.includes("StyleSheet")) return "stylesheet";
  if (constructorName?.endsWith("Event")) return "event";
  if (constructorName === "File") return "file";
  if (constructorName === "ReadableStream") return "readable-stream";
  if (constructorName?.includes("ReadableStream") && constructorName.includes("Reader")) {
    return "readable-stream-reader";
  }
  throw new TypeError(`Sandom backend cannot expose ${constructorName ?? typeof resource}`);
}

export function createMothershipBackend({
  reportException,
  document: suppliedDocument = null,
  viewportW = 1280,
  viewportH = 720,
  glyphResourceManager,
} = {}) {
  if (typeof reportException !== "function") {
    throw new TypeError("createMothershipBackend requires reportException");
  }
  const customElements = suppliedDocument?.customElements ??
    new CustomElementRegistry({ reportException });
  const document = suppliedDocument ?? new SDDocument({ customElements });
  if (document.customElements !== customElements) {
    throw new TypeError("The supplied document uses another custom-element registry");
  }
  // Drone-side measurement (clientWidth, getBoundingClientRect, ...)
  // resolves through the document's layout options. Without this, every
  // read answered the 1280x720 default whatever viewport the embedder
  // passed, while the render path laid out against the real viewport
  // (BUG-drone-cannot-measure-its-viewport, resolved; see
  // activity/reports/REPORT-2026-10-09-resolved-bug-records.md). A supplied
  // document keeps the options its own host installed.
  document._layoutOptions ??= { viewportW, viewportH };
  let customElementResolver = null;
  if (!document.documentElement) {
    const documentElement = document.createElement("html");
    const head = document.createElement("head");
    const body = document.createElement("body");
    document.appendChild(documentElement);
    documentElement.append(head, body);
  }
  const listenerWrappers = new WeakMap();

  function encode(value, seen = new Set()) {
    if (
      value === null || value === undefined || typeof value === "boolean" ||
      typeof value === "number" || typeof value === "string" ||
      typeof value === "bigint" || value instanceof Uint8Array
    ) {
      return { kind: "primitive", value };
    }
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`Sandom backend cannot encode ${typeof value}`);
    }
    if (value instanceof Promise) {
      throw new TypeError("Sandom backend must await a promise before encoding it");
    }
    if (Array.isArray(value) || value?.constructor?.name === "NodeList" ||
        value?.constructor?.name === "HTMLCollection") {
      if (seen.has(value)) throw new TypeError("Sandom backend cannot encode a cycle");
      seen.add(value);
      return { kind: "sequence", values: Array.from(value, (entry) => encode(entry, seen)) };
    }
    try {
      const type = resourceType(value);
      const objectHandle = type === "element" ? customElementResolver?.(value) : null;
      return objectHandle
        ? { kind: "vat-object", resource: value, objectHandle }
        : { kind: "resource", resource: value, resourceType: type };
    } catch (resourceError) {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw resourceError;
    }
    if (seen.has(value)) throw new TypeError("Sandom backend cannot encode a cycle");
    seen.add(value);
    const entries = {};
    for (const [name, entry] of Object.entries(value)) entries[name] = encode(entry, seen);
    return { kind: "record", entries };
  }

  function inspectMember(resource, propertyName) {
    if (typeof propertyName !== "string" || propertyName.startsWith("_")) {
      return { kind: "absent" };
    }
    const type = resourceType(resource);
    const catalogue = MEMBERS[type];
    if (type === "style-declaration" && supportsStyleProperty(propertyName)) {
      return { kind: "data", writable: true };
    }
    if (catalogue.data.has(propertyName)) {
      return { kind: "data", writable: catalogue.writable.has(propertyName) };
    }
    if (catalogue.methods.has(propertyName)) return { kind: "method" };
    return { kind: "absent" };
  }

  const runHostOperation = (action, reactionContext = null) =>
    customElements.runHostOperation(action, reactionContext);
  const runHostEventOperation = (action) => {
    const reactionContext = customElements._activeReactionContext();
    return runHostOperation(action, reactionContext);
  };

  // The render entry: one retained surface per viewport environment. The
  // pod cap renders with surface.renderNow() (GPU texture frame) or
  // surface.renderNow({ pixels: true }) (CPU readback) and keeps the
  // surface across mutations; every later frame costs what changed.
  function createRenderSurface(root, options = {}) {
    return createDOMRenderSurface(root, {
      viewportWidth: viewportW,
      viewportHeight: viewportH,
      ...(glyphResourceManager === undefined ? {} : { glyphResourceManager }),
      ...options,
    });
  }

  const backend = {
    // The embedder's exception surface, re-exposed so the DOM
    // capability can carry an UNCAUGHT drone exception here (its
    // onUncaughtException hook). Lifecycle-reaction failures already
    // arrive via the custom-element registry's own use of this hook.
    reportException,
    getDocument() {
      return document;
    },
    getRenderRoot() {
      if (document.documentElement?.ownerDocument !== document) {
        throw new Error("Sandom document has no valid document element");
      }
      return document.documentElement;
    },
    inspectMember,
    constructEvent(type, init = undefined, { custom = false } = {}) {
      const normalizedInit = init === null || init === undefined ? {} : init;
      if (typeof normalizedInit !== "object" || Array.isArray(normalizedInit)) {
        throw new TypeError("Event constructor init must be an object");
      }
      return encode(
        custom
          ? new CustomEvent(String(type), normalizedInit)
          : new Event(String(type), normalizedInit),
      );
    },
    async readMember(resource, propertyName, { reactionContext = null } = {}) {
      const inspection = inspectMember(resource, propertyName);
      if (inspection.kind !== "data") {
        throw new TypeError(`${resourceType(resource)}.${propertyName} is not public data`);
      }
      return await runHostOperation(
        async () => encode(await resource[propertyName]),
        reactionContext,
      );
    },
    async writeMember(resource, propertyName, value, { reactionContext = null } = {}) {
      const inspection = inspectMember(resource, propertyName);
      if (inspection.kind !== "data" || !inspection.writable) {
        throw new TypeError(`${resourceType(resource)}.${propertyName} is not writable`);
      }
      return await runHostOperation(() => {
        resource[propertyName] = value;
        return { kind: "primitive", value };
      }, reactionContext);
    },
    async deleteMember(resource, propertyName, { reactionContext = null } = {}) {
      const inspection = inspectMember(resource, propertyName);
      if (inspection.kind !== "data" || !inspection.writable) return false;
      return await runHostOperation(
        () => delete resource[propertyName],
        reactionContext,
      );
    },
    async callMember(
      resource,
      methodName,
      argumentsList,
      { reactionContext = null } = {},
    ) {
      if (inspectMember(resource, methodName).kind !== "method") {
        throw new TypeError(`${resourceType(resource)}.${methodName} is not a public method`);
      }
      return await runHostOperation(async (context) => {
        if (resource === document && methodName === "createElement") {
          return encode(await customElements.createHostElement(
            document,
            String(argumentsList[0]).toLowerCase(),
            context,
          ));
        }
        const result = await resource[methodName](...argumentsList);
        return encode(result);
      }, reactionContext);
    },
    async addEventListener(
      resource,
      eventName,
      callback,
      options,
      { reactionContext = null, participant } = {},
    ) {
      if (participant === null || participant === undefined) {
        throw new TypeError("Mothership event listeners require a participant");
      }
      const capture = normalizeListenerOptions(options).capture;
      let byResource = listenerWrappers.get(callback);
      if (!byResource) {
        byResource = new WeakMap();
        listenerWrappers.set(callback, byResource);
      }
      let byEventName = byResource.get(resource);
      if (!byEventName) {
        byEventName = new Map();
        byResource.set(resource, byEventName);
      }
      let byCapture = byEventName.get(eventName);
      if (!byCapture) {
        byCapture = new Map();
        byEventName.set(eventName, byCapture);
      }
      if (byCapture.has(capture)) return;
      const wrapped = (event) => {
        const context = customElements._activeReactionContext();
        if (context === null) {
          throw new Error("Host event listener ran outside its reaction transaction");
        }
        return callback({
          event,
          currentTarget: event.currentTarget,
          reactionContext: context,
          participant,
        });
      };
      markHostEventListener(wrapped, {
        participant,
        runHostOperation: runHostEventOperation,
      });
      byCapture.set(capture, wrapped);
      await runHostOperation(
        () => resource.addEventListener(eventName, wrapped, options),
        reactionContext,
      );
    },
    async removeEventListener(
      resource,
      eventName,
      callback,
      options,
      { reactionContext = null } = {},
    ) {
      const capture = normalizeListenerOptions(options).capture;
      const byEventName = listenerWrappers.get(callback)?.get(resource);
      const byCapture = byEventName?.get(eventName);
      const wrapped = byCapture?.get(capture);
      if (!wrapped) return;
      await runHostOperation(
        () => resource.removeEventListener(eventName, wrapped, options),
        reactionContext,
      );
      byCapture.delete(capture);
      if (byCapture.size === 0) byEventName.delete(eventName);
      if (byEventName.size === 0) listenerWrappers.get(callback).delete(resource);
    },
    setCustomElementResolver(resolver) {
      if (customElementResolver !== null) {
        throw new Error("Sandom custom-element resolver is already installed");
      }
      if (typeof resolver !== "function") throw new TypeError("resolver must be a function");
      customElementResolver = resolver;
    },
    async defineCustomElement(definitionInput, { reactionContext = null } = {}) {
      return await customElements.defineHost(definitionInput, reactionContext);
    },
    setCustomElementParticipant(definition, participant) {
      customElements._setHostDefinitionParticipant(definition, participant);
    },
    async beginCustomElementConstruction(definition, { reactionContext = null } = {}) {
      return await customElements.beginHostConstruction(definition, reactionContext);
    },
    claimCustomElementConstruction(
      constructionToken,
      definition,
      { reactionContext } = {},
    ) {
      return customElements.claimHostConstruction(
        constructionToken,
        definition,
        reactionContext,
      );
    },
    async completeCustomElementConstruction(
      constructionToken,
      { reactionContext } = {},
    ) {
      await customElements.completeHostConstruction(constructionToken, reactionContext);
    },
    async abortCustomElementConstruction(
      constructionToken,
      { reactionContext } = {},
    ) {
      await customElements.abortHostConstruction(constructionToken, reactionContext);
    },
    async upgradeCustomElements(root, { reactionContext = null } = {}) {
      return await runHostOperation(
        async (context) => await customElements.upgradeHost(root, context),
        reactionContext,
      );
    },
    inspectCustomElementOperations() {
      return customElements.inspectHostOperations();
    },
    createRenderSurface,
  };
  return backend;
}
