import {
  addEventListener as addSandomEventListener,
  dispatchEventFromScript,
  removeEventListener as removeSandomEventListener,
} from './events.js';
import { scrollRead, scrollStore } from "./scroll-core.js";
import { sharedDomCore } from "../dom-wasm/core.js";
import { installViewportScrollBindings } from "./dom-bindings.generated.js";
import { layoutConstant } from "../wasm/layout-table.js";

const SCROLL_REQUESTED_LEFT = layoutConstant("SCROLL_REQUESTED_LEFT");
const SCROLL_REQUESTED_TOP = layoutConstant("SCROLL_REQUESTED_TOP");
const SCROLL_ACCEPTED_LEFT = layoutConstant("SCROLL_ACCEPTED_LEFT");
const SCROLL_ACCEPTED_TOP = layoutConstant("SCROLL_ACCEPTED_TOP");

// The behavior check and the finite coordinates are
// scroll_coordinates_behavior and scroll_coordinate.
export function normalizeScrollCoordinates(first, second, fallbackLeft, fallbackTop) {
  let left;
  let top;
  let behavior = 'auto';
  if (typeof first === 'object' && first !== null) {
    left = first.left;
    top = first.top;
    behavior = first.behavior ?? 'auto';
  } else {
    left = first;
    top = second;
  }
  sharedDomCore.statusRaw("scroll_coordinates_behavior", ...sharedDomCore.valueListInput([behavior, String(behavior)]));
  const numericLeft = left === undefined ? fallbackLeft : Number(left);
  const numericTop = top === undefined ? fallbackTop : Number(top);
  return {
    left: sharedDomCore.exports.scroll_coordinate(numericLeft),
    top: sharedDomCore.exports.scroll_coordinate(numericTop),
    behavior,
  };
}

// Language-only hooks used by the generated public scroll bindings. Capture
// method identity before value conversion and preserve ECMAScript + coercion.
export const scrollBindingRuntime = Object.freeze({
  normalizeScrollCoordinates,
  normalizeScrollProperty(value) {
    return sharedDomCore.exports.scroll_coordinate(Number(value));
  },
  addScrollDelta(base, delta) { return base + delta; },
  applyScrollPosition(target, method, ...args) {
    return Reflect.apply(method, target, args);
  },
  viewportScrollRequest(target, left, top, source, behavior) {
    target._surface?._requestViewportScroll(left, top, source, behavior);
    if (!target._surface) target._setRequested(left, top);
  },
});

// The viewport of a render surface. `deviceScale` is the raster scale: the
// texture pixels of one CSS pixel. `density` is the device pixel ratio the
// document sees, which snaps its line widths; without one it is the raster
// scale. A host that magnifies a document (a zoom) changes the raster
// scale and keeps the density, so the layout stays the same.
export class SandomViewport {
  constructor({ width = 1280, height = 720, deviceScale = 1, density = null } = {}) {
    if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
      throw new RangeError('Viewport width, height, and deviceScale must be positive');
    }
    if (density !== null && !(density > 0)) {
      throw new RangeError(`Viewport density must be positive or null: observed ${density}`);
    }
    this.width = Number(width);
    this.height = Number(height);
    this.deviceScale = Number(deviceScale);
    this._density = density === null ? null : Number(density);
    this._requestedLeft = 0;
    this._requestedTop = 0;
    this._effectiveLeft = 0;
    this._effectiveTop = 0;
    this._surface = null;
  }

  get density() { return this._density ?? this.deviceScale; }

  get _requestedLeft() { return scrollRead(this, SCROLL_REQUESTED_LEFT); }
  set _requestedLeft(value) { scrollStore(this, SCROLL_REQUESTED_LEFT, value); }
  get _requestedTop() { return scrollRead(this, SCROLL_REQUESTED_TOP); }
  set _requestedTop(value) { scrollStore(this, SCROLL_REQUESTED_TOP, value); }
  get _effectiveLeft() { return scrollRead(this, SCROLL_ACCEPTED_LEFT); }
  set _effectiveLeft(value) { scrollStore(this, SCROLL_ACCEPTED_LEFT, value); }
  get _effectiveTop() { return scrollRead(this, SCROLL_ACCEPTED_TOP); }
  set _effectiveTop(value) { scrollStore(this, SCROLL_ACCEPTED_TOP, value); }
  get parentNode() { return null; }
  get innerWidth() { return this.width; }
  get innerHeight() { return this.height; }

  // `density` null makes the density follow the raster scale.
  resizeTo(width, height, deviceScale = this.deviceScale, density = this._density) {
    if (!(width > 0) || !(height > 0) || !(deviceScale > 0)) {
      throw new RangeError('Viewport width, height, and deviceScale must be positive');
    }
    if (density !== null && !(density > 0)) {
      throw new RangeError(`Viewport density must be positive or null: observed ${density}`);
    }
    if (this.width === width && this.height === height && this.deviceScale === deviceScale &&
      this._density === density) return;
    const previous = {
      width: this.width,
      height: this.height,
      deviceScale: this.deviceScale,
      density: this.density,
    };
    this.width = Number(width);
    this.height = Number(height);
    this.deviceScale = Number(deviceScale);
    this._density = density === null ? null : Number(density);
    this._surface?._recordViewportResize(previous);
  }

  addEventListener(type, callback, options) { addSandomEventListener(this, type, callback, options); }
  removeEventListener(type, callback, options) { removeSandomEventListener(this, type, callback, options); }
  dispatchEvent(event) { return dispatchEventFromScript(this, event); }

  _setRequested(left, top) {
    this._requestedLeft = left;
    this._requestedTop = top;
    if (!this._surface) this._setEffective(left, top);
  }

  _setEffective(left, top) {
    this._effectiveLeft = left;
    this._effectiveTop = top;
  }
}

installViewportScrollBindings(scrollBindingRuntime, SandomViewport.prototype);
