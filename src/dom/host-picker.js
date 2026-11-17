import { layoutConstant } from "../wasm/layout-table.js";
import { createFileList, encodeFileNames, expectInputFiles } from "./file-list.js";

// The host's pickers, a thin wrapper over the host pickers of
// core/dom/date-picker.watpart and core/dom/input-file.watpart. The core
// decides when a picker opens and whether the host draws it; this file
// gives the host the request and brings its answer back as user input.
//
// A host gives `backend.setPickers({ date, color, file })`, or null for
// none. `date(request)` draws the pickers of the date and time inputs
// (date, datetime-local, month, time, week), `color(request)` the colour
// well's; a kind without a function stays Sandom's. `file(request)` is
// the file input's chooser, which only the host can give: a file input
// activated without it stays as it was, and the document records the
// diagnostic "file-chooser-missing". After the frame in which a picker of
// the host's kind opens, its function receives:
//
//   { kind: "date" | "color", type, value, min, max, step,
//     list: [{ value, label }], rect, reply(value), cancel() }
//   { kind: "file", type: "file", accept, multiple, rect,
//     reply(files), cancel() }
//
// `rect` is the input's border box in the document's viewport, so the
// host can place its picker beside it. The host calls `reply(value)` once
// with a value string of the input's type ("2026-11-20", "09:30", a CSS
// colour; "" clears a date or time), or `cancel()`, at any later time.
// A reply that changes the value fires input and change, as a pick in
// Sandom's own picker does. A file chooser replies with an array of the
// host's File objects, one at most without `multiple`; a reply that
// changes the selected files fires input and change, and `cancel()` fires
// cancel (HTML §4.10.5.1.18). The input matches :open until the answer.
// A request for another input replaces the open one; an answer once the
// input's picker has closed throws.

const DATE = layoutConstant("HOST_PICKER_DATE");
const COLOR = layoutConstant("HOST_PICKER_COLOR");
const FILE = layoutConstant("HOST_PICKER_FILE");
const REPLY = layoutConstant("HOST_PICKER_REPLY");
const CANCEL = layoutConstant("HOST_PICKER_CANCEL");
const KIND_NAMES = Object.freeze({ date: DATE, color: COLOR, file: FILE });

// Gives `document`'s host pickers `pickers`, or none for null.
export function setDocumentPickers(document, pickers) {
  if (pickers !== null && (typeof pickers !== "object" || Array.isArray(pickers))) {
    throw new TypeError(`setPickers: pickers is ${describe(pickers)}; expected null or { date(request), color(request), file(request) }`);
  }
  let kinds = 0;
  for (const [name, picker] of Object.entries(pickers ?? {})) {
    if (!Object.hasOwn(KIND_NAMES, name)) {
      throw new TypeError(`setPickers: pickers has ${JSON.stringify(name)}; expected date, color or file`);
    }
    if (typeof picker !== "function") {
      throw new TypeError(`setPickers: pickers.${name} is ${describe(picker)}; expected a function of the request`);
    }
    kinds |= KIND_NAMES[name];
  }
  document._domCore.status("picker_host_set", document._coreHandle, kinds);
  document._hostPickers = pickers;
}

// Gives the host the picker request that the last frame of `document`
// showed, for the input under render surface root `root`, and records a
// file input activated without a chooser.
export function sendPickerRequest(document, root) {
  const core = document._domCore;
  recordMissingChooser(document, core.status("picker_host_missing", document._coreHandle));
  const pickers = document._hostPickers;
  if (!pickers) return;
  const handle = core.status("picker_host_take", document._coreHandle);
  if (handle === 0n) return;
  const input = core.wrapperFor(handle);
  const kind = input.type === "color" ? "color" : input.type === "file" ? "file" : "date";
  const commands = document._editingCommands;
  let answered = false;
  const answer = (name, code, value, shown) => {
    if (answered) throw new Error(`pickers.${kind}: ${name}: this request was already answered`);
    try {
      commands.pickerAnswer(root, input, code, value);
    } catch (error) {
      // The core's error, with the request and the value the host gave.
      const message = `pickers.${kind}: ${name}(${shown}) for a ${input.type} input: ${error.message}`;
      throw error instanceof DOMException ? new DOMException(message, error.name) : new error.constructor(message);
    }
    answered = true;
  };
  const rect = input.getBoundingClientRect();
  const frozenRect = Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const cancel = () => answer("cancel", CANCEL, "", "");
  if (kind === "file") {
    pickers.file(Object.freeze({
      kind,
      type: "file",
      accept: input.getAttribute("accept") ?? "",
      multiple: input.hasAttribute("multiple"),
      rect: frozenRect,
      reply(files) {
        if (!Array.isArray(files)) {
          throw new TypeError(`pickers.file: reply: the files are ${describe(files)}; expected an array of File`);
        }
        const list = createFileList(files);
        // The selection's events read input.files: the list is the
        // input's once the core makes the selection.
        const release = expectInputFiles(input, list);
        try {
          answer("reply", REPLY, encodeFileNames(list), `[${files.map((file) => JSON.stringify(file.name)).join(", ")}]`);
        } finally {
          release();
        }
      },
      cancel,
    }));
    return;
  }
  pickers[kind](Object.freeze({
    kind,
    type: input.type,
    value: input.value,
    min: input.getAttribute("min") ?? "",
    max: input.getAttribute("max") ?? "",
    step: input.getAttribute("step") ?? "",
    list: Object.freeze([...(input.list?.options ?? [])]
      .filter((option) => !option.disabled)
      .map((option) => Object.freeze({ value: option.value, label: option.label }))),
    rect: frozenRect,
    reply(value) {
      if (typeof value !== "string") {
        throw new TypeError(`pickers.${kind}: reply: the value is ${describe(value)}; expected a string`);
      }
      answer("reply", REPLY, value, JSON.stringify(value));
    },
    cancel,
  }));
}

// A file input activated without the host's chooser: one diagnostic for
// each input.
function recordMissingChooser(document, handle) {
  if (handle === 0n) return;
  const input = document._domCore.wrapperFor(handle);
  if (document._fileChooserDiagnostics.has(input)) return;
  const id = input.id;
  const element = `input${id ? `#${id}` : ""}[type=file]`;
  document._fileChooserDiagnostics.set(input, Object.freeze({
    code: "file-chooser-missing",
    severity: "warning",
    recoverable: true,
    message: `The user activated ${element}, and the host gives no file chooser, so no file can be chosen: ` +
      "give one with backend.setPickers({ file(request) })",
    owner: Object.freeze({ element }),
  }));
}

function describe(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}
