// Program-image loader.
//
// Sandom's own WebAssembly modules and bundled font files ship with its
// package and its library set. They are part of the program, as its
// JavaScript modules are, and they are not document resources: a document
// resource always goes through the host resource session. This module reads
// only locators below the Sandom package root, the root of the libraries it
// is installed beside, or the font set, and refuses every other locator, so
// it cannot serve as a document resource provider.
//
// Deno, Node, and Bun expose the package files through `node:fs`; a browser
// loads them over its own fetch. A browser gets no `node:fs` import attempt:
// Chrome logs a console error for the failed request that no catch can
// suppress, so the attempt is gated on the runtime advertising node
// compatibility.

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

// The libraries root is where the sibling libraries resolve: two levels
// above the colour module, which is `<root>/sandom-color/dist/color.wasm`
// in a checkout or a published set and `node_modules/@sandom/color/dist/`
// in an installed package. The npm build projects both specifiers below.
const COLOR_WASM = "@sandom/color/color.wasm";
const FONT_SET_LOCATION = "https://cdn.urania-libs.com/set/4ac082ad6cf25238/sandom-fonts/";
// The module URL goes through a variable on purpose. Vite's asset transform
// rewrites the literal form `new URL("../", import.meta.url)` at serve time
// into the directory's file-system path (no trailing slash), while the asset
// URLs other modules build stay origin-relative, so every bundled asset fell
// outside the root.
const moduleURL = import.meta.url;
const packageRoot = new URL("../", moduleURL).href;
const librariesRoot = new URL("../../", import.meta.resolve(COLOR_WASM)).href;
const fontSetRoot = import.meta.resolve(FONT_SET_LOCATION);
const programRoots = Object.freeze([...new Set([packageRoot, librariesRoot, fontSetRoot])]);

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
