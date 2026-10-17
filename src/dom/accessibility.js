// Native semantics; host only reads language values and decodes immutable data.
// Nodes are the document, elements with an implicit or explicit role, and
// text runs (role "StaticText"). checked and pressed are true, false,
// "mixed", or null where the role has no such state; level is a heading's.
// A node Chrome exposes without a DOM node of its own (a text control's
// inner editor and its value, a menulist's popup, a list marker) is a part
// of its host element: its identifier is the host's with a suffix, and it
// is no action target.
const PART_NAMES = ["", "editor", "text", "line-break", "popup", "marker"];
const partSuffix = (part) => {
  const kind = part & 255;
  return kind === 2 || kind === 3 ? `:${PART_NAMES[kind]}-${part >>> 8}` : `:${PART_NAMES[kind]}`;
};
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
  const states = elements.map((element) => {
    const value = element.value ?? "";
    return { element, value, type: element.type ?? "", flags: (element.disabled ? 1 : 0) |
      (element.checked ? 2 : 0) | (element.selected ? 4 : 0) |
      (element.ownerDocument?._focusedElement === element ? 8 : 0), tabIndex: element.tabIndex,
      start: element.selectionStart ?? value.length, end: element.selectionEnd ?? value.length,
      direction: { none: 0, forward: 1, backward: 2 }[element.selectionDirection ?? "none"] };
  });
  const encoded = states.map((state) => ({ ...state, valueBytes: core.encoder.encode(String(state.value)), typeBytes: core.encoder.encode(String(state.type)) }));
  const stringsLength = encoded.reduce((length, state) => length + state.valueBytes.byteLength + state.typeBytes.byteLength, 0);
  const pointer = core.status("abi_allocate", states.length * 48 + stringsLength);
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  let cursor = pointer + states.length * 48;
  encoded.forEach((state, index) => {
    const offset = pointer + index * 48;
    view.setBigUint64(offset, state.element._coreHandle, true);
    view.setUint32(offset + 8, cursor, true);
    view.setUint32(offset + 12, state.valueBytes.byteLength, true);
    bytes.set(state.valueBytes, cursor); cursor += state.valueBytes.byteLength;
    view.setUint32(offset + 16, cursor, true);
    view.setUint32(offset + 20, state.typeBytes.byteLength, true);
    bytes.set(state.typeBytes, cursor); cursor += state.typeBytes.byteLength;
    view.setUint32(offset + 24, state.flags, true);
    view.setInt32(offset + 28, state.tabIndex, true);
    view.setUint32(offset + 32, state.start, true);
    view.setUint32(offset + 36, state.end, true);
    view.setUint32(offset + 40, state.direction, true);
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
      const offset = output + index * 128;
      const text = (field) => {
        const p = result.getUint32(offset + field, true);
        const length = result.getUint32(offset + field + 4, true);
        return core.decoder.decode(memory.subarray(p, p + length));
      };
      const flags = result.getUint32(offset + 48, true);
      const actions = result.getUint32(offset + 52, true);
      decoded.push({ node: result.getBigUint64(offset, true), parent: result.getBigUint64(offset + 8, true),
        part: result.getUint32(offset + 104, true), parentPart: result.getUint32(offset + 108, true),
        role: text(16), name: text(24), value: flags & 256 ? text(32) : null,
        description: flags & 1024 ? text(40) : null,
        checked: flags & 64 ? (flags & 8192 ? "mixed" : Boolean(flags & 2)) : null,
        pressed: flags & 2048 ? (flags & 16384 ? "mixed" : Boolean(flags & 4096)) : null,
        selected: flags & 128 ? Boolean(flags & 4) : null,
        expanded: flags & 16 ? Boolean(flags & 32) : null,
        disabled: Boolean(flags & 1), focused: Boolean(flags & 8),
        level: result.getUint32(offset + 68, true) || null,
        selection: flags & 512 ? Object.freeze({ start: result.getUint32(offset + 56, true), end: result.getUint32(offset + 60, true), direction: ["none", "forward", "backward"][result.getUint32(offset + 64, true)] }) : null,
        bounds: Object.freeze({ x: result.getFloat64(offset + 72, true), y: result.getFloat64(offset + 80, true), width: result.getFloat64(offset + 88, true), height: result.getFloat64(offset + 96, true) }),
        actions: Object.freeze(["focus", "press", "set-value", "selection"].filter((_, bit) => actions & (1 << bit))) });
    }
    const nodeByIdentifier = new Map();
    const identifiers = new Map();
    for (const record of decoded) {
      if (record.part !== 0) continue;
      const element = core.wrapperFor(record.node);
      const identifier = identify(element);
      identifiers.set(record.node, identifier);
      nodeByIdentifier.set(identifier, element);
    }
    const identifierOf = (node, part) => part === 0 ? identifiers.get(node) : `${identifiers.get(node)}${partSuffix(part)}`;
    const nodes = decoded.map(({ node, parent, part, parentPart, ...record }) => ({ ...record,
      identifier: identifierOf(node, part), parentIdentifier: parent === 0n ? null : identifierOf(parent, parentPart), childIdentifiers: [] }));
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
