// One clock per document (docs/design/component-rendering.md, "Page clock").
//
// A document clock is a source, `now()`, `requestFrame(callback)` and
// `cancelFrame(request)`, the same triple as a render surface, and a time
// origin. Every time value that the document's page observes comes from it:
// `performance.now()`, `performance.timeOrigin`, `Date` (for an injected
// clock), `Event.timeStamp`, timer due times, animation frame times and
// `document.timeline` (src/dom/page-clock.js).
//
// The host injects the clock when it creates the document (`now`,
// `requestFrame`, `cancelFrame`, `timeOrigin`), or the document takes the
// host's real clock, the one documented default. A document without a
// clock of its host fixes one when its page begins (`fixDocumentClock`):
// the clock of the surface that drives it then, else the real clock. Once
// fixed, a document's clock does not change.
//
// The document's time never decreases (High Resolution Time, §2.1
// "Clocks", the monotonic clock). A frame or a capture sample at time t
// holds it at t or later until the source passes t; a source that goes back
// is a defect of the host and throws.
import { hostClearTimeout, hostNow, hostSetTimeout, hostTimeOrigin } from "../host-clock.js";

// Without a host requestAnimationFrame (Deno), the live loop paces itself
// as a 60 Hz display does: a frame runs at the next frame boundary of the
// clock `now`, and the boundary is the frame's time. A timer can fire just
// before its boundary; it then waits out the rest, so that the next request
// computes the following boundary and no interval gets two frames.
const HOST_FRAME_INTERVAL_MILLISECONDS = 1000 / 60;
export function createDisplayFrameSource({ now, setTimer, clearTimer }) {
  return {
    requestFrame(callback) {
      const boundary = (Math.floor(now() / HOST_FRAME_INTERVAL_MILLISECONDS) + 1) *
        HOST_FRAME_INTERVAL_MILLISECONDS;
      const request = { timer: 0 };
      const wait = () => {
        const remaining = boundary - now();
        if (remaining > 0) request.timer = setTimer(wait, remaining);
        else callback(boundary);
      };
      wait();
      return request;
    },
    cancelFrame(request) {
      clearTimer(request.timer);
    },
  };
}

// The host's real clock and its frames: the default of documents and
// surfaces. The host's own timers and animation frames, taken before any
// page window can replace them on a shared global object.
const hostDisplayFrameSource = createDisplayFrameSource({
  now: hostNow,
  setTimer: hostSetTimeout,
  clearTimer: hostClearTimeout,
});
export const realClockSource = Object.freeze({
  now: hostNow,
  requestFrame: typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : hostDisplayFrameSource.requestFrame,
  cancelFrame: typeof globalThis.cancelAnimationFrame === "function"
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : hostDisplayFrameSource.cancelFrame,
});

// `now` and `requestFrame` are one clock: the time a frame callback
// receives and the time that everything else reads. A caller that drives
// frames supplies both; the host's real clock and its animation frames
// come only together, as the defaults. `timeOrigin` declares the epoch of
// a caller's clock, so it comes only with `now`.
export function assertClockOptions(options, label) {
  if ((options.now === undefined) !== (options.requestFrame === undefined)) {
    throw new TypeError(
      options.now === undefined
        ? `${label}: requestFrame requires now, the clock its frames run on; supply now as well or omit both for the host's real clock`
        : `${label}: now requires requestFrame, the frame source on that clock; supply requestFrame as well or omit both for the host's real clock`,
    );
  }
  if (options.timeOrigin !== undefined && options.now === undefined) {
    throw new TypeError(
      `${label}: timeOrigin requires now; the host's real clock has the host's own time origin`,
    );
  }
}

export class DocumentClock {
  // `real` is true for the host's real clock: its timers arm host timers
  // and its page keeps the realm's own wall clock (`Date`).
  constructor({ now, requestFrame, cancelFrame, timeOrigin, real }) {
    if (typeof now !== "function" || typeof requestFrame !== "function") {
      throw new TypeError("A document clock needs now and requestFrame functions");
    }
    if (!Number.isFinite(timeOrigin)) {
      throw new RangeError(`A document clock's timeOrigin must be a finite number of milliseconds from the Unix epoch, not ${timeOrigin}`);
    }
    this.source = Object.freeze({ now, requestFrame, cancelFrame: cancelFrame ?? (() => {}) });
    this.timeOrigin = timeOrigin;
    this.real = real;
    this.lastSourceTime = -Infinity;
    this.held = -Infinity;
    this.lastFrameTime = null;
    this.lastTimelineTime = -Infinity;
  }

  // The document's time: milliseconds from the time origin.
  now() {
    const time = this.source.now();
    if (typeof time !== "number" || Number.isNaN(time)) {
      throw new TypeError(`The document clock's now() returned ${String(time)}, not a number of milliseconds`);
    }
    if (time < this.lastSourceTime) {
      throw new RangeError(
        `The document clock's now() went back from ${this.lastSourceTime} to ${time}; a document's clock never decreases (High Resolution Time, §2.1)`,
      );
    }
    this.lastSourceTime = time;
    return time > this.held ? time : this.held;
  }

  // A frame of the clock's source ran at `time`: the document's time is at
  // least `time` from now on.
  hold(time) {
    if (time > this.held) this.held = time;
  }

  // An animation frame or a capture sample of the surface that drives the
  // document ran at `time`: the document's time is held at `time`, and
  // `time` is the time of the document's latest animation frame.
  frame(time) {
    this.hold(time);
    if (this.lastFrameTime === null || time > this.lastFrameTime) this.lastFrameTime = time;
  }

  // The page's wall clock for an injected clock: the time origin plus the
  // document's time, in whole milliseconds, as an ECMAScript time value.
  epochNow() {
    return Math.floor(this.timeOrigin + this.now());
  }

  // `document.timeline.currentTime` (Web Animations, §4.3.1): the time of
  // the latest animation frame, or before the first one the document's
  // time; monotonically increasing.
  timelineTime() {
    const time = this.lastFrameTime ?? this.now();
    if (time > this.lastTimelineTime) this.lastTimelineTime = time;
    return this.lastTimelineTime;
  }

  requestFrame(callback) {
    return this.source.requestFrame(callback);
  }

  cancelFrame(request) {
    this.source.cancelFrame(request);
  }
}

// The document clock of the host's options, or null when the options name
// none (the document then fixes one when its page begins).
export function documentClockFromOptions(options, label) {
  assertClockOptions(options, label);
  if (options.now === undefined) return null;
  return new DocumentClock({
    now: options.now,
    requestFrame: options.requestFrame,
    cancelFrame: options.cancelFrame,
    timeOrigin: options.timeOrigin ?? 0,
    real: false,
  });
}

export function realDocumentClock() {
  return new DocumentClock({ ...realClockSource, timeOrigin: hostTimeOrigin, real: true });
}

// The document's clock, fixed now if its host gave it none: the clock of
// the live surfaces over the document, else the host's real clock.
export function fixDocumentClock(document) {
  if (document._clock) return document._clock;
  const surfaces = [...(document._liveRenderSurfaces ?? [])].filter((surface) => !surface._shutdown);
  const first = surfaces[0];
  if (first !== undefined && surfaces.some((surface) => surface._now !== first._now)) {
    throw new Error(
      `The page of ${document.URL} begins while the surfaces over its document run on different clocks; give the document its clock when you create it (now, requestFrame, cancelFrame, timeOrigin)`,
    );
  }
  document._clock = first === undefined ? realDocumentClock() : first._clockForDocument();
  return document._clock;
}

// The default document timeline (Web Animations, §4.3.1.1 and §6.3): its
// origin time is zero, so its current time is on the document's clock. A
// document whose page has no clock has an inactive timeline.
class DocumentTimeline {
  #document;

  constructor(document) {
    this.#document = document;
  }

  get currentTime() {
    return this.#document._clock?.timelineTime() ?? null;
  }
}

const documentTimelines = new WeakMap();

export function documentTimeline(document) {
  let timeline = documentTimelines.get(document);
  if (timeline === undefined) {
    timeline = new DocumentTimeline(document);
    documentTimelines.set(document, timeline);
  }
  return timeline;
}
