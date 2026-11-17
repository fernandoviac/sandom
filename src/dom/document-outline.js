// The document outline of `root` (CSS Generated Content 3 §3) from the
// core's current styles: an entry for each rendered element whose
// bookmark-level is an integer, in tree order, nested by level. An entry
// holds the following entries of a greater level, up to the next entry of
// its level or less. Each entry is { level, label, state, element,
// children }; `element` is the wrapper the core gives the element.
export function readDocumentOutline(root) {
  const core = root._domCore;
  const count = core.status("document_outline_build", root._coreHandle);
  const entries = [];
  for (let index = 0; index < count; index++) {
    entries.push({
      level: core.status("document_outline_level", index),
      label: core.string("document_outline_label", index) ?? "",
      state: core.status("document_outline_closed", index) ? "closed" : "open",
      handle: core.status("document_outline_element", index),
    });
  }
  const outline = [];
  const open = [];
  for (const { level, label, state, handle } of entries) {
    const entry = { level, label, state, element: core.wrapperFor(handle), children: [] };
    while (open.length > 0 && open.at(-1).level >= level) open.pop();
    (open.length > 0 ? open.at(-1).children : outline).push(entry);
    open.push(entry);
  }
  return outline;
}
