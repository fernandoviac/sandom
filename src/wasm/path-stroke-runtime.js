import * as ABI from "./path-stroke-interface.js";
import { resourceOwnerIdentity } from "./resource-owner.js";

const services = new WeakMap();

export function createPathStrokeService(module) {
  const existing = services.get(module);
  if (existing) return existing;
  const ownerIdentity = resourceOwnerIdentity(module);
  const nativeError = () => {
    const detail = ABI.readError(new DataView(module.memory.buffer), module.exports.atlas_strokes_error_ptr());
    return Object.assign(new Error(`Native stroke operation failed (${detail.code}, field ${detail.field}, record ${detail.recordIndex})`), { nativeFailure: Object.freeze(detail) });
  };
  const service = Object.freeze({
    owner: module,
    ownerIdentity,
    canonicalize(inputBytes, dashes) {
      if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength % ABI.INPUT_SIZE !== 0 ||
          !(dashes instanceof Float64Array)) {
        throw new TypeError("Stroke input requires Input64 bytes and a Float64Array dash arena");
      }
      // Only same-owner inputs need a copy before an allocating call can detach them.
      const input = inputBytes.buffer === module.memory.buffer ? inputBytes.slice() : inputBytes;
      const dashInput = dashes.buffer === module.memory.buffer ? dashes.slice() : dashes;
      const count = input.byteLength / ABI.INPUT_SIZE;
      const batch = module.exports.atlas_strokes_create(count, dashInput.length);
      if (!batch) throw nativeError();
      try {
        if (input.byteLength) new Uint8Array(module.memory.buffer).set(input, module.exports.atlas_strokes_input_ptr(batch));
        if (dashInput.length) {
          const pointer = module.exports.atlas_strokes_dash_ptr(batch);
          const view = new DataView(module.memory.buffer);
          for (let index = 0; index < dashInput.length; index++) view.setFloat64(pointer + index * 8, dashInput[index], true);
        }
        if (module.exports.atlas_strokes_execute(batch) !== 1) throw nativeError();
        const pointer = module.exports.atlas_strokes_output_ptr(batch);
        const byteLength = module.exports.atlas_strokes_output_length(batch);
        const output = ABI.readStrokeOutput(new DataView(module.memory.buffer), pointer, byteLength);
        if (output.count !== count) throw new Error("Native stroke output count mismatch");
        let released = false;
        const live = () => {
          if (released) throw new Error("Canonical stroke result has been released");
        };
        return Object.freeze({
          owner: module,
          ownerIdentity,
          count,
          byteLength,
          view() {
            live();
            return new Uint8Array(module.memory.buffer, pointer, byteLength);
          },
          blob(index) {
            live();
            if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError("Stroke output index out of bounds");
            const view = new DataView(module.memory.buffer, pointer, byteLength);
            const entry = ABI.readOutputEntry(view, ABI.OUTPUT_BATCH_SIZE + index * ABI.OUTPUT_ENTRY_SIZE);
            return ABI.readCanonicalBlob(view, entry.offset, entry.byteLength);
          },
          release() {
            if (released) return;
            if (module.exports.atlas_strokes_destroy(batch) !== 1) throw nativeError();
            released = true;
          },
        });
      } catch (error) {
        if (module.exports.atlas_strokes_destroy(batch) !== 1) {
          throw new AggregateError([error, nativeError()], "Stroke operation and native cleanup failed");
        }
        throw error;
      }
    },
  });
  services.set(module, service);
  return service;
}
