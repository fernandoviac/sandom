export { createSandomRuntime } from "../scene-renderer.js";
export {
  defineSandomInteractiveRenderer,
  SandomInteractiveRendererElement,
} from "./interactive-renderer-element.js";
export { createDocumentSession, DocumentSession } from "./document-session.js";
export { createRenderSurface } from "./render-surface.js";
export { renderComponent } from "./render-component.js";
export { recommendMotionCapture } from "./motion-capture-recommendation.js";
export {
  planAutomaticViewport,
  renderInput,
  RenderPlanningError,
} from "./render-planning.js";
export { renderInBrowserWorker } from "./browser-render-client.js";
export {
  BROWSER_RENDER_ERROR_KIND,
  BROWSER_RENDER_PROTOCOL_VERSION,
  BROWSER_RENDER_READY_KIND,
  BROWSER_RENDER_REQUEST_KIND,
  BROWSER_RENDER_RESULT_KIND,
} from "./browser-render-worker-protocol.js";
export {
  installBrowserRenderWorker,
  renderBrowserWorkerRequest,
} from "./browser-render-worker-runtime.js";
export { createInputWindow, evaluateComponentModule } from "./input-preprocessors.js";
export { DOMParser, SDDocument as SandomDocument } from "./node.js";
export { createSandomDOM } from "./sandom-dom.js";
export { caretRectangle, selectionRectangles } from "./geometry.js";
// Public Sandom DOM facade. This module owns document construction,
// interaction, layout inspection, rendering surfaces, and render planning.
// Product adapters belong in separate modules.

import { DOMParser } from "./node.js";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "./live-geometry.js";
import { serializeToScene, unsuppliedFontFaceMessage } from "./serialize.js";
import { createLayoutArtifact } from "../scene-renderer.js";
import { CSSKeyframesRule } from "./stylesheet.js";

export async function inspectHTML(source, {
  viewportW = DEFAULT_VIEWPORT_WIDTH,
  viewportH = DEFAULT_VIEWPORT_HEIGHT,
  layout = false,
} = {}) {
  const document = new DOMParser().parseFromString(String(source), "text/html");
  const nodes = [];
  const domNodes = [];
  const pending = [{
    node: document.documentElement,
    parentIndex: null,
  }];
  let pendingIndex = 0;
  const resourceReferences = [];

  while (pendingIndex < pending.length) {
    const { node, parentIndex } = pending[pendingIndex++];
    const index = nodes.length;
    const record = {
      index,
      parentIndex,
      type: node.nodeType === 1
        ? "element"
        : node.nodeType === 3
        ? "text"
        : node.nodeType === 8
        ? "comment"
        : "other",
      name: node.nodeName,
      children: [],
    };
    if (node.nodeType === 1) {
      record.attributes = Object.fromEntries(node.getAttributeNames().map((name) => [name, node.getAttribute(name)]));
      for (
        const [attribute, kind] of [
          ["src", node.localName === "script" ? "script" : "image"],
          ["href", node.localName === "link" ? "stylesheet" : "link"],
        ]
      ) {
        const value = node.getAttribute(attribute);
        if (value !== null) {
          resourceReferences.push(Object.freeze({
            kind,
            url: value,
            source: "attribute",
            nodeIndex: index,
          }));
        }
      }
    } else if (node.nodeType === 3 || node.nodeType === 8) {
      record.text = node.data;
    }
    nodes.push(record);
    domNodes.push(node);
    if (parentIndex !== null) nodes[parentIndex].children.push(index);
    for (const child of node.childNodes) {
      pending.push({ node: child, parentIndex: index });
    }
  }

  const styleSheets = [...document.styleSheets];
  let keyframeRuleCount = 0;
  const styleDiagnostics = [];
  for (const styleSheet of styleSheets) {
    styleDiagnostics.push(...styleSheet.diagnostics);
    const rules = [...styleSheet._ruleList()];
    while (rules.length > 0) {
      const rule = rules.pop();
      if (rule instanceof CSSKeyframesRule) keyframeRuleCount++;
      if (rule.cssRules) rules.push(...rule.cssRules);
    }
  }
  let layoutRecord = null;
  if (layout) {
    const serialized = serializeToScene(document.documentElement, {
      viewportWidth: viewportW,
      viewportHeight: viewportH,
    });
    const artifact = await createLayoutArtifact({
      width: viewportW,
      height: viewportH,
      nodes: serialized.nodes,
      imageSources: serialized.imageSources,
    });
    layoutRecord = Object.freeze({
      boxes: Object.freeze(nodes.flatMap((node, index) => {
        const boxIndex = serialized.indexOf.get(domNodes[index]);
        const box = boxIndex === undefined
          ? undefined
          : artifact.boxes[boxIndex];
        return box === undefined ? [] : [Object.freeze({
          nodeIndex: node.index,
          x: box.borderBox.x,
          y: box.borderBox.y,
          width: box.borderBox.width,
          height: box.borderBox.height,
          scrollWidth: box.scroll.width,
          scrollHeight: box.scroll.height,
        })];
      })),
    });
  }
  const fontDiagnostics = unsuppliedFontDiagnostics(document, domNodes);

  return Object.freeze({
    kind: "html-inspection",
    version: 1,
    document: Object.freeze({
      title: document.title,
      language: document.documentElement.getAttribute("lang") ?? "",
      compatibilityMode: document.compatMode,
      scripts: Object.freeze({
        count: document.querySelectorAll("script").length,
        execution: "inert",
      }),
    }),
    viewport: Object.freeze({ width: viewportW, height: viewportH }),
    tree: Object.freeze({
      root: 0,
      nodes: Object.freeze(nodes.map((node) =>
        Object.freeze({
          ...node,
          attributes: node.attributes === undefined
            ? undefined
            : Object.freeze(node.attributes),
          children: Object.freeze(node.children),
        })
      )),
    }),
    styles: Object.freeze({
      styleSheetCount: styleSheets.length,
      keyframeRuleCount,
      diagnostics: Object.freeze(styleDiagnostics),
    }),
    resources: Object.freeze({
      references: Object.freeze(resourceReferences),
    }),
    layout: layoutRecord,
    diagnostics: Object.freeze(fontDiagnostics),
  });
}

// The font-family lists of the document that no face can draw, each once,
// with the first element in document order whose text needs it. The lists
// resolve against the registry the document renders with, as a render
// does: the first family of the list with a face, else the face of the
// initial family. A render of such a list throws the same message.
function unsuppliedFontDiagnostics(document, domNodes) {
  const registry = document._sandomFontRegistry;
  const nodeIndices = new Map(domNodes.map((node, index) => [node, index]));
  const hasFace = (key) => {
    try {
      return registry.fontFileFor(key, 400) !== null;
    } catch {
      return false;
    }
  };
  const keysOf = (list) => {
    try {
      return registry.fontStackKeysForCssValue(list, { document });
    } catch {
      return [];
    }
  };
  const initialHasFace = keysOf("sans-serif").some(hasFace);
  const checked = new Set();
  const diagnostics = [];
  for (const element of document.querySelectorAll("*")) {
    const drawsText = [...element.childNodes].some((child) => child.nodeType === 3 && child.data.trim() !== "");
    if (!drawsText) continue;
    // Text inside display: none (the head, a hidden subtree) draws nothing.
    let hidden = false;
    for (let node = element; node !== null && !hidden; node = node.parentElement) {
      hidden = document.getComputedStyle(node).display === "none";
    }
    if (hidden) continue;
    const family = document.getComputedStyle(element).fontFamily;
    if (checked.has(family)) continue;
    checked.add(family);
    if (initialHasFace || keysOf(family).some(hasFace)) continue;
    diagnostics.push(Object.freeze({
      code: "font-face-unsupplied",
      severity: "error",
      recoverable: false,
      message: unsuppliedFontFaceMessage(family, element),
      fontFamily: family,
      nodeIndex: nodeIndices.get(element),
    }));
  }
  return diagnostics;
}
