import { createInputBindings } from "./dom-bindings.generated.js";
import { createEvent, dispatchEvent as dispatchSandomEvent, SDDataTransfer } from "./events.js";
import { executeInputRun, inputInvoke as invoke } from "./input-activation.js";
import { scrollbarAtPoint } from "./presented-frame.js";

const measurementSymbol = Symbol.for("sandom.domCore.measurement");
const encoder = new TextEncoder();
const EVENTS = [null, "pointerout", "pointerleave", "pointerover", "pointerenter", "mouseout", "mouseleave", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup", "pointercancel", "lostpointercapture", "gotpointercapture", "wheel", "keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "change", "copy", "cut", "paste"];
const INPUT_TYPES = [null, "deleteContentBackward", "deleteContentForward", "insertLineBreak", "insertText", "insertCompositionText", "insertReplacementText", "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteWordBackward", "deleteWordForward"];
const INSERT_TEXT_TYPES = ["insertText", "insertReplacementText", "insertFromPaste", "insertFromDrop"];
const DELETE_SELECTION_TYPES = ["deleteContentBackward", "deleteContentForward", "deleteByCut"];
const stateFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("input_state_release", handle))
  : null;
// Text editing follows Chrome on one platform (plans/dom/PLAN-platform-
// editing-behavior.md): its key bindings and its caret motion rules. The
// code is the input state's platform in the DOM core.
const EDITING_PLATFORMS = Object.freeze({ mac: 0, windows: 1, linux: 2 });

// The platform of the host process: macOS for darwin, Windows for windows,
// Linux for every other system.
export function hostEditingPlatform() {
  const system = globalThis.Deno?.build?.os ?? globalThis.process?.platform;
  if (system === "darwin") return "mac";
  if (system === "windows" || system === "win32") return "windows";
  return "linux";
}

function protocolEnum(core, domain, value) {
  return typeof value === "string"
    ? core.status("input_schema_enum", domain, ...core.input(value))
    : 0;
}

// A pointer down, move or up without a time takes the time of the root's
// render surface clock: the clock its frames and momentum run on.
const TIMED_POINTER_KINDS = new Set(["pointer-down", "pointer-move", "pointer-up"]);
function pointerRecordTime(root, record) {
  if (record.timeMilliseconds !== undefined || !TIMED_POINTER_KINDS.has(record.kind)) return record.timeMilliseconds;
  const surface = root._renderSurface;
  if (!surface) throw new Error(`${record.kind} requires timeMilliseconds or a render surface whose clock supplies it`);
  return surface._now();
}

function encodeRecords(core, root, records) {
  const encoded = records.map((record) => {
    const text = record.key ?? record.text ?? record.value ?? "";
    const code = record.code ?? "";
    return { record, kind: protocolEnum(core, 0, record.kind), text: encoder.encode(typeof text === "string" ? text : ""), code: encoder.encode(typeof code === "string" ? code : ""), textLength: typeof text === "string" ? text.length : 0, pointerType: protocolEnum(core, 1, record.pointerType), action: protocolEnum(core, 2, record.action) };
  });
  const length = records.length * 160 + encoded.reduce((sum, item) => sum + item.text.byteLength + item.code.byteLength, 0);
  const pointer = core.exports.abi_allocate(length);
  const bytes = core.refreshBytes();
  bytes.fill(0, pointer, pointer + length);
  const view = new DataView(bytes.buffer);
  let cursor = records.length * 160;
  for (let index = 0; index < encoded.length; index++) {
    const item = encoded[index];
    const record = item.record;
    const base = pointer + index * 160;
    view.setUint32(base, item.kind, true);
    view.setUint32(base + 4, item.pointerType, true);
    view.setUint32(base + 8, (record.isPrimary ? 1 : 0) | (record.shiftKey ? 2 : 0) | (record.altKey ? 4 : 0) | (record.ctrlKey ? 8 : 0) | (record.metaKey ? 16 : 0) | (record.repeat ? 32 : 0) | (record.cancelled ? 64 : 0), true);
    for (const [offset, value] of [[16, record.pointerId], [24, record.x], [32, record.y], [40, record.deltaX], [48, record.deltaY], [56, pointerRecordTime(root, record)], [64, record.pressure], [72, record.button], [80, record.buttons], [112, record.selectionStart], [120, record.selectionEnd]]) {
      view.setFloat64(base + offset, value ?? 0, true);
    }
    view.setBigUint64(base + 88, record.target?._coreHandle ?? 0n, true);
    view.setUint32(base + 96, cursor, true);
    view.setUint32(base + 100, item.text.byteLength, true);
    bytes.set(item.text, pointer + cursor);
    cursor += item.text.byteLength;
    view.setUint32(base + 104, cursor, true);
    view.setUint32(base + 108, item.code.byteLength, true);
    bytes.set(item.code, pointer + cursor);
    cursor += item.code.byteLength;
    view.setUint32(base + 128, item.textLength, true);
    view.setUint32(base + 132, item.action || record.deltaMode || record.location || 0, true);
    view.setBigUint64(base + 136, root._coreHandle, true);
  }
  const measurement = globalThis[measurementSymbol];
  if (measurement) measurement.record({ category: "lifecycle", operation: "input_run_begin", direction: "host-to-core", bytes: length, allocations: encoded.length * 2, allocationBytes: length - records.length * 160 });
  return [pointer, length];
}

function documentOf(root) {
  return root.nodeType === 9 ? root : root.ownerDocument;
}

// The text an edit of this input type inserts; deletes insert nothing.
function insertedText(inputType, record) {
  if (inputType >= 4 && inputType <= 8) return record.key ?? record.text ?? record.value;
  return inputType === 3 ? "\n" : null;
}

function inputTypeCode(operation, inputType, allowed) {
  if (!allowed.includes(inputType)) {
    throw new RangeError(`${operation}: unknown inputType ${String(inputType)}; use one of ${allowed.join(", ")}`);
  }
  return INPUT_TYPES.indexOf(inputType);
}

// The clipboard text of a copy or cut (input run host effect 1; see
// $inputClipboardDefault): the listeners' data, or the core's text.
function clipboardText(core, notification, record) {
  const { aux } = notification;
  if (aux === 0) {
    return record.clipboardData.types.includes("text/plain") ? record.clipboardData.getData("text/plain") : null;
  }
  if (aux === 1 || aux === 2) {
    const text = core.decoder.decode(core.refreshBytes().subarray(notification.a, notification.a + notification.b));
    return aux === 2 && text === "" ? null : text;
  }
  if (aux === 3) return null;
  throw new Error(`Unknown native clipboard text source ${aux}`);
}

// The Event of an input batch event notification (input action 1's fields).
function eventFor(notification, record, relatedTarget) {
  const { code, aux } = notification;
  const fields = { bubbles: Boolean(notification.flags & 1), cancelable: Boolean(notification.flags & 2), composed: Boolean(notification.flags & 4) };
  const modifiers = { shiftKey: record.shiftKey ?? false, altKey: record.altKey ?? false, ctrlKey: record.ctrlKey ?? false, metaKey: record.metaKey ?? false };
  if (code <= 17) {
    if (aux & 32) {
      fields.pointerId = record.pointerId;
    } else {
      Object.assign(fields, modifiers, { button: aux & 1 ? -1 : record.button ?? 0, buttons: aux & 2 ? 0 : aux & 4 ? 1 : record.buttons ?? 0, clientX: aux & 8 ? 0 : record.x ?? 0, clientY: aux & 8 ? 0 : record.y ?? 0 });
      if (![5, 6, 7, 8, 10, 12, 14].includes(code)) {
        Object.assign(fields, { pointerId: record.pointerId, pointerType: aux & 16 ? [null, "mouse", "pen", "touch"][notification.c] : record.pointerType, isPrimary: aux & 16 ? Boolean(notification.d) : record.isPrimary, pressure: record.pressure ?? 0 });
      }
      if (code <= 8) fields.relatedTarget = relatedTarget;
    }
  } else if (code === 18) {
    Object.assign(fields, modifiers, { clientX: record.x, clientY: record.y, deltaX: record.deltaX, deltaY: record.deltaY, deltaMode: record.deltaMode });
  } else if (code === 19 || code === 20) {
    Object.assign(fields, modifiers, { key: record.key, code: record.code ?? "", location: record.location ?? 0, repeat: record.repeat ?? false });
  } else if (code >= 21 && code <= 23) {
    Object.assign(fields, modifiers, { data: aux & 512 ? "" : record.text });
  } else if (code === 24 || code === 25) {
    const inputType = aux & 255;
    Object.assign(fields, { inputType: INPUT_TYPES[inputType], data: insertedText(inputType, record), isComposing: Boolean(aux & 256) });
  } else if (code >= 27 && code <= 29) {
    fields.clipboardData = record.clipboardData;
  }
  return createEvent(EVENTS[code], fields);
}

export function createInputController(layoutOptions, editingPlatform) {
  if (!Object.hasOwn(EDITING_PLATFORMS, editingPlatform)) {
    throw new RangeError(
      `editingPlatform must be "mac", "windows" or "linux", got ${JSON.stringify(editingPlatform)}`,
    );
  }
  const platform = EDITING_PLATFORMS[editingPlatform];
  const states = new WeakMap();
  function stateFor(node) {
    const owner = node.nodeType === 9 ? node : node.ownerDocument;
    let state = states.get(owner);
    if (!state) {
      const core = owner._domCore;
      state = { core, handle: invoke(core, "input_state_create", owner._coreHandle, platform), root: node };
      states.set(owner, state);
      stateFinalizer?.register(state, { core, handle: state.handle });
    }
    return state;
  }
  function snapshotFor(root, required = true) {
    const snapshot = root._renderSurface?.presentedFrame ?? null;
    if (!snapshot && required) throw new Error("Host input requires a presented frame: attach a render surface and deliver one frame before dispatching input.");
    return snapshot;
  }
  // Binds the scroll owner of the root's render surface and the document
  // Selection to the state; a run that begins next executes against them.
  function bind(state, root) {
    invoke(state.core, "input_state_bind", state.handle, root._renderSurface?._scrollOwner ?? 0n, documentOf(root).getSelection()._handle);
  }
  // Executes run `run` over `records` (src/dom-wasm/input-run.watpart): the
  // core executes every default action; this host dispatches the events,
  // runs the record hooks and applies the facade's effects.
  function runOwned(state, root, run, records, hooks = {}) {
    const core = state.core;
    const results = new Array(records.length);
    const viewportResults = new Set();
    let scrollbarChanged = false;
    let valueChanged = false;
    let copiedText = null;
    let scrolled = false;
    executeInputRun(core, run, {
      batchEvent(notification) {
        const index = notification.record;
        let target;
        if (notification.aux & 64) {
          viewportResults.add(index);
          target = root._renderSurface?.viewport;
        } else {
          target = core.wrapperFor(notification.target);
        }
        const event = eventFor(notification, records[index], core.wrapperFor(notification.related));
        dispatchSandomEvent(target, event);
        return event.defaultPrevented ? 1 : 0;
      },
      valueEdited(notification) {
        if (notification.c) valueChanged = true;
      },
      scrolled(notification) {
        const action = notification.aux;
        if (notification.target === 0n && action !== 9) viewportResults.add(notification.record);
        if (action === 7) scrolled = Boolean(notification.a) || scrolled;
        if (action === 11) scrollbarChanged = true;
        root._renderSurface?._inputScrolled(action, Boolean(notification.a));
      },
      clipboard(notification) {
        copiedText = clipboardText(core, notification, records[notification.record]);
      },
      recordHook(notification) {
        const index = notification.record;
        const record = records[index];
        const target = core.wrapperFor(notification.target);
        if (notification.code === 15) {
          scrolled = false;
          hooks.beforeRecord?.(record, index);
        } else if (notification.code === 16) {
          const result = record.kind === "pointer-leave"
            ? null
            : target ?? (viewportResults.has(index) ? root._renderSurface?.viewport : null);
          results[index] = result;
          hooks.afterRecord?.(record, index, result, scrolled);
        } else if (notification.code === 17) {
          target._pointerController = pointerController;
          target._layoutOptions = layoutOptions;
        } else {
          throw new Error(`Unknown native input record hook ${notification.code}`);
        }
      },
    });
    return { results, scrollbarChanged, valueChanged, copiedText };
  }
  // A run over a batch that `begin` makes, with the root's binding.
  function adopt(state, root, begin) {
    bind(state, root);
    return invoke(state.core, "input_run_adopt", begin());
  }
  function dispatchBatch(root, records, hooks = {}) {
    const state = stateFor(root);
    state.root = root;
    const requiresSnapshot = records.some((record) => record.kind.startsWith("pointer-") || record.kind === "wheel");
    const snapshot = hooks.snapshot ?? snapshotFor(root, requiresSnapshot);
    if (snapshot && snapshot.geometryCore !== state.core) {
      throw new TypeError("Input snapshot must use the document's DOM core.");
    }
    bind(state, root);
    const [pointer, length] = encodeRecords(state.core, root, records);
    // The surface's touch-panning opt-in travels with the batch; the engine
    // decides whether a drag pans.
    const touchPanning = root._renderSurface?._touchPanning ? 1 : 0;
    const run = invoke(state.core, "input_run_begin", state.handle, snapshot?.geometryHandle ?? 0n, pointer, length, records.length, touchPanning);
    const results = runOwned(state, root, run, records, hooks).results;
    // The engine knows which CSS cursor belongs at a document point. A host
    // that named an element for it gets the answer applied there, so the
    // pointer over text is a text cursor without every interactive host
    // resolving and assigning it again.
    const surface = root._renderSurface;
    if (surface?._cursorTarget && snapshot) {
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (typeof record.x !== "number" || typeof record.y !== "number") {
          continue;
        }
        surface._applyCursor(record.x, record.y);
        break;
      }
    }
    // The scrollbar under the pointer shows an overlay bar and holds it
    // shown (design/scrollbars.md, decision 2); a pointer that
    // goes down on a thumb presses it until the pointer goes up.
    const pointerRecord = records.findLast((record) => record.kind.startsWith("pointer-"));
    if (surface && pointerRecord) {
      const positioned = (record) => record.kind !== "pointer-leave" && snapshot &&
        typeof record.x === "number" && typeof record.y === "number";
      let pressed;
      for (const record of records) {
        if (record.kind === "pointer-down" && positioned(record)) {
          const bar = scrollbarAtPoint(snapshot, record.x, record.y);
          pressed = bar && record.x >= bar.thumb.x && record.x < bar.thumb.x + bar.thumb.width &&
              record.y >= bar.thumb.y && record.y < bar.thumb.y + bar.thumb.height
            ? bar
            : null;
        } else if (record.kind === "pointer-up" || record.kind === "pointer-cancel") {
          pressed = null;
        }
      }
      surface._noteScrollbarPointer(
        positioned(pointerRecord) ? scrollbarAtPoint(snapshot, pointerRecord.x, pointerRecord.y) : null,
        pressed,
      );
    }
    return results;
  }
  const pointerController = {
    capture(element, pointerId) {
      const state = stateFor(element);
      const run = adopt(state, state.root, () => invoke(state.core, "input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, 0));
      runOwned(state, state.root, run, [{ kind: "pointer-capture", pointerId }]);
    },
    release(element, pointerId) {
      const state = stateFor(element);
      const run = adopt(state, state.root, () => invoke(state.core, "input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, 1));
      runOwned(state, state.root, run, [{ kind: "pointer-release", pointerId }]);
    },
    has(element, pointerId) {
      const state = stateFor(element);
      return invoke(state.core, "input_pointer_has_capture", state.handle, element._coreHandle, pointerId) !== 0;
    },
  };
  function one(root, record) { return dispatchBatch(root, [record])[0]; }
  // Host editing commands: 1 text edit (code = input type), 2 select all,
  // 3 clipboard (code 1 copy, 2 cut, 3 paste). The engine owns every
  // default; see $inputEditPrepare.
  function edit(root, operation, target, command, code, text, record) {
    if (typeof text !== "string") throw new TypeError(`${operation}: text must be a string, received ${typeof text}`);
    if (typeof target?._coreHandle !== "bigint") throw new TypeError(`${operation}: target must be a Sandom node, received ${String(target)}`);
    const state = stateFor(root);
    state.root = root;
    bind(state, root);
    const run = invoke(state.core, "input_run_edit_begin", state.handle, target._coreHandle, root._coreHandle, command, code, ...state.core.input(text));
    return runOwned(state, root, run, [record]);
  }
  const runtime = {
    pointerController,
    dispatchInputRecords: dispatchBatch,
    resolveCursor(root, x, y) {
      const snapshot = snapshotFor(root);
      return snapshot.geometryCore.string("input_pointer_cursor", snapshot.geometryHandle, x, y);
    },
    wheel(root, x, y, deltaX, deltaY, deltaMode = 0, { shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "wheel", x, y, deltaX, deltaY, deltaMode, shiftKey, altKey, ctrlKey, metaKey });
    },
    keydown(root, key, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, code = "", location = 0, repeat = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "key-down", target, key, code, location, repeat, shiftKey, altKey, ctrlKey, metaKey });
    },
    keyup(root, key, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, code = "", location = 0, repeat = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "key-up", target, key, code, location, repeat, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionStart(root, text = "", { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-start", target, text, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionUpdate(root, text, { shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-update", text, shiftKey, altKey, ctrlKey, metaKey });
    },
    compositionEnd(root, text, { cancelled = false, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
      return one(root, { kind: "composition-end", text, cancelled, shiftKey, altKey, ctrlKey, metaKey });
    },
    accessibilityAction(root, target, action) { return one(root, { ...action, kind: "accessibility-action", target }); },
    pointerDown(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, buttons = 1, pressure = 0.5, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-down", x, y, pointerId, pointerType, isPrimary, button, buttons, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerMove(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, buttons = 1, pressure = 0.5, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-move", x, y, pointerId, pointerType, isPrimary, button: -1, buttons, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerUp(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, pressure = 0, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-up", x, y, pointerId, pointerType, isPrimary, button, buttons: 0, pressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerCancel(root, pointerId = 1) { return one(root, { kind: "pointer-cancel", pointerId }); },
    pointerLeave(root, pointerId = 1) { return one(root, { kind: "pointer-leave", pointerId }); },
    scrollbarKeydown(root, element, orientation, key) {
      const state = stateFor(root);
      const snapshot = snapshotFor(root);
      const code = state.core.status("input_key_code", ...state.core.input(key));
      const run = adopt(state, root, () => invoke(state.core, "input_pointer_scrollbar_key_begin", state.handle, snapshot.geometryHandle, element?._coreHandle ?? 0n, orientation === "vertical" ? 1 : 0, code));
      return runOwned(state, root, run, [{ kind: "scrollbar-key", key }]).scrollbarChanged;
    },
    insertText(root, text, { inputType = "insertText", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("insertText", inputType, INSERT_TEXT_TYPES);
      return edit(root, "insertText", target, 1, code, text, { kind: "text-edit", text }).valueChanged;
    },
    deleteSelection(root, { inputType = "deleteContentBackward", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("deleteSelection", inputType, DELETE_SELECTION_TYPES);
      return edit(root, "deleteSelection", target, 1, code, "", { kind: "text-edit", text: "" }).valueChanged;
    },
    selectAll(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      edit(root, "selectAll", target, 2, 0, "", { kind: "select-all" });
    },
    copy(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "copy", target, 3, 1, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    cut(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "cut", target, 3, 2, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    paste(root, text, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const clipboardData = new SDDataTransfer();
      if (typeof text === "string") clipboardData.setData("text/plain", text);
      return edit(root, "paste", target, 3, 3, text, { kind: "clipboard", text, clipboardData }).valueChanged;
    },
  };
  return { ...runtime, ...createInputBindings(runtime) };
}
