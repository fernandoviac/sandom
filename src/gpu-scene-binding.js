const formats = ['rgba8unorm', 'rgba16float', 'rgba16uint', 'rgba32float'];
const emptyBytes = new Uint8Array(0);
const emptyConversion = new Float32Array(20);

// Transport only: the draw sequence, group steps, pool selection, cache
// comparison, shaders, samplers, image conversion passes, mip levels and
// draw records belong to renderer-core (src/wasm/gpu-frame.watpart).
export function createGpuSceneResources(gpu, width, height, colorFormat) {
  const { core, stream } = gpu;
  core.gpu_scene_create(stream, width, height, formats.indexOf(colorFormat));
  const identities = new WeakMap();
  function identity(object) {
    let handle = identities.get(object);
    if (handle === undefined) {
      handle = core.gpu_handle_allocate();
      identities.set(object, handle);
    }
    return handle;
  }
  function transport(prefix, arrays) {
    const spans = arrays.map(array => ({
      buffer: array.buffer, offset: array.byteOffset, length: array.byteLength,
      native: array.buffer === core.memory.buffer,
    }));
    const length = spans.reduce((sum, span) => sum + span.length, prefix);
    const view = gpu.input(length);
    const bytes = new Uint8Array(core.memory.buffer, view.byteOffset, length);
    bytes.fill(0, 0, prefix);
    let offset = prefix;
    const pointers = [];
    for (const span of spans) {
      pointers.push(view.byteOffset + offset);
      bytes.set(new Uint8Array(span.native ? core.memory.buffer : span.buffer, span.offset, span.length), offset);
      offset += span.length;
    }
    return { view, pointers };
  }
  function writeUniform(buffer, data) {
    const length = data.byteLength;
    const { view } = transport(0, [data]);
    core.gpu_scene_uniform_write(stream, gpu.importResource(buffer), view.byteOffset, length);
    gpu.execute();
  }
  function uniform(size) {
    const handle = core.gpu_scene_uniform(stream, size);
    gpu.execute();
    return gpu.resource(handle);
  }
  function texture(descriptor) {
    const format = formats.indexOf(descriptor.format);
    if (format < 0) throw new Error(`GPU scene texture format ${descriptor.format} is unsupported`);
    const handle = core.gpu_scene_texture(stream, descriptor.size.width, descriptor.size.height,
      format, descriptor.usage, descriptor.mipLevelCount ?? 1);
    gpu.execute();
    return gpu.resource(handle);
  }
  // The plan in renderer-core memory; a plan of another memory is copied.
  function planPointer(reader) {
    const source = reader.bytes;
    if (source.buffer === core.memory.buffer) return source.byteOffset;
    const plan = core.gpu_groups_plan_input(stream, source.byteLength);
    new Uint8Array(core.memory.buffer, plan, source.byteLength).set(reader.bytes);
    return plan;
  }
  // Writes the image record of one image entry (gpu-frame.watpart).
  function imageRecord(image, imageIndex, resources) {
    if (resources.unavailableImages.has(imageIndex)) {
      const view = gpu.input(40);
      new Uint8Array(core.memory.buffer, view.byteOffset, 40).fill(0);
      view.setUint32(0, 512, true);
      return view.byteOffset;
    }
    if (image === undefined) {
      const view = gpu.input(40);
      new Uint8Array(core.memory.buffer, view.byteOffset, 40).fill(0);
      view.setUint32(0, 256, true);
      return view.byteOffset;
    }
    const conversion = image.kind === 'gpu-texture'
      ? { uniformData: resources.imageConversionUniformFor(image.descriptor), upload: null }
      : image.kind === 'color-glyph-cache-page'
      ? { uniformData: emptyConversion, upload: null }
      : resources.imageConversionFor(image);
    const upload = conversion.upload;
    const { view, pointers } = transport(40, [conversion.uniformData, upload?.data ?? emptyBytes]);
    view.setUint32(0, (image.kind === 'gpu-texture' ? 1 : 0) |
      (image.kind === 'color-glyph-cache-page' ? 2 : 0) |
      (image.contentsOpaque === true ? 4 : 0) |
      (resources.images?.get(imageIndex) === image ? 8 : 0), true);
    view.setUint32(4, image.width, true);
    view.setUint32(8, image.height, true);
    view.setUint32(12, upload ? formats.indexOf(upload.format) : 1, true);
    view.setUint32(16, image.texture ? gpu.importResource(image.texture) : 0, true);
    view.setUint32(20, identity(image), true);
    view.setUint32(24, pointers[1], true);
    view.setUint32(28, upload?.data.byteLength ?? 0, true);
    view.setUint32(32, upload?.bytesPerRow ?? 0, true);
    view.setUint32(36, pointers[0], true);
    return view.byteOffset;
  }
  return {
    begin() { core.gpu_scene_begin(stream); },
    end(submitted) { core.gpu_scene_end(stream, submitted ? 1 : 0); gpu.execute(); },
    resourceEncoder() { return core.gpu_scene_resource_encoder(stream); },
    detachedEncoder() { return core.gpu_groups_detached_encoder(stream); },
    planPointer,
    // Forms the draw sequence and uploads its instances. Returns the entry
    // count and whether a clip of the frame carries an SVG path mask.
    sequence(plan, textThickening) {
      const count = core.gpu_frame_sequence(stream, plan, textThickening.lightInk, textThickening.darkInk);
      if (count < 0) {
        throw new RangeError(`raster plan payload of record ${core.gpu_frame_failure_record(stream)} ends at ` +
          `${core.gpu_frame_failure_value(stream)}, outside its region or word alignment`);
      }
      gpu.execute();
      return { count, pathMaskInUse: core.gpu_frame_path_mask(stream) !== 0 };
    },
    beginGroups(plan, encoder, target, pass, quad, atlas, maxExtent, damagePointer, damageCount) {
      core.gpu_groups_begin(stream, plan, encoder, gpu.importResource(target), pass,
        gpu.importResource(quad), gpu.importResource(atlas), maxExtent, damagePointer, damageCount);
    },
    // Supplies each entry's atlas texture or image record, then records
    // its group step and draw.
    drawEntries(count, resources) {
      for (let entry = 0; entry < count; entry++) {
        const at = core.gpu_frame_entries(stream) + entry * 48;
        const fields = new DataView(core.memory.buffer, at, 48);
        const request = fields.getUint32(40, true);
        const resource = fields.getUint32(44, true);
        let handle = 0;
        if (request === 1) {
          if (!resources.atlasForIdentity) {
            throw new Error(`Native atlas ${resource} requires the raster plan's graphics resource reader`);
          }
          handle = gpu.importResource(resources.atlasTexture(resources.atlasForIdentity(resource)));
        } else if (request === 2) {
          handle = imageRecord(resources.resolvedImages?.get(resource), resource, resources);
        }
        new DataView(core.memory.buffer, at, 48).setUint32(36, handle, true);
        const status = core.gpu_frame_draw_entry(stream, entry);
        gpu.execute();
        if (status === 0) continue;
        const record = core.gpu_frame_failure_record(stream);
        const value = core.gpu_frame_failure_value(stream);
        if (status === 1) {
          throw new Error(`render: unknown raster-plan record kind 0x${(value & 65535).toString(16)} at index ${record}`);
        }
        if (status === 2) {
          throw new Error(`native CMD_IMAGE resource ${value} is absent from the host image map`);
        }
        throw new RangeError(`instance buffer overflow at record ${record}: the batch exceeds limit ${value}; split the batch`);
      }
    },
    finishGroups() { core.gpu_groups_finish(stream); gpu.execute(); },
    takeFrameUniformBuffer: uniform,
    writeUniform,
    takeScratchTexture(usage, textureWidth = width, textureHeight = height) {
      return texture({ size: { width: textureWidth, height: textureHeight }, format: colorFormat, usage });
    },
  };
}
