import { sharedDomCore } from "../dom-wasm/core.js";
import { enterComponentCode } from "./component-code.js";
import {
  createCustomElementRegistryBinding,
  createCustomStateSetBinding,
  createElementInternalsBinding,
} from "./dom-bindings.generated.js";

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

function nullableInput(core, value) {
  return value === null ? [0, -1] : core.input(value);
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
  return [null, "precustomized", "custom", "failed", null][
    core.status("custom_element_state", element._coreHandle)
  ];
}

export function customElementDefinition(element) {
  const core = element?._domCore;
  const definitions = core ? coreState(core).definitions : null;
  return element?._coreHandle === undefined ? null : definitions.get(
    core.status("custom_element_definition", element._coreHandle, 0),
  ) ?? null;
}

function nextReaction(core, handle, registry) {
  const { definitions } = coreState(core);
  const pointer = core.status("custom_reaction_next", handle, registry);
  if (!pointer) return null;
  const token = core.handle("custom_reaction_token", handle, registry);
  const view = new DataView(core.refreshBytes().buffer);
  const string = (offset) => {
    const length = view.getInt32(pointer + offset + 4, true);
    if (length === -1) return null;
    const start = view.getUint32(pointer + offset, true);
    return core.decoder.decode(core.bytes.subarray(start, start + length));
  };
  // Decode the complete owned invocation before crossing into authored code.
  const elementHandle = view.getBigUint64(pointer + 8, true);
  const definition = definitions.get(view.getUint32(pointer + 16, true));
  const kind = view.getUint32(pointer + 20, true);
  const name = string(24);
  const oldValue = string(32);
  const newValue = string(40);
  const oldDocument = view.getBigUint64(pointer + 48, true);
  const newDocument = view.getBigUint64(pointer + 56, true);
  const element = core.wrapperFor(elementHandle);
  return {
    token,
    definition,
    element,
    kind,
    argumentsList: kind === 3
      ? [name, oldValue, newValue]
      : kind === 4
      ? [core.wrapperFor(oldDocument), core.wrapperFor(newDocument)]
      : [],
  };
}

const callbackNames = [
  null,
  "connectedCallback",
  "disconnectedCallback",
  "attributeChangedCallback",
  "adoptedCallback",
  "connectedMoveCallback",
];

// Runs a reaction as component code of its element's document.
function invokeReaction(reaction, context = null) {
  return enterComponentCode(reaction.element?.ownerDocument, runReaction, null, [reaction, context]);
}

function runReaction(reaction, context) {
  const { definition, element, kind, argumentsList } = reaction;
  if (kind === 0) {
    return definition.host
      ? definition.registry._constructHostElement(
        element.ownerDocument,
        definition,
        context,
        element,
      )
      : definition.registry._upgradeElement(element, definition);
  }
  const name = callbackNames[kind];
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
  if (kind !== 5) return;
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
    error === undefined ? 0 : 1,
  );
  if (result === 2) reaction.definition.registry._reportException(error.error);
}

export function withCustomElementReactions(operation, core = sharedDomCore) {
  const handle = core.handle("custom_reactions_begin");
  try {
    return operation();
  } finally {
    try {
      for (let reaction; (reaction = nextReaction(core, handle, 0));) {
        let failure;
        try {
          invokeReaction(reaction);
        } catch (error) {
          failure = { error };
        }
        completeReaction(core, handle, 0, reaction, failure);
      }
    } finally {
      core.status("custom_reactions_end", handle, 0);
    }
  }
}

function enqueue(
  element,
  kind,
  name = "",
  oldValue = null,
  newValue = null,
  oldDocument = null,
  newDocument = null,
) {
  const core = element._domCore;
  requireCore(core, oldDocument);
  requireCore(core, newDocument);
  const operation = () =>
    core.status(
      "custom_reaction_enqueue",
      element._coreHandle,
      kind,
      ...core.input(name),
      ...nullableInput(core, oldValue),
      ...nullableInput(core, newValue),
      oldDocument?._coreHandle ?? 0n,
      newDocument?._coreHandle ?? 0n,
    );
  if (core.handle("custom_reactions_current")) operation();
  else withCustomElementReactions(operation, core);
}

export function treeUpgrade(root) {
  const core = root._domCore;
  withCustomElementReactions(
    () => core.status("custom_tree_upgrade", root._coreHandle),
    core,
  );
}

export function treeChanged(target, addedNode, removedNode) {
  const core = target._domCore;
  requireCore(core, addedNode);
  requireCore(core, removedNode);
  core.status(
    "custom_tree_reactions",
    target._coreHandle,
    addedNode?._coreHandle ?? 0n,
    removedNode?._coreHandle ?? 0n,
  );
}

export function attributeChanged(element, name, oldValue, newValue) {
  enqueue(element, 3, name, oldValue, newValue);
}

export function connectedChanged(element, connected) {
  enqueue(element, connected ? 1 : 2);
}

export function adopted(element, oldDocument, newDocument) {
  enqueue(element, 4, "", null, null, oldDocument, newDocument);
}

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
    ) === 1;
  }
  _bindingAdd(state) {
    const core = this._host._domCore;
    const result = core.status(
      "custom_state_set",
      this._host._coreHandle,
      ...core.input(state),
      1,
    );
    if (result === 2) {
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
      0,
    );
    if (result !== 2) return false;
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
      serial = view.getBigUint64(pointer + 8, true);
      const length = view.getUint32(pointer + 4, true);
      yield core.decoder.decode(
        core.bytes.subarray(pointer + 16, pointer + 16 + length),
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

class ElementInternalsRuntime {
  constructor(host) {
    const core = host._domCore;
    core.status("custom_internals_attach", host._coreHandle);
    this._host = host;
    this.states = new CustomStateSet(host);
    return new Proxy(this, {
      get: (target, property, receiver) => {
        const kind = typeof property === "string"
          ? core.status("custom_internals_property", ...core.input(property))
          : 0;
        if (!kind) return Reflect.get(target, property, receiver);
        const type = core.status(
          "custom_internals_get",
          host._coreHandle,
          ...core.input(property),
        );
        if (!type) return null;
        if (type === 1) return core.outputString();
        const pointer = core.exports.abi_output_pointer();
        const count = core.exports.abi_output_length() / 8;
        const view = new DataView(core.refreshBytes().buffer);
        const handles = Array.from(
          { length: count },
          (_, index) => view.getBigUint64(pointer + index * 8, true),
        );
        return handles.map((handle) => core.wrapperFor(handle));
      },
      set: (target, property, value, receiver) => {
        const kind = typeof property === "string"
          ? core.status("custom_internals_property", ...core.input(property))
          : 0;
        if (!kind) return Reflect.set(target, property, value, receiver);
        if (kind === 2 && value !== null) {
          const elements = [...value].map((element) => {
            requireCore(core, element);
            return element._coreHandle;
          });
          const pointer = core.exports.abi_allocate(elements.length * 8);
          try {
            const view = new DataView(core.refreshBytes().buffer);
            elements.forEach((handle, index) => {
              view.setBigUint64(pointer + index * 8, handle, true);
            });
            core.status(
              "custom_internals_set",
              host._coreHandle,
              ...core.input(property),
              pointer,
              elements.length * 8,
              2,
            );
          } finally {
            core.exports.abi_free(pointer);
          }
        } else {
          core.status(
            "custom_internals_set",
            host._coreHandle,
            ...core.input(property),
            ...core.input(value === null ? "" : String(value)),
            value === null ? 0 : 1,
          );
        }
        host._notifyMutation("state", property);
        return true;
      },
    });
  }
}

function tokenState(token) {
  const binding = constructions.get(token);
  const core = binding.registry._domCore;
  if (binding.terminal !== undefined) return binding.terminal;
  return ["unclaimed", "claimed", "completed", "aborted"][
    core.status(
      "custom_construction_state",
      binding.handle,
      binding.registry._coreRegistry,
      contextHandle(binding.context, core),
    )
  ];
}

function applyConstructionResult(binding, result) {
  if (result >= 3) {
    binding.element._internals = null;
    Object.setPrototypeOf(binding.element, binding.originalPrototype);
  }
  binding.element._dispatchCoreTreeRecords();
  binding.element._notifyMutation("state", "defined");
}

class CustomElementRegistryRuntime {
  constructor({
    core = sharedDomCore,
    supportedBuiltIns = new Map(),
    reportException = globalThis.reportError?.bind(globalThis),
  } = {}) {
    this._domCore = core;
    this._coreRegistry = core.status("custom_registry_create");
    this._supportedBuiltIns = supportedBuiltIns;
    for (const [name, interfaceConstructor] of supportedBuiltIns) {
      core.status(
        "custom_registry_builtin",
        this._coreRegistry,
        ...core.input(name),
        constructorIdentity(interfaceConstructor),
      );
    }
    this._waiting = new Map();
    this._reportException = reportException ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
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
        return definitionText(core, id, 0);
      },
      get extendedTag() {
        return definitionText(core, id, 1);
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
        failure ? 1 : 0,
      );
      if (result === 3 || result === 6) applyConstructionResult(binding, 3);
      if (result !== 1) {
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
      0,
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
      queueDepth: core.status("custom_host_inspect", this._coreRegistry, 0),
      activeContextGeneration:
        (core.status("custom_host_inspect", this._coreRegistry, 3) >>> 0) ||
        null,
      unfinishedConstructionCount: core.status(
        "custom_host_inspect",
        this._coreRegistry,
        1,
      ),
      pendingReactionCount: core.status(
        "custom_host_inspect",
        this._coreRegistry,
        2,
      ),
    });
  }

  _bindingDefine(normalizedName, constructor, options) {
    const extendedTag = options.extends === undefined
      ? null
      : String(options.extends);
    const observed = constructor.observedAttributes;
    this._installDefinition(
      normalizedName,
      constructor,
      extendedTag,
      Array.isArray(observed) ? observed.map(String) : [],
      false,
      null,
      null,
    );
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
    return id ? definitionText(core, id, 0) : null;
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
      core.status("custom_element_definition", element._coreHandle, 1),
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
      let outcome = 0;
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
          outcome = 2;
          failure = new TypeError(
            "Custom element constructor returned a different object",
          );
        }
      } catch (error) {
        outcome = 1;
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
      if (result === 4) {
        failure = new DOMException(
          "Custom element creation requires an empty, detached element with the requested document and local name",
          "NotSupportedError",
        );
      }
      if (result === 5) failure = new TypeError("Custom element constructor returned an invalid element");
      if (result !== 1) this._reportException(failure);
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
    const id = core.status(
      "custom_registry_match",
      this._coreRegistry,
      ...core.input(element.localName),
      ...core.nullableInput(is),
      0,
    );
    const definition = definitions.get(id);
    if (!definition) return element;
    if (is) element._setParsedAttribute("is", is);
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
