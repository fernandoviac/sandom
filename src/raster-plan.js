import { nativeAtlasView, flushNativeAtlasEffects } from "./atlas.js";
import {
  clipUniformFloats as packClipUniformFloats,
  MAX_SHADER_CLIP_ENTRIES,
} from "./gpu-composition-clip.js";
import {
  CMD_DAMAGE,
  CMD_IMAGE,
  CMD_IMAGE_FLAG_PIXELATED,
  CMD_PUSH_BLEND_LAYER,
  CMD_PUSH_OPACITY,
  RASTER_PLAN_ABI_VERSION,
  RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS,
  RASTER_PLAN_CLIP_ENTRY_SIZE,
  RASTER_PLAN_CLIP_FLOATS,
  RASTER_PLAN_CLIP_PATH_MASK_FLOATS,
  RASTER_PLAN_FILTER_DESCRIPTOR_BYTES,
  RASTER_PLAN_FILTER_LIST_OFFSET,
  RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES,
  RASTER_PLAN_GRADIENT_RECORD_BYTES,
  RASTER_PLAN_GRADIENT_STOP_BYTES,
  RASTER_PLAN_GROUP_POP_FLOATS,
  RASTER_PLAN_HEADER_SIZE,
  RASTER_PLAN_MAGIC,
  RASTER_PLAN_NO_CLIP,
  RASTER_PLAN_PASS_BOX_BLUR_H,
  RASTER_PLAN_PASS_BOX_BLUR_V,
  RASTER_PLAN_PASS_DROP_SHADOW,
  RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY,
  RASTER_PLAN_RECORD_OFFSET_CLIP,
  RASTER_PLAN_RECORD_OFFSET_FLAGS,
  RASTER_PLAN_RECORD_OFFSET_GRADIENT,
  RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES,
  RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT,
  RASTER_PLAN_RECORD_OFFSET_KIND,
  RASTER_PLAN_RECORD_OFFSET_PAYLOAD,
  RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES,
  RASTER_PLAN_RECORD_OFFSET_SOURCE,
  RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES,
  RASTER_PLAN_RECORD_OFFSET_RESOURCE,
  RASTER_PLAN_RECORD_SIZE,
} from "./wasm/layout.js";

export const EMPTY_CLIP_STATE = Object.freeze({
  entries: Object.freeze([]),
  bounds: null,
  clipIndex: RASTER_PLAN_NO_CLIP,
  entryCount: 0,
  packedFloats: new Float32Array(RASTER_PLAN_CLIP_FLOATS),
  pathMaskFloats: null,
});
export const RECT_INSTANCE_FLOATS = 44;
export const BOX_SHADOW_INSTANCE_FLOATS =
  RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS;
export const GRADIENT_RECORD_STRIDE = RASTER_PLAN_GRADIENT_RECORD_BYTES;
export const GRADIENT_STOP_STRIDE = RASTER_PLAN_GRADIENT_STOP_BYTES;
export function clipUniformFloats(clipState) {
  return clipState.packedFloats ?? packClipUniformFloats(clipState);
}
export { MAX_SHADER_CLIP_ENTRIES };

// Record table words and halves, for the totals passes below.
const RECORD_WORDS = RASTER_PLAN_RECORD_SIZE / 4;
const RECORD_WORD_INSTANCE_COUNT = RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT /
  4;
const RECORD_WORD_RESOURCE = RASTER_PLAN_RECORD_OFFSET_RESOURCE / 4;
const RECORD_HALF_KIND = RASTER_PLAN_RECORD_OFFSET_KIND / 2;

export function openRasterPlan(memory, plan) {
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError("openRasterPlan: memory must be WebAssembly.Memory");
  }
  if (!Number.isInteger(plan) || plan <= 0) {
    throw new RangeError(`openRasterPlan: plan handle ${plan} is not a positive integer`);
  }

  let view;
  let bytes;
  let recordCount;
  let recordTableOffset;
  let clipTableOffset;
  const clipStates = new Map();
  let clipCount;
  let payloadRegionOffset;
  let payloadRegionBytes;

  function refresh() {
    if (plan + RASTER_PLAN_HEADER_SIZE > memory.buffer.byteLength) {
      throw new RangeError(
        `openRasterPlan: ${RASTER_PLAN_HEADER_SIZE}-byte header at ${plan} exceeds ${memory.buffer.byteLength}-byte memory`,
      );
    }
    clipStates.clear();
    view = new DataView(memory.buffer, plan);
    const magic = view.getUint32(0, true);
    const abiVersion = view.getUint32(4, true);
    if (magic !== RASTER_PLAN_MAGIC) {
      throw new Error(
        `openRasterPlan: magic 0x${magic.toString(16)} does not equal SRPL 0x${RASTER_PLAN_MAGIC.toString(16)}`,
      );
    }
    if (abiVersion !== RASTER_PLAN_ABI_VERSION) {
      throw new Error(
        `openRasterPlan: ABI version ${abiVersion} is unsupported; expected ${RASTER_PLAN_ABI_VERSION}`,
      );
    }

    const totalBytes = view.getUint32(8, true);
    recordCount = view.getUint32(12, true);
    recordTableOffset = view.getUint32(20, true);
    const recordStride = view.getUint32(24, true);
    clipTableOffset = view.getUint32(52, true);
    clipCount = view.getUint32(56, true);
    payloadRegionOffset = view.getUint32(60, true);
    payloadRegionBytes = view.getUint32(64, true);
    if (recordTableOffset !== RASTER_PLAN_HEADER_SIZE || recordStride !== RASTER_PLAN_RECORD_SIZE) {
      throw new Error(
        `openRasterPlan: record table offset/stride ${recordTableOffset}/${recordStride} does not equal ${RASTER_PLAN_HEADER_SIZE}/${RASTER_PLAN_RECORD_SIZE}`,
      );
    }
    if (totalBytes < RASTER_PLAN_HEADER_SIZE || plan + totalBytes > memory.buffer.byteLength) {
      throw new RangeError(
        `openRasterPlan: ${totalBytes}-byte plan at ${plan} exceeds ${memory.buffer.byteLength}-byte memory`,
      );
    }
    const recordsEnd = recordTableOffset + recordCount * recordStride;
    const clipsEnd = clipTableOffset + clipCount * RASTER_PLAN_CLIP_ENTRY_SIZE;
    const payloadEnd = payloadRegionOffset + payloadRegionBytes;
    if (
      clipTableOffset < recordsEnd || payloadRegionOffset < clipsEnd ||
      payloadEnd > totalBytes || (payloadRegionOffset & 15) !== 0
    ) {
      throw new Error(
        `openRasterPlan: invalid regions recordsEnd=${recordsEnd}, clipTable=${clipTableOffset}..${clipsEnd}, payload=${payloadRegionOffset}..${payloadEnd}, total=${totalBytes}`,
      );
    }
    bytes = new Uint8Array(memory.buffer, plan, totalBytes);
    return reader;
  }

  function ensureCurrentMemory() {
    if (view.buffer !== memory.buffer) refresh();
  }

  function recordOffset(index) {
    ensureCurrentMemory();
    if (!Number.isInteger(index) || index < 0 || index >= recordCount) {
      throw new RangeError(`raster plan record index ${index} is outside 0..${recordCount - 1}`);
    }
    return recordTableOffset + index * RASTER_PLAN_RECORD_SIZE;
  }

  const reader = {
    // The plan's address in its memory.
    get address() {
      return plan;
    },
    get count() {
      ensureCurrentMemory();
      return recordCount;
    },
    kind(index) {
      const offset = recordOffset(index);
      return view.getUint16(offset + RASTER_PLAN_RECORD_OFFSET_KIND, true);
    },
    flags(index) {
      const offset = recordOffset(index);
      return view.getUint16(offset + RASTER_PLAN_RECORD_OFFSET_FLAGS, true);
    },
    sourceOffset(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_SOURCE, true);
    },
    sourceBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES, true);
    },
    clipIndex(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_CLIP, true);
    },
    clip(index) {
      const offset = recordOffset(index);
      const clipIndex = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_CLIP, true);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      const clipOffset = clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE;
      return new Float32Array(
        memory.buffer,
        plan + clipOffset + 4,
        RASTER_PLAN_CLIP_FLOATS,
      );
    },
    clipEntryCount(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return 0;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      return view.getUint32(
        clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE,
        true,
      );
    },
    clipBounds(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      const offset = clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE +
        4 + (RASTER_PLAN_CLIP_FLOATS + RASTER_PLAN_CLIP_PATH_MASK_FLOATS) * 4;
      const minX = view.getFloat32(offset, true);
      return Number.isNaN(minX)
        ? null
        : {
          minX,
          minY: view.getFloat32(offset + 4, true),
          maxX: view.getFloat32(offset + 8, true),
          maxY: view.getFloat32(offset + 12, true),
        };
    },
    pathMask(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return null;
      if (clipIndex >= clipCount) {
        throw new RangeError(`raster plan clip index ${clipIndex} exceeds count ${clipCount}`);
      }
      return new Float32Array(
        memory.buffer,
        plan + clipTableOffset + clipIndex * RASTER_PLAN_CLIP_ENTRY_SIZE +
          4 + RASTER_PLAN_CLIP_FLOATS * 4,
        RASTER_PLAN_CLIP_PATH_MASK_FLOATS,
      );
    },
    clipState(index) {
      const clipIndex = reader.clipIndex(index);
      if (clipIndex === RASTER_PLAN_NO_CLIP) return EMPTY_CLIP_STATE;
      let state = clipStates.get(clipIndex);
      if (state === undefined) {
        const entryCount = reader.clipEntryCount(index);
        let packedFloats = reader.clip(index);
        let pathMaskFloats = reader.pathMask(index);
        state = Object.freeze({
          entries: Object.freeze(Array.from({ length: entryCount }, () => null)),
          // Atlas effects can grow the fused core while a backend holds this
          // clip. Keep native offsets authoritative across memory replacement.
          get packedFloats() {
            if (packedFloats.buffer !== memory.buffer) packedFloats = reader.clip(index);
            return packedFloats;
          },
          get pathMaskFloats() {
            if (pathMaskFloats.buffer !== memory.buffer) pathMaskFloats = reader.pathMask(index);
            return pathMaskFloats;
          },
          entryCount,
          bounds: reader.clipBounds(index),
          clipIndex,
        });
        clipStates.set(clipIndex, state);
      }
      return state;
    },
    payload(index) {
      const offset = recordOffset(index);
      const payloadOffset = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD, true);
      const payloadBytes = view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES, true);
      if ((payloadOffset & 3) !== 0 || (payloadBytes & 3) !== 0 || payloadOffset + payloadBytes > payloadRegionBytes) {
        throw new RangeError(
          `raster plan payload ${payloadOffset}..${payloadOffset + payloadBytes} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Float32Array(
        memory.buffer,
        plan + payloadRegionOffset + payloadOffset,
        payloadBytes >>> 2,
      );
    },
    // Totals every backend-independent consumer reads from the record
    // table: the instances the records draw (a DAMAGE record's count is
    // its rectangles, which scissor and draw nothing), and whether any
    // record draws an image whose resource `imageKind` reports as live.
    recordTotals(imageKind) {
      ensureCurrentMemory();
      const words = new Uint32Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS,
      );
      const halves = new Uint16Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS * 2,
      );
      let instances = 0;
      let liveImage = false;
      for (let index = 0; index < recordCount; index++) {
        const word = index * RECORD_WORDS;
        const kind = halves[index * RECORD_WORDS * 2 + RECORD_HALF_KIND];
        if (kind !== CMD_DAMAGE) {
          instances += words[word + RECORD_WORD_INSTANCE_COUNT];
        }
        if (!liveImage && kind === CMD_IMAGE) {
          liveImage = imageKind(words[word + RECORD_WORD_RESOURCE]);
        }
      }
      return { instances, liveImage };
    },
    // The image resources that the plan's CMD_IMAGE records draw. A frame
    // captures only these canvases: the host image map holds every image
    // of the runtime, other documents' canvases included.
    imageResources() {
      ensureCurrentMemory();
      const words = new Uint32Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS,
      );
      const halves = new Uint16Array(
        memory.buffer,
        plan + recordTableOffset,
        recordCount * RECORD_WORDS * 2,
      );
      const resources = new Set();
      for (let index = 0; index < recordCount; index++) {
        if (halves[index * RECORD_WORDS * 2 + RECORD_HALF_KIND] === CMD_IMAGE) {
          resources.add(words[index * RECORD_WORDS + RECORD_WORD_RESOURCE]);
        }
      }
      return resources;
    },
    // The first `byteLength` bytes of the payload region.
    payloadRegion(byteLength) {
      ensureCurrentMemory();
      if (byteLength > payloadRegionBytes) {
        throw new RangeError(
          `raster plan payload prefix of ${byteLength} bytes exceeds the ${payloadRegionBytes}-byte region`,
        );
      }
      return new Uint8Array(
        memory.buffer,
        plan + payloadRegionOffset,
        byteLength,
      );
    },
    payloadOffset(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD, true);
    },
    payloadBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES, true);
    },
    gradientBytes(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES, true);
    },
    // The payload bytes `start..end` as one view; `drawSequence` names the
    // spans whose bytes are contiguous.
    payloadBytesView(start, end) {
      ensureCurrentMemory();
      if (
        (start & 3) !== 0 || (end & 3) !== 0 || start > end ||
        end > payloadRegionBytes
      ) {
        throw new RangeError(
          `raster plan payload span ${start}..${end} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Float32Array(
        memory.buffer,
        plan + payloadRegionOffset + start,
        (end - start) >>> 2,
      );
    },
    instanceCount(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT, true);
    },
    resource(index) {
      const offset = recordOffset(index);
      return view.getUint32(offset + RASTER_PLAN_RECORD_OFFSET_RESOURCE, true);
    },
    gradient(index) {
      const offset = recordOffset(index);
      const gradientOffset = view.getUint32(
        offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT,
        true,
      );
      const gradientBytes = view.getUint32(
        offset + RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES,
        true,
      );
      if (
        (gradientOffset & 3) !== 0 || (gradientBytes & 3) !== 0 ||
        gradientOffset + gradientBytes > payloadRegionBytes
      ) {
        throw new RangeError(
          `raster plan gradient ${gradientOffset}..${gradientOffset + gradientBytes} exceeds ${payloadRegionBytes}-byte region`,
        );
      }
      return new Uint8Array(
        memory.buffer,
        plan + payloadRegionOffset + gradientOffset,
        gradientBytes,
      );
    },
    gradientParts(index) {
      const gradient = reader.gradient(index);
      if (gradient.byteLength === 0) return null;
      if (gradient.byteLength < GRADIENT_RECORD_STRIDE) {
        throw new Error(
          `raster plan gradient at record ${index} has ${gradient.byteLength} bytes; expected at least ${GRADIENT_RECORD_STRIDE}`,
        );
      }
      const gradientView = new DataView(
        gradient.buffer,
        gradient.byteOffset,
        gradient.byteLength,
      );
      const stopCount = gradientView.getUint32(12, true);
      const expectedBytes = GRADIENT_RECORD_STRIDE +
        stopCount * GRADIENT_STOP_STRIDE;
      if (gradient.byteLength !== expectedBytes) {
        throw new Error(
          `raster plan gradient at record ${index} has ${gradient.byteLength} bytes; expected ${expectedBytes}`,
        );
      }
      return {
        record: gradient.subarray(0, GRADIENT_RECORD_STRIDE),
        stops: gradient.subarray(GRADIENT_RECORD_STRIDE),
        stopCount,
      };
    },
    filterPasses(index, listOffset = 0) {
      const payload = reader.payload(index);
      if (payload.byteLength < listOffset + 4) {
        throw new Error(
          `native filter pass list at ${listOffset} exceeds ${payload.byteLength}-byte payload`,
        );
      }
      const passView = new DataView(
        payload.buffer,
        payload.byteOffset + listOffset,
        payload.byteLength - listOffset,
      );
      const count = passView.getUint32(0, true);
      const uniformBase = 4 + count * RASTER_PLAN_FILTER_DESCRIPTOR_BYTES;
      const requiredBytes = uniformBase +
        count * RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES;
      if (requiredBytes > passView.byteLength) {
        throw new Error(
          `native filter pass list requires ${requiredBytes} bytes; payload has ${passView.byteLength}`,
        );
      }
      const passes = [];
      for (let passIndex = 0; passIndex < count; passIndex++) {
        const descriptor = 4 +
          passIndex * RASTER_PLAN_FILTER_DESCRIPTOR_BYTES;
        const kind = passView.getUint32(descriptor, true);
        const uniformOffset = passView.getUint32(descriptor + 4, true);
        const uniformBytes = passView.getUint32(descriptor + 8, true);
        if (
          uniformOffset < uniformBase ||
          uniformOffset + uniformBytes > passView.byteLength ||
          (uniformOffset & 3) !== 0 || (uniformBytes & 3) !== 0
        ) {
          throw new Error(
            `native filter pass ${passIndex} uniform ${uniformOffset}..${uniformOffset + uniformBytes} exceeds ${passView.byteLength}-byte list`,
          );
        }
        const uniformAddress = payload.byteOffset + listOffset + uniformOffset;
        let uniform = new Float32Array(memory.buffer, uniformAddress, uniformBytes >>> 2);
        passes.push({
          kind,
          get uniform() {
            if (uniform.buffer !== memory.buffer) {
              uniform = new Float32Array(memory.buffer, uniformAddress, uniformBytes >>> 2);
            }
            return uniform;
          },
        });
      }
      return passes;
    },
    refresh,
    get bytes() {
      ensureCurrentMemory();
      return bytes;
    },
  };

  return refresh();
}

// How far each filter pass list reads beyond the pixel it writes, in
// device pixels per axis: a box pass reads floor(width / 2) texels either
// side along its direction, a drop shadow reads its offset away, a matrix
// pass reads only its own pixel. reaches[2k], reaches[2k + 1] is the x and
// y reach of passes k..end, so reaches[0..1] is the outset the whole list
// needs around the frame for every frame pixel to see the content it reads
// (BUG-css-filter-blur-renormalises-at-the-frame-edge, resolved; see
// design/paint-coverage.md, "Filter passes"), and
// reaches[2k + 2..3] is the outset over which pass k's output is still read.
export function filterPassReaches(passes) {
  const reaches = new Int32Array(2 * passes.length + 2);
  for (let index = passes.length - 1; index >= 0; index--) {
    const { kind, uniform } = passes[index];
    let x = 0;
    let y = 0;
    if (
      kind === RASTER_PLAN_PASS_BOX_BLUR_H ||
      kind === RASTER_PLAN_PASS_BOX_BLUR_V
    ) {
      const radius = Math.floor(uniform[0] / 2);
      x = Math.ceil(radius * Math.abs(uniform[1]));
      y = Math.ceil(radius * Math.abs(uniform[2]));
    } else if (kind === RASTER_PLAN_PASS_DROP_SHADOW) {
      x = Math.ceil(Math.abs(uniform[0]));
      y = Math.ceil(Math.abs(uniform[1]));
    }
    reaches[2 * index] = reaches[2 * index + 2] + x;
    reaches[2 * index + 1] = reaches[2 * index + 3] + y;
  }
  return reaches;
}

// The padding, per side of one axis, of the texture a filter pass list
// runs on: the list's reach rounded up to FILTER_REGION_PADDING_QUANTUM, so
// a changing blur radius takes the same scratch textures frame after
// frame, and bounded by the largest texture the device can create
// (`maxExtent`). A list bounded there sees the box passes' own edge rule
// at the padded edge instead of the content it would read beyond it.
const FILTER_REGION_PADDING_QUANTUM = 64;
export function filterRegionPadding(reach, extent, maxExtent) {
  const padding = Math.ceil(reach / FILTER_REGION_PADDING_QUANTUM) *
    FILTER_REGION_PADDING_QUANTUM;
  return Math.min(padding, Math.floor((maxExtent - extent) / 2));
}

// Copies the native draw sequence of `reader`'s plan: per entry the first
// record, instance count, payload span and four device-pixel bounds; the
// instance upload prefix; and whether a visited clip carries a path mask.
function rasterPlanSequence(reader, exports) {
  const state = exports.raster_plan_sequence_create();
  try {
    const count = exports.raster_plan_sequence(state, reader.address);
    if (count < 0) {
      throw new RangeError(
        `raster plan payload of record ${exports.raster_plan_sequence_failure_record(state)} ends at ` +
          `${exports.raster_plan_sequence_failure_value(state)}, outside its region or word alignment`,
      );
    }
    const words = new Uint32Array(count * 12);
    words.set(new Uint32Array(exports.memory.buffer, exports.raster_plan_sequence_entries(state), count * 12));
    const floats = new Float32Array(words.buffer);
    const field = (offset) => Uint32Array.from({ length: count }, (_, index) => words[index * 12 + offset]);
    const bounds = new Float32Array(count * 4);
    for (let index = 0; index < count; index++) bounds.set(floats.subarray(index * 12 + 5, index * 12 + 9), index * 4);
    return {
      count,
      first: field(0),
      instanceCount: field(2),
      payloadStart: field(3),
      payloadEnd: field(4),
      bounds,
      uploadBytes: exports.raster_plan_sequence_upload_bytes(state),
      pathMaskInUse: exports.raster_plan_sequence_path_mask(state) !== 0,
    };
  } finally {
    exports.raster_plan_sequence_destroy(state);
  }
}

// Renderer-core forms the draw sequence (`raster_plan_sequence`,
// src/wasm/gpu-frame.watpart), as it does for the GPU command stream;
// `exports` belong to the core whose memory holds the plan.
// One mutable cursor serves the complete frame. It walks the reader's draw
// sequence: selecting an entry changes only numeric indices, and payloads
// remain zero-copy views into the native plan. An entry may cover a SPAN of
// consecutive mergeable records, in which case `instances`, `count` and
// `gradients` describe the whole span and the backend issues one instanced
// draw for it.
export function createRasterPlanCursor(reader, exports, resources = {}) {
  const sequence = rasterPlanSequence(reader, exports);
  let entry = 0;
  let recordIndex = 0;
  let selectionGradients = null;
  let resolvedImages = resources.images ?? null;
  const cursor = {
    // The entries the backend visits, then the payload prefix every draw
    // reads from and whether any clip carries a path mask.
    get entryCount() {
      return sequence.count;
    },
    get uploadBytes() {
      return sequence.uploadBytes;
    },
    get pathMaskInUse() {
      return sequence.pathMaskInUse;
    },
    // Four device-pixel bounds per draw-sequence entry, without a copied view.
    get bounds() {
      return sequence.bounds;
    },
    // Selects entry `index` and returns its first record.
    selectEntry(index) {
      entry = index;
      recordIndex = sequence.first[index];
      selectionGradients = null;
      return recordIndex;
    },
    setImages(images) {
      resolvedImages = images;
    },
    get clipState() {
      return reader.clipState(recordIndex);
    },
    get instances() {
      return reader.payloadBytesView(
        sequence.payloadStart[entry],
        sequence.payloadEnd[entry],
      );
    },
    // The selection's instance bytes within the payload region.
    get payloadByteOffset() {
      return sequence.payloadStart[entry];
    },
    get payloadByteLength() {
      return sequence.payloadEnd[entry] - sequence.payloadStart[entry];
    },
    // Whether the selection's draw can write a pixel of the device-pixel
    // rectangle `x, y, width, height`: its bounds, which hold every pixel
    // centre its quads cover, overlap the rectangle's interior.
    reaches(x, y, width, height) {
      const bounds = sequence.bounds;
      const at = entry * 4;
      return bounds[at] < x + width && bounds[at + 2] > x &&
        bounds[at + 1] < y + height && bounds[at + 3] > y;
    },
    get count() {
      return sequence.instanceCount[entry];
    },
    get resourceIndex() {
      return reader.resource(recordIndex);
    },
    get resourceGeneration() {
      return cursor.atlas?.revision ?? 0;
    },
    get atlas() {
      const identity = reader.resource(recordIndex);
      if (!resources.atlasForIdentity) {
        throw new Error(`Native atlas ${identity} requires the raster plan's graphics resource reader`);
      }
      return resources.atlasForIdentity(identity);
    },
    get image() {
      const imageIndex = reader.resource(recordIndex);
      const image = resolvedImages?.get(imageIndex);
      if (image === undefined) {
        throw new Error(
          `native CMD_IMAGE resource ${imageIndex} is absent from the host image map`,
        );
      }
      return image;
    },
    get pixelated() {
      return (reader.flags(recordIndex) & CMD_IMAGE_FLAG_PIXELATED) !== 0;
    },
    get gradients() {
      if (selectionGradients !== null) return selectionGradients;
      // A span is gradient-free by construction (`drawSequence` refuses to
      // extend across a record that carries gradient bytes), so only the
      // selected record can contribute one.
      const gradient = reader.gradientParts(recordIndex);
      selectionGradients = Object.freeze(Array.from(
        { length: cursor.count },
        (_, index) => index === 0 ? gradient : null,
      ));
      return selectionGradients;
    },
    get gradient() {
      return reader.gradientParts(recordIndex);
    },
    get opacity() {
      return reader.payload(recordIndex)[0];
    },
    get blendMode() {
      return reader.kind(recordIndex) === CMD_PUSH_BLEND_LAYER
        ? reader.resource(recordIndex)
        : reader.payload(recordIndex)[1];
    },
    get filterPasses() {
      return reader.filterPasses(
        recordIndex,
        reader.kind(recordIndex) === CMD_PUSH_OPACITY
          ? RASTER_PLAN_FILTER_LIST_OFFSET
          : 0,
      );
    },
    get hasMask() {
      return (reader.payload(recordIndex)[2] & 1) !== 0;
    },
    get nativeComposite() {
      const payload = reader.payload(recordIndex);
      return payload.length === RASTER_PLAN_GROUP_POP_FLOATS ? payload : null;
    },
    get needsBackdropCopy() {
      return (reader.flags(recordIndex) &
        RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY) !== 0;
    },
    get mode() {
      return new Uint32Array(
        reader.payload(recordIndex).buffer,
        reader.payload(recordIndex).byteOffset,
        2,
      )[0];
    },
    get composite() {
      return new Uint32Array(
        reader.payload(recordIndex).buffer,
        reader.payload(recordIndex).byteOffset,
        2,
      )[1];
    },
    get ownClipState() {
      return reader.clipState(recordIndex);
    },
    get rects() {
      const payload = reader.payload(recordIndex);
      const rects = [];
      for (let offset = 0; offset < payload.length; offset += 4) {
        rects.push({
          x: payload[offset],
          y: payload[offset + 1],
          w: payload[offset + 2],
          h: payload[offset + 3],
        });
      }
      return rects;
    },
  };
  return cursor;
}


// The native plan owns every revision. This cache holds only graphics views.
const rasterPlanAtlasViews = new WeakMap();

export function rasterPlanAtlasResources(descriptor) {
  let plans = rasterPlanAtlasViews.get(descriptor.exports);
  if (!plans) {
    plans = new Map();
    rasterPlanAtlasViews.set(descriptor.exports, plans);
  }
  let state = plans.get(descriptor.plan);
  if (!state) {
    const views = new Map();
    const atlasForIdentity = (identity) => {
      let atlas = views.get(identity);
      if (!atlas) {
        const revision = descriptor.exports.raster_plan_atlas_revision(descriptor.plan, identity);
        atlas = nativeAtlasView(descriptor.memory, identity, revision);
        views.set(identity, atlas);
      }
      return atlas;
    };
    state = { atlasForIdentity };
    plans.set(descriptor.plan, state);
  }
  const pathIdentity = new DataView(descriptor.memory.buffer, descriptor.plan, RASTER_PLAN_HEADER_SIZE).getUint32(88, true);
  return { atlasForIdentity: state.atlasForIdentity,
    svgPathAtlas: pathIdentity ? state.atlasForIdentity(pathIdentity) : null };
}

export function releaseRasterPlan(descriptor) {
  descriptor.exports.raster_plan_release(descriptor.plan);
  rasterPlanAtlasViews.get(descriptor.exports)?.delete(descriptor.plan);
  flushNativeAtlasEffects(descriptor.memory ?? descriptor.exports.memory);
}
