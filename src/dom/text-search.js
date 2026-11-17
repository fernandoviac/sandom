// Text search over a document's rendered text, for ::search-text matches
// and ::target-text directives. The text is the data of the text nodes in
// tree order, without the subtrees that render no text (display: none,
// scripts, styles, templates); a block-level box breaks it, so a match
// stays within one block's run of inline content.

const UNRENDERED = new Set(["script", "style", "template", "noscript", "title", "head"]);

// { text, segments }: each segment is a text node and the offset of its
// first character in text; "\n" separates the runs of two blocks.
function documentText(document) {
  let text = "";
  const segments = [];
  const blockBreak = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      segments.push({ node, start: text.length });
      text += node.data;
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    let block = false;
    if (node.nodeType === 1) {
      if (UNRENDERED.has(node.localName)) return;
      const display = document.getComputedStyle(node).display;
      if (display === "none") return;
      block = !display.startsWith("inline") && display !== "contents" && !display.startsWith("ruby");
    }
    if (block) blockBreak();
    for (const child of node.childNodes) visit(child);
    if (block) blockBreak();
  };
  visit(document.documentElement ?? document);
  return { text, segments };
}

// The text node and offset of position $position, at the end of the
// segment before it when $end is set.
function boundaryAt(segments, position, end) {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const start = segments[middle].start;
    if (end ? start < position : start <= position) low = middle;
    else high = middle - 1;
  }
  const segment = segments[low];
  return [segment.node, position - segment.start];
}

function rangeOf(document, segments, start, end) {
  const range = document.createRange();
  const [startNode, startOffset] = boundaryAt(segments, start, false);
  const [endNode, endOffset] = boundaryAt(segments, end, true);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

// A copy of $text compared ASCII and Unicode case-insensitively where
// lowercasing keeps its length, so positions still map to the text.
function folded(text, caseSensitive) {
  if (caseSensitive) return text;
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

// Every match of $query in the document's text, in order, as Ranges.
export function searchRanges(document, query, caseSensitive) {
  const { text, segments } = documentText(document);
  const haystack = folded(text, caseSensitive);
  const needle = folded(query, caseSensitive);
  const ranges = [];
  for (let at = haystack.indexOf(needle); at >= 0 && needle !== ""; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push(rangeOf(document, segments, at, at + needle.length));
  }
  return ranges;
}

// The first match of a text directive (URL Fragment Text Directives §3.3):
// "text=" with "prefix-," before and ",-suffix" after an optional end, the
// parts percent-encoded and matched case-insensitively, the prefix and the
// suffix next to the match across white space. Returns a Range or null.
export function findTextDirective(document, directive) {
  const body = directive.startsWith("text=") ? directive.slice(5) : directive;
  const parts = body.split(",");
  let prefix = null;
  let suffix = null;
  if (parts.length > 1 && parts[0].endsWith("-")) prefix = decodeURIComponent(parts.shift().slice(0, -1));
  if (parts.length > 1 && parts.at(-1).startsWith("-")) suffix = decodeURIComponent(parts.pop().slice(1));
  if (parts.length === 0 || parts.length > 2) return null;
  const [start, end] = parts.map((part) => folded(decodeURIComponent(part), false));
  if (start === "") return null;
  const { text, segments } = documentText(document);
  const haystack = folded(text, false);
  const before = prefix === null ? null : folded(prefix, false);
  const after = suffix === null ? null : folded(suffix, false);
  for (let at = haystack.indexOf(start); at >= 0; at = haystack.indexOf(start, at + 1)) {
    if (before !== null && !haystack.slice(0, at).trimEnd().endsWith(before)) continue;
    let finish = at + start.length;
    if (end !== undefined) {
      const endAt = haystack.indexOf(end, finish);
      if (endAt < 0) return null;
      finish = endAt + end.length;
    }
    if (after !== null && !haystack.slice(finish).trimStart().startsWith(after)) continue;
    return rangeOf(document, segments, at, finish);
  }
  return null;
}
