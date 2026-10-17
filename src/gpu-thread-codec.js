// Structured-clone transport. Tags distinguish opaque GPU handles from user
// dictionaries without reserving property names in those dictionaries.
const byteViews = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float16Array: globalThis.Float16Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
const textEncoder = new TextEncoder();
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
const bufferLengthGetters = [
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get,
  globalThis.SharedArrayBuffer && Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get,
].filter(Boolean);
function bufferByteLength(value) {
  if (value === null || typeof value !== 'object') return null;
  for (const getter of bufferLengthGetters) {
    try { return getter.call(value); }
    catch { /* An intrinsic accessor rejects a different buffer brand. */ }
  }
  return null;
}
function snapshotBytes(buffer, offset, length, transfers) {
  const snapshot = new Uint8Array(length);
  snapshot.set(new Uint8Array(buffer, offset, length));
  transfers?.push(snapshot.buffer);
  return snapshot.buffer;
}
function size64(value, member) {
  const number = Math.trunc(+value);
  if (!(number >= 0 && number < 18446744073709551616)) {
    throw new TypeError(`${member} requires a finite unsigned 64-bit size; observed ${String(value)}`);
  }
  return number;
}
// Frame only the addressed bytes. Native renderer writes commonly point at a
// short span of a large WebAssembly memory; cloning the whole memory per write
// would turn a few uniform bytes into a multi-megabyte transport operation.
export function gpuWriteBufferArguments(arguments_) {
  if (arguments_.length < 3) return arguments_;
  const data = arguments_[2];
  const view = ArrayBuffer.isView(data);
  const byteLength = view ? data.byteLength : bufferByteLength(data);
  if (byteLength === null) return arguments_;
  const name = view ? typedArrayName.call(data) : undefined;
  const elementSize = name === undefined ? 1 : byteViews[name].BYTES_PER_ELEMENT;
  const offset = arguments_[3] === undefined ? 0 : size64(arguments_[3], 'GPUQueue.writeBuffer dataOffset');
  const available = byteLength / elementSize;
  const size = arguments_[4] === undefined ? available - offset : size64(arguments_[4], 'GPUQueue.writeBuffer size');
  if (offset > available || size > available - offset) {
    throw new DOMException(`GPUQueue.writeBuffer range ${offset}+${size} exceeds ${available} elements; select a range within the source`, 'OperationError');
  }
  const bytes = new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + offset * elementSize, size * elementSize);
  return [arguments_[0], arguments_[1], bytes, 0, bytes.byteLength];
}
export function encodeGpuValue(value, resourceHandle = () => null, transfers = null) {
  if (value === undefined) return ['undefined'];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['value', value];
  if (typeof value === 'number') return Number.isFinite(value) ? ['value', value] : ['number', String(value)];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  const handle = resourceHandle(value);
  if (handle !== null) return ['resource', handle];
  if (ArrayBuffer.isView(value)) {
    const name = typedArrayName.call(value) ?? 'DataView';
    return ['view', name, snapshotBytes(value.buffer, value.byteOffset, value.byteLength, transfers), 0, value.byteLength];
  }
  if (Array.isArray(value)) return ['array', value.map((entry) => encodeGpuValue(entry, resourceHandle, transfers))];
  if (typeof value !== 'object') throw new TypeError(`GPU transport cannot copy a ${typeof value} value`);
  const byteLength = bufferByteLength(value);
  if (byteLength !== null) return ['buffer', snapshotBytes(value, 0, byteLength, transfers)];
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new DOMException(`GPU transport does not accept script-thread ${value.constructor?.name ?? 'native'} objects; create GPU resources through the GPU-thread facade`, 'NotSupportedError');
  }
  return ['dictionary', Object.getOwnPropertyNames(value).map((key) => [key, encodeGpuValue(value[key], resourceHandle, transfers)])];
}

export function decodeGpuValue(record, resource = () => { throw new Error('A GPU resource resolver is required'); }) {
  switch (record[0]) {
    case 'undefined': return undefined;
    case 'value': return record[1];
    case 'number': return Number(record[1]);
    case 'bigint': return BigInt(record[1]);
    case 'resource': return resource(record[1]);
    case 'buffer': return record[1];
    case 'view': {
      const Constructor = byteViews[record[1]];
      if (!Constructor) throw new TypeError(`Unknown GPU byte view ${record[1]}`);
      return Constructor === DataView ? new DataView(record[2], record[3], record[4])
        : new Constructor(record[2], record[3], record[4] / Constructor.BYTES_PER_ELEMENT);
    }
    case 'array': return record[1].map((entry) => decodeGpuValue(entry, resource));
    case 'dictionary': return Object.fromEntries(record[1].map(([key, entry]) => [key, decodeGpuValue(entry, resource)]));
    default: throw new TypeError(`Unknown GPU transport tag ${record[0]}`);
  }
}

export function gpuErrorRecord(error) {
  return { name: error.name, message: error.message, constructor: error.constructor?.name,
    reason: error.reason, stack: error.stack };
}

export function writeGpuReply(memory, value) {
  const text = JSON.stringify(value);
  const length = 16 + text.length * 3;
  if (length > memory.byteLength) memory.grow(length);
  const destination = new Uint8Array(memory, 16);
  const { written } = textEncoder.encodeInto(text, destination);
  const control = new Int32Array(memory, 0, 4);
  Atomics.store(control, 1, written);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}
