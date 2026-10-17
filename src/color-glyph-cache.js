// Native color-glyph layouts, publication and render jobs. The host retains
// opaque contexts and textures and executes each requested page job.
import { createRenderContext, render } from './rasterize.js';
import { createWebgl2ColorGlyphCachePage } from './rasterize-webgl2.js';
import { releaseRasterPlan } from './raster-plan.js';
import { createGpuBinding } from './gpu-binding.js';

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
      const error = unsigned(cache + 44);
      if (error) throw new Error(`Native color glyph cache error ${error}: observed ${unsigned(cache + 48)}, limit ${unsigned(cache + 52)}; supply a complete command stream and a frame within the eight-page cache limit`);
      return frame ? { handle: frame, generation: unsigned(frame + 12), deviceScale } : null;
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
      const pageNumber = unsigned(pagePointer + 4);
      const width = unsigned(pagePointer + 8);
      const height = unsigned(pagePointer + 12);
      const flags = unsigned(handle + 28);
      if (flags & 2) {
        if (state.scratch) await state.scratch.destroy();
        state.scratch = await createRenderContext({
          width: unsigned(handle + 32), height: unsigned(handle + 36),
          graphicsBackend: context.kind, sharedStateOwner: graphicsStateOwner,
          renderMode: context.renderMode, renderPrecision: context.renderPrecision,
        });
      }
      const pointer = unsigned(handle + 112);
      const length = unsigned(handle + 116);
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
        if (flags & 1) {
          page = { image: { kind: 'color-glyph-cache-page', width, height, texture: state.binding.resource(texture) } };
          state.pages.set(pageNumber, page);
        }
      } else {
        native.gpu_color_copy(handle, 0, 0);
        if (flags & 1) {
          const gpu = createWebgl2ColorGlyphCachePage(context, width, height);
          page = { gpu, image: { kind: 'color-glyph-cache-page', width, height, texture: gpu.texture } };
          state.pages.set(pageNumber, page);
        }
        const rectangles = unsigned(handle + 48);
        const count = unsigned(handle + 44);
        const view = new DataView(engine.memory.buffer);
        page.gpu.copyFrom(state.scratch, Array.from({ length: count }, (_, index) => {
          const row = rectangles + index * 32;
          return { x: view.getUint32(row + 8, true), y: view.getUint32(row + 12, true),
            width: view.getUint32(row + 16, true), height: view.getUint32(row + 20, true) };
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
