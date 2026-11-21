import { createMutationObserverClass } from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";
import { layoutConstant } from "../wasm/layout-table.js";

const OBSERVER_MUTATION = layoutConstant("OBSERVER_MUTATION");

// The queue node of observers.watpart and the callback record it holds
// (records.watpart), by WAT name.
const OBSERVER_QUEUED = Object.freeze(Object.fromEntries(["SIZE", "NEXT", "OLD_PRESENT", "RECORD", "NAMESPACE",
  "NAMESPACE_LENGTH"].map((name) => [name, layoutConstant(`OBSERVER_QUEUED_${name}`)])));
const CALLBACK_FIELD = Object.freeze(Object.fromEntries(["KIND", "TARGET", "RELATED_A", "RELATED_B", "PREVIOUS", "NEXT",
  "NAME_POINTER", "NAME_LENGTH", "OLD_VALUE_POINTER", "OLD_VALUE_LENGTH"]
  .map((name) => [name, layoutConstant(`CALLBACK_FIELD_${name}`)])));
const CALLBACK_RECORD_ATTRIBUTES = layoutConstant("CALLBACK_RECORD_ATTRIBUTES");

function normalizeOptions(options) {
  return {
    childList: Boolean(options?.childList),
    attributes: options?.attributes === undefined
      ? Boolean(options?.attributeOldValue || options?.attributeFilter)
      : Boolean(options.attributes),
    characterData: options?.characterData === undefined
      ? Boolean(options?.characterDataOldValue)
      : Boolean(options.characterData),
    subtree: Boolean(options?.subtree),
    attributeOldValue: Boolean(options?.attributeOldValue),
    characterDataOldValue: Boolean(options?.characterDataOldValue),
    attributeFilter: options?.attributeFilter === undefined
      ? null
      : [...options.attributeFilter].map(String),
  };
}

export class MutationRecord {
  constructor({
    type,
    target,
    addedNodes = [],
    removedNodes = [],
    previousSibling = null,
    nextSibling = null,
    attributeName = null,
    attributeNamespace = null,
    oldValue = null,
  }) {
    this.type = type;
    this.target = target;
    this.addedNodes = Object.freeze([...addedNodes]);
    this.removedNodes = Object.freeze([...removedNodes]);
    this.previousSibling = previousSibling;
    this.nextSibling = nextSibling;
    this.attributeName = attributeName;
    this.attributeNamespace = attributeNamespace;
    this.oldValue = oldValue;
    Object.freeze(this);
  }
}
Object.defineProperty(MutationRecord.prototype, Symbol.toStringTag, { value: "MutationRecord", configurable: true });

// JavaScript retains wrapper and callback identity; queued records and every
// checkpoint/drain decision are owned by the core.
class MutationObserverRuntime {
  constructor(document, callback) {
    this._core = document._domCore;
    this._document = document;
    this._ownerHandle = document._coreHandle;
    this._id = this._core.registerObserver(this);
    this._core.status("observer_create", this._id, this._ownerHandle, OBSERVER_MUTATION);
    this._callback = callback;
    this._targets = new Set();
  }

  _requireTarget(target) {
    if (!target || typeof target.nodeType !== "number") {
      throw new TypeError("MutationObserver.observe target must be a Node");
    }
    if (target._domCore !== this._core) {
      throw new TypeError(
        "MutationObserver.observe target belongs to another DOM core",
      );
    }
    return target;
  }

  _transportObserve(target, options) {
    this._core.observe(this._id, target._coreHandle, options);
    this._core.retainObserver(this);
    this._targets.add(target);
  }

  _transportDisconnect() {
    this._core.disconnectObserver(this._id);
    this._targets.clear();
  }

  _transportTakeRecords() {
    const checkpoint = this._core.status(
      "observer_take_records",
      this._id,
      this._ownerHandle,
    );
    try {
      return checkpointRecords(this._core, checkpoint, this._ownerHandle);
    } finally {
      this._core.status(
        "observer_checkpoint_abort",
        checkpoint,
        this._ownerHandle,
        0n,
      );
    }
  }
}

export const DocumentMutationObserver = createMutationObserverClass({
  Base: MutationObserverRuntime,
  normalizeOptions,
});

// The records of a checkpoint: the borrowed list that
// observer_checkpoint_records returns is decoded whole before wrapper
// creation runs other core operations.
function checkpointRecords(core, checkpoint, owner) {
  let pointer = core.status("observer_checkpoint_records", checkpoint, owner);
  const view = core.resultMemory("observer_checkpoint_records");
  const field = (name) => OBSERVER_QUEUED.RECORD + CALLBACK_FIELD[name];
  const entries = [];
  while (pointer) {
    const at = (offset) => pointer + offset;
    const kind = view.getUint32(at(field("KIND")), true);
    const stringAt = (offset, lengthOffset) =>
      view.memoryText(core.decoder, view.getUint32(at(offset), true), view.getUint32(at(lengthOffset), true));
    entries.push({
      kind,
      target: view.getBigUint64(at(field("TARGET")), true),
      added: view.getBigUint64(at(field("RELATED_A")), true),
      removed: view.getBigUint64(at(field("RELATED_B")), true),
      previous: view.getBigUint64(at(field("PREVIOUS")), true),
      following: view.getBigUint64(at(field("NEXT")), true),
      attributeName: kind === CALLBACK_RECORD_ATTRIBUTES ? stringAt(field("NAME_POINTER"), field("NAME_LENGTH")) : null,
      attributeNamespace: kind === CALLBACK_RECORD_ATTRIBUTES && view.getUint32(at(OBSERVER_QUEUED.NAMESPACE_LENGTH), true)
        ? stringAt(OBSERVER_QUEUED.NAMESPACE, OBSERVER_QUEUED.NAMESPACE_LENGTH)
        : null,
      oldValue: view.getUint32(at(OBSERVER_QUEUED.OLD_PRESENT), true) !== 0
        ? stringAt(field("OLD_VALUE_POINTER"), field("OLD_VALUE_LENGTH"))
        : null,
    });
    pointer = view.getUint32(at(OBSERVER_QUEUED.NEXT), true);
  }
  return entries.map(({ kind, target, added, removed, previous, following, attributeName, attributeNamespace, oldValue }) =>
    new MutationRecord({
      type: ["", "childList", "attributes", "characterData"][kind],
      target: core.wrapperFor(target),
      addedNodes: added ? [core.wrapperFor(added)] : [],
      removedNodes: removed ? [core.wrapperFor(removed)] : [],
      previousSibling: core.wrapperFor(previous),
      nextSibling: core.wrapperFor(following),
      attributeName,
      attributeNamespace,
      oldValue,
    })
  );
}

// Calls the observer's callback as component code of its document.
// Exception objects and reporting belong to the host: a microtask of the
// same component code rethrows the exception. The native checkpoint still
// receives one completion and continues its batch.
function invokeObserver(records) {
  try {
    this._callback(records, this);
    return 0;
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
    return 1;
  }
}

function deliverMutationCheckpoint(core, owner) {
  const checkpoint = core.status("observer_checkpoint_begin", owner);
  if (!checkpoint) return;
  let token = 0n;
  try {
    for (;;) {
      const id = core.status("observer_checkpoint_next", checkpoint, owner);
      if (!id) break;
      token = core.status("observer_checkpoint_token", checkpoint, owner);
      const records = checkpointRecords(core, checkpoint, owner);
      const observer = core.observersById.get(id)?.deref();
      let outcome = 0;
      try {
        if (observer) {
          outcome = enterComponentCode(observer._document, invokeObserver, observer, [records]);
        }
      } finally {
        core.status(
          "observer_checkpoint_resume",
          checkpoint,
          owner,
          token,
          outcome,
        );
        token = 0n;
      }
    }
  } finally {
    core.status("observer_checkpoint_abort", checkpoint, owner, token);
    scheduleMutationObservers(core);
  }
}

export function scheduleMutationObservers(core) {
  for (;;) {
    const owner = core.status("observer_checkpoint_request");
    if (!owner) return;
    queueMicrotask(() => deliverMutationCheckpoint(core, owner));
  }
}
