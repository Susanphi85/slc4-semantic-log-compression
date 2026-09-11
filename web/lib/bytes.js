// Minimal byte helpers replacing Node's Buffer, so the SLC4 codec runs
// unchanged in the browser, in a Web Worker and in Node.
// Every function operates on plain Uint8Array.

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8', { fatal: false });

export function alloc(n) { return new Uint8Array(n); }
export function allocUnsafe(n) { return new Uint8Array(n); }
export function isBytes(v) { return v instanceof Uint8Array; }

export function from(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new TypeError('bytes.from: unsupported value');
}

export function fromString(s) { return ENC.encode(s); }
export function toString(u8, start = 0, end = u8.length) { return DEC.decode(u8.subarray(start, end)); }

export function fromHex(s) {
  if (s.length % 2) throw new Error('bytes.fromHex: odd length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new Error('bytes.fromHex: invalid hex');
    out[i] = v;
  }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(u8, start = 0, end = u8.length) {
  let s = '';
  for (let i = start; i < end; i++) s += HEX[u8[i]];
  return s;
}

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function equals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Big-endian scalar accessors. A fresh DataView per call is measurably slower
// than reusing one, so the last view is memoised -- but it is always bound to
// the array's own offset and length, so reads past the end of a subarray throw
// instead of silently returning neighbouring bytes.
let lastArr = null, lastView = null;
function view(u8) {
  if (u8 !== lastArr) { lastArr = u8; lastView = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  return lastView;
}
const off = (u8, pos) => pos;

export const readU8    = (u8, pos) => u8[pos];
export const readU16BE = (u8, pos) => view(u8).getUint16(off(u8, pos), false);
export const readU32BE = (u8, pos) => view(u8).getUint32(off(u8, pos), false);
export const readI8     = (u8, pos) => view(u8).getInt8(off(u8, pos));
export const readI16BE  = (u8, pos) => view(u8).getInt16(off(u8, pos), false);
export const readI32BE  = (u8, pos) => view(u8).getInt32(off(u8, pos), false);
export const readU64BE  = (u8, pos) => view(u8).getBigUint64(off(u8, pos), false);
export const readI64BE  = (u8, pos) => view(u8).getBigInt64(off(u8, pos), false);
export const readF32BE  = (u8, pos) => view(u8).getFloat32(off(u8, pos), false);
export const readF64BE  = (u8, pos) => view(u8).getFloat64(off(u8, pos), false);

export function writeU32BE(u8, value, pos = 0) { view(u8).setUint32(off(u8, pos), value, false); return u8; }

function scalar(size, setter) {
  return (n) => { const b = new Uint8Array(size); setter(new DataView(b.buffer), n); return b; };
}
export const u16 = scalar(2, (dv, n) => dv.setUint16(0, n, false));
export const u32 = scalar(4, (dv, n) => dv.setUint32(0, n, false));
export const i8  = scalar(1, (dv, n) => dv.setInt8(0, n));
export const i16 = scalar(2, (dv, n) => dv.setInt16(0, n, false));
export const i32 = scalar(4, (dv, n) => dv.setInt32(0, n, false));
export const u64 = scalar(8, (dv, n) => dv.setBigUint64(0, BigInt(n), false));
export const i64 = scalar(8, (dv, n) => dv.setBigInt64(0, BigInt(n), false));
export const f64 = scalar(8, (dv, n) => dv.setFloat64(0, n, false));
