import { buildGeometry } from "./geometry.js";
import {
  createIntersectionObserverClass,
  createResizeObserverClass,
} from "./dom-bindings.generated.js";
import { enterComponentCode } from "./component-code.js";
import { layoutConstant } from "../wasm/layout-table.js";

const OBSERVER_RESIZE = layoutConstant("OBSERVER_RESIZE");
const OBSERVER_INTERSECTION = layoutConstant("OBSERVER_INTERSECTION");
const RESIZE_UNCHANGED = layoutConstant("RESIZE_UNCHANGED");
const RESIZE_SKIPPED = layoutConstant("RESIZE_SKIPPED");
// The ResizeObserverBoxOptions values by their WAT codes.
const RESIZE_BOXES = Object.freeze({
  "content-box": layoutConstant("RESIZE_BOX_CONTENT"),
  "border-box": layoutConstant("RESIZE_BOX_BORDER"),
  "device-pixel-content-box": layoutConstant("RESIZE_BOX_DEVICE_PIXEL_CONTENT"),
});
const geometryStateFinalizer = new FinalizationRegistry(({ core, handle }) => {
  core.exports.geometry_observer_release(handle);
});

function releaseGeometryState(state, core) {
  if (!state?.geometryHandle) return;
  core.status("geometry_observer_release", state.geometryHandle);
  geometryStateFinalizer.unregister(state);
  state.geometryHandle = 0n;
}

// The geometry of a delivery checkpoint, built once and read by every
// observer: each observer reads the checkpoint's frozen layout across
// callback mutations, not a fresh live query or the preceding published
// frame. The caller owns it and releases it.
export function observerLayout(serialized, boxes, viewport) {
  return buildGeometry({ root: serialized.root, boxes, publication: serialized.publication,
    sourceRevisions: serialized.sourceRevisions,
    viewportIndex: serialized.viewportIndex, viewport, presented: true });
}

// The margin, threshold and intersection records of
// geometry-observer-options.watpart and geometry-observers.watpart, by WAT
// name without the GEOMETRY_ prefix.
const OBSERVER = Object.freeze(Object.fromEntries([
  "MARGIN_SIZE", "MARGIN_VALUE", "MARGIN_PERCENT", "MARGINS_SIZE", "THRESHOLD_SIZE", "THRESHOLD_VALUE",
  "THRESHOLD_PRESENT", "INTERSECTION_SIZE", "INTERSECTION_VALUES", "INTERSECTION_VALUE_COUNT",
  "INTERSECTION_INTERSECTING",
].map((name) => [name, layoutConstant(`GEOMETRY_${name}`)])));
const F64 = Float64Array.BYTES_PER_ELEMENT;

// The first $count f64 values of the core's output.
function outputNumbers(core, count) {
  const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), core.exports.abi_output_length());
  return Array.from({ length: count }, (_, index) => view.getFloat64(index * F64, true));
}

// A margin record ({ value, unit }) at `at` of `view`.
function writeMargin(view, at, margin) {
  view.setFloat64(at + OBSERVER.MARGIN_VALUE, margin.value, true);
  view.setUint32(at + OBSERVER.MARGIN_PERCENT, margin.unit === "%" ? 1 : 0, true);
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
  const pointer = core.status("abi_allocate", normalized.length * OBSERVER.THRESHOLD_SIZE);
  const view = new DataView(core.memory.buffer);
  for (let index = 0; index < normalized.length; index++) {
    const at = pointer + index * OBSERVER.THRESHOLD_SIZE;
    view.setFloat64(at + OBSERVER.THRESHOLD_VALUE, normalized[index] ?? 0, true);
    view.setUint32(at + OBSERVER.THRESHOLD_PRESENT, index in normalized ? 1 : 0, true);
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
    value: view.getFloat64(index * OBSERVER.MARGIN_SIZE + OBSERVER.MARGIN_VALUE, true),
    unit: view.getUint32(index * OBSERVER.MARGIN_SIZE + OBSERVER.MARGIN_PERCENT, true) ? "%" : "px",
  })), cssText: core.decoder.decode(bytes.subarray(pointer + OBSERVER.MARGINS_SIZE, pointer + length)) };
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
      registryName === "_resizeObservers" ? OBSERVER_RESIZE : OBSERVER_INTERSECTION,
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
    // The document's registry keeps the observer alive; the core's lookup
    // is weak, so it never keeps the document.
    this._core.renderingObserversById.set(this._id, new WeakRef(this));
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
  _gather(serialized, boxes, geometry, minimumDepth) {
    const entries = [];
    let shallowestDepth = Infinity;
    let skipped = false;
    for (const [target, state] of this._targets) {
      const index = serialized.indexOf.get(target);
      if (index === undefined || !boxes[index]) continue;
      const outcome = this._core.status("geometry_resize", state.geometryHandle,
        geometry.handle, target._coreHandle,
        RESIZE_BOXES[state.box],
        minimumDepth);
      if (outcome === RESIZE_UNCHANGED) continue;
      if (outcome === RESIZE_SKIPPED) { skipped = true; continue; }
      const values = outputNumbers(this._core, 10);
      shallowestDepth = Math.min(shallowestDepth,
        this._core.status("geometry_observer_depth", state.geometryHandle));
      entries.push(Object.freeze({ target, contentRect: rectangle(...values.slice(0, 4)),
        borderBoxSize: logicalSize(values[4], values[5]),
        contentBoxSize: logicalSize(values[6], values[7]),
        devicePixelContentBoxSize: logicalSize(values[8], values[9]) }));
    }
    return { entries, shallowestDepth, skipped };
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
  _gather(serialized, boxes, geometry, time) {
    const entries = [];
    for (const [target, state] of this._targets) {
      const index = serialized.indexOf.get(target);
      if (index === undefined || !boxes[index]) continue;
      const bytes = new Uint8Array(OBSERVER.MARGINS_SIZE + this.thresholds.length * F64);
      const view = new DataView(bytes.buffer);
      this._rootMargins.forEach((margin, index) => writeMargin(view, index * OBSERVER.MARGIN_SIZE, margin));
      this.thresholds.forEach((threshold, index) => view.setFloat64(OBSERVER.MARGINS_SIZE + index * F64, threshold, true));
      const pointer = this._core.status("abi_allocate", bytes.byteLength);
      this._core.refreshBytes().set(bytes, pointer);
      if (!this._core.status("geometry_intersection", state.geometryHandle,
        geometry.handle, target._coreHandle, this.root?._coreHandle ?? 0n,
        pointer, pointer + OBSERVER.MARGINS_SIZE, this.thresholds.length)) continue;
      const values = outputNumbers(this._core, OBSERVER.INTERSECTION_VALUE_COUNT);
      const resultView = new DataView(this._core.memory.buffer, this._core.exports.abi_output_pointer(), OBSERVER.INTERSECTION_SIZE);
      const isIntersecting = Boolean(resultView.getUint32(OBSERVER.INTERSECTION_INTERSECTING, true));
      entries.push(Object.freeze({ time, target,
        rootBounds: rectangle(...values.slice(0, 4)),
        boundingClientRect: rectangle(...values.slice(4, 8)),
        intersectionRect: rectangle(...values.slice(8, 12)),
        intersectionRatio: values[12], isIntersecting }));
    }
    return entries;
  }
}

export const DocumentIntersectionObserver = createIntersectionObserverClass({
  Base: IntersectionObserverRuntime,
});

// `layout()` answers the checkpoint's geometry (observerLayout of
// `boxes`), which the caller owns: the frame reads it again for its
// scrollbars when it presents these boxes.
export function deliverRenderingObservers(
  document,
  serialized,
  boxes,
  time,
  minimumResizeDepth,
  layout,
) {
  let delivered = 0;
  let shallowestResizeDepth = Infinity;
  let skippedResize = false;
  if (!document) return { delivered, shallowestResizeDepth, skippedResize };
  const core = document._domCore;
  const owner = document._coreHandle;
  const checkpoint = core.status("rendering_checkpoint_begin", owner);
  let token = 0n;
  // Asked for before the first observer's callback runs.
  let geometry = null;
  try {
    for (;;) {
      const id = core.status("rendering_checkpoint_next", checkpoint, owner);
      if (!id) break;
      token = core.status("rendering_checkpoint_token", checkpoint, owner);
      const observer = core.renderingObserversById.get(id)?.deref();
      let outcome = 0;
      try {
        if (observer) {
          geometry ??= layout();
          let entries;
          if (observer instanceof DocumentResizeObserver) {
            const result = observer._gather(
              serialized,
              boxes,
              geometry,
              minimumResizeDepth,
            );
            entries = result.entries;
            shallowestResizeDepth = Math.min(
              shallowestResizeDepth,
              result.shallowestDepth,
            );
            skippedResize ||= result.skipped;
          } else {
            entries = observer._gather(serialized, boxes, geometry, time);
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
