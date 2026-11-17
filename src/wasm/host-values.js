// The bytes of a host value list (core/engine/host-values.watpart): per value
// its kind, number, string text and JSON text, with array elements after
// their array and the key and value of each own enumerable field after
// their object. With compositeJson false, arrays and objects carry an empty
// JSON text, so that deep values cost their size once.
import * as outputFormatsBinary from "./output-formats-binary.js";
import { moduleLayoutConstants } from "./layout-table.js";

// The entry layout and tags of host-values.watpart. Every module that reads
// host value lists composes that component; the output formats module is
// the smallest of them.
const hostValueConstant = moduleLayoutConstants(outputFormatsBinary, "output formats");
const HOST_VALUE = Object.freeze(Object.fromEntries(["TAG", "NUMBER", "TEXT_LENGTH", "TEXT", "JSON_LENGTH_SIZE"]
  .map((name) => [name, hostValueConstant(`HOST_VALUE_${name}`)])));
const TAG = Object.freeze(Object.fromEntries(["UNDEFINED", "NULL", "NUMBER", "STRING", "BOOLEAN", "OBJECT", "ARRAY",
  "OTHER"].map((name) => [name, hostValueConstant(`HOST_VALUE_TAG_${name}`)])));
const encoder = new TextEncoder();

// The values are written into one buffer that grows by doubling; each text
// is encoded in place (encodeInto), so a value costs no allocation of its
// own. A frame encodes its facts and each layout read its peek this way.
export function encodeHostValues(values, { compositeJson = true } = {}) {
  let bytes = new Uint8Array(256);
  let view = new DataView(bytes.buffer);
  let length = 0;
  const reserve = (count) => {
    if (length + count <= bytes.length) return;
    let capacity = bytes.length * 2;
    while (capacity < length + count) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(bytes.subarray(0, length));
    bytes = grown;
    view = new DataView(bytes.buffer);
  };
  // Encodes `text` at the end and stores its byte length at `lengthOffset`.
  const writeText = (lengthOffset, text) => {
    reserve(text.length * 3);
    const { written } = encoder.encodeInto(text, bytes.subarray(length));
    view.setUint32(lengthOffset, written, true);
    length += written;
  };
  const append = (value) => {
    const kind = value === undefined ? TAG.UNDEFINED : value === null ? TAG.NULL
      : typeof value === "number" ? TAG.NUMBER : typeof value === "string" ? TAG.STRING
      : typeof value === "boolean" ? TAG.BOOLEAN : Array.isArray(value) ? TAG.ARRAY
      : typeof value === "object" ? TAG.OBJECT : TAG.OTHER;
    const keys = kind === TAG.OBJECT ? Object.keys(value) : null;
    reserve(HOST_VALUE.TEXT);
    const header = length;
    view.setUint8(header + HOST_VALUE.TAG, kind);
    view.setFloat64(header + HOST_VALUE.NUMBER, kind === TAG.NUMBER ? value : kind === TAG.BOOLEAN ? Number(value)
      : kind === TAG.ARRAY ? value.length : kind === TAG.OBJECT ? keys.length : 0, true);
    length += HOST_VALUE.TEXT;
    writeText(header + HOST_VALUE.TEXT_LENGTH, kind === TAG.STRING ? value : "");
    reserve(HOST_VALUE.JSON_LENGTH_SIZE);
    const jsonLength = length;
    length += HOST_VALUE.JSON_LENGTH_SIZE;
    writeText(jsonLength,
      !compositeJson && (kind === TAG.OBJECT || kind === TAG.ARRAY) ? "" : String(JSON.stringify(value)));
    if (kind === TAG.ARRAY) for (let index = 0; index < value.length; index++) append(value[index]);
    if (kind === TAG.OBJECT) {
      for (const key of keys) {
        append(key);
        append(value[key]);
      }
    }
  };
  values.forEach(append);
  return bytes.slice(0, length);
}
