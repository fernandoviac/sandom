// The DOMString transport of the DOM core (docs/design/dom-webassembly-core.md,
// "Strings and lists"). A DOMString is a sequence of UTF-16 code units
// (WebIDL); it can contain a lone surrogate. The core keeps a DOMString as
// WTF-8 (https://simonsapin.github.io/wtf-8/): a surrogate pair is one supplementary
// code point in four UTF-8 bytes, and a lone surrogate is the three-byte
// sequence of its code point, ED A0..BF 80..BF. Well-formed UTF-16 has the same
// bytes as UTF-8, so the conversion is lossless in both directions and equal
// to TextEncoder and TextDecoder for a well-formed string.
//
// A USVString (WebIDL) is a Unicode scalar value conversion, not a DOMString
// conversion: its lone surrogates become U+FFFD before transport.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function encodeDomString(value) {
  if (value.isWellFormed()) return utf8Encoder.encode(value);
  const bytes = new Uint8Array(value.length * 3);
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    let unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes[length++] = unit;
      continue;
    }
    if (unit < 0x800) {
      bytes[length++] = 0xc0 | (unit >> 6);
      bytes[length++] = 0x80 | (unit & 0x3f);
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        unit = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        index++;
        bytes[length++] = 0xf0 | (unit >> 18);
        bytes[length++] = 0x80 | ((unit >> 12) & 0x3f);
        bytes[length++] = 0x80 | ((unit >> 6) & 0x3f);
        bytes[length++] = 0x80 | (unit & 0x3f);
        continue;
      }
    }
    bytes[length++] = 0xe0 | (unit >> 12);
    bytes[length++] = 0x80 | ((unit >> 6) & 0x3f);
    bytes[length++] = 0x80 | (unit & 0x3f);
  }
  return bytes.subarray(0, length);
}

// The byte index of the first lone surrogate at or after $from, or -1. In
// WTF-8, 0xED is always a lead byte; a second byte of A0..BF makes it a
// surrogate code point.
function loneSurrogateAt(bytes, from) {
  for (let at = bytes.indexOf(0xed, from); at >= 0; at = bytes.indexOf(0xed, at + 1)) {
    if (bytes[at + 1] >= 0xa0) return at;
  }
  return -1;
}

export function decodeDomString(bytes) {
  let surrogate = loneSurrogateAt(bytes, 0);
  if (surrogate < 0) return utf8Decoder.decode(bytes);
  let text = "";
  let start = 0;
  while (surrogate >= 0) {
    text += utf8Decoder.decode(bytes.subarray(start, surrogate)) +
      String.fromCharCode(
        0xd000 | ((bytes[surrogate + 1] & 0x3f) << 6) | (bytes[surrogate + 2] & 0x3f),
      );
    start = surrogate + 3;
    surrogate = loneSurrogateAt(bytes, start);
  }
  return text + utf8Decoder.decode(bytes.subarray(start));
}

// The codec object of a DOM core: `encode` and `decode` as TextEncoder and
// TextDecoder name them.
export const domStringCodec = Object.freeze({
  encode: encodeDomString,
  decode: decodeDomString,
});
