// This realm owns native WebGPU objects. It performs requested host effects;
// command selection, resource identities and operation ownership stay in WAT.
import { decodeGpuValue, encodeGpuValue, gpuErrorRecord, writeGpuReply } from './gpu-thread-codec.js';

const serverHost = typeof Deno !== 'undefined' || Boolean(globalThis.process?.versions?.node);
const parentPort = serverHost ? globalThis.process.getBuiltinModule('node:worker_threads').parentPort : null;
const send = parentPort ? (value) => parentPort.postMessage(value) : (value) => globalThis.postMessage(value);
const objects = new Map();
const devices = new Set();
const mappedRanges = new Map();
const synchronousReplies = new Set();
let provider = null;
let providerOptions = null;
let rootHandle = 0;
let closed = false;

function resource(handle) {
  if (!objects.has(handle)) throw new Error(`GPU-thread handle ${handle} is absent`);
  return objects.get(handle);
}
function unsupported(interfaceName, member) {
  return new DOMException(`${interfaceName}.${member} is not supported by the GPU-thread host`, 'NotSupportedError');
}
function attributes(object, names) {
  const result = {};
  for (const name of names) if (name in object) result[name] = object[name];
  return result;
}
function limits(object) {
  return attributes(object, [
    'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers',
    'maxBindGroups', 'maxBindGroupsPlusVertexBuffers', 'maxImmediateSize', 'maxBindingsPerBindGroup',
    'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
    'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
    'maxStorageBuffersInVertexStage', 'maxStorageBuffersInFragmentStage', 'maxStorageTexturesPerShaderStage',
    'maxStorageTexturesInVertexStage', 'maxStorageTexturesInFragmentStage', 'maxUniformBuffersPerShaderStage',
    'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize', 'minUniformBufferOffsetAlignment',
    'minStorageBufferOffsetAlignment', 'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes',
    'maxVertexBufferArrayStride', 'maxInterStageShaderVariables', 'maxColorAttachments',
    'maxColorAttachmentBytesPerSample', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension',
  ]);
}
function adapterInfo(object) {
  return object ? attributes(object, ['vendor', 'architecture', 'device', 'description',
    'subgroupMinSize', 'subgroupMaxSize', 'isFallbackAdapter']) : null;
}
function describe(value, request) {
  if (value === null) return null;
  const type = request.resultType;
  if (type === 'value' || type === undefined) return encodeGpuValue(value);
  if (type === 'GPUCompilationInfo') return { type, messages: value.messages.map((message) =>
    attributes(message, ['message', 'type', 'lineNum', 'linePos', 'offset', 'length'])) };
  if (type === 'GPUError') return { type: value.constructor.name, message: value.message };
  const handle = request.resultHandle;
  if (objects.has(handle)) throw new Error(`GPU-thread result handle ${handle} is already bound`);
  objects.set(handle, value);
  const result = { type, handle };
  if ('label' in value) result.label = value.label;
  if (type === 'GPUAdapter' || type === 'GPUDevice') {
    result.features = [...value.features];
    result.limits = limits(value.limits);
    result.info = adapterInfo(type === 'GPUAdapter' ? value.info : value.adapterInfo);
  }
  if (type === 'GPUDevice') {
    devices.add(value);
    objects.set(request.queueHandle, value.queue);
    result.queue = { type: 'GPUQueue', handle: request.queueHandle, label: request.queueLabel };
    value.addEventListener('uncapturederror', (event) => {
      event.preventDefault();
      send({ event: 'uncapturederror', target: handle, error: { type: event.error.constructor.name, message: event.error.message } });
    });
    value.lost.then((information) => {
      devices.delete(value);
      send({ event: 'lost', target: handle, information: { reason: information.reason, message: information.message } });
    });
  }
  if (type === 'GPUBuffer') {
    result.attributes = attributes(value, ['size', 'usage', 'mapState']);
    result.deviceHandle = request.target;
  }
  if (type === 'GPUTexture') result.attributes = attributes(value, ['width', 'height', 'depthOrArrayLayers',
    'mipLevelCount', 'sampleCount', 'dimension', 'format', 'usage', 'textureBindingViewDimension']);
  if (type === 'GPUQuerySet') result.attributes = attributes(value, ['type', 'count']);
  if (type === 'mapped-range') result.byteLength = value.byteLength;
  return result;
}
function reply(request, result) {
  if (request.replyMemory) {
    writeGpuReply(request.replyMemory, result);
    synchronousReplies.delete(request.replyMemory);
  } else send({ token: request.token, ...result });
}
function success(request, value) {
  let description;
  try { description = describe(value, request); }
  catch (error) { failure(request, error); return; }
  reply(request, { success: true, value: description });
}
function failure(request, error) { reply(request, { success: false, error: gpuErrorRecord(error) }); }
function flushMappedRanges(handle, discard) {
  const ranges = mappedRanges.get(handle);
  if (!ranges) return;
  for (const range of ranges) {
    if (!discard && range.write) new Uint8Array(resource(range.handle)).set(new Uint8Array(range.shared));
    objects.delete(range.handle);
  }
  mappedRanges.delete(handle);
}
function dispatch(request) {
  if (request.replyMemory) synchronousReplies.add(request.replyMemory);
  try {
    if (closed) throw new Error('GPU-thread binding is closed');
    if (request.kind === 'boot') {
      const initialize = async () => {
        if (request.gpuModule !== null) await import(request.gpuModule);
        if (request.provider !== null) {
          provider = await import(request.provider.module);
          providerOptions = request.provider.options;
          if (typeof provider.provideDevice !== 'function') throw new TypeError('GPU-thread provider must export provideDevice(request, operation)');
        }
        rootHandle = request.rootHandle;
        return {};
      };
      initialize().then((value) => success(request, value), (error) => failure(request, error));
      return;
    }
    if (request.kind === 'release') {
      if (!objects.delete(request.target)) throw new Error(`Released GPU-thread handle ${request.target} is absent`);
      return;
    }
    if (request.kind === 'close') {
      const losses = [...devices].map((device) => { device.destroy(); return device.lost; });
      Promise.all(losses).then(() => {
        objects.clear(); mappedRanges.clear(); closed = true;
        success(request, undefined);
      }, (error) => failure(request, error));
      return;
    }
    if (request.kind === 'stage-mapped-range') {
      const range = resource(request.range);
      new Uint8Array(request.shared).set(new Uint8Array(range));
      let ranges = mappedRanges.get(request.target);
      if (!ranges) mappedRanges.set(request.target, ranges = []);
      ranges.push({ handle: request.range, shared: request.shared, write: request.write });
      success(request, undefined);
      return;
    }
    if (request.target === rootHandle && !objects.has(rootHandle)) {
      const gpu = provider?.gpu ?? globalThis.navigator?.gpu ?? null;
      if (gpu === null) throw unsupported(request.interfaceName, request.member);
      objects.set(rootHandle, gpu);
    }
    const target = resource(request.target);
    if (!(request.member in target)) throw unsupported(request.interfaceName, request.member);
    if (request.kind === 'get') {
      const value = target[request.member];
      success(request, request.interfaceName === 'GPU' && request.member === 'wgslLanguageFeatures' ? [...value] : value);
      return;
    }
    const values = decodeGpuValue(request.arguments, resource);
    if (request.kind === 'set') { target[request.member] = values[0]; success(request, target[request.member]); return; }
    if (request.kind !== 'call') throw new TypeError(`Unknown GPU-thread request kind ${request.kind}`);
    if (typeof target[request.member] !== 'function') throw unsupported(request.interfaceName, request.member);
    if (request.flushQueue) resource(request.flushQueue).submit([]);
    if (request.releaseBuffers) for (const handle of request.releaseBuffers) flushMappedRanges(handle, true);
    if (request.interfaceName === 'GPUBuffer' && (request.member === 'unmap' || request.member === 'destroy')) {
      flushMappedRanges(request.target, request.member === 'destroy');
    }
    if (request.interfaceName === 'GPUAdapter' && request.member === 'requestDevice') {
      const label = values[0]?.defaultQueue?.label;
      request.queueLabel = label === undefined ? '' : `${label}`;
    }
    if (request.interfaceName === 'GPUAdapter' && request.member === 'requestDevice' && provider !== null) {
      provider.provideDevice({ adapter: target, descriptor: values[0] ?? {}, options: providerOptions }, {
        reply(value) {
          if (!(value instanceof GPUDevice)) { failure(request, new TypeError('GPU-thread provider must reply with a native GPUDevice from this thread')); return; }
          success(request, value);
        },
        throw(error) { failure(request, error); },
      });
      return;
    }
    const result = Reflect.apply(target[request.member], target, values);
    if (request.asynchronous) result.then((value) => success(request, value), (error) => failure(request, error));
    else success(request, result);
  } catch (error) { failure(request, error); }
}

if (parentPort) parentPort.on('message', dispatch);
else globalThis.onmessage = ({ data }) => dispatch(data);
function terminalFailure(error) {
  closed = true;
  const value = { success: false, error: gpuErrorRecord(error) };
  for (const memory of synchronousReplies) writeGpuReply(memory, value);
  synchronousReplies.clear();
  send({ event: 'failure', error: value.error });
}
if (parentPort) parentPort.on('messageerror', terminalFailure);
else globalThis.addEventListener('error', (event) => { event.preventDefault(); terminalFailure(event.error ?? new Error(event.message)); });
