import { DomCore, domCoreForWrapper, sharedDomCore } from "../dom-wasm/core.js";
import {
  installShadowCloneBindings,
  installShadowElementBindings,
  installElementInternalsBindings,
  installSlotBindings,
} from "./dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The codes that this file passes to WAT, by the names of their WAT
// globals.
const SHADOW_BINDING_ATTACH = layoutConstant("SHADOW_BINDING_ATTACH");
const SHADOW_BINDING_CLONE = layoutConstant("SHADOW_BINDING_CLONE");
const SHADOW_BINDING_THREW = layoutConstant("SHADOW_BINDING_THREW");
const SHADOW_MODES = new Map([["open", layoutConstant("SHADOW_MODE_OPEN")], ["closed", layoutConstant("SHADOW_MODE_CLOSED")]]);
const SHADOW_SLOTS = new Map([["named", layoutConstant("SHADOW_SLOTS_NAMED")], ["manual", layoutConstant("SHADOW_SLOTS_MANUAL")]]);
const SHADOW_DECIDE_VISIBLE = layoutConstant("SHADOW_DECIDE_VISIBLE");
const SHADOW_DECIDE_ASSIGN = layoutConstant("SHADOW_DECIDE_ASSIGN");
const SHADOW_DECIDE_ASSIGNED_NODES = layoutConstant("SHADOW_DECIDE_ASSIGNED_NODES");
const CALLBACK_EFFECT_RESTYLE = layoutConstant("CALLBACK_EFFECT_RESTYLE");
const SHADOW_DECIDE_ELEMENT = layoutConstant("SHADOW_DECIDE_ELEMENT");
const SHADOW_STAGE = Object.freeze(Object.fromEntries([
  "MODE", "HOSTS_ROOT", "HTML_NAMESPACE", "SLOT_ASSIGNMENT", "HOST_NAME", "CUSTOM_NAME", "DELEGATES_FOCUS", "CLONABLE",
  "CREATE", "WRAP", "SURFACE", "NOTIFY", "CLONE_CHECK", "CLONE_FRAGMENT", "CLONE_DEEP", "CHILD_ITERATOR", "CHILD_STEP",
  "CHILD_APPEND",
].map((name) => [name, layoutConstant(`SHADOW_STAGE_${name}`)])));

const nativeCreateShadowRoot = DomCore.prototype.createShadowRoot;
const nativeIncludes = String.prototype.includes;

// Only JS values, property/callee access, IteratorClose, and wrapper identity
// live here. Kind76 selects every branch and claims every language action.
function runShadowActions(node, kind, argument, runtime) {
  const core = domCoreForWrapper(node) ?? sharedDomCore;
  const invocation = core.handle(
    "shadow_binding_begin",
    0n,
    kind,
  );
  let token = 0n;
  let result;
  let created;
  let iterator;
  let next;
  let child;
  let closeOnError = false;
  try {
    while ((token = core.handle("shadow_binding_next", invocation)) !== 0n) {
      const action = core.status("shadow_binding_action", invocation, token);
      let fact = 0;
      switch (action) {
        case SHADOW_STAGE.MODE: {
          const mode = argument?.mode;
          fact = SHADOW_MODES.get(mode) ?? 0;
          break;
        }
        case SHADOW_STAGE.HOSTS_ROOT:
          fact = Number(Boolean(node._shadowRoot));
          break;
        case SHADOW_STAGE.HTML_NAMESPACE:
          fact = Number(node.namespaceURI === runtime.HTML_NS);
          break;
        case SHADOW_STAGE.SLOT_ASSIGNMENT: {
          const assignment = argument.slotAssignment ?? "named";
          fact = SHADOW_SLOTS.get(assignment) ?? 0;
          break;
        }
        case SHADOW_STAGE.HOST_NAME: {
          const name = node.localName;
          fact = core.status(
            "shadow_binding_host_name",
            ...core.input(typeof name === "string" ? name : ""),
          );
          break;
        }
        case SHADOW_STAGE.CUSTOM_NAME: {
          const name = node.localName;
          const callee = name.includes;
          fact = typeof name === "string" && callee === nativeIncludes
            ? core.status("shadow_binding_hyphen", ...core.input(name))
            : Number(Boolean(Reflect.apply(callee, name, ["-"])));
          break;
        }
        case SHADOW_STAGE.DELEGATES_FOCUS:
          fact = Number(Boolean(argument.delegatesFocus));
          break;
        case SHADOW_STAGE.CLONABLE:
          fact = Number(Boolean(argument.clonable));
          break;
        case SHADOW_STAGE.CREATE: {
          const receiver = node._domCore;
          const callee = receiver.createShadowRoot;
          const host = node._coreHandle;
          const flags = core.status("shadow_binding_flags", invocation, token);
          // Selecting a captured built-in versus an authored callee is language
          // identity dispatch, not a second implementation of shadow policy.
          created = receiver === core && callee === nativeCreateShadowRoot
            ? core.handle("shadow_binding_create", invocation, token, host)
            : Reflect.apply(callee, receiver, [host, flags]);
          break;
        }
        case SHADOW_STAGE.WRAP:
          result = node._domCore.wrapperFor(created);
          node._domCore.callbackRecords();
          break;
        case SHADOW_STAGE.SURFACE:
          result._renderSurface = node._renderSurface;
          break;
        case SHADOW_STAGE.NOTIFY:
          node._notifyMutation("structure", undefined, null, CALLBACK_EFFECT_RESTYLE);
          break;
        case SHADOW_STAGE.CLONE_CHECK:
          fact = Number(Boolean(node.clonable));
          break;
        case SHADOW_STAGE.CLONE_FRAGMENT:
          result = new runtime.SDDocumentFragment(node.ownerDocument);
          break;
        case SHADOW_STAGE.CLONE_DEEP:
          fact = Number(Boolean(argument));
          break;
        case SHADOW_STAGE.CHILD_ITERATOR:
          iterator = node.childNodes[Symbol.iterator]();
          if (Object(iterator) !== iterator) {
            throw new TypeError("Iterator is not an object");
          }
          next = iterator.next;
          break;
        case SHADOW_STAGE.CHILD_STEP: {
          // IteratorStep/IteratorValue failures do not close a for-of iterator.
          closeOnError = false;
          const step = Reflect.apply(next, iterator, []);
          if (Object(step) !== step) {
            throw new TypeError("Iterator result is not an object");
          }
          fact = Number(Boolean(step.done));
          if (!fact) {
            child = step.value;
            closeOnError = true;
          }
          break;
        }
        case SHADOW_STAGE.CHILD_APPEND:
          // Member callee evaluation precedes the child clone call, exactly as
          // in the source for-of body. Authored overrides are never bypassed.
          result.appendChild(child.cloneNode(true));
          break;
        default:
          throw new Error(`Unknown shadow language action ${action}`);
      }
      const completed = token;
      token = 0n;
      core.status("shadow_binding_ack", invocation, completed, fact);
    }
    return result;
  } catch (error) {
    if (closeOnError) {
      try {
        // On abrupt completion IteratorClose preserves the original exception,
        // including when return's getter/call or result validation would fail.
        iterator.return?.();
      } catch {
        // Preserve the original abrupt completion.
      }
    }
    if (token !== 0n) {
      core.status("shadow_binding_ack", invocation, token, SHADOW_BINDING_THREW);
      token = 0n;
    }
    throw error;
  } finally {
    core.status("shadow_binding_release", invocation);
  }
}

export function installShadowBindings(prototypes, runtime) {
  const bindingRuntime = {
    shadowRoot(node) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      const mode = node._shadowRoot?.mode;
      return core.status(
          "shadow_binding_decide",
          SHADOW_DECIDE_VISIBLE,
          SHADOW_MODES.get(mode) ?? 0,
        )
        ? node._shadowRoot
        : null;
    },
    attachShadow(node, options) {
      return runShadowActions(node, SHADOW_BINDING_ATTACH, options, runtime);
    },
    assign(node, nodes) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      const name = node.localName;
      const slot = core.status("shadow_binding_slot_name", ...core.input(typeof name === "string" ? name : ""));
      core.status("shadow_binding_decide", SHADOW_DECIDE_ASSIGN, slot);
      node._domCore.slotAssign(
        node._coreHandle,
        nodes.map((value) => runtime.ensureNode(value)._coreHandle),
      );
      node._domCore.callbackRecords();
    },
    // AssignedNodesOptions (HTML): a dictionary; undefined and null are
    // empty, another primitive fails the WebIDL conversion.
    assignedNodes(node, options) {
      if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") {
        throw new TypeError(`assignedNodes options must be a dictionary, got ${typeof options}`);
      }
      const flatten = options === undefined || options === null ? false : Boolean(options.flatten);
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      const name = node.localName;
      const slot = core.status("shadow_binding_slot_name", ...core.input(typeof name === "string" ? name : ""));
      return core.status("shadow_binding_decide", SHADOW_DECIDE_ASSIGNED_NODES, slot)
        ? node._domCore.assignedNodes(node._coreHandle, flatten)
        : [];
    },
    assignedElements(node, options) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      return node.assignedNodes(options).filter((value) => {
        const type = value.nodeType;
        return Boolean(core.status("shadow_binding_decide", SHADOW_DECIDE_ELEMENT, typeof type === "number" ? type : NaN));
      });
    },
  };
  installShadowElementBindings(bindingRuntime, prototypes.element);
  installSlotBindings(bindingRuntime, prototypes.slot);
  installElementInternalsBindings({ ElementInternals: runtime.ElementInternals }, prototypes.htmlElement);
  installShadowCloneBindings({
    cloneNode(node, deep) {
      return runShadowActions(node, SHADOW_BINDING_CLONE, deep, runtime);
    },
  }, prototypes.shadow);
}
