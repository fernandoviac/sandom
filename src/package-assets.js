// Program-image loader.
//
// Sandom's own WebAssembly modules and bundled font files ship with its
// package and its library set. They are part of the program, as its
// JavaScript modules are, and they are not document resources: a document
// resource always goes through the host resource session. This module reads
// only locators below the Sandom package root, the root of each library
// that it loads, or the font set, and refuses every other locator, so
// it cannot serve as a document resource provider.
//
// Deno, Node, and Bun expose the package files through `node:fs`; a browser
// loads them over its own fetch. A browser gets no `node:fs` import attempt:
// Chrome logs a console error for the failed request that no catch can
// suppress, so the attempt is gated on the runtime advertising node
// compatibility.

import { FONT_SET } from "./font-set.js";

const runtimeProvidesNodeModules = globalThis.Deno !== undefined ||
  globalThis.process?.versions !== undefined;

// Note the statement shape: `await import(...)` at statement start. Node's
// CJS/ESM detection for extensionless-package .js files accepts this form but
// misparses the same await inside a ternary expression as CommonJS and fails
// the import (verified on Node 24.4).
let nodeFileSystemPromises = null;
if (runtimeProvidesNodeModules) {
  nodeFileSystemPromises = await import("node:fs/promises");
}

// True when the runtime reads package files from a file system (Deno, Node,
// Bun). False in a browser.
export const hasFileSystem = nodeFileSystemPromises !== null;

// A library root is two levels above a library module: the set root in a
// checkout or a published set (`<root>/sandom-color/dist/color.wasm`), and
// the scope directory that holds the package in an installed package
// (`node_modules/@sandom/color/dist/color.wasm`). An install can put each
// package in its own directory: an isolated layout
// (`node_modules/.store/@sandom/color@0.3.0-…/node_modules/@sandom/`) gives
// each library a different scope directory. Thus each library module that
// Sandom loads gives one root. The npm build projects each specifier below.
const LIBRARY_MODULES = Object.freeze([
  "@sandom/color/color.wasm",
  "@sandom/gain-map/gain-map.wasm",
  "@sandom/png/png-codec.wasm",
  "@sandom/image-codecs/jpeg.wasm",
  "@sandom/image-codecs/webp.wasm",
]);
const FONT_SET_LOCATION = "https://cdn.urania-libs.com/set/2621941e2c701e45/sandom-fonts/";
// The font set's location as src/system-fonts.js resolves it: the
// import-map target of FONT_SET_LOCATION, else the published set of the pin
// (a realm without an import map, such as a dedicated worker). The npm
// package names the published set itself, which no import map redirects and
// which Deno, running an npm package, refuses to resolve.
const mappedFontSet = FONT_SET_LOCATION === FONT_SET.url ? FONT_SET.url : import.meta.resolve(FONT_SET_LOCATION);
const fontSetRoot = mappedFontSet === FONT_SET_LOCATION ? FONT_SET.url : mappedFontSet;
// The module URL goes through a variable on purpose. Vite's asset transform
// rewrites the literal form `new URL("../", import.meta.url)` at serve time
// into the directory's file-system path (no trailing slash), while the asset
// URLs other modules build stay origin-relative, so every bundled asset fell
// outside the root.
const moduleURL = import.meta.url;
const packageRoot = new URL("../", moduleURL).href;
const libraryRoots = LIBRARY_MODULES.map((specifier) => new URL("../../", import.meta.resolve(specifier)).href);
const programRoots = Object.freeze([...new Set([packageRoot, ...libraryRoots, fontSetRoot])]);

function toUint8Array(buffer) {
  return buffer instanceof Uint8Array && buffer.constructor === Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
}

function programLocator(source) {
  let url;
  try {
    url = new URL(source instanceof URL ? source.href : String(source));
  } catch (cause) {
    throw new TypeError(
      `Package asset ${JSON.stringify(String(source))} must be an absolute URL`,
      { cause },
    );
  }
  if (!programRoots.some((root) => url.href.startsWith(root))) {
    throw new TypeError(
      `Package asset ${url.href} is outside the Sandom package and library set (${programRoots.join(", ")}); documents obtain resources through a host`,
    );
  }
  return url;
}

// Reads one program asset: a WebAssembly module or a bundled font of the
// Sandom package or its library set.
export async function readPackageAsset(source) {
  const url = programLocator(source);
  if (url.protocol === "file:") {
    if (!hasFileSystem) {
      throw new Error(`Package asset ${url.href} needs a file system; this runtime has none`);
    }
    return toUint8Array(await nodeFileSystemPromises.readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Package asset ${url.href} returned HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
