// The selected files of a file input (HTML §4.10.5.1.18) and FileList
// (File API §5.2). The core keeps each input's file names and a serial
// (core/dom/input-file.watpart); this file keeps the host's File objects
// in the FileList made for that serial. A list is current while its
// serial is the input's: a reset, an empty value or a type change in the
// core empties the selection, and the next read sees an empty list.

const CONSTRUCTION = Symbol("FileList construction");
const encoder = new TextEncoder();

// The selection each input's FileList was made for.
const selections = new WeakMap();
// The FileList that the host chooser's answer gives each input, while the
// answer runs (expectInputFiles).
const expected = new WeakMap();

export class SDFileList {
  #files;
  // Default parameters keep the interface object's length 0 (Web IDL).
  constructor(token = undefined, files = []) {
    if (token !== CONSTRUCTION) throw new TypeError("Illegal constructor");
    this.#files = Object.freeze([...files]);
    for (let index = 0; index < this.#files.length; index++) {
      Object.defineProperty(this, index, { value: this.#files[index], enumerable: true });
    }
    Object.preventExtensions(this);
  }
  get length() {
    return this.#files.length;
  }
  item(index) {
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'item' on 'FileList': 1 argument required, but only 0 present.");
    }
    return this.#files[Number(index) >>> 0] ?? null;
  }
  *[Symbol.iterator]() {
    yield* this.#files;
  }
  static [Symbol.hasInstance](value) {
    return typeof value === "object" && value !== null && #files in value;
  }
}
Object.defineProperty(SDFileList.prototype, Symbol.toStringTag, { value: "FileList", configurable: true });

// A FileList of `files`, File objects of the host.
export function createFileList(files) {
  for (const [index, file] of files.entries()) {
    if (!(file instanceof File)) {
      throw new TypeError(`The file list's entry ${index} is ${describe(file)}; expected a File`);
    }
  }
  return new SDFileList(CONSTRUCTION, files);
}

// The encoded name list of `files` (core/dom/input-file.watpart, the only
// reader): the count (u32, little-endian), then for each name its UTF-8
// byte length (u32) and its bytes.
export function encodeFileNames(files) {
  const names = [...files].map((file) => encoder.encode(file.name));
  const bytes = new Uint8Array(4 + names.reduce((total, name) => total + 4 + name.byteLength, 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, names.length, true);
  let at = 4;
  for (const name of names) {
    view.setUint32(at, name.byteLength, true);
    bytes.set(name, at + 4);
    at += 4 + name.byteLength;
  }
  return bytes;
}

function fileSerial(input) {
  return input._domCore.status("input_control_file_serial", input._coreHandle);
}

// The FileList of file input `input` (null for another type): the list
// made for its current selection, or an empty one.
export function inputFiles(input) {
  if (input.type !== "file") return null;
  const serial = fileSerial(input);
  const selection = selections.get(input);
  if (selection?.serial === serial) return selection.list;
  if (serial !== 0) {
    // The host chooser's answer made this selection in the core.
    const list = expected.get(input);
    if (!list) {
      throw new Error(`The file input's selection ${serial} has no FileList: a selection reached the core without its files`);
    }
    selections.set(input, { serial, list });
    return list;
  }
  const list = new SDFileList(CONSTRUCTION, []);
  selections.set(input, { serial: 0, list });
  return list;
}

// Makes `list` the selection of file input `input` (the files setter and
// the host's chooser), with no events. Returns the core's serial.
export function selectInputFiles(input, list) {
  const core = input._domCore;
  const serial = core.status("input_control_file_select", input._coreHandle, ...core.byteInput(encodeFileNames(list)));
  selections.set(input, { serial, list });
  return serial;
}

// `list` is the FileList of the selection that the core makes for file
// input `input` from the host chooser's answer, if it makes one: the
// events of that selection read it. Returns the function that ends the
// answer, binding the list to that selection.
export function expectInputFiles(input, list) {
  expected.set(input, list);
  return () => {
    inputFiles(input);
    expected.delete(input);
  };
}

function describe(value) {
  if (value === null) return "null";
  if (typeof value === "object") return value.constructor?.name ?? "an object";
  return typeof value;
}
