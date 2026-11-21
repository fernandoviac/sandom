import { SandomHostError, validateSandomHost } from "../host/contract.js";
import { createDocumentResourceLoader } from "./document-resources.js";
import { validateClosedRecord } from "../closed-record.js";
import { createGifRecorder } from "../output/gif.js";
import { encodeImage, validateOutputRequest } from "../output/image.js";
import { generateAdaptiveImage } from "../output/gain-map.js";
import { encodeGainMapJpegPackage } from "../output/jpeg-gain-map.js";
import {
  createModuleExecutor,
  createPreprocessorRegistry,
  selectPreprocessor,
} from "./input-preprocessors.js";
import { createRenderSurface } from "./render-surface.js";
import { documentClockFromOptions } from "./document-clock.js";
import { assertScrollbarStyle } from "./scrollbar-visibility.js";
import { SDDocument } from "./node.js";
import { serializeToScene } from "./serialize.js";
import { nodeMember } from "./node-members.js";

import { createLayoutArtifact, createPaintRecord } from "../scene-renderer.js";
import { createPreparedDocument } from "./prepared-document.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { createSandomDOM } from "./sandom-dom.js";

const numberOrNaN = (value) => typeof value === "number" ? value : NaN;
// The render request, plan request and frame metadata outputs of the
// output-render watparts, by WAT name.
const OUTPUT_RENDER_REQUEST = Object.freeze(Object.fromEntries(["SIZE", "HIGH_DYNAMIC_RANGE", "GIF_WIDTH", "GIF_HEIGHT"]
  .map((name) => [name, layoutConstant(`OUTPUT_RENDER_REQUEST_${name}`)])));
const OUTPUT_PLAN_REQUEST = Object.freeze(Object.fromEntries(["SIZE", "LOOP_COUNT"]
  .map((name) => [name, layoutConstant(`OUTPUT_PLAN_REQUEST_${name}`)])));
const OUTPUT_FRAME_METADATA = Object.freeze(Object.fromEntries(["SIZE", "SEQUENCE", "DURATION"]
  .map((name) => [name, layoutConstant(`OUTPUT_FRAME_METADATA_${name}`)])));
// The codes of the output watparts: formats (output-plan.watpart),
// preprocessor choices (output-render-input.watpart) and inspection checks
// (output-inspection.watpart).
const OUTPUT_CODE = Object.freeze(Object.fromEntries([
  "PLAN_FORMAT_PNG", "PLAN_FORMAT_GIF", "PLAN_FORMAT_JPEG_XL", "PLAN_FORMAT_JPEG_GAIN_MAP",
  "PREPROCESSOR_EXPLICIT", "PREPROCESSOR_BY_MEDIA_TYPE", "PREPROCESSOR_BY_EXTENSION",
  "INSPECTION_CHECK_VIEWPORT", "INSPECTION_CHECK_MODE", "INSPECTION_CHECK_ANIMATION",
  "INSPECTION_ANALYTICAL_LAYOUT", "INSPECTION_HIGH_DYNAMIC_RANGE", "INSPECTION_TEXT_OPERATION",
].map((name) => [name, layoutConstant(`OUTPUT_${name}`)])));

// The inspection node records of output-inspection.watpart and
// frame-inspection.watpart, by WAT name.
const INSPECTION = Object.freeze(Object.fromEntries([
  "NODE_SIZE", "NODE_PARENT", "NODE_FLAGS", "NODE_DECLARED_WIDTH", "NODE_DECLARED_HEIGHT", "SOURCE_MASK",
  "BACKGROUND", "TEXT", "KIND_SHIFT", "KIND_MASK",
].map((name) => [name, layoutConstant(`INSPECTION_${name}`)])));
const FRAME_INSPECTION = Object.freeze(Object.fromEntries([
  "NODE_SIZE", "NODE_PARENT", "NODE_FLAGS", "NODE_DECLARED_WIDTH", "NODE_DECLARED_HEIGHT", "NODE_X", "NODE_Y",
  "NODE_WIDTH", "NODE_HEIGHT", "NODE_SCROLL_WIDTH", "NODE_SCROLL_HEIGHT", "NODE_INTRINSIC_WIDTH",
  "NODE_INTRINSIC_HEIGHT", "NODE_RESULT", "DOCUMENT_ROOT", "PARTICIPATES", "INTRINSIC", "VIEWPORT_BACKGROUND",
  "AGGREGATE_SCROLL_WIDTH",
  "AGGREGATE_SCROLL_HEIGHT", "AGGREGATE_OVERFLOW_LEFT", "AGGREGATE_OVERFLOW_TOP", "AGGREGATE_OVERFLOW_RIGHT",
  "AGGREGATE_OVERFLOW_BOTTOM",
].map((name) => [name, layoutConstant(`FRAME_INSPECTION_${name}`)])));

const REC2100_PQ_OUTPUT_ENCODING = Object.freeze({
  primaries: "rec2020",
  transferFunction: "pq",
  transferFunctionParameters: null,
  whitePoint: "d65",
  referenceWhiteLuminance: 203,
  profile: null,
});

const PNG_OUTPUT_REQUEST = Object.freeze({ format: "png" });
const JPEG_XL_OUTPUT_REQUEST = Object.freeze({
  format: "jpeg-xl",
  colorEncoding: REC2100_PQ_OUTPUT_ENCODING,
  dynamicRange: "high",
  bitDepth: "float16",
  masteringDisplay: Object.freeze({
    maxLuminance: 1000,
    minLuminance: 0.005,
  }),
});

const ADAPTIVE_OUTPUT_REQUEST = Object.freeze({
  format: "jpeg-gain-map",
  colorEncoding: Object.freeze({
    primaries: "srgb",
    transferFunction: "srgb",
    transferFunctionParameters: null,
    whitePoint: "d65",
    referenceWhiteLuminance: 203,
    profile: null,
  }),
  dynamicRange: "adaptive",
  bitDepth: 8,
  alphaMode: "straight",
  toneMap: "bt2390",
  targetPeakLuminance: 203,
  masteringDisplay: Object.freeze({
    maxLuminance: 1000,
    minLuminance: 0.005,
  }),
});

// The SHA-256 digest text of the bytes (output_input_digest).
function digest(bytes) {
  sharedDomCore.status("output_input_digest", ...sharedDomCore.byteInput(bytes));
  return sharedDomCore.outputString("output_input_digest");
}
// Each prepared input's lifecycle record (output-render-input.watpart).
const preparedInputStates = new WeakMap();

function preparedInputState(preparedInput) {
  const state = preparedInputStates.get(preparedInput);
  if (!state) {
    throw new TypeError("operation requires a prepared render input");
  }
  return state;
}

async function performPreparedOperation(preparedInput, operation) {
  const state = preparedInputState(preparedInput);
  sharedDomCore.statusRaw("output_prepared_input_begin", state.handle);
  try {
    return await operation(state);
  } finally {
    sharedDomCore.status("output_prepared_input_end", state.handle);
  }
}

function frameMetadata(frame) {
  const hasSequence = frame.sequence !== null && frame.sequence !== undefined;
  const hasDuration = frame.durationMilliseconds !== null && frame.durationMilliseconds !== undefined;
  sharedDomCore.status("output_frame_metadata", hasSequence ? 1 : 0, hasSequence ? Number(frame.sequence) : NaN,
    Number(frame.frameSequence), hasDuration ? 1 : 0, hasDuration ? Number(frame.durationMilliseconds) : NaN);
  const output = sharedDomCore.output("output_frame_metadata");
  const sequence = output.getFloat64(OUTPUT_FRAME_METADATA.SEQUENCE, true);
  const durationMilliseconds = output.getFloat64(OUTPUT_FRAME_METADATA.DURATION, true);
  return Object.freeze({
    sequence: hasSequence ? frame.sequence : sequence,
    timeMilliseconds: frame.timeMilliseconds,
    durationMilliseconds: hasDuration ? frame.durationMilliseconds : durationMilliseconds,
    dirtyRectangles: frame.dirtyRectangles,
    readbackByteLength: frame.readbackByteLength,
  });
}

export async function renderDocumentAnimation(document, options = {}) {
  const {
    format = "gif",
    width = 1280,
    height = 720,
    deviceScale = 1,
    frameBudget,
    durationMilliseconds,
    loopCount = 0,
    adaptiveCodecOptions = {},
    graphicsBackend = "auto",
    scrollbarStyle = "overlay",
  } = options;
  assertScrollbarStyle(scrollbarStyle, "render options");
  const core = sharedDomCore;
  const formatIndex = core.statusRaw("output_render_request",
    ...core.input(typeof format === "string" ? format : ""), ...core.input(String(JSON.stringify(format))),
    numberOrNaN(width), numberOrNaN(height), numberOrNaN(deviceScale), numberOrNaN(frameBudget));
  const checked = core.output("output_render_request");
  const highDynamicRangeStillOutput = checked.getUint32(OUTPUT_RENDER_REQUEST.HIGH_DYNAMIC_RANGE, true) !== 0;
  const gifWidth = checked.getUint32(OUTPUT_RENDER_REQUEST.GIF_WIDTH, true);
  const gifHeight = checked.getUint32(OUTPUT_RENDER_REQUEST.GIF_HEIGHT, true);
  if (!(document instanceof SDDocument)) {
    throw new TypeError("renderDocumentAnimation requires an SDDocument");
  }
  if (!document.documentElement) {
    throw new Error("The preprocessor did not populate a document element");
  }

  await document._readyForRendering();
  const surface = createRenderSurface(document.documentElement, {
    viewportWidth: width,
    viewportHeight: height,
    deviceScale,
    renderMode: highDynamicRangeStillOutput ? "high-dynamic-range" : undefined,
    renderPrecision: highDynamicRangeStillOutput ? "rgba16float" : undefined,
    graphicsBackend,
    scrollbarStyle,
  });
  try {
    // A one-shot render runs no loop: a loop frame on the real clock could
    // otherwise race the explicit render.
    surface.stop();
    const initialFrame = await surface.renderNow({ pixels: true });
    if (formatIndex !== OUTPUT_CODE.PLAN_FORMAT_GIF) {
      const frame = frameMetadata(initialFrame);
      const descriptor = {
        pixels: initialFrame.pixels,
        width: initialFrame.width,
        height: initialFrame.height,
        rowStride: initialFrame.rowStride,
        channelLayout: initialFrame.channelLayout,
        sampleType: initialFrame.sampleType,
        bitsPerSample: initialFrame.bitsPerSample,
        colorEncoding: initialFrame.colorEncoding,
        alphaMode: initialFrame.alphaMode,
        metadata: initialFrame.metadata,
      };
      let bytes;
      let outputFacts;
      if (formatIndex === OUTPUT_CODE.PLAN_FORMAT_PNG) {
        bytes = await encodeImage(descriptor, PNG_OUTPUT_REQUEST, {
          encodePngOutput: document._sandomSceneRendererRuntime?.codecRuntime
            ?.encodePngOutput,
        });
      } else if (formatIndex === OUTPUT_CODE.PLAN_FORMAT_JPEG_XL) {
        bytes = await encodeImage(descriptor, JPEG_XL_OUTPUT_REQUEST, {
          renderPrecision: "rgba16float",
        });
      } else {
        const request = validateOutputRequest({
          ...ADAPTIVE_OUTPUT_REQUEST,
          codecOptions: adaptiveCodecOptions,
        }, { renderPrecision: "rgba16float" });
        const encoded = await encodeGainMapJpegPackage(
          generateAdaptiveImage(descriptor, request),
        );
        bytes = encoded.bytes;
        outputFacts = encoded.facts;
      }
      return Object.freeze({
        bytes,
        ...(formatIndex === OUTPUT_CODE.PLAN_FORMAT_PNG ? { png: bytes } : {}),
        ...(outputFacts === undefined ? {} : { outputFacts }),
        pixels: new Float32Array(initialFrame.pixels),
        rowStride: initialFrame.rowStride,
        channelLayout: initialFrame.channelLayout,
        sampleType: initialFrame.sampleType,
        bitsPerSample: initialFrame.bitsPerSample,
        colorEncoding: initialFrame.colorEncoding,
        alphaMode: initialFrame.alphaMode,
        metadata: initialFrame.metadata,
        format,
        width: initialFrame.width,
        height: initialFrame.height,
        deviceScale: initialFrame.deviceScale,
        graphicsBackend: initialFrame.graphicsBackend,
        graphicsBackendInfo: initialFrame.graphicsBackendInfo,
        scrollbarStyle: surface.scrollbarStyle,
        dirtyRectangles: initialFrame.dirtyRectangles,
        readbackByteLength: initialFrame.readbackByteLength,
        frameSequence: initialFrame.frameSequence,
        scrollbars: initialFrame.scrollbars,
        timeMilliseconds: initialFrame.timeMilliseconds,
        durationMilliseconds: 0,
        frameCount: 1,
        frames: Object.freeze([frame]),
      });
    }

    const recorder = createGifRecorder({
      width: gifWidth,
      height: gifHeight,
      loopCount,
    });
    const frames = [];
    for await (
      const frame of surface.captureFrames({
        frameBudget,
        durationMilliseconds,
      })
    ) {
      recorder.addFrame({
        pixels: frame.pixels,
        candidateRectangles: frame.dirtyRectangles,
        durationMilliseconds: frame.durationMilliseconds,
      });
      frames.push(frameMetadata(frame));
    }
    const bytes = recorder.finish();
    return Object.freeze({
      bytes,
      format: "gif",
      width: gifWidth,
      height: gifHeight,
      graphicsBackend: initialFrame.graphicsBackend,
      graphicsBackendInfo: initialFrame.graphicsBackendInfo,
      scrollbarStyle: surface.scrollbarStyle,
      durationMilliseconds: durationMilliseconds ?? gifDuration(frames),
      frameCount: frames.length,
      fullReadbackByteLength: initialFrame.readbackByteLength,
      frames: Object.freeze(frames),
    });
  } finally {
    await surface.shutdown();
  }
}

// The sum of captured frame durations (output_gif_duration).
function gifDuration(frames) {
  const durations = new Float64Array(frames.map((frame) => frame.durationMilliseconds));
  const [pointer] = sharedDomCore.byteInput(new Uint8Array(durations.buffer));
  return sharedDomCore.exports.output_gif_duration(pointer, durations.length);
}

// The preprocessor of a primary input (output_preprocessor_choice): a
// network input that the host fetched selects by response media type;
// supplied bytes select by their media type when one is given, and
// otherwise by the URL path extension, as a file input does.
function selectInputPreprocessor(registry, inputURL, mediaType, explicitName, fetched) {
  const explicit = explicitName !== undefined && explicitName !== null;
  const choice = sharedDomCore.status("output_preprocessor_choice", explicit ? 1 : 0, fetched ? 1 : 0,
    ...sharedDomCore.input(inputURL.protocol), mediaType === null ? 0 : 1,
    ...sharedDomCore.input(typeof mediaType === "string" ? mediaType : ""),
    ...sharedDomCore.input(String(JSON.stringify(mediaType))), ...sharedDomCore.input(inputURL.href));
  if (choice === OUTPUT_CODE.PREPROCESSOR_EXPLICIT) return selectPreprocessor(registry, inputURL, explicitName);
  if (choice === OUTPUT_CODE.PREPROCESSOR_BY_MEDIA_TYPE) {
    return selectPreprocessor(registry, inputURL, sharedDomCore.outputString("output_preprocessor_choice"));
  }
  if (choice === OUTPUT_CODE.PREPROCESSOR_BY_EXTENSION) return selectPreprocessor(registry, inputURL, undefined);
  throw new SandomHostError("response-media-type", sharedDomCore.outputString("output_preprocessor_choice"), { details: { mediaType } });
}

// Obtains the primary input through the host as a document demand. The
// demand's client is the input itself, as a top-level navigation is.
async function requestPrimaryInput(host, inputURL) {
  const loader = createDocumentResourceLoader({ host, documentURL: inputURL.href });
  try {
    const resource = await loader.resolveResource({
      requestedURL: inputURL.href,
      kind: "document",
    });
    return resource;
  } finally {
    await loader.release();
  }
}

// `now`, `requestFrame`, `cancelFrame` and `timeOrigin` are the document's
// clock (src/dom/document-clock.js), as for renderComponent; the host's
// real clock when omitted. Every surface over the document runs on it.
// Pass `timeOrigin` with `now`: it is the page's date at time 0, and
// without it the page's `Date` starts at the Unix epoch; page scripts may
// need the current date.
const PREPARATION_OPTION_NAMES = new Set([
  "preprocessors",
  "preprocessor",
  "host",
  "now",
  "requestFrame",
  "cancelFrame",
  "timeOrigin",
]);

export async function prepareRenderInput(input, options = {}) {
  validateClosedRecord(options, PREPARATION_OPTION_NAMES, "prepareRenderInput options");
  const {
    preprocessors = [],
    preprocessor: explicitPreprocessor,
    host,
  } = options;
  validateSandomHost(host, "prepareRenderInput");
  const clock = documentClockFromOptions(options, "prepareRenderInput options");
  let requestedURL;
  let inputURL;
  let inputBytes;
  let mediaType = null;
  let inputDigest;
  let provenance;
  if (input instanceof URL || typeof input === "string") {
    requestedURL = new URL(input);
    const resource = await requestPrimaryInput(host, requestedURL);
    inputURL = new URL(resource.finalURL);
    inputBytes = resource.bytes;
    mediaType = resource.mediaType;
    inputDigest = resource.digest;
    provenance = resource.provenance;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    requestedURL = new URL(input.url);
    if (input.bytes === undefined) {
      const resource = await requestPrimaryInput(host, requestedURL);
      inputURL = new URL(resource.finalURL);
      inputBytes = resource.bytes;
      mediaType = resource.mediaType;
      inputDigest = resource.digest;
      provenance = resource.provenance;
    } else {
      inputURL = requestedURL;
      inputBytes = input.bytes;
      if (input.mediaType !== undefined && input.mediaType !== null) {
        mediaType = String(input.mediaType);
      }
      provenance = Object.freeze({ backend: "supplied-input" });
    }
  } else {
    throw new TypeError(
      "input must be a URL, absolute URL string, or { url, bytes } object",
    );
  }
  if (!(inputBytes instanceof Uint8Array)) {
    throw new TypeError("input.bytes must be a Uint8Array");
  }

  const registry = createPreprocessorRegistry(preprocessors);
  const selectedPreprocessor = selectInputPreprocessor(
    registry,
    inputURL,
    mediaType,
    explicitPreprocessor,
    input.bytes === undefined,
  );
  const preparedDocument = await createPreparedDocument({
    url: inputURL,
    host,
    clock,
  });
  const {
    document,
    window,
    resolveResource,
  } = preparedDocument;
  const normalizedInput = Object.freeze({ url: inputURL, bytes: inputBytes });
  let inputRecord;
  try {
    const preparationResult = await selectedPreprocessor.prepare(Object.freeze({
      input: normalizedInput,
      document,
      window,
      executeModule: createModuleExecutor(document, window),
      resolveResource,
    }));
    if (preparationResult !== undefined) {
      throw new TypeError(
        `Preprocessor ${
          JSON.stringify(selectedPreprocessor.name)
        } must not return a value`,
      );
    }
    await document._readyForRendering();
    // The prepared input is the loaded document: each image's load or
    // error event has run, as the window load event waits for them.
    await document._imagesLoaded();
    inputRecord = Object.freeze({
      url: requestedURL.href,
      finalURL: inputURL.href,
      mediaType,
      byteLength: inputBytes.byteLength,
      digest: inputDigest ?? await digest(inputBytes),
      preprocessor: selectedPreprocessor.name,
      provenance,
      backend: host.backend,
    });
  } catch (preparationError) {
    try {
      await preparedDocument.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [
          preparationError,
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        ],
        "Prepared input setup and resource release failed",
      );
    }
    throw preparationError;
  }

  const state = {
    handle: sharedDomCore.exports.output_prepared_input_create(),
    preparedDocument,
    resourceRecords: () => preparedDocument.resources,
    diagnosticRecords: () => preparedDocument.diagnostics,
  };
  const preparedInput = Object.freeze({
    document,
    input: inputRecord,
    // The source document, the source of each document log's load entry.
    sourceBytes: inputBytes,
    get resources() {
      return preparedDocument.resources;
    },
    get diagnostics() {
      return preparedDocument.diagnostics;
    },
    async release() {
      if (sharedDomCore.statusRaw("output_prepared_input_release", state.handle) === 0) return;
      state.handle = 0n;
      await state.preparedDocument.release();
    },
  });
  preparedInputStates.set(preparedInput, state);
  return preparedInput;
}

function renderRequestFromPlan(plan) {
  const core = sharedDomCore;
  const graphicsBackend = plan.graphicsBackend ?? "auto";
  core.statusRaw("output_render_plan_backend", numberOrNaN(plan.version), ...core.input(String(plan.version)),
    ...core.input(typeof graphicsBackend === "string" ? graphicsBackend : ""));
  const scrollbarStyle = assertScrollbarStyle(
    plan.scrollbarStyle ?? "overlay",
    "render plan",
  );
  const format = plan.output?.format;
  const width = plan.viewport?.width;
  const height = plan.viewport?.height;
  const deviceScale = plan.viewport?.deviceScale;
  const durationMilliseconds = plan.capture?.durationMilliseconds;
  const frameBudget = plan.capture?.sampling?.recommendedFrameBudget;
  const repetition = plan.capture?.repetition;
  const formatIndex = core.statusRaw("output_render_plan_request",
    ...core.input(typeof format === "string" ? format : ""),
    numberOrNaN(width), numberOrNaN(height), numberOrNaN(deviceScale), plan.capture?.kind === "still" ? 1 : 0,
    numberOrNaN(durationMilliseconds), numberOrNaN(frameBudget),
    ...core.input(typeof repetition?.kind === "string" ? repetition.kind : ""), numberOrNaN(repetition?.count));
  const request = { format, width, height, deviceScale, graphicsBackend, scrollbarStyle };
  if (formatIndex === OUTPUT_CODE.PLAN_FORMAT_JPEG_GAIN_MAP) return { ...request, adaptiveCodecOptions: plan.output.codecOptions ?? {} };
  if (formatIndex !== OUTPUT_CODE.PLAN_FORMAT_GIF) return request;
  const loopCount = core.output("output_render_plan_request").getUint32(OUTPUT_PLAN_REQUEST.LOOP_COUNT, true);
  return { ...request, durationMilliseconds, frameBudget, loopCount };
}

export async function renderPreparedInput(preparedInput, renderRequest = {}) {
  const plan = renderRequest?.kind === "render-plan" ? renderRequest : null;
  const exactRequest = plan === null
    ? renderRequest
    : renderRequestFromPlan(plan);
  return await performPreparedOperation(preparedInput, async (state) => {
    const rendered = await renderDocumentAnimation(
      preparedInput.document,
      {
        ...exactRequest,
      },
    );
    return Object.freeze({
      ...rendered,
      ...(plan === null ? {} : { plan }),
      input: preparedInput.input,
      resources: state.resourceRecords(),
      diagnostics: state.diagnosticRecords(),
    });
  });
}

export async function startPreparedRenderSurface(preparedInput, options = {}) {
  const state = preparedInputState(preparedInput);
  sharedDomCore.statusRaw("output_prepared_input_begin", state.handle);
  let surface;
  try {
    surface = createRenderSurface(preparedInput.document.documentElement, {
      ...options,
    });
    await surface.renderNow();
    surface.start();
  } catch (error) {
    if (surface) await surface.shutdown();
    sharedDomCore.status("output_prepared_input_end", state.handle);
    throw error;
  }
  let released = false;
  return Object.freeze({
    surface,
    async release() {
      if (released) return;
      released = true;
      try {
        await surface.shutdown();
      } finally {
        sharedDomCore.status("output_prepared_input_end", state.handle);
      }
    },
  });
}

// Attaches a prepared input's document (prepareRenderInput) to `target`,
// as dom.attach does (src/dom/attach.js). The prepared input stays in use
// until view.detach().
export async function attachPreparedInput(preparedInput, target, options = {}) {
  const state = preparedInputState(preparedInput);
  sharedDomCore.statusRaw("output_prepared_input_begin", state.handle);
  let view;
  try {
    view = await createSandomDOM({ document: preparedInput.document }).attach(target, options);
  } catch (error) {
    sharedDomCore.status("output_prepared_input_end", state.handle);
    throw error;
  }
  // The view, with a detach that also ends the prepared input's use.
  let detached = false;
  const descriptors = Object.getOwnPropertyDescriptors(view);
  descriptors.detach = {
    enumerable: true,
    value: async () => {
      if (detached) return;
      detached = true;
      try {
        await view.detach();
      } finally {
        sharedDomCore.status("output_prepared_input_end", state.handle);
      }
    },
  };
  return Object.freeze(Object.defineProperties({}, descriptors));
}

const SOURCE_KINDS = Object.freeze(["element", "text", "viewport", "generated"]);

// The inspection facts of each scene node (output_inspection_nodes of
// core/dom/output-inspection.watpart): parent, text, source kind, the
// frame inspection source flags and the declared size. styleSourceAt names
// where the style facts come from: the handle of a DOM-backed box's element
// (its scene node carries no style; the core reads the element's stored
// fields), a scene-written node's own fields, or null.
function inspectionNodes(sceneNodes, sourceNodeAt, styleSourceAt) {
  const core = sharedDomCore;
  const values = [];
  sceneNodes.forEach((sceneNode, sceneIndex) => {
    const sourceNode = sourceNodeAt(sceneIndex);
    const source = styleSourceAt(sceneIndex);
    const style = typeof source === "number" ? null : source;
    // A form's controls can shadow its members (form-dom.js, nodeMember).
    values.push(
      sceneNode.children, sceneNode.text, sourceNode ? nodeMember(sourceNode, "nodeType") : 0,
      typeof source === "number" ? source : 0,
      style?.bg !== undefined, style?.backgroundImages?.length, style?.width, style?.height,
      sceneNode.display, sourceNode ? nodeMember(sourceNode, "nodeName") : undefined, sceneNode.src,
    );
  });
  core.status("output_inspection_nodes", sceneNodes.length, ...core.valueListInput(values));
  const view = sceneNodes.length === 0 ? null : core.output("output_inspection_nodes");
  const optional = (number) => Number.isNaN(number) ? null : number;
  return sceneNodes.map((_, sceneIndex) => {
    const at = sceneIndex * INSPECTION.NODE_SIZE;
    const parentIndex = view.getInt32(at + INSPECTION.NODE_PARENT, true);
    const flags = view.getUint32(at + INSPECTION.NODE_FLAGS, true);
    return {
      parentIndex: parentIndex < 0 ? null : parentIndex,
      sourceFlags: flags & INSPECTION.SOURCE_MASK,
      hasText: (flags & INSPECTION.TEXT) !== 0,
      sourceKind: SOURCE_KINDS[(flags >> INSPECTION.KIND_SHIFT) & INSPECTION.KIND_MASK],
      hasBackground: (flags & INSPECTION.BACKGROUND) !== 0,
      declaredWidth: optional(view.getFloat64(at + INSPECTION.NODE_DECLARED_WIDTH, true)),
      declaredHeight: optional(view.getFloat64(at + INSPECTION.NODE_DECLARED_HEIGHT, true)),
    };
  });
}

// A scene node identifier (output_inspection_identifier).
function inspectionIdentifier(sceneIndex) {
  sharedDomCore.status("output_inspection_identifier", sceneIndex);
  return sharedDomCore.outputString("output_inspection_identifier");
}

// The device-pixel numbers of logical numbers (output_inspection_scale).
function devicePixelNumbers(numbers, deviceScale) {
  const core = sharedDomCore;
  const [pointer] = core.byteInput(new Uint8Array(numbers.buffer, numbers.byteOffset, numbers.byteLength));
  core.status("output_inspection_scale", pointer, numbers.length, deviceScale);
  const view = numbers.length === 0 ? null : core.output("output_inspection_scale");
  return Float64Array.from({ length: numbers.length },
    (_, index) => view.getFloat64(index * Float64Array.BYTES_PER_ELEMENT, true));
}

function immutableLayoutFacts(
  document,
  viewport,
  serialized,
  artifact,
  scrollbarStyle,
) {
  const elementsBySceneIndex = new Map();
  for (const [element, sceneIndex] of serialized.indexOf) {
    if (sceneIndex !== null) elementsBySceneIndex.set(sceneIndex, element);
  }
  const elementAt = (sceneIndex) => elementsBySceneIndex.get(sceneIndex) ?? null;
  const facts = inspectionNodes(serialized.nodes, elementAt, (sceneIndex) => {
    const sceneNode = serialized.nodes[sceneIndex];
    const element = elementAt(sceneIndex);
    return sceneNode._coreBox !== undefined && element !== null ? Number(element._coreHandle) : sceneNode;
  });
  const core = document._domCore;
  const documentElement = document.documentElement;
  const documentBody = document.body;
  const inspection = core.status(
    "frame_inspection_begin", serialized.nodes.length, viewport.width, viewport.height,
  );
  try {
  const input = core.status("frame_inspection_input", inspection);
  let view = new DataView(core.refreshBytes().buffer);
  for (let index = 0; index < serialized.nodes.length; index++) {
    const element = elementAt(index);
    const fact = facts[index];
    const box = artifact.boxes[index];
    const at = input + index * FRAME_INSPECTION.NODE_SIZE;
    const flags = fact.sourceFlags |
      (element === documentElement || element === documentBody ? FRAME_INSPECTION.DOCUMENT_ROOT : 0);
    if (view.buffer !== core.memory.buffer) view = new DataView(core.refreshBytes().buffer);
    view.setInt32(at + FRAME_INSPECTION.NODE_PARENT, fact.parentIndex ?? -1, true);
    view.setUint32(at + FRAME_INSPECTION.NODE_FLAGS, flags, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_DECLARED_WIDTH, fact.declaredWidth ?? NaN, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_DECLARED_HEIGHT, fact.declaredHeight ?? NaN, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_X, box?.borderBox.x ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_Y, box?.borderBox.y ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_WIDTH, box?.borderBox.width ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_HEIGHT, box?.borderBox.height ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_SCROLL_WIDTH, box?.scroll.width ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_SCROLL_HEIGHT, box?.scroll.height ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_INTRINSIC_WIDTH, box?.contentBox.width ?? 0, true);
    view.setFloat64(at + FRAME_INSPECTION.NODE_INTRINSIC_HEIGHT, box?.contentBox.height ?? 0, true);
  }
  // The host writes each record up to its result field.
  globalThis[Symbol.for("sandom.domCore.measurement")]?.record({
    category: "geometry", operation: "frame_inspection_input",
    direction: "host-to-core", bytes: serialized.nodes.length * FRAME_INSPECTION.NODE_RESULT,
  });
  core.status("frame_inspection_resolve", inspection);
  const aggregate = core.output("frame_inspection_resolve");
  view = new DataView(core.refreshBytes().buffer);
  const scrollWidth = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_SCROLL_WIDTH, true);
  const scrollHeight = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_SCROLL_HEIGHT, true);
  const overflowLeft = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_OVERFLOW_LEFT, true);
  const overflowTop = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_OVERFLOW_TOP, true);
  const overflowRight = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_OVERFLOW_RIGHT, true);
  const overflowBottom = aggregate.getFloat64(FRAME_INSPECTION.AGGREGATE_OVERFLOW_BOTTOM, true);
  const nodes = serialized.nodes.map((sceneNode, sceneIndex) => {
    const element = elementAt(sceneIndex);
    const box = artifact.boxes[sceneIndex];
    if (view.buffer !== core.memory.buffer) view = new DataView(core.refreshBytes().buffer);
    const at = input + sceneIndex * FRAME_INSPECTION.NODE_SIZE;
    const flags = view.getUint32(at + FRAME_INSPECTION.NODE_RESULT, true);
    const nodeScrollWidth = view.getFloat64(at + FRAME_INSPECTION.NODE_SCROLL_WIDTH, true);
    const nodeScrollHeight = view.getFloat64(at + FRAME_INSPECTION.NODE_SCROLL_HEIGHT, true);
    const participatesInLayout = (flags & FRAME_INSPECTION.PARTICIPATES) !== 0;
    const fact = facts[sceneIndex];
    return Object.freeze({
      nodeIndex: sceneIndex,
      parentIndex: fact.parentIndex,
      nodeName: element?.nodeName ?? null,
      id: element?.getAttribute?.("id") ?? null,
      display: sceneNode.display,
      participatesInLayout,
      hasText: fact.hasText,
      hasImage: sceneNode.src !== undefined,
      hasBackground: fact.hasBackground,
      children: Object.freeze([...(sceneNode.children ?? [])]),
      declaredWidth: fact.declaredWidth,
      declaredHeight: fact.declaredHeight,
      borderBox: participatesInLayout
        ? Object.freeze({ ...box.borderBox })
        : null,
      scroll: participatesInLayout
        ? Object.freeze(
            {
              left: box.scroll.left,
              top: box.scroll.top,
              width: nodeScrollWidth,
              height: nodeScrollHeight,
            },
          )
        : null,
      intrinsicDimensions: (flags & FRAME_INSPECTION.INTRINSIC) !== 0
        ? Object.freeze({
          width: box.contentBox.width,
          height: box.contentBox.height,
        })
        : null,
      viewportSizedBackground: (flags & FRAME_INSPECTION.VIEWPORT_BACKGROUND) !== 0,
    });
  });
  globalThis[Symbol.for("sandom.domCore.measurement")]?.record({
    category: "geometry", operation: "frame_inspection_resolve",
    direction: "core-to-host", bytes: serialized.nodes.length * 20 + 48,
  });
  return Object.freeze({
    kind: "layout-facts",
    version: 1,
    viewport: Object.freeze({ ...viewport }),
    scrollbarStyle,
    documentScrollBounds: Object.freeze({
      width: scrollWidth,
      height: scrollHeight,
    }),
    overflow: Object.freeze({
      left: overflowLeft,
      top: overflowTop,
      right: overflowRight,
      bottom: overflowBottom,
    }),
    nodes: Object.freeze(nodes),
    textLineBoxes: Object.freeze(
      artifact.lineBoxes.map((line) => Object.freeze({ ...line })),
    ),
    mediaQueries: Object.freeze({
      environment: Object.freeze({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
    }),
    containerQueries: Object.freeze({
      supported: false,
      states: Object.freeze([]),
    }),
    diagnostics: Object.freeze(
      [...document.styleSheets].flatMap((sheet) => sheet.diagnostics),
    ),
  });
  } finally {
    core.status("frame_inspection_dispose", inspection);
  }
}

// A layout inspection lays out a broken image as an image that paints
// nothing, as a render does. The DOM image loading fired its error event,
// and the render surface records its diagnostic. An invalid host response
// is a host defect and fails the inspection.
function brokenImageInLayout({ error }) {
  if (error.cause instanceof SandomHostError && error.cause.code === "invalid-host-response") {
    throw error.cause;
  }
}

export async function inspectDocumentLayout(
  renderRoot,
  viewport,
  {
    createArtifact = createLayoutArtifact,
    resolveResource = renderRoot.ownerDocument._resolveResource,
    scrollbarStyle = "overlay",
  } = {},
) {
  assertScrollbarStyle(scrollbarStyle, "layout inspection options");
  const document = renderRoot.ownerDocument;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const deviceScale = Number(viewport.deviceScale ?? 1);
  sharedDomCore.status("output_inspection_check", OUTPUT_CODE.INSPECTION_CHECK_VIEWPORT, width, height, deviceScale, ...sharedDomCore.valueListInput([]));
  const previousCallbackSuppression = document._suppressAuthoredCallbacks;
  const styleSystem = document._styleSystem;
  const previousEnvironment = { ...styleSystem.environment };
  document._suppressAuthoredCallbacks = true;
  let inspectionError = null;
  let layout;
  try {
    await document._readyForRendering();
    styleSystem.setEnvironment({
      viewportWidth: width,
      viewportHeight: height,
      scrollbarStyle,
    });
    await document._readyForRendering();
    const serialized = serializeToScene(renderRoot, {
      viewportWidth: width,
      viewportHeight: height,
    });
    const artifact = await createArtifact({
      width,
      height,
      nodes: serialized.nodes,
      generatedBoxRows: serialized.generatedBoxRows,
      imageSources: serialized.imageSources,
    }, {
      resolveResource,
      onImageLoadError: brokenImageInLayout,
    });
    layout = immutableLayoutFacts(
      document,
      { width, height, deviceScale },
      serialized,
      artifact,
      scrollbarStyle,
    );
  } catch (error) {
    inspectionError = error;
  }
  let restorationError = null;
  try {
    styleSystem.setEnvironment(previousEnvironment);
    await document._readyForRendering();
  } catch (error) {
    restorationError = error;
  } finally {
    document._suppressAuthoredCallbacks = previousCallbackSuppression;
  }
  if (inspectionError && restorationError) {
    throw new AggregateError(
      [inspectionError, restorationError],
      "Analytical inspection and environment restoration failed",
    );
  }
  if (inspectionError) throw inspectionError;
  if (restorationError) throw restorationError;
  return layout;
}

// The paint artifact of `renderRoot` at `viewport` without a raster target:
// the scene serializes as a render surface serializes it (with the viewport
// row), and the renderer emits its commands and captures the paint record
// (createPaintRecord). No GPU submission, readback or encoding takes part.
// Returns the paint artifact and the source node of each scene row.
export async function inspectDocumentPaint(
  renderRoot,
  viewport,
  {
    createRecord = createPaintRecord,
    resolveResource = renderRoot.ownerDocument._resolveResource,
    scrollbarStyle = "overlay",
  } = {},
) {
  assertScrollbarStyle(scrollbarStyle, "paint inspection options");
  const document = renderRoot.ownerDocument;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const deviceScale = Number(viewport.deviceScale ?? 1);
  sharedDomCore.status("output_inspection_check", OUTPUT_CODE.INSPECTION_CHECK_VIEWPORT, width, height, deviceScale, ...sharedDomCore.valueListInput([]));
  const previousCallbackSuppression = document._suppressAuthoredCallbacks;
  const styleSystem = document._styleSystem;
  const previousEnvironment = { ...styleSystem.environment };
  document._suppressAuthoredCallbacks = true;
  let inspectionError = null;
  let inspection;
  try {
    await document._readyForRendering();
    styleSystem.setEnvironment({
      viewportWidth: width,
      viewportHeight: height,
      scrollbarStyle,
    });
    await document._readyForRendering();
    const serialized = serializeToScene(renderRoot, {
      viewportWidth: width,
      viewportHeight: height,
      viewport: { width, height, deviceScale, _requestedLeft: 0, _requestedTop: 0 },
    });
    const { paintArtifact } = await createRecord({
      width,
      height,
      nodes: serialized.nodes,
      generatedBoxRows: serialized.generatedBoxRows,
      imageSources: serialized.imageSources,
    }, {
      resolveResource,
      onImageLoadError: brokenImageInLayout,
    });
    const elementAtIndex = new Array(serialized.nodes.length).fill(null);
    for (const [node, index] of serialized.indexOf) if (index !== null) elementAtIndex[index] = node;
    inspection = Object.freeze({ paintArtifact, elementAtIndex: Object.freeze(elementAtIndex) });
  } catch (error) {
    inspectionError = error;
  }
  let restorationError = null;
  try {
    styleSystem.setEnvironment(previousEnvironment);
    await document._readyForRendering();
  } catch (error) {
    restorationError = error;
  } finally {
    document._suppressAuthoredCallbacks = previousCallbackSuppression;
  }
  if (inspectionError && restorationError) {
    throw new AggregateError(
      [inspectionError, restorationError],
      "Paint inspection and environment restoration failed",
    );
  }
  if (inspectionError) throw inspectionError;
  if (restorationError) throw restorationError;
  return inspection;
}

export async function inspectPreparedInput(
  preparedInput,
  request = {},
  inspectionDependencies = {},
) {
  return await performPreparedOperation(preparedInput, async (state) => {
    const {
      createSurface = createRenderSurface,
      createArtifact = createLayoutArtifact,
    } = inspectionDependencies;
    const {
      mode = "observed",
      viewport = {},
      scrollbarStyle = "overlay",
    } = request;
    assertScrollbarStyle(scrollbarStyle, "inspection request");
    const modeIndex = sharedDomCore.status("output_inspection_check", OUTPUT_CODE.INSPECTION_CHECK_MODE, NaN, NaN, NaN,
      ...sharedDomCore.valueListInput([mode]));
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    const deviceScale = Number(viewport.deviceScale ?? 1);
    sharedDomCore.status("output_inspection_check", OUTPUT_CODE.INSPECTION_CHECK_VIEWPORT, width, height, deviceScale, ...sharedDomCore.valueListInput([]));
    const document = preparedInput.document;

    if (modeIndex === OUTPUT_CODE.INSPECTION_ANALYTICAL_LAYOUT) {
      const layout = await inspectDocumentLayout(
        document.documentElement,
        { width, height, deviceScale },
        {
          createArtifact,
          scrollbarStyle,
        },
      );
      return Object.freeze({
        kind: "prepared-render-inspection",
        version: 1,
        mode,
        scrollbarStyle,
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        layout,
        motion: null,
      });
    }

    await document._readyForRendering();

    // The inspection renders once at time 0 (prepareNow) on the document's
    // clock, and never runs a frame: the surface stops before it prepares.
    const surface = createSurface(document.documentElement, {
      viewportWidth: width,
      viewportHeight: height,
      deviceScale,
      initializePersistentRenderer: false,
      scrollbarStyle,
    });
    try {
      surface.stop();
      const preparedState = await surface.prepareNow();
      const artifact = await createArtifact(
        preparedState.scene,
        { resolveResource: document._resolveResource, onImageLoadError: brokenImageInLayout },
      );
      const motion = surface.inspectMotion();
      return Object.freeze({
        kind: "prepared-render-inspection",
        version: 1,
        mode,
        scrollbarStyle,
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        layout: immutableLayoutFacts(
          document,
          { width, height, deviceScale },
          preparedState.serialized,
          artifact,
          scrollbarStyle,
        ),
        motion: Object.freeze({
          kind: "motion-facts",
          version: 1,
          ...motion,
        }),
      });
    } finally {
      await surface.shutdown();
    }
  });
}

// Inspection rectangles of logical rectangles: each with its device-pixel
// rectangle (output_inspection_scale), in order.
function inspectionRectangles(logicalRectangles, deviceScale) {
  const numbers = new Float64Array(logicalRectangles.length * 4);
  logicalRectangles.forEach((rectangle, index) => {
    numbers.set([rectangle.x, rectangle.y, rectangle.width, rectangle.height], index * 4);
  });
  const devicePixels = devicePixelNumbers(numbers, deviceScale);
  return logicalRectangles.map((rectangle, index) => Object.freeze({
    logical: Object.freeze({ ...rectangle }),
    devicePixels: Object.freeze({
      x: devicePixels[index * 4],
      y: devicePixels[index * 4 + 1],
      width: devicePixels[index * 4 + 2],
      height: devicePixels[index * 4 + 3],
    }),
  }));
}

export async function inspectAnimationPreparedInput(
  preparedInput,
  inspectionRequest = {},
) {
  return await performPreparedOperation(preparedInput, async (state) => {
    const {
      width = 1280,
      height = 720,
      deviceScale = 1,
      renderMode = "standard-dynamic-range",
      graphicsBackend = "auto",
      scrollbarStyle = "overlay",
    } = inspectionRequest;
    assertScrollbarStyle(scrollbarStyle, "inspection request");
    const highDynamicRange = sharedDomCore.status("output_inspection_check", OUTPUT_CODE.INSPECTION_CHECK_ANIMATION,
      numberOrNaN(width), numberOrNaN(height), numberOrNaN(deviceScale),
      ...sharedDomCore.valueListInput([renderMode])) === OUTPUT_CODE.INSPECTION_HIGH_DYNAMIC_RANGE;
    if (!preparedInput.document.documentElement) {
      throw new Error("The preprocessor did not populate a document element");
    }

    await preparedInput.document._readyForRendering();
    const surface = createRenderSurface(
      preparedInput.document.documentElement,
      {
        viewportWidth: width,
        viewportHeight: height,
        deviceScale,
        renderMode: highDynamicRange ? "high-dynamic-range" : undefined,
        renderPrecision: highDynamicRange ? "rgba16float" : undefined,
        capturePaintArtifact: true,
        graphicsBackend,
        scrollbarStyle,
      },
    );
    try {
      // A one-shot render runs no loop (as renderDocumentAnimation).
      surface.stop();
      const frame = await surface.renderNow();
      if (!frame?.inspection) {
        throw new Error(
          "The render surface did not return inspection artifacts",
        );
      }
      const {
        sceneNodes,
        elementAtIndex,
        layoutBoxes,
        paintArtifact,
      } = frame.inspection;
      const facts = inspectionNodes(sceneNodes, (sceneIndex) => elementAtIndex[sceneIndex], () => null);
      const identifiers = new Map();
      const nodeIdentifier = (sceneIndex) => {
        if (!identifiers.has(sceneIndex)) identifiers.set(sceneIndex, inspectionIdentifier(sceneIndex));
        return identifiers.get(sceneIndex);
      };
      const nodes = sceneNodes.map((sceneNode, sceneIndex) => {
        const sourceNode = elementAtIndex[sceneIndex];
        const { parentIndex, sourceKind: kind } = facts[sceneIndex];
        let source;
        if (kind === "element") {
          source = {
            kind,
            localName: sourceNode.localName,
            namespace: sourceNode.namespaceURI,
            ...(sourceNode.id === "" ? {} : { id: sourceNode.id }),
            ...(typeof sceneNode.text === "string"
              ? { text: sceneNode.text }
              : {}),
          };
        } else if (kind === "text") {
          source = { kind, text: sourceNode.data };
        } else {
          source = { kind, display: sceneNode.display };
        }
        return Object.freeze({
          identifier: nodeIdentifier(sceneIndex),
          sceneIndex,
          parentIdentifier: parentIndex === null ? null : nodeIdentifier(parentIndex),
          childIdentifiers: Object.freeze(
            (sceneNode.children ?? []).map(nodeIdentifier),
          ),
          source: Object.freeze(source),
        });
      });
      const layoutRectangleValues = inspectionRectangles(
        layoutBoxes.map((box) => ({ x: box.x, y: box.y, width: box.w, height: box.h })),
        deviceScale,
      );
      const layoutRectangles = layoutBoxes.map((_, sceneIndex) =>
        Object.freeze({
          nodeIdentifier: nodeIdentifier(sceneIndex),
          rectangleKind: "border-box",
          rectangle: layoutRectangleValues[sceneIndex],
        })
      );
      const operationRectangles = inspectionRectangles(
        paintArtifact.operations.map((operation) => operation.logicalRectangle),
        deviceScale,
      );
      const clipRectangles = inspectionRectangles(
        paintArtifact.operations.flatMap((operation) =>
          operation.clipEntries.map((entry) => ({ x: entry.x, y: entry.y, width: entry.width, height: entry.height }))
        ),
        deviceScale,
      );
      let clipIndex = 0;
      const paintOperations = paintArtifact.operations.map((operation, operationPosition) =>
        Object.freeze({
          operationIndex: operation.operationIndex,
          commandIndex: operation.commandIndex,
          operationKind: operation.kind,
          nodeIdentifier: nodeIdentifier(operation.nodeIndex),
          rectangle: operationRectangles[operationPosition],
          ...(operation.text === undefined ? {} : {
            text: operation.text,
            fontSize: operation.fontSize,
            lineHeight: operation.lineHeight,
            ascent: operation.ascent,
            descent: operation.descent,
            baseline: operation.baseline,
            glyphAdvances: Object.freeze([...operation.glyphAdvances]),
          }),
          affine: operation.affine,
          clip: Object.freeze({
            entries: Object.freeze(
              operation.clipEntries.map((entry) =>
                Object.freeze({
                  rectangle: clipRectangles[clipIndex++],
                  radii: Object.freeze([...entry.radii]),
                  affine: entry.affine,
                  pathMask: entry.pathMask,
                })
              ),
            ),
          }),
          opacity: operation.opacity,
          blendMode: operation.blendMode,
          compositingGroupIdentifiers: Object.freeze(
            [...operation.compositingGroupIdentifiers],
          ),
          stackingContextIdentifiers: Object.freeze(
            [...operation.stackingContextIdentifiers],
          ),
        })
      );
      sharedDomCore.status("output_inspection_text_operations",
        ...sharedDomCore.valueListInput(paintOperations.map((operation) => operation.operationKind)));
      const textOperation = paintOperations.length === 0
        ? new Uint8Array(0)
        : sharedDomCore.outputBytes("output_inspection_text_operations", 0, paintOperations.length);
      const textChunks = paintOperations.filter((_, operationPosition) =>
        textOperation[operationPosition] === OUTPUT_CODE.INSPECTION_TEXT_OPERATION);
      const compositingGroups = paintArtifact.compositingGroups.map((group) =>
        Object.freeze({
          identifier: group.identifier,
          groupKind: group.kind,
          nodeIdentifier: group.nodeIndex === null
            ? null
            : nodeIdentifier(group.nodeIndex),
          startCommandIndex: group.startCommandIndex,
          endCommandIndex: group.endCommandIndex,
          startOperationIndex: group.startOperationIndex,
          endOperationIndex: group.endOperationIndex,
          stackingContext: group.stackingContext,
          ...(group.opacity === undefined ? {} : { opacity: group.opacity }),
          ...(group.blendMode === undefined
            ? {}
            : { blendMode: group.blendMode }),
        })
      );
      return Object.freeze({
        input: preparedInput.input,
        resources: state.resourceRecords(),
        diagnostics: state.diagnosticRecords(),
        requestedGraphicsBackend: graphicsBackend,
        graphicsBackend: frame.graphicsBackend,
        graphicsBackendInfo: frame.graphicsBackendInfo,
        scrollbarStyle: surface.scrollbarStyle,
        viewport: Object.freeze({
          width,
          height,
          deviceScale,
          devicePixelWidth: frame.width,
          devicePixelHeight: frame.height,
          renderMode,
        }),
        nodes: Object.freeze(nodes),
        layout: Object.freeze({
          rectangles: Object.freeze(layoutRectangles),
        }),
        paint: Object.freeze({
          operations: Object.freeze(paintOperations),
          textChunks: Object.freeze(textChunks),
          compositingGroups: Object.freeze(compositingGroups),
        }),
      });
    } finally {
      await surface.shutdown();
    }
  });
}
