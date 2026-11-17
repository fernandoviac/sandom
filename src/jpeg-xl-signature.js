// JPEG XL has two signatures: the bare codestream (FF 0A) and the ISOBMFF
// container (0x0000000C 'JXL ' 0D 0A 87 0A); the image container module
// (core/engine/image-container.wat) recognizes both. Keep this detector
// separate from the codec so format dispatch does not load the JPEG XL
// implementation.
import { imageFormat } from "./image-container.js";

export function isJXL(bytes) {
  return imageFormat(bytes) === "jxl";
}
