// The time interfaces of a document's window, on the document's clock
// (docs/design/component-rendering.md, "Page clock").
//
// - `performance`: `now()` and `timeOrigin` (High Resolution Time, §7.1 and
//   §7.2), `toJSON()`, and User Timing's `mark()`, `measure()` and entry
//   lists, with an entry buffer per document.
// - `Date`, for an injected clock: the realm's `Date` whose current time is
//   the time origin plus the document's time.
// - The window's event constructors (src/dom/events.js): a construction
//   stamps `timeStamp` (DOM, §2.2).
// - The window timers: the document's timers (src/dom/document-timers.js).
//
// A window that is the host's own global object (`renderComponent`) on the
// host's real clock keeps the host's interfaces: they already read that
// clock, and host code that shares the realm keeps its own timers.
// The User Timing rules are in core/dom/frame-performance.watpart.
import { fixDocumentClock } from "./document-clock.js";
import { SDEvent, stampEventTime } from "./events.js";
import { documentScripts } from "./scripts.js";
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

const PERFORMANCE_FILTER_TYPE = layoutConstant("PERFORMANCE_FILTER_TYPE");
const PERFORMANCE_FILTER_NAME = layoutConstant("PERFORMANCE_FILTER_NAME");
const NEGATIVE_MARK = layoutConstant("PERFORMANCE_NEGATIVE_MARK");
const NEGATIVE_MEASURE = layoutConstant("PERFORMANCE_NEGATIVE_MEASURE");
const END_RULE_MASK = layoutConstant("PERFORMANCE_END_RULE_MASK");
const START_RULE_SHIFT = layoutConstant("PERFORMANCE_START_RULE_SHIFT");
const END_FROM_END_OPTION = layoutConstant("PERFORMANCE_END_FROM_END");
const END_FROM_START_AND_DURATION = layoutConstant("PERFORMANCE_END_FROM_START_AND_DURATION");
const START_FROM_START_OPTION = layoutConstant("PERFORMANCE_START_FROM_START");
const START_FROM_END_AND_DURATION = layoutConstant("PERFORMANCE_START_FROM_END_AND_DURATION");
const COMBINE_ADD = layoutConstant("PERFORMANCE_COMBINE_ADD");
const COMBINE_SUBTRACT = layoutConstant("PERFORMANCE_COMBINE_SUBTRACT");

// `windowNames` are the names of the bindings that the window's installer
// defined on `target`: a `node:vm` context's global object does not list
// the properties defined on it from outside.
export function installPageClock(target, document, windowNames) {
  const clock = fixDocumentClock(document);
  if (target === globalThis && clock.real) return;
  Object.defineProperty(target, "performance", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: createPagePerformance(clock),
  });
  if (!clock.real && typeof target.Date === "function") {
    Object.defineProperty(target, "Date", {
      configurable: true,
      writable: true,
      value: createPageDate(target.Date, clock),
    });
  }
  const names = new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(globalThis), ...windowNames]);
  for (const name of names) {
    if (typeof name !== "string" || !name.endsWith("Event") || !Object.hasOwn(target, name)) continue;
    const Constructor = target[name];
    if (
      typeof Constructor !== "function" ||
      (Constructor !== SDEvent && !(Constructor.prototype instanceof SDEvent))
    ) continue;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: stampingEventConstructor(Constructor, clock),
    });
  }
  // On the host's own global object, an exception that a timer's function
  // throws is reported as the host reports one of its own timers: through
  // the global's reportError, which the window's dispatchEvent routes to the
  // document's exception sink.
  documentScripts(document).installWindowTimers(
    target,
    target === globalThis ? (error) => target.reportError(error) : null,
  );
}

function stampingEventConstructor(Constructor, clock) {
  const PageConstructor = new Proxy(Constructor, {
    construct(target, argumentsList, newTarget) {
      const event = Reflect.construct(target, argumentsList, newTarget === PageConstructor ? target : newTarget);
      stampEventTime(event, clock);
      return event;
    },
  });
  return PageConstructor;
}

// The realm's `Date` on the page's wall clock: `Date.now()`, `new Date()`
// and `Date()` read the time origin plus the document's time; every other
// operation is the realm's own.
function createPageDate(RealmDate, clock) {
  const now = {
    now() {
      return clock.epochNow();
    },
  }.now;
  const PageDate = new Proxy(RealmDate, {
    apply() {
      return RealmDate.prototype.toString.call(new RealmDate(clock.epochNow()));
    },
    construct(target, argumentsList, newTarget) {
      return Reflect.construct(
        target,
        argumentsList.length === 0 ? [clock.epochNow()] : argumentsList,
        newTarget === PageDate ? target : newTarget,
      );
    },
    get(target, key) {
      return key === "now" ? now : Reflect.get(target, key, target);
    },
  });
  return PageDate;
}

// The entries as host values: entry type, name and start time each
// (core/dom/frame-performance.watpart).
function entryValues(entries) {
  return entries.flatMap((entry) => [entry.entryType, entry.name, entry.startTime]);
}

function outputIndices(operation, count) {
  return count === 0 ? new Uint32Array(0) : new Uint32Array(core.outputBytes(operation, 0, count * 4).buffer);
}

// User Timing, "convert a mark to a timestamp".
function markTime(entries, mark) {
  if (typeof mark === "string") {
    return core.statusRaw("frame_performance_mark_lookup", ...core.valueListInput([mark, ...entryValues(entries)]));
  }
  const time = Number(mark);
  if (core.exports.frame_performance_negative(time)) {
    core.statusRaw("frame_performance_negative_error", NEGATIVE_MEASURE, ...core.input(`${mark}`));
  }
  return time;
}

function performanceEntry(name, entryType, startTime, duration, detail) {
  return Object.freeze({
    name,
    entryType,
    startTime,
    duration,
    detail,
    toJSON() {
      return { name, entryType, startTime, duration, detail };
    },
  });
}

function createPagePerformance(clock) {
  const entries = [];
  // filter: the PERFORMANCE_FILTER_* bits; none lists every entry.
  const listed = (filter, type = "", name = "") => {
    const count = core.status("frame_performance_list", ...core.valueListInput([filter, type, name, ...entryValues(entries)]));
    return Array.from(outputIndices("frame_performance_list", count), (index) => entries[index]);
  };
  const clear = (measure, name) => {
    const count = core.status("frame_performance_clear", measure, ...core.valueListInput([name, ...entryValues(entries)]));
    const indices = outputIndices("frame_performance_clear", count);
    for (let index = indices.length - 1; index >= 0; index--) entries.splice(indices[index], 1);
  };
  return Object.freeze({
    now() {
      return clock.now();
    },
    get timeOrigin() {
      return clock.timeOrigin;
    },
    toJSON() {
      return { timeOrigin: clock.timeOrigin };
    },
    mark(markName, markOptions = {}) {
      const name = String(markName);
      const startTime = markOptions?.startTime === undefined ? clock.now() : Number(markOptions.startTime);
      if (core.exports.frame_performance_negative(startTime)) {
        core.statusRaw("frame_performance_negative_error", NEGATIVE_MARK, ...core.input(name));
      }
      const entry = performanceEntry(name, "mark", startTime, 0, markOptions?.detail ?? null);
      entries.push(entry);
      return entry;
    },
    measure(measureName, startOrMeasureOptions = undefined, endMark = undefined) {
      const name = String(measureName);
      let start;
      let end;
      let detail = null;
      if (startOrMeasureOptions !== null && typeof startOrMeasureOptions === "object") {
        const { start: startOption, end: endOption, duration } = startOrMeasureOptions;
        detail = startOrMeasureOptions.detail ?? null;
        const plan = core.statusRaw(
          "frame_performance_measure_plan",
          startOption === undefined ? 0 : 1,
          endOption === undefined ? 0 : 1,
          duration === undefined ? 0 : 1,
          endMark === undefined ? 0 : 1,
        );
        const endRule = plan & END_RULE_MASK;
        const startRule = plan >> START_RULE_SHIFT;
        if (endRule === END_FROM_END_OPTION) end = markTime(entries, endOption);
        else if (endRule === END_FROM_START_AND_DURATION) {
          end = core.exports.frame_performance_combine(COMBINE_ADD, markTime(entries, startOption), Number(duration));
        } else end = endMark === undefined ? clock.now() : markTime(entries, endMark);
        if (startRule === START_FROM_START_OPTION) start = markTime(entries, startOption);
        else if (startRule === START_FROM_END_AND_DURATION) start = core.exports.frame_performance_combine(COMBINE_SUBTRACT, end, Number(duration));
        else start = 0;
      } else {
        end = endMark === undefined ? clock.now() : markTime(entries, endMark);
        start = startOrMeasureOptions === undefined ? 0 : markTime(entries, startOrMeasureOptions);
      }
      const entry = performanceEntry(name, "measure", start, core.exports.frame_performance_combine(COMBINE_SUBTRACT, end, start), detail);
      entries.push(entry);
      return entry;
    },
    getEntries() {
      return listed(0);
    },
    getEntriesByType(type) {
      return listed(PERFORMANCE_FILTER_TYPE, String(type));
    },
    getEntriesByName(entryName, type = undefined) {
      const name = String(entryName);
      return type === undefined ? listed(PERFORMANCE_FILTER_NAME, "", name)
        : listed(PERFORMANCE_FILTER_TYPE | PERFORMANCE_FILTER_NAME, String(type), name);
    },
    clearMarks(markName = undefined) {
      clear(false, markName === undefined ? undefined : String(markName));
    },
    clearMeasures(measureName = undefined) {
      clear(true, measureName === undefined ? undefined : String(measureName));
    },
  });
}
