// Minimal MessagePack codec for JSON/SLC4 metadata. Zero dependencies.
// Supports: null, booleans, strings, Uint8Array, arrays, plain objects,
// integers (Number/BigInt), and float64.
// Byte-for-byte compatible with the original Buffer-based implementation.

import * as B from './bytes.js';

export function encode(value) {
  if (value === null || value === undefined) return B.from([0xc0]);
  if (value === false) return B.from([0xc2]);
  if (value === true) return B.from([0xc3]);
  if (value instanceof Uint8Array) {
    const x = value, n = x.length;
    if (n <= 0xff) return B.concat([B.from([0xc4, n]), x]);
    if (n <= 0xffff) return B.concat([B.from([0xc5]), B.u16(n), x]);
    return B.concat([B.from([0xc6]), B.u32(n), x]);
  }
  if (typeof value === 'bigint') return encodeInteger(value);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return encodeInteger(BigInt(value));
    return B.concat([B.from([0xcb]), B.f64(value)]);
  }
  if (typeof value === 'string') {
    const x = B.fromString(value), n = x.length;
    if (n <= 31) return B.concat([B.from([0xa0 | n]), x]);
    if (n <= 0xff) return B.concat([B.from([0xd9, n]), x]);
    if (n <= 0xffff) return B.concat([B.from([0xda]), B.u16(n), x]);
    return B.concat([B.from([0xdb]), B.u32(n), x]);
  }
  if (Array.isArray(value)) {
    const n = value.length; let h;
    if (n <= 15) h = B.from([0x90 | n]);
    else if (n <= 0xffff) h = B.concat([B.from([0xdc]), B.u16(n)]);
    else h = B.concat([B.from([0xdd]), B.u32(n)]);
    return B.concat([h, ...value.map(encode)]);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value), n = entries.length; let h;
    if (n <= 15) h = B.from([0x80 | n]);
    else if (n <= 0xffff) h = B.concat([B.from([0xde]), B.u16(n)]);
    else h = B.concat([B.from([0xdf]), B.u32(n)]);
    const parts = [h];
    for (const [k, v] of entries) { parts.push(encode(k), encode(v)); }
    return B.concat(parts);
  }
  throw new TypeError(`MessagePack unsupported type: ${typeof value}`);
}

function encodeInteger(n) {
  if (n >= 0n) {
    if (n <= 0x7fn) return B.from([Number(n)]);
    if (n <= 0xffn) return B.from([0xcc, Number(n)]);
    if (n <= 0xffffn) return B.concat([B.from([0xcd]), B.u16(Number(n))]);
    if (n <= 0xffffffffn) return B.concat([B.from([0xce]), B.u32(Number(n))]);
    if (n <= 0xffffffffffffffffn) return B.concat([B.from([0xcf]), B.u64(n)]);
  } else {
    if (n >= -32n) return B.from([Number(256n + n)]);
    if (n >= -128n) return B.concat([B.from([0xd0]), B.i8(Number(n))]);
    if (n >= -32768n) return B.concat([B.from([0xd1]), B.i16(Number(n))]);
    if (n >= -2147483648n) return B.concat([B.from([0xd2]), B.i32(Number(n))]);
    if (n >= -9223372036854775808n) return B.concat([B.from([0xd3]), B.i64(n)]);
  }
  throw new RangeError('MessagePack integer outside 64-bit range');
}

export function decode(buf) {
  const b = B.from(buf);
  const [v, pos] = read(b, 0);
  if (pos !== b.length) throw new Error(`Trailing MessagePack bytes: ${b.length - pos}`);
  return v;
}

function safeBig(n) {
  return (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(n) : n;
}

// Lengths and offsets come straight out of the byte stream, so every read is
// checked against what the buffer actually holds before it is used. Without
// this a truncated or hostile archive surfaces as an opaque DataView
// RangeError instead of a clean truncation error.
function span(buf, pos, n) {
  if (n < 0 || pos + n > buf.length) throw new Error('Truncated MessagePack');
  return pos + n;
}
function need(buf, pos, n) {
  if (pos + n > buf.length) throw new Error('Truncated MessagePack');
  return pos;
}

export function read(buf, pos) {
  if (pos >= buf.length) throw new Error('Truncated MessagePack');
  const c = buf[pos++];
  if (c <= 0x7f) return [c, pos];
  if (c >= 0xe0) return [c - 256, pos];
  if ((c & 0xf0) === 0x80) return readMap(buf, pos, c & 0x0f);
  if ((c & 0xf0) === 0x90) return readArray(buf, pos, c & 0x0f);
  if ((c & 0xe0) === 0xa0) return readString(buf, pos, c & 0x1f);
  switch (c) {
    case 0xc0: return [null, pos];
    case 0xc2: return [false, pos];
    case 0xc3: return [true, pos];
    case 0xc4: { const n = buf[pos++]; const e = span(buf, pos, n); return [buf.subarray(pos, e), e]; }
    case 0xc5: { const n = B.readU16BE(buf, need(buf, pos, 2)); pos += 2; const e = span(buf, pos, n); return [buf.subarray(pos, e), e]; }
    case 0xc6: { const n = B.readU32BE(buf, need(buf, pos, 4)); pos += 4; const e = span(buf, pos, n); return [buf.subarray(pos, e), e]; }
    case 0xca: return [B.readF32BE(buf, need(buf, pos, 4)), pos + 4];
    case 0xcb: return [B.readF64BE(buf, need(buf, pos, 8)), pos + 8];
    case 0xcc: return [buf[need(buf, pos, 1)], pos + 1];
    case 0xcd: return [B.readU16BE(buf, need(buf, pos, 2)), pos + 2];
    case 0xce: return [B.readU32BE(buf, need(buf, pos, 4)), pos + 4];
    case 0xcf: return [safeBig(B.readU64BE(buf, need(buf, pos, 8))), pos + 8];
    case 0xd0: return [B.readI8(buf, need(buf, pos, 1)), pos + 1];
    case 0xd1: return [B.readI16BE(buf, need(buf, pos, 2)), pos + 2];
    case 0xd2: return [B.readI32BE(buf, need(buf, pos, 4)), pos + 4];
    case 0xd3: return [safeBig(B.readI64BE(buf, need(buf, pos, 8))), pos + 8];
    case 0xd9: { const n = buf[pos++]; return readString(buf, pos, n); }
    case 0xda: { const n = B.readU16BE(buf, need(buf, pos, 2)); pos += 2; return readString(buf, pos, n); }
    case 0xdb: { const n = B.readU32BE(buf, need(buf, pos, 4)); pos += 4; return readString(buf, pos, n); }
    case 0xdc: { const n = B.readU16BE(buf, need(buf, pos, 2)); pos += 2; return readArray(buf, pos, n); }
    case 0xdd: { const n = B.readU32BE(buf, need(buf, pos, 4)); pos += 4; return readArray(buf, pos, n); }
    case 0xde: { const n = B.readU16BE(buf, need(buf, pos, 2)); pos += 2; return readMap(buf, pos, n); }
    case 0xdf: { const n = B.readU32BE(buf, need(buf, pos, 4)); pos += 4; return readMap(buf, pos, n); }
    default: throw new Error(`Unsupported MessagePack opcode 0x${c.toString(16)}`);
  }
}

function readString(buf, pos, n) { const e = span(buf, pos, n); return [B.toString(buf, pos, e), e]; }
function readArray(buf, pos, n) {
  if (pos + n > buf.length) throw new Error('Truncated MessagePack');  // 1 byte minimum per element
  const a = [];
  for (let i = 0; i < n; i++) { const r = read(buf, pos); a.push(r[0]); pos = r[1]; }
  return [a, pos];
}
function readMap(buf, pos, n) {
  if (pos + n * 2 > buf.length) throw new Error('Truncated MessagePack');
  const o = {};
  for (let i = 0; i < n; i++) {
    let r = read(buf, pos); const k = r[0]; pos = r[1];
    r = read(buf, pos); o[String(k)] = r[0]; pos = r[1];
  }
  return [o, pos];
}
