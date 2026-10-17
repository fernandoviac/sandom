// Component code that Sandom enters, and the tasks that it schedules.
//
// A component session claims an exception only when component code that
// Sandom entered raised it: mount, event listeners, lifecycle reactions,
// animation-frame and observer callbacks, and the timers, tasks and
// promises that this code starts. Every other exception belongs to the host
// program, and the runtime reports it as usual (the window's
// `dispatchEvent` in component-globals.js).
//
// Deno, Node and Bun carry an AsyncLocalStorage store from the code that
// schedules a timer, a task or a promise reaction into that callback, and
// report an unhandled rejection with the store of the code that rejected
// the promise. The entered document therefore stays current across
// `await`, timers, microtasks and message ports. A browser has no such
// store: there the entered document is current only during the synchronous
// call that Sandom makes.
//
// When its session is disposed, the component code of a document closes, as
// a browser closes a page: the window cancels every task that this code
// scheduled and that has not run, and a task that it schedules after that
// never runs (closeComponentCode).
//
// The import is gated on the runtime advertising node compatibility, as in
// src/package-assets.js: a browser logs a failed `node:` import that no
// catch can suppress.
const runtimeProvidesNodeModules = globalThis.Deno !== undefined ||
  globalThis.process?.versions !== undefined;

let asyncHooks = null;
if (runtimeProvidesNodeModules) {
  asyncHooks = await import("node:async_hooks");
}
const asyncContext = asyncHooks === null ? null : new asyncHooks.AsyncLocalStorage();
let synchronousDocument = null;

// The document whose component code runs, or null when host code runs.
export function componentCodeDocument() {
  return asyncContext === null ? synchronousDocument : asyncContext.getStore() ?? null;
}

// Calls `callback` with `thisArgument` and `argumentsList` as component code
// of `document`. Without a document, the call is not component code.
export function enterComponentCode(document, callback, thisArgument, argumentsList) {
  if (document == null || componentCodeDocument() === document) {
    return Reflect.apply(callback, thisArgument, argumentsList);
  }
  if (asyncContext !== null) {
    return asyncContext.run(document, Reflect.apply, callback, thisArgument, argumentsList);
  }
  const previousDocument = synchronousDocument;
  synchronousDocument = document;
  try {
    return Reflect.apply(callback, thisArgument, argumentsList);
  } finally {
    synchronousDocument = previousDocument;
  }
}

// Per document, the cancel functions of the tasks that its component code
// scheduled and that have not run; null when its component code is closed.
const pendingTasks = new WeakMap();

// Whether the component code of `document` is closed.
export function componentCodeClosed(document) {
  return pendingTasks.get(document) === null;
}

// Records a task that component code of the open `document` scheduled:
// `cancel()` cancels it. Returns the function that forgets the task after it
// ran or the page cancelled it.
export function recordComponentTask(document, cancel) {
  let tasks = pendingTasks.get(document);
  if (tasks === null) throw new Error("The component code of the document is closed");
  if (tasks === undefined) pendingTasks.set(document, (tasks = new Set()));
  const task = { cancel };
  tasks.add(task);
  return () => tasks.delete(task);
}

// Closes the component code of `document` and cancels its pending tasks.
export function closeComponentCode(document) {
  const tasks = pendingTasks.get(document);
  pendingTasks.set(document, null);
  for (const task of tasks ?? []) task.cancel();
}
