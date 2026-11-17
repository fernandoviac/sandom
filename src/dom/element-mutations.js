import { domCoreForWrapper } from "../dom-wasm/core.js";
import {
  installDOMImplementationBindings,
  installDocumentConstructionBindings,
  installElementMarkupBindings,
  installInnerTextBindings,
  installOuterTextBindings,
  installFragmentMarkupBindings,
  installShadowMarkupBindings,
} from "./dom-bindings.generated.js";


// The DOMImplementation interface object (DOM). It has no constructor: each
// document has one DOMImplementation, from the factory that
// installMarkupBindings returns.
export function DOMImplementation() {
  throw new TypeError("Illegal constructor");
}
Object.defineProperty(DOMImplementation, "prototype", { writable: false });
Object.defineProperty(DOMImplementation.prototype, Symbol.toStringTag, {
  value: "DOMImplementation",
  configurable: true,
});

export function installMarkupBindings(prototypes, runtime) {
  installElementMarkupBindings({}, prototypes.element);
  installInnerTextBindings({}, prototypes.htmlElement);
  installInnerTextBindings({}, prototypes.script);
  installOuterTextBindings({}, prototypes.htmlElement);
  installFragmentMarkupBindings({}, prototypes.fragment);
  installShadowMarkupBindings({}, prototypes.shadow);
  installDocumentConstructionBindings({}, prototypes.document);
  // The document of each DOMImplementation; the operations accept no other
  // receiver.
  const documents = new WeakMap();
  installDOMImplementationBindings({
    implementationDocument(implementation) {
      const document = documents.get(implementation);
      if (document === undefined) throw new TypeError("Illegal invocation");
      return document;
    },
    createDocumentType: (document, name, publicId, systemId) =>
      new runtime.SDDocumentType(name, publicId, systemId, document),
    // WebIDL DocumentType?: undefined and null give null.
    documentType(value) {
      if (value === undefined || value === null) return null;
      if (domCoreForWrapper(value) === undefined || !(value instanceof runtime.SDDocumentType)) {
        throw new TypeError("Failed to execute 'createDocument' on 'DOMImplementation': parameter 3 is not of type 'DocumentType'.");
      }
      return value;
    },
    // createDocument: an XMLDocument with the doctype and the document
    // element of the qualified name. The documents of DOMImplementation
    // have no browsing context.
    createXMLDocument(owner, namespace, name, doctype) {
      const document = new runtime.SDDocument({ core: owner._domCore, xmlDocument: true, browsingContext: false });
      const element = name === "" ? null : document.createElementNS(namespace, name);
      if (doctype !== null) document.append(doctype);
      if (element !== null) document.append(element);
      return document;
    },
    // createHTMLDocument: a doctype, html, head, an optional title and body.
    createHTMLDocument(owner, title) {
      const document = new runtime.SDDocument({ core: owner._domCore, browsingContext: false });
      document.append(new runtime.SDDocumentType("html", "", "", document));
      const html = document.createElement("html");
      document.append(html);
      const head = document.createElement("head");
      html.append(head);
      if (title !== undefined) {
        const titleElement = document.createElement("title");
        titleElement.append(document.createTextNode(title));
        head.append(titleElement);
      }
      html.append(document.createElement("body"));
      return document;
    },
  }, DOMImplementation.prototype);
  return (document) => {
    const implementation = Object.create(DOMImplementation.prototype);
    documents.set(implementation, document);
    return implementation;
  };
}
