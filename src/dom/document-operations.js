// Runs authoring batches (docs/specifications/dom-authoring-bytecode.md) on
// a live document. The core validates and runs every operation; this
// runner copies the batch into core memory and performs the host effect of
// each suspension: it delivers the callback records and runs the custom
// element reactions, answers a font family request, prepares a parsed
// fragment, and brings the documents of a changed sheet up to date.
import {
  DomBatchHeaderFields,
  DomBatchHeaderSize,
  domBatchLayout,
  readDomBatchResult,
} from "../dom-wasm/record-readers.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { BATCH_NONE, BatchEncoder } from "../dom-wasm/dom-batch-encoder.js";
import { withCustomElementReactions } from "./custom-elements.js";
import { imagesParsed } from "./images.js";
import { decodeInputRecord, encodeInputRecord } from "../dom-wasm/input-record-encoding.js";
import { domStringCodec } from "../dom-wasm/dom-string-transport.js";

const BATCH_SUSPENDED = layoutConstant("DOM_BATCH_SUSPENDED");
const BATCH_FAILED = layoutConstant("DOM_BATCH_FAILED");
const EFFECT_RECORDS = layoutConstant("DOM_BATCH_EFFECT_RECORDS");
const EFFECT_STYLE_FAMILY = layoutConstant("DOM_BATCH_EFFECT_STYLE_FAMILY");
const EFFECT_PARSED_MARKUP = layoutConstant("DOM_BATCH_EFFECT_PARSED_MARKUP");
const EFFECT_SHEET_CHANGED = layoutConstant("DOM_BATCH_EFFECT_SHEET_CHANGED");
const OPCODE_NAMES = new Map(Object.entries(domBatchLayout.opcodes).map(([name, { code }]) => [code, name]));

const ORIGINS = new Map([
  ["inspector", layoutConstant("DOCUMENT_LOG_ORIGIN_INSPECTOR")],
  ["agent", layoutConstant("DOCUMENT_LOG_ORIGIN_AGENT")],
  ["script", layoutConstant("DOCUMENT_LOG_ORIGIN_SCRIPT")],
  ["input", layoutConstant("DOCUMENT_LOG_ORIGIN_INPUT")],
]);
const ORIGIN_NAMES = new Map([...ORIGINS].map(([name, code]) => [code, name]));
const NO_SOURCE = new Uint8Array();
const ENTRY_LOAD = layoutConstant("DOCUMENT_LOG_ENTRY_LOAD");
const ENTRY_MUTATE = layoutConstant("DOCUMENT_LOG_ENTRY_MUTATE");
const ENTRY_INTERACT = layoutConstant("DOCUMENT_LOG_ENTRY_INTERACT");
const ENTRY_FRAME = layoutConstant("DOCUMENT_LOG_ENTRY_FRAME");

function originCode(origin) {
  const code = ORIGINS.get(origin);
  if (code === undefined) {
    throw new RangeError(`Unknown document log origin ${String(origin)}; the origins are ${[...ORIGINS.keys()].join(", ")}`);
  }
  return code;
}

// Opens the document's origin scope: the core logs each change with
// `origin` ("input" logs none) and its gate admits it.
export function openDocumentScope(document, origin) {
  document._domCore.status("document_scope_open", document._coreHandle, originCode(origin));
}

export function closeDocumentScope(document) {
  document._domCore.status("document_scope_close", document._coreHandle);
}

// Runs `operation` with the document's origin scope open.
export function withDocumentScope(document, origin, operation) {
  openDocumentScope(document, origin);
  try {
    return operation();
  } finally {
    closeDocumentScope(document);
  }
}

// Writes input record `record` to the document's log as an interact entry
// and returns the normalized record. The document's scope is open with the
// origin input.
export function logInteraction(document, record) {
  const core = document._domCore;
  const length = core.statusRaw("document_log_interact", document._coreHandle, ...core.byteInput(encodeInputRecord(record)));
  return decodeInputRecord(core.outputBytes("document_log_interact", 0, length));
}

// Whether a document refuses changes outside an origin scope.
export function gateDocument(document, gated) {
  document._domCore.status("document_log_gate", document._coreHandle, gated ? 1 : 0);
}

// Starts a span of the document's log with its source bytes (absent: the
// core serializes the document) and declared inputs.
export function loadDocumentLog(document, sourceBytes, { clock = 0, seed = 0 } = {}) {
  const core = document._domCore;
  core.status("document_log_load", document._coreHandle, ...core.byteInput(sourceBytes ?? NO_SOURCE), clock, seed);
}

// The byte length of the log of `document`: it grows with each entry.
export function documentLogLength(document) {
  return document._domCore.status("document_log_bytes", document._coreHandle);
}

// A copy of the document's log bytes.
export function documentLogBytes(document) {
  const core = document._domCore;
  const length = core.status("document_log_bytes", document._coreHandle);
  return length === 0 ? new Uint8Array(0) : core.outputBytes("document_log_bytes", 0, length);
}

// The operation of a logged batch (one operation, a creation with its
// RETURN) and its operands by the names of the opcode table: a node as its
// durable identifier (null for none), a string, an index path as an array
// of indices, a word as a number; a creation's result slot is omitted.
export function decodeOperation(batch) {
  const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const handleCount = view.getUint32(DomBatchHeaderFields.handleCount, true);
  const operationBytes = view.getUint32(DomBatchHeaderFields.operationBytes, true);
  const record = DomBatchHeaderSize + handleCount * 8;
  const strings = record + operationBytes;
  const code = view.getUint16(record, true);
  const operation = OPCODE_NAMES.get(code);
  const opcode = domBatchLayout.opcodes[operation];
  const operands = {};
  let cursor = record + 4;
  opcode.operands.forEach((kind, index) => {
    const name = opcode.names[index];
    if (kind === "node" || kind === "optional-node") {
      const value = view.getUint32(cursor, true);
      operands[name] = value === BATCH_NONE ? null
        : Number(view.getBigUint64(DomBatchHeaderSize + (value & 0x7fffffff) * 8, true));
      cursor += 4;
    } else if (kind === "string") {
      const start = strings + view.getUint32(cursor, true);
      operands[name] = domStringCodec.decode(batch.subarray(start, start + view.getUint32(cursor + 4, true)));
      cursor += 8;
    } else if (kind === "index-path") {
      const start = strings + view.getUint32(cursor, true);
      operands[name] = Array.from({ length: view.getUint32(cursor + 4, true) }, (_, step) => view.getUint32(start + step * 4, true));
      cursor += 8;
    } else if (kind === "word") {
      operands[name] = view.getUint32(cursor, true);
      cursor += 4;
    } else {
      cursor += 4;
    }
  });
  return { operation, operands: Object.freeze(operands) };
}

// The entries of log `bytes`: { kind: "load", clock, seed, source },
// { kind: "mutate", origin, operation, operands, before, batch },
// { kind: "interact", time, record } and { kind: "frame", time }. The core
// gives each
// entry's size and refuses an unknown kind.
export function documentLogEntries(core, bytes) {
  const copy = bytes.slice();
  const length = copy.byteLength;
  const view = new DataView(copy.buffer);
  const entries = [];
  for (let offset = 0; offset < length;) {
    // The core reads the entry's kind and length from its header.
    const [header] = core.byteInput(copy.subarray(offset, offset + Math.min(8, length - offset)));
    const size = core.status("document_log_entry_size", header, length - offset);
    const kind = view.getUint32(offset, true);
    if (kind === ENTRY_LOAD) {
      const sourceLength = view.getUint32(offset + 20, true);
      entries.push(Object.freeze({
        kind: "load",
        clock: view.getFloat64(offset + 8, true),
        seed: view.getUint32(offset + 16, true),
        source: copy.slice(offset + 24, offset + 24 + sourceLength),
      }));
    } else if (kind === ENTRY_MUTATE) {
      const batchLength = view.getUint32(offset + 12, true);
      const batch = copy.slice(offset + 16, offset + 16 + batchLength);
      const before = offset + 16 + ((batchLength + 3) & ~3);
      const beforeState = view.getUint32(before, true);
      const beforeLength = view.getUint32(before + 4, true);
      const { operation, operands } = decodeOperation(batch);
      entries.push(Object.freeze({
        kind: "mutate",
        origin: ORIGIN_NAMES.get(view.getUint32(offset + 8, true)),
        operation,
        operands,
        // The value before the change: a string, null for an absent one,
        // or undefined for an operation whose value the core does not read.
        before: beforeState === 2
          ? domStringCodec.decode(copy.subarray(before + 8, before + 8 + beforeLength))
          : beforeState === 1 ? null : undefined,
        batch,
      }));
    } else if (kind === ENTRY_INTERACT) {
      entries.push(Object.freeze({
        kind: "interact",
        time: view.getFloat64(offset + 8, true),
        record: decodeInputRecord(copy, offset + 20),
      }));
    } else if (kind === ENTRY_FRAME) {
      entries.push(Object.freeze({ kind: "frame", time: view.getFloat64(offset + 8, true) }));
    } else {
      throw new RangeError(`document_log_entry_size accepted entry kind ${kind}, which this host does not name`);
    }
    offset += size;
  }
  return entries;
}

// The history of `document`: the entries of its log after the load but its
// frame entries, each
// with its index in the log and, for a mutate entry, `nodes`, the live
// nodes its node operands name (null for a node that is gone), in operand
// order.
export function documentHistory(document) {
  const core = document._domCore;
  const entries = documentLogEntries(core, documentLogBytes(document));
  return entries.flatMap((entry, index) => {
    if (entry.kind === "load" || entry.kind === "frame") return [];
    if (entry.kind === "interact") return [Object.freeze({ ...entry, index, nodes: Object.freeze([]) })];
    const opcode = domBatchLayout.opcodes[entry.operation];
    const nodes = opcode.operands.flatMap((kind, operand) => {
      if (kind !== "node" && kind !== "optional-node") return [];
      const identifier = entry.operands[opcode.names[operand]];
      return identifier === null ? [] : [core.nodeByIdentifier(document._coreHandle, identifier)];
    });
    return [Object.freeze({ ...entry, index, nodes: Object.freeze(nodes) })];
  });
}

// Applies the entries of log `bytes` to `document`, which holds the log's
// source as loaded. A mutate entry runs in a scope of its origin; an
// interact entry runs `interact(record)`, the host's input path, in a scope
// of the origin input after logging the record. A frame entry resolves
// `present(time)`, the host's frame of the document at that time on its
// clock, so transitions, timers and the geometry that input finds follow
// the live document's frames. The document's own log records the same
// entries (its frames as its surface renders them). `through` stops after the entry of that
// index in the log: the state after it. Resolves after the last entry;
// rejects at the first entry that fails and names it.
export async function replayDocumentLog(document, bytes, { interact, present, through = Infinity } = {}) {
  const core = document._domCore;
  const kept = [];
  try {
    for (const [index, entry] of documentLogEntries(core, bytes).entries()) {
      if (entry.kind === "load" || index > through) continue;
      try {
        if (entry.kind === "frame") {
          if (typeof present !== "function") {
            throw new TypeError("The log holds frames; replay needs a present(time) frame of the document");
          }
          await present(entry.time);
          continue;
        }
        if (entry.kind === "interact") {
          if (typeof interact !== "function") {
            throw new TypeError("The log holds input records; replay needs an interact(record) input path");
          }
          withDocumentScope(document, "input", () => interact(logInteraction(document, entry.record)));
          continue;
        }
        withDocumentScope(document, entry.origin, () => kept.push(...runBatch(document, entry.batch)));
      } catch (error) {
        throw new Error(`Replay of log entry ${index} (${entry.operation ?? entry.record?.kind ?? entry.kind}) failed: ${error.message}`, { cause: error });
      }
    }
  } finally {
    for (const handle of kept) core.status("node_release", handle);
  }
}

// A batch of `operations`, each a record { operation, ...operands } that
// names an opcode and its operands by the names of the opcode table
// (core/dom/dom-interfaces.json): nodes as live nodes of `document` or
// null, strings (absent: empty), index paths as arrays and words as
// numbers. The batch names nodes by their durable identifiers.
export function encodeOperationRecords(document, operations) {
  const core = document._domCore;
  const batch = new BatchEncoder({ identifiedNodes: true });
  for (const record of operations) {
    const opcode = domBatchLayout.opcodes[record.operation];
    if (!opcode) throw new RangeError(`Unknown document operation ${String(record.operation)}`);
    batch.operation(record.operation, ...opcode.operands.map((kind, index) => {
      const value = record[opcode.names[index]];
      if (kind === "node" || kind === "optional-node") {
        return value === null || value === undefined ? BATCH_NONE : batch.existing(core.nodeIdentifier(value._coreHandle));
      }
      if (kind === "string") return value === undefined ? "" : String(value);
      return value;
    }));
  }
  return batch;
}

// Runs the operations of `batch` (a BatchEncoder) on `document` in a scope
// of `origin`. Throws when the batch does not validate, or names the
// operation that failed; the operations before it stay applied.
export function applyDocumentOperations(document, batch, { origin }) {
  const core = document._domCore;
  withDocumentScope(document, origin, () => {
    for (const handle of runBatch(document, batch.encode())) core.status("node_release", handle);
  });
}

// Runs encoded batch `bytes` and returns the handles its RETURN operations
// gave the host, each with its host reference.
function runBatch(document, bytes) {
  const core = document._domCore;
  const registry = document._sandomFontRegistry ?? core.defaultFontRegistry;
  const pointer = core.status("dom_batch_input_allocate", bytes.byteLength);
  const memory = core.refreshBytes();
  memory.set(bytes, pointer);
  new DataView(memory.buffer).setBigUint64(pointer + DomBatchHeaderFields.fontCatalog, registry.fontCatalogHandle, true);
  // The result of a step of the batch, with the diagnostic of a failure and
  // the returned handles of the end, read before the step's records run
  // other operations.
  const readResult = (operation) => {
    const output = core.output(operation);
    const result = readDomBatchResult(output, 0);
    const addresses = output.memory();
    if (result.status === BATCH_FAILED) {
      result.diagnostic = addresses.memoryText(core.decoder, result.diagnosticPointer, result.diagnosticLength);
    } else if (result.status !== BATCH_SUSPENDED) {
      result.returned = Array.from({ length: result.returnedCount },
        (_, index) => addresses.getBigUint64(result.returnedPointer + index * 8, true));
    }
    return result;
  };
  // Each run of the batch up to a suspension is one [CEReactions] step, as
  // each scalar operation is.
  const run = (step) =>
    withCustomElementReactions(() => {
      const result = step();
      document._deliverCoreTreeRecords();
      return result;
    }, core);
  let handle = 0n;
  let result = run(() => {
    handle = core.handle("dom_batch_apply", document._coreHandle, pointer, bytes.byteLength, -1n);
    return readResult("dom_batch_apply");
  });
  try {
    while (result.status === BATCH_SUSPENDED) {
      if (result.effect === EFFECT_STYLE_FAMILY) {
        core.answerStyleFamily(result.effectHandle, registry, document);
      } else if (result.effect === EFFECT_PARSED_MARKUP) {
        const fragment = core.wrapperFor(result.effectHandle);
        document._scriptProcessing?.activateParsedHandlers(fragment);
        imagesParsed(fragment);
      } else if (result.effect === EFFECT_SHEET_CHANGED) {
        const owner = core.wrapperFor(result.effectHandle);
        document._styleSystem?.sheetForElement(owner)?._changed();
        document._invalidateStyles();
      } else if (result.effect !== EFFECT_RECORDS) {
        throw new Error(`dom_batch_apply suspended with unknown effect ${result.effect}; known effects are 1 to 4`);
      }
      result = run(() => {
        core.status("dom_batch_resume", handle);
        return readResult("dom_batch_resume");
      });
    }
    if (result.status === BATCH_FAILED) {
      throw new Error(
        `Document operation ${result.operationIndex} (${OPCODE_NAMES.get(result.opcode) ?? result.opcode}) failed: ${result.diagnostic} (error kind ${result.errorKind})`,
      );
    }
    return result.returned;
  } finally {
    core.status("dom_batch_release", handle);
  }
}

// Runs normalized input record `record` on `backend`, the Sandom DOM of
// `root`, as its input path: text-input, clipboard and system-focus by the
// backend's methods, the other kinds as input records. Returns the
// backend's result. A replay gives it as `interact`.
export function dispatchInteraction(backend, root, record, options) {
  switch (record.kind) {
    case "text-input":
      return backend.insertText(root, record.text, { inputType: record.inputType });
    case "clipboard":
      if (record.action === "paste") return backend.paste(root, record.text);
      return record.action === "cut" ? backend.cut(root) : backend.copy(root);
    case "system-focus":
      return backend.systemFocus(root, record.focused);
    default:
      return backend.dispatchInputRecords(root, [record], options)[0];
  }
}

// The modifier fields of an input record from DOM event options.
const modifierFields = ({ shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) =>
  ({ shiftKey, altKey, controlKey: ctrlKey, metaKey });

const pointerFields = (options = {}) => {
  const {
    pointerId = 1, pointerType = "mouse", isPrimary = true, button = 0, buttons = 0, pressure = 0, tiltX = 0, tiltY = 0, twist = 0,
    width, height, tangentialPressure = 0, timeMilliseconds,
  } = options;
  return {
    pointerId, pointerType, isPrimary, button, buttons, pressure, tiltX, tiltY, twist, width, height, tangentialPressure,
    ...modifierFields(options), timeMilliseconds,
  };
};

/**
 * An input backend for bindProjectedInput that writes each input to the
 * log of `document` as an interact entry and runs it on `backend` through
 * dispatchInteraction, so a replay of the log gives the same input. Cursor,
 * context-menu and preference calls pass through unlogged: they change no
 * document state.
 */
export function createLoggedInput(backend, document) {
  const run = (root, record, options) =>
    withDocumentScope(document, "input", () => dispatchInteraction(backend, root, logInteraction(document, record), options));
  return {
    resolveCursor: (...args) => backend.resolveCursor(...args),
    setContextMenu: (...args) => backend.setContextMenu(...args),
    setEyeDropper: (...args) => backend.setEyeDropper(...args),
    setPreferences: (...args) => backend.setPreferences(...args),
    pointerDown: (root, x, y, options) => run(root, { kind: "pointer-down", x, y, ...pointerFields(options) }),
    pointerMove: (root, x, y, options) => run(root, { kind: "pointer-move", x, y, ...pointerFields({ button: -1, ...options }) }),
    pointerUp: (root, x, y, options) => run(root, { kind: "pointer-up", x, y, ...pointerFields(options) }),
    pointerCancel: (root, pointerId = 1) => run(root, { kind: "pointer-cancel", pointerId }),
    pointerLeave: (root, pointerId = 1) => run(root, { kind: "pointer-leave", pointerId }),
    wheel: (root, x, y, deltaX, deltaY, deltaMode = 0, options) =>
      run(root, { kind: "wheel", x, y, deltaX, deltaY, deltaMode, ...modifierFields(options) }),
    keydown: (root, key, { code = "", location = 0, repeat = false, ...options } = {}) =>
      run(root, { kind: "key-down", key, code, location, repeat, ...modifierFields(options) }),
    keyup: (root, key, { code = "", location = 0, repeat = false, ...options } = {}) =>
      run(root, { kind: "key-up", key, code, location, repeat, ...modifierFields(options) }),
    compositionStart: (root, text = "", options) => run(root, { kind: "composition-start", text, ...modifierFields(options) }),
    compositionUpdate: (root, text, options) => run(root, { kind: "composition-update", text, ...modifierFields(options) }),
    compositionEnd: (root, text, { cancelled = false, ...options } = {}) =>
      run(root, { kind: "composition-end", text, cancelled, ...modifierFields(options) }),
    insertText: (root, text, { inputType = "insertText" } = {}) => run(root, { kind: "text-input", text, inputType }),
    copy: (root) => run(root, { kind: "clipboard", action: "copy" }),
    cut: (root) => run(root, { kind: "clipboard", action: "cut" }),
    paste: (root, text) => run(root, { kind: "clipboard", action: "paste", text }),
    systemFocus: (root, focused) => run(root, { kind: "system-focus", focused: focused === true }),
    // Records that the binding builds itself (a wheel at a scroll
    // boundary), each logged and run with the caller's options.
    dispatchInputRecords: (root, records, options) => {
      const results = [];
      for (const { ctrlKey, ...record } of records) {
        results.push(run(root, { ...record, ...(ctrlKey === undefined ? {} : { controlKey: ctrlKey }) }, options));
      }
      return results;
    },
  };
}
