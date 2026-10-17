import { markAuthorValueRejection, sharedDomCore } from "./core.js";
import { createEasingBindings } from "../dom/dom-bindings.generated.js";

// Easing diagnostics already contain the complete language-level message.
// Kinds 2 and 14 are the grammar's verdict on the value it was handed - the
// author-value rejection CSS Cascade drops a declaration for - and are
// marked as such. Every other kind is a fault inside the core and stays
// unmarked, so an apply path cannot mistake one for the other.
function throwEasingError(core) {
  const kind = core.exports.abi_error_kind();
  if (kind === 0) return;
  if (kind !== 2 && kind !== 14) {
    core.throwIfError();
    return;
  }
  const pointer = core.exports.abi_error_pointer();
  const length = core.exports.abi_error_length();
  const message = core.decoder.decode(
    core.refreshBytes().subarray(pointer, pointer + length),
  );
  throw markAuthorValueRejection(
    kind === 14 ? new RangeError(message) : new TypeError(message),
  );
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
    switch (view.getUint32(0, true)) {
      case 0:
        return cssText;
      case 1:
        return {
          kind: "cubicBezier",
          x1: view.getFloat64(16, true),
          y1: view.getFloat64(24, true),
          x2: view.getFloat64(32, true),
          y2: view.getFloat64(40, true),
          cssText,
        };
      case 2: {
        const count = view.getFloat64(8, true);
        core.status("css_easing_step_position", handle);
        return { kind: "steps", count, position: core.outputString(), cssText };
      }
      case 3: {
        const points = new Array(view.getUint32(48, true));
        for (let index = 0; index < points.length; index++) {
          points[index] = {
            input: view.getFloat64(56 + index * 16, true),
            output: view.getFloat64(64 + index * 16, true),
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
  const stride = inputs === null ? 8 : 16;
  const pointer = encoded.length
    ? core.exports.abi_allocate(encoded.length * stride)
    : 0;
  core.refreshBytes();
  const view = new DataView(core.memory.buffer);
  for (let index = 0; index < encoded.length; index++) {
    let offset = pointer + index * stride;
    if (inputs !== null) {
      view.setFloat64(offset, inputs[index], true);
      offset += 8;
    }
    view.setUint32(offset, encoded[index][0], true);
    view.setUint32(offset + 4, encoded[index][1], true);
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
