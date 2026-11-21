import { createInputBindings } from "./dom-bindings.generated.js";
import { createEvent, dispatchEvent as dispatchSandomEvent } from "./events.js";
import { SDDataTransfer } from "./data-transfer.js";
import { effectText, eventFlagsInit, executeInputRun, INPUT_OUTCOME, setSystemFocus } from "./input-activation.js";
import { fieldMenuCommand, runFieldMenuCommand } from "./field-menu.js";
import { eyedropperRequest, releaseEyedropperCapture, runEyedropper } from "./eyedropper.js";
import { autofill, autofillFields, autofillSuggestions } from "./autofill.js";
import { scrollbarAtPoint } from "./presented-frame.js";
import { withPresentedPageGeometry } from "./live-geometry.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { localNow } from "./local-time.js";

const INPUT_SCHEMA_UNKNOWN = layoutConstant("INPUT_SCHEMA_UNKNOWN");
const INPUT_AUX_VIEWPORT_TARGET = layoutConstant("INPUT_AUX_VIEWPORT_TARGET");

const measurementSymbol = Symbol.for("sandom.domCore.measurement");
const INPUT_TYPES_INSERT_TEXT = layoutConstant("INPUT_TYPES_INSERT_TEXT");
const INPUT_TYPES_DELETE_SELECTION = layoutConstant("INPUT_TYPES_DELETE_SELECTION");
const INPUT_AUX_INPUT_TYPE_MASK = layoutConstant("INPUT_AUX_INPUT_TYPE_MASK");
const INPUT_AUX_COMPOSING = layoutConstant("INPUT_AUX_COMPOSING");
// The normalized input kinds that a backend method delivers rather than
// an input batch, by that method.
const METHOD_INPUT_KINDS = Object.freeze({
  "text-input": "insertText",
  "clipboard": "copy, cut or paste",
  "system-focus": "systemFocus",
});
// The event type, inputType and pointerType names of the core's codes.
const coreName = (exportName) => (code) => sharedDomCore.string(exportName, code);
const INPUT_SOURCE_BATCH = layoutConstant("INPUT_SOURCE_BATCH");
const eventName = (code) => sharedDomCore.string("input_event_type", INPUT_SOURCE_BATCH, code);
const inputTypeName = coreName("input_type_name");
const pointerTypeName = coreName("input_pointer_type_name");
const stateFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ core, handle }) => core.status("input_state_release", handle))
  : null;
// Text editing follows Chrome on one platform (plans/dom/PLAN-platform-
// editing-behavior.md): its key bindings and its caret motion rules. The
// code is the input state's platform in the DOM core.
const EDITING_PLATFORMS = Object.freeze({
  mac: layoutConstant("INPUT_PLATFORM_MAC"),
  windows: layoutConstant("INPUT_PLATFORM_WINDOWS"),
  linux: layoutConstant("INPUT_PLATFORM_LINUX"),
});

// The platform of the host: in a browser, the platform the browser reports
// (navigator.userAgentData, else navigator.platform); in a host process,
// the system it runs on. macOS and Windows by their names, Linux for
// every other system.
export function hostEditingPlatform() {
  const browser = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform;
  if (typeof browser === "string" && globalThis.Deno === undefined) {
    if (/^mac/i.test(browser)) return "mac";
    if (/^win/i.test(browser)) return "windows";
    return "linux";
  }
  const system = globalThis.Deno?.build?.os ?? globalThis.process?.platform;
  if (system === "darwin") return "mac";
  if (system === "windows" || system === "win32") return "windows";
  return "linux";
}

// The double-click interval of each editing platform's default settings,
// in milliseconds: macOS NSEvent.doubleClickInterval, Windows
// GetDoubleClickTime and GNOME's double-click setting.
const DEFAULT_DOUBLE_CLICK_INTERVALS = Object.freeze({ mac: 500, windows: 500, linux: 400 });
// The setting of the host's system, where a host process may read it:
// macOS `defaults read -g com.apple.mouse.doubleClickThreshold` (seconds;
// absent until the user changes it), Windows' registry DoubleClickSpeed
// and GNOME's gsettings (milliseconds). A browser page cannot read it, and
// a process without the permission to run the reader does not; both take
// the platform's default.
const DOUBLE_CLICK_READERS = Object.freeze({
  mac: { command: "defaults", args: ["read", "-g", "com.apple.mouse.doubleClickThreshold"], scale: 1000 },
  windows: { command: "reg", args: ["query", "HKCU\\Control Panel\\Mouse", "/v", "DoubleClickSpeed"], scale: 1 },
  linux: { command: "gsettings", args: ["get", "org.gnome.desktop.peripherals.mouse", "double-click"], scale: 1 },
});
// The system's setting, read once in a process.
let systemDoubleClickInterval;
export function hostDoubleClickInterval(editingPlatform) {
  const fallback = DEFAULT_DOUBLE_CLICK_INTERVALS[editingPlatform];
  const Deno = globalThis.Deno;
  if (Deno === undefined || hostEditingPlatform() !== editingPlatform) return fallback;
  systemDoubleClickInterval ??= readSystemDoubleClickInterval(Deno, editingPlatform, fallback);
  return systemDoubleClickInterval;
}
function readSystemDoubleClickInterval(Deno, editingPlatform, fallback) {
  const reader = DOUBLE_CLICK_READERS[editingPlatform];
  if (Deno.permissions.querySync({ name: "run", command: reader.command }).state !== "granted") return fallback;
  let output;
  try {
    output = new Deno.Command(reader.command, { args: reader.args, stdout: "piped", stderr: "null" }).outputSync();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return fallback;
    throw error;
  }
  // A setting the user never changed is absent: the reader fails.
  if (!output.success) return fallback;
  const text = new TextDecoder().decode(output.stdout);
  const number = Number(/(\d+(?:\.\d+)?)\s*$/.exec(text.trim())?.[1]);
  if (!Number.isFinite(number)) {
    throw new Error(`hostDoubleClickInterval: ${reader.command} ${reader.args.join(" ")} printed ${JSON.stringify(text)}, which holds no interval; pass doubleClickInterval to createSandomDOM`);
  }
  return Math.min(10000, number * reader.scale);
}

function protocolEnum(core, domain, value) {
  return typeof value === "string"
    ? core.status("input_schema_enum", domain, ...core.input(value))
    : INPUT_SCHEMA_UNKNOWN;
}

// A pointer down, move or up without a time takes the time of the root's
// render surface clock: the clock its frames and momentum run on. A key
// down or up takes it when the root has a surface; that time ends a
// select's type-ahead (core/dom/select-type-ahead.watpart).
const TIMED_POINTER_KINDS = new Set(["pointer-down", "pointer-move", "pointer-up"]);
const TIMED_KEY_KINDS = new Set(["key-down", "key-up"]);
function recordTime(root, record) {
  if (record.timeMilliseconds !== undefined) return record.timeMilliseconds;
  const surface = root._renderSurface;
  if (TIMED_KEY_KINDS.has(record.kind)) return surface?._now();
  if (!TIMED_POINTER_KINDS.has(record.kind)) return undefined;
  if (!surface) throw new Error(`${record.kind} requires timeMilliseconds or a render surface whose clock supplies it`);
  return surface._now();
}

// The input record and the input action kinds of input.watpart, by WAT name
// without the INPUT_ prefix.
const INPUT = Object.freeze(Object.fromEntries([
  "RECORD_SIZE", "RECORD_KIND", "RECORD_TYPE", "RECORD_FLAGS", "RECORD_POINTER_ID", "RECORD_X", "RECORD_Y",
  "RECORD_DELTA_X", "RECORD_DELTA_Y", "RECORD_TIME", "RECORD_PRESSURE", "RECORD_BUTTON", "RECORD_BUTTONS",
  "RECORD_TARGET", "RECORD_TEXT_OFFSET", "RECORD_TEXT_LENGTH", "RECORD_CODE_OFFSET", "RECORD_CODE_LENGTH",
  "RECORD_SELECTION_START", "RECORD_SELECTION_END", "RECORD_UTF16_LENGTH", "RECORD_AUXILIARY", "RECORD_ROOT",
  "RECORD_TILT_X", "RECORD_TILT_Y", "RECORD_TWIST", "RECORD_WIDTH", "RECORD_HEIGHT", "RECORD_TANGENTIAL_PRESSURE",
  "FLAG_PRIMARY", "FLAG_SHIFT", "FLAG_ALT", "FLAG_CTRL", "FLAG_META", "FLAG_REPEAT", "FLAG_CANCELLED",
  "ACTION_SCROLL_CHAIN", "ACTION_SCROLL_INTERACTION_END", "ACTION_SCROLLBAR", "ACTION_RECORD_START",
  "ACTION_RECORD_END", "ACTION_POINTER_TARGET",
].map((name) => [name, layoutConstant(`INPUT_${name}`)])));
// The Event init fields that input_event_fields names (input-run.watpart),
// by WAT name without the INPUT_EVENT_FIELD_ prefix.
const EVENT_FIELD = Object.freeze(Object.fromEntries([
  "MODIFIERS", "BUTTON", "BUTTON_NONE", "BUTTONS", "BUTTONS_NONE", "BUTTONS_PRIMARY", "CLIENT", "CLIENT_ZERO",
  "POINTER_ID", "POINTER", "POINTER_TYPE_CORE", "RELATED_TARGET", "WHEEL", "KEY", "DATA", "DATA_EMPTY",
  "INPUT_TYPE", "INSERTED_TEXT", "CLIPBOARD", "DATA_TRANSFER", "DETAIL", "POINTER_LAST",
].map((name) => [name, layoutConstant(`INPUT_EVENT_FIELD_${name}`)])));
// The output of input_run_pointer_last (input-pointer.watpart), by WAT name
// without the INPUT_POINTER_LAST_ prefix.
const POINTER_LAST = Object.freeze(Object.fromEntries([
  "SIZE", "X", "Y", "PRESSURE", "TYPE", "PRIMARY", "TILT_X", "TILT_Y", "TWIST", "WIDTH", "HEIGHT", "TANGENTIAL_PRESSURE",
].map((name) => [name, layoutConstant(`INPUT_POINTER_LAST_${name}`)])));

const CLIPBOARD = Object.freeze(Object.fromEntries(["LISTENER_DATA", "CONTROL_SELECTION", "DOCUMENT_SELECTION", "NONE", "READ_REPLY", "READ_REFUSE"]
  .map((name) => [name, layoutConstant(`INPUT_CLIPBOARD_${name}`)])));
// The commands and clipboard operations of input_edit_begin, by WAT name
// without the INPUT_EDIT_ prefix.
const EDIT = Object.freeze(Object.fromEntries(["TEXT", "SELECT_ALL", "CLIPBOARD", "COMMAND", "HISTORY", "PICKER", "COPY", "CUT", "PASTE"]
  .map((name) => [name, layoutConstant(`INPUT_EDIT_${name}`)])));
function encodeRecords(core, root, records) {
  const encoded = records.map((record) => {
    const text = record.key ?? record.text ?? record.value ?? "";
    const code = record.code ?? "";
    return { record, kind: protocolEnum(core, 0, record.kind), text: core.encoder.encode(typeof text === "string" ? text : ""), code: core.encoder.encode(typeof code === "string" ? code : ""), textLength: typeof text === "string" ? text.length : 0, pointerType: protocolEnum(core, 1, record.pointerType), action: protocolEnum(core, 2, record.action) };
  });
  const length = records.length * INPUT.RECORD_SIZE + encoded.reduce((sum, item) => sum + item.text.byteLength + item.code.byteLength, 0);
  const pointer = core.exports.abi_allocate(length);
  const bytes = core.refreshBytes();
  bytes.fill(0, pointer, pointer + length);
  const view = new DataView(bytes.buffer);
  let cursor = records.length * INPUT.RECORD_SIZE;
  for (let index = 0; index < encoded.length; index++) {
    const item = encoded[index];
    const record = item.record;
    const base = pointer + index * INPUT.RECORD_SIZE;
    view.setUint32(base + INPUT.RECORD_KIND, item.kind, true);
    view.setUint32(base + INPUT.RECORD_TYPE, item.pointerType, true);
    view.setUint32(base + INPUT.RECORD_FLAGS, (record.isPrimary ? INPUT.FLAG_PRIMARY : 0) | (record.shiftKey ? INPUT.FLAG_SHIFT : 0) |
      (record.altKey ? INPUT.FLAG_ALT : 0) | (record.ctrlKey ? INPUT.FLAG_CTRL : 0) | (record.metaKey ? INPUT.FLAG_META : 0) |
      (record.repeat ? INPUT.FLAG_REPEAT : 0) | (record.cancelled ? INPUT.FLAG_CANCELLED : 0), true);
    for (const [field, value] of [[INPUT.RECORD_POINTER_ID, record.pointerId], [INPUT.RECORD_X, record.x],
      [INPUT.RECORD_Y, record.y], [INPUT.RECORD_DELTA_X, record.deltaX], [INPUT.RECORD_DELTA_Y, record.deltaY],
      [INPUT.RECORD_TIME, recordTime(root, record)], [INPUT.RECORD_PRESSURE, record.pressure],
      [INPUT.RECORD_BUTTON, record.button], [INPUT.RECORD_BUTTONS, record.buttons],
      [INPUT.RECORD_SELECTION_START, record.selectionStart], [INPUT.RECORD_SELECTION_END, record.selectionEnd],
      [INPUT.RECORD_TILT_X, record.tiltX], [INPUT.RECORD_TILT_Y, record.tiltY], [INPUT.RECORD_TWIST, record.twist],
      [INPUT.RECORD_TANGENTIAL_PRESSURE, record.tangentialPressure]]) {
      view.setFloat64(base + field, value ?? 0, true);
    }
    // A width or height that the record does not give is NaN: the core
    // gives such a pointer the default 1 (Pointer Events 3 §4.1).
    view.setFloat64(base + INPUT.RECORD_WIDTH, record.width ?? NaN, true);
    view.setFloat64(base + INPUT.RECORD_HEIGHT, record.height ?? NaN, true);
    view.setBigUint64(base + INPUT.RECORD_TARGET, record.target?._coreHandle ?? 0n, true);
    view.setUint32(base + INPUT.RECORD_TEXT_OFFSET, cursor, true);
    view.setUint32(base + INPUT.RECORD_TEXT_LENGTH, item.text.byteLength, true);
    bytes.set(item.text, pointer + cursor);
    cursor += item.text.byteLength;
    view.setUint32(base + INPUT.RECORD_CODE_OFFSET, cursor, true);
    view.setUint32(base + INPUT.RECORD_CODE_LENGTH, item.code.byteLength, true);
    bytes.set(item.code, pointer + cursor);
    cursor += item.code.byteLength;
    view.setUint32(base + INPUT.RECORD_UTF16_LENGTH, item.textLength, true);
    view.setUint32(base + INPUT.RECORD_AUXILIARY, item.action || record.deltaMode || record.location || 0, true);
    view.setBigUint64(base + INPUT.RECORD_ROOT, root._coreHandle, true);
  }
  const measurement = globalThis[measurementSymbol];
  if (measurement) measurement.record({ category: "lifecycle", operation: "input_run_begin", direction: "host-to-core", bytes: length, allocations: encoded.length * 2, allocationBytes: length - records.length * INPUT.RECORD_SIZE });
  return [pointer, length];
}

function documentOf(root) {
  return root.nodeType === 9 ? root : root.ownerDocument;
}

function inputTypeCode(operation, inputType, set) {
  const code = sharedDomCore.status("input_type_code", set, ...sharedDomCore.input(String(inputType)));
  if (code === 0) throw new RangeError(`${operation}: ${sharedDomCore.outputString("input_type_code")}`);
  return code;
}

// The clipboard text of a copy or cut (input run host effect 1; see
// $inputClipboardDefault): the listeners' data, nothing, or the core's text.
function clipboardText(core, notification, record) {
  const { aux } = notification;
  if (aux === CLIPBOARD.LISTENER_DATA) {
    return record.clipboardData.types.includes("text/plain") ? record.clipboardData.getData("text/plain") : null;
  }
  if (aux === CLIPBOARD.NONE) return null;
  if (aux === CLIPBOARD.CONTROL_SELECTION || aux === CLIPBOARD.DOCUMENT_SELECTION) {
    return core.decoder.decode(core.refreshBytes().subarray(notification.a, notification.a + notification.b));
  }
  throw new Error(`Unknown native clipboard text source ${aux}`);
}

// The Event of an input batch event notification (input action 1's
// fields) of run `run`: the core names the init fields, and each comes from
// the record, from the core's state of the pointer or is the constant its
// bit names.
function eventFor(core, run, notification, record, relatedTarget) {
  const { code, aux } = notification;
  const has = core.exports.input_event_fields(code, aux);
  const fields = eventFlagsInit(notification.flags);
  if (has & EVENT_FIELD.MODIFIERS) Object.assign(fields, { shiftKey: record.shiftKey ?? false, altKey: record.altKey ?? false, ctrlKey: record.ctrlKey ?? false, metaKey: record.metaKey ?? false });
  if (has & EVENT_FIELD.BUTTON) fields.button = record.button ?? 0;
  if (has & EVENT_FIELD.BUTTON_NONE) fields.button = -1;
  if (has & EVENT_FIELD.BUTTONS) fields.buttons = record.buttons ?? 0;
  if (has & EVENT_FIELD.BUTTONS_NONE) fields.buttons = 0;
  if (has & EVENT_FIELD.BUTTONS_PRIMARY) fields.buttons = 1;
  if (has & EVENT_FIELD.CLIENT) Object.assign(fields, { clientX: record.x ?? 0, clientY: record.y ?? 0 });
  if (has & EVENT_FIELD.CLIENT_ZERO) Object.assign(fields, { clientX: 0, clientY: 0 });
  if (has & (EVENT_FIELD.POINTER_ID | EVENT_FIELD.POINTER)) fields.pointerId = record.pointerId;
  if (has & EVENT_FIELD.POINTER) {
    Object.assign(fields, {
      pointerType: record.pointerType, isPrimary: record.isPrimary, pressure: record.pressure ?? 0, tiltX: record.tiltX, tiltY: record.tiltY,
      twist: record.twist, width: record.width, height: record.height, tangentialPressure: record.tangentialPressure,
    });
  }
  if (has & EVENT_FIELD.POINTER_TYPE_CORE) Object.assign(fields, { pointerType: pointerTypeName(notification.c), isPrimary: Boolean(notification.d) });
  if (has & EVENT_FIELD.RELATED_TARGET) fields.relatedTarget = relatedTarget;
  if (has & EVENT_FIELD.WHEEL) Object.assign(fields, { deltaX: record.deltaX, deltaY: record.deltaY, deltaMode: record.deltaMode });
  if (has & EVENT_FIELD.KEY) Object.assign(fields, { key: record.key, code: record.code ?? "", location: record.location ?? 0, repeat: record.repeat ?? false });
  if (has & EVENT_FIELD.DATA) fields.data = record.text;
  if (has & EVENT_FIELD.DATA_EMPTY) fields.data = "";
  if (has & EVENT_FIELD.INPUT_TYPE) {
    Object.assign(fields, {
      inputType: inputTypeName(aux & INPUT_AUX_INPUT_TYPE_MASK), data: null, isComposing: Boolean(aux & INPUT_AUX_COMPOSING),
    });
  }
  if (has & EVENT_FIELD.INSERTED_TEXT) fields.data = record.key ?? record.text ?? record.value;
  if (has & EVENT_FIELD.CLIPBOARD) fields.clipboardData = record.clipboardData;
  if (has & EVENT_FIELD.DATA_TRANSFER) fields.dataTransfer = record.clipboardData ?? null;
  if (has & EVENT_FIELD.DETAIL) fields.detail = notification.a;
  if (has & EVENT_FIELD.POINTER_LAST) {
    core.status("input_run_pointer_last", run);
    const view = core.output("input_run_pointer_last");
    const type = view.getUint32(POINTER_LAST.TYPE, true);
    Object.assign(fields, {
      clientX: view.getFloat64(POINTER_LAST.X, true), clientY: view.getFloat64(POINTER_LAST.Y, true),
      pressure: view.getFloat64(POINTER_LAST.PRESSURE, true), isPrimary: view.getUint32(POINTER_LAST.PRIMARY, true) !== 0,
      tiltX: view.getFloat64(POINTER_LAST.TILT_X, true), tiltY: view.getFloat64(POINTER_LAST.TILT_Y, true),
      twist: view.getFloat64(POINTER_LAST.TWIST, true), width: view.getFloat64(POINTER_LAST.WIDTH, true),
      height: view.getFloat64(POINTER_LAST.HEIGHT, true), tangentialPressure: view.getFloat64(POINTER_LAST.TANGENTIAL_PRESSURE, true),
    });
    fields.pointerType = pointerTypeName(type);
  }
  return createEvent(eventName(code), fields);
}

// `document` is the backend's document: its editing platform is the
// controller's from the start, so its text control selections have the
// platform's selection direction before any input. `doubleClickInterval`
// is the host's double-click interval in milliseconds.
export function createInputController(layoutOptions, editingPlatform, document, doubleClickInterval) {
  if (!Object.hasOwn(EDITING_PLATFORMS, editingPlatform)) {
    throw new RangeError(
      `editingPlatform must be "mac", "windows" or "linux", got ${JSON.stringify(editingPlatform)}`,
    );
  }
  const platform = EDITING_PLATFORMS[editingPlatform];
  document._domCore.status("input_document_platform_set", document._coreHandle, platform);
  const states = new WeakMap();
  function stateFor(node) {
    const owner = node.nodeType === 9 ? node : node.ownerDocument;
    let state = states.get(owner);
    if (!state) {
      const core = owner._domCore;
      state = { core, handle: core.status("input_state_create", owner._coreHandle, platform), root: node };
      core.status("input_state_click_interval_set", state.handle, doubleClickInterval);
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
    state.core.status("input_state_bind", state.handle, root._renderSurface?._scrollOwner ?? 0n, documentOf(root).getSelection()._handle);
  }
  // Executes run `run` over `records` (core/dom/input-run.watpart): the
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
    const menuCommands = [];
    const eyedropperRequests = [];
    const clipboardReads = [];
    executeInputRun(core, run, {
      batchEvent(notification) {
        const index = notification.record;
        let target;
        if (notification.aux & INPUT_AUX_VIEWPORT_TARGET) {
          viewportResults.add(index);
          target = root._renderSurface?.viewport;
        } else {
          target = core.wrapperFor(notification.target);
        }
        // The clipboard event of a clipboard key takes a DataTransfer of
        // its own, as the host's clipboard commands give theirs.
        const record = records[index];
        if (record.clipboardData === undefined && (core.exports.input_event_fields(notification.code, notification.aux) & EVENT_FIELD.CLIPBOARD)) {
          record.clipboardData = new SDDataTransfer();
        }
        const event = eventFor(core, run, notification, record, core.wrapperFor(notification.related));
        dispatchSandomEvent(target, event);
        return event.defaultPrevented ? INPUT_OUTCOME.CANCELED : INPUT_OUTCOME.DONE;
      },
      valueEdited(notification) {
        if (notification.c) valueChanged = true;
      },
      scrolled(notification) {
        const action = notification.aux;
        if (notification.target === 0n && action !== INPUT.ACTION_SCROLL_INTERACTION_END) viewportResults.add(notification.record);
        if (action === INPUT.ACTION_SCROLL_CHAIN) scrolled = Boolean(notification.a) || scrolled;
        if (action === INPUT.ACTION_SCROLLBAR) scrollbarChanged = true;
        root._renderSurface?._inputScrolled(action, Boolean(notification.a));
      },
      // The copied text of a copy or cut. A clipboard key's goes to the
      // document's host clipboard (backend.setContextMenu's `clipboard`).
      clipboard(notification) {
        const record = records[notification.record];
        copiedText = clipboardText(core, notification, record);
        if (record.kind === "key-down" && copiedText !== null) documentOf(root)._contextMenuClipboard?.write(copiedText);
      },
      // The paste key asks the host to read its clipboard (input run host
      // effect 13); the answer pastes after this run.
      clipboardRead(notification) {
        clipboardReads.push({ operation: notification.a, target: core.wrapperFor(notification.target) });
      },
      fieldMenu(notification) {
        menuCommands.push(fieldMenuCommand(core, notification));
      },
      eyedropper(notification) {
        eyedropperRequests.push(eyedropperRequest(core, notification));
      },
      // A followed hyperlink (input run host effect 10, which the run
      // executor follows): the input's host receives the link and its URL
      // (`hooks.hyperlink(link, url)`).
      hyperlink(link, url) {
        hooks.hyperlink?.(link, url);
      },
      // A changed cursor (input run host effect 11) shows at the surface's
      // cursor target.
      cursor(notification) {
        root._renderSurface?._applyCursor(effectText(core, notification));
      },
      recordHook(notification) {
        const index = notification.record;
        const record = records[index];
        const target = core.wrapperFor(notification.target);
        if (notification.code === INPUT.ACTION_RECORD_START) {
          scrolled = false;
          hooks.beforeRecord?.(record, index);
        } else if (notification.code === INPUT.ACTION_RECORD_END) {
          const result = record.kind === "pointer-leave"
            ? null
            : target ?? (viewportResults.has(index) ? root._renderSurface?.viewport : null);
          results[index] = result;
          hooks.afterRecord?.(record, index, result, scrolled);
        } else if (notification.code === INPUT.ACTION_POINTER_TARGET) {
          target._pointerController = pointerController;
          target._layoutOptions = layoutOptions;
        } else {
          throw new Error(`Unknown native input record hook ${notification.code}`);
        }
      },
    });
    // A context menu's chosen command is a host edit of its own, after the
    // run that chose it ends (src/dom/field-menu.js).
    for (const command of menuCommands) runFieldMenuCommand(runtime, root, command);
    // So is the colour an eyedropper takes (src/dom/eyedropper.js).
    for (const request of eyedropperRequests) runEyedropper(runtime, root, request);
    releaseEyedropperCapture(core, documentOf(root));
    for (const read of clipboardReads) readClipboard(state, root, read);
    return { results, scrollbarChanged, valueChanged, copiedText };
  }
  // Reads the document's host clipboard for clipboard read `operation` of
  // the paste key at `target`: `clipboard.read(request)` answers once, at
  // any later time, with `request.reply(text)` or `request.refuse()`;
  // without a clipboard the read is refused. The core pastes a reply at the
  // target (input_run_clipboard_answer).
  function readClipboard(state, root, { operation, target }) {
    const clipboard = documentOf(root)._contextMenuClipboard;
    let answered = false;
    const answer = (text) => {
      if (answered) throw new Error("paste key: the clipboard already answered");
      answered = true;
      bind(state, root);
      const run = state.core.status("input_run_clipboard_answer", state.handle, operation,
        text === null ? CLIPBOARD.READ_REFUSE : CLIPBOARD.READ_REPLY, ...state.core.input(text ?? ""));
      if (run === 0n) return;
      const clipboardData = new SDDataTransfer();
      clipboardData.setData("text/plain", text);
      runOwned(state, root, run, [{ kind: "clipboard", text, clipboardData }]);
    };
    if (!clipboard) {
      answer(null);
      return;
    }
    clipboard.read(Object.freeze({
      target,
      reply(text) {
        if (typeof text !== "string") throw new TypeError(`paste key: the clipboard text is ${typeof text}; expected a string`);
        answer(text);
      },
      refuse() {
        answer(null);
      },
    }));
  }
  // A run over a batch that `begin` makes, with the root's binding.
  function adopt(state, root, begin) {
    bind(state, root);
    return state.core.status("input_run_adopt", begin());
  }
  function dispatchBatch(root, records, hooks = {}) {
    records.forEach((record, index) => {
      const method = METHOD_INPUT_KINDS[record.kind];
      if (method === undefined) return;
      throw new TypeError(
        `Input record ${index} is a ${record.kind} record, which an input batch does not carry: ` +
          `deliver it through the backend's ${method}, or dispatchInteraction (src/dom/document-operations.js).`,
      );
    });
    // A pointer on a page of a paged surface that the frame does not show
    // (a selection dragged past the page's edge): the batch runs against
    // the paged geometry of the pages its points are on, as the geometry
    // getters answer them (src/dom/page-stack.js).
    const surface = root._renderSurface;
    const shown = surface?.page ?? null;
    if (shown !== null && hooks.snapshot === undefined) {
      const pages = new Set();
      for (const record of records) {
        if (typeof record.x === "number" && typeof record.y === "number") pages.add(surface.pagePoint(record.x, record.y).page);
      }
      if ([...pages].some((page) => page !== shown.index) && surface.presentedFrame !== null) {
        return withPresentedPageGeometry(root, layoutOptions, [...pages], (snapshot) =>
          dispatchBatch(root, records, { ...hooks, snapshot }));
      }
    }
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
    // A run carries the document's local date and time: an empty part of a
    // date or time input that an arrow steps takes it, and a picker that
    // the run opens shows today and now (core/dom/input-date-fields.watpart,
    // core/dom/date-picker.watpart). A document whose clock no read has
    // fixed takes its surface's time without fixing it, so input alone
    // leaves the document free to run on another surface's clock.
    const rootDocument = documentOf(root);
    state.core.exports.input_local_now_set(
      localNow(rootDocument, rootDocument._clock ?? root._renderSurface?._clockForDocument()),
    );
    const run = state.core.status("input_run_begin", state.handle, snapshot?.geometryHandle ?? 0n, pointer, length, records.length, touchPanning);
    const results = runOwned(state, root, run, records, hooks).results;
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
          const index = snapshot.geometryCore.status("geometry_scrollbar_thumb_hit", snapshot.geometryHandle, record.x, record.y);
          pressed = index < 0 ? null : snapshot.scrollbars[index];
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
      const run = adopt(state, state.root, () => state.core.status("input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, false));
      runOwned(state, state.root, run, [{ kind: "pointer-capture", pointerId }]);
    },
    release(element, pointerId) {
      const state = stateFor(element);
      const run = adopt(state, state.root, () => state.core.status("input_pointer_capture_begin", state.handle, element._coreHandle, pointerId, true));
      runOwned(state, state.root, run, [{ kind: "pointer-release", pointerId }]);
    },
    has(element, pointerId) {
      const state = stateFor(element);
      return state.core.status("input_pointer_has_capture", state.handle, element._coreHandle, pointerId) !== 0;
    },
  };
  function one(root, record) { return dispatchBatch(root, [record])[0]; }
  // Host editing commands: 1 text edit (code = input type), 2 select all,
  // 3 clipboard (code 1 copy, 2 cut, 3 paste), 4 a command of execCommand
  // (code = editing_command_code). The engine owns every default; see
  // $inputEditPrepare.
  // `text` is a string, or the bytes of a file chooser's answer
  // (src/dom/file-list.js encodeFileNames).
  function edit(root, operation, target, command, code, text, record) {
    if (typeof text !== "string" && !(text instanceof Uint8Array)) {
      throw new TypeError(`${operation}: text must be a string or a Uint8Array, received ${typeof text}`);
    }
    if (typeof target?._coreHandle !== "bigint") throw new TypeError(`${operation}: target must be a Sandom node, received ${String(target)}`);
    const state = stateFor(root);
    state.root = root;
    bind(state, root);
    const input = typeof text === "string" ? state.core.input(text) : state.core.byteInput(text);
    const run = state.core.status("input_run_edit_begin", state.handle, target._coreHandle, root._coreHandle, command, code, ...input);
    return runOwned(state, root, run, [record]);
  }
  const runtime = {
    pointerController,
    dispatchInputRecords: dispatchBatch,
    resolveCursor(root, x, y) {
      const snapshot = snapshotFor(root);
      return snapshot.geometryCore.string("input_pointer_cursor", snapshot.geometryHandle, x, y);
    },
    systemFocus(root, focused) {
      setSystemFocus(root.ownerDocument ?? root, focused === true);
    },
    // The host's autofill (src/dom/autofill.js).
    autofillFields(root, control = null) {
      return autofillFields(root, control);
    },
    autofill(root, control, values) {
      autofill(root, control, values);
    },
    autofillSuggestions(root, control, available) {
      autofillSuggestions(root, control, available);
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
    pointerDown(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, buttons = 1, pressure = 0.5, tiltX = 0, tiltY = 0, twist = 0, width, height, tangentialPressure = 0, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-down", x, y, pointerId, pointerType, isPrimary, button, buttons, pressure, tiltX, tiltY, twist, width, height, tangentialPressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerMove(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, buttons = 1, pressure = 0.5, tiltX = 0, tiltY = 0, twist = 0, width, height, tangentialPressure = 0, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-move", x, y, pointerId, pointerType, isPrimary, button: -1, buttons, pressure, tiltX, tiltY, twist, width, height, tangentialPressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerUp(root, x, y, { pointerId = 1, pointerType = "touch", isPrimary = true, button = 0, pressure = 0, tiltX = 0, tiltY = 0, twist = 0, width, height, tangentialPressure = 0, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false, timeMilliseconds } = {}) {
      return one(root, { kind: "pointer-up", x, y, pointerId, pointerType, isPrimary, button, buttons: 0, pressure, tiltX, tiltY, twist, width, height, tangentialPressure, shiftKey, altKey, ctrlKey, metaKey, timeMilliseconds });
    },
    pointerCancel(root, pointerId = 1) { return one(root, { kind: "pointer-cancel", pointerId }); },
    pointerLeave(root, pointerId = 1) { return one(root, { kind: "pointer-leave", pointerId }); },
    scrollbarKeydown(root, element, orientation, key) {
      const state = stateFor(root);
      const snapshot = snapshotFor(root);
      const code = state.core.status("input_key_code", ...state.core.input(key));
      const run = adopt(state, root, () => state.core.status("input_pointer_scrollbar_key_begin", state.handle, snapshot.geometryHandle,
        element?._coreHandle ?? 0n, orientation === "vertical", code));
      return runOwned(state, root, run, [{ kind: "scrollbar-key", key }]).scrollbarChanged;
    },
    // The held spin half of a number field (core/dom/input-number.watpart):
    // the milliseconds until its next step at `now`, 0 when it is due, or
    // -1 when no half is held or the pointer is off it.
    spinRepeatDelay(root, now) {
      const state = states.get(root.nodeType === 9 ? root : root.ownerDocument);
      if (!state) return -1;
      return state.core.status("input_spin_repeat_delay", state.handle, now);
    },
    // Steps the held spin half once when its step is due at `now`, with its
    // input and change events. Returns whether it stepped.
    spinRepeat(root, now) {
      const state = states.get(root.nodeType === 9 ? root : root.ownerDocument);
      if (!state || state.core.status("input_spin_repeat_delay", state.handle, now) !== 0) return false;
      state.root = root;
      const run = adopt(state, root, () => state.core.status("input_spin_repeat_begin", state.handle, now));
      runOwned(state, root, run, [{ kind: "spin-repeat" }]);
      return true;
    },
    insertText(root, text, { inputType = "insertText", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("insertText", inputType, INPUT_TYPES_INSERT_TEXT);
      return edit(root, "insertText", target, EDIT.TEXT, code, text, { kind: "text-edit", text }).valueChanged;
    },
    deleteSelection(root, { inputType = "deleteContentBackward", target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const code = inputTypeCode("deleteSelection", inputType, INPUT_TYPES_DELETE_SELECTION);
      return edit(root, "deleteSelection", target, EDIT.TEXT, code, "", { kind: "text-edit", text: "" }).valueChanged;
    },
    selectAll(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      edit(root, "selectAll", target, EDIT.SELECT_ALL, 0, "", { kind: "select-all" });
    },
    // Undo, or redo with `redo`, of the document's editing history, as the
    // keys run it.
    history(root, redo, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      edit(root, redo ? "redo" : "undo", target, EDIT.HISTORY, redo ? 1 : 0, "", { kind: "text-edit", text: "" });
    },
    // A command of Document.execCommand (src/dom/editing-commands.js): the
    // core decides what it changes and fires its input event. copy and cut
    // (`clipboard`) take the DataTransfer of their clipboard event.
    command(root, code, value, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root, clipboard = false } = {}) {
      edit(root, "execCommand", target, EDIT.COMMAND, code, value, { kind: "text-edit", text: value, clipboardData: clipboard ? new SDDataTransfer() : null });
    },
    copy(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "copy", target, EDIT.CLIPBOARD, EDIT.COPY, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    cut(root, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      return edit(root, "cut", target, EDIT.CLIPBOARD, EDIT.CUT, "", { kind: "clipboard", clipboardData: new SDDataTransfer() }).copiedText;
    },
    paste(root, text, { target = root.ownerDocument?._focusedElement ?? root.ownerDocument?.activeElement ?? root } = {}) {
      const clipboardData = new SDDataTransfer();
      if (typeof text === "string") clipboardData.setData("text/plain", text);
      return edit(root, "paste", target, EDIT.CLIPBOARD, EDIT.PASTE, text, { kind: "clipboard", text, clipboardData }).valueChanged;
    },
    // The host picker's answer for input `target`: `code` 1 a reply with
    // `value` (a string, or a file chooser's encoded names), 2 a cancel
    // (src/dom/host-picker.js).
    pickerAnswer(root, target, code, value) {
      return edit(root, "picker answer", target, EDIT.PICKER, code, value, { kind: "picker-answer", value }).valueChanged;
    },
  };
  return { ...runtime, ...createInputBindings(runtime) };
}
