// HTML parsing and serialization are owned by the WebAssembly core. Host
// wrappers materialize lazily; declarative shadow roots activate here because
// attaching a shadow root is a host-visible element operation.

// Templates in a parsed subtree, in tree order, each followed by the
// templates of its content: an inner declarative shadow root activates after
// the outer one has moved its host into place. The core lists them; the walk
// materializes no other wrapper.
function templatesIn(root) {
  const core = root._domCore;
  const templates = core.selectorQueryAll(root._coreHandle, "template");
  for (let index = 0; index < templates.length; index += 1) {
    const content = templates[index].content;
    if (content !== null) {
      templates.push(...core.selectorQueryAll(content._coreHandle, "template"));
    }
  }
  return templates;
}

// A template on the stack of open elements of a paused parser (isOpen) has
// not closed yet and does not activate.
function activateDeclarativeShadowRoots(root, fragmentHost = null, isOpen = null) {
  for (const template of templatesIn(root)) {
    const mode = template.getAttribute("shadowrootmode");
    const host = template.parentElement ?? (
      template.parentNode === root ? fragmentHost : null
    );
    if (
      (mode !== "open" && mode !== "closed") ||
      !host ||
      host._shadowRoot ||
      host.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      isOpen?.(template)
    ) continue;
    let shadowRoot;
    try {
      shadowRoot = host.attachShadow({
        mode,
        delegatesFocus: template.hasAttribute("shadowrootdelegatesfocus"),
        clonable: template.hasAttribute("shadowrootclonable"),
        slotAssignment: template.getAttribute("shadowrootslotassignment") ??
          "named",
      });
    } catch (error) {
      if (
        !(error instanceof DOMException && error.name === "NotSupportedError")
      ) {
        throw error;
      }
      continue;
    }
    while (template.content.firstChild) {
      shadowRoot.appendChild(template.content.firstChild);
    }
    template.parentNode?.removeChild(template);
  }
  return root;
}

export function parseHTMLDocument(source, documentFactory) {
  const document = documentFactory();
  document._domCore.parseHtmlDocument(document._coreHandle, String(source));
  activateDeclarativeShadowRoots(document);
  // The parsed images of a document with a window start to load.
  document._imagesParsed?.();
  return document;
}

const RUN_STATUS = ["finished", "script", "insertion-point", "input"];

// The parser of a document that receives its input in pieces and returns to
// the caller after each script end tag (the script processing model). The
// core keeps the tokenizer and tree-builder state between runs.
class HTMLDocumentParser {
  constructor(document, scripting) {
    this._document = document;
    this._core = document._domCore;
    this._id = this._core.htmlParserBegin(document._coreHandle, scripting);
  }

  // False after a run finished or after abort.
  get active() {
    return this._id !== 0;
  }

  _parser() {
    if (this._id === 0) {
      throw new DOMException("The HTML parser is not active", "InvalidStateError");
    }
    return this._id;
  }

  // Adds text at the end of the input stream.
  append(source) {
    this._core.htmlParserAppend(this._parser(), String(source));
  }

  // The explicit end of file after the current end of the input stream.
  end() {
    this._core.htmlParserEnd(this._parser());
  }

  // Inserts text at the insertion point and moves the point after it.
  insert(source) {
    this._core.htmlParserInsert(this._parser(), String(source));
  }

  // Sets the insertion point just before the next input character.
  markInsertionPoint() {
    this._core.htmlParserMarkInsertionPoint(this._parser());
  }

  // An opaque number that a later assignment restores (the count of input
  // bytes after the point, which text inserted before it does not change),
  // or null when the point is undefined.
  get insertionPoint() {
    const bytesAfter = this._core.htmlParserInsertionPoint(this._parser());
    return bytesAfter < 0 ? null : bytesAfter;
  }

  set insertionPoint(value) {
    this._core.htmlParserSetInsertionPoint(
      this._parser(),
      value === null ? -1 : value,
    );
  }

  // Runs to the end of the input, to the next script end tag, or with
  // toInsertionPoint to the insertion point. Declarative shadow roots of the
  // templates that closed in this run attach before the run returns. A
  // script pause reports where the script's text starts in the input
  // stream (written text included): 1-based line, 0-based UTF-16 column.
  // `handlers` lists the elements with event handler content attributes
  // that the run created, each with the position just after its start tag.
  run({ toInsertionPoint = false } = {}) {
    const parser = this._parser();
    let status;
    try {
      status = this._core.htmlParserRun(parser, toInsertionPoint);
    } catch (error) {
      // A core error ends the parse and frees its record.
      this._id = 0;
      throw error;
    }
    const handlers = this._core.htmlParserTakeHandlerElements(parser);
    if (status === 0) {
      // The finished record stays until its handler elements are taken.
      this.abort();
      activateDeclarativeShadowRoots(this._document);
      return { status: "finished", handlers };
    }
    activateDeclarativeShadowRoots(
      this._document,
      null,
      (template) => this._core.htmlParserOpen(parser, template._coreHandle),
    );
    if (status === 1) {
      const { line, column } = this._core.htmlParserScriptPosition(parser);
      return {
        status: "script",
        script: this._core.wrapperFor(this._core.htmlParserScript(parser)),
        line,
        column,
        handlers,
      };
    }
    return { status: RUN_STATUS[status], handlers };
  }

  // The position after the last token the parser consumed: 1-based line,
  // 0-based UTF-16 column.
  position() {
    return this._core.htmlParserPosition(this._parser());
  }

  // Ends the parse at once; nodes already inserted stay.
  abort() {
    if (this._id === 0) return;
    const parser = this._id;
    this._id = 0;
    this._core.htmlParserAbort(parser);
  }
}

// The parser of an empty document. With scripting, noscript is raw text
// (a browsing context with scripting enabled); without it, as in
// parseHTMLDocument, noscript content is markup.
export function beginHTMLDocumentParse(document, { scripting = false } = {}) {
  return new HTMLDocumentParser(document, scripting);
}

// Fragment parsing (innerHTML, outerHTML, insertAdjacentHTML) is one call
// and never pauses. Its scripts are inert here; the script processing model
// marks them "already started".
export function parseHTMLFragment(context, source) {
  const document = context.ownerDocument;
  if (!document) {
    throw new DOMException(
      "Fragment context has no owner document",
      "InvalidStateError",
    );
  }
  const fragment = document.createDocumentFragment();
  document._domCore.parseHtmlFragment(
    context._coreHandle,
    fragment._coreHandle,
    String(source),
  );
  return activateDeclarativeShadowRoots(fragment, context);
}

export function serializeNodeContents(node) {
  return node._domCore.string("html_serialize_children", node._coreHandle, 0);
}

export function serializeNode(node) {
  return node._domCore.string("html_serialize_node", node._coreHandle, 0);
}

// Snapshot output includes every shadow root as a declarative shadow root
// template placed before the host's light children.
export function serializeSnapshotNode(node) {
  return node._domCore.string("html_serialize_node", node._coreHandle, 1);
}
