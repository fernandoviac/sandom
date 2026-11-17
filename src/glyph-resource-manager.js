import { defaultAtlasRuntime, GLYPH_PERFORMANCE_PHASE_FIELDS, emptyGlyphPhaseMilliseconds, transportNativePacket } from "./atlas.js";
import { createWebGpuMsdfGenerator } from "./msdf-webgpu/generator.js";
import { hostNow } from "./host-clock.js";
import { layoutConstant } from "./wasm/layout-table.js";

const OPTIONAL_ABSENT = layoutConstant("OPTIONAL_ABSENT");
const OPTIONAL_PRESENT = layoutConstant("OPTIONAL_PRESENT");
const OPTIONAL_OTHER = layoutConstant("OPTIONAL_OTHER");
// The fields of the glyph manager records that this host reads
// (glyph-resources.watpart GLYPH_*), keyed by their name without the prefix.
const GLYPH = Object.freeze(Object.fromEntries([
  "FONT_INDEX", "FONT_WIDTH", "FONT_SLANT", "FONT_CONTROL",
  "RESOURCE_GLYPH", "RESOURCE_WEIGHT", "RESOURCE_OPTICAL", "RESOURCE_SIZE", "RESOURCE_PREPARED",
  "RESOURCE_PREPARED_LENGTH", "RESOURCE_ADVANCE", "RESOURCE_READY", "RESOURCE_REQUEST_INDEX",
  "PREPARED_WIDTH", "PREPARED_HEIGHT",
  "OPERATION_REQUEST_COUNT", "OPERATION_REQUESTS", "OPERATION_DEVICE", "OPERATION_REVISIONS",
  "OPERATION_REVISION_COUNT",
  "MANAGER_REQUEST_SIZE", "MANAGER_REQUEST_FONT", "MANAGER_REQUEST_ATLAS", "MANAGER_REQUEST_INSTANCE",
  "MANAGER_STATE", "MANAGER_SHUT_DOWN", "MANAGER_ENTRY_COUNT", "MANAGER_BYTE_LENGTH",
  "MANAGER_FONT_CONTENT_COUNT", "MANAGER_PINNED_REVISION_COUNT", "MANAGER_COUNTERS",
  "MISSING_FONTS_COUNT", "MISSING_FONTS_INSTANCES",
  "REQUEST_CHECK_SIZE", "REQUEST_CHECK_FACE", "REQUEST_CHECK_WIDTH", "REQUEST_CHECK_SLANT",
  "REQUEST_CHECK_FAILING_GLYPH",
  "OPERATION_ROWS", "OPERATION_ERROR", "OPERATION_UNIQUE_COUNT", "OPERATION_GENERATION_BACKEND",
  "OPERATION_DIRECT_POPULATION",
  "INPUT_SIZE", "INPUT_FONT", "INPUT_REQUEST", "INPUT_GLYPH", "INPUT_WEIGHT", "INPUT_OPTICAL", "INPUT_SIZE_PX",
  "EFFECT_KIND", "EFFECT_OPERATION", "EFFECT_FONT", "EFFECT_ATLAS", "EFFECT_SOURCE", "EFFECT_RESOURCES",
  "EFFECT_COUNT", "EFFECT_BACKEND", "EFFECT_GENERATED", "EFFECT_GENERATED_COUNT",
].map((name) => [name, layoutConstant(`GLYPH_${name}`)])));
// The reported names of how an operation generated its glyphs.
const GENERATION_BACKENDS = new Map(["cache-reuse", "cpu-single", "cpu-batch", "webgpu-batch"]
  .map((name) => [layoutConstant(`GLYPH_GENERATION_${name.replaceAll("-", "_").toUpperCase()}`), name]));
// The codes of the glyph manager (glyph-resources.watpart,
// glyph-resource-input.watpart): effect kinds, generation backends, error
// classes and failure messages.
const GLYPH_CODE = Object.freeze(Object.fromEntries([
  "EFFECT_GENERATE", "EFFECT_POPULATE_GPU", "EFFECT_COPY_REQUEST", "EFFECT_ACQUISITION_READY",
  "EFFECT_SHUTDOWN_READY", "EFFECT_ACQUISITION_FAILED", "BACKEND_WEBGPU",
  "CLASS_HOST_ERROR", "CLASS_TYPE_ERROR", "CLASS_RANGE_ERROR", "CLASS_ABORT",
  "MESSAGE_CANCELLED", "MESSAGE_BACKEND", "MESSAGE_FONT_REGISTRATION", "MESSAGE_GENERATED_COUNT",
  "MESSAGE_COPY_TEXTURE", "MESSAGE_NO_RECIPIENT", "MESSAGE_RELEASED_PUBLICATION", "MESSAGE_UNKNOWN_EFFECT",
  "MESSAGE_DISPOSAL", "MESSAGE_SHUTDOWN", "MESSAGE_GLYPH_IDENTIFIER", "MESSAGE_FIRST_FIELD",
].map((name) => [name, layoutConstant(`GLYPH_${name}`)])));

// Constructors validate limits synchronously through the same native ABI used
// by acquisitions. Scene runtimes pass their initialized, fused atlas runtime.
await defaultAtlasRuntime.initializeAtlasRuntime();
const defaultNative = defaultAtlasRuntime.moduleIdentity().exports;
export const GLYPH_RESOURCE_FORMAT_VERSION = defaultNative.glyph_manager_format_version();
export const DEFAULT_GLYPH_RESOURCE_LIMITS = Object.freeze({
  maxEntries: defaultNative.glyph_manager_default_entries(),
  maxBytes: defaultNative.glyph_manager_default_bytes(),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REQUEST_FIELDS = ["weight", "faceIndex", "variationWidth", "variationSlant", "opticalSize", "devicePixelSize"];

// The kind of a request field for glyph_request_check: null and undefined
// are absent.
function fieldKind(value) {
  return value === null || value === undefined ? OPTIONAL_ABSENT : typeof value === "number" ? OPTIONAL_PRESENT : OPTIONAL_OTHER;
}

function checkSignal(signal) {
  if (signal === null) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean" || typeof signal.throwIfAborted !== "function") {
    throw new TypeError("glyph resource signal must be an AbortSignal or null");
  }
  signal.throwIfAborted();
}

function accumulatePhases(target, source) {
  for (const field of GLYPH_PERFORMANCE_PHASE_FIELDS) target[field] += source[field] ?? 0;
}

export class GlyphResourceManager {
  constructor({
    maxEntries = DEFAULT_GLYPH_RESOURCE_LIMITS.maxEntries,
    maxBytes = DEFAULT_GLYPH_RESOURCE_LIMITS.maxBytes,
    webGpuGeneratorFactory = createWebGpuMsdfGenerator,
    atlasRuntime = defaultAtlasRuntime,
  } = {}) {
    if (typeof webGpuGeneratorFactory !== "function") throw new TypeError("webGpuGeneratorFactory must be a function");
    this._runtime = atlasRuntime;
    this._module = atlasRuntime.moduleIdentity();
    if (!this._module) throw new Error("Initialize the atlas runtime before constructing its glyph resource manager");
    this._native = this._module.exports;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this._handle = this._native.glyph_manager_create(
      typeof maxEntries === "number" ? maxEntries : NaN,
      typeof maxBytes === "number" ? maxBytes : NaN,
    );
    if (!this._handle) throw this._error(this._native.glyph_manager_error());
    this._generatorFactory = webGpuGeneratorFactory;
    this._sourceIdentities = new WeakMap();
    this._sourceSequence = 0;
    this._deviceIdentities = new WeakMap();
    this._devices = new Map();
    this._generators = new Map();
    this._atlases = new Map();
    this._publicationFonts = new WeakMap();
    this._publicationFontAllocations = new Set();
    this._completions = new Map();
    this._shutdownCompletions = [];
    this._effectRunning = false;
    this._pumping = false;
    this._memoryView = null;
  }

  _view() {
    const buffer = this._module.memory.buffer;
    if (this._memoryView?.buffer !== buffer) this._memoryView = new DataView(buffer);
    return this._memoryView;
  }

  _text(value) {
    const bytes = encoder.encode(String(value));
    const pointer = this._native.abi_allocate(bytes.byteLength);
    new Uint8Array(this._module.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return [pointer, bytes.byteLength];
  }

  // The error of glyph resource failure `code` (glyph_manager_message):
  // the core formats the message, naming `first`, `second` and the texts
  // `a` and `b`, and names the error class.
  _failure(code, first = 0, second = 0, a = "", b = "") {
    const native = this._native;
    const errorClass = native.glyph_manager_message(code, first, second, ...this._text(a), ...this._text(b));
    const pointer = native.abi_output_pointer();
    const message = decoder.decode(new Uint8Array(this._module.memory.buffer, pointer, native.abi_output_length()));
    if (errorClass === GLYPH_CODE.CLASS_HOST_ERROR) throw new Error(message);
    if (errorClass === GLYPH_CODE.CLASS_ABORT) return new DOMException(message, "AbortError");
    const classes = new Map([[GLYPH_CODE.CLASS_TYPE_ERROR, TypeError], [GLYPH_CODE.CLASS_RANGE_ERROR, RangeError]]);
    return new (classes.get(errorClass) ?? Error)(message);
  }

  _error(code, operation = 0) {
    return this._failure(code, operation, 0, this.maxEntries, this.maxBytes);
  }

  // Converts each request's fields to numbers and kinds; the core checks
  // them, supplies absent coordinates, and names the first failing field
  // (glyph_request_check).
  _transportRequests(requests) {
    if (!Array.isArray(requests)) throw new TypeError("glyph resource requests must be an array");
    return requests.map((request, requestIndex) => {
      if (!(request?.fontBytes instanceof Uint8Array)) {
        throw new TypeError(`glyph resource request ${requestIndex} fontBytes must be a Uint8Array`);
      }
      if (!request.glyphIds || typeof request.glyphIds[Symbol.iterator] !== "function") {
        throw new TypeError(`glyph resource request ${requestIndex} glyphIds must be iterable`);
      }
      const glyphIds = [...request.glyphIds];
      const identifiers = Float64Array.from(glyphIds, (glyphId) => typeof glyphId === "number" ? glyphId : NaN);
      const pointer = this._native.abi_allocate(identifiers.byteLength);
      new Uint8Array(this._module.memory.buffer, pointer, identifiers.byteLength).set(new Uint8Array(identifiers.buffer));
      const fields = REQUEST_FIELDS.flatMap((field) =>
        [typeof request[field] === "number" ? request[field] : NaN, fieldKind(request[field])]);
      const code = this._native.glyph_request_check(pointer, identifiers.length, ...fields);
      const output = this._native.abi_output_pointer();
      const failingGlyph = code === GLYPH_CODE.MESSAGE_GLYPH_IDENTIFIER;
      const view = new DataView(this._module.memory.buffer, output, code === 0 ? GLYPH.REQUEST_CHECK_SIZE : failingGlyph ? 4 : 0);
      if (failingGlyph) {
        throw this._failure(code, requestIndex, 0, String(glyphIds[view.getUint32(GLYPH.REQUEST_CHECK_FAILING_GLYPH, true)]));
      }
      if (code !== 0) throw this._failure(code, requestIndex, 0, String(request[REQUEST_FIELDS[code - GLYPH_CODE.MESSAGE_FIRST_FIELD]]));
      return {
        ...request, glyphIds, faceIndex: view.getUint32(GLYPH.REQUEST_CHECK_FACE, true),
        variationWidth: view.getFloat64(GLYPH.REQUEST_CHECK_WIDTH, true),
        variationSlant: view.getFloat64(GLYPH.REQUEST_CHECK_SLANT, true),
      };
    });
  }

  _backend(backend) {
    if (backend === null) return { kind: -1, device: 0 };
    const kind = this._native.glyph_backend_kind(...this._text(backend?.kind), backend?.device ? 1 : 0);
    if (kind < 0) throw this._error(GLYPH_CODE.MESSAGE_BACKEND);
    let device = 0;
    if (backend.device) {
      device = this._deviceIdentities.get(backend.device);
      if (device === undefined) {
        device = this._devices.size + 1;
        this._deviceIdentities.set(backend.device, device);
        this._devices.set(device, backend.device);
      }
    }
    return { kind, device };
  }

  // The selection is synchronous; the promise keeps the contract.
  selectGenerationBackend(backend) {
    return Promise.try(() => {
      const { kind, device } = this._backend(backend);
      if (!this._native.glyph_manager_select(this._handle, kind, device)) throw this._error(this._native.glyph_manager_error());
    });
  }

  _font(request) {
    const bytes = request.fontBytes;
    let identity = this._sourceIdentities.get(bytes);
    if (identity === undefined) {
      identity = ++this._sourceSequence;
      this._sourceIdentities.set(bytes, identity);
    }
    const buffer = bytes.buffer;
    const mutable = Number(Boolean(buffer.resizable || buffer.growable ||
      (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)));
    let index = this._native.glyph_manager_source(this._handle, identity, mutable, request.faceIndex, bytes.byteLength);
    if (index < 0) {
      const pointer = this._native.abi_malloc(bytes.byteLength);
      new Uint8Array(this._module.memory.buffer, pointer, bytes.byteLength).set(bytes);
      index = this._native.register_font_for_outline(pointer, bytes.byteLength, request.faceIndex);
      if (index < 0) throw this._failure(GLYPH_CODE.MESSAGE_FONT_REGISTRATION, this._native.font_table_count());
      this._native.glyph_manager_source_publish(this._handle, identity, mutable, request.faceIndex, index, bytes.byteLength);
    }
    const font = this._native.glyph_manager_font(this._handle, index, request.variationWidth, request.variationSlant, 0);
    if (!font) throw this._error(this._native.glyph_manager_error());
    return font;
  }

  _atlas(handle, font) {
    let atlas = this._atlases.get(handle);
    if (!atlas) {
      const view = this._view();
      atlas = this._runtime.glyphAtlasFromHandle(handle, view.getUint32(font + GLYPH.FONT_INDEX, true),
        view.getFloat64(font + GLYPH.FONT_WIDTH, true), view.getFloat64(font + GLYPH.FONT_SLANT, true),
        view.getUint32(font + GLYPH.FONT_CONTROL, true));
      this._atlases.set(handle, atlas);
    }
    return atlas;
  }

  _resource(pointer, includePrepared = true) {
    const view = this._view();
    const preparedPointer = view.getUint32(pointer + GLYPH.RESOURCE_PREPARED, true);
    const preparedLength = view.getUint32(pointer + GLYPH.RESOURCE_PREPARED_LENGTH, true);
    const preparedGeometry = includePrepared && preparedPointer
      ? new Uint8Array(this._module.memory.buffer, preparedPointer, preparedLength).slice()
      : null;
    const width = preparedPointer ? view.getUint32(preparedPointer + GLYPH.PREPARED_WIDTH, true) : 0;
    const height = preparedPointer ? view.getUint32(preparedPointer + GLYPH.PREPARED_HEIGHT, true) : 0;
    return {
      pointer, glyphId: view.getUint32(pointer + GLYPH.RESOURCE_GLYPH, true),
      weight: view.getFloat32(pointer + GLYPH.RESOURCE_WEIGHT, true),
      opticalSize: view.getFloat64(pointer + GLYPH.RESOURCE_OPTICAL, true),
      devicePixelSize: view.getFloat64(pointer + GLYPH.RESOURCE_SIZE, true),
      requestIndex: view.getUint32(pointer + GLYPH.RESOURCE_REQUEST_INDEX, true),
      ready: view.getUint32(pointer + GLYPH.RESOURCE_READY, true) !== 0,
      advance: view.getFloat32(pointer + GLYPH.RESOURCE_ADVANCE, true), preparedGeometry, width, height, texelCount: width * height,
    };
  }

  _resourceRows(pointer, count, includePrepared = true) {
    const view = this._view();
    return Array.from({ length: count }, (_, index) =>
      this._resource(view.getUint32(pointer + index * Uint32Array.BYTES_PER_ELEMENT, true), includePrepared));
  }

  _generate(effect, completion, operation) {
    const atlas = this._atlas(effect.atlas, effect.font);
    let start = 0;
    const publish = (descriptors, result) => {
      accumulatePhases(completion.phases, result.phaseMilliseconds);
      if (result.generatedGlyphs.length !== descriptors.length) {
        throw this._failure(GLYPH_CODE.MESSAGE_GENERATED_COUNT, descriptors.length, result.generatedGlyphs.length);
      }
      for (let index = 0; index < descriptors.length; index++) {
        const descriptor = descriptors[index];
        const glyph = result.generatedGlyphs[index];
        if (effect.backend === GLYPH_CODE.BACKEND_WEBGPU) {
          const pointer = this._native.abi_malloc(glyph.preparedGeometry.byteLength);
          try {
            new Uint8Array(this._module.memory.buffer, pointer, glyph.preparedGeometry.byteLength).set(glyph.preparedGeometry);
            this._native.glyph_manager_prepared(effect.operation, descriptor.pointer, pointer, glyph.preparedGeometry.byteLength, glyph.advance);
          } finally {
            this._native.abi_free(pointer);
          }
        }
        completion.generatedGlyphs.push({ requestIndex: descriptor.requestIndex, weight: descriptor.weight,
          opticalSize: descriptor.opticalSize, devicePixelSize: descriptor.devicePixelSize, ...glyph });
      }
    };
    const advance = () => {
      try {
        while (start < effect.count) {
          const end = this._native.glyph_manager_group_end(effect.operation, start);
          const descriptors = this._resourceRows(effect.resources + start * 4, end - start);
          const first = descriptors[0];
          if (first.ready) {
            for (const descriptor of descriptors) {
              accumulatePhases(completion.phases, atlas.hydratePreparedGlyphForCpu(descriptor).phaseMilliseconds);
            }
          } else if (effect.backend === GLYPH_CODE.BACKEND_WEBGPU) {
            atlas.prepareGlyphsForWebGpu(descriptors.map((descriptor) => descriptor.glyphId),
              first.weight, first.opticalSize, first.devicePixelSize).then((result) => {
                try { publish(descriptors, result); } catch (error) { operation.throw(error); return; }
                start = end;
                advance();
              }, (error) => operation.throw(error));
            return;
          } else {
            atlas.ensureGlyphsSync(descriptors.map((descriptor) => descriptor.glyphId),
              first.weight, first.opticalSize, first.devicePixelSize, {
                reply: (result) => publish(descriptors, result),
                throw(error) { throw error; },
              });
          }
          start = end;
        }
      } catch (error) {
        operation.throw(error);
        return;
      }
      operation.reply();
    };
    advance();
  }

  async _populateGpu(effect, completion) {
    const operation = this._native.glyph_manager_operation(effect.operation);
    const deviceIdentity = this._view().getUint32(operation + GLYPH.OPERATION_DEVICE, true);
    let generator = this._generators.get(deviceIdentity);
    if (!generator) {
      generator = await this._generatorFactory({ device: this._devices.get(deviceIdentity) });
      this._generators.set(deviceIdentity, generator);
      completion.phases.webGpuPipelineCreationMilliseconds += generator.pipelineCreationMilliseconds;
    }
    const atlas = this._atlas(effect.atlas, effect.font);
    const { generationTimings, copyMilliseconds } = await atlas.rebuildWebGpuTexture(generator,
      this._resourceRows(effect.generated, effect.generatedCount));
    completion.phases.directAtlasCopyMilliseconds += copyMilliseconds;
    if (generationTimings) {
      completion.phases.webGpuCpuPackingMilliseconds += generationTimings.cpuPackMilliseconds;
      completion.phases.webGpuUploadMilliseconds += generationTimings.uploadMilliseconds;
      completion.phases.webGpuEncodeMilliseconds += Math.max(0, generationTimings.encodeMilliseconds - generationTimings.directAtlasPopulationMilliseconds);
      completion.phases.webGpuSubmitMilliseconds += generationTimings.submitMilliseconds;
      completion.phases.webGpuCompletionMilliseconds += generationTimings.completionMilliseconds;
      completion.phases.directAtlasPopulationMilliseconds += generationTimings.directAtlasPopulationMilliseconds;
    }
  }

  _copyRequest(effect, completion) {
    const operation = this._native.glyph_manager_operation(effect.operation);
    const device = this._devices.get(this._view().getUint32(operation + GLYPH.OPERATION_DEVICE, true));
    const result = this._atlas(effect.atlas, effect.font).createRequestWebGpuTexture(device,
      this._atlas(effect.source, effect.font), this._resourceRows(effect.resources, effect.count, false));
    if (!result.texture) throw this._failure(GLYPH_CODE.MESSAGE_COPY_TEXTURE, effect.operation);
    completion.phases.directAtlasCopyMilliseconds += result.copyMilliseconds;
  }

  _dispose() {
    const errors = [];
    let handle;
    while ((handle = this._native.glyph_manager_dispose_next(this._handle)) !== 0) {
      const atlas = this._atlases.get(handle);
      this._atlases.delete(handle);
      try {
        if (atlas) atlas.destroy();
        else this._native.atlas_destroy(handle);
      } catch (error) {
        errors.push(error);
      }
    }
    this._runtime.flushAtlasEffects();
    if (errors.length) throw new AggregateError(errors, this._failure(GLYPH_CODE.MESSAGE_DISPOSAL).message);
  }

  _performance(operation, completion) {
    const view = this._view();
    const requestedGlyphCount = view.getUint32(operation + GLYPH.OPERATION_UNIQUE_COUNT, true);
    const requests = view.getUint32(operation + GLYPH.OPERATION_REQUESTS, true);
    const generatedGlyphs = Object.freeze(completion.generatedGlyphs.map((glyph) => {
      if (!completion.publication) return Object.freeze(glyph);
      const { requestIndex, ...fields } = glyph;
      return Object.freeze({
        fontIndex: view.getUint32(requests + requestIndex * GLYPH.MANAGER_REQUEST_SIZE + GLYPH.MANAGER_REQUEST_INSTANCE, true),
        ...fields,
      });
    }));
    const generationBackend = GENERATION_BACKENDS.get(view.getUint32(operation + GLYPH.OPERATION_GENERATION_BACKEND, true));
    const measured = Object.values(completion.phases).reduce((sum, value) => sum + value, 0);
    completion.phases[generationBackend === "cache-reuse" ? "cacheReuseMilliseconds" : "otherPreparationMilliseconds"] +=
      Math.max(0, hostNow() - completion.startedAt - measured);
    const phaseMilliseconds = Object.freeze({ ...completion.phases });
    return Object.freeze({ requestedGlyphCount, cacheHitGlyphCount: requestedGlyphCount - generatedGlyphs.length,
      generatedGlyphCount: generatedGlyphs.length, outputTexelCount: generatedGlyphs.reduce((sum, glyph) => sum + glyph.texelCount, 0),
      generatedGlyphs, phaseMilliseconds, generationBackend,
      directAtlasPopulation: view.getUint32(operation + GLYPH.OPERATION_DIRECT_POPULATION, true) !== 0,
      totalMilliseconds: Object.values(phaseMilliseconds).reduce((sum, value) => sum + value, 0) });
  }

  _lease(token, operation, glyphPerformance, destination = this._runtime) {
    const view = this._view();
    const count = view.getUint32(operation + GLYPH.OPERATION_REQUEST_COUNT, true);
    const requests = view.getUint32(operation + GLYPH.OPERATION_REQUESTS, true);
    const foreign = destination.moduleIdentity().memory !== this._module.memory;
    const bindings = [];
    const atlases = [];
    try {
      for (let index = 0; index < count; index++) {
        const row = requests + index * GLYPH.MANAGER_REQUEST_SIZE;
        const current = this._view();
        const handle = current.getUint32(row + GLYPH.MANAGER_REQUEST_ATLAS, true);
        const instance = current.getUint32(row + GLYPH.MANAGER_REQUEST_INSTANCE, true);
        atlases.push(foreign ? destination.importGlyphAtlas(this._module, handle)
          : this._atlas(handle, current.getUint32(row + GLYPH.MANAGER_REQUEST_FONT, true)));
        if (foreign) bindings.push(instance);
      }
    } catch (error) {
      for (const atlas of atlases) if (foreign) atlas.destroy();
      throw error;
    }
    const native = () => this._native;
    const pump = () => this._pump();
    const failure = (code) => this._failure(code);
    return Object.freeze({
      atlases: Object.freeze(atlases),
      revisions: Object.freeze(Array.from(new Uint32Array(this._module.memory.buffer,
        this._view().getUint32(operation + GLYPH.OPERATION_REVISIONS, true),
        this._view().getUint32(operation + GLYPH.OPERATION_REVISION_COUNT, true)))),
      glyphPerformance,
      get active() { return native().glyph_lease_active(token) !== 0; },
      bindRasterResources() {
        if (!foreign) return native().glyph_lease_bind_raster(token);
        if (!native().glyph_lease_active(token)) throw failure(GLYPH_CODE.MESSAGE_RELEASED_PUBLICATION);
        const destinationNative = destination.moduleIdentity().exports;
        for (let index = 0; index < atlases.length; index++) destinationNative.raster_bind_font_atlas(bindings[index], atlases[index].id);
      },
      releaseSourcePins() { native().glyph_lease_release_sources(token); pump(); },
      release() {
        if (foreign) for (const atlas of atlases) atlas.destroy();
        native().glyph_lease_release(token); pump();
      },
    });
  }

  _pump() {
    if (this._effectRunning || this._pumping) return;
    this._pumping = true;
    try {
      this._drainEffects();
    } finally {
      this._pumping = false;
    }
  }

  _drainEffects() {
    while (!this._effectRunning) {
      this._dispose();
      const startedAt = hostNow();
      const pointer = this._native.glyph_manager_effect(this._handle);
      const nativeMilliseconds = hostNow() - startedAt;
      this._dispose();
      if (!pointer) return;
      const view = this._view();
      const field = (name) => view.getUint32(pointer + GLYPH[`EFFECT_${name}`], true);
      const effect = { kind: field("KIND"), operation: field("OPERATION"), font: field("FONT"), atlas: field("ATLAS"),
        source: field("SOURCE"), resources: field("RESOURCES"), count: field("COUNT"), backend: field("BACKEND"),
        generated: field("GENERATED"), generatedCount: field("GENERATED_COUNT") };
      const completion = this._completions.get(effect.operation);
      if (completion) completion.phases.atlasRebuildAndPackingMilliseconds += nativeMilliseconds;
      if (effect.kind === GLYPH_CODE.EFFECT_ACQUISITION_READY || effect.kind === GLYPH_CODE.EFFECT_ACQUISITION_FAILED) {
        if (!completion) throw this._failure(GLYPH_CODE.MESSAGE_NO_RECIPIENT, effect.operation);
        const operation = this._native.glyph_manager_operation(effect.operation);
        let result;
        let error;
        if (effect.kind === GLYPH_CODE.EFFECT_ACQUISITION_READY) {
          const performance = this._performance(operation, completion);
          try {
            result = completion.prewarm ? { glyphPerformance: performance }
              : this._lease(effect.operation, operation, performance, completion.destination);
          } catch (failure) {
            error = failure;
          }
        } else {
          const code = this._view().getUint32(operation + GLYPH.OPERATION_ERROR, true);
          error = (code === GLYPH_CODE.MESSAGE_CANCELLED ? completion.abortReason : completion.error) ?? this._error(code, effect.operation);
        }
        this._native.glyph_manager_reply(effect.operation, 1);
        if (error && effect.kind === GLYPH_CODE.EFFECT_ACQUISITION_READY && !completion.prewarm) this._native.glyph_lease_release(effect.operation);
        this._completions.delete(effect.operation);
        completion.signal?.removeEventListener("abort", completion.onAbort);
        if (error) completion.reject(error);
        else completion.resolve(completion.prewarm ? Object.freeze({ ...result, cache: this.snapshot() }) : result);
        continue;
      }
      this._effectRunning = true;
      this._executeEffect(effect, completion, { reply: () => {
        if (effect.kind === GLYPH_CODE.EFFECT_SHUTDOWN_READY) {
          this._native.glyph_manager_shutdown_reply(this._handle);
          for (const recipient of this._shutdownCompletions.splice(0)) recipient.resolve();
        } else {
          const startedAt = hostNow();
          this._native.glyph_manager_reply(effect.operation, 1);
          completion.phases.atlasRebuildAndPackingMilliseconds += hostNow() - startedAt;
        }
        this._effectRunning = false;
        this._pump();
      }, throw: (error) => {
        if (effect.kind === GLYPH_CODE.EFFECT_SHUTDOWN_READY) {
          this._native.glyph_manager_shutdown_reply(this._handle);
          for (const recipient of this._shutdownCompletions.splice(0)) recipient.reject(error);
        } else {
          completion.error = error;
          this._native.glyph_manager_reply(effect.operation, 0);
        }
        this._effectRunning = false;
        this._pump();
      } });
    }
  }

  _executeEffect(effect, completion, operation) {
    try {
      switch (effect.kind) {
        case GLYPH_CODE.EFFECT_GENERATE: this._generate(effect, completion, operation); return;
        case GLYPH_CODE.EFFECT_POPULATE_GPU:
          this._populateGpu(effect, completion).then(() => operation.reply(), (error) => operation.throw(error));
          return;
        case GLYPH_CODE.EFFECT_COPY_REQUEST:
          this._copyRequest(effect, completion);
          break;
        case GLYPH_CODE.EFFECT_SHUTDOWN_READY:
          this._shutdownGenerators().then(() => operation.reply(), (error) => operation.throw(error));
          return;
        default: throw this._failure(GLYPH_CODE.MESSAGE_UNKNOWN_EFFECT, effect.kind);
      }
    } catch (error) {
      operation.throw(error);
      return;
    }
    operation.reply();
  }

  async _shutdownGenerators() {
    const errors = [];
    for (const generator of this._generators.values()) {
      try { await generator.shutdown(); } catch (error) { errors.push(error); }
    }
    this._generators.clear();
    for (const bindings of this._publicationFontAllocations) this._native.glyph_font_bindings_destroy(bindings);
    this._publicationFontAllocations.clear();
    this._runtime.completeAtlasEffects();
    if (errors.length) throw new AggregateError(errors, this._failure(GLYPH_CODE.MESSAGE_SHUTDOWN).message);
  }

  _beginSubmission(requests, { generationBackend = null, signal = null } = {}, prewarm = false) {
    checkSignal(signal);
    const startedAt = hostNow();
    const transported = this._transportRequests(requests);
    const fonts = transported.map((request) => this._font(request));
    const backend = this._backend(generationBackend);
    const count = transported.reduce((sum, request) => sum + request.glyphIds.length, 0);
    const token = this._native.glyph_manager_begin(this._handle, count, transported.length, backend.kind, backend.device);
    if (!token) throw this._error(this._native.glyph_manager_error());
    const operation = this._native.glyph_manager_operation(token);
    const view = this._view();
    const rows = view.getUint32(operation + GLYPH.OPERATION_ROWS, true);
    const requestRows = view.getUint32(operation + GLYPH.OPERATION_REQUESTS, true);
    let index = 0;
    for (let requestIndex = 0; requestIndex < transported.length; requestIndex++) {
      const request = transported[requestIndex];
      view.setUint32(requestRows + requestIndex * GLYPH.MANAGER_REQUEST_SIZE + GLYPH.MANAGER_REQUEST_FONT, fonts[requestIndex], true);
      for (const glyphId of request.glyphIds) {
        const row = rows + index++ * GLYPH.INPUT_SIZE;
        view.setUint32(row + GLYPH.INPUT_FONT, fonts[requestIndex], true);
        view.setUint32(row + GLYPH.INPUT_REQUEST, requestIndex, true);
        view.setUint32(row + GLYPH.INPUT_GLYPH, glyphId, true);
        view.setFloat32(row + GLYPH.INPUT_WEIGHT, request.weight, true);
        view.setFloat64(row + GLYPH.INPUT_OPTICAL, request.opticalSize ?? Number.NaN, true);
        view.setFloat64(row + GLYPH.INPUT_SIZE_PX, request.devicePixelSize ?? 0, true);
      }
    }
    if (prewarm) this._native.glyph_manager_prewarm(token);
    return { token, startedAt };
  }

  _registerSubmission(token, { signal = null, prewarm = false, publication = false, destination = this._runtime, startedAt }, operation) {
    const completion = {
      resolve: (value) => operation.reply(value), reject: (error) => operation.throw(error),
      signal, prewarm, publication, destination, startedAt, phases: emptyGlyphPhaseMilliseconds(), generatedGlyphs: [],
    };
    completion.onAbort = () => {
      completion.abortReason = signal.reason;
      this._native.glyph_manager_cancel(token);
      this._pump();
    };
    this._completions.set(token, completion);
    signal?.addEventListener("abort", completion.onAbort, { once: true });
    this._native.glyph_manager_submit(token);
    this._pump();
  }

  _completeSubmission(token, options) {
    return new Promise((resolve, reject) => this._registerSubmission(token, options, { reply: resolve, throw: reject }));
  }

  async _submit(requests, options = {}, prewarm = false) {
    const { token, startedAt } = this._beginSubmission(requests, options, prewarm);
    return await this._completeSubmission(token, { signal: options.signal, prewarm, startedAt });
  }

  acquireWithCompletion(requests, options, operation) {
    let submission;
    try { submission = this._beginSubmission(requests, options); }
    catch (error) { operation.throw(error); return; }
    this._registerSubmission(submission.token, { signal: options?.signal, startedAt: submission.startedAt }, operation);
  }

  acquirePublication(snapshot, { generationBackend = null, atlasRuntime = this._runtime } = {}) {
    const startedAt = hostNow();
    const backend = this._backend(generationBackend);
    const pointer = this._native.abi_malloc(snapshot.byteLength);
    let token;
    try {
      new Uint8Array(this._module.memory.buffer, pointer, snapshot.byteLength).set(snapshot);
      let bindings = 0;
      const source = atlasRuntime.moduleIdentity();
      if (source.memory !== this._module.memory) {
        bindings = this._publicationFonts.get(source.memory);
        if (!bindings) {
          bindings = this._native.glyph_font_bindings_create();
          this._publicationFonts.set(source.memory, bindings);
          this._publicationFontAllocations.add(bindings);
        }
        const missing = this._native.glyph_publication_missing_fonts(pointer, snapshot.byteLength, bindings);
        try {
          const count = this._view().getUint32(missing + GLYPH.MISSING_FONTS_COUNT, true);
          for (let index = 0; index < count; index++) {
            const instance = this._view().getUint32(missing + GLYPH.MISSING_FONTS_INSTANCES + index * Uint32Array.BYTES_PER_ELEMENT, true);
            transportNativePacket(source, this._module, source.exports.glyph_font_export(instance),
              (packet, length) => this._native.glyph_manager_import_font(this._handle, bindings, instance, packet, length));
          }
        } finally {
          this._native.abi_free(missing);
        }
      }
      token = this._native.glyph_manager_begin_publication(
        this._handle, pointer, snapshot.byteLength, backend.kind, backend.device, bindings,
      );
    } finally {
      this._native.abi_free(pointer);
    }
    if (!token) throw this._error(this._native.glyph_manager_error());
    return this._completeSubmission(token, { publication: true, destination: atlasRuntime, startedAt });
  }

  acquire(requests, options = {}) { return this._submit(requests, options); }
  prewarm(requests, options = {}) { return this._submit(requests, options, true); }

  snapshot() {
    const pointer = this._native.glyph_manager_snapshot(this._handle);
    const view = this._view();
    const counters = ["requestCount", "hitCount", "missCount", "generatedGlyphCount", "reusedGlyphCount", "evictionCount", "replacementCount", "coalescedRequestCount"];
    return Object.freeze({ formatVersion: GLYPH_RESOURCE_FORMAT_VERSION, maxEntries: this.maxEntries, maxBytes: this.maxBytes,
      entryCount: view.getUint32(pointer + GLYPH.MANAGER_ENTRY_COUNT, true),
      byteLength: view.getUint32(pointer + GLYPH.MANAGER_BYTE_LENGTH, true),
      fontContentCount: view.getUint32(pointer + GLYPH.MANAGER_FONT_CONTENT_COUNT, true),
      pinnedRevisionCount: view.getUint32(pointer + GLYPH.MANAGER_PINNED_REVISION_COUNT, true),
      shutDown: view.getUint32(pointer + GLYPH.MANAGER_STATE, true) === GLYPH.MANAGER_SHUT_DOWN,
      ...Object.fromEntries(counters.map((field, index) =>
        [field, view.getUint32(pointer + GLYPH.MANAGER_COUNTERS + index * Uint32Array.BYTES_PER_ELEMENT, true)])) });
  }

  shutdown() {
    this._native.glyph_manager_shutdown(this._handle);
    if (this.snapshot().shutDown) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._shutdownCompletions.push({ resolve, reject });
      this._pump();
    });
  }
}

let defaultGlyphResourceManager = null;
export function getDefaultGlyphResourceManager() {
  if (!defaultGlyphResourceManager || defaultGlyphResourceManager.snapshot().shutDown) defaultGlyphResourceManager = new GlyphResourceManager();
  return defaultGlyphResourceManager;
}
export async function shutdownDefaultGlyphResourceManager() {
  const manager = defaultGlyphResourceManager;
  defaultGlyphResourceManager = null;
  if (manager) await manager.shutdown();
}
