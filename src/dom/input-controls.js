import { createEvent, dispatchEvent } from "./events.js";
import { documentScripts } from "./scripts.js";

// Only values with JavaScript identity (including nonnumeric direct selection
// assignments) live here. Numeric positions, dirty flags and strings live in core.
const identities = new WeakMap();
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
// HTML "set the selection range" ends: the core answers 2 when the
// selection APIs do not apply, 1 when the selection changed. A change
// queues one select event, as Chrome does.
function selectionChanged(node, result) {
  if (result === 2) {
    throw new DOMException("The input element's type does not support selection.", "InvalidStateError");
  }
  if (result !== 1) return;
  node._notifyMutation("selection");
  documentScripts(node.ownerDocument).queueTask(() => dispatchEvent(node, createEvent("select", { bubbles: true })));
}
export function controlSelectionQueued(node) {
  selectionChanged(node, 1);
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
  if (valueChanged) node._notifyMutation("property", undefined, null, true);
  else if (identityValue) node._notifyMutation("property");
  if (selectionChanged) node._notifyMutation("selection");
}
// The core set a text control's selection as setSelectionRange does (input
// run state 7): the select event follows.
export function controlSelectionSet(node) {
  dispatchEvent(node, createEvent("select", { bubbles: true }));
  node._notifyMutation("selection");
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
    const options = [...node.options];
    options.forEach((option, index) => {
      option.selected = Boolean(node._domCore.status("input_control_index_matches", index, normalized));
    });
  },
  value(node) {
    const source = status(node, "value_source");
    if (source === 1) return string(node, "value");
    if (source === 2) return node._value;
    if (source === 3 && status(node, "is_textarea")) return string(node, "value");
    const authored = node.getAttribute("value");
    if (typeof authored === "string") {
      return node._domCore.string("input_control_sanitize_value", node._coreHandle, ...node._domCore.input(authored));
    }
    if (authored !== null) return authored;
    // An option without a value attribute has its text (HTML option value).
    if (source === 3) return string(node, "option_text");
    // A checkbox or radio button without one has "on" (the default/on mode).
    const type = node.localName === "input" ? string(node, "type") : "";
    return type === "checkbox" || type === "radio" ? "on" : "";
  },
  setValue(node, value) {
    // A textarea's API value has CR LF and CR as LF.
    const normalized = status(node, "is_textarea") ? String(value).replace(/\r\n?/g, "\n") : String(value);
    if (status(node, "is_select")) {
      let state = 0;
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
      return;
    }
    // A realm value cannot be strictly equal to the normalized string even if
    // its truthiness/previous native bytes coincide with the normalized value.
    if (identities.get(node)?.has("_value")) status(node, "raw_set", 4, 0);
    if (status(node, "value_set", ...node._domCore.input(normalized))) {
      identities.get(node)?.delete("_value");
      identities.get(node)?.delete("_valueDirty");
      node._notifyMutation("property");
    }
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
    const source = status(node, "state_source", 0);
    return source === 2 ? node._checked : Boolean(source);
  },
  setChecked(node, value) {
    if (identities.get(node)?.has("_checked")) status(node, "raw_set", 1, 0);
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
  selected(node) {
    const source = status(node, "state_source", 1);
    return source === 2 ? node._selected : Boolean(source);
  },
  setSelected(node, value) {
    if (identities.get(node)?.has("_selected")) status(node, "raw_set", 3, 0);
    if (status(node, "selected_set", Boolean(value))) {
      identities.get(node)?.delete("_selected");
      identities.get(node)?.delete("_selectedDirty");
      node._notifyMutation("state", "selected");
    }
  },
  form(node) { return node._domCore.wrapperFor(status(node, "form")); },
  tabIndex(node) { return status(node, "tab_index"); },
  setTabIndex(node, value) { node.setAttribute("tabindex", String(Number(value))); },
  type(node) { return string(node, "type"); },
  setType(node, value) { node.setAttribute("type", String(value)); },
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
    const token = status(node, "direction");
    return token === 1 ? "forward" : token === 2 ? "backward" : "none";
  },
  setDirection(node, value) {
    const text = value === null ? "" : String(value);
    selectionChanged(node, status(node, "selection_field_set", 2, 0, ...node._domCore.input(text)));
  },
  // setSelectionRange(unsigned long start, unsigned long end, optional
  // DOMString direction).
  setSelectionRange(node, start, end, direction = undefined) {
    const startOffset = unsignedLong(start);
    const endOffset = unsignedLong(end);
    const text = direction === undefined ? "" : String(direction);
    selectionChanged(node, status(node, "selection_range_set", startOffset, endOffset, ...node._domCore.input(text)));
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
    const dirty = status(node, "raw_get", 4);
    status(node, "value_set", ...node._domCore.input(value));
    status(node, "raw_set", 4, dirty);
    identities.get(node)?.delete("_value");
  },
};
