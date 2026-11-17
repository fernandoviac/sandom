// Artifact comparison runs in core/build/artifact-comparison.wat: the module
// validates both artifacts against the exact producer shape and lists the
// content changes. A failed check traps after the module records the error;
// this binding throws that error. Each comparison takes two live
// projections; the renderer core writes each one as the host value that the
// comparison reads.
import * as artifactComparisonBinary from "../wasm/artifact-comparison-binary.js";
import { layoutConstant, moduleLayoutConstants } from "../wasm/layout-table.js";
import { KIND_STRUCTURE, projectionHostValue } from "./native-projections.js";
import { compareRasters } from "../output/pixel-diff.js";

const comparisonConstant = moduleLayoutConstants(artifactComparisonBinary, "artifact comparison");
const COMPARE_DOCUMENT_SNAPSHOT = comparisonConstant("COMPARE_DOCUMENT_SNAPSHOT");
const COMPARE_LAYER_METRICS = comparisonConstant("COMPARE_LAYER_METRICS");
const COMPARE_PAINT_ARTIFACT = comparisonConstant("COMPARE_PAINT_ARTIFACT");
const COMPARE_ERROR_RANGE = comparisonConstant("COMPARE_ERROR_RANGE");
const KIND_METRICS = layoutConstant("PROJECTION_KIND_METRICS");
const KIND_PAINT = layoutConstant("PROJECTION_KIND_PAINT");

const decoder = new TextDecoder();
let comparison = null;

// `bytes` is the host value list of the two artifacts.
function compareArtifactBytes(mode, bytes) {
  comparison ??= artifactComparisonBinary.instantiate({}).exports;
  const pointer = comparison.input_buffer(bytes.length);
  new Uint8Array(comparison.memory.buffer, pointer, bytes.length).set(bytes);
  try {
    comparison.compare(mode, pointer, bytes.length);
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError) || comparison.error_length() === 0) throw error;
    const message = decoder.decode(
      new Uint8Array(comparison.memory.buffer, comparison.error_address(), comparison.error_length()),
    );
    throw comparison.error_kind() === COMPARE_ERROR_RANGE ? new RangeError(message) : new TypeError(message);
  }
  return JSON.parse(decoder.decode(
    new Uint8Array(comparison.memory.buffer, comparison.output_address(), comparison.output_length()),
  ));
}

function compareProjections(mode, kind, name, baseline, current) {
  const baselineBytes = projectionHostValue(baseline, kind, `${name} baseline`);
  const currentBytes = projectionHostValue(current, kind, `${name} current`);
  const bytes = new Uint8Array(baselineBytes.length + currentBytes.length);
  bytes.set(baselineBytes);
  bytes.set(currentBytes, baselineBytes.length);
  return compareArtifactBytes(mode, bytes);
}

// Compares two structure projections of DocumentSession.snapshot().
export function compareDocumentSnapshots(baseline, current) {
  return compareProjections(COMPARE_DOCUMENT_SNAPSHOT, KIND_STRUCTURE, "compareDocumentSnapshots", baseline, current);
}

// Compares two metrics projections of DocumentSession.metrics().
export function compareLayerMetrics(baseline, current) {
  return compareProjections(COMPARE_LAYER_METRICS, KIND_METRICS, "compareLayerMetrics", baseline, current);
}

// Compares two paint command records: operations align through the scene
// node tree that each record carries.
export function comparePaintArtifacts(baseline, current) {
  return compareProjections(COMPARE_PAINT_ARTIFACT, KIND_PAINT, "comparePaintArtifacts", baseline, current);
}

const OBSERVATION_COMPARISONS = new Map([
  ["structure", compareDocumentSnapshots],
  ["metrics", compareLayerMetrics],
  ["paint", comparePaintArtifacts],
]);

// Compares two captured projections ({ artifact, provenance }, as
// session.project() delivers them) of `kind` and returns the facts with
// both provenances: { kind, changes, left, right }. A raster comparison
// takes read-back rasters (session.readback()) as its artifacts, since a
// later frame of a surface supersedes a raster's texture. It gives no
// verdict and applies no transition.
export function compareObservations(left, right, kind) {
  for (const [side, captured] of [["left", left], ["right", right]]) {
    if (captured?.provenance?.kind !== kind) {
      throw new TypeError(`A ${kind} comparison needs two ${kind} projections; the ${side} one is ${captured?.provenance?.kind}.`);
    }
  }
  const changes = kind === "raster"
    ? compareRasters(
      { ...left.artifact, deviceScale: left.provenance.environment.deviceScale },
      { ...right.artifact, deviceScale: right.provenance.environment.deviceScale },
    )
    : OBSERVATION_COMPARISONS.get(kind)(left.artifact, right.artifact);
  return Object.freeze({ kind, changes, left: left.provenance, right: right.provenance });
}
