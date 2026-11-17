// XMLHttpRequest's FormData(form, submitter), HTML's FormDataEvent and the
// host side of form submission. The DOM core constructs the entry list of
// a form (core/dom/constraint-validation.watpart, form_entry_list_begin);
// this host decodes its records into entries and fires the formdata event
// that the construction includes. For a submission, the core encodes the
// entries and plans the navigation (core/dom/form-submission.watpart); this
// host gives it the entries and runs the planned navigation's task.
import { layoutConstant } from "../wasm/layout-table.js";
import { decodeDomString } from "../dom-wasm/dom-string-transport.js";
import { createEventUsing, dispatchEvent, SDEvent } from "./events.js";
import { submissionValue } from "./form-submission-values.js";
import { documentCompletelyLoaded, documentScripts } from "./scripts.js";
import { navigateForForm } from "./component-environment.js";
import { nodeMember } from "./node-members.js";
import { inputFiles } from "./file-list.js";

const FORM_ENTRY_STRING = layoutConstant("FORM_ENTRY_STRING");
const FORM_ENTRY_FILE = layoutConstant("FORM_ENTRY_FILE");
const FORM_ENTRY_CUSTOM = layoutConstant("FORM_ENTRY_CUSTOM");
const FORM_ENTRY_HEADER = layoutConstant("FORM_ENTRY_HEADER");
const FORM_SUBMISSION_ENTRY_HEADER = layoutConstant("FORM_SUBMISSION_ENTRY_HEADER");
const NAVIGATION = Object.freeze(Object.fromEntries(["METHOD", "REPLACE", "URL", "TARGET", "CONTENT_TYPE", "SEGMENTS", "HEADER", "POST"]
  .map((name) => [name, layoutConstant(`FORM_NAVIGATION_${name}`)])));
const FORM_BODY_BYTES = layoutConstant("FORM_BODY_BYTES");
const FORM_BODY_FILE = layoutConstant("FORM_BODY_FILE");
const FORM_BODY_SEGMENT_HEADER = layoutConstant("FORM_BODY_SEGMENT_HEADER");
const HTML_NS = "http://www.w3.org/1999/xhtml";
const HostFormData = globalThis.FormData;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// HTML's FormDataEvent: the formdata event of a form whose entry list is
// being constructed.
export class FormDataEvent extends SDEvent {
  #formData;
  constructor(type, init) {
    if (arguments.length < 2 || init === null || typeof init !== "object" || !("formData" in init)) {
      throw new TypeError("Failed to construct 'FormDataEvent': required member formData is undefined.");
    }
    if (!(init.formData instanceof HostFormData)) {
      throw new TypeError("Failed to construct 'FormDataEvent': member formData is not of type 'FormData'.");
    }
    super(type, init);
    this.#formData = init.formData;
  }
  get formData() {
    return this.#formData;
  }
}
Object.defineProperty(FormDataEvent.prototype, "formData", { enumerable: true });
Object.defineProperty(FormDataEvent.prototype, Symbol.toStringTag, { configurable: true, value: "FormDataEvent" });

function isForm(value) {
  return typeof value === "object" && value !== null && value._domCore !== undefined &&
    nodeMember(value, "localName") === "form" && nodeMember(value, "namespaceURI") === HTML_NS;
}

// The entries of the core's records in the output of form_entry_list_begin.
// A form-associated custom element's record names the element; its entries
// come from its submission value (HTML "entry construction algorithm"): the
// entries of a FormData, or one entry with its name and the value.
function decodeEntries(core, count) {
  const pointer = core.exports.abi_output_pointer();
  const length = core.exports.abi_output_length();
  const bytes = new Uint8Array(core.refreshBytes().buffer, pointer, length).slice();
  const view = new DataView(bytes.buffer);
  const records = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    const kind = view.getUint32(at, true);
    const nameLength = view.getUint32(at + 4, true);
    const valueLength = view.getUint32(at + 8, true);
    at += FORM_ENTRY_HEADER;
    const name = decodeDomString(bytes.subarray(at, at + nameLength));
    at += nameLength;
    if (kind === FORM_ENTRY_CUSTOM) {
      records.push({ kind, name, element: view.getBigUint64(at, true), named: bytes[at + 8] === 1 });
    } else if (kind === FORM_ENTRY_FILE) {
      records.push({ kind, name, element: view.getBigUint64(at, true) });
    } else if (kind === FORM_ENTRY_STRING) {
      records.push({ kind, name, text: decodeDomString(bytes.subarray(at, at + valueLength)) });
    } else {
      throw new Error(`Unknown entry list record kind ${kind}`);
    }
    at += valueLength;
  }
  if (at !== length) throw new Error(`The entry list records end at byte ${at} of ${length}`);
  const entries = [];
  for (const record of records) {
    if (record.kind === FORM_ENTRY_STRING) entries.push([record.name, record.text]);
    else if (record.kind === FORM_ENTRY_FILE) {
      // HTML "constructing the entry list": each selected file, or one
      // empty file without a name when none is selected.
      const files = inputFiles(core.wrapperFor(record.element));
      if (files.length === 0) entries.push([record.name, new File([], "", { type: "application/octet-stream" })]);
      for (const file of files) entries.push([record.name, file]);
    } else {
      const value = submissionValue(core.wrapperFor(record.element));
      if (Array.isArray(value)) entries.push(...value);
      else if (value !== null && record.named) entries.push([record.name, value]);
    }
  }
  return entries;
}

// HTML "constructing the entry list" of `form` with `submitter`: the
// FormData that the formdata event's listeners saw, or null when the form
// is already constructing its entry list.
export function constructEntryList(form, submitter) {
  const core = form._domCore;
  const count = core.status("form_entry_list_begin", form._coreHandle, submitter === null ? 0n : submitter._coreHandle);
  if (count === -1) return null;
  try {
    const formData = new HostFormData();
    for (const [name, value] of decodeEntries(core, count)) formData.append(name, value);
    dispatchEvent(form, createEventUsing(FormDataEvent, "formdata", { bubbles: true, formData }));
    return formData;
  } finally {
    core.status("form_entry_list_end", form._coreHandle);
  }
}

// The entries that each form gave its submission last, by entry index: a
// planned navigation's body takes its files from them.
const submittedEntries = new WeakMap();

// Input effect 2 of a form submission: constructs the entry list of `form`
// with `submitter`, which fires the formdata event, and gives it to the
// core (form_submission_entries). A form already constructing its entry
// list gives none, and does not submit.
export function giveSubmissionEntries(form, submitter) {
  const formData = constructEntryList(form, submitter);
  if (formData === null) return;
  const entries = [...formData];
  const records = entries.map(([name, value]) => {
    const file = typeof value !== "string";
    return {
      file,
      name: encoder.encode(name),
      value: encoder.encode(file ? value.name : value),
      type: encoder.encode(file ? value.type : ""),
    };
  });
  const length = records.reduce((sum, record) =>
    sum + FORM_SUBMISSION_ENTRY_HEADER + record.name.length + record.value.length + record.type.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const record of records) {
    view.setUint32(at, record.file ? FORM_ENTRY_FILE : FORM_ENTRY_STRING, true);
    view.setUint32(at + 4, record.name.length, true);
    view.setUint32(at + 8, record.value.length, true);
    view.setUint32(at + 12, record.type.length, true);
    at += FORM_SUBMISSION_ENTRY_HEADER;
    for (const part of [record.name, record.value, record.type]) {
      bytes.set(part, at);
      at += part.length;
    }
  }
  const core = form._domCore;
  submittedEntries.set(form, entries);
  core.status("form_submission_entries", form._coreHandle, documentCompletelyLoaded(nodeMember(form, "ownerDocument")) ? 1 : 0,
    ...core.byteInput(bytes), entries.length);
}

// The request of form_navigation_claim's output, with the body of a POST
// request as a Blob of its segments.
function readNavigationRequest(core, entries) {
  const pointer = core.exports.abi_output_pointer();
  const length = core.exports.abi_output_length();
  const bytes = new Uint8Array(core.refreshBytes().buffer, pointer, length).slice();
  const view = new DataView(bytes.buffer);
  let at = NAVIGATION.HEADER;
  const text = (size) => decoder.decode(bytes.subarray(at, at += size));
  const url = text(view.getUint32(NAVIGATION.URL, true));
  const target = text(view.getUint32(NAVIGATION.TARGET, true));
  const contentType = text(view.getUint32(NAVIGATION.CONTENT_TYPE, true));
  const post = view.getUint32(NAVIGATION.METHOD, true) === NAVIGATION.POST;
  const parts = [];
  for (let index = 0; index < view.getUint32(NAVIGATION.SEGMENTS, true); index++) {
    const kind = view.getUint32(at, true);
    const word = view.getUint32(at + 4, true);
    at += FORM_BODY_SEGMENT_HEADER;
    if (kind === FORM_BODY_BYTES) {
      parts.push(bytes.subarray(at, at + word));
      at += word;
    } else if (kind === FORM_BODY_FILE) {
      parts.push(entries[word][1]);
    } else {
      throw new Error(`Unknown form body segment kind ${kind}`);
    }
  }
  if (at !== length) throw new Error(`The form navigation request ends at byte ${at} of ${length}`);
  return {
    kind: view.getUint32(NAVIGATION.REPLACE, true) === 1 ? "replace" : "assign",
    url,
    method: post ? "POST" : "GET",
    target,
    body: post ? new Blob(parts) : null,
    contentType: post ? contentType : null,
  };
}

// Input effect 6 of a form submission: queues the task of the form's
// planned navigation `token` (HTML "plan to navigate"). The task navigates
// unless a later submission of the form replaced it.
export function queueFormNavigation(form, token) {
  const entries = submittedEntries.get(form);
  submittedEntries.delete(form);
  documentScripts(nodeMember(form, "ownerDocument")).queueTask(() => {
    const core = form._domCore;
    if (!core.status("form_navigation_claim", form._coreHandle, token)) return;
    navigateForForm(nodeMember(form, "ownerDocument"), readNavigationRequest(core, entries));
  });
}

// FormData(optional HTMLFormElement form, optional HTMLElement? submitter
// = null).
export class FormData extends HostFormData {
  constructor(form = undefined, submitter = null) {
    super();
    if (form === undefined) return;
    if (!isForm(form)) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
    const by = submitter ?? null;
    if (by !== null) {
      const core = form._domCore;
      if (by?._domCore !== core || !core.status("input_control_submit_button", by._coreHandle)) {
        throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
      }
      if (core.handle("input_control_form", by._coreHandle) !== form._coreHandle) {
        throw new DOMException("Failed to construct 'FormData': The specified element is not owned by this form element.", "NotFoundError");
      }
    }
    const list = constructEntryList(form, by);
    if (list === null) {
      throw new DOMException("Failed to construct 'FormData': The form is already constructing its entry list.", "InvalidStateError");
    }
    for (const [name, value] of list) this.append(name, value);
  }
}
// Web IDL puts each FormData member on FormData.prototype: the interface
// object's prototype holds the host's FormData members, which work on
// these instances because the constructor builds a host FormData.
for (const key of Reflect.ownKeys(HostFormData.prototype)) {
  if (key === "constructor") continue;
  Object.defineProperty(FormData.prototype, key, Object.getOwnPropertyDescriptor(HostFormData.prototype, key));
}
// append() and set() have two overloads, (name, USVString value) and
// (name, Blob blobValue, optional USVString filename). With three
// arguments only the Blob overload applies, so a value that is not a Blob
// is a TypeError (Web IDL overload resolution). The host's members accept
// it, so these wrappers check it first.
for (const member of ["append", "set"]) {
  const host = HostFormData.prototype[member];
  Object.defineProperty(FormData.prototype, member, {
    value: {
      [member](name, value) {
        if (arguments.length > 2 && !(value instanceof Blob)) {
          throw new TypeError(`Failed to execute '${member}' on 'FormData': parameter 2 is not of type 'Blob'.`);
        }
        return Reflect.apply(host, this, arguments);
      },
    }[member],
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
