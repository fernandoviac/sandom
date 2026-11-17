import { instantiateRendererCore } from './wasm/renderer-core-binary.js';
import { decodeGpuValue, encodeGpuValue, GPU_REPLY, gpuWriteBufferArguments } from './gpu-thread-codec.js';
import { createGpuFacade, gpuThreadError, gpuThreadResource } from './dom/webgpu-facade.js';
import { layoutConstant } from './wasm/layout-table.js';

const GPU_QUEUE_STAGE = layoutConstant('GPU_QUEUE_STAGE');
const GPU_QUEUE_SUBMIT = layoutConstant('GPU_QUEUE_SUBMIT');
const GPU_QUEUE_WAIT = layoutConstant('GPU_QUEUE_WAIT');
const GPU_BUFFER_STATES = new Map([
  [layoutConstant('GPU_BUFFER_UNMAPPED'), 'unmapped'],
  [layoutConstant('GPU_BUFFER_PENDING'), 'pending'],
  [layoutConstant('GPU_BUFFER_MAPPED'), 'mapped'],
]);

const HostWorker = globalThis.Worker;
const serverHost = typeof Deno !== 'undefined' || Boolean(globalThis.process?.versions?.node);
const browserMainThread = !serverHost && typeof Window === 'function' && globalThis instanceof Window;
// Capture the navigator without reading its GPU getter during module loading.
// A permissions:none worker can evaluate this module without requesting GPU.
const hostNavigator = globalThis.navigator ?? null;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached').get;
const arrayBufferTransfer = ArrayBuffer.prototype.transfer;
// Calls that need no reply from the GPU thread. WebGPU returns nothing from
// the void members and reports their failures through the device. The other
// members create an object whose description is only its type, handle, and
// label; the script thread allocates the handle, so it can describe the
// object itself. Both kinds queue in call order and leave in one message
// ahead of the next message of any kind.
const QUEUED_CALLS = new Set([
  ...['GPURenderPassEncoder', 'GPURenderBundleEncoder'].flatMap((name) => ['setPipeline', 'setBindGroup',
    'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect',
    'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker'].map((member) => `${name}.${member}`)),
  ...['setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference', 'beginOcclusionQuery',
    'endOcclusionQuery', 'executeBundles', 'end'].map((member) => `GPURenderPassEncoder.${member}`),
  ...['setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'end',
    'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker'].map((member) => `GPUComputePassEncoder.${member}`),
  ...['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer',
    'resolveQuerySet', 'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker', 'beginRenderPass',
    'beginComputePass', 'finish'].map((member) => `GPUCommandEncoder.${member}`),
  'GPUQueue.writeBuffer', 'GPUQueue.writeTexture', 'GPUQueue.submit',
  'GPUTexture.createView', 'GPUDevice.createBindGroup', 'GPUDevice.createCommandEncoder', 'GPUDevice.createSampler',
  'GPURenderPipeline.getBindGroupLayout', 'GPUComputePipeline.getBindGroupLayout',
  // A canvas's current texture is presented at the end of the GPU thread's
  // task that took it, so it travels with the frame's pass and submit.
  'GPUCanvasContext.getCurrentTexture',
]);

// The provider module executes on the GPU thread. It exports
// provideDevice({adapter, descriptor, options}, {reply, throw}); its return is
// ignored. An optional `gpu` export supplies the GPU capability on that thread.
// `gpuModule` is a module URL that the GPU thread imports first; it mounts
// `navigator.gpu` in that realm on a host whose workers lack it (sandom/gpu
// on Node and Bun).
export function createGpuThread({ provider = null, gpuModule = null } = {}, operation) {
  if (!operation || typeof operation.reply !== 'function' || typeof operation.throw !== 'function') {
    throw new TypeError('createGpuThread requires an explicit reply/throw operation');
  }
  if (browserMainThread || typeof SharedArrayBuffer !== 'function') {
    operation.throw(new DOMException('GPU-thread creation requires a worker script realm and cross-origin isolation in browsers', 'NotSupportedError'));
    return;
  }
  if (provider !== null && (typeof provider.module !== 'string' || !provider.module.length)) {
    operation.throw(new TypeError('GPU-thread provider.module must be a worker-reachable module URL'));
    return;
  }
  if (gpuModule !== null && (typeof gpuModule !== 'string' || !gpuModule.length)) {
    operation.throw(new TypeError('GPU-thread gpuModule must be a worker-reachable module URL'));
    return;
  }
  const open = () => {
    const core = instantiateRendererCore().exports;
    const state = core.gpu_thread_create();
    const rootHandle = core.gpu_handle_allocate();
    const Constructor = serverHost ? globalThis.process.getBuiltinModule('node:worker_threads').Worker : HostWorker;
    // The worker reads no environment variable. node:worker_threads copies
    // the whole process environment by default, which needs unrestricted
    // env permission and stops a narrowly permitted host on a prompt.
    const worker = serverHost
      ? new Constructor(serverWorkerAddress(new URL('./gpu-thread-worker.js', import.meta.url)), { type: 'module', env: {} })
      : new Constructor(browserWorkerAddress(new URL('./gpu-thread-worker.js', import.meta.url)), { type: 'module' });
    // A browser worker's GPU thread is a nested worker, which receives a
    // message of this thread only when this thread yields, so a request that
    // this thread then waits on would never arrive. Requests go over a message
    // port, which delivers while this thread waits once the GPU thread holds
    // it; the boot request, which this thread does not wait on, settles that.
    const requestPort = serverHost ? null : attachRequestPort(worker);
    const pending = new Map();
    const objects = new Map();
    const devices = new Map();
    const buffers = new Map();
    const ranges = new Map();
    const mappedBuffers = new Map();
    const replyMemory = new SharedArrayBuffer(4096, { maxByteLength: 0x7fffffff });
    const decoder = new TextDecoder();
    let failure = null;
    let closed = false;
    let closing = false;
    let closeCompletion = null;
    let exitedDuringClose = null;
    let closeReceivers = null;
    let synchronous = false;
    // Queued calls and the byte buffers they transfer, in call order.
    const queued = [];
    const queuedTransfers = [];
    function post(message, transferables = []) {
      if (queued.length) {
        (requestPort ?? worker).postMessage({ kind: 'batch', requests: queued.splice(0) }, queuedTransfers.splice(0));
      }
      (requestPort ?? worker).postMessage(message, transferables);
    }
    const finalization = new FinalizationRegistry((handle) => {
      objects.delete(handle);
      const owner = buffers.get(handle);
      if (owner) {
        core.gpu_buffer_release(state, owner.mapping);
        buffers.delete(handle);
      }
      if (!closed && !closing && failure === null) post({ kind: 'release', target: handle });
    });
    function reference(value) {
      const owner = gpuThreadResource(value);
      if (!owner) return null;
      if (owner.transport !== transport) throw new DOMException('GPU objects belong to another GPU-thread capability', 'NotSupportedError');
      return owner.handle;
    }
    function result(value) {
      if (value === null) return null;
      return Array.isArray(value) ? decodeGpuValue(value) : createGpuFacade(transport, value);
    }
    function checkOpen() {
      if (failure !== null) throw failure;
      if (closed || closing) throw new Error('GPU-thread binding is closed');
    }
    function packet(owner, member, arguments_, resultType, kind, asynchronous) {
      checkOpen();
      let argumentsRecord;
      const transferables = [];
      try {
        const values = owner.name === 'GPUQueue' && member === 'writeBuffer' ? gpuWriteBufferArguments(arguments_) : arguments_;
        argumentsRecord = encodeGpuValue(values, reference, transferables);
      }
      catch (error) {
        if (error.name === 'NotSupportedError') throw new DOMException(`${owner.name}.${member}: ${error.message}`, 'NotSupportedError');
        throw error;
      }
      return { kind, target: owner.handle, interfaceName: owner.name, member, arguments: argumentsRecord, transferables,
        resultType, asynchronous, resultHandle: resultType === 'value' ? 0 : core.gpu_handle_allocate(),
        queueHandle: resultType === 'GPUDevice' ? core.gpu_handle_allocate() : 0 };
    }
    function synchronize(request, begin = null) {
      checkOpen();
      if (synchronous) throw new Error('GPU-thread synchronous transport is already occupied');
      const token = core.gpu_thread_request(state, request.target ?? 0, 0);
      const control = new Int32Array(replyMemory, 0, GPU_REPLY.CONTROL_WORDS);
      Atomics.store(control, GPU_REPLY.READY, 0);
      synchronous = true;
      let retired = false;
      try {
        begin?.(token);
        post({ ...request, token, replyMemory }, request.transferables);
        while (Atomics.load(control, GPU_REPLY.READY) === 0) Atomics.wait(control, GPU_REPLY.READY, 0);
        const reply = JSON.parse(decoder.decode(
          new Uint8Array(replyMemory, GPU_REPLY.TEXT, Atomics.load(control, GPU_REPLY.LENGTH)).slice()));
        core.gpu_thread_reply(state, token);
        retired = true;
        if (!reply.success) throw gpuThreadError(reply.error);
        return result(reply.value);
      } finally {
        if (!retired) core.gpu_thread_reply(state, token);
        synchronous = false;
      }
    }
    function asynchronous(request, receiver, begin = null) {
      checkOpen();
      const token = core.gpu_thread_request(state, request.target ?? 0, 1);
      pending.set(token, receiver);
      worker.ref?.();
      try {
        begin?.(token);
        post({ ...request, token }, request.transferables);
      }
      catch (error) {
        pending.delete(token); core.gpu_thread_reply(state, token);
        if (!core.gpu_thread_has_waiters(state)) worker.unref?.();
        receiver.throw(error);
      }
    }
    function failed(error) {
      if (closed || failure !== null) return;
      failure = error;
      queued.length = 0;
      queuedTransfers.length = 0;
      core.gpu_thread_fail(state);
      for (const [token, receiver] of pending) {
        core.gpu_thread_reply(state, token);
        pending.delete(token);
        receiver.throw(error);
      }
      for (const [handle, receiver] of devices) {
        core.gpu_thread_device_lost(state, handle);
        receiver({ event: 'lost', information: { reason: 'unknown', message: error.message } });
      }
      devices.clear();
      worker.unref?.();
    }
    function bufferOwner(handle) {
      const owner = buffers.get(handle);
      if (!owner) throw new Error(`GPUBuffer handle ${handle} has no host owner`);
      return owner;
    }
    function cancelMapping(owner) {
      const token = core.gpu_buffer_mapping_token(owner.mapping);
      if (!token) return;
      const receiver = pending.get(token);
      if (!receiver) throw new Error(`GPUBuffer mapping token ${token} has no pending operation`);
      receiver.throw(new DOMException('GPUBuffer.mapAsync was aborted by unmap or destruction', 'AbortError'));
    }
    function releaseMapping(owner, destroy) {
      cancelMapping(owner);
      for (let pointer = core.gpu_buffer_range_head(owner.mapping); pointer; pointer = core.gpu_buffer_range_next(pointer)) {
        const range = ranges.get(pointer);
        if (!range) throw new Error(`GPUBuffer mapped range ${pointer} has no host memory`);
        if (!arrayBufferDetached.call(range.buffer)) arrayBufferTransfer.call(range.buffer, 0);
        ranges.delete(pointer);
      }
      core.gpu_buffer_unmap(owner.mapping, destroy ? 1 : 0);
      mappedBuffers.delete(owner.handle);
    }
    function beginMapping(owner, token, arguments_, request) {
      const object = objects.get(owner.handle)?.deref();
      if (!object) throw new Error(`GPUBuffer ${owner.handle} has no live facade`);
      const accepted = Boolean(core.gpu_buffer_mapping_begin(owner.mapping, token, arguments_[0],
        arguments_[1] ?? 0, arguments_[2] ?? 0, arguments_[2] === undefined ? 0 : 1));
      if (accepted) {
        request.flushQueue = core.gpu_thread_buffer_queue_wait(state, owner.mapping);
        mappedBuffers.set(owner.handle, object);
      }
      return accepted;
    }
    function disposeBuffers() {
      let pointer;
      while ((pointer = core.gpu_thread_buffer_first(state, 0))) {
        const handle = core.gpu_buffer_handle(pointer);
        releaseMapping(bufferOwner(handle), true);
        core.gpu_buffer_release(state, pointer);
        buffers.delete(handle);
      }
    }
    function receive(message) {
      if (message.event === 'failure') { failed(gpuThreadError(message.error)); return; }
      if (message.event === 'lost' || message.event === 'uncapturederror') {
        const receiver = devices.get(message.target);
        if (!receiver) { failed(new Error(`GPU device event names absent handle ${message.target}`)); return; }
        receiver(message);
        if (message.event === 'lost') {
          core.gpu_thread_device_lost(state, message.target);
          devices.delete(message.target);
          if (!core.gpu_thread_has_waiters(state)) worker.unref?.();
        }
        return;
      }
      const receiver = pending.get(message.token);
      if (!receiver) { failed(new Error(`GPU-thread completion token ${message.token} is absent or repeated`)); return; }
      pending.delete(message.token);
      core.gpu_thread_reply(state, message.token);
      if (!core.gpu_thread_has_waiters(state)) worker.unref?.();
      if (message.success) {
        try { receiver.reply(result(message.value)); } catch (error) { failed(error); throw error; }
      } else receiver.throw(gpuThreadError(message.error));
    }
    if (serverHost) {
      worker.on('message', receive);
      worker.on('error', (error) => {
        if (closeCompletion !== null) {
          const receiver = closeCompletion; closeCompletion = null; receiver.throw(error);
        } else failed(error);
      });
      // The worker exits right after it acknowledges a close, so its exit
      // can arrive before that acknowledgement: during a close the exit code
      // waits for it (exitedDuringClose) and completes the close then.
      worker.on('exit', (code) => {
        if (closeCompletion !== null) {
          const receiver = closeCompletion; closeCompletion = null;
          if (code === 0) receiver.reply();
          else receiver.throw(new Error(`GPU thread exited with code ${code} during close`));
        } else if (closing && !closed) exitedDuringClose = code;
        else if (!closed) failed(new Error(`GPU thread exited with code ${code}; create a new GPU-thread capability`));
      });
    } else {
      worker.onmessage = ({ data }) => receive(data);
      worker.onerror = (event) => { event.preventDefault(); failed(event.error ?? new Error(event.message)); };
      worker.onmessageerror = () => failed(new Error('GPU-thread response could not be decoded'));
    }
    const transport = {
      retain(object, handle) { objects.set(handle, new WeakRef(object)); finalization.register(object, handle); },
      observeDevice(handle, queue, receiver) { core.gpu_thread_device_register(state, handle, queue); devices.set(handle, receiver); },
      call(owner, member, arguments_, resultType) {
        const request = packet(owner, member, arguments_, resultType, 'call', false);
        if (QUEUED_CALLS.has(`${owner.name}.${member}`)) {
          checkOpen();
          queued.push(request);
          queuedTransfers.push(...request.transferables);
          if (member === 'writeBuffer' || member === 'writeTexture') core.gpu_thread_queue_operation(state, owner.handle, GPU_QUEUE_STAGE);
          else if (member === 'submit') core.gpu_thread_queue_operation(state, owner.handle, GPU_QUEUE_SUBMIT);
          if (resultType === 'value') return undefined;
          const descriptor = arguments_[0];
          const label = descriptor !== null && typeof descriptor === 'object' && descriptor.label !== undefined ? `${descriptor.label}` : '';
          return createGpuFacade(transport, { type: resultType, handle: request.resultHandle, label });
        }
        if (owner.name !== 'GPUDevice' || member !== 'destroy') return synchronize(request);
        if (!core.gpu_thread_device_destroy(state, owner.handle)) return;
        if (core.gpu_thread_has_waiters(state)) worker.ref?.();
        request.releaseBuffers = [];
        for (let pointer = core.gpu_thread_buffer_first(state, owner.handle); pointer; pointer = core.gpu_thread_buffer_next(pointer, owner.handle)) {
          request.releaseBuffers.push(core.gpu_buffer_handle(pointer));
        }
        try { return synchronize(request); }
        finally {
          for (const handle of request.releaseBuffers) releaseMapping(bufferOwner(handle), true);
        }
      },
      callAsync(owner, member, arguments_, resultType, receiver) {
        try {
          const request = packet(owner, member, arguments_, resultType, 'call', true);
          if (owner.name === 'GPUQueue' && member === 'onSubmittedWorkDone') request.flushQueue = core.gpu_thread_queue_operation(state, owner.handle, GPU_QUEUE_WAIT);
          asynchronous(request, receiver);
        }
        catch (error) { receiver.throw(error); }
      },
      callBlockingAsync(owner, member, arguments_, resultType) {
        return synchronize(packet(owner, member, arguments_, resultType, 'call', true));
      },
      get(owner, member) { return synchronize(packet(owner, member, [], 'value', 'get', false)); },
      set(owner, member, value) { return synchronize(packet(owner, member, [value], 'value', 'set', false)); },
      registerBuffer(object, owner) {
        const mapped = owner.description.attributes.mapState === 'mapped';
        owner.mapping = core.gpu_buffer_mapping_create(state, owner.handle, owner.description.deviceHandle, owner.description.attributes.size, mapped);
        buffers.set(owner.handle, owner);
        if (mapped) mappedBuffers.set(owner.handle, object);
      },
      bufferState(owner) { return GPU_BUFFER_STATES.get(core.gpu_buffer_status(owner.mapping)); },
      mapBuffer(owner, arguments_, receiver) {
        let token = 0;
        let accepted = false;
        try {
          const request = packet(owner, 'mapAsync', arguments_, 'value', 'call', true);
          asynchronous(request, {
            reply(value) {
              if (!accepted || core.gpu_buffer_mapping_complete(owner.mapping, token, 1)) receiver.reply(value);
            },
            throw(error) {
              if (!accepted || core.gpu_buffer_mapping_complete(owner.mapping, token, 0)) {
                if (accepted) mappedBuffers.delete(owner.handle);
                receiver.throw(error);
              }
            },
          }, (requestToken) => {
            token = requestToken;
            accepted = beginMapping(owner, token, arguments_, request);
          });
        } catch (error) { receiver.throw(error); }
      },
      mapBufferBlocking(owner, arguments_) {
        const request = packet(owner, 'mapAsync', arguments_, 'value', 'call', true);
        let token = 0;
        let accepted = false;
        try {
          synchronize(request, (requestToken) => {
            token = requestToken;
            accepted = beginMapping(owner, token, arguments_, request);
          });
        } catch (error) {
          if (accepted) {
            core.gpu_buffer_mapping_complete(owner.mapping, token, 0);
            mappedBuffers.delete(owner.handle);
          }
          throw error;
        }
        if (accepted) core.gpu_buffer_mapping_complete(owner.mapping, token, 1);
      },
      mappedRange(owner, offset, size) {
        const pointer = core.gpu_buffer_range(owner.mapping, offset === undefined ? 0 : offset, size === undefined ? 0 : size, size === undefined ? 0 : 1);
        if (pointer < 0) {
          const message = `GPUBuffer.getMappedRange rejected offset ${String(offset)}, size ${String(size)} (mapping rule ${pointer}); use an aligned, nonoverlapping range within the active mapping`;
          if (pointer === -1) throw new TypeError(message);
          throw new DOMException(message, 'OperationError');
        }
        try {
          const start = core.gpu_buffer_range_start(pointer);
          const length = core.gpu_buffer_range_size(pointer);
          const range = synchronize(packet(owner, 'getMappedRange', [start, length], 'mapped-range', 'call', false));
          if (range.byteLength !== length) throw new Error(`GPUBuffer.getMappedRange returned ${range.byteLength} bytes; native ownership requires ${length}`);
          const shared = new SharedArrayBuffer(length);
          synchronize({ kind: 'stage-mapped-range', target: owner.handle, range: range.handle, shared,
            write: Boolean(core.gpu_buffer_mapping_mode(owner.mapping) & 2) });
          const buffer = new ArrayBuffer(length);
          new Uint8Array(buffer).set(new Uint8Array(shared));
          ranges.set(pointer, { shared, buffer });
          return buffer;
        } catch (error) { core.gpu_buffer_range_release(owner.mapping, pointer); throw error; }
      },
      unmapBuffer(owner, destroy) {
        cancelMapping(owner);
        if (!destroy && (core.gpu_buffer_mapping_mode(owner.mapping) & 2)) {
          for (let pointer = core.gpu_buffer_range_head(owner.mapping); pointer; pointer = core.gpu_buffer_range_next(pointer)) {
            const range = ranges.get(pointer);
            if (!range) throw new Error(`GPUBuffer mapped range ${pointer} has no host memory`);
            if (!arrayBufferDetached.call(range.buffer)) new Uint8Array(range.shared).set(new Uint8Array(range.buffer));
          }
        }
        try { return synchronize(packet(owner, destroy ? 'destroy' : 'unmap', [], 'value', 'call', false)); }
        finally { releaseMapping(owner, destroy); }
      },
      adoptCanvas(owner, canvas) {
        return synchronize({ kind: 'adopt-canvas', target: owner.handle, canvas, transferables: [canvas],
          resultType: 'GPUCanvasContext', resultHandle: core.gpu_handle_allocate() });
      },
      sizeCanvas(owner, width, height) {
        synchronize({ kind: 'size-canvas', target: owner.handle, width, height, resultType: 'value' });
      },
      // Sends the queued calls now, such as a presentation's submit, which
      // no later request carries.
      flush() {
        checkOpen();
        if (queued.length) (requestPort ?? worker).postMessage({ kind: 'batch', requests: queued.splice(0) }, queuedTransfers.splice(0));
      },
    };
    const thread = (description) => {
      worker.unref?.();
      const gpu = description === null ? null : createGpuFacade(transport, { type: 'GPU', handle: rootHandle, ...description });
      return {
        gpu,
        close(receiver) {
          if (!receiver || typeof receiver.reply !== 'function' || typeof receiver.throw !== 'function') throw new TypeError('GPU-thread close requires reply/throw');
          if (closeReceivers !== null) { closeReceivers.push(receiver); return; }
          if (closed) { receiver.reply(); return; }
          if (failure !== null) {
            closed = true; worker.terminate(); disposeBuffers(); core.gpu_thread_destroy(state); receiver.throw(failure); return;
          }
          if (pending.size) { receiver.throw(new Error(`GPU-thread close has ${pending.size} pending operations; finish them before closing`)); return; }
          closeReceivers = [receiver];
          const completion = {
            reply() {
              const receivers = closeReceivers; closeReceivers = null;
              for (const receiver of receivers) receiver.reply();
            },
            throw(error) {
              const receivers = closeReceivers; closeReceivers = null;
              for (const receiver of receivers) receiver.throw(error);
            },
          };
          asynchronous({ kind: 'close', resultType: 'value' }, {
            reply() {
              closed = true;
              disposeBuffers(); devices.clear(); objects.clear(); core.gpu_thread_destroy(state);
              requestPort?.close();
              if (serverHost && exitedDuringClose !== null) {
                if (exitedDuringClose === 0) completion.reply();
                else completion.throw(new Error(`GPU thread exited with code ${exitedDuringClose} during close`));
              } else if (serverHost) {
                // The acknowledgement precedes the worker's natural exit.
                // Keep it alive until native teardown has completed.
                closeCompletion = completion;
                worker.ref();
              } else completion.reply();
            },
            throw(error) { closed = true; worker.terminate(); disposeBuffers(); core.gpu_thread_destroy(state); completion.throw(error); },
          });
          closing = true;
        },
      };
    };
    const abandon = () => { closed = true; worker.terminate(); core.gpu_thread_destroy(state); };
    const boot = { kind: 'boot', rootHandle, provider, gpuModule, resultType: 'value' };
    if (requestPort === null) {
      try { return thread(synchronize(boot)); }
      catch (error) { abandon(); throw error; }
    }
    asynchronous(boot, {
      reply(description) { operation.reply(thread(description)); },
      throw(error) { abandon(); operation.throw(error); },
    });
    return null;
  };
  let thread;
  try { thread = open(); }
  catch (error) { operation.throw(error); return; }
  if (thread !== null) operation.reply(thread);
}

// Gives a browser worker's GPU thread the port that carries its requests.
function attachRequestPort(worker) {
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ kind: 'attach', port: port2 }, [port2]);
  return port1;
}

let defaultThread = null;
let defaultFailure = null;
let defaultPreparation = null;
let defaultClosure = null;
// A browser worker's GPU thread boots asynchronously (createGpuThread):
// prepareDefaultGpuThread() boots the default one, and renderComponent()
// awaits it before the component mounts. Elsewhere first use boots the GPU
// worker through the same shared-memory completion path as synchronous calls,
// and importing this module does not yield to worker message delivery before
// its consumer installs an input handler.
const asynchronousBoot = !serverHost && !browserMainThread;

/** Boots this realm's default GPU thread where a browser worker hosts one; a no-op elsewhere. */
export function prepareDefaultGpuThread() {
  if (!asynchronousBoot || !hostNavigator?.gpu || typeof SharedArrayBuffer !== 'function') return Promise.resolve();
  defaultPreparation ??= new Promise((resolve, reject) => {
    createGpuThread({ gpuModule: globalThis[Symbol.for('sandom.gpuModule')] ?? null }, {
      reply(thread) { defaultThread = thread; resolve(); },
      throw(error) { defaultFailure = error; reject(error); },
    });
  });
  return defaultPreparation;
}

function defaultBinding() {
  if (defaultClosure !== null) throw new Error('The default GPU thread is closing');
  if (defaultFailure !== null) throw defaultFailure;
  if (defaultThread !== null) return defaultThread;
  if (asynchronousBoot) {
    throw new Error(
      'The GPU thread of a browser worker boots asynchronously: await prepareDefaultGpuThread() (src/gpu-thread.js) before the first GPU use; renderComponent() does. Its worker is nested and receives no message while this thread waits.',
    );
  }
  // The module that mounted this realm's GPU mounts the GPU thread's.
  createGpuThread({ gpuModule: globalThis[Symbol.for('sandom.gpuModule')] ?? null }, {
    reply(thread) { defaultThread = thread; },
    throw(error) { defaultFailure = error; },
  });
  if (defaultFailure !== null) throw defaultFailure;
  return defaultThread;
}

export function defaultGpuThread(operation) {
  let thread;
  try { thread = defaultBinding(); }
  catch (error) { operation.throw(error); return; }
  operation.reply(thread);
}

// Hosts call this only after shutting down every surface/document and
// releasing their renderer runtimes' shared render contexts.
export function closeDefaultGpuThread() {
  if (defaultClosure !== null) return defaultClosure;
  if (defaultThread === null && defaultPreparation === null) return Promise.resolve();
  defaultClosure = (async () => {
    if (defaultPreparation !== null) await defaultPreparation;
    if (defaultThread === null) return;
    await new Promise((reply, reject) => defaultThread.close({ reply, throw: reject }));
    defaultThread = null;
    defaultPreparation = null;
    defaultFailure = null;
  })().finally(() => { defaultClosure = null; });
  return defaultClosure;
}

// The address a browser starts the GPU-thread worker from. A browser starts
// a worker only from a script of the realm's origin; Sandom loaded from
// another origin, such as by a library URL in a component worker, starts it
// from a same-origin blob: module that imports the worker module. A blob:
// worker takes its creator's service worker and isolation, so the import
// goes where Sandom's own imports go.
function browserWorkerAddress(workerAddress) {
  const origin = globalThis.location?.origin;
  if (origin === undefined || origin === 'null' || workerAddress.origin === origin) return workerAddress;
  const source = `import ${JSON.stringify(workerAddress.href)};\n`;
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

// node:worker_threads starts only file: and data: modules. Sandom loaded from
// a library set over https starts its worker from a data: module that imports
// the worker module; the import resolves through the host's import map.
function serverWorkerAddress(workerAddress) {
  if (workerAddress.protocol === 'file:') return workerAddress;
  const source = `import ${JSON.stringify(workerAddress.href)};\n`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

// A Deno realm without read access to the GPU-thread worker module (such as a
// permissions:none component worker) cannot start that worker.
function workerModuleReadable() {
  if (typeof Deno === 'undefined') return true;
  const workerAddress = new URL('./gpu-thread-worker.js', import.meta.url);
  if (workerAddress.protocol !== 'file:') return true;
  return Deno.permissions.querySync({ name: 'read', path: workerAddress }).state === 'granted';
}

// The GPU-thread facade of this realm's WebGPU, or null on a realm without
// WebGPU or one that cannot host a GPU thread (a browser main thread, a
// page that is not cross-origin isolated, a Deno realm that cannot read the
// worker module). Such a realm renders with its own native WebGPU.
export function getDefaultGpu() {
  if (!hostNavigator?.gpu || browserMainThread || typeof SharedArrayBuffer !== 'function') return null;
  if (!workerModuleReadable()) return null;
  return defaultBinding().gpu;
}

export function createDefaultGpuDeviceSync() {
  const gpu = getDefaultGpu();
  if (gpu === null) throw new DOMException('Canvas 2D requires the host WebGPU capability', 'NotSupportedError');
  const owner = gpuThreadResource(gpu);
  const adapter = owner.transport.callBlockingAsync(owner, 'requestAdapter', [], 'GPUAdapter');
  if (adapter === null) throw new DOMException('Canvas 2D requires an available GPU adapter', 'NotSupportedError');
  const adapterOwner = gpuThreadResource(adapter);
  return adapterOwner.transport.callBlockingAsync(adapterOwner, 'requestDevice', [], 'GPUDevice');
}

export function mapGpuBufferSync(buffer, mode, offset = 0, size = undefined) {
  const owner = gpuThreadResource(buffer);
  if (owner?.name !== 'GPUBuffer') throw new TypeError('Synchronous GPU readback requires a GPU-thread buffer');
  owner.transport.mapBufferBlocking(owner, [mode, offset, size]);
}
