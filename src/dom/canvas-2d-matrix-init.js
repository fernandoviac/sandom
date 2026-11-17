// DOMMatrix2DInit for CanvasRenderingContext2D, Path2D and CanvasPattern:
// the binding reads the dictionary members, and the canvas core `core`
// (core/engine/canvas-2d-paint.watpart, matrix_init) runs "validate and fixup
// (2D)". `member` names the calling member in error messages, as Chrome's
// bindings do.
import * as canvas2dBinary from "../wasm/canvas-2d-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";

const MATRIX_INIT_MISMATCH = moduleLayoutConstants(canvas2dBinary, "canvas 2d")("MATRIX_INIT_MISMATCH");
const MEMBERS = Object.freeze(["a", "b", "c", "d", "e", "f", "m11", "m12", "m21", "m22", "m41", "m42"]);

export function matrixFromInit(value, member, core) {
  let present = 0;
  const values = MEMBERS.map(() => 0);
  if (value !== undefined && value !== null) {
    if (typeof value !== "object" && typeof value !== "function") {
      throw new TypeError(`${member}: The provided value is not of type 'DOMMatrix2DInit'.`);
    }
    MEMBERS.forEach((name, index) => {
      const memberValue = value[name];
      if (memberValue === undefined) return;
      present |= 1 << index;
      values[index] = Number(memberValue);
    });
  }
  if (core.matrix_init(present, ...values) === MATRIX_INIT_MISMATCH) {
    throw new TypeError(`${member}: Property mismatch on matrix initialization.`);
  }
  return Array.from(new Float64Array(core.memory.buffer, core.output_pointer(), 6));
}
