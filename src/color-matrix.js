import { loadColorKernel } from "./wasm/color-kernel.js";

// One 3x3 matrix, rows of three, from linear-light `sourcePrimaries` into
// linear-light `destinationPrimaries` (PRIMARIES names of src/color.js),
// computed by the @sandom/color kernel. A host that composes a Sandom texture
// in its own GPU pass uses it for the pass's colour uniform. An unsupported
// destination throws.
const { linearRgbToWorkingMatrix } = loadColorKernel();
export { linearRgbToWorkingMatrix };
