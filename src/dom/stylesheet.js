import { parseCSSEasing } from "../dom-wasm/easing.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { createCSSNamespace, readStyleDeclarationText, requireStyleDeclarationWritable } from "./element-mutations.js";
import {
  createCSSStyleSheetClass, installComputedStyleBindings,
  installCSSRuleBindings, installCSSStyleRuleBindings,
  installCSSMediaRuleBindings, installCSSSupportsRuleBindings,
  installCSSFontFaceRuleBindings, installCSSFontFeatureValuesRuleBindings, installCSSKeyframeRuleBindings,
  installCSSKeyframesRuleBindings, installStyleDeclarationBindings, installRuleStyleDeclarationBindings,
} from "./dom-bindings.generated.js";
import {
  cssPropertyToIDLName,
  idlPropertyToCSSName,
  repeatedListValue,
  supportsStyleProperty,
} from "./style.js";
import {
  defaultFontRegistry,
  fontFaceStyleDescriptor,
  registerRuntimeFont,
  unregisterRuntimeFont,
} from "../font-registry.js";
import { decodeWebFont } from "../web-font.js";
import { resolveElementStyle } from "./resolve-style.js";
import { containingShadowRoot, flatTreeParent } from "./shadow.js";
import { withLiveGeometry } from "./live-geometry.js";
import { scheduleFocusFixup } from "./input-activation.js";


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

export const CSS = createCSSNamespace({ supportsCondition });

// An @font-face font-weight descriptor: "auto" (absent, auto or invalid),
// one weight, or a range of two (CSS Fonts 4, 4.4) as [minimum, maximum].
// A decreasing range swaps its ends.
function fontFaceWeightDescriptor(text) {
  const trimmed = String(text ?? "").trim().toLowerCase();
  if (trimmed === "" || trimmed === "auto") return "auto";
  const weights = trimmed.split(/\s+/).map((token) =>
    token === "normal" ? 400 : token === "bold" ? 700 : /^[+]?(\d+\.?\d*|\.\d+)$/.test(token) ? Number(token) : NaN
  );
  if (weights.length > 2 || !weights.every((weight) => weight >= 1 && weight <= 1000)) return "auto";
  if (weights.length === 1) return weights[0];
  return [Math.min(weights[0], weights[1]), Math.max(weights[0], weights[1])];
}

const FONT_STRETCH_KEYWORDS = Object.freeze({
  "ultra-condensed": 50,
  "extra-condensed": 62.5,
  condensed: 75,
  "semi-condensed": 87.5,
  normal: 100,
  "semi-expanded": 112.5,
  expanded: 125,
  "extra-expanded": 150,
  "ultra-expanded": 200,
});

// An @font-face font-stretch descriptor: "auto" (absent, auto or invalid;
// the file's own 'wdth' range instances at the requested stretch), one
// percentage or keyword, or a range of two as [minimum, maximum] (CSS
// Fonts 4, 4.5). A decreasing range swaps its ends.
function fontFaceStretchDescriptor(text) {
  const tokens = String(text ?? "").trim().toLowerCase().split(/\s+/);
  const stretches = tokens.map((token) =>
    Object.hasOwn(FONT_STRETCH_KEYWORDS, token)
      ? FONT_STRETCH_KEYWORDS[token]
      : /^[+]?(\d+\.?\d*|\.\d+)%$/.test(token) ? Number(token.slice(0, -1)) : NaN
  );
  if (stretches.length > 2 || !stretches.every((stretch) => stretch >= 0)) return "auto";
  if (stretches.length === 1) return stretches[0];
  return [Math.min(stretches[0], stretches[1]), Math.max(stretches[0], stretches[1])];
}

function activeNamedRules(rules, name, environment, output = []) {
  for (const rule of rules) {
    if (rule.name === name) output.push(rule);
    else if (rule.name === "media" && mediaMatches(rule.prelude, environment)) {
      activeNamedRules(rule.rules, name, environment, output);
    } else if (rule.name === "supports" && supportsCondition(rule.prelude)) {
      activeNamedRules(rule.rules, name, environment, output);
    }
  }
  return output;
}

// Whether a sheet snapshot holds a @keyframes rule at any depth. The core
// replaces a sheet's snapshot when the sheet changes (insertRule, new
// text), so the answer is kept per snapshot and each sheet is scanned once
// per revision.
const snapshotsDeclaringKeyframes = new WeakMap();
function rulesDeclareKeyframes(rules) {
  return rules.some((rule) =>
    rule.name === "keyframes" || rulesDeclareKeyframes(rule.rules)
  );
}
function snapshotDeclaresKeyframes(snapshot) {
  let declares = snapshotsDeclaringKeyframes.get(snapshot);
  if (declares === undefined) {
    declares = rulesDeclareKeyframes(snapshot.rules);
    snapshotsDeclaringKeyframes.set(snapshot, declares);
  }
  return declares;
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
    });
  }
}

installStyleDeclarationBindings({
  readText: readStyleDeclarationText,
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
  _propertyNames() {
    this._refreshComputed();
    const count = this._domCore.status("computed_view_count", this._coreView);
    return Array.from({ length: count }, (_, index) =>
      this._domCore.string("computed_view_name", this._coreView, index) ?? ""
    );
  }
  _readNormalized(name) {
    this._refreshComputed();
    const core = this._domCore;
    // A read of a layout-dependent property updates layout in Chrome, so it
    // runs the focus check, also when the value needs no geometry.
    if (core.status("computed_value_updates_layout", this._coreView, ...core.input(name))) scheduleFocusFixup(this._element);
    if (core.status("computed_value_needs_geometry", this._coreView, ...core.input(name))) {
      return withLiveGeometry(this._element, undefined, ({ handle }) =>
        core.string("computed_value_text", this._coreView, ...core.input(name), handle) ?? "");
    }
    return core.string("computed_value_text", this._coreView, ...core.input(name), 0n) ?? "";
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
          0,
        ) ?? "",
      () => {
        const count = core.status("css_rule_style_count", handle);
        return Array.from(
          { length: count },
          (_, index) =>
            core.string("css_rule_style_name", handle, index) ?? "",
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
        ) ?? "";
        rule._changed();
        return previous;
      },
      (name) =>
        core.string(
          "css_rule_get_property",
          handle,
          ...core.input(name),
          1,
        ) ?? "",
    );
    this._rule = rule;
    this._domCore = core;
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

export class CSSStyleRule extends CSSRule {
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

export class CSSGroupingRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.conditionText = core.string("css_rule_prelude", handle) ?? "";
    const count = core.status("css_rule_child_count", handle);
    this.cssRules = liveCollection(
      Array.from(
        { length: count },
        (_, index) =>
          ruleObject(
            sheet,
            core.status("css_rule_child_at", handle, index),
            core,
          ),
      ),
      "CSSRuleList",
    );
  }
}

export class CSSMediaRule extends CSSGroupingRule {
}

export class CSSSupportsRule extends CSSGroupingRule {
}

export class CSSFontFaceRule extends CSSRule {
  constructor(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
    super(sheet, handle, core);
    this.style = new RuleStyleDeclaration(this);
  }
}

export class CSSFontFeatureValuesRule extends CSSRule {
}

export class CSSKeyframeRule extends CSSStyleRule {
}

export class CSSKeyframesRule extends CSSGroupingRule {
}

const ruleBindingRuntime = {
  CSSRule,
  setKeyText(rule, text) {
    const core = rule._domCore;
    core.status("css_rule_set_key_text", rule._coreRuleHandle, ...core.input(text));
  },
};
installCSSRuleBindings(ruleBindingRuntime, CSSRule.prototype);
installCSSStyleRuleBindings(ruleBindingRuntime, CSSStyleRule.prototype);
installCSSMediaRuleBindings(ruleBindingRuntime, CSSMediaRule.prototype);
installCSSSupportsRuleBindings(ruleBindingRuntime, CSSSupportsRule.prototype);
installCSSFontFaceRuleBindings(ruleBindingRuntime, CSSFontFaceRule.prototype);
installCSSFontFeatureValuesRuleBindings(ruleBindingRuntime, CSSFontFeatureValuesRule.prototype);
installCSSKeyframeRuleBindings(ruleBindingRuntime, CSSKeyframeRule.prototype);
installCSSKeyframesRuleBindings(ruleBindingRuntime, CSSKeyframesRule.prototype);

function ruleObject(sheet, handle, core = sheet?._domCore ?? sharedDomCore) {
  const existing = coreHandleCache(rulesByHandle, core).get(handle)?.deref();
  if (existing) return existing;
  switch (core.status("css_rule_kind", handle)) {
    case 1:
      return new CSSStyleRule(sheet, handle, core);
    case 4:
      return new CSSMediaRule(sheet, handle, core);
    case 5:
      return new CSSFontFaceRule(sheet, handle, core);
    case 7:
      return new CSSKeyframesRule(sheet, handle, core);
    case 8:
      return new CSSKeyframeRule(sheet, handle, core);
    case 12:
      return new CSSSupportsRule(sheet, handle, core);
    case 14:
      return new CSSFontFeatureValuesRule(sheet, handle, core);
    default:
      return new CSSRule(sheet, handle, core);
  }
}

function parseCoreStylesheet(source, { sourceURL = "about:blank" } = {}) {
  const normalizedSource = String(source);
  const sheetHandle = sharedDomCore.createStylesheet();
  sharedDomCore.parseStylesheet(sheetHandle, normalizedSource);
  try {
    return sharedDomCore.stylesheetSnapshot(
      sheetHandle,
      sourceURL,
      normalizedSource,
    );
  } finally {
    sharedDomCore.disposeStylesheet(sheetHandle);
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
    this._constructionDocument = document;
    this._baseURL = baseURL;
    this._adopters = new Set();
    this._rulesByHandle = new Map();
    this._snapshotRevision = -1;
    this._snapshotValue = null;
    this._cssRules = liveCollection([], "CSSRuleList");
    // The CSSOM origin-clean flag: unset for a sheet from an opaque
    // response. The sheet still applies; a script cannot read or change
    // its rules.
    this._originClean = true;
    if (coreHandle) {
      this._coreSheetHandle = coreHandle;
    } else {
      this._coreSheetHandle = core.createStylesheet();
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
      this._snapshotValue = this._domCore.stylesheetSnapshot(
        this._coreSheetHandle,
        this.href ?? this._baseURL,
        this._domCore.stylesheetSource(this._coreSheetHandle),
      );
      this._rebuild();
    }
    return this._snapshotValue;
  }
  _requireOriginClean(message) {
    if (!this._originClean) throw new DOMException(message, "SecurityError");
  }
  _getRules() {
    this._requireOriginClean("Cannot access rules");
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
      ...this._snapshotValue.rules.map((record) =>
        ruleObject(this, record.handle)
      ),
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
    this._requireOriginClean("Cannot access StyleSheet to insertRule");
    return index === undefined ? this._ruleList().length : index;
  }
  _checkInsertIndex(index) {
    return this._domCore.status(
      "stylesheet_check_index",
      this._coreSheetHandle,
      index,
      1,
    );
  }
  _checkDeleteIndex(index) {
    this._requireOriginClean("Cannot access StyleSheet to deleteRule");
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

// The native cascade's pseudo-element discriminators.
const CASCADE_PSEUDO_KINDS = new Map([
  ["::before", 1],
  ["::after", 2],
  ["::selection", 4],
  ["::placeholder", 5],
]);

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
    system.resolvedFields(element);
    core.cascadeBegin();
    core.cascadeElementCollect(
      element._coreHandle,
      CASCADE_PSEUDO_KINDS.get(pseudoElement) ?? 0,
    );
    core.status("cascade_finish");
    return core.computedStyleResolve(
      element._coreHandle,
      element._coreHandle,
      2,
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
      system.bindRendererFonts();
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
  for (const [property, value] of result.declarations) {
    if (property === "fontFamily") system.recordInheritedFontFamily(value, context.fontFamily);
  }
  return {
    authoredValues: new Map(result.declarations),
    declarations: result.declarations,
    customProperties: result.customProperties,
    context,
  };
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
  const ownedSheets = new Set();
  const resolved = new WeakMap();
  function resolutionFor(system, element) {
    const cached = resolved.get(element);
    if (cached?.generation === system.generation) return cached.value;
    const parent = flatTreeParent(element);
    const parentContext = parent?.nodeType === 1
      ? resolutionFor(system, parent).childContext
      : { customProperties: new Map(), inheritedFields: {} };
    const value = resolveElementStyle(
      element.style,
      parentContext,
    );
    resolved.set(element, { generation: system.generation, value });
    return value;
  }
  const adopted = [];
  const linkedResources = new Map();
  function stylesheetLinkIsEligible(element) {
    const relations = (element.getAttribute("rel") ?? "").toLowerCase().split(
      /\s+/,
    );
    return element.isConnected &&
      relations.includes("stylesheet") &&
      !element.disabled &&
      !element.hasAttribute("disabled") &&
      Boolean(element.getAttribute("href"));
  }

  function dispatchResourceEvent(element, type) {
    queueMicrotask(() => element.dispatchEvent(new Event(type)));
  }
  const fontResources = new Map();
  const fontPending = new Set();
  let fontsReleased = false;
  const fontRuleIDs = new WeakMap();
  let nextFontRuleID = 1;
  function publishFontResource(rule, resource, state) {
    let id = fontRuleIDs.get(rule);
    if (id === undefined) {
      id = nextFontRuleID++;
      fontRuleIDs.set(rule, id);
    }
    resource.catalogID = id;
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

  // Native catalog changes own cache/revision consequences; this only wakes
  // the host scheduler for asynchronous loading and metric completion.
  function fontStateChanged() {
    if (!fontsReleased) {
      document._renderSurface?._broadcastMutation("font", document);
    }
  }

  function releaseFontResource(resource) {
    if (resource.catalogID !== undefined && !fontsReleased) {
      core.status(
        "font_catalog_availability", ensureFontRegistry().fontCatalogHandle,
        document._coreHandle, resource.catalogID, ...core.input(resource.family), -1,
      );
    }
    if (resource.state === "pending") {
      resource.controller.abort(
        new DOMException("Font load became obsolete", "AbortError"),
      );
    }
    // A loaded face, and the declared face of a rule with unicode-range.
    if (resource.familyKey !== undefined) {
      (
        document._sandomFontRegistry?.unregisterRuntimeFont ??
          unregisterRuntimeFont
      )(resource.familyKey, resource);
    }
  }

  // Rewrites each relative URL in a linked sheet's text as an absolute
  // url(), so it resolves against the sheet and not against the document.
  // The core's tokenizer finds the URLs and decodes their escapes. An
  // absolute URL's serialization has no control code point, so escaping
  // `"` and `\` is the whole CSS string serialization it needs.
  function absolutizeResourceURLs(source, baseURL) {
    let absolutized = "";
    let copied = 0;
    for (const { start, end, url } of core.cssURLs(source)) {
      const trimmed = url.trim();
      if (/^(?:data:|blob:|#)/i.test(trimmed)) continue;
      if (trimmed.startsWith("/")) continue;
      const absolute = new URL(trimmed, baseURL).href.replace(/["\\]/g, "\\$&");
      absolutized += `${source.slice(copied, start)}url("${absolute}")`;
      copied = end;
    }
    return absolutized + source.slice(copied);
  }

  async function resolveSheetSource(
    document,
    requestedURL,
    baseURL,
    signal,
    ancestors = [],
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
    });
    if (signal.aborted) throw signal.reason;
    if (!response || typeof response.source !== "string") {
      throw new TypeError(
        "Stylesheet resolver must return { source, finalURL }",
      );
    }
    const finalURL =
      new URL(response.finalURL ?? absoluteURL, absoluteURL).href;
    const parsedSource = parseCoreStylesheet(response.source, {
      sourceURL: finalURL,
    });
    const importedSources = [];
    const importedRanges = [];
    // A sheet is opaque when its response is opaque. Sandom inlines each
    // imported sheet into the importing source, so an opaque import makes
    // the whole flattened sheet opaque: its rules are no longer separable.
    let opaque = response.opaque === true;
    for (const rule of parsedSource.rules) {
      if (rule.name !== "import") continue;
      // The rule's first URL is the one it imports; the media query list
      // follows it.
      const [importedURL] = core.cssURLs(rule.cssText);
      if (!importedURL) continue;
      const media = rule.cssText.slice(importedURL.end).replace(/;\s*$/, "").trim();
      const imported = await resolveSheetSource(
        document,
        importedURL.url,
        finalURL,
        signal,
        [...ancestors, absoluteURL],
      );
      opaque ||= imported.opaque;
      importedSources.push(
        media
          ? `@media ${media} { ${imported.source} }\n`
          : `${imported.source}\n`,
      );
      importedRanges.push([
        rule.location.offset,
        rule.location.endOffset,
      ]);
    }
    let localSource = response.source;
    for (
      const [start, end] of importedRanges.sort((left, right) =>
        right[0] - left[0]
      )
    ) {
      localSource = localSource.slice(0, start) + localSource.slice(end);
    }
    return {
      source: importedSources.join("") +
        absolutizeResourceURLs(localSource, finalURL),
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
      ...environment,
    },
    get generation() {
      ensureFontRegistry();
      return core.styleGeneration(document._coreHandle);
    },
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
      if (changed) this.invalidate();
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
    reconcileResources() {
      const connectedLinks = new Set(
        core.elementsByTagName(document._coreHandle, "link"),
      );
      for (const [element, resource] of linkedResources) {
        if (
          !connectedLinks.has(element) || !stylesheetLinkIsEligible(element)
        ) {
          resource.controller?.abort(
            new DOMException("Stylesheet load became obsolete", "AbortError"),
          );
          linkedResources.delete(element);
          element._stylesheetState = "inactive";
        }
      }
      for (const element of connectedLinks) {
        if (!stylesheetLinkIsEligible(element)) {
          element._stylesheetState = "inactive";
          continue;
        }
        const href = element.getAttribute("href");
        const unresolvedSignature = `${href}\n${document.baseURI}`;
        let requestedURL;
        try {
          requestedURL = new URL(href, document.baseURI).href;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          if (element._stylesheetFailedHref !== unresolvedSignature) {
            element._stylesheetFailedHref = unresolvedSignature;
            element._stylesheetState = "failed";
            dispatchResourceEvent(element, "error");
          }
          continue;
        }
        element._stylesheetFailedHref = null;
        const signature = `${requestedURL}\n${document.baseURI}`;
        const previous = linkedResources.get(element);
        if (previous?.signature === signature) continue;
        previous?.controller.abort(
          new DOMException("Stylesheet load became obsolete", "AbortError"),
        );
        const controller = new AbortController();
        const resource = {
          signature,
          controller,
          state: "pending",
          sheet: null,
          error: null,
        };
        linkedResources.set(element, resource);
        element._stylesheetState = "pending";
        resource.pending = resolveSheetSource(
          document,
          href,
          document.baseURI,
          controller.signal,
        ).then(({ source, finalURL, opaque }) => {
          if (
            controller.signal.aborted ||
            linkedResources.get(element) !== resource
          ) return;
          const sheet = new CSSStyleSheet({
            baseURL: finalURL,
            ownerNode: element,
          });
          sheet.href = finalURL;
          sheet._originClean = !opaque;
          sheet._setSource(source);
          sheet.media = element.getAttribute("media") ?? "";
          sheet._adopters.add(document);
          ownedSheets.add(sheet);
          sheet._syncOwnerConnection();
          resource.sheet = sheet;
          resource.state = "loaded";
          element._stylesheetState = "loaded";
          this.invalidate();
          dispatchResourceEvent(element, "load");
        }).catch((error) => {
          if (
            controller.signal.aborted ||
            linkedResources.get(element) !== resource
          ) return;
          resource.error = error;
          resource.state = "failed";
          element._stylesheetState = "failed";
          this.invalidate();
          dispatchResourceEvent(element, "error");
        });
      }
    },
    reconcileFonts() {
      if (fontsReleased) return;
      const activeFontRules = new Set();
      for (const { sheet } of this.activeSheets()) {
        for (
          const rule of activeNamedRules(
            sheet._snapshot.rules,
            "font-face",
            this.environment,
          )
        ) {
          activeFontRules.add(rule);
          const declarations = new Map(
            rule.declarations.map((declaration) => [
              declaration.property.toLowerCase(),
              declaration.value,
            ]),
          );
          const familySource = declarations.get("font-family");
          const family = familySource === undefined ? undefined : core.string(
            "font_family_normalize", ...core.input(familySource), 0,
          );
          // The first url() of the src descriptor is the face's source.
          const [sourceToken] = core.cssURLs(declarations.get("src") ?? "");
          if (!family || !sourceToken) continue;
          const authoredURL = sourceToken.url;
          const baseURL = sheet.href ?? sheet._baseURL;
          const weight = fontFaceWeightDescriptor(declarations.get("font-weight"));
          const stretch = fontFaceStretchDescriptor(declarations.get("font-stretch"));
          // An absent or invalid font-style descriptor is auto.
          const styleText = declarations.get("font-style");
          const style = fontFaceStyleDescriptor(styleText) === null ? "auto" : styleText;
          // A rule already resolved (loaded, pending or failed) is not
          // re-published: publishing bumps the style generation, and a
          // failed url() re-failed on every reconcile kept every frame of
          // the document live.
          if (fontResources.has(rule)) continue;
          let requestedURL;
          try {
            requestedURL = new URL(authoredURL, baseURL).href;
          } catch (error) {
            fontResources.set(rule, {
              state: "failed",
              error,
              family,
              requestedURL: authoredURL,
              finalURL: null,
            });
            publishFontResource(rule, fontResources.get(rule), 2);
            continue;
          }

          // A rule with a valid unicode-range descriptor stays unloaded
          // until a shaped text needs a scalar of its range
          // (design/text-rendering.md, "unicode-range faces", item 3); Chrome ignores
          // an invalid descriptor, and the rule then loads at once with
          // the range U+0-10FFFF, as a rule without the descriptor does.
          const rangeText = declarations.get("unicode-range");
          const unicodeRange = rangeText === undefined ? null : core.fontUnicodeRanges(rangeText);
          const controller = new AbortController();
          const resource = {
            state: unicodeRange === null ? "pending" : "unloaded",
            controller,
            family,
            requestedURL,
            finalURL: null,
          };
          // Starts the load of the rule. The promise settles after the face
          // registers, or rejects with the cause of a failed load.
          const load = () => {
            resource.state = "pending";
            const pending = Promise.resolve(document._resolveResource({
              requestedURL,
              authoredURL,
              baseURL,
              kind: "font",
              signal: controller.signal,
            })).then(async (response) => {
              if (
                controller.signal.aborted || fontResources.get(rule) !== resource
              ) {
                return;
              }
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
              if (
                controller.signal.aborted || fontResources.get(rule) !== resource
              ) {
                return;
              }
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
              Object.assign(resource, {
                state: "loaded",
                familyKey,
                finalURL,
              });
              publishFontResource(rule, resource, 1);
              fontStateChanged();
            }).catch((error) => {
              if (
                controller.signal.aborted || fontResources.get(rule) !== resource
              ) {
                return;
              }
              Object.assign(resource, { state: "failed", error });
              // The declared face of a rule with unicode-range leaves the
              // font stack, so no frame requests it again.
              if (resource.familyKey !== undefined) {
                (
                  document._sandomFontRegistry?.unregisterRuntimeFont ??
                    unregisterRuntimeFont
                )(resource.familyKey, resource);
                delete resource.familyKey;
              }
              publishFontResource(rule, resource, 2);
              fontStateChanged();
            }).finally(() => {
              fontPending.delete(pending);
            });
            fontPending.add(pending);
            pending.then(() => this.invalidate());
            return pending.then(() => {
              if (resource.state === "failed") throw resource.error;
              if (resource.state !== "loaded") {
                throw new DOMException(`The font rule of ${requestedURL} became obsolete while it loaded`, "AbortError");
              }
            });
          };
          fontResources.set(rule, resource);
          publishFontResource(rule, resource, 0);
          if (unicodeRange === null) {
            // The resource records a failed load (resourceDiagnostics).
            load().catch(() => {});
          } else {
            let loading = null;
            resource.familyKey = ensureFontRegistry().declareRuntimeFont(family, {
              weight,
              stretch,
              style,
              unicodeRange,
              owner: resource,
              load: () => loading ??= load(),
              document,
            });
          }
        }
      }
      for (const [rule, resource] of fontResources) {
        if (activeFontRules.has(rule)) continue;
        releaseFontResource(resource);
        fontResources.delete(rule);
        fontStateChanged();
      }
    },
    releaseFonts() {
      if (fontsReleased) return;
      fontsReleased = true;
      unsubscribeFontRegistry?.();
      unsubscribeFontRegistry = null;
      selectedFontRegistry?.unbindDocument(document);
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
    bindRendererFonts() {
      (document._sandomFontRegistry ?? defaultFontRegistry).prepareNativeFontPublication(document);
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
      for (const resource of fontResources.values()) {
        if (resource.state === "failed") return;
      }
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
        [...fontResources.values()]
          .filter((resource) => resource.state === "failed")
          .map((resource) => {
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
      await Promise.all(
        [...linkedResources.values()]
          .map((resource) => resource.pending)
          .filter(Boolean),
      );
    },
    hasLoadingLinkedSheets() {
      this._reconcileOwed = true;
      this.reconcile();
      for (const resource of linkedResources.values()) {
        if (resource.state === "pending") return true;
      }
      return false;
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
      await Promise.all(
        [...linkedResources.values()]
          .map((resource) => resource.pending)
          .filter(Boolean),
      );
      const stylesheetErrors = [...linkedResources.values()]
        .filter((resource) => resource.state === "failed")
        .map((resource) => resource.error);
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
      // Every document wraps the core's shared user-agent sheet itself.
      return core.activeStylesheets(scopeRoot._coreHandle).map((handle) =>
        handle === userAgentSheet._coreSheetHandle
          ? { sheet: userAgentSheet, origin: 0 }
          : { sheet: wrapSheet(core, handle), origin: 1 }
      );
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
    // Whether an active sheet of the element's scope holds a @keyframes
    // rule. Without one, keyframesFor finds nothing in that scope, so no
    // element of it has an animation definition (animationDefinitions).
    declaresKeyframes(element) {
      const scopeRoot = containingShadowRoot(element) ?? document;
      return this.activeSheets(scopeRoot).some(({ sheet }) =>
        snapshotDeclaresKeyframes(sheet._snapshot)
      );
    },
    // The document's @page rules in cascade order, each { prelude,
    // declarations, rules }, rules being its margin rules ({ name,
    // declarations }): rules of the active sheets in sheet order, inside
    // matching @media and @supports rules (src/dom/page-rules.js resolves
    // them).
    pageRules() {
      const rules = [];
      for (const { sheet } of this.activeSheets()) {
        for (const rule of activeNamedRules(sheet._snapshot.rules, "page", this.environment)) {
          rules.push({
            prelude: rule.prelude,
            declarations: rule.declarations,
            rules: (rule.rules ?? []).map(({ name, declarations }) => ({ name, declarations })),
          });
        }
      }
      return rules;
    },
    keyframesFor(name, scopeRoot = document) {
      let matching = null;
      for (const { sheet } of this.activeSheets(scopeRoot)) {
        for (
          const rule of activeNamedRules(
            sheet._snapshot.rules,
            "keyframes",
            this.environment,
          )
        ) {
          if (rule.prelude === name) matching = rule;
        }
      }
      if (!matching) return null;
      const byOffset = new Map();
      for (const frameRule of matching.rules) {
        for (const selector of frameRule.selectorText.split(",")) {
          const normalized = selector.trim().toLowerCase();
          const offset = normalized === "from"
            ? 0
            : normalized === "to"
            ? 1
            : Number.parseFloat(normalized) / 100;
          if (!Number.isFinite(offset) || offset < 0 || offset > 1) continue;
          const frame = byOffset.get(offset) ?? { offset };
          for (const declaration of frameRule.declarations) {
            if (declaration.property === "animation-timing-function") {
              frame.easing = parseCSSEasing(declaration.value);
            } else {
              frame[cssPropertyToIDLName(declaration.property)] =
                declaration.value;
            }
          }
          byOffset.set(offset, frame);
        }
      }
      return [...byOffset.values()].sort((left, right) =>
        left.offset - right.offset
      );
    },
    animationDefinitions(element, pseudoElement = null) {
      // resolutionFor memoizes per element per generation and reuses the
      // parent's cached childContext - the same resolution serialization
      // consumes. The old inline recursion re-resolved the whole ancestor
      // chain uncached on every call, which made the per-frame
      // animation-definition scan quadratic in tree depth.
      const elementResolution = resolutionFor(this, element);
      const { fields } = pseudoElement === null
        ? elementResolution
        : resolveElementStyle(
          element.style,
          elementResolution.childContext,
          pseudoElement,
        );
      const names = fields.animationName ?? ["none"];
      const compositions = fields.animationComposition ?? ["replace"];
      const durations = fields.animationDuration ?? [0];
      const delays = fields.animationDelay ?? [0];
      const timingFunctions = fields.animationTimingFunction ?? ["ease"];
      const iterationCounts = fields.animationIterationCount ?? [1];
      const directions = fields.animationDirection ?? ["normal"];
      const fillModes = fields.animationFillMode ?? ["none"];
      const playStates = fields.animationPlayState ?? ["running"];
      const timelines = fields.animationTimeline ?? ["auto"];
      const rangeStarts = fields.animationRangeStart ?? ["normal"];
      const rangeEnds = fields.animationRangeEnd ?? ["normal"];
      const scopeRoot = containingShadowRoot(element) ?? document;
      return names.flatMap((name, listIndex) => {
        if (name === "none") return [];
        const authoredKeyframes = this.keyframesFor(name, scopeRoot);
        if (!authoredKeyframes) return [];
        const defaultEasing = repeatedListValue(timingFunctions, listIndex);
        const keyframes = authoredKeyframes.map((frame) => ({
          ...frame,
          easing: frame.easing ?? defaultEasing,
        }));
        return [{
          name,
          listIndex,
          keyframes,
          // A keyframe that the rule lacks at 0% or 100% takes the
          // animation's timing function and replaces the underlying value
          // (css-animations-1 section 3).
          implicitKeyframe: { easing: defaultEasing, composite: "replace" },
          composition: repeatedListValue(compositions, listIndex),
          timing: {
            duration: repeatedListValue(durations, listIndex),
            delay: repeatedListValue(delays, listIndex),
            easing: "linear",
            iterations: repeatedListValue(iterationCounts, listIndex),
            direction: repeatedListValue(directions, listIndex),
            fill: repeatedListValue(fillModes, listIndex),
            timeline: repeatedListValue(timelines, listIndex),
            rangeStart: repeatedListValue(rangeStarts, listIndex),
            rangeEnd: repeatedListValue(rangeEnds, listIndex),
          },
          paused: repeatedListValue(playStates, listIndex) === "paused",
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
    resolvedFields(element) {
      if (!element || element.nodeType !== 1) {
        throw new TypeError("resolvedFields requires an Element");
      }
      return resolutionFor(this, element).fields;
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
        read: (name) => core.string("computed_value_text", handle, ...core.input(name), 0n) ?? "",
        release: () => core.status("computed_view_release", handle),
      };
    },
    computedStyle(element, pseudoElement = null) {
      if (!element || element.nodeType !== 1) {
        throw new TypeError("getComputedStyle requires an Element");
      }
      const core = element._domCore;
      const views = coreHandleCache(computedViews, core);
      const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
      const handle = core.status(
        "computed_view_get", element._coreHandle,
        ...core.input(String(pseudoElement ?? "")), registry.fontCatalogHandle,
      );
      const cached = views.get(handle)?.deref();
      if (cached) {
        core.status("computed_view_release", handle);
        return cached;
      }
      const refresh = () => {
        // Resolve directly into the native field store; no scene-field decode
        // or JavaScript computed serialization is involved in readback.
        (element.ownerDocument?._styleSystem ?? this).cascadedFor(element, pseudoElement);
        const registry = element.ownerDocument?._sandomFontRegistry ?? defaultFontRegistry;
        core.status("computed_view_capture", handle, registry.fontCatalogHandle,
          element._renderSurface?._computedSamples ?? 0);
      };
      const declaration = new ComputedStyleDeclaration(element, handle, refresh);
      views.set(handle, new WeakRef(declaration));
      computedViewFinalizer.register(declaration, { coreReference: new WeakRef(core), handle });
      return declaration;
    },
    fontSet: {
      get status() {
        return fontPending.size ? "loading" : "loaded";
      },
      get ready() {
        return Promise.all([...fontPending]).then(() => this);
      },
      check() {
        return fontPending.size === 0;
      },
      load() {
        return this.ready.then(() => []);
      },
    },
    adopted,
  };
  userAgentSheet._adopters.add(document);
  return system;
}

export function setAdoptedStyleSheets(root, sheets) {
  const next = [...sheets];
  if (
    next.some((sheet) => !(sheet instanceof CSSStyleSheet) || sheet.ownerNode)
  ) {
    throw new DOMException(
      "Only constructible stylesheets may be adopted",
      "NotAllowedError",
    );
  }
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  for (const sheet of next) {
    if (
      sheet._domCore !== document._domCore ||
      sheet._constructionDocument &&
      sheet._constructionDocument !== document
    ) {
      throw new DOMException(
        "A constructed stylesheet cannot be adopted by a different document",
        "NotAllowedError",
      );
    }
  }
  root._domCore.setAdoptedStylesheets(
    root._coreHandle,
    next.map((sheet) => sheet._coreSheetHandle),
  );
  for (const sheet of next) sheet._constructionDocument = document;
  const adoptedSheets = root.nodeType === 9
    ? root._styleSystem.adopted
    : root._adoptedStyleSheets;
  for (const sheet of adoptedSheets) sheet._adopters.delete(root);
  adoptedSheets.splice(0, adoptedSheets.length, ...next);
  for (const sheet of next) sheet._adopters.add(root);
  document._invalidateStyles();
}

export function cssSupports(property, value) {
  if (arguments.length === 1) return supportsCondition(property);
  return supportsStyleProperty(property) && String(value).trim() !== "";
}
