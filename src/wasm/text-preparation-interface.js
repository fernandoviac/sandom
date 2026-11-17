// Renderer-core text preparation ABI. Keep these values in lockstep with
// src/wasm/engine.wat; the WAT exports are the ABI authority.
export const TEXT_PREPARATION_ABI_VERSION = 2;

export const TEXT_PREPARATION_ERROR = Object.freeze({
  OK: 0,
  BOUNDS: 1,
  CAPACITY: 2,
  HANDLE: 3,
  GRAPH: 7,
  MODE: 8,
  UTF8: 9,
});

export const TEXT_PREPARATION_RUN_SIZE = 40;
export const TEXT_PREPARATION_RUN = Object.freeze({
  SOURCE: 0,
  LENGTH: 4,
  MODE: 8,
  FLAGS: 12,
  PARENT: 16,
  SOURCE_ID: 20,
  REVISION: 24,
  LETTER_SPACING: 28,
  // The offset map of the run's text-transform (u32 per UTF-16 unit of
  // the run's text and one for its end: the UTF-16 offset in the node's
  // data) and its entry count, or 0 and 0.
  TRANSFORM_MAP: 32,
  TRANSFORM_MAP_LENGTH: 36,
});

export const TEXT_PREPARATION_RESULT_SIZE = 40;
export const TEXT_PREPARATION_RESULT = Object.freeze({
  BYTES: 0,
  LENGTH: 4,
  MAPPING: 8,
  AUTHORED_LENGTH: 12,
  SOURCE_ID: 16,
  REVISION: 20,
  LETTER_SPACING: 24,
  ELLIPSIS: 28,
  DIGEST: 32,
  // u32 per prepared byte and one for the end: the UTF-16 offset in the
  // node's data of the scalar that the byte stands for.
  SOURCE_OFFSETS: 36,
});

export const TEXT_PREPARATION_WHITE_SPACE = Object.freeze({
  normal: 0,
  nowrap: 1,
  pre: 2,
  "pre-wrap": 3,
  "pre-line": 4,
  "break-spaces": 5,
});
