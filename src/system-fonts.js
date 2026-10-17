// The bundled fonts: the sandom-fonts library set
// (design/font-fallback.md, "Fallback set decisions"). The set holds faces for the CSS
// generic families, used when a document declares no @font-face for them and
// the host supplies no system font resolver:
//
//   sans-serif, system-ui, ui-sans-serif  -> Inter (variable weight axis)
//   monospace, ui-monospace                -> IBM Plex Mono (static faces)
//   serif, ui-serif                        -> Crimson Text (static faces)
//   cursive                                -> Dancing Script (variable weight axis)
//   fantasy                                -> Lobster (one face)
//
// and the Noto fallback families with their coverage index
// (src/font-coverage.js), which paint each script that no authored face
// covers.
//
// The fonts are opt-in, and importing Sandom reads none of them. A host
// enables them before the first render with `await installBundledSystemFonts()`,
// which enables them for the default font registry, or passes
// `await loadBundledSystemFonts()` as the `bundledSystemFonts` option of
// createFontRegistry, createSceneRendererRuntime or createSandomRuntime.
// The font registry resolves generic faces synchronously during shaping, so
// both functions read the generic faces (about 2.4 MB), the set manifest, and
// the coverage index before they return. A fallback face loads only when a
// text cluster needs it. When the host installs the bundled fonts, the
// default font registry forgets the generic families it resolved before. A
// host with its own generic faces passes
// `await loadFontSetFallbackFamilies()` as the `fallbackFamilies` option of
// createFontRegistry or createSceneRendererRuntime instead, or enables them
// for the default font registry with `await installFontSetFallbackFamilies()`.
//
// Where the set is read. src/font-set.js pins one published set
// (tools/pin-font-set.js). The location is the URL that the import map of the
// host gives to FONT_SET_SPECIFIER: in Sandom development, deno.json maps it to
// the sandom-fonts checkout next to Sandom; a certified run maps it to the
// published set. Without a mapping, the location is the published set. The npm
// package has no import map, so its build writes the published set as the
// specifier (deployment/build-npm.js). Every file is checked against the
// SHA-256 of the pin before use.
//
// The provenance and licence of each file are in docs/legal/fonts.md.

import { FONT_SET } from "./font-set.js";
import { readPackageAsset } from "./package-assets.js";
import { sharedDomCore } from "./dom-wasm/core.js";

const faceSelectors = new WeakMap();
const faceSelectorFinalizer = new FinalizationRegistry((handle) => {
  sharedDomCore.status("font_selection_release", handle);
});
const fontTextEncoder = new TextEncoder();
const fontTextDecoder = new TextDecoder();
const bundledFamilyFinalizer = new FinalizationRegistry((handle) => {
  sharedDomCore.status("font_bundled_release", handle);
});

function bundledFamilyCatalog(families) {
  const rows = families.map(family => ({
    name: fontTextEncoder.encode(family.family),
    aliases: family.generic.map(name => fontTextEncoder.encode(name)),
  }));
  const length = rows.length * 16 + rows.reduce((total, row) =>
    total + row.name.length + row.aliases.length * 8 + row.aliases.reduce((bytes, name) => bytes + name.length, 0), 0);
  const pointer = sharedDomCore.exports.abi_allocate(length);
  const bytes = sharedDomCore.refreshBytes();
  const view = new DataView(bytes.buffer);
  let cursor = pointer + rows.length * 16;
  for (const [index, row] of rows.entries()) {
    const offset = pointer + index * 16;
    view.setUint32(offset, cursor, true);
    view.setUint32(offset + 4, row.name.length, true);
    bytes.set(row.name, cursor);
    cursor += row.name.length;
    const aliases = cursor;
    view.setUint32(offset + 8, aliases, true);
    view.setUint32(offset + 12, row.aliases.length, true);
    cursor += row.aliases.length * 8;
    for (const [aliasIndex, name] of row.aliases.entries()) {
      view.setUint32(aliases + aliasIndex * 8, cursor, true);
      view.setUint32(aliases + aliasIndex * 8 + 4, name.length, true);
      bytes.set(name, cursor);
      cursor += name.length;
    }
  }
  return sharedDomCore.status("font_bundled_create", pointer, rows.length);
}

function bundledFamilyDescriptor(catalog, index) {
  sharedDomCore.status("font_bundled_describe", catalog, index);
  const bytes = sharedDomCore.refreshBytes();
  const view = new DataView(bytes.buffer, sharedDomCore.exports.abi_output_pointer(), 20);
  const text = offset => fontTextDecoder.decode(bytes.subarray(view.getUint32(offset, true),
    view.getUint32(offset, true) + view.getUint32(offset + 4, true)));
  return {fallback: view.getUint32(16, true) ? text(0) : undefined, familyIdentity: text(8)};
}

function bundledFaceDescriptor(file) {
  sharedDomCore.status("font_bundled_face", ...sharedDomCore.input(file));
  const bytes = sharedDomCore.refreshBytes();
  const pointer = sharedDomCore.exports.abi_output_pointer();
  return {
    faceIndex: new DataView(bytes.buffer).getUint32(pointer, true),
    faceIdentity: fontTextDecoder.decode(bytes.subarray(pointer + 4, pointer + sharedDomCore.exports.abi_output_length())),
  };
}

function faceSelector(faces) {
  let handle = faceSelectors.get(faces);
  if (handle !== undefined) return handle;
  const rows = faces.map((face) => ({
    style: fontTextEncoder.encode(String(face.style)),
    weights: Array.isArray(face.weight) ? face.weight : [face.weight, face.weight],
    variable: Number(Array.isArray(face.weight)),
  }));
  const length = rows.length * 32 + rows.reduce((total, row) => total + row.style.length, 0);
  const pointer = sharedDomCore.exports.abi_allocate(length);
  if (!pointer && length) sharedDomCore.throwIfError();
  const bytes = sharedDomCore.refreshBytes();
  const view = new DataView(bytes.buffer);
  bytes.fill(0, pointer, pointer + length);
  let cursor = pointer + rows.length * 32;
  for (const [index, row] of rows.entries()) {
    const at = pointer + index * 32;
    view.setUint32(at, cursor, true);
    view.setUint32(at + 4, row.style.length, true);
    view.setFloat64(at + 8, Number(row.weights[0]), true);
    view.setFloat64(at + 16, Number(row.weights[1]), true);
    view.setUint32(at + 24, row.variable, true);
    bytes.set(row.style, cursor);
    cursor += row.style.length;
  }
  handle = sharedDomCore.status("font_selection_create", pointer, rows.length);
  faceSelectors.set(faces, handle);
  faceSelectorFinalizer.register(faces, handle);
  return handle;
}

export const BUNDLED_SYSTEM_FONTS_SYMBOL = Symbol.for("sandom.bundledSystemFonts");
export const FONT_SET_FALLBACK_FAMILIES_SYMBOL = Symbol.for("sandom.fontSetFallbackFamilies");
export const FONT_SET_SPECIFIER = "https://cdn.urania-libs.com/set/4ac082ad6cf25238/sandom-fonts/";

// The location of the font set: the import-map target of
// FONT_SET_SPECIFIER, else the published set of the pin.
export function fontSetLocation() {
  const resolved = import.meta.resolve(FONT_SET_SPECIFIER);
  return resolved === FONT_SET_SPECIFIER ? FONT_SET.url : resolved;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The bytes of `path` in the set at `location`, checked against the pin.
async function readSetFile(location, path) {
  const expected = FONT_SET.files[path];
  if (expected === undefined) {
    throw new Error(`The pinned font set ${FONT_SET.setHash} has no file ${path}; pin a set that has it (tools/pin-font-set.js)`);
  }
  const url = new URL(path, location);
  const bytes = await readPackageAsset(url);
  const observed = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (observed !== expected) {
    throw new Error(
      `The font set file ${url.href} has SHA-256 ${observed}; the pinned set ${FONT_SET.setHash} ` +
        `(sandom-fonts commit ${FONT_SET.commit}) lists ${expected}. Check out that commit where ` +
        `${FONT_SET_SPECIFIER} is mapped, or pin the set of that checkout (tools/pin-font-set.js).`,
    );
  }
  return { bytes, url };
}

// Native selection returns the index of the host's byte and URL handles.
function closestFace(faces, weight, style, mapOblique) {
  const handle = faceSelector(faces);
  return faces[sharedDomCore.status("font_selection_find", handle, Number(weight),
    ...sharedDomCore.input(String(style)), Number(mapOblique))];
}

// Each read of a set location happens once in a realm.
function once(cache, location, read) {
  const key = String(location);
  let result = cache.get(key);
  if (result === undefined) {
    result = read(new URL(key));
    cache.set(key, result);
  }
  return result;
}

const manifests = new Map();
const fallbackFamilies = new Map();
const bundledFonts = new Map();

function readManifest(location) {
  return once(manifests, location, async (url) =>
    JSON.parse(new TextDecoder().decode((await readSetFile(url, "manifest.json")).bytes)));
}

// Reads the manifest and the coverage index of the font set once, and
// returns the `fallbackFamilies` option of createFontRegistry: the coverage
// index and a loader for each family, which reads a face when the renderer
// asks for it. For a host with its own generic faces. `location` overrides
// the location of the set (fontSetLocation()).
export function loadFontSetFallbackFamilies({ location = fontSetLocation() } = {}) {
  return once(fallbackFamilies, location, async (url) => {
    const manifest = await readManifest(url);
    const coverage = (await readSetFile(url, manifest.output)).bytes;
    const faces = Object.fromEntries(manifest.families.map(({ family, faces: familyFaces }) => [family, {
      url: new URL(familyFaces[0].file, url).href,
      async load({ weight, style }) {
        const { bytes, url: faceURL } = await readSetFile(url, closestFace(familyFaces, weight, style, false).file);
        return { bytes, finalURL: faceURL.href };
      },
    }]));
    return Object.freeze({ coverage, faces });
  });
}

// Reads the manifest, the coverage index, and every generic face of the font
// set once, and returns `{ familyFor(genericName), familyNamed(familyName),
// fallbackFamilies }`. `familyFor` returns the family specification of a
// bundled generic family, or null for a generic family without a bundled
// font. `fallbackFamilies` is the result of loadFontSetFallbackFamilies.
// `location` overrides the location of the set (fontSetLocation()).
export function loadBundledSystemFonts({ location = fontSetLocation() } = {}) {
  return once(bundledFonts, location, readBundledFonts);
}

async function readBundledFonts(location) {
  const manifest = await readManifest(location);
  const genericFamilies = [];
  await Promise.all(manifest.generic.map(async (family) => {
    const faces = await Promise.all(family.faces.map(async (face) => {
      const { bytes, url } = await readSetFile(location, face.file);
      return Object.freeze({ ...face, bytes, finalURL: url.href, ...bundledFaceDescriptor(face.file) });
    }));
    genericFamilies.push({ ...family, faces });
  }));
  const specification = index => {
    const {family, faces} = genericFamilies[index];
    const {fallback, familyIdentity} = bundledFamilyDescriptor(catalog, index);
    return {
      cssFamily: family,
      fallback,
      variable: sharedDomCore.status("font_selection_variable", faceSelector(faces)) !== 0,
      familyIdentity,
      resolveFace(weight, style) {
        const face = closestFace(faces, weight, style, true);
        return {
          bytes: face.bytes,
          faceIndex: face.faceIndex,
          style: face.style,
          faceIdentity: face.faceIdentity,
          finalURL: face.finalURL,
        };
      },
    };
  };
  const fallback = await loadFontSetFallbackFamilies({ location });
  const catalog = bundledFamilyCatalog(genericFamilies);
  const result = Object.freeze({
    // The bundled family of a generic family name, or null.
    familyFor(genericName) {
      const index = sharedDomCore.status("font_bundled_find", catalog,
        ...sharedDomCore.input(typeof genericName === "string" ? genericName : ""), 0, Number(typeof genericName === "string"));
      return index < 0 ? null : specification(index);
    },
    // The bundled family whose own name is `familyName`, compared with
    // Unicode lowercase mapping: a bundled
    // font is installed under its name as well as its generic family.
    familyNamed(familyName) {
      const index = sharedDomCore.status("font_bundled_find", catalog, ...sharedDomCore.input(String(familyName)), 1, 1);
      return index < 0 ? null : specification(index);
    },
    fallbackFamilies: fallback,
  });
  bundledFamilyFinalizer.register(result, catalog);
  return result;
}

// Enables the bundled fonts for the default font registry of this realm.
// Returns once the generic faces and the coverage index are read.
export async function installBundledSystemFonts() {
  globalThis[BUNDLED_SYSTEM_FONTS_SYMBOL] = await loadBundledSystemFonts();
}

// Enables the fallback families of the font set, without its generic
// faces, for the default font registry of this realm. Returns once the
// coverage index is read.
export async function installFontSetFallbackFamilies() {
  globalThis[FONT_SET_FALLBACK_FAMILIES_SYMBOL] = await loadFontSetFallbackFamilies();
}
