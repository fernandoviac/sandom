import { domCoreForWrapper, sharedDomCore } from "../dom-wasm/core.js";
import { scheduleFocusFixup } from "./input-activation.js";
import {
  createCSSBindings,
  createDOMImplementationBinding,
  installDocumentConstructionBindings,
  installElementMarkupBindings,
  installInnerTextBindings,
  installOuterTextBindings,
  installFragmentMarkupBindings,
  installScriptBindings,
  installShadowMarkupBindings,
} from "./dom-bindings.generated.js";

// Numeric property operands in the native immutable markup stage records.
// This is language spelling/identity transport, not a mutation decision table.
const properties = [
  "firstChild", "removeChild", "appendChild", "ownerDocument", "createTextNode",
  "textContent", "localName", "content", "_xmlDocument", "parentNode", "nodeType",
  "parentElement", "createElement", "insertBefore", "nextSibling", "host",
  "_domCore", "_coreHandle", "toLowerCase", "parseHTMLFragment", "parseXMLFragment",
  "serializeHTMLNode", "serializeXMLNode", "serializeHTMLNodeContents",
  "serializeXMLNodeContents", "SDTextNode", "SDElement",
  "customElements", "_construct", "_createUncustomizedElement", "is", "append",
  "SDDocument", "html", "head", "title",
  "getAttribute", "src", "baseURI", "about:blank", "href",
  "supportsCondition", "(", ": ", ")", "length", "charCodeAt", "toString",
  "\uFFFD", "\\", " ", "\\-",
  "_names", "map", "join", "getPropertyPriority", "getPropertyValue",
  " !important", ";",
  "querySelector", "base[href]", "URL",
  "_assertMutationAllowed", "indexOf", ":", "slice", "withCustomElementReactions",
  "_setParsedAttribute", "_notifyMutation", "class", "attribute",
  "renderedText", "setOuterText",
  "_createPublicElement", "namespaceURI",
];
const exceptionNames = { 3: "SyntaxError", 19: "NoModificationAllowedError" };

// Escaping callbacks retain only their language runtime, lexical owner and
// native callback mode, never the outer invocation or its register storage.
function createStageCallback(language, owner, mode) {
  return (argument) => language.execute(owner, mode, argument);
}

function createCapturedStageCallback(language, owner, mode, captured) {
  return () => language.execute(owner, mode, undefined, undefined, undefined, captured);
}

function createMarkupLanguage(runtime) {
  const runtimes = new WeakMap();
  const language = {
    execute(receiver, mode, first, second, third, captured) {
      // WeakMap lookup adds no observable property reads before the first
      // native-requested action. Borrowed methods retain their duck typing.
      const core = domCoreForWrapper(receiver) ?? sharedDomCore;
      let ownerRuntime = runtimes.get(core);
      if (!ownerRuntime) {
        ownerRuntime = { ...runtime };
        if (runtime.SDDocument) {
          ownerRuntime.SDDocument = class extends runtime.SDDocument {
            constructor(options = {}) {
              super({ ...options, core });
            }
          };
        }
        if (runtime.withCustomElementReactions) {
          ownerRuntime.withCustomElementReactions = (operation) =>
            runtime.withCustomElementReactions(operation, core);
        }
        runtimes.set(core, ownerRuntime);
      }
      const invocation = core.handle("markup_begin", mode);
      const registers = [receiver, first, second, undefined, null, "", "body", ownerRuntime];
      registers[20] = third;
      registers[21] = captured;
      let returned;
      let failed = false;
      try {
        for (;;) {
          const token = core.handle("markup_next", invocation);
          if (token === 0n) return returned;
          const pointer = core.status("markup_stage", invocation);
          const bytes = core.refreshBytes();
          // Snapshot every instruction operand before an observable action:
          // getters/callees may recursively invoke markup and grow memory.
          const op = bytes[pointer];
          const destination = bytes[pointer + 1];
          const a = bytes[pointer + 2];
          const b = bytes[pointer + 3];
          const c = bytes[pointer + 4];
          const d = bytes[pointer + 5];
          const e = bytes[pointer + 6];
          const test = bytes[pointer + 7];
          let value;
          try {
            switch (op) {
              case 1:
                value = registers[a][properties[b]];
                break;
              case 2:
                value = registers[a]?.[properties[b]];
                break;
              case 3:
                value = registers[a];
                break;
              case 4:
                value = String(registers[a]);
                break;
              case 6:
                value = Reflect.apply(registers[a], registers[b], []);
                break;
              case 7:
                value = Reflect.apply(registers[a], registers[b], [registers[c]]);
                break;
              case 8:
                value = Reflect.apply(registers[a], registers[b], [registers[c], registers[d]]);
                break;
              case 9:
                value = Reflect.construct(registers[a], [registers[c]]);
                break;
              case 10:
                registers[a][properties[b]] = registers[c];
                break;
              case 11:
                value = registers[a] instanceof registers[b];
                break;
              case 12:
                returned = registers[a];
                break;
              case 13: {
                const messagePointer = (bytes[pointer + 8] | (bytes[pointer + 9] << 8) |
                  (bytes[pointer + 10] << 16) | (bytes[pointer + 11] << 24)) >>> 0;
                const message = core.decoder.decode(bytes.subarray(messagePointer, messagePointer + c + (d << 8)));
                if (destination === 1) throw new TypeError(message);
                throw new DOMException(message, exceptionNames[destination]);
              }
              case 14:
                value = Reflect.apply(registers[a], registers[b], [registers[c], registers[d], registers[e]]);
                break;
              case 15:
                value = { [properties[b]]: registers[a] };
                break;
              case 16:
                value = properties[a];
                break;
              case 18:
                value = URL;
                break;
              case 19:
                value = Reflect.construct(registers[a], [registers[c], registers[d]]);
                break;
              case 20:
                value = core.status("markup_index", invocation);
                break;
              case 22:
                value = registers[a] >= b;
                break;
              case 23:
                value = registers[a] <= b;
                break;
              case 24:
                value = registers[a] < registers[b];
                break;
              case 25:
                value = registers[a] + registers[b];
                break;
              case 26:
                value = `${registers[a]}`;
                break;
              case 28:
                value = a;
                break;
              case 29:
                value = registers[a][registers[b]];
                break;
              case 30:
                value = createStageCallback(language, registers[a], b);
                break;
              case 31:
                value = [registers[a], registers[b], registers[c], registers[d], registers[e]];
                break;
              case 32:
                value = createCapturedStageCallback(language, registers[a], b, registers[c]);
                break;
              case 33:
                value = registers[a][b];
                break;
              case 34:
                value = Reflect.apply(registers[a], registers[b], registers[c]);
                break;
              case 35:
                value = [registers[a], registers[b], registers[c], registers[d]];
                break;
              case 36:
                // Language record construction preserves own data properties
                // and the two public result getters in their original order.
                value = {
                  type: "attributes",
                  target: registers[a],
                  attributeName: registers[b],
                  attributeNamespace: registers[c],
                  oldValue: registers[d].oldValue,
                  observers: registers[d].observers,
                };
                break;
              default:
                throw new TypeError("Unknown native markup action");
            }
          } catch (error) {
            let handled;
            try {
              handled = core.status("markup_throw", invocation, token);
            } catch {
              throw error;
            }
            if (!handled) throw error;
            // Native catch policy chooses the next stage. Do not overwrite
            // registers with a failed result or acknowledge this token twice.
            continue;
          }
          // Register3 is the immutable undefined/discard register. In particular,
          // overridden mutation methods may return arbitrary language objects.
          if (destination !== 3) registers[destination] = value;
          const flags = (value ? 1 : 0) |
            (value === null || value === undefined ? 2 : 0) |
            (typeof value === "number" ? 4 : 0) |
            (typeof value === "string" ? 8 : 0) |
            (value === null ? 16 : 0) |
            (value === undefined ? 32 : 0);
          // Only native strict-string tests need byte transport. Encoding occurs
          // immediately before ack, so no intermediate operation rotates it.
          let textPointer = 0;
          let textLength = 0;
          if ((test === 3 || (test >= 5 && test <= 8) || test === 10 || test === 14) &&
            typeof value === "string") {
            [textPointer, textLength] = core.input(value);
          }
          core.status("markup_ack", invocation, token, flags,
            typeof value === "number" ? value : 0, textPointer, textLength);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // A pending action is abandoned, never repeated. Preserve the original
        // abrupt completion even if a hostile callback invalidated the handle.
        if (failed) {
          try {
            core.status("markup_release", invocation);
          } catch {
            // The language exception wins over an already-invalid lifetime.
          }
        } else {
          core.status("markup_release", invocation);
        }
      }
    },
  };
  return language;
}

const declarationLanguage = createMarkupLanguage({});

export function readStyleDeclarationText(declaration) {
  return declarationLanguage.execute(declaration, 19);
}

export function requireStyleDeclarationWritable(flag) {
  return sharedDomCore.status("style_declaration_guard", flag ? 1 : 0);
}

export function createCSSNamespace(runtime) {
  return Object.freeze(createCSSBindings(createMarkupLanguage(runtime)));
}

// The innerText and outerText getters (HTML): an element that is not being
// rendered gives its descendant text; otherwise the rendered text
// collection steps. The rendering state comes from the core
// (element_rendered_state: bit 1 no box, 2 skipped contents, 4 visibility
// not visible, 8 display: contents); the CSS values from computed style.
const BLOCK_LEVEL_DISPLAYS = new Set(["block", "flow-root", "flex", "grid", "table", "list-item", "table-caption"]);
function renderedState(element) {
  return element._domCore.status("element_rendered_state", element._coreHandle);
}
// innerText and outerText update layout in Chrome, so they run the focus
// check (scheduleFocusFixup).
function renderedText(element) {
  scheduleFocusFixup(element);
  if (renderedState(element) & 3) return element.textContent;
  const items = [];
  for (const child of element.childNodes) collectRenderedText(child, items);
  return joinRenderedText(items);
}
// One node's items: strings, as { text, collapsible }, and required line
// break counts, as numbers.
function collectRenderedText(node, items) {
  if (node.nodeType === 3) {
    const parent = node.parentElement;
    // A text node renders only in a parent that has a box, is visible and
    // does not skip its contents.
    if (parent === null || (renderedState(parent) & 23)) return;
    const style = parent.ownerDocument.getComputedStyle(parent);
    const whiteSpace = style.getPropertyValue("white-space");
    let text = node.data;
    const collapsible = whiteSpace === "normal" || whiteSpace === "nowrap" || whiteSpace === "pre-line" || whiteSpace === "";
    if (whiteSpace === "pre-line") text = text.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t\r\f]+/g, " ");
    else if (collapsible) text = text.replace(/[ \t\n\r\f]+/g, " ");
    const transform = style.getPropertyValue("text-transform");
    if (transform === "uppercase") text = text.toUpperCase();
    else if (transform === "lowercase") text = text.toLowerCase();
    else if (transform === "capitalize") text = text.replace(/(^|\s)(\S)/g, (_, space, letter) => space + letter.toUpperCase());
    items.push({ text, collapsible });
    return;
  }
  if (node.nodeType !== 1) return;
  const state = renderedState(node);
  if (state & 3) return;
  const children = [];
  for (const child of node.childNodes) collectRenderedText(child, children);
  if ((state & 4) || (state & 8)) {
    items.push(...children);
    return;
  }
  const style = node.ownerDocument.getComputedStyle(node);
  const display = style.getPropertyValue("display");
  if (node.localName === "br") {
    items.push({ text: "\n", collapsible: false });
    return;
  }
  const nextBox = (wanted) => {
    for (let sibling = node.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
      if (!(renderedState(sibling) & 3) && node.ownerDocument.getComputedStyle(sibling).getPropertyValue("display") === wanted) return true;
    }
    return false;
  };
  if (display === "table-cell" && nextBox("table-cell")) children.push({ text: "\t", collapsible: false });
  if (display === "table-row" && nextBox("table-row")) children.push({ text: "\n", collapsible: false });
  const breaks = node.localName === "p" ? 2 : BLOCK_LEVEL_DISPLAYS.has(display) ? 1 : 0;
  if (breaks) items.push(breaks, ...children, breaks);
  else items.push(...children);
}
// CSS white space processing across the items, then the required line
// breaks: a collapsible space after a space or at the start of a block
// goes, and so does one at the end of a block.
function joinRenderedText(items) {
  let blockStart = true;
  let afterSpace = false;
  for (const item of items) {
    if (typeof item === "number") {
      blockStart = true;
      afterSpace = false;
      continue;
    }
    if (item.collapsible && item.text.startsWith(" ") && (blockStart || afterSpace)) item.text = item.text.slice(1);
    if (item.text === "") continue;
    blockStart = false;
    afterSpace = item.collapsible && item.text.endsWith(" ");
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (typeof item === "number" || !item.collapsible || !item.text.endsWith(" ")) continue;
    let next = index + 1;
    while (next < items.length && typeof items[next] !== "number" && items[next].text === "") next++;
    if (next === items.length || typeof items[next] === "number") item.text = item.text.slice(0, -1);
  }
  let text = "";
  let pendingBreaks = 0;
  for (const item of items) {
    if (typeof item === "number") {
      if (text !== "") pendingBreaks = Math.max(pendingBreaks, item);
      continue;
    }
    if (item.text === "") continue;
    text += "\n".repeat(pendingBreaks) + item.text;
    pendingBreaks = 0;
  }
  return text;
}

// The outerText setter (HTML): the element is replaced by the rendered
// text fragment of the value, which merges with adjacent text.
function setOuterText(element, value) {
  const parent = element.parentNode;
  if (parent === null) throw new DOMException("outerText: the element has no parent", "NoModificationAllowedError");
  const document = element.ownerDocument;
  const next = element.nextSibling;
  const previous = element.previousSibling;
  const fragment = document.createDocumentFragment();
  String(value).split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) fragment.append(document.createElement("br"));
    if (line !== "") fragment.append(document.createTextNode(line));
  });
  if (fragment.firstChild === null) fragment.append(document.createTextNode(""));
  parent.replaceChild(fragment, element);
  const merge = (node) => {
    const following = node?.nextSibling;
    if (node?.nodeType !== 3 || following?.nodeType !== 3) return;
    node.data += following.data;
    following.remove();
  };
  if (next?.nodeType === 3) merge(next.previousSibling);
  if (previous?.nodeType === 3) merge(previous);
}

export function installMarkupBindings(prototypes, runtime) {
  const language = createMarkupLanguage({ ...runtime, renderedText, setOuterText });
  installElementMarkupBindings(language, prototypes.element);
  installInnerTextBindings(language, prototypes.htmlElement);
  installInnerTextBindings(language, prototypes.script);
  installOuterTextBindings(language, prototypes.htmlElement);
  installFragmentMarkupBindings(language, prototypes.fragment);
  installShadowMarkupBindings(language, prototypes.shadow);
  installDocumentConstructionBindings(language, prototypes.document);
  installScriptBindings(language, prototypes.script);
  return (document) => createDOMImplementationBinding({
    // Generated object methods may be borrowed; this receiver is lexical.
    execute: (mode, title) => language.execute(document, mode, title),
  });
}
