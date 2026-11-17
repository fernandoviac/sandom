// The one upload of authored Scene values. This format contains no engine
// offsets, enums, records, pools, defaults, or normalized CSS values. Native
// direct-input.watpart owns interpretation and publication.
import { layoutConstant } from "../wasm/layout-table.js";

const VALUE = Object.fromEntries(["SIZE", "KIND", "PAYLOAD", "COUNT", "NUMBER", "KEY", "KEY_LENGTH"]
  .map((name) => [name, layoutConstant(`AUTHORED_VALUE_${name}`)]));
const KIND = Object.fromEntries(["UNDEFINED", "NUMBER", "TEXT", "BOOLEAN", "OBJECT", "ARRAY"]
  .map((name) => [name, layoutConstant(`AUTHORED_KIND_${name}`)]));
const INPUT = Object.fromEntries(["MAGIC", "HEADER_MAGIC", "HEADER_COUNT", "HEADER_STRING_BYTES", "HEADER_SIZE"]
  .map((name) => [name, layoutConstant(`AUTHORED_INPUT_${name}`)]));
const ROW = Object.fromEntries(["SIZE", "SOURCE", "VALUE", "RECORD", "INDEX_SPACE_CHANGED"]
  .map((name) => [name, layoutConstant(`AUTHORED_ROW_${name}`)]));
const ERROR_KIND_ERROR = layoutConstant("ERROR_KIND_ERROR");
const utf8 = new TextEncoder();
// The member names that cross for scope 0 (a scene) or 1 (image
// preparation), per core (engine_direct_field_names).
const fieldNameSets = new WeakMap();
function fieldNames(core, scope) {
  let sets = fieldNameSets.get(core);
  if (!sets) {
    sets = [0, 1].map((each) => new Set(core.string("engine_direct_field_names", each).split(" ")));
    fieldNameSets.set(core, sets);
  }
  return sets[scope];
}

export function publishDirectSceneInput(core, nodes, patchIndex = null, rowRevision = 0) {
  return submitDirectSceneInput(core, nodes, patchIndex, rowRevision, null);
}

// Image preparation uses the same bounded tagged-value transport. Only raw
// resource fields cross; native code selects usages and requests host effects.
export function prepareImageSceneInput(core, nodes, scope) {
  // These are host resource requests, not scene rows. Keep their payload
  // separate so a retained row can never enter the generic scene encoder.
  const resources = nodes.map((node) => {
    const resource = {};
    for (const name of fieldNames(core, 1)) {
      if (node[name] !== undefined) resource[name] = node[name];
    }
    return resource;
  });
  return submitDirectSceneInput(core, resources, null, 0, scope);
}

const authoredPublications = new FinalizationRegistry(({ core, handle }) => {
  core.engineRecordRelease(handle);
});
const decoder = new TextDecoder();

// Copy native preparation facts. Source indices join opaque host resources;
// they do not select ordering, expansion, defaults or rendering values.
export function prepareAuthoredSceneInput(core, nodes, fontRegistry) {
  if (nodes._corePublication || (nodes.length && nodes.every((node) => node._coreBox !== undefined))) return nodes;
  const handle = submitDirectSceneInput(core, nodes, null, 0, null, true);
  const publication = { core, handle, fontRegistry, boxes: [], authored: true };
  try {
    const count = core.status("engine_authored_rows", handle);
    const pointer = core.exports.abi_output_pointer();
    const bytes = core.refreshBytes();
    const view = new DataView(bytes.buffer);
    const text = (pointer, length) => decoder.decode(bytes.subarray(pointer, pointer + length));
    const decode = (pointer) => {
      const kind = view.getUint32(pointer + VALUE.KIND, true);
      if (kind === KIND.UNDEFINED) return undefined;
      if (kind === KIND.NUMBER) return view.getFloat64(pointer + VALUE.NUMBER, true);
      if (kind === KIND.BOOLEAN) return view.getFloat64(pointer + VALUE.NUMBER, true) !== 0;
      const payload = view.getUint32(pointer + VALUE.PAYLOAD, true);
      const count = view.getUint32(pointer + VALUE.COUNT, true);
      if (kind === KIND.TEXT) return text(payload, count);
      if (kind === KIND.ARRAY) return Array.from({ length: count }, (_, index) => decode(payload + index * VALUE.SIZE));
      if (kind !== KIND.OBJECT) throw new Error(`Unknown native authored value kind ${kind}`);
      const object = {};
      for (let index = 0; index < count; index++) {
        const field = payload + index * VALUE.SIZE;
        const name = text(view.getUint32(field + VALUE.KEY, true), view.getUint32(field + VALUE.KEY_LENGTH, true));
        Object.defineProperty(object, name, { value: decode(field), enumerable: true, writable: true, configurable: true });
      }
      return object;
    };
    const output = Array.from({ length: count }, (_, index) => {
      const row = pointer + index * ROW.SIZE;
      const source = view.getInt32(row + ROW.SOURCE, true);
      const node = { ...nodes[source], ...decode(view.getUint32(row + ROW.VALUE, true)) };
      const box = { children: node.children ?? [], record: view.getUint32(row + ROW.RECORD, true) };
      publication.boxes.push(box);
      return { ...node, _coreBox: 0, _corePublication: publication, _corePublicationIndex: index };
    });
    publication.indexSpaceChanged = count !== 0 && view.getUint32(pointer + ROW.INDEX_SPACE_CHANGED, true) !== 0;
    Object.defineProperty(output, "_corePublication", { value: publication });
    authoredPublications.register(publication, { core, handle }, publication);
    return output;
  } catch (error) {
    core.engineRecordRelease(handle);
    throw error;
  }
}

export function releaseAuthoredSceneInput(nodes, preservedNodes = []) {
  const preserved = new Set(preservedNodes.map((node) => node._corePublication));
  preserved.add(preservedNodes._corePublication);
  const publications = new Set((nodes ?? []).map((node) => node._corePublication));
  publications.add(nodes?._corePublication);
  for (const publication of publications) {
    if (!publication?.authored || preserved.has(publication) || !authoredPublications.unregister(publication)) continue;
    publication.core.engineRecordRelease(publication.handle);
  }
}

function submitDirectSceneInput(core, nodes, patchIndex, rowRevision, imageScope, preparing = false) {
  if (!preparing && imageScope === null && isDomBackedScene(nodes)) {
    const publication = scenePublication(core, nodes, rowRevision, patchIndex);
    return patchIndex === null
      ? core.status("engine_direct_publish_scene", publication.handle, rowRevision)
      : publication.authored
      ? core.status("engine_direct_publish_scene_patch", publication.handle, nodes[0]._corePublicationIndex, patchIndex, rowRevision)
      : core.status("engine_direct_publish_scene_row", publication.handle, patchIndex, rowRevision);
  }
  const values = [];
  const strings = [];
  const stringOffsets = new Map();
  let stringBytes = 0;
  const string = (text) => {
    let encoded = stringOffsets.get(text);
    if (encoded) return encoded;
    const bytes = utf8.encode(text);
    encoded = { offset: stringBytes, length: bytes.length };
    strings.push(bytes);
    stringBytes += bytes.length;
    stringOffsets.set(text, encoded);
    return encoded;
  };
  const active = new Set();
  const encode = (value, at, key = "", sceneNode = false) => {
    const entry = { key: string(key), name: key, kind: KIND.UNDEFINED };
    values[at] = entry;
    if (value == null) return;
    if (typeof value === "number" || typeof value === "boolean") {
      entry.kind = typeof value === "number" ? KIND.NUMBER : KIND.BOOLEAN;
      entry.number = Number(value);
      return;
    }
    if (typeof value === "string") {
      entry.kind = KIND.TEXT;
      entry.string = string(value);
      entry.text = value;
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(`Unsupported authored Scene value for ${key}`);
    }
    entry.authored = value;
    if (active.has(value)) throw new TypeError("Cyclic authored Scene value");
    active.add(value);
    try {
      if (sceneNode && value._coreBox !== undefined) {
        throw new Error(`Generic scene encoder received core-backed row ${value._corePublicationIndex ?? patchIndex ?? at} (${value.id ?? value.name ?? value.display ?? "unnamed"}); publish its native row instead`);
      }
      const array = Array.isArray(value);
      entry.kind = array ? KIND.ARRAY : KIND.OBJECT;
      const keys = array ? Array.from(value.keys()) : Object.keys(value);
      // Ignore resource objects and unrelated application data. Native lookup
      // also checks exact UTF-8 spelling, not a hash alone.
      const fields = array ? keys : keys.filter((name) =>
        fieldNames(core, imageScope === null ? 0 : 1).has(name));
      if (imageScope === null && sceneNode && value._corePublication && value._coreBox === undefined) {
        if (value._corePublication.core !== core) {
          throw new TypeError("DOM-backed text belongs to another renderer core");
        }
        const textIndex = fields.indexOf("text");
        if (textIndex !== -1) fields.splice(textIndex, 1);
        fields.push("_nativeTextPublication", "_nativePublicationIndex");
      }
      entry.first = values.length;
      entry.count = fields.length;
      values.length += fields.length;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        let child = value[field];
        if (sceneNode && field === "_nativeTextPublication") {
          child = value._corePublication.handle;
        } else if (sceneNode && field === "_nativePublicationIndex") {
          child = value._corePublicationIndex;
        }
        encode(child, entry.first + index, array ? "" : field,
          array && value === nodes);
      }
    } finally {
      active.delete(value);
    }
  };
  values.length = 1;
  encode(patchIndex === null ? nodes : nodes[0], 0, "", patchIndex !== null);
  const stringBase = INPUT.HEADER_SIZE + values.length * VALUE.SIZE;
  const length = stringBase + stringBytes;
  const pointer = core.status("engine_direct_input_allocate", length);
  if (!pointer) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  view.setUint32(pointer + INPUT.HEADER_MAGIC, INPUT.MAGIC, true);
  view.setUint32(pointer + INPUT.HEADER_COUNT, values.length, true);
  view.setUint32(pointer + INPUT.HEADER_STRING_BYTES, stringBytes, true);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const at = pointer + INPUT.HEADER_SIZE + index * VALUE.SIZE;
    view.setUint32(at + VALUE.KIND, value.kind, true);
    view.setUint32(at + VALUE.KEY, pointer + stringBase + value.key.offset, true);
    view.setUint32(at + VALUE.KEY_LENGTH, value.key.length, true);
    if (value.kind === KIND.NUMBER || value.kind === KIND.BOOLEAN) {
      view.setFloat64(at + VALUE.NUMBER, value.number, true);
    } else if (value.kind === KIND.TEXT) {
      view.setUint32(at + VALUE.PAYLOAD, pointer + stringBase + value.string.offset, true);
      view.setUint32(at + VALUE.COUNT, value.string.length, true);
    } else if (value.kind === KIND.OBJECT || value.kind === KIND.ARRAY) {
      view.setUint32(at + VALUE.PAYLOAD, pointer + INPUT.HEADER_SIZE + value.first * VALUE.SIZE, true);
      view.setUint32(at + VALUE.COUNT, value.count, true);
    }
  }
  let cursor = pointer + stringBase;
  for (const text of strings) {
    bytes.set(text, cursor);
    cursor += text.length;
  }
  // The native operation adopts the allocation, including on failure. Full
  // publication replaces the previous owned input; sparse patches replace only
  // their node's owned input. No JavaScript snapshot authority remains.
  try {
    if (imageScope !== null) {
      return core.status("image_requests_prepare", imageScope, pointer, length);
    }
    if (preparing) return core.status("engine_authored_prepare", pointer, length);
    return core.status("engine_direct_publish", pointer, length, patchIndex ?? -1);
  } catch (error) {
    if (core.exports.abi_error_kind() !== ERROR_KIND_ERROR) throw error;
    const rejectedPointer = core.exports.abi_error_detail_a();
    const valueIndex = (rejectedPointer - pointer - INPUT.HEADER_SIZE) / VALUE.SIZE;
    const rejected = Number.isInteger(valueIndex) ? values[valueIndex] : undefined;
    if (!rejected) throw error;
    const authored = rejected.kind === KIND.TEXT ? rejected.text
      : rejected.kind === KIND.BOOLEAN ? Boolean(rejected.number)
      : rejected.kind === KIND.NUMBER ? rejected.number : rejected.authored;
    const renderedValue = typeof authored === "number" && !Number.isFinite(authored) ? String(authored) : JSON.stringify(authored);
    throw new Error(
      `Unsupported authored Scene value ${renderedValue} for ${rejected.name}` +
      ` at node ${core.exports.abi_error_detail_b()}`,
      { cause: error },
    );
  }
}

// Retained core rows publish from their native publication. Only original
// authored scene input reaches the generic encoder.
function isDomBackedScene(nodes) {
  if (nodes.length === 0) return nodes._corePublication !== undefined;
  const publication = nodes[0]._corePublication;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node._coreBox === undefined) return false;
    if (node._corePublication !== publication) return false;
  }
  return true;
}

// The publication whose rows a DOM-backed scene is: each row is the
// publication's row at its index, with the publication's child list, and
// `rowRevision` the revision of the rows the scene holds. The core publishes
// those rows as they were lowered, with the scroll offsets and transforms
// later frames restated (engine_record_scroll_restate,
// engine_record_transform_restate). A scene of other rows, or one made
// before a later restatement, holds rows the core no longer has: it throws.
function scenePublication(core, nodes, rowRevision, patchIndex = null) {
  const publication = nodes[0]?._corePublication ?? nodes._corePublication;
  const boxes = publication?.boxes;
  if (publication?.core !== core) {
    throw new TypeError("DOM-backed scene belongs to another renderer core");
  }
  if (boxes == null || (patchIndex === null ? boxes.length !== nodes.length : nodes.length !== 1 || !publication.authored && patchIndex >= boxes.length)) {
    throw new Error(
      `A DOM-backed scene of ${nodes.length} rows names a publication of ${boxes?.length ?? "no"} rows; ` +
        "serialize the document again to publish it",
    );
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const row = patchIndex === null ? index : publication.authored ? node._corePublicationIndex : patchIndex;
    if (node._corePublication !== publication || node._corePublicationIndex !== row) {
      throw new Error(
        `Row ${index} of a DOM-backed scene is row ${node._corePublicationIndex} of ` +
          `${node._corePublication === publication ? "its" : "another"} publication; serialize the document again to publish it`,
      );
    }
    const children = node.children;
    const publishedChildren = boxes[row].children;
    if (children === undefined ? publishedChildren.length !== 0 : children !== publishedChildren) {
      throw new Error(
        `Row ${index} of a DOM-backed scene has children other than its publication's; serialize the document again to publish it`,
      );
    }
  }
  if (core.status("engine_direct_scene_current", publication.handle, rowRevision) !== 1) {
    throw new Error(
      `A DOM-backed scene holds row revision ${rowRevision}, and its publication's rows were restated since; ` +
        "publish the scene of the latest frame",
    );
  }
  return publication;
}
