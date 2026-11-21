import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";
import { decodeInputRecord, encodeInputRecord } from "../dom-wasm/input-record-encoding.js";

const INPUT_SCHEMA_FINITE = layoutConstant("INPUT_SCHEMA_FINITE");
const INPUT_COALESCE_START = layoutConstant("INPUT_COALESCE_START");
const INPUT_COALESCE_READ_KIND = layoutConstant("INPUT_COALESCE_READ_KIND");
const INPUT_COALESCE_READ_IDENTITY = layoutConstant("INPUT_COALESCE_READ_IDENTITY");
const INPUT_COALESCE_REPLACE = layoutConstant("INPUT_COALESCE_REPLACE");

function schemaNumber(kind, value) {
  return sharedDomCore.status("input_schema_number", kind, value) !== 0;
}

function finite(value, name) {
  const number = Number(value);
  if (!schemaNumber(INPUT_SCHEMA_FINITE, number)) throw new TypeError(`${name} must be finite`);
  return number;
}

// The core checks and normalizes the record (core/dom/input-record.watpart).
export function normalizeInputRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("An input record must be an object.");
  }
  const length = sharedDomCore.statusRaw("input_record_normalize", ...sharedDomCore.byteInput(encodeInputRecord(record)));
  return decodeInputRecord(sharedDomCore.outputBytes("input_record_normalize", 0, length));
}

const bigintHex = BigInt.prototype.toString;

// Abstract relational comparison uses a number-hinted ToPrimitive on both
// operands before either ToNumeric. Keep callbacks and failures on the host.
function comparisonPrimitive(value) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    const primitive = Reflect.apply(exotic, value, ["number"]);
    if (
      primitive === null ||
      (typeof primitive !== "object" && typeof primitive !== "function")
    ) return primitive;
    throw new TypeError("Cannot convert object to primitive value");
  }
  const valueOf = value.valueOf;
  if (typeof valueOf === "function") {
    const primitive = Reflect.apply(valueOf, value, []);
    if (
      primitive === null ||
      (typeof primitive !== "object" && typeof primitive !== "function")
    ) return primitive;
  }
  const toString = value.toString;
  if (typeof toString === "function") {
    const primitive = Reflect.apply(toString, value, []);
    if (
      primitive === null ||
      (typeof primitive !== "object" && typeof primitive !== "function")
    ) return primitive;
  }
  throw new TypeError("Cannot convert object to primitive value");
}

export function exceedsInputBound(value, maximum) {
  let left = comparisonPrimitive(value);
  let right = comparisonPrimitive(maximum);
  if (typeof left === "string" && typeof right === "string") {
    return sharedDomCore.inputSchemaTextCompare(left, right, 0);
  }
  if (
    (typeof left === "bigint" && typeof right === "string") ||
    (typeof left === "string" && typeof right === "bigint")
  ) {
    // StringToBigInt failure makes a relational comparison unordered, not an
    // exception. No objects or callbacks reach this language conversion.
    try {
      if (typeof left === "string") left = BigInt(left);
      else right = BigInt(right);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return sharedDomCore.exports.input_schema_bound_number(NaN, 0);
    }
  } else {
    if (typeof left !== "bigint") left = +left;
    if (typeof right !== "bigint") right = +right;
  }
  if (typeof left === "bigint") {
    const leftText = Reflect.apply(bigintHex, left, [16]);
    return typeof right === "bigint"
      ? sharedDomCore.inputSchemaTextCompare(
        leftText,
        Reflect.apply(bigintHex, right, [16]),
        1,
      )
      : sharedDomCore.inputSchemaTextCompare(leftText, "", 3, right);
  }
  return typeof right === "bigint"
    ? sharedDomCore.inputSchemaTextCompare(
      "",
      Reflect.apply(bigintHex, right, [16]),
      2,
      left,
    )
    : sharedDomCore.exports.input_schema_bound_number(left, right);
}

export function normalizeInputBatch(
  records,
  { maximumRecords = 512, maximumBytes = 131072 } = {},
) {
  if (!Array.isArray(records)) {
    throw new TypeError("Input records must be an array.");
  }
  const firstLength = records.length;
  if (
    sharedDomCore.exports.input_schema_batch_empty(
      typeof firstLength === "number",
      typeof firstLength === "number" ? firstLength : 0,
    ) || exceedsInputBound(records.length, maximumRecords)
  ) {
    throw new RangeError(
      `Input batch count must be between one and ${maximumRecords}`,
    );
  }
  if (
    exceedsInputBound(
      new TextEncoder().encode(JSON.stringify(records)).byteLength,
      maximumBytes,
    )
  ) {
    throw new RangeError(`Input batch exceeds ${maximumBytes} encoded bytes`);
  }
  return Object.freeze(records.map(normalizeInputRecord));
}
export function enqueueInputRecord(records, record) {
  if (!Array.isArray(records)) {
    throw new TypeError("The input record queue must be an array.");
  }
  // Each native step requests only the next observable host read. In particular,
  // do not cache at(-1), or convert arbitrary pointer identities to numbers.
  let step = sharedDomCore.exports.input_schema_coalesce(
    INPUT_COALESCE_START,
    record?.kind === "pointer-move",
  );
  if (step === INPUT_COALESCE_READ_KIND) {
    step = sharedDomCore.exports.input_schema_coalesce(
      step,
      records.at(-1)?.kind === "pointer-move",
    );
  }
  if (step === INPUT_COALESCE_READ_IDENTITY) {
    step = sharedDomCore.exports.input_schema_coalesce(
      step,
      records.at(-1).pointerId === record.pointerId,
    );
  }
  if (step === INPUT_COALESCE_REPLACE) {
    records[records.length - 1] = record;
  } else {
    records.push(record);
  }
}

export function mapPresentedPoint({ x, y }, rectangle, viewport) {
  const left = finite(rectangle.left, "presented left");
  const top = finite(rectangle.top, "presented top");
  const width = finite(rectangle.width, "presented width");
  const height = finite(rectangle.height, "presented height");
  if (!sharedDomCore.exports.input_schema_dimensions(width, height)) {
    throw new RangeError("Presented dimensions must be positive");
  }
  const hostX = finite(x, "host x");
  const hostY = finite(y, "host y");
  if (
    !sharedDomCore.exports.input_schema_contains(hostX, hostY, left, top, width, height)
  ) {
    throw new RangeError("The point is outside the presented rectangle.");
  }
  return Object.freeze({
    x: sharedDomCore.exports.input_schema_map_axis(
      hostX,
      left,
      finite(viewport.width, "viewport width"),
      width,
    ),
    y: sharedDomCore.exports.input_schema_map_axis(
      hostY,
      top,
      finite(viewport.height, "viewport height"),
      height,
    ),
  });
}
