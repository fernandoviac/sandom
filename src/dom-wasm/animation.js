import { sharedDomCore as core } from "./core.js";
import { parseCSSEasing } from "./easing.js";

// Calls a validation operation of the animation core. Its error names the
// reason and the limit; $subject names what failed and its observed value.
function animationStatus(subject, exportName, ...parameters) {
  try {
    return core.statusRaw(exportName, ...parameters);
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    throw new error.constructor(`${subject()}: ${error.message}`, { cause: error });
  }
}
// The text of an observed value in an error message.
function observedText(value) {
  return typeof value === "number" || value === undefined ? String(value) : JSON.stringify(value);
}

// The keyframes with their computed offsets, in their order (Web
// Animations 1, "compute missing keyframe offsets"; animation_offsets).
export function normalizeAnimationOffsets(keyframes) {
  const frames = keyframes.map((frame) => ({ ...frame }));
  if (frames.length === 0) return frames;
  const pointer = core.exports.abi_allocate(frames.length * 16);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) {
    const offset = frames[index].offset;
    // Property access and Number.isFinite's noncoercing contract belong here.
    if (index > 0 && offset != null && typeof offset !== "number") {
      throw new TypeError("keyframe offset must be finite");
    }
    view.setFloat64(pointer + index * 16, offset ?? NaN, true);
    view.setUint32(pointer + index * 16 + 8, index, true);
    view.setUint32(pointer + index * 16 + 12, offset == null ? 0 : 1, true);
  }
  const count = animationStatus(() => `The keyframe offsets [${frames.map(({ offset }) => String(offset ?? null)).join(", ")}]`,
    "animation_offsets", pointer, frames.length);
  view = new DataView(core.refreshBytes().buffer);
  const output = core.exports.abi_output_pointer();
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const frame = frames[view.getUint32(output + index * 16 + 8, true)];
    frame.offset = view.getFloat64(output + index * 16, true);
    result[index] = frame;
  }
  return result;
}

// The arrangement of a property-indexed keyframes argument
// (animation_keyframes_arrange): $properties holds [name, values] pairs.
// Returns the keyframes as { offsetIndex, easingIndex, compositeIndex }
// (-1 for none) and the value assignments as [pairIndex, valueIndex,
// keyframeIndex] in the order their values enter the keyframes.
export function arrangeKeyframes(properties, offsetCount, easingCount, compositeCount) {
  const names = properties.map(([name]) => core.input(name));
  const rows = core.exports.abi_allocate(Math.max(1, properties.length) * 16);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < properties.length; index++) {
    view.setUint32(rows + index * 16, names[index][0], true);
    view.setUint32(rows + index * 16 + 4, names[index][1], true);
    view.setUint32(rows + index * 16 + 8, properties[index][1].length, true);
  }
  const output = core.status("animation_keyframes_arrange", rows, properties.length, offsetCount, easingCount, compositeCount);
  view = new DataView(core.refreshBytes().buffer);
  const frameCount = view.getUint32(output, true);
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    offsetIndex: view.getInt32(output + 8 + index * 12, true),
    easingIndex: view.getInt32(output + 12 + index * 12, true),
    compositeIndex: view.getInt32(output + 16 + index * 12, true),
  }));
  const base = output + 8 + frameCount * 12;
  const assignments = Array.from({ length: view.getUint32(output + 4, true) }, (_, index) =>
    [0, 4, 8].map((field) => view.getUint32(base + index * 12 + field, true)));
  return { frames, assignments };
}

// The numbers of a transform component, as animation_keyframe_value_text
// reads them for its function name.
function componentNumbers(component) {
  switch (component.kind) {
    case "translate": return [component.x.pixels, component.x.percentage, component.y.pixels, component.y.percentage];
    case "translateX": case "translateY": return [component.value.pixels, component.value.percentage];
    case "scale": return [component.x, component.y];
    case "skew": return [component.xRadians, component.yRadians];
    case "matrix": return component.value;
    case "rotate": case "skewX": case "skewY": return [component.radians];
    default: return [component.value];
  }
}
// The items and numbers of a canonical keyframe value.
function keyframeValueItems(value) {
  switch (value?.kind) {
    case "scalar": return [{ kind: "scalar", numbers: [value.value] }];
    case "scale": return [{ kind: "scale", numbers: [value.x, value.y] }];
    case "lengthPercentage": return [{ kind: value.kind, numbers: [value.pixels, value.percentage] }];
    case "color": return [{ kind: "color", numbers: value.value }];
    case "keyword": return [{ kind: "keyword", text: value.keyword }];
    case "lineHeight": return [{ kind: value.kind, text: value.unit, numbers: [value.value] }];
    case "translate":
      return [{ kind: value.kind, numbers: [value.x.pixels, value.x.percentage, value.y.pixels, value.y.percentage] }];
    case "transform":
      return [{ kind: "transform" },
        ...value.components.map((component) => ({ kind: component.kind, numbers: componentNumbers(component) }))];
    case "shadowList":
      return [{ kind: value.kind }, ...value.shadows.map((shadow) => ({ kind: "shadow",
        numbers: [...shadow.color, shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread, shadow.inset ? 1 : 0] }))];
    default: return [{ kind: String(value?.kind) }];
  }
}
// The CSS text of a canonical keyframe value of $propertyName
// (animation_keyframe_value_text). A string value is already CSS text.
export function keyframeValueText(value, propertyName) {
  if (typeof value === "string") return value;
  const items = keyframeValueItems(value);
  const texts = items.map((item) => [core.input(item.kind), core.input(String(item.text ?? ""))]);
  const numberCount = items.reduce((sum, item) => sum + (item.numbers?.length ?? 0), 0);
  const property = core.input(String(propertyName));
  const rows = core.exports.abi_allocate(items.length * 24);
  const numbers = core.exports.abi_allocate(Math.max(1, numberCount) * 8);
  const view = new DataView(core.refreshBytes().buffer);
  let numberIndex = 0;
  for (let index = 0; index < items.length; index++) {
    const row = rows + index * 24;
    const itemNumbers = items[index].numbers ?? [];
    view.setUint32(row, texts[index][0][0], true); view.setUint32(row + 4, texts[index][0][1], true);
    view.setUint32(row + 8, texts[index][1][0], true); view.setUint32(row + 12, texts[index][1][1], true);
    view.setUint32(row + 16, numberIndex, true); view.setUint32(row + 20, itemNumbers.length, true);
    for (const number of itemNumbers) view.setFloat64(numbers + 8 * numberIndex++, number, true);
  }
  return animationStatus(() => `The ${propertyName} keyframe value ${JSON.stringify(value)}`,
    "animation_keyframe_value_text", ...property, rows, items.length, numbers) ? core.outputString() : null;
}

// The composite operation of a track declaration after its node, property
// and composite checks (animation_track_check). $property is null for a
// name the core does not animate.
export function checkAnimationTrack(nodeIndex, capacity, property, propertyName, composite) {
  return core.status("animation_track_check", Number(nodeIndex), capacity, property?.id ?? 0, property?.kind ?? 0,
    ...core.input(String(propertyName)), ...core.input(String(composite)));
}
// The value kind of a track of normalized $frames (animation_track_kind).
export function animationTrackKind(propertyKind, composite, frames) {
  const kinds = core.exports.abi_allocate(Math.max(1, frames.length) * 4);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) view.setUint32(kinds + index * 4, frames[index].value.kind, true);
  return core.status("animation_track_kind", propertyKind, composite, kinds, frames.length);
}

// The canonical CSS name of an animation property id, or null.
export function animationPropertyName(id) {
  return core.status("animation_property_name", id) ? core.outputString() : null;
}
// The name of native value $value of an animation enumeration
// (animation_enumeration_name).
export function animationEnumerationName(enumeration, value) {
  return core.string("animation_enumeration_name", enumeration, value);
}
// The DOM event type of an engine animation event type id.
export function animationEventName(typeId) {
  return animationEnumerationName(3, typeId);
}
// The engine fill and direction modes of fill and direction keyword text
// (animation_fill_mode, animation_direction_mode).
export function animationFillMode(fill) {
  return core.exports.animation_fill_mode(...core.input(String(fill)));
}
export function animationDirectionMode(direction) {
  return core.exports.animation_direction_mode(...core.input(String(direction)));
}
// Throws the failure of an engine animation_track_declare result code.
export function throwAnimationDeclarationError(code) {
  core.status("animation_declaration_error", code);
  throw new Error(`animation_declaration_error reported no failure for code ${code}`);
}
const TRANSFORM_FUNCTION_SHAPES = [
  (p) => ({ kind: "translate", x: { pixels: p[0], percentage: p[1] }, y: { pixels: p[2], percentage: p[3] } }),
  (p) => ({ kind: "translateX", value: { pixels: p[0], percentage: p[1] } }),
  (p) => ({ kind: "translateY", value: { pixels: p[2], percentage: p[3] } }),
  (p) => ({ kind: "scale", x: p[0], y: p[1] }),
  (p) => ({ kind: "scaleX", value: p[0] }),
  (p) => ({ kind: "scaleY", value: p[1] }),
  (p) => ({ kind: "rotate", radians: p[0] }),
  (p) => ({ kind: "skew", xRadians: p[0], yRadians: p[1] }),
  (p) => ({ kind: "skewX", radians: p[0] }),
  (p) => ({ kind: "skewY", radians: p[1] }),
  (p) => ({ kind: "matrix", value: p.slice(0, 6) }),
];
// The script transform components of engine $components ({ kind,
// parameters }), named after $sourceNames, the function names of the
// transform list they came from (null for none), whose normalized engine
// kinds are $normalizedKinds (animation_transform_frame_names). The index
// order of TRANSFORM_FUNCTION_SHAPES is the core's name order.
export function transformFrameComponents(components, normalizedKinds, sourceNames) {
  const names = (sourceNames ?? []).map((name) => core.input(String(name ?? "")));
  const rows = core.exports.abi_allocate(Math.max(1, components.length) * 56);
  const kinds = core.exports.abi_allocate(Math.max(1, normalizedKinds.length) * 4);
  const nameRows = core.exports.abi_allocate(Math.max(1, names.length) * 8);
  let view = new DataView(core.refreshBytes().buffer);
  components.forEach(({ kind, parameters }, index) => {
    view.setUint32(rows + index * 56, kind, true);
    for (let parameter = 0; parameter < 6; parameter++) {
      view.setFloat64(rows + index * 56 + 8 + parameter * 8, parameters[parameter], true);
    }
  });
  normalizedKinds.forEach((kind, index) => view.setUint32(kinds + index * 4, kind, true));
  names.forEach(([pointer, length], index) => {
    view.setUint32(nameRows + index * 8, pointer, true);
    view.setUint32(nameRows + index * 8 + 4, length, true);
  });
  const count = core.status("animation_transform_frame_names", rows, components.length, kinds, nameRows,
    sourceNames === null || normalizedKinds.length !== components.length ? -1 : components.length);
  const output = core.exports.abi_output_pointer();
  view = new DataView(core.refreshBytes().buffer);
  return Array.from({ length: count }, (_, index) =>
    TRANSFORM_FUNCTION_SHAPES[view.getUint32(output + index * 4, true)](components[index].parameters));
}

// The value kind of an animation property id (animation_property_value_kind).
export function animationPropertyValueKind(id) {
  return core.status("animation_property_value_kind", id);
}

export function createAnimationTrackIdentity(owner = 0n) {
  return core.handle("animation_track_identity_create", owner);
}
export function releaseAnimationTrackIdentity(handle) {
  core.status("animation_track_identity_release", handle);
}
function snapshotAnimationTracks(engineView, allocations, tableBase, recordSize) {
  // Read the engine rows first: abi_allocate can grow the shared memory,
  // which detaches the caller's engine view.
  const rows = [];
  for (const [slot, allocation] of allocations) {
    const address = tableBase + slot * recordSize;
    rows.push([allocation.identity, slot,
      engineView.getUint16(address, true), engineView.getUint16(address + 2, true),
      engineView.getUint8(address + 5), engineView.getUint8(address + 4),
      engineView.getUint8(address + 59), engineView.getUint32(address + 96, true),
      engineView.getUint8(address + 6)]);
  }
  const pointer = core.exports.abi_allocate(rows.length * 40);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < rows.length; index++) {
    const row = pointer + index * 40;
    const fields = rows[index];
    view.setBigUint64(row, fields[0], true);
    for (let field = 1; field < 9; field++) view.setUint32(row + 4 + field * 4, fields[field], true);
  }
  return pointer;
}
export function nextAnimationReplacement(engineView, allocations, tableBase, recordSize, nodeIndex, propertyId, cursor) {
  return core.status("animation_replacement_next", snapshotAnimationTracks(engineView, allocations, tableBase, recordSize),
    allocations.size, nodeIndex, propertyId, cursor);
}
export function animationTransitionProperties(name) {
  const count = core.status("animation_transition_properties", ...core.input(name));
  const pointer = core.exports.abi_output_pointer();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer);
  return Array.from({ length: count }, (_, index) => {
    const row = pointer + index * 8;
    const text = view.getUint32(row, true);
    return core.decoder.decode(bytes.subarray(text, text + view.getUint32(row + 4, true)));
  });
}

export function reconcileAnimationDefinitions(definitions, previous = []) {
  const desired = definitions.map((definition) => ({
    definition,
    signature: JSON.stringify({ name: definition.name, keyframes: definition.keyframes,
      composition: definition.composition, timing: definition.timing, paused: definition.paused }),
  }));
  const pointer = core.exports.abi_allocate((previous.length + desired.length) * 24);
  const rows = [...previous, ...desired];
  for (let index = 0; index < rows.length; index++) {
    const record = rows[index];
    const [name, nameLength] = core.input(record.definition.name);
    const [signature, signatureLength] = core.input(record.signature);
    const view = new DataView(core.refreshBytes().buffer);
    const row = pointer + index * 24;
    view.setUint32(row, name, true); view.setUint32(row + 4, nameLength, true);
    view.setUint32(row + 8, signature, true); view.setUint32(row + 12, signatureLength, true);
    view.setUint32(row + 16, record.occurrence ?? 0, true);
    view.setUint32(row + 20, index, true);
  }
  core.status("animation_css_reconcile", pointer, previous.length,
    pointer + previous.length * 24, desired.length);
  const output = core.exports.abi_output_pointer();
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < desired.length; index++) {
    const record = desired[index];
    const row = output + index * 16;
    record.occurrence = view.getUint32(row + 4, true);
    record.identity = `${record.definition.name}\u0000${record.occurrence}`;
    record.reusable = previous[view.getInt32(row, true)];
    record.previous = previous[view.getInt32(row + 8, true)];
  }
  return desired;
}
export function animationCSSInsertion(following, preceding, previous, first, count) {
  return core.status("animation_css_insertion", following, preceding, previous ?? -1, first, count);
}

export function animationTransitionDefinitions(element) {
  const native = element._domCore;
  const count = native.status("animation_transition_definitions", element._coreHandle);
  const pointer = native.exports.abi_output_pointer();
  const bytes = native.refreshBytes();
  const view = new DataView(bytes.buffer);
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const row = pointer + index * 40;
    const name = view.getUint32(row, true);
    const nameLength = view.getUint32(row + 4, true);
    const easing = view.getUint32(row + 24, true);
    const easingLength = view.getUint32(row + 28, true);
    result[index] = {
      propertyName: native.decoder.decode(bytes.subarray(name, name + nameLength)),
      duration: view.getFloat64(row + 8, true), delay: view.getFloat64(row + 16, true),
      easing: native.decoder.decode(bytes.subarray(easing, easing + easingLength)),
    };
  }
  for (const definition of result) definition.easing = parseCSSEasing(definition.easing);
  return result;
}

// A box-shadow or text-shadow list travels as component pairs in the
// transform component pool (engine-layout.watpart
// $animationWriteShadowSample): geometry (offset-x, offset-y, blur, spread;
// kind bit 0 = inset; a text shadow's spread is 0) then colour.
export const SHADOW_COMPONENT_GEOMETRY = 0x40;
export const SHADOW_COMPONENT_COLOR = 0x41;
export const SHADOW_LIST_MAX = 8;
function nativeTransform(component) {
  const kind = component.kind;
  let values;
  if (kind === "translate") {
    const x = normalizeAnimationValue({ id: 1, kind: 2 }, component.x ?? { pixels: 0, percentage: 0 });
    const y = normalizeAnimationValue({ id: 1, kind: 2 }, component.y ?? { pixels: 0, percentage: 0 });
    values = [x.values[0], x.values[1], y.values[0], y.values[1]];
  } else if (kind === "translateX" || kind === "translateY") {
    values = normalizeAnimationValue({ id: 1, kind: 2 }, component.value).values;
  } else if (kind === "scale") values = [component.x, component.y];
  else if (kind === "scaleX" || kind === "scaleY") values = [component.value];
  else if (kind === "rotate" || kind === "skewX" || kind === "skewY") values = [component.radians];
  else if (kind === "skew") values = [component.xRadians, component.yRadians];
  else if (kind === "matrix") {
    if (!Array.isArray(component.value) || component.value.length !== 6) throw new TypeError("A matrix component needs six values");
    values = component.value;
  } else values = [];
  const pointer = core.exports.abi_allocate(48);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < 6; index++) {
    const value = index < values.length ? values[index] : 0;
    view.setFloat64(pointer + index * 8, typeof value === "number" ? value : NaN, true);
  }
  const output = animationStatus(() => `The ${kind} transform function ${observedText(component)}`,
    "animation_transform_normalize", ...core.input(String(kind)), pointer);
  view = new DataView(core.refreshBytes().buffer);
  return { kind: view.getUint32(output, true),
    parameters: Array.from({ length: 6 }, (_, index) => view.getFloat64(output + 16 + index * 8, true)) };
}
export function normalizeAnimationValue(property, input) {
  let kind = 0, keyword = "", values = [], components;
  if (input?.kind === "keyword") {
    kind = 5; keyword = String(input.keyword);
  } else if (property.kind === 2) {
    if (input?.kind === "lengthPercentage" || (input && "pixels" in input && "percentage" in input)) {
      kind = 2; values = [input.pixels, input.percentage, 0];
    }
  } else if (property.kind === 1) {
    if (input?.kind === "scalar") { kind = 1; values = [input.value]; }
    else if (input?.kind === "lengthPercentage") {
      kind = 2; values = [input.pixels, input.percentage];
    }
  } else if (property.kind === 3) {
    if (input?.kind === "color" && Array.isArray(input.value) && input.value.length === 4) {
      kind = 3; values = input.value;
    }
  } else if (property.kind === 6) {
    kind = 6; keyword = String(input?.keyword ?? input);
  } else if (property.kind === 4) {
    if (input?.kind === "transform" && Array.isArray(input.components)) {
      kind = 4; values = [0, 0, 0, 0, 0, 0];
      components = input.components.map(nativeTransform);
    }
  } else if (property.kind === 7) {
    if (input?.kind === "shadowList" && Array.isArray(input.shadows)) {
      if (input.shadows.length > SHADOW_LIST_MAX) {
        throw new RangeError(`A shadow list animates at most ${SHADOW_LIST_MAX} shadows, got ${input.shadows.length}`);
      }
      kind = 7;
      // The envelope's vector is the first shadow's numbers (the reversing
      // rule measures progress along it; every shadow shares the progress).
      const first = input.shadows[0];
      values = first
        ? [first.offsetX, first.offsetY, first.blur, first.spread, first.color[3], 0]
        : [0, 0, 0, 0, 0, 0];
      components = input.shadows.flatMap((shadow) => {
        for (const number of [shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread, ...shadow.color]) {
          if (!Number.isFinite(number)) throw new TypeError("A shadow needs finite lengths and colour channels");
        }
        return [
          { kind: SHADOW_COMPONENT_GEOMETRY | (shadow.inset ? 1 : 0), parameters: [shadow.offsetX, shadow.offsetY, shadow.blur, shadow.spread, 0, 0] },
          { kind: SHADOW_COMPONENT_COLOR, parameters: [shadow.color[0], shadow.color[1], shadow.color[2], shadow.color[3], 0, 0] },
        ];
      });
    }
  } else if (property.kind === 8 && input?.kind === "lineHeight") {
    kind = 8; keyword = String(input.unit);
    values = [input.value, 0];
  } else if (property.kind === 9 && input?.kind === "translate") {
    const x = input.x ?? { pixels: 0, percentage: 0 };
    const y = input.y ?? { pixels: 0, percentage: 0 };
    kind = 9;
    values = [x.pixels, x.percentage, y.pixels, y.percentage];
  } else if (property.kind === 10 && input?.kind === "scale") {
    kind = 10;
    values = [input.x, input.y];
  }
  const keywordInput = core.input(keyword);
  const pointer = core.exports.abi_allocate(64);
  let view = new DataView(core.refreshBytes().buffer);
  new Uint8Array(view.buffer, pointer, 64).fill(0);
  view.setUint32(pointer, kind, true);
  view.setUint32(pointer + 8, values.length, true);
  for (let index = 0; index < values.length; index++) {
    view.setFloat64(pointer + 16 + index * 8, typeof values[index] === "number" ? values[index] : NaN, true);
  }
  const output = animationStatus(() => `The ${property.name ?? "length"} value ${observedText(input)}`,
    "animation_value_normalize", property.id, pointer, ...keywordInput);
  view = new DataView(core.refreshBytes().buffer);
  const normalized = { kind: view.getUint32(output, true), tag: view.getUint32(output + 4, true),
    values: Array.from({ length: view.getUint32(output + 8, true) }, (_, index) => view.getFloat64(output + 16 + index * 8, true)) };
  if (components) normalized.components = components;
  return normalized;
}

export function animationProperty(name) {
  const id = core.status("animation_property", ...core.input(name));
  return id ? { id, name: core.outputString() } : null;
}
// A keyframe length as a pixel and percentage pair, or the keyword text
// of a value that does not interpolate. With $element, the font-relative
// and viewport-relative units compute against it (animation_length_parse).
export function animationLength(value, element = null) {
  if (typeof value === "number") return { kind: "lengthPercentage", pixels: value, percentage: 0 };
  const native = element?._domCore ?? core;
  const pointer = native.status("animation_length_parse", ...native.input(String(value)), element?._coreHandle ?? 0n);
  const bytes = native.refreshBytes();
  const view = new DataView(bytes.buffer);
  if (view.getUint32(pointer + 16, true) === 2) {
    return { kind: "lengthPercentage", pixels: view.getFloat64(pointer, true), percentage: view.getFloat64(pointer + 8, true) };
  }
  const text = view.getUint32(pointer + 24, true);
  const length = view.getUint32(pointer + 28, true);
  return { kind: "keyword", keyword: native.decoder.decode(bytes.subarray(text, text + length)) };
}
export function animationLineHeight(value, element = null) {
  const native = element?._domCore ?? core;
  const pointer = native.status("animation_length_parse", ...native.input(String(value)), element?._coreHandle ?? 0n);
  const view = new DataView(native.refreshBytes().buffer);
  const number = view.getFloat64(pointer, true);
  const unit = view.getUint32(pointer + 20, true);
  // Unit 3 (not a line height) has no name.
  return { kind: "lineHeight", value: number, unit: native.string("animation_enumeration_name", 4, unit) || undefined };
}


// A number of the animation timing or of an easing. $label names it in an
// error: mode 0 takes a finite number, mode 1 a positive integer, mode 2 a
// number from 0 to infinity.
export function animationNumber(value, label, mode = 0) {
  try {
    return core.statusRaw("animation_number", typeof value === "number" ? value : NaN, mode);
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    throw new error.constructor(`${label} ${observedText(value)} ${error.message}`, { cause: error });
  }
}
// The animation_easing_normalize input of $easing: [kind, pointer, count].
function animationEasingInput(easing) {
  if (typeof easing === "string") return [0, ...core.input(easing)];
  let kind, values;
  if (easing.kind === "cubicBezier") {
    kind = 1;
    values = [easing.x1, easing.y1, easing.x2, easing.y2].map((value) => animationNumber(value, "The cubic-bezier() number"));
  } else if (easing.kind === "steps") {
    kind = 2;
    const steps = animationNumber(easing.count, "The steps() count", 1);
    values = [steps, core.exports.animation_step_position_index(...core.input(String(easing.position)))];
  } else if (easing.kind === "linear") {
    kind = 3;
    if (!Array.isArray(easing.points)) throw new TypeError("linear() needs at least one point");
    values = easing.points.flatMap((point) => [
      animationNumber(point.input, "The linear() input"), animationNumber(point.output, "The linear() output"),
    ]);
  } else { kind = 4; values = []; }
  const pointer = core.exports.abi_allocate(values.length * 8);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < values.length; index++) view.setFloat64(pointer + index * 8, values[index], true);
  return [kind, pointer, kind === 3 ? values.length / 2 : values.length];
}
export function normalizeAnimationEasing(easing = "linear") {
  const output = animationStatus(() => `The easing ${observedText(easing)}`,
    "animation_easing_normalize", ...animationEasingInput(easing));
  const view = new DataView(core.refreshBytes().buffer);
  const result = { kind: view.getUint32(output, true) };
  if (result.kind === 3) {
    result.points = Array.from({ length: view.getUint32(output + 40, true) }, (_, index) => ({
      input: view.getFloat64(output + 48 + index * 16, true), output: view.getFloat64(output + 56 + index * 16, true),
    }));
  } else {
    result.payload = Array.from({ length: result.kind === 1 ? 4 : result.kind === 2 ? 2 : 0 },
      (_, index) => view.getFloat64(output + 8 + index * 8, true));
  }
  return result;
}
// The computed timing of the animation record $handle at $now: the core
// reads its timing record and eases the progress through the engine. A
// null member is NaN in the core.
export function animationComputedTiming(handle, now, { endDelay, iterationStart, direction, fill, easing }) {
  // The easing input runs core operations, which end older input blocks:
  // it is marshalled before the keyword text.
  const easingInput = animationEasingInput(easing);
  const output = core.status("animation_computed_timing", handle, now, endDelay, iterationStart,
    ...core.input(String(direction)), ...core.input(String(fill)), ...easingInput);
  const view = new DataView(core.refreshBytes().buffer);
  const read = (offset) => {
    const value = view.getFloat64(output + offset, true);
    return Number.isNaN(value) ? null : value;
  };
  return {
    activeDuration: read(8), currentIteration: read(24), endTime: read(16),
    localTime: read(0), progress: read(32),
  };
}

// The keyframes of $propertyName among $keyframes, whose offsets are
// computed (normalizeAnimationOffsets): each keyframe that holds a value
// of the property, as { offset, easing, composite, value }. The core
// selects them and requires values at offsets 0 and 1.
export function animationPropertyFrames(keyframes, propertyName) {
  const pointer = core.exports.abi_allocate(keyframes.length * 16);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < keyframes.length; index++) {
    view.setFloat64(pointer + index * 16, keyframes[index].offset, true);
    view.setUint32(pointer + index * 16 + 8, keyframes[index][propertyName] === undefined ? 0 : 1, true);
  }
  const count = core.exports.animation_property_frames(pointer, keyframes.length);
  try {
    core.throwIfError(true);
  } catch (error) {
    throw new TypeError(`The ${propertyName} keyframes are incomplete: ${error.message}`, { cause: error });
  }
  view = new DataView(core.refreshBytes().buffer);
  const output = core.exports.abi_output_pointer();
  return Array.from({ length: count }, (_, index) => {
    const frame = keyframes[view.getUint32(output + index * 4, true)];
    return { offset: frame.offset, easing: frame.easing, composite: frame.composite, value: frame[propertyName] };
  });
}
export function sampleAnimationContent(record, timeMilliseconds) {
  const { timing, keyframes } = record.definition;
  const easing = keyframes[0]?.easing ?? timing.easing;
  const easingInput = animationEasingInput(typeof easing === "string" ? parseCSSEasing(easing) : easing);
  const pointer = core.exports.abi_allocate(keyframes.length * 16);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < keyframes.length; index++) {
    view.setFloat64(pointer + index * 16, keyframes[index].offset ?? NaN, true);
    view.setUint32(pointer + index * 16 + 8, keyframes[index].content === undefined ? 0 : 1, true);
  }
  const index = animationStatus(() => `Animation ${JSON.stringify(record.definition.name)}`,
    "animation_content_sample", pointer, keyframes.length,
    Number(timing.duration), Number(timing.iterations), timeMilliseconds, record.startTimeMilliseconds,
    Number(timing.delay ?? 0), ...core.input(String(timing.direction)), ...core.input(String(timing.fill)),
    record.definition.paused ? 1 : 0, ...easingInput);
  return index < 0 ? record.initialContent : keyframes[index]?.content;
}

const deferredBindingFinalizer = new FinalizationRegistry((handle) => {
  core.status("animation_binding_release", handle);
});
export function deferAnimationBinding(declare) {
  let binding = core.handle("animation_binding_create");
  let engineHandle = null;
  const command = (kind, value = 0, sample = 0) => {
    if (binding) core.status("animation_binding_command", binding, kind, value, sample);
  };
  const handle = Object.freeze({
    get trackIndices() { return engineHandle?.trackIndices ?? []; },
    pause(time) { if (engineHandle) engineHandle.pause(time); else command(1, time); },
    resume(time) { if (engineHandle) engineHandle.resume(time); else command(2, time); },
    seek(local, sample) { if (engineHandle) engineHandle.seek(local, sample); else command(3, local, sample); },
    cancelSilently() { if (engineHandle) engineHandle.cancelSilently(); else command(4); },
    cancel() { if (engineHandle) engineHandle.cancel(); else command(4); },
  });
  deferredBindingFinalizer.register(handle, binding, handle);
  const release = () => {
    if (!binding) return;
    deferredBindingFinalizer.unregister(handle);
    core.status("animation_binding_release", binding);
    binding = 0n;
  };
  return {
    handle, release,
    bind(renderer, nodeIndex) {
      if (!binding) return;
      if (core.status("animation_binding_canceled", binding)) { release(); return; }
      engineHandle = declare(renderer, nodeIndex);
      const count = core.status("animation_binding_export", binding);
      const pointer = core.exports.abi_output_pointer();
      const view = new DataView(core.refreshBytes().buffer);
      const commands = Array.from({ length: count }, (_, index) => {
        const row = pointer + index * 24;
        return [view.getUint32(row, true), view.getFloat64(row + 8, true), view.getFloat64(row + 16, true)];
      });
      for (const [kind, value, sample] of commands) {
        if (kind === 3) engineHandle.seek(value, sample);
        else engineHandle[kind === 1 ? "pause" : "resume"](value);
      }
      release();
    },
  };
}
