// The captures of a live document that a document session and a component
// session share: its layout world, its structure, metrics, and paint
// records (src/dom/native-projections.js, metrics-projection.js,
// paint-projection.js), and its rasters. `identify(node)` gives a node's
// stable identifier in the caller's session; `onRelease(record)` tells the
// caller that it no longer owns a released record.
import { inspectDocumentLayout, inspectDocumentPaint } from "./render-animation.js";
import { prepareSceneDocument, publishSceneRecords, serializeToScene } from "./serialize.js";
import { captureStructure } from "./native-projections.js";
import { captureMetrics, loadMetrics } from "./metrics-projection.js";
import { selectPaintRecord } from "./paint-projection.js";
import { createRenderSurface } from "./render-surface.js";
import { copyTextureImageInto, readbackTextureImage } from "../rasterize.js";

// The layout of `root` in `environment`, each layout node joined to the
// identifier of its element (null for an anonymous box), and its scene.
export async function inspectDocumentWorld(root, environment, { scrollbarStyle, identify }) {
  const inspectedLayout = await inspectDocumentLayout(root, environment, { scrollbarStyle });
  const serialized = serializeToScene(root, {
    viewportWidth: environment.width,
    viewportHeight: environment.height,
  });
  const elementsByIndex = new Map([...serialized.indexOf].map(([element, index]) => [index, element]));
  return {
    layout: Object.freeze({
      ...inspectedLayout,
      nodes: Object.freeze(inspectedLayout.nodes.map((node, index) =>
        Object.freeze({
          ...node,
          nodeIdentifier: elementsByIndex.has(index) ? identify(elementsByIndex.get(index)) : null,
        })
      )),
    }),
    scene: Object.freeze({
      width: serialized.width,
      height: serialized.height,
      nodes: Object.freeze(serialized.nodes),
    }),
  };
}

// The structure record of `document`, or of the subtree of `root`.
export function captureDocumentStructure(document, { root, instance, revision, environment, onRelease }) {
  prepareSceneDocument(document.documentElement, {
    viewportWidth: environment.width,
    viewportHeight: environment.height,
  });
  return captureStructure(document, {
    selected: root,
    instance,
    revision,
    environment,
    publish: publishSceneRecords,
    onRelease,
  });
}

// The layer metrics record of `selectedNodes` and their subtrees: their
// border boxes from `world` and their text chunks from the paint command
// record of the document in `world.environment`.
export async function captureDocumentMetrics(document, {
  selectedNodes,
  world,
  sizingSource,
  scrollbarStyle,
  identify,
  onRelease,
}) {
  // The report nodes: each selected node and its subtree, in tree order.
  const orderedNodes = [];
  const reportIndex = new Map();
  const visit = (node) => {
    if (reportIndex.has(node)) return;
    reportIndex.set(node, orderedNodes.length);
    orderedNodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  for (const selectedNode of selectedNodes) visit(selectedNode);
  const boxByIdentifier = new Map(
    world.layout.nodes
      .filter((node) => node.nodeIdentifier !== null)
      .map((node) => [node.nodeIdentifier, node.borderBox]),
  );
  const paint = await inspectDocumentPaint(document.documentElement, world.environment, { scrollbarStyle });
  try {
    return captureMetrics(document._domCore, {
      nodes: orderedNodes.map((node) => {
        const identifier = identify(node);
        return {
          identifier,
          childIndices: [...node.childNodes].map((child) => reportIndex.get(child)),
          rectangle: boxByIdentifier.get(identifier) ?? null,
        };
      }),
      selection: selectedNodes.map((node) => reportIndex.get(node)),
      sceneNodes: paint.elementAtIndex.map((node) => reportIndex.get(node) ?? -1),
      paint: paint.paintArtifact,
      sizingSource,
      worldKey: world.key,
      viewport: world.environment,
      onRelease,
    });
  } finally {
    paint.paintArtifact.release();
  }
}

// A metrics record of `document`'s core loaded from `bytes` (a metrics
// record's bytes()), as a capture that compareObservations takes. Its
// provenance names the bytes; loaded bytes have no revision, selection, or
// environment of this session.
export function loadDocumentMetrics(document, bytes, { onRelease }) {
  const artifact = loadMetrics(document._domCore, bytes, { onRelease });
  return Object.freeze({
    artifact,
    provenance: Object.freeze({ kind: "metrics", source: "bytes", byteLength: bytes.length }),
  });
}

// The paint command record of `document` in `environment`, or of the
// subtree of `root`: the core builds the subtree's record.
export async function captureDocumentPaint(document, { root, environment, scrollbarStyle, identify }) {
  const inspection = await inspectDocumentPaint(document.documentElement, environment, { scrollbarStyle });
  if (root === null) return inspection.paintArtifact;
  try {
    const sceneRow = inspection.elementAtIndex.indexOf(root);
    if (sceneRow < 0) {
      throw new RangeError(`The selected node ${identify(root)} has no scene row: it renders nothing.`);
    }
    return selectPaintRecord(inspection.paintArtifact, [sceneRow]);
  } finally {
    inspection.paintArtifact.release();
  }
}

// A raster of `document`, of the subtree of `root`, or of the paint group
// `layer`, at `placement` ({ rectangle, backdrop, offset }) in
// `environment`. The raster uses the surface registered for the document
// element at that environment (one root has one surface per environment),
// else the one `surfaces` (environment key to surface, owned by the caller)
// holds, else a new one that it adds there. It stops the surface, sets its
// selection, world rectangle, and backdrop for one frame, and restores
// them. A null rectangle is the root's border box, or the viewport for the
// document and for a layer. The artifact holds the frame's GPU texture
// (pixels on WebGL 2); it stays readable until the surface's next frame.
export async function captureDocumentRaster(document, { root, layer = null, environment, placement, surfaces, scrollbarStyle, identify }) {
  const element = document.documentElement;
  const key = `${environment.width}x${environment.height}@${environment.deviceScale}`;
  let surface = element._renderSurfaces?.get(key) ?? surfaces.get(key);
  // A raster target that rendered at this environment displaced the
  // caller's surface: a new one takes its place.
  if (surface === undefined || surface._shutdown) {
    surface = createRenderSurface(element, {
      viewportWidth: environment.width,
      viewportHeight: environment.height,
      deviceScale: environment.deviceScale,
      scrollbarStyle,
    });
    // A projection surface renders only the frames that captures ask for.
    surface.stop();
    surfaces.set(key, surface);
  }
  const running = surface.running;
  const previous = {
    root: surface.selectedRoot,
    layer: surface.selectedLayer,
    rectangle: surface.visibleRectangle,
    background: surface.background,
  };
  surface.stop();
  await surface.whenIdle();
  try {
    surface.setSelectedLayer(layer);
    if (layer === null) surface.setSelectedRoot(root);
    surface.setBackground(placement.backdrop);
    let rectangle = placement.rectangle;
    if (rectangle === null && root !== null) {
      surface.setVisibleRectangle(null);
      await surface.prepareNow({ deliverObservers: false });
      const box = surface.layoutTree().find((entry) => entry.node === root)?.rect ?? null;
      if (box === null || !(box.width > 0) || !(box.height > 0)) {
        throw new RangeError(`The selected node ${identify(root)} has no border box: it renders nothing.`);
      }
      rectangle = box;
    }
    surface.setVisibleRectangle(rectangle);
    const frame = await surface.renderNow({ pixels: false });
    return Object.freeze({
      kind: "raster",
      width: frame.width,
      height: frame.height,
      deviceScale: environment.deviceScale,
      rectangle: Object.freeze(rectangle === null
        ? { x: 0, y: 0, width: environment.width, height: environment.height }
        : { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height }),
      backdrop: placement.backdrop,
      offset: placement.offset,
      colorEncoding: frame.colorEncoding ?? frame.textureImage?.colorEncoding ?? null,
      alphaMode: frame.alphaMode ?? frame.textureImage?.alphaMode ?? null,
      textureImage: frame.textureImage,
      device: frame.device,
      pixels: frame.pixels ?? null,
      rowStride: frame.rowStride ?? null,
      surface,
      frameSequence: frame.frameSequence,
    });
  } finally {
    if (!surface._shutdown) {
      surface.setSelectedLayer(previous.layer);
      if (previous.layer === null) surface.setSelectedRoot(previous.root);
      surface.setVisibleRectangle(previous.rectangle);
      surface.setBackground(previous.background);
      if (running) surface.start();
    }
  }
}

// Throws when the surface of `artifact` rendered another frame since, or
// shut down.
function requireCurrentRaster(artifact) {
  const { surface } = artifact;
  if (surface._shutdown || surface.frameSequence !== artifact.frameSequence) {
    throw new Error(
      `The raster of frame ${artifact.frameSequence} is superseded: its surface ` +
        (surface._shutdown ? "shut down" : `delivered frame ${surface.frameSequence}`) +
        ". Use a raster before the next frame of its surface.",
    );
  }
}

// Copies a raster artifact's texture into `texture` (a GPUTexture of the
// same format, with COPY_DST usage, on the same device) at the artifact's
// offset, with no readback. A superseded raster, or a WebGL 2 raster, which
// has pixels and no GPU texture, throws.
export async function copyRasterArtifact(artifact, texture) {
  requireCurrentRaster(artifact);
  if (artifact.textureImage === null || artifact.textureImage === undefined) {
    throw new TypeError("This raster has no GPU texture (WebGL 2 delivers pixels); read it back into a shared buffer.");
  }
  await copyTextureImageInto(artifact.device, artifact.textureImage, texture, artifact.offset.x, artifact.offset.y);
}

// Reads a raster artifact back: its working pixels ({ width, height,
// pixels, colorEncoding, alphaMode }). With `destination` ({ pixels, width,
// height } of the same sample type) the raster also lands in that shared
// buffer at the artifact's offset. A superseded raster throws.
export async function readRasterArtifact(artifact, destination = null) {
  requireCurrentRaster(artifact);
  const read = artifact.pixels !== null
    ? { pixels: artifact.pixels, width: artifact.width, height: artifact.height, rowStride: artifact.rowStride }
    : await readbackTextureImage(artifact.device, artifact.textureImage);
  // rowStride counts bytes, and may hold padding past each row's samples.
  const sourceStride = (read.rowStride ?? read.width * 4 * read.pixels.BYTES_PER_ELEMENT) /
    read.pixels.BYTES_PER_ELEMENT;
  if (destination !== null) {
    const { x, y } = artifact.offset;
    if (x + read.width > destination.width || y + read.height > destination.height) {
      throw new RangeError(
        `A ${read.width} x ${read.height} raster at offset (${x}, ${y}) does not fit the ` +
          `${destination.width} x ${destination.height} destination.`,
      );
    }
    if (destination.pixels.constructor !== read.pixels.constructor) {
      throw new TypeError(
        `The destination holds ${destination.pixels.constructor.name} samples; the raster holds ${read.pixels.constructor.name}.`,
      );
    }
    const rowLength = read.width * 4;
    for (let row = 0; row < read.height; row++) {
      destination.pixels.set(
        read.pixels.subarray(row * sourceStride, row * sourceStride + rowLength),
        ((y + row) * destination.width + x) * 4,
      );
    }
  }
  return Object.freeze({
    width: read.width,
    height: read.height,
    pixels: read.pixels,
    rowStride: sourceStride * read.pixels.BYTES_PER_ELEMENT,
    colorEncoding: read.colorEncoding ?? artifact.colorEncoding,
    alphaMode: read.alphaMode ?? artifact.alphaMode,
  });
}
