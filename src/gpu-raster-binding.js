import { openRasterPlan } from './raster-plan.js';

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
      const offset = pointer + index * 16;
      return { x: view.getUint32(offset, true), y: view.getUint32(offset + 4, true),
        w: view.getUint32(offset + 8, true), h: view.getUint32(offset + 12, true) };
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
      const totals = reader.recordTotals(index => options.images?.get(index)?.kind === 'canvas');
      const length = 192 + dirtyLength;
      if (length > inputCapacity) {
        if (inputPointer) core.abi_free(inputPointer);
        inputPointer = core.abi_malloc(length);
        if (!inputPointer) throw new Error(`Raster retention could not allocate ${length} input bytes`);
        inputCapacity = length;
      }
      const input = new DataView(core.memory.buffer, inputPointer, length);
      new Uint8Array(core.memory.buffer, inputPointer, 192).fill(0);
      input.setUint32(0, ownerIdentity, true);
      input.setUint32(4, resourceIdentity, true);
      input.setUint32(8, descriptor.plan, true);
      input.setUint32(12, reader.bytes.byteLength, true);
      input.setFloat64(16, publication?.revision ?? 0, true);
      const rectangle = options.visibleRectangle;
      const key = [options.deviceScale ?? 1, options.renderMode === 'high-dynamic-range' ? 1 : 0,
        rectangle?.x ?? 0, rectangle?.y ?? 0, rectangle?.width ?? 0, rectangle?.height ?? 0,
        options.background?.r ?? 0, options.background?.g ?? 0, options.background?.b ?? 0, options.background?.a ?? 0,
        options.textThickening?.lightInk ?? 0, options.textThickening?.darkInk ?? 0, width, height, options.tileSize ?? 64];
      key.forEach((value, index) => input.setFloat64(24 + index * 8, value, true));
      input.setUint32(144, indexFlags & 1, true);
      input.setUint32(148, Number(totals.liveImage), true);
      input.setUint32(152, reader.count, true);
      input.setUint32(156, totals.instances, true);
      input.setUint32(160, publication?.ranges?.length ?? 0, true);
      input.setUint32(164, indexFlags >>> 1, true);
      input.setUint32(168, options.readback === 'none' ? 0 : 1, true);
      input.setInt32(172, options.dirtyTiles == null ? -1 : dirtyLength, true);
      input.setUint32(176, Number(rectangle?.x !== undefined) | (Number(rectangle?.y !== undefined) << 1) |
        (Number(rectangle?.width !== undefined) << 2) | (Number(rectangle?.height !== undefined) << 3), true);
      input.setUint32(180, texelBytes, true);
      input.setUint32(184, Number(options.damageSelection === true), true);
      if (dirtyLength) new Uint8Array(core.memory.buffer, inputPointer + 192, dirtyLength).set(
        dirtyMemory === null ? options.dirtyTiles : new Uint8Array(dirtyMemory.buffer, dirtyOffset, dirtyLength),
      );
      const frame = core.raster_retention_prepare(state, inputPointer);
      const header = new DataView(core.memory.buffer, frame, 256);
      const flags = header.getUint32(8, true);
      const dirtyCount = header.getInt32(12, true);
      const damagePointer = header.getUint32(36, true);
      const damageCount = header.getUint32(40, true);
      const dirtyPointer = header.getUint32(240, true);
      const decodedRecords = header.getUint32(44, true);
      if (flags & 3) graphicsReader = reader;
      else graphicsReader.refresh();
      let selected = graphicsReader;
      let replayPlan = 0;
      if (flags & 16) {
        // The plan can belong to another core. Its owner receives the bounded map.
        const pointer = descriptor.exports.abi_malloc(dirtyCount);
        if (!pointer) throw new Error(`Raster selection could not allocate ${dirtyCount} dirty-tile bytes`);
        try {
          new Uint8Array(descriptor.memory.buffer, pointer, dirtyCount).set(new Uint8Array(core.memory.buffer, dirtyPointer, dirtyCount));
          replayPlan = descriptor.exports.raster_plan_select(descriptor.plan, pointer, dirtyCount);
        } finally { descriptor.exports.abi_free(pointer); }
        if (replayPlan) selected = openRasterPlan(descriptor.memory, replayPlan);
      }
      let released = false;
      return {
        core, pointer: frame, planReader: selected, reuse: Boolean(flags & 8),
        partial: Boolean(flags & 4), damagePointer, damageCount: flags & 4 ? damageCount : -1,
        get dirtyTiles() { return dirtyCount < 0 ? null : new Uint8Array(core.memory.buffer, dirtyPointer, dirtyCount); },
        dirtyRectangles() { return rectangles(frame, 28, 16); },
        damageRectangles() { return rectangles(frame, 36, 40); },
        storePixels(pixels) {
          const pointer = core.raster_retention_pixels(frame);
          new Float32Array(core.memory.buffer, pointer, width * height * 4).set(pixels);
        },
        cachedPixels() {
          const pointer = core.raster_retention_pixels(frame);
          return new Float32Array(core.memory.buffer, pointer, width * height * 4).slice();
        },
        statistics: { rebuilt: Boolean(flags & 1), decodedRecords,
          replayedInstances: selected === graphicsReader ? totals.instances : selected.recordTotals(() => false).instances,
          replayedBatches: selected.count, damageSelected: selected !== graphicsReader },
        commit() {
          if (destroyed || released) throw new Error('Raster frame is released');
          core.raster_retention_commit(frame);
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

// Float pixels and partial regions are complete only after gpu_completion.
// Copies here give the caller ownership without exposing movable Wasm views.
export function readbackResult(binding, slot) {
  const { core } = binding;
  const token = new DataView(core.memory.buffer).getUint32(slot + 12, true);
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
        if (view.getUint32(slot + 12, true) !== token || core.gpu_readback_state(slot) !== 3) {
          throw new Error(`GPU readback ${token} has not completed through gpu_completion`);
        }
        const context = view.getUint32(slot, true);
        const frame = view.getUint32(slot + 32, true);
        const pixels = new Float32Array(core.memory.buffer, view.getUint32(slot + 28, true), view.getUint32(context + 12, true) / 4).slice();
        const result = { pixels, readbackByteLength: view.getUint32(frame + 24, true) };
        if (view.getUint32(frame + 8, true) & 4) {
          const regions = view.getUint32(frame + 32, true);
          const raw = view.getUint32(slot + 20, true);
          result.pixelRegions = Array.from({ length: view.getUint32(frame + 20, true) }, (_, index) => {
            const offset = regions + index * 32;
            const width = view.getUint32(offset + 8, true), height = view.getUint32(offset + 12, true);
            return { x: view.getUint32(offset, true), y: view.getUint32(offset + 4, true), width, height,
              pixels: new Float32Array(core.memory.buffer, raw + view.getUint32(offset + 24, true), width * height * 4).slice() };
          });
        }
        core.gpu_readback_release(slot, token);
        return result;
      } };
    },
  };
}
