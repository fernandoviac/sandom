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

const HTML_NS = "http://www.w3.org/1999/xhtml";
const INDEX = /^(0|[1-9][0-9]*)$/;
const LISTED = "button,fieldset,input,object,output,select,textarea";
const LISTED_NAMES = new Set(LISTED.split(","));
const LABELABLE = "button,input,meter,output,progress,select,textarea";
const LABELABLE_NAMES = new Set(LABELABLE.split(","));
const ASCII_UPPER = /[A-Z]+/g;

const states = new WeakMap();
const caches = new WeakMap();

function cached(element, key, create) {
  let cache = caches.get(element);
  if (!cache) caches.set(element, cache = new Map());
  let value = cache.get(key);
  if (value === undefined) cache.set(key, value = create());
  return value;
}

function asciiLowercase(value) {
  return value.replace(ASCII_UPPER, (letters) => letters.toLowerCase());
}

function isHTML(element) {
  return element.namespaceURI === HTML_NS;
}

function formOwnerHandle(element) {
  return element._domCore.handle("input_control_form", element._coreHandle);
}

// A string as the content of a quoted CSS string.
function cssString(value) {
  return value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ")
    .replace(/\f/g, "\\c ").replace(/\0/g, "\uFFFD");
}

function query(root, selector) {
  return root._domCore.selectorQueryAll(root._coreHandle, selector);
}

// The elements of `root` (root excluded) whose id is `name`, or, for an HTML
// element, whose name attribute is `name`, in tree order.
function namedCandidates(root, name, selector = "") {
  const value = cssString(name);
  return query(root, `${selector}[id="${value}"],${selector}[name="${value}"]`).filter((element) =>
    element.getAttribute("id") === name || isHTML(element) && element.getAttribute("name") === name);
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
  get [Symbol.toStringTag]() {
    return "HTMLCollection";
  }
}

export class HTMLFormControlsCollection extends HTMLCollection {
  get [Symbol.toStringTag]() {
    return "HTMLFormControlsCollection";
  }
}

export class HTMLOptionsCollection extends HTMLCollection {
  get selectedIndex() {
    return stateOf(this).select.selectedIndex;
  }
  set selectedIndex(value) {
    stateOf(this).select.selectedIndex = value;
  }
  get [Symbol.toStringTag]() {
    return "HTMLOptionsCollection";
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
  get [Symbol.toStringTag]() {
    return "NodeList";
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
  get [Symbol.toStringTag]() {
    return "RadioNodeList";
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
// image buttons (HTML form.elements).
function formListedElements(form, root = form.getRootNode()) {
  const handle = form._coreHandle;
  return query(root, LISTED).filter((element) =>
    isHTML(element) && formOwnerHandle(element) === handle &&
    !(element.localName === "input" && element.type === "image"));
}

function isFormControl(form, element) {
  return LISTED_NAMES.has(element.localName) && isHTML(element) &&
    formOwnerHandle(element) === form._coreHandle && !(element.localName === "input" && element.type === "image");
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
      if (name === "") return null;
      const matches = namedCandidates(form.getRootNode(), name).filter((element) => isFormControl(form, element));
      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      return radioNodeList(form, `controls ${name}`, () => items().filter((element) => matchesName(element, name)));
    };
    return liveCollection(HTMLFormControlsCollection.prototype, { items, named });
  });
}

// The img elements whose form owner is the form: an img has its nearest
// ancestor form.
function formImages(form, name) {
  return namedCandidates(form.getRootNode(), name, "img").filter((image) =>
    isHTML(image) && image.parentElement?.closest("form") === form);
}

// Whether an element of `root` has the id or name `name`: one core walk
// with no result list, so a miss (the usual read of an absent property,
// also by Sandom's own code while it makes the form's wrapper) runs no
// selector query.
function hasNamedDescendant(root, name) {
  const core = root._domCore;
  return core.handle("node_collection_named", root._coreHandle, ...core.input("*"), 0, ...core.input(name)) !== 0n;
}

// HTML's named property of a form: its controls by id or name, else its
// images by id or name; a RadioNodeList when several match.
function formNamedProperty(form, name) {
  if (name === "" || !hasNamedDescendant(form.getRootNode(), name)) return undefined;
  const control = formElements(form).namedItem(name);
  if (control !== null) return control;
  const images = formImages(form, name);
  if (images.length === 0) return undefined;
  if (images.length === 1) return images[0];
  return radioNodeList(form, `images ${name}`, () => formImages(form, name));
}

// Indexed and named properties of a form or a select element, without a
// proxy around the element itself: an object between the class prototype
// and its parent answers the properties that no own property and no
// prototype has. The receiver is the element.
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

function reflectString(name) {
  return {
    get() {
      return this.getAttribute(name) ?? "";
    },
    set(value) {
      this.setAttribute(name, String(value));
    },
    configurable: true,
  };
}

function reflectBoolean(name) {
  return {
    get() {
      return this.hasAttribute(name);
    },
    set(value) {
      this.toggleAttribute(name, Boolean(value));
    },
    configurable: true,
  };
}

// An enumerated attribute: the keyword in ASCII lower case, else the
// invalid-value default, else (no attribute) the missing-value default.
function reflectEnumerated(name, keywords, missing, invalid = missing) {
  return {
    get() {
      const value = this.getAttribute(name);
      if (value === null) return missing;
      const keyword = asciiLowercase(value);
      return keywords.includes(keyword) ? keyword : invalid;
    },
    set(value) {
      this.setAttribute(name, String(value));
    },
    configurable: true,
  };
}

// HTML's rules for parsing non-negative integers; null for an error.
function parseNonNegative(value) {
  const match = /^[\t\n\f\r ]*([+-]?)([0-9]+)/.exec(value);
  if (!match) return null;
  const number = Number(match[2]);
  if (match[1] === "-" && number !== 0) return null;
  return number > 2147483647 ? null : number;
}

// An unsigned long attribute; `positive` limits it to values above zero.
export function reflectUnsigned(name, fallback, positive = false) {
  return {
    get() {
      const value = this.getAttribute(name);
      const number = value === null ? null : parseNonNegative(value);
      if (number === null || positive && number === 0) return fallback;
      return number;
    },
    set(value) {
      let number = Number(value);
      number = Number.isFinite(number) ? ((Math.trunc(number) % 2 ** 32) + 2 ** 32) % 2 ** 32 : 0;
      if (number > 2147483647 || positive && number === 0) number = fallback;
      this.setAttribute(name, String(number));
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

function isLabelable(element) {
  return isHTML(element) && LABELABLE_NAMES.has(element.localName) &&
    !(element.localName === "input" && element.type === "hidden");
}

// The labeled control of a label: the element its for attribute names in
// its tree when that is labelable, else (no for attribute) its first
// labelable descendant.
function labelControl(label) {
  const target = label.getAttribute("for");
  if (target !== null) {
    if (target === "") return null;
    const root = label.getRootNode();
    const element = root.getAttribute?.("id") === target
      ? root
      : label._domCore.elementById(root._coreHandle, target);
    return element !== null && isLabelable(element) ? element : null;
  }
  return query(label, LABELABLE).find(isLabelable) ?? null;
}

// The labels of a labelable element: the label elements of its tree whose
// labeled control it is, in tree order. Null for a hidden input.
const labels = {
  get() {
    if (this.localName === "input" && this.type === "hidden") return null;
    return cached(this, "labels", () => liveCollection(NodeList.prototype, {
      items: () => query(this.getRootNode(), "label").filter((label) => isHTML(label) && labelControl(label) === this),
    }));
  },
  configurable: true,
};

// The output element's default value override (HTML output): undefined in
// the default mode.
const outputOverrides = new WeakMap();

// The list of options of a select. The core packs their handles; they are
// copied before wrapper construction can enter the core again.
function selectOptions(select) {
  const core = select._domCore;
  const count = core.status("input_control_options", select._coreHandle);
  if (count <= 0) return [];
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 8);
  const handles = Array.from({ length: count }, (_, index) => view.getBigUint64(index * 8, true));
  return handles.map((handle) => core.wrapperFor(handle));
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
    action: {
      get() {
        const value = this.getAttribute("action");
        const document = this.ownerDocument;
        if (value === null || value === "") return document.URL;
        return URL.parse(value, document.baseURI)?.href ?? value;
      },
      set(value) {
        this.setAttribute("action", String(value));
      },
      configurable: true,
    },
    method: reflectEnumerated("method", ["get", "post", "dialog"], "get"),
    enctype: reflectEnumerated("enctype", ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"], "application/x-www-form-urlencoded"),
    encoding: reflectEnumerated("enctype", ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"], "application/x-www-form-urlencoded"),
    autocomplete: reflectEnumerated("autocomplete", ["on", "off"], "on"),
    target: reflectString("target"),
    acceptCharset: reflectString("accept-charset"),
    rel: reflectString("rel"),
    relList: reflectTokenList("rel"),
    noValidate: reflectBoolean("novalidate"),
  });
  installElementProperties(SDHTMLFormElement.prototype, (form, property) =>
    INDEX.test(property) ? formElements(form).item(Number(property)) ?? undefined : formNamedProperty(form, property));

  Object.defineProperty(SDHTMLInputElement.prototype, "labels", labels);
  Object.defineProperty(SDHTMLInputElement.prototype, "placeholder", reflectString("placeholder"));

  Object.defineProperties(SDHTMLButtonElement.prototype, {
    type: reflectEnumerated("type", ["submit", "reset", "button"], "submit"),
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
    size: reflectUnsigned("size", 0),
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
    rows: reflectUnsigned("rows", 2, true),
    cols: reflectUnsigned("cols", 20, true),
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
        return cached(this, "elements", () =>
          htmlCollection(HTMLCollection.prototype, () => query(this, LISTED).filter(isHTML)));
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
