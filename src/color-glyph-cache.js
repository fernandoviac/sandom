// Native color-glyph layouts, publication and render jobs. The host retains
// opaque contexts and textures and executes each requested page job.
import { createRenderContext, render } from './rasterize.js';
import { createWebgl2ColorGlyphCachePage } from './rasterize-webgl2.js';
import { releaseRasterPlan } from './raster-plan.js';
import { createGpuBinding } from './gpu-binding.js';
import { layoutConstant } from './wasm/layout-table.js';

// The cache, frame, page, device and rectangle fields of
// gpu-color-glyph.watpart, by WAT name.
const COLOR = Object.freeze(Object.fromEntries([
  'CACHE_ERROR', 'CACHE_OBSERVED', 'CACHE_LIMIT', 'FRAME_GENERATION', 'PAGE_INDEX', 'PAGE_WIDTH', 'PAGE_HEIGHT',
  'DEVICE_FLAGS', 'DEVICE_SCRATCH_WIDTH', 'DEVICE_SCRATCH_HEIGHT', 'DEVICE_RECTANGLE_COUNT', 'DEVICE_RECTANGLES',
  'DEVICE_COMMANDS', 'DEVICE_COMMANDS_LENGTH', 'RECTANGLE_SIZE', 'RECTANGLE_X', 'RECTANGLE_Y', 'RECTANGLE_WIDTH',
  'RECTANGLE_HEIGHT', 'DEVICE_NEW_PAGE', 'DEVICE_SCRATCH_GROWN',
].map((name) => [name, layoutConstant(`COLOR_${name}`)])));

const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

export function createColorGlyphCache({ engine, graphicsStateOwner, pathAtlas,
  svgPathEnsures, bindPathRasterAtlas, restorePathRasterAtlas }) {
  const native = engine.exports;
  const cache = native.gpu_color_cache_create();
  const identities = new WeakMap();
  const states = new Map();
  const unsigned = (pointer) => new DataView(engine.memory.buffer).getUint32(pointer, true);

  function prepare(view, bytes, deviceScale) {
    let input = view.byteOffset;
    let allocation = 0;
    if (view.buffer !== engine.memory.buffer) {
      allocation = native.abi_malloc(bytes || 1);
      new Uint8Array(engine.memory.buffer, allocation, bytes).set(new Uint8Array(view.buffer, view.byteOffset, bytes));
      input = allocation;
    }
    try {
      const frame = native.gpu_color_prepare(cache, input, bytes, deviceScale);
      const error = unsigned(cache + COLOR.CACHE_ERROR);
      if (error) throw new Error(`Native color glyph cache error ${error}: observed ${unsigned(cache + COLOR.CACHE_OBSERVED)}, limit ${unsigned(cache + COLOR.CACHE_LIMIT)}; supply a complete command stream and a frame within the eight-page cache limit`);
      return frame ? { handle: frame, generation: unsigned(frame + COLOR.FRAME_GENERATION), deviceScale } : null;
    } finally { if (allocation) native.abi_free(allocation); }
  }

  async function retire(all = false) {
    let handle;
    while ((handle = native.gpu_color_retired(cache, Number(all))) !== 0) {
      const state = states.get(handle);
      if (!state) throw new Error(`Native color glyph state ${handle} has no graphics binding`);
      if (state.scratch) await state.scratch.destroy();
      for (const page of state.pages.values()) page.gpu?.destroy();
      native.gpu_color_state_destroy(handle);
      if (state.binding) {
        state.binding.execute();
        state.binding.close();
      }
      states.delete(handle);
    }
    native.gpu_color_collect(cache, Number(all));
  }

  async function imagesFor(frame, context, images) {
    let identity = identities.get(context.shared);
    if (identity === undefined) {
      identity = native.gpu_handle_allocate();
      identities.set(context.shared, identity);
    }
    const handle = native.gpu_color_state(cache, identity,
      Number(context.renderMode === 'high-dynamic-range'), frame.handle,
      Number(context.kind === 'webgl2'), Number(context.colorFormat === 'rgba16float'));
    let state = states.get(handle);
    if (!state) {
      state = { scratch: null, pages: new Map(), binding: context.kind === 'webgl2' ? null : createGpuBinding(native, context.device) };
      states.set(handle, state);
    }
    await retire();
    let pagePointer;
    while ((pagePointer = native.gpu_color_next(handle, frame.handle)) !== 0) {
      const pageNumber = unsigned(pagePointer + COLOR.PAGE_INDEX);
      const width = unsigned(pagePointer + COLOR.PAGE_WIDTH);
      const height = unsigned(pagePointer + COLOR.PAGE_HEIGHT);
      const flags = unsigned(handle + COLOR.DEVICE_FLAGS);
      if (flags & COLOR.DEVICE_SCRATCH_GROWN) {
        if (state.scratch) await state.scratch.destroy();
        state.scratch = await createRenderContext({
          width: unsigned(handle + COLOR.DEVICE_SCRATCH_WIDTH), height: unsigned(handle + COLOR.DEVICE_SCRATCH_HEIGHT),
          graphicsBackend: context.kind, sharedStateOwner: graphicsStateOwner,
          renderMode: context.renderMode, renderPrecision: context.renderPrecision,
        });
      }
      const pointer = unsigned(handle + COLOR.DEVICE_COMMANDS);
      const length = unsigned(handle + COLOR.DEVICE_COMMANDS_LENGTH);
      if (length) {
        const stream = new DataView(new Uint8Array(engine.memory.buffer, pointer, length).slice().buffer);
        const { ensures } = svgPathEnsures(stream, length, frame.deviceScale);
        await pathAtlas.ensurePaths(ensures);
        pathAtlas.rebuildAtlas();
      }
      bindPathRasterAtlas(pathAtlas);
      let plan;
      try { plan = native.gpu_color_plan(handle); }
      finally { restorePathRasterAtlas(); }
      if (!plan) throw new Error(`Native color glyph page ${pageNumber} rejected ${length} command bytes`);
      try {
        await render(state.scratch, {
          background: TRANSPARENT, images: new Map(), scrollTable: new Float32Array(0),
          deviceScale: frame.deviceScale, rasterPlan: { memory: engine.memory, exports: native, plan }, readback: 'none',
        });
      } finally { releaseRasterPlan({ exports: native, plan }); }
      let page = state.pages.get(pageNumber);
      if (state.binding) {
        state.binding.beginFrame();
        const texture = native.gpu_color_copy(handle, state.binding.stream, state.binding.importResource(state.scratch.mainTexture));
        state.binding.execute();
        if (flags & COLOR.DEVICE_NEW_PAGE) {
          page = { image: { kind: 'color-glyph-cache-page', width, height, texture: state.binding.resource(texture) } };
          state.pages.set(pageNumber, page);
        }
      } else {
        native.gpu_color_copy(handle, 0, 0);
        if (flags & COLOR.DEVICE_NEW_PAGE) {
          const gpu = createWebgl2ColorGlyphCachePage(context, width, height);
          page = { gpu, image: { kind: 'color-glyph-cache-page', width, height, texture: gpu.texture } };
          state.pages.set(pageNumber, page);
        }
        const rectangles = unsigned(handle + COLOR.DEVICE_RECTANGLES);
        const count = unsigned(handle + COLOR.DEVICE_RECTANGLE_COUNT);
        const view = new DataView(engine.memory.buffer);
        page.gpu.copyFrom(state.scratch, Array.from({ length: count }, (_, index) => {
          const row = rectangles + index * COLOR.RECTANGLE_SIZE;
          return { x: view.getUint32(row + COLOR.RECTANGLE_X, true), y: view.getUint32(row + COLOR.RECTANGLE_Y, true),
            width: view.getUint32(row + COLOR.RECTANGLE_WIDTH, true), height: view.getUint32(row + COLOR.RECTANGLE_HEIGHT, true) };
        }));
      }
      native.gpu_color_commit(handle);
    }
    const frameImages = new Map(images);
    for (const [pageNumber, page] of state.pages) {
      frameImages.set(native.color_glyph_cache_page_index_base() + pageNumber, page.image);
    }
    return frameImages;
  }

  async function releaseFrame(frame) {
    if (frame === null) return;
    native.gpu_color_frame_release(frame.handle);
    await retire();
  }
  async function release() { await retire(true); }
  return { prepare, imagesFor, releaseFrame, release };
}
