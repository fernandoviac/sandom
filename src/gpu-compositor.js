// The same-device compositor binding (docs/specifications/gpu-command-stream.md).
// Renderer-core (src/wasm/gpu-compositor.watpart) owns layer
// uniforms, instance packing, glyph quads, buffer capacity, bind groups, and
// the composition pass. This module validates the public records, shapes
// text, leases glyph atlases, and transports their values.
import { GlyphResourceManager } from "./glyph-resource-manager.js";
import { validateClosedRecord } from "./closed-record.js";
import { createGpuBinding } from "./gpu-binding.js";
import { createGpuPipelineLibrary } from "./gpu-pipeline-library.js";
import { shapeFontText } from "./shaping.js";
import { decodeWebFont } from "./web-font.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";

let compositorCore;

const IDENTITY_TRANSFORM = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});
const DEFAULT_TEXT_COLOR = Object.freeze([1, 1, 1, 1]);
const DEFAULT_CLEAR_COLOR = Object.freeze([0, 0, 0, 1]);
const TEXTURE_LAYER_FIELDS = new Set([
  "textureView",
  "destinationRectangle",
  "opacity",
  "clipRectangle",
  "transform",
]);
const TEXT_LAYER_FIELDS = new Set([
  "fontBytes",
  "text",
  "fontSize",
  "baselinePosition",
  "color",
  "letterSpacing",
  "weight",
  "opticalSize",
  "opacity",
  "clipRectangle",
  "transform",
]);

function validateFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function validateUnitInterval(value, name) {
  validateFiniteNumber(value, name);
  if (value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function validateRectangle(value, name) {
  validateClosedRecord(value, new Set(["x", "y", "width", "height"]), name);
  const rectangle = {
    x: validateFiniteNumber(value.x, `${name}.x`),
    y: validateFiniteNumber(value.y, `${name}.y`),
    width: validateFiniteNumber(value.width, `${name}.width`),
    height: validateFiniteNumber(value.height, `${name}.height`),
  };
  if (rectangle.width <= 0 || rectangle.height <= 0) {
    throw new RangeError(`${name} width and height must be positive`);
  }
  return Object.freeze(rectangle);
}

function validatePosition(value, name) {
  validateClosedRecord(value, new Set(["x", "y"]), name);
  return Object.freeze({
    x: validateFiniteNumber(value.x, `${name}.x`),
    y: validateFiniteNumber(value.y, `${name}.y`),
  });
}

function validateTransform(value, name) {
  validateClosedRecord(value, new Set(["a", "b", "c", "d", "e", "f"]), name);
  const transform = Object.freeze({
    a: validateFiniteNumber(value.a, `${name}.a`),
    b: validateFiniteNumber(value.b, `${name}.b`),
    c: validateFiniteNumber(value.c, `${name}.c`),
    d: validateFiniteNumber(value.d, `${name}.d`),
    e: validateFiniteNumber(value.e, `${name}.e`),
    f: validateFiniteNumber(value.f, `${name}.f`),
  });
  if (transform.a * transform.d - transform.b * transform.c === 0) {
    throw new RangeError(`${name} must be invertible`);
  }
  return transform;
}

function validateColor(value, name, { opaque = false } = {}) {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new TypeError(`${name} must be a four-component array`);
  }
  if (value.length !== 4) {
    throw new RangeError(`${name} must contain four components`);
  }
  const color = Object.freeze(Array.from(value, (component, index) =>
    validateFiniteNumber(component, `${name}[${index}]`)
  ));
  validateUnitInterval(color[3], `${name}[3]`);
  if (opaque && color[3] !== 1) {
    throw new RangeError(`${name} must be opaque`);
  }
  return color;
}

function normalizeClipRectangle(value, name) {
  return value === null ? null : validateRectangle(value, name);
}

function normalizeTextureRecord(record, previous = null) {
  validateClosedRecord(record, TEXTURE_LAYER_FIELDS, "texture layer");
  const textureView = record.textureView === undefined
    ? previous?.textureView
    : record.textureView;
  if (
    textureView === null ||
    (typeof textureView !== "object" && typeof textureView !== "function")
  ) {
    throw new TypeError("texture layer textureView must be a GPUTextureView");
  }
  const destinationRectangle = record.destinationRectangle === undefined
    ? previous?.destinationRectangle
    : validateRectangle(
      record.destinationRectangle,
      "texture layer destinationRectangle",
    );
  if (!destinationRectangle) {
    throw new TypeError("texture layer destinationRectangle is required");
  }
  return Object.freeze({
    textureView,
    destinationRectangle,
    opacity: record.opacity === undefined
      ? previous?.opacity ?? 1
      : validateUnitInterval(record.opacity, "texture layer opacity"),
    clipRectangle: record.clipRectangle === undefined
      ? previous?.clipRectangle ?? null
      : normalizeClipRectangle(
        record.clipRectangle,
        "texture layer clipRectangle",
      ),
    transform: record.transform === undefined
      ? previous?.transform ?? IDENTITY_TRANSFORM
      : validateTransform(record.transform, "texture layer transform"),
  });
}

function normalizeTextRecord(record, previous = null) {
  validateClosedRecord(record, TEXT_LAYER_FIELDS, "text layer");
  const fontBytes = record.fontBytes === undefined
    ? previous?.fontBytes
    : record.fontBytes;
  if (!(fontBytes instanceof Uint8Array)) {
    throw new TypeError("text layer fontBytes must be a Uint8Array");
  }
  const text = record.text === undefined ? previous?.text : record.text;
  if (typeof text !== "string") {
    throw new TypeError("text layer text must be a string");
  }
  const fontSize = record.fontSize === undefined
    ? previous?.fontSize
    : validateFiniteNumber(record.fontSize, "text layer fontSize");
  if (fontSize === undefined || fontSize <= 0) {
    throw new RangeError("text layer fontSize must be positive");
  }
  const baselinePosition = record.baselinePosition === undefined
    ? previous?.baselinePosition
    : validatePosition(record.baselinePosition, "text layer baselinePosition");
  if (!baselinePosition) {
    throw new TypeError("text layer baselinePosition is required");
  }
  const weight = record.weight === undefined
    ? previous?.weight ?? 400
    : validateFiniteNumber(record.weight, "text layer weight");
  const opticalSize = record.opticalSize === undefined
    ? previous?.opticalSize ?? fontSize
    : validateFiniteNumber(record.opticalSize, "text layer opticalSize");
  if (opticalSize <= 0) {
    throw new RangeError("text layer opticalSize must be positive");
  }
  return Object.freeze({
    fontBytes,
    text,
    fontSize,
    baselinePosition,
    color: record.color === undefined
      ? previous?.color ?? DEFAULT_TEXT_COLOR
      : validateColor(record.color, "text layer color"),
    letterSpacing: record.letterSpacing === undefined
      ? previous?.letterSpacing ?? 0
      : validateFiniteNumber(record.letterSpacing, "text layer letterSpacing"),
    weight,
    opticalSize,
    opacity: record.opacity === undefined
      ? previous?.opacity ?? 1
      : validateUnitInterval(record.opacity, "text layer opacity"),
    clipRectangle: record.clipRectangle === undefined
      ? previous?.clipRectangle ?? null
      : normalizeClipRectangle(record.clipRectangle, "text layer clipRectangle"),
    transform: record.transform === undefined
      ? previous?.transform ?? IDENTITY_TRANSFORM
      : validateTransform(record.transform, "text layer transform"),
  });
}

function writeTransform(view, offset, transform) {
  view.setFloat64(offset, transform.a, true);
  view.setFloat64(offset + 8, transform.b, true);
  view.setFloat64(offset + 16, transform.c, true);
  view.setFloat64(offset + 24, transform.d, true);
  view.setFloat64(offset + 32, transform.e, true);
  view.setFloat64(offset + 40, transform.f, true);
}

function writeClip(view, offset, clipRectangle) {
  view.setFloat64(offset, clipRectangle === null ? 0 : 1, true);
  view.setFloat64(offset + 8, clipRectangle?.x ?? 0, true);
  view.setFloat64(offset + 16, clipRectangle?.y ?? 0, true);
  view.setFloat64(offset + 24, clipRectangle?.width ?? 0, true);
  view.setFloat64(offset + 32, clipRectangle?.height ?? 0, true);
}

export async function createGpuCompositor(options) {
  validateClosedRecord(options, new Set(["device"]), "GPU compositor options");
  const device = options.device;
  if (
    !device || typeof device.createBuffer !== "function" ||
    typeof device.createTexture !== "function" ||
    typeof device.createCommandEncoder !== "function" ||
    typeof device.pushErrorScope !== "function" ||
    typeof device.popErrorScope !== "function" ||
    typeof device.queue?.submit !== "function"
  ) {
    throw new TypeError("GPU compositor device must be a GPUDevice");
  }

  const library = await createGpuPipelineLibrary(device, "rgba16float");
  const core = compositorCore ??= instantiateRendererCore().exports;
  const gpu = createGpuBinding(core, device, { pipeline: library.pipeline });
  const compositorState = core.gpu_compositor_create(gpu.stream);
  gpu.execute();
  const glyphResourceManager = new GlyphResourceManager();
  const layers = new Set();
  const layerSources = new WeakMap();
  let disposed = false;

  function requireActive() {
    if (disposed) throw new Error("GPU compositor is disposed");
  }

  const decodedFontPromises = new WeakMap();
  async function decodedFont(fontBytes) {
    let promise = decodedFontPromises.get(fontBytes);
    if (!promise) {
      promise = decodeWebFont(fontBytes);
      decodedFontPromises.set(fontBytes, promise);
    }
    return await promise;
  }

  function writeTextureLayer(handle, record) {
    const view = gpu.input(128);
    const rectangle = record.destinationRectangle;
    view.setFloat64(0, rectangle.x, true);
    view.setFloat64(8, rectangle.y, true);
    view.setFloat64(16, rectangle.width, true);
    view.setFloat64(24, rectangle.height, true);
    view.setFloat64(32, record.opacity, true);
    writeTransform(view, 40, record.transform);
    writeClip(view, 88, record.clipRectangle);
    core.gpu_compositor_texture_layer_set(handle, view.byteOffset);
  }

  function createTextureLayer(record) {
    requireActive();
    let current = normalizeTextureRecord(record);
    let layerDisposed = false;
    const handle = core.gpu_compositor_layer_create(compositorState, 0);
    gpu.execute();
    writeTextureLayer(handle, current);

    const layer = Object.freeze({
      kind: "texture",
      update(changes) {
        requireActive();
        if (layerDisposed) throw new Error("texture layer is disposed");
        current = normalizeTextureRecord(changes, current);
        writeTextureLayer(handle, current);
      },
      // The layer contract returns a promise; the release is synchronous.
      dispose() {
        if (!layerDisposed) {
          layerDisposed = true;
          layers.delete(layer);
          core.gpu_compositor_layer_destroy(handle);
          gpu.execute();
          current = null;
        }
        return Promise.resolve();
      },
    });
    layerSources.set(layer, () => {
      if (layerDisposed) throw new Error("texture layer is disposed");
      return [handle, gpu.importResource(current.textureView)];
    });
    layers.add(layer);
    return layer;
  }

  const textLayerStates = new Map();
  let textResourceRevision = 0;
  let preparedTextResourceRevision = -1;
  let sharedTextLease = null;

  let settledShaping = Promise.resolve();

  function shapeTextRecord(record) {
    const operation = settledShaping.then(async () => {
      const decodedFontBytes = await decodedFont(record.fontBytes);
      const shaped = await shapeFontText(
        decodedFontBytes,
        record.text,
        record.fontSize,
        {
          variations: [["wght", record.weight], ["opsz", record.opticalSize]],
        },
      );
      return { decodedFontBytes, shaped };
    });
    settledShaping = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  // Transports the run, its atlas entries, and the layer values.
  function writeTextLayer(state) {
    if (state.atlas === null) {
      core.gpu_compositor_text_layer_clear(state.handle);
      return;
    }
    const record = state.current;
    const glyphs = state.shaped.glyphs;
    const view = gpu.input(168 + glyphs.length * 120);
    view.setFloat64(0, record.fontSize, true);
    view.setFloat64(8, state.shaped.upem, true);
    view.setFloat64(16, record.baselinePosition.x, true);
    view.setFloat64(24, record.baselinePosition.y, true);
    view.setFloat64(32, record.letterSpacing, true);
    for (let channel = 0; channel < 4; channel++) {
      view.setFloat64(40 + channel * 8, record.color[channel], true);
    }
    view.setFloat64(72, record.opacity, true);
    writeTransform(view, 80, record.transform);
    writeClip(view, 128, record.clipRectangle);
    for (let index = 0; index < glyphs.length; index++) {
      const glyph = glyphs[index];
      const offset = 168 + index * 120;
      const information = state.atlas.glyphInfo(
        glyph.g,
        record.weight,
        record.opticalSize,
        record.fontSize,
      );
      const present = Boolean(information && information.w > 0 && information.h > 0);
      view.setFloat64(offset, present ? 1 : 0, true);
      if (present) {
        view.setFloat64(offset + 8, information.w, true);
        view.setFloat64(offset + 16, information.h, true);
        view.setFloat64(offset + 24, information.u, true);
        view.setFloat64(offset + 32, information.v, true);
        view.setFloat64(offset + 40, information.uW, true);
        view.setFloat64(offset + 48, information.vH, true);
        view.setFloat64(offset + 56, information.metrics.bboxXMin, true);
        view.setFloat64(offset + 64, information.metrics.bboxXMax, true);
        view.setFloat64(offset + 72, information.metrics.bboxYMin, true);
        view.setFloat64(offset + 80, information.metrics.bboxYMax, true);
      }
      view.setFloat64(offset + 88, glyph.dx, true);
      view.setFloat64(offset + 96, glyph.dy, true);
      view.setFloat64(offset + 104, glyph.ax, true);
      view.setFloat64(offset + 112, glyph.ay, true);
    }
    core.gpu_compositor_text_layer_set(state.handle, view.byteOffset, glyphs.length);
    gpu.execute();
  }

  function releaseSharedTextResources() {
    for (const state of textLayerStates.values()) {
      state.atlas = null;
      state.atlasTexture = null;
      writeTextLayer(state);
    }
    // Atlas textures are owned by the atlases (WasmAtlas.deviceTexture);
    // releasing the lease is what retires them.
    if (sharedTextLease !== null) {
      const lease = sharedTextLease;
      sharedTextLease = null;
      lease.release();
    }
  }

  async function ensureSharedTextResources() {
    if (preparedTextResourceRevision === textResourceRevision) return;
    if (sharedTextLease !== null) {
      await device.queue.onSubmittedWorkDone();
      releaseSharedTextResources();
    }
    const requestedRevision = textResourceRevision;
    const states = [...textLayerStates.values()].filter((state) =>
      !state.disposed
    );
    if (states.length === 0) {
      preparedTextResourceRevision = textResourceRevision;
      return;
    }
    const lease = await glyphResourceManager.acquire(
      states.map((state) => ({
        fontBytes: state.decodedFontBytes,
        glyphIds: state.shaped.glyphs.map((glyph) => glyph.g),
        weight: state.current.weight,
        opticalSize: state.current.opticalSize,
        devicePixelSize: state.current.fontSize,
      })),
      { generationBackend: { kind: "cpu" } },
    );
    if (textResourceRevision !== requestedRevision) {
      lease.release();
      return await ensureSharedTextResources();
    }
    try {
      for (let index = 0; index < states.length; index++) {
        const state = states[index];
        const atlas = lease.atlases[index];
        state.atlas = atlas;
        state.atlasTexture = atlas.deviceTexture(device);
        writeTextLayer(state);
      }
    } catch (error) {
      lease.release();
      for (const state of states) {
        state.atlas = null;
        state.atlasTexture = null;
        writeTextLayer(state);
      }
      throw error;
    }
    sharedTextLease = lease;
    preparedTextResourceRevision = requestedRevision;
  }

  async function createTextLayer(record) {
    requireActive();
    const current = normalizeTextRecord(record);
    const shapedRecord = await shapeTextRecord(current);
    requireActive();
    const state = {
      current,
      decodedFontBytes: shapedRecord.decodedFontBytes,
      shaped: shapedRecord.shaped,
      atlas: null,
      atlasTexture: null,
      handle: core.gpu_compositor_layer_create(compositorState, 1),
      disposed: false,
      settledUpdate: Promise.resolve(),
    };
    gpu.execute();
    writeTextLayer(state);

    const layer = Object.freeze({
      kind: "text",
      update(changes) {
        requireActive();
        if (state.disposed) {
          return Promise.reject(new Error("text layer is disposed"));
        }
        const operation = state.settledUpdate.then(async () => {
          const next = normalizeTextRecord(changes, state.current);
          const resourceChanged =
            next.fontBytes !== state.current.fontBytes ||
            next.text !== state.current.text ||
            next.fontSize !== state.current.fontSize ||
            next.weight !== state.current.weight ||
            next.opticalSize !== state.current.opticalSize;
          if (resourceChanged) {
            const nextShapedRecord = await shapeTextRecord(next);
            state.current = next;
            state.decodedFontBytes = nextShapedRecord.decodedFontBytes;
            state.shaped = nextShapedRecord.shaped;
            textResourceRevision++;
          } else {
            state.current = next;
            writeTextLayer(state);
          }
        });
        state.settledUpdate = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        layers.delete(layer);
        await state.settledUpdate;
        textLayerStates.delete(layer);
        textResourceRevision++;
        core.gpu_compositor_layer_destroy(state.handle);
        gpu.execute();
        state.atlas = null;
        state.atlasTexture = null;
        state.current = null;
        state.decodedFontBytes = null;
        state.shaped = null;
      },
    });
    textLayerStates.set(layer, state);
    textResourceRevision++;
    layerSources.set(layer, () => {
      if (state.disposed) throw new Error("text layer is disposed");
      return [state.handle, state.atlasTexture === null ? 0 : gpu.importResource(state.atlasTexture)];
    });
    layers.add(layer);
    return layer;
  }

  const compositor = Object.freeze({
    createTextureLayer,
    createTextLayer,
    async compose(record) {
      requireActive();
      validateClosedRecord(
        record,
        new Set(["targetView", "width", "height", "layers", "clearColor"]),
        "GPU composition",
      );
      if (
        record.targetView === null ||
        (typeof record.targetView !== "object" && typeof record.targetView !== "function")
      ) {
        throw new TypeError("GPU composition targetView must be a GPUTextureView");
      }
      if (!Number.isInteger(record.width) || record.width < 1) {
        throw new RangeError("GPU composition width must be a positive integer");
      }
      if (!Number.isInteger(record.height) || record.height < 1) {
        throw new RangeError("GPU composition height must be a positive integer");
      }
      if (!Array.isArray(record.layers)) {
        throw new TypeError("GPU composition layers must be an array");
      }
      for (const layer of record.layers) {
        if (!layers.has(layer)) {
          throw new TypeError("GPU composition layers must belong to this compositor");
        }
      }
      const clearColor = record.clearColor === undefined
        ? DEFAULT_CLEAR_COLOR
        : validateColor(record.clearColor, "GPU composition clearColor", { opaque: true });
      await ensureSharedTextResources();
      device.pushErrorScope("validation");
      let synchronousError = null;
      try {
        gpu.beginFrame();
        const view = gpu.input(56 + record.layers.length * 8);
        view.setUint32(0, gpu.importResource(record.targetView), true);
        view.setUint32(4, record.width, true);
        view.setUint32(8, record.height, true);
        view.setUint32(12, record.layers.length, true);
        view.setUint32(16, gpu.importResource(library.quadBuffer), true);
        for (let channel = 0; channel < 4; channel++) {
          view.setFloat64(24 + channel * 8, clearColor[channel], true);
        }
        for (let index = 0; index < record.layers.length; index++) {
          const [layerHandle, sourceHandle] = layerSources.get(record.layers[index])();
          view.setUint32(56 + index * 8, layerHandle, true);
          view.setUint32(60 + index * 8, sourceHandle, true);
        }
        core.gpu_compositor_compose(compositorState, view.byteOffset);
        gpu.execute();
      } catch (error) {
        synchronousError = error;
      }
      const validationError = await device.popErrorScope();
      if (synchronousError !== null && validationError !== null) {
        throw new AggregateError(
          [synchronousError, validationError],
          "GPU composition failed validation",
        );
      }
      if (synchronousError !== null) throw synchronousError;
      if (validationError !== null) {
        throw new Error(
          `GPU composition failed validation: ${validationError.message}`,
          { cause: validationError },
        );
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const layer of [...layers]) {
        try {
          await layer.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await device.queue.onSubmittedWorkDone();
      } catch (error) {
        errors.push(error);
      }
      try {
        releaseSharedTextResources();
      } catch (error) {
        errors.push(error);
      }
      try {
        await glyphResourceManager.shutdown();
      } catch (error) {
        errors.push(error);
      }
      try {
        core.gpu_compositor_destroy(compositorState);
        gpu.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        library.destroy();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "GPU compositor disposal failed");
      }
    },
  });

  return compositor;
}
