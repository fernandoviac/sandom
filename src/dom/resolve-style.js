import { sharedDomCore } from "../dom-wasm/core.js";
import { parseCSSEasing } from "../dom-wasm/easing.js";
import { droppedDeclarations } from "./style.js";

export const DOCUMENT_INITIAL_FONT_SIZE = 16;

// One dropped declaration answers one of two different questions, and the
// cascade's drop list does not say which.
//
// 1. The author wrote a value CSS calls invalid. Dropping it is required
//    (CSS Cascade 4 §4.2): the declaration is ignored and the rest of the
//    rule stands. It must stay silent - a real stylesheet drops dozens.
// 2. The engine failed to apply a value it claims to support. That is an
//    internal defect, and dropping it turns a defect into missing paint
//    with no diagnostic anywhere.
//
// The engine answers the first question itself, twice, and the ABI keeps
// the author-value rejection distinguishable from a native fault at both
// (`0` with `abi_error_kind` zero against a nonzero kind, which throws):
//
// - `specified_value_text` is the verdict `style.setProperty` accepts or
//   rejects a declaration with (style-mutations.watpart), the path that
//   already raises `unsupported value "..."` for what it cannot take.
// - `field_declaration_parse` is the parse `@supports` is decided with
//   (cascade-assembly.watpart `$supportsDeclaration`); a rejected value is
//   a single kind-1 dropped slot.
//
// Neither alone is the claim: specified validation defers anything holding
// `var()`, `calc()` or a font-relative unit, and the standalone parse has
// no color kernel or record context. A value BOTH accept, dropped by the
// record's apply path anyway, is the engine contradicting its own published
// support.
//
// `inherit` is neither question: it is never an invalid value, and reaches
// the field record as text for the store's inherit step, where a drop means
// the parent had no entry to copy - the correct computed result.
function engineAppliesValue(property, value) {
  if (String(value).trim().toLowerCase() === "inherit") return false;
  if (!sharedDomCore.specifiedValueAccepted(property, value)) return false;
  const slots = sharedDomCore.declarationSlots(property, value);
  if (slots === null) return false;
  return slots.length > 0 && slots[0].kind !== 1;
}

export function resolveElementStyle(
  style,
  parentContext = {},
  pseudoElement = null,
) {
  const element = style._element;
  const core = element?._domCore ?? sharedDomCore;
  const styleSystem = element?.ownerDocument?._styleSystem;
  // The core owns the computed stage and the field store: cascade winners
  // resolve against the flat-tree parent's record (custom properties, var()
  // substitution, CSS-wide keywords, the element context), the field record
  // applies over the parent's inherited fields. The binding decodes only
  // the scene transport bag; computed CSS text reads the native store.
  const cascaded = styleSystem?.cascadedFor(element, pseudoElement) ?? {
    declarations: [],
    customProperties: new Map(),
    context: null,
  };
  const customProperties = cascaded.customProperties;
  const context = cascaded.context;
  const inheritedFields = context === null
    ? { ...(parentContext.inheritedFields ?? {}) }
    : {};
  // Declarations the binding itself rejected on an author value, which the
  // store's own drop list cannot know about.
  const rejected = [];
  const fields = context === null
    ? { ...inheritedFields }
    : core.fieldStore(parseCSSEasing, inheritedFields, rejected);
  if (context === null) {
    // A host-only parent transport bag has no element record to resolve.
    fields.fontSize = inheritedFields.fontSize = parentContext.inheritedFields?.fontSize ??
      DOCUMENT_INITIAL_FONT_SIZE;
  } else {
    const declarations = cascaded.declarations ?? [];
    const drop = (index) => {
      const [property, value] = declarations[index];
      droppedDeclarations.add(`${property}: ${value}`);
    };
    for (const index of rejected) drop(index);
    for (const index of core.fieldStoreDropped()) {
      const [property, value] = declarations[index];
      if (engineAppliesValue(property, value)) {
        // The engine contradicted itself: its own declaration grammar
        // parses this value, and the apply path dropped it anyway. That is
        // an internal defect, and the one thing a drop must never be is
        // silent - a swallowed splitting bug shipped as missing paint once
        // already (BUG-style-resolution-swallows-internal-errors, resolved;
        // see activity/reports/REPORT-2026-10-09-resolved-bug-records.md).
        throw new Error(
          `style.${property}: the cascade dropped "${value}", a value the engine parses`,
        );
      }
      drop(index);
    }
  }
  return {
    fields,
    declarations: cascaded.declarations ?? [],
    childContext: {
      customProperties,
      animationComposition: fields.animationComposition ?? ["replace"],
      rootFontSize: parentContext.rootFontSize ?? fields.fontSize,
      inheritedFields,
    },
  };
}
