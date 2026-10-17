// Handwritten WebGPU interface. Native effects execute on the GPU thread.
// Interface coverage follows https://gpuweb.github.io/gpuweb/#idl-index.
const construction = Symbol('GPU-thread construction');
const resources = new WeakMap();
const values = new WeakMap();
const queueDevices = new WeakMap();
let externalImageCopy = null;

export function setGpuThreadExternalImageCopy(handler) { externalImageCopy = handler; }
export function gpuThreadResource(value) { return resources.get(value) ?? null; }
export function isGpuThreadDevice(value) { return value instanceof GPUDevice; }
export function isGpuThreadCapability(value) { return resources.get(value)?.name === 'GPU'; }
export function gpuThreadQueueDevice(queue) {
  const device = queueDevices.get(queue);
  if (!device) throw new TypeError('GPUQueue has no GPU-thread device');
  return device;
}
function unsupported(name, member) {
  throw new DOMException(`${name}.${member} is not supported by the GPU-thread host`, 'NotSupportedError');
}
function initialize(object, token, transport, description) {
  if (token !== construction) throw new TypeError('Illegal constructor');
  const state = { transport, handle: description.handle, name: description.type, description };
  resources.set(object, state);
  transport.retain(object, state.handle);
  return state;
}
function state(object) {
  const result = resources.get(object);
  if (!result) throw new TypeError('Illegal WebGPU invocation');
  return result;
}
function call(object, member, arguments_, resultType = 'value') {
  const owner = state(object);
  return owner.transport.call(owner, member, Array.from(arguments_), resultType);
}
function callAsync(object, member, arguments_, resultType = 'value') {
  const owner = state(object);
  return new Promise((reply, reject) => owner.transport.callAsync(owner, member, Array.from(arguments_), resultType, { reply, throw: reject }));
}
function get(object, member) { const owner = state(object); return owner.transport.get(owner, member); }
function set(object, member, value) { const owner = state(object); owner.transport.set(owner, member, value); }
function label(object) {
  const owner = state(object);
  if (!Object.hasOwn(owner.description, 'label')) unsupported(owner.name, 'label');
  return owner.description.label;
}
function setLabel(object, value) {
  const text = `${value}`;
  set(object, 'label', text);
  state(object).description.label = text;
}
function attribute(object, member) {
  const owner = state(object);
  const attributes = owner.description.attributes;
  if (!Object.hasOwn(attributes, member)) unsupported(owner.name, member);
  return attributes[member];
}
function data(object, member, name) {
  const record = values.get(object);
  if (!record) throw new TypeError('Illegal WebGPU invocation');
  if (!Object.hasOwn(record, member)) unsupported(name, member);
  return record[member];
}
class GpuObject {
  constructor(token, transport, description) { initialize(this, token, transport, description); }
  get label() { return label(this); }
  set label(value) { setLabel(this, value); }
  get [Symbol.toStringTag]() { return state(this).name; }
}
class ReadonlyGpuSet {
  #entries;
  constructor(token, entries) {
    if (token !== construction) throw new TypeError('Illegal constructor');
    this.#entries = new Set(entries);
  }
  get size() { return this.#entries.size; }
  has(value) { return this.#entries.has(String(value)); }
  entries() { return this.#entries.entries(); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  forEach(callback, thisArgument) { this.#entries.forEach((value) => callback.call(thisArgument, value, value, this)); }
  [Symbol.iterator]() { return this.#entries.values(); }
}
export class GPUSupportedFeatures extends ReadonlyGpuSet { get [Symbol.toStringTag]() { return 'GPUSupportedFeatures'; } }
export class WGSLLanguageFeatures extends ReadonlyGpuSet { get [Symbol.toStringTag]() { return 'WGSLLanguageFeatures'; } }
export class GPUSupportedLimits {
  constructor(token, record) { if (token !== construction) throw new TypeError('Illegal constructor'); values.set(this, record); }
  get maxTextureDimension1D() { return data(this, 'maxTextureDimension1D', 'GPUSupportedLimits'); }
  get maxTextureDimension2D() { return data(this, 'maxTextureDimension2D', 'GPUSupportedLimits'); }
  get maxTextureDimension3D() { return data(this, 'maxTextureDimension3D', 'GPUSupportedLimits'); }
  get maxTextureArrayLayers() { return data(this, 'maxTextureArrayLayers', 'GPUSupportedLimits'); }
  get maxBindGroups() { return data(this, 'maxBindGroups', 'GPUSupportedLimits'); }
  get maxBindGroupsPlusVertexBuffers() { return data(this, 'maxBindGroupsPlusVertexBuffers', 'GPUSupportedLimits'); }
  get maxImmediateSize() { return data(this, 'maxImmediateSize', 'GPUSupportedLimits'); }
  get maxBindingsPerBindGroup() { return data(this, 'maxBindingsPerBindGroup', 'GPUSupportedLimits'); }
  get maxDynamicUniformBuffersPerPipelineLayout() { return data(this, 'maxDynamicUniformBuffersPerPipelineLayout', 'GPUSupportedLimits'); }
  get maxDynamicStorageBuffersPerPipelineLayout() { return data(this, 'maxDynamicStorageBuffersPerPipelineLayout', 'GPUSupportedLimits'); }
  get maxSampledTexturesPerShaderStage() { return data(this, 'maxSampledTexturesPerShaderStage', 'GPUSupportedLimits'); }
  get maxSamplersPerShaderStage() { return data(this, 'maxSamplersPerShaderStage', 'GPUSupportedLimits'); }
  get maxStorageBuffersPerShaderStage() { return data(this, 'maxStorageBuffersPerShaderStage', 'GPUSupportedLimits'); }
  get maxStorageBuffersInVertexStage() { return data(this, 'maxStorageBuffersInVertexStage', 'GPUSupportedLimits'); }
  get maxStorageBuffersInFragmentStage() { return data(this, 'maxStorageBuffersInFragmentStage', 'GPUSupportedLimits'); }
  get maxStorageTexturesPerShaderStage() { return data(this, 'maxStorageTexturesPerShaderStage', 'GPUSupportedLimits'); }
  get maxStorageTexturesInVertexStage() { return data(this, 'maxStorageTexturesInVertexStage', 'GPUSupportedLimits'); }
  get maxStorageTexturesInFragmentStage() { return data(this, 'maxStorageTexturesInFragmentStage', 'GPUSupportedLimits'); }
  get maxUniformBuffersPerShaderStage() { return data(this, 'maxUniformBuffersPerShaderStage', 'GPUSupportedLimits'); }
  get maxUniformBufferBindingSize() { return data(this, 'maxUniformBufferBindingSize', 'GPUSupportedLimits'); }
  get maxStorageBufferBindingSize() { return data(this, 'maxStorageBufferBindingSize', 'GPUSupportedLimits'); }
  get minUniformBufferOffsetAlignment() { return data(this, 'minUniformBufferOffsetAlignment', 'GPUSupportedLimits'); }
  get minStorageBufferOffsetAlignment() { return data(this, 'minStorageBufferOffsetAlignment', 'GPUSupportedLimits'); }
  get maxVertexBuffers() { return data(this, 'maxVertexBuffers', 'GPUSupportedLimits'); }
  get maxBufferSize() { return data(this, 'maxBufferSize', 'GPUSupportedLimits'); }
  get maxVertexAttributes() { return data(this, 'maxVertexAttributes', 'GPUSupportedLimits'); }
  get maxVertexBufferArrayStride() { return data(this, 'maxVertexBufferArrayStride', 'GPUSupportedLimits'); }
  get maxInterStageShaderVariables() { return data(this, 'maxInterStageShaderVariables', 'GPUSupportedLimits'); }
  get maxColorAttachments() { return data(this, 'maxColorAttachments', 'GPUSupportedLimits'); }
  get maxColorAttachmentBytesPerSample() { return data(this, 'maxColorAttachmentBytesPerSample', 'GPUSupportedLimits'); }
  get maxComputeWorkgroupStorageSize() { return data(this, 'maxComputeWorkgroupStorageSize', 'GPUSupportedLimits'); }
  get maxComputeInvocationsPerWorkgroup() { return data(this, 'maxComputeInvocationsPerWorkgroup', 'GPUSupportedLimits'); }
  get maxComputeWorkgroupSizeX() { return data(this, 'maxComputeWorkgroupSizeX', 'GPUSupportedLimits'); }
  get maxComputeWorkgroupSizeY() { return data(this, 'maxComputeWorkgroupSizeY', 'GPUSupportedLimits'); }
  get maxComputeWorkgroupSizeZ() { return data(this, 'maxComputeWorkgroupSizeZ', 'GPUSupportedLimits'); }
  get maxComputeWorkgroupsPerDimension() { return data(this, 'maxComputeWorkgroupsPerDimension', 'GPUSupportedLimits'); }
  get [Symbol.toStringTag]() { return 'GPUSupportedLimits'; }
}
export class GPUAdapterInfo {
  constructor(token, record) { if (token !== construction) throw new TypeError('Illegal constructor'); values.set(this, record); }
  get vendor() { return data(this, 'vendor', 'GPUAdapterInfo'); }
  get architecture() { return data(this, 'architecture', 'GPUAdapterInfo'); }
  get device() { return data(this, 'device', 'GPUAdapterInfo'); }
  get description() { return data(this, 'description', 'GPUAdapterInfo'); }
  get subgroupMinSize() { return data(this, 'subgroupMinSize', 'GPUAdapterInfo'); }
  get subgroupMaxSize() { return data(this, 'subgroupMaxSize', 'GPUAdapterInfo'); }
  get isFallbackAdapter() { return data(this, 'isFallbackAdapter', 'GPUAdapterInfo'); }
  get [Symbol.toStringTag]() { return 'GPUAdapterInfo'; }
}
export class GPU {
  #language = null;
  constructor(token, transport, description) {
    initialize(this, token, transport, description);
  }
  requestAdapter(_options = undefined) { return callAsync(this, 'requestAdapter', arguments, 'GPUAdapter'); }
  getPreferredCanvasFormat() { return call(this, 'getPreferredCanvasFormat', arguments); }
  get wgslLanguageFeatures() {
    return this.#language ??= new WGSLLanguageFeatures(construction, get(this, 'wgslLanguageFeatures'));
  }
  get [Symbol.toStringTag]() { return 'GPU'; }
}
export class GPUAdapter {
  #features; #limits; #info;
  constructor(token, transport, description) {
    initialize(this, token, transport, description);
    this.#features = new GPUSupportedFeatures(construction, description.features);
    this.#limits = new GPUSupportedLimits(construction, description.limits);
    this.#info = description.info === null ? null : new GPUAdapterInfo(construction, description.info);
  }
  get features() { return this.#features; }
  get limits() { return this.#limits; }
  get info() { return this.#info ?? unsupported('GPUAdapter', 'info'); }
  requestDevice(_descriptor = undefined) { return callAsync(this, 'requestDevice', arguments, 'GPUDevice'); }
  get [Symbol.toStringTag]() { return 'GPUAdapter'; }
}
export class GPUDevice extends EventTarget {
  #features; #limits; #info; #queue; #lost; #lostReply; #onuncapturederror = null;
  constructor(token, transport, description) {
    super();
    initialize(this, token, transport, description);
    this.#features = new GPUSupportedFeatures(construction, description.features);
    this.#limits = new GPUSupportedLimits(construction, description.limits);
    this.#info = description.info === null ? null : new GPUAdapterInfo(construction, description.info);
    this.#queue = createGpuFacade(transport, description.queue);
    queueDevices.set(this.#queue, this);
    this.#lost = new Promise((reply) => { this.#lostReply = reply; });
    transport.observeDevice(description.handle, description.queue.handle, (event) => {
      if (event.event === 'lost') this.#lostReply(new GPUDeviceLostInfo(construction, event.information));
      else if (event.event === 'uncapturederror') {
        const error = createGpuFacade(transport, event.error);
        const notification = new GPUUncapturedErrorEvent('uncapturederror', { error, cancelable: true });
        if (this.dispatchEvent(notification)) console.error(error.message);
      } else throw new Error(`Unknown GPU device event ${event.event}`);
    });
  }
  get label() { return label(this); }
  set label(value) { setLabel(this, value); }
  get features() { return this.#features; }
  get limits() { return this.#limits; }
  get adapterInfo() { return this.#info ?? unsupported('GPUDevice', 'adapterInfo'); }
  get queue() { return this.#queue; }
  get lost() { return this.#lost; }
  get onuncapturederror() { return this.#onuncapturederror; }
  set onuncapturederror(value) {
    if (this.#onuncapturederror !== null) this.removeEventListener('uncapturederror', this.#onuncapturederror);
    this.#onuncapturederror = typeof value === 'function' ? value : null;
    if (this.#onuncapturederror !== null) this.addEventListener('uncapturederror', this.#onuncapturederror);
  }
  destroy() { return call(this, 'destroy', arguments); }
  createBuffer(_descriptor) { return call(this, 'createBuffer', arguments, 'GPUBuffer'); }
  createTexture(_descriptor) { return call(this, 'createTexture', arguments, 'GPUTexture'); }
  createSampler(_descriptor = undefined) { return call(this, 'createSampler', arguments, 'GPUSampler'); }
  importExternalTexture(_descriptor) { return call(this, 'importExternalTexture', arguments, 'GPUExternalTexture'); }
  createBindGroupLayout(_descriptor) { return call(this, 'createBindGroupLayout', arguments, 'GPUBindGroupLayout'); }
  createPipelineLayout(_descriptor) { return call(this, 'createPipelineLayout', arguments, 'GPUPipelineLayout'); }
  createBindGroup(_descriptor) { return call(this, 'createBindGroup', arguments, 'GPUBindGroup'); }
  createShaderModule(_descriptor) { return call(this, 'createShaderModule', arguments, 'GPUShaderModule'); }
  createComputePipeline(_descriptor) { return call(this, 'createComputePipeline', arguments, 'GPUComputePipeline'); }
  createRenderPipeline(_descriptor) { return call(this, 'createRenderPipeline', arguments, 'GPURenderPipeline'); }
  createComputePipelineAsync(_descriptor) { return callAsync(this, 'createComputePipelineAsync', arguments, 'GPUComputePipeline'); }
  createRenderPipelineAsync(_descriptor) { return callAsync(this, 'createRenderPipelineAsync', arguments, 'GPURenderPipeline'); }
  createCommandEncoder(_descriptor = undefined) { return call(this, 'createCommandEncoder', arguments, 'GPUCommandEncoder'); }
  createRenderBundleEncoder(_descriptor) { return call(this, 'createRenderBundleEncoder', arguments, 'GPURenderBundleEncoder'); }
  createQuerySet(_descriptor) { return call(this, 'createQuerySet', arguments, 'GPUQuerySet'); }
  pushErrorScope(_filter) { return call(this, 'pushErrorScope', arguments); }
  popErrorScope() { return callAsync(this, 'popErrorScope', arguments, 'GPUError'); }
  get [Symbol.toStringTag]() { return 'GPUDevice'; }
}
export class GPUBuffer extends GpuObject {
  constructor(token, transport, description) {
    super(token, transport, description);
    transport.registerBuffer(this, state(this));
  }
  get size() { return attribute(this, 'size'); }
  get usage() { return attribute(this, 'usage'); }
  get mapState() { const owner = state(this); return owner.transport.bufferState(owner); }
  mapAsync(_mode, _offset = undefined, _size = undefined) {
    const owner = state(this);
    return new Promise((reply, reject) => owner.transport.mapBuffer(owner, Array.from(arguments), { reply, throw: reject }));
  }
  getMappedRange(offset = undefined, size = undefined) {
    const owner = state(this);
    return owner.transport.mappedRange(owner, offset, size);
  }
  unmap() { const owner = state(this); return owner.transport.unmapBuffer(owner, false); }
  destroy() { const owner = state(this); return owner.transport.unmapBuffer(owner, true); }
}
export class GPUTexture extends GpuObject {
  createView(_descriptor = undefined) { return call(this, 'createView', arguments, 'GPUTextureView'); }
  destroy() { return call(this, 'destroy', arguments); }
  get width() { return attribute(this, 'width'); }
  get height() { return attribute(this, 'height'); }
  get depthOrArrayLayers() { return attribute(this, 'depthOrArrayLayers'); }
  get mipLevelCount() { return attribute(this, 'mipLevelCount'); }
  get sampleCount() { return attribute(this, 'sampleCount'); }
  get dimension() { return attribute(this, 'dimension'); }
  get format() { return attribute(this, 'format'); }
  get usage() { return attribute(this, 'usage'); }
  get textureBindingViewDimension() { return attribute(this, 'textureBindingViewDimension'); }
}
export class GPUTextureView extends GpuObject {}
export class GPUSampler extends GpuObject {}
export class GPUExternalTexture extends GpuObject {}
export class GPUBindGroupLayout extends GpuObject {}
export class GPUPipelineLayout extends GpuObject {}
export class GPUBindGroup extends GpuObject {}
export class GPUShaderModule extends GpuObject {
  getCompilationInfo() { return callAsync(this, 'getCompilationInfo', arguments, 'GPUCompilationInfo'); }
}
class GpuPipeline extends GpuObject {
  getBindGroupLayout(_index) { return call(this, 'getBindGroupLayout', arguments, 'GPUBindGroupLayout'); }
}
export class GPUComputePipeline extends GpuPipeline {}
export class GPURenderPipeline extends GpuPipeline {}
export class GPUCommandBuffer extends GpuObject {}
class GpuDebugCommands extends GpuObject {
  pushDebugGroup(_groupLabel) { return call(this, 'pushDebugGroup', arguments); }
  popDebugGroup() { return call(this, 'popDebugGroup', arguments); }
  insertDebugMarker(_markerLabel) { return call(this, 'insertDebugMarker', arguments); }
}
class GpuBindingCommands extends GpuDebugCommands {
  setBindGroup(_index, _bindGroup, _dynamicOffsets = undefined, _start = undefined, _length = undefined) { return call(this, 'setBindGroup', arguments); }
  setImmediates(_rangeOffset, _bytes, _dataOffset = undefined, _dataSize = undefined) { return call(this, 'setImmediates', arguments); }
}
class GpuRenderCommands extends GpuBindingCommands {
  setPipeline(_pipeline) { return call(this, 'setPipeline', arguments); }
  setIndexBuffer(_buffer, _indexFormat, _offset = undefined, _size = undefined) { return call(this, 'setIndexBuffer', arguments); }
  setVertexBuffer(_slot, _buffer, _offset = undefined, _size = undefined) { return call(this, 'setVertexBuffer', arguments); }
  draw(_vertexCount, _instanceCount = undefined, _firstVertex = undefined, _firstInstance = undefined) { return call(this, 'draw', arguments); }
  drawIndexed(_indexCount, _instanceCount = undefined, _firstIndex = undefined, _baseVertex = undefined, _firstInstance = undefined) { return call(this, 'drawIndexed', arguments); }
  drawIndirect(_indirectBuffer, _indirectOffset) { return call(this, 'drawIndirect', arguments); }
  drawIndexedIndirect(_indirectBuffer, _indirectOffset) { return call(this, 'drawIndexedIndirect', arguments); }
}
export class GPUCommandEncoder extends GpuDebugCommands {
  beginRenderPass(_descriptor) { return call(this, 'beginRenderPass', arguments, 'GPURenderPassEncoder'); }
  beginComputePass(_descriptor = undefined) { return call(this, 'beginComputePass', arguments, 'GPUComputePassEncoder'); }
  copyBufferToBuffer(_source, _sourceOffset, _destination = undefined, _destinationOffset = undefined, _size = undefined) { return call(this, 'copyBufferToBuffer', arguments); }
  copyBufferToTexture(_source, _destination, _copySize) { return call(this, 'copyBufferToTexture', arguments); }
  copyTextureToBuffer(_source, _destination, _copySize) { return call(this, 'copyTextureToBuffer', arguments); }
  copyTextureToTexture(_source, _destination, _copySize) { return call(this, 'copyTextureToTexture', arguments); }
  clearBuffer(_buffer, _offset = undefined, _size = undefined) { return call(this, 'clearBuffer', arguments); }
  resolveQuerySet(_querySet, _firstQuery, _queryCount, _destination, _destinationOffset) { return call(this, 'resolveQuerySet', arguments); }
  finish(_descriptor = undefined) { return call(this, 'finish', arguments, 'GPUCommandBuffer'); }
}
export class GPUComputePassEncoder extends GpuBindingCommands {
  setPipeline(_pipeline) { return call(this, 'setPipeline', arguments); }
  dispatchWorkgroups(_workgroupCountX, _workgroupCountY = undefined, _workgroupCountZ = undefined) { return call(this, 'dispatchWorkgroups', arguments); }
  dispatchWorkgroupsIndirect(_indirectBuffer, _indirectOffset) { return call(this, 'dispatchWorkgroupsIndirect', arguments); }
  end() { return call(this, 'end', arguments); }
}
export class GPURenderPassEncoder extends GpuRenderCommands {
  setViewport(_x, _y, _width, _height, _minDepth, _maxDepth) { return call(this, 'setViewport', arguments); }
  setScissorRect(_x, _y, _width, _height) { return call(this, 'setScissorRect', arguments); }
  setBlendConstant(_color) { return call(this, 'setBlendConstant', arguments); }
  setStencilReference(_reference) { return call(this, 'setStencilReference', arguments); }
  beginOcclusionQuery(_queryIndex) { return call(this, 'beginOcclusionQuery', arguments); }
  endOcclusionQuery() { return call(this, 'endOcclusionQuery', arguments); }
  executeBundles(_bundles) { return call(this, 'executeBundles', arguments); }
  end() { return call(this, 'end', arguments); }
}
export class GPURenderBundleEncoder extends GpuRenderCommands {
  finish(_descriptor = undefined) { return call(this, 'finish', arguments, 'GPURenderBundle'); }
}
export class GPURenderBundle extends GpuObject {}
export class GPUQueue extends GpuObject {
  submit(_commandBuffers) { return call(this, 'submit', arguments); }
  onSubmittedWorkDone() { return callAsync(this, 'onSubmittedWorkDone', arguments); }
  writeBuffer(_buffer, _bufferOffset, _bytes, _dataOffset = undefined, _size = undefined) { return call(this, 'writeBuffer', arguments); }
  writeTexture(_destination, _bytes, _dataLayout, _size) { return call(this, 'writeTexture', arguments); }
  copyExternalImageToTexture(source, destination, copySize) {
    if (externalImageCopy?.(this, source, destination, copySize)) return;
    return call(this, 'copyExternalImageToTexture', arguments);
  }
}
export class GPUQuerySet extends GpuObject {
  destroy() { return call(this, 'destroy', arguments); }
  get type() { return attribute(this, 'type'); }
  get count() { return attribute(this, 'count'); }
}
export class GPUDeviceLostInfo {
  constructor(token, record) { if (token !== construction) throw new TypeError('Illegal constructor'); values.set(this, record); }
  get reason() { return data(this, 'reason', 'GPUDeviceLostInfo'); }
  get message() { return data(this, 'message', 'GPUDeviceLostInfo'); }
  get [Symbol.toStringTag]() { return 'GPUDeviceLostInfo'; }
}
export class GPUCompilationMessage {
  constructor(token, record) { if (token !== construction) throw new TypeError('Illegal constructor'); values.set(this, record); }
  get message() { return data(this, 'message', 'GPUCompilationMessage'); }
  get type() { return data(this, 'type', 'GPUCompilationMessage'); }
  get lineNum() { return data(this, 'lineNum', 'GPUCompilationMessage'); }
  get linePos() { return data(this, 'linePos', 'GPUCompilationMessage'); }
  get offset() { return data(this, 'offset', 'GPUCompilationMessage'); }
  get length() { return data(this, 'length', 'GPUCompilationMessage'); }
  get [Symbol.toStringTag]() { return 'GPUCompilationMessage'; }
}
export class GPUCompilationInfo {
  #messages;
  constructor(token, record) {
    if (token !== construction) throw new TypeError('Illegal constructor');
    this.#messages = Object.freeze(record.messages.map((message) => new GPUCompilationMessage(construction, message)));
  }
  get messages() { return this.#messages; }
  get [Symbol.toStringTag]() { return 'GPUCompilationInfo'; }
}
export class GPUError {
  #message;
  constructor(token, message) { if (token !== construction) throw new TypeError('Illegal constructor'); this.#message = String(message); }
  get message() { return this.#message; }
  get [Symbol.toStringTag]() { return this.constructor.name; }
}
export class GPUValidationError extends GPUError {
  constructor(message) { if (!arguments.length) throw new TypeError('GPUValidationError requires a message'); super(construction, message); }
}
export class GPUOutOfMemoryError extends GPUError {
  constructor(message) { if (!arguments.length) throw new TypeError('GPUOutOfMemoryError requires a message'); super(construction, message); }
}
export class GPUInternalError extends GPUError {
  constructor(message) { if (!arguments.length) throw new TypeError('GPUInternalError requires a message'); super(construction, message); }
}
export class GPUPipelineError extends DOMException {
  #reason;
  constructor(message = '', options) {
    super(String(message), 'GPUPipelineError');
    if (!options || !['validation', 'internal'].includes(String(options.reason))) throw new TypeError('GPUPipelineError requires a validation or internal reason');
    this.#reason = String(options.reason);
  }
  get reason() { return this.#reason; }
}
export class GPUUncapturedErrorEvent extends Event {
  #error;
  constructor(type, initialization) {
    super(type, initialization);
    if (!(initialization?.error instanceof GPUError)) throw new TypeError('GPUUncapturedErrorEvent requires a GPUError');
    this.#error = initialization.error;
  }
  get error() { return this.#error; }
}

export const GPUBufferUsage = Object.freeze({ MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
  INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });
export const GPUTextureUsage = Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16, TRANSIENT_ATTACHMENT: 32 });
export const GPUMapMode = Object.freeze({ READ: 1, WRITE: 2 });
export const GPUShaderStage = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
export const GPUColorWrite = Object.freeze({ RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 });

export const gpuFacadeInterfaces = Object.freeze({ GPU, GPUAdapter, GPUDevice, GPUSupportedFeatures,
  GPUSupportedLimits, GPUAdapterInfo, WGSLLanguageFeatures, GPUBuffer, GPUTexture, GPUTextureView,
  GPUSampler, GPUExternalTexture, GPUBindGroupLayout, GPUPipelineLayout, GPUBindGroup, GPUShaderModule,
  GPUComputePipeline, GPURenderPipeline, GPUCommandEncoder, GPUCommandBuffer, GPUComputePassEncoder,
  GPURenderPassEncoder, GPURenderBundleEncoder, GPURenderBundle, GPUQueue, GPUQuerySet, GPUDeviceLostInfo,
  GPUCompilationMessage, GPUCompilationInfo, GPUError, GPUValidationError, GPUOutOfMemoryError,
  GPUInternalError, GPUPipelineError, GPUUncapturedErrorEvent, GPUBufferUsage, GPUTextureUsage,
  GPUMapMode, GPUShaderStage, GPUColorWrite });

export function createGpuFacade(transport, record) {
  if (record === null) return null;
  if (record.type === 'mapped-range') return record;
  if (record.type === 'GPUCompilationInfo') return new GPUCompilationInfo(construction, record);
  if (record.type === 'GPUValidationError') return new GPUValidationError(record.message);
  if (record.type === 'GPUOutOfMemoryError') return new GPUOutOfMemoryError(record.message);
  if (record.type === 'GPUInternalError') return new GPUInternalError(record.message);
  const Constructor = gpuFacadeInterfaces[record.type];
  if (typeof Constructor !== 'function') throw new TypeError(`Unknown GPU-thread interface ${record.type}`);
  return new Constructor(construction, transport, record);
}
export function gpuThreadError(record) {
  if (record.constructor === 'GPUPipelineError') return new GPUPipelineError(record.message, { reason: record.reason });
  const constructors = { Error, TypeError, RangeError, SyntaxError, ReferenceError };
  const Constructor = constructors[record.name];
  const error = Constructor ? new Constructor(record.message) : new DOMException(record.message, record.name);
  if (record.stack) error.stack = record.stack;
  return error;
}
