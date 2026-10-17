export const MAX_SHADER_CLIP_ENTRIES = 8;

// Packs the fixed shader clip tail of Sandom command rendering. Each entry is
// five vec4f values. src/wasm/gpu-compositor.watpart packs the same layout.
export function clipUniformFloats(clipState) {
  if (clipState.packedFloats) return clipState.packedFloats;
  const entries = clipState.entries;
  if (entries.length > MAX_SHADER_CLIP_ENTRIES) {
    throw new Error(
      `clipUniformFloats: ${entries.length} clip entries exceed the shader cap of ` +
        `${MAX_SHADER_CLIP_ENTRIES} (distinct transform spaces with active clips on one ` +
        `paint path) — raise MAX_SHADER_CLIP_ENTRIES if a real scene needs this`,
    );
  }
  const output = new Array(MAX_SHADER_CLIP_ENTRIES * 20).fill(0);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const base = index * 20;
    output[base] = entry.x;
    output[base + 1] = entry.y;
    output[base + 2] = entry.x + entry.w;
    output[base + 3] = entry.y + entry.h;
    output[base + 4] = entry.radiiX[0];
    output[base + 5] = entry.radiiX[1];
    output[base + 6] = entry.radiiX[2];
    output[base + 7] = entry.radiiX[3];
    output[base + 8] = entry.radiiY[0];
    output[base + 9] = entry.radiiY[1];
    output[base + 10] = entry.radiiY[2];
    output[base + 11] = entry.radiiY[3];
    output[base + 12] = entry.inverseAffine[0];
    output[base + 13] = entry.inverseAffine[1];
    output[base + 14] = entry.inverseAffine[2];
    output[base + 15] = entry.inverseAffine[3];
    output[base + 16] = entry.inverseAffine[4];
    output[base + 17] = entry.inverseAffine[5];
    output[base + 18] = entry.mode;
    output[base + 19] = entry.axisBits;
  }
  return output;
}
