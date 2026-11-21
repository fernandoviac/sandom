import { createEvent, createEventUsing, createSyntheticEvent, dispatchEvent, markRunActivationEvent, SDEvent } from "./events.js";
import { controlSelectionQueued, controlSelectionSet, controlValueEdited } from "./input-controls.js";
import { documentScripts } from "./scripts.js";
import { giveSubmissionEntries, queueFormNavigation } from "./form-data.js";
import { resetOutput } from "./form-dom.js";
import { nodeMember } from "./node-members.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { activationClock } from "./local-time.js";

const INPUT_ACTIVATION_BLUR = layoutConstant("INPUT_ACTIVATION_BLUR");
const INPUT_ACTIVATION_REQUEST_SUBMIT = layoutConstant("INPUT_ACTIVATION_REQUEST_SUBMIT");
const INPUT_ACTIVATION_CLICK = layoutConstant("INPUT_ACTIVATION_CLICK");
const INPUT_ACTIVATION_SYSTEM_BLUR = layoutConstant("INPUT_ACTIVATION_SYSTEM_BLUR");
const INPUT_ACTIVATION_SYSTEM_FOCUS = layoutConstant("INPUT_ACTIVATION_SYSTEM_FOCUS");
const FOCUS_CHECK_NOW = layoutConstant("FOCUS_CHECK_NOW");
const FOCUS_CHECK_QUEUE = layoutConstant("FOCUS_CHECK_QUEUE");
const FOCUS_CHECK_BLUR = layoutConstant("FOCUS_CHECK_BLUR");

// The JavaScript host of the core's executing input runs
// (core/dom/input-run.watpart): Event objects, listener calls and the
// facade's effects of each notification. The core chooses every target,
// state transition, default action and notification order, and executes
// the default actions.
// The codes of input-run.watpart, by WAT name.
const constant = (name) => layoutConstant(name);
const NOTIFY = Object.freeze({
  EVENT: constant("INPUT_NOTIFY_EVENT"), STATE: constant("INPUT_NOTIFY_STATE"), EFFECT: constant("INPUT_NOTIFY_EFFECT"),
  RECORD_HOOK: constant("INPUT_NOTIFY_RECORD_HOOK"),
});
const SOURCE_BATCH = constant("INPUT_SOURCE_BATCH");
const EVENT = Object.freeze(Object.fromEntries(["BLUR", "FOCUSOUT", "FOCUS", "FOCUSIN", "CLICK", "INPUT", "CHANGE", "SUBMIT",
  "BEFORETOGGLE", "CANCEL", "INVALID", "RESET", "AUTOFILL_KEYDOWN", "AUTOFILL_KEYUP"].map((name) => [name, constant(`INPUT_EVENT_${name}`)])));
const STATE = Object.freeze(Object.fromEntries(["HOVER", "ACTIVE", "FOCUS", "CHECKED", "SELECTED", "VALUE_EDITED",
  "SELECTION_SET", "DOCUMENT_SELECTION", "SCROLLED", "DETAILS_OPEN", "SELECTION_QUEUED", "TOP_LAYER", "VALIDITY", "CONTENT_EDITED",
  "AUTOFILL", "OPEN"].map((name) => [name, constant(`INPUT_STATE_${name}`)])));
const EFFECT_CLIPBOARD = constant("INPUT_EFFECT_CLIPBOARD");
const EFFECT_FORM_ENTRY_LIST = constant("INPUT_EFFECT_FORM_ENTRY_LIST");
const EFFECT_FORM_NAVIGATION = constant("INPUT_EFFECT_FORM_NAVIGATION");
const EFFECT_TOP_LAYER_TASK = constant("INPUT_EFFECT_TOP_LAYER_TASK");
const EFFECT_SCROLL_INTO_VIEW = constant("INPUT_EFFECT_SCROLL_INTO_VIEW");
const EFFECT_RESET_OUTPUT = constant("INPUT_EFFECT_RESET_OUTPUT");
const EFFECT_FIELD_MENU = constant("INPUT_EFFECT_FIELD_MENU");
const EFFECT_RESIZE = constant("INPUT_EFFECT_RESIZE");
const EFFECT_EYEDROPPER = constant("INPUT_EFFECT_EYEDROPPER");
const EFFECT_HYPERLINK = constant("INPUT_EFFECT_HYPERLINK");
const EFFECT_CURSOR = constant("INPUT_EFFECT_CURSOR");
const EFFECT_CLIPBOARD_READ = constant("INPUT_EFFECT_CLIPBOARD_READ");
export const INPUT_OUTCOME = Object.freeze({
  DONE: constant("INPUT_OUTCOME_DONE"), CANCELED: constant("INPUT_OUTCOME_CANCELED"), FAILED: constant("INPUT_OUTCOME_FAILED"),
});
const EVENT_FLAG = Object.freeze(Object.fromEntries(["BUBBLES", "CANCELABLE", "COMPOSED"]
  .map((name) => [name, constant(`INPUT_EVENT_FLAG_${name}`)])));
// The bubbles, cancelable and composed of an event notification, from its
// INPUT_EVENT_FLAG_* flags.
export function eventFlagsInit(flags) {
  return {
    bubbles: (flags & EVENT_FLAG.BUBBLES) !== 0, cancelable: (flags & EVENT_FLAG.CANCELABLE) !== 0,
    composed: (flags & EVENT_FLAG.COMPOSED) !== 0,
  };
}
// The pseudo-class name of a state notification that a style rule reads.
const STATE_NAMES = new Map([
  [STATE.HOVER, "hover"], [STATE.ACTIVE, "active"], [STATE.FOCUS, "focus"], [STATE.CHECKED, "checked"],
  [STATE.SELECTED, "selected"], [STATE.AUTOFILL, "autofill"], [STATE.OPEN, "open"],
]);

// The tasks of the top layer operations (core/dom/top-layer.watpart):
// the core queues them, and each asks the core whether it fires.
const TOP_LAYER_CLAIM = Object.freeze(Object.fromEntries(["SIZE", "ELEMENT", "SOURCE", "OLD_STATE", "NEW_STATE"]
  .map((name) => [name, layoutConstant(`TOP_LAYER_CLAIM_${name}`)])));
const TOP_LAYER_TASK_TOGGLE = layoutConstant("TOP_LAYER_TASK_TOGGLE");
const TOP_LAYER_TASK_CLOSE = layoutConstant("TOP_LAYER_TASK_CLOSE");
const TOGGLE_DETAIL_STATE_MASK = layoutConstant("TOGGLE_DETAIL_STATE_MASK");
const TOGGLE_DETAIL_NEW_SHIFT = layoutConstant("TOGGLE_DETAIL_NEW_SHIFT");
const TOGGLE_DETAIL_CANCELABLE = layoutConstant("TOGGLE_DETAIL_CANCELABLE");
// The ToggleEvent state keywords by the core's toggle state.
const TOGGLE_STATES = new Map([
  [layoutConstant("TOGGLE_STATE_CLOSED"), "closed"],
  [layoutConstant("TOGGLE_STATE_OPEN"), "open"],
]);

// The toggle state of a beforetoggle notification's aux word.
function toggleEventInit(core, notification) {
  return {
    cancelable: (notification.aux & TOGGLE_DETAIL_CANCELABLE) !== 0,
    oldState: TOGGLE_STATES.get(notification.aux & TOGGLE_DETAIL_STATE_MASK),
    newState: TOGGLE_STATES.get((notification.aux >> TOGGLE_DETAIL_NEW_SHIFT) & TOGGLE_DETAIL_STATE_MASK),
    source: core.wrapperFor(notification.related),
  };
}

// A task of the core's top layer task queue (a queue task notification,
// or a details toggle task of details.watpart): the task runs on the
// document's task queue and asks the core whether it fires.
export function queueTopLayerTask(core, element, token) {
  documentScripts(nodeMember(element, "ownerDocument")).queueTask(() => {
    const kind = core.status("top_layer_task_claim", token);
    if (kind === 0) return;
    // Capture the claim before resolving a wrapper can reenter the core.
    const view = core.output("top_layer_task_claim");
    const element = view.getBigUint64(TOP_LAYER_CLAIM.ELEMENT, true);
    const sourceHandle = view.getBigUint64(TOP_LAYER_CLAIM.SOURCE, true);
    const oldState = TOGGLE_STATES.get(view.getUint32(TOP_LAYER_CLAIM.OLD_STATE, true));
    const newState = TOGGLE_STATES.get(view.getUint32(TOP_LAYER_CLAIM.NEW_STATE, true));
    const target = core.wrapperFor(element);
    const source = core.wrapperFor(sourceHandle);
    if (kind === TOP_LAYER_TASK_TOGGLE) {
      dispatchEvent(target, createEvent("toggle", { oldState, newState, source }));
    } else if (kind === TOP_LAYER_TASK_CLOSE) {
      dispatchEvent(target, createEvent("close"));
    } else {
      throw new Error(`Unknown top layer task kind ${kind}`);
    }
  });
}

// The notification of input-run.watpart, by WAT name.
const NOTIFICATION = Object.freeze(Object.fromEntries(["SIZE", "KIND", "CODE", "FLAGS", "AUX", "TARGET", "RELATED", "A",
  "B", "C", "D", "RECORD", "SOURCE", "TOKEN"].map((name) => [name, layoutConstant(`INPUT_NOTIFICATION_${name}`)])));

function readNotification(core) {
  const view = core.output("input_run_next");
  // Capture the borrowed record before resolving a wrapper can reenter the core.
  return {
    kind: view.getUint32(NOTIFICATION.KIND, true), code: view.getUint32(NOTIFICATION.CODE, true),
    flags: view.getUint32(NOTIFICATION.FLAGS, true), aux: view.getUint32(NOTIFICATION.AUX, true),
    target: view.getBigUint64(NOTIFICATION.TARGET, true), related: view.getBigUint64(NOTIFICATION.RELATED, true),
    a: view.getFloat64(NOTIFICATION.A, true), b: view.getFloat64(NOTIFICATION.B, true),
    c: view.getFloat64(NOTIFICATION.C, true), d: view.getFloat64(NOTIFICATION.D, true),
    record: view.getInt32(NOTIFICATION.RECORD, true), token: view.getBigUint64(NOTIFICATION.TOKEN, true),
    source: view.getUint32(NOTIFICATION.SOURCE, true),
  };
}

// The Event object of an activation event notification, with the
// bubbles, cancelable and composed that the core gives in its flags. The
// clicks of a click() run are synthetic: their isTrusted is false (HTML
// "fire a synthetic pointer event" with the not trusted flag). A user's
// click is trusted.
function activationEvent(core, notification, syntheticClicks) {
  const related = core.wrapperFor(notification.related);
  const init = eventFlagsInit(notification.flags);
  switch (notification.code) {
    case EVENT.BLUR: return createEvent("blur", { ...init, relatedTarget: related });
    case EVENT.FOCUSOUT: return createEvent("focusout", { ...init, relatedTarget: related });
    case EVENT.FOCUS: return createEvent("focus", { ...init, relatedTarget: related });
    case EVENT.FOCUSIN: return createEvent("focusin", { ...init, relatedTarget: related });
    // The core gives the click count of the press as notification a (1
    // for a click without one; input-activation.watpart).
    case EVENT.CLICK: return (syntheticClicks ? createSyntheticEvent : createEvent)("click", { ...init, detail: notification.a });
    case EVENT.INPUT: return createEvent("input", { ...init, inputType: null, data: null });
    case EVENT.CHANGE: return createEvent("change", init);
    case EVENT.SUBMIT: return createEvent("submit", { ...init, submitter: related });
    case EVENT.BEFORETOGGLE: return createEvent("beforetoggle", toggleEventInit(core, notification));
    case EVENT.CANCEL: return createEvent("cancel", { cancelable: (notification.aux & 1) !== 0 });
    case EVENT.INVALID: return createEvent("invalid", init);
    case EVENT.RESET: return createEvent("reset", init);
    // The key events of a fill are plain events, as Chrome fires them
    // (core/dom/autofill.watpart).
    case EVENT.AUTOFILL_KEYDOWN: return createEventUsing(SDEvent, "keydown", init);
    case EVENT.AUTOFILL_KEYUP: return createEventUsing(SDEvent, "keyup", init);
    default: throw new Error(`Unknown native activation event ${notification.code}`);
  }

}

// The UTF-8 text of a host effect notification: the b bytes at address
// a, as the clipboard text, a hyperlink's URL and a cursor keyword give it.
export function effectText(core, notification) {
  return core.decoder.decode(core.refreshBytes().subarray(notification.a, notification.a + notification.b));
}

// Follows the hyperlink of a host effect notification (HTML "follow the
// hyperlink"): the core gives the link and its URL, parsed against the
// document base URL; the document runs a javascript: URL. Returns the
// link and the URL.
function followRunHyperlink(core, notification) {
  const link = core.wrapperFor(notification.target);
  const url = effectText(core, notification);
  nodeMember(link, "ownerDocument")._scriptProcessing?.followURL(url);
  return { link, url };
}

// Executes one notification; returns its INPUT_OUTCOME.
// `host` answers what only an input batch's host knows: its events, the
// scroll owner's surface, the clipboard text and the record hooks.
function executeNotification(core, notification, host) {
  const { kind, code } = notification;
  if (kind === NOTIFY.EVENT) {
    if (notification.source === SOURCE_BATCH) return host.batchEvent(notification);
    const target = core.wrapperFor(notification.target);
    const event = activationEvent(core, notification, host.syntheticClicks === true);
    // The run follows the hyperlink of its click itself (EFFECT_HYPERLINK).
    markRunActivationEvent(event);
    return dispatchEvent(target, event) ? INPUT_OUTCOME.DONE : INPUT_OUTCOME.CANCELED;
  }
  if (kind === NOTIFY.STATE) {
    const target = core.wrapperFor(notification.target);
    if (STATE_NAMES.has(code)) {
      // The core invalidated the style that the state affects.
      target._notifyMutation("state", code === STATE.FOCUS && notification.a ? "focus-within" : STATE_NAMES.get(code));
    } else if (code === STATE.VALUE_EDITED) {
      controlValueEdited(target, Boolean(notification.a), Boolean(notification.b));
      host.valueEdited?.(notification);
    } else if (code === STATE.SELECTION_SET) {
      controlSelectionSet(target, notification.a !== 0);
    } else if (code === STATE.DOCUMENT_SELECTION) {
      core.wrapperFor(notification.related).getSelection()._onChange(target);
    } else if (code === STATE.SCROLLED) {
      host.scrolled(notification);
    } else if (code === STATE.DETAILS_OPEN) {
      target._deliverToggledAttribute();
    } else if (code === STATE.CONTENT_EDITED) {
      // The core edited the content of the editing host: its tree and text
      // records reach the facade as the DOM methods' do.
      target._dispatchCoreTreeRecords();
    } else if (code === STATE.SELECTION_QUEUED) {
      controlSelectionQueued(target);
    } else if (code === STATE.TOP_LAYER) {
      // The core changed the element's top layer state (:modal, the top
      // layer) and invalidated its style.
      target._notifyMutation("state", "modal");
    } else if (code === STATE.VALIDITY) {
      host.validity(notification);
    } else {
      throw new Error(`Unknown native input state ${code}`);
    }
    return INPUT_OUTCOME.DONE;
  }
  if (kind === NOTIFY.EFFECT) {
    if (code === EFFECT_CLIPBOARD) {
      host.clipboard(notification);
    } else if (code === EFFECT_FORM_ENTRY_LIST) {
      giveSubmissionEntries(core.wrapperFor(notification.target), core.wrapperFor(notification.related));
    } else if (code === EFFECT_FORM_NAVIGATION) {
      queueFormNavigation(core.wrapperFor(notification.target), notification.a);
    } else if (code === EFFECT_TOP_LAYER_TASK) {
      queueTopLayerTask(core, core.wrapperFor(notification.target), BigInt(notification.a));
    } else if (code === EFFECT_RESET_OUTPUT) {
      resetOutput(core.wrapperFor(notification.target));
    } else if (code === EFFECT_SCROLL_INTO_VIEW) {
      core.wrapperFor(notification.target).scrollIntoView({ block: "nearest", inline: "nearest" });
    } else if (code === EFFECT_FIELD_MENU) {
      host.fieldMenu(notification);
    } else if (code === EFFECT_RESIZE) {
      // A drag of a textarea's resize handle (core/dom/textarea-resize.watpart)
      // writes the box's size in its style attribute, as Chrome does.
      const target = core.wrapperFor(notification.target);
      if (Number.isFinite(notification.a)) target.style.width = `${notification.a}px`;
      if (Number.isFinite(notification.b)) target.style.height = `${notification.b}px`;
    } else if (code === EFFECT_EYEDROPPER) {
      host.eyedropper(notification);
    } else if (code === EFFECT_HYPERLINK) {
      const { link, url } = followRunHyperlink(core, notification);
      host.hyperlink(link, url);
    } else if (code === EFFECT_CURSOR) {
      host.cursor(notification);
    } else if (code === EFFECT_CLIPBOARD_READ) {
      host.clipboardRead(notification);
    } else {
      throw new Error(`Unknown native host effect ${code}`);
    }
    return INPUT_OUTCOME.DONE;
  }
  if (kind === NOTIFY.RECORD_HOOK) {
    host.recordHook(notification);
    return INPUT_OUTCOME.DONE;
  }
  throw new Error(`Unknown native input notification ${kind}`);
}

// Reads the run's next notification, or null at its end. A run opens no
// custom element reaction scope: the reactions that a step enqueues (a
// form reset's formResetCallback) go to the scope of the [CEReactions]
// method that started the run, or else to the backup element queue, and
// so no callback reenters the core while the run holds a notification.
function nextNotification(core, run) {
  return core.status("input_run_next", run) ? readNotification(core) : null;
}

// Drives run `run` to its end and releases it. A host exception resumes
// the notification with INPUT_OUTCOME.FAILED, which ends the run, and is
// rethrown.
export function executeInputRun(core, run, host) {
  try {
    for (let notification; (notification = nextNotification(core, run));) {
      // A step of the run that changed a select's selection updated its
      // selectedcontent: its records reach the facade before the next
      // notification, an input or change event among them, runs.
      core.deliverSelectedContent();
      let outcome;
      try {
        outcome = executeNotification(core, notification, host);
      } catch (error) {
        try { core.status("input_run_resume", run, notification.token, INPUT_OUTCOME.FAILED); } catch { /* Preserve the original listener/host exception. */ }
        throw error;
      }
      core.status("input_run_resume", run, notification.token, outcome);
    }
    core.deliverSelectedContent();
  } finally {
    // Release keeps an active native error for the throw above.
    core.exports.input_run_release(run);
  }
}

const activationHost = {
  batchEvent() { throw new Error("An activation run has no input batch event"); },
  scrolled() { throw new Error("An activation run does not scroll"); },
  clipboard() { throw new Error("An activation run has no clipboard text"); },
  clipboardRead() { throw new Error("An activation run has no paste key"); },
  fieldMenu() { throw new Error("An activation run has no context menu"); },
  eyedropper() { throw new Error("An activation run has no colour picker eyedropper"); },
  // A click() run has no input host to give its followed hyperlink.
  hyperlink() {},
  cursor() { throw new Error("An activation run has no pointer record for a cursor"); },
  recordHook() { throw new Error("An activation run has no input records"); },
  validity() { throw new Error("An activation run has no validity result"); },
};

// The run of click(): the clicks it fires are synthetic.
const clickMethodHost = { ...activationHost, syntheticClicks: true };

export function executeActivationRun(core, run) {
  executeInputRun(core, run, activationHost);
}

export function runInputActivation(node, operation) {
  const core = node._domCore;
  executeInputRun(core, core.status("input_run_activation_begin", node._coreHandle, operation, activationClock(node)),
    operation === INPUT_ACTIVATION_CLICK ? clickMethodHost : activationHost);
}

// The host gives document system focus or takes it away
// (core/dom/input-activation.watpart, $inputActivationSystemFocus).
export function setSystemFocus(document, focused) {
  runInputActivation(document, focused ? INPUT_ACTIVATION_SYSTEM_FOCUS : INPUT_ACTIVATION_SYSTEM_BLUR);
}

// checkValidity() and reportValidity() of an element or a form
// (core/dom/constraint-validation.watpart): the run fires the invalid
// events that the core requests and ends with the core's result.
export function runValidation(node, operation) {
  const core = node._domCore;
  let result = null;
  executeInputRun(core, core.status("input_run_activation_begin", node._coreHandle, operation, activationClock(node)), {
    ...activationHost,
    validity(notification) { result = notification.aux === 1; },
  });
  if (result === null) throw new Error("The validation run ended without its result");
  return result;
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
  const document = nodeMember(root, "ownerDocument") ?? root;
  if (pendingFocusFixups.has(document) || focusFixupTarget(document) === null) return;
  pendingFocusFixups.add(document);
  // The document's own task queue, where its page timers run: the blur
  // orders against setTimeout as Chrome orders it.
  documentScripts(document).queueTask(() => {
    pendingFocusFixups.delete(document);
    const focused = focusFixupTarget(document);
    if (focused !== null) runInputActivation(focused, INPUT_ACTIVATION_BLUR);
  });
}

// Chrome's focus check inside an attribute change
// (input_focus_attribute_check): it blurs the focused element at once
// when it is no longer a focusable area (FOCUS_CHECK_NOW) or
// unconditionally (FOCUS_CHECK_BLUR), or queues the focus fixup
// (FOCUS_CHECK_QUEUE).
export function focusAttributeChanged(element, name) {
  const core = element._domCore;
  const action = core.status("input_focus_attribute_check", element._coreHandle, ...core.input(String(name)));
  if (action === FOCUS_CHECK_NOW) {
    const focused = focusFixupTarget(nodeMember(element, "ownerDocument"));
    if (focused !== null) runInputActivation(focused, INPUT_ACTIVATION_BLUR);
  } else if (action === FOCUS_CHECK_QUEUE) {
    scheduleFocusFixup(element);
  } else if (action === FOCUS_CHECK_BLUR) {
    runInputActivation(element, INPUT_ACTIVATION_BLUR);
  }
}

// Chrome blurs the focused element before a removal takes it out of its
// document (input_focus_removal): the removal of `node`, or of its
// children with `childrenOnly`.
export function blurBeforeRemoval(node, childrenOnly = false) {
  const core = node._domCore;
  const focused = core.wrapperFor(core.handle("input_focus_removal", node._coreHandle, childrenOnly ? 1 : 0));
  if (focused !== null) runInputActivation(focused, INPUT_ACTIVATION_BLUR);
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
  runInputActivation(submitter ?? form, INPUT_ACTIVATION_REQUEST_SUBMIT);
}
