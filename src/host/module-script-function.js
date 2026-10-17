// An ECMAScript module as the source of a script function, for a realm
// whose module loader the host cannot use: Deno evaluates `import()` from a
// `node:vm` context in the caller's realm, and has no `vm.SourceTextModule`
// (design/classic-scripts.md, "Document realm", fact 6).
//
// The function keeps the module's scoping: its body runs in strict mode, in
// a function scope of its own, so the module's top-level declarations are
// not globals, while a free name resolves through the realm's global scope,
// including the top-level `let` of a classic script, as in a browser. Its
// imports are getters on the object of a `with` statement around the
// strict function, so an imported binding is live and cannot be assigned.
// Its exports are getters that the function hands to the module record when
// it starts. The body keeps every line where the source has it.
//
// The rewrite is lexical: es-module-lexer finds the import and export
// statements, and the scanner below reads their clauses and the names that
// an exported `var`, `let` or `const` declaration binds.

// The parameter that carries the module record into the function.
const MODULE = "__sandomModule";
// The binding of an `export default` expression.
const DEFAULT_BINDING = "__sandomDefault";

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const WHITESPACE = /[\s\uFEFF]/;
const IDENTIFIER_START = /[\p{ID_Start}$_\\#]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d\\]/u;
const NUMBER = /(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;
const PUNCTUATOR = /(?:>>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|\*\*|<<|>>|[+\-*%&|^/]=|[^])/y;

// Keywords after which `/` starts a regular expression literal, and after
// which an expression has not ended.
const OPERATOR_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "extends", "in", "instanceof", "new",
  "of", "return", "throw", "typeof", "void", "yield",
]);

function syntaxError(message) {
  return new SyntaxError(message);
}

// A token scanner over `text` from `position` to `end`: names, numbers,
// strings, template and regular expression literals, and punctuators.
// Comments and white space separate tokens; `newlineBefore` records a line
// terminator among them, for automatic semicolon insertion.
class Scanner {
  constructor(text, position, end = text.length) {
    this.text = text;
    this.position = position;
    this.end = end;
    this.previous = null;
    this.lookahead = null;
  }

  peek() {
    this.lookahead ??= this.scan();
    return this.lookahead;
  }

  next() {
    const token = this.peek();
    this.lookahead = null;
    this.previous = token;
    return token;
  }

  regexAllowed() {
    const previous = this.previous;
    if (previous === null) return true;
    if (previous.type === "punctuator") return !(previous.value === ")" || previous.value === "]" || previous.value === "}");
    if (previous.type === "name") return OPERATOR_KEYWORDS.has(previous.value);
    return false;
  }

  skipTrivia() {
    const { text } = this;
    let newline = false;
    while (this.position < this.end) {
      const character = text[this.position];
      if (LINE_TERMINATOR.test(character)) {
        newline = true;
        this.position += 1;
      } else if (WHITESPACE.test(character)) {
        this.position += 1;
      } else if (character === "/" && text[this.position + 1] === "/") {
        while (this.position < this.end && !LINE_TERMINATOR.test(text[this.position])) this.position += 1;
      } else if (character === "/" && text[this.position + 1] === "*") {
        const close = text.indexOf("*/", this.position + 2);
        const stop = close === -1 ? this.end : close + 2;
        if (LINE_TERMINATOR.test(text.slice(this.position, stop))) newline = true;
        this.position = stop;
      } else {
        break;
      }
    }
    return newline;
  }

  scan() {
    const newlineBefore = this.skipTrivia();
    const { text } = this;
    const start = this.position;
    if (start >= this.end) return { type: "end", value: "", start, end: start, newlineBefore };
    const character = text[start];
    let type;
    if (character === "'" || character === '"') {
      type = "string";
      this.position += 1;
      while (this.position < this.end) {
        const current = text[this.position];
        if (current === "\\") this.position += 2;
        else if (current === character || LINE_TERMINATOR.test(current)) {
          this.position += 1;
          break;
        } else this.position += 1;
      }
    } else if (character === "`") {
      type = "template";
      this.scanTemplate();
    } else if (/\d/.test(character) || (character === "." && /\d/.test(text[start + 1] ?? ""))) {
      type = "number";
      NUMBER.lastIndex = start;
      NUMBER.test(text);
      this.position = Math.max(NUMBER.lastIndex, start + 1);
    } else if (IDENTIFIER_START.test(String.fromCodePoint(text.codePointAt(start)))) {
      type = "name";
      this.position += character === "\\" ? 2 : String.fromCodePoint(text.codePointAt(start)).length;
      while (this.position < this.end) {
        const point = String.fromCodePoint(text.codePointAt(this.position));
        if (!IDENTIFIER_PART.test(point)) break;
        this.position += point === "\\" ? 2 : point.length;
      }
    } else if (character === "/" && this.regexAllowed()) {
      type = "regex";
      this.position += 1;
      let inClass = false;
      while (this.position < this.end) {
        const current = text[this.position];
        if (current === "\\") this.position += 2;
        else if (LINE_TERMINATOR.test(current)) break;
        else {
          this.position += 1;
          if (current === "[") inClass = true;
          else if (current === "]") inClass = false;
          else if (current === "/" && !inClass) break;
        }
      }
      while (this.position < this.end && IDENTIFIER_PART.test(text[this.position])) this.position += 1;
    } else {
      type = "punctuator";
      PUNCTUATOR.lastIndex = start;
      PUNCTUATOR.test(text);
      this.position = PUNCTUATOR.lastIndex;
    }
    const end = Math.min(this.position, this.end);
    this.position = end;
    return { type, value: text.slice(start, end), start, end, newlineBefore };
  }

  // A template literal from its opening backtick; each substitution is
  // scanned as tokens up to its closing brace.
  scanTemplate() {
    const { text } = this;
    this.position += 1;
    while (this.position < this.end) {
      const current = text[this.position];
      if (current === "\\") {
        this.position += 2;
      } else if (current === "`") {
        this.position += 1;
        return;
      } else if (current === "$" && text[this.position + 1] === "{") {
        this.position += 2;
        const previous = this.previous;
        this.previous = null;
        let depth = 0;
        for (;;) {
          const token = this.scan();
          this.previous = token;
          if (token.type === "end") return;
          if (token.type !== "punctuator") continue;
          if (token.value === "{") depth += 1;
          else if (token.value === "}") {
            if (depth === 0) break;
            depth -= 1;
          }
        }
        this.previous = previous;
      } else {
        this.position += 1;
      }
    }
  }
}

function isPunctuator(token, value) {
  return token.type === "punctuator" && token.value === value;
}

function endsExpression(token) {
  if (token.type === "name") return !OPERATOR_KEYWORDS.has(token.value);
  if (token.type === "punctuator") return [")", "]", "}", "++", "--"].includes(token.value);
  return token.type !== "end";
}

function continuesExpression(token) {
  if (token.type === "punctuator") return !["{", "!", "~", "++", "--"].includes(token.value);
  if (token.type === "name") return token.value === "in" || token.value === "instanceof";
  return token.type === "template";
}

const CLOSERS = new Set([",", ";", ")", "]", "}"]);

// Skips one assignment expression: it ends before a comma, a semicolon or a
// closing bracket at its own depth, or where automatic semicolon insertion
// ends the statement.
function skipExpression(scanner) {
  let depth = 0;
  let previous = null;
  for (;;) {
    const token = scanner.peek();
    if (token.type === "end") return;
    if (depth === 0) {
      if (token.type === "punctuator" && CLOSERS.has(token.value)) return;
      if (previous !== null && token.newlineBefore && endsExpression(previous) && !continuesExpression(token)) return;
    }
    scanner.next();
    if (token.type === "punctuator") {
      if (token.value === "(" || token.value === "[" || token.value === "{") depth += 1;
      else if (token.value === ")" || token.value === "]" || token.value === "}") depth -= 1;
    }
    previous = token;
  }
}

function expect(scanner, value) {
  const token = scanner.next();
  if (!isPunctuator(token, value)) {
    throw syntaxError(`Unexpected token ${JSON.stringify(token.value)}; expected ${JSON.stringify(value)}`);
  }
}

// The names a binding identifier or a destructuring pattern binds.
function bindingNames(scanner, names) {
  const token = scanner.next();
  if (token.type === "name") {
    names.push(token.value);
  } else if (isPunctuator(token, "{")) {
    while (!isPunctuator(scanner.peek(), "}")) {
      if (isPunctuator(scanner.peek(), "...")) {
        scanner.next();
        bindingNames(scanner, names);
      } else {
        const key = scanner.next();
        if (isPunctuator(key, "[")) {
          skipExpression(scanner);
          expect(scanner, "]");
        } else if (key.type !== "name" && key.type !== "string" && key.type !== "number") {
          throw syntaxError(`Unexpected token ${JSON.stringify(key.value)} in an object pattern`);
        }
        if (isPunctuator(scanner.peek(), ":")) {
          scanner.next();
          bindingNames(scanner, names);
        } else if (key.type === "name") {
          names.push(key.value);
        }
        if (isPunctuator(scanner.peek(), "=")) {
          scanner.next();
          skipExpression(scanner);
        }
      }
      if (!isPunctuator(scanner.peek(), ",")) break;
      scanner.next();
    }
    expect(scanner, "}");
  } else if (isPunctuator(token, "[")) {
    while (!isPunctuator(scanner.peek(), "]")) {
      if (isPunctuator(scanner.peek(), ",")) {
        scanner.next();
        continue;
      }
      if (isPunctuator(scanner.peek(), "...")) scanner.next();
      bindingNames(scanner, names);
      if (isPunctuator(scanner.peek(), "=")) {
        scanner.next();
        skipExpression(scanner);
      }
      if (!isPunctuator(scanner.peek(), ",")) break;
      scanner.next();
    }
    expect(scanner, "]");
  } else {
    throw syntaxError(`Unexpected token ${JSON.stringify(token.value)} in a binding`);
  }
}

// The names that the declarators of a `var`, `let` or `const` declaration
// bind; `position` is just after the keyword.
function declaredNames(text, position) {
  const scanner = new Scanner(text, position);
  const names = [];
  for (;;) {
    bindingNames(scanner, names);
    if (isPunctuator(scanner.peek(), "=")) {
      scanner.next();
      skipExpression(scanner);
    }
    if (!isPunctuator(scanner.peek(), ",")) return names;
    scanner.next();
  }
}

function tokensOf(text, start, end) {
  const scanner = new Scanner(text, start, end);
  const tokens = [];
  for (let token = scanner.next(); token.type !== "end"; token = scanner.next()) tokens.push(token);
  return tokens;
}

function moduleExportName(token) {
  if (token?.type === "name") return token.value;
  if (token?.type === "string") return JSON.parse(token.value.replace(/^'|'$/g, '"'));
  throw syntaxError(`Unexpected token ${JSON.stringify(token?.value ?? "end")} in an import or export clause`);
}

// `{ a, b as c, default as d }`, from `tokens[index]` (the opening brace):
// the [name, alias] pairs, and the index after the closing brace.
function namedClause(tokens, index) {
  const pairs = [];
  index += 1;
  while (!isPunctuator(tokens[index] ?? {}, "}")) {
    const name = moduleExportName(tokens[index]);
    index += 1;
    let alias = name;
    if (tokens[index]?.type === "name" && tokens[index].value === "as") {
      alias = moduleExportName(tokens[index + 1]);
      index += 2;
    }
    pairs.push([name, alias]);
    if (isPunctuator(tokens[index] ?? {}, ",")) index += 1;
    else if (!isPunctuator(tokens[index] ?? {}, "}")) {
      throw syntaxError(`Unexpected token ${JSON.stringify(tokens[index]?.value ?? "end")} in an import or export clause`);
    }
  }
  return { pairs, index: index + 1 };
}

function expectFrom(tokens, index) {
  if (index !== tokens.length - 1 || tokens[index].type !== "name" || tokens[index].value !== "from") {
    throw syntaxError(`Unexpected token ${JSON.stringify(tokens[index]?.value ?? "end")}; expected "from"`);
  }
}

// The bindings of `import <clause> from`: [local, imported] pairs, where
// imported `*` is the namespace.
function importBindings(tokens) {
  const bindings = [];
  if (tokens.length === 0) return bindings;
  let index = 0;
  if (tokens[0].type === "name") {
    bindings.push([tokens[0].value, "default"]);
    index = 1;
    if (isPunctuator(tokens[index] ?? {}, ",")) index += 1;
  }
  if (isPunctuator(tokens[index] ?? {}, "*")) {
    if (tokens[index + 1]?.value !== "as" || tokens[index + 2]?.type !== "name") {
      throw syntaxError("A namespace import needs `* as name`");
    }
    bindings.push([tokens[index + 2].value, "*"]);
    index += 3;
  } else if (isPunctuator(tokens[index] ?? {}, "{")) {
    const clause = namedClause(tokens, index);
    for (const [imported, local] of clause.pairs) bindings.push([local, imported]);
    index = clause.index;
  }
  expectFrom(tokens, index);
  return bindings;
}

// The exports of `export <clause> from`: [exported, imported] pairs, where
// imported `*` is the namespace, or `star` for `export * from`.
function reexportBindings(tokens) {
  if (isPunctuator(tokens[0] ?? {}, "*")) {
    if (tokens[1]?.type === "name" && tokens[1].value === "as") {
      expectFrom(tokens, 3);
      return { star: false, pairs: [[moduleExportName(tokens[2]), "*"]] };
    }
    expectFrom(tokens, 1);
    return { star: true, pairs: [] };
  }
  if (!isPunctuator(tokens[0] ?? {}, "{")) {
    throw syntaxError(`Unexpected token ${JSON.stringify(tokens[0]?.value ?? "end")} after export`);
  }
  const clause = namedClause(tokens, 0);
  expectFrom(tokens, clause.index);
  return { star: false, pairs: clause.pairs.map(([imported, exported]) => [exported, imported]) };
}

// The same text with every character but a line terminator replaced by a
// space, so no line or column of the code after it moves.
function blank(text) {
  return text.replace(/[^\n\r\u2028\u2029]/g, " ");
}

// Rewrites module `text`, which es-module-lexer parsed into `imports` and
// `exports`, into the source of
//   (function (module) { with (module.imports) { return async function () { … } } })
// Returns that `source`; `columnShift`, the length of the source before the
// module's first character on its line; `requests`, the static imports and
// re-exports in source order, as { specifier, bindings: [[local, imported]] }
// or { specifier, reexports: [[exported, imported]], star }; and
// `localExports`, the [exported, local] pairs the module's own bindings give.
//
// The function's argument is { imports, exports(getters), meta, import }:
// the import bindings, a function that receives the export getters, the
// `import.meta` object, and the dynamic `import()`.
export function moduleScriptFunction(text, imports, exports) {
  const edits = [];
  const requests = [];
  const localExports = new Map();
  const reexportStarts = new Set();
  for (const record of imports) {
    if (record.d === -1) {
      if (record.t !== undefined && record.t !== 1) {
        throw syntaxError(`The import phase of ${JSON.stringify(text.slice(record.ss, record.se))} is not supported`);
      }
      const keyword = text.startsWith("export", record.ss) ? "export" : "import";
      const tokens = tokensOf(text, record.ss + keyword.length, record.s - 1);
      if (keyword === "import") {
        requests.push({ specifier: record.n, bindings: importBindings(tokens) });
      } else {
        reexportStarts.add(record.ss);
        const { star, pairs } = reexportBindings(tokens);
        requests.push({ specifier: record.n, reexports: pairs, star });
      }
      edits.push([record.ss, record.se, blank(text.slice(record.ss, record.se))]);
    } else if (record.d === -2) {
      edits.push([record.s, record.e, `${MODULE}.meta`]);
    } else if (record.d >= 0) {
      edits.push([record.ss, record.d + 1, `${MODULE}.import(`]);
    }
  }

  const statements = new Map();
  for (const entry of exports) {
    const start = text.lastIndexOf("export", entry.s);
    if (start === -1 || reexportStarts.has(start)) continue;
    if (!statements.has(start)) statements.set(start, []);
    statements.get(start).push(entry);
  }
  for (const [start, entries] of statements) {
    const scanner = new Scanner(text, start + "export".length);
    const first = scanner.next();
    if (isPunctuator(first, "{")) {
      for (const entry of entries) localExports.set(entry.n, entry.ln);
      let close = scanner.next();
      while (close.type !== "end" && !isPunctuator(close, "}")) close = scanner.next();
      edits.push([start, close.end, blank(text.slice(start, close.end))]);
    } else if (first.type === "name" && first.value === "default") {
      const local = entries[0].ln ?? DEFAULT_BINDING;
      localExports.set("default", local);
      edits.push([
        start,
        first.end,
        local === DEFAULT_BINDING ? `let ${DEFAULT_BINDING} =` : blank(text.slice(start, first.end)),
      ]);
    } else {
      const names = first.type === "name" && ["var", "let", "const"].includes(first.value)
        ? declaredNames(text, first.end)
        : entries.map((entry) => entry.ln);
      for (const name of names) localExports.set(name, name);
      edits.push([start, start + "export".length, "      "]);
    }
  }

  edits.sort((left, right) => left[0] - right[0]);
  let body = "";
  let offset = 0;
  for (const [start, end, replacement] of edits) {
    if (start < offset) throw syntaxError(`Overlapping module syntax at offset ${start}`);
    body += text.slice(offset, start) + replacement;
    offset = end;
  }
  body += text.slice(offset);

  const getters = [...localExports].map(([exported, local]) => `${JSON.stringify(exported)}: () => ${local}`);
  const head = `(function (${MODULE}) { with (${MODULE}.imports) { return async function () { "use strict"; ` +
    `${MODULE}.exports({ ${getters.join(", ")} }); `;
  return {
    source: `${head}${body}\n} } })`,
    columnShift: head.length,
    requests,
    localExports: [...localExports],
  };
}
