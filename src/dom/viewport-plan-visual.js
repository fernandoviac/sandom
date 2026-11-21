// Renders one viewport recommendation trace as a standalone HTML document
// (output_viewport_visual of core/dom/output-viewport-visual.watpart).
import { sharedDomCore as core } from "../dom-wasm/core.js";

export function viewportPlanDocument(trace) {
  const { inputName, initialViewport, recommendation, plan } = trace;
  const trials = recommendation.trials;
  const code = plan.decision?.reason?.code;
  const values = [
    String(inputName), String(initialViewport.width), String(initialViewport.height),
    String(recommendation.classification), String(plan.confidence), code, String(code),
    Boolean(plan.viewport), plan.viewport?.width, plan.viewport?.height,
    String(plan.viewport?.width), String(plan.viewport?.height), trials.length,
  ];
  for (const trial of trials) {
    const { viewport, contentBounds: bounds } = trial;
    values.push(
      Number(viewport.width), Number(viewport.height), viewport.width, viewport.height,
      String(viewport.width), String(viewport.height), Boolean(trial.valid),
      Number(bounds.x), Number(bounds.y), Number(bounds.width), Number(bounds.height),
      String(trial.sequence), String(trial.source), trial.failedConstraints.length,
      ...trial.failedConstraints.map(String),
    );
  }
  core.status("output_viewport_visual", ...core.valueListInput(values));
  return core.outputString("output_viewport_visual");
}
