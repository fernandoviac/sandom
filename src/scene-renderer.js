// Shared scene rendering machinery for the gallery AND the headless pixel test.
// Single source of truth for: spec → WAT layout nodes, spec → equivalent
// CSS/HTML (the Chrome side), and lay-out-and-render to pixels. Both the visible
// gallery and the test import these, so the test renders the exact same bytes
// the gallery shows.

const engineWriteClaims = new WeakMap();

import { hostNow } from "./host-clock.js";
import { loadEngine } from "./wasm/loader.js";
import { createImageResourceBinding } from "./image-resource-binding.js";
import {
  readEngineBoxes,
  releaseBoxSnapshot,
  retainBoxSnapshot,
} from "./dom-wasm/geometry-wire.js";
const domMeasurementKey = Symbol.for("sandom.domCore.measurement");
import {
  createRenderContext,
  releaseSharedWebgl2State,
  releaseSharedWebgpuStates,
  render,
} from "./rasterize.js";
import { releaseRasterPlan } from "./raster-plan.js";
import { createAnimationController } from "./animations.js";
import { createAtlasRuntime, emptyGlyphPhaseMilliseconds } from "./atlas.js";
import { GlyphResourceManager } from "./glyph-resource-manager.js";
import { createColorGlyphCache } from "./color-glyph-cache.js";
export {
  DEFAULT_GLYPH_RESOURCE_LIMITS,
  GLYPH_RESOURCE_FORMAT_VERSION,
  GlyphResourceManager,
} from "./glyph-resource-manager.js";
import { createImageCodecRuntime } from "./jpeg.js";
import { decodeImageResource, UndecodableImageError } from "./image-decode.js";
import { createWebPDecoder } from "./webp.js";
import { createJpegXlCodec } from "./jpeg-xl.js";
import {
  lazyAssetBytes,
  prepareSandomRuntimeOptions,
} from "./runtime-assets.js";
import { prepareImageProfile, toSrgbRgba8 } from "./image-data.js";
import { BROKEN_IMAGE_ICON_2X_PNG, BROKEN_IMAGE_ICON_PNG } from "./broken-image-icon.js";
import { srgb8Pixels } from "./wasm/color-source.js";
import { createShapingRuntime } from "./shaping.js";
import { acquireFontByteSource } from "./dom-wasm/font-byte-binding.js";
import { noResourceHost } from "./host/contract.js";
import { createDocumentResourceLoader } from "./dom/document-resources.js";
import { capturePaintRecord } from "./dom/paint-projection.js";
import {
  createFontRegistry,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  defaultFontRegistry,
} from "./font-registry.js";
import { gridTrackCss } from "./grid-tracks.js";
import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { prepareAuthoredSceneInput, publishDirectSceneInput, releaseAuthoredSceneInput } from "./dom-wasm/direct-scene-input.js";
import { readSceneRowStyle, sceneStyleGeneration } from "./dom-wasm/scene-style.js";
import { createFontRequestPlan } from "./dom-wasm/font-request-binding.js";
import {
  EngineFrameFinishRowFields,
  EngineFrameFinishRowSize,
  EngineFrameResolutionFields,
  EngineFrameResolutionSize,
  writeEngineFrameInput,
} from "./dom-wasm/record-readers.generated.js";
import {
  BOX_OFFSET_CONTENT_H,
  BOX_OFFSET_CONTENT_W,
  BOX_OFFSET_CONTENT_X,
  BOX_OFFSET_CONTENT_Y,
  BOX_OFFSET_HEIGHT,
  BOX_OFFSET_WIDTH,
  BOX_OFFSET_X,
  BOX_OFFSET_Y,
  BOX_SIZE,
  CLIP_ENTRY_FLAG_AFFINE,
  CLIP_ENTRY_FLAG_PATH_MASK,
  CLIP_ENTRY_OFFSET_AFFINE,
  CLIP_ENTRY_OFFSET_FLAGS,
  CLIP_ENTRY_OFFSET_H,
  CLIP_ENTRY_OFFSET_RADII,
  CLIP_ENTRY_OFFSET_W,
  CLIP_ENTRY_OFFSET_X,
  CLIP_ENTRY_OFFSET_Y,
  CLIP_ENTRY_SIZE,
  CMD_BOX_SHADOW,
  CMD_BOX_SHADOW_OFFSET_H,
  CMD_BOX_SHADOW_OFFSET_W,
  CMD_BOX_SHADOW_OFFSET_X,
  CMD_BOX_SHADOW_OFFSET_Y,
  CMD_IMAGE,
  CMD_IMAGE_OFFSET_H,
  CMD_IMAGE_OFFSET_W,
  CMD_IMAGE_OFFSET_X,
  CMD_IMAGE_OFFSET_Y,
  CMD_POP_CLIP,
  CMD_PUSH_CLIP,
  CMD_PUSH_CLIP_HEADER_SIZE,
  CMD_PUSH_CLIP_OFFSET_COUNT,
  CMD_RECT,
  CMD_RECT_FLAG_BORDER,
  CMD_RECT_FLAG_FILL,
  CMD_RECT_FLAG_TRANSFORM,
  CMD_RECT_OFFSET_BORDER_BOTTOM,
  CMD_RECT_OFFSET_BORDER_LEFT,
  CMD_RECT_OFFSET_BORDER_RIGHT,
  CMD_RECT_OFFSET_BORDER_TOP,
  CMD_RECT_OFFSET_FILL,
  CMD_RECT_OFFSET_FLAGS,
  CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X,
  CMD_RECT_OFFSET_H,
  CMD_RECT_OFFSET_W,
  CMD_RECT_OFFSET_X,
  CMD_RECT_OFFSET_Y,
  CMD_SET_NODE,
  CMD_SET_NODE_OFFSET_INDEX,
  CMD_SVG_PATH,
  CMD_SVG_PATH_FLAG_TRANSFORM,
  CMD_SVG_PATH_OFFSET_FLAGS,
  CMD_SVG_PATH_OFFSET_H,
  CMD_SVG_PATH_OFFSET_INDEX,
  CMD_SVG_PATH_OFFSET_W,
  CMD_SVG_PATH_OFFSET_X,
  CMD_SVG_PATH_OFFSET_XFORM,
  CMD_SVG_PATH_OFFSET_Y,
  COLOR_GLYPH_IMAGE_INDEX_BASE,
  COLOR_GLYPH_IMAGE_RESOURCE_COUNT,
  COLOR_GLYPH_PATH_INDEX_BASE,
  FONT_UNIT_SUBDIVISION,
  CMD_TEXT,
  CMD_TEXT_FLAG_TEXT_SHADOW,
  CMD_TEXT_FLAG_TRANSFORM,
  CMD_TEXT_OFFSET_BL,
  CMD_TEXT_OFFSET_FLAGS,
  CMD_TEXT_OFFSET_FONT,
  CMD_TEXT_OFFSET_COLOR,
  CMD_TEXT_OFFSET_FSIZE,
  CMD_TEXT_OFFSET_GCOUNT,
  CMD_TEXT_OFFSET_GOFF,
  CMD_TEXT_OFFSET_OPSZ,
  CMD_TEXT_OFFSET_STYLE,
  CMD_TEXT_OFFSET_UPEM,
  CMD_TEXT_OFFSET_VARIATIONS,
  CMD_TEXT_OFFSET_WEIGHT,
  CMD_TEXT_OFFSET_X,
  CMD_TEXT_OFFSET_XFORM,
  CMD_TEXT_OFFSET_Y,
  commandByteSize,
  FONT_TABLE_BASE,
  FONT_TABLE_ENTRY_SIZE,
  FONT_TABLE_OFFSET_UPEM,
  FONT_TABLE_OFFSET_BYTES,
  FONT_TABLE_OFFSET_LENGTH,
  FONT_TABLE_OFFSET_WEIGHT,
  FONT_VARIATION_TABLE_BASE,
  FONT_VARIATION_TABLE_ENTRY_SIZE,
  FONT_VARIATION_OFFSET_WIDTH,
  FONT_VARIATION_OFFSET_SLANT,
  GLYPH_ENTRY_SIZE,
  GLYPH_REQUEST_HEADER_SIZE,
  GLYPH_REQUEST_ROW_SIZE,
  GLYPH_REQUEST_KIND_PATH,
  GLYPH_REQUEST_KIND,
  GLYPH_REQUEST_PATH_INDEX,
  GLYPH_REQUEST_PATH_SCREEN_SIZE,
  GLYPH_REQUEST_PATH_COVERAGE,
  glyphRequestRowByteSize,
  GLYPH_OFFSET_CLUSTER_END,
  GLYPH_OFFSET_CLUSTER_START,
  GLYPH_OFFSET_ID,
  GLYPH_OFFSET_INK_X,
  GLYPH_OFFSET_INK_Y,
  GLYPH_OFFSET_X_ADVANCE,
  GLYPH_OFFSET_X_OFFSET,
  RASTER_PLAN_SCROLLBAR_ROW_SIZE,
  RASTER_RESOURCE_IMAGE,
  LAYOUT_NODE_OFFSET_CHANGED_GEN,
  LAYOUT_NODE_OFFSET_PAINT_GEN,
  LAYOUT_NODE_SIZE,
  LAYOUT_UNIT,
  TEXT_LINE_ENTRY_SIZE,
  TEXT_LINE_OFFSET_AVAIL,
  TEXT_LINE_OFFSET_FIRST_GLYPH,
  TEXT_LINE_OFFSET_GLYPH_COUNT,
  TEXT_LINE_OFFSET_WIDTH,
  TEXT_LINE_OFFSET_X,
  TEXT_LINE_OFFSET_Y,
  TEXT_RUN_ENTRY_SIZE,
  TEXT_RUN_OFFSET_LINE_COUNT,
  TEXT_RUN_OFFSET_LINE_OFFSET,
  SHAPED_GLYPH_FONT_INDEX,
  SHAPED_GLYPH_FONT_SYNTHESIZED,
} from "./wasm/layout.js";
import { layoutConstant } from "./wasm/layout-table.js";

const SCENE_LAYER_BACKGROUNDS = layoutConstant("SCENE_LAYER_BACKGROUNDS");
const SCENE_LAYER_MASKS = layoutConstant("SCENE_LAYER_MASKS");
const SCENE_LAYER_BORDER_IMAGE = layoutConstant("SCENE_LAYER_BORDER_IMAGE");
const SCENE_CSS_NEEDS_FONT = layoutConstant("SCENE_CSS_NEEDS_FONT");
const SCENE_CSS_NEEDS_GRID = layoutConstant("SCENE_CSS_NEEDS_GRID");
const SCENE_CSS_NEEDS_IMAGE = layoutConstant("SCENE_CSS_NEEDS_IMAGE");
const SVG_GEOMETRY_CHANGED = layoutConstant("SVG_GEOMETRY_CHANGED");
const SVG_GEOMETRY_REQUESTS_SHIFT = layoutConstant("SVG_GEOMETRY_REQUESTS_SHIFT");
const PATH_SOURCE_SVG = layoutConstant("PATH_SOURCE_SVG");
const PATH_SOURCE_COLOR_GLYPH = layoutConstant("PATH_SOURCE_COLOR_GLYPH");
const ENGINE_FINISH_FORCE_GENERATION = layoutConstant("ENGINE_FINISH_FORCE_GENERATION");
const ENGINE_FINISH_SCROLL_ONLY = layoutConstant("ENGINE_FINISH_SCROLL_ONLY");
const PATH_SOURCE_TEXT_STROKE = layoutConstant("PATH_SOURCE_TEXT_STROKE");
const RASTER_IMAGE_RECORD = Object.fromEntries(["FLOATS", "WIDTH", "HEIGHT", "KIND"]
  .map((name) => [name, layoutConstant(`RASTER_IMAGE_RECORD_${name}`)]));
const FRAME_TILES = Object.fromEntries(["COLUMNS", "ROWS", "MAP"]
  .map((name) => [name, layoutConstant(`FRAME_TILES_${name}`)]));
const RASTER_IMAGE_KIND_DECODED = layoutConstant("RASTER_IMAGE_KIND_DECODED");
const RASTER_IMAGE_KIND_CANVAS = layoutConstant("RASTER_IMAGE_KIND_CANVAS");
const BROKEN_IMAGE_ICON_WIDTH = layoutConstant("BROKEN_IMAGE_ICON_WIDTH");
const BROKEN_IMAGE_ICON_HEIGHT = layoutConstant("BROKEN_IMAGE_ICON_HEIGHT");
const BROKEN_IMAGE_ICON_2X = layoutConstant("BROKEN_IMAGE_ICON_2X");
const DRAWN_SCAN_TABLE_FULL = layoutConstant("DRAWN_SCAN_TABLE_FULL");
const ENGINE_FRAME_INPUT_DIRECT = layoutConstant("ENGINE_FRAME_INPUT_DIRECT");
const ENGINE_RESOLUTION = Object.fromEntries(["FONT", "IMAGE", "LAYERS"]
  .map((name) => [name, layoutConstant(`ENGINE_RESOLUTION_${name}`)]));
const IMAGE_INDEX_NONE = layoutConstant("IMAGE_INDEX_NONE");
const RETAINED_EDIT_SPLICE = layoutConstant("RETAINED_EDIT_SPLICE");
const RETAINED_EDIT_PATCH = layoutConstant("RETAINED_EDIT_PATCH");
const RASTER_PLAN_REUSE = Object.fromEntries(["NONE", "TARGET", "SAME"]
  .map((name) => [name, layoutConstant(`RASTER_PLAN_REUSE_${name}`)]));
const RASTER_PLAN_HEADER_RECORD_COUNT = layoutConstant("RASTER_PLAN_HEADER_RECORD_COUNT");
const GLYPH_REQUEST_COUNT = layoutConstant("GLYPH_REQUEST_COUNT");
const GLYPH_REQUEST_REVISION = layoutConstant("GLYPH_REQUEST_REVISION");
// The font records of font-registration, font-instance-input and
// font-requests watparts, by WAT name.
const layoutConstants = (prefix, names) =>
  Object.freeze(Object.fromEntries(names.map((name) => [name, layoutConstant(`${prefix}${name}`)])));
const FONT_REGISTRATION = layoutConstants("FONT_REGISTRATION_",
  ["SIZE", "FAMILY", "IDENTITY", "FACE_INDEX", "ITALIC", "WEIGHT", "STRETCH", "SLANT"]);
const FONT_INSTANCE_REPORT = layoutConstants("FONT_INSTANCE_REPORT_", ["SIZE", "WEIGHT", "WIDTH", "SLANT", "FACE_INDEX"]);
const FONT_GLYPH_REQUEST = layoutConstants("FONT_GLYPH_REQUEST_",
  ["SIZE", "FACE_INDEX", "WEIGHT", "WIDTH", "SLANT", "OPTICAL_SIZE", "DEVICE_PIXEL_SIZE"]);
const CANVAS_TEXT_LAYOUT = Object.freeze(Object.fromEntries(["WIDTH", "INK", "ASCENT", "DESCENT", "LINE_GAP",
  "TYPO_ASCENT", "TYPO_DESCENT", "SIZE", "SYNTHESIZED_SIZE", "GLYPH_COUNT", "GLYPHS"]
  .map((name) => [name, layoutConstant(`CANVAS_TEXT_LAYOUT_${name}`)])));
const CANVAS_TEXT_GLYPH = Object.freeze(Object.fromEntries(["SIZE", "ID", "FONT", "OBLIQUE", "RUN_FONT", "X"]
  .map((name) => [name, layoutConstant(`CANVAS_TEXT_GLYPH_${name}`)])));
const CANVAS_TEXT_MEASURE_COUNT = layoutConstant("CANVAS_TEXT_MEASURE_COUNT");
const SHAPE_FEATURE_SIZE = layoutConstant("SHAPE_FEATURE_SIZE");
const SHAPE_FEATURE_TAG = layoutConstant("SHAPE_FEATURE_TAG");
const SHAPE_FEATURE_VALUE = layoutConstant("SHAPE_FEATURE_VALUE");
const VARIATION_CONTROL_COUNT = layoutConstant("VARIATION_CONTROL_COUNT");
const VARIATION_CONTROL_OPTICAL_SIZING_NONE = layoutConstant("VARIATION_CONTROL_OPTICAL_SIZING_NONE");
const VARIATION_CONTROL_PAIRS = layoutConstant("VARIATION_CONTROL_PAIRS");
const VARIATION_PAIR_SIZE = layoutConstant("VARIATION_PAIR_SIZE");
const VARIATION_PAIR_TAG = layoutConstant("VARIATION_PAIR_TAG");
const VARIATION_PAIR_VALUE = layoutConstant("VARIATION_PAIR_VALUE");
const FONT_SOURCE_REQUEST = Object.freeze(Object.fromEntries(["SIZE", "FAMILY_POINTER", "FAMILY_LENGTH", "WEIGHT", "STYLE"]
  .map((name) => [name, layoutConstant(`FONT_SOURCE_REQUEST_${name}`)])));
const CLIP_ENTRY_PATH = Object.freeze(Object.fromEntries(["INDEX", "SCALE", "X_MIN", "Y_MIN", "X_MAX", "Y_MAX"]
  .map((name) => [name, layoutConstant(`CLIP_ENTRY_PATH_${name}`)])));
const PAGE_FRAGMENT_NODE = layoutConstant("PAGE_FRAGMENT_NODE");
const PAGE_FRAGMENT_PAGE = layoutConstant("PAGE_FRAGMENT_PAGE");
const PAGE_FRAGMENT_BOX = layoutConstant("PAGE_FRAGMENT_BOX");
const FONT_REQUEST_CSS_FAMILY = layoutConstant("FONT_REQUEST_CSS_FAMILY");
const F32 = Float32Array.BYTES_PER_ELEMENT;

export { LAYOUT_UNIT };

// The variation control of a text command's variation key
// (text_variation_control): whether font-optical-sizing is none, and the
// font-variation-settings pairs [tag, value].
function textVariationControl(engine, key) {
  const control = engine.exports.text_variation_control(key);
  if (control === 0) return { opticalSizing: "auto", variationSettings: [] };
  const view = new DataView(engine.memory.buffer);
  const count = view.getUint32(control + VARIATION_CONTROL_COUNT, true);
  return {
    opticalSizing: view.getUint32(control + VARIATION_CONTROL_OPTICAL_SIZING_NONE, true) === 0 ? "auto" : "none",
    variationSettings: Array.from({ length: count }, (_, index) => {
      const pair = control + VARIATION_CONTROL_PAIRS + index * VARIATION_PAIR_SIZE;
      const tag = view.getUint32(pair + VARIATION_PAIR_TAG, true);
      return [String.fromCharCode(tag >>> 24, (tag >>> 16) & 0xFF, (tag >>> 8) & 0xFF, tag & 0xFF),
        view.getFloat32(pair + VARIATION_PAIR_VALUE, true)];
    }),
  };
}

// The canvases a scene paints (serialize.js imageSources: a canvas's
// resource identifier to its context's paint source), each with its
// content revision as a preparation recorded them.
function canvasSourceRevisions(imageSources) {
  return new Map(Array.from(imageSources ?? [], ([id, source]) => [id, { source, revision: source.revision }]));
}

// Whether a scene paints the canvases of `recorded` (canvasSourceRevisions)
// with the same content: a serialization builds a new map each frame, and
// a canvas that kept its content keeps the preparation's rows and commands.
function canvasSourcesHold(recorded, imageSources) {
  const size = imageSources?.size ?? 0;
  if (size !== (recorded?.size ?? 0)) return false;
  for (const [id, source] of imageSources ?? []) {
    const entry = recorded.get(id);
    if (entry === undefined || entry.source !== source || entry.revision !== source.revision) return false;
  }
  return true;
}

export async function createSceneRendererRuntime({
  harfbuzzBytes = null,
  msdfgenBytes = null,
  fontRegistry: suppliedFontRegistry = null,
  graphicsDevice = null,
  resolveSystemFontFamily = null,
  // The generic faces (loadBundledSystemFonts()) and the registry fallback
  // families of the runtime's own font registry (createFontRegistry). A
  // supplied fontRegistry carries its own.
  bundledSystemFonts = null,
  fallbackFamilies = null,
  shapingRuntime: suppliedShapingRuntime = null,
  atlasRuntime: suppliedAtlasRuntime = null,
  codecRuntime: suppliedCodecRuntime = null,
  svgImageRasterMode = false,
  // The DOM core whose memory this runtime's engine shares. The realm's
  // default runtime renders the realm's documents and passes sharedDomCore;
  // an isolated runtime keeps its own memory (design/memory-map.md).
  core = new DomCore(),
} = {}) {
  const engine = await loadEngine({ harfbuzzBytes, core });
  const shapingRuntime = suppliedShapingRuntime ??
    createShapingRuntime({ engine });
  const atlasRuntime = suppliedAtlasRuntime ??
    createAtlasRuntime({
      engine,
      msdfgenBytes,
      createGlyphOutlineSource: shapingRuntime.createGlyphOutlineSource,
      createGlyphOutlineSourceSync: shapingRuntime.createGlyphOutlineSourceSync,
    });
  if (suppliedFontRegistry !== null && (fallbackFamilies !== null || bundledSystemFonts !== null)) {
    throw new TypeError(
      "createSceneRendererRuntime takes fallbackFamilies and bundledSystemFonts, or a fontRegistry, not both; " +
        "pass them to createFontRegistry",
    );
  }
  const fontRegistry = suppliedFontRegistry ??
    createFontRegistry({ resolveSystemFontFamily, bundledSystemFonts, fallbackFamilies, core });
  if (fontRegistry.core && fontRegistry.core !== core) {
    throw new TypeError("Font registry belongs to another renderer core");
  }
  // A document made later without a registry takes the core's first one; a
  // runtime made later for the same core does not change it.
  core.defaultFontRegistry ??= fontRegistry;
  const codecRuntime = suppliedCodecRuntime ?? createImageCodecRuntime();
  const {
    initializeAtlasRuntime,
    SvgPathAtlas,
  } = atlasRuntime;
  const {
    fontFamilyCssValue,
    fontStackKeysForCssValue,
    fontFileFor,
    fontWeightInCssUnits,
  } = fontRegistry;
  const { decodeImage, imageMimeType } = codecRuntime;
  if (
    graphicsDevice !== null &&
    (typeof graphicsDevice?.createBuffer !== "function" ||
      typeof graphicsDevice?.queue?.submit !== "function")
  ) {
    throw new TypeError("graphicsDevice must be a GPUDevice");
  }
  const graphicsStateOwner = graphicsDevice === null
    ? {}
    : { webgpuDevice: graphicsDevice };
  // Adopts a host's GPU device for every surface, presenter and canvas of
  // this runtime: one device for the realm, which the host owns. Only
  // before the runtime's first render context: its pipelines, atlases and
  // textures belong to the device that context started on.
  function useGraphicsDevice(device) {
    if (typeof device?.createBuffer !== "function" || typeof device?.queue?.submit !== "function") {
      throw new TypeError(`useGraphicsDevice takes a GPUDevice; it received ${device}`);
    }
    if (graphicsStateOwner.webgpuDevice === device) return;
    if (graphicsStateOwner.webgpuDevice !== undefined || graphicsStateOwner.webgpu?.size || graphicsStateOwner.webgl2) {
      throw new Error(
        "useGraphicsDevice: this Sandom runtime already renders on " +
          (graphicsStateOwner.webgpuDevice !== undefined ? "another host device" : "a device it requested at its first frame") +
          "; call useGraphicsDevice once, before the first surface renders",
      );
    }
    graphicsDevice = device;
    graphicsStateOwner.webgpuDevice = device;
  }
  // True once the runtime has its device: a host's (useGraphicsDevice) or the
  // one its first render context requested.
  function hasGraphicsDevice() {
    return graphicsStateOwner.webgpuDevice !== undefined || Boolean(graphicsStateOwner.webgpu?.size) ||
      Boolean(graphicsStateOwner.webgl2);
  }
  // The device the host gave the runtime (useGraphicsDevice), or null.
  function hostGraphicsDevice() {
    return graphicsStateOwner.webgpuDevice ?? null;
  }
  // Engine layout-buffer occupancy. Persistent renderers created through
  // this runtime share ONE engine; a renderer's incremental node diff is
  // only valid while the engine memory still holds THAT renderer's scene.
  // Every writer nulls the owner (writeSceneNodesAndTileConfig below);
  // renderScenePixels re-claims it after its main write when the caller
  // passes an engineWriteOwner token. A caller whose token no longer
  // matches the current owner gets a full node rewrite instead of its
  // incremental set — writeNode is write-if-changed, so generations still
  // advance only where bytes genuinely differ.
  let engineWriteOwner = null;
  // The owner whose render emission the engine's retained rows hold (an
  // emission outside a query snapshots them). The damage pass classifies
  // a changed node against them only in that owner's next frame.
  let retainedRowsOwner = null;
  // The paged layout whose page starts the engine recorded last: its key
  // (write owner, rows, size, fonts, resources), its page count and the
  // engine's record serial (renderScenePixelsNow's page option).
  let pagedLayoutRecord = null;
  // The rows a synchronous layout getter left in the engine on behalf of
  // the surface that owns the write claim (layoutTreeBoxesSync), for the
  // frame that takes the same serialization to reuse instead of publishing
  // every row again. Any other engine write supersedes it.
  let syncLayoutWrite = null;
  const retainedPreparations = new WeakMap();

  function releaseRetainedPreparation(owner, preservedTextResources = null, preservedNodes = []) {
    const retained = owner && retainedPreparations.get(owner);
    if (!retained) return;
    retainedPreparations.delete(owner);
    if (retained.rasterPlan) {
      releaseRasterPlan(retained.rasterPlan);
    }
    if (retained.textResources.glyphLease !== preservedTextResources?.glyphLease) {
      retained.textResources.glyphLease.release();
    }
    releaseBoxSnapshot(retained.boxes);
    releaseAuthoredSceneInput(retained.nodes, preservedNodes);
  }

  // Whether a changed row forbids the sparse and patched frames
  // (engine_direct_needs_global_preparation).
  function needsGlobalPreparation(node) {
    const text = (value) => typeof value === "string" ? value : "";
    return core.status("engine_direct_needs_global_preparation",
      ...core.input(text(node.display)), Number(node.order ?? 0),
      ...core.input(text(node.transform?.kind)), node.clipPath !== undefined ? 1 : 0,
      usesCoreRecord(node) ? 1 : 0) !== 0;
  }
  // Renders through the shared engine are SERIALIZED: renderScenePixels
  // holds live views over the engine's command buffer across awaits, so a
  // second renderer starting mid-render would clobber the first's frame.
  let engineRenderChain = Promise.resolve();
  function runExclusiveEngineOperation(operation) {
    const run = engineRenderChain.then(operation);
    // Keep the chain alive past a failing operation, or one thrown error
    // would poison every later operation through this engine.
    engineRenderChain = run.then(() => {}, () => {});
    return run;
  }
  let defaultGlyphResourceManager = null;
  function getDefaultGlyphResourceManager() {
    if (
      !defaultGlyphResourceManager ||
      defaultGlyphResourceManager.snapshot().shutDown
    ) {
      defaultGlyphResourceManager = new GlyphResourceManager({
        atlasRuntime,
      });
    }
    return defaultGlyphResourceManager;
  }
  async function shutdownDefaultGlyphResourceManager() {
    const manager = defaultGlyphResourceManager;
    defaultGlyphResourceManager = null;
    if (manager) await manager.shutdown();
  }


  // Style inspection reads matrices, borders and SVG facts. Image resources
  // join only during a render, so inspection omits their unresolved sources.
  function inspectAuthoredNode(node, box) {
    const input = node._coreBox === undefined
      ? [{ ...node, borderImage: undefined, backgroundImages: undefined, masks: undefined }]
      : [node];
    const nodes = prepareAuthoredSceneInput(core, input, fontRegistry);
    try {
      return readSceneRowStyle(core, nodes[0], box);
    } finally {
      if (nodes !== input) releaseAuthoredSceneInput(nodes);
    }
  }

  // Debug-only escape hatch: exposes the module's own engine instance so a
  // scratch script can read WASM memory directly (e.g. debug_trace_base(),
  // raw command-buffer bytes) without instantiating a second, separate engine
  // that wouldn't share memory with whatever renderScenePixels
  // call already ran.
  function __debugEngine() {
    return engine;
  }

  await shapingRuntime.preload();
  if (shapingRuntime.instanceIdentity() !== engine.hb) {
    throw new TypeError("Shaping runtime uses another HarfBuzz instance; bind it to this renderer's engine");
  }
  await initializeAtlasRuntime();
  const textPreparationRuntime = engine.textPreparation;
  // The engine's per-node tables start in the fixed map (layout.js) and
  // move to an allocated block when a scene needs more nodes
  // (engine.wat node_tables_reserve). Every address into them is read
  // from the engine after each reservation; nothing here assumes the
  // initial map. A caller may still cap a renderer explicitly.
  let layoutBufferBase = engine.exports.layout_buffer_base();
  let computedBoxBufferBase = engine.exports.computed_box_buffer_base();
  let scrollTableBase = engine.exports.scroll_table_base();
  let scrollTableSize = engine.exports.scroll_table_size();
  let textRunDirBase = engine.exports.text_run_dir_base();
  let nodeCapacity = engine.exports.node_capacity();
  function ensureNodeCapacity(count) {
    if (count <= nodeCapacity) return;
    if (!engine.exports.node_tables_reserve(count)) {
      throw new RangeError(
        `Scene has ${count} nodes; the engine could not allocate node tables for it`,
      );
    }
    nodeCapacity = engine.exports.node_capacity();
    layoutBufferBase = engine.exports.layout_buffer_base();
    computedBoxBufferBase = engine.exports.computed_box_buffer_base();
    scrollTableBase = engine.exports.scroll_table_base();
    scrollTableSize = engine.exports.scroll_table_size();
    textRunDirBase = engine.exports.text_run_dir_base();
  }

  function validateLayoutNodeCapacity(capacity) {
    if (
      capacity !== Infinity && (!Number.isSafeInteger(capacity) || capacity < 1)
    ) {
      throw new RangeError(
        `Layout node capacity must be a positive integer; received ${capacity}`,
      );
    }
    return capacity;
  }
  // Long-lived view over the shared engine+HarfBuzz memory. HarfBuzz heap
  // growth detaches it; the loader's growth notification re-derives it (the
  // one refresh rule — see src/wasm/loader.js).
  let view = new DataView(engine.memory.buffer);
  engine.onMemoryGrowth(() => {
    view = new DataView(engine.memory.buffer);
  });

  // White render background, shared by sandom render AND the Chrome SVG raster, so
  // the two pixel buffers compare against the same backdrop.
  const RENDER_BG = { r: 1, g: 1, b: 1, a: 1 };
  const glyphGenerationBackend = Object.freeze({ kind: "cpu" });

  // The font registry supplies complete font bytes. A host resolver can read
  // installed fonts synchronously before Sandom enters synchronous layout.
  const fontBytesByPointer = new Map();
  // Tokens retain host identity values. Native records own their visibility,
  // ordering, default coordinates and release transitions.
  const fontIdentityTokens = new Map([[null, 0], [undefined, 0]]);
  const fontIdentityValues = [null];
  function fontIdentityToken(value) {
    let token = fontIdentityTokens.get(value);
    if (token === undefined) {
      token = fontIdentityValues.length;
      fontIdentityValues.push(value);
      fontIdentityTokens.set(value, token);
    }
    return token;
  }

  function fontIdentityForDocument(fontIndex, document) {
    const pointer = core.status("font_registration_read", fontRegistry.fontCatalogHandle, fontIndex, document);
    const record = new DataView(core.refreshBytes().buffer, pointer, FONT_REGISTRATION.SIZE);
    return Object.freeze({
      family: fontIdentityValues[record.getUint32(FONT_REGISTRATION.FAMILY, true)],
      faceIdentity: fontIdentityValues[record.getUint32(FONT_REGISTRATION.IDENTITY, true)],
      faceIndex: record.getUint32(FONT_REGISTRATION.FACE_INDEX, true),
      style: ["normal", "italic"][record.getUint32(FONT_REGISTRATION.ITALIC, true)],
      weight: record.getFloat64(FONT_REGISTRATION.WEIGHT, true),
      stretch: record.getFloat64(FONT_REGISTRATION.STRETCH, true),
      slant: record.getFloat64(FONT_REGISTRATION.SLANT, true),
    });
  }

  function fontVariationWidth(fontIndex) {
    return view.getFloat32(FONT_VARIATION_TABLE_BASE + fontIndex * FONT_VARIATION_TABLE_ENTRY_SIZE + FONT_VARIATION_OFFSET_WIDTH, true);
  }

  function fontVariationSlant(fontIndex) {
    return view.getFloat32(FONT_VARIATION_TABLE_BASE + fontIndex * FONT_VARIATION_TABLE_ENTRY_SIZE + FONT_VARIATION_OFFSET_SLANT, true);
  }
  let sceneGeneration = 0;


  // Registers the engine instance of host font bytes outside any catalog
  // (a directly authored scene's face, a registry fallback face). The core
  // reads the variation axes and metrics, registers the instance and sets
  // its decoration metrics (font_instance_acquire). wghtOnAxis registers
  // the weight only when the file has a 'wght' axis.
  function registerFontBytes(
    family,
    weight,
    stretch,
    {
      bytes, faceIndex, resourceHandle, faceIdentity, finalURL,
      variationWeight, variationWidth, variationSlant, wghtOnAxis,
    },
  ) {
    const index = acquireFontByteSource(core, bytes, "font_instance_acquire", [
      typeof faceIndex === "number" ? faceIndex : 0,
      faceIndex === undefined ? 0 : typeof faceIndex === "number" ? 1 : 2,
      Number(variationWeight),
      typeof variationWidth === "number" ? variationWidth : NaN,
      typeof variationSlant === "number" ? variationSlant : NaN,
      Number(Boolean(wghtOnAxis)) | (Number(typeof variationWidth === "number") << 1) |
        (Number(typeof variationSlant === "number") << 2),
    ]);
    const report = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), FONT_INSTANCE_REPORT.SIZE);
    return recordFontInstance(index, {
      family, weight, stretch, faceIdentity, finalURL, resourceHandle,
      faceIndex: report.getUint32(FONT_INSTANCE_REPORT.FACE_INDEX, true),
      registeredWeight: report.getInt32(FONT_INSTANCE_REPORT.WEIGHT, true),
      registeredWidth: report.getFloat32(FONT_INSTANCE_REPORT.WIDTH, true),
      registeredSlant: report.getFloat32(FONT_INSTANCE_REPORT.SLANT, true),
    });
  }

  // The catalog owns registration identity and document visibility.
  function recordFontInstance(fontIndex, {
    family, weight, stretch, faceIndex, faceIdentity, finalURL, resourceHandle,
    registeredWeight, registeredWidth, registeredSlant, document = 0n,
  }) {
    core.status("font_registration_record", fontRegistry.fontCatalogHandle,
      fontIndex, resourceHandle ?? 0n, document, fontIdentityToken(family),
      fontIdentityToken(faceIdentity ?? finalURL), faceIndex, weight, stretch,
      registeredWeight, registeredWidth, registeredSlant);
    return resourceHandle === undefined
      ? fontIndex
      : joinEngineResource(resourceHandle, fontIndex, fontIndex);
  }



  function registeredFontBytes(fontIndex) {
    const entry = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
    const pointer = view.getUint32(entry + FONT_TABLE_OFFSET_BYTES, true);
    let bytes = fontBytesByPointer.get(pointer);
    if (!bytes) {
      bytes = new Uint8Array(engine.memory.buffer, pointer,
        view.getUint32(entry + FONT_TABLE_OFFSET_LENGTH, true)).slice();
      fontBytesByPointer.set(pointer, bytes);
    }
    return bytes;
  }

  // Resolve CSS font declarations through the production registry, shape text
  // with HarfBuzz at the production variation coordinates, then fill the shared
  // bounded glyph manager. This is the public prewarm boundary for DOM clients.
  async function prewarmCssTextGlyphs({
    glyphResourceManager = getDefaultGlyphResourceManager(),
    instances,
    text,
  }) {
    const prewarmStartedAt = hostNow();
    if (!Array.isArray(instances)) {
      throw new TypeError("CSS glyph prewarm instances must be an array");
    }
    if (typeof text !== "string") {
      throw new TypeError("CSS glyph prewarm text must be a string");
    }
    if (
      glyphResourceManager === null ||
      typeof glyphResourceManager.prewarm !== "function"
    ) {
      throw new TypeError(
        "CSS glyph prewarm requires a glyph resource manager",
      );
    }

    const fontDigests = new WeakMap();
    const requests = [];
    const plan = createFontRequestPlan(core, instances, 1);
    try {
      for (const [group, instance] of plan.requests.entries()) {
        const [fontFamily] = fontStackKeysForCssValue(instance.family);
        const { weight, stretch, style, slope } = instance;
        const fontIndex = registerFontBytes(fontFamily, weight, stretch,
          fontFileFor(fontFamily, weight, style, stretch, slope));
        const count = core.status("font_requests_shape", plan.handle, group, fontIndex, ...core.input(text));
        if (count < 0) continue;
        const glyphIds = new Uint32Array(core.refreshBytes().buffer,
          core.exports.abi_output_pointer(), count).slice();
        core.status("font_requests_glyph_request", plan.handle, group, fontRegistry.fontCatalogHandle);
        const record = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), FONT_GLYPH_REQUEST.SIZE);
        const glyphRequest = {
          faceIndex: record.getUint32(FONT_GLYPH_REQUEST.FACE_INDEX, true),
          weight: record.getFloat64(FONT_GLYPH_REQUEST.WEIGHT, true),
          variationWidth: record.getFloat64(FONT_GLYPH_REQUEST.WIDTH, true),
          variationSlant: record.getFloat64(FONT_GLYPH_REQUEST.SLANT, true),
          opticalSize: record.getFloat64(FONT_GLYPH_REQUEST.OPTICAL_SIZE, true),
          devicePixelSize: record.getFloat64(FONT_GLYPH_REQUEST.DEVICE_PIXEL_SIZE, true),
        };
        const fontBytes = registeredFontBytes(fontIndex);
        if (!fontBytes) {
          throw new Error(`CSS glyph prewarm resolved font index ${fontIndex} without font bytes`);
        }
        let contentDigest = fontDigests.get(fontBytes);
        if (contentDigest === undefined) {
          contentDigest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", fontBytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          fontDigests.set(fontBytes, contentDigest);
        }
        requests.push({ fontBytes, glyphIds, ...glyphRequest, fontFamily, contentDigest });
      }
    } finally {
      core.status("font_requests_release", plan.handle);
    }

    const prewarmResult = await glyphResourceManager.prewarm(
      requests.map((request) => ({
        fontBytes: request.fontBytes,
        faceIndex: request.faceIndex,
        glyphIds: request.glyphIds,
        weight: request.weight,
        variationWidth: request.variationWidth,
        variationSlant: request.variationSlant,
        opticalSize: request.opticalSize,
        devicePixelSize: request.devicePixelSize,
      })),
    );
    return Object.freeze({
      fontInstanceCount: requests.length,
      requestedGlyphCount: prewarmResult.glyphPerformance.requestedGlyphCount,
      generatedGlyphCount: prewarmResult.glyphPerformance.generatedGlyphCount,
      reusedGlyphCount: prewarmResult.glyphPerformance.cacheHitGlyphCount,
      milliseconds: hostNow() - prewarmStartedAt,
      glyphGenerationMilliseconds:
        prewarmResult.glyphPerformance.totalMilliseconds,
      glyphPerformance: prewarmResult.glyphPerformance,
      cache: prewarmResult.cache,
      fontInstances: Object.freeze(requests.map((request) =>
        Object.freeze({
          fontFamily: request.fontFamily,
          contentDigest: request.contentDigest,
          weight: request.weight,
          variationWidth: request.variationWidth,
          variationSlant: request.variationSlant,
          opticalSize: request.opticalSize,
          devicePixelSize: request.devicePixelSize,
          glyphIds: Object.freeze([...request.glyphIds]),
        })
      )),
    });
  }

  // DOM records carry native font indices. Direct authored scenes resolve
  // each distinct face once within this scene, with separate dimensions.
  function resolveFontIndices(nodes) {
    if (nodes._corePublication) return nodes;
    const plan = createFontRequestPlan(core, nodes, 0);
    try {
      if (plan.requests.length === 0) return nodes;
      const fonts = plan.requests.map((request) => {
        const family = request.familyKind === FONT_REQUEST_CSS_FAMILY
          ? fontStackKeysForCssValue(request.family)[0] : request.family;
        return registerFontBytes(family, request.weight, request.stretch,
          fontFileFor(family, request.weight, request.style, request.stretch, request.slope));
      });
      return nodes.map((node, index) => plan.indices[index] < 0
        ? node : { ...node, fontIndex: fonts[plan.indices[index]] });
    } finally {
      core.status("font_requests_release", plan.handle);
    }
  }

  // Native image joins own indices and resource lifetimes. The host retains
  // only pixel descriptors, canvas sources and decoder effects.
  const imagePixelsByIndex = new Map();
  // The renderer's resource engine scope, created on first use by any
  // resource (an image, a font face, an engine resource) and again after
  // releaseRenderContexts: each new scope takes the font registry's engine
  // sources, which the old scope held.
  let resourceEngineScope = 0n;
  function ensureResourceScope() {
    if (resourceEngineScope === 0n) {
      resourceEngineScope = core.resourceEngineCreate();
      fontRegistry.replayEngineSources();
    }
    return resourceEngineScope;
  }
  const { prepareImages, prepareImagesSync, registerDecodedImage, canvasImageEntry, releasePixels } =
    createImageResourceBinding({
      core,
      ensureScope: ensureResourceScope,
      pixels: imagePixelsByIndex,
      decode: decodeImageEntry,
      decodeIcon: () => brokenImageIconEntry(svgImageDensity),
      failureCode: brokenImageFailureCode,
    });

  function joinEngineResource(resource, index, variant = 0) {
    const scope = ensureResourceScope();
    core.resourceEngineBind(scope, resource, index, variant);
    return core.resourceEngineIndex(scope, core.resourceId(resource), variant);
  }

  const fontSourceDecoder = new TextDecoder();
  fontRegistry.attachEngineSourceTransport({
    // A released face no longer names the engine instances it registered.
    release({ resourceHandle }) {
      core.status("font_registration_forget", fontRegistry.fontCatalogHandle, resourceHandle);
    },
    // The renderer's resource engine scope (ensureResourceScope).
    ensureScope() {
      return ensureResourceScope();
    },
    // The core registered engine instance `index` of a face whose bytes it
    // keeps (font_hosted_face_supply, font_runtime_face_publish); the
    // renderer keeps its inspection records, with the coordinates the engine
    // registered.
    recordFaceInstance(index, { family, weight, stretch, face, resourceHandle, document }) {
      const entry = FONT_TABLE_BASE + index * FONT_TABLE_ENTRY_SIZE;
      const variation = FONT_VARIATION_TABLE_BASE + index * FONT_VARIATION_TABLE_ENTRY_SIZE;
      recordFontInstance(index, {
        family, weight, stretch, bytes: face.bytes, faceIndex: face.faceIndex ?? 0,
        finalURL: face.finalURL, resourceHandle, document,
        registeredWeight: view.getUint16(entry + FONT_TABLE_OFFSET_WEIGHT, true),
        registeredWidth: view.getFloat32(variation + FONT_VARIATION_OFFSET_WIDTH, true),
        registeredSlant: view.getFloat32(variation + FONT_VARIATION_OFFSET_SLANT, true),
      });
    },
    prepare(root, defaultFamilyKey, importSource, computedRead) {
      synchronizeFallbackCoverage();
      core.status("font_catalog_render_bind", fontRegistry.fontCatalogHandle,
        ensureResourceScope(), root._coreHandle, ...core.input(defaultFamilyKey));
      const count = core.status("font_catalog_source_requests", computedRead ? root._coreHandle : 0n);
      if (count === 0) return;
      const base = core.exports.abi_output_pointer();
      const requestView = new DataView(core.memory.buffer);
      const requests = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = base + index * FONT_SOURCE_REQUEST.SIZE;
        const pointer = requestView.getUint32(row + FONT_SOURCE_REQUEST.FAMILY_POINTER, true);
        const length = requestView.getUint32(row + FONT_SOURCE_REQUEST.FAMILY_LENGTH, true);
        requests[index] = {
          family: fontSourceDecoder.decode(new Uint8Array(core.memory.buffer, pointer, length)),
          weight: requestView.getUint32(row + FONT_SOURCE_REQUEST.WEIGHT, true),
          style: requestView.getUint32(row + FONT_SOURCE_REQUEST.STYLE, true) === 0 ? "normal" : "italic",
        };
      }
      for (const request of requests) importSource(request.family, request.weight, request.style);
    },
  });

  // Registry fallback families (design/font-fallback.md, decision 7): the
  // engine holds the coverage index of this runtime's registry and asks for
  // a face only when a missing range needs it. The registry reads its
  // fallback families when asked (installBundledSystemFonts can run after
  // the default runtime exists), so each font publication of a frame loads
  // a changed index before layout.
  let engineFallbackFamilies = null;
  function synchronizeFallbackCoverage() {
    const fallbackFamilies = fontRegistry.fallbackFamilies;
    if (fallbackFamilies === engineFallbackFamilies) return;
    engineFallbackFamilies = fallbackFamilies;
    if (fallbackFamilies === null) {
      engine.exports.font_coverage_set(0, 0, 0, 0, 0);
      return;
    }
    const { ranges, defaultCount, languages } = fallbackFamilies.coverage;
    core.status(
      "font_coverage_publish",
      ...(ranges.length === 0 ? [0, 0] : core.byteInput(ranges)),
      defaultCount,
      ...core.valueListInput(languages.flatMap((tag) => [tag, tag.toLowerCase()])),
      languages.length,
    );
  }
  synchronizeFallbackCoverage();

  // Decision 7: the engine's font requests are the registry fallback faces
  // that a shaped range needs and the host has not loaded. Loads each one
  // (a failed load throws with the family, the URL and the cause),
  // registers it, and answers; every text then shapes again. The engine
  // also requests the unloaded unicode-range faces that a shaped range or
  // a primary face needs (answerRangeFaces). Returns null without a
  // request, so that a frame without one does not yield to another engine
  // writer after its emission; else a promise that settles once each
  // request is answered, after which the caller lays out again.
  function answerFallbackFaces() {
    const count = engine.exports.font_fallback_request_count();
    const rangeCount = engine.exports.font_range_request_count();
    if (count === 0 && rangeCount === 0) return null;
    const answers = rangeCount === 0 ? [] : [answerRangeFaces(rangeCount)];
    if (count === 0) return Promise.all(answers);
    const fallbackFamilies = fontRegistry.fallbackFamilies;
    if (fallbackFamilies === null) {
      throw new Error(`The engine requested ${count} fallback faces, and the font registry has no fallbackFamilies`);
    }
    const requests = Array.from({ length: count }, (_, index) => ({
      family: engine.exports.font_fallback_request_family(index),
      style: engine.exports.font_fallback_request_style(index),
      weight: fontRegistry.fontWeightInCssUnits(engine.exports.font_fallback_request_weight(index)),
      italic: engine.exports.font_fallback_request_italic(index) === 1,
    }));
    answers.push(Promise.all(requests.map(({ family, weight, italic }) =>
      fallbackFamilies.load(family, weight, italic ? "italic" : "normal")
    )).then((faces) => registerFallbackFaces(requests, faces)));
    return Promise.all(answers);
  }

  // design/text-rendering.md, "unicode-range faces", item 3: loads the @font-face rule
  // of each requested unicode-range face (fontRegistry.loadDeclaredFace),
  // then answers with the engine font of the loaded face at the weight and
  // style of the request. A failed load answers FONT_STACK_UNLOADED, and
  // shaping skips the face, as Chrome skips a face that fails to load; the
  // font resource of the rule keeps the failure (resourceDiagnostics).
  function answerRangeFaces(count) {
    const requests = Array.from({ length: count }, (_, index) => ({
      face: engine.exports.font_range_request_face(index),
      style: engine.exports.font_range_request_style(index),
    }));
    return Promise.all(requests.map(({ face }) =>
      fontRegistry.loadDeclaredFace(face).then(() => true, () => false)
    )).then((loaded) => {
      for (const [index, { face, style }] of requests.entries()) {
        core.status("font_range_settle", face, style, loaded[index] ? 1 : 0);
      }
    });
  }

  function registerFallbackFaces(requests, faces) {
    for (const [index, { family, style, weight }] of requests.entries()) {
      const face = faces[index];
      const fontIndex = registerFontBytes(`fallback:${face.family}`, weight, 100, {
        bytes: face.bytes, faceIndex: face.faceIndex,
        faceIdentity: face.finalURL, finalURL: face.finalURL,
        variationWeight: weight, variationWidth: 100, variationSlant: 0, wghtOnAxis: true,
      });
      engine.exports.font_fallback_answer(family, style, fontIndex);
    }
  }

  let svgRasterRuntimePromise = null;
  async function svgRasterRuntime() {
    if (!svgRasterRuntimePromise) {
      svgRasterRuntimePromise = (async () => {
        const svgCore = new DomCore();
        const svgFonts = createFontRegistry({
          core: svgCore,
          sourceRegistry: fontRegistry,
        });
        try {
          const runtime = await createSceneRendererRuntime({
            core: svgCore,
            fontRegistry: svgFonts,
            codecRuntime,
            harfbuzzBytes,
            msdfgenBytes,
            graphicsDevice,
            svgImageRasterMode: true,
          });
          return { runtime, fonts: svgFonts };
        } catch (error) {
          svgFonts.dispose();
          throw error;
        }
      })().catch((error) => {
        svgRasterRuntimePromise = null;
        throw error;
      });
    }
    return await svgRasterRuntimePromise;
  }

  // The SVG raster runtime is one engine, and renderScenePixels on it is
  // not serialized (only the persistent renderers' frames are). The rasters
  // of a frame start together (selectSvgImageRasters), so the SVG rasters
  // take turns: a raster starts when the raster before it has submitted
  // its frame to the GPU, or has failed. It then parses and prepares its
  // scene while the raster before it waits for its pixels.
  //
  // This is safe because a render reads no engine memory after its
  // submission. After the emission and before its next await,
  // renderScenePixelsNow copies the commands, the scroll table, the
  // gradient stops and the boxes, and it reads its share of the shared work
  // counters before the raster await.
  // The raster reads all of the raster plan before the submission
  // (rasterize.js renderFrame), and the readback goes to host memory.
  // After the GPU wait, the raster only releases its own raster plan and
  // box snapshot, which no other render reads. Thus the next raster can
  // write the engine and grow its memory during the wait (test/images/image_test.js).
  // A raster of the same pixel size as a raster that has not finished
  // takes another render context of that size (withRenderContext).
  //
  // The rasters that submitted their frame and wait for its pixels.
  let svgRastersAwaitingPixels = 0;
  let svgRasterChain = Promise.resolve();
  function rasterizeSvgImage(svgImage, locator, density, viewport, svgImageTimings = null) {
    let endTurn;
    const turnEnded = new Promise((resolve) => {
      endTurn = resolve;
    });
    let awaitingPixels = false;
    const submitted = () => {
      awaitingPixels = true;
      svgRastersAwaitingPixels++;
      endTurn();
    };
    const run = svgRasterChain.then(() =>
      rasterizeSvgImageNow(
        svgImage,
        locator,
        density,
        viewport,
        svgImageTimings,
        svgRastersAwaitingPixels,
        submitted,
      )
    );
    // A failed raster also ends its turn: it must not fail the images
    // queued after it.
    const settled = () => {
      if (awaitingPixels) svgRastersAwaitingPixels--;
      endTurn();
    };
    run.then(settled, settled);
    svgRasterChain = turnEnded;
    return run;
  }

  // The device pixels per CSS pixel of the last frame, or null before the
  // first frame. An SVG image rasters at the device scale of each frame
  // that draws it, as a browser rasters an SVG image at its device pixels:
  // the decode registers the image without a raster, and each frame
  // selects the raster of its own scale for the images its commands draw
  // (selectSvgImageRasters). A canvas that reads an SVG image without a
  // raster rasters it at this scale, or at 1 before the first frame; each
  // frame also selects the broken image icon of this scale
  // (selectBrokenImageIcon).
  let svgImageDensity = null;

  // svgImage: the shared decode of the SVG resource (src/image-decode.js),
  // which checked the document. viewport: the size in whole CSS px, at
  // least one on each axis, of the image document's viewport
  // (svgImageViewport): an image with a zero natural width or height
  // loads, as in Chrome, and paints nothing in its empty box. The raster
  // has the viewport times `density`.
  // overlappedRasterCount: the rasters that waited for their pixels when
  // this raster started. submitted: called when this raster's frame goes
  // to the GPU (rasterizeSvgImage).
  async function rasterizeSvgImageNow(
    svgImage,
    locator,
    density,
    viewport,
    svgImageTimings,
    overlappedRasterCount,
    submitted,
  ) {
    const startedAt = hostNow();
    let stageStartedAt = startedAt;
    const stages = {
      source: locator,
      coldRuntime: !svgRasterRuntimePromise,
      overlappedRasterCount,
      moduleMilliseconds: 0,
      runtimeInitializationMilliseconds: 0,
      parseMilliseconds: 0,
      definitionsMilliseconds: 0,
      decorationMilliseconds: 0,
      pathPreparationMilliseconds: 0,
      atlasMilliseconds: 0,
      scenePreparationMilliseconds: 0,
      rasterMilliseconds: 0,
      pathGenerationCount: 0,
      totalMilliseconds: 0,
    };
    const [
      { SDDocument },
      { parseXMLDocument },
      { serializeToScene },
      { prepareSvgImageDefinitions },
    ] = await Promise.all([
      import("./dom/node.js"),
      import("./dom/xml.js"),
      import("./dom/serialize.js"),
      import("./dom/svg-image.js"),
    ]);
    let now = hostNow();
    stages.moduleMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const { runtime, fonts } = await svgRasterRuntime();
    now = hostNow();
    stages.runtimeInitializationMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const document = parseXMLDocument(
      svgImage.source,
      "image/svg+xml",
      () =>
        new SDDocument({
          core: runtime.core,
          fontRegistry: fonts,
          url: new URL(locator, "file:///").href,
        }),
    );
    const root = document.documentElement;
    now = hostNow();
    stages.parseMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const decorate = prepareSvgImageDefinitions(
      root, runtime.core, locator, stages,
    );
    now = hostNow();
    stages.definitionsMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const { width, height } = viewport;
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1)) {
      throw new Error(`Invalid SVG image viewport at ${locator}: ${width}x${height}`);
    }
    const generationBefore = runtime.sharedSvgPathAtlas.generationCount;
    const scene = {
      width,
      height,
      ...await decorate(serializeToScene(root, {
        viewportWidth: width,
        viewportHeight: height,
      }), runtime),
    };
    now = hostNow();
    stages.decorationMilliseconds = now - stageStartedAt -
      stages.pathPreparationMilliseconds;
    stageStartedAt = now;
    const renderPathTimings = {
      preparationMilliseconds: 0,
      atlasMilliseconds: 0,
    };
    const result = await runtime.renderScenePixels(scene, density, {
      background: { r: 0, g: 0, b: 0, a: 0 },
      svgPathStageTimings: renderPathTimings,
      onSubmitted: () => {
        // Count before the next raster adds paths to the shared atlas.
        stages.pathGenerationCount =
          runtime.sharedSvgPathAtlas.generationCount - generationBefore;
        submitted();
      },
    });
    now = hostNow();
    stages.pathPreparationMilliseconds += renderPathTimings.preparationMilliseconds;
    stages.atlasMilliseconds = renderPathTimings.atlasMilliseconds;
    stages.rasterMilliseconds = result.performance.rasterMilliseconds -
      stages.atlasMilliseconds;
    stages.scenePreparationMilliseconds = now - stageStartedAt -
      result.performance.rasterMilliseconds -
      renderPathTimings.preparationMilliseconds;
    releaseBoxSnapshot(result.boxes);
    stages.totalMilliseconds = hostNow() - startedAt;
    svgImageTimings?.push(Object.freeze(stages));
    return result;
  }

  // width and height: the pixels; naturalWidth and naturalHeight: the size
  // that layout reads, which differs for an SVG image rastered above one
  // device pixel per CSS pixel or with a zero natural dimension.
  function registeredImageEntry(
    descriptor,
    naturalWidth = descriptor.width,
    naturalHeight = descriptor.height,
  ) {
    const resolved = prepareImageProfile(descriptor);
    return {
      width: resolved.width,
      height: resolved.height,
      naturalWidth,
      naturalHeight,
      descriptor: resolved,
      // Degraded-backend flattening, derived once on first request; the
      // WebGPU path never touches it. An ICC-resolved descriptor (linear
      // XYZ D65 float32, built above) flattens here directly - the same
      // lossy eight-bit sRGB bake the degraded backend gets for every
      // image, with out-of-gamut channels clamped at the encode.
      get pixels() {
        let value;
        if (
          resolved.sampleType === "float32" &&
          resolved.colorEncoding.primaries === "xyz-d65" &&
          resolved.colorEncoding.transferFunction === "linear"
        ) {
          value = srgb8Pixels(resolved);
        } else {
          value = toSrgbRgba8(resolved).pixels;
        }
        Object.defineProperty(this, "pixels", { value });
        return value;
      },
    };
  }


  // The failure code the core keeps for a broken image
  // (image_failure_code).
  function brokenImageFailureCode(broken) {
    const type = broken.mediaType ?? null;
    return core.status("image_failure_code", broken.failure === "fetch" ? 1 : 0, ...core.input(type ?? ""), type === null ? 0 : 1);
  }

  // $mediaType is the resource's normalized media type, or null.
  function undecodableImage(locator, cause, mediaType) {
    const broken = Object.freeze({
      failure: "decode",
      mediaType,
      error: new Error(`Image ${locator}: ${cause.message}`, { cause }),
    });
    return broken;
  }


  // Host decode effect. The native request owns the image's index and state.
  // Document image loading and rendering share decodeImageResource.
  async function decodeImageEntry(resource, cacheKey) {
    const locator = resource.finalURL ?? cacheKey;
    let decoded;
    try {
      decoded = await decodeImageResource(resource, codecRuntime);
    } catch (error) {
      if (!(error instanceof UndecodableImageError)) {
        throw new Error(`Image ${locator}: ${error.message}`, { cause: error });
      }
      return undecodableImage(locator, error.cause ?? error, resource.mediaType ?? null);
    }
    if (decoded.kind === "raster") return registeredImageEntry(decoded.descriptor);
    return svgImageEntry(decoded, locator);
  }

  // The registration entry of a decoded SVG image: its natural size and
  // no pixels. width and height are those of the raster at density 1,
  // which the native join commits; defaultSized and naturalRatio tell the
  // engine to size an image without natural dimensions by the default
  // sizing algorithm. The frame that draws the image rasters it at its
  // own scale (selectSvgImageRasters). `svg` keeps the decode and the
  // rasters by density and viewport, which every entry of the image
  // shares, so a frame at a scale drawn before selects its raster again
  // without rastering.
  function svgImageEntry(decoded, locator) {
    const viewport = svgImageViewport(decoded, null);
    return {
      width: viewport.width,
      height: viewport.height,
      naturalWidth: core.exports.image_svg_natural(decoded.naturalWidth),
      naturalHeight: core.exports.image_svg_natural(decoded.naturalHeight),
      defaultSized: decoded.defaultSized,
      naturalRatio: decoded.naturalRatio ?? 0,
      svg: Object.freeze({ decoded, locator, density: null, viewport: null, rasters: new Map() }),
    };
  }

  // The viewport of an SVG image's raster in CSS px (image_svg_viewport),
  // drawn at the concrete object size `concrete` ([width, height] or null).
  function svgImageViewport(decoded, concrete) {
    const defaultSized = decoded.defaultSized ? 1 : 0;
    return {
      width: core.exports.image_svg_viewport(decoded.naturalWidth, defaultSized, concrete?.[0] ?? NaN),
      height: core.exports.image_svg_viewport(decoded.naturalHeight, defaultSized, concrete?.[1] ?? NaN),
    };
  }

  // The entry of an SVG image with pixels at `density` and `viewport`,
  // kept or made. A raster in progress is shared; a failed raster is not
  // kept.
  function svgImageRaster(entry, density, viewport, svgImageTimings = null) {
    const { decoded, locator, rasters } = entry.svg;
    const key = `${density}:${viewport.width}x${viewport.height}`;
    let raster = rasters.get(key);
    if (raster === undefined) {
      raster = rasterizeSvgImage(decoded, locator, density, viewport, svgImageTimings).then((result) => {
        const rastered = registeredImageEntry(
          result,
          core.exports.image_svg_natural(decoded.naturalWidth),
          core.exports.image_svg_natural(decoded.naturalHeight),
        );
        rastered.defaultSized = decoded.defaultSized;
        rastered.naturalRatio = decoded.naturalRatio ?? 0;
        rastered.svg = Object.freeze({ decoded, locator, density, viewport, rasters });
        return rastered;
      });
      rasters.set(key, raster);
      raster.catch(() => {
        if (rasters.get(key) === raster) rasters.delete(key);
      });
    }
    return raster;
  }

  // The images and color glyph bitmap slots that the engine's last
  // emission of `bytesWritten` command bytes draws (frame_drawn_scan), read
  // before the frame awaits: another engine writer may emit after. The scan
  // writes into the commands the index of each concrete size of an image
  // without natural dimensions, so it runs before the frame copies them.
  // Each image row names the index that its draws name and the base index
  // whose decode it draws.
  function drawnImagesAndSlots(bytesWritten) {
    const imageCount = engine.exports.frame_drawn_scan(bytesWritten);
    if (imageCount === DRAWN_SCAN_TABLE_FULL) {
      core.throwIfError();
      throw new Error("The engine's image draws need more image indices than the image table has free");
    }
    if (imageCount < 0) {
      throw new Error(
        `The engine's ${bytesWritten} command bytes hold an unknown or truncated command at byte ` +
          `${engine.exports.frame_drawn_failed_offset()}`,
      );
    }
    const images = new Array(imageCount);
    for (let row = 0; row < imageCount; row++) {
      const width = engine.exports.frame_drawn_image_concrete(row, 0);
      images[row] = {
        imageIndex: engine.exports.frame_drawn_image(row),
        baseIndex: engine.exports.frame_drawn_image_base(row),
        concrete: Number.isNaN(width) ? null : [width, engine.exports.frame_drawn_image_concrete(row, 1)],
      };
    }
    const slots = Array.from(
      { length: engine.exports.frame_drawn_slot_count() },
      (_, row) => engine.exports.frame_drawn_slot(row),
    );
    return { images, slots };
  }

  // Gives each SVG image index that the frame's commands draw its raster at
  // `density`, kept or made. An image without natural dimensions rasters
  // with its viewport at the concrete object size of its draw
  // (frame_drawn_scan, with the engine's natural ratio, as layout sizes the
  // image): the scan gives each concrete size its own index, a size variant
  // of the image's index, and the variant's entry is a raster of the base
  // index's decode. Images that the frame does not draw keep their entry:
  // the runtime also holds the images of other documents. The entry
  // replaces the one at the same index, as a color glyph bitmap of another
  // size does; the GPU texture follows the entry. The rasters to make start
  // at once and take turns (rasterizeSvgImage).
  async function selectSvgImageRasters(drawnImages, density, svgImageTimings) {
    const selections = [];
    for (const { imageIndex, baseIndex, concrete } of drawnImages) {
      const base = imagePixelsByIndex.get(baseIndex);
      if (base?.svg === undefined) continue;
      const current = imagePixelsByIndex.get(imageIndex);
      const viewport = svgImageViewport(base.svg.decoded, base.defaultSized ? concrete : null);
      if (
        current?.svg?.decoded === base.svg.decoded && current.svg.density === density &&
        current.svg.viewport.width === viewport.width && current.svg.viewport.height === viewport.height
      ) continue;
      selections.push({
        imageIndex,
        baseIndex,
        decoded: base.svg.decoded,
        current,
        selected: svgImageRaster(base, density, viewport, svgImageTimings),
      });
    }
    const selected = await Promise.all(
      selections.map((selection) => selection.selected),
    );
    // An index whose entry changed during the rasters, or whose base no
    // longer holds the decode (a release), keeps that change.
    selections.forEach(({ imageIndex, baseIndex, decoded, current }, index) => {
      if (
        imagePixelsByIndex.get(imageIndex) === current &&
        imagePixelsByIndex.get(baseIndex)?.svg?.decoded === decoded
      ) imagePixelsByIndex.set(imageIndex, selected[index]);
    });
  }

  // A canvas reads the pixels of an image outside a frame: an SVG image
  // without a raster rasters at its natural size (the default object size
  // for an image without natural dimensions), at the density of the last
  // frame, or at 1 before the first frame.
  async function canvasImagePixels(resource) {
    const entry = await canvasImageEntry(resource);
    if (entry?.svg?.density !== null || entry === null) return entry;
    return await svgImageRaster(entry, svgImageDensity ?? 1, svgImageViewport(entry.svg.decoded, null));
  }

  // Chromium's broken image icon (src/broken-image-icon.js), which the
  // alternative text of an img or an image input shows (box kind 17, node
  // brokenImageIcon). The native join gives it one index with the 14 by 16
  // natural size. Each frame selects the entry of its device scale
  // (selectBrokenImageIcon), as Blink's LayoutImageResource::BrokenImage
  // does: the 28 by 32 icon at 2 or more, else the 14 by 16 icon. The GPU
  // texture follows the entry.
  const brokenImageIconEntries = new Map(); // 1 | 2 -> Promise<entry>
  function brokenImageIconEntry(density) {
    const variant = core.exports.image_broken_icon_variant(density);
    let entry = brokenImageIconEntries.get(variant);
    if (entry === undefined) {
      entry = decodeImage(variant === BROKEN_IMAGE_ICON_2X ? BROKEN_IMAGE_ICON_2X_PNG : BROKEN_IMAGE_ICON_PNG)
        .then((decoded) => registeredImageEntry(decoded, BROKEN_IMAGE_ICON_WIDTH, BROKEN_IMAGE_ICON_HEIGHT));
      brokenImageIconEntries.set(variant, entry);
    }
    return entry;
  }
  async function selectBrokenImageIcon() {
    if (brokenImageIconEntries.size === 0) return;
    const icons = new Set(await Promise.all(brokenImageIconEntries.values()));
    const selected = await brokenImageIconEntry(svgImageDensity);
    for (const [imageIndex, entry] of imagePixelsByIndex) {
      if (icons.has(entry) && entry !== selected) imagePixelsByIndex.set(imageIndex, selected);
    }
  }

  function imagePixelsFor(imageIndex) {
    return imagePixelsByIndex.get(imageIndex);
  }


  // A synchronous layout can precede the host's decode completion.
  function hasUnresolvedImage(row) {
    const unresolved = (layer) => layer.src && layer.imageIndex === undefined;
    return Boolean(row.src) && row.imageIndex === undefined ||
      row.resolvedBackgroundImages?.some(unresolved) === true ||
      row.resolvedMasks?.some(unresolved) === true;
  }

  // render()'s `images` option wants imageIndex -> { width, height, pixels }
  // (RGBA8) for the CMD_IMAGE GPU-texture-per-draw upload. The decoded
  // image cache already holds every registered image, keyed by the same
  // index that CMD_IMAGE commands reference.
  function buildImageRenderResources() {
    return imagePixelsByIndex;
  }
  // An SVG image without a raster (one that no frame has drawn) is no
  // raster resource: the raster plan then skips its commands, which draw
  // nothing (selectSvgImageRasters rasters every image that a frame draws).
  function synchronizeImageRasterResources() {
    for (const [imageIndex, image] of imagePixelsByIndex) {
      if (image.svg?.density === null) {
        engine.exports.raster_resource_table_release(RASTER_RESOURCE_IMAGE, imageIndex);
        continue;
      }
      const kind = image.kind === "canvas" ? RASTER_IMAGE_KIND_CANVAS : RASTER_IMAGE_KIND_DECODED;
      const count = image.glyphBox ? COLOR_GLYPH_IMAGE_RESOURCE_COUNT : 1;
      const pointer = engine.exports.raster_resource_table_reserve(
        RASTER_RESOURCE_IMAGE,
        imageIndex,
        count,
      );
      if (pointer === 0) {
        throw new Error(
          `raster image resource ${imageIndex} (${image.width}×${image.height}) could not be reserved`,
        );
      }
      const records = new Float32Array(engine.memory.buffer, pointer, count * RASTER_IMAGE_RECORD.FLOATS);
      records[RASTER_IMAGE_RECORD.WIDTH] = image.width;
      records[RASTER_IMAGE_RECORD.HEIGHT] = image.height;
      records[RASTER_IMAGE_RECORD.KIND] = kind;
      if (image.glyphBox) records.set(image.glyphBox, RASTER_IMAGE_RECORD.FLOATS);
    }
  }

  // Bitmap glyphs (design/text-rendering.md, "Colour glyphs"): a CMD_IMAGE with
  // CMD_IMAGE_FLAG_GLYPH_BITMAP names the engine's bitmap slot (font,
  // glyph, CSS font size) at COLOR_GLYPH_IMAGE_INDEX_BASE + slot. At the
  // target's device scale the engine's strike chooser picks the strike and
  // locates its PNG; the PNG decodes once for each strike and glyph, and
  // the image entry carries the strike's image box in ems of the font size
  // (left, top, width, height, y down from the origin) and whether the
  // origin is a whole device pixel (sbix) for the raster plan.
  const colorGlyphBitmapBySlot = new Map(); // slot -> { requested, entry }
  const colorGlyphBitmapDecodes = new Map(); // "pointer:length" -> { png, image }
  async function prepareColorGlyphBitmaps(slots, deviceScale) {
    const slotCount = engine.exports.color_glyph_bitmap_count();
    if (slotCount === 0) return;
    for (const slot of slots) {
      if (slot >= slotCount) {
        throw new Error(
          `CMD_IMAGE names color glyph bitmap slot ${slot}, but the engine registered ${slotCount}; ` +
            "the command buffer and the engine disagree",
        );
      }
      const requested = Math.fround(engine.exports.color_glyph_bitmap_font_size(slot) * deviceScale);
      if (colorGlyphBitmapBySlot.get(slot)?.requested === requested) continue;
      const imageIndex = COLOR_GLYPH_IMAGE_INDEX_BASE + slot;
      colorGlyphBitmapBySlot.delete(slot);
      imagePixelsByIndex.delete(imageIndex);
      engine.exports.raster_resource_table_release(RASTER_RESOURCE_IMAGE, imageIndex);
      // 0: the slot's font changed, or the chosen strike has no image for
      // the glyph; the command then draws nothing.
      if (engine.exports.color_glyph_bitmap_select(slot, requested) === 0) continue;
      const pointer = engine.exports.color_glyph_bitmap_png_pointer();
      const length = engine.exports.color_glyph_bitmap_png_length();
      const ppem = engine.exports.color_glyph_bitmap_metric(4);
      const glyphBox = [
        engine.exports.color_glyph_bitmap_metric(0) / ppem,
        -engine.exports.color_glyph_bitmap_metric(1) / ppem,
        engine.exports.color_glyph_bitmap_metric(2) / ppem,
        engine.exports.color_glyph_bitmap_metric(3) / ppem,
        engine.exports.color_glyph_bitmap_metric(5),
      ];
      const png = new Uint8Array(engine.memory.buffer, pointer, length).slice();
      const decodeKey = `${pointer}:${length}`;
      let decoded = colorGlyphBitmapDecodes.get(decodeKey);
      if (decoded === undefined || !decoded.png.every((byte, index) => byte === png[index])) {
        decoded = { png, image: registeredImageEntry(await decodeImage(png)) };
        colorGlyphBitmapDecodes.set(decodeKey, decoded);
      }
      const { image } = decoded;
      const entry = {
        width: image.width,
        height: image.height,
        descriptor: image.descriptor,
        get pixels() {
          return image.pixels;
        },
        glyphBox,
      };
      imagePixelsByIndex.set(imageIndex, entry);
      colorGlyphBitmapBySlot.set(slot, { requested, entry });
    }
  }

  function bindPathRasterAtlas(atlas) {
    engine.exports.raster_bind_path_atlas(atlas.id, Number(atlas.coverageMode));
  }

  function restorePathRasterAtlas() {
    bindPathRasterAtlas(sharedSvgPathAtlas);
  }

  // Authored paths register in the same native identity space as DOM paths.
  // A definition is immutable while its index keeps its generation: the
  // core releases unused paths and gives a reused index a new generation
  // (core/dom/path-collection.watpart).
  const svgPathDefByIndex = new Map(); // pathIndex -> { generation, definition }
  function svgPathDefinitionCurrent(pathIndex) {
    const generation = core.exports.svg_path_generation(pathIndex);
    const cached = svgPathDefByIndex.get(pathIndex);
    if (cached?.generation === generation) return cached.definition;
    const definition = { ...core.svgPathDefinition(pathIndex), generation };
    svgPathDefByIndex.set(pathIndex, { generation, definition });
    return definition;
  }
  const sharedSvgPathAtlas = new SvgPathAtlas({
    coverageMode: svgImageRasterMode,
  });
  // COLR glyphs of axis-aligned, unscaled text draw from RGBA atlas pages
  // (src/color-glyph-cache.js); setColorGlyphCacheEnabled(false) keeps
  // their commands, the pixels the cache reproduces.
  const colorGlyphCache = createColorGlyphCache({
    engine,
    graphicsStateOwner,
    pathAtlas: new SvgPathAtlas({ coverageMode: svgImageRasterMode }),
    svgPathEnsures,
    bindPathRasterAtlas,
    restorePathRasterAtlas,
  });
  engine.exports.color_glyph_cache_enable(1);

  // The outline of a color glyph layer (design/text-rendering.md, "Colour glyphs"): the
  // engine's path slot names a registered font and a glyph; the core writes
  // its outline at the shaping scale as a `d` string in font units, y down
  // (svg_path_definition) — the box the engine measured for the slot's
  // CMD_SVG_PATH dest rect.
  const colorGlyphPathDefs = new Map(); // pathIndex -> { key, def }
  // Relative agreement of the engine's layer box with the atlas bounds.
  // Both measure the same f32 outline coordinates; the engine stores its
  // box (curve extrema included) in f32, so a curve extremum may round
  // differently by an f32 step (2^-23 relative). Measured 2026-10-05 on
  // the 120 box corners of test/text/text_color_glyph_test.js: 0.
  const COLOR_GLYPH_BOX_TOLERANCE = 2 ** -22;
  function colorGlyphPathDef(pathIndex) {
    const { pathDef, fillRule } = core.svgPathDefinition(pathIndex);
    const slot = pathIndex - COLOR_GLYPH_PATH_INDEX_BASE;
    const key = engine.exports.color_glyph_path_key(slot);
    const cached = colorGlyphPathDefs.get(pathIndex);
    if (cached?.key === key) return cached.def;
    const def = { pathDef, fillRule };
    // The command places the atlas entry's bounds on the engine's box: the
    // two measure the same outline, so they agree to the rounding of the
    // engine's f32 box (see COLOR_GLYPH_BOX_TOLERANCE).
    const bounds = svgPathBboxSync(def.pathDef, def.fillRule);
    const measured = [bounds.xMin, bounds.yMin, bounds.xMax, bounds.yMax];
    // The atlas measures a sliver of (near) zero area as an empty shape,
    // which has no coverage to stretch (Noto Color Emoji U+1F602 has one,
    // an 18-unit two-curve contour enclosing ~0 area).
    const atlasEmpty = measured.every((value) => value === 0);
    for (let corner = 0; corner < 4 && !atlasEmpty; corner++) {
      const engineValue = engine.exports.color_glyph_path_box(slot, corner);
      const tolerance = COLOR_GLYPH_BOX_TOLERANCE * Math.max(1, Math.abs(engineValue));
      if (!(Math.abs(engineValue - measured[corner]) <= tolerance)) {
        throw new Error(
          `color glyph ${key & 0xffff} of font ${key >>> 16}: the engine's layer box ` +
            `[${[0, 1, 2, 3].map((index) => engine.exports.color_glyph_path_box(slot, index)).join(", ")}] ` +
            `and the path atlas bounds [${measured.join(", ")}] differ by more than ${COLOR_GLYPH_BOX_TOLERANCE} ` +
            "relative; the layer would be stretched. The engine's outline box (engine-color-glyph.watpart " +
            "$cgPathSlot) and the atlas measurement must describe the same outline. The outline: " + def.pathDef,
        );
      }
    }
    colorGlyphPathDefs.set(pathIndex, { key, def });
    return def;
  }

  // The path a CMD_SVG_PATH index names: a host SVG path, or an outline
  // the core defines (a color glyph outline, a stroked glyph outline of SVG
  // text, or a built-in outline).
  function pathDefForIndex(pathIndex) {
    const source = engine.exports.path_index_source(pathIndex);
    if (source === PATH_SOURCE_COLOR_GLYPH) return colorGlyphPathDef(pathIndex);
    if (source === PATH_SOURCE_SVG) return svgPathDefinitionCurrent(pathIndex);
    const { pathDef, fillRule, stroke } = core.svgPathDefinition(pathIndex);
    return { pathDef, fillRule, stroke };
  }

  function svgPathBboxSync(pathDef, fillRule) {
    return sharedSvgPathAtlas.measurePathBoundsSync(pathDef, fillRule);
  }

  function nativePathRequests(snapshot = null) {
    if (snapshot === null) {
      snapshot = new Uint8Array(engine.memory.buffer,
        engine.exports.glyph_request_table_base(),
        engine.exports.glyph_request_table_bytes()).slice();
    }
    const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
    const requests = [];
    for (let offset = GLYPH_REQUEST_HEADER_SIZE; offset < snapshot.byteLength;) {
      const size = glyphRequestRowByteSize(view, offset);
      if (view.getUint16(offset + GLYPH_REQUEST_KIND, true) === GLYPH_REQUEST_KIND_PATH) {
        const pathIndex = view.getUint32(offset + GLYPH_REQUEST_PATH_INDEX, true);
        // Color glyph and text stroke slots are the engine's; the core
        // writes their definitions from its current slots.
        const source = engine.exports.path_index_source(pathIndex);
        const engineSlot = source === PATH_SOURCE_COLOR_GLYPH || source === PATH_SOURCE_TEXT_STROKE;
        const definition = engineSlot ? core.svgPathDefinition(pathIndex) : svgPathDefinitionCurrent(pathIndex);
        requests.push({
          ...definition,
          pathIndex,
          screenSize: view.getFloat64(offset + GLYPH_REQUEST_PATH_SCREEN_SIZE, true),
          coverage: view.getUint16(offset + GLYPH_REQUEST_PATH_COVERAGE, true) !== 0,
        });
      }
      offset += size;
    }
    return requests;
  }

  function svgPathPublications(nodes) {
    const publications = new Set();
    for (const node of nodes) {
      if (node._corePublication?.core !== core) {
        throw new TypeError("SVG preparation requires a native publication from this renderer core");
      }
      publications.add(node._corePublication);
    }
    return publications;
  }


  async function prepareSvgPathResources(nodes) {
    for (const publication of svgPathPublications(nodes)) {
      if (core.status("scene_svg_path_prepare", publication.handle) === 0) continue;
      await sharedSvgPathAtlas.ensurePaths(nativePathRequests());
      core.status("scene_svg_path_complete", publication.handle, sharedSvgPathAtlas.id);
    }
    return nodes;
  }

  function prepareSvgPathResourcesSync(nodes) {
    for (const publication of svgPathPublications(nodes)) {
      if (core.status("scene_svg_path_prepare", publication.handle) === 0) continue;
      sharedSvgPathAtlas.ensurePathsSync(nativePathRequests());
      core.status("scene_svg_path_complete", publication.handle, sharedSvgPathAtlas.id);
    }
    return nodes;
  }

  // The publication phase initializes the path atlas before native rows are
  // installed. Resolution and metric completion stay in this synchronous turn:
  // an awaited resource load could replace the shared engine's current rows.
  function prepareLayoutSvgGeometry(count, width, height) {
    const preparation = core.status("scene_svg_geometry_prepare", count, width, height);
    if (preparation >>> SVG_GEOMETRY_REQUESTS_SHIFT) {
      sharedSvgPathAtlas.ensurePathsSync(nativePathRequests());
      core.status("scene_svg_geometry_complete", count, sharedSvgPathAtlas.id);
    }
    return (preparation & SVG_GEOMETRY_CHANGED) !== 0;
  }

  // Capture at emission, before user callbacks or asynchronous resource preparation.
  function captureTextRequestPublication(owner, previous, glyphBufferUnchanged, glyphResourceManager, generationBackend) {
    const requestRevision = engine.exports.glyph_request_revision();
    const reusable = owner !== null && previous?.publicationOwner === owner &&
      previous.engineMemory === engine.memory && previous.requestRevision === requestRevision &&
      previous.glyphResourceManager === glyphResourceManager && previous.glyphLease?.active === true &&
      previous.generationBackend.kind === generationBackend.kind &&
      previous.generationBackend.device === generationBackend.device;
    if (reusable && glyphBufferUnchanged) return previous;
    const glyphBase = engine.exports.glyph_buffer_base();
    const glyphBuffer = new Uint8Array(engine.memory.buffer, glyphBase, engine.exports.glyph_bytes()).slice();
    if (reusable) return { ...previous, glyphBuffer };
    const requestBase = engine.exports.glyph_request_table_base();
    const requestBytes = engine.exports.glyph_request_table_bytes();
    const requestSnapshot = new Uint8Array(engine.memory.buffer, requestBase, requestBytes).slice();
    const header = new DataView(requestSnapshot.buffer);
    const requestRowCount = header.getUint32(GLYPH_REQUEST_COUNT, true);
    const publishedRevision = header.getUint32(GLYPH_REQUEST_REVISION, true);
    if (requestBytes !== GLYPH_REQUEST_HEADER_SIZE + requestRowCount * GLYPH_REQUEST_ROW_SIZE ||
      publishedRevision !== requestRevision) {
      throw new Error(`Glyph request publication has ${requestBytes} bytes, ${requestRowCount} rows, and revision ${publishedRevision}; expected revision ${requestRevision} and complete ${GLYPH_REQUEST_ROW_SIZE}-byte rows`);
    }
    return { requestRevision, requestRowCount, requestSnapshot, glyphBuffer,
      engineMemory: engine.memory, publicationOwner: owner, glyphResourceManager, generationBackend, glyphLease: null };
  }


  // Native request rows already include draw transforms, clip masks and
  // density: they are every path entry the frame draws, so the frame begins
  // here and the atlas may free the entries it leaves unused.
  async function buildSvgPathRenderResources(requestSnapshot) {
    const requests = nativePathRequests(requestSnapshot);
    if (requests.length) {
      sharedSvgPathAtlas.beginFrame();
      await sharedSvgPathAtlas.ensurePaths(requests);
    }
    sharedSvgPathAtlas.rebuildAtlas();
    bindPathRasterAtlas(sharedSvgPathAtlas);
    return sharedSvgPathAtlas;
  }

  // The path atlas entries the CMD_SVG_PATH commands and path-mask clip
  // entries of a command stream draw at `deviceScale`: every command's
  // entry, and the ensure of each path index.
  function svgPathEnsures(cmdView, bytesWritten, deviceScale) {
    const entries = [];
    let off = 0;
    while (off < bytesWritten) {
      const opcode = cmdView.getUint8(off);
      if (opcode === CMD_SVG_PATH) {
        const flags = cmdView.getUint8(off + CMD_SVG_PATH_OFFSET_FLAGS);
        const pathIndex = cmdView.getUint16(
          off + CMD_SVG_PATH_OFFSET_INDEX,
          true,
        );
        const destW = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_W, true) *
          deviceScale;
        const destH = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_H, true) *
          deviceScale;
        // design/svg-rendering.md invariant 3: destW/destH is the RAW
        // bbox — the command's own affine (transform block, when present) is
        // stored SEPARATELY, not pre-applied to the dest rect. Fold its
        // linear part's per-axis scale magnitude in so screenSize reflects
        // the true on-screen footprint under a scaling viewBox (e.g. a small
        // viewBox in a large viewport) or a scaling CSS transform on an
        // ancestor, not just the identity case every prior gallery/test
        // happened to use.
        let scaleX = 1, scaleY = 1;
        if (flags & CMD_SVG_PATH_FLAG_TRANSFORM) {
          const a = cmdView.getFloat32(off + CMD_SVG_PATH_OFFSET_XFORM, true);
          const b = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + F32,
            true,
          );
          const c = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 2 * F32,
            true,
          );
          const d = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 3 * F32,
            true,
          );
          scaleX = Math.hypot(a, b);
          scaleY = Math.hypot(c, d);
        }
        const def = pathDefForIndex(pathIndex);
        if (def) {
          entries.push({
            pathIndex,
            pathDef: def.pathDef,
            fillRule: def.fillRule,
            stroke: def.stroke,
            destW,
            destH,
            scaleX,
            scaleY,
          });
        }
      } else if (opcode === CMD_PUSH_CLIP) {
        const count = cmdView.getUint16(off + CMD_PUSH_CLIP_OFFSET_COUNT, true);
        for (let index = 0; index < count; index++) {
          const entry = off + CMD_PUSH_CLIP_HEADER_SIZE +
            index * CLIP_ENTRY_SIZE;
          const flags = cmdView.getUint8(entry + CLIP_ENTRY_OFFSET_FLAGS);
          if (!(flags & CLIP_ENTRY_FLAG_PATH_MASK)) continue;
          const payload = entry + CLIP_ENTRY_OFFSET_RADII;
          const pathIndex = cmdView.getUint32(payload + CLIP_ENTRY_PATH.INDEX, true);
          const coordinateScale = cmdView.getFloat32(payload + CLIP_ENTRY_PATH.SCALE, true) *
            deviceScale;
          const destW = (cmdView.getFloat32(payload + CLIP_ENTRY_PATH.X_MAX, true) -
            cmdView.getFloat32(payload + CLIP_ENTRY_PATH.X_MIN, true)) * coordinateScale;
          const destH = (cmdView.getFloat32(payload + CLIP_ENTRY_PATH.Y_MAX, true) -
            cmdView.getFloat32(payload + CLIP_ENTRY_PATH.Y_MIN, true)) * coordinateScale;
          let scaleX = 1;
          let scaleY = 1;
          if (flags & CLIP_ENTRY_FLAG_AFFINE) {
            const a = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE,
              true,
            );
            const b = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + F32,
              true,
            );
            const c = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 2 * F32,
              true,
            );
            const d = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 3 * F32,
              true,
            );
            scaleX = Math.hypot(a, b);
            scaleY = Math.hypot(c, d);
          }
          const def = pathDefForIndex(pathIndex);
          if (def) {
            entries.push({
              pathIndex,
              pathDef: def.pathDef,
              fillRule: def.fillRule,
              destW,
              destH,
              scaleX,
              scaleY,
            });
          }
        }
      }
      off += commandByteSize(cmdView, off);
      commandDecodeWork.commands++;
    }
    // screenSize is the on-screen footprint's max dimension — destW/destH
    // (the raw bbox) scaled by the command's own affine, when one is
    // present. No-transform commands keep today's behavior exactly (factor
    // 1×1). A path index names one atlas entry, the last one ensured for
    // it (every command of the index draws that entry), so only its last
    // command's entry is ensured: ensuring the others too made a path
    // drawn at two sizes re-alias, and the atlas rebuild and upload again,
    // every frame (a color glyph layer outline that two glyphs share).
    const ensureByPathIndex = new Map();
    for (const { pathIndex, pathDef, fillRule, stroke, destW, destH, scaleX, scaleY } of entries) {
      ensureByPathIndex.delete(pathIndex);
      ensureByPathIndex.set(pathIndex, {
        pathIndex,
        pathDef,
        fillRule,
        stroke,
        screenSize: Math.max(destW * scaleX, destH * scaleY),
      });
    }
    return { entries, ensures: ensureByPathIndex.values() };
  }

  function usesCoreRecord(node) {
    return node._coreBox !== undefined;
  }



  // Authored values and DOM-backed rows join one native publication. The host
  // completes only asynchronous font, image, and path resource references.
  // A render surface's frame names the row revision its rows hold: the
  // core publishes DOM-backed rows as that revision restated them.
  function publishCoreFrame(nodes, patchIndex = null, rowRevision = 0) {
    const publication = publishDirectSceneInput(core, nodes, patchIndex, rowRevision);
    if (publication === 0) return false;
    let imageCount = 0;
    for (const node of nodes) {
      if (usesCoreRecord(node) && !node._corePublication.authored) {
        imageCount += (node.resolvedBackgroundImages?.length ?? 0) + (node.resolvedMasks?.length ?? 0) +
          (node.resolvedBorderImage ? 1 : 0);
      }
    }
    const input = core.engineRecordFrameInput(
      nodes.length,
      imageCount,
      patchIndex === null ? null : { publication, index: patchIndex },
    );
    if (input === null) return false;
    const { view: inputView } = input;
    // DOM and engine share this instance: publish directly into final records.
    writeEngineFrameInput(inputView, input.header, {
      count: nodes.length,
      imageCount,
      publication,
      flags: ENGINE_FRAME_INPUT_DIRECT,
      sceneGeneration,
    });
    let imageCursor = 0;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const row = input.rows + index * EngineFrameResolutionSize;
      let flags = 0;
      // Scene capture precedes asynchronous font resource resolution: the
      // resolved renderer table index lands over the native record, like
      // the image and path joins; a retained zero would shape the first
      // frame against the fallback face.
      if (node.fontIndex !== undefined) {
        flags |= ENGINE_RESOLUTION.FONT;
        inputView.setUint32(
          row + EngineFrameResolutionFields.fontIndex,
          node.fontIndex,
          true,
        );
      }
      if (node.imageIndex !== undefined) {
        flags |= ENGINE_RESOLUTION.IMAGE;
        inputView.setUint32(
          row + EngineFrameResolutionFields.imageIndex,
          node.imageIndex,
          true,
        );
      }
      // Authored rows already contain their image indices and any appended
      // backgroundGradient layer. DOM rows receive the host's resource joins.
      const imageLists = usesCoreRecord(node) && !node._corePublication.authored
        ? [node.resolvedBackgroundImages, node.resolvedMasks, node.resolvedBorderImage ? [node.resolvedBorderImage] : null] : [];
      const layerCount = imageLists.reduce((count, layers) => count + (layers?.length ?? 0), 0);
      if (layerCount) {
        flags |= ENGINE_RESOLUTION.LAYERS;
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImages,
          imageCursor,
          true,
        );
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImageCount,
          layerCount,
          true,
        );
        for (const layers of imageLists) for (const layer of layers ?? []) {
          inputView.setUint32(
            input.images + imageCursor * 4,
            layer.imageIndex ?? IMAGE_INDEX_NONE,
            true,
          );
          imageCursor++;
        }
      }
      inputView.setUint32(row + EngineFrameResolutionFields.flags, flags, true);
    }
    const frame = core.engineRecordFrame();
    if (frame === null) return false;
    frame.patchIndex = patchIndex;
    return frame;
  }

  // Prepared text remains retained for inspection; publication and generation
  // comparison of its source spans are native.
  let currentTextBatch = null;
  // Text preparation work, totals over this runtime's writes: batches
  // prepared and the rows they prepared; rows a sparse write republished
  // whose run the core proved unchanged (kept) or found changed (rebuilt,
  // each re-preparing the batch). A render reports its own share.
  const textPreparationWork = {
    batches: 0,
    rows: 0,
    runsKept: 0,
    runsRebuilt: 0,
  };
  function prepareCountedTextBatch(nodes) {
    const batch = textPreparationRuntime.prepareTextBatch(nodes);
    textPreparationWork.batches++;
    textPreparationWork.rows += nodes.length;
    return batch;
  }
  // Commands the host decoded, a total over this runtime's renders: the
  // paint artifact, the text geometry, the glyph and path resource scans
  // and the highlighted raster stream each count the commands they read.
  // A render reports its own share.
  const commandDecodeWork = { commands: 0 };
  // More runs than this changed in one sparse write re-prepare the batch
  // more times than a full write prepares it once; the write is refused.
  const SPARSE_TEXT_REPREPARATION_LIMIT = 8;

  // ---- spec → CSS/HTML (the Chrome side) ----
  // The fields of a scene node that its oracle CSS reads, in the order of
  // scene_node_css (core/dom/scene-css.watpart); the binding adds the
  // font and grid texts that other modules resolve. SVG shapes, groups,
  // symbols and uses carry SVG attributes and get no CSS.
  function nodeCss(n) {
    const needs = core.status("scene_css_needs", ...core.valueListInput([n.display, n.inlineCtx]));
    const text = (needs & SCENE_CSS_NEEDS_FONT) !== 0;
    const grid = (needs & SCENE_CSS_NEEDS_GRID) !== 0;
    const tracks = (value) => Array.isArray(value) ? value.map(gridTrackCss) : undefined;
    return core.string("scene_node_css", ...core.valueListInput([
      n.display, n.boxSizing, n.bfc, n.overflow, n.clipPath,
      text ? fontFamilyCssValue(n.fontFamily ?? fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0]) : undefined,
      text ? n.fontSize ?? DEFAULT_FONT_SIZE : undefined,
      text ? fontWeightInCssUnits(n.fontWeight) : undefined,
      n.fontStyle, n.textAlign, n.textDecoration, n.textOverflow, n.verticalAlign, n.color, n.lineHeight, n.inlineCtx,
      n.tableLayout, n.borderCollapse, n.borderSpacing, n.captionSide, n.emptyCells,
      n.flexDirection, n.justifyContent, n.alignItems, n.flexWrap, n.gap, n.rowGap, n.columnGap,
      grid ? tracks(n.gridTemplateColumns) : undefined,
      grid ? tracks(n.gridTemplateRows) : undefined,
      n.gridTemplateAreas,
      grid && n.gridAutoColumns !== undefined ? gridTrackCss(n.gridAutoColumns) : undefined,
      grid && n.gridAutoRows !== undefined ? gridTrackCss(n.gridAutoRows) : undefined,
      n.gridAutoFlow, n.justifyItems, n.alignContent,
      n.flexGrow, n.flexShrink, n.flexBasis, n.alignSelf, n.order,
      n.gridRowStart, n.gridRowEnd, n.gridColumnStart, n.gridColumnEnd, n.gridArea, n.justifySelf,
      n.float, n.clear, n.width, n.height, n.aspectRatio, n.minWidth, n.minHeight, n.maxWidth, n.maxHeight,
      n.margin, n.marginTop, n.marginBottom, n.marginLeft, n.marginRight, n.padding,
      n.borderStyle, n.border, n.borderColor, n.borderRadius, n.bg, n.backgroundClip, n.backgroundOrigin,
      n.backgroundGradient, undefined,
      n.boxShadows, n.textShadows, n.filter, n.backdropFilter, n.position, n.zIndex,
      n.top, n.right, n.bottom, n.left, n.opacity, n.transform, n.blendMode,
      n.objectFit, n.objectPosition, n.imageRendering,
      n.gridTemplateColumns, n.gridTemplateRows,
      n.resolvedBackgroundImages, n.backgroundImages, n.backgroundAttachment,
    ], { compositeJson: false }));
  }

  // Images (like fonts, see font-registry.js's fontDataUri) are embedded as
  // data: URIs so the Chrome oracle pane can load them without a file server.
  // The MIME comes from the BYTES (imageMimeType), never from the extension
  // or a hardcoded default. Chrome sniffs images and renders a JPEG the same
  // under any declared type (measured — see imageMimeType's own comment), so
  // this changes no pixels today; it is here because the alternative is a
  // data: URI that states something untrue about its own payload.
  const imageDataUriCache = new Map();
  async function imageDataUri(src, readImage) {
    if (imageDataUriCache.has(src)) return imageDataUriCache.get(src);
    const bytes = await readImage(src);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const uri = `data:${imageMimeType(bytes)};base64,${btoa(bin)}`;
    imageDataUriCache.set(src, uri);
    return uri;
  }

  // The data URIs of the layers with a source, in layer order.
  async function layerDataUris(layers, readImage) {
    const uris = [];
    for (const layer of Array.isArray(layers) ? layers : []) {
      uris.push(layer?.src ? await imageDataUri(layer.src, readImage) : undefined);
    }
    return uris;
  }

  // The background-image, border-image and mask longhands of the oracle
  // page (scene_layer_css): async only for the data URIs of their images.
  async function nodeCssBackgroundImages(n, readImage) {
    const source = n.resolvedBackgroundImages ?? n.backgroundImages;
    return core.string("scene_layer_css", SCENE_LAYER_BACKGROUNDS, ...core.valueListInput([
      n.resolvedBackgroundImages, n.backgroundImages, n.backgroundAttachment, n.backgroundGradient,
      await layerDataUris(source, readImage),
    ], { compositeJson: false }));
  }

  async function nodeCssBorderImage(n, readImage) {
    const uri = n.borderImage?.src ? await imageDataUri(n.borderImage.src, readImage) : undefined;
    return core.string("scene_layer_css", SCENE_LAYER_BORDER_IMAGE, ...core.valueListInput([n.borderImage, uri], { compositeJson: false }));
  }

  async function nodeCssMasks(n, readImage) {
    return core.string("scene_layer_css", SCENE_LAYER_MASKS, ...core.valueListInput([
      n.masks, await layerDataUris(n.masks, readImage),
    ], { compositeJson: false }));
  }

  // The image bytes of the oracle page come from `host`, as every other
  // resource demand does; a scene without images needs no host.
  async function sceneHtml(scene, { host = noResourceHost } = {}) {
    const imageLoader = createDocumentResourceLoader({ host, documentURL: "about:blank" });
    const readImage = async (src) =>
      (await imageLoader.resolveResource({ requestedURL: src, kind: "image" })).bytes;
    try {
      return await sceneHtmlWithImages(scene, readImage);
    } finally {
      await imageLoader.release();
    }
  }

  async function sceneHtmlWithImages(scene, readImage) {
    return await runExclusiveEngineOperation(async () => {
      const resolveResource = async (request) => ({ bytes: await readImage(request.requestedURL) });
      const resources = await prepareImages(resolveFontIndices(scene.nodes), resolveResource, scene.imageSources);
      const prepared = prepareAuthoredSceneInput(core, resources, fontRegistry);
      try {
        const written = await emitSceneCommands({ ...scene, nodes: prepared }, {
          resolveResource,
        }, null, false);
        const boxes = readSceneBoxes({ ...scene, nodes: written.nodes });
        const nodes = written.nodes.map((node, index) => {
          const style = readSceneRowStyle(core, node, boxes[index]);
          const projected = { ...node, transform: node.transform === undefined ? undefined : style.diagnosticMatrix,
            border: style.border, borderColor: style.borderColors,
            borderStyle: typeof node.borderStyle === "object" && node.borderStyle !== null
              ? style.borderStyles : style.borderStyles.top,
            borderRadius: node.borderRadius === undefined ? undefined : style.borderRadii };
          if (style.svg) {
            const svg = style.svg;
            Object.assign(projected, {
              strokeWidth: node.strokeWidth === undefined ? undefined : svg.width,
              fillRule: svg.fillRule, strokeLinecap: svg.cap, strokeLinejoin: svg.join,
              strokeDasharray: svg.strokeParameters?.dashArray,
              strokeDashoffset: svg.strokeParameters?.dashPhase,
              strokeMiterlimit: svg.strokeParameters?.miterLimit });
            if (svg.path) Object.assign(projected, {
              display: "svg-path", d: svg.path.pathDef, resolvedPathBbox: svg.bounds,
            });
          }
          return projected;
        });
        return await sceneHtmlPrepared({ ...scene, nodes }, readImage);
      } finally {
        if (prepared !== scene.nodes) releaseAuthoredSceneInput(prepared);
      }
    });
  }

  // The node fields the oracle page's markup reads (scene_html_field_names).
  let sceneHtmlFields = null;

  // The oracle page of a prepared scene: its style sheet (scene_css_rules)
  // and its markup (scene_html). The binding resolves what the core
  // cannot: the data URIs of images and the sine and cosine of each
  // linear SVG gradient angle (WebAssembly has no sine and cosine).
  async function sceneHtmlPrepared(scene, readImage) {
    const declarations = await Promise.all(scene.nodes.map(async (n) => [
      nodeCss(n),
      await nodeCssBackgroundImages(n, readImage),
      await nodeCssMasks(n, readImage),
      await nodeCssBorderImage(n, readImage),
    ]));
    const css = core.string("scene_css_rules", ...core.valueListInput([scene.id, declarations], { compositeJson: false }));
    const imageUris = await Promise.all(scene.nodes.map((n) =>
      (core.status("scene_css_needs", ...core.valueListInput([n.display, n.inlineCtx])) & SCENE_CSS_NEEDS_IMAGE) !== 0 && n.src
        ? imageDataUri(n.src, readImage)
        : undefined
    ));
    const angle = (gradient) => {
      const radians = (gradient?.angle ?? 0) * Math.PI / 180;
      return [Math.sin(radians), Math.cos(radians)];
    };
    const trigonometry = scene.nodes.map((n) => [...angle(n.svgFillGradient), ...angle(n.svgStrokeGradient)]);
    sceneHtmlFields ??= core.string("scene_html_field_names").split(" ");
    const nodes = scene.nodes.map((n) => Object.fromEntries(sceneHtmlFields.map((field) => [field, n[field]])));
    const html = core.string("scene_html", ...core.valueListInput(
      [scene.id, nodes, imageUris, trigonometry],
      { compositeJson: false },
    ));
    return { css, html };
  }

  // Emits the commands of one page of the rows the engine holds: `page` is
  // { height, index, rulesKey, box } (renderScenePixelsNow's page option).
  // The engine records every page's start while it counts the pages. A
  // later emission of the same rows, size and fonts seeks the page it
  // shows; any other counts the pages again. The rows are the same while
  // the newest row generation and the engine epoch are: a row write stamps
  // each row it changes with a new generation, and so does an animation
  // sample for the rows whose layout it changes. A write that changes no
  // row (a geometry getter's layout of an unchanged document) keeps the
  // count. The engine advances the header generation at every sample, also
  // when no row changes, so the header generation is not a key. Returns
  // the command bytes, the page count, the
  // page shown (the requested one, or the last page when the document is
  // shorter) and the scene indices of the nodes on other pages. A count
  // also records each scene node's fragments (pagedLayoutRecord.nodeFragments:
  // per node, null or [{ page, rect, content }] in page order).
  function emitPageCommands(scene, nodes, page, writeOwner) {
    const rowGeneration = engine.exports.layout_rows_generation(nodes.length) >>> 0;
    const pageKey = [
      writeOwner, nodes.length,
      rowGeneration, engine.exports.engine_epoch(),
      scene.width, page.height, page.rulesKey ?? "", fontRegistry.revision, core.status("resource_revision"),
    ];
    const recorded = pagedLayoutRecord !== null &&
      pagedLayoutRecord.serial === engine.exports.page_record_serial() &&
      pagedLayoutRecord.key.every((value, position) => value === pageKey[position]);
    let pageCount;
    if (recorded) {
      pageCount = pagedLayoutRecord.count;
    } else {
      // Each page: its name (CSS Paged Media 3, 7.1), from the content it
      // starts with, whether it is left blank for a side break, and its
      // page box from the caller's @page rules (page.box), or the scene's
      // size without margins. The page area is the viewport the page lays
      // out in.
      const pages = [];
      // Each scene node's fragments, in page order, from the fragment
      // records the engine writes after each page's layout
      // (page_write_fragments).
      const nodeFragments = new Array(scene.nodes.length).fill(null);
      const sceneIndexOfEngineNode = new Int32Array(nodes.length).fill(-1);
      for (let sceneIndex = 0; sceneIndex < scene.nodes.length; sceneIndex++) {
        const engineIndex = engineIndexOfSceneNode(nodes, sceneIndex);
        if (engineIndex >= 0) sceneIndexOfEngineNode[engineIndex] = sceneIndex;
      }
      const unit = (offset) => view.getInt32(offset, true) / LAYOUT_UNIT;
      pageCount = 0;
      engine.exports.page_begin(page.height);
      do {
        const index = pages.length;
        const nameId = engine.exports.page_name();
        // The page groups the page is in (CSS Generated Content for Paged
        // Media 3, 3.2), outermost first: each group's name and the page's
        // position in it, from 1 (page_group_position).
        const groups = [];
        const groupCount = engine.exports.page_group_count();
        for (let group = 0; group < groupCount; group++) {
          groups.push({
            name: core.string("page_name_text", engine.exports.page_group_name(group)),
            position: engine.exports.page_group_position(group),
          });
        }
        const description = {
          index,
          name: nameId === 0 ? "" : core.string("page_name_text", nameId),
          side: core.string("frame_page_side", index),
          blank: engine.exports.page_blank() !== 0,
          groups,
        };
        const box = page.box?.(description) ?? {
          width: scene.width,
          height: page.height,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          area: { x: 0, y: 0, width: scene.width, height: page.height },
        };
        pages.push({ ...description, box });
        engine.exports.page_set_block_size(box.area.height);
        engine.exports.page_set_box(box.width, box.height, box.margin.top, box.margin.right, box.margin.bottom, box.margin.left);
        engine.exports.layout(nodes.length, box.area.width, box.area.height);
        engine.exports.page_write_fragments(nodes.length);
        pageCount++;
      } while (engine.exports.page_advance());
      const fragmentSize = engine.exports.page_fragment_size();
      const fragmentBase = engine.exports.page_fragment_base();
      const fragmentCount = engine.exports.page_fragment_count();
      for (let fragment = 0; fragment < fragmentCount; fragment++) {
        const record = fragmentBase + fragment * fragmentSize;
        const sceneIndex = sceneIndexOfEngineNode[view.getUint32(record + PAGE_FRAGMENT_NODE, true)];
        if (sceneIndex < 0) continue;
        const boxBase = record + PAGE_FRAGMENT_BOX;
        (nodeFragments[sceneIndex] ??= []).push(Object.freeze({
          page: view.getUint32(record + PAGE_FRAGMENT_PAGE, true),
          rect: Object.freeze({
            x: unit(boxBase + BOX_OFFSET_X),
            y: unit(boxBase + BOX_OFFSET_Y),
            width: unit(boxBase + BOX_OFFSET_WIDTH),
            height: unit(boxBase + BOX_OFFSET_HEIGHT),
          }),
          content: Object.freeze({
            x: unit(boxBase + BOX_OFFSET_CONTENT_X),
            y: unit(boxBase + BOX_OFFSET_CONTENT_Y),
            width: unit(boxBase + BOX_OFFSET_CONTENT_W),
            height: unit(boxBase + BOX_OFFSET_CONTENT_H),
          }),
        }));
      }
      for (const fragments of nodeFragments) {
        if (fragments !== null) Object.freeze(fragments);
      }
      pagedLayoutRecord = { key: pageKey, count: pageCount, pages, nodeFragments, serial: engine.exports.page_record_serial() };
    }
    const pageIndex = Math.min(page.index, pageCount - 1);
    if (!engine.exports.page_seek(pageIndex)) {
      throw new Error(`page ${pageIndex} has no recorded start; the engine recorded the pages of another layout`);
    }
    const { box } = pagedLayoutRecord.pages[pageIndex];
    engine.exports.page_set_block_size(box.area.height);
    engine.exports.page_set_box(box.width, box.height, box.margin.top, box.margin.right, box.margin.bottom, box.margin.left);
    const offPageNodes = [];
    let bytes;
    try {
      prepareLayoutSvgGeometry(nodes.length, box.area.width, box.area.height);
      bytes = engine.exports.emit_commands_sized(nodes.length, box.area.width, box.area.height);
    } finally {
      for (let sceneIndex = 0; sceneIndex < scene.nodes.length; sceneIndex++) {
        const engineIndex = engineIndexOfSceneNode(nodes, sceneIndex);
        if (engineIndex >= 0 && engine.exports.page_node_off(engineIndex)) {
          offPageNodes.push(sceneIndex);
        }
      }
      engine.exports.page_end();
    }
    return { bytes, pageCount, pageIndex, offPageNodes };
  }

  async function emitSceneCommands(
    scene,
    options = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    const {
      resolveResource = null,
      onImageLoadError = null,
      layoutNodeCapacity = Infinity,
      commitTextRunKeys,
      captureNodeMarkers = false,
      engineWriteOwner = null,
      // The time to sample the write owner's tracks at; by default the
      // time of its last tick.
      sampleTimeMilliseconds,
      // The page to list (emitPageCommands); null lists the continuous
      // document.
      page = null,
    } = options;
    validateLayoutNodeCapacity(layoutNodeCapacity);
    // The engine lays out in CSS pixels; deviceScale is raster-only and
    // never reaches layout or emission. Reset the persistent engine
    // global (opsz reads it during shaping).
    engine.exports.set_device_scale(1);
    const resources = await prepareImages(resolveFontIndices(scene.nodes),
      resolveResource, scene.imageSources, onImageLoadError);
    const used = prepareAuthoredSceneInput(core, resources, fontRegistry);
    const globalPreparation = used[0]?._corePublication?.indexSpaceChanged ?? false;
    const nodes = await prepareSvgPathResources(used);
    writeSceneNodesAndTileConfig(
      scene,
      nodes,
      null,
      layoutNodeCapacity,
      generationReservation,
      commitTextRunKeys,
    );
    // Sample the write owner's animations onto the rows just written. The
    // owner takes the shared animation table in this synchronous turn, so
    // the layout below reads no other renderer's tracks.
    engineWriteOwner?.resample(sampleTimeMilliseconds);
    if (page === null) prepareLayoutSvgGeometry(nodes.length, scene.width, scene.height);
    if (!emitPaintCommands) {
      engine.exports.layout(
        nodes.length,
        scene.width,
        scene.height,
      );
      // A fallback face that this layout requested shapes its text in a
      // second layout of the whole scene.
      const answering = answerFallbackFaces();
      if (answering !== null) {
        await answering;
        return await emitSceneCommands(scene, options, generationReservation, emitPaintCommands);
      }
      return { view: null, bytesWritten: 0, nodes, globalPreparation };
    }
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    // QUERY emit: leave the render pipeline's persistent damage state
    // (tile dirty map, painted-box mirror, watermarks, retained-buffer
    // record) untouched — see the engine's $queryEmitMode comment.
    engine.exports.set_query_emit(1);
    let bytesWritten;
    try {
      bytesWritten = page === null
        ? engine.exports.emit_commands(nodes.length)
        : emitPageCommands(scene, nodes, page, engineWriteOwner).bytes;
    } finally {
      engine.exports.set_query_emit(0);
    }
    const answering = answerFallbackFaces();
    if (answering !== null) {
      await answering;
      return await emitSceneCommands(scene, options, generationReservation, emitPaintCommands);
    }
    // The emission may have moved the command buffer: its base is read now.
    const commandBase = engine.exports.command_buffer_base();
    const copy = engine.memory.buffer.slice(commandBase, commandBase + bytesWritten);
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
  }

  // A DOM scene names its faces in the catalog of its document's font
  // registry, and only this runtime's registry binds faces to this
  // engine. A scene of another registry would lay out with no font.
  function assertSceneFontRegistry(nodes) {
    const publication = nodes.find((node) => node._corePublication !== undefined)?._corePublication;
    if (publication === undefined || publication.fontRegistry === fontRegistry) return;
    throw new Error(
      `The document ${publication.documentURL} uses a font registry that this scene renderer runtime does not own, ` +
        "and a runtime renders only the documents of its own font registry. Render the document with " +
        "createSandomDOM({ sceneRendererRuntime }), where the runtime is " +
        "createSceneRendererRuntime({ core, fontRegistry }) with the document's core and registry, or create the " +
        "document without a fontRegistry.",
    );
  }

  // Shared write step between emitSceneCommands and its synchronous
  // counterpart below — factored out once a second (sync) caller existed,
  // not before (this project's own "don't build shared abstractions ahead
  function writeSceneNodesAndTileConfig(
    scene,
    nodes,
    changedNodeIndices = null,
    layoutNodeCapacity = Infinity,
    generationReservation = null,
    commitTextRunKeys = generationReservation === null,
    forceGenerationNodeIndices = null,
    scrollOnlyNodeIndices = null,
    retained = false,
  ) {
    // Every engine write invalidates the previous owner's incremental
    // claim; an owned render re-claims after ITS write (renderScenePixels).
    engineWriteOwner = null;
    assertSceneFontRegistry(nodes);
    engineWriteClaims.set(
      engine.memory,
      (engineWriteClaims.get(engine.memory) ?? 0) + 1,
    );
    if (nodes.length > layoutNodeCapacity) {
      throw new RangeError(
        `Scene has ${nodes.length} nodes; layout capacity is ${layoutNodeCapacity}`,
      );
    }
    if (!retained) ensureNodeCapacity(nodes.length);
    const reserved = Boolean(generationReservation) && !generationReservation.consumed;
    if (reserved) generationReservation.consumed = true;
    sceneGeneration = core.status(
      "engine_record_generation", reserved ? 1 : 0,
      reserved ? generationReservation.generation : 0,
      reserved && generationReservation.published ? 1 : 0,
      reserved ? generationReservation.nodeCount : 0,
    ) >>> 0;
    let sparseValid = true;
    if (!retained) {
      publishCoreFrame(nodes, null, scene.rowRevision ?? 0);
      currentTextBatch?.release();
      currentTextBatch = null;
    }
    let textBatch = retained
      ? currentTextBatch
      : prepareCountedTextBatch(nodes);
    try {
      let resultsBase = nodes.length ? textBatch.resultsBase() : 0;
      const finishRows = (patchIndex = null) => {
        const selected = patchIndex !== null ||
          forceGenerationNodeIndices?.size || scrollOnlyNodeIndices?.size;
        let rows = 0;
        let rowCount = 0;
        if (selected) {
          rowCount = patchIndex === null ? nodes.length : 1;
          rows = core.exports.abi_allocate(Math.max(1, rowCount) * EngineFrameFinishRowSize);
          if (!rows) core.throwIfError();
          const rowView = new DataView(core.refreshBytes().buffer);
          let cursor = rows;
          for (let row = 0; row < rowCount; row++) {
            const index = patchIndex ?? row;
            rowView.setUint32(cursor + EngineFrameFinishRowFields.index, index, true);
            rowView.setUint32(cursor + EngineFrameFinishRowFields.flags,
              (forceGenerationNodeIndices?.has(index) ? ENGINE_FINISH_FORCE_GENERATION : 0) |
                (scrollOnlyNodeIndices?.has(index) ? ENGINE_FINISH_SCROLL_ONLY : 0), true);
            cursor += EngineFrameFinishRowSize;
          }
        }
        return core.status(
          "engine_record_finish", resultsBase, nodes.length,
          commitTextRunKeys ? 1 : 0, rows, rowCount,
        ) !== 0;
      };
      if (retained) {
        // Publication exposes only the current patch's fact and input.
        // Finish it before publishing the next row overwrites those values.
        // A rejected publication (null) leaves the rows unusable; pool
        // drift (false) only forbids retained reuse of the prepared frame.
        // Text preparation reads the whole publication: a republished row
        // whose run the core cannot prove unchanged re-prepares the batch
        // before its finish reads the row's result. When every republished
        // row's run is unchanged, so is every run, and so is every result
        // of the batch (an ancestor's run carries the ellipsis eligibility
        // its text inherits).
        let rebuiltRuns = 0;
        for (const index of changedNodeIndices) {
          if (publishCoreFrame([nodes[index]], index, scene.rowRevision ?? 0) === false) return null;
          if (core.status("engine_record_text_run_prepared", index) === 1) {
            textPreparationWork.runsKept++;
          } else {
            textPreparationWork.runsRebuilt++;
            if (++rebuiltRuns > SPARSE_TEXT_REPREPARATION_LIMIT) return null;
            const prepared = prepareCountedTextBatch(nodes);
            textBatch.release();
            textBatch = prepared;
            resultsBase = textBatch.resultsBase();
            // The retained commands and text geometry name the previous
            // batch's runs: a rebuilt run forbids retained reuse.
            sparseValid = false;
          }
          if (!finishRows(index)) sparseValid = false;
        }
      } else {
        sparseValid = finishRows();
      }
      if (globalThis.__engineRecordProbe) {
        for (const index of retained ? changedNodeIndices : nodes.keys()) {
          const base = layoutBufferBase + index * LAYOUT_NODE_SIZE;
          globalThis.__engineRecordProbe(
            index, nodes[index], engine.bytes.slice(base, base + LAYOUT_NODE_SIZE),
            engine.bytes,
          );
        }
      }
    } finally {
      currentTextBatch = textBatch;
    }
    // A write for layout reads (no raster target) keeps a CSS px grid; a
    // render sets the raster grid before it emits (writeTileGrid).
    writeTileGrid(scene, scene.width, scene.height, 1, null);
    return sparseValid;
  }

  // The grid the engine marks damage in (tile_grid_write). Returns the tile
  // side in device px.
  function writeTileGrid(scene, deviceWidth, deviceHeight, deviceScale, visibleRectangle) {
    return engine.exports.tile_grid_write(
      deviceWidth, deviceHeight, scene.width, scene.height, deviceScale,
      visibleRectangle?.x ?? 0, visibleRectangle?.y ?? 0,
    );
  }

  // Layout getters use registered resources without waiting for host effects.
  // With `page` ({ height, index, rulesKey, box }, as a page frame's) the
  // emission lays out that page of the document's page count
  // (emitPageCommands) and returns its `paging`: { count, index (the page
  // laid out), offPageNodes (scene indices of the nodes on other pages),
  // pages (each page's description and box), nodeFragments (each scene
  // node's fragments on each page, null for a node on none) }. Without
  // it, `paging` is null.
  function emitSceneCommandsSync(
    scene,
    { layoutNodeCapacity = Infinity, commitTextRunKeys, discardCommands = false, engineWriteOwner = null, sampleTimeMilliseconds, prepareEngine = null, captureNodeMarkers = false, textGeometry = false, page = null } = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    if (page !== null && !emitPaintCommands) {
      throw new Error("emitSceneCommandsSync: a page layout emits the page's commands; it needs emitPaintCommands");
    }
    engine.exports.set_device_scale(1);
    const resources = prepareImagesSync(resolveFontIndices(scene.nodes), scene.imageSources);
    const used = prepareAuthoredSceneInput(core, resources, fontRegistry);
    const globalPreparation = used[0]?._corePublication?.indexSpaceChanged ?? false;
    const nodes = prepareSvgPathResourcesSync(used);
    writeSceneNodesAndTileConfig(
      scene,
      nodes,
      null,
      layoutNodeCapacity,
      generationReservation,
      commitTextRunKeys,
    );
    // The caller declares tracks over the rows just written, before they
    // are sampled (render-surface's _declareUnrenderedEffects).
    prepareEngine?.();
    engineWriteOwner?.resample(sampleTimeMilliseconds);
    if (page === null) prepareLayoutSvgGeometry(nodes.length, scene.width, scene.height);
    if (!emitPaintCommands) {
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return { view: null, bytesWritten: 0, nodes, globalPreparation, paging: null };
    }
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    // QUERY emit — same contract as emitSceneCommands above. A text
    // geometry query also lists hidden text and gives the spaces a line
    // end removes no advance (set_query_text_geometry).
    engine.exports.set_query_emit(1);
    engine.exports.set_query_text_geometry(textGeometry ? 1 : 0);
    let bytesWritten;
    let paging = null;
    try {
      if (page === null) {
        bytesWritten = engine.exports.emit_commands(nodes.length);
      } else {
        const emitted = emitPageCommands(scene, nodes, page, engineWriteOwner);
        bytesWritten = emitted.bytes;
        paging = Object.freeze({
          count: emitted.pageCount,
          index: emitted.pageIndex,
          offPageNodes: Object.freeze(emitted.offPageNodes),
          pages: pagedLayoutRecord.pages,
          nodeFragments: pagedLayoutRecord.nodeFragments,
        });
      }
    } finally {
      engine.exports.set_query_emit(0);
      engine.exports.set_query_text_geometry(0);
    }
    if (discardCommands) {
      return { view: null, bytesWritten, nodes, globalPreparation, paging };
    }
    const commandBase = engine.exports.command_buffer_base();
    const copy = engine.memory.buffer.slice(commandBase, commandBase + bytesWritten);
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation, paging };
  }

  // Native snapshots include SVG source bounds transformed into CSS pixels.
  function readSceneBoxes(scene, deviceScale = 1) {
    return readEngineBoxes(engine.core, scene.nodes.length, deviceScale);
  }

  // A standalone analytical layout must not inherit geometry or cache
  // validity from a prior call: the engine may hold another scene whose
  // records happen to match this one's at some index, and that node would
  // keep the other scene's box (and its post-layout transform). Force
  // every node into the next generation and clear the output tables, so
  // the engine computes a complete standalone result. An analytical pass
  // over the scene the engine ALREADY holds skips this (see
  // layoutTreeBoxesSync): the record diff is then authoritative, exactly
  // as it is for a frame. The reset writes every row, so the node tables
  // must hold the scene first.
  function stampAnalyticalState(nodeCount, forcedGeneration) {
    ensureNodeCapacity(nodeCount);
    core.status("engine_record_analytical_reset", nodeCount, forcedGeneration);
  }

  // The generation reservation of an analytical pass
  // (engine_record_generation_reserve).
  function resetAnalyticalLayoutState(nodeCount, inheritRetained = false) {
    const generation = core.exports.engine_record_generation_reserve() >>> 0;
    const generationReservation = {
      generation,
      published: core.exports.engine_record_generation_reserve_published() !== 0,
      consumed: false,
      nodeCount,
    };
    if (!inheritRetained) {
      stampAnalyticalState(nodeCount, generationReservation.generation);
    }
    return generationReservation;
  }

  // An analytical layout over the scene the claim owner renders is that
  // owner's next frame in all but name: it inherits the retained layout
  // (only the rows whose records changed relay out), commits text identity
  // like a frame write, and the rows it leaves in the engine are recorded
  // so the frame that takes this scene skips writing them again
  // (renderScenePixelsNow's reuseSyncLayoutWrite). Without a claim the
  // layout stands alone: forced generation, cleared output tables.
  function analyticalWriteOptions(scene, options) {
    const owner = options.engineWriteOwner ?? null;
    const inherited = owner !== null && engineWriteOwner === owner;
    const generationReservation = resetAnalyticalLayoutState(
      scene.nodes.length,
      inherited,
    );
    return { owner, inherited, generationReservation };
  }

  function finishAnalyticalWrite(scene, { owner, inherited }, written) {
    const boxes = readSceneBoxes(scene);
    owner?.captureComputedSamples?.();
    owner?.captureComputedPseudos?.(scene.nodes, boxes, scene.generatedBoxRows);
    owner?.captureComputedGeometry?.(boxes);
    owner?.captureLiveValues();
    // The write above dropped the claim (every engine write does). This
    // scene came from the claimant's own tree, so hand it back: the next
    // frame keeps its incremental node set instead of rewriting every
    // record because a layout ran between the two.
    if (owner !== null) engineWriteOwner = owner;
    syncLayoutWrite = inherited
      ? {
        owner,
        sceneNodes: scene.nodes,
        nodes: written.nodes,
        globalPreparation: written.globalPreparation,
        width: scene.width,
        height: scene.height,
        writeClaim: engineWriteClaims.get(engine.memory),
        coreWriteRevision: core.engineFrameRevision,
        resourceRevision: core.status("resource_revision"),
        fontRevision: fontRegistry.revision,
      }
      : null;
    return boxes;
  }

  // Lay out a scene (deviceScale=1) and return every node's computed border-box
  // and content-box in CSS pixels. The layout-getter family uses this shared
  // mechanism: serialize, run layout, and read the node's box. It reuses
  // emitSceneCommands for its layout side effect rather than duplicating a
  // second layout path. The emitted commands are discarded.
  async function layoutTreeBoxes(scene, options = {}) {
    // The generation reservation and the box read assume exclusive engine
    // access; a live surface's render loop would interleave otherwise
    // (writeSceneNodesAndTileConfig rejects the advanced generation loudly).
    return await runExclusiveEngineOperation(async () => {
      const analytical = analyticalWriteOptions(scene, options);
      const written = await emitSceneCommands(
        scene,
        analytical.inherited ? { ...options, commitTextRunKeys: true } : options,
        analytical.generationReservation,
        false,
      );
      return finishAnalyticalWrite(scene, analytical, written);
    });
  }

  // Synchronous counterpart of layoutTreeBoxes — matches a real browser's
  // synchronous offsetWidth/getBoundingClientRect/etc. exactly. Throws if
  // the tree references an unregistered font/image/SVG-path (see
  function layoutTreeBoxesSync(scene, options = {}) {
    if (options.page !== undefined && options.page !== null) {
      throw new Error("layoutTreeBoxesSync lays out the continuous document; layoutPageBoxesSync lays out a page");
    }
    return analyticalBoxesSync(scene, options).boxes;
  }

  // layoutTreeBoxesSync for one page of a paged document: `options.page`
  // ({ height, index, rulesKey, box }, as a page frame's) names the page.
  // Returns { boxes, paging }: the boxes of the page's layout, in its page
  // area's coordinates (a node on another page has no box on it; paging
  // lists those), and the page count's paging (emitSceneCommandsSync).
  function layoutPageBoxesSync(scene, options) {
    if (!options?.page) throw new Error("layoutPageBoxesSync needs options.page");
    return analyticalBoxesSync(scene, options);
  }

  function analyticalBoxesSync(scene, options) {
    const analytical = analyticalWriteOptions(scene, options);
    // emitPaintCommands stays ON for the analytical path: a non-atomic
    // inline box's computed box is the union of its per-line fragment
    // rects, and that union is produced by the emit walk
    // ($emitInlineLineDecorations) — layout alone leaves inline boxes
    // zero-sized. The command bytes themselves are discarded.
    const written = emitSceneCommandsSync(
      scene,
      analytical.inherited
        ? { ...options, commitTextRunKeys: true, discardCommands: true }
        : { ...options, discardCommands: true },
      analytical.generationReservation,
      true,
    );
    return { boxes: finishAnalyticalWrite(scene, analytical, written), paging: written.paging };
  }

  // A synchronous layout with the text geometry of every text node it lays
  // out (CSSOM View Range.getClientRects, caretPositionFromPoint): the
  // boxes, as layoutTreeBoxesSync gives them, and the text geometry capture
  // of a query emit that lists hidden text and skipped contents and gives
  // the spaces a line end removes no advance (set_query_text_geometry;
  // geometry_text_query_capture), in scroll space as the geometry records
  // hold their boxes, moved by `options.textOffset` ({ x, y }, the place of
  // a page in the space of a paged surface; none for the page shown). The
  // caller takes the capture (geometry_text_store_of_query or
  // geometry_text_release); 0 when the emit wrote no command. With
  // `options.page` the layout is that page's and `paging` describes the
  // page count (emitSceneCommandsSync); else `paging` is null.
  function layoutTextGeometrySync(scene, options = {}) {
    const { textOffset = null, ...layoutOptions } = options;
    const analytical = analyticalWriteOptions(scene, layoutOptions);
    const written = emitSceneCommandsSync(
      scene,
      {
        ...layoutOptions,
        ...(analytical.inherited ? { commitTextRunKeys: true } : {}),
        captureNodeMarkers: true,
        textGeometry: true,
      },
      analytical.generationReservation,
      true,
    );
    const textCapture = written.bytesWritten === 0 ? 0 : core.status("geometry_text_query_capture", written.bytesWritten,
      currentTextBatch.resultsBase(), scene.nodes[0]?._corePublication?.handle ?? 0, textOffset?.x ?? 0, textOffset?.y ?? 0);
    try {
      return { boxes: finishAnalyticalWrite(scene, analytical, written), textCapture, paging: written.paging ?? null };
    } catch (error) {
      if (textCapture !== 0) core.status("geometry_text_release", textCapture);
      throw error;
    }
  }

  // Canvas 2D text (src/dom/canvas-2d-text.js). Lays `scene` out alone, as
  // a standalone analytical layout does, then lays the canvas text of its
  // text nodes `textNodes` out (canvas_text_layout,
  // core/engine/canvas-text-layout.watpart) for `style`: its size, letter and
  // word spacings in px and slope. Returns the width, the ink bounds and
  // the primary face's metrics, the glyphs in drawing order with their
  // faces, and `measure(textAlign, textBaseline, direction)`
  // (canvas_text_measure): the TextMetrics values, the align factor and
  // the alphabetic baseline. The engine shapes canvas text as it shapes
  // CSS text: font stack, fallback faces, bidi levels over all the nodes,
  // features. One face object stands for a font index for the runtime's
  // life.
  const canvasTextFaces = new Map();
  function canvasTextFace(fontIndex) {
    let described = canvasTextFaces.get(fontIndex);
    if (described !== undefined && described.bytes !== registeredFontBytes(fontIndex)) described = undefined;
    if (described !== undefined) return described;
    const entry = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
    const fontView = new DataView(engine.memory.buffer);
    const subdividedUpem = fontView.getUint32(entry + FONT_TABLE_OFFSET_UPEM, true);
    const weight = fontView.getUint16(entry + FONT_TABLE_OFFSET_WEIGHT, true);
    described = Object.freeze({
      fontIndex,
      bytes: registeredFontBytes(fontIndex),
      faceIndex: fontIdentityForDocument(fontIndex, 0n).faceIndex,
      weight,
      variationWidth: fontVariationWidth(fontIndex),
      variationSlant: fontVariationSlant(fontIndex),
      upem: subdividedUpem / FONT_UNIT_SUBDIVISION,
    });
    canvasTextFaces.set(fontIndex, described);
    return described;
  }
  function layoutCanvasTextSync(scene, textNodes, style) {
    const analytical = analyticalWriteOptions(scene, {});
    emitSceneCommandsSync(scene, {}, analytical.generationReservation, false);
    syncLayoutWrite = null;
    const nodes = engine.exports.abi_malloc(textNodes.length * 4);
    let output;
    try {
      new Uint32Array(engine.memory.buffer, nodes, textNodes.length).set(textNodes);
      output = engine.exports.canvas_text_layout(nodes, textNodes.length, style.size, style.letterSpacingPx,
        style.wordSpacingPx, style.slope);
    } finally {
      engine.exports.abi_free(nodes);
    }
    // Every value is read before a face is described: describing one may
    // grow the memory.
    const record = new DataView(engine.memory.buffer, output);
    const number = (offset) => record.getFloat64(offset, true);
    const raw = Array.from({ length: record.getUint32(CANVAS_TEXT_LAYOUT.GLYPH_COUNT, true) }, (_, index) => {
      const at = CANVAS_TEXT_LAYOUT.GLYPHS + index * CANVAS_TEXT_GLYPH.SIZE;
      return [record.getUint32(at + CANVAS_TEXT_GLYPH.ID, true), record.getUint32(at + CANVAS_TEXT_GLYPH.FONT, true),
        record.getUint32(at + CANVAS_TEXT_GLYPH.OBLIQUE, true), record.getUint32(at + CANVAS_TEXT_GLYPH.RUN_FONT, true),
        number(at + CANVAS_TEXT_GLYPH.X)];
    });
    const ink = CANVAS_TEXT_LAYOUT.INK;
    const layout = {
      width: number(CANVAS_TEXT_LAYOUT.WIDTH),
      ink: { x: number(ink), y: number(ink + 8), width: number(ink + 16), height: number(ink + 24) },
      ascent: number(CANVAS_TEXT_LAYOUT.ASCENT),
      descent: number(CANVAS_TEXT_LAYOUT.DESCENT),
      lineGap: number(CANVAS_TEXT_LAYOUT.LINE_GAP),
      typoAscent: number(CANVAS_TEXT_LAYOUT.TYPO_ASCENT),
      typoDescent: number(CANVAS_TEXT_LAYOUT.TYPO_DESCENT),
      size: number(CANVAS_TEXT_LAYOUT.SIZE),
      synthesizedSize: number(CANVAS_TEXT_LAYOUT.SYNTHESIZED_SIZE),
    };
    layout.glyphs = raw.map(([id, font, oblique, runFont, x]) => ({
      id,
      face: canvasTextFace(font & SHAPED_GLYPH_FONT_INDEX),
      synthesized: (font & SHAPED_GLYPH_FONT_SYNTHESIZED) !== 0,
      oblique: oblique !== 0,
      runFont,
      x,
    }));
    layout.measure = (textAlign, textBaseline, direction) => {
      const measured = engine.exports.canvas_text_measure(layout.width, layout.ink.x, layout.ink.y, layout.ink.width,
        layout.ink.height, layout.ascent, layout.descent, layout.typoAscent, layout.typoDescent, textAlign, textBaseline, direction);
      const F64 = Float64Array.BYTES_PER_ELEMENT;
      const values = new DataView(engine.memory.buffer, measured, CANVAS_TEXT_MEASURE_COUNT * F64);
      return Array.from({ length: CANVAS_TEXT_MEASURE_COUNT }, (_, index) => values.getFloat64(index * F64, true));
    };
    return layout;
  }

  // The words of canvas text (canvas_text_word_ends, which also prepares
  // the text in place), each laid out as a text node of its own.
  function canvasTextWordsSync(text) {
    const bytes = new TextEncoder().encode(text);
    // The text, then room for one u32 end for each byte and for one more.
    const input = engine.exports.abi_malloc(bytes.length + (bytes.length + 1) * Uint32Array.BYTES_PER_ELEMENT);
    try {
      new Uint8Array(engine.memory.buffer, input, bytes.length).set(bytes);
      const output = input + bytes.length;
      const count = engine.exports.canvas_text_word_ends(input, bytes.length, output);
      const prepared = new Uint8Array(engine.memory.buffer, input, bytes.length);
      const ends = new DataView(engine.memory.buffer, output, count * Uint32Array.BYTES_PER_ELEMENT);
      const decoder = new TextDecoder();
      const words = [];
      let start = 0;
      for (let index = 0; index < count; index++) {
        const end = ends.getUint32(index * Uint32Array.BYTES_PER_ELEMENT, true);
        words.push(decoder.decode(prepared.subarray(start, end)));
        start = end;
      }
      return words;
    } finally {
      engine.exports.abi_free(input);
    }
  }

  // The outline of glyph `glyphId` of the registered font `fontIndex` at
  // the optical size `opticalSize` (canvas_text_glyph_outline), in font
  // units, for strokeText.
  function canvasTextGlyphOutlineSync(fontIndex, opticalSize, glyphId) {
    const pointer = engine.exports.canvas_text_glyph_outline(fontIndex, opticalSize, glyphId);
    return new Uint8Array(engine.memory.buffer, pointer, engine.exports.glyph_outline_length()).slice();
  }

  function artifactBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value));
  }

  function freezeArtifactValue(value) {
    if (Array.isArray(value)) {
      value.forEach(freezeArtifactValue);
      return Object.freeze(value);
    }
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      Object.values(value).forEach(freezeArtifactValue);
      return Object.freeze(value);
    }
    return value;
  }

  // A box's used margins and padding (top, right, bottom, left each), from
  // the core's box snapshot (geometry_boxes: zero when it has none).
  const NO_USED_EDGES = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);

  function expandedBox(box, top, right, bottom, left) {
    return {
      x: box.x - left,
      y: box.y - top,
      width: box.width + left + right,
      height: box.height + top + bottom,
    };
  }

  function readLayoutArtifact(scene, nodes) {
    const parentIndices = new Array(nodes.length).fill(null);
    nodes.forEach((node, nodeIndex) => {
      for (const childIndex of node.children ?? []) {
        parentIndices[childIndex] = nodeIndex;
      }
    });
    const scrollBoxes = readSceneBoxes({ nodes });
    const boxes = nodes.map((node, nodeIndex) => {
      const boxBase = computedBoxBufferBase + nodeIndex * BOX_SIZE;
      const borderBox = {
        x: view.getInt32(boxBase + BOX_OFFSET_X, true) / LAYOUT_UNIT,
        y: view.getInt32(boxBase + BOX_OFFSET_Y, true) / LAYOUT_UNIT,
        width: view.getInt32(boxBase + BOX_OFFSET_WIDTH, true) / LAYOUT_UNIT,
        height: view.getInt32(boxBase + BOX_OFFSET_HEIGHT, true) / LAYOUT_UNIT,
      };
      const contentBox = {
        x: view.getInt32(boxBase + BOX_OFFSET_CONTENT_X, true) / LAYOUT_UNIT,
        y: view.getInt32(boxBase + BOX_OFFSET_CONTENT_Y, true) / LAYOUT_UNIT,
        width: view.getInt32(boxBase + BOX_OFFSET_CONTENT_W, true) /
          LAYOUT_UNIT,
        height: view.getInt32(boxBase + BOX_OFFSET_CONTENT_H, true) /
          LAYOUT_UNIT,
      };
      const edges = scrollBoxes[nodeIndex].usedEdges ?? NO_USED_EDGES;
      const paddingBox = expandedBox(contentBox, edges[4], edges[5], edges[6], edges[7]);
      const marginBox = expandedBox(borderBox, edges[0], edges[1], edges[2], edges[3]);
      return {
        nodeIndex,
        parentIndex: parentIndices[nodeIndex],
        childIndices: [...(node.children ?? [])],
        marginBox,
        borderBox,
        paddingBox,
        contentBox,
        scroll: {
          left: scrollBoxes[nodeIndex].scrollLeft,
          top: scrollBoxes[nodeIndex].scrollTop,
          width: scrollBoxes[nodeIndex].scrollWidth,
          height: scrollBoxes[nodeIndex].scrollHeight,
        },
      };
    });
    const lineBoxes = [];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const runBase = textRunDirBase + nodeIndex * TEXT_RUN_ENTRY_SIZE;
      const lineOffset = view.getUint32(
        runBase + TEXT_RUN_OFFSET_LINE_OFFSET,
        true,
      );
      const lineCount = view.getUint32(
        runBase + TEXT_RUN_OFFSET_LINE_COUNT,
        true,
      );
      if (lineCount === 0) continue;
      const [lineHeight, baselineOffset] = engine.exports.text_line_metrics(nodeIndex);
      const contentBox = boxes[nodeIndex].contentBox;
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        // lineOffset is the ABSOLUTE byte address of this node's span
        // ($layoutText stores its $textLineCursor grab directly); the
        // engine's own readers pass it to $textLineRec unchanged.
        const lineBase = lineOffset + lineIndex * TEXT_LINE_ENTRY_SIZE;
        const lineX = contentBox.x +
          view.getFloat32(lineBase + TEXT_LINE_OFFSET_X, true);
        const lineY = contentBox.y +
          view.getFloat32(lineBase + TEXT_LINE_OFFSET_Y, true);
        const width = view.getFloat32(lineBase + TEXT_LINE_OFFSET_WIDTH, true);
        const availableWidth = view.getFloat32(
          lineBase + TEXT_LINE_OFFSET_AVAIL,
          true,
        );
        // x is the line's band left; the glyphs start after the text-align
        // shift the paint emitter takes (text_line_align_offset).
        const alignedX = lineX + engine.exports.text_line_align_offset(nodeIndex, width, availableWidth);
        lineBoxes.push({
          nodeIndex,
          lineIndex,
          x: lineX,
          y: lineY,
          alignedX,
          width,
          height: lineHeight,
          availableWidth,
          baseline: lineY + baselineOffset,
          firstGlyph: view.getUint32(
            lineBase + TEXT_LINE_OFFSET_FIRST_GLYPH,
            true,
          ),
          glyphCount: view.getUint32(
            lineBase + TEXT_LINE_OFFSET_GLYPH_COUNT,
            true,
          ),
        });
      }
    }
    const value = {
      kind: "layout",
      viewport: { width: scene.width, height: scene.height },
      boxes,
      lineBoxes,
    };
    return freezeArtifactValue({ ...value, bytes: artifactBytes(value) });
  }

  async function createLayoutArtifact(
    scene,
    {
      resolveResource = null,
      onImageLoadError = null,
      layoutNodeCapacity = Infinity,
    } = {},
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    return await runExclusiveEngineOperation(async () => {
      engine.exports.set_device_scale(1);
      // A layout artifact publishes the rows as a frame does, so the native
      // SVG path join needs its stroke atlas entries first.
      const resources = await prepareImages(resolveFontIndices(scene.nodes),
        resolveResource, scene.imageSources, onImageLoadError);
      const nodes = await prepareSvgPathResources(
        prepareAuthoredSceneInput(core, resources, fontRegistry));
      const generationReservation = resetAnalyticalLayoutState(nodes.length);
      writeSceneNodesAndTileConfig(
        scene,
        nodes,
        null,
        layoutNodeCapacity,
        generationReservation,
      );
      prepareLayoutSvgGeometry(nodes.length, scene.width, scene.height);
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return readLayoutArtifact(scene, nodes);
    });
  }

  // The paint record of a scene without a raster target: the rows are
  // written and the commands emitted as a frame does, and the core decodes
  // the command stream where the engine wrote it. No render context,
  // raster plan, GPU submission, readback or encoding takes part. Returns
  // the paint artifact facade and the prepared nodes.
  async function createPaintRecord(
    scene,
    {
      resolveResource = null,
      onImageLoadError = null,
      layoutNodeCapacity = Infinity,
    } = {},
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    return await runExclusiveEngineOperation(async () => {
      for (;;) {
        engine.exports.set_device_scale(1);
        const resources = await prepareImages(resolveFontIndices(scene.nodes),
          resolveResource, scene.imageSources, onImageLoadError);
        const nodes = await prepareSvgPathResources(
          prepareAuthoredSceneInput(core, resources, fontRegistry));
        writeSceneNodesAndTileConfig(scene, nodes, null, layoutNodeCapacity, null, true, null, null, false);
        engine.exports.clear_tile_dirty_map();
        engine.exports.set_paint_artifact_capture(1);
        engine.exports.set_retained_frame_enabled(0);
        const bytes = engine.exports.emit_commands(nodes.length);
        // Registry fallback faces that the layout requested: answer them,
        // then write and emit again, so the text shapes with them.
        const answering = answerFallbackFaces();
        if (answering !== null) {
          await answering;
          continue;
        }
        const paintArtifact = capturePaintRecord(core, {
          commands: { pointer: engine.exports.command_buffer_base(), length: bytes },
          glyphs: { pointer: engine.exports.glyph_buffer_base(), length: engine.exports.glyph_bytes() },
          nodes,
          textRuns: currentTextBatch.runSpans(),
          sceneChildren: scene.nodes.map((node) => node.children ?? []),
          width: scene.width,
          height: scene.height,
        });
        commandDecodeWork.commands += paintArtifact.commandCount;
        return { paintArtifact, nodes };
      }
    });
  }

  // The name of a command (command_name); undefined for a command that has
  // none.
  const commandNames = new Map();
  function commandName(opcode) {
    if (!commandNames.has(opcode)) commandNames.set(opcode, core.string("command_name", opcode) ?? undefined);
    return commandNames.get(opcode);
  }

  function decodeClipEntries(commandView, commandOffset, deviceScale = 1) {
    const count = commandView.getUint16(
      commandOffset + CMD_PUSH_CLIP_OFFSET_COUNT,
      true,
    );
    const entries = [];
    for (let index = 0; index < count; index++) {
      const entryOffset = commandOffset + CMD_PUSH_CLIP_HEADER_SIZE +
        index * CLIP_ENTRY_SIZE;
      const flags = commandView.getUint8(entryOffset + CLIP_ENTRY_OFFSET_FLAGS);
      entries.push({
        flags,
        x: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_X, true) /
          deviceScale,
        y: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_Y, true) /
          deviceScale,
        width: commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_W, true) /
          deviceScale,
        height:
          commandView.getFloat32(entryOffset + CLIP_ENTRY_OFFSET_H, true) /
          deviceScale,
        radii: Array.from(
          { length: 8 },
          (_, radiusIndex) =>
            commandView.getFloat32(
              entryOffset + CLIP_ENTRY_OFFSET_RADII + radiusIndex * 4,
              true,
            ) / deviceScale,
        ),
        affine: (flags & CLIP_ENTRY_FLAG_AFFINE) !== 0
          ? Array.from(
            { length: 6 },
            (_, affineIndex) => {
              const value = commandView.getFloat32(
                entryOffset + CLIP_ENTRY_OFFSET_AFFINE + affineIndex * 4,
                true,
              );
              return affineIndex < 4 ? value : value / deviceScale;
            },
          )
          : null,
        pathMask: (flags & CLIP_ENTRY_FLAG_PATH_MASK) !== 0,
      });
    }
    return entries;
  }

  // The paint of a rectangle command: its fill colour (linear premultiplied
  // RGBA as the command stores it, or null without a fill), its border widths
  // (top, right, bottom, left; zeros without a border), its corner radii
  // (x then y for top left, top right, bottom right, bottom left), and
  // whether a transform places it.
  function decodeRectanglePaint(commandView, commandOffset) {
    const flags = commandView.getUint8(commandOffset + CMD_RECT_OFFSET_FLAGS);
    const fill = (flags & CMD_RECT_FLAG_FILL)
      ? [0, 1, 2, 3].map((channel) => commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_FILL + channel * F32, true))
      : null;
    const borders = [CMD_RECT_OFFSET_BORDER_TOP, CMD_RECT_OFFSET_BORDER_RIGHT, CMD_RECT_OFFSET_BORDER_BOTTOM,
      CMD_RECT_OFFSET_BORDER_LEFT].map((field) =>
        (flags & CMD_RECT_FLAG_BORDER) ? commandView.getFloat32(commandOffset + field, true) : 0);
    const radii = Array.from({ length: 8 }, (_, index) =>
      commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X + index * F32, true));
    return { fill, borders, radii, transformed: (flags & CMD_RECT_FLAG_TRANSFORM) !== 0 };
  }
  function decodeCommandGeometry(commandView, commandOffset, opcode) {
    if (opcode === CMD_RECT) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_Y, true),
        width: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_W, true),
        height: commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_H, true),
      };
    }
    if (opcode === CMD_TEXT) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_TEXT_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_TEXT_OFFSET_Y, true),
        baseline: commandView.getFloat32(
          commandOffset + CMD_TEXT_OFFSET_BL,
          true,
        ),
      };
    }
    if (opcode === CMD_IMAGE) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_Y, true),
        width: commandView.getFloat32(commandOffset + CMD_IMAGE_OFFSET_W, true),
        height: commandView.getFloat32(
          commandOffset + CMD_IMAGE_OFFSET_H,
          true,
        ),
      };
    }
    if (opcode === CMD_SVG_PATH) {
      return {
        x: commandView.getFloat32(commandOffset + CMD_SVG_PATH_OFFSET_X, true),
        y: commandView.getFloat32(commandOffset + CMD_SVG_PATH_OFFSET_Y, true),
        width: commandView.getFloat32(
          commandOffset + CMD_SVG_PATH_OFFSET_W,
          true,
        ),
        height: commandView.getFloat32(
          commandOffset + CMD_SVG_PATH_OFFSET_H,
          true,
        ),
      };
    }
    if (opcode === CMD_BOX_SHADOW) {
      return {
        x: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_X,
          true,
        ),
        y: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_Y,
          true,
        ),
        width: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_W,
          true,
        ),
        height: commandView.getFloat32(
          commandOffset + CMD_BOX_SHADOW_OFFSET_H,
          true,
        ),
      };
    }
    return null;
  }

  const utf8Decoder = new TextDecoder();

  // The engine row of scene node $sceneIndex: the same index unless a
  // normalization (order-modified children, SVG use) renumbered the rows,
  // which keep their scene index as _inspectionSourceNodeIndex. -1 for a
  // node the rows do not hold.
  function engineIndexOfSceneNode(nodes, sceneIndex) {
    if ((nodes[sceneIndex]?._inspectionSourceNodeIndex ?? sceneIndex) === sceneIndex) {
      return sceneIndex;
    }
    return nodes.findIndex((node, index) =>
      (node._inspectionSourceNodeIndex ?? index) === sceneIndex
    );
  }

  // A copy of the raster tile map $tiles with the engine's damage marked
  // (raster-tiles.watpart). An empty map has no tile to mark.
  function rasterDirtyTiles(exportName, tiles, ...parameters) {
    if (tiles.byteLength === 0) return tiles;
    core.status(exportName, ...core.byteInput(tiles), ...parameters);
    const pointer = core.exports.abi_output_pointer();
    return core.refreshBytes().slice(pointer, pointer + core.exports.abi_output_length());
  }

  // `page` lists one page of a paged scene (emitPageCommands); null lists
  // the continuous document.
  async function createDisplayListArtifact(scene, { page = null } = {}) {
    // The document whose faces name the engine font instances of the list.
    const sceneDocument = scene.nodes.find((node) => node._corePublication !== undefined)
      ?._corePublication.documentHandle ?? 0n;
    const emitted = await runExclusiveEngineOperation(async () => {
      const result = await emitSceneCommands(scene, {
        captureNodeMarkers: true,
        page,
      });
      const glyphBufferBase = engine.exports.glyph_buffer_base();
      return {
        ...result,
        glyphBuffer: new Uint8Array(
          engine.memory.buffer.slice(
            glyphBufferBase,
            glyphBufferBase + engine.exports.glyph_bytes(),
          ),
        ),
        textRuns: currentTextBatch?.copyRuns() ?? [],
        // The OpenType features each node's text shapes with: its shaping
        // context's font feature set and the letter-spacing ligature rule
        // (engine-layout.watpart $shapeFeaturesBuild).
        nodeFeatures: Array.from(scene.nodes, (_, index) => {
          const count = engine.exports.shape_features(index);
          const view = new DataView(engine.memory.buffer, engine.exports.shape_features_pointer(), count * SHAPE_FEATURE_SIZE);
          return Array.from({ length: count }, (_, feature) => {
            const tag = view.getUint32(feature * SHAPE_FEATURE_SIZE + SHAPE_FEATURE_TAG, true);
            return [
              String.fromCharCode(tag >>> 24, (tag >>> 16) & 0xFF, (tag >>> 8) & 0xFF, tag & 0xFF),
              view.getUint32(feature * SHAPE_FEATURE_SIZE + SHAPE_FEATURE_VALUE, true),
            ];
          });
        }),
      };
    });
    const commands = [];
    const groups = [];
    const clipStack = [];
    const groupStack = [];
    let currentNodeIndex = null;
    for (let byteOffset = 0; byteOffset < emitted.bytesWritten;) {
      const opcode = emitted.view.getUint8(byteOffset);
      const byteLength = commandByteSize(emitted.view, byteOffset);
      const commandIndex = commands.length;
      if (opcode === CMD_SET_NODE) {
        currentNodeIndex = emitted.view.getUint32(
          byteOffset + CMD_SET_NODE_OFFSET_INDEX,
          true,
        );
      }
      let textRun = null;
      if (opcode === CMD_TEXT) {
        const glyphCount = emitted.view.getUint16(
          byteOffset + CMD_TEXT_OFFSET_GCOUNT,
          true,
        );
        const glyphOffset = emitted.view.getUint32(
          byteOffset + CMD_TEXT_OFFSET_GOFF,
          true,
        );
        const fontIndex = emitted.view.getUint16(
          byteOffset + CMD_TEXT_OFFSET_FONT,
          true,
        );
        const fontSize = engine.exports.used_font_size(emitted.view.getFloat32(
          byteOffset + CMD_TEXT_OFFSET_FSIZE,
          true,
        ));
        const unitsPerEm = emitted.view.getUint16(
          byteOffset + CMD_TEXT_OFFSET_UPEM,
          true,
        );
        const glyphView = new DataView(
          emitted.glyphBuffer.buffer,
          emitted.glyphBuffer.byteOffset,
          emitted.glyphBuffer.byteLength,
        );
        const glyphIds = new Array(glyphCount);
        const advances = new Array(glyphCount);
        // Where each glyph draws: its pen plus its ink offset (the
        // HarfBuzz offsets, glyphInkY up), in the units of the advances.
        const glyphPositions = new Array(glyphCount);
        const glyphInkY = new Array(glyphCount);
        const clusters = new Array(glyphCount);
        let clusterStart = Number.MAX_SAFE_INTEGER;
        let clusterEnd = 0;
        for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
          const entryOffset = glyphOffset + glyphIndex * GLYPH_ENTRY_SIZE;
          glyphIds[glyphIndex] = glyphView.getUint16(
            entryOffset + GLYPH_OFFSET_ID,
            true,
          );
          glyphPositions[glyphIndex] = Math.fround(
            glyphView.getFloat32(entryOffset + GLYPH_OFFSET_X_OFFSET, true) +
              glyphView.getFloat32(entryOffset + GLYPH_OFFSET_INK_X, true),
          ) * fontSize / unitsPerEm;
          glyphInkY[glyphIndex] = glyphView.getFloat32(
            entryOffset + GLYPH_OFFSET_INK_Y,
            true,
          ) * fontSize / unitsPerEm;
          advances[glyphIndex] = glyphView.getFloat32(
            entryOffset + GLYPH_OFFSET_X_ADVANCE,
            true,
          ) * fontSize / unitsPerEm;
          const glyphClusterStart = glyphView.getUint32(
            entryOffset + GLYPH_OFFSET_CLUSTER_START,
            true,
          );
          const glyphClusterEnd = glyphView.getUint32(
            entryOffset + GLYPH_OFFSET_CLUSTER_END,
            true,
          );
          clusters[glyphIndex] = {
            start: glyphClusterStart,
            end: glyphClusterEnd,
          };
          clusterStart = Math.min(clusterStart, glyphClusterStart);
          clusterEnd = Math.max(clusterEnd, glyphClusterEnd);
        }
        const preparedBytes = emitted.textRuns[currentNodeIndex]?.bytes ??
          new Uint8Array();
        const text = glyphCount === 0 || clusterEnd > preparedBytes.length
          ? ""
          : utf8Decoder.decode(
            preparedBytes.subarray(clusterStart, clusterEnd),
          );
        textRun = {
          // The scene node whose text the run paints (its CMD_SET_NODE).
          nodeIndex: currentNodeIndex,
          text,
          characterCount: text.length,
          // The node's whole prepared text, which clusters index as UTF-8
          // byte offsets: a line fragment's glyphs were shaped in it. An
          // appended text-overflow marker (three bytes, U+2026) is shaped
          // alone and is not part of it.
          sourceText: utf8Decoder.decode(
            emitted.textRuns[currentNodeIndex]?.ellipsis
              ? preparedBytes.subarray(0, preparedBytes.length - 3)
              : preparedBytes,
          ),
          // The OpenType features the run was shaped with.
          features: emitted.nodeFeatures[currentNodeIndex] ?? [],
          letterSpacing: emitted.textRuns[currentNodeIndex]?.letterSpacing ?? 0,
          glyphIds,
          glyphPositions,
          glyphInkY,
          advances,
          clusters,
          fontSize,
          unitsPerEm,
          fontWeight: emitted.view.getUint8(byteOffset + CMD_TEXT_OFFSET_WEIGHT) * 100,
          // The variation instance of the glyph outlines: the optical size
          // (CSS px) the face was shaped at, whether font-optical-sizing
          // is none, and the font-variation-settings pairs.
          opticalSize: emitted.view.getFloat32(byteOffset + CMD_TEXT_OFFSET_OPSZ, true),
          ...textVariationControl(engine, emitted.view.getUint16(byteOffset + CMD_TEXT_OFFSET_VARIATIONS, true)),
          fontStyle: emitted.view.getUint8(byteOffset + CMD_TEXT_OFFSET_STYLE) === 1
            ? "italic"
            : "normal",
          font: fontIdentityForDocument(fontIndex, sceneDocument),
          color: [0, 4, 8, 12].map((offset) =>
            emitted.view.getFloat32(byteOffset + CMD_TEXT_OFFSET_COLOR + offset, true)
          ),
          // The affine the run paints under, [a, b, c, d, e, f] with the
          // translation in the command's own units (CSS px), or null:
          // device = (a x + c y + e s, b x + d y + f s) for a point (x, y)
          // of the run already at device scale s.
          transform:
            (emitted.view.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS) &
                CMD_TEXT_FLAG_TRANSFORM) === 0
              ? null
              : Array.from({ length: 6 }, (_, index) =>
                emitted.view.getFloat32(byteOffset + CMD_TEXT_OFFSET_XFORM + index * F32, true)
              ),
          textShadow:
            (emitted.view.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS) &
              CMD_TEXT_FLAG_TEXT_SHADOW) !== 0,
        };
      }
      let clipEntries = null;
      if (opcode === CMD_PUSH_CLIP) {
        clipEntries = decodeClipEntries(emitted.view, byteOffset);
        clipStack.push(clipEntries);
      } else if (opcode === CMD_POP_CLIP) {
        if (clipStack.length === 0) {
          throw new Error("display-list artifact: clip stack underflow");
        }
        clipStack.pop();
      }
      const popOpcode = core.exports.command_group_close(opcode);
      if (popOpcode !== 0) {
        const group = {
          kind: core.string("command_group_kind", opcode),
          startCommandIndex: commandIndex,
          endCommandIndex: null,
        };
        groups.push(group);
        groupStack.push({ group, popOpcode });
      } else if (
        groupStack.length > 0 &&
        opcode === groupStack[groupStack.length - 1].popOpcode
      ) {
        groupStack.pop().group.endCommandIndex = commandIndex;
      }
      commands.push({
        commandIndex,
        byteOffset,
        byteLength,
        opcode,
        name: commandName(opcode),
        clipDepth: clipStack.length,
        groupDepth: groupStack.length,
        clipEntries,
        geometry: decodeCommandGeometry(emitted.view, byteOffset, opcode),
        ...(opcode === CMD_RECT ? { paint: decodeRectanglePaint(emitted.view, byteOffset) } : {}),
        ...(textRun ?? {}),
      });
      byteOffset += byteLength;
    }
    // A terminal clip state is valid; only a later unmatched pop is malformed.
    if (groupStack.length !== 0) {
      throw new Error("display-list artifact: unclosed group stack");
    }
    const value = {
      kind: "display-list",
      viewport: { width: scene.width, height: scene.height },
      commands,
      groups,
    };
    return freezeArtifactValue({
      ...value,
      bytes: new Uint8Array(
        emitted.view.buffer,
        emitted.view.byteOffset,
        emitted.bytesWritten,
      ),
    });
  }

  function createInvalidationArtifact(frame, tileSize = 64) {
    if (!Number.isInteger(tileSize) || tileSize <= 0) {
      throw new TypeError("tileSize must be a positive integer");
    }
    const frameReason = frame.invalidationReason ??
      core.string("frame_invalidation_reason", frame.frameSequence ?? NaN);
    const dirtyRectangles = (frame.dirtyRectangles ?? frame.dirtyRects ?? [])
      .map((rectangle) => ({ ...rectangle, reason: rectangle.reason ?? frameReason }));
    // The tiles the dirty rectangles cover (frame_invalidation_tiles).
    const rectangles = new Float64Array(dirtyRectangles.length * 4);
    dirtyRectangles.forEach((rectangle, index) => rectangles.set([rectangle.x, rectangle.y, rectangle.w, rectangle.h], index * 4));
    core.status("frame_invalidation_tiles", frame.width, frame.height, tileSize,
      ...core.byteInput(new Uint8Array(rectangles.buffer)));
    const output = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), core.exports.abi_output_length());
    const columns = output.getUint32(FRAME_TILES.COLUMNS, true);
    const rows = output.getUint32(FRAME_TILES.ROWS, true);
    const tileMap = Array.from({ length: columns * rows }, (_, tile) => output.getUint8(FRAME_TILES.MAP + tile) !== 0);
    const value = {
      kind: "invalidation",
      frameSequence: frame.frameSequence ?? null,
      viewport: { width: frame.width, height: frame.height },
      tileSize,
      columns,
      rows,
      tileMap,
      dirtyRectangles,
    };
    return freezeArtifactValue({ ...value, bytes: artifactBytes(value) });
  }


  // Pooled render contexts, keyed by canvas size.
  //
  // createRenderContext() builds a fresh WebGPU device, compiles every
  // shader module and rebuilds every pipeline and buffer pool. Measured:
  // 21.9 ms, against 14.0 ms for the render itself and 0.3 ms for the WAT
  // engine's whole layout+emit pass. Calling it per scene therefore threw
  // away more than half of every render's cost rebuilding state that never
  // changes — structurally the same per-call-setup mistake the Chrome
  // oracle had before it was pooled, one layer down.
  //
  // Keyed by size because a context owns a mainTexture and a readback ring
  // of exactly those dimensions. Reuse across scenes of the SAME size is
  // what the context was always built for — the video/stream paths already
  // drive one context across thousands of frames — and every render here
  // is non-incremental, so mainTexture is cleared on entry and nothing
  // carries over.
  //
  // Bounded LRU: a long run touches many scene sizes and each context pins
  // a device's worth of GPU memory. There is no context-level teardown, so
  // eviction destroys the device, which releases its textures, buffers and
  // pipelines together.
  const renderContexts = new Map(); // "WxH" -> { ctx, queue, renders }; insertion order = LRU
  // 16, chosen by measurement, not by reasoning about working-set size.
  // The obvious argument says "size it above the real working set" — the
  // pixel sweep alone touches 28 (14 scene sizes x 2 densities) — but each
  // pooled context pins a whole WebGPU device, and holding many of them is
  // itself expensive. Measured on the same 26-file batch: cap 48 -> 29.0s,
  // cap 24 -> 18.9s, cap 16 -> 19.4s, cap 12 -> 18.9s, cap 8 -> 19.8s. The
  // curve is flat from 8 to 24 and falls off a cliff past it; 48 ran 50%
  // SLOWER than 12.
  //
  // Raising it does not help the sweep anyway: that test renders each size
  // about twice, so there is little to reuse no matter how much is retained
  // (16.4s before pooling, 16.1s after, at every cap tried). Its cost is
  // the box-parity pass and the 2x pass, not context setup — see
  // design/paint-coverage.md's oracle follow-up.
  const MAX_RENDER_CONTEXTS = 16;

  // Renders are SERIALIZED per context. Two concurrent renders sharing one
  // context would interleave on its uniform pools and instance buffer —
  // the exact hazard rasterize.js documents at its rect uniform pool, which
  // has already shipped twice there.
  //
  // The SVG raster runtime renders concurrently: each raster starts when
  // the raster before it has submitted its frame (rasterizeSvgImage). Its
  // renders keep nothing in their context between frames (no incremental
  // raster, and the pixels are read back to host memory), so a render of a
  // size whose contexts all have a render takes another context of that
  // size ("WxH:backend#N"), and a raster does not wait for the complete
  // render of another raster of its size. Other runtimes keep one context
  // for each size: a surface's incremental raster reads the pixels that
  // its context kept from the frame before.
  async function withRenderContext(
    width,
    height,
    fn,
    graphicsBackend = "auto",
  ) {
    const size = `${width}x${height}:${graphicsBackend}`;
    let key = size;
    if (svgImageRasterMode) {
      for (let copy = 1; renderContexts.get(key)?.renders > 0; copy++) {
        key = `${size}#${copy}`;
      }
    }
    let entry = renderContexts.get(key);
    if (entry) {
      renderContexts.delete(key); // refresh LRU position
    } else {
      entry = {
        ctx: await createRenderContext({
          width,
          height,
          graphicsBackend,
          sharedStateOwner: graphicsStateOwner,
        }),
        queue: Promise.resolve(),
        // The renders queued on or running in this context.
        renders: 0,
      };
    }
    renderContexts.set(key, entry);
    entry.renders++;

    while (renderContexts.size > MAX_RENDER_CONTEXTS) {
      const oldestKey = renderContexts.keys().next().value;
      if (oldestKey === key) break; // never evict the one we are about to use
      const evicted = renderContexts.get(oldestKey);
      renderContexts.delete(oldestKey);
      await evicted.queue; // let any queued render finish first
      await destroyRenderContext(evicted.ctx);
    }

    const run = entry.queue.then(() => fn(entry.ctx));
    // Keep the chain alive past a failing render, or one thrown error would
    // poison every later render through this context.
    const settled = () => {
      entry.renders--;
    };
    entry.queue = run.then(settled, settled);
    return run;
  }

  // A pooled context releases its per-context GPU resources; the shared
  // WebGPU device (rasterize.js createSharedWebgpuState) stays with this
  // runtime's graphicsStateOwner until releaseRenderContexts runs.
  async function destroyRenderContext(ctx) {
    await ctx.destroy();
  }

  // Drop every pooled context, then release the shared WebGPU device once
  // no live context references it. Nothing in the repo needs this today; it
  // exists so a long-lived embedder can reclaim GPU memory deliberately
  // rather than waiting for the process to exit.
  async function releaseRenderContexts() {
    for (const entry of renderContexts.values()) {
      await entry.queue;
      await destroyRenderContext(entry.ctx);
    }
    renderContexts.clear();
    if (svgRasterRuntimePromise) {
      const { runtime, fonts } = await svgRasterRuntimePromise;
      try {
        await runtime.releaseRenderContexts();
      } finally {
        fonts.dispose();
        svgRasterRuntimePromise = null;
      }
    }
    await colorGlyphCache.release();
    await releaseSharedWebgpuStates(graphicsStateOwner);
    await releaseSharedWebgl2State(graphicsStateOwner);
    await shutdownDefaultGlyphResourceManager();
    currentTextBatch?.release();
    currentTextBatch = null;
    if (resourceEngineScope !== 0n) {
      core.resourceEngineRelease(resourceEngineScope);
      releasePixels();
    }
    resourceEngineScope = 0n;
  }
  async function renderScenePixels(scene, deviceScale = 1, renderOptions = {}) {
    try {
      return await renderScenePixelsNow(scene, deviceScale, renderOptions);
    } catch (error) {
      releaseRetainedPreparation(renderOptions.engineWriteOwner);
      engineWriteOwner = null;
      throw error;
    }
  }

  // Writes one row of `wordsPerRow` u32 words per range into an engine
  // allocation, passes its address to `use`, frees it, and returns what
  // `use` returned.
  function withRasterPlanRangeTable(ranges, wordsPerRow, rowWords, use) {
    const table = engine.exports.abi_malloc(ranges.length * wordsPerRow * 4);
    if (table === 0) {
      throw new Error(
        `raster plan range table allocation rejected ${ranges.length} rows of ${wordsPerRow} words`,
      );
    }
    try {
      const rows = new Uint32Array(
        engine.memory.buffer,
        table,
        ranges.length * wordsPerRow,
      );
      for (let index = 0; index < ranges.length; index++) {
        rows.set(rowWords(ranges[index]), index * wordsPerRow);
      }
      return use(table);
    } finally {
      engine.exports.abi_free(table);
    }
  }

  // The number of records, one per command, of a prepared raster plan.
  function rasterPlanRecordCount(plan) {
    return new DataView(engine.memory.buffer).getUint32(plan + RASTER_PLAN_HEADER_RECORD_COUNT, true);
  }

  async function renderScenePixelsNow(
    scene,
    deviceScale = 1,
    renderOptions = {},
  ) {
    const {
      prepareEngine,
      renderContext,
      glyphResourceManager = getDefaultGlyphResourceManager(),
      changedNodeIndices = null,
      mutationNodeIndices: _mutationNodeIndices = null,
      forceGenerationNodeIndices = null,
      scrollOnlyNodeIndices = null,
      engineWriteOwner: renderWriteOwner = null,
      retainedPreparationAllowed = false,
      timeMilliseconds: _timeMilliseconds,
      sampledLayout,
      capturePaintArtifact = false,
      captureTextGeometry = false,
      // Whether the caller reads the coordinates of this frame's text
      // geometry artifact. A caller that keeps the text geometry it
      // presented (a scroll frame) passes false: the engine may then
      // replay commands whose sticky scopes moved, whose bytes, and so
      // the kept artifact, carry the sticky offsets of the walk that wrote
      // them. A later frame that reads the artifact walks again.
      textGeometryArtifactRead = true,
      authoritativeDirtyTiles = false,
      graphicsBackend = "auto",
      resolveResource = null,
      onImageLoadError = null,
      svgImageTimings = null,
      svgPathStageTimings = null,
      onPerformance = null,
      layoutNodeCapacity = Infinity,
      // Visible-region rasterization (raster-scale plan, slice 3): the
      // CSS-pixel rectangle of the scene the raster target covers.
      // null covers the full scene. Layout and emission are unaffected;
      // the walker offsets and culls, and the target holds
      // visible size × deviceScale device pixels.
      visibleRectangle = null,
      // Native frame surface whose DOM selection and caret the engine paints.
      selectionFrameOwner = 0n,
      selectionPixelReadback = false,
      // The painted scrollbar parts, back to front: the scene index of the
      // scroller (-1 for the viewport), x, y, width, height and radius in
      // viewport CSS px, and the colour. The raster plan expands each
      // scroller's scrollbar marker from them. A function is called once,
      // after this frame's layout and before its raster, with the frame's
      // boxes and the engine's layout work so far (layout_compute_total: an
      // equal reading means no node was laid out since), and returns the
      // parts.
      scrollbarParts = [],
      // Paged media: { height, index } lays the scene out in pages of
      // `height` CSS px and paints page `index` (design/fragmentation.md).
      // The engine decides every break; the frame reports whether a later
      // page follows. null paints the continuous document.
      page = null,
      // The scene index of the root whose subtree the raster draws, or
      // null for the whole scene. Layout and emission still cover the whole
      // scene; raster_commands_select copies the subtree's commands and the
      // groups around them, and the plan rasters only those.
      selectedSceneIndex = null,
      // The paint group index of the layer that the raster draws, with all
      // it holds, or null. It excludes selectedSceneIndex.
      selectedLayer = null,
      // With node markers captured: the result carries the emission's text
      // geometry capture (`textCapture`, geometry_text_capture), which the
      // caller releases (geometry_text_release).
      textCapture: textCaptureRequested = false,
      ...rasterOptions
    } = renderOptions;
    const textOperationsRequired = captureTextGeometry;
    // A selection reads the node markers to find the subtree's commands.
    const captureNodeMarkers = capturePaintArtifact || textOperationsRequired || selectedSceneIndex !== null;
    // Only coordinate inspection requires bytes with current sticky offsets.
    const artifactCoordinatesRead = capturePaintArtifact ||
      (captureTextGeometry && textGeometryArtifactRead);
    validateLayoutNodeCapacity(layoutNodeCapacity);
    // A canvas that reads an SVG image rasters it at the device scale of
    // the last frame (svgImageDensity), and the broken image icon takes its
    // version for this frame's device pixels.
    svgImageDensity = Math.max(1, deviceScale);
    await selectBrokenImageIcon();
    core.statusRaw("frame_render_target_check", ...core.valueListInput([
      page === null ? null : Number(page.height),
      page === null ? null : String(page.height),
      page === null ? null : page.index,
      page === null ? null : String(page.index),
      visibleRectangle === null ? null : visibleRectangle.x,
      visibleRectangle === null ? null : visibleRectangle.y,
      visibleRectangle === null ? null : Number(visibleRectangle.width),
      visibleRectangle === null ? null : Number(visibleRectangle.height),
    ]));
    const logicalTargetWidth = visibleRectangle?.width ?? scene.width;
    const logicalTargetHeight = visibleRectangle?.height ?? scene.height;
    if (!renderContext) {
      return await withRenderContext(
        logicalTargetWidth * deviceScale,
        logicalTargetHeight * deviceScale,
        (context) =>
          renderScenePixels(scene, deviceScale, {
            ...renderOptions,
            renderContext: context,
            glyphResourceManager,
            graphicsBackend,
          }),
        graphicsBackend,
      );
    }
    const renderWallStartedAt = hostNow();
    const textPreparationBefore = { ...textPreparationWork };
    const commandDecodeBefore = commandDecodeWork.commands;
    const previous = renderWriteOwner &&
      retainedPreparations.get(renderWriteOwner);
    const resourceRevision = core.status("resource_revision");
    const fontRevision = fontRegistry.revision;
    const changed = changedNodeIndices === null
      ? null
      : new Set(changedNodeIndices);
    for (const index of forceGenerationNodeIndices ?? []) changed?.add(index);
    if (changed !== null && changed.size > 0) {
      core.statusRaw("frame_changed_rows_check", ...core.valueListInput([
        scene.nodes.length,
        ...[...changed].flatMap((index) => [index, `${index}`]),
      ]), changed.size);
    }
    const provenanceMatches = scene.changedRows == null ||
      (scene.publicationRevision !== undefined &&
        (scene.publicationRevision === previous?.publicationRevision ||
          (scene.previousPublicationRevision !== undefined &&
            scene.previousPublicationRevision !== 0n &&
            scene.previousPublicationRevision ===
              previous?.publicationRevision)));
    // The previous preparation's commands, glyph atlases, image and path
    // resources and text geometry describe this frame too when its
    // resources, scale, size, capture modes and page are this frame's: a
    // frame whose commands the engine keeps (sparse, or a replayed
    // emission) reuses them. Its rows depend on all of these but the page.
    const previousRowInputsHold = !!previous?.valid &&
      previous.resourceRevision === resourceRevision &&
      previous.fontRevision === fontRevision &&
      previous.svgPathAtlasRevision === (previous.svgPathAtlas?.revision ?? 0) &&
      previous.resolveResource === resolveResource &&
      previous.deviceScale === deviceScale &&
      previous.glyphResourceManager === glyphResourceManager &&
      previous.width === scene.width && previous.height === scene.height &&
      !capturePaintArtifact &&
      previous.captureNodeMarkers === captureNodeMarkers &&
      canvasSourcesHold(previous.imageSourceRevisions, scene.imageSources);
    const previousResourcesHold = previousRowInputsHold &&
      previous.page?.height === page?.height &&
      previous.page?.index === page?.index;
    // The engine holds the previous preparation's rows under this owner's
    // claim, and the scene names the same rows.
    const previousRowsHeld = !!previous && retainedPreparationAllowed &&
      changed !== null && provenanceMatches &&
      engineWriteOwner === renderWriteOwner &&
      previous.writeClaim === engineWriteClaims.get(engine.memory) &&
      previous.coreWriteRevision === core.engineFrameRevision &&
      previous.nodes.length === scene.nodes.length;
    let sparse = page === null && previousResourcesHold && previousRowsHeld;
    // Another page of the same rows publishes nothing: the frame lays the
    // held rows out and paints them for its page.
    const pageRowsHeld = page !== null && previousRowInputsHold &&
      previousRowsHeld && changed.size === 0;
    if (previous) previous.valid = false;
    // The engine holds the previous preparation's rows under this owner's
    // claim. Two ways to avoid publishing every row again:
    // - sparse: the retained frame patches opacity groups in place and
    //   emits again, and splices in, the command blocks that read another
    //   changed paint field; no layout, no emission walk. A text row takes
    //   it only while the write keeps its prepared run;
    // - patched: the changed rows are published as patches, then the frame
    //   lays out and emits in full. The layout is incremental by row
    //   generation and the emission walk is cheap; the full publication
    //   was the cost. Text rows are allowed (the write re-prepares text
    //   for a changed run, and refuses more than
    //   SPARSE_TEXT_REPREPARATION_LIMIT of them); rows that change the index
    //   space or a row's normalization are not.
    let patched = sparse && !previous.globalPreparation && changed.size > 0;
    if (sparse && changed.size) {
      if (previous.globalPreparation) sparse = false;
      for (const index of changed) {
        const node = scene.nodes[index];
        const old = previous.nodes[index];
        if (
          needsGlobalPreparation(node) || needsGlobalPreparation(old) ||
          (node.children?.length ?? 0) !== (old.children?.length ?? 0) ||
          node.children?.[0] !== old.children?.[0] ||
          (!usesCoreRecord(node) &&
            node.children?.some((child, childIndex) => child !== old.children[childIndex]))
        ) {
          sparse = false;
          patched = false;
          break;
        }
      }
    }
    // Rows that changed only their scroll offsets keep their generation
    // (engine_record_finish's scroll-only flag). The offsets feed the
    // post-layout scroll pass alone, so emit_commands replays the retained
    // commands and rebuilds only the scroll table instead of walking the
    // paint tree. The retained-frame transaction is not attempted for
    // them: its row comparison refuses a changed scroll offset, and the
    // abandoned transaction leaves the command buffer marked clobbered,
    // which forbids that replay.
    const scrollOnlyRows = patched && scrollOnlyNodeIndices !== null &&
      [...changed].every((index) =>
        scrollOnlyNodeIndices.has(index) &&
        !forceGenerationNodeIndices?.has(index)
      );
    if (scrollOnlyRows) sparse = false;
    let visitedNodeCount = 0;
    // Engine rows this frame published: every row for a full write, the
    // changed rows for a patch (the surface's rowsChanged work counter).
    let writtenRowCount = 0;
    let nodes;
    let globalPreparation = previous?.globalPreparation ?? false;
    const resolveRows = async (rows) => {
      visitedNodeCount += rows.length;
      const resources = await prepareImages(resolveFontIndices(rows),
        resolveResource, scene.imageSources, onImageLoadError);
      const pathStartedAt = svgPathStageTimings ? hostNow() : 0;
      const withPaths = await prepareSvgPathResources(
        prepareAuthoredSceneInput(core, resources, fontRegistry));
      if (svgPathStageTimings) {
        svgPathStageTimings.preparationMilliseconds +=
          hostNow() - pathStartedAt;
      }
      return withPaths;
    };
    const prepareFull = async () => {
      nodes = await resolveRows(scene.nodes);
      // Only a normalization that changes the row index space invalidates
      // every sparse delta. Unrelated grid/clip/transform nodes retain their
      // prepared inputs; actual layout drift is checked natively below.
      globalPreparation = nodes[0]?._corePublication?.indexSpaceChanged ?? false;
      visitedNodeCount += nodes.length;
      writtenRowCount = nodes.length;
      writeSceneNodesAndTileConfig(
        scene,
        nodes,
        null,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        null,
        false,
      );
    };
    if (sparse || patched) {
      const indices = [...changed];
      const resolved = indices.length === 0 ? [] : await resolveRows(
        indices.map((index) => scene.nodes[index]),
      );
      // A synchronous query may run during resource resolution. Never publish
      // a sparse delta into somebody else's rows or relocated pool spans.
      const held = engineWriteOwner === renderWriteOwner &&
        previous.writeClaim === engineWriteClaims.get(engine.memory) &&
        previous.coreWriteRevision === core.engineFrameRevision &&
          resourceRevision === core.status("resource_revision") &&
        fontRevision === fontRegistry.revision;
      sparse &&= held;
      patched &&= held;
      if (held) {
        nodes = previous.nodes;
        for (let i = 0; i < indices.length; i++) {
          nodes[indices[i]] = resolved[i];
        }
      }
    }
    // Publish and index the allocated raster target, not the fractional
    // CSS-size × density request. CSS layout and raster scale stay unchanged.
    const pxW = renderContext.width;
    const pxH = renderContext.height;
    // Device scale is applied by the native raster planner. Reset persistent
    // engine state so an older caller cannot leak a stale value into text
    // shaping (opsz reads it).
    engine.exports.set_device_scale(1);
    engine.exports.clear_tile_dirty_map();
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    engine.exports.set_retained_frame_enabled(
      renderWriteOwner !== null ? 1 : 0,
    );
    // A frame taking the serialization a synchronous layout getter produced
    // (render-surface's _takeSyncLayout) finds the engine already holding
    // those rows: the getter wrote them under this owner's claim and no
    // write happened since. Rows the surface restated after the getter ran
    // (scroll requests) and rows whose generation the surface forces are
    // published again as a patch; everything else stands. The getter
    // resolved images synchronously: an image still loading has no index
    // there, so its row is resolved again, as a serialized frame resolves
    // it, waiting for the load.
    const reuseSyncLayoutWrite = async () => {
      const written = syncLayoutWrite;
      if (written === null) return false;
      syncLayoutWrite = null;
      const source = scene.syncLayoutSource ?? scene.nodes;
      if (
        written.sceneNodes !== source || written.owner !== renderWriteOwner ||
        written.width !== scene.width || written.height !== scene.height ||
        written.nodes.length !== scene.nodes.length
      ) return false;
      const patchIndices = new Set(scene.syncLayoutScrollIndices ?? []);
      for (const index of forceGenerationNodeIndices ?? []) {
        patchIndices.add(index);
      }
      for (let index = 0; index < written.nodes.length; index++) {
        if (hasUnresolvedImage(written.nodes[index])) patchIndices.add(index);
      }
      const indices = [...patchIndices];
      const resolved = indices.length === 0 ? [] : await resolveRows(
        indices.map((index) => scene.nodes[index]),
      );
      // Resolution may await; a query or another frame may have written.
      if (
        engineWriteOwner !== renderWriteOwner ||
        written.writeClaim !== engineWriteClaims.get(engine.memory) ||
        written.coreWriteRevision !== core.engineFrameRevision ||
        written.resourceRevision !== core.status("resource_revision") ||
        written.fontRevision !== fontRegistry.revision
      ) return false;
      globalPreparation = written.globalPreparation;
      if (indices.length === 0) {
        nodes = written.nodes;
        return true;
      }
      nodes = written.nodes.slice();
      for (let i = 0; i < indices.length; i++) nodes[indices[i]] = resolved[i];
      visitedNodeCount += indices.length;
      writtenRowCount = indices.length;
      // Rows are stamped as a full write would stamp them (no scroll-only
      // flag): pool drift is irrelevant to the full emission that follows,
      // only a rejected publication sends the frame back to a full write.
      return writeSceneNodesAndTileConfig(
        scene,
        nodes,
        patchIndices,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        null,
        true,
      ) !== null;
    };
    // One patch write serves both: the retained frame needs it with every
    // pool unchanged (true); the patched frame needs only an accepted
    // publication (not null), then lays out and emits in full.
    let rowsPatched = false;
    if (sparse || patched) {
      visitedNodeCount += changed.size;
      const written = writeSceneNodesAndTileConfig(
        scene,
        nodes,
        changed,
        layoutNodeCapacity,
        null,
        true,
        forceGenerationNodeIndices,
        scrollOnlyRows ? scrollOnlyNodeIndices : null,
        true,
      );
      rowsPatched = written !== null;
      if (rowsPatched) writtenRowCount = changed.size;
      // The rows the patch left alone still retain the publication they
      // were lowered from; move them to this build's publication so the
      // older ones can be freed (one publication per build otherwise
      // accumulates until the next full write).
      if (
        rowsPatched &&
        scene.publicationRevision !== previous.publicationRevision
      ) {
        const publication = scene.nodes.find((node) =>
          node._corePublication !== undefined
        )?._corePublication;
        if (publication !== undefined) {
          core.status("engine_direct_rebase", publication.handle);
        }
      }
      sparse &&= written === true;
      if (sparse) {
        sparse = engine.exports.retained_frame_begin(
          nodes.length,
          scene.width,
          scene.height,
        ) === 1;
        if (sparse) {
          for (const index of changed) {
            if (engine.exports.retained_frame_validate_node(index) !== 1) {
              sparse = false;
              break;
            }
          }
        }
      }
    }
    if (pageRowsHeld) {
      nodes = previous.nodes;
    } else if (!sparse && !rowsPatched && !(await reuseSyncLayoutWrite())) {
      await prepareFull();
    }
    // Resource resolution can run synchronous layout queries while awaited.
    // Restore this frame's native modes after that shared-engine boundary.
    engine.exports.set_device_scale(1);
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    engine.exports.set_artifact_coordinates_read(
      artifactCoordinatesRead ? 1 : 0,
    );
    engine.exports.set_retained_frame_enabled(
      renderWriteOwner !== null ? 1 : 0,
    );
    // The engine's paint damage compares this frame with the engine's last
    // render emission: its painted-box mirror, its watermarks and the
    // command stream that emission reuse keeps. When another owner (a
    // surface over another document of this runtime) emitted last, that
    // emission is not this target's previous frame, and the damage misses
    // what this target still shows.
    const engineDamageOwned = retainedRowsOwner === renderWriteOwner;
    if (!engineDamageOwned) engine.exports.retained_rows_release();
    retainedRowsOwner = renderWriteOwner;
    engineWriteOwner = renderWriteOwner;
    const preparation =
      prepareEngine?.({ engine, view, nodes, physicalScene: scene }) ?? {};
    if (page === null && prepareLayoutSvgGeometry(nodes.length, scene.width, scene.height)) sparse = false;
    // The shared engine reads this surface's native selection immediately
    // before emission, without an await that could switch publication owners.
    core.status(
      "scene_selection_prepare",
      selectionFrameOwner,
      _timeMilliseconds ?? 0,
      selectionPixelReadback ? 1 : 0,
    );
    // The engine marks damage in the raster target's tiles from here to
    // the merge below, with no await between.
    const engineTileSize = writeTileGrid(scene, pxW, pxH, deviceScale, visibleRectangle);
    // Publication restores authored values. Sample animations before comparing
    // their paint values with the previous frame's sampled command state.
    if (sparse) {
      for (const index of changed) {
        if (engine.exports.retained_frame_node(index) !== 1) {
          sparse = false;
          break;
        }
      }
    }
    const emissionReusesBefore = engine.exports.emission_reuse_count();
    let bytes = sparse ? engine.exports.retained_frame_end() : -1;
    const retainedCommands = bytes >= 0;
    // The document's page count at this page height, and the page shown:
    // the requested one, or the last page when the document is shorter.
    let pageCount = 0;
    let pageIndex = 0;
    // Scene indices of the nodes on other pages.
    let offPageNodes = [];
    if (!retainedCommands) {
      if (page === null) {
        bytes = engine.exports.emit_commands(nodes.length);
      } else {
        ({ bytes, pageCount, pageIndex, offPageNodes } = emitPageCommands(scene, nodes, page, renderWriteOwner));
      }
    }
    // The layout requested registry fallback faces (decision 7): load and
    // answer them, then lay out and paint the frame again in full, so that
    // the requesting text shapes with them. No retained state of this
    // frame is kept.
    const answering = retainedCommands ? null : answerFallbackFaces();
    if (answering !== null) {
      await answering;
      return await renderScenePixelsNow(scene, deviceScale, {
        ...renderOptions,
        changedNodeIndices: null,
        retainedPreparationAllowed: false,
      });
    }
    // Work counters of this render: the nodes the layout pass computed (a
    // retained transaction lays nothing out), the command bytes a paint walk
    // wrote (a replayed or retained emission walks nothing), the nodes
    // whose paint the retained transaction changed, and the command blocks
    // it emitted again.
    const nodesLaidOut = engine.exports.layout_compute_count();
    const paintWalked = !retainedCommands &&
      engine.exports.emission_reuse_count() === emissionReusesBefore;
    const retainedCommandPatches = retainedCommands
      ? engine.exports.retained_patched_node_count()
      : 0;
    const commandBlocksEmitted = retainedCommands
      ? engine.exports.retained_block_emission_count()
      : 0;
    const blockCommandsEmitted = retainedCommands
      ? engine.exports.retained_block_command_count()
      : 0;
    let rasterPlanRangesReplanned = 0;
    let rasterPlanCommandsReplanned = 0;
    const commandRevision = engine.exports.command_revision();
    const layoutRevision = engine.exports.layout_revision();
    // An emission that outgrew the command buffer moved it: every reader
    // takes the base after the emission, never a constant.
    const commandBase = engine.exports.command_buffer_base();
    engine.exports.glyph_request_collect_paths(commandBase, bytes, deviceScale);
    const textPublication = captureTextRequestPublication(renderWriteOwner, previous?.textResources,
      retainedCommands || commandRevision === previous?.commandRevision,
      glyphResourceManager, glyphGenerationBackend);
    const writeClaim = engineWriteClaims.get(engine.memory);
    const coreWriteRevision = core.engineFrameRevision;
    const preparedResourceRevision = core.status("resource_revision");
    const preparedFontRevision = fontRegistry.revision;
    // emit_commands keeps its command buffer when only scroll offsets
    // changed since it last walked the paint tree: the command revision
    // holds. The previous preparation's commands, glyph atlases, path
    // atlas, text geometry and raster plan then describe this frame too,
    // except for the scroll table and the overlays.
    const replayedCommands = !retainedCommands && previousResourcesHold &&
      commandRevision === previous.commandRevision &&
      bytes === previous.cmdView.byteLength &&
      preparedResourceRevision === previous.resourceRevision &&
      preparedFontRevision === previous.fontRevision;
    const reusedCommands = (retainedCommands || replayedCommands) && textPublication.glyphLease?.active === true;
    // The retained transaction's edits of the command stream in stream
    // order: a block spliced in (kind 0) or an opacity group patched in
    // place (kind 1), with its offset and size in the new and the previous
    // stream and the scroll reference in effect at its start.
    const ranges = retainedCommands
      ? Array.from(
        { length: engine.exports.retained_command_changes_count() },
        (_, index) => ({
          offset: engine.exports.retained_command_change_offset(index),
          byteLength: engine.exports.retained_command_change_size(index),
          oldOffset: engine.exports.retained_command_change_old_offset(index),
          oldBytes: engine.exports.retained_command_change_old_size(index),
          scrollReference: engine.exports
            .retained_command_change_scroll_reference(index),
          kind: engine.exports.retained_command_change_kind(index),
        }),
      )
      : null;
    // Commands moved: an edit's new bytes differ in size from its old.
    const commandsMoved = retainedCommands && engine.exports.retained_command_changes_moved() !== 0;
    const rasterResourceRevision = reusedCommands
      ? previous.rasterResourceRevision
      : {};
    rasterOptions.commandRetention = renderWriteOwner === null ? null : {
      owner: renderWriteOwner,
      revision: commandRevision,
      baseRevision: retainedCommands ? previous.commandRevision : null,
      ranges,
      resourceRevision: rasterResourceRevision,
    };
    // The engine's damage of another owner's last emission (above) does not
    // describe this target: the frame rasterizes every tile.
    if (!engineDamageOwned && !authoritativeDirtyTiles && renderWriteOwner !== null) {
      rasterOptions.dirtyTiles = null;
    }
    // The damage tracks the document, not the selection: a selected frame,
    // and the first frame after one, rasterizes every tile.
    const selected = selectedSceneIndex !== null || selectedLayer !== null;
    if (selected || previous?.selected) {
      rasterOptions.dirtyTiles = null;
    }
    if (retainedCommands && rasterOptions.dirtyTiles === undefined) {
      rasterOptions.dirtyTiles = new Uint8Array(core.exports.frame_raster_tile_count(pxW, pxH));
    }
    // The raster tile map also repaints the engine's damage: its dirty map
    // of this target's grid (writeTileGrid), unless the caller's tiles are
    // authoritative, and its paint damage in every frame mode.
    if (rasterOptions.dirtyTiles) {
      const damageMeasurement = authoritativeDirtyTiles ? null : globalThis[domMeasurementKey];
      const damageStart = damageMeasurement ? hostNow() : 0;
      rasterOptions.dirtyTiles = rasterDirtyTiles(
        "frame_raster_tiles", rasterOptions.dirtyTiles, pxW, pxH,
        engineTileSize, authoritativeDirtyTiles ? 0 : 1, deviceScale,
        visibleRectangle?.x ?? 0, visibleRectangle?.y ?? 0,
      );
      if (damageMeasurement) {
        damageMeasurement.record({
          category: "damage",
          operation: "dirty-tiles.merge",
          direction: "engine-to-host",
          bytes: Math.ceil(pxW / engineTileSize) * Math.ceil(pxH / engineTileSize),
          allocations: 1,
          allocationBytes: rasterOptions.dirtyTiles.byteLength,
          milliseconds: hostNow() - damageStart,
        });
      }
    }
    // Geometry capture needs owned text runs on a full frame and on a
    // retained frame that spliced blocks in (its new text operations name
    // their runs). Certified paint-only replay keeps the immutable geometry
    // artifact, so neither text run copying nor command decoding repeats
    // during animation or scrolling.
    const splicedBlocks = retainedCommands && engine.exports.retained_command_changes_spliced() !== 0;
    const frameTextRuns = captureNodeMarkers &&
        (!reusedCommands || splicedBlocks)
      ? currentTextBatch.copyRuns()
      : [];
    // A preparation reads the laid-out engine rows here, before the raster
    // awaits (examples/animation-playground-sandom.js keeps its result).
    preparation.inspect?.();
    // The scan writes the index of each image size into the commands, so
    // the snapshot below copies them with those indices.
    const drawnResources = drawnImagesAndSlots(bytes);
    // FRAME SNAPSHOT — the frame owns its bytes. A synchronous layout
    // getter (getBoundingClientRect → layoutTreeBoxesSync →
    // emitSceneCommandsSync) can barge into the SHARED engine while this
    // render is parked at an await below; it re-emits the command,
    // glyph, gradient-stop, and scroll buffers for a DIFFERENT scene.
    // The promise chain (runExclusiveEngineOperation) cannot serialize a
    // synchronous caller, so live views over engine memory across awaits
    // are corrupted frames waiting to happen (found via react_select: the
    // paint decoder walked another emit's marker-free stream).
    // Copy everything the rest of this frame reads, before ANY await.
    // A retained frame whose edits moved commands copies the whole spliced
    // stream; one whose edits kept every offset patches the previous copy.
    const cmdView = reusedCommands && !commandsMoved
      ? previous.cmdView
      : new DataView(
        engine.memory.buffer.slice(commandBase, commandBase + bytes),
      );
    if (retainedCommands && !commandsMoved) {
      const commandBytes = new Uint8Array(
        cmdView.buffer,
        cmdView.byteOffset,
        cmdView.byteLength,
      );
      for (const range of ranges) {
        commandBytes.set(
          engine.bytes.subarray(
            commandBase + range.offset,
            commandBase + range.offset + range.byteLength,
          ),
          range.offset,
        );
      }
    }
    // The text geometry of the emission (geometry_text_capture), taken
    // before any await: another engine writer may emit after it. The
    // caller releases it (geometry_text_release).
    const textCapture = captureNodeMarkers && textCaptureRequested
      ? core.status("geometry_text_capture", bytes, currentTextBatch.resultsBase(),
        nodes[0]?._corePublication?.handle ?? 0)
      : 0;
    const scrollTable = retainedCommands
      ? previous.scrollTable
      : new Float32Array(
        engine.memory.buffer.slice(
          scrollTableBase,
          scrollTableBase + scrollTableSize,
        ),
      );
    // The gradient stop pool moves to a larger block when a frame's stops
    // need more (gradient_stop_pool_base), so its base and size are read
    // from the engine at each use.
    const gradientStopPoolBase = engine.exports.gradient_stop_pool_base();
    const gradientStopPool = new Uint8Array(
      engine.memory.buffer.slice(
        gradientStopPoolBase,
        gradientStopPoolBase + engine.exports.gradient_stop_pool_size(),
      ),
    );
    // The layout boxes too: a render orphaned by a rejected Promise.all
    // (the Chrome side of a two-backend comparison failing first) keeps
    // running and re-lays-out ITS scene into the computed-box buffer
    // while this frame rasterizes, so a box read after the raster await
    // returned another scene's rectangle at the same node index.
    // Boxes are CSS px natively (the engine lays out in CSS pixels).
    // Full records (content box, effective scroll offsets, scroll ranges,
    // sticky) so the render surface can treat these as the effective-state
    // source of truth.
    const retainedBoxes = retainedCommands &&
      layoutRevision === previous.layoutRevision;
    const boxes = retainedBoxes
      ? retainBoxSnapshot(previous.boxes)
      : readSceneBoxes({ nodes });
    sampledLayout?.(boxes);
    const frameScrollbarParts = typeof scrollbarParts === "function"
      ? scrollbarParts(boxes, engine.exports.layout_compute_total())
      : scrollbarParts;
    // Generate glyph atlases on the CPU for every raster backend. The WebGPU
    // atlas generator is not cross-browser safe: Chrome produced empty atlases,
    // Firefox produced partial atlases, and Safari produced complete atlases.
    await prepareColorGlyphBitmaps(drawnResources.slots, deviceScale);
    await selectSvgImageRasters(drawnResources.images, Math.max(1, deviceScale), svgImageTimings);
    let colorGlyphFrame = null;
    synchronizeImageRasterResources();
    let rasterPlan = null;
    let rasterPlanConfiguration = null;
    // The scrollbar rows this frame paints (RASTER_PLAN_SCROLLBAR_ROW_SIZE).
    let frameScrollbarRows = new Float32Array(0);
    const reusedTextResources = textPublication.glyphLease?.active === true;
    const textResources = reusedTextResources ? textPublication : {
      ...textPublication,
      glyphLease: await textPublication.glyphResourceManager.acquirePublication(
        textPublication.requestSnapshot, { generationBackend: textPublication.generationBackend, atlasRuntime },
      ),
    };
    if (!reusedTextResources) textResources.glyphPerformance = textResources.glyphLease.glyphPerformance;
    if (!reusedCommands) releaseRetainedPreparation(renderWriteOwner, textResources, nodes);
    const { glyphBuffer, glyphLease } = textResources;
    const glyphPerformance = reusedTextResources
      ? {
        ...textResources.glyphPerformance,
        requestedGlyphCount: 0,
        cacheHitGlyphCount: 0,
        generatedGlyphCount: 0,
        outputTexelCount: 0,
        generatedGlyphs: [],
        generationBackend: "cache-reuse",
        directAtlasPopulation: false,
        phaseMilliseconds: emptyGlyphPhaseMilliseconds(),
        totalMilliseconds: 0,
      }
      : {
        ...textResources.glyphPerformance,
        phaseMilliseconds: { ...textResources.glyphPerformance.phaseMilliseconds },
      };
    let svgPathAtlas;
    let paintArtifact = null;
    let rasterMilliseconds = 0;
    // This render's share of the work counters that every render of this
    // runtime adds to.
    let preparedWork = null;
    let result;
    let renderFailed = false;
    let renderFailure;
    try {
      colorGlyphFrame = colorGlyphCache.prepare(cmdView, bytes, deviceScale);
      const rasterStartedAt = hostNow();
      // The core decodes the frame's paint command stream into a retained
      // paint record (src/dom/paint-projection.js); the frame holds its
      // facade.
      paintArtifact = capturePaintArtifact
        ? capturePaintRecord(core, {
          commands: new Uint8Array(cmdView.buffer, cmdView.byteOffset, bytes),
          glyphs: glyphBuffer,
          nodes,
          textRuns: frameTextRuns,
          sceneChildren: scene.nodes.map((node) => node.children ?? []),
          width: scene.width,
          height: scene.height,
        })
        : null;
      if (paintArtifact !== null) commandDecodeWork.commands += paintArtifact.commandCount;
      const images = buildImageRenderResources();
      const atlasStartedAt = svgPathStageTimings && !reusedCommands
        ? hostNow()
        : 0;
      svgPathAtlas = reusedCommands
        ? previous.svgPathAtlas
        : await buildSvgPathRenderResources(textPublication.requestSnapshot);
      if (svgPathStageTimings && !reusedCommands) {
        svgPathStageTimings.atlasMilliseconds +=
          hostNow() - atlasStartedAt;
      }
      // Another emission between this frame's and now may have moved the
      // buffer (it only grows): the commands go back to its current base.
      const engineCommandBase = engine.exports.command_buffer_base();
      const engineBytes = new Uint8Array(engine.memory.buffer);
      engineBytes.set(
        new Uint8Array(cmdView.buffer, cmdView.byteOffset, cmdView.byteLength),
        engineCommandBase,
      );
      engineBytes.set(glyphBuffer, engine.exports.glyph_buffer_base());
      new Float32Array(
        engine.memory.buffer,
        scrollTableBase,
        scrollTable.length,
      ).set(scrollTable);
      engineBytes.set(gradientStopPool, engine.exports.gradient_stop_pool_base());
      // The scrollbar rows the plan expands the scrollbar markers from:
      // each painted part under its scroller's engine row, -1 for the
      // viewport's.
      const scrollbarFloats = RASTER_PLAN_SCROLLBAR_ROW_SIZE / 4;
      const scrollbarRows = new Float32Array(frameScrollbarParts.length * scrollbarFloats);
      let scrollbarRowCount = 0;
      for (const part of frameScrollbarParts) {
        const node = part.ownerIndex < 0
          ? -1
          : engineIndexOfSceneNode(nodes, part.ownerIndex);
        if (part.ownerIndex >= 0 && node < 0) continue;
        scrollbarRows.set([
          node,
          part.x,
          part.y,
          part.width,
          part.height,
          part.color.r,
          part.color.g,
          part.color.b,
          part.color.a,
          part.radius,
        ], scrollbarRowCount++ * scrollbarFloats);
      }
      frameScrollbarRows = scrollbarRows.subarray(0, scrollbarRowCount * scrollbarFloats);
      const previousScrollbarRows = previous?.scrollbarRows ?? frameScrollbarRows.subarray(0, 0);
      const previousScrollbarRowCount = previousScrollbarRows.length / scrollbarFloats;
      // The target (raster size, scale, mode, visible rectangle), then the
      // scrollbar rows.
      rasterPlanConfiguration = [
        pxW,
        pxH,
        deviceScale,
        renderContext.renderMode === "high-dynamic-range" ? 1 : 0,
        visibleRectangle?.x ?? 0,
        visibleRectangle?.y ?? 0,
        visibleRectangle?.width ?? scene.width,
        visibleRectangle?.height ?? scene.height,
        // A new color glyph cache layout moves entries the plan packed.
        colorGlyphFrame?.generation ?? 0,
      ];
      // frame_raster_plan_reuse compares the first targetConfigurationLength
      // values (the target) and the rest (the scrollbar rows) of two frames.
      const targetConfigurationLength = rasterPlanConfiguration.length;
      for (const value of frameScrollbarRows) rasterPlanConfiguration.push(value);
      // One allocation holds this frame's rows, the previous frame's, and
      // room for the damage between them.
      const scrollbarRowsBytes = scrollbarRowCount * RASTER_PLAN_SCROLLBAR_ROW_SIZE;
      const previousScrollbarRowsBytes = previousScrollbarRowCount *
        RASTER_PLAN_SCROLLBAR_ROW_SIZE;
      const scrollbarTableBytes = scrollbarRowsBytes + previousScrollbarRowsBytes +
        (scrollbarRowCount + previousScrollbarRowCount) * 16;
      const scrollbarTable = scrollbarTableBytes === 0
        ? 0
        : engine.exports.abi_malloc(scrollbarTableBytes);
      if (scrollbarTableBytes !== 0 && scrollbarTable === 0) {
        throw new Error(
          `raster scrollbar table allocation rejected ${scrollbarTableBytes} bytes`,
        );
      }
      if (scrollbarTable !== 0) {
        new Float32Array(
          engine.memory.buffer,
          scrollbarTable,
          frameScrollbarRows.length + previousScrollbarRows.length,
        ).set([...frameScrollbarRows, ...previousScrollbarRows]);
        // The scrollbars' damage: each part this frame or the previous one
        // paints that the other does not, in every frame mode.
        if (rasterOptions.dirtyTiles) {
          const damageTable = scrollbarTable + scrollbarRowsBytes +
            previousScrollbarRowsBytes;
          const damageCount = engine.exports.raster_scrollbar_damage(
            scrollbarTable + scrollbarRowsBytes,
            previousScrollbarRowCount,
            scrollbarTable,
            scrollbarRowCount,
            damageTable,
            // One device pixel, the antialiasing of a rounded part.
            1 / deviceScale,
          );
          if (damageCount > 0) {
            rasterOptions.dirtyTiles = rasterDirtyTiles(
              "frame_raster_tiles_mark", rasterOptions.dirtyTiles, pxW, pxH,
              damageTable, damageCount, deviceScale,
              visibleRectangle?.x ?? 0, visibleRectangle?.y ?? 0,
            );
          }
        }
      }
      try {
        glyphLease.bindRasterResources();
        bindPathRasterAtlas(svgPathAtlas);
        rasterPlan = (() => {
          const previousConfiguration = previous?.rasterPlanConfiguration;
          // frame_raster_plan_reuse compares the two configurations.
          const configurationBytes = (values) => new Uint8Array(Float64Array.from(values).buffer);
          const planReuse = previousConfiguration == null ? RASTER_PLAN_REUSE.NONE : core.status(
            "frame_raster_plan_reuse",
            ...core.byteInput(configurationBytes(previousConfiguration)),
            ...core.byteInput(configurationBytes(rasterPlanConfiguration)),
            targetConfigurationLength,
          );
          // Patches address byte ranges in the engine's emitted stream.
          const canPatch = !selected && retainedCommands && reusedCommands && previous.rasterPlan &&
            planReuse === RASTER_PLAN_REUSE.SAME;
          if (canPatch) {
            // Spliced blocks replan their new commands in place of their
            // old ones; opacity groups patched in place repack after that,
            // at their offsets in the new stream.
            const splicedRanges = ranges.filter((range) => range.kind === RETAINED_EDIT_SPLICE);
            const patchedRanges = ranges.filter((range) => range.kind === RETAINED_EDIT_PATCH);
            const spliceRecordsBefore = engine.exports
              .raster_plan_splice_records_written();
            if (
              (splicedRanges.length === 0 ||
                withRasterPlanRangeTable(splicedRanges, 5, (range) => [
                  range.oldOffset,
                  range.oldBytes,
                  range.offset,
                  range.byteLength,
                  range.scrollReference,
                ], (table) =>
                  engine.exports.raster_plan_splice(
                    previous.rasterPlan.plan,
                    table,
                    splicedRanges.length,
                    engineCommandBase,
                    bytes,
                    engine.exports.gradient_stop_pool_base(),
                    scrollTableBase,
                  ) === 1)) &&
              (patchedRanges.length === 0 ||
                withRasterPlanRangeTable(patchedRanges, 3, (range) => [
                  range.offset,
                  range.byteLength,
                  engineCommandBase + range.offset,
                ], (table) =>
                  engine.exports.raster_plan_patch(
                    previous.rasterPlan.plan,
                    table,
                    patchedRanges.length,
                  ) === 1))
            ) {
              rasterPlanRangesReplanned = ranges.length;
              rasterPlanCommandsReplanned = patchedRanges.length +
                engine.exports.raster_plan_splice_records_written() -
                spliceRecordsBefore;
              return {
                memory: engine.memory,
                plan: previous.rasterPlan.plan,
                exports: engine.exports,
              };
            }
          }
          // A replayed emission changed only the scroll table and the
          // scrollbar rows: the retained plan is written again in place,
          // from its own copy of the commands, for the same target.
          const canRescroll = !selected && replayedCommands && reusedCommands && previous.rasterPlan &&
            planReuse !== RASTER_PLAN_REUSE.NONE;
          if (
            canRescroll &&
            engine.exports.raster_plan_rescroll(
                previous.rasterPlan.plan,
                scrollTableBase,
                engine.exports.gradient_stop_pool_base(),
                scrollbarTable,
                scrollbarRowCount,
              ) === 1
          ) {
            rasterPlanRangesReplanned = 1;
            rasterPlanCommandsReplanned = rasterPlanRecordCount(
              previous.rasterPlan.plan,
            );
            return previous.rasterPlan;
          }
          let planCommandBase = engineCommandBase;
          let planBytes = bytes;
          if (selected) {
            let selectedEngineIndex = -1;
            if (selectedSceneIndex !== null) {
              selectedEngineIndex = engineIndexOfSceneNode(nodes, selectedSceneIndex);
              if (selectedEngineIndex < 0) {
                throw new RangeError(`Scene row ${selectedSceneIndex} has no engine node: it is not laid out.`);
              }
            }
            planBytes = engine.exports.raster_commands_select(
              engineCommandBase,
              bytes,
              nodes.length,
              selectedEngineIndex,
              selectedLayer ?? -1,
            );
            if (planBytes < 0) {
              const value = engine.exports.raster_commands_select_failure_value();
              throw new Error([
                null,
                `raster_commands_select cannot size the command at byte ${value} of ${bytes}`,
                `raster_commands_select found engine node ${value} with its children before it`,
                `raster_commands_select cannot allocate ${value} bytes`,
                `raster_commands_select received root ${value} outside ${nodes.length} engine nodes`,
                `raster_commands_select found ${value} groups open at the end of the stream`,
                `raster_commands_select found a pop at byte ${value} that closes no open clip or group`,
                `Layer ${selectedLayer} is outside the frame's ${value} paint groups.`,
              ][engine.exports.raster_commands_select_failure()]);
            }
            planCommandBase = engine.exports.raster_commands_selected_base();
          }
          const plan = engine.exports.raster_plan_prepare(
            planCommandBase,
            planBytes,
            commandRevision,
            pxW,
            pxH,
            deviceScale,
            renderContext.renderMode === "high-dynamic-range" ? 1 : 0,
            scrollTableBase,
            engine.exports.gradient_stop_pool_base(),
            visibleRectangle?.x ?? 0,
            visibleRectangle?.y ?? 0,
            visibleRectangle?.width ?? scene.width,
            visibleRectangle?.height ?? scene.height,
            scrollbarTable,
            scrollbarRowCount,
          );
          if (plan === 0) {
            throw new Error(
              `raster_plan_prepare rejected ${bytes} command bytes at revision ${commandRevision}`,
            );
          }
          rasterPlanRangesReplanned = 1;
          rasterPlanCommandsReplanned = rasterPlanRecordCount(plan);
          if (reusedCommands && previous.rasterPlan) {
            releaseRasterPlan(previous.rasterPlan);
            // The previous preparation owns the new plan until this frame's
            // preparation replaces it, so a failure below releases it once.
            previous.rasterPlan = {
              memory: engine.memory,
              plan,
              exports: engine.exports,
            };
            return previous.rasterPlan;
          }
          return { memory: engine.memory, plan, exports: engine.exports };
        })();
      } finally {
        if (scrollbarTable !== 0) engine.exports.abi_free(scrollbarTable);
      }
      // Scroll offsets come from the frame snapshot above. Gradient bytes are
      // already owned by the retained raster plan. The work counters are
      // read before the raster await: another render can prepare during it
      // (rasterizeSvgImage).
      preparedWork = {
        commandsDecoded: commandDecodeWork.commands - commandDecodeBefore,
        textBatchesPrepared: textPreparationWork.batches -
          textPreparationBefore.batches,
        textRowsPrepared: textPreparationWork.rows - textPreparationBefore.rows,
        textRunsKept: textPreparationWork.runsKept -
          textPreparationBefore.runsKept,
        textRunsRebuilt: textPreparationWork.runsRebuilt -
          textPreparationBefore.runsRebuilt,
      };
      result = renderContext
        ? await render(renderContext, {
          background: RENDER_BG,
          glyphBuffer,
          images: colorGlyphFrame === null
            ? images
            : await colorGlyphCache.imagesFor(colorGlyphFrame, renderContext, images),
          scrollTable,
          deviceScale,
          visibleRectangle,
          rasterPlan,
          glyphPerformance,
          ...rasterOptions,
        })
        : await withRenderContext(
          pxW,
          pxH,
          async (context) =>
            render(context, {
              background: RENDER_BG,
              glyphBuffer,
              images: colorGlyphFrame === null
                ? images
                : await colorGlyphCache.imagesFor(colorGlyphFrame, context, images),
              scrollTable,
              deviceScale,
              visibleRectangle,
              rasterPlan,
              glyphPerformance,
              ...rasterOptions,
            }),
          graphicsBackend,
        );
      rasterMilliseconds = hostNow() - rasterStartedAt;
    } catch (error) {
      renderFailed = true;
      renderFailure = error;
    }
    // The release below runs after a failed render too. A failure of the
    // preparation's cleanup has precedence over the render's failure.
    await colorGlyphCache.releaseFrame(colorGlyphFrame);
    if (
      rasterPlan !== null &&
      !reusedCommands &&
      (!result || renderWriteOwner === null)
    ) {
      releaseRasterPlan(rasterPlan);
    }
    if (!reusedCommands && (!result || renderWriteOwner === null)) {
      glyphLease.release();
    }
    if (!result) releaseBoxSnapshot(boxes);
    try {
      preparation.cleanup?.();
    } catch (error) {
      if (!reusedCommands && result && renderWriteOwner !== null) {
        glyphLease.release();
      }
      if (result) releaseBoxSnapshot(boxes);
      throw error;
    }
    if (renderFailed) throw renderFailure;
    if (renderWriteOwner !== null) {
      // Keep the independently copied request atlases, not source-revision
      // pins: another surface must be able to acquire newly needed glyphs
      // while this surface is idle with a retained command snapshot.
      glyphLease.releaseSourcePins();
      if (reusedCommands && !retainedBoxes) {
        releaseBoxSnapshot(previous.boxes);
      }
      retainedPreparations.set(renderWriteOwner, {
        valid: writeClaim === engineWriteClaims.get(engine.memory) &&
          engineWriteOwner === renderWriteOwner &&
          coreWriteRevision === core.engineFrameRevision &&
          preparedResourceRevision ===
            core.status("resource_revision") &&
          preparedFontRevision === fontRegistry.revision,
        nodes: retainedCommands ? nodes : nodes.slice(),
        boxes: retainedBoxes ? boxes : retainBoxSnapshot(boxes),
        textResources,
        svgPathAtlas,
        svgPathAtlasRevision: svgPathAtlas?.revision ?? 0,
        cmdView,
        scrollTable,
        captureNodeMarkers,
        page,
        rasterPlan,
        rasterPlanConfiguration,
        selected,
        scrollbarRows: frameScrollbarRows,
        commandRevision,
        layoutRevision,
        rasterResourceRevision,
        resourceRevision: preparedResourceRevision,
        fontRevision: preparedFontRevision,
        resolveResource,
        deviceScale,
        glyphResourceManager,
        coreWriteRevision,
        width: scene.width,
        height: scene.height,
        writeClaim,
        publicationRevision: scene.publicationRevision,
        imageSourceRevisions: canvasSourceRevisions(scene.imageSources),
        globalPreparation,
      });
    }
    // Copy the readback so the context-owned ring/persistent buffer can be
    // reused by the next frame while the caller holds this one.
    const pixels = result.pixels ? result.pixels.slice() : null;
    // The shared manager retains the unpinned revision for other rendering APIs.
    // The pixel buffer is at physical resolution; boxes were read before
    // the raster await above.
    const phaseMilliseconds = Object.freeze({
      ...glyphPerformance.phaseMilliseconds,
    });
    const glyphPerformanceRecord = Object.freeze({
      requestRevision: textResources.requestRevision,
      requestRowCount: textResources.requestRowCount,
      requestedGlyphCount: glyphPerformance.requestedGlyphCount,
      cacheHitGlyphCount: glyphPerformance.cacheHitGlyphCount,
      generatedGlyphCount: glyphPerformance.generatedGlyphCount,
      outputTexelCount: glyphPerformance.outputTexelCount,
      generatedGlyphs: Object.freeze(
        glyphPerformance.generatedGlyphs.map((glyph) => Object.freeze(glyph)),
      ),
      generationBackend: glyphPerformance.generationBackend,
      directAtlasPopulation: glyphPerformance.directAtlasPopulation,
      phaseMilliseconds,
      totalMilliseconds: Object.values(phaseMilliseconds).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      ),
    });
    const performanceRecord = Object.freeze({
      glyphs: glyphPerformanceRecord,
      preparation: Object.freeze({
        visitedNodeCount,
        decodedBoxCount: retainedBoxes ? 0 : nodes.length,
        retained: retainedCommands,
        // The emission replayed the previous commands; the frame kept their
        // text resources, path atlas and text geometry.
        replayed: replayedCommands,
        writtenRowCount,
        // The frame published only its changed rows, into the previous
        // frame's rows: no row was inserted or removed and no changed row's
        // children changed (sparse or patched, above).
        rowsPatched,
        nodesLaidOut,
        paintWalked,
        commandBytesEmitted: paintWalked ? bytes : 0,
        retainedCommandPatches,
        // Command blocks the retained transaction emitted again and spliced
        // in, and the commands in their new emission.
        commandBlocksEmitted,
        blockCommandsEmitted,
        // Commands the host decoded: the paint artifact, the text geometry,
        // the glyph and path resource scans and the highlighted stream.
        commandsDecoded: preparedWork.commandsDecoded,
        // Command ranges the raster plan planned again (a preparation or a
        // rescroll plans the whole stream as one range), and the commands
        // in them.
        rasterPlanRangesReplanned,
        rasterPlanCommandsReplanned,
        // Text batches this render prepared and the rows they prepared, and
        // the republished rows whose run it kept or rebuilt.
        textBatchesPrepared: preparedWork.textBatchesPrepared,
        textRowsPrepared: preparedWork.textRowsPrepared,
        textRunsKept: preparedWork.textRunsKept,
        textRunsRebuilt: preparedWork.textRunsRebuilt,
        // Device pixels the raster painted: its dirty tiles, or the target.
        rasterDamagePixels: (result.dirtyRects ?? [{ w: pxW, h: pxH }])
          .reduce(
            (total, rectangle) =>
              total + (rectangle.w ?? rectangle.width) *
                  (rectangle.h ?? rectangle.height),
            0,
          ),
      }),
      rasterPreparation: result.rasterPreparation,
      rasterMilliseconds,
      wallMilliseconds: hostNow() - renderWallStartedAt,
    });
    if (onPerformance !== null) onPerformance(performanceRecord);
    // The result IS the working ImageDescriptor (rgba in the mode's working
    // encoding, premultiplied; float32 samples, or uint8 for an "rgba8"
    // readback - see rasterize.js's workingRenderResult) plus boxes,
    // performance, and dirty tracking. readback: "none" returns the direct
    // textureImage instead.
    return {
      ...(pixels
        ? {
          pixels,
          rowStride: result.rowStride,
          channelLayout: result.channelLayout,
          sampleType: result.sampleType,
          bitsPerSample: result.bitsPerSample,
          colorEncoding: result.colorEncoding,
          alphaMode: result.alphaMode,
          metadata: result.metadata,
        }
        : {
          device: result.device,
          textureImage: result.textureImage,
        }),
      graphicsBackend: renderContext.kind,
      graphicsBackendInfo: renderContext.backendInfo,
      boxes,
      ...(page !== null
        ? {
          // The page shown: its index, name, side, blankness and page box,
          // the page count, every page's description in order, the nodes on
          // other pages, and each scene node's fragments.
          page: {
            height: page.height,
            rulesKey: page.rulesKey ?? "",
            ...pagedLayoutRecord.pages[pageIndex],
            count: pageCount,
            pages: pagedLayoutRecord.pages,
            offPageNodes,
            nodeFragments: pagedLayoutRecord.nodeFragments,
          },
        }
        : {}),
      ...(paintArtifact ? { paintArtifact } : {}),
      ...(textCapture !== 0 ? { textCapture } : {}),
      performance: performanceRecord,
      width: pxW,
      height: pxH,
      deviceScale,
      dirtyRects: result.dirtyRects,
      pixelRegions: result.pixelRegions ?? [],
      readbackByteLength: result.readbackByteLength,
    };
  }

  async function createPersistentSceneRenderer(options) {
    const {
      graphicsDevice: selectedGraphicsDevice = graphicsDevice,
      ...rendererOptions
    } = options;
    const isolatedCore = new DomCore();
    const isolatedFonts = createFontRegistry({
      core: isolatedCore,
      sourceRegistry: fontRegistry,
    });
    let isolatedRuntime;
    try {
      isolatedRuntime = await createSceneRendererRuntime({
        core: isolatedCore,
        harfbuzzBytes,
        msdfgenBytes,
        fontRegistry: isolatedFonts,
        codecRuntime,
        graphicsDevice: selectedGraphicsDevice,
      });
      const renderer = await isolatedRuntime.createSceneRenderer(
        rendererOptions,
      );
      return Object.freeze({
        ...renderer,
        async shutdown() {
          try {
            await renderer.shutdown();
            await isolatedRuntime.releaseRenderContexts();
          } finally {
            isolatedFonts.dispose();
          }
        },
      });
    } catch (error) {
      try {
        await isolatedRuntime?.releaseRenderContexts();
      } finally {
        isolatedFonts.dispose();
      }
      throw error;
    }
  }

  function sceneNodeSignature(node) {
    // Plain JSON: a node carries no BigInt (a native SVG request's uint64
    // identity is serialized as its decimal string), and a replacer call
    // per key was a measurable share of the frame.
    return JSON.stringify(node);
  }

  // A persistent scene renderer whose graphics context is ready; one whose
  // context fails to start shuts down and rethrows.
  async function createSceneRenderer(options) {
    const renderer = openSceneRenderer(options);
    try {
      await renderer.ready;
    } catch (error) {
      await renderer.shutdown();
      throw error;
    }
    return renderer;
  }

  // A persistent scene renderer at once: its engine side (the animation
  // controller, its engine write token, track declarations and samples)
  // works immediately, and `ready` settles when its graphics context
  // exists, rejecting with the context's creation error. Rendering, resizing
  // and shutdown wait for the context.
  function openSceneRenderer({
    width,
    height,
    deviceScale = 1,
    graphicsBackend = "auto",
    graphicsDevice: selectedGraphicsDevice = graphicsDevice,
    renderMode = undefined,
    renderPrecision = undefined,
    glyphResourceManager = getDefaultGlyphResourceManager(),
    layoutNodeCapacity = Infinity,
  }) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    if (
      selectedGraphicsDevice !== null &&
      (typeof selectedGraphicsDevice?.createBuffer !== "function" ||
        typeof selectedGraphicsDevice?.queue?.submit !== "function")
    ) {
      throw new TypeError("graphicsDevice must be a GPUDevice");
    }
    const rendererGraphicsStateOwner = selectedGraphicsDevice === graphicsDevice
      ? graphicsStateOwner
      : { webgpuDevice: selectedGraphicsDevice };
    // Visible-region rasterization: the CSS-px rectangle of the scene
    // the raster target covers; null covers the full scene. Owned here
    // because the render context's physical size follows it.
    let visibleRectangle = null;
    let physicalWidth = width * deviceScale;
    let physicalHeight = height * deviceScale;
    // The render context's physical size. A size or region change rebuilds
    // the context only when that size changes: a region that moves at one
    // size keeps its context (and the context allocates its target at its
    // first frame, so a size replaced before a frame costs nothing).
    const targetWidth = () => (visibleRectangle?.width ?? width) * deviceScale;
    const targetHeight = () => (visibleRectangle?.height ?? height) * deviceScale;
    async function rebuildContext() {
      physicalWidth = targetWidth();
      physicalHeight = targetHeight();
      context = await createRenderContext({
        width: physicalWidth,
        height: physicalHeight,
        graphicsBackend,
        sharedStateOwner: rendererGraphicsStateOwner,
        ...(renderMode !== undefined ? { renderMode } : {}),
        ...(renderPrecision !== undefined ? { renderPrecision } : {}),
      });
      if (frameComparison !== null) attachFrameComparison(context);
    }
    // An attached frame comparison session (src/gpu-frame-comparison.js):
    // each render context gets its own owner, so a context rebuild starts
    // a new comparison epoch.
    let frameComparison = null;
    function attachFrameComparison(target) {
      if (target.kind === "webgpu") target.attachComparison(frameComparison);
      else frameComparison.rejectBackend(target.kind);
    }
    let context = null;
    const ready = rebuildContext();
    let shutDown = false;
    let previousNodeSignatures = null;
    let previousStyleGeneration = 0;
    let previousSceneNodes = null;
    let previousPublicationRevision;
    let previousBoxes = null;
    let automaticTransitionsActive = false;
    const animationEventListeners = new Set();
    const animations = createAnimationController(engine, {
      onEvent(event) {
        for (const listener of animationEventListeners) listener(event);
      },
      // The engine write token is this controller, so the buffer holds
      // this renderer's rows while it is the engine write owner.
      ownsLayoutRows: () => engineWriteOwner === animations,
    });
    // The transitions a style change starts on one node: its node of the
    // last rendered scene, with that scene's box, against its node of the
    // next scene. Null when the node declares no transitions or was not a
    // DOM-backed box (it has no before-change style).
    function planNodeTransitions(previousNode, nextNode, box) {
      if (!previousNode || !nextNode?.transitionDefinitions?.length) return null;
      // A DOM-backed box's values live in its immutable native record.
      // Both endpoints come from record bytes, never from the engine
      // buffer: it is shared, and a synchronous layout getter since the
      // preceding frame has rewritten it with the after-change scene. A
      // serialization taken while the element declared transitions
      // carries its record copy; one taken before (the transition
      // declared with the change) is read from its publication, live
      // until the next frame supersedes it.
      if (previousNode._coreRecord === undefined && !usesCoreRecord(previousNode)) return null;
      const previousRecord = previousNode._coreRecord ??
        previousNode._corePublication.core.engineRecordCopy(
          previousNode._corePublication.boxes[previousNode._corePublicationIndex].stableId,
          previousNode._corePublication.boxes[previousNode._corePublicationIndex].sourceRevision,
        );
      // The record folds the transform list into one affine, which CSS
      // cannot interpolate component-wise, so the CSS form the
      // serializations captured (serialize.js) comes along.
      // Both records leave out the effects of the running transitions that
      // computed resolution applies (engine_record_after_change): the
      // planner compares the styles that the transitions run between.
      return animations.planTransitions({
        previousRecord,
        nextRecord: nextNode._coreRecord,
        box,
        previousTransform: previousNode.transform,
        nextTransform: nextNode.transform,
        definitions: nextNode.transitionDefinitions,
        pseudoElement: nextNode.pseudoElement ?? "",
      });
    }
    async function renderFrame(scene, renderOptions, readback) {
      await ready;
      // Serialize renders across every renderer sharing this runtime's
      // engine (see engineRenderChain above).
      return await runExclusiveEngineOperation(() =>
        renderFrameNow(scene, renderOptions, readback)
      );
    }
    async function renderFrameNow(scene, renderOptions, readback) {
      if (shutDown) throw new Error("persistent scene renderer is shut down");
      if (scene.width !== width || scene.height !== height) {
        throw new RangeError(
          `persistent scene renderer expected ${width}x${height}, got ${scene.width}x${scene.height}`,
        );
      }
      // The transitions below are declared before this frame writes its
      // rows, at this scene's node indices, and a declaration reads its
      // node's row. The node tables must hold the scene first. A scene over
      // the renderer's own cap fails at the row write.
      if (scene.nodes.length <= layoutNodeCapacity) {
        ensureNodeCapacity(scene.nodes.length);
      }
      // A caller that KNOWS which nodes changed (the render surface's
      // scroll-only frames declare the scrolled node indices) skips the
      // change detection; only the declared nodes' signatures refresh so
      // the next undeclared frame diffs correctly. Scroll offsets never
      // change ancestor layout, so ancestor refresh is skipped too.
      //
      // A DOM-backed scene carries its publication's changed row list: a
      // row absent from it has an engine record byte-identical to the
      // previous publication's at the same index, and every host-side
      // input (resources, scroll requests, text, structure) reaches the
      // renderer through the mutation set or the record. That list is the
      // change set; no JSON signature is built. A hand-authored scene keeps
      // the signature diff.
      const declared = renderOptions.declaredChangedNodeIndices ?? null;
      const lowered = scene.changedRows == null
        ? null
        : scene.publicationRevision !== undefined &&
            scene.publicationRevision === previousPublicationRevision
        ? []
        : scene.changedRows;
      const havePrevious = lowered !== null
        ? previousSceneNodes !== null
        : previousNodeSignatures !== null;
      let changedNodeIndices;
      if (declared !== null && havePrevious) {
        changedNodeIndices = new Set(declared);
        if (lowered === null) {
          for (const index of declared) {
            previousNodeSignatures[index] = sceneNodeSignature(
              scene.nodes[index],
            );
          }
        }
      } else {
        if (lowered !== null) {
          changedNodeIndices = havePrevious ? new Set(lowered) : null;
        } else {
          const nextNodeSignatures = scene.nodes.map(sceneNodeSignature);
          changedNodeIndices = havePrevious
            ? new Set(
              nextNodeSignatures.flatMap((signature, index) =>
                signature === previousNodeSignatures[index] ? [] : [index]
              ),
            )
            : null;
          previousNodeSignatures = nextNodeSignatures;
          // A DOM-backed box's style lives in the core, outside its
          // signature: a style generation change refreshes every core-written
          // node (write-if-changed keeps the unchanged ones' generations). A
          // caller that passes only the serialized nodes gets the generation
          // they were serialized at.
          const styleGeneration = scene.styleGeneration ??
            sceneStyleGeneration(scene.nodes) ?? 0;
          if (
            changedNodeIndices !== null &&
            styleGeneration !== previousStyleGeneration
          ) {
            for (let index = 0; index < scene.nodes.length; index++) {
              if (usesCoreRecord(scene.nodes[index])) {
                changedNodeIndices.add(index);
              }
            }
          }
          previousStyleGeneration = styleGeneration;
        }
      }
      const mutationNodeIndices = renderOptions.mutationNodeIndices ?? null;
      if (changedNodeIndices !== null && mutationNodeIndices?.size) {
        for (const mutationNodeIndex of mutationNodeIndices) {
          if (mutationNodeIndex >= scene.nodes.length) {
            throw new RangeError(
              `Mutation node index ${mutationNodeIndex} is outside a scene of ${scene.nodes.length} nodes`,
            );
          }
          changedNodeIndices.add(mutationNodeIndex);
        }
      }
      // A style change that a synchronous style or layout read resolved
      // (render-surface.js, _takeSyncLayout) happened at that read's time:
      // the running transitions it interrupts are sampled there. A
      // transition that the change starts is pending until this frame, and
      // this frame's time is its start time, as in Chrome (Web Animations 1,
      // section 4.4.4). Without such a read, the render that first resolves
      // the change is both times; the previous presented frame may be
      // arbitrarily old.
      const renderTime = renderOptions.timeMilliseconds ?? hostNow();
      const transitionChangeTime =
        renderOptions.transitionChangeTimeMilliseconds ?? renderTime;
      // The transitions this style change starts, collected before any is
      // declared: the running ones they interrupt are brought to the
      // change's time first (below). The engine decides them from the
      // node's records (planNodeTransitions).
      const declarations = [];
      if (previousSceneNodes !== null && changedNodeIndices?.size) {
        for (const nodeIndex of changedNodeIndices) {
          // A node the last scene did not hold plans from the style a read
          // kept of it (render-surface.js, _planPendingTransitions).
          const plan = planNodeTransitions(
            previousSceneNodes[nodeIndex] ?? renderOptions.readBaseline?.(nodeIndex) ?? undefined,
            scene.nodes[nodeIndex],
            previousBoxes[nodeIndex],
          );
          if (plan === null) continue;
          for (const propertyName of plan.unanimated) {
            renderOptions.onTransitionPropertyUnanimated?.({ nodeIndex, propertyName });
          }
          for (const transition of plan.transitions) {
            // A transition that a script already holds (a pending
            // CSSTransition, which a read between frames created) runs on
            // that object's identity and timing.
            const held = renderOptions.heldTransition?.(nodeIndex, transition.propertyName) ?? null;
            declarations.push({
              nodeIndex,
              planned: transition,
              timing: {
                duration: transition.definition.duration,
                delay: transition.definition.delay,
                easing: transition.definition.easing,
                startTime: renderTime,
                startValue: transition.startValue,
                ...held?.timing,
              },
              declarationOptions: held === null ? {} : {
                animationId: held.animationId,
                trackGeneration: held.trackGeneration,
              },
            });
          }
        }
      }
      // css-transitions-1 §3: a style change sees the running transitions
      // at its own time. Before a declaration interrupts one, the tracks
      // advance to that time: one whose end it reaches completes with
      // transitionend and the new transition starts from its end value with
      // its full duration; a running one is interrupted, or reversed with
      // its shortening factor, at its value at that time.
      if (
        declarations.some(({ nodeIndex, planned }) =>
          animations.hasEffect(nodeIndex, planned.propertyName)
        )
      ) {
        animations.advance(transitionChangeTime);
      }
      // Each transition reaches the caller's onTransitionStarted as it is
      // declared: after the cancel of the transition it replaces, which the
      // declaration reports, and before its own events, which this frame's
      // tick reports (a reversal of a transition that has not progressed
      // has no duration left, and starts and ends in that tick).
      for (const { nodeIndex, planned, timing, declarationOptions } of declarations) {
        const transition = animations.startPlannedTransition(nodeIndex, planned, timing, {
          ...declarationOptions,
          changeTime: transitionChangeTime,
        });
        renderOptions.onTransitionStarted?.({
          nodeIndex,
          propertyName: planned.propertyName,
          ...timing,
          duration: transition.duration,
          endValue: planned.endValue,
          trackStartValue: transition.start,
          animationId: transition.animationId,
          engineHandle: transition,
        });
      }
      let animationTickResult = null;
      let animationTickMilliseconds = null;
      const callerPrepareEngine = renderOptions.prepareEngine;
      const result = await renderScenePixels(scene, deviceScale, {
        ...renderOptions,
        readback,
        changedNodeIndices,
        engineWriteOwner: animations,
        retainedPreparationAllowed: callerPrepareEngine === undefined,
        glyphResourceManager,
        layoutNodeCapacity,
        prepareEngine(state) {
          animations.bindComputedSamples(renderOptions.computedSamples ?? null);
          // The tick and the layout that follow read the shared animation
          // table. This frame's awaits let a sibling renderer declare or
          // control its tracks and take the table, so the frame takes it
          // back in the synchronous turn that ticks and lays out. The rows
          // of this frame fill the buffer now, so the bases of tracks
          // declared over another scene's rows are read from them. A caller
          // preparation that declares tracks through its own controller
          // takes the table after this, for the layout of this frame.
          animations.prepareLayout();
          const preparation = callerPrepareEngine?.(state) ?? {};
          if (
            renderOptions.timeMilliseconds !== undefined ||
            automaticTransitionsActive ||
            declarations.length > 0
          ) {
            animationTickMilliseconds = renderTime;
            animationTickResult = animations.tick(animationTickMilliseconds);
          }
          return preparation;
        },
        sampledLayout(boxes) {
          animations.captureComputedSamples();
          animations.captureComputedPseudos(scene.nodes, boxes, scene.generatedBoxRows);
          animations.captureComputedGeometry(boxes);
          // The rows are this frame's, laid out: an interrupting transition
          // reads its start from these values after another renderer's
          // rows fill the buffer.
          animations.captureLiveValues();
        },
        renderContext: context,
        visibleRectangle,
      });
      previousSceneNodes = scene.nodes;
      previousPublicationRevision = scene.publicationRevision;
      previousBoxes = result.boxes;
      automaticTransitionsActive =
        (animationTickResult?.liveTrackCount ?? 0) > 0;
      return {
        ...result,
        animationActive: automaticTransitionsActive,
        // The time this frame ticked the engine's tracks at, or null: every
        // track whose end that time reached has ended and reported it.
        animationTickMilliseconds,
      };
    }

    return Object.freeze({
      ready,
      async resize(nextWidth, nextHeight, nextDeviceScale = deviceScale) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (
          width === nextWidth && height === nextHeight &&
          deviceScale === nextDeviceScale
        ) return;
        if (!(nextWidth > 0) || !(nextHeight > 0) || !(nextDeviceScale > 0)) {
          throw new RangeError(
            "persistent scene renderer dimensions and device scale must be positive",
          );
        }
        const densityOnlyResize = width === nextWidth &&
          height === nextHeight;
        await ready;
        width = nextWidth;
        height = nextHeight;
        deviceScale = nextDeviceScale;
        if (targetWidth() !== physicalWidth || targetHeight() !== physicalHeight) {
          await context.destroy();
          await rebuildContext();
        }
        // A density-only resize is raster-only: layout, the scene cache,
        // and the node signatures stay valid because the engine lays out
        // in CSS pixels and deviceScale never reaches it. Only a logical
        // size change invalidates them.
        if (!densityOnlyResize) {
          previousNodeSignatures = null;
          previousSceneNodes = null;
          previousBoxes = null;
          automaticTransitionsActive = false;
        }
      },
      /** Selects the CSS-px rectangle of the scene the raster target
       * covers, or the full scene with null. Raster-only: layout, the
       * scene cache, and the node signatures stay valid; only a new size
       * replaces the render context and its raster target. */
      async setVisibleRectangle(rectangle) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (rectangle !== null) {
          const { x, y, width: w, height: h } = rectangle;
          if (
            !(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)
          ) {
            throw new RangeError(
              "visibleRectangle requires finite x/y and positive width/height",
            );
          }
        }
        const previous = visibleRectangle;
        if (
          previous === rectangle ||
          (previous !== null && rectangle !== null &&
            previous.x === rectangle.x && previous.y === rectangle.y &&
            previous.width === rectangle.width &&
            previous.height === rectangle.height)
        ) return;
        visibleRectangle = rectangle === null ? null : {
          x: Number(rectangle.x),
          y: Number(rectangle.y),
          width: Number(rectangle.width),
          height: Number(rectangle.height),
        };
        await ready;
        if (targetWidth() !== physicalWidth || targetHeight() !== physicalHeight) {
          await context.destroy();
          await rebuildContext();
        }
      },
      // The resolved raster backend ("webgpu" | "webgl2"), null until the
      // context is ready. Presentation consumers branch on this: only the
      // webgpu backend can return a GPU texture image; the webgl2 backend
      // always reads back pixels.
      get graphicsBackend() {
        return context?.kind ?? null;
      },
      // Attaches a frame comparison session; the next frame of the context
      // creates its owner.
      async attachFrameComparison(session) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (frameComparison !== null) throw new Error("a frame comparison is already attached; detach it first");
        // Set before the wait: a frame requested after this call finds it.
        frameComparison = session;
        await ready;
        if (frameComparison === session) attachFrameComparison(context);
      },
      // Detaches the session and releases the context's owner.
      async detachFrameComparison() {
        await ready;
        frameComparison = null;
        if (context.kind === "webgpu") await context.detachComparison();
      },
      // The GPUDevice the webgpu backend renders on; null for webgl2 and
      // until the context is ready.
      get graphicsDevice() {
        return context?.kind === "webgpu" ? context.device : null;
      },
      // The token this renderer claims the engine's layout buffer with.
      // A synchronous layout getter over the tree this renderer renders
      // passes it to layoutTreeBoxesSync, which then inherits the
      // retained layout instead of relaying out the whole page, and hands
      // the claim back so the next frame keeps its incremental node set.
      get engineWriteToken() {
        return animations;
      },
      // `renderOptions.readback` selects "float32" (the default) or, for the
      // rgba8unorm render precision, "rgba8" samples.
      render(scene, renderOptions = {}) {
        const readback = renderOptions.readback ?? "float32";
        if (readback !== "float32" && readback !== "rgba8") {
          throw new Error(`render: readback must be "float32" or "rgba8", got ${JSON.stringify(readback)}; renderTexture delivers a texture`);
        }
        return renderFrame(scene, renderOptions, readback);
      },
      renderTexture(scene, renderOptions = {}) {
        return renderFrame(scene, renderOptions, "none");
      },
      createDisplayListArtifact(scene, options) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return createDisplayListArtifact(scene, options);
      },
      engineCounters,
      // The generation of the row's last change: its layout generation, or
      // its paint-only generation when that is newer (a paint-only change
      // leaves the layout generation as it was).
      nodeGeneration(index) {
        if (!Number.isInteger(index) || index < 0) {
          throw new RangeError(
            `nodeGeneration index must be a non-negative integer, got ${index}`,
          );
        }
        const record = layoutBufferBase + index * LAYOUT_NODE_SIZE;
        return Math.max(
          view.getUint32(record + LAYOUT_NODE_OFFSET_CHANGED_GEN, true),
          view.getUint32(record + LAYOUT_NODE_OFFSET_PAINT_GEN, true),
        );
      },
      animate(nodeIndex, keyframes, timing, declarationOptions = {}) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.animate(
          nodeIndex,
          keyframes,
          timing,
          declarationOptions,
        );
      },
      transition(nodeIndex, propertyName, target, timing) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.transition(nodeIndex, propertyName, target, timing);
      },
      // The value of a track's property at `time`, composed through that
      // track of its effect stack (commitStyles()).
      sampleAnimationThrough(trackIndex, timeMilliseconds) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.sampleThrough(trackIndex, timeMilliseconds);
      },
      // The transitions that the style change since the last frame starts
      // on one node of a scene a read between frames serialized:
      // `previousIndex` is the node's index in the last rendered scene. It
      // only plans; the next frame plans the same change and declares it.
      planStyleChangeTransitions(previousIndex, nextNode) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (previousSceneNodes === null) return [];
        return planNodeTransitions(
          previousSceneNodes[previousIndex],
          nextNode,
          previousBoxes[previousIndex],
        )?.transitions ?? [];
      },
      // The transitions from a before-change style that a read kept of a
      // node the last rendered scene did not hold.
      planTransitionsFrom(previousNode, nextNode) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return planNodeTransitions(previousNode, nextNode, undefined)?.transitions ?? [];
      },
      declareTransitionTrack(nodeIndex, propertyName, keyframes, timing, declarationOptions = {}) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.declareTransitionTrack(
          nodeIndex,
          propertyName,
          keyframes,
          timing,
          declarationOptions,
        );
      },
      tick(timeMilliseconds) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.tick(timeMilliseconds);
      },
      remapAnimations(indexMap) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        if (previousSceneNodes !== null) {
          const remappedPreviousSceneNodes = [];
          for (const [previousIndex, nextIndex] of indexMap) {
            remappedPreviousSceneNodes[nextIndex] =
              previousSceneNodes[previousIndex];
          }
          previousSceneNodes = remappedPreviousSceneNodes;
          if (previousBoxes !== null) {
            const remappedPreviousBoxes = [];
            for (const [previousIndex, nextIndex] of indexMap) {
              remappedPreviousBoxes[nextIndex] = previousBoxes[previousIndex];
            }
            previousBoxes = remappedPreviousBoxes;
          }
        }
        return animations.remapNodes(indexMap);
      },
      onAnimationEvent(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("animation event listener must be a function");
        }
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        animationEventListeners.add(listener);
        return () => animationEventListeners.delete(listener);
      },
      replaceAnimationBase(nodeIndex, propertyName, target) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return animations.replaceBase(nodeIndex, propertyName, target);
      },
      async shutdown() {
        if (shutDown) return;
        shutDown = true;
        // Release every engine animation track this renderer still owns;
        // on a shared engine the table outlives the renderer. A controller
        // without tracks releases the shared table too.
        animations.cancelAll();
        animations.bindComputedSamples(null);
        // The engine outlives this renderer: the controller's growth
        // listener would otherwise keep the renderer, its last scene and
        // that scene's documents alive, and the DOM core's collection walks
        // every node of every document it keeps.
        animations.dispose();
        if (engineWriteOwner === animations) engineWriteOwner = null;
        if (retainedRowsOwner === animations) retainedRowsOwner = null;
        releaseRetainedPreparation(animations);
        // A context that failed to start reported its error through `ready`
        // and holds nothing to release.
        await ready.then(() => context.destroy(), () => {});
        if (rendererGraphicsStateOwner !== graphicsStateOwner) {
          await releaseSharedWebgpuStates(rendererGraphicsStateOwner);
          await releaseSharedWebgl2State(rendererGraphicsStateOwner);
        }
      },
    });
  }

  // Permanent engine stage counters (presented-frame refactor verification
  // contract): layout computes vs cache hits of the last layout pass,
  // whole-tree scrollable overflow measures, command emission reuses, inline
  // formatting contexts whose inline boxes were computed from their lines,
  // raster plans prepared vs rescrolled, and full frames published natively
  // vs from host-encoded rows, read from the live engine instance every
  // renderer and analytical layout of this runtime shares.
  function engineCounters() {
    return Object.freeze({
      layoutComputeCount: engine.exports.layout_compute_count(),
      layoutCacheHitCount: engine.exports.layout_cache_hit_count(),
      scrollableOverflowMeasureCount:
        engine.exports.scrollable_overflow_measure_count(),
      emissionReuseCount: engine.exports.emission_reuse_count(),
      inlineContextGeometryCount:
        engine.exports.inline_context_geometry_count(),
      rasterPlanPrepareCount: engine.exports.raster_plan_prepare_count(),
      rasterPlanRescrollCount: engine.exports.raster_plan_rescroll_count(),
      // Full frames the core published from its last scene build, and full
      // frames published from input this host encoded row by row.
      directScenePublishCount: engine.exports.engine_direct_scene_publish_count(),
      directInputPublishCount: engine.exports.engine_direct_input_publish_count(),
    });
  }

  // Whether COLR glyphs of axis-aligned, unscaled text draw from the color
  // glyph cache (the default) or keep their commands, for the parity tests
  // that compare the two.
  function setColorGlyphCacheEnabled(enabled) {
    engine.exports.color_glyph_cache_enable(enabled ? 1 : 0);
  }

  return Object.freeze({
    core,
    engineCounters,
    setColorGlyphCacheEnabled,
    __debugEngine,
    RENDER_BG,
    inspectAuthoredNode,
    prewarmCssTextGlyphs,
    imagePixelsFor,
    sharedSvgPathAtlas,
    sceneHtml,
    emitSceneCommands,
    emitSceneCommandsSync,
    layoutTreeBoxes,
    layoutTreeBoxesSync,
    layoutPageBoxesSync,
    layoutTextGeometrySync,
    registerDecodedImage,
    canvasImageEntry: canvasImagePixels,
    layoutCanvasTextSync,
    canvasTextWordsSync,
    canvasTextGlyphOutlineSync,
    createLayoutArtifact,
    createPaintRecord,
    createDisplayListArtifact,
    createInvalidationArtifact,
    releaseRenderContexts,
    useGraphicsDevice,
    hasGraphicsDevice,
    hostGraphicsDevice,
    getDefaultGlyphResourceManager,
    shutdownDefaultGlyphResourceManager,
    renderScenePixels,
    createPersistentSceneRenderer,
    createSceneRenderer: createSceneRenderer,
    openSceneRenderer,
    fontRegistry,
    shapingRuntime,
    atlasRuntime,
    codecRuntime,
    assetIdentities: Object.freeze({
      harfbuzz: harfbuzzBytes,
      msdfgen: msdfgenBytes,
      engine,
      atlasModule: atlasRuntime.moduleIdentity(),
    }),
  });
}

const defaultSceneRendererRuntime = await createSceneRendererRuntime({
  core: sharedDomCore,
  fontRegistry: defaultFontRegistry,
});

// The image side of the default renderer: a document without its own
// renderer runtime decodes its images with this codec runtime and
// registers them here (src/dom/images.js), so that the default renderer
// and its synchronous layout take the same decode.
export const defaultImageRuntime = Object.freeze({
  codecRuntime: defaultSceneRendererRuntime.codecRuntime,
  registerDecodedImage: (...arguments_) =>
    defaultSceneRendererRuntime.registerDecodedImage(...arguments_),
  canvasImageEntry: (...arguments_) =>
    defaultSceneRendererRuntime.canvasImageEntry(...arguments_),
});

export const createLayoutArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createLayoutArtifact(...arguments_);
export const createPaintRecord = (...arguments_) =>
  defaultSceneRendererRuntime.createPaintRecord(...arguments_);
export const createDisplayListArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createDisplayListArtifact(...arguments_);
export const createInvalidationArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createInvalidationArtifact(...arguments_);
export const layoutTreeBoxes = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxes(...arguments_);
export const layoutTreeBoxesSync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxesSync(...arguments_);
export const layoutPageBoxesSync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutPageBoxesSync(...arguments_);
export const layoutTextGeometrySync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTextGeometrySync(...arguments_);
export const layoutCanvasTextSync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutCanvasTextSync(...arguments_);
export const canvasTextWordsSync = (...arguments_) =>
  defaultSceneRendererRuntime.canvasTextWordsSync(...arguments_);
export const canvasTextGlyphOutlineSync = (...arguments_) =>
  defaultSceneRendererRuntime.canvasTextGlyphOutlineSync(...arguments_);
export const engineCounters = (...arguments_) =>
  defaultSceneRendererRuntime.engineCounters(...arguments_);
export const releaseRenderContexts = (...arguments_) =>
  defaultSceneRendererRuntime.releaseRenderContexts(...arguments_);
export const createPersistentSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.createPersistentSceneRenderer(...arguments_);
export const createSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.createSceneRenderer(...arguments_);
export const openSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.openSceneRenderer(...arguments_);
// The host's GPU device for every surface of the realm's default runtime
// (useGraphicsDevice above): call it once, before the first surface renders.
export const useGraphicsDevice = (device) =>
  defaultSceneRendererRuntime.useGraphicsDevice(device);
export const hasGraphicsDevice = () => defaultSceneRendererRuntime.hasGraphicsDevice();
export const hostGraphicsDevice = () => defaultSceneRendererRuntime.hostGraphicsDevice();
export async function createSandomRuntime(options = {}) {
  return await __createSandomRuntimeFromPrepared(
    await prepareSandomRuntimeOptions(options),
  );
}

// Engine tests reach the module realm's runtime through
// test/helpers/scene-render.js; nothing in src or a product imports this.
export function __sceneRendererRuntimeForTests() {
  return defaultSceneRendererRuntime;
}

export async function __createSandomRuntimeFromPrepared(prepared) {
  const {
    explicitAssets,
    resolveSystemFontFamily,
    bundledSystemFonts,
    harfbuzzSource,
    msdfgenSource,
    codecSources,
    harfbuzzBytes,
    msdfgenBytes,
  } = prepared;
  const webPDecoder = createWebPDecoder(
    explicitAssets
      ? { getWebPBytes: lazyAssetBytes(codecSources.webp, "webp") }
      : {},
  );
  const jpegXlCodec = createJpegXlCodec(
    explicitAssets
      ? { getJpegXlBytes: lazyAssetBytes(codecSources.jpegXl, "jpegXl") }
      : {},
  );
  const codecRuntime = createImageCodecRuntime({
    getJpegBytes: explicitAssets
      ? lazyAssetBytes(codecSources.jpeg, "jpeg")
      : null,
    getPngBytes: explicitAssets
      ? lazyAssetBytes(codecSources.png, "png")
      : null,
    decodeWebP: webPDecoder.decodeWebP,
    decodeJXL: jpegXlCodec.decodeJXL,
    encodeJxlOutput: jpegXlCodec.encodeJxlOutput,
  });

  const sceneRendererRuntime = await createSceneRendererRuntime({
    harfbuzzBytes,
    msdfgenBytes,
    resolveSystemFontFamily,
    bundledSystemFonts,
    codecRuntime,
  });
  const domModule = await import("./dom/dom.js");
  const createRuntimeDOM = (domOptions = {}) =>
    domModule.createSandomDOM({
      ...domOptions,
      sceneRendererRuntime,
      fontRegistry: sceneRendererRuntime.fontRegistry,
    });
  const runtime = {
    assets: Object.freeze({
      mode: explicitAssets ? "explicit" : "module-relative",
      harfbuzz: harfbuzzSource,
      msdfgen: msdfgenSource,
      codecs: Object.freeze({ ...codecSources }),
    }),
    renderComponent(options) {
      return domModule.renderComponent(options, {
        createSandomDOM: createRuntimeDOM,
        core: sceneRendererRuntime.core,
        fontRegistry: sceneRendererRuntime.fontRegistry,
      });
    },
    createSandomDOM: createRuntimeDOM,
    loadFont: (...arguments_) =>
      sceneRendererRuntime.fontRegistry.loadFont(...arguments_),
    createSceneRenderer: sceneRendererRuntime.createSceneRenderer,
    openSceneRenderer: sceneRendererRuntime.openSceneRenderer,
    createPersistentSceneRenderer:
      sceneRendererRuntime.createPersistentSceneRenderer,
    createLayoutArtifact: sceneRendererRuntime.createLayoutArtifact,
    createPaintRecord: sceneRendererRuntime.createPaintRecord,
    createDisplayListArtifact: sceneRendererRuntime.createDisplayListArtifact,
    releaseRenderContexts: sceneRendererRuntime.releaseRenderContexts,
    useGraphicsDevice: sceneRendererRuntime.useGraphicsDevice,
    hasGraphicsDevice: sceneRendererRuntime.hasGraphicsDevice,
  };
  return Object.freeze(runtime);
}
