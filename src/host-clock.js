// The host's real clock, taken when this module is first evaluated.
//
// A page's window can be the host's own global object (`renderComponent`,
// or a classic-script session that evaluates in the caller's realm). With an
// injected clock, Sandom installs the page's `performance`, `Date` and timers
// on that global for the page's lifetime (src/dom/page-clock.js). Sandom's
// own measurements and its real-clock defaults read this module instead, so
// they read the host's clock whatever the page's window holds.
// src/dom/component-globals.js imports it, so it is evaluated before any
// window is installed.
const hostPerformance = globalThis.performance;

export const hostNow = hostPerformance.now.bind(hostPerformance);
export const hostTimeOrigin = hostPerformance.timeOrigin;
export const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
export const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
