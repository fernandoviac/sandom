// The public Sandom surface: one entry per job. Everything here is retained,
// incremental, and delivers GPU texture frames by default; CPU pixels and
// file encodings are explicit requests. test/output-and-cli/public_surface_test.js pins
// this export list.
//
// Frames:        createRenderSurface(root, options) → surface.renderNow()
// Pixels:        surface.renderNow({ pixels: true })
// Presentation:  presentFrame option + createCanvasPresenter(...).present()
// Projected:     createTexturePresenter(...).presentFrame + bindProjectedInput
// Files:         encodeImage(frame, { format }), createGifRecorder
// Video:         not offered; @sandom/vp9-webm owns it
// Direct scenes: createSceneRenderer({ width, height }).renderTexture(scene)
// Devices:       createGpuThread(options, { reply, throw })

export {
  createLayoutArtifact,
  createDisplayListArtifact,
  createInvalidationArtifact,
  createPersistentSceneRenderer,
  createSandomRuntime,
  createSceneRenderer,
  DEFAULT_GLYPH_RESOURCE_LIMITS,
  GlyphResourceManager,
  releaseRenderContexts,
} from "./scene-renderer.js";
export {
  createDocumentSession,
  createRenderSurface,
  createSandomDOM,
  DocumentSession,
  evaluateComponentModule,
  planAutomaticViewport,
  recommendMotionCapture,
  renderComponent,
  renderInBrowserWorker,
  renderInput,
  RenderPlanningError,
  SandomDocument,
} from "./dom/dom.js";
export { loadFont } from "./font-registry.js";
// The glyph outlines of a font's bytes, from the shaper Sandom renders with.
export { createGlyphOutlineSource } from "./shaping.js";
export { createCanvasPresenter } from "./canvas-presentation.js";
export {
  bindProjectedInput,
  createTexturePresenter,
  projectOntoRectangle,
} from "./dom/projected-surface.js";
export { createGpuCompositor } from "./gpu-compositor.js";
export { createGpuThread } from "./gpu-thread.js";
export {
  encodeImage,
  OUTPUT_FORMATS,
  validateOutputRequest,
} from "./output/image.js";
export { createGifRecorder } from "./output/gif.js";
export { quantizeWorkingPixels } from "./output/color-transform.js";
