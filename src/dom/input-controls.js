import { createEvent, dispatchEvent } from "./events.js";
import { documentScripts } from "./scripts.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { activationClock, emptyStepNumber, localNow, renderSurfaceOf } from "./local-time.js";
import { inputFiles, SDFileList, selectInputFiles } from "./file-list.js";

const SELECTION_FIELD_DIRECTION = layoutConstant("SELECTION_FIELD_DIRECTION");
const SELECTION_SET_NOT_APPLICABLE = layoutConstant("SELECTION_SET_NOT_APPLICABLE");
const CONTROL_RAW_CHECKED_DIRTY = layoutConstant("CONTROL_RAW_CHECKED_DIRTY");
const CONTROL_RAW_SELECTED_DIRTY = layoutConstant("CONTROL_RAW_SELECTED_DIRTY");
const CONTROL_RAW_VALUE_DIRTY = layoutConstant("CONTROL_RAW_VALUE_DIRTY");
const CONTROL_VALUE_CORE = layoutConstant("CONTROL_VALUE_CORE");
const CONTROL_VALUE_HOST = layoutConstant("CONTROL_VALUE_HOST");
const CONTROL_STATE_HOST = layoutConstant("CONTROL_STATE_HOST");
const RANGE_TEXT_INDEX_SIZE = layoutConstant("RANGE_TEXT_INDEX_SIZE");
const SELECTION_MODES = new Map(["select", "start", "end", "preserve"].map((name) =>
  [name, layoutConstant(`SELECTION_MODE_${name.toUpperCase()}`)]));
const NUMBER_STEP_CHANGED = layoutConstant("NUMBER_STEP_CHANGED");
const NUMBER_STEP_NOT_APPLICABLE = layoutConstant("NUMBER_STEP_NOT_APPLICABLE");
const NUMBER_STEP_ANY = layoutConstant("NUMBER_STEP_ANY");
const INPUT_SHOW_PICKER_IMMUTABLE = layoutConstant("INPUT_SHOW_PICKER_IMMUTABLE");
const INPUT_SHOW_PICKER_NO_ACTIVATION = layoutConstant("INPUT_SHOW_PICKER_NO_ACTIVATION");

// Only values with JavaScript identity (including nonnumeric direct selection
// assignments) live here. Numeric positions, dirty flags and strings live in core.
const identities = new WeakMap();
// Raised while a select's selectedIndex or value setter sets each option's
// selected: those setters ask their select for no reset (HTML §4.10.7).
let selectingEveryOption = 0;
function identityFields(node) {
  let fields = identities.get(node);
  if (!fields) identities.set(node, fields = new Map());
  return fields;
}
function status(node, operation, ...args) {
  return node._domCore.status(`input_control_${operation}`, node._coreHandle, ...args);
}
function string(node, operation) {
  return node._domCore.string(`input_control_${operation}`, node._coreHandle);
}
// WebIDL unsigned long (no [EnforceRange] or [Clamp]): ToNumber, then
// modulo 2^32. Unary + is ToNumber; it rejects a BigInt as WebIDL does.
function unsignedLong(value) {
  const number = +value;
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : 0;
}
// HTML "set the selection range" ends: the core answers not applicable
// when the selection APIs do not apply, else whether the selection
// changed. A change queues one select event, as Chrome does. The setter
// can also have moved the document Selection to the control.
function selectionChanged(node, result) {
  documentSelectionChanged(node);
  if (result === SELECTION_SET_NOT_APPLICABLE) {
    throw new DOMException("The input element's type does not support selection.", "InvalidStateError");
  }
  if (!result) return;
  node._notifyMutation("selection");
  documentScripts(node.ownerDocument).queueTask(() => dispatchEvent(node, createEvent("select", { bubbles: true })));
}
// The core keeps a change of the document Selection that a control setter
// made (selection_change_take); the Selection reports it.
function documentSelectionChanged(node) {
  node.ownerDocument?.getSelection()?._takeChange();
}
export function controlSelectionQueued(node) {
  selectionChanged(node, true);
}
export function copyControlIdentities(source, clone) {
  // Native node_clone has already copied portable state. These ordered public
  // reads/writes transport realm identities and preserve overridden descriptors.
  clone._value = source._value;
  clone._valueDirty = source._valueDirty;
  clone._checked = source._checked;
  clone._checkedDirty = source._checkedDirty;
  clone._selected = source._selected;
  clone._selectedDirty = source._selectedDirty;
  // Selection offsets and direction are portable core state that
  // node_clone has already copied.
}
// The other radio buttons of a radio button's group (HTML radio button
// group): inputs of type radio in the same tree, with the same form owner
// and the same non-empty name, compared case-sensitively, as in Chrome.
function radioGroupOthers(node) {
  if (node.localName !== "input" || string(node, "type") !== "radio") return [];
  const name = node.getAttribute("name");
  if (!name) return [];
  const root = node.getRootNode();
  if (root === node) return [];
  const form = status(node, "form");
  return Array.prototype.filter.call(root.querySelectorAll("input"), (other) =>
    other !== node && string(other, "type") === "radio" && other.getAttribute("name") === name &&
    status(other, "form") === form
  );
}
// The core set a text control's value as the user edits it, with its
// selection and direction none (input run state 6, the core invalidated a
// changed value's style). The realm identities of those fields no longer
// apply; a dropped value identity is a change the core cannot see.
export function controlValueEdited(node, valueChanged, selectionChanged) {
  const fields = identities.get(node);
  const identityValue = fields?.has("_value") ?? false;
  for (const field of ["_value", "_valueDirty"]) fields?.delete(field);
  if (valueChanged || identityValue) node._notifyMutation("property");
  if (selectionChanged) node._notifyMutation("selection");
}
// The core set a text control's selection as setSelectionRange does (input
// run state 7): the select event follows when the core says it is due.
export function controlSelectionSet(node, selectDue) {
  if (selectDue) dispatchEvent(node, createEvent("select", { bubbles: true }));
  node._notifyMutation("selection");
}
// The result of a core number operation that sets the value as the value
// setter does: an InvalidStateError where it does not apply, else the
// setter's mutation steps for a changed value.
function numberValueSet(node, result, member) {
  if (result === NUMBER_STEP_NOT_APPLICABLE) {
    throw new DOMException(`Failed to execute '${member}' on 'HTMLInputElement': it does not apply to this input type.`, "InvalidStateError");
  }
  if (result === NUMBER_STEP_ANY) {
    throw new DOMException(`Failed to execute '${member}' on 'HTMLInputElement': the step attribute is 'any'.`, "InvalidStateError");
  }
  if (result === NUMBER_STEP_CHANGED) {
    identities.get(node)?.delete("_value");
    identities.get(node)?.delete("_valueDirty");
    node._notifyMutation("property");
  }
  documentSelectionChanged(node);
}
export const inputControlRuntime = {
  options(node) {
    return status(node, "is_select") ? node.querySelectorAll("option") : undefined;
  },
  selectedIndex(node) {
    return status(node, "selected_index");
  },
  setSelectedIndex(node, value) {
    if (!status(node, "is_select")) return;
    const normalized = Number(value);
    // Iteration and each public setter remain host-observable, including partial
    // effects when a getter, iterator, setter or mutation callback throws.
    // The setter sets every option and asks for no reset.
    const options = [...node.options];
    selectingEveryOption++;
    try {
      options.forEach((option, index) => {
        option.selected = Boolean(node._domCore.status("input_control_index_matches", index, normalized));
      });
    } finally {
      selectingEveryOption--;
    }
    // The setter updates the selectedcontent elements whatever changed.
    status(node, "select_selected_content_mark");
    node._domCore.deliverSelectedContent();
  },
  value(node) {
    const source = status(node, "value_source");
    if (source === CONTROL_VALUE_CORE) return string(node, "value");
    if (source === CONTROL_VALUE_HOST) return node._value;
    const authored = node.getAttribute("value");
    if (typeof authored === "string") {
      return node._domCore.string("input_control_sanitize_value", node._coreHandle, ...node._domCore.input(authored));
    }
    if (authored !== null) return authored;
    return string(node, "missing_value");
  },
  setValue(node, value) {
    // input's and textarea's value are [LegacyNullToEmptyString] (HTML);
    // select's is a plain DOMString.
    const select = status(node, "is_select");
    const normalized = value === null && !select ? "" : String(value);
    if (select) {
      let state = 0;
      selectingEveryOption++;
      try {
        for (const option of node.options) {
          // Native response bit2 suppresses subsequent observable value reads.
          let decision = state;
          if (!state) {
            const other = option.value;
            if (typeof other === "string") {
              decision = node._domCore.status("input_control_value_matches",
                ...node._domCore.input(normalized), ...node._domCore.input(other), state);
            }
          }
          option.selected = Boolean(decision & 1);
          state = decision & 2;
        }
      } finally {
        selectingEveryOption--;
      }
      status(node, "select_selected_content_mark");
      node._domCore.deliverSelectedContent();
      return;
    }
    // A realm value cannot be strictly equal to the normalized string even if
    // its truthiness/previous native bytes coincide with the normalized value.
    if (identities.get(node)?.has("_value")) status(node, "raw_set", CONTROL_RAW_VALUE_DIRTY, 0);
    if (status(node, "value_set", ...node._domCore.input(normalized))) {
      identities.get(node)?.delete("_value");
      identities.get(node)?.delete("_valueDirty");
      node._notifyMutation("property");
    }
    documentSelectionChanged(node);
  },
  defaultValue(node) {
    return status(node, "is_textarea") ? node.textContent : node.getAttribute("value") ?? "";
  },
  setDefaultValue(node, value) {
    if (status(node, "is_textarea")) node.textContent = String(value);
    else node.setAttribute("value", String(value));
  },
  disabled(node) { return Boolean(status(node, "disabled")); },
  setDisabled(node, value) { node.toggleAttribute("disabled", Boolean(value)); },
  checked(node) {
    const source = status(node, "state_source");
    return source === CONTROL_STATE_HOST ? node._checked : Boolean(source);
  },
  setChecked(node, value) {
    if (identities.get(node)?.has("_checked")) status(node, "raw_set", CONTROL_RAW_CHECKED_DIRTY, 0);
    if (status(node, "checked_set", Boolean(value))) {
      identities.get(node)?.delete("_checked");
      identities.get(node)?.delete("_checkedDirty");
      node._notifyMutation("state", "checked");
    }
    // A radio button that is checked unchecks the others of its group.
    if (!value) return;
    for (const other of radioGroupOthers(node)) {
      if (inputControlRuntime.checked(other)) inputControlRuntime.setChecked(other, false);
    }
  },
  indeterminate(node) { return Boolean(status(node, "indeterminate")); },
  setIndeterminate(node, value) {
    if (status(node, "indeterminate_set", Boolean(value))) node._notifyMutation("state", "indeterminate");
  },
  // An option's selectedness: a value the wrapper holds with its host
  // identity, else the core's, which depends on the other options of its
  // select (input-controls.watpart $inputControlSelected).
  selected(node) {
    const fields = identities.get(node);
    if (fields?.has("_selected")) return fields.get("_selected");
    return Boolean(status(node, "selected"));
  },
  setSelected(node, value) {
    if (identities.get(node)?.has("_selected")) status(node, "raw_set", CONTROL_RAW_SELECTED_DIRTY, 0);
    if (status(node, "selected_set", (value ? 1 : 0) | (selectingEveryOption ? 2 : 0))) {
      identities.get(node)?.delete("_selected");
      identities.get(node)?.delete("_selectedDirty");
      node._notifyMutation("state", "selected");
      // The core's reset may have changed the other options of a select
      // without multiple; their wrappers drop any value they held.
      const select = node.closest("select");
      if (!selectingEveryOption && select && !select.multiple) {
        for (const option of select.options) {
          if (option === node) continue;
          identities.get(option)?.delete("_selected");
          identities.get(option)?.delete("_selectedDirty");
        }
      }
    }
    if (!selectingEveryOption) node._domCore.deliverSelectedContent();
  },
  form(node) { return node._domCore.wrapperFor(status(node, "form")); },
  tabIndex(node) { return status(node, "tab_index"); },
  setTabIndex(node, value) { node.setAttribute("tabindex", String(Number(value))); },
  type(node) { return string(node, "type"); },
  setType(node, value) { node.setAttribute("type", String(value)); },
  // valueAsNumber, valueAsDate, stepUp() and stepDown()
  // (core/dom/input-number.watpart, core/dom/input-date.watpart).
  valueAsNumber(node) { return status(node, "value_as_number"); },
  setValueAsNumber(node, value) {
    const number = +value;
    if (number === Infinity || number === -Infinity) {
      throw new TypeError(`Failed to set the 'valueAsNumber' property on 'HTMLInputElement': the value ${number} is not finite.`);
    }
    numberValueSet(node, status(node, "value_as_number_set", number), "valueAsNumber");
  },
  // valueAsDate gives a Date of the document's window, and takes a Date
  // of any realm (its [[DateValue]] slot, which Date.prototype.getTime
  // reads).
  valueAsDate(node) {
    const time = status(node, "value_as_date");
    if (Number.isNaN(time)) return null;
    const RealmDate = node.ownerDocument?.defaultView?.Date ?? Date;
    return new RealmDate(time);
  },
  setValueAsDate(node, value) {
    if (!status(node, "value_as_date_applies")) {
      throw new DOMException("Failed to set the 'valueAsDate' property on 'HTMLInputElement': This input element does not support Date values.", "InvalidStateError");
    }
    let time = NaN;
    if (value !== null) {
      try {
        time = Date.prototype.getTime.call(value);
      } catch {
        throw new TypeError("Failed to set the 'valueAsDate' property on 'HTMLInputElement': The provided value is not a Date.");
      }
    }
    numberValueSet(node, status(node, "value_as_date_set", time), "valueAsDate");
  },
  // files (src/dom/file-list.js): a file input's FileList, null for
  // another type. Setting takes a FileList; null, or another type, keeps
  // the files.
  files(node) { return inputFiles(node); },
  setFiles(node, value) {
    if (value === null) return;
    if (!(value instanceof SDFileList)) {
      throw new TypeError("Failed to set the 'files' property on 'HTMLInputElement': The provided value is not of type 'FileList'.");
    }
    if (node.type !== "file") return;
    selectInputFiles(node, value);
    // The label of the files changes with them.
    node._notifyMutation("property");
  },
  // An empty date or time input steps from today or now (local-time.js).
  stepUp(node, n = 1) { numberValueSet(node, status(node, "step", n | 0, 0, emptyStepNumber(node)), "stepUp"); },
  stepDown(node, n = 1) { numberValueSet(node, status(node, "step", n | 0, 1, emptyStepNumber(node)), "stepDown"); },
  // showPicker(): a date or time input opens its picker, a color input its
  // own (core/dom/date-picker.watpart), and a select its list, placed over
  // `geometry`, the live geometry of the current layout (node.js); the
  // picker shows today and now.
  showPicker(node, geometry = 0n) {
    const result = status(node, "show_picker", localNow(node.ownerDocument), activationClock(node), geometry);
    const name = node.localName === "select" ? "HTMLSelectElement" : "HTMLInputElement";
    if (result === INPUT_SHOW_PICKER_IMMUTABLE) {
      throw new DOMException(`Failed to execute 'showPicker' on '${name}': ${name}::showPicker() cannot be used on immutable controls.`, "InvalidStateError");
    }
    if (result === INPUT_SHOW_PICKER_NO_ACTIVATION) {
      throw new DOMException(`Failed to execute 'showPicker' on '${name}': ${name}::showPicker() requires a user gesture.`, "NotAllowedError");
    }
    // The picker, or the host's request for it, shows at the next frame.
    const surface = renderSurfaceOf(node);
    if (surface) {
      surface._dirty = true;
      surface._schedule();
    }
  },
  // selectionStart and selectionEnd: null when the selection APIs do not
  // apply to the control.
  selection(node, field) {
    return status(node, "selection_applies") ? status(node, "selection_get", field) : null;
  },
  // The setters take unsigned long? (null as 0).
  setSelection(node, field, value) {
    const offset = value === null || value === undefined ? 0 : unsignedLong(value);
    selectionChanged(node, status(node, "selection_field_set", field, offset, 0, 0));
  },
  direction(node) {
    if (!status(node, "selection_applies")) return null;
    return string(node, "direction");
  },
  setDirection(node, value) {
    const text = value === null ? "" : String(value);
    selectionChanged(node, status(node, "selection_field_set", SELECTION_FIELD_DIRECTION, 0, ...node._domCore.input(text)));
  },
  // setSelectionRange(unsigned long start, unsigned long end, optional
  // DOMString direction).
  setSelectionRange(node, start, end, direction = undefined) {
    const startOffset = unsignedLong(start);
    const endOffset = unsignedLong(end);
    const text = direction === undefined ? "" : String(direction);
    selectionChanged(node, status(node, "selection_range_set", startOffset, endOffset, ...node._domCore.input(text)));
  },
  // setRangeText(DOMString replacement) and setRangeText(DOMString
  // replacement, unsigned long start, unsigned long end, optional
  // SelectionMode selectMode = "preserve"): WebIDL overload resolution by
  // the argument count, then the conversions in argument order. The
  // binding passes the arguments after the replacement.
  setRangeText(node, replacement, rest) {
    if (rest.length === 1) throw new TypeError("setRangeText: 2 arguments match no overload.");
    const text = String(replacement);
    let start = 0;
    let end = 0;
    let mode = SELECTION_MODES.get("preserve");
    if (rest.length > 1) {
      start = unsignedLong(rest[0]);
      end = unsignedLong(rest[1]);
      if (rest[2] !== undefined) {
        const name = String(rest[2]);
        mode = SELECTION_MODES.get(name);
        if (mode === undefined) throw new TypeError(`setRangeText: "${name}" is not a SelectionMode.`);
      }
    }
    if (identities.get(node)?.has("_value")) status(node, "raw_set", CONTROL_RAW_VALUE_DIRTY, 0);
    const result = status(node, "range_text_set", ...node._domCore.input(text), start, end, mode, rest.length > 1 ? 1 : 0);
    if (result === RANGE_TEXT_INDEX_SIZE) {
      throw new DOMException("setRangeText: the start is after the end.", "IndexSizeError");
    }
    if (result !== SELECTION_SET_NOT_APPLICABLE) {
      identities.get(node)?.delete("_value");
      identities.get(node)?.delete("_valueDirty");
      node._notifyMutation("property");
    }
    selectionChanged(node, result);
  },
  raw(node, name, field) {
    const fields = identities.get(node);
    if (fields?.has(name)) return fields.get(name);
    return Boolean(status(node, "raw_get", field));
  },
  setRaw(node, name, field, value) {
    status(node, "raw_set", field, Boolean(value));
    if (typeof value === "boolean") identities.get(node)?.delete(name);
    else identityFields(node).set(name, value);
  },
  rawValue(node) {
    const fields = identities.get(node);
    if (fields?.has("_value")) return fields.get("_value");
    return node._domCore.nodeString("node_aux_a", node._coreHandle) ?? "";
  },
  setRawValue(node, value) {
    // Raw fields have no coercion or mutation callback. Preserve arbitrary host
    // identity, while string storage remains usable by direct native consumers.
    if (typeof value !== "string") {
      identityFields(node).set("_value", value);
      return;
    }
    const dirty = status(node, "raw_get", CONTROL_RAW_VALUE_DIRTY);
    status(node, "value_set", ...node._domCore.input(value));
    status(node, "raw_set", CONTROL_RAW_VALUE_DIRTY, dirty);
    identities.get(node)?.delete("_value");
    documentSelectionChanged(node);
  },
};
