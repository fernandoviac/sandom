import { buildGeometry } from "./geometry.js";
import {
  createIntersectionObserverClass,
  createResizeObserverClass,
} from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";
const geometryStateFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_observer_release(handle);
});

function releaseGeometryState(state, core) {
  if (!state?.geometryHandle) return;
  core.status("geometry_observer_release", state.geometryHandle);
  geometryStateFinalizer.unregister(state);
  state.geometryHandle = 0n;
}

function observerLayout(serialized, boxes, viewport) {
  // Each observer reads this checkpoint's frozen layout across callback mutations,
  // not a fresh live query or the preceding published frame.
  return buildGeometry({ root: serialized.root, boxes, publication: serialized.publication,
    sourceRevisions: serialized.sourceRevisions,
    viewportIndex: serialized.viewportIndex, viewport, presented: true });
}

function outputNumbers(core, count) {
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), core.exports.abi_output_length());
  return Array.from({ length: count }, (_, index) => view.getFloat64(index * 8, true));
}

function logicalSize(inlineSize, blockSize) {
  return Object.freeze([Object.freeze({ inlineSize, blockSize })]);
}
function rectangle(x, y, width, height) {
  return Object.freeze({
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
  });
}


function normalizeThresholds(core, value) {
  const thresholds = value === undefined ? [0] : Array.isArray(value) ? value : [value];
  const normalized = thresholds.map(Number);
  const pointer = core.status("abi_allocate", normalized.length * 16);
  const view = new DataView(core.memory.buffer);
  for (let index = 0; index < normalized.length; index++) {
    view.setFloat64(pointer + index * 16, normalized[index] ?? 0, true);
    view.setUint32(pointer + index * 16 + 8, index in normalized ? 1 : 0, true);
  }
  const count = core.status("geometry_thresholds", pointer, normalized.length);
  return outputNumbers(core, count).map((value) => Number.isNaN(value) ? undefined : value);
}

function parseRootMargin(core, value) {
  if (!core.status("geometry_root_margin", ...core.input(String(value ?? "0px")))) {
    throw new SyntaxError(core.outputString());
  }
  const pointer = core.exports.abi_output_pointer();
  const length = core.exports.abi_output_length();
  const bytes = core.refreshBytes();
  const view = new DataView(bytes.buffer, pointer, length);
  return { parsed: Array.from({ length: 4 }, (_, index) => ({
    value: view.getFloat64(index * 16, true),
    unit: view.getUint32(index * 16 + 8, true) ? "%" : "px",
  })), cssText: core.decoder.decode(bytes.subarray(pointer + 64, pointer + length)) };
}


class RenderingObserver {
  constructor(document, callback, registryName) {
    this._document = document;
    this._callback = callback;
    this._targets = new Map();
    this._registryName = registryName;
    this._core = document._domCore;
    this._ownerHandle = document._coreHandle;
    this._id = this._core.registerObserver(this);
    this._core.status(
      "observer_create",
      this._id,
      this._ownerHandle,
      registryName === "_resizeObservers" ? 1 : 2,
    );
    this._core.renderingObserversById ??= new Map();
  }
  _transportUnobserve(target) {
    releaseGeometryState(this._targets.get(target), this._core);
    this._targets.delete(target);
  }
  _transportDisconnect() {
    for (const state of this._targets.values()) releaseGeometryState(state, this._core);
    this._targets.clear();
    this._document[this._registryName]?.delete(this);
    this._core.status("rendering_observer_active", this._id, 0);
    this._core.renderingObserversById.delete(this._id);
  }
  _requireTarget(target) {
    if (!target || target.nodeType !== 1) {
      throw new TypeError("Observer target must be an Element");
    }
    return target;
  }
  _register(target, state) {
    releaseGeometryState(this._targets.get(target), this._core);
    state.geometryHandle = this._core.status("geometry_observer_create", this._ownerHandle);
    geometryStateFinalizer.register(state, { core: this._core, handle: state.geometryHandle }, state);
    this._targets.set(target, state);
    this._document[this._registryName] ??= new Set();
    this._document[this._registryName].add(this);
    this._core.status("rendering_observer_active", this._id, 1);
    this._core.renderingObserversById.set(this._id, this);
    this._document._componentRenderSurface?._scheduleObserverFrame();
  }
}


class ResizeObserverRuntime extends RenderingObserver {
  constructor(document, callback) {
    super(document, callback, "_resizeObservers");
  }
  _transportObserve(target, box) {
    this._register(target, { box, signature: null });
  }
  _gather(serialized, boxes, viewport, minimumDepth) {
    const entries = [];
    let shallowestDepth = Infinity;
    let skipped = false;
    const geometry = observerLayout(serialized, boxes, viewport);
    try {
      for (const [target, state] of this._targets) {
        const index = serialized.indexOf.get(target);
        if (index === undefined || !boxes[index]) continue;
        const outcome = this._core.status("geometry_resize", state.geometryHandle,
          geometry.handle, target._coreHandle,
          { "content-box": 0, "border-box": 1, "device-pixel-content-box": 2 }[state.box],
          minimumDepth);
        if (outcome === 0) continue;
        if (outcome === 2) { skipped = true; continue; }
        const values = outputNumbers(this._core, 10);
        shallowestDepth = Math.min(shallowestDepth,
          this._core.status("geometry_observer_depth", state.geometryHandle));
        entries.push(Object.freeze({ target, contentRect: rectangle(...values.slice(0, 4)),
          borderBoxSize: logicalSize(values[4], values[5]),
          contentBoxSize: logicalSize(values[6], values[7]),
          devicePixelContentBoxSize: logicalSize(values[8], values[9]) }));
      }
      return { entries, shallowestDepth, skipped };
    } finally {
      geometry.release();
    }
  }
}

function normalizeResizeOptions(options) {
  const box = options.box ?? "content-box";
  if (
    !["content-box", "border-box", "device-pixel-content-box"].includes(box)
  ) {
    throw new TypeError(`Unsupported ResizeObserver box "${box}"`);
  }
  return box;
}

export const DocumentResizeObserver = createResizeObserverClass({
  Base: ResizeObserverRuntime,
  normalizeResizeOptions,
});

class IntersectionObserverRuntime extends RenderingObserver {
  constructor(document, callback, options) {
    super(document, callback, "_intersectionObservers");
    this.root = options.root ?? null;
    const margin = parseRootMargin(this._core, options.rootMargin);
    this._rootMargins = margin.parsed;
    this.rootMargin = margin.cssText;
    this.thresholds = Object.freeze(normalizeThresholds(this._core, options.threshold));
  }
  _transportObserve(target) {
    this._register(target, { thresholdIndex: null, isIntersecting: null });
  }
  _transportTakeRecords() {
    return [];
  }
  _gather(serialized, boxes, viewport, time) {
    const entries = [];
    const geometry = observerLayout(serialized, boxes, viewport);
    try {
      for (const [target, state] of this._targets) {
        const index = serialized.indexOf.get(target);
        if (index === undefined || !boxes[index]) continue;
        const bytes = new Uint8Array(64 + this.thresholds.length * 8);
        const view = new DataView(bytes.buffer);
        this._rootMargins.forEach((margin, index) => {
          view.setFloat64(index * 16, margin.value, true);
          view.setUint32(index * 16 + 8, margin.unit === "%" ? 1 : 0, true);
        });
        this.thresholds.forEach((threshold, index) => view.setFloat64(64 + index * 8, threshold, true));
        const pointer = this._core.status("abi_allocate", bytes.byteLength);
        this._core.refreshBytes().set(bytes, pointer);
        if (!this._core.status("geometry_intersection", state.geometryHandle,
          geometry.handle, target._coreHandle, this.root?._coreHandle ?? 0n,
          pointer, pointer + 64, this.thresholds.length)) continue;
        const values = outputNumbers(this._core, 13);
        const resultView = new DataView(this._core.memory.buffer, this._core.exports.abi_output_pointer(), 112);
        const isIntersecting = Boolean(resultView.getUint32(104, true));
        entries.push(Object.freeze({ time, target,
          rootBounds: rectangle(...values.slice(0, 4)),
          boundingClientRect: rectangle(...values.slice(4, 8)),
          intersectionRect: rectangle(...values.slice(8, 12)),
          intersectionRatio: values[12], isIntersecting }));
      }
      return entries;
    } finally {
      geometry.release();
    }
  }
}

export const DocumentIntersectionObserver = createIntersectionObserverClass({
  Base: IntersectionObserverRuntime,
});

export function deliverRenderingObservers(
  document,
  serialized,
  boxes,
  viewport,
  time,
  minimumResizeDepth = 0,
) {
  let delivered = 0;
  let shallowestResizeDepth = Infinity;
  let skippedResize = false;
  if (!document) return { delivered, shallowestResizeDepth, skippedResize };
  const core = document._domCore;
  const owner = document._coreHandle;
  const checkpoint = core.status("rendering_checkpoint_begin", owner);
  let token = 0n;
  try {
    for (;;) {
      const id = core.status("rendering_checkpoint_next", checkpoint, owner);
      if (!id) break;
      token = core.status("rendering_checkpoint_token", checkpoint, owner);
      const observer = core.renderingObserversById.get(id);
      let outcome = 0;
      try {
        if (observer) {
          let entries;
          if (observer instanceof DocumentResizeObserver) {
            const result = observer._gather(
              serialized,
              boxes,
              viewport,
              minimumResizeDepth,
            );
            entries = result.entries;
            shallowestResizeDepth = Math.min(
              shallowestResizeDepth,
              result.shallowestDepth,
            );
            skippedResize ||= result.skipped;
          } else {
            entries = observer._gather(serialized, boxes, viewport, time);
          }
          if (entries.length) {
            enterComponentCode(observer._document, observer._callback, observer, [entries, observer]);
          }
          delivered += entries.length;
        }
      } catch (error) {
        outcome = 1;
        throw error;
      } finally {
        core.status(
          "rendering_checkpoint_resume",
          checkpoint,
          owner,
          token,
          outcome,
        );
        token = 0n;
      }
    }
  } finally {
    core.status("rendering_checkpoint_abort", checkpoint, owner, token);
  }
  return { delivered, shallowestResizeDepth, skippedResize };
}
export function documentHasRenderingObservers(document) {
  return Boolean(
    document?._resizeObservers?.size || document?._intersectionObservers?.size,
  );
}
