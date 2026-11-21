import { sharedDomCore as core } from "./core.js";
import { parseCSSEasing } from "./easing.js";
import { layoutConstant } from "../wasm/layout-table.js";

const ANIMATION_ENUMERATION_EVENT_TYPE = layoutConstant("ANIMATION_ENUMERATION_EVENT_TYPE");
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const KEYFRAME_OFFSET_SIZE = layoutConstant("KEYFRAME_OFFSET_SIZE");
const KEYFRAME_OFFSET_VALUE = layoutConstant("KEYFRAME_OFFSET_VALUE");
const KEYFRAME_OFFSET_SOURCE = layoutConstant("KEYFRAME_OFFSET_SOURCE");
const KEYFRAME_OFFSET_SPECIFIED = layoutConstant("KEYFRAME_OFFSET_SPECIFIED");
const KEYFRAME_PROPERTY_SIZE = layoutConstant("KEYFRAME_PROPERTY_SIZE");
const KEYFRAME_PROPERTY_NAME = layoutConstant("KEYFRAME_PROPERTY_NAME");
const KEYFRAME_PROPERTY_NAME_LENGTH = layoutConstant("KEYFRAME_PROPERTY_NAME_LENGTH");
const KEYFRAME_PROPERTY_VALUES = layoutConstant("KEYFRAME_PROPERTY_VALUES");
const KEYFRAME_ARRANGEMENT_FRAMES = layoutConstant("KEYFRAME_ARRANGEMENT_FRAMES");
const KEYFRAME_ARRANGEMENT_ASSIGNMENTS = layoutConstant("KEYFRAME_ARRANGEMENT_ASSIGNMENTS");
const KEYFRAME_ARRANGEMENT_HEADER_SIZE = layoutConstant("KEYFRAME_ARRANGEMENT_HEADER_SIZE");
const KEYFRAME_SLOT_SIZE = layoutConstant("KEYFRAME_SLOT_SIZE");
const KEYFRAME_SLOT_OFFSET = layoutConstant("KEYFRAME_SLOT_OFFSET");
const KEYFRAME_SLOT_EASING = layoutConstant("KEYFRAME_SLOT_EASING");
const KEYFRAME_SLOT_COMPOSITE = layoutConstant("KEYFRAME_SLOT_COMPOSITE");
const KEYFRAME_ASSIGNMENT_SIZE = layoutConstant("KEYFRAME_ASSIGNMENT_SIZE");
const KEYFRAME_ASSIGNMENT_FIELDS = [
  layoutConstant("KEYFRAME_ASSIGNMENT_NAME"),
  layoutConstant("KEYFRAME_ASSIGNMENT_VALUE"),
  layoutConstant("KEYFRAME_ASSIGNMENT_FRAME"),
];
const TEXT_ROW_SIZE = layoutConstant("TEXT_ROW_SIZE");
const TEXT_ROW_POINTER = layoutConstant("TEXT_ROW_POINTER");
const TEXT_ROW_LENGTH = layoutConstant("TEXT_ROW_LENGTH");
const TRACK_EVENT_SIZE = layoutConstant("TRACK_EVENT_SIZE");
const TRACK_EVENT_SLOT = layoutConstant("TRACK_EVENT_SLOT");
const TRACK_EVENT_TYPE = layoutConstant("TRACK_EVENT_TYPE");
const TRACK_SETTLED_SIZE = layoutConstant("TRACK_SETTLED_SIZE");
const TRACK_SETTLED_IDENTITY = layoutConstant("TRACK_SETTLED_IDENTITY");
const TRACK_SETTLED_ANIMATION = layoutConstant("TRACK_SETTLED_ANIMATION");
const TRACK_SETTLED_GENERATION = layoutConstant("TRACK_SETTLED_GENERATION");
const TRACK_ENDED_SIZE = layoutConstant("TRACK_ENDED_SIZE");
const ANIMATION_FEEDBACK_SIZE = layoutConstant("ANIMATION_FEEDBACK_SIZE");
const ANIMATION_FEEDBACK_IDENTITY = layoutConstant("ANIMATION_FEEDBACK_IDENTITY");
const ANIMATION_FEEDBACK_SLOT = layoutConstant("ANIMATION_FEEDBACK_SLOT");
// Each feedback field and the engine track record field it carries.
const ANIMATION_FEEDBACK_FIELDS = Object.freeze([
  ["ANIMATION_FEEDBACK_NODE", "ANIMATION_RECORD_NODE", "getUint16"],
  ["ANIMATION_FEEDBACK_PROPERTY", "ANIMATION_RECORD_PROPERTY", "getUint16"],
  ["ANIMATION_FEEDBACK_FLAGS", "ANIMATION_RECORD_FLAGS", "getUint8"],
  ["ANIMATION_FEEDBACK_STATE", "ANIMATION_RECORD_STATE", "getUint8"],
  ["ANIMATION_FEEDBACK_STARTED", "ANIMATION_RECORD_STARTED", "getUint8"],
  ["ANIMATION_FEEDBACK_SEQUENCE", "ANIMATION_RECORD_SEQUENCE", "getUint32"],
  ["ANIMATION_FEEDBACK_COMPOSITE", "ANIMATION_RECORD_COMPOSITE", "getUint8"],
].map(([feedback, record, read]) => [layoutConstant(feedback), layoutConstant(record), read]));
const VALUE_ENVELOPE_KIND = layoutConstant("VALUE_ENVELOPE_KIND");
const VALUE_ENVELOPE_TAG = layoutConstant("VALUE_ENVELOPE_TAG");
const VALUE_ENVELOPE_COUNT = layoutConstant("VALUE_ENVELOPE_COUNT");
const VALUE_ENVELOPE_VALUES = layoutConstant("VALUE_ENVELOPE_VALUES");
// A canonical animation value (ANIMATION_VALUE_*), the result of
// animation_value_from_text and animation_value_compose.
const ANIMATION_VALUE = Object.freeze(Object.fromEntries(["COMPONENT_COUNT", "TEXT_POINTER", "TEXT_LENGTH", "COMPONENTS",
  "COMPONENT_SIZE", "COMPONENT_KIND", "COMPONENT_NAME", "COMPONENT_PARAMETERS"]
  .map((name) => [name, layoutConstant(`ANIMATION_VALUE_${name}`)])));
export const ANIMATION_VALUE_TAG_IN_VALUES = layoutConstant("ANIMATION_VALUE_TAG_IN_VALUES");
const KEYFRAME_VALUE_NEEDS_COLOR = layoutConstant("KEYFRAME_VALUE_NEEDS_COLOR");
const KEYFRAME_VALUE_NEEDS_PARENT_COLOR = layoutConstant("KEYFRAME_VALUE_NEEDS_PARENT_COLOR");
const KEYFRAME_VALUE_UNSET = layoutConstant("KEYFRAME_VALUE_UNSET");
const KEYFRAME_VALUE_KEYWORD = layoutConstant("KEYFRAME_VALUE_KEYWORD");
const COMPUTED_TIMING_LOCAL = layoutConstant("COMPUTED_TIMING_LOCAL");
const COMPUTED_TIMING_ACTIVE = layoutConstant("COMPUTED_TIMING_ACTIVE");
const COMPUTED_TIMING_END = layoutConstant("COMPUTED_TIMING_END");
const COMPUTED_TIMING_ITERATION = layoutConstant("COMPUTED_TIMING_ITERATION");
const COMPUTED_TIMING_PROGRESS = layoutConstant("COMPUTED_TIMING_PROGRESS");
const EASING_KIND_KEYWORD = layoutConstant("EASING_KIND_KEYWORD");
const EASING_KIND_CUBIC = layoutConstant("EASING_KIND_CUBIC");
const EASING_KIND_STEPS = layoutConstant("EASING_KIND_STEPS");
const EASING_KIND_LINEAR = layoutConstant("EASING_KIND_LINEAR");
const EASING_KIND_UNSUPPORTED = layoutConstant("EASING_KIND_UNSUPPORTED");
const EASING_RECORD_KIND = layoutConstant("EASING_RECORD_KIND");
const EASING_RECORD_PAYLOAD = layoutConstant("EASING_RECORD_PAYLOAD");
const EASING_RECORD_POINT_COUNT = layoutConstant("EASING_RECORD_POINT_COUNT");
const EASING_RECORD_HEADER_SIZE = layoutConstant("EASING_RECORD_HEADER_SIZE");
const EASING_POINT_SIZE = layoutConstant("EASING_POINT_SIZE");
const EASING_POINT_INPUT = layoutConstant("EASING_POINT_INPUT");
const EASING_POINT_OUTPUT = layoutConstant("EASING_POINT_OUTPUT");
const CSS_DEFINITION_SIZE = layoutConstant("CSS_DEFINITION_SIZE");
const CSS_DEFINITION_NAME = layoutConstant("CSS_DEFINITION_NAME");
const CSS_DEFINITION_NAME_LENGTH = layoutConstant("CSS_DEFINITION_NAME_LENGTH");
const CSS_DEFINITION_SIGNATURE = layoutConstant("CSS_DEFINITION_SIGNATURE");
const CSS_DEFINITION_SIGNATURE_LENGTH = layoutConstant("CSS_DEFINITION_SIGNATURE_LENGTH");
const CSS_DEFINITION_OCCURRENCE = layoutConstant("CSS_DEFINITION_OCCURRENCE");
const CSS_DEFINITION_INDEX = layoutConstant("CSS_DEFINITION_INDEX");
const CSS_RECONCILED_SIZE = layoutConstant("CSS_RECONCILED_SIZE");
const CSS_RECONCILED_REUSE = layoutConstant("CSS_RECONCILED_REUSE");
const CSS_RECONCILED_OCCURRENCE = layoutConstant("CSS_RECONCILED_OCCURRENCE");
const CSS_RECONCILED_MATCH = layoutConstant("CSS_RECONCILED_MATCH");
const CSS_PREVIOUS_TIMELINE_SIZE = layoutConstant("CSS_PREVIOUS_TIMELINE_SIZE");
const CSS_PREVIOUS_TIMELINE_HANDLE = layoutConstant("CSS_PREVIOUS_TIMELINE_HANDLE");
const CSS_PREVIOUS_TIMELINE_TEXT = layoutConstant("CSS_PREVIOUS_TIMELINE_TEXT");
const CSS_PREVIOUS_TIMELINE_TEXT_LENGTH = layoutConstant("CSS_PREVIOUS_TIMELINE_TEXT_LENGTH");
const CSS_DESIRED_TIMELINE_SIZE = layoutConstant("CSS_DESIRED_TIMELINE_SIZE");
const CSS_DESIRED_TIMELINE_TEXT = layoutConstant("CSS_DESIRED_TIMELINE_TEXT");
const CSS_DESIRED_TIMELINE_TEXT_LENGTH = layoutConstant("CSS_DESIRED_TIMELINE_TEXT_LENGTH");
const CSS_PLAN_SIZE = layoutConstant("CSS_PLAN_SIZE");
const CSS_PLAN_RETAINED = layoutConstant("CSS_PLAN_RETAINED");
const CSS_PLAN_KIND = layoutConstant("CSS_PLAN_KIND");
const CSS_PLAN_OCCURRENCE = layoutConstant("CSS_PLAN_OCCURRENCE");
const CSS_PLAN_MATCH = layoutConstant("CSS_PLAN_MATCH");
export const CSS_PLAN_KEEP = layoutConstant("CSS_PLAN_KEEP");
export const CSS_PLAN_UPDATE = layoutConstant("CSS_PLAN_UPDATE");
const CSS_PLACE_SIZE = layoutConstant("CSS_PLACE_SIZE");
const CSS_PLACE_POSITION = layoutConstant("CSS_PLACE_POSITION");
const CSS_PLACE_RETAINED = layoutConstant("CSS_PLACE_RETAINED");
const CSS_PLACE_MATCH = layoutConstant("CSS_PLACE_MATCH");
const FRAME_PRESENCE_SIZE = layoutConstant("FRAME_PRESENCE_SIZE");
const FRAME_PRESENCE_OFFSET = layoutConstant("FRAME_PRESENCE_OFFSET");
const FRAME_PRESENCE_PRESENT = layoutConstant("FRAME_PRESENCE_PRESENT");
// The CONTENT_FRAME rows of animation_content_sample.
const CONTENT_FRAME = Object.freeze(Object.fromEntries([
  "SIZE", "OFFSET", "PRESENT", "EASING_KIND", "EASING_POINTER", "EASING_COUNT",
].map((name) => [name, layoutConstant(`CONTENT_FRAME_${name}`)])));
const CONTENT_TIMES_START = layoutConstant("CONTENT_TIMES_START");
const CONTENT_TIMES_HOLD = layoutConstant("CONTENT_TIMES_HOLD");
// FRAME_PRESENCE rows of $keyframes: each offset, and whether $present.
function framePresenceRows(keyframes, offsetOf, present) {
  const pointer = core.exports.abi_allocate(keyframes.length * FRAME_PRESENCE_SIZE);
  const view = new DataView(core.refreshBytes().buffer);
  keyframes.forEach((keyframe, index) => {
    view.setFloat64(pointer + index * FRAME_PRESENCE_SIZE + FRAME_PRESENCE_OFFSET, offsetOf(keyframe), true);
    view.setUint32(pointer + index * FRAME_PRESENCE_SIZE + FRAME_PRESENCE_PRESENT, present(keyframe) ? 1 : 0, true);
  });
  return pointer;
}
const TRANSITION_DEFINITION_SIZE = layoutConstant("TRANSITION_DEFINITION_SIZE");
const TRANSITION_DEFINITION_NAME = layoutConstant("TRANSITION_DEFINITION_NAME");
const TRANSITION_DEFINITION_NAME_LENGTH = layoutConstant("TRANSITION_DEFINITION_NAME_LENGTH");
const TRANSITION_DEFINITION_DURATION = layoutConstant("TRANSITION_DEFINITION_DURATION");
const TRANSITION_DEFINITION_DELAY = layoutConstant("TRANSITION_DEFINITION_DELAY");
const TRANSITION_DEFINITION_EASING = layoutConstant("TRANSITION_DEFINITION_EASING");
const TRANSITION_DEFINITION_EASING_LENGTH = layoutConstant("TRANSITION_DEFINITION_EASING_LENGTH");
const BINDING_COMMAND_PAUSE = layoutConstant("BINDING_COMMAND_PAUSE");
const BINDING_COMMAND_RESUME = layoutConstant("BINDING_COMMAND_RESUME");
const BINDING_COMMAND_SEEK = layoutConstant("BINDING_COMMAND_SEEK");
const BINDING_COMMAND_CANCEL = layoutConstant("BINDING_COMMAND_CANCEL");
const BINDING_COMMAND_SIZE = layoutConstant("BINDING_COMMAND_SIZE");
const BINDING_COMMAND_KIND = layoutConstant("BINDING_COMMAND_KIND");
const BINDING_COMMAND_LOCAL = layoutConstant("BINDING_COMMAND_LOCAL");
const BINDING_COMMAND_SAMPLE = layoutConstant("BINDING_COMMAND_SAMPLE");

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
  const pointer = core.exports.abi_allocate(frames.length * KEYFRAME_OFFSET_SIZE);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) {
    const offset = frames[index].offset;
    // Property access and Number.isFinite's noncoercing contract belong here.
    if (index > 0 && offset != null && typeof offset !== "number") {
      throw new TypeError("keyframe offset must be finite");
    }
    const at = pointer + index * KEYFRAME_OFFSET_SIZE;
    view.setFloat64(at + KEYFRAME_OFFSET_VALUE, offset ?? NaN, true);
    view.setUint32(at + KEYFRAME_OFFSET_SOURCE, index, true);
    view.setUint32(at + KEYFRAME_OFFSET_SPECIFIED, offset == null ? 0 : 1, true);
  }
  const count = animationStatus(() => `The keyframe offsets [${frames.map(({ offset }) => String(offset ?? null)).join(", ")}]`,
    "animation_offsets", pointer, frames.length);
  const output = count === 0 ? null : core.output("animation_offsets");
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const at = index * KEYFRAME_OFFSET_SIZE;
    const frame = frames[output.getUint32(at + KEYFRAME_OFFSET_SOURCE, true)];
    frame.offset = output.getFloat64(at + KEYFRAME_OFFSET_VALUE, true);
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
  const rows = core.exports.abi_allocate(Math.max(1, properties.length) * KEYFRAME_PROPERTY_SIZE);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < properties.length; index++) {
    const at = rows + index * KEYFRAME_PROPERTY_SIZE;
    view.setUint32(at + KEYFRAME_PROPERTY_NAME, names[index][0], true);
    view.setUint32(at + KEYFRAME_PROPERTY_NAME_LENGTH, names[index][1], true);
    view.setUint32(at + KEYFRAME_PROPERTY_VALUES, properties[index][1].length, true);
  }
  core.status("animation_keyframes_arrange", rows, properties.length, offsetCount, easingCount, compositeCount);
  const output = core.output("animation_keyframes_arrange");
  const frameCount = output.getUint32(KEYFRAME_ARRANGEMENT_FRAMES, true);
  const slots = KEYFRAME_ARRANGEMENT_HEADER_SIZE;
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    offsetIndex: output.getInt32(slots + index * KEYFRAME_SLOT_SIZE + KEYFRAME_SLOT_OFFSET, true),
    easingIndex: output.getInt32(slots + index * KEYFRAME_SLOT_SIZE + KEYFRAME_SLOT_EASING, true),
    compositeIndex: output.getInt32(slots + index * KEYFRAME_SLOT_SIZE + KEYFRAME_SLOT_COMPOSITE, true),
  }));
  const base = slots + frameCount * KEYFRAME_SLOT_SIZE;
  const assignments = Array.from({ length: output.getUint32(KEYFRAME_ARRANGEMENT_ASSIGNMENTS, true) }, (_, index) =>
    KEYFRAME_ASSIGNMENT_FIELDS.map((field) => output.getUint32(base + index * KEYFRAME_ASSIGNMENT_SIZE + field, true)));
  return { frames, assignments };
}

// A canonical animation value of one animation property: the core's
// normalized envelope (`kind`, `tag`, `values`), its `components` (a
// transform's functions or a shadow list's geometry and colour pairs, each
// `{ kind, name, parameters }`) and its CSS `text`, as Chrome reports a
// keyframe's computed value. The engine declares tracks from it; the host
// only carries it.
export class AnimationValue {
  constructor(propertyId, kind, tag, values, components, text) {
    this.propertyId = propertyId;
    this.kind = kind;
    this.tag = tag;
    this.values = Object.freeze(values);
    this.components = Object.freeze(components.map((component) => Object.freeze(component)));
    this.text = text;
    Object.freeze(this);
  }
  toString() { return this.text; }
}
// The canonical value that operation $operation of $native published as its
// standard output.
function readAnimationValue(native, operation, propertyId) {
  const view = native.output(operation);
  const count = view.getUint32(VALUE_ENVELOPE_COUNT, true);
  const components = Array.from({ length: view.getUint32(ANIMATION_VALUE.COMPONENT_COUNT, true) }, (_, index) => {
    const row = ANIMATION_VALUE.COMPONENTS + index * ANIMATION_VALUE.COMPONENT_SIZE;
    return {
      kind: view.getUint32(row + ANIMATION_VALUE.COMPONENT_KIND, true),
      name: view.getUint32(row + ANIMATION_VALUE.COMPONENT_NAME, true),
      parameters: Array.from({ length: 6 }, (_, parameter) =>
        view.getFloat64(row + ANIMATION_VALUE.COMPONENT_PARAMETERS + parameter * F64, true)),
    };
  });
  return new AnimationValue(propertyId, view.getUint32(VALUE_ENVELOPE_KIND, true),
    view.getUint32(VALUE_ENVELOPE_TAG, true),
    Array.from({ length: count }, (_, index) => view.getFloat64(VALUE_ENVELOPE_VALUES + index * F64, true)),
    components, view.memoryText(native.decoder, view.getUint32(ANIMATION_VALUE.TEXT_POINTER, true),
      view.getUint32(ANIMATION_VALUE.TEXT_LENGTH, true)));
}
// The canonical value of animation property $property from CSS text
// (animation_value_from_text), computed in $element's context on its core.
// $context (animationKeyframeContext) gives the colour currentcolor names
// (`currentColor(parent)`: { r, g, b, a }), the element's underlying value
// (`underlyingValue(name)`), which a value invalid at computed-value time
// takes (it is unset), and the value a CSS-wide keyword computes to on the
// element (`keywordValue(name, keyword)`). Without $context, a value that
// names currentcolor is a TypeError.
export function animationValueFromText(property, text, element = null, context = null) {
  const native = element?._domCore ?? core;
  const source = String(text);
  const call = (color) => {
    try {
      return native.statusRaw("animation_value_from_text", property.id, ...native.input(source), element?._coreHandle ?? 0n,
        color ? 1 : 0, color?.r ?? 0, color?.g ?? 0, color?.b ?? 0, color?.a ?? 0);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new error.constructor(`The ${property.name} keyframe value ${source.trim()} ${error.message}`, { cause: error });
    }
  };
  const status = call(null);
  if (status === KEYFRAME_VALUE_UNSET) {
    if (context === null) throw new Error(`The ${property.name} keyframe value ${source.trim()} became unset without its element's context`);
    return animationValueFromText(property, context.underlyingValue(property.name), element, context);
  }
  if (status === KEYFRAME_VALUE_KEYWORD) {
    if (context === null) {
      throw new TypeError(`The ${property.name} keyframe value ${source.trim()} is a CSS-wide keyword, which needs its target element`);
    }
    return animationValueFromText(property, context.keywordValue(property.name, source.trim()), element, context);
  }
  if (status === KEYFRAME_VALUE_NEEDS_COLOR || status === KEYFRAME_VALUE_NEEDS_PARENT_COLOR) {
    if (context === null) {
      throw new TypeError(`The ${property.name} keyframe value ${source.trim()} needs the color of its target element`);
    }
    call(context.currentColor(status === KEYFRAME_VALUE_NEEDS_PARENT_COLOR));
  }
  return readAnimationValue(native, "animation_value_from_text", property.id);
}
// The canonical value of animation property $property from an engine
// value: its `tag` (ANIMATION_VALUE_TAG_IN_VALUES when its second number
// carries it), up to six `values` and its `components` ({ kind, parameters
// }); a transform's functions take their names after the canonical value
// $source (animation_value_compose).
export function composeAnimationValue(property, { tag, values, components = [] }, source = null) {
  const write = (value) => {
    const pointer = core.exports.abi_allocate(ANIMATION_VALUE.COMPONENTS + value.components.length * ANIMATION_VALUE.COMPONENT_SIZE);
    const bytes = core.refreshBytes();
    bytes.fill(0, pointer, pointer + ANIMATION_VALUE.COMPONENTS + value.components.length * ANIMATION_VALUE.COMPONENT_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(pointer + VALUE_ENVELOPE_TAG, value.tag, true);
    value.values.forEach((number, index) => view.setFloat64(pointer + VALUE_ENVELOPE_VALUES + index * F64, number, true));
    view.setUint32(pointer + ANIMATION_VALUE.COMPONENT_COUNT, value.components.length, true);
    value.components.forEach((component, index) => {
      const row = pointer + ANIMATION_VALUE.COMPONENTS + index * ANIMATION_VALUE.COMPONENT_SIZE;
      view.setUint32(row + ANIMATION_VALUE.COMPONENT_KIND, component.kind, true);
      view.setUint32(row + ANIMATION_VALUE.COMPONENT_NAME, component.name ?? 0, true);
      component.parameters.forEach((number, parameter) =>
        view.setFloat64(row + ANIMATION_VALUE.COMPONENT_PARAMETERS + parameter * F64, number, true));
    });
    return pointer;
  };
  const sourcePointer = source === null ? 0 : write(source);
  core.status("animation_value_compose", property.id, write({ tag, values, components }), sourcePointer);
  return readAnimationValue(core, "animation_value_compose", property.id);
}
// The canonical value of a keyframe or transition value of $property:
// a canonical value of the property, or CSS text computed without an
// element.
export function canonicalAnimationValue(property, value) {
  if (value instanceof AnimationValue) {
    if (value.propertyId !== property.id) {
      throw new TypeError(`A ${animationPropertyName(value.propertyId)} value ${value.text} does not apply to ${property.name}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(`The ${property.name} value ${observedText(value)} is neither CSS text nor a canonical animation value`);
  }
  return animationValueFromText(property, value);
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
  const kinds = core.exports.abi_allocate(Math.max(1, frames.length) * U32);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < frames.length; index++) view.setUint32(kinds + index * U32, frames[index].value.kind, true);
  return core.status("animation_track_kind", propertyKind, composite, kinds, frames.length);
}

// The canonical CSS name of an animation property id, or null.
export function animationPropertyName(id) {
  return core.string("animation_property_name", id);
}
// The name of native value $value of an animation enumeration
// (animation_enumeration_name).
export function animationEnumerationName(enumeration, value) {
  return core.string("animation_enumeration_name", enumeration, value);
}
// The DOM event type of an engine animation event type id.
export function animationEventName(typeId) {
  return animationEnumerationName(ANIMATION_ENUMERATION_EVENT_TYPE, typeId);
}
// The engine fill and direction modes of fill and direction keyword text
// (animation_fill_mode, animation_direction_mode).
export function animationFillMode(fill) {
  return core.exports.animation_fill_mode(...core.input(String(fill)));
}
export function animationDirectionMode(direction) {
  return core.exports.animation_direction_mode(...core.input(String(direction)));
}
// Records in animation `animationId` of core `native` whether its keyframe
// `values` follow its element (animation_keyframes_follow_element_set).
export function recordKeyframesFollowElement(native, animationId, values) {
  const inputs = values.map((value) => native.input(String(value)));
  const rows = native.exports.abi_allocate(Math.max(1, values.length) * TEXT_ROW_SIZE);
  const view = new DataView(native.refreshBytes().buffer);
  inputs.forEach(([pointer, length], index) => {
    view.setUint32(rows + index * TEXT_ROW_SIZE + TEXT_ROW_POINTER, pointer, true);
    view.setUint32(rows + index * TEXT_ROW_SIZE + TEXT_ROW_LENGTH, length, true);
  });
  native.status("animation_keyframes_follow_element_set", animationId, rows, values.length);
}
// The member kind of keyframe key `name` (animation_keyframe_member):
// KEYFRAME_MEMBER.PROPERTY for an animated property, else the reserved
// key it is.
export const KEYFRAME_MEMBER = Object.freeze(Object.fromEntries(["PROPERTY", "OFFSET", "EASING", "COMPOSITE"]
  .map((name) => [name, layoutConstant(`ANIMATION_KEYFRAME_MEMBER_${name}`)])));
export function keyframeMember(name) {
  return core.exports.animation_keyframe_member(...core.input(String(name)));
}
export function keyframePropertyNames(keyframe) {
  return Object.keys(keyframe).filter((name) => keyframeMember(name) === KEYFRAME_MEMBER.PROPERTY);
}
// Throws the failure of an engine animation_track_declare result code.
export function throwAnimationDeclarationError(code) {
  core.status("animation_declaration_error", code);
  throw new Error(`animation_declaration_error reported no failure for code ${code}`);
}

// The table of the engine tracks one animation controller holds
// (animation-track-table.watpart).
export function createAnimationTrackTable() {
  return core.handle("animation_tracks_create");
}
export function releaseAnimationTrackTable(table) {
  core.status("animation_tracks_release", table);
}
export function bindAnimationTrack(table, slot, animationId, generation) {
  return core.handle("animation_tracks_bind", table, slot, animationId ?? 0n, generation ?? 0);
}
// The identity of a held slot, or 0n.
export function animationTrackIdentity(table, slot) {
  return core.status("animation_tracks_identity", table, slot);
}
export function animationTrackAnimationId(table, slot) {
  return core.status("animation_tracks_animation_id", table, slot);
}
export function animationTrackCount(table) {
  return core.status("animation_tracks_count", table);
}
// The held slots in ascending order.
export function animationTrackSlots(table) {
  const count = core.status("animation_tracks_slots", table);
  if (count === 0) return [];
  return Array.from(new Uint32Array(core.outputBytes("animation_tracks_slots", 0, count * 4).buffer));
}
// Takes what one engine operation queued: `events` of { slot, type } and
// the `ended` slots. Returns each event's { identity, animationId,
// trackGeneration } and each ended track's identity. With `deliver`, the
// events open a delivery batch that endAnimationTrackBatch closes.
export function settleAnimationTracks(table, events, ended, deliver) {
  const endedStart = events.length * TRACK_EVENT_SIZE;
  const input = new DataView(new ArrayBuffer(Math.max(4, endedStart + ended.length * 4)));
  events.forEach(({ slot, type }, index) => {
    input.setUint32(index * TRACK_EVENT_SIZE + TRACK_EVENT_SLOT, slot, true);
    input.setUint32(index * TRACK_EVENT_SIZE + TRACK_EVENT_TYPE, type, true);
  });
  ended.forEach((slot, index) => input.setUint32(endedStart + index * U32, slot, true));
  const [pointer] = core.byteInput(new Uint8Array(input.buffer));
  core.status("animation_tracks_settle", table, pointer, events.length, pointer + endedStart,
    ended.length, deliver);
  const view = core.output("animation_tracks_settle");
  return {
    events: events.map((_, index) => ({
      identity: view.getBigUint64(index * TRACK_SETTLED_SIZE + TRACK_SETTLED_IDENTITY, true),
      animationId: view.getBigUint64(index * TRACK_SETTLED_SIZE + TRACK_SETTLED_ANIMATION, true),
      trackGeneration: view.getUint32(index * TRACK_SETTLED_SIZE + TRACK_SETTLED_GENERATION, true),
    })),
    ended: ended.map((_, index) =>
      view.getBigUint64(events.length * TRACK_SETTLED_SIZE + index * TRACK_ENDED_SIZE, true)),
  };
}
export function animationTrackBatchLive(table, index) {
  return core.status("animation_tracks_batch_live", table, index) !== 0;
}
export function endAnimationTrackBatch(table) {
  core.status("animation_tracks_batch_end", table);
}
// The feedback rows of `candidates`, the tracks that may animate property
// $propertyId of node $nodeIndex (the chain of the owner's effect stack
// there): the only rows a replacement request can choose, so a declaration
// reads a few track identities, not one per held track. A slot the table
// does not hold has identity 0, which the request skips.
function snapshotAnimationTracks(engine, table, recordSize, candidates) {
  const identities = candidates.map((slot) => animationTrackIdentity(table, slot));
  // The core calls can grow the shared memory, so the engine rows are read
  // through a view taken after them.
  const engineView = new DataView(engine.memory.buffer);
  const tableBase = engine.exports.animation_table_base();
  const rows = candidates.map((slot, index) => {
    const address = tableBase + slot * recordSize;
    return { identity: identities[index], slot,
      fields: ANIMATION_FEEDBACK_FIELDS.map(([, field, read]) => engineView[read](address + field, true)) };
  });
  const pointer = core.exports.abi_allocate(Math.max(1, rows.length) * ANIMATION_FEEDBACK_SIZE);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < rows.length; index++) {
    const row = pointer + index * ANIMATION_FEEDBACK_SIZE;
    view.setBigUint64(row + ANIMATION_FEEDBACK_IDENTITY, rows[index].identity, true);
    view.setUint32(row + ANIMATION_FEEDBACK_SLOT, rows[index].slot, true);
    ANIMATION_FEEDBACK_FIELDS.forEach(([field], position) => view.setUint32(row + field, rows[index].fields[position], true));
  }
  return { pointer, count: rows.length };
}
export function nextAnimationReplacement(engine, table, recordSize, candidates, nodeIndex, propertyId, cursor) {
  const snapshot = snapshotAnimationTracks(engine, table, recordSize, candidates);
  return core.status("animation_replacement_next", snapshot.pointer, snapshot.count, nodeIndex, propertyId, cursor);
}
export function animationTransitionProperties(name) {
  const count = core.status("animation_transition_properties", ...core.input(name));
  const view = count === 0 ? null : core.output("animation_transition_properties");
  return Array.from({ length: count }, (_, index) => {
    const row = index * TEXT_ROW_SIZE;
    return view.memoryText(core.decoder, view.getUint32(row + TEXT_ROW_POINTER, true), view.getUint32(row + TEXT_ROW_LENGTH, true));
  });
}
// The indices of $names in the order the transitions of one style change
// take (animation_transition_name_order).
export function animationTransitionNameOrder(names) {
  if (names.length < 2) return names.map((_, index) => index);
  const inputs = names.map((name) => core.input(name));
  const rows = core.exports.abi_allocate(names.length * TEXT_ROW_SIZE);
  const input = new DataView(core.refreshBytes().buffer);
  inputs.forEach(([pointer, length], index) => {
    input.setUint32(rows + index * TEXT_ROW_SIZE + TEXT_ROW_POINTER, pointer, true);
    input.setUint32(rows + index * TEXT_ROW_SIZE + TEXT_ROW_LENGTH, length, true);
  });
  const count = core.status("animation_transition_name_order", rows, names.length);
  const order = core.output("animation_transition_name_order");
  return Array.from({ length: count }, (_, index) => order.getUint32(index * U32, true));
}

export function reconcileAnimationDefinitions(definitions, previous = []) {
  const desired = definitions.map((definition) => ({
    definition,
    signature: JSON.stringify({ name: definition.name, keyframes: definition.keyframes,
      composition: definition.composition, timing: definition.timing, paused: definition.paused }),
  }));
  const pointer = writeCSSDefinitionRows(core, [...previous, ...desired]);
  core.status("animation_css_reconcile", pointer, previous.length,
    pointer + previous.length * CSS_DEFINITION_SIZE, desired.length);
  const view = desired.length === 0 ? null : core.output("animation_css_reconcile");
  for (let index = 0; index < desired.length; index++) {
    const record = desired[index];
    const row = index * CSS_RECONCILED_SIZE;
    record.occurrence = view.getUint32(row + CSS_RECONCILED_OCCURRENCE, true);
    record.identity = `${record.definition.name}\u0000${record.occurrence}`;
    record.reusable = previous[view.getInt32(row + CSS_RECONCILED_REUSE, true)];
    record.previous = previous[view.getInt32(row + CSS_RECONCILED_MATCH, true)];
  }
  return desired;
}
// CSS_DEFINITION rows of `records`, each with its definition name,
// signature and occurrence, in the memory of core `native`.
function writeCSSDefinitionRows(native, records) {
  const pointer = native.exports.abi_allocate(Math.max(1, records.length) * CSS_DEFINITION_SIZE);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const [name, nameLength] = native.input(record.definition.name);
    const [signature, signatureLength] = native.input(record.signature);
    const view = new DataView(native.refreshBytes().buffer);
    const row = pointer + index * CSS_DEFINITION_SIZE;
    view.setUint32(row + CSS_DEFINITION_NAME, name, true);
    view.setUint32(row + CSS_DEFINITION_NAME_LENGTH, nameLength, true);
    view.setUint32(row + CSS_DEFINITION_SIGNATURE, signature, true);
    view.setUint32(row + CSS_DEFINITION_SIGNATURE_LENGTH, signatureLength, true);
    view.setUint32(row + CSS_DEFINITION_OCCURRENCE, record.occurrence ?? 0, true);
    view.setUint32(row + CSS_DEFINITION_INDEX, index, true);
  }
  return pointer;
}
// The plan of the CSS animations of `element` after a style change
// (animation_css_plan): `previous` is the element's records, each with its
// definition, signature, occurrence and animation. Returns the desired
// records with their occurrence, `retained` (the index of the previous
// record that continues, -1 none), `kind` (CSS_PLAN_KEEP, CSS_PLAN_UPDATE or
// CSS_PLAN_CREATE) and `match` (the index of the previous record of the same
// identity, -1 none), and `cancelled`, the previous records to cancel.
export function planCSSAnimations(element, definitions, previous) {
  const native = element._domCore;
  const desired = definitions.map((definition) => ({
    definition,
    signature: JSON.stringify({ name: definition.name, keyframes: definition.keyframes,
      composition: definition.composition, timing: definition.timing, paused: definition.paused }),
  }));
  const definitionRows = writeCSSDefinitionRows(native, [...previous, ...desired]);
  const previousTimelines = native.exports.abi_allocate(Math.max(1, previous.length) * CSS_PREVIOUS_TIMELINE_SIZE);
  for (let index = 0; index < previous.length; index++) {
    const animation = previous[index].animation;
    const [text, length] = native.input(String(animation._timelineValue()));
    const view = new DataView(native.refreshBytes().buffer);
    const row = previousTimelines + index * CSS_PREVIOUS_TIMELINE_SIZE;
    view.setBigUint64(row + CSS_PREVIOUS_TIMELINE_HANDLE, BigInt.asUintN(64, BigInt(animation._animationId)), true);
    view.setUint32(row + CSS_PREVIOUS_TIMELINE_TEXT, text, true);
    view.setUint32(row + CSS_PREVIOUS_TIMELINE_TEXT_LENGTH, length, true);
  }
  const desiredTimelines = native.exports.abi_allocate(Math.max(1, desired.length) * CSS_DESIRED_TIMELINE_SIZE);
  for (let index = 0; index < desired.length; index++) {
    const [text, length] = native.input(String(desired[index].definition.timing.timeline));
    const view = new DataView(native.refreshBytes().buffer);
    const row = desiredTimelines + index * CSS_DESIRED_TIMELINE_SIZE;
    view.setUint32(row + CSS_DESIRED_TIMELINE_TEXT, text, true);
    view.setUint32(row + CSS_DESIRED_TIMELINE_TEXT_LENGTH, length, true);
  }
  native.status("animation_css_plan", definitionRows, previous.length,
    definitionRows + previous.length * CSS_DEFINITION_SIZE, desired.length, previousTimelines, desiredTimelines);
  const view = native.output("animation_css_plan");
  for (let index = 0; index < desired.length; index++) {
    const row = index * CSS_PLAN_SIZE;
    desired[index].retained = view.getInt32(row + CSS_PLAN_RETAINED, true);
    desired[index].kind = view.getInt32(row + CSS_PLAN_KIND, true);
    desired[index].occurrence = view.getUint32(row + CSS_PLAN_OCCURRENCE, true);
    desired[index].match = view.getInt32(row + CSS_PLAN_MATCH, true);
  }
  const cancelFlags = desired.length * CSS_PLAN_SIZE;
  const cancelled = previous.filter((_, index) => view.getInt32(cancelFlags + index * U32, true) !== 0);
  return { desired, cancelled };
}
// The list position of the animation that definition `index` of a plan
// creates and the indices of the definitions it is declared before
// (animation_css_place). `positions` holds the current list position of
// each definition's record animation (-1 none), `previousPositions` the
// positions of the previous animations before the plan's cancellations.
export function placeCSSAnimation(index, desired, positions, previousPositions, count) {
  const rows = core.exports.abi_allocate(Math.max(1, desired.length) * CSS_PLACE_SIZE);
  const previousRows = core.exports.abi_allocate(Math.max(1, previousPositions.length) * U32);
  const view = new DataView(core.refreshBytes().buffer);
  desired.forEach((record, row) => {
    const at = rows + row * CSS_PLACE_SIZE;
    view.setInt32(at + CSS_PLACE_POSITION, positions[row], true);
    view.setInt32(at + CSS_PLACE_RETAINED, record.retained, true);
    view.setInt32(at + CSS_PLACE_MATCH, record.match, true);
  });
  previousPositions.forEach((position, row) => view.setInt32(previousRows + row * U32, position, true));
  const insertionIndex = core.status("animation_css_place", index, rows, desired.length,
    previousRows, previousPositions.length, count);
  const result = core.output("animation_css_place");
  const before = Array.from({ length: result.byteLength / U32 }, (_, row) => result.getUint32(row * U32, true));
  return { insertionIndex, before };
}
// The list places of an element's CSS animations at `positions`, -1 for one
// not in the list (animation_css_slots).
export function cssAnimationSlots(positions) {
  const input = core.exports.abi_allocate(Math.max(1, positions.length) * U32);
  const view = new DataView(core.refreshBytes().buffer);
  positions.forEach((position, row) => view.setInt32(input + row * U32, position, true));
  const count = core.status("animation_css_slots", input, positions.length);
  const result = count === 0 ? null : core.output("animation_css_slots");
  return Array.from({ length: count }, (_, row) => result.getInt32(row * U32, true));
}

// The transition lists of an element, or with `pseudo` 1 or 2 of its
// ::before or ::after (animation_transition_definitions).
export function animationTransitionDefinitions(element, pseudo = 0) {
  const native = element._domCore;
  const count = native.status("animation_transition_definitions", element._coreHandle, pseudo);
  const view = count === 0 ? null : native.output("animation_transition_definitions");
  const result = new Array(count);
  for (let index = 0; index < count; index++) {
    const row = index * TRANSITION_DEFINITION_SIZE;
    result[index] = {
      propertyName: view.memoryText(native.decoder, view.getUint32(row + TRANSITION_DEFINITION_NAME, true),
        view.getUint32(row + TRANSITION_DEFINITION_NAME_LENGTH, true)),
      duration: view.getFloat64(row + TRANSITION_DEFINITION_DURATION, true),
      delay: view.getFloat64(row + TRANSITION_DEFINITION_DELAY, true),
      easing: view.memoryText(native.decoder, view.getUint32(row + TRANSITION_DEFINITION_EASING, true),
        view.getUint32(row + TRANSITION_DEFINITION_EASING_LENGTH, true)),
    };
  }
  for (const definition of result) {
    definition.easing = parseCSSEasing(definition.easing);
    // A logical longhand transitions the physical longhand of the
    // element's writing mode and direction (animation_property_for).
    if (animationProperty(definition.propertyName) === null) {
      definition.propertyName = animationPropertyFor(definition.propertyName, element)?.name ?? definition.propertyName;
    }
  }
  return result;
}

// The animation lists of an element (animation_definitions), one row for
// each animation-name item, the shorter lists repeated: `current` reads the
// record the cascade resolved last (a pseudo-element).
const ANIMATION_DEFINITION = Object.freeze(Object.fromEntries([
  "SIZE", "NAME", "COMPOSITION", "EASING", "DIRECTION", "FILL", "PLAY_STATE", "TIMELINE", "RANGE_START", "RANGE_END",
  "TEXT_LENGTH", "DURATION", "DELAY", "ITERATIONS",
].map((name) => [name, layoutConstant(`ANIMATION_DEFINITION_${name}`)])));
export function animationListDefinitions(element, current = false) {
  const native = element._domCore;
  const count = native.status("animation_definitions", element._coreHandle, current ? 1 : 0);
  const view = count === 0 ? null : native.output("animation_definitions");
  const rows = new Array(count);
  for (let index = 0; index < count; index++) {
    const row = index * ANIMATION_DEFINITION.SIZE;
    const text = (field) =>
      view.memoryText(native.decoder, view.getUint32(row + field, true), view.getUint32(row + field + ANIMATION_DEFINITION.TEXT_LENGTH, true));
    rows[index] = {
      name: text(ANIMATION_DEFINITION.NAME),
      composition: text(ANIMATION_DEFINITION.COMPOSITION),
      easing: text(ANIMATION_DEFINITION.EASING),
      direction: text(ANIMATION_DEFINITION.DIRECTION),
      fill: text(ANIMATION_DEFINITION.FILL),
      playState: text(ANIMATION_DEFINITION.PLAY_STATE),
      timeline: text(ANIMATION_DEFINITION.TIMELINE),
      rangeStart: text(ANIMATION_DEFINITION.RANGE_START),
      rangeEnd: text(ANIMATION_DEFINITION.RANGE_END),
      duration: view.getFloat64(row + ANIMATION_DEFINITION.DURATION, true),
      delay: view.getFloat64(row + ANIMATION_DEFINITION.DELAY, true),
      iterations: view.getFloat64(row + ANIMATION_DEFINITION.ITERATIONS, true),
    };
  }
  for (const row of rows) row.easing = parseCSSEasing(row.easing);
  return rows;
}

export function animationProperty(name) {
  const id = core.status("animation_property", ...core.input(name));
  return id ? { id, name: core.outputString("animation_property") } : null;
}
// The animation property of keyframe property `name` of `element`: a
// logical longhand animates the physical longhand of the element's
// computed writing mode and direction (animation_property_for), which the
// element's own core holds.
export function animationPropertyFor(name, element) {
  const native = element?._domCore ?? core;
  const id = native.status("animation_property_for", element?._coreHandle ?? 0n, ...native.input(name));
  return id ? { id, name: native.outputString("animation_property_for") } : null;
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
// The easing in the animation_easing_normalize input language, as the
// kind and either the keyword text or the numbers. It calls the core, so
// it runs before the inputs of a call are allocated.
function animationEasingValues(easing) {
  if (typeof easing === "string") return { kind: EASING_KIND_KEYWORD, text: easing };
  let kind, values;
  if (easing.kind === "cubicBezier") {
    kind = EASING_KIND_CUBIC;
    values = [easing.x1, easing.y1, easing.x2, easing.y2].map((value) => animationNumber(value, "The cubic-bezier() number"));
  } else if (easing.kind === "steps") {
    kind = EASING_KIND_STEPS;
    const steps = animationNumber(easing.count, "The steps() count", 1);
    values = [steps, core.exports.animation_step_position_index(...core.input(String(easing.position)))];
  } else if (easing.kind === "linear") {
    kind = EASING_KIND_LINEAR;
    if (!Array.isArray(easing.points)) throw new TypeError("linear() needs at least one point");
    values = easing.points.flatMap((point) => [
      animationNumber(point.input, "The linear() input"), animationNumber(point.output, "The linear() output"),
    ]);
  } else { kind = EASING_KIND_UNSUPPORTED; values = []; }
  return { kind, values };
}
// The animation_easing_normalize input of animationEasingValues: [kind,
// pointer, count].
function animationEasingAllocation({ kind, text, values }) {
  if (text !== undefined) return [kind, ...core.input(text)];
  const pointer = core.exports.abi_allocate(values.length * F64);
  const view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < values.length; index++) view.setFloat64(pointer + index * F64, values[index], true);
  return [kind, pointer, kind === EASING_KIND_LINEAR ? values.length / 2 : values.length];
}
function animationEasingInput(easing) {
  return animationEasingAllocation(animationEasingValues(easing));
}
export function normalizeAnimationEasing(easing = "linear") {
  animationStatus(() => `The easing ${observedText(easing)}`,
    "animation_easing_normalize", ...animationEasingInput(easing));
  const view = core.output("animation_easing_normalize");
  const result = { kind: view.getUint32(EASING_RECORD_KIND, true) };
  if (result.kind === EASING_KIND_LINEAR) {
    const points = EASING_RECORD_HEADER_SIZE;
    result.points = Array.from({ length: view.getUint32(EASING_RECORD_POINT_COUNT, true) }, (_, index) => ({
      input: view.getFloat64(points + index * EASING_POINT_SIZE + EASING_POINT_INPUT, true),
      output: view.getFloat64(points + index * EASING_POINT_SIZE + EASING_POINT_OUTPUT, true),
    }));
  } else {
    result.payload = Array.from({ length: result.kind === EASING_KIND_CUBIC ? 4 : result.kind === EASING_KIND_STEPS ? 2 : 0 },
      (_, index) => view.getFloat64(EASING_RECORD_PAYLOAD + index * F64, true));
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
  core.status("animation_computed_timing", handle, now, endDelay, iterationStart,
    ...core.input(String(direction)), ...core.input(String(fill)), ...easingInput);
  const view = core.output("animation_computed_timing");
  const read = (offset) => {
    const value = view.getFloat64(offset, true);
    return Number.isNaN(value) ? null : value;
  };
  return {
    activeDuration: read(COMPUTED_TIMING_ACTIVE), currentIteration: read(COMPUTED_TIMING_ITERATION),
    endTime: read(COMPUTED_TIMING_END), localTime: read(COMPUTED_TIMING_LOCAL), progress: read(COMPUTED_TIMING_PROGRESS),
  };
}

// The keyframes of $propertyName among $keyframes, whose offsets are
// computed (normalizeAnimationOffsets): each keyframe that holds a value
// of the property, as { offset, easing, composite, value }. The core
// selects them and requires values at offsets 0 and 1.
export function animationPropertyFrames(keyframes, propertyName) {
  const pointer = framePresenceRows(keyframes, (keyframe) => keyframe.offset,
    (keyframe) => keyframe[propertyName] !== undefined);
  const count = core.exports.animation_property_frames(pointer, keyframes.length);
  try {
    core.throwIfError(true);
  } catch (error) {
    throw new TypeError(`The ${propertyName} keyframes are incomplete: ${error.message}`, { cause: error });
  }
  const view = count === 0 ? null : core.output("animation_property_frames");
  return Array.from({ length: count }, (_, index) => {
    const frame = keyframes[view.getUint32(index * U32, true)];
    return { offset: frame.offset, easing: frame.easing, composite: frame.composite, value: frame[propertyName] };
  });
}
// The start time and held time of a ::before or ::after content animation
// record after a style change (animation_content_times): `previous` is the
// record of the same name and occurrence that continues, or undefined;
// `timeMilliseconds` is null for a read between frames, whose time is
// `currentTimeMilliseconds`. A time without a value is null.
export function contentAnimationTimes(previous, paused, timeMilliseconds, currentTimeMilliseconds) {
  core.status("animation_content_times", previous ? 1 : 0, previous?.startTimeMilliseconds ?? NaN,
    previous?.holdTimeMilliseconds ?? NaN, previous?.definition.paused ? 1 : 0, paused ? 1 : 0,
    timeMilliseconds ?? NaN, currentTimeMilliseconds);
  return contentAnimationTimesOutput("animation_content_times");
}
// The times of ::before or ::after content animation `record` at frame
// time `timeMilliseconds` (animation_content_frame_start).
export function contentAnimationFrameStart(record, timeMilliseconds) {
  core.status("animation_content_frame_start", record.startTimeMilliseconds ?? NaN,
    record.holdTimeMilliseconds ?? NaN, record.definition.paused ? 1 : 0, timeMilliseconds);
  return contentAnimationTimesOutput("animation_content_frame_start");
}
// The start time and held time that $operation (animation_content_times or
// animation_content_frame_start) wrote; null for none.
function contentAnimationTimesOutput(operation) {
  const view = core.output(operation);
  const time = (offset) => {
    const value = view.getFloat64(offset, true);
    return Number.isNaN(value) ? null : value;
  };
  return { startTimeMilliseconds: time(CONTENT_TIMES_START), holdTimeMilliseconds: time(CONTENT_TIMES_HOLD) };
}
// The content that the ::before or ::after content animation `records`
// show at `timeMilliseconds`, in animation-name order
// (animation_content_sample, animation_content_stack); undefined when none
// has an effect.
export function stackedAnimationContent(records, timeMilliseconds) {
  const samples = records.map((record) => sampleAnimationContent(record, timeMilliseconds));
  const input = core.exports.abi_allocate(Math.max(1, samples.length) * U32);
  const view = new DataView(core.refreshBytes().buffer);
  samples.forEach((sample, index) => view.setInt32(input + index * U32, sample, true));
  const shown = core.status("animation_content_stack", input, samples.length);
  return shown < 0 ? undefined : records[shown].definition.keyframes[samples[shown]].content;
}
// The keyframe index that a ::before or ::after content animation record
// shows at `timeMilliseconds` (animation_content_sample); -1 where the
// animation has no effect or shows the underlying content.
function sampleAnimationContent(record, timeMilliseconds) {
  const { timing, keyframes, implicitKeyframe } = record.definition;
  // The easings call the core; the rows below are allocated after them,
  // with no core call until animation_content_sample reads them.
  const easingValues = (easing) =>
    animationEasingValues(typeof easing === "string" ? parseCSSEasing(easing) : easing ?? "linear");
  const frameEasings = keyframes.map((keyframe) => easingValues(keyframe.easing));
  const implicitEasing = easingValues(implicitKeyframe?.easing);
  const rows = core.exports.abi_allocate(keyframes.length * CONTENT_FRAME.SIZE);
  keyframes.forEach((keyframe, index) => {
    const row = rows + index * CONTENT_FRAME.SIZE;
    const easing = animationEasingAllocation(frameEasings[index]);
    const view = new DataView(core.refreshBytes().buffer);
    view.setFloat64(row + CONTENT_FRAME.OFFSET, keyframe.offset ?? NaN, true);
    view.setUint32(row + CONTENT_FRAME.PRESENT, keyframe.content !== undefined ? 1 : 0, true);
    view.setUint32(row + CONTENT_FRAME.EASING_KIND, easing[0], true);
    view.setUint32(row + CONTENT_FRAME.EASING_POINTER, easing[1], true);
    view.setUint32(row + CONTENT_FRAME.EASING_COUNT, easing[2], true);
  });
  return animationStatus(() => `Animation ${JSON.stringify(record.definition.name)}`,
    "animation_content_sample", rows, keyframes.length,
    Number(timing.duration), Number(timing.iterations), record.startTimeMilliseconds ?? NaN,
    record.holdTimeMilliseconds ?? NaN, timeMilliseconds,
    Number(timing.delay ?? 0), ...core.input(String(timing.direction)), ...core.input(String(timing.fill)),
    ...animationEasingAllocation(implicitEasing));
}

// The rows of animation_dependency_set (animation-dependencies.watpart).
const DEPENDENCY_FRAME = Object.freeze(Object.fromEntries([
  "SIZE", "OFFSET", "VALUE", "TEXT_POINTER", "TEXT_LENGTH", "EASING_KIND", "EASING_POINTER", "EASING_COUNT",
  "COMPOSITE_POINTER", "COMPOSITE_LENGTH",
].map((name) => [name, layoutConstant(`ANIMATION_DEPENDENCY_FRAME_${name}`)])));
// The property of a custom property effect of animation_dependency_set.
export const ANIMATION_DEPENDENCY_CUSTOM = layoutConstant("ANIMATION_DEPENDENCY_CUSTOM");

// Whether the effects on animation property `propertyId` apply in the
// core's computed resolution instead of an engine track: values of the
// element depend on them (font-size).
export function isAnimationDependency(propertyId) {
  return core.exports.animation_dependency_property(propertyId) === 1;
}
// Whether a transition of the transition-property name covers a property
// whose animated value computed resolution owns
// (animation_transition_dependency).
export function transitionCoversAnimationDependency(name) {
  return core.exports.animation_transition_dependency(...core.input(String(name))) === 1;
}

// Registers the effect of animation `animationId` on dependency property
// `property` ({ id, name }; id ANIMATION_DEPENDENCY_CUSTOM for a custom
// property) of `element` at the animation time `now` of its document,
// with the effect's timing members; `transition` marks a CSS transition's
// effect. Each frame is { offset, easing, composite, value }: the value a
// number in the property's canonical unit, a custom property's text, or
// null for the underlying value of an implicit keyframe.
export function setAnimationDependency({ animationId, element, property, order, now, timing, frames, transition = false }) {
  // The easings call the core; the inputs below are allocated after them,
  // with no core call until animation_dependency_set reads them.
  const parsedEasing = typeof timing.easing === "string" ? parseCSSEasing(timing.easing) : timing.easing;
  const effectEasing = animationEasingValues(parsedEasing ?? "linear");
  const frameEasings = frames.map((frame) =>
    animationEasingValues(typeof frame.easing === "string" && frame.easing !== "linear" ? parseCSSEasing(frame.easing) : frame.easing ?? "linear"));
  const rows = core.exports.abi_allocate(frames.length * DEPENDENCY_FRAME.SIZE);
  frames.forEach((frame, index) => {
    const row = rows + index * DEPENDENCY_FRAME.SIZE;
    const easing = animationEasingAllocation(frameEasings[index]);
    const [compositePointer, compositeLength] = core.input(String(frame.composite ?? "auto"));
    const [textPointer, textLength] = typeof frame.value === "string" ? core.input(frame.value) : [0, -1];
    const view = new DataView(core.refreshBytes().buffer);
    view.setFloat64(row + DEPENDENCY_FRAME.OFFSET, frame.offset, true);
    if (property.id === ANIMATION_DEPENDENCY_CUSTOM) {
      view.setUint32(row + DEPENDENCY_FRAME.TEXT_POINTER, textPointer, true);
      view.setInt32(row + DEPENDENCY_FRAME.TEXT_LENGTH, textLength, true);
    } else {
      view.setFloat64(row + DEPENDENCY_FRAME.VALUE, frame.value, true);
    }
    view.setUint32(row + DEPENDENCY_FRAME.EASING_KIND, easing[0], true);
    view.setUint32(row + DEPENDENCY_FRAME.EASING_POINTER, easing[1], true);
    view.setUint32(row + DEPENDENCY_FRAME.EASING_COUNT, easing[2], true);
    view.setUint32(row + DEPENDENCY_FRAME.COMPOSITE_POINTER, compositePointer, true);
    view.setUint32(row + DEPENDENCY_FRAME.COMPOSITE_LENGTH, compositeLength, true);
  });
  animationStatus(() => `The ${property.name} effect of the animation`, "animation_dependency_set",
    animationId, element._coreHandle, property.id, ...core.input(property.name), transition ? 1 : 0, order,
    Number(timing.iterationStart ?? 0), now,
    ...core.input(String(timing.direction ?? "normal")), ...core.input(String(timing.fill ?? "none")),
    ...animationEasingAllocation(effectEasing), ...core.input(String(timing.composite ?? "replace")),
    rows, frames.length);
}

// Sets the animation time of the dependency effects of `document`: an
// element whose effect progress changed resolves again.
export function setAnimationDependencyTime(document, now) {
  document._domCore.status("animation_dependency_time", document._coreHandle, now);
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
    pause(time) { if (engineHandle) engineHandle.pause(time); else command(BINDING_COMMAND_PAUSE, time); },
    resume(time) { if (engineHandle) engineHandle.resume(time); else command(BINDING_COMMAND_RESUME, time); },
    seek(local, sample) { if (engineHandle) engineHandle.seek(local, sample); else command(BINDING_COMMAND_SEEK, local, sample); },
    cancelSilently() { if (engineHandle) engineHandle.cancelSilently(); else command(BINDING_COMMAND_CANCEL); },
    cancel() { if (engineHandle) engineHandle.cancel(); else command(BINDING_COMMAND_CANCEL); },
    // An undeclared track has no row and no sample to capture.
    captureSamples(time) { if (engineHandle) engineHandle.captureSamples(time); },
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
      const view = count === 0 ? null : core.output("animation_binding_export");
      const commands = Array.from({ length: count }, (_, index) => {
        const row = index * BINDING_COMMAND_SIZE;
        return [view.getUint32(row + BINDING_COMMAND_KIND, true), view.getFloat64(row + BINDING_COMMAND_LOCAL, true),
          view.getFloat64(row + BINDING_COMMAND_SAMPLE, true)];
      });
      for (const [kind, value, sample] of commands) {
        if (kind === BINDING_COMMAND_SEEK) engineHandle.seek(value, sample);
        else engineHandle[kind === BINDING_COMMAND_PAUSE ? "pause" : "resume"](value);
      }
      release();
    },
  };
}
