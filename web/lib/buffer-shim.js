// A Buffer-compatible view over Uint8Array, covering exactly the surface the
// SLC4 codec uses. It exists so slc4_codec.js can stay byte-for-byte the same
// logic in Node and in the browser instead of being forked into two ports.
//
// In Node the real Buffer is re-exported unchanged; the shim is only used where
// there is none. Both paths are held to the same bytes by a differential test.

import * as B from './bytes.js';

class Bytes extends Uint8Array {
  // subarray()/slice() route through Symbol.species, so they already return
  // Bytes rather than a plain Uint8Array.

  static alloc(n, fill = 0) {
    const b = new Bytes(n);
    if (fill) b.fill(fill);
    return b;
  }

  static allocUnsafe(n) { return new Bytes(n); }

  static from(value, encoding) {
    if (typeof value === 'string') {
      if (encoding === 'hex') return new Bytes(B.fromHex(value).buffer);
      const enc = B.fromString(value);
      return new Bytes(enc.buffer, enc.byteOffset, enc.byteLength);
    }
    if (value instanceof Uint8Array) { const b = new Bytes(value.length); b.set(value); return b; }
    if (Array.isArray(value)) return new Bytes(Uint8Array.from(value).buffer);
    if (value instanceof ArrayBuffer) return new Bytes(value);
    throw new TypeError('Bytes.from: unsupported value');
  }

  static concat(list) {
    let total = 0;
    for (const p of list) total += p.length;
    const out = new Bytes(total);
    let off = 0;
    for (const p of list) { out.set(p, off); off += p.length; }
    return out;
  }

  static isBuffer(v) { return v instanceof Bytes; }

  static compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
  }

  toString(encoding = 'utf8', start = 0, end = this.length) {
    if (encoding === 'hex') return B.toHex(this, start, end);
    if (encoding === 'utf8' || encoding === 'utf-8') return B.toString(this, start, end);
    throw new Error(`Bytes.toString: unsupported encoding ${encoding}`);
  }

  equals(other) { return B.equals(this, other); }

  readUInt32BE(pos = 0) { return B.readU32BE(this, pos); }
  writeUInt32BE(value, pos = 0) { B.writeU32BE(this, value, pos); return pos + 4; }
  readUInt16BE(pos = 0) { return B.readU16BE(this, pos); }
  writeUInt16BE(value, pos = 0) { new DataView(this.buffer, this.byteOffset, this.byteLength).setUint16(pos, value, false); return pos + 2; }
}

export const Buf = (typeof globalThis.Buffer !== 'undefined') ? globalThis.Buffer : Bytes;
export { Bytes };
