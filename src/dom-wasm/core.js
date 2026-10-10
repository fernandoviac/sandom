import { scheduleMutationObservers } from "../dom/mutation-observer.js";
import { instantiateRendererCore } from "../wasm/renderer-core-binary.js";
import {
  ANIMATION_RECORD_SIZE, LAYOUT_NODE_SIZE,
  LAYOUT_NODE_OFFSET_BORDER_BOTTOM, LAYOUT_NODE_OFFSET_BORDER_LEFT,
  LAYOUT_NODE_OFFSET_BORDER_RIGHT, LAYOUT_NODE_OFFSET_BORDER_TOP,
  LAYOUT_NODE_OFFSET_BOX_SIZING, LAYOUT_NODE_OFFSET_MARGIN_BOTTOM,
  LAYOUT_NODE_OFFSET_MARGIN_LEFT, LAYOUT_NODE_OFFSET_MARGIN_RIGHT,
  LAYOUT_NODE_OFFSET_MARGIN_TOP, LAYOUT_NODE_OFFSET_POSITION,
  LAYOUT_NODE_OFFSET_SHADOW_COUNT, LAYOUT_NODE_OFFSET_SHADOW_OFFSET,
  POSITION_ABSOLUTE, SHADOW_POOL_BASE, SHADOW_ENTRY_SIZE,
} from "../wasm/layout.js";
import {
  coreTransportPoolKinds,
  EngineFrameInputSize,
  EngineFrameResolutionSize,
  readEngineFrameOutput,
  readEngineSvgRequest,
  SceneBuildBoxSize
} from "./record-readers.generated.js";
const FRAME_MEASUREMENT = Symbol.for("sandom.domCore.measurement");

const resourceMeasurementKey = Symbol.for("sandom.domCore.measurement");

const measurementKey = Symbol.for("sandom.domCore.measurement");

const wrapperCores = new WeakMap();
const applyNative = Reflect.apply;

// An author value the core's own grammar rejected, marked at the throw
// site. CSS Cascade 4 §4.2 drops such a declaration and keeps the rest of
// the rule; a failure anywhere else in the same apply path is an internal
// defect and must reach the caller
// (BUG-style-resolution-swallows-internal-errors, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md). The mark
// rides on the exception the CSSOM and `animate()` are specified to throw,
// so those surfaces keep their TypeError/RangeError.
const authorValueRejection = Symbol("sandom.authorValueRejection");

export function markAuthorValueRejection(error) {
  error[authorValueRejection] = true;
  return error;
}

export function isAuthorValueRejection(error) {
  return Boolean(error?.[authorValueRejection]);
}

// One list item of a declaration whose author value the binding rejected.
const REJECTED_ITEM = Symbol("sandom.rejectedListItem");

export function domCoreForWrapper(wrapper) {
  return wrapperCores.get(wrapper);
}

// Wraps a module's exports so a memory growth inside any call is reported
// before the caller can read a detached view. Only the DOM core's allocator
// grows the shared memory, but it is reached from the engine's shaping
// calls (through HarfBuzz) as well as from the core's own operations, so
// both export sets are observed.
export function observeMemoryGrowth(memory, exports, notify) {
  let buffer = memory.buffer;
  const wrapped = {};
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = function () {
      let exportThrew = true;
      try {
        const result = applyNative(value, null, arguments);
        exportThrew = false;
        return result;
      } finally {
        const nextBuffer = memory.buffer;
        if (nextBuffer !== buffer) {
          buffer = nextBuffer;
          try {
            notify();
          } catch (error) {
            // The export's own failure has precedence. After a normal
            // return, notification is the only failure and remains visible.
            if (!exportThrew) throw error;
          }
        }
      }
    };
  }
  return Object.freeze(wrapped);
}

// Cascade item pseudo-element kinds, indexed by the native discriminator.
const PSEUDO_ELEMENT_NAMES = Object.freeze([
  null,
  "::before",
  "::after",
  "::unsupported",
  "::selection",
]);

const ERROR_NAMES = new Map([
  [5, "HierarchyRequestError"],
  [6, "NotFoundError"],
  [7, "SyntaxError"],
  [8, "IndexSizeError"],
  [9, "InvalidStateError"],
  [10, "InvalidStateError"],
  [11, "QuotaExceededError"],
  [12, "NamespaceError"],
  [13, "NotSupportedError"],

  [15, "NotAllowedError"],
  [16, "WrongDocumentError"],
  [17, "InvalidNodeTypeError"],
  [19, "NoModificationAllowedError"],
]);

const RADIAL_SIZES = [
  "closest-side",
  "closest-corner",
  "farthest-side",
  "farthest-corner",
];

// One scene box of a build (sceneBuild below). A class, not a literal
// plus Object.defineProperty per box: an own accessor puts every box in
// dictionary mode and allocates a closure, and a text page's build
// produces thousands of them. `text` decodes from the build's owned text
// copy on first read and memoizes; a box without text answers null (an
// svg shape distinguishes "no path definition" from an empty one).
class SceneBuildBox {
  constructor(
    kind,
    display,
    flags,
    owner,
    handle,
    context,
    children,
    stableId,
    sourceRevision,
    textOffset,
    textLength,
    whiteSpace,
    textTransform,
    font,
    letterSpacing,
    host,
    textSource,
    decoder,
  ) {
    this.kind = kind;
    this.display = display;
    this.flags = flags;
    this.owner = owner;
    this.handle = handle;
    this.context = context;
    this.children = children;
    this.stableId = stableId;
    this.sourceRevision = sourceRevision;
    this.textOffset = textOffset;
    this.textLength = textLength;
    this.whiteSpace = whiteSpace;
    this.textTransform = textTransform;
    this.font = font;
    this.letterSpacing = letterSpacing;
    this.host = host;
    this._textSource = textSource;
    this._decoder = decoder;
    this._text = textSource === null ? null : undefined;
  }

  get text() {
    if (this._text === undefined) {
      this._text = this._decoder.decode(
        this._textSource.core.engineRecordPublicationText(this._textSource.handle).subarray(
          this.textOffset,
          this.textOffset + this.textLength,
        ),
      );
    }
    return this._text;
  }
}

function lengthPercentage(pixels, percentage) {
  return { kind: "lengthPercentage", pixels, percentage };
}

function transformComponent(name, valueKind, a, b, c, d) {
  if (valueKind === 15) return [a, b];
  switch (name) {
    case "translate":
      return {
        kind: name,
        x: lengthPercentage(a, b),
        y: lengthPercentage(c, d),
      };
    case "translateX":
    case "translateY":
      return { kind: name, value: lengthPercentage(a, b) };
    case "scale":
      return { kind: name, x: a, y: b };
    case "scaleX":
    case "scaleY":
      return { kind: name, value: a };
    case "rotate":
    case "skewX":
    case "skewY":
      return { kind: name, radians: a };
    case "skew":
      return { kind: name, xRadians: a, yRadians: b };
    default:
      return { kind: "matrix", value: [a, b, c, d] };
  }
}

// Explicit disposal unregisters these tokens (`DomCore.dispose`), so a
// finalizer only ever releases a handle the core still holds. A handle can
// carry several registrations at once (`finalizerRegistrations`); each one
// owns one retain, and only the last one drops the handle's cached state.
const wrapperFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ coreReference, handle, reference }) => {
    const core = coreReference.deref();
    if (!core) return;
    if (core.wrapperByHandle.get(handle) === reference) {
      core.wrapperByHandle.delete(handle);
    }
    const registration = core.finalizerRegistrations.get(handle);
    registration.count -= 1;
    if (registration.count === 0) {
      core.finalizerRegistrations.delete(handle);
      core.nodeTypes.delete(handle);
    }
    core.status("node_release", handle);
  })
  : null;

const EDGE_SIDES = ["top", "right", "bottom", "left"];
const FIELD_MEMBERS = {
  borderRadius: ["topLeft", "topRight", "bottomRight", "bottomLeft"],
  overflowClipMargin: ["visualBox", "offset"],
  scrollSnapType: ["axis", "strictness"],
  scrollSnapAlign: ["block", "inline"],
};

function rgba(view, offset) {
  return {
    r: view.getFloat64(offset, true),
    g: view.getFloat64(offset + 8, true),
    b: view.getFloat64(offset + 16, true),
    a: view.getFloat64(offset + 24, true),
  };
}

// A document whose wrapper is unreachable (every node wrapper of a document
// keeps its document wrapper alive) has no host reference left; its core
// tree is disposed so a long-lived process does not accumulate documents.
const documentFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ coreReference, handle }) => {
    const core = coreReference.deref();
    if (!core) return;
    core.dispose(handle);
  })
  : null;

function attributeMetadata(core, handle, index) {
  return {
    namespaceURI:
      core.attributeStringAt("attribute_namespace_at", handle, index) || null,
    localName: core.attributeStringAt("attribute_local_name_at", handle, index),
    prefix: core.attributeStringAt("attribute_prefix_at", handle, index) ||
      null,
  };
}

export class DomCoreAttributeMap {
  constructor(core, handle) {
    this.core = core;
    this.handle = handle;
  }

  get size() {
    return this.core.attributeCount(this.handle);
  }

  get(name) {
    return this.core.getAttribute(this.handle, name);
  }

  has(name) {
    return this.core.hasAttribute(this.handle, name);
  }

  set(name, value) {
    this.core.setAttribute(this.handle, null, name, value);
    return this;
  }

  delete(name) {
    return this.core.removeAttribute(this.handle, name);
  }

  clear() {
    for (const name of [...this.keys()]) this.delete(name);
  }

  *keys() {
    const count = this.size;
    for (let index = 0; index < count; index += 1) {
      yield this.core.attributeStringAt(
        "attribute_name_at",
        this.handle,
        index,
      );
    }
  }

  *values() {
    const count = this.size;
    for (let index = 0; index < count; index += 1) {
      yield this.core.attributeStringAt(
        "attribute_value_at",
        this.handle,
        index,
      );
    }
  }

  *entries() {
    const count = this.size;
    for (let index = 0; index < count; index += 1) {
      yield [
        this.core.attributeStringAt("attribute_name_at", this.handle, index),
        this.core.attributeStringAt("attribute_value_at", this.handle, index),
      ];
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArgument = undefined) {
    for (const [name, value] of this) {
      callback.call(thisArgument, value, name, this);
    }
  }
}

export class DomCoreAttributeMetadataMap {
  constructor(core, handle) {
    this.core = core;
    this.handle = handle;
  }

  get size() {
    return this.core.attributeCount(this.handle);
  }

  get(name) {
    const wanted = String(name);
    const count = this.size;
    for (let index = 0; index < count; index += 1) {
      if (
        this.core.attributeStringAt("attribute_name_at", this.handle, index) ===
          wanted
      ) {
        return attributeMetadata(this.core, this.handle, index);
      }
    }
    return undefined;
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  set(_name, _metadata) {
    return this;
  }

  delete(name) {
    return !this.has(name);
  }

  *entries() {
    const count = this.size;
    for (let index = 0; index < count; index += 1) {
      yield [
        this.core.attributeStringAt("attribute_name_at", this.handle, index),
        attributeMetadata(this.core, this.handle, index),
      ];
    }
  }

  *keys() {
    for (const [name] of this) yield name;
  }

  *values() {
    for (const [, metadata] of this) yield metadata;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

export class DomCoreClassSet {
  constructor(core, handle) {
    this.core = core;
    this.handle = handle;
  }

  has(token) {
    return this.core.classContains(this.handle, token);
  }

  *values() {
    const count = this.core.classCount(this.handle);
    for (let index = 0; index < count; index += 1) {
      yield this.core.classItem(this.handle, index);
    }
  }

  keys() {
    return this.values();
  }

  entries() {
    const values = [...this.values()];
    return values.map((value) => [value, value])[Symbol.iterator]();
  }

  [Symbol.iterator]() {
    return this.values();
  }

  get size() {
    return this.core.classCount(this.handle);
  }
}

// Read-only view of an element's stored computed custom properties.
export class DomCoreComputedCustomProperties {
  constructor(core, handle) {
    this.core = core;
    this.handle = handle;
  }

  get(name) {
    return this.core.computedCustomProperty(this.handle, name) ?? undefined;
  }

  has(name) {
    return this.core.computedCustomProperty(this.handle, name) !== null;
  }

  entries() {
    if (!this.core.status("node_computed_select", this.handle)) {
      return new Map();
    }
    return this.core.readCurrentCustomProperties();
  }

  keys() {
    return this.entries().keys();
  }

  [Symbol.iterator]() {
    return this.entries()[Symbol.iterator]();
  }
}

// A renderer-core instance used without DOM wrappers: one memory, its raw
// DOM/engine exports, and growth notification for the loader's engine facade.
export function createAllocatorCore() {
  const instance = instantiateRendererCore();
  const memory = instance.exports.memory;
  const listeners = new Set();
  return Object.freeze({
    memory,
    rawExports: instance.exports,
    onMemoryGrowth(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyGrowth() {
      for (const listener of listeners) listener();
    },
  });
}

export class DomCore {
  constructor() {
    const instance = instantiateRendererCore();
    this.memory = instance.exports.memory;
    this.growthListeners = new Set();
    // Raw exports bind HarfBuzz's allocator directly; host calls go through
    // growth-observing wrappers so no caller reads a detached view.
    this.rawExports = instance.exports;
    this.nativeExports = observeMemoryGrowth(
      this.memory,
      instance.exports,
      () => this.notifyGrowth(),
    );
    const measurement = globalThis[measurementKey];
    this.exports = measurement
      ? measurement.wrapExports(this.nativeExports, "core")
      : this.nativeExports;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.bytes = new Uint8Array(this.memory.buffer);
    this.wrapperCaches = new Map();
    this.wrapperHandles = new WeakMap();
    this.wrapperFactory = null;
    this.observersById = new Map();
    this.nextObserverId = 1;
    this.observerFinalizer = new FinalizationRegistry((id) => {
      this.status("observer_release", id);
    });
  }

  notifyGrowth() {
    this.bytes = new Uint8Array(this.memory.buffer);
    for (const listener of this.growthListeners) listener();
  }

  // The one refresh rule: a listener re-derives every long-lived view over
  // the shared memory; fired synchronously after the growing call. The
  // returned function removes the listener. An owner that ends before the
  // core calls it when it ends; until then the listener's closure retains
  // the owner, and everything the owner references, for the core's life.
  onMemoryGrowth(listener) {
    this.growthListeners.add(listener);
    return () => this.growthListeners.delete(listener);
  }

  refreshBytes() {
    if (this.bytes.buffer !== this.memory.buffer) {
      this.bytes = new Uint8Array(this.memory.buffer);
    }
    return this.bytes;
  }

  frameDamageRectangles(frame) {
    const count = this.status("frame_damage_export", frame);
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer);
    const measurement = globalThis[FRAME_MEASUREMENT];
    if (measurement) {
      measurement.record({
        category: "damage",
        operation: "frame_damage_export",
        direction: "core-to-host",
        bytes: count * 32,
        allocations: count + 1,
      });
    }
    return Array.from({ length: count }, (_, index) => {
      const at = pointer + index * 32;
      return {
        x: view.getFloat64(at, true),
        y: view.getFloat64(at + 8, true),
        width: view.getFloat64(at + 16, true),
        height: view.getFloat64(at + 24, true),
      };
    });
  }

  // The used caret-color of an element: its caret-color, or its own color
  // for `auto`. { r, g, b, a } in 0..1.
  styleUsedCaretColor(handle) {
    this.status("style_used_caret_color", handle);
    const view = new DataView(
      this.refreshBytes().buffer,
      this.exports.abi_output_pointer(),
      32,
    );
    return {
      r: view.getFloat64(0, true),
      g: view.getFloat64(8, true),
      b: view.getFloat64(16, true),
      a: view.getFloat64(24, true),
    };
  }

  frameDamageTiles(frame, width, height, tileSize) {
    this.status("frame_damage_tiles", frame, width, height, tileSize);
    const pointer = this.exports.abi_output_pointer();
    const length = this.exports.abi_output_length();
    const tiles = this.refreshBytes().slice(pointer, pointer + length);
    const measurement = globalThis[FRAME_MEASUREMENT];
    if (measurement) {
      measurement.record({
        category: "damage",
        operation: "frame_damage_tiles",
        direction: "core-to-host",
        bytes: length,
        allocations: 1,
        allocationBytes: length,
      });
    }
    return tiles;
  }

  frameCommitGroupInput(entries) {
    const pointer = this.exports.abi_allocate(entries.length * 16);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < entries.length; index++) {
      view.setBigUint64(pointer + index * 16, entries[index].handle, true);
      view.setBigUint64(
        pointer + index * 16 + 8,
        entries[index].revision,
        true,
      );
    }
    const measurement = globalThis[FRAME_MEASUREMENT];
    if (measurement) {
      measurement.record({
        category: "lifecycle",
        operation: "frame_commit_group",
        direction: "host-to-core",
        bytes: entries.length * 16,
      });
    }
    return pointer;
  }

  input(value) {
    return this.byteInput(this.encoder.encode(String(value)), true);
  }

  byteInput(bytes, utf8Encoded = false) {
    const pointer = this.exports.abi_allocate(bytes.byteLength);
    // abi_allocate preserves the previous operation's error registers; only a
    // failed allocation may inspect them before the next operation begins.
    if (!pointer) this.throwIfError();
    this.refreshBytes().set(bytes, pointer);
    const measurement = globalThis[measurementKey];
    if (measurement) {
      measurement.record({
        category: "transport",
        operation: utf8Encoded ? "utf8.input" : "bytes.input",
        direction: "host-to-core",
        bytes: bytes.byteLength,
        allocations: utf8Encoded ? 1 : 0,
        allocationBytes: utf8Encoded ? bytes.byteLength : 0,
      });
    }
    return [pointer, bytes.byteLength];
  }

  inputSchemaTextCompare(left, right, mode, value = 0) {
    const pointer = this.exports.abi_allocate((left.length + right.length) * 2);
    if (!pointer) this.throwIfError();
    const view = new DataView(
      this.refreshBytes().buffer,
      pointer,
      (left.length + right.length) * 2,
    );
    for (let index = 0; index < left.length; index++) {
      view.setUint16(index * 2, left.charCodeAt(index), true);
    }
    for (let index = 0; index < right.length; index++) {
      view.setUint16((left.length + index) * 2, right.charCodeAt(index), true);
    }
    const measurement = globalThis[measurementKey];
    if (measurement) {
      measurement.record({
        category: "transport",
        operation: "input.bound-text",
        direction: "host-to-core",
        bytes: view.byteLength,
        allocations: 1,
      });
    }
    const result = this.exports.input_schema_bound_text(
      pointer,
      left.length,
      right.length,
      mode,
      value,
    );
    this.throwIfError();
    return result;
  }

  nullableInput(value) {
    return value === null || value === undefined ? [0, 0] : this.input(value);
  }

  outputString() {
    const pointer = this.exports.abi_output_pointer();
    const length = this.exports.abi_output_length();
    const measurement = globalThis[measurementKey];
    const start = measurement ? performance.now() : 0;
    const result = this.decoder.decode(
      this.refreshBytes().subarray(pointer, pointer + length),
    );
    if (measurement) {
      measurement.record({
        category: "transport",
        operation: "utf8.output",
        direction: "core-to-host",
        bytes: length,
        allocations: 1,
        milliseconds: performance.now() - start,
      });
    }
    return result;
  }

  throwIfError(rawMessage = false) {
    const kind = this.exports.abi_error_kind();
    if (kind === 0) return;
    const pointer = this.exports.abi_error_pointer();
    const length = this.exports.abi_error_length();
    const baseMessage = this.decoder.decode(
      this.refreshBytes().subarray(pointer, pointer + length),
    );
    const detailA = this.exports.abi_error_detail_a();
    const detailB = this.exports.abi_error_detail_b();
    const message = rawMessage || kind === 16 || kind === 17 || kind === 19
      ? baseMessage
      : kind === 3
      ? `${baseMessage}: supplied ${detailA}, live ${detailB}`
      : `${baseMessage}: observed ${detailA}, limit ${detailB}`;
    if (kind === 1 || kind === 2) throw new TypeError(message);
    if (kind === 14) throw new RangeError(baseMessage);
    if (kind === 18) throw new Error(baseMessage);
    const errorName = ERROR_NAMES.get(kind);
    if (errorName && typeof DOMException === "function") {
      throw new DOMException(message, errorName);
    }
    throw new Error(message);
  }

  status(exportName, ...parameters) {
    const native = this.exports;
    const result = applyNative(native[exportName], native, parameters);
    this.throwIfError();
    return result;
  }

  selectionStatus(exportName, ...parameters) {
    const result = applyNative(
      this.exports[exportName],
      this.exports,
      parameters,
    );
    this.throwIfError(true);
    return result;
  }

  handle(exportName, ...parameters) {
    const native = this.exports;
    const handle = applyNative(native[exportName], native, parameters);
    this.throwIfError();
    return handle;
  }

  selectionBoundaries(handle, ordered = false) {
    if (
      !this.selectionStatus(
        ordered ? "selection_ordered_export" : "selection_export",
        handle,
      )
    ) return null;
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer, pointer, 32);
    const first = view.getBigUint64(0, true);
    const firstOffset = view.getFloat64(8, true);
    const second = view.getBigUint64(16, true);
    const secondOffset = view.getFloat64(24, true);
    return [
      this.wrapperFor(first),
      firstOffset,
      this.wrapperFor(second),
      secondOffset,
    ];
  }

  selectionSpans(handle, node = 0n) {
    const count = this.status("selection_text_spans", handle, node);
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer, pointer, count * 16);
    // Capture all transient facts before wrapper construction or data access
    // enters another operation; no native pointer crosses a host callback.
    const spans = new Array(count);
    for (let index = 0; index < count; index++) {
      spans[index] = [
        view.getBigUint64(index * 16, true),
        view.getUint32(index * 16 + 8, true),
        view.getUint32(index * 16 + 12, true),
      ];
    }
    for (const span of spans) span[0] = this.wrapperFor(span[0]);
    return spans;
  }
  string(exportName, ...parameters) {
    const native = this.exports;
    const result = applyNative(native[exportName], native, parameters);
    this.throwIfError();
    return result === 0 ? null : this.outputString();
  }

  createDocument(url, xmlDocument = false) {
    return this.handle(
      "document_create",
      ...this.input(url),
      xmlDocument ? 1 : 0,
    );
  }

  parseHtmlDocument(documentHandle, source) {
    return this.status(
      "html_parse_document",
      documentHandle,
      ...this.input(source),
    );
  }

  parseHtmlFragment(contextHandle, fragmentHandle, source) {
    return this.status(
      "html_parse_fragment",
      contextHandle,
      fragmentHandle,
      ...this.input(source),
    );
  }

  parseXmlDocument(documentHandle, source) {
    return this.status(
      "xml_parse_document",
      documentHandle,
      ...this.input(source),
    );
  }

  parseXmlFragment(contextHandle, fragmentHandle, source) {
    return this.status(
      "xml_parse_fragment",
      contextHandle,
      fragmentHandle,
      ...this.input(source),
    );
  }

  // The first syntax diagnostic of the last XML parse, or null when it was
  // well formed. The readers neither begin an operation nor rotate state.
  xmlParseDiagnostic() {
    const line = this.exports.xml_parse_error_line();
    if (line === 0) return null;
    const pointer = this.exports.xml_parse_error_pointer();
    return {
      line,
      column: this.exports.xml_parse_error_column(),
      message: this.decoder.decode(this.refreshBytes().subarray(
        pointer,
        pointer + this.exports.xml_parse_error_length(),
      )),
    };
  }

  isXmlDocument(documentHandle) {
    return this.status("document_is_xml", documentHandle) === 1;
  }

  documentMode(documentHandle) {
    return this.status("document_mode", documentHandle);
  }

  selectorMatches(handle, selector) {
    return this.status(
      "selector_matches",
      handle,
      ...this.input(selector),
    ) === 1;
  }

  selectorClosest(handle, selector) {
    return this.wrapperFor(this.handle(
      "selector_closest",
      handle,
      ...this.input(selector),
    ));
  }

  selectorQuery(rootHandle, selector) {
    return this.wrapperFor(this.handle(
      "selector_query",
      rootHandle,
      ...this.input(selector),
    ));
  }

  selectorQueryAll(rootHandle, selector) {
    return this.resultHandles(this.status(
      "selector_query_all",
      rootHandle,
      ...this.input(selector),
    ));
  }

  // Elements of the light-DOM subtree whose cascade names an animation
  // (pseudoKind 0: the element; 1/2: its ::before/::after), document order.
  animationCandidates(rootHandle, pseudoKind) {
    return this.resultHandles(
      this.status("animation_candidates", rootHandle, pseudoKind),
    );
  }

  resultHandles(count) {
    const result = new Array(count);
    for (let index = 0; index < count; index += 1) {
      result[index] = this.wrapperFor(
        this.handle("selector_result_handle", index),
      );
    }
    return result;
  }

  slotAssign(slotHandle, nodeHandles) {
    const pointer = this.exports.abi_allocate(nodeHandles.length * 8);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < nodeHandles.length; index += 1) {
      view.setBigUint64(pointer + index * 8, nodeHandles[index], true);
    }
    this.status("slot_assign", slotHandle, pointer, nodeHandles.length);
  }

  assignedSlot(handle) {
    return this.wrapperFor(this.handle("slot_assigned_slot", handle));
  }

  assignedNodes(slotHandle) {
    return this.resultHandles(this.status("slot_assigned_nodes", slotHandle));
  }

  flatTreeParent(handle) {
    return this.wrapperFor(this.handle("flat_tree_parent", handle));
  }

  flatTreeChildren(handle) {
    return this.resultHandles(this.status("flat_tree_children", handle));
  }

  setXmlDocument(documentHandle, value) {
    return this.status("document_set_xml", documentHandle, value ? 1 : 0);
  }

  createElement(documentHandle, namespaceURI, qualifiedName) {
    return this.handle(
      "node_create_element",
      documentHandle,
      ...this.nullableInput(namespaceURI),
      ...this.input(qualifiedName),
    );
  }

  createText(documentHandle, data) {
    return this.handle("node_create_text", documentHandle, ...this.input(data));
  }

  createComment(documentHandle, data) {
    return this.handle(
      "node_create_comment",
      documentHandle,
      ...this.input(data),
    );
  }

  createCdata(documentHandle, data) {
    return this.handle(
      "node_create_cdata",
      documentHandle,
      ...this.input(data),
    );
  }

  createFragment(documentHandle) {
    return this.handle("node_create_fragment", documentHandle);
  }

  createProcessingInstruction(documentHandle, target, data) {
    return this.handle(
      "node_create_processing_instruction",
      documentHandle,
      ...this.input(target),
      ...this.input(data),
    );
  }

  createDoctype(documentHandle, name, publicId, systemId) {
    return this.handle(
      "node_create_doctype",
      documentHandle,
      ...this.input(name),
      ...this.input(publicId),
      ...this.input(systemId),
    );
  }

  createShadowRoot(hostHandle, flags) {
    return this.handle("node_create_shadow_root", hostHandle, flags);
  }

  detachShadowRoot(hostHandle) {
    this.status("node_detach_shadow_root", hostHandle);
  }

  // Decode core-owned resource usages in CSS order for the element
  // (pseudo 0), its ::before (1) or its ::after (2). Device acquisition is
  // separate; these IDs remain stable across builds and shared renderers.
  sceneResourceLayers(handle, pseudo) {
    const count = this.status("scene_resource_layers", handle, pseudo);
    const layers = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const resource = this.handle("scene_resource_layer", handle, pseudo, index);
      layers[index] = resource === 0n ? {} : {
        src: this.resourceKey(resource),
        resourceIdentifier: this.resourceId(resource),
      };
    }
    return layers;
  }

  wrapperCache(handle) {
    return this.documentWrapperCache(
      this.handle("node_owner_document", handle),
    );
  }

  documentWrapperCache(documentHandle) {
    let cache = this.wrapperCaches.get(documentHandle);
    if (!cache) {
      cache = new Map();
      this.wrapperCaches.set(documentHandle, cache);
    }
    return cache;
  }

  // A node's wrapper cache entry lives under its current owner document:
  // `dispose` cancels the finalizers of exactly the handles the core frees,
  // so an adopted node's entry moves with it (callback record kind 4).
  moveWrapperCacheEntry(handle, oldDocumentHandle, newDocumentHandle) {
    const priorCache = this.wrapperCaches.get(oldDocumentHandle);
    const reference = priorCache?.get(handle);
    if (!reference) return;
    priorCache.delete(handle);
    this.documentWrapperCache(newDocumentHandle).set(handle, reference);
  }

  // Every live wrapper by handle, across documents: the lookup a scene
  // serialization makes per node must not cost a core call (the owner
  // document) each. Handles are unique per node lifetime (a slot
  // generation in the high bits), so a stale entry can only miss.
  wrapperByHandle = new Map();

  // Unregister token per finalizer-registered handle (node wrappers and
  // document wrappers): `dispose` must cancel finalization even for a
  // wrapper that is already unreachable but not yet finalized. A collected
  // wrapper's WeakRef clears before its finalizer runs, so `wrapperFor` can
  // wrap the same handle again (with its own retain) while the first
  // registration is still pending: every registration of a handle shares
  // the handle's token, and `count` tracks how many are outstanding.
  finalizerRegistrations = new Map();
  documentFinalizerTokens = new Map();

  registerDocumentWrapper(wrapper, handle) {
    if (!documentFinalizer) return;
    const token = {};
    this.documentFinalizerTokens.set(handle, token);
    documentFinalizer.register(wrapper, {
      coreReference: new WeakRef(this),
      handle,
    }, token);
  }

  registerWrapper(wrapper, handle, retained = true) {
    this.wrapperHandles.set(wrapper, handle);
    wrapperCores.set(wrapper, this);
    const reference = new WeakRef(wrapper);
    this.wrapperByHandle.set(handle, reference);
    this.wrapperCache(handle).set(handle, reference);
    if (wrapperFinalizer && retained) {
      let registration = this.finalizerRegistrations.get(handle);
      if (!registration) {
        registration = { token: {}, count: 0 };
        this.finalizerRegistrations.set(handle, registration);
      }
      registration.count += 1;
      wrapperFinalizer.register(
        wrapper,
        { coreReference: new WeakRef(this), handle, reference },
        registration.token,
      );
    }
  }

  cancelFinalizer(handle) {
    const registration = this.finalizerRegistrations.get(handle);
    if (!registration) return;
    this.finalizerRegistrations.delete(handle);
    wrapperFinalizer.unregister(registration.token);
  }

  handleForWrapper(wrapper) {
    return this.wrapperHandles.get(wrapper) ?? 0n;
  }

  wrapperFor(handle) {
    if (handle === 0n) return null;
    const live = this.wrapperByHandle.get(handle)?.deref();
    if (live) return live;
    const cache = this.wrapperCache(handle);
    const existing = cache.get(handle)?.deref();
    if (existing) return existing;
    if (!this.wrapperFactory) {
      throw new Error(`No wrapper factory for DOM core handle ${handle}`);
    }
    this.status("node_retain", handle);
    const wrapper = this.wrapperFactory(handle);
    this.registerWrapper(wrapper, handle, true);
    return wrapper;
  }

  nodesEqual(leftHandle, rightHandle) {
    return this.status("node_is_equal", leftHandle, rightHandle) === 1;
  }

  // A node's type never changes; the first read is the last core call.
  nodeTypes = new Map();
  nodeType(handle) {
    let type = this.nodeTypes.get(handle);
    if (type === undefined) {
      type = this.status("node_type", handle);
      this.nodeTypes.set(handle, type);
    }
    return type;
  }

  nodeString(exportName, handle) {
    return this.string(exportName, handle);
  }

  nodeHandle(exportName, ...args) {
    return this.wrapperFor(this.handle(exportName, ...args));
  }

  childCount(handle) {
    return this.status("node_child_count", handle);
  }

  // A child by index, or undefined past the end (a collection read).
  childAt(handle, index) {
    const child = this.exports.node_child_at(handle, index);
    if (child === 0n) {
      const kind = this.exports.abi_error_kind();
      if (kind === 8) return undefined;
      this.throwIfError();
    }
    return this.wrapperFor(child);
  }

  textContent(handle) {
    this.status("node_text_content", handle);
    return this.outputString();
  }

  elementById(rootHandle, id) {
    return this.wrapperFor(
      this.handle("node_element_by_id", rootHandle, ...this.input(id)),
    );
  }

  elementsByTagName(rootHandle, qualifiedName) {
    return this.resultHandles(
      this.status(
        "node_elements_by_tag_name",
        rootHandle,
        ...this.input(qualifiedName),
      ),
    );
  }

  childHandles(handle) {
    return this.resultHandles(this.status("node_child_handles", handle));
  }

  childElementHandles(handle) {
    return this.resultHandles(
      this.status("node_child_element_handles", handle),
    );
  }

  childElementCount(handle) {
    return this.status("node_child_element_count", handle);
  }

  childElementAt(handle, index) {
    const child = this.handle("node_child_element_at", handle, index);
    return child === 0n ? undefined : this.wrapperFor(child);
  }

  elementChildEdge(handle, fromEnd) {
    return this.wrapperFor(
      this.handle("node_element_child_edge", handle, fromEnd ? 1 : 0),
    );
  }

  validateInsertion(parentHandle, nodeHandle, referenceHandle = 0n) {
    return this.status(
      "node_validate_insertion",
      parentHandle,
      nodeHandle,
      referenceHandle,
    );
  }

  replaceChild(parentHandle, newHandle, oldHandle) {
    return this.status(
      "node_replace_child",
      parentHandle,
      newHandle,
      oldHandle,
    );
  }

  replaceChildren(parentHandle, replacementHandle = 0n) {
    return this.status(
      "node_replace_children",
      parentHandle,
      replacementHandle,
    );
  }

  insertBefore(parentHandle, nodeHandle, referenceHandle) {
    return this.status(
      "node_insert_before",
      parentHandle,
      nodeHandle,
      referenceHandle ?? 0n,
    );
  }

  removeChild(parentHandle, nodeHandle) {
    return this.status("node_remove_child", parentHandle, nodeHandle);
  }

  setData(handle, data) {
    return this.status("node_set_data", handle, ...this.input(data));
  }

  setHostState(handle, { hovered = false, active = false } = {}) {
    return this.status(
      "node_set_host_state",
      handle,
      (hovered ? 2 : 0) | (active ? 4 : 0),
    );
  }

  setDoctypePublicId(handle, value) {
    return this.status(
      "node_set_doctype_public_id",
      handle,
      ...this.input(value),
    );
  }

  adopt(documentHandle, nodeHandle) {
    return this.status("node_adopt", documentHandle, nodeHandle);
  }

  clone(sourceHandle, documentHandle, deep) {
    return this.wrapperFor(this.handle(
      "node_clone",
      sourceHandle,
      documentHandle,
      deep ? 1 : 0,
    ));
  }

  setDoctypeSystemId(handle, value) {
    return this.status(
      "node_set_doctype_system_id",
      handle,
      ...this.input(value),
    );
  }

  getAttribute(handle, name) {
    return this.string("attribute_get", handle, ...this.input(name));
  }

  hasAttribute(handle, name) {
    return this.status("attribute_has", handle, ...this.input(name)) === 1;
  }

  getAttributeNS(handle, namespaceURI, localName) {
    return this.string(
      "attribute_get_ns",
      handle,
      ...this.nullableInput(namespaceURI),
      ...this.input(localName),
    );
  }

  setAttribute(handle, namespaceURI, qualifiedName, value) {
    return this.status(
      "attribute_set",
      handle,
      ...this.nullableInput(namespaceURI),
      ...this.input(qualifiedName),
      ...this.input(value),
    );
  }

  removeAttribute(handle, name) {
    return this.status("attribute_remove", handle, ...this.input(name)) === 1;
  }

  removeAttributeNS(handle, namespaceURI, localName) {
    return this.status(
      "attribute_remove_ns",
      handle,
      ...this.nullableInput(namespaceURI),
      ...this.input(localName),
    ) === 1;
  }

  attributeCount(handle) {
    return this.status("attribute_count", handle);
  }

  classCount(handle) {
    return this.status("class_count", handle);
  }

  classItem(handle, index) {
    const result = this.exports.class_item(handle, index);
    this.throwIfError();
    return result === 0 ? null : this.outputString();
  }

  classRemove(handle, token) {
    return this.status("class_remove", handle, ...this.input(token)) === 1;
  }

  classReplace(handle, oldToken, newToken) {
    return this.status(
      "class_replace",
      handle,
      ...this.input(oldToken),
      ...this.input(newToken),
    ) === 1;
  }

  classToggle(handle, token, force = -1) {
    return this.status(
      "class_toggle",
      handle,
      ...this.input(token),
      force,
    ) === 1;
  }

  attributeStringAt(exportName, handle, index) {
    const result = this.exports[exportName](handle, index);
    this.throwIfError();
    return result === 0 ? null : this.outputString();
  }

  classContains(handle, token) {
    return this.status("class_contains", handle, ...this.input(token)) === 1;
  }

  classAdd(handle, token) {
    return this.status("class_add", handle, ...this.input(token)) === 1;
  }

  styleGet(handle, name) {
    return this.string("style_get", handle, ...this.input(name));
  }

  styleHas(handle, name) {
    return this.status("style_has", handle, ...this.input(name)) === 1;
  }

  styleSet(
    handle,
    name,
    value,
    priority = "",
    mode = 0,
    registry = this.defaultFontRegistry,
  ) {
    const operation = this.handle(
      "style_set",
      handle,
      ...this.input(name),
      ...this.input(value),
      ...this.input(priority),
      mode,
      registry.fontCatalogHandle,
    );
    return this.runStyleMutation(operation, registry, mode);
  }

  styleSetPriority(handle, name, important) {
    return this.status(
      "style_set_priority",
      handle,
      ...this.input(name),
      important ? 1 : 0,
    ) === 1;
  }

  stylePriority(handle, name) {
    return this.status("style_get_priority", handle, ...this.input(name)) === 1
      ? "important"
      : "";
  }

  styleRemove(handle, name) {
    this.status("style_remove", handle, ...this.input(name));
    return this.outputString();
  }

  styleClear(handle) {
    return this.status("style_clear", handle) === 1;
  }

  styleCount(handle) {
    return this.status("style_count", handle);
  }

  styleNameAt(handle, index) {
    return this.attributeStringAt("style_name_at", handle, index);
  }

  styleValueAt(handle, index) {
    return this.attributeStringAt("style_value_at", handle, index);
  }

  styleRead(handle, name) {
    return this.string("style_read", handle, ...this.input(name));
  }

  styleText(handle) {
    return this.string("style_text", handle) ?? "";
  }

  styleReplace(
    handle,
    source,
    attributeReplay = false,
    registry = this.defaultFontRegistry,
  ) {
    const operation = this.handle(
      "style_replace",
      handle,
      ...this.input(source),
      registry.fontCatalogHandle,
      attributeReplay ? 1 : 0,
    );
    return this.runStyleMutation(operation, registry, attributeReplay ? 3 : 2);
  }

  runStyleMutation(operation, registry, mode) {
    try {
      while (true) {
        const step = this.status("style_mutation_next", operation);
        if (step === 0) return this.status("style_mutation_result", operation);
        if (step < 0) {
          const message = this.outputString();
          const kind = this.status("style_mutation_error_kind", operation);
          if (kind === 2) throw new TypeError(message);
          if (kind === 14) throw new RangeError(message);
          throw new Error(message);
        }
        const family = this.string("style_mutation_family", operation);
        const token = this.handle("style_mutation_token", operation);
        let failure;
        let outcome = 0;
        let message = "";
        try {
          registry.fontStackKeysForCssValue(family);
        } catch (error) {
          failure = error;
          outcome = error instanceof Error ? 1 : 2;
          if (mode >= 2 && outcome === 1) message = `${error.message}`;
        }
        this.status(
          "style_mutation_resume",
          operation,
          token,
          outcome,
          ...this.input(message),
        );
        if (outcome === 2 || (outcome === 1 && mode < 2)) throw failure;
      }
    } finally {
      this.status("style_mutation_dispose", operation);
    }
  }

  styleSupports(name) {
    return this.status("style_supported", ...this.input(name)) === 1;
  }

  styleIDLName(name) {
    return this.string("style_idl_name", ...this.input(name)) ?? "";
  }

  styleMethodName(name) {
    return this.string("style_method_name", ...this.input(name)) ?? "";
  }

  styleCSSName(name) {
    return this.string("style_css_name", ...this.input(name)) ?? "";
  }

  styleCSSNameAt(handle, index) {
    return this.attributeStringAt("style_css_name_at", handle, index);
  }

  stylePriorityValid(priority) {
    return this.status("style_priority_valid", ...this.input(priority)) === 1;
  }

  styleCheckName(name) {
    if (!this.status("style_check_name", ...this.input(name))) {
      throw new Error(this.outputString());
    }
  }

  styleDiagnostics(handle) {
    const count = this.status("style_diagnostic_count", handle);
    const diagnostics = new Array(count);
    for (let index = 0; index < count; index++) {
      const code = this.status("style_diagnostic_at", handle, index);
      const message = this.outputString();
      diagnostics[index] = Object.freeze(
        code === 1
          ? {
            code: "css-invalid-declaration",
            severity: "warning",
            recoverable: true,
            sourceURL: "about:blank",
            line: 1,
            column: 1,
            message,
          }
          : {
            sourceURL: "about:blank",
            line: 1,
            column: 1,
            offset: 0,
            code: "css-unsupported-declaration",
            message,
          },
      );
    }
    return Object.freeze(diagnostics);
  }

  // An element's unsupported MathML (mathml.watpart): its name when it is
  // outside MathML Core, then each presentation attribute Sandom ignores.
  mathmlDiagnostics(handle) {
    const diagnostics = [];
    for (let index = 0; ; index++) {
      const kind = this.status("mathml_diagnostic_at", handle, index);
      if (kind === 0) return diagnostics;
      diagnostics.push({
        code: kind === 1 ? "mathml-unsupported-element" : "mathml-unsupported-attribute",
        message: this.outputString(),
      });
    }
  }

  createStylesheet() {
    return this.status("stylesheet_create");
  }

  disposeStylesheet(sheetHandle) {
    this.status("stylesheet_dispose", sheetHandle);
  }

  parseStylesheet(sheetHandle, source, rejectMalformed = false) {
    this.status(
      "stylesheet_replace",
      sheetHandle,
      ...this.input(source),
      rejectMalformed ? 1 : 0,
    );
  }

  connectStylesheet(sheetHandle, ownerHandle, documentHandle) {
    this.status("stylesheet_connect", sheetHandle, ownerHandle, documentHandle);
  }

  disconnectStylesheet(sheetHandle) {
    this.status("stylesheet_disconnect", sheetHandle);
  }

  stylesheetIsConnected(sheetHandle) {
    return this.status("stylesheet_is_connected", sheetHandle) === 1;
  }

  stylesheetSnapshot(
    sheetHandle,
    sourceURL = "about:blank",
    source = "",
  ) {
    const readString = (exportName, handle) =>
      this.string(exportName, handle) ?? "";
    let sourceSearchOffset = 0;
    const readDeclarations = (ruleHandle) => {
      const count = this.status("css_rule_declaration_count", ruleHandle);
      const declarations = new Array(count);
      for (let index = 0; index < count; index += 1) {
        declarations[index] = Object.freeze({
          property:
            this.string("css_rule_declaration_property", ruleHandle, index) ??
              "",
          value: this.string("css_rule_declaration_value", ruleHandle, index) ??
            "",
          important:
            this.status("css_rule_declaration_important", ruleHandle, index) ===
              1,
        });
      }
      return Object.freeze(declarations);
    };
    const readRule = (ruleHandle) => {
      const kind = this.status("css_rule_kind", ruleHandle);
      const prelude = readString("css_rule_prelude", ruleHandle);
      const cssText = readString("css_rule_source_text", ruleHandle);
      const childCount = this.status("css_rule_child_count", ruleHandle);
      const rules = new Array(childCount);
      for (let index = 0; index < childCount; index += 1) {
        rules[index] = readRule(
          this.status("css_rule_child_at", ruleHandle, index),
        );
      }
      const offset = source.indexOf(cssText, sourceSearchOffset);
      const normalizedOffset = offset < 0 ? sourceSearchOffset : offset;
      sourceSearchOffset = normalizedOffset + cssText.length;
      return Object.freeze({
        handle: ruleHandle,
        kind,
        type: kind === 1 || kind === 8 ? "style" : "at-rule",
        name: readString("css_rule_name", ruleHandle),
        prelude,
        selectorText: prelude,
        declarations: readDeclarations(ruleHandle),
        rules: Object.freeze(rules),
        cssText,
        location: Object.freeze({
          sourceURL,
          line: 1,
          column: normalizedOffset + 1,
          offset: normalizedOffset,
          endOffset: normalizedOffset + cssText.length,
        }),
      });
    };
    const count = this.status("css_sheet_rule_count", sheetHandle);
    const rules = new Array(count);
    for (let index = 0; index < count; index += 1) {
      rules[index] = readRule(
        this.status("css_sheet_rule_at", sheetHandle, index),
      );
    }
    const invalidDeclarationCount = this.status(
      "css_sheet_invalid_declaration_count",
      sheetHandle,
    );
    const diagnostics = invalidDeclarationCount === 0 ? [] : [Object.freeze({
      code: "css-invalid-declaration",
      severity: "warning",
      recoverable: true,
      sourceURL,
      line: 1,
      column: 1,
      message: "Invalid declaration animation-timing-function",
    })];
    return Object.freeze({
      rules: Object.freeze(rules),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  // Compiled complex selectors of one selector list; ranges are decoded
  // back into strings so the binding never holds core offsets.
  selectorCompile(selectorList, { strict = false } = {}) {
    const text = String(selectorList);
    const [pointer, length] = this.input(text);
    const count = this.status(
      "selector_compile",
      pointer,
      length,
      strict ? 1 : 0,
    );
    const size = this.exports.selector_compile_record_size();
    const base = this.exports.abi_output_pointer();
    const view = new DataView(this.memory.buffer, base, count * size);
    const bytes = this.refreshBytes();
    const slice = (start, end) =>
      this.decoder.decode(bytes.subarray(pointer + start, pointer + end));
    const selectors = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const at = index * size;
      const start = view.getUint32(at, true);
      const end = view.getUint32(at + 4, true);
      const shape = view.getUint32(at + 40, true);
      const argumentStart = view.getUint32(at + 44, true);
      const argumentEnd = view.getUint32(at + 48, true);
      const restStart = view.getUint32(at + 52, true);
      const restEnd = view.getUint32(at + 56, true);
      const keyLength = view.getUint32(at + 36, true);
      const keyPointer = view.getUint32(at + 32, true);
      const flags = view.getUint32(at + 60, true);
      selectors[index] = {
        selectorText: slice(start, end),
        matchSelector: slice(start, view.getUint32(at + 8, true)),
        pseudoElement: PSEUDO_ELEMENT_NAMES[view.getUint32(at + 12, true)],
        specificity: [
          view.getUint32(at + 16, true),
          view.getUint32(at + 20, true),
          view.getUint32(at + 24, true),
        ],
        keyKind: view.getUint32(at + 28, true),
        key: keyLength === 0 ? "" : this.decoder.decode(
          bytes.subarray(keyPointer, keyPointer + keyLength),
        ),
        shape,
        argument: shape === 0 || (shape === 1 && argumentEnd === 0)
          ? null
          : slice(argumentStart, argumentEnd),
        rest: shape === 0 || restEnd <= restStart
          ? null
          : slice(restStart, restEnd),
        usesHover: (flags & 1) !== 0,
        usesActive: (flags & 2) !== 0,
      };
    }
    return selectors;
  }

  selectorStateProbe(handle, selectorList, state) {
    return this.status(
      "selector_state_probe",
      handle,
      ...this.input(selectorList),
      state === "active" ? 4 : 2,
    ) === 1;
  }

  mediaEnvironmentSet(environment) {
    this.status(
      "media_environment_set",
      environment.viewportWidth,
      environment.viewportHeight,
      environment.mediaType === "screen"
        ? 0
        : environment.mediaType === "print"
        ? 1
        : 2,
      environment.colorScheme === "dark" ? 1 : 0,
      environment.reducedMotion ? 1 : 0,
      { srgb: 0, p3: 1, rec2020: 2 }[environment.colorGamut] ?? 0,
      environment.dynamicRange === "high" ? 1 : 0,
      environment.hoverCapability === "none" ? 0 : 1,
      { none: 0, coarse: 1, fine: 2 }[environment.pointerAccuracy] ?? 2,
      environment.scrollbarStyle === "classic" ? 1 : 0,
    );
  }

  mediaMatches(text, environment) {
    this.mediaEnvironmentSet(environment);
    return this.status("media_matches", ...this.input(text)) === 1;
  }

  supportsCondition(text) {
    return this.status("supports_condition", ...this.input(text)) === 1;
  }

  cascadePlanAddSheet(plan, sheetHandle, origin, entryIndex, forPart) {
    this.status(
      "cascade_plan_add_sheet",
      plan,
      sheetHandle,
      origin,
      entryIndex,
      forPart ? 1 : 0,
    );
  }

  cascadePlanSequence(plan) {
    return this.status("cascade_plan_sequence", plan);
  }

  cascadePlanItem_(plan, index) {
    const shapeFlags = this.status("cascade_plan_item_field", plan, index, 1);
    const stateFlags = this.status("cascade_plan_item_field", plan, index, 3);
    return {
      index,
      entryIndex: this.status("cascade_plan_item_field", plan, index, 0),
      shape: shapeFlags & 7,
      forPart: (shapeFlags & 8) !== 0,
      pseudoElement: PSEUDO_ELEMENT_NAMES[
        this.status("cascade_plan_item_field", plan, index, 2)
      ],
      usesHover: (stateFlags & 1) !== 0,
      usesActive: (stateFlags & 2) !== 0,
      matchSelector: this.string("cascade_plan_item_text", plan, index, 0),
      argument: this.string("cascade_plan_item_text", plan, index, 1),
      rest: this.string("cascade_plan_item_text", plan, index, 2),
    };
  }

  // Items the binding matches itself: shadow-scoped shapes and ::part rules.
  cascadePlanSpecialItems(plan) {
    const items = [];
    for (
      let index = this.status("cascade_plan_special_next", plan, -1);
      index >= 0;
      index = this.status("cascade_plan_special_next", plan, index)
    ) {
      items.push(this.cascadePlanItem_(plan, index));
    }
    return items;
  }

  // Items whose selectors consult :hover (state 1) or :active (state 2).
  cascadePlanProbeItems(plan, state) {
    const items = [];
    for (
      let index = this.status("cascade_plan_probe_next", plan, 0, state);
      index >= 0;
      index = this.status("cascade_plan_probe_next", plan, index + 1, state)
    ) {
      items.push(this.cascadePlanItem_(plan, index));
    }
    return items;
  }

  cascadePlanOfferItem(plan, index) {
    this.status("cascade_plan_offer_item", plan, index);
  }

  cascadeElementCollect(handle, pseudoKind) {
    this.status("cascade_element_collect", handle, pseudoKind);
  }

  cascadeStateAffects(handle, state) {
    return this.status(
      "cascade_state_affects",
      handle,
      state === "active" ? 2 : 1,
    ) === 1;
  }

  setUserAgentStylesheet(documentHandle, sheetHandle) {
    this.status(
      "document_user_agent_stylesheet_set",
      documentHandle,
      sheetHandle,
    );
  }

  setAdoptedStylesheets(rootHandle, sheetHandles) {
    const pointer = this.exports.abi_allocate(sheetHandles.length * 4);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < sheetHandles.length; index += 1) {
      view.setUint32(pointer + index * 4, sheetHandles[index], true);
    }
    this.status(
      "scope_adopted_stylesheets_set",
      rootHandle,
      pointer,
      sheetHandles.length,
    );
  }

  activeStylesheets(rootHandle) {
    const count = this.status("scope_active_stylesheet_count", rootHandle);
    const handles = new Array(count);
    for (let index = 0; index < count; index += 1) {
      handles[index] = this.status(
        "scope_active_stylesheet_at",
        rootHandle,
        index,
      );
    }
    return handles;
  }

  stylesheetDisabled(sheetHandle) {
    return this.status("stylesheet_is_disabled", sheetHandle) === 1;
  }

  stylesheetMedia(sheetHandle) {
    return this.string("stylesheet_media", sheetHandle) ?? "";
  }

  stylesheetRevision(sheetHandle) {
    return this.status("stylesheet_revision", sheetHandle);
  }

  stylesheetSource(sheetHandle) {
    return this.string("stylesheet_source", sheetHandle) ?? "";
  }

  stylesheetOwner(sheetHandle) {
    return this.wrapperFor(this.handle("stylesheet_owner", sheetHandle));
  }

  elementStylesheet(elementHandle) {
    return this.status("scope_element_stylesheet", elementHandle);
  }

  setStylesheetDisabled(sheetHandle, disabled) {
    this.status("stylesheet_set_disabled", sheetHandle, disabled ? 1 : 0);
  }

  setStylesheetMedia(sheetHandle, media) {
    this.status("stylesheet_set_media", sheetHandle, ...this.input(media));
  }

  // The participating children of an element as scene items: kind 1
  // element, 2 text, 3/4 anonymous inline run open/close, 5/6 expansion
  // open/close (a display:contents child or shadow-tree slot).
  sceneChildren(handle) {
    const count = this.status("scene_children", handle);
    const items = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const kind = this.status("scene_child_kind", index);
      items[index] = {
        kind,
        node: kind === 3 || kind === 4 || kind === 6
          ? null
          : this.wrapperFor(this.handle("scene_child_handle", index)),
      };
    }
    return items;
  }

  // The scene box tree of a subtree root: boxes in engine order (breadth
  // first, children contiguous) with kind, display code, flags, owner box,
  // node and context handles, child indices, and text; plus the handles of
  // the display:contents and slot elements the tree expanded (no box).
  // Decode transient box metadata here. Text remains in the publication's
  // retained native arena and is decoded only when a facade reader asks.
  sceneBuild(rootHandle, viewport, publication) {
    const count = this.status(
      viewport ? "scene_build_viewport" : "scene_build",
      rootHandle,
    );
    const base = this.exports.abi_output_pointer();
    const view = new DataView(this.memory.buffer);
    const arena = this.exports.scene_text_arena_pointer();
    const boxes = new Array(count);
    const childBase = base + count * SceneBuildBoxSize;
    for (let index = 0; index < count; index += 1) {
      // Decoded field by field into its final shape: the generated reader
      // would build an intermediate object per box, and a text page has
      // thousands of boxes per build.
      const pointer = base + index * SceneBuildBoxSize;
      const childOffset = view.getUint32(pointer + 24, true);
      const childCount = view.getUint32(pointer + 28, true);
      const children = new Array(childCount);
      for (let child = 0; child < childCount; child += 1) {
        children[child] = view.getUint32(
          childBase + (childOffset + child) * 4,
          true,
        );
      }
      const textPointer = view.getUint32(pointer + 32, true);
      const textLength = view.getUint32(pointer + 36, true);
      const hasText = textPointer !== 0 || textLength !== 0;
      const owner = view.getInt32(pointer + 4, true);
      boxes[index] = new SceneBuildBox(
        view.getUint8(pointer + 0),
        view.getUint8(pointer + 1),
        view.getUint16(pointer + 2, true),
        owner < 0 ? undefined : owner,
        view.getBigUint64(pointer + 8, true),
        view.getBigUint64(pointer + 16, true),
        children,
        view.getBigUint64(pointer + 56, true),
        view.getBigUint64(pointer + 64, true),
        hasText ? textPointer - arena : 0,
        hasText ? textLength : 0,
        view.getUint8(pointer + 40),
        view.getUint8(pointer + 41),
        view.getUint32(pointer + 44, true),
        view.getFloat64(pointer + 48, true),
        view.getUint8(pointer + 42),
        hasText ? publication : null,
        hasText ? this.decoder : null,
      );
    }
    // Rows and child lists are build-owned; the readers below may rotate
    // transient memory without affecting them.
    const expansionCount = this.status("scene_expansion_count");
    const expansions = new Array(expansionCount);
    for (let index = 0; index < expansionCount; index += 1) {
      expansions[index] = this.handle("scene_expansion_handle", index);
    }
    const rootContext = {
      direction: this.exports.scene_root_direction() === 1 ? "rtl" : "ltr",
      writingMode: ["horizontal-tb", "vertical-rl", "vertical-lr"][
        this.exports.scene_root_writing_mode()
      ],
    };
    return { boxes, expansions, rootContext };
  }

  // The canvas background the last build propagated from the html root
  // or its body (CSS 2.1 14.2), as { r, g, b, a }, or null.
  sceneCanvasBackground() {
    if (this.status("scene_canvas_background") === 0) return null;
    const view = new DataView(
      this.memory.buffer,
      this.exports.abi_output_pointer(),
      32,
    );
    return {
      r: view.getFloat64(0, true),
      g: view.getFloat64(8, true),
      b: view.getFloat64(16, true),
      a: view.getFloat64(24, true),
    };
  }

  // Host generated-content overrides (animated pseudo-element content) for
  // the next scene build; pseudoKind 1 ::before, 2 ::after.
  sceneGeneratedOverride(handle, pseudoKind, text) {
    this.status(
      "scene_generated_override",
      handle,
      pseudoKind,
      ...this.input(text),
    );
  }

  // A CSS color as encoded sRGB {r, g, b, a}, "currentColor" for the
  // keyword, or null for an invalid value.
  parseColor(text) {
    const status = this.exports.color_parse(...this.input(text));
    this.throwIfError();
    if (status === 1) return "currentColor";
    if (status !== 0) return null;
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.memory.buffer);
    return {
      r: view.getFloat64(pointer, true),
      g: view.getFloat64(pointer + 8, true),
      b: view.getFloat64(pointer + 16, true),
      a: view.getFloat64(pointer + 24, true),
    };
  }

  // Every URL that CSS text names, with its escapes decoded by the core's
  // tokenizer: each url() and the string that an @import names. `start`
  // and `end` are the UTF-16 offsets of the whole token, from `url(`
  // through its `)`, or the quoted string.
  cssURLs(text) {
    const source = this.encoder.encode(String(text));
    const count = this.status("css_url_tokens", ...this.byteInput(source, true));
    const pointer = this.exports.abi_output_pointer();
    const length = this.exports.abi_output_length();
    const records = this.refreshBytes().slice(pointer, pointer + length);
    const view = new DataView(records.buffer);
    // The records count UTF-8 bytes; every byte that does not continue a
    // sequence is one UTF-16 code unit, and a four-byte sequence is two.
    let byteOffset = 0;
    let textOffset = 0;
    const textOffsetOf = (target) => {
      for (; byteOffset < target; byteOffset++) {
        const byte = source[byteOffset];
        if ((byte & 0xc0) !== 0x80) textOffset += byte >= 0xf0 ? 2 : 1;
      }
      return textOffset;
    };
    const urls = new Array(count);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const start = textOffsetOf(view.getUint32(offset, true));
      const end = textOffsetOf(view.getUint32(offset + 4, true));
      const urlLength = view.getUint32(offset + 8, true);
      urls[index] = {
        start,
        end,
        url: this.decoder.decode(records.subarray(offset + 12, offset + 12 + urlLength)),
      };
      offset += 12 + urlLength;
    }
    return urls;
  }

  // The ranges of an @font-face unicode-range descriptor value as a
  // Uint32Array of {start, end} scalar pairs, sorted and disjoint, or null
  // for an invalid descriptor, which Chrome ignores.
  fontUnicodeRanges(text) {
    const count = this.status("font_unicode_range_parse", ...this.input(text));
    if (count < 0) return null;
    const pointer = this.exports.abi_output_pointer();
    return new Uint32Array(this.refreshBytes().buffer.slice(pointer, pointer + count * 8));
  }

  cascadePlanCreate() {
    return this.status("cascade_plan_create");
  }

  cascadePlanDispose(plan) {
    this.status("cascade_plan_dispose", plan);
  }

  // entries: [{ skipped, scopeRoot: handle|0n }] written as 16-byte rows.
  cascadePlanCollect(plan, handle, pseudoKind, entries) {
    const pointer = this.exports.abi_allocate(entries.length * 16);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < entries.length; index += 1) {
      const at = pointer + index * 16;
      view.setUint32(at, entries[index].skipped ? 1 : 0, true);
      view.setUint32(at + 4, 0, true);
      view.setBigUint64(at + 8, entries[index].scopeRoot, true);
    }
    this.status(
      "cascade_plan_collect",
      plan,
      handle,
      pseudoKind,
      pointer,
      entries.length,
    );
  }

  cascadeBegin() {
    this.exports.cascade_begin();
    this.throwIfError();
  }

  cascadeOffer({
    property,
    value,
    important,
    origin,
    specificity,
    layerOrder,
    order,
  }) {
    this.exports.cascade_offer(
      ...this.input(property),
      ...this.input(value),
      important ? 1 : 0,
      origin,
      Number.isFinite(specificity[0]) ? specificity[0] : 0x7fff_ffff,
      specificity[1],
      specificity[2],
      layerOrder,
      order,
    );
    this.throwIfError();
  }

  resourceRegister(kind, key) {
    const input = this.input(key);
    return this.handle("resource_register", kind, ...input);
  }

  resourceRegisterOwned(kind, owner, key) {
    return this.handle(
      "resource_register_owned",
      kind,
      owner,
      ...this.input(key),
    );
  }

  resourceFindId(id) {
    return this.handle("resource_find_id", id);
  }

  resourceId(resource) {
    return this.status("resource_id", resource) >>> 0;
  }

  resourceContentGeneration(resource) {
    return this.status("resource_content_generation", resource) >>> 0;
  }

  canvasResourceDimension(resource, axis) {
    return this.status("resource_canvas_dimension", resource, axis);
  }

  attachSceneResources(nodes, root) {
    if (!this.sceneResourceOwners) {
      this.sceneResourceOwners = new WeakMap();
      this.sceneResourceFinalizer = new FinalizationRegistry((handle) => {
        this.status("resource_scene_release", handle);
      });
    }
    const handle = this.handle("resource_scene_capture", root);
    this.sceneResourceOwners.set(nodes, handle);
    this.sceneResourceFinalizer.register(nodes, handle, nodes);
  }

  shareSceneResources(sourceNodes, nodes) {
    const handle = this.sceneResourceOwners?.get(sourceNodes);
    if (handle === undefined) {
      throw new Error("Scene resource ownership is missing");
    }
    this.status("resource_scene_retain", handle);
    this.sceneResourceOwners.set(nodes, handle);
    this.sceneResourceFinalizer.register(nodes, handle, nodes);
  }

  releaseSceneResources(nodes) {
    const handle = this.sceneResourceOwners?.get(nodes);
    if (handle === undefined) return;
    this.sceneResourceOwners.delete(nodes);
    this.sceneResourceFinalizer.unregister(nodes);
    this.status("resource_scene_release", handle);
  }

  resourceInfo(handle) {
    this.status("resource_info", handle);
    const view = new DataView(
      this.memory.buffer,
      this.exports.abi_output_pointer(),
      64,
    );
    return {
      id: view.getUint32(0, true),
      kind: view.getUint32(4, true),
      references: view.getUint32(8, true),
      readiness: view.getUint32(12, true),
      contentGeneration: view.getUint32(16, true),
      metricsGeneration: view.getUint32(20, true),
      width: view.getFloat64(24, true),
      height: view.getFloat64(32, true),
      failure: view.getUint32(40, true),
      revision: view.getUint32(44, true),
    };
  }

  resourceKey(handle) {
    this.status("resource_key", handle);
    return this.outputString();
  }

  sceneResourceNode(node) {
    return this.handle("scene_resource_node", node);
  }

  // The URL that an SVG element's fill (which 0) or stroke (which 1) names
  // as its paint server, escapes decoded, or null when that paint names
  // none (SceneBuildBox.host bits 4 and 8).
  sceneSvgPaintServer(node, which) {
    return this.status("scene_svg_paint_server", node, which)
      ? this.outputString()
      : null;
  }

  resourceEngineCreate() {
    return this.handle("resource_engine_create");
  }

  resourceEngineBind(scope, resource, index, variant = 0) {
    this.status("resource_engine_bind", scope, resource, index, variant);
  }

  resourceEngineIndex(scope, id, variant = 0) {
    return this.status("resource_engine_index", scope, id, variant);
  }

  resourceEngineRelease(scope) {
    this.status("resource_engine_release", scope);
  }
  resourceUpdate(
    handle,
    readiness,
    width,
    height,
    contentChanged = false,
    failure = 0,
  ) {
    const measurement = globalThis[resourceMeasurementKey];
    const result = this.status(
      "resource_update",
      handle,
      readiness,
      width,
      height,
      contentChanged ? 1 : 0,
      failure,
    );
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "resource.update",
        direction: "host-to-core",
        bytes: 36,
        crossings: 0,
        allocations: 0,
        allocationBytes: 0,
      });
    }
    return result;
  }

  resourceBind(node, resource) {
    return this.status("resource_bind", node, resource);
  }

  resourceForNode(node) {
    return this.handle("resource_for_node", node);
  }

  resourceNodeDetach(node) {
    return this.status("resource_node_detach", node);
  }

  resourceMetricsChanged(handle) {
    return this.status("resource_metrics_changed", handle);
  }

  resourceRetain(handle) {
    return this.status("resource_retain", handle);
  }

  resourceRelease(handle) {
    return this.status("resource_release", handle);
  }

  get resourceRevision() {
    return this.status("resource_revision") >>> 0;
  }

  canvasBitmapDimension(node, axis) {
    return this.status("canvas_bitmap_dimension", node, axis);
  }

  canvasBitmapReset(node, sizeChanged, resetDevice) {
    const request = this.handle("canvas_bitmap_set", node, sizeChanged ? 1 : 0);
    this.canvasResetRequest(request, resetDevice);
  }

  canvasBitmapAttributeMatches(name, namespace) {
    // Raw namespace/name identity checks must not coerce objects before the
    // reflected attribute operation does. The native matcher sees only strings.
    const input = typeof name === "string" ? this.input(name) : [0, 0];
    return this.status(
      "canvas_bitmap_attribute_matches",
      ...input,
      namespace === null ? 0 : 1,
    ) === 1;
  }

  canvasBitmapAttribute(
    node,
    name,
    namespaced,
    removed,
    wasPresent,
    resetDevice,
  ) {
    const input = this.input(name);
    const request = this.handle(
      "canvas_bitmap_attribute",
      node,
      ...input,
      namespaced ? 1 : 0,
      removed ? 1 : 0,
      wasPresent ? 1 : 0,
    );
    if (request !== 0n) this.canvasResetRequest(request, resetDevice);
  }

  canvasResetRequest(request, resetDevice) {
    const invocation = this.handle("canvas_reset_next", request);
    try {
      this.status("canvas_reset_info", request);
      const view = new DataView(
        this.memory.buffer,
        this.exports.abi_output_pointer(),
        24,
      );
      resetDevice({
        width: view.getFloat64(0, true),
        height: view.getFloat64(8, true),
        contentGeneration: view.getUint32(16, true),
        sizeChanged: view.getUint32(20, true) !== 0,
      });
    } finally {
      this.status("canvas_reset_ack", request, invocation);
    }
  }

  layoutRecords(rootHandle) {
    const count = this.status("layout_records_export", rootHandle);
    const base = this.exports.abi_output_pointer();
    const length = this.exports.abi_output_length();
    const view = new DataView(this.memory.buffer, base, length);
    if (
      view.getUint32(0, true) !== 1 ||
      view.getUint32(4, true) !== 3 ||
      view.getUint32(8, true) !== length ||
      view.getUint32(12, true) !== count
    ) {
      throw new Error("Invalid DOM core layout record header");
    }
    const records = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = 16 + index * 24;
      records[index] = {
        handle: view.getBigUint64(offset, true),
        parentHandle: view.getBigUint64(offset + 8, true),
        nodeType: view.getUint32(offset + 16, true),
        resourceId: view.getUint32(offset + 20, true),
      };
    }
    return records;
  }
  // The shared-memory path stays wholly native. An isolated renderer transports
  // the same raw ABI bytes, never decoded CSS values or a second style store.
  captureComputedSample(engine, owner, identity, node, index, track, property, time) {
    let record = engine.exports.layout_buffer_base() + index * LAYOUT_NODE_SIZE;
    let shadows = 0;
    if (engine.memory !== this.memory) {
      const source = new DataView(engine.memory.buffer);
      const shadowLength = property.kind === 7
        ? source.getUint8(record + LAYOUT_NODE_OFFSET_SHADOW_COUNT) * SHADOW_ENTRY_SIZE
        : 0;
      shadows = shadowLength
        ? SHADOW_POOL_BASE + source.getUint32(record + LAYOUT_NODE_OFFSET_SHADOW_OFFSET, true)
        : 0;
      const bytes = new Uint8Array(ANIMATION_RECORD_SIZE + LAYOUT_NODE_SIZE + shadowLength);
      bytes.set(new Uint8Array(engine.memory.buffer, track, ANIMATION_RECORD_SIZE));
      bytes.set(new Uint8Array(engine.memory.buffer, record, LAYOUT_NODE_SIZE), ANIMATION_RECORD_SIZE);
      if (shadowLength) bytes.set(new Uint8Array(engine.memory.buffer, shadows, shadowLength),
        ANIMATION_RECORD_SIZE + LAYOUT_NODE_SIZE);
      const [pointer] = this.byteInput(bytes);
      track = pointer;
      record = pointer + ANIMATION_RECORD_SIZE;
      shadows = record + LAYOUT_NODE_SIZE;
    }
    this.status("computed_samples_capture", owner, identity, node, index,
      track, record, shadows, property.kind, property.valueOffset,
      property.tagOffset ?? 0, property.percentageOffset ?? 0, time);
  }
  // Capture the layout-used values CSSOM exposes for ::before and ::after
  // boxes (scene box kinds 14 and 15). The snapshot is renderer-owned like
  // sampled animation values; the native view accepts it only while the
  // element's cascade generation still matches. `generatedRows` lists the
  // scene's rows of those boxes (a serialized scene carries them); without
  // it every row's kind is read.
  captureComputedPseudos(engine, owner, nodes, elements, boxes, generatedRows) {
    this.status("computed_pseudos_clear", owner);
    const view = new DataView(engine.memory.buffer);
    const base = engine.exports.layout_buffer_base();
    const rows = generatedRows ?? nodes.keys();
    for (const index of rows) {
      const kind = nodes[index]._coreBox & 0xff;
      if (kind !== 14 && kind !== 15) continue;
      const ownerIndex = nodes[index].generatedOwnerIndex;
      const element = elements[ownerIndex];
      if (!element || element._domCore !== this) continue;
      const record = base + index * LAYOUT_NODE_SIZE;
      // Absolute generated boxes are the layout-used CSSOM case. Relative
      // and in-flow pseudos retain their ordinary computed inset keywords.
      if (view.getUint8(record + LAYOUT_NODE_OFFSET_POSITION) !== POSITION_ABSOLUTE) {
        continue;
      }
      // Read after the position: a frame's box list makes a box on its
      // first read.
      const box = boxes[index];
      const containingBox = boxes[ownerIndex];
      if (!box || !containingBox) continue;
      const containingRecord = base + ownerIndex * LAYOUT_NODE_SIZE;
      const marginTop = view.getFloat32(record + LAYOUT_NODE_OFFSET_MARGIN_TOP, true);
      const marginRight = view.getFloat32(record + LAYOUT_NODE_OFFSET_MARGIN_RIGHT, true);
      const marginBottom = view.getFloat32(record + LAYOUT_NODE_OFFSET_MARGIN_BOTTOM, true);
      const marginLeft = view.getFloat32(record + LAYOUT_NODE_OFFSET_MARGIN_LEFT, true);
      const paddingTopEdge = containingBox.y +
        view.getFloat32(containingRecord + LAYOUT_NODE_OFFSET_BORDER_TOP, true);
      const paddingRightEdge = containingBox.x + containingBox.w -
        view.getFloat32(containingRecord + LAYOUT_NODE_OFFSET_BORDER_RIGHT, true);
      const paddingBottomEdge = containingBox.y + containingBox.h -
        view.getFloat32(containingRecord + LAYOUT_NODE_OFFSET_BORDER_BOTTOM, true);
      const paddingLeftEdge = containingBox.x +
        view.getFloat32(containingRecord + LAYOUT_NODE_OFFSET_BORDER_LEFT, true);
      const contentBox = view.getUint8(record + LAYOUT_NODE_OFFSET_BOX_SIZING) === 0;
      this.status(
        "computed_pseudo_capture",
        owner,
        element._coreHandle,
        kind - 13,
        contentBox ? box.cw : box.w,
        contentBox ? box.ch : box.h,
        box.y - marginTop - paddingTopEdge,
        paddingRightEdge - box.x - box.w - marginRight,
        paddingBottomEdge - box.y - box.h - marginBottom,
        box.x - marginLeft - paddingLeftEdge,
      );
    }
  }


  remapComputedSamples(owner, indexMap) {
    const pointer = this.status("abi_allocate", indexMap.size * 8);
    const view = new DataView(this.refreshBytes().buffer);
    let offset = pointer;
    for (const [previous, next] of indexMap) {
      view.setUint32(offset, previous, true);
      view.setUint32(offset + 4, next, true);
      offset += 8;
    }
    this.status("computed_samples_remap", owner, pointer, indexMap.size);
  }

  // Resolve the current cascade result for an element. Returns the computed
  // declarations (var() substituted, CSS-wide keywords applied) and the
  // element's computed custom properties. A stored resolution supplies the
  // inherited custom properties of its children.
  computedStyleResolve(handle, parentHandle, store) {
    const mode = store === true ? 1 : store === false ? 0 : store;
    const count = this.status(
      "computed_style_resolve",
      handle,
      parentHandle ?? 0n,
      mode,
    );
    const declarations = new Array(count);
    for (let index = 0; index < count; index += 1) {
      declarations[index] = [
        this.string("computed_declaration_property", index),
        this.string("computed_declaration_value", index),
      ];
    }
    // A stored resolution reads its custom properties from the element on
    // demand; a transient one is decoded now, before the next resolution
    // replaces it.
    const customProperties = mode === 1
      ? new DomCoreComputedCustomProperties(this, handle)
      : this.readCurrentCustomProperties();
    return { declarations, customProperties };
  }

  // Cascades and resolves the element after its flat-tree parent unless its
  // stored record is current for the document's style generation.
  styleElementResolve(handle) {
    const count = this.status("style_element_resolve", handle);
    const declarations = new Array(count);
    for (let index = 0; index < count; index += 1) {
      declarations[index] = [
        this.string("computed_declaration_property", index),
        this.string("computed_declaration_value", index),
      ];
    }
    return {
      declarations,
      customProperties: new DomCoreComputedCustomProperties(this, handle),
    };
  }

  readCurrentCustomProperties() {
    const customCount = this.status("computed_custom_count");
    const customProperties = new Map();
    for (let index = 0; index < customCount; index += 1) {
      customProperties.set(
        this.string("computed_custom_name_at", index),
        this.string("computed_custom_value_at", index),
      );
    }
    return customProperties;
  }

  // Length resolution runs in the core against the current context. The
  // result carries pixel and percentage parts as numbers.
  lengthViewport(width, height) {
    if (
      this._lengthViewportWidth === width &&
      this._lengthViewportHeight === height
    ) return;
    this._lengthViewportWidth = width;
    this._lengthViewportHeight = height;
    this.exports.length_viewport_set(width, height);
  }

  // Returns a keyword string, a pixel number, a "N%" string, a
  // { pixels, percentage } pair, or a length expression { expression,
  // cssText }; throws a SyntaxError on invalid input.
  resolveLength(value) {
    const kind = this.status("length_resolve", ...this.input(value));
    if (kind === 1) return this.outputString();
    if (kind === 5) {
      return {
        expression: this.exports.length_result_expression(),
        cssText: this.outputString(),
      };
    }
    const pixels = this.exports.length_result_pixels();
    if (kind === 2) return pixels;
    const percentage = this.exports.length_result_percentage();
    if (kind === 3) return `${percentage * 100}%`;
    return { pixels, percentage };
  }

  // Field slots for the current computed record, in declaration order.
  fieldRecord() {
    return this.decodeFieldSlots(this.status("field_record_resolve"));
  }

  // The current record's element context: computed font size, root font
  // size, color (when the element declared one), family key, direction,
  // and writing mode.
  computedContext() {
    const number = (which) => this.exports.computed_context_number(which);
    const hasColor = number(6) === 1;
    const context = {
      fontSize: number(0),
      rootFontSize: number(1),
      color: { r: number(2), g: number(3), b: number(4), a: number(5) },
      hasColor,
      fontFamily: this.string("computed_context_family"),
      direction: number(7) === 1 ? "rtl" : "ltr",
      writingMode: ["horizontal-tb", "vertical-rl", "vertical-lr"][number(8)],
      pending: number(9) === 1,
    };
    this.throwIfError();
    return context;
  }

  // Font-family values the core met without an answer; the binding keys
  // them through its registry and answers with setFontFamily.
  fontFamilyRequests() {
    const count = this.status("font_family_request_count");
    const requests = new Array(count);
    for (let index = 0; index < count; index += 1) {
      requests[index] = this.string("font_family_request_at", index);
    }
    return requests;
  }



  // keys: the authored stack of cssValue, one key of each available
  // family in authored order; empty when no family matches.
  setFontFamily(cssValue, keys, zeroAdvanceRatio) {
    const css = this.input(cssValue);
    const inputs = keys.map((key) => this.input(key));
    let rows = 0;
    if (inputs.length !== 0) {
      rows = this.exports.abi_allocate(inputs.length * 8);
      if (!rows) this.throwIfError();
      const view = new DataView(this.refreshBytes().buffer);
      inputs.forEach(([pointer, length], index) => {
        view.setUint32(rows + index * 8, pointer, true);
        view.setUint32(rows + index * 8 + 4, length, true);
      });
    }
    this.status("font_family_set", ...css, rows, inputs.length, zeroAdvanceRatio);
  }

  clearFontFamilies() {
    this.status("font_family_clear");
  }

  // The current record's field store as the binding's field object: every
  // entry (own and inherited) decoded into the scene field shapes.
  // `rejectedDeclarations`, like `inheritedFields`, is an out-parameter:
  // the binding pushes the index of every declaration whose AUTHOR value it
  // rejected itself (field-lists.watpart: "an item the binding rejects (an
  // easing function with invalid arguments) drops the whole declaration").
  fieldStore(easing, inheritedFields = null, rejectedDeclarations = null) {
    const count = this.status("field_store_count");
    const fields = {};
    const slot = () => this.decodeFieldSlots(1)[0];
    const scalar = (index, which, sub, extra) => {
      const status = this.status(
        "field_store_slot",
        index,
        which,
        sub ?? 0,
        extra ?? 0,
      );
      return status === 0 ? undefined : slot();
    };
    // Easing text parses for plain list items; a joined list keeps the text.
    // A rejected author easing is a dropped declaration, not a failure of
    // this decode: the sentinel unwinds the entry, and every OTHER failure
    // stays an exception on its way to the caller.
    const itemValue = (decoded) => {
      if (!(decoded.easing && decoded.kind === 7)) return decoded.value;
      try {
        return easing(decoded.value);
      } catch (error) {
        if (!isAuthorValueRejection(error)) throw error;
        rejectedDeclarations?.push(decoded.declaration);
        return REJECTED_ITEM;
      }
    };
    for (let index = 0; index < count; index += 1) {
      const kind = this.status("field_store_entry_scene", index);
      if (kind === 0) continue;
      const name = this.outputString();
      if (kind === 1) {
        fields[name] = scalar(index, 0).value;
      } else if (kind === 2) {
        const members = FIELD_MEMBERS[name] ?? EDGE_SIDES;
        const fillKind = this.status("field_store_entry_field", index, 0);
        const fill = fillKind === 1
          ? scalar(index, 0).value
          : fillKind === 2
          ? {}
          : undefined;
        const value = {};
        for (let side = 0; side < members.length; side += 1) {
          const member = scalar(index, 1, side);
          if (member !== undefined) value[members[side]] = member.value;
          else if (fillKind !== 0) value[members[side]] = fill;
        }
        fields[name] = value;
      } else if (kind === 3) {
        const flags = this.status("field_store_entry_field", index, 0);
        if (flags & 1 && !(flags & 2)) {
          fields[name] = this.string("field_store_entry_text", index) ?? "";
        } else {
          const itemCount = this.status("field_store_entry_field", index, 1);
          const items = new Array(itemCount);
          let rejected = false;
          for (let item = 0; item < itemCount; item += 1) {
            const itemFlags = this.status(
              "field_store_slot",
              index,
              2,
              item,
              0,
            );
            const value = itemFlags & 1 ? itemValue(slot()) : undefined;
            if (value === REJECTED_ITEM) {
              rejected = true;
              break;
            }
            if (itemFlags & 2) {
              this.status("field_store_slot", index, 3, item, 0);
              value.gradient.size = slot().value;
            }
            const stops = this.status("field_store_item_count", index, item, 0);
            for (let stop = 0; stop < stops; stop += 1) {
              this.status("field_store_slot", index, 4, item, stop);
              value.gradient.stops.push(slot().value);
            }
            const components = this.status(
              "field_store_item_count",
              index,
              item,
              1,
            );
            for (let component = 0; component < components; component += 1) {
              this.status("field_store_slot", index, 5, item, component);
              value.value.push(...slot().value);
            }
            items[item] = value;
          }
          if (!rejected) {
            fields[name] = flags & 2
              ? {
                kind: "cssTransform",
                components: items,
                cssText: this.string("field_store_entry_text", index) ?? "",
              }
              : items;
          }
        }
      } else if (kind === 4) {
        fields[name] = {};
      } else if (kind === 5) {
        fields[name] = [];
      } else if (kind === 6) {
        fields[name] = this.string("field_store_entry_text", index) ?? "";
      }
      if (
        inheritedFields !== null && fields[name] !== undefined &&
        this.status("field_store_is_inherited", index)
      ) inheritedFields[name] = fields[name];
    }
    this.throwIfError();
    return fields;
  }

  // Lowers every row of the last build into a retained publication and
  // returns its handle. The caller releases it (engineRecordRelease). A
  // failure carries `sceneRow`, the index of the build row that failed.
  engineRecordPublish(rootHandle, viewportWidth, viewportHeight) {
    const native = this.exports;
    const handle = applyNative(native.engine_record_publish, native, [
      rootHandle,
      viewportWidth,
      viewportHeight,
    ]);
    if (native.abi_error_kind() !== 0) {
      const sceneRow = native.abi_error_detail_a();
      try {
        this.throwIfError();
      } catch (error) {
        error.sceneRow = sceneRow;
        throw error;
      }
    }
    return handle;
  }

  engineRecordPublicationText(publication) {
    this.status("engine_record_publication_text", publication);
    const pointer = this.exports.abi_output_pointer();
    return this.refreshBytes().subarray(
      pointer,
      pointer + this.exports.abi_output_length(),
    );
  }

  engineRecordRelease(publication) {
    this.status("engine_record_release", publication);
  }

  // The row indices a publication lowered anew, ascending; every other
  // row's lowered bytes are identical to the previous live publication's.
  engineRecordChanged(publication) {
    const count = this.status("engine_record_changed", publication);
    if (count < 0) this.throwIfError();
    const pointer = this.exports.abi_output_pointer();
    return new Uint32Array(
      this.refreshBytes().buffer.slice(pointer, pointer + count * 4),
    );
  }

  engineRecordReused(publication) {
    return this.status("engine_record_reused", publication);
  }

  engineRecordLowered(publication) {
    const count = this.status("engine_record_lowered", publication);
    if (count < 0) this.throwIfError();
    const pointer = this.exports.abi_output_pointer();
    return new Uint32Array(
      this.refreshBytes().buffer.slice(pointer, pointer + count * 4),
    );
  }

  // The unrelocated engine record of one published row, as owned bytes:
  // the record followed by its pool blocks (u32 legacy pool, u32 length,
  // payload). Frame publication does not use this; transition endpoints
  // and tests read a box's style values from it.
  engineRecordCopy(stableId, sourceRevision) {
    if (
      typeof stableId !== "bigint" || typeof sourceRevision !== "bigint" ||
      stableId <= 0n || stableId > 0xffffffffffffffffn ||
      sourceRevision <= 0n || sourceRevision > 0xffffffffffffffffn
    ) {
      throw new TypeError(
        "Core record copy requires its actual native scene-build provenance",
      );
    }
    this.status("engine_record_published_row", stableId, sourceRevision);
    const pointer = this.exports.abi_output_pointer();
    return this.refreshBytes().slice(
      pointer,
      pointer + this.exports.abi_output_length(),
    );
  }

  // The geometry of a rect, circle, ellipse or line box whose record the
  // core lowered to a path (its stroke names a paint server): six f32s in
  // the order engine_record_svg_shape_geometry gives, or null for a record
  // that keeps its own shape.
  engineSvgShapeGeometry(stableId, sourceRevision) {
    this.status("engine_record_capture", stableId, sourceRevision);
    if (this.status("engine_record_svg_shape_geometry") === 0) return null;
    const pointer = this.exports.abi_output_pointer();
    return new Float32Array(this.refreshBytes().slice(pointer, pointer + 24).buffer);
  }

  // The native SVG path request of a path box: the lowered path bytes, its
  // resource identity, fill rule and stroke parameters, read from the box's
  // freshly lowered record.
  engineSvgRequest(stableId, sourceRevision, path, pathIdentity) {
    if (!(path instanceof Uint8Array)) {
      throw new TypeError("Captured SVG path requires its raw bytes");
    }
    if (
      typeof pathIdentity !== "bigint" || pathIdentity < 0n ||
      pathIdentity > 0xffffffffffffffffn
    ) {
      throw new TypeError(
        "Captured SVG path requires its actual lossless source identity",
      );
    }
    this.status("engine_record_capture", stableId, sourceRevision);
    const input = this.byteInput(path);
    this.status("engine_record_svg_request", ...input, pathIdentity);
    const request = readEngineSvgRequest(
      new DataView(this.memory.buffer),
      this.exports.abi_output_pointer(),
    );
    const pathUtf8 = this.refreshBytes().slice(
      request.path,
      request.path + request.length,
    );
    const dashArray = Array.from(
      new Float64Array(
        this.memory.buffer,
        request.dashArray,
        request.dashCount,
      ),
    );
    return {
      pathUtf8,
      identity: request.identity,
      resourceRevision: request.resourceRevision,
      fillRule: request.fillRule,
      stroke: request.strokePresent
        ? {
          width: request.width,
          cap: request.cap,
          join: request.join,
          miterLimit: request.miterLimit,
          dashArray,
          dashPhase: request.dashPhase,
        }
        : null,
    };
  }

  engineRecordPrevious(publication) {
    const revision = this.exports.engine_record_previous(publication);
    this.throwIfError();
    return revision;
  }

  engineRecordRevision(publication) {
    const revision = this.exports.engine_record_revision(publication);
    this.throwIfError();
    return revision;
  }

  // Frame publication. The host reserves the retained input block, writes
  // the header and the rows it resolved, then publishes once; the result
  // names borrowed final engine regions, valid until their next publication.
  engineRecordFrameInput(count, imageCount, patch = null) {
    const pointer = patch === null
      ? this.status("engine_record_frame_input", count, imageCount)
      : this.status(
        "engine_record_frame_patch_input",
        patch.publication,
        patch.index,
        imageCount,
      );
    if (pointer === 0) {
      this.throwIfError();
      return null;
    }
    return {
      view: new DataView(this.memory.buffer),
      header: pointer,
      rows: pointer + EngineFrameInputSize,
      images: pointer + EngineFrameInputSize +
        count * EngineFrameResolutionSize,
    };
  }

  // Returns pointers into core memory, not views: the memory may grow
  // between this call and the host's reads (text preparation allocates
  // through the same allocator). Read through refreshBytes() at use time.
  // A patch frame the row's pool spans cannot hold is declined (null):
  // nothing was written and the caller publishes a full frame instead.
  engineRecordFrame() {
    this.engineFrameRevision = (this.engineFrameRevision ?? 0) + 1;
    const outcome = this.exports.engine_record_frame();
    if (outcome === 2) return null;
    if (outcome !== 1) this.throwIfError();
    const output = readEngineFrameOutput(
      new DataView(this.memory.buffer),
      this.exports.abi_output_pointer(),
    );
    return {
      count: output.count,
      records: output.records,
      facts: output.facts,
      pools: {
        [coreTransportPoolKinds.GRID]: [output.gridPool, output.gridPoolLength],
        [coreTransportPoolKinds.BACKGROUND]: [
          output.backgroundPool,
          output.backgroundPoolLength,
        ],
        [coreTransportPoolKinds.GRADIENT_STOPS]: [
          output.stopPool,
          output.stopPoolLength,
        ],
        [coreTransportPoolKinds.SHADOW]: [
          output.shadowPool,
          output.shadowPoolLength,
        ],
        [coreTransportPoolKinds.SVG_GEOMETRY]: [
          output.geometryPool,
          output.geometryPoolLength,
        ],
        [coreTransportPoolKinds.FILTER]: [
          output.filterPool,
          output.filterPoolLength,
        ],
        [coreTransportPoolKinds.CLIP_PATH]: [
          output.clipPool,
          output.clipPoolLength,
        ],
        [coreTransportPoolKinds.MASK]: [
          output.maskPool,
          output.maskPoolLength,
        ],
        [coreTransportPoolKinds.BORDER_IMAGE]: [
          output.borderImagePool,
          output.borderImagePoolLength,
        ],
      },
    };
  }

  fieldStoreDropped() {
    const count = this.status("field_store_dropped_count");
    const dropped = new Array(count);
    for (let index = 0; index < count; index += 1) {
      dropped[index] = this.status("field_store_dropped_at", index);
    }
    return dropped;
  }

  decodeFieldSlots(count) {
    const base = this.exports.field_record_pointer();
    const slotSize = this.exports.field_record_slot_size();
    const view = new DataView(this.memory.buffer, base, count * slotSize);
    const bytes = this.refreshBytes();
    const text = (pointer, length) =>
      this.decoder.decode(bytes.subarray(pointer, pointer + length));
    const slots = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = index * slotSize;
      const kind = view.getUint32(offset, true);
      const valueKind = view.getUint32(offset + 4, true);
      const slot = {
        kind,
        declaration: view.getUint32(offset + 60, true),
        field: kind >= 2
          ? text(
            view.getUint32(offset + 40, true),
            view.getUint32(offset + 44, true),
          )
          : null,
        side: view.getUint32(offset + 48, true),
        value: undefined,
      };
      if (valueKind === 1 || valueKind === 5) {
        const number = view.getFloat64(offset + 8, true);
        slot.value = valueKind === 5 ? { px: number } : number;
      } else if (valueKind === 2) {
        slot.value = `${view.getFloat64(offset + 8, true)}%`;
      } else if (valueKind === 3) {
        slot.value = {
          pixels: view.getFloat64(offset + 8, true),
          percentage: view.getFloat64(offset + 16, true),
        };
      } else if (valueKind === 23) {
        // A length expression: layout evaluates the interned program once
        // it knows the percentage basis; cssText is the computed value.
        slot.value = {
          expression: view.getFloat64(offset + 8, true),
          cssText: text(
            view.getUint32(offset + 52, true),
            view.getUint32(offset + 56, true),
          ),
        };
      } else if (valueKind === 4 || valueKind === 6 || valueKind === 8) {
        slot.value = text(
          view.getUint32(offset + 52, true),
          view.getUint32(offset + 56, true),
        );
        slot.color = valueKind === 6;
        slot.easing = valueKind === 8;
      } else if (valueKind === 17) {
        slot.value = rgba(view, offset + 8);
      } else if (valueKind === 18 || valueKind === 19) {
        slot.value = {
          offsetX: view.getFloat64(offset + 8, true),
          offsetY: view.getFloat64(offset + 16, true),
          blur: view.getFloat64(offset + 24, true),
          spread: view.getFloat64(offset + 32, true),
          color: rgba(
            new DataView(this.memory.buffer),
            view.getUint32(offset + 52, true),
          ),
          inset: valueKind === 19,
        };
        slot.shadow = true;
      } else if (valueKind === 20) {
        slot.value = {
          position: view.getFloat64(offset + 8, true),
          color: rgba(
            new DataView(this.memory.buffer),
            view.getUint32(offset + 52, true),
          ),
        };
        slot.gradient = 3;
      } else if (valueKind === 7) {
        slot.value = [
          view.getFloat64(offset + 8, true),
          view.getFloat64(offset + 16, true),
        ];
      } else if (valueKind === 9 || valueKind === 10) {
        slot.value = {
          offsetX: view.getFloat64(offset + 8, true),
          offsetY: view.getFloat64(offset + 16, true),
          blur: view.getFloat64(offset + 24, true),
          spread: view.getFloat64(offset + 32, true),
          color: text(
            view.getUint32(offset + 52, true),
            view.getUint32(offset + 56, true),
          ),
          inset: valueKind === 10,
        };
        slot.shadow = true;
      } else if (valueKind === 11) {
        const flags = view.getFloat64(offset + 16, true);
        const clause = text(
          view.getUint32(offset + 52, true),
          view.getUint32(offset + 56, true),
        );
        const gradientKind = (flags >> 1) & 3;
        const coordinate = (value, pixels) => pixels ? value : `${value}%`;
        const gradient = {
          kind: gradientKind === 0
            ? "linear"
            : gradientKind === 1
            ? "radial"
            : "conic",
          ...(flags & 1 ? { repeating: true } : {}),
          stops: [],
        };
        if (clause) {
          const [space, method] = clause.toLowerCase().split(/\s+/);
          gradient.interpolationSpace = space;
          if (method) gradient.hueMethod = method;
        }
        if (gradientKind === 1) {
          gradient.shape = flags & 8 ? "circle" : "ellipse";
          gradient.size = undefined;
        } else {
          gradient.angle = view.getFloat64(offset + 8, true);
        }
        if (gradientKind !== 0) {
          gradient.center = [
            coordinate(view.getFloat64(offset + 24, true), flags & 16),
            coordinate(view.getFloat64(offset + 32, true), flags & 32),
          ];
        }
        slot.value = { gradient };
        slot.gradient = 1;
      } else if (valueKind === 21) {
        // A url() image layer, or a `none` layer (empty).
        const src = text(
          view.getUint32(offset + 52, true),
          view.getUint32(offset + 56, true),
        );
        slot.value = src ? { src } : {};
      } else if (valueKind === 12) {
        const sizeKind = view.getFloat64(offset + 8, true);
        slot.value = sizeKind === 4
          ? [
            view.getFloat64(offset + 16, true),
            view.getFloat64(offset + 24, true),
          ]
          : RADIAL_SIZES[sizeKind];
        slot.gradient = 2;
      } else if (valueKind === 13) {
        slot.value = {
          position: view.getFloat64(offset + 8, true),
          color: text(
            view.getUint32(offset + 52, true),
            view.getUint32(offset + 56, true),
          ),
        };
        slot.gradient = 3;
      } else if (valueKind === 14 || valueKind === 15) {
        slot.value = transformComponent(
          text(
            view.getUint32(offset + 52, true),
            view.getUint32(offset + 56, true),
          ),
          valueKind,
          view.getFloat64(offset + 8, true),
          view.getFloat64(offset + 16, true),
          view.getFloat64(offset + 24, true),
          view.getFloat64(offset + 32, true),
        );
        slot.transform = valueKind - 13;
      } else if (valueKind === 16) {
        slot.value = {
          x: lengthPercentage(
            view.getFloat64(offset + 8, true),
            view.getFloat64(offset + 16, true),
          ),
          y: lengthPercentage(
            view.getFloat64(offset + 24, true),
            view.getFloat64(offset + 32, true),
          ),
          cssText: text(
            view.getUint32(offset + 52, true),
            view.getUint32(offset + 56, true),
          ),
        };
      }
      slots[index] = slot;
    }
    return slots;
  }

  // Parse a transform list outside a cascade. Returns the component list
  // or throws for an invalid list.
  // Field slots for one declaration outside a cascade, or null when the
  // core has no entry for the property.
  declarationSlots(property, value) {
    const count = this.status(
      "field_declaration_parse",
      ...this.input(property),
      ...this.input(value),
    );
    if (count < 0) return null;
    return this.decodeFieldSlots(count);
  }

  // Whether the core's specified-value validation accepts this declaration:
  // the verdict `style.setProperty` succeeds or fails with
  // (style-mutations.watpart). The ABI separates the two failures the
  // caller must not confuse - `0` with no error kind is the author value
  // the grammar rejected, a nonzero kind is a native fault, which
  // `status` throws.
  specifiedValueAccepted(property, value) {
    return this.status(
      "specified_value_text",
      ...this.input(property),
      ...this.input(value),
      0,
    ) === 1;
  }

  fontShorthand(text) {
    const count = this.status("font_parse", ...this.input(text));
    const slots = this.decodeFieldSlots(count);
    if (count === 0 || slots[0].kind === 1) return null;
    const fields = {};
    for (const slot of slots) fields[slot.field] = slot.value;
    return fields;
  }

  transformComponents(text) {
    const count = this.status("transform_parse", ...this.input(text));
    const slots = this.decodeFieldSlots(count);
    if (count === 0 || slots[0].kind === 1) {
      throw new TypeError(`Invalid transform list: ${String(text).trim()}`);
    }
    const components = [];
    for (const slot of slots) {
      if (slot.transform === 2) {
        components[slot.side].value.push(...slot.value);
      } else {
        components[slot.side] = slot.value;
      }
    }
    return components;
  }

  computedCustomProperty(handle, name) {
    return this.string(
      "node_computed_custom_property",
      handle,
      ...this.input(name),
    );
  }

  styleGeneration(documentHandle) {
    return this.status("document_style_generation", documentHandle);
  }

  styleInvalidate(documentHandle) {
    this.status("document_style_invalidate", documentHandle);
  }
  // ownOnly: an ancestor reporting its own :focus-within. pointerState: the
  // change is :hover or :active (element_state_invalidate flags 1 and 2).
  stateInvalidate(elementHandle, ownOnly, pointerState) {
    this.status(
      "element_state_invalidate",
      elementHandle,
      (ownOnly ? 1 : 0) | (pointerState ? 2 : 0),
    );
  }

  // The elements under a root whose stored scroll-snap-type is not none.
  snapContainers(rootHandle) {
    const count = this.status("scene_snap_containers", rootHandle);
    const containers = new Array(count);
    for (let index = 0; index < count; index += 1) {
      containers[index] = this.wrapperFor(
        this.handle("selector_result_handle", index),
      );
    }
    return containers;
  }

  rootNode(handle, composed) {
    return this.wrapperFor(this.handle("node_root", handle, composed ? 1 : 0));
  }

  // Identities are host-owned; native records own registration and delivery.
  registerObserver(observer) {
    if (this.nextObserverId > 0xffffffff) {
      throw new RangeError("Observer identities exhausted");
    }
    const id = this.nextObserverId;
    this.nextObserverId += 1;
    this.observerFinalizer.register(observer, id);
    return id;
  }

  observe(observerId, handle, options) {
    const flags = (options.childList ? 1 : 0) | (options.attributes ? 2 : 0) |
      (options.characterData ? 4 : 0) | (options.subtree ? 8 : 0) |
      (options.attributeOldValue ? 16 : 0) |
      (options.characterDataOldValue ? 32 : 0) |
      (options.attributeFilter ? 64 : 0);
    this.status(
      "observer_observe",
      observerId,
      handle,
      flags,
      ...this.nullableInput(options.attributeFilter?.join("\n")),
    );
  }

  disconnectObserver(observerId) {
    this.status("observer_disconnect", observerId);
    this.observersById.delete(observerId);
  }

  callbackRecords() {
    const count = this.exports.callback_records_export();
    this.throwIfError();
    const recordSize = this.exports.callback_record_size();
    const base = this.exports.abi_output_pointer();
    const view = new DataView(this.memory.buffer, base, count * recordSize);
    const records = [];
    for (let index = 0; index < count; index += 1) {
      const offset = index * recordSize;
      records.push({
        kind: view.getUint32(offset, true),
        target: view.getBigUint64(offset + 8, true),
        relatedA: view.getBigUint64(offset + 16, true),
        relatedB: view.getBigUint64(offset + 24, true),
        previous: view.getBigUint64(offset + 32, true),
        next: view.getBigUint64(offset + 40, true),
        name: this.decoder.decode(
          this.refreshBytes().subarray(
            view.getUint32(offset + 48, true),
            view.getUint32(offset + 48, true) +
              view.getUint32(offset + 52, true),
          ),
        ),
        oldValue: this.decoder.decode(
          this.refreshBytes().subarray(
            view.getUint32(offset + 56, true),
            view.getUint32(offset + 56, true) +
              view.getUint32(offset + 60, true),
          ),
        ),
      });
    }
    this.exports.callback_records_acknowledge();
    scheduleMutationObservers(this);
    for (const record of records) {
      if (record.kind === 4) {
        this.moveWrapperCacheEntry(
          record.target,
          record.relatedA,
          record.relatedB,
        );
      }
    }
    for (const record of records) {
      if (record.kind === 6) {
        this.slotChangeHandler?.(this.wrapperFor(record.target));
      }
    }
    // Details toggle tasks the operation queued (details.watpart). The
    // entries are copied before wrapperFor can reenter the core.
    const toggleCount = this.exports.details_toggle_take();
    if (toggleCount !== 0) {
      const toggleView = new DataView(this.memory.buffer, this.exports.abi_output_pointer(), toggleCount * 16);
      const toggles = Array.from({ length: toggleCount }, (_, index) => [
        toggleView.getBigUint64(index * 16, true),
        toggleView.getUint32(index * 16 + 8, true) !== 0,
      ]);
      for (const [handle, wasOpen] of toggles) {
        this.detailsToggleHandler?.(this.wrapperFor(handle), wasOpen);
      }
    }
    return records;
  }

  dispose(documentHandle) {
    const releaseEventIdentities = this.eventDisposalHandler?.(
      this,
      documentHandle,
    );
    const documentToken = this.documentFinalizerTokens.get(documentHandle);
    if (documentToken) {
      this.documentFinalizerTokens.delete(documentHandle);
      documentFinalizer.unregister(documentToken);
    }
    this.cancelFinalizer(documentHandle);
    for (const handle of this.wrapperCaches.get(documentHandle)?.keys() ?? []) {
      this.wrapperByHandle.delete(handle);
      this.nodeTypes.delete(handle);
      this.cancelFinalizer(handle);
    }
    this.wrapperCaches.delete(documentHandle);
    this.status("document_dispose", documentHandle);
    releaseEventIdentities?.();
    for (const [id, observer] of this.observersById) {
      if (observer._ownerHandle === documentHandle) {
        this.observersById.delete(id);
      }
    }
    for (const [id, observer] of this.renderingObserversById ?? []) {
      if (observer._ownerHandle === documentHandle) {
        this.renderingObserversById.delete(id);
      }
    }
  }
}

export const sharedDomCore = new DomCore();
