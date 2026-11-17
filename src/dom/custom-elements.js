import { registerCustomElementReactionRunner, sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { enterComponentCode } from "./component-code.js";
import {
  createCustomElementRegistryBinding,
  createCustomStateSetBinding,
  createElementInternalsBinding,
} from "./dom-bindings.generated.js";

// The codes that this file passes to or reads from WAT, by the names of
// their WAT globals.
const CUSTOM_ELEMENT_STATES = new Map([
  [layoutConstant("CUSTOM_ELEMENT_PRECUSTOMIZED"), "precustomized"],
  [layoutConstant("CUSTOM_ELEMENT_CUSTOM"), "custom"],
  [layoutConstant("CUSTOM_ELEMENT_FAILED"), "failed"],
]);
const CUSTOM_REACTION_REPORT = layoutConstant("CUSTOM_REACTION_REPORT");
const CUSTOM_REACTION_CONNECTED = layoutConstant("CUSTOM_REACTION_CONNECTED");
const CUSTOM_REACTION_DISCONNECTED = layoutConstant("CUSTOM_REACTION_DISCONNECTED");
const CUSTOM_REACTION_ATTRIBUTE_CHANGED = layoutConstant("CUSTOM_REACTION_ATTRIBUTE_CHANGED");
const CUSTOM_REACTION_ADOPTED = layoutConstant("CUSTOM_REACTION_ADOPTED");
// The callbacks of form-associated custom elements
// (core/dom/constraint-validation.watpart).
const CUSTOM_REACTION_FORM_ASSOCIATED = layoutConstant("CUSTOM_REACTION_FORM_ASSOCIATED");
const CUSTOM_REACTION_FORM_DISABLED = layoutConstant("CUSTOM_REACTION_FORM_DISABLED");
const CUSTOM_REACTION_FORM_ENABLED = layoutConstant("CUSTOM_REACTION_FORM_ENABLED");
const CUSTOM_REACTION_FORM_RESET = layoutConstant("CUSTOM_REACTION_FORM_RESET");
const CUSTOM_REACTION_UPGRADE = layoutConstant("CUSTOM_REACTION_UPGRADE");
const CUSTOM_REACTION_CONNECTED_MOVE = layoutConstant("CUSTOM_REACTION_CONNECTED_MOVE");
const CUSTOM_STATE_CHANGED = layoutConstant("CUSTOM_STATE_CHANGED");
const CUSTOM_INTERNALS_STRING = layoutConstant("CUSTOM_INTERNALS_STRING");
const CUSTOM_INTERNALS_ELEMENTS = layoutConstant("CUSTOM_INTERNALS_ELEMENTS");
const SHADOW_ROOT_AVAILABLE_TO_INTERNALS = layoutConstant("SHADOW_ROOT_AVAILABLE_TO_INTERNALS");
const CUSTOM_CONSTRUCTION_STATES = new Map([
  [layoutConstant("CUSTOM_CONSTRUCTION_UNCLAIMED"), "unclaimed"],
  [layoutConstant("CUSTOM_CONSTRUCTION_CLAIMED"), "claimed"],
  [layoutConstant("CUSTOM_CONSTRUCTION_COMPLETED"), "completed"],
  [layoutConstant("CUSTOM_CONSTRUCTION_ABORTED"), "aborted"],
]);
const CUSTOM_HOST_QUEUE_ACTIVE = layoutConstant("CUSTOM_HOST_QUEUE_ACTIVE");
const CUSTOM_HOST_UNFINISHED_CONSTRUCTIONS = layoutConstant("CUSTOM_HOST_UNFINISHED_CONSTRUCTIONS");
const CUSTOM_HOST_PENDING_REACTIONS = layoutConstant("CUSTOM_HOST_PENDING_REACTIONS");
const CUSTOM_HOST_CONTEXT_GENERATION = layoutConstant("CUSTOM_HOST_CONTEXT_GENERATION");
const CUSTOM_OUTCOME_CONSTRUCTED = layoutConstant("CUSTOM_OUTCOME_CONSTRUCTED");
const CUSTOM_OUTCOME_THREW = layoutConstant("CUSTOM_OUTCOME_THREW");
const CUSTOM_OUTCOME_OTHER_OBJECT = layoutConstant("CUSTOM_OUTCOME_OTHER_OBJECT");
const CUSTOM_CONSTRUCTION_DEFINED = layoutConstant("CUSTOM_CONSTRUCTION_DEFINED");
const CUSTOM_CONSTRUCTION_FAILED_RESET = layoutConstant("CUSTOM_CONSTRUCTION_FAILED_RESET");
const CUSTOM_CONSTRUCTION_NOT_SUPPORTED = layoutConstant("CUSTOM_CONSTRUCTION_NOT_SUPPORTED");
const CUSTOM_CONSTRUCTION_INVALID_ELEMENT = layoutConstant("CUSTOM_CONSTRUCTION_INVALID_ELEMENT");
const CUSTOM_CONSTRUCTION_RESETS = new Set([
  CUSTOM_CONSTRUCTION_FAILED_RESET, CUSTOM_CONSTRUCTION_NOT_SUPPORTED, CUSTOM_CONSTRUCTION_INVALID_ELEMENT,
]);
const CUSTOM_RETURN_COMPLETED = layoutConstant("CUSTOM_RETURN_COMPLETED");
const CUSTOM_RETURN_FINISHED = layoutConstant("CUSTOM_RETURN_FINISHED");
const CUSTOM_RETURN_FINISHED_FAILED = layoutConstant("CUSTOM_RETURN_FINISHED_FAILED");

const constructors = new WeakMap();
const constructorCores = new WeakMap();
const coreStates = new WeakMap();
const contexts = new WeakMap();
const constructions = new WeakMap();
let constructionCore = sharedDomCore;
let nextConstructor = 1;

function coreState(core) {
  let state = coreStates.get(core);
  if (!state) {
    state = {
      definitions: new Map(),
      constructionObjects: new Map(),
      contextObjects: new Map(),
      hostWaiters: new Map(),
    };
    coreStates.set(core, state);
  }
  return state;
}

function requireCore(core, owner) {
  if (owner && owner._domCore !== core) {
    throw new DOMException(
      "Custom element objects must belong to the same DOM core",
      "NotSupportedError",
    );
  }
}

function definitionId(core, definition) {
  requireCore(core, definition?.registry);
  return definition?.id ?? 0;
}

function constructionBinding(token, registry) {
  const binding = constructions.get(token);
  requireCore(registry._domCore, binding?.registry);
  return binding;
}

function constructorIdentity(constructor) {
  let id = constructors.get(constructor);
  if (id === undefined) {
    id = nextConstructor++;
    constructors.set(constructor, id);
  }
  return id;
}

function contextHandle(context, core) {
  requireCore(core, context?.registry);
  return contexts.get(context) ?? 0n;
}

function definitionText(core, id, field) {
  return core.string("custom_definition_text", id, field);
}

export function constructHTMLElement(constructor, interfaceConstructor, autonomous = false) {
  const core = constructorCores.get(constructor) ?? constructionCore;
  const definition = core.status(
    "custom_html_constructor_prepare",
    constructors.get(constructor) ?? 0,
    constructorIdentity(interfaceConstructor),
    autonomous ? 1 : 0,
  );
  const requestedPrototype = constructor.prototype;
  const prototype = requestedPrototype !== null &&
      (typeof requestedPrototype === "object" || typeof requestedPrototype === "function")
    ? requestedPrototype : interfaceConstructor.prototype;
  const handle = core.handle("custom_html_constructor_create", definition);
  try {
    const element = core.wrapperFor(handle);
    Object.setPrototypeOf(element, prototype);
    core.status("custom_html_constructor_finish", definition, handle);
    return element;
  } finally {
    core.status("node_release", handle);
  }
}

export function customElementState(element) {
  const core = element._domCore;
  return CUSTOM_ELEMENT_STATES.get(core.status("custom_element_state", element._coreHandle)) ?? null;
}

export function customElementDefinition(element) {
  const core = element?._domCore;
  const definitions = core ? coreState(core).definitions : null;
  return element?._coreHandle === undefined ? null : definitions.get(
    core.status("custom_element_definition", element._coreHandle, false),
  ) ?? null;
}

// The reaction and custom state records of custom-elements.watpart, by WAT
// name without the CUSTOM_ prefix.
const CUSTOM = Object.freeze(Object.fromEntries([
  "REACTION_ELEMENT", "REACTION_DEFINITION", "REACTION_KIND", "REACTION_NAME", "REACTION_OLD_VALUE",
  "REACTION_NEW_VALUE", "REACTION_OLD_DOCUMENT", "REACTION_NEW_DOCUMENT", "STRING_POINTER", "STRING_LENGTH",
  "STATE_LENGTH", "STATE_SERIAL", "STATE_NAME",
].map((name) => [name, layoutConstant(`CUSTOM_${name}`)])));

function nextReaction(core, handle, registry) {
  const { definitions } = coreState(core);
  const pointer = core.status("custom_reaction_next", handle, registry);
  if (!pointer) return null;
  const token = core.handle("custom_reaction_token", handle, registry);
  const view = new DataView(core.refreshBytes().buffer);
  const string = (field) => {
    const length = view.getInt32(pointer + field + CUSTOM.STRING_LENGTH, true);
    if (length === -1) return null;
    const start = view.getUint32(pointer + field + CUSTOM.STRING_POINTER, true);
    return core.decoder.decode(core.bytes.subarray(start, start + length));
  };
  // Decode the complete owned invocation before crossing into authored code.
  const elementHandle = view.getBigUint64(pointer + CUSTOM.REACTION_ELEMENT, true);
  const definition = definitions.get(view.getUint32(pointer + CUSTOM.REACTION_DEFINITION, true));
  const kind = view.getUint32(pointer + CUSTOM.REACTION_KIND, true);
  const name = string(CUSTOM.REACTION_NAME);
  const oldValue = string(CUSTOM.REACTION_OLD_VALUE);
  const newValue = string(CUSTOM.REACTION_NEW_VALUE);
  const oldDocument = view.getBigUint64(pointer + CUSTOM.REACTION_OLD_DOCUMENT, true);
  const newDocument = view.getBigUint64(pointer + CUSTOM.REACTION_NEW_DOCUMENT, true);
  const element = core.wrapperFor(elementHandle);
  return {
    token,
    definition,
    element,
    kind,
    argumentsList: kind === CUSTOM_REACTION_ATTRIBUTE_CHANGED
      ? [name, oldValue, newValue]
      : kind === CUSTOM_REACTION_ADOPTED
      ? [core.wrapperFor(oldDocument), core.wrapperFor(newDocument)]
      : kind === CUSTOM_REACTION_FORM_ASSOCIATED
      ? [core.wrapperFor(newDocument)]
      : kind === CUSTOM_REACTION_FORM_DISABLED || kind === CUSTOM_REACTION_FORM_ENABLED
      ? [kind === CUSTOM_REACTION_FORM_DISABLED]
      : [],
  };
}

// The lifecycle callback of each callback reaction kind.
const callbackNames = new Map([
  [CUSTOM_REACTION_CONNECTED, "connectedCallback"],
  [CUSTOM_REACTION_DISCONNECTED, "disconnectedCallback"],
  [CUSTOM_REACTION_ATTRIBUTE_CHANGED, "attributeChangedCallback"],
  [CUSTOM_REACTION_ADOPTED, "adoptedCallback"],
  [CUSTOM_REACTION_CONNECTED_MOVE, "connectedMoveCallback"],
  [CUSTOM_REACTION_FORM_ASSOCIATED, "formAssociatedCallback"],
  [CUSTOM_REACTION_FORM_DISABLED, "formDisabledCallback"],
  [CUSTOM_REACTION_FORM_ENABLED, "formDisabledCallback"],
  [CUSTOM_REACTION_FORM_RESET, "formResetCallback"],
]);

// Runs a reaction as component code of its element's document.
function invokeReaction(reaction, context = null) {
  return enterComponentCode(reaction.element?.ownerDocument, runReaction, null, [reaction, context]);
}

function runReaction(reaction, context) {
  const { definition, element, kind, argumentsList } = reaction;
  if (kind === CUSTOM_REACTION_UPGRADE) {
    return definition.host
      ? definition.registry._constructHostElement(
        element.ownerDocument,
        definition,
        context,
        element,
      )
      : definition.registry._upgradeElement(element, definition);
  }
  const name = callbackNames.get(kind);
  const callbackOf = (callbackName) => definition.host ? definition.callbacks[callbackName] : element[callbackName];
  const call = (callback) => definition.host
    ? callback(element, ...argumentsList, context, definition.participant)
    : callback.apply(element, argumentsList);
  const callback = callbackOf(name);
  if (typeof callback === "function") return call(callback);
  // HTML "enqueue a custom element callback reaction": without
  // connectedMoveCallback, a move runs disconnectedCallback and then
  // connectedCallback as two reactions; an exception in the first is
  // reported and the second still runs.
  if (kind !== CUSTOM_REACTION_CONNECTED_MOVE) return;
  const disconnected = callbackOf("disconnectedCallback");
  if (typeof disconnected === "function") {
    try {
      call(disconnected);
    } catch (error) {
      definition.registry._reportException(error);
    }
  }
  const connected = callbackOf("connectedCallback");
  if (typeof connected === "function") return call(connected);
}

function completeReaction(core, handle, registry, reaction, error) {
  const result = core.status(
    "custom_reaction_complete",
    handle,
    registry,
    reaction.token,
    error !== undefined,
  );
  if (result === CUSTOM_REACTION_REPORT) reaction.definition.registry._reportException(error.error);
}

export function withCustomElementReactions(operation, core = sharedDomCore) {
  const handle = core.handle("custom_reactions_begin");
  try {
    return operation();
  } finally {
    runCustomElementReactions(core, handle);
  }
}

// Runs the reactions of scope `handle` and ends it: a host scope, or the
// backup element queue (custom_reactions_backup_begin).
export function runCustomElementReactions(core, handle) {
  // custom_reactions_finish ends a scope with no queued reaction.
  if (core.status("custom_reactions_finish", handle) === 0) return;
  try {
    for (let reaction; (reaction = nextReaction(core, handle, 0));) {
      let failure;
      try {
        // A callback's own mutations are [CEReactions] steps of their own:
        // their reactions run when the callback returns.
        withCustomElementReactions(() => invokeReaction(reaction), core);
      } catch (error) {
        failure = { error };
      }
      completeReaction(core, handle, 0, reaction, failure);
    }
  } finally {
    core.status("custom_reactions_end", handle, 0);
  }
}
registerCustomElementReactionRunner(runCustomElementReactions);

class CustomStateSetRuntime extends Set {
  constructor(host) {
    super();
    this._host = host;
  }
  _bindingSize() {
    const core = this._host._domCore;
    return core.status("custom_state_count", this._host._coreHandle);
  }
  _bindingHas(value) {
    const core = this._host._domCore;
    return core.status(
      "custom_state_has",
      this._host._coreHandle,
      ...core.input(value),
    ) !== 0;
  }
  _bindingAdd(state) {
    const core = this._host._domCore;
    const result = core.status(
      "custom_state_set",
      this._host._coreHandle,
      ...core.input(state),
      true,
    );
    if (result === CUSTOM_STATE_CHANGED) {
      this._host._notifyMutation("state", state);
    }
    return this;
  }
  _bindingDelete(state) {
    const core = this._host._domCore;
    const result = core.status(
      "custom_state_set",
      this._host._coreHandle,
      ...core.input(state),
      false,
    );
    if (result !== CUSTOM_STATE_CHANGED) return false;
    this._host._notifyMutation("state", state);
    return true;
  }
  _bindingClear() {
    const core = this._host._domCore;
    const changed = core.status("custom_states_clear", this._host._coreHandle);
    if (changed) this._host._notifyMutation("state");
  }
  *_bindingValues() {
    const core = this._host._domCore;
    let serial = 0n;
    for (;;) {
      const pointer = core.status(
        "custom_state_after",
        this._host._coreHandle,
        serial,
      );
      if (!pointer) return;
      const view = new DataView(core.refreshBytes().buffer);
      serial = view.getBigUint64(pointer + CUSTOM.STATE_SERIAL, true);
      const length = view.getUint32(pointer + CUSTOM.STATE_LENGTH, true);
      yield core.decoder.decode(
        core.bytes.subarray(pointer + CUSTOM.STATE_NAME, pointer + CUSTOM.STATE_NAME + length),
      );
    }
  }
  *_bindingEntries() {
    for (const value of this._bindingValues()) yield [value, value];
  }
  _bindingForEach(callback, thisArgument) {
    for (const value of this._bindingValues()) {
      callback.call(thisArgument, value, value, this);
    }
  }
}

// An element that an element reference of `host` may name (WAI-ARIA, "ARIA
// reflection"; HTML, "attr-associated element"): one in the tree of `host`
// or in the tree of one of its shadow-including ancestors.
function referenceVisible(host, candidate) {
  const candidateRoot = candidate.getRootNode();
  for (let root = host.getRootNode(); root; root = root.host?.getRootNode() ?? null) {
    if (root === candidateRoot) return true;
  }
  return false;
}

function requireElement(core, value, member) {
  if (value?.nodeType !== 1) {
    throw new TypeError(`ElementInternals ${member} takes Element values, not ${value === null ? "null" : typeof value}`);
  }
  requireCore(core, value);
  return value;
}

// ElementInternals (HTML) with the ARIA reflection members of WAI-ARIA.
// Each value is the element's default ARIA semantics: the DOM core keeps it
// under the content attribute it stands below ("role", "aria-checked"),
// and the accessibility snapshot reads it when the element has no such
// attribute (geometry-accessibility.watpart $a11yAttribute).
class ElementInternalsRuntime {
  constructor(host) {
    host._domCore.status("custom_internals_attach", host._coreHandle);
    this._host = host;
    this._elementLists = new Map();
    this.states = new CustomStateSet(host);
  }
  _reflectionRead(name) {
    const core = this._host._domCore;
    const type = core.status("custom_internals_get", this._host._coreHandle, ...core.input(name));
    if (type === CUSTOM_INTERNALS_STRING) return core.outputString();
    if (type !== CUSTOM_INTERNALS_ELEMENTS) return null;
    const pointer = core.exports.abi_output_pointer();
    const count = core.exports.abi_output_length() / BigUint64Array.BYTES_PER_ELEMENT;
    const view = new DataView(core.refreshBytes().buffer);
    return Array.from({ length: count }, (_, index) =>
      core.wrapperFor(view.getBigUint64(pointer + index * BigUint64Array.BYTES_PER_ELEMENT, true)));
  }
  _reflectionWrite(name, value, type) {
    const host = this._host;
    const core = host._domCore;
    if (type === CUSTOM_INTERNALS_ELEMENTS) {
      // abi_allocate input is transient: the next operations release it.
      const length = value.length * BigUint64Array.BYTES_PER_ELEMENT;
      const pointer = core.exports.abi_allocate(length);
      const view = new DataView(core.refreshBytes().buffer);
      value.forEach((element, index) =>
        view.setBigUint64(pointer + index * BigUint64Array.BYTES_PER_ELEMENT, element._coreHandle, true));
      core.status("custom_internals_set", host._coreHandle, ...core.input(name), pointer, length, type);
    } else {
      core.status("custom_internals_set", host._coreHandle, ...core.input(name), ...core.input(value ?? ""), type);
    }
    host._notifyMutation("state", name);
  }
  _reflectionGet(name) {
    return this._reflectionRead(name);
  }
  _reflectionSet(name, value) {
    this._reflectionWrite(name, value, value === null ? 0 : CUSTOM_INTERNALS_STRING);
  }
  _reflectionElementGet(name) {
    const [element = null] = this._reflectionRead(name) ?? [];
    return element !== null && referenceVisible(this._host, element) ? element : null;
  }
  _reflectionElementSet(name, value) {
    if (value === null || value === undefined) {
      this._reflectionWrite(name, null, 0);
      return;
    }
    this._reflectionWrite(name, [requireElement(this._host._domCore, value, name)], CUSTOM_INTERNALS_ELEMENTS);
  }
  // A FrozenArray that stays the same object while its elements do not
  // change ("cached attr-associated elements").
  _reflectionElementsGet(name) {
    const stored = this._reflectionRead(name);
    if (stored === null) {
      this._elementLists.delete(name);
      return null;
    }
    const elements = stored.filter((element) => referenceVisible(this._host, element));
    const cached = this._elementLists.get(name);
    if (cached?.length === elements.length && cached.every((element, index) => element === elements[index])) return cached;
    const frozen = Object.freeze(elements);
    this._elementLists.set(name, frozen);
    return frozen;
  }
  _reflectionElementsSet(name, value) {
    if (value === null || value === undefined) {
      this._reflectionWrite(name, null, 0);
      return;
    }
    if (typeof value?.[Symbol.iterator] !== "function") {
      throw new TypeError(`ElementInternals ${name} takes a sequence of Element values`);
    }
    const core = this._host._domCore;
    this._reflectionWrite(name, [...value].map((element) => requireElement(core, element, name)), CUSTOM_INTERNALS_ELEMENTS);
  }
  // HTML: the host's shadow root when it is available to element internals
  // (DOM): attachShadow() while the host is precustomized or custom, or a
  // declarative shadow root.
  _shadowRoot() {
    const shadow = this._host._shadowRoot;
    if (!shadow) return null;
    const flags = shadow._domCore.status("node_flags", shadow._coreHandle);
    return (flags & SHADOW_ROOT_AVAILABLE_TO_INTERNALS) !== 0 ? shadow : null;
  }
}

function tokenState(token) {
  const binding = constructions.get(token);
  const core = binding.registry._domCore;
  if (binding.terminal !== undefined) return binding.terminal;
  return CUSTOM_CONSTRUCTION_STATES.get(core.status(
    "custom_construction_state",
    binding.handle,
    binding.registry._coreRegistry,
    contextHandle(binding.context, core),
  ));
}

// A failed construction that restores the element's original prototype
// (CUSTOM_CONSTRUCTION_RESETS) drops its internals.
function applyConstructionResult(binding, result) {
  if (CUSTOM_CONSTRUCTION_RESETS.has(result)) {
    binding.element._internals = null;
    Object.setPrototypeOf(binding.element, binding.originalPrototype);
  }
  binding.element._dispatchCoreTreeRecords();
  binding.element._notifyMutation("state", "defined");
}

// A collected registry releases its native registry. A definition holds
// its registry, so only a registry without definitions is collected.
const nativeRegistryFinalizer = new FinalizationRegistry(({ coreReference, id }) => {
  coreReference.deref()?.status("custom_registry_release", id);
});

class CustomElementRegistryRuntime {
  constructor({
    core = sharedDomCore,
    supportedBuiltIns = new Map(),
    reportException = globalThis.reportError?.bind(globalThis),
  } = {}) {
    this._domCore = core;
    // The native registry, made on first use (`_coreRegistry`): a document
    // without a browsing context finds no definition and needs none.
    this._nativeRegistry = 0;
    this._supportedBuiltIns = supportedBuiltIns;
    this._waiting = new Map();
    this._reportException = reportException ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
  }

  get _coreRegistry() {
    if (this._nativeRegistry !== 0) return this._nativeRegistry;
    const core = this._domCore;
    const id = core.status("custom_registry_create");
    nativeRegistryFinalizer.register(this, { coreReference: new WeakRef(core), id });
    this._nativeRegistry = id;
    for (const [name, interfaceConstructor] of this._supportedBuiltIns) {
      core.status("custom_registry_builtin", id, ...core.input(name), constructorIdentity(interfaceConstructor));
    }
    return id;
  }

  _registerDocument(document) {
    const core = this._domCore;
    requireCore(core, document);
    core.status(
      "document_custom_registry_set",
      document._coreHandle,
      this._coreRegistry,
    );
  }

  *_documents() {
    const core = this._domCore;
    for (let index = 0;; index++) {
      const handle = core.handle(
        "custom_registry_document",
        this._coreRegistry,
        index,
      );
      if (!handle) return;
      yield core.wrapperFor(handle);
    }
  }

  _activeReactionContext() {
    const core = this._domCore;
    const { contextObjects } = coreState(core);
    return contextObjects.get(
      core.handle("custom_host_active", this._coreRegistry),
    ) ?? null;
  }

  _validateReactionContext(context) {
    const core = this._domCore;
    core.status(
      "custom_host_validate",
      this._coreRegistry,
      contextHandle(context, core),
    );
  }

  async _drainHostReactions(context) {
    const core = this._domCore;
    const handle = contextHandle(context, core);
    for (let reaction; (reaction = nextReaction(core, handle, this._coreRegistry));) {
      let failure;
      try {
        await invokeReaction(reaction, context);
      } catch (error) {
        failure = { error };
      }
      completeReaction(core, handle, this._coreRegistry, reaction, failure);
    }
  }

  _setHostDefinitionParticipant(definition, participant) {
    const core = this._domCore;
    core.status(
      "custom_definition_validate",
      this._coreRegistry,
      definitionId(core, definition),
      1,
    );
    if (participant === null || participant === undefined) {
      throw new TypeError("Host custom-element participant binding is invalid");
    }
    definition.participant = participant;
  }

  async _bindingRunHostOperation(callback, reactionContext = null) {
    const core = this._domCore;
    const { constructionObjects, contextObjects, hostWaiters } = coreState(core);
    if (reactionContext !== null) {
      this._validateReactionContext(reactionContext);
      return await callback(reactionContext);
    }
    const handle = core.handle("custom_host_reserve", this._coreRegistry);
    let context;
    let closed = false;
    try {
      if (core.handle("custom_host_ready", this._coreRegistry) !== handle) {
        await new Promise((resolve) => hostWaiters.set(handle, resolve));
      }
      core.status("custom_host_begin", this._coreRegistry, handle);
      hostWaiters.delete(handle);
      context = Object.freeze({
        registry: this,
        generation: Number(handle >> 32n),
        get closed() {
          return closed;
        },
      });
      contexts.set(context, handle);
      contextObjects.set(handle, context);
      try {
        return await callback(context);
      } finally {
        try {
          for (
            let unfinished;
            (unfinished = core.handle(
              "custom_host_unfinished",
              this._coreRegistry,
              handle,
            ));
          ) {
            this._abortHostToken(constructionObjects.get(unfinished), context);
          }
        } finally {
          await this._drainHostReactions(context);
        }
      }
    } finally {
      try {
        if (context) {
          core.status(
            "custom_reactions_end",
            contextHandle(context, core),
            this._coreRegistry,
          );
        } else core.status("custom_host_cancel", this._coreRegistry, handle);
      } finally {
        closed = true;
        if (context) contextObjects.delete(contextHandle(context, core));
        hostWaiters.delete(handle);
        const ready = core.handle("custom_host_ready", this._coreRegistry);
        hostWaiters.get(ready)?.();
      }
    }
  }

  _installDefinition(
    name,
    constructor,
    extendedTag,
    observedAttributes,
    host,
    callbacks,
    participant,
  ) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    const id = core.status(
      "custom_registry_define",
      this._coreRegistry,
      ...core.input(name),
      ...core.nullableInput(extendedTag),
      constructor === null ? 0 : constructorIdentity(constructor),
      host ? 1 : 0,
    );
    if (constructor !== null) constructorCores.set(constructor, core);
    for (const attribute of observedAttributes) {
      core.status("custom_definition_observe", id, ...core.input(attribute));
    }
    const definition = {
      id,
      constructor,
      host,
      callbacks,
      registry: this,
      participant,
      get name() {
        return definitionText(core, id, false);
      },
      get extendedTag() {
        return definitionText(core, id, true);
      },
    };
    definitions.set(id, definition);
    const waiting = this._waiting.get(name);
    if (waiting) {
      waiting.resolve(host ? definition : constructor);
      this._waiting.delete(name);
    }
    return definition;
  }

  async _bindingDefineHost(input, reactionContext = null) {
    return await this.runHostOperation(async (context) => {
      if (input.participant === null || input.participant === undefined) {
        throw new TypeError(
          "Host custom-element definitions require a participant",
        );
      }
      const definition = this._installDefinition(
        String(input.name),
        null,
        null,
        input.observedAttributes.map(String),
        true,
        {
          construct: input.construct,
          connectedCallback: input.connected,
          disconnectedCallback: input.disconnected,
          attributeChangedCallback: input.attributeChanged,
          adoptedCallback: input.adopted,
        },
        input.participant,
      );
      for (const document of this._documents()) {
        await this.upgradeHost(document, context);
      }
      return definition;
    }, reactionContext);
  }

  _beginConstruction(element, definition, context, mode) {
    const core = this._domCore;
    const { constructionObjects } = coreState(core);
    requireCore(core, element);
    const handle = core.handle(
      "custom_construction_begin",
      this._coreRegistry,
      definitionId(core, definition),
      element._coreHandle,
      contextHandle(context, core),
      mode,
    );
    if (!handle) return null;
    const binding = {
      handle,
      registry: this,
      definition,
      element,
      context,
      claim: 0n,
      originalPrototype: Object.getPrototypeOf(element),
    };
    const token = Object.freeze({
      get state() {
        return tokenState(token);
      },
    });
    constructions.set(token, binding);
    constructionObjects.set(handle, token);
    element._notifyMutation("state", "defined");
    return token;
  }

  _releaseConstruction(token) {
    const core = this._domCore;
    const { constructionObjects } = coreState(core);
    const binding = constructionBinding(token, this);
    binding.terminal = tokenState(token);
    core.status(
      "custom_construction_release",
      binding.handle,
      this._coreRegistry,
      contextHandle(binding.context, core),
    );
    constructionObjects.delete(binding.handle);
  }

  async _constructHostElement(
    document,
    definition,
    reactionContext,
    existingElement = null,
  ) {
    const core = this._domCore;
    requireCore(core, document);
    this._validateReactionContext(reactionContext);
    const element = existingElement ??
      document._createUncustomizedElement(definition.name);
    const token = this._beginConstruction(
      element,
      definition,
      reactionContext,
      2,
    );
    if (!token) return element;
    const binding = constructions.get(token);
    binding.invoked = true;
    let failure;
    try {
      await definition.callbacks.construct({
        definition,
        constructionToken: token,
        node: element,
        reactionContext,
        participant: definition.participant,
      });
    } catch (error) {
      failure = { error };
    }
    try {
      const result = core.status(
        "custom_construction_return",
        binding.handle,
        this._coreRegistry,
        contextHandle(reactionContext, core),
        failure ? CUSTOM_OUTCOME_THREW : CUSTOM_OUTCOME_CONSTRUCTED,
      );
      if (result === CUSTOM_RETURN_FINISHED || result === CUSTOM_RETURN_FINISHED_FAILED) {
        applyConstructionResult(binding, CUSTOM_CONSTRUCTION_FAILED_RESET);
      }
      if (result !== CUSTOM_RETURN_COMPLETED) {
        this._reportException(
          failure ? failure.error : new Error(
            "Host custom-element constructor did not complete its token",
          ),
        );
      }
    } finally {
      this._releaseConstruction(token);
    }
    return element;
  }

  _completeHostToken(token, reactionContext) {
    const core = this._domCore;
    const binding = constructionBinding(token, this);
    const result = core.status(
      "custom_construction_complete",
      binding?.handle ?? 0n,
      this._coreRegistry,
      contextHandle(reactionContext, core),
      binding?.claim ?? 0n,
      CUSTOM_OUTCOME_CONSTRUCTED,
    );
    applyConstructionResult(binding, result);
    // The invoking host constructor still owns its continuation until it returns.
    if (!binding.invoked) this._releaseConstruction(token);
  }

  _abortHostToken(token, reactionContext) {
    const core = this._domCore;
    const binding = constructionBinding(token, this);
    const result = core.status(
      "custom_construction_abort",
      binding?.handle ?? 0n,
      this._coreRegistry,
      contextHandle(reactionContext, core),
      binding?.claim ?? 0n,
    );
    applyConstructionResult(binding, result);
    if (!binding.invoked) this._releaseConstruction(token);
  }

  async _bindingCreateHostElement(document, localName, reactionContext) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    requireCore(core, document);
    const id = core.status(
      "custom_registry_match",
      this._coreRegistry,
      ...core.input(localName),
      0,
      0,
      1,
    );
    const definition = definitions.get(id);
    return definition
      ? await this._constructHostElement(document, definition, reactionContext)
      : document.createElement(localName);
  }

  _bindingUpgradeHost(root, reactionContext) {
    this._validateReactionContext(reactionContext);
    this.upgrade(root);
  }

  async _bindingBeginHostConstruction(definition, reactionContext = null) {
    const core = this._domCore;
    core.status(
      "custom_definition_validate",
      this._coreRegistry,
      definitionId(core, definition),
      1,
    );
    if (reactionContext !== null) {
      this._validateReactionContext(reactionContext);
      const document = core.wrapperFor(
        core.handle("custom_registry_first_document", this._coreRegistry),
      );
      const element = document._createUncustomizedElement(definition.name);
      const token = this._beginConstruction(
        element,
        definition,
        reactionContext,
        2,
      );
      this.claimHostConstruction(token, definition, reactionContext);
      return {
        definition,
        constructionToken: token,
        node: element,
        reactionContext,
      };
    }
    let reserve;
    const result = new Promise((resolve, reject) =>
      reserve = { resolve, reject }
    );
    let finish;
    const finished = new Promise((resolve, reject) =>
      finish = { resolve, reject }
    );
    this.runHostOperation(async (context) => {
      const started = await this.beginHostConstruction(definition, context);
      const binding = constructions.get(started.constructionToken);
      binding.splitOwner = true;
      binding.operationFinished = finished;
      const completion = new Promise((resolve) =>
        binding.finishSplit = resolve
      );
      reserve.resolve(started);
      await completion;
    }).then(finish.resolve, (error) => {
      finish.reject(error);
      reserve.reject(error);
    });
    return await result;
  }

  _bindingClaimHostConstruction(token, definition, reactionContext) {
    const core = this._domCore;
    const binding = constructionBinding(token, this);
    const claim = core.handle(
      "custom_construction_claim",
      binding?.handle ?? 0n,
      this._coreRegistry,
      definitionId(core, definition),
      contextHandle(reactionContext, core),
    );
    binding.claim = claim;
    return {
      definition,
      constructionToken: token,
      node: binding.element,
      reactionContext,
    };
  }

  async _bindingCompleteHostConstruction(token, reactionContext) {
    this._completeHostToken(token, reactionContext);
    const binding = constructions.get(token);
    if (binding.splitOwner) {
      binding.finishSplit();
      await binding.operationFinished;
    }
  }

  async _bindingAbortHostConstruction(token, reactionContext) {
    this._abortHostToken(token, reactionContext);
    const binding = constructions.get(token);
    if (binding.splitOwner) {
      binding.finishSplit();
      await binding.operationFinished;
    }
  }

  _bindingInspectHostOperations() {
    const core = this._domCore;
    return Object.freeze({
      queueDepth: core.status("custom_host_inspect", this._coreRegistry, CUSTOM_HOST_QUEUE_ACTIVE),
      activeContextGeneration:
        (core.status("custom_host_inspect", this._coreRegistry, CUSTOM_HOST_CONTEXT_GENERATION) >>> 0) ||
        null,
      unfinishedConstructionCount: core.status(
        "custom_host_inspect",
        this._coreRegistry,
        CUSTOM_HOST_UNFINISHED_CONSTRUCTIONS,
      ),
      pendingReactionCount: core.status(
        "custom_host_inspect",
        this._coreRegistry,
        CUSTOM_HOST_PENDING_REACTIONS,
      ),
    });
  }

  _bindingDefine(normalizedName, constructor, options) {
    const extendedTag = options.extends === undefined
      ? null
      : String(options.extends);
    const observed = constructor.observedAttributes;
    // HTML "define": formAssociated is the conversion of the constructor's
    // formAssociated property to a boolean.
    const formAssociated = Boolean(constructor.formAssociated);
    const definition = this._installDefinition(
      normalizedName,
      constructor,
      extendedTag,
      Array.isArray(observed) ? observed.map(String) : [],
      false,
      null,
      null,
    );
    if (formAssociated) this._domCore.status("custom_definition_form_associated", definition.id);
    for (const document of this._documents()) this.upgrade(document);
  }

  _bindingGet(name) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    return definitions.get(
      core.status(
        "custom_registry_get",
        this._coreRegistry,
        ...core.input(name),
      ),
    )?.constructor;
  }

  _bindingSnapshotDefinitions() {
    const core = this._domCore;
    const { definitions } = coreState(core);
    const snapshot = [];
    for (let index = 0;; index++) {
      const id = core.status(
        "custom_registry_definition_at",
        this._coreRegistry,
        index,
      );
      if (!id) return snapshot;
      const definition = definitions.get(id);
      snapshot.push({
        name: definition.name,
        constructor: definition.constructor,
        extendedTag: definition.extendedTag,
      });
    }
  }

  _bindingGetName(constructor) {
    const core = this._domCore;
    const identity = constructors.get(constructor);
    if (identity === undefined) return null;
    const id = core.status(
      "custom_registry_constructor",
      this._coreRegistry,
      identity,
    );
    return id ? definitionText(core, id, false) : null;
  }

  _bindingWhenDefined(normalizedName) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    core.status("custom_name_validate", ...core.input(normalizedName));
    const id = core.status(
      "custom_registry_get",
      this._coreRegistry,
      ...core.input(normalizedName),
    );
    if (id) {
      const definition = definitions.get(id);
      return Promise.resolve(
        definition.host ? definition : definition.constructor,
      );
    }
    let waiting = this._waiting.get(normalizedName);
    if (!waiting) {
      let resolve;
      const promise = new Promise((complete) => resolve = complete);
      waiting = { promise, resolve };
      this._waiting.set(normalizedName, waiting);
    }
    return waiting.promise;
  }

  _definitionForElement(element) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    requireCore(core, element);
    return definitions.get(
      core.status("custom_element_definition", element._coreHandle, true),
    ) ?? null;
  }

  _upgradeElement(
    element,
    definition = this._definitionForElement(element),
    construction = false,
  ) {
    const core = this._domCore;
    if (!definition) return element;
    return withCustomElementReactions(() => {
      const token = this._beginConstruction(
        element,
        definition,
        null,
        construction ? 1 : 0,
      );
      if (!token) return element;
      const binding = constructions.get(token);
      let failure;
      let outcome = CUSTOM_OUTCOME_CONSTRUCTED;
      let result;
      let returned;
      let constructed = element;
      try {
        binding.claim = core.handle(
          "custom_construction_claim",
          binding.handle,
          this._coreRegistry,
          definition.id,
          0n,
        );
        const previousCore = constructionCore;
        try {
          constructionCore = core;
          returned = Reflect.construct(definition.constructor, []);
        } finally {
          constructionCore = previousCore;
        }
        if (!construction && returned !== element) {
          outcome = CUSTOM_OUTCOME_OTHER_OBJECT;
          failure = new TypeError(
            "Custom element constructor returned a different object",
          );
        }
      } catch (error) {
        outcome = CUSTOM_OUTCOME_THREW;
        failure = error;
      }
      try {
        if (construction) {
          result = core.status(
            "custom_creation_complete",
            binding.handle,
            this._coreRegistry,
            binding.claim,
            core.handleForWrapper(returned),
            outcome,
          );
          constructed = core.wrapperFor(core.handle(
            "custom_creation_result", binding.handle, this._coreRegistry,
          ));
          constructed._dispatchCoreTreeRecords();
          constructed._notifyMutation("state", "defined");
        } else {
          result = core.status(
            "custom_construction_complete",
            binding.handle,
            this._coreRegistry,
            0n,
            binding.claim,
            outcome,
          );
          applyConstructionResult(binding, result);
        }
      } finally {
        this._releaseConstruction(token);
      }
      if (result === CUSTOM_CONSTRUCTION_NOT_SUPPORTED) {
        failure = new DOMException(
          "Custom element creation requires an empty, detached element with the requested document and local name",
          "NotSupportedError",
        );
      }
      if (result === CUSTOM_CONSTRUCTION_INVALID_ELEMENT) failure = new TypeError("Custom element constructor returned an invalid element");
      if (result !== CUSTOM_CONSTRUCTION_DEFINED) this._reportException(failure);
      return constructed;
    }, core);
  }

  _bindingUpgrade(root) {
    const core = this._domCore;
    requireCore(core, root);
    withCustomElementReactions(
      () => core.status("custom_upgrade", root._coreHandle),
      core,
    );
  }

  _construct(element, is = null) {
    const core = this._domCore;
    const { definitions } = coreState(core);
    requireCore(core, element);
    // The core sets the element's is value and finds its definition; a
    // registry without a native registry yet has no definition (0).
    const id = core.status(
      "custom_element_create",
      this._nativeRegistry,
      element._coreHandle,
      ...core.nullableInput(is),
      is === null || is === undefined ? 0 : 1,
    );
    const definition = definitions.get(id);
    if (!definition) return element;
    return this._upgradeElement(element, definition, true);
  }
}

export function definitionForConstructor(constructor, core = sharedDomCore) {
  const { definitions } = coreState(core);
  const identity = constructors.get(constructor);
  if (identity === undefined) return null;
  return definitions.get(
    core.status("custom_constructor_definition", identity),
  ) ?? null;
}

export const CustomStateSet = createCustomStateSetBinding({
  Base: CustomStateSetRuntime,
});
export const ElementInternals = createElementInternalsBinding({
  Base: ElementInternalsRuntime,
});
export const CustomElementRegistry = createCustomElementRegistryBinding({
  Base: CustomElementRegistryRuntime,
  validateName(name) {
    const core = sharedDomCore;
    core.status("custom_name_validate", ...core.input(name));
    return name;
  },
});
// Each interface prototype's class string (Web IDL §3.7.3).
for (const [name, Interface] of Object.entries({ CustomStateSet, ElementInternals, CustomElementRegistry })) {
  Object.defineProperty(Interface.prototype, Symbol.toStringTag, { value: name, configurable: true });
}
