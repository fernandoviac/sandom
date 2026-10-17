// A browser-compatible ECMAScript module session for hosts whose modules do
// not live in the runtime's own module loader: supplied resources, browser
// documents, and network documents.
//
// The session resolves each specifier with the document import maps and the
// URL Standard, requests each module through the host resource session,
// parses static and dynamic imports, and links the graph through object
// URLs. Each module evaluates once in one session; a new session evaluates a
// new instance. `import.meta.url` is the final locator of the module, and a
// dynamic import returns to the same session. A graph that a request names
// a script realm for evaluates in that realm instead, each module as a
// script function.
import { SandomHostError } from "./contract.js";
import { moduleScriptFunction } from "./module-script-function.js";

// The lexer loads on the first module evaluation, so a session that never
// evaluates a module needs no lexer in its realm.
let moduleLexer = null;
async function loadModuleLexer() {
  moduleLexer ??= import("es-module-lexer").then(async (lexer) => {
    await lexer.init;
    return lexer;
  });
  try {
    return await moduleLexer;
  } catch (cause) {
    moduleLexer = null;
    throw new SandomHostError(
      "module-resolution-failure",
      `The module session needs the es-module-lexer package: ${cause?.message ?? String(cause)}`,
      { cause },
    );
  }
}

const JAVASCRIPT_MEDIA_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "module",
]);
const JSON_MEDIA_TYPES = new Set(["application/json", "text/json"]);

let nextSessionIdentifier = 1;

function resolutionFailure(message, cause, details = {}) {
  return new SandomHostError("module-resolution-failure", message, {
    cause,
    details,
  });
}

// Parses one import map text as the HTML Standard defines it for the
// fields Sandom hosts support: `imports` and `scopes`.
function parseImportMap(text, baseURL) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw resolutionFailure(`Import map of ${baseURL} is not valid JSON: ${cause.message}`, cause);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw resolutionFailure(`Import map of ${baseURL} must be a JSON object`);
  }
  const normalizeSpecifierMap = (map, label) => {
    if (map === undefined) return [];
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      throw resolutionFailure(`Import map ${label} of ${baseURL} must be an object`);
    }
    const entries = [];
    for (const [key, address] of Object.entries(map)) {
      if (typeof address !== "string") continue;
      const normalizedKey = urlLikeSpecifier(key, baseURL) ?? key;
      let addressURL;
      try {
        addressURL = new URL(address, baseURL).href;
      } catch {
        continue;
      }
      if (normalizedKey.endsWith("/") && !addressURL.endsWith("/")) continue;
      entries.push([normalizedKey, addressURL]);
    }
    // The longest key wins, as the HTML Standard sorts specifier maps.
    return entries.sort((left, right) => right[0].length - left[0].length);
  };
  const scopes = [];
  if (value.scopes !== undefined) {
    if (value.scopes === null || typeof value.scopes !== "object" || Array.isArray(value.scopes)) {
      throw resolutionFailure(`Import map scopes of ${baseURL} must be an object`);
    }
    for (const [scope, map] of Object.entries(value.scopes)) {
      let scopeURL;
      try {
        scopeURL = new URL(scope, baseURL).href;
      } catch {
        continue;
      }
      scopes.push([scopeURL, normalizeSpecifierMap(map, `scope ${scope}`)]);
    }
    scopes.sort((left, right) => right[0].length - left[0].length);
  }
  return { imports: normalizeSpecifierMap(value.imports, "imports"), scopes };
}

function urlLikeSpecifier(specifier, baseURL) {
  if (
    specifier.startsWith("/") || specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    try {
      return new URL(specifier, baseURL).href;
    } catch {
      return null;
    }
  }
  try {
    return new URL(specifier).href;
  } catch {
    return null;
  }
}

function applySpecifierMap(entries, normalizedSpecifier) {
  for (const [key, address] of entries) {
    if (key === normalizedSpecifier) return address;
    if (key.endsWith("/") && normalizedSpecifier.startsWith(key)) {
      return new URL(normalizedSpecifier.slice(key.length), address).href;
    }
  }
  return null;
}

function moduleSourceText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function javascriptStringLiteral(value) {
  return JSON.stringify(value);
}

const PARSE_ONLY_PREFIX = "throw 0;";

// Deno reports a module that does not compile as a TypeError, "The module's
// source code could not be parsed: <message> at <url>:<line>:<column>". A
// browser throws a SyntaxError at the module's final locator; this returns
// that SyntaxError, its stack in the engine's compile-error form (locator
// and line, the source line, a caret under the column), or null for any
// other failure. `sourceOf(url)` names the module an object URL holds, as
// { finalURL, code }, or null; `firstLineShift` is what precedes that code
// on its first line.
function engineSyntaxError(cause, sourceOf, firstLineShift = 0) {
  if (!(cause instanceof Error)) return null;
  const prefix = "The module's source code could not be parsed: ";
  const message = String(cause.message);
  if (!message.startsWith(prefix)) return null;
  const located = / at (\S+):(\d+):(\d+)/.exec(message.slice(prefix.length).split("\n")[0]);
  const source = located === null ? null : sourceOf(located[1]);
  if (source === null) return null;
  const line = Number(located[2]);
  const column = Number(located[3]) - (line === 1 ? firstLineShift : 0);
  const description = message.slice(prefix.length, prefix.length + located.index);
  const error = new SyntaxError(description);
  const sourceLine = source.code.split(/\r\n?|\n/)[line - 1] ?? "";
  Object.defineProperty(error, "stack", {
    value: `${source.finalURL}:${line}\n${sourceLine}\n${" ".repeat(Math.max(0, column - 1))}^\n\nSyntaxError: ${description}`,
    writable: true,
    configurable: true,
  });
  return error;
}

// The failure of module `text`, which does not compile, as its evaluation
// would fail: with a SyntaxError. A lexer's or a script compiler's position
// is not the module compiler's, so the engine compiles the unlinked source
// to name where it fails. The leading throw, on the first line so no line
// moves, means that source the engine does parse still evaluates nothing;
// the SyntaxError of `cause` then stands.
async function parseFailure(finalURL, text, cause) {
  let syntaxError = cause?.name === "SyntaxError" ? cause : new SyntaxError(cause?.message ?? String(cause));
  const objectURL = URL.createObjectURL(
    new Blob([PARSE_ONLY_PREFIX, text], { type: "text/javascript" }),
  );
  try {
    await import(objectURL);
  } catch (engineCause) {
    syntaxError = engineSyntaxError(
      engineCause,
      (url) => url === objectURL ? { finalURL, code: text } : null,
      PARSE_ONLY_PREFIX.length,
    ) ?? syntaxError;
  } finally {
    URL.revokeObjectURL(objectURL);
  }
  return new SandomHostError(
    "module-evaluation-failure",
    `Module ${finalURL} does not parse: ${syntaxError.message}`,
    { cause: syntaxError },
  );
}

export function createModuleGraphSession({ requestModule, documentURL, signal }) {
  if (typeof requestModule !== "function") {
    throw new TypeError("createModuleGraphSession requires a requestModule function");
  }
  const sessionIdentifier = nextSessionIdentifier++;
  const dynamicImportKey = Symbol.for(`sandom.moduleSession.${sessionIdentifier}.import`);
  const importMaps = [];
  // Final module locator -> Promise of { objectURL, finalURL }.
  const linkedModules = new Map();
  // Linked object URL -> the final locator of the module it holds.
  const objectURLs = new Map();
  let released = false;

  const resolveSpecifier = (specifier, parentURL) => {
    const asURL = urlLikeSpecifier(specifier, parentURL);
    const normalized = asURL ?? specifier;
    for (const map of importMaps) {
      for (const [scopePrefix, entries] of map.scopes) {
        if (parentURL === scopePrefix || (scopePrefix.endsWith("/") && parentURL.startsWith(scopePrefix))) {
          const mapped = applySpecifierMap(entries, normalized);
          if (mapped !== null) return mapped;
        }
      }
      const mapped = applySpecifierMap(map.imports, normalized);
      if (mapped !== null) return mapped;
    }
    if (asURL !== null) return asURL;
    throw resolutionFailure(
      `Module specifier ${JSON.stringify(specifier)} imported from ${parentURL} is a bare specifier that no import map resolves`,
      undefined,
      { specifier, parentURL },
    );
  };

  const objectURLFor = (code, finalURL) => {
    const objectURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    objectURLs.set(objectURL, { finalURL, code });
    return objectURL;
  };

  // A module's exception names the module by its final locator, as in
  // Chrome, not by the object URL this session evaluated it from.
  const nameFinalURLs = (cause) => {
    if (cause === null || (typeof cause !== "object" && typeof cause !== "function")) return;
    let stack;
    try {
      stack = cause.stack;
    } catch {
      return;
    }
    if (typeof stack !== "string" || !stack.includes("blob:")) return;
    const named = stack.replace(
      /blob:[^\s()]*?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (objectURL) => objectURLs.get(objectURL)?.finalURL ?? objectURL,
    );
    try {
      Object.defineProperty(cause, "stack", { value: named, writable: true, configurable: true });
    } catch {
      // A frozen or exotic exception keeps its stack.
    }
  };

  // Rewrites one module so its static imports name linked object URLs, its
  // dynamic imports return to this session, and import.meta names its final
  // locator.
  const linkSource = async (finalURL, text, ancestors) => {
    const lexer = await loadModuleLexer();
    let imports;
    try {
      [imports] = lexer.parse(text, finalURL);
    } catch (cause) {
      throw await parseFailure(finalURL, text, cause);
    }
    const replacements = [];
    for (const record of imports) {
      if (record.d === -1) {
        const specifier = record.n;
        if (specifier === undefined) {
          throw resolutionFailure(`Module ${finalURL} has a static import without a string specifier`);
        }
        const dependencyURL = resolveSpecifier(specifier, finalURL);
        const dependency = await linkModule(dependencyURL, null, [...ancestors, finalURL]);
        replacements.push([record.s, record.e, dependency.objectURL]);
      } else if (record.d === -2) {
        const meta = `({ url: ${javascriptStringLiteral(finalURL)}, resolve: (specifier) => globalThis[Symbol.for(${
          javascriptStringLiteral(`sandom.moduleSession.${sessionIdentifier}.resolve`)
        })](String(specifier), ${javascriptStringLiteral(finalURL)}) })`;
        replacements.push([record.s, record.e, meta, true]);
      } else if (record.d >= 0) {
        replacements.push([
          record.ss,
          record.d + 1,
          `globalThis[Symbol.for(${javascriptStringLiteral(dynamicImportKey.description)})](${
            javascriptStringLiteral(finalURL)
          }, `,
          true,
        ]);
      }
    }
    replacements.sort((left, right) => left[0] - right[0]);
    let code = "";
    let offset = 0;
    for (const [start, end, value, verbatim] of replacements) {
      code += text.slice(offset, start);
      code += verbatim ? value : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      offset = end;
    }
    code += text.slice(offset);
    return code;
  };

  const loadModuleBytes = async (reference, baseURL, signalForDemand) => {
    let resource;
    try {
      resource = await requestModule({ reference, baseURL, signal: signalForDemand });
    } catch (cause) {
      if (cause instanceof SandomHostError) throw cause;
      const moduleURL = new URL(reference, baseURL).href;
      throw resolutionFailure(`Module ${moduleURL} could not be obtained: ${cause?.message ?? String(cause)}`, cause);
    }
    return resource;
  };

  // One module's source: { finalURL, text }, with `json` the value of a
  // JSON module. `entry` is the entry's request, { reference, baseURL,
  // source }, or null for a dependency: an entry is demanded by its authored
  // reference, so the host sees a root-relative reference as authored, and
  // its supplied source needs no demand.
  const loadModuleSource = async (moduleURL, entry, signalForDemand) => {
    let finalURL = moduleURL;
    let bytes = entry?.source ?? null;
    let mediaType = null;
    if (bytes === null) {
      const resource = await loadModuleBytes(entry?.reference ?? moduleURL, entry?.baseURL ?? moduleURL, signalForDemand);
      finalURL = resource.finalURL;
      bytes = resource.bytes;
      mediaType = resource.mediaType;
    }
    const text = moduleSourceText(bytes);
    if (mediaType !== null && JSON_MEDIA_TYPES.has(mediaType)) {
      try {
        return { finalURL, text, json: JSON.parse(text) };
      } catch (cause) {
        throw resolutionFailure(`JSON module ${finalURL} is not valid JSON: ${cause.message}`, cause);
      }
    }
    if (mediaType !== null && !JAVASCRIPT_MEDIA_TYPES.has(mediaType)) {
      throw new SandomHostError(
        "response-media-type",
        `Module ${finalURL} has media type ${JSON.stringify(mediaType)}; a module script needs a JavaScript media type`,
        { details: { mediaType } },
      );
    }
    return { finalURL, text };
  };

  const cycleFailure = (moduleURL, ancestors) =>
    resolutionFailure(
      `Module ${moduleURL} is part of an import cycle (${[...ancestors, moduleURL].join(" -> ")}); this module session links acyclic graphs only`,
      undefined,
      { cycle: [...ancestors, moduleURL] },
    );

  // `modules` maps a module URL to the promise of its record; a record
  // that fails to arrive leaves the map, so a later import tries again.
  const memoize = (modules, moduleURL, make) => {
    let record = modules.get(moduleURL);
    if (record) return record;
    record = make();
    modules.set(moduleURL, record);
    record.catch(() => {
      if (modules.get(moduleURL) === record) modules.delete(moduleURL);
    });
    return record;
  };

  const linkModule = (moduleURL, entry, ancestors, signalForDemand) => {
    if (ancestors.includes(moduleURL)) return Promise.reject(cycleFailure(moduleURL, ancestors));
    return memoize(linkedModules, moduleURL, async () => {
      const { finalURL, text, json } = await loadModuleSource(moduleURL, entry, signalForDemand);
      if (json !== undefined) {
        return { finalURL, objectURL: objectURLFor(`export default ${JSON.stringify(json)};`, finalURL) };
      }
      const code = await linkSource(finalURL, text, ancestors);
      return { finalURL, objectURL: objectURLFor(code, finalURL) };
    });
  };

  const requireOpen = (moduleURL) => {
    if (released) {
      throw new SandomHostError(
        "stale-resource-generation",
        `The module session of ${documentURL} has been released; ${moduleURL} cannot load`,
      );
    }
  };

  const importLinked = async (moduleURL, entry, signalForDemand) => {
    requireOpen(moduleURL);
    await loadModuleLexer();
    const linked = await linkModule(moduleURL, entry, [], signalForDemand);
    try {
      return await import(linked.objectURL);
    } catch (thrown) {
      // A linked module that the engine cannot compile throws a SyntaxError
      // naming it; rewriting keeps every line where the source has it.
      const cause = engineSyntaxError(thrown, (url) => objectURLs.get(url) ?? null) ?? thrown;
      nameFinalURLs(cause);
      throw new SandomHostError(
        "module-evaluation-failure",
        `Module ${linked.finalURL} failed to evaluate: ${cause?.message ?? String(cause)}`,
        { cause },
      );
    }
  };

  // A module graph in a script realm: the realm of a document whose scripts
  // run in a realm of their own (a classic-script session's), which the
  // runtime's module loader does not evaluate in. Each module evaluates
  // there as a script function (src/host/module-script-function.js), once
  // in each realm. A record is { finalURL, namespace, exportNames,
  // dependencies, run }.
  const realmModules = new WeakMap();

  const namespaceOf = (exportNames, getter) => {
    const namespace = Object.create(null);
    for (const name of [...exportNames].sort()) {
      Object.defineProperty(namespace, name, { enumerable: true, get: getter(name) });
    }
    Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
    return Object.preventExtensions(namespace);
  };

  const missingExport = (specifier, name) =>
    new SyntaxError(`The requested module '${specifier}' does not provide an export named '${name}'`);

  const instantiateInRealm = (realm, moduleURL, entry, ancestors, signalForDemand) => {
    if (ancestors.includes(moduleURL)) return Promise.reject(cycleFailure(moduleURL, ancestors));
    if (!realmModules.has(realm)) realmModules.set(realm, new Map());
    return memoize(realmModules.get(realm), moduleURL, async () => {
      const { finalURL, text, json } = await loadModuleSource(moduleURL, entry, signalForDemand);
      if (json !== undefined) {
        return {
          finalURL,
          namespace: namespaceOf(["default"], () => () => json),
          exportNames: new Set(["default"]),
          dependencies: [],
          run: () => undefined,
        };
      }
      const lexer = await loadModuleLexer();
      let plan;
      try {
        const [imports, exports] = lexer.parse(text, finalURL);
        plan = moduleScriptFunction(text, imports, exports);
      } catch (cause) {
        throw await parseFailure(finalURL, text, cause);
      }
      const linkFailure = (cause) =>
        new SandomHostError("module-evaluation-failure", `Module ${finalURL} does not link: ${cause.message}`, { cause });

      const dependencies = [];
      const imports = Object.create(null);
      const exportNames = new Set(plan.localExports.map(([exported]) => exported));
      const exportedFrom = new Map();
      const starNames = new Map();
      for (const request of plan.requests) {
        const dependency = await instantiateInRealm(
          realm,
          resolveSpecifier(request.specifier, finalURL),
          null,
          [...ancestors, finalURL],
          signalForDemand,
        );
        dependencies.push(dependency);
        const binding = (name) => {
          if (name === "*") return () => dependency.namespace;
          if (!dependency.exportNames.has(name)) throw linkFailure(missingExport(request.specifier, name));
          return () => dependency.namespace[name];
        };
        for (const [local, imported] of request.bindings ?? []) {
          Object.defineProperty(imports, local, { enumerable: true, get: binding(imported) });
        }
        for (const [exported, imported] of request.reexports ?? []) {
          exportNames.add(exported);
          exportedFrom.set(exported, binding(imported));
        }
        if (request.star) {
          for (const name of dependency.exportNames) {
            if (name === "default") continue;
            const previous = starNames.get(name);
            starNames.set(name, previous === undefined || previous === dependency ? dependency : null);
          }
        }
      }
      // An `export *` name that a module exports itself, or that two
      // dependencies give, is not exported through the star.
      for (const [name, dependency] of starNames) {
        if (exportNames.has(name) || dependency === null) continue;
        exportNames.add(name);
        exportedFrom.set(name, () => dependency.namespace[name]);
      }

      let getters = null;
      const namespace = namespaceOf(exportNames, (name) => exportedFrom.get(name) ?? (() => getters[name]()));
      const completion = realm.evaluateScript({
        source: plan.source,
        url: finalURL,
        line: 1,
        column: -plan.columnShift,
      });
      if (completion.type === "throw") throw await parseFailure(finalURL, text, completion.value);
      const moduleFunction = completion.value;
      const record = {
        finalURL,
        namespace,
        exportNames,
        dependencies,
        run: () =>
          moduleFunction(Object.freeze({
            imports,
            exports(moduleGetters) {
              getters = moduleGetters;
            },
            meta: {
              url: finalURL,
              resolve: (specifier) => resolveSpecifier(String(specifier), finalURL),
            },
            import: (specifier) =>
              importInRealm(realm, resolveSpecifier(String(specifier), finalURL), null, signalForDemand).catch((error) => {
                throw error?.code === "module-evaluation-failure" ? error.cause : error;
              }),
          }))(),
        evaluation: null,
      };
      return record;
    });
  };

  // Evaluates a record after its dependencies, in the order the module
  // imports them.
  const evaluateInRealm = (record) =>
    record.evaluation ??= (async () => {
      for (const dependency of record.dependencies) await evaluateInRealm(dependency);
      await record.run();
    })();

  const importInRealm = async (realm, moduleURL, entry, signalForDemand) => {
    requireOpen(moduleURL);
    const record = await instantiateInRealm(realm, moduleURL, entry, [], signalForDemand);
    try {
      await evaluateInRealm(record);
    } catch (cause) {
      throw new SandomHostError(
        "module-evaluation-failure",
        `Module ${record.finalURL} failed to evaluate: ${cause?.message ?? String(cause)}`,
        { cause },
      );
    }
    return record.namespace;
  };

  globalThis[dynamicImportKey] = (parentURL, specifier) =>
    importLinked(resolveSpecifier(String(specifier), parentURL), null, signal);
  globalThis[Symbol.for(`sandom.moduleSession.${sessionIdentifier}.resolve`)] = resolveSpecifier;

  return Object.freeze({
    // `scriptRealm`, when present, is the classic-script session of the
    // document's realm: the graph evaluates in that realm.
    async execute({
      reference,
      baseURL,
      source,
      preprocessor,
      importMaps: documentImportMaps = [],
      signal: executeSignal,
      scriptRealm = null,
    }) {
      if (preprocessor !== "javascript") {
        throw resolutionFailure(
          `Module ${reference} uses preprocessor ${JSON.stringify(preprocessor)}; this module session evaluates JavaScript modules only`,
          undefined,
          { preprocessor },
        );
      }
      for (const { text, baseURL: mapBaseURL } of documentImportMaps) {
        if (!importMaps.some((map) => map.text === text && map.baseURL === mapBaseURL)) {
          importMaps.push({ text, baseURL: mapBaseURL, ...parseImportMap(text, mapBaseURL) });
        }
      }
      // A module script `src` and an inline identity are URLs, not module
      // specifiers: the URL Standard resolves them against the base.
      let entryURL;
      try {
        entryURL = new URL(reference, baseURL).href;
      } catch (cause) {
        throw resolutionFailure(`Module entry ${JSON.stringify(reference)} does not resolve against ${baseURL}`, cause);
      }
      const entry = { reference, baseURL, source: source ?? null };
      if (scriptRealm !== null) return await importInRealm(scriptRealm, entryURL, entry, executeSignal ?? signal);
      return await importLinked(entryURL, entry, executeSignal ?? signal);
    },
    release() {
      if (released) return;
      released = true;
      delete globalThis[dynamicImportKey];
      delete globalThis[Symbol.for(`sandom.moduleSession.${sessionIdentifier}.resolve`)];
      for (const objectURL of objectURLs.keys()) URL.revokeObjectURL(objectURL);
      objectURLs.clear();
      linkedModules.clear();
    },
  });
}
