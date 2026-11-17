// The browser session host protocol: every message kind and the protocol
// version in one module (plans/PLAN-browser-session-host.md). Both sides
// import this file; a message whose version differs from
// SESSION_HOST_PROTOCOL_VERSION fails loudly on receipt, on either side.
//
// Main -> worker:
//   { kind: SESSION_HOST_START_KIND, version, canvas, width, height,
//     deviceScale, module, component, schema, instance,
//     fonts: [{ family, url }], stylesheets: [{ url, source } | { locator }] }
//   { kind: SESSION_HOST_PRESENT_KIND, version, enabled }
//   { kind: SESSION_HOST_INPUT_KIND, version, records }
//   { kind: SESSION_HOST_INSPECT_KIND, version }
//   { kind: SESSION_HOST_STYLE_SET_KIND, version, identifier, property, value }
//   { kind: SESSION_HOST_CAPTURE_KIND, version }
//   { kind: SESSION_HOST_RESIZE_KIND, version, width, height, deviceScale }
//   { kind: SESSION_HOST_END_KIND, version }
// Worker -> main:
//   { kind: SESSION_HOST_STARTED_KIND, version }
//   { kind: SESSION_HOST_FAILED_KIND, version, message }
//   { kind: SESSION_HOST_ENDED_KIND, version }
//   { kind: SESSION_HOST_PRESENTATION_MODE_KIND, version, extended,
//     dynamicRange }
//   { kind: SESSION_HOST_INPUT_RESULT_KIND, version, target, cursor }
//   { kind: SESSION_HOST_INSPECT_RESULT_KIND, version, tree, boxes }
//   { kind: SESSION_HOST_CAPTURE_FRAME_KIND, version, bitmap, width, height }
//   { kind: SESSION_HOST_STEP_KIND, version, name }
//
// Version 2 (warm realm reuse, plans/PLAN-browser-session-host.md): an
// end-session exchange. END disposes the live session completely - the
// realm retains only fonts and module registries - and the worker answers
// ENDED, after which the same worker accepts a new START. A worker whose
// teardown failed refuses every later START loudly; the client then
// spawns a fresh worker (degraded reuse, reported, never silent).

export const SESSION_HOST_PROTOCOL_VERSION = 2;

export const SESSION_HOST_START_KIND = "sandom/session-host-start";
export const SESSION_HOST_PRESENT_KIND = "sandom/session-host-present";
export const SESSION_HOST_INPUT_KIND = "sandom/session-host-input";
export const SESSION_HOST_INSPECT_KIND = "sandom/session-host-inspect";
export const SESSION_HOST_STYLE_SET_KIND = "sandom/session-host-style-set";
export const SESSION_HOST_CAPTURE_KIND = "sandom/session-host-capture";
export const SESSION_HOST_RESIZE_KIND = "sandom/session-host-resize";
export const SESSION_HOST_END_KIND = "sandom/session-host-end";

export const SESSION_HOST_STARTED_KIND = "sandom/session-host-started";
export const SESSION_HOST_FAILED_KIND = "sandom/session-host-failed";
export const SESSION_HOST_PRESENTATION_MODE_KIND =
  "sandom/session-host-presentation-mode";
export const SESSION_HOST_INPUT_RESULT_KIND =
  "sandom/session-host-input-result";
export const SESSION_HOST_INSPECT_RESULT_KIND =
  "sandom/session-host-inspect-result";
export const SESSION_HOST_CAPTURE_FRAME_KIND =
  "sandom/session-host-capture-frame";
export const SESSION_HOST_STEP_KIND = "sandom/session-host-step";
export const SESSION_HOST_ENDED_KIND = "sandom/session-host-ended";
