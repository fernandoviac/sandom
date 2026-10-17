/**
 * Host views and graphics resources for the fused WAT glyph/path atlas.
 * Keys, budgets, skyline placement, residency and texel storage live in
 * glyph-atlas.watpart. atlas-driver.js transports generator input and output.
 */
import { createAtlasDriver } from "./wasm/atlas-driver.js";
import { hostNow } from "./host-clock.js";
import { createShapingRuntime } from "./shaping.js";
import * as GlyphPolicy from "./wasm/glyph-policy-atlas-interface.js";
import { createGpuBinding } from "./gpu-binding.js";


export function transportNativePacket(source, destination, packet, consume) {
  let target = 0;
  try {
    const length = new DataView(source.memory.buffer).getUint32(packet, true);
    target = destination.exports.abi_malloc(length);
    new Uint8Array(destination.memory.buffer, target, length).set(
      new Uint8Array(source.memory.buffer, packet, length),
    );
    return consume(target, length);
  } finally {
    if (target) destination.exports.abi_free(target);
    source.exports.abi_free(packet);
  }
}
// Shared distance range, verified against the native atlas at initialization.
const MSDF_RANGE = 6.0;

// The policy ABI owns the entry information layout. Generator phase timings
// remain separate from host transport and native atlas packing.
const NATIVE_GLYPH_TIMING_FIELDS = Object.freeze([
  "nativeOutlineDecodeAndShapeConstructionMilliseconds",
  "skiaGeometryResolutionMilliseconds",
  "normalizationAndDeconvergenceMilliseconds",
  "geometrySizingAndProjectionMilliseconds",
  "edgeColoringMilliseconds",
  "bitmapAllocationMilliseconds",
  "generateMsdfIncludingErrorCorrectionMilliseconds",
  "pixelPackingAndCopyMilliseconds",
  "atlasInsertionAndBookkeepingMilliseconds",
  "atlasInsertTotalMilliseconds",
]);

export const GLYPH_PERFORMANCE_PHASE_FIELDS = Object.freeze([
  "harfBuzzOutlineExtractionMilliseconds",
  "javascriptToWebAssemblyAllocationCopyCallMilliseconds",
  ...NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1),
  "webGpuPipelineCreationMilliseconds",
  "webGpuCpuPackingMilliseconds",
  "webGpuUploadMilliseconds",
  "webGpuEncodeMilliseconds",
  "webGpuSubmitMilliseconds",
  "webGpuCompletionMilliseconds",
  "directAtlasPopulationMilliseconds",
  "directAtlasCopyMilliseconds",
  "cacheReuseMilliseconds",
  "atlasRebuildAndPackingMilliseconds",
  "gpuUploadMilliseconds",
  "otherPreparationMilliseconds",
]);

export function emptyGlyphPhaseMilliseconds() {
  return Object.fromEntries(
    GLYPH_PERFORMANCE_PHASE_FIELDS.map((field) => [field, 0]),
  );
}

function nativeGlyphTiming(Module) {
  const timingPointer = Module.generator._glyph_timing_ptr();
  const timingView = new DataView(
    Module.generator.HEAPU8.buffer,
    timingPointer,
    NATIVE_GLYPH_TIMING_FIELDS.length * 8,
  );
  return Object.fromEntries(
    NATIVE_GLYPH_TIMING_FIELDS.map((field, index) => [
      field,
      timingView.getFloat64(index * 8, true),
    ]),
  );
}

const textEncoder = new TextEncoder();

// A host that bundles the msdfgen module (the Deno component worker) puts its
// bytes on a global symbol. The first atlas runtime takes them off the global
// and keeps them here, so every later runtime of the realm uses them too.
let packagedBytes;
function packagedMsdfgenBytes() {
  const symbol = Symbol.for("sandom.msdfgenBytes");
  if (symbol in globalThis) {
    packagedBytes = globalThis[symbol];
    delete globalThis[symbol];
  }
  return packagedBytes;
}

const atlasHostsByMemory = new WeakMap();

export function nativeAtlasView(memory, handle, revision) {
  const host = atlasHostsByMemory.get(memory);
  if (!host) throw new Error(`Native atlas ${handle} has no graphics host for this renderer memory`);
  return host.view(handle, revision);
}

export function flushNativeAtlasEffects(memory) {
  atlasHostsByMemory.get(memory)?.flush();
}

export function createAtlasRuntime({
  engine,
  msdfgenBytes,
  createGlyphOutlineSource = null,
  createGlyphOutlineSourceSync = null,
} = {}) {
  let wasmModule = null;
  let initializing = null;
  const atlasOwners = new Map();
  const retirementRecipients = new Map();
  const planOwner = {
    release(handle) {
      wasmModule.exports.atlas_plan_release(handle);
      flushAtlasEffects();
    },
  };

  function flushRetirements() {
    if (!wasmModule) return;
    let event;
    while ((event = wasmModule.exports.atlas_retirement_next()) !== 0) {
      const view = new DataView(wasmModule.memory.buffer, event, 16);
      const consumer = view.getUint32(4, true);
      const texture = view.getUint32(8, true);
      wasmModule.exports.atlas_retirement_acknowledge(event);
      const recipient = retirementRecipients.get(consumer);
      if (!recipient) throw new Error(`Native atlas retirement consumer ${consumer} is unregistered; complete its retirement effects before closing it`);
      recipient(texture);
    }
  }

  function flushAtlasEffects() {
    flushRetirements();
    if (!wasmModule) return;
    let handle;
    while ((handle = wasmModule.exports.atlas_dispose_next()) !== 0) {
      const owner = atlasOwners.get(handle);
      if (!owner) throw new Error(`Native atlas disposal ${handle} has no host owner`);
      owner._destroyNow();
      flushRetirements();
    }
  }


  async function ensureWasm() {
    if (wasmModule) return wasmModule;

    const wasmBinary = msdfgenBytes ?? packagedMsdfgenBytes();
    const Module = await (initializing ??= createAtlasDriver({ engine, msdfgenBytes: wasmBinary }));
    const infoFloats = Module.exports.atlas_entry_info_floats();
    if (infoFloats !== GlyphPolicy.RESIDENCY_INFORMATION_COUNT) {
      throw new Error(
        `atlas entry layout mismatch: core reports ${infoFloats} floats, binding expects ${GlyphPolicy.RESIDENCY_INFORMATION_COUNT}; rebuild renderer-core`,
      );
    }
    if (Module.exports.atlas_msdf_range() !== MSDF_RANGE) {
      throw new Error("Atlas distance range differs from the renderer binding; rebuild renderer-core and update MSDF_RANGE together");
    }
    const timingCount = Module.generator._glyph_timing_count();
    if (timingCount !== NATIVE_GLYPH_TIMING_FIELDS.length) {
      throw new Error(
        `glyph timing layout mismatch: wasm reports ${timingCount} fields, JS mirror expects ${NATIVE_GLYPH_TIMING_FIELDS.length} — rebuild vendor/msdfgen.wasm or update src/atlas.js`,
      );
    }
    wasmModule = Module;
    atlasHostsByMemory.set(Module.memory, {
      view(handle, revision) {
        const owner = atlasOwners.get(handle);
        if (!owner) throw new Error(`Native atlas ${handle} has no registered graphics owner`);
        return owner.revisionView(revision);
      },
      flush: flushAtlasEffects,
    });
    if (createGlyphOutlineSource === null || createGlyphOutlineSourceSync === null) {
      const shaping = createShapingRuntime({ engine: Module.engine });
      createGlyphOutlineSource ??= shaping.createGlyphOutlineSource;
      createGlyphOutlineSourceSync ??= shaping.createGlyphOutlineSourceSync;
    }
    return wasmModule;
  }
  // Scene rendering imports this runtime before exposing synchronous DOM layout
  // getters. Local SVG paths are deterministic inputs just like local fonts;
  // mount-time getBoundingClientRect must not depend on an unrelated prior frame.
  async function initializeAtlasRuntime() {
    await ensureWasm();
  }

  // Shared handle/lifecycle layer — one wasm atlas handle per instance.
  // GlyphAtlas and SvgPathAtlas deliberately share this single
  // implementation (they always shared one packing/caching shape; keeping
  // them split was two copies of the same bug surface).
  class WasmAtlas {
    constructor(kind) {
      this._kind = kind;
      this.id = 0;
      this._destroyListeners = new Set();
      this._webGpuTextures = new Map();
      this._destroyRequested = false;
      this._disposed = false;
    }

    _adoptNativeHandle(handle) {
      this.id = handle;
      wasmModule.exports.atlas_host_owned(handle);
      atlasOwners.set(handle, this);
    }

    async _ensureCreated() {
      if (this._destroyRequested || this._disposed) throw new Error("Cannot generate fields in a destroyed atlas");
      const Module = await ensureWasm();
      if (!this.id) this._adoptNativeHandle(Module.exports.atlas_create(this._kind));
      return Module;
    }

    // The scene renderer initializes the local atlas runtime before exporting
    // synchronous layout getters. Reaching this guard means a caller imported
    // this low-level module directly without honoring that initialization
    // contract; fail loudly rather than returning false path geometry.
    _ensureCreatedSync() {
      if (this._destroyRequested || this._disposed) throw new Error("Cannot generate fields in a destroyed atlas");
      if (!wasmModule) {
        throw new Error(
          "atlas.js: native atlas runtime is not initialized; call initializeAtlasRuntime before synchronous generation",
        );
      }
      if (!this.id) this._adoptNativeHandle(wasmModule.exports.atlas_create(this._kind));
      return wasmModule;
    }

    _infoFloats(slot) {
      const ptr = wasmModule.exports.atlas_entry_info_ptr(this.id, slot);
      if (ptr === 0) return null;
      // One view over the heap, re-made only when the heap grows.
      const buffer = wasmModule.memory.buffer;
      if (
        this._heapFloats === undefined || this._heapFloats.buffer !== buffer
      ) {
        this._heapFloats = new Float32Array(buffer);
      }
      return this._heapFloats.subarray(
        ptr >> 2,
        (ptr >> 2) + GlyphPolicy.RESIDENCY_INFORMATION_COUNT,
      );
    }
    get revision() {
      return this.id ? wasmModule.exports.atlas_revision(this.id) : 0;
    }


    rebuildAtlas() {
      this._ensureCreatedSync();
      // Empty and populated atlases share one native revision sequence.
      // A first field must invalidate a texture uploaded for the empty atlas.
      if (this.revision !== 0 && !wasmModule.exports.atlas_dirty(this.id)) return 0;
      const startedAt = hostNow();
      wasmModule.exports.atlas_batch_commit(this.id);
      return hostNow() - startedAt;
    }

    // Live views over the wasm-owned packed atlas — re-derived on every
    // access rather than cached, because a wasm memory growth (any later
    // ensure call) detaches earlier views. Consumers read these at
    // texture-upload time, immediately before the upload call.
    get atlasData() {
      if (!this.id) return null;
      const ptr = wasmModule.exports.atlas_data_ptr(this.id);
      if (ptr === 0) return null;
      return new Uint8Array(
        wasmModule.memory.buffer,
        ptr,
        this.atlasWidth * this.atlasHeight * 4,
      );
    }

    get atlasWidth() {
      if (!this.id) return 0;
      return wasmModule.exports.atlas_width(this.id);
    }

    get atlasHeight() {
      if (!this.id) return 0;
      return wasmModule.exports.atlas_height(this.id);
    }

    _revisionData(revision) {
      const native = wasmModule.exports;
      return new Uint8Array(wasmModule.memory.buffer, native.atlas_revision_data_ptr(this.id, revision),
        native.atlas_revision_width(this.id, revision) * native.atlas_revision_height(this.id, revision) * 4);
    }

    get graphicsOwner() { return this; }

    createUploadConsumer(retire) {
      const consumer = wasmModule.exports.atlas_consumer_create(this.id);
      retirementRecipients.set(consumer, retire);
      return consumer;
    }

    closeUploadConsumer(consumer) {
      wasmModule.exports.atlas_consumer_destroy(consumer);
      flushRetirements();
      retirementRecipients.delete(consumer);
    }

    retireUploadTexture(consumer, revision, identity) {
      wasmModule.exports.atlas_consumer_retire(consumer, revision, identity);
      flushRetirements();
    }

    uploadChanges(consumer, revision = this.revision) {
      const native = wasmModule.exports;
      native.atlas_consumer_target(consumer, revision);
      const replace = native.atlas_consumer_replace(consumer) !== 0;
      const pointer = native.atlas_consumer_changes(consumer);
      const count = native.atlas_consumer_change_count(consumer);
      const rows = new Uint32Array(wasmModule.memory.buffer, pointer, count * 4);
      const rectangles = Array.from({ length: count }, (_, index) => ({
        x: rows[index * 4], y: rows[index * 4 + 1], width: rows[index * 4 + 2], height: rows[index * 4 + 3],
      }));
      return { replace, rectangles };
    }

    acknowledgeUpload(consumer) {
      wasmModule.exports.atlas_consumer_acknowledge(consumer);
    }

    uploadRegion(rectangle, revision = this.revision) {
      const native = wasmModule.exports;
      const width = native.atlas_revision_width(this.id, revision);
      const pointer = native.atlas_revision_data_ptr(this.id, revision) + (rectangle.y * width + rectangle.x) * 4;
      const byteLength = ((rectangle.height - 1) * width + rectangle.width) * 4;
      const source = new Uint8Array(wasmModule.memory.buffer, pointer, byteLength);
      if (!source.buffer.resizable && !source.buffer.growable) return { data: source, bytesPerRow: width * 4 };
      const bytesPerRow = rectangle.width * 4;
      const data = new Uint8Array(bytesPerRow * rectangle.height);
      for (let row = 0; row < rectangle.height; row++) {
        data.set(source.subarray(row * width * 4, row * width * 4 + bytesPerRow), row * bytesPerRow);
      }
      return { data, bytesPerRow };
    }

    retainForPlan(retentions, revision = this.revision) {
      let retention = retentions.get(planOwner);
      if (!retention) {
        retention = { handle: wasmModule.exports.atlas_plan_create(), owner: planOwner };
        retentions.set(planOwner, retention);
      }
      wasmModule.exports.atlas_plan_bind(retention.handle, this.id, revision);
      return this.revisionView(revision);
    }

    revisionView(revision) {
      const revisionData = () => this._revisionData(revision);
      const revisionWidth = () => wasmModule.exports.atlas_revision_width(this.id, revision);
      const revisionHeight = () => wasmModule.exports.atlas_revision_height(this.id, revision);
      return Object.freeze({
        graphicsOwner: this, revision,
        get atlasData() { return revisionData(); },
        get atlasWidth() { return revisionWidth(); },
        get atlasHeight() { return revisionHeight(); },
        getMsdfParams: () => this.getMsdfParams(),
        uploadRegion: (rectangle) => this.uploadRegion(rectangle, revision),
        uploadChanges: (consumer) => this.uploadChanges(consumer, revision),
        acknowledgeUpload: (consumer) => this.acknowledgeUpload(consumer),
        deviceTexture: (device) => this.deviceTexture(device, revision),
        webGpuTexture: (device) => this.webGpuTexture(device, revision),
      });
    }

    _gpuState(device) {
      let state = this._webGpuTextures.get(device);
      if (!state) {
        const native = wasmModule.exports;
        const binding = createGpuBinding(native, device);
        const handle = native.gpu_atlas_create(binding.stream, this.id);
        const consumer = native.gpu_atlas_consumer(handle);
        state = { binding, handle, consumer };
        retirementRecipients.set(consumer, (texture) => {
          native.gpu_atlas_retire(handle, texture);
          binding.execute();
        });
        this._webGpuTextures.set(device, state);
      }
      return state;
    }

    _gpuKeys(state, descriptors) {
      const input = state.binding.input(descriptors.length * 32);
      for (let index = 0; index < descriptors.length; index++) {
        const glyph = descriptors[index];
        const offset = index * 32;
        input.setUint32(offset, glyph.glyphId, true);
        input.setFloat32(offset + 4, glyph.weight, true);
        input.setFloat64(offset + 8, glyph.opticalSize ?? Number.NaN, true);
        input.setFloat64(offset + 16, glyph.devicePixelSize ?? 0, true);
      }
      return input.byteOffset;
    }

    webGpuTexture(device, revision = this.revision) {
      const state = this._webGpuTextures.get(device);
      if (!state) return null;
      const handle = wasmModule.exports.gpu_atlas_generated(state.handle, revision);
      return handle ? state.binding.resource(handle) : null;
    }

    deviceTexture(device, revision = this.revision) {
      flushAtlasEffects();
      const state = this._gpuState(device);
      state.binding.beginFrame();
      const texture = wasmModule.exports.gpu_atlas_prepare(state.handle, revision, 0);
      state.binding.execute();
      wasmModule.exports.gpu_atlas_publish(state.handle);
      flushRetirements();
      return state.binding.resource(texture);
    }

    async rebuildWebGpuTexture(generator, generatedGlyphs) {
      const state = this._gpuState(generator.device);
      const native = wasmModule.exports;
      const startedAt = hostNow();
      state.binding.beginFrame();
      const texture = native.gpu_atlas_prepare(state.handle, this.revision, 1);
      state.binding.execute();
      const pointer = this._gpuKeys(state, generatedGlyphs);
      native.gpu_atlas_placements(state.handle, pointer, generatedGlyphs.length);
      const view = new DataView(wasmModule.memory.buffer);
      const placements = generatedGlyphs.map((_, index) => ({
        x: view.getUint32(pointer + index * 32 + 24, true),
        y: view.getUint32(pointer + index * 32 + 28, true),
      }));
      const copyMilliseconds = hostNow() - startedAt;
      try {
        const { timings } = await generator.generate(generatedGlyphs.map((glyph) => glyph.preparedGeometry), {
          directAtlas: { texture: state.binding.resource(texture), placements },
        });
        const token = native.gpu_atlas_ready(state.handle, timings.batchCount);
        state.binding.execute();
        if (token) await new Promise((reply, reject) => state.binding.completion(token, { reply, throw: reject }));
        native.gpu_atlas_publish(state.handle);
        flushRetirements();
        return { generationTimings: timings, copyMilliseconds };
      } catch (error) {
        native.gpu_atlas_cancel(state.handle);
        state.binding.execute();
        throw error;
      }
    }

    createRequestWebGpuTexture(device, sourceAtlas, descriptors) {
      const startedAt = hostNow();
      const state = this._gpuState(device);
      const source = sourceAtlas._gpuState(device);
      state.binding.beginFrame();
      const sourceTexture = state.binding.importResource(sourceAtlas.webGpuTexture(device));
      const pointer = this._gpuKeys(state, descriptors);
      const texture = wasmModule.exports.gpu_atlas_request(state.handle, source.handle, sourceTexture, pointer, descriptors.length);
      state.binding.execute();
      wasmModule.exports.gpu_atlas_publish(state.handle);
      flushRetirements();
      return { texture: texture ? state.binding.resource(texture) : null, copyMilliseconds: hostNow() - startedAt };
    }

    getMsdfParams() {
      return { range: MSDF_RANGE };
    }

    onDestroy(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("atlas destroy listener must be a function");
      }
      this._destroyListeners.add(listener);
      return () => this._destroyListeners.delete(listener);
    }

    destroy() {
      if (this._disposed) return;
      this._destroyRequested = true;
      if (this.id && !wasmModule.exports.atlas_destroy_ready(this.id)) {
        wasmModule.exports.atlas_destroy(this.id);
        return;
      }
      this._destroyNow();
    }

    _destroyNow() {
      if (this._disposed) return;
      this._disposed = true;
      atlasOwners.delete(this.id);
      const errors = [];
      for (const listener of this._destroyListeners) {
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
      this._destroyListeners.clear();
      for (const state of this._webGpuTextures.values()) {
        wasmModule.exports.gpu_atlas_close(state.handle);
        flushRetirements();
        retirementRecipients.delete(state.consumer);
        wasmModule.exports.gpu_atlas_destroy(state.handle);
        state.binding.close();
      }
      this._webGpuTextures.clear();
      this._outlineSource?.destroy();
      this._outlineSource = null;
      if (this.id) wasmModule.exports.atlas_destroy(this.id);
      this.id = 0;
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "atlas graphics resource release failed",
        );
      }
    }
  }

  /**
   * Font-level glyph atlas — one wasm atlas handle per font instance: the
   * font file and the 'wdth' coordinate (variationWidth; 0 for none) and
   * 'slnt' coordinate (variationSlant; 0 for upright) every glyph is
   * outlined at.
   */
  class GlyphAtlas extends WasmAtlas {
    constructor(fontBytes, variationWidth = 0, variationSlant = 0, faceIndex = 0) {
      super(0);
      this.fontBytes = fontBytes;
      this.variationWidth = variationWidth;
      this.variationSlant = variationSlant;
      this.faceIndex = faceIndex;
      this.unitsPerEm = 0;
      // Registered HarfBuzz face in fused renderer memory. The native
      // collector supplies outline bytes and metadata; msdfgen receives
      // only bounded verb spans, never font bytes (design/text-rendering.md).
      this._outlineSource = null;
    }

    // The variation instance a glyph is outlined at: the requested weight,
    // the atlas's width and slant (a font without a 'slnt' axis ignores
    // it), and the clamped optical size (opsz-less fonts take none).
    _outlineVariations(Module, weight, opszCss) {
      const variations = [["wght", weight], ["slnt", this.variationSlant]];
      if (this.variationWidth !== 0) {
        variations.push(["wdth", this.variationWidth]);
      }
      if (this._outlineSource.opszAxis) {
        variations.push([
          "opsz",
          Module.exports.atlas_resolve_opsz(this.id, opszCss ?? Number.NaN),
        ]);
      }
      return variations;
    }

    async _ensureCreated() {
      const created = this.id === 0;
      const Module = await super._ensureCreated();
      if (!this._outlineSource) {
        this._outlineSource = await createGlyphOutlineSource(this.fontBytes, { faceIndex: this.faceIndex });
      }
      this._configureOutlineSource(Module, created);
      return Module;
    }

    _ensureGlyphSourceSync() {
      const created = this.id === 0;
      const Module = super._ensureCreatedSync();
      this._outlineSource ??= createGlyphOutlineSourceSync(this.fontBytes, { faceIndex: this.faceIndex });
      this._configureOutlineSource(Module, created);
      return Module;
    }

    _configureOutlineSource(Module, created) {
      if (created) {
        const axis = this._outlineSource.opszAxis;
        const configured = Module.exports.atlas_configure_font(
          this.id,
          this._outlineSource.upem,
          axis ? 1 : 0,
          axis?.min ?? 0,
          axis?.default ?? 0,
          axis?.max ?? 0,
        );
        if (!configured) {
          throw new Error(
            "atlas_configure_font rejected the font metadata — zero units-per-em or a non-glyph atlas handle",
          );
        }
        this.unitsPerEm = this._outlineSource.upem;
      }
    }

    /**
     * Ensure glyphs are cached, generating MSDFs for missing ones — at the
     * given weight, optical size (opszCss, CSS px; null = the font's own
     * default opsz, ignored for opsz-less fonts), and MSDF texel budget
     * (from devicePx). Key construction — opsz clamping, texel-budget
     * bucketing — happens in glyph-atlas.watpart, so ensure
     * and lookup can never disagree; atlas_resolve_opsz hands back the
     * clamped value so the HarfBuzz variation instance matches the key.
     * On a miss, the outline is extracted from HarfBuzz as a flat verb
     * buffer and marshalled into msdfgen's memory for generation.
     */
    async ensureGlyphs(glyphIds, weight, opszCss = null, devicePx = null) {
      const preparationStartedAt = hostNow();
      const Module = await this._ensureCreated();
      return this._generateGlyphs(Module, glyphIds, weight, opszCss, devicePx, preparationStartedAt);
    }

    ensureGlyphsSync(glyphIds, weight, opszCss, devicePx, operation) {
      let result;
      try {
        const startedAt = hostNow();
        result = this._generateGlyphs(this._ensureGlyphSourceSync(), glyphIds, weight, opszCss, devicePx, startedAt);
      } catch (error) {
        operation.throw(error);
        return;
      }
      operation.reply(result);
    }

    _generateGlyphs(Module, glyphIds, weight, opszCss, devicePx, preparationStartedAt) {
      const phases = emptyGlyphPhaseMilliseconds();
      const generatedGlyphs = [];
      const requestedGlyphIds = [...glyphIds];
      const missing = requestedGlyphIds.filter((glyphId) =>
        Module.exports.atlas_lookup_glyph(
          this.id,
          glyphId,
          weight,
          opszCss ?? Number.NaN,
          devicePx ?? 0,
        ) < 0
      );

      if (missing.length > 0) {
        const font = this._outlineSource.createFont(
          this._outlineVariations(Module, weight, opszCss),
        );
        try {
          for (const glyphId of missing) {
            const outlineStartedAt = hostNow();
            const { verbs, advance } = font.glyphOutline(glyphId);
            phases.harfBuzzOutlineExtractionMilliseconds += hostNow() -
              outlineStartedAt;

            const boundaryStartedAt = hostNow();
            const allocationLength = verbs.length || 1;
            const ptr = Module.exports.abi_malloc(allocationLength);
            let slot;
            try {
              new Uint8Array(Module.memory.buffer).set(verbs, ptr);
              slot = Module.insertGlyph(
                this.id,
                glyphId,
                weight,
                opszCss ?? Number.NaN,
                devicePx ?? 0,
                ptr,
                verbs.length,
                advance,
              );
            } finally {
              Module.exports.abi_free(ptr);
            }
            const boundaryMilliseconds = hostNow() - boundaryStartedAt;
            const nativeTimings = nativeGlyphTiming(Module);
            phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds += Math
              .max(
                0,
                boundaryMilliseconds - NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)
                  .reduce((sum, field) => sum + nativeTimings[field], 0),
              );
            for (
              const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)
            ) {
              phases[field] += nativeTimings[field];
            }

            if (slot < 0) {
              throw new Error(
                `glyph atlas insert failed for glyphId ${glyphId}; the native entry limit is 4096; release unused atlas resources`,
              );
            }
            const info = this._infoFloats(slot);
            const width = info[0];
            const height = info[1];
            generatedGlyphs.push(Object.freeze({
              glyphId,
              width,
              height,
              texelCount: width * height,
            }));
          }
        } finally {
          font.destroy();
        }
      }

      const measuredPreparationMilliseconds = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      phases.otherPreparationMilliseconds = Math.max(
        0,
        hostNow() - preparationStartedAt -
          measuredPreparationMilliseconds,
      );
      const totalMilliseconds = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      return Object.freeze({
        requestedGlyphCount: requestedGlyphIds.length,
        cacheHitGlyphCount: requestedGlyphIds.length - missing.length,
        generatedGlyphCount: generatedGlyphs.length,
        outputTexelCount: generatedGlyphs.reduce(
          (total, glyph) => total + glyph.texelCount,
          0,
        ),
        generatedGlyphs: Object.freeze(generatedGlyphs),
        phaseMilliseconds: Object.freeze(phases),
        totalMilliseconds,
      });
    }

    /**
     * Runs the unchanged CPU geometry-preparation and edge-coloring phases, then
     * registers metadata-only atlas entries for one WebGPU batch. The selected
     * WebGPU generator validates and consumes the returned prepared records.
     */
    async prepareGlyphsForWebGpu(
      glyphIds,
      weight,
      opszCss = null,
      devicePx = null,
    ) {
      const preparationStartedAt = hostNow();
      const phases = emptyGlyphPhaseMilliseconds();
      const generatedGlyphs = [];
      const requestedGlyphIds = [...glyphIds];
      const Module = await this._ensureCreated();
      const missing = requestedGlyphIds.filter((glyphId) =>
        Module.exports.atlas_lookup_glyph(
          this.id,
          glyphId,
          weight,
          opszCss ?? Number.NaN,
          devicePx ?? 0,
        ) < 0
      );
      if (missing.length > 0) {
        const font = this._outlineSource.createFont(
          this._outlineVariations(Module, weight, opszCss),
        );
        try {
          for (const glyphId of missing) {
            const outlineStartedAt = hostNow();
            const { verbs, advance } = font.glyphOutline(glyphId);
            phases.harfBuzzOutlineExtractionMilliseconds += hostNow() -
              outlineStartedAt;

            const boundaryStartedAt = hostNow();
            const verbsLength = verbs.length || 1;
            const verbsPointer = Module.exports.abi_malloc(verbsLength);
            let preparedPointer = 0;
            let preparedCapacity = 96;
            let preparedLength = 0;
            try {
              new Uint8Array(Module.memory.buffer).set(verbs, verbsPointer);
              preparedPointer = Module.exports.abi_malloc(preparedCapacity);
              const msdfSize = Module.exports.atlas_glyph_msdf_size(
                this.id,
                devicePx ?? 0,
              );
              const minimumShapeUnitsPerTexel = Module.exports.atlas_glyph_minimum_shape_units_per_texel(
                  this.id,
                  devicePx ?? 0,
                );
              preparedLength = Module.prepareOutline(
                verbsPointer,
                verbs.length,
                msdfSize,
                MSDF_RANGE,
                minimumShapeUnitsPerTexel,
                preparedPointer,
                preparedCapacity,
              );
              if (preparedLength > preparedCapacity) {
                Module.exports.abi_free(preparedPointer);
                preparedCapacity = preparedLength;
                preparedPointer = Module.exports.abi_malloc(preparedCapacity);
                preparedLength = Module.prepareOutline(
                  verbsPointer,
                  verbs.length,
                  msdfSize,
                  MSDF_RANGE,
                  minimumShapeUnitsPerTexel,
                  preparedPointer,
                  preparedCapacity,
                );
              }
              if (preparedLength === 0 || preparedLength > preparedCapacity) {
                throw new Error(
                  `prepared glyph geometry failed for glyphId ${glyphId}`,
                );
              }
              const preparedGeometry = new Uint8Array(Module.memory.buffer).slice(
                preparedPointer,
                preparedPointer + preparedLength,
              );
              const slot = Module.insertPreparedGlyph(
                this.id,
                glyphId,
                weight,
                opszCss ?? Number.NaN,
                devicePx ?? 0,
                preparedPointer,
                preparedLength,
                advance,
              );
              if (slot < 0) {
                throw new Error(
                  `prepared glyph atlas insert failed for glyphId ${glyphId}`,
                );
              }
              const view = new DataView(
                preparedGeometry.buffer,
                preparedGeometry.byteOffset,
                preparedGeometry.byteLength,
              );
              const width = view.getUint32(8, true);
              const height = view.getUint32(12, true);
              generatedGlyphs.push(Object.freeze({
                glyphId,
                weight,
                opticalSize: opszCss,
                devicePixelSize: devicePx,
                width,
                height,
                texelCount: width * height,
                advance,
                preparedGeometry,
              }));
            } finally {
              if (preparedPointer) {
                Module.exports.abi_free(preparedPointer);
              }
              Module.exports.abi_free(verbsPointer);
            }
            const nativeTimings = nativeGlyphTiming(Module);
            const nativeTotal = NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1).reduce(
              (total, field) => total + nativeTimings[field],
              0,
            );
            phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds += Math
              .max(0, hostNow() - boundaryStartedAt - nativeTotal);
            for (const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)) {
              phases[field] += nativeTimings[field];
            }
          }
        } finally {
          font.destroy();
        }
      }
      const measured = Object.values(phases).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      phases.otherPreparationMilliseconds = Math.max(
        0,
        hostNow() - preparationStartedAt - measured,
      );
      return Object.freeze({
        requestedGlyphCount: requestedGlyphIds.length,
        cacheHitGlyphCount: requestedGlyphIds.length - missing.length,
        generatedGlyphCount: generatedGlyphs.length,
        outputTexelCount: generatedGlyphs.reduce(
          (total, glyph) => total + glyph.texelCount,
          0,
        ),
        generatedGlyphs: Object.freeze(generatedGlyphs),
        phaseMilliseconds: Object.freeze(phases),
        totalMilliseconds: Object.values(phases).reduce(
          (total, milliseconds) => total + milliseconds,
          0,
        ),
      });
    }

    hydratePreparedGlyphForCpu(glyph) {
      const Module = this._ensureCreatedSync();
      const startedAt = hostNow();
      const preparedPointer = Module.exports.abi_malloc(glyph.preparedGeometry.length);
      try {
        new Uint8Array(Module.memory.buffer).set(glyph.preparedGeometry, preparedPointer);
        const slot = Module.hydrateGlyph(
          this.id,
          glyph.glyphId,
          glyph.weight,
          glyph.opticalSize ?? Number.NaN,
          glyph.devicePixelSize ?? 0,
          preparedPointer,
          glyph.preparedGeometry.length,
          glyph.advance,
        );
        if (slot < 0) {
          throw new Error(
            `CPU glyph hydration failed for glyphId ${glyph.glyphId}`,
          );
        }
        const phases = emptyGlyphPhaseMilliseconds();
        const nativeTimings = nativeGlyphTiming(Module);
        for (const field of NATIVE_GLYPH_TIMING_FIELDS.slice(0, -1)) {
          phases[field] = nativeTimings[field];
        }
        const measured = Object.values(phases).reduce(
          (total, milliseconds) => total + milliseconds,
          0,
        );
        phases.javascriptToWebAssemblyAllocationCopyCallMilliseconds = Math.max(
          0,
          hostNow() - startedAt - measured,
        );
        return Object.freeze({
          slot,
          phaseMilliseconds: Object.freeze(phases),
        });
      } finally {
        Module.exports.abi_free(preparedPointer);
      }
    }

    /**
     * Copy an already-generated glyph field from a resource atlas into this
     * atlas. This configures a new destination from the source font metadata,
     * but deliberately does not create another HarfBuzz outline source and
     * never calls MSDF generation. Request-scoped atlases use this path so
     * their packing contains only the current render's glyph set.
     */
    async copyGlyphFrom(
      sourceAtlas,
      glyphId,
      weight,
      opszCss = null,
      devicePx = null,
    ) {
      if (!(sourceAtlas instanceof GlyphAtlas)) {
        throw new TypeError("glyph resource source must be a GlyphAtlas");
      }
      const Module = await sourceAtlas._ensureCreated();
      if (!this.id) {
        await super._ensureCreated();
        const axis = sourceAtlas._outlineSource.opszAxis;
        const configured = Module.exports.atlas_configure_font(
          this.id,
          sourceAtlas.unitsPerEm,
          axis ? 1 : 0,
          axis?.min ?? 0,
          axis?.default ?? 0,
          axis?.max ?? 0,
        );
        if (!configured) {
          throw new Error("glyph request atlas rejected source font metadata");
        }
        this.unitsPerEm = sourceAtlas.unitsPerEm;
      }
      const slot = Module.exports.atlas_copy_glyph(
        this.id,
        sourceAtlas.id,
        glyphId,
        weight,
        opszCss ?? Number.NaN,
        devicePx ?? 0,
      );
      if (slot < 0) {
        throw new Error(
          `glyph resource copy failed for glyphId ${glyphId} — source miss, font mismatch, or request atlas full`,
        );
      }
      return slot;
    }

    glyphSlot(glyphId, weight, opszCss = null, devicePx = null) {
      if (!this.id) return -1;
      return wasmModule.exports.atlas_lookup_glyph(
        this.id,
        glyphId,
        weight,
        opszCss ?? Number.NaN,
        devicePx ?? 0,
      );
    }
    glyphResidency(glyphIds, weight, opszCss = null, devicePx = null) {
      const slots = new Int32Array(glyphIds.length);
      if (!glyphIds.length) return slots;
      if (!this.id) {
        slots.fill(-1);
        return slots;
      }
      return this._glyphKeyBatch(
        this._ensureCreatedSync(),
        GlyphPolicy.MODE_RESIDENCY,
        "residency",
        glyphIds,
        weight,
        opszCss,
        devicePx,
        (view, outputPointer) => {
          for (let index = 0; index < glyphIds.length; index++) {
            slots[index] = view.getInt32(
              outputPointer + index * GlyphPolicy.RESIDENCY_SIZE +
                GlyphPolicy.RESIDENCY_SLOT_OFFSET,
              true,
            );
          }
          return slots;
        },
      );
    }

    // Runs one glyph-policy key batch over glyphIds at one weight, optical
    // size and device size, and hands its published output records to
    // readOutput(view, outputPointer).
    _glyphKeyBatch(Module, mode, label, glyphIds, weight, opszCss, devicePx, readOutput) {
      const batch = Module.exports.atlas_glyph_keys_create(glyphIds.length, mode);
      if (!batch) {
        const error = GlyphPolicy.readError(
          new DataView(Module.memory.buffer),
          Module.exports.atlas_glyph_keys_error_ptr(),
        );
        throw new Error(
          `glyph ${label} batch creation failed (${error.code}:${error.field})`,
        );
      }
      try {
        const inputPointer = Module.exports.atlas_glyph_keys_input_ptr(batch);
        const view = new DataView(Module.memory.buffer);
        for (let index = 0; index < glyphIds.length; index++) {
          const row = inputPointer + index * GlyphPolicy.INPUT_SIZE;
          view.setFloat64(
            row + GlyphPolicy.INPUT_GLYPH_ID_OFFSET,
            glyphIds[index],
            true,
          );
          view.setFloat64(row + GlyphPolicy.INPUT_WEIGHT_OFFSET, weight, true);
          view.setFloat64(
            row + GlyphPolicy.INPUT_OPTICAL_SIZE_OFFSET,
            opszCss ?? 0,
            true,
          );
          view.setFloat64(
            row + GlyphPolicy.INPUT_DEVICE_PIXEL_SIZE_OFFSET,
            devicePx ?? 0,
            true,
          );
          view.setUint32(
            row + GlyphPolicy.INPUT_OPTICAL_SIZE_PRESENT_OFFSET,
            Number(opszCss !== null),
            true,
          );
          view.setUint32(
            row + GlyphPolicy.INPUT_DEVICE_PIXEL_SIZE_PRESENT_OFFSET,
            Number(devicePx !== null),
            true,
          );
        }
        if (!Module.exports.atlas_glyph_keys_execute(batch, this.id)) {
          const error = GlyphPolicy.readError(
            new DataView(Module.memory.buffer),
            Module.exports.atlas_glyph_keys_error_ptr(),
          );
          throw new Error(
            `glyph ${label} query failed (${error.code}:${error.field}:${error.recordIndex})`,
          );
        }
        return readOutput(
          new DataView(Module.memory.buffer),
          Module.exports.atlas_glyph_keys_output_ptr(batch),
        );
      } finally {
        Module.exports.atlas_glyph_keys_destroy(batch);
      }
    }

    get generationCount() {
      return this.id ? wasmModule.exports.atlas_generation_count(this.id) : 0;
    }

    destroy() {
      super.destroy();
      if (this._outlineSource) {
        this._outlineSource.destroy();
        this._outlineSource = null;
      }
    }

    // Diagnostic lookup. Raster preparation reads native residency directly.
    glyphInfo(glyphId, weight, opszCss = null, devicePx = null) {
      if (!this.id) return null;
      const slot = wasmModule.exports.atlas_lookup_glyph(
        this.id, glyphId, weight, opszCss ?? Number.NaN, devicePx ?? 0,
      );
      if (slot < 0) return null;
      const f = this._infoFloats(slot);
      if (f === null) return null;
      return {
        w: f[0],
        h: f[1],
        u: f[2],
        v: f[3],
        uW: f[4],
        vH: f[5],
        metrics: {
          bearingX: f[6],
          bearingY: f[7],
          advance: f[8],
          bboxXMin: f[9],
          bboxYMin: f[10],
          bboxXMax: f[11],
          bboxYMax: f[12],
          msdfWidth: f[13],
          msdfHeight: f[14],
        },
      };
    }
  }

  /**
   * MSDF atlas for arbitrary SVG path shapes (design/svg-rendering.md, Tier B) — keyed
   * by path content + fill-rule + scale bucket (+ stroke params), one
   * shared instance across every svg-path/svg-polygon/svg-polyline node in
   * a scene.
   */
  class SvgPathAtlas extends WasmAtlas {
    constructor({ coverageMode = false } = {}) {
      super(1);
      this._pathBoundsByKey = new Map();
      this.coverageMode = coverageMode;
      // pathIndex -> the entry its alias was last ensured from, with the
      // atlas handle. The atlas never evicts an entry, so a path index
      // ensured again from the same definition and screen size names the
      // same slot: ensurePaths skips it instead of encoding its `d` string
      // and probing the atlas every frame.
      this._ensuredByPathIndex = new Map();
    }

    destroy() {
      this._ensuredByPathIndex.clear();
      super.destroy();
    }

    get generationCount() {
      return this.id ? wasmModule.exports.atlas_generation_count(this.id) : 0;
    }

    // The SVG scene writer needs the path bbox before it knows the screen
    // size. Measure geometry without constructing a throwaway distance field;
    // both the async and layout-getter paths share the same cached result.
    async measurePathBounds(pathDef, fillRule) {
      const Module = await this._ensureCreated();
      return this._measurePathBounds(Module, pathDef, fillRule);
    }

    measurePathBoundsSync(pathDef, fillRule) {
      const Module = this._ensureCreatedSync();
      return this._measurePathBounds(Module, pathDef, fillRule);
    }

    _measurePathBounds(Module, pathDef, fillRule) {
      const key = `${fillRule}\0${pathDef}`;
      const cached = this._pathBoundsByKey.get(key);
      if (cached) return cached;
      const bytes = textEncoder.encode(pathDef);
      const pathPtr = Module.exports.abi_malloc(bytes.length || 1);
      const boundsPtr = Module.exports.abi_malloc(16);
      let bounds;
      try {
        new Uint8Array(Module.memory.buffer).set(bytes, pathPtr);
        Module.measurePath(
          pathPtr,
          bytes.length,
          fillRule === "evenodd" ? 1 : 0,
          boundsPtr,
        );
        const values = new Float32Array(Module.memory.buffer, boundsPtr, 4);
        bounds = {
          xMin: values[0],
          yMin: values[1],
          xMax: values[2],
          yMax: values[3],
        };
      } finally {
        Module.exports.abi_free(boundsPtr);
        Module.exports.abi_free(pathPtr);
      }
      this._pathBoundsByKey.set(key, bounds);
      return bounds;
    }

    /**
     * Ensure MSDFs exist for the given { pathDef, fillRule, screenSize,
     * pathIndex?, stroke? } combinations — same entry shape as before (see
     * render-scene.js's callers). stroke selects the stroke-outline shape
     * (stroke-outline shapes get their own atlas entry); pathIndex registers the CMD_SVG_PATH alias resolved
     * by getPathByIndex.
     */
    async ensurePaths(entries) {
      const Module = await this._ensureCreated();
      this._ensureEntries(Module, entries);
    }

    // Synchronous counterpart of ensurePaths, for the layout-getter fast
    // path — throws (via _ensureCreatedSync) rather than awaiting if the
    // wasm module isn't loaded yet.
    ensurePathsSync(entries) {
      this._ensureEntries(this._ensureCreatedSync(), entries);
    }

    _ensureEntries(Module, entries) {
      for (const entry of entries) {
        if (entry.pathIndex === undefined) {
          this._ensurePath(Module, entry);
          continue;
        }
        const ensured = this._ensuredByPathIndex.get(entry.pathIndex);
        if (
          ensured !== undefined && ensured.id === this.id &&
          ensured.pathDef === entry.pathDef && ensured.fillRule === entry.fillRule &&
          ensured.stroke === entry.stroke && ensured.screenSize === entry.screenSize
        ) continue;
        const slot = this._ensurePath(Module, entry);
        Module.exports.atlas_alias_path_index(this.id, entry.pathIndex, slot);
        this._ensuredByPathIndex.set(entry.pathIndex, {
          id: this.id,
          pathDef: entry.pathDef,
          fillRule: entry.fillRule,
          stroke: entry.stroke,
          screenSize: entry.screenSize,
        });
      }
    }

    _ensurePath(Module, { pathDef, fillRule, screenSize, stroke }) {
      const slot = this._pathCall(
        Module.ensurePath,
        pathDef,
        fillRule,
        screenSize,
        stroke,
      );
      if (slot < 0) {
        throw new Error(
          `SVG path atlas reached its 4096-entry limit; release unused atlas resources`,
        );
      }
      return slot;
    }

    // Shared marshalling for ensure and lookup — the path bytes and the
    // normalized stroke params (cap/join default 0, miterLimit default 4,
    // dash by value) must be IDENTICAL between the two, or lookups silently
    // miss entries ensure just created.
    _pathCall(wasmFunction, pathDef, fillRule, screenSize, stroke) {
      const Module = wasmModule;
      const pathBytes = textEncoder.encode(pathDef);
      const pathPtr = Module.exports.abi_malloc(pathBytes.length);
      new Uint8Array(Module.memory.buffer).set(pathBytes, pathPtr);
      const dashArray = stroke?.dashArray ?? [];
      let dashPtr = 0;
      if (dashArray.length) {
        dashPtr = Module.exports.abi_malloc(dashArray.length * 4);
        new Float32Array(Module.memory.buffer, dashPtr, dashArray.length).set(
          dashArray,
        );
      }

      const slot = wasmFunction(
        this.id,
        pathPtr,
        pathBytes.length,
        fillRule === "evenodd" ? 1 : 0,
        screenSize,
        stroke ? 1 : 0,
        stroke?.width ?? 0,
        stroke?.cap ?? 0,
        stroke?.join ?? 0,
        stroke?.miterLimit ?? 4,
        dashPtr,
        dashArray.length,
        stroke?.dashPhase ?? 0,
        this.coverageMode ? 1 : 0,
      );
      if (dashPtr) Module.exports.abi_free(dashPtr);
      Module.exports.abi_free(pathPtr);
      return slot;
    }

    /**
     * Get path info (UV + bbox metrics) for a combination already ensured
     * via ensurePaths. Read-only — a miss returns null, never generates.
     */
    getPath(pathDef, fillRule, screenSize, stroke) {
      if (!this.id) return null;
      const slot = this._pathCall(
        wasmModule.lookupPath,
        pathDef,
        fillRule,
        screenSize,
        stroke,
      );
      return this._pathInfo(slot);
    }

    /**
     * Get path info by the opaque pathIndex a CMD_SVG_PATH command carries —
     * the rasterizer's own lookup path (it never sees pathDef/fillRule/
     * screenSize; see engine.wat's NODE_SVG_PATH_INDEX doc).
     */
    getPathByIndex(pathIndex) {
      if (!this.id) return null;
      return this._pathInfo(
        wasmModule.exports.atlas_path_slot_by_index(this.id, pathIndex),
      );
    }

    _pathInfo(slot) {
      if (slot < 0) return null;
      const f = this._infoFloats(slot);
      if (!f) return null;
      return {
        pixelW: f[0],
        pixelH: f[1],
        bboxXMin: f[9],
        bboxYMin: f[10],
        bboxXMax: f[11],
        bboxYMax: f[12],
        u: f[2],
        v: f[3],
        uW: f[4],
        vH: f[5],
      };
    }
  }

  return Object.freeze({
    flushAtlasEffects,
    completeAtlasEffects() {
      flushAtlasEffects();
    },
    initializeAtlasRuntime,
    GlyphAtlas,
    SvgPathAtlas,
    glyphAtlasFromHandle(handle, fontIndex, variationWidth, variationSlant) {
      if (!wasmModule) throw new Error("Initialize the atlas runtime before adopting a native atlas handle");
      const atlas = new GlyphAtlas(fontIndex, variationWidth, variationSlant);
      atlas._adoptNativeHandle(handle);
      atlas.unitsPerEm = wasmModule.exports.atlas_units_per_em(handle);
      return atlas;
    },
    importGlyphAtlas(source, handle) {
      const imported = transportNativePacket(source, wasmModule, source.exports.atlas_export(handle),
        (pointer, length) => wasmModule.exports.atlas_import(pointer, length));
      const atlas = new WasmAtlas(0);
      atlas._adoptNativeHandle(imported);
      atlas.unitsPerEm = wasmModule.exports.atlas_units_per_em(imported);
      return atlas;
    },
    moduleIdentity() {
      return wasmModule;
    },
  });
}

export const defaultAtlasRuntime = createAtlasRuntime();

export const initializeAtlasRuntime = (...arguments_) =>
  defaultAtlasRuntime.initializeAtlasRuntime(...arguments_);
export class GlyphAtlas extends defaultAtlasRuntime.GlyphAtlas {}
export class SvgPathAtlas extends defaultAtlasRuntime.SvgPathAtlas {}
