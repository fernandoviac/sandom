// Standards-shaped wrappers for the Sandom DOM WebAssembly core. The core owns
// tree, style, and layout state; serialize.js publishes its engine records.

import { layoutConstant } from "../wasm/layout-table.js";
import { createStyle } from "./style.js";
import { createAdditionalElementInterfaces, createElementInterface } from "./element-interfaces.js";
import { createFontRegistry, defaultFontRegistry } from "../font-registry.js";
import { createDocumentResourceLoader } from "./document-resources.js";
import { noResourceHost } from "../host/contract.js";
import {
  domCoreForWrapper,
  sharedDomCore,
} from "../dom-wasm/core.js";
import {
  createEvent,
  dispatchEvent as dispatchNativeEvent,
  moveListenedNode,
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
  installHiddenBindings, installInputDefaultCheckedBindings,
  installElementAttributeBindings, installElementCollectionBindings, installStylesheetElementBindings, installDatasetBindings,
  installAutofocusBindings, installOpenElementBindings, installRelListBindings, installAttributeReflections,
} from "./dom-bindings.generated.js";
import { documentAnimations, elementAnimationHost } from "./animation.js";
import { documentTimeline } from "./document-clock.js";
import {
  adoptedStyleSheets,
  createDocumentStyleSystem,
  setAdoptedStyleSheets,
} from "./stylesheet.js";
import {
  CustomElementRegistry,
  customElementState,
  ElementInternals,
  withCustomElementReactions,
} from "./custom-elements.js";
import { installEditingCommands } from "./editing-commands.js";
import { queueSlotChange } from "./shadow.js";
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
import { cssNamespaceFor } from "./highlights.js";
import { blurBeforeRemoval, focusAttributeChanged, queueTopLayerTask, requestSubmit, runInputActivation, scheduleFocusFixup, withFocusGeometry } from "./input-activation.js";
import { withLiveGeometry } from "./live-geometry.js";
import { copyControlIdentities, inputControlRuntime } from "./input-controls.js";
import { installConstraintValidationBindings, installElementInternalsFormBindings } from "./constraint-validation.js";
import { elementLabels, elementWrapper, HTMLCollection, installFormDomBindings, liveCollection, NodeList } from "./form-dom.js";
import { nodeMember } from "./node-members.js";
import {
  installDialogBindings,
  installPopoverBindings,
  installPopoverTargetBindings,
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
import { popoverAttributeChanged, topLayerBindingRuntime } from "./top-layer.js";
import { installShadowBindings } from "./shadow-bindings.js";
import { createTokenList, createDataset, createNamedNodeMap, attributeNodeCore } from "./node-collections.js";
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
// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const IMAGE_AXIS_WIDTH = layoutConstant("IMAGE_AXIS_WIDTH");
const IMAGE_AXIS_HEIGHT = layoutConstant("IMAGE_AXIS_HEIGHT");
const IMAGE_POSITION_X = layoutConstant("IMAGE_POSITION_X");
const IMAGE_POSITION_Y = layoutConstant("IMAGE_POSITION_Y");
const NODE_FLAG_SHADOW_ROOT = layoutConstant("NODE_FLAG_SHADOW_ROOT");
const NODE_SEQUENCE_APPEND = layoutConstant("NODE_SEQUENCE_APPEND");
const NODE_SEQUENCE_PREPEND = layoutConstant("NODE_SEQUENCE_PREPEND");
const NODE_SEQUENCE_BEFORE = layoutConstant("NODE_SEQUENCE_BEFORE");
const NODE_SEQUENCE_AFTER = layoutConstant("NODE_SEQUENCE_AFTER");
const NODE_SEQUENCE_REPLACE_WITH = layoutConstant("NODE_SEQUENCE_REPLACE_WITH");
const NODE_SEQUENCE_REPLACE_CHILDREN = layoutConstant("NODE_SEQUENCE_REPLACE_CHILDREN");
const NODE_SEQUENCE_REMOVE = layoutConstant("NODE_SEQUENCE_REMOVE");
const INPUT_FOCUS_FOCUSED = layoutConstant("INPUT_FOCUS_FOCUSED");
const ATTRIBUTE_TOGGLE_PRESENT = layoutConstant("ATTRIBUTE_TOGGLE_PRESENT");
const ATTRIBUTE_TOGGLE_SET = layoutConstant("ATTRIBUTE_TOGGLE_SET");
const ATTRIBUTE_TOGGLE_REMOVE = layoutConstant("ATTRIBUTE_TOGGLE_REMOVE");
const ATTRIBUTE_TOGGLE_UNFORCED = layoutConstant("ATTRIBUTE_TOGGLE_UNFORCED");
const CUSTOM_ELEMENT_UNCUSTOMIZED = layoutConstant("CUSTOM_ELEMENT_UNCUSTOMIZED");
const CUSTOM_ELEMENT_FAILED = layoutConstant("CUSTOM_ELEMENT_FAILED");
const CALLBACK_EFFECT_RETAIN = layoutConstant("CALLBACK_EFFECT_RETAIN");
const CALLBACK_EFFECT_CANVAS_ADOPT = layoutConstant("CALLBACK_EFFECT_CANVAS_ADOPT");
const CALLBACK_EFFECT_IMAGE_ADOPT = layoutConstant("CALLBACK_EFFECT_IMAGE_ADOPT");
const CALLBACK_EFFECT_STYLE_ATTRIBUTE = layoutConstant("CALLBACK_EFFECT_STYLE_ATTRIBUTE");
const CALLBACK_EFFECT_CANVAS_BITMAP = layoutConstant("CALLBACK_EFFECT_CANVAS_BITMAP");
const CALLBACK_EFFECT_CLONE = layoutConstant("CALLBACK_EFFECT_CLONE");
const CALLBACK_EFFECT_SURFACE_DISCONNECT = layoutConstant("CALLBACK_EFFECT_SURFACE_DISCONNECT");
const CALLBACK_EFFECT_SURFACE_CONNECT = layoutConstant("CALLBACK_EFFECT_SURFACE_CONNECT");
const CALLBACK_EFFECT_SELECTION = layoutConstant("CALLBACK_EFFECT_SELECTION");
const CALLBACK_EFFECT_RESTYLE = layoutConstant("CALLBACK_EFFECT_RESTYLE");
const CALLBACK_EFFECT_SCRIPT_STEPS = layoutConstant("CALLBACK_EFFECT_SCRIPT_CHILDREN") |
  layoutConstant("CALLBACK_EFFECT_SCRIPT_INSERTED") | layoutConstant("CALLBACK_EFFECT_SCRIPT_SRC") |
  layoutConstant("CALLBACK_EFFECT_EVENT_HANDLER");
const CALLBACK_EFFECT_IMAGE_ATTRIBUTE = layoutConstant("CALLBACK_EFFECT_IMAGE_ATTRIBUTE");
const CALLBACK_EFFECT_FOCUS_ATTRIBUTE = layoutConstant("CALLBACK_EFFECT_FOCUS_ATTRIBUTE");
const CALLBACK_EFFECT_POPOVER_ATTRIBUTE = layoutConstant("CALLBACK_EFFECT_POPOVER_ATTRIBUTE");
const CALLBACK_NOTIFY_NONE = layoutConstant("CALLBACK_NOTIFY_NONE");
const CALLBACK_NOTIFY_STRUCTURE = layoutConstant("CALLBACK_NOTIFY_STRUCTURE");
const CALLBACK_NOTIFY_TEXT = layoutConstant("CALLBACK_NOTIFY_TEXT");
// The mutation kinds of the render surface and the document session gate.
const CALLBACK_NOTIFY_KINDS = new Map([
  [CALLBACK_NOTIFY_STRUCTURE, "structure"],
  [layoutConstant("CALLBACK_NOTIFY_ATTRIBUTE"), "attribute"],
  [layoutConstant("CALLBACK_NOTIFY_CLASS"), "class"],
  [CALLBACK_NOTIFY_TEXT, "text"],
]);
const NODE_SEQUENCE_ACTION_INPUT = layoutConstant("NODE_SEQUENCE_ACTION_INPUT");
const NODE_SEQUENCE_ACTION_INSERT = layoutConstant("NODE_SEQUENCE_ACTION_INSERT");
const NODE_SEQUENCE_ACTION_VALIDATE = layoutConstant("NODE_SEQUENCE_ACTION_VALIDATE");
const NODE_SEQUENCE_ACTION_FRAGMENT = layoutConstant("NODE_SEQUENCE_ACTION_FRAGMENT");
const NODE_SEQUENCE_ACTION_ASSEMBLE = layoutConstant("NODE_SEQUENCE_ACTION_ASSEMBLE");
const NODE_SEQUENCE_ACTION_REPLACE = layoutConstant("NODE_SEQUENCE_ACTION_REPLACE");
const NODE_SEQUENCE_ACTION_REMOVE = layoutConstant("NODE_SEQUENCE_ACTION_REMOVE");
const NODE_SEQUENCE_ACTION_SHAPE = layoutConstant("NODE_SEQUENCE_ACTION_SHAPE");
const TREE_WALK_ACTION_CHILDREN = layoutConstant("TREE_WALK_ACTION_CHILDREN");
const TREE_WALK_ACTION_STEP = layoutConstant("TREE_WALK_ACTION_STEP");
const TREE_WALK_ACTION_CLOSE = layoutConstant("TREE_WALK_ACTION_CLOSE");
const SCROLL_REQUESTED_LEFT = layoutConstant("SCROLL_REQUESTED_LEFT");
const SCROLL_REQUESTED_TOP = layoutConstant("SCROLL_REQUESTED_TOP");
const SCROLL_ACCEPTED_LEFT = layoutConstant("SCROLL_ACCEPTED_LEFT");
const SCROLL_ACCEPTED_TOP = layoutConstant("SCROLL_ACCEPTED_TOP");
const SCROLL_REQUEST_GENERATION = layoutConstant("SCROLL_REQUEST_GENERATION");
const CHARACTER_DATA_END = layoutConstant("CHARACTER_DATA_END");
const MARKUP_FRAGMENT_INNER = layoutConstant("MARKUP_FRAGMENT_INNER");
const MARKUP_FRAGMENT_OUTER = layoutConstant("MARKUP_FRAGMENT_OUTER");
const MARKUP_FRAGMENT_ADJACENT = layoutConstant("MARKUP_FRAGMENT_ADJACENT");
const INPUT_ACTIVATION_FOCUS = layoutConstant("INPUT_ACTIVATION_FOCUS");
const INPUT_ACTIVATION_SELECT = layoutConstant("INPUT_ACTIVATION_SELECT");
const TITLE_TARGET_NONE = layoutConstant("TITLE_TARGET_NONE");
const TITLE_TARGET_ELEMENT = layoutConstant("TITLE_TARGET_ELEMENT");
const TITLE_TARGET_SVG = layoutConstant("TITLE_TARGET_SVG");
const COLLECTION_NAME_STRING = layoutConstant("COLLECTION_NAME_STRING");
const COLLECTION_NAME_NULL = layoutConstant("COLLECTION_NAME_NULL");
const COLLECTION_NAME_OTHER = layoutConstant("COLLECTION_NAME_OTHER");
const COLLECTION_ANY_TAG = layoutConstant("COLLECTION_ANY_TAG");
const COLLECTION_FILTER_NAMESPACE = layoutConstant("COLLECTION_FILTER_NAMESPACE");
const COLLECTION_FILTER_CLASSES = layoutConstant("COLLECTION_FILTER_CLASSES");
const COLLECTION_FILTER_NAME = layoutConstant("COLLECTION_FILTER_NAME");
const COLLECTION_FILTER_HTML = layoutConstant("COLLECTION_FILTER_HTML");
const COLLECTION_FILTER_TABLE_ROWS = layoutConstant("COLLECTION_FILTER_TABLE_ROWS");
const COLLECTION_SCOPE_DESCENDANTS = layoutConstant("COLLECTION_SCOPE_DESCENDANTS");
const COLLECTION_SCOPE_CHILDREN = layoutConstant("COLLECTION_SCOPE_CHILDREN");
const CONTENT_EDITABLE_REMOVE = layoutConstant("CONTENT_EDITABLE_REMOVE");
const TABLE_PART_CAPTION = layoutConstant("TABLE_PART_CAPTION");
const TABLE_PART_HEAD = layoutConstant("TABLE_PART_HEAD");
const TABLE_PART_FOOT = layoutConstant("TABLE_PART_FOOT");

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
  const tag = tagName === null ? [0, COLLECTION_ANY_TAG] : core.input(tagName);
  const kind = typeof name === "string" ? COLLECTION_NAME_STRING : name === null ? COLLECTION_NAME_NULL : COLLECTION_NAME_OTHER;
  const requested = kind === COLLECTION_NAME_STRING ? core.input(name) : [0, 0];
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

// A live collection of the nodes of `root` that a core collection filter
// accepts (node_collection_list): `a` and `b` are its text arguments. An
// HTMLCollection has the core's named item; `named: false` makes a
// NodeList.
function filteredCollection(root, scope, filter, a = "", b = "", { named = true } = {}) {
  const core = root._domCore;
  return collection(() => core.collectionList(root._coreHandle, scope, filter, a, b), {
    named: named ? (name) => core.collectionListNamed(root._coreHandle, scope, filter, a, b, String(name)) : null,
  });
}

// The HTML descendants of `root` named in the comma-separated `names`
// that carry the attribute `attribute`, if given.
function descendantCollection(root, names, attribute = "") {
  return filteredCollection(root, COLLECTION_SCOPE_DESCENDANTS, COLLECTION_FILTER_HTML, names, attribute);
}

function querySelectorAll(root, selector) {
  return staticNodeList(root._domCore.selectorQueryAll(root._coreHandle, selector));
}

// getElementsByTagNameNS (DOM). The namespace is a nullable DOMString;
// the core reads null as the empty string, no namespace.
function elementsByTagNameNS(root, namespace, localName) {
  return filteredCollection(root, COLLECTION_SCOPE_DESCENDANTS, COLLECTION_FILTER_NAMESPACE,
    namespace === null || namespace === undefined ? "" : String(namespace), String(localName));
}

// getElementsByClassName (DOM).
function elementsByClassName(root, classNames) {
  return filteredCollection(root, COLLECTION_SCOPE_DESCENDANTS, COLLECTION_FILTER_CLASSES, String(classNames));
}

// getElementsByName (HTML): a live NodeList.
function elementsByName(document, elementName) {
  return filteredCollection(document, COLLECTION_SCOPE_DESCENDANTS, COLLECTION_FILTER_NAME, String(elementName), "",
    { named: false });
}

// A live HTMLCollection of the HTML children of `parent` named in the
// comma-separated `names`.
function childCollection(parent, names) {
  return filteredCollection(parent, COLLECTION_SCOPE_CHILDREN, COLLECTION_FILTER_HTML, names);
}

function ensureNode(value) {
  if (!(value instanceof SDNode)) {
    throw new TypeError("The value is not a Sandom Node");
  }
  return value;
}

// The mutation record a callback record notifies, in the shape of a
// MutationRecord (src/dom/document-session.js and src/dom/scripts.js read
// it).
function mutationRecordOf(core, record, target, relatedA, relatedB) {
  if (record.notify === CALLBACK_NOTIFY_STRUCTURE) {
    return {
      type: "childList",
      target,
      addedNodes: relatedA ? [relatedA] : [],
      removedNodes: relatedB ? [relatedB] : [],
      previousSibling: core.wrapperFor(record.previous),
      nextSibling: core.wrapperFor(record.next),
    };
  }
  if (record.notify === CALLBACK_NOTIFY_TEXT) return { type: "characterData", target, oldValue: record.oldValue };
  return {
    type: "attributes",
    target,
    attributeName: record.name,
    attributeNamespace: relatedA?.namespaceURI ?? null,
    oldValue: record.oldValue,
  };
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
  if (register) {
    core.registerWrapper(node, handle, true,
      ownerDocument === null ? core.handle("node_owner_document", handle) : ownerDocument._coreHandle);
  }
}

function initializeElementHostState(element) {
  element._attributes = createNamedNodeMap(element);
  element._style = createStyle(element);
  element._classList = createTokenList(element, "class");
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
      if (state !== CUSTOM_ELEMENT_UNCUSTOMIZED && state !== CUSTOM_ELEMENT_FAILED) prototype = SDHTMLElement.prototype;
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
    prototype = (flags & NODE_FLAG_SHADOW_ROOT) !== 0
      ? SDShadowRoot.prototype
      : SDDocumentFragment.prototype;
  } else {
    throw new Error(`Unsupported DOM core node type ${nodeType}`);
  }
  // A form's wrapper is a proxy for its named properties (form-dom.js).
  const node = elementWrapper(Object.create(prototype));
  registerEventTargetWrapper(node);
  initializeNodeHostState(node, core, handle, document, { register: false });
  // Named-property access during host-state setup can ask the core for this
  // same wrapper. Publish its identity before those accesses; the caller
  // attaches the one retained-reference finalizer after materialization.
  core.registerWrapper(node, handle, false, document._coreHandle);
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

// DOM "clone a node" creates each copy with "create an element" without
// the synchronous custom elements flag: a copy that has a definition gets
// an upgrade reaction (custom_upgrade), which runs before cloneNode or
// importNode returns, after the whole copy exists.
function cloneNodeInto(source, document, deep) {
  const core = source._domCore;
  return withCustomElementReactions(() => {
    const clone = core.clone(source._coreHandle, document._coreHandle, deep);
    copyClonedHostState(source, clone, deep);
    core.status("custom_upgrade", clone._coreHandle);
    return clone;
  }, core);
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

  // The owner document (node_owner_document), kept until the core's owner
  // epoch changes (an adoption or a document disposal).
  _bindingOwnerDocument() {
    const epoch = this._domCore.ownerEpochRegister.value;
    if (this._ownerDocumentEpoch !== epoch) {
      this._ownerDocument = this._domCore.nodeHandle("node_owner_document", this._coreHandle);
      this._ownerDocumentEpoch = epoch;
    }
    return this._ownerDocument;
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
    return nodeMember(this, "ownerDocument").baseURI;
  }
  get nodeValue() {
    return this._domCore.string("node_value", this._coreHandle);
  }
  set nodeValue(value) { this._transportNodeValue(`${value ?? ""}`); }
  get textContent() { return this._domCore.string("node_value", this._coreHandle); }
  set textContent(value) { this._transportNodeValue(`${value ?? ""}`); }
  _transportNodeValue(value) {
    withCustomElementReactions(() => {
      this._domCore.status("node_value_set", this._coreHandle, ...this._domCore.input(value));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  hasChildNodes() {
    return nodeMember(this, "firstChild") !== null;
  }
  isSameNode(otherNode) {
    return this === otherNode;
  }
  // normalize (DOM) runs in the core (nodes.watpart).
  normalize() {
    this._runTreeOperation(() => this._domCore.status("node_normalize", this._coreHandle));
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
    return this._domCore.wrapperFor(this._domCore.handle("input_focus_get", this._coreHandle, INPUT_FOCUS_FOCUSED));
  }
  get _activeElement() {
    return this._domCore.wrapperFor(this._domCore.handle("input_active_element", this._coreHandle));
  }

  get _childNodes() {
    return [...nodeMember(this, "childNodes")];
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
    const nodeType = nodeMember(this, "nodeType");
    sharedDomCore.status("node_clone_guard",
      typeof nodeType === "number" ? nodeType : NaN);
    return cloneNodeInto(this, nodeMember(this, "ownerDocument"), Boolean(deep));
  }

  // The document whose session gate and style system see this node's
  // mutations: the node itself for a document. A form's controls can shadow
  // its members (node-members.js).
  _mutationDocument() {
    return nodeMember(this, "nodeType") === 9 ? this : nodeMember(this, "ownerDocument");
  }

  // A mutation notification: the render surface, the mutation observer
  // checkpoint, and the host effects the core requested for it
  // (CALLBACK_EFFECT_* bits of its callback record). The core gates and
  // logs the change itself (core/dom/document-log.watpart).
  _notifyMutation(kind, detail, record = null, effects = 0) {
    const document = this._mutationDocument();
    this._renderSurface?._broadcastMutation(kind, this, detail);
    if (effects & CALLBACK_EFFECT_RESTYLE) document?._styleSystem?.reconcileSoon();
    scheduleMutationObservers(this._domCore);
    if (effects & CALLBACK_EFFECT_SCRIPT_STEPS) document?._scriptProcessing?.mutation(this, effects, record);
    if (effects & CALLBACK_EFFECT_IMAGE_ATTRIBUTE) imageAttributeChanged(this, record.attributeName);
    if (effects & CALLBACK_EFFECT_FOCUS_ATTRIBUTE) focusAttributeChanged(this, record.attributeName);
    if (effects & CALLBACK_EFFECT_POPOVER_ATTRIBUTE) popoverAttributeChanged(this);
  }

  _adoptSubtree(document) {
    if (document._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    if (nodeMember(this, "parentNode")) blurBeforeRemoval(this);
    this._runTreeOperation(() => this._domCore.adopt(document._coreHandle, this._coreHandle));
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

  // A [CEReactions] tree operation: the core enqueues its reactions into a
  // scope opened before it runs, and they run once its records are
  // delivered, before the operation returns.
  _runTreeOperation(operation) {
    return withCustomElementReactions(() => {
      try {
        return operation();
      } finally {
        this._deliverCoreTreeRecords();
      }
    }, this._domCore);
  }

  // Performs the host effects of the core's callback records
  // (CALLBACK_EFFECT_* bits) and delivers their mutation notifications.
  // Without a node at hand, a caller passes the core (the selectedcontent
  // handler of SDDocument).
  _deliverCoreTreeRecords(core = this._domCore) {
    for (const record of core.callbackRecords()) {
      const { effects } = record;
      if (effects === 0 && record.notify === CALLBACK_NOTIFY_NONE) continue;
      const target = core.wrapperFor(record.target);
      const relatedA = core.wrapperFor(record.relatedA);
      const relatedB = core.wrapperFor(record.relatedB);
      if (effects & CALLBACK_EFFECT_RETAIN) {
        moveListenedNode(target, target._documentRetention, relatedB);
        target._documentRetention = relatedB;
      }
      if (effects & CALLBACK_EFFECT_CANVAS_ADOPT) {
        relatedA?._canvasContexts?.delete(target._canvasContext);
        relatedB?._canvasContexts?.add(target._canvasContext);
      }
      if (effects & CALLBACK_EFFECT_IMAGE_ADOPT) imageAdopted(target);
      if (effects & CALLBACK_EFFECT_CLONE) copyClonedHostState(relatedA, target, record.previous === 1n);
      if (effects & CALLBACK_EFFECT_STYLE_ATTRIBUTE) target._style._parseAttribute(target.getAttributeNS(null, "style") ?? "");
      if (effects & CALLBACK_EFFECT_CANVAS_BITMAP) {
        target._canvasContext.attributeChanged(record.name, null, !target.hasAttribute(record.name), true);
      }
      // A moved node stays connected to the same surface with its state;
      // the core queued its connectedMoveCallback reactions.
      if (effects & CALLBACK_EFFECT_SURFACE_DISCONNECT) target._renderSurface?._broadcastDisconnectSubtree(relatedB);
      // The live range steps of a removal can move the Selection.
      if (effects & CALLBACK_EFFECT_SELECTION) target._mutationDocument()?.getSelection()?._takeChange();
      if (effects & CALLBACK_EFFECT_SURFACE_CONNECT) target._renderSurface?._connectSubtree(relatedA);
      if (record.notify === CALLBACK_NOTIFY_NONE) continue;
      const mutation = mutationRecordOf(core, record, target, relatedA, relatedB);
      target._notifyMutation(CALLBACK_NOTIFY_KINDS.get(record.notify), mutation.attributeName, mutation, effects);
    }
  }


  _transportInsertBefore(node, referenceNode) {
    const candidate = ensureNode(node);
    this._validateInsertion(candidate, referenceNode);
    if (referenceNode !== null) ensureNode(referenceNode);
    if (candidate.parentNode) blurBeforeRemoval(candidate);
    this._runTreeOperation(() => this._domCore.insertBefore(this._coreHandle, candidate._coreHandle, referenceNode?._coreHandle ?? 0n));
    return candidate;
  }

  // moveBefore (ParentNode): the core validates and moves; the move keeps
  // focus, so no blur runs.
  _transportMoveBefore(node, child) {
    const candidate = ensureNode(node);
    if (child !== null) ensureNode(child);
    if (candidate._domCore !== this._domCore) {
      throw new DOMException("move crosses shadow-including roots", "HierarchyRequestError");
    }
    this._runTreeOperation(() => this._domCore.moveBefore(this._coreHandle, candidate._coreHandle, child?._coreHandle ?? 0n));
  }

  _transportRemoveChild(node) {
    const candidate = ensureNode(node);
    if (candidate.parentNode === this) blurBeforeRemoval(candidate);
    this._runTreeOperation(() => this._domCore.removeChild(this._coreHandle, candidate._coreHandle));
    return candidate;
  }

  _transportReplaceChild(newChild, oldChild) {
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
    this._runTreeOperation(() => this._domCore.replaceChild(this._coreHandle, replacement._coreHandle, replaced._coreHandle));
    return replaced;
  }

  // The innerText and outerText setters (HTML) run in the core
  // (dom-text.watpart): $exportName replaces the children ($replacesSelf
  // false) or the element itself.
  _transportSetText(exportName, value, replacesSelf) {
    if (!replacesSelf) blurBeforeRemoval(this, true);
    else if (nodeMember(this, "parentNode") !== null) blurBeforeRemoval(this);
    this._runTreeOperation(() => this._domCore.status(exportName, this._coreHandle, ...this._domCore.input(value)));
  }
  // innerText and outerText ([LegacyNullToEmptyString]).
  _transportSetInnerText(value) {
    this._transportSetText("element_set_inner_text", value === null ? "" : String(value), false);
  }
  _transportSetOuterText(value) {
    this._transportSetText("element_set_outer_text", value === null ? "" : String(value), true);
  }
  // The innerText and outerText getters (HTML): the core runs the rendered
  // text collection steps. They update layout in Chrome, so they run the
  // focus check.
  _transportRenderedText() {
    scheduleFocusFixup(this);
    return this._domCore.string("element_rendered_text", this._coreHandle);
  }

  _transportTextContent() {
    return this._domCore.textContent(this._coreHandle);
  }
  // textContent (DOMString?: null is the empty string): the core replaces
  // all the children with one Text node.
  _transportSetTextContent(value) {
    const text = value === null ? "" : String(value);
    blurBeforeRemoval(this, true);
    this._runTreeOperation(() => this._domCore.status("node_set_text_content", this._coreHandle, ...this._domCore.input(text)));
  }

  // innerHTML and outerHTML getters: the XML serialization in an XML
  // document, else the HTML serialization.
  _transportInnerHTML() {
    return nodeMember(this, "ownerDocument")?._xmlDocument ? serializeXMLNodeContents(this) : serializeHTMLNodeContents(this);
  }
  _transportOuterHTML() {
    return nodeMember(this, "ownerDocument")?._xmlDocument ? serializeXMLNode(this) : serializeHTMLNode(this);
  }
  // The innerHTML and outerHTML setters ([LegacyNullToEmptyString]) and
  // insertAdjacentHTML: the core chooses the context element of the parse
  // and puts the parsed fragment in place.
  _transportSetInnerHTML(value) {
    this._setFragmentMarkup(MARKUP_FRAGMENT_INNER, "", value === null ? "" : String(value));
  }
  _transportSetOuterHTML(value) {
    this._setFragmentMarkup(MARKUP_FRAGMENT_OUTER, "", value === null ? "" : String(value));
  }
  _transportInsertAdjacentHTML(position, text) {
    this._setFragmentMarkup(MARKUP_FRAGMENT_ADJACENT, String(position), String(text));
  }
  _setFragmentMarkup(mode, position, markup) {
    const core = this._domCore;
    withCustomElementReactions(() => {
      const context = core.wrapperFor(core.statusRaw("markup_fragment_context", this._coreHandle, mode, ...core.input(position)));
      if (context === null) return;
      const fragment = parseMarkupFragment(context, markup);
      if (mode === MARKUP_FRAGMENT_INNER) blurBeforeRemoval(this, true);
      else if (mode === MARKUP_FRAGMENT_OUTER) blurBeforeRemoval(this);
      this._runTreeOperation(() =>
        core.status("markup_fragment_insert", this._coreHandle, mode, ...core.input(position), fragment._coreHandle));
    }, core);
  }
  _transportInsertAdjacentElement(position, element) {
    const where = String(position);
    const core = this._domCore;
    if (domCoreForWrapper(element) !== core) throw new TypeError("insertAdjacentElement requires an Element");
    if (element.parentNode) blurBeforeRemoval(element);
    return core.wrapperFor(this._runTreeOperation(() =>
      core.statusRaw("element_insert_adjacent", this._coreHandle, ...core.input(where), element._coreHandle)));
  }

  _bindingNodeSequence(mode, values) {
    let parent;
    let reference;
    let present = true;
    let document;
    let removeMethod;
    if (mode === NODE_SEQUENCE_BEFORE || mode === NODE_SEQUENCE_AFTER || mode === NODE_SEQUENCE_REPLACE_WITH) {
      present = !!nodeMember(this, "parentNode");
      if (present && mode === NODE_SEQUENCE_AFTER) reference = nodeMember(this, "nextSibling");
      if (present && mode === NODE_SEQUENCE_REPLACE_WITH) parent = nodeMember(this, "parentNode");
    } else if (mode === NODE_SEQUENCE_REMOVE) {
      parent = nodeMember(this, "parentNode");
      present = parent !== null && parent !== undefined;
      if (present) removeMethod = nodeMember(parent, "removeChild");
    } else if (mode === NODE_SEQUENCE_REPLACE_CHILDREN) {
      document = nodeMember(this, "ownerDocument") ?? this;
      values = values.map((value) => nodeFrom(value, document));
    }
    const core = domCoreForWrapper(this) ?? sharedDomCore;
    const invocation = core.handle("node_sequence_begin", 0n,
      mode, mode === NODE_SEQUENCE_REMOVE ? 0 : -1, present ? 1 : 0);
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
        if (action === NODE_SEQUENCE_ACTION_INPUT) {
          inputOpen = false;
          if (!input) {
            input = languageIterator(mode === NODE_SEQUENCE_PREPEND ? [...values].reverse() : values);
          }
          if (!languageIteratorStep(input)) {
            input = null;
            core.status("node_sequence_ack", invocation, token, 0n, 1);
            continue;
          }
          inputOpen = true;
          if (mode === NODE_SEQUENCE_REPLACE_CHILDREN) {
            candidate = input.value;
          } else {
            const intoTarget = mode === NODE_SEQUENCE_APPEND || mode === NODE_SEQUENCE_PREPEND;
            receiver = intoTarget ? this : mode === NODE_SEQUENCE_REPLACE_WITH ? parent : nodeMember(this, "parentNode");
            method = nodeMember(receiver, mode === NODE_SEQUENCE_APPEND ? "appendChild" : "insertBefore");
            const owner = intoTarget ? nodeMember(this, "ownerDocument") ?? this : nodeMember(this, "ownerDocument");
            candidate = nodeFrom(input.value, owner);
            insertionReference = mode === NODE_SEQUENCE_PREPEND ? nodeMember(this, "firstChild") :
              mode === NODE_SEQUENCE_AFTER ? reference : this;
          }
        } else if (action === NODE_SEQUENCE_ACTION_INSERT) {
          if (mode === NODE_SEQUENCE_APPEND) callLanguageFunction(method, receiver, candidate);
          else callLanguageFunction(method, receiver, candidate, insertionReference);
        } else if (action === NODE_SEQUENCE_ACTION_VALIDATE) {
          this._domCore.validateInsertion(this._coreHandle, candidate._coreHandle, 0n);
        } else if (action === NODE_SEQUENCE_ACTION_FRAGMENT) {
          replacement = document.createDocumentFragment();
        } else if (action === NODE_SEQUENCE_ACTION_ASSEMBLE) {
          inputOpen = false;
          if (!input) input = languageIterator(values);
          if (!languageIteratorStep(input)) {
            input = null;
            core.status("node_sequence_ack", invocation, token, 0n, 1);
            continue;
          }
          inputOpen = true;
          replacement.appendChild(input.value);
        } else if (action === NODE_SEQUENCE_ACTION_REPLACE) {
          this._transportReplaceChildren(replacement);
        } else if (action === NODE_SEQUENCE_ACTION_REMOVE) {
          if (mode === NODE_SEQUENCE_REMOVE) callLanguageFunction(removeMethod, parent, this);
          else nodeMember(parent, "removeChild").call(parent, this);
        } else if (action === NODE_SEQUENCE_ACTION_SHAPE) {
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
    this._runTreeOperation(() => this._domCore.replaceChildren(this._coreHandle, replacement?._coreHandle ?? 0n));
  }

}

export const Attr = createElementInterface(class SDAttr extends SDNode {
  get namespaceURI() { return attributeNodeCore(this).nodeString("node_namespace", this._coreHandle); }
  get prefix() { return attributeNodeCore(this).nodeString("node_prefix", this._coreHandle); }
  get localName() { return attributeNodeCore(this).nodeString("node_local_name", this._coreHandle); }
  get name() { return attributeNodeCore(this).nodeString("node_name", this._coreHandle); }
  get value() { return attributeNodeCore(this).string("node_value", this._coreHandle); }
  set value(value) {
    attributeNodeCore(this);
    this._transportNodeValue(`${value}`);
  }
  get ownerElement() { return attributeNodeCore(this).nodeHandle("attribute_node_owner", this._coreHandle); }
  get specified() { attributeNodeCore(this); return true; }
});

export const SDElement = createElementInterface(class SDElement extends SDNode {
  _transportSetAttributeNode(attribute) {
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

  get _requestedScrollLeft() { return scrollRead(this, SCROLL_REQUESTED_LEFT); }
  set _requestedScrollLeft(value) { scrollStore(this, SCROLL_REQUESTED_LEFT, value); }
  get _requestedScrollTop() { return scrollRead(this, SCROLL_REQUESTED_TOP); }
  set _requestedScrollTop(value) { scrollStore(this, SCROLL_REQUESTED_TOP, value); }
  get _scrollLeft() { return scrollRead(this, SCROLL_ACCEPTED_LEFT); }
  set _scrollLeft(value) { scrollStore(this, SCROLL_ACCEPTED_LEFT, value); }
  get _scrollTop() { return scrollRead(this, SCROLL_ACCEPTED_TOP); }
  set _scrollTop(value) { scrollStore(this, SCROLL_ACCEPTED_TOP, value); }
  // The public scroll bindings read these: the offsets of the scroller the
  // element's scroll position belongs to (elementScrollSource), which is the
  // viewport for the scrolling element. Each public scroll read and write
  // passes through one of them; it updates layout in Chrome, so it runs the
  // focus check (scheduleFocusFixup).
  get _cssomRequestedScrollLeft() { scheduleFocusFixup(this); return elementScrollRead(this, SCROLL_REQUESTED_LEFT); }
  get _cssomRequestedScrollTop() { scheduleFocusFixup(this); return elementScrollRead(this, SCROLL_REQUESTED_TOP); }
  get _cssomScrollLeft() { scheduleFocusFixup(this); return layoutGetters.scrollLeft(this); }
  get _cssomScrollTop() { scheduleFocusFixup(this); return layoutGetters.scrollTop(this); }

  _transportSetAttribute(name, value) {
    withCustomElementReactions(() => {
      this._domCore.setAttribute(this._coreHandle, String(name), String(value));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  _transportRemoveAttribute(name) {
    withCustomElementReactions(() => {
      this._domCore.removeAttribute(this._coreHandle, String(name));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  _transportRemoveAttributeNS(namespaceURI, localName) {
    withCustomElementReactions(() => {
      this._domCore.removeAttributeNS(this._coreHandle, namespaceURI ?? null, String(localName));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  _transportSetAttributeNS(namespaceURI, qualifiedName, value) {
    const namespace = namespaceURI === null || namespaceURI === undefined ? null : String(namespaceURI);
    const name = String(qualifiedName);
    withCustomElementReactions(() => {
      this._domCore.setAttributeNS(this._coreHandle, namespace, name, String(value));
      this._deliverCoreTreeRecords();
    }, this._domCore);
  }
  _bindingToggleAttribute(name, force) {
    const present = nodeMember(this, "hasAttribute").call(this, name);
    const action = sharedDomCore.status("attribute_toggle_plan",
      present ? 1 : 0, force === undefined ? ATTRIBUTE_TOGGLE_UNFORCED : force ? 1 : 0);
    if (action & ATTRIBUTE_TOGGLE_SET) nodeMember(this, "setAttribute").call(this, name, "");
    if (action & ATTRIBUTE_TOGGLE_REMOVE) nodeMember(this, "removeAttribute").call(this, name);
    return (action & ATTRIBUTE_TOGGLE_PRESENT) !== 0;
  }
  // An input run toggled this element's boolean attribute in the core (the
  // details disclosure, core/dom/input-run.watpart): its callback
  // records reach the facade as setAttribute's and removeAttribute's do.
  _deliverToggledAttribute() {
    this._dispatchCoreTreeRecords();
  }

  _bindingSheet() {
    return nodeMember(this, "ownerDocument")?._styleSystem?.sheetForElement(this) ?? null;
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
    if (this._domCore.status("scroll_accept", scrollState(this), scrollRead(this, SCROLL_REQUEST_GENERATION), left, top)) {
      dispatchNativeEvent(this, createEvent("scroll"));
      dispatchNativeEvent(this, createEvent("scrollend"));
    }
  }

  _treeRoot() {
    return nodeMember(this, "getRootNode").call(this);
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
    return this._layoutOptions ?? nodeMember(this, "ownerDocument")?._layoutOptions;
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
    const inView = withLiveGeometry(this, this._resolvedLayoutOptions, ({ core, handle }) =>
      core.status("geometry_in_root_client", handle, this._coreHandle));
    if (inView === 1) return;
    this.scrollIntoView({ block: "center", inline: "center" });
  }
});
// HTMLImageElement x and y (geometry_image_position).
function imagePosition(image, axis) {
  const surface = image._renderSurface;
  return withLiveGeometry(image, image._resolvedLayoutOptions, ({ core, handle }) =>
    core.status("geometry_image_position", handle, image._coreHandle, axis, surface?._scrollOwner ?? 0n,
      surface?.viewport.width ?? 0, surface?.viewport.height ?? 0));
}
installElementScrollBindings(scrollBindingRuntime, SDElement.prototype);
installInputControlStateBindings(inputControlRuntime, SDElement.prototype);
// focus() of an element that no other focusable kind covers updates layout
// in Chrome: its focus check tests for a keyboard-focusable scroll container
// over a synchronous layout (input_focus_scroller_candidate).
function runElementActivation(element, operation) {
  if (operation === INPUT_ACTIVATION_FOCUS && element._domCore.status("input_focus_scroller_candidate", element._coreHandle)) {
    withLiveGeometry(element, undefined, ({ core, handle }) =>
      withFocusGeometry(core, handle, () => runInputActivation(element, operation)));
    return;
  }
  runInputActivation(element, operation);
}

export const SDHTMLElement = createElementInterface(class SDHTMLElement extends SDElement {
  // contentEditable (HTML): the keyword of the contenteditable state.
  get contentEditable() {
    return this._domCore.string("element_content_editable", this._coreHandle);
  }
  set contentEditable(value) {
    const core = this._domCore;
    const action = core.statusRaw("content_editable_keyword", ...core.input(String(value)));
    if (action === CONTENT_EDITABLE_REMOVE) nodeMember(this, "removeAttribute").call(this, "contenteditable");
    else nodeMember(this, "setAttribute").call(this, "contenteditable", core.outputString());
  }
  // isContentEditable (HTML), from the core (input-activation.watpart).
  get isContentEditable() {
    return this._domCore.status("element_is_content_editable", this._coreHandle) === 1;
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
    this._domCore.status("node_set_data", this._coreHandle, ...this._domCore.input(normalized));
    this._deliverCoreTreeRecords();
  }
  // substringData, replaceData and its forms, and splitText run in the
  // core (nodes.watpart), with the live range steps.
  _bindingSubstringData(offset, count) {
    return this._domCore.string("node_substring_data", this._coreHandle, offset, count);
  }
  _bindingReplaceDataAtEnd(text) {
    this._replaceData(CHARACTER_DATA_END, 0, text);
  }
  _bindingReplaceData(offset, count, text) {
    this._replaceData(offset, count, text);
  }
  _replaceData(offset, count, text) {
    this._runTreeOperation(() =>
      this._domCore.status("node_replace_data", this._coreHandle, offset, count, ...this._domCore.input(text)));
  }
}

export class SDTextNode extends SDCharacterData {
  constructor(data = "", ownerDocument = null) {
    super(3, "#text", data, ownerDocument);
  }
  // splitText(unsigned long offset) (DOM, "split a Text node").
  splitText(offset) {
    const handle = this._runTreeOperation(() => this._domCore.handle("text_split", this._coreHandle, Number(offset) >>> 0));
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
  _notifyMutation(kind, detail, record = null, effects = 0) {
    this._renderSurface?._broadcastMutation(kind, this.host, detail);
    if (effects & CALLBACK_EFFECT_RESTYLE) this.ownerDocument?._styleSystem?.reconcileSoon();
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
  // width and height (HTML §4.10.5.1.20): an image button's rendered
  // image size, else its dimension attribute, else its image's natural
  // size, as an img's; 0 for another type, which has no image. Setting
  // reflects the attribute.
  get width() {
    return this.type === "image" ? imageDimension(this, IMAGE_AXIS_WIDTH) : 0;
  }
  set width(value) {
    this.setAttribute("width", unsignedLongAttributeValue(this._domCore, value));
  }
  get height() {
    return this.type === "image" ? imageDimension(this, IMAGE_AXIS_HEIGHT) : 0;
  }
  set height(value) {
    this.setAttribute("height", unsignedLongAttributeValue(this._domCore, value));
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
    return this._optionsCollection ??= descendantCollection(this, "option");
  }
}, "html");
// table.rows and table.tBodies (HTML): the rows of its thead children
// first, then its own and its tbody children's rows, then its tfoot
// children's rows, each in tree order.
// The caption, tHead and tFoot members and the create, delete and insert
// methods follow HTML, "The table element".
export const SDHTMLTableElement = createElementInterface(class SDHTMLTableElement extends SDHTMLElement {
  get rows() {
    return this._rowsCollection ??= filteredCollection(this, COLLECTION_SCOPE_CHILDREN, COLLECTION_FILTER_TABLE_ROWS);
  }
  get tBodies() {
    return this._bodiesCollection ??= childCollection(this, "tbody");
  }
  get caption() {
    return tablePart(this, TABLE_PART_CAPTION);
  }
  set caption(value) {
    if (value != null && !(value instanceof additionalElementInterfaces.HTMLTableCaptionElement)) {
      throw new TypeError("Failed to set the 'caption' property on 'HTMLTableElement': Failed to convert value to 'HTMLTableCaptionElement'.");
    }
    this.deleteCaption();
    if (value != null) this.insertBefore(value, this.firstChild);
  }
  createCaption() {
    return tablePart(this, TABLE_PART_CAPTION) ??
      this.insertBefore(this.ownerDocument.createElementNS(HTML_NS, "caption"), this.firstChild);
  }
  deleteCaption() {
    tablePart(this, TABLE_PART_CAPTION)?.remove();
  }
  get tHead() {
    return tablePart(this, TABLE_PART_HEAD);
  }
  set tHead(value) {
    tableSectionValue(value, "tHead", TABLE_PART_HEAD);
    this.deleteTHead();
    if (value != null) this.insertBefore(value, tableAnswer(this, "table_head_position"));
  }
  createTHead() {
    return tablePart(this, TABLE_PART_HEAD) ??
      this.insertBefore(this.ownerDocument.createElementNS(HTML_NS, "thead"), tableAnswer(this, "table_head_position"));
  }
  deleteTHead() {
    tablePart(this, TABLE_PART_HEAD)?.remove();
  }
  get tFoot() {
    return tablePart(this, TABLE_PART_FOOT);
  }
  set tFoot(value) {
    tableSectionValue(value, "tFoot", TABLE_PART_FOOT);
    this.deleteTFoot();
    if (value != null) this.appendChild(value);
  }
  createTFoot() {
    return tablePart(this, TABLE_PART_FOOT) ?? this.appendChild(this.ownerDocument.createElementNS(HTML_NS, "tfoot"));
  }
  deleteTFoot() {
    tablePart(this, TABLE_PART_FOOT)?.remove();
  }
  createTBody() {
    return this.insertBefore(this.ownerDocument.createElementNS(HTML_NS, "tbody"), tableAnswer(this, "table_body_position"));
  }
  // insertRow(): the core names the new row's parent (none: a new tbody at
  // the end of the table) and the row it goes before.
  insertRow(index = -1) {
    const core = this._domCore;
    const parent = core.wrapperFor(core.handle("table_row_insertion", this._coreHandle, toLong(index)));
    const reference = core.wrapperFor(core.handle("table_row_reference"));
    const row = this.ownerDocument.createElementNS(HTML_NS, "tr");
    (parent ?? this.appendChild(this.ownerDocument.createElementNS(HTML_NS, "tbody"))).insertBefore(row, reference);
    return row;
  }
  deleteRow(index) {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'deleteRow' on 'HTMLTableElement': 1 argument required, but only 0 present.");
    }
    const core = this._domCore;
    core.wrapperFor(core.handle("table_row_at", this._coreHandle, toLong(index)))?.remove();
  }
}, "html");
// A node that a table_* export answers for `table`.
function tableAnswer(table, exportName, ...args) {
  const core = table._domCore;
  return core.wrapperFor(core.handle(exportName, table._coreHandle, ...args));
}
function tablePart(table, part) {
  return tableAnswer(table, "table_part", part);
}
// The tHead and tFoot setters: the IDL type HTMLTableSectionElement, then
// the core's part check (table_part_check).
function tableSectionValue(value, member, part) {
  if (value == null) return;
  if (!(value instanceof additionalElementInterfaces.HTMLTableSectionElement)) {
    throw new TypeError(`Failed to set the '${member}' property on 'HTMLTableElement': Failed to convert value to 'HTMLTableSectionElement'.`);
  }
  value._domCore.status("table_part_check", value._coreHandle, part);
}
// WebIDL `long`: ToNumber, then ToInt32.
function toLong(value) {
  return Number(value) | 0;
}
// tr.cells (HTML): its td and th children.
export const SDHTMLTableRowElement = createElementInterface(class SDHTMLTableRowElement extends SDHTMLElement {
  get cells() {
    return this._cellsCollection ??= childCollection(this, "td,th");
  }
}, "html");
// map.areas (HTML): the area descendants.
export const SDHTMLMapElement = createElementInterface(class SDHTMLMapElement extends SDHTMLElement {
  get areas() {
    return this._areasCollection ??= descendantCollection(this, "area");
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
  get text() {
    return this._domCore.string("node_child_text", this._coreHandle);
  }
  set text(value) {
    this.textContent = String(value);
  }
}, "html");

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

export const SDHTMLImageElement = createElementInterface(class SDHTMLImageElement extends SDHTMLElement {
  // x and y (CSSOM View, HTMLImageElement): the box's position in the
  // document, truncated; 0 without a box.
  get x() {
    return imagePosition(this, IMAGE_POSITION_X);
  }
  get y() {
    return imagePosition(this, IMAGE_POSITION_Y);
  }
  get width() {
    return imageDimension(this, IMAGE_AXIS_WIDTH);
  }
  set width(value) {
    this.setAttribute("width", unsignedLongAttributeValue(this._domCore, value));
  }
  get height() {
    return imageDimension(this, IMAGE_AXIS_HEIGHT);
  }
  set height(value) {
    this.setAttribute("height", unsignedLongAttributeValue(this._domCore, value));
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

export const SDHTMLSourceElement = createElementInterface(class SDHTMLSourceElement extends SDHTMLElement {}, "html");

export const SDHTMLIFrameElement = createElementInterface(class SDHTMLIFrameElement extends SDHTMLElement {}, "html");

export class SDTreeWalker {
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
        if (action === TREE_WALK_ACTION_CLOSE) {
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
          if (action === TREE_WALK_ACTION_CHILDREN) {
            const record = languageIterator(values.get(target).childNodes ?? []);
            iteratorIdentity = ++nextIdentity;
            iterators.set(iteratorIdentity, record);
          } else if (action === TREE_WALK_ACTION_STEP) {
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
        } else if (action === TREE_WALK_ACTION_CHILDREN) {
          core.status("tree_walk_iterator", invocation, token, iteratorIdentity);
        } else if (action === TREE_WALK_ACTION_STEP) {
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

// Delivers the records of the selectedcontent updates of `core`, in a
// custom element reaction scope as _dispatchCoreTreeRecords does.
function dispatchSelectedContentRecords(core) {
  withCustomElementReactions(() => SDNode.prototype._deliverCoreTreeRecords.call(null, core), core);
}

// The wrapper of a node of document `ownerHandle` (node_owner_document).
function wrapOwnedNode(core, nodeHandle, ownerHandle) {
  if (ownerHandle === 0n) {
    throw new Error(`Missing document wrapper for handle ${nodeHandle}`);
  }
  const node = wrapExistingNode(core, nodeHandle, core.wrapperFor(ownerHandle));
  // A render surface connects every node of its subtree, but the link lives
  // on the wrapper. Under a surface root outside a document's tree, a node
  // without a box (an SVG `<stop>`) has no other holder, so its wrapper can
  // be collected and recreated here. The surface root is retained by its
  // surface, so the nearest parent (or shadow host) carries the surface this
  // node belongs to.
  const parent = nodeMember(node, "parentNode") ?? (node.nodeType === 11 ? node.host : null);
  node._renderSurface = parent?._renderSurface ?? null;
  return node;
}

export class SDDocument extends SDNode {
  // The document URL, which session history replaces (document_set_url).
  get URL() {
    return this._domCore.string("document_url", this._coreHandle);
  }
  get documentURI() {
    return this._domCore.string("document_url", this._coreHandle);
  }
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
    browsingContext = true,
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
    core.detailsToggleHandler ??= queueTopLayerTask;
    // A select's selectedcontent changed by a step without tree records of
    // its own (core/dom/selected-content.watpart): its records reach the
    // facade as a tree operation's do.
    core.selectedContentHandler ??= dispatchSelectedContentRecords;
    // Each change invalidates the selection at once; the event is
    // scheduled (Selection API, "schedule a selectionchange event"): a
    // change while one is scheduled queues none, and the queued task fires
    // one event that does not bubble at the document.
    this._selectionChangeScheduled = false;
    this._selection = new SDSelection(this, (changedNode) => {
      changedNode?._notifyMutation("selection");
      if (this._selectionChangeScheduled) return;
      this._selectionChangeScheduled = true;
      documentScripts(this).queueTask(() => {
        this._selectionChangeScheduled = false;
        dispatchNativeEvent(this, createEvent("selectionchange"));
      });
    });
    this._defaultView = null;
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
    // The file inputs activated without the host's file chooser
    // (src/dom/host-picker.js), one diagnostic each.
    this._fileChooserDiagnostics = new Map();
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
    // HTML, "look up a custom element definition": a document without a
    // browsing context (from DOMParser or DOMImplementation) finds no
    // definition, so the core keeps no registry for it.
    if (browsingContext) this.customElements._registerDocument(this);
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
  // A change of a registered highlight or of its ranges repaints the
  // document's text as a selection change does (CSS Custom Highlight API 1
  // §5.1).
  _repaintHighlights() {
    this.documentElement?._notifyMutation("selection");
  }
  _bindingDefaultView(value) {
    this._defaultView = value;
    if (value) {
      value.getComputedStyle = (element, pseudoElement = null) =>
        this.getComputedStyle(element, pseudoElement);
      value.getSelection = () => this.getSelection();
      value.CSS = cssNamespaceFor(this);
      value.customElements = this.customElements;
    }
  }
  get readyState() {
    return documentReadyState(this);
  }
  // Page visibility (HTML "update the visibility state"): the host that
  // shows the document sets it; a document is visible until then.
  get visibilityState() {
    return this.hidden ? "hidden" : "visible";
  }
  get hidden() {
    return this._domCore.status("document_hidden", this._coreHandle) === 1;
  }
  _setVisibilityState(state) {
    if (state !== "visible" && state !== "hidden") {
      throw new TypeError(`Unknown visibility state ${JSON.stringify(state)}; expected "visible" or "hidden"`);
    }
    if (this._domCore.status("document_visibility_set", this._coreHandle, Number(state === "hidden")) === 0) return;
    dispatchNativeEvent(this, createEvent("visibilitychange", { bubbles: true }));
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
    return this._linksCollection ??= descendantCollection(this, "a,area", "href");
  }
  get anchors() {
    return this._anchorsCollection ??= descendantCollection(this, "a", "name");
  }
  get scripts() {
    return this._scriptsCollection ??= descendantCollection(this, "script");
  }
  get embeds() {
    return this._embedsCollection ??= descendantCollection(this, "embed");
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
  // its core record (document_viewport_set). A change of the size makes
  // every computed record of the document resolve again; a change of the
  // scale alone snaps the records' line widths again. Without a scale it
  // keeps the document's scale, else the host's devicePixelRatio, else 1.
  _setViewport(width, height, deviceScale = this._viewport?.deviceScale ?? globalThis.devicePixelRatio ?? 1) {
    if (this._viewport?.width === width && this._viewport?.height === height && this._viewport?.deviceScale === deviceScale) return;
    this._viewport = { width, height, deviceScale };
    this._domCore.documentViewport(this._coreHandle, width, height, deviceScale);
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
    core.registerWrapper(element, handle, true, this._coreHandle);
    return element;
  }
  _createPublicElement(namespaceURI, name, namespaceAware) {
    const core = this._domCore;
    const handle = core.createPublicElement(this._coreHandle, namespaceURI, name,
      this.contentType ?? "", namespaceAware);
    const element = wrapExistingNode(core, handle, this);
    core.registerWrapper(element, handle, true, this._coreHandle);
    return element;
  }
  // createElement and createElementNS: the core validates the name and
  // creates the element; the registry constructs it with the is option.
  _transportCreateElement(tag, options) {
    const name = String(tag);
    const is = elementCreationIs(options);
    return withCustomElementReactions(
      () => this.customElements._construct(this._createPublicElement(null, name, false), is), this._domCore);
  }
  _transportCreateElementNS(namespaceURI, tag, options) {
    const namespace = namespaceURI === null || namespaceURI === undefined ? null : String(namespaceURI);
    const name = String(tag);
    const is = elementCreationIs(options);
    return withCustomElementReactions(
      () => this.customElements._construct(this._createPublicElement(namespace, name, true), is), this._domCore);
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
    return cloneNodeInto(source, this, Boolean(deep));
  }
  _transportAdoptNode(node) {
    const adopted = ensureNode(node);
    adopted._adoptSubtree(this);
    return adopted;
  }
}

// The is member of an ElementCreationOptions dictionary; a string option
// (the legacy form) gives none.
function elementCreationIs(options) {
  if (options === null || (typeof options !== "object" && typeof options !== "function")) return null;
  const is = options.is;
  return is === undefined ? null : String(is);
}

export class SDHTMLDocument extends SDDocument {}
export class SDXMLDocument extends SDDocument {}

export const DOMParser = createDOMParserClass({
  createDocument: () => new SDDocument({ browsingContext: false }),
  parseHTMLDocument,
  parseXMLDocument,
});
Object.defineProperty(DOMParser.prototype, Symbol.toStringTag, { value: "DOMParser", configurable: true });

export const additionalElementInterfaces = createAdditionalElementInterfaces(SDElement, SDHTMLElement, SDSVGElement);
installSVGGraphicsBindings(svgGraphicsRuntime, additionalElementInterfaces.SVGGraphicsElement.prototype);
Object.defineProperty(additionalElementInterfaces.HTMLLIElement.prototype, "value",
  reflectNumericValue(layoutConstant("NUMERIC_VALUE_LIST_ITEM"), webIDLLong));
Object.defineProperty(additionalElementInterfaces.HTMLMeterElement.prototype, "value",
  reflectNumericValue(layoutConstant("NUMERIC_VALUE_METER"), webIDLDouble));
Object.defineProperty(additionalElementInterfaces.HTMLProgressElement.prototype, "value",
  reflectNumericValue(layoutConstant("NUMERIC_VALUE_PROGRESS"), webIDLDouble));
// The values of a progress or meter (core/dom/gauge.watpart gauge_value,
// design/interaction.md Q6) by field: 1 minimum, 2 maximum, 3 low boundary,
// 4 high boundary, 5 optimum point, 6 position. Setting writes the
// attribute as the shortest number text; a setter with `positive` ignores
// a value of 0 or less, as progress.max does.
function reflectGauge(field, attribute, { positive = false } = {}) {
  return {
    get() {
      return this._domCore.status("gauge_value", this._coreHandle, field);
    },
    set(value) {
      const number = webIDLDouble(value);
      if (positive && !(number > 0)) return;
      this.setAttribute(attribute, String(number));
    },
    enumerable: true,
    configurable: true,
  };
}
const gaugeLabels = {
  get() {
    return elementLabels(this);
  },
  enumerable: true,
  configurable: true,
};
Object.defineProperties(additionalElementInterfaces.HTMLMeterElement.prototype, {
  min: reflectGauge(1, "min"),
  max: reflectGauge(2, "max"),
  low: reflectGauge(3, "low"),
  high: reflectGauge(4, "high"),
  optimum: reflectGauge(5, "optimum"),
  labels: gaugeLabels,
});
Object.defineProperties(additionalElementInterfaces.HTMLProgressElement.prototype, {
  max: reflectGauge(2, "max", { positive: true }),
  position: {
    get() {
      return this._domCore.status("gauge_value", this._coreHandle, 6);
    },
    enumerable: true,
    configurable: true,
  },
  labels: gaugeLabels,
});
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
    target?._bindingNodeSequence(NODE_SEQUENCE_REMOVE, []);
  },
  enumerable: true,
  configurable: true,
  writable: true,
});
for (const [name, interfaceObject] of Object.entries({
  Node: SDNode, Attr, Element: SDElement, HTMLElement: SDHTMLElement, SVGElement: SDSVGElement,
  TreeWalker: SDTreeWalker, Document: SDDocument, HTMLDocument: SDHTMLDocument, XMLDocument: SDXMLDocument,
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
  select(node) { runInputActivation(node, INPUT_ACTIVATION_SELECT); },
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
// A select's showPicker() places its picker over the current layout.
installSelectIndexBindings({
  ...inputControlRuntime,
  showPicker: (node) => withLiveGeometry(node, undefined, (geometry) => inputControlRuntime.showPicker(node, geometry.handle)),
}, SDHTMLSelectElement.prototype);
installFormDomBindings({
  SDDocument, SDHTMLFormElement, SDHTMLInputElement, SDHTMLSelectElement, SDHTMLButtonElement,
  SDHTMLTextAreaElement, SDHTMLOptionElement, SDHTMLFieldSetElement, SDHTMLOutputElement, SDHTMLLabelElement,
});
installConstraintValidationBindings([
  SDHTMLButtonElement.prototype, SDHTMLFieldSetElement.prototype, SDHTMLInputElement.prototype,
  SDHTMLOutputElement.prototype, SDHTMLSelectElement.prototype, SDHTMLTextAreaElement.prototype,
  additionalElementInterfaces.HTMLObjectElement.prototype,
], SDHTMLFormElement.prototype);
installElementInternalsFormBindings(ElementInternals.prototype);

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
installDialogBindings(topLayerBindingRuntime, additionalElementInterfaces.HTMLDialogElement.prototype);
installPopoverBindings(topLayerBindingRuntime, SDHTMLElement.prototype);
for (const constructor of [SDHTMLButtonElement, SDHTMLInputElement]) {
  installPopoverTargetBindings(topLayerBindingRuntime, constructor.prototype);
}
// relList (HTML) of a, area, form and link: one native token list per
// element over rel.
const relLists = new WeakMap();
const relListRuntime = {
  relList(element) {
    let list = relLists.get(element);
    if (list === undefined) relLists.set(element, list = createTokenList(element, "rel"));
    return list;
  },
  setRelList(element, value) {
    relListRuntime.relList(element).value = value;
  },
};
for (const constructor of [SDHTMLAnchorElement, additionalElementInterfaces.HTMLAreaElement, SDHTMLFormElement,
  additionalElementInterfaces.HTMLLinkElement]) {
  installRelListBindings(relListRuntime, constructor.prototype);
}
// The reflected IDL attributes of the "reflections" binding
// (dom-interfaces.json).
installAttributeReflections({
  ...additionalElementInterfaces,
  Element: SDElement, HTMLElement: SDHTMLElement, HTMLAnchorElement: SDHTMLAnchorElement, HTMLButtonElement: SDHTMLButtonElement,
  HTMLFieldSetElement: SDHTMLFieldSetElement, HTMLMapElement: SDHTMLMapElement, HTMLOutputElement: SDHTMLOutputElement,
  HTMLFormElement: SDHTMLFormElement, HTMLIFrameElement: SDHTMLIFrameElement, HTMLImageElement: SDHTMLImageElement,
  HTMLInputElement: SDHTMLInputElement, HTMLScriptElement: SDHTMLScriptElement, HTMLSelectElement: SDHTMLSelectElement,
  HTMLSourceElement: SDHTMLSourceElement, HTMLTemplateElement: SDHTMLTemplateElement,
  HTMLTableElement: SDHTMLTableElement, HTMLTableRowElement: SDHTMLTableRowElement, HTMLTextAreaElement: SDHTMLTextAreaElement,
});
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
installShadowRootBindings({ adoptedStyleSheets, setAdoptedStyleSheets }, SDShadowRoot.prototype);
// HTML `Document.title`: the core finds the title element, reads its text
// and chooses where a write goes (document-title.watpart). An existing
// title element keeps its identity and receives the value as its only
// child.
function documentTitleText(document) {
  return document._domCore.string("document_title_text", document._coreHandle);
}

function setDocumentTitleText(document, value) {
  const core = document._domCore;
  const target = core.status("document_title_target", document._coreHandle);
  let title;
  if (target === TITLE_TARGET_NONE) return;
  if (target === TITLE_TARGET_ELEMENT) {
    title = core.wrapperFor(core.status("document_title_element", document._coreHandle));
  } else if (target === TITLE_TARGET_SVG) {
    const root = document.documentElement;
    title = document.createElementNS(SVG_NS, "title");
    root.insertBefore(title, root.firstChild);
  } else {
    title = document.createElement("title");
    document.head.appendChild(title);
  }
  // The DOM's "string replace all".
  title.textContent = value;
}

installPrototypeEventHandlers(SDDocument.prototype, DOCUMENT_EVENT_HANDLER_TYPES);
const documentImplementations = new WeakMap();
installDocumentBindings({
  SDTextNode, SDComment, SDDocumentFragment, SDCDATASection,
  SDProcessingInstruction,
  SDRange, SDTreeWalker, ensureNode, adoptedStyleSheets, setAdoptedStyleSheets,
  elementsByTagName, elementsByTagNameNS, elementsByClassName, elementsByName, querySelectorAll, sharedDomCore,
  // HTML "has focus steps": a document with a host environment while its
  // host gives it system focus (input_document_system_focused).
  documentHasFocus(document) {
    return document._componentEnvironment != null &&
      document._domCore.status("input_document_system_focused", document._coreHandle) === 1;
  },
  documentTitleText,
  setDocumentTitleText,
  documentScrollingElement,
  // Document.implementation is [SameObject].
  implementation(document) {
    let implementation = documentImplementations.get(document);
    if (implementation === undefined) {
      implementation = createDOMImplementation(document);
      documentImplementations.set(document, implementation);
    }
    return implementation;
  },
}, SDDocument.prototype);
installDocumentGeometryBindings(layoutGetters, SDDocument.prototype);
installDocumentAnimationBindings({ documentAnimations, documentTimeline }, SDDocument.prototype);
installEditingCommands(SDDocument.prototype);
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
// Fragment parsing marks its scripts "already started": inserting the
// fragment runs none of them. Its content attributes set handlers.
function parseHTMLFragmentWithEffects(context, source) {
  const fragment = parseHTMLFragment(context, source);
  context.ownerDocument?._scriptProcessing?.activateParsedHandlers(fragment);
  imagesParsed(fragment);
  markScriptsAlreadyStarted(fragment);
  return fragment;
}
// The fragment of markup parsed in the context element: XML in an XML
// document, else HTML.
function parseMarkupFragment(context, source) {
  return context.ownerDocument?._xmlDocument ? parseXMLFragment(context, source) : parseHTMLFragmentWithEffects(context, source);
}

const createDOMImplementation = installMarkupBindings({
  element: SDElement.prototype,
  htmlElement: SDHTMLElement.prototype,
  fragment: SDDocumentFragment.prototype,
  shadow: SDShadowRoot.prototype,
  document: SDDocument.prototype,
  script: SDHTMLScriptElement.prototype,
}, { SDDocument, SDDocumentType });
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
