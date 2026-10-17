// The page timers of one document on the document's clock (HTML Standard,
// §8.7 "Timers"; docs/specifications/host-boundary.md, "Classic-script session").
//
// The document owns its timer ids and its map of active timers. A timer's
// due time is on the document clock (src/dom/document-clock.js), the one
// clock the page reads, so an injected clock gives exact due times.
//
// Nothing here polls. Sandom learns that the clock advanced from events:
// - every frame of the surface that drives the document (a loop frame,
//   renderNow, tick, a capture sample) runs the timers due by its time
//   before its rendering steps (DOMRenderSurface._advanceDocumentClock);
// - on an injected clock, while no running surface drives the document, a
//   pending timer keeps a frame of the clock's own frame source requested,
//   and that frame runs the timers due by its time; while one does, the
//   surface keeps its frame requested instead;
// - on the host's real clock, one host timer is armed for the earliest due
//   time.
// A timer that is due enters the document's task queue, after the timers
// due before it and after the timers due at the same time that were set
// before it.
import { hostClearTimeout, hostSetTimeout } from "../host-clock.js";

// "If nesting level is greater than 5, and timeout is less than 4, then set
// timeout to 4." Chrome 151 measures the same: in a chain of zero-delay
// timers started outside a timer, the seventh is the first that waits 4 ms.
const MAXIMUM_UNCLAMPED_NESTING_LEVEL = 5;
const NESTED_MINIMUM_TIMEOUT = 4;

const hostTimers = Object.freeze({ setTimer: hostSetTimeout, clearTimer: hostClearTimeout });

// WebIDL `long`: ToNumber, then modulo 2^32 into the signed range.
function toLong(value) {
  return value | 0;
}

export class DocumentTimers {
  // `clock` is the document's clock. `enqueue(task)` appends a task to the
  // document's task queue and returns a promise that settles when the task
  // has run or the queue is dropped. `host` ({ setTimer, clearTimer }) arms
  // the host timer of the real clock.
  constructor(document, clock, enqueue, host = hostTimers) {
    this.document = document;
    this.clock = clock;
    this.enqueue = enqueue;
    this.host = host;
    this.active = new Map();
    this.pending = [];
    // Timer tasks in the document's task queue that have not run yet.
    this.queued = 0;
    this.lastQueued = null;
    this.nextId = 1;
    this.sequence = 0;
    // The timer nesting level of the timer task that runs now, or 0.
    this.nestingLevel = 0;
    this.hostTimer = null;
    this.hostTimerDue = Infinity;
    this.frameRequest = null;
    this.released = false;
  }

  // The document's time now.
  now() {
    return this.clock.now();
  }

  // The surface that drives the document, its frames running or its
  // capture sampling, or null.
  framingDriver() {
    const driver = this.document._componentRenderSurface ?? null;
    return driver !== null && driver._drivesDocumentClock() && driver._framesAdvanceDocumentClock()
      ? driver
      : null;
  }

  // The driving surface started, stopped, changed or captures: the pending
  // timers wait for the frames that now advance the clock.
  driverChanged() {
    this.disarm();
    this.armClock();
  }

  get hasPending() {
    return this.pending.length > 0;
  }

  // The document's clock advanced: the timers due by now run, those already
  // in the task queue included, and so do the timers they set that are due
  // by then. Null when there is none; otherwise a promise that settles after
  // they ran.
  advance() {
    if (this.queued === 0 && !this.hasDue()) return null;
    return this.runDue();
  }

  hasDue() {
    return this.pending.length > 0 && this.pending[0].due <= this.now();
  }

  async runDue() {
    for (;;) {
      if (this.hasDue()) this.releaseDue();
      if (this.queued === 0) return;
      await this.lastQueued;
    }
  }

  // Moves every timer due by now into the document's task queue, in order.
  releaseDue() {
    const now = this.now();
    while (this.pending.length > 0 && this.pending[0].due <= now) {
      const timer = this.pending.shift();
      this.queued += 1;
      this.lastQueued = this.enqueue(() => this.run(timer)).then(() => {
        this.queued -= 1;
      });
    }
    this.armClock();
  }

  // "Timer initialization steps".
  initialize(callback, timeout, repeat, previousId = null) {
    const id = previousId ?? this.nextId++;
    let delay = Math.max(0, timeout);
    if (this.nestingLevel > MAXIMUM_UNCLAMPED_NESTING_LEVEL && delay < NESTED_MINIMUM_TIMEOUT) {
      delay = NESTED_MINIMUM_TIMEOUT;
    }
    const now = this.now();
    const timer = {
      id,
      callback,
      timeout,
      repeat,
      nestingLevel: this.nestingLevel + 1,
      due: now + delay,
      sequence: this.sequence++,
    };
    this.active.set(id, timer);
    this.insert(timer);
    // A timer due at once (a zero delay) enters the task queue now, after
    // the timers due before it, as Chrome posts it.
    if (timer.due <= now) this.releaseDue();
    else this.armClock();
    return id;
  }

  // Pending timers in due order; equal due times in the order they were
  // set ("run steps after a timeout", the ordering of one global).
  insert(timer) {
    let low = 0;
    let high = this.pending.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = this.pending[middle];
      if (other.due < timer.due || (other.due === timer.due && other.sequence < timer.sequence)) low = middle + 1;
      else high = middle;
    }
    this.pending.splice(low, 0, timer);
  }

  // The task of a timer.
  run(timer) {
    if (this.released || this.active.get(timer.id) !== timer) return;
    const outerLevel = this.nestingLevel;
    this.nestingLevel = timer.nestingLevel;
    try {
      timer.callback();
    } finally {
      this.nestingLevel = outerLevel;
      if (this.active.get(timer.id) === timer) {
        if (timer.repeat && !this.released) {
          this.nestingLevel = timer.nestingLevel;
          try {
            this.initialize(timer.callback, timer.timeout, true, timer.id);
          } finally {
            this.nestingLevel = outerLevel;
          }
        } else {
          this.active.delete(timer.id);
        }
      }
    }
  }

  setTimer(callback, timeout, repeat) {
    return this.initialize(callback, toLong(timeout), repeat);
  }

  // clearTimeout and clearInterval.
  clear(id) {
    const timer = this.active.get(toLong(id));
    if (timer === undefined) return;
    this.active.delete(timer.id);
    const index = this.pending.indexOf(timer);
    if (index < 0) return;
    this.pending.splice(index, 1);
    if (index === 0) this.armClock();
  }

  // Waits for the next event that advances the clock while a timer is
  // pending: a host timer for the real clock's earliest due time; for an
  // injected clock, a frame of the driving surface or of the clock itself.
  armClock() {
    const next = this.pending[0];
    if (next === undefined || this.released) {
      this.disarm();
      return;
    }
    if (this.clock.real) {
      if (this.hostTimer !== null && this.hostTimerDue <= next.due) return;
      this.disarm();
      this.hostTimerDue = next.due;
      this.hostTimer = this.host.setTimer(() => {
        this.hostTimer = null;
        this.hostTimerDue = Infinity;
        this.releaseDue();
      }, Math.max(0, next.due - this.now()));
      return;
    }
    const driver = this.framingDriver();
    if (driver !== null) {
      this.disarm();
      driver._schedule();
      return;
    }
    if (this.frameRequest !== null) return;
    // The frame's callback returns the promise of the timers it runs, as a
    // surface's frame callback returns its frame's.
    this.frameRequest = this.clock.requestFrame((time) => {
      this.frameRequest = null;
      this.clock.hold(time);
      const running = this.advance();
      this.armClock();
      return running;
    });
  }

  disarm() {
    if (this.hostTimer !== null) {
      this.host.clearTimer(this.hostTimer);
      this.hostTimer = null;
      this.hostTimerDue = Infinity;
    }
    if (this.frameRequest !== null) {
      this.clock.cancelFrame(this.frameRequest);
      this.frameRequest = null;
    }
  }

  release() {
    this.released = true;
    this.disarm();
    this.active.clear();
    this.pending.length = 0;
  }
}
