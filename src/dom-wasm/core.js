import { scheduleMutationObservers } from "../dom/mutation-observer.js";
import { instantiateRendererCore } from "../wasm/renderer-core-binary.js";
import { hostNow } from "../host-clock.js";
import { encodeHostValues } from "../wasm/host-values.js";
import { domStringCodec } from "./dom-string-transport.js";
import {
  ANIMATION_RECORD_SIZE, LAYOUT_NODE_SIZE,
  LAYOUT_NODE_OFFSET_SHADOW_COUNT, LAYOUT_NODE_OFFSET_SHADOW_OFFSET,
  SHADOW_ENTRY_SIZE,
} from "../wasm/layout.js";
import {
  coreTransportPoolKinds,
  EngineFrameInputSize,
  EngineFrameResolutionSize,
  readEngineFrameOutput,
  readSvgPathDefinition,
  SceneBuildBoxFields,
  SceneBuildBoxSize
} from "./record-readers.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const STYLE_DIAGNOSTIC_INVALID_DECLARATION = layoutConstant("STYLE_DIAGNOSTIC_INVALID_DECLARATION");
// The kinds of a style sheet's diagnostics (css_sheet_diagnostic_at), by
// the code the core gives each one.
const STYLE_SHEET_DIAGNOSTICS = Object.freeze({
  [layoutConstant("CSS_DIAGNOSTIC_INVALID_DECLARATION")]: { code: "css-invalid-declaration", message: "Invalid declaration" },
  [layoutConstant("CSS_DIAGNOSTIC_UNIMPLEMENTED_PROPERTY")]: { code: "css-unimplemented-property", message: "Property that Sandom does not implement" },
  [layoutConstant("CSS_DIAGNOSTIC_UNSUPPORTED_VALUE")]: { code: "css-unsupported-value", message: "Value that is invalid or that Sandom does not implement" },
  [layoutConstant("CSS_DIAGNOSTIC_INVALID_SELECTOR")]: { code: "css-invalid-selector", message: "Invalid selector" },
  [layoutConstant("CSS_DIAGNOSTIC_UNIMPLEMENTED_SELECTOR")]: { code: "css-unimplemented-selector", message: "Selector that Sandom does not implement" },
  [layoutConstant("CSS_DIAGNOSTIC_INVALID_AT_RULE")]: { code: "css-invalid-at-rule", message: "Invalid at-rule" },
  [layoutConstant("CSS_DIAGNOSTIC_UNIMPLEMENTED_AT_RULE")]: { code: "css-unimplemented-at-rule", message: "At-rule that Sandom does not implement" },
});
const MATHML_DIAGNOSTIC_ELEMENT = layoutConstant("MATHML_DIAGNOSTIC_ELEMENT");
const COLOR_PARSED = layoutConstant("COLOR_PARSED");
const COLOR_CURRENT = layoutConstant("COLOR_CURRENT");
const NODE_STATE_HOVER = layoutConstant("NODE_STATE_HOVER");
const COMPUTED_CONTEXT_PENDING = layoutConstant("COMPUTED_CONTEXT_PENDING");
const TOKEN_RESULT = layoutConstant("TOKEN_RESULT");
const TOKEN_RESULT_WRITE = layoutConstant("TOKEN_RESULT_WRITE");
const CSS_REFERENCE_RECORD_KIND = layoutConstant("CSS_REFERENCE_RECORD_KIND");
const CSS_REFERENCE_RECORD_LENGTH = layoutConstant("CSS_REFERENCE_RECORD_LENGTH");
const CSS_REFERENCE_RECORD_REQUEST = layoutConstant("CSS_REFERENCE_RECORD_REQUEST");
const CSS_REFERENCE_RECORD_INTEGRITY_LENGTH = layoutConstant("CSS_REFERENCE_RECORD_INTEGRITY_LENGTH");
const CSS_REFERENCE_RECORD_HEADER_SIZE = layoutConstant("CSS_REFERENCE_RECORD_HEADER_SIZE");
const NODE_STATE_ACTIVE = layoutConstant("NODE_STATE_ACTIVE");
const FORCED_STATE_HOVER = layoutConstant("FORCED_STATE_HOVER");
const FORCED_STATE_ACTIVE = layoutConstant("FORCED_STATE_ACTIVE");
const FORCED_STATE_FOCUS = layoutConstant("FORCED_STATE_FOCUS");
const FORCED_STATE_FOCUS_VISIBLE = layoutConstant("FORCED_STATE_FOCUS_VISIBLE");
const FORCED_STATE_FOCUS_WITHIN = layoutConstant("FORCED_STATE_FOCUS_WITHIN");
const CASCADE_STATE_HOVER = layoutConstant("CASCADE_STATE_HOVER");
const CASCADE_STATE_ACTIVE = layoutConstant("CASCADE_STATE_ACTIVE");
// The host runner of a custom element reaction scope; src/dom/custom-elements.js
// registers it.
let customElementReactionRunner = null;
export function registerCustomElementReactionRunner(runner) {
  customElementReactionRunner = runner;
}
const LENGTH_RESULT = Object.freeze(Object.fromEntries(["KEYWORD", "PIXELS", "PERCENTAGE", "MIXED", "EXPRESSION"]
  .map((name) => [name, layoutConstant(`LENGTH_RESULT_${name}`)])));
const ENGINE_FRAME_RECORDED = layoutConstant("ENGINE_FRAME_RECORDED");
const ENGINE_FRAME_DECLINED = layoutConstant("ENGINE_FRAME_DECLINED");
const IMAGE_RESOURCE = Object.freeze(Object.fromEntries(["BACKGROUND", "MASK", "BORDER", "KIND_COUNT"]
  .map((name) => [name, layoutConstant(`IMAGE_RESOURCE_${name}`)])));
const STYLE_FAMILY_AVAILABLE = layoutConstant("STYLE_FAMILY_AVAILABLE");
const STYLE_FAMILY_REJECTED = layoutConstant("STYLE_FAMILY_REJECTED");
const STYLE_FAMILY_FAULT = layoutConstant("STYLE_FAMILY_FAULT");
const STYLE_MUTATION_RETHROW = layoutConstant("STYLE_MUTATION_RETHROW");
const ERROR_CLASS_TYPE_ERROR = layoutConstant("ERROR_CLASS_TYPE_ERROR");
const ERROR_CLASS_RANGE_ERROR = layoutConstant("ERROR_CLASS_RANGE_ERROR");
const ERROR_CLASS_DOM_EXCEPTION = layoutConstant("ERROR_CLASS_DOM_EXCEPTION");
const SPECIFIED_GRAMMAR_PROPERTY = layoutConstant("SPECIFIED_GRAMMAR_PROPERTY");
const OBSERVE_CHILD_LIST = layoutConstant("OBSERVE_CHILD_LIST");
const OBSERVE_ATTRIBUTES = layoutConstant("OBSERVE_ATTRIBUTES");
const OBSERVE_CHARACTER_DATA = layoutConstant("OBSERVE_CHARACTER_DATA");
const OBSERVE_SUBTREE = layoutConstant("OBSERVE_SUBTREE");
const OBSERVE_ATTRIBUTE_OLD_VALUE = layoutConstant("OBSERVE_ATTRIBUTE_OLD_VALUE");
const OBSERVE_CHARACTER_DATA_OLD_VALUE = layoutConstant("OBSERVE_CHARACTER_DATA_OLD_VALUE");
const OBSERVE_ATTRIBUTE_FILTER = layoutConstant("OBSERVE_ATTRIBUTE_FILTER");
const ANIMATION_KIND_SHADOW = layoutConstant("ANIMATION_KIND_SHADOW");
const COLOR_RGBA_SIZE = layoutConstant("COLOR_RGBA_SIZE");
const COLOR_RGBA_R = layoutConstant("COLOR_RGBA_R");
const COLOR_RGBA_G = layoutConstant("COLOR_RGBA_G");
const COLOR_RGBA_B = layoutConstant("COLOR_RGBA_B");
const COLOR_RGBA_A = layoutConstant("COLOR_RGBA_A");
const DAMAGE_RECT_SIZE = layoutConstant("DAMAGE_RECT_SIZE");
const DAMAGE_RECT_X = layoutConstant("DAMAGE_RECT_X");
const DAMAGE_RECT_Y = layoutConstant("DAMAGE_RECT_Y");
const DAMAGE_RECT_WIDTH = layoutConstant("DAMAGE_RECT_WIDTH");
const DAMAGE_RECT_HEIGHT = layoutConstant("DAMAGE_RECT_HEIGHT");
const COMMIT_GROUP_SIZE = layoutConstant("COMMIT_GROUP_SIZE");
const COMMIT_GROUP_FRAME = layoutConstant("COMMIT_GROUP_FRAME");
const COMMIT_GROUP_REVISION = layoutConstant("COMMIT_GROUP_REVISION");
const SELECTION_SPAN_SIZE = layoutConstant("SELECTION_SPAN_SIZE");
const SELECTION_SPAN_NODE = layoutConstant("SELECTION_SPAN_NODE");
const SELECTION_SPAN_START = layoutConstant("SELECTION_SPAN_START");
const SELECTION_SPAN_END = layoutConstant("SELECTION_SPAN_END");
const HANDLER_ELEMENT_SIZE = layoutConstant("HANDLER_ELEMENT_SIZE");
const HANDLER_ELEMENT_NODE = layoutConstant("HANDLER_ELEMENT_NODE");
const HANDLER_ELEMENT_LINE = layoutConstant("HANDLER_ELEMENT_LINE");
const HANDLER_ELEMENT_COLUMN = layoutConstant("HANDLER_ELEMENT_COLUMN");
const SELECTION_BOUNDARIES = Object.freeze(Object.fromEntries(["SIZE", "FIRST_NODE", "FIRST_OFFSET", "SECOND_NODE",
  "SECOND_OFFSET"].map((name) => [name, layoutConstant(`SELECTION_BOUNDARIES_${name}`)])));
const SELECTION_FOREIGN_PAIR = Object.freeze(Object.fromEntries(["SIZE", "RECORD", "DOCUMENT"]
  .map((name) => [name, layoutConstant(`SELECTION_FOREIGN_PAIR_${name}`)])));
const OKLAB_STOP_INTERPOLATED = layoutConstant("OKLAB_STOP_INTERPOLATED");
const OKLAB_STOP_OWN = layoutConstant("OKLAB_STOP_OWN");
const CSS_URL_START = layoutConstant("CSS_URL_START");
const CSS_URL_END = layoutConstant("CSS_URL_END");
const CSS_URL_LENGTH = layoutConstant("CSS_URL_LENGTH");
const CSS_URL_REQUEST = layoutConstant("CSS_URL_REQUEST");
const CSS_URL_INTEGRITY_LENGTH = layoutConstant("CSS_URL_INTEGRITY_LENGTH");
const CSS_URL_HEADER_SIZE = layoutConstant("CSS_URL_HEADER_SIZE");
const KEYFRAME_RECORD_SIZE = layoutConstant("KEYFRAME_RECORD_SIZE");
const KEYFRAME_RECORD_OFFSET = layoutConstant("KEYFRAME_RECORD_OFFSET");
const KEYFRAME_RECORD_FRAME = layoutConstant("KEYFRAME_RECORD_FRAME");
const KEYFRAME_RECORD_RULE = layoutConstant("KEYFRAME_RECORD_RULE");
const UNICODE_RANGE_SIZE = layoutConstant("UNICODE_RANGE_SIZE");
const RESOURCE_INFO_SIZE = layoutConstant("RESOURCE_INFO_SIZE");
const RESOURCE_INFO_FIELDS = Object.freeze([
  ["id", "RESOURCE_INFO_ID", "getUint32"], ["kind", "RESOURCE_INFO_KIND", "getUint32"],
  ["references", "RESOURCE_INFO_REFERENCES", "getUint32"], ["readiness", "RESOURCE_INFO_READINESS", "getUint32"],
  ["contentGeneration", "RESOURCE_INFO_CONTENT_GENERATION", "getUint32"],
  ["metricsGeneration", "RESOURCE_INFO_METRICS_GENERATION", "getUint32"],
  ["width", "RESOURCE_INFO_WIDTH", "getFloat64"], ["height", "RESOURCE_INFO_HEIGHT", "getFloat64"],
  ["failure", "RESOURCE_INFO_FAILURE", "getUint32"], ["revision", "RESOURCE_INFO_REVISION", "getUint32"],
].map(([name, constant, read]) => [name, layoutConstant(constant), read]));
const CANVAS_RESET_SIZE = layoutConstant("CANVAS_RESET_SIZE");
const CANVAS_RESET_WIDTH = layoutConstant("CANVAS_RESET_WIDTH");
const CANVAS_RESET_HEIGHT = layoutConstant("CANVAS_RESET_HEIGHT");
const CANVAS_RESET_CONTENT_GENERATION = layoutConstant("CANVAS_RESET_CONTENT_GENERATION");
const CANVAS_RESET_SIZE_CHANGED = layoutConstant("CANVAS_RESET_SIZE_CHANGED");
const CALLBACK_EFFECT_RETAIN = layoutConstant("CALLBACK_EFFECT_RETAIN");
const CALLBACK_EFFECT_SLOT_CHANGE = layoutConstant("CALLBACK_EFFECT_SLOT_CHANGE");
const CALLBACK_FIELD_EFFECTS = layoutConstant("CALLBACK_FIELD_EFFECTS");
const CALLBACK_FIELD_NOTIFY = layoutConstant("CALLBACK_FIELD_NOTIFY");
const CALLBACK_FIELD_KIND = layoutConstant("CALLBACK_FIELD_KIND");
const CALLBACK_FIELD_FLAGS = layoutConstant("CALLBACK_FIELD_FLAGS");
const CALLBACK_FIELD_TARGET = layoutConstant("CALLBACK_FIELD_TARGET");
const CALLBACK_FIELD_RELATED_A = layoutConstant("CALLBACK_FIELD_RELATED_A");
const CALLBACK_FIELD_RELATED_B = layoutConstant("CALLBACK_FIELD_RELATED_B");
const CALLBACK_FIELD_PREVIOUS = layoutConstant("CALLBACK_FIELD_PREVIOUS");
const CALLBACK_FIELD_NEXT = layoutConstant("CALLBACK_FIELD_NEXT");
const CALLBACK_FIELD_NAME_POINTER = layoutConstant("CALLBACK_FIELD_NAME_POINTER");
const CALLBACK_FIELD_NAME_LENGTH = layoutConstant("CALLBACK_FIELD_NAME_LENGTH");
const CALLBACK_FIELD_OLD_VALUE_POINTER = layoutConstant("CALLBACK_FIELD_OLD_VALUE_POINTER");
const CALLBACK_FIELD_OLD_VALUE_LENGTH = layoutConstant("CALLBACK_FIELD_OLD_VALUE_LENGTH");
const CALLBACK_FLAG_OLD_VALUE_ABSENT = layoutConstant("CALLBACK_FLAG_OLD_VALUE_ABSENT");
const CALLBACK_FLAG_MOVED = layoutConstant("CALLBACK_FLAG_MOVED");
const CALLBACK_RECORD_CHILD_LIST = layoutConstant("CALLBACK_RECORD_CHILD_LIST");
const DETAILS_TOGGLE_SIZE = layoutConstant("DETAILS_TOGGLE_SIZE");
const DETAILS_TOGGLE_NODE = layoutConstant("DETAILS_TOGGLE_NODE");
const DETAILS_TOGGLE_TOKEN = layoutConstant("DETAILS_TOGGLE_TOKEN");
const INDEX_REMAP_SIZE = layoutConstant("INDEX_REMAP_SIZE");
const INDEX_REMAP_PREVIOUS = layoutConstant("INDEX_REMAP_PREVIOUS");
const INDEX_REMAP_NEXT = layoutConstant("INDEX_REMAP_NEXT");
const SVG_PATH_BOUNDS_X_MIN = layoutConstant("SVG_PATH_BOUNDS_X_MIN");
const SVG_PATH_BOUNDS_Y_MIN = layoutConstant("SVG_PATH_BOUNDS_Y_MIN");
const SVG_PATH_BOUNDS_X_MAX = layoutConstant("SVG_PATH_BOUNDS_X_MAX");
const SVG_PATH_BOUNDS_Y_MAX = layoutConstant("SVG_PATH_BOUNDS_Y_MAX");
const FRAME_MEASUREMENT = Symbol.for("sandom.domCore.measurement");

const resourceMeasurementKey = Symbol.for("sandom.domCore.measurement");

const measurementKey = Symbol.for("sandom.domCore.measurement");

const wrapperCores = new WeakMap();
const applyNative = Reflect.apply;

export function domCoreForWrapper(wrapper) {
  return wrapperCores.get(wrapper);
}

// A failure of a renderer-core export (a trap, or an exhausted WebAssembly
// stack) carries the state of its call under this key: the export, its
// arguments, the memory size and the allocator's state. A fault that does
// not repeat can then be diagnosed from its one report; the test runner
// writes the record into the test result (scripts/test-runner-execution.js).
export const WASM_EXPORT_FAILURE = Symbol.for("sandom.wasmExportFailure");

function failureArgument(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "bigint" ? `${value}n` : String(value);
}

// The allocator's state comes from its exported globals
// (core/dom/memory.watpart), not from a call into the module that
// failed.
function wasmExportFailureState(name, args, memory, exports) {
  const global = (key) => exports[key]?.value ?? null;
  return {
    export: name,
    arguments: Array.from(args, failureArgument),
    memoryBytes: memory.buffer.byteLength,
    allocator: {
      heapCursor: global("abi_heap_cursor_value"),
      retainedBytes: global("abi_retained_bytes_value"),
      transientCurrent: global("abi_transient_current_value"),
      transientPrevious: global("abi_transient_previous_value"),
      recordOwnedHead: global("abi_record_owned_head_value"),
    },
  };
}

// Wraps a module's exports so a memory growth inside any call is reported
// before the caller can read a detached view. Only the DOM core's allocator
// grows the shared memory, but it is reached from the engine's shaping
// calls (through HarfBuzz) as well as from the core's own operations, so
// both export sets are observed. A failed call records its state on the
// error (WASM_EXPORT_FAILURE).
export function observeMemoryGrowth(memory, exports, notify) {
  let buffer = memory.buffer;
  const wrapped = {};
  const observe = () => {
    const nextBuffer = memory.buffer;
    if (nextBuffer !== buffer) {
      buffer = nextBuffer;
      notify();
    }
  };
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = function () {
      let result;
      try {
        result = applyNative(value, null, arguments);
      } catch (error) {
        // The export's own failure has precedence over a failure of the
        // record or the notification. After a normal return, a
        // notification failure is the only failure and remains visible.
        try {
          if (error instanceof Error && Object.isExtensible(error)) {
            error[WASM_EXPORT_FAILURE] = wasmExportFailureState(name, arguments, memory, exports);
          }
        } catch {
          // The export's failure below is the failure of the call.
        }
        try {
          observe();
        } catch {
          // The export's failure below is the failure of the call.
        }
        throw error;
      }
      observe();
      return result;
    };
  }
  return Object.freeze(wrapped);
}

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

// Each wrapper registration owns one retain of its handle. Its entry
// ({ reference }, the wrapper's WeakRef) is also its unregister token, so
// one registration can be cancelled without the others of the same handle.
// A registration ends exactly once: by its finalizer, by
// `releaseCollectedWrappers` once its WeakRef is cleared, or by `dispose`,
// which cancels it because the disposal frees the handle.
const wrapperFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ coreReference, handle, entry }) => {
    coreReference.deref()?.releaseWrapperRegistration(handle, entry);
  })
  : null;

function rgba(view, offset) {
  return {
    r: view.getFloat64(offset + COLOR_RGBA_R, true),
    g: view.getFloat64(offset + COLOR_RGBA_G, true),
    b: view.getFloat64(offset + COLOR_RGBA_B, true),
    a: view.getFloat64(offset + COLOR_RGBA_A, true),
  };
}

// The document wrappers whose core tree a disposal freed: work that a
// document queued before its disposal (a style reconcile) finds it here and
// does not run.
const disposedDocuments = new WeakSet();

// A document whose wrapper is unreachable (every node wrapper of a document
// keeps its document wrapper alive) has no host reference left; its core
// tree is disposed so a long-lived process does not accumulate documents.
const documentFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ coreReference, handle }) => {
    const core = coreReference.deref();
    if (!core) return;
    core.documentFinalizerEntries.delete(handle);
    core.dispose(handle);
  })
  : null;

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

// SANDOM_SCENE_CACHE_VERIFY=1 builds each scene twice, with the subtree
// cache and without it, and fails a build whose rows differ
// (core/dom/scene-cache.watpart). Tests and probes set it.
const sceneCacheVerify = globalThis.Deno?.permissions?.querySync?.({ name: "env", variable: "SANDOM_SCENE_CACHE_VERIFY" })
    .state === "granted" && globalThis.Deno.env.get("SANDOM_SCENE_CACHE_VERIFY") === "1";

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
    if (sceneCacheVerify) instance.exports.scene_cache_verify(1);
    const measurement = globalThis[measurementKey];
    this.exports = measurement
      ? measurement.wrapExports(this.nativeExports, "core")
      : this.nativeExports;
    // The error kind and output registers, read without a call.
    this.errorKindRegister = instance.exports.abi_error_kind_value;
    this.outputPointerRegister = instance.exports.abi_output_pointer_value;
    this.outputLengthRegister = instance.exports.abi_output_length_value;
    this.detailsToggleCountRegister = instance.exports.details_toggle_count_value;
    this.selectedContentPendingRegister = instance.exports.selected_content_pending_value;
    this.ownerEpochRegister = instance.exports.node_owner_epoch_value;
    this.backupReactionsRegister = instance.exports.custom_reactions_backup;
    // HTML "processing the backup element queue" flag.
    this.backupReactionsQueued = false;
    this.selectionDocumentEpochRegister = instance.exports.selection_document_epoch_value;
    this.callbackRecordSize = instance.exports.callback_record_size();
    // The DOMString transport (dom-string-transport.js): lossless for lone
    // surrogates, equal to UTF-8 for well-formed text.
    this.encoder = domStringCodec;
    this.decoder = domStringCodec;
    this.bytes = new Uint8Array(this.memory.buffer);
    this.wrapperCaches = new Map();
    this.wrapperHandles = new WeakMap();
    this.wrapperFactory = null;
    // Observer id to a WeakRef of its MutationObserver, for delivery. An
    // observing observer stays alive while its document wrapper does
    // (observingObserversByDocument), so an observer that is never
    // disconnected does not keep its document from being collected.
    this.observersById = new Map();
    this.observingObserversByDocument = new WeakMap();
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
        bytes: count * DAMAGE_RECT_SIZE,
        allocations: count + 1,
      });
    }
    return Array.from({ length: count }, (_, index) => {
      const at = pointer + index * DAMAGE_RECT_SIZE;
      return {
        x: view.getFloat64(at + DAMAGE_RECT_X, true),
        y: view.getFloat64(at + DAMAGE_RECT_Y, true),
        width: view.getFloat64(at + DAMAGE_RECT_WIDTH, true),
        height: view.getFloat64(at + DAMAGE_RECT_HEIGHT, true),
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
      COLOR_RGBA_SIZE,
    );
    return rgba(view, 0);
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
    const pointer = this.exports.abi_allocate(entries.length * COMMIT_GROUP_SIZE);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < entries.length; index++) {
      const at = pointer + index * COMMIT_GROUP_SIZE;
      view.setBigUint64(at + COMMIT_GROUP_FRAME, entries[index].handle, true);
      view.setBigUint64(at + COMMIT_GROUP_REVISION, entries[index].revision, true);
    }
    const measurement = globalThis[FRAME_MEASUREMENT];
    if (measurement) {
      measurement.record({
        category: "lifecycle",
        operation: "frame_commit_group",
        direction: "host-to-core",
        bytes: entries.length * COMMIT_GROUP_SIZE,
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
      view.setUint16(index * Uint16Array.BYTES_PER_ELEMENT, left.charCodeAt(index), true);
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

  // A host value list (core/engine/host-values.watpart).
  valueListInput(values, options = undefined) {
    return this.byteInput(encodeHostValues(values, options));
  }

  outputString() {
    const pointer = this.outputPointerRegister.value;
    const length = this.outputLengthRegister.value;
    const measurement = globalThis[measurementKey];
    const start = measurement ? hostNow() : 0;
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
        milliseconds: hostNow() - start,
      });
    }
    return result;
  }

  // The core reports the message and the exception class of its error
  // (abi_error_report); `rawMessage` asks for the message without its
  // detail numbers, for a caller that names the subject itself. When the
  // call put the first reaction into the backup element queue
  // (custom_reactions_backup), a microtask processes that queue.
  throwIfError(rawMessage = false) {
    if (this.backupReactionsRegister.value !== 0n && !this.backupReactionsQueued) this.queueBackupReactions();
    if (this.errorKindRegister.value !== 0) throw this.currentError(rawMessage);
  }

  queueBackupReactions() {
    this.backupReactionsQueued = true;
    queueMicrotask(() => {
      try {
        const handle = this.handle("custom_reactions_backup_begin");
        if (handle !== 0n) customElementReactionRunner(this, handle);
      } finally {
        this.backupReactionsQueued = false;
      }
    });
  }

  currentError(rawMessage) {
    const errorClass = this.exports.abi_error_report(rawMessage ? 1 : 0);
    const message = this.outputString();
    if (errorClass === ERROR_CLASS_TYPE_ERROR) return new TypeError(message);
    if (errorClass === ERROR_CLASS_RANGE_ERROR) return new RangeError(message);
    if (errorClass === ERROR_CLASS_DOM_EXCEPTION && typeof DOMException === "function") {
      this.exports.abi_error_name();
      return new DOMException(message, this.outputString());
    }
    return new Error(message);
  }

  status(exportName, ...parameters) {
    const native = this.exports;
    const result = applyNative(native[exportName], native, parameters);
    this.throwIfError();
    return result;
  }

  // As status(), for an operation whose error message names its reason
  // and limit itself: the caller adds the subject and the observed value,
  // so the message carries no detail numbers.
  statusRaw(exportName, ...parameters) {
    const native = this.exports;
    const result = applyNative(native[exportName], native, parameters);
    this.throwIfError(true);
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

  // Range and Selection wrappers by record handle (src/dom/selection.js).
  // A Range holds its boundary nodes, and a node holds its node document,
  // so a wrapper keeps the wrapper of each other document that a boundary
  // of its record is in (`_boundaryDocuments`), as the core reports it
  // (selection_foreign_changes). The core frees such a document's nodes
  // only after the record lets it go (document_dispose).
  selectionRecords = new Map();
  selectionDocumentEpoch = 0;

  // Brings `_boundaryDocuments` up to date after a change that can move a
  // boundary into or out of another document: an adoption (delivered by
  // callbackRecords) or a Range or Selection operation. The core reports
  // only the records that changed; document 0 means none.
  syncSelectionDocuments() {
    const epoch = this.selectionDocumentEpochRegister.value;
    if (epoch === this.selectionDocumentEpoch) return;
    this.selectionDocumentEpoch = epoch;
    const count = this.status("selection_foreign_changes");
    const view = new DataView(this.refreshBytes().buffer, this.exports.abi_output_pointer(), count * SELECTION_FOREIGN_PAIR.SIZE);
    const documents = new Map();
    for (let index = 0; index < count; index += 1) {
      const pair = index * SELECTION_FOREIGN_PAIR.SIZE;
      const handle = view.getBigUint64(pair + SELECTION_FOREIGN_PAIR.RECORD, true);
      const document = view.getBigUint64(pair + SELECTION_FOREIGN_PAIR.DOCUMENT, true);
      if (!documents.has(handle)) documents.set(handle, []);
      if (document !== 0n) documents.get(handle).push(document);
    }
    for (const [handle, handles] of documents) {
      const record = this.selectionRecords.get(handle)?.reference.deref();
      if (!record) continue;
      // A document wrapper cannot be made again: only a live one is held.
      record._boundaryDocuments = handles.length === 0
        ? null
        : handles.map((document) => this.wrapperByHandle.get(document)?.deref() ?? null);
    }
  }

  forgetSelectionRecord(handle) {
    this.selectionRecords.delete(handle);
  }

  // Releases the native record of a Range or Selection wrapper once: `entry`
  // is the wrapper's record entry (src/dom/selection.js), and an entry that
  // is no longer the handle's was already released.
  releaseSelectionRecord(handle, entry) {
    if (entry === undefined || this.selectionRecords.get(handle) !== entry) return;
    this.forgetSelectionRecord(handle);
    this.status("selection_release", handle);
  }

  selectionBoundaries(handle, ordered = false) {
    if (
      !this.selectionStatus(
        ordered ? "selection_ordered_export" : "selection_export",
        handle,
      )
    ) return null;
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer, pointer, SELECTION_BOUNDARIES.SIZE);
    const first = view.getBigUint64(SELECTION_BOUNDARIES.FIRST_NODE, true);
    const firstOffset = view.getFloat64(SELECTION_BOUNDARIES.FIRST_OFFSET, true);
    const second = view.getBigUint64(SELECTION_BOUNDARIES.SECOND_NODE, true);
    const secondOffset = view.getFloat64(SELECTION_BOUNDARIES.SECOND_OFFSET, true);
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
    const view = new DataView(this.refreshBytes().buffer, pointer, count * SELECTION_SPAN_SIZE);
    // Capture all transient facts before wrapper construction or data access
    // enters another operation; no native pointer crosses a host callback.
    const spans = new Array(count);
    for (let index = 0; index < count; index++) {
      spans[index] = [
        view.getBigUint64(index * SELECTION_SPAN_SIZE + SELECTION_SPAN_NODE, true),
        view.getUint32(index * SELECTION_SPAN_SIZE + SELECTION_SPAN_START, true),
        view.getUint32(index * SELECTION_SPAN_SIZE + SELECTION_SPAN_END, true),
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

  // The record-driven HTML parser (src/dom/html.js beginHTMLDocumentParse).
  // Strings enter as UTF-8; the insertion point is the number of input
  // bytes after it, or -1 when it is undefined.
  htmlParserBegin(documentHandle, scripting) {
    return this.status("html_parser_begin", documentHandle, scripting ? 1 : 0);
  }

  htmlParserAppend(parser, source) {
    return this.status("html_parser_append", parser, ...this.input(source));
  }

  htmlParserInsert(parser, source) {
    return this.status("html_parser_insert", parser, ...this.input(source));
  }

  htmlParserEnd(parser) {
    return this.status("html_parser_end", parser);
  }

  htmlParserRun(parser, toInsertionPoint) {
    return this.status("html_parser_run", parser, toInsertionPoint ? 1 : 0);
  }

  htmlParserScript(parser) {
    return this.handle("html_parser_script", parser);
  }

  // 1-based line and 0-based UTF-16 column of the paused script's text.
  htmlParserScriptPosition(parser) {
    return {
      line: this.status("html_parser_script_line", parser),
      column: this.status("html_parser_script_column", parser),
    };
  }

  // The parser's position after its last token: 1-based line, 0-based
  // UTF-16 column.
  htmlParserPosition(parser) {
    const line = this.status("html_parser_line", parser);
    return { line, column: this.status("html_parser_column", parser) };
  }

  // The elements with event handler attributes that the parser created
  // since the last call, each with the position after its start tag.
  htmlParserTakeHandlerElements(parser) {
    const count = this.status("html_parser_take_handler_elements", parser);
    if (count === 0) return [];
    const view = new DataView(this.memory.buffer, this.exports.abi_output_pointer(), count * HANDLER_ELEMENT_SIZE);
    // Copy the numbers before wrapper materialization can grow memory.
    const entries = Array.from({ length: count }, (_, index) => ({
      handle: view.getBigUint64(index * HANDLER_ELEMENT_SIZE + HANDLER_ELEMENT_NODE, true),
      line: view.getUint32(index * HANDLER_ELEMENT_SIZE + HANDLER_ELEMENT_LINE, true),
      column: view.getUint32(index * HANDLER_ELEMENT_SIZE + HANDLER_ELEMENT_COLUMN, true),
    }));
    return entries.map(({ handle, line, column }) => ({ element: this.wrapperFor(handle), line, column }));
  }

  htmlParserMarkInsertionPoint(parser) {
    return this.status("html_parser_mark_insertion_point", parser);
  }

  htmlParserInsertionPoint(parser) {
    return this.status("html_parser_insertion_point", parser);
  }

  htmlParserSetInsertionPoint(parser, bytesAfter) {
    return this.status("html_parser_set_insertion_point", parser, bytesAfter);
  }

  htmlParserOpen(parser, handle) {
    return this.status("html_parser_open", parser, handle) === 1;
  }

  htmlParserAbort(parser) {
    return this.status("html_parser_abort", parser);
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

  // The wrappers of the `count` u64 node handles in standard output. The
  // handles are copied before wrapperFor can reenter the core.
  outputNodes(count) {
    if (count <= 0) return [];
    const view = new DataView(this.refreshBytes().buffer, this.exports.abi_output_pointer(), count * BigUint64Array.BYTES_PER_ELEMENT);
    const handles = Array.from({ length: count }, (_, index) => view.getBigUint64(index * BigUint64Array.BYTES_PER_ELEMENT, true));
    return handles.map((handle) => this.wrapperFor(handle));
  }

  // The nodes of a root that a collection filter accepts, and the named
  // item among them (node_collection_list, form-collections.watpart).
  collectionList(rootHandle, scope, filter, a, b) {
    return this.outputNodes(this.status("node_collection_list", rootHandle, scope, filter, ...this.input(a), ...this.input(b)));
  }

  collectionListNamed(rootHandle, scope, filter, a, b, name) {
    return this.wrapperFor(this.handle("node_collection_list_named", rootHandle, scope, filter,
      ...this.input(a), ...this.input(b), ...this.input(name)));
  }

  slotAssign(slotHandle, nodeHandles) {
    const pointer = this.exports.abi_allocate(nodeHandles.length * 8);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < nodeHandles.length; index += 1) {
      view.setBigUint64(pointer + index * BigUint64Array.BYTES_PER_ELEMENT, nodeHandles[index], true);
    }
    this.status("slot_assign", slotHandle, pointer, nodeHandles.length);
  }

  assignedSlot(handle) {
    return this.wrapperFor(this.handle("slot_assigned_slot", handle));
  }

  assignedNodes(slotHandle, flatten) {
    return this.resultHandles(this.status("slot_assigned_nodes", slotHandle, flatten ? 1 : 0));
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

  createElement(documentHandle, namespaceURI, localName) {
    return this.handle(
      "node_create_element_local",
      documentHandle,
      ...this.nullableInput(namespaceURI),
      ...this.input(localName),
    );
  }

  createPublicElement(documentHandle, namespaceURI, name, contentType, namespaceAware) {
    return this.handle(
      "node_create_element_public", documentHandle,
      ...this.nullableInput(namespaceURI), ...this.input(name),
      ...this.input(contentType), namespaceAware ? 1 : 0,
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

  // Decode core-owned resource usages in CSS order for the element
  // (pseudo 0), its ::before (1) or its ::after (2). Device acquisition is
  // separate; these IDs remain stable across builds and shared renderers.
  sceneResourceLayers(handle, pseudo) {
    const count = this.status("scene_resource_layers", handle, pseudo);
    if (count === 0) return null;
    const counts = new Uint32Array(this.refreshBytes().buffer, this.exports.abi_output_pointer(), IMAGE_RESOURCE.KIND_COUNT).slice();
    const result = {};
    let index = 0;
    for (const [kind, name] of [[IMAGE_RESOURCE.BACKGROUND, "backgroundImages"], [IMAGE_RESOURCE.MASK, "masks"], [IMAGE_RESOURCE.BORDER, "borderImage"]]) {
      const layers = new Array(counts[kind]);
      for (let layer = 0; layer < layers.length; layer++, index++) {
        const resource = this.handle("scene_resource_layer", handle, pseudo, index);
        layers[layer] = resource === 0n ? {} : {
          src: this.resourceKey(resource),
          resourceIdentifier: this.resourceId(resource),
        };
      }
      if (layers.length) result[name] = kind === IMAGE_RESOURCE.BORDER ? layers[0] : layers;
    }
    return result;
  }

  // The wrapper cache of a document handle (node_owner_document of a node;
  // 0 for documents).
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

  // The wrapper registrations of each handle (node wrappers and document
  // wrappers): a Set of entries, one per registration. A collected
  // wrapper's WeakRef clears before its finalizer runs, so `wrapperFor` can
  // wrap the same handle again (with its own retain) while the first
  // registration is still pending.
  finalizerRegistrations = new Map();
  // Per document handle, the entry of its wrapper's document finalizer:
  // { reference }, also its unregister token.
  documentFinalizerEntries = new Map();

  // The wrappers of the nodes in a document's tree, keyed by the document's
  // wrapper. A script can reach a connected node through its document at
  // any time, so the node keeps one wrapper, with its expandos and the host
  // state keyed by it, while the document wrapper lives. The key is weak:
  // every node wrapper keeps its document wrapper, so a document wrapper
  // that nothing else reaches is collected with the wrappers of its tree,
  // and its finalizer disposes the document. A node that leaves the tree
  // (removal, adoption) leaves the set, and its wrapper is weak again, as
  // the wrapper of every detached node is. A node that no script reached has
  // no wrapper and is in no set.
  connectedWrappersByDocument = new WeakMap();
  // The set of connectedWrappersByDocument that holds a node wrapper.
  connectedWrapperHolders = new WeakMap();

  // Holds `wrapper` in the connected wrappers of `documentWrapper`, or in
  // no set when `documentWrapper` is undefined.
  holdConnectedWrapper(wrapper, documentWrapper) {
    const holder = this.connectedWrapperHolders.get(wrapper);
    let wrappers;
    if (documentWrapper !== undefined) {
      wrappers = this.connectedWrappersByDocument.get(documentWrapper);
      if (!wrappers) this.connectedWrappersByDocument.set(documentWrapper, wrappers = new Set());
    }
    if (holder === wrappers) return;
    holder?.delete(wrapper);
    if (wrappers === undefined) {
      this.connectedWrapperHolders.delete(wrapper);
      return;
    }
    wrappers.add(wrapper);
    this.connectedWrapperHolders.set(wrapper, wrappers);
  }

  // The wrapper of the document whose tree node `handle` is in; undefined
  // for a node that is not connected.
  connectedDocumentWrapper(handle) {
    if (this.status("node_is_connected", handle) !== 1) return undefined;
    return this.wrapperByHandle.get(this.handle("node_owner_document", handle))?.deref();
  }

  // The durable identifier the core gave node `handle` when it created it
  // (core/dom/node-identity.watpart).
  nodeIdentifier(handle) {
    return this.status("node_identifier", handle);
  }

  // The wrapper of the live node of `identifier` in document
  // `documentHandle`, or null.
  nodeByIdentifier(documentHandle, identifier) {
    return this.wrapperFor(this.handle("node_by_identifier", documentHandle, identifier));
  }

  // Settles the wrappers of the subtree of `rootHandle`, which entered or
  // left a document tree, against the tree: the core lists the nodes of the
  // subtree with a host reference (node_retained_subtree), which include
  // every node with a wrapper. The subtree shares one root, so one
  // connectedness holds for all of them.
  updateConnectedWrappers(rootHandle) {
    const documentWrapper = this.connectedDocumentWrapper(rootHandle);
    const count = this.status("node_retained_subtree", rootHandle);
    if (count <= 0) return;
    const view = new DataView(this.refreshBytes().buffer, this.exports.abi_output_pointer(), count * BigUint64Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < count; index += 1) {
      const wrapper = this.wrapperByHandle.get(view.getBigUint64(index * BigUint64Array.BYTES_PER_ELEMENT, true))?.deref();
      if (wrapper !== undefined) this.holdConnectedWrapper(wrapper, documentWrapper);
    }
  }

  registerDocumentWrapper(wrapper, handle) {
    if (!documentFinalizer) return;
    const entry = { reference: new WeakRef(wrapper) };
    this.documentFinalizerEntries.set(handle, entry);
    documentFinalizer.register(wrapper, {
      coreReference: new WeakRef(this),
      handle,
    }, entry);
  }

  registerWrapper(wrapper, handle, retained, documentHandle) {
    this.wrapperHandles.set(wrapper, handle);
    wrapperCores.set(wrapper, this);
    const existingReference = this.wrapperByHandle.get(handle);
    const reference = existingReference?.deref() === wrapper ? existingReference : new WeakRef(wrapper);
    this.wrapperByHandle.set(handle, reference);
    this.documentWrapperCache(documentHandle).set(handle, reference);
    if (wrapperFinalizer && retained) {
      let entries = this.finalizerRegistrations.get(handle);
      if (!entries) {
        entries = new Set();
        this.finalizerRegistrations.set(handle, entries);
      }
      const entry = { reference };
      entries.add(entry);
      wrapperFinalizer.register(wrapper, { coreReference: new WeakRef(this), handle, entry }, entry);
    }
  }

  // Ends one wrapper registration of `handle`: gives its retain back, and
  // with the handle's last registration drops its cached state. An entry
  // that already ended is ignored.
  releaseWrapperRegistration(handle, entry) {
    const entries = this.finalizerRegistrations.get(handle);
    if (!entries?.delete(entry)) return;
    if (this.wrapperByHandle.get(handle) === entry.reference) this.wrapperByHandle.delete(handle);
    if (entries.size === 0) {
      this.finalizerRegistrations.delete(handle);
      this.nodeTypes.delete(handle);
    }
    this.status("node_release", handle);
  }

  // Ends now what the collector has taken, as the finalizers would in later
  // tasks: the native record of each collected Range or Selection wrapper,
  // each registration of a collected node wrapper, and each document whose
  // wrapper was collected (disposed). Their finalizers are cancelled. A host
  // calls it after a collection to reach the core state the finalizers will
  // leave, without waiting for their tasks. Returns the number of records,
  // registrations and documents ended.
  releaseCollectedWrappers() {
    let released = 0;
    for (const [handle, entry] of [...this.selectionRecords]) {
      if (entry.reference.deref() !== undefined) continue;
      entry.cancel();
      this.releaseSelectionRecord(handle, entry);
      released += 1;
    }
    for (const [handle, entries] of [...this.finalizerRegistrations]) {
      for (const entry of [...entries]) {
        if (entry.reference.deref() !== undefined) continue;
        wrapperFinalizer.unregister(entry);
        this.releaseWrapperRegistration(handle, entry);
        released += 1;
      }
    }
    for (const [handle, entry] of [...this.documentFinalizerEntries]) {
      if (entry.reference.deref() !== undefined) continue;
      this.documentFinalizerEntries.delete(handle);
      documentFinalizer.unregister(entry);
      this.dispose(handle);
      released += 1;
    }
    return released;
  }

  cancelFinalizer(handle) {
    const entries = this.finalizerRegistrations.get(handle);
    if (!entries) return;
    this.finalizerRegistrations.delete(handle);
    for (const entry of entries) wrapperFinalizer.unregister(entry);
  }

  handleForWrapper(wrapper) {
    return this.wrapperHandles.get(wrapper) ?? 0n;
  }

  wrapperFor(handle) {
    if (handle === 0n) return null;
    const live = this.wrapperByHandle.get(handle)?.deref();
    if (live) return live;
    const ownerHandle = this.handle("node_owner_document", handle);
    const cache = this.documentWrapperCache(ownerHandle);
    const existing = cache.get(handle)?.deref();
    if (existing) return existing;
    if (!this.wrapperFactory) {
      throw new Error(`No wrapper factory for DOM core handle ${handle}`);
    }
    this.status("node_retain", handle);
    const wrapper = this.wrapperFactory(handle, ownerHandle);
    this.registerWrapper(wrapper, handle, true, ownerHandle);
    // The wrapper of a node in a document's tree lives with that tree.
    if (ownerHandle !== 0n && this.status("node_is_connected", handle) === 1) {
      this.holdConnectedWrapper(wrapper, this.wrapperByHandle.get(ownerHandle)?.deref());
    }
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

  // A child by index, or null past the end (a collection read).
  childAt(handle, index) {
    return this.wrapperFor(this.handle("node_child_at", handle, index));
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

  moveBefore(parentHandle, nodeHandle, childHandle) {
    return this.status("node_move_before", parentHandle, nodeHandle, childHandle);
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
      (hovered ? NODE_STATE_HOVER : 0) | (active ? NODE_STATE_ACTIVE : 0),
    );
  }

  // Forced user action pseudo-classes (core/dom/forced-state.watpart).
  // Returns whether the forced set changed.
  setForcedState(handle, { hover = false, active = false, focus = false, focusVisible = false, focusWithin = false }) {
    return this.status(
      "element_forced_state_set",
      handle,
      (hover ? FORCED_STATE_HOVER : 0) | (active ? FORCED_STATE_ACTIVE : 0) | (focus ? FORCED_STATE_FOCUS : 0) |
        (focusVisible ? FORCED_STATE_FOCUS_VISIBLE : 0) | (focusWithin ? FORCED_STATE_FOCUS_WITHIN : 0),
    ) === 1;
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

  setAttribute(handle, qualifiedName, value) {
    return this.status(
      "attribute_set",
      handle,
      ...this.nullableInput(null),
      ...this.input(qualifiedName),
      ...this.input(value),
    );
  }

  setAttributeNS(handle, namespaceURI, qualifiedName, value) {
    return this.status(
      "attribute_set_ns",
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

  // DOMTokenList: the native ordered set of the attribute `name`
  // (token_list_*). tokenListUpdate returns the operation's result and the
  // serialized set that the update steps write, or null when they do not
  // run.
  tokenListCount(handle, name) {
    return this.status("token_list_count", handle, ...this.input(name));
  }

  tokenListItem(handle, name, index) {
    return this.string("token_list_item", handle, ...this.input(name), index);
  }

  tokenListContains(handle, name, token) {
    return this.status("token_list_contains", handle, ...this.input(name), ...this.input(token)) === 1;
  }

  tokenListUpdate(handle, name, mode, force, tokens) {
    const encoded = tokens.map((token) => this.encoder.encode(token));
    const bytes = new Uint8Array(encoded.reduce((total, token) => total + token.byteLength + 1, 0));
    let offset = 0;
    for (const token of encoded) {
      bytes.set(token, offset);
      offset += token.byteLength;
      bytes[offset++] = 0xff;
    }
    const nameInput = this.input(name);
    const result = this.status("token_list_update", handle, ...nameInput, mode, force,
      ...this.byteInput(bytes), tokens.length);
    return {
      result: (result & TOKEN_RESULT) !== 0,
      value: (result & TOKEN_RESULT_WRITE) === 0 ? null : this.outputString(),
    };
  }

  attributeStringAt(exportName, handle, index) {
    const result = this.exports[exportName](handle, index);
    this.throwIfError();
    return result === 0 ? null : this.outputString();
  }

  // `document`: the owner document of the element, whose @font-face
  // families a font-family value can name; null for none.
  styleSet(
    handle,
    name,
    value,
    priority = "",
    mode = 0,
    registry = this.defaultFontRegistry,
    document = null,
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
    return this.runStyleMutation(operation, registry, document);
  }

  stylePriority(handle, name) {
    return this.string("style_get_priority", handle, ...this.input(name));
  }

  styleRemove(handle, name) {
    this.status("style_remove", handle, ...this.input(name));
    return this.outputString();
  }

  styleCount(handle) {
    return this.status("style_count", handle);
  }

  styleRead(handle, name) {
    return this.string("style_read", handle, ...this.input(name));
  }

  styleText(handle) {
    return this.string("style_text", handle);
  }

  styleReplace(
    handle,
    source,
    attributeReplay = false,
    registry = this.defaultFontRegistry,
    document = null,
  ) {
    const operation = this.handle(
      "style_replace",
      handle,
      ...this.input(source),
      registry.fontCatalogHandle,
      attributeReplay ? 1 : 0,
    );
    return this.runStyleMutation(operation, registry, document);
  }

  runStyleMutation(operation, registry, document) {
    try {
      while (true) {
        const step = this.status("style_mutation_next", operation);
        if (step === 0) return this.status("style_mutation_result", operation);
        // A rejected value completes the mutation; a fault (-1) sets the
        // ABI error registers, which status() throws.
        if (step !== 1) throw new Error(`style_mutation_next returned ${step} without an ABI error`);
        this.answerStyleFamily(operation, registry, document);
      }
    } finally {
      this.status("style_mutation_dispose", operation);
    }
  }

  // Answers the font family request of style mutation `operation`, which
  // waits at a family (style_mutation_next 1, or batch effect 2).
  answerStyleFamily(operation, registry, document) {
    const family = this.string("style_mutation_family", operation);
    const token = this.handle("style_mutation_token", operation);
    let failure;
    let outcome = STYLE_FAMILY_AVAILABLE;
    let message = "";
    // The host learns of each family the value names. A value whose
    // families are all unavailable still applies, as in Chrome: text
    // in it draws with the initial family's face.
    try {
      registry.availableFontStackKeys(family, { document });
    } catch (error) {
      failure = error;
      outcome = error instanceof Error ? STYLE_FAMILY_REJECTED : STYLE_FAMILY_FAULT;
      if (error instanceof Error) message = `${error.message}`;
    }
    const resumed = this.status(
      "style_mutation_resume",
      operation,
      token,
      outcome,
      ...this.input(message),
    );
    if (resumed === STYLE_MUTATION_RETHROW) throw failure;
  }

  styleSupports(name) {
    return this.status("style_supported", ...this.input(name)) === 1;
  }

  styleIDLName(name) {
    return this.string("style_idl_name", ...this.input(name));
  }

  styleMethodName(name) {
    return this.string("style_method_name", ...this.input(name));
  }

  styleCSSName(name) {
    return this.string("style_css_name", ...this.input(name));
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
        code === STYLE_DIAGNOSTIC_INVALID_DECLARATION
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
        code: kind === MATHML_DIAGNOSTIC_ELEMENT ? "mathml-unsupported-element" : "mathml-unsupported-attribute",
        message: this.outputString(),
      });
    }
  }

  // A sheet of the bindings: a constructed sheet of the document
  // `documentHandle` (0n for none yet), or an owned (linked) sheet.
  createStylesheet(documentHandle, owned) {
    return this.status("stylesheet_create_bound", documentHandle, owned ? 1 : 0);
  }

  disposeStylesheet(sheetHandle) {
    this.status("stylesheet_dispose", sheetHandle);
  }

  parseStylesheet(sheetHandle, source, constructed = false) {
    this.status(
      "stylesheet_replace",
      sheetHandle,
      ...this.input(source),
      constructed ? 1 : 0,
    );
  }

  connectStylesheet(sheetHandle, ownerHandle, documentHandle) {
    this.status("stylesheet_connect", sheetHandle, ownerHandle, documentHandle);
  }

  disconnectStylesheet(sheetHandle) {
    this.status("stylesheet_disconnect", sheetHandle);
  }

  // The declarations of a CSS rule: { property, value, important }.
  ruleDeclarations(ruleHandle) {
    const count = this.status("css_rule_declaration_count", ruleHandle);
    const declarations = new Array(count);
    for (let index = 0; index < count; index += 1) {
      declarations[index] = Object.freeze({
        property: this.string("css_rule_declaration_property", ruleHandle, index),
        value: this.string("css_rule_declaration_value", ruleHandle, index),
        important: this.status("css_rule_declaration_important", ruleHandle, index) === 1,
      });
    }
    return Object.freeze(declarations);
  }

  // The rule handles of a u64 list in the standard output.
  outputRuleHandles(count) {
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer, pointer, count * 8);
    return Array.from({ length: count }, (_, index) => view.getBigUint64(index * 8, true));
  }

  // The rules of a sheet named `name` (font-face, page, keyframes) that are
  // active in the media environment (css_active_named_rules).
  activeNamedRules(sheetHandle, name, environment) {
    this.mediaEnvironmentSet(environment);
    return this.outputRuleHandles(this.status("css_active_named_rules", sheetHandle, ...this.input(name)));
  }

  // The keyframes of the @keyframes rule `name` of a scope root in the
  // media environment, ordered by offset: { offset, declarations } with
  // the declarations of each keyframe rule at that offset in rule order;
  // null without the rule.
  keyframes(rootHandle, name, environment) {
    this.mediaEnvironmentSet(environment);
    const rule = this.handle("css_keyframes_rule", rootHandle, ...this.input(name));
    if (rule === 0n) return null;
    const count = this.status("css_keyframes_frames", rule);
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().slice(pointer, pointer + count * KEYFRAME_RECORD_SIZE).buffer);
    const frames = [];
    for (let index = 0; index < count; index += 1) {
      const record = index * KEYFRAME_RECORD_SIZE;
      const frame = view.getUint32(record + KEYFRAME_RECORD_FRAME, true);
      frames[frame] ??= { offset: view.getFloat64(record + KEYFRAME_RECORD_OFFSET, true), declarations: [] };
      frames[frame].declarations.push(...this.ruleDeclarations(view.getBigUint64(record + KEYFRAME_RECORD_RULE, true)));
    }
    return frames;
  }

  // The top-level rule handles of a sheet, and its diagnostics.
  stylesheetSnapshot(sheetHandle, sourceURL) {
    const count = this.status("css_sheet_rule_count", sheetHandle);
    const rules = new Array(count);
    for (let index = 0; index < count; index += 1) {
      rules[index] = this.status("css_sheet_rule_at", sheetHandle, index);
    }
    const diagnosticCount = this.status("css_sheet_diagnostic_count", sheetHandle);
    const diagnostics = new Array(diagnosticCount);
    for (let index = 0; index < diagnosticCount; index += 1) {
      const kind = STYLE_SHEET_DIAGNOSTICS[this.status("css_sheet_diagnostic_at", sheetHandle, index)];
      const construct = this.outputString();
      diagnostics[index] = Object.freeze({
        code: kind.code,
        severity: "warning",
        recoverable: true,
        sourceURL,
        line: this.exports.css_sheet_diagnostic_line(),
        column: this.exports.css_sheet_diagnostic_column(),
        construct,
        message: `${kind.message}: ${construct}`,
      });
    }
    return Object.freeze({
      rules: Object.freeze(rules),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  // The media environment of a style system (media_environment_set
  // reads its keywords).
  mediaEnvironmentSet(environment) {
    this.status(
      "media_environment_set",
      environment.viewportWidth,
      environment.viewportHeight,
      ...this.input(String(environment.mediaType)),
      ...this.input(String(environment.colorScheme)),
      environment.reducedMotion ? 1 : 0,
      ...this.input(String(environment.colorGamut)),
      ...this.input(String(environment.dynamicRange)),
      ...this.input(String(environment.hoverCapability)),
      ...this.input(String(environment.pointerAccuracy)),
      ...this.input(String(environment.scrollbarStyle)),
      ...this.input(String(environment.forcedColors ?? "none")),
    );
  }

  mediaMatches(text, environment) {
    this.mediaEnvironmentSet(environment);
    return this.status("media_matches", ...this.input(text)) === 1;
  }

  supportsCondition(text) {
    return this.status("supports_condition", ...this.input(text)) === 1;
  }

  cascadeElementCollect(handle, pseudoElement) {
    this.status("cascade_element_collect", handle, ...this.input(pseudoElement));
  }

  cascadeStateAffects(handle, state) {
    return this.status(
      "cascade_state_affects",
      handle,
      state === "active" ? CASCADE_STATE_ACTIVE : CASCADE_STATE_HOVER,
    ) === 1;
  }

  userAgentStylesheet(documentHandle) {
    return this.status(
      "document_user_agent_stylesheet",
      documentHandle,
    );
  }

  setAdoptedStylesheets(rootHandle, sheetHandles) {
    const pointer = this.exports.abi_allocate(sheetHandles.length * 4);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < sheetHandles.length; index += 1) {
      view.setUint32(pointer + index * Uint32Array.BYTES_PER_ELEMENT, sheetHandles[index], true);
    }
    this.status(
      "scope_adopted_stylesheets_set",
      rootHandle,
      pointer,
      sheetHandles.length,
    );
  }

  // The FontFaceSet sheets of a document, one for each added FontFace
  // (core/dom/font-face-set.watpart).
  setFontFaceSheets(documentHandle, sheetHandles) {
    const pointer = this.exports.abi_allocate(sheetHandles.length * 4);
    const view = new DataView(this.refreshBytes().buffer);
    for (let index = 0; index < sheetHandles.length; index += 1) {
      view.setUint32(pointer + index * Uint32Array.BYTES_PER_ELEMENT, sheetHandles[index], true);
    }
    this.status("document_font_face_sheets_set", documentHandle, pointer, sheetHandles.length);
  }

  // The active sheets of a scope root with their cascade origins: 0 the
  // user agent, 1 the author.
  activeStylesheets(rootHandle) {
    const count = this.status("scope_active_stylesheet_count", rootHandle);
    const sheets = new Array(count);
    for (let index = 0; index < count; index += 1) {
      sheets[index] = {
        handle: this.status("scope_active_stylesheet_at", rootHandle, index),
        origin: this.status("scope_active_stylesheet_origin", rootHandle, index),
      };
    }
    return sheets;
  }

  stylesheetDisabled(sheetHandle) {
    return this.status("stylesheet_is_disabled", sheetHandle) === 1;
  }

  stylesheetMedia(sheetHandle) {
    return this.string("stylesheet_media", sheetHandle);
  }

  stylesheetRevision(sheetHandle) {
    return this.status("stylesheet_revision", sheetHandle);
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
    const field = SceneBuildBoxFields;
    for (let index = 0; index < count; index += 1) {
      // Decoded field by field into its final shape: the generated reader
      // would build an intermediate object per box, and a text page has
      // thousands of boxes per build.
      const pointer = base + index * SceneBuildBoxSize;
      const childOffset = view.getUint32(pointer + field.childOffset, true);
      const childCount = view.getUint32(pointer + field.childCount, true);
      const children = new Array(childCount);
      for (let child = 0; child < childCount; child += 1) {
        children[child] = view.getUint32(
          childBase + (childOffset + child) * Uint32Array.BYTES_PER_ELEMENT,
          true,
        );
      }
      const textPointer = view.getUint32(pointer + field.textPointer, true);
      const textLength = view.getUint32(pointer + field.textLength, true);
      const hasText = textPointer !== 0 || textLength !== 0;
      const owner = view.getInt32(pointer + field.owner, true);
      boxes[index] = new SceneBuildBox(
        view.getUint8(pointer + field.kind),
        view.getUint8(pointer + field.display),
        view.getUint16(pointer + field.flags, true),
        owner < 0 ? undefined : owner,
        view.getBigUint64(pointer + field.handle, true),
        view.getBigUint64(pointer + field.context, true),
        children,
        view.getBigUint64(pointer + field.stableId, true),
        view.getBigUint64(pointer + field.sourceRevision, true),
        hasText ? textPointer - arena : 0,
        hasText ? textLength : 0,
        view.getUint8(pointer + field.whiteSpace),
        view.getUint8(pointer + field.textTransform),
        view.getUint32(pointer + field.font, true),
        view.getFloat64(pointer + field.letterSpacing, true),
        view.getUint8(pointer + field.host),
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
      direction: this.string("scene_root_direction_keyword"),
      writingMode: this.string("scene_root_writing_mode_keyword"),
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
      COLOR_RGBA_SIZE,
    );
    return rgba(view, 0);
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

  // The page-margin boxes of the next scene builds of the root element
  // `rootHandle` (src/dom/page-rules.js pageMarginBoxes: sixteen
  // { declarations, content }), or null for none. Other roots' builds have
  // none; null for a root that does not hold them changes nothing. A call
  // that repeats the boxes the core holds does nothing.
  setPageMargins(rootHandle, boxes) {
    const root = String(rootHandle);
    if (boxes === null && this._pageMarginsRoot !== root) return;
    const state = boxes === null ? null : JSON.stringify(boxes);
    if (this._pageMarginsRoot === root && state === this._pageMarginsState) return;
    if (!this.exports.page_margins_set(BigInt(rootHandle), boxes === null ? 0 : 1)) this.throwIfError();
    this._pageMarginsRoot = boxes === null ? undefined : root;
    this._pageMarginsState = state;
    if (boxes === null) return;
    for (const [index, { declarations, content }] of boxes.entries()) {
      if (!this.exports.page_margin_box(index, ...this.input(declarations), ...this.input(content))) {
        this._pageMarginsRoot = undefined;
        this.throwIfError();
      }
    }
  }

  // A CSS color as encoded sRGB {r, g, b, a}, "currentColor" for the
  // keyword, or null for an invalid value. `currentColor` ({r, g, b, a},
  // encoded sRGB) resolves currentcolor inside a color-mix(); without it the
  // element context's currentcolor applies.
  parseColor(text, currentColor = null) {
    const status = currentColor === null
      ? this.exports.color_parse(...this.input(text))
      : this.exports.color_parse_with_current(
        ...this.input(text),
        currentColor.r,
        currentColor.g,
        currentColor.b,
        currentColor.a,
      );
    this.throwIfError();
    if (status === COLOR_CURRENT) return "currentColor";
    if (status !== COLOR_PARSED) return null;
    const pointer = this.exports.abi_output_pointer();
    return rgba(new DataView(this.memory.buffer), pointer);
  }

  // Chrome's serialization of the color the last parseColor() returned when
  // it is outside the legacy sRGB forms (lab(), lch(), oklab(), oklch(),
  // color(), color-mix()), or null for a keyword, hex, rgb(), hsl() or
  // hwb() color, which serializes from its 8-bit components.
  parsedColorText() {
    return this.exports.color_parsed_text() === 0 ? null : this.outputString();
  }

  // Blink's stop of a gradient that interpolates in OKLab for the color the
  // last parseColor() returned, when it was not currentcolor: `stop`, the
  // color through OKLab and back to encoded sRGB, and `own`, its own
  // encoded sRGB, which Blink copies to offset 0, each [r, g, b]. A
  // keyword, hex or rgb() color enters as the given 8-bit encoded r, g, b.
  parsedOklabStop(r, g, b) {
    this.exports.color_parsed_oklab_stop(r, g, b);
    this.throwIfError();
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.memory.buffer);
    const color = (start) => [0, 1, 2].map((index) => view.getFloat64(pointer + start + index * Float64Array.BYTES_PER_ELEMENT, true));
    return { stop: color(OKLAB_STOP_INTERPOLATED), own: color(OKLAB_STOP_OWN) };
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
      const start = textOffsetOf(view.getUint32(offset + CSS_URL_START, true));
      const end = textOffsetOf(view.getUint32(offset + CSS_URL_END, true));
      const urlLength = view.getUint32(offset + CSS_URL_LENGTH, true);
      const integrityLength = view.getUint32(offset + CSS_URL_INTEGRITY_LENGTH, true);
      const urlStart = offset + CSS_URL_HEADER_SIZE;
      const integrityStart = urlStart + urlLength;
      urls[index] = {
        start,
        end,
        url: this.decoder.decode(records.subarray(urlStart, integrityStart)),
        request: this.requestFields(view.getUint32(offset + CSS_URL_REQUEST, true),
          this.decoder.decode(records.subarray(integrityStart, integrityStart + integrityLength))),
      };
      offset = integrityStart + integrityLength;
    }
    return urls;
  }

  // The references of a linked sheet's source that the host resolves, in
  // css_sheet_flatten order: { kind (CSS_REFERENCE_*), url, request (the
  // demand fields of its url()'s modifiers, requestFields) }.
  cssSheetReferences(source) {
    const count = this.status("css_sheet_references", ...this.input(source));
    const pointer = this.exports.abi_output_pointer();
    const records = this.refreshBytes().slice(pointer, pointer + this.exports.abi_output_length());
    const view = new DataView(records.buffer);
    const references = new Array(count);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const length = view.getUint32(offset + CSS_REFERENCE_RECORD_LENGTH, true);
      const integrityLength = view.getUint32(offset + CSS_REFERENCE_RECORD_INTEGRITY_LENGTH, true);
      const urlStart = offset + CSS_REFERENCE_RECORD_HEADER_SIZE;
      const integrityStart = urlStart + length;
      references[index] = {
        kind: view.getUint32(offset + CSS_REFERENCE_RECORD_KIND, true),
        url: this.decoder.decode(records.subarray(urlStart, integrityStart)),
        request: this.requestFields(view.getUint32(offset + CSS_REFERENCE_RECORD_REQUEST, true),
          this.decoder.decode(records.subarray(integrityStart, integrityStart + integrityLength))),
      };
      offset = integrityStart + integrityLength;
    }
    return references;
  }

  // The flattened source of a linked sheet, given the result of each of
  // its references: an import's flattened source, a url()'s absolute URL.
  cssSheetFlatten(source, pieces) {
    return this.string("css_sheet_flatten", ...this.input(source), ...this.valueListInput(pieces));
  }

  // The ranges of an @font-face unicode-range descriptor value as a
  // Uint32Array of {start, end} scalar pairs, sorted and disjoint, or null
  // for an invalid descriptor, which Chrome ignores.
  fontUnicodeRanges(text) {
    const count = this.status("font_unicode_range_parse", ...this.input(text));
    if (count < 0) return null;
    const pointer = this.exports.abi_output_pointer();
    return new Uint32Array(this.refreshBytes().buffer.slice(pointer, pointer + count * UNICODE_RANGE_SIZE));
  }

  cascadeBegin() {
    this.exports.cascade_begin();
    this.throwIfError();
  }

  resourceRegister(kind, key) {
    const input = this.input(key);
    return this.handle("resource_register", kind, ...input);
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
      RESOURCE_INFO_SIZE,
    );
    return Object.fromEntries(RESOURCE_INFO_FIELDS.map(([name, offset, read]) => [name, view[read](offset, true)]));
  }

  resourceKey(handle) {
    this.status("resource_key", handle);
    return this.outputString();
  }

  // The request a url()'s modifiers name for the resource (CSS Values 5
  // §4.1.1; resource_request): the fields of a host resource demand.
  resourceRequest(handle) {
    const request = this.status("resource_request", handle);
    return this.requestFields(request, this.outputString());
  }

  // The demand fields of a url() request: `request` holds the credentials
  // mode in byte 0 (0 the destination's default, 1 "same-origin", 2
  // "include", either making the mode "cors") and the referrer policy in
  // byte 1 (css_referrer_policy_name; 0 none). A field the url() does not
  // set is undefined, so the demand takes the destination's default.
  requestFields(request, integrity) {
    const credentials = request & 0xff;
    const referrerPolicy = (request >> 8) & 0xff;
    return {
      mode: credentials === 0 ? undefined : "cors",
      credentials: credentials === 0 ? undefined : credentials === 1 ? "same-origin" : "include",
      integrity: integrity === "" ? undefined : integrity,
      referrerPolicy: referrerPolicy === 0 ? undefined : this.string("css_referrer_policy_name", referrerPolicy),
    };
  }

  // The resource whose id is `id` (resource_find_id).
  resourceById(id) {
    return this.handle("resource_find_id", id);
  }

  sceneResourceNode(node) {
    return this.handle("scene_resource_node", node);
  }

  // The image resource of the generated image a build row shows (a list
  // marker's list-style-image, or an image of ::before or ::after
  // content), bound to its element; 0n for none (scene_resource_generated).
  sceneResourceGenerated(stableId, sourceRevision) {
    return this.handle("scene_resource_generated", stableId, sourceRevision);
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
      contentChanged,
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

  resourceNodeDetach(node) {
    return this.status("resource_node_detach", node);
  }

  resourceRelease(handle) {
    return this.status("resource_release", handle);
  }

  releaseDocumentResourceBindings(documentHandle) {
    return this.status("resource_release_document_bindings", documentHandle);
  }

  get resourceRevision() {
    return this.status("resource_revision") >>> 0;
  }

  canvasBitmapDimension(node, axis) {
    return this.status("canvas_bitmap_dimension", node, axis);
  }

  canvasDimensionValue(value, axis) {
    return this.status("canvas_dimension_value", value, axis);
  }

  canvasBitmapReset(node, sizeChanged, resetDevice) {
    const request = this.handle("canvas_bitmap_set", node, sizeChanged ? 1 : 0);
    this.canvasResetRequest(request, resetDevice);
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
        CANVAS_RESET_SIZE,
      );
      resetDevice({
        width: view.getFloat64(CANVAS_RESET_WIDTH, true),
        height: view.getFloat64(CANVAS_RESET_HEIGHT, true),
        contentGeneration: view.getUint32(CANVAS_RESET_CONTENT_GENERATION, true),
        sizeChanged: view.getUint32(CANVAS_RESET_SIZE_CHANGED, true) !== 0,
      });
    } finally {
      this.status("canvas_reset_ack", request, invocation);
    }
  }

  // The shared-memory path stays wholly native. An isolated renderer transports
  // the same raw ABI bytes, never decoded CSS values or a second style store.
  // `record` is the engine row the sample copies: the node's layout row, or
  // a row with its stack composed at `time` (animation_track_stack_row).
  // `pseudo` 1 or 2 samples the ::before or ::after of element `node`.
  captureComputedSample(engine, owner, identity, node, pseudo, index, track, property, time,
    record = engine.exports.layout_buffer_base() + index * LAYOUT_NODE_SIZE) {
    let shadows = 0;
    if (engine.memory !== this.memory) {
      const source = new DataView(engine.memory.buffer);
      const shadowLength = property.kind === ANIMATION_KIND_SHADOW
        ? source.getUint8(record + LAYOUT_NODE_OFFSET_SHADOW_COUNT) * SHADOW_ENTRY_SIZE
        : 0;
      shadows = shadowLength
        ? engine.exports.shadow_pool_base() + source.getUint32(record + LAYOUT_NODE_OFFSET_SHADOW_OFFSET, true)
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
    this.status("computed_samples_capture", owner, identity, node, pseudo, index,
      track, record, shadows, property.kind, property.valueOffset,
      property.tagOffset ?? 0, property.percentageOffset ?? 0, time);
  }
  // Capture the layout-used values CSSOM exposes for absolutely positioned
  // ::before and ::after boxes (computed_pseudo_capture selects them and
  // derives the values). The snapshot is renderer-owned like sampled
  // animation values; the native view accepts it only while the element's
  // cascade generation still matches. `generatedRows` lists the scene's
  // ::before and ::after boxes as `{ row, element }`, the element being the
  // originating element of the same serialization; serializeToScene gives
  // them as generatedBoxRows.
  captureComputedPseudos(engine, owner, nodes, boxes, generatedRows) {
    if (!Array.isArray(generatedRows)) {
      throw new TypeError(
        `captureComputedPseudos needs the scene's generatedBoxRows; got ${String(generatedRows)}. ` +
          "Pass serialized.generatedBoxRows of serializeToScene() in the scene.",
      );
    }
    this.status("computed_pseudos_clear", owner);
    const base = engine.exports.layout_buffer_base();
    for (const { row: index, element } of generatedRows) {
      if (element._domCore !== this) continue;
      const ownerIndex = nodes[index].generatedOwnerIndex;
      const box = boxes[index];
      const containingBox = boxes[ownerIndex];
      if (!box || !containingBox) continue;
      let record = base + index * LAYOUT_NODE_SIZE;
      let containingRecord = base + ownerIndex * LAYOUT_NODE_SIZE;
      if (engine.memory !== this.memory) {
        const bytes = new Uint8Array(2 * LAYOUT_NODE_SIZE);
        bytes.set(new Uint8Array(engine.memory.buffer, record, LAYOUT_NODE_SIZE));
        bytes.set(new Uint8Array(engine.memory.buffer, containingRecord, LAYOUT_NODE_SIZE), LAYOUT_NODE_SIZE);
        [record] = this.byteInput(bytes);
        containingRecord = record + LAYOUT_NODE_SIZE;
      }
      this.status(
        "computed_pseudo_capture",
        owner,
        element._coreHandle,
        // src/dom/serialize.js packs the box kind into the low byte.
        nodes[index]._coreBox & 0xff,
        record,
        containingRecord,
        box.x, box.y, box.w, box.h, box.cw, box.ch,
        containingBox.x, containingBox.y, containingBox.w, containingBox.h,
      );
    }
  }


  remapComputedSamples(owner, indexMap) {
    const pointer = this.status("abi_allocate", indexMap.size * INDEX_REMAP_SIZE);
    const view = new DataView(this.refreshBytes().buffer);
    let offset = pointer;
    for (const [previous, next] of indexMap) {
      view.setUint32(offset + INDEX_REMAP_PREVIOUS, previous, true);
      view.setUint32(offset + INDEX_REMAP_NEXT, next, true);
      offset += INDEX_REMAP_SIZE;
    }
    this.status("computed_samples_remap", owner, pointer, indexMap.size);
  }

  // Resolve the current cascade result for an element in resolution mode
  // `mode` (COMPUTED_RESOLVE_*). Returns the computed declarations (var()
  // substituted, CSS-wide keywords applied) as [property, value] pairs.
  computedStyleResolve(handle, parentHandle, mode) {
    return this.computedDeclarations(this.status("computed_style_resolve", handle, parentHandle ?? 0n, mode));
  }

  // Cascades and resolves the element after its flat-tree parent unless its
  // stored record is current for the document's style generation.
  styleElementResolve(handle) {
    return this.computedDeclarations(this.status("style_element_resolve", handle));
  }

  computedDeclarations(count) {
    const declarations = new Array(count);
    for (let index = 0; index < count; index += 1) {
      declarations[index] = [
        this.string("computed_declaration_property", index),
        this.string("computed_declaration_value", index),
      ];
    }
    return declarations;
  }

  // The viewport that vw, vh, vmin and vmax of the document of `handle`
  // resolve against. A change makes the document's computed records resolve
  // again.
  documentViewport(handle, width, height, deviceScale) {
    this.status("document_viewport_set", handle, width, height, deviceScale);
  }

  // Returns a keyword string, a pixel number, a "N%" string, a
  // { pixels, percentage } pair, or a length expression { expression,
  // cssText }; throws a SyntaxError on invalid input.
  resolveLength(value) {
    const kind = this.status("length_resolve", ...this.input(value));
    if (kind === LENGTH_RESULT.KEYWORD) return this.outputString();
    if (kind === LENGTH_RESULT.EXPRESSION) {
      return {
        expression: this.exports.length_result_expression(),
        cssText: this.outputString(),
      };
    }
    const pixels = this.exports.length_result_pixels();
    if (kind === LENGTH_RESULT.PIXELS) return pixels;
    const percentage = this.exports.length_result_percentage();
    if (kind === LENGTH_RESULT.PERCENTAGE) return `${percentage * 100}%`;
    return { pixels, percentage };
  }

  // The current record's family key, and whether the record waits on a
  // font-family answer or a face binding.
  computedContext() {
    const context = {
      fontFamily: this.string("computed_context_family"),
      pending: this.exports.computed_context_number(COMPUTED_CONTEXT_PENDING) === 1,
    };
    this.throwIfError();
    return context;
  }

  // Font-family values the resolutions of `document` met without an
  // answer; the binding keys them through its registry and answers them.
  fontFamilyRequests(document) {
    const count = this.status("font_family_request_count", document._coreHandle);
    const requests = new Array(count);
    for (let index = 0; index < count; index += 1) {
      requests[index] = this.string("font_family_request_at", document._coreHandle, index);
    }
    return requests;
  }

  // Lowers every row of the last build into a retained publication and
  // returns its handle. The caller releases it (engineRecordRelease). A
  // failure carries `sceneRow`, the index of the build row that failed,
  // and `fontFailure`, whether a font failed it (engine_record_font_failed).
  // `scrollOwner` is the scroll owner of the render surface the build is
  // for (0n without one): the publication records each row's requested
  // scroll offsets from it.
  engineRecordPublish(rootHandle, viewportWidth, viewportHeight, scrollOwner) {
    const native = this.exports;
    const handle = applyNative(native.engine_record_publish, native, [
      rootHandle,
      viewportWidth,
      viewportHeight,
      scrollOwner,
    ]);
    if (native.abi_error_kind() !== 0) {
      const sceneRow = native.abi_error_detail_a();
      const fontFailure = native.engine_record_font_failed() === 1;
      try {
        this.throwIfError();
      } catch (error) {
        error.sceneRow = sceneRow;
        error.fontFailure = fontFailure;
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

  // The query containers that the last scene build met
  // (scene_query_containers), each as its element handle and its container
  // types (1 size, 2 inline-size, 4 scroll-state).
  sceneQueryContainers() {
    const count = this.status("scene_query_containers");
    const pointer = this.exports.abi_output_pointer();
    const words = new BigInt64Array(this.refreshBytes().buffer.slice(pointer, pointer + count * 16));
    return Array.from({ length: count }, (_, index) => ({ handle: words[index * 2], types: Number(words[index * 2 + 1]) }));
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

  // The after-change record of one row of the last scene build, as owned
  // bytes in the form of engineRecordCopy: the transitions a style change
  // starts compare it with the before-change record
  // (engine_record_after_change).
  engineRecordAfterChange(stableId, sourceRevision) {
    this.status("engine_record_after_change", stableId, sourceRevision);
    const pointer = this.exports.abi_output_pointer();
    return this.refreshBytes().slice(pointer, pointer + this.exports.abi_output_length());
  }

  svgPathRegister(path, fillRule, stroke = null) {
    const input = this.input(path);
    const dashArray = Float64Array.from(stroke?.dashArray ?? []);
    const dashes = dashArray.length
      ? this.byteInput(new Uint8Array(dashArray.buffer))[0]
      : 0;
    return this.status("svg_path_register", ...input, Number(fillRule === "evenodd"),
      Number(stroke !== null), stroke?.width ?? 0, stroke?.cap ?? 0,
      stroke?.join ?? 0, stroke?.miterLimit ?? 4, dashes, dashArray.length,
      stroke?.dashPhase ?? 0);
  }

  svgPathDefinition(pathIndex) {
    this.status("svg_path_definition", pathIndex);
    const record = readSvgPathDefinition(new DataView(this.refreshBytes().buffer), this.exports.abi_output_pointer());
    return {
      pathIndex,
      pathDef: this.decoder.decode(this.bytes.subarray(record.dataPointer, record.dataPointer + record.dataLength)),
      fillRule: record.fillRule ? "evenodd" : "nonzero",
      stroke: record.stroked ? {
        width: record.strokeWidth,
        cap: record.cap,
        join: record.join,
        miterLimit: record.miterLimit,
        dashArray: Array.from(new Float32Array(this.memory.buffer, record.dashPointer, record.dashCount)),
        dashPhase: record.dashPhase,
      } : null,
      // A device coverage index: the raster the stroke fills, under the
      // affine from path units into raster pixels. nonScalingStrokeScale is
      // device pixels per host pixel for a non-scaling stroke, else 0.
      device: record.deviceCoverage ? {
        matrix: [record.deviceA, record.deviceB, record.deviceC, record.deviceD, record.deviceE, record.deviceF],
        width: record.deviceWidth,
        height: record.deviceHeight,
        nonScalingStrokeScale: record.nonScalingStrokeScale,
      } : null,
    };
  }

  sceneSvgPathBounds(publication, index) {
    if (!this.status("scene_svg_path_bounds", publication, index)) return null;
    const pointer = this.exports.abi_output_pointer();
    const view = new DataView(this.refreshBytes().buffer);
    return {
      xMin: view.getFloat64(pointer + SVG_PATH_BOUNDS_X_MIN, true),
      yMin: view.getFloat64(pointer + SVG_PATH_BOUNDS_Y_MIN, true),
      xMax: view.getFloat64(pointer + SVG_PATH_BOUNDS_X_MAX, true),
      yMax: view.getFloat64(pointer + SVG_PATH_BOUNDS_Y_MAX, true),
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
    if (outcome === ENGINE_FRAME_DECLINED) return null;
    if (outcome !== ENGINE_FRAME_RECORDED) this.throwIfError();
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
      SPECIFIED_GRAMMAR_PROPERTY,
    ) !== 0;
  }

  styleGeneration(documentHandle) {
    return this.status("document_style_generation", documentHandle);
  }

  styleInvalidate(documentHandle) {
    this.status("document_style_invalidate", documentHandle);
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
    const flags = (options.childList ? OBSERVE_CHILD_LIST : 0) | (options.attributes ? OBSERVE_ATTRIBUTES : 0) |
      (options.characterData ? OBSERVE_CHARACTER_DATA : 0) | (options.subtree ? OBSERVE_SUBTREE : 0) |
      (options.attributeOldValue ? OBSERVE_ATTRIBUTE_OLD_VALUE : 0) |
      (options.characterDataOldValue ? OBSERVE_CHARACTER_DATA_OLD_VALUE : 0) |
      (options.attributeFilter ? OBSERVE_ATTRIBUTE_FILTER : 0);
    this.status(
      "observer_observe",
      observerId,
      handle,
      flags,
      ...this.nullableInput(options.attributeFilter?.join("\n")),
    );
  }

  // An observer that observes a node stays alive while its document does.
  retainObserver(observer) {
    this.observersById.set(observer._id, new WeakRef(observer));
    let observers = this.observingObserversByDocument.get(observer._document);
    if (!observers) this.observingObserversByDocument.set(observer._document, observers = new Set());
    observers.add(observer);
  }

  disconnectObserver(observerId) {
    this.status("observer_disconnect", observerId);
    const observer = this.observersById.get(observerId)?.deref();
    this.observersById.delete(observerId);
    if (observer) this.observingObserversByDocument.get(observer._document)?.delete(observer);
  }

  // A step without tree records of its own changed what a select's
  // selectedcontent shows (core/dom/selected-content.watpart): the core
  // updates it when the records are taken, and they reach the facade
  // through the handler SDDocument installs.
  deliverSelectedContent() {
    if (this.selectedContentPendingRegister.value === 0) return;
    this.selectedContentHandler(this);
  }

  callbackRecords() {
    const count = this.exports.callback_records_export();
    this.throwIfError();
    const records = [];
    // The roots of the subtrees that entered or left a tree. A moved node
    // (moveBefore) stays connected.
    const changedSubtrees = new Set();
    if (count !== 0) {
      const recordSize = this.callbackRecordSize;
      const view = new DataView(this.memory.buffer, this.outputPointerRegister.value, count * recordSize);
      for (let index = 0; index < count; index += 1) {
        const offset = index * recordSize;
        const text = (pointerField, lengthField) => {
          const pointer = view.getUint32(offset + pointerField, true);
          return this.decoder.decode(
            this.refreshBytes().subarray(pointer, pointer + view.getUint32(offset + lengthField, true)),
          );
        };
        const flags = view.getUint32(offset + CALLBACK_FIELD_FLAGS, true);
        const kind = view.getUint32(offset + CALLBACK_FIELD_KIND, true);
        const relatedA = view.getBigUint64(offset + CALLBACK_FIELD_RELATED_A, true);
        const relatedB = view.getBigUint64(offset + CALLBACK_FIELD_RELATED_B, true);
        if (kind === CALLBACK_RECORD_CHILD_LIST && (flags & CALLBACK_FLAG_MOVED) === 0) {
          if (relatedA !== 0n) changedSubtrees.add(relatedA);
          if (relatedB !== 0n) changedSubtrees.add(relatedB);
        }
        records.push({
          kind,
          effects: view.getUint32(offset + CALLBACK_FIELD_EFFECTS, true),
          notify: view.getUint32(offset + CALLBACK_FIELD_NOTIFY, true),
          target: view.getBigUint64(offset + CALLBACK_FIELD_TARGET, true),
          relatedA,
          relatedB,
          previous: view.getBigUint64(offset + CALLBACK_FIELD_PREVIOUS, true),
          next: view.getBigUint64(offset + CALLBACK_FIELD_NEXT, true),
          name: text(CALLBACK_FIELD_NAME_POINTER, CALLBACK_FIELD_NAME_LENGTH),
          oldValue: (flags & CALLBACK_FLAG_OLD_VALUE_ABSENT) !== 0
            ? null
            : text(CALLBACK_FIELD_OLD_VALUE_POINTER, CALLBACK_FIELD_OLD_VALUE_LENGTH),
        });
      }
      this.exports.callback_records_acknowledge();
    }
    scheduleMutationObservers(this);
    for (const record of records) {
      if (record.effects & CALLBACK_EFFECT_RETAIN) {
        this.moveWrapperCacheEntry(
          record.target,
          record.relatedA,
          record.relatedB,
        );
      }
    }
    // Each subtree is settled once, against the tree the whole operation
    // left.
    for (const handle of changedSubtrees) this.updateConnectedWrappers(handle);
    for (const record of records) {
      if (record.effects & CALLBACK_EFFECT_SLOT_CHANGE) {
        this.slotChangeHandler?.(this.wrapperFor(record.target));
      }
    }
    // Details toggle tasks the operation queued (details.watpart). The
    // entries are copied before wrapperFor can reenter the core.
    const toggleCount = this.detailsToggleCountRegister.value === 0 ? 0 : this.exports.details_toggle_take();
    if (toggleCount !== 0) {
      const toggleView = new DataView(this.memory.buffer, this.outputPointerRegister.value, toggleCount * DETAILS_TOGGLE_SIZE);
      const toggles = Array.from({ length: toggleCount }, (_, index) => [
        toggleView.getBigUint64(index * DETAILS_TOGGLE_SIZE + DETAILS_TOGGLE_NODE, true),
        toggleView.getBigUint64(index * DETAILS_TOGGLE_SIZE + DETAILS_TOGGLE_TOKEN, true),
      ]);
      for (const [handle, token] of toggles) {
        this.detailsToggleHandler?.(this, this.wrapperFor(handle), token);
      }
    }
    // An adoption can carry a Range's boundary into another document.
    this.syncSelectionDocuments();
    return records;
  }

  // Whether a disposal freed the core tree of the document wrapper
  // `document`.
  documentDisposed(document) {
    return disposedDocuments.has(document);
  }

  dispose(documentHandle) {
    const releaseEventIdentities = this.eventDisposalHandler?.(
      this,
      documentHandle,
    );
    const documentEntry = this.documentFinalizerEntries.get(documentHandle);
    if (documentEntry) {
      this.documentFinalizerEntries.delete(documentHandle);
      documentFinalizer.unregister(documentEntry);
    }
    // The disposal frees the document's tree, so it holds no wrapper.
    const documentWrapper = this.wrapperByHandle.get(documentHandle)?.deref();
    if (documentWrapper !== undefined) {
      this.connectedWrappersByDocument.delete(documentWrapper);
      disposedDocuments.add(documentWrapper);
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
    for (const [id, reference] of this.observersById) {
      const observer = reference.deref();
      if (observer === undefined || observer._ownerHandle === documentHandle) {
        this.observersById.delete(id);
      }
    }
    for (const [id, reference] of this.renderingObserversById ?? []) {
      const observer = reference.deref();
      if (observer === undefined || observer._ownerHandle === documentHandle) {
        this.renderingObserversById.delete(id);
      }
    }
  }
}

export const sharedDomCore = new DomCore();
