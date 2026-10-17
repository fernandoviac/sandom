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
import { loadColorKernel } from "./wasm/color-kernel.js";
import { createShapingRuntime } from "./shaping.js";
import { acquireFontByteSource } from "./dom-wasm/font-byte-binding.js";
import { noResourceHost } from "./host/contract.js";
import { createDocumentResourceLoader } from "./dom/document-resources.js";
import {
  createFontRegistry,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  defaultFontRegistry,
} from "./font-registry.js";
import {
  gridTrackCss,
  scaleGridTrack,
} from "./grid-tracks.js";
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
  BLEND_MODE_NAMES,
  BOX_OFFSET_CONTENT_H,
  BOX_OFFSET_CONTENT_W,
  BOX_OFFSET_CONTENT_X,
  BOX_OFFSET_CONTENT_Y,
  BOX_OFFSET_HEIGHT,
  BOX_OFFSET_WIDTH,
  BOX_OFFSET_X,
  BOX_OFFSET_Y,
  BOX_SIZE,
  CLEAR_BOTH,
  CLEAR_LEFT,
  CLEAR_NONE,
  CLEAR_RIGHT,
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
  CMD_BOX_SHADOW_FLAG_TRANSFORM,
  CMD_BOX_SHADOW_OFFSET_FLAGS,
  CMD_BOX_SHADOW_OFFSET_H,
  CMD_BOX_SHADOW_OFFSET_W,
  CMD_BOX_SHADOW_OFFSET_X,
  CMD_BOX_SHADOW_OFFSET_XFORM,
  CMD_BOX_SHADOW_OFFSET_Y,
  CMD_IMAGE,
  CMD_IMAGE_FLAG_GLYPH_BITMAP,
  CMD_IMAGE_FLAG_NO_PIXEL_SNAP,
  CMD_IMAGE_FLAG_TRANSFORM,
  CMD_IMAGE_OFFSET_FLAGS,
  CMD_IMAGE_OFFSET_INDEX,
  CMD_IMAGE_OFFSET_H,
  CMD_IMAGE_OFFSET_UV_H,
  CMD_IMAGE_OFFSET_UV_W,
  CMD_IMAGE_OFFSET_W,
  CMD_IMAGE_OFFSET_X,
  CMD_IMAGE_OFFSET_XFORM,
  CMD_IMAGE_OFFSET_Y,
  CMD_POP_BACKDROP_FILTER,
  CMD_POP_BACKGROUND,
  CMD_POP_BLEND_LAYER,
  CMD_POP_CLIP,
  CMD_POP_MASK_LAYER,
  CMD_POP_OPACITY,
  CMD_PUSH_BACKDROP_FILTER,
  CMD_PUSH_BACKGROUND,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
  CMD_PUSH_CLIP,
  CMD_PUSH_CLIP_HEADER_SIZE,
  CMD_PUSH_CLIP_OFFSET_COUNT,
  CMD_PUSH_MASK,
  CMD_PUSH_MASK_LAYER,
  CMD_PUSH_OPACITY,
  CMD_PUSH_OPACITY_FLAG_BLEND_MASK,
  CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT,
  CMD_PUSH_OPACITY_OFFSET_ALPHA,
  CMD_PUSH_OPACITY_OFFSET_FLAGS,
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
  CMD_RECT_OFFSET_XFORM,
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
  COLOR_GLYPH_CACHE_INDEX_BASE,
  COLOR_GLYPH_IMAGE_INDEX_BASE,
  COLOR_GLYPH_IMAGE_RESOURCE_COUNT,
  COLOR_GLYPH_PATH_INDEX_BASE,
  TEXT_STROKE_PATH_INDEX_BASE,
  BUILTIN_PATH_INDEX_BASE,
  BUILTIN_PATH_DISCLOSURE_DOWN,
  BUILTIN_PATH_DISCLOSURE_LEFT,
  BUILTIN_PATH_DISCLOSURE_RIGHT,
  FONT_UNIT_SUBDIVISION,
  CMD_TEXT,
  CMD_TEXT_FLAG_TEXT_SHADOW,
  CMD_TEXT_FLAG_TRANSFORM,
  CMD_TEXT_OFFSET_ASCENT,
  CMD_TEXT_OFFSET_BL,
  CMD_TEXT_OFFSET_DESCENT,
  CMD_TEXT_OFFSET_FLAGS,
  CMD_TEXT_OFFSET_FONT,
  CMD_TEXT_OFFSET_COLOR,
  CMD_TEXT_OFFSET_FSIZE,
  CMD_TEXT_OFFSET_GCOUNT,
  CMD_TEXT_OFFSET_GOFF,
  CMD_TEXT_OFFSET_LH,
  CMD_TEXT_OFFSET_STYLE,
  CMD_TEXT_OFFSET_UPEM,
  CMD_TEXT_OFFSET_WEIGHT,
  CMD_TEXT_OFFSET_X,
  CMD_TEXT_OFFSET_XFORM,
  CMD_TEXT_OFFSET_Y,
  commandByteSize,
  FLOAT_LEFT,
  FLOAT_NONE,
  FLOAT_RIGHT,
  FONT_TABLE_BASE,
  FONT_TABLE_ENTRY_SIZE,
  FONT_TABLE_OFFSET_ASCENDER,
  FONT_TABLE_OFFSET_DESCENDER,
  FONT_TABLE_OFFSET_LINE_GAP,
  FONT_TABLE_OFFSET_UPEM,
  FONT_TABLE_OFFSET_BYTES,
  FONT_TABLE_OFFSET_LENGTH,
  FONT_TABLE_OFFSET_ITALIC,
  FONT_TABLE_OFFSET_WEIGHT,
  FONT_VARIATION_TABLE_BASE,
  FONT_VARIATION_TABLE_ENTRY_SIZE,
  FONT_VARIATION_OFFSET_WIDTH,
  FONT_VARIATION_OFFSET_SLANT,
  GLYPH_ENTRY_SIZE,
  GLYPH_REQUEST_HEADER_SIZE,
  GLYPH_REQUEST_ROW_SIZE,
  GLYPH_REQUEST_KIND_PATH,
  glyphRequestRowByteSize,
  GLYPH_OFFSET_CLUSTER_END,
  GLYPH_OFFSET_CLUSTER_START,
  GLYPH_OFFSET_ID,
  GLYPH_OFFSET_X_ADVANCE,
  GLYPH_OFFSET_X_OFFSET,
  GRADIENT_STOP_POOL_BASE,
  GRADIENT_STOP_POOL_SIZE,
  HEADER_BASE,
  HEADER_OFFSET_GENERATION,
  RASTER_PLAN_SCROLLBAR_ROW_SIZE,
  RASTER_RESOURCE_IMAGE,
  LANGUAGE_TABLE_ENTRY_SIZE,
  LAYOUT_NODE_OFFSET_CHANGED_GEN,
  LAYOUT_NODE_OFFSET_PAINT_GEN,
  LAYOUT_NODE_OFFSET_FONT_INDEX,
  LAYOUT_NODE_OFFSET_FONT_SIZE,
  LAYOUT_NODE_OFFSET_FONT_STACK,
  FONT_STACK_ENTRY_SIZE,
  FONT_STACK_OFFSET_PRIMARY,
  FONT_STACK_OFFSET_SLOTS,
  FONT_STACK_SLOT_HEADER_SIZE,
  FONT_STACK_SLOT_SIZE,
  FONT_STACK_TABLE_BASE,
  FONT_STACK_UNLOADED,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
  LAYOUT_NODE_SIZE,
  LAYOUT_UNIT,
  LINE_HEIGHT_LENGTH,
  LINE_HEIGHT_NORMAL,
  LINE_HEIGHT_NUMBER,
  TEXT_LINE_ENTRY_SIZE,
  TEXT_LINE_OFFSET_AVAIL,
  TEXT_LINE_OFFSET_FIRST_GLYPH,
  TEXT_LINE_OFFSET_GLYPH_COUNT,
  TEXT_LINE_OFFSET_WIDTH,
  TEXT_LINE_OFFSET_X,
  TEXT_LINE_OFFSET_Y,
  TEXT_RUN_ENTRY_SIZE,
  TEXT_RUN_OFFSET_GLYPH_COUNT,
  TEXT_RUN_OFFSET_GLYPH_OFFSET,
  TEXT_RUN_OFFSET_LINE_COUNT,
  TEXT_RUN_OFFSET_LINE_OFFSET,
  SHAPED_GLYPH_ENTRY_SIZE,
  SHAPED_GLYPH_OFFSET_CLUSTER_START,
  SHAPED_GLYPH_OFFSET_FLAGS,
  SHAPED_GLYPH_FONT_INDEX,
  SHAPED_GLYPH_FONT_SYNTHESIZED,
  SHAPED_GLYPH_OFFSET_FONT,
  SHAPED_GLYPH_OFFSET_ID,
  SHAPED_GLYPH_OFFSET_X_ADVANCE,
  SHAPED_GLYPH_OFFSET_UNSCALED_ADVANCE,
  TILE_CONFIG_BASE,
  TILE_CONFIG_OFFSET_COLUMNS,
  TILE_CONFIG_OFFSET_DEVICE_SCALE,
  TILE_CONFIG_OFFSET_FRAME_HEIGHT,
  TILE_CONFIG_OFFSET_FRAME_WIDTH,
  TILE_CONFIG_OFFSET_ORIGIN_X,
  TILE_CONFIG_OFFSET_ORIGIN_Y,
  TILE_CONFIG_OFFSET_ROWS,
  TILE_CONFIG_OFFSET_TILE_SIZE,
  TILE_DIRTY_MAP_SIZE,
} from "./wasm/layout.js";
import { FONT_COVERAGE_RANGE_SIZE } from "./font-coverage.js";

export { LAYOUT_UNIT };

const { convertXyzToLinearRgb, encodeSrgbTransfer } = loadColorKernel();

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

  function needsGlobalPreparation(node) {
    return node.display === "svg-use" || (node.order ?? 0) !== 0 ||
      (!usesCoreRecord(node) && (node.display === "grid" ||
        node.display === "inline-grid" ||
        node.transform?.kind === "cssTransform" ||
        node.clipPath !== undefined));
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
    const record = new DataView(core.refreshBytes().buffer, pointer, 80);
    return Object.freeze({
      family: fontIdentityValues[record.getUint32(24, true)],
      faceIdentity: fontIdentityValues[record.getUint32(28, true)],
      faceIndex: record.getUint32(32, true),
      style: ["normal", "italic"][record.getUint32(36, true)],
      weight: record.getFloat64(40, true),
      stretch: record.getFloat64(48, true),
      slant: record.getFloat64(56, true),
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
    const report = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 16);
    return recordFontInstance(index, {
      family, weight, stretch, faceIdentity, finalURL, resourceHandle,
      faceIndex: report.getUint32(12, true),
      registeredWeight: report.getInt32(0, true),
      registeredWidth: report.getFloat32(4, true),
      registeredSlant: report.getFloat32(8, true),
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
        const record = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 48);
        const glyphRequest = {
          faceIndex: record.getUint32(0, true), weight: record.getFloat64(8, true),
          variationWidth: record.getFloat64(16, true), variationSlant: record.getFloat64(24, true),
          opticalSize: record.getFloat64(32, true), devicePixelSize: record.getFloat64(40, true),
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
        const family = request.familyKind === 1
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
  let resourceEngineScope = 0n;
  const { prepareImages, prepareImagesSync, registerDecodedImage, canvasImageEntry, releasePixels } =
    createImageResourceBinding({
      core,
      ensureScope: () => resourceEngineScope ||= core.resourceEngineCreate(),
      pixels: imagePixelsByIndex,
      decode: decodeImageEntry,
      decodeIcon: () => brokenImageIconEntry(svgImageDensity),
      failureCode: brokenImageFailureCode,
    });

  function joinEngineResource(resource, index, variant = 0) {
    resourceEngineScope ||= core.resourceEngineCreate();
    core.resourceEngineBind(
      resourceEngineScope,
      resource,
      index,
      variant,
    );
    return core.resourceEngineIndex(
      resourceEngineScope,
      core.resourceId(resource),
      variant,
    );
  }

  const fontSourceDecoder = new TextDecoder();
  fontRegistry.attachEngineSourceTransport({
    // A released face no longer names the engine instances it registered.
    release({ resourceHandle }) {
      core.status("font_registration_forget", fontRegistry.fontCatalogHandle, resourceHandle);
    },
    // The renderer's resource engine scope, created on first use.
    ensureScope() {
      return resourceEngineScope ||= core.resourceEngineCreate();
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
    prepare(root, defaultFamilyKey, importSource) {
      synchronizeFallbackCoverage();
      if (resourceEngineScope === 0n) {
        resourceEngineScope = core.resourceEngineCreate();
        fontRegistry.replayEngineSources();
      }
      core.status("font_catalog_render_bind", fontRegistry.fontCatalogHandle,
        resourceEngineScope, root._coreHandle, ...core.input(defaultFamilyKey));
      const count = core.status("font_catalog_source_requests");
      if (count === 0) return;
      const base = core.exports.abi_output_pointer();
      const requestView = new DataView(core.memory.buffer);
      const requests = new Array(count);
      for (let index = 0; index < count; index++) {
        const row = base + index * 16;
        const pointer = requestView.getUint32(row, true);
        const length = requestView.getUint32(row + 4, true);
        requests[index] = {
          family: fontSourceDecoder.decode(new Uint8Array(core.memory.buffer, pointer, length)),
          weight: requestView.getUint32(row + 8, true),
          style: requestView.getUint32(row + 12, true) === 0 ? "normal" : "italic",
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
    const rangePointer = engine.exports.hb_malloc_for_test(ranges.length);
    new Uint8Array(engine.memory.buffer, rangePointer, ranges.length).set(ranges);
    const languagePointer = engine.exports.hb_malloc_for_test(Math.max(1, languages.length) * LANGUAGE_TABLE_ENTRY_SIZE);
    const languageBytes = new Uint8Array(engine.memory.buffer, languagePointer, languages.length * LANGUAGE_TABLE_ENTRY_SIZE);
    languageBytes.fill(0);
    for (const [index, tag] of languages.entries()) {
      const bytes = new TextEncoder().encode(tag.toLowerCase());
      if (bytes.length > LANGUAGE_TABLE_ENTRY_SIZE - 1) {
        throw new RangeError(
          `The coverage index language tag "${tag}" has ${bytes.length} bytes; the limit is ${LANGUAGE_TABLE_ENTRY_SIZE - 1}`,
        );
      }
      languageBytes[index * LANGUAGE_TABLE_ENTRY_SIZE] = bytes.length;
      languageBytes.set(bytes, index * LANGUAGE_TABLE_ENTRY_SIZE + 1);
    }
    engine.exports.font_coverage_set(
      rangePointer, ranges.length / FONT_COVERAGE_RANGE_SIZE, defaultCount, languagePointer, languages.length,
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
    const requests = Array.from({ length: count }, (_, index) => {
      const request = engine.exports.font_fallback_request_at(index);
      return {
        family: request >>> 16,
        style: request & 0xFFFF,
        weight: fontRegistry.fontWeightInCssUnits(request & 0xFF),
        italic: (request & 0x100) !== 0,
      };
    });
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
        engine.exports.font_range_answer(
          face,
          style,
          loaded[index] ? core.status("font_range_face_index", style, face) : FONT_STACK_UNLOADED,
        );
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
          const count = resolved.width * resolved.height;
          value = new Uint8Array(count * 4);
          for (let i = 0; i < count; i++) {
            const rgb = convertXyzToLinearRgb("srgb", [
              resolved.pixels[i * 4],
              resolved.pixels[i * 4 + 1],
              resolved.pixels[i * 4 + 2],
            ]);
            for (let channel = 0; channel < 3; channel++) {
              value[i * 4 + channel] = Math.round(
                Math.min(1, Math.max(0, encodeSrgbTransfer(rgb[channel]))) *
                  255,
              );
            }
            value[i * 4 + 3] = Math.round(
              Math.min(1, Math.max(0, resolved.pixels[i * 4 + 3])) * 255,
            );
          }
        } else {
          value = toSrgbRgba8(resolved).pixels;
        }
        Object.defineProperty(this, "pixels", { value });
        return value;
      },
    };
  }


  // The failure code the core keeps for a broken image (resources.watpart
  // failure96, read by scene.watpart $sceneSourceFailure): 1 the load
  // failed; 2 bytes of an image type, or of no type, that do not decode; 3
  // bytes of a document type (text, XML or JSON), which an object or an
  // embed shows as a nested browsing context (Blink's
  // IsSupportedNonImageMimeType); 4 bytes of another type.
  function brokenImageFailureCode(broken) {
    if (broken.failure === "fetch") return 1;
    const type = broken.mediaType;
    if (type === null || type.startsWith("image/")) return 2;
    if (
      type.startsWith("text/") || type === "application/xml" ||
      type === "application/xhtml+xml" || type === "application/json" ||
      type.endsWith("+xml") || type.endsWith("+json")
    ) {
      return 3;
    }
    return 4;
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
    return {
      width: Math.max(1, Math.ceil(decoded.naturalWidth)),
      height: Math.max(1, Math.ceil(decoded.naturalHeight)),
      naturalWidth: Math.ceil(decoded.naturalWidth),
      naturalHeight: Math.ceil(decoded.naturalHeight),
      defaultSized: decoded.defaultSized,
      naturalRatio: decoded.naturalRatio ?? 0,
      svg: Object.freeze({ decoded, locator, density: null, viewport: null, rasters: new Map() }),
    };
  }

  // The viewport of an SVG image's raster in CSS px: its natural size,
  // rounded up, or for an image without natural dimensions the concrete
  // object size that the frame draws it at (rounded up).
  function svgImageViewport(decoded, concrete) {
    const [width, height] = decoded.defaultSized && concrete !== null
      ? concrete
      : [decoded.naturalWidth, decoded.naturalHeight];
    return { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) };
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
          Math.ceil(decoded.naturalWidth),
          Math.ceil(decoded.naturalHeight),
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

  // The concrete object size in CSS px that one CMD_IMAGE draws image
  // `entry` at: the destination over the share of the image it samples.
  // A border-image piece (CMD_IMAGE_FLAG_NO_PIXEL_SNAP) scales a slice to
  // a border width, which does not give the size of the image: for an
  // image with a natural ratio its concrete size has that ratio (CSS
  // Backgrounds 3 §6.2 sizes it in the border image area), and the larger
  // scale of the piece gives the resolution.
  function drawnConcreteSize(cmdView, off, entry) {
    const scaleX = cmdView.getFloat32(off + CMD_IMAGE_OFFSET_W, true) /
      Math.abs(cmdView.getFloat32(off + CMD_IMAGE_OFFSET_UV_W, true));
    const scaleY = cmdView.getFloat32(off + CMD_IMAGE_OFFSET_H, true) /
      Math.abs(cmdView.getFloat32(off + CMD_IMAGE_OFFSET_UV_H, true));
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
    const piece = (cmdView.getUint8(off + CMD_IMAGE_OFFSET_FLAGS) & CMD_IMAGE_FLAG_NO_PIXEL_SNAP) !== 0;
    if (!piece || !(entry.naturalRatio > 0)) return [scaleX, scaleY];
    const width = Math.max(scaleX, scaleY * entry.naturalRatio);
    return [width, width / entry.naturalRatio];
  }

  // Gives each SVG image that the frame's commands draw (CMD_IMAGE of a
  // registered image) its raster at `density`, kept or made. An image
  // without natural dimensions rasters with its viewport at the concrete
  // object size of the largest draw of the frame: one image index has one
  // raster in a frame
  // (plans/images/BUG-default-sized-image-drawn-at-two-shapes-shares-one-raster.md).
  // Images that the frame does not draw keep their entry: the runtime also
  // holds the images of other documents. The entry replaces the one at
  // the same index, as a color glyph bitmap of another size does; the GPU
  // texture follows the entry. The rasters to make start at once and take
  // turns (rasterizeSvgImage).
  async function selectSvgImageRasters(cmdView, bytesWritten, density, svgImageTimings) {
    const drawn = new Map(); // imageIndex -> { entry, concrete }
    for (let off = 0; off < bytesWritten; off += commandByteSize(cmdView, off)) {
      // A command with an empty rectangle draws nothing.
      if (
        cmdView.getUint8(off) !== CMD_IMAGE ||
        (cmdView.getUint8(off + CMD_IMAGE_OFFSET_FLAGS) & CMD_IMAGE_FLAG_GLYPH_BITMAP) !== 0 ||
        !(cmdView.getFloat32(off + CMD_IMAGE_OFFSET_W, true) > 0) ||
        !(cmdView.getFloat32(off + CMD_IMAGE_OFFSET_H, true) > 0)
      ) continue;
      const imageIndex = cmdView.getUint16(off + CMD_IMAGE_OFFSET_INDEX, true);
      const entry = imagePixelsByIndex.get(imageIndex);
      if (entry?.svg === undefined) continue;
      const image = drawn.get(imageIndex) ?? { entry, concrete: null };
      drawn.set(imageIndex, image);
      if (!entry.defaultSized) continue;
      const concrete = drawnConcreteSize(cmdView, off, entry);
      if (concrete !== null && (image.concrete === null || concrete[0] * concrete[1] > image.concrete[0] * image.concrete[1])) {
        image.concrete = concrete;
      }
    }
    const selections = [];
    for (const [imageIndex, { entry, concrete }] of drawn) {
      const viewport = svgImageViewport(entry.svg.decoded, concrete);
      if (
        entry.svg.density === density && entry.svg.viewport.width === viewport.width &&
        entry.svg.viewport.height === viewport.height
      ) continue;
      selections.push({ imageIndex, entry, selected: svgImageRaster(entry, density, viewport, svgImageTimings) });
    }
    const selected = await Promise.all(
      selections.map((selection) => selection.selected),
    );
    selections.forEach(({ imageIndex, entry }, index) => {
      if (imagePixelsByIndex.get(imageIndex) === entry) {
        imagePixelsByIndex.set(imageIndex, selected[index]);
      }
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
    const variant = density >= 2 ? 2 : 1;
    let entry = brokenImageIconEntries.get(variant);
    if (entry === undefined) {
      entry = decodeImage(variant === 2 ? BROKEN_IMAGE_ICON_2X_PNG : BROKEN_IMAGE_ICON_PNG)
        .then((decoded) => registeredImageEntry(decoded, 14, 16));
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
      const kind = image.kind === "canvas" ? 1 : 0;
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
      const records = new Float32Array(engine.memory.buffer, pointer, count * 3);
      records.set([image.width, image.height, kind]);
      if (image.glyphBox) records.set(image.glyphBox, 3);
    }
  }

  // Bitmap glyphs (plans/text/PLAN-color-glyphs.md slice 2): a CMD_IMAGE with
  // CMD_IMAGE_FLAG_GLYPH_BITMAP names the engine's bitmap slot (font,
  // glyph, CSS font size) at COLOR_GLYPH_IMAGE_INDEX_BASE + slot. At the
  // target's device scale the engine's strike chooser picks the strike and
  // locates its PNG; the PNG decodes once for each strike and glyph, and
  // the image entry carries the strike's image box in ems of the font size
  // (left, top, width, height, y down from the origin) and whether the
  // origin is a whole device pixel (sbix) for the raster plan.
  const colorGlyphBitmapBySlot = new Map(); // slot -> { requested, entry }
  const colorGlyphBitmapDecodes = new Map(); // "pointer:length" -> { png, image }
  async function prepareColorGlyphBitmaps(cmdView, bytesWritten, deviceScale) {
    const slotCount = engine.exports.color_glyph_bitmap_count();
    if (slotCount === 0) return;
    const slots = new Set();
    for (let off = 0; off < bytesWritten; off += commandByteSize(cmdView, off)) {
      if (
        cmdView.getUint8(off) === CMD_IMAGE &&
        (cmdView.getUint8(off + CMD_IMAGE_OFFSET_FLAGS) & CMD_IMAGE_FLAG_GLYPH_BITMAP) !== 0
      ) {
        const index = cmdView.getUint16(off + CMD_IMAGE_OFFSET_INDEX, true);
        // Indices from COLOR_GLYPH_CACHE_INDEX_BASE are color glyph cache
        // slots (src/color-glyph-cache.js).
        if (index < COLOR_GLYPH_CACHE_INDEX_BASE) slots.add(index - COLOR_GLYPH_IMAGE_INDEX_BASE);
      }
    }
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
  // Definitions are immutable effects data for the atlas generator.
  const svgPathDefByIndex = new Map(); // pathIndex -> { pathDef, fillRule, stroke? }
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

  // The outline of a color glyph layer (plans/text/PLAN-color-glyphs.md): the
  // engine's path slot names a registered font and a glyph; its outline at
  // the shaping scale becomes a `d` string in font units, y down — the box
  // the engine measured for the slot's CMD_SVG_PATH dest rect.
  const colorGlyphPathDefs = new Map(); // pathIndex -> { key, def }
  // Relative agreement of the engine's layer box with the atlas bounds.
  // Both measure the same f32 outline coordinates; the engine stores its
  // box (curve extrema included) in f32, so a curve extremum may round
  // differently by an f32 step (2^-23 relative). Measured 2026-10-05 on
  // the 120 box corners of test/text/text_color_glyph_test.js: 0.
  const COLOR_GLYPH_BOX_TOLERANCE = 2 ** -22;
  function colorGlyphPathDef(pathIndex) {
    const slot = pathIndex - COLOR_GLYPH_PATH_INDEX_BASE;
    const count = engine.exports.color_glyph_path_count();
    if (slot >= count) {
      throw new Error(
        `CMD_SVG_PATH names color glyph path slot ${slot}, but the engine registered ${count}; ` +
          "the command buffer and the engine disagree",
      );
    }
    const key = engine.exports.color_glyph_path_key(slot);
    const cached = colorGlyphPathDefs.get(pathIndex);
    if (cached?.key === key) return cached.def;
    const pointer = engine.exports.glyph_outline_extract_registered(key >>> 16, key & 0xffff);
    const length = engine.exports.glyph_outline_length();
    const view = new DataView(engine.memory.buffer, pointer, length);
    const scale = 1 / FONT_UNIT_SUBDIVISION;
    const x = (offset) => view.getFloat32(offset, true) * scale;
    const y = (offset) => -view.getFloat32(offset, true) * scale;
    const parts = [];
    for (let offset = 0; offset < length;) {
      const verb = view.getUint8(offset);
      if (verb === 0) {
        parts.push(`M${x(offset + 1)} ${y(offset + 5)}`);
        offset += 9;
      } else if (verb === 1) {
        parts.push(`L${x(offset + 1)} ${y(offset + 5)}`);
        offset += 9;
      } else if (verb === 2) {
        parts.push(`Q${x(offset + 1)} ${y(offset + 5)} ${x(offset + 9)} ${y(offset + 13)}`);
        offset += 17;
      } else if (verb === 3) {
        parts.push(
          `C${x(offset + 1)} ${y(offset + 5)} ${x(offset + 9)} ${y(offset + 13)} ${x(offset + 17)} ${y(offset + 21)}`,
        );
        offset += 25;
      } else if (verb === 4) {
        parts.push("Z");
        offset += 1;
      } else {
        throw new Error(`glyph outline verb ${verb} at byte ${offset} of ${length} is unknown`);
      }
    }
    const def = { pathDef: parts.join(""), fillRule: "nonzero" };
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
            "$cgPathSlot) and the atlas measurement must describe the same outline",
        );
      }
    }
    colorGlyphPathDefs.set(pathIndex, { key, def });
    return def;
  }

  // The engine's built-in outlines (layout.js BUILTIN_PATH_*): Blink's
  // disclosure triangles (list_marker_painter.cc) in a 100-unit square. The
  // command's rectangle is each outline's own box, so only the shape and
  // its proportions within the box matter. The core lists the same
  // definitions to native hosts (src/dom-wasm/path-resources.watpart).
  const BUILTIN_PATH_DEFS = new Map([
    [BUILTIN_PATH_DISCLOSURE_RIGHT, { pathDef: "M0 0L86 50L0 100Z", fillRule: "nonzero" }],
    [BUILTIN_PATH_DISCLOSURE_LEFT, { pathDef: "M100 0L14 50L100 100Z", fillRule: "nonzero" }],
    [BUILTIN_PATH_DISCLOSURE_DOWN, { pathDef: "M0 7L50 93L100 7Z", fillRule: "nonzero" }],
  ]);

  // The path a CMD_SVG_PATH index names: a host SVG path, a color glyph
  // outline, a stroked glyph outline of SVG text, or a built-in outline.
  function pathDefForIndex(pathIndex) {
    if (pathIndex >= BUILTIN_PATH_INDEX_BASE) {
      const def = BUILTIN_PATH_DEFS.get(pathIndex);
      if (!def) throw new Error(`CMD_SVG_PATH names built-in path ${pathIndex}, which the host does not define`);
      return def;
    }
    if (pathIndex >= TEXT_STROKE_PATH_INDEX_BASE) {
      const { pathDef, fillRule, stroke } = core.svgPathDefinition(pathIndex);
      return { pathDef, fillRule, stroke };
    }
    return pathIndex >= COLOR_GLYPH_PATH_INDEX_BASE
      ? colorGlyphPathDef(pathIndex)
      : svgPathDefByIndex.get(pathIndex);
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
      if (view.getUint16(offset + 14, true) === GLYPH_REQUEST_KIND_PATH) {
        const pathIndex = view.getUint32(offset, true);
        // Color glyph and text stroke slots are the engine's; the core
        // writes their definitions from its current slots.
        const engineSlot = pathIndex >= COLOR_GLYPH_PATH_INDEX_BASE && pathIndex < BUILTIN_PATH_INDEX_BASE;
        let definition = engineSlot ? null : svgPathDefByIndex.get(pathIndex);
        if (!definition) {
          definition = core.svgPathDefinition(pathIndex);
          if (!engineSlot) svgPathDefByIndex.set(pathIndex, definition);
        }
        requests.push({ ...definition, pathIndex, screenSize: view.getFloat64(offset + 4, true) });
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
      core.status("scene_svg_path_complete", publication.handle,
        sharedSvgPathAtlas.id, Number(sharedSvgPathAtlas.coverageMode));
    }
    return nodes;
  }

  function prepareSvgPathResourcesSync(nodes) {
    for (const publication of svgPathPublications(nodes)) {
      if (core.status("scene_svg_path_prepare", publication.handle) === 0) continue;
      sharedSvgPathAtlas.ensurePathsSync(nativePathRequests());
      core.status("scene_svg_path_complete", publication.handle,
        sharedSvgPathAtlas.id, Number(sharedSvgPathAtlas.coverageMode));
    }
    return nodes;
  }

  // The publication phase initializes the path atlas before native rows are
  // installed. Resolution and metric completion stay in this synchronous turn:
  // an awaited resource load could replace the shared engine's current rows.
  function prepareLayoutSvgGeometry(count, width, height) {
    const preparation = core.status("scene_svg_geometry_prepare", count, width, height);
    if (preparation >>> 1) {
      sharedSvgPathAtlas.ensurePathsSync(nativePathRequests());
      core.status("scene_svg_geometry_complete", count,
        sharedSvgPathAtlas.id, Number(sharedSvgPathAtlas.coverageMode));
    }
    return (preparation & 1) !== 0;
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
    const requestRowCount = header.getUint32(0, true);
    if (requestBytes !== GLYPH_REQUEST_HEADER_SIZE + requestRowCount * GLYPH_REQUEST_ROW_SIZE ||
      header.getUint32(4, true) !== requestRevision) {
      throw new Error(`Glyph request publication has ${requestBytes} bytes, ${requestRowCount} rows, and revision ${header.getUint32(4, true)}; expected revision ${requestRevision} and complete 16-byte rows`);
    }
    return { requestRevision, requestRowCount, requestSnapshot, glyphBuffer,
      engineMemory: engine.memory, publicationOwner: owner, glyphResourceManager, generationBackend, glyphLease: null };
  }


  // Native request rows already include draw transforms, clip masks and density.
  async function buildSvgPathRenderResources(requestSnapshot) {
    const requests = nativePathRequests(requestSnapshot);
    if (requests.length) await sharedSvgPathAtlas.ensurePaths(requests);
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
            off + CMD_SVG_PATH_OFFSET_XFORM + 4,
            true,
          );
          const c = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 8,
            true,
          );
          const d = cmdView.getFloat32(
            off + CMD_SVG_PATH_OFFSET_XFORM + 12,
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
        const count = cmdView.getUint8(off + CMD_PUSH_CLIP_OFFSET_COUNT);
        for (let index = 0; index < count; index++) {
          const entry = off + CMD_PUSH_CLIP_HEADER_SIZE +
            index * CLIP_ENTRY_SIZE;
          const flags = cmdView.getUint8(entry + CLIP_ENTRY_OFFSET_FLAGS);
          if (!(flags & CLIP_ENTRY_FLAG_PATH_MASK)) continue;
          const payload = entry + CLIP_ENTRY_OFFSET_RADII;
          const pathIndex = cmdView.getUint32(payload, true);
          const coordinateScale = cmdView.getFloat32(payload + 4, true) *
            deviceScale;
          const destW = (cmdView.getFloat32(payload + 16, true) -
            cmdView.getFloat32(payload + 8, true)) * coordinateScale;
          const destH = (cmdView.getFloat32(payload + 20, true) -
            cmdView.getFloat32(payload + 12, true)) * coordinateScale;
          let scaleX = 1;
          let scaleY = 1;
          if (flags & CLIP_ENTRY_FLAG_AFFINE) {
            const a = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE,
              true,
            );
            const b = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 4,
              true,
            );
            const c = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 8,
              true,
            );
            const d = cmdView.getFloat32(
              entry + CLIP_ENTRY_OFFSET_AFFINE + 12,
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

  const col = (c) => c || { r: 0, g: 0, b: 0, a: 0 };

  // float / clear DSL values → u8 enums (design/floats.md). Unknown
  // values throw rather than silently writing 0 — same fail-loud convention
  // as blendMode.
  function floatByte(value) {
    if (value === undefined || value === "none") return FLOAT_NONE;
    if (value === "left") return FLOAT_LEFT;
    if (value === "right") return FLOAT_RIGHT;
    throw new Error(`unknown float: ${value}`);
  }

  function clearByte(value) {
    if (value === undefined || value === "none") return CLEAR_NONE;
    if (value === "left") return CLEAR_LEFT;
    if (value === "right") return CLEAR_RIGHT;
    if (value === "both") return CLEAR_BOTH;
    throw new Error(`unknown clear: ${value}`);
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
      flags: 1,
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
        flags |= 1;
        inputView.setUint32(
          row + EngineFrameResolutionFields.fontIndex,
          node.fontIndex,
          true,
        );
      }
      if (node.imageIndex !== undefined) {
        flags |= 2;
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
        flags |= 16;
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
            layer.imageIndex ?? 0xffff,
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
  function backgroundLayerList(node) {
    const layers = node.resolvedBackgroundImages ?? node.backgroundImages;
    const attachment = node.backgroundAttachment ?? "scroll";
    if (!layers?.length) {
      return node.backgroundGradient && attachment !== "scroll"
        ? [{ gradient: node.backgroundGradient, attachment }]
        : null;
    }
    return node.backgroundGradient
      ? [...layers, { gradient: node.backgroundGradient, attachment }]
      : layers;
  }

  function edgeQuad(spec, fallback) {
    const v = spec === undefined ? fallback : spec;
    const a = Array.isArray(v) ? v : [v];
    if (a.length === 1) return [a[0], a[0], a[0], a[0]];
    if (a.length === 2) return [a[0], a[1], a[0], a[1]];
    if (a.length === 3) return [a[0], a[1], a[2], a[1]];
    return [a[0], a[1], a[2], a[3]];
  }



  // ---- spec → CSS/HTML (the Chrome side) ----
  function cssSize(v) {
    if (v === undefined || v === "auto") return "auto";
    if (typeof v === "number") return `${v}px`;
    if (
      v && typeof v === "object" &&
      Number.isFinite(v.pixels) && Number.isFinite(v.percentage)
    ) {
      const sign = v.percentage < 0 ? "-" : "+";
      return `calc(${v.pixels}px ${sign} ${Math.abs(v.percentage * 100)}%)`;
    }
    return v;
  }
  const rgba = (c) =>
    c && c.a > 0
      ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${
        Math.round(c.b * 255)
      },${c.a})`
      : "transparent";

  // svg shape children (design/svg-rendering.md): SVG presentation attributes
  // (cx/r/x/width/fill/...) are NOT CSS properties — applying nodeCss's
  // ordinary width/height/etc. declarations to a <rect>/<circle> element
  // would be meaningless (SVG geometry attributes, not boxes). sceneHtml's
  // renderNode emits real SVG attributes directly instead; nodeCss
  // contributes nothing for these nodes.
  // svg-symbol (S6 step 3): a DEFINITION-only node, never itself linked
  // into any `children` array (only ever reached via a use.href index) —
  // nodeCss should treat it as a no-op just like every other member here,
  // since <symbol> gets display:none unconditionally per the UA
  // stylesheet regardless of any CSS declared on it.
  // svg-use (S6 steps 2-3): its own x/y/width/height/transform are ALL
  // real SVG attributes on the <use> element itself (renderNode's own
  // svg-use branch emits them directly) — applying nodeCss's ordinary
  // width:/height:/transform: CSS declarations ON TOP would double-apply
  // sizing/positioning that's already fully expressed via attributes
  // (found as a real bug: a real Chrome oracle test showed both instances
  // shifted/resized wrong until this was added).
  const SVG_SHAPE_DISPLAY_NAMES_CSS = new Set([
    "svg-rect",
    "svg-circle",
    "svg-ellipse",
    "svg-line",
    "svg-path",
    "svg-polygon",
    "svg-polyline",
    "svg-group",
    "svg-symbol",
    "svg-use",
  ]);

  // Shared by nodeCss's own filter: and backdrop-filter: declarations — CSS
  // space-separated function list, list order preserved AS-IS (matches
  // writeFilterList's own list-order-is-chaining-order convention). amount
  // is unitless for color-matrix functions (CSS accepts a bare number OR
  // percentage — this DSL's own `amount` is always the unitless/fraction
  // form, e.g. 1 not 100%) except hue-rotate (angle, deg — writeFilterList
  // converts to radians on the WASM side, this oracle-CSS side stays in
  // degrees since that's what the `deg` unit expects), blur (length, px —
  // this DSL's own `amount` IS sigma directly, which is also exactly what
  // CSS's own blur() length argument means, so no conversion needed here),
  // and drop-shadow (CSS's own `drop-shadow(dx dy sigma color)` shorthand —
  // NOTE: unlike box-shadow, drop-shadow's blur argument in CSS is ALSO
  // literally sigma, same "no radius/2 mapping" convention as blur() itself,
  // confirmed by writeFilterList's own doc comment for the WASM-side
  // payload).
  function filterListCss(filters) {
    return filters.map((f) => {
      if (f.type === "hue-rotate") return `hue-rotate(${f.amount ?? 0}deg)`;
      if (f.type === "blur") return `blur(${f.amount ?? 0}px)`;
      if (f.type === "drop-shadow") {
        const c = f.color ?? { r: 0, g: 0, b: 0, a: 1 };
        return `drop-shadow(${f.dx ?? 0}px ${f.dy ?? 0}px ${f.sigma ?? 0}px ${
          rgba(c)
        })`;
      }
      return `${f.type}(${f.amount ?? 1})`;
    }).join(" ");
  }

  // One CSS <gradient> function from this DSL's {kind, repeating, angle,
  // center, shape, size, stops} shape — shared by background-image and
  // P11's mask-image, which take the identical gradient object.
  function cssGradientImage(g) {
    // A stop's position is its `position` fraction plus its `pixels`
    // length; a stop with neither is unpositioned.
    const stopPositionCss = (s) => {
      if (s.pixels === undefined) {
        return s.position === undefined ? "" : ` ${s.position * 100}%`;
      }
      return s.position ? ` calc(${s.position * 100}% + ${s.pixels}px)` : ` ${s.pixels}px`;
    };
    const stopsCss = g.stops.map((s) => `${rgba(s.color)}${stopPositionCss(s)}`).join(", ");
    const repeatingPrefix = g.repeating ? "repeating-" : "";
    // css-images-4 <color-interpolation-method>: emitted only when the DSL
    // names one, so every pre-existing scene keeps its exact CSS text.
    const hueClause = g.hueMethod && g.hueMethod !== "shorter"
      ? ` ${g.hueMethod} hue`
      : "";
    const interpolationCss = g.interpolationSpace
      ? ` in ${g.interpolationSpace}${hueClause}`
      : "";
    if (g.kind === "linear") {
      return `${repeatingPrefix}linear-gradient(${
        g.angle ?? 0
      }deg${interpolationCss}, ${stopsCss})`;
    }
    // css's <position> takes bare length/percent components (no 'x'/'y'
    // suffix) in x-then-y order — same values this scene DSL's own
    // `center` field already carries, just needing unit suffixes for a
    // plain number (matches cssSize's own length-vs-percent convention).
    const [centerXSpec, centerYSpec] = g.center ?? ["50%", "50%"];
    const centerCss = `${cssSize(centerXSpec)} ${cssSize(centerYSpec)}`;
    if (g.kind === "conic") {
      return `${repeatingPrefix}conic-gradient(from ${
        g.angle ?? 0
      }deg at ${centerCss}${interpolationCss}, ${stopsCss})`;
    }
    if (g.kind !== "radial") {
      throw new Error(`cssGradientImage: unknown gradient kind "${g.kind}"`);
    }
    const shapeCss = g.shape ?? "ellipse";
    // css-images-3's <radial-size> grammar: an EXPLICIT circle takes a
    // single <length> (not a pair) — `circle 60px 60px` is invalid CSS and
    // Chrome silently drops the whole declaration on a parse failure
    // (found exactly this way: an explicit-circle demo scene rendered a
    // real gradient in sandom but a completely BLANK box in Chrome — not
    // an engine bug, a CSS syntax mistake in this emission code). An
    // explicit ellipse still takes the rx/ry pair.
    const sizeCss = Array.isArray(g.size)
      ? (g.shape === "circle"
        ? cssSize(g.size[0])
        : `${cssSize(g.size[0])} ${cssSize(g.size[1] ?? g.size[0])}`)
      : (g.size ?? "farthest-corner");
    return `${repeatingPrefix}radial-gradient(${shapeCss} ${sizeCss} at ${centerCss}${interpolationCss}, ${stopsCss})`;
  }

  function nodeCss(n) {
    if (SVG_SHAPE_DISPLAY_NAMES_CSS.has(n.display)) return "";
    const d = [];
    d.push("box-sizing:" + (n.boxSizing === 1 ? "border-box" : "content-box"));
    // n.bfc is a BFC-establishment-only test knob (Chrome has no "BFC but
    // don't clip" property, so overflow:hidden is the trigger either way);
    // n.overflow:'hidden' (Slice P1) is the real, visually-clipping case —
    // see chrome-oracle.js's matching nodeCss comment for the full reasoning.
    if (n.bfc) d.push("overflow:hidden");
    else if (n.overflow !== undefined) d.push(`overflow:${n.overflow}`);
    // clip-path (P9): real CSS basic-shape syntax for the Chrome-oracle
    // side, from the same scene fields writeClipPath encodes for the
    // engine. Value formatting: numbers are px, strings ('50%',
    // 'closest-side', 'farthest-side') pass through verbatim.
    if (n.clipPath) {
      const cp = n.clipPath;
      const len = (v) => (typeof v === "number" ? `${v}px` : v);
      if (cp.kind === "inset") {
        let inset = `inset(${len(cp.top ?? 0)} ${len(cp.right ?? 0)} ${
          len(cp.bottom ?? 0)
        } ${len(cp.left ?? 0)}`;
        const corners = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
        const cornerRadii = corners.map((corner) => {
          const v = cp.radii ? (cp.radii[corner] ?? 0) : (cp.radius ?? 0);
          return typeof v === "object"
            ? { rx: v.rx ?? 0, ry: v.ry ?? 0 }
            : { rx: v, ry: v };
        });
        if (cornerRadii.some((r) => r.rx > 0 || r.ry > 0)) {
          const anyElliptical = cornerRadii.some((r) => r.rx !== r.ry);
          inset += anyElliptical
            ? ` round ${cornerRadii.map((r) => `${r.rx}px`).join(" ")} / ${
              cornerRadii.map((r) => `${r.ry}px`).join(" ")
            }`
            : ` round ${cornerRadii.map((r) => `${r.rx}px`).join(" ")}`;
        }
        d.push(`clip-path:${inset})`);
      } else if (cp.kind === "circle") {
        d.push(
          `clip-path:circle(${len(cp.r ?? "closest-side")} at ${
            len(cp.cx ?? "50%")
          } ${len(cp.cy ?? "50%")})`,
        );
      } else if (cp.kind === "ellipse") {
        d.push(
          `clip-path:ellipse(${len(cp.rx ?? "closest-side")} ${
            len(cp.ry ?? "closest-side")
          } at ${len(cp.cx ?? "50%")} ${len(cp.cy ?? "50%")})`,
        );
      } else if (cp.kind === "polygon") {
        const fillRule = cp.fillRule === "evenodd" ? "evenodd, " : "";
        const points = cp.points.map(([x, y]) => `${len(x)} ${len(y)}`).join(
          ", ",
        );
        d.push(`clip-path:polygon(${fillRule}${points})`);
      } else if (cp.kind === "path") {
        const fillRule = cp.fillRule === "evenodd" ? "evenodd, " : "";
        d.push(`clip-path:path(${fillRule}"${cp.d.replaceAll('"', '\\"')}")`);
      }
    }
    // Text declarations (Slice 6; multi-family since T4). font-family MUST
    // match the font sandom shapes with (the registry maps the node's
    // fontFamily key to the same test-assets file both sides use) for the
    // pixel/box comparison to mean anything; the gallery/pixel-test harness
    // is responsible for loading the matching @font-face for the Chrome
    // side (fontFaceCss in test/fixtures/font-registry.js).
    if (
      n.display === "text" || n.display === "inline" ||
      n.display === "inline-block" || n.inlineCtx
    ) {
      d.push(
        `font-family:${
          fontFamilyCssValue(
            n.fontFamily ?? fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0],
          )
        }`,
      );
      d.push(`font-size:${n.fontSize ?? DEFAULT_FONT_SIZE}px`);
      d.push(`font-weight:${fontWeightInCssUnits(n.fontWeight)}`);
      d.push(`font-style:${n.fontStyle ?? "normal"}`);
      d.push(`text-align:${n.textAlign ?? "left"}`);
      d.push(`text-decoration:${n.textDecoration ?? "none"}`);
      d.push(`text-overflow:${n.textOverflow ?? "clip"}`);
      if (n.verticalAlign !== undefined) {
        const verticalAlign = typeof n.verticalAlign === "object"
          ? `${n.verticalAlign.px}px`
          : n.verticalAlign;
        d.push(`vertical-align:${verticalAlign}`);
      }
      // Text color defaults to opaque black (CSS initial), NOT transparent —
      // mirrors writeNode's same special case for NODE_TEXT_COLOR.
      d.push("color:" + rgba(n.color || { r: 0, g: 0, b: 0, a: 1 }));
      const lh = n.lineHeight;
      if (lh === undefined || lh === "normal") d.push("line-height:normal");
      else if (typeof lh === "number") d.push(`line-height:${lh}`);
      else if (typeof lh === "object" && typeof lh.px === "number") {
        d.push(`line-height:${lh.px}px`);
      }
    }
    // An inline-block renders as a <span> (renderNode), whose own display
    // is inline: it needs the declaration to be an atomic inline.
    if (n.display === "inline-block") d.push("display:inline-block");
    if (
      typeof n.display === "string" &&
      (n.display === "table" || n.display === "inline-table" ||
        n.display.startsWith("table-"))
    ) {
      d.push(`display:${n.display}`);
      if (n.tableLayout !== undefined) d.push(`table-layout:${n.tableLayout}`);
      if (n.borderCollapse !== undefined) {
        d.push(`border-collapse:${n.borderCollapse}`);
      }
      if (n.borderSpacing !== undefined) {
        const spacing = Array.isArray(n.borderSpacing)
          ? n.borderSpacing
          : [n.borderSpacing];
        d.push(
          `border-spacing:${spacing.map((value) => `${value}px`).join(" ")}`,
        );
      }
      if (n.captionSide !== undefined) d.push(`caption-side:${n.captionSide}`);
      if (n.emptyCells !== undefined) d.push(`empty-cells:${n.emptyCells}`);
    }
    // Flex container declarations.
    if (n.display === "flex" || n.display === "inline-flex") {
      d.push(`display:${n.display}`);
      if (n.flexDirection) d.push(`flex-direction:${n.flexDirection}`);
      if (n.justifyContent) d.push(`justify-content:${n.justifyContent}`);
      if (n.alignItems) d.push(`align-items:${n.alignItems}`);
      if (n.flexWrap) d.push(`flex-wrap:${n.flexWrap}`);
      if (n.gap !== undefined) d.push(`gap:${n.gap}px`);
      if (n.rowGap !== undefined) d.push(`row-gap:${n.rowGap}px`);
      if (n.columnGap !== undefined) d.push(`column-gap:${n.columnGap}px`);
    }
    if (n.display === "grid" || n.display === "inline-grid") {
      d.push(`display:${n.display}`);
      d.push(
        `grid-template-columns:${
          Array.isArray(n.gridTemplateColumns)
            ? n.gridTemplateColumns.map(gridTrackCss).join(" ")
            : n.gridTemplateColumns || "none"
        }`,
      );
      d.push(
        `grid-template-rows:${
          Array.isArray(n.gridTemplateRows)
            ? n.gridTemplateRows.map(gridTrackCss).join(" ")
            : n.gridTemplateRows || "none"
        }`,
      );
      if (n.gridTemplateAreas !== undefined) {
        d.push(
          `grid-template-areas:${
            n.gridTemplateAreas.map((row) => `"${row}"`).join(" ")
          }`,
        );
      }
      if (n.gridAutoColumns !== undefined) {
        d.push(`grid-auto-columns:${gridTrackCss(n.gridAutoColumns)}`);
      }
      if (n.gridAutoRows !== undefined) {
        d.push(`grid-auto-rows:${gridTrackCss(n.gridAutoRows)}`);
      }
      if (n.gridAutoFlow !== undefined) {
        d.push(`grid-auto-flow:${n.gridAutoFlow}`);
      }
      if (n.gap !== undefined) d.push(`gap:${cssSize(n.gap)}`);
      if (n.rowGap !== undefined) d.push(`row-gap:${cssSize(n.rowGap)}`);
      if (n.columnGap !== undefined) {
        d.push(`column-gap:${cssSize(n.columnGap)}`);
      }
      if (n.alignItems !== undefined) d.push(`align-items:${n.alignItems}`);
      if (n.justifyItems !== undefined) {
        d.push(`justify-items:${n.justifyItems}`);
      }
      if (n.alignContent !== undefined) {
        d.push(`align-content:${n.alignContent}`);
      }
      if (n.justifyContent !== undefined) {
        d.push(`justify-content:${n.justifyContent}`);
      }
    }
    // Flex item declarations (only meaningful when parent is flex; harmless else).
    if (n.flexGrow !== undefined) d.push(`flex-grow:${n.flexGrow}`);
    if (n.flexShrink !== undefined) d.push(`flex-shrink:${n.flexShrink}`);
    if (n.flexBasis !== undefined) d.push(`flex-basis:${cssSize(n.flexBasis)}`);
    if (n.alignSelf !== undefined) d.push(`align-self:${n.alignSelf}`);
    if (n.order !== undefined) d.push(`order:${n.order}`);
    if (n.gridRowStart !== undefined) {
      d.push(`grid-row-start:${n.gridRowStart}`);
    }
    if (n.gridRowEnd !== undefined) d.push(`grid-row-end:${n.gridRowEnd}`);
    if (n.gridColumnStart !== undefined) {
      d.push(`grid-column-start:${n.gridColumnStart}`);
    }
    if (n.gridColumnEnd !== undefined) {
      d.push(`grid-column-end:${n.gridColumnEnd}`);
    }
    if (n.gridArea !== undefined) d.push(`grid-area:${n.gridArea}`);
    if (n.justifySelf !== undefined) d.push(`justify-self:${n.justifySelf}`);
    // float / clear (design/floats.md). floatByte/clearByte validate
    // the same values writeNode accepts, so oracle HTML can never diverge
    // from what the engine side was given.
    if (n.float !== undefined) {
      floatByte(n.float);
      d.push(`float:${n.float}`);
    }
    if (n.clear !== undefined) {
      clearByte(n.clear);
      d.push(`clear:${n.clear}`);
    }
    d.push("width:" + cssSize(n.width));
    d.push("height:" + cssSize(n.height));
    if (n.aspectRatio !== undefined) d.push(`aspect-ratio:${n.aspectRatio}`);
    if (n.minWidth !== undefined) d.push("min-width:" + cssSize(n.minWidth));
    if (n.minHeight !== undefined) d.push("min-height:" + cssSize(n.minHeight));
    if (n.maxWidth !== undefined) d.push("max-width:" + cssSize(n.maxWidth));
    if (n.maxHeight !== undefined) d.push("max-height:" + cssSize(n.maxHeight));
    const m = n.margin || {};
    d.push(
      "margin-top:" + (n.marginTop === "auto" ? "auto" : `${m.top || 0}px`),
    );
    d.push(
      "margin-bottom:" +
        (n.marginBottom === "auto" ? "auto" : `${m.bottom || 0}px`),
    );
    d.push(
      "margin-left:" + (n.marginLeft === "auto" ? "auto" : `${m.left || 0}px`),
    );
    d.push(
      "margin-right:" +
        (n.marginRight === "auto" ? "auto" : `${m.right || 0}px`),
    );
    const p = n.padding || {};
    d.push(
      `padding:${p.top || 0}px ${p.right || 0}px ${p.bottom || 0}px ${
        p.left || 0
      }px`,
    );
    const b = n.border;
    d.push(`border-style:${typeof n.borderStyle === "string" ? n.borderStyle :
      `${n.borderStyle.top} ${n.borderStyle.right} ${n.borderStyle.bottom} ${n.borderStyle.left}`}`);
    d.push(
      `border-width:${b.top || 0}px ${b.right || 0}px ${b.bottom || 0}px ${
        b.left || 0
      }px`,
    );
    const nodeBorderColors = n.borderColor;
    d.push(
      `border-color:${rgba(nodeBorderColors.top)} ${
        rgba(nodeBorderColors.right)
      } ${rgba(nodeBorderColors.bottom)} ${rgba(nodeBorderColors.left)}`,
    );
    if (n.borderRadius !== undefined) {
      const nodeRadii = n.borderRadius;
      const corners = [
        nodeRadii.topLeft,
        nodeRadii.topRight,
        nodeRadii.bottomRight,
        nodeRadii.bottomLeft,
      ];
      // A negative component is the percentage encoding (see cornerRxRy):
      // emit the CSS percentage form for the oracle.
      const radiusCss = (component) =>
        component < 0 ? `${-component}%` : `${component}px`;
      const xValues = corners.map((c) => radiusCss(c.rx)).join(" ");
      // P10: only emit the CSS `/` elliptical syntax when a corner is
      // actually elliptical (rx!==ry) — keeps existing circular-only scenes'
      // generated CSS unchanged (easier to read/diff).
      const isElliptical = corners.some((c) => c.rx !== c.ry);
      d.push(
        isElliptical
          ? `border-radius:${xValues} / ${
            corners.map((c) => radiusCss(c.ry)).join(" ")
          }`
          : `border-radius:${xValues}`,
      );
    }
    d.push("background:" + rgba(n.bg));
    // background-clip / background-origin: emitted whenever set so the
    // Chrome oracle sees the same value the engine reads (background-clip
    // was never emitted here before — P10's own tests were pixel asserts,
    // not oracle comparisons, so the gap never surfaced). Defaults need no
    // emission: Chrome's initial values (clip border-box, origin
    // padding-box) match the engine's zeroed-struct behavior.
    if (n.backgroundClip !== undefined) {
      d.push(`background-clip:${n.backgroundClip}`);
    }
    if (n.backgroundOrigin !== undefined) {
      d.push(`background-origin:${n.backgroundOrigin}`);
    }
    // P4 (gradients): CSS's background-image is INDEPENDENT of background-
    // color (the `background:` shorthand above only ever set the color, per
    // rgba(n.bg) — a plain color function, not a gradient-aware one), so
    // this is a separate declaration, matching real CSS layering.
    // Only the FUSED case here — once the gradient lowers into the layer
    // list, nodeCssBackgroundImages emits it as one entry of a single
    // comma-separated background-image, which is the only way the ordering
    // between it and the other layers can be expressed at all.
    if (n.backgroundGradient && !backgroundLayerList(n)) {
      d.push(`background-image:${cssGradientImage(n.backgroundGradient)}`);
    }
    // box-shadow (P3): CSS shorthand order is [inset] offsetX offsetY
    // [blur] [spread] color — offsetX/offsetY/blur/spread are ALL required
    // positionally even when 0 (CSS's own grammar has no way to omit blur
    // while supplying spread), same plain-px-number convention as this
    // scene DSL's other length fields (no unit suffixes needed for box-
    // shadow's own length values). List order is preserved AS-IS (this
    // scene DSL's own array order === CSS's comma-separated list order,
    // per writeShadows' own doc comment on index 0 = first-listed).
    if (n.boxShadows?.length) {
      const shadowsCss = n.boxShadows.map((s) =>
        `${s.inset ? "inset " : ""}${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${
          s.blur ?? 0
        }px ${s.spread ?? 0}px ${rgba(s.color)}`
      ).join(", ");
      d.push(`box-shadow:${shadowsCss}`);
    }
    // text-shadow (P6): same list-order preservation as box-shadow above.
    if (n.textShadows?.length) {
      const textShadowsCss = n.textShadows.map((sh) =>
        `${sh.offsetX ?? 0}px ${sh.offsetY ?? 0}px ${sh.blur ?? 0}px ${
          rgba(sh.color || { r: 0, g: 0, b: 0, a: 1 })
        }`
      ).join(", ");
      d.push(`text-shadow:${textShadowsCss}`);
    }
    // filter (P8) / backdrop-filter (P8b): see filterListCss's own comment
    // for the CSS mapping rules.
    if (n.filter?.length) {
      d.push(`filter:${filterListCss(n.filter)}`);
    }
    // backdrop-filter (P8b): SAME CSS function-list grammar as filter (see
    // filterListCss's own comment) — the only difference is which property
    // it lands on.
    if (n.backdropFilter?.length) {
      d.push(`backdrop-filter:${filterListCss(n.backdropFilter)}`);
    }
    if (n.position === 1) d.push("position:relative");
    if (n.position === 2) d.push("position:absolute");
    if (n.position === 3) d.push("position:fixed");
    if (n.zIndex !== undefined) d.push(`z-index:${n.zIndex}`);
    for (const side of ["top", "right", "bottom", "left"]) {
      if (n[side] !== undefined) d.push(`${side}:${cssSize(n[side])}`);
    }
    if (n.opacity !== undefined) d.push(`opacity:${n.opacity}`);
    if (n.transform !== undefined) {
      const [a, b, c, dd, e, f] = n.transform;
      d.push(`transform:matrix(${a},${b},${c},${dd},${e},${f})`);
    }
    if (n.blendMode !== undefined) d.push(`mix-blend-mode:${n.blendMode}`);
    if (n.display === "image") {
      d.push(`object-fit:${n.objectFit ?? "fill"}`);
      const [posX, posY] = n.objectPosition ?? ["50%", "50%"];
      d.push(
        `object-position:${typeof posX === "number" ? posX + "px" : posX} ${
          typeof posY === "number" ? posY + "px" : posY
        }`,
      );
    }
    if (n.imageRendering !== undefined) {
      d.push(`image-rendering:${n.imageRendering}`);
    }
    return d.join(";");
  }

  // Minimal HTML-escaping for text node content — the only characters that
  // can break attribute/element parsing in the plain-text positions this
  // content is inserted into.
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  // background-image CSS (Slice P5c) — separate from nodeCss (which stays
  // synchronous) since the src->data:URI conversion is async, same reason
  // <img>'s src attribute is built inside sceneHtml's own async renderNode
  // rather than nodeCss. CSS list order matches node.backgroundImages'
  // own order directly (unlike the WAT/pool side, which reverses it for
  // paint order — CSS's own multi-background syntax is authored top-first
  // too, so no reordering is needed here).
  async function nodeCssBackgroundImages(n, readImage) {
    // The SAME effective list the pool gets, so the two sides cannot
    // disagree about whether a backgroundGradient is fused or a layer. When
    // it fuses, nodeCss already emitted it as its own background-image
    // declaration and this returns '' — the two paths are mutually
    // exclusive by construction, which also fixes the pre-existing case
    // where both emitted `background-image` and the second silently won.
    const layers = backgroundLayerList(n);
    if (!layers) return "";
    const d = [];
    const images = [],
      sizes = [],
      positions = [],
      repeats = [],
      blendModes = [];
    for (const layer of layers) {
      if (layer.src) images.push(`url(${await imageDataUri(layer.src, readImage)})`);
      else if (layer.gradient) images.push(cssGradientImage(layer.gradient));
      else images.push("none");
      const [sizeW, sizeH] = layer.size ?? ["auto", "auto"];
      if (sizeW === "cover" || sizeW === "contain") sizes.push(sizeW);
      else sizes.push(`${cssSize(sizeW)} ${cssSize(sizeH)}`);
      const [posX, posY] = layer.position ?? ["0%", "0%"];
      positions.push(`${cssSize(posX)} ${cssSize(posY)}`);
      const [repeatX, repeatY] = layer.repeat ?? ["repeat", "repeat"];
      repeats.push(repeatX === repeatY ? repeatX : `${repeatX} ${repeatY}`);
      blendModes.push(layer.blendMode ?? "normal");
    }
    d.push(`background-image:${images.join(",")}`);
    d.push(`background-size:${sizes.join(",")}`);
    d.push(`background-position:${positions.join(",")}`);
    d.push(`background-repeat:${repeats.join(",")}`);
    if (blendModes.some((m) => m !== "normal")) {
      d.push(`background-blend-mode:${blendModes.join(",")}`);
    }
    return d.join(";");
  }

  // border-image CSS (P14) — async for the same src->data:URI reason as
  // nodeCssBackgroundImages above, and emitted as LONGHANDS for the same
  // reason nodeCssMasks does: sandom consumes resolved style values, so
  // there is no shorthand parser under test, and longhands keep every edge
  // value explicit in the oracle CSS.
  //
  // The value forms have to round-trip EXACTLY as authored, because that is
  // the whole comparison: a bare `4` in border-image-width means four times
  // the border-width, while `4px` is a length — emitting one as the other
  // would make the oracle agree with a different feature.
  async function nodeCssBorderImage(n, readImage) {
    if (!n.borderImage || !n.borderImage.src) return "";
    const spec = n.borderImage;
    const d = [`border-image-source:url(${await imageDataUri(spec.src, readImage)})`];

    const sliceQuad = edgeQuad(spec.slice, 100);
    // CSS orders the slice shorthand top/right/bottom/left, same as our quad.
    d.push(
      `border-image-slice:${sliceQuad.join(" ")}${spec.fill ? " fill" : ""}`,
    );

    const widthQuad = edgeQuad(spec.width, 1);
    d.push(`border-image-width:${widthQuad.join(" ")}`);

    const outsetQuad = edgeQuad(spec.outset, 0);
    d.push(`border-image-outset:${outsetQuad.join(" ")}`);

    const [repeatX, repeatY] = Array.isArray(spec.repeat)
      ? (spec.repeat.length === 1
        ? [spec.repeat[0], spec.repeat[0]]
        : spec.repeat)
      : [spec.repeat ?? "stretch", spec.repeat ?? "stretch"];
    d.push(`border-image-repeat:${repeatX} ${repeatY}`);

    return d.join(";");
  }

  // mask CSS (P11) — async for the same src->data:URI reason as
  // nodeCssBackgroundImages above, and emitted as LONGHANDS rather than the
  // `mask` shorthand: sandom consumes resolved style values, so there is no
  // shorthand parser under test here, and longhands keep each per-layer
  // list explicit in the oracle CSS. List order matches node.masks
  // directly (the pool side reverses; CSS is authored top-first).
  // Unprefixed only: the oracle Chrome implements the css-masking-1
  // longhands natively, and adding -webkit- aliases would only risk a
  // differently-parsed keyword set silently overriding them.
  async function nodeCssMasks(n, readImage) {
    if (!n.masks || !n.masks.length) return "";
    const images = [], sizes = [], positions = [], repeats = [];
    const modes = [], origins = [], clips = [], composites = [];
    for (const layer of n.masks) {
      if (layer.src) images.push(`url(${await imageDataUri(layer.src, readImage)})`);
      else if (layer.gradient) images.push(cssGradientImage(layer.gradient));
      else images.push("none");
      const [sizeW, sizeH] = layer.size ?? ["auto", "auto"];
      if (sizeW === "cover" || sizeW === "contain") sizes.push(sizeW);
      else sizes.push(`${cssSize(sizeW)} ${cssSize(sizeH)}`);
      const [posX, posY] = layer.position ?? ["0%", "0%"];
      positions.push(`${cssSize(posX)} ${cssSize(posY)}`);
      const [repeatX, repeatY] = layer.repeat ?? ["repeat", "repeat"];
      repeats.push(repeatX === repeatY ? repeatX : `${repeatX} ${repeatY}`);
      modes.push(layer.mode ?? "match-source");
      origins.push(layer.origin ?? "border-box");
      clips.push(layer.clip ?? "border-box");
      composites.push(layer.composite ?? "add");
    }
    return [
      `mask-image:${images.join(",")}`,
      `mask-size:${sizes.join(",")}`,
      `mask-position:${positions.join(",")}`,
      `mask-repeat:${repeats.join(",")}`,
      `mask-mode:${modes.join(",")}`,
      `mask-origin:${origins.join(",")}`,
      `mask-clip:${clips.join(",")}`,
      `mask-composite:${composites.join(",")}`,
    ].join(";");
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

  async function sceneHtmlPrepared(scene, readImage) {
    const cssRules = await Promise.all(scene.nodes.map(async (n, i) => {
      const extra = [
        await nodeCssBackgroundImages(n, readImage),
        await nodeCssMasks(n, readImage),
        await nodeCssBorderImage(n, readImage),
      ].filter(Boolean);
      return `.s${scene.id}-n${i}{${
        [nodeCss(n), ...extra].filter(Boolean).join(";")
      }}`;
    }));
    const css = cssRules.join("\n");
    // preserveAspectRatio: the DSL value is an SVG preserveAspectRatio
    // attribute value, passed through unchanged ('xMidYMid meet' when the
    // attribute is omitted).
    // Plain length-or-percent resolver against a basis (JS-side port of
    // engine.wat's own $resolveLength, needed here since gradient <defs>
    // markup is generated in JS at oracle-build time, not resolved by the
    // engine at emission time — same numeric contract, just a different
    // caller).
    function resolveLengthOrPercent(spec, basis) {
      if (typeof spec === "number") return spec;
      if (typeof spec === "string" && spec.endsWith("%")) {
        return parseFloat(spec) / 100 * basis;
      }
      throw new Error(`resolveLengthOrPercent: bad spec "${spec}"`);
    }

    // JS port of engine.wat's $resolveRadialGradientGeometry — same 4
    // extent-keyword formulas (including the closest-corner/farthest-corner
    // closed-form ellipse-radii derivation css-images-3 deliberately leaves
    // unspecified, derived from scratch and verified numerically when
    // FIRST written for the engine — see that function's own comment in
    // engine.wat for the derivation/verification detail; ported verbatim
    // here rather than re-derived a second time).
    // cx/cy: center relative to the shape's own top-left (NOT absolute
    // page coordinates) — matches $resolveRadialGradientGeometry's own
    // (cx,cy) parameter meaning.
    function resolveRadialEndingShapeJs(cx, cy, shape, sizeSpec, w, h) {
      if (Array.isArray(sizeSpec)) {
        return { rx: sizeSpec[0] ?? 0, ry: sizeSpec[1] ?? sizeSpec[0] ?? 0 };
      }
      const sizeKeyword = sizeSpec ?? "farthest-corner";
      const left = cx, right = w - cx, top = cy, bottom = h - cy;
      const isCircle = shape === "circle";
      if (sizeKeyword === "closest-side") {
        if (isCircle) {
          const r = Math.min(left, right, top, bottom);
          return { rx: r, ry: r };
        }
        return { rx: Math.min(left, right), ry: Math.min(top, bottom) };
      }
      if (sizeKeyword === "farthest-side") {
        if (isCircle) {
          const r = Math.max(left, right, top, bottom);
          return { rx: r, ry: r };
        }
        return { rx: Math.max(left, right), ry: Math.max(top, bottom) };
      }
      const closest = sizeKeyword === "closest-corner";
      const cornerL = closest ? Math.min(left, right) : Math.max(left, right);
      const cornerV = closest ? Math.min(top, bottom) : Math.max(top, bottom);
      const ratioRx = cornerL, ratioRy = cornerV;
      if (isCircle) {
        const r = Math.sqrt(cornerL * cornerL + cornerV * cornerV);
        return { rx: r, ry: r };
      }
      if (ratioRx === 0) return { rx: 0, ry: cornerV };
      const ry = Math.sqrt(
        cornerV * cornerV + (cornerL * ratioRy / ratioRx) ** 2,
      );
      const rx = ry * (ratioRx / ratioRy);
      return { rx, ry };
    }

    // Gradient <defs> accumulator (SVG gradients) — NOT shared closure
    // state (a prior version used one shared array + counter for the whole
    // sceneHtml() call, which raced: renderNode recurses through
    // Promise.all, so TWO SIBLING svg roots' subtrees run concurrently, and
    // whichever root's own "read svgGradientDefs.length" line happened to
    // run AFTER the other root's shape already pushed its own gradient
    // would silently print the WRONG root's gradients into its own <defs>
    // — found via a live-browser-tab visual review showing genuinely wrong
    // gradient POSITIONS/colors per shape, not a display/color-profile
    // difference as first suspected). Each svg root now creates its OWN
    // fresh accumulator array (see the 'svg' root branch below) and passes
    // it down through renderNode/svgFillAttr/svgGradientDef explicitly —
    // sibling svg roots' concurrent subtrees can never see each other's
    // pushes. svgGradientIdCounter stays a single shared per-sceneHtml()
    // counter (harmless to race on a plain increment for uniqueness
    // purposes only — worst case two ids interleave differently across
    // runs, never producing a COLLISION or cross-contaminating which
    // gradient markup lands in which root's own accumulator array).
    let svgGradientIdCounter = 0;
    const svgGradientIdPrefix = String(scene.id ?? "scene").replace(
      /[^A-Za-z0-9_-]/g,
      "-",
    );

    // Convert this scene DSL's {kind,angle,center,shape,size,stops} shape
    // (the SAME object shape CSS's own backgroundGradient uses — see
    // writeGradientStops' own comment) into a REAL SVG gradient element,
    // in userSpaceOnUse coordinates so the resolved geometry EXACTLY
    // matches what $resolveLinearGradientGeometry/$resolveRadialGradient
    // Geometry compute in engine.wat (verified numerically before writing
    // this: userSpaceOnUse reproduces css-images-3's own w/h-dependent
    // gradient-length formula exactly; objectBoundingBox's unit-square
    // normalization would visibly DISTORT a non-square shape's gradient
    // direction/length, since it flattens aspect ratio away).
    // shapeX/Y/W/H: the shape's own resolved bounding box in the SAME
    // user-space coordinates its own geometry attributes use (e.g. a rect's
    // x/y/width/height, or a circle's cx-r/cy-r/2r/2r). defsAccumulator:
    // THIS shape's own enclosing svg root's private array (see the 'svg'
    // root branch below) — pushed into directly, never the shared
    // svgGradientDefs closure this function used before the sibling-race
    // fix (see that variable's own removal comment above).
    function svgGradientDef(
      gradient,
      shapeX,
      shapeY,
      shapeW,
      shapeH,
      defsAccumulator,
    ) {
      const id =
        `sandom-${svgGradientIdPrefix}-svg-grad-${svgGradientIdCounter++}`;
      const stopsMarkup = gradient.stops.map((s) => {
        const c = col(s.color);
        return `<stop offset="${(s.position ?? 0) * 100}%" stop-color="rgb(${
          Math.round(c.r * 255)
        },${Math.round(c.g * 255)},${
          Math.round(c.b * 255)
        })" stop-opacity="${c.a}"></stop>`;
      }).join("");
      if (gradient.kind === "linear") {
        // Same direction+length formula this project's own
        // $resolveLinearGradientGeometry implements (css-images-3 SS3.1,
        // 0deg=up/clockwise convention) — see that function's own doc
        // comment in engine.wat for the derivation/verification.
        const rad = (gradient.angle ?? 0) * Math.PI / 180;
        const dx = Math.sin(rad), dy = -Math.cos(rad);
        const length = Math.abs(shapeW * Math.sin(rad)) +
          Math.abs(shapeH * Math.cos(rad));
        const cx = shapeX + shapeW / 2, cy = shapeY + shapeH / 2;
        const halfLen = length / 2;
        const x1 = cx - dx * halfLen, y1 = cy - dy * halfLen;
        const x2 = cx + dx * halfLen, y2 = cy + dy * halfLen;
        defsAccumulator.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsMarkup}</linearGradient>`,
        );
      } else if (gradient.kind === "radial") {
        // SVG's native <radialGradient> is CIRCULAR ONLY (cx/cy/r, no rx/ry
        // — confirmed via direct spec research before assuming otherwise:
        // SVG has no elliptical radial-gradient attribute at all). An
        // elliptical shape gets a non-uniform gradientTransform scale
        // instead — center the transform's own scale on the gradient's
        // OWN center point (a plain scale from origin would also shift
        // the center, which a translate-scale-translate-back fold avoids).
        const [centerXSpec, centerYSpec] = gradient.center ?? ["50%", "50%"];
        const cx = shapeX + resolveLengthOrPercent(centerXSpec, shapeW);
        const cy = shapeY + resolveLengthOrPercent(centerYSpec, shapeH);
        // Ending-shape radii: reuse this project's OWN already-verified
        // radial-geometry resolution (writeGradientStops' sibling function
        // resolveRadialEndingShape, extracted below) rather than
        // re-deriving the 4 extent-keyword formulas a second time here.
        const { rx, ry } = resolveRadialEndingShapeJs(
          cx - shapeX,
          cy - shapeY,
          gradient.shape ?? "ellipse",
          gradient.size,
          shapeW,
          shapeH,
        );
        const isCircle = Math.abs(rx - ry) < 1e-4;
        const transformAttr = isCircle
          ? ""
          : ` gradientTransform="translate(${cx} ${cy}) scale(1 ${
            ry / rx
          }) translate(${-cx} ${-cy})"`;
        const r = isCircle ? rx : rx; // the (pre-transform) circle radius is rx either way — ry comes from the non-uniform Y scale
        defsAccumulator.push(
          `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"${transformAttr}>${stopsMarkup}</radialGradient>`,
        );
      }
      return id;
    }

    function svgFillAttr(
      fill,
      gradient,
      shapeX,
      shapeY,
      shapeW,
      shapeH,
      defsAccumulator,
    ) {
      if (gradient) {
        const id = svgGradientDef(
          gradient,
          shapeX,
          shapeY,
          shapeW,
          shapeH,
          defsAccumulator,
        );
        return ` fill="url(#${id})"`;
      }
      if (fill === undefined) return ""; // SVG default fill is black — omitting the attribute IS the default.
      if (fill === "none") return ' fill="none"';
      return ` fill="${rgba(fill)}"`;
    }
    // stroke (S3): SVG default is 'none' — omitting the attribute IS the
    // default, same convention as svgFillAttr above. strokeWidth similarly
    // omits when unset (SVG default is 1, but only meaningful with a stroke).
    // A svgStrokeGradient paints url(#…) of a gradient over gradientBox, the
    // box the engine resolves the stroke's gradient against: the fill
    // path's, as SVG's object bounding box excludes the stroke.
    function svgStrokeAttrs(n, gradientBox, defsAccumulator) {
      let paint;
      if (n.svgStrokeGradient && gradientBox) {
        paint = `url(#${
          svgGradientDef(n.svgStrokeGradient, ...gradientBox, defsAccumulator)
        })`;
      } else if (n.stroke === undefined || n.stroke === "none") {
        return "";
      } else {
        paint = rgba(n.stroke);
      }
      const widthAttr = n.strokeWidth !== undefined
        ? ` stroke-width="${n.strokeWidth}"`
        : "";
      const dashAttr = n.strokeDasharray && n.strokeDasharray.length
        ? ` stroke-dasharray="${n.strokeDasharray.join(",")}"`
        : "";
      const dashOffsetAttr = n.strokeDashoffset !== undefined
        ? ` stroke-dashoffset="${n.strokeDashoffset}"`
        : "";
      return ` stroke="${paint}"${widthAttr}${dashAttr}${dashOffsetAttr}`;
    }
    // Native path bounds in author coordinates.
    function loweredGradientBox(n) {
      const bbox = n.resolvedPathBbox;
      if (bbox === undefined) return null;
      return [bbox.xMin, bbox.yMin, bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin];
    }
    // defsAccumulator (S7): null outside any svg root's subtree (the
    // overwhelmingly common case — text/image/flex/block nodes never touch
    // it); set to a FRESH array by the 'svg' root branch below, then
    // threaded through this same parameter to every descendant's own
    // recursive renderNode call, so sibling svg roots' concurrent subtrees
    // (Promise.all runs them interleaved, not sequentially) each only ever
    // see their OWN gradients, never a sibling's — see the accumulator
    // variable's own removal comment above for the race this replaces.
    async function renderNode(i, defsAccumulator = null) {
      const n = scene.nodes[i];
      if (n.display === "text") {
        return `<div class="s${scene.id}-n${i}">${
          escapeHtml(n.text ?? "")
        }</div>`;
      }
      if (n.display === "image") {
        const src = n.src ? await imageDataUri(n.src, readImage) : "";
        return `<img class="s${scene.id}-n${i}" src="${src}">`;
      }
      // svg root (design/svg-rendering.md): a real <svg> element — width/height/
      // viewBox/preserveAspectRatio are genuine SVG attributes (also styled
      // via nodeCss's ordinary width/height CSS declarations, since CSS
      // sizing DOES apply to <svg> as a replaced element — both are present
      // and Chrome reconciles them per the replaced-element sizing spec,
      // same as sandom's own engine does).
      if (n.display === "svg") {
        // Each viewport owns the gradients of its descendant shapes.
        const ownDefsAccumulator = [];
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, ownDefsAccumulator)
        ))).join("");
        const attrs = [`class="s${scene.id}-n${i}"`];
        const nested = defsAccumulator !== null;
        if (nested) {
          attrs.push('style="transform:none"');
          if (n.width !== undefined) attrs.push(`width="${n.width}"`);
          if (n.height !== undefined) attrs.push(`height="${n.height}"`);
        }
        if (n.viewBox) {
          attrs.push(`viewBox="${n.viewBox.join(" ")}"`);
        }
        if (n.preserveAspectRatio) {
          attrs.push(`preserveAspectRatio="${n.preserveAspectRatio}"`);
        }
        // S7: any gradient fills collected from descendant shapes (rendered
        // before this line via the recursive renderNode above) need a real
        // <defs> host — SVG resolves url(#id) references anywhere in the
        // document, but <defs> is the conventional non-rendering container.
        const defsMarkup = ownDefsAccumulator.length
          ? `<defs>${ownDefsAccumulator.join("")}</defs>`
          : "";
        const markup = `<svg ${attrs.join(" ")}>${defsMarkup}${kids}</svg>`;
        return nested && n.transform
          ? `<g transform="matrix(${n.transform.join(" ")})">${markup}</g>`
          : markup;
      }
      // Native group rows carry their resolved affine and expanded children.
      if (n.display === "svg-group") {
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ))).join("");
        const transformAttr = n.transform !== undefined
          ? (() => {
            const [a, b, c, dd, e, f] = n.transform;
            return ` transform="matrix(${a} ${b} ${c} ${dd} ${e} ${f})"`;
          })()
          : "";
        return `<g class="s${scene.id}-n${i}"${transformAttr}>${kids}</g>`;
      }
      // Native SVG geometry uses SVG presentation attributes.
      if (n.display === "svg-circle") {
        const r = n.r ?? 0;
        const box = await loweredGradientBox(n) ??
          [(n.cx ?? 0) - r, (n.cy ?? 0) - r, 2 * r, 2 * r];
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          ...box,
          defsAccumulator,
        );
        return `<circle id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" cx="${
          n.cx ?? 0
        }" cy="${n.cy ?? 0}" r="${r}"${fillAttr}${
          svgStrokeAttrs(n, box, defsAccumulator)
        }></circle>`;
      }
      if (n.display === "svg-ellipse") {
        const rx = n.rx ?? 0, ry = n.ry ?? 0;
        const box = await loweredGradientBox(n) ??
          [(n.cx ?? 0) - rx, (n.cy ?? 0) - ry, 2 * rx, 2 * ry];
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          ...box,
          defsAccumulator,
        );
        return `<ellipse id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" cx="${
          n.cx ?? 0
        }" cy="${n.cy ?? 0}" rx="${rx}" ry="${ry}"${fillAttr}${
          svgStrokeAttrs(n, box, defsAccumulator)
        }></ellipse>`;
      }
      if (n.display === "svg-rect") {
        const rxAttr = n.rx !== undefined ? ` rx="${n.rx}"` : "";
        const ryAttr = n.ry !== undefined ? ` ry="${n.ry}"` : "";
        const box = await loweredGradientBox(n) ??
          [n.x ?? 0, n.y ?? 0, n.width ?? 0, n.height ?? 0];
        const fillAttr = svgFillAttr(
          n.fill,
          n.svgFillGradient,
          ...box,
          defsAccumulator,
        );
        return `<rect id="s${scene.id}-n${i}" class="s${scene.id}-n${i}" x="${
          n.x ?? 0
        }" y="${n.y ?? 0}" width="${n.width ?? 0}" height="${
          n.height ?? 0
        }"${rxAttr}${ryAttr}${fillAttr}${
          svgStrokeAttrs(n, box, defsAccumulator)
        }></rect>`;
      }
      if (n.display === "svg-line") {
        // line (S3) has no fill attribute at all — SVG semantics, zero area
        // unstroked (see writeSvgShape's own comment). stroke-linecap
        // defaults to 'butt' when unset, same as sandom's own LINE_CAP default.
        const capAttr = n.strokeLinecap !== undefined
          ? ` stroke-linecap="${n.strokeLinecap}"`
          : "";
        return `<line class="s${scene.id}-n${i}" x1="${n.x1 ?? 0}" y1="${
          n.y1 ?? 0
        }" x2="${n.x2 ?? 0}" y2="${n.y2 ?? 0}"${
          svgStrokeAttrs(n, await loweredGradientBox(n), defsAccumulator)
        }${capAttr}></line>`;
      }
      if (n.display === "svg-path") {
        // S4 (Tier B): the `d` string passes through UNCHANGED — same string
        // sandom's own MSDF pipeline parses via buildShapeFromSvgPath, so
        // Chrome and sandom render literally the same path definition.
        const fillRuleAttr = n.fillRule === "evenodd"
          ? ` fill-rule="evenodd"`
          : "";
        // S7 step 2: a gradient fill or stroke needs the path's own bounding
        // box (the SAME space $writeGradientExtension resolves geom0..3
        // against in engine.wat — see writeSvgShape's own bbox-warmup
        // comment). Only computed when actually needed — a plain color/none
        // paint (the overwhelmingly common case) skips this extra msdfgen
        // round-trip entirely, same "don't pay for what you don't use"
        // discipline as resolveSvgPathIndices' own stroke-bbox branch.
        let box = null;
        if (n.svgFillGradient || n.svgStrokeGradient) {
          const bbox = n.resolvedPathBbox;
          box = [bbox.xMin, bbox.yMin, bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin];
        }
        const fillAttr = n.svgFillGradient
          ? svgFillAttr(n.fill, n.svgFillGradient, ...box, defsAccumulator)
          : svgFillAttr(n.fill);
        const capAttr = n.strokeLinecap === undefined
          ? "" : ` stroke-linecap="${n.strokeLinecap}"`;
        const joinAttr = n.strokeLinejoin === undefined
          ? "" : ` stroke-linejoin="${n.strokeLinejoin}"`;
        return `<path class="s${scene.id}-n${i}" d="${
          n.d ?? ""
        }"${fillRuleAttr}${fillAttr}${
          svgStrokeAttrs(n, box, defsAccumulator)
        }${capAttr}${joinAttr}></path>`;
      }
      // design/inline-layout.md: an inlineCtx:true container's DISPLAY_TEXT/
      // DISPLAY_INLINE children render as real inline <span>s sharing this
      // DIV's own line boxes — NOT independent block-level <div>s (the
      // ordinary display:'text' branch above, correct for a BARE leaf, is
      // wrong here: it would give Chrome N separate one-line paragraphs
      // instead of one paragraph with N runs). No whitespace between
      // sibling <span> tags in the generated markup — an accidental
      // newline/indent there would be a MARKUP-level space Chrome's own
      // whitespace collapsing would then fold in, not a real content space;
      // callers wanting a real inter-item space put it INSIDE an item's own
      // text (matching sandomInlineFragmentRects' own convention).
      // An inline-block (display:inline-block in nodeCss) and an inline box
      // hold their text children as inline <span>s, as an inlineCtx
      // container does: an inline-block lays its text out as its own
      // inline content.
      if (n.display === "inline-block" || n.display === "inline") {
        const kids =
          (await Promise.all((n.children || []).map((childIndex) => {
            const child = scene.nodes[childIndex];
            if (child.display === "text") {
              return `<span class="s${scene.id}-n${childIndex}">${
                escapeHtml(child.text ?? "")
              }</span>`;
            }
            return renderNode(childIndex, defsAccumulator);
          }))).join("");
        return `<span class="s${scene.id}-n${i}">${kids}</span>`;
      }
      if (n.inlineCtx) {
        const kids =
          (await Promise.all((n.children || []).map((childIndex) => {
            const child = scene.nodes[childIndex];
            if (child.display === "text") {
              return `<span class="s${scene.id}-n${childIndex}">${
                escapeHtml(child.text ?? "")
              }</span>`;
            }
            return renderNode(childIndex, defsAccumulator);
          }))).join("");
        return `<div class="s${scene.id}-n${i}">${kids}</div>`;
      }
      const kids = (await Promise.all(
        (n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ),
      )).join("");
      return `<div class="s${scene.id}-n${i}">${kids}</div>`;
    }
    return { css, html: await renderNode(0) };
  }

  // Scale every length-valued field in a node by `scale`. Percentages, auto,
  // and dimensionless ratios (flexGrow/flexShrink, alignSelf) pass through.
  // Mirrors test/oracle/sandom-layout.js's scaleNode so a spec written for the
  // layout oracle works here too. The scale parameter encodes Blink's
  // LayoutZoomFactor — see test/oracle/README.md for the full model:
  // Blink lays out in PHYSICAL LU (1/64 of a physical pixel). We match by
  // pre-scaling all input lengths so the engine sees physical-pixel inputs,
  // then rasterizing at the matching device resolution.
  function scaleLen(v, s) {
    if (v === undefined || v === "auto") return v;
    if (typeof v === "number") return v * s;
    return v; // 'min-content' / 'max-content' / 'NN%' pass through
  }
  function scaleEdges(e, s) {
    if (!e) return e;
    return {
      top: (e.top || 0) * s,
      right: (e.right || 0) * s,
      bottom: (e.bottom || 0) * s,
      left: (e.left || 0) * s,
    };
  }

  // A gradient's own px lengths, pre-scaled for deviceScale: `center`, an
  // explicit radial `size: [rx, ry]`, and the `pixels` length of a stop. An
  // angle and a stop's `position` (a 0..1 fraction) are
  // resolution-independent, and the extent KEYWORDS resolve against the
  // box at emission time.
  function scaleGradient(gradient, s) {
    return {
      ...gradient,
      ...(gradient.center
        ? { center: gradient.center.map((v) => scaleLen(v, s)) }
        : {}),
      ...(Array.isArray(gradient.size)
        ? { size: gradient.size.map((v) => scaleLen(v, s)) }
        : {}),
      ...(gradient.stops?.some((stop) => stop.pixels !== undefined)
        ? {
          stops: gradient.stops.map((stop) =>
            stop.pixels === undefined ? stop : { ...stop, pixels: stop.pixels * s }
          ),
        }
        : {}),
    };
  }

  function scaleNode(node, s) {
    if (s === 1) return node;
    const out = { ...node };
    for (
      const k of [
        "width",
        "height",
        "minWidth",
        "minHeight",
        "maxWidth",
        "maxHeight",
        "top",
        "right",
        "bottom",
        "left",
        "fontSize",
        "letterSpacing",
        "scrollTop",
        "scrollLeft",
      ]
    ) {
      if (k in node) out[k] = scaleLen(node[k], s);
    }
    // SVG shape geometry: x/y (svg-rect),
    // cx/cy/r (svg-circle), cx/cy/rx/ry (svg-ellipse, and svg-rect's own
    // rounded-corner rx/ry), x1/y1/x2/y2 (svg-line) — all plain numbers in
    // the shape's own user-unit space (1 unit = 1 CSS px when no viewBox is
    // set, same convention svg-rect's width/height already scale under via
    // the generic length-field loop above). These fields are exclusive to
    // SVG shape nodes (confirmed: no other display kind reads x/y/cx/cy/r/
    // rx/ry/x1/y1/x2/y2), so scaling them unconditionally here is safe.
    // Mirrors clipPath's own cx/cy/r/rx/ry scaling a few lines below —
    // same field names, same "user-space geometry tracks deviceScale"
    // requirement, just for the shape's own top-level fields instead of a
    // nested clipPath object.
    for (
      const k of ["x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2"]
    ) {
      if (typeof node[k] === "number") out[k] = node[k] * s;
    }
    if (typeof node.svgTextX === "number") out.svgTextX = node.svgTextX * s;
    if (typeof node.svgTextY === "number") out.svgTextY = node.svgTextY * s;
    // SVG stroke fields: a follow-on
    // to the geometry fix above, found via a real stroke gallery scene —
    // that fix's own regression test used fill-only shapes and never
    // exercised a stroke, missing this. strokeWidth/strokeDashoffset are
    // plain numbers; strokeDasharray is an ARRAY of numbers, each scaled
    // individually (same "map over each entry" shape boxShadows/
    // textShadows already use elsewhere in this function).
    if (typeof node.strokeWidth === "number") {
      out.strokeWidth = node.strokeWidth * s;
    }
    if (typeof node.strokeDashoffset === "number") {
      out.strokeDashoffset = node.strokeDashoffset * s;
    }
    if (Array.isArray(node.strokeDasharray)) {
      out.strokeDasharray = node.strokeDasharray.map((v) => v * s);
    }
    // viewBox (design/svg-rendering.md invariant 2): all four entries
    // are author-unit lengths (minX/minY included — they're offsets in the
    // same user-unit space, not just width/height) and must pre-scale like
    // every other length field, so $computeViewBoxTransform's affine (built
    // from the root's DEVICE-px content box over this array) stays
    // deviceScale-free: (s*viewport)/(s*viewBox) = viewport/viewBox, applied
    // to s*geometry = correct.
    if (Array.isArray(node.viewBox)) {
      out.viewBox = node.viewBox.map((v) => v * s);
    }
    if ("margin" in node) out.margin = scaleEdges(node.margin, s);
    if ("padding" in node) out.padding = scaleEdges(node.padding, s);
    if ("border" in node) out.border = scaleEdges(node.border, s);
    if (typeof node.borderSpacing === "number") {
      out.borderSpacing = node.borderSpacing * s;
    } else if (Array.isArray(node.borderSpacing)) {
      out.borderSpacing = node.borderSpacing.map((value) => value * s);
    }
    for (const property of ["gridTemplateColumns", "gridTemplateRows"]) {
      if (!(property in node)) continue;
      out[property] = Array.isArray(node[property])
        ? node[property].map((track) => scaleGridTrack(track, s))
        : scaleGridTrack(node[property], s);
    }
    if ("gridAutoColumns" in node) {
      out.gridAutoColumns = scaleGridTrack(node.gridAutoColumns, s);
    }
    if ("gridAutoRows" in node) {
      out.gridAutoRows = scaleGridTrack(node.gridAutoRows, s);
    }
    // border-image (P14): only the LENGTH forms scale to physical px.
    //
    // `slice` never does — it is source-image space, and the source does not
    // grow with deviceScale. Bare numbers in `width`/`outset` never do
    // either: they are multiples of border-width, which has already been
    // scaled on the line above, so scaling them again would square the
    // factor. Percentages resolve against the (already physical) border box.
    // Only an explicit 'Npx' is a length in CSS px that must become physical.
    if (node.borderImage) {
      const scalePx = (
        v,
      ) => (typeof v === "string" && v.endsWith("px")
        ? `${parseFloat(v) * s}px`
        : v);
      const scaleQuad = (q) => (Array.isArray(q) ? q.map(scalePx) : scalePx(q));
      const bi = { ...node.borderImage };
      if ("width" in bi) bi.width = scaleQuad(bi.width);
      if ("outset" in bi) bi.outset = scaleQuad(bi.outset);
      out.borderImage = bi;
    }
    if ("borderRadius" in node) {
      const r = node.borderRadius;
      // Percentages ("50%" strings and the negative encoded form) are
      // scale-invariant: pass them through untouched.
      if (typeof r === "number") {
        out.borderRadius = r >= 0 ? r * s : r;
      } else if (typeof r === "string") {
        out.borderRadius = r;
      } else if (typeof r === "object" && r !== null) {
        const isPerCorner = "topLeft" in r || "topRight" in r ||
          "bottomRight" in r || "bottomLeft" in r;
        if (isPerCorner) {
          // Per-corner form (Slice P2) — a corner is either a plain length or,
          // as of P10, an elliptical {rx,ry} pair.
          out.borderRadius = {};
          for (
            const corner of ["topLeft", "topRight", "bottomRight", "bottomLeft"]
          ) {
            const v = r[corner];
            if (v === undefined) continue;
            const scaleComponent = (value) =>
              typeof value === "string" || value < 0 ? value : value * s;
            out.borderRadius[corner] = typeof v === "object"
              ? { rx: scaleComponent(v.rx || 0), ry: scaleComponent(v.ry || 0) }
              : scaleComponent(v);
          }
        } else {
          // P10 uniform-ellipse shorthand: {rx,ry} with no corner keys.
          out.borderRadius = {
            rx: typeof r.rx === "string" || r.rx < 0 ? r.rx : (r.rx || 0) * s,
            ry: typeof r.ry === "string" || r.ry < 0 ? r.ry : (r.ry || 0) * s,
          };
        }
      }
    }
    // textShadows (P6): offsets and blur are lengths.
    if ("textShadows" in node) {
      out.textShadows = node.textShadows.map((sh) => ({
        ...sh,
        offsetX: (sh.offsetX ?? 0) * s,
        offsetY: (sh.offsetY ?? 0) * s,
        blur: (sh.blur ?? 0) * s,
      }));
    }
    // boxShadows (P3): offsets, blur, and spread are all lengths.
    if ("boxShadows" in node) {
      out.boxShadows = node.boxShadows.map((sh) => ({
        ...sh,
        offsetX: (sh.offsetX ?? 0) * s,
        offsetY: (sh.offsetY ?? 0) * s,

        blur: (sh.blur ?? 0) * s,
        spread: (sh.spread ?? 0) * s,
      }));
    }
    // outline (P10): width and offset are lengths.
    if ("outline" in node) {
      out.outline = {
        ...node.outline,
        ...(typeof node.outline.width === "number"
          ? { width: node.outline.width * s }
          : {}),
        ...(typeof node.outline.offset === "number"
          ? { offset: node.outline.offset * s }
          : {}),
      };
    }
    // objectPosition (P5b): only the LENGTH form (a plain number) is a real
    // length needing pre-scaling; a percent string is resolution-independent.
    if ("objectPosition" in node) {
      out.objectPosition = node.objectPosition.map((v) => scaleLen(v, s));
    }
    // Background/mask LAYERS: each layer's size/position can independently
    // mix length and percent forms (e.g. size:[40,'auto']) — same
    // per-value scaleLen treatment as objectPosition above, applied
    // per-layer. 'cover'/'contain'/'auto' keywords pass through scaleLen
    // unchanged (its own guard only touches actual numbers).
    const scaleLayer = (layer) => ({
      ...layer,
      ...(layer.size ? { size: layer.size.map((v) => scaleLen(v, s)) } : {}),
      ...(layer.position
        ? { position: layer.position.map((v) => scaleLen(v, s)) }
        : {}),
      ...(layer.gradient ? { gradient: scaleGradient(layer.gradient, s) } : {}),
    });
    if ("backgroundImages" in node) {
      out.backgroundImages = node.backgroundImages.map(scaleLayer);
    }
    if ("masks" in node) out.masks = node.masks.map(scaleLayer);
    // A gradient's OWN px lengths (a radial `center: [40, '50%']`, an
    // explicit `size: [30, 20]`) are CSS px like any other length and must
    // pre-scale too. This was a live P4 gap for backgroundGradient — px
    // centers rendered at half position at deviceScale 2, unnoticed because
    // percent forms, the common case, are resolution-independent. It stops
    // being merely a gap once a backgroundGradient can LOWER into a layer
    // (backgroundLayerList): the same declaration would otherwise scale
    // differently depending on whether an unrelated sibling layer exists.
    if (node.backgroundGradient) {
      out.backgroundGradient = scaleGradient(node.backgroundGradient, s);
    }
    if (node.svgFillGradient) {
      out.svgFillGradient = scaleGradient(node.svgFillGradient, s);
    }
    if (node.svgStrokeGradient) {
      out.svgStrokeGradient = scaleGradient(node.svgStrokeGradient, s);
    }
    // clipPath (P9): numbers are px lengths (pre-scale like every other
    // length); percent strings and closest/farthest-side keywords are
    // resolution-independent and pass through. radius/radii mirror
    // borderRadius's own px-only scaling above.
    if ("clipPath" in node && node.clipPath) {
      const clipPath = { ...node.clipPath };
      for (
        const key of [
          "top",
          "right",
          "bottom",
          "left",
          "cx",
          "cy",
          "r",
          "rx",
          "ry",
        ]
      ) {
        if (typeof clipPath[key] === "number") {
          clipPath[key] = clipPath[key] * s;
        }
      }
      if (clipPath.kind === "polygon" && Array.isArray(clipPath.points)) {
        clipPath.points = clipPath.points.map(([x, y]) => [
          typeof x === "number" ? x * s : x,
          typeof y === "number" ? y * s : y,
        ]);
      }
      if (clipPath.kind === "path" && typeof clipPath.d === "string") {
        const tokens = clipPath.d.match(
          /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g,
        ) ?? [];
        const parameterCounts = {
          M: 2,
          L: 2,
          H: 1,
          V: 1,
          C: 6,
          S: 4,
          Q: 4,
          T: 2,
          A: 7,
          Z: 0,
        };
        let currentCommand = null;
        let parameterIndex = 0;
        clipPath.d = tokens.map((token) => {
          if (/^[a-zA-Z]$/.test(token)) {
            currentCommand = token.toUpperCase();
            parameterIndex = 0;
            return token;
          }
          if (!currentCommand || !(currentCommand in parameterCounts)) {
            throw new Error(
              `clipPath path: unsupported SVG path command near ${
                JSON.stringify(token)
              }`,
            );
          }
          const unscaledArcParameter = currentCommand === "A" &&
            (parameterIndex === 2 || parameterIndex === 3 ||
              parameterIndex === 4);
          const result = unscaledArcParameter
            ? Number(token)
            : Number(token) * s;
          parameterIndex = (parameterIndex + 1) %
            parameterCounts[currentCommand];
          return String(result);
        }).join(" ");
      }
      if (typeof clipPath.radius === "number") {
        clipPath.radius = clipPath.radius * s;
      }
      if (clipPath.radii) {
        const radii = {};
        for (
          const corner of ["topLeft", "topRight", "bottomRight", "bottomLeft"]
        ) {
          const v = clipPath.radii[corner];
          if (v === undefined) continue;
          radii[corner] = typeof v === "object"
            ? { rx: (v.rx || 0) * s, ry: (v.ry || 0) * s }
            : v * s;
        }
        clipPath.radii = radii;
      }
      out.clipPath = clipPath;
    }
    if ("gap" in node) {
      out.gap = typeof node.gap === "number"
        ? node.gap * s
        : node.gap && typeof node.gap === "object" &&
            Number.isFinite(node.gap.pixels) &&
            Number.isFinite(node.gap.percentage)
        ? { ...node.gap, pixels: node.gap.pixels * s }
        : node.gap;
    }
    if ("rowGap" in node) {
      out.rowGap = typeof node.rowGap === "number"
        ? node.rowGap * s
        : node.rowGap && typeof node.rowGap === "object" &&
            Number.isFinite(node.rowGap.pixels) &&
            Number.isFinite(node.rowGap.percentage)
        ? { ...node.rowGap, pixels: node.rowGap.pixels * s }
        : node.rowGap;
    }
    if ("columnGap" in node) {
      out.columnGap = typeof node.columnGap === "number"
        ? node.columnGap * s
        : node.columnGap && typeof node.columnGap === "object" &&
            Number.isFinite(node.columnGap.pixels) &&
            Number.isFinite(node.columnGap.percentage)
        ? { ...node.columnGap, pixels: node.columnGap.pixels * s }
        : node.columnGap;
    }
    if ("flexBasis" in node && typeof node.flexBasis === "number") {
      out.flexBasis = node.flexBasis * s;
    }
    // lineHeight: a unitless number (CSS line-height:1.5) must NOT scale (it's
    // a ratio against fontSize, already scaled) — only the explicit LENGTH
    // form ({px: N}) is a real length needing the same pre-scaling.
    if (
      "lineHeight" in node && typeof node.lineHeight === "object" &&
      typeof node.lineHeight.px === "number"
    ) {
      out.lineHeight = { px: node.lineHeight.px * s };
    }
    if (
      "verticalAlign" in node && typeof node.verticalAlign === "object" &&
      typeof node.verticalAlign.px === "number"
    ) {
      out.verticalAlign = { px: node.verticalAlign.px * s };
    }
    // transform (Slice 8B): only the TRANSLATION component is a length (needs
    // the same physical-px pre-scaling every other length field gets);
    // rotate (degrees) and scale (a dimensionless ratio) must NOT scale —
    // scaling them would make a Retina render's fan/rotation look different
    // from a 1x render of the identical CSS, which is wrong (found via a
    // real gallery bug: node.transform wasn't touched here at all, so at
    // deviceScale 2 the translate offset landed at half its intended CSS-px
    // distance, visibly compressing the whole composition toward center).
    if ("transform" in node) {
      const t = node.transform;
      if (t.kind === "cssTransform") {
        const scaleLengthPercentage = (length) => ({
          ...length,
          pixels: (length.pixels ?? 0) * s,
        });
        out.transform = {
          ...t,
          components: t.components.map((component) => {
            if (component.kind === "translate") {
              return {
                ...component,
                x: scaleLengthPercentage(component.x),
                y: scaleLengthPercentage(component.y),
              };
            }
            if (
              component.kind === "translateX" || component.kind === "translateY"
            ) {
              return {
                ...component,
                value: scaleLengthPercentage(component.value),
              };
            }
            if (component.kind === "matrix") {
              return {
                ...component,
                value: component.value.map((entry, index) =>
                  index >= 4 ? entry * s : entry
                ),
              };
            }
            return component;
          }),
        };
        if (node.transformOrigin) {
          out.transformOrigin = {
            ...node.transformOrigin,
            x: scaleLengthPercentage(node.transformOrigin.x),
            y: scaleLengthPercentage(node.transformOrigin.y),
          };
        }
      } else if (Array.isArray(t)) {
        out.transform = [t[0], t[1], t[2], t[3], t[4] * s, t[5] * s];
      } else {
        out.transform = { ...t };
        if (t.translate) {
          out.transform.translate = {
            x: (t.translate.x ?? 0) * s,
            y: (t.translate.y ?? 0) * s,
          };
        }
      }
    }
    return out;
  }

  // Emits the commands of one page of the rows the engine holds: `page` is
  // { height, index, rulesKey, box } (renderScenePixelsNow's page option).
  // The engine records every page's start while it counts the pages. A
  // later emission of the same rows, size and fonts seeks the page it
  // shows; any other counts the pages again. A row write takes a new
  // claim. An animation sample takes none, and stamps the rows whose layout
  // it changes with the current generation: the newest row generation, with
  // the engine epoch, names those changes. The engine advances the header
  // generation at every sample, also when no row changes, so the header
  // generation is not a key. Returns the command bytes, the page count, the
  // page shown (the requested one, or the last page when the document is
  // shorter) and the scene indices of the nodes on other pages.
  function emitPageCommands(scene, nodes, page, writeOwner) {
    let rowGeneration = 0;
    for (let index = 0; index < nodes.length; index++) {
      const generation = view.getUint32(
        layoutBufferBase + index * LAYOUT_NODE_SIZE + LAYOUT_NODE_OFFSET_CHANGED_GEN,
        true,
      );
      if (generation > rowGeneration) rowGeneration = generation;
    }
    const pageKey = [
      writeOwner, engineWriteClaims.get(engine.memory), nodes.length,
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
      // Pages counted so far in each page group, by its element.
      const groupPages = new Map();
      pageCount = 0;
      engine.exports.page_begin(page.height);
      do {
        const index = pages.length;
        const nameId = engine.exports.page_name();
        // The page groups the page is in (CSS Generated Content for Paged
        // Media 3, 3.2), outermost first: each group's name and the page's
        // position in it, from 1.
        const groups = [];
        const groupCount = engine.exports.page_group_count();
        for (let group = 0; group < groupCount; group++) {
          const element = engine.exports.page_group_node(group);
          const position = (groupPages.get(element) ?? 0) + 1;
          groupPages.set(element, position);
          groups.push({ name: core.string("page_name_text", engine.exports.page_group_name(group)), position });
        }
        const description = {
          index,
          name: nameId === 0 ? "" : core.string("page_name_text", nameId),
          side: index % 2 === 0 ? "right" : "left",
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
        pageCount++;
      } while (engine.exports.page_advance());
      pagedLayoutRecord = { key: pageKey, count: pageCount, pages, serial: engine.exports.page_record_serial() };
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
    engineWriteOwner?.resample();
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
    if (generationReservation && !generationReservation.consumed) {
      generationReservation.consumed = true;
      const currentGeneration = view.getUint32(
        HEADER_BASE + HEADER_OFFSET_GENERATION,
        true,
      );
      const drifted = generationReservation.published
        ? currentGeneration !== generationReservation.generation
        : currentGeneration + 1 !== generationReservation.generation;
      if (drifted) {
        // A QUERY emit interleaved between the reservation and this
        // write: synchronous layout getters can barge into the awaits of
        // an async analytical pass on the shared engine, advancing the
        // generation and overwriting the pre-stamped analytical state.
        // The reservation's prediction is stale, not corrupt — re-derive
        // it: advance to a fresh generation and re-stamp the analytical
        // baseline with the ACTUAL number. The full node write below
        // rebuilds everything else from the caller's own scene.
        sceneGeneration = engine.exports.advance_generation() >>> 0;
        stampAnalyticalState(generationReservation.nodeCount, sceneGeneration);
      } else if (generationReservation.published) {
        sceneGeneration = generationReservation.generation;
      } else {
        sceneGeneration = engine.exports.advance_generation() >>> 0;
        if (sceneGeneration !== generationReservation.generation) {
          throw new Error(
            `Prepared analytical generation ${generationReservation.generation} ` +
              `advanced to ${sceneGeneration}`,
          );
        }
      }
    } else {
      sceneGeneration = engine.exports.advance_generation() >>> 0;
    }
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
              (forceGenerationNodeIndices?.has(index) ? 1 : 0) |
                (scrollOnlyNodeIndices?.has(index) ? 2 : 0), true);
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

  // The grid the engine marks damage in (layout.js TILE_CONFIG_*): the
  // raster target's 64 device px tiles, or a coarser multiple of 64 when
  // that grid holds more tiles than the dirty map has bits. Returns the
  // tile side in device px.
  function writeTileGrid(scene, deviceWidth, deviceHeight, deviceScale, visibleRectangle) {
    let tileSize = 64;
    while (
      Math.ceil(deviceWidth / tileSize) * Math.ceil(deviceHeight / tileSize) >
        TILE_DIRTY_MAP_SIZE * 8
    ) tileSize *= 2;
    view.setUint32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_TILE_SIZE, tileSize, true);
    view.setUint32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_COLUMNS, Math.ceil(deviceWidth / tileSize), true);
    view.setUint32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_ROWS, Math.ceil(deviceHeight / tileSize), true);
    view.setUint32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_FRAME_WIDTH, scene.width, true);
    view.setUint32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_FRAME_HEIGHT, scene.height, true);
    view.setFloat32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_DEVICE_SCALE, deviceScale, true);
    view.setFloat32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_ORIGIN_X, visibleRectangle?.x ?? 0, true);
    view.setFloat32(TILE_CONFIG_BASE + TILE_CONFIG_OFFSET_ORIGIN_Y, visibleRectangle?.y ?? 0, true);
    return tileSize;
  }

  // Layout getters use registered resources without waiting for host effects.
  function emitSceneCommandsSync(
    scene,
    { layoutNodeCapacity = Infinity, commitTextRunKeys, discardCommands = false, engineWriteOwner = null, captureNodeMarkers = false, textGeometry = false } = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
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
    engineWriteOwner?.resample();
    prepareLayoutSvgGeometry(nodes.length, scene.width, scene.height);
    if (!emitPaintCommands) {
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return { view: null, bytesWritten: 0, nodes, globalPreparation };
    }
    engine.exports.set_paint_artifact_capture(captureNodeMarkers ? 1 : 0);
    // QUERY emit — same contract as emitSceneCommands above. A text
    // geometry query also lists hidden text and gives the spaces a line
    // end removes no advance (set_query_text_geometry).
    engine.exports.set_query_emit(1);
    engine.exports.set_query_text_geometry(textGeometry ? 1 : 0);
    let bytesWritten;
    try {
      bytesWritten = engine.exports.emit_commands(nodes.length);
    } finally {
      engine.exports.set_query_emit(0);
      engine.exports.set_query_text_geometry(0);
    }
    if (discardCommands) {
      return { view: null, bytesWritten, nodes, globalPreparation };
    }
    const commandBase = engine.exports.command_buffer_base();
    const copy = engine.memory.buffer.slice(commandBase, commandBase + bytesWritten);
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
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

  function resetAnalyticalLayoutState(nodeCount, inheritRetained = false) {
    const currentGeneration = view.getUint32(
      HEADER_BASE + HEADER_OFFSET_GENERATION,
      true,
    );
    const generationReservation = currentGeneration === 0xFFFF_FFFF
      ? {
        generation: engine.exports.advance_generation() >>> 0,
        published: true,
        consumed: false,
        nodeCount,
      }
      : {
        generation: currentGeneration + 1,
        published: false,
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
    return finishAnalyticalWrite(scene, analytical, written);
  }

  // A synchronous layout with the text geometry of every text node it lays
  // out (CSSOM View Range.getClientRects, caretPositionFromPoint): the
  // boxes, as layoutTreeBoxesSync gives them, and one operation per text
  // command of a query emit that lists hidden text and skipped contents
  // and gives the spaces a line end removes no advance
  // (set_query_text_geometry). An operation holds the source node index of
  // its text (`nodeIndex`), in scroll space as the geometry records hold
  // their boxes (no scroll container's offset; a reader adds the scroll of
  // the text's record), its line box (`lineTop`, `lineHeight`), its text box on the
  // line (`textTop`, `textHeight`: from the baseline less the ascent of the
  // node's primary font to the baseline plus its descent), whether its
  // glyphs run right to left (`rtl`), and its glyphs in visual order:
  // `x`, `width`, and the authored UTF-8 byte range `start`, `end` of the
  // cluster (the prepared run's mapping of its cluster bounds).
  function layoutTextGeometrySync(scene, options = {}) {
    const analytical = analyticalWriteOptions(scene, options);
    const written = emitSceneCommandsSync(
      scene,
      {
        ...options,
        ...(analytical.inherited ? { commitTextRunKeys: true } : {}),
        captureNodeMarkers: true,
        textGeometry: true,
      },
      analytical.generationReservation,
      true,
    );
    const commandView = written.view;
    const glyphBase = engine.exports.glyph_buffer_base();
    const glyphView = new DataView(
      engine.memory.buffer.slice(glyphBase, glyphBase + engine.exports.glyph_bytes()),
    );
    const textRuns = currentTextBatch.copyRuns();
    const textOperations = [];
    let emittedNode = null;
    for (let offset = 0; offset < written.bytesWritten;) {
      const opcode = commandView.getUint8(offset);
      if (opcode === CMD_SET_NODE) {
        emittedNode = commandView.getUint32(offset + CMD_SET_NODE_OFFSET_INDEX, true);
      } else if (
        opcode === CMD_TEXT &&
        (commandView.getUint8(offset + CMD_TEXT_OFFSET_FLAGS) & CMD_TEXT_FLAG_TEXT_SHADOW) === 0
      ) {
        if (emittedNode === null) {
          throw new Error(`text geometry: the text command at byte ${offset} has no node marker before it`);
        }
        const glyphCount = commandView.getUint16(offset + CMD_TEXT_OFFSET_GCOUNT, true);
        const glyphOffset = commandView.getUint32(offset + CMD_TEXT_OFFSET_GOFF, true);
        const run = textRuns[emittedNode];
        if (!run && glyphCount > 0) {
          throw new Error(
            `text geometry: the text command at byte ${offset} under node ${emittedNode} has glyphs, but the node carries no prepared text run`,
          );
        }
        // The query emit's glyph entries hold px ($queryTextGeometry).
        const x = commandView.getFloat32(offset + CMD_TEXT_OFFSET_X, true);
        const lineTop = commandView.getFloat32(offset + CMD_TEXT_OFFSET_Y, true);
        const glyphs = new Array(glyphCount);
        for (let index = 0; index < glyphCount; index++) {
          const entry = glyphOffset + index * GLYPH_ENTRY_SIZE;
          glyphs[index] = Object.freeze({
            x: x + glyphView.getFloat32(entry + GLYPH_OFFSET_X_OFFSET, true),
            width: glyphView.getFloat32(entry + GLYPH_OFFSET_X_ADVANCE, true),
            start: run.mapping[glyphView.getUint32(entry + GLYPH_OFFSET_CLUSTER_START, true)],
            end: run.mapping[glyphView.getUint32(entry + GLYPH_OFFSET_CLUSTER_END, true)],
          });
        }
        const ascent = engine.exports.text_font_extent(emittedNode, 0);
        const descent = engine.exports.text_font_extent(emittedNode, 1);
        const baseline = lineTop + commandView.getFloat32(offset + CMD_TEXT_OFFSET_BL, true);
        textOperations.push(Object.freeze({
          nodeIndex: run?.sourceId ?? written.nodes[emittedNode]?._inspectionSourceNodeIndex ?? emittedNode,
          lineTop,
          lineHeight: commandView.getFloat32(offset + CMD_TEXT_OFFSET_LH, true),
          textTop: baseline - ascent,
          textHeight: ascent + descent,
          rtl: glyphCount > 1 && glyphs[0].start > glyphs[glyphCount - 1].start,
          glyphs: Object.freeze(glyphs),
        }));
      }
      offset += commandByteSize(commandView, offset);
    }
    const boxes = finishAnalyticalWrite(scene, analytical, written);
    return { boxes, textOperations };
  }

  // Canvas 2D text (src/dom/canvas-2d-text.js). Lays `scene` out alone, as
  // a standalone analytical layout does, and returns what the engine shaped
  // for each of its text nodes `textNodes`: each glyph in logical order with
  // its face, its advance in font units, its cluster, its bidi level byte
  // and whether it is a synthesized small capital, the primary face of the
  // first node, and the size of that node's synthesized small capitals.
  // The engine shapes canvas text as it shapes CSS text: font stack,
  // fallback faces, bidi levels over all the nodes, features,
  // letter-spacing; it shapes each node on its own. The faces carry what
  // glyph atlases and font metrics need; one face object stands for a font
  // index for the runtime's life.
  const standaloneTextFaces = new Map();
  function shapeStandaloneTextSync(scene, textNodes) {
    const analytical = analyticalWriteOptions(scene, {});
    emitSceneCommandsSync(scene, {}, analytical.generationReservation, false);
    syncLayoutWrite = null;
    const faces = standaloneTextFaces;
    const face = (fontIndex) => {
      let described = faces.get(fontIndex);
      if (described !== undefined && described.bytes !== registeredFontBytes(fontIndex)) described = undefined;
      if (described !== undefined) return described;
      const entry = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
      const subdividedUpem = view.getUint32(entry + FONT_TABLE_OFFSET_UPEM, true);
      described = Object.freeze({
        fontIndex,
        bytes: registeredFontBytes(fontIndex),
        faceIndex: fontIdentityForDocument(fontIndex, 0n).faceIndex,
        weight: view.getUint16(entry + FONT_TABLE_OFFSET_WEIGHT, true),
        variationWidth: fontVariationWidth(fontIndex),
        variationSlant: fontVariationSlant(fontIndex),
        italic: view.getUint32(entry + FONT_TABLE_OFFSET_ITALIC, true) !== 0,
        upem: subdividedUpem / FONT_UNIT_SUBDIVISION,
        subdividedUpem,
        ascender: view.getInt32(entry + FONT_TABLE_OFFSET_ASCENDER, true),
        descender: view.getInt32(entry + FONT_TABLE_OFFSET_DESCENDER, true),
        lineGap: view.getInt32(entry + FONT_TABLE_OFFSET_LINE_GAP, true),
      });
      faces.set(fontIndex, described);
      return described;
    };
    const shapedNodes = textNodes.map((textNode) => {
      const run = textRunDirBase + textNode * TEXT_RUN_ENTRY_SIZE;
      const glyphBase = view.getUint32(run + TEXT_RUN_OFFSET_GLYPH_OFFSET, true);
      const glyphCount = view.getUint16(run + TEXT_RUN_OFFSET_GLYPH_COUNT, true);
      const glyphs = new Array(glyphCount);
      for (let index = 0; index < glyphCount; index++) {
        const glyph = glyphBase + index * SHAPED_GLYPH_ENTRY_SIZE;
        const flags = view.getUint16(glyph + SHAPED_GLYPH_OFFSET_FLAGS, true);
        glyphs[index] = {
          id: view.getUint16(glyph + SHAPED_GLYPH_OFFSET_ID, true),
          advance: view.getInt32(glyph + SHAPED_GLYPH_OFFSET_X_ADVANCE, true),
          unscaledAdvance: view.getInt32(glyph + SHAPED_GLYPH_OFFSET_UNSCALED_ADVANCE, true),
          cluster: view.getUint32(glyph + SHAPED_GLYPH_OFFSET_CLUSTER_START, true),
          level: flags >>> 8,
          face: face(view.getUint16(glyph + SHAPED_GLYPH_OFFSET_FONT, true) & SHAPED_GLYPH_FONT_INDEX),
          synthesized: (view.getUint16(glyph + SHAPED_GLYPH_OFFSET_FONT, true) & SHAPED_GLYPH_FONT_SYNTHESIZED) !== 0,
        };
      }
      return glyphs;
    });
    const firstNode = layoutBufferBase + textNodes[0] * LAYOUT_NODE_SIZE;
    const primary = face(nodePrimaryFontIndex(firstNode));
    const synthesizedSize = engine.exports.caps_synthesized_size(
      view.getFloat32(firstNode + LAYOUT_NODE_OFFSET_FONT_SIZE, true),
    );
    return { nodes: shapedNodes, primary, synthesizedSize };
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

  function edgeValue(node, group, side) {
    return node?.[group]?.[side] ?? 0;
  }

  function expandedBox(box, top, right, bottom, left) {
    return {
      x: box.x - left,
      y: box.y - top,
      width: box.width + left + right,
      height: box.height + top + bottom,
    };
  }

  // The primary face of a node, as the engine's $nodePrimaryFont reads it:
  // the loaded font of the primary slot of a stack with unicode-range
  // faces, else the node's font index.
  function nodePrimaryFontIndex(nodeBase) {
    const stack = view.getUint16(nodeBase + LAYOUT_NODE_OFFSET_FONT_STACK, true);
    if (stack !== 0) {
      const entry = FONT_STACK_TABLE_BASE + stack * FONT_STACK_ENTRY_SIZE;
      const slots = view.getUint32(entry + FONT_STACK_OFFSET_SLOTS, true);
      if (slots !== 0) {
        const primary = view.getUint16(entry + FONT_STACK_OFFSET_PRIMARY, true);
        const font = view.getUint16(slots + FONT_STACK_SLOT_HEADER_SIZE + primary * FONT_STACK_SLOT_SIZE, true);
        if (font !== FONT_STACK_UNLOADED) return font;
      }
    }
    return view.getUint16(nodeBase + LAYOUT_NODE_OFFSET_FONT_INDEX, true);
  }

  function textMetricsForNode(nodeIndex) {
    const nodeBase = layoutBufferBase + nodeIndex * LAYOUT_NODE_SIZE;
    const fontIndex = nodePrimaryFontIndex(nodeBase);
    const fontBase = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
    const unitsPerEm = view.getUint32(
      fontBase + FONT_TABLE_OFFSET_UPEM,
      true,
    );
    const fontSize = view.getFloat32(
      nodeBase + LAYOUT_NODE_OFFSET_FONT_SIZE,
      true,
    );
    const scale = Math.fround(fontSize / unitsPerEm);
    const metricPixels = (units) =>
      Math.fround(Math.floor(units * scale + 0.5));
    const ascender = metricPixels(
      view.getInt32(fontBase + FONT_TABLE_OFFSET_ASCENDER, true),
    );
    const descender = -metricPixels(
      -view.getInt32(fontBase + FONT_TABLE_OFFSET_DESCENDER, true),
    );
    const lineGap = Math.fround(
      view.getInt32(fontBase + FONT_TABLE_OFFSET_LINE_GAP, true) * scale,
    );
    const lineHeightTag = view.getUint8(
      nodeBase + LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
    );
    const authoredLineHeight = view.getFloat32(
      nodeBase + LAYOUT_NODE_OFFSET_LINE_HEIGHT,
      true,
    );
    let lineHeight;
    if (lineHeightTag === LINE_HEIGHT_NORMAL) {
      lineHeight = Math.fround(ascender - descender + lineGap);
    } else if (lineHeightTag === LINE_HEIGHT_LENGTH) {
      lineHeight = Math.round(authoredLineHeight * LAYOUT_UNIT) / LAYOUT_UNIT;
    } else if (lineHeightTag === LINE_HEIGHT_NUMBER) {
      lineHeight = Math.floor(
        Math.fround(authoredLineHeight * fontSize) * LAYOUT_UNIT,
      ) / LAYOUT_UNIT;
    } else {
      throw new Error(
        `layout artifact: unknown line-height tag ${lineHeightTag}`,
      );
    }
    const lineHeightUnits = Math.round(lineHeight * LAYOUT_UNIT);
    const fontHeightUnits = Math.round(
      Math.fround(ascender - descender) * LAYOUT_UNIT,
    );
    const halfLeadingUnits = Math.trunc(
      (lineHeightUnits - fontHeightUnits) / 2,
    );
    const baseline = (halfLeadingUnits >> 6) + ascender;
    return { baseline, lineHeight };
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
      const paddingBox = expandedBox(
        contentBox,
        edgeValue(node, "padding", "top"),
        edgeValue(node, "padding", "right"),
        edgeValue(node, "padding", "bottom"),
        edgeValue(node, "padding", "left"),
      );
      const marginBox = expandedBox(
        borderBox,
        edgeValue(node, "margin", "top"),
        edgeValue(node, "margin", "right"),
        edgeValue(node, "margin", "bottom"),
        edgeValue(node, "margin", "left"),
      );
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
      const lineCount = view.getUint16(
        runBase + TEXT_RUN_OFFSET_LINE_COUNT,
        true,
      );
      if (lineCount === 0) continue;
      const metrics = textMetricsForNode(nodeIndex);
      const contentBox = boxes[nodeIndex].contentBox;
      const textAlign = nodes[nodeIndex].textAlign ?? "left";
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
        // shift, mirroring the paint emitter's math exactly.
        const alignmentSlack = Math.max(availableWidth - width, 0);
        const alignedX = textAlign === "center"
          ? lineX + alignmentSlack / 2
          : textAlign === "right"
          ? lineX + alignmentSlack
          : lineX;
        lineBoxes.push({
          nodeIndex,
          lineIndex,
          x: lineX,
          y: lineY,
          alignedX,
          width,
          height: metrics.lineHeight,
          availableWidth,
          baseline: lineY + metrics.baseline,
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

  const COMMAND_NAMES = new Map([
    [CMD_RECT, "rectangle"],
    [CMD_TEXT, "text"],
    [CMD_IMAGE, "image"],
    [CMD_BOX_SHADOW, "box-shadow"],
    [CMD_PUSH_CLIP, "push-clip"],
    [CMD_POP_CLIP, "pop-clip"],
    [CMD_PUSH_OPACITY, "push-opacity"],
    [CMD_POP_OPACITY, "pop-opacity"],
    [CMD_SVG_PATH, "svg-path"],
    [CMD_PUSH_BACKDROP_FILTER, "push-backdrop-filter"],
    [CMD_POP_BACKDROP_FILTER, "pop-backdrop-filter"],
    [CMD_PUSH_MASK, "push-mask"],
    [CMD_PUSH_MASK_LAYER, "push-mask-layer"],
    [CMD_POP_MASK_LAYER, "pop-mask-layer"],
    [CMD_PUSH_BACKGROUND, "push-background"],
    [CMD_PUSH_BLEND_LAYER, "push-blend-layer"],
    [CMD_POP_BLEND_LAYER, "pop-blend-layer"],
    [CMD_POP_BACKGROUND, "pop-background"],
    [CMD_SET_NODE, "set-node"],
  ]);

  const GROUP_PAIRS = new Map([
    [CMD_PUSH_OPACITY, CMD_POP_OPACITY],
    [CMD_PUSH_BACKDROP_FILTER, CMD_POP_BACKDROP_FILTER],
    [CMD_PUSH_MASK_LAYER, CMD_POP_MASK_LAYER],
    [CMD_PUSH_BLEND_LAYER, CMD_POP_BLEND_LAYER],
    [CMD_PUSH_BACKGROUND, CMD_POP_BACKGROUND],
  ]);

  const BLEND_MODE_NAMES_BY_VALUE = Object.freeze(
    Object.fromEntries(
      Object.entries(BLEND_MODE_NAMES).map(([name, value]) => [value, name]),
    ),
  );

  function decodeClipEntries(commandView, commandOffset, deviceScale = 1) {
    const count = commandView.getUint8(
      commandOffset + CMD_PUSH_CLIP_OFFSET_COUNT,
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
      ? [0, 1, 2, 3].map((channel) => commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_FILL + channel * 4, true))
      : null;
    const borders = [CMD_RECT_OFFSET_BORDER_TOP, CMD_RECT_OFFSET_BORDER_RIGHT, CMD_RECT_OFFSET_BORDER_BOTTOM,
      CMD_RECT_OFFSET_BORDER_LEFT].map((field) =>
        (flags & CMD_RECT_FLAG_BORDER) ? commandView.getFloat32(commandOffset + field, true) : 0);
    const radii = Array.from({ length: 8 }, (_, index) =>
      commandView.getFloat32(commandOffset + CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X + index * 4, true));
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
  // The source of a text command whose glyphs name no source bytes: the
  // glyphs MathMLPainter paints in place of no text (a radical's surd,
  // under its msqrt or mroot) carry clusters [0, 0) and need no prepared
  // run; their node may have none.
  const NO_SOURCE_BYTES = new Uint8Array(0);
  // UTF-16 code unit offset at each UTF-8 byte offset of a run's bytes;
  // null when every byte is ASCII. Cached on the run's byte array.
  const utf16OffsetTables = new WeakMap();
  function utf16OffsetsOf(bytes) {
    let table = utf16OffsetTables.get(bytes);
    if (table !== undefined) return table;
    table = null;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) {
        table = new Uint32Array(bytes.length + 1);
        let units = 0;
        for (let k = 0; k < bytes.length; k++) {
          table[k] = units;
          const byte = bytes[k];
          // A code unit begins at every non-continuation byte; a 4-byte
          // sequence (astral) is a surrogate pair.
          if ((byte & 0xc0) !== 0x80) units += byte >= 0xf0 ? 2 : 1;
        }
        table[bytes.length] = units;
        break;
      }
    }
    utf16OffsetTables.set(bytes, table);
    return table;
  }

  // glyphs and glyphAdvances of a text operation, built on first read
  // and then plain data properties. Glyph cluster bounds are UTF-8 byte
  // offsets into the run; the artifact reports UTF-16 code unit offsets.
  function defineLazyGlyphs(operation, source, deviceScale) {
    const build = () => {
      const { entries, count, x, fontSize, unitsPerEm, preparedBytes } = source;
      const view = new DataView(
        entries.buffer,
        entries.byteOffset,
        entries.byteLength,
      );
      const units = utf16OffsetsOf(preparedBytes);
      const glyphAdvances = new Array(count);
      const glyphs = new Array(count);
      // A right-to-left run's glyphs come in visual order, with decreasing
      // cluster offsets; each glyph's cluster end is its logical end.
      const rtl = count > 1 &&
        view.getUint32(GLYPH_OFFSET_CLUSTER_START, true) >
          view.getUint32((count - 1) * GLYPH_ENTRY_SIZE + GLYPH_OFFSET_CLUSTER_START, true);
      for (let index = 0; index < count; index++) {
        const entryOffset = index * GLYPH_ENTRY_SIZE;
        const xOffset = view.getFloat32(
          entryOffset + GLYPH_OFFSET_X_OFFSET,
          true,
        );
        const advance = view.getFloat32(
          entryOffset + GLYPH_OFFSET_X_ADVANCE,
          true,
        );
        const sourceStart = view.getUint32(
          entryOffset + GLYPH_OFFSET_CLUSTER_START,
          true,
        );
        const sourceEnd = view.getUint32(
          entryOffset + GLYPH_OFFSET_CLUSTER_END,
          true,
        );
        const logicalAdvance = advance * fontSize / unitsPerEm / deviceScale;
        glyphAdvances[index] = logicalAdvance;
        glyphs[index] = Object.freeze({
          x: (x + xOffset * fontSize / unitsPerEm) / deviceScale,
          width: logicalAdvance,
          sourceStart: units === null ? sourceStart : units[sourceStart],
          sourceEnd: units === null ? sourceEnd : units[sourceEnd],
          rtl,
        });
      }
      Object.defineProperties(operation, {
        glyphAdvances: {
          value: glyphAdvances,
          enumerable: true,
          writable: true,
          configurable: true,
        },
        glyphs: {
          value: Object.freeze(glyphs),
          enumerable: true,
          writable: true,
          configurable: true,
        },
      });
    };
    Object.defineProperties(operation, {
      glyphCount: { value: source.count, enumerable: true, configurable: true },
      glyphAdvances: {
        get() {
          build();
          return operation.glyphAdvances;
        },
        enumerable: true,
        configurable: true,
      },
      glyphs: {
        get() {
          build();
          return operation.glyphs;
        },
        enumerable: true,
        configurable: true,
      },
    });
  }

  function createPaintArtifact(
    commandView,
    bytesWritten,
    scene,
    emittedNodes,
    deviceScale,
    glyphBuffer,
    frameTextRuns,
  ) {
    const glyphView = new DataView(
      glyphBuffer.buffer,
      glyphBuffer.byteOffset,
      glyphBuffer.byteLength,
    );
    const boxes = [];
    const operations = [];
    const compositingGroups = [];
    const clipStack = [];
    const compositingGroupStack = [];
    // The group-derived fields of the current group stack (see below);
    // null after a push or pop.
    let activeGroupState = null;
    let currentNodeIndex = null;
    let currentRunIndex = null;
    let currentClipEntries = [];
    let commandIndex = 0;
    for (let byteOffset = 0; byteOffset < bytesWritten; commandIndex++) {
      const opcode = commandView.getUint8(byteOffset);
      if (opcode === CMD_SET_NODE) {
        const emittedNodeIndex = commandView.getUint32(
          byteOffset + CMD_SET_NODE_OFFSET_INDEX,
          true,
        );
        currentRunIndex = emittedNodeIndex;
        currentNodeIndex = frameTextRuns[emittedNodeIndex]?.sourceId ??
          emittedNodes[emittedNodeIndex]?._inspectionSourceNodeIndex ??
          emittedNodeIndex;
      } else if (opcode === CMD_PUSH_CLIP) {
        currentClipEntries = decodeClipEntries(
          commandView,
          byteOffset,
          deviceScale,
        );
        clipStack.push(currentClipEntries);
      } else if (opcode === CMD_POP_CLIP) {
        if (clipStack.length === 0) {
          throw new Error("paint artifact: clip stack underflow");
        }
        clipStack.pop();
        currentClipEntries = clipStack.at(-1) ?? [];
      }

      if (GROUP_PAIRS.has(opcode)) {
        const group = {
          identifier: `paint-group-${compositingGroups.length}`,
          kind: COMMAND_NAMES.get(opcode).slice(5),
          nodeIndex: currentNodeIndex,
          startCommandIndex: commandIndex,
          endCommandIndex: null,
          startOperationIndex: operations.length,
          endOperationIndex: null,
        };
        if (opcode === CMD_PUSH_OPACITY) {
          const flags = commandView.getUint8(
            byteOffset + CMD_PUSH_OPACITY_OFFSET_FLAGS,
          );
          group.opacity = commandView.getFloat32(
            byteOffset + CMD_PUSH_OPACITY_OFFSET_ALPHA,
            true,
          );
          group.blendMode = BLEND_MODE_NAMES_BY_VALUE[
            (flags & CMD_PUSH_OPACITY_FLAG_BLEND_MASK) >>
            CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT
          ];
          group.stackingContext = true;
        } else if (opcode === CMD_PUSH_BLEND_LAYER) {
          group.blendMode = BLEND_MODE_NAMES_BY_VALUE[
            commandView.getUint8(
              byteOffset + CMD_PUSH_BLEND_LAYER_OFFSET_MODE,
            )
          ];
          group.stackingContext = false;
        } else {
          group.stackingContext = opcode === CMD_PUSH_BACKDROP_FILTER;
        }
        compositingGroups.push(group);
        compositingGroupStack.push({
          group,
          popOpcode: GROUP_PAIRS.get(opcode),
        });
        activeGroupState = null;
      } else if (
        compositingGroupStack.length > 0 &&
        opcode === compositingGroupStack.at(-1).popOpcode
      ) {
        const { group } = compositingGroupStack.pop();
        group.endCommandIndex = commandIndex;
        group.endOperationIndex = operations.length - 1;
        activeGroupState = null;
      }

      const geometry = decodeCommandGeometry(commandView, byteOffset, opcode);
      if (
        opcode === CMD_RECT || opcode === CMD_TEXT || opcode === CMD_IMAGE ||
        opcode === CMD_SVG_PATH || opcode === CMD_BOX_SHADOW
      ) {
        if (currentNodeIndex === null) {
          // Diagnostic depth matters here: this fires when a draw command
          // appears before any CMD_SET_NODE marker — historically a
          // symptom of another emit clobbering the shared buffers while a
          // frame was parked at an await (fixed by the frame snapshot in
          // renderScenePixels), so name the command and its geometry.
          const preceding = [];
          for (let o = 0; o < byteOffset;) {
            const k = commandView.getUint8(o);
            preceding.push(COMMAND_NAMES.get(k) ?? `op${k}`);
            o += commandByteSize(commandView, o);
          }
          throw new Error(
            `paint artifact: ${COMMAND_NAMES.get(opcode)} has no scene node ` +
              `(command ${commandIndex}, geometry ${
                JSON.stringify(geometry)
              }, ` +
              `preceding: ${preceding.join(" ")})`,
          );
        }
        const textFlags = opcode === CMD_TEXT
          ? commandView.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS)
          : 0;
        let logicalRectangle;
        let textMetrics = null;
        let lazyGlyphs = null;
        if (opcode === CMD_TEXT) {
          const glyphCount = commandView.getUint16(
            byteOffset + CMD_TEXT_OFFSET_GCOUNT,
            true,
          );
          const glyphOffset = commandView.getUint32(
            byteOffset + CMD_TEXT_OFFSET_GOFF,
            true,
          );
          const fontSize = engine.exports.used_font_size(commandView.getFloat32(
            byteOffset + CMD_TEXT_OFFSET_FSIZE,
            true,
          ));
          const unitsPerEm = commandView.getUint16(
            byteOffset + CMD_TEXT_OFFSET_UPEM,
            true,
          );
          let width = 0;
          let clusterStart = Number.MAX_SAFE_INTEGER;
          let clusterEnd = 0;
          for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
            const entryOffset = glyphOffset + glyphIndex * GLYPH_ENTRY_SIZE;
            const xOffset = glyphView.getFloat32(
              entryOffset + GLYPH_OFFSET_X_OFFSET,
              true,
            );
            const advance = glyphView.getFloat32(
              entryOffset + GLYPH_OFFSET_X_ADVANCE,
              true,
            );
            width = Math.max(width, xOffset + advance);
            clusterStart = Math.min(
              clusterStart,
              glyphView.getUint32(
                entryOffset + GLYPH_OFFSET_CLUSTER_START,
                true,
              ),
            );
            clusterEnd = Math.max(
              clusterEnd,
              glyphView.getUint32(entryOffset + GLYPH_OFFSET_CLUSTER_END, true),
            );
          }
          const preparedRun = frameTextRuns[currentRunIndex];
          if (!preparedRun && clusterEnd > 0) {
            throw new Error(
              `paint artifact: text command under node ${currentRunIndex} (${
                emittedNodes[currentRunIndex]?.display ?? "absent"
              }) names source bytes ${clusterStart}..${clusterEnd}, but the node carries no prepared text run`,
            );
          }
          const preparedBytes = preparedRun?.bytes ?? NO_SOURCE_BYTES;
          const text = glyphCount === 0 ? "" : utf8Decoder.decode(
            preparedBytes.subarray(clusterStart, clusterEnd),
          );
          // The per-glyph objects (glyphs, glyphAdvances) are built on
          // first read from a copy of the command's glyph entries: a frame
          // reads them only for text nodes whose geometry it cannot keep
          // from the previous frame (render-surface), and a frame of a
          // thousand runs would otherwise build them all.
          lazyGlyphs = {
            entries: glyphBuffer.slice(
              glyphOffset,
              glyphOffset + glyphCount * GLYPH_ENTRY_SIZE,
            ),
            count: glyphCount,
            x: geometry.x,
            fontSize,
            unitsPerEm,
            preparedBytes,
          };
          const baseline = commandView.getFloat32(
            byteOffset + CMD_TEXT_OFFSET_BL,
            true,
          );
          textMetrics = {
            text,
            fontSize: fontSize / deviceScale,
            lineHeight: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_LH,
              true,
            ) / deviceScale,
            ascent: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_ASCENT,
              true,
            ) / deviceScale,
            descent: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_DESCENT,
              true,
            ) / deviceScale,
            baseline: {
              x: geometry.x / deviceScale,
              y: (geometry.y + baseline) / deviceScale,
            },
          };
          logicalRectangle = {
            x: geometry.x / deviceScale,
            y: geometry.y / deviceScale,
            width: width * fontSize / unitsPerEm / deviceScale,
            height: commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_LH,
              true,
            ) / deviceScale,
          };
        } else {
          logicalRectangle = {
            x: geometry.x / deviceScale,
            y: geometry.y / deviceScale,
            width: geometry.width / deviceScale,
            height: geometry.height / deviceScale,
          };
        }

        let affine = null;
        let affineOffset = null;
        if (
          opcode === CMD_RECT &&
          (commandView.getUint8(byteOffset + CMD_RECT_OFFSET_FLAGS) &
              CMD_RECT_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_RECT_OFFSET_XFORM;
        } else if (
          opcode === CMD_TEXT &&
          (textFlags & CMD_TEXT_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_TEXT_OFFSET_XFORM;
        } else if (
          opcode === CMD_IMAGE &&
          (commandView.getUint8(byteOffset + CMD_IMAGE_OFFSET_FLAGS) &
              CMD_IMAGE_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_IMAGE_OFFSET_XFORM;
        } else if (
          opcode === CMD_SVG_PATH &&
          (commandView.getUint8(byteOffset + CMD_SVG_PATH_OFFSET_FLAGS) &
              CMD_SVG_PATH_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_SVG_PATH_OFFSET_XFORM;
        } else if (
          opcode === CMD_BOX_SHADOW &&
          (commandView.getUint8(byteOffset + CMD_BOX_SHADOW_OFFSET_FLAGS) &
              CMD_BOX_SHADOW_FLAG_TRANSFORM) !== 0
        ) {
          affineOffset = CMD_BOX_SHADOW_OFFSET_XFORM;
        }
        if (affineOffset !== null) {
          const affineAt = byteOffset + affineOffset;
          affine = [
            commandView.getFloat32(affineAt, true),
            commandView.getFloat32(affineAt + 4, true),
            commandView.getFloat32(affineAt + 8, true),
            commandView.getFloat32(affineAt + 12, true),
            commandView.getFloat32(affineAt + 16, true) / deviceScale,
            commandView.getFloat32(affineAt + 20, true) / deviceScale,
          ];
        }

        // The group-derived fields change only at a group push or pop; the
        // operations between share them (consumers only read them).
        if (activeGroupState === null) {
          const activeGroups = compositingGroupStack.map(({ group }) => group);
          activeGroupState = {
            opacity: activeGroups.reduce(
              (opacity, group) => group.opacity === undefined ? opacity : opacity * group.opacity,
              1,
            ),
            blendMode: activeGroups.findLast((group) => group.blendMode !== undefined)?.blendMode ??
              "normal",
            compositingGroupIdentifiers: activeGroups.map((group) => group.identifier),
            stackingContextIdentifiers: activeGroups
              .filter((group) => group.stackingContext)
              .map((group) => group.identifier),
          };
        }
        const kind = opcode === CMD_TEXT &&
            (textFlags & CMD_TEXT_FLAG_TEXT_SHADOW) !== 0
          ? "text-shadow"
          : COMMAND_NAMES.get(opcode);
        // Two literals, not one with a conditional spread: the spread made
        // every operation a slow dictionary object (a page of color glyph
        // layers is thousands of them a frame). The text fields keep their
        // place after logicalRectangle.
        const operation = textMetrics === null
          ? {
            operationIndex: operations.length,
            commandIndex,
            kind,
            nodeIndex: currentNodeIndex,
            logicalRectangle,
            affine,
            clipEntries: currentClipEntries,
            opacity: activeGroupState.opacity,
            blendMode: activeGroupState.blendMode,
            compositingGroupIdentifiers: activeGroupState.compositingGroupIdentifiers,
            stackingContextIdentifiers: activeGroupState.stackingContextIdentifiers,
          }
          : {
            operationIndex: operations.length,
            commandIndex,
            kind,
            nodeIndex: currentNodeIndex,
            logicalRectangle,
            text: textMetrics.text,
            fontSize: textMetrics.fontSize,
            lineHeight: textMetrics.lineHeight,
            ascent: textMetrics.ascent,
            descent: textMetrics.descent,
            baseline: textMetrics.baseline,
            affine,
            clipEntries: currentClipEntries,
            opacity: activeGroupState.opacity,
            blendMode: activeGroupState.blendMode,
            compositingGroupIdentifiers: activeGroupState.compositingGroupIdentifiers,
            stackingContextIdentifiers: activeGroupState.stackingContextIdentifiers,
          };
        if (lazyGlyphs !== null) {
          defineLazyGlyphs(operation, lazyGlyphs, deviceScale);
        }
        operations.push(operation);

        if (
          opcode === CMD_RECT || opcode === CMD_IMAGE ||
          opcode === CMD_SVG_PATH
        ) {
          boxes.push({
            kind: "shape",
            box: logicalRectangle,
            affine,
          });
        } else if (
          opcode === CMD_TEXT &&
          (textFlags & CMD_TEXT_FLAG_TEXT_SHADOW) === 0
        ) {
          boxes.push({
            kind: "text-run",
            box: logicalRectangle,
            affine,
          });
        }
      }
      byteOffset += commandByteSize(commandView, byteOffset);
    }
    // Clip pushes replace the complete raster state. A terminal state needs
    // no restoring pop because the command stream is discarded after replay.
    if (compositingGroupStack.length !== 0) {
      throw new Error("paint artifact: unclosed compositing group");
    }
    commandDecodeWork.commands += commandIndex;
    return {
      kind: "paint",
      viewport: { width: scene.width, height: scene.height },
      boxes,
      operations,
      compositingGroups,
    };
  }

  // The text operations of the commands in [start, end) of a command
  // stream, as the text geometry artifact holds them, and the byte offset
  // of each one's command. A text command reports the node of the last
  // node marker before it in the range; text shadows are not text
  // operations. The glyphs stay lazy, as the paint artifact's are: a frame
  // reads those of the text owners whose geometry it rebuilds, not every
  // operation's. Geometry deliberately has no opacity or blend fields:
  // those may change while these owned glyph and rectangle facts do not.
  function decodeTextGeometryOperations(
    commandView,
    start,
    end,
    emittedNodes,
    deviceScale,
    glyphBuffer,
    frameTextRuns,
  ) {
    const glyphView = new DataView(
      glyphBuffer.buffer,
      glyphBuffer.byteOffset,
      glyphBuffer.byteLength,
    );
    const operations = [];
    const offsets = [];
    let currentNodeIndex = null;
    let currentRunIndex = null;
    let byteOffset = start;
    while (byteOffset < end) {
      const opcode = commandView.getUint8(byteOffset);
      commandDecodeWork.commands++;
      if (opcode === CMD_SET_NODE) {
        const emittedNodeIndex = commandView.getUint32(
          byteOffset + CMD_SET_NODE_OFFSET_INDEX,
          true,
        );
        currentRunIndex = emittedNodeIndex;
        currentNodeIndex = frameTextRuns[emittedNodeIndex]?.sourceId ??
          emittedNodes[emittedNodeIndex]?._inspectionSourceNodeIndex ??
          emittedNodeIndex;
      } else if (
        opcode === CMD_TEXT &&
        (commandView.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS) &
            CMD_TEXT_FLAG_TEXT_SHADOW) === 0
      ) {
        if (currentNodeIndex === null) {
          throw new Error(
            `text geometry: the text command at byte ${byteOffset} has no node marker before it in bytes ${start}..${end}`,
          );
        }
        const geometry = decodeCommandGeometry(commandView, byteOffset, opcode);
        const glyphCount = commandView.getUint16(
          byteOffset + CMD_TEXT_OFFSET_GCOUNT,
          true,
        );
        const glyphOffset = commandView.getUint32(
          byteOffset + CMD_TEXT_OFFSET_GOFF,
          true,
        );
        const fontSize = engine.exports.used_font_size(commandView.getFloat32(
          byteOffset + CMD_TEXT_OFFSET_FSIZE,
          true,
        ));
        const unitsPerEm = commandView.getUint16(
          byteOffset + CMD_TEXT_OFFSET_UPEM,
          true,
        );
        let width = 0;
        let clusterEnd = 0;
        for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
          const entryOffset = glyphOffset + glyphIndex * GLYPH_ENTRY_SIZE;
          width = Math.max(
            width,
            glyphView.getFloat32(entryOffset + GLYPH_OFFSET_X_OFFSET, true) +
              glyphView.getFloat32(entryOffset + GLYPH_OFFSET_X_ADVANCE, true),
          );
          clusterEnd = Math.max(
            clusterEnd,
            glyphView.getUint32(entryOffset + GLYPH_OFFSET_CLUSTER_END, true),
          );
        }
        const preparedRun = frameTextRuns[currentRunIndex];
        if (!preparedRun && clusterEnd > 0) {
          throw new Error(
            `text geometry: text command under node ${currentRunIndex} (${
              emittedNodes[currentRunIndex]?.display ?? "absent"
            }) names source bytes up to ${clusterEnd}, but the node carries no prepared text run`,
          );
        }
        const affine = (commandView.getUint8(byteOffset + CMD_TEXT_OFFSET_FLAGS) &
            CMD_TEXT_FLAG_TRANSFORM) === 0
          ? null
          : Object.freeze(Array.from({ length: 6 }, (_, index) => {
            const value = commandView.getFloat32(
              byteOffset + CMD_TEXT_OFFSET_XFORM + index * 4,
              true,
            );
            return index < 4 ? value : value / deviceScale;
          }));
        const glyphSource = {};
        defineLazyGlyphs(glyphSource, {
          entries: glyphBuffer.slice(
            glyphOffset,
            glyphOffset + glyphCount * GLYPH_ENTRY_SIZE,
          ),
          count: glyphCount,
          x: geometry.x,
          fontSize,
          unitsPerEm,
          preparedBytes: preparedRun?.bytes ?? NO_SOURCE_BYTES,
        }, deviceScale);
        operations.push(Object.freeze({
          kind: "text",
          nodeIndex: currentNodeIndex,
          logicalRectangle: Object.freeze({
            x: geometry.x / deviceScale,
            y: geometry.y / deviceScale,
            width: width * fontSize / unitsPerEm / deviceScale,
            height: commandView.getFloat32(byteOffset + CMD_TEXT_OFFSET_LH, true) /
              deviceScale,
          }),
          affine,
          glyphCount,
          get glyphs() {
            return glyphSource.glyphs;
          },
        }));
        offsets.push(byteOffset);
      }
      byteOffset += commandByteSize(commandView, byteOffset);
    }
    if (byteOffset !== end) {
      throw new Error(
        `text geometry: the commands of bytes ${start}..${end} end at byte ${byteOffset}`,
      );
    }
    return { operations, offsets };
  }

  // The text geometry of a stream that edits made from the previous
  // stream: the previous operations outside the edited ranges, at their
  // moved offsets, and the operations decoded from each edit's new bytes.
  // Edits are in stream order: { oldOffset, oldBytes, offset, byteLength }.
  // The previous artifact itself when no edit held or holds a text
  // operation.
  function spliceTextGeometry(
    previousArtifact,
    previousOffsets,
    edits,
    commandView,
    emittedNodes,
    deviceScale,
    glyphBuffer,
    frameTextRuns,
  ) {
    const lowerBound = (offset) => {
      let low = 0;
      let high = previousOffsets.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (previousOffsets[middle] < offset) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const replaced = edits.map((edit) => ({
      first: lowerBound(edit.oldOffset),
      end: lowerBound(edit.oldOffset + edit.oldBytes),
      decoded: decodeTextGeometryOperations(
        commandView,
        edit.offset,
        edit.offset + edit.byteLength,
        emittedNodes,
        deviceScale,
        glyphBuffer,
        frameTextRuns,
      ),
    }));
    const operationsChanged = replaced.some(({ first, end, decoded }) =>
      first !== end || decoded.operations.length !== 0
    );
    const count = replaced.reduce(
      (total, { first, end, decoded }) =>
        total - (end - first) + decoded.operations.length,
      previousOffsets.length,
    );
    const offsets = new Uint32Array(count);
    const operations = operationsChanged ? new Array(count) : null;
    let cursor = 0;
    let previousIndex = 0;
    let shift = 0;
    const keep = (end) => {
      for (; previousIndex < end; previousIndex++, cursor++) {
        offsets[cursor] = previousOffsets[previousIndex] + shift;
        if (operations !== null) {
          operations[cursor] = previousArtifact.operations[previousIndex];
        }
      }
    };
    for (let index = 0; index < edits.length; index++) {
      const { first, end, decoded } = replaced[index];
      keep(first);
      for (let added = 0; added < decoded.operations.length; added++, cursor++) {
        offsets[cursor] = decoded.offsets[added];
        operations[cursor] = decoded.operations[added];
      }
      previousIndex = end;
      shift += edits[index].byteLength - edits[index].oldBytes;
    }
    keep(previousOffsets.length);
    return {
      artifact: operations === null ? previousArtifact : Object.freeze({
        kind: "text-geometry",
        operations: Object.freeze(operations),
      }),
      offsets,
    };
  }

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

  // Marks the 64-device-px raster tiles over a $width x $height target that
  // a device-px rectangle covers. The raster rounds an edge to the device
  // grid inside the pixel the edge cuts, so the right and bottom edges are
  // exclusive. A caller grows a rectangle whose shape antialiases past it.
  function markDirtyRectangle(tiles, width, height, x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    const columns = Math.ceil(width / 64);
    const rows = Math.ceil(height / 64);
    const left = Math.max(0, Math.floor(x / 64));
    const top = Math.max(0, Math.floor(y / 64));
    const right = Math.min(columns - 1, Math.ceil((x + w) / 64) - 1);
    const bottom = Math.min(rows - 1, Math.ceil((y + h) / 64) - 1);
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        tiles[row * columns + column] = 1;
      }
    }
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
          const view = new DataView(engine.memory.buffer, engine.exports.shape_features_pointer(), count * 16);
          return Array.from({ length: count }, (_, feature) => {
            const tag = view.getUint32(feature * 16, true);
            return [
              String.fromCharCode(tag >>> 24, (tag >>> 16) & 0xFF, (tag >>> 8) & 0xFF, tag & 0xFF),
              view.getUint32(feature * 16 + 4, true),
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
        const glyphPositions = new Array(glyphCount);
        const clusters = new Array(glyphCount);
        let clusterStart = Number.MAX_SAFE_INTEGER;
        let clusterEnd = 0;
        for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
          const entryOffset = glyphOffset + glyphIndex * GLYPH_ENTRY_SIZE;
          glyphIds[glyphIndex] = glyphView.getUint16(
            entryOffset + GLYPH_OFFSET_ID,
            true,
          );
          glyphPositions[glyphIndex] = glyphView.getFloat32(
            entryOffset + GLYPH_OFFSET_X_OFFSET,
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
          advances,
          clusters,
          fontSize,
          unitsPerEm,
          fontWeight: emitted.view.getUint8(byteOffset + CMD_TEXT_OFFSET_WEIGHT) * 100,
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
                emitted.view.getFloat32(byteOffset + CMD_TEXT_OFFSET_XFORM + index * 4, true)
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
      if (GROUP_PAIRS.has(opcode)) {
        const group = {
          kind: COMMAND_NAMES.get(opcode).slice(5),
          startCommandIndex: commandIndex,
          endCommandIndex: null,
        };
        groups.push(group);
        groupStack.push({ group, popOpcode: GROUP_PAIRS.get(opcode) });
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
        name: COMMAND_NAMES.get(opcode),
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
    const columns = Math.ceil(frame.width / tileSize);
    const rows = Math.ceil(frame.height / tileSize);
    const tileMap = new Array(columns * rows).fill(false);
    const dirtyRectangles = (frame.dirtyRectangles ?? frame.dirtyRects ?? [])
      .map(
        (rectangle) => ({
          ...rectangle,
          reason: rectangle.reason ?? frame.invalidationReason ??
            (frame.frameSequence === 1
              ? "initial-render"
              : "render-state-change"),
        }),
      );
    for (const rectangle of dirtyRectangles) {
      const firstColumn = Math.floor(rectangle.x / tileSize);
      const lastColumn = Math.ceil((rectangle.x + rectangle.w) / tileSize);
      const firstRow = Math.floor(rectangle.y / tileSize);
      const lastRow = Math.ceil((rectangle.y + rectangle.h) / tileSize);
      for (let row = firstRow; row < lastRow; row++) {
        for (let column = firstColumn; column < lastColumn; column++) {
          if (row >= 0 && row < rows && column >= 0 && column < columns) {
            tileMap[row * columns + column] = true;
          }
        }
      }
    }
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
    return new DataView(engine.memory.buffer).getUint32(plan + 12, true);
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
      ...rasterOptions
    } = renderOptions;
    const textOperationsRequired = captureTextGeometry;
    const captureNodeMarkers = capturePaintArtifact || textOperationsRequired;
    // Only coordinate inspection requires bytes with current sticky offsets.
    const artifactCoordinatesRead = capturePaintArtifact ||
      (captureTextGeometry && textGeometryArtifactRead);
    validateLayoutNodeCapacity(layoutNodeCapacity);
    // A canvas that reads an SVG image rasters it at the device scale of
    // the last frame (svgImageDensity), and the broken image icon takes its
    // version for this frame's device pixels.
    svgImageDensity = Math.max(1, deviceScale);
    await selectBrokenImageIcon();
    if (page !== null) {
      if (!(page.height > 0) || !Number.isInteger(page.index) || page.index < 0) {
        throw new RangeError(
          `page needs a positive height and a page index of 0 or more; got height ${page.height}, index ${page.index}`,
        );
      }
    }
    if (visibleRectangle !== null) {
      const { x, y, width, height } = visibleRectangle;
      if (
        !(width > 0) || !(height > 0) || !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        throw new RangeError(
          "visibleRectangle requires finite x/y and positive width/height",
        );
      }
    }
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
    for (const index of changed ?? []) {
      if (
        !Number.isInteger(index) || index < 0 || index >= scene.nodes.length
      ) {
        throw new RangeError(
          `Changed node index ${index} is outside a scene of ${scene.nodes.length} nodes`,
        );
      }
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
      (!textOperationsRequired || previous.textGeometryArtifact !== null) &&
      (!scene.imageSources?.size ||
        previous.imageSources === scene.imageSources);
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
    const commandsMoved = retainedCommands &&
      ranges.some((range) => range.byteLength !== range.oldBytes);
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
    if (retainedCommands && rasterOptions.dirtyTiles === undefined) {
      rasterOptions.dirtyTiles = new Uint8Array(
        Math.ceil(pxW / 64) * Math.ceil(pxH / 64),
      );
    }
    if (rasterOptions.dirtyTiles && !authoritativeDirtyTiles) {
      // The engine's dirty map covers the raster target's grid
      // (writeTileGrid): 64 device px tiles, or a multiple of 64 that
      // spans that many raster tiles across and down.
      const damageMeasurement = globalThis[domMeasurementKey];
      const damageStart = damageMeasurement ? hostNow() : 0;
      const combinedDirtyTiles = rasterOptions.dirtyTiles.slice();
      const dirtyMapAddress = engine.exports.tile_dirty_map_base();
      const engineColumns = Math.ceil(pxW / engineTileSize);
      const engineRows = Math.ceil(pxH / engineTileSize);
      const span = engineTileSize / 64;
      const physicalColumns = Math.ceil(pxW / 64);
      const physicalRows = Math.ceil(pxH / 64);
      for (let index = 0; index < engineColumns * engineRows; index++) {
        const byte = view.getUint8(dirtyMapAddress + (index >>> 3));
        if (!(byte & (1 << (index & 7)))) continue;
        const firstColumn = (index % engineColumns) * span;
        const firstRow = ((index / engineColumns) | 0) * span;
        const lastColumn = Math.min(physicalColumns, firstColumn + span);
        const lastRow = Math.min(physicalRows, firstRow + span);
        for (let row = firstRow; row < lastRow; row++) {
          for (let column = firstColumn; column < lastColumn; column++) {
            combinedDirtyTiles[row * physicalColumns + column] = 1;
          }
        }
      }
      if (damageMeasurement) {
        damageMeasurement.record({
          category: "damage",
          operation: "dirty-tiles.merge",
          direction: "engine-to-host",
          bytes: engineColumns * engineRows,
          allocations: 1,
          allocationBytes: combinedDirtyTiles.byteLength,
          milliseconds: hostNow() - damageStart,
        });
      }
      rasterOptions.dirtyTiles = combinedDirtyTiles;
    }
    // The engine's paint damage (a caret that moved, appeared or went)
    // repaints in every frame mode: a pure-scroll frame's declared tiles,
    // which leave the engine's dirty map out, include it too.
    if (rasterOptions.dirtyTiles) {
      const damageCount = engine.exports.paint_damage_count();
      if (damageCount > 0) {
        rasterOptions.dirtyTiles = rasterOptions.dirtyTiles.slice();
      }
      for (let index = 0; index < damageCount; index++) {
        markDirtyRectangle(
          rasterOptions.dirtyTiles,
          pxW,
          pxH,
          engine.exports.paint_damage_value(index, 0) * deviceScale -
            (visibleRectangle?.x ?? 0) * deviceScale,
          engine.exports.paint_damage_value(index, 1) * deviceScale -
            (visibleRectangle?.y ?? 0) * deviceScale,
          engine.exports.paint_damage_value(index, 2) * deviceScale,
          engine.exports.paint_damage_value(index, 3) * deviceScale,
        );
      }
    }
    // Geometry capture needs owned text runs on a full frame and on a
    // retained frame that spliced blocks in (its new text operations name
    // their runs). Certified paint-only replay keeps the immutable geometry
    // artifact, so neither text run copying nor command decoding repeats
    // during animation or scrolling.
    const splicedBlocks = retainedCommands &&
      ranges.some((range) => range.kind === 0);
    const frameTextRuns = captureNodeMarkers &&
        (!reusedCommands || splicedBlocks)
      ? currentTextBatch.copyRuns()
      : [];
    // A preparation reads the laid-out engine rows here, before the raster
    // awaits (examples/animation-playground-sandom.js keeps its result).
    preparation.inspect?.();
    // FRAME SNAPSHOT — the frame owns its bytes. A synchronous layout
    // getter (getBoundingClientRect → layoutTreeBoxesSync →
    // emitSceneCommandsSync) can barge into the SHARED engine while this
    // render is parked at an await below; it re-emits the command,
    // glyph, gradient-stop, and scroll buffers for a DIFFERENT scene.
    // The promise chain (runExclusiveEngineOperation) cannot serialize a
    // synchronous caller, so live views over engine memory across awaits
    // are corrupted frames waiting to happen (found via react_select:
    // createPaintArtifact walked another emit's marker-free stream).
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
    const scrollTable = retainedCommands
      ? previous.scrollTable
      : new Float32Array(
        engine.memory.buffer.slice(
          scrollTableBase,
          scrollTableBase + scrollTableSize,
        ),
      );
    const gradientStopPool = new Uint8Array(
      engine.memory.buffer.slice(
        GRADIENT_STOP_POOL_BASE,
        GRADIENT_STOP_POOL_BASE + GRADIENT_STOP_POOL_SIZE,
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
    await prepareColorGlyphBitmaps(cmdView, bytes, deviceScale);
    await selectSvgImageRasters(cmdView, bytes, Math.max(1, deviceScale), svgImageTimings);
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
    let textGeometryArtifact = null;
    // The byte offset of each text geometry operation's command.
    let textOperationOffsets = null;
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
      // The command stream is CSS px natively; the paint artifact's
      // logical rectangles need no division.
      paintArtifact = capturePaintArtifact
        ? createPaintArtifact(
          cmdView,
          bytes,
          scene,
          nodes,
          1,
          glyphBuffer,
          frameTextRuns,
        )
        : null;
      if (textOperationsRequired) {
        if (reusedCommands && !splicedBlocks) {
          textGeometryArtifact = previous.textGeometryArtifact;
          textOperationOffsets = previous.textOperationOffsets;
        } else if (splicedBlocks) {
          ({ artifact: textGeometryArtifact, offsets: textOperationOffsets } =
            spliceTextGeometry(
              previous.textGeometryArtifact,
              previous.textOperationOffsets,
              ranges.filter((range) => range.kind === 0),
              cmdView,
              nodes,
              1,
              glyphBuffer,
              frameTextRuns,
            ));
        } else {
          const decoded = decodeTextGeometryOperations(
            cmdView,
            0,
            bytes,
            nodes,
            1,
            glyphBuffer,
            frameTextRuns,
          );
          textGeometryArtifact = Object.freeze({
            kind: "text-geometry",
            operations: Object.freeze(decoded.operations),
          });
          textOperationOffsets = Uint32Array.from(decoded.offsets);
        }
      }
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
      engineBytes.set(gradientStopPool, GRADIENT_STOP_POOL_BASE);
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
            rasterOptions.dirtyTiles = rasterOptions.dirtyTiles.slice();
          }
          const damage = new Float32Array(
            engine.memory.buffer,
            damageTable,
            damageCount * 4,
          );
          for (let index = 0; index < damageCount; index++) {
            markDirtyRectangle(
              rasterOptions.dirtyTiles,
              pxW,
              pxH,
              (damage[index * 4] - (visibleRectangle?.x ?? 0)) * deviceScale,
              (damage[index * 4 + 1] - (visibleRectangle?.y ?? 0)) * deviceScale,
              damage[index * 4 + 2] * deviceScale,
              damage[index * 4 + 3] * deviceScale,
            );
          }
        }
      }
      try {
        glyphLease.bindRasterResources();
        bindPathRasterAtlas(svgPathAtlas);
        rasterPlan = (() => {
          const previousConfiguration = previous?.rasterPlanConfiguration;
          // Patches address byte ranges in the engine's emitted stream.
          const canPatch = retainedCommands && reusedCommands && previous.rasterPlan &&
            previousConfiguration?.length === rasterPlanConfiguration.length &&
            previousConfiguration.every((value, index) =>
              value === rasterPlanConfiguration[index]
            );
          if (canPatch) {
            // Spliced blocks replan their new commands in place of their
            // old ones; opacity groups patched in place repack after that,
            // at their offsets in the new stream.
            const splicedRanges = ranges.filter((range) => range.kind === 0);
            const patchedRanges = ranges.filter((range) => range.kind === 1);
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
                    GRADIENT_STOP_POOL_BASE,
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
          const canRescroll = replayedCommands && reusedCommands && previous.rasterPlan &&
            previousConfiguration != null &&
            previousConfiguration.length >= targetConfigurationLength &&
            rasterPlanConfiguration.every((value, index) =>
              index >= targetConfigurationLength ||
              value === previousConfiguration[index]
            );
          if (
            canRescroll &&
            engine.exports.raster_plan_rescroll(
                previous.rasterPlan.plan,
                scrollTableBase,
                GRADIENT_STOP_POOL_BASE,
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
          const plan = engine.exports.raster_plan_prepare(
            engineCommandBase,
            bytes,
            commandRevision,
            pxW,
            pxH,
            deviceScale,
            renderContext.renderMode === "high-dynamic-range" ? 1 : 0,
            scrollTableBase,
            GRADIENT_STOP_POOL_BASE,
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
        scrollbarRows: frameScrollbarRows,
        textGeometryArtifact,
        textOperationOffsets,
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
        imageSources: scene.imageSources,
        globalPreparation,
      });
    }
    // Copy the readback so the context-owned ring/persistent buffer can be
    // reused by the next frame while the caller holds this one.
    const pixels = result.pixels ? new Float32Array(result.pixels) : null;
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
    // The result IS the working ImageDescriptor (float32 rgba in the mode's
    // working encoding, premultiplied - see rasterize.js's
    // workingRenderResult) plus boxes, performance, and dirty tracking.
    // readback: "none" returns the direct textureImage instead.
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
          // the page count, every page's description in order, and the
          // nodes on other pages.
          page: {
            height: page.height,
            rulesKey: page.rulesKey ?? "",
            ...pagedLayoutRecord.pages[pageIndex],
            count: pageCount,
            pages: pagedLayoutRecord.pages,
            offPageNodes,
          },
        }
        : {}),
      ...(paintArtifact ? { paintArtifact } : {}),
      ...(captureTextGeometry && textGeometryArtifact
        ? { textGeometryArtifact }
        : {}),
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

  async function createSceneRenderer({
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
    async function rebuildContext() {
      physicalWidth = (visibleRectangle?.width ?? width) * deviceScale;
      physicalHeight = (visibleRectangle?.height ?? height) * deviceScale;
      context = await createRenderContext({
        width: physicalWidth,
        height: physicalHeight,
        graphicsBackend,
        sharedStateOwner: rendererGraphicsStateOwner,
        ...(renderMode !== undefined ? { renderMode } : {}),
        ...(renderPrecision !== undefined ? { renderPrecision } : {}),
      });
    }
    let context = await createRenderContext({
      width: physicalWidth,
      height: physicalHeight,
      graphicsBackend,
      sharedStateOwner: rendererGraphicsStateOwner,
      ...(renderMode !== undefined ? { renderMode } : {}),
      ...(renderPrecision !== undefined ? { renderPrecision } : {}),
    });
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
      return animations.planTransitions({
        previousRecord,
        nextRecord: nextNode._coreRecord,
        box,
        previousTransform: previousNode.transform,
        nextTransform: nextNode.transform,
        definitions: nextNode.transitionDefinitions,
      });
    }
    function renderFrame(scene, renderOptions, readback) {
      // Serialize renders across every renderer sharing this runtime's
      // engine (see engineRenderChain above).
      return runExclusiveEngineOperation(() =>
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
          const plan = planNodeTransitions(
            previousSceneNodes[nodeIndex],
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
        await context.destroy();
        width = nextWidth;
        height = nextHeight;
        deviceScale = nextDeviceScale;
        await rebuildContext();
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
       * scene cache, and the node signatures stay valid; only the
       * render context and the raster target are replaced. */
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
        await context.destroy();
        await rebuildContext();
      },
      // The resolved raster backend ("webgpu" | "webgl2"). Presentation
      // consumers branch on this: only the webgpu backend can return a
      // GPU texture image; the webgl2 backend always reads back pixels.
      get graphicsBackend() {
        return context.kind;
      },
      // The GPUDevice the webgpu backend renders on; null for webgl2.
      get graphicsDevice() {
        return context.kind === "webgpu" ? context.device : null;
      },
      // The token this renderer claims the engine's layout buffer with.
      // A synchronous layout getter over the tree this renderer renders
      // passes it to layoutTreeBoxesSync, which then inherits the
      // retained layout instead of relaying out the whole page, and hands
      // the claim back so the next frame keeps its incremental node set.
      get engineWriteToken() {
        return animations;
      },
      render(scene, renderOptions = {}) {
        return renderFrame(scene, renderOptions, "float32");
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
        await context.destroy();
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
    floatByte,
    clearByte,
    sceneHtml,
    scaleNode,
    emitSceneCommands,
    emitSceneCommandsSync,
    layoutTreeBoxes,
    layoutTreeBoxesSync,
    layoutTextGeometrySync,
    registerDecodedImage,
    canvasImageEntry: canvasImagePixels,
    shapeStandaloneTextSync,
    createLayoutArtifact,
    createDisplayListArtifact,
    createInvalidationArtifact,
    releaseRenderContexts,
    getDefaultGlyphResourceManager,
    shutdownDefaultGlyphResourceManager,
    renderScenePixels,
    createPersistentSceneRenderer,
    createSceneRenderer: createSceneRenderer,
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
export const createDisplayListArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createDisplayListArtifact(...arguments_);
export const createInvalidationArtifact = (...arguments_) =>
  defaultSceneRendererRuntime.createInvalidationArtifact(...arguments_);
export const layoutTreeBoxes = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxes(...arguments_);
export const layoutTreeBoxesSync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTreeBoxesSync(...arguments_);
export const layoutTextGeometrySync = (...arguments_) =>
  defaultSceneRendererRuntime.layoutTextGeometrySync(...arguments_);
export const shapeStandaloneTextSync = (...arguments_) =>
  defaultSceneRendererRuntime.shapeStandaloneTextSync(...arguments_);
export const glyphOutlinesSync = (...arguments_) =>
  defaultSceneRendererRuntime.shapingRuntime.glyphOutlinesSync(...arguments_);
export const engineCounters = (...arguments_) =>
  defaultSceneRendererRuntime.engineCounters(...arguments_);
export const releaseRenderContexts = (...arguments_) =>
  defaultSceneRendererRuntime.releaseRenderContexts(...arguments_);
export const createPersistentSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.createPersistentSceneRenderer(...arguments_);
export const createSceneRenderer = (...arguments_) =>
  defaultSceneRendererRuntime.createSceneRenderer(...arguments_);
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
    createPersistentSceneRenderer:
      sceneRendererRuntime.createPersistentSceneRenderer,
    createLayoutArtifact: sceneRendererRuntime.createLayoutArtifact,
    createDisplayListArtifact: sceneRendererRuntime.createDisplayListArtifact,
    releaseRenderContexts: sceneRendererRuntime.releaseRenderContexts,
  };
  return Object.freeze(runtime);
}
