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
//
// The timer table, the due order, the nesting clamp and the choice of the
// wait are in core/dom/frame-clock.watpart; this binding keeps the
// callbacks and performs the host timer, frame and task queue effects.
import { hostClearTimeout, hostSetTimeout } from "../host-clock.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

const hostTimers = Object.freeze({ setTimer: hostSetTimeout, clearTimer: hostClearTimeout });

const ARM_DISARM = layoutConstant("FRAME_TIMERS_ARM_DISARM");
const ARM_HOST_TIMER = layoutConstant("FRAME_TIMERS_ARM_HOST_TIMER");
const ARM_DRIVER = layoutConstant("FRAME_TIMERS_ARM_DRIVER");
const ARM_FRAME = layoutConstant("FRAME_TIMERS_ARM_FRAME");
const TIMER_DUE = layoutConstant("FRAME_TIMERS_STATE_DUE");
const TIMER_QUEUED = layoutConstant("FRAME_TIMERS_STATE_QUEUED");
const TIMER_PENDING = layoutConstant("FRAME_TIMERS_STATE_PENDING");
const END_FORGET = layoutConstant("FRAME_TIMERS_END_FORGET");
const END_REPEAT = layoutConstant("FRAME_TIMERS_END_REPEAT");
const CLEAR_REARM = layoutConstant("FRAME_TIMERS_CLEAR_REARM");
const DUE = Object.freeze(Object.fromEntries(["SIZE", "ID", "SEQUENCE"]
  .map((name) => [name, layoutConstant(`FRAME_TIMERS_DUE_${name}`)])));

// The 4-byte output of frame_timers_set and frame_timers_clear.
function outputWord() {
  return new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), 4).getInt32(0, true);
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
    this.handle = core.status("frame_timers_create");
    this.callbacks = new Map();
    this.lastQueued = null;
    this.hostTimer = null;
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
    return !this.released && (this.state() & TIMER_PENDING) !== 0;
  }

  // The timer table's state (frame_timers_state); `now`, when given, also
  // asks whether the next pending timer is due.
  state(now = -Infinity) {
    return core.status("frame_timers_state", this.handle, now);
  }

  hasDue() {
    return (this.state() & TIMER_PENDING) !== 0 && (this.state(this.now()) & TIMER_DUE) !== 0;
  }

  // The document's clock advanced: the timers due by now run, those already
  // in the task queue included, and so do the timers they set that are due
  // by then. Null when there is none; otherwise a promise that settles after
  // they ran.
  advance() {
    if (this.released) return null;
    if ((this.state() & TIMER_QUEUED) === 0 && !this.hasDue()) return null;
    return this.runDue();
  }

  async runDue() {
    while (!this.released) {
      if (this.hasDue()) this.releaseDue();
      if ((this.state() & TIMER_QUEUED) === 0) return;
      await this.lastQueued;
    }
  }

  // Moves every timer due by now into the document's task queue, in order.
  releaseDue() {
    if (this.released) return;
    const count = core.status("frame_timers_take_due", this.handle, this.now());
    const view = new DataView(core.refreshBytes().buffer, core.exports.abi_output_pointer(), count * DUE.SIZE);
    const due = Array.from({ length: count }, (_, index) =>
      [view.getInt32(index * DUE.SIZE + DUE.ID, true), view.getInt32(index * DUE.SIZE + DUE.SEQUENCE, true)]);
    for (const [id, sequence] of due) {
      this.lastQueued = this.enqueue(() => this.run(id, sequence)).then(() => {
        if (!this.released) core.status("frame_timers_task_done", this.handle);
      });
    }
    this.armClock();
  }

  // The timer's id was set: its task enters the queue now when it is due
  // now (a zero delay, after the timers due before it, as Chrome posts it),
  // else the clock waits for it.
  initialized(id) {
    const dueNow = outputWord() === 1;
    if (dueNow) this.releaseDue();
    else this.armClock();
    return id;
  }

  // The task of a timer.
  run(id, sequence) {
    if (this.released) return;
    const outerLevel = core.status("frame_timers_run_begin", this.handle, id, sequence);
    if (outerLevel < 0) return;
    try {
      this.callbacks.get(id)();
    } finally {
      if (!this.released) {
        const ending = core.status("frame_timers_run_end", this.handle, id, sequence, outerLevel);
        if (ending === END_FORGET) this.callbacks.delete(id);
        if (ending === END_REPEAT) {
          this.initialized(core.status("frame_timers_repeat", this.handle, id, outerLevel, this.now()));
        }
      }
    }
  }

  // A released table keeps giving ids; its timers never run.
  setTimer(callback, timeout, repeat) {
    if (this.released) {
      +timeout;
      return this.nextIdAfterRelease++;
    }
    const id = core.status("frame_timers_set", this.handle, +timeout, repeat ? 1 : 0, this.now());
    this.callbacks.set(id, callback);
    return this.initialized(id);
  }

  // clearTimeout and clearInterval.
  clear(id) {
    if (this.released) return;
    const cleared = core.status("frame_timers_clear", this.handle, +id);
    if (cleared === 0) return;
    this.callbacks.delete(outputWord());
    if (cleared & CLEAR_REARM) this.armClock();
  }

  // Waits for the next event that advances the clock while a timer is
  // pending: a host timer for the real clock's earliest due time; for an
  // injected clock, a frame of the driving surface or of the clock itself.
  armClock() {
    if (this.released) {
      this.disarm();
      return;
    }
    const real = this.clock.real;
    const driver = real ? null : this.framingDriver();
    const action = core.status(
      "frame_timers_arm",
      this.handle,
      real ? 1 : 0,
      this.hostTimer !== null ? 1 : 0,
      driver !== null ? 1 : 0,
      this.frameRequest !== null ? 1 : 0,
    );
    if (action === ARM_DISARM) {
      this.disarm();
    } else if (action === ARM_HOST_TIMER) {
      this.disarm();
      this.hostTimer = this.host.setTimer(() => {
        this.hostTimer = null;
        if (this.released) return;
        core.status("frame_timers_host_timer_ended", this.handle);
        this.releaseDue();
      }, core.status("frame_timers_host_delay", this.handle, this.now()));
    } else if (action === ARM_DRIVER) {
      this.disarm();
      driver._schedule();
    } else if (action === ARM_FRAME) {
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
  }

  disarm() {
    if (this.hostTimer !== null) {
      this.host.clearTimer(this.hostTimer);
      this.hostTimer = null;
      if (!this.released) core.status("frame_timers_host_timer_ended", this.handle);
    }
    if (this.frameRequest !== null) {
      this.clock.cancelFrame(this.frameRequest);
      this.frameRequest = null;
    }
  }

  release() {
    if (this.released) return;
    this.disarm();
    this.released = true;
    this.nextIdAfterRelease = core.status("frame_timers_release", this.handle);
    this.callbacks.clear();
  }
}
