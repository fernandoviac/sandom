// The form members that a script reads, as in Chrome 151
// (docs/design/dom-webassembly-core.md, "Images and forms"):
// `document.forms`, HTMLFormElement with its controls collection and its
// indexed and named properties, and the reading members of the form
// controls. Submission is in input-activation.js.
//
// Every collection here is live: it reads the tree at each access. The form
// owner of a control is the DOM core's (`input_control_form`); the list of
// options of a select is the DOM core's (`input_control_options`).
import { createTokenList } from "./node-collections.js";
import { decodeDomString } from "../dom-wasm/dom-string-transport.js";
import { formTargets, nodeMember } from "./node-members.js";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const INDEX = /^(0|[1-9][0-9]*)$/;

const states = new WeakMap();
const caches = new WeakMap();

function cached(element, key, create) {
  let cache = caches.get(element);
  if (!cache) caches.set(element, cache = new Map());
  let value = cache.get(key);
  if (value === undefined) cache.set(key, value = create());
  return value;
}

function isHTML(element) {
  return element.namespaceURI === HTML_NS;
}

function formOwnerHandle(element) {
  return element._domCore.handle("input_control_form", element._coreHandle);
}

function matchesName(element, name) {
  return element.getAttribute("id") === name || isHTML(element) && element.getAttribute("name") === name;
}

// The supported property names of a collection: for each element in order,
// its id and then, for an HTML element, its name attribute; no empty name,
// no duplicate.
function supportedNames(elements) {
  const names = new Set();
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) names.add(id);
    const name = isHTML(element) ? element.getAttribute("name") : null;
    if (name) names.add(name);
  }
  return [...names];
}

function stateOf(collection) {
  const state = states.get(collection);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

// The length and the item at an index of a collection state: its `count`
// and `at` when the source answers them without materializing every item
// (the core's child lists), else from `items()`.
function countOf(state) {
  return state.count ? state.count() : state.items().length;
}
function itemAt(state, index) {
  return state.at ? state.at(index) ?? undefined : state.items()[index];
}

function illegalConstructor() {
  throw new TypeError("Illegal constructor");
}

const collectionTraps = {
  get(target, property, receiver) {
    if (typeof property === "string") {
      const state = states.get(target);
      if (INDEX.test(property)) return itemAt(state, Number(property));
      if (state.named && !(property in target)) {
        const value = state.named(property);
        if (value !== null) return value;
      }
    }
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    if (typeof property === "string") {
      const state = states.get(target);
      if (INDEX.test(property)) return Number(property) < countOf(state);
      if (state.named && !(property in target) && state.named(property) !== null) return true;
    }
    return Reflect.has(target, property);
  },
  set(target, property, value, receiver) {
    if (typeof property === "string" && INDEX.test(property)) return false;
    return Reflect.set(target, property, value, receiver);
  },
  defineProperty(target, property, descriptor) {
    if (typeof property === "string" && INDEX.test(property)) return false;
    return Reflect.defineProperty(target, property, descriptor);
  },
  ownKeys(target) {
    const state = states.get(target);
    const count = countOf(state);
    const keys = Array.from({ length: count }, (_, index) => String(index));
    if (state.named) {
      for (const name of supportedNames(state.items())) {
        if (!INDEX.test(name) && !(name in target)) keys.push(name);
      }
    }
    return keys.concat(Reflect.ownKeys(target));
  },
  getOwnPropertyDescriptor(target, property) {
    if (typeof property === "string") {
      const state = states.get(target);
      if (INDEX.test(property)) {
        const value = itemAt(state, Number(property));
        return value === undefined ? undefined : { value, writable: false, enumerable: true, configurable: true };
      }
      if (state.named && !(property in target)) {
        const value = state.named(property);
        if (value !== null) return { value, writable: false, enumerable: false, configurable: true };
      }
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
};

// A live collection: `items()` gives its elements in order, `named(name)`
// its named property (null for none), or no `named` for a NodeList;
// `count()` and `at(index)` optionally answer length and index reads.
export function liveCollection(prototype, state) {
  const target = Object.create(prototype);
  const proxy = new Proxy(target, collectionTraps);
  states.set(target, state);
  states.set(proxy, state);
  return proxy;
}

export class HTMLCollection {
  constructor() {
    illegalConstructor();
  }
  get length() {
    return countOf(stateOf(this));
  }
  item(index) {
    return itemAt(stateOf(this), index >>> 0) ?? null;
  }
  namedItem(name) {
    return stateOf(this).named(String(name));
  }
  [Symbol.iterator]() {
    return stateOf(this).items()[Symbol.iterator]();
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "HTMLCollection", configurable: true });
  }
}

export class HTMLFormControlsCollection extends HTMLCollection {
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "HTMLFormControlsCollection", configurable: true });
  }
}

export class HTMLOptionsCollection extends HTMLCollection {
  get selectedIndex() {
    return stateOf(this).select.selectedIndex;
  }
  set selectedIndex(value) {
    stateOf(this).select.selectedIndex = value;
  }
  // HTML: add(element, before) inserts an option or optgroup into the
  // select before the node `before` names, or before the before-th option
  // when it is a number, or at the end.
  add(element, before = null) {
    const { select } = stateOf(this);
    if (!(element instanceof Object) || !isHTML(element) || !["option", "optgroup"].includes(element.localName)) {
      throw new TypeError("Failed to execute 'add': the element is not an option or an optgroup");
    }
    if (element.contains(select)) {
      throw new DOMException("Failed to execute 'add': the element is an ancestor of the select", "HierarchyRequestError");
    }
    let reference = null;
    if (before !== null && typeof before === "object") {
      if (!select.contains(before) || before === select) {
        throw new DOMException("Failed to execute 'add': the reference element is not in the select", "NotFoundError");
      }
      if (before === element) return;
      reference = before;
    } else if (before !== null) {
      reference = this.item(Number(before) | 0);
    }
    (reference === null ? select : reference.parentNode).insertBefore(element, reference);
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "HTMLOptionsCollection", configurable: true });
  }
}

export class NodeList {
  constructor() {
    illegalConstructor();
  }
  get length() {
    return countOf(stateOf(this));
  }
  item(index) {
    return itemAt(stateOf(this), index >>> 0) ?? null;
  }
  forEach(callback, thisArgument = undefined) {
    const items = stateOf(this).items();
    for (let index = 0; index < items.length; index += 1) {
      callback.call(thisArgument, items[index], index, this);
    }
  }
  entries() {
    return stateOf(this).items().entries();
  }
  keys() {
    return stateOf(this).items().keys();
  }
  values() {
    return stateOf(this).items().values();
  }
  [Symbol.iterator]() {
    return stateOf(this).items()[Symbol.iterator]();
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "NodeList", configurable: true });
  }
}

function isRadio(element) {
  return element.localName === "input" && isHTML(element) && element.type === "radio";
}

export class RadioNodeList extends NodeList {
  // The value of the first checked radio button of the list, else "".
  get value() {
    for (const element of stateOf(this).items()) {
      if (isRadio(element) && element.checked) return element.value;
    }
    return "";
  }
  // Checks the first radio button of the list whose value is the value.
  set value(value) {
    const wanted = String(value);
    for (const element of stateOf(this).items()) {
      if (isRadio(element) && element.value === wanted) {
        element.checked = true;
        return;
      }
    }
  }
  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "RadioNodeList", configurable: true });
  }
}

// The collection named property of HTMLCollection: the first element whose
// id or name is the name.
function firstNamed(items, name) {
  if (name === "") return null;
  return items().find((element) => matchesName(element, name)) ?? null;
}

function htmlCollection(prototype, items, extra = {}) {
  return liveCollection(prototype, { items, named: (name) => firstNamed(items, name), ...extra });
}

// The listed elements whose form owner is the form, in tree order, without
// image buttons (HTML form.elements; form_controls).
function formListedElements(form) {
  return form._domCore.statusNodes("form_controls", form._coreHandle);
}

// The form's controls with the id or name `name` (form_named_controls).
function formNamedControls(form, name) {
  const core = form._domCore;
  return core.statusNodes("form_named_controls", form._coreHandle, ...core.input(name));
}

// A live RadioNodeList over `items()`, the same object for each read of
// one key of its owner.
function radioNodeList(owner, key, items) {
  return cached(owner, key, () => liveCollection(RadioNodeList.prototype, { items }));
}

function formElements(form) {
  return cached(form, "elements", () => {
    const items = () => formListedElements(form);
    const named = (name) => {
      const matches = formNamedControls(form, name);
      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      return radioNodeList(form, `controls ${name}`, () => formNamedControls(form, name));
    };
    return liveCollection(HTMLFormControlsCollection.prototype, { items, named });
  });
}

// HTMLFormElement is a legacy platform object (Web IDL) with an indexed
// getter, its controls, and a named getter (HTML "the form element",
// form_named_item), with [LegacyOverrideBuiltIns] and
// [LegacyUnenumerableNamedProperties]: a named property comes before each
// property of the prototype chain. The wrapper of a form element is a
// proxy around the element object; the traps are Web IDL's
// [[GetOwnProperty]], [[DefineOwnProperty]], [[Delete]],
// [[PreventExtensions]] and [[OwnPropertyKeys]] of such an object.
//
// A property whose name starts with "_" is a Sandom internal of the node
// (design/constraint-validation.md, "Form named properties"): a named
// property does not shadow it when the element has it, and a script can
// always set or define it.
const FORM_NAMED_CANDIDATES = 0;
const FORM_NAMED_GETTER = 1;
const FORM_NAMED_SUPPORTED = 2;
const ARRAY_INDEX_END = 4294967295;

let formPrototype = null;
// Each form element object's wrapper; each wrapper's element object is in
// formTargets (node-members.js).
const formWrappers = new WeakMap();

function isArrayIndex(property) {
  return INDEX.test(property) && Number(property) < ARRAY_INDEX_END;
}

function isInternal(property) {
  return property.charCodeAt(0) === 95;
}

// The elements of form element `element` for `name` by `mode`
// (form_named_item).
function formNamedItems(element, name, mode) {
  const core = element._domCore;
  const count = core.status("form_named_item", element._coreHandle, ...core.input(name), mode);
  return core.outputNodes("form_named_item", count);
}

// The supported property indices of a form: its controls (form_controls).
function formIndexed(element, property) {
  const core = element._domCore;
  return core.statusNodes("form_controls", element._coreHandle)[Number(property)];
}

// Web IDL "named property visibility" without the supported property name
// check: the object has no own property of the name, and the name is not
// a Sandom internal that the element has.
function namedVisible(element, property) {
  return !Object.hasOwn(element, property) && !(isInternal(property) && property in element);
}

// The value of a visible named property of the form: one element, or a
// RadioNodeList of the candidates; undefined for none. Several controls
// give the RadioNodeList of form.elements for the name, as in Chrome.
function formNamed(form, element, property) {
  if (!namedVisible(element, property)) return undefined;
  const items = formNamedItems(element, property, FORM_NAMED_GETTER);
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  if (element._domCore.nodeString("node_local_name", items[0]._coreHandle) !== "img") {
    return radioNodeList(form, `controls ${property}`, () => formNamedControls(form, property));
  }
  return radioNodeList(form, `images ${property}`, () => formNamedItems(element, property, FORM_NAMED_CANDIDATES));
}

function isSupportedName(element, property) {
  const core = element._domCore;
  return core.status("form_named_item", element._coreHandle, ...core.input(property), FORM_NAMED_SUPPORTED) !== 0;
}

// The supported property names of a form (form_supported_property_names):
// each name as its byte length (u32) and its bytes.
function formSupportedNames(element) {
  const core = element._domCore;
  const count = core.status("form_supported_property_names", element._coreHandle);
  const bytes = count === 0 ? new Uint8Array(0) : core.outputBytes("form_supported_property_names");
  const view = new DataView(bytes.buffer);
  const names = [];
  for (let index = 0, at = 0; index < count; index += 1) {
    const size = view.getUint32(at, true);
    names.push(decodeDomString(bytes.subarray(at + 4, at + 4 + size)));
    at += 4 + size;
  }
  return names;
}

const formTraps = {
  get(element, property, receiver) {
    if (typeof property === "string") {
      const value = isArrayIndex(property)
        ? formIndexed(element, property)
        : formNamed(formWrappers.get(element), element, property);
      if (value !== undefined) return value;
    }
    return Reflect.get(element, property, receiver);
  },
  has(element, property) {
    if (typeof property === "string") {
      const value = isArrayIndex(property)
        ? formIndexed(element, property)
        : formNamed(formWrappers.get(element), element, property);
      if (value !== undefined) return true;
    }
    return Reflect.has(element, property);
  },
  getOwnPropertyDescriptor(element, property) {
    if (typeof property === "string") {
      if (isArrayIndex(property)) {
        const value = formIndexed(element, property);
        if (value !== undefined) return { value, writable: false, enumerable: true, configurable: true };
      } else {
        const value = formNamed(formWrappers.get(element), element, property);
        if (value !== undefined) return { value, writable: false, enumerable: false, configurable: true };
      }
    }
    return Reflect.getOwnPropertyDescriptor(element, property);
  },
  // A Sandom internal that the element does not have yet becomes its own
  // data property, without the named property check of [[Set]].
  set(element, property, value, receiver) {
    if (typeof property === "string" && isInternal(property) && !(property in element) &&
      receiver === formWrappers.get(element)) {
      return Reflect.defineProperty(element, property, { value, writable: true, enumerable: true, configurable: true });
    }
    return Reflect.set(element, property, value, receiver);
  },
  defineProperty(element, property, descriptor) {
    if (typeof property === "string") {
      if (isArrayIndex(property)) return false;
      if (!isInternal(property) && isSupportedName(element, property)) return false;
    }
    return Reflect.defineProperty(element, property, descriptor);
  },
  deleteProperty(element, property) {
    if (typeof property === "string") {
      if (isArrayIndex(property)) return formIndexed(element, property) === undefined;
      if (namedVisible(element, property) && isSupportedName(element, property)) return false;
    }
    return Reflect.deleteProperty(element, property);
  },
  preventExtensions() {
    return false;
  },
  ownKeys(element) {
    const core = element._domCore;
    const count = core.status("form_controls", element._coreHandle);
    const keys = new Set(Array.from({ length: count }, (_, index) => String(index)));
    for (const name of formSupportedNames(element)) {
      if (namedVisible(element, name)) keys.add(name);
    }
    for (const key of Reflect.ownKeys(element)) keys.add(key);
    return [...keys];
  },
};

// The wrapper of element object `element`: a form wrapper proxy for an
// HTML form element, else the object.
export function elementWrapper(element) {
  if (Object.getPrototypeOf(element) !== formPrototype) return element;
  const form = new Proxy(element, formTraps);
  formWrappers.set(element, form);
  formTargets.set(form, element);
  return form;
}

// Indexed properties of a select element, without a proxy around the
// element itself: an object between the class prototype and its parent
// answers the properties that no own property and no prototype has. The
// receiver is the element.
function installElementProperties(prototype, lookup) {
  const parent = Object.getPrototypeOf(prototype);
  const target = Object.create(parent);
  Object.setPrototypeOf(prototype, new Proxy(target, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(receiver, "_coreHandle") && !Reflect.has(target, property)) {
        return lookup(receiver, property);
      }
      return Reflect.get(target, property, receiver);
    },
  }));
}

// A reflected attribute; a form's controls can shadow the attribute
// methods of the form (node-members.js).
function reflectString(name) {
  return {
    get() {
      return nodeMember(this, "getAttribute").call(this, name) ?? "";
    },
    set(value) {
      nodeMember(this, "setAttribute").call(this, name, String(value));
    },
    configurable: true,
  };
}

// The autocomplete IDL attribute of input, select and textarea: the
// element's IDL-exposed autofill value (HTML "autofill processing model",
// core/dom/autofill.watpart); setting it sets the content attribute.
const autocomplete = {
  get() {
    return this._domCore.string("element_autofill_value", this._coreHandle);
  },
  set(value) {
    this.setAttribute("autocomplete", String(value));
  },
  configurable: true,
};

function reflectBoolean(name) {
  return {
    get() {
      return nodeMember(this, "hasAttribute").call(this, name);
    },
    set(value) {
      nodeMember(this, "toggleAttribute").call(this, name, Boolean(value));
    },
    configurable: true,
  };
}

// A DOMTokenList of an attribute, the same object for each read; setting
// the property sets its value ([PutForwards=value]).
function reflectTokenList(attribute) {
  return {
    get() {
      return cached(this, `tokens ${attribute}`, () => createTokenList(this, attribute));
    },
    set(value) {
      cached(this, `tokens ${attribute}`, () => createTokenList(this, attribute)).value = value;
    },
    configurable: true,
  };
}

// The labeled control of a label (label_control).
function labelControl(label) {
  return label._domCore.nodeHandle("label_control", label._coreHandle);
}

// The labels of a labelable element, in tree order (element_labels). Null
// for a hidden input.
const labels = {
  get() {
    const core = this._domCore;
    if (core.status("element_labels", this._coreHandle) < 0) return null;
    return cached(this, "labels", () => liveCollection(NodeList.prototype, {
      items: () => core.statusNodes("element_labels", this._coreHandle),
    }));
  },
  configurable: true,
};

// The labels NodeList of labelable element `element`.
export function elementLabels(element) {
  return labels.get.call(element);
}

// The suggestions source element of an input (input_control_list), or null.
const list = {
  get() {
    return this._domCore.nodeHandle("input_control_list", this._coreHandle);
  },
  configurable: true,
};

// The output element's default value override (HTML output): undefined in
// the default mode.
const outputOverrides = new WeakMap();

// The reset algorithm of an output element: its text becomes its default
// value, and its default value override goes away.
export function resetOutput(output) {
  const value = outputOverrides.get(output) ?? output.textContent;
  outputOverrides.delete(output);
  output.textContent = value;
}

// The list of options of a select (input_control_options).
function selectOptions(select) {
  return select._domCore.statusNodes("input_control_options", select._coreHandle);
}

export function installFormDomBindings({
  SDDocument, SDHTMLFormElement, SDHTMLInputElement, SDHTMLSelectElement, SDHTMLButtonElement,
  SDHTMLTextAreaElement, SDHTMLOptionElement, SDHTMLFieldSetElement, SDHTMLOutputElement, SDHTMLLabelElement,
}) {
  const controlValue = Object.getOwnPropertyDescriptor(SDHTMLInputElement.prototype, "value");

  Object.defineProperty(SDDocument.prototype, "forms", {
    get() {
      return cached(this, "forms", () => {
        const items = () => this._domCore.elementsByTagName(this._coreHandle, "form").filter(isHTML);
        return htmlCollection(HTMLCollection.prototype, items);
      });
    },
    configurable: true,
  });

  Object.defineProperties(SDHTMLFormElement.prototype, {
    elements: {
      get() {
        return formElements(this);
      },
      configurable: true,
    },
    length: {
      get() {
        return formElements(this).length;
      },
      configurable: true,
    },
    target: reflectString("target"),
    acceptCharset: reflectString("accept-charset"),
    rel: reflectString("rel"),
    noValidate: reflectBoolean("novalidate"),
  });
  formPrototype = SDHTMLFormElement.prototype;

  Object.defineProperty(SDHTMLInputElement.prototype, "labels", labels);
  Object.defineProperty(SDHTMLInputElement.prototype, "list", list);
  Object.defineProperty(SDHTMLInputElement.prototype, "placeholder", reflectString("placeholder"));
  Object.defineProperty(SDHTMLInputElement.prototype, "autocomplete", autocomplete);
  Object.defineProperty(SDHTMLSelectElement.prototype, "autocomplete", autocomplete);
  Object.defineProperty(SDHTMLTextAreaElement.prototype, "autocomplete", autocomplete);

  Object.defineProperties(SDHTMLButtonElement.prototype, {
    value: reflectString("value"),
    labels,
  });

  const options = (select) => cached(select, "options", () => {
    const items = () => selectOptions(select);
    return htmlCollection(HTMLOptionsCollection.prototype, items, { select });
  });
  Object.defineProperties(SDHTMLSelectElement.prototype, {
    type: {
      get() {
        return this.hasAttribute("multiple") ? "select-multiple" : "select-one";
      },
      configurable: true,
    },
    options: {
      get() {
        return options(this);
      },
      configurable: true,
    },
    length: {
      get() {
        return options(this).length;
      },
      configurable: true,
    },
    item: {
      value(index) {
        return options(this).item(index);
      },
      writable: true,
      configurable: true,
    },
    add: {
      value: function add(element, before = null) {
        options(this).add(element, before);
      },
      writable: true,
      configurable: true,
    },
    namedItem: {
      value(name) {
        return options(this).namedItem(name);
      },
      writable: true,
      configurable: true,
    },
    selectedOptions: {
      get() {
        return cached(this, "selectedOptions", () => {
          const items = () => [...options(this)].filter((option) => option.selected);
          return htmlCollection(HTMLCollection.prototype, items);
        });
      },
      configurable: true,
    },
    multiple: reflectBoolean("multiple"),
    labels,
  });
  installElementProperties(SDHTMLSelectElement.prototype, (select, property) =>
    INDEX.test(property) ? options(select).item(Number(property)) ?? undefined : undefined);

  Object.defineProperties(SDHTMLTextAreaElement.prototype, {
    type: {
      get() {
        return "textarea";
      },
      configurable: true,
    },
    textLength: {
      get() {
        return this.value.length;
      },
      configurable: true,
    },
    placeholder: reflectString("placeholder"),
    labels,
  });

  Object.defineProperties(SDHTMLOptionElement.prototype, {
    value: {
      get: controlValue.get,
      set(value) {
        this.setAttribute("value", String(value));
      },
      configurable: true,
    },
    text: {
      get() {
        return this._domCore.string("input_control_option_text", this._coreHandle);
      },
      set(value) {
        this.textContent = String(value);
      },
      configurable: true,
    },
    label: {
      get() {
        return this.getAttribute("label") ?? this.text;
      },
      set(value) {
        this.setAttribute("label", String(value));
      },
      configurable: true,
    },
    defaultSelected: reflectBoolean("selected"),
    index: {
      get() {
        const select = this.parentElement?.closest("select");
        if (!select) return 0;
        const index = [...options(select)].indexOf(this);
        return index < 0 ? 0 : index;
      },
      configurable: true,
    },
  });

  Object.defineProperties(SDHTMLFieldSetElement.prototype, {
    type: {
      get() {
        return "fieldset";
      },
      configurable: true,
    },
    disabled: reflectBoolean("disabled"),
    elements: {
      get() {
        return cached(this, "elements", () => htmlCollection(HTMLCollection.prototype,
          () => this._domCore.statusNodes("fieldset_elements", this._coreHandle)));
      },
      configurable: true,
    },
  });

  Object.defineProperties(SDHTMLOutputElement.prototype, {
    type: {
      get() {
        return "output";
      },
      configurable: true,
    },
    value: {
      get() {
        return this.textContent;
      },
      // The value mode: the default value stays what it was.
      set(value) {
        if (!outputOverrides.has(this)) outputOverrides.set(this, this.textContent);
        this.textContent = String(value);
      },
      configurable: true,
    },
    defaultValue: {
      get() {
        return outputOverrides.get(this) ?? this.textContent;
      },
      set(value) {
        if (outputOverrides.has(this)) outputOverrides.set(this, String(value));
        else this.textContent = String(value);
      },
      configurable: true,
    },
    htmlFor: reflectTokenList("for"),
    labels,
  });

  Object.defineProperties(SDHTMLLabelElement.prototype, {
    htmlFor: reflectString("for"),
    control: {
      get() {
        return labelControl(this);
      },
      configurable: true,
    },
    form: {
      get() {
        const control = labelControl(this);
        return control === null ? null : control._domCore.wrapperFor(formOwnerHandle(control));
      },
      configurable: true,
    },
  });
}
