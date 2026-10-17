import { createEvent, dispatchEvent } from "./events.js";
import { controlSelectionQueued, controlSelectionSet, controlValueEdited } from "./input-controls.js";
import { documentScripts } from "./scripts.js";

// The JavaScript host of the core's executing input runs
// (src/dom-wasm/input-run.watpart): Event objects, listener calls and the
// facade's effects of each notification. The core chooses every target,
// state transition, default action and notification order, and executes
// the default actions.
const ACTIVATION_EVENTS = [null, "blur", "focusout", "focus", "focusin", "click", "input", "change"];
const STATES = [null, "hover", "active", "focus", "checked", "selected"];

// Calls an input export and throws its error, with the input error code's
// message when it has one.
export function inputInvoke(core, operation, ...args) {
  const result = core.exports[operation](...args);
  if (core.exports.abi_error_kind()) {
    const code = core.exports.input_error_code();
    if (code === 1 || code === 2) {
      const id = core.exports.input_error_pointer_id();
      throw new Error(`Pointer ${id} is ${code === 2 ? "already" : "not"} active`);
    }
    if (code === 3) throw new Error("A text composition is already active");
    if (code === 4) throw new Error("Composition update requires an active composition");
    if (code === 5) throw new Error("Composition end requires an active composition");
    if (code === 6 || code === 7) throw new Error(`No ${code === 7 ? "vertical" : "horizontal"} scrollbar exists for the element`);
    if (code === 8) throw new Error("Text composition requires an enabled focused text control");
    if (code === 9) throw new Error("A text edit cannot run during an active text composition: end it with compositionEnd first");
    core.throwIfError();
  }
  return result;
}

function readNotification(core) {
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 80);
  // Capture the borrowed record before resolving a wrapper can reenter the core.
  return {
    kind: view.getUint32(0, true), code: view.getUint32(4, true), flags: view.getUint32(8, true), aux: view.getUint32(12, true),
    target: view.getBigUint64(16, true), related: view.getBigUint64(24, true),
    a: view.getFloat64(32, true), b: view.getFloat64(40, true), c: view.getFloat64(48, true), d: view.getFloat64(56, true),
    record: view.getInt32(64, true), token: view.getBigUint64(72, true), source: view.getUint32(68, true),
  };
}

function activationEvent(core, notification) {
  const { code } = notification;
  if (code === 15) {
    return createEvent("submit", { bubbles: true, cancelable: true, submitter: core.wrapperFor(notification.related) });
  }
  let options;
  if (code <= 4) {
    options = { composed: true, relatedTarget: core.wrapperFor(notification.related) };
    if (code === 2 || code === 4) options.bubbles = true;
  } else if (code === 5) {
    options = { bubbles: true, cancelable: true, detail: 1 };
  } else if (code === 6) {
    options = { bubbles: true, composed: true, inputType: null, data: null };
  } else if (code === 7) {
    options = { bubbles: true };
  } else {
    throw new Error(`Unknown native activation event ${code}`);
  }
  return createEvent(ACTIVATION_EVENTS[code], options);
}

// Executes one notification; returns the outcome, 1 for a canceled event.
// `host` answers what only an input batch's host knows: its events, the
// scroll owner's surface, the clipboard text and the record hooks.
function executeNotification(core, notification, host) {
  const { kind, code } = notification;
  if (kind === 1) {
    if (notification.source === 0) return host.batchEvent(notification);
    const target = core.wrapperFor(notification.target);
    return dispatchEvent(target, activationEvent(core, notification)) ? 0 : 1;
  }
  if (kind === 2) {
    const target = core.wrapperFor(notification.target);
    if (code >= 1 && code <= 5) {
      // The core invalidated the style that the state affects.
      target._notifyMutation("state", code === 3 && notification.a ? "focus-within" : STATES[code], null, true);
    } else if (code === 6) {
      controlValueEdited(target, Boolean(notification.a), Boolean(notification.b));
      host.valueEdited?.(notification);
    } else if (code === 7) {
      controlSelectionSet(target);
    } else if (code === 8) {
      core.wrapperFor(notification.related).getSelection()._onChange(target);
    } else if (code === 9) {
      host.scrolled(notification);
    } else if (code === 10) {
      target._deliverToggledAttribute(Boolean(notification.a));
    } else if (code === 11) {
      controlSelectionQueued(target);
    } else {
      throw new Error(`Unknown native input state ${code}`);
    }
    return 0;
  }
  if (kind === 3) {
    if (code === 1) {
      host.clipboard(notification);
    } else if (code === 2) {
      // The submission reached navigation, which Sandom does not
      // perform: the document stays as it is, and says so.
      const detail = Object.freeze({ submitter: core.wrapperFor(notification.related) });
      dispatchEvent(core.wrapperFor(notification.target), createEvent("sandom-form-submission", { bubbles: true, composed: true, detail }));
    } else {
      throw new Error(`Unknown native host effect ${code}`);
    }
    return 0;
  }
  if (kind === 4) {
    host.recordHook(notification);
    return 0;
  }
  throw new Error(`Unknown native input notification ${kind}`);
}

// Drives run `run` to its end and releases it. A host exception resumes
// the notification with outcome 2, which ends the run, and is rethrown.
export function executeInputRun(core, run, host) {
  try {
    while (inputInvoke(core, "input_run_next", run)) {
      const notification = readNotification(core);
      let outcome;
      try {
        outcome = executeNotification(core, notification, host);
      } catch (error) {
        try { inputInvoke(core, "input_run_resume", run, notification.token, 2); } catch { /* Preserve the original listener/host exception. */ }
        throw error;
      }
      inputInvoke(core, "input_run_resume", run, notification.token, outcome);
    }
  } finally {
    // Release keeps an active native error for the throw above.
    core.exports.input_run_release(run);
  }
}

const activationHost = {
  batchEvent() { throw new Error("An activation run has no input batch event"); },
  scrolled() { throw new Error("An activation run does not scroll"); },
  clipboard() { throw new Error("An activation run has no clipboard text"); },
  recordHook() { throw new Error("An activation run has no input records"); },
};

export function executeActivationRun(core, run) {
  executeInputRun(core, run, activationHost);
}

export function runInputActivation(node, operation) {
  const core = node._domCore;
  executeInputRun(core, inputInvoke(core, "input_run_activation_begin", node._coreHandle, operation), activationHost);
}

// Runs `operation` with the geometry snapshot `handle` as the focus
// geometry: the focus checks read it to decide whether a scroll container
// is a focusable area (input_focus_geometry). The previous focus geometry
// comes back after it.
export function withFocusGeometry(core, handle, operation) {
  const previous = core.handle("input_focus_geometry", handle);
  try {
    return operation();
  } finally {
    core.handle("input_focus_geometry", previous);
  }
}

// The geometry of the frame that the document's render surface presents,
// or 0n before its first frame.
function presentedFocusGeometry(document) {
  const surface = document.documentElement?._renderSurface ?? document._componentRenderSurface;
  return surface?.presentedFrame?.geometryHandle ?? 0n;
}

// The focus fixup (HTML "update the rendering", as Chrome runs it): each
// style and layout update checks whether the focused element is still a
// focusable area. When it stopped being rendered or became disabled or
// inert, a task is queued that checks again and blurs it, with its blur
// and focusout events. Render surfaces check at the start of a rendering
// opportunity and after its animation frame callbacks; a synchronous
// layout read checks too (live-geometry.js). A focused scroll container
// keeps its focusable area while the presented frame's geometry gives it
// overflow.
const pendingFocusFixups = new WeakSet();
function focusFixupTarget(document) {
  const core = document._domCore;
  return withFocusGeometry(core, presentedFocusGeometry(document), () =>
    core.wrapperFor(core.handle("input_focus_fixup", document._coreHandle)));
}
export function scheduleFocusFixup(root) {
  const document = root.ownerDocument ?? root;
  if (pendingFocusFixups.has(document) || focusFixupTarget(document) === null) return;
  pendingFocusFixups.add(document);
  // The document's own task queue, where its page timers run: the blur
  // orders against setTimeout as Chrome orders it.
  documentScripts(document).queueTask(() => {
    pendingFocusFixups.delete(document);
    const focused = focusFixupTarget(document);
    if (focused !== null) runInputActivation(focused, 2);
  });
}

// Chrome's focus check inside an attribute change
// (input_focus_attribute_check): it blurs the focused element at once
// when it is no longer a focusable area (1) or unconditionally (3), or
// queues the focus fixup (2).
export function focusAttributeChanged(element, name) {
  const core = element._domCore;
  const action = core.status("input_focus_attribute_check", element._coreHandle, ...core.input(String(name)));
  if (action === 1) {
    const focused = focusFixupTarget(element.ownerDocument);
    if (focused !== null) runInputActivation(focused, 2);
  } else if (action === 2) {
    scheduleFocusFixup(element);
  } else if (action === 3) {
    runInputActivation(element, 2);
  }
}

// Chrome blurs the focused element before a removal takes it out of its
// document (input_focus_removal): the removal of `node`, or of its
// children with `childrenOnly`.
export function blurBeforeRemoval(node, childrenOnly = false) {
  const core = node._domCore;
  const focused = core.wrapperFor(core.handle("input_focus_removal", node._coreHandle, childrenOnly ? 1 : 0));
  if (focused !== null) runInputActivation(focused, 2);
}

// HTMLFormElement.requestSubmit: a submitter must be a submit button whose
// form owner is this form; without one, the form submits itself.
export function requestSubmit(form, submitter = null) {
  const core = form._domCore;
  if (submitter !== null) {
    if (submitter?._domCore !== core || !core.status("input_control_submit_button", submitter._coreHandle)) {
      throw new TypeError("requestSubmit: the submitter is not a submit button");
    }
    if (core.handle("input_control_form", submitter._coreHandle) !== form._coreHandle) {
      throw new DOMException("requestSubmit: the submitter is not owned by this form", "NotFoundError");
    }
  }
  runInputActivation(submitter ?? form, 4);
}
