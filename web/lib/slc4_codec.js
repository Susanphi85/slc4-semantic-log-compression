/**
 * Universal Log Codec V4 - JavaScript port.
 * Zero field-name-specific rules; lossless for JSON values/order.
 * Format is intentionally compatible with the Python SLC4 prototype where the
 * same generic encoding is selected.
 */
import * as msgpack from './msgpack.js';
import { Buf as Buffer } from './buffer-shim.js';

// The ZSTD backend is injected rather than imported: node:zlib in Node,
// WebAssembly in the browser. The codec needs it only to score candidate
// encodings in ZSTD-aware selection mode, never to produce the SLC4 stream.
let zstdCompressImpl = null;
export function setZstdCompress(fn) { zstdCompressImpl = fn; }

// An SLC4 stream is untrusted input. Every count in its metadata is attacker
// controlled, so decoding validates each one against the bytes actually present
// rather than allocating on the strength of a declared number.
export const LIMITS = { maxRecords: 50_000_000, maxSchemas: 1_000_000, maxPaths: 200_000 };
function bad(msg) { throw new Error(`SLC4: ${msg}`); }
// Numeric metadata fields are used in arithmetic, and MessagePack hands back a
// BigInt for anything outside the safe integer range -- which would mix types
// rather than fail cleanly. Every such field is normalised here first.
function uint(v,what,max){
  if(!Number.isInteger(v)||v<0||v>max) bad(`${what} is ${String(v)}, not a plausible count`);
  return v;
}
function label(v){const t=String(v);return JSON.stringify(t.length>24?t.slice(0,24)+'…':t);}
function checkCount(v, max, what) {
  if (!Number.isInteger(v) || v < 0 || v > max) bad(`${what} is ${v}, outside 0..${max}`);
  return v;
}

const MAGIC=Buffer.from('SLC4');
let SELECTION_MODE='raw';
const TS_RE=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const DECIMAL_UINT_RE=/^(?:0|[1-9]\d*)$/;
const HEX_RE=/^[0-9a-fA-F]+$/;
const NUM_TEMPLATE_RE=/^(.*?)([+-]?(?:\d+)(?:\.(\d+))?)([^\d]*)$/;

function setSelectionMode(x){SELECTION_MODE=(x==='zstd'?'zstd':'raw');}
function isPlainObject(v){return v!==null && typeof v==='object' && !Array.isArray(v) && !Buffer.isBuffer(v);}
function flattenLeaves(obj,prefix=[]){
  if(isPlainObject(obj)){
    const keys=Object.keys(obj);
    if(keys.length===0 && prefix.length) return [[prefix,{}]];
    const out=[]; for(const k of keys) out.push(...flattenLeaves(obj[k],[...prefix,k])); return out;
  }
  return [[prefix,obj]];
}
function setNested(root,path,value){
  let cur=root;
  for(const key of path.slice(0,-1)){
    if(!Object.prototype.hasOwnProperty.call(cur,key)) cur[key]=Object.create(null);
    cur=cur[key];
  }
  cur[path[path.length-1]]=value;
}
function encUvarint(value){
  let n=typeof value==='bigint'?value:BigInt(value); if(n<0n) throw new Error('uvarint requires non-negative integer');
  const a=[]; while(n>=0x80n){a.push(Number((n&0x7fn)|0x80n));n>>=7n;}a.push(Number(n));return Buffer.from(a);
}
function decUvarint(buf,pos=0){let shift=0n,n=0n;while(true){if(pos>=buf.length)throw new Error('truncated uvarint');const b=BigInt(buf[pos++]);n|=(b&0x7fn)<<shift;if(!(b&0x80n))return[n,pos];shift+=7n;if(shift>70n)throw new Error('uvarint too large');}}
function zigzag(n){n=BigInt(n);return n>=0n?n*2n:(-n)*2n-1n;}
function unzigzag(z){z=BigInt(z);return z%2n===0n?z/2n:-(z/2n)-1n;}
function bitsNeeded(n){if(n<=1)return 1;return Math.ceil(Math.log2(n));}
function bitpack(values,bits){if(!values.length)return Buffer.alloc(0);const out=Buffer.alloc(Math.ceil(values.length*bits/8));let bitpos=0;for(const value0 of values){const value=Number(value0);for(let j=0;j<bits;j++){if(value&(1<<j)){const idx=bitpos+j;out[Math.floor(idx/8)]|=1<<(idx%8);}}bitpos+=bits;}return out;}
function bitunpack(buf,n,bits){
  checkCount(n,LIMITS.maxRecords,'bit-packed value count');
  if(!Number.isInteger(bits)||bits<1||bits>32) bad(`bit width is ${bits}, outside 1..32`);
  if(Math.ceil(n*bits/8)>buf.length) bad(`bit-packed stream holds ${buf.length} bytes but declares ${n} values of ${bits} bits`);
  const vals=[];let bitpos=0;for(let k=0;k<n;k++){let v=0;for(let j=0;j<bits;j++){const idx=bitpos+j;if(buf[Math.floor(idx/8)]&(1<<(idx%8)))v|=1<<j;}vals.push(v);bitpos+=bits;}return vals;}
function tsToNs(s){const m=TS_RE.exec(s);if(!m)throw new Error(s);const [y,mo,d,h,mi,sec]=m.slice(1,7).map(Number);const frac=m[7]||'';const ms=Date.UTC(y,mo-1,d,h,mi,sec);const ns=BigInt(ms)*1000000n+BigInt((frac+'000000000').slice(0,9));return[ns,frac.length];}
function pad(n,w){return String(n).padStart(w,'0');}
function nsToTs(ns,precision){ns=BigInt(ns);let sec=ns/1000000000n,nano=ns%1000000000n;if(nano<0n){nano+=1000000000n;sec-=1n;}const d=new Date(Number(sec)*1000);const base=`${pad(d.getUTCFullYear(),4)}-${pad(d.getUTCMonth()+1,2)}-${pad(d.getUTCDate(),2)}T${pad(d.getUTCHours(),2)}:${pad(d.getUTCMinutes(),2)}:${pad(d.getUTCSeconds(),2)}`;return precision?`${base}.${nano.toString().padStart(9,'0').slice(0,precision)}Z`:`${base}Z`;}
function commonPrefix(strings){if(!strings.length)return'';let p=strings[0];for(let i=1;i<strings.length&&p;i++){const s=strings[i];let j=0,m=Math.min(p.length,s.length);while(j<m&&p[j]===s[j])j++;p=p.slice(0,j);}return p;}
function hexCaseStyle(strings){if(strings.every(s=>s===s.toLowerCase()))return'lower';if(strings.every(s=>s===s.toUpperCase()))return'upper';return null;}
function zstdCompress(data,level=1){
  if(!zstdCompressImpl) throw new Error('ZSTD-aware selection needs a ZSTD backend; call setZstdCompress() first');
  return Buffer.from(zstdCompressImpl(data,level));
}
function candidateCost(meta,blob){const payload=Buffer.concat([msgpack.encode(meta),blob]);return SELECTION_MODE==='zstd'?zstdCompress(payload,1).length:payload.length;}
function choose(cands){let best=cands[0],cost=candidateCost(...best);for(let i=1;i<cands.length;i++){const c=candidateCost(...cands[i]);if(c<cost){cost=c;best=cands[i];}}return best;}
function encodeRuns(values,valueEncoder){const parts=[];let runs=0;for(let i=0;i<values.length;){let j=i+1;while(j<values.length&&Object.is(values[j],values[i]))j++;const vb=valueEncoder(values[i]);parts.push(encUvarint(j-i),encUvarint(vb.length),vb);runs++;i=j;}return[runs,Buffer.concat(parts)];}
function decodeRuns(blob,runs,valueDecoder,limit=Infinity){
  checkCount(runs,LIMITS.maxRecords,'run count');
  const vals=[];let pos=0;for(let r=0;r<runs;r++){let x=decUvarint(blob,pos);const count=Number(x[0]);pos=x[1];x=decUvarint(blob,pos);const ln=Number(x[0]);pos=x[1];const vb=blob.subarray(pos,pos+ln);pos+=ln;const v=valueDecoder(vb);
    if(vals.length+count>limit) bad(`run-length stream expands past its declared ${limit} values`);
    for(let i=0;i<count;i++)vals.push(v);}return vals;}
function intVarints(vals){return Buffer.concat(vals.map(v=>encUvarint(zigzag(v))));}
function toBigVals(vals){return vals.map(v=>typeof v==='bigint'?v:BigInt(v));}
function intDeltas(vals0){const vals=toBigVals(vals0),ds=[vals[0]];for(let i=1;i<vals.length;i++)ds.push(vals[i]-vals[i-1]);return intVarints(ds);}
function intDelta2(vals0){const vals=toBigVals(vals0);if(vals.length===1)return intVarints(vals);const d1=[];for(let i=1;i<vals.length;i++)d1.push(vals[i]-vals[i-1]);const seq=[vals[0],d1[0]];for(let i=1;i<d1.length;i++)seq.push(d1[i]-d1[i-1]);return intVarints(seq);}
function decodeIntStream(blob,n,mode){const raw=[];let pos=0;while(raw.length<n){const x=decUvarint(blob,pos);raw.push(unzigzag(x[0]));pos=x[1];}if(mode==='ints')return raw;if(mode==='intdelta'){const out=[raw[0]];for(let i=1;i<raw.length;i++)out.push(out[out.length-1]+raw[i]);return out;}if(mode==='intdelta2'){if(n===1)return raw;const out=[raw[0]];let d=raw[1];out.push(out[0]+d);for(let i=2;i<raw.length;i++){d+=raw[i];out.push(out[out.length-1]+d);}return out;}bad(`unknown integer stream mode ${label(mode)}`);}
function encodeNumericTemplateStrings(ss){
  const parsed=ss.map(s=>NUM_TEMPLATE_RE.exec(s));if(parsed.some(x=>!x))return null;
  const prefixes=parsed.map(m=>m[1]),suffixes=parsed.map(m=>m[4]);if(new Set(prefixes).size!==1||new Set(suffixes).size!==1)return null;
  const nums=parsed.map(m=>m[2]);if(!nums.length||nums.reduce((a,x)=>a+x.length,0)<ss.length*1.2)return null;
  for(const num of nums){if(num.startsWith('+'))return null;const body=num.startsWith('-')?num.slice(1):num;const intpart=body.split('.',1)[0];if(intpart.length>1&&intpart.startsWith('0'))return null;if(num.startsWith('-')&&Number(num)===0)return null;}
  const scales=parsed.map(m=>(m[3]||'').length);const mant=nums.map(num=>{const sign=num.startsWith('-')?-1n:1n;const t=num.replace(/^[+-]/,'').replace('.','');return sign*BigInt(t);});
  const [mm,mb]=choose([[{menc:'ints'},intVarints(mant)],[{menc:'intdelta'},intDeltas(mant)],[{menc:'intdelta2'},intDelta2(mant)]]);
  const uniq=[...new Set(scales)];let sb,smeta;if(uniq.length<=16){const mp=new Map(uniq.map((v,i)=>[v,i]));const bits=bitsNeeded(uniq.length);sb=bitpack(scales.map(x=>mp.get(x)),bits);smeta={sdict:uniq,sbits:bits};}else{sb=Buffer.concat(scales.map(encUvarint));smeta={svarint:true};}
  return[{enc:'numtemplate',n:ss.length,prefix:prefixes[0],suffix:suffixes[0],...mm,...smeta},Buffer.concat([encUvarint(mb.length),mb,sb])];
}
function decodeNumericTemplate(meta,blob){const n=meta.n;let pos=0,x=decUvarint(blob,pos);const mlen=Number(x[0]);pos=x[1];const mb=blob.subarray(pos,pos+mlen);pos+=mlen;const mant=decodeIntStream(mb,n,meta.menc);let scales;if(meta.sdict){if(!Array.isArray(meta.sdict)) bad('numeric-template scale dictionary is malformed');const idx=bitunpack(blob.subarray(pos),n,meta.sbits);scales=idx.map(i=>meta.sdict[i]);}else{scales=[];for(let i=0;i<n;i++){x=decUvarint(blob,pos);scales.push(Number(x[0]));pos=x[1];}}
  return mant.map((m,i)=>{const sc=scales[i],sign=m<0n?'-':'';let digs=(m<0n?-m:m).toString();let num;if(sc){if(digs.length<=sc)digs='0'.repeat(sc+1-digs.length)+digs;num=sign+digs.slice(0,-sc)+'.'+digs.slice(-sc);}else num=sign+digs;return meta.prefix+num+meta.suffix;});}
function encodeFrontStrings(ss){const parts=[];let prev='';for(const s of ss){let k=0,m=Math.min(prev.length,s.length);while(k<m&&prev[k]===s[k])k++;const suffix=Buffer.from(s.slice(k),'utf8');parts.push(encUvarint(k),encUvarint(suffix.length),suffix);prev=s;}return Buffer.concat(parts);}
function decodeFrontStrings(blob,n){const vals=[];let pos=0,prev='';for(let i=0;i<n;i++){let x=decUvarint(blob,pos);const k=Number(x[0]);pos=x[1];x=decUvarint(blob,pos);const ln=Number(x[0]);pos=x[1];const suffix=blob.toString('utf8',pos,pos+ln);pos+=ln;const s=prev.slice(0,k)+suffix;vals.push(s);prev=s;}return vals;}
function encodeStringDictValues(ss){const n=ss.length,c=[];let parts=[];for(const s of ss){const b=Buffer.from(s,'utf8');parts.push(encUvarint(b.length),b);}c.push([{denc:'raw',n},Buffer.concat(parts)]);const pref=commonPrefix(ss);if(pref){parts=[];for(const s of ss){const b=Buffer.from(s.slice(pref.length),'utf8');parts.push(encUvarint(b.length),b);}c.push([{denc:'prefix',n,prefix:pref},Buffer.concat(parts)]);}c.push([{denc:'front',n},encodeFrontStrings(ss)]);
  const hstyle=ss.length?hexCaseStyle(ss):null;if(ss.length&&hstyle&&ss.every(x=>HEX_RE.test(x))&&new Set(ss.map(x=>x.length)).size===1&&ss[0].length%2===0&&ss[0].length>=8)c.push([{denc:'hex',n,hexchars:ss[0].length,hcase:hstyle},Buffer.concat(ss.map(x=>Buffer.from(x,'hex')))]);
  const suffix=pref?ss.map(x=>x.slice(pref.length)):[],shstyle=suffix.length?hexCaseStyle(suffix):null;if(pref&&suffix.length&&shstyle&&suffix.every(x=>HEX_RE.test(x))&&new Set(suffix.map(x=>x.length)).size===1&&suffix[0].length%2===0&&suffix[0].length>=8)c.push([{denc:'prefix_hex',n,prefix:pref,hexchars:suffix[0].length,hcase:shstyle},Buffer.concat(suffix.map(x=>Buffer.from(x,'hex')))]);
  return choose(c);
}
function decodeStringDictValues(meta,blob){const enc=meta.denc,n=meta.n;if(enc==='raw'||enc==='prefix'){const vals=[];let pos=0,p=meta.prefix||'';for(let i=0;i<n;i++){const x=decUvarint(blob,pos),ln=Number(x[0]);pos=x[1];vals.push(p+blob.toString('utf8',pos,pos+ln));pos+=ln;}return vals;}if(enc==='front')return decodeFrontStrings(blob,n);if(enc==='hex'||enc==='prefix_hex'){const w=uint(meta.hexchars,'hex width',1<<20)/2,p=meta.prefix||'';const vals=[];for(let i=0;i<n;i++){let v=blob.subarray(i*w,(i+1)*w).toString('hex');if(meta.hcase==='upper')v=v.toUpperCase();vals.push(p+v);}return vals;}bad(`unknown dictionary encoding ${label(enc)}`);}
function jsonStable(v){if(Array.isArray(v))return`[${v.map(jsonStable).join(',')}]`;if(isPlainObject(v)){return`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+jsonStable(v[k])).join(',')}}`;}return JSON.stringify(v);}
function sameAll(vals){if(!vals.length)return true;const a=jsonStable(vals[0]);return vals.every(v=>jsonStable(v)===a);}
function kind(v){if(v===null)return'null';if(typeof v==='boolean')return'bool';if(typeof v==='number')return Number.isInteger(v)?'int':'float';if(typeof v==='string')return'str';if(Array.isArray(v))return'array';if(isPlainObject(v))return'object';return typeof v;}
function parseIPv4(s){const p=s.split('.');if(p.length!==4)return null;const a=[];for(const x of p){if(!/^\d+$/.test(x)||(x.length>1&&x[0]==='0'))return null;const n=Number(x);if(n<0||n>255)return null;a.push(n);}return Buffer.from(a);}
function encodeColumn(vals){const n=vals.length;if(n===0)return[{enc:'empty',n:0},Buffer.alloc(0)];if(sameAll(vals))return[{enc:'const',value:vals[0],n},Buffer.alloc(0)];const types=new Set(vals.map(kind));
  if(types.size===1&&types.has('bool'))return[{enc:'boolbits',n},bitpack(vals.map(v=>v?1:0),1)];
  if(types.size===1&&types.has('int')){const big=vals.map(BigInt),c=[[{enc:'ints',n},intVarints(big)],[{enc:'intdelta',n},intDeltas(big)],[{enc:'intdelta2',n},intDelta2(big)]];const uniq=[...new Set(vals)];if(uniq.length<=65536){const bits=bitsNeeded(uniq.length),mp=new Map(uniq.map((v,i)=>[v,i])),db=intVarints(uniq.map(BigInt)),ib=bitpack(vals.map(v=>mp.get(v)),bits);c.push([{enc:'intdict',n,dcount:uniq.length,bits},Buffer.concat([encUvarint(db.length),db,ib])]);}const [runs,rb]=encodeRuns(vals,v=>encUvarint(zigzag(BigInt(v))));c.push([{enc:'intrle',n,runs},rb]);return choose(c);}
  if(types.size===1&&types.has('str')){const ss=vals,c=[];let parts=[];for(const s of ss){const b=Buffer.from(s,'utf8');parts.push(encUvarint(b.length),b);}c.push([{enc:'strraw',n},Buffer.concat(parts)]);
    const tm=ss.map(s=>TS_RE.exec(s));if(tm.every(m=>m&&(m[7]||'').length<=9)){const parsed=ss.map(tsToNs),ns=parsed.map(x=>x[0]),precisions=parsed.map(x=>x[1]);const [pm,pb]=choose([[{tmode:'intdelta'},intDeltas(ns)],[{tmode:'intdelta2'},intDelta2(ns)],[{tmode:'ints'},intVarints(ns)]]);const puniq=[...new Set(precisions)],pbits=bitsNeeded(puniq.length),pmap=new Map(puniq.map((v,i)=>[v,i])),precb=bitpack(precisions.map(x=>pmap.get(x)),pbits);c.push([{enc:'timestamp',n,...pm,pdict:puniq,pbits},Buffer.concat([encUvarint(pb.length),pb,precb])]);}
    if(ss.every(s=>DECIMAL_UINT_RE.test(s))){const ints=ss.map(BigInt);const [mm,mb]=choose([[{umode:'ints'},intVarints(ints)],[{umode:'intdelta'},intDeltas(ints)],[{umode:'intdelta2'},intDelta2(ints)]]);c.push([{enc:'uintstr',n,...mm},mb]);}
    const nt=encodeNumericTemplateStrings(ss);if(nt)c.push(nt);
    const ips=ss.map(parseIPv4);if(ips.every(Boolean))c.push([{enc:'ipv4',n},Buffer.concat(ips)]);
    const uniq=[...new Set(ss)];if(uniq.length<=65536){const bits=bitsNeeded(uniq.length),mp=new Map(uniq.map((v,i)=>[v,i])),[dm,db]=encodeStringDictValues(uniq),ib=bitpack(ss.map(v=>mp.get(v)),bits);c.push([{enc:'strdict',n,dcount:uniq.length,bits,dmeta:dm},Buffer.concat([encUvarint(db.length),db,ib])]);}
    {const[runs,rb]=encodeRuns(ss,s=>Buffer.from(s,'utf8'));c.push([{enc:'strrle',n,runs},rb]);}
    const hstyle=hexCaseStyle(ss);if(hstyle&&ss.every(s=>HEX_RE.test(s))&&new Set(ss.map(s=>s.length)).size===1&&ss[0].length%2===0&&ss[0].length>=8)c.push([{enc:'hex',n,hexchars:ss[0].length,hcase:hstyle},Buffer.concat(ss.map(s=>Buffer.from(s,'hex')))]);
    const pref=commonPrefix(ss),suffix=ss.map(s=>s.slice(pref.length)),shstyle=suffix.length?hexCaseStyle(suffix):null;if(pref&&suffix.length&&shstyle&&suffix.every(x=>HEX_RE.test(x))&&new Set(suffix.map(x=>x.length)).size===1&&suffix[0].length%2===0&&suffix[0].length>=8)c.push([{enc:'prefix_hex',n,prefix:pref,hexchars:suffix[0].length,hcase:shstyle},Buffer.concat(suffix.map(x=>Buffer.from(x,'hex')))]);
    if(pref){parts=[];for(const s of ss){const b=Buffer.from(s.slice(pref.length),'utf8');parts.push(encUvarint(b.length),b);}c.push([{enc:'prefix_raw',n,prefix:pref},Buffer.concat(parts)]);}c.push([{enc:'front',n},encodeFrontStrings(ss)]);return choose(c);
  }
  return[{enc:'msgpack',n},msgpack.encode(vals)];
}
function decodeColumn(meta,blob){if(!meta||typeof meta!=='object') bad('column descriptor is malformed');const enc=meta.enc,n=checkCount(meta.n,LIMITS.maxRecords,'column value count');if(enc==='empty')return[];if(enc==='const')return Array.from({length:n},()=>meta.value);if(enc==='boolbits')return bitunpack(blob,n,1).map(Boolean);if(['ints','intdelta','intdelta2'].includes(enc))return decodeIntStream(blob,n,enc).map(Number);if(enc==='intdict'){let x=decUvarint(blob,0),dlen=Number(x[0]),pos=x[1];const db=blob.subarray(pos,pos+dlen);pos+=dlen;const dvals=decodeIntStream(db,uint(meta.dcount,'dictionary size',LIMITS.maxRecords),'ints').map(Number);return bitunpack(blob.subarray(pos),n,meta.bits).map(i=>dvals[i]);}if(enc==='intrle')return decodeRuns(blob,meta.runs,b=>Number(unzigzag(decUvarint(b,0)[0])),n);if(enc==='timestamp'){let x=decUvarint(blob,0),ln=Number(x[0]),pos=x[1];const ib=blob.subarray(pos,pos+ln);pos+=ln;if(!Array.isArray(meta.pdict)) bad('timestamp precision dictionary is malformed');const ns=decodeIntStream(ib,n,meta.tmode),idx=bitunpack(blob.subarray(pos),n,meta.pbits),prec=idx.map(i=>meta.pdict[i]);return ns.map((v,i)=>nsToTs(v,prec[i]));}if(enc==='uintstr')return decodeIntStream(blob,n,meta.umode).map(String);if(enc==='numtemplate')return decodeNumericTemplate(meta,blob);if(enc==='ipv4'){const vals=[];for(let i=0;i<n;i++)vals.push([...blob.subarray(i*4,i*4+4)].join('.'));return vals;}if(enc==='strdict'){let x=decUvarint(blob,0),dlen=Number(x[0]),pos=x[1];const db=blob.subarray(pos,pos+dlen);pos+=dlen;if(!meta.dmeta||typeof meta.dmeta!=='object') bad('string dictionary has no descriptor');const dvals=decodeStringDictValues(meta.dmeta,db);return bitunpack(blob.subarray(pos),n,meta.bits).map(i=>dvals[i]);}if(enc==='strrle')return decodeRuns(blob,meta.runs,b=>b.toString('utf8'),n);if(enc==='hex'||enc==='prefix_hex'){const w=uint(meta.hexchars,'hex width',1<<20)/2,p=meta.prefix||'',vals=[];for(let i=0;i<n;i++){let v=blob.subarray(i*w,(i+1)*w).toString('hex');if(meta.hcase==='upper')v=v.toUpperCase();vals.push(p+v);}return vals;}if(enc==='prefix_raw'||enc==='strraw'){const vals=[];let pos=0,p=meta.prefix||'';for(let i=0;i<n;i++){const x=decUvarint(blob,pos),ln=Number(x[0]);pos=x[1];vals.push(p+blob.toString('utf8',pos,pos+ln));pos+=ln;}return vals;}if(enc==='front')return decodeFrontStrings(blob,n);if(enc==='msgpack')return msgpack.decode(blob);bad(`unknown column encoding ${label(enc)}`);}
function encodeSchemaSeq(seq,count){const bits=bitsNeeded(count),packed=bitpack(seq,bits),c=[[{enc:'bitpack',bits,n:seq.length},packed]];const[runs,rb]=encodeRuns(seq,v=>encUvarint(v));c.push([{enc:'rle',runs,n:seq.length},rb]);return choose(c);}
function decodeSchemaSeq(meta,blob){if(meta.enc==='bitpack')return bitunpack(blob,meta.n,meta.bits);if(meta.enc==='rle')return decodeRuns(blob,meta.runs,b=>Number(decUvarint(b,0)[0]),meta.n);bad(`unknown schema-sequence encoding ${label(meta.enc)}`);}
function pathKey(p){return JSON.stringify(p);}
function encode(records){const recordFlat=[],schemaMap=new Map(),schemaPaths=[],schemaSeq=[];for(const rec of records){const leaves=new Map(flattenLeaves(rec).map(([p,v])=>[pathKey(p),{path:p,value:v}]));recordFlat.push(leaves);const keys=[...leaves.keys()].sort(),sig=JSON.stringify(keys);let sid=schemaMap.get(sig);if(sid===undefined){sid=schemaPaths.length;schemaMap.set(sig,sid);schemaPaths.push(keys);}schemaSeq.push(sid);}
  const allKeys=[...new Set(schemaPaths.flat())].sort(),paths=allKeys.map(k=>JSON.parse(k)),pathId=new Map(allKeys.map((k,i)=>[k,i])),schemas=schemaPaths.map(sig=>sig.map(k=>pathId.get(k)));const columns=new Map(allKeys.map(k=>[k,[]]));for(const leaves of recordFlat)for(const[k,o]of leaves)columns.get(k).push(o.value);
  const data=[],colMeta=[],encCounts={};let offset=0;for(const k of allKeys){const[meta,blob]=encodeColumn(columns.get(k));encCounts[meta.enc]=(encCounts[meta.enc]||0)+1;meta.offset=offset;meta.length=blob.length;offset+=blob.length;colMeta.push(meta);data.push(blob);}const[smeta,sblob]=encodeSchemaSeq(schemaSeq,schemaPaths.length);const metadata={version:4,record_count:records.length,paths,schemas,schema_seq:smeta,schema_seq_len:sblob.length,columns:colMeta};const mb=msgpack.encode(metadata),ml=Buffer.alloc(4);ml.writeUInt32BE(mb.length);return{buffer:Buffer.concat([MAGIC,ml,mb,sblob,...data]),encCounts};}
function decode(buf0){
  const buf=Buffer.from(buf0);
  if(buf.length<8) bad('stream is too short to hold a header');
  if(!buf.subarray(0,4).equals(MAGIC)) throw new Error('Not SLC4');
  const ml=buf.readUInt32BE(4);
  if(8+ml>buf.length) bad(`metadata claims ${ml} bytes but only ${buf.length-8} remain`);
  const meta=msgpack.decode(buf.subarray(8,8+ml));

  if(!Array.isArray(meta.paths)) bad('metadata has no path table');
  if(!Array.isArray(meta.schemas)) bad('metadata has no schema registry');
  if(!Array.isArray(meta.columns)) bad('metadata has no column table');
  if(!meta.schema_seq||typeof meta.schema_seq!=='object') bad('metadata has no schema-sequence descriptor');
  checkCount(meta.paths.length,LIMITS.maxPaths,'path count');
  checkCount(meta.schemas.length,LIMITS.maxSchemas,'schema count');
  if(meta.columns.length!==meta.paths.length) bad(`${meta.columns.length} columns for ${meta.paths.length} paths`);
  for(const path of meta.paths){
    if(!Array.isArray(path)||!path.length||!path.every(k=>typeof k==='string')) bad('path table holds a malformed entry');
  }
  for(const schema of meta.schemas){
    if(!Array.isArray(schema)) bad('schema registry holds a malformed entry');
    for(const pid of schema) if(!Number.isInteger(pid)||pid<0||pid>=meta.paths.length) bad(`schema references path ${pid}, which does not exist`);
  }

  let pos=8+ml;
  const sl=meta.schema_seq_len;
  if(!Number.isInteger(sl)||sl<0||pos+sl>buf.length) bad('schema sequence extends past the end of the stream');
  const sblob=buf.subarray(pos,pos+sl); pos+=sl;
  const data=buf.subarray(pos);

  const sseq=decodeSchemaSeq(meta.schema_seq,sblob);
  const cols=[];
  for(const cm of meta.columns){
    if(!cm||typeof cm!=='object') bad('column table holds a malformed entry');
    const off=cm.offset, len=cm.length;
    if(!Number.isInteger(off)||!Number.isInteger(len)||off<0||len<0||off+len>data.length){
      bad(`column spans bytes ${off}..${off+len} of a ${data.length}-byte payload`);
    }
    cols.push(decodeColumn(cm,data.subarray(off,off+len)));
  }

  const paths=meta.paths, curs=Array(paths.length).fill(0), out=[];
  for(const sid of sseq){
    if(!Number.isInteger(sid)||sid<0||sid>=meta.schemas.length) bad(`record references schema ${sid}, which does not exist`);
    const rec=Object.create(null);
    for(const pid of meta.schemas[sid]){
      if(curs[pid]>=cols[pid].length) bad(`column "${paths[pid].join('.')}" ran out of values before every record was rebuilt`);
      setNested(rec,paths[pid],cols[pid][curs[pid]++]);
    }
    out.push(rec);
  }
  return out;
}
function inspect(buf0){
  const buf=Buffer.from(buf0);
  if(buf.length<8) bad('stream is too short to hold a header');
  if(!buf.subarray(0,4).equals(MAGIC)) throw new Error('Not SLC4');
  const ml=buf.readUInt32BE(4);
  if(8+ml>buf.length) bad(`metadata claims ${ml} bytes but only ${buf.length-8} remain`);
  return msgpack.decode(buf.subarray(8,8+ml));
}
export {MAGIC,setSelectionMode,encode,decode,inspect,zstdCompress,flattenLeaves};
