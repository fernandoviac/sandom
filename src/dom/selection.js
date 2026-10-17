import { installAbstractRangeBindings, installCaretPositionBindings, installRangeBindings, installSelectionBindings } from "./dom-bindings.generated.js";
import { parseHTMLFragment } from "./html.js";
import { parseXMLFragment } from "./xml.js";
import { geometryRangeRects } from "./geometry.js";
import { withLiveGeometry } from "./live-geometry.js";
import { executeActivationRun, scheduleFocusFixup } from "./input-activation.js";
import { withCustomElementReactions } from "./custom-elements.js";
// Language wrappers for native UTF-16 Range/Selection boundaries. Native
// records retain nodes independently of these wrappers and are generation checked.
const finalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("selection_release", handle))
  : null;

// The core yields complete input runs, not host-selected removal targets.
// Consume each run before acknowledging it; never keep a memory view across
// callback-record delivery or author code.
function runRangeMutation(record, mode, node = 0n) {
  const document = record._document;
  const core = record._core;
  document._assertMutationAllowed();
  return withCustomElementReactions(() => {
    const mutation = core.selectionStatus("range_mutation_begin", record._handle, mode, node);
    if (mutation === 0n) return 0n;
    try {
      while (core.selectionStatus("range_mutation_next", mutation)) {
        const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 16);
        const token = view.getBigUint64(0, true);
        const run = view.getBigUint64(8, true);
        try {
          document._dispatchCoreTreeRecords();
          executeActivationRun(core, run);
        } catch (error) {
          core.exports.input_run_release(run);
          // Preserve the host exception while acknowledging its failed run.
          core.exports.range_mutation_resume(mutation, token, 2);
          throw error;
        }
        core.selectionStatus("range_mutation_resume", mutation, token, 0);
      }
      return core.selectionStatus("range_mutation_result", mutation);
    } finally {
      try { document._dispatchCoreTreeRecords(); }
      finally { core.exports.range_mutation_release(mutation); }
    }
  }, core);
}

function requireBoundary(document, node, offset) {
  if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError("Range boundary must be a Node");
  }
  // The owner check precedes Number(offset), including user conversion hooks.
  document._domCore.selectionStatus("selection_boundary_validate", document._coreHandle, node._coreHandle, 0);
  const normalized = Number(offset);
  document._domCore.selectionStatus("selection_boundary_validate", document._coreHandle, node._coreHandle, normalized);
  return normalized;
}

export function compareBoundaryPoints(nodeA, offsetA, nodeB, offsetB) {
  return nodeA._domCore.selectionStatus("selection_compare", nodeA._coreHandle, offsetA, nodeB._coreHandle, offsetB);
}

class SelectionRecord {
  constructor(document, kind) {
    this._document = document;
    this._core = document._domCore;
    this._handle = this._core.handle("selection_create", document._coreHandle, kind);
    finalizer?.register(this, { core: this._core, handle: this._handle }, this);
  }
  _boundaries(ordered = false) {
    return this._core.selectionBoundaries(this._handle, ordered);
  }
  _set(operation, node = null, offset = 0, other = null, otherOffset = 0) {
    return this._core.selectionStatus("selection_set", this._handle, operation, node?._coreHandle ?? 0n, offset, other?._coreHandle ?? 0n, otherOffset);
  }
  _text() {
    return this._core.selectionSpans(this._handle).map(([node, start, end]) => node.data.slice(start, end)).join("");
  }
  _release() {
    finalizer?.unregister(this);
    this._core.status("selection_release", this._handle);
  }
}

export class SDAbstractRange extends SelectionRecord {
  _bindingStartContainer() { return this._boundaries()[0]; }
  _bindingStartOffset() { return this._boundaries()[1]; }
  _bindingEndContainer() { return this._boundaries()[2]; }
  _bindingEndOffset() { return this._boundaries()[3]; }
  _bindingCollapsed() {
    const [start, startOffset, end, endOffset] = this._boundaries();
    return start === end && startOffset === endOffset;
  }
}

export class SDRange extends SDAbstractRange {
  constructor(document) {
    if (document?.nodeType !== 9) throw new TypeError("Range requires a Document");
    super(document, 48);
  }
  _bindingCommonAncestorContainer() {
    return this._core.wrapperFor(this._core.handle("selection_common_ancestor", this._handle));
  }
  _bindingSetStart(node, offset) { this._set(1, node, requireBoundary(this._document, node, offset)); }
  _bindingSetEnd(node, offset) { this._set(2, node, requireBoundary(this._document, node, offset)); }
  _bindingSetStartBefore(node) { this._set(7, node); }
  _bindingSetStartAfter(node) { this._set(8, node); }
  _bindingSetEndBefore(node) { this._set(9, node); }
  _bindingSetEndAfter(node) { this._set(10, node); }
  _bindingCollapse(toStart = false) { this._set(toStart ? 3 : 4); }
  _bindingSelectNodeContents(node) { this._set(5, node); }
  _bindingCloneRange() {
    const clone = new SDRange(this._document);
    const [a, ao, b, bo] = this._boundaries();
    try { clone._set(0, a, ao, b, bo); } catch (error) { clone._release(); throw error; }
    return clone;
  }
  _bindingToString() { return this._text(); }
  _bindingGetClientRects() { return rangeRectangles(this, false); }
  _bindingGetBoundingClientRect() { return rangeRectangles(this, true); }
  // The Range members below run in the core (selection.watpart); the
  // bindings convert their arguments (WebIDL) and deliver the records.
  _bindingCompareBoundaryPoints(how, sourceRange) {
    const kind = (Number(how) >>> 0) & 0xffff;
    if (!(sourceRange instanceof SDRange)) throw new TypeError("Failed to execute 'compareBoundaryPoints' on 'Range': parameter 2 is not of type 'Range'.");
    return this._core.selectionStatus("range_compare_boundary_points", this._handle, kind, sourceRange._handle);
  }
  _bindingComparePoint(node, offset) {
    requireNode(node, "comparePoint");
    return this._core.selectionStatus("range_compare_point", this._handle, node._coreHandle, Number(offset) >>> 0, 0);
  }
  _bindingIsPointInRange(node, offset) {
    requireNode(node, "isPointInRange");
    return this._core.selectionStatus("range_compare_point", this._handle, node._coreHandle, Number(offset) >>> 0, 1) === 1;
  }
  _bindingIntersectsNode(node) {
    requireNode(node, "intersectsNode");
    return this._core.selectionStatus("range_intersects_node", this._handle, node._coreHandle) === 1;
  }
  _bindingSelectNode(node) {
    requireNode(node, "selectNode");
    this._core.selectionStatus("range_select_node", this._handle, node._coreHandle);
  }
  _bindingDetach() {}
  _bindingCloneContents() { return this._mutate(() => this._core.handle("range_clone_contents", this._handle)); }
  _bindingExtractContents() {
    const handle = runRangeMutation(this, 1);
    try { return this._core.wrapperFor(handle); }
    finally { this._core.status("node_release", handle); }
  }
  _bindingDeleteContents() { runRangeMutation(this, 2); }
  _bindingInsertNode(node) {
    requireNode(node, "insertNode");
    runRangeMutation(this, 3, node._coreHandle);
  }
  _bindingSurroundContents(newParent) {
    requireNode(newParent, "surroundContents");
    runRangeMutation(this, 4, newParent._coreHandle);
  }
  _bindingCreateContextualFragment(markup) {
    const element = this._mutate(() => this._core.handle("range_contextual_element", this._handle));
    const document = this._document;
    return document._xmlDocument ? parseXMLFragment(element, markup) : parseHTMLFragment(element, markup);
  }
  // A core operation that changes the tree: the records of the changes
  // reach the host even when it fails, and a node it made becomes a wrapper
  // that holds the core's creation reference.
  _mutate(operation) {
    this._document._assertMutationAllowed();
    let result;
    try {
      result = operation();
    } finally {
      this._document._dispatchCoreTreeRecords();
    }
    if (typeof result !== "bigint") return result;
    if (result === 0n) return null;
    const node = this._core.wrapperFor(result);
    this._core.status("node_release", result);
    return node;
  }
}

function requireNode(node, method) {
  if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError(`Failed to execute '${method}' on 'Range': parameter 1 is not of type 'Node'.`);
  }
}

// Range.getClientRects and getBoundingClientRect (CSSOM View) over a
// synchronous layout of the range's document with the text geometry of
// every laid-out text node: Chrome lays the document out for them, also
// its skipped contents. A document without a document element has no
// rendering.
function rangeRectangles(range, bounding) {
  const root = range._document.documentElement;
  if (root === null) {
    return bounding ? { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } : [];
  }
  return withLiveGeometry(root, root._resolvedLayoutOptions, ({ core, handle }) =>
    geometryRangeRects(core, handle, range, bounding), true);
}

// A caret position (CSSOM View, caretPositionFromPoint): a node and an
// offset in it, fixed when it is made.
export class SDCaretPosition {
  constructor(document, node, offset) {
    this._document = document;
    this._node = node;
    this._offset = offset;
  }
  _bindingOffsetNode() { return this._node; }
  _bindingOffset() { return this._offset; }
  // Blink's CaretPosition::getClientRect: the bounding rectangle of a
  // collapsed range at the position.
  _bindingGetClientRect() {
    const range = new SDRange(this._document);
    try {
      range._set(0, this._node, this._offset, this._node, this._offset);
      return rangeRectangles(range, true);
    } finally {
      range._release();
    }
  }
}

// Each public Selection member except removeAllRanges and empty updates
// layout in Chrome, so it runs the focus check (scheduleFocusFixup).
export class SDSelection extends SelectionRecord {
  constructor(document, onChange) {
    super(document, 49);
    this._onChange = onChange;
  }
  _layoutUpdate() { scheduleFocusFixup(this._document); }
  _bindingAnchorNode() { this._layoutUpdate(); return this._boundaries()[0]; }
  _bindingAnchorOffset() { this._layoutUpdate(); return this._boundaries()[1]; }
  _bindingFocusNode() { this._layoutUpdate(); return this._boundaries()[2]; }
  _bindingFocusOffset() { this._layoutUpdate(); return this._boundaries()[3]; }
  _bindingRangeCount() { this._layoutUpdate(); return this._boundaries()[0] === null ? 0 : 1; }
  _bindingIsCollapsed() {
    this._layoutUpdate();
    const [a, ao, b, bo] = this._boundaries();
    return a === null || (a === b && ao === bo);
  }
  _bindingType() { return this.rangeCount === 0 ? "None" : this.isCollapsed ? "Caret" : "Range"; }
  _orderedRange() {
    const boundaries = this._boundaries(true);
    if (boundaries === null) return null;
    const range = new SDRange(this._document);
    try { range._set(0, ...boundaries); } catch (error) { range._release(); throw error; }
    return range;
  }
  _setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    anchorOffset = requireBoundary(this._document, anchorNode, anchorOffset);
    focusOffset = requireBoundary(this._document, focusNode, focusOffset);
    const previous = this.focusNode ?? this.anchorNode;
    if (this._set(0, anchorNode, anchorOffset, focusNode, focusOffset)) {
      this._onChange(this.focusNode ?? previous);
    }
  }
  _bindingSetBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    this._layoutUpdate();
    this._setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }
  _bindingCollapse(node, offset = 0) {
    this._layoutUpdate();
    if (node === null) { this.removeAllRanges(); return; }
    this._setBaseAndExtent(node, offset, node, offset);
  }
  _bindingSetPosition(node, offset = 0) { this.collapse(node, offset); }
  _bindingExtend(node, offset = 0) {
    this._layoutUpdate();
    if (this.anchorNode === null) throw new DOMException("Selection has no range", "InvalidStateError");
    this._setBaseAndExtent(this.anchorNode, this.anchorOffset, node, offset);
  }
  _bindingSelectAllChildren(node) {
    this._layoutUpdate();
    requireBoundary(this._document, node, 0);
    this._setBaseAndExtent(node, 0, node, this._core.status("selection_boundary_length", node._coreHandle));
  }
  _bindingAddRange(range) {
    this._layoutUpdate();
    if (!(range instanceof SDRange)) throw new DOMException("Range belongs to another document", "WrongDocumentError");
    this._changed(() => this._core.selectionStatus("selection_add_range", this._handle, range._handle));
  }
  // Runs a core change of this selection and reports it at the new focus
  // (or the old one).
  _changed(operation) {
    const previous = this.focusNode ?? this.anchorNode;
    if (operation()) this._onChange(this.focusNode ?? previous);
  }
  _bindingGetRangeAt(index) {
    this._layoutUpdate();
    if (index !== 0 || this._boundaries()[0] === null) {
      throw new DOMException("Selection range does not exist", "IndexSizeError");
    }
    return this._orderedRange();
  }
  _bindingRemoveAllRanges() {
    const [anchor, , focus] = this._boundaries();
    if (this._set(6)) this._onChange(focus ?? anchor);
  }
  _bindingEmpty() { this.removeAllRanges(); }
  _bindingContainsNode(node, allowPartialContainment = false) {
    this._layoutUpdate();
    return this._core.selectionStatus("selection_contains", this._handle, node._coreHandle, Boolean(allowPartialContainment)) !== 0;
  }
  // The members below run in the core (selection.watpart).
  _bindingCollapseToStart() {
    this._layoutUpdate();
    this._changed(() => this._core.selectionStatus("selection_collapse_to", this._handle, 0));
  }
  _bindingCollapseToEnd() {
    this._layoutUpdate();
    this._changed(() => this._core.selectionStatus("selection_collapse_to", this._handle, 1));
  }
  _bindingRemoveRange(range) {
    this._layoutUpdate();
    if (!(range instanceof SDRange)) throw new TypeError("Failed to execute 'removeRange' on 'Selection': parameter 1 is not of type 'Range'.");
    this._changed(() => this._core.selectionStatus("selection_remove_range", this._handle, range._handle));
  }
  _bindingDeleteFromDocument() {
    this._layoutUpdate();
    this._changed(() => runRangeMutation(this, 5) !== 0n);
  }
  _bindingDirection() {
    this._layoutUpdate();
    return ["none", "forward", "backward"][this._core.selectionStatus("selection_direction", this._handle)];
  }
  _selectedSpans() {
    return this._core.selectionSpans(this._handle);
  }
  // A node removal in the core cleared this selection: report the change at
  // the node it had as focus (or anchor), once.
  _takeRemoval() {
    if (!this._core.status("selection_removal_take", this._handle)) return;
    const view = new DataView(this._core.refreshBytes().buffer);
    this._onChange(this._core.wrapperFor(view.getBigUint64(this._core.exports.abi_output_pointer(), true)));
  }
  _bindingToString() { this._layoutUpdate(); return this._text(); }
}

for (const [name, interfaceObject] of Object.entries({
  AbstractRange: SDAbstractRange, Range: SDRange, Selection: SDSelection, CaretPosition: SDCaretPosition,
})) {
  Object.defineProperty(interfaceObject.prototype, Symbol.toStringTag, { value: name, configurable: true });
}
installAbstractRangeBindings({}, SDAbstractRange.prototype);
installRangeBindings({}, SDRange.prototype);
installSelectionBindings({}, SDSelection.prototype);
installCaretPositionBindings({}, SDCaretPosition.prototype);
