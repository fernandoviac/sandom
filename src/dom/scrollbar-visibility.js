// Overlay scrollbar visibility (design/scrollbars.md, decision 2).
//
// An overlay bar is hidden while its scroller is at rest. A scroll position
// change shows the thumb at once; a pointer in the bar's region shows it too
// and fades the track in. After an idle delay the thumb and the track fade
// out together. Every time is a frame time of the surface's own clock: the
// state changes only in a render, so a still capture renders the state at its
// own time, and a document at rest renders no bar.
//
// The timings are Chromium's macOS overlay animator
// (ui/native_theme/scrollbar_animator_mac.h, OverlayScrollbarAnimatorMac):
// kFadeOutDelay 500 ms, and kAnimationDuration 250 ms for the fade-out, the
// track fade-in and the thumb expansion, each eased with EASE_IN_OUT
// (ui/native_theme/scrollbar_animator_mac.cc, ScrollbarAnimationTimerMac).
// Chromium ignores a pointer that enters a hidden bar; Sandom shows the bar,
// as the plan's objective requires.
export const OVERLAY_SCROLLBAR_FADE_DELAY_MILLISECONDS = 500;
export const OVERLAY_SCROLLBAR_ANIMATION_MILLISECONDS = 250;
export const SCROLLBAR_STYLES = Object.freeze(["overlay", "classic"]);

// `pointer` is "pressed" while a pointer drags the bar's thumb, "hover" while
// the pointer is in the bar, or null; the painted thumb colour follows it
// (src/dom/scrollbar-paint.js).
const HIDDEN = Object.freeze({ state: "hidden", thumbAlpha: 0, trackAlpha: 0, expansion: 0, pointer: null });
const CLASSIC = Object.freeze({
  null: Object.freeze({ state: "shown", thumbAlpha: 1, trackAlpha: 1, expansion: 0, pointer: null }),
  hover: Object.freeze({ state: "shown", thumbAlpha: 1, trackAlpha: 1, expansion: 0, pointer: "hover" }),
  pressed: Object.freeze({ state: "shown", thumbAlpha: 1, trackAlpha: 1, expansion: 0, pointer: "pressed" }),
});

const sameBar = (a, b) => (a?.element ?? null) === (b?.element ?? null) && (a?.orientation ?? null) === (b?.orientation ?? null);
const barKey = (bar) => bar ? { element: bar.element, orientation: bar.orientation } : null;

export function assertScrollbarStyle(value, owner) {
  if (!SCROLLBAR_STYLES.includes(value)) {
    throw new RangeError(
      `${owner}: scrollbarStyle must be "overlay" or "classic", got ${JSON.stringify(value)}; pass one of those values or omit the option for "overlay"`,
    );
  }
  return value;
}

// CSS ease-in-out, cubic-bezier(0.42, 0, 0.58, 1), the EASE_IN_OUT preset of
// gfx::CubicBezierTimingFunction. x(s) is solved by bisection; y(s) is
// 3s^2 - 2s^3 because y1 = 0 and y2 = 1.
function easeInOut(progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const curveX = (s) => (((1 - 3 * 0.58 + 3 * 0.42) * s + (3 * 0.58 - 6 * 0.42)) * s + 3 * 0.42) * s;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (curveX(middle) < progress) low = middle;
    else high = middle;
  }
  const s = (low + high) / 2;
  return s * s * (3 - 2 * s);
}

// Eased progress of an animation that starts at `start`: -Infinity is a
// complete animation, null one that has not started.
const ramp = (start, timeMilliseconds) =>
  start === null ? 0 : easeInOut((timeMilliseconds - start) / OVERLAY_SCROLLBAR_ANIMATION_MILLISECONDS);

const stateOf = (thumbAlpha) => thumbAlpha === 0 ? "hidden" : thumbAlpha < 1 ? "fading" : "shown";

// One bar: `idleSince` starts the fade-out delay, which does not run while
// the pointer is in the bar; `trackSince` and `expandSince` start the track
// fade-in and the thumb expansion.
function sample(bar, timeMilliseconds) {
  if (!bar) return HIDDEN;
  const fadeStart = bar.idleSince + OVERLAY_SCROLLBAR_FADE_DELAY_MILLISECONDS;
  if (bar.hovered || timeMilliseconds < fadeStart) {
    return {
      state: "shown",
      thumbAlpha: 1,
      trackAlpha: ramp(bar.trackSince, timeMilliseconds),
      expansion: ramp(bar.expandSince, timeMilliseconds),
      pointer: null,
    };
  }
  const fade = ramp(fadeStart, timeMilliseconds);
  if (fade >= 1) return HIDDEN;
  // The fade-out stops the track fade-in and the expansion where they are;
  // a track that had started to show fades out from full, as in Chromium.
  const thumbAlpha = 1 - fade;
  return {
    state: stateOf(thumbAlpha),
    thumbAlpha,
    trackAlpha: ramp(bar.trackSince, fadeStart) > 0 ? thumbAlpha : 0,
    expansion: ramp(bar.expandSince, fadeStart),
    pointer: null,
  };
}

export class ScrollbarVisibility {
  constructor(style = "overlay") {
    this.style = assertScrollbarStyle(style, "ScrollbarVisibility");
    // element -> { horizontal, vertical } bar records.
    this._bars = new Map();
    // The bar under the pointer and the bar whose thumb a pointer drags, as
    // { element, orientation }, or null.
    this._pointer = null;
    this._pressed = null;
    this._pointerChanged = false;
  }

  // Input dispatch reports the scrollbar under the pointer (a descriptor or
  // null) and, when a pointer went down or up, the bar whose thumb it pressed
  // (null on release; undefined keeps the pressed bar). Returns true when a
  // bar needs a frame for it: an overlay bar shows, a thumb changes colour.
  // The state itself changes in the next render, at that frame's time.
  notePointer(scrollbar, pressed = undefined) {
    let changed = false;
    if (!sameBar(this._pointer, scrollbar)) {
      this._pointer = barKey(scrollbar);
      changed = true;
    }
    if (pressed !== undefined && !sameBar(this._pressed, pressed)) {
      this._pressed = barKey(pressed);
      changed = true;
    }
    if (changed) this._pointerChanged = true;
    return changed;
  }

  _pointerOf(scrollbar) {
    if (this._pressed && sameBar(this._pressed, scrollbar)) return "pressed";
    if (this._pointer && sameBar(this._pointer, scrollbar)) return "hover";
    return null;
  }

  // A shown record with the bar's pointer state.
  _withPointer(record, scrollbar) {
    if (record.state === "hidden") return record;
    const pointer = this._pointerOf(scrollbar);
    return pointer === record.pointer ? record : { ...record, pointer };
  }

  _bar(scrollbar) {
    return this._bars.get(scrollbar.element)?.[scrollbar.orientation] ?? null;
  }

  // Advances every bar to this frame and returns one visibility record per
  // descriptor, in order. `previous` is the presented frame's descriptor list:
  // a value that differs from it is a scroll.
  advance(scrollbars, previous, timeMilliseconds) {
    if (this.style === "classic") {
      this._pointerChanged = false;
      return scrollbars.map((scrollbar) => CLASSIC[this._pointerOf(scrollbar)]);
    }
    const previousValues = new Map();
    for (const scrollbar of previous) {
      previousValues.set(scrollbar.element, {
        ...previousValues.get(scrollbar.element),
        [scrollbar.orientation]: scrollbar.value,
      });
    }
    const bars = new Map();
    const result = scrollbars.map((scrollbar) => {
      const before = previousValues.get(scrollbar.element)?.[scrollbar.orientation];
      const scrolled = before !== undefined && before !== scrollbar.value;
      // A dragged thumb holds its bar as the pointer does.
      const hovered = this._pointerOf(scrollbar) !== null;
      const current = sample(this._bar(scrollbar), timeMilliseconds);
      let bar = current.state === "hidden" ? null : { ...this._bar(scrollbar) };
      if (bar === null) {
        if (!scrolled && !hovered) return HIDDEN;
        bar = { idleSince: timeMilliseconds, hovered: false, trackSince: null, expandSince: null };
        // A scroll under the pointer shows the track and the wide thumb at
        // once (OverlayScrollbarAnimatorMac::DidScroll).
        if (scrolled && hovered) {
          bar.trackSince = -Infinity;
          bar.expandSince = -Infinity;
        }
      }
      const entering = hovered && !bar.hovered;
      // A scroll or an entering pointer cancels a running fade-out: the
      // thumb is whole again, and so is a track that had started to show.
      if (current.state === "fading" && (scrolled || entering)) {
        bar.trackSince = current.trackAlpha > 0 ? -Infinity : null;
        bar.expandSince = current.expansion > 0 ? -Infinity : null;
        bar.idleSince = timeMilliseconds;
      }
      if (scrolled) bar.idleSince = timeMilliseconds;
      if (entering) {
        if (ramp(bar.trackSince, timeMilliseconds) < 1) bar.trackSince = timeMilliseconds;
        if (ramp(bar.expandSince, timeMilliseconds) < 1) bar.expandSince = timeMilliseconds;
      }
      if (bar.hovered && !hovered) bar.idleSince = timeMilliseconds;
      bar.hovered = hovered;
      // A finished animation is complete for every later time.
      if (ramp(bar.trackSince, timeMilliseconds) === 1) bar.trackSince = -Infinity;
      if (ramp(bar.expandSince, timeMilliseconds) === 1) bar.expandSince = -Infinity;
      bars.set(scrollbar.element, { ...bars.get(scrollbar.element), [scrollbar.orientation]: bar });
      return this._withPointer(sample(bar, timeMilliseconds), scrollbar);
    });
    this._bars = bars;
    this._pointerChanged = false;
    return result;
  }

  // The visibility each descriptor would have at this time, without
  // advancing: the scheduler compares it with the painted visibility.
  sample(scrollbars, timeMilliseconds) {
    if (this.style === "classic") return scrollbars.map((scrollbar) => CLASSIC[this._pointerOf(scrollbar)]);
    return scrollbars.map((scrollbar) => this._withPointer(sample(this._bar(scrollbar), timeMilliseconds), scrollbar));
  }

  // True while a later frame can change a bar without input: a pointer change
  // waits for its frame, or a bar is shown and not held by the pointer, or
  // its track or thumb still animates.
  get active() {
    if (this.style === "classic") return this._pointerChanged;
    if (this._pointerChanged) return true;
    for (const bars of this._bars.values()) {
      for (const bar of Object.values(bars)) {
        if (!bar.hovered || bar.trackSince !== -Infinity || bar.expandSince !== -Infinity) return true;
      }
    }
    return false;
  }

  // True when a frame at this time paints a bar differently from the
  // presented descriptors, each of which carries its painted visibility.
  due(presented, timeMilliseconds) {
    if (this.style === "classic") return this._pointerChanged;
    return this._pointerChanged || !sameScrollbarVisibility(
      this.sample(presented, timeMilliseconds),
      presented.map((scrollbar) => scrollbar.visibility ?? HIDDEN),
    );
  }
}

export function sameScrollbarVisibility(a, b) {
  return a.length === b.length && a.every((entry, index) =>
    entry.state === b[index].state && entry.thumbAlpha === b[index].thumbAlpha &&
    entry.trackAlpha === b[index].trackAlpha && entry.expansion === b[index].expansion &&
    (entry.pointer ?? null) === (b[index].pointer ?? null)
  );
}
