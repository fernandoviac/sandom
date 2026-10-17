// The one upload of authored Scene values. This format contains no engine
// offsets, enums, records, pools, defaults, or normalized CSS values. Native
// direct-input.watpart owns interpretation and publication.
const utf8 = new TextEncoder();
const hashName = (name) => {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(name)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
};

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
    for (const name of imageSceneFields) {
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
      const kind = view.getUint32(pointer + 4, true);
      if (kind === 0) return undefined;
      if (kind === 1) return view.getFloat64(pointer + 16, true);
      if (kind === 3) return view.getFloat64(pointer + 16, true) !== 0;
      const payload = view.getUint32(pointer + 8, true);
      const count = view.getUint32(pointer + 12, true);
      if (kind === 2) return text(payload, count);
      if (kind === 5) return Array.from({ length: count }, (_, index) => decode(payload + index * 32));
      if (kind !== 4) throw new Error(`Unknown native authored value kind ${kind}`);
      const object = {};
      for (let index = 0; index < count; index++) {
        const field = payload + index * 32;
        const name = text(view.getUint32(field + 24, true), view.getUint32(field + 28, true));
        Object.defineProperty(object, name, { value: decode(field), enumerable: true, writable: true, configurable: true });
      }
      return object;
    };
    const output = Array.from({ length: count }, (_, index) => {
      const row = pointer + index * 16;
      const source = view.getInt32(row, true);
      const node = { ...nodes[source], ...decode(view.getUint32(row + 4, true)) };
      const box = { children: node.children ?? [], record: view.getUint32(row + 8, true) };
      publication.boxes.push(box);
      return { ...node, _coreBox: 0, _corePublication: publication, _corePublicationIndex: index };
    });
    publication.indexSpaceChanged = count !== 0 && view.getUint32(pointer + 12, true) !== 0;
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
    const entry = { key: string(key), name: key, hash: key ? (directSceneFields.get(key) ?? hashName(key)) : 0, kind: 0 };
    values[at] = entry;
    if (value == null) return;
    if (typeof value === "number" || typeof value === "boolean") {
      entry.kind = typeof value === "number" ? 1 : 3;
      entry.number = Number(value);
      return;
    }
    if (typeof value === "string") {
      entry.kind = 2;
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
      entry.kind = array ? 5 : 4;
      const keys = array ? Array.from(value.keys()) : Object.keys(value);
      // Ignore resource objects and unrelated application data. Native lookup
      // also checks exact UTF-8 spelling, not a hash alone.
      const fields = array ? keys : keys.filter((name) =>
        (imageScope === null ? directSceneFields : imageSceneFields).has(name));
      if (imageScope === null && sceneNode && value._corePublication && value._coreBox === undefined) {
        if (value._corePublication.core !== core) {
          throw new TypeError("DOM-backed text belongs to another renderer core");
        }
        const textIndex = fields.indexOf("text");
        if (textIndex !== -1) fields.splice(textIndex, 1);
        fields.push("_nativeTextPublication", "_nativePublicationIndex");
      }
      if (imageScope === null && sceneNode && value.resolvedBorderImage && !fields.includes("borderImage")) {
        fields.push("borderImage");
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
        if (imageScope === null && sceneNode && field === "borderImage") {
          child = value.resolvedBorderImage ?? child;
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
  const stringBase = 16 + values.length * 32;
  const length = stringBase + stringBytes;
  const pointer = core.status("engine_direct_input_allocate", length);
  if (!pointer) core.throwIfError();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  view.setUint32(pointer, 0x53434e31, true);
  view.setUint32(pointer + 4, values.length, true);
  view.setUint32(pointer + 8, stringBytes, true);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const at = pointer + 16 + index * 32;
    view.setUint32(at, value.hash, true);
    view.setUint32(at + 4, value.kind, true);
    view.setUint32(at + 24, pointer + stringBase + value.key.offset, true);
    view.setUint32(at + 28, value.key.length, true);
    if (value.kind === 1 || value.kind === 3) {
      view.setFloat64(at + 16, value.number, true);
    } else if (value.kind === 2) {
      view.setUint32(at + 8, pointer + stringBase + value.string.offset, true);
      view.setUint32(at + 12, value.string.length, true);
    } else if (value.kind === 4 || value.kind === 5) {
      view.setUint32(at + 8, pointer + 16 + value.first * 32, true);
      view.setUint32(at + 12, value.count, true);
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
    if (core.exports.abi_error_kind() !== 18) throw error;
    const rejectedPointer = core.exports.abi_error_detail_a();
    const valueIndex = (rejectedPointer - pointer - 16) / 32;
    const rejected = Number.isInteger(valueIndex) ? values[valueIndex] : undefined;
    if (!rejected) throw error;
    const authored = rejected.kind === 2 ? rejected.text
      : rejected.kind === 3 ? Boolean(rejected.number)
      : rejected.kind === 1 ? rejected.number : rejected.authored;
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

const directSceneFields = new Map([
  "src", "resourceIdentifier", "canvasSourceIdentifier", "brokenImageIcon",
  "display", "layoutDisplay", "children", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "order", "href", "d", "points", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
  "aspectRatio", "boxSizing", "position", "zIndex", "top", "right", "bottom", "left", "margin", "padding", "border",
  "marginTop", "marginRight", "marginBottom", "marginLeft", "borderColor", "borderStyle", "borderRadius", "outline",
  "bg", "opacity", "blendMode", "isolation", "visibility", "overflow", "overflowX", "overflowY", "overflowClipMargin",
  "visualBox", "offset", "scrollLeft", "scrollTop", "direction", "writingMode", "float", "clear", "bfc", "inlineCtx",
  "fontIndex", "fontSize", "fontWeight", "fontStyle", "color", "textAlign", "textDecoration", "textOverflow", "whiteSpace",
  "overflowWrap", "verticalAlign", "lineHeight", "letterSpacing", "flexDirection", "flexWrap", "flexGrow", "flexShrink",
  "flexBasis", "alignItems", "alignSelf", "alignContent", "justifyItems", "justifySelf", "justifyContent", "layoutAlignItems",
  "layoutJustifyContent", "gap", "rowGap", "columnGap", "columnWidth", "columnCount", "breakInside", "orphans", "widows",
  "columnRuleWidth", "columnRuleStyle", "columnRuleColor", "columnSpan", "columnFill", "gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas",
  "gridAutoColumns", "gridAutoRows", "gridAutoFlow", "gridRowStart", "gridRowEnd", "gridColumnStart", "gridColumnEnd",
  "gridRow", "gridColumn", "gridArea", "tableLayout", "borderCollapse", "captionSide", "emptyCells", "colSpan", "rowSpan",
  "borderSpacing", "imageIndex", "objectFit", "objectPosition", "imageRendering", "backgroundGradient", "backgroundImages",
  "resolvedBackgroundImages", "backgroundAttachment", "backgroundClip", "backgroundOrigin", "boxShadows", "textShadows",
  "filter", "backdropFilter", "masks", "resolvedMasks", "borderImage", "clipPath", "svgFillGradient", "svgStrokeGradient", "viewBox",
  "preserveAspectRatio", "fill", "stroke", "fillOpacity", "strokeOpacity", "strokeWidth", "fillRule", "strokeLinecap",
  "strokeLinejoin", "svgTextAnchor", "svgTextX", "svgTextY", "resolvedPathBbox",
  "transform", "transformOrigin", "kind", "components", "value", "radians",
  "xRadians", "yRadians", "scale", "rotate", "translate", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "xMin", "yMin", "xMax", "yMax", "pixels", "percentage", "px", "g", "b", "a", "topLeft", "topRight", "bottomRight", "bottomLeft",
  "style", "gradient", "stops", "angle", "repeating", "shape", "size", "center", "interpolationSpace", "hueMethod", "missingComponents",
  "attachment", "repeat", "origin", "clip", "mode", "composite", "type", "amount", "dx", "dy", "sigma", "offsetX", "offsetY", "blur",
  "spread", "inset", "slice", "outset", "radius", "radii", "_nativePublication",
  "text", "sourceRevision", "_inspectionSourceNodeIndex", "_nativePublicationIndex", "_nativeTextPublication",
].map((name) => [name, hashName(name)]));

const imageSceneFields = new Set([
  "src", "resourceIdentifier", "canvasSourceIdentifier", "brokenImageIcon",
  "backgroundImages", "masks", "borderImage",
]);
