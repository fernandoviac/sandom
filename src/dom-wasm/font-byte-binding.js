// Host objects retain only opaque native source indices. The core owns face
// and coordinate selection. Mutable backing stores cross the ABI as snapshots.
const sourcesByCore = new WeakMap();

export function acquireFontByteSource(core, bytes, operation, arguments_) {
  const buffer = bytes.buffer;
  const mutable = buffer === core.refreshBytes().buffer || buffer.resizable || buffer.growable ||
    (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer);
  let sources = sourcesByCore.get(core);
  if (!sources) {
    sources = new WeakMap();
    sourcesByCore.set(core, sources);
  }
  const source = mutable ? undefined : sources.get(bytes);
  const input = source === undefined ? core.byteInput(mutable ? bytes.slice() : bytes) : [0, 0];
  const index = core.status(operation, source ?? -1, ...input, ...arguments_);
  if (!mutable) sources.set(bytes, index);
  return index;
}
