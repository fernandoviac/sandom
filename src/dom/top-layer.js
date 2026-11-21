import { executeActivationRun } from "./input-activation.js";
import { withCustomElementReactions } from "./custom-elements.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The dialog and popover methods of the DOM core's top layer
// (core/dom/top-layer.watpart): each starts a core run, and the core
// decides each step and each event. input-activation.js runs the tasks
// that the core queues.

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SHOW_POPOVER = layoutConstant("INPUT_ACTIVATION_SHOW_POPOVER");
const TOGGLE_POPOVER = layoutConstant("INPUT_ACTIVATION_TOGGLE_POPOVER");
const TOGGLE_POPOVER_SHOW = layoutConstant("INPUT_ACTIVATION_TOGGLE_POPOVER_SHOW");
const TOGGLE_POPOVER_HIDE = layoutConstant("INPUT_ACTIVATION_TOGGLE_POPOVER_HIDE");
const POPOVER_ATTRIBUTE = layoutConstant("INPUT_ACTIVATION_POPOVER_ATTRIBUTE");

const CLOSED_BY = new Map([
  [layoutConstant("DIALOG_CLOSED_BY_ANY"), "any"],
  [layoutConstant("DIALOG_CLOSED_BY_CLOSE_REQUEST"), "closerequest"],
  [layoutConstant("DIALOG_CLOSED_BY_NONE"), "none"],
]);

// Runs top layer operation `operation` on `element`; `returnValue` is the
// optional DOMString argument of close() and requestClose(), `source` the
// source element of a popover operation. Each dialog and popover method
// is [CEReactions].
function runTopLayerOperation(element, operation, returnValue = undefined, source = null) {
  const core = element._domCore;
  const present = returnValue !== undefined;
  const [pointer, length] = present ? core.input(String(returnValue)) : [0, 0];
  withCustomElementReactions(() => executeActivationRun(core, core.status("input_run_top_layer_begin", element._coreHandle,
    operation, source === null ? 0n : source._coreHandle, pointer, length, present ? 1 : 0)), core);
}

// The Web IDL conversion of a dictionary argument: undefined and null are
// the empty dictionary, any other non-object throws.
function dictionary(options, method) {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" && typeof options !== "function") {
    throw new TypeError(`Failed to execute '${method}' on 'HTMLElement': The provided value is not of type 'dictionary'.`);
  }
  return options;
}

// The `source` member of ShowPopoverOptions and TogglePopoverOptions: an
// HTMLElement or absent.
function popoverSource(options, method) {
  const source = options.source;
  if (source === undefined) return null;
  if (source === null || typeof source !== "object" || source._coreHandle === undefined || source.nodeType !== 1 ||
    source.namespaceURI !== HTML_NAMESPACE) {
    throw new TypeError(`Failed to execute '${method}' on 'HTMLElement': Failed to read the 'source' property from the dictionary: Failed to convert value to 'HTMLElement'.`);
  }
  return source;
}

// A change of the popover attribute (P12): the hide that the core owes a
// showing popover runs before the attribute method returns.
export function popoverAttributeChanged(element) {
  const core = element._domCore;
  if (core.status("popover_attribute_take", element._coreHandle) === 1) {
    runTopLayerOperation(element, POPOVER_ATTRIBUTE);
  }
}

export const topLayerBindingRuntime = Object.freeze({
  runTopLayerOperation,
  showPopover(element, options) {
    const source = popoverSource(dictionary(options, "showPopover"), "showPopover");
    runTopLayerOperation(element, SHOW_POPOVER, undefined, source);
  },
  togglePopover(element, options) {
    // (TogglePopoverOptions or boolean): an object or a nullish value is
    // the dictionary, anything else the boolean force.
    let force;
    let source = null;
    if (options === undefined || options === null || typeof options === "object" || typeof options === "function") {
      const members = dictionary(options, "togglePopover");
      const value = members.force;
      force = value === undefined ? undefined : Boolean(value);
      source = popoverSource(members, "togglePopover");
    } else {
      force = Boolean(options);
    }
    runTopLayerOperation(element, force === undefined ? TOGGLE_POPOVER : force ? TOGGLE_POPOVER_SHOW : TOGGLE_POPOVER_HIDE,
      undefined, source);
    return element._domCore.status("popover_showing", element._coreHandle) === 1;
  },
  popoverTargetElement(element) {
    const core = element._domCore;
    return core.wrapperFor(core.handle("popover_target_element", element._coreHandle));
  },
  setPopoverTargetElement(element, value) {
    if (value === null || value === undefined) {
      element.removeAttribute("popovertarget");
      return;
    }
    if (typeof value !== "object" || value._coreHandle === undefined || value.nodeType !== 1) {
      throw new TypeError("Failed to set the 'popoverTargetElement' property on 'HTMLElement': Failed to convert value to 'Element'.");
    }
    element.setAttribute("popovertarget", "");
    element._domCore.status("popover_target_element_set", element._coreHandle, value._coreHandle);
  },
  dialogReturnValue(element) {
    const core = element._domCore;
    core.status("dialog_return_value", element._coreHandle);
    return core.outputString("dialog_return_value");
  },
  setDialogReturnValue(element, value) {
    const core = element._domCore;
    core.status("dialog_return_value_set", element._coreHandle, ...core.input(String(value)));
  },
  dialogClosedBy(element) {
    const core = element._domCore;
    return CLOSED_BY.get(core.status("dialog_closed_by", element._coreHandle));
  },
  setDialogClosedBy(element, value) {
    element.setAttribute("closedby", value);
  },
});
