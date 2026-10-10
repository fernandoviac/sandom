// Standards-shaped wrappers for the Sandom DOM WebAssembly core. The core owns
// tree, style, and layout state; serialize.js publishes its engine records.

import { createStyle, resolvedElementFields } from "./style.js";
import { createFontRegistry, defaultFontRegistry } from "../font-registry.js";
import {
  DomCoreAttributeMap,
  DomCoreAttributeMetadataMap,
  DomCoreClassSet,
  domCoreForWrapper,
  sharedDomCore,
} from "../dom-wasm/core.js";
import {
  addEventListener as addListener,
  createEvent,
  dispatchEvent as dispatchNativeEvent,
  removeEventListener as removeListener,
} from "./events.js";
import { SandomViewport, scrollBindingRuntime } from "./viewport.js";
import { installElementScrollBindings } from "./dom-bindings.generated.js";
import { documentScrollingElement, elementScrollRead, elementScrollSource, scrollRead, scrollStore, scrollRequest, scrollState } from "./scroll-core.js";
import * as layoutGetters from "./layout-getters.js";
import { scheduleMutationObservers } from "./mutation-observer.js";
import {
  parseHTMLDocument,
  parseHTMLFragment,
  serializeNode as serializeHTMLNode,
  serializeNodeContents as serializeHTMLNodeContents,
} from "./html.js";
import {
  parseXMLDocument,
  parseXMLFragment,
  serializeXMLNode,
  serializeXMLNodeContents,
} from "./xml.js";
import { createDOMParserClass } from "./dom-parser.generated.js";
import {
  createElementFamily, createHTMLCollectionBinding, createNodeListBinding,
  installCharacterDataBindings, installDocumentBindings, installDocumentFragmentBindings,
  installDocumentTypeBindings, installElementBindings, installHTMLElementBindings, installNodeBindings,
  installProcessingInstructionBindings, installShadowRootBindings, installSVGElementBindings, installTemplateBindings, installTreeWalkerBindings,
  installElementAnimationBindings, installElementGeometryBindings, installDocumentGeometryBindings, installCanvasResourceBindings,
  installDocumentAnimationBindings,
} from "./dom-bindings.generated.js";
import { documentAnimations, elementAnimationHost } from "./animation.js";
import {
  createDocumentStyleSystem,
  CSS,
  setAdoptedStyleSheets,
} from "./stylesheet.js";
import {
  adopted as customElementAdopted,
  attributeChanged as customElementAttributeChanged,
  constructionCandidate,
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
  assertCanvas2DSettingsSupported,
  canvasToBlob,
  convertCanvas2DSettings,
  createCanvasRenderingContext2D,
  readMemberNotSupported,
} from "./canvas-2d.js";
import { SDRange, SDSelection } from "./selection.js";
import { requestSubmit, runInputActivation } from "./input-activation.js";
import { copyControlIdentities, inputControlRuntime } from "./input-controls.js";
import {
  installFormSubmissionBindings,
  installInputActivationBindings,
  installInputControlBindings,
  installInputControlStateBindings,
  installInputTypeBindings,
} from "./dom-bindings.generated.js";
import { installMarkupBindings } from "./element-mutations.js";
import { installShadowBindings } from "./shadow-bindings.js";
import { createTokenList, createClassTokenList, createDataset } from "./node-collections.js";
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



const TEXT_INPUT_TYPES = new Set([
  "email",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);
const eventHandlerRecords = new WeakMap();

function getEventHandler(element, type) {
  return eventHandlerRecords.get(element)?.get(type)?.value ?? null;
}

function setEventHandler(element, type, candidate) {
  let records = eventHandlerRecords.get(element);
  const current = records?.get(type) ?? null;
  const value = typeof candidate === "function" ? candidate : null;
  if (current) {
    if (value) {
      current.value = value;
    } else {
      removeListener(element, type, current.listener);
      records.delete(type);
      if (records.size === 0) eventHandlerRecords.delete(element);
    }
    return;
  }
  if (!value) return;
  if (!records) {
    records = new Map();
    eventHandlerRecords.set(element, records);
  }
  const record = {
    value,
    listener(event) {
      const core = this._domCore;
      const result = record.value.call(this, event);
      if (core.status("event_handler_result", typeof result === "boolean" ? 1 : 0, result ? 1 : 0)) {
        event.preventDefault();
      }
    },
  };
  records.set(type, record);
  addListener(element, type, record.listener);
}

// A live collection over `items()`; `count` and `at` answer length and index
// reads without materializing every item when the source can (the core's
// child lists), so `children.length` or `childNodes[0]` on a wide parent
// costs one core call instead of one wrapper per child.
function collection(items, { named = null, count = null, at = null } = {}) {
  const runtime = {
    count: count ?? (() => items().length),
    at: at ?? ((index) => items()[index]),
    iterator() {
      return items()[Symbol.iterator]();
    },
    forEach(callback, thisArgument) {
      items().forEach(callback, thisArgument);
    },
    named,
  };
  return named ? createHTMLCollectionBinding(runtime) : createNodeListBinding(runtime);
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

function walkElements(root) {
  const elements = [];
  const pending = [...root._childNodes];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node.nodeType === 1) elements.push(node);
    pending.unshift(...node._childNodes);
  }
  return elements;
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



function ensureNode(value) {
  if (!(value instanceof SDNode)) {
    throw new TypeError("The value is not a Sandom Node");
  }
  return value;
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
  node.childNodes = collection(() => core.childHandles(handle), {
    count: () => core.childCount(handle),
    at: (index) => core.childAt(handle, index),
  });
  node.children = collection(() => core.childElementHandles(handle), {
    named: (name) => collectionNamed(node, null, name),
    count: () => core.childElementCount(handle),
    at: (index) => core.childElementAt(handle, index),
  });
  node._renderSurface = null;
  if (register) core.registerWrapper(node, handle, true);
}

function initializeElementHostState(element) {
  element.attributes = new DomCoreAttributeMap(
    element._domCore,
    element._coreHandle,
  );
  element._attributeMetadata = new DomCoreAttributeMetadataMap(
    element._domCore,
    element._coreHandle,
  );
  element.classes = new DomCoreClassSet(element._domCore, element._coreHandle);
  element.style = createStyle(element);
  element._classList = createClassTokenList(element, {
    withCustomElementReactions, customElementAttributeChanged,
  });
  element._part = createTokenList(element, "part");
  element._dataset = null;
  installInputControlStateBindings(inputControlRuntime, element);
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
  initializeNodeHostState(node, core, handle, document, { register: false });
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

export class SDNode {
  constructor(_nodeType, _nodeName, ownerDocument, coreState) {
    if (!coreState?.core || typeof coreState.handle !== "bigint") {
      throw new TypeError("A DOM core handle is required");
    }
    initializeNodeHostState(
      this,
      coreState.core,
      coreState.handle,
      ownerDocument,
    );
  }

  get _focusedElement() {
    return this._domCore.wrapperFor(this._domCore.handle("input_focus_get", this._coreHandle, 1));
  }
  set _focusedElement(value) {
    this._domCore.status("input_focus_set", this._coreHandle, 1, value?._coreHandle ?? 0n);
  }
  get _activeElement() {
    return this._domCore.wrapperFor(this._domCore.handle("input_focus_get", this._coreHandle, 2));
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

  _notifyMutation(kind, detail, record = null) {
    this._assertMutationAllowed();
    if (kind === "style" && !this._parsingStyleAttribute) {
      record = {
        type: "attributes",
        target: this,
        attributeName: "style",
        attributeNamespace: null,
        oldValue: this.style._mutationOldValue ?? null,
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
    if (kind === "state" || kind === "property") this._invalidateState(detail);
    else if (kind !== "selection" && kind !== "style") document?._styleSystem?.reconcileSoon();
    scheduleMutationObservers(this._domCore);
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
        }
        continue;
      }
      if (record.kind === 2) {
        const target = this._domCore.wrapperFor(record.target);
        target._notifyMutation("attribute", record.name, {
          type: "attributes",
          target,
          attributeName: record.name,
          attributeNamespace: null,
          oldValue: record.oldValue,
        });
        continue;
      }
      if (record.kind !== 1) continue;
      const target = this._domCore.wrapperFor(record.target);
      const addedNode = this._domCore.wrapperFor(record.relatedA);
      const removedNode = this._domCore.wrapperFor(record.relatedB);
      const previousSibling = this._domCore.wrapperFor(record.previous);
      const nextSibling = this._domCore.wrapperFor(record.next);
      if (removedNode) {
        target._renderSurface?._broadcastDisconnectSubtree(removedNode);
        const document = target.nodeType === 9 ? target : target.ownerDocument;
        const selection = document?.getSelection();
        selection?._removed(removedNode);
      }
      if (addedNode) {
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
      customElementTreeChanged(target, addedNode, removedNode);
    }
  }


  _transportInsertBefore(node, referenceNode) {
    this._assertMutationAllowed();
    const candidate = ensureNode(node);
    this._validateInsertion(candidate, referenceNode);
    if (referenceNode !== null) ensureNode(referenceNode);
    this._domCore.insertBefore(
      this._coreHandle,
      candidate._coreHandle,
      referenceNode?._coreHandle ?? 0n,
    );
    this._dispatchCoreTreeRecords();
    return candidate;
  }

  _transportRemoveChild(node) {
    this._assertMutationAllowed();
    const candidate = ensureNode(node);
    const document = candidate.ownerDocument;
    this._domCore.removeChild(this._coreHandle, candidate._coreHandle);
    this._dispatchCoreTreeRecords();
    this._domCore.status("input_focus_removed", document?._coreHandle ?? 0n, candidate._coreHandle, 1);
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
    const document = replaced.ownerDocument;
    this._domCore.replaceChild(
      this._coreHandle,
      replacement._coreHandle,
      replaced._coreHandle,
    );
    this._dispatchCoreTreeRecords();
    this._domCore.status("input_focus_removed", document?._coreHandle ?? 0n, replaced._coreHandle, 2);
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
          this._transportReplaceChildren(replacement, document);
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

  _transportReplaceChildren(replacement, document) {
    if (replacement && replacement._domCore !== this._domCore) {
      throw new DOMException(
        "The nodes belong to different DOM core instances",
        "WrongDocumentError",
      );
    }
    this._domCore.replaceChildren(this._coreHandle, replacement?._coreHandle ?? 0n);
    this._dispatchCoreTreeRecords();
    this._domCore.status("input_focus_removed", document?._coreHandle ?? 0n, this._coreHandle, 3);
  }

}

export class SDElement extends SDNode {
  constructor(tag, namespaceURI = HTML_NS, ownerDocument = null) {
    const candidate = constructionCandidate(new.target);
    if (candidate) return candidate;
    const document = ownerDocument ?? defaultDocument;
    const handle = document._domCore.createElement(
      document._coreHandle,
      namespaceURI,
      String(tag),
    );
    super(1, null, document, { core: document._domCore, handle });
    initializeElementHostState(this);
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
  // viewport for the scrolling element.
  get _cssomRequestedScrollLeft() { return elementScrollRead(this, 0); }
  get _cssomRequestedScrollTop() { return elementScrollRead(this, 1); }
  get _cssomScrollLeft() { return elementScrollRead(this, 2); }
  get _cssomScrollTop() { return elementScrollRead(this, 3); }

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
    if (normalizedName === "style") this.style._parseAttribute(normalizedValue);
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
    if (normalizedName === "style") this.style._parseAttribute("");
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
      present ? 1 : 0, force === undefined ? -1 : Boolean(force) ? 1 : 0);
    if (action & 2) this.setAttribute(name, "");
    if (action & 4) this.removeAttribute(name);
    return (action & 1) !== 0;
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
  scrollIntoView(options) {
    if (this._scrollIntoView) this._scrollIntoView(options);
    else {layoutGetters.scrollIntoView(
        this,
        options,
        this._resolvedLayoutOptions,
      );}
  }


}
installElementScrollBindings(scrollBindingRuntime, SDElement.prototype);
installInputControlBindings(inputControlRuntime, SDElement.prototype);
installInputActivationBindings({ runInputActivation }, SDElement.prototype);

export class SDHTMLElement extends SDElement {
  constructor(tag, namespaceURI = HTML_NS, ownerDocument = null) {
    super(tag, namespaceURI, ownerDocument);
  }
}

export class SDSVGElement extends SDElement {
  constructor(tag, namespaceURI = SVG_NS, ownerDocument = null) {
    super(tag, namespaceURI, ownerDocument);
  }
}

export class SDHTMLTemplateElement extends SDHTMLElement {
  constructor(_tag = "template", namespaceURI = HTML_NS, ownerDocument = null) {
    super("template", namespaceURI, ownerDocument);
  }
}

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
}

export class SDTextNode extends SDCharacterData {
  constructor(data, ownerDocument = null) {
    super(3, "#text", data, ownerDocument);
  }
}

export class SDComment extends SDCharacterData {
  constructor(data, ownerDocument = null) {
    super(8, "#comment", data, ownerDocument);
  }
}

export class SDCDATASection extends SDCharacterData {
  constructor(data, ownerDocument = null) {
    super(4, "#cdata-section", data, ownerDocument);
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
  constructor() {
    throw new TypeError("Illegal constructor");
  }
  get activeElement() {
    return this._activeElement;
  }
  _invalidateStyles() {
    this.ownerDocument?._invalidateStyles();
  }
  _notifyMutation(kind, detail, record = null) {
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
export class SDHTMLInputElement extends SDHTMLElement {
  constructor(tag = "input", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
  get value() {
    return super.value;
  }
  set value(value) {
    super.value = value;
  }
}
installInputTypeBindings(inputControlRuntime, SDHTMLInputElement.prototype);

export class SDHTMLSelectElement extends SDHTMLElement {
  constructor(tag = "select", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
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
}

export class SDHTMLButtonElement extends SDHTMLElement {
  constructor(tag = "button", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
}
export class SDHTMLFormElement extends SDHTMLElement {
  constructor(tag = "form", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
}
installFormSubmissionBindings({ requestSubmit, runInputActivation }, SDHTMLFormElement.prototype);
export class SDHTMLCanvasElement extends SDHTMLElement {
  constructor(tag = "canvas", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
  _getContextFromString(contextIdentifier, options) {
    if (contextIdentifier === "2d") {
      const settings = convertCanvas2DSettings(options);
      if (this._canvasContextType === "2d") return this._canvasContext;
      if (this._canvasContextType !== null) return null;
      assertCanvas2DSettingsSupported(settings);
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
  toDataURL() {
    throw readMemberNotSupported("HTMLCanvasElement.toDataURL");
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
}

export class SDHTMLScriptElement extends SDHTMLElement {
  constructor(tag = "script", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
}

export class SDHTMLIFrameElement extends SDHTMLElement {
  constructor(tag = "iframe", ownerDocument = null) {
    super(tag, HTML_NS, ownerDocument);
  }
}

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
    resolveStylesheet = null,
    environment = {},
    customElements = null,
    reportException = null,
    core = sharedDomCore,
    fontRegistry,
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
    this.oninput = null;
    this.URL = normalizedURL;
    this.documentURI = this.URL;
    this._resolveStylesheet = resolveStylesheet;
    this._sandomFontRegistry = fontRegistry ?? core.defaultFontRegistry ??
      (core.defaultFontRegistry = core === defaultFontRegistry.core
        ? defaultFontRegistry
        : createFontRegistry({ core }));
    this._styleSystem = createDocumentStyleSystem(this, environment);
    // Diagnostics of images that failed to load or decode: render surfaces
    // record them, a prepared document gives them to the host.
    this._brokenImageDiagnostics = new Map();
    // Background exception sink for this document's realm. A component
    // session routes lifecycle, animation-frame, and background render
    // failures here so they fail the session loudly instead of escaping
    // as an unobserved worker error (silence in a browser worker).
    this._reportException = reportException;
    this.customElements = customElements ?? new CustomElementRegistry({
      core,
      supportedBuiltIns: new Map([["button", SDHTMLButtonElement]]),
      ...(reportException ? { reportException } : {}),
    });
    this._canvasContexts = new Set();
    this.customElements._registerDocument(this);
    this.implementation = createDOMImplementation(this);
  }
  get _xmlDocument() {
    return this._domCore.isXmlDocument(this._coreHandle);
  }
  set _xmlDocument(value) {
    this._domCore.setXmlDocument(this._coreHandle, Boolean(value));
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
  _validateInsertion(node, referenceNode = null) {
    super._validateInsertion(node, referenceNode);
    this._domCore.status("document_validate_children", this._coreHandle,
      node._coreHandle, referenceNode?._coreHandle ?? 0n);
  }
  _createUncustomizedElement(tag, namespaceURI = HTML_NS) {
    return elementFamily.construct(this, tag, namespaceURI);
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

export const DOMParser = createDOMParserClass({
  createDocument: () => new SDDocument(),
  parseHTMLDocument,
  parseXMLDocument,
});

const elementFamily = createElementFamily({
  SDElement, SDHTMLElement, SDSVGElement, SDHTMLTemplateElement,
  SDHTMLButtonElement, SDHTMLCanvasElement, SDHTMLFormElement, SDHTMLInputElement,
  SDHTMLSelectElement, SDHTMLScriptElement, SDHTMLIFrameElement,
});

installNodeBindings({ addListener, removeListener, dispatchNativeEvent }, SDNode.prototype);
installElementAnimationBindings({ animationHost: elementAnimationHost }, SDElement.prototype);
installElementGeometryBindings(layoutGetters, SDElement.prototype);
installElementBindings({
  elementsByTagName,
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
}, SDElement.prototype);
installTreeWalkerBindings({}, SDTreeWalker.prototype);
installHTMLElementBindings({ getEventHandler, setEventHandler }, SDHTMLElement.prototype);
installSVGElementBindings({ getEventHandler, setEventHandler }, SDSVGElement.prototype);
installCharacterDataBindings({}, SDCharacterData.prototype);
installTemplateBindings({}, SDHTMLTemplateElement.prototype);
installProcessingInstructionBindings({}, SDProcessingInstruction.prototype);
installDocumentFragmentBindings({}, SDDocumentFragment.prototype);
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

installDocumentBindings({
  SDTextNode, SDComment, SDDocumentFragment, SDCDATASection,
  SDProcessingInstruction, SDDocumentType,
  SDRange, SDTreeWalker, ensureNode, setAdoptedStyleSheets,
  elementsByTagName, sharedDomCore,
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
installDocumentAnimationBindings({ documentAnimations }, SDDocument.prototype);
installCanvasResourceBindings({}, SDHTMLCanvasElement.prototype);
const createDOMImplementation = installMarkupBindings({
  element: SDElement.prototype,
  fragment: SDDocumentFragment.prototype,
  shadow: SDShadowRoot.prototype,
  document: SDDocument.prototype,
  script: SDHTMLScriptElement.prototype,
}, {
  parseHTMLFragment, parseXMLFragment,
  serializeXMLNode, serializeXMLNodeContents,
  serializeHTMLNode, serializeHTMLNodeContents,
  SDTextNode, SDElement, SDDocument,
  withCustomElementReactions,
});
installShadowBindings({
  element: SDElement.prototype,
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
