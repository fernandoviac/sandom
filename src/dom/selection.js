import { installAbstractRangeBindings, installCaretPositionBindings, installRangeBindings, installSelectionBindings } from "./dom-bindings.generated.js";
import { parseHTMLFragment } from "./html.js";
import { parseXMLFragment } from "./xml.js";
import { geometryRangeRects } from "./geometry.js";
import { pagesOfNodes, withLiveGeometry } from "./live-geometry.js";
import { executeActivationRun, scheduleFocusFixup } from "./input-activation.js";
import { withCustomElementReactions } from "./custom-elements.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The codes that this file passes to WAT, by the names of their WAT
// globals.
const SELECTION_KIND_RANGE = layoutConstant("SELECTION_KIND_RANGE");
const SELECTION_KIND_SELECTION = layoutConstant("SELECTION_KIND_SELECTION");
const SELECTION_SET_BOTH = layoutConstant("SELECTION_SET_BOTH");
const SELECTION_SET_START = layoutConstant("SELECTION_SET_START");
const SELECTION_SET_END = layoutConstant("SELECTION_SET_END");
const SELECTION_COLLAPSE_START = layoutConstant("SELECTION_COLLAPSE_START");
const SELECTION_COLLAPSE_END = layoutConstant("SELECTION_COLLAPSE_END");
const SELECTION_SELECT_NODE_CONTENTS = layoutConstant("SELECTION_SELECT_NODE_CONTENTS");
const SELECTION_REMOVE = layoutConstant("SELECTION_REMOVE");
const INPUT_OUTCOME_DONE = layoutConstant("INPUT_OUTCOME_DONE");
const INPUT_OUTCOME_FAILED = layoutConstant("INPUT_OUTCOME_FAILED");
// The Selection.type keywords of the core's selection types.
const SELECTION_TYPES = new Map([["NONE", "None"], ["CARET", "Caret"], ["RANGE", "Range"]]
  .map(([name, keyword]) => [layoutConstant(`SELECTION_TYPE_${name}`), keyword]));
const SELECTION_SET_START_BEFORE = layoutConstant("SELECTION_SET_START_BEFORE");
const SELECTION_SET_START_AFTER = layoutConstant("SELECTION_SET_START_AFTER");
const SELECTION_SET_END_BEFORE = layoutConstant("SELECTION_SET_END_BEFORE");
const SELECTION_SET_END_AFTER = layoutConstant("SELECTION_SET_END_AFTER");
const RANGE_MUTATION_EXTRACT = layoutConstant("RANGE_MUTATION_EXTRACT");
const RANGE_MUTATION_DELETE = layoutConstant("RANGE_MUTATION_DELETE");
const RANGE_MUTATION_INSERT = layoutConstant("RANGE_MUTATION_INSERT");
const RANGE_MUTATION_SURROUND = layoutConstant("RANGE_MUTATION_SURROUND");
const RANGE_MUTATION_DELETE_FROM_DOCUMENT = layoutConstant("RANGE_MUTATION_DELETE_FROM_DOCUMENT");
const RANGE_MUTATION_STEP = Object.freeze(Object.fromEntries(["SIZE", "TOKEN", "RUN"]
  .map((name) => [name, layoutConstant(`RANGE_MUTATION_STEP_${name}`)])));
// Language wrappers for native UTF-16 Range/Selection boundaries. Native
// records retain nodes independently of these wrappers and are generation checked.
// A wrapper holds the wrapper of each other document that a boundary is in
// (`_boundaryDocuments`, DomCore.syncSelectionDocuments). A wrapper's record
// entry ({ reference, cancel }, DomCore.selectionRecords) is its finalizer's
// unregister token; the record is released once, by the finalizer, by
// `_release`, or by DomCore.releaseCollectedWrappers.
const finalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle, entry }) => {
    core.releaseSelectionRecord(handle, entry);
  })
  : null;

// The core yields complete input runs, not host-selected removal targets.
// Consume each run before acknowledging it; never keep a memory view across
// callback-record delivery or author code.
function runRangeMutation(record, mode, node = 0n) {
  const document = record._document;
  const core = record._core;
  return withCustomElementReactions(() => {
    const mutation = core.selectionStatus("range_mutation_begin", record._handle, mode, node);
    if (mutation === 0n) return 0n;
    try {
      while (core.selectionStatus("range_mutation_next", mutation)) {
        const view = core.output("range_mutation_next");
        const token = view.getBigUint64(RANGE_MUTATION_STEP.TOKEN, true);
        const run = view.getBigUint64(RANGE_MUTATION_STEP.RUN, true);
        try {
          document._dispatchCoreTreeRecords();
          executeActivationRun(core, run);
        } catch (error) {
          core.exports.input_run_release(run);
          // Preserve the host exception while acknowledging its failed run.
          core.exports.range_mutation_resume(mutation, token, INPUT_OUTCOME_FAILED);
          throw error;
        }
        core.selectionStatus("range_mutation_resume", mutation, token, INPUT_OUTCOME_DONE);
      }
      return core.selectionStatus("range_mutation_result", mutation);
    } finally {
      try { document._dispatchCoreTreeRecords(); }
      finally { core.exports.range_mutation_release(mutation); }
    }
  }, core);
}

// A boundary node and offset of a Range (`selection` null) or a Selection.
// A Range takes a node of any document of its core (DOM, "set the start or
// end"); a Selection takes only a node of its document, checked before
// Number(offset), including user conversion hooks.
function requireBoundary(core, selection, node, offset) {
  if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError("Range boundary must be a Node");
  }
  requireCore(core, node);
  const document = selection?._document._coreHandle ?? 0n;
  if (selection) core.selectionStatus("selection_boundary_validate", document, node._coreHandle, 0);
  const normalized = Number(offset);
  core.selectionStatus("selection_boundary_validate", document, node._coreHandle, normalized);
  return normalized;
}

// Node handles name nodes of one core only.
function requireCore(core, node) {
  if (node !== null && node._domCore !== core) {
    throw new DOMException("The nodes belong to different DOM core instances", "WrongDocumentError");
  }
}

export function compareBoundaryPoints(nodeA, offsetA, nodeB, offsetB) {
  return nodeA._domCore.selectionStatus("selection_compare", nodeA._coreHandle, offsetA, nodeB._coreHandle, offsetB);
}

class SelectionRecord {
  // A static range ($kind null) keeps its boundary points itself and has no
  // core record.
  constructor(document, kind) {
    this._document = document;
    this._core = document._domCore;
    // The registered highlights that hold this range: a change of its
    // boundary points repaints them (CSS Custom Highlight API 1 §5.1).
    this._highlightCount = 0;
    if (kind === null) {
      this._handle = null;
      return;
    }
    this._handle = this._core.handle("selection_create", document._coreHandle, kind);
    this._boundaryDocuments = null;
    const entry = { reference: new WeakRef(this), cancel: () => finalizer?.unregister(entry) };
    this._core.selectionRecords.set(this._handle, entry);
    finalizer?.register(this, { core: this._core, handle: this._handle, entry }, entry);
  }
  _boundaries(ordered = false) {
    return this._core.selectionBoundaries(this._handle, ordered);
  }
  _set(operation, node = null, offset = 0, other = null, otherOffset = 0) {
    requireCore(this._core, node);
    requireCore(this._core, other);
    const changed = this._core.selectionStatus("selection_set", this._handle, operation, node?._coreHandle ?? 0n, offset, other?._coreHandle ?? 0n, otherOffset);
    this._core.syncSelectionDocuments();
    if (this._highlightCount > 0) this._document._repaintHighlights();
    return changed;
  }
  _text() {
    return this._core.selectionSpans(this._handle).map(([node, start, end]) => node.data.slice(start, end)).join("");
  }
  _release() {
    const entry = this._core.selectionRecords.get(this._handle);
    entry?.cancel();
    this._core.releaseSelectionRecord(this._handle, entry);
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
    super(document, SELECTION_KIND_RANGE);
  }
  _bindingCommonAncestorContainer() {
    return this._core.wrapperFor(this._core.handle("selection_common_ancestor", this._handle));
  }
  _bindingSetStart(node, offset) { this._set(SELECTION_SET_START, node, requireBoundary(this._core, null, node, offset)); }
  _bindingSetEnd(node, offset) { this._set(SELECTION_SET_END, node, requireBoundary(this._core, null, node, offset)); }
  _bindingSetStartBefore(node) { this._set(SELECTION_SET_START_BEFORE, node); }
  _bindingSetStartAfter(node) { this._set(SELECTION_SET_START_AFTER, node); }
  _bindingSetEndBefore(node) { this._set(SELECTION_SET_END_BEFORE, node); }
  _bindingSetEndAfter(node) { this._set(SELECTION_SET_END_AFTER, node); }
  _bindingCollapse(toStart = false) { this._set(toStart ? SELECTION_COLLAPSE_START : SELECTION_COLLAPSE_END); }
  _bindingSelectNodeContents(node) { this._set(SELECTION_SELECT_NODE_CONTENTS, node); }
  _bindingCloneRange() {
    const clone = new SDRange(this._document);
    const [a, ao, b, bo] = this._boundaries();
    try { clone._set(SELECTION_SET_BOTH, a, ao, b, bo); } catch (error) { clone._release(); throw error; }
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
    return this._core.selectionStatus("range_compare_point", this._handle, node._coreHandle, Number(offset) >>> 0, false);
  }
  _bindingIsPointInRange(node, offset) {
    requireNode(node, "isPointInRange");
    return !!this._core.selectionStatus("range_compare_point", this._handle, node._coreHandle, Number(offset) >>> 0, true);
  }
  _bindingIntersectsNode(node) {
    requireNode(node, "intersectsNode");
    return this._core.selectionStatus("range_intersects_node", this._handle, node._coreHandle) === 1;
  }
  _bindingSelectNode(node) {
    requireNode(node, "selectNode");
    this._core.selectionStatus("range_select_node", this._handle, node._coreHandle);
    this._core.syncSelectionDocuments();
    if (this._highlightCount > 0) this._document._repaintHighlights();
  }
  _bindingDetach() {}
  _bindingCloneContents() { return this._mutate(() => this._core.handle("range_clone_contents", this._handle)); }
  _bindingExtractContents() {
    const handle = runRangeMutation(this, RANGE_MUTATION_EXTRACT);
    try { return this._core.wrapperFor(handle); }
    finally { this._core.status("node_release", handle); }
  }
  _bindingDeleteContents() { runRangeMutation(this, RANGE_MUTATION_DELETE); }
  _bindingInsertNode(node) {
    requireNode(node, "insertNode");
    runRangeMutation(this, RANGE_MUTATION_INSERT, node._coreHandle);
  }
  _bindingSurroundContents(newParent) {
    requireNode(newParent, "surroundContents");
    runRangeMutation(this, RANGE_MUTATION_SURROUND, newParent._coreHandle);
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

// StaticRange (DOM §5.4): boundary points that mutations of the tree do not
// update. A doctype or an attribute is no boundary container.
export class SDStaticRange extends SDAbstractRange {
  constructor(init) {
    if (init === null || typeof init !== "object") {
      throw new TypeError("Failed to construct 'StaticRange': parameter 1 is not of type 'StaticRangeInit'.");
    }
    for (const member of ["startContainer", "startOffset", "endContainer", "endOffset"]) {
      if (init[member] === undefined) {
        throw new TypeError(`Failed to construct 'StaticRange': required member ${member} is undefined.`);
      }
    }
    const { startContainer, endContainer } = init;
    for (const node of [startContainer, endContainer]) {
      if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
        throw new TypeError("Failed to construct 'StaticRange': the boundary container is not of type 'Node'.");
      }
      if (node.nodeType === 10 || node.nodeType === 2) {
        throw new DOMException("Failed to construct 'StaticRange': a doctype or an attribute is no boundary container.",
          "InvalidNodeTypeError");
      }
    }
    if (startContainer._domCore !== endContainer._domCore) {
      throw new DOMException("The boundary containers belong to different DOM core instances", "WrongDocumentError");
    }
    super(startContainer.nodeType === 9 ? startContainer : startContainer.ownerDocument, null);
    this._staticBoundaries = Object.freeze([
      startContainer, Number(init.startOffset) >>> 0, endContainer, Number(init.endOffset) >>> 0,
    ]);
  }
  _boundaries() {
    return this._staticBoundaries;
  }
}

Object.defineProperty(SDStaticRange.prototype, Symbol.toStringTag, { value: "StaticRange", configurable: true });

function requireNode(node, method) {
  if (node === null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError(`Failed to execute '${method}' on 'Range': parameter 1 is not of type 'Node'.`);
  }
}

// Range.getClientRects and getBoundingClientRect (CSSOM View) over a
// synchronous layout of the range's document with the text geometry of
// every laid-out text node: Chrome lays the document out for them, also
// its skipped contents. On a paged surface the layout holds the text of
// the pages from the range's start to its end. A document without a
// document element has no rendering.
function rangeRectangles(range, bounding) {
  const root = range._document.documentElement;
  if (root === null) {
    return bounding ? { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } : [];
  }
  return withLiveGeometry(root, root._resolvedLayoutOptions, ({ core, handle }) =>
    geometryRangeRects(core, handle, range, bounding),
  (paging, indexOf) => pagesOfNodes(paging, indexOf, [range.startContainer, range.endContainer]));
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
      range._set(SELECTION_SET_BOTH, this._node, this._offset, this._node, this._offset);
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
    super(document, SELECTION_KIND_SELECTION);
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
  // The core answers 0 None, 1 Caret, 2 Range: a Selection in a text
  // control with a selected range is a Range, with isCollapsed true.
  _bindingType() {
    this._layoutUpdate();
    return SELECTION_TYPES.get(this._core.status("selection_type", this._handle));
  }
  _orderedRange() {
    const boundaries = this._boundaries(true);
    if (boundaries === null) return null;
    const range = new SDRange(this._document);
    try { range._set(SELECTION_SET_BOTH, ...boundaries); } catch (error) { range._release(); throw error; }
    return range;
  }
  _setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    anchorOffset = requireBoundary(this._core, this, anchorNode, anchorOffset);
    focusOffset = requireBoundary(this._core, this, focusNode, focusOffset);
    const previous = this.focusNode ?? this.anchorNode;
    if (this._set(SELECTION_SET_BOTH, anchorNode, anchorOffset, focusNode, focusOffset)) {
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
    requireBoundary(this._core, this, node, 0);
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
    const changed = operation();
    this._core.syncSelectionDocuments();
    if (changed) this._onChange(this.focusNode ?? previous);
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
    if (this._set(SELECTION_REMOVE)) this._onChange(focus ?? anchor);
  }
  _bindingEmpty() { this.removeAllRanges(); }
  _bindingContainsNode(node, allowPartialContainment = false) {
    this._layoutUpdate();
    return this._core.selectionStatus("selection_contains", this._handle, node._coreHandle, Boolean(allowPartialContainment)) !== 0;
  }
  // The members below run in the core (selection.watpart).
  _bindingCollapseToStart() {
    this._layoutUpdate();
    this._changed(() => this._core.selectionStatus("selection_collapse_to", this._handle, false));
  }
  _bindingCollapseToEnd() {
    this._layoutUpdate();
    this._changed(() => this._core.selectionStatus("selection_collapse_to", this._handle, true));
  }
  _bindingRemoveRange(range) {
    this._layoutUpdate();
    if (!(range instanceof SDRange)) throw new TypeError("Failed to execute 'removeRange' on 'Selection': parameter 1 is not of type 'Range'.");
    this._changed(() => this._core.selectionStatus("selection_remove_range", this._handle, range._handle));
  }
  _bindingDeleteFromDocument() {
    this._layoutUpdate();
    this._changed(() => runRangeMutation(this, RANGE_MUTATION_DELETE_FROM_DOCUMENT) !== 0n);
  }
  _bindingDirection() {
    this._layoutUpdate();
    this._core.selectionStatus("selection_direction", this._handle);
    return this._core.outputString("selection_direction");
  }
  _selectedSpans() {
    return this._core.selectionSpans(this._handle);
  }
  // A core change of this selection (the live range steps of a removal, a
  // text control setter): report it at the node it changed at, once.
  _takeChange() {
    if (!this._core.status("selection_change_take", this._handle)) return;
    this._onChange(this._core.wrapperFor(this._core.output("selection_change_take").getBigUint64(0, true)));
  }
  // The text of the selection (core): the control's selection in a text
  // control, else the rendered text of the range.
  _bindingToString() {
    this._layoutUpdate();
    return this._core.string("selection_text", this._handle);
  }
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
