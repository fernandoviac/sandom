// The native GPU host (the sibling library sandom-gpu-host,
// plans/PLAN-native-gpu-host.md there). On Deno, Bun and Node the GPU
// thread forwards the calls of Sandom's WebGPU facade (dom/webgpu-facade.js)
// to the host when the host's platform package is installed beside Sandom
// (`npm install sandom` installs the one of the machine) and the realm may
// load native code. The environment variable SANDOM_NATIVE_GPU_HOST
// overrides that: 0 turns the host off, and 1 requires it, from the
// installed package or else from the host's checkout beside Sandom with its
// library built (docs/operations/development.md). Otherwise the GPU thread
// forwards to the WebGPU of a worker. A GPU thread with a provider module
// keeps the worker, whose WebGPU the provider's device belongs to. Browsers
// always use their own WebGPU.
//
// The host owns one wgpu device. Each GPUDevice of its facade is a logical
// device on it with its own error scopes and loss, so the page's canvases
// and Sandom's frames share resources. Sandom's stream bindings on such a
// device execute their command streams in the host, and a GPU object
// outside a stream is a facade object of the host.

import { createGpuFacade, gpuThreadError, gpuThreadResource } from "./dom/webgpu-facade.js";
import { gpuWriteBufferArguments, encodeGpuValue } from "./gpu-thread-codec.js";
import { layoutConstant } from "./wasm/layout-table.js";
import { instantiateRendererCore } from "./wasm/renderer-core-binary.js";

const BINDINGS = "@sandom/gpu-host/bindings/mod.js";
const GPU_PIPELINE_IDENTITIES = layoutConstant("GPU_PIPELINE_IDENTITIES");
const GPU_BUFFER_STATES = new Map([
  [layoutConstant("GPU_BUFFER_UNMAPPED"), "unmapped"],
  [layoutConstant("GPU_BUFFER_PENDING"), "pending"],
  [layoutConstant("GPU_BUFFER_MAPPED"), "mapped"],
]);
// The completion kinds of the host's page operations (sandom-gpu-host
// src/completions.rs).
const SUBMISSION_FENCE = 2;
const BUFFER_MAP = 4;

const serverRuntime = globalThis.Deno !== undefined || globalThis.Bun !== undefined ||
  globalThis.process?.versions?.node !== undefined;
const OPT_IN = "SANDOM_NATIVE_GPU_HOST";
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached").get;
const arrayBufferTransfer = ArrayBuffer.prototype.transfer;

// What SANDOM_NATIVE_GPU_HOST selects: "required" (1), "off" (0), or
// "installed" (unset or empty), the host of an installed platform package.
// A Deno realm that may not read the variable, such as a component worker,
// selects "off".
function hostSelection() {
  let value;
  if (globalThis.Deno !== undefined) {
    if (Deno.permissions.querySync({ name: "env", variable: OPT_IN }).state !== "granted") return "off";
    value = Deno.env.get(OPT_IN);
  } else {
    value = globalThis.process.env[OPT_IN];
  }
  if (value === undefined || value === "") return "installed";
  if (value === "0") return "off";
  if (value === "1") return "required";
  throw new Error(`${OPT_IN} is ${JSON.stringify(value)}; set it to 1 to require the native GPU host, to 0 to turn it off, or unset it to use the host when its platform package is installed`);
}

// True when the file at `location` (a file URL) exists. False in a Deno
// realm that may not read it.
async function fileExists(location) {
  if (globalThis.Deno !== undefined) {
    if (Deno.permissions.querySync({ name: "read", path: location }).state !== "granted") return false;
    try {
      Deno.statSync(location);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  const { existsSync } = await import("node:fs");
  return existsSync(location);
}

// The binding module of the host that this realm selects, or null; throws
// with what is missing when SANDOM_NATIVE_GPU_HOST=1 requires the host.
// Sandom loaded from a library set on a CDN has no installed package. A
// realm selects an installed package only when it may load native code: a
// Deno realm needs FFI permission for all paths, which the host's
// completion callback needs. Otherwise loading native code waits for the
// first GPU thread, so a program that imports Sandom and renders nothing
// needs no native code permission.
async function selectedBinding() {
  if (!serverRuntime) return null;
  const selection = hostSelection();
  if (selection === "off") return null;
  const location = new URL(import.meta.resolve(BINDINGS));
  if (location.protocol !== "file:") {
    if (selection === "installed") return null;
    throw new Error(`${OPT_IN}=1 requires the native GPU host, and ${BINDINGS} resolves to ${location.href}; install sandom from npm, or map Sandom's library prefix to the checkouts beside Sandom`);
  }
  if (!await fileExists(location)) {
    if (selection === "installed") return null;
    throw new Error(`${OPT_IN}=1 requires the native GPU host, and ${location.href} does not exist; install sandom from npm, or place the sandom-gpu-host checkout beside Sandom`);
  }
  if (selection === "installed" && globalThis.Deno !== undefined &&
    Deno.permissions.querySync({ name: "ffi" }).state !== "granted") return null;
  const binding = await import(location.href);
  if (selection === "installed") return binding.installedNativeGpuHostLibrary() === null ? null : binding;
  if (binding.nativeGpuHostLibrary() === null) {
    throw new Error(`${OPT_IN}=1 requires the native GPU host, and this platform has neither an installed host package nor a library built in ${new URL("../", location).href}; run \`deno task build\` there`);
  }
  return binding;
}

const binding = await selectedBinding();

// True when the GPU thread of this realm forwards to the native GPU host.
export const nativeGpuHostAvailable = binding !== null;
// The runtime whose binding loads the host ("deno", "bun" or "node"), or
// null without the host.
export const nativeGpuHostRuntime = binding?.nativeGpuHostRuntime ?? null;

// The host of each native transport.
const transportHosts = new WeakMap();

// The host's WebCodecs and server canvas (bindings/canvas.js) name the host
// and object of a facade object of a native transport through this.
binding?.addNativeGpuObjectResolver((value) => {
  const owner = gpuThreadResource(value);
  const host = owner === null ? undefined : transportHosts.get(owner.transport);
  return host === undefined ? null : { host, object: owner.handle };
});

// True when `device` is a GPUDevice of a native GPU thread.
export function isNativeGpuDevice(device) {
  const owner = gpuThreadResource(device);
  return owner?.name === "GPUDevice" && transportHosts.has(owner.transport);
}

// The native GPU host of a GPU object of a native GPU thread, such as a
// rendered frame's device: its counts() and whenDrained().
export function nativeGpuHostOf(object) {
  const host = transportHosts.get(gpuThreadResource(object)?.transport);
  if (host === undefined) throw new TypeError(`${object?.constructor?.name ?? object} is no GPU object of a native GPU host`);
  return host;
}

// A GPU thread (src/gpu-thread.js createGpuThread) that forwards to a new
// native GPU host: `{ gpu, close(receiver) }`. Its close destroys its
// devices and closes the host once its last completion has arrived.
export function createNativeGpuThread() {
  if (binding === null) throw new Error("The native GPU host is not installed in this realm");
  // Deno's thread-safe callback, which carries the host's completions,
  // needs FFI permission for all paths.
  if (globalThis.Deno !== undefined && Deno.permissions.querySync({ name: "ffi" }).state !== "granted") {
    throw new Error(`${OPT_IN}=1 selects the native GPU host, and this Deno realm may not load native code; run it with --allow-ffi (for all paths: the host's completion callback needs it)`);
  }
  const host = binding.openNativeGpuHost();
  const core = instantiateRendererCore().exports;
  const state = core.gpu_thread_create();
  const objects = new Map();
  const devices = new Map();
  const buffers = new Map();
  const ranges = new Map();
  // The receivers of the asynchronous calls, by their tokens.
  const pending = new Map();
  let closed = false;
  let closing = null;

  const finalization = new FinalizationRegistry((handle) => {
    objects.delete(handle);
    const owner = buffers.get(handle);
    if (owner) {
      core.gpu_buffer_release(state, owner.mapping);
      buffers.delete(handle);
    }
    if (!closed) host.release(handle);
  });
  function checkOpen() {
    if (closed || closing !== null) throw new Error("GPU-thread binding is closed");
  }
  function reference(value) {
    const owner = gpuThreadResource(value);
    if (!owner) return null;
    if (owner.transport !== transport) throw new DOMException("GPU objects belong to another GPU-thread capability", "NotSupportedError");
    return owner.handle;
  }
  function result(value) {
    if (value === null) return null;
    return Array.isArray(value) ? decodeValue(value) : createGpuFacade(transport, value);
  }
  function decodeValue(record) {
    switch (record[0]) {
      case "undefined": return undefined;
      case "value": return record[1];
      case "array": return record[1].map(decodeValue);
      default: throw new TypeError(`The native GPU host replied with the value record ${record[0]}`);
    }
  }
  // The device events of a reply: an uncaptured error is an event of a
  // later task, as WebGPU dispatches it; a loss settles the device's lost
  // promise.
  function deliver(events) {
    for (const event of events) {
      const receiver = devices.get(event.target);
      if (receiver === undefined) throw new Error(`The native GPU host reported ${event.event} of absent GPUDevice ${event.target}`);
      if (event.event === "lost") {
        core.gpu_thread_device_lost(state, event.target);
        devices.delete(event.target);
        receiver(event);
      } else {
        queueMicrotask(() => receiver(event));
      }
    }
  }
  // Executes one call and returns its reply's value, or throws its error.
  function execute(owner, kind, member, arguments_, token = 0) {
    checkOpen();
    let record;
    try {
      const values = owner.name === "GPUQueue" && member === "writeBuffer" ? gpuWriteBufferArguments(arguments_) : arguments_;
      record = encodeGpuValue(values, reference);
    } catch (error) {
      if (error.name === "NotSupportedError") throw new DOMException(`${owner.name}.${member}: ${error.message}`, "NotSupportedError");
      throw error;
    }
    const reply = host.call({ kind, target: owner.handle, interface: owner.name, member, arguments: record, token });
    deliver(reply.events);
    if (!reply.success) throw gpuThreadError(reply.error);
    return reply;
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
    receiver.throw(new DOMException("GPUBuffer.mapAsync was aborted by unmap or destruction", "AbortError"));
  }
  // Detaches the mapped ranges of `owner` and ends its mapping.
  function releaseMapping(owner, destroy) {
    cancelMapping(owner);
    for (let pointer = core.gpu_buffer_range_head(owner.mapping); pointer; pointer = core.gpu_buffer_range_next(pointer)) {
      const range = ranges.get(pointer);
      if (!range) throw new Error(`GPUBuffer mapped range ${pointer} has no host memory`);
      if (!arrayBufferDetached.call(range.buffer)) arrayBufferTransfer.call(range.buffer, 0);
      ranges.delete(pointer);
    }
    core.gpu_buffer_unmap(owner.mapping, destroy ? 1 : 0);
  }
  // An asynchronous operation of the host completes through the page
  // completions of the host.
  function asynchronous(token, receiver) {
    pending.set(token, receiver);
  }
  host.onPageCompletion((token, status, kind) => {
    const receiver = pending.get(token);
    if (!receiver) throw new Error(`The native GPU host completed absent operation ${token} (kind ${kind})`);
    pending.delete(token);
    core.gpu_thread_reply(state, token);
    if (status === 0) receiver.reply(undefined);
    else if (kind === BUFFER_MAP) receiver.throw(new DOMException("GPUBuffer.mapAsync failed on the device", "OperationError"));
    else receiver.throw(new Error(`The native GPU host's operation ${token} (kind ${kind}) failed on the device`));
  });

  const transport = {
    retain(object, handle) {
      if (handle === 0) return;
      objects.set(handle, new WeakRef(object));
      finalization.register(object, handle);
    },
    observeDevice(handle, queue, receiver) {
      core.gpu_thread_device_register(state, handle, queue);
      devices.set(handle, receiver);
    },
    call(owner, member, arguments_, resultType) {
      if (owner.name !== "GPUDevice" || member !== "destroy") return result(execute(owner, "call", member, arguments_).value);
      checkOpen();
      if (!core.gpu_thread_device_destroy(state, owner.handle)) return undefined;
      const released = [];
      for (let pointer = core.gpu_thread_buffer_first(state, owner.handle); pointer; pointer = core.gpu_thread_buffer_next(pointer, owner.handle)) {
        released.push(core.gpu_buffer_handle(pointer));
      }
      try { return result(execute(owner, "call", member, arguments_).value); }
      finally {
        for (const handle of released) releaseMapping(bufferOwner(handle), true);
      }
    },
    callAsync(owner, member, arguments_, resultType, receiver) {
      try {
        if (owner.name === "GPUQueue" && member === "onSubmittedWorkDone") {
          checkOpen();
          const token = core.gpu_thread_request(state, owner.handle, 1);
          try { execute(owner, "call", member, arguments_, token); }
          catch (error) { core.gpu_thread_reply(state, token); throw error; }
          asynchronous(token, receiver);
          return;
        }
        receiver.reply(result(execute(owner, "call", member, arguments_).value));
      } catch (error) { receiver.throw(error); }
    },
    callBlockingAsync(owner, member, arguments_, resultType) {
      return result(execute(owner, "call", member, arguments_).value);
    },
    get(owner, member) { return result(execute(owner, "get", member, []).value); },
    set(owner, member, value) { return result(execute(owner, "set", member, [value]).value); },
    registerBuffer(object, owner) {
      const mapped = owner.description.attributes.mapState === "mapped";
      owner.mapping = core.gpu_buffer_mapping_create(state, owner.handle, owner.description.deviceHandle, owner.description.attributes.size, mapped);
      buffers.set(owner.handle, owner);
    },
    bufferState(owner) { return GPU_BUFFER_STATES.get(core.gpu_buffer_status(owner.mapping)); },
    mapBuffer(owner, arguments_, receiver) {
      let token = 0;
      let accepted = false;
      try {
        checkOpen();
        token = core.gpu_thread_request(state, owner.handle, 1);
        accepted = Boolean(core.gpu_buffer_mapping_begin(owner.mapping, token, arguments_[0],
          arguments_[1] ?? 0, arguments_[2] ?? 0, arguments_[2] === undefined ? 0 : 1));
        execute(owner, "call", "mapAsync", arguments_, token);
      } catch (error) {
        if (token !== 0) {
          if (accepted) core.gpu_buffer_mapping_complete(owner.mapping, token, 0);
          core.gpu_thread_reply(state, token);
        }
        receiver.throw(error);
        return;
      }
      asynchronous(token, {
        reply(value) {
          if (!accepted || core.gpu_buffer_mapping_complete(owner.mapping, token, 1)) receiver.reply(value);
        },
        throw(error) {
          if (!accepted || core.gpu_buffer_mapping_complete(owner.mapping, token, 0)) receiver.throw(error);
        },
      });
    },
    // A synchronous map (gpu-thread.js mapGpuBufferSync): the host maps
    // the buffer and waits for its work before it replies.
    mapBufferBlocking(owner, arguments_) {
      checkOpen();
      const token = core.gpu_thread_request(state, owner.handle, 0);
      let accepted = false;
      try {
        accepted = Boolean(core.gpu_buffer_mapping_begin(owner.mapping, token, arguments_[0],
          arguments_[1] ?? 0, arguments_[2] ?? 0, arguments_[2] === undefined ? 0 : 1));
        execute(owner, "call", "mapSync", arguments_);
      } catch (error) {
        if (accepted) core.gpu_buffer_mapping_complete(owner.mapping, token, 0);
        throw error;
      } finally {
        core.gpu_thread_reply(state, token);
      }
      if (accepted) core.gpu_buffer_mapping_complete(owner.mapping, token, 1);
    },
    mappedRange(owner, offset, size) {
      const pointer = core.gpu_buffer_range(owner.mapping, offset === undefined ? 0 : offset, size === undefined ? 0 : size, size === undefined ? 0 : 1);
      if (pointer < 0) {
        const message = `GPUBuffer.getMappedRange rejected offset ${String(offset)}, size ${String(size)} (mapping rule ${pointer}); use an aligned, nonoverlapping range within the active mapping`;
        if (pointer === -1) throw new TypeError(message);
        throw new DOMException(message, "OperationError");
      }
      try {
        const start = core.gpu_buffer_range_start(pointer);
        const length = core.gpu_buffer_range_size(pointer);
        const reply = execute(owner, "call", "getMappedRange", [start, length]);
        if (reply.payload.byteLength !== length) {
          throw new Error(`GPUBuffer.getMappedRange returned ${reply.payload.byteLength} bytes; the mapping requires ${length}`);
        }
        const buffer = reply.payload.buffer.byteLength === length ? reply.payload.buffer : reply.payload.slice().buffer;
        ranges.set(pointer, { buffer, start });
        return buffer;
      } catch (error) { core.gpu_buffer_range_release(owner.mapping, pointer); throw error; }
    },
    unmapBuffer(owner, destroy) {
      cancelMapping(owner);
      // A write mapping's ranges carry their bytes back to the buffer.
      const written = [];
      if (!destroy && (core.gpu_buffer_mapping_mode(owner.mapping) & 2)) {
        for (let pointer = core.gpu_buffer_range_head(owner.mapping); pointer; pointer = core.gpu_buffer_range_next(pointer)) {
          const range = ranges.get(pointer);
          if (!range) throw new Error(`GPUBuffer mapped range ${pointer} has no host memory`);
          if (!arrayBufferDetached.call(range.buffer)) written.push([range.start, new Uint8Array(range.buffer)]);
        }
      }
      try { return result(execute(owner, "call", destroy ? "destroy" : "unmap", destroy ? [] : [written]).value); }
      finally { releaseMapping(owner, destroy); }
    },
    adoptCanvas() {
      throw new DOMException("A native GPU host presents to no canvas of the runtime; read its frames, or give the presenter a device of the runtime's WebGPU", "NotSupportedError");
    },
    sizeCanvas() {
      throw new DOMException("A native GPU host presents to no canvas of the runtime", "NotSupportedError");
    },
    // Calls leave at once; nothing waits in a queue.
    flush() { checkOpen(); },
    // The facade description of `object`, an object of the host.
    describe(object) {
      const reply = host.call({ kind: "describe", target: object, interface: "", member: "" });
      if (!reply.success) throw gpuThreadError(reply.error);
      return reply.value;
    },
  };
  transportHosts.set(transport, host);

  const gpu = createGpuFacade(transport, { type: "GPU", handle: 0 });
  return {
    gpu,
    close(receiver) {
      if (!receiver || typeof receiver.reply !== "function" || typeof receiver.throw !== "function") {
        throw new TypeError("GPU-thread close requires reply/throw");
      }
      if (closed) { receiver.reply(); return; }
      if (closing === null) {
        if (pending.size) {
          receiver.throw(new Error(`GPU-thread close has ${pending.size} pending operations; finish them before closing`));
          return;
        }
        // Each live device is destroyed, as a worker's close destroys its
        // devices; then the host delivers its last completions and closes.
        for (const handle of [...devices.keys()]) {
          const device = objects.get(handle)?.deref();
          if (device !== undefined) device.destroy();
          else execute({ handle, name: "GPUDevice" }, "call", "destroy", []);
        }
        for (let pointer; (pointer = core.gpu_thread_buffer_first(state, 0));) {
          const handle = core.gpu_buffer_handle(pointer);
          releaseMapping(bufferOwner(handle), true);
          core.gpu_buffer_release(state, pointer);
          buffers.delete(handle);
        }
        closing = host.close().then(() => {
          closed = true;
          objects.clear();
          core.gpu_thread_destroy(state);
        });
      }
      closing.then(() => receiver.reply(), (error) => receiver.throw(error));
    },
  };
}

// A stream binding of `device`, a GPUDevice of a native GPU thread, with the
// interface and effects of createGpuBinding: the shared pipeline of each
// identity (record 17) and the unpremultiply table (record 19), which the
// host takes before the stream needs them. Its resources outside the stream
// are facade objects of the host.
export function createNativeGpuBinding(core, device, effects = {}) {
  const owner = gpuThreadResource(device);
  const host = transportHosts.get(owner.transport);
  const object = (value, what) => {
    const resource = gpuThreadResource(value);
    if (resource?.transport !== owner.transport) {
      throw new TypeError(`The native GPU binding takes GPU objects of its device's host for ${what}; it received ${value?.constructor?.name ?? value}`);
    }
    return resource.handle;
  };
  const pipelines = [];
  if (effects.pipeline) {
    for (let identity = 0; identity < GPU_PIPELINE_IDENTITIES; identity += 1) {
      pipelines.push([identity, object(effects.pipeline(identity), `shared pipeline ${identity}`)]);
    }
  }
  const native = host.createBinding(core, {
    device: owner.handle,
    pipelines,
    unpremultiplyTable: effects.unpremultiplyTable ? object(effects.unpremultiplyTable(), "the unpremultiply table") : 0,
  });
  // The facade object of each handle that left the stream, while it lives.
  const exported = new Map();
  const unexported = new FinalizationRegistry((handle) => {
    if (exported.get(handle)?.deref() === undefined) exported.delete(handle);
  });
  return {
    core: native.core,
    stream: native.stream,
    execute: native.execute,
    close: native.close,
    completion: native.completion,
    readback: native.readback,
    beginFrame: native.beginFrame,
    input: native.input,
    destroy: native.destroy,
    get closed() { return native.closed; },
    importResource(resource) {
      return resource === null ? 0 : native.importObject(object(resource, "an import"));
    },
    resource(handle) {
      const existing = exported.get(handle)?.deref();
      if (existing !== undefined) return existing;
      const facade = createGpuFacade(owner.transport, owner.transport.describe(native.resourceObject(handle)));
      exported.set(handle, new WeakRef(facade));
      unexported.register(facade, handle);
      return facade;
    },
  };
}
