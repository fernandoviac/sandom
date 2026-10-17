import { createMutationObserverClass } from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";

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

// JavaScript retains wrapper and callback identity; queued records and every
// checkpoint/drain decision are owned by the core.
class MutationObserverRuntime {
  constructor(document, callback) {
    this._core = document._domCore;
    this._document = document;
    this._ownerHandle = document._coreHandle;
    this._id = this._core.registerObserver(this);
    this._core.status("observer_create", this._id, this._ownerHandle, 0);
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
    this._core.observersById.set(this._id, this);
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

function checkpointRecords(core, checkpoint, owner) {
  let pointer = core.status("observer_checkpoint_records", checkpoint, owner);
  const records = [];
  while (pointer) {
    const view = new DataView(core.memory.buffer, pointer, 88);
    const next = view.getUint32(0, true);
    const hasOldValue = view.getUint32(4, true) !== 0;
    const kind = view.getUint32(8, true);
    const target = view.getBigUint64(16, true);
    const added = view.getBigUint64(24, true);
    const removed = view.getBigUint64(32, true);
    const previous = view.getBigUint64(40, true);
    const following = view.getBigUint64(48, true);
    const stringAt = (offset) => {
      const start = view.getUint32(offset, true);
      const length = view.getUint32(offset + 4, true);
      return core.decoder.decode(
        core.refreshBytes().subarray(start, start + length),
      );
    };
    const attributeName = kind === 2 ? stringAt(56) : null;
    const attributeNamespace = kind === 2 && view.getUint32(84, true)
      ? stringAt(80)
      : null;
    const oldValue = hasOldValue ? stringAt(64) : null;
    // Decode all borrowed fields before wrapper creation can grow memory.
    records.push(
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
      }),
    );
    pointer = next;
  }
  return records;
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
      const observer = core.observersById.get(id);
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
