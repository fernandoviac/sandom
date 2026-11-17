import * as motionCaptureBinary from "../wasm/motion-capture-binary.js";
import { moduleLayoutConstants } from "../wasm/layout-table.js";

const { instantiate } = motionCaptureBinary;
const motionCaptureConstant = moduleLayoutConstants(motionCaptureBinary, "motion capture");
const CREATE = motionCaptureConstant("FRAME_SEQUENCE_CONTEXT_CREATE");
const ADD_FRAME = motionCaptureConstant("FRAME_SEQUENCE_CONTEXT_ADD_FRAME");
const FINISH = motionCaptureConstant("FRAME_SEQUENCE_CONTEXT_FINISH");
const numberOrNaN = (value) => typeof value === "number" ? value : NaN;

function messageText(exports, length) {
  return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.frame_sequence_error_text(), length));
}

// Throws the RangeError of a nonzero check result (its message length).
function check(exports, length) {
  if (length !== 0) throw new RangeError(messageText(exports, length));
}

function call(exports, operation, context) {
  if (operation()) return;
  throw new Error(messageText(exports, exports.frame_sequence_failure_message(context)));
}

function frameBytes(pixels) {
  if (
    !(pixels instanceof Float32Array) &&
    !(pixels instanceof Uint8Array) &&
    !(pixels instanceof Uint8ClampedArray)
  ) {
    throw new TypeError(
      "pixels must be a Uint8Array, Uint8ClampedArray, or Float32Array",
    );
  }
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function copyRectangles(exports, rectangles) {
  if (rectangles === undefined) return -1;
  if (!Array.isArray(rectangles)) {
    throw new TypeError("candidateRectangles must be an array");
  }
  check(exports, exports.frame_sequence_rectangle_count_check(rectangles.length));
  const view = new DataView(exports.memory.buffer);
  const base = exports.frame_sequence_rectangle_address();
  for (let index = 0; index < rectangles.length; index++) {
    const rectangle = rectangles[index];
    if (rectangle === null || typeof rectangle !== "object") {
      throw new TypeError(`candidateRectangles[${index}] must be a rectangle`);
    }
    const values = [
      rectangle.x,
      rectangle.y,
      rectangle.width,
      rectangle.height,
    ];
    if (values.some((value) => typeof value !== "number")) {
      throw new TypeError(
        `candidateRectangles[${index}] must have numeric x, y, width, and height`,
      );
    }
    // Each rectangle is x, y, width and height as f64 values.
    for (let field = 0; field < values.length; field++) {
      view.setFloat64(base + (index * values.length + field) * Float64Array.BYTES_PER_ELEMENT, values[field], true);
    }
  }
  return rectangles.length;
}

export function createGifRecorder({
  width,
  height,
  loopCount = 0,
  alphaThreshold = 0,
}) {
  const instance = instantiate({});
  const exports = instance.exports;
  check(exports, exports.frame_sequence_option_check(
    numberOrNaN(width), numberOrNaN(height), numberOrNaN(loopCount), numberOrNaN(alphaThreshold),
  ));
  call(exports, () => exports.frame_sequence_create(width, height, loopCount, alphaThreshold), CREATE);

  return Object.freeze({
    addFrame({ pixels, durationMilliseconds, candidateRectangles } = {}) {
      const bytes = frameBytes(pixels);
      const floatSamples = pixels instanceof Float32Array;
      check(exports, exports.frame_sequence_samples_check(floatSamples, bytes.byteLength));
      new Uint8Array(
        exports.memory.buffer,
        exports.frame_sequence_input_address(),
        bytes.byteLength,
      ).set(bytes);
      const rectangleCount = copyRectangles(exports, candidateRectangles);
      call(
        exports,
        () =>
          exports.frame_sequence_add_frame(
            floatSamples,
            bytes.byteLength,
            durationMilliseconds,
            rectangleCount,
          ),
        ADD_FRAME,
      );
    },

    finish() {
      call(exports, () => exports.frame_sequence_finish(), FINISH);
      return new Uint8Array(
        exports.memory.buffer,
        exports.frame_sequence_output_address(),
        exports.frame_sequence_output_length(),
      ).slice();
    },
  });
}
