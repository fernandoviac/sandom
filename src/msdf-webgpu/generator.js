// Native MSDF requests own validation, batches, buffer sizes, packing, passes,
// pipelines and their layouts, atlas population and readback conversion. This
// module transports the WGSL sources and input spans.
import { hostNow } from '../host-clock.js';
import { createGpuBinding } from '../gpu-binding.js';
import { instantiateRendererCore } from '../wasm/renderer-core-binary.js';
import { MAX_CONTOURS, MSDF_ATLAS_POPULATION_WGSL, MSDF_COMPUTE_WGSL } from './shader.js';
import { getDefaultGpu } from '../gpu-thread.js';
import { layoutConstant } from '../wasm/layout-table.js';

// The request rows of gpu-msdf.watpart, by WAT name.
const MSDF_REQUEST = Object.freeze(Object.fromEntries(
  ['SIZE', 'GEOMETRY', 'LENGTH', 'X', 'Y', 'WIDTH', 'HEIGHT', 'PIXELS']
    .map((name) => [name, layoutConstant(`MSDF_REQUEST_${name}`)])));
const MSDF_ERROR = Object.freeze(Object.fromEntries(['CODE', 'GLYPH', 'OBSERVED', 'LIMIT']
  .map((name) => [name, layoutConstant(`MSDF_ERROR_${name}`)])));

export class WebGpuMsdfError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'WebGpuMsdfError';
    this.code = code;
    this.details = details;
  }
}

export async function createWebGpuMsdfGenerator(options = {}) {
  const startedAt = hostNow();
  let device = options.device ?? null;
  const ownsDevice = device === null;
  if (!device) {
    const adapter = await getDefaultGpu()?.requestAdapter();
    if (!adapter) throw new WebGpuMsdfError('no-adapter', 'the GPU-thread capability has no adapter');
    device = await adapter.requestDevice();
  }
  let broken = null;
  device.lost.then((info) => {
    broken = new WebGpuMsdfError('device-lost', `WebGPU device lost: ${info.message}`, { reason: info.reason });
  });
  const core = instantiateRendererCore().exports;
  // Record 27 reads the sources when the create records execute.
  const encoder = new TextEncoder();
  const sources = [MSDF_COMPUTE_WGSL, MSDF_ATLAS_POPULATION_WGSL].map((source) => {
    const bytes = encoder.encode(source);
    // A retained block, freed after the create records execute.
    const pointer = core.abi_malloc(bytes.length);
    if (!pointer) throw new Error(`renderer-core could not allocate ${bytes.length} bytes of MSDF WGSL`);
    new Uint8Array(core.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer, length: bytes.length };
  });
  const binding = createGpuBinding(core, device);
  const state = core.gpu_msdf_create(binding.stream, device.limits.maxStorageBufferBindingSize,
    device.limits.maxBufferSize, device.limits.maxComputeWorkgroupsPerDimension,
    sources[0].pointer, sources[0].length, sources[1].pointer, sources[1].length);
  binding.execute();
  for (const source of sources) core.abi_free(source.pointer);
  const pipelineCreationMilliseconds = hostNow() - startedAt;
  let closed = false;
  function throwNativeError() {
    const view = new DataView(core.memory.buffer, state, MSDF_ERROR.LIMIT + Uint32Array.BYTES_PER_ELEMENT);
    const code = view.getUint32(MSDF_ERROR.CODE, true);
    if (!code) return;
    const glyphIndex = view.getUint32(MSDF_ERROR.GLYPH, true);
    const observed = view.getUint32(MSDF_ERROR.OBSERVED, true);
    const limit = view.getUint32(MSDF_ERROR.LIMIT, true);
    const codes = ['malformed-buffer', 'unknown-format-version', 'contour-cap-exceeded', 'batch-too-large', 'malformed-atlas-target', 'device-lost'];
    throw new WebGpuMsdfError(codes[code - 1], `glyph ${glyphIndex}: observed ${observed}, required limit ${limit}; provide geometry and a target within the declared format and device limits`, { glyphIndex, observed, limit });
  }
  return {
    device,
    limits: { maxContoursPerGlyph: MAX_CONTOURS, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize },
    pipelineCreationMilliseconds,
    async generate(preparedBuffers, { readBack = false, directAtlas = null } = {}) {
      if (closed) throw new WebGpuMsdfError('shut-down', 'generator was shut down');
      if (broken) throw broken;
      if (readBack && directAtlas) throw new WebGpuMsdfError('invalid-output-policy', 'readback and direct atlas population are mutually exclusive');
      if (directAtlas && (!directAtlas.texture || !Array.isArray(directAtlas.placements) || directAtlas.placements.length !== preparedBuffers.length)) {
        throw new WebGpuMsdfError('malformed-atlas-target', 'direct atlas target needs one placement per prepared glyph');
      }
      for (const bytes of preparedBuffers) {
        if (!(bytes instanceof Uint8Array)) throw new WebGpuMsdfError('malformed-buffer', 'prepared geometry must be a Uint8Array');
      }
      if (!core.gpu_msdf_claim(state)) throw new WebGpuMsdfError('generation-in-progress', 'finish the current native request before submitting another');
      const totalStart = hostNow();
      const timings = { cpuPackMilliseconds: 0, uploadMilliseconds: 0, encodeMilliseconds: 0,
        submitMilliseconds: 0, completionMilliseconds: 0, directAtlasPopulationMilliseconds: 0,
        readbackMilliseconds: 0, totalMilliseconds: 0, batchCount: 0 };
      try {
        binding.beginFrame();
        const length = preparedBuffers.reduce((sum, bytes) => sum + bytes.byteLength, preparedBuffers.length * MSDF_REQUEST.SIZE);
        const input = binding.input(length);
        const inputPointer = input.byteOffset;
        let pointer = inputPointer + preparedBuffers.length * MSDF_REQUEST.SIZE;
        const memory = new Uint8Array(core.memory.buffer);
        for (let index = 0; index < preparedBuffers.length; index++) {
          const bytes = preparedBuffers[index];
          const row = index * MSDF_REQUEST.SIZE;
          input.setUint32(row + MSDF_REQUEST.GEOMETRY, pointer, true);
          input.setUint32(row + MSDF_REQUEST.LENGTH, bytes.length, true);
          input.setUint32(row + MSDF_REQUEST.X, directAtlas?.placements[index].x ?? 0, true);
          input.setUint32(row + MSDF_REQUEST.Y, directAtlas?.placements[index].y ?? 0, true);
          memory.set(bytes, pointer);
          pointer += bytes.length;
        }
        core.gpu_msdf_begin(state, inputPointer, preparedBuffers.length, Number(readBack),
          binding.importResource(directAtlas?.texture ?? null), directAtlas?.texture.width ?? 0, directAtlas?.texture.height ?? 0);
        throwNativeError();
        for (;;) {
          const packStart = hostNow();
          const token = core.gpu_msdf_next(state);
          timings.cpuPackMilliseconds += hostNow() - packStart;
          throwNativeError();
          if (!token) break;
          timings.batchCount++;
          const encodeStart = hostNow();
          try { binding.execute(); } catch (error) {
            if (core.gpu_operation_pending(binding.stream, token)) core.gpu_completion(binding.stream, token, 1);
            broken = error;
            throw error;
          }
          timings.encodeMilliseconds += hostNow() - encodeStart;
          const completionStart = hostNow();
          await new Promise((reply, reject) => binding.completion(token, { reply, throw: reject }));
          timings.completionMilliseconds += hostNow() - completionStart;
        }
        const readStart = hostNow();
        const view = new DataView(core.memory.buffer);
        const results = preparedBuffers.map((_, index) => {
          const row = inputPointer + index * MSDF_REQUEST.SIZE;
          const width = view.getUint32(row + MSDF_REQUEST.WIDTH, true);
          const height = view.getUint32(row + MSDF_REQUEST.HEIGHT, true);
          const pixels = view.getUint32(row + MSDF_REQUEST.PIXELS, true);
          return { width, height, pixels: pixels ? new Uint8Array(core.memory.buffer, pixels, width * height * 3).slice() : null };
        });
        timings.readbackMilliseconds += hostNow() - readStart;
        timings.totalMilliseconds = hostNow() - totalStart;
        return { results, timings };
      } finally { core.gpu_msdf_release(state); }
    },
    shutdown() {
      if (closed) return;
      try {
        core.gpu_msdf_destroy(state);
        try { binding.execute(); } finally { binding.close(); }
      } finally {
        closed = true;
        if (ownsDevice) device.destroy();
      }
    },
  };
}
