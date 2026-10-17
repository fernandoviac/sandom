// External SVG paint servers stay in the DOM and use native row lowering.
// Image-local clip definitions become CSS path() authoring input.
import { hostNow } from "../host-clock.js";
import { serializeToScene } from "./serialize.js";
const SVG_NS = "http://www.w3.org/2000/svg";
// The element id that a paint or clip-path value names when the whole value
// is one url(#id), with its escapes decoded by the core's CSS tokenizer.
function referencedElementId(core, text) {
  const value = text?.trim();
  if (!value) return undefined;
  const [token] = core.cssURLs(value);
  if (token?.start !== 0 || token.end !== value.length || !token.url.startsWith("#")) {
    return undefined;
  }
  return token.url.slice(1);
}

const drawable = new Set([
  "rect", "circle", "ellipse", "line", "path", "polygon", "polyline",
]);
const nonRendering = new Set(["title", "desc", "metadata"]);
const referenceProperties = ["filter", "mask"];

function value(element, name) {
  const attribute = element.getAttribute(name);
  if (attribute !== null) return attribute;
  const style = element.getAttribute("style");
  if (!style) return null;
  return style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))
    ?.[1]?.trim() ?? null;
}

function svgLength(raw, fallback) {
  if (raw === null) return fallback;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%)?$/i.test(text)) {
    throw new Error(`Unsupported SVG length ${raw}`);
  }
  const parsed = Number.parseFloat(text);
  return text.endsWith("%") ? `${parsed}%` : parsed;
}

function svgMatrix(raw, kind = "gradient") {
  let matrix = [1, 0, 0, 1, 0, 0];
  if (!raw) return matrix;
  const transforms = raw.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g);
  let cursor = 0;
  for (const match of transforms) {
    if (!/^[\s,]*$/.test(raw.slice(cursor, match.index))) {
      throw new Error(`Unsupported SVG ${kind} transform ${raw}`);
    }
    cursor = match.index + match[0].length;
    const values = match[2].trim()
      ? match[2].trim().split(/[\s,]+/).map(Number)
      : [];
    if (values.some((number) => !Number.isFinite(number))) {
      throw new Error(`Invalid SVG ${kind} transform ${raw}`);
    }
    let next;
    switch (match[1]) {
      case "matrix":
        if (values.length !== 6) throw new Error(`Invalid SVG ${kind} matrix ${raw}`);
        next = values;
        break;
      case "translate":
        if (values.length < 1 || values.length > 2) {
          throw new Error(`Invalid SVG ${kind} translate ${raw}`);
        }
        next = [1, 0, 0, 1, values[0], values[1] ?? 0];
        break;
      case "scale":
        if (values.length < 1 || values.length > 2) {
          throw new Error(`Invalid SVG ${kind} scale ${raw}`);
        }
        next = [values[0], 0, 0, values[1] ?? values[0], 0, 0];
        break;
      case "rotate": {
        if (values.length !== 1 && values.length !== 3) {
          throw new Error(`Invalid SVG ${kind} rotate ${raw}`);
        }
        const angle = values[0] * Math.PI / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const x = values[1] ?? 0, y = values[2] ?? 0;
        next = [cos, sin, -sin, cos,
          x - cos * x + sin * y, y - sin * x - cos * y];
        break;
      }
      case "skewX":
      case "skewY":
        if (values.length !== 1) throw new Error(`Invalid SVG ${kind} ${match[1]} ${raw}`);
        next = match[1] === "skewX"
          ? [1, 0, Math.tan(values[0] * Math.PI / 180), 1, 0, 0]
          : [1, Math.tan(values[0] * Math.PI / 180), 0, 1, 0, 0];
        break;
      default:
        throw new Error(`Unsupported SVG ${kind} transform ${match[1]}`);
    }
    const [a, b, c, d, e, f] = matrix;
    const [g, h, i, j, k, l] = next;
    matrix = [
      a * g + c * h, b * g + d * h,
      a * i + c * j, b * i + d * j,
      a * k + c * l + e, b * k + d * l + f,
    ];
  }
  if (!/^[\s,]*$/.test(raw.slice(cursor))) {
    throw new Error(`Unsupported SVG ${kind} transform ${raw}`);
  }
  return matrix;
}

const identity = [1, 0, 0, 1, 0, 0];

function multiply(outer, inner) {
  const [a, b, c, d, e, f] = outer;
  const [g, h, i, j, k, l] = inner;
  return [a * g + c * h, b * g + d * h,
    a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f];
}

// Bake definition-only transforms into the clip geometry; the referenced
// element's own transform remains on its scene node, shared by ink and clip.
function transformPath(path, matrix, locator) {
  if (matrix.every((number, index) => number === identity[index])) return path;
  const [a, b, c, d, e, f] = matrix;
  const point = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const tokens = path.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  if (path.replace(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[\s,]/gi, "")) {
    throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
  }
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const out = [];
  let command = null, x = 0, y = 0, startX = 0, startY = 0, index = 0;
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index])) {
      command = tokens[index++];
      if (!(command.toUpperCase() in counts)) {
        throw new Error(`SVG image ${locator}: unsupported clip path command ${command}`);
      }
      if (command.toUpperCase() === "Z") {
        out.push("Z");
        x = startX;
        y = startY;
        command = null;
        continue;
      }
    }
    if (!command) throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
    const kind = command.toUpperCase();
    const count = counts[kind];
    const params = tokens.slice(index, index + count).map(Number);
    if (params.length !== count || params.some((n) => !Number.isFinite(n))) {
      throw new Error(`SVG image ${locator}: invalid clip path ${path}`);
    }
    index += count;
    const ox = command === kind ? 0 : x, oy = command === kind ? 0 : y;
    if (kind === "H") {
      x = ox + params[0];
      out.push("L", ...point(x, y));
    } else if (kind === "V") {
      y = oy + params[0];
      out.push("L", ...point(x, y));
    } else if (kind === "A") {
      if (b !== 0 || c !== 0 || a === 0 || d === 0 ||
        (Math.abs(a) !== Math.abs(d) && params[2] % 180 !== 0)) {
        throw new Error(`SVG image ${locator}: unsupported transformed clip arc`);
      }
      x = ox + params[5];
      y = oy + params[6];
      out.push("A", Math.abs(a) * params[0], Math.abs(d) * params[1],
        a * d < 0 ? -params[2] : params[2], params[3],
        a * d < 0 ? 1 - params[4] : params[4], ...point(x, y));
    } else {
      const converted = [];
      for (let k = 0; k < count; k += 2) {
        converted.push(...point(ox + params[k], oy + params[k + 1]));
      }
      x = ox + params.at(-2);
      y = oy + params.at(-1);
      out.push(kind, ...converted);
      if (kind === "M") {
        startX = x;
        startY = y;
        command = command === kind ? "L" : "l";
      }
    }
  }
  return out.join(" ");
}

function clipGeometry(element, locator, units) {
  const numeric = (name, fallback = 0) => {
    const length = svgLength(element.getAttribute(name), fallback);
    if (typeof length === "string") {
      if (units === "objectBoundingBox") return Number.parseFloat(length) / 100;
      throw new Error(`SVG image ${locator}: unsupported percentage clip geometry ${name}`);
    }
    return length;
  };
  switch (element.localName) {
    case "path":
      return element.getAttribute("d") ?? "";
    case "rect": {
      if (element.hasAttribute("rx") || element.hasAttribute("ry")) {
        throw new Error(`SVG image ${locator}: unsupported rounded clip rect`);
      }
      const x = numeric("x"), y = numeric("y");
      const w = numeric("width"), h = numeric("height");
      return `M${x} ${y}h${w}v${h}h${-w}Z`;
    }
    case "circle":
    case "ellipse": {
      const cx = numeric("cx"), cy = numeric("cy");
      const rx = numeric(element.localName === "circle" ? "r" : "rx");
      const ry = element.localName === "circle" ? rx : numeric("ry");
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "polygon":
    case "polyline": {
      const raw = element.getAttribute("points") ?? "";
      const points = raw.trim().split(/[\s,]+/).map(Number);
      if (points.length < 4 || points.length % 2 || points.some((n) => !Number.isFinite(n))) {
        throw new Error(`SVG image ${locator}: invalid clip points ${raw}`);
      }
      let d = `M${points[0]} ${points[1]}`;
      for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
      return d + "Z";
    }
    default:
      throw new Error(`SVG image ${locator}: unsupported clip child ${element.localName}`);
  }
}

function clipDefinition(element, locator) {
  if (element.hasAttribute("href") || element.hasAttribute("xlink:href")) {
    throw new Error(`SVG image ${locator}: unsupported clipPath href`);
  }
  const units = element.getAttribute("clipPathUnits") ?? "userSpaceOnUse";
  if (units !== "userSpaceOnUse" && units !== "objectBoundingBox") {
    throw new Error(`SVG image ${locator}: unsupported clipPathUnits ${units}`);
  }
  const paths = [];
  let fillRule = null;
  function collect(node, matrix, inheritedRule) {
    const transformed = multiply(matrix, svgMatrix(node.getAttribute("transform"), "clip"));
    const groupRule = value(node, "clip-rule") ?? inheritedRule;
    for (const child of node.children) {
      if (child.namespaceURI !== SVG_NS) {
        throw new Error(`SVG image ${locator}: unsupported clip child ${child.localName}`);
      }
      if (child.localName === "g") {
        collect(child, transformed, groupRule);
        continue;
      }
      const rule = value(child, "clip-rule") ?? groupRule;
      if (rule !== "nonzero" && rule !== "evenodd") {
        throw new Error(`SVG image ${locator}: unsupported clip-rule ${rule}`);
      }
      if (fillRule !== null && fillRule !== rule) {
        throw new Error(`SVG image ${locator}: mixed clip-rule in clipPath`);
      }
      fillRule = rule;
      paths.push(transformPath(clipGeometry(child, locator, units),
        multiply(transformed, svgMatrix(child.getAttribute("transform"), "clip")), locator));
    }
  }
  collect(element, identity, "nonzero");
  if (paths.length > 1) {
    throw new Error(`SVG image ${locator}: unsupported multi-shape clipPath`);
  }
  return { units, d: paths.join(" "), fillRule: fillRule ?? "nonzero" };
}


export function shapeBounds(element, node) {
  const number = (name, fallback = 0) => {
    const raw = element.getAttribute(name);
    const length = svgLength(raw, fallback);
    if (typeof length !== "number") {
      throw new Error(`Percentage SVG geometry needs a resolved viewport: ${name}=${raw}`);
    }
    return length;
  };
  switch (element.localName) {
    case "rect": {
      const x = number("x"), y = number("y");
      return { xMin: x, yMin: y, xMax: x + number("width"), yMax: y + number("height") };
    }
    case "circle": {
      const cx = number("cx"), cy = number("cy"), r = number("r");
      return { xMin: cx - r, yMin: cy - r, xMax: cx + r, yMax: cy + r };
    }
    case "ellipse": {
      const cx = number("cx"), cy = number("cy");
      const rx = number("rx"), ry = number("ry");
      return { xMin: cx - rx, yMin: cy - ry, xMax: cx + rx, yMax: cy + ry };
    }
    case "line": {
      const x1 = number("x1"), y1 = number("y1"), x2 = number("x2"), y2 = number("y2");
      return { xMin: Math.min(x1, x2), yMin: Math.min(y1, y2), xMax: Math.max(x1, x2), yMax: Math.max(y1, y2) };
    }
    default:
      if (!node.d) throw new Error(`SVG ${element.localName} has no path geometry`);
      return null;
  }
}


async function pathBoundsFor(pathDef, fillRule, runtime, cache, timings) {
  const key = `${fillRule}\0${pathDef}`;
  let bounds = cache.get(key);
  if (bounds) return bounds;
  const startedAt = timings ? hostNow() : 0;
  bounds = await runtime.sharedSvgPathAtlas.measurePathBounds(pathDef, fillRule);
  if (timings) {
    timings.pathPreparationMilliseconds += hostNow() - startedAt;
  }
  cache.set(key, bounds);
  return bounds;
}

async function clipTargetBounds(element, serialized, runtime, cache, locator, timings) {
  if (element.localName === "g") {
    let bounds = null;
    for (const child of element.children) {
      const childBounds = await clipTargetBounds(
        child, serialized, runtime, cache, locator, timings,
      );
      if (!childBounds) continue;
      const [a, b, c, d, e, f] = svgMatrix(child.getAttribute("transform"), "clip target");
      if (b !== 0 || c !== 0) {
        throw new Error(`SVG image ${locator}: unsupported rotated objectBoundingBox clip target`);
      }
      const x1 = a * childBounds.xMin + e, x2 = a * childBounds.xMax + e;
      const y1 = d * childBounds.yMin + f, y2 = d * childBounds.yMax + f;
      const part = {
        xMin: Math.min(x1, x2), xMax: Math.max(x1, x2),
        yMin: Math.min(y1, y2), yMax: Math.max(y1, y2),
      };
      bounds = bounds === null ? part : {
        xMin: Math.min(bounds.xMin, part.xMin),
        yMin: Math.min(bounds.yMin, part.yMin),
        xMax: Math.max(bounds.xMax, part.xMax),
        yMax: Math.max(bounds.yMax, part.yMax),
      };
    }
    return bounds;
  }
  const index = serialized.indexOf.get(element);
  if (index == null || !drawable.has(element.localName)) {
    throw new Error(`SVG image ${locator}: unsupported objectBoundingBox clip target ${element.localName}`);
  }
  const node = serialized.nodes[index];
  return shapeBounds(element, node) ?? await pathBoundsFor(
    node.d, node._coreSvgRequest?.fillRule ?? "nonzero",
    runtime, cache, timings);
}


export function prepareSvgImageDefinitions(root, core, locator, timings = null) {
  const clips = new Map();
  const remove = [];
  function collect(element) {
    if (element.localName === "clipPath" && element.namespaceURI === SVG_NS) {
      const id = element.getAttribute("id");
      if (id && !clips.has(id)) clips.set(id, element);
      remove.push(element);
      return;
    }
    if (nonRendering.has(element.localName) && element.namespaceURI === SVG_NS) {
      remove.push(element);
      return;
    }
    for (const child of element.children) collect(child);
  }
  collect(root);
  for (const element of remove) element.parentNode.removeChild(element);

  const clipped = new Map();
  const resolvedClips = new Map();
  function visit(element) {
    for (const name of referenceProperties) {
      const property = value(element, name);
      if (property?.includes("url(")) {
        throw new Error(`SVG image ${locator}: unsupported ${name} ${property}`);
      }
    }
    const clip = value(element, "clip-path");
    if (clip && clip !== "none") {
      const id = referencedElementId(core, clip);
      if (!id) throw new Error(`SVG image ${locator}: unsupported clip-path ${clip}`);
      const definition = clips.get(id);
      if (!definition) {
        throw new Error(`SVG image ${locator}: unresolved clip-path #${id}`);
      }
      let resolved = resolvedClips.get(id);
      if (!resolved) {
        resolved = clipDefinition(definition, locator);
        resolvedClips.set(id, resolved);
      }
      clipped.set(element, resolved);
    }
    for (const child of element.children) visit(child);
  }
  visit(root);
  const pathBounds = new Map();
  return async (serialized, runtime) => {
    if (clipped.size === 0) return serialized;
    try {
      for (const [element, clip] of clipped) {
        if (serialized.indexOf.get(element) == null ||
            element.localName !== "g" && !drawable.has(element.localName)) {
          throw new Error(`SVG image ${locator}: unpaintable clipped ${element.localName}`);
        }
        let matrix = identity;
        if (clip.units === "objectBoundingBox") {
          const bounds = await clipTargetBounds(
            element, serialized, runtime, pathBounds, locator, timings,
          );
          if (!bounds || !(bounds.xMax > bounds.xMin && bounds.yMax > bounds.yMin)) {
            throw new Error(`SVG image ${locator}: objectBoundingBox clip requires positive target bounds`);
          }
          matrix = [bounds.xMax - bounds.xMin, 0, 0, bounds.yMax - bounds.yMin,
            bounds.xMin, bounds.yMin];
        }
        const path = transformPath(clip.d, matrix, locator);
        if (!path.trim()) {
          throw new Error(`SVG image ${locator}: empty clip-path definition`);
        }
        element.style.setProperty("clip-path", `path(${clip.fillRule}, ${JSON.stringify(path)})`);
      }
      return serializeToScene(root);
    } finally {
      serialized.release();
    }
  };
}
