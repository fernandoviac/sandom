// A Sandom document shown on a host surface: a flat canvas, a mesh in a
// three.js or VGPU scene, a quad under a custom shader, a screen inside a
// device model. Two halves, independent of the 3D library in use:
//
// - createTexturePresenter: the `presentFrame` for createRenderSurface when
//   the scene samples Sandom's GPU texture directly. Verifies the frame was
//   rendered on the scene's GPUDevice and hands the texture over once per
//   identity, so the scene rebuilds its texture view only when Sandom
//   reallocates.
// - bindProjectedInput: the ONE host-input binding for every interactive
//   Sandom surface. Pointer, hover, capture, cursor, wheel, keyboard, text
//   composition (IME), virtual-keyboard text, clipboard, focus and
//   multi-document routing all live here. A page supplies a projection from
//   host event to document point and, optionally, its inverse, which lets
//   the input sink follow the caret. Contract:
//   docs/specifications/host-input-binding.md.
//
// The document's UV convention is v = 0 at the top edge, which is what a
// GPU texture sampled with flipY = true gives a three.js PlaneGeometry.

import { sharedDomCore } from "../dom-wasm/core.js";
import { caretRectangle } from "./geometry.js";

// `onTexture(texture, frame)` runs once for each new GPU texture: `texture`
// is the frame's GPUTexture and `frame` the frame that brought it, both
// never null. A frame without a GPU texture, or rendered on another device,
// throws instead.
export function createTexturePresenter({ device, onTexture }) {
  if (!device || typeof device.createShaderModule !== "function") {
    throw new TypeError("createTexturePresenter: device must be a GPUDevice");
  }
  if (typeof onTexture !== "function") {
    throw new TypeError("createTexturePresenter: onTexture must be a function");
  }
  let current = null;
  let frames = 0;
  const presentFrame = (frame) => {
    const texture = frame.textureImage?.texture;
    if (!texture) {
      throw new Error("Sandom did not deliver a GPU texture");
    }
    if (frame.device !== device) {
      throw new Error("Sandom rendered on a different GPU device than the scene");
    }
    frames++;
    if (texture === current) return;
    current = texture;
    onTexture(texture, frame);
  };
  return Object.freeze({
    presentFrame,
    get texture() {
      return current;
    },
    get frames() {
      return frames;
    },
  });
}

// The content box of `element` in CSS pixels, before CSS transforms: the
// document's viewport. A transform scales the box on screen, and the
// projection maps the transformed box onto this size. `caller` names the API
// in the error for an element without a size.
export function layoutBoxSize(element, caller) {
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`${caller}: the canvas's layout box is ${style.width} x ${style.height}; give it a size in the page`);
  }
  return { width, height };
}

// The projection for a flat host: the document fills `host`'s client box,
// scaled to `width` x `height` document CSS pixels. A point outside the box
// misses. Its `unproject` is the inverse, for the `unproject` argument of
// bindProjectedInput: a document point as a client point, or null outside
// the document.
export function projectOntoRectangle(host, { width, height }) {
  sharedDomCore.statusRaw("input_projection_check", ...sharedDomCore.valueListInput([
    Number(width), Number(height), String(width), String(height),
  ]));
  const exports = sharedDomCore.exports;
  const projected = (direction, x, y) => {
    const bounds = host.getBoundingClientRect();
    if (exports.input_project(direction, bounds.left, bounds.top, bounds.width, bounds.height, x, y, width, height) === 0) return null;
    return { x: exports.input_projected(false), y: exports.input_projected(true) };
  };
  const project = (event) => projected(false, event.clientX, event.clientY);
  project.unproject = ({ x, y }) => projected(true, x, y);
  return project;
}

const modifierOptions = (event) => ({
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
});

const pointerOptions = (event) => ({
  ...modifierOptions(event),
  button: event.button,
  buttons: event.buttons,
  pointerId: event.pointerId,
  pointerType: event.pointerType || "mouse",
  isPrimary: event.isPrimary,
  pressure: event.pressure,
  timeMilliseconds: event.timeStamp,
});

const keyOptions = (event) => ({
  ...modifierOptions(event),
  code: event.code,
  location: event.location,
  repeat: event.repeat,
});

// The key routes of input_key_route and the beforeinput actions of
// input_before_input: the command chords, clipboard chords, composition
// keys and beforeinput types are tables of core/dom/input-projection.watpart.
const KEY_DROP = 0;
const KEY_DELIVER_PREVENTING_DEFAULT = 2;
const BEFORE_INPUT_INSERT = 1;
const BEFORE_INPUT_KEYS = [undefined, undefined, "Backspace", "Delete", "Enter"];

const documentOf = (root) => root.nodeType === 9 ? root : root.ownerDocument;

// Whether an element takes a text composition (input_text_control).
function isTextControl(element) {
  return sharedDomCore.status("input_text_control", ...sharedDomCore.valueListInput([
    element ? 1 : 0,
    element?.disabled ? 1 : 0,
    element?.readOnly ? 1 : 0,
    element ? String(element.localName) : "",
    element ? String(element.type ?? "") : "",
  ])) === 1;
}

// The document side of an input binding: everything the page side needs
// from one document. bindProjectedInput serves a document of this realm
// through this port; src/dom/worker-input.js serves a document of a worker
// through one with the same operations.
//   deliver(method, ...arguments_)  an input record, as backend[method](root, ...arguments_)
//   setPreferences(preferences)     the host's colour scheme, motion and forced colours
//   cursorAt(x, y)                  the cursor at a document point, or null
//   copy(), cut()                   the selected text for the clipboard, or null
//   textControlFocused()            whether the focused element takes a composition
//   caret()                         null without a focused text control, else
//                                   { control, point }: point is the caret in
//                                   document CSS pixels, or null where the
//                                   presented frame does not draw it
//   onFrame(callback)               callback after each presented frame; returns the stop function
//   dispatchInputRecords(records, hooks)
export function localDocumentPort(backend, root) {
  return Object.freeze({
    deliver: (method, ...arguments_) => backend[method](root, ...arguments_),
    setPreferences: (preferences) => backend.setPreferences(preferences),
    cursorAt: (x, y) => backend.resolveCursor(root, x, y),
    copy: () => backend.copy(root),
    cut: () => backend.cut(root),
    textControlFocused: () => isTextControl(documentOf(root).activeElement),
    caret() {
      const control = documentOf(root).activeElement;
      if (!isTextControl(control)) return null;
      const frame = root._renderSurface?.presentedFrame ?? null;
      if (frame === null) return { control, point: null };
      const offset = control._domCore.status("input_control_caret_offset", control._coreHandle);
      const deviceScale = frame.viewport.deviceScale;
      const caret = caretRectangle(frame, control, offset, { deviceScale });
      return { control, point: caret === null ? null : { x: caret.x / deviceScale, y: caret.y / deviceScale } };
    },
    onFrame: (callback) => root._renderSurface?.onFrame(callback) ?? null,
    dispatchInputRecords: (records, hooks) => backend.dispatchInputRecords(root, records, hooks),
  });
}

// A visually hidden textarea is the keyboard's real focus while a document
// owns the keyboard. A canvas cannot receive text composition, virtual
// keyboard text, or clipboard events; a focused textarea receives all of
// them. The sink is never where the text lands: every event it receives is
// forwarded to the document and its own value is cleared.
function createInputSink(host, label) {
  const sink = host.ownerDocument.createElement("textarea");
  sink.setAttribute("aria-label", label);
  sink.setAttribute("autocomplete", "off");
  sink.setAttribute("autocorrect", "off");
  sink.setAttribute("autocapitalize", "off");
  sink.setAttribute("spellcheck", "false");
  sink.dataset.sandomInputSink = "";
  Object.assign(sink.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    margin: "0",
    opacity: "0",
    resize: "none",
    overflow: "hidden",
    whiteSpace: "pre",
    caretColor: "transparent",
    pointerEvents: "none",
    // 16px keeps mobile browsers from zooming the page on focus.
    fontSize: "16px",
  });
  host.after(sink);
  return sink;
}

// Each hook, and each value the binding passes to it:
//
// `project(event, { target })` returns `{ x, y }` in document CSS pixels, or
// null when the event misses every document. It may add `backend` and
// `root` to route the point to another document than the default. `event`
// is never null: a `pointerdown`, `pointermove`, `pointerup`,
// `pointercancel` or `wheel` event, or the last `pointermove` again when a
// presented frame resolves the cursor of a resting pointer. `target` is
// null except during a pressed gesture, where it is the `{ backend, root }`
// the press started on, so a drag can keep tracking past that document's
// edge.
//
// `unproject(point, target)` is the inverse: `point` (never null) is a point
// of `target`'s document in document CSS pixels, and `target` (never null)
// is the `{ backend, root }` that has the keyboard. It returns the point as
// `{ x, y }` in host client coordinates, or null where that point is not
// visible. With it the input sink sits at the caret of the focused text
// control, so the browser opens its composition window where the reader is
// typing; without it the sink sits at the host's top left corner.
//
// `claimPointerDown(point, event)`, `claimWheel(point, event)` and
// `claimKey(event)` keep a press, a wheel turn or a key for the host (a
// click that orbits the camera, a wheel that zooms it, an Escape that
// returns the keyboard); return true to claim. A claimed press or a miss
// hands the keyboard back to the host element. `claimPointerDown` receives
// the `pointerdown` event and the point that `project` returned, null on a
// miss. `claimWheel` receives the `wheel` event and a point that is never
// null: a wheel over a miss stays with the host without a call.
// `claimKey` receives the sink's `keydown` or `keyup` event, never null.
//
// `cursor(point, event)` may return a cursor name to show instead of the
// document's own. `point` is the point that `project` returned, or null on
// a miss. `event` is the `pointerdown`, `pointermove`, `pointerup` or
// `pointercancel` event, or the last `pointermove` again when a presented
// frame resolves the cursor of a resting pointer. When the pointer leaves
// the host, both `point` and `event` are null.
//
// `onInput()` runs, without arguments, after every record the binding
// delivers.
//
// `browserContextMenu: false` keeps the browser's own context menu off the
// host and the input sink, for a document whose text fields show
// Sandom's context menu (`backend.setContextMenu`, src/dom/field-menu.js).
// The page side of an input binding, for one default target `{ backend,
// root, port }` (a document of another realm has no backend; its port
// carries its records). bindProjectedInput and bindWorkerInput call it.
export function bindDocumentInput({
  host,
  target: defaultTarget,
  project,
  unproject = null,
  claimPointerDown = () => false,
  claimWheel = () => false,
  releaseWheelAtBoundary = false,
  claimKey = () => false,
  cursor = () => null,
  onInput = () => {},
  label = "Sandom document input",
  touchAction = "none",
  browserContextMenu = true,
}) {
  if (typeof host?.addEventListener !== "function") {
    throw new TypeError("bindProjectedInput: host must be an EventTarget");
  }
  if (!host.isConnected) {
    throw new Error(
      "bindProjectedInput: host is not in the document; insert it before binding so the input sink can sit beside it and take focus",
    );
  }
  if (typeof project !== "function") {
    throw new TypeError("bindProjectedInput: project must be a function");
  }
  if (unproject !== null && typeof unproject !== "function") {
    throw new TypeError("bindProjectedInput: unproject must be a function or null");
  }
  const localTargets = new WeakMap();
  const targetOf = (point) => {
    if (point.root === undefined || point.root === defaultTarget.root) return defaultTarget;
    const routedBackend = point.backend ?? defaultTarget.backend;
    if (routedBackend === null) {
      throw new Error("bindDocumentInput: project routed a point to another document, which a worker document's binding cannot reach");
    }
    let target = localTargets.get(point.root);
    if (target === undefined || target.backend !== routedBackend) {
      target = Object.freeze({ backend: routedBackend, root: point.root, port: localDocumentPort(routedBackend, point.root) });
      localTargets.set(point.root, target);
    }
    return target;
  };
  const sameTarget = (left, right) => left?.root === right?.root;

  if (touchAction !== null) host.style.touchAction = touchAction;
  const sink = createInputSink(host, label);

  let hoverTarget = null;
  let hoverPointer = null;
  let captured = null;
  let claimedPointer = null;
  let keyboardTarget = null;
  let composing = false;
  // A claimed keydown's text must not reach the document through the
  // sink's beforeinput: the host owns that key.
  let claimedKeyDown = false;
  // The document with system focus: the keyboard target while the sink has
  // browser focus, else none. A field that loses it commits its edit and
  // stops matching :focus, as a page does when its window loses focus.
  let systemFocusTarget = null;
  const giveSystemFocus = (target) => {
    if (sameTarget(systemFocusTarget, target)) return;
    const previous = systemFocusTarget;
    systemFocusTarget = target;
    previous?.port.deliver("systemFocus", false);
    target?.port.deliver("systemFocus", true);
    delivered();
  };
  // The document starts without system focus until the sink takes focus.
  defaultTarget.port.deliver("systemFocus", false);
  // The text control whose caret the sink sits at, or null while the sink
  // sits at the host's corner.
  let sinkCaretControl = null;
  // The render surface whose presented frames move the sink with the
  // caret, and the call that stops listening to it.
  let caretPort = null;
  let stopCaretFrames = null;

  const placeSinkAtHostCorner = () => {
    sinkCaretControl = null;
    const bounds = host.getBoundingClientRect();
    sink.style.left = `${Math.max(0, bounds.left)}px`;
    sink.style.top = `${Math.max(0, bounds.top)}px`;
  };

  // Composition windows open next to the focused editable, so the sink sits
  // at the caret of the document's focused text control, where the
  // presented frame draws it. A frame that has not drawn that caret yet (a
  // key just moved it) leaves the sink at the control's previous caret until
  // the next frame. Without `unproject`, without a focused text control, or
  // with the caret out of view, the sink sits at the host's corner.
  const placeSink = () => {
    const target = unproject === null ? null : compositionTarget();
    if (target === null) {
      placeSinkAtHostCorner();
      return;
    }
    const caret = target.port.caret();
    const control = caret?.control ?? null;
    if (caret === null || caret.point === null) {
      if (sinkCaretControl !== control) placeSinkAtHostCorner();
      return;
    }
    const point = unproject(caret.point, target);
    if (point === null) {
      placeSinkAtHostCorner();
      return;
    }
    sinkCaretControl = control;
    sink.style.left = `${point.x}px`;
    sink.style.top = `${point.y}px`;
  };

  // While the sink has the browser's focus, every frame the keyboard's
  // document presents can move or scroll its caret; the sink follows.
  const followCaretFrames = (focused = sink.getRootNode().activeElement === sink) => {
    const port = unproject !== null && keyboardTarget !== null && focused
      ? keyboardTarget.port
      : null;
    if (port === caretPort) return;
    stopCaretFrames?.();
    caretPort = port;
    stopCaretFrames = port?.onFrame(placeSink) ?? null;
  };

  // Any record can move or scroll the caret; a sink without `unproject`
  // stays at the host's corner, where focus put it.
  const delivered = () => {
    if (unproject !== null && keyboardTarget !== null) placeSink();
    onInput();
  };

  const applyCursor = (point, event, target) => {
    host.style.cursor = cursor(point, event) ??
      (point === null
        ? "default"
        : target.port.cursorAt(point.x, point.y) ??
          "default");
  };

  // Content moves under a resting pointer: a scroll, a layout change, an
  // animation. Hit testing reads the presented frame, so the cursor the last
  // pointer record chose describes the frame before. Every frame the hovered
  // document presents, the host's cursor is resolved again at the last
  // pointer position, as a browser updates its cursor after a scroll.
  let hoverEvent = null;
  let hoverPort = null;
  let stopHoverFrames = null;
  const resolveRestingCursor = () => {
    if (hoverTarget === null || hoverEvent === null || captured !== null || claimedPointer !== null) return;
    const point = project(hoverEvent, { target: null });
    // A pointer that no longer lies on the hovered document waits for its
    // next record, which ends the hover.
    if (point === null || !sameTarget(targetOf(point), hoverTarget)) return;
    applyCursor(point, hoverEvent, hoverTarget);
  };
  const followHoverFrames = () => {
    const port = hoverTarget?.port ?? null;
    if (port === hoverPort) return;
    stopHoverFrames?.();
    hoverPort = port;
    stopHoverFrames = port?.onFrame(resolveRestingCursor) ?? null;
  };

  const leaveHover = () => {
    if (hoverTarget === null) return;
    const previous = hoverTarget;
    hoverTarget = null;
    hoverEvent = null;
    followHoverFrames();
    previous.port.deliver("pointerLeave", hoverPointer ?? 1);
    delivered();
  };

  const focusSink = (target) => {
    keyboardTarget = target;
    placeSink();
    if (sink.getRootNode().activeElement !== sink) {
      sink.focus({ preventScroll: true });
    } else {
      giveSystemFocus(target);
    }
    followCaretFrames();
  };

  // A host with its own keys (a camera) is focusable and takes the keyboard
  // back; a host without keys is not a tab stop, so the sink just lets go.
  const releaseKeyboard = () => {
    keyboardTarget = null;
    followCaretFrames();
    if (sink.getRootNode().activeElement !== sink) return;
    if (host.tabIndex >= 0) host.focus({ preventScroll: true });
    else sink.blur();
  };

  // A claimed or missed pointer is the host's gesture from press to
  // release. The host sees the press through `claimPointerDown` (with a
  // null point on a miss), and its cursor comes from the `cursor` hook
  // after the host has updated its own state.
  const applyHostCursor = (event) => {
    const point = project(event, { target: null });
    host.style.cursor = cursor(point, event) ?? "default";
  };

  const onPointerDown = (event) => {
    const point = project(event, { target: null });
    const claimed = claimPointerDown(point, event);
    if (point === null || claimed) {
      claimedPointer = event.pointerId;
      releaseKeyboard();
      applyHostCursor(event);
      return;
    }
    const target = targetOf(point);
    // The press owns focus: without this the host element would take focus
    // after this handler and pull the keyboard away from the sink.
    event.preventDefault();
    captured = { pointerId: event.pointerId, target };
    host.setPointerCapture?.(event.pointerId);
    focusSink(target);
    target.port.deliver("pointerDown", point.x, point.y, pointerOptions(event));
    applyCursor(point, event, target);
    delivered();
  };

  const onPointerMove = (event) => {
    if (event.pointerId === claimedPointer) {
      applyHostCursor(event);
      return;
    }
    if (captured?.pointerId === event.pointerId) {
      const point = project(event, { target: captured.target });
      if (point === null) return;
      // The resting cursor resolves at the pointer's last place, so a
      // release away from the press place shows the cursor there.
      hoverEvent = event;
      captured.target.port.deliver("pointerMove", point.x, point.y, pointerOptions(event));
      applyCursor(point, event, captured.target);
      delivered();
      return;
    }
    const point = project(event, { target: null });
    const target = point === null ? null : targetOf(point);
    if (hoverTarget !== null && !sameTarget(hoverTarget, target)) leaveHover();
    if (point === null) {
      applyCursor(null, event, null);
      return;
    }
    hoverTarget = target;
    hoverPointer = event.pointerId;
    hoverEvent = event;
    followHoverFrames();
    target.port.deliver("pointerMove", point.x, point.y, pointerOptions(event));
    applyCursor(point, event, target);
    delivered();
  };

  const release = (event) => {
    if (event.pointerId === claimedPointer) {
      claimedPointer = null;
      applyHostCursor(event);
      return null;
    }
    if (captured?.pointerId !== event.pointerId) return null;
    const { target } = captured;
    captured = null;
    if (host.hasPointerCapture?.(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
    return target;
  };

  const onPointerUp = (event) => {
    const target = release(event);
    if (target === null) return;
    const point = project(event, { target }) ?? { x: -1, y: -1 };
    target.port.deliver("pointerUp", point.x, point.y, pointerOptions(event));
    if (point.x >= 0) applyCursor(point, event, target);
    delivered();
  };

  const onPointerCancel = (event) => {
    const target = release(event);
    if (target === null) return;
    target.port.deliver("pointerCancel", event.pointerId);
    delivered();
  };

  const cancelGestures = () => {
    claimedPointer = null;
    if (captured !== null) {
      const { pointerId } = captured;
      const target = release({ pointerId });
      target.port.deliver("pointerCancel", pointerId);
      delivered();
    }
    leaveHover();
    applyCursor(null, null, null);
  };

  const onPointerLeave = () => {
    if (captured !== null) return;
    leaveHover();
    applyCursor(null, null, null);
  };

  const onWheel = (event) => {
    const point = project(event, { target: null });
    if (point === null || claimWheel(point, event)) return;
    const target = targetOf(point);
    if (releaseWheelAtBoundary) {
      let scrolled = false;
      target.port.dispatchInputRecords([{
        kind: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ...modifierOptions(event),
      }], {
        afterRecord(_record, _index, _target, changed) {
          scrolled = changed;
        },
      });
      if (scrolled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    } else {
      event.preventDefault();
      target.port.deliver(
        "wheel",
        point.x,
        point.y,
        event.deltaX,
        event.deltaY,
        event.deltaMode,
        modifierOptions(event),
      );
    }
    delivered();
  };

  // Keyboard users reach the document by tabbing onto the sink.
  const onSinkFocus = () => {
    claimedKeyDown = false;
    keyboardTarget ??= defaultTarget;
    giveSystemFocus(keyboardTarget);
    sink.value = "";
    placeSink();
    followCaretFrames(true);
  };

  const onSinkBlur = () => {
    giveSystemFocus(null);
    claimedKeyDown = false;
    composing = false;
    sink.value = "";
    followCaretFrames(false);
  };

  const forwardKey = (event, direction) => {
    const target = keyboardTarget;
    if (target === null) return;
    if (claimKey(event)) {
      if (direction === "keydown") claimedKeyDown = true;
      return;
    }
    if (direction === "keydown") claimedKeyDown = false;
    const route = sharedDomCore.status("input_key_route", ...sharedDomCore.valueListInput([
      event.key, composing || event.isComposing ? 1 : 0, event.metaKey ? 1 : 0, event.ctrlKey ? 1 : 0, event.altKey ? 1 : 0,
    ]));
    if (route === KEY_DROP) return;
    // A clipboard chord keeps its browser default so the clipboard event
    // follows on the sink.
    if (route === KEY_DELIVER_PREVENTING_DEFAULT) event.preventDefault();
    target.port.deliver(direction, event.key, keyOptions(event));
    delivered();
  };

  const onKeyDown = (event) => forwardKey(event, "keydown");
  const onKeyUp = (event) => {
    claimedKeyDown = false;
    forwardKey(event, "keyup");
  };

  const compositionTarget = () => {
    const target = keyboardTarget;
    if (target === null) return null;
    return target.port.textControlFocused() ? target : null;
  };

  const onCompositionStart = (event) => {
    const target = compositionTarget();
    // A composition outside a text control has nowhere to land; the sink
    // absorbs it and clears, as a browser does for a composition over a
    // non-editable element.
    if (target === null) return;
    composing = true;
    target.port.deliver("compositionStart", event.data ?? "", modifierOptions(event));
    delivered();
  };

  const onCompositionUpdate = (event) => {
    if (!composing) return;
    keyboardTarget.port.deliver("compositionUpdate", event.data ?? "", modifierOptions(event));
    delivered();
  };

  const onCompositionEnd = (event) => {
    sink.value = "";
    if (!composing) return;
    composing = false;
    keyboardTarget.port.deliver("compositionEnd", event.data ?? "", modifierOptions(event));
    delivered();
  };

  // Text that arrives without a keydown the sink forwarded: virtual
  // keyboards, autocorrect replacements, dictation, the browser's own
  // Edit menu.
  const onBeforeInput = (event) => {
    if (event.isComposing || composing) return;
    event.preventDefault();
    if (claimedKeyDown) return;
    const target = keyboardTarget;
    if (target === null) return;
    const action = sharedDomCore.status("input_before_input", ...sharedDomCore.valueListInput([event.inputType, String(event.inputType)]));
    if (action === BEFORE_INPUT_INSERT) {
      target.port.deliver("insertText", event.data ?? "", { inputType: event.inputType });
      delivered();
      return;
    }
    const key = BEFORE_INPUT_KEYS[action];
    if (key !== undefined) {
      target.port.deliver("keydown", key, {});
      target.port.deliver("keyup", key, {});
      delivered();
    }
  };

  const onCopy = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    const text = target.port.copy();
    if (text !== null) event.clipboardData.setData("text/plain", text);
    delivered();
  };

  const onCut = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    const text = target.port.cut();
    if (text !== null) event.clipboardData.setData("text/plain", text);
    delivered();
  };

  const onPaste = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    target.port.deliver("paste", event.clipboardData.getData("text/plain"));
    delivered();
  };
  const onContextMenu = (event) => {
    if (!browserContextMenu) event.preventDefault();
  };

  const hostListeners = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["contextmenu", onContextMenu],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["lostpointercapture", onPointerCancel],
    ["pointerleave", onPointerLeave],
    ["wheel", onWheel, { passive: false, capture: releaseWheelAtBoundary }],
  ];
  const sinkListeners = [
    ["focus", onSinkFocus],
    ["blur", onSinkBlur],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
    ["compositionstart", onCompositionStart],
    ["compositionupdate", onCompositionUpdate],
    ["compositionend", onCompositionEnd],
    ["beforeinput", onBeforeInput],
    ["copy", onCopy],
    ["cut", onCut],
    ["paste", onPaste],
    ["contextmenu", onContextMenu],
  ];
  const hostWindow = host.ownerDocument.defaultView;
  const windowListeners = [
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["blur", cancelGestures],
  ];
  for (const [type, listener] of windowListeners) {
    hostWindow?.addEventListener(type, listener);
  }
  for (const [type, listener, options] of hostListeners) {
    host.addEventListener(type, listener, options);
  }
  for (const [type, listener] of sinkListeners) {
    sink.addEventListener(type, listener);
  }
  // The browser's preferences are the document's, as its focus is: the
  // colour scheme, reduced motion and forced colours follow the host
  // window's media queries now and on each change. A host page without
  // matchMedia (no browser window) leaves the document's preferences.
  const preferenceQueries = hostWindow?.matchMedia
    ? {
      dark: hostWindow.matchMedia("(prefers-color-scheme: dark)"),
      reduce: hostWindow.matchMedia("(prefers-reduced-motion: reduce)"),
      forced: hostWindow.matchMedia("(forced-colors: active)"),
    }
    : null;
  const followPreferences = () => {
    const dark = preferenceQueries.dark.matches;
    defaultTarget.port.setPreferences({
      colorScheme: dark ? "dark" : "light",
      reducedMotion: preferenceQueries.reduce.matches ? "reduce" : "no-preference",
      forcedColors: preferenceQueries.forced.matches ? (dark ? "dark" : "light") : "none",
    });
  };
  if (preferenceQueries) {
    followPreferences();
    for (const query of Object.values(preferenceQueries)) query.addEventListener("change", followPreferences);
  }

  return Object.freeze({
    get capturedPointer() {
      return captured?.pointerId ?? null;
    },
    // The document that receives keys, or null while the host keeps them.
    get keyboardTarget() {
      return keyboardTarget;
    },
    // Hands the keyboard to a document (the default one when omitted), as
    // a press on it would.
    focus(target = defaultTarget) {
      focusSink(target);
    },
    // Returns the keyboard to the host element.
    releaseKeyboard,
    dispose() {
      for (const [type, listener, options] of hostListeners) {
        host.removeEventListener(type, listener, options);
      }
      for (const [type, listener] of sinkListeners) {
        sink.removeEventListener(type, listener);
      }
      for (const [type, listener] of windowListeners) {
        hostWindow?.removeEventListener(type, listener);
      }
      if (preferenceQueries) {
        for (const query of Object.values(preferenceQueries)) query.removeEventListener("change", followPreferences);
      }
      cancelGestures();
      sink.remove();
      keyboardTarget = null;
      followCaretFrames(false);
    },
  });
}

// Binds the host element's input to a Sandom document of this realm: see
// the hooks above bindDocumentInput. `backend` is the createSandomDOM result
// that built `root`, the document node or element whose document takes the
// input.
export function bindProjectedInput({ backend, root, ...options }) {
  if (typeof backend?.pointerDown !== "function" || !root) {
    throw new TypeError(
      "bindProjectedInput: backend must be an input backend (createSandomDOM) and root its document node",
    );
  }
  return bindDocumentInput({ ...options, target: Object.freeze({ backend, root, port: localDocumentPort(backend, root) }) });
}
