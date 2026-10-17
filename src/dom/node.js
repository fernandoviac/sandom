// Standards-shaped wrappers for the Sandom DOM WebAssembly core. The core owns
// tree, style, and layout state; serialize.js publishes its engine records.

import { createStyle } from "./style.js";
import { createAdditionalElementInterfaces, createElementInterface } from "./element-interfaces.js";
import { createFontRegistry, defaultFontRegistry } from "../font-registry.js";
import { createDocumentResourceLoader } from "./document-resources.js";
import { noResourceHost } from "../host/contract.js";
import {
  DomCoreAttributeMetadataMap,
  domCoreForWrapper,
  sharedDomCore,
} from "../dom-wasm/core.js";
import {
  createEvent,
  dispatchEvent as dispatchNativeEvent,
  registerEventTargetWrapper,
  SDEventTarget,
} from "./events.js";
import { SandomViewport, scrollBindingRuntime } from "./viewport.js";
import { installElementScrollBindings } from "./dom-bindings.generated.js";
import { documentScrollingElement, elementScrollRead, elementScrollSource, scrollRead, scrollStore, scrollRequest, scrollState } from "./scroll-core.js";
import * as layoutGetters from "./layout-getters.js";
import { svgGraphicsRuntime } from "./svg-geometry.js";
import { scheduleMutationObservers } from "./mutation-observer.js";
import {
  parseHTMLDocument,
  parseHTMLFragment,
  serializeNode as serializeHTMLNode,
  serializeNodeContents as serializeHTMLNodeContents,
} from "./html.js";
import {
  documentClose,
  documentScripts,
  documentCurrentScript,
  documentOpen,
  documentReadyState,
  documentWrite,
  markScriptsAlreadyStarted,
  scriptElementAsync,
  setScriptElementAsync,
} from "./scripts.js";
import {
  imageAdopted,
  imageAttributeChanged,
  imageCloned,
  imageComplete,
  imageCurrentSrc,
  imageDecode,
  imageDimension,
  imagesDelayLoadEvent,
  imageNaturalHeight,
  imageNaturalWidth,
  imagesParsed,
  unsignedLongAttributeValue,
} from "./images.js";
import {
  DOCUMENT_EVENT_HANDLER_TYPES,
  GLOBAL_EVENT_HANDLER_TYPES,
  getEventHandler,
  installPrototypeEventHandlers,
  setEventHandler,
} from "./event-handlers.js";
import {
  parseXMLDocument,
  parseXMLFragment,
  serializeXMLNode,
  serializeXMLNodeContents,
} from "./xml.js";
import { createDOMParserClass } from "./dom-parser.generated.js";
import {
  createElementFamily,
  installCharacterDataBindings, installDocumentBindings, installDocumentFragmentBindings,
  installDocumentTypeBindings, installElementBindings, installHTMLElementBindings, installNodeBindings,
  installProcessingInstructionBindings, installShadowRootBindings, installSVGElementBindings, installTemplateBindings, installTreeWalkerBindings,
  installElementAnimationBindings, installElementGeometryBindings, installDocumentGeometryBindings, installCanvasResourceBindings,
  installHTMLElementGeometryBindings, installSVGGraphicsBindings,
  installDocumentAnimationBindings,
  installParentNodeBindings, installChildNodeBindings, installElementSiblingBindings, installSlottableBindings,
  installElementInlineStyleBindings,
  installNamedElementBindings, installHiddenBindings, installInputDefaultCheckedBindings,
  installElementAttributeBindings, installElementCollectionBindings, installStylesheetElementBindings, installDatasetBindings,
  installAutofocusBindings, installOpenElementBindings,
} from "./dom-bindings.generated.js";
import { documentAnimations, elementAnimationHost } from "./animation.js";
import { documentTimeline } from "./document-clock.js";
import {
  createDocumentStyleSystem,
  CSS,
  setAdoptedStyleSheets,
} from "./stylesheet.js";
import {
  adopted as customElementAdopted,
  attributeChanged as customElementAttributeChanged,
  CustomElementRegistry,
  customElementState,
  ElementInternals,
  treeChanged as customElementTreeChanged,
  treeUpgrade as customElementTreeUpgrade,
  withCustomElementReactions,
} from "./custom-elements.js";
import { queueSlotChange } from "./shadow.js";
import { queueDetailsToggle } from "./details.js";
import {
  SandomGPUCanvasContext,
} from "./canvas.js";
import {
  canvasToBlob,
  convertCanvas2DSettings,
  createCanvasRenderingContext2D,
  canvasToDataURL,
} from "./canvas-2d.js";
import { transferControlToOffscreen } from "./offscreen-canvas.js";
import { SDRange, SDSelection } from "./selection.js";
import { blurBeforeRemoval, focusAttributeChanged, requestSubmit, runInputActivation, scheduleFocusFixup, withFocusGeometry } from "./input-activation.js";
import { withLiveGeometry } from "./live-geometry.js";
import { copyControlIdentities, inputControlRuntime } from "./input-controls.js";
import { HTMLCollection, installFormDomBindings, liveCollection, NodeList, reflectUnsigned } from "./form-dom.js";
import {
  installFormSubmissionBindings,
  installFocusBindings,
  installHTMLElementActivationBindings,
  installSelectIndexBindings,
  installControlValueBindings,
  installTextControlDefaultValueBindings,
  installControlDisabledBindings,
  installInputCheckedBindings,
  installOptionSelectedBindings,
  installControlFormBindings,
  installTabIndexBindings,
  installTextControlSelectionBindings,
  installTextControlSelectionStateBindings,
  installInputControlStateBindings,
  installInputTypeBindings,
} from "./dom-bindings.generated.js";
import { installMarkupBindings } from "./element-mutations.js";
import { installShadowBindings } from "./shadow-bindings.js";
import { createTokenList, createClassTokenList, createDataset, createNamedNodeMap, attributeNodeCore } from "./node-collections.js";
export { SDRange, SDSelection };

const callLanguageFunction = Function.prototype.call.bind(Function.prototype.call);
const iteratorResultString = String;
const languageNumber = Number;

function languageIterator(iterable) {
  const iterator = iterable[Symbol.iterator]();
  if (iterator === null ||
    typeof iterator !== "object" && typeof iterator !== "function") {
    throw new TypeError("Result of the Symbol.iterator method is not an object");
  }
  return { iterator, next: iterator.next, value: undefined };
}

function languageIteratorStep(record) {
  const result = callLanguageFunction(record.next, record.iterator);
  if (result === null ||
    typeof result !== "object" && typeof result !== "function") {
    throw new TypeError(`Iterator result ${iteratorResultString(result)} is not an object`);
  }
  if (result.done) return false;
  record.value = result.value;
  return true;
}

function languageIteratorClose(record, throwing) {
  const close = record.iterator.return;
  if (close == null) return;
  const result = callLanguageFunction(close, record.iterator);
  if (!throwing && (result === null ||
    typeof result !== "object" && typeof result !== "function")) {
    throw new TypeError(`Iterator result ${iteratorResultString(result)} is not an object`);
  }
}
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// A live NodeList over `items()`, or an HTMLCollection when it has `named`
// (the DOM Standard's collection types). `count` and `at` answer length and
// index reads without materializing every item when the source can (the
// core's child lists), so `children.length` or `childNodes[0]` on a wide
// parent costs one core call instead of one wrapper per child.
function collection(items, { named = null, count = null, at = null } = {}) {
  const state = { items };
  if (count) state.count = count;
  if (at) state.at = at;
  if (named) state.named = (name) => named(name) ?? null;
  return liveCollection(named ? HTMLCollection.prototype : NodeList.prototype, state);
}

// A static NodeList of `nodes` (querySelectorAll, getElementsByName).
function staticNodeList(nodes) {
  return liveCollection(NodeList.prototype, { items: () => nodes });
}

function collectionNamed(root, tagName, name) {
  const core = root._domCore;
  const tag = tagName === null ? [0, -1] : core.input(tagName);
  const kind = typeof name === "string" ? 0 : name === null ? 1 : 2;
  const requested = kind === 0 ? core.input(name) : [0, 0];
  return core.nodeHandle("node_collection_named", root._coreHandle, ...tag, kind, ...requested);
}

export function processDocumentAutofocus(document) {
  if (!(document instanceof SDDocument)) {
    throw new TypeError("Autofocus processing requires a Sandom Document");
  }
  const element = document._domCore.wrapperFor(document._domCore.handle(
    "input_focus_autofocus",
    document._coreHandle,
  ));
  if (element === null) return null;
  element.focus();
  return element;
}

function elementsByTagName(root, qualifiedName) {
  const name = String(qualifiedName);
  return collection(
    () => root._domCore.elementsByTagName(root._coreHandle, name),
    {
      named: (requested) => collectionNamed(root, name, requested),
    },
  );
}

// The named property of an HTMLCollection over `items()`: the first
// element whose id is the name or, for an HTML element, whose name
// attribute is (DOM, HTMLCollection namedItem).
function namedAmong(items) {
  return (name) => {
    const wanted = String(name);
    if (wanted === "") return null;
    return items().find((element) => element.getAttribute("id") === wanted ||
      element.namespaceURI === HTML_NS && element.getAttribute("name") === wanted) ?? null;
  };
}

// A live HTMLCollection of the elements that `filter` accepts among the
// descendants of `root` in tree order.
function descendantCollection(root, filter) {
  const items = () => root._domCore.elementsByTagName(root._coreHandle, "*").filter(filter);
  return collection(items, { named: namedAmong(items) });
}

function querySelectorAll(root, selector) {
  return staticNodeList(root._domCore.selectorQueryAll(root._coreHandle, selector));
}

// getElementsByTagNameNS (DOM): "*" matches every namespace or local name;
// the empty namespace is no namespace.
function elementsByTagNameNS(root, namespace, localName) {
  const space = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
  const local = String(localName);
  return descendantCollection(root, (element) =>
    (space === "*" || element.namespaceURI === space) && (local === "*" || element.localName === local));
}

// getElementsByClassName (DOM): the elements whose classes include every
// token, ASCII case-insensitively in a quirks-mode document; none for no
// token.
function elementsByClassName(root, classNames) {
  const tokens = String(classNames).split(/[\t\n\f\r ]+/).filter(Boolean);
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  return descendantCollection(root, (element) => {
    if (tokens.length === 0) return false;
    const quirks = document.compatMode === "BackCompat";
    const classes = (element.getAttribute("class") ?? "").split(/[\t\n\f\r ]+/).filter(Boolean)
      .map((name) => quirks ? asciiLowercase(name) : name);
    return tokens.every((token) => classes.includes(quirks ? asciiLowercase(token) : token));
  });
}

function asciiLowercase(value) {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

// getElementsByName (HTML): a live NodeList of the HTML elements of the
// document whose name attribute is the name.
function elementsByName(document, elementName) {
  const name = String(elementName);
  return collection(() => document._domCore.elementsByTagName(document._coreHandle, "*").filter((element) =>
    element.namespaceURI === HTML_NS && element.getAttribute("name") === name));
}

function htmlElement(localName) {
  const names = new Set(localName.split(","));
  return (element) => element.namespaceURI === HTML_NS && names.has(element.localName);
}

// A live HTMLCollection of the HTML children of `parent` named in `names`.
function childCollection(parent, names) {
  const accept = htmlElement(names);
  const items = () => [...parent.children].filter(accept);
  return collection(items, { named: namedAmong(items) });
}

function ensureNode(value) {
  if (!(value instanceof SDNode)) {
    throw new TypeError("The value is not a Sandom Node");
  }
  return value;
}

// A stable order of DOM cores, for comparing nodes that share no tree.
const coreOrders = new WeakMap();
let nextCoreOrder = 0;
function coreOrder(core) {
  let order = coreOrders.get(core);
  if (order === undefined) {
    order = nextCoreOrder++;
    coreOrders.set(core, order);
  }
  return order;
}

function nodeFrom(value, document) {
  return value instanceof SDNode
    ? value
    : document.createTextNode(String(value));
}

function initializeNodeHostState(
  node,
  core,
  handle,
  ownerDocument,
  { register = true } = {},
) {
  node._domCore = core;
  node._coreHandle = handle;
  // The core owns the document relationship; wrappers query it by handle.
  // The wrapper keeps its document wrapper reachable: document wrappers are
  // cached weakly, and a node must never outlive the object its
  // ownerDocument getter resolves to.
  node._documentRetention = ownerDocument ?? null;
  node._childNodesCollection = collection(() => core.childHandles(handle), {
    count: () => core.childCount(handle),
    at: (index) => core.childAt(handle, index),
  });
  node._renderSurface = null;
  if (register) core.registerWrapper(node, handle, true);
}

function initializeElementHostState(element) {
  element._attributes = createNamedNodeMap(element);
  element._attributeMetadata = new DomCoreAttributeMetadataMap(
    element._domCore,
    element._coreHandle,
  );
  element._style = createStyle(element);
  element._classList = createClassTokenList(element, {
    withCustomElementReactions, customElementAttributeChanged,
  });
  element._part = createTokenList(element, "part");
  element._dataset = null;
  element._requestedScrollLeft = 0;
  element._requestedScrollTop = 0;
  element._scrollLeft = 0;
  element._scrollTop = 0;
  element._pointerController = null;
  element._layoutOptions = undefined;
  if (
    element.localName === "canvas" &&
    element.namespaceURI === HTML_NS
  ) {
    element._canvasContextType = null;
    element._canvasContext = new SandomGPUCanvasContext(element);
    element.ownerDocument?._canvasContexts?.add(element._canvasContext);
  }
}


function wrapExistingNode(core, handle, document) {
  const nodeType = core.nodeType(handle);
  let prototype;
  if (nodeType === 1) {
    const localName = core.nodeString("node_local_name", handle);
    const namespaceURI = core.nodeString("node_namespace", handle);
    prototype = elementFamily.prototypeFor(localName, namespaceURI);
    if (prototype === additionalElementInterfaces.HTMLUnknownElement.prototype) {
      const state = core.status("custom_element_state", handle);
      if (state !== 0 && state !== 3) prototype = SDHTMLElement.prototype;
    }
  } else if (nodeType === 2) {
    prototype = Attr.prototype;
  } else if (nodeType === 3) {
    prototype = SDTextNode.prototype;
  } else if (nodeType === 4) {
    prototype = SDCDATASection.prototype;
  } else if (nodeType === 7) {
    prototype = SDProcessingInstruction.prototype;
  } else if (nodeType === 8) {
    prototype = SDComment.prototype;
  } else if (nodeType === 10) {
    prototype = SDDocumentType.prototype;
  } else if (nodeType === 11) {
    const flags = core.status("node_flags", handle);
    prototype = (flags & 0x100) !== 0
      ? SDShadowRoot.prototype
      : SDDocumentFragment.prototype;
  } else {
    throw new Error(`Unsupported DOM core node type ${nodeType}`);
  }
  const node = Object.create(prototype);
  registerEventTargetWrapper(node);
  initializeNodeHostState(node, core, handle, document, { register: false });
  // Named-property access during host-state setup can ask the core for this
  // same wrapper. Publish its identity before those accesses; the caller
  // attaches the one retained-reference finalizer after materialization.
  core.registerWrapper(node, handle, false);
  if (nodeType === 1) {
    initializeElementHostState(node);
  } else if (
    nodeType === 11 && (core.status("node_flags", handle) & 0x100) !== 0
  ) {
    node._adoptedStyleSheets = [];
  }
  return node;
}

function copyClonedHostState(source, clone, deep) {
  if (source.nodeType === 1) {
    copyControlIdentities(source, clone);
    imageCloned(clone);
  }
  if (!deep) return;
  for (let index = 0; index < source.childNodes.length; index += 1) {
    copyClonedHostState(
      source.childNodes[index],
      clone.childNodes[index],
      true,
    );
  }
  if (source._shadowRoot?.clonable && clone._shadowRoot) {
    copyClonedHostState(source._shadowRoot, clone._shadowRoot, true);
  }
}

export class SDNode extends SDEventTarget {
  constructor(_nodeType, _nodeName, ownerDocument, coreState) {
    if (!coreState?.core || typeof coreState.handle !== "bigint") {
      throw new TypeError("A DOM core handle is required");
    }
    super();
    initializeNodeHostState(
      this,
      coreState.core,
      coreState.handle,
      ownerDocument,
    );
  }

  _bindingChildren() {
    if (this._childrenCollection !== undefined) return this._childrenCollection;
    const core = this._domCore;
    const handle = this._coreHandle;
    return this._childrenCollection = collection(() => core.childElementHandles(handle), {
      named: (name) => collectionNamed(this, null, name),
      count: () => core.childElementCount(handle),
      at: (index) => core.childElementAt(handle, index),
    });
  }

  // The Node members of the DOM Standard that read the tree.
  get baseURI() {
    return this.ownerDocument.baseURI;
  }
  get nodeValue() {
    return this._domCore.string("node_value", this._coreHandle);
  }
  set nodeValue(value) { this._transportNodeValue(`${value ?? ""}`); }
  get textContent() { return this._domCore.string("node_value", this._coreHandle); }
  set textContent(value) { this._transportNodeValue(`${value ?? ""}`); }
  _transportNodeValue(value) {
    this._assertMutationAllowed();
    withCustomElementReactions(() => {
      this._domCore.status("node_value_set", this._coreHandle, ...this._domCore.input(value));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  hasChildNodes() {
    return this.firstChild !== null;
  }
  isSameNode(otherNode) {
    return this === otherNode;
  }
  // normalize (DOM) runs in the core (nodes.watpart).
  normalize() {
    this._assertMutationAllowed();
    try {
      this._domCore.status("node_normalize", this._coreHandle);
    } finally {
      this._dispatchCoreTreeRecords();
    }
  }
  // lookupPrefix, lookupNamespaceURI and isDefaultNamespace (DOM) locate
  // in the core (attributes.watpart); the empty string is null.
  lookupPrefix(namespace) {
    const space = namespace === null || namespace === undefined ? "" : String(namespace);
    return this._domCore.string("node_lookup_prefix", this._coreHandle, ...this._domCore.input(space));
  }
  lookupNamespaceURI(prefix) {
    const name = prefix === null || prefix === undefined ? "" : String(prefix);
    return this._domCore.string("node_lookup_namespace", this._coreHandle, ...this._domCore.input(name));
  }
  isDefaultNamespace(namespace) {
    const space = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
    return this._domCore.string("node_lookup_namespace", this._coreHandle, ...this._domCore.input("")) === space;
  }

  get _focusedElement() {
    return this._domCore.wrapperFor(this._domCore.handle("input_focus_get", this._coreHandle, 1));
  }
  set _focusedElement(value) {
    this._domCore.status("input_focus_set", this._coreHandle, 1, value?._coreHandle ?? 0n);
  }
  get _activeElement() {
    return this._domCore.wrapperFor(this._domCore.handle("input_active_element", this._coreHandle));
  }
  set _activeElement(value) {
    this._domCore.status("input_focus_set", this._coreHandle, 2, value?._coreHandle ?? 0n);
  }
  get _focusVisible() {
    return this._domCore.handle("input_focus_get", this._coreHandle, 3) !== 0n;
  }
  set _focusVisible(value) {
    this._domCore.status("input_focus_set", this._coreHandle, 3, value ? 1n : 0n);
  }
  get _focusModality() {
    return ["none", "keyboard", "pointer"][Number(this._domCore.handle("input_focus_get", this._coreHandle, 4))];
  }
  set _focusModality(value) {
    this._domCore.status("input_focus_set", this._coreHandle, 4, value === "keyboard" ? 1n : value === "pointer" ? 2n : 0n);
  }

  get _childNodes() {
    return [...this.childNodes];
  }

  _transportContains(other) {
    if (other === null) return false;
    const candidate = ensureNode(other);
    if (candidate._domCore !== this._domCore) return false;
    return this._domCore.status(
      "node_contains",
      this._coreHandle,
      candidate._coreHandle,
    ) === 1;
  }

  _transportCompareDocumentPosition(other) {
    const candidate = ensureNode(other);
    if (candidate === this) return 0;
    // Nodes of different cores share no tree: DISCONNECTED | IMPLEMENTATION_SPECIFIC,
    // ordered by core so that both directions agree.
    if (candidate._domCore !== this._domCore) {
      return 33 | (coreOrder(candidate._domCore) < coreOrder(this._domCore) ? 2 : 4);
    }
    return this._domCore.status(
      "node_compare_document_position",
      this._coreHandle,
      candidate._coreHandle,
    );
  }

  _transportIsEqualNode(otherNode) {
    if (otherNode === null) return false;
    const other = ensureNode(otherNode);
    if (this === other) return true;
    if (this._domCore !== other._domCore) return false;
    return this._domCore.nodesEqual(this._coreHandle, other._coreHandle);
  }

  _transportCloneNode(deep = false) {
    const nodeType = this.nodeType;
    sharedDomCore.status("node_clone_guard",
      typeof nodeType === "number" ? nodeType : NaN);
    const clone = this._domCore.clone(
      this._coreHandle,
      this.ownerDocument._coreHandle,
      Boolean(deep),
    );
    copyClonedHostState(this, clone, Boolean(deep));
    return clone;
  }

  _assertMutationAllowed() {
    const document = this.nodeType === 9 ? this : this.ownerDocument;
    document?._documentSessionMutationGate?.assert();
  }

  // coreInvalidated: the core has already invalidated the style that a
  // state or property change affects (an input run's state notification).
  _notifyMutation(kind, detail, record = null, coreInvalidated = false) {
    this._assertMutationAllowed();
    if (kind === "style" && !this._parsingStyleAttribute) {
      record = {
        type: "attributes",
        target: this,
        attributeName: "style",
        attributeNamespace: null,
        oldValue: this._style._mutationOldValue ?? null,
      };
    }
    const mutationDocument = this.nodeType === 9 ? this : this.ownerDocument;
    mutationDocument?._documentSessionMutationGate?.record(
      kind,
      this,
      detail,
      record,
    );
    this._renderSurface?._broadcastMutation(kind, this, detail);
    // The core records its own invalidation for inline style, attribute,
    // text and tree mutations (an attribute change reaches the element's
    // subtree and, with sibling selectors, its following siblings; the
    // rest the whole cascade); a host invalidation here would widen the
    // scoped ones to every element. Pseudo-class state and control
    // property changes are the host's to report, scoped to the element.
    const document = this.nodeType === 9 ? this : this.ownerDocument;
    if (kind === "state" || kind === "property") {
      if (!coreInvalidated) this._invalidateState(detail);
    } else if (kind !== "selection" && kind !== "style") document?._styleSystem?.reconcileSoon();
    scheduleMutationObservers(this._domCore);
    // Script elements outside the parser: their insertion, children and
    // src steps (src/dom/scripts.js).
    document?._scriptProcessing?.mutation(this, kind, detail, record);
    // An img whose src changes updates its image data (src/dom/images.js).
    if (kind === "attribute") {
      imageAttributeChanged(this, record?.attributeName ?? detail);
      if ((record?.attributeNamespace ?? null) === null) focusAttributeChanged(this, record?.attributeName ?? detail);
    }
  }

  // detail names the state that changed. "focus-within": an ancestor whose
  // :focus-within changed - its own record, or its subtree and
  // selector-reachable siblings when a selector puts :focus-within left of
  // a combinator. Any other state: its subtree and selector-reachable
  // siblings, or the whole cascade under :has(); for "hover" and "active"
  // only when a :has() selector names a pointer state. A state is no input
  // of the linked sheets and font rules, so it owes no reconcile.
  _invalidateState(detail) {
    this._domCore.stateInvalidate(
      this._coreHandle,
      detail === "focus-within",
      detail === "hover" || detail === "active",
    );
  }

  _adoptSubtree(document) {
    if (document._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    if (this.parentNode) blurBeforeRemoval(this);
    this._domCore.adopt(document._coreHandle, this._coreHandle);
    this._dispatchCoreTreeRecords();
  }

  _validateInsertion(node, referenceNode = null) {
    const candidate = ensureNode(node);
    if (candidate._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    this._domCore.validateInsertion(
      this._coreHandle,
      candidate._coreHandle,
      referenceNode?._coreHandle ?? 0n,
    );
  }

  // Delivers the core's tree records: adoption and structure. A structure
  // change is a [CEReactions] operation: the lifecycle callbacks it enqueues
  // run when delivery returns.
  _dispatchCoreTreeRecords() {
    withCustomElementReactions(() => this._deliverCoreTreeRecords(), this._domCore);
  }

  _deliverCoreTreeRecords() {
    const records = this._domCore.callbackRecords();
    for (const record of records) {
      if (record.kind === 4) {
        const adoptedNode = this._domCore.wrapperFor(record.target);
        const oldDocument = this._domCore.wrapperFor(record.relatedA);
        const newDocument = this._domCore.wrapperFor(record.relatedB);
        adoptedNode._documentRetention = newDocument;
        if (adoptedNode instanceof SDHTMLCanvasElement) {
          oldDocument?._canvasContexts?.delete(adoptedNode._canvasContext);
          newDocument?._canvasContexts?.add(adoptedNode._canvasContext);
        }
        if (adoptedNode.nodeType === 1) {
          customElementAdopted(adoptedNode, oldDocument, newDocument);
          imageAdopted(adoptedNode, newDocument);
        }
        continue;
      }
      if (record.kind === 2) {
        const target = this._domCore.wrapperFor(record.target);
        const attribute = this._domCore.wrapperFor(record.relatedA);
        if (attribute) {
          customElementAttributeChanged(target, attribute.localName, record.oldValue,
            target.getAttributeNS(attribute.namespaceURI, attribute.localName));
        }
        target._notifyMutation("attribute", record.name, {
          type: "attributes",
          target,
          attributeName: record.name,
          attributeNamespace: attribute?.namespaceURI ?? null,
          oldValue: record.oldValue,
        });
        continue;
      }
      if (record.kind === 3) {
        const target = this._domCore.wrapperFor(record.target);
        target._notifyMutation("text", undefined, {
          type: "characterData",
          target,
          oldValue: record.oldValue,
          observers: record.observers ?? [],
        });
        continue;
      }
      // A clone a Range operation made in the core: its host state.
      if (record.kind === 21) {
        copyClonedHostState(
          this._domCore.wrapperFor(record.relatedA),
          this._domCore.wrapperFor(record.target),
          record.previous === 1n,
        );
        continue;
      }
      if (record.kind !== 1) continue;
      const target = this._domCore.wrapperFor(record.target);
      const addedNode = this._domCore.wrapperFor(record.relatedA);
      const removedNode = this._domCore.wrapperFor(record.relatedB);
      const previousSibling = this._domCore.wrapperFor(record.previous);
      const nextSibling = this._domCore.wrapperFor(record.next);
      // A moved node stays connected to the same surface with its state;
      // the core queued its connectedMoveCallback reactions.
      if (removedNode) {
        if (!record.moved) target._renderSurface?._broadcastDisconnectSubtree(removedNode);
        const document = target.nodeType === 9 ? target : target.ownerDocument;
        document?.getSelection()?._takeRemoval();
      }
      if (addedNode && !record.moved) {
        customElementTreeUpgrade(addedNode);
        target._renderSurface?._connectSubtree(addedNode);
      }
      target._notifyMutation("structure", undefined, {
        type: "childList",
        target,
        addedNodes: addedNode ? [addedNode] : [],
        removedNodes: removedNode ? [removedNode] : [],
        previousSibling,
        nextSibling,
      });
      if (!record.moved) customElementTreeChanged(target, addedNode, removedNode);
    }
  }


  _transportInsertBefore(node, referenceNode) {
    this._assertMutationAllowed();
    const candidate = ensureNode(node);
    this._validateInsertion(candidate, referenceNode);
    if (referenceNode !== null) ensureNode(referenceNode);
    if (candidate.parentNode) blurBeforeRemoval(candidate);
    this._domCore.insertBefore(
      this._coreHandle,
      candidate._coreHandle,
      referenceNode?._coreHandle ?? 0n,
    );
    this._dispatchCoreTreeRecords();
    return candidate;
  }

  // moveBefore (ParentNode): the core validates and moves; the move keeps
  // focus, so no blur runs. Reactions enqueued during the move run in the
  // same scope as the delivered records.
  _transportMoveBefore(node, child) {
    this._assertMutationAllowed();
    const candidate = ensureNode(node);
    if (child !== null) ensureNode(child);
    if (candidate._domCore !== this._domCore) {
      throw new DOMException("move crosses shadow-including roots", "HierarchyRequestError");
    }
    withCustomElementReactions(() => {
      this._domCore.moveBefore(this._coreHandle, candidate._coreHandle, child?._coreHandle ?? 0n);
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }

  _transportRemoveChild(node) {
    this._assertMutationAllowed();
    const candidate = ensureNode(node);
    if (candidate.parentNode === this) blurBeforeRemoval(candidate);
    this._domCore.removeChild(this._coreHandle, candidate._coreHandle);
    this._dispatchCoreTreeRecords();
    return candidate;
  }

  _transportReplaceChild(newChild, oldChild) {
    this._assertMutationAllowed();
    const replacement = ensureNode(newChild);
    const replaced = ensureNode(oldChild);
    if (replacement._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    if (replaced.parentNode === this) blurBeforeRemoval(replaced);
    if (replacement.parentNode) blurBeforeRemoval(replacement);
    this._domCore.replaceChild(
      this._coreHandle,
      replacement._coreHandle,
      replaced._coreHandle,
    );
    this._dispatchCoreTreeRecords();
    return replaced;
  }

  _bindingNodeSequence(mode, values) {
    let parent;
    let reference;
    let present = true;
    let document;
    let removeMethod;
    if (mode >= 2 && mode <= 4) {
      present = !!this.parentNode;
      if (present && mode === 3) reference = this.nextSibling;
      if (present && mode === 4) parent = this.parentNode;
    } else if (mode === 6) {
      parent = this.parentNode;
      present = parent !== null && parent !== undefined;
      if (present) removeMethod = parent.removeChild;
    } else if (mode === 5) {
      this._assertMutationAllowed();
      document = this.ownerDocument ?? this;
      values = values.map((value) => nodeFrom(value, document));
    }
    const core = domCoreForWrapper(this) ?? sharedDomCore;
    const invocation = core.handle("node_sequence_begin", 0n,
      mode, mode === 6 ? 0 : -1, present ? 1 : 0);
    let input;
    let inputOpen = false;
    let failed = false;
    let receiver;
    let method;
    let candidate;
    let insertionReference;
    let replacement = null;
    try {
      for (;;) {
        const token = core.handle("node_sequence_next", invocation);
        if (token === 0n) return;
        const action = core.status("node_sequence_action", invocation);
        if (action === 1) {
          inputOpen = false;
          if (!input) {
            input = languageIterator(mode === 1 ? [...values].reverse() : values);
          }
          if (!languageIteratorStep(input)) {
            input = null;
            core.status("node_sequence_ack", invocation, token, 0n, 1);
            continue;
          }
          inputOpen = true;
          if (mode === 5) {
            candidate = input.value;
          } else {
            receiver = mode < 2 ? this : mode === 4 ? parent : this.parentNode;
            method = mode === 0 ? receiver.appendChild : receiver.insertBefore;
            const owner = mode < 2 ? this.ownerDocument ?? this : this.ownerDocument;
            candidate = nodeFrom(input.value, owner);
            insertionReference = mode === 1 ? this.firstChild :
              mode === 3 ? reference : this;
          }
        } else if (action === 2) {
          if (mode === 0) callLanguageFunction(method, receiver, candidate);
          else callLanguageFunction(method, receiver, candidate, insertionReference);
        } else if (action === 3) {
          this._domCore.validateInsertion(this._coreHandle, candidate._coreHandle, 0n);
        } else if (action === 4) {
          replacement = document.createDocumentFragment();
        } else if (action === 5) {
          inputOpen = false;
          if (!input) input = languageIterator(values);
          if (!languageIteratorStep(input)) {
            input = null;
            core.status("node_sequence_ack", invocation, token, 0n, 1);
            continue;
          }
          inputOpen = true;
          replacement.appendChild(input.value);
        } else if (action === 6) {
          this._transportReplaceChildren(replacement);
        } else if (action === 7) {
          if (mode === 6) callLanguageFunction(removeMethod, parent, this);
          else parent.removeChild(this);
        } else if (action === 9) {
          replacement = values[0] ?? null;
          // Number preserves the relational threshold for every primitive,
          // including BigInt, while the native phase owns length > 1.
          const length = languageNumber(values.length);
          core.status("node_sequence_shape", invocation, token, 0n, length);
          continue;
        }
        // This ownerless language invocation holds actual values in its
        // frame. Do not validate/retain native node handles before the actual
        // captured public mutation callee, including authored callees.
        core.status("node_sequence_ack", invocation, token, 0n, 0);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (inputOpen && failed) {
          try {
            languageIteratorClose(input, true);
          } catch {
            // IteratorClose preserves the original abrupt completion.
          }
        } else if (inputOpen) {
          languageIteratorClose(input, false);
        }
      } finally {
        core.status("node_sequence_release", invocation);
      }
    }
  }

  _transportReplaceChildren(replacement) {
    if (replacement && replacement._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    if (replacement?.parentNode) blurBeforeRemoval(replacement);
    blurBeforeRemoval(this, true);
    this._domCore.replaceChildren(this._coreHandle, replacement?._coreHandle ?? 0n);
    this._dispatchCoreTreeRecords();
  }

}

export const Attr = createElementInterface(class SDAttr extends SDNode {
  get namespaceURI() { return attributeNodeCore(this).nodeString("node_namespace", this._coreHandle) || null; }
  get prefix() { return attributeNodeCore(this).nodeString("node_prefix", this._coreHandle) || null; }
  get localName() { return attributeNodeCore(this).nodeString("node_local_name", this._coreHandle); }
  get name() { return attributeNodeCore(this).nodeString("node_name", this._coreHandle); }
  get value() { return attributeNodeCore(this).string("node_value", this._coreHandle); }
  set value(value) {
    attributeNodeCore(this);
    this._transportNodeValue(`${value}`);
  }
  get ownerElement() { return attributeNodeCore(this).nodeHandle("attribute_node_owner", this._coreHandle); }
  get specified() { attributeNodeCore(this); return true; }
  get [Symbol.toStringTag]() { return "Attr"; }
});

export const SDElement = createElementInterface(class SDElement extends SDNode {
  _transportSetAttributeNode(attribute) {
    this._assertMutationAllowed();
    return withCustomElementReactions(() => {
      const previous = this._domCore.nodeHandle("attribute_node_attach", this._coreHandle, attribute._coreHandle);
      this._deliverCoreTreeRecords();
      return previous;
    }, this._domCore);
  }
  // The Attr methods of Element go through the element's NamedNodeMap, which
  // owns Attr identity. React releases a singleton (<html>, <head>, <body>)
  // with removeAttributeNode.
  getAttributeNode(qualifiedName) {
    return this.attributes.getNamedItem(qualifiedName);
  }
  getAttributeNodeNS(namespace, localName) {
    return this.attributes.getNamedItemNS(namespace, localName);
  }
  setAttributeNode(attribute) {
    return this.attributes.setNamedItem(attribute);
  }
  setAttributeNodeNS(attribute) {
    return this.attributes.setNamedItemNS(attribute);
  }
  removeAttributeNode(attribute) {
    attributeNodeCore(attribute);
    if (attribute.ownerElement !== this) {
      throw new DOMException(
        "Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.",
        "NotFoundError",
      );
    }
    this.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    return attribute;
  }
  get _shadowRoot() {
    return this._domCore.nodeHandle("node_shadow_root", this._coreHandle);
  }
  get _customElementState() {
    return customElementState(this);
  }

  get _requestedScrollLeft() { return scrollRead(this, 0); }
  set _requestedScrollLeft(value) { scrollStore(this, 0, value); }
  get _requestedScrollTop() { return scrollRead(this, 1); }
  set _requestedScrollTop(value) { scrollStore(this, 1, value); }
  get _scrollLeft() { return scrollRead(this, 2); }
  set _scrollLeft(value) { scrollStore(this, 2, value); }
  get _scrollTop() { return scrollRead(this, 3); }
  set _scrollTop(value) { scrollStore(this, 3, value); }
  // The public scroll bindings read these: the offsets of the scroller the
  // element's scroll position belongs to (elementScrollSource), which is the
  // viewport for the scrolling element. Each public scroll read and write
  // passes through one of them; it updates layout in Chrome, so it runs the
  // focus check (scheduleFocusFixup).
  get _cssomRequestedScrollLeft() { scheduleFocusFixup(this); return elementScrollRead(this, 0); }
  get _cssomRequestedScrollTop() { scheduleFocusFixup(this); return elementScrollRead(this, 1); }
  get _cssomScrollLeft() { scheduleFocusFixup(this); return layoutGetters.scrollLeft(this); }
  get _cssomScrollTop() { scheduleFocusFixup(this); return layoutGetters.scrollTop(this); }

  _setParsedAttribute(localName, value, namespaceURI = null, prefix = null) {
    const qualifiedName = prefix ? `${prefix}:${localName}` : String(localName);
    const oldValue = namespaceURI === null
      ? this.getAttribute(qualifiedName)
      : this.getAttributeNS(namespaceURI, localName);
    const normalizedValue = String(value);
    this._domCore.setAttribute(
      this._coreHandle,
      namespaceURI,
      qualifiedName,
      normalizedValue,
    );
    const attributeRecord = this._domCore.callbackRecords().find((record) =>
      record.kind === 2
    );
    const normalizedName = attributeRecord?.name ?? qualifiedName;
    if (normalizedName === "style") this._style._parseAttribute(normalizedValue);
    customElementAttributeChanged(
      this,
      normalizedName,
      oldValue,
      normalizedValue,
    );
    return {
      normalizedName,
      oldValue,
      normalizedValue,
      observers: attributeRecord?.observers ?? [],
    };
  }
  _transportSetAttribute(name, value) {
    this._assertMutationAllowed();
    withCustomElementReactions(() => {
      const result = this._setParsedAttribute(String(name), value);
      this._notifyMutation(
        result.normalizedName === "class" ? "class" : "attribute",
        undefined,
        {
          type: "attributes",
          target: this,
          attributeName: result.normalizedName,
          attributeNamespace: null,
          oldValue: result.oldValue,
          observers: result.observers,
        },
      );
    }, this._domCore);
  }
  _transportRemoveAttribute(name) {
    this._assertMutationAllowed();
    withCustomElementReactions(() => this._removeAttribute(name), this._domCore);
  }
  _removeAttribute(name) {
    const requestedName = String(name);
    const oldValue = this.getAttribute(requestedName);
    const removed = this._domCore.removeAttribute(
      this._coreHandle,
      requestedName,
    );
    const attributeRecord = this._domCore.callbackRecords().find((record) =>
      record.kind === 2
    );
    if (!removed) return;
    const normalizedName = attributeRecord?.name ?? requestedName;
    if (normalizedName === "style") this._style._parseAttribute("");
    this._notifyMutation(
      normalizedName === "class" ? "class" : "attribute",
      undefined,
      {
        type: "attributes",
        target: this,
        attributeName: normalizedName,
        attributeNamespace: null,
        oldValue,
        observers: attributeRecord?.observers ?? [],
      },
    );
    customElementAttributeChanged(this, normalizedName, oldValue, null);
  }
  _transportRemoveAttributeNS(namespaceURI, localName) {
    this._assertMutationAllowed();
    withCustomElementReactions(
      () => this._removeAttributeNS(namespaceURI, localName),
      this._domCore,
    );
  }
  _removeAttributeNS(namespaceURI, localName) {
    const normalizedNamespace = namespaceURI ?? null;
    const normalizedLocalName = String(localName);
    const oldValue = this.getAttributeNS(
      normalizedNamespace,
      normalizedLocalName,
    );
    const removed = this._domCore.removeAttributeNS(
      this._coreHandle,
      normalizedNamespace,
      normalizedLocalName,
    );
    const attributeRecord = this._domCore.callbackRecords().find((record) =>
      record.kind === 2
    );
    if (!removed) return;
    this._notifyMutation(
      normalizedLocalName === "class" ? "class" : "attribute",
      undefined,
      {
        type: "attributes",
        target: this,
        attributeName: normalizedLocalName,
        attributeNamespace: normalizedNamespace,
        oldValue,
        observers: attributeRecord?.observers ?? [],
      },
    );
    customElementAttributeChanged(
      this,
      normalizedLocalName,
      oldValue,
      null,
    );
  }
  _bindingToggleAttribute(name, force) {
    const present = this.hasAttribute(name);
    const action = sharedDomCore.status("attribute_toggle_plan",
      present ? 1 : 0, force === undefined ? -1 : force ? 1 : 0);
    if (action & 2) this.setAttribute(name, "");
    if (action & 4) this.removeAttribute(name);
    return (action & 1) !== 0;
  }
  // An input run toggled this element's boolean attribute in the core (the
  // details disclosure, src/dom-wasm/input-run.watpart): its callback
  // records reach the facade as setAttribute's and removeAttribute's do.
  _deliverToggledAttribute(added) {
    this._assertMutationAllowed();
    withCustomElementReactions(() => {
      const attributeRecord = this._domCore.callbackRecords().find((record) => record.kind === 2);
      const name = attributeRecord.name;
      const oldValue = added ? null : attributeRecord.oldValue;
      if (added) customElementAttributeChanged(this, name, oldValue, "");
      this._notifyMutation("attribute", undefined, {
        type: "attributes",
        target: this,
        attributeName: name,
        attributeNamespace: null,
        oldValue,
        observers: [],
      });
      if (!added) customElementAttributeChanged(this, name, oldValue, null);
    }, this._domCore);
  }

  _bindingSheet() {
    return this.ownerDocument?._styleSystem?.sheetForElement(this) ?? null;
  }


  _setScrollPosition(left, top, source, behavior = "instant") {
    const target = elementScrollSource(this);
    if (target === null) return;
    if (target instanceof SandomViewport) {
      target._surface._requestViewportScroll(left, top, source, behavior);
      return;
    }
    target._setOwnScrollPosition(left, top, source, behavior);
  }

  _setOwnScrollPosition(left, top, source, behavior) {
    if (this._renderSurface) {
      this._renderSurface._requestElementScroll(this, left, top, source, behavior);
      return;
    }
    if (!scrollRequest(this, left, top, behavior, source)) return;
    if (this._domCore.status("scroll_accept", scrollState(this), scrollRead(this, 7), left, top)) {
      dispatchNativeEvent(this, createEvent("scroll"));
      dispatchNativeEvent(this, createEvent("scrollend"));
    }
  }

  _treeRoot() {
    return this.getRootNode();
  }


  setPointerCapture(pointerId) {
    if (!this._pointerController) {
      throw new Error(
        "setPointerCapture: element has no host input controller",
      );
    }
    this._pointerController.capture(this, pointerId);
  }
  releasePointerCapture(pointerId) {
    if (!this._pointerController) {
      throw new Error(
        "releasePointerCapture: element has no host input controller",
      );
    }
    this._pointerController.release(this, pointerId);
  }
  hasPointerCapture(pointerId) {
    return this._pointerController?.has(this, pointerId) ?? false;
  }

  // The layout options a measurement resolves against. An element carries
  // its own options when a host built it through createSandomDOM's
  // factories; every other element falls back to its document's options,
  // so an embedder that sizes the document (mothership-backend's
  // viewportW/viewportH) is answered by drone-side measurement too.
  // Without the fallback every read resolved through the 1280x720
  // default while the render path laid out against the real viewport
  // (BUG-drone-cannot-measure-its-viewport, resolved; see
  // activity/reports/REPORT-2026-10-09-resolved-bug-records.md).
  get _resolvedLayoutOptions() {
    return this._layoutOptions ?? this.ownerDocument?._layoutOptions;
  }
  // scrollIntoView(optional arg): length 0.
  scrollIntoView(options = undefined) {
    if (this._scrollIntoView) this._scrollIntoView(options);
    else {layoutGetters.scrollIntoView(
        this,
        options,
        this._resolvedLayoutOptions,
      );}
  }
  // scrollIntoViewIfNeeded(optional boolean centerIfNeeded = true) (Blink):
  // no scroll when the element is in view; else it is centered, or
  // brought to the nearest edge when centerIfNeeded is false.
  scrollIntoViewIfNeeded(centerIfNeeded = true) {
    if (!centerIfNeeded) {
      this.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const rect = this.getBoundingClientRect();
    const root = this.ownerDocument.documentElement;
    const width = root?.clientWidth ?? 0;
    const height = root?.clientHeight ?? 0;
    if (rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height) return;
    this.scrollIntoView({ block: "center", inline: "center" });
  }
});
installElementScrollBindings(scrollBindingRuntime, SDElement.prototype);
installInputControlStateBindings(inputControlRuntime, SDElement.prototype);
// focus() of an element that no other focusable kind covers updates layout
// in Chrome: its focus check tests for a keyboard-focusable scroll container
// over a synchronous layout (input_focus_scroller_candidate).
function runElementActivation(element, operation) {
  if (operation === 1 && element._domCore.status("input_focus_scroller_candidate", element._coreHandle)) {
    withLiveGeometry(element, undefined, ({ core, handle }) =>
      withFocusGeometry(core, handle, () => runInputActivation(element, operation)));
    return;
  }
  runInputActivation(element, operation);
}

export const SDHTMLElement = createElementInterface(class SDHTMLElement extends SDElement {
  // contentEditable (HTML): the state of the contenteditable attribute.
  get contentEditable() {
    return ["inherit", "true", "false", "plaintext-only"][this._domCore.status("element_content_editable", this._coreHandle)];
  }
  set contentEditable(value) {
    const keyword = String(value).toLowerCase();
    if (keyword === "inherit") this.removeAttribute("contenteditable");
    else if (keyword === "true" || keyword === "false" || keyword === "plaintext-only") this.setAttribute("contenteditable", keyword);
    else throw new DOMException(`The value provided ('${value}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`, "SyntaxError");
  }
  // isContentEditable (HTML), from the core (input-activation.watpart).
  get isContentEditable() {
    return this._domCore.status("element_is_content_editable", this._coreHandle, this.ownerDocument?.designMode === "on" ? 1 : 0) === 1;
  }
}, "autonomous");

export const SDSVGElement = createElementInterface(class SDSVGElement extends SDElement {});

export const SDHTMLTemplateElement = createElementInterface(class SDHTMLTemplateElement extends SDHTMLElement {}, "html");

export class SDCharacterData extends SDNode {
  constructor(nodeType, nodeName, data, ownerDocument) {
    const document = ownerDocument ?? defaultDocument;
    let handle;
    if (nodeType === 3) {
      handle = document._domCore.createText(document._coreHandle, String(data));
    } else if (nodeType === 4) {
      handle = document._domCore.createCdata(
        document._coreHandle,
        String(data),
      );
    } else if (nodeType === 7) {
      handle = document._domCore.createProcessingInstruction(
        document._coreHandle,
        String(nodeName),
        String(data),
      );
    } else if (nodeType === 8) {
      handle = document._domCore.createComment(
        document._coreHandle,
        String(data),
      );
    } else {
      throw new TypeError(`Unsupported character node type ${nodeType}`);
    }
    super(nodeType, nodeName, document, { core: document._domCore, handle });
  }
  _bindingSetData(normalized) {
    if (!this._domCore.status("node_set_data_if_changed", this._coreHandle,
      ...this._domCore.input(normalized))) return;
    const dataRecord = this._domCore.callbackRecords().find((record) => record.kind === 3);
    this._notifyMutation("text", undefined, {
      type: "characterData",
      target: this,
      oldValue: dataRecord.oldValue,
      observers: dataRecord.observers ?? [],
    });
  }
  // substringData, replaceData and its forms, and splitText run in the
  // core (nodes.watpart), with the live range steps.
  _bindingSubstringData(offset, count) {
    return this._domCore.string("node_substring_data", this._coreHandle, offset, count);
  }
  _bindingReplaceDataAtEnd(text) {
    this._replaceData(-1, 0, text);
  }
  _bindingReplaceData(offset, count, text) {
    this._replaceData(offset, count, text);
  }
  _replaceData(offset, count, text) {
    this._assertMutationAllowed();
    try {
      this._domCore.status("node_replace_data", this._coreHandle, offset, count, ...this._domCore.input(text));
    } finally {
      this._dispatchCoreTreeRecords();
    }
  }
}

export class SDTextNode extends SDCharacterData {
  constructor(data = "", ownerDocument = null) {
    super(3, "#text", data, ownerDocument);
  }
  // splitText(unsigned long offset) (DOM, "split a Text node").
  splitText(offset) {
    this._assertMutationAllowed();
    let handle;
    try {
      handle = this._domCore.handle("text_split", this._coreHandle, Number(offset) >>> 0);
    } finally {
      this._dispatchCoreTreeRecords();
    }
    const node = this._domCore.wrapperFor(handle);
    this._domCore.status("node_release", handle);
    return node;
  }
  // wholeText (DOM): the data of the contiguous Text nodes.
  get wholeText() {
    return this._domCore.string("text_whole_text", this._coreHandle);
  }
}

export class SDComment extends SDCharacterData {
  constructor(data, ownerDocument = null) {
    super(8, "#comment", data, ownerDocument);
  }
}

export class SDCDATASection extends SDTextNode {
  constructor(data, ownerDocument = null) {
    return Reflect.construct(SDCharacterData, [4, "#cdata-section", data, ownerDocument], new.target);
  }
}

export class SDProcessingInstruction extends SDCharacterData {
  constructor(target, data, ownerDocument = null) {
    super(7, String(target), data, ownerDocument);
  }
}

export class SDDocumentFragment extends SDNode {
  constructor(ownerDocument = null) {
    const document = ownerDocument ?? defaultDocument;
    const handle = document._domCore.createFragment(document._coreHandle);
    super(11, "#document-fragment", document, {
      core: document._domCore,
      handle,
    });
  }
}
export class SDShadowRoot extends SDDocumentFragment {
  // An illegal constructor (WebIDL): a shadow root is made from the
  // prototype by attachShadow, so no path reaches super().
  // deno-lint-ignore constructor-super
  constructor() {
    throw new TypeError("Illegal constructor");
  }
  get activeElement() {
    return this._activeElement;
  }
  _invalidateStyles() {
    this.ownerDocument?._invalidateStyles();
  }
  _notifyMutation(kind, detail) {
    this._renderSurface?._broadcastMutation(kind, this.host, detail);
    if (kind === "state" || kind === "property") this.host._invalidateState(detail);
    else if (kind !== "selection" && kind !== "style") this.ownerDocument?._styleSystem?.reconcileSoon();
    scheduleMutationObservers(this._domCore);
  }
}
export class SDDocumentType extends SDNode {
  constructor(name, publicId = "", systemId = "", ownerDocument = null) {
    const document = ownerDocument ?? defaultDocument;
    const handle = document._domCore.createDoctype(
      document._coreHandle,
      String(name),
      String(publicId),
      String(systemId),
    );
    super(10, String(name), document, { core: document._domCore, handle });
  }
}
export const SDHTMLInputElement = createElementInterface(class SDHTMLInputElement extends SDHTMLElement {
  get value() {
    return super.value;
  }
  set value(value) {
    super.value = value;
  }
}, "html");
installInputTypeBindings(inputControlRuntime, SDHTMLInputElement.prototype);

export const SDHTMLSelectElement = createElementInterface(class SDHTMLSelectElement extends SDHTMLElement {
  // Own-property accessors, matching SDHTMLInputElement: libraries drive
  // controlled native selects through
  // Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set
  // (Radix Select, React's input value tracking), which requires the
  // accessor to live on THIS prototype, not the SDElement base.
  get value() {
    return super.value;
  }
  set value(value) {
    super.value = value;
  }
  get selectedIndex() {
    return super.selectedIndex;
  }
  set selectedIndex(value) {
    super.selectedIndex = value;
  }
}, "html");

export const SDHTMLButtonElement = createElementInterface(class SDHTMLButtonElement extends SDHTMLElement {}, "html");
export const SDHTMLFormElement = createElementInterface(class SDHTMLFormElement extends SDHTMLElement {}, "html");
installFormSubmissionBindings({ requestSubmit, runInputActivation }, SDHTMLFormElement.prototype);
// Form controls whose members src/dom/form-dom.js installs.
export const SDHTMLTextAreaElement = createElementInterface(class SDHTMLTextAreaElement extends SDHTMLElement {}, "html");
export const SDHTMLOptionElement = createElementInterface(class SDHTMLOptionElement extends SDHTMLElement {}, "html");
export const SDHTMLFieldSetElement = createElementInterface(class SDHTMLFieldSetElement extends SDHTMLElement {}, "html");
export const SDHTMLOutputElement = createElementInterface(class SDHTMLOutputElement extends SDHTMLElement {}, "html");
export const SDHTMLLabelElement = createElementInterface(class SDHTMLLabelElement extends SDHTMLElement {}, "html");
// datalist.options (HTML): the option descendants.
export const SDHTMLDataListElement = createElementInterface(class SDHTMLDataListElement extends SDHTMLElement {
  get options() {
    return this._optionsCollection ??= descendantCollection(this, htmlElement("option"));
  }
}, "html");
// table.rows and table.tBodies (HTML): the rows of its thead children
// first, then its own and its tbody children's rows, then its tfoot
// children's rows, each in tree order.
export const SDHTMLTableElement = createElementInterface(class SDHTMLTableElement extends SDHTMLElement {
  get rows() {
    const isRow = htmlElement("tr");
    const rowsOf = (sections) => [...this.children].flatMap((child) =>
      sections.includes(child.localName) && child.namespaceURI === HTML_NS
        ? [...child.children].filter(isRow)
        : []);
    const items = () => {
      const head = rowsOf(["thead"]);
      const body = [...this.children].flatMap((child) =>
        isRow(child) ? [child] : htmlElement("tbody")(child) ? [...child.children].filter(isRow) : []);
      return [...head, ...body, ...rowsOf(["tfoot"])];
    };
    return this._rowsCollection ??= collection(items, { named: namedAmong(items) });
  }
  get tBodies() {
    return this._bodiesCollection ??= childCollection(this, "tbody");
  }
}, "html");
// tr.cells (HTML): its td and th children.
export const SDHTMLTableRowElement = createElementInterface(class SDHTMLTableRowElement extends SDHTMLElement {
  get cells() {
    return this._cellsCollection ??= childCollection(this, "td,th");
  }
}, "html");
// map.areas (HTML): the area descendants.
export const SDHTMLMapElement = createElementInterface(class SDHTMLMapElement extends SDHTMLElement {
  get areas() {
    return this._areasCollection ??= descendantCollection(this, htmlElement("area"));
  }
}, "html");
// The a element (HTML, HTMLAnchorElement).
export const SDHTMLAnchorElement = createElementInterface(class SDHTMLAnchorElement extends SDHTMLElement {}, "html");
export const SDHTMLCanvasElement = createElementInterface(class SDHTMLCanvasElement extends SDHTMLElement {
  _getContextFromString(contextIdentifier, options) {
    if (this._canvasContextType === "placeholder") {
      throw new DOMException(
        "HTMLCanvasElement.getContext: Cannot get context from a canvas that has transferred its control to offscreen.",
        "InvalidStateError",
      );
    }
    if (contextIdentifier === "2d") {
      const settings = convertCanvas2DSettings(options);
      if (this._canvasContextType === "2d") return this._canvasContext;
      if (this._canvasContextType !== null) return null;
      // The 2D context takes over the canvas resource that the element
      // registered, so paint reaches its bitmap through the same source.
      const resourceHandle = this._canvasContext._resourceHandle;
      const context = createCanvasRenderingContext2D(this, settings, resourceHandle);
      this.ownerDocument?._canvasContexts?.delete(this._canvasContext);
      this.ownerDocument?._canvasContexts?.add(context);
      this._canvasContext = context;
      this._canvasContextType = "2d";
      return context;
    }
    const identifier = contextIdentifier.toLowerCase();
    if (identifier !== "webgpu") return null;
    if (
      this._canvasContextType !== null && this._canvasContextType !== identifier
    ) {
      return null;
    }
    const graphicsCapability = this.ownerDocument?._componentEnvironment?.gpu ??
      globalThis.navigator?.gpu;
    if (!graphicsCapability) return null;
    this._canvasContextType = identifier;
    return this._canvasContext;
  }
  toBlob(callback, type = undefined, quality = undefined) {
    canvasToBlob(this, arguments.length, callback, type, quality);
  }
  toDataURL(type = undefined, quality = undefined) {
    return canvasToDataURL(this, type, quality);
  }
  transferControlToOffscreen() {
    return transferControlToOffscreen(this);
  }
  _setParsedAttribute(localName, value, namespaceURI = null, prefix = null) {
    const result = super._setParsedAttribute(
      localName,
      value,
      namespaceURI,
      prefix,
    );
    this._canvasContext?.attributeChanged(localName, namespaceURI, false, true);
    return result;
  }
  removeAttribute(name) {
    const normalizedName = String(name).toLowerCase();
    const wasPresent = this._domCore.canvasBitmapAttributeMatches(normalizedName, null) &&
      this.hasAttribute(normalizedName);
    super.removeAttribute(name);
    if (wasPresent) this._canvasContext.attributeChanged(normalizedName, null, true, true);
  }
  removeAttributeNS(namespaceURI, localName) {
    const wasPresent = this._domCore.canvasBitmapAttributeMatches(localName, namespaceURI) &&
      this.hasAttributeNS(namespaceURI, localName);
    super.removeAttributeNS(namespaceURI, localName);
    if (wasPresent) this._canvasContext.attributeChanged(localName, namespaceURI, true, true);
  }
  _notifyCanvasPaint() {
    this._renderSurface?._broadcastMutation("canvas-paint", this);
  }
  _notifyCanvasSize() {
    this._renderSurface?._broadcastMutation("canvas-size", this);
  }
}, "html");

export const SDHTMLScriptElement = createElementInterface(class SDHTMLScriptElement extends SDHTMLElement {
  get async() {
    return scriptElementAsync(this);
  }
  set async(value) {
    setScriptElementAsync(this, Boolean(value));
  }
  get defer() {
    return this.hasAttribute("defer");
  }
  set defer(value) {
    this.toggleAttribute("defer", Boolean(value));
  }
  get noModule() {
    return this.hasAttribute("nomodule");
  }
  set noModule(value) {
    this.toggleAttribute("nomodule", Boolean(value));
  }
  get type() {
    return this.getAttribute("type") ?? "";
  }
  set type(value) {
    this.setAttribute("type", String(value));
  }
  get text() {
    let text = "";
    for (let child = this.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 3) text += child.data;
    }
    return text;
  }
  set text(value) {
    this.textContent = String(value);
  }
  get crossOrigin() {
    const value = this.getAttribute("crossorigin");
    if (value === null) return null;
    return value.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous";
  }
  set crossOrigin(value) {
    if (value === null) this.removeAttribute("crossorigin");
    else this.setAttribute("crossorigin", String(value));
  }
  get integrity() {
    return this.getAttribute("integrity") ?? "";
  }
  set integrity(value) {
    this.setAttribute("integrity", String(value));
  }
  get event() {
    return this.getAttribute("event") ?? "";
  }
  set event(value) {
    this.setAttribute("event", String(value));
  }
  get htmlFor() {
    return this.getAttribute("for") ?? "";
  }
  set htmlFor(value) {
    this.setAttribute("for", String(value));
  }
}, "html");

// The string reflection of a content attribute.
function reflectString(name) {
  return {
    get() {
      return this.getAttribute(name) ?? "";
    },
    set(value) {
      this.setAttribute(name, String(value));
    },
    enumerable: true,
    configurable: true,
  };
}

function webIDLLong(value) {
  return +value | 0;
}

function webIDLDouble(value) {
  const number = +value;
  if (!Number.isFinite(number)) throw new TypeError(`Expected a finite double; received ${number}`);
  return number;
}

function reflectNumericValue(kind, convert) {
  return {
    get() {
      return this._domCore.status("element_numeric_value", this._coreHandle, kind, 0, 0);
    },
    set(value) {
      const number = convert(value);
      const normalized = this._domCore.status("element_numeric_value", this._coreHandle, kind, 1, number);
      this.setAttribute("value", String(normalized));
    },
    enumerable: true,
    configurable: true,
  };
}

// An enumerated reflection limited to known values: the keyword in lower
// case, else the invalid-value default, else (no attribute) the
// missing-value default.
function reflectEnumerated(name, keywords, missing, invalid = missing) {
  return {
    get() {
      const value = this.getAttribute(name);
      if (value === null) return missing;
      const keyword = value.toLowerCase();
      return keywords.includes(keyword) ? keyword : invalid;
    },
    set(value) {
      this.setAttribute(name, String(value));
    },
    enumerable: true,
    configurable: true,
  };
}

export const SDHTMLImageElement = createElementInterface(class SDHTMLImageElement extends SDHTMLElement {
  // x and y (CSSOM View, HTMLImageElement): the box's position in the
  // document, truncated; 0 without a box.
  get x() {
    const scroller = this.ownerDocument.scrollingElement;
    return Math.trunc(this.getBoundingClientRect().left + (scroller?.scrollLeft ?? 0));
  }
  get y() {
    const scroller = this.ownerDocument.scrollingElement;
    return Math.trunc(this.getBoundingClientRect().top + (scroller?.scrollTop ?? 0));
  }
  get src() {
    const value = this.getAttribute("src");
    if (value === null) return "";
    return URL.parse(value, this.ownerDocument.baseURI)?.href ?? value;
  }
  set src(value) {
    this.setAttribute("src", String(value));
  }
  get crossOrigin() {
    const value = this.getAttribute("crossorigin");
    if (value === null) return null;
    return value.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous";
  }
  set crossOrigin(value) {
    if (value === null) this.removeAttribute("crossorigin");
    else this.setAttribute("crossorigin", String(value));
  }
  get isMap() {
    return this.hasAttribute("ismap");
  }
  set isMap(value) {
    this.toggleAttribute("ismap", Boolean(value));
  }
  get width() {
    return imageDimension(this, 0);
  }
  set width(value) {
    this.setAttribute("width", unsignedLongAttributeValue(value));
  }
  get height() {
    return imageDimension(this, 1);
  }
  set height(value) {
    this.setAttribute("height", unsignedLongAttributeValue(value));
  }
  get naturalWidth() {
    return imageNaturalWidth(this);
  }
  get naturalHeight() {
    return imageNaturalHeight(this);
  }
  get complete() {
    return imageComplete(this);
  }
  get currentSrc() {
    return imageCurrentSrc(this);
  }
  decode() {
    return imageDecode(this);
  }
}, "html");
Object.defineProperties(SDHTMLImageElement.prototype, {
  alt: reflectString("alt"),
  srcset: reflectString("srcset"),
  sizes: reflectString("sizes"),
  useMap: reflectString("usemap"),
  name: reflectString("name"),
  align: reflectString("align"),
  border: reflectString("border"),
  referrerPolicy: reflectEnumerated("referrerpolicy", [
    "no-referrer", "no-referrer-when-downgrade", "same-origin", "origin",
    "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url",
  ], "", ""),
  decoding: reflectEnumerated("decoding", ["sync", "async", "auto"], "auto"),
  loading: reflectEnumerated("loading", ["lazy", "eager", "auto"], "auto"),
  fetchPriority: reflectEnumerated("fetchpriority", ["high", "low", "auto"], "auto"),
});

export const SDHTMLSourceElement = createElementInterface(class SDHTMLSourceElement extends SDHTMLElement {
  get src() {
    const value = this.getAttribute("src");
    if (value === null) return "";
    return URL.parse(value, this.ownerDocument.baseURI)?.href ?? value;
  }
  set src(value) {
    this.setAttribute("src", String(value));
  }
}, "html");
Object.defineProperties(SDHTMLSourceElement.prototype, {
  type: reflectString("type"),
  srcset: reflectString("srcset"),
  sizes: reflectString("sizes"),
  media: reflectString("media"),
  width: { ...reflectUnsigned("width", 0), enumerable: true },
  height: { ...reflectUnsigned("height", 0), enumerable: true },
});

export const SDHTMLIFrameElement = createElementInterface(class SDHTMLIFrameElement extends SDHTMLElement {}, "html");

class SDTreeWalker {
  constructor(root, whatToShow = 0xFFFFFFFF, filter = null) {
    this.root = root;
    this.whatToShow = Number(whatToShow);
    this.filter = filter;
    this.currentNode = root;
  }
  _bindingTraverse(backwards) {
    const root = this.root;
    const core = domCoreForWrapper(root) ?? sharedDomCore;
    const identities = new Map();
    const values = new Map();
    const iterators = new Map();
    let nextIdentity = 0n;
    const identity = (value) => {
      let result = identities.get(value);
      if (result === undefined) {
        result = ++nextIdentity;
        identities.set(value, result);
        values.set(result, value);
      }
      return result;
    };
    const invocation = core.handle("tree_walk_begin", identity(root));
    let failed = false;
    let failure;
    try {
      for (;;) {
        const token = core.handle("tree_walk_next", invocation);
        if (token === 0n) break;
        const action = core.status("tree_walk_action", invocation, token);
        const target = core.handle("tree_walk_target", invocation, token);
        if (action === 4) {
          // IteratorClose preserves the original abrupt completion, including
          // when the return getter/call itself throws or returns a primitive.
          try {
            languageIteratorClose(iterators.get(target), true);
          } catch {
            // Native retains the original unwinding order and completion.
          }
          core.status("tree_walk_close", invocation, token);
          iterators.delete(target);
          continue;
        }
        let iteratorIdentity = 0n;
        let nodeIdentity = 0n;
        let done = false;
        let decision = 3;
        let thrown = false;
        try {
          if (action === 1) {
            const record = languageIterator(values.get(target).childNodes ?? []);
            iteratorIdentity = ++nextIdentity;
            iterators.set(iteratorIdentity, record);
          } else if (action === 2) {
            const record = iterators.get(target);
            done = !languageIteratorStep(record);
            if (!done) nodeIdentity = identity(record.value);
          } else {
            const node = values.get(target);
            const typeShift = (node.nodeType - 1) | 0;
            if (core.status("tree_walk_filter", invocation, token, this.whatToShow | 0, typeShift)) {
              decision = typeof this.filter === "function"
                ? this.filter(node)
                : this.filter?.acceptNode?.(node) ?? 1;
            }
          }
        } catch (error) {
          thrown = true;
          failed = true;
          failure = error;
        }
        if (thrown) {
          core.status("tree_walk_throw", invocation, token);
        } else if (action === 1) {
          core.status("tree_walk_iterator", invocation, token, iteratorIdentity);
        } else if (action === 2) {
          core.status("tree_walk_item", invocation, token, done ? 1 : 0, nodeIdentity);
          if (done) iterators.delete(target);
        } else {
          core.status("tree_walk_complete", invocation, token,
            decision === 1 ? 1 : decision === 2 ? 2 : 3);
        }
      }
      if (failed) throw failure;
      core.status("tree_walk_find_begin", invocation,
        this.currentNode === this.root ? 1 : 0);
      for (;;) {
        const token = core.handle("tree_walk_find_next", invocation);
        if (token === 0n) break;
        const node = values.get(core.handle("tree_walk_target", invocation, token));
        core.status("tree_walk_find_complete", invocation, token,
          node === this.currentNode ? 1 : 0);
      }
      const resultHandle = core.handle("tree_walk_result", invocation, backwards ? 1 : 0);
      const result = resultHandle === 0n ? null : values.get(resultHandle);
      if (result !== null) {
        this.currentNode = result;
        return this.currentNode;
      }
      return null;
    } finally {
      core.status("tree_walk_release", invocation);
    }
  }
}

function wrapOwnedNode(core, nodeHandle) {
  const ownerHandle = core.handle("node_owner_document", nodeHandle);
  if (ownerHandle === 0n) {
    throw new Error(`Missing document wrapper for handle ${nodeHandle}`);
  }
  const node = wrapExistingNode(core, nodeHandle, core.wrapperFor(ownerHandle));
  // A render surface connects every node of its subtree, but the link lives
  // on the wrapper. A node without a box (an SVG `<stop>`) has no other
  // holder, so its wrapper can be collected and recreated here. The surface
  // root is retained by its surface, so the nearest parent (or shadow host)
  // carries the surface this node belongs to.
  const parent = node.parentNode ?? (node.nodeType === 11 ? node.host : null);
  node._renderSurface = parent?._renderSurface ?? null;
  return node;
}

export class SDDocument extends SDNode {
  constructor({
    url = "about:blank",
    xmlDocument = false,
    host = noResourceHost,
    environment = {},
    customElements = null,
    reportException = null,
    core = sharedDomCore,
    fontRegistry,
    enterRealm = null,
    clock = null,
  } = {}) {
    const normalizedURL = new URL(url).href;
    if (fontRegistry && fontRegistry.core !== core) {
      throw new TypeError("The font registry belongs to a different renderer core");
    }
    const handle = core.createDocument(normalizedURL, Boolean(xmlDocument));
    super(9, "#document", null, { core, handle });
    core.registerDocumentWrapper(this, handle);
    // A core-owned callback must not capture this constructor's context:
    // its selection callback retains the document in that same context.
    core.wrapperFactory ??= wrapOwnedNode.bind(null, core);
    core.slotChangeHandler ??= queueSlotChange;
    core.detailsToggleHandler ??= queueDetailsToggle;
    this._selection = new SDSelection(this, (changedNode) => {
      changedNode?._notifyMutation("selection");
      dispatchNativeEvent(this, createEvent("selectionchange"));
    });
    this._defaultView = null;
    this.URL = normalizedURL;
    this.documentURI = this.URL;
    // Every resource demand of this document goes to the host resource
    // session; a document without a host refuses its first demand. A demand
    // that names no base resolves against the document base URL at the time
    // of the demand, so a <base> element applies.
    this._resources = createDocumentResourceLoader({ host, documentURL: normalizedURL });
    this._resolveResource = (demand) =>
      this._resources.resolveResource(
        demand.baseURL === undefined ? { ...demand, baseURL: this.baseURI } : demand,
      );
    this._sandomFontRegistry = fontRegistry ?? core.defaultFontRegistry ??
      (core.defaultFontRegistry = core === defaultFontRegistry.core
        ? defaultFontRegistry
        : createFontRegistry({ core }));
    this._styleSystem = createDocumentStyleSystem(this, environment);
    // The viewport that vw, vh, vmin and vmax of this document and its
    // synchronous layout resolve against. Each document has its own, also
    // when documents share a core: a render surface, a layout of the
    // document or its host sets it (_setViewport).
    this._setViewport(this._styleSystem.environment.viewportWidth, this._styleSystem.environment.viewportHeight);
    // Diagnostics of images that failed to load or decode: render surfaces
    // record them, a prepared document gives them to the host.
    this._brokenImageDiagnostics = new Map();
    // Diagnostics of properties a transition or an animation names that the
    // core does not animate, per element (src/dom/style.js).
    this._unanimatedPropertyDiagnostics = new Map();
    // Background exception sink for this document's realm. A component
    // session routes lifecycle, animation-frame, and background render
    // failures here so they fail the session loudly instead of escaping
    // as an unobserved worker error (silence in a browser worker).
    this._reportException = reportException;
    // The entry into the realm of this document's classic scripts
    // (`enterDocumentRealm` in src/dom/document-realm.js), given by the code
    // that makes a document with a window. A document without one, such as
    // one from DOMParser, has scripting disabled, as a document without a
    // browsing context has in a browser.
    this._enterRealm = enterRealm;
    // The document's clock (src/dom/document-clock.js): the clock its host
    // injected, or null until the page begins and fixes one.
    this._clock = clock;
    this.customElements = customElements ?? new CustomElementRegistry({
      core,
      supportedBuiltIns: new Map([["button", SDHTMLButtonElement]]),
      ...(reportException ? { reportException } : {}),
    });
    this._canvasContexts = new Set();
    this.customElements._registerDocument(this);
    this.implementation = createDOMImplementation(this);
    if (new.target === SDDocument) {
      Object.setPrototypeOf(this, xmlDocument ? SDXMLDocument.prototype : SDHTMLDocument.prototype);
    }
  }
  // A new Attr of this document, owned by no element. The core makes Attr
  // nodes only on an element, so a scratch element of this document carries
  // it and lets it go; setAttribute and setAttributeNS check the name as
  // these do.
  createAttribute(localName) {
    let name = String(localName);
    if (!this._xmlDocument) name = name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
    const carrier = this.createElementNS(null, "carrier");
    carrier.setAttribute(name, "");
    return carrier.removeAttributeNode(carrier.getAttributeNode(name));
  }
  createAttributeNS(namespace, qualifiedName) {
    const carrier = this.createElementNS(null, "carrier");
    carrier.setAttributeNS(namespace, qualifiedName, "");
    const attribute = carrier.attributes.item(0);
    return carrier.removeAttributeNode(attribute);
  }
  // DocumentOrShadowRoot activeElement for a document: the retargeted
  // focused element, else the body element, else the document element. A
  // shadow root keeps null when focus is not in its tree.
  get _activeElement() {
    return super._activeElement ?? this.body ?? this.documentElement;
  }
  get _xmlDocument() {
    return this._domCore.isXmlDocument(this._coreHandle);
  }
  set _xmlDocument(value) {
    this._domCore.setXmlDocument(this._coreHandle, Boolean(value));
    const prototype = Object.getPrototypeOf(this);
    if (prototype === SDHTMLDocument.prototype || prototype === SDXMLDocument.prototype) {
      Object.setPrototypeOf(this, this._xmlDocument ? SDXMLDocument.prototype : SDHTMLDocument.prototype);
    }
  }
  _bindingDefaultView(value) {
    this._defaultView = value;
    if (value) {
      value.getComputedStyle = (element, pseudoElement = null) =>
        this.getComputedStyle(element, pseudoElement);
      value.getSelection = () => this.getSelection();
      value.CSS = CSS;
      value.customElements = this.customElements;
    }
  }
  get readyState() {
    return documentReadyState(this);
  }
  // Page visibility (HTML "update the visibility state"): the host that
  // shows the document sets it; a document is visible until then.
  get visibilityState() {
    return this._visibilityState ?? "visible";
  }
  get hidden() {
    return this.visibilityState === "hidden";
  }
  _setVisibilityState(state) {
    if (state !== "visible" && state !== "hidden") {
      throw new TypeError(`Unknown visibility state ${JSON.stringify(state)}; expected "visible" or "hidden"`);
    }
    if (this.visibilityState === state) return;
    this._visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }
  get currentScript() {
    return documentCurrentScript(this);
  }
  get images() {
    this._imageCollection ??= this.getElementsByTagName("img");
    return this._imageCollection;
  }
  // The document collections of HTML: links (a and area with href),
  // anchors (a with name), scripts, embeds and plugins (embed).
  get links() {
    return this._linksCollection ??= descendantCollection(this, (element) =>
      htmlElement("a,area")(element) && element.hasAttribute("href"));
  }
  get anchors() {
    return this._anchorsCollection ??= descendantCollection(this, (element) =>
      htmlElement("a")(element) && element.hasAttribute("name"));
  }
  get scripts() {
    return this._scriptsCollection ??= descendantCollection(this, htmlElement("script"));
  }
  get embeds() {
    return this._embedsCollection ??= descendantCollection(this, htmlElement("embed"));
  }
  get plugins() {
    return this.embeds;
  }
  // The parser made images (src/dom/scripts.js, input-preprocessors.js):
  // they start to load.
  _imagesParsed() {
    imagesParsed(this);
  }
  // Whether an image request delays the window load event.
  get _imagesDelayLoadEvent() {
    return imagesDelayLoadEvent(this);
  }
  // Resolves when no image request delays the load event: the task that
  // fires each image's load or error event has run.
  async _imagesLoaded() {
    if (!this._imagesDelayLoadEvent) return;
    await documentScripts(this).until(() => !this._imagesDelayLoadEvent);
  }
  write(...text) {
    documentWrite(this, text, false);
  }
  writeln(...text) {
    documentWrite(this, text, true);
  }
  open() {
    return documentOpen(this);
  }
  close() {
    documentClose(this);
  }
  _readyForRendering() {
    return this._styleSystem.ready();
  }
  // Every CSSOM mutation of an adopted or owned sheet lands here
  // (replaceSync/replace, insertRule/deleteRule, a live rule's own
  // declarations), as does an adoptedStyleSheets assignment. The cascade
  // changed for the whole document and no node carries the change, so a
  // live render loop has nothing to wake it: report it to every live
  // surface over a tree of this document, attached to it or not
  // (render-surface.js keeps the set), which marks each dirty and schedules
  // a frame. No node enters the mutated set - the core's own style
  // invalidation above already classifies how wide the damage is, and the
  // frame decides scene reuse from the style generation, so this costs no
  // more than the restyle already does.
  _invalidateStyles() {
    this._styleSystem.invalidate();
    for (const surface of this._liveRenderSurfaces ?? []) {
      surface._recordMutation("stylesheet", null, undefined);
    }
  }
  // Sets the viewport of the document (`_viewport`) in the document and in
  // its core record (document_viewport_set). A change makes every computed
  // record of the document resolve again.
  _setViewport(width, height, deviceScale = this._viewport?.deviceScale ?? globalThis.devicePixelRatio) {
    if (this._viewport?.width === width && this._viewport?.height === height && this._viewport?.deviceScale === deviceScale) return;
    this._viewport = { width, height, deviceScale };
    this._domCore.documentViewport(this._coreHandle, width, height, deviceScale ?? 0);
  }
  _validateInsertion(node, referenceNode = null) {
    super._validateInsertion(node, referenceNode);
    this._domCore.status("document_validate_children", this._coreHandle,
      node._coreHandle, referenceNode?._coreHandle ?? 0n);
  }
  _createUncustomizedElement(tag, namespaceURI = HTML_NS) {
    const core = this._domCore;
    const handle = core.createElement(this._coreHandle, namespaceURI, String(tag));
    const element = wrapExistingNode(core, handle, this);
    core.registerWrapper(element, handle, true);
    return element;
  }
  _createPublicElement(namespaceURI, name, namespaceAware) {
    const core = this._domCore;
    const handle = core.createPublicElement(this._coreHandle, namespaceURI, name,
      this.contentType ?? "", namespaceAware);
    const element = wrapExistingNode(core, handle, this);
    core.registerWrapper(element, handle, true);
    return element;
  }
  async _shutdownCanvasContexts() {
    const contexts = [...this._canvasContexts];
    this._canvasContexts.clear();
    await Promise.all(contexts.map((context) => context.shutdown()));
  }
  _transportImportNode(node, deep = false) {
    const source = ensureNode(node);
    if (source._domCore !== this._domCore) {
      throw new DOMException(
        "The node belongs to a different DOM core instance",
        "WrongDocumentError",
      );
    }
    const clone = this._domCore.clone(
      source._coreHandle,
      this._coreHandle,
      Boolean(deep),
    );
    copyClonedHostState(source, clone, Boolean(deep));
    return clone;
  }
  _transportAdoptNode(node) {
    const adopted = ensureNode(node);
    adopted._adoptSubtree(this);
    return adopted;
  }
}

export class SDHTMLDocument extends SDDocument {}
export class SDXMLDocument extends SDDocument {}

export const DOMParser = createDOMParserClass({
  createDocument: () => new SDDocument(),
  parseHTMLDocument,
  parseXMLDocument,
});

export const additionalElementInterfaces = createAdditionalElementInterfaces(SDElement, SDHTMLElement, SDSVGElement);
installSVGGraphicsBindings(svgGraphicsRuntime, additionalElementInterfaces.SVGGraphicsElement.prototype);
Object.defineProperty(additionalElementInterfaces.HTMLDataElement.prototype, "value", reflectString("value"));
Object.defineProperty(additionalElementInterfaces.HTMLLIElement.prototype, "value", reflectNumericValue(1, webIDLLong));
Object.defineProperty(additionalElementInterfaces.HTMLMeterElement.prototype, "value", reflectNumericValue(2, webIDLDouble));
Object.defineProperty(additionalElementInterfaces.HTMLProgressElement.prototype, "value", reflectNumericValue(3, webIDLDouble));
for (const constructor of [additionalElementInterfaces.HTMLStyleElement, additionalElementInterfaces.SVGStyleElement]) {
  Object.defineProperty(constructor.prototype, "disabled", {
    get() {
      return Boolean(this._domCore.status("scope_style_element_disabled", this._coreHandle, 0, 0));
    },
    set(value) {
      this._domCore.status("scope_style_element_disabled", this._coreHandle, 1, value ? 1 : 0);
    },
    enumerable: true,
    configurable: true,
  });
}
Object.defineProperty(SDHTMLSelectElement.prototype, "remove", {
  value: function remove(index) {
    const hasIndex = arguments.length !== 0;
    const normalized = hasIndex ? webIDLLong(index) : 0;
    const target = this._domCore.nodeHandle("input_select_remove_target", this._coreHandle, hasIndex ? 1 : 0, normalized);
    target?._bindingNodeSequence(6, []);
  },
  enumerable: true,
  configurable: true,
  writable: true,
});
for (const [name, interfaceObject] of Object.entries({
  Node: SDNode, Element: SDElement, HTMLElement: SDHTMLElement, SVGElement: SDSVGElement,
  Document: SDDocument, HTMLDocument: SDHTMLDocument, XMLDocument: SDXMLDocument,
  CharacterData: SDCharacterData, Text: SDTextNode, Comment: SDComment, CDATASection: SDCDATASection,
  ProcessingInstruction: SDProcessingInstruction, DocumentType: SDDocumentType,
  DocumentFragment: SDDocumentFragment, ShadowRoot: SDShadowRoot,
  HTMLTemplateElement: SDHTMLTemplateElement, HTMLButtonElement: SDHTMLButtonElement,
  HTMLCanvasElement: SDHTMLCanvasElement, HTMLFormElement: SDHTMLFormElement,
  HTMLInputElement: SDHTMLInputElement, HTMLSelectElement: SDHTMLSelectElement,
  HTMLScriptElement: SDHTMLScriptElement, HTMLIFrameElement: SDHTMLIFrameElement,
  HTMLImageElement: SDHTMLImageElement, HTMLSourceElement: SDHTMLSourceElement,
  HTMLTextAreaElement: SDHTMLTextAreaElement, HTMLOptionElement: SDHTMLOptionElement,
  HTMLFieldSetElement: SDHTMLFieldSetElement, HTMLOutputElement: SDHTMLOutputElement,
  HTMLLabelElement: SDHTMLLabelElement, HTMLDataListElement: SDHTMLDataListElement,
  HTMLTableElement: SDHTMLTableElement, HTMLTableRowElement: SDHTMLTableRowElement,
  HTMLMapElement: SDHTMLMapElement, HTMLAnchorElement: SDHTMLAnchorElement,
})) {
  Object.defineProperty(interfaceObject.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

const elementFamily = createElementFamily({
  ...additionalElementInterfaces,
  SDElement, SDHTMLElement, SDSVGElement, SDHTMLTemplateElement,
  SDHTMLButtonElement, SDHTMLCanvasElement, SDHTMLFormElement, SDHTMLInputElement,
  SDHTMLSelectElement, SDHTMLScriptElement, SDHTMLIFrameElement, SDHTMLImageElement, SDHTMLSourceElement,
  SDHTMLTextAreaElement, SDHTMLOptionElement, SDHTMLFieldSetElement, SDHTMLOutputElement, SDHTMLLabelElement,
  SDHTMLDataListElement, SDHTMLTableElement, SDHTMLTableRowElement, SDHTMLMapElement, SDHTMLAnchorElement,
});
const textControlRuntime = {
  ...inputControlRuntime,
  select(node) { runInputActivation(node, 6); },
};
for (const constructor of [SDHTMLInputElement, SDHTMLTextAreaElement, SDHTMLSelectElement]) {
  installControlValueBindings(inputControlRuntime, constructor.prototype);
}
for (const constructor of [SDHTMLInputElement, SDHTMLTextAreaElement]) {
  installTextControlDefaultValueBindings(inputControlRuntime, constructor.prototype);
  installTextControlSelectionBindings(textControlRuntime, constructor.prototype);
  installTextControlSelectionStateBindings(inputControlRuntime, constructor.prototype);
}
for (const constructor of [
  SDHTMLButtonElement, SDHTMLInputElement, SDHTMLSelectElement, SDHTMLTextAreaElement, SDHTMLOptionElement,
  additionalElementInterfaces.HTMLOptGroupElement, additionalElementInterfaces.HTMLLinkElement,
]) {
  installControlDisabledBindings(inputControlRuntime, constructor.prototype);
}
for (const constructor of [
  SDHTMLButtonElement, SDHTMLFieldSetElement, SDHTMLInputElement, SDHTMLOptionElement,
  SDHTMLOutputElement, SDHTMLSelectElement, SDHTMLTextAreaElement,
  additionalElementInterfaces.HTMLLegendElement, additionalElementInterfaces.HTMLObjectElement,
]) {
  installControlFormBindings(inputControlRuntime, constructor.prototype);
}
installInputCheckedBindings(inputControlRuntime, SDHTMLInputElement.prototype);
installOptionSelectedBindings(inputControlRuntime, SDHTMLOptionElement.prototype);
installSelectIndexBindings(inputControlRuntime, SDHTMLSelectElement.prototype);
installFormDomBindings({
  SDDocument, SDHTMLFormElement, SDHTMLInputElement, SDHTMLSelectElement, SDHTMLButtonElement,
  SDHTMLTextAreaElement, SDHTMLOptionElement, SDHTMLFieldSetElement, SDHTMLOutputElement, SDHTMLLabelElement,
});

installNodeBindings({}, SDNode.prototype);
for (const constructor of [SDElement, SDDocument, SDDocumentFragment]) {
  installParentNodeBindings({}, constructor.prototype);
}
for (const constructor of [SDElement, SDCharacterData, SDDocumentType]) {
  installChildNodeBindings({}, constructor.prototype);
}
for (const constructor of [SDElement, SDCharacterData]) {
  installElementSiblingBindings({}, constructor.prototype);
}
for (const constructor of [SDElement, SDTextNode]) {
  installSlottableBindings({}, constructor.prototype);
}
installElementAnimationBindings({ animationHost: elementAnimationHost }, SDElement.prototype);
installElementGeometryBindings(layoutGetters, SDElement.prototype);
installHTMLElementGeometryBindings(layoutGetters, SDHTMLElement.prototype);
const elementBindingRuntime = {
  elementsByTagName, elementsByTagNameNS, elementsByClassName, querySelectorAll,
  // getAttributeNames (DOM): the qualified names in order.
  attributeNames(element) {
    const core = element._domCore;
    const count = core.attributeCount(element._coreHandle);
    return Array.from({ length: count }, (_, index) =>
      core.attributeStringAt("attribute_name_at", element._coreHandle, index));
  },
  dataset(instance) {
    if (!instance._dataset) instance._dataset = createDataset(instance);
    return instance._dataset;
  },
  emptyToNull(value) {
    return value || null;
  },
  nonNull(value) {
    return value !== null;
  },
};
installElementBindings(elementBindingRuntime, SDElement.prototype);
installElementAttributeBindings(elementBindingRuntime, SDElement.prototype);
installElementCollectionBindings(elementBindingRuntime, SDElement.prototype);
installHiddenBindings({}, SDHTMLElement.prototype);
installInputDefaultCheckedBindings({}, SDHTMLInputElement.prototype);
for (const constructor of [
  SDHTMLAnchorElement, SDHTMLButtonElement, SDHTMLFieldSetElement, SDHTMLFormElement,
  SDHTMLIFrameElement, SDHTMLImageElement, SDHTMLInputElement, SDHTMLMapElement,
  SDHTMLOutputElement, SDHTMLSelectElement, SDHTMLTextAreaElement,
  additionalElementInterfaces.HTMLDetailsElement, additionalElementInterfaces.HTMLEmbedElement,
  additionalElementInterfaces.HTMLMetaElement, additionalElementInterfaces.HTMLObjectElement,
  additionalElementInterfaces.HTMLSlotElement,
]) {
  installNamedElementBindings({}, constructor.prototype);
}
for (const constructor of [
  additionalElementInterfaces.HTMLLinkElement, additionalElementInterfaces.HTMLStyleElement,
  additionalElementInterfaces.SVGStyleElement,
]) {
  installStylesheetElementBindings({}, constructor.prototype);
}
const activationRuntime = { runInputActivation: runElementActivation };
for (const constructor of [SDHTMLElement, SDSVGElement, additionalElementInterfaces.MathMLElement]) {
  installElementInlineStyleBindings({}, constructor.prototype);
  installDatasetBindings(elementBindingRuntime, constructor.prototype);
  installFocusBindings(activationRuntime, constructor.prototype);
  installTabIndexBindings(inputControlRuntime, constructor.prototype);
  installAutofocusBindings({}, constructor.prototype);
}
for (const constructor of [additionalElementInterfaces.HTMLDetailsElement, additionalElementInterfaces.HTMLDialogElement]) {
  installOpenElementBindings({}, constructor.prototype);
}
installHTMLElementActivationBindings(activationRuntime, SDHTMLElement.prototype);
installTreeWalkerBindings({}, SDTreeWalker.prototype);
installPrototypeEventHandlers(SDHTMLElement.prototype, GLOBAL_EVENT_HANDLER_TYPES);
installPrototypeEventHandlers(SDSVGElement.prototype, GLOBAL_EVENT_HANDLER_TYPES);
installHTMLElementBindings({ getEventHandler, setEventHandler }, SDHTMLElement.prototype);
installSVGElementBindings({ getEventHandler, setEventHandler }, SDSVGElement.prototype);
installCharacterDataBindings({}, SDCharacterData.prototype);
installTemplateBindings({}, SDHTMLTemplateElement.prototype);
installProcessingInstructionBindings({}, SDProcessingInstruction.prototype);
installDocumentFragmentBindings({ querySelectorAll }, SDDocumentFragment.prototype);
installDocumentTypeBindings({}, SDDocumentType.prototype);
installShadowRootBindings({
  setAdoptedStyleSheets,
  shadowFlag(node, mask, enabled, disabled) {
    return (node._domCore.status("node_flags", node._coreHandle) & mask) !== 0
      ? enabled : disabled;
  },
}, SDShadowRoot.prototype);
// HTML `Document.title` (HTML, "The title element of a document"). When the
// document element is an SVG `svg`, the title is its first SVG `title`
// child, created as the first child on assignment. Otherwise it is the first
// HTML `title` element in tree order; assignment creates one in the head,
// and does nothing unless the document element is an HTML element. The
// value is the title's child text content, ASCII whitespace stripped and
// collapsed; a document without a title has the empty title.
const TITLE_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
const TITLE_WHITESPACE_RUNS = /[\t\n\f\r ]+/g;

function isSvgRoot(element) {
  return element !== null && element.namespaceURI === SVG_NS && element.localName === "svg";
}

function documentTitleElement(document) {
  const root = document.documentElement;
  if (isSvgRoot(root)) {
    for (const child of root._childNodes) {
      if (child.nodeType === 1 && child.namespaceURI === SVG_NS && child.localName === "title") return child;
    }
    return null;
  }
  const pending = root === null ? [] : [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.namespaceURI === HTML_NS && node.localName === "title") return node;
    for (let index = node._childNodes.length - 1; index >= 0; index--) {
      if (node._childNodes[index].nodeType === 1) pending.push(node._childNodes[index]);
    }
  }
  return null;
}

function documentTitleText(document) {
  const element = documentTitleElement(document);
  if (element === null) return "";
  let text = "";
  for (const child of element._childNodes) {
    if (child.nodeType === 3) text += child.data;
  }
  return text.replace(TITLE_WHITESPACE_EDGES, "").replace(
    TITLE_WHITESPACE_RUNS,
    " ",
  );
}

// An existing title element keeps its identity and receives the value as its
// only child.
function setDocumentTitleText(document, value) {
  const root = document.documentElement;
  let title = documentTitleElement(document);
  if (title === null) {
    if (isSvgRoot(root)) {
      title = document.createElementNS(SVG_NS, "title");
      root.insertBefore(title, root.firstChild);
    } else {
      if (root === null || root.namespaceURI !== HTML_NS) return;
      const head = document.head;
      if (head === null) return;
      title = document.createElement("title");
      head.appendChild(title);
    }
  } else if (!isSvgRoot(root) && root.namespaceURI !== HTML_NS) {
    return;
  }
  title.replaceChildren(
    ...(value === "" ? [] : [document.createTextNode(value)]),
  );
}

installPrototypeEventHandlers(SDDocument.prototype, DOCUMENT_EVENT_HANDLER_TYPES);
installDocumentBindings({
  SDTextNode, SDComment, SDDocumentFragment, SDCDATASection,
  SDProcessingInstruction, SDDocumentType,
  SDRange, SDTreeWalker, ensureNode, setAdoptedStyleSheets,
  elementsByTagName, elementsByTagNameNS, elementsByClassName, elementsByName, querySelectorAll, sharedDomCore,
  hasHostEnvironment(document) {
    return document._componentEnvironment != null;
  },
  compatibilityMode(mode) {
    return mode === 1 ? "BackCompat" : "CSS1Compat";
  },
  documentTitleText,
  setDocumentTitleText,
  documentScrollingElement,
}, SDDocument.prototype);
installDocumentGeometryBindings(layoutGetters, SDDocument.prototype);
installDocumentAnimationBindings({ documentAnimations, documentTimeline }, SDDocument.prototype);
installCanvasResourceBindings({}, SDHTMLCanvasElement.prototype);
// A placeholder canvas (transferControlToOffscreen()) cannot be resized
// through its width and height attributes, as in Chrome; setAttribute()
// still changes the attribute.
for (const name of ["width", "height"]) {
  const descriptor = Object.getOwnPropertyDescriptor(SDHTMLCanvasElement.prototype, name);
  const set = descriptor.set;
  Object.defineProperty(SDHTMLCanvasElement.prototype, name, {
    ...descriptor,
    set(value) {
      if (this._canvasContextType === "placeholder") {
        throw new DOMException(
          `HTMLCanvasElement.${name}: Cannot resize canvas after call to transferControlToOffscreen().`,
          "InvalidStateError",
        );
      }
      set.call(this, value);
    },
  });
}
const createDOMImplementation = installMarkupBindings({
  element: SDElement.prototype,
  htmlElement: SDHTMLElement.prototype,
  fragment: SDDocumentFragment.prototype,
  shadow: SDShadowRoot.prototype,
  document: SDDocument.prototype,
  script: SDHTMLScriptElement.prototype,
}, {
  // Fragment parsing marks its scripts "already started": inserting the
  // fragment runs none of them. Its content attributes set handlers.
  parseHTMLFragment(context, source) {
    const fragment = parseHTMLFragment(context, source);
    context.ownerDocument?._scriptProcessing?.activateParsedHandlers(fragment);
    imagesParsed(fragment);
    markScriptsAlreadyStarted(fragment);
    return fragment;
  },
  parseXMLFragment,
  serializeXMLNode, serializeXMLNodeContents,
  serializeHTMLNode, serializeHTMLNodeContents,
  SDTextNode, SDElement, SDDocument,
  withCustomElementReactions,
});
installShadowBindings({
  element: SDElement.prototype,
  htmlElement: SDHTMLElement.prototype,
  slot: additionalElementInterfaces.HTMLSlotElement.prototype,
  shadow: SDShadowRoot.prototype,
}, { HTML_NS, SDDocumentFragment, ElementInternals, ensureNode });

const defaultDocument = new SDDocument();

export function createDocument(options = {}) {
  return new SDDocument(options);
}
export function createElement(tag) {
  return defaultDocument.createElement(tag);
}
export function createElementNS(namespaceURI, tag) {
  return defaultDocument.createElementNS(namespaceURI, tag);
}
export function createTextNode(data) {
  return defaultDocument.createTextNode(data);
}
export function createComment(data) {
  return defaultDocument.createComment(data);
}
export function createDocumentFragment() {
  return defaultDocument.createDocumentFragment();
}
export { HTML_NS, SVG_NS };

export function createRoot() {
  const document = new SDDocument();
  const root = document.createElement("root");
  document.appendChild(root);
  return root;
}
