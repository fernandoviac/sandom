import { createDatasetTrapsBinding } from "./dom-bindings.generated.js";
import { domCoreForWrapper } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The modes and the omitted force of token_list_update, by the names of
// their WAT globals.
const TOKEN_ADD = layoutConstant("TOKEN_ADD");
const TOKEN_REMOVE = layoutConstant("TOKEN_REMOVE");
const TOKEN_TOGGLE = layoutConstant("TOKEN_TOGGLE");
const TOKEN_REPLACE = layoutConstant("TOKEN_REPLACE");
const TOKEN_FORCE_OMITTED = layoutConstant("TOKEN_FORCE_OMITTED");

const tokenListBindings = new WeakMap();

function tokenListBinding(receiver, required = 0, supplied = 0) {
  const binding = tokenListBindings.get(receiver);
  if (!binding) throw new TypeError("Illegal DOMTokenList receiver");
  if (supplied < required) throw new TypeError(`DOMTokenList operation requires ${required} arguments; received ${supplied}`);
  return binding;
}

export class DOMTokenList {
  constructor() { throw new TypeError("Illegal DOMTokenList constructor"); }
  get length() { return tokenListBinding(this).length(); }
  item(index) { return tokenListBinding(this, 1, arguments.length).item(index >>> 0); }
  contains(token) { return tokenListBinding(this, 1, arguments.length).contains(`${token}`); }
  add(...tokens) {
    const binding = tokenListBinding(this);
    for (let index = 0; index < tokens.length; index++) tokens[index] = `${tokens[index]}`;
    binding.add(tokens);
  }
  remove(...tokens) {
    const binding = tokenListBinding(this);
    for (let index = 0; index < tokens.length; index++) tokens[index] = `${tokens[index]}`;
    binding.remove(tokens);
  }
  toggle(token, force = undefined) {
    return tokenListBinding(this, 1, arguments.length).toggle(`${token}`, force === undefined ? undefined : Boolean(force));
  }
  replace(oldToken, newToken) {
    return tokenListBinding(this, 2, arguments.length).replace(`${oldToken}`, `${newToken}`);
  }
  supports(token) { return tokenListBinding(this, 1, arguments.length).supports(`${token}`); }
  get value() { return tokenListBinding(this).getValue(); }
  set value(value) { tokenListBinding(this).setValue(`${value}`); }
  toString() { return tokenListBinding(this).getValue(); }
}

for (const name of Object.getOwnPropertyNames(DOMTokenList.prototype)) {
  if (name !== "constructor") Object.defineProperty(DOMTokenList.prototype, name, { enumerable: true });
}
for (const name of ["entries", "forEach", "keys", "values"]) {
  Object.defineProperty(DOMTokenList.prototype, name, {
    value: Array.prototype[name], writable: true, enumerable: true, configurable: true,
  });
}
Object.defineProperties(DOMTokenList.prototype, {
  [Symbol.iterator]: { value: Array.prototype.values, writable: true, enumerable: true, configurable: true },
  [Symbol.toStringTag]: { value: "DOMTokenList", configurable: true },
});

function tokenListIndex(property) {
  if (typeof property !== "string" || !MAP_INDEX.test(property)) return -1;
  const index = Number(property);
  return index < 0xffffffff ? index : -1;
}

const tokenListTraps = {
  get(target, property, receiver) {
    const index = tokenListIndex(property);
    if (index >= 0) return tokenListBinding(target).item(index) ?? undefined;
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    const index = tokenListIndex(property);
    return index >= 0 ? index < tokenListBinding(target).length() : Reflect.has(target, property);
  },
  set(target, property, value, receiver) {
    if (tokenListIndex(property) >= 0) return true;
    return Reflect.set(target, property, value, receiver);
  },
  defineProperty(target, property, descriptor) {
    if (tokenListIndex(property) >= 0) return true;
    return Reflect.defineProperty(target, property, descriptor);
  },
  deleteProperty(target, property) {
    const index = tokenListIndex(property);
    return index >= 0 ? index >= tokenListBinding(target).length() : Reflect.deleteProperty(target, property);
  },
  ownKeys(target) {
    const count = tokenListBinding(target).length();
    return Array.from({ length: count }, (_, index) => String(index)).concat(Reflect.ownKeys(target));
  },
  getOwnPropertyDescriptor(target, property) {
    const index = tokenListIndex(property);
    if (index >= 0 && index < tokenListBinding(target).length()) {
      return { value: tokenListBinding(target).item(index), writable: false, enumerable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
  preventExtensions() { return false; },
};

function createTokenListObject(binding) {
  const target = Object.create(DOMTokenList.prototype);
  const list = new Proxy(target, tokenListTraps);
  tokenListBindings.set(target, binding);
  tokenListBindings.set(list, binding);
  return list;
}

const utf16Apply = Reflect.apply;
const utf16CharCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const utf16FromCharCode = String.fromCharCode;

// UTF16LE is deliberately not TextEncoder/TextDecoder: dataset property
// transport must distinguish every lone surrogate from U+FFFD.
function tokenInput(core, value) {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const unit = utf16CharCodeAt(value, index);
    bytes[index * 2] = unit;
    bytes[index * 2 + 1] = unit >>> 8;
  }
  return core.byteInput(bytes);
}

function tokenOutput(core, operation) {
  const bytes = core.outputBytes(operation);
  const length = bytes.length;
  let text = "";
  for (let offset = 0; offset < length; offset += 8192) {
    const count = Math.min(4096, (length - offset) / 2);
    const units = new Uint16Array(count);
    for (let index = 0; index < count; index += 1) {
      const at = offset + index * 2;
      units[index] = bytes[at] | bytes[at + 1] << 8;
    }
    // Reflect.apply reads array-like indices without an iterator or spread.
    // Primitive concatenation avoids any authored Array.prototype.join hook.
    text += utf16Apply(utf16FromCharCode, undefined, units);
  }
  return text;
}

// A DOMTokenList over the attribute `attributeName` (DOM). The core owns
// the token set (token_list_*): the ordered set parse, validation and the
// operations. The update steps set the attribute through the element's
// attribute-change path, which runs the mutation records, the custom
// element reactions and the style invalidation.
export function createTokenList(element, attributeName) {
  const update = (mode, tokens, force = TOKEN_FORCE_OMITTED) => {
    const { result, value } = element._domCore.tokenListUpdate(element._coreHandle, attributeName, mode, force, tokens);
    if (value !== null) element._transportSetAttribute(attributeName, value);
    return result;
  };
  return createTokenListObject({
    length: () => element._domCore.tokenListCount(element._coreHandle, attributeName),
    item: (index) => element._domCore.tokenListItem(element._coreHandle, attributeName, index),
    contains: (token) => element._domCore.tokenListContains(element._coreHandle, attributeName, token),
    add(tokens) { update(TOKEN_ADD, tokens); },
    remove(tokens) { update(TOKEN_REMOVE, tokens); },
    toggle: (token, force) => update(TOKEN_TOGGLE, [token], force === undefined ? TOKEN_FORCE_OMITTED : force ? 1 : 0),
    replace: (oldToken, newToken) => update(TOKEN_REPLACE, [oldToken, newToken]),
    supports: (token) => element._domCore.status("token_binding_supports", element._coreHandle,
      ...element._domCore.input(attributeName), ...element._domCore.input(token)) === 1,
    getValue: () => element.getAttribute(attributeName) ?? "",
    setValue: (value) => element.setAttribute(attributeName, value),
  });
}

export function createDataset(element) {
  const core = element._domCore;
  const name = (property) => {
    const input = tokenInput(core, String(property));
    core.status("dataset_binding_name", input[0], input[1]);
    return tokenOutput(core, "dataset_binding_name");
  };
  // The baseline has no ownKeys/has/getOwnPropertyDescriptor trap. Enumeration
  // therefore concerns only the ordinary target, never the data-* attributes.
  return new Proxy({}, createDatasetTrapsBinding({
    get: (_, property) => element.getAttribute(name(property)) ?? undefined,
    set(_, property, value) {
      element.setAttribute(name(property), value);
      return true;
    },
    deleteProperty(_, property) {
      element.removeAttribute(name(property));
      return true;
    },
  }));
}

// NamedNodeMap transports the core's attribute nodes. Native node handles
// provide identity across mutation, detachment, adoption and collection.
const mapElements = new WeakMap();
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAP_INDEX = /^(0|[1-9][0-9]*)$/;

export function attributeNodeCore(attribute) {
  const core = domCoreForWrapper(attribute);
  if (!core || core.nodeType(core.handleForWrapper(attribute)) !== 2) {
    throw new TypeError("The receiver is not an Attr.");
  }
  return core;
}

function attrAt(element, index) {
  return element._domCore.nodeHandle("attribute_node_at", element._coreHandle, index);
}

function attributeCount(element) {
  return element._domCore.attributeCount(element._coreHandle);
}

// The index of the first attribute whose qualified name is `name`, after
// ASCII lowercasing for an HTML element of an HTML document; -1 for none.
function attributeIndexByName(element, name) {
  let wanted = String(name);
  if (element.namespaceURI === HTML_NAMESPACE && element.ownerDocument?._xmlDocument === false) {
    wanted = wanted.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  }
  const count = attributeCount(element);
  for (let index = 0; index < count; index += 1) {
    if (element._domCore.attributeStringAt("attribute_name_at", element._coreHandle, index) === wanted) return index;
  }
  return -1;
}

function attributeIndexByNamespace(element, namespace, localName) {
  const space = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
  const local = String(localName);
  const count = attributeCount(element);
  for (let index = 0; index < count; index += 1) {
    const core = element._domCore;
    if ((core.attributeStringAt("attribute_namespace_at", element._coreHandle, index) || null) === space &&
      core.attributeStringAt("attribute_local_name_at", element._coreHandle, index) === local) return index;
  }
  return -1;
}

function detachAttr(element, attribute) {
  element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
  return attribute;
}

function mapElement(map) {
  const element = mapElements.get(map);
  if (!element) throw new TypeError("Illegal invocation");
  return element;
}

function setAttr(element, attribute) {
  const core = attributeNodeCore(attribute);
  if (core !== element._domCore) {
    throw new DOMException("The nodes belong to different DOM core instances", "WrongDocumentError");
  }
  return element._transportSetAttributeNode(attribute);
}

export class NamedNodeMap {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
  get length() { return attributeCount(mapElement(this)); }
  item(index) {
    const element = mapElement(this);
    const position = index >>> 0;
    return position < attributeCount(element) ? attrAt(element, position) : null;
  }
  getNamedItem(qualifiedName) {
    const element = mapElement(this);
    const index = attributeIndexByName(element, qualifiedName);
    return index < 0 ? null : attrAt(element, index);
  }
  getNamedItemNS(namespace, localName) {
    const element = mapElement(this);
    const index = attributeIndexByNamespace(element, namespace, localName);
    return index < 0 ? null : attrAt(element, index);
  }
  setNamedItem(attr) {
    return setAttr(mapElement(this), attr);
  }
  setNamedItemNS(attr) {
    return setAttr(mapElement(this), attr);
  }
  removeNamedItem(qualifiedName) {
    const element = mapElement(this);
    const index = attributeIndexByName(element, qualifiedName);
    if (index < 0) throw new DOMException(`No item with name '${qualifiedName}' was found.`, "NotFoundError");
    return detachAttr(element, attrAt(element, index));
  }
  removeNamedItemNS(namespace, localName) {
    const element = mapElement(this);
    const index = attributeIndexByNamespace(element, namespace, localName);
    if (index < 0) throw new DOMException(`No item with namespace '${namespace}' and local name '${localName}' was found.`, "NotFoundError");
    return detachAttr(element, attrAt(element, index));
  }
  *[Symbol.iterator]() {
    const element = mapElement(this);
    for (let index = 0; index < attributeCount(element); index += 1) yield attrAt(element, index);
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "NamedNodeMap", configurable: true });
  }
}

// The supported property names of a NamedNodeMap: its qualified names,
// without those with an ASCII upper case letter for an HTML element of an
// HTML document.
function mapNames(element) {
  const names = [];
  const lowerOnly = element.namespaceURI === HTML_NAMESPACE && element.ownerDocument?._xmlDocument === false;
  for (let index = 0; index < attributeCount(element); index += 1) {
    const name = element._domCore.attributeStringAt("attribute_name_at", element._coreHandle, index);
    if (!(lowerOnly && /[A-Z]/.test(name)) && !names.includes(name)) names.push(name);
  }
  return names;
}

const namedNodeMapTraps = {
  get(target, property, receiver) {
    if (typeof property === "string") {
      const element = mapElements.get(target);
      if (MAP_INDEX.test(property)) return NamedNodeMap.prototype.item.call(receiver, Number(property)) ?? undefined;
      if (!(property in target) && mapNames(element).includes(property)) {
        return NamedNodeMap.prototype.getNamedItem.call(receiver, property);
      }
    }
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    if (typeof property === "string") {
      const element = mapElements.get(target);
      if (MAP_INDEX.test(property)) return Number(property) < attributeCount(element);
      if (!(property in target) && mapNames(element).includes(property)) return true;
    }
    return Reflect.has(target, property);
  },
  set(target, property, value, receiver) {
    if (typeof property === "string" && MAP_INDEX.test(property)) return false;
    return Reflect.set(target, property, value, receiver);
  },
  defineProperty(target, property, descriptor) {
    if (typeof property === "string" && MAP_INDEX.test(property)) return false;
    return Reflect.defineProperty(target, property, descriptor);
  },
  ownKeys(target) {
    const element = mapElements.get(target);
    const keys = Array.from({ length: attributeCount(element) }, (_, index) => String(index));
    for (const name of mapNames(element)) if (!(name in target)) keys.push(name);
    return keys.concat(Reflect.ownKeys(target));
  },
  getOwnPropertyDescriptor(target, property) {
    if (typeof property === "string") {
      const element = mapElements.get(target);
      if (MAP_INDEX.test(property) && Number(property) < attributeCount(element)) {
        return { value: attrAt(element, Number(property)), writable: false, enumerable: true, configurable: true };
      }
      if (!(property in target) && mapNames(element).includes(property)) {
        return { value: attrAt(element, attributeIndexByName(element, property)), writable: false, enumerable: false, configurable: true };
      }
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
};

export function createNamedNodeMap(element) {
  const target = Object.create(NamedNodeMap.prototype);
  const map = new Proxy(target, namedNodeMapTraps);
  mapElements.set(target, element);
  mapElements.set(map, element);
  return map;
}
