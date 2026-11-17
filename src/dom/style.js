// The `style` proxy accepts CSS-shaped property writes into the core's
// declaration block. As in CSSOM, a value that does not parse leaves the
// declaration block unchanged and throws nothing; unknown named-property
// assignments are no-ops. Rejected setter values and the unsupported
// declarations of a parsed list are exposed through `style.diagnostics`.

import { parseCSSEasing } from "../dom-wasm/easing.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import {
  animationProperty,
  animationPropertyFor,
  animationValueFromText,
  keyframeMember,
  KEYFRAME_MEMBER,
  keyframePropertyNames,
  normalizeAnimationOffsets,
} from "../dom-wasm/animation.js";
import { createInlineStyleClass } from "./dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { withCustomElementReactions } from "./custom-elements.js";

const CALLBACK_RECORD_ATTRIBUTES = layoutConstant("CALLBACK_RECORD_ATTRIBUTES");
const STYLE_SET_PROPERTY = layoutConstant("STYLE_SET_PROPERTY");
const STYLE_RESULT_NOTHING_REMOVED = layoutConstant("STYLE_RESULT_NOTHING_REMOVED");

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
export function cssPropertyToIDLName(name) {
  return sharedDomCore.styleIDLName(String(name));
}

export function idlPropertyToCSSName(name) {
  return sharedDomCore.styleCSSName(String(name));
}

// ---- CSSStyleDeclaration parity ----
//
// The real pod cap's bindStyleHandle (swarm.js) assumes
// getStyle(node) returns something that behaves like a real
// CSSStyleDeclaration — in particular, plain property/bracket assignment
// is a silent no-op for CSS custom properties (`--foo`); only
// setProperty/getPropertyValue/removeProperty actually work for those.
// The proxy preserves this JavaScript property-assignment distinction; the
// explicit methods use the core's custom declaration storage.

const IMPLICIT = Object.freeze(Object.fromEntries([
  "KEYFRAME_SIZE", "KEYFRAME_OFFSET", "KEYFRAME_PROPERTIES", "PLACEMENT_SIZE", "PLACEMENT_INDEX", "PLACEMENT_PROPERTIES",
].map((name) => [name, layoutConstant(`IMPLICIT_${name}`)])));
// The context of the keyframe values of an element's animation. A keyframe
// value is a computed value of its target element (css-animations-1
// section 3, web-animations-1 section 5.3.4): lengths compute against the
// element's font sizes and the viewport, and currentcolor is the element's
// color (its parent's for the color property itself). The underlying value
// of a property is the element's computed value without animation effects;
// a CSS-wide keyword computes as the element's own declaration of it
// would (keywordComputedValue). `release()` gives back the computed views
// that the context read.
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
      return baseValue(element, name);
    },
    keywordValue(name, keyword) {
      return element.ownerDocument._styleSystem.keywordComputedValue(element, name, keyword);
    },
    // The color that currentcolor stands for: the element's, or its
    // parent's for a keyframe of the color property ($parent).
    currentColor(parent) {
      return parseColor(baseValue(parent ? element.parentElement : element, "color"));
    },
    release() {
      for (const view of views.values()) view.release();
      views.clear();
    },
  };
}

// One keyframe value of the animation property $property as a canonical
// value (animation_value_from_text), computed in $context
// (animationKeyframeContext) or, without one, from the value alone.
function canonicalAnimationValue(property, value, context) {
  return animationValueFromText(property, String(value), context?.element ?? null, context);
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
      const member = keyframeMember(name);
      if (member === KEYFRAME_MEMBER.OFFSET || member === KEYFRAME_MEMBER.COMPOSITE) {
        canonical[name] = value;
        continue;
      }
      if (member === KEYFRAME_MEMBER.EASING) {
        canonical.easing = typeof value === "string"
          ? parseCSSEasing(value)
          : structuredClone(value);
        continue;
      }
      const property = animationPropertyFor(name, context?.element);
      if (!property) {
        onUnanimated(name);
        continue;
      }
      canonical[property.name] = canonicalAnimationValue(property, value, context);
    }
    return canonical;
  });
}

// Adds the implicit keyframes of canonical $keyframes
// (animation_implicit_keyframes): each property takes its underlying value
// in the context where the core places it, a new keyframe having the
// easing and composite of $implicit. Returns the keyframes with their
// computed offsets.
export function addImplicitKeyframes(keyframes, context, implicit) {
  const frames = normalizeAnimationOffsets(keyframes);
  if (frames.length === 0) return frames;
  const properties = new Map();
  const core = sharedDomCore;
  const pointer = core.exports.abi_allocate(frames.length * IMPLICIT.KEYFRAME_SIZE);
  let view = new DataView(core.refreshBytes().buffer);
  frames.forEach((frame, index) => {
    let bits = 0n;
    for (const name of keyframePropertyNames(frame)) {
      if (!properties.has(name)) properties.set(name, animationProperty(name));
      bits |= 1n << BigInt(properties.get(name).id);
    }
    view = new DataView(core.refreshBytes().buffer);
    view.setFloat64(pointer + index * IMPLICIT.KEYFRAME_SIZE + IMPLICIT.KEYFRAME_OFFSET, frame.offset, true);
    view.setBigUint64(pointer + index * IMPLICIT.KEYFRAME_SIZE + IMPLICIT.KEYFRAME_PROPERTIES, bits, true);
  });
  core.status("animation_implicit_keyframes", pointer, frames.length);
  view = new DataView(core.refreshBytes().buffer);
  const output = core.exports.abi_output_pointer();
  // The placements at offset 0 and at offset 1: a keyframe index and the
  // properties that it takes.
  const placements = [0, 1].map((placement) => {
    const at = output + placement * IMPLICIT.PLACEMENT_SIZE;
    return [view.getInt32(at + IMPLICIT.PLACEMENT_INDEX, true), view.getBigUint64(at + IMPLICIT.PLACEMENT_PROPERTIES, true)];
  });
  const implicitFrame = (offset) => ({
    offset,
    ...(implicit.easing === undefined ? {} : {
      easing: typeof implicit.easing === "string" ? parseCSSEasing(implicit.easing) : implicit.easing,
    }),
    ...(implicit.composite === undefined ? {} : { composite: implicit.composite }),
  });
  const fill = (frame, bits) => {
    for (const [name, property] of properties) {
      if (bits & (1n << BigInt(property.id))) {
        frame[name] = canonicalAnimationValue(property, context.underlyingValue(name), context);
      }
    }
  };
  const [[first, startBits], [last, finishBits]] = placements;
  const start = startBits === 0n ? null : first >= 0 ? frames[first] : implicitFrame(0);
  const finish = finishBits === 0n ? null : last >= 0 ? frames[last] : implicitFrame(1);
  if (start !== null) {
    if (first < 0) frames.unshift(start);
    fill(start, startBits);
  }
  if (finish !== null) {
    if (last < 0) frames.push(finish);
    fill(finish, finishBits);
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
  // cssText, setProperty(), removeProperty() and the named properties are
  // [CEReactions]: the style attribute change enqueues attributeChanged.
  _replaceText(source) {
    withCustomElementReactions(() => {
      this._element._domCore.styleReplace(
        this._element._coreHandle,
        source,
        false,
        this._element.ownerDocument?._sandomFontRegistry ?? undefined,
        this._element.ownerDocument ?? null,
      );
      this._deliverMutation();
    }, this._element._domCore);
  }
  _parseAttribute(source) {
    this._element._domCore.styleReplace(
      this._element._coreHandle,
      source,
      true,
      this._element.ownerDocument?._sandomFontRegistry ?? undefined,
      this._element.ownerDocument ?? null,
    );
    this._element._domCore.callbackRecords();
    this._element._notifyMutation("style");
  }
  // A CSSOM change of the declarations: the core synced the style
  // attribute, and its record gives the attribute's old value.
  _deliverMutation(property) {
    const record = this._element._domCore.callbackRecords().find((entry) => entry.kind === CALLBACK_RECORD_ATTRIBUTES);
    this._element._notifyMutation("style", property, {
      type: "attributes",
      target: this._element,
      attributeName: "style",
      attributeNamespace: null,
      oldValue: record?.oldValue ?? null,
    });
  }
  _set(name, value, priority, mode) {
    withCustomElementReactions(() => this._setDeclaration(name, value, priority, mode), this._element._domCore);
  }
  _setDeclaration(name, value, priority, mode) {
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
    if (changed === STYLE_RESULT_NOTHING_REMOVED) {
      this._element._domCore.callbackRecords();
      return;
    }
    this._deliverMutation(name);
    const animatedProperty = changed === 1 && this._element._renderSurface
      ? animationProperty(name) : null;
    if (animatedProperty) {
      // The base beneath the element's effects is its computed value
      // without them: the new underlying value, computed for a renderer
      // whose effect stack takes it.
      const element = this._element;
      const base = () => {
        const context = animationKeyframeContext(element);
        try {
          return canonicalAnimationValue(animatedProperty, context.underlyingValue(animatedProperty.name), context);
        } finally {
          context.release();
        }
      };
      element._renderSurface._broadcastReplaceAnimationBase(element, animatedProperty.name, base);
    }
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
    this._set(property, value, priority, STYLE_SET_PROPERTY);
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
    return withCustomElementReactions(() => {
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
    }, this._element._domCore);
  }
}

const SDStyle = createInlineStyleClass({ Base: SDStyleRuntime });
// The indexed getter's @@iterator: %Array.prototype.values% (Web IDL).
Object.defineProperty(SDStyle.prototype, Symbol.iterator, {
  value: Array.prototype.values, writable: true, enumerable: false, configurable: true,
});
// An element's style attribute is a CSSStyleDeclaration (CSSOM §6.7).
Object.defineProperty(SDStyle.prototype, Symbol.toStringTag, { value: "CSSStyleDeclaration", configurable: true });

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
      // Custom-property parity (see class doc above): plain assignment on
      // a dash-prefixed name is a silent no-op, exactly like a real
      // CSSStyleDeclaration — only setProperty (above) actually sets one.
      if (prop.startsWith("--")) return true;
      const property = cssPropertyToIDLName(prop);
      if (target._unsupportedName(property)) return true;
      if (value === "") {
        target.removeProperty(idlPropertyToCSSName(prop));
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
