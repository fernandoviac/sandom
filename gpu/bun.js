// sandom/gpu on Bun: mounts `navigator.gpu` from the `bun-webgpu` npm
// package (Dawn through bun:ffi).
//
// Install the optional peer dependency: bun add bun-webgpu
// Import this module before any sandom module.
//
// One Bun-specific requirement:
//
// 1. bun-webgpu 0.1.7 implements GPUShaderModule.getCompilationInfo as a
//    "not implemented" error. Sandom calls it to surface WGSL
//    compilation errors loudly. This entry stubs it to zero messages, so
//    a genuinely bad shader fails silently on Bun until bun-webgpu
//    implements the method.

import { setupGlobals } from "bun-webgpu";

if (!globalThis.navigator?.gpu) {
  setupGlobals();

  const gpu = globalThis.navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (...adapterArgs) => {
    const adapter = await requestAdapter(...adapterArgs);
    if (!adapter) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...deviceArgs) => {
      const device = await requestDevice(...deviceArgs);
      const createShaderModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = createShaderModule(descriptor);
        const prototype = Object.getPrototypeOf(module);
        prototype.getCompilationInfo = () =>
          Promise.resolve({ messages: [] });
        return module;
      };
      return device;
    };
    return adapter;
  };
}

// Sandom's GPU thread is a worker without this realm's globals. Its default
// thread imports this module there before it reads `navigator.gpu`.
globalThis[Symbol.for("sandom.gpuModule")] = import.meta.url;
