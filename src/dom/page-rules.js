// Immutable @page rule resources. The core owns selector compilation,
// declaration cascade, page geometry, counters, and margin-box content.
import { sharedDomCore as core } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

// The page records (page-selectors, page-rules and page-content watparts),
// keyed by their name without the PAGE_ prefix.
const PAGE = Object.freeze(Object.fromEntries([
  "RULE_SIZE", "RULE_PRELUDE", "RULE_DECLARATIONS", "RULE_DECLARATION_COUNT", "RULE_MARGINS", "RULE_MARGIN_COUNT",
  "MARGIN_RULE_SIZE", "MARGIN_RULE_NAME", "MARGIN_RULE_DECLARATIONS", "MARGIN_RULE_DECLARATION_COUNT",
  "DECLARATION_SIZE", "DECLARATION_PROPERTY", "DECLARATION_VALUE", "DECLARATION_IMPORTANT",
  "INPUT_SIZE", "INPUT_INDEX", "INPUT_NAME", "INPUT_NAME_LENGTH", "INPUT_SIDE", "INPUT_SIDE_LENGTH", "INPUT_BLANK",
  "INPUT_GROUPS", "INPUT_GROUP_COUNT",
  "GROUP_SIZE", "GROUP_NAME", "GROUP_NAME_LENGTH", "GROUP_POSITION",
  "GEOMETRY_SIZE", "GEOMETRY_WIDTH", "GEOMETRY_HEIGHT", "GEOMETRY_MARGIN_TOP", "GEOMETRY_MARGIN_RIGHT",
  "GEOMETRY_MARGIN_BOTTOM", "GEOMETRY_MARGIN_LEFT", "GEOMETRY_AREA_X", "GEOMETRY_AREA_Y", "GEOMETRY_AREA_WIDTH",
  "GEOMETRY_AREA_HEIGHT",
  "MARGIN_BOX_SIZE", "MARGIN_BOX_DECLARATIONS", "MARGIN_BOX_CONTENT",
].map((name) => [name, layoutConstant(`PAGE_${name}`)])));
const TEXT_ROW_POINTER = layoutConstant("TEXT_ROW_POINTER");
const TEXT_ROW_LENGTH = layoutConstant("TEXT_ROW_LENGTH");

const ruleFinalizer = new FinalizationRegistry((handle) => {
  core.status("scene_page_rules_release", handle);
});

// String and record references are offsets into this slab; the native
// resource copies it before the call returns.
export function parsePageRules(rules) {
  let byteLength = rules.length * PAGE.RULE_SIZE;
  const fields = [];
  const strings = [];
  const reserve = (count, size) => {
    const offset = byteLength;
    byteLength += count * size;
    return offset;
  };
  const string = (offset, value) => {
    strings.push({ offset, bytes: core.encoder.encode(String(value)) });
  };
  const declarations = (values) => {
    const offset = reserve(values.length, PAGE.DECLARATION_SIZE);
    values.forEach((value, index) => {
      const record = offset + index * PAGE.DECLARATION_SIZE;
      string(record + PAGE.DECLARATION_PROPERTY, value.property);
      string(record + PAGE.DECLARATION_VALUE, value.value);
      fields.push([record + PAGE.DECLARATION_IMPORTANT, Number(Boolean(value.important))]);
    });
    return offset;
  };
  rules.forEach((rule, index) => {
    const nested = rule.rules ?? [];
    const marginOffset = reserve(nested.length, PAGE.MARGIN_RULE_SIZE);
    const values = rule.declarations ?? [];
    const record = index * PAGE.RULE_SIZE;
    string(record + PAGE.RULE_PRELUDE, rule.prelude);
    fields.push([record + PAGE.RULE_DECLARATIONS, declarations(values)], [record + PAGE.RULE_DECLARATION_COUNT, values.length],
      [record + PAGE.RULE_MARGINS, marginOffset], [record + PAGE.RULE_MARGIN_COUNT, nested.length]);
    nested.forEach((margin, marginIndex) => {
      const values = margin.declarations ?? [];
      const marginRecord = marginOffset + marginIndex * PAGE.MARGIN_RULE_SIZE;
      string(marginRecord + PAGE.MARGIN_RULE_NAME, margin.name);
      fields.push([marginRecord + PAGE.MARGIN_RULE_DECLARATIONS, declarations(values)],
        [marginRecord + PAGE.MARGIN_RULE_DECLARATION_COUNT, values.length]);
    });
  });
  for (const entry of strings) {
    fields.push([entry.offset + TEXT_ROW_POINTER, byteLength], [entry.offset + TEXT_ROW_LENGTH, entry.bytes.length]);
    entry.pointer = byteLength;
    byteLength += entry.bytes.length;
  }
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  for (const [offset, word] of fields) view.setUint32(offset, word, true);
  for (const { pointer, bytes: text } of strings) bytes.set(text, pointer);
  const handle = core.status("scene_page_rules_create", ...core.byteInput(bytes), rules.length);
  const result = { handle };
  ruleFinalizer.register(result, handle, result);
  return result;
}

export function releasePageRules(rules) {
  core.status("scene_page_rules_release", rules.handle);
  ruleFinalizer.unregister(rules);
}

// Pages and their groups carry raw page metadata; native selectors own
// matching.
function pageInput(pages) {
  const bytes = new Uint8Array(pages.length * PAGE.INPUT_SIZE);
  const view = new DataView(bytes.buffer);
  pages.forEach((page, index) => {
    const offset = index * PAGE.INPUT_SIZE;
    const groups = page.groups ?? [];
    const groupBytes = new Uint8Array(groups.length * PAGE.GROUP_SIZE);
    const groupView = new DataView(groupBytes.buffer);
    groups.forEach((group, index) => {
      const [pointer, length] = core.input(group.name);
      const row = index * PAGE.GROUP_SIZE;
      groupView.setUint32(row + PAGE.GROUP_NAME, pointer, true);
      groupView.setUint32(row + PAGE.GROUP_NAME_LENGTH, length, true);
      groupView.setFloat64(row + PAGE.GROUP_POSITION, group.position, true);
    });
    const [name, nameLength] = core.input(page.name);
    const [side, sideLength] = core.input(page.side);
    view.setFloat64(offset + PAGE.INPUT_INDEX, page.index, true);
    view.setUint32(offset + PAGE.INPUT_NAME, name, true);
    view.setUint32(offset + PAGE.INPUT_NAME_LENGTH, nameLength, true);
    view.setUint32(offset + PAGE.INPUT_SIDE, side, true);
    view.setUint32(offset + PAGE.INPUT_SIDE_LENGTH, sideLength, true);
    view.setUint32(offset + PAGE.INPUT_BLANK, Number(Boolean(page.blank)), true);
    view.setUint32(offset + PAGE.INPUT_GROUPS, core.byteInput(groupBytes)[0], true);
    view.setUint32(offset + PAGE.INPUT_GROUP_COUNT, groups.length, true);
  });
  return core.byteInput(bytes)[0];
}

export function pageBox(rules, page, defaultSize) {
  const pointer = core.status("scene_page_box", rules.handle, pageInput([page]), defaultSize.width, defaultSize.height);
  const view = new DataView(core.memory.buffer, pointer, PAGE.GEOMETRY_SIZE);
  const value = (field) => view.getFloat64(PAGE[`GEOMETRY_${field}`], true);
  return {
    width: value("WIDTH"), height: value("HEIGHT"),
    margin: { top: value("MARGIN_TOP"), right: value("MARGIN_RIGHT"), bottom: value("MARGIN_BOTTOM"), left: value("MARGIN_LEFT") },
    area: { x: value("AREA_X"), y: value("AREA_Y"), width: value("AREA_WIDTH"), height: value("AREA_HEIGHT") },
  };
}

export function pageCounters(rules, pages) {
  const pointer = core.status("scene_page_counters", rules.handle, pageInput(pages), pages.length);
  return { values: Array.from(new Float64Array(core.memory.buffer, pointer, pages.length)), pages: pages.length };
}

export function pageMarginBoxes(rules, page, counters, box) {
  const { top, right, bottom, left } = box.margin;
  const margins = core.byteInput(new Uint8Array(new Float64Array([top, right, bottom, left]).buffer))[0];
  const pointer = core.status("scene_page_margin_boxes", rules.handle, pageInput([page]), counters.page, counters.pages, margins);
  const view = new DataView(core.memory.buffer);
  const bytes = core.refreshBytes();
  const string = (offset) => {
    const pointer = view.getUint32(offset + TEXT_ROW_POINTER, true);
    return core.decoder.decode(bytes.subarray(pointer, pointer + view.getUint32(offset + TEXT_ROW_LENGTH, true)));
  };
  return Array.from({ length: core.exports.abi_output_length() / PAGE.MARGIN_BOX_SIZE }, (_, index) => {
    const row = pointer + index * PAGE.MARGIN_BOX_SIZE;
    return { declarations: string(row + PAGE.MARGIN_BOX_DECLARATIONS), content: string(row + PAGE.MARGIN_BOX_CONTENT) };
  });
}
