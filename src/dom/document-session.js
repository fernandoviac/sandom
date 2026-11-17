import { hostNow } from "../host-clock.js";
import {
  inspectAnimationPreparedInput,
  inspectDocumentPaint,
  inspectPreparedInput,
  prepareRenderInput,
  renderPreparedInput,
} from "./render-animation.js";
import {
  abortFrameTransaction,
  commitFrameTransaction,
  createFrameTransaction,
  createRenderSurface,
} from "./render-surface.js";
import { createSandomDOM } from "./sandom-dom.js";
import { normalizeInputBatch } from "./interaction.js";
import {
  closeDocumentScope,
  documentLogBytes,
  documentLogEntries,
  gateDocument,
  loadDocumentLog,
  logInteraction,
  openDocumentScope,
  replayDocumentLog,
  withDocumentScope,
} from "./document-operations.js";
import { recommendViewportFromInspection } from "./viewport-recommendation.js";
import {
  captureDocumentMetrics,
  captureDocumentPaint,
  copyRasterArtifact,
  captureDocumentRaster,
  captureDocumentStructure,
  inspectDocumentWorld,
  loadDocumentMetrics,
  readRasterArtifact,
} from "./document-observation.js";
import { compareObservations } from "./artifact-comparison.js";
import { selectPaintRecord } from "./paint-projection.js";
import { buildAccessibilitySnapshot } from "./accessibility.js";
import { assertScrollbarStyle } from "./scrollbar-visibility.js";
import { createRetainedInstance } from "./retained-transitions.js";
import { readDocumentOutline } from "./document-outline.js";
import { prepareSceneDocument } from "./serialize.js";

const SESSION_STATE = new WeakMap();

function requiredState(session) {
  const state = SESSION_STATE.get(session);
  if (!state || state.disposed) {
    throw new Error("The document session is disposed.");
  }
  return state;
}

function environmentKey(environment) {
  const width = Number(environment.width);
  const height = Number(environment.height);
  const deviceScale = Number(environment.deviceScale ?? 1);
  if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
    throw new RangeError(
      "A document environment requires positive dimensions and device scale.",
    );
  }
  return `${width}x${height}@${deviceScale}`;
}

function clonePreparedDocument(preparedInput) {
  const source = preparedInput.document;
  const document = new source.constructor();
  for (const child of source.childNodes) {
    document.appendChild(document.importNode(child, true));
  }
  return document;
}

export class DocumentSession {
  // `scrollbarStyle` ("overlay" or "classic") is the style of every surface
  // and layout the session creates (design/scrollbars.md,
  // decision 1). An inspect, plan, or renderOnce request that names its
  // own scrollbarStyle overrides it for that request.
  constructor(preparedInput, { scrollbarStyle } = {}) {
    if (!preparedInput?.document?.documentElement) {
      throw new TypeError("DocumentSession requires a prepared render input.");
    }
    const document = preparedInput.document;
    const containsCustomElement = document._domCore.status("custom_element_in_tree", document._coreHandle) === 1;
    const state = {
      preparedInput,
      // Undefined when the creator named no style: a request then reports
      // the "overlay" default as its own (render plan decision source).
      scrollbarStyle: scrollbarStyle === undefined
        ? undefined
        : assertScrollbarStyle(scrollbarStyle, "document session options"),
      baselineDocument: containsCustomElement
        ? null
        : clonePreparedDocument(preparedInput),
      disposed: false,
      nextInstanceIdentifier: 2,
      nextTargetIdentifier: 1,
      instances: new Map(),
      targets: new Map(),
      operationChain: Promise.resolve(),
      // The projections that the session captured and has not released.
      projections: new Set(),
      // The render surfaces of raster projections, by environment key,
      // that no raster target registered first. They live until disposal.
      projectionSurfaces: new Map(),
    };
    SESSION_STATE.set(this, state);
    this.#addInstance("instance-1", preparedInput.document);
  }

  get scrollbarStyle() {
    return requiredState(this).scrollbarStyle ?? "overlay";
  }

  get document() {
    return requiredState(this).instances.get("instance-1").document;
  }

  get instances() {
    return Object.freeze([...requiredState(this).instances.keys()]);
  }

  createInstance({ attributes = {} } = {}) {
    const state = requiredState(this);
    if (state.baselineDocument === null) {
      throw new Error(
        "A document with custom elements cannot create a cloned instance.",
      );
    }
    const identifier = `instance-${state.nextInstanceIdentifier++}`;
    const document = clonePreparedDocument({
      ...state.preparedInput,
      document: state.baselineDocument,
    });
    this.#addInstance(identifier, document);
    state.instances.get(identifier).creationAttributes = Object.freeze({
      ...attributes,
    });
    const root = document.documentElement;
    this.mutate(() => {
      for (const [name, value] of Object.entries(attributes)) {
        root.setAttribute(name, value);
      }
    }, { instance: identifier });
    return identifier;
  }

  // Runs `operation(document)` with the instance's origin scope open: the
  // core logs each change with `origin` ("script", "agent" or "inspector").
  mutate(operation, { instance = "instance-1", origin = "script" } = {}) {
    const state = requiredState(this);
    if (typeof operation !== "function") {
      throw new TypeError("mutate requires a function.");
    }
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    return withDocumentScope(current.document, origin, () => {
      const result = operation(current.document);
      if (result instanceof Promise) {
        throw new TypeError(
          "A document mutation operation must be synchronous.",
        );
      }
      current.revision += 1;
      current.worlds.clear();
      return result;
    });
  }

  // A copy of the instance's document log
  // (docs/design/dom-webassembly-core.md, "Document operation log").
  documentLog(instance = "instance-1") {
    return documentLogBytes(this.#instanceState(instance).document);
  }

  // Resolves to a new instance of the session's source with `log` replayed
  // on it; its own log holds the same entries. `interact(document, record)`
  // dispatches each input record of the log, and `present(document, time)`
  // renders each frame of the log at its time.
  async replay(log, { interact, present } = {}) {
    const identifier = this.createInstance();
    const current = this.#instanceState(identifier);
    await replayDocumentLog(current.document, log, {
      interact: interact && ((record) => interact(current.document, record)),
      present: present && ((time) => present(current.document, time)),
    });
    current.revision += 1;
    current.worlds.clear();
    return identifier;
  }

  #instanceState(instance) {
    const current = requiredState(this).instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    return current;
  }

  // Queues one transition of a document instance and returns its handle at
  // once (docs/design/component-rendering.md#retained-transitions).
  // `applicator({ document }, context)` mutates the live document
  // synchronously, or calls `context.deferSettlement()` and then `settle()`
  // or `fail(error)`; document writes are open until the step ends. The
  // transition renders nothing; completion arrives through
  // `onPublished(revision)` or `onFailed(error)`. A document with custom
  // elements takes transitions on its one instance.
  transition(applicator, { instance = "instance-1", ...options } = {}) {
    return this.#retainedInstance(instance).transition(applicator, options);
  }

  // Queues a reset of a document instance: its document is replaced by a
  // clone of the prepared source. Completion arrives through
  // `onReady(revision)` or `onFailed(error)`.
  reset({ instance = "instance-1", ...options } = {}) {
    return this.#retainedInstance(instance).reset(options);
  }

  // The published revision of a document instance.
  revision(instance = "instance-1") {
    return this.#retainedInstance(instance).revision;
  }

  // Throws unless `revisionHandle` names the published revision of the
  // document instance.
  requireCurrentRevision(revisionHandle, { instance = "instance-1" } = {}) {
    this.#retainedInstance(instance).requireCurrentRevision(revisionHandle);
  }

  // Names what a projection observes in a document instance: the document
  // (no address), the subtree of the one node that `address` resolves to,
  // or the compositing layer at paint group index `layer` (a raster only).
  // Returns { handle, release() }.
  select({ address, layer, instance = "instance-1" } = {}) {
    if (layer !== undefined) return this.#retainedInstance(instance).selectLayer(layer);
    const effectiveInstance = this.#addressInstance(address, instance);
    let root = null;
    if (address !== undefined) {
      const nodes = this.#resolveNodes(address, effectiveInstance);
      if (nodes.length !== 1) {
        throw new RangeError(`A selection requires an address that resolves to one node; it resolves to ${nodes.length}.`);
      }
      [root] = nodes;
    }
    return this.#retainedInstance(effectiveInstance).select(root);
  }

  // Names how to raster a selection of a document instance: { environment,
  // rectangle, backdrop, offset } (createRetainedInstance's place()).
  // Returns { handle, release() }.
  place(selection, options, { instance = "instance-1" } = {}) {
    return this.#retainedInstance(instance).place(selection, options);
  }

  // Reads a raster artifact back, optionally into a shared destination
  // buffer at the artifact's offset (readRasterArtifact).
  readback(artifact, destination = null) {
    requiredState(this);
    return readRasterArtifact(artifact, destination);
  }

  // Copies a raster artifact's GPU texture into a shared `texture` at the
  // artifact's offset, with no readback (copyRasterArtifact).
  copyRaster(artifact, texture) {
    requiredState(this);
    return copyRasterArtifact(artifact, texture);
  }

  // Compares two captured projections of `kind` (compareObservations) and
  // delivers { kind, changes, left, right } through onCompared, or the
  // incompatibility through onFailed. It applies no transition.
  compare(left, right, { kind } = {}, { onCompared, onFailed } = {}) {
    requiredState(this);
    Promise.resolve().then(() => compareObservations(left, right, kind)).then(onCompared, onFailed);
  }

  // Loads the bytes of a metrics record (its bytes()) into the core of a
  // document instance, as { artifact, provenance } that compare() and
  // compareLayerMetrics() take. The session releases the record at
  // disposal; `artifact.release()` frees it earlier.
  loadMetrics(bytes, { instance = "instance-1" } = {}) {
    const state = requiredState(this);
    const current = state.instances.get(instance);
    if (!current) throw new RangeError(`Unknown document instance: ${instance}`);
    const loaded = loadDocumentMetrics(current.document, bytes, {
      onRelease: (released) => state.projections.delete(released),
    });
    state.projections.add(loaded.artifact);
    return loaded;
  }

  // Requests one projection of a published revision of the instance that
  // `revision` names: { kind: "structure" | "metrics" | "paint", selection,
  // environment } or { kind: "raster", placement }. Returns its handle at
  // once; the request runs after the instance's queued transitions, and
  // completion arrives through onCaptured({ artifact, provenance }) or
  // onFailed(error). A structure or metrics artifact belongs to the
  // session, as a snapshot() or metrics() record does.
  project(revision, request, callbacks) {
    const state = requiredState(this);
    for (const current of state.instances.values()) {
      if (current.retained?.revision.instance === revision?.instance) {
        return current.retained.project(revision, request, callbacks);
      }
    }
    throw new RangeError(`No document instance of this session published revision ${revision?.handle}.`);
  }

  // The entries of the instance's document log: its load, then one entry
  // per change, each with its origin, operation and authoring batch.
  mutationEffects(instance = "instance-1") {
    const { document } = this.#instanceState(instance);
    return Object.freeze(documentLogEntries(document._domCore, documentLogBytes(document)));
  }

  async layout({
    instance = "instance-1",
    root = null,
    environment,
  }) {
    const state = requiredState(this);
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    const renderRoot = root ?? current.document.documentElement;
    if (renderRoot.ownerDocument !== current.document) {
      throw new Error(
        "The layout root does not belong to the selected instance.",
      );
    }
    const rootIdentifier = this.#nodeIdentifier(renderRoot);
    // A layout world is per (root, logical viewport). The engine lays
    // out in CSS pixels, so layout facts are density-invariant; density
    // belongs to surfaces (a surface owns a raster target), never to a
    // layout world. environmentKey still validates the full environment.
    environmentKey(environment);
    const key = `${rootIdentifier}:${Number(environment.width)}x${
      Number(environment.height)
    }`;
    let world = current.worlds.get(key);
    if (!world) {
      if (
        current.worlds.size > 0 &&
        current.document._environmentObservations?.size > 0
      ) {
        throw new Error(
          `The document observed ${
            [...current.document._environmentObservations].join(", ")
          }; one instance cannot use multiple environment worlds.`,
        );
      }
      const { layout, scene } = await inspectDocumentWorld(renderRoot, environment, {
        scrollbarStyle: this.scrollbarStyle,
        identify: (node) => this.#nodeIdentifier(node),
      });
      world = Object.freeze({
        kind: "document-layout-world",
        version: 1,
        key,
        instance,
        rootIdentifier,
        revision: current.revision,
        environment: Object.freeze({
          width: Number(environment.width),
          height: Number(environment.height),
        }),
        layout,
        scene,
      });
      current.worlds.set(key, world);
    }
    return world;
  }

  // The document outline of the instance (document-outline.js) under the
  // media of `environment`'s viewport, with each element as its node
  // identifier: { level, label, state, nodeIdentifier, children }. The
  // document's own environment returns afterwards.
  async documentOutline({ instance = "instance-1", root = null, environment }) {
    const state = requiredState(this);
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    const renderRoot = root ?? current.document.documentElement;
    if (renderRoot.ownerDocument !== current.document) {
      throw new Error("The outline root does not belong to the selected instance.");
    }
    environmentKey(environment);
    const width = Number(environment.width);
    const height = Number(environment.height);
    const styleSystem = current.document._styleSystem;
    const previousEnvironment = { ...styleSystem.environment };
    let outline;
    try {
      await current.document._readyForRendering();
      styleSystem.setEnvironment({ viewportWidth: width, viewportHeight: height });
      await current.document._readyForRendering();
      prepareSceneDocument(current.document.documentElement, { viewportWidth: width, viewportHeight: height });
      outline = readDocumentOutline(renderRoot);
    } finally {
      styleSystem.setEnvironment(previousEnvironment);
      await current.document._readyForRendering();
    }
    const identify = (entries) => entries.map(({ level, label, state, element, children }) =>
      Object.freeze({ level, label, state, nodeIdentifier: this.#nodeIdentifier(element), children: Object.freeze(identify(children)) }));
    return Object.freeze(identify(outline));
  }

  async recommendViewport({
    instance = "instance-1",
    root = null,
    initialViewport = { width: 640, height: 640 },
    deviceScale = 1,
    ...options
  } = {}) {
    const state = requiredState(this);
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    const renderRoot = root ?? current.document.documentElement;
    return await recommendViewportFromInspection(
      async (viewport) => ({
        layout: (await this.layout({
          instance,
          root: renderRoot,
          environment: { ...viewport, deviceScale },
        })).layout,
      }),
      { initialViewport, ...options },
    );
  }

  async resolveViewport({
    constraint = "auto",
    target = null,
    instance = "instance-1",
    root = null,
    deviceScale = 1,
    ...options
  } = {}) {
    requiredState(this);
    if (constraint !== "auto" && constraint !== null) {
      environmentKey({
        ...constraint,
        deviceScale: constraint.deviceScale ?? deviceScale,
      });
      return Object.freeze({
        viewport: Object.freeze({
          width: Number(constraint.width),
          height: Number(constraint.height),
          deviceScale: Number(constraint.deviceScale ?? deviceScale),
        }),
        source: "caller",
      });
    }
    if (target !== null) {
      const attached = requiredState(this).targets.get(String(target));
      const ambient = attached?.placements[0]?.environment;
      if (ambient) {
        return Object.freeze({
          viewport: Object.freeze({ ...ambient }),
          source: "attached-target",
        });
      }
    }
    const recommendation = await this.recommendViewport({
      instance,
      root,
      deviceScale,
      ...options,
    });
    if (recommendation.viewport) {
      return Object.freeze({
        viewport: Object.freeze({
          ...recommendation.viewport,
          deviceScale,
        }),
        source: "analytical-trial",
        recommendation,
      });
    }
    const error = new Error(
      "The document session cannot resolve a viewport without a caller constraint.",
    );
    error.name = "DocumentSessionSizingError";
    error.details = Object.freeze({
      unresolvedField: "viewport",
      acceptedCallerConstraints: Object.freeze(["constraint"]),
      recommendation,
    });
    throw error;
  }

  query(address) {
    const state = requiredState(this);
    const instance = address?.instance ?? "instance-1";
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    if (address?.system === "dom") {
      const nodes = address.selector === undefined
        ? [current.document.documentElement]
        : [...current.document.querySelectorAll(String(address.selector))];
      return Object.freeze(nodes.map((node) =>
        Object.freeze({
          nodeIdentifier: this.#nodeIdentifier(node),
          node,
        })
      ));
    }
    if (address?.system === "layout") {
      const world = current.worlds.get(String(address.worldKey));
      if (!world) {
        throw new RangeError(`Unknown layout world: ${address.worldKey}`);
      }
      const nodeIdentifier = this.#nodeIdentifier(this.#nodeOf(current.document, address.nodeIdentifier));
      return world.layout.nodes.find((entry) =>
        entry.nodeIdentifier === nodeIdentifier
      ) ?? null;
    }
    if (address?.system === "output") {
      const target = state.targets.get(String(address.target));
      if (!target) {
        throw new RangeError(`Unknown raster target: ${address.target}`);
      }
      return target.outputLayers.get(Number(address.layer)) ?? null;
    }
    throw new RangeError(`Unknown document query system: ${address?.system}`);
  }

  async extract({
    address,
    constraint = "auto",
    instance = "instance-1",
    deviceScale = 1,
    ...options
  } = {}) {
    const effectiveInstance = this.#addressInstance(address, instance);
    const nodes = this.#resolveNodes(address, effectiveInstance);
    if (nodes.length !== 1) {
      throw new RangeError(
        "Extraction requires an address that resolves to one node.",
      );
    }
    const [root] = nodes;
    const resolution = await this.resolveViewport({
      constraint,
      instance: effectiveInstance,
      root,
      deviceScale,
      ...options,
    });
    const world = await this.layout({
      instance: effectiveInstance,
      root,
      environment: resolution.viewport,
    });
    return Object.freeze({
      kind: "document-extraction",
      version: 1,
      sizingSource: resolution.source,
      world,
    });
  }

  // The structure of one document instance, captured by the core
  // (core/engine/native-projections.watpart): a retained record that the
  // facade reads when a caller reads a field. The session releases its
  // snapshots at disposal; `snapshot.release()` frees one earlier.
  snapshot({
    address,
    instance = "instance-1",
    environment = { width: 1280, height: 720, deviceScale: 1 },
  } = {}) {
    const state = requiredState(this);
    const effectiveInstance = this.#addressInstance(address, instance);
    const current = state.instances.get(effectiveInstance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${effectiveInstance}`);
    }
    environmentKey(environment);
    const selectedNodes = address === undefined
      ? [current.document.documentElement]
      : this.#resolveNodes(address, effectiveInstance);
    if (selectedNodes.length !== 1) {
      throw new RangeError(
        "A document snapshot requires an address that resolves to one node.",
      );
    }
    const projection = captureDocumentStructure(current.document, {
      root: address === undefined ? null : selectedNodes[0],
      instance: effectiveInstance,
      revision: current.revision,
      environment,
      onRelease: (released) => state.projections.delete(released),
    });
    state.projections.add(projection);
    return projection;
  }

  // The layer metrics of the addressed nodes and their subtrees, as a
  // retained core record (src/dom/metrics-projection.js, version 3): their
  // layout boxes and their text chunks. The text chunks are the text
  // operations of the paint command record (inspectDocumentPaint). The
  // session releases its records at disposal; `metrics.release()` frees one
  // earlier.
  async metrics({
    address,
    constraint = "auto",
    instance = "instance-1",
    deviceScale = 1,
    ...options
  } = {}) {
    const state = requiredState(this);
    const effectiveInstance = this.#addressInstance(address, instance);
    const selectedNodes = this.#resolveNodes(address, effectiveInstance);
    if (selectedNodes.length === 0) {
      throw new RangeError(
        "Metrics require an address that resolves to at least one node.",
      );
    }
    const current = state.instances.get(effectiveInstance);
    const resolution = await this.resolveViewport({
      constraint,
      instance: effectiveInstance,
      deviceScale,
      ...options,
    });
    const world = await this.layout({
      instance: effectiveInstance,
      environment: resolution.viewport,
    });
    const projection = await captureDocumentMetrics(current.document, {
      selectedNodes,
      world,
      sizingSource: resolution.source,
      scrollbarStyle: this.scrollbarStyle,
      identify: (node) => this.#nodeIdentifier(node),
      onRelease: (released) => state.projections.delete(released),
    });
    state.projections.add(projection);
    return projection;
  }

  // The paint command record of the instance in `environment`
  // (src/dom/paint-projection.js): its operations, its compositing groups
  // and its scene tree, which comparePaintArtifacts aligns. The record
  // lives while the returned value is reachable; `paint.release()` frees
  // it earlier.
  async paint({ environment, instance = "instance-1" } = {}) {
    const state = requiredState(this);
    const current = state.instances.get(instance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${instance}`);
    }
    environmentKey(environment);
    const inspection = await inspectDocumentPaint(current.document.documentElement, environment, {
      scrollbarStyle: this.scrollbarStyle,
    });
    return inspection.paintArtifact;
  }

  async isolate({
    address,
    environment,
    instance = "instance-1",
  } = {}) {
    const state = requiredState(this);
    const effectiveInstance = this.#addressInstance(address, instance);
    const current = state.instances.get(effectiveInstance);
    if (!current) {
      throw new RangeError(`Unknown document instance: ${effectiveInstance}`);
    }
    environmentKey(environment);
    const selectedNodes = this.#resolveNodes(address, effectiveInstance);
    const includedNodes = new Set();
    for (const selectedNode of selectedNodes) {
      const pendingNodes = [selectedNode];
      while (pendingNodes.length > 0) {
        const node = pendingNodes.pop();
        if (includedNodes.has(node)) continue;
        includedNodes.add(node);
        pendingNodes.push(...node.childNodes);
      }
    }
    let inspection;
    if (address?.system === "output") {
      const target = state.targets.get(String(address.target));
      const layer = target?.outputLayers.get(Number(address.layer));
      if (!layer) {
        throw new RangeError(`Unknown output layer: ${address.layer}`);
      }
      inspection = layer.frame.inspection;
    } else {
      // The paint command record (inspectDocumentPaint).
      inspection = await inspectDocumentPaint(current.document.documentElement, environment, {
        scrollbarStyle: this.scrollbarStyle,
      });
    }
    // The core selects the subtrees of every included node that has a scene
    // row (paint_select), so a node without one keeps its descendants.
    const sceneRows = [];
    for (const node of includedNodes) {
      const index = inspection.elementAtIndex.indexOf(node);
      if (index >= 0) sceneRows.push(index);
    }
    const selected = selectPaintRecord(inspection.paintArtifact, sceneRows);
    let operations;
    let compositingGroups;
    let strippedCompositingGroups;
    try {
      operations = selected.operations.map((operation) => ({ ...operation }));
      compositingGroups = selected.compositingGroups;
      strippedCompositingGroups = selected.outsideCompositingGroups;
    } finally {
      selected.release();
    }
    return Object.freeze({
      kind: "document-in-place-isolation",
      version: 1,
      nodeIdentifiers: Object.freeze(
        selectedNodes.map((node) => this.#nodeIdentifier(node)),
      ),
      includedNodeIdentifiers: Object.freeze(
        [...includedNodes].map((node) => this.#nodeIdentifier(node)),
      ),
      operations: Object.freeze(operations.map((operation) =>
        Object.freeze({
          ...operation,
          nodeIdentifier: this.#nodeIdentifier(
            inspection.elementAtIndex[operation.nodeIndex],
          ),
        })
      )),
      compositingGroups: Object.freeze(
        compositingGroups.map((group) =>
          Object.freeze({
            ...group,
            nodeIdentifier: group.nodeIndex === null
              ? null
              : this.#nodeIdentifier(
                inspection.elementAtIndex[group.nodeIndex],
              ),
          })
        ),
      ),
      strippedCompositingGroups: Object.freeze(
        strippedCompositingGroups.map((group) =>
          Object.freeze({
            ...group,
            nodeIdentifier: group.nodeIndex === null
              ? null
              : this.#nodeIdentifier(
                inspection.elementAtIndex[group.nodeIndex],
              ),
          })
        ),
      ),
    });
  }

  async markSelection({
    addresses,
    environment,
    instance = "instance-1",
  } = {}) {
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new TypeError("Selection marks require one or more addresses.");
    }
    const effectiveInstances = new Set(
      addresses.map((address) => this.#addressInstance(address, instance)),
    );
    if (effectiveInstances.size !== 1) {
      throw new Error("One selection mark cannot span document instances.");
    }
    const effectiveInstance = [...effectiveInstances][0];
    const world = await this.layout({
      instance: effectiveInstance,
      environment,
    });
    const rectangles = [];
    for (const address of addresses) {
      for (const node of this.#resolveNodes(address, effectiveInstance)) {
        const nodeIdentifier = this.#nodeIdentifier(node);
        const layoutNode = world.layout.nodes.find((entry) =>
          entry.nodeIdentifier === nodeIdentifier
        );
        if (!layoutNode) continue;
        rectangles.push(Object.freeze({
          nodeIdentifier,
          rectangle: Object.freeze({ ...layoutNode.borderBox }),
        }));
      }
    }
    return Object.freeze({
      kind: "document-selection-mark",
      version: 1,
      worldKey: world.key,
      viewport: world.environment,
      rectangles: Object.freeze(rectangles),
    });
  }

  attachTarget(options = {}) {
    const state = requiredState(this);
    const identifier = `target-${state.nextTargetIdentifier++}`;
    const requestedPlacements = options.placements ?? [{
      instance: options.instance ?? "instance-1",
      environment: options.environment,
      root: options.root ?? null,
      x: 0,
      y: 0,
    }];
    if (
      !Array.isArray(requestedPlacements) || requestedPlacements.length === 0
    ) {
      throw new TypeError("A raster target requires one or more placements.");
    }
    const placements = requestedPlacements.map((placement, index) => {
      const instance = String(placement.instance ?? "instance-1");
      if (!state.instances.has(instance)) {
        throw new RangeError(`Unknown document instance: ${instance}`);
      }
      environmentKey(placement.environment);
      return Object.freeze({
        ...placement,
        identifier: String(placement.identifier ?? `placement-${index + 1}`),
        instance,
      });
    });
    if (
      new Set(placements.map(({ identifier }) => identifier)).size !==
        placements.length
    ) {
      throw new Error("Raster target placement identifiers must be unique.");
    }
    const interactionMode = options.interactionMode ?? "asset";
    if (!["asset", "real"].includes(interactionMode)) {
      throw new RangeError(`Unknown interaction mode: ${interactionMode}`);
    }
    const target = {
      identifier,
      placements: Object.freeze(placements),
      interactionMode,
      presentationRevision: 0,
      accessibilityRevision: 0,
      // Permanent per-target interaction counters
      // (design/interaction.md,
      // "Observability"). Exposed through inspectCurrent and every
      // dispatchInputBatch result; never reset while the target lives.
      interactionCounters: {
        batches: 0,
        records: 0,
        hitTests: 0,
        reResolvedBatches: 0,
        rejectedBatches: 0,
        lastRejectionReason: null,
        presentationRevisionRead: 0,
        presentationRevisionPublished: 0,
        dirtyPhysicalArea: 0,
        renderMilliseconds: 0,
      },
      surfaces: [],
      accessibilityNodesByPlacement: new Map(),
      outputLayers: new Map(),
      output: null,
      createSurface: options.createSurface ?? createRenderSurface,
      displacesRegisteredSurfaces: options.createSurface === undefined,
      surfaceOptions: {
        scrollbarStyle: this.scrollbarStyle,
        ...options.surfaceOptions,
      },
      width: options.width ?? null,
      height: options.height ?? null,
      // Texture delivery by default: each layer frame carries the
      // renderer's GPU texture image and `output.pixels` is null. A pixel
      // target reads every layer back and composites one CPU buffer.
      pixels: options.pixels === true,
    };
    state.targets.set(identifier, target);
    return identifier;
  }

  // Surfaces are RETAINED across renders and keyed per (root, environment):
  // many live surfaces coexist over one root at different environments
  // (the render-surface registry mirrors layout()'s per-(root, environment)
  // worlds). Retention is revision-correct without any shutdown pass:
  // instance mutations fan out to every live surface over the mutated
  // nodes' root, and renderNow() always delivers a fresh frame, so a
  // retained surface can never present pixels older than the instance
  // revision it claims. Two placements at the SAME (root, environment)
  // SERIALIZE: creating the newer surface shuts the occupant down first
  // (the surface constructor itself rejects an occupied key).
  async render(targetIdentifier, frameTransaction = null) {
    const state = requiredState(this);
    const target = state.targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    if (target._frameTransaction && target._frameTransaction !== frameTransaction) {
      return target.output;
    }
    if (frameTransaction) {
      target._frameTransaction = frameTransaction;
      if (!frameTransaction.targets.has(target)) frameTransaction.targets.set(target, null);
    }
    const surfaces = frameTransaction
      ? frameTransaction.workingSurfaces.get(target) ?? target.surfaces.slice()
      : target.surfaces;
    if (frameTransaction) frameTransaction.workingSurfaces.set(target, surfaces);
    const previousOutputLayers = new Map(target.outputLayers);
    const nextOutputLayers = new Map();
    const nextAccessibilityNodesByPlacement = new Map();
    const frames = [];
    for (let index = 0; index < target.placements.length; index++) {
      const placement = target.placements[index];
      const current = state.instances.get(placement.instance);
      if (!current) {
        throw new RangeError(
          `Unknown document instance: ${placement.instance}`,
        );
      }
      const root = placement.root ?? current.document.documentElement;
      // A connected subtree renders on a surface over its document, with
      // the subtree as the surface's selected root. A detached tree root
      // and the document element are surface roots of their own.
      const selectedRoot = placement.root &&
          placement.root !== current.document.documentElement &&
          placement.root.parentElement
        ? placement.root
        : null;
      const surfaceRoot = selectedRoot === null ? root : current.document.documentElement;
      const environment = placement.environment;
      const placementEnvironmentKey = environmentKey(environment);
      let surface = surfaces[index];
      let createdSurface = false;
      if (
        !surface ||
        surface._shutdown ||
        surface.root !== surfaceRoot ||
        surface.viewport.width !== environment.width ||
        surface.viewport.height !== environment.height ||
        surface.viewport.deviceScale !== (environment.deviceScale ?? 1)
      ) {
        if (surface && !surface._shutdown) {
          if (frameTransaction) frameTransaction.retired.add(surface);
          else await surface.shutdown();
        }
        // The default factory owns the root registry slot. A custom factory
        // owns its own lifecycle and can wrap an already registered surface,
        // so a FOREIGN registered surface is preserved. The target's OWN
        // surfaces still serialize: a duplicate (root, environment)
        // placement displaces this target's earlier occupant.
        const occupying = surfaceRoot._renderSurfaces?.get(placementEnvironmentKey);
        if (
          occupying && !occupying._shutdown &&
          (target.displacesRegisteredSurfaces ||
            surfaces.includes(occupying))
        ) {
          if (frameTransaction) frameTransaction.retired.add(occupying);
          else await occupying.shutdown();
          for (const candidate of state.targets.values()) {
            const candidateSurfaces = frameTransaction
              ? frameTransaction.workingSurfaces.get(candidate) ?? candidate.surfaces.slice()
              : candidate.surfaces;
            if (frameTransaction) frameTransaction.workingSurfaces.set(candidate, candidateSurfaces);
            const occupyingIndex = candidateSurfaces.indexOf(occupying);
            if (occupyingIndex !== -1) candidateSurfaces[occupyingIndex] = undefined;
          }
        }
        surface = target.createSurface(surfaceRoot, {
          viewportWidth: environment.width,
          viewportHeight: environment.height,
          deviceScale: environment.deviceScale ?? 1,
          capturePaintArtifact: true,
          ...target.surfaceOptions,
          frameTransaction,
        });
        surfaces[index] = surface;
        createdSurface = true;
      }
      if (selectedRoot !== null && typeof surface.setSelectedRoot !== "function") {
        throw new TypeError(
          `Placement ${placement.identifier} selects a subtree, and the surface of target ${target.identifier} has no setSelectedRoot().`,
        );
      }
      surface.setSelectedRoot?.(selectedRoot);
      if (frameTransaction) surface._beginFrameTransaction?.(frameTransaction);
      const documentRevision = current.revision;
      const interactionRevision = frameTransaction?.instances.get(current)?.interactionRevision ??
        current.interactionRevision;
      const frame = await surface.renderNow({
        pixels: target.pixels,
        _transaction: frameTransaction,
      }) ??
        previousOutputLayers.get(index)?.frame;
      if (!frame) {
        throw new Error(
          `Target ${target.identifier} produced no initial frame for placement ${placement.identifier}.`,
        );
      }
      if (createdSurface) surface.start();
      const accessibility = buildAccessibilitySnapshot({
        root,
        presentedFrame: frameTransaction
          ? surface._candidatePresentedFrame ?? surface.presentedFrame
          : surface.presentedFrame,
        identify: (node) => this.#nodeIdentifier(node),
        documentRevision,
        interactionRevision,
        presentationRevision: target.presentationRevision + 1,
        accessibilityRevision: target.accessibilityRevision + 1,
      });
      const layer = Object.freeze({
        layer: index,
        placement,
        frame,
        accessibility: accessibility.snapshot,
      });
      nextAccessibilityNodesByPlacement.set(
        placement.identifier,
        accessibility.nodeByIdentifier,
      );
      nextOutputLayers.set(index, layer);
      frames.push(layer);
    }
    const width = Number(
      target.width ?? Math.max(
        ...frames.map(({ placement, frame }) =>
          Number(placement.x ?? 0) + Number(frame.width ?? 0)
        ),
      ),
    );
    const height = Number(
      target.height ?? Math.max(
        ...frames.map(({ placement, frame }) =>
          Number(placement.y ?? 0) + Number(frame.height ?? 0)
        ),
      ),
    );
    const pixelConstructor = frames[0]?.frame.pixels?.constructor;
    const pixels = pixelConstructor &&
        frames.every(({ frame }) =>
          ArrayBuffer.isView(frame.pixels) &&
          frame.pixels.constructor === pixelConstructor
        )
      ? new pixelConstructor(width * height * 4)
      : null;
    if (pixels) {
      for (const { placement, frame } of frames) {
        const left = Number(placement.x ?? 0);
        const top = Number(placement.y ?? 0);
        if (!Number.isInteger(left) || !Number.isInteger(top)) {
          throw new RangeError(
            "Raster placement coordinates must be integers.",
          );
        }
        // rowStride counts BYTES; subarray indexes ELEMENTS. A float32 RGBA
        // frame carries width * 16 bytes per row, which is width * 4 elements.
        const byteStride = Number(
          frame.rowStride ?? frame.width * 4 * frame.pixels.BYTES_PER_ELEMENT,
        );
        const sourceStride = byteStride / frame.pixels.BYTES_PER_ELEMENT;
        for (let sourceY = 0; sourceY < frame.height; sourceY++) {
          const outputY = top + sourceY;
          if (outputY < 0 || outputY >= height) continue;
          const sourceLeft = Math.max(0, -left);
          const sourceRight = Math.min(frame.width, width - left);
          if (sourceRight <= sourceLeft) continue;
          const sourceOffset = sourceY * sourceStride + sourceLeft * 4;
          const outputOffset = (outputY * width + left + sourceLeft) * 4;
          pixels.set(
            frame.pixels.subarray(
              sourceOffset,
              sourceOffset + (sourceRight - sourceLeft) * 4,
            ),
            outputOffset,
          );
        }
      }
    }
    const output = Object.freeze({
      target: target.identifier,
      presentationRevision: target.presentationRevision + 1,
      accessibilityRevision: target.accessibilityRevision + 1,
      width,
      height,
      pixels,
      layers: Object.freeze(frames),
    });
    const publication = {
      presentationRevision: output.presentationRevision,
      accessibilityRevision: output.accessibilityRevision,
      outputLayers: nextOutputLayers,
      accessibilityNodesByPlacement: nextAccessibilityNodesByPlacement,
      output,
      surfaces,
    };
    if (frameTransaction) frameTransaction.targets.set(target, publication);
    else Object.assign(target, publication);
    return output;
  }

  async detachTarget(targetIdentifier) {
    const state = requiredState(this);
    const target = state.targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    state.targets.delete(String(targetIdentifier));
    target._frameTransaction = null;
    for (const surface of target.surfaces) {
      if (surface) await surface.shutdown();
    }
  }

  setInteractionMode(targetIdentifier, interactionMode) {
    const target = requiredState(this).targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    if (!["asset", "real"].includes(interactionMode)) {
      throw new RangeError(`Unknown interaction mode: ${interactionMode}`);
    }
    target.interactionMode = interactionMode;
    return this.targetStatus(targetIdentifier);
  }

  targetStatus(targetIdentifier) {
    const state = requiredState(this);
    const target = state.targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    return Object.freeze({
      target: target.identifier,
      interactionMode: target.interactionMode,
      presentationRevision: target.presentationRevision,
      accessibilityRevision: target.accessibilityRevision,
      placements: Object.freeze(
        target.placements.map((placement) =>
          Object.freeze({
            identifier: placement.identifier,
            instance: placement.instance,
            environment: Object.freeze({ ...placement.environment }),
            interactionRevision: state.instances.get(placement.instance)
              .interactionRevision,
          })
        ),
      ),
    });
  }

  async dispatchInputBatch({
    target: targetIdentifier,
    placement: placementIdentifier,
    records,
    expectedPresentationRevision,
    expectedInteractionRevision,
  }) {
    const state = requiredState(this);
    const operation = async () => {
      const operationStartedAt = hostNow();
      const target = state.targets.get(String(targetIdentifier));
      if (!target) {
        throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
      }
      const counters = target.interactionCounters;
      const reject = (message) => {
        counters.rejectedBatches += 1;
        counters.lastRejectionReason = message;
        throw new Error(message);
      };
      if (target.interactionMode !== "real") {
        reject(`Raster target ${target.identifier} is in Asset mode.`);
      }
      const placementIndex = target.placements.findIndex(({ identifier }) =>
        identifier === String(placementIdentifier)
      );
      if (placementIndex === -1) {
        throw new RangeError(
          `Unknown target placement: ${placementIdentifier}`,
        );
      }
      const placement = target.placements[placementIndex];
      const instance = state.instances.get(placement.instance);
      // Staleness rule ("Stable dispatch target"): an animated or pipelined
      // document advances revisions continuously, so an expected revision
      // that lags by exactly one in-flight frame re-resolves against the
      // current snapshot instead of rejecting. Anything older, or a claimed
      // future revision, rejects loudly.
      const presentationLag = target.presentationRevision -
        expectedPresentationRevision;
      if (presentationLag < 0 || presentationLag > 1) {
        reject(
          `Stale target presentation revision: expected ${target.presentationRevision}, received ${expectedPresentationRevision}`,
        );
      }
      const interactionLag = instance.interactionRevision -
        expectedInteractionRevision;
      if (interactionLag < 0 || interactionLag > 1) {
        reject(
          `Stale instance interaction revision: expected ${instance.interactionRevision}, received ${expectedInteractionRevision}`,
        );
      }
      if (presentationLag === 1 || interactionLag === 1) {
        counters.reResolvedBatches += 1;
      }
      counters.presentationRevisionRead = target.presentationRevision;
      const normalizedRecords = normalizeInputBatch(records);
      const currentAccessibility = target.outputLayers.get(placementIndex)
        ?.accessibility;
      for (const record of normalizedRecords) {
        if (record.kind !== "accessibility-action") continue;
        if (
          !currentAccessibility ||
          record.accessibilityRevision !==
            currentAccessibility.accessibilityRevision
        ) {
          reject(
            `Stale accessibility revision: expected ${
              currentAccessibility?.accessibilityRevision ?? "none"
            }, received ${record.accessibilityRevision}`,
          );
        }
        const semanticNode = currentAccessibility.nodes.find((node) =>
          node.identifier === record.nodeIdentifier
        );
        if (!semanticNode) {
          reject(`Unknown semantic node: ${record.nodeIdentifier}`);
        }
        if (!semanticNode.actions.includes(record.action)) {
          reject(
            `Semantic node ${record.nodeIdentifier} does not support ${record.action}`,
          );
        }
      }
      const bindingKey = `${target.identifier}:${placement.identifier}`;
      let backend = instance.interactionBackends.get(bindingKey);
      if (!backend) {
        await this.layout({
          instance: placement.instance,
          root: placement.root,
          environment: placement.environment,
        });
        backend = createSandomDOM({
          viewportW: placement.environment.width,
          viewportH: placement.environment.height,
          deviceScale: placement.environment.deviceScale ?? 1,
        });
        instance.interactionBackends.set(bindingKey, backend);
      }
      const layoutCompletedAt = hostNow();
      if (
        target.surfaces[placementIndex] === undefined ||
        target.surfaces[placementIndex]._shutdown
      ) {
        const precedingOutput = target.output;
        const precedingRevision = target.presentationRevision;
        await this.render(target.identifier);
        target.output = precedingOutput;
        target.presentationRevision = precedingRevision;
      }
      const root = placement.root ?? instance.document.documentElement;
      const outcomes = [];
      const dispatchRecords = normalizedRecords.map((record) => {
        if (record.kind !== "accessibility-action") return record;
        const semanticTarget = target.accessibilityNodesByPlacement
          .get(placement.identifier)?.get(record.nodeIdentifier);
        if (!semanticTarget) {
          throw new RangeError(`Unknown semantic node: ${record.nodeIdentifier}`);
        }
        return { ...record, target: semanticTarget };
      });
      this.mutate(() => {
        backend.dispatchInputRecords(root, dispatchRecords, {
          beforeRecord(record, index) {
            const activeBinding = instance.pointerBindings.get(record.pointerId);
            if (
              activeBinding !== undefined &&
              activeBinding !== bindingKey &&
              !["pointer-down", "wheel"].includes(record.kind)
            ) {
              throw new Error(
                `Pointer ${record.pointerId} belongs to ${activeBinding}; input cannot retarget it to ${bindingKey}`,
              );
            }
            if (record.kind === "pointer-down" && activeBinding !== undefined) {
              throw new Error(`Pointer ${record.pointerId} is already active.`);
            }
            logInteraction(instance.document, records[index]);
          },
          afterRecord: (record, _index, result, scrolled) => {
            if (record.kind === "pointer-down" && result) {
              instance.pointerBindings.set(record.pointerId, bindingKey);
            } else if (
              record.kind === "pointer-up" || record.kind === "pointer-cancel" ||
              record.kind === "pointer-leave"
            ) {
              instance.pointerBindings.delete(record.pointerId);
            }
            const resultTarget = result?.target ?? result;
            outcomes.push(Object.freeze({
              kind: record.kind,
              targetIdentifier: resultTarget
                ? this.#nodeIdentifier(resultTarget)
                : null,
              scrolled,
            }));
          },
        });
      }, { instance: placement.instance, origin: "input" });
      const mutationCompletedAt = hostNow();
      const affectedTargets = [...state.targets.values()].filter((candidate) =>
        candidate.placements.some(({ instance: candidateInstance }) =>
          candidateInstance === placement.instance
        )
      );
      const frameTransaction = createFrameTransaction();
      frameTransaction.instances.set(instance, {
        interactionRevision: instance.interactionRevision + 1,
      });
      for (const candidate of affectedTargets) {
        candidate._frameTransaction = frameTransaction;
        frameTransaction.targets.set(candidate, null);
      }
      let renderCompletedAt;
      let outputs;
      try {
        outputs = [];
        for (const candidate of affectedTargets) {
          outputs.push(await this.render(candidate.identifier, frameTransaction));
        }
        await commitFrameTransaction(frameTransaction);
        renderCompletedAt = hostNow();
      } catch (error) {
        if (!frameTransaction.committed) {
          await abortFrameTransaction(frameTransaction);
        }
        throw error;
      }
      const lastPoint = [...normalizedRecords].reverse().find((record) =>
        Number.isFinite(record.x) && Number.isFinite(record.y)
      );
      counters.batches += 1;
      counters.records += normalizedRecords.length;
      // One hit test per pointer or wheel record, plus one post-render hit
      // test when a cursor resolves against the successor frame.
      counters.hitTests += normalizedRecords.filter((record) =>
        Number.isFinite(record.x) && Number.isFinite(record.y)
      ).length + (lastPoint ? 1 : 0);
      counters.presentationRevisionPublished = target.presentationRevision;
      counters.dirtyPhysicalArea += outputs
        .flatMap((output) => output.layers)
        .flatMap(({ frame }) => frame.dirtyRectangles ?? [])
        .reduce(
          (area, rectangle) => area + rectangle.width * rectangle.height,
          0,
        );
      counters.renderMilliseconds += renderCompletedAt - mutationCompletedAt;
      const accessibility = target.outputLayers.get(placementIndex)
        .accessibility;
      const precedingByIdentifier = new Map(
        (currentAccessibility?.nodes ?? []).map((node) => [
          node.identifier,
          node,
        ]),
      );
      const changedControlStates = accessibility.nodes.flatMap((node) => {
        const preceding = precedingByIdentifier.get(node.identifier);
        const changed = !preceding ||
          preceding.value !== node.value ||
          preceding.checked !== node.checked ||
          preceding.pressed !== node.pressed ||
          preceding.expanded !== node.expanded ||
          preceding.selected !== node.selected ||
          preceding.disabled !== node.disabled ||
          preceding.focused !== node.focused;
        return changed
          ? [Object.freeze({
            nodeIdentifier: node.identifier,
            value: node.value,
            checked: node.checked,
            pressed: node.pressed,
            expanded: node.expanded,
            selected: node.selected,
            disabled: node.disabled,
            focused: node.focused,
          })]
          : [];
      });
      return Object.freeze({
        target: target.identifier,
        placement: placement.identifier,
        instance: placement.instance,
        interactionRevision: instance.interactionRevision,
        presentationRevision: target.presentationRevision,
        accessibilityRevision: target.accessibilityRevision,
        focusIdentifier: instance.document._focusedElement
          ? this.#nodeIdentifier(instance.document._focusedElement)
          : null,
        changedControlStates: Object.freeze(changedControlStates),
        accessibility,
        cursor: lastPoint
          ? backend.resolveCursor(root, lastPoint.x, lastPoint.y)
          : "default",
        activePointerIdentifiers: Object.freeze([
          ...instance.pointerBindings.keys(),
        ]),
        outcomes: Object.freeze(outcomes),
        counters: Object.freeze({ ...counters }),
        timings: Object.freeze({
          layoutMilliseconds: layoutCompletedAt - operationStartedAt,
          dispatchMilliseconds: mutationCompletedAt - layoutCompletedAt,
          renderMilliseconds: renderCompletedAt - mutationCompletedAt,
          totalMilliseconds: renderCompletedAt - operationStartedAt,
        }),
        outputs: Object.freeze(outputs),
      });
    };
    const result = state.operationChain.then(operation, operation);
    state.operationChain = result.then(() => undefined, () => undefined);
    return await result;
  }

  async resetInteraction(instanceIdentifier = "instance-1") {
    const state = requiredState(this);
    const identifier = String(instanceIdentifier);
    const operation = async () => {
      const current = state.instances.get(identifier);
      if (!current) {
        throw new RangeError(`Unknown document instance: ${identifier}`);
      }
      const document = clonePreparedDocument({
        ...state.preparedInput,
        document: state.baselineDocument,
      });
      const attributes = current.creationAttributes;
      for (const [name, value] of Object.entries(attributes)) {
        document.documentElement.setAttribute(name, value);
      }
      // The replaced instance ends its retained steps as cancelled.
      current.retained?.dispose();
      state.instances.delete(identifier);
      this.#addInstance(identifier, document);
      state.instances.get(identifier).creationAttributes = attributes;
      const outputs = [];
      for (const target of state.targets.values()) {
        if (
          !target.placements.some(({ instance }) => instance === identifier)
        ) continue;
        if (
          target.placements.some(({ instance, root }) =>
            instance === identifier && root !== null && root !== undefined
          )
        ) {
          throw new Error(
            `Cannot reset ${identifier} while a placement addresses an explicit root.`,
          );
        }
        outputs.push(await this.render(target.identifier));
      }
      return Object.freeze({
        instance: identifier,
        interactionRevision: 0,
        outputs: Object.freeze(outputs),
      });
    };
    const result = state.operationChain.then(operation, operation);
    state.operationChain = result.then(() => undefined, () => undefined);
    return await result;
  }

  inspectCurrent({ target: targetIdentifier, placement: placementIdentifier }) {
    const state = requiredState(this);
    const target = state.targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    const placementIndex = target.placements.findIndex(({ identifier }) =>
      identifier === String(placementIdentifier)
    );
    if (placementIndex === -1) {
      throw new RangeError(`Unknown target placement: ${placementIdentifier}`);
    }
    const placement = target.placements[placementIndex];
    const instance = state.instances.get(placement.instance);
    const layer = target.outputLayers.get(placementIndex);
    if (!layer) {
      throw new Error(`Target ${target.identifier} has no published frame.`);
    }
    const surface = target.surfaces[placementIndex];
    const scrollbars = layer.frame.scrollbars ?? surface?.scrollbars ?? [];
    return Object.freeze({
      kind: "document-live-inspection",
      version: 1,
      target: target.identifier,
      placement: placement.identifier,
      interaction: Object.freeze({ ...target.interactionCounters }),
      instance: placement.instance,
      environment: Object.freeze({ ...placement.environment }),
      documentRevision: instance.revision,
      interactionRevision: instance.interactionRevision,
      presentationRevision: target.presentationRevision,
      accessibilityRevision: target.accessibilityRevision,
      focusIdentifier: instance.document._focusedElement
        ? this.#nodeIdentifier(instance.document._focusedElement)
        : null,
      accessibility: layer.accessibility,
      frame: Object.freeze({
        width: layer.frame.width,
        height: layer.frame.height,
        time: layer.frame.time ?? null,
        dirtyRectangles: Object.freeze(
          (layer.frame.dirtyRectangles ?? []).map((rectangle) =>
            Object.freeze({ ...rectangle })
          ),
        ),
        readbackByteLength: layer.frame.readbackByteLength ?? null,
        scrollbars: Object.freeze(scrollbars.map((scrollbar) =>
          Object.freeze({
            orientation: scrollbar.orientation,
            value: scrollbar.value,
            minimum: scrollbar.minimum,
            maximum: scrollbar.maximum,
            range: scrollbar.range,
            viewportLength: scrollbar.viewportLength,
            scrollLength: scrollbar.scrollLength,
            track: Object.freeze({ ...scrollbar.track }),
            thumb: Object.freeze({ ...scrollbar.thumb }),
          })
        )),
        interactiveTextGeometry: Object.freeze(
          [...(surface?.presentedFrame?.textGeometryByElement ?? [])].map(
            ([element, geometry]) => Object.freeze({
              nodeIdentifier: this.#nodeIdentifier(element),
              caretStops: geometry.caretStops,
              selectionStart: geometry.selectionStart,
              selectionEnd: geometry.selectionEnd,
              selectionRectangles: surface.presentedFrame.selectionRectanglesByElement.get(element) ?? Object.freeze([]),
            }),
          ),
        ),
      }),
    });
  }

  captureCurrent(targetIdentifier) {
    const state = requiredState(this);
    const target = state.targets.get(String(targetIdentifier));
    if (!target) {
      throw new RangeError(`Unknown raster target: ${targetIdentifier}`);
    }
    if (!target.output) {
      throw new Error(`Target ${target.identifier} has no published frame.`);
    }
    return Object.freeze({
      kind: "document-current-frame",
      version: 1,
      target: target.identifier,
      presentationRevision: target.presentationRevision,
      placements: Object.freeze(
        target.placements.map((placement) =>
          Object.freeze({
            placement: placement.identifier,
            instance: placement.instance,
            interactionRevision:
              state.instances.get(placement.instance).interactionRevision,
          })
        ),
      ),
      width: target.output.width,
      height: target.output.height,
      pixels: target.output.pixels,
      // A texture target has no pixels: its placements' frames carry the
      // GPU textures that a presenter draws.
      layers: target.output.layers,
    });
  }

  async inspect(request = {}) {
    const state = requiredState(this);
    return await inspectPreparedInput(
      state.preparedInput,
      this.#withScrollbarStyle(request),
    );
  }

  async plan(request = {}) {
    const state = requiredState(this);
    const { planRenderInput } = await import("./render-planning.js");
    return await planRenderInput(
      state.preparedInput,
      this.#withScrollbarStyle(request),
    );
  }

  // A render plan carries its own scrollbarStyle; an exact request takes
  // the session style unless it names one.
  async renderOnce(request = {}) {
    const state = requiredState(this);
    return await renderPreparedInput(
      state.preparedInput,
      request?.kind === "render-plan"
        ? request
        : this.#withScrollbarStyle(request),
    );
  }

  async dispose() {
    const state = requiredState(this);
    // Every queued and running step ends as cancelled first.
    for (const instance of state.instances.values()) instance.retained?.dispose();
    for (const projection of state.projections) projection.release();
    state.disposed = true;
    for (const surface of state.projectionSurfaces.values()) await surface.shutdown();
    state.projectionSurfaces.clear();
    for (const target of state.targets.values()) {
      for (const surface of target.surfaces) {
        if (surface) await surface.shutdown();
      }
    }
    state.targets.clear();
    await state.preparedInput.release();
  }

  // The retained instance of a document instance, made at its first use.
  #retainedInstance(identifier) {
    const state = requiredState(this);
    const current = state.instances.get(String(identifier));
    if (!current) {
      throw new RangeError(`Unknown document instance: ${identifier}`);
    }
    current.retained ??= createRetainedInstance({
      core: current.document._domCore,
      runOperation: (operation) => {
        if (state.disposed) {
          return Promise.reject(new Error("The document session is disposed."));
        }
        const result = state.operationChain.then(operation, operation);
        state.operationChain = result.then(() => undefined, () => undefined);
        return result;
      },
      apply: (applicator, context) =>
        applicator(Object.freeze({ document: current.document }), context),
      // A projection of the live document: the subtree of `root`, or the
      // whole document.
      capture: async (kind, { root, layer, environment, placement }) => {
        const address = root === null ? undefined : { system: "dom", nodeIdentifier: this.#nodeIdentifier(root) };
        if (kind === "structure") {
          return this.snapshot({ address, instance: identifier, environment });
        }
        if (kind === "paint") {
          return captureDocumentPaint(current.document, {
            root,
            environment,
            scrollbarStyle: this.scrollbarStyle,
            identify: (node) => this.#nodeIdentifier(node),
          });
        }
        if (kind === "raster") {
          return captureDocumentRaster(current.document, {
            root,
            environment,
            placement,
            layer,
            surfaces: state.projectionSurfaces,
            scrollbarStyle: this.scrollbarStyle,
            identify: (node) => this.#nodeIdentifier(node),
          });
        }
        return this.metrics({
          address: address ?? { system: "dom" },
          instance: identifier,
          constraint: { width: environment.width, height: environment.height },
          deviceScale: environment.deviceScale,
        });
      },
      replace: async () => {
        if (state.baselineDocument === null) {
          throw new Error(
            "A document with custom elements cannot reset: its prepared source cannot be cloned. Create a new document session.",
          );
        }
        for (const target of state.targets.values()) {
          if (
            target.placements.some(({ instance, root }) =>
              instance === identifier && root !== null && root !== undefined
            )
          ) {
            throw new Error(
              `Cannot reset ${identifier} while a placement addresses an explicit root.`,
            );
          }
        }
        const document = clonePreparedDocument({
          ...state.preparedInput,
          document: state.baselineDocument,
        });
        for (const [name, value] of Object.entries(current.creationAttributes)) {
          document.documentElement.setAttribute(name, value);
        }
        current.document = document;
        this.#startSpan(document);
      },
      // Document writes are open from the start of the step to its end, so
      // an update that settles later can write.
      // A reset replaces the document during the step: the step closes
      // the scope of the document it opened.
      stepStarted() {
        current.scopedDocument = current.document;
        openDocumentScope(current.scopedDocument, "script");
      },
      stepEnded() {
        closeDocumentScope(current.scopedDocument);
        current.scopedDocument = null;
        current.revision += 1;
        current.worlds.clear();
      },
    });
    return current.retained;
  }

  #withScrollbarStyle(request) {
    const style = requiredState(this).scrollbarStyle;
    return style === undefined || request.scrollbarStyle !== undefined
      ? request
      : { ...request, scrollbarStyle: style };
  }

  #addInstance(identifier, document) {
    const state = SESSION_STATE.get(this);
    const instance = {
      document,
      creationAttributes: Object.freeze({}),
      revision: 0,
      interactionRevision: 0,
      worlds: new Map(),
      interactionBackends: new Map(),
      pointerBindings: new Map(),
    };
    state.instances.set(identifier, instance);
    this.#startSpan(instance.document);
  }

  // Gates the document, so a write outside mutate() or a transition step
  // throws, and starts its log with the session's source.
  #startSpan(document) {
    gateDocument(document, true);
    loadDocumentLog(document, requiredState(this).preparedInput.sourceBytes);
  }

  #addressInstance(address, fallback) {
    if (address?.system !== "output") return fallback;
    const state = requiredState(this);
    const target = state.targets.get(String(address.target));
    const layer = target?.outputLayers.get(Number(address.layer));
    if (!layer) {
      throw new RangeError(`Unknown output layer: ${address.layer}`);
    }
    return layer.placement.instance ?? fallback;
  }

  #resolveNodes(address, instanceIdentifier) {
    const state = requiredState(this);
    const instance = state.instances.get(instanceIdentifier);
    if (!instance) {
      throw new RangeError(`Unknown document instance: ${instanceIdentifier}`);
    }
    if (typeof address === "string") {
      return [...instance.document.querySelectorAll(address)];
    }
    if (address?.system === "dom") {
      if (address.nodeIdentifier !== undefined) {
        return [this.#nodeOf(instance.document, address.nodeIdentifier)];
      }
      return address.selector === undefined
        ? [instance.document.documentElement]
        : [...instance.document.querySelectorAll(String(address.selector))];
    }
    if (address?.system === "layout") {
      const world = instance.worlds.get(String(address.worldKey));
      if (!world) {
        throw new RangeError(`Unknown layout world: ${address.worldKey}`);
      }
      const node = this.#nodeOf(instance.document, address.nodeIdentifier);
      if (!world.layout.nodes.some((entry) => entry.nodeIdentifier === address.nodeIdentifier)) {
        throw new RangeError(
          `Unknown node in layout world: ${address.nodeIdentifier}`,
        );
      }
      return [node];
    }
    if (address?.system === "output") {
      const target = state.targets.get(String(address.target));
      if (!target) {
        throw new RangeError(`Unknown raster target: ${address.target}`);
      }
      const layer = target.outputLayers.get(Number(address.layer));
      if (!layer) {
        throw new RangeError(`Unknown output layer: ${address.layer}`);
      }
      if (address.nodeIdentifier !== undefined) {
        return [this.#nodeOf(instance.document, address.nodeIdentifier)];
      }
      return [layer.placement.root ?? instance.document.documentElement];
    }
    throw new RangeError(`Unknown document address system: ${address?.system}`);
  }

  // The core's durable identifier of `node` (core/dom/node-identity.watpart).
  #nodeIdentifier(node) {
    return node._domCore.nodeIdentifier(node._coreHandle);
  }

  // The live node of durable identifier `identifier` in `document`.
  #nodeOf(document, identifier) {
    if (!Number.isInteger(identifier) || identifier < 1) {
      throw new TypeError(`A node identifier is a positive integer; received ${String(identifier)}`);
    }
    const node = document._domCore.nodeByIdentifier(document._coreHandle, identifier);
    if (!node) throw new RangeError(`Unknown node: ${identifier}`);
    return node;
  }
}

export async function createDocumentSession(input, options = {}) {
  const { scrollbarStyle, ...preparationOptions } = options;
  if (scrollbarStyle !== undefined) {
    assertScrollbarStyle(scrollbarStyle, "document session options");
  }
  const preparedInput = input?.document && typeof input.release === "function"
    ? input
    : await prepareRenderInput(input, preparationOptions);
  return new DocumentSession(preparedInput, { scrollbarStyle });
}

// One-shot entries over one DocumentSession. They live beside the session
// so render-animation.js, which the session builds on, never imports it
// back (test/dom-core/module_graph_test.js).
export async function renderAnimationInput(input, options = {}) {
  const {
    preprocessors = [],
    preprocessor,
    host,
    ...renderRequest
  } = options;
  const preparedInput = await prepareRenderInput(input, {
    preprocessors,
    preprocessor,
    host,
  });
  const session = new DocumentSession(preparedInput);
  try {
    return await session.renderOnce(renderRequest);
  } finally {
    await session.dispose();
  }
}

export async function inspectAnimationInput(input, options = {}) {
  const {
    preprocessors = [],
    preprocessor,
    host,
    ...inspectionRequest
  } = options;
  const preparedInput = await prepareRenderInput(input, {
    preprocessors,
    preprocessor,
    host,
  });
  const session = new DocumentSession(preparedInput);
  try {
    return await inspectAnimationPreparedInput(
      preparedInput,
      inspectionRequest,
    );
  } finally {
    await session.dispose();
  }
}
