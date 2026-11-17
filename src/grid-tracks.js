import { sharedDomCore as core } from "./dom-wasm/core.js";
import {
  GRID_TRACK_ENTRY_SIZE,
  GRID_TRACK_OFFSET_MIN_TYPE, GRID_TRACK_OFFSET_MAX_TYPE, GRID_TRACK_OFFSET_REPEAT_LENGTH,
  GRID_TRACK_OFFSET_MIN_VALUE, GRID_TRACK_OFFSET_MAX_VALUE,
  GRID_TRACK_OFFSET_MIN_PERCENTAGE, GRID_TRACK_OFFSET_MAX_PERCENTAGE,
  GRID_TRACK_AUTO_FILL, GRID_TRACK_AUTO_FIT,
} from "./wasm/layout.js";
import { layoutConstant } from "./wasm/layout-table.js";

// The codes of scene_grid_tracks and scene_grid_text, by the names of
// their WAT globals.
const GRID_VALUE_ABSENT = layoutConstant("GRID_VALUE_ABSENT");
const GRID_VALUE_NUMBER = layoutConstant("GRID_VALUE_NUMBER");
const GRID_VALUE_STRING = layoutConstant("GRID_VALUE_STRING");
const GRID_VALUE_OTHER = layoutConstant("GRID_VALUE_OTHER");
const GRID_TRACKS_SINGLE = layoutConstant("GRID_TRACKS_SINGLE");
const GRID_TRACKS_TEXT_LIST = layoutConstant("GRID_TRACKS_TEXT_LIST");
const GRID_TRACKS_ARRAY = layoutConstant("GRID_TRACKS_ARRAY");
const GRID_TEXT_CSS = layoutConstant("GRID_TEXT_CSS");
const GRID_TEXT_SCALE = layoutConstant("GRID_TEXT_SCALE");
// The input rows and scene_row_grid fields of grid-input.watpart.
const GRID_INPUT = Object.freeze(Object.fromEntries(["SIZE", "KIND", "POINTER", "LENGTH", "NUMBER"]
  .map((name) => [name, layoutConstant(`GRID_INPUT_${name}`)])));
const GRID_PROJECTION = Object.freeze(Object.fromEntries(["SIZE", "KIND", "TEXT", "LENGTH", "NUMBER"]
  .map((name) => [name, layoutConstant(`GRID_PROJECTION_${name}`)])));

const breadthNames = [
  "length", "percent", "fraction", "auto", "min-content", "max-content",
  "fit-content", "fit-content-percent", null, null,
  "length-percentage", "fit-content-length-percentage",
];

function trackInput(values) {
  const bytes = new Uint8Array(values.length * GRID_INPUT.SIZE);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    const offset = index * GRID_INPUT.SIZE;
    if (typeof value === "number") {
      view.setUint32(offset + GRID_INPUT.KIND, GRID_VALUE_NUMBER, true);
      view.setFloat64(offset + GRID_INPUT.NUMBER, value, true);
    } else if (typeof value === "string") {
      const [pointer, length] = core.input(value);
      view.setUint32(offset + GRID_INPUT.KIND, GRID_VALUE_STRING, true);
      view.setUint32(offset + GRID_INPUT.POINTER, pointer, true);
      view.setUint32(offset + GRID_INPUT.LENGTH, length, true);
    } else {
      view.setUint32(offset + GRID_INPUT.KIND, value == null ? GRID_VALUE_ABSENT : GRID_VALUE_OTHER, true);
    }
  });
  return core.byteInput(bytes)[0];
}

function readTracks(values, mode) {
  const count = core.status("scene_grid_tracks", trackInput(values), values.length, mode);
  const pointer = core.exports.abi_output_pointer();
  const view = new DataView(core.memory.buffer);
  const breadth = (record, typeOffset, valueOffset, percentageOffset) => {
    const type = view.getUint8(record + typeOffset);
    const name = breadthNames[type];
    if (name == null) throw new Error(`Unknown native grid breadth kind ${type}`);
    return {
      type: name,
      value: view.getFloat32(record + valueOffset, true),
      percentage: view.getFloat32(record + percentageOffset, true),
    };
  };
  return Array.from({ length: count }, (_, index) => {
    const record = pointer + index * GRID_TRACK_ENTRY_SIZE;
    const type = view.getUint8(record + GRID_TRACK_OFFSET_MIN_TYPE);
    if (type === GRID_TRACK_AUTO_FILL || type === GRID_TRACK_AUTO_FIT) {
      return {
        automaticRepeat: type === GRID_TRACK_AUTO_FILL ? "auto-fill" : "auto-fit",
        patternLength: view.getUint16(record + GRID_TRACK_OFFSET_REPEAT_LENGTH, true),
      };
    }
    return {
      minimum: breadth(record, GRID_TRACK_OFFSET_MIN_TYPE, GRID_TRACK_OFFSET_MIN_VALUE, GRID_TRACK_OFFSET_MIN_PERCENTAGE),
      maximum: breadth(record, GRID_TRACK_OFFSET_MAX_TYPE, GRID_TRACK_OFFSET_MAX_VALUE, GRID_TRACK_OFFSET_MAX_PERCENTAGE),
    };
  });
}

export function parseGridTrack(track) {
  return readTracks([track], GRID_TRACKS_SINGLE)[0];
}

// Native wire tracks, including repeat markers; named lines stay native.
export function parseGridTracks(template) {
  return Array.isArray(template) ? readTracks(template, GRID_TRACKS_ARRAY) : readTracks([template], GRID_TRACKS_TEXT_LIST);
}

function gridText(value, scale, mode) {
  const kind = typeof value === "number" ? GRID_VALUE_NUMBER : typeof value === "string" ? GRID_VALUE_STRING : GRID_VALUE_ABSENT;
  const [pointer, length] = typeof value === "string" ? core.input(value) : [0, 0];
  const outputKind = core.status("scene_grid_text", pointer, length, typeof value === "number" ? value : 0, kind, scale, mode);
  if (outputKind === GRID_VALUE_NUMBER) return new DataView(core.memory.buffer).getFloat64(core.exports.abi_output_pointer(), true);
  if (outputKind === GRID_VALUE_STRING) return core.outputString();
  throw new Error(`Unknown native grid text kind ${outputKind}`);
}

export function scaleGridTrack(track, scale) {
  return gridText(track, scale, GRID_TEXT_SCALE);
}

export function gridTrackCss(track) {
  return gridText(track, 1, GRID_TEXT_CSS);
}

const projectionFields = [
  "gridTemplateColumns", "gridTemplateRows", "gridRowStart", "gridRowEnd", "gridColumnStart", "gridColumnEnd",
];

// The native authored publication owns area and named-line resolution. This
// projection keeps original track text at full precision for subsequent scale.
export function readSceneRowGrid(core, node) {
  const publication = node._corePublication;
  if (publication?.core !== core) throw new TypeError("Grid readback requires a publication from the supplied core");
  const pointer = core.status("scene_row_grid", publication.handle, node._corePublicationIndex);
  const view = new DataView(core.memory.buffer);
  const bytes = core.refreshBytes();
  const result = {};
  projectionFields.forEach((property, index) => {
    const offset = pointer + index * GRID_PROJECTION.SIZE;
    const kind = view.getUint32(offset + GRID_PROJECTION.KIND, true);
    if (kind === GRID_VALUE_ABSENT) return;
    if (kind === GRID_VALUE_NUMBER) {
      result[property] = view.getFloat64(offset + GRID_PROJECTION.NUMBER, true);
    } else if (kind === GRID_VALUE_STRING) {
      const text = view.getUint32(offset + GRID_PROJECTION.TEXT, true);
      result[property] = core.decoder.decode(bytes.subarray(text, text + view.getUint32(offset + GRID_PROJECTION.LENGTH, true)));
    } else {
      throw new Error(`Unknown native grid projection kind ${kind}`);
    }
  });
  return result;
}
