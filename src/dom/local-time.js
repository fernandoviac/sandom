// The local date and time of a document: its clock's wall time
// (src/dom/document-clock.js, the time origin plus the document's time)
// in its time zone: UTC, unless the host gives createSandomDOM another
// (`timeZone`). The date and time inputs take today and now from here
// (design/interaction.md, "Date and time inputs", D4).
import { fixDocumentClock } from "./document-clock.js";

const DAY = 86400000;
const formatters = new Map();

// The render surface of `node`'s document, or null.
export function renderSurfaceOf(node) {
  const document = node.ownerDocument ?? node;
  return node._renderSurface ?? document.documentElement?._renderSurface ?? document._componentRenderSurface ?? null;
}

// The time of the render surface clock of `node`'s document, which input
// records carry: transient activation lasts 5000ms of it after an
// activation triggering input event (core/dom/input-run.watpart). NaN
// without a surface.
export function activationClock(node) {
  const surface = renderSurfaceOf(node);
  return surface ? surface._now() : NaN;
}

// Checks an IANA time zone name and returns its canonical form.
export function assertTimeZone(timeZone, label) {
  if (typeof timeZone !== "string" || timeZone === "") {
    throw new TypeError(`${label}: timeZone must be an IANA time zone name such as "Europe/Madrid", received ${String(timeZone)}`);
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(`${label}: timeZone ${JSON.stringify(timeZone)} is not a time zone that Intl knows; give an IANA name such as "Europe/Madrid" or "UTC"`);
  }
}

function formatter(timeZone) {
  let entry = formatters.get(timeZone);
  if (entry === undefined) {
    entry = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, entry);
  }
  return entry;
}

// The document's local date and time now, as the milliseconds of that
// date and time read as UTC: the numbers of the date and time inputs. The
// time is `clock`'s, by default the document's clock, which a read fixes.
export function localNow(document, clock = fixDocumentClock(document)) {
  const timeZone = document._timeZone ?? "UTC";
  const epoch = clock.epochNow();
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(epoch).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, ((epoch % 1000) + 1000) % 1000);
}

// The number that an empty date or time input steps from, as Chrome's
// DefaultValueForStepUp gives it: today, this month, this week's Monday,
// now, or this time of day; NaN for another input or a value.
export function emptyStepNumber(input) {
  const type = input.type;
  if (!["date", "month", "week", "time", "datetime-local"].includes(type) || input.value !== "") return NaN;
  const now = localNow(input.ownerDocument);
  const day = Math.floor(now / DAY) * DAY;
  if (type === "date") return day;
  if (type === "datetime-local") return Math.floor(now / 60000) * 60000;
  if (type === "time") return Math.floor((now - day) / 60000) * 60000;
  if (type === "week") return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const date = new Date(day);
  return (date.getUTCFullYear() - 1970) * 12 + date.getUTCMonth();
}
