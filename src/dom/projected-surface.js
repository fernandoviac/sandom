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

// The projection for a flat host: the document fills `host`'s client box,
// scaled to `width` x `height` document CSS pixels. A point outside the box
// misses. Its `unproject` is the inverse, for the `unproject` argument of
// bindProjectedInput: a document point as a client point, or null outside
// the document.
export function projectOntoRectangle(host, { width, height }) {
  if (!(width > 0) || !(height > 0)) {
    throw new TypeError(
      `projectOntoRectangle: width and height must be positive; got ${width} x ${height}`,
    );
  }
  const project = (event) => {
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    const x = (event.clientX - bounds.left) * width / bounds.width;
    const y = (event.clientY - bounds.top) * height / bounds.height;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    return { x, y };
  };
  project.unproject = ({ x, y }) => {
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    return {
      x: bounds.left + x * bounds.width / width,
      y: bounds.top + y * bounds.height / height,
    };
  };
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

// The engine's command-modifier policy: meta, or ctrl without alt. AltGr
// arrives as ctrl+alt and types characters.
const commandModifier = (event) =>
  event.metaKey || (event.ctrlKey && !event.altKey);

// Command chords the document performs itself, or that must not act on the
// hidden input sink (undo, redo). Every other command chord (reload, new
// tab, address bar, developer tools, zoom) stays with the browser; the
// document still receives its keydown.
const DOCUMENT_COMMAND_KEYS = new Set([
  "a", "z", "y", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home",
  "End", "Backspace", "Delete", "Enter", "Tab",
]);

// Copy, cut and paste chords keep their browser default: the browser then
// fires `copy`, `cut` and `paste` on the focused input sink, where the
// clipboard is readable and writable without a permission prompt.
const CLIPBOARD_KEYS = new Set(["c", "x", "v"]);

// Keys that belong to an in-progress text composition or to a virtual
// keyboard: the text arrives through composition or beforeinput instead.
const TEXT_SOURCE_KEYS = new Set(["Process", "Unidentified", "Dead"]);

// beforeinput types a virtual keyboard or the browser's own menus produce
// without a preceding keydown the sink forwarded.
const TEXT_INSERTION_TYPES = new Set([
  "insertText", "insertReplacementText",
]);
const KEY_EQUIVALENT_TYPES = new Map([
  ["deleteContentBackward", "Backspace"],
  ["deleteContentForward", "Delete"],
  ["insertLineBreak", "Enter"],
  ["insertParagraph", "Enter"],
]);

const TEXT_INPUT_TYPES = new Set([
  "", "text", "search", "url", "tel", "email", "password", "number",
]);

const documentOf = (root) => root.nodeType === 9 ? root : root.ownerDocument;

function isTextControl(element) {
  if (!element || element.disabled || element.readOnly) return false;
  if (element.localName === "textarea") return true;
  return element.localName === "input" &&
    TEXT_INPUT_TYPES.has(String(element.type ?? "").toLowerCase());
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
export function bindProjectedInput({
  host,
  backend,
  root,
  project,
  unproject = null,
  claimPointerDown = () => false,
  claimWheel = () => false,
  claimKey = () => false,
  cursor = () => null,
  onInput = () => {},
  label = "Sandom document input",
  touchAction = "none",
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
  if (typeof backend?.pointerDown !== "function" || !root) {
    throw new TypeError(
      "bindProjectedInput: backend must be an input backend (createSandomDOM) and root its document node",
    );
  }
  const defaultTarget = Object.freeze({ backend, root });
  const targetOf = (point) =>
    point.root === undefined || point.root === root
      ? defaultTarget
      : { backend: point.backend ?? backend, root: point.root };
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
  // The text control whose caret the sink sits at, or null while the sink
  // sits at the host's corner.
  let sinkCaretControl = null;
  // The render surface whose presented frames move the sink with the
  // caret, and the call that stops listening to it.
  let caretSurface = null;
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
    const control = documentOf(target.root).activeElement;
    const frame = target.root._renderSurface?.presentedFrame ?? null;
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? start;
    const offset = control.selectionDirection === "backward" ? start : end;
    const deviceScale = frame?.viewport.deviceScale ?? 1;
    const caret = frame === null
      ? null
      : caretRectangle(frame, control, offset, { deviceScale });
    if (caret === null) {
      if (sinkCaretControl !== control) placeSinkAtHostCorner();
      return;
    }
    const point = unproject({ x: caret.x / deviceScale, y: caret.y / deviceScale }, target);
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
    const surface = unproject !== null && keyboardTarget !== null && focused
      ? keyboardTarget.root._renderSurface ?? null
      : null;
    if (surface === caretSurface) return;
    stopCaretFrames?.();
    caretSurface = surface;
    stopCaretFrames = surface?.onFrame(placeSink) ?? null;
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
        : target.backend.resolveCursor(target.root, point.x, point.y) ??
          "default");
  };

  // Content moves under a resting pointer: a scroll, a layout change, an
  // animation. Hit testing reads the presented frame, so the cursor the last
  // pointer record chose describes the frame before. Every frame the hovered
  // document presents, the host's cursor is resolved again at the last
  // pointer position, as a browser updates its cursor after a scroll.
  let hoverEvent = null;
  let hoverSurface = null;
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
    const surface = hoverTarget?.root._renderSurface ?? null;
    if (surface === hoverSurface) return;
    stopHoverFrames?.();
    hoverSurface = surface;
    stopHoverFrames = surface?.onFrame(resolveRestingCursor) ?? null;
  };

  const leaveHover = () => {
    if (hoverTarget === null) return;
    const previous = hoverTarget;
    hoverTarget = null;
    hoverEvent = null;
    followHoverFrames();
    previous.backend.pointerLeave(previous.root, hoverPointer ?? 1);
    delivered();
  };

  const focusSink = (target) => {
    keyboardTarget = target;
    placeSink();
    if (sink.getRootNode().activeElement !== sink) {
      sink.focus({ preventScroll: true });
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
    target.backend.pointerDown(target.root, point.x, point.y, pointerOptions(event));
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
      captured.target.backend.pointerMove(captured.target.root, point.x, point.y, pointerOptions(event));
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
    target.backend.pointerMove(target.root, point.x, point.y, pointerOptions(event));
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
    target.backend.pointerUp(target.root, point.x, point.y, pointerOptions(event));
    if (point.x >= 0) applyCursor(point, event, target);
    delivered();
  };

  const onPointerCancel = (event) => {
    const target = release(event);
    if (target === null) return;
    target.backend.pointerCancel(target.root, event.pointerId);
    delivered();
  };

  const onPointerLeave = () => {
    if (captured !== null) return;
    leaveHover();
    applyCursor(null, null, null);
  };

  const onWheel = (event) => {
    const point = project(event, { target: null });
    if (point === null || claimWheel(point, event)) return;
    event.preventDefault();
    const target = targetOf(point);
    target.backend.wheel(
      target.root,
      point.x,
      point.y,
      event.deltaX,
      event.deltaY,
      event.deltaMode,
      modifierOptions(event),
    );
    delivered();
  };

  // Keyboard users reach the document by tabbing onto the sink.
  const onSinkFocus = () => {
    keyboardTarget ??= defaultTarget;
    sink.value = "";
    placeSink();
    followCaretFrames(true);
  };

  const onSinkBlur = () => {
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
    if (composing || event.isComposing || TEXT_SOURCE_KEYS.has(event.key)) return;
    const command = commandModifier(event);
    if (command && CLIPBOARD_KEYS.has(event.key.toLowerCase())) {
      // Deliver the keydown to the document, keep the browser default so
      // the clipboard event follows on the sink.
      target.backend[direction](target.root, event.key, keyOptions(event));
      delivered();
      return;
    }
    if (!command || DOCUMENT_COMMAND_KEYS.has(event.key) ||
        DOCUMENT_COMMAND_KEYS.has(event.key.toLowerCase())) {
      event.preventDefault();
    }
    target.backend[direction](target.root, event.key, keyOptions(event));
    delivered();
  };

  const onKeyDown = (event) => forwardKey(event, "keydown");
  const onKeyUp = (event) => forwardKey(event, "keyup");

  const compositionTarget = () => {
    const target = keyboardTarget;
    if (target === null) return null;
    const document = documentOf(target.root);
    return isTextControl(document.activeElement) ? target : null;
  };

  const onCompositionStart = (event) => {
    const target = compositionTarget();
    // A composition outside a text control has nowhere to land; the sink
    // absorbs it and clears, as a browser does for a composition over a
    // non-editable element.
    if (target === null) return;
    composing = true;
    target.backend.compositionStart(target.root, event.data ?? "", modifierOptions(event));
    delivered();
  };

  const onCompositionUpdate = (event) => {
    if (!composing) return;
    keyboardTarget.backend.compositionUpdate(keyboardTarget.root, event.data ?? "", modifierOptions(event));
    delivered();
  };

  const onCompositionEnd = (event) => {
    sink.value = "";
    if (!composing) return;
    composing = false;
    keyboardTarget.backend.compositionEnd(keyboardTarget.root, event.data ?? "", modifierOptions(event));
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
    if (TEXT_INSERTION_TYPES.has(event.inputType)) {
      target.backend.insertText(target.root, event.data ?? "", { inputType: event.inputType });
      delivered();
      return;
    }
    const key = KEY_EQUIVALENT_TYPES.get(event.inputType);
    if (key !== undefined) {
      target.backend.keydown(target.root, key, {});
      target.backend.keyup(target.root, key, {});
      delivered();
      return;
    }
    // Paste and cut arrive as clipboard events, which already ran.
    if (event.inputType === "insertFromPaste" || event.inputType === "deleteByCut") return;
    throw new Error(
      `bindProjectedInput: the Sandom document has no action for beforeinput "${event.inputType}"`,
    );
  };

  const onCopy = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    const text = target.backend.copy(target.root);
    if (text !== null) event.clipboardData.setData("text/plain", text);
    delivered();
  };

  const onCut = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    const text = target.backend.cut(target.root);
    if (text !== null) event.clipboardData.setData("text/plain", text);
    delivered();
  };

  const onPaste = (event) => {
    event.preventDefault();
    const target = keyboardTarget;
    if (target === null) return;
    target.backend.paste(target.root, event.clipboardData.getData("text/plain"));
    delivered();
  };

  const hostListeners = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["pointerleave", onPointerLeave],
    ["wheel", onWheel, { passive: false }],
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
  ];
  for (const [type, listener, options] of hostListeners) {
    host.addEventListener(type, listener, options);
  }
  for (const [type, listener] of sinkListeners) {
    sink.addEventListener(type, listener);
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
      leaveHover();
      if (captured !== null) {
        captured.target.backend.pointerCancel(captured.target.root, captured.pointerId);
        captured = null;
      }
      sink.remove();
      keyboardTarget = null;
      followCaretFrames(false);
    },
  });
}
