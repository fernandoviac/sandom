// The identity of an element's ::before or ::after as the target of an
// animation: the key of its scene node in the render surface's maps
// (serialize.js pseudoIndexOf), beside the elements that key theirs. One
// object per element and pseudo-element, so the identity holds across
// serializations.
const targets = new WeakMap();
const created = new WeakSet();

export const PSEUDO_ELEMENT_NAMES = Object.freeze(["", "::before", "::after"]);

export function pseudoElementTarget(element, pseudoElement) {
  const kind = PSEUDO_ELEMENT_NAMES.indexOf(pseudoElement);
  if (kind < 1) {
    throw new TypeError(`An animation target pseudo-element is ::before or ::after; got ${JSON.stringify(pseudoElement)}`);
  }
  let byKind = targets.get(element);
  if (byKind === undefined) targets.set(element, byKind = []);
  let target = byKind[kind];
  if (target === undefined) {
    target = byKind[kind] = Object.freeze({ element, pseudoElement, kind });
    created.add(target);
  }
  return target;
}

export function isPseudoElementTarget(value) {
  return created.has(value);
}
