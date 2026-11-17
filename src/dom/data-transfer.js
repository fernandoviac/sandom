// DataTransfer, DataTransferItemList and DataTransferItem (HTML §6.11.3
// to §6.11.5) over one drag data store: an ordered list of items, each a
// string of a type or a File. A DataTransfer that script constructs, or
// that a clipboard event carries, is in read/write mode. The core gives
// the type of a getData()/setData() format and whether a read takes the
// first URL (data_transfer_format: ASCII-case-insensitive, "text" names
// text/plain and "url" names text/uri-list).

import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { createFileList } from "./file-list.js";

const DATA_TRANSFER_FIRST_URL = layoutConstant("DATA_TRANSFER_FIRST_URL");
const CONSTRUCTION = Symbol("DataTransfer item construction");

function dataTransferFormat(format) {
  const input = sharedDomCore.input(String(format));
  const firstURL = sharedDomCore.status("data_transfer_format", ...input) === DATA_TRANSFER_FIRST_URL;
  return [sharedDomCore.outputString(), firstURL];
}

const asciiLowercase = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

// The drag data store: its items ({ kind, type, data } or { kind, type,
// file }), the item list's DataTransferItem of each, and the FileList of
// its file items, kept until they change.
class DataStore {
  items = [];
  wrappers = new Map();
  fileList = null;
  changed() {
    this.fileList = null;
  }
  stringIndex(type) {
    return this.items.findIndex((item) => item.kind === "string" && item.type === type);
  }
  remove(index) {
    const [item] = this.items.splice(index, 1);
    this.wrappers.delete(item);
    this.changed();
  }
}

const stores = new WeakMap();
const storeOf = (owner, interfaceName) => {
  const store = stores.get(owner);
  if (!store) throw new TypeError(`Illegal invocation: the receiver is not a ${interfaceName}`);
  return store;
};

export class SDDataTransferItem {
  #store;
  #item;
  // Default parameters keep the interface object's length 0 (Web IDL).
  constructor(token = undefined, store = null, item = null) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#store = store;
    this.#item = item;
  }
  // An item removed from its list is disabled: no kind and no type.
  get #live() {
    return this.#store.items.includes(this.#item);
  }
  get kind() {
    return this.#live ? this.#item.kind : "";
  }
  get type() {
    return this.#live ? this.#item.type : "";
  }
  getAsFile() {
    return this.#live && this.#item.kind === "file" ? this.#item.file : null;
  }
  getAsString(callback) {
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'getAsString' on 'DataTransferItem': 1 argument required, but only 0 present.");
    }
    if (callback !== null && typeof callback !== "function") {
      throw new TypeError("Failed to execute 'getAsString' on 'DataTransferItem': The callback provided as parameter 1 is not a function.");
    }
    if (callback === null || !this.#live || this.#item.kind !== "string") return;
    const data = this.#item.data;
    // HTML queues a task to call the callback with the data.
    setTimeout(() => callback(data), 0);
  }
}
Object.defineProperty(SDDataTransferItem.prototype, Symbol.toStringTag, { value: "DataTransferItem", configurable: true });

const itemOf = (store, item) => {
  if (!store.wrappers.has(item)) store.wrappers.set(item, new SDDataTransferItem(CONSTRUCTION, store, item));
  return store.wrappers.get(item);
};

// The indexed getter of DataTransferItemList (Web IDL "supported
// property indices": the items' indices, read only).
const ITEM_LIST_HANDLER = {
  get(target, property, receiver) {
    const index = typeof property === "string" ? itemIndex(property) : -1;
    if (index < 0) return Reflect.get(target, property, receiver);
    const store = stores.get(target);
    return index < store.items.length ? itemOf(store, store.items[index]) : undefined;
  },
  has(target, property) {
    const index = typeof property === "string" ? itemIndex(property) : -1;
    if (index < 0) return Reflect.has(target, property);
    return index < stores.get(target).items.length;
  },
  set(target, property, value, receiver) {
    if (typeof property === "string" && itemIndex(property) >= 0) return false;
    return Reflect.set(target, property, value, receiver);
  },
  defineProperty(target, property, descriptor) {
    if (typeof property === "string" && itemIndex(property) >= 0) return false;
    return Reflect.defineProperty(target, property, descriptor);
  },
  getOwnPropertyDescriptor(target, property) {
    const index = typeof property === "string" ? itemIndex(property) : -1;
    if (index < 0) return Reflect.getOwnPropertyDescriptor(target, property);
    const store = stores.get(target);
    if (index >= store.items.length) return undefined;
    return { value: itemOf(store, store.items[index]), writable: false, enumerable: true, configurable: true };
  },
  ownKeys(target) {
    const indices = stores.get(target).items.map((_, index) => String(index));
    return [...indices, ...Reflect.ownKeys(target)];
  },
};
// The array index that `property` names, or -1.
function itemIndex(property) {
  if (!/^(0|[1-9][0-9]*)$/.test(property)) return -1;
  const index = Number(property);
  return index < 2 ** 32 - 1 ? index : -1;
}

export class SDDataTransferItemList {
  constructor(token = undefined, store = null) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    stores.set(this, store);
    const list = new Proxy(this, ITEM_LIST_HANDLER);
    stores.set(list, store);
    return list;
  }
  get length() {
    return storeOf(this, "DataTransferItemList").items.length;
  }
  // add(data, type) adds a string of `type`; add(file) adds a File.
  add(data, type = undefined) {
    const store = storeOf(this, "DataTransferItemList");
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'add' on 'DataTransferItemList': 1 argument required, but only 0 present.");
    }
    let item;
    if (data instanceof File) {
      item = { kind: "file", type: asciiLowercase(data.type), file: data };
    } else {
      if (arguments.length < 2) {
        throw new TypeError("Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.");
      }
      const itemType = asciiLowercase(String(type));
      if (store.stringIndex(itemType) >= 0) {
        throw new DOMException(`Failed to execute 'add' on 'DataTransferItemList': An item already exists for type '${itemType}'.`, "NotSupportedError");
      }
      item = { kind: "string", type: itemType, data: String(data) };
    }
    store.items.push(item);
    store.changed();
    return itemOf(store, item);
  }
  remove(index) {
    const store = storeOf(this, "DataTransferItemList");
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'remove' on 'DataTransferItemList': 1 argument required, but only 0 present.");
    }
    const position = Number(index) >>> 0;
    if (position < store.items.length) store.remove(position);
  }
  clear() {
    const store = storeOf(this, "DataTransferItemList");
    store.items.splice(0).forEach((item) => store.wrappers.delete(item));
    store.changed();
  }
}
Object.defineProperty(SDDataTransferItemList.prototype, Symbol.toStringTag, { value: "DataTransferItemList", configurable: true });

export class SDDataTransfer {
  #store = new DataStore();
  #items = new SDDataTransferItemList(CONSTRUCTION, this.#store);
  get items() {
    return this.#items;
  }
  // The string items' types in order, then "Files" when a file item is
  // in the store.
  get types() {
    const types = this.#store.items.filter((item) => item.kind === "string").map((item) => item.type);
    if (this.#store.items.some((item) => item.kind === "file")) types.push("Files");
    return Object.freeze(types);
  }
  // The file items' Files: the same FileList until the items change.
  get files() {
    this.#store.fileList ??= createFileList(this.#store.items.filter((item) => item.kind === "file").map((item) => item.file));
    return this.#store.fileList;
  }
  getData(format) {
    const [type, firstURL] = dataTransferFormat(format);
    const data = this.#store.items[this.#store.stringIndex(type)]?.data ?? "";
    if (!firstURL) return data;
    return sharedDomCore.string("data_transfer_first_url", ...sharedDomCore.input(data));
  }
  setData(format, data) {
    const [type] = dataTransferFormat(format);
    const index = this.#store.stringIndex(type);
    if (index >= 0) this.#store.remove(index);
    this.#store.items.push({ kind: "string", type, data: String(data) });
    this.#store.changed();
  }
  // Without a format every string item goes; file items stay.
  clearData(format) {
    if (format === undefined) {
      for (let index = this.#store.items.length - 1; index >= 0; index--) {
        if (this.#store.items[index].kind === "string") this.#store.remove(index);
      }
      return;
    }
    const index = this.#store.stringIndex(dataTransferFormat(format)[0]);
    if (index >= 0) this.#store.remove(index);
  }
}
Object.defineProperty(SDDataTransfer.prototype, Symbol.toStringTag, { value: "DataTransfer", configurable: true });
