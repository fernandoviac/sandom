// The realm's MessageChannel, taken before a component session can replace
// the global one: the document's task queue is not component code, and its
// ports do not close with the component's (component-globals.js).
const RealmMessageChannel = globalThis.MessageChannel;

// One macrotask hop: every microtask queued so far, and every microtask
// they queue, runs before it ("perform a microtask checkpoint" after a
// script runs with an empty execution context stack).
export function microtaskCheckpoint() {
  return new Promise((resolve) => {
    const channel = new RealmMessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
