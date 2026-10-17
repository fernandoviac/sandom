import { decodeFontCoverage } from "./font-coverage.js";

import { createDocumentResourceLoader } from "./dom/document-resources.js";
import { sharedDomCore } from "./dom-wasm/core.js";

const fontCatalogFinalizer = new FinalizationRegistry((lifetime) => {
  lifetime.unsubscribe?.();
  // The owner can point back to its default registry. Holding it strongly
  // here would keep both the registry and its entire WASM memory alive.
  const core = lifetime.coreReference.deref();
  if (!core) return;
  for (const resource of lifetime.resources.values()) core.status("resource_release", resource);
  if (lifetime.sourceSync !== 0n) core.status("font_source_sync_release", lifetime.sourceSync);
  core.status("font_catalog_release", lifetime.handle);
});

export const DEFAULT_FONT_FAMILY = "sans-serif";
export const DEFAULT_FONT_SIZE = 14;
// Hosted faces are immutable process resources. Every registry in one module
// realm must resolve a hosted family key to the same selected face record.
const hostedFontFamilies = new Map();
const registrySources = new WeakMap();
// Opaque identities of the host values that a registry's resolver and
// bundled fonts read (font_catalog_host_sources); 0 for an absent value.
const hostValueTokens = new WeakMap();
let nextHostValueToken = 1;
function hostValueToken(value) {
  if (value === undefined || value === null) return 0;
  let token = hostValueTokens.get(value);
  if (token === undefined) hostValueTokens.set(value, token = nextHostValueToken++);
  return token;
}
const fontLoadRequestCaches = new WeakMap();
const fontLoadRequestFinalizer = new FinalizationRegistry((handle) => {
  sharedDomCore.status("font_load_requests_release", handle);
});

function fontLoadRequestFor(owner, family, weight, style) {
  let handle = fontLoadRequestCaches.get(owner);
  if (handle === undefined) {
    handle = sharedDomCore.status("font_load_requests_create");
    fontLoadRequestCaches.set(owner, handle);
    fontLoadRequestFinalizer.register(owner, handle);
  }
  return sharedDomCore.status("font_load_request", handle, Number(family),
    Number(weight), ...sharedDomCore.input(String(style)));
}

function subscribeFontSource(registry, synchronizeReference) {
  const unsubscribe = registry.subscribe(() => {
    const synchronize = synchronizeReference.deref();
    if (synchronize) synchronize();
    else unsubscribe();
  });
  return unsubscribe;
}

function normalizedFamilyName(value, lower, core) {
  return core.string(
    "font_family_normalize", ...core.input(String(value)), lower ? 1 : 0,
  ) ?? "";
}

// The message of font registry failure `kind` (font_registry_message),
// naming `number` and the texts.
function registryMessage(core, kind, number, ...texts) {
  const inputs = [0, 1, 2, 3].flatMap((index) => core.input(texts[index] ?? ""));
  return core.string("font_registry_message", kind, number, ...inputs) ?? "";
}

// The font-style slope a request without an explicit slope selects
// (font_style_default_slope): Chrome matches italic and an oblique
// without an angle as the same oblique angle.
function defaultSlope(core, style) {
  return core.status("font_style_default_slope", ...core.input(String(style)));
}

// An @font-face font-style descriptor (CSS Fonts 4, 4.4) as a slope range
// in degrees, read by the core (font_face_style_descriptor): auto (matched
// as normal; a 'slnt' axis instances at the requested angle), normal [0, 0],
// italic and oblique [14, 14], oblique with one angle, or oblique with two.
// Returns { slopeMinimum, slopeMaximum, slopeAuto }, or null for any other
// text.
export function fontFaceStyleDescriptor(text, core = sharedDomCore) {
  if (core.status("font_face_style_descriptor", ...core.input(String(text ?? ""))) === 0) return null;
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 24);
  return {
    slopeMinimum: view.getFloat64(0, true),
    slopeMaximum: view.getFloat64(8, true),
    slopeAuto: view.getInt32(16, true) !== 0,
  };
}

// The registry fallback families of `fallbackFamilies`
// (design/font-fallback.md): `coverage`, a coverage index
// (src/font-coverage.js, tools/generate-font-coverage.js), and `faces`, an
// object with one entry for each family the index names:
// `{ url, load({ url, weight, style }) }`. `load` returns a promise of the
// face's bytes (a Uint8Array, or `{ bytes, finalURL, faceIndex }`) for a
// CSS weight and a style ("normal" or "italic"). The renderer asks for a
// face only when a text cluster that no authored face covers needs it.
// Each face load is a font resource: pending, then loaded or failed. The
// state is shared with each registry made from this one (sourceRegistry),
// so a face loads once.
function createFallbackFamilies(fallbackFamilies) {
  if (fallbackFamilies === null) return null;
  if (typeof fallbackFamilies !== "object" || !(fallbackFamilies.coverage instanceof Uint8Array) ||
    typeof fallbackFamilies.faces !== "object" || fallbackFamilies.faces === null) {
    throw new TypeError(
      "fallbackFamilies must be { coverage: Uint8Array, faces: { [family]: { url, load } } } or null",
    );
  }
  const coverage = decodeFontCoverage(fallbackFamilies.coverage);
  const faces = coverage.families.map((family) => {
    const entry = Object.hasOwn(fallbackFamilies.faces, family) ? fallbackFamilies.faces[family] : undefined;
    if (typeof entry?.url !== "string" || typeof entry?.load !== "function") {
      throw new Error(registryMessage(sharedDomCore, 5, 0, family));
    }
    return entry;
  });
  const loads = new Map();
  const requestOwner = {};
  return Object.freeze({
    coverage,
    // The face of fallback family `family` (its index in the coverage
    // index) at a CSS weight and style: a promise of
    // { family, bytes, faceIndex, finalURL }. A failed load rejects with
    // the family, the URL, and the cause.
    load(family, weight, style) {
      const key = fontLoadRequestFor(requestOwner, family, weight, style);
      let resource = loads.get(key);
      if (resource === undefined) {
        const name = coverage.families[family];
        const { url, load } = faces[family];
        resource = { family: name, weight: Number(weight), style: String(style), state: "pending", url, promise: null };
        resource.promise = Promise.resolve().then(() => load({ url, weight, style })).then((response) => {
          const bytes = response instanceof Uint8Array ? response : response?.bytes;
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError(`load returned ${Object.prototype.toString.call(response)}, not font bytes`);
          }
          // Bytes that are not a font fail the load (font_bytes_readable).
          sharedDomCore.status("font_bytes_readable", ...sharedDomCore.byteInput(bytes), Number(response?.faceIndex ?? 0));
          Object.assign(resource, { state: "loaded" });
          return {
            family: name, bytes, faceIndex: Number(response?.faceIndex ?? 0),
            finalURL: response?.finalURL ?? url,
          };
        }).catch((cause) => {
          Object.assign(resource, { state: "failed", error: cause });
          throw new Error(registryMessage(sharedDomCore, 6, Number(weight), name, String(style), url,
            String(cause?.message ?? cause)), { cause });
        });
        loads.set(key, resource);
      }
      return resource.promise;
    },
    // The state of each face load: [{ family, weight, style, url, state }].
    get resources() {
      return [...loads.values()].map(({ family, weight, style, url, state }) =>
        ({ family, weight, style, url, state }));
    },
  });
}

// The fallback families of each bundled font set (system-fonts.js), shared
// by every registry that uses the set, so that a face loads once in a realm.
const bundledFallbackFamilies = new WeakMap();

function fallbackFamiliesOfBundledFonts(bundledSystemFonts) {
  const option = bundledSystemFonts?.fallbackFamilies ?? null;
  if (option === null) return null;
  let fallback = bundledFallbackFamilies.get(option);
  if (fallback === undefined) {
    fallback = createFallbackFamilies(option);
    bundledFallbackFamilies.set(option, fallback);
  }
  return fallback;
}

// `bundledSystemFonts` is the result of `loadBundledSystemFonts()` from
// system-fonts.js, or null. With it, a generic family that the system font
// resolver does not resolve uses the bundled face, and the fallback
// families of the bundled font set are the registry fallback families when
// neither `fallbackFamilies` nor the source registry names others.
// `fallbackFamilies`: see createFallbackFamilies.
export function createFontRegistry(options = {}) {
  return createRegistry(options, null);
}

// `hostSources`: null, or a function that returns the host values that the
// resolver and the bundled fonts of the registry read at each request
// (defaultFontRegistry reads them from globalThis). When one of them
// changes, the registry forgets each answer that the earlier values gave
// (refreshHostAnswers).
function createRegistry({
  resolveSystemFontFamily = null,
  bundledSystemFonts = null,
  fallbackFamilies = null,
  core = sharedDomCore,
  sourceRegistry = null,
} = {}, hostSources) {
  const source = sourceRegistry === null ? null : registrySources.get(sourceRegistry);
  if (sourceRegistry !== null && !source) throw new TypeError("Unknown source font registry");
  resolveSystemFontFamily ??= source?.resolveSystemFontFamily ?? null;
  bundledSystemFonts ??= source?.bundledSystemFonts ?? null;
  hostSources ??= source?.hostSources ?? null;
  const explicitFallback = fallbackFamilies === null ? null : createFallbackFamilies(fallbackFamilies);
  // Read when the renderer asks, so that a host can install the bundled
  // fonts after the default registry exists.
  const currentFallback = () =>
    explicitFallback ?? source?.fallback() ?? fallbackFamiliesOfBundledFonts(bundledSystemFonts);
  if (
    resolveSystemFontFamily !== null &&
    typeof resolveSystemFontFamily !== "function"
  ) {
    throw new TypeError("resolveSystemFontFamily must be a function or null");
  }
  if (bundledSystemFonts !== null && typeof bundledSystemFonts?.familyFor !== "function") {
    throw new TypeError(`bundledSystemFonts must be the result of loadBundledSystemFonts() or null; it is ${bundledSystemFonts}`);
  }

  const runtimeFontFamilies = new Map();
  // Opaque host owner identities stay live exactly while native faces use them.
  const runtimeOwnerTokens = new Map();
  const facesByID = new Map();
  // The inspection record of each face whose bytes the core keeps:
  // { family, weight, stretch } (hosted and runtime faces).
  const keptFaceRecords = new Map();
  const faceIDs = new WeakMap();
  const familyKeys = new WeakMap();
  const listeners = new Set();
  const resources = new Map();
  let engineSourceTransport = null;
  let defaultFamilyKey = null;
  let nextOwnerToken = 1;
  let disposed = false;
  const genericFontFamilies = new Map();
  // The keys of the hosted families that this catalog holds.
  const hostedFamilyKeys = new Set();
  function recordHostSources() {
    const tokens = Uint32Array.from(hostSources(), hostValueToken);
    return core.status("font_catalog_host_sources", fontCatalogHandle,
      ...core.byteInput(new Uint8Array(tokens.buffer)));
  }
  let runtimeFontVersion = 0;
  const fontCatalogHandle = core.status("font_catalog_create");
  if (hostSources !== null) recordHostSources();
  const lifetime = {
    coreReference: new WeakRef(core),
    handle: fontCatalogHandle,
    resources,
    unsubscribe: null,
    sourceSync: 0n,
  };
  function changed() {
    defaultFamilyKey = null;
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    for (const listener of [...listeners]) listener(revision);
  }

  // Forgets each host answer of the catalog when a host value changed
  // (font_catalog_host_sources): the core removes the hosted and generic
  // families with their faces and font resources; the registry drops its
  // records of them. The next request asks the current host again, so a
  // document gets the answer that a fresh process gives.
  function refreshHostAnswers() {
    if (hostSources === null) return;
    const count = recordHostSources();
    if (count < 0) return;
    const report = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 16);
    const released = Array.from({ length: count }, (_, row) =>
      [report.getUint32(row * 16, true), report.getBigInt64(row * 16 + 8, true)]);
    for (const [faceID, resourceHandle] of released) {
      faceIDs.delete(facesByID.get(faceID));
      facesByID.delete(faceID);
      keptFaceRecords.delete(faceID);
      resources.delete(faceID);
      if (resourceHandle !== 0n) engineSourceTransport?.release({ resourceHandle });
    }
    for (const key of hostedFamilyKeys) familyKeys.delete(hostedFontFamilies.get(key));
    for (const specification of genericFontFamilies.values()) familyKeys.delete(specification);
    hostedFamilyKeys.clear();
    genericFontFamilies.clear();
    changed();
  }

  // weight: "auto" (an absent or auto font-weight descriptor), one CSS
  // weight, or the [minimum, maximum] range of a variable face's
  // font-weight descriptor. Face matching takes "auto" as 400; a file with
  // a 'wght' axis instances it at the requested weight ("auto", as Blink's
  // range set from auto does) or the requested weight clamped into the
  // range.
  // stretch: "auto" (an absent or auto font-stretch descriptor), one CSS
  // stretch percentage, or a [minimum, maximum] range. Face matching takes
  // "auto" as 100%; a file with a 'wdth' axis instances it at the requested
  // stretch ("auto"), the one value, or the requested stretch clamped into
  // the range (CSS Fonts 4, 4.4 and 5.2).
  // style: an @font-face font-style descriptor (fontFaceStyleDescriptor):
  // auto, normal, italic, oblique, or oblique with one or two angles. Face
  // matching takes auto as normal; a file with a 'slnt' axis instances it
  // at the requested oblique angle (auto) or the angle clamped into the
  // face's slope range.
  // unicodeRange: the {start, end} scalar pairs of an @font-face
  // unicode-range descriptor (DomCore.fontUnicodeRanges), or null for
  // U+0-10FFFF. The face applies only to the scalars of its range
  // (design/text-rendering.md, "unicode-range faces").
  // document: the document of the @font-face rule that supplies the face,
  // or null. Only that document selects a face of a document; a face
  // without a document serves every document of the registry.
  function registerRuntimeFont(
    cssFamily,
    bytes,
    { weight = 400, stretch = "auto", style = "normal", unicodeRange = null, finalURL = null, owner = null, document = null } = {},
  ) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Runtime font bytes must be a Uint8Array");
    }
    const descriptor = runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange });
    return publishRuntimeFace(descriptor, {
      bytes,
      version: ++runtimeFontVersion,
      finalURL,
      owner,
      document: ownerDocument(document),
    });
  }

  // The document of a runtime face: null, or a document of this
  // registry's core.
  function ownerDocument(document) {
    if (document === null) return null;
    if (document?._domCore !== core) {
      throw new TypeError(
        `A runtime font face belongs to a document of the font registry's core or to no document; got ${document}`,
      );
    }
    return document;
  }


  // Declares the face of an @font-face rule with a unicode-range
  // descriptor before its bytes load (item 3 of "unicode-range faces" in
  // design/text-rendering.md). The face joins the font stack of
  // its family as an unloaded range face. When the text needs it, the
  // renderer calls loadDeclaredFace, which calls `load`; `load` registers
  // the bytes with registerRuntimeFont and the same owner, and returns a
  // promise that settles after that registration or with the load error.
  function declareRuntimeFont(
    cssFamily,
    { weight = 400, stretch = "auto", style = "normal", unicodeRange, owner, load, document = null } = {},
  ) {
    if (!(unicodeRange instanceof Uint32Array)) {
      throw new TypeError(`A declared runtime font needs its unicode-range pairs as a Uint32Array; got ${unicodeRange}`);
    }
    if (typeof load !== "function") {
      throw new TypeError(`A declared runtime font needs a load function; got ${load}`);
    }
    const descriptor = runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange });
    return publishRuntimeFace(descriptor, {
      bytes: null,
      version: ++runtimeFontVersion,
      finalURL: null,
      owner,
      load,
      document: ownerDocument(document),
    });
  }

  // Numeric conversion belongs to the host; descriptor policy belongs to WAT.
  function runtimeFaceDescriptor(cssFamily, { weight, stretch, style, unicodeRange }) {
    if (unicodeRange !== null && !(unicodeRange instanceof Uint32Array)) {
      throw new TypeError("Runtime font unicodeRange must be null or a Uint32Array");
    }
    const weights = Array.isArray(weight) ? weight : [weight, weight];
    const stretches = Array.isArray(stretch) ? stretch : [stretch, stretch];
    core.status(
      "font_runtime_descriptor", ...core.input(String(cssFamily)),
      ...core.input(typeof weight === "string" ? weight : ""), Number(weights[0]), Number(weights[1]),
      ...core.input(typeof stretch === "string" ? stretch : ""), Number(stretches[0]), Number(stretches[1]),
      ...core.input(String(style)), unicodeRange?.byteLength ?? 0,
    );
    const pointer = core.exports.abi_output_pointer();
    const bytes = core.refreshBytes();
    const descriptor = new DataView(bytes.buffer, pointer, 56);
    return {
      name: new TextDecoder().decode(bytes.subarray(pointer + 56, pointer + core.exports.abi_output_length())),
      weightMinimum: descriptor.getFloat64(0, true),
      weightMaximum: descriptor.getFloat64(8, true),
      stretchMinimum: descriptor.getFloat64(16, true),
      stretchMaximum: descriptor.getFloat64(24, true),
      weightAuto: descriptor.getUint32(32, true) !== 0,
      stretchAuto: descriptor.getUint32(36, true) !== 0,
      initialWeight: descriptor.getFloat64(40, true),
      initialStretch: descriptor.getFloat64(48, true),
      style: String(style),
      unicodeRange,
    };
  }

  // Publishes a runtime face of `descriptor` (runtimeFaceDescriptor) with
  // `fields`; the face of the same owner is updated in place, so that a
  // declared face keeps its catalog ID, and its place among the faces of
  // the family, when it loads. Native publication selects the document family
  // and the face of the opaque owner. Host records retain byte/load effects
  // and inspection values, keyed by the returned native identities.
  function publishRuntimeFace({ name, ...descriptor }, { document, ...fields }) {
    const face = { ...descriptor, ...fields };
    let ownerBinding = runtimeOwnerTokens.get(fields.owner);
    if (!ownerBinding) {
      ownerBinding = { token: nextOwnerToken++, references: 0 };
      runtimeOwnerTokens.set(fields.owner, ownerBinding);
    }
    const ranges = descriptor.unicodeRange;
    let faceID;
    try {
      faceID = core.status(
        "font_runtime_face_publish", fontCatalogHandle, document?._coreHandle ?? 0n,
        engineSourceTransport?.ensureScope() ?? 0n, ownerBinding.token,
        ...core.input(name), descriptor.weightMinimum, descriptor.weightMaximum, descriptor.weightAuto ? 1 : 0,
        descriptor.stretchMinimum, descriptor.stretchMaximum, descriptor.stretchAuto ? 1 : 0,
        ...core.input(descriptor.style),
        ...core.byteInput(ranges === null
          ? new Uint8Array(0)
          : new Uint8Array(ranges.buffer, ranges.byteOffset, ranges.byteLength)),
        ...core.byteInput(fields.bytes ?? new Uint8Array(0)),
      );
    } catch (error) {
      if (ownerBinding.references === 0) runtimeOwnerTokens.delete(fields.owner);
      throw error;
    }
    const outputPointer = core.exports.abi_output_pointer();
    const output = core.refreshBytes().slice(outputPointer, outputPointer + core.exports.abi_output_length());
    const report = new DataView(output.buffer, output.byteOffset, 16);
    const index = report.getInt32(4, true);
    const resourceHandle = report.getBigInt64(8, true);
    const key = new TextDecoder().decode(output.subarray(16));
    const existing = facesByID.get(faceID);
    const registered = existing ?? face;
    if (!existing) ownerBinding.references++;
    let specification = runtimeFontFamilies.get(key);
    if (!specification) {
      specification = { cssFamily: name, faces: [], ofDocument: document !== null };
      runtimeFontFamilies.set(key, specification);
      familyKeys.set(specification, key);
    }
    if (existing) Object.assign(existing, face);
    else specification.faces.push(face);
    faceIDs.set(registered, faceID);
    facesByID.set(faceID, registered);
    if (fields.bytes) {
      // `document`: the handle of the face's document, 0n for a face of
      // every document; the renderer names an engine instance after a face
      // the rendered document can select.
      const record = {
        family: key,
        weight: descriptor.initialWeight,
        stretch: descriptor.initialStretch,
        document: document?._coreHandle ?? 0n,
      };
      keptFaceRecords.set(faceID, record);
      resources.set(faceID, resourceHandle);
      if (index >= 0) engineSourceTransport.recordFaceInstance(index, { ...record, face: registered, resourceHandle });
    }
    changed();
    return key;
  }

  // Loads the declared face `faceID` of this registry's catalog (an
  // unloaded range face that a shaped text needs): the promise of its
  // `load` (declareRuntimeFont).
  function loadDeclaredFace(faceID) {
    const face = facesByID.get(faceID);
    if (typeof face?.load !== "function") {
      throw new Error(registryMessage(core, 3, Number(faceID)));
    }
    return face.load();
  }

  function unregisterRuntimeFont(familyKey, owner) {
    const ownerBinding = runtimeOwnerTokens.get(owner);
    const removed = core.status("font_runtime_face_remove", fontCatalogHandle,
      ...core.input(familyKey), ownerBinding?.token ?? 0);
    if (removed === 0) return;
    const faceID = new DataView(core.refreshBytes().buffer,
      core.exports.abi_output_pointer(), 4).getUint32(0, true);
    const face = facesByID.get(faceID);
    const resourceHandle = resources.get(faceID);
    const specification = runtimeFontFamilies.get(familyKey);
    specification.faces.splice(specification.faces.indexOf(face), 1);
    if (removed === 2) runtimeFontFamilies.delete(familyKey);
    faceIDs.delete(face);
    facesByID.delete(faceID);
    keptFaceRecords.delete(faceID);
    resources.delete(faceID);
    ownerBinding.references--;
    if (ownerBinding.references === 0) runtimeOwnerTokens.delete(owner);
    runtimeFontVersion++;
    if (resourceHandle !== undefined) engineSourceTransport?.release({ resourceHandle });
    changed();
  }

  async function loadFont(
    cssFamily,
    source,
    { weight = 400, stretch = "auto", style = "normal", host = null } = {},
  ) {
    const name = normalizedFamilyName(cssFamily, false, core);
    if (!name) throw new TypeError(registryMessage(core, 7, 0));
    let bytes;
    let finalURL = null;
    if (source instanceof Uint8Array) {
      bytes = source;
    } else if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source);
    } else if (source instanceof URL || typeof source === "string") {
      // A locator source is a font demand: the host obtains it.
      let sourceURL;
      try {
        sourceURL = new URL(source);
      } catch (cause) {
        throw new TypeError(
          `Font source ${JSON.stringify(String(source))} must be bytes or an absolute URL`,
          { cause },
        );
      }
      if (host === null) {
        throw new TypeError(
          `Font source ${sourceURL.href} is a locator; loadFont needs { host } to obtain it`,
        );
      }
      const loader = createDocumentResourceLoader({ host, documentURL: sourceURL.href });
      try {
        const resource = await loader.resolveResource({
          requestedURL: sourceURL.href,
          kind: "font",
        });
        bytes = resource.bytes;
        finalURL = resource.finalURL;
      } finally {
        await loader.release();
      }
    } else {
      throw new TypeError(
        "Font source must be an absolute URL, Uint8Array, or ArrayBuffer",
      );
    }
    const owner = {};
    const family = registerRuntimeFont(name, bytes, {
      weight,
      stretch,
      style,
      finalURL,
      owner,
    });
    return Object.freeze({
      family,
      unload() {
        unregisterRuntimeFont(family, owner);
      },
    });
  }

  function runtimeFontFamily(key) {
    return runtimeFontFamilies.get(key) ?? null;
  }

  function familySpec(familyKey) {
    const specification = lookupFamily(familyKey);
    if (specification === null) throw new Error(registryMessage(core, 0, 0, String(familyKey)));
    return specification;
  }

  // The family record of a key or authored family name, or null when no
  // family of the registry or its host matches. The core names the CSS
  // family value of the key and whether the key itself selects first
  // (font_family_key_value).
  function lookupFamily(familyKey) {
    const registered = (localKey) =>
      runtimeFontFamilies.get(localKey) ?? hostedFontFamilies.get(localKey) ?? genericFontFamilies.get(localKey);
    const kind = core.status("font_family_key_value", ...core.input(String(familyKey)));
    const value = core.outputString() ?? "";
    let specification = kind === 1 ? undefined : registered(familyKey);
    if (!specification) {
      const [localKey] = stackKeys(value).keys;
      if (localKey !== undefined) specification = registered(localKey);
    }
    if (!specification) return null;
    // Runtime and generic records belong to this registry; a hosted record
    // is realm-wide, and another registry may have resolved it.
    if (!familyKeys.has(specification)) publishSharedHostedFamily(specification);
    return specification;
  }

  // Publishes in this catalog a realm-wide hosted family record another
  // registry resolved, as the family session does
  // (font_hosted_family_publish).
  function publishSharedHostedFamily(specification) {
    core.status(
      "font_hosted_family_publish", fontCatalogHandle,
      ...core.input(specification.familyIdentity), ...core.input(specification.cssFamily),
      ...core.input(specification.fallback ?? ""), specification.variable === true ? 1 : 0,
      Number.isFinite(specification.zeroAdvanceRatio) ? specification.zeroAdvanceRatio : NaN,
    );
    const key = core.outputString() ?? "";
    familyKeys.set(specification, key);
    hostedFamilyKeys.add(key);
    changed();
  }

  // The family record a system font resolver returned for `authoredName`,
  // or null. The core checks and normalizes its identity, CSS family and
  // fallback (font_host_family_record).
  function hostFamilyRecord(authoredName, resolved) {
    if (resolved === null || resolved === undefined) return null;
    if (typeof resolved !== "object") {
      throw new TypeError(
        "A system font family resolver must return an object or null",
      );
    }
    if (typeof resolved.resolveFace !== "function") {
      throw new TypeError(
        "A resolved system font family must provide resolveFace",
      );
    }
    const cssPresent = resolved.cssFamily !== undefined && resolved.cssFamily !== null;
    const fallbackPresent = resolved.fallback !== undefined && resolved.fallback !== null;
    core.exports.font_host_family_record(
      ...core.input(String(resolved.familyIdentity ?? "")),
      ...core.input(cssPresent ? String(resolved.cssFamily) : ""), Number(cssPresent),
      ...core.input(String(authoredName)),
      ...core.input(fallbackPresent ? String(resolved.fallback) : ""), Number(fallbackPresent),
    );
    core.throwIfError(true);
    const bytes = core.refreshBytes();
    const pointer = core.exports.abi_output_pointer();
    const lengths = new DataView(bytes.buffer, pointer, 12);
    const decoder = new TextDecoder();
    let cursor = pointer + 12;
    const [identity, cssFamily, fallback] = [0, 4, 8].map((offset) => {
      const start = cursor;
      cursor += lengths.getUint32(offset, true);
      return decoder.decode(bytes.subarray(start, cursor));
    });
    return {
      identity,
      specification: {
        familyIdentity: identity,
        cssFamily,
        fallback,
        zeroAdvanceRatio: resolved.zeroAdvanceRatio,
        // Variable families instance the 'wght' axis at registration;
        // static families register their weight's file as-is.
        variable: resolved.variable === true,
        resolveFace: resolved.resolveFace,
        faces: new Map(),
      },
    };
  }

  // The family record of a system family named `name`: the host's system
  // resolver answers first; bundled system fonts are installed under their
  // own names too.
  function systemFamilyRecord(name) {
    return hostFamilyRecord(
      name,
      (resolveSystemFontFamily === null ? null : resolveSystemFontFamily(name)) ??
        bundledSystemFonts?.familyNamed?.(name) ?? null,
    );
  }

  // Keeps the specification of hosted family `key`, which the core
  // published; the first record of a key stays.
  function adoptHostedFamily(key, specification) {
    if (!hostedFontFamilies.has(key)) hostedFontFamilies.set(key, specification);
    familyKeys.set(hostedFontFamilies.get(key), key);
    hostedFamilyKeys.add(key);
  }

  // Answers every font-family value the cascade of `document` requested
  // (font_answer_next). The core resolves, publishes and records; the
  // registry supplies system family records, generic family records and
  // the metrics face of a family.
  function answerFontFamilies(document) {
    refreshHostAnswers();
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    const session = core.status("font_answer_begin", fontCatalogHandle, document._coreHandle);
    try {
      runFamilySession(session);
    } finally {
      core.status("font_answer_end", session);
    }
    if (core.status("font_catalog_revision", fontCatalogHandle) !== revision) changed();
  }

  // Answers the requests of a family session until it finishes: system and
  // generic family records, and the metrics face of a family.
  function runFamilySession(session) {
    for (;;) {
      const request = core.status("font_answer_next", session);
      if (request === 0) return;
      const name = core.outputString() ?? "";
      const token = core.status("font_answer_token", session);
      if (request === 1 || request === 2) {
        const record = request === 1
          ? systemFamilyRecord(name)
          : genericFamilyRecord(name);
        const specification = record?.specification;
        core.status(
          "font_answer_family", session, token,
          ...core.input(record?.identity ?? ""),
          ...core.input(specification?.cssFamily ?? ""),
          ...core.input(specification?.fallback ?? ""),
          specification?.variable === true ? 1 : 0,
          Number.isFinite(specification?.zeroAdvanceRatio) ? specification.zeroAdvanceRatio : NaN,
        );
        const key = core.outputString() ?? "";
        if (request === 1 && record !== null) adoptHostedFamily(key, record.specification);
        if (request === 2) adoptGenericFamily(key, name, specification ?? null);
      } else {
        const face = metricsFace(name);
        core.status(
          "font_answer_metrics", session, token,
          face?.catalogID ?? 0, face?.resourceHandle ?? 0n,
          ...core.byteInput(face?.bytes ?? new Uint8Array(0)), face?.faceIndex ?? 0,
        );
      }
    }
  }

  // The family record of generic family `name`: its bundled font, or null
  // for a generic family without faces.
  function genericFamilyRecord(name) {
    const bundled = bundledSystemFonts?.familyFor(name) ?? null;
    if (bundled === null) return null;
    return {
      identity: bundled.familyIdentity,
      specification: { ...bundled, cssFamily: name, faces: new Map() },
    };
  }

  function adoptGenericFamily(key, name, specification) {
    if (!genericFontFamilies.has(key)) {
      genericFontFamilies.set(key, specification ?? { cssFamily: name, fallback: name, faces: new Map() });
    }
    familyKeys.set(genericFontFamilies.get(key), key);
  }

  function fontFamilyCssValue(familyKey) {
    const specification = familySpec(familyKey);
    return core.string(
      "font_catalog_css", fontCatalogHandle,
      ...core.input(familyKeys.get(specification)),
    ) ?? "";
  }

  // The authored stack of a CSS font-family value: the key of each
  // available family in authored order, resolved by the core
  // (font_stack_begin). Key 0 is the primary family. A value without an
  // available family throws. `document`: the document whose @font-face
  // families the value can also select, or null for the families of every
  // document only.
  function fontStackKeysForCssValue(cssValue, { document = null } = {}) {
    const { keys, error } = stackKeys(cssValue, document);
    if (keys.length === 0) throw new Error(error);
    return keys;
  }

  // The keys of the available families of a CSS font-family value, in
  // authored order, with the host asked for each family as a resolution
  // does; none when no family of the value is available.
  function availableFontStackKeys(cssValue, { document = null } = {}) {
    return stackKeys(cssValue, document).keys;
  }

  // The family keys of a font-family value; none, with the core's reason,
  // when no family of the value is available.
  function stackKeys(cssValue, document = null) {
    refreshHostAnswers();
    const documentHandle = document === null ? 0n : ownerDocument(document)._coreHandle;
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    const session = core.status("font_stack_begin", fontCatalogHandle, documentHandle, ...core.input(String(cssValue)));
    try {
      runFamilySession(session);
      const count = core.status("font_stack_key_count", session);
      if (count === 0) return { keys: [], error: core.string("font_stack_error", session) ?? "" };
      return {
        keys: Array.from({ length: count }, (_, index) => core.string("font_stack_key_at", session, index) ?? ""),
        error: null,
      };
    } finally {
      core.status("font_answer_end", session);
      if (core.status("font_catalog_revision", fontCatalogHandle) !== revision) changed();
    }
  }

  // stretch: the requested CSS font-stretch percentage. It selects among a
  // runtime family's faces and sets variationWidth, the 'wdth' coordinate
  // the face instances at when its file has that axis (the renderer
  // registers a file without one as-is). A host resolver's face instances
  // 'wdth' at the requested stretch, as a runtime face with an auto
  // descriptor does.
  // slope: the requested font-style slope in degrees (0 normal, 14 italic
  // and a plain oblique, else the oblique angle; the core's face table
  // states it). It selects among a runtime family's faces and sets
  // variationSlant, the 'slnt' coordinate the face instances at when its
  // file has that axis: the negated slope clamped into the face's slope
  // range, or unclamped for an auto descriptor and a host resolver's face.
  // italicFace states whether the face slants its own glyphs; Chrome
  // synthesizes a slant for a slope of 14deg or more on any other face.
  function importHostFontSource(familyKey, weight, style) {
    const specification = hostedFontFamilies.get(familyKey) ?? genericFontFamilies.get(familyKey);
    if (!specification?.resolveFace) {
      throw new Error(registryMessage(core, 2, 0, String(familyKey)));
    }
    const face = hostFontFace(specification, Number(weight), style);
    return face;
  }

  // The face a hosted family's provider resolves for a weight and host
  // style ("normal", "italic" or "oblique"). The provider's answer is
  // cached on the realm-wide family specification; the core checks the
  // bytes, publishes the face, its font resource and its engine source in
  // this registry's catalog (font_hosted_face_supply).
  function hostFontFace(specification, requestedWeight, hostStyle) {
    const request = fontLoadRequestFor(specification, 0, requestedWeight, hostStyle);
    let face = specification.faces.get(request);
    if (!face) {
      const resolved = specification.resolveFace(requestedWeight, hostStyle);
      if (!resolved || !(resolved.bytes instanceof Uint8Array)) {
        throw new Error(registryMessage(core, 1, 0, String(specification.cssFamily)));
      }
      face = {
        bytes: resolved.bytes, faceIndex: Number(resolved.faceIndex ?? 0),
        italicFace: core.status("font_style_is_italic", ...core.input(String(resolved.style))) !== 0,
        version: resolved.faceIdentity ?? resolved.finalURL ?? null,
        finalURL: resolved.finalURL ?? null,
      };
    }
    if (!faceIDs.has(face)) {
      const styleCode = core.status("font_host_style_code", ...core.input(String(hostStyle)));
      const key = familyKeys.get(specification);
      const scope = engineSourceTransport?.ensureScope() ?? 0n;
      const faceID = core.status(
        "font_hosted_face_supply", fontCatalogHandle, scope, ...core.input(key),
        requestedWeight, styleCode,
        ...core.byteInput(face.bytes), face.faceIndex,
      );
      const report = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 16);
      const index = report.getInt32(4, true);
      const resource = report.getBigInt64(8, true);
      faceIDs.set(face, faceID);
      facesByID.set(faceID, face);
      const record = { family: key, weight: requestedWeight, stretch: 100, document: 0n };
      keptFaceRecords.set(faceID, record);
      resources.set(faceID, resource);
      specification.faces.set(request, face);
      if (index >= 0) engineSourceTransport.recordFaceInstance(index, { ...record, face, resourceHandle: resource });
      changed();
    }
    return face;
  }

  // Registers every face whose bytes the core keeps (hosted and runtime
  // faces) in the renderer's scope.
  function registerKeptFaces() {
    const count = core.status("font_catalog_faces_register", fontCatalogHandle, engineSourceTransport.ensureScope());
    const report = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * 16);
    const rows = Array.from({ length: count }, (_, row) => ({
      faceID: report.getInt32(row * 16, true),
      index: report.getInt32(row * 16 + 4, true),
      resourceHandle: report.getBigInt64(row * 16 + 8, true),
    }));
    for (const { faceID, index, resourceHandle } of rows) {
      engineSourceTransport.recordFaceInstance(index, {
        ...keptFaceRecords.get(faceID), face: facesByID.get(faceID), resourceHandle,
      });
    }
  }

  function fontFileFor(familyKey, weight, style = "normal", stretch = 100, slope = defaultSlope(core, style)) {
    const face = faceFor(familyKey, weight, style, stretch, slope);
    if (face !== null) return face;
    const specification = familySpec(familyKey);
    const kind = !(specification.faces instanceof Map) ? 0 : resolveSystemFontFamily === null ? 1 : 2;
    core.status("font_family_face_error", ...core.input(specification.cssFamily),
      ...core.input(String(familyKey)), kind);
  }

  // The face fontFileFor returns, or null when the family has no face: a
  // generic family without a resolver face, or a runtime family without a
  // loaded face. A host resolver's failure throws.
  function faceFor(familyKey, weight, style = "normal", stretch = 100, slope = defaultSlope(core, style)) {
    refreshHostAnswers();
    const specification = familySpec(familyKey);
    if (specification.resolveFace) {
      // A platform font request asks for an upright face at a slope of 0deg
      // or less, as Chrome's does.
      const hostStyle = core.string("font_request_style", ...core.input(String(style)), Number(slope));
      const face = hostFontFace(specification, Number(weight), hostStyle);
      // The host resolver returns the physical face for this exact request.
      // Retain that imported identity; a later host request must not replace
      // the already cached result (including coercion-time reentrant calls).
      const catalogID = faceIDs.get(face);
      return {
        ...face,
        catalogID,
        resourceHandle: resources.get(catalogID),
        variationWeight: core.status("font_catalog_instance_weight", fontCatalogHandle,
          ...core.input(familyKeys.get(specification)), Number(weight)),
        variationWidth: Number(stretch),
        variationSlant: core.exports.font_slant_coordinate(Number(slope)),
      };
    }
    if (specification.faces instanceof Map) return null;
    const faceID = core.status(
      "font_face_instance", fontCatalogHandle, ...core.input(familyKeys.get(specification)),
      Number(weight), Number(stretch), Number(slope),
    );
    if (faceID === 0) return null;
    const instance = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 32);
    const face = facesByID.get(faceID);
    return {
      bytes: face.bytes,
      faceIndex: Number(face.faceIndex ?? 0),
      italicFace: instance.getInt32(24, true) !== 0,
      version: face.version,
      finalURL: face.finalURL,
      catalogID: faceID,
      resourceHandle: resources.get(faceID),
      variationWeight: instance.getFloat64(0, true),
      variationWidth: instance.getFloat64(8, true),
      variationSlant: instance.getFloat64(16, true),
    };
  }

  function fontWeightInCssUnits(value = 4) {
    return core.exports.font_weight_css(Number(value));
  }

  function fontWeightInSceneUnits(value = 4) {
    return core.exports.font_weight_scene(Number(value));
  }

  // Whether register_font should instance the 'wght' axis (variable) or
  // register the file as-is (static: weight comes from the file itself).
  function isVariableFamily(familyKey) {
    const specification = familySpec(familyKey);
    return (core.status(
      "font_catalog_family_flags", fontCatalogHandle,
      ...core.input(familyKeys.get(specification)),
    ) & 1) !== 0;
  }

  // CSS Values and Units, "ch": when it is impossible or impractical to
  // determine the measure of the "0" glyph, it must be assumed to be
  // 0.5em wide. A ch declaration is valid either way, so the ratio never
  // classifies it as invalid.
  // A family the registry cannot find, a generic family without a face and
  // a runtime family with no loaded face have no "0" glyph to measure, so
  // their ratio is the specified 0.5em. Every other failure (a host
  // resolver that throws, or one that names a family and returns no usable
  // face) throws and names the family.
  function zeroAdvanceRatioFor(familyKey) {
    const specification = lookupFamily(familyKey);
    if (specification === null) {
      return core.status(
        "font_catalog_metric", fontCatalogHandle, ...core.input(""), 0,
      );
    }
    const key = familyKeys.get(specification);
    const revision = core.status("font_catalog_revision", fontCatalogHandle);
    if (core.status("font_family_metrics", fontCatalogHandle, ...core.input(key)) === 0) {
      const face = metricsFace(key);
      core.status(
        "font_family_metrics_face", fontCatalogHandle, ...core.input(key),
        face?.catalogID ?? 0, face?.resourceHandle ?? 0n,
        ...core.byteInput(face?.bytes ?? new Uint8Array(0)), face?.faceIndex ?? 0,
      );
    }
    if (core.status("font_catalog_revision", fontCatalogHandle) !== revision) changed();
    return core.status(
      "font_catalog_metric", fontCatalogHandle, ...core.input(key), 0,
    );
  }

  // The weight 400 normal face of a family, whose metrics the core reads,
  // or null when the family has no face (faceFor): ch then uses 0.5em.
  // A face the host fails to supply throws, naming the family and the
  // cause.
  function metricsFace(key) {
    try {
      return faceFor(key, 400, "normal");
    } catch (cause) {
      const family = lookupFamily(key)?.cssFamily ?? key;
      throw new Error(registryMessage(core, 4, 0, String(family), String(cause?.message ?? cause)), { cause });
    }
  }

  const registry = Object.freeze({
    core,
    fontCatalogHandle,
    // The registry fallback families (createFallbackFamilies), or null.
    get fallbackFamilies() {
      return currentFallback();
    },
    get revision() {
      return core.status("font_catalog_revision", fontCatalogHandle);
    },
    bindDocument(document) {
      if (document._domCore !== core) throw new TypeError("Font registry belongs to another renderer core");
      core.status("font_catalog_bind_document", fontCatalogHandle, document._coreHandle);
    },
    unbindDocument(document) {
      if (document._domCore !== core) throw new TypeError("Font registry belongs to another renderer core");
      if (disposed) return;
      core.status("font_catalog_unbind_document", fontCatalogHandle, document._coreHandle);
    },
    subscribe(listener, options = null) {
      if (options?.weak === true) {
        return subscribeFontSource(registry, new WeakRef(listener));
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachEngineSourceTransport(transport) {
      if (engineSourceTransport !== null) throw new Error("Font catalog already has a renderer source owner");
      engineSourceTransport = transport;
      if (keptFaceRecords.size !== 0) registerKeptFaces();
    },
    prepareNativeFontPublication(root) {
      refreshHostAnswers();
      if (engineSourceTransport === null) return;
      registry.bindDocument(root.nodeType === 9 ? root : root.ownerDocument);
      defaultFamilyKey ??= fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0];
      engineSourceTransport.prepare(root, defaultFamilyKey, importHostFontSource);
    },
    replayEngineSources() {
      if (keptFaceRecords.size !== 0) registerKeptFaces();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.unsubscribe?.();
      lifetime.unsubscribe = null;
      registrySources.get(registry).synchronize = null;
      listeners.clear();
      engineSourceTransport = null;
      for (const resource of resources.values()) core.status("resource_release", resource);
      if (lifetime.sourceSync !== 0n) core.status("font_source_sync_release", lifetime.sourceSync);
      resources.clear();
      runtimeOwnerTokens.clear();
      core.status("font_catalog_release", fontCatalogHandle);
      fontCatalogFinalizer.unregister(registry);
    },
    registerRuntimeFont,
    declareRuntimeFont,
    loadDeclaredFace,
    unregisterRuntimeFont,
    loadFont,
    runtimeFontFamily,
    fontFamilyCssValue,
    fontStackKeysForCssValue,
    availableFontStackKeys,
    fontFileFor,
    fontWeightInCssUnits,
    fontWeightInSceneUnits,
    isVariableFamily,
    zeroAdvanceRatioFor,
    answerFontFamilies,
    refreshHostAnswers,
  });
  fontCatalogFinalizer.register(registry, lifetime, registry);
  registrySources.set(registry, {
    runtimeFontFamilies,
    resolveSystemFontFamily,
    bundledSystemFonts,
    hostSources,
    fallback: currentFallback,
    get version() { return runtimeFontVersion; },
  });
  if (source) {
    // A standalone persistent renderer needs its own native catalog/resource
    // handles, while immutable font bytes and authored family keys stay shared.
    // The faces of a document stay with that document: the registry made
    // from a source serves other cores, which hold no document of the source.
    // The core decides which source faces to copy and which copies to
    // remove (font_source_sync_face, font_source_sync_stale); the registry
    // copies the source face's descriptor and bytes.
    const sync = core.status("font_source_sync_create");
    lifetime.sourceSync = sync;
    const copies = new Map();
    const faceTokens = new WeakMap();
    let nextFaceToken = 1;
    let synchronizedVersion = -1;
    const synchronizeSource = () => {
      if (synchronizedVersion === source.version) return;
      synchronizedVersion = source.version;
      for (const [key, specification] of source.runtimeFontFamilies) {
        for (const face of specification.faces) {
          let token = faceTokens.get(face);
          if (token === undefined) faceTokens.set(face, token = nextFaceToken++);
          if (core.status("font_source_sync_face", sync, token, face.version, specification.ofDocument ? 1 : 0) === 0) continue;
          const {
            weightMinimum, weightMaximum, weightAuto, stretchMinimum, stretchMaximum, stretchAuto,
            initialWeight, initialStretch, style, unicodeRange,
          } = face;
          const descriptor = {
            name: specification.cssFamily, weightMinimum, weightMaximum, weightAuto, stretchMinimum,
            stretchMaximum, stretchAuto, initialWeight, initialStretch, style, unicodeRange: unicodeRange ?? null,
          };
          // A declared face loads through its source registry's load.
          publishRuntimeFace(descriptor, face.bytes === null
            ? { bytes: null, version: ++runtimeFontVersion, finalURL: null, owner: face, load: face.load, document: null }
            : { bytes: face.bytes, version: ++runtimeFontVersion, finalURL: face.finalURL, owner: face, document: null });
          copies.set(token, { key, face });
        }
      }
      const count = core.status("font_source_sync_stale", sync);
      const pointer = core.exports.abi_output_pointer();
      const stale = new Uint32Array(core.refreshBytes().slice(pointer, pointer + count * 4).buffer);
      for (const token of stale) {
        const { key, face } = copies.get(token);
        copies.delete(token);
        unregisterRuntimeFont(key, face);
      }
    };
    synchronizeSource();
    // Keep the listener alive with this registry, never with its source.
    registrySources.get(registry).synchronize = synchronizeSource;
    lifetime.unsubscribe = subscribeFontSource(sourceRegistry, new WeakRef(synchronizeSource));
  }
  return registry;
}

// The default module registry consults a host-installed resolver and the
// installed bundled system fonts lazily on every unresolved family, so the
// host (a test harness, a shell, a page) can seed the process before or
// after this module evaluates — the same seeding pattern as sandom.hbBytes.
// When the host installs another resolver or other bundled fonts, or
// removes them, the registry forgets the answers of the earlier ones.
export const defaultFontRegistry = createRegistry({
  resolveSystemFontFamily: (name) => {
    const resolver = globalThis[Symbol.for("sandom.resolveSystemFontFamily")];
    return resolver ? resolver(name) : null;
  },
  bundledSystemFonts: {
    familyFor: (name) => globalThis[Symbol.for("sandom.bundledSystemFonts")]?.familyFor(name) ?? null,
    familyNamed: (name) => globalThis[Symbol.for("sandom.bundledSystemFonts")]?.familyNamed(name) ?? null,
    // The bundled fonts' fallback families, else those that a host with
    // its own generic faces installed (installFontSetFallbackFamilies).
    get fallbackFamilies() {
      return globalThis[Symbol.for("sandom.bundledSystemFonts")]?.fallbackFamilies ??
        globalThis[Symbol.for("sandom.fontSetFallbackFamilies")] ?? null;
    },
  },
}, () => [
  globalThis[Symbol.for("sandom.resolveSystemFontFamily")],
  globalThis[Symbol.for("sandom.bundledSystemFonts")],
]);
sharedDomCore.defaultFontRegistry = defaultFontRegistry;

export const registerRuntimeFont = (...arguments_) =>
  defaultFontRegistry.registerRuntimeFont(...arguments_);
export const unregisterRuntimeFont = (...arguments_) =>
  defaultFontRegistry.unregisterRuntimeFont(...arguments_);
export const loadFont = (...arguments_) =>
  defaultFontRegistry.loadFont(...arguments_);
export const runtimeFontFamily = (...arguments_) =>
  defaultFontRegistry.runtimeFontFamily(...arguments_);
export const fontFamilyCssValue = (...arguments_) =>
  defaultFontRegistry.fontFamilyCssValue(...arguments_);
export const fontStackKeysForCssValue = (...arguments_) =>
  defaultFontRegistry.fontStackKeysForCssValue(...arguments_);
export const fontFileFor = (...arguments_) =>
  defaultFontRegistry.fontFileFor(...arguments_);
export const fontWeightInCssUnits = (...arguments_) =>
  defaultFontRegistry.fontWeightInCssUnits(...arguments_);
export const fontWeightInSceneUnits = (...arguments_) =>
  defaultFontRegistry.fontWeightInSceneUnits(...arguments_);
export const isVariableFamily = (...arguments_) =>
  defaultFontRegistry.isVariableFamily(...arguments_);
export const zeroAdvanceRatioFor = (...arguments_) =>
  defaultFontRegistry.zeroAdvanceRatioFor(...arguments_);
