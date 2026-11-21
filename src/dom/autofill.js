// The host's autofill of form controls (design/autofill.md): the field
// list, the fill and the suggestion state.
// The core decides every rule (core/dom/autofill.watpart); this module
// converts the arguments, reads the core's records and runs the core's
// input run.
import { runInputActivation } from "./input-activation.js";
import { layoutConstant } from "../wasm/layout-table.js";

const INPUT_ACTIVATION_AUTOFILL = layoutConstant("INPUT_ACTIVATION_AUTOFILL");

// The field records of autofill_fields, by WAT name without the
// AUTOFILL_FIELD_ prefix.
const FIELD = Object.freeze(Object.fromEntries(["SIZE", "ELEMENT", "FORM", "NAME", "SECTION", "MODE", "CONTACT", "KEY",
  "FLAGS", "FLAG_AUTOFILLED", "FLAG_ANCHOR", "FLAG_SUGGESTIONS"].map((name) => [name, layoutConstant(`AUTOFILL_FIELD_${name}`)])));

function requireNode(operation, name, node) {
  if (typeof node?._coreHandle !== "bigint") throw new TypeError(`${operation}: ${name} must be a Sandom node, received ${String(node)}`);
  return node;
}

// The fillable controls and the anchors of the document of `root`, or of
// the fill group of `control`.
export function autofillFields(root, control = null) {
  requireNode("autofillFields", "root", root);
  if (control !== null) requireNode("autofillFields", "control", control);
  const core = root._domCore;
  const count = core.status("autofill_fields", root._coreHandle, control?._coreHandle ?? 0n);
  const fields = count === 0 ? null : core.output("autofill_fields");
  const output = fields?.pointer ?? 0;
  const view = fields?.memory();
  const records = [];
  // Decode before a wrapper lookup can reenter the core.
  for (let index = 0; index < count; index++) {
    const offset = output + index * FIELD.SIZE;
    const text = (field) => {
      const length = view.getUint32(offset + field + 4, true);
      return length === 0 ? null : view.memoryText(core.decoder, view.getUint32(offset + field, true), length);
    };
    records.push({
      element: view.getBigUint64(offset + FIELD.ELEMENT, true), form: view.getBigUint64(offset + FIELD.FORM, true),
      fieldName: text(FIELD.NAME) ?? "", section: text(FIELD.SECTION), mode: text(FIELD.MODE), contact: text(FIELD.CONTACT),
      key: text(FIELD.KEY), flags: view.getUint32(offset + FIELD.FLAGS, true),
    });
  }
  return records.map(({ element, form, flags, ...record }) => {
    const anchor = (flags & FIELD.FLAG_ANCHOR) !== 0;
    const node = core.wrapperFor(element);
    return Object.freeze({
      element: node, form: form === 0n ? null : core.wrapperFor(form), ...record,
      autofilled: (flags & FIELD.FLAG_AUTOFILLED) !== 0, suggestions: (flags & FIELD.FLAG_SUGGESTIONS) !== 0,
      anchor, value: anchor ? node.value : null,
    });
  });
}

// Fills the fill group of `control` with `values`: an object or a Map
// whose string keys are keys (the mode, the contact and the field name)
// and whose element keys name one control. The core decides which
// controls take which value and fires the events of the fill.
export function autofill(root, control, values) {
  requireNode("autofill", "root", root);
  requireNode("autofill", "control", control);
  if (values === null || typeof values !== "object") throw new TypeError(`autofill: values must be an object or a Map, received ${String(values)}`);
  // Convert every entry before the core holds the data: a conversion can
  // run script.
  const entries = (values instanceof Map ? [...values] : Object.entries(values)).map(([key, value]) =>
    [typeof key === "string" ? key : requireNode("autofill", "a key of values", key), String(value)]);
  const core = control._domCore;
  core.status("autofill_data_clear");
  for (const [key, value] of entries) {
    if (typeof key === "string") core.status("autofill_data_add", 0n, ...core.input(key), ...core.input(value));
    else core.status("autofill_data_add", key._coreHandle, 0, 0, ...core.input(value));
  }
  runInputActivation(control, INPUT_ACTIVATION_AUTOFILL);
  // The fill can move the document Selection to the focused control, as
  // the value setter does.
  control.ownerDocument?.getSelection()?._takeChange();
}

// Records whether the host has autofill suggestions for `control`. The
// accessibility snapshot gives the control the state autofillAvailable
// and hasPopup "menu" while it holds, as Chrome does.
export function autofillSuggestions(root, control, available) {
  requireNode("autofillSuggestions", "root", root);
  requireNode("autofillSuggestions", "control", control);
  if (control._domCore.status("autofill_suggestions_set", control._coreHandle, available ? 1 : 0)) {
    control._notifyMutation("state", "autofill");
  }
}