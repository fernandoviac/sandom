// Native semantics; host only reads language values and decodes immutable data.
// Nodes are the document, elements with an implicit or explicit role, and
// text runs (role "StaticText"). checked and pressed are true, false,
// "mixed", or null where the role has no such state; level is a heading's;
// modal is true for a modal dialog; required and invalid are the required
// and invalid states. autofillAvailable is true while the host has autofill
// suggestions for a control (core/dom/autofill.watpart); hasPopup is then
// "menu", as Chrome gives it, and "menu" too for a drop-down select. A
// password field's value is a bullet for each code point, as the field
// draws it. valueNow, valueMin and valueMax are a spinbutton's or slider's
// current value and range as numbers, or null where it has none;
// orientation is a slider's or a list box's "horizontal" or "vertical".
// multiselectable is true for a list box with multiple.
// posInSet and setSize are a radio button's position in its group, from 1,
// and the group's size, or null.
// A node Chrome exposes without a DOM node of its own (a text control's
// inner editor and its value, a menulist's popup, a list marker) is a part
// of its host element: its identifier is the host's with a suffix, and it
// is no action target.
import { layoutConstant } from "../wasm/layout-table.js";

// The records of geometry-accessibility.watpart, by WAT name without the
// ACCESSIBILITY_ prefix.
const ACCESSIBILITY = Object.freeze(Object.fromEntries([
  "RECORD_SIZE", "RECORD_NODE", "RECORD_PARENT", "RECORD_ROLE", "RECORD_NAME", "RECORD_VALUE", "RECORD_DESCRIPTION",
  "RECORD_FLAGS", "RECORD_ACTIONS", "RECORD_SELECTION_START", "RECORD_SELECTION_END", "RECORD_SELECTION_DIRECTION",
  "RECORD_LEVEL", "RECORD_X", "RECORD_Y", "RECORD_WIDTH", "RECORD_HEIGHT", "RECORD_PART", "RECORD_PARENT_PART",
  "RECORD_VALUE_NOW", "RECORD_VALUE_MIN", "RECORD_VALUE_MAX", "RECORD_POS_IN_SET", "RECORD_SET_SIZE",
  "STRING_POINTER", "STRING_LENGTH",
  "FLAG_DISABLED", "FLAG_CHECKED", "FLAG_SELECTED", "FLAG_FOCUSED", "FLAG_EXPANDED_PRESENT", "FLAG_EXPANDED",
  "FLAG_CHECKED_PRESENT", "FLAG_SELECTED_PRESENT", "FLAG_VALUE_PRESENT", "FLAG_SELECTION_PRESENT",
  "FLAG_DESCRIPTION_PRESENT", "FLAG_PRESSED_PRESENT", "FLAG_PRESSED", "FLAG_CHECKED_MIXED", "FLAG_PRESSED_MIXED", "FLAG_MODAL",
  "FLAG_REQUIRED", "FLAG_INVALID", "FLAG_AUTOFILL_AVAILABLE",
  "FLAG_VALUE_NOW_PRESENT", "FLAG_VALUE_MIN_PRESENT", "FLAG_VALUE_MAX_PRESENT", "FLAG_ORIENTATION_PRESENT", "FLAG_VERTICAL",
  "FLAG_HAS_POPUP_MENU", "FLAG_MULTISELECTABLE",
  "PART_KIND_MASK", "PART_LINE_SHIFT", "PART_EDITOR", "PART_TEXT", "PART_LINE_BREAK", "PART_POPUP", "PART_MARKER",
  "STATE_SIZE", "STATE_NODE", "STATE_VALUE", "STATE_TYPE", "STATE_BOOLEANS", "STATE_TAB_INDEX",
  "STATE_SELECTION_START", "STATE_SELECTION_END", "STATE_SELECTION_DIRECTION", "STATE_DISABLED", "STATE_CHECKED",
  "STATE_SELECTED", "STATE_FOCUSED",
].map((name) => [name, layoutConstant(`ACCESSIBILITY_${name}`)])));
// The selectionDirection keywords of the core's direction tokens.
const DIRECTIONS = new Map(["none", "forward", "backward"]
  .map((keyword) => [layoutConstant(`SELECTION_DIRECTION_${keyword.toUpperCase()}`), keyword]));
const DIRECTION_TOKENS = new Map([...DIRECTIONS].map(([token, keyword]) => [keyword, token]));
// The identifier suffix of each part kind; a text run and a line break
// also name their line.
const PART_NAMES = new Map([
  [ACCESSIBILITY.PART_EDITOR, "editor"],
  [ACCESSIBILITY.PART_TEXT, "text"],
  [ACCESSIBILITY.PART_LINE_BREAK, "line-break"],
  [ACCESSIBILITY.PART_POPUP, "popup"],
  [ACCESSIBILITY.PART_MARKER, "marker"],
]);
const partSuffix = (part) => {
  const kind = part & ACCESSIBILITY.PART_KIND_MASK;
  const line = part >>> ACCESSIBILITY.PART_LINE_SHIFT;
  return kind === ACCESSIBILITY.PART_TEXT || kind === ACCESSIBILITY.PART_LINE_BREAK
    ? `:${PART_NAMES.get(kind)}-${line}`
    : `:${PART_NAMES.get(kind) ?? ""}`;
};
const EMPTY_BYTES = new Uint8Array(0);
export function buildAccessibilitySnapshot({ root, presentedFrame, identify, documentRevision, interactionRevision, presentationRevision, accessibilityRevision }) {
  if (!presentedFrame || typeof identify !== "function") {
    throw new TypeError("Accessibility snapshots require a presented frame and identifier function");
  }
  const core = presentedFrame.geometryCore;
  // Read every potentially user-defined property before allocating transient
  // input: getters can reenter the DOM core and rotate its transient arena.
  const elements = [];
  for (let index = 0, count = core.status("geometry_count", presentedFrame.geometryHandle); index < count; index++) {
    const handle = core.status("geometry_node", presentedFrame.geometryHandle, index);
    if (handle === 0n) continue;
    const element = core.wrapperFor(handle);
    if (element?.nodeType === 1) elements.push(element);
  }
  const focusedElement = root.ownerDocument?._focusedElement ?? null;
  const states = elements.map((element) => {
    const value = element.value ?? "";
    return { element, value, type: element.type ?? "", flags: (element.disabled ? ACCESSIBILITY.STATE_DISABLED : 0) |
      (element.checked ? ACCESSIBILITY.STATE_CHECKED : 0) | (element.selected ? ACCESSIBILITY.STATE_SELECTED : 0) |
      (focusedElement === element ? ACCESSIBILITY.STATE_FOCUSED : 0), tabIndex: element.tabIndex,
      start: element.selectionStart ?? value.length, end: element.selectionEnd ?? value.length,
      direction: DIRECTION_TOKENS.get(element.selectionDirection ?? "none") };
  });
  // Most elements have no value and no type: their strings share one empty
  // encoding.
  const encode = (text) => text === "" ? EMPTY_BYTES : core.encoder.encode(String(text));
  const encoded = states.map((state) => ({ ...state, valueBytes: encode(state.value), typeBytes: encode(state.type) }));
  const stringsLength = encoded.reduce((length, state) => length + state.valueBytes.byteLength + state.typeBytes.byteLength, 0);
  const pointer = core.status("abi_allocate", states.length * ACCESSIBILITY.STATE_SIZE + stringsLength);
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  let cursor = pointer + states.length * ACCESSIBILITY.STATE_SIZE;
  // A borrowed string: its bytes go after the states, its pair into the state.
  const putString = (at, encodedBytes) => {
    view.setUint32(at + ACCESSIBILITY.STRING_POINTER, cursor, true);
    view.setUint32(at + ACCESSIBILITY.STRING_LENGTH, encodedBytes.byteLength, true);
    bytes.set(encodedBytes, cursor);
    cursor += encodedBytes.byteLength;
  };
  encoded.forEach((state, index) => {
    const offset = pointer + index * ACCESSIBILITY.STATE_SIZE;
    view.setBigUint64(offset + ACCESSIBILITY.STATE_NODE, state.element._coreHandle, true);
    putString(offset + ACCESSIBILITY.STATE_VALUE, state.valueBytes);
    putString(offset + ACCESSIBILITY.STATE_TYPE, state.typeBytes);
    view.setUint32(offset + ACCESSIBILITY.STATE_BOOLEANS, state.flags, true);
    view.setInt32(offset + ACCESSIBILITY.STATE_TAB_INDEX, state.tabIndex, true);
    view.setUint32(offset + ACCESSIBILITY.STATE_SELECTION_START, state.start, true);
    view.setUint32(offset + ACCESSIBILITY.STATE_SELECTION_END, state.end, true);
    view.setUint32(offset + ACCESSIBILITY.STATE_SELECTION_DIRECTION, state.direction, true);
  });
  const handle = core.status("geometry_accessibility_build", presentedFrame.geometryHandle, root._coreHandle, pointer, states.length);
  try {
    const count = core.status("geometry_accessibility_export", handle);
    const output = core.exports.abi_output_pointer();
    const memory = core.refreshBytes();
    const result = new DataView(memory.buffer);
    const decoded = [];
    // Decode before identify callbacks can reenter and grow native memory.
    for (let index = 0; index < count; index++) {
      const offset = output + index * ACCESSIBILITY.RECORD_SIZE;
      const word = (field) => result.getUint32(offset + field, true);
      const number = (field) => result.getFloat64(offset + field, true);
      const text = (field) => {
        const p = word(field + ACCESSIBILITY.STRING_POINTER);
        const length = word(field + ACCESSIBILITY.STRING_LENGTH);
        return core.decoder.decode(memory.subarray(p, p + length));
      };
      const flags = word(ACCESSIBILITY.RECORD_FLAGS);
      const flag = (name) => (flags & ACCESSIBILITY[`FLAG_${name}`]) !== 0;
      const actions = word(ACCESSIBILITY.RECORD_ACTIONS);
      decoded.push({
        node: result.getBigUint64(offset + ACCESSIBILITY.RECORD_NODE, true),
        parent: result.getBigUint64(offset + ACCESSIBILITY.RECORD_PARENT, true),
        part: word(ACCESSIBILITY.RECORD_PART), parentPart: word(ACCESSIBILITY.RECORD_PARENT_PART),
        role: text(ACCESSIBILITY.RECORD_ROLE), name: text(ACCESSIBILITY.RECORD_NAME),
        value: flag("VALUE_PRESENT") ? text(ACCESSIBILITY.RECORD_VALUE) : null,
        description: flag("DESCRIPTION_PRESENT") ? text(ACCESSIBILITY.RECORD_DESCRIPTION) : null,
        checked: flag("CHECKED_PRESENT") ? (flag("CHECKED_MIXED") ? "mixed" : flag("CHECKED")) : null,
        pressed: flag("PRESSED_PRESENT") ? (flag("PRESSED_MIXED") ? "mixed" : flag("PRESSED")) : null,
        selected: flag("SELECTED_PRESENT") ? flag("SELECTED") : null,
        expanded: flag("EXPANDED_PRESENT") ? flag("EXPANDED") : null,
        disabled: flag("DISABLED"), focused: flag("FOCUSED"), modal: flag("MODAL"),
        required: flag("REQUIRED"), invalid: flag("INVALID"),
        autofillAvailable: flag("AUTOFILL_AVAILABLE"),
        hasPopup: flag("AUTOFILL_AVAILABLE") || flag("HAS_POPUP_MENU") ? "menu" : null,
        multiselectable: flag("MULTISELECTABLE"),
        level: word(ACCESSIBILITY.RECORD_LEVEL) || null,
        valueNow: flag("VALUE_NOW_PRESENT") ? number(ACCESSIBILITY.RECORD_VALUE_NOW) : null,
        valueMin: flag("VALUE_MIN_PRESENT") ? number(ACCESSIBILITY.RECORD_VALUE_MIN) : null,
        valueMax: flag("VALUE_MAX_PRESENT") ? number(ACCESSIBILITY.RECORD_VALUE_MAX) : null,
        orientation: flag("ORIENTATION_PRESENT") ? (flag("VERTICAL") ? "vertical" : "horizontal") : null,
        posInSet: word(ACCESSIBILITY.RECORD_POS_IN_SET) || null,
        setSize: word(ACCESSIBILITY.RECORD_SET_SIZE) || null,
        selection: flag("SELECTION_PRESENT") ? Object.freeze({
          start: word(ACCESSIBILITY.RECORD_SELECTION_START), end: word(ACCESSIBILITY.RECORD_SELECTION_END),
          direction: DIRECTIONS.get(word(ACCESSIBILITY.RECORD_SELECTION_DIRECTION)),
        }) : null,
        bounds: Object.freeze({
          x: number(ACCESSIBILITY.RECORD_X), y: number(ACCESSIBILITY.RECORD_Y),
          width: number(ACCESSIBILITY.RECORD_WIDTH), height: number(ACCESSIBILITY.RECORD_HEIGHT),
        }),
        actions: Object.freeze(["focus", "press", "set-value", "selection", "increment", "decrement"].filter((_, bit) => actions & (1 << bit))) });
    }
    const nodeByIdentifier = new Map();
    const identifiers = new Map();
    for (const record of decoded) {
      if (record.part !== 0) continue;
      const element = core.wrapperFor(record.node);
      const identifier = identify(element);
      identifiers.set(record.node, identifier);
      nodeByIdentifier.set(String(identifier), element);
    }
    const identifierOf = (node, part) => part === 0 ? String(identifiers.get(node)) : `${identifiers.get(node)}${partSuffix(part)}`;
    // `nodeIdentifier`: the durable identifier of the DOM node the semantic
    // node is, or is a part of.
    const nodes = decoded.map(({ node, parent, part, parentPart, ...record }) => ({ ...record,
      identifier: identifierOf(node, part), nodeIdentifier: identifiers.get(node), parentIdentifier: parent === 0n ? null : identifierOf(parent, parentPart), childIdentifiers: [] }));
    const byIdentifier = new Map(nodes.map((node) => [node.identifier, node]));
    for (const node of nodes) if (node.parentIdentifier !== null) byIdentifier.get(node.parentIdentifier)?.childIdentifiers.push(node.identifier);
    const frozenNodes = nodes.map((node) => Object.freeze({ ...node, childIdentifiers: Object.freeze(node.childIdentifiers) }));
    return Object.freeze({ snapshot: Object.freeze({ kind: "sandom-accessibility-snapshot", version: 1,
      documentRevision, interactionRevision, presentationRevision, accessibilityRevision,
      rootIdentifier: frozenNodes.find((node) => node.parentIdentifier === null)?.identifier ?? null,
      nodes: Object.freeze(frozenNodes) }), nodeByIdentifier });
  } finally {
    core.status("geometry_accessibility_release", handle);
  }
}
