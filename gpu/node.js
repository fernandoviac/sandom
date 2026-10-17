// sandom/gpu on Node: mounts `navigator.gpu` from the `webgpu` npm
// package (dawn-gpu/node-webgpu, the Google Dawn N-API binding).
//
// Install the optional peer dependency: npm install webgpu
// Import this module before any sandom module.
//
// Dawn keeps the Node event loop alive while a GPU device exists. Exit
// with process.exit() or destroy the device when your program finishes.

import { create, globals } from "webgpu";

if (!globalThis.navigator?.gpu) {
  // GPUBufferUsage, GPUTextureUsage, GPUShaderStage, ... constants.
  Object.assign(globalThis, globals);
  const gpu = create([]);
  try {
    // Node >= 21 ships a `navigator` global; add `gpu` onto it.
    Object.defineProperty(globalThis.navigator, "gpu", { value: gpu });
  } catch {
    Object.defineProperty(globalThis, "navigator", { value: { gpu } });
  }
}

// Sandom's GPU thread is a worker without this realm's globals. Its default
// thread imports this module there before it reads `navigator.gpu`.
globalThis[Symbol.for("sandom.gpuModule")] = import.meta.url;
