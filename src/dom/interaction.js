import { sharedDomCore } from "../dom-wasm/core.js";

// These codes select native schema domains, not host validation policy.
const POINTER_KEYS = 1;
const WHEEL_KEYS = 6;
const CANCEL_KEYS = 4;
const KEYBOARD_KEYS = 7;
const COMPOSITION_KEYS = 9;
const COMPOSITION_END_KEYS = 11;
const ACCESSIBILITY_ACTION_KEYS = 12;

function schemaEnum(domain, value) {
  if (typeof value !== "string") return 0;
  return sharedDomCore.status("input_schema_enum", domain, ...sharedDomCore.input(value));
}

function schemaNumber(kind, value) {
  return sharedDomCore.status("input_schema_number", kind, value) !== 0;
}

function finite(value, name) {
  const number = Number(value);
  if (!schemaNumber(0, number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function integer(value, name) {
  const number = Number(value);
  if (!schemaNumber(1, number)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return number;
}

function exactKeys(record, allowed) {
  for (const key of Object.keys(record)) {
    if (!sharedDomCore.status("input_schema_field", allowed, ...sharedDomCore.input(key))) {
      throw new TypeError(`Unknown ${record.kind} field: ${key}`);
    }
  }
}

function modifiers(record) {
  return Object.freeze({
    altKey: Boolean(record.altKey),
    ctrlKey: Boolean(record.controlKey),
    metaKey: Boolean(record.metaKey),
    shiftKey: Boolean(record.shiftKey),
  });
}
function keyboardString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
  }
  return value;
}


export function normalizeInputRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("An input record must be an object.");
  }
  if (!schemaEnum(0, record.kind)) {
    throw new RangeError(`Unknown input record kind: ${record.kind}`);
  }
  if (record.kind === "pointer-cancel" || record.kind === "pointer-leave") {
    exactKeys(record, CANCEL_KEYS);
    return Object.freeze({
      kind: record.kind,
      pointerId: integer(record.pointerId, "pointerId"),
    });
  }
  if (record.kind.startsWith("composition-")) {
    exactKeys(
      record,
      record.kind === "composition-end"
        ? COMPOSITION_END_KEYS
        : COMPOSITION_KEYS,
    );
    return Object.freeze({
      kind: record.kind,
      text: keyboardString(record.text, "text", { allowEmpty: true }),
      ...(record.kind === "composition-end"
        ? { cancelled: Boolean(record.cancelled) }
        : {}),
      ...modifiers(record),
    });
  }
  if (record.kind === "accessibility-action") {
    exactKeys(record, ACCESSIBILITY_ACTION_KEYS);
    const action = String(record.action);
    if (!schemaEnum(2, action)) {
      throw new RangeError(`Unknown accessibility action ${action}`);
    }
    const normalized = {
      kind: record.kind,
      accessibilityRevision: integer(
        record.accessibilityRevision,
        "accessibilityRevision",
      ),
      nodeIdentifier: keyboardString(
        record.nodeIdentifier,
        "nodeIdentifier",
      ),
      action,
    };
    if (action === "set-value") {
      normalized.value = keyboardString(record.value, "value", {
        allowEmpty: true,
      });
      if (
        record.selectionStart !== undefined ||
        record.selectionEnd !== undefined
      ) {
        throw new TypeError(
          "set-value does not accept selectionStart or selectionEnd",
        );
      }
    } else if (action === "selection") {
      normalized.selectionStart = integer(
        record.selectionStart,
        "selectionStart",
      );
      normalized.selectionEnd = integer(record.selectionEnd, "selectionEnd");
      if (record.value !== undefined) {
        throw new TypeError("selection does not accept value");
      }
    } else if (
      record.value !== undefined ||
      record.selectionStart !== undefined ||
      record.selectionEnd !== undefined
    ) {
      throw new TypeError(`${action} does not accept a value or selection`);
    }
    return Object.freeze(normalized);
  }
  if (record.kind === "wheel") {
    exactKeys(record, WHEEL_KEYS);
    const deltaMode = integer(record.deltaMode ?? 0, "deltaMode");
    if (!schemaNumber(3, deltaMode)) {
      throw new RangeError(`Unknown wheel deltaMode ${deltaMode}`);
    }
    return Object.freeze({
      kind: record.kind,
      x: finite(record.x, "x"),
      y: finite(record.y, "y"),
      deltaX: finite(record.deltaX, "deltaX"),
      deltaY: finite(record.deltaY, "deltaY"),
      deltaMode,
      ...modifiers(record),
    });
  }
  if (record.kind === "key-down" || record.kind === "key-up") {
    exactKeys(record, KEYBOARD_KEYS);
    const location = integer(record.location ?? 0, "location");
    if (!schemaNumber(4, location)) {
      throw new RangeError(`Unknown keyboard location ${location}`);
    }
    return Object.freeze({
      kind: record.kind,
      key: keyboardString(record.key, "key"),
      code: keyboardString(record.code ?? "", "code", { allowEmpty: true }),
      location,
      repeat: Boolean(record.repeat),
      ...modifiers(record),
    });
  }
  exactKeys(record, POINTER_KEYS);
  const pointerType = String(record.pointerType ?? "mouse");
  if (!schemaEnum(1, pointerType)) {
    throw new RangeError(`Unknown pointerType ${pointerType}`);
  }
  const pressure = finite(
    record.pressure ?? (record.kind === "pointer-up" ? 0 : 0.5),
    "pressure",
  );
  if (!schemaNumber(2, pressure)) {
    throw new RangeError("pressure must be between zero and one");
  }
  return Object.freeze({
    kind: record.kind,
    pointerId: integer(record.pointerId, "pointerId"),
    pointerType,
    isPrimary: Boolean(record.isPrimary ?? true),
    button: integer(record.button ?? 0, "button"),
    buttons: integer(
      record.buttons ?? (record.kind === "pointer-up" ? 0 : 1),
      "buttons",
    ),
    x: finite(record.x, "x"),
    y: finite(record.y, "y"),
    pressure,
    // A record without a time takes the time of the surface's clock when it
    // is dispatched (input-controller.js), the clock its frames run on.
    ...((record.timeMilliseconds ?? undefined) === undefined
      ? {}
      : { timeMilliseconds: finite(record.timeMilliseconds, "timeMilliseconds") }),
    ...modifiers(record),
  });
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
    0,
    record?.kind === "pointer-move",
  );
  if (step === 1) {
    step = sharedDomCore.exports.input_schema_coalesce(
      1,
      records.at(-1)?.kind === "pointer-move",
    );
  }
  if (step === 2) {
    step = sharedDomCore.exports.input_schema_coalesce(
      2,
      records.at(-1).pointerId === record.pointerId,
    );
  }
  if (step === 3) {
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
