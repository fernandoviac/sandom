// DOMMatrix2DInit with the WebIDL "validate and fixup (2D)" steps, shared by
// CanvasRenderingContext2D, Path2D and CanvasPattern. `member` names the
// calling member in error messages, as Chrome's bindings do.
export function matrixFromInit(value, member) {
  if (value === undefined || value === null) return [1, 0, 0, 1, 0, 0];
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError(`${member}: The provided value is not of type 'DOMMatrix2DInit'.`);
  }
  const read = (name) => (value[name] === undefined ? undefined : Number(value[name]));
  const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map(read);
  const [m11, m12, m21, m22, m41, m42] = ["m11", "m12", "m21", "m22", "m41", "m42"].map(read);
  const pair = (short, long, fallback) => {
    if (short !== undefined && long !== undefined && !(short === long || (Number.isNaN(short) && Number.isNaN(long)))) {
      throw new TypeError(`${member}: Property mismatch on matrix initialization.`);
    }
    return long ?? short ?? fallback;
  };
  return [pair(a, m11, 1), pair(b, m12, 0), pair(c, m21, 0), pair(d, m22, 1), pair(e, m41, 0), pair(f, m42, 0)];
}
