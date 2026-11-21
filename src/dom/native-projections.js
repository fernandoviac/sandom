// Facades of the native projections (core/engine/native-projections.watpart).
// A projection is one immutable record in the renderer core's memory that
// the core captured; a facade holds its handle and reads the record when a
// caller reads a field. Nothing builds the record's tree before a caller
// asks for it. Release frees the record; a later read throws.
import { layoutConstant } from "../wasm/layout-table.js";
import { identifyCore } from "./core-identity.js";

const KIND_STRUCTURE = layoutConstant("PROJECTION_KIND_STRUCTURE");
// For each projection kind: the DocumentSession method that captures it
// and the core export that writes its comparison input.
const KIND_SOURCES = new Map([
  [KIND_STRUCTURE, { method: "snapshot", encoder: "structure_encode" }],
  [layoutConstant("PROJECTION_KIND_METRICS"), { method: "metrics", encoder: "metrics_encode" }],
  [layoutConstant("PROJECTION_KIND_PAINT"), { method: "paint", encoder: "paint_encode" }],
]);
const structure = (name) => layoutConstant(`STRUCTURE_${name}`);
const HEADER = Object.freeze(Object.fromEntries([
  "NODE_COUNT", "NODES", "ATTRIBUTES", "CHILDREN", "ROOT", "REVISION", "INSTANCE", "INSTANCE_LENGTH", "HTML",
  "HTML_LENGTH",
].map((name) => [name, structure(`HEADER_${name}`)])));
const NODE = Object.freeze(Object.fromEntries([
  "SIZE", "SCENE", "PARENT", "CHILD_FIRST", "CHILD_COUNT", "SOURCE", "NAME", "NAME_LENGTH", "NAMESPACE",
  "NAMESPACE_LENGTH",
  "ATTRIBUTE_FIRST", "ATTRIBUTE_COUNT",
].map((name) => [name, structure(`NODE_${name}`)])));
const ATTRIBUTE = Object.freeze(Object.fromEntries([
  "SIZE", "NAME", "NAME_LENGTH", "VALUE", "VALUE_LENGTH", "NAMESPACE", "NAMESPACE_LENGTH", "PREFIX", "PREFIX_LENGTH",
].map((name) => [name, structure(`ATTRIBUTE_${name}`)])));
const SOURCE = Object.freeze({
  ELEMENT: structure("SOURCE_ELEMENT"),
  TEXT: structure("SOURCE_TEXT"),
  VIEWPORT: structure("SOURCE_VIEWPORT"),
});
const ARTIFACT_VERSION = structure("ARTIFACT_VERSION");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The projection facades of each core, by handle, for the comparison
// binding: a facade is accepted only when its core made it.
const facadeHandles = new WeakMap();

// Records that `facade` holds `handle` of `kind` in `core`.
export function registerProjectionFacade(facade, core, handle, kind) {
  facadeHandles.set(facade, { core, handle, kind });
}

// The core and handle of a projection facade of `kind`; throws for any
// other value.
export function projectionHandle(value, kind, label) {
  const entry = facadeHandles.get(value);
  if (entry === undefined || entry.kind !== kind) {
    throw new TypeError(`${label} takes a projection that DocumentSession.${KIND_SOURCES.get(kind).method}() captured; received ${value === null ? "null" : typeof value}`);
  }
  return entry;
}

// The string whose block-relative offset is at `record + field` and whose
// byte length is at `record + lengthField`.
function stringAt(view, block, record, field, lengthField) {
  return view.memoryText(decoder, block + view.getUint32(record + field, true), view.getInt32(record + lengthField, true));
}

function nullableStringAt(view, block, record, field, lengthField) {
  return view.getInt32(record + lengthField, true) === 0 ? null : stringAt(view, block, record, field, lengthField);
}

const identifier = (sceneIndex) => `scene-node-${sceneIndex}`;

// The facade of a structure projection: the fields of the snapshot
// artifact (kind "document-html-snapshot", version 2), read from the
// record.
function structureFacade(core, handle, onRelease) {
  let released = false;
  let nodes = null;
  // The record's block and a checked view of it, taken fresh at each read.
  const record = () => {
    const block = core.status("projection_block", handle, KIND_STRUCTURE);
    return { block, view: core.resultMemory("projection_block") };
  };
  const readNodes = () => {
    const { block, view } = record();
    const nodeBase = block + view.getUint32(block + HEADER.NODES, true);
    const childBase = block + view.getUint32(block + HEADER.CHILDREN, true);
    const attributeBase = block + view.getUint32(block + HEADER.ATTRIBUTES, true);
    const count = view.getUint32(block + HEADER.NODE_COUNT, true);
    const result = new Array(count);
    for (let index = 0; index < count; index++) {
      const row = nodeBase + index * NODE.SIZE;
      const sceneIndex = view.getUint32(row + NODE.SCENE, true);
      const parent = view.getInt32(row + NODE.PARENT, true);
      const childFirst = view.getUint32(row + NODE.CHILD_FIRST, true);
      const childIdentifiers = new Array(view.getUint32(row + NODE.CHILD_COUNT, true));
      for (let child = 0; child < childIdentifiers.length; child++) {
        childIdentifiers[child] = identifier(view.getUint32(childBase + (childFirst + child) * 4, true));
      }
      const sourceKind = view.getUint32(row + NODE.SOURCE, true);
      let source;
      if (sourceKind === SOURCE.ELEMENT) {
        const attributeFirst = view.getUint32(row + NODE.ATTRIBUTE_FIRST, true);
        const attributes = new Array(view.getUint32(row + NODE.ATTRIBUTE_COUNT, true));
        for (let attribute = 0; attribute < attributes.length; attribute++) {
          const at = attributeBase + (attributeFirst + attribute) * ATTRIBUTE.SIZE;
          attributes[attribute] = Object.freeze({
            name: stringAt(view, block, at, ATTRIBUTE.NAME, ATTRIBUTE.NAME_LENGTH),
            value: stringAt(view, block, at, ATTRIBUTE.VALUE, ATTRIBUTE.VALUE_LENGTH),
            namespace: nullableStringAt(view, block, at, ATTRIBUTE.NAMESPACE, ATTRIBUTE.NAMESPACE_LENGTH),
            prefix: nullableStringAt(view, block, at, ATTRIBUTE.PREFIX, ATTRIBUTE.PREFIX_LENGTH),
          });
        }
        source = {
          kind: "element",
          localName: stringAt(view, block, row, NODE.NAME, NODE.NAME_LENGTH),
          namespace: nullableStringAt(view, block, row, NODE.NAMESPACE, NODE.NAMESPACE_LENGTH),
          attributes: Object.freeze(attributes),
        };
      } else if (sourceKind === SOURCE.TEXT) {
        source = { kind: "text", text: stringAt(view, block, row, NODE.NAME, NODE.NAME_LENGTH) };
      } else {
        const viewport = sourceKind === SOURCE.VIEWPORT;
        source = {
          kind: viewport ? "viewport" : "generated",
          generated: !viewport,
          display: view.getInt32(row + NODE.NAME_LENGTH, true) < 0
            ? undefined
            : stringAt(view, block, row, NODE.NAME, NODE.NAME_LENGTH),
        };
      }
      result[index] = Object.freeze({
        identifier: identifier(sceneIndex),
        sceneIndex,
        parentIdentifier: parent < 0 ? null : identifier(parent),
        childIdentifiers: Object.freeze(childIdentifiers),
        source: Object.freeze(source),
      });
    }
    return Object.freeze(result);
  };
  const facade = Object.freeze({
    kind: "document-html-snapshot",
    version: ARTIFACT_VERSION,
    get instance() {
      const { block, view } = record();
      return stringAt(view, block, block, HEADER.INSTANCE, HEADER.INSTANCE_LENGTH);
    },
    get revision() {
      const { block, view } = record();
      return view.getInt32(block + HEADER.REVISION, true);
    },
    get rootIdentifier() {
      const { block, view } = record();
      return identifier(view.getUint32(block + HEADER.ROOT, true));
    },
    get html() {
      const { block, view } = record();
      return stringAt(view, block, block, HEADER.HTML, HEADER.HTML_LENGTH);
    },
    // The node rows, in scene order. The first read builds them; a read
    // after release throws.
    get nodes() {
      if (nodes === null) nodes = readNodes();
      else record();
      return nodes;
    },
    // The handle of the record in its core.
    get handle() {
      return handle;
    },
    // Frees the record. A second release throws.
    release() {
      core.status("projection_release", handle, KIND_STRUCTURE);
      released = true;
      onRelease?.(facade);
    },
    get released() {
      return released;
    },
  });
  registerProjectionFacade(facade, core, handle, KIND_STRUCTURE);
  return facade;
}

// Captures the structure of `document` from `selected` (a node, or null
// for the whole document). The host prepares the document as a scene
// serialization does (viewport, media environment, declared font
// families); the core builds the scene, captures the record, and asks for
// a publication when the subtree holds an SVG use instance, whose display
// comes from its engine record.
export function captureStructure(document, {
  selected,
  instance,
  revision,
  environment,
  publish,
  onRelease,
}) {
  const core = document._domCore;
  identifyCore(core);
  const root = document.documentElement;
  const htmlNode = selected ?? document;
  const capture = (publication) => {
    const [instancePointer, instanceLength] = core.byteInput(encoder.encode(instance));
    return core.statusRaw(
      "structure_capture",
      root._coreHandle,
      selected === null ? 0n : selected._coreHandle,
      htmlNode._coreHandle,
      publication,
      revision,
      instancePointer,
      instanceLength,
      environment.width,
      environment.height,
      environment.deviceScale ?? 1,
    );
  };
  let handle = capture(0);
  if (handle === 0n) {
    const publication = publish(root);
    try {
      handle = capture(publication);
    } finally {
      core.status("engine_record_release", publication);
    }
  }
  return structureFacade(core, handle, onRelease);
}

// The comparison input of a projection of `kind` as one host value, in the
// bytes that the comparison module reads (src/wasm/host-values.js). The
// core writes it.
export function projectionHostValue(projection, kind, label) {
  const { core, handle } = projectionHandle(projection, kind, label);
  const encoder = KIND_SOURCES.get(kind).encoder;
  const length = core.status(encoder, handle);
  return length === 0 ? new Uint8Array(0) : core.outputBytes(encoder, 0, length);
}

export { KIND_STRUCTURE };
