import { parseCSSEasing } from "../dom-wasm/easing.js";
import { createFontFaceSet } from "./font-face-set.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { createEvent, dispatchEvent } from "./events.js";
import {
  createCSSBindings, createCSSStyleSheetClass, installComputedStyleBindings,
  installCSSRuleBindings, installCSSStyleRuleBindings,
  installCSSConditionRuleBindings, installCSSContainerRuleBindings, installCSSMediaRuleBindings, installCSSSupportsRuleBindings,
  installCSSCounterStyleRuleBindings, installCSSFontFaceRuleBindings, installCSSFontFeatureValuesRuleBindings, installCSSKeyframeRuleBindings,
  installCSSKeyframesRuleBindings, installStyleDeclarationBindings, installRuleStyleDeclarationBindings,
} from "./dom-bindings.generated.js";
import {
  cssPropertyToIDLName,
  idlPropertyToCSSName,
  supportsStyleProperty,
} from "./style.js";
import {
  defaultFontRegistry,
  fontFaceStyleDescriptor,
  registerRuntimeFont,
  unregisterRuntimeFont,
} from "../font-registry.js";
import { decodeWebFont } from "../web-font.js";
import { animationListDefinitions } from "../dom-wasm/animation.js";
import { containingShadowRoot } from "./shadow.js";
import { withLiveGeometry } from "./live-geometry.js";
import { scheduleFocusFixup } from "./input-activation.js";
import { layoutConstant } from "../wasm/layout-table.js";

const COMPUTED_RESOLVE_PSEUDO = layoutConstant("COMPUTED_RESOLVE_PSEUDO");
const COMPUTED_RESOLVE_TRANSIENT = layoutConstant("COMPUTED_RESOLVE_TRANSIENT");
// The view key of keywordComputedValue's transient resolutions: no
// pseudo-element, whose keys start with "::", has it.
const KEYWORD_VIEW_KEY = "keyword-resolution";
const CSS_REFERENCE_URL = layoutConstant("CSS_REFERENCE_URL");
const LINK_SHEET_ACTION_ERROR = layoutConstant("LINK_SHEET_ACTION_ERROR");
const LINK_SHEET_ACTION_LOAD = layoutConstant("LINK_SHEET_ACTION_LOAD");
const LINK_SHEET_FAILED = layoutConstant("LINK_SHEET_FAILED");
const FONT_FACE_ACTION_NONE = layoutConstant("FONT_FACE_ACTION_NONE");
const FONT_FACE_ACTION_DECLARE = layoutConstant("FONT_FACE_ACTION_DECLARE");
const FONT_FACE_ACTION_RELEASE = layoutConstant("FONT_FACE_ACTION_RELEASE");
const FONT_FACE_UNLOADED = layoutConstant("FONT_FACE_UNLOADED");
const FONT_FACE_PENDING = layoutConstant("FONT_FACE_PENDING");
const FONT_FACE_LOADED = layoutConstant("FONT_FACE_LOADED");
const FONT_FACE_FAILED = layoutConstant("FONT_FACE_FAILED");
const STYLESHEET_ACCESS_RULES = layoutConstant("STYLESHEET_ACCESS_RULES");
const STYLESHEET_ACCESS_INSERT = layoutConstant("STYLESHEET_ACCESS_INSERT");
const STYLESHEET_ACCESS_DELETE = layoutConstant("STYLESHEET_ACCESS_DELETE");

function liveCollection(items, name) {
  return new Proxy(items, {
    get(target, property) {
      if (property === "item") return (index) => target[index] ?? null;
      if (property === Symbol.toStringTag) return name;
      return Reflect.get(target, property);
    },
  });
}

export function mediaMatches(text, environment) {
  return sharedDomCore.mediaMatches(text, environment);
}

export function supportsCondition(text) {
  return sharedDomCore.supportsCondition(text);
}

// CSS.supports: an undefined value takes the one-argument form, which
// also tries the text wrapped in parentheses (CSS Conditional 3 §8.1), so
// that "color: red" reads as a declaration. The class string of the CSS
// namespace object is its name (Web IDL §3.13.1).
export const CSS = Object.freeze(Object.defineProperty(createCSSBindings({
  supports: (propertyOrCondition, value) => {
    if (value !== undefined) return supportsCondition(`(${propertyOrCondition}: ${value})`);
    const text = String(propertyOrCondition);
    return supportsCondition(text) || supportsCondition(`(${text})`);
  },
  escape: (value) => sharedDomCore.string("css_escape", ...sharedDomCore.input(String(value))),
}), Symbol.toStringTag, { value: "CSS", configurable: true }));

// An @font-face font-weight or font-stretch descriptor
// (font_face_range_descriptor): "auto" (absent, auto or invalid), one
// value, or a range of two as [minimum, maximum].
function fontFaceRangeDescriptor(text, stretch) {
  const count = sharedDomCore.status("font_face_range_descriptor", ...sharedDomCore.input(String(text ?? "")), stretch ? 1 : 0);
  if (count === 0) return "auto";
  const values = new Float64Array(sharedDomCore.outputBytes("font_face_range_descriptor", 0, 16).buffer);
  return count === 1 ? values[0] : [values[0], values[1]];
}

export class SDStyleDeclaration {
  constructor(read, names, write = null, remove = null, priority = null) {
    this._read = read;
    this._names = names;
    this._write = write;
    this._remove = remove;
    this._priority = priority;
    return new Proxy(this, {
      get: (target, property, receiver) => {
        // The indexed getter (CSSOM: CSSStyleDeclaration's item() for an
        // index below length; undefined beyond it).
        const index = arrayIndex(property);
        if (index >= 0) return index < target.length ? target.item(index) : undefined;
        if (
          typeof property === "string" &&
          !Reflect.has(target, property) &&
          (property.startsWith("--") || supportsStyleProperty(property))
        ) {
          return target.getPropertyValue(idlPropertyToCSSName(property));
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        // No indexed setter: an index is read-only (Web IDL §3.9).
        if (arrayIndex(property) >= 0) return false;
        if (
          typeof property === "string" &&
          !Reflect.has(target, property) &&
          (property.startsWith("--") || supportsStyleProperty(property))
        ) {
          target.setProperty(idlPropertyToCSSName(property), value);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
      // Every supported property is an IDL attribute of the declaration in
      // its camel-case, webkit-cased and dashed forms (CSSOM, "The
      // CSSStyleDeclaration Interface"), so `in` finds it. A custom
      // property is not an attribute.
      has: (target, property) => {
        const index = arrayIndex(property);
        if (index >= 0) return index < target.length;
        return (typeof property === "string" && !property.startsWith("--") && supportsStyleProperty(property)) ||
          Reflect.has(target, property);
      },
      // The indices below length are own, enumerable, read-only data
      // properties (Web IDL §3.9, legacy platform objects).
      getOwnPropertyDescriptor: (target, property) => {
        const index = arrayIndex(property);
        if (index >= 0) {
          return index < target.length
            ? { value: target.item(index), writable: false, enumerable: true, configurable: true }
            : undefined;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys: (target) => [
        ...Array.from({ length: target.length }, (_, index) => String(index)),
        ...Reflect.ownKeys(target),
      ],
    });
  }
}
Object.defineProperty(SDStyleDeclaration.prototype, Symbol.toStringTag, { value: "CSSStyleDeclaration", configurable: true });

// A read-only declaration throws on a write (style_declaration_guard).
function requireStyleDeclarationWritable(flag) {
  return sharedDomCore.status("style_declaration_guard", flag ? 1 : 0);
}

// Every declaration is a computed or a rule declaration, each with its own
// cssText; the base getter has no declaration to read.
installStyleDeclarationBindings({
  readText() {
    throw new TypeError("Illegal invocation");
  },
  requireWritable: requireStyleDeclarationWritable,
}, SDStyleDeclaration.prototype);
// CSSStyleDeclaration has an indexed getter, so its @@iterator is
// %Array.prototype.values% (Web IDL).
Object.defineProperty(SDStyleDeclaration.prototype, Symbol.iterator, {
  value: Array.prototype.values, writable: true, enumerable: false, configurable: true,
});

function coreHandleCache(caches, core) {
  let cache = caches.get(core);
  if (!cache) caches.set(core, cache = new Map());
  return cache;
}

const computedViews = new WeakMap();
const computedViewFinalizer = new FinalizationRegistry(({ coreReference, handle }) => {
  const core = coreReference.deref();
  if (!core) return;
  const views = computedViews.get(core);
  if (!views?.get(handle)?.deref()) views?.delete(handle);
  core.status("computed_view_release", handle);
});

class ComputedStyleDeclaration extends SDStyleDeclaration {
  constructor(element, handle, refresh) {
    super(
      (name) => this._readNormalized(name),
      () => this._propertyNames(),
    );
    this._element = element;
    this._domCore = element._domCore;
    this._coreView = handle;
    this._refreshComputed = refresh;
  }
  // Chrome gives a computed declaration an empty cssText: it reads no
  // property, so it neither serializes values nor updates layout. Setting
  // it throws, as a write to any read-only declaration does.
  get cssText() {
    return "";
  }
  set cssText(value) {
    requireStyleDeclarationWritable(false);
  }
  _getLength() {
    this._refreshComputed();
    return this._domCore.status("computed_view_count", this._coreView);
  }
  _item(names, index) {
    return names[index] ?? "";
  }
  // item() takes a snapshot of the names before it converts its index
  // (dom-interfaces.json), so a loop over item() reads the names once per
  // call. The names change only with the document's styles: the snapshot
  // is kept while the style generation and the count stay.
  _propertyNames() {
    this._refreshComputed();
    const count = this._domCore.status("computed_view_count", this._coreView);
    const generation = this._element.ownerDocument?._styleSystem?.generation;
    const kept = this._namesSnapshot;
    if (kept !== undefined && kept.generation === generation && kept.names.length === count) return kept.names;
    const names = Object.freeze(Array.from({ length: count }, (_, index) =>
      this._domCore.string("computed_view_name", this._coreView, index)
    ));
    this._namesSnapshot = { generation, names };
    return names;
  }
  // The core reads the property name as getPropertyValue() does (CSSOM
  // §6.7.1): in ASCII lowercase, except a custom property name.
  _readNormalized(name) {
    this._refreshComputed();
    const core = this._domCore;
    // A read of a layout-dependent property updates layout in Chrome, so it
    // runs the focus check, also when the value needs no geometry.
    if (core.status("computed_value_updates_layout", this._coreView, ...core.input(name))) scheduleFocusFixup(this._element);
    if (core.status("computed_value_needs_geometry", this._coreView, ...core.input(name))) {
      return withLiveGeometry(this._element, undefined, ({ handle }) =>
        core.string("computed_value_text", this._coreView, ...core.input(name), handle));
    }
    return core.string("computed_value_text", this._coreView, ...core.input(name), 0n);
  }
}
installComputedStyleBindings({}, ComputedStyleDeclaration.prototype);

const rulesByHandle = new WeakMap();
const ruleFinalizer = new FinalizationRegistry(({ coreReference, handle, sheet }) => {
  const core = coreReference.deref();
  if (!core) return;
  const rules = rulesByHandle.get(core);
  if (!rules?.get(handle)?.deref()) rules?.delete(handle);
  const localRules = sheet?.deref()?._rulesByHandle;
  if (!localRules?.get(handle)?.deref()) localRules?.delete(handle);
  core.status("css_rule_release", handle);
});

class RuleStyleDeclaration extends SDStyleDeclaration {
  constructor(rule) {
    const handle = rule._coreRuleHandle;
    const core = rule._domCore;
    super(
      (name) =>
        core.string(
          "css_rule_get_property",
          handle,
          ...core.input(name),
          false,
        ),
      () => {
        const count = core.status("css_rule_style_count", handle);
        return Array.from(
          { length: count },
          (_, index) =>
            core.string("css_rule_style_name", handle, index),
        );
      },
      (name, value, priority) => {
        core.status(
          "css_rule_set_property",
          handle,
          ...core.input(name),
          ...core.input(value),
          ...core.input(priority),
        );
        rule._changed();
      },
      (name) => {
        const previous = core.string(
          "css_rule_remove_property",
          handle,
          ...core.input(name),
        );
        rule._changed();
        return previous;
      },
      (name) =>
        core.string(
          "css_rule_get_property",
          handle,
          ...core.input(name),
          true,
        ),
    );
    this._rule = rule;
    this._domCore = core;
  }
  _replaceDeclarationText(text) {
    this._domCore.status("css_rule_set_declaration_text", this._rule._coreRuleHandle, ...this._domCore.input(text));
    this._rule._changed();
  }
}

installRuleStyleDeclarationBindings({}, RuleStyleDeclaration.prototype);

export class CSSRule {

  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    this._sheet = sheet;
    this._domCore = core;
    this._coreRuleHandle = handle;
    core.status("css_rule_retain", handle);
    ruleFinalizer.register(this, {
      coreReference: new WeakRef(core),
      handle,
      sheet: sheet && new WeakRef(sheet),
    });
    const reference = new WeakRef(this);
    coreHandleCache(rulesByHandle, core).set(handle, reference);
    sheet?._rulesByHandle.set(handle, reference);
  }
  // CSSOM: setting CSSRule.cssText does nothing.
  _ignoreCssText() {}
  _bindingParentStyleSheet() {
    if (!this._domCore.status("css_rule_sheet", this._coreRuleHandle)) {
      this._sheet?._rulesByHandle.delete(this._coreRuleHandle);
      this._sheet = null;
    }
    return this._sheet;
  }
  _bindingParentRule() {
    const parent = this._domCore.status(
      "css_rule_parent",
      this._coreRuleHandle,
    );
    return parent ? ruleObject(this.parentStyleSheet, parent, this._domCore) : null;
  }
  _changed() {
    this.parentStyleSheet?._changed();
  }
}

// The child rules of a grouping rule as one CSSRuleList, which each read
// brings up to date: an insertRule or deleteRule, or a change that the
// sheet reparses, changes the list in place.
function childRules(rule) {
  const core = rule._domCore;
  const handle = rule._coreRuleHandle;
  rule._childRules ??= liveCollection([], "CSSRuleList");
  const count = core.status("css_rule_child_count", handle);
  rule._childRules.splice(0, rule._childRules.length, ...Array.from({ length: count }, (_, index) =>
    ruleObject(rule.parentStyleSheet, core.status("css_rule_child_at", handle, index), core)));
  return rule._childRules;
}

export class CSSGroupingRule extends CSSRule {
  get cssRules() {
    return childRules(this);
  }
  // CSSOM §6.4.3: insertRule(rule, optional unsigned long index = 0).
  insertRule(rule, index = 0) {
    const core = this._domCore;
    const position = core.status("css_rule_insert_rule", this._coreRuleHandle, ...core.input(String(rule)), Number(index) >>> 0);
    this._changed();
    return position;
  }
  deleteRule(index) {
    this._domCore.status("css_rule_delete_rule", this._coreRuleHandle, Number(index) >>> 0);
    this._changed();
  }
}

// A style rule groups its nested rules (CSS Nesting 1 §5.1).
export class CSSStyleRule extends CSSGroupingRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
  get selectorText() {
    return this._domCore.string("css_rule_prelude", this._coreRuleHandle) ?? "";
  }
  set selectorText(value) {
    const core = this._domCore;
    core.status("css_rule_set_selector_text", this._coreRuleHandle, ...core.input(String(value)));
    this._changed();
  }
}

// The declarations of a style rule that follow a nested rule (CSS Nesting
// 1 §5.3).
export class CSSNestedDeclarations extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
}

// A grouping rule with a condition, @media or @supports (CSS Conditional
// 3 §7.2).
export class CSSConditionRule extends CSSGroupingRule {
}

export class CSSMediaRule extends CSSConditionRule {
}

export class CSSSupportsRule extends CSSConditionRule {
}

// An @container rule (CSS Conditional 5 §4.1).
export class CSSContainerRule extends CSSConditionRule {
}

export class CSSFontFaceRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
}

export class CSSFontFeatureValuesRule extends CSSRule {
}

export class CSSCounterStyleRule extends CSSRule {
}

export class CSSKeyframeRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
}

// A @layer block and a @layer statement (CSS Cascade 5 §7.2, §7.3).
export class CSSLayerBlockRule extends CSSGroupingRule {
  get name() {
    return this._domCore.string("css_rule_prelude", this._coreRuleHandle) ?? "";
  }
}

export class CSSLayerStatementRule extends CSSRule {
  get nameList() {
    const prelude = this._domCore.string("css_rule_prelude", this._coreRuleHandle) ?? "";
    return Object.freeze(prelude.split(",").map((name) => name.trim()).filter((name) => name !== ""));
  }
}

// A @keyframes rule lists its keyframe rules (CSS Animations 1 §6.2).
export class CSSKeyframesRule extends CSSRule {
  get cssRules() {
    return childRules(this);
  }
}

const ruleBindingRuntime = {
  CSSRule,
  conditionText(rule) {
    return rule._domCore.string("css_rule_condition_text", rule._coreRuleHandle) ?? "";
  },
  setKeyText(rule, text) {
    const core = rule._domCore;
    core.status("css_rule_set_key_text", rule._coreRuleHandle, ...core.input(text));
  },
  setKeyframesName(rule, text) {
    const core = rule._domCore;
    core.status("css_keyframes_rule_set_name", rule._coreRuleHandle, ...core.input(text));
  },
  counterStyleDescriptor(rule, descriptor) {
    const core = rule._domCore;
    return core.string("css_counter_style_descriptor", rule._coreRuleHandle, ...core.input(descriptor));
  },
  setCounterStyleDescriptor(rule, descriptor, text) {
    const core = rule._domCore;
    core.status("css_counter_style_set_descriptor", rule._coreRuleHandle, ...core.input(descriptor), ...core.input(text));
  },
  setCounterStyleName(rule, text) {
    const core = rule._domCore;
    core.status("css_counter_style_set_name", rule._coreRuleHandle, ...core.input(text));
  },
  containerName(rule) {
    return rule._domCore.string("css_container_rule_part", rule._coreRuleHandle, 1, -1) ?? "";
  },
  containerQuery(rule) {
    return rule._domCore.string("css_container_rule_part", rule._coreRuleHandle, 2, -1) ?? "";
  },
  // Each condition as a CSSContainerCondition dictionary, in a frozen
  // array (CSS Conditional 5 §4.1).
  containerConditions(rule) {
    const core = rule._domCore;
    const count = core.status("css_container_rule_condition_count", rule._coreRuleHandle);
    return Object.freeze(Array.from({ length: count }, (_, index) => ({
      name: core.string("css_container_rule_part", rule._coreRuleHandle, 1, index) ?? "",
      query: core.string("css_container_rule_part", rule._coreRuleHandle, 2, index) ?? "",
    })));
  },
};
installCSSRuleBindings(ruleBindingRuntime, CSSRule.prototype);
installCSSStyleRuleBindings(ruleBindingRuntime, CSSStyleRule.prototype);
installCSSConditionRuleBindings(ruleBindingRuntime, CSSConditionRule.prototype);
installCSSMediaRuleBindings(ruleBindingRuntime, CSSMediaRule.prototype);
installCSSSupportsRuleBindings(ruleBindingRuntime, CSSSupportsRule.prototype);
installCSSContainerRuleBindings(ruleBindingRuntime, CSSContainerRule.prototype);
installCSSFontFaceRuleBindings(ruleBindingRuntime, CSSFontFaceRule.prototype);
installCSSFontFeatureValuesRuleBindings(ruleBindingRuntime, CSSFontFeatureValuesRule.prototype);
installCSSCounterStyleRuleBindings(ruleBindingRuntime, CSSCounterStyleRule.prototype);
installCSSKeyframeRuleBindings(ruleBindingRuntime, CSSKeyframeRule.prototype);
installCSSKeyframesRuleBindings(ruleBindingRuntime, CSSKeyframesRule.prototype);
// Each interface prototype's class string (Web IDL §3.7.3).
for (const [name, Interface] of Object.entries({
  CSSRule, CSSStyleRule, CSSNestedDeclarations, CSSGroupingRule, CSSConditionRule, CSSMediaRule, CSSSupportsRule, CSSContainerRule, CSSFontFaceRule,
  CSSFontFeatureValuesRule, CSSCounterStyleRule, CSSKeyframeRule, CSSKeyframesRule, CSSLayerBlockRule, CSSLayerStatementRule,
})) {
  Object.defineProperty(Interface.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

function ruleObject(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
  const existing = coreHandleCache(rulesByHandle, core).get(handle)?.deref();
  if (existing) return existing;
  // css_rule_kind answers the CSSOM CSSRule type constant.
  switch (core.status("css_rule_kind", handle)) {
    case CSSRule.STYLE_RULE:
      return new CSSStyleRule(sheet, handle, core);
    case CSSRule.MEDIA_RULE:
      return new CSSMediaRule(sheet, handle, core);
    case CSSRule.FONT_FACE_RULE:
      return new CSSFontFaceRule(sheet, handle, core);
    case CSSRule.KEYFRAMES_RULE:
      return new CSSKeyframesRule(sheet, handle, core);
    case CSSRule.KEYFRAME_RULE:
      return new CSSKeyframeRule(sheet, handle, core);
    case CSSRule.SUPPORTS_RULE:
      return new CSSSupportsRule(sheet, handle, core);
    case CSSRule.FONT_FEATURE_VALUES_RULE:
      return new CSSFontFeatureValuesRule(sheet, handle, core);
    case CSSRule.COUNTER_STYLE_RULE:
      return new CSSCounterStyleRule(sheet, handle, core);
    // A nested declarations rule (core kind 23) has no CSSRule type
    // constant (CSS Nesting 1 §5.3).
    case 23:
      return new CSSNestedDeclarations(sheet, handle, core);
    default:
      // @container and @layer have no CSSRule type constant (CSS
      // Conditional 5 §4.1, CSS Cascade 5 §7); a @layer statement ends in ";".
      switch ((core.string("css_rule_name", handle) ?? "").toLowerCase()) {
        case "container":
          return new CSSContainerRule(sheet, handle, core);
        case "layer":
          return (core.string("css_rule_text", handle) ?? "").endsWith(";")
            ? new CSSLayerStatementRule(sheet, handle, core)
            : new CSSLayerBlockRule(sheet, handle, core);
      }
      return new CSSRule(sheet, handle, core);
  }
}

// A core sheet outlives its wrapper only until the wrapper is collected.
// Wrappers of binding-owned sheets (constructed, linked, user-agent) by core
// handle, held weakly: a strong entry would keep every adopting document
// alive through the sheet's adopter set. A <style> element's sheet is
// core-owned and wraps on the element.
const sheetsByHandle = new WeakMap();
const sheetFinalizer = new FinalizationRegistry(({ coreReference, handle }) => {
  const core = coreReference.deref();
  if (!core) return;
  const sheets = sheetsByHandle.get(core);
  if (!sheets?.get(handle)?.deref()) sheets?.delete(handle);
  core.disposeStylesheet(handle);
});

class CSSStyleSheetRuntime {
  constructor(
    {
      baseURL = "about:blank", ownerNode = null, coreHandle = 0,
      document = ownerNode?.ownerDocument ?? null,
      core = document?._domCore ?? sharedDomCore,
    } = {},
  ) {
    this.href = null;
    this.ownerNode = ownerNode;
    this._domCore = core;
    this._baseURL = baseURL;
    this._adopters = new Set();
    this._rulesByHandle = new Map();
    this._snapshotRevision = -1;
    this._snapshotValue = null;
    this._cssRules = liveCollection([], "CSSRuleList");
    if (coreHandle) {
      this._coreSheetHandle = coreHandle;
    } else {
      this._coreSheetHandle = core.createStylesheet(document?._coreHandle ?? 0n, ownerNode !== null);
      coreHandleCache(sheetsByHandle, core).set(this._coreSheetHandle, new WeakRef(this));
      sheetFinalizer.register(this, { coreReference: new WeakRef(core), handle: this._coreSheetHandle });
      core.parseStylesheet(this._coreSheetHandle, "");
    }
  }
  _getDisabled() {
    return this._domCore.stylesheetDisabled(this._coreSheetHandle);
  }
  _setDisabled(value) {
    this._domCore.setStylesheetDisabled(this._coreSheetHandle, value);
  }
  _getMedia() {
    return this._domCore.stylesheetMedia(this._coreSheetHandle);
  }
  _setMedia(value) {
    this._domCore.setStylesheetMedia(this._coreSheetHandle, value);
  }
  // The core re-parses a <style> sheet from its text when the text changes;
  // the snapshot and rule objects follow the core revision.
  get _snapshot() {
    const revision = this._domCore.stylesheetRevision(this._coreSheetHandle);
    if (revision !== this._snapshotRevision) {
      this._snapshotRevision = revision;
      this._snapshotValue = this._domCore.stylesheetSnapshot(this._coreSheetHandle, this.href ?? this._baseURL);
      this._rebuild();
    }
    return this._snapshotValue;
  }
  _requireOriginClean(access) {
    this._domCore.status("stylesheet_require_origin_clean", this._coreSheetHandle, access);
  }
  _getRules() {
    this._requireOriginClean(STYLESHEET_ACCESS_RULES);
    return this._ruleList();
  }
  // The rule list without the origin-clean check, for Sandom's own reads.
  _ruleList() {
    this._snapshot;
    return this._cssRules;
  }
  _syncOwnerConnection() {
    const owner = this.ownerNode;
    const ownerDocument = owner?.ownerDocument;
    if (owner?.isConnected && ownerDocument) {
      this._domCore.connectStylesheet(
        this._coreSheetHandle,
        owner._coreHandle,
        ownerDocument._coreHandle,
      );
    } else {
      this._domCore.disconnectStylesheet(this._coreSheetHandle);
    }
  }
  _rebuild() {
    this._cssRules.splice(
      0,
      this._cssRules.length,
      ...this._snapshotValue.rules.map((handle) => ruleObject(this, handle)),
    );
    for (const [handle, reference] of this._rulesByHandle) {
      const rule = reference.deref();
      if (!rule || !this._domCore.status("css_rule_sheet", handle)) {
        if (rule) rule._sheet = null;
        this._rulesByHandle.delete(handle);
      }
    }
  }
  _changed() {
    this._snapshot;
    for (const document of this._adopters) document._invalidateStyles();
  }
  // The core retains the source and all rule/declaration records for each
  // revision. `constructed`: the replace of a constructed sheet, whose
  // @import rules are ignored (CSSOM replaceSync()).
  _setSource(source, constructed = false) {
    this._domCore.parseStylesheet(
      this._coreSheetHandle,
      source,
      constructed,
    );
    this._snapshot;
    for (const document of this._adopters) document._invalidateStyles();
  }
  _replaceSyncTransport(source) {
    this._setSource(source, true);
  }
  _replaceTransport(source) {
    return Promise.resolve().then(() => {
      this.replaceSync(source);
      return this;
    });
  }
  _defaultInsertIndex(index) {
    this._requireOriginClean(STYLESHEET_ACCESS_INSERT);
    // Web IDL: insertRule(rule, optional unsigned long index = 0).
    return index === undefined ? 0 : index;
  }
  _checkInsertIndex(index) {
    return this._domCore.status(
      "stylesheet_check_index",
      this._coreSheetHandle,
      index,
      true,
    );
  }
  _checkDeleteIndex(index) {
    this._requireOriginClean(STYLESHEET_ACCESS_DELETE);
    return this._domCore.status(
      "stylesheet_check_index",
      this._coreSheetHandle,
      index,
      0,
    );
  }
  _insertRuleTransport(source, position) {
    const result = this._domCore.status(
      "stylesheet_insert_rule",
      this._coreSheetHandle,
      ...this._domCore.input(source),
      position,
    );
    this._changed();
    return result;
  }
  _deleteRuleTransport(index) {
    this._domCore.status(
      "stylesheet_delete_rule",
      this._coreSheetHandle,
      index,
    );
    this._changed();
  }
  _getDiagnostics() {
    return this._snapshot.diagnostics;
  }
}

export const CSSStyleSheet = createCSSStyleSheetClass({ CSSStyleSheetRuntime });
Object.defineProperty(CSSStyleSheet.prototype, Symbol.toStringTag, { value: "CSSStyleSheet", configurable: true });


function cascadeFor(system, element, pseudoElement) {
  const core = element._domCore;
  // The core lists the sheets of every scope that can reach the element,
  // matches ordinary, shadow-scoped, and ::part rules, offers inline
  // declarations, and resolves custom properties, var() references, and
  // the CSS-wide keywords against the flat-tree parent's stored record; the
  // environment gates @media in that plan.
  core.mediaEnvironmentSet(system.environment);
  const resolve = () => {
    if (!pseudoElement) {
      return core.styleElementResolve(element._coreHandle);
    }
    // A pseudo-element inherits from its element and is not stored.
    system.cascadedFor(element, null);
    core.cascadeBegin();
    core.cascadeElementCollect(element._coreHandle, pseudoElement);
    core.status("cascade_finish");
    return core.computedStyleResolve(
      element._coreHandle,
      element._coreHandle,
      COMPUTED_RESOLVE_PSEUDO,
    );
  };
  // Font families are host state: the core lists the font-family values it
  // met without an answer, the registry keys them, and the element resolves
  // again with the answers in place. A math script size reads the MATH
  // table of the face, so a record also waits on the renderer font binding
  // of its document, which a layout makes; a read before any layout makes
  // it here.
  let result = resolve();
  let context = core.computedContext();
  let fontsBound = false;
  while (context.pending) {
    if (core.fontFamilyRequests(element.ownerDocument).length !== 0) {
      system.answerFontFamilyRequests();
    } else if (!fontsBound) {
      fontsBound = true;
      system.bindRendererFonts(element);
    } else {
      // A record waits only on an unanswered value of its own document or
      // on the face binding; a pending record with neither would resolve
      // the same way forever.
      throw new Error(
        `The style of <${element.localName}>${pseudoElement ?? ""} waits on a font, and its document has no ` +
          "unanswered font-family value and its faces are bound: a record it inherits from is stale",
      );
    }
    result = resolve();
    context = core.computedContext();
  }
  // A font-family value no family matches inherits; the inherited family is
  // the fallback the failed resource diagnostic reports.
  for (const [property, value] of result) {
    if (property === "fontFamily") system.recordInheritedFontFamily(value, context.fontFamily);
  }
}

// The wrapper of a core-owned <style> sheet lives on its element; binding-
// owned sheets are found by handle.
function wrapElementSheet(element, handle) {
  let sheet = element._sheetWrapper;
  if (sheet?._coreSheetHandle !== handle || sheet?._domCore !== element._domCore) {
    sheet = new CSSStyleSheet({
      baseURL: element.ownerDocument.baseURI,
      ownerNode: element,
      coreHandle: handle,
    });
    sheet._adopters.add(element.ownerDocument);
    element._sheetWrapper = sheet;
  }
  return sheet;
}

function wrapSheet(core, handle) {
  const known = sheetsByHandle.get(core)?.get(handle)?.deref();
  if (known) return known;
  const owner = core.stylesheetOwner(handle);
  if (!owner) throw new Error("Active stylesheet has no wrapper");
  return wrapElementSheet(owner, handle);
}

export function createDocumentStyleSystem(document, environment = {}) {
  const core = document._domCore;
  // The core installs its user-agent sheet in every document it creates.
  const wrapUserAgentSheet = () => new CSSStyleSheet({
    baseURL: "sandom:user-agent",
    document,
    coreHandle: core.userAgentStylesheet(document._coreHandle),
  });
  let userAgentSheet = wrapUserAgentSheet();
  let quirksSheet = null;
  const ownedSheets = new Set();
  const adopted = [];
  const linkedResources = new Map();

  function dispatchResourceEvent(element, type) {
    queueMicrotask(() => dispatchEvent(element, createEvent(type)));
  }
  const fontResources = new Map();
  const fontPending = new Set();
  let fontsReleased = false;
  let nextFontRuleID = 1;
  // The availability row of a face (font_catalog_availability), by the
  // ID of its resource: a resource keeps one ID from pending to released.
  function publishFontResource(resource, state) {
    const id = resource.catalogID ??= nextFontRuleID++;
    const registry = ensureFontRegistry();
    core.status(
      "font_catalog_availability", registry.fontCatalogHandle,
      document._coreHandle, id, ...core.input(resource.family), state,
    );
  }
  let selectedFontRegistry = null;
  let unsubscribeFontRegistry = null;
  function ensureFontRegistry() {
    const registry = document._sandomFontRegistry ?? defaultFontRegistry;
    if (registry !== selectedFontRegistry) {
      selectedFontRegistry?.unbindDocument(document);
      unsubscribeFontRegistry?.();
      selectedFontRegistry = registry;
      unsubscribeFontRegistry = registry.subscribe(fontStateChanged, { weak: true });
    }
    core.status(
      "font_catalog_activate", registry.fontCatalogHandle, document._coreHandle,
    );
    return registry;
  }

  // document.fonts (font-face-set.js); set once the style system exists.
  let fontFaceSet = null;
  // Native catalog changes own cache/revision consequences; this only wakes
  // the host scheduler for asynchronous loading and metric completion.
  function fontStateChanged() {
    if (!fontsReleased) {
      document._renderSurface?._broadcastMutation("font", document);
    }
    fontFaceSet?._settleFaces();
  }

  function releaseFontResource(resource) {
    if (resource.catalogID !== undefined && !fontsReleased) {
      core.status(
        "font_catalog_availability", ensureFontRegistry().fontCatalogHandle,
        document._coreHandle, resource.catalogID, ...core.input(resource.family), -1,
      );
    }
    resource.controller?.abort(
      new DOMException("Font load became obsolete", "AbortError"),
    );
    // A loaded face, and the declared face of a rule with unicode-range.
    if (resource.familyKey !== undefined) {
      (
        document._sandomFontRegistry?.unregisterRuntimeFont ??
          unregisterRuntimeFont
      )(resource.familyKey, resource);
    }
  }

  // The source of a linked sheet with its imports inlined and its relative
  // url()s made absolute (css-sheet-imports.watpart): the core lists the
  // references, the host fetches each import and resolves each URL against
  // the sheet's final URL, and the core composes the result.
  // `request`: the demand fields of the import's url() modifiers (CSS
  // Values 5 §4.1.1); a linked sheet's own link has none.
  async function resolveSheetSource(
    document,
    requestedURL,
    baseURL,
    signal,
    ancestors = [],
    request = {},
  ) {
    if (!document._resolveResource) {
      throw new TypeError(`The document of stylesheet ${requestedURL} has no resource loader`);
    }
    const absoluteURL = new URL(requestedURL, baseURL).href;
    if (ancestors.includes(absoluteURL)) {
      throw new DOMException(
        `Stylesheet import cycle at ${absoluteURL}`,
        "NetworkError",
      );
    }
    const response = await document._resolveResource({
      requestedURL: absoluteURL,
      authoredURL: requestedURL,
      baseURL,
      kind: "stylesheet",
      signal,
      ...request,
    });
    if (signal.aborted) throw signal.reason;
    if (!response || typeof response.source !== "string") {
      throw new TypeError(
        "Stylesheet resolver must return { source, finalURL }",
      );
    }
    const finalURL =
      new URL(response.finalURL ?? absoluteURL, absoluteURL).href;
    // A sheet is opaque when its response is opaque. Sandom inlines each
    // imported sheet into the importing source, so an opaque import makes
    // the whole flattened sheet opaque: its rules are no longer separable.
    let opaque = response.opaque === true;
    const pieces = [];
    for (const { kind, url, request: referenceRequest } of core.cssSheetReferences(response.source)) {
      if (kind === CSS_REFERENCE_URL) {
        pieces.push(new URL(url, finalURL).href);
        continue;
      }
      const imported = await resolveSheetSource(
        document,
        url,
        finalURL,
        signal,
        [...ancestors, absoluteURL],
        referenceRequest,
      );
      opaque ||= imported.opaque;
      pieces.push(imported.source);
    }
    return {
      source: core.cssSheetFlatten(response.source, pieces),
      finalURL,
      opaque,
    };
  }

  const system = {
    environment: {
      viewportWidth: 1280,
      viewportHeight: 720,
      mediaType: "screen",
      colorScheme: "light",
      reducedMotion: false,
      // The default render pipeline works in an extended rgba16float
      // encoding that preserves display-p3 chroma end to end, so p3 is
      // the truthful default gamut. Dynamic range stays standard unless
      // the host declares a high-dynamic-range presentation.
      colorGamut: "p3",
      dynamicRange: "standard",
      hoverCapability: "hover",
      pointerAccuracy: "fine",
      // "overlay" or "classic" (design/scrollbars.md): set by
      // the render surface; a classic bar takes layout space.
      scrollbarStyle: "overlay",
      // Forced colors mode (CSS Color Adjust 1 §3): "none", or the
      // emulation palette "light" or "dark" (§5.2).
      forcedColors: "none",
      ...environment,
    },
    get generation() {
      ensureFontRegistry();
      return core.styleGeneration(document._coreHandle);
    },
    // Callbacks of the document's render surfaces, called after an
    // environment change (DOMRenderSurface's constructor and shutdown).
    environmentListeners: new Set(),
    // The viewport of the environment is also the document's viewport, which
    // its lengths resolve against (SDDocument._setViewport).
    setEnvironment(values) {
      let changed = false;
      for (const [name, value] of Object.entries(values)) {
        if (this.environment[name] === value) continue;
        this.environment[name] = value;
        changed = true;
      }
      if ("viewportWidth" in values || "viewportHeight" in values) {
        document._setViewport(this.environment.viewportWidth, this.environment.viewportHeight);
      }
      if (changed) {
        this.invalidate();
        // The render surfaces over the document owe a frame: no DOM
        // mutation tells them, and forced colors and the media type act on
        // the records their frames write.
        for (const listener of this.environmentListeners) listener();
      }
    },
    invalidate() {
      core.styleInvalidate(document._coreHandle);
      this.reconcileSoon();
    },
    // Owner connections and the linked-sheet/font reconcile without a
    // cascade invalidation: for mutations the core already invalidates
    // itself (attributes, scoped to the element's subtree; tree and text
    // changes, the whole cascade), so a host bump here would only widen
    // a scoped one to every element. Every change of a reconcile input
    // lands here: a tree, attribute or text mutation (Node
    // _notifyMutation), a sheet's CSSOM change, an environment change and
    // a sheet or font load settling (invalidate). A pseudo-class state
    // change is none of them.
    reconcileSoon() {
      this._reconcileOwed = true;
      for (const sheet of ownedSheets) sheet._syncOwnerConnection();
      if (!this._reconcileQueued) {
        this._reconcileQueued = true;
        queueMicrotask(() => {
          this._reconcileQueued = false;
          // A disposal between the change and this task freed the tree.
          if (core.documentDisposed(document)) return;
          this.reconcile();
        });
      }
    },
    // Linked stylesheets and font-face rules are functions of the tree, the
    // attributes, the active sheets and the environment, and each change of
    // those owes a reconcile (reconcileSoon); without one the walk over the
    // document's links and sheets is skipped. Cleared BEFORE reconciling: a
    // load completing inside owes the next one, which is idempotent.
    _reconcileOwed: true,
    // The reconciles that walked the links and sheets.
    reconciliations: 0,
    reconcile() {
      ensureFontRegistry();
      if (!this._reconcileOwed) return;
      this._reconcileOwed = false;
      this.reconciliations++;
      this.reconcileResources();
      this.reconcileFonts();
    },
    sheetForElement(element) {
      if (!element || !["style", "link"].includes(element.localName)) {
        return null;
      }
      if (element.localName === "link") {
        return linkedResources.get(element)?.sheet ?? null;
      }
      const handle = element._domCore.elementStylesheet(element._coreHandle);
      if (!handle) return null;
      return wrapElementSheet(element, handle);
    },
    // The loads of the document's linked sheets (link-sheets.watpart): the
    // core decides which links load, when a load starts or is superseded,
    // and its state; the host resolves each href, fetches, and keeps each
    // load's AbortController and sheet.
    reconcileResources() {
      const obsolete = () => new DOMException("Stylesheet load became obsolete", "AbortError");
      for (const element of core.statusNodes("link_sheet_prune", document._coreHandle)) {
        linkedResources.get(element)?.controller.abort(obsolete());
        linkedResources.delete(element);
      }
      const baseURL = document.baseURI;
      for (const element of core.elementsByTagName(document._coreHandle, "link")) {
        const href = element.getAttribute("href");
        const action = core.status(
          "link_sheet_update",
          element._coreHandle,
          document._coreHandle,
          ...core.input(URL.parse(href, baseURL)?.href ?? ""),
          ...core.input(baseURL),
        );
        if (action === LINK_SHEET_ACTION_ERROR) {
          dispatchResourceEvent(element, "error");
          continue;
        }
        if (action !== LINK_SHEET_ACTION_LOAD) continue;
        linkedResources.get(element)?.controller.abort(obsolete());
        const generation = core.status("link_sheet_generation", element._coreHandle);
        const controller = new AbortController();
        const resource = { controller, sheet: null, error: null, pending: null };
        linkedResources.set(element, resource);
        resource.pending = resolveSheetSource(document, href, baseURL, controller.signal).then(
          ({ source, finalURL, opaque }) => {
            if (core.status("link_sheet_settle", element._coreHandle, generation, 1) === 0) return;
            const sheet = new CSSStyleSheet({
              baseURL: finalURL,
              ownerNode: element,
            });
            sheet.href = finalURL;
            core.status("stylesheet_set_opaque", sheet._coreSheetHandle, Number(opaque));
            sheet._setSource(source);
            sheet.media = element.getAttribute("media") ?? "";
            sheet._adopters.add(document);
            ownedSheets.add(sheet);
            sheet._syncOwnerConnection();
            resource.sheet = sheet;
            this.invalidate();
            dispatchResourceEvent(element, "load");
          },
          (error) => {
            if (core.status("link_sheet_settle", element._coreHandle, generation, 0) === 0) return;
            resource.error = error;
            this.invalidate();
            dispatchResourceEvent(element, "error");
          },
        );
      }
    },
    // The faces of the active @font-face rules (font-face-rules.watpart):
    // the core decides which rules name a face, when a face loads again,
    // whether it waits for its unicode-range, its state and the rules that
    // left the active sheets; the host resolves, fetches, decodes and
    // registers each face. A face belongs to its core rule, by handle: a
    // sheet wrapper is collected with its element wrapper, and the next
    // wrapper wraps the same core rules.
    reconcileFonts() {
      if (fontsReleased) return;
      const releaseRule = (rule) => {
        releaseFontResource(fontResources.get(rule));
        fontResources.delete(rule);
        fontStateChanged();
      };
      for (const { sheet } of this.activeSheets()) {
        const baseURL = sheet.href ?? sheet._baseURL;
        for (const rule of core.activeNamedRules(sheet._coreSheetHandle, "font-face", this.environment)) {
          const action = core.status("font_face_update", document._coreHandle, rule, ...core.input(baseURL));
          if (action === FONT_FACE_ACTION_NONE) continue;
          if ((action & FONT_FACE_ACTION_RELEASE) !== 0) releaseRule(rule);
          const generation = core.status("font_face_generation", rule);
          const declarations = new Map(
            core.ruleDeclarations(rule).map((declaration) => [
              declaration.property.toLowerCase(),
              declaration.value,
            ]),
          );
          const family = core.string("font_family_normalize", ...core.input(declarations.get("font-family")), 0);
          // The first url() of the src descriptor is the face's source; its
          // request modifiers set the fields of the demand.
          const [{ url: authoredURL, request: sourceRequest }] = core.cssURLs(declarations.get("src"));
          const weight = fontFaceRangeDescriptor(declarations.get("font-weight"), false);
          const stretch = fontFaceRangeDescriptor(declarations.get("font-stretch"), true);
          // An absent or invalid font-style descriptor is auto.
          const styleText = declarations.get("font-style");
          const style = fontFaceStyleDescriptor(styleText) === null ? "auto" : styleText;
          let requestedURL;
          try {
            requestedURL = new URL(authoredURL, baseURL).href;
          } catch (error) {
            core.status("font_face_settle", rule, generation, 0);
            fontResources.set(rule, {
              error,
              family,
              requestedURL: authoredURL,
              finalURL: null,
            });
            publishFontResource(fontResources.get(rule), 2);
            continue;
          }
          const current = () => core.status("font_face_current", rule, generation) === 1;
          const controller = new AbortController();
          const resource = {
            controller,
            family,
            requestedURL,
            finalURL: null,
          };
          // Starts the load of the rule. The promise settles after the face
          // registers, or rejects with the cause of a failed load.
          const load = () => {
            core.status("font_face_pending", rule, generation);
            const pending = Promise.resolve(document._resolveResource({
              requestedURL,
              authoredURL,
              baseURL,
              kind: "font",
              signal: controller.signal,
              ...sourceRequest,
            })).then(async (response) => {
              if (!current()) return;
              const source = response?.bytes ?? response?.source;
              const bytes = source instanceof Uint8Array
                ? source
                : source instanceof ArrayBuffer
                ? new Uint8Array(source)
                : null;
              if (!bytes) {
                throw new TypeError(
                  "Font resolver response must provide Uint8Array bytes",
                );
              }
              const finalURL = new URL(
                response.finalURL ?? requestedURL,
                requestedURL,
              ).href;
              const decodedBytes = await decodeWebFont(bytes);
              if (!current()) return;
              const familyKey = (
                document._sandomFontRegistry?.registerRuntimeFont ??
                  registerRuntimeFont
              )(family, decodedBytes, {
                weight,
                stretch,
                style,
                unicodeRange,
                finalURL,
                owner: resource,
                document,
              });
              core.status("font_face_settle", rule, generation, 1);
              Object.assign(resource, { familyKey, finalURL });
              publishFontResource(resource, 1);
              fontStateChanged();
            }).catch((error) => {
              if (core.status("font_face_settle", rule, generation, 0) === 0) return;
              resource.error = error;
              // The declared face of a rule with unicode-range leaves the
              // font stack, so no frame requests it again.
              if (resource.familyKey !== undefined) {
                (
                  document._sandomFontRegistry?.unregisterRuntimeFont ??
                    unregisterRuntimeFont
                )(resource.familyKey, resource);
                delete resource.familyKey;
              }
              publishFontResource(resource, 2);
              fontStateChanged();
            }).finally(() => {
              fontPending.delete(pending);
            });
            fontPending.add(pending);
            pending.then(() => this.invalidate());
            return pending.then(() => {
              const state = current() ? core.status("font_face_state", rule) : FONT_FACE_UNLOADED;
              if (state === FONT_FACE_FAILED) throw resource.error;
              if (state !== FONT_FACE_LOADED) {
                throw new DOMException(`The font rule of ${requestedURL} became obsolete while it loaded`, "AbortError");
              }
            });
          };
          // A face with a valid unicode-range descriptor stays unloaded
          // until a shaped text needs a scalar of its range
          // (design/text-rendering.md, "unicode-range faces", item 3).
          const unicodeRange = (action & FONT_FACE_ACTION_DECLARE) !== 0
            ? core.fontUnicodeRanges(declarations.get("unicode-range"))
            : null;
          fontResources.set(rule, resource);
          publishFontResource(resource, 0);
          if (unicodeRange === null) {
            // The resource records a failed load (resourceDiagnostics).
            const loading = load();
            loading.catch(() => {});
            resource.load = () => loading;
          } else {
            let loading = null;
            // FontFace.load() starts a declared face before text needs it.
            resource.load = () => loading ??= load();
            resource.familyKey = ensureFontRegistry().declareRuntimeFont(family, {
              weight,
              stretch,
              style,
              unicodeRange,
              owner: resource,
              load: resource.load,
              document,
            });
          }
        }
      }
      for (const rule of core.outputRuleHandles("font_face_prune", core.status("font_face_prune", document._coreHandle, 0))) {
        releaseRule(rule);
      }
    },
    releaseFonts() {
      if (fontsReleased) return;
      fontsReleased = true;
      unsubscribeFontRegistry?.();
      unsubscribeFontRegistry = null;
      selectedFontRegistry?.unbindDocument(document);
      core.status("font_face_prune", document._coreHandle, 1);
      for (const resource of fontResources.values()) {
        releaseFontResource(resource);
      }
      if (fontResources.size !== 0) fontStateChanged();
      fontResources.clear();
    },
    // The core answers the font-family values it requested; the registry
    // supplies the host's family records and faces (font_answer_next).
    answerFontFamilyRequests() {
      (document._sandomFontRegistry ?? defaultFontRegistry).answerFontFamilies(document);
    },
    // Binds the face catalog of the document's registry to its renderer, as
    // the publication of a layout does (serializeToScene).
    bindRendererFonts(element) {
      (document._sandomFontRegistry ?? defaultFontRegistry).prepareNativeFontPublication(element, true);
    },
    // Answers, before the first resolution of a frame, every family value
    // the cascade of the root's scope declares. An answer given after
    // elements resolved publishes families to the font catalog, and that
    // makes every element resolve again. Values with var() and inline
    // values are still requested when an element resolves. While a font
    // resource of the document has failed, only the values elements
    // resolve against are answered, so the fallbacks its diagnostic names
    // (font_answer_inherited) stay the ones elements use.
    answerDeclaredFontFamilies(root) {
      if (core.status("font_faces_in_state", document._coreHandle, FONT_FACE_FAILED) > 0) return;
      core.mediaEnvironmentSet(this.environment);
      if (core.status("font_family_request_declared", root._coreHandle) > 0) {
        this.answerFontFamilyRequests();
      }
    },
    // Records the family a value that matched no family inherits as the
    // fallback of the failed font resources the value names.
    recordInheritedFontFamily(authoredFontFamily, inheritedFamilyKey) {
      core.status(
        "font_answer_inherited", ensureFontRegistry().fontCatalogHandle, document._coreHandle,
        ...core.input(String(authoredFontFamily)), ...core.input(String(inheritedFamilyKey ?? "")),
      );
    },
    get resourceDiagnostics() {
      const registry = ensureFontRegistry();
      return Object.freeze(
        [...fontResources]
          .filter(([rule]) => core.status("font_face_state", rule) === FONT_FACE_FAILED)
          .map(([, resource]) => {
            const count = core.status(
              "font_fallback_count", registry.fontCatalogHandle, document._coreHandle, resource.catalogID,
            );
            const selectedFallbacks = Object.freeze(
              Array.from({ length: count }, (_, index) => {
                const familyKey = core.string(
                  "font_fallback_at", registry.fontCatalogHandle, document._coreHandle, resource.catalogID, index,
                ) ?? "";
                return Object.freeze({ familyKey, fontFamily: registry.fontFamilyCssValue(familyKey) });
              }),
            );
            const fallbackMessage = selectedFallbacks.length === 0
              ? ""
              : `; using ${
                selectedFallbacks.map((fallback) => fallback.fontFamily).join(
                  " or ",
                )
              }`;
            return Object.freeze({
              code: "font-resource-unavailable",
              severity: "warning",
              recoverable: true,
              message:
                `Font resource ${resource.requestedURL} for "${resource.family}" is unavailable${fallbackMessage}: ${
                  resource.error?.message ?? String(resource.error)
                }`,
              unavailableFontFamily: resource.family,
              selectedFallbacks,
              resource: Object.freeze({
                kind: "font",
                requestedFinalURL: resource.requestedURL,
                finalURL: resource.finalURL,
              }),
              cause: Object.freeze({
                name: resource.error?.name ?? "Error",
                message: resource.error?.message ?? String(resource.error),
              }),
            });
          }),
      );
    },
    // The linked style sheets that are loading now, settled. A parser-
    // blocking script waits for them (HTML, "has a style sheet that is
    // blocking scripts"); a failed load unblocks it as a loaded one does.
    // The parser inserts links without a mutation notification, so the
    // links are walked again here.
    async linkedSheetsSettled() {
      this._reconcileOwed = true;
      this.reconcile();
      await Promise.all([...linkedResources.values()].map((resource) => resource.pending));
    },
    // The linked style sheets and the declared fonts that are loading now,
    // settled. A script that runs after parsing, deferred or a module,
    // waits for them: Sandom has no fallback face to lay text out with
    // while a web font loads, so such a script could read the layout of
    // text that has none. A failed load unblocks it as a loaded one does.
    async sheetsAndFontsSettled() {
      await this.linkedSheetsSettled();
      // A linked sheet that just loaded may declare fonts.
      this.reconcile();
      await Promise.all([...fontPending]);
    },
    // Brings the document's linked sheet loads up to date: a script that
    // the parser inserts waits for the sheets that are loading
    // (link_sheet_loading, script_prepare).
    reconcileLinkedSheets() {
      this.reconcileResources();
    },
    // A document with scripting enabled hides `noscript`, whose content its
    // parser keeps as text (HTML, "Rendering", 15.3.1): the core gives it
    // the scripting user-agent sheet.
    enableScripting() {
      core.status("document_scripting_enable", document._coreHandle);
      userAgentSheet._adopters.delete(document);
      userAgentSheet = wrapUserAgentSheet();
      userAgentSheet._adopters.add(document);
      this.invalidate();
    },
    async ready() {
      this.reconcile();
      await Promise.all([...linkedResources.values()].map((resource) => resource.pending));
      const stylesheetErrors = [...linkedResources]
        .filter(([element]) => core.status("link_sheet_state", element._coreHandle) === LINK_SHEET_FAILED)
        .map(([, resource]) => resource.error);
      if (stylesheetErrors.length > 0) {
        throw new AggregateError(
          stylesheetErrors,
          `${stylesheetErrors.length} stylesheet resource(s) failed`,
        );
      }
      // A linked sheet that just loaded may declare fonts.
      this.reconcile();
      await Promise.all([...fontPending]);
    },
    activeSheets(scopeRoot = document) {
      // Every document wraps the core's user-agent sheets itself: its
      // user-agent sheet and, in quirks mode, the quirks sheet.
      return core.activeStylesheets(scopeRoot._coreHandle).map(({ handle, origin }) => {
        if (origin !== 0) return { sheet: wrapSheet(core, handle), origin };
        if (handle === userAgentSheet._coreSheetHandle) return { sheet: userAgentSheet, origin };
        if (quirksSheet?._coreSheetHandle !== handle) {
          quirksSheet = new CSSStyleSheet({ baseURL: "sandom:user-agent-quirks", document, coreHandle: handle });
        }
        return { sheet: quirksSheet, origin };
      });
    },
    cascadedFor(element, pseudoElement = null) {
      ensureFontRegistry();
      return cascadeFor(this, element, pseudoElement);
    },
    hoverStateAffectsStyle(element) {
      element._domCore.mediaEnvironmentSet(this.environment);
      return element._domCore.cascadeStateAffects(element._coreHandle, "hover");
    },
    activeStateAffectsStyle(element) {
      element._domCore.mediaEnvironmentSet(this.environment);
      return element._domCore.cascadeStateAffects(element._coreHandle, "active");
    },
    // Whether a scope of `root`'s tree holds a @keyframes rule: the
    // document's, or a shadow root's in its subtree, user-agent roots too
    // (css_tree_declares_keyframes). Without one no element of the tree
    // has an animation definition (animationDefinitions).
    treeDeclaresKeyframes(root) {
      return core.status("css_tree_declares_keyframes", document._coreHandle, root._coreHandle) === 1;
    },
    // The document's @page rules in cascade order, each { prelude,
    // declarations, rules }, rules being its margin rules ({ name,
    // declarations }): rules of the active sheets in sheet order, inside
    // matching @media and @supports rules (src/dom/page-rules.js resolves
    // them).
    pageRules() {
      const rules = [];
      for (const { sheet } of this.activeSheets()) {
        for (const rule of core.activeNamedRules(sheet._coreSheetHandle, "page", this.environment)) {
          const margins = [];
          const count = core.status("css_rule_child_count", rule);
          for (let index = 0; index < count; index += 1) {
            const margin = core.handle("css_rule_child_at", rule, index);
            margins.push({ name: core.string("css_rule_name", margin), declarations: core.ruleDeclarations(margin) });
          }
          rules.push({
            prelude: core.string("css_rule_prelude", rule),
            declarations: core.ruleDeclarations(rule),
            rules: margins,
          });
        }
      }
      return rules;
    },
    // The keyframes of the @keyframes rule `name` for an element of scope
    // `scopeRoot`, as CSS Scoping resolves a tree-scoped name: the rule of
    // that scope, else of the scope of its host, and on out to the
    // document's; null without one.
    keyframesFor(name, scopeRoot = document) {
      for (let scope = scopeRoot; scope; scope = scope === document ? null : containingShadowRoot(scope.host) ?? document) {
        const frames = core.keyframes(scope._coreHandle, name, this.environment);
        if (frames) {
          return frames.map(({ offset, declarations }) => {
            const frame = { offset };
            for (const { property, value } of declarations) {
              if (property === "animation-timing-function") frame.easing = parseCSSEasing(value);
              else if (property === "animation-composition") frame.composite = value;
              else frame[cssPropertyToIDLName(property)] = value;
            }
            return frame;
          });
        }
      }
      return null;
    },
    animationDefinitions(element, pseudoElement = null) {
      // The cascade answers the record's font-family requests; the core
      // then lists the record's animations.
      this.cascadedFor(element, pseudoElement);
      const scopeRoot = containingShadowRoot(element) ?? document;
      return animationListDefinitions(element, pseudoElement !== null).flatMap((row, listIndex) => {
        if (row.name === "none") return [];
        const authoredKeyframes = this.keyframesFor(row.name, scopeRoot);
        if (!authoredKeyframes) return [];
        const keyframes = authoredKeyframes.map((frame) => ({
          ...frame,
          easing: frame.easing ?? row.easing,
        }));
        return [{
          name: row.name,
          listIndex,
          keyframes,
          // A keyframe that the rule lacks at 0% or 100% takes the
          // animation's timing function and replaces the underlying value
          // (css-animations-1 section 3).
          implicitKeyframe: { easing: row.easing, composite: "replace" },
          composition: row.composition,
          timing: {
            duration: row.duration,
            delay: row.delay,
            easing: "linear",
            iterations: row.iterations,
            direction: row.direction,
            fill: row.fill,
            timeline: row.timeline,
            rangeStart: row.rangeStart,
            rangeEnd: row.rangeEnd,
          },
          paused: row.playState === "paused",
        }];
      });
    },
    styleSheets() {
      return liveCollection(
        this.activeSheets().filter((entry) =>
          entry.origin === 1 && entry.sheet.ownerNode
        ).map((entry) => entry.sheet),
        "StyleSheetList",
      );
    },
    // The element's computed values without its animation effects: the
    // underlying values of web-animations-1 section 5.3.4. `read(name)`
    // returns the computed text of a property; `release()` gives the view
    // back.
    underlyingComputedValues(element) {
      const core = element._domCore;
      const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
      const handle = core.status(
        "computed_view_get", element._coreHandle,
        ...core.input(""), registry.fontCatalogHandle,
      );
      this.cascadedFor(element, null);
      core.status("computed_view_capture", handle, registry.fontCatalogHandle, 0);
      return {
        read: (name) => core.string("computed_value_text", handle, ...core.input(name), 0n),
        release: () => core.status("computed_view_release", handle),
      };
    },
    // The computed text of property $name (a CSS name) on the element when
    // it declares $keyword, a CSS-wide keyword, above its whole cascade
    // (cascade_offer_override): initial, inherit and unset as for any
    // declaration, revert to the user agent origin, revert-layer to the
    // element's own cascade. The resolution is transient: the element's
    // stored record stays, and the result is captured in a view of its own
    // (KEYWORD_VIEW_KEY), since computed_view_get shares one view per
    // element and pseudo-element key with getComputedStyle.
    keywordComputedValue(element, name, keyword) {
      const core = element._domCore;
      const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
      this.cascadedFor(element, null);
      const parent = core.flatTreeParent(element._coreHandle);
      const handle = core.status(
        "computed_view_get", element._coreHandle,
        ...core.input(KEYWORD_VIEW_KEY), registry.fontCatalogHandle,
      );
      try {
        core.cascadeBegin();
        core.cascadeElementCollect(element._coreHandle, "");
        core.status("cascade_offer_override", ...core.input(cssPropertyToIDLName(name)), ...core.input(String(keyword)));
        core.status("cascade_finish");
        core.computedStyleResolve(element._coreHandle, parent?.nodeType === 1 ? parent._coreHandle : 0n, COMPUTED_RESOLVE_TRANSIENT);
        core.status("computed_view_capture", handle, registry.fontCatalogHandle, 0);
        return core.string("computed_value_text", handle, ...core.input(name), 0n);
      } finally {
        core.status("computed_view_release", handle);
      }
    },
    computedStyle(element, pseudoElement = null) {
      if (!element || element.nodeType !== 1) {
        throw new TypeError("getComputedStyle requires an Element");
      }
      const core = element._domCore;
      const views = coreHandleCache(computedViews, core);
      const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
      // CSSOM getComputedStyle step 4: an argument that does not start with
      // a colon is ignored; one that does names a pseudo-element, and the
      // core gives an empty declaration when it parses as none
      // ($readbackPseudoArgumentInvalid).
      const argument = pseudoElement === null || pseudoElement === undefined ? "" : String(pseudoElement);
      pseudoElement = argument.startsWith(":") ? argument : null;
      const handle = core.status(
        "computed_view_get", element._coreHandle,
        ...core.input(pseudoElement ?? ""), registry.fontCatalogHandle,
      );
      const cached = views.get(handle)?.deref();
      if (cached) {
        core.status("computed_view_release", handle);
        return cached;
      }
      const refresh = () => {
        // A read updates the style: its style change event starts the CSS
        // animations and transitions of the change, whose effects the read
        // includes. Resolve directly into the native field store; no
        // scene-field decode or JavaScript computed serialization is
        // involved in readback.
        const surface = element._renderSurface;
        surface?._startStyleChangeAnimations();
        // An animation of an element that no frame has rendered has no
        // computed sample until a layout writes the element's row: the
        // synchronous layout declares its provisional track and samples it.
        // It resolves other elements, so it runs before this element's
        // resolution, which the capture below takes.
        if (surface?._hasUnrenderedEffects()) withLiveGeometry(surface._root, {}, () => {});
        const styleSystem = element.ownerDocument?._styleSystem ?? this;
        styleSystem.cascadedFor(element, pseudoElement);
        // A value can depend on a query container's size, which only a
        // layout gives: a synchronous layout settles the sizes (it
        // restyles what they change), then the element resolves again.
        if (core.status("element_query_container_dependent", element._coreHandle, pseudoElement ? 1 : 0) === 1) {
          withLiveGeometry(element, {}, () => {});
          styleSystem.cascadedFor(element, pseudoElement);
        }
        const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
        core.status("computed_view_capture", handle, registry.fontCatalogHandle,
          surface?._computedSamples ?? 0);
      };
      const declaration = new ComputedStyleDeclaration(element, handle, refresh);
      views.set(handle, new WeakRef(declaration));
      computedViewFinalizer.register(declaration, { coreReference: new WeakRef(core), handle });
      return declaration;
    },
    // The resource of the @font-face rule `rule`: its load and its error.
    fontResource(rule) {
      return fontResources.get(rule);
    },
    // The active @font-face rules that name a face, in reconciliation order.
    fontRules() {
      return [...fontResources.keys()];
    },
    adopted,
  };
  fontFaceSet = createFontFaceSet({ document, core, fontPending, system, CSSStyleSheet });
  system.fontSet = fontFaceSet;
  userAgentSheet._adopters.add(document);
  return system;
}

// CSSOM, DocumentOrShadowRoot adoptedStyleSheets: an
// ObservableArray<CSSStyleSheet> (WebIDL). Each root has one array, a Proxy
// over its list of adopted sheets: index and length changes check the sheet
// and adopt the new list in place, as an assignment does.
const adoptedStyleSheetArrays = new WeakMap();

function adoptedSheetList(root) {
  return root.nodeType === 9 ? root._styleSystem.adopted : root._adoptedStyleSheets;
}

// WebIDL conversion to CSSStyleSheet. The core accepts only constructed
// sheets of the root's document (scope_adopted_stylesheets_set); a sheet
// of another core instance is of another document.
function adoptableSheet(root, sheet) {
  if (!(sheet instanceof CSSStyleSheet)) {
    throw new TypeError(
      `adoptedStyleSheets holds CSSStyleSheet objects; got ${sheet === null ? "null" : typeof sheet === "object" ? sheet.constructor?.name ?? "an object" : typeof sheet}`,
    );
  }
  if (sheet._domCore !== root._domCore) {
    throw new DOMException(
      "A constructed stylesheet cannot be adopted by a different document",
      "NotAllowedError",
    );
  }
  return sheet;
}

// Makes `next` (checked sheets) the root's adopted sheets.
function adoptSheetList(root, next) {
  root._domCore.setAdoptedStylesheets(
    root._coreHandle,
    next.map((sheet) => sheet._coreSheetHandle),
  );
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  const adoptedSheets = adoptedSheetList(root);
  for (const sheet of adoptedSheets) sheet._adopters.delete(root);
  adoptedSheets.splice(0, adoptedSheets.length, ...next);
  for (const sheet of next) sheet._adopters.add(root);
  document._invalidateStyles();
}

// The array index that `property` names (ECMAScript CanonicalNumericIndexString
// of an array index), or -1.
function arrayIndex(property) {
  if (typeof property !== "string") return -1;
  const index = Number(property);
  return String(index) === property && Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1
    ? index
    : -1;
}

// WebIDL observable array exotic object: the backing list is the target, so
// reads are ordinary array reads; writes go through the indexed value and
// length steps.
function setAdoptedIndex(root, list, index, value) {
  if (index > list.length) return false;
  const next = [...list];
  next[index] = adoptableSheet(root, value);
  adoptSheetList(root, next);
  return true;
}

function setAdoptedLength(root, list, value) {
  const length = value >>> 0;
  if (length !== Number(value)) {
    throw new RangeError(`Invalid adoptedStyleSheets length ${String(value)}`);
  }
  if (length > list.length) return false;
  if (length < list.length) adoptSheetList(root, list.slice(0, length));
  return true;
}

export function adoptedStyleSheets(root) {
  let array = adoptedStyleSheetArrays.get(root);
  if (array) return array;
  const list = adoptedSheetList(root);
  array = new Proxy(list, {
    defineProperty(target, property, descriptor) {
      const index = arrayIndex(property);
      if (property !== "length" && index === -1) return Reflect.defineProperty(target, property, descriptor);
      if (
        "get" in descriptor || "set" in descriptor || descriptor.configurable === false ||
        descriptor.enumerable === false || descriptor.writable === false
      ) {
        return false;
      }
      if (!("value" in descriptor)) return true;
      return property === "length"
        ? setAdoptedLength(root, target, descriptor.value)
        : setAdoptedIndex(root, target, index, descriptor.value);
    },
    deleteProperty(target, property) {
      if (property === "length") return false;
      const index = arrayIndex(property);
      if (index === -1) return Reflect.deleteProperty(target, property);
      if (index >= target.length) return true;
      if (index !== target.length - 1) return false;
      adoptSheetList(root, target.slice(0, index));
      return true;
    },
    set(target, property, value, receiver) {
      if (property === "length") return setAdoptedLength(root, target, value);
      const index = arrayIndex(property);
      if (index === -1) return Reflect.set(target, property, value, receiver);
      return setAdoptedIndex(root, target, index, value);
    },
    preventExtensions() {
      return false;
    },
  });
  adoptedStyleSheetArrays.set(root, array);
  return array;
}

// The adoptedStyleSheets setter: the value converts to
// sequence<CSSStyleSheet>, and each sheet passes the indexed value checks.
export function setAdoptedStyleSheets(root, sheets) {
  const next = [...sheets].map((sheet) => adoptableSheet(root, sheet));
  adoptSheetList(root, next);
}
