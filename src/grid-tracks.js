import { sharedDomCore as core } from "./dom-wasm/core.js";
import {
  GRID_TRACK_ENTRY_SIZE,
  GRID_TRACK_OFFSET_MIN_TYPE, GRID_TRACK_OFFSET_MAX_TYPE,
  GRID_TRACK_OFFSET_MIN_VALUE, GRID_TRACK_OFFSET_MAX_VALUE,
  GRID_TRACK_OFFSET_MIN_PERCENTAGE, GRID_TRACK_OFFSET_MAX_PERCENTAGE,
  GRID_TRACK_AUTO_FILL, GRID_TRACK_AUTO_FIT,
} from "./wasm/layout.js";

const breadthNames = [
  "length", "percent", "fraction", "auto", "min-content", "max-content",
  "fit-content", "fit-content-percent", null, null,
  "length-percentage", "fit-content-length-percentage",
];

function trackInput(values) {
  const bytes = new Uint8Array(values.length * 24);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    const offset = index * 24;
    if (typeof value === "number") {
      view.setUint32(offset, 1, true);
      view.setFloat64(offset + 16, value, true);
    } else if (typeof value === "string") {
      const [pointer, length] = core.input(value);
      view.setUint32(offset, 2, true);
      view.setUint32(offset + 4, pointer, true);
      view.setUint32(offset + 8, length, true);
    } else {
      view.setUint32(offset, value == null ? 0 : 3, true);
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
        patternLength: view.getUint8(record + GRID_TRACK_OFFSET_MAX_TYPE),
      };
    }
    return {
      minimum: breadth(record, GRID_TRACK_OFFSET_MIN_TYPE, GRID_TRACK_OFFSET_MIN_VALUE, GRID_TRACK_OFFSET_MIN_PERCENTAGE),
      maximum: breadth(record, GRID_TRACK_OFFSET_MAX_TYPE, GRID_TRACK_OFFSET_MAX_VALUE, GRID_TRACK_OFFSET_MAX_PERCENTAGE),
    };
  });
}

export function parseGridTrack(track) {
  return readTracks([track], 0)[0];
}

// Native wire tracks, including repeat markers; named lines stay native.
export function parseGridTracks(template) {
  return Array.isArray(template) ? readTracks(template, 2) : readTracks([template], 1);
}

function gridText(value, scale, mode) {
  const kind = typeof value === "number" ? 1 : typeof value === "string" ? 2 : 0;
  const [pointer, length] = typeof value === "string" ? core.input(value) : [0, 0];
  const outputKind = core.status("scene_grid_text", pointer, length, typeof value === "number" ? value : 0, kind, scale, mode);
  if (outputKind === 1) return new DataView(core.memory.buffer).getFloat64(core.exports.abi_output_pointer(), true);
  if (outputKind === 2) return core.outputString();
  throw new Error(`Unknown native grid text kind ${outputKind}`);
}

export function scaleGridTrack(track, scale) {
  return gridText(track, scale, 1);
}

export function gridTrackCss(track) {
  return gridText(track, 1, 0);
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
    const offset = pointer + index * 16;
    const kind = view.getUint32(offset, true);
    if (kind === 0) return;
    if (kind === 1) {
      result[property] = view.getFloat64(offset + 8, true);
    } else if (kind === 2) {
      const text = view.getUint32(offset + 4, true);
      result[property] = core.decoder.decode(bytes.subarray(text, text + view.getUint32(offset + 8, true)));
    } else {
      throw new Error(`Unknown native grid projection kind ${kind}`);
    }
  });
  return result;
}
