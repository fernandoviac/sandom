import { sharedDomCore } from "./core.js";
import { createEasingBindings } from "../dom/dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";

const TEXT_ROW_SIZE = layoutConstant("TEXT_ROW_SIZE");
const TEXT_ROW_POINTER = layoutConstant("TEXT_ROW_POINTER");
const TEXT_ROW_LENGTH = layoutConstant("TEXT_ROW_LENGTH");
const EASING_LINEAR_TEXT_SIZE = layoutConstant("EASING_LINEAR_TEXT_SIZE");
const EASING_LINEAR_TEXT_INPUT = layoutConstant("EASING_LINEAR_TEXT_INPUT");
const EASING_LINEAR_TEXT_ROW = layoutConstant("EASING_LINEAR_TEXT_ROW");
// The css_easing_payload output of easing.watpart, by WAT name.
const EASING_PAYLOAD = Object.freeze(Object.fromEntries(["KIND", "COUNT", "X1", "Y1", "X2", "Y2", "POINT_COUNT", "POINTS"]
  .map((name) => [name, layoutConstant(`EASING_PAYLOAD_${name}`)])));
const EASING_POINT = Object.freeze(Object.fromEntries(["SIZE", "INPUT", "OUTPUT"]
  .map((name) => [name, layoutConstant(`EASING_POINT_${name}`)])));
const EASING_KIND = Object.freeze(Object.fromEntries(["KEYWORD", "CUBIC", "STEPS", "LINEAR"]
  .map((name) => [name, layoutConstant(`EASING_KIND_${name}`)])));
const ERROR_KIND_INVALID_HANDLE = layoutConstant("ERROR_KIND_INVALID_HANDLE");
const ERROR_KIND_RANGE = layoutConstant("ERROR_KIND_RANGE");

// The grammar's verdict on an easing value (ERROR_KIND_INVALID_HANDLE and
// ERROR_KIND_RANGE) already contains the complete language-level message;
// every other kind is a fault inside the core and keeps its detail numbers.
function throwEasingError(core) {
  const kind = core.exports.abi_error_kind();
  if (kind === 0) return;
  core.throwIfError(kind === ERROR_KIND_INVALID_HANDLE || kind === ERROR_KIND_RANGE);
}

function parseEasingTransport(raw) {
  const core = sharedDomCore;
  const handle = core.exports.css_easing_parse(...core.input(raw));
  throwEasingError(core);
  try {
    core.exports.css_easing_text(handle);
    throwEasingError(core);
    const cssText = core.outputString();
    core.exports.css_easing_payload(handle);
    throwEasingError(core);
    core.refreshBytes();
    const view = new DataView(
      core.memory.buffer,
      core.exports.abi_output_pointer(),
      core.exports.abi_output_length(),
    );
    switch (view.getUint32(EASING_PAYLOAD.KIND, true)) {
      case EASING_KIND.KEYWORD:
        return cssText;
      case EASING_KIND.CUBIC:
        return {
          kind: "cubicBezier",
          x1: view.getFloat64(EASING_PAYLOAD.X1, true),
          y1: view.getFloat64(EASING_PAYLOAD.Y1, true),
          x2: view.getFloat64(EASING_PAYLOAD.X2, true),
          y2: view.getFloat64(EASING_PAYLOAD.Y2, true),
          cssText,
        };
      case EASING_KIND.STEPS: {
        const count = view.getFloat64(EASING_PAYLOAD.COUNT, true);
        core.status("css_easing_step_position", handle);
        return { kind: "steps", count, position: core.outputString(), cssText };
      }
      case EASING_KIND.LINEAR: {
        const points = new Array(view.getUint32(EASING_PAYLOAD.POINT_COUNT, true));
        for (let index = 0; index < points.length; index++) {
          const point = EASING_PAYLOAD.POINTS + index * EASING_POINT.SIZE;
          points[index] = {
            input: view.getFloat64(point + EASING_POINT.INPUT, true),
            output: view.getFloat64(point + EASING_POINT.OUTPUT, true),
          };
        }
        return { kind: "linear", points, cssText };
      }
      default:
        throw new Error("Unknown core easing payload kind");
    }
  } finally {
    core.status("css_easing_release", handle);
  }
}

function coerceEasing(easing) {
  let kind;
  let text = "";
  let strings;
  let inputs = null;
  if (typeof easing === "string") {
    return { kind: 0, text: easing };
  } else if (typeof easing?.cssText === "string") {
    return { kind: 0, text: easing.cssText };
  } else if (easing?.kind === "cubicBezier") {
    kind = 4;
    strings = [
      `${easing.x1}`,
      `${easing.y1}`,
      `${easing.x2}`,
      `${easing.y2}`,
    ];
  } else if (easing?.kind === "steps") {
    // Test position before count; the explicit branch reads position again.
    const implicitPosition = easing.position === "jump-end";
    kind = implicitPosition ? 5 : 7;
    strings = [`${easing.count}`];
    text = implicitPosition ? "jump-end" : `${easing.position}`;
  } else if (easing?.kind === "linear") {
    kind = 6;
    inputs = [];
    strings = easing.points.map((point) => {
      const output = `${point.output}`;
      inputs.push(+point.input);
      return output;
    });
  } else {
    throw new TypeError(`Unsupported easing record: ${JSON.stringify(easing)}`);
  }
  return { kind, text, strings, inputs };
}

function serializeEasingTransport({ kind, text, strings, inputs }) {
  if (kind === 0) return text;
  const core = sharedDomCore;
  // Finish all observable JavaScript coercions before touching ABI scratch.
  const encoded = strings.map((value) => core.input(value));
  const [textPointer, textLength] = core.input(text);
  const stride = inputs === null ? TEXT_ROW_SIZE : EASING_LINEAR_TEXT_SIZE;
  const pointer = encoded.length
    ? core.exports.abi_allocate(encoded.length * stride)
    : 0;
  core.refreshBytes();
  const view = new DataView(core.memory.buffer);
  for (let index = 0; index < encoded.length; index++) {
    let offset = pointer + index * stride;
    if (inputs !== null) {
      view.setFloat64(offset + EASING_LINEAR_TEXT_INPUT, inputs[index], true);
      offset += EASING_LINEAR_TEXT_ROW;
    }
    view.setUint32(offset + TEXT_ROW_POINTER, encoded[index][0], true);
    view.setUint32(offset + TEXT_ROW_LENGTH, encoded[index][1], true);
  }
  core.exports.css_easing_serialize(
    kind,
    textPointer,
    textLength,
    pointer,
    encoded.length,
  );
  throwEasingError(core);
  return core.outputString();
}

export const { parseCSSEasing, serializeCSSEasing } = createEasingBindings({
  coerceEasing,
  parseEasingTransport,
  serializeEasingTransport,
});

// The serialization of a timing function that the Web Animations interface
// reports (animation_easing_report). $easing is CSS text or a parsed record.
export function serializeAnimationEasing(easing) {
  const record = typeof easing === "string" ? parseCSSEasing(easing) : easing;
  if (typeof record !== "string") return serializeCSSEasing(record);
  return sharedDomCore.string("animation_easing_report", ...sharedDomCore.input(record));
}
