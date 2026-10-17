import { REFERENCE_WHITE_LUMINANCE } from "../color.js";
import { loadColorKernel } from "../wasm/color-kernel.js";
import { canvasFrameSource } from "./canvas-gpu-binding.js";
import { isGpuThreadDevice } from "./webgpu-facade.js";
import { getDefaultGpu } from "../gpu-thread.js";

// A realm that cannot host a GPU thread (a browser main thread, a page that
// is not cross-origin isolated) renders with its native WebGPU, so its
// canvases take the native device the scene renderer uses.
function isNativeGpuDevice(device) {
  return getDefaultGpu() === null && typeof globalThis.GPUDevice === "function" &&
    device instanceof globalThis.GPUDevice;
}

const {
  convertLinearRgbToXyz,
  convertXyzToLinearRgb,
  decodeSrgbTransfer,
  encodeSrgbTransfer,
} = loadColorKernel();

const MAXIMUM_READBACKS = 4;

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function float16ToNumber(bits) {
  const sign = bits >> 15 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1F;
  const fraction = bits & 0x3FF;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1F) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function colorEncodingFor(colorSpace) {
  return Object.freeze({
    primaries: colorSpace === "display-p3" ? "display-p3" : "srgb",
    transferFunction: "srgb",
    transferFunctionParameters: null,
    whitePoint: "d65",
    referenceWhiteLuminance: REFERENCE_WHITE_LUMINANCE,
    profile: null,
  });
}

function formatProperties(format) {
  if (format === "rgba16float") {
    return Object.freeze({
      bytesPerPixel: 8,
      sampleType: "float16",
      bitsPerSample: 16,
      channelOrder: "rgba",
    });
  }
  if (format === "rgba8unorm" || format === "rgba8unorm-srgb") {
    return Object.freeze({
      bytesPerPixel: 4,
      sampleType: "uint8",
      bitsPerSample: 8,
      channelOrder: "rgba",
    });
  }
  if (format === "bgra8unorm" || format === "bgra8unorm-srgb") {
    return Object.freeze({
      bytesPerPixel: 4,
      sampleType: "uint8",
      bitsPerSample: 8,
      channelOrder: "bgra",
    });
  }
  throw new RangeError(
    `GPUCanvasContext.configure: unsupported format "${format}"`,
  );
}

function configurationToneMapping(configuration) {
  const mode = configuration.toneMapping?.mode ?? "standard";
  if (mode !== "standard" && mode !== "extended") {
    throw new RangeError(
      `GPUCanvasContext.configure: unknown toneMapping.mode "${mode}"`,
    );
  }
  return Object.freeze({ mode });
}

function releaseFrame(frame) {
  frame.leases -= 1;
  if (frame.leases < 0) {
    throw new Error("Canvas frame lease count became negative");
  }
  if (frame.retired && frame.leases === 0) frame.finish();
}

export class SandomGPUCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    const core = canvas._domCore;
    this._resourceHandle = core.resourceRegister(2, `canvas:${canvas._coreHandle}`);
    core.resourceBind(canvas._coreHandle, this._resourceHandle);
    core.resourceUpdate(this._resourceHandle, 0, canvas.width, canvas.height);
    this._configuration = null;
    this._currentFrame = null;
    this._presentedFrame = null;
    this._failure = null;
    this._shutdown = false;
    this._presentationSequence = 0;
    this._readbackSequence = 0;
    this._nextPublishedReadbackSequence = 1;
    this._completedReadbacks = new Map();
    this._publishedDescriptor = null;
    this._readbackSlots = Array.from(
      { length: MAXIMUM_READBACKS },
      () => ({ buffer: null, byteLength: 0, device: null, busy: false, frame: null }),
    );
    this._publishedPresentationSequence = 0;
    this._readbackOperationsByPresentation = new Map();
    this._pendingReadbackFrame = null;
    this._activeReadbacks = new Set();
    this._availableTextures = [];
    this._webglDescriptorCache = new WeakMap();
    this.paintSource = Object.freeze({
      kind: "canvas",
      sourceIdentifier: core.resourceId(this._resourceHandle),
      resourceHandle: this._resourceHandle,
      get width() {
        return core.canvasResourceDimension(canvas._canvasContext._resourceHandle, 0);
      },
      get height() {
        return core.canvasResourceDimension(canvas._canvasContext._resourceHandle, 1);
      },
      get revision() {
        return core.resourceContentGeneration(canvas._canvasContext._resourceHandle);
      },
      get readbackCount() {
        return canvas._canvasContext?._readbackSequence ?? 0;
      },
      get preferredDevice() {
        return canvas._canvasContext?._configuration?.device ?? null;
      },
      captureForRender: (targetDevice) => this._captureForRender(targetDevice),
    });
  }

  configure(candidate) {
    if (this._shutdown) throw new Error("GPUCanvasContext is shut down");
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      throw new TypeError(
        "GPUCanvasContext.configure requires a configuration object",
      );
    }
    const device = candidate.device;
    if (!isGpuThreadDevice(device) && !isNativeGpuDevice(device)) {
      throw new TypeError(
        "GPUCanvasContext.configure: device must be a GPU-thread facade, or the native GPUDevice on a realm without a GPU thread; supply native devices elsewhere through a GPU-thread provider module",
      );
    }
    const format = String(candidate.format ?? "");
    formatProperties(format);
    const colorSpace = candidate.colorSpace ?? "srgb";
    if (colorSpace !== "srgb" && colorSpace !== "display-p3") {
      throw new RangeError(
        `GPUCanvasContext.configure: unknown colorSpace "${colorSpace}"`,
      );
    }
    const alphaMode = candidate.alphaMode ?? "opaque";
    if (alphaMode !== "opaque" && alphaMode !== "premultiplied") {
      throw new RangeError(
        `GPUCanvasContext.configure: unknown alphaMode "${alphaMode}"`,
      );
    }
    const usage = candidate.usage ?? GPUTextureUsage.RENDER_ATTACHMENT;
    if (!Number.isInteger(usage) || usage <= 0) {
      throw new TypeError(
        "GPUCanvasContext.configure: usage must be a positive integer",
      );
    }
    const viewFormats = candidate.viewFormats === undefined
      ? []
      : [...candidate.viewFormats].map(String);
    for (const viewFormat of viewFormats) formatProperties(viewFormat);
    this._retireFrames(false);
    this._publishedDescriptor = null;
    this._publishedPresentationSequence = 0;
    this._updateResource(0, true);
    this._configuration = Object.freeze({
      device,
      format,
      usage,
      viewFormats: Object.freeze(viewFormats),
      colorSpace,
      alphaMode,
      toneMapping: configurationToneMapping(candidate),
    });
    this._failure = null;
    this.canvas.ownerDocument._preferredCanvasDevice ??= device;
    const configuredDevice = device;
    void device.lost.then((information) => {
      if (this._configuration?.device !== configuredDevice) return;
      this._failure = new Error(
        `Canvas WebGPU device was lost: ${
          information?.message ?? "unknown reason"
        }`,
      );
      this._updateResource(2, false, 1);
      this.canvas._notifyCanvasPaint();
    });
    this.canvas._notifyCanvasPaint();
  }

  unconfigure() {
    if (this._shutdown) throw new Error("GPUCanvasContext is shut down");
    this._configuration = null;
    this._failure = null;
    this.resetBitmap(false);
  }

  // WebGPU spec: the configuration the context currently holds, or null
  // before configure()/after unconfigure(). Components confirm the granted
  // surface through this (for example exactas' confirmDisplaySurface);
  // without it a caller must assume an srgb/standard-range surface and
  // desaturate its own wide-gamut output.
  getConfiguration() {
    if (this._shutdown) throw new Error("GPUCanvasContext is shut down");
    const configuration = this._configuration;
    if (configuration === null) return null;
    return {
      device: configuration.device,
      format: configuration.format,
      usage: configuration.usage,
      viewFormats: [...configuration.viewFormats],
      colorSpace: configuration.colorSpace,
      toneMapping: { mode: configuration.toneMapping.mode },
      alphaMode: configuration.alphaMode,
    };
  }

  getCurrentTexture() {
    if (this._shutdown) throw new Error("GPUCanvasContext is shut down");
    if (this._failure) throw this._failure;
    const configuration = this._configuration;
    if (configuration === null) {
      throw new DOMException(
        "GPUCanvasContext is not configured",
        "InvalidStateError",
      );
    }
    if (this.canvas.width === 0 || this.canvas.height === 0) {
      throw new DOMException(
        "GPUCanvasContext cannot create a zero-size current texture",
        "OperationError",
      );
    }
    if (
      this.canvas.width > configuration.device.limits.maxTextureDimension2D ||
      this.canvas.height > configuration.device.limits.maxTextureDimension2D
    ) {
      throw new RangeError(
        `GPUCanvasContext bitmap ${this.canvas.width}x${this.canvas.height} exceeds ` +
          `maxTextureDimension2D ${configuration.device.limits.maxTextureDimension2D}`,
      );
    }
    if (this._currentFrame !== null) return this._currentFrame.texture;
    const recycledTexture = this._availableTextures.pop() ?? null;
    const texture = recycledTexture ??
      configuration.device.createTexture({
        size: { width: this.canvas.width, height: this.canvas.height },
        format: configuration.format,
        usage: configuration.usage | GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        viewFormats: configuration.viewFormats,
        label:
          `Sandom canvas ${this.paintSource.sourceIdentifier} presentation`,
      });
    if (recycledTexture !== null) {
      const encoder = configuration.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.end();
      configuration.device.queue.submit([encoder.finish()]);
    }
    const frame = {
      texture,
      configuration,
      device: configuration.device,
      format: configuration.format,
      colorSpace: configuration.colorSpace,
      alphaMode: configuration.alphaMode,
      toneMapping: configuration.toneMapping,
      width: this.canvas.width,
      height: this.canvas.height,
      leases: 0,
      retired: false,
      recycleOnRetire: false,
      presentationSequence: ++this._presentationSequence,
      finish: null,
    };
    frame.finish = () => this._finishRetiredFrame(frame);
    this._currentFrame = frame;
    this._updateResource(1, true);
    frame.bitmapRevision = this.paintSource.revision;
    this.canvas._notifyCanvasPaint();
    return texture;
  }

  _updateResource(readiness, contentChanged = false, failure = 0) {
    return this.canvas._domCore.resourceUpdate(
      this._resourceHandle, readiness, this.paintSource.width, this.paintSource.height,
      contentChanged, failure,
    );
  }

  // The canvas as a Canvas 2D image source (drawImage(), createPattern(),
  // createImageBitmap()): a copy of the current texture, taken now on its
  // device in the bitmap format (src/dom/canvas-gpu-binding.js), or null when
  // the canvas has no current texture. As in Chrome, the texture that a
  // frame presented is not a source: its canvas reads as transparent.
  _imageSource() {
    if (this._shutdown || this._failure !== null || this._currentFrame === null) return null;
    return canvasFrameSource(this._currentFrame);
  }

  get [Symbol.toStringTag]() {
    return "GPUCanvasContext";
  }

  resetBitmap(sizeChanged = true) {
    this.canvas._domCore.canvasBitmapReset(
      this.canvas._coreHandle, sizeChanged, (request) => this._resetDevice(request),
    );
  }

  attributeChanged(name, namespaceURI, removed, wasPresent) {
    this.canvas._domCore.canvasBitmapAttribute(
      this.canvas._coreHandle, name, namespaceURI !== null, removed, wasPresent,
      (request) => this._resetDevice(request),
    );
  }

  _resetDevice(request) {
    this._retireFrames(false);
    this._publishedDescriptor = null;
    this._publishedPresentationSequence = 0;
    this._failure = null;
    if (request.sizeChanged) this.canvas._notifyCanvasSize();
    else this.canvas._notifyCanvasPaint();
  }

  async shutdown() {
    if (this._shutdown) return;
    this._shutdown = true;
    this._retireFrames(false);
    if (this._pendingReadbackFrame !== null) {
      releaseFrame(this._pendingReadbackFrame);
      this._pendingReadbackFrame = null;
    }
    try {
      const results = await Promise.allSettled([...this._activeReadbacks]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      for (const slot of this._readbackSlots) {
        // A rejected readback does not prove its submitted GPU work completed.
        if (slot.busy) continue;
        slot.buffer?.destroy();
        slot.buffer = null;
        slot.byteLength = 0;
        slot.device = null;
        slot.busy = false;
      }
      this._configuration = null;
      this.canvas._domCore.resourceNodeDetach(this.canvas._coreHandle);
      this.canvas._domCore.resourceRelease(this._resourceHandle);
    }
  }

  _retireFrame(frame, recycle) {
    if (frame === null || frame.retired) return;
    frame.retired = true;
    frame.recycleOnRetire = recycle;
    if (frame.leases === 0) frame.finish();
  }

  _finishRetiredFrame(frame) {
    if (
      frame.recycleOnRetire && !this._shutdown &&
      frame.configuration === this._configuration
    ) {
      this._availableTextures.push(frame.texture);
    } else {
      frame.texture.destroy();
    }
  }

  _retireFrames(recycle) {
    this._retireFrame(this._currentFrame, recycle);
    this._retireFrame(this._presentedFrame, recycle);
    this._currentFrame = null;
    this._presentedFrame = null;
    if (!recycle) {
      for (const texture of this._availableTextures) texture.destroy();
      this._availableTextures.length = 0;
    }
  }

  _latchPresentedFrame() {
    if (this._currentFrame !== null) {
      this._retireFrame(this._presentedFrame, true);
      this._presentedFrame = this._currentFrame;
      this._currentFrame = null;
    }
    return this._presentedFrame;
  }

  _captureForRender(targetDevice) {
    if (this._failure) throw this._failure;
    // A shut-down context paints nothing; retired frames are unreachable.
    const frame = this._shutdown ? null : this._latchPresentedFrame();
    let owner = frame;
    let heldFrame = frame;
    let source = null;
    let readback = null;
    let readiness = frame === null ? "absent" : "ready";
    if (frame !== null) frame.leases += 1;
    try {
      if (frame !== null && frame.device === targetDevice) {
        const properties = formatProperties(frame.format);
        const descriptor = Object.freeze({
          width: frame.width,
          height: frame.height,
          rowStride: frame.width * properties.bytesPerPixel,
          channelLayout: "rgba",
          sampleType: properties.sampleType,
          bitsPerSample: properties.bitsPerSample,
          colorEncoding: colorEncodingFor(frame.colorSpace),
          alphaMode: frame.alphaMode,
          canvasToneMapping: frame.toneMapping.mode,
          metadata: Object.freeze({}),
        });
        source = Object.freeze({
          kind: "gpu-texture",
          width: frame.width,
          height: frame.height,
          device: frame.device,
          texture: frame.texture,
          format: frame.format,
          descriptor,
          toneMapping: frame.toneMapping.mode,
        });
      } else if (frame !== null) {
        // Select the published descriptor before queuing work. Presentation may
        // intentionally lag the current frame; capture must preserve that choice.
        const published = this._publishedDescriptor;
        if (
          published === null ||
          this._publishedPresentationSequence !== frame.presentationSequence
        ) {
          readback = this._readbackOperationsByPresentation.get(
            frame.presentationSequence,
          ) ?? null;
          if (
            readback === null &&
            this._pendingReadbackFrame?.presentationSequence !==
              frame.presentationSequence
          ) {
            // The bounded queue owns a separate lease from the capture.
            frame.leases += 1;
            readback = this._queueReadback(frame);
          }
        }
        if (published !== null) {
          owner = published;
          heldFrame = null;
          releaseFrame(frame);
          // Descriptor records are frozen, but their typed pixel storage is not.
          // Keep lineage on the selected owner while resolving this byte snapshot.
          source = Object.freeze({
            ...published,
            pixels: published.pixels.slice(),
          });
        } else if (readback === null) {
          // Coalescing does not promise bytes for this frame. Do not turn its
          // mutable pending queue entry into a new per-capture readback queue.
          readiness = "pending";
        }
      }
      const forTarget = (descriptor) =>
        targetDevice === null && descriptor !== null
          ? this._descriptorForWebgl(descriptor)
          : descriptor;
      let released = false;
      let resolution;
      return Object.freeze({
        readiness,
        owner,
        width: owner?.width ?? this.paintSource.width,
        height: owner?.height ?? this.paintSource.height,
        bitmapRevision: owner?.bitmapRevision ?? this.paintSource.revision,
        device: owner?.device ?? null,
        resolve() {
          if (released) throw new Error("Canvas capture is released");
          resolution ??= Promise.resolve(source ?? readback).then(forTarget);
          return resolution;
        },
        release() {
          if (released) return;
          released = true;
          if (heldFrame !== null) releaseFrame(heldFrame);
        },
      });
    } catch (error) {
      try {
        if (heldFrame !== null) releaseFrame(heldFrame);
      } catch {
        // Rollback must preserve the original acquisition failure.
      }
      throw error;
    }
  }

  _descriptorForWebgl(descriptor) {
    const cached = this._webglDescriptorCache.get(descriptor);
    if (cached) return cached;
    const output = new Uint8Array(descriptor.width * descriptor.height * 4);
    const source = descriptor.pixels;
    const sourceSample = (index) =>
      descriptor.sampleType === "float16"
        ? float16ToNumber(source[index])
        : source[index] / 255;
    for (
      let pixelIndex = 0;
      pixelIndex < descriptor.width * descriptor.height;
      pixelIndex++
    ) {
      const sourceOffset = pixelIndex * 4;
      const alpha = descriptor.alphaMode === "opaque"
        ? 1
        : sourceSample(sourceOffset + 3);
      const encoded = [
        sourceSample(sourceOffset),
        sourceSample(sourceOffset + 1),
        sourceSample(sourceOffset + 2),
      ];
      if (descriptor.alphaMode === "premultiplied" && alpha > 0) {
        encoded[0] /= alpha;
        encoded[1] /= alpha;
        encoded[2] /= alpha;
      }
      const linear = encoded.map(decodeSrgbTransfer);
      const xyz = convertLinearRgbToXyz(
        descriptor.colorEncoding.primaries,
        linear,
      );
      const srgb = convertXyzToLinearRgb("srgb", xyz);
      const outputOffset = pixelIndex * 4;
      for (let channel = 0; channel < 3; channel++) {
        output[outputOffset + channel] = Math.round(
          Math.min(1, Math.max(0, encodeSrgbTransfer(srgb[channel]))) * 255,
        );
      }
      output[outputOffset + 3] = Math.round(
        Math.min(1, Math.max(0, alpha)) * 255,
      );
    }
    const flattened = Object.freeze({
      width: descriptor.width,
      height: descriptor.height,
      rowStride: descriptor.width * 4,
      pixels: output,
      channelLayout: "rgba",
      sampleType: "uint8",
      bitsPerSample: 8,
      colorEncoding: colorEncodingFor("srgb"),
      alphaMode: "straight",
      metadata: Object.freeze({}),
    });
    this._webglDescriptorCache.set(descriptor, flattened);
    return flattened;
  }

  _queueReadback(frame) {
    const availableSlot = this._readbackSlots.find((slot) => !slot.busy);
    if (availableSlot === undefined) {
      const previous = this._pendingReadbackFrame;
      this._pendingReadbackFrame = frame;
      if (previous !== null) releaseFrame(previous);
      return null;
    }
    availableSlot.busy = true;
    availableSlot.frame = frame;
    const readbackSequence = ++this._readbackSequence;
    let submitted = false;
    let completed = false;
    const operation = (async () => {
      try {
        const properties = formatProperties(frame.format);
        const bytesPerRow = align(frame.width * properties.bytesPerPixel, 256);
        const byteLength = bytesPerRow * frame.height;
        if (
          availableSlot.buffer === null || availableSlot.byteLength < byteLength ||
          availableSlot.device !== frame.device
        ) {
          availableSlot.buffer?.destroy();
          availableSlot.buffer = frame.device.createBuffer({
            size: byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: `Sandom canvas ${this.paintSource.sourceIdentifier} readback`,
          });
          availableSlot.byteLength = byteLength;
          availableSlot.device = frame.device;
        }
        const encoder = frame.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: frame.texture },
          { buffer: availableSlot.buffer, bytesPerRow },
          { width: frame.width, height: frame.height },
        );
        const commandBuffer = encoder.finish();
        submitted = true;
        frame.device.queue.submit([commandBuffer]);
        await availableSlot.buffer.mapAsync(GPUMapMode.READ);
        completed = true;
        const mapped = new Uint8Array(availableSlot.buffer.getMappedRange());
        const tightBytes = new Uint8Array(
          frame.width * frame.height * properties.bytesPerPixel,
        );
        const tightRowBytes = frame.width * properties.bytesPerPixel;
        for (let row = 0; row < frame.height; row++) {
          tightBytes.set(
            mapped.subarray(
              row * bytesPerRow,
              row * bytesPerRow + tightRowBytes,
            ),
            row * tightRowBytes,
          );
        }
        availableSlot.buffer.unmap();
        if (properties.channelOrder === "bgra") {
          for (let offset = 0; offset < tightBytes.length; offset += 4) {
            const blue = tightBytes[offset];
            tightBytes[offset] = tightBytes[offset + 2];
            tightBytes[offset + 2] = blue;
          }
        }
        const pixels = properties.sampleType === "float16"
          ? new Uint16Array(tightBytes.buffer)
          : tightBytes;
        const descriptor = Object.freeze({
          width: frame.width,
          height: frame.height,
          rowStride: tightRowBytes,
          pixels,
          channelLayout: "rgba",
          sampleType: properties.sampleType,
          bitsPerSample: properties.bitsPerSample,
          colorEncoding: colorEncodingFor(frame.colorSpace),
          alphaMode: frame.alphaMode,
          canvasToneMapping: frame.toneMapping.mode,
          bitmapRevision: frame.bitmapRevision,
          presentationSequence: frame.presentationSequence,
          metadata: Object.freeze({}),
        });
        const currentBitmap = !this._shutdown &&
          frame.bitmapRevision === this.paintSource.revision;
        this._completedReadbacks.set(
          readbackSequence,
          currentBitmap ? descriptor : null,
        );
        while (
          this._completedReadbacks.has(this._nextPublishedReadbackSequence)
        ) {
          const completedDescriptor = this._completedReadbacks.get(
            this._nextPublishedReadbackSequence,
          );
          if (completedDescriptor !== null) {
            this._publishedDescriptor = completedDescriptor;
            this._publishedPresentationSequence =
              completedDescriptor.presentationSequence;
          }
          this._completedReadbacks.delete(this._nextPublishedReadbackSequence);
          this._nextPublishedReadbackSequence += 1;
        }
        if (currentBitmap) this.canvas._notifyCanvasPaint();
        return descriptor;
      } catch (error) {
        this._failure = error;
        if (completed) {
          try {
            availableSlot.buffer.unmap();
          } catch {
            // Cleanup must preserve the operation's original failure.
          }
        }
        try {
          if (!this._shutdown) this._updateResource(2, false, 1);
          this.canvas._notifyCanvasPaint();
        } catch {
          // Reporting must not replace the readback's original failure.
        }
        throw error;
      } finally {
        if (!submitted || completed) {
          availableSlot.busy = false;
          availableSlot.frame = null;
          releaseFrame(frame);
          if (this._pendingReadbackFrame !== null) {
            const pending = this._pendingReadbackFrame;
            this._pendingReadbackFrame = null;
            this._queueReadback(pending);
          }
        }
      }
    })();
    this._activeReadbacks.add(operation);
    this._readbackOperationsByPresentation.set(
      frame.presentationSequence,
      operation,
    );
    void operation.then(
      () => {
        this._activeReadbacks.delete(operation);
        this._readbackOperationsByPresentation.delete(
          frame.presentationSequence,
        );
      },
      () => {
        this._activeReadbacks.delete(operation);
        this._readbackOperationsByPresentation.delete(
          frame.presentationSequence,
        );
      },
    );
    return operation;
  }
}
export function canvasBitmapWidth(element) {
  return element._domCore.canvasBitmapDimension(element._coreHandle, 0);
}

export function canvasBitmapHeight(element) {
  return element._domCore.canvasBitmapDimension(element._coreHandle, 1);
}
