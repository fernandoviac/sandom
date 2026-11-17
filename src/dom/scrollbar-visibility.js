// Overlay scrollbar visibility (design/scrollbars.md, decision 2).
//
// An overlay bar is hidden while its scroller is at rest. A scroll position
// change shows the thumb at once; a pointer in the region of a shown bar
// widens the thumb and fades the track in, and a pointer that enters a
// hidden bar leaves it hidden. After an idle delay the thumb and the track fade
// out together. Every time is a frame time of the surface's own clock: the
// state changes only in a render, so a still capture renders the state at its
// own time, and a document at rest renders no bar.
//
// The timings are Chromium's macOS overlay animator
// (ui/native_theme/scrollbar_animator_mac.h, OverlayScrollbarAnimatorMac):
// kFadeOutDelay 500 ms, and kAnimationDuration 250 ms for the fade-out, the
// track fade-in and the thumb expansion, each eased with EASE_IN_OUT
// (ui/native_theme/scrollbar_animator_mac.cc, ScrollbarAnimationTimerMac).
// Chromium's MouseDidEnter likewise ignores a pointer that enters a hidden
// bar.
import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The timings that scrollbar-visibility.watpart applies.
export const OVERLAY_SCROLLBAR_FADE_DELAY_MILLISECONDS = 500;
export const OVERLAY_SCROLLBAR_ANIMATION_MILLISECONDS = 250;
export const SCROLLBAR_STYLES = Object.freeze(["overlay", "classic"]);

const ORIENTATIONS = new Map([
  ["horizontal", layoutConstant("SCROLL_BAR_HORIZONTAL")],
  ["vertical", layoutConstant("SCROLL_BAR_VERTICAL")],
]);
const VALUE_THUMB = layoutConstant("SCROLL_BAR_VALUE_THUMB");
const VALUE_TRACK = layoutConstant("SCROLL_BAR_VALUE_TRACK");
const VALUE_EXPANSION = layoutConstant("SCROLL_BAR_VALUE_EXPANSION");
// `pointer` is "pressed" while a pointer drags the bar's thumb, "hover" while
// the pointer is in the bar, or null; the painted thumb colour follows it
// (src/dom/scrollbar-paint.js).
const POINTERS = new Map([
  [layoutConstant("SCROLL_BAR_POINTER_NONE"), null],
  [layoutConstant("SCROLL_BAR_POINTER_HOVER"), "hover"],
  [layoutConstant("SCROLL_BAR_POINTER_PRESSED"), "pressed"],
]);
export function assertScrollbarStyle(value, owner) {
  if (!SCROLLBAR_STYLES.includes(value)) {
    throw new RangeError(
      `${owner}: scrollbarStyle must be "overlay" or "classic", got ${JSON.stringify(value)}; pass one of those values or omit the option for "overlay"`,
    );
  }
  return value;
}

// The keywords of a sampled bar's state codes.
const STATES = new Map(["HIDDEN", "FADING", "SHOWN"]
  .map((name) => [layoutConstant(`SCROLL_BAR_${name}`), name.toLowerCase()]));

// The overlay bar records of one render surface live in the core's bar set
// (scroll_bars_*, core/dom/scrollbar-visibility.watpart): the fade and
// expansion timings, each bar's last scroll value, its painted visibility
// and the hovered and pressed bars. A bar is named by its scroller's node
// handle (0 for the viewport) and its orientation.
export class ScrollbarVisibility {
  constructor(style = "overlay") {
    this.style = assertScrollbarStyle(style, "ScrollbarVisibility");
    this._set = sharedDomCore.status("scroll_bars_create", this.style === "classic" ? 1 : 0);
  }

  release() {
    sharedDomCore.status("scroll_bars_release", this._set);
    this._set = 0;
  }

  // Input dispatch reports the scrollbar under the pointer (a descriptor or
  // null) and, when a pointer went down or up, the bar whose thumb it pressed
  // (null on release; undefined keeps the pressed bar). Returns true when a
  // bar needs a frame for it.
  notePointer(scrollbar, pressed = undefined) {
    return sharedDomCore.status("scroll_bars_note_pointer", this._set,
      scrollbar ? 1 : 0, barElement(scrollbar), barOrientation(scrollbar),
      pressed === undefined ? 0 : 1, pressed ? 1 : 0, barElement(pressed), barOrientation(pressed)) === 1;
  }

  // Advances every presented bar to this frame and returns one visibility
  // record per descriptor, in order.
  advance(scrollbars, timeMilliseconds) {
    const core = sharedDomCore;
    core.status("scroll_bars_advance_begin", this._set);
    const records = scrollbars.map((scrollbar) => visibilityRecord(this._set, scrollbar,
      core.status("scroll_bars_step", this._set, barElement(scrollbar), barOrientation(scrollbar), scrollbar.value, timeMilliseconds)));
    core.status("scroll_bars_advance_end", this._set);
    return records;
  }

  // The visibility each descriptor would have at this time, without
  // advancing.
  sample(scrollbars, timeMilliseconds) {
    return scrollbars.map((scrollbar) => visibilityRecord(this._set, scrollbar,
      sharedDomCore.status("scroll_bars_sample", this._set, barElement(scrollbar), barOrientation(scrollbar), timeMilliseconds)));
  }

  // True while a later frame can change a bar without input.
  get active() {
    return sharedDomCore.status("scroll_bars_active", this._set) === 1;
  }

  // True when a frame at this time paints a presented bar differently.
  due(timeMilliseconds) {
    return sharedDomCore.status("scroll_bars_due", this._set, timeMilliseconds) === 1;
  }
}

function barElement(scrollbar) {
  return scrollbar?.element?._coreHandle ?? 0n;
}

function barOrientation(scrollbar) {
  return scrollbar ? ORIENTATIONS.get(scrollbar.orientation) : 0;
}

function visibilityRecord(set, scrollbar, state) {
  const core = sharedDomCore;
  return {
    state: STATES.get(state),
    thumbAlpha: core.exports.scroll_bar_value(VALUE_THUMB),
    trackAlpha: core.exports.scroll_bar_value(VALUE_TRACK),
    expansion: core.exports.scroll_bar_value(VALUE_EXPANSION),
    pointer: POINTERS.get(core.status("scroll_bars_pointer", set, barElement(scrollbar), barOrientation(scrollbar))),
  };
}
