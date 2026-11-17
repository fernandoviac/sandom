import { withScrollGeometry } from "./scroll-core.js";
const descriptors = new WeakMap();
const finalizer = new FinalizationRegistry(({ core, handle }) => core.status("scroll_timeline_release", handle));
function applyTimelineRange(core, sample, token, value, end) {
  const progress = core.exports.scroll_timeline_range(sample, token, ...core.input(value || ""), end);
  core.throwIfError();
  return progress;
}
export function sampleScrollTimeline(animation, root, viewport, serialized, boxes) {
  const value = animation._timelineValue();
  const timeline = value ? String(value) : "";
  const named = typeof value === "string" ? 1 : 0;
  const core = root._domCore;
  let descriptor = descriptors.get(animation);
  if (!descriptor || descriptor.timeline !== timeline || descriptor.named !== named) {
    descriptors.delete(animation);
    if (descriptor?.handle) {
      finalizer.unregister(descriptor);
      core.status("scroll_timeline_release", descriptor.handle);
    }
    const handle = core.status("scroll_timeline_parse", animation._element._coreHandle, ...core.input(timeline), named);
    descriptor = { timeline, named, handle };
    descriptors.set(animation, descriptor);
    if (handle) finalizer.register(animation, { core, handle }, descriptor);
  }
  if (!descriptor.handle) return null;
  const sample = withScrollGeometry(root, viewport, boxes, serialized, (geometryCore, snapshot) =>
    geometryCore.status("scroll_timeline_sample", descriptor.handle, snapshot, root._coreHandle));
  if (!sample) return null;
  try {
    const startToken = core.status("scroll_timeline_next", sample);
    applyTimelineRange(core, sample, startToken, animation._timelineRangeStart(), 0);
    const endToken = core.status("scroll_timeline_next", sample);
    const progress = applyTimelineRange(core, sample, endToken, animation._timelineRangeEnd(), 1);
    return Number.isNaN(progress) ? null : progress;
  } finally {
    core.status("scroll_timeline_release", sample);
  }
}
