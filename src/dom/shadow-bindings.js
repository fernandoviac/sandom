import { DomCore, domCoreForWrapper, sharedDomCore } from "../dom-wasm/core.js";
import {
  installShadowCloneBindings,
  installShadowElementBindings,
  installElementInternalsBindings,
  installSlotBindings,
} from "./dom-bindings.generated.js";

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
        case 1: {
          const mode = argument?.mode;
          fact = mode === "open" ? 1 : mode === "closed" ? 2 : 0;
          break;
        }
        case 2:
          fact = Number(Boolean(node._shadowRoot));
          break;
        case 3:
          fact = Number(node.namespaceURI === runtime.HTML_NS);
          break;
        case 4: {
          const assignment = argument.slotAssignment ?? "named";
          fact = assignment === "named" ? 1 : assignment === "manual" ? 2 : 0;
          break;
        }
        case 5: {
          const name = node.localName;
          fact = core.status(
            "shadow_binding_host_name",
            ...core.input(typeof name === "string" ? name : ""),
          );
          break;
        }
        case 6: {
          const name = node.localName;
          const callee = name.includes;
          fact = typeof name === "string" && callee === nativeIncludes
            ? core.status("shadow_binding_hyphen", ...core.input(name))
            : Number(Boolean(Reflect.apply(callee, name, ["-"])));
          break;
        }
        case 7:
          fact = Number(Boolean(argument.delegatesFocus));
          break;
        case 8:
          fact = Number(Boolean(argument.clonable));
          break;
        case 9: {
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
        case 10:
          result = node._domCore.wrapperFor(created);
          node._domCore.callbackRecords();
          break;
        case 11:
          result._renderSurface = node._renderSurface;
          break;
        case 12:
          node._notifyMutation("structure");
          break;
        case 20:
          fact = Number(Boolean(node.clonable));
          break;
        case 21:
          result = new runtime.SDDocumentFragment(node.ownerDocument);
          break;
        case 22:
          fact = Number(Boolean(argument));
          break;
        case 23:
          iterator = node.childNodes[Symbol.iterator]();
          if (Object(iterator) !== iterator) {
            throw new TypeError("Iterator is not an object");
          }
          next = iterator.next;
          break;
        case 24: {
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
        case 25:
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
      core.status("shadow_binding_ack", invocation, token, -1);
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
          1,
          mode === "open" ? 1 : mode === "closed" ? 2 : 0,
        )
        ? node._shadowRoot
        : null;
    },
    attachShadow(node, options) {
      return runShadowActions(node, 1, options, runtime);
    },
    assign(node, nodes) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      const name = node.localName;
      const slot = core.status("shadow_binding_slot_name", ...core.input(typeof name === "string" ? name : ""));
      core.status("shadow_binding_decide", 2, slot);
      node._domCore.slotAssign(
        node._coreHandle,
        nodes.map((value) => runtime.ensureNode(value)._coreHandle),
      );
      node._domCore.callbackRecords();
    },
    assignedNodes(node) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      const name = node.localName;
      const slot = core.status("shadow_binding_slot_name", ...core.input(typeof name === "string" ? name : ""));
      return core.status("shadow_binding_decide", 3, slot)
        ? node._domCore.assignedNodes(node._coreHandle)
        : [];
    },
    assignedElements(node, options) {
      const core = domCoreForWrapper(node) ?? sharedDomCore;
      return node.assignedNodes(options).filter((value) => {
        const type = value.nodeType;
        return Boolean(core.status("shadow_binding_decide", 4, typeof type === "number" ? type : NaN));
      });
    },
  };
  installShadowElementBindings(bindingRuntime, prototypes.element);
  installSlotBindings(bindingRuntime, prototypes.slot);
  installElementInternalsBindings({ ElementInternals: runtime.ElementInternals }, prototypes.htmlElement);
  installShadowCloneBindings({
    cloneNode(node, deep) {
      return runShadowActions(node, 2, deep, runtime);
    },
  }, prototypes.shadow);
}
