import { mapGpuBufferSync } from './gpu-thread.js';

// The record contract is docs/specifications/gpu-command-stream.md.
// This binding performs native effects; renderer-core writes every record.
export function createGpuBinding(core, device, effects = {}) {
  const stream = core.gpu_stream_create();
  const resources = new Map();
  const owned = new Set();
  const imported = new WeakMap();
  const imports = new Set();
  const pending = new Set();
  const readbacks = new Map();
  const completions = new Map();
  let failure = null;
  let closed = false;
  let recordKind = 0;
  let recordOffset = 0;
  let commandView = null;
  let inputView = null;
  let memoryBytes = null;
  const formats = ['rgba8unorm', 'rgba16float', 'rgba16uint', 'rgba32float',
    'r8unorm', 'r8uint', 'depth24plus-stencil8', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb'];
  const decoder = new TextDecoder();
  function text(pointer, length) {
    requireSpan(pointer, length);
    return decoder.decode(new Uint8Array(core.memory.buffer, pointer, length));
  }
  function enumeration(values, index, name) {
    const value = values[index];
    if (value === undefined) throw new Error(`GPU ${name} enum ${index} is unsupported`);
    return value;
  }
  function requireResource(handle) {
    const resource = resources.get(handle >>> 0);
    if (resource === undefined) throw new Error(`GPU handle ${handle} is absent; import or create it before use`);
    return resource;
  }
  function store(handle, resource, own = false) {
    if (handle === 0 || resources.has(handle)) throw new Error(`GPU handle ${handle} is zero or already bound`);
    resources.set(handle, resource);
    imported.set(resource, handle);
    if (own) owned.add(handle);
    else imports.add(handle);
  }
  function importResource(resource) {
    if (resource === null) return 0;
    let handle = imported.get(resource);
    if (handle === undefined) {
      handle = core.gpu_handle_allocate() >>> 0;
      imported.set(resource, handle);
    }
    if (!resources.has(handle)) {
      store(handle, resource);
    }
    return handle;
  }
  // An imported GPUTextureView stands for its texture's default view.
  function textureView(resource, descriptor) {
    if (typeof resource.createView === 'function') return resource.createView(descriptor);
    if (descriptor !== undefined) throw new Error('GPU texture view import cannot select a mip level; import its texture');
    return resource;
  }
  function requireSpan(pointer, length) {
    if (pointer > core.memory.buffer.byteLength || length > core.memory.buffer.byteLength - pointer) {
      throw new RangeError(`GPU byte span ${pointer}+${length} exceeds memory size ${core.memory.buffer.byteLength}`);
    }
  }
  function notifyReadbacks() {
    for (const [slot, operation] of readbacks) {
      if (failure !== null) {
        readbacks.delete(slot);
        operation.throw(failure);
      } else if (core.gpu_readback_state(slot) === 3) {
        readbacks.delete(slot);
        operation.reply();
      }
    }
    for (const [token, operation] of completions) {
      if (failure !== null) {
        completions.delete(token);
        operation.throw(failure);
      } else if (!core.gpu_operation_pending(stream, token)) {
        completions.delete(token);
        operation.reply();
      }
    }
  }
  function completeReadback(token, status) {
    core.gpu_completion(stream, token, status);
    notifyReadbacks();
  }
  function mapReadback(bufferHandle, pointer, length, token) {
    if (bufferHandle === 0) {
      completeReadback(token, 0);
      return;
    }
    const buffer = requireResource(bufferHandle);
    const mapped = buffer.mapAsync(GPUMapMode.READ);
    const copied = mapped.then(() => {
      try {
        requireSpan(pointer, length);
        new Uint8Array(core.memory.buffer, pointer, length).set(
          new Uint8Array(buffer.getMappedRange(), 0, length),
        );
      } finally {
        buffer.unmap();
      }
    });
    const completion = copied.then(() => {
      pending.delete(completion);
      completeReadback(token, 0);
    }, (error) => {
      pending.delete(completion);
      failure = new Error(`GPU readback ${token} failed`, { cause: error });
      completeReadback(token, 1);
    }).catch((error) => {
      failure = error;
      notifyReadbacks();
    }).finally(() => pending.delete(completion));
    pending.add(completion);
  }
  function execute() {
    if (closed) throw new Error('GPU binding is closed');
    if (failure !== null) throw failure;
    const pointer = core.gpu_stream_pointer(stream) >>> 0;
    const length = core.gpu_stream_length(stream) >>> 0;
    requireSpan(pointer, length);
    if (commandView === null || commandView.buffer !== core.memory.buffer || commandView.byteOffset !== pointer) {
      commandView = new DataView(core.memory.buffer, pointer);
    }
    if (memoryBytes === null || memoryBytes.buffer !== core.memory.buffer) {
      memoryBytes = new Uint8Array(core.memory.buffer);
    }
    const view = commandView;
    try {
      for (let offset = 0; offset < length;) {
        recordOffset = offset;
        recordKind = length - offset >= 4 ? view.getUint32(offset, true) : 0;
        const size = core.gpu_record_size(recordKind);
        if (size === 0 || size > length - offset || view.getUint32(offset + 4, true) !== size) {
          throw new Error(`unknown or truncated GPU record; expected size ${size}, remaining ${length - offset}`);
        }
        const first = view.getUint32(offset + 8, true);
        const second = view.getUint32(offset + 12, true);
        const third = view.getUint32(offset + 16, true);
        const fourth = view.getUint32(offset + 20, true);
        const fifth = view.getUint32(offset + 24, true);
        switch (recordKind) {
          case 1:
            store(first, device.createBuffer({ size: second, usage: third }), true);
            break;
          case 2: {
            const format = formats[fourth];
            if (format === undefined) throw new Error(`GPU texture format ${fourth} is unsupported`);
            store(first, device.createTexture({ size: { width: second, height: third }, format, usage: fifth,
              mipLevelCount: view.getUint32(offset + 28, true) || 1,
              sampleCount: view.getUint32(offset + 32, true) || 1 }), true);
            break;
          }
          case 3:
            if (!owned.has(first)) throw new Error(`GPU handle ${first} is borrowed; its owner must destroy it`);
            requireResource(first).destroy?.();
            resources.delete(first);
            owned.delete(first);
            break;
          case 4:
            requireSpan(third, fourth);
            device.queue.writeBuffer(requireResource(first), second, memoryBytes, third, fourth);
            break;
          case 5:
            if (fourth > 1) throw new Error(`GPU pass load operation ${fourth} is unsupported`);
            store(first, requireResource(second).beginRenderPass({ colorAttachments: [{
              view: textureView(requireResource(third), fifth === 0 ? undefined : { baseMipLevel: fifth - 1, mipLevelCount: 1 }),
              loadOp: fourth === 1 ? 'load' : 'clear', storeOp: 'store',
              clearValue: { r: view.getFloat64(offset + 32, true), g: view.getFloat64(offset + 40, true),
                b: view.getFloat64(offset + 48, true), a: view.getFloat64(offset + 56, true) },
            }] }));
            break;
          case 6:
            requireResource(first).end();
            resources.delete(first);
            imports.delete(first);
            break;
          case 7:
            requireResource(first).setPipeline(requireResource(second));
            break;
          case 8:
            requireResource(first).setBindGroup(second, requireResource(third));
            break;
          case 9:
            requireResource(first).setVertexBuffer(second, requireResource(third), fourth, fifth === 0 ? undefined : fifth);
            break;
          case 10:
            requireResource(first).setScissorRect(second, third, fourth, fifth);
            break;
          case 11:
            requireResource(first).draw(second, third, fourth, fifth);
            break;
          case 12:
            store(second, requireResource(first).finish());
            resources.delete(first);
            owned.delete(first);
            imports.delete(first);
            break;
          case 13: {
            const buffers = [];
            if (first !== 0) buffers.push(requireResource(first));
            if (second !== 0) buffers.push(requireResource(second));
            buffers.push(requireResource(third));
            try { device.queue.submit(buffers); }
            catch (error) { if (fourth !== 0) core.gpu_completion(stream, fourth, 1); throw error; }
            if (fourth === 0) break;
            const completion = device.queue.onSubmittedWorkDone().then(() => {
              completeReadback(fourth, 0);
              pending.delete(completion);
            }, (error) => {
              core.gpu_completion(stream, fourth, 1);
              failure = new Error(`GPU submission ${fourth} failed`, { cause: error });
              pending.delete(completion);
              notifyReadbacks();
            });
            pending.add(completion);
            break;
          }
          case 14:
            store(first, device.createCommandEncoder(), true);
            break;
          case 15: {
            if (third > 10) throw new Error(`GPU bind entry count ${third} exceeds record capacity 10`);
            const entries = [];
            for (let index = 0; index < third; index++) {
              const entryOffset = offset + 24 + index * 16;
              const binding = view.getUint32(entryOffset, true);
              const kind = view.getUint32(entryOffset + 4, true);
              const object = requireResource(view.getUint32(entryOffset + 8, true));
              const mip = view.getInt32(entryOffset + 12, true);
              let resource;
              if (kind === 0) resource = { buffer: object };
              else if (kind === 1) resource = textureView(object, mip === -1 ? undefined : { baseMipLevel: mip, mipLevelCount: 1 });
              else if (kind === 2) resource = object;
              else throw new Error(`GPU bind entry kind ${kind} is unsupported`);
              entries.push({ binding, resource });
            }
            const layout = fourth === 0xffffffff ? requireResource(second) : requireResource(second).getBindGroupLayout(fourth);
            store(first, device.createBindGroup({ layout, entries }), true);
            break;
          }
          case 16:
            store(first, device.createSampler({
              magFilter: second & 1 ? 'nearest' : 'linear',
              minFilter: second & 1 ? 'nearest' : 'linear',
              mipmapFilter: second & 1 || !(second & 4) ? 'nearest' : 'linear',
              lodMinClamp: view.getFloat32(offset + 16, true),
              lodMaxClamp: view.getFloat32(offset + 20, true),
              addressModeU: second & 2 ? 'repeat' : 'clamp-to-edge',
              addressModeV: second & 2 ? 'repeat' : 'clamp-to-edge',
            }), true);
            break;
          case 17:
            store(first, effects.pipeline(second));
            imports.delete(first);
            break;
          case 18: {
            requireSpan(second, third);
            const bytes = memoryBytes.subarray(second, second + third);
            device.queue.writeTexture({ texture: requireResource(first), origin: {
              x: view.getUint32(offset + 32, true), y: view.getUint32(offset + 36, true),
            } }, bytes.buffer.resizable || bytes.buffer.growable ? bytes.slice() : bytes,
              { bytesPerRow: fourth }, { width: fifth, height: view.getUint32(offset + 28, true) });
            break;
          }
          case 19:
            store(first, effects.unpremultiplyTable());
            imports.delete(first);
            break;
          case 20:
            requireResource(first).copyTextureToTexture(
              { texture: requireResource(second), origin: {
                x: view.getUint32(offset + 28, true), y: view.getUint32(offset + 32, true),
              } }, { texture: requireResource(third), origin: {
                x: view.getUint32(offset + 36, true), y: view.getUint32(offset + 40, true),
              } },
              { width: fourth, height: fifth },
            );
            break;
          case 21:
            requireResource(first).copyTextureToBuffer(
              { texture: requireResource(second), origin: {
                x: view.getUint32(offset + 28, true), y: view.getUint32(offset + 32, true),
              } },
              { buffer: requireResource(third), offset: fourth, bytesPerRow: fifth },
              { width: view.getUint32(offset + 36, true), height: view.getUint32(offset + 40, true) },
            );
            break;
          case 22:
            mapReadback(first, second, third, fourth);
            break;
          case 23:
            store(first, requireResource(second).beginComputePass());
            break;
          case 24:
            requireResource(first).dispatchWorkgroups(second, third, fourth);
            break;
          case 25:
            requireResource(first).copyBufferToBuffer(requireResource(second), 0, requireResource(third), 0, fourth);
            break;
          case 26: {
            try { device.queue.submit([requireResource(first)]); }
            catch (error) { completeReadback(fifth, 1); throw error; }
            if (second !== 0) {
              mapReadback(second, third, fourth, fifth);
            } else {
              const completion = device.queue.onSubmittedWorkDone().then(
                () => {
                  pending.delete(completion);
                  completeReadback(fifth, 0);
                },
                (error) => {
                  pending.delete(completion);
                  failure = new Error(`GPU submission ${fifth} failed`, { cause: error });
                  completeReadback(fifth, 1);
                },
              ).finally(() => pending.delete(completion));
              pending.add(completion);
            }
            break;
          }
          case 27:
            store(first, device.createShaderModule({ code: text(second, third) }), true);
            break;
          case 28: {
            requireSpan(second, third * 16);
            const descriptor = new DataView(core.memory.buffer, second, third * 16);
            const entries = [];
            for (let index = 0; index < third; index++) {
              const at = index * 16;
              const entry = { binding: descriptor.getUint32(at, true), visibility: descriptor.getUint32(at + 4, true) };
              const kind = descriptor.getUint32(at + 8, true);
              const flags = descriptor.getUint32(at + 12, true);
              if (kind === 0) entry.buffer = { type: enumeration(['uniform', 'storage', 'read-only-storage'], flags, 'buffer binding') };
              else if (kind === 1) entry.texture = {
                sampleType: enumeration(['float', 'unfilterable-float', 'uint', 'sint', 'depth'], flags & 255, 'texture sample'),
                multisampled: Boolean(flags & 256),
              };
              else if (kind === 2) entry.sampler = { type: enumeration(['filtering', 'non-filtering', 'comparison'], flags, 'sampler binding') };
              else if (kind === 3) entry.storageTexture = {
                format: enumeration(formats, flags & 255, 'storage texture format'),
                access: enumeration(['write-only', 'read-only', 'read-write'], flags >>> 8, 'storage texture access'),
              };
              else throw new Error(`GPU layout entry kind ${kind} is unsupported`);
              entries.push(entry);
            }
            store(first, device.createBindGroupLayout({ entries }), true);
            break;
          }
          case 29: {
            requireSpan(second, third * 4);
            const handles = new Uint32Array(core.memory.buffer, second, third);
            store(first, device.createPipelineLayout({ bindGroupLayouts: Array.from(handles, requireResource) }), true);
            break;
          }
          case 36:
            store(first, device.createComputePipeline({
              layout: second === 0 ? 'auto' : requireResource(second),
              compute: { module: requireResource(third), entryPoint: text(fourth, fifth) },
            }), true);
            break;
          case 30:
          case 35: {
            if (third !== 56) throw new Error(`GPU render-pipeline descriptor has ${third} bytes; expected 56`);
            requireSpan(second, 56);
            const descriptor = new DataView(core.memory.buffer, second, 56);
            const word = (at) => descriptor.getUint32(at, true);
            const module = requireResource(word(4));
            const target = { format: enumeration(formats, word(24), 'texture format'), writeMask: word(36) };
            if (word(40) !== 0) {
              requireSpan(word(40), 24);
              const blend = new Uint32Array(core.memory.buffer, word(40), 6);
              const factors = ['zero', 'one', 'src', 'one-minus-src', 'src-alpha', 'one-minus-src-alpha',
                'dst', 'one-minus-dst', 'dst-alpha', 'one-minus-dst-alpha', 'src-alpha-saturated',
                'constant', 'one-minus-constant', 'src1', 'one-minus-src1', 'src1-alpha', 'one-minus-src1-alpha'];
              const operations = ['add', 'subtract', 'reverse-subtract', 'min', 'max'];
              const component = (at) => ({
                srcFactor: enumeration(factors, blend[at], 'blend factor'),
                dstFactor: enumeration(factors, blend[at + 1], 'blend factor'),
                operation: enumeration(operations, blend[at + 2], 'blend operation'),
              });
              target.blend = { color: component(0), alpha: component(3) };
            }
            const pipeline = {
              // A zero pipeline-layout handle derives the layout from the shader.
              layout: word(0) === 0 ? 'auto' : requireResource(word(0)),
              vertex: { module, entryPoint: text(word(8), word(12)), buffers: [] },
              fragment: { module, entryPoint: text(word(16), word(20)), targets: [target] },
              primitive: { topology: enumeration(['triangle-list', 'triangle-strip', 'point-list', 'line-list', 'line-strip'], word(28), 'topology') },
              multisample: { count: word(32) },
            };
            if (word(44) !== 0) {
              requireSpan(word(44), 48);
              const depth = new Uint32Array(core.memory.buffer, word(44), 12);
              const comparisons = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'];
              const stencilOperations = ['keep', 'zero', 'replace', 'invert', 'increment-clamp', 'decrement-clamp', 'increment-wrap', 'decrement-wrap'];
              const face = (at) => ({
                compare: enumeration(comparisons, depth[at], 'stencil comparison'),
                failOp: enumeration(stencilOperations, depth[at + 1], 'stencil operation'),
                depthFailOp: enumeration(stencilOperations, depth[at + 2], 'stencil operation'),
                passOp: enumeration(stencilOperations, depth[at + 3], 'stencil operation'),
              });
              pipeline.depthStencil = {
                format: 'depth24plus-stencil8', depthWriteEnabled: Boolean(depth[0]),
                depthCompare: enumeration(comparisons, depth[1], 'depth comparison'),
                stencilReadMask: depth[2], stencilWriteMask: depth[3], stencilFront: face(4), stencilBack: face(8),
              };
            }
            requireSpan(word(48), word(52) * 16);
            const buffers = new Uint32Array(core.memory.buffer, word(48), word(52) * 4);
            const attributeFormats = ['float32', 'float32x2', 'float32x3', 'float32x4', 'uint32', 'uint32x2', 'uint32x3', 'uint32x4'];
            for (let index = 0; index < word(52); index++) {
              const at = index * 4;
              requireSpan(buffers[at + 2], buffers[at + 3] * 12);
              const attributes = new Uint32Array(core.memory.buffer, buffers[at + 2], buffers[at + 3] * 3);
              const layout = {
                arrayStride: buffers[at], stepMode: enumeration(['vertex', 'instance'], buffers[at + 1], 'vertex step'), attributes: [],
              };
              for (let attribute = 0; attribute < buffers[at + 3]; attribute++) {
                const field = attribute * 3;
                layout.attributes.push({ shaderLocation: attributes[field], offset: attributes[field + 1],
                  format: enumeration(attributeFormats, attributes[field + 2], 'vertex attribute format') });
              }
              pipeline.vertex.buffers.push(layout);
            }
            if (recordKind === 35) {
              requireSpan(fourth, fifth * 16);
              const constants = new DataView(core.memory.buffer, fourth, fifth * 16);
              pipeline.fragment.constants = {};
              for (let index = 0; index < fifth; index++) {
                pipeline.fragment.constants[text(constants.getUint32(index * 16, true), constants.getUint32(index * 16 + 4, true))] =
                  constants.getFloat64(index * 16 + 8, true);
              }
            }
            store(first, device.createRenderPipeline(pipeline), true);
            break;
          }
          case 31:
            requireResource(first).setViewport(view.getFloat64(offset + 16, true), view.getFloat64(offset + 24, true),
              view.getFloat64(offset + 32, true), view.getFloat64(offset + 40, true),
              view.getFloat64(offset + 48, true), view.getFloat64(offset + 56, true));
            break;
          case 32:
            if (!owned.delete(first)) throw new Error(`GPU handle ${first} is not owned; only an owned resource can be handed to a caller`);
            imports.add(first);
            break;
          case 33: {
            const buffer = requireResource(first);
            try {
              mapGpuBufferSync(buffer, GPUMapMode.READ, 0, third);
              try {
                requireSpan(second, third);
                new Uint8Array(core.memory.buffer, second, third).set(new Uint8Array(buffer.getMappedRange(0, third)));
              } finally {
                buffer.unmap();
              }
            } catch (error) {
              completeReadback(fourth, 1);
              throw error;
            }
            completeReadback(fourth, 0);
            break;
          }
          case 34: {
            if (fourth > 1) throw new Error(`GPU pass load operation ${fourth} is unsupported`);
            const color = { view: textureView(requireResource(third)), loadOp: fourth === 1 ? 'load' : 'clear',
              storeOp: view.getUint32(offset + 32, true) === 1 ? 'discard' : 'store',
              clearValue: { r: view.getFloat64(offset + 40, true), g: view.getFloat64(offset + 48, true),
                b: view.getFloat64(offset + 56, true), a: view.getFloat64(offset + 64, true) } };
            if (fifth !== 0) color.resolveTarget = requireResource(fifth).createView();
            const descriptor = { colorAttachments: [color] };
            const depth = view.getUint32(offset + 28, true);
            if (depth !== 0) {
              descriptor.depthStencilAttachment = { view: requireResource(depth).createView(),
                depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'discard',
                stencilLoadOp: 'clear', stencilClearValue: 0, stencilStoreOp: 'discard' };
            }
            store(first, requireResource(second).beginRenderPass(descriptor));
            break;
          }
          default:
            throw new Error('GPU binding does not implement the record kind');
        }
        offset += size;
      }
      core.gpu_stream_reset(stream);
    } catch (error) {
      failure = new Error(`GPU record kind ${recordKind} at byte offset ${recordOffset}: ${error.message}`, { cause: error });
      throw failure;
    }
  }
  function close() {
    if (closed) return;
    if (pending.size) throw new Error(`GPU binding has ${pending.size} pending completions; await destroy instead`);
    try {
      if (failure !== null) {
        core.gpu_stream_abort(stream);
        throw failure;
      }
      core.gpu_stream_close(stream);
      execute();
    } finally {
      for (const handle of owned) requireResource(handle).destroy?.();
      resources.clear();
      owned.clear();
      imports.clear();
      core.gpu_stream_destroy(stream);
      closed = true;
    }
  }
  return {
    core, stream, importResource, resource: requireResource, execute, close,
    completion(token, operation) {
      if (closed) throw new Error('GPU binding is closed');
      if (completions.has(token)) throw new Error(`GPU operation ${token} already has a completion receiver`);
      completions.set(token, operation);
      notifyReadbacks();
    },
    get closed() { return closed; },
    readback(slot, operation) {
      if (closed) throw new Error('GPU binding is closed');
      if (readbacks.has(slot)) throw new Error(`GPU readback slot ${slot} already has a completion receiver`);
      readbacks.set(slot, operation);
      notifyReadbacks();
    },
    beginFrame() {
      if (failure !== null) throw failure;
      for (const handle of imports) resources.delete(handle);
      imports.clear();
      // Object identities survive frame retirement without retaining the object.
      core.gpu_pass_invalidate(stream);
    },
    input(length) {
      const pointer = core.gpu_stream_input(stream, length) >>> 0;
      if (inputView === null || inputView.buffer !== core.memory.buffer || inputView.byteOffset !== pointer) {
        inputView = new DataView(core.memory.buffer, pointer);
      }
      return inputView;
    },
    async destroy() {
      if (closed) return;
      await Promise.all(pending);
      close();
    },
  };
}
