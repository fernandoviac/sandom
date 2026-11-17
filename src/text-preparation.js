import {
  TEXT_PREPARATION_ABI_VERSION,
  TEXT_PREPARATION_RESULT,
  TEXT_PREPARATION_RESULT_SIZE,
} from "./wasm/text-preparation-interface.js";

const REQUIRED_EXPORTS = Object.freeze([
  "text_prepare_abi_version",
  "text_prepare_error",
  "engine_record_prepare_text",
  "text_prepare_results",
  "text_prepare_release",
]);

// Preparation consumes the current native publication. Only requested
// inspection artifacts copy prepared text or source maps into JavaScript.
export function createTextPreparationRuntime(engine) {
  if (!(engine?.memory instanceof WebAssembly.Memory)) {
    throw new TypeError("text preparation requires a renderer-core engine");
  }
  const native = engine.exports;
  for (const name of REQUIRED_EXPORTS) {
    if (typeof native?.[name] !== "function") {
      throw new Error(`renderer-core text preparation ABI missing ${name}`);
    }
  }
  if (native.text_prepare_abi_version() !== TEXT_PREPARATION_ABI_VERSION) {
    throw new Error("renderer-core text preparation ABI version mismatch");
  }
  const check = (value, operation) => {
    if (!value) {
      throw new Error(
        `renderer-core text preparation ${operation} failed (${native.text_prepare_error()})`,
      );
    }
    return value;
  };

  return Object.freeze({
    // Nodes are retained only to format optional inspection artifacts.
    prepareTextBatch(nodes) {
      const handle = check(native.engine_record_prepare_text(), "batch");

      let released = false;
      let results = 0;
      // A batch's results never change, and a sparse write keeps the batch
      // only while every row's run is the one it prepared (a row that stops
      // or starts being text changes its run): one copy serves every frame
      // of the batch.
      let copiedRuns = null;
      const assertLive = () => {
        if (released) throw new Error("text preparation batch is released");
      };
      const resultsBase = () => {
        assertLive();
        if (results === 0) results = check(native.text_prepare_results(handle), "result read");
        return results;
      };
      return Object.freeze({
        resultsBase,
        // Owned copies for inspection artifacts only.
        copyRuns() {
          assertLive();
          if (copiedRuns !== null) return copiedRuns;
          const base = resultsBase();
          const view = new DataView(engine.memory.buffer);
          copiedRuns = Object.freeze(nodes.map((node, index) => {
            if (node.display !== "text") return null;
            const result = base + index * TEXT_PREPARATION_RESULT_SIZE;
            const bytes = view.getUint32(result + TEXT_PREPARATION_RESULT.BYTES, true);
            const length = view.getUint32(result + TEXT_PREPARATION_RESULT.LENGTH, true);
            const mapping = view.getUint32(result + TEXT_PREPARATION_RESULT.MAPPING, true);
            return Object.freeze({
              bytes: new Uint8Array(engine.memory.buffer, bytes, length).slice(),
              mapping: new Uint32Array(
                engine.memory.buffer,
                mapping,
                length + 1,
              ).slice(),
              authoredLength: view.getUint32(
                result + TEXT_PREPARATION_RESULT.AUTHORED_LENGTH,
                true,
              ),
              ellipsis: view.getUint32(
                result + TEXT_PREPARATION_RESULT.ELLIPSIS,
                true,
              ) !== 0,
              sourceId: view.getUint32(
                result + TEXT_PREPARATION_RESULT.SOURCE_ID,
                true,
              ),
              revision: view.getUint32(
                result + TEXT_PREPARATION_RESULT.REVISION,
                true,
              ),
              letterSpacing: view.getFloat32(
                result + TEXT_PREPARATION_RESULT.LETTER_SPACING,
                true,
              ),
            });
          }));
          return copiedRuns;
        },
        // Each node's run where the batch holds it: the core address and
        // length of its bytes and its source id, or null for a node that is
        // not text. The spans stay valid until the batch is released.
        runSpans() {
          const base = resultsBase();
          const view = new DataView(engine.memory.buffer);
          return nodes.map((node, index) => {
            if (node.display !== "text") return null;
            const result = base + index * TEXT_PREPARATION_RESULT_SIZE;
            return {
              bytes: {
                pointer: view.getUint32(result + TEXT_PREPARATION_RESULT.BYTES, true),
                length: view.getUint32(result + TEXT_PREPARATION_RESULT.LENGTH, true),
              },
              sourceId: view.getUint32(result + TEXT_PREPARATION_RESULT.SOURCE_ID, true),
            };
          });
        },
        release() {
          assertLive();
          check(native.text_prepare_release(handle), "release");
          released = true;
        },
      });
    },
  });
}
