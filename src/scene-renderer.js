// Shared scene rendering machinery for the gallery AND the headless pixel test.
// Single source of truth for: spec → WAT layout nodes, spec → equivalent
// CSS/HTML (the Chrome side), and lay-out-and-render to pixels. Both the visible
// gallery and the test import these, so the test renders the exact same bytes
// the gallery shows.

const resourceMeasurementKey = Symbol.for("sandom.domCore.measurement");
const engineWriteClaims = new WeakMap();

import { loadEngine } from "./wasm/loader.js";
import {
  BOX_SNAPSHOT_ROW_WORDS,
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
import { svgShapeToPathDef } from "./svg-shape-path.js";
import { createAnimationController } from "./animations.js";
import {
  animationTransitionChanged,
  animationTransitionProperties,
} from "./dom-wasm/animation.js";
import { createAtlasRuntime, emptyGlyphPhaseMilliseconds } from "./atlas.js";
import { GlyphResourceManager } from "./glyph-resource-manager.js";
import { createColorGlyphCache } from "./color-glyph-cache.js";
export {
  DEFAULT_GLYPH_RESOURCE_LIMITS,
  GLYPH_RESOURCE_FORMAT_VERSION,
  GlyphResourceManager,
} from "./glyph-resource-manager.js";
import { createImageCodecRuntime, svgImageSource } from "./jpeg.js";
import { createWebPDecoder } from "./webp.js";
import { createJpegXlCodec } from "./jpeg-xl.js";
import {
  lazyAssetBytes,
  prepareSandomRuntimeOptions,
} from "./runtime-assets.js";
import { prepareImageProfile, toSrgbRgba8 } from "./image-data.js";
import { convertXyzToLinearRgb, encodeSrgbTransfer } from "./color.js";
import { createShapingRuntime } from "./shaping.js";
import { readFontMetrics } from "./font-metrics.js";
import { readBinaryFile } from "./host.js";
import {
  createFontRegistry,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  defaultFontRegistry,
  fontVariationAxes,
  ITALIC_SLOPE,
} from "./font-registry.js";
import {
  gridTrackCss,
  scaleGridTrack,
} from "./grid-tracks.js";
import { DomCore, sharedDomCore } from "./dom-wasm/core.js";
import { publishDirectSceneInput } from "./dom-wasm/direct-scene-input.js";
import { resolvedGradient } from "./dom/svg-image.js";
import {
  EngineFrameFinishRowFields,
  EngineFrameFinishRowSize,
  EngineFrameResolutionFields,
  EngineFrameResolutionSize,
  writeEngineFrameInput,
} from "./dom-wasm/record-readers.generated.js";
import {
  BLEND_MODE_NAMES,
  BORDER_STYLE_DASHED,
  BORDER_STYLE_DOTTED,
  BORDER_STYLE_DOUBLE,
  BORDER_STYLE_GROOVE,
  BORDER_STYLE_HIDDEN,
  BORDER_STYLE_INSET,
  BORDER_STYLE_NONE,
  BORDER_STYLE_OUTSET,
  BORDER_STYLE_RIDGE,
  BORDER_STYLE_SOLID,
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
  CMD_IMAGE_FLAG_TRANSFORM,
  CMD_IMAGE_OFFSET_FLAGS,
  CMD_IMAGE_OFFSET_INDEX,
  CMD_IMAGE_OFFSET_H,
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
  CMD_RECT_FLAG_FILL,
  CMD_RECT_FLAG_TRANSFORM,
  CMD_RECT_OFFSET_FILL,
  CMD_RECT_OFFSET_FLAGS,
  CMD_RECT_OFFSET_H,
  CMD_RECT_OFFSET_W,
  CMD_RECT_OFFSET_X,
  CMD_RECT_OFFSET_XFORM,
  CMD_RECT_OFFSET_Y,
  CMD_SET_NODE,
  CMD_SET_NODE_OFFSET_INDEX,
  CMD_SET_SCROLL,
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
  BUILTIN_PATH_INDEX_BASE,
  BUILTIN_PATH_DISCLOSURE_DOWN,
  BUILTIN_PATH_DISCLOSURE_LEFT,
  BUILTIN_PATH_DISCLOSURE_RIGHT,
  FONT_UNIT_SUBDIVISION,
  CMD_TEXT,
  CMD_TEXT_FLAG_TEXT_SHADOW,
  CMD_TEXT_FLAG_TRANSFORM,
  CMD_TEXT_OFFSET_ASCENT,
  CMD_TEXT_OFFSET_COLOR,
  CMD_TEXT_OFFSET_BL,
  CMD_TEXT_OFFSET_DESCENT,
  CMD_TEXT_OFFSET_FLAGS,
  CMD_TEXT_OFFSET_FONT,
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
  COMMAND_BUFFER_BASE,
  commandByteSize,
  cmdRectSize,
  cmdTextSize,
  FLOAT_LEFT,
  FLOAT_NONE,
  FLOAT_RIGHT,
  FONT_TABLE_BASE,
  FONT_TABLE_MAX_ENTRIES,
  FONT_TABLE_ENTRY_SIZE,
  FONT_TABLE_OFFSET_ASCENDER,
  FONT_TABLE_OFFSET_DESCENDER,
  FONT_TABLE_OFFSET_LINE_GAP,
  FONT_TABLE_OFFSET_UPEM,
  FONT_TABLE_OFFSET_BYTES,
  FONT_TABLE_OFFSET_LENGTH,
  FONT_TABLE_OFFSET_FACE_INDEX,
  FONT_TABLE_OFFSET_ITALIC,
  FONT_TABLE_OFFSET_WEIGHT,
  FONT_VARIATION_TABLE_BASE,
  FONT_VARIATION_TABLE_ENTRY_SIZE,
  FONT_VARIATION_OFFSET_WIDTH,
  FONT_VARIATION_OFFSET_SLANT,
  GLYPH_ENTRY_SIZE,
  GLYPH_ID_INVISIBLE,
  GLYPH_REQUEST_HEADER_SIZE,
  GLYPH_REQUEST_ROW_SIZE,
  GLYPH_OFFSET_CLUSTER_END,
  GLYPH_OFFSET_CLUSTER_START,
  GLYPH_OFFSET_ID,
  GLYPH_OFFSET_X_ADVANCE,
  GLYPH_OFFSET_X_OFFSET,
  GRADIENT_STOP_POOL_BASE,
  GRADIENT_STOP_POOL_SIZE,
  HEADER_BASE,
  HEADER_OFFSET_GENERATION,
  IMAGE_TABLE_MAX_ENTRIES,
  RASTER_PLAN_SCROLLBAR_ROW_SIZE,
  RASTER_RESOURCE_IMAGE,
  RASTER_RESOURCE_GLYPH,
  RASTER_RESOURCE_GLYPH_ROW_SIZE,
  RASTER_RESOURCE_PATH,
  LANGUAGE_TABLE_ENTRY_SIZE,
  LAYOUT_NODE_OFFSET_BG_COLOR,
  LAYOUT_NODE_OFFSET_TEXT_COLOR,
  LAYOUT_NODE_OFFSET_CHANGED_GEN,
  LAYOUT_NODE_OFFSET_PAINT_GEN,
  LAYOUT_NODE_OFFSET_FLEX_BASIS,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
  LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
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
  LAYOUT_NODE_OFFSET_HEIGHT,
  LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
  LAYOUT_NODE_OFFSET_INSET_LEFT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
  LAYOUT_NODE_OFFSET_INSET_RIGHT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
  LAYOUT_NODE_OFFSET_INSET_TOP,
  LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
  LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT,
  LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG,
  LAYOUT_NODE_OFFSET_MAX_H_TAG,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT,
  LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MAX_W_TAG,
  LAYOUT_NODE_OFFSET_MAX_WIDTH,
  LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_H_TAG,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT,
  LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
  LAYOUT_NODE_OFFSET_MIN_W_TAG,
  LAYOUT_NODE_OFFSET_MIN_WIDTH,
  LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_OPACITY,
  LAYOUT_NODE_OFFSET_PADDING_TOP,
  LAYOUT_NODE_OFFSET_PADDING_RIGHT,
  LAYOUT_NODE_OFFSET_PADDING_BOTTOM,
  LAYOUT_NODE_OFFSET_PADDING_LEFT,
  LAYOUT_NODE_OFFSET_ROW_GAP,
  LAYOUT_NODE_OFFSET_GRID_ROW_GAP_PERCENTAGE,
  LAYOUT_NODE_OFFSET_GRID_COLUMN_GAP_PERCENTAGE,
  LAYOUT_NODE_OFFSET_COLUMN_GAP,
  LAYOUT_NODE_OFFSET_TRANSFORM,
  LAYOUT_NODE_OFFSET_TRANSFORM_KIND,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y,
  LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT,
  LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT,
  LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN,
  LAYOUT_NODE_OFFSET_WIDTH,
  LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
  LAYOUT_NODE_OFFSET_WIDTH_TAG,
  LAYOUT_NODE_SIZE,
  LAYOUT_NODE_OFFSET_FLAGS,
  LAYOUT_FLAG_HAS_BOX_SHADOW,
  LAYOUT_NODE_OFFSET_SHADOW_COUNT,
  LAYOUT_NODE_OFFSET_SHADOW_OFFSET,
  SHADOW_ENTRY_SIZE,
  SHADOW_OFFSET_OFFSET_X,
  SHADOW_OFFSET_OFFSET_Y,
  SHADOW_OFFSET_BLUR,
  SHADOW_OFFSET_SPREAD,
  SHADOW_OFFSET_COLOR,
  SHADOW_OFFSET_INSET,
  LAYOUT_UNIT,
  SVG_GEOM_POOL_BASE,
  SVG_GEOM_ENTRY_SIZE,
  SVG_GEOM_POOL_SIZE,
  LAYOUT_NODE_OFFSET_GEOM_LENGTH,
  LAYOUT_NODE_OFFSET_GEOM_OFFSET,
  LAYOUT_NODE_OFFSET_SVG_KIND,
  LAYOUT_NODE_OFFSET_SVG_HAS_VIEW_BOX,
  LAYOUT_NODE_OFFSET_SVG_PRESERVE_ASPECT_RATIO,
  LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_X,
  LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_Y,
  LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_WIDTH,
  LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_HEIGHT,
  SVG_KIND_PATH_REF,
  LINE_HEIGHT_LENGTH,
  LINE_HEIGHT_NORMAL,
  LINE_HEIGHT_NUMBER,
  SIZE_TAG_CALC_PAIR,
  SIZE_TAG_FIT_CONTENT,
  SIZE_TAG_LENGTH,
  SIZE_TAG_MAX_CONTENT,
  SIZE_TAG_MIN_CONTENT,
  SIZE_TAG_PERCENT,
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
  TILE_CONFIG_BASE,
  TRANSFORM_KIND_RESOLVED,
} from "./wasm/layout.js";
import { FONT_COVERAGE_RANGE_SIZE } from "./font-coverage.js";

export { LAYOUT_UNIT };

// The bytes of an SVG image are not a usable SVG document: their root is
// not an svg element in the SVG namespace. Such an image is broken, as in
// Chrome. Other failures while an SVG image rasterizes are Sandom failures
// and fail the frame.
class UndecodableSvgImageError extends Error {}

export async function createSceneRendererRuntime({
  harfbuzzBytes = null,
  msdfgenBytes = null,
  fontRegistry: suppliedFontRegistry = null,
  graphicsDevice = null,
  resolveSystemFontFamily = null,
  // The registry fallback families of the runtime's own font registry
  // (createFontRegistry). A supplied fontRegistry carries its own.
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
    createShapingRuntime({ engine, registerFont: fontIndexForOutlineBytes });
  const atlasRuntime = suppliedAtlasRuntime ??
    createAtlasRuntime({
      msdfgenBytes,
      createGlyphOutlineSource: shapingRuntime.createGlyphOutlineSource,
    });
  if (suppliedFontRegistry !== null && fallbackFamilies !== null) {
    throw new TypeError(
      "createSceneRendererRuntime takes fallbackFamilies or a fontRegistry, not both; pass fallbackFamilies to createFontRegistry",
    );
  }
  const fontRegistry = suppliedFontRegistry ??
    createFontRegistry({ resolveSystemFontFamily, fallbackFamilies, core });
  if (fontRegistry.core && fontRegistry.core !== core) {
    throw new TypeError("Font registry belongs to another renderer core");
  }
  core.defaultFontRegistry = fontRegistry;
  const codecRuntime = suppliedCodecRuntime ?? createImageCodecRuntime();
  const {
    initializeAtlasRuntime,
    SvgPathAtlas,
  } = atlasRuntime;
  const { shapeGlyphIds } = shapingRuntime;
  const {
    fontFamilyCssValue,
    fontStackKeysForCssValue,
    fontFileFor,
    fontWeightInCssUnits,
    isVariableFamily,
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
  // The rows a synchronous layout getter left in the engine on behalf of
  // the surface that owns the write claim (layoutTreeBoxesSync), for the
  // frame that takes the same serialization to reuse instead of publishing
  // every row again. Any other engine write supersedes it.
  let syncLayoutWrite = null;
  const retainedPreparations = new WeakMap();

  function releaseRetainedPreparation(owner, preservedTextResources = null) {
    const retained = owner && retainedPreparations.get(owner);
    if (!retained) return;
    retainedPreparations.delete(owner);
    if (retained.rasterPlan) {
      engine.exports.raster_plan_release(retained.rasterPlan.plan);
    }
    if (retained.textResources.glyphLease !== preservedTextResources?.glyphLease) {
      retained.textResources.glyphLease.release();
    }
    releaseBoxSnapshot(retained.boxes);
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
        glyphAtlasFactory: (fontBytes, variationWidth, variationSlant, faceIndex) =>
          new atlasRuntime.GlyphAtlas(fontBytes, variationWidth, variationSlant, faceIndex),
      });
    }
    return defaultGlyphResourceManager;
  }
  async function shutdownDefaultGlyphResourceManager() {
    const manager = defaultGlyphResourceManager;
    defaultGlyphResourceManager = null;
    if (manager) await manager.shutdown();
  }


  // Resolve authored transforms for CSS/HTML diagnostics and host resources.
  function resolveTransform(node) {
    const t = node.transform;
    if (t === undefined) return [1, 0, 0, 1, 0, 0];
    if (Array.isArray(t)) {
      if (t.length !== 6) {
        throw new Error(`transform array must have 6 values, got ${t.length}`);
      }
      return t;
    }
    const sx = typeof t.scale === "number" ? t.scale : (t.scale?.x ?? 1);
    const sy = typeof t.scale === "number" ? t.scale : (t.scale?.y ?? 1);
    const rad = ((t.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;

    const tx = t.translate?.x ?? 0, ty = t.translate?.y ?? 0;
    return [a, b, c, d, tx, ty];
  }

  // svg-use (S6 step 2): composes "apply innerAffine's transform first, then
  // outerAffine's" — matrix() order, same convention as engine.wat's own
  // $composeNodeTransform ("this node's transform, then the already-
  // accumulated parent transform"). Used to fold <use>'s own x/y translate
  // (applied to the referenced content, spec: "appended to the right-side of
  // the transformation list") together with any transform the <use> element
  // itself carries, into ONE affine for the synthetic wrapping group — same
  // [a,b,c,d,e,f] shape resolveTransform() already produces/consumes.
  function composeAffine(outer, inner) {
    const [oa, ob, oc, od, oe, of] = outer;
    const [ia, ib, ic, id, ie, iff] = inner;
    return [
      oa * ia + oc * ib,
      ob * ia + od * ib,
      oa * ic + oc * id,
      ob * ic + od * id,
      oa * ie + oc * iff + oe,
      ob * ie + od * iff + of,
    ];
  }

  function resolveLengthPercentage(value, referenceLength) {
    return (value?.pixels ?? 0) + (value?.percentage ?? 0) * referenceLength;
  }

  function cssTransformMatrix(node, box) {
    const transform = node.transform;
    let matrix = [1, 0, 0, 1, 0, 0];
    for (const component of transform.components) {
      let next;
      switch (component.kind) {
        case "matrix":
          next = component.value;
          break;
        case "translate":
          next = [
            1,
            0,
            0,
            1,
            resolveLengthPercentage(component.x, box.w),
            resolveLengthPercentage(component.y, box.h),
          ];
          break;
        case "translateX":
          next = [
            1,
            0,
            0,
            1,
            resolveLengthPercentage(component.value, box.w),
            0,
          ];
          break;
        case "translateY":
          next = [
            1,
            0,
            0,
            1,
            0,
            resolveLengthPercentage(component.value, box.h),
          ];
          break;
        case "scale":
          next = [component.x, 0, 0, component.y, 0, 0];
          break;
        case "scaleX":
          next = [component.value, 0, 0, 1, 0, 0];
          break;
        case "scaleY":
          next = [1, 0, 0, component.value, 0, 0];
          break;
        case "rotate": {
          const cosine = Math.cos(component.radians);
          const sine = Math.sin(component.radians);
          next = [cosine, sine, -sine, cosine, 0, 0];
          break;
        }
        case "skew":
          next = [
            1,
            Math.tan(component.yRadians),
            Math.tan(component.xRadians),
            1,
            0,
            0,
          ];
          break;
        case "skewX":
          next = [1, 0, Math.tan(component.radians), 1, 0, 0];
          break;
        case "skewY":
          next = [1, Math.tan(component.radians), 0, 1, 0, 0];
          break;
        default:
          throw new Error(`Unknown CSS transform component: ${component.kind}`);
      }
      matrix = composeAffine(matrix, next);
    }
    const origin = node.transformOrigin ?? {
      x: { pixels: 0, percentage: 0.5 },
      y: { pixels: 0, percentage: 0.5 },
    };
    const originX = box.x + resolveLengthPercentage(origin.x, box.w);
    const originY = box.y + resolveLengthPercentage(origin.y, box.h);
    return composeAffine(
      [1, 0, 0, 1, originX, originY],
      composeAffine(matrix, [1, 0, 0, 1, -originX, -originY]),
    );
  }

  function resolveCssTransform(node, box) {
    const desired = cssTransformMatrix(node, box);
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    return composeAffine(
      [1, 0, 0, 1, -centerX, -centerY],
      composeAffine(desired, [1, 0, 0, 1, centerX, centerY]),
    );
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
  const fontInstancesByBytes = new WeakMap();
  const fontCoordinateBits = new DataView(new ArrayBuffer(8));
  const fontBytesByIndex = new Map();
  const fontBytesByPointer = new Map();
  const fontIdentitiesByPointer = new Map();
  let nativeFontMetadataCount = 0;
  const fontIsItalicFaceByIndex = new Map();
  // The 'wdth' coordinate each engine font instance shapes at (0: none)
  // and its 'slnt' coordinate (0: upright); its glyph outlines take the
  // same coordinates.
  const fontVariationWidthByIndex = new Map();
  const fontVariationSlantByIndex = new Map();
  const fontIdentityByIndex = new Map();
  // The registrations of each engine font instance, earliest first. The
  // engine shares one instance among faces with the same bytes
  // (font-identity.watpart), and each face registers it under its own
  // family and identity: a document's runtime face and a system family can
  // be the same file. fontIdentityByIndex holds the earliest registration
  // still live; the registry's release of a face (the engine source
  // transport) removes that face's registrations, so a disposed document's
  // face names no instance another document draws with. A registration
  // without a face resource (a hosted or fallback family) stays.
  const fontRegistrationsByIndex = new Map();

  function noteFontRegistration(fontIndex, owner, identity) {
    let registrations = fontRegistrationsByIndex.get(fontIndex);
    if (!registrations) fontRegistrationsByIndex.set(fontIndex, registrations = []);
    const known = registrations.some((registration) =>
      registration.owner === owner &&
      registration.identity.family === identity.family &&
      registration.identity.faceIdentity === identity.faceIdentity
    );
    if (!known) registrations.push({ owner, identity });
    fontIdentityByIndex.set(fontIndex, registrations[0].identity);
  }

  // Removes the registrations of the face resource `owner`. An instance
  // whose every registration is gone keeps its last identity: the engine
  // keeps the instance, and no live face draws with it under another name.
  function forgetFontRegistrations(owner) {
    for (const [fontIndex, registrations] of fontRegistrationsByIndex) {
      const kept = registrations.filter((registration) => registration.owner !== owner);
      if (kept.length === registrations.length || kept.length === 0) continue;
      fontRegistrationsByIndex.set(fontIndex, kept);
      fontIdentityByIndex.set(fontIndex, kept[0].identity);
    }
  }
  let sceneGeneration = 0;

  function fontInstanceCache(bytes, faceIndex, weight, width, slant) {
    const buffer = bytes.buffer;
    if (buffer === engine.memory.buffer || buffer.resizable || buffer.growable ||
      (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)) return null;
    let instances = fontInstancesByBytes.get(bytes);
    if (!instances) {
      instances = new Map();
      fontInstancesByBytes.set(bytes, instances);
    }
    fontCoordinateBits.setFloat32(0, width, true);
    fontCoordinateBits.setFloat32(4, slant, true);
    for (const dimension of [faceIndex, weight, fontCoordinateBits.getUint32(0, true)]) {
      let next = instances.get(dimension);
      if (!next) {
        next = new Map();
        instances.set(dimension, next);
      }
      instances = next;
    }
    return { instances, slantBits: fontCoordinateBits.getUint32(4, true) };
  }

  function registerFontBytes(
    family,
    weight,
    stretch,
    {
      bytes, faceIndex = 0, italicFace, resourceHandle, faceIdentity, finalURL,
      variationWeight, variationWidth, variationSlant,
    },
  ) {
    const buffer = bytes.buffer;
    const mutableSource = buffer === engine.memory.buffer || buffer.resizable || buffer.growable ||
      (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer);
    if (mutableSource) bytes = bytes.slice();
    // A runtime face states its own instancing weight (0: register as-is);
    // a hosted family instances 'wght' when it is variable. The registry
    // states every face's 'wdth' and 'slnt' coordinates; a file without
    // that axis registers as-is (wdth 0, slnt 0), so a static face takes
    // one instance at every stretch and slope.
    const registeredWeight = variationWeight ?? (isVariableFamily(family) ? weight : 0);
    if (!(variationWidth >= 0) || !Number.isFinite(variationWidth)) {
      throw new RangeError(
        `Font face of ${family} has no usable 'wdth' coordinate: ${variationWidth}; the registry states the requested or clamped font-stretch percentage`,
      );
    }
    if (!Number.isFinite(variationSlant)) {
      throw new RangeError(
        `Font face of ${family} has no usable 'slnt' coordinate: ${variationSlant}; the registry states the negated requested or clamped oblique angle`,
      );
    }
    // Both host parses run before the engine sees the bytes: bytes that
    // fail either one leave no engine allocation and no font index.
    const axes = fontVariationAxes(bytes, faceIndex);
    const metrics = readFontMetrics(bytes, { faceIndex });
    const registeredWidth = axes.has("wdth") ? variationWidth : 0;
    const registeredSlant = axes.has("slnt") ? variationSlant : 0;
    const cachedInstance = mutableSource ? null : fontInstanceCache(bytes, faceIndex, registeredWeight, registeredWidth, registeredSlant);
    const existing = cachedInstance?.instances.get(cachedInstance.slantBits);
    const registrationIdentity = (fontIndex) => Object.freeze({
      family,
      faceIdentity: faceIdentity ?? finalURL ?? null,
      faceIndex,
      weight: registeredWeight || weight,
      stretch: registeredWidth || stretch,
      slant: registeredSlant,
      style: engine.exports.font_is_italic(fontIndex) !== 0 ? "italic" : "normal",
    });
    if (existing !== undefined) {
      noteFontRegistration(existing, resourceHandle ?? null, registrationIdentity(existing));
      return resourceHandle === undefined
        ? existing
        : joinEngineResource(resourceHandle, existing, existing);
    }
    // Single shared memory: hb_malloc_for_test allocates in HarfBuzz's heap
    // region of engine.memory (above the layout reservation).
    const fontPtr = engine.exports.hb_malloc_for_test(bytes.length);
    const measurement = globalThis[domMeasurementKey];
    const transferStart = measurement ? performance.now() : 0;
    new Uint8Array(engine.memory.buffer, fontPtr, bytes.length).set(bytes);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.bytes",
        direction: "host-to-engine",
        bytes: bytes.byteLength,
        allocations: 1,
        milliseconds: performance.now() - transferStart,
      });
    }
    const fontIndex = engine.exports.register_font(
      fontPtr,
      bytes.length,
      faceIndex,
      registeredWeight,
      registeredWidth,
      registeredSlant,
    );
    if (fontIndex < 0) throw fontTableFullError(family);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.register",
        direction: "host-to-engine",
        bytes: 16,
        crossings: 0,
      });
    }
    engine.exports.set_font_decoration_metrics(
      fontIndex,
      metrics.underlinePosition,
      metrics.underlineThickness,
      metrics.strikeoutPosition,
      metrics.strikeoutThickness,
    );
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "font.decoration",
        direction: "host-to-engine",
        bytes: 20,
        crossings: 0,
      });
    }
    cachedInstance?.instances.set(cachedInstance.slantBits, fontIndex);
    if (!fontIdentityByIndex.get(fontIndex)?.family) {
      const pointer = view.getUint32(
        FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE + FONT_TABLE_OFFSET_BYTES, true);
      bytes = fontBytesByPointer.get(pointer) ?? bytes.slice();
      italicFace = engine.exports.font_is_italic(fontIndex) !== 0;
      fontBytesByIndex.set(fontIndex, bytes);
      fontBytesByPointer.set(pointer, bytes);
      let identities = fontIdentitiesByPointer.get(pointer);
      if (!identities) fontIdentitiesByPointer.set(pointer, identities = new Map());
      fontIsItalicFaceByIndex.set(fontIndex, italicFace);
      fontVariationWidthByIndex.set(fontIndex, registeredWidth);
      fontVariationSlantByIndex.set(fontIndex, registeredSlant);
      if (!identities.has(faceIndex)) identities.set(faceIndex, registrationIdentity(fontIndex));
    }
    noteFontRegistration(fontIndex, resourceHandle ?? null, registrationIdentity(fontIndex));
    // A face resource joins each engine instance registered from it under
    // the instance's own index: instances of one face differ by weight,
    // width, slant, and italic synthesis.
    return resourceHandle === undefined
      ? fontIndex
      : joinEngineResource(resourceHandle, fontIndex, fontIndex);
  }

  function fontIndexForOutlineBytes(bytes, faceIndex = 0) {
    const pointer = engine.exports.hb_malloc_for_test(bytes.byteLength);
    new Uint8Array(engine.memory.buffer, pointer, bytes.byteLength).set(bytes);
    const fontIndex = engine.exports.register_font_for_outline(pointer, bytes.byteLength, faceIndex);
    if (fontIndex < 0) throw fontTableFullError("an outline face");
    return fontIndex;
  }

  function fontTableFullError(family) {
    return new Error(
      `The engine font table is full: registering ${family} needs instance ${engine.exports.font_table_count() + 1}, ` +
        `FONT_TABLE_MAX_ENTRIES is ${FONT_TABLE_MAX_ENTRIES}. Raise FONT_TABLE_MAX_ENTRIES and FONT_TABLE_SIZE ` +
        "together in src/wasm/engine-constants.watpart and src/wasm/layout.js.",
    );
  }

  function synchronizeNativeFonts() {
    const count = engine.exports.font_table_count();
    while (nativeFontMetadataCount < count) {
      const fontIndex = nativeFontMetadataCount++;
      if (fontBytesByIndex.has(fontIndex)) continue;
      const entry = FONT_TABLE_BASE + fontIndex * FONT_TABLE_ENTRY_SIZE;
      const pointer = view.getUint32(entry + FONT_TABLE_OFFSET_BYTES, true);
      let bytes = fontBytesByPointer.get(pointer);
      if (!bytes) {
        bytes = new Uint8Array(engine.memory.buffer, pointer,
          view.getUint32(entry + FONT_TABLE_OFFSET_LENGTH, true)).slice();
        fontBytesByPointer.set(pointer, bytes);
      }
      const variation = FONT_VARIATION_TABLE_BASE + fontIndex * FONT_VARIATION_TABLE_ENTRY_SIZE;
      const width = view.getFloat32(variation + FONT_VARIATION_OFFSET_WIDTH, true);
      const slant = view.getFloat32(variation + FONT_VARIATION_OFFSET_SLANT, true);
      const italicFace = view.getUint32(entry + FONT_TABLE_OFFSET_ITALIC, true) !== 0;
      const faceIndex = view.getUint32(entry + FONT_TABLE_OFFSET_FACE_INDEX, true);
      const sourceIdentity = fontIdentitiesByPointer.get(pointer)?.get(faceIndex);
      fontBytesByIndex.set(fontIndex, bytes);
      fontIsItalicFaceByIndex.set(fontIndex, italicFace);
      fontVariationWidthByIndex.set(fontIndex, width);
      fontVariationSlantByIndex.set(fontIndex, slant);
      fontIdentityByIndex.set(fontIndex, Object.freeze({
        family: sourceIdentity?.family ?? null, faceIdentity: sourceIdentity?.faceIdentity ?? null,
        faceIndex,
        weight: view.getUint16(entry + FONT_TABLE_OFFSET_WEIGHT, true) || sourceIdentity?.weight || 400,
        stretch: width || 100, slant, style: italicFace ? "italic" : "normal",
      }));
    }
  }

  // Resolve CSS font declarations through the production registry, shape text
  // with HarfBuzz at the production variation coordinates, then fill the shared
  // bounded glyph manager. This is the public prewarm boundary for DOM clients.
  async function prewarmCssTextGlyphs({
    glyphResourceManager = getDefaultGlyphResourceManager(),
    instances,
    text,
  }) {
    const prewarmStartedAt = performance.now();
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
    const requestsByInstance = new Map();
    const requests = [];
    for (const [instanceIndex, instance] of instances.entries()) {
      const [fontFamily] = fontStackKeysForCssValue(instance?.fontFamily);
      const weight = fontWeightInCssUnits(instance?.fontWeight ?? 400);
      const fontSize = Number(instance?.fontSize);
      const deviceScale = Number(instance?.deviceScale ?? 1);
      const fontStyle = instance?.fontStyle ?? "normal";
      const fontStretch = Number(instance?.fontStretch ?? 100);
      if (!Number.isFinite(weight) || weight < 1 || weight > 1000) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font weight`,
        );
      }
      if (!Number.isFinite(fontSize) || fontSize <= 0) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font size`,
        );
      }
      if (!Number.isFinite(deviceScale) || deviceScale <= 0) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid device scale`,
        );
      }
      if (fontStyle !== "normal" && fontStyle !== "italic") {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font style`,
        );
      }
      if (!(fontStretch >= 0) || !Number.isFinite(fontStretch)) {
        throw new RangeError(
          `CSS glyph prewarm instance ${instanceIndex} has an invalid font stretch`,
        );
      }

      const fontIndex = registerFontBytes(fontFamily, weight, fontStretch,
        fontFileFor(fontFamily, weight, fontStyle, fontStretch, fontStyle === "italic" ? ITALIC_SLOPE : 0));
      const variationWidth = fontVariationWidthByIndex.get(fontIndex);
      const variationSlant = fontVariationSlantByIndex.get(fontIndex);
      const fontBytes = fontBytesByIndex.get(fontIndex);
      if (!fontBytes) {
        throw new Error(
          `CSS glyph prewarm resolved font index ${fontIndex} without font bytes`,
        );
      }
      let contentDigest = fontDigests.get(fontBytes);
      if (contentDigest === undefined) {
        contentDigest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", fontBytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        fontDigests.set(fontBytes, contentDigest);
      }
      const opticalSize = fontSize;
      const devicePixelSize = fontSize;
      const faceIndex = fontIdentityByIndex.get(fontIndex).faceIndex;
      let instanceRows = requestsByInstance;
      for (const dimension of [contentDigest, faceIndex, weight, variationWidth, variationSlant, opticalSize]) {
        let next = instanceRows.get(dimension);
        if (!next) {
          next = new Map();
          instanceRows.set(dimension, next);
        }
        instanceRows = next;
      }
      if (instanceRows.has(devicePixelSize)) continue;
      const variations = [["wght", weight], ["opsz", opticalSize], ["slnt", variationSlant]];
      if (variationWidth !== 0) variations.push(["wdth", variationWidth]);
      const glyphIds = shapeGlyphIds(fontIndex, text, variations);
      const request = {
        fontBytes,
        faceIndex,
        glyphIds: [...new Set(glyphIds)],
        weight,
        variationWidth,
        variationSlant,
        opticalSize,
        devicePixelSize,
        fontFamily,
        contentDigest,
      };
      instanceRows.set(devicePixelSize, request);
      requests.push(request);
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
      milliseconds: performance.now() - prewarmStartedAt,
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
    synchronizeNativeFonts();
    const faces = new Map();
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (usesCoreRecord(node) || (
        node.display !== "text" && node.display !== "inline" &&
        node.display !== "inline-block" && !node.inlineCtx && !node._coreTextarea
      )) {
        if (out !== null) out.push(node);
        continue;
      }
      const family = node.fontFamily ?? fontStackKeysForCssValue(DEFAULT_FONT_FAMILY)[0];
      const weight = fontWeightInCssUnits(node.fontWeight);
      const style = node.fontStyle ?? "normal";
      const stretch = node.fontStretch ?? 100;
      const slope = node.fontSlope ?? (style === "normal" ? 0 : ITALIC_SLOPE);
      let instances = faces;
      for (const dimension of [family, weight, style, stretch]) {
        let next = instances.get(dimension);
        if (!next) instances.set(dimension, next = new Map());
        instances = next;
      }
      let fontIndex = instances.get(slope);
      if (fontIndex === undefined) {
        fontIndex = registerFontBytes(family, weight, stretch,
          fontFileFor(family, weight, style, stretch, slope));
        instances.set(slope, fontIndex);
      }
      if (out === null) out = nodes.slice(0, index);
      out.push({ ...node, fontIndex });
    }
    return out ?? nodes;
  }

  // Image registration (Slice P5a/b): mirrors resolveFontIndices/fontIndexFor
  // above — one decode+register per distinct src, cached across scenes.
  // register_image's INDEX is caller-picked (unlike register_font's
  // auto-incremented handle — see IMAGE_TABLE's doc comment in layout.js),
  // so this module owns the counter. Each entry caches the NATIVE
  // ImageDescriptor for the color-managed WebGPU upload (src/rasterize.js
  // converts it into the mode's working encoding on the graphics processing
  // unit) plus a lazily derived eight-bit sRGB flattening for the degraded
  // WebGL 2 backend — the engine itself never sees pixel bytes, only
  // width/height (IMAGE_TABLE).
  const imageIndexBySrc = new Map(); // src (string path) -> imageIndex
  const imagePixelsByIndex = new Map(); // imageIndex -> { width, height, descriptor, pixels (lazy) }
  const synchronizedGlyphRasterRevisions = new Map();
  let synchronizedGlyphRequestSnapshot = null;
  let synchronizedGlyphAtlases = null;
  const imageIndexByCanvasSource = new WeakMap();
  const imageResourceHandles = new Map();
  const canvasResourceHandles = new Map();
  let resourceEngineScope = 0n;

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
      forgetFontRegistrations(resourceHandle);
    },
    register({ family, faceID, face, descriptor, resourceHandle, variable }) {
      resourceEngineScope ||= core.resourceEngineCreate();
      const weight = Math.min(Math.max(400, descriptor.weightMinimum), descriptor.weightMaximum);
      const stretch = descriptor.stretchAuto ? 100 :
        Math.min(Math.max(100, descriptor.stretchMinimum), descriptor.stretchMaximum);
      const slope = descriptor.slopeAuto ? 0 :
        Math.min(Math.max(0, descriptor.slopeMinimum), descriptor.slopeMaximum);
      const weighted = variable || descriptor.weightMaximum > descriptor.weightMinimum;
      const index = registerFontBytes(family, weight, stretch, {
        ...face, resourceHandle, variationWeight: weighted ? weight : 0,
        variationWidth: stretch, variationSlant: slope === 0 ? 0 : -slope,
      });
      const axes = fontVariationAxes(face.bytes, face.faceIndex ?? 0);
      const flags = (weighted ? 1 : 0) | (axes.has("wdth") ? 2 : 0) |
        (axes.has("slnt") ? 4 : 0) | (descriptor.stretchAuto ? 8 : 0) |
        (descriptor.slopeAuto ? 16 : 0);
      core.status("font_catalog_source_bind", fontRegistry.fontCatalogHandle,
        resourceEngineScope, faceID, resourceHandle, index, flags);
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

  // Registry fallback families (plans/PLAN-font-fallback.md, slice 4): the
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

  // plans/PLAN-font-unicode-range.md decision 3: loads the @font-face rule
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
      const axes = fontVariationAxes(face.bytes, face.faceIndex);
      const fontIndex = registerFontBytes(`fallback:${face.family}`, weight, 100, {
        bytes: face.bytes, faceIndex: face.faceIndex, italicFace: false,
        faceIdentity: face.finalURL, finalURL: face.finalURL,
        variationWeight: axes.has("wght") ? weight : 0, variationWidth: 100, variationSlant: 0,
      });
      engine.exports.font_fallback_answer(family, style, fontIndex);
    }
  }

  function imageResourceFor(src, resourceIdentifier) {
    const key = resourceIdentifier ?? src;
    let handle = imageResourceHandles.get(key);
    if (handle === undefined) {
      if (resourceIdentifier === undefined) {
        resourceEngineScope ||= core.resourceEngineCreate();
        handle = core.resourceRegisterOwned(
          1,
          resourceEngineScope,
          src,
        );
      } else {
        handle = core.resourceFindId(resourceIdentifier);
        core.resourceRetain(handle);
      }
      imageResourceHandles.set(key, handle);
    }
    return handle;
  }
  let nextImageIndex = 0;
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
  // not serialized (only the persistent renderers' frames are). The images
  // of a frame load concurrently (resolveImageIndices), so each SVG image
  // waits here for the one before it. The fetches and the raster image
  // decodes of the frame still overlap these renders.
  let svgRasterChain = Promise.resolve();
  function rasterizeSvgImage(source, locator, svgImageTimings = null) {
    const run = svgRasterChain.then(() =>
      rasterizeSvgImageNow(source, locator, svgImageTimings)
    );
    // A failed image must not fail the images queued after it.
    svgRasterChain = run.then(() => {}, () => {});
    return run;
  }

  async function rasterizeSvgImageNow(source, locator, svgImageTimings) {
    const startedAt = performance.now();
    let stageStartedAt = startedAt;
    const stages = {
      source: locator,
      coldRuntime: !svgRasterRuntimePromise,
      moduleMilliseconds: 0,
      runtimeInitializationMilliseconds: 0,
      parseMilliseconds: 0,
      definitionsMilliseconds: 0,
      measurementMilliseconds: 0,
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
    let now = performance.now();
    stages.moduleMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const { runtime, fonts } = await svgRasterRuntime();
    now = performance.now();
    stages.runtimeInitializationMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const document = parseXMLDocument(
      source,
      "image/svg+xml",
      () =>
        new SDDocument({
          core: runtime.core,
          fontRegistry: fonts,
          url: new URL(locator, "file:///").href,
        }),
    );
    const root = document.documentElement;
    if (
      root?.localName !== "svg" ||
      root.namespaceURI !== "http://www.w3.org/2000/svg"
    ) {
      throw new UndecodableSvgImageError(
        `Invalid SVG image at ${locator}: expected an SVG root`,
      );
    }
    now = performance.now();
    stages.parseMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const decorate = prepareSvgImageDefinitions(
      root, runtime.core, locator, stages,
    );
    now = performance.now();
    stages.definitionsMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    // Intrinsic dimensions belong to the SVG root, independently of its
    // descendants. Measuring every path first built an MSDF at an arbitrary
    // size, then built it again at its actual raster size.
    const serializedMeasure = serializeToScene(root, {
      viewportWidth: 300,
      viewportHeight: 150,
    });
    const measureScene = {
      width: 300,
      height: 150,
      nodes: [{ ...serializedMeasure.nodes[0], children: [] }],
    };
    const boxes = await runtime.layoutTreeBoxes(measureScene);
    const { w, h } = boxes[0];
    releaseBoxSnapshot(boxes);
    if (!(w > 0 && h > 0) || !Number.isFinite(w + h)) {
      throw new Error(`Invalid SVG image dimensions at ${locator}: ${w}x${h}`);
    }
    now = performance.now();
    stages.measurementMilliseconds = now - stageStartedAt;
    stageStartedAt = now;
    const width = Math.ceil(w);
    const height = Math.ceil(h);
    const generationBefore = runtime.sharedSvgPathAtlas.generationCount;
    const scene = {
      width,
      height,
      ...await decorate(serializeToScene(root, {
        viewportWidth: width,
        viewportHeight: height,
      }), runtime),
    };
    now = performance.now();
    stages.decorationMilliseconds = now - stageStartedAt -
      stages.pathPreparationMilliseconds;
    stageStartedAt = now;
    const renderPathTimings = {
      preparationMilliseconds: 0,
      atlasMilliseconds: 0,
    };
    const result = await runtime.renderScenePixels(scene, 1, {
      background: { r: 0, g: 0, b: 0, a: 0 },
      svgPathStageTimings: renderPathTimings,
    });
    now = performance.now();
    stages.pathPreparationMilliseconds += renderPathTimings.preparationMilliseconds;
    stages.atlasMilliseconds = renderPathTimings.atlasMilliseconds;
    stages.rasterMilliseconds = result.performance.rasterMilliseconds -
      stages.atlasMilliseconds;
    stages.scenePreparationMilliseconds = now - stageStartedAt -
      result.performance.rasterMilliseconds -
      renderPathTimings.preparationMilliseconds;
    stages.pathGenerationCount =
      runtime.sharedSvgPathAtlas.generationCount - generationBefore;
    releaseBoxSnapshot(result.boxes);
    stages.totalMilliseconds = performance.now() - startedAt;
    svgImageTimings?.push(Object.freeze(stages));
    return result;
  }

  function registeredImageEntry(descriptor) {
    const resolved = prepareImageProfile(descriptor);
    return {
      width: resolved.width,
      height: resolved.height,
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

  // (resource identifier or src) -> joined engine image index once the
  // image has decoded and registered. The miss path below read the file
  // from disk on every frame for every node showing it.
  const imageJoinByKey = new Map();
  // A broken image paints nothing, as in Chrome: its fetch failed, or its
  // bytes did not decode. The failure is kept per resource, and a decode
  // failure also per resolved URL, so a later frame does not fetch or
  // decode the image again.
  const brokenImageByKey = new Map();
  const brokenImageByCacheKey = new Map();
  // Image loads in flight, by the same key as imageJoinByKey, from the
  // start of the fetch until the registration that consumes the load
  // (imageIndexFor). resolveImageIndices starts every load of a frame at
  // once and registers them in node order, so the engine image indices,
  // the resource updates and the broken-image reports keep that order.
  // A load settles to { broken }, { cacheKey, entry } (entry is null when
  // the resolved URL is already registered or broken), or { thrown } (a
  // resolver contract error or a Sandom bug, thrown at registration).
  const pendingImageLoadByKey = new Map();
  // Resolved URL -> decode (or SVG raster) of its bytes, until the
  // registration of the entry, so two resources with one resolved URL
  // decode once.
  const decodedImageByCacheKey = new Map();

  function startImageLoad(
    src,
    resolveResource,
    resourceIdentifier,
    svgImageTimings,
  ) {
    const joinKey = resourceIdentifier ?? src;
    if (
      imageJoinByKey.has(joinKey) || brokenImageByKey.has(joinKey) ||
      pendingImageLoadByKey.has(joinKey)
    ) {
      return;
    }
    pendingImageLoadByKey.set(
      joinKey,
      loadImage(src, resolveResource, svgImageTimings).catch((thrown) => ({
        thrown,
      })),
    );
  }

  // Gives each broken image to onImageLoadError on each frame, with the
  // scene node and the property that own it; the caller records the
  // diagnostic and dispatches `error`. Without onImageLoadError, the
  // failure fails the frame: nothing can record it.
  async function imageIndexFor(
    src,
    resolveResource = null,
    resourceIdentifier,
    onImageLoadError = null,
    ownerNode = null,
    ownerProperty = null,
    svgImageTimings = null,
  ) {
    const joinKey = resourceIdentifier ?? src;
    const joined = imageJoinByKey.get(joinKey);
    if (joined !== undefined) return joined;
    const resourceHandle = imageResourceFor(src, resourceIdentifier);
    let broken = brokenImageByKey.get(joinKey);
    if (broken === undefined) {
      startImageLoad(src, resolveResource, resourceIdentifier, svgImageTimings);
      const pending = pendingImageLoadByKey.get(joinKey);
      const loaded = await pending;
      if (pendingImageLoadByKey.get(joinKey) === pending) {
        pendingImageLoadByKey.delete(joinKey);
      }
      // Another frame awaited the same load and registered it first.
      const joinedMeanwhile = imageJoinByKey.get(joinKey);
      if (joinedMeanwhile !== undefined) return joinedMeanwhile;
      broken = brokenImageByKey.get(joinKey);
      if (broken === undefined) {
        let registered;
        try {
          registered = registerLoadedImage(loaded, resourceHandle);
        } catch (error) {
          core.resourceUpdate(resourceHandle, 2, 0, 0, false, 1);
          throw error;
        }
        if (typeof registered === "number") {
          const join = joinEngineResource(resourceHandle, registered);
          imageJoinByKey.set(joinKey, join);
          return join;
        }
        broken = registered;
        core.resourceUpdate(resourceHandle, 2, 0, 0, false, 1);
        brokenImageByKey.set(joinKey, broken);
      }
    }
    if (!onImageLoadError) throw broken.error;
    onImageLoadError({
      node: ownerNode,
      property: ownerProperty,
      requestedURL: src,
      failure: broken.failure,
      error: broken.error,
    });
    return undefined;
  }

  function undecodableImage(cacheKey, cause) {
    const broken = Object.freeze({
      failure: "decode",
      error: new Error(`Image ${cacheKey}: ${cause.message}`, { cause }),
    });
    brokenImageByCacheKey.set(cacheKey, broken);
    return broken;
  }

  // Fetches and decodes one image without registering it; see
  // pendingImageLoadByKey for the result.
  async function loadImage(src, resolveResource, svgImageTimings) {
    let resource;
    try {
      resource = resolveResource
        ? await resolveResource({ requestedURL: src, kind: "image" })
        : { bytes: await readBinaryFile(src) };
    } catch (cause) {
      return {
        broken: Object.freeze({
          failure: "fetch",
          error: new Error(
            `Image ${src}: resource resolution failed: ${cause.message ?? String(cause)}`,
            { cause },
          ),
        }),
      };
    }
    const bytes = resource?.bytes;
    const cacheKey = resource?.cacheKey ?? resource?.finalURL ?? src;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Image resolver must return Uint8Array bytes");
    }
    if (brokenImageByCacheKey.has(cacheKey) || imageIndexBySrc.has(cacheKey)) {
      return { cacheKey, entry: null };
    }
    let decoded = decodedImageByCacheKey.get(cacheKey);
    if (decoded === undefined) {
      decoded = decodeImageEntry(bytes, cacheKey, svgImageTimings);
      decodedImageByCacheKey.set(cacheKey, decoded);
      // A failed decode is not kept: a later frame decodes again. An
      // undecodable image is kept in brokenImageByCacheKey instead.
      const forget = () => decodedImageByCacheKey.delete(cacheKey);
      decoded.then((entry) => {
        if (entry === null) forget();
      }, forget);
    }
    return { cacheKey, entry: await decoded };
  }

  // The registration entry of the bytes, or null when they do not decode
  // (brokenImageByCacheKey then holds the failure).
  async function decodeImageEntry(bytes, cacheKey, svgImageTimings) {
    let svgSource;
    try {
      svgSource = svgImageSource(bytes);
    } catch (cause) {
      // The bytes start like XML text but are not UTF-8.
      undecodableImage(cacheKey, cause);
      return null;
    }
    let descriptor;
    try {
      descriptor = svgSource === null
        ? await decodeImage(bytes)
        : await rasterizeSvgImage(svgSource, cacheKey, svgImageTimings);
    } catch (cause) {
      // A raster decoder rejects bytes it cannot decode with an Error or
      // a codec error. A TypeError or a ReferenceError is a Sandom bug.
      const undecodable = svgSource === null
        ? !(cause instanceof TypeError || cause instanceof ReferenceError)
        : cause instanceof UndecodableSvgImageError;
      if (!undecodable) {
        throw new Error(`Image ${cacheKey}: ${cause.message}`, { cause });
      }
      undecodableImage(cacheKey, cause);
      return null;
    }
    return registeredImageEntry(descriptor);
  }

  // The registered image index of a load, or a broken image record
  // { failure: "fetch" | "decode", error }. Called in node order.
  function registerLoadedImage(loaded, resourceHandle) {
    if (Object.hasOwn(loaded, "thrown")) throw loaded.thrown;
    if (loaded.broken !== undefined) return loaded.broken;
    const { cacheKey, entry } = loaded;
    const broken = brokenImageByCacheKey.get(cacheKey);
    if (broken !== undefined) return broken;
    let imageIndex = imageIndexBySrc.get(cacheKey);
    if (imageIndex !== undefined) {
      const registered = imagePixelsByIndex.get(imageIndex);
      core.resourceUpdate(
        resourceHandle,
        1,
        registered.width,
        registered.height,
      );
      return imageIndex;
    }
    if (entry === null) {
      throw new Error(
        `Image ${cacheKey}: the load skipped its decode, but the resolved URL is neither registered nor broken`,
      );
    }
    if (nextImageIndex >= IMAGE_TABLE_MAX_ENTRIES) {
      throw new RangeError(
        `IMAGE_TABLE overflow: more than ${IMAGE_TABLE_MAX_ENTRIES} images in one renderer`,
      );
    }
    imageIndex = nextImageIndex++;
    const measurement = globalThis[resourceMeasurementKey];
    engine.exports.register_image(imageIndex, entry.width, entry.height);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "image.register",
        direction: "host-to-engine",
        bytes: 12,
        crossings: 0,
        allocations: 0,
        allocationBytes: 0,
      });
    }
    imageIndexBySrc.set(cacheKey, imageIndex);
    imagePixelsByIndex.set(imageIndex, entry);
    decodedImageByCacheKey.delete(cacheKey);
    core.resourceUpdate(resourceHandle, 1, entry.width, entry.height, true);
    return imageIndex;
  }

  function canvasImageIndexFor(source) {
    if (
      source.resourceHandle !== undefined &&
      !canvasResourceHandles.has(source.sourceIdentifier)
    ) {
      core.resourceRetain(source.resourceHandle);
      canvasResourceHandles.set(source.sourceIdentifier, source.resourceHandle);
    }
    let imageIndex = imageIndexByCanvasSource.get(source);
    if (imageIndex === undefined) {
      if (nextImageIndex >= IMAGE_TABLE_MAX_ENTRIES) {
        throw new RangeError(
          `IMAGE_TABLE overflow: more than ${IMAGE_TABLE_MAX_ENTRIES} images in one renderer`,
        );
      }
      imageIndex = nextImageIndex++;
      imageIndexByCanvasSource.set(source, imageIndex);
    }
    const measurement = globalThis[resourceMeasurementKey];
    engine.exports.register_image(imageIndex, source.width, source.height);
    if (measurement) {
      measurement.record({
        category: "resources",
        operation: "canvas.register",
        direction: "host-to-engine",
        bytes: 12,
        crossings: 0,
        allocations: 0,
        allocationBytes: 0,
      });
    }
    imagePixelsByIndex.set(imageIndex, source);
    return source.resourceHandle === undefined
      ? imageIndex
      : joinEngineResource(source.resourceHandle, imageIndex);
  }

  function imagePixelsFor(imageIndex) {
    return imagePixelsByIndex.get(imageIndex);
  }

  // Synchronous counterpart of imageIndexFor — same "throw rather than
  // fall back to real async I/O" contract as fontIndexForSync above. It
  // uses the same key as imageIndexFor: a resolver can register an image
  // under its final URL, which differs from the node's src.
  function imageIndexForSync(src, resourceIdentifier) {
    const joinKey = resourceIdentifier ?? src;
    const joined = imageJoinByKey.get(joinKey);
    if (joined !== undefined) return joined;
    if (brokenImageByKey.has(joinKey)) return undefined;
    throw new Error(
      `imageIndexForSync: image "${src}" (resource key ${JSON.stringify(joinKey)}) not registered yet — synchronous layout-getters require the tree to have been rendered (or this image otherwise pre-warmed) at least once already`,
    );
  }

  // A node without an image, canvas source, background layer or mask keeps
  // its identity (and the array keeps its own when nothing at all needs an
  // index): copying a DOM-backed node evaluates its deferred text decode,
  // and a text-bearing page has thousands of them.
  function resolveImageIndicesSync(nodes, imageSources = new Map()) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      let next = n;
      if (n.src) {
        next = {
          ...next,
          imageIndex: imageIndexForSync(n.src, n.resourceIdentifier),
        };
      }
      if (n.canvasSourceIdentifier !== undefined) {
        const source = imageSources.get(n.canvasSourceIdentifier);
        if (!source) {
          throw new Error(
            `Missing canvas image source ${n.canvasSourceIdentifier}`,
          );
        }
        next = { ...next, imageIndex: canvasImageIndexFor(source) };
      }
      if (n.backgroundImages && n.backgroundImages.length) {
        const resolvedLayers = n.backgroundImages.map((
          layer,
        ) => (layer.src
          ? {
            ...layer,
            imageIndex: imageIndexForSync(layer.src, layer.resourceIdentifier),
          }
          : layer)
        );
        next = { ...next, resolvedBackgroundImages: resolvedLayers };
      }
      if (n.masks && n.masks.length) {
        const resolvedMasks = n.masks.map((
          layer,
        ) => (layer.src
          ? {
            ...layer,
            imageIndex: imageIndexForSync(layer.src, layer.resourceIdentifier),
          }
          : layer)
        );
        next = { ...next, resolvedMasks };
      }
      if (next !== n && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  // render()'s `images` option wants imageIndex -> { width, height, pixels }
  // (RGBA8) for the CMD_IMAGE GPU-texture-per-draw upload. UNLIKE
  // buildTextRenderResources, this doesn't need a command-buffer walk to
  // discover which images are actually used — imagePixelsByIndex already has
  // every registered image's decoded pixels, keyed by the same index
  // CMD_IMAGE commands reference, so the whole cache can be handed to
  // render() directly.
  function buildImageRenderResources() {
    return imagePixelsByIndex;
  }
  function synchronizeImageRasterResources() {
    for (const [imageIndex, image] of imagePixelsByIndex) {
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

  // Bitmap glyphs (plans/PLAN-color-glyphs.md slice 2): a CMD_IMAGE with
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
  function synchronizeGlyphRasterResources(atlases, requestSnapshot) {
    if (synchronizedGlyphRequestSnapshot === requestSnapshot && synchronizedGlyphAtlases === atlases) {
      let current = true;
      for (const [fontIndex, entry] of atlases) {
        const previous = synchronizedGlyphRasterRevisions.get(fontIndex);
        if (previous?.atlas !== entry.atlas || previous.revision !== entry.atlas.revision ||
          previous.italicFace !== (entry.italicFace ? 1 : 0)) {
          current = false;
          break;
        }
      }
      if (current) return;
    }
    const requests = new DataView(requestSnapshot.buffer, requestSnapshot.byteOffset, requestSnapshot.byteLength);
    const rowCount = requests.getUint32(0, true);
    let first = 0;
    while (first < rowCount) {
      const fontIndex = requests.getUint16(GLYPH_REQUEST_HEADER_SIZE + first * GLYPH_REQUEST_ROW_SIZE, true);
      let end = first + 1;
      while (end < rowCount && requests.getUint16(GLYPH_REQUEST_HEADER_SIZE + end * GLYPH_REQUEST_ROW_SIZE, true) === fontIndex) end++;
      const entry = atlases.get(fontIndex);
      if (!entry) {
        throw new Error(`Glyph request fontIndex ${fontIndex} has no held atlas; acquire every published font group`);
      }
      const revision = entry.atlas.revision;
      const italicFace = entry.italicFace ? 1 : 0;
      const previous = synchronizedGlyphRasterRevisions.get(fontIndex);
      if (previous?.atlas !== entry.atlas || previous.revision !== revision ||
        previous.italicFace !== italicFace || previous.requestSnapshot !== requestSnapshot) {
        const pointer = engine.exports.raster_resource_table_reserve(RASTER_RESOURCE_GLYPH, fontIndex, end - first);
        if (pointer === 0) {
          throw new Error(`Raster glyph resource ${fontIndex} could not reserve ${end - first} rows; reduce the publication size`);
        }
        const target = new DataView(engine.memory.buffer);
        for (let index = first; index < end; index++) {
          const source = GLYPH_REQUEST_HEADER_SIZE + index * GLYPH_REQUEST_ROW_SIZE;
          const glyphId = requests.getUint16(source + 12, true);
          const weight = requests.getUint16(source + 2, true);
          const opticalSize = requests.getFloat32(source + 4, true);
          const fontSize = requests.getFloat32(source + 8, true);
          const info = entry.atlas.glyphInfoFloats(glyphId, weight, opticalSize, fontSize);
          if (info === null) {
            throw new Error(`Held atlas for font ${fontIndex} is missing glyph ${glyphId}, weight ${weight}, optical size ${opticalSize}, CSS size ${fontSize}; acquire the complete request set`);
          }
          const destination = pointer + (index - first) * RASTER_RESOURCE_GLYPH_ROW_SIZE;
          target.setUint16(destination, glyphId, true);
          target.setUint16(destination + 2, weight, true);
          target.setFloat32(destination + 4, opticalSize, true);
          target.setFloat32(destination + 8, fontSize, true);
          new Float32Array(engine.memory.buffer, destination + 12, 13).set(info.subarray(0, 13));
        }
        if (engine.exports.raster_resource_table_set_metadata(RASTER_RESOURCE_GLYPH, fontIndex, italicFace) !== 1) {
          throw new Error(`Raster glyph resource ${fontIndex} rejected italic-face metadata ${italicFace}`);
        }
        synchronizedGlyphRasterRevisions.set(fontIndex, { atlas: entry.atlas, revision, italicFace, requestSnapshot });
      }
      first = end;
    }
    synchronizedGlyphRequestSnapshot = requestSnapshot;
    synchronizedGlyphAtlases = atlases;
  }

  function synchronizePathRasterResources(atlas, pathIndices) {
    const { range } = atlas.getMsdfParams();
    for (const pathIndex of new Set(pathIndices)) {
      const info = atlas.getPathByIndex(pathIndex);
      if (!info) {
        throw new Error(`raster path resource ${pathIndex} is unresolved`);
      }
      const pointer = engine.exports.raster_resource_table_reserve(
        RASTER_RESOURCE_PATH,
        pathIndex,
        1,
      );
      if (pointer === 0) {
        throw new Error(`raster path resource ${pathIndex} could not be reserved`);
      }
      new Float32Array(engine.memory.buffer, pointer, 10).set([
        info.u,
        info.v,
        info.uW,
        info.vH,
        info.pixelW,
        info.pixelH,
        info.bboxXMin,
        info.bboxYMin,
        info.bboxXMax,
        info.bboxYMax,
      ]);
      if (
        engine.exports.raster_resource_table_set_metadata(
          RASTER_RESOURCE_PATH,
          pathIndex,
          atlas.coverageMode ? -range : range,
        ) !== 1
      ) {
        throw new Error(`raster path resource ${pathIndex} metadata was rejected`);
      }
    }
  }

  // The raster path resources of the frame's atlas for `pathIndices` after
  // the color glyph cache wrote its own atlas's: a path the frame's atlas
  // holds as it holds it, any other absent.
  function restorePathRasterResources(pathIndices) {
    for (const pathIndex of new Set(pathIndices)) {
      if (sharedSvgPathAtlas.getPathByIndex(pathIndex)) {
        synchronizePathRasterResources(sharedSvgPathAtlas, [pathIndex]);
      } else {
        engine.exports.raster_resource_table_release(RASTER_RESOURCE_PATH, pathIndex);
      }
    }
  }

  // SVG path registration (design/svg-rendering.md, Tier B): pathIndex is a purely JS-side
  // handle (never interpreted by WAT beyond forwarding it through
  // CMD_SVG_PATH, see LAYOUT_NODE_OFFSET_SVG_PATH_INDEX's doc in layout.js)
  // mapping to the (pathDef, fillRule) pair the rasterizer needs at draw
  // time to resolve an atlas UV. UNLIKE images, there's no WASM register_*
  // call — the shape's bbox (which WAT DOES need, to compute the dest rect)
  // is written directly into the SVG geometry pool by writeSvgShape, same
  // as every other Tier A shape's geometry.
  const svgPathIndexByKey = new Map(); // "pathDef|fillRule[|stroke...]" -> pathIndex
  const svgPathDefByIndex = new Map(); // pathIndex -> { pathDef, fillRule, stroke? }
  let svgPathIndexCount = 0;
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
    synchronizePathRasterResources,
    restorePathRasterResources,
  });
  engine.exports.color_glyph_cache_enable(1);

  // Plain (not async) — no await in this body ever, unlike svgPathBbox
  // below it (which needs the wasm atlas module). Kept non-async
  // deliberately so the synchronous layout-getter fast path
  // (resolveSvgPathIndicesSync) can call it directly without an
  // async/sync split of its own; every existing call site already awaits
  // it inside an async function, where awaiting a non-Promise value is a
  // harmless passthrough.
  function svgPathIndexFor(pathDef, fillRule) {
    const key = `${pathDef}|${fillRule}`;
    if (svgPathIndexByKey.has(key)) return svgPathIndexByKey.get(key);
    const pathIndex = nextSvgPathIndex();
    svgPathIndexByKey.set(key, pathIndex);
    svgPathDefByIndex.set(pathIndex, { pathDef, fillRule });
    return pathIndex;
  }

  // Indices from COLOR_GLYPH_PATH_INDEX_BASE up name color glyph outlines.
  function nextSvgPathIndex() {
    const pathIndex = svgPathIndexCount++;
    if (pathIndex >= COLOR_GLYPH_PATH_INDEX_BASE) {
      throw new Error(
        `SVG path index ${pathIndex} reaches the color glyph path range at ${COLOR_GLYPH_PATH_INDEX_BASE}; ` +
          "a renderer holds at most that many distinct SVG paths, so render fewer distinct paths with one renderer",
      );
    }
    return pathIndex;
  }

  // S5: a SEPARATE opaque index for the stroke's own filled-outline shape —
  // see LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX's own comment in layout.js
  // for why this can't share NODE_SVG_PATH_INDEX's slot (fill and stroke
  // paint as two independent Chrome layers, each needing its own atlas
  // entry/CMD_SVG_PATH draw). Keyed by pathDef+fillRule+stroke params
  // together — a node's stroke can change independently of its fill, and
  // two DIFFERENT nodes sharing the same `d` but different stroke-width
  // must NOT share an atlas entry.
  // Plain (not async) — same rationale as svgPathIndexFor above.
  function svgStrokePathIndexFor(pathDef, fillRule, stroke) {
    const key = `${pathDef}|${fillRule}|stroke:${JSON.stringify(stroke)}`;
    if (svgPathIndexByKey.has(key)) return svgPathIndexByKey.get(key);
    const pathIndex = nextSvgPathIndex();
    svgPathIndexByKey.set(key, pathIndex);
    svgPathDefByIndex.set(pathIndex, { pathDef, fillRule, stroke });
    return pathIndex;
  }

  // The outline of a color glyph layer (plans/PLAN-color-glyphs.md): the
  // engine's path slot names a registered font and a glyph; its outline at
  // the shaping scale becomes a `d` string in font units, y down — the box
  // the engine measured for the slot's CMD_SVG_PATH dest rect.
  const colorGlyphPathDefs = new Map(); // pathIndex -> { key, def }
  // Relative agreement of the engine's layer box with the atlas bounds.
  // Both measure the same f32 outline coordinates; the engine stores its
  // box (curve extrema included) in f32, so a curve extremum may round
  // differently by an f32 step (2^-23 relative). Measured 2026-10-05 on
  // the 120 box corners of test/text_color_glyph_test.js: 0.
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
  // its proportions within the box matter.
  const BUILTIN_PATH_DEFS = new Map([
    [BUILTIN_PATH_DISCLOSURE_RIGHT, { pathDef: "M0 0L86 50L0 100Z", fillRule: "nonzero" }],
    [BUILTIN_PATH_DISCLOSURE_LEFT, { pathDef: "M100 0L14 50L100 100Z", fillRule: "nonzero" }],
    [BUILTIN_PATH_DISCLOSURE_DOWN, { pathDef: "M0 7L50 93L100 7Z", fillRule: "nonzero" }],
  ]);

  // The path a CMD_SVG_PATH index names: a host SVG path, a color glyph
  // outline, or a built-in outline.
  function pathDefForIndex(pathIndex) {
    if (pathIndex >= BUILTIN_PATH_INDEX_BASE) {
      const def = BUILTIN_PATH_DEFS.get(pathIndex);
      if (!def) throw new Error(`CMD_SVG_PATH names built-in path ${pathIndex}, which the host does not define`);
      return def;
    }
    return pathIndex >= COLOR_GLYPH_PATH_INDEX_BASE
      ? colorGlyphPathDef(pathIndex)
      : svgPathDefByIndex.get(pathIndex);
  }

  // polygon/polyline (Tier B): points -> an equivalent `d`
  // string, then reuse EVERY bit of the path pipeline (SvgPathAtlas,
  // CMD_SVG_PATH, generate_path_msdf_var) unchanged — polygon closes with Z
  // (SVG semantics: always a closed fillable shape), polyline does not
  // (SVG semantics: an open, unclosed contour — still fillable per spec,
  // the fill just implicitly closes straight back to the start point, but
  // the STROKE, when S5 lands, must not draw that implicit closing edge).
  function pointsToPathDef(points, closed) {
    if (!points || points.length < 2) return "";
    const cmds = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`);
    if (closed) cmds.push("Z");
    return cmds.join(" ");
  }

  // A Tier A shape carrying a real dash spec or a gradient stroke,
  // re-expressed as the equivalent Tier B path node (same fill, same
  // stroke, same paint order). The border ring of a Tier A shape has one
  // solid colour; only a path's stroke outline is a command of its own that
  // a gradient can paint. Returns the node unchanged when it isn't Tier A,
  // has no usable stroke, or its stroke is solid and its dasharray
  // normalizes away — so the ordinary Tier A lowering, which is cheaper and
  // needs no atlas entry, stays the path for every solid undashed shape.
  function tierAAsPath(node) {
    if (!SVG_TIER_A_LOWERABLE.has(node.display)) return node;
    const stroke = svgStrokeParamsFor(node);
    if (!stroke) return node;
    if (stroke.dashArray === undefined && !node.svgStrokeGradient) return node;
    const d = svgShapeToPathDef(node);
    // A shape with no outline (a zero width, height or radius) renders
    // nothing, its stroke included (SVG 2 §10.2-10.4).
    if (!d) return node.svgStrokeGradient ? { ...node, svgStrokeGradient: undefined } : node;
    // A line has no fill (SVG 2 §10.5); as a path it would take one.
    return node.display === "svg-line"
      ? { ...node, display: "svg-path", d, fill: "none" }
      : { ...node, display: "svg-path", d };
  }

  const SVG_TIER_A_LOWERABLE = new Set([
    "svg-rect",
    "svg-circle",
    "svg-ellipse",
    "svg-line",
  ]);

  // The path bbox is needed by the scene writer before its on-screen size
  // is known. Measure the same normalized shape the MSDF generator uses,
  // without generating a throwaway distance field at an arbitrary bucket.
  async function svgPathBbox(pathDef, fillRule) {
    return await sharedSvgPathAtlas.measurePathBounds(pathDef, fillRule);
  }

  // Synchronous layout getters use the same geometry-only measurement;
  // the atlas throws if its wasm module has not already loaded.
  function svgPathBboxSync(pathDef, fillRule) {
    return sharedSvgPathAtlas.measurePathBoundsSync(pathDef, fillRule);
  }

  // Stroke bounds depend on Skia's expanded outline, including joins and
  // dashes. The path atlas supplies those bounds with its first stroke entry.
  const STROKE_BBOX_WARMUP_SCREEN_SIZE = 48;
  async function svgStrokePathBbox(pathDef, fillRule, stroke) {
    await sharedSvgPathAtlas.ensurePaths([{
      pathDef,
      fillRule,
      screenSize: STROKE_BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      STROKE_BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  function svgStrokePathBboxSync(pathDef, fillRule, stroke) {
    sharedSvgPathAtlas.ensurePathsSync([{
      pathDef,
      fillRule,
      screenSize: STROKE_BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    }]);
    const info = sharedSvgPathAtlas.getPath(
      pathDef,
      fillRule,
      STROKE_BBOX_WARMUP_SCREEN_SIZE,
      stroke,
    );
    if (!info) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: info.bboxXMin,
      yMin: info.bboxYMin,
      xMax: info.bboxXMax,
      yMax: info.bboxYMax,
    };
  }

  // SVG stroke-dasharray's own error-recovery rule: an odd-length list
  // means "duplicate it to make it even" (e.g. [5] -> [5,5], [5,3,2] ->
  // [5,3,2,5,3,2]); a negative value or a list that's empty/sums to 0
  // means "treat as if stroke-dasharray were absent" (solid stroke). This
  // mirrors SVG's own dasharray normalization, applied once here so both
  // the atlas cache key and the wasm call see the SAME normalized array
  // sandom promises to render, not the raw author-provided one.
  function normalizeDashArray(dashArray) {
    if (!dashArray || dashArray.length === 0) return null;
    if (dashArray.some((v) => v < 0)) return null;
    const normalized = dashArray.length % 2 === 0
      ? dashArray
      : [...dashArray, ...dashArray];
    if (normalized.every((v) => v === 0)) return null;
    return normalized;
  }

  // A node's stroke params as SkStroke/SkDashPath expect them (numeric
  // cap/join, normalized dasharray), or null if the node has no usable
  // stroke at all (stroke:none/undefined without a svgStrokeGradient, or
  // strokeWidth<=0 — matches writeSvgShape's own svgHasStroke gate in
  // engine.wat for Tier A shapes, kept here in JS since Tier B's stroke
  // needs its own atlas entry BEFORE emission, unlike Tier A's border-ring
  // trick which reads the node fields directly at emit time).
  function svgStrokeParamsFor(node) {
    if (
      (node.stroke === undefined || node.stroke === "none") &&
      !node.svgStrokeGradient
    ) return null;
    const width = node.strokeWidth ?? 1;
    if (!(width > 0)) return null;
    return {
      width,
      cap: { butt: 0, round: 1, square: 2 }[node.strokeLinecap] ?? 0,
      join: { miter: 0, round: 1, bevel: 2 }[node.strokeLinejoin] ?? 0,
      miterLimit: node.strokeMiterlimit ?? 4,
      dashArray: normalizeDashArray(node.strokeDasharray) ?? undefined,
      dashPhase: node.strokeDashoffset ?? 0,
    };
  }

  // Starts the loads of a background or mask layer list; false when the
  // node has no layers.
  function startLayerImageLoads(layers, resolveResource, svgImageTimings) {
    if (!(layers && layers.length)) return false;
    for (const layer of layers) {
      if (layer.src) {
        startImageLoad(
          layer.src,
          resolveResource,
          layer.resourceIdentifier,
          svgImageTimings,
        );
      }
    }
    return true;
  }

  async function resolveImageIndices(
    nodes,
    resolveResource = null,
    imageSources = new Map(),
    onImageLoadError = null,
    svgImageTimings = null,
  ) {
    // Copy-on-change, like resolveImageIndicesSync: a page of text has
    // thousands of nodes with no image of any kind, and copying a
    // DOM-backed node evaluates its deferred text decode.
    //
    // The first pass starts the fetch and decode of every image of the
    // frame at once. The second registers them in node order (src, canvas,
    // background layers, mask layers, border image), so the engine image
    // indices and the broken-image reports do not depend on which load
    // finishes first.
    const imageNodeIndices = [];
    for (let index = 0; index < nodes.length; index++) {
      const n = nodes[index];
      let hasImage = n.canvasSourceIdentifier !== undefined;
      if (n.src) {
        startImageLoad(
          n.src,
          resolveResource,
          n.resourceIdentifier,
          svgImageTimings,
        );
        hasImage = true;
      }
      if (
        startLayerImageLoads(n.backgroundImages, resolveResource, svgImageTimings)
      ) {
        hasImage = true;
      }
      if (startLayerImageLoads(n.masks, resolveResource, svgImageTimings)) {
        hasImage = true;
      }
      if (n.borderImage && n.borderImage.src) {
        startImageLoad(
          n.borderImage.src,
          resolveResource,
          undefined,
          svgImageTimings,
        );
        hasImage = true;
      }
      if (hasImage) imageNodeIndices.push(index);
    }
    if (imageNodeIndices.length === 0) return nodes;
    const out = nodes.slice();
    for (const index of imageNodeIndices) {
      const n = nodes[index];
      let next = n;
      if (n.src) {
        next = {
          ...next,
          imageIndex: await imageIndexFor(
            n.src,
            resolveResource,
            n.resourceIdentifier,
            onImageLoadError,
            n,
            "src",
            svgImageTimings,
          ),
        };
      }
      if (n.canvasSourceIdentifier !== undefined) {
        const source = imageSources.get(n.canvasSourceIdentifier);
        if (!source) {
          throw new Error(
            `Missing canvas image source ${n.canvasSourceIdentifier}`,
          );
        }
        next = { ...next, imageIndex: canvasImageIndexFor(source) };
      }
      // background-image (P5c): independent of display type — a node can
      // have BOTH an <img> src (display:'image') and background-image
      // layers (any node) at once, hence the separate NODE_BACKGROUND_
      // IMAGE_INDEX-per-layer fields (see BG_LAYER_POOL's doc comment in
      // layout.js/engine.wat) instead of reusing NODE_IMAGE_INDEX.
      // node.backgroundImages is a list, CSS comma-list order (first =
      // TOP layer, matching author-facing CSS — the WAT emission side
      // reverses this since bottom-layer-paints-first per css-backgrounds-3
      // §3.8, not this resolution step).
      if (n.backgroundImages && n.backgroundImages.length) {
        const resolvedLayers = [];
        for (const layer of n.backgroundImages) {
          // A layer with no src is a legitimate authoring state (same
          // rationale as the <img> guard above) — writeBackgroundLayers'
          // own default (imageIndex ?? 0xFFFF) treats "no imageIndex" as
          // "none", so this layer still occupies a pool slot but paints
          // nothing (see $emitNodeRect's bgImageIndex != 0xFFFF guard).
          resolvedLayers.push(
            layer.src
              ? {
                ...layer,
                imageIndex: await imageIndexFor(
                  layer.src,
                  resolveResource,
                  layer.resourceIdentifier,
                  onImageLoadError,
                  n,
                  "background-image",
                  svgImageTimings,
                ),
              }
              : layer,
          );
        }
        next = { ...next, resolvedBackgroundImages: resolvedLayers };
      }
      // mask-image (P11): the same per-layer src resolution as
      // backgroundImages above, into its own resolved list (a node can have
      // both — a background layer list and a mask layer list — and they
      // reach two different pools).
      if (n.masks && n.masks.length) {
        const resolvedMasks = [];
        for (const layer of n.masks) {
          resolvedMasks.push(
            layer.src
              ? {
                ...layer,
                imageIndex: await imageIndexFor(
                  layer.src,
                  resolveResource,
                  layer.resourceIdentifier,
                  onImageLoadError,
                  n,
                  "mask-image",
                  svgImageTimings,
                ),
              }
              : layer,
          );
        }
        next = { ...next, resolvedMasks };
      }
      // border-image (P14): one source per node, not a layer list — the
      // shorthand has no comma syntax. Its own resolved field rather than
      // reusing imageIndex, because a node can have BOTH an <img> src and a
      // border-image.
      if (n.borderImage && n.borderImage.src) {
        next = {
          ...next,
          resolvedBorderImage: {
            ...n.borderImage,
            imageIndex: await imageIndexFor(
              n.borderImage.src,
              resolveResource,
              undefined,
              onImageLoadError,
              n,
              "border-image-source",
              svgImageTimings,
            ),
          },
        };
      }
      out[index] = next;
    }
    return out;
  }

  // svg-use (S6 step 2): a JS-side STRUCTURAL CLONE at scene-authoring time,
  // NOT a new runtime node kind or WAT concept at all (confirmed against
  // the real SVG 2 spec: "the 'use'
  // element does not itself establish a new viewport" when referencing a
  // plain shape — no clip, no new coordinate system, just a clone-in-place
  // with x/y composing as a plain translate appended AFTER the use's own
  // transform). Must run BEFORE every other preprocessing pass (resolveSvg
  // PathIndices included) since a cloned shape still needs its own path/bbox
  // resolved same as an authored one.
  //
  // This is NOT a 1:1 map like resolveImageIndices/resolveSvgPathIndices
  // above — a `svg-use` node's clone can be a WHOLE SUBTREE (any size), so
  // this REBUILDS the entire flat nodes array. The engine's OWN contiguity
  // rule is stricter than plain depth-first pre-order: a parent's DIRECT
  // children must occupy one contiguous block with NOTHING else (not even
  // a grandchild) interleaved between them (writeNode's own throw-on-
  // violation check; confirmed against this codebase's own existing
  // "reordered contiguous children" positive-control test, which places
  // EVERY node's direct children immediately, THEN appends each child's own
  // subtree afterward — level-order-per-branch, not strict pre-order). A
  // naive recursive pre-order rebuild (assign a child's index, then
  // immediately recurse into IT before moving to the next sibling) breaks
  // this the moment one child's own subtree has more than 1 node (exactly
  // what a svg-use child produces: a wrapper node PLUS its cloned
  // subtree) — the next sibling's freshly-assigned index would land AFTER
  // that whole subtree, no longer contiguous with the earlier siblings.
  // Fixed by processing nodes in a QUEUE (reserve every one of a node's
  // OWN direct children's indices as ONE contiguous block up front, then
  // queue each of THOSE children for its own later expansion) — this is
  // the same "reserve this level's slots before descending" shape a
  // level-order array-tree serialization already needs, applied here
  // specifically because svg-use is the first node kind whose own
  // "subtree" can be more than 1 node.
  //
  // Only handles a plain-shape href (step 2's own scope) — referencing an
  // `<svg>`/`<symbol>` (needs viewport/clip/width-height-override behavior)
  // is step 3, not yet implemented; that case is deliberately left
  // unhandled here (falls through to the generic clone below, which is
  // WRONG for that case — do not extend this function's scope without also
  // building step 3's own viewport-clip path).
  function resolveSvgUseNodes(nodes) {
    // Does this subtree (any depth) contain a svg-use node? If not, the
    // overwhelmingly common case (a scene with zero <use> at all) can skip
    // the whole rebuild and return the original array unchanged.
    if (!nodes.some((n) => n.display === "svg-use")) return nodes;

    const out = [];
    // Each queue entry is { newIndex, kind, ... } describing WORK still to
    // do at that already-reserved index — children not yet assigned/
    // reserved, so this level's siblings all got contiguous slots already.
    const queue = [];

    // Reserves ONE fresh contiguous slot for `originalIndex` (a node from
    // the ORIGINAL `nodes` array), queues its own children/expansion for
    // later, and returns the new index. Called once per entry in some
    // node's `children` array — so a sibling group's calls are all made
    // back-to-back, before any of THEIR OWN queued work runs, which is
    // exactly what keeps that sibling group contiguous.
    function reserveOriginal(originalIndex) {
      const n = nodes[originalIndex];
      const newIndex = out.length;
      out.push(null); // placeholder, filled in once this entry's queued work runs
      if (n.display === "svg-use") {
        if (n.href === undefined) {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex} is svg-use with no href`,
          );
        }
        if (nodes[n.href] === undefined) {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex}'s href=${n.href} does not exist`,
          );
        }
        if (nodes[n.href].display === "svg-use") {
          throw new Error(
            `resolveSvgUseNodes: node ${originalIndex}'s href=${n.href} is ITSELF a svg-use — chained <use> references are not supported`,
          );
        }
        queue.push({
          newIndex,
          kind: "use",
          useNode: n,
          sourceSceneNodeIndex: originalIndex,
        });
      } else {
        queue.push({
          newIndex,
          kind: "plain",
          src: n,
          sourceSceneNodeIndex: originalIndex,
        });
      }
      return newIndex;
    }
    // Same as reserveOriginal, but the referenced node came from a CLONE
    // (via a use's own href) rather than directly from `nodes` — kept as a
    // separate function (rather than a flag param) since a cloned node's
    // OWN children need to be reserved as clones too (recursive cloning),
    // never re-interpreting a clone's descendant as ANOTHER use reference
    // (chained <use> is unsupported, see reserveOriginal's own guard).
    function reserveClone(originalIndex, sourceSceneNodeIndex) {
      const src = nodes[originalIndex];
      const newIndex = out.length;
      out.push(null);
      queue.push({
        newIndex,
        kind: "clone",
        src,
        sourceSceneNodeIndex,
      });
      return newIndex;
    }

    reserveOriginal(0); // scene root — always lands at out[0], the same convention sceneHtml's renderNode(0) already relies on
    // BFS drain: `queue` only ever grows by exactly the reserved children
    // of whatever's dequeued next — since every reserve* call ALSO reserves
    // its OWN contiguous slot immediately (not deferred), draining the
    // queue in FIFO order naturally interleaves each level's worth of
    // reservations correctly across sibling subtrees.
    while (queue.length) {
      const entry = queue.shift();
      if (entry.kind === "plain") {
        const { src } = entry;
        const newChildren = src.children && src.children.length
          ? src.children.map((childIndex) => reserveOriginal(childIndex))
          : undefined;
        out[entry.newIndex] = {
          ...src,
          _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          ...(newChildren ? { children: newChildren } : {}),
        };
      } else if (entry.kind === "clone") {
        const { src } = entry;
        const newChildren = src.children && src.children.length
          ? src.children.map((childIndex) =>
            reserveClone(childIndex, entry.sourceSceneNodeIndex)
          )
          : undefined;
        out[entry.newIndex] = {
          ...src,
          _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          ...(newChildren ? { children: newChildren } : {}),
        };
      } else {
        // 'use': x/y (spec: "an additional translate(x,y), appended to the
        // RIGHT side of the transformation list") composes AFTER the use's
        // own transform, i.e. this node's own affine is `useTransform ∘
        // translate(x,y)`, matching composeAffine's own "outer ∘ inner"
        // convention (useTransform is outer, the x/y translate is inner,
        // closest to the referenced geometry). CONFIRMED against the real
        // spec text (not assumed) that x/y behave IDENTICALLY here whether
        // or not the reference establishes a viewport — no special case
        // needed for that part.
        const { useNode } = entry;
        const xy = {
          transform: { translate: { x: useNode.x ?? 0, y: useNode.y ?? 0 } },
        };
        const composed = composeAffine(
          resolveTransform(useNode),
          resolveTransform(xy),
        );
        const referenced = nodes[useNode.href];
        if (
          referenced.display === "svg" || referenced.display === "svg-symbol"
        ) {
          // S6 step 3: referencing a viewport-establishing element (a real
          // <svg> used as a definition, or a <symbol>) is genuinely
          // DIFFERENT from a plain-shape reference — confirmed via spec:
          // "the width and height properties on the 'use' element
          // override the values for the corresponding properties on a
          // referenced 'svg' or 'symbol' element" (falling back to the
          // referenced element's own value, then 100%/auto if neither
          // specifies one — the SAME fallback chain $resolveReplacedSize
          // already implements for an ordinary svg root's own width/
          // height, so passing `undefined` through when NEITHER side sets
          // one reaches that existing behavior for free, no new fallback
          // logic needed here). Per the confirmed design conclusion (no
          // new WAT-side kind needed): synthesize a CONCRETE display:'svg'
          // node carrying the composed transform, the resolved width/
          // height, and the referenced element's OWN viewBox/
          // preserveAspectRatio (properties of the referenced CONTENT,
          // never overridden by the use) — by the time WAT ever sees this
          // tree, it's just an ordinary svg root; <symbol>'s own "never
          // rendered unless referenced" semantics fall out entirely from
          // this node simply not existing in `nodes` at all until NOW.
          const newChildren = referenced.children && referenced.children.length
            ? referenced.children.map((childIndex) =>
              reserveClone(childIndex, entry.sourceSceneNodeIndex)
            )
            : undefined;
          out[entry.newIndex] = {
            display: "svg",
            transform: composed,
            width: useNode.width ?? referenced.width,
            height: useNode.height ?? referenced.height,
            boxSizing: referenced.boxSizing,
            viewBox: referenced.viewBox,
            preserveAspectRatio: referenced.preserveAspectRatio,
            ...(newChildren ? { children: newChildren } : {}),
            _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          };
        } else {
          // Plain shape/group reference (step 2's own case): wrap the
          // clone in a synthetic svg-group carrying the composed
          // transform. The clone's own root gets reserved as this
          // wrapper's ONLY child — reserveClone (not reserveOriginal)
          // since everything from here down is a copy, not an original
          // scene node.
          const clonedRootIndex = reserveClone(
            useNode.href,
            entry.sourceSceneNodeIndex,
          );
          out[entry.newIndex] = {
            display: "svg-group",
            transform: composed,
            children: [clonedRootIndex],
            _inspectionSourceNodeIndex: entry.sourceSceneNodeIndex,
          };
        }
      }
    }
    return out;
  }

  // Order-modified document order (CSS `order`, flex+grid — the Grid plan's
  // L1 ordering item). A flex or grid container's items lay out, place into
  // the automatic grid, and paint in ascending `order`, then tree order. The
  // engine consumes children strictly as a contiguous buffer block
  // (firstChild + count), so buffer order IS item order for layout, grid
  // automatic placement, and the paint walk alike — reordering the sibling
  // subtrees here, at scene-preprocessing time, gives all three consumers ONE
  // stable ordering with no engine-side `order` concept and no wire field.
  //
  // Same full-rebuild shape as resolveSvgUseNodes above (a sibling reorder
  // moves whole subtrees, which the contiguity rule turns into a rebuild),
  // including its fast path: a scene where every flex/grid sibling group is
  // already non-decreasing in `order` (the overwhelmingly common zero-`order`
  // case, and every serializeToScene scene — its own finalize step already
  // sorted) returns the original array unchanged, keeping caller-side index
  // maps valid. Array.prototype.sort is stable per specification, so equal
  // `order` values keep tree order.
  //
  // DOM source order and accessibility order are untouched: this reorders
  // only the render-scene array, never the DOM.
  const ORDER_CONTAINER_DISPLAYS = new Set([
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
  ]);

  function resolveOrderModifiedChildren(nodes) {
    let reorderNeeded = false;
    for (const n of nodes) {
      if (!n.children || n.children.length < 2) continue;
      if (!ORDER_CONTAINER_DISPLAYS.has(n.layoutDisplay ?? n.display)) continue;
      let previous = -Infinity;
      for (const childIndex of n.children) {
        const value = nodes[childIndex].order ?? 0;
        if (value < previous) {
          reorderNeeded = true;
          break;
        }
        previous = value;
      }
      if (reorderNeeded) break;
    }
    if (!reorderNeeded) return nodes;

    const out = [];
    const queue = [];
    function reserve(originalIndex) {
      const newIndex = out.length;
      out.push(null);
      queue.push({ newIndex, originalIndex });
      return newIndex;
    }
    reserve(0);
    while (queue.length) {
      const { newIndex, originalIndex } = queue.shift();
      const src = nodes[originalIndex];
      let childIndices = src.children;
      if (
        childIndices && childIndices.length > 1 &&
        ORDER_CONTAINER_DISPLAYS.has(src.layoutDisplay ?? src.display)
      ) {
        childIndices = childIndices.slice().sort(
          (a, b) => (nodes[a].order ?? 0) - (nodes[b].order ?? 0),
        );
      }
      const newChildren = childIndices && childIndices.length
        ? childIndices.map((childIndex) => reserve(childIndex))
        : undefined;
      out[newIndex] = {
        ...src,
        _inspectionSourceNodeIndex: src._inspectionSourceNodeIndex ??
          originalIndex,
        ...(newChildren ? { children: newChildren } : {}),
      };
    }
    return out;
  }

  // svg-path/svg-polygon/svg-polyline nodes need pathIndex + bbox resolved
  // BEFORE writeSvgShape (which is called synchronously inside a forEach,
  // unlike this async resolution step) — same "resolve async refs into a
  // plain field first" shape as resolveImageIndices above. polygon/polyline
  // derive their `d` from `points` (see pointsToPathDef) and are resolved
  // through the EXACT SAME path pipeline as svg-path — no separate atlas
  // entry point, no separate CMD opcode.
  // A DOM-backed path's definition, fill rule, and stroke: the core lowered
  // the path (a polygon's or polyline's points included) into the scene
  // node's `d`, and its record carries the fill rule and stroke paint.
  function coreSvgPath(node) {
    if (!node._coreSvgRequest) {
      throw new Error("DOM path lacks its producing native SVG request");
    }
    return node._coreSvgRequest;
  }

  // The path definition, fill rule, and stroke params of a path, polygon,
  // or polyline node, or null for any other node (or one without a path).
  function svgPathOf(n) {
    if (usesCoreRecord(n)) {
      if (n.d === undefined) return null;
      return coreSvgPath(n);
    }
    let d = n.d;
    if (n.display === "svg-polygon") {
      d = pointsToPathDef(n.points, /*closed=*/ true);
    } else if (n.display === "svg-polyline") {
      d = pointsToPathDef(n.points, /*closed=*/ false);
    } else if (n.display !== "svg-path") return null;
    if (!d) return null;
    return {
      d,
      fillRule: n.fillRule === "evenodd" ? "evenodd" : "nonzero",
      stroke: svgStrokeParamsFor(n),
    };
  }

  // An inline SVG shape's fill and stroke paint servers (svgFillPaintServer,
  // svgStrokePaintServer, src/dom/serialize.js) become the svgFillGradient
  // and svgStrokeGradient that paint over its native row, resolved against
  // the shape's bounding box: the one its geometry gives, or the measured
  // fill path's (SVG's object bounding box excludes the stroke). The engine
  // places a stroke gradient in the fill path's box, which a line's outline
  // leaves empty; the line's geometry box takes its place. An empty
  // bounding box has no objectBoundingBox gradient to paint, and the row
  // keeps its fallback paint. A userSpaceOnUse stroke still paints there,
  // but its gradient is placed in that box, so it is refused by name.
  function resolveSvgPaintServers(n) {
    const fill = n.svgFillPaintServer, stroke = n.svgStrokePaintServer;
    if (fill === undefined && stroke === undefined) return n;
    const bounds = (fill ?? stroke).bounds ?? n.resolvedPathBbox;
    if (!(bounds.xMax > bounds.xMin && bounds.yMax > bounds.yMin)) {
      if (stroke?.gradient.units === "userSpaceOnUse") {
        throw new Error(`unsupported userSpaceOnUse SVG stroke paint server on a shape with an empty bounding box (${bounds.xMax - bounds.xMin} x ${bounds.yMax - bounds.yMin}): give the gradient objectBoundingBox units or the shape an area`);
      }
      return n;
    }
    const next = { ...n };
    if (fill !== undefined) next.svgFillGradient = resolvedGradient(fill.gradient, bounds);
    if (stroke !== undefined) {
      next.svgStrokeGradient = resolvedGradient(stroke.gradient, bounds);
      const box = n.resolvedPathBbox;
      if (!(box.xMax > box.xMin && box.yMax > box.yMin)) next.resolvedPathBbox = bounds;
    }
    return next;
  }

  // The engine places a stroke gradient in the fill path's box, which a
  // line's outline leaves empty: an authored line lowered to its path
  // (tierAAsPath) places it in the line's geometry box, the object bounding
  // box its gradient was resolved against. A line along an axis has no
  // such box, so its gradient is refused by name.
  function lineStrokeGradientBox(raw, n) {
    if (raw.display !== "svg-line" || !n.svgStrokeGradient || usesCoreRecord(raw)) return n;
    const box = n.resolvedPathBbox;
    if (box.xMax > box.xMin && box.yMax > box.yMin) return n;
    const x1 = raw.x1 ?? 0, y1 = raw.y1 ?? 0, x2 = raw.x2 ?? 0, y2 = raw.y2 ?? 0;
    if (x1 === x2 || y1 === y2) {
      throw new Error(`unsupported gradient stroke on an svg-line along an axis (${x1},${y1} to ${x2},${y2}): its bounding box has no area to place the gradient in`);
    }
    return {
      ...n,
      resolvedPathBbox: { xMin: Math.min(x1, x2), yMin: Math.min(y1, y2), xMax: Math.max(x1, x2), yMax: Math.max(y1, y2) },
    };
  }

  async function resolveSvgPathIndices(nodes) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const raw = nodes[index];
      const n = tierAAsPath(raw);
      const path = svgPathOf(n);
      let next = n;
      if (path !== null) {
        const { d, fillRule } = path;
        const pathIndex = await svgPathIndexFor(d, fillRule);
        const bbox = await svgPathBbox(d, fillRule);
        next = { ...n, resolvedPathIndex: pathIndex, resolvedPathBbox: bbox };
        // S5: a stroked path/polygon/polyline ALSO needs the stroke's own
        // atlas entry + bbox, resolved here (before writeSvgShape, which
        // runs synchronously) exactly like the fill path above — see
        // svgStrokePathIndexFor's own comment for why this can't share the
        // fill's pathIndex/bbox.
        const stroke = path.stroke;
        if (stroke) {
          const strokePathIndex = await svgStrokePathIndexFor(
            d,
            fillRule,
            stroke,
          );
          const strokeBbox = await svgStrokePathBbox(d, fillRule, stroke);
          next = {
            ...next,
            resolvedStrokePathIndex: strokePathIndex,
            resolvedStrokePathBbox: strokeBbox,
          };
        }
      }
      next = lineStrokeGradientBox(raw, resolveSvgPaintServers(next));
      if (next !== raw && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  // Synchronous counterpart of resolveSvgPathIndices — throws if the
  // msdfgen wasm module has not loaded, rather than blocking a layout getter.
  function resolveSvgPathIndicesSync(nodes) {
    let out = null;
    for (let index = 0; index < nodes.length; index++) {
      const raw = nodes[index];
      const n = tierAAsPath(raw);
      const path = svgPathOf(n);
      let next = n;
      if (path !== null) {
        const { d, fillRule } = path;
        const pathIndex = svgPathIndexFor(d, fillRule);
        const bbox = svgPathBboxSync(d, fillRule);
        next = { ...n, resolvedPathIndex: pathIndex, resolvedPathBbox: bbox };
        const stroke = path.stroke;
        if (stroke) {
          const strokePathIndex = svgStrokePathIndexFor(d, fillRule, stroke);
          const strokeBbox = svgStrokePathBboxSync(d, fillRule, stroke);
          next = {
            ...next,
            resolvedStrokePathIndex: strokePathIndex,
            resolvedStrokePathBbox: strokeBbox,
          };
        }
      }
      next = lineStrokeGradientBox(raw, resolveSvgPaintServers(next));
      // A scene without any path keeps its array; every node without one
      // keeps its identity (see resolveImageIndicesSync).
      if (next !== raw && out === null) out = nodes.slice(0, index);
      if (out !== null) out.push(next);
    }
    return out ?? nodes;
  }

  function resolvePolygonCoordinate(value, dimension) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.endsWith("%")) {
      const percent = Number.parseFloat(value);
      if (Number.isFinite(percent)) return dimension * percent / 100;
    }
    throw new Error(
      `clipPath polygon: unsupported coordinate ${JSON.stringify(value)}`,
    );
  }

  function polygonClipPathDef(points, box) {
    if (!Array.isArray(points) || points.length < 3) {
      throw new Error(
        "clipPath polygon: points must contain at least three coordinate pairs",
      );
    }
    return points.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new Error(`clipPath polygon: point ${index} must be [x, y]`);
      }
      const x = resolvePolygonCoordinate(point[0], box.w);
      const y = resolvePolygonCoordinate(point[1], box.h);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    }).concat("Z").join(" ");
  }

  async function resolveClipPathIndices(nodes, boxes, deviceScale) {
    const out = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const clipPath = node.clipPath;
      if (
        !clipPath || (clipPath.kind !== "polygon" && clipPath.kind !== "path")
      ) {
        out.push(node);
        continue;
      }
      const fillRule = clipPath.fillRule === "evenodd" ? "evenodd" : "nonzero";
      const pathDef = clipPath.kind === "polygon"
        ? polygonClipPathDef(clipPath.points, boxes[index])
        : clipPath.d;
      if (typeof pathDef !== "string" || pathDef.trim() === "") {
        throw new Error(
          `clipPath ${clipPath.kind}: a non-empty path is required`,
        );
      }
      const pathIndex = svgPathIndexFor(pathDef, fillRule);
      const bbox = await svgPathBbox(pathDef, fillRule);
      out.push({
        ...node,
        clipPath: {
          ...clipPath,
          resolvedPathIndex: pathIndex,
          resolvedPathBbox: bbox,
          resolvedCoordinateScale: 1,
        },
      });
    }
    return out;
  }

  function resolveClipPathIndicesSync(nodes, boxes) {
    return nodes.map((node, index) => {
      const clipPath = node.clipPath;
      if (
        !clipPath || (clipPath.kind !== "polygon" && clipPath.kind !== "path")
      ) return node;
      const fillRule = clipPath.fillRule === "evenodd" ? "evenodd" : "nonzero";
      const pathDef = clipPath.kind === "polygon"
        ? polygonClipPathDef(clipPath.points, boxes[index])
        : clipPath.d;
      if (typeof pathDef !== "string" || pathDef.trim() === "") {
        throw new Error(
          `clipPath ${clipPath.kind}: a non-empty path is required`,
        );
      }
      const pathIndex = svgPathIndexFor(pathDef, fillRule);
      const bbox = svgPathBboxSync(pathDef, fillRule);
      return {
        ...node,
        clipPath: {
          ...clipPath,
          resolvedPathIndex: pathIndex,
          resolvedPathBbox: bbox,
          resolvedCoordinateScale: 1,
        },
      };
    });
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

  async function buildTextRenderResources(publication) {
    if (publication.glyphLease?.active === true) return publication;
    const preparationStartedAt = performance.now();
    const rows = new DataView(publication.requestSnapshot.buffer, publication.requestSnapshot.byteOffset, publication.requestSnapshot.byteLength);
    const resourceRequests = [];
    let group = null;
    for (let index = 0; index < publication.requestRowCount; index++) {
      const offset = GLYPH_REQUEST_HEADER_SIZE + index * GLYPH_REQUEST_ROW_SIZE;
      const fontIndex = rows.getUint16(offset, true);
      const weight = rows.getUint16(offset + 2, true);
      const opticalSize = rows.getFloat32(offset + 4, true);
      const fontSize = rows.getFloat32(offset + 8, true);
      if (rows.getUint16(offset + 14, true) !== 0) {
        throw new Error(`Glyph request row ${index} has reserved value ${rows.getUint16(offset + 14, true)}; expected zero`);
      }
      if (!group || group.fontIndex !== fontIndex || group.weight !== weight ||
        group.opticalSize !== opticalSize || group.devicePixelSize !== fontSize) {
        const fontBytes = fontBytesByIndex.get(fontIndex);
        if (!fontBytes) {
          throw new Error(`Glyph request fontIndex ${fontIndex} has no registered bytes; register its face before emission`);
        }
        group = { fontIndex, fontBytes, faceIndex: fontIdentityByIndex.get(fontIndex).faceIndex,
          glyphIds: [], weight, opticalSize, devicePixelSize: fontSize,
          variationWidth: fontVariationWidthByIndex.get(fontIndex), variationSlant: fontVariationSlantByIndex.get(fontIndex) };
        resourceRequests.push(group);
      }
      group.glyphIds.push(rows.getUint16(offset + 12, true));
    }
    const glyphLease = await publication.glyphResourceManager.acquire(resourceRequests, {
      generationBackend: publication.generationBackend,
    });
    const atlases = new Map();
    for (let index = 0; index < glyphLease.atlases.length; index++) {
      const fontIndex = resourceRequests[index].fontIndex;
      atlases.set(fontIndex, { atlas: glyphLease.atlases[index], italicFace: fontIsItalicFaceByIndex.get(fontIndex) ?? false });
    }
    const phaseMilliseconds = { ...glyphLease.glyphPerformance.phaseMilliseconds };
    phaseMilliseconds.otherPreparationMilliseconds += Math.max(0,
      performance.now() - preparationStartedAt - glyphLease.glyphPerformance.totalMilliseconds);
    const glyphPerformance = {
      requestedGlyphCount: glyphLease.glyphPerformance.requestedGlyphCount,
      cacheHitGlyphCount: glyphLease.glyphPerformance.cacheHitGlyphCount,
      generatedGlyphCount: glyphLease.glyphPerformance.generatedGlyphCount,
      outputTexelCount: glyphLease.glyphPerformance.outputTexelCount,
      generatedGlyphs: glyphLease.glyphPerformance.generatedGlyphs.map(({ requestIndex, ...glyph }) => ({
        fontIndex: resourceRequests[requestIndex].fontIndex, ...glyph,
      })),
      generationBackend: glyphLease.glyphPerformance.generationBackend,
      directAtlasPopulation: glyphLease.glyphPerformance.directAtlasPopulation,
      phaseMilliseconds,
    };
    return { ...publication, atlases, glyphLease, glyphPerformance };
  }

  // After emit_commands has written CMD_SVG_PATH commands, ensure
  // sharedSvgPathAtlas has an MSDF generated at the ACTUAL on-screen scale
  // each command implies — an atlas entry generated at the wrong scale
  // bucket renders blurry/aliased (see SvgPathAtlas's own scale-bucket doc
  // in atlas.js). destW/destH is the RAW bbox, not the on-screen footprint:
  // WAT stores the viewBox/CSS-transform affine SEPARATELY in the command's
  // own transform block rather than pre-applying it to the dest rect (see
  // design/svg-rendering.md invariant 3), so this must fold that
  // affine's linear-part scale in before taking the max dimension. Returns
  // the atlas ready to pass straight into render()'s svgPathAtlas option.
  async function buildSvgPathRenderResources(
    cmdView,
    bytesWritten,
    deviceScale = 1,
  ) {
    const { entries, ensures } = svgPathEnsures(cmdView, bytesWritten, deviceScale);
    if (entries.length === 0) {
      sharedSvgPathAtlas.rebuildAtlas();
      return sharedSvgPathAtlas;
    }
    await sharedSvgPathAtlas.ensurePaths(ensures);
    sharedSvgPathAtlas.rebuildAtlas();
    synchronizePathRasterResources(
      sharedSvgPathAtlas,
      entries.map((entry) => entry.pathIndex),
    );
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

  // Spec sugar → the engine's per-side form (Slice P2). `borderColor` is
  // either ONE color {r,g,b,a} (all four sides) or per-side colors
  // { top, right, bottom, left } (a missing side is transparent). The engine
  // and rasterizer only ever see the four-slot form.
  function normalizedBorderColors(node) {
    const c = node.borderColor;
    if (
      c && (c.top !== undefined || c.right !== undefined ||
        c.bottom !== undefined || c.left !== undefined)
    ) {
      return {
        top: col(c.top),
        right: col(c.right),
        bottom: col(c.bottom),
        left: col(c.left),
      };
    }
    const uniform = col(c);
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }

  // `borderStyle` (P7) is either ONE style string (all four sides) or
  // per-side strings { top, right, bottom, left } (a missing side is
  // solid). Same spec-sugar shape as normalizedBorderColors above.
  const BORDER_STYLE_NAME_TO_VALUE = {
    solid: BORDER_STYLE_SOLID,
    double: BORDER_STYLE_DOUBLE,
    dashed: BORDER_STYLE_DASHED,
    dotted: BORDER_STYLE_DOTTED,
    inset: BORDER_STYLE_INSET,
    outset: BORDER_STYLE_OUTSET,
    groove: BORDER_STYLE_GROOVE,
    ridge: BORDER_STYLE_RIDGE,
    none: BORDER_STYLE_NONE,
    hidden: BORDER_STYLE_HIDDEN,
  };
  function borderStyleValue(name) {
    if (name === undefined) return BORDER_STYLE_SOLID;
    const value = BORDER_STYLE_NAME_TO_VALUE[name];
    if (value === undefined) {
      throw new Error(`borderStyle: unknown style ${JSON.stringify(name)}`);
    }
    return value;
  }
  function normalizedBorderStyles(node) {
    const s = node.borderStyle;
    if (typeof s === "object" && s !== null) {
      return {
        top: borderStyleValue(s.top),
        right: borderStyleValue(s.right),
        bottom: borderStyleValue(s.bottom),
        left: borderStyleValue(s.left),
      };
    }
    const uniform = borderStyleValue(s);
    return { top: uniform, right: uniform, bottom: uniform, left: uniform };
  }

  // `borderRadius` is either ONE number (all corners, circular) or per-corner
  // { topLeft, topRight, bottomRight, bottomLeft } (a missing corner is
  // square). CSS corner order everywhere. P10: each corner value can ALSO be
  // {rx, ry} instead of a plain number, for a genuinely ELLIPTICAL corner
  // (CSS `border-radius: h / v` syntax) — a plain number is shorthand for
  // rx===ry. A percentage ("50%") resolves against the BORDER BOX at
  // emission time, where the used size is known: it travels to the engine
  // as a NEGATIVE value (radii are never negative in CSS, so the sign bit
  // is free) and $clampRectRadii resolves rx against the box width and ry
  // against the box height before the css-backgrounds-3 §5.4 clamp.
  // Returns {topLeft: {rx,ry}, topRight: {rx,ry}, ...}.
  function radiusComponent(v) {
    if (typeof v === "string") {
      const match = /^([\d.]+)%$/.exec(v.trim());
      if (!match) throw new Error(`borderRadius: unsupported value "${v}"`);
      return -Number(match[1]);
    }
    return v || 0;
  }
  function cornerRxRy(v) {
    if (v === undefined || v === null) return { rx: 0, ry: 0 };
    if (typeof v === "object") {
      return { rx: radiusComponent(v.rx), ry: radiusComponent(v.ry) };
    }
    const component = radiusComponent(v);
    return { rx: component, ry: component };
  }
  function normalizedBorderRadii(node) {
    const r = node.borderRadius;
    // A per-corner spec has at least one of the four corner keys; {rx,ry} on
    // its own (no corner keys) is P10's UNIFORM-ellipse shorthand instead —
    // same rx/ry pair replicated to all four corners.
    if (typeof r === "object" && r !== null) {
      const isPerCorner = "topLeft" in r || "topRight" in r ||
        "bottomRight" in r || "bottomLeft" in r;
      if (isPerCorner) {
        return {
          topLeft: cornerRxRy(r.topLeft),
          topRight: cornerRxRy(r.topRight),
          bottomRight: cornerRxRy(r.bottomRight),
          bottomLeft: cornerRxRy(r.bottomLeft),
        };
      }
    }
    const uniform = cornerRxRy(r);
    return {
      topLeft: uniform,
      topRight: uniform,
      bottomRight: uniform,
      bottomLeft: uniform,
    };
  }

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
  function publishCoreFrame(nodes, patchIndex = null) {
    const publication = publishDirectSceneInput(
      core, nodes, imagePixelsFor, patchIndex,
    );
    if (publication === 0) return false;
    let imageCount = 0;
    for (const node of nodes) {
      if (usesCoreRecord(node)) {
        imageCount += node.resolvedBackgroundImages?.length ?? 0;
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
      if (usesCoreRecord(node) && node.resolvedPathIndex !== undefined) {
        flags |= 4;
        inputView.setUint32(
          row + EngineFrameResolutionFields.pathIndex,
          node.resolvedPathIndex,
          true,
        );
        const fill = node.resolvedPathBbox ??
          { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds0,
          fill.xMin,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds1,
          fill.yMin,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds2,
          fill.xMax,
          true,
        );
        inputView.setFloat64(
          row + EngineFrameResolutionFields.fillBounds3,
          fill.yMax,
          true,
        );
        if (node.resolvedStrokePathIndex !== undefined) {
          flags |= 8;
          inputView.setUint32(
            row + EngineFrameResolutionFields.strokePathIndex,
            node.resolvedStrokePathIndex,
            true,
          );
          const stroke = node.resolvedStrokePathBbox ??
            { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds0,
            stroke.xMin,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds1,
            stroke.yMin,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds2,
            stroke.xMax,
            true,
          );
          inputView.setFloat64(
            row + EngineFrameResolutionFields.strokeBounds3,
            stroke.yMax,
            true,
          );
        }
      }
      const layers = usesCoreRecord(node) ? node.resolvedBackgroundImages : null;
      if (layers?.length) {
        flags |= 16;
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImages,
          imageCursor,
          true,
        );
        inputView.setUint32(
          row + EngineFrameResolutionFields.backgroundImageCount,
          layers.length,
          true,
        );
        for (const layer of layers) {
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
    const stopsCss = g.stops.map((s) =>
      `${rgba(s.color)} ${(s.position ?? 0) * 100}%`
    ).join(", ");
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
    // side (fontFaceCss in examples/font-registry.js).
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
    const b = n.border || {};
    // border-style (P7): per-side longhand from the same spec sugar the
    // engine gets (uniform string or {top,right,bottom,left}); default solid.
    if (n.borderStyle === undefined) {
      d.push(`border-style:solid`);
    } else if (typeof n.borderStyle === "object" && n.borderStyle !== null) {
      d.push(
        `border-style:${n.borderStyle.top ?? "solid"} ${
          n.borderStyle.right ?? "solid"
        } ${n.borderStyle.bottom ?? "solid"} ${n.borderStyle.left ?? "solid"}`,
      );
    } else {
      d.push(`border-style:${n.borderStyle}`);
    }
    d.push(
      `border-width:${b.top || 0}px ${b.right || 0}px ${b.bottom || 0}px ${
        b.left || 0
      }px`,
    );
    const nodeBorderColors = normalizedBorderColors(n);
    d.push(
      `border-color:${rgba(nodeBorderColors.top)} ${
        rgba(nodeBorderColors.right)
      } ${rgba(nodeBorderColors.bottom)} ${rgba(nodeBorderColors.left)}`,
    );
    if (n.borderRadius !== undefined) {
      const nodeRadii = normalizedBorderRadii(n);
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
      const [a, b, c, dd, e, f] = resolveTransform(n);
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
  async function imageDataUri(src) {
    if (imageDataUriCache.has(src)) return imageDataUriCache.get(src);
    const bytes = await readBinaryFile(src);
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
  async function nodeCssBackgroundImages(n) {
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
      if (layer.src) images.push(`url(${await imageDataUri(layer.src)})`);
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
  async function nodeCssBorderImage(n) {
    if (!n.borderImage || !n.borderImage.src) return "";
    const spec = n.borderImage;
    const d = [`border-image-source:url(${await imageDataUri(spec.src)})`];

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
  async function nodeCssMasks(n) {
    if (!n.masks || !n.masks.length) return "";
    const images = [], sizes = [], positions = [], repeats = [];
    const modes = [], origins = [], clips = [], composites = [];
    for (const layer of n.masks) {
      if (layer.src) images.push(`url(${await imageDataUri(layer.src)})`);
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

  async function sceneHtml(scene) {
    const cssRules = await Promise.all(scene.nodes.map(async (n, i) => {
      const extra = [
        await nodeCssBackgroundImages(n),
        await nodeCssMasks(n),
        await nodeCssBorderImage(n),
      ].filter(Boolean);
      return `.s${scene.id}-n${i}{${
        [nodeCss(n), ...extra].filter(Boolean).join(";")
      }}`;
    }));
    const css = cssRules.join("\n");
    // S6 step 3: tracks which definition-only svg/svg-symbol nodes have
    // already had their markup emitted into SOME svg root's <defs> — a
    // definition can be referenced by more than one <use> (the same
    // multi-reference case step 2 already proved for plain shapes), and
    // each one must emit its OWN markup exactly ONCE, not once per
    // reference (unlike gradients, whose defsAccumulator entries are never
    // deduped since each gets its own freshly-generated id).
    const emittedDefinitionIndices = new Set();
    // preserveAspectRatio: sandom's DSL keyword ('none' or absent-for-default)
    // maps directly to the SVG attribute's own keyword vocabulary — no
    // translation needed beyond the CSS/SVG default ('xMidYMid meet' when
    // the attribute is simply omitted).
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
    // The box the engine resolves the gradients of a Tier A shape against
    // when tierAAsPath lowers it to its path (a dash or a gradient stroke):
    // that path's measured bbox, [x, y, width, height]. Null for a shape
    // drawn as itself.
    async function loweredGradientBox(n) {
      if (tierAAsPath(n).display !== "svg-path") return null;
      const bbox = await svgPathBbox(
        svgShapeToPathDef(n),
        n.fillRule === "evenodd" ? "evenodd" : "nonzero",
      );
      return [bbox.xMin, bbox.yMin, bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin];
    }
    // S6 step 3: emits a DEFINITION-only node's markup (a <symbol>, or a
    // plain <svg> used purely as a <use> target) directly into `into`
    // (some enclosing svg root's own defsAccumulator) — called on-demand
    // the FIRST time a <use> references this index, deduped via
    // `emittedDefinitionIndices` (module-scope Set, see its own comment).
    // This does NOT go through the normal renderNode(i) top-down walk at
    // all (a definition node is never reachable via any `children` array,
    // per this slice's own "excluded from the normal top-down render walk"
    // design) — it's the ONLY place in this file that ever reads one of
    // these nodes' own markup.
    async function renderDefinitionNode(href, into) {
      if (emittedDefinitionIndices.has(href)) return;
      emittedDefinitionIndices.add(href);
      const n = scene.nodes[href];
      const kids = (await Promise.all(
        (n.children || []).map((childIndex) => renderNode(childIndex, into)),
      )).join("");
      const attrs = [`id="s${scene.id}-n${href}"`];
      if (n.viewBox) attrs.push(`viewBox="${n.viewBox.join(" ")}"`);
      if (n.preserveAspectRatio) {
        attrs.push(`preserveAspectRatio="${n.preserveAspectRatio}"`);
      }
      // <symbol> gets display:none unconditionally via the UA stylesheet
      // (confirmed via spec text), regardless of placement — no <defs>
      // wrapper needed for THAT part specifically, but it's harmless/
      // conventional to nest it inside one anyway (which `into` already
      // is, once the caller wraps its contents in <defs>...</defs>).
      // A plain <svg> used purely as a definition has NO such automatic
      // rule, so it relies entirely on living inside <defs> (which,
      // per spec, "are not rendered directly" — see struct.html's DefsElement)
      // to stay hidden from direct rendering.
      const tag = n.display === "svg-symbol" ? "symbol" : "svg";
      into.push(`<${tag} ${attrs.join(" ")}>${kids}</${tag}>`);
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
        const src = n.src ? await imageDataUri(n.src) : "";
        return `<img class="s${scene.id}-n${i}" src="${src}">`;
      }
      // svg root (design/svg-rendering.md): a real <svg> element — width/height/
      // viewBox/preserveAspectRatio are genuine SVG attributes (also styled
      // via nodeCss's ordinary width/height CSS declarations, since CSS
      // sizing DOES apply to <svg> as a replaced element — both are present
      // and Chrome reconciles them per the replaced-element sizing spec,
      // same as sandom's own engine does).
      if (n.display === "svg") {
        // A fresh accumulator PER svg root (S7) — NOT the incoming
        // defsAccumulator param (an svg root is never itself nested inside
        // another svg root's own gradient scope in this DSL; each root
        // owns its own <defs>).
        const ownDefsAccumulator = [];
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, ownDefsAccumulator)
        ))).join("");
        const attrs = [`class="s${scene.id}-n${i}"`];
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
        return `<svg ${attrs.join(" ")}>${defsMarkup}${kids}</svg>`;
      }
      // <g>: a real <g> element — no box, no viewport, no
      // clip, just grouping + an optional transform. n.transform reuses
      // the EXACT SAME representation ordinary CSS nodes use ({scale,
      // rotate, translate} or a 6-value affine array — resolveTransform())
      // rather than a raw SVG transform-list string; SVG's own matrix(a,b,
      // c,d,e,f) transform function uses the IDENTICAL parameter order and
      // formula as CSS's matrix() (new_x = a·x + c·y + e, new_y = b·x +
      // d·y + f — confirmed against the SVG Transforms spec before
      // assuming this), so the same resolveTransform() output converts
      // directly with no reordering. defsAccumulator is passed straight
      // through unchanged (a <g> never owns its own gradient <defs> scope
      // — only an svg ROOT does, per the S7 accumulator-race fix's own
      // "one fresh array per svg root, not per arbitrary container" design).
      if (n.display === "svg-group") {
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ))).join("");
        const transformAttr = n.transform !== undefined
          ? (() => {
            const [a, b, c, dd, e, f] = resolveTransform(n);
            return ` transform="matrix(${a} ${b} ${c} ${dd} ${e} ${f})"`;
          })()
          : "";
        return `<g class="s${scene.id}-n${i}"${transformAttr}>${kids}</g>`;
      }
      // <use>: a REAL <use href="#..."> element —
      // deliberately NOT pre-expanded here (unlike the WAT/sandom-pixels
      // path, which DOES structurally clone via resolveSvgUseNodes before
      // this function ever runs, since <use> is a JS-authoring-time concept
      // with no WAT-side equivalent). Emitting a real <use> here is the
      // whole point of this oracle test: it proves sandom's own approach is
      // actually EQUIVALENT to Chrome's native <use> semantics, not just
      // internally self-consistent against itself.
      // n.href indexes scene.nodes directly (same convention as n.children).
      // Two cases: (1) the referenced node renders SOMEWHERE of its own
      // (step 2's plain-shape case — nothing extra needed here, its own id
      // already resolves); (2) the referenced node is a DEFINITION-only
      // svg/svg-symbol (step 3), never itself reachable via any `children`
      // array — renderDefinitionNode emits its markup on demand, into the
      // SAME defsAccumulator this <use>'s own enclosing svg root already
      // owns (deduped, so N sibling <use>s sharing one definition still
      // only emit it once).
      if (n.display === "svg-use") {
        const referenced = scene.nodes[n.href];
        if (
          referenced.display === "svg" || referenced.display === "svg-symbol"
        ) {
          await renderDefinitionNode(n.href, defsAccumulator);
        }
        const xAttr = n.x !== undefined ? ` x="${n.x}"` : "";
        const yAttr = n.y !== undefined ? ` y="${n.y}"` : "";
        const widthAttr = n.width !== undefined ? ` width="${n.width}"` : "";
        const heightAttr = n.height !== undefined
          ? ` height="${n.height}"`
          : "";
        const transformAttr = n.transform !== undefined
          ? (() => {
            const [a, b, c, dd, e, f] = resolveTransform(n);
            return ` transform="matrix(${a} ${b} ${c} ${dd} ${e} ${f})"`;
          })()
          : "";
        return `<use class="s${scene.id}-n${i}" href="#s${scene.id}-n${n.href}"${xAttr}${yAttr}${widthAttr}${heightAttr}${transformAttr}></use>`;
      }
      // svg shapes (design/svg-rendering.md): real SVG presentation attributes, not
      // CSS (see nodeCss's own guard above for why). Carries BOTH class
      // (the gallery's own .s{scene}-n{index} comparison convention) and id
      // (S6 step 2: a real id is what <use href="#..."> below needs to
      // resolve — same s{scene}-n{index} string, just also as a real id).
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
          const bbox = await svgPathBbox(
            n.d ?? "",
            n.fillRule === "evenodd" ? "evenodd" : "nonzero",
          );
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
      if (n.display === "svg-polygon" || n.display === "svg-polyline") {
        // The Chrome side renders a REAL <polygon>/<polyline> element (its
        // own `points` attribute, not sandom's derived `d` string) — this
        // is what proves pointsToPathDef's lowering is actually equivalent
        // to SVG's own polygon/polyline semantics, not just internally
        // self-consistent.
        const tag = n.display === "svg-polygon" ? "polygon" : "polyline";
        const pointsAttr = (n.points ?? []).map(([x, y]) => `${x},${y}`).join(
          " ",
        );
        const fillRuleAttr = n.fillRule === "evenodd"
          ? ` fill-rule="evenodd"`
          : "";
        // S7 step 2: same bbox-on-demand pattern as svg-path above — derive
        // the SAME `d` string resolveSvgPathIndices itself derives from
        // `points` (pointsToPathDef), so the bbox msdfgen computes here is
        // identical to what the engine actually emitted geometry against.
        let box = null;
        if (n.svgFillGradient || n.svgStrokeGradient) {
          const d = pointsToPathDef(
            n.points,
            /*closed=*/ n.display === "svg-polygon",
          );
          const bbox = await svgPathBbox(
            d,
            n.fillRule === "evenodd" ? "evenodd" : "nonzero",
          );
          box = [bbox.xMin, bbox.yMin, bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin];
        }
        const fillAttr = n.svgFillGradient
          ? svgFillAttr(n.fill, n.svgFillGradient, ...box, defsAccumulator)
          : svgFillAttr(n.fill);
        return `<${tag} class="s${scene.id}-n${i}" points="${pointsAttr}"${fillRuleAttr}${fillAttr}${
          svgStrokeAttrs(n, box, defsAccumulator)
        }></${tag}>`;
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
      if (n.display === "inline-block") {
        const kids = (await Promise.all((n.children || []).map((childIndex) =>
          renderNode(childIndex, defsAccumulator)
        ))).join("");
        return `<span class="s${scene.id}-n${i}">${kids}</span>`;
      }
      if (n.display === "inline") {
        const kids =
          (await Promise.all((n.children || []).map(async (childIndex) => {
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
          (await Promise.all((n.children || []).map(async (childIndex) => {
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

  // A gradient's own px lengths, pre-scaled for deviceScale. Only `center`
  // and an explicit radial `size: [rx, ry]` carry lengths — an angle and
  // stop positions (0..1 fractions) are resolution-independent, and the
  // extent KEYWORDS resolve against the box at emission time.
  function scaleGradient(gradient, s) {
    return {
      ...gradient,
      ...(gradient.center
        ? { center: gradient.center.map((v) => scaleLen(v, s)) }
        : {}),
      ...(Array.isArray(gradient.size)
        ? { size: gradient.size.map((v) => scaleLen(v, s)) }
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
    // to s*geometry = correct. A new array — resolveSvgUseNodes runs before
    // scaleNode in renderScenePixels, so synthesized DISPLAY_SVG_ROOT clones
    // (which copy the referenced node's viewBox) are already flattened in
    // and get scaled here too, no special-casing needed.
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
  // Lay out a scene and return the raw RGBA pixels + computed boxes. No PNG
  // encoding (callers that want a PNG encode the result with encodeImage). This is the
  // fastest path for in-browser playgrounds that draw directly to a canvas via
  // putImageData.
  //
  // deviceScale (default 1) controls the LayoutZoomFactor / DPR scaling that
  // matches Blink's physical-LU layout. When set to N>1, every input length is
  // multiplied by N (so the engine lays out in physical pixels at N× resolution)
  // and the rasterizer paints an N× pixel buffer. The caller is then expected to
  // display the canvas at the CSS-pixel size (set canvas.style.width/height to
  // scene.width/scene.height) so the result downscales crisply on a Retina /
  // high-DPI display, matching how Chrome paints its own layout output.
  // Returned width/height are the PHYSICAL dimensions of the pixel buffer.
  // Write a scene's nodes, run layout + emission, and return a COPY of the
  // raw command bytes (the engine reuses its buffer on the next call) — for
  // command-level tests that assert emitted FORMAT contents rather than
  // pixels (test/layout_border_test.js). Rect/clip scenes only (no text
  // resource building).
  function physicalBorderBoxes(nodes) {
    return nodes.map((_, index) => {
      const base = computedBoxBufferBase + index * BOX_SIZE;
      return {
        x: view.getInt32(base + BOX_OFFSET_X, true) / LAYOUT_UNIT,
        y: view.getInt32(base + BOX_OFFSET_Y, true) / LAYOUT_UNIT,
        w: view.getInt32(base + BOX_OFFSET_WIDTH, true) / LAYOUT_UNIT,
        h: view.getInt32(base + BOX_OFFSET_HEIGHT, true) / LAYOUT_UNIT,
      };
    });
  }


  function provisionalClipLayout(
    scene,
    nodes,
    layoutNodeCapacity,
    generationReservation = null,
  ) {
    if (
      !nodes.some((node) =>
        node.clipPath?.kind === "polygon" || node.clipPath?.kind === "path"
      )
    ) {
      return null;
    }
    const provisional = nodes.map((node) =>
      node.clipPath?.kind === "polygon" || node.clipPath?.kind === "path"
        ? { ...node, clipPath: undefined }
        : node
    );
    writeSceneNodesAndTileConfig(
      scene,
      provisional,
      null,
      layoutNodeCapacity,
      generationReservation,
      false,
    );
    engine.exports.layout(provisional.length, scene.width, scene.height);
    return physicalBorderBoxes(provisional);
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
      svgImageTimings = null,
      deviceScale = 1,
      layoutNodeCapacity = Infinity,
      commitTextRunKeys,
      captureNodeMarkers = false,
      engineWriteOwner = null,
    } = options;
    validateLayoutNodeCapacity(layoutNodeCapacity);
    // The engine lays out in CSS pixels; deviceScale is raster-only and
    // never reaches layout or emission. Reset the persistent engine
    // global (opsz reads it during shaping).
    engine.exports.set_device_scale(1);
    const used = resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes));
    const globalPreparation = used !== scene.nodes;
    let nodes = await resolveImageIndices(
      await resolveFontIndices(await resolveSvgPathIndices(used)),
      resolveResource,
      scene.imageSources,
      onImageLoadError,
      svgImageTimings,
    );
    const boxes = provisionalClipLayout(
      scene,
      nodes,
      layoutNodeCapacity,
      generationReservation,
    );
    if (boxes) nodes = await resolveClipPathIndices(nodes, boxes, deviceScale);
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
      bytesWritten = engine.exports.emit_commands(nodes.length);
    } finally {
      engine.exports.set_query_emit(0);
    }
    const answering = answerFallbackFaces();
    if (answering !== null) {
      await answering;
      return await emitSceneCommands(scene, options, generationReservation, emitPaintCommands);
    }
    const copy = engine.memory.buffer.slice(
      COMMAND_BUFFER_BASE,
      COMMAND_BUFFER_BASE + bytesWritten,
    );
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
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
      publishCoreFrame(nodes);
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
          if (publishCoreFrame([nodes[index]], index) === false) return null;
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
    view.setUint32(TILE_CONFIG_BASE + 0x00, 64, true);
    view.setUint32(TILE_CONFIG_BASE + 0x04, Math.ceil(scene.width / 64), true);
    view.setUint32(TILE_CONFIG_BASE + 0x08, Math.ceil(scene.height / 64), true);
    view.setUint32(TILE_CONFIG_BASE + 0x0C, scene.width, true);
    view.setUint32(TILE_CONFIG_BASE + 0x10, scene.height, true);
    return sparseValid;
  }

  // Synchronous counterpart of emitSceneCommands — matches a real
  // browser's SYNCHRONOUS layout-getter properties exactly (offsetWidth
  // etc., src/dom/layout-getters.js), per project ruling. Throws (via
  // resolveFontIndices/resolveImageIndicesSync/resolveSvgPathIndicesSync)
  // if the tree references a font/image/SVG-path not already registered —
  // see each sync resolver's own comment for why that's the correct,
  // honest contract rather than silently blocking or guessing wrong. Font
  // indices take the shared resolver: it has been synchronous since the
  // async fontIndexFor went away, and the copy its duplicate made per
  // text node evaluated every node's deferred text decode.
  function emitSceneCommandsSync(
    scene,
    { layoutNodeCapacity = Infinity, commitTextRunKeys, discardCommands = false, engineWriteOwner = null } = {},
    generationReservation = null,
    emitPaintCommands = true,
  ) {
    validateLayoutNodeCapacity(layoutNodeCapacity);
    engine.exports.set_device_scale(1);
    const used = resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes));
    // Mirrors prepareFull: only a normalization that changes the row index
    // space invalidates every sparse delta of the frame that reuses this.
    const globalPreparation = used !== scene.nodes;
    let nodes = resolveSvgPathIndicesSync(
      resolveImageIndicesSync(resolveFontIndices(used), scene.imageSources),
    );
    const boxes = provisionalClipLayout(
      scene,
      nodes,
      layoutNodeCapacity,
      generationReservation,
    );
    if (boxes) nodes = resolveClipPathIndicesSync(nodes, boxes);
    writeSceneNodesAndTileConfig(
      scene,
      nodes,
      null,
      layoutNodeCapacity,
      generationReservation,
      commitTextRunKeys,
    );
    engineWriteOwner?.resample();
    if (!emitPaintCommands) {
      engine.exports.layout(nodes.length, scene.width, scene.height);
      return { view: null, bytesWritten: 0, nodes, globalPreparation };
    }
    engine.exports.set_paint_artifact_capture(0);
    // QUERY emit — same contract as emitSceneCommands above.
    engine.exports.set_query_emit(1);
    let bytesWritten;
    try {
      bytesWritten = engine.exports.emit_commands(nodes.length);
    } finally {
      engine.exports.set_query_emit(0);
    }
    if (discardCommands) {
      return { view: null, bytesWritten, nodes, globalPreparation };
    }
    const copy = engine.memory.buffer.slice(
      COMMAND_BUFFER_BASE,
      COMMAND_BUFFER_BASE + bytesWritten,
    );
    return { view: new DataView(copy), bytesWritten, nodes, globalPreparation };
  }

  // SVG descendants skip CSS layout: their computed-box rows are zero (or
  // stale), even when the renderer has a real path bounding box in its SVG
  // geometry pool. Materialize that box into the snapshot rows (fifteen f64
  // words per row, readEngineBoxes) before the DOM geometry snapshot takes
  // them. The path atlas supplies the geometric bounds; stroke outlines
  // are paint, not part of an SVG path's getBoundingClientRect rectangle.
  function materializeSvgPathBoxes(nodes, rows, count) {
    const bytes = engine.bytes;
    let parents = null;
    let changed = false;
    for (let index = 0; index < count; index++) {
      // The record's SVG kind byte first: one byte per row, where the
      // scene node's display is a property read of many node shapes.
      const record = layoutBufferBase + index * LAYOUT_NODE_SIZE;
      if (bytes[record + LAYOUT_NODE_OFFSET_SVG_KIND] !== SVG_KIND_PATH_REF) continue;
      const display = nodes[index]?.display;
      if (display !== "svg-path" && display !== "svg-polygon" &&
        display !== "svg-polyline") continue;
      if (view.getUint16(record + LAYOUT_NODE_OFFSET_GEOM_LENGTH, true) < 1) continue;
      if (parents === null) {
        parents = new Int32Array(nodes.length).fill(-1);
        for (let parent = 0; parent < nodes.length; parent++) {
          for (const child of nodes[parent]?.children ?? []) {
            if (child < parents.length) parents[child] = parent;
          }
        }
      }
      let root = parents[index];
      while (root >= 0 && nodes[root]?.display !== "svg") root = parents[root];
      if (root < 0 || root >= count) continue;
      const svgRow = root * BOX_SNAPSHOT_ROW_WORDS;
      const svgBox = {
        cx: rows[svgRow + 4],
        cy: rows[svgRow + 5],
        cw: rows[svgRow + 6],
        ch: rows[svgRow + 7],
      };
      const svgRecord = layoutBufferBase + root * LAYOUT_NODE_SIZE;
      const geometry = SVG_GEOM_POOL_BASE +
        view.getUint32(record + LAYOUT_NODE_OFFSET_GEOM_OFFSET, true);
      if (geometry + SVG_GEOM_ENTRY_SIZE > SVG_GEOM_POOL_BASE + SVG_GEOM_POOL_SIZE) continue;
      const x0 = view.getFloat32(geometry, true);
      const y0 = view.getFloat32(geometry + 4, true);
      const x1 = view.getFloat32(geometry + 8, true);
      const y1 = view.getFloat32(geometry + 12, true);
      if (!Number.isFinite(x0 + y0 + x1 + y1)) continue;

      // Transform attributes on path and <g> are user-space affines. Walk
      // from the path towards its viewport so the viewBox mapping is last.
      let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;
      if (engine.bytes[svgRecord + LAYOUT_NODE_OFFSET_SVG_HAS_VIEW_BOX]) {
        const minX = view.getFloat32(svgRecord + LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_X, true);
        const minY = view.getFloat32(svgRecord + LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_Y, true);
        const width = view.getFloat32(svgRecord + LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_WIDTH, true);
        const height = view.getFloat32(svgRecord + LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_HEIGHT, true);
        if (!(width > 0 && height > 0)) continue;
        scaleX = svgBox.cw / width;
        scaleY = svgBox.ch / height;
        const aspect = engine.bytes[svgRecord + LAYOUT_NODE_OFFSET_SVG_PRESERVE_ASPECT_RATIO];
        if (aspect !== 0) {
          scaleX = scaleY = Math.min(scaleX, scaleY);
          offsetX = (svgBox.cw - width * scaleX) * ((aspect - 1) % 3) / 2;
          offsetY = (svgBox.ch - height * scaleY) * Math.floor((aspect - 1) / 3) / 2;
        }
        offsetX -= minX * scaleX;
        offsetY -= minY * scaleY;
      }
      let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
      for (let ancestor = index; ancestor !== root; ancestor = parents[ancestor]) {
        const base = layoutBufferBase + ancestor * LAYOUT_NODE_SIZE +
          LAYOUT_NODE_OFFSET_TRANSFORM;
        const aa = view.getFloat32(base, true);
        const bb = view.getFloat32(base + 4, true);
        const cc = view.getFloat32(base + 8, true);
        const dd = view.getFloat32(base + 12, true);
        const ee = view.getFloat32(base + 16, true);
        const ff = view.getFloat32(base + 20, true);
        const nextA = aa * a + cc * b;
        b = bb * a + dd * b;
        a = nextA;
        const nextC = aa * c + cc * d;
        d = bb * c + dd * d;
        c = nextC;
        const nextE = aa * e + cc * f + ee;
        f = bb * e + dd * f + ff;
        e = nextE;
      }
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let corner = 0; corner < 4; corner++) {
        const x = corner & 1 ? x1 : x0;
        const y = corner & 2 ? y1 : y0;
        const px = svgBox.cx + offsetX + (a * x + c * y + e) * scaleX;
        const py = svgBox.cy + offsetY + (b * x + d * y + f) * scaleY;
        left = Math.min(left, px);
        top = Math.min(top, py);
        right = Math.max(right, px);
        bottom = Math.max(bottom, py);
      }
      if (!Number.isFinite(left + top + right + bottom)) continue;
      const row = index * BOX_SNAPSHOT_ROW_WORDS;
      rows[row] = rows[row + 4] = left;
      rows[row + 1] = rows[row + 5] = top;
      rows[row + 2] = rows[row + 6] = right - left;
      rows[row + 3] = rows[row + 7] = bottom - top;
      changed = true;
    }
    return changed;
  }

  // Reads every node's computed border-box + content-box (CSS px) off the
  // engine's box buffer after a layout pass — shared by layoutTreeBoxes
  // and layoutTreeBoxesSync below. Indexed EXACTLY like scene.nodes (not
  // the internally-resolved array, which resolveSvgUseNodes can grow via
  // <use> synthesis — irrelevant here since DOM-layer callers index by
  // serializeToScene's own 1:1 indexOf map). The core snapshots the rows
  // (layout units to CSS px, the RTL scroll origin, rounded scroll
  // extents) and a box is made on its first read (readEngineBoxes). SVG
  // paths have no CSS layout box: their atlas bbox, transformed through
  // the SVG viewport, is the source of the DOM rectangle in both the host
  // boxes and the retained native geometry snapshot.
  function readSceneBoxes(scene, deviceScale = 1, resolvedNodes = scene.nodes) {
    const count = scene.nodes.length;
    return readEngineBoxes(
      engine.core,
      count,
      deviceScale,
      (rows) => materializeSvgPathBoxes(resolvedNodes, rows, count),
    );
  }

  // A standalone analytical layout must not inherit geometry or cache
  // validity from a prior call: the engine may hold another scene whose
  // records happen to match this one's at some index, and that node would
  // keep the other scene's box (and its post-layout transform). Force
  // every node into the next generation and clear the output tables, so
  // the engine computes a complete standalone result. An analytical pass
  // over the scene the engine ALREADY holds skips this (see
  // layoutTreeBoxesSync): the record diff is then authoritative, exactly
  // as it is for a frame.
  function stampAnalyticalState(nodeCount, forcedGeneration) {
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
    const boxes = readSceneBoxes(scene, 1, written.nodes);
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
      const nodes = await resolveFontIndices(
        await resolveImageIndices(
          resolveOrderModifiedChildren(resolveSvgUseNodes(scene.nodes)),
          resolveResource,
          scene.imageSources,
          onImageLoadError,
        ),
      );
      const generationReservation = resetAnalyticalLayoutState(nodes.length);
      writeSceneNodesAndTileConfig(
        scene,
        nodes,
        null,
        layoutNodeCapacity,
        generationReservation,
      );
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

  // Draw commands a node marker introduces. Anything else between a text
  // run's marker and the run (a clip, a group, a scroll reference) changes
  // the raster state, so the highlight background is not moved across it.
  const HIGHLIGHT_ANCHOR_DRAW_OPCODES = new Set([
    CMD_RECT,
    CMD_TEXT,
    CMD_IMAGE,
    CMD_SVG_PATH,
    CMD_BOX_SHADOW,
  ]);

  function requireHighlightColor(color, name, index) {
    if (color === null) return;
    for (const channel of ["r", "g", "b", "a"]) {
      if (!Number.isFinite(color?.[channel])) {
        throw new TypeError(
          `textHighlights[${index}].${name}.${channel} is ${
            color?.[channel]
          }; a highlight colour is null or finite r, g, b, a`,
        );
      }
    }
  }

  function requireCaretColor(color) {
    for (const channel of ["r", "g", "b", "a"]) {
      if (!Number.isFinite(color?.[channel])) {
        throw new TypeError(
          `textCaret.color.${channel} is ${color?.[channel]}; a caret colour is finite r, g, b, a`,
        );
      }
    }
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
  // a device-px rectangle covers, grown by one CSS px ($deviceScale device
  // px) on every side: the raster snaps edges to the device grid.
  function markDirtyRectangle(tiles, width, height, x, y, w, h, deviceScale) {
    if (!(w > 0) || !(h > 0)) return;
    const columns = Math.ceil(width / 64);
    const rows = Math.ceil(height / 64);
    const left = Math.max(0, Math.floor((x - deviceScale) / 64));
    const top = Math.max(0, Math.floor((y - deviceScale) / 64));
    const right = Math.min(columns - 1, Math.floor((x + w + deviceScale) / 64));
    const bottom = Math.min(rows - 1, Math.floor((y + h + deviceScale) / 64));
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        tiles[row * columns + column] = 1;
      }
    }
  }

  // Text selection paints in the text's own paint order, as Chrome paints
  // it: the highlight background behind the selected glyphs (above the
  // backgrounds under the text) and the selected glyphs in the highlight
  // colour when one is set. A highlight names the scene index that owns the
  // text (a text node, or a text control for its value) and a UTF-16 source
  // range in the text geometry's units. The raster stream is the emitted
  // stream with a background rectangle inserted before each highlighted
  // run's node marker, under the run's decorations and shadows, and the run
  // split at the selection when the glyph colour changes. The emitted stream
  // is untouched, so geometry, retention, and inspection never see either.
  // Returns the raster stream (null when no emitted run is highlighted) and
  // one band per highlighted run: its bounds in viewport CSS px (through the
  // run's transform and the scroll table entry of the scroll reference it
  // paints under, as the raster plan places it), then its background and
  // glyph colours (-1 channels for none).
  function highlightedRasterCommands(
    commandView,
    bytesWritten,
    textOperations,
    sceneNodes,
    highlights,
    scrollTable,
  ) {
    const highlightByOwner = new Map();
    for (let index = 0; index < highlights.length; index++) {
      const highlight = highlights[index];
      if (
        !Number.isInteger(highlight.ownerIndex) || highlight.ownerIndex < 0 ||
        highlight.ownerIndex >= sceneNodes.length
      ) {
        throw new RangeError(
          `textHighlights[${index}].ownerIndex ${highlight.ownerIndex} is outside a scene of ${sceneNodes.length} nodes`,
        );
      }
      if (
        !Number.isFinite(highlight.start) || !Number.isFinite(highlight.end) ||
        !(highlight.end > highlight.start)
      ) {
        throw new RangeError(
          `textHighlights[${index}] range ${highlight.start}..${highlight.end} selects nothing`,
        );
      }
      requireHighlightColor(highlight.background, "background", index);
      requireHighlightColor(highlight.color, "color", index);
      if (highlightByOwner.has(highlight.ownerIndex)) {
        throw new RangeError(
          `textHighlights[${index}] repeats owner ${highlight.ownerIndex}`,
        );
      }
      highlightByOwner.set(highlight.ownerIndex, highlight);
    }
    // A text operation's index is its ordinal among the stream's text
    // commands that are not text shadows.
    const runs = new Map();
    for (
      let operationIndex = 0;
      operationIndex < textOperations.length;
      operationIndex++
    ) {
      const operation = textOperations[operationIndex];
      const highlight = highlightByOwner.get(
        sceneNodes[operation.nodeIndex]?.generatedOwnerIndex ??
          operation.nodeIndex,
      );
      if (highlight === undefined) continue;
      const glyphs = operation.glyphs;
      let firstGlyph = -1;
      let endGlyph = -1;
      let left = Infinity;
      let right = -Infinity;
      for (let index = 0; index < glyphs.length; index++) {
        const glyph = glyphs[index];
        if (
          glyph.sourceEnd <= highlight.start ||
          glyph.sourceStart >= highlight.end
        ) continue;
        if (firstGlyph < 0) firstGlyph = index;
        endGlyph = index + 1;
        left = Math.min(left, glyph.x);
        right = Math.max(right, glyph.x + glyph.width);
      }
      if (firstGlyph < 0) continue;
      runs.set(operationIndex, {
        highlight,
        firstGlyph,
        endGlyph,
        left,
        right,
        top: operation.logicalRectangle.y,
        height: operation.logicalRectangle.height,
      });
    }
    if (runs.size === 0) return { commands: null, bands: [] };
    const source = new Uint8Array(
      commandView.buffer,
      commandView.byteOffset,
      bytesWritten,
    );
    const output = new Uint8Array(
      bytesWritten +
        runs.size * (cmdRectSize(true, false) + 2 * cmdTextSize(true, true)),
    );
    const view = new DataView(output.buffer);
    let cursor = 0;
    let anchor = -1;
    let highlighted = 0;
    let textOrdinal = 0;
    let scrollReference = 0;
    const bands = [];
    for (let offset = 0; offset < bytesWritten;) {
      const opcode = commandView.getUint8(offset);
      const size = commandByteSize(commandView, offset);
      commandDecodeWork.commands++;
      if (opcode === CMD_SET_SCROLL) {
        scrollReference = commandView.getUint16(offset + 2, true);
      }
      const run = opcode === CMD_TEXT &&
          (commandView.getUint8(offset + CMD_TEXT_OFFSET_FLAGS) &
              CMD_TEXT_FLAG_TEXT_SHADOW) === 0
        ? runs.get(textOrdinal++)
        : undefined;
      if (run === undefined) {
        output.set(source.subarray(offset, offset + size), cursor);
        if (opcode === CMD_SET_NODE) anchor = cursor;
        else if (!HIGHLIGHT_ANCHOR_DRAW_OPCODES.has(opcode)) anchor = -1;
        cursor += size;
        offset += size;
        continue;
      }
      highlighted++;
      const { highlight } = run;
      const transformed = (commandView.getUint8(offset + CMD_TEXT_OFFSET_FLAGS) &
        CMD_TEXT_FLAG_TRANSFORM) !== 0;
      const background = highlight.background;
      // The run's highlight: its band and its selected glyphs, recoloured
      // when the highlight sets a colour, both inside the band's bounds.
      bands.push([
        ...highlightBandBounds(
          commandView,
          transformed ? offset + CMD_TEXT_OFFSET_XFORM : -1,
          run.left,
          run.top,
          run.right - run.left,
          run.height,
          scrollTable,
          scrollReference,
        ),
        ...[background, highlight.color].flatMap((color) =>
          color === null ? [-1, -1, -1, -1] : [color.r, color.g, color.b, color.a]
        ),
      ]);
      if (background !== null && background.a > 0) {
        const rectSize = cmdRectSize(transformed, false);
        const at = anchor < 0 ? cursor : anchor;
        output.copyWithin(at + rectSize, at, cursor);
        output.fill(0, at, at + rectSize);
        view.setUint8(at, CMD_RECT);
        view.setUint8(
          at + CMD_RECT_OFFSET_FLAGS,
          CMD_RECT_FLAG_FILL | (transformed ? CMD_RECT_FLAG_TRANSFORM : 0),
        );
        view.setFloat32(at + CMD_RECT_OFFSET_X, run.left, true);
        view.setFloat32(at + CMD_RECT_OFFSET_Y, run.top, true);
        view.setFloat32(at + CMD_RECT_OFFSET_W, run.right - run.left, true);
        view.setFloat32(at + CMD_RECT_OFFSET_H, run.height, true);
        view.setFloat32(at + CMD_RECT_OFFSET_FILL, background.r, true);
        view.setFloat32(at + CMD_RECT_OFFSET_FILL + 4, background.g, true);
        view.setFloat32(at + CMD_RECT_OFFSET_FILL + 8, background.b, true);
        view.setFloat32(at + CMD_RECT_OFFSET_FILL + 12, background.a, true);
        if (transformed) {
          output.set(
            source.subarray(
              offset + CMD_TEXT_OFFSET_XFORM,
              offset + CMD_TEXT_OFFSET_XFORM + 24,
            ),
            at + CMD_RECT_OFFSET_XFORM,
          );
        }
        cursor += rectSize;
      }
      anchor = -1;
      if (highlight.color === null) {
        output.set(source.subarray(offset, offset + size), cursor);
        cursor += size;
        offset += size;
        continue;
      }
      const glyphCount = commandView.getUint16(
        offset + CMD_TEXT_OFFSET_GCOUNT,
        true,
      );
      const glyphOffset = commandView.getUint32(
        offset + CMD_TEXT_OFFSET_GOFF,
        true,
      );
      for (
        const [start, end, color] of [
          [0, run.firstGlyph, null],
          [run.firstGlyph, run.endGlyph, highlight.color],
          [run.endGlyph, glyphCount, null],
        ]
      ) {
        if (end <= start) continue;
        output.set(source.subarray(offset, offset + size), cursor);
        view.setUint16(cursor + CMD_TEXT_OFFSET_GCOUNT, end - start, true);
        view.setUint32(
          cursor + CMD_TEXT_OFFSET_GOFF,
          glyphOffset + start * GLYPH_ENTRY_SIZE,
          true,
        );
        if (color !== null) {
          view.setFloat32(cursor + CMD_TEXT_OFFSET_COLOR, color.r, true);
          view.setFloat32(cursor + CMD_TEXT_OFFSET_COLOR + 4, color.g, true);
          view.setFloat32(cursor + CMD_TEXT_OFFSET_COLOR + 8, color.b, true);
          view.setFloat32(cursor + CMD_TEXT_OFFSET_COLOR + 12, color.a, true);
        }
        cursor += size;
      }
      offset += size;
    }
    if (highlighted !== runs.size) {
      throw new Error(
        `text highlight: ${runs.size} highlighted text operations name ${highlighted} text commands in a ${bytesWritten}-byte stream`,
      );
    }
    return { commands: output.subarray(0, cursor), bands };
  }

  // The viewport CSS px bounds of a command-space rectangle drawn under
  // the affine at $transformOffset (-1 for none) and scroll reference
  // $scrollReference: a point maps to (a x + c y + e, b x + d y + f) plus
  // the reference's scroll table offset.
  function highlightBandBounds(
    commandView,
    transformOffset,
    x,
    y,
    width,
    height,
    scrollTable,
    scrollReference,
  ) {
    const scrollX = scrollReference === 0 ? 0 : scrollTable[scrollReference * 2];
    const scrollY = scrollReference === 0 ? 0 : scrollTable[scrollReference * 2 + 1];
    if (transformOffset < 0) {
      return [x + scrollX, y + scrollY, width, height];
    }
    const [a, b, c, d, e, f] = [0, 4, 8, 12, 16, 20].map((field) =>
      commandView.getFloat32(transformOffset + field, true)
    );
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const [px, py] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]) {
      const tx = a * px + c * py + e;
      const ty = b * px + d * py + f;
      left = Math.min(left, tx);
      top = Math.min(top, ty);
      right = Math.max(right, tx);
      bottom = Math.max(bottom, ty);
    }
    return [left + scrollX, top + scrollY, right - left, bottom - top];
  }

  // Whether two frames painted the same highlight bands.
  function sameHighlightBands(previous, next) {
    return previous.length === next.length &&
      previous.every((band, index) =>
        band.every((value, field) => value === next[index][field])
      );
  }

  async function createDisplayListArtifact(scene) {
    const emitted = await runExclusiveEngineOperation(async () => {
      const result = await emitSceneCommands(scene, {
        captureNodeMarkers: true,
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
          font: fontIdentityByIndex.get(fontIndex) ?? null,
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
  const renderContexts = new Map(); // "WxH" -> { ctx, queue }; insertion order = LRU
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
  // has already shipped twice there. Nothing in the tree renders
  // concurrently today (checked), so this costs nothing now and makes the
  // pool safe for the first caller who tries.
  async function withRenderContext(
    width,
    height,
    fn,
    graphicsBackend = "auto",
  ) {
    const key = `${width}x${height}:${graphicsBackend}`;
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
      };
    }
    renderContexts.set(key, entry);

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
    entry.queue = run.then(() => {}, () => {});
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
    synchronizedGlyphRasterRevisions.clear();
    synchronizedGlyphRequestSnapshot = null;
    synchronizedGlyphAtlases = null;
    for (const handle of imageResourceHandles.values()) {
      core.resourceRelease(handle);
    }
    imageResourceHandles.clear();
    for (const handle of canvasResourceHandles.values()) {
      core.resourceRelease(handle);
    }
    canvasResourceHandles.clear();
    currentTextBatch?.release();
    currentTextBatch = null;
    if (resourceEngineScope !== 0n) {
      core.resourceEngineRelease(resourceEngineScope);
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
      // Selected text, painted in the text's own paint order; see
      // highlightedRasterCommands. Highlights are resolved against this
      // frame's text operations, so a highlighted frame captures them.
      textHighlights = [],
      // The focused text control's caret, painted by the engine in its
      // value text's block (engine-paint.watpart $emitCaret): the scene
      // index of the text node, the caret's UTF-16 offset in it, its
      // affinity and its used caret-color. null paints none.
      textCaret = null,
      // The painted scrollbar parts, back to front: the scene index of the
      // scroller (-1 for the viewport), x, y, width, height and radius in
      // viewport CSS px, and the colour. The raster plan expands each
      // scroller's scrollbar marker from them. A function is called once,
      // after this frame's layout and before its raster, with the frame's
      // boxes and the engine's layout work so far (layout_compute_total: an
      // equal reading means no node was laid out since), and returns the
      // parts.
      scrollbarParts = [],
      ...rasterOptions
    } = renderOptions;
    const textOperationsRequired = captureTextGeometry ||
      textHighlights.length > 0;
    const captureNodeMarkers = capturePaintArtifact || textOperationsRequired;
    // A highlighted run's rectangles are placed in the command bytes' own
    // coordinates, so only an artifact decoded for its coordinates needs
    // bytes written with the current sticky offsets.
    const artifactCoordinatesRead = capturePaintArtifact ||
      (captureTextGeometry && textGeometryArtifactRead);
    validateLayoutNodeCapacity(layoutNodeCapacity);
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
    if (textCaret !== null) {
      if (
        !Number.isInteger(textCaret.ownerIndex) || textCaret.ownerIndex < 0 ||
        textCaret.ownerIndex >= scene.nodes.length
      ) {
        throw new RangeError(
          `textCaret.ownerIndex ${textCaret.ownerIndex} is outside a scene of ${scene.nodes.length} nodes`,
        );
      }
      if (!Number.isInteger(textCaret.offset) || textCaret.offset < 0) {
        throw new RangeError(
          `textCaret.offset ${textCaret.offset} is not a UTF-16 offset`,
        );
      }
      requireCaretColor(textCaret.color);
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
    const renderWallStartedAt = performance.now();
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
    // resources, scale, size and capture modes are this frame's: a frame
    // whose commands the engine keeps (sparse, or a replayed emission)
    // reuses them.
    const previousResourcesHold = !!previous?.valid &&
      previous.resourceRevision === resourceRevision &&
      previous.fontRevision === fontRevision &&
      previous.resolveResource === resolveResource &&
      previous.deviceScale === deviceScale &&
      previous.glyphResourceManager === glyphResourceManager &&
      previous.width === scene.width && previous.height === scene.height &&
      !capturePaintArtifact &&
      previous.captureNodeMarkers === captureNodeMarkers &&
      (!textOperationsRequired || previous.textGeometryArtifact !== null) &&
      (!scene.imageSources?.size ||
        previous.imageSources === scene.imageSources);
    let sparse = retainedPreparationAllowed && previousResourcesHold &&
      changed !== null && provenanceMatches &&
      engineWriteOwner === renderWriteOwner &&
      previous.writeClaim === engineWriteClaims.get(engine.memory) &&
      previous.coreWriteRevision === core.engineFrameRevision &&
      previous.nodes.length === scene.nodes.length;
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
          (!usesCoreRecord(node) && node.children !== old.children)
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
      const pathStartedAt = svgPathStageTimings ? performance.now() : 0;
      const withPaths = await resolveSvgPathIndices(rows);
      if (svgPathStageTimings) {
        svgPathStageTimings.preparationMilliseconds +=
          performance.now() - pathStartedAt;
      }
      return await resolveImageIndices(
        resolveFontIndices(withPaths),
        resolveResource,
        scene.imageSources,
        onImageLoadError,
        svgImageTimings,
      );
    };
    const prepareFull = async () => {
      const used = resolveOrderModifiedChildren(
        resolveSvgUseNodes(scene.nodes),
      );
      nodes = await resolveRows(used);
      // Only a normalization that changes the row index space invalidates
      // every sparse delta. Unrelated grid/clip/transform nodes retain their
      // prepared inputs; actual layout drift is checked natively below.
      globalPreparation = used !== scene.nodes;
      const clipBoxes = provisionalClipLayout(scene, nodes, layoutNodeCapacity);
      if (clipBoxes) {
        nodes = await resolveClipPathIndices(nodes, clipBoxes, deviceScale);
      }
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
      const resolved = await resolveRows(
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
    // published again as a patch; everything else stands.
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
    if (!sparse && !rowsPatched && !(await reuseSyncLayoutWrite())) {
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
    engineWriteOwner = renderWriteOwner;
    const preparation =
      prepareEngine?.({ engine, view, nodes, physicalScene: scene }) ?? {};
    // The caret, from here to the emission without an await between: the
    // engine is shared, and another surface's render sets its own.
    const caretNode = textCaret === null
      ? -1
      : engineIndexOfSceneNode(nodes, textCaret.ownerIndex);
    engine.exports.paint_caret_set(
      caretNode,
      caretNode < 0 ? 0 : textCaret.offset,
      caretNode >= 0 && textCaret.upstream ? 1 : 0,
      caretNode < 0 ? 0 : textCaret.color.r,
      caretNode < 0 ? 0 : textCaret.color.g,
      caretNode < 0 ? 0 : textCaret.color.b,
      caretNode < 0 ? 0 : textCaret.color.a,
    );
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
    if (!retainedCommands) bytes = engine.exports.emit_commands(nodes.length);
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
    if (retainedCommands && rasterOptions.dirtyTiles === undefined) {
      rasterOptions.dirtyTiles = new Uint8Array(
        Math.ceil(pxW / 64) * Math.ceil(pxH / 64),
      );
    }
    if (rasterOptions.dirtyTiles && !authoritativeDirtyTiles) {
      // The engine's dirty map covers 64-CSS-px tiles over the logical
      // scene; the raster grid covers 64-device-px tiles over the
      // physical target (the visible region at the raster scale).
      // Convert each dirty logical tile into the physical tiles its
      // scaled, origin-shifted rectangle covers.
      const damageMeasurement = globalThis[domMeasurementKey];
      const damageStart = damageMeasurement ? performance.now() : 0;
      const combinedDirtyTiles = rasterOptions.dirtyTiles.slice();
      const dirtyMapAddress = engine.exports.tile_dirty_map_base();
      const logicalColumns = Math.ceil(scene.width / 64);
      const logicalRows = Math.ceil(scene.height / 64);
      const physicalColumns = Math.ceil(pxW / 64);
      const physicalRows = Math.ceil(pxH / 64);
      const originDeviceX = (visibleRectangle?.x ?? 0) * deviceScale;
      const originDeviceY = (visibleRectangle?.y ?? 0) * deviceScale;
      const identityGrid = deviceScale === 1 && originDeviceX === 0 &&
        originDeviceY === 0;
      for (let index = 0; index < logicalColumns * logicalRows; index++) {
        const byte = view.getUint8(dirtyMapAddress + (index >>> 3));
        if (!(byte & (1 << (index & 7)))) continue;
        if (identityGrid) {
          if (index < combinedDirtyTiles.length) combinedDirtyTiles[index] = 1;
          continue;
        }
        const logicalColumn = index % logicalColumns;
        const logicalRow = (index / logicalColumns) | 0;
        const deviceLeft = logicalColumn * 64 * deviceScale - originDeviceX;
        const deviceRight = (logicalColumn + 1) * 64 * deviceScale -
          originDeviceX;
        const deviceTop = logicalRow * 64 * deviceScale - originDeviceY;
        const deviceBottom = (logicalRow + 1) * 64 * deviceScale -
          originDeviceY;
        if (deviceRight <= 0 || deviceBottom <= 0) continue;
        const firstColumn = Math.max(0, Math.floor(deviceLeft / 64));
        const lastColumn = Math.min(
          physicalColumns - 1,
          Math.ceil(deviceRight / 64) - 1,
        );
        const firstRow = Math.max(0, Math.floor(deviceTop / 64));
        const lastRow = Math.min(
          physicalRows - 1,
          Math.ceil(deviceBottom / 64) - 1,
        );
        for (let row = firstRow; row <= lastRow; row++) {
          for (let column = firstColumn; column <= lastColumn; column++) {
            const physicalIndex = row * physicalColumns + column;
            if (physicalIndex < combinedDirtyTiles.length) {
              combinedDirtyTiles[physicalIndex] = 1;
            }
          }
        }
      }
      if (damageMeasurement) {
        damageMeasurement.record({
          category: "damage",
          operation: "dirty-tiles.merge",
          direction: "engine-to-host",
          bytes: logicalColumns * logicalRows,
          allocations: 1,
          allocationBytes: combinedDirtyTiles.byteLength,
          milliseconds: performance.now() - damageStart,
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
          deviceScale,
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
    const inspection = preparation.inspect?.();
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
        engine.memory.buffer.slice(
          COMMAND_BUFFER_BASE,
          COMMAND_BUFFER_BASE + bytes,
        ),
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
            COMMAND_BUFFER_BASE + range.offset,
            COMMAND_BUFFER_BASE + range.offset + range.byteLength,
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
    const colorGlyphFrame = colorGlyphCache.prepare(cmdView, bytes, deviceScale);
    synchronizeImageRasterResources();
    let rasterPlan = null;
    let rasterPlanConfiguration = null;
    let highlightedRaster = false;
    // The selection bands this frame paints: viewport CSS px bounds, then
    // colours.
    let highlightBands = [];
    // The scrollbar rows this frame paints (RASTER_PLAN_SCROLLBAR_ROW_SIZE).
    let frameScrollbarRows = new Float32Array(0);
    const reusedTextResources = textPublication.glyphLease?.active === true;
    const textResources = await buildTextRenderResources(textPublication);
    if (!reusedCommands) releaseRetainedPreparation(renderWriteOwner, textResources);
    const { atlases, glyphBuffer, glyphLease } = textResources;
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
      : textResources.glyphPerformance;
    let svgPathAtlas;
    let paintArtifact = null;
    let textGeometryArtifact = null;
    // The byte offset of each text geometry operation's command.
    let textOperationOffsets = null;
    let rasterMilliseconds = 0;
    let result;
    try {
      const rasterStartedAt = performance.now();
      synchronizeGlyphRasterResources(atlases, textResources.requestSnapshot);
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
        ? performance.now()
        : 0;
      svgPathAtlas = reusedCommands
        ? previous.svgPathAtlas
        : await buildSvgPathRenderResources(
          cmdView,
          bytes,
          deviceScale,
        );
      if (svgPathStageTimings && !reusedCommands) {
        svgPathStageTimings.atlasMilliseconds +=
          performance.now() - atlasStartedAt;
      }
      const engineBytes = new Uint8Array(engine.memory.buffer);
      engineBytes.set(
        new Uint8Array(cmdView.buffer, cmdView.byteOffset, cmdView.byteLength),
        COMMAND_BUFFER_BASE,
      );
      engineBytes.set(glyphBuffer, engine.exports.glyph_buffer_base());
      new Float32Array(
        engine.memory.buffer,
        scrollTableBase,
        scrollTable.length,
      ).set(scrollTable);
      engineBytes.set(gradientStopPool, GRADIENT_STOP_POOL_BASE);
      const highlightedStream = textHighlights.length === 0
        ? { commands: null, bands: [] }
        : highlightedRasterCommands(
          cmdView,
          bytes,
          textGeometryArtifact.operations,
          scene.nodes,
          textHighlights,
          scrollTable,
        );
      const highlightedCommands = highlightedStream.commands;
      highlightedRaster = highlightedCommands !== null;
      highlightBands = highlightedStream.bands;
      // The highlight bands' damage: where the previous frame painted its
      // bands and where this frame paints its own, whenever they differ,
      // in every frame mode.
      const previousBands = previous?.highlightBands ?? [];
      if (
        rasterOptions.dirtyTiles &&
        !sameHighlightBands(previousBands, highlightBands)
      ) {
        rasterOptions.dirtyTiles = rasterOptions.dirtyTiles.slice();
        for (const [x, y, width, height] of [...previousBands, ...highlightBands]) {
          markDirtyRectangle(
            rasterOptions.dirtyTiles,
            pxW,
            pxH,
            (x - (visibleRectangle?.x ?? 0)) * deviceScale,
            (y - (visibleRectangle?.y ?? 0)) * deviceScale,
            width * deviceScale,
            height * deviceScale,
            deviceScale,
          );
        }
      }
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
              deviceScale,
            );
          }
        }
      }
      try {
        rasterPlan = (() => {
          const previousConfiguration = previous?.rasterPlanConfiguration;
          // A patch addresses the emitted stream's byte ranges, which a
          // highlighted raster stream on either side no longer has.
          const canPatch = retainedCommands && reusedCommands && previous.rasterPlan &&
            !highlightedRaster && !previous.highlightedRaster &&
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
                    COMMAND_BUFFER_BASE,
                    bytes,
                    GRADIENT_STOP_POOL_BASE,
                    scrollTableBase,
                  ) === 1)) &&
              (patchedRanges.length === 0 ||
                withRasterPlanRangeTable(patchedRanges, 3, (range) => [
                  range.offset,
                  range.byteLength,
                  COMMAND_BUFFER_BASE + range.offset,
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
            !highlightedRaster && !previous.highlightedRaster &&
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
          const rasterCommands = highlightedCommands === null
            ? COMMAND_BUFFER_BASE
            : engine.exports.abi_malloc(highlightedCommands.byteLength);
          if (rasterCommands === 0) {
            throw new Error(
              `raster highlight stream allocation rejected ${highlightedCommands.byteLength} bytes`,
            );
          }
          const rasterCommandBytes = highlightedCommands === null
            ? bytes
            : highlightedCommands.byteLength;
          let plan;
          try {
            if (highlightedCommands !== null) {
              new Uint8Array(engine.memory.buffer).set(
                highlightedCommands,
                rasterCommands,
              );
            }
            plan = engine.exports.raster_plan_prepare(
              rasterCommands,
              rasterCommandBytes,
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
          } finally {
            if (highlightedCommands !== null) {
              engine.exports.abi_free(rasterCommands);
            }
          }
          if (plan === 0) {
            throw new Error(
              `raster_plan_prepare rejected ${rasterCommandBytes} command bytes at revision ${commandRevision}`,
            );
          }
          rasterPlanRangesReplanned = 1;
          rasterPlanCommandsReplanned = rasterPlanRecordCount(plan);
          if (reusedCommands && previous.rasterPlan) {
            engine.exports.raster_plan_release(previous.rasterPlan.plan);
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
      // already owned by the retained raster plan.
      result = renderContext
        ? await render(renderContext, {
          background: RENDER_BG,
          atlases,
          glyphBuffer,
          images: colorGlyphFrame === null
            ? images
            : await colorGlyphCache.imagesFor(colorGlyphFrame, renderContext, images),
          svgPathAtlas,
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
              atlases,
              glyphBuffer,
              images: colorGlyphFrame === null
                ? images
                : await colorGlyphCache.imagesFor(colorGlyphFrame, context, images),
              svgPathAtlas,
              scrollTable,
              deviceScale,
              visibleRectangle,
              rasterPlan,
              glyphPerformance,
              ...rasterOptions,
            }),
          graphicsBackend,
        );
      rasterMilliseconds = performance.now() - rasterStartedAt;
    } finally {
      if (
        rasterPlan !== null &&
        !reusedCommands &&
        (!result || renderWriteOwner === null)
      ) {
        engine.exports.raster_plan_release(rasterPlan.plan);
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
    }
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
        cmdView,
        scrollTable,
        captureNodeMarkers,
        rasterPlan,
        rasterPlanConfiguration,
        highlightedRaster,
        highlightBands,
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
        commandsDecoded: commandDecodeWork.commands - commandDecodeBefore,
        // Command ranges the raster plan planned again (a preparation or a
        // rescroll plans the whole stream as one range), and the commands
        // in them.
        rasterPlanRangesReplanned,
        rasterPlanCommandsReplanned,
        // Text batches this render prepared and the rows they prepared, and
        // the republished rows whose run it kept or rebuilt.
        textBatchesPrepared: textPreparationWork.batches -
          textPreparationBefore.batches,
        textRowsPrepared: textPreparationWork.rows - textPreparationBefore.rows,
        textRunsKept: textPreparationWork.runsKept -
          textPreparationBefore.runsKept,
        textRunsRebuilt: textPreparationWork.runsRebuilt -
          textPreparationBefore.runsRebuilt,
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
      wallMilliseconds: performance.now() - renderWallStartedAt,
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

  const ANIMATION_PROPERTY_SCENE_FIELDS = Object.freeze({
    width: "width",
    "min-width": "minWidth",
    "max-width": "maxWidth",
    height: "height",
    "min-height": "minHeight",
    "max-height": "maxHeight",
    left: "left",
    right: "right",
    top: "top",
    bottom: "bottom",
    "flex-basis": "flexBasis",
  });

  function sceneAnimationLengthPercentage(value, propertyName) {
    if (typeof value === "number") {
      return { kind: "lengthPercentage", pixels: value, percentage: 0 };
    }
    if (typeof value === "string" && value.endsWith("%")) {
      return {
        kind: "lengthPercentage",
        pixels: 0,
        percentage: Number.parseFloat(value) / 100,
      };
    }
    if (
      value && typeof value === "object" &&
      Number.isFinite(value.pixels) && Number.isFinite(value.percentage)
    ) {
      return {
        kind: "lengthPercentage",
        pixels: value.pixels,
        percentage: value.percentage,
      };
    }
    const initial = {
      width: "auto",
      "min-width": "zero",
      "max-width": "none",
      height: "auto",
      "min-height": "zero",
      "max-height": "none",
      left: "auto",
      right: "auto",
      top: "auto",
      bottom: "auto",
      "flex-basis": "auto",
    }[propertyName];
    return { kind: "keyword", keyword: value ?? initial };
  }

  // The animation-facing value of a property in an engine record (a
  // DOM-backed box: the engine's record before this frame, or the core's
  // record for it), in the shapes animationValueForSceneNode produces.
  const ANIMATION_PROPERTY_RECORD_SIZES = Object.freeze({
    width: [
      LAYOUT_NODE_OFFSET_WIDTH_TAG,
      LAYOUT_NODE_OFFSET_WIDTH,
      LAYOUT_NODE_OFFSET_WIDTH_PERCENT,
    ],
    "min-width": [
      LAYOUT_NODE_OFFSET_MIN_W_TAG,
      LAYOUT_NODE_OFFSET_MIN_WIDTH,
      LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT,
    ],
    "max-width": [
      LAYOUT_NODE_OFFSET_MAX_W_TAG,
      LAYOUT_NODE_OFFSET_MAX_WIDTH,
      LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT,
    ],
    height: [
      LAYOUT_NODE_OFFSET_HEIGHT_TAG,
      LAYOUT_NODE_OFFSET_HEIGHT,
      LAYOUT_NODE_OFFSET_HEIGHT_PERCENT,
    ],
    "min-height": [
      LAYOUT_NODE_OFFSET_MIN_H_TAG,
      LAYOUT_NODE_OFFSET_MIN_HEIGHT,
      LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT,
    ],
    "max-height": [
      LAYOUT_NODE_OFFSET_MAX_H_TAG,
      LAYOUT_NODE_OFFSET_MAX_HEIGHT,
      LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT,
    ],
    left: [
      LAYOUT_NODE_OFFSET_INSET_LEFT_TAG,
      LAYOUT_NODE_OFFSET_INSET_LEFT,
      LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT,
    ],
    right: [
      LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG,
      LAYOUT_NODE_OFFSET_INSET_RIGHT,
      LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT,
    ],
    top: [
      LAYOUT_NODE_OFFSET_INSET_TOP_TAG,
      LAYOUT_NODE_OFFSET_INSET_TOP,
      LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT,
    ],
    bottom: [
      LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG,
      LAYOUT_NODE_OFFSET_INSET_BOTTOM,
      LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT,
    ],
    "flex-basis": [
      LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG,
      LAYOUT_NODE_OFFSET_FLEX_BASIS,
      LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT,
    ],
  });
  const ANIMATION_PROPERTY_RECORD_SCALARS = Object.freeze({
    "padding-top": LAYOUT_NODE_OFFSET_PADDING_TOP,
    "padding-right": LAYOUT_NODE_OFFSET_PADDING_RIGHT,
    "padding-bottom": LAYOUT_NODE_OFFSET_PADDING_BOTTOM,
    "padding-left": LAYOUT_NODE_OFFSET_PADDING_LEFT,
    "row-gap": LAYOUT_NODE_OFFSET_ROW_GAP,
    "column-gap": LAYOUT_NODE_OFFSET_COLUMN_GAP,
    "font-size": LAYOUT_NODE_OFFSET_FONT_SIZE,
  });
  // A gap whose percentage coefficient is NaN holds a length expression
  // (src/wasm/layout.js), which does not interpolate.
  const ANIMATION_PROPERTY_RECORD_GAP_PERCENTAGES = Object.freeze({
    "row-gap": LAYOUT_NODE_OFFSET_GRID_ROW_GAP_PERCENTAGE,
    "column-gap": LAYOUT_NODE_OFFSET_GRID_COLUMN_GAP_PERCENTAGE,
  });
  function animationValueForRecord(bytes, recordView, base, propertyName, box) {
    const scalarOffset = ANIMATION_PROPERTY_RECORD_SCALARS[propertyName];
    if (scalarOffset !== undefined) {
      const gapPercentage = ANIMATION_PROPERTY_RECORD_GAP_PERCENTAGES[propertyName];
      if (
        gapPercentage !== undefined &&
        Number.isNaN(recordView.getFloat32(base + gapPercentage, true))
      ) {
        return {
          kind: "lengthExpression",
          expression: recordView.getFloat32(base + scalarOffset, true),
        };
      }
      return { kind: "scalar", value: recordView.getFloat32(base + scalarOffset, true) };
    }
    if (propertyName === "line-height") {
      return {
        kind: "lineHeight",
        value: recordView.getFloat32(base + LAYOUT_NODE_OFFSET_LINE_HEIGHT, true),
        unit: ["normal", "length", "number"][bytes[base + LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG]],
      };
    }
    const sizeField = ANIMATION_PROPERTY_RECORD_SIZES[propertyName];
    if (sizeField !== undefined) {
      const [tagOffset, valueOffset, percentOffset] = sizeField;
      const tag = bytes[base + tagOffset];
      const value = recordView.getFloat32(base + valueOffset, true);
      if (tag === SIZE_TAG_LENGTH) {
        return sceneAnimationLengthPercentage(value, propertyName);
      }
      if (tag === SIZE_TAG_PERCENT) {
        return sceneAnimationLengthPercentage(`${value}%`, propertyName);
      }
      if (tag === SIZE_TAG_CALC_PAIR) {
        const percentage = recordView.getFloat32(base + percentOffset, true);
        // A NaN percentage marks a length expression (src/wasm/layout.js):
        // a min(), max(), or clamp() that compares a percentage with
        // another unit. It does not interpolate.
        if (Number.isNaN(percentage)) {
          return { kind: "lengthExpression", expression: value };
        }
        return sceneAnimationLengthPercentage(
          { pixels: value, percentage },
          propertyName,
        );
      }
      if (tag === SIZE_TAG_MIN_CONTENT) {
        return { kind: "keyword", keyword: "min-content" };
      }
      if (tag === SIZE_TAG_MAX_CONTENT) {
        return { kind: "keyword", keyword: "max-content" };
      }
      if (tag === SIZE_TAG_FIT_CONTENT) {
        return { kind: "keyword", keyword: "fit-content" };
      }
      return sceneAnimationLengthPercentage(undefined, propertyName);
    }
    if (propertyName === "opacity") {
      return {
        kind: "scalar",
        value: recordView.getFloat32(base + LAYOUT_NODE_OFFSET_OPACITY, true),
      };
    }
    if (propertyName === "background-color" || propertyName === "color") {
      const offset = propertyName === "color"
        ? LAYOUT_NODE_OFFSET_TEXT_COLOR
        : LAYOUT_NODE_OFFSET_BG_COLOR;
      const value = [];
      for (let k = 0; k < 4; k++) {
        value.push(recordView.getFloat32(base + offset + k * 4, true));
      }
      return { kind: "color", value };
    }
    if (propertyName === "visibility") {
      return {
        kind: "keyword",
        keyword: bytes[base + LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN] === 1
          ? "hidden"
          : "visible",
      };
    }
    if (propertyName === "transform") {
      // The record folds the function list into one affine, which CSS
      // cannot interpolate component-wise. A serialization that carries the
      // CSS form is read through animationValueForSceneNode instead; this
      // is the endpoint of last resort, for a node whose previous
      // serialization predates its transition declaration.
      return {
        kind: "transform",
        components: [{
          kind: "matrix",
          value: recordCssTransform(bytes, recordView, base, box),
        }],
      };
    }
    if (propertyName === "translate") {
      const f32 = (offset) => recordView.getFloat32(base + offset, true);
      const [a, b, c, d] = [0, 4, 8, 12].map((offset) =>
        f32(LAYOUT_NODE_OFFSET_TRANSFORM + offset)
      );
      const crossX = f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 4);
      const crossY = f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 8);
      if (a !== 1 || b !== 0 || c !== 0 || d !== 1 ||
        crossX !== 0 || crossY !== 0) {
        throw new TypeError(
          "Cannot recover individual translate from a record with another transform",
        );
      }
      return {
        kind: "translate",
        x: {
          pixels: f32(LAYOUT_NODE_OFFSET_TRANSFORM + 16),
          percentage: f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT),
        },
        y: {
          pixels: f32(LAYOUT_NODE_OFFSET_TRANSFORM + 20),
          percentage: f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 12),
        },
      };
    }
    if (propertyName === "box-shadow") {
      return { kind: "shadowList", shadows: recordShadowList(bytes, recordView, base) };
    }
    throw new TypeError(
      `Cannot animate unsupported property "${propertyName}"`,
    );
  }

  // Legacy pool id of the shadow block in a record copy (dom-interfaces.json
  // engine pools: SHADOW is legacy 4).
  const SHADOW_LEGACY_POOL = 4;
  // A record copy's box-shadow list. The copy is the node record followed
  // by its pool blocks (u32 legacy pool, u32 length, payload); the shadow
  // block is legacy pool 4, and the record's SHADOW_OFFSET is the span's
  // byte offset inside that block's payload.
  function recordShadowList(bytes, recordView, base) {
    if ((recordView.getUint16(base + LAYOUT_NODE_OFFSET_FLAGS, true) & LAYOUT_FLAG_HAS_BOX_SHADOW) === 0) {
      return [];
    }
    const count = bytes[base + LAYOUT_NODE_OFFSET_SHADOW_COUNT];
    if (count === 0) return [];
    const spanOffset = recordView.getUint32(base + LAYOUT_NODE_OFFSET_SHADOW_OFFSET, true);
    let cursor = base + LAYOUT_NODE_SIZE;
    const end = base + recordView.byteLength;
    while (cursor + 8 <= end) {
      const pool = recordView.getUint32(cursor, true);
      const length = recordView.getUint32(cursor + 4, true);
      if (pool === SHADOW_LEGACY_POOL) {
        const span = cursor + 8 + spanOffset;
        if (span + count * SHADOW_ENTRY_SIZE > cursor + 8 + length) {
          throw new RangeError(
            `Record shadow span of ${count} entries at ${spanOffset} exceeds its ${length}-byte block`,
          );
        }
        const shadows = [];
        for (let index = 0; index < count; index++) {
          const entry = span + index * SHADOW_ENTRY_SIZE;
          shadows.push({
            offsetX: recordView.getFloat32(entry + SHADOW_OFFSET_OFFSET_X, true),
            offsetY: recordView.getFloat32(entry + SHADOW_OFFSET_OFFSET_Y, true),
            blur: recordView.getFloat32(entry + SHADOW_OFFSET_BLUR, true),
            spread: recordView.getFloat32(entry + SHADOW_OFFSET_SPREAD, true),
            color: [0, 1, 2, 3].map((k) => recordView.getFloat32(entry + SHADOW_OFFSET_COLOR + k * 4, true)),
            inset: bytes[entry + SHADOW_OFFSET_INSET] === 1,
          });
        }
        return shadows;
      }
      cursor += 8 + length;
    }
    throw new RangeError(`Record paints ${count} box shadows but carries no shadow block`);
  }

  // A record's transform in the engine's resolved form (engine.wat
  // $resolveCssTransform): the box-linear translation applied for the box's
  // size and the list folded around transform-origin.
  function recordCssTransform(bytes, recordView, base, box) {
    const f32 = (offset) => recordView.getFloat32(base + offset, true);
    const [a, b, c, d] = [0, 4, 8, 12].map((k) =>
      f32(LAYOUT_NODE_OFFSET_TRANSFORM + k)
    );
    let e = f32(LAYOUT_NODE_OFFSET_TRANSFORM + 16);
    let f = f32(LAYOUT_NODE_OFFSET_TRANSFORM + 20);
    if (
      bytes[base + LAYOUT_NODE_OFFSET_TRANSFORM_KIND] ===
        TRANSFORM_KIND_RESOLVED
    ) {
      return [a, b, c, d, e, f];
    }
    const w = box?.w ?? 0;
    const h = box?.h ?? 0;
    e += f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT) * w +
      f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 4) * h;
    f += f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 8) * w +
      f32(LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT + 12) * h;
    const dx = f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X) +
      (f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT) - 0.5) * w;
    const dy = f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y) +
      (f32(LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT) - 0.5) * h;
    return [a, b, c, d, e + dx - (a * dx + c * dy), f + dy - (b * dx + d * dy)];
  }

  function animationValueForSceneNode(node, propertyName) {
    if (propertyName in ANIMATION_PROPERTY_SCENE_FIELDS) {
      return sceneAnimationLengthPercentage(
        node[ANIMATION_PROPERTY_SCENE_FIELDS[propertyName]],
        propertyName,
      );
    }
    if (propertyName.startsWith("padding-")) {
      return { kind: "scalar", value: node.padding?.[propertyName.slice(8)] ?? 0 };
    }
    if (propertyName === "row-gap" || propertyName === "column-gap" || propertyName === "font-size") {
      const field = propertyName === "row-gap" ? "rowGap" : propertyName === "column-gap" ? "columnGap" : "fontSize";
      return { kind: "scalar", value: node[field] ?? (propertyName === "font-size" ? 16 : 0) };
    }
    if (propertyName === "line-height") {
      const value = node.lineHeight;
      return typeof value === "number"
        ? { kind: "lineHeight", value, unit: "number" }
        : typeof value?.px === "number"
        ? { kind: "lineHeight", value: value.px, unit: "length" }
        : { kind: "lineHeight", value: 0, unit: "normal" };
    }
    if (propertyName === "opacity") {
      return { kind: "scalar", value: node.opacity ?? 1 };
    }
    if (propertyName === "background-color") {
      const color = node.bg ?? { r: 0, g: 0, b: 0, a: 0 };
      return { kind: "color", value: [color.r, color.g, color.b, color.a] };
    }
    if (propertyName === "color") {
      // Opaque black is the CSS initial value, not transparent — the same
      // special case writeNode applies to NODE_TEXT_COLOR.
      const color = node.color ?? { r: 0, g: 0, b: 0, a: 1 };
      return { kind: "color", value: [color.r, color.g, color.b, color.a] };
    }
    if (propertyName === "visibility") {
      return { kind: "keyword", keyword: node.visibility ?? "visible" };
    }
    if (propertyName === "transform") {
      // CSS Transforms: `none` is the identity for interpolation, i.e. an
      // empty function list the other endpoint's identity functions pad out
      // (engine.wat $animationSampleTransform) — not a matrix() function,
      // which would force the mismatched-list decomposition fallback and
      // turn a rotation into a chord.
      const transform = node.transform;
      return {
        kind: "transform",
        components: transform?.cssText === "none"
          ? []
          : transform?.components ?? [],
      };
    }
    if (propertyName === "translate") {
      const translate = node.translate;
      return {
        kind: "translate",
        x: translate?.x ?? { pixels: 0, percentage: 0 },
        y: translate?.y ?? { pixels: 0, percentage: 0 },
      };
    }
    if (propertyName === "box-shadow") {
      return {
        kind: "shadowList",
        shadows: (node.boxShadows ?? []).map((shadow) => ({
          offsetX: shadow.offsetX ?? 0,
          offsetY: shadow.offsetY ?? 0,
          blur: shadow.blur ?? 0,
          spread: shadow.spread ?? 0,
          color: [shadow.color.r, shadow.color.g, shadow.color.b, shadow.color.a],
          inset: shadow.inset === true,
        })),
      };
    }
    throw new TypeError(
      `Cannot animate unsupported property "${propertyName}"`,
    );
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
          // node (write-if-changed keeps the unchanged ones' generations).
          const styleGeneration = scene.styleGeneration ?? 0;
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
      // A synchronous style/layout read resolves a pending transition at
      // that read's document time, just as Chrome does. Without such a read,
      // the render that first resolves the change is its time anchor; the
      // previous presented frame may be arbitrarily old.
      const renderTime = renderOptions.timeMilliseconds ?? performance.now();
      const transitionStartTime =
        renderOptions.transitionStartTimeMilliseconds ?? renderTime;
      // The transitions this style change starts, collected before any is
      // declared: the running ones they interrupt are brought to the
      // change's time first (below).
      const declarations = [];
      if (previousSceneNodes !== null && changedNodeIndices?.size) {
        for (const nodeIndex of changedNodeIndices) {
          const previousNode = previousSceneNodes[nodeIndex];
          const nextNode = scene.nodes[nodeIndex];
          if (!previousNode || !nextNode?.transitionDefinitions?.length) {
            continue;
          }
          // An element that was not rendered has no before-change style,
          // and one that stops being rendered has no after-change style
          // (css-transitions-1 §3): neither starts a transition. A panel
          // that appears does so at its size; nothing grows from 0.
          if (previousNode.display === "none" || nextNode.display === "none") {
            continue;
          }
          // A DOM-backed box's values live in its immutable native record.
          // Read both transition endpoints from record bytes, never from
          // the engine buffer: it is shared, and a synchronous layout
          // getter since the preceding frame has rewritten it with the
          // after-change scene. A serialization taken while the element
          // declared transitions carries its record copy; one taken before
          // (the transition declared with the change) is read from its
          // publication, live until this frame supersedes it.
          const recordView = (record) =>
            new DataView(record.buffer, record.byteOffset, record.byteLength);
          const publishedRecord = (node) => {
            const box = node._corePublication.boxes[node._corePublicationIndex];
            return node._corePublication.core.engineRecordCopy(
              box.stableId,
              box.sourceRevision,
            );
          };
          const previousRecord = previousNode._coreRecord ??
            (usesCoreRecord(previousNode) ? publishedRecord(previousNode) : null);
          const nextRecord = nextNode._coreRecord ?? null;
          // The transform is the exception: the record folds the function
          // list into one affine, so its endpoints come from the CSS form
          // the same serialization captured (serialize.js), which is just
          // as immutable and is what CSS interpolates.
          //
          // Both endpoints take the same form or neither does: the CSS
          // list and the folded affine are different spellings of one
          // value, and comparing one against the other would report a
          // change where there is none. A serialization taken before the
          // element declared its transition carries no list, so that pair
          // compares — and interpolates — as affines.
          const carriesCssTransform = (propertyName) =>
            propertyName === "transform" &&
            previousNode.transform !== undefined &&
            nextNode.transform !== undefined;
          const carriesCssTranslate = (propertyName) =>
            propertyName === "translate" &&
            previousNode.translate !== undefined &&
            nextNode.translate !== undefined;
          const carriesCssValue = (propertyName) =>
            carriesCssTransform(propertyName) ||
            carriesCssTranslate(propertyName);
          const previousValue = (propertyName) =>
            carriesCssValue(propertyName)
              ? animationValueForSceneNode(previousNode, propertyName)
              : previousRecord !== null
              ? animationValueForRecord(
                previousRecord,
                recordView(previousRecord),
                0,
                propertyName,
                previousBoxes[nodeIndex],
              )
              : animationValueForSceneNode(previousNode, propertyName);
          const nextValue = (propertyName) =>
            nextRecord !== null && !carriesCssValue(propertyName)
              ? animationValueForRecord(
                nextRecord,
                recordView(nextRecord),
                0,
                propertyName,
                previousBoxes[nodeIndex],
              )
              : animationValueForSceneNode(nextNode, propertyName);
          for (const definition of nextNode.transitionDefinitions) {
            const propertyNames = animationTransitionProperties(
              definition.propertyName,
            );
            for (const propertyName of propertyNames) {
              const previousTarget = previousValue(propertyName);
              const nextTarget = nextValue(propertyName);
              if (
                !animationTransitionChanged(
                  previousTarget,
                  nextTarget,
                  definition.duration,
                  definition.delay,
                )
              ) continue;
              // css-transitions-1 §3: a transition starts only when both
              // values are interpolable. A sizing keyword (auto,
              // fit-content, min-/max-content) on either end of a length
              // property is not; the value changes discretely. A layout
              // that swung from `auto` through 0 to its final size was the
              // Tabs orientation switch's wrong first frames.
              if (
                propertyName in ANIMATION_PROPERTY_RECORD_SIZES &&
                (previousTarget.kind === "keyword" || nextTarget.kind === "keyword")
              ) continue;
              // A length expression that compares a percentage with another
              // unit resolves only at layout; it changes discretely.
              if (
                previousTarget.kind === "lengthExpression" ||
                nextTarget.kind === "lengthExpression"
              ) continue;
              if (propertyName === "line-height" &&
                (previousTarget.unit === "normal" || nextTarget.unit === "normal" ||
                  previousTarget.unit !== nextTarget.unit)) continue;
              // The before-change value comes from the previous frame's
              // immutable capture, never from the engine buffer: a
              // synchronous layout getter since that frame has rewritten
              // the buffer with the after-change scene. The controller
              // keeps the node's live value instead only while an earlier
              // effect is still sampling it.
              const timing = {
                duration: definition.duration,
                delay: definition.delay,
                easing: definition.easing,
                startTime: transitionStartTime,
                startValue: previousTarget,
              };
              if (propertyName === "transform") {
                // The base the track restores at its end, and the vector
                // the reversing-shortening rule measures progress along,
                // are matrices: the resolved affine of the end value. It
                // folds the CSS form whenever the node carries one — a
                // retained transform-only frame keeps the record it was
                // serialized with, so the record is the weaker source.
                const targetMatrix =
                  nextNode.transform?.kind === "cssTransform" &&
                    previousBoxes[nodeIndex] !== undefined
                    ? resolveCssTransform(nextNode, previousBoxes[nodeIndex])
                    : nextRecord !== null
                    ? recordCssTransform(
                      nextRecord,
                      recordView(nextRecord),
                      0,
                      previousBoxes[nodeIndex],
                    )
                    : resolveTransform(nextNode);
                timing.baseTarget = {
                  kind: "transform",
                  components: [{ kind: "matrix", value: targetMatrix }],
                };
              }
              declarations.push({ nodeIndex, propertyName, nextTarget, timing });
            }
          }
        }
      }
      // css-transitions-1 §3: a style change sees the running transitions
      // at its own time. Before a declaration interrupts one, the tracks
      // advance to that time: one whose end it reaches completes with
      // transitionend and the new transition starts from its end value with
      // its full duration; a running one is interrupted, or reversed with
      // its shortening factor, at its value at that time instead of at the
      // last frame's sample.
      if (
        declarations.some(({ nodeIndex, propertyName }) =>
          animations.hasEffect(nodeIndex, propertyName)
        )
      ) {
        animations.advance(transitionStartTime);
      }
      // Each transition reaches the caller's onTransitionStarted as it is
      // declared: after the cancel of the transition it replaces, which the
      // declaration reports, and before its own events, which this frame's
      // tick reports (a reversal of a transition that has not progressed
      // has no duration left, and starts and ends in that tick).
      for (const { nodeIndex, propertyName, nextTarget, timing } of declarations) {
        const transition = animations.transition(
          nodeIndex,
          propertyName,
          nextTarget,
          timing,
        );
        renderOptions.onTransitionStarted?.({
          nodeIndex,
          propertyName,
          ...timing,
          duration: transition.duration,
          endValue: nextTarget,
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
            animationTickMilliseconds = renderOptions.timeMilliseconds ??
              transitionStartTime;
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
      createDisplayListArtifact(scene) {
        if (shutDown) throw new Error("persistent scene renderer is shut down");
        return createDisplayListArtifact(scene);
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
  // and raster plans prepared vs rescrolled, read from the live engine
  // instance every renderer and analytical layout of this runtime shares.
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
    cssTransformMatrix,
    prewarmCssTextGlyphs,
    imagePixelsFor,
    sharedSvgPathAtlas,
    normalizedBorderColors,
    normalizedBorderStyles,
    normalizedBorderRadii,
    floatByte,
    clearByte,
    sceneHtml,
    scaleNode,
    emitSceneCommands,
    emitSceneCommandsSync,
    layoutTreeBoxes,
    layoutTreeBoxesSync,
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
