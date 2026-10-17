// Immutable @page rule resources. The core owns selector compilation,
// declaration cascade, page geometry, counters, and margin-box content.
import { sharedDomCore as core } from "../dom-wasm/core.js";

const ruleFinalizer = new FinalizationRegistry((handle) => {
  core.status("scene_page_rules_release", handle);
});

// Rule32, Margin16, Declaration24. String and record references are offsets
// into this slab; the native resource copies it before the call returns.
export function parsePageRules(rules) {
  let byteLength = rules.length * 32;
  const records = [];
  const strings = [];
  const reserve = (count, size) => {
    const offset = byteLength;
    byteLength += count * size;
    return offset;
  };
  const string = (record, offset, value) => {
    strings.push({ record, offset, bytes: core.encoder.encode(String(value)) });
  };
  const declarations = (values) => {
    const offset = reserve(values.length, 24);
    values.forEach((value, index) => {
      const record = { offset: offset + index * 24, words: [0, 0, 0, 0, Number(Boolean(value.important)), 0] };
      string(record, 0, value.property);
      string(record, 8, value.value);
      records.push(record);
    });
    return offset;
  };
  rules.forEach((rule, index) => {
    const nested = rule.rules ?? [];
    const marginOffset = reserve(nested.length, 16);
    const values = rule.declarations ?? [];
    const record = { offset: index * 32, words: [0, 0, declarations(values), values.length, marginOffset, nested.length, 0, 0] };
    string(record, 0, rule.prelude);
    records.push(record);
    nested.forEach((margin, marginIndex) => {
      const values = margin.declarations ?? [];
      const record = { offset: marginOffset + marginIndex * 16, words: [0, 0, declarations(values), values.length] };
      string(record, 0, margin.name);
      records.push(record);
    });
  });
  for (const entry of strings) {
    entry.pointer = byteLength;
    entry.record.words[entry.offset / 4] = byteLength;
    entry.record.words[entry.offset / 4 + 1] = entry.bytes.length;
    byteLength += entry.bytes.length;
  }
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  for (const { offset, words } of records) {
    words.forEach((word, index) => view.setUint32(offset + index * 4, word, true));
  }
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

// Page40 and Group16 carry raw page metadata; native selectors own matching.
function pageInput(pages) {
  const bytes = new Uint8Array(pages.length * 40);
  const view = new DataView(bytes.buffer);
  pages.forEach((page, index) => {
    const offset = index * 40;
    const groups = page.groups ?? [];
    const groupBytes = new Uint8Array(groups.length * 16);
    const groupView = new DataView(groupBytes.buffer);
    groups.forEach((group, index) => {
      const [pointer, length] = core.input(group.name);
      groupView.setUint32(index * 16, pointer, true);
      groupView.setUint32(index * 16 + 4, length, true);
      groupView.setFloat64(index * 16 + 8, group.position, true);
    });
    const [name, nameLength] = core.input(page.name);
    const [side, sideLength] = core.input(page.side);
    view.setFloat64(offset, page.index, true);
    view.setUint32(offset + 8, name, true);
    view.setUint32(offset + 12, nameLength, true);
    view.setUint32(offset + 16, side, true);
    view.setUint32(offset + 20, sideLength, true);
    view.setUint32(offset + 24, Number(Boolean(page.blank)), true);
    view.setUint32(offset + 28, core.byteInput(groupBytes)[0], true);
    view.setUint32(offset + 32, groups.length, true);
  });
  return core.byteInput(bytes)[0];
}

export function pageBox(rules, page, defaultSize) {
  const pointer = core.status("scene_page_box", rules.handle, pageInput([page]), defaultSize.width, defaultSize.height);
  const values = new Float64Array(core.memory.buffer, pointer, 10);
  return {
    width: values[0], height: values[1],
    margin: { top: values[2], right: values[3], bottom: values[4], left: values[5] },
    area: { x: values[6], y: values[7], width: values[8], height: values[9] },
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
    const pointer = view.getUint32(offset, true);
    return core.decoder.decode(bytes.subarray(pointer, pointer + view.getUint32(offset + 4, true)));
  };
  return Array.from({ length: core.exports.abi_output_length() / 16 }, (_, index) => ({
    declarations: string(pointer + index * 16), content: string(pointer + index * 16 + 8),
  }));
}
