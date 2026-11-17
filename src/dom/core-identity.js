// Names the identity of a renderer core once (core/engine/component-revisions.watpart):
// a random nonzero u32 that the core puts in each revision and projection
// handle, so that a handle of another runtime throws.
export function identifyCore(core) {
  if (core.statusRaw("revision_core_identity") !== 0) return;
  const [identity] = crypto.getRandomValues(new Uint32Array(1));
  core.statusRaw("revision_core_identify", identity | 1);
}
