// The SVG overlay of a render artifact as element operations
// (output_artifact_svg of core/dom/output-artifact-svg.watpart).
import { sharedDomCore as core } from "./dom-wasm/core.js";

import { layoutConstant } from "./wasm/layout-table.js";

// The operation bytes of output_artifact_svg, and its byte of an append
// with a parent.
const OPERATION_NAMES = new Map([
  [layoutConstant("ARTIFACT_SVG_CREATE"), "create"],
  [layoutConstant("ARTIFACT_SVG_SET_ATTRIBUTE"), "set-attribute"],
  [layoutConstant("ARTIFACT_SVG_APPEND"), "append"],
]);
const ARTIFACT_SVG_HAS_PARENT = layoutConstant("ARTIFACT_SVG_HAS_PARENT");

// The artifact's entries in the order output_artifact_svg reads them.
function artifactValues(artifact) {
  const values = [Boolean(artifact?.viewport), artifact?.kind, artifact?.viewport?.width, artifact?.viewport?.height];
  const rectangle = (box) => [box.x, box.y, box.width, box.height];
  if (!artifact?.viewport) return values;
  if (artifact?.kind === "layout") {
    values.push(artifact.boxes.length);
    for (const box of artifact.boxes) values.push(box.nodeIndex, ...rectangle(box.borderBox));
    values.push(artifact.lineBoxes.length);
    for (const line of artifact.lineBoxes) values.push(line.x, line.baseline, line.width, line.nodeIndex);
  } else if (artifact?.kind === "paint") {
    values.push(artifact.boxes.length);
    for (const entry of artifact.boxes) values.push(entry.kind, ...rectangle(entry.box), entry.affine);
  } else if (artifact?.kind === "display-list") {
    values.push(artifact.commands.length);
    for (const command of artifact.commands) {
      const geometry = command.geometry ?? {};
      const clips = command.clipEntries ?? [];
      values.push(command.geometry?.width !== undefined, ...rectangle(geometry), command.commandIndex, command.clipDepth,
        clips.length, ...clips.flatMap(rectangle));
    }
  } else if (artifact?.kind === "invalidation") {
    values.push(artifact.tileMap.length, artifact.columns, artifact.tileSize);
    for (let index = 0; index < artifact.tileMap.length; index++) {
      values.push(index in artifact.tileMap && Boolean(artifact.tileMap[index]));
    }
  }
  return values;
}

export function createArtifactSvgOperations(artifact) {
  core.statusRaw("output_artifact_svg", ...core.valueListInput(artifactValues(artifact)));
  const pointer = core.exports.abi_output_pointer();
  const bytes = core.refreshBytes().slice(pointer, pointer + core.exports.abi_output_length());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  let at = 0;
  const text = () => {
    const length = view.getUint32(at, true);
    const value = decoder.decode(bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
    return value;
  };
  const operations = [];
  while (at < bytes.length) {
    const operation = OPERATION_NAMES.get(bytes[at]);
    if (operation === undefined) throw new Error(`output_artifact_svg wrote unknown operation ${bytes[at]} at byte ${at}`);
    at += 1;
    if (operation === "create") {
      operations.push({ operation, identifier: text(), namespace: text(), name: text() });
    } else if (operation === "set-attribute") {
      operations.push({ operation, identifier: text(), attribute: text(), value: text() });
    } else {
      const parent = bytes[at++] === ARTIFACT_SVG_HAS_PARENT ? text() : null;
      operations.push({ operation, parent, child: text() });
    }
  }
  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

export function applySvgOperations(document, parent, operations) {
  const elements = new Map([[null, parent]]);
  for (const operation of operations) {
    if (operation.operation === "create") {
      elements.set(
        operation.identifier,
        document.createElementNS(operation.namespace, operation.name),
      );
    } else if (operation.operation === "set-attribute") {
      elements.get(operation.identifier).setAttribute(
        operation.attribute,
        operation.value,
      );
    } else if (operation.operation === "set-text") {
      elements.get(operation.identifier).textContent = operation.value;
    } else if (operation.operation === "append") {
      elements.get(operation.parent).appendChild(elements.get(operation.child));
    } else {
      throw new Error(
        `SVG artifact renderer: unknown operation ${operation.operation}`,
      );
    }
  }
  return elements.get(operations[0].identifier);
}
