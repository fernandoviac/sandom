// Puts a Sandom DOM into one place of its host (plans/PLAN-sandom-embedding.md):
// dom.attach(target, options) creates the render surface of the document,
// presents its frames there and binds the host's input to the document. The
// host keeps changing the document; the view renders each change.
//
// target { canvas }: an HTMLCanvasElement of the host page. The document's
// viewport is the canvas's layout box at the display's pixel density, and
// follows both. Frames are GPU textures of the runtime's device, presented
// without a readback. The canvas takes the document's full input: pointer,
// wheel, keys, composition, clipboard, focus, cursor and context menu.
//
// target { texture, width, height, host, project, unproject }: a surface of
// the host's own GPU scene. texture(frame) receives each new frame: its
// textureImage is a GPU texture of the runtime's device, which the host
// samples in place (copying it costs a copy per frame and gains nothing).
// width and height are the document's viewport in CSS pixels. With host
// (the element that receives the pointer and the keys) and project (a host
// event to a document point, or null for a miss), the host's input reaches
// the document; unproject maps a document point back for the caret and the
// IME window. view.resize(width, height, deviceScale) changes the viewport.
//
// target { frames: { width, height, deviceScale, format } }: frames for
// files (video, still images, captures). width and height are the viewport
// in CSS pixels; deviceScale is 1 without it. format "rgba8" (the default)
// gives 8-bit samples, which the encoders take; "float32" gives the working
// float samples of the high-precision target. view.frames({ from, to,
// frameRate }) renders the document at each frame time from `from` up to
// `to` (milliseconds) and yields each frame's pixels in order. It keeps
// three frames in GPU readback while it renders the next. The stream drives
// the document's time, so this target takes neither clock nor input.
//
// options:
//   clock       { now, requestFrame, cancelFrame } of a host that drives the
//               document's time; the real clock without it.
//   input       false keeps the canvas's input for the host. In a worker, the
//               port of bindWorkerInput (src/dom/worker-input.js), which also
//               carries the page canvas's size and density.
//   deviceScale a fixed pixel density instead of the display's.
//   schedule    "loop" (the default) renders a frame after each change of
//               the document, on the clock's frames. "host" renders only
//               when the host calls view.render(), which resolves after the
//               frame is presented: a host that renders frames of its own
//               time, such as a film player.
//   onInput     a function called after each input record reaches the
//               document, so a "host" schedule can render its response.
//
// A live view (canvas or texture) has render(): it renders and presents one
// frame now and resolves to it.
import { createCanvasPresenter } from "../canvas-presentation.js";
import { createTextureReader, TEXTURE_READS_IN_FLIGHT } from "../rasterize.js";
import { bindProjectedInput, layoutBoxSize, projectOntoRectangle } from "./projected-surface.js";
import { serveWorkerInput } from "./worker-input.js";
import { hasGraphicsDevice, useGraphicsDevice } from "../scene-renderer.js";
import { gpuPassTimingFeatures } from "../gpu-pass-timing.js";

const OPTION_NAMES = new Set(["clock", "input", "deviceScale", "schedule", "onInput"]);

// The schedule and the input callback of a live view.
function liveOptions({ schedule = "loop", onInput = null }) {
  if (schedule !== "loop" && schedule !== "host") {
    throw new TypeError(`attach schedule must be "loop" or "host"; it is ${JSON.stringify(schedule)}`);
  }
  if (onInput !== null && typeof onInput !== "function") {
    throw new TypeError(`attach onInput must be a function; it is ${onInput}`);
  }
  return { schedule, onInput };
}

// The surface's clock options. On a "host" schedule the host renders every
// frame (view.render), so a frame the surface requests after a change is the
// host's next frame: the request is inert.
function surfaceClock(clock, schedule) {
  const clockOptions = clock === null ? {} : { now: clock.now, requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame };
  return schedule === "host" ? { ...clockOptions, requestFrame: () => 0, cancelFrame: () => {} } : clockOptions;
}
const HostHTMLCanvasElement = globalThis.HTMLCanvasElement;
const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const HostMessagePort = globalThis.MessagePort;
// A dedicated worker: no window, a worker global scope.
const inWorker = typeof globalThis.WorkerGlobalScope === "function" && globalThis instanceof globalThis.WorkerGlobalScope;
// The host's WebGPU and error report, taken when this module loads: a
// page that a worker runs (prepareRenderInput) installs its own window on
// the worker's global later.
const hostGpu = globalThis.navigator?.gpu;
const hostReportError = globalThis.reportError;

// A worker renders on its own WebGPU device, the fastest path a worker has
// (the GPU thread costs a frame more). A device the host gave the runtime
// stays. Device errors and loss reach the worker's error event: otherwise
// they leave each later frame blank without a word.
async function useWorkerDevice(backend) {
  const runtime = backend.document._sandomSceneRendererRuntime ?? { hasGraphicsDevice, useGraphicsDevice };
  if (runtime.hasGraphicsDevice()) return;
  const adapter = await hostGpu?.requestAdapter();
  if (!adapter) {
    throw new Error("attach in a worker needs WebGPU: this worker has no WebGPU adapter");
  }
  const device = await adapter.requestDevice({ requiredFeatures: gpuPassTimingFeatures(adapter) });
  device.addEventListener("uncapturederror", (event) => {
    hostReportError(new Error(`Sandom worker device: ${event.error.constructor.name}: ${event.error.message}`));
  });
  device.lost.then((information) => {
    if (information.reason !== "destroyed") {
      hostReportError(new Error(`Sandom worker device lost (${information.reason}): ${information.message}`));
    }
  });
  runtime.useGraphicsDevice(device);
}

export async function attachDocument(backend, target, options = {}) {
  if (target === null || typeof target !== "object") {
    throw new TypeError(`attach takes a target such as { canvas }; it received ${target}`);
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError(`attach options must be an object; it received ${options}`);
  }
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) {
      throw new TypeError(`attach has no option ${JSON.stringify(name)}; its options are ${[...OPTION_NAMES].join(", ")}`);
    }
  }
  if ("canvas" in target) {
    if (HostOffscreenCanvas !== undefined && target.canvas instanceof HostOffscreenCanvas) {
      return await attachOffscreenCanvas(backend, target.canvas, options, liveOptions(options));
    }
    return await attachCanvas(backend, target.canvas, options, liveOptions(options));
  }
  if ("texture" in target) return await attachTexture(backend, target, options, liveOptions(options));
  if ("frames" in target) return attachFrames(backend, target.frames, options);
  throw new TypeError(`attach takes a target with a canvas, a texture or frames; it received one with ${Object.keys(target).join(", ") || "no keys"}`);
}

const FRAME_FORMATS = new Set(["rgba8", "float32"]);

async function attachFrames(backend, frames, options) {
  if (frames === null || typeof frames !== "object") {
    throw new TypeError(`attach({ frames }) takes { width, height, deviceScale, format }; it received ${frames}`);
  }
  const { width, height, deviceScale = 1, format = "rgba8" } = frames;
  for (const [name, value] of [["width", width], ["height", height], ["deviceScale", deviceScale]]) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new TypeError(`attach({ frames }) ${name} must be a positive number of CSS pixels; it is ${value}`);
    }
  }
  if (!FRAME_FORMATS.has(format)) {
    throw new TypeError(`attach({ frames }) format must be "rgba8" or "float32"; it is ${JSON.stringify(format)}`);
  }
  for (const name of ["clock", "input", "deviceScale", "schedule", "onInput"]) {
    if (options[name] !== undefined) {
      throw new TypeError(
        `attach({ frames }) takes no ${name} option: the frame stream drives the document's time and has no input; give deviceScale in the frames target`,
      );
    }
  }
  const root = backend.document.documentElement;
  if (!root) {
    throw new Error("attach: the document has no root element; append an <html> element before attach");
  }
  // The frame stream drives the document's time. A document whose clock is
  // not fixed takes the stream's clock: the time of the frame that renders.
  // A document whose host injected its clock (prepareRenderInput,
  // createSandomDOM: now, requestFrame) keeps that clock, and each frame
  // advances it to the frame's time. A document on the host's real clock
  // has a time that no stream drives.
  const documentClock = backend.document._clock ?? null;
  if (documentClock?.real) {
    throw new TypeError(
      "attach({ frames }) drives the document's time, and this document runs on the host's real clock; " +
        "give the document a clock where it is created (prepareRenderInput or createSandomDOM: now, requestFrame, cancelFrame)",
    );
  }
  let timeMilliseconds = documentClock === null ? 0 : documentClock.now();
  const surface = backend.createRenderSurface(root, {
    viewportWidth: width,
    viewportHeight: height,
    deviceScale,
    ...(format === "rgba8" ? { renderPrecision: "rgba8unorm" } : {}),
    // The stream renders every frame itself (view.frames), so a frame the
    // surface requests after a change is the stream's next frame.
    ...(documentClock === null ? { now: () => timeMilliseconds, requestFrame: () => 0, cancelFrame: () => {} } : {}),
  });
  // The frame surface drives the document's injected clock and its page
  // timers, as the surface that a page's window binds to does.
  if (documentClock !== null) {
    const driver = backend.document._componentRenderSurface ?? null;
    if (driver !== null && driver !== surface) {
      await surface.shutdown();
      throw new Error("attach({ frames }) drives the document's time, and another live surface over the document drives it; shut that surface down first");
    }
    backend.document._componentRenderSurface = surface;
    backend.document._documentTimers?.driverChanged();
  }
  let reader = null;
  let streaming = false;
  let detached = false;
  async function* streamFrames({ from = 0, to, frameRate = 60 } = {}) {
    if (detached) throw new Error("attach({ frames }): the view is detached");
    if (streaming) throw new Error("attach({ frames }): view.frames() already streams; finish that stream first");
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) {
      throw new RangeError(`view.frames takes finite from < to in milliseconds; it received from ${from}, to ${to}`);
    }
    if (!(Number.isFinite(frameRate) && frameRate > 0)) {
      throw new RangeError(`view.frames frameRate must be a positive number of frames per second; it is ${frameRate}`);
    }
    if (documentClock !== null) timeMilliseconds = documentClock.now();
    if (from < timeMilliseconds) {
      throw new RangeError(`view.frames starts at ${from} ms, before the document's time ${timeMilliseconds} ms; a document's time only advances`);
    }
    streaming = true;
    const frameDuration = 1000 / frameRate;
    const pending = [];
    try {
      for (let sequence = 0; from + sequence * frameDuration < to; sequence++) {
        timeMilliseconds = from + sequence * frameDuration;
        const frame = await (documentClock === null ? surface.renderNow() : surface._renderAt(timeMilliseconds));
        if (!frame.textureImage) {
          throw new Error(`attach({ frames }) streams GPU texture frames; this surface renders on ${frame.graphicsBackend ?? "a backend"} without them`);
        }
        reader ??= createTextureReader(frame.device, { format });
        const timing = { sequence, timeMilliseconds, durationMilliseconds: frameDuration };
        pending.push(reader.read(frame.textureImage).then((pixels) => Object.freeze({ ...pixels, ...timing })));
        if (pending.length === TEXTURE_READS_IN_FLIGHT) yield await pending.shift();
      }
      while (pending.length) yield await pending.shift();
    } finally {
      // A consumer that stops early leaves reads in flight: each releases
      // its readback slot when it settles.
      await Promise.allSettled(pending);
      streaming = false;
    }
  }
  return Object.freeze({
    surface,
    root,
    get viewport() { return surface.viewport; },
    frames: streamFrames,
    async detach() {
      if (detached) return;
      detached = true;
      await surface.shutdown();
      await reader?.destroy();
    },
  });
}

// A canvas whose control the page transferred to this worker. The page's
// bindWorkerInput sends its size and density and its input through `input`.
async function attachOffscreenCanvas(backend, canvas, { clock = null, input = null, deviceScale = null }, { schedule, onInput }) {
  if (HostMessagePort === undefined || !(input instanceof HostMessagePort)) {
    throw new TypeError(
      "attach({ canvas }) with an OffscreenCanvas takes input: the port that bindWorkerInput returned on the page, which carries the canvas's size and input",
    );
  }
  if (deviceScale !== null) {
    throw new TypeError("attach({ canvas }) with an OffscreenCanvas takes its density from the page: give bindWorkerInput the deviceScale");
  }
  if (clock !== null && ["now", "requestFrame", "cancelFrame"].some((name) => typeof clock[name] !== "function")) {
    throw new TypeError("attach clock must have now, requestFrame and cancelFrame functions");
  }
  const root = backend.document.documentElement;
  if (!root) {
    throw new Error("attach: the document has no root element; append an <html> element before attach");
  }
  await useWorkerDevice(backend);
  let presenter = null;
  let presenterDevice = null;
  let surface = null;
  const connection = await serveWorkerInput(input, (size) => {
    surface = backend.createRenderSurface(root, {
      viewportWidth: size.width,
      viewportHeight: size.height,
      deviceScale: size.deviceScale,
      ...surfaceClock(clock, schedule),
      presentFrame(frame) {
        if (presenterDevice !== frame.device) {
          presenter?.destroy();
          presenter = createCanvasPresenter({ canvas, device: frame.device });
          presenterDevice = frame.device;
        }
        presenter.present(frame.textureImage);
      },
    });
    return { backend, root, surface };
  }, onInput);
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    connection.close();
    await surface.shutdown();
    presenter?.destroy();
  };
  try {
    await surface.renderNow();
    if (schedule === "loop") surface.start();
  } catch (error) {
    await detach();
    throw error;
  }
  return Object.freeze({
    surface,
    root,
    get viewport() { return surface.viewport; },
    render: () => surface.renderNow(),
    detach,
  });
}

async function attachCanvas(backend, canvas, { clock = null, input = true, deviceScale = null }, { schedule, onInput }) {
  if (HostHTMLCanvasElement === undefined || !(canvas instanceof HostHTMLCanvasElement)) {
    throw new TypeError(`attach({ canvas }) takes an HTMLCanvasElement of this realm; it received ${canvas}`);
  }
  if (!canvas.isConnected) {
    throw new Error("attach({ canvas }): insert the canvas into the page first; its layout box sets the document's viewport");
  }
  if (deviceScale !== null && !(deviceScale > 0)) {
    throw new RangeError(`attach deviceScale must be positive; it is ${deviceScale}`);
  }
  if (clock !== null && ["now", "requestFrame", "cancelFrame"].some((name) => typeof clock[name] !== "function")) {
    throw new TypeError("attach clock must have now, requestFrame and cancelFrame functions");
  }
  const root = backend.document.documentElement;
  if (!root) {
    throw new Error("attach: the document has no root element; append an <html> element before attach");
  }
  const scale = () => deviceScale ?? globalThis.devicePixelRatio ?? 1;
  // The canvas's layout box in CSS pixels, which the document fills.
  const layoutSize = () => layoutBoxSize(canvas, "attach({ canvas })");
  let size = layoutSize();
  let density = scale();
  const sizeBacking = () => {
    canvas.width = Math.round(size.width * density);
    canvas.height = Math.round(size.height * density);
  };
  sizeBacking();

  let presenter = null;
  let presenterDevice = null;
  const surface = backend.createRenderSurface(root, {
    viewportWidth: size.width,
    viewportHeight: size.height,
    deviceScale: density,
    ...surfaceClock(clock, schedule),
    presentFrame(frame) {
      if (presenterDevice !== frame.device) {
        presenter?.destroy();
        presenter = createCanvasPresenter({ canvas, device: frame.device });
        presenterDevice = frame.device;
      }
      presenter.present(frame.textureImage);
    },
  });

  // The projection follows the viewport: a resize replaces it, and the
  // input binding reads the current one.
  let projection = projectOntoRectangle(canvas, size);
  const project = (event) => projection(event);
  const unproject = (point) => projection.unproject(point);

  // A size or density change resizes the viewport in place (the measured
  // fastest change: one surface, no rebuild).
  const resize = () => {
    const next = layoutSize();
    const nextDensity = scale();
    if (next.width === size.width && next.height === size.height && nextDensity === density) return;
    size = next;
    density = nextDensity;
    sizeBacking();
    projection = projectOntoRectangle(canvas, size);
    surface.viewport.resizeTo(size.width, size.height, density);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  // A display density change fires the query of the density it leaves.
  let densityQuery = null;
  const watchDensity = () => {
    densityQuery?.removeEventListener("change", onDensity);
    densityQuery = deviceScale === null && typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia(`(resolution: ${scale()}dppx)`)
      : null;
    densityQuery?.addEventListener("change", onDensity);
  };
  function onDensity() {
    resize();
    watchDensity();
  }
  watchDensity();

  let binding = null;
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    binding?.dispose();
    resizeObserver.disconnect();
    densityQuery?.removeEventListener("change", onDensity);
    await surface.shutdown();
    presenter?.destroy();
  };
  try {
    // The input binding hit-tests the presented frame: it binds after the
    // first one.
    await surface.renderNow();
    if (input !== false) {
      binding = bindProjectedInput({
        host: canvas,
        backend,
        root,
        project,
        unproject,
        label: "Sandom document",
        ...(onInput === null ? {} : { onInput }),
      });
    }
    if (schedule === "loop") surface.start();
  } catch (error) {
    await detach();
    throw error;
  }
  return Object.freeze({
    surface,
    root,
    get viewport() { return surface.viewport; },
    render: () => surface.renderNow(),
    detach,
  });
}

async function attachTexture(backend, target, { clock = null, input = true, deviceScale = null }, { schedule, onInput }) {
  const { texture, width, height, host = null, project = null, unproject = null } = target;
  if (typeof texture !== "function") {
    throw new TypeError(`attach({ texture }) takes a function that receives each frame; it received ${texture}`);
  }
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError(`attach({ texture }) needs the document's width and height in CSS pixels; it received ${width} x ${height}`);
  }
  if (deviceScale !== null && !(deviceScale > 0)) {
    throw new RangeError(`attach deviceScale must be positive; it is ${deviceScale}`);
  }
  if (clock !== null && ["now", "requestFrame", "cancelFrame"].some((name) => typeof clock[name] !== "function")) {
    throw new TypeError("attach clock must have now, requestFrame and cancelFrame functions");
  }
  if (input !== false && (host === null) !== (project === null)) {
    throw new TypeError("attach({ texture }) binds input with both host and project; give both, or input: false");
  }
  const root = backend.document.documentElement;
  if (!root) {
    throw new Error("attach: the document has no root element; append an <html> element before attach");
  }
  if (inWorker) await useWorkerDevice(backend);
  const surface = backend.createRenderSurface(root, {
    viewportWidth: width,
    viewportHeight: height,
    deviceScale: deviceScale ?? 1,
    ...surfaceClock(clock, schedule),
    presentFrame: (frame) => texture(frame),
  });
  let binding = null;
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    binding?.dispose();
    await surface.shutdown();
  };
  try {
    await surface.renderNow();
    if (input !== false && host !== null) {
      binding = bindProjectedInput({
        host, backend, root, project, unproject, label: "Sandom document",
        ...(onInput === null ? {} : { onInput }),
      });
    }
    if (schedule === "loop") surface.start();
  } catch (error) {
    await detach();
    throw error;
  }
  return Object.freeze({
    surface,
    root,
    get viewport() { return surface.viewport; },
    render: () => surface.renderNow(),
    resize(nextWidth, nextHeight, nextDeviceScale = surface.viewport.deviceScale) {
      surface.viewport.resizeTo(nextWidth, nextHeight, nextDeviceScale);
    },
    detach,
  });
}
