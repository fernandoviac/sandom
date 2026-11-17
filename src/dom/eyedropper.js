// The colour picker's eyedroppers, a thin wrapper over
// core/dom/color-picker.watpart. The core decides when an eyedropper
// takes a colour and draws the loupe; this file reads the pixels the core
// asks for and gives them back, or enters a colour in the picker's text
// field through the input controller's host editing commands, as a typed
// colour that Enter applies.
//
// When the page eyedropper starts, this file captures the page once, as
// the render surface draws it, and keeps the capture while the eyedropper
// waits for a press: the loupe shows the capture's pixels around the
// pointer, in the frame's working encoding (sRGB in the standard render
// mode, linear Rec. 2100 in the high-dynamic-range mode).
//
// A host gives `backend.setEyeDropper(eyeDropper)`: `{ open(request) }`
// or null. `open` calls `request.reply(colour)` once with a CSS colour,
// or `request.cancel()`, at any later time. With one, a picker built
// after offers the screen eyedropper beside the page one.

const KIND = Object.freeze({ PAGE: 1, SCREEN: 2, LOUPE: 3, CAPTURE: 4 });
// The loupe's side in device pixels (core $COLOR_PICKER_LOUPE_SIDE).
const LOUPE_SIDE = 11;

export function setDocumentEyeDropper(document, eyeDropper) {
  if (eyeDropper !== null && typeof eyeDropper?.open !== "function") {
    throw new TypeError(`setEyeDropper: eyeDropper is ${describe(eyeDropper)}; expected null or { open(request) }`);
  }
  document._domCore.exports.color_picker_screen_eyedropper_set(eyeDropper === null ? 0 : 1);
  document._eyeDropper = eyeDropper;
}

// The request of an effect 9 notification.
export function eyedropperRequest(core, notification) {
  return {
    kind: notification.aux,
    field: core.wrapperFor(notification.target),
    textField: core.wrapperFor(notification.related),
    x: notification.a,
    y: notification.b,
  };
}

// Runs eyedropper request `request` with the input controller's host
// editing commands `runtime`, after the run that made it.
export function runEyedropper(runtime, root, { kind, field, textField, x, y }) {
  const document = field.ownerDocument;
  const take = (colour) => {
    runtime.selectAll(root, { target: textField });
    runtime.insertText(root, colour, { inputType: "insertReplacementText", target: textField });
    runtime.keydown(root, "Enter", { target: textField, code: "Enter" });
  };
  if (kind === KIND.CAPTURE) {
    const surface = root._renderSurface;
    if (!surface) throw new Error("page eyedropper: the root has no render surface to capture");
    const capture = { frame: null, loupe: null };
    document._eyedropperCapture = capture;
    surface.renderNow({ pixels: true }).then((frame) => {
      if (document._eyedropperCapture !== capture) return;
      capture.frame = { ...frame, pixels: frame.pixels.slice() };
      if (capture.loupe) giveLoupe(document, capture, capture.loupe.x, capture.loupe.y);
    });
  } else if (kind === KIND.LOUPE) {
    const capture = document._eyedropperCapture;
    if (!capture) throw new Error("page eyedropper: a loupe request came without a capture of the page");
    capture.loupe = { x, y };
    if (capture.frame) giveLoupe(document, capture, x, y);
  } else if (kind === KIND.PAGE) {
    const capture = document._eyedropperCapture;
    if (capture?.frame) {
      take(colourAt(capture.frame, x, y));
    } else {
      const surface = root._renderSurface;
      if (!surface) throw new Error("page eyedropper: the root has no render surface to read the colour from");
      surface.renderNow({ pixels: true }).then((frame) => take(colourAt(frame, x, y)));
    }
  } else if (kind === KIND.SCREEN) {
    const eyeDropper = document._eyeDropper;
    if (!eyeDropper) throw new Error("screen eyedropper: the host gave none (backend.setEyeDropper)");
    let answered = false;
    const answer = () => {
      if (answered) throw new Error("screen eyedropper: the host already answered");
      answered = true;
    };
    eyeDropper.open(Object.freeze({
      reply(colour) {
        answer();
        if (typeof colour !== "string") {
          throw new TypeError(`screen eyedropper: the colour is ${describe(colour)}; expected a CSS colour string`);
        }
        take(colour);
      },
      cancel() {
        answer();
      },
    }));
  } else {
    throw new Error(`Unknown eyedropper request ${kind}`);
  }
}

// Drops the capture of `document` once its page eyedropper stops waiting.
export function releaseEyedropperCapture(core, document) {
  if (document._eyedropperCapture && !core.exports.color_picker_sampling()) document._eyedropperCapture = null;
}

// Gives the core the capture's pixels around (x, y).
function giveLoupe(document, capture, x, y) {
  const { frame } = capture;
  const core = document._domCore;
  const samples = new Float32Array(LOUPE_SIDE * LOUPE_SIDE * 4);
  const [centreColumn, centreRow] = devicePixel(frame, x, y);
  const half = (LOUPE_SIDE - 1) / 2;
  for (let row = 0; row < LOUPE_SIDE; row++) {
    for (let column = 0; column < LOUPE_SIDE; column++) {
      const pixel = pixelAt(frame, centreColumn - half + column, centreRow - half + row);
      samples.set(pixel, (row * LOUPE_SIDE + column) * 4);
    }
  }
  const [pointer] = core.byteInput(new Uint8Array(samples.buffer));
  core.exports.color_picker_loupe_set(pointer, encodingHdr(frame) ? 1 : 0, x, y);
  core.throwIfError();
}

// The device pixel of frame `frame` at (x, y) in the viewport.
function devicePixel(frame, x, y) {
  return [
    Math.floor((x - (frame.region?.x ?? 0)) * frame.deviceScale),
    Math.floor((y - (frame.region?.y ?? 0)) * frame.deviceScale),
  ];
}

// The unpremultiplied [red, green, blue, alpha] of a device pixel, or
// transparent outside the frame.
function pixelAt(frame, column, row) {
  if (column < 0 || row < 0 || column >= frame.width || row >= frame.height) return [0, 0, 0, 0];
  const index = (row * frame.width + column) * 4;
  const alpha = frame.pixels[index + 3];
  const unpremultiply = frame.alphaMode === "premultiplied" && alpha > 0 ? alpha : 1;
  return [0, 1, 2].map((channel) => frame.pixels[index + channel] / unpremultiply).concat(alpha);
}

function encodingHdr(frame) {
  const { primaries, transferFunction } = frame.colorEncoding;
  if (primaries === "srgb" && transferFunction === "srgb") return false;
  if (primaries === "rec2020" && transferFunction === "linear") return true;
  throw new Error(`page eyedropper: no CSS space for the frame encoding ${primaries} ${transferFunction}`);
}

// The CSS colour of frame `frame` at (x, y) in the viewport.
function colourAt(frame, x, y) {
  const [column, row] = devicePixel(frame, x, y);
  if (column < 0 || row < 0 || column >= frame.width || row >= frame.height) {
    throw new RangeError(`page eyedropper: (${x}, ${y}) lies outside the frame of ${frame.width} x ${frame.height} device px`);
  }
  const [red, green, blue, alpha] = pixelAt(frame, column, row).map(round);
  const space = encodingHdr(frame) ? "rec2100-linear" : "srgb";
  return `color(${space} ${red} ${green} ${blue}${alpha < 1 ? ` / ${alpha}` : ""})`;
}

function round(value) {
  return Number(value.toFixed(6));
}

function describe(value) {
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") return "an object without open()";
  return `${typeof value} ${JSON.stringify(value)}`;
}
