import { instantiate } from "../wasm/motion-capture-binary.js";

// The failure message of the last failed call (frame_sequence_error_message).
function failureMessage(exports) {
  const length = exports.frame_sequence_error_message();
  const pointer = exports.frame_sequence_error_text();
  return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer, length));
}

function call(exports, operation, message) {
  if (operation()) return;
  throw new Error(`${message}: ${failureMessage(exports)}`);
}
function integerInRange(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
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
  if (rectangles.length > exports.frame_sequence_rectangle_capacity()) {
    throw new RangeError(
      "candidateRectangles exceeds the WebAssembly capacity",
    );
  }
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
    for (let field = 0; field < values.length; field++) {
      view.setFloat64(base + index * 32 + field * 8, values[field], true);
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
  const frameWidth = integerInRange(width, 1, 65535, "width");
  const frameHeight = integerInRange(height, 1, 65535, "height");
  const loops = integerInRange(loopCount, 0, 65535, "loopCount");
  const threshold = integerInRange(alphaThreshold, 0, 255, "alphaThreshold");
  const expectedByteLength = frameWidth * frameHeight * 4;
  const instance = instantiate({});
  const exports = instance.exports;
  call(
    exports,
    () =>
      exports.frame_sequence_create(frameWidth, frameHeight, loops, threshold),
    "Cannot create GIF recorder",
  );

  return Object.freeze({
    addFrame({ pixels, durationMilliseconds, candidateRectangles } = {}) {
      const bytes = frameBytes(pixels);
      const format = pixels instanceof Float32Array ? 1 : 0;
      const expectedInputLength = format === 1
        ? expectedByteLength * Float32Array.BYTES_PER_ELEMENT
        : expectedByteLength;
      if (bytes.byteLength !== expectedInputLength) {
        throw new RangeError(
          `pixels must contain exactly ${expectedByteLength} RGBA samples`,
        );
      }
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
            format,
            bytes.byteLength,
            durationMilliseconds,
            rectangleCount,
          ),
        "Cannot encode GIF frame",
      );
    },

    finish() {
      call(
        exports,
        () => exports.frame_sequence_finish(),
        "Cannot finish GIF recorder",
      );
      return new Uint8Array(
        exports.memory.buffer,
        exports.frame_sequence_output_address(),
        exports.frame_sequence_output_length(),
      ).slice();
    },
  });
}
