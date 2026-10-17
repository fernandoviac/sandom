import {
  DISPLAY_SVG_SHAPE,
  LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP,
  LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT,
  LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT_Y,
  LAYOUT_NODE_OFFSET_BORDER_STYLE_TOP,
  LAYOUT_NODE_OFFSET_BORDER_TOP,
  LAYOUT_NODE_OFFSET_DISPLAY,
  LAYOUT_NODE_OFFSET_SVG_FILL_COLOR,
  LAYOUT_NODE_OFFSET_SVG_FILL_RULE,
  LAYOUT_NODE_OFFSET_SVG_KIND,
  LAYOUT_NODE_OFFSET_SVG_LINE_CAP,
  LAYOUT_NODE_OFFSET_SVG_LINE_JOIN,
  LAYOUT_NODE_OFFSET_SVG_PATH_INDEX,
  LAYOUT_NODE_OFFSET_SVG_STROKE_COLOR,
  LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX,
  LAYOUT_NODE_OFFSET_SVG_STROKE_WIDTH,
} from "../wasm/layout.js";

// The style generation each serialized node list was taken at. A
// DOM-backed node carries no style, so a renderer given only the nodes
// reads here whether their styles may have changed.
const nodeListStyleGenerations = new WeakMap();

export function recordSceneStyleGeneration(nodes, generation) {
  nodeListStyleGenerations.set(nodes, generation);
}

export function sceneStyleGeneration(nodes) {
  return nodeListStyleGenerations.get(nodes);
}

const sides = ["top", "right", "bottom", "left"];
const corners = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
const styles = [
  "solid",
  "double",
  "dashed",
  "dotted",
  "inset",
  "outset",
  "groove",
  "ridge",
  "none",
  "hidden",
];

// Presentation names and bounded record reads only. Native preparation and
// the native paint transform resolver own every value returned here.
export function readSceneRowStyle(
  core,
  node,
  box = { x: 0, y: 0, w: 0, h: 0 },
) {
  const publication = node._corePublication;
  if (publication?.core !== core) {
    throw new TypeError(
      `Scene style requires a publication from this renderer core; node ` +
        `${node._corePublicationIndex ?? "without an index"} has ` +
        `${publication === undefined ? "no publication" : "a publication from another core"}`,
    );
  }
  const record = core.status(
    "scene_row_style",
    publication.handle,
    node._corePublicationIndex,
    box.x,
    box.y,
    box.w,
    box.h,
  );
  const view = new DataView(core.refreshBytes().buffer);
  const output = core.exports.abi_output_pointer();
  const number = (offset) => view.getFloat32(record + offset, true);
  const color = (offset) => ({
    r: number(offset),
    g: number(offset + 4),
    b: number(offset + 8),
    a: number(offset + 12),
  });
  const style = {
    matrix: Array.from(
      { length: 6 },
      (_, index) => view.getFloat32(output + index * 4, true),
    ),
    diagnosticMatrix: Array.from(
      { length: 6 },
      (_, index) => view.getFloat64(output + 48 + index * 8, true),
    ),
    worldMatrix: Array.from(
      { length: 6 },
      (_, index) => view.getFloat32(output + 24 + index * 4, true),
    ),
    border: Object.fromEntries(
      sides.map((
        side,
        index,
      ) => [side, number(LAYOUT_NODE_OFFSET_BORDER_TOP + index * 4)]),
    ),
    borderColors: Object.fromEntries(
      sides.map((
        side,
        index,
      ) => [side, color(LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP + index * 16)]),
    ),
    borderStyles: Object.fromEntries(sides.map((side, index) => {
      const value = view.getUint8(
        record + LAYOUT_NODE_OFFSET_BORDER_STYLE_TOP + index,
      );
      if (styles[value] === undefined) {
        throw new Error(`Unknown native border style ${value}`);
      }
      return [side, styles[value]];
    })),
    borderRadii: Object.fromEntries(corners.map((corner, index) => [corner, {
      rx: number(LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT + index * 4),
      ry: number(LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT_Y + index * 4),
    }])),
  };
  if (
    view.getUint8(record + LAYOUT_NODE_OFFSET_DISPLAY) === DISPLAY_SVG_SHAPE
  ) {
    const kind = view.getUint8(record + LAYOUT_NODE_OFFSET_SVG_KIND);
    const fillIndex = view.getUint16(
      record + LAYOUT_NODE_OFFSET_SVG_PATH_INDEX,
      true,
    );
    const strokeIndex = view.getUint16(
      record + LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX,
      true,
    );
    style.svg = {
      kind,
      fill: color(LAYOUT_NODE_OFFSET_SVG_FILL_COLOR),
      stroke: color(LAYOUT_NODE_OFFSET_SVG_STROKE_COLOR),
      width: number(LAYOUT_NODE_OFFSET_SVG_STROKE_WIDTH),
      fillRule: view.getUint8(record + LAYOUT_NODE_OFFSET_SVG_FILL_RULE) === 1
        ? "evenodd"
        : "nonzero",
      cap: [
        "butt",
        "round",
        "square",
      ][view.getUint8(record + LAYOUT_NODE_OFFSET_SVG_LINE_CAP)],
      join: [
        "miter",
        "round",
        "bevel",
      ][view.getUint8(record + LAYOUT_NODE_OFFSET_SVG_LINE_JOIN)],
    };
    if (kind === 4) {
      style.svg.path = core.svgPathDefinition(fillIndex);
      style.svg.bounds = core.sceneSvgPathBounds(
        publication.handle,
        node._corePublicationIndex,
      );
      if (strokeIndex !== 65535) {
        style.svg.strokeParameters = core.svgPathDefinition(strokeIndex).stroke;
      }
    }
  }
  return style;
}
