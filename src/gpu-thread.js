import { instantiateRendererCore } from './wasm/renderer-core-binary.js';
import { decodeGpuValue, encodeGpuValue, gpuWriteBufferArguments } from './gpu-thread-codec.js';
import { createGpuFacade, gpuThreadError, gpuThreadResource } from './dom/webgpu-facade.js';

const HostWorker = globalThis.Worker;
const serverHost = typeof Deno !== 'undefined' || Boolean(globalThis.process?.versions?.node);
const browserMainThread = !serverHost && typeof Window === 'function' && globalThis instanceof Window;
// Capture the navigator without reading its GPU getter during module loading.
// A permissions:none worker can evaluate this module without requesting GPU.
const hostNavigator = globalThis.navigator ?? null;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached').get;
const arrayBufferTransfer = ArrayBuffer.prototype.transfer;

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
    const worker = new Constructor(new URL('./gpu-thread-worker.js', import.meta.url), { type: 'module' });
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
    let synchronous = false;
    const finalization = new FinalizationRegistry((handle) => {
      objects.delete(handle);
      const owner = buffers.get(handle);
      if (owner) {
        core.gpu_buffer_release(state, owner.mapping);
        buffers.delete(handle);
      }
      if (!closed && !closing && failure === null) worker.postMessage({ kind: 'release', target: handle });
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
      const control = new Int32Array(replyMemory, 0, 4);
      Atomics.store(control, 0, 0);
      synchronous = true;
      let retired = false;
      try {
        begin?.(token);
        worker.postMessage({ ...request, token, replyMemory }, request.transferables);
        while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);
        const reply = JSON.parse(decoder.decode(new Uint8Array(replyMemory, 16, Atomics.load(control, 1))));
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
        worker.postMessage({ ...request, token }, request.transferables);
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
      worker.on('error', failed);
      worker.on('exit', (code) => { if (!closed) failed(new Error(`GPU thread exited with code ${code}; create a new GPU-thread capability`)); });
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
        if (owner.name === 'GPUQueue') {
          const value = synchronize(request);
          if (member === 'writeBuffer' || member === 'writeTexture') core.gpu_thread_queue_operation(state, owner.handle, 1);
          else if (member === 'submit') core.gpu_thread_queue_operation(state, owner.handle, 2);
          return value;
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
          if (owner.name === 'GPUQueue' && member === 'onSubmittedWorkDone') request.flushQueue = core.gpu_thread_queue_operation(state, owner.handle, 3);
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
        owner.mapping = core.gpu_buffer_mapping_create(state, owner.handle, owner.description.deviceHandle, owner.description.attributes.size, mapped ? 1 : 0);
        buffers.set(owner.handle, owner);
        if (mapped) mappedBuffers.set(owner.handle, object);
      },
      bufferState(owner) { return ['unmapped', 'pending', 'mapped'][core.gpu_buffer_status(owner.mapping)]; },
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
    };
    try {
      const description = synchronize({ kind: 'boot', rootHandle, provider, gpuModule, resultType: 'value' });
      worker.unref?.();
      const gpu = description === null ? null : createGpuFacade(transport, { type: 'GPU', handle: rootHandle, ...description });
      return {
        gpu,
        close(receiver) {
          if (!receiver || typeof receiver.reply !== 'function' || typeof receiver.throw !== 'function') throw new TypeError('GPU-thread close requires reply/throw');
          if (closed) { receiver.reply(); return; }
          if (failure !== null) {
            closed = true; worker.terminate(); disposeBuffers(); core.gpu_thread_destroy(state); receiver.throw(failure); return;
          }
          if (pending.size) { receiver.throw(new Error(`GPU-thread close has ${pending.size} pending operations; finish them before closing`)); return; }
          asynchronous({ kind: 'close', resultType: 'value' }, {
            reply() { closed = true; worker.terminate(); disposeBuffers(); devices.clear(); objects.clear(); core.gpu_thread_destroy(state); receiver.reply(); },
            throw(error) { closed = true; worker.terminate(); disposeBuffers(); core.gpu_thread_destroy(state); receiver.throw(error); },
          });
          closing = true;
        },
      };
    } catch (error) {
      closed = true; worker.terminate(); core.gpu_thread_destroy(state); throw error;
    }
  };
  let thread;
  try { thread = open(); }
  catch (error) { operation.throw(error); return; }
  operation.reply(thread);
}

let defaultThread = null;
let defaultFailure = null;
// Importing this module must not yield to worker message delivery before its
// consumer installs an input handler. First use boots the independent GPU
// worker through the same shared-memory completion path as synchronous calls.
function defaultBinding() {
  if (defaultFailure !== null) throw defaultFailure;
  if (defaultThread === null) {
    // The module that mounted this realm's GPU mounts the GPU thread's.
    createGpuThread({ gpuModule: globalThis[Symbol.for('sandom.gpuModule')] ?? null }, {
      reply(thread) { defaultThread = thread; },
      throw(error) { defaultFailure = error; },
    });
    if (defaultFailure !== null) throw defaultFailure;
  }
  return defaultThread;
}

export function defaultGpuThread(operation) {
  let thread;
  try { thread = defaultBinding(); }
  catch (error) { operation.throw(error); return; }
  operation.reply(thread);
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
