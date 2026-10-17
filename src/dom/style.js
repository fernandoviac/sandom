// The `style` proxy accepts CSS-shaped property writes and resolves them into
// the flat fields consumed by the scene writer. As in CSSOM, a value that
// does not parse leaves the declaration block unchanged and throws nothing;
// unknown named-property assignments are no-ops. Rejected setter values and
// the unsupported declarations of a parsed list are exposed through
// `style.diagnostics`.
//
// serialize.js reads an element's resolved fields via style._fields — a
// plain object shaped exactly like a test/fixtures/scenes.js node (minus
// `children`, which the tree walk supplies).

import { parseCSSEasing } from "../dom-wasm/easing.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import {
  animationLength as parseAnimationLength,
  animationLineHeight,
  animationProperty,
  animationPropertyValueKind,
  normalizeAnimationOffsets,
} from "../dom-wasm/animation.js";
import { createInlineStyleClass } from "./dom-bindings.generated.js";

// ---- value parsing ----

// The WebAssembly color kernel owns the color grammar and every numeric
// conversion step (docs/specifications/color-and-image-data.md). This module
// only routes strings to it.

// "#rrggbb" / functional CSS Color 4 forms / a named color -> {r,g,b,a} in
// extended sign-mirrored encoded sRGB - standard mode's working encoding
// (docs/specifications/color-and-image-data.md). The DOM core parses and
// converts through the shared color kernel; wide-gamut and high-dynamic-
// range input keeps components below zero and above one; no gamut map and
// no channel clamp run here. Native raster-plan preparation converts these
// values into linear Rec. 2020 for the high-dynamic-range render path. An
// invalid value throws.
export function parseColor(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (typeof raw === "object") return raw;
  const color = sharedDomCore.parseColor(raw);
  if (color === null) throw new Error(`CSS color "${raw}": invalid value`);
  return color;
}




export function repeatedListValue(values, index) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Cannot repeat an empty style list");
  }
  return values[sharedDomCore.status("animation_list_index", values.length, index)];
}


// The ONE way to read an element's style facts outside the style system:
// cascade-resolved fields (stylesheet rules plus inline style) when a
// style system exists, inline fields otherwise (detached trees, tests).
// Reading `element.style._fields` directly misses class-driven values -
// the interaction snapshot, scrollbars, anchoring, and snapping all
// consume this instead (presented-frame refactor, Slice 3).
export function resolvedElementFields(element) {
  if (element?.nodeType !== 1) return {};
  return element.ownerDocument?._styleSystem?.resolvedFields?.(element) ??
    element.style?._fields ?? {};
}

export function resolvedOverflowAxes(fields) {
  let x = fields.overflowX ?? fields.overflow ?? "visible";
  let y = fields.overflowY ?? fields.overflow ?? "visible";
  const originalX = x;
  const originalY = y;
  if (originalX === "visible" && !["visible", "clip"].includes(originalY)) {
    x = "auto";
  }
  if (originalY === "visible" && !["visible", "clip"].includes(originalX)) {
    y = "auto";
  }
  if (originalX === "clip" && !["visible", "clip"].includes(originalY)) {
    x = "hidden";
  }
  if (originalY === "clip" && !["visible", "clip"].includes(originalX)) {
    y = "hidden";
  }
  return { x, y };
}

export function cssPropertyToIDLName(name) {
  return sharedDomCore.styleIDLName(String(name));
}

export function idlPropertyToCSSName(name) {
  return sharedDomCore.styleCSSName(String(name));
}


// Cascade swallow policy (`BUG-document-parity-divergences` (resolved; see
// `activity/reports/REPORT-2026-10-14-document-parity-resolved-bug-records.md`),
// decided 2026-08-25): the ENGINE stays CSS-conformant — an unsupported or
// unparseable declaration is dropped from the cascade like a browser
// drops an unknown property — but every drop is RECORDED here so the
// parity gate can fail loudly on documents that silently lost styling.
// Four separate document divergences (flex, border sides, place-items,
// grid-row) each hid behind a silent drop before this registry existed.
// Consumers (the parity harness) read and clear between documents.
export const droppedDeclarations = new Set();


// ---- CSSStyleDeclaration parity ----
//
// The real pod cap's bindStyleHandle (swarm.js) assumes
// getStyle(node) returns something that behaves like a real
// CSSStyleDeclaration — in particular, plain property/bracket assignment
// is a silent no-op for CSS custom properties (`--foo`); only
// setProperty/getPropertyValue/removeProperty actually work for those.
// The proxy preserves this JavaScript property-assignment distinction; the
// explicit methods use the core's custom declaration storage.


// The individual transforms take `none`, the identity, as a keyword
// (css-transforms-2); normalizeAnimationValue gives it the identity values.
// With $element, lengths compute against the element.
function parseAnimationTranslate(value, element = null) {
  if (String(value).trim() === "none") return { kind: "keyword", keyword: "none" };
  const slots = (element?._domCore ?? sharedDomCore).declarationSlots("translate", String(value), element);
  if (!slots?.length || slots[0].kind === 1 || slots[0].value?.x === undefined) {
    throw new TypeError(`Invalid translate value: ${String(value).trim()}`);
  }
  return {
    kind: "translate",
    x: slots[0].value.x,
    y: slots[0].value.y,
  };
}
// A transform list; `none` is the empty list, which interpolates with any
// list as its identity functions (css-transforms-1 section 10).
function parseAnimationTransform(value, element = null) {
  if (String(value).trim() === "none") return { kind: "transform", components: [] };
  return { kind: "transform", components: (element?._domCore ?? sharedDomCore).transformComponents(value, element) };
}

// An individual scale (one or two numbers) and rotate (an angle, as
// radians), parsed by the core's transform grammar.
function parseAnimationScale(value) {
  const text = String(value).trim();
  if (text === "none") return { kind: "keyword", keyword: "none" };
  const [component] = sharedDomCore.transformComponents(`scale(${text.split(/\s+/).join(", ")})`) ?? [];
  if (component?.kind !== "scale") throw new TypeError(`Invalid scale value: ${text}`);
  return { kind: "scale", x: component.x, y: component.y };
}
function parseAnimationRotate(value) {
  const text = String(value).trim();
  if (text === "none") return { kind: "keyword", keyword: "none" };
  const [component] = sharedDomCore.transformComponents(`rotate(${text})`) ?? [];
  if (component?.kind !== "rotate") throw new TypeError(`Invalid rotate value: ${text}`);
  return { kind: "scalar", value: component.radians };
}

// The context of the keyframe values of an element's animation. A keyframe
// value is a computed value of its target element (css-animations-1
// section 3, web-animations-1 section 5.3.4): lengths compute against the
// element's font sizes and the viewport, and currentcolor is the element's
// color (its parent's for the color property itself). The underlying value
// of a property is the element's computed value without animation effects.
// `release()` gives back the computed views that the context read.
export function animationKeyframeContext(element) {
  const views = new Map();
  const baseValue = (target, name) => {
    let view = views.get(target);
    if (view === undefined) {
      view = target.ownerDocument._styleSystem.underlyingComputedValues(target);
      views.set(target, view);
    }
    return view.read(name);
  };
  return {
    element,
    underlyingValue(name) {
      return baseValue(element, cssPropertyToIDLName(name));
    },
    // The color that currentcolor stands for in a keyframe of $name.
    currentColor(name) {
      if (name !== "color") return parseColor(baseValue(element, "color"));
      const parent = element.parentElement;
      return parseColor(parent ? baseValue(parent, "color") : "canvastext");
    },
    release() {
      for (const view of views.values()) view.release();
      views.clear();
    },
  };
}

// A keyframe color. currentcolor, alone or inside a color function, takes
// the context's current color.
function parseAnimationColor(value, name, context) {
  const text = String(value);
  let color;
  if (/currentcolor/i.test(text)) {
    if (context === null) {
      throw new TypeError(`The ${name} keyframe value ${text.trim()} needs the color of its target element`);
    }
    const currentColor = context.currentColor(name);
    color = sharedDomCore.parseColor(text, currentColor);
    if (color === "currentColor") color = currentColor;
  } else {
    color = sharedDomCore.parseColor(text);
  }
  if (color === null || color === "currentColor") {
    throw new TypeError(`The ${name} keyframe value ${text.trim()} is not a color`);
  }
  return { kind: "color", value: [color.r, color.g, color.b, color.a] };
}

// One keyframe value of the animation property $property in the
// controller's value shape, computed in $context (animationKeyframeContext)
// or, without one, from the value alone.
function canonicalAnimationValue(property, value, context) {
  const element = context?.element ?? null;
  if (property.id === 12) return { kind: "scalar", value: Number(value) };
  if (property.id === 15) return parseAnimationTransform(value, element);
  if (animationPropertyValueKind(property.id) === 3) return parseAnimationColor(value, property.name, context);
  if (property.id === 14) return { kind: "keyword", keyword: String(value) };
  if (property.id === 25) return animationLineHeight(value, element);
  if (property.id === 26) return parseAnimationTranslate(value, element);
  if (property.id === 32) return parseAnimationScale(value);
  if (property.id === 33) return parseAnimationRotate(value);
  return parseAnimationLength(value, element);
}

// A property the core does not animate, named by a transition or an
// animation, keeps one recoverable diagnostic per element, property and
// source ("transition-property" or "keyframes") in its document. The
// element renders without that property's animation, as in a browser.
export function recordUnanimatedProperty(element, property, source) {
  const document = element.ownerDocument;
  const ownerElement = `${element.localName}${element.id ? `#${element.id}` : ""}`;
  const owners = document._unanimatedPropertyDiagnostics;
  let properties = owners.get(element);
  if (!properties) {
    properties = new Map();
    owners.set(element, properties);
  }
  const key = `${source}\n${property}`;
  if (properties.has(key)) return;
  properties.set(key, Object.freeze({
    code: "animation-property-unsupported",
    severity: "warning",
    recoverable: true,
    message: `${property} of ${ownerElement}, named by ${source}, does not animate: Sandom does not animate this property`,
    owner: Object.freeze({ element: ownerElement, property }),
    source,
  }));
}

// Keyframes in the controller's value shapes, computed in $context
// (animationKeyframeContext). A property the core does not animate is left
// out, as a browser leaves it out, and reported to $onUnanimated with its
// name.
export function canonicalizeAnimationKeyframes(keyframes, onUnanimated, context) {
  if (!Array.isArray(keyframes)) {
    throw new TypeError("keyframes must be an array");
  }
  return keyframes.map((frame) => {
    const canonical = {};
    for (const [name, value] of Object.entries(frame)) {
      if (name === "offset" || name === "composite") {
        canonical[name] = value;
        continue;
      }
      if (name === "easing") {
        canonical.easing = typeof value === "string"
          ? parseCSSEasing(value)
          : structuredClone(value);
        continue;
      }
      const property = animationProperty(name);
      if (!property) {
        onUnanimated(name);
        continue;
      }
      canonical[property.name] = canonicalAnimationValue(property, value, context);
    }
    return canonical;
  });
}

// Adds the implicit keyframes of canonical $keyframes (web-animations-1
// section 5.3.4, css-animations-1 section 3): a property without a value at
// offset 0 takes the underlying value of the context's element there, and
// so does a property without a value at offset 1. The value joins the first
// keyframe at offset 0 (the last at offset 1), or a new keyframe with the
// easing and composite of $implicit. Returns the keyframes with their
// computed offsets.
export function addImplicitKeyframes(keyframes, context, implicit) {
  const frames = normalizeAnimationOffsets(keyframes);
  const properties = new Set(frames.flatMap((frame) =>
    Object.keys(frame).filter((name) => name !== "offset" && name !== "easing" && name !== "composite")
  ));
  const implicitFrame = (offset) => ({
    offset,
    ...(implicit.easing === undefined ? {} : {
      easing: typeof implicit.easing === "string" ? parseCSSEasing(implicit.easing) : implicit.easing,
    }),
    ...(implicit.composite === undefined ? {} : { composite: implicit.composite }),
  });
  for (const offset of [0, 1]) {
    const missing = [...properties].filter((name) =>
      !frames.some((frame) => frame.offset === offset && frame[name] !== undefined)
    );
    if (missing.length === 0) continue;
    let frame = offset === 0
      ? frames.find((candidate) => candidate.offset === 0)
      : frames.findLast((candidate) => candidate.offset === 1);
    if (frame === undefined) {
      frame = implicitFrame(offset);
      if (offset === 0) frames.unshift(frame);
      else frames.push(frame);
    }
    for (const name of missing) {
      frame[name] = canonicalAnimationValue(animationProperty(name), context.underlyingValue(name), context);
    }
  }
  return frames;
}

export function supportsStyleProperty(name) {
  return sharedDomCore.styleSupports(cssPropertyToIDLName(name));
}

const styleInstances = new WeakSet();

export function isStyleDeclaration(value) {
  return styleInstances.has(value);
}

class SDStyleRuntime {
  constructor(element) {
    this._element = element;
    this._mutationOldValue = null;
  }

  _getDiagnostics() {
    return this._element._domCore.styleDiagnostics(this._element._coreHandle);
  }
  _getLength() {
    return this._element._domCore.styleCount(this._element._coreHandle);
  }
  _item(index) {
    return this._element._domCore.styleCSSNameAt(
      this._element._coreHandle,
      index,
    ) ?? "";
  }
  [Symbol.iterator]() {
    return Array.from({ length: this.length }, (_, index) => this.item(index))
      [Symbol.iterator]();
  }
  _getCSSText() {
    return this._element._domCore.styleText(this._element._coreHandle);
  }
  _replaceText(source) {
    this._element._domCore.styleReplace(
      this._element._coreHandle,
      source,
      false,
      this._element.ownerDocument?._sandomFontRegistry ?? undefined,
      this._element.ownerDocument ?? null,
    );
    this._deliverMutation();
  }
  _parseAttribute(source) {
    this._element._assertMutationAllowed();
    this._element._parsingStyleAttribute = true;
    try {
      this._element._domCore.styleReplace(
        this._element._coreHandle,
        source,
        true,
        this._element.ownerDocument?._sandomFontRegistry ?? undefined,
        this._element.ownerDocument ?? null,
      );
      this._element._domCore.callbackRecords();
      this._element._notifyMutation("style");
    } finally {
      this._element._parsingStyleAttribute = false;
    }
  }
  _deliverMutation(property) {
    const core = this._element._domCore;
    const hadAttribute = core.exports.style_mutation_had_attribute() !== 0;
    const record = core.callbackRecords().find((entry) => entry.kind === 2);
    this._mutationOldValue = hadAttribute ? record?.oldValue ?? "" : null;
    this._element._notifyMutation("style", property);
  }
  _set(name, value, priority, mode) {
    const changed = this._element._domCore.styleSet(
      this._element._coreHandle,
      name,
      value,
      priority,
      mode,
      this._element.ownerDocument?._sandomFontRegistry ?? undefined,
      this._element.ownerDocument ?? null,
    );
    if (!changed) return;
    if (changed === 3) {
      this._element._domCore.callbackRecords();
      return;
    }
    this._deliverMutation(name);
    const animatedProperty = changed === 1 && this._element._renderSurface
      ? animationProperty(name) : null;
    if (animatedProperty) {
      // The base beneath the element's effects is its computed value
      // without them: the new underlying value.
      const context = animationKeyframeContext(this._element);
      let base;
      try {
        base = canonicalAnimationValue(animatedProperty, context.underlyingValue(animatedProperty.name), context);
      } finally {
        context.release();
      }
      this._element._renderSurface._broadcastReplaceAnimationBase(this._element, animatedProperty.name, base);
    }
  }
  _assertMutation() {
    this._element._assertMutationAllowed();
  }
  _invalidPriority(priority) {
    return !this._element._domCore.stylePriorityValid(priority);
  }
  _methodName(name) {
    return this._element._domCore.styleMethodName(name);
  }
  _unsupportedName(property) {
    return !this._element._domCore.styleSupports(property);
  }
  _setPropertyNormalized(property, value, priority) {
    this._set(property, value, priority, 1);
  }
  _getPropertyValue(property) {
    return this._element._domCore.styleRead(
      this._element._coreHandle,
      property,
    ) ?? "";
  }
  _getPropertyPriority(property) {
    return this._element._domCore.stylePriority(
      this._element._coreHandle,
      property,
    );
  }
  _removeProperty(property) {
    const previous = this._element._domCore.styleRemove(
      this._element._coreHandle,
      property,
    );
    if (previous !== "") this._deliverMutation(property);
    else {
      // The attribute operation still owns its record lifetime when removing
      // an absent/empty declaration does not notify style consumers.
      this._element._domCore.callbackRecords();
    }
    return previous;
  }
}

const SDStyle = createInlineStyleClass({ Base: SDStyleRuntime });
// The indexed getter's @@iterator: %Array.prototype.values% (Web IDL).
Object.defineProperty(SDStyle.prototype, Symbol.iterator, {
  value: Array.prototype.values, writable: true, enumerable: false, configurable: true,
});

export function createStyle(element) {
  const style = new SDStyle(element);
  const proxy = new Proxy(style, {
    get(target, prop) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) {
        const index = Number(prop);
        return index < target.length ? target.item(index) : undefined;
      }
      if (prop in target || typeof prop !== "string") return target[prop];
      if (!supportsStyleProperty(prop) || prop.startsWith("--")) {
        return undefined;
      }
      return target.getPropertyValue(idlPropertyToCSSName(prop));
    },
    set(target, prop, value) {
      if (typeof prop !== "string") return false;
      if (/^(0|[1-9]\d*)$/.test(prop)) return true;
      // Internal SDStyle state and real class members bypass CSS property
      // assignment. The proxy must not interpret them as authored properties.
      if (prop in target) {
        target[prop] = value;
        return true;
      }
      target._element._assertMutationAllowed();
      // Custom-property parity (see class doc above): plain assignment on
      // a dash-prefixed name is a silent no-op, exactly like a real
      // CSSStyleDeclaration — only setProperty (above) actually sets one.
      if (prop.startsWith("--")) return true;
      const property = cssPropertyToIDLName(prop);
      if (target._unsupportedName(property)) return true;
      if (value === "") {
        target.removeProperty(prop);
        return true;
      }
      // Keep the core's strict check for engine callers. Only the CSSOM named
      // property setter turns an unknown authored property into a no-op.
      target._element._domCore.styleCheckName(property);
      target._set(property, String(value), "", 0);
      return true;
    },
    has(target, prop) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) {
        return Number(prop) < target.length;
      }
      return prop in target;
    },
    ownKeys(target) {
      return [
        ...Array.from({ length: target.length }, (_, index) => String(index)),
        ...Reflect.ownKeys(target),
      ];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (
        typeof prop === "string" &&
        /^(0|[1-9]\d*)$/.test(prop) &&
        Number(prop) < target.length
      ) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: target.item(Number(prop)),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  styleInstances.add(proxy);
  return proxy;
}
