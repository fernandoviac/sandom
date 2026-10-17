// Chrome unpremultiplies a canvas read with Skia's float raster pipeline:
// each byte times float32(1/255), the color times float32(1/alpha), then
// value * 255 rounded half to even. Measured exact for every premultiplied
// value and alpha (2026-10-10). A screenshot of an opaque canvas whose
// stored alpha is below 255 unpremultiplies its surface alike (measured
// 2026-10-12 on 720 such pixels). The table holds the result for value
// and alpha, indexed alpha * 256 + value; alpha 0 reads as 0. Its users
// are the canvas read (src/dom/canvas-2d.js) and the paint of an opaque
// canvas (src/rasterize.js, IMAGE_VARIANT_CONTENTS_OPAQUE).
let table = null;

function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function unpremultiplied(value, alpha) {
  const inverse255 = Math.fround(1 / 255);
  const scale = Math.fround(1 / Math.fround(alpha * inverse255));
  const color = Math.min(1, Math.fround(Math.fround(value * inverse255) * scale));
  return roundHalfToEven(Math.fround(color * 255));
}

export function canvasUnpremultiplyTable() {
  if (table === null) {
    table = new Uint8Array(256 * 256);
    for (let alpha = 1; alpha < 256; alpha++) {
      for (let value = 0; value < 256; value++) {
        table[alpha * 256 + value] = unpremultiplied(value, alpha);
      }
    }
  }
  return table;
}
