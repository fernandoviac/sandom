// The shared pipeline library binding. Renderer-core
// (src/wasm/gpu-pipelines.watpart) records the shader modules, pipeline
// descriptors, blend states, vertex layouts, the unit quad, and the
// placeholder texture of one device and color format. This module composes
// the WGSL sources, reports compilation errors, and answers record 17
// imports with the library's pipelines.
import { createGpuBinding } from "./gpu-binding.js";
import { composeShaderBytes } from "./shaders/compose.js";
import { PIPELINE_LIBRARY_SHADERS, SHADER_CONSTANTS } from "./shaders/constants.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";

const FORMATS = ["rgba8unorm", "rgba16float"];
const decoder = new TextDecoder();
let libraryCore;

export async function createGpuPipelineLibrary(device, colorFormat) {
  const format = FORMATS.indexOf(colorFormat);
  if (format < 0) {
    throw new Error(`GPU pipeline library format ${colorFormat}: expected rgba8unorm or rgba16float`);
  }
  const core = libraryCore ??= instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device);
  const sources = PIPELINE_LIBRARY_SHADERS.map(([name, variant]) => ({
    name,
    ...composeShaderBytes(core, name, { ...SHADER_CONSTANTS, ...variant }),
  }));
  const table = gpu.input(sources.length * 8);
  sources.forEach((source, index) => {
    table.setUint32(index * 8, source.pointer, true);
    table.setUint32(index * 8 + 4, source.length, true);
  });
  const state = core.gpu_pipeline_library_create(gpu.stream, format, table.byteOffset);
  gpu.execute();

  // createShaderModule never throws on invalid WGSL: the module is invalid,
  // every pipeline from it draws nothing, and only getCompilationInfo()
  // reports the cause.
  const reports = await Promise.all(sources.map((_, index) =>
    gpu.resource(core.gpu_pipeline_library_module(state, index)).getCompilationInfo()
  ));
  const failures = [];
  reports.forEach((report, index) => {
    const errors = report.messages.filter((message) => message.type === "error");
    if (errors.length === 0) return;
    const sourceLines = decoder.decode(
      new Uint8Array(core.memory.buffer, sources[index].pointer, sources[index].length),
    ).split("\n");
    for (const message of errors) {
      const sourceLine = sourceLines[message.lineNum - 1]?.trim() ?? "<source unavailable>";
      failures.push(`  ${sources[index].name} line ${message.lineNum}:${message.linePos} — ${message.message}\n    ${sourceLine}`);
    }
  });
  if (failures.length > 0) {
    core.gpu_pipeline_library_destroy(state);
    gpu.close();
    throw new Error(`WGSL compilation failed:\n${failures.join("\n")}`);
  }

  let destroyed = false;
  return Object.freeze({
    pipeline(identity) {
      if (destroyed) throw new Error("GPU pipeline library is destroyed");
      const handle = core.gpu_pipeline_library_get(state, identity);
      gpu.execute();
      return gpu.resource(handle);
    },
    quadBuffer: gpu.resource(core.gpu_pipeline_library_quad(state)),
    placeholderTexture: gpu.resource(core.gpu_pipeline_library_placeholder(state)),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      core.gpu_pipeline_library_destroy(state);
      gpu.close();
    },
  });
}
