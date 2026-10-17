// The time interfaces of a document's window, on the document's clock
// (docs/design/component-rendering.md, "Page clock").
//
// - `performance`: `now()` and `timeOrigin` (High Resolution Time, §7.1 and
//   §7.2), `toJSON()`, and User Timing's `mark()`, `measure()` and entry
//   lists, with an entry buffer per document.
// - `Date`, for an injected clock: the realm's `Date` whose current time is
//   the time origin plus the document's time.
// - The window's event constructors: a construction stamps `timeStamp`
//   (DOM, §2.2).
// - The window timers: the document's timers (src/dom/document-timers.js).
//
// A window that is the host's own global object (`renderComponent`) on the
// host's real clock keeps the host's interfaces: they already read that
// clock, and host code that shares the realm keeps its own timers.
import { fixDocumentClock } from "./document-clock.js";
import { stampEventTime } from "./events.js";
import { documentScripts } from "./scripts.js";

// The host's Event, taken before any window can replace the global one.
const HostEvent = globalThis.Event;

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
      (Constructor !== HostEvent && !(Constructor.prototype instanceof HostEvent))
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

function syntaxError(message) {
  return new DOMException(message, "SyntaxError");
}

// User Timing, "convert a mark to a timestamp".
function markTime(entries, mark) {
  if (typeof mark === "string") {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.entryType === "mark" && entry.name === mark) return entry.startTime;
    }
    throw syntaxError(`Failed to execute 'measure' on 'Performance': The mark '${mark}' does not exist.`);
  }
  const time = Number(mark);
  if (time < 0) {
    throw new TypeError(`Failed to execute 'measure' on 'Performance': '${mark}' cannot be negative.`);
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
  const listed = (filter) =>
    entries.filter(filter).sort((left, right) => left.startTime - right.startTime);
  const clear = (entryType, name) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.entryType === entryType && (name === undefined || entry.name === name)) entries.splice(index, 1);
    }
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
      if (startTime < 0) {
        throw new TypeError(`Failed to execute 'mark' on 'Performance': '${name}' cannot have a negative start time.`);
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
        if (
          (startOption !== undefined || endOption !== undefined || duration !== undefined) && endMark !== undefined
        ) {
          throw new TypeError("Failed to execute 'measure' on 'Performance': an end mark cannot come with measure options.");
        }
        if (startOption === undefined && endOption === undefined && duration !== undefined) {
          throw new TypeError("Failed to execute 'measure' on 'Performance': a duration needs a start or an end.");
        }
        if (startOption !== undefined && endOption !== undefined && duration !== undefined) {
          throw new TypeError("Failed to execute 'measure' on 'Performance': start, end and duration cannot all be given.");
        }
        if (endOption !== undefined) end = markTime(entries, endOption);
        else if (startOption !== undefined && duration !== undefined) end = markTime(entries, startOption) + Number(duration);
        else end = endMark === undefined ? clock.now() : markTime(entries, endMark);
        if (startOption !== undefined) start = markTime(entries, startOption);
        else if (duration !== undefined) start = end - Number(duration);
        else start = 0;
      } else {
        end = endMark === undefined ? clock.now() : markTime(entries, endMark);
        start = startOrMeasureOptions === undefined ? 0 : markTime(entries, startOrMeasureOptions);
      }
      const entry = performanceEntry(name, "measure", start, end - start, detail);
      entries.push(entry);
      return entry;
    },
    getEntries() {
      return listed(() => true);
    },
    getEntriesByType(type) {
      const entryType = String(type);
      return listed((entry) => entry.entryType === entryType);
    },
    getEntriesByName(entryName, type = undefined) {
      const name = String(entryName);
      return listed((entry) => entry.name === name && (type === undefined || entry.entryType === String(type)));
    },
    clearMarks(markName = undefined) {
      clear("mark", markName === undefined ? undefined : String(markName));
    },
    clearMeasures(measureName = undefined) {
      clear("measure", measureName === undefined ? undefined : String(measureName));
    },
  });
}
