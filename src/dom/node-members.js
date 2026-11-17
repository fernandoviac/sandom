// The DOM members of a node as its interface gives them. The wrapper of an
// HTML form element is a proxy whose named properties come before the
// members of its prototype chain (src/dom/form-dom.js): a control named
// `ownerDocument` is the form's `ownerDocument` property for scripts.
// Sandom's own code reads the members of a node that can be a form through
// nodeMember, so that a control's name never changes what it reads.

// Each form wrapper's element object (form-dom.js).
export const formTargets = new WeakMap();

// The value of property `property` of node `node` without a form's indexed
// and named properties. Getters and methods run with the node as `this`.
export function nodeMember(node, property) {
  const element = formTargets.get(node);
  return element === undefined ? node[property] : Reflect.get(element, property, node);
}
