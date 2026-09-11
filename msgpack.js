'use strict';

// Minimal MessagePack codec for JSON/SLC4 metadata. Zero dependencies.
// Supports: null, booleans, strings, Buffer/Uint8Array, arrays, plain objects,
// integers (Number/BigInt), and float64.

function concat(parts) { return Buffer.concat(parts); }
function u16(n) { const b=Buffer.allocUnsafe(2); b.writeUInt16BE(n); return b; }
function u32(n) { const b=Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; }
function i8(n) { const b=Buffer.allocUnsafe(1); b.writeInt8(n); return b; }
function i16(n) { const b=Buffer.allocUnsafe(2); b.writeInt16BE(n); return b; }
function i32(n) { const b=Buffer.allocUnsafe(4); b.writeInt32BE(n); return b; }
function u64(n) { const b=Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function i64(n) { const b=Buffer.allocUnsafe(8); b.writeBigInt64BE(BigInt(n)); return b; }

function encode(value) {
  if (value === null || value === undefined) return Buffer.from([0xc0]);
  if (value === false) return Buffer.from([0xc2]);
  if (value === true) return Buffer.from([0xc3]);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const x=Buffer.from(value); const n=x.length;
    if (n <= 0xff) return concat([Buffer.from([0xc4,n]),x]);
    if (n <= 0xffff) return concat([Buffer.from([0xc5]),u16(n),x]);
    return concat([Buffer.from([0xc6]),u32(n),x]);
  }
  if (typeof value === 'bigint') return encodeInteger(value);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return encodeInteger(BigInt(value));
    const b=Buffer.allocUnsafe(9); b[0]=0xcb; b.writeDoubleBE(value,1); return b;
  }
  if (typeof value === 'string') {
    const x=Buffer.from(value,'utf8'), n=x.length;
    if (n <= 31) return concat([Buffer.from([0xa0|n]),x]);
    if (n <= 0xff) return concat([Buffer.from([0xd9,n]),x]);
    if (n <= 0xffff) return concat([Buffer.from([0xda]),u16(n),x]);
    return concat([Buffer.from([0xdb]),u32(n),x]);
  }
  if (Array.isArray(value)) {
    const n=value.length; let h;
    if (n <= 15) h=Buffer.from([0x90|n]);
    else if (n <= 0xffff) h=concat([Buffer.from([0xdc]),u16(n)]);
    else h=concat([Buffer.from([0xdd]),u32(n)]);
    return concat([h,...value.map(encode)]);
  }
  if (typeof value === 'object') {
    const entries=Object.entries(value), n=entries.length; let h;
    if (n <= 15) h=Buffer.from([0x80|n]);
    else if (n <= 0xffff) h=concat([Buffer.from([0xde]),u16(n)]);
    else h=concat([Buffer.from([0xdf]),u32(n)]);
    const parts=[h]; for (const [k,v] of entries) { parts.push(encode(k),encode(v)); }
    return concat(parts);
  }
  throw new TypeError(`MessagePack unsupported type: ${typeof value}`);
}

function encodeInteger(n) {
  if (n >= 0n) {
    if (n <= 0x7fn) return Buffer.from([Number(n)]);
    if (n <= 0xffn) return Buffer.from([0xcc,Number(n)]);
    if (n <= 0xffffn) return concat([Buffer.from([0xcd]),u16(Number(n))]);
    if (n <= 0xffffffffn) return concat([Buffer.from([0xce]),u32(Number(n))]);
    if (n <= 0xffffffffffffffffn) return concat([Buffer.from([0xcf]),u64(n)]);
  } else {
    if (n >= -32n) return Buffer.from([Number(256n+n)]);
    if (n >= -128n) return concat([Buffer.from([0xd0]),i8(Number(n))]);
    if (n >= -32768n) return concat([Buffer.from([0xd1]),i16(Number(n))]);
    if (n >= -2147483648n) return concat([Buffer.from([0xd2]),i32(Number(n))]);
    if (n >= -9223372036854775808n) return concat([Buffer.from([0xd3]),i64(n)]);
  }
  throw new RangeError('MessagePack integer outside 64-bit range');
}

function decode(buf) {
  const b=Buffer.from(buf); const [v,pos]=read(b,0);
  if (pos !== b.length) throw new Error(`Trailing MessagePack bytes: ${b.length-pos}`);
  return v;
}
function safeBig(n) {
  return (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(n) : n;
}
function read(buf,pos) {
  if (pos >= buf.length) throw new Error('Truncated MessagePack');
  const c=buf[pos++];
  if (c <= 0x7f) return [c,pos];
  if (c >= 0xe0) return [c-256,pos];
  if ((c&0xf0)===0x80) return readMap(buf,pos,c&0x0f);
  if ((c&0xf0)===0x90) return readArray(buf,pos,c&0x0f);
  if ((c&0xe0)===0xa0) return readString(buf,pos,c&0x1f);
  switch(c) {
    case 0xc0:return [null,pos]; case 0xc2:return [false,pos]; case 0xc3:return [true,pos];
    case 0xc4:{const n=buf[pos++];return [buf.subarray(pos,pos+n),pos+n];}
    case 0xc5:{const n=buf.readUInt16BE(pos);pos+=2;return [buf.subarray(pos,pos+n),pos+n];}
    case 0xc6:{const n=buf.readUInt32BE(pos);pos+=4;return [buf.subarray(pos,pos+n),pos+n];}
    case 0xca:{const v=buf.readFloatBE(pos);return [v,pos+4];}
    case 0xcb:{const v=buf.readDoubleBE(pos);return [v,pos+8];}
    case 0xcc:return [buf[pos],pos+1];
    case 0xcd:return [buf.readUInt16BE(pos),pos+2];
    case 0xce:return [buf.readUInt32BE(pos),pos+4];
    case 0xcf:{const n=buf.readBigUInt64BE(pos);return [safeBig(n),pos+8];}
    case 0xd0:return [buf.readInt8(pos),pos+1];
    case 0xd1:return [buf.readInt16BE(pos),pos+2];
    case 0xd2:return [buf.readInt32BE(pos),pos+4];
    case 0xd3:{const n=buf.readBigInt64BE(pos);return [safeBig(n),pos+8];}
    case 0xd9:{const n=buf[pos++];return readString(buf,pos,n);}
    case 0xda:{const n=buf.readUInt16BE(pos);pos+=2;return readString(buf,pos,n);}
    case 0xdb:{const n=buf.readUInt32BE(pos);pos+=4;return readString(buf,pos,n);}
    case 0xdc:{const n=buf.readUInt16BE(pos);pos+=2;return readArray(buf,pos,n);}
    case 0xdd:{const n=buf.readUInt32BE(pos);pos+=4;return readArray(buf,pos,n);}
    case 0xde:{const n=buf.readUInt16BE(pos);pos+=2;return readMap(buf,pos,n);}
    case 0xdf:{const n=buf.readUInt32BE(pos);pos+=4;return readMap(buf,pos,n);}
    default: throw new Error(`Unsupported MessagePack opcode 0x${c.toString(16)}`);
  }
}
function readString(buf,pos,n){return [buf.toString('utf8',pos,pos+n),pos+n];}
function readArray(buf,pos,n){const a=[];for(let i=0;i<n;i++){const r=read(buf,pos);a.push(r[0]);pos=r[1];}return [a,pos];}
function readMap(buf,pos,n){const o={};for(let i=0;i<n;i++){let r=read(buf,pos);const k=r[0];pos=r[1];r=read(buf,pos);o[String(k)]=r[0];pos=r[1];}return [o,pos];}

module.exports={encode,decode,read};
