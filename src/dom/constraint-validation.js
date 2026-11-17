// The constraint validation API (HTML §4.10.21.3) of the listed elements:
// each member converts its WebIDL arguments and asks the DOM core
// (core/dom/constraint-validation.watpart), which decides
// (design/constraint-validation.md).
import { layoutConstant } from "../wasm/layout-table.js";
import { runInputActivation, runValidation } from "./input-activation.js";
import { elementLabels } from "./form-dom.js";
import { setSubmissionValue } from "./form-submission-values.js";
import { withCustomElementReactions } from "./custom-elements.js";
import { nodeMember } from "./node-members.js";

const INPUT_ACTIVATION_CHECK_VALIDITY = layoutConstant("INPUT_ACTIVATION_CHECK_VALIDITY");
const INPUT_ACTIVATION_REPORT_VALIDITY = layoutConstant("INPUT_ACTIVATION_REPORT_VALIDITY");
const INPUT_ACTIVATION_RESET = layoutConstant("INPUT_ACTIVATION_RESET");

// The ValidityState attributes in IDL order, with the bit of each in the
// flags of input_control_validity.
const VALIDITY_FLAGS = Object.freeze([
  ["valueMissing", "VALIDITY_VALUE_MISSING"], ["typeMismatch", "VALIDITY_TYPE_MISMATCH"],
  ["patternMismatch", "VALIDITY_PATTERN_MISMATCH"], ["tooLong", "VALIDITY_TOO_LONG"], ["tooShort", "VALIDITY_TOO_SHORT"],
  ["rangeUnderflow", "VALIDITY_RANGE_UNDERFLOW"], ["rangeOverflow", "VALIDITY_RANGE_OVERFLOW"],
  ["stepMismatch", "VALIDITY_STEP_MISMATCH"], ["badInput", "VALIDITY_BAD_INPUT"], ["customError", "VALIDITY_CUSTOM_ERROR"],
  ["valid", "VALIDITY_VALID"],
].map(([name, constant]) => [name, layoutConstant(constant)]));

const validityElements = new WeakMap();

function illegalConstructor() {
  throw new TypeError("Illegal constructor");
}

// The interface object ValidityState: script cannot construct one; each
// element has one, which reads the element's current flags.
export class ValidityState {
  constructor() {
    illegalConstructor();
  }
}
for (const [name, bit] of VALIDITY_FLAGS) {
  Object.defineProperty(ValidityState.prototype, name, {
    get() {
      const element = validityElements.get(this);
      if (element === undefined) throw new TypeError(`Illegal invocation: ${name} needs a ValidityState`);
      return (element._domCore.status("input_control_validity", element._coreHandle) & bit) !== 0;
    },
    enumerable: true,
    configurable: true,
  });
}
Object.defineProperty(ValidityState.prototype, Symbol.toStringTag, { value: "ValidityState", configurable: true });

const validityStates = new WeakMap();
function validityOf(element) {
  let state = validityStates.get(element);
  if (state === undefined) {
    state = Object.create(ValidityState.prototype);
    validityElements.set(state, element);
    validityStates.set(element, state);
  }
  return state;
}

const members = {
  willValidate: {
    get() {
      return this._domCore.status("input_control_will_validate", this._coreHandle) === 1;
    },
    enumerable: true,
    configurable: true,
  },
  validity: {
    get() {
      return validityOf(this);
    },
    enumerable: true,
    configurable: true,
  },
  validationMessage: {
    get() {
      return this._domCore.string("input_control_validation_message", this._coreHandle);
    },
    enumerable: true,
    configurable: true,
  },
  setCustomValidity: {
    value: function setCustomValidity(error) {
      if (arguments.length < 1) {
        throw new TypeError("Failed to execute 'setCustomValidity': 1 argument required, but only 0 present.");
      }
      this._domCore.status("input_control_custom_validity_set", this._coreHandle, ...this._domCore.input(String(error)));
    },
    writable: true,
    enumerable: true,
    configurable: true,
  },
};

// checkValidity() and reportValidity(), of the listed elements and of
// form.
const methods = {
  checkValidity: {
    value: function checkValidity() {
      return runValidation(this, INPUT_ACTIVATION_CHECK_VALIDITY);
    },
    writable: true,
    enumerable: true,
    configurable: true,
  },
  reportValidity: {
    value: function reportValidity() {
      return runValidation(this, INPUT_ACTIVATION_REPORT_VALIDITY);
    },
    writable: true,
    enumerable: true,
    configurable: true,
  },
};

// Installs the members on the prototypes of the listed elements, and the
// methods on the form prototype.
export function installConstraintValidationBindings(prototypes, formPrototype) {
  for (const prototype of prototypes) Object.defineProperties(prototype, { ...members, ...methods });
  Object.defineProperties(formPrototype, {
    ...methods,
    // [CEReactions] reset(): the form's reset
    // (core/dom/constraint-validation.watpart, "Form reset").
    reset: {
      value: function reset() {
        withCustomElementReactions(() => runInputActivation(this, INPUT_ACTIVATION_RESET), this._domCore);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
}

// Each form-associated member of ElementInternals throws
// "NotSupportedError" for an element that is not a form-associated custom
// element (HTML §4.13.7.4).
function formAssociatedHost(internals, member) {
  const host = internals._host;
  if (host._domCore.status("custom_form_associated", host._coreHandle) !== 1) {
    throw new DOMException(
      `Failed to execute '${member}' on 'ElementInternals': The target element is not a form-associated custom element.`,
      "NotSupportedError",
    );
  }
  return host;
}

// The FormData of the host realm, which Sandom's FormData extends.
const HostFormData = globalThis.FormData;

// A submission value or state: a File, a string, a FormData (its entries
// are copied) or null.
function submissionOf(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof HostFormData) return [...value];
  if (value instanceof File) return value;
  return String(value);
}

// The ValidityStateFlags of setValidity(), as the VALIDITY_* bits.
function validityFlagBits(flags) {
  if (flags !== undefined && flags !== null && typeof flags !== "object" && typeof flags !== "function") {
    throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': parameter 1 is not of type 'ValidityStateFlags'.");
  }
  let bits = 0;
  for (const [name, bit] of VALIDITY_FLAGS) {
    if (name !== "valid" && flags?.[name]) bits |= bit;
  }
  return bits;
}

// Whether `anchor` is a shadow-including inclusive descendant of `host`.
function shadowIncludingInclusiveDescendant(anchor, host) {
  for (let node = anchor; node !== null; node = nodeMember(node, "parentNode") ?? nodeMember(node, "host") ?? null) {
    if (node === host) return true;
  }
  return false;
}

// Installs the form-associated members of ElementInternals.
export function installElementInternalsFormBindings(prototype) {
  Object.defineProperties(prototype, {
    form: {
      get() {
        const host = formAssociatedHost(this, "form");
        return host._domCore.wrapperFor(host._domCore.handle("input_control_form", host._coreHandle));
      },
      enumerable: true,
      configurable: true,
    },
    labels: {
      get() {
        return elementLabels(formAssociatedHost(this, "labels"));
      },
      enumerable: true,
      configurable: true,
    },
    setFormValue: {
      value: function setFormValue(value, state = value) {
        if (arguments.length < 1) {
          throw new TypeError("Failed to execute 'setFormValue' on 'ElementInternals': 1 argument required, but only 0 present.");
        }
        const host = formAssociatedHost(this, "setFormValue");
        const submission = submissionOf(value);
        // The state is converted as Web IDL requires; Sandom restores no
        // form state, so formStateRestoreCallback never reads it.
        submissionOf(state);
        setSubmissionValue(host, submission);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    willValidate: {
      get() {
        return members.willValidate.get.call(formAssociatedHost(this, "willValidate"));
      },
      enumerable: true,
      configurable: true,
    },
    validity: {
      get() {
        return validityOf(formAssociatedHost(this, "validity"));
      },
      enumerable: true,
      configurable: true,
    },
    validationMessage: {
      get() {
        return members.validationMessage.get.call(formAssociatedHost(this, "validationMessage"));
      },
      enumerable: true,
      configurable: true,
    },
    setValidity: {
      value: function setValidity(flags = {}, message = undefined, anchor = undefined) {
        const host = formAssociatedHost(this, "setValidity");
        const bits = validityFlagBits(flags);
        const text = message === undefined ? "" : String(message);
        if (bits !== 0 && text === "") {
          throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': The second argument should not be empty if one or more flags are true.");
        }
        if (anchor !== undefined && anchor !== null) {
          if (anchor?._domCore !== host._domCore || nodeMember(anchor, "nodeType") !== 1 ||
            nodeMember(anchor, "namespaceURI") !== "http://www.w3.org/1999/xhtml") {
            throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': parameter 3 is not of type 'HTMLElement'.");
          }
          if (!shadowIncludingInclusiveDescendant(anchor, host)) {
            throw new DOMException(
              "Failed to execute 'setValidity' on 'ElementInternals': The validation anchor is not a shadow-including inclusive descendant of the element.",
              "NotFoundError",
            );
          }
        }
        const core = host._domCore;
        core.status("custom_internals_validity_set", host._coreHandle, bits, ...core.input(text), anchor?._coreHandle ?? 0n);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    checkValidity: {
      value: function checkValidity() {
        return runValidation(formAssociatedHost(this, "checkValidity"), INPUT_ACTIVATION_CHECK_VALIDITY);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    reportValidity: {
      value: function reportValidity() {
        return runValidation(formAssociatedHost(this, "reportValidity"), INPUT_ACTIVATION_REPORT_VALIDITY);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
}
