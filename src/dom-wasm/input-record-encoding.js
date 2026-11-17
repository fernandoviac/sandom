// The field encoding of input records (core/dom/input-record.watpart): a
// record's own fields, each with its name, its value's type and its value.
// The core checks and normalizes the encoded record; the host converts
// values by their JavaScript type and nothing else.
import { layoutConstant } from "../wasm/layout-table.js";
import { domStringCodec } from "./dom-string-transport.js";

const VALUE_UNDEFINED = layoutConstant("INPUT_VALUE_UNDEFINED");
const VALUE_NUMBER = layoutConstant("INPUT_VALUE_NUMBER");
const VALUE_STRING = layoutConstant("INPUT_VALUE_STRING");
const VALUE_BOOLEAN = layoutConstant("INPUT_VALUE_BOOLEAN");
const VALUE_OTHER = layoutConstant("INPUT_VALUE_OTHER");
const VALUE_NULL = layoutConstant("INPUT_VALUE_NULL");

const pad = (length) => (length + 3) & ~3;

function valueType(value) {
  if (value === undefined) return VALUE_UNDEFINED;
  if (value === null) return VALUE_NULL;
  if (typeof value === "number") return VALUE_NUMBER;
  if (typeof value === "string") return VALUE_STRING;
  if (typeof value === "boolean") return VALUE_BOOLEAN;
  return VALUE_OTHER;
}

// The encoded fields of `record`, in its own key order.
export function encodeInputRecord(record) {
  const fields = Object.keys(record).map((name) => {
    const value = record[name];
    const type = valueType(value);
    return {
      name: domStringCodec.encode(name),
      type,
      value,
      text: type === VALUE_STRING ? domStringCodec.encode(value) : null,
    };
  });
  let length = 4;
  for (const field of fields) {
    length += 8 + pad(field.name.byteLength);
    if (field.type === VALUE_NUMBER) length += 8;
    else if (field.type === VALUE_BOOLEAN) length += 4;
    else if (field.type === VALUE_STRING) length += 4 + pad(field.text.byteLength);
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fields.length, true);
  let offset = 4;
  for (const field of fields) {
    view.setUint32(offset, field.name.byteLength, true);
    bytes.set(field.name, offset + 4);
    offset += 4 + pad(field.name.byteLength);
    view.setUint32(offset, field.type, true);
    offset += 4;
    if (field.type === VALUE_NUMBER) {
      view.setFloat64(offset, field.value, true);
      offset += 8;
    } else if (field.type === VALUE_BOOLEAN) {
      view.setUint32(offset, field.value ? 1 : 0, true);
      offset += 4;
    } else if (field.type === VALUE_STRING) {
      view.setUint32(offset, field.text.byteLength, true);
      bytes.set(field.text, offset + 4);
      offset += 4 + pad(field.text.byteLength);
    }
  }
  return bytes;
}

// The frozen record of the encoded fields at `offset` of `bytes`: a
// normalized record, or the record of an interact entry.
export function decodeInputRecord(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(offset, true);
  const record = {};
  let cursor = offset + 4;
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint32(cursor, true);
    const name = domStringCodec.decode(bytes.subarray(cursor + 4, cursor + 4 + nameLength));
    cursor += 4 + pad(nameLength);
    const type = view.getUint32(cursor, true);
    cursor += 4;
    if (type === VALUE_NUMBER) {
      record[name] = view.getFloat64(cursor, true);
      cursor += 8;
    } else if (type === VALUE_BOOLEAN) {
      record[name] = view.getUint32(cursor, true) === 1;
      cursor += 4;
    } else if (type === VALUE_STRING) {
      const length = view.getUint32(cursor, true);
      record[name] = domStringCodec.decode(bytes.subarray(cursor + 4, cursor + 4 + length));
      cursor += 4 + pad(length);
    } else if (type === VALUE_UNDEFINED) {
      record[name] = undefined;
    } else if (type === VALUE_NULL) {
      record[name] = null;
    } else if (type === VALUE_OTHER) {
      // A value of another type, which the core reads as an object.
      record[name] = Object.freeze({});
    } else {
      throw new RangeError(`An input record holds field ${name} of unknown type ${type}`);
    }
  }
  return Object.freeze(record);
}
