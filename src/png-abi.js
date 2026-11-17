import record from "@sandom/png/abi.json" with { type: "json" };

// The codec package owns field order and ABI constants. The binding uses byte offsets.
export const PNG_ABI = Object.freeze({
  ...record,
  fields: Object.fromEntries(record.fields.map((name, index) => [name, index * 4])),
  recordBytes: record.fields.length * 4,
});
