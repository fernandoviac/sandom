import { openRasterPlan } from './raster-plan.js';
import { layoutConstant } from './wasm/layout-table.js';

// The retention input, frame, rectangle, region and readback slot fields
// (gpu-raster.watpart), keyed by their global name.
const LAYOUT = Object.freeze(Object.fromEntries([
  'RETENTION_INPUT_SIZE', 'RETENTION_INPUT_OWNER', 'RETENTION_INPUT_RESOURCE_REVISION', 'RETENTION_INPUT_PLAN',
  'RETENTION_INPUT_PLAN_BYTES', 'RETENTION_INPUT_REVISION', 'RETENTION_INPUT_TARGET_KEY',
  'RETENTION_INPUT_INDEXED', 'RETENTION_INPUT_LIVE_CANVAS',
  'RETENTION_INPUT_RECORDS', 'RETENTION_INPUT_INSTANCES', 'RETENTION_INPUT_CHANGED_RANGES', 'RETENTION_INPUT_RETAIN',
  'RETENTION_INPUT_READBACK', 'RETENTION_INPUT_DIRTY_COUNT', 'RETENTION_INPUT_OPTIONAL_KEY_MASK',
  'RETENTION_INPUT_TEXEL_BYTES', 'RETENTION_INPUT_DAMAGE_SELECTION',
  'RETENTION_FRAME_SIZE', 'RETENTION_FRAME_FLAGS', 'RETENTION_FRAME_DIRTY_COUNT', 'RETENTION_FRAME_RECTANGLES',
  'RETENTION_FRAME_REGIONS', 'RETENTION_FRAME_READBACK_BYTES', 'RETENTION_FRAME_RECTANGLE_POINTER',
  'RETENTION_FRAME_REGION_POINTER', 'RETENTION_FRAME_DAMAGE_POINTER', 'RETENTION_FRAME_DAMAGE_COUNT',
  'RETENTION_FRAME_DECODED_RECORDS', 'RETENTION_FRAME_DIRTY_POINTER',
  'RETENTION_FRAME_FLAG_REBUILT', 'RETENTION_FRAME_FLAG_CHANGED', 'RETENTION_FRAME_FLAG_PARTIAL',
  'RETENTION_FRAME_FLAG_REUSE', 'RETENTION_FRAME_FLAG_SELECT',
  'RETENTION_RECTANGLE_SIZE', 'RETENTION_RECTANGLE_X', 'RETENTION_RECTANGLE_Y', 'RETENTION_RECTANGLE_WIDTH',
  'RETENTION_RECTANGLE_HEIGHT',
  'RETENTION_REGION_SIZE', 'RETENTION_REGION_X', 'RETENTION_REGION_Y', 'RETENTION_REGION_WIDTH',
  'RETENTION_REGION_HEIGHT', 'RETENTION_REGION_PIXEL_OFFSET',
  'RETENTION_INDEX_INDEXED', 'RETENTION_INDEX_RETAIN',
  'READBACK_CONTEXT_PIXEL_BYTES', 'READBACK_CONTEXT_WIDTH', 'READBACK_CONTEXT_HEIGHT', 'READBACK_SLOT_CONTEXT',
  'READBACK_SLOT_TOKEN', 'READBACK_SLOT_RAW', 'READBACK_SLOT_PIXELS', 'READBACK_SLOT_FRAME', 'READBACK_SLOT_FORMAT',
  'READBACK_STATE_COMPLETED', 'READBACK_FORMAT_RGBA8',
].map((name) => [name, layoutConstant(name)])));

// Native retention owns comparison keys, damage geometry and frame publication.
// These identities represent opaque publication values, not raster decisions.
export function createRasterRetention(core, width, height, texelBytes) {
  const state = core.raster_retention_create(width, height);
  const owner = { value: undefined, identity: 0 };
  const resource = { value: undefined, identity: 0 };
  let inputPointer = 0;
  let inputCapacity = 0;
  let destroyed = false;
  let graphicsReader = null;
  // The content revision of each canvas the committed frame drew, by its
  // image index. A canvas is live, and the frame repaints whole, only when
  // its content changed since then: the dirty tiles name document changes,
  // and a canvas's own drawing changes none.
  let committedCanvasRevisions = new Map();
  function identity(slot, value) {
    if (value == null) return 0;
    if (slot.value !== value) {
      slot.value = value;
      slot.identity = core.gpu_handle_allocate();
    }
    return slot.identity;
  }
  function rectangles(frame, pointerField, countField) {
    const view = new DataView(core.memory.buffer);
    const pointer = view.getUint32(frame + pointerField, true);
    const count = view.getUint32(frame + countField, true);
    return Array.from({ length: count }, (_, index) => {
      const offset = pointer + index * LAYOUT.RETENTION_RECTANGLE_SIZE;
      return { x: view.getUint32(offset + LAYOUT.RETENTION_RECTANGLE_X, true),
        y: view.getUint32(offset + LAYOUT.RETENTION_RECTANGLE_Y, true),
        w: view.getUint32(offset + LAYOUT.RETENTION_RECTANGLE_WIDTH, true),
        h: view.getUint32(offset + LAYOUT.RETENTION_RECTANGLE_HEIGHT, true) };
    });
  }
  return {
    core,
    prepare(options) {
      if (destroyed) throw new Error('Raster retention is destroyed');
      const publication = options.commandRetention;
      const descriptor = options.rasterPlanDescriptor;
      const reader = options.rasterPlan;
      const dirtyLength = options.dirtyTiles?.byteLength ?? 0;
      const dirtyOffset = options.dirtyTiles?.byteOffset ?? 0;
      const dirtyMemory = options.dirtyTiles?.buffer === core.memory.buffer ? core.memory
        : options.dirtyTiles?.buffer === descriptor.memory.buffer ? descriptor.memory : null;
      const ownerIdentity = identity(owner, publication?.owner);
      const resourceIdentity = identity(resource, publication?.resourceRevision);
      const indexFlags = descriptor.exports.raster_retention_index(descriptor.plan, ownerIdentity,
        options.dirtyTiles == null ? -1 : dirtyLength, options.tileSize ?? 64);
      const canvasRevisions = new Map();
      for (const index of reader.imageResources()) {
        const image = options.images?.get(index);
        if (image?.kind === 'canvas') canvasRevisions.set(index, image.revision);
      }
      const totals = {
        instances: reader.instanceTotal(),
        liveImage: [...canvasRevisions].some(([index, revision]) => committedCanvasRevisions.get(index) !== revision),
      };
      const length = LAYOUT.RETENTION_INPUT_SIZE + dirtyLength;
      if (length > inputCapacity) {
        if (inputPointer) core.abi_free(inputPointer);
        inputPointer = core.abi_malloc(length);
        if (!inputPointer) throw new Error(`Raster retention could not allocate ${length} input bytes`);
        inputCapacity = length;
      }
      const input = new DataView(core.memory.buffer, inputPointer, length);
      new Uint8Array(core.memory.buffer, inputPointer, LAYOUT.RETENTION_INPUT_SIZE).fill(0);
      input.setUint32(LAYOUT.RETENTION_INPUT_OWNER, ownerIdentity, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_RESOURCE_REVISION, resourceIdentity, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_PLAN, descriptor.plan, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_PLAN_BYTES, reader.bytes.byteLength, true);
      input.setFloat64(LAYOUT.RETENTION_INPUT_REVISION, publication?.revision ?? 0, true);
      const rectangle = options.visibleRectangle;
      const key = [options.deviceScale ?? 1, options.renderMode === 'high-dynamic-range' ? 1 : 0,
        rectangle?.x ?? 0, rectangle?.y ?? 0, rectangle?.width ?? 0, rectangle?.height ?? 0,
        options.background?.r ?? 0, options.background?.g ?? 0, options.background?.b ?? 0, options.background?.a ?? 0,
        options.textThickening?.lightInk ?? 0, options.textThickening?.darkInk ?? 0, width, height, options.tileSize ?? 64];
      key.forEach((value, index) =>
        input.setFloat64(LAYOUT.RETENTION_INPUT_TARGET_KEY + index * Float64Array.BYTES_PER_ELEMENT, value, true));
      input.setUint32(LAYOUT.RETENTION_INPUT_INDEXED, Number((indexFlags & LAYOUT.RETENTION_INDEX_INDEXED) !== 0), true);
      input.setUint32(LAYOUT.RETENTION_INPUT_LIVE_CANVAS, Number(totals.liveImage), true);
      input.setUint32(LAYOUT.RETENTION_INPUT_RECORDS, reader.count, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_INSTANCES, totals.instances, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_CHANGED_RANGES, publication?.ranges?.length ?? 0, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_RETAIN, Number((indexFlags & LAYOUT.RETENTION_INDEX_RETAIN) !== 0), true);
      input.setUint32(LAYOUT.RETENTION_INPUT_READBACK, options.readback === 'none' ? 0 : 1, true);
      input.setInt32(LAYOUT.RETENTION_INPUT_DIRTY_COUNT, options.dirtyTiles == null ? -1 : dirtyLength, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_OPTIONAL_KEY_MASK, Number(rectangle?.x !== undefined) |
        (Number(rectangle?.y !== undefined) << 1) |
        (Number(rectangle?.width !== undefined) << 2) | (Number(rectangle?.height !== undefined) << 3), true);
      input.setUint32(LAYOUT.RETENTION_INPUT_TEXEL_BYTES, texelBytes, true);
      input.setUint32(LAYOUT.RETENTION_INPUT_DAMAGE_SELECTION, Number(options.damageSelection === true), true);
      if (dirtyLength) new Uint8Array(core.memory.buffer, inputPointer + LAYOUT.RETENTION_INPUT_SIZE, dirtyLength).set(
        dirtyMemory === null ? options.dirtyTiles : new Uint8Array(dirtyMemory.buffer, dirtyOffset, dirtyLength),
      );
      const frame = core.raster_retention_prepare(state, inputPointer);
      const header = new DataView(core.memory.buffer, frame, LAYOUT.RETENTION_FRAME_SIZE);
      const flags = header.getUint32(LAYOUT.RETENTION_FRAME_FLAGS, true);
      const dirtyCount = header.getInt32(LAYOUT.RETENTION_FRAME_DIRTY_COUNT, true);
      const damagePointer = header.getUint32(LAYOUT.RETENTION_FRAME_DAMAGE_POINTER, true);
      const damageCount = header.getUint32(LAYOUT.RETENTION_FRAME_DAMAGE_COUNT, true);
      const dirtyPointer = header.getUint32(LAYOUT.RETENTION_FRAME_DIRTY_POINTER, true);
      const decodedRecords = header.getUint32(LAYOUT.RETENTION_FRAME_DECODED_RECORDS, true);
      if (flags & (LAYOUT.RETENTION_FRAME_FLAG_REBUILT | LAYOUT.RETENTION_FRAME_FLAG_CHANGED)) graphicsReader = reader;
      else graphicsReader.refresh();
      let selected = graphicsReader;
      let replayPlan = 0;
      if (flags & LAYOUT.RETENTION_FRAME_FLAG_SELECT) {
        // The plan can belong to another core. Its owner receives the bounded map.
        const pointer = descriptor.exports.abi_malloc(dirtyCount);
        if (!pointer) throw new Error(`Raster selection could not allocate ${dirtyCount} dirty-tile bytes`);
        try {
          new Uint8Array(descriptor.memory.buffer, pointer, dirtyCount).set(new Uint8Array(core.memory.buffer, dirtyPointer, dirtyCount));
          replayPlan = descriptor.exports.raster_plan_select(descriptor.plan, pointer, dirtyCount);
        } finally { descriptor.exports.abi_free(pointer); }
        if (replayPlan) selected = openRasterPlan(descriptor, replayPlan);
      }
      let released = false;
      return {
        core, pointer: frame, planReader: selected, reuse: Boolean(flags & LAYOUT.RETENTION_FRAME_FLAG_REUSE),
        partial: Boolean(flags & LAYOUT.RETENTION_FRAME_FLAG_PARTIAL), damagePointer,
        damageCount: flags & LAYOUT.RETENTION_FRAME_FLAG_PARTIAL ? damageCount : -1,
        get dirtyTiles() { return dirtyCount < 0 ? null : new Uint8Array(core.memory.buffer, dirtyPointer, dirtyCount); },
        dirtyRectangles() { return rectangles(frame, LAYOUT.RETENTION_FRAME_RECTANGLE_POINTER, LAYOUT.RETENTION_FRAME_RECTANGLES); },
        damageRectangles() { return rectangles(frame, LAYOUT.RETENTION_FRAME_DAMAGE_POINTER, LAYOUT.RETENTION_FRAME_DAMAGE_COUNT); },
        storePixels(pixels) {
          const pointer = core.raster_retention_pixels(frame);
          new Float32Array(core.memory.buffer, pointer, width * height * 4).set(pixels);
        },
        cachedPixels() {
          const pointer = core.raster_retention_pixels(frame);
          return new Float32Array(core.memory.buffer, pointer, width * height * 4).slice();
        },
        statistics: { rebuilt: Boolean(flags & LAYOUT.RETENTION_FRAME_FLAG_REBUILT), decodedRecords,
          replayedInstances: selected === graphicsReader ? totals.instances : selected.instanceTotal(),
          replayedBatches: selected.count, damageSelected: selected !== graphicsReader },
        commit() {
          if (destroyed || released) throw new Error('Raster frame is released');
          core.raster_retention_commit(frame);
          committedCanvasRevisions = canvasRevisions;
        },
        release() {
          if (released) return;
          released = true;
          if (replayPlan) descriptor.exports.raster_plan_release(replayPlan);
          if (!destroyed) core.raster_retention_release(frame);
        },
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      core.raster_retention_destroy(state);
      if (inputPointer) core.abi_free(inputPointer);
    },
  };
}

// Pixels and partial regions are complete only after gpu_completion. Copies
// here give the caller ownership without exposing movable Wasm views. A
// slot's format names its sample type: uint8 for READBACK_FORMAT_RGBA8,
// float32 otherwise. Packed region offsets count 16-byte float32 pixels.
export function readbackResult(binding, slot) {
  const { core } = binding;
  const token = new DataView(core.memory.buffer).getUint32(slot + LAYOUT.READBACK_SLOT_TOKEN, true);
  let ready;
  const completion = () => ready ??= new Promise((reply, fail) => binding.readback(slot, { reply, throw: fail }));
  let delivered = false;
  return {
    deferred: true,
    async discard() {
      await completion();
      if (binding.closed || delivered) throw new Error(`GPU readback ${token} is released`);
      delivered = true;
      core.gpu_readback_release(slot, token);
    },
    async collect() {
      await completion();
      return { finish() {
        if (binding.closed || delivered) throw new Error(`GPU readback ${token} is released`);
        delivered = true;
        const view = new DataView(core.memory.buffer);
        if (view.getUint32(slot + LAYOUT.READBACK_SLOT_TOKEN, true) !== token ||
          core.gpu_readback_state(slot) !== LAYOUT.READBACK_STATE_COMPLETED) {
          throw new Error(`GPU readback ${token} has not completed through gpu_completion`);
        }
        const context = view.getUint32(slot + LAYOUT.READBACK_SLOT_CONTEXT, true);
        const frame = view.getUint32(slot + LAYOUT.READBACK_SLOT_FRAME, true);
        const bytes = view.getUint32(slot + LAYOUT.READBACK_SLOT_FORMAT, true) === LAYOUT.READBACK_FORMAT_RGBA8;
        const Samples = bytes ? Uint8Array : Float32Array;
        const samples = view.getUint32(context + LAYOUT.READBACK_CONTEXT_WIDTH, true) *
          view.getUint32(context + LAYOUT.READBACK_CONTEXT_HEIGHT, true) * 4;
        const pixels = new Samples(core.memory.buffer, view.getUint32(slot + LAYOUT.READBACK_SLOT_PIXELS, true), samples).slice();
        const result = { pixels, readbackByteLength: view.getUint32(frame + LAYOUT.RETENTION_FRAME_READBACK_BYTES, true) };
        if (view.getUint32(frame + LAYOUT.RETENTION_FRAME_FLAGS, true) & LAYOUT.RETENTION_FRAME_FLAG_PARTIAL) {
          const regions = view.getUint32(frame + LAYOUT.RETENTION_FRAME_REGION_POINTER, true);
          const raw = view.getUint32(slot + LAYOUT.READBACK_SLOT_RAW, true);
          result.pixelRegions = Array.from({ length: view.getUint32(frame + LAYOUT.RETENTION_FRAME_REGIONS, true) }, (_, index) => {
            const offset = regions + index * LAYOUT.RETENTION_REGION_SIZE;
            const width = view.getUint32(offset + LAYOUT.RETENTION_REGION_WIDTH, true);
            const height = view.getUint32(offset + LAYOUT.RETENTION_REGION_HEIGHT, true);
            return { x: view.getUint32(offset + LAYOUT.RETENTION_REGION_X, true),
              y: view.getUint32(offset + LAYOUT.RETENTION_REGION_Y, true), width, height,
              pixels: new Samples(core.memory.buffer, raw + view.getUint32(offset + LAYOUT.RETENTION_REGION_PIXEL_OFFSET, true) /
                (bytes ? 4 : 1), width * height * 4).slice() };
          });
        }
        core.gpu_readback_release(slot, token);
        return result;
      } };
    },
  };
}
