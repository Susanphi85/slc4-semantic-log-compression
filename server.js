'use strict';

const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const msgpack=require('./msgpack');
const zstd=require('./zstd');
const codec=require('./slc4_codec');

const BASE=__dirname, STATIC=path.join(BASE,'static');
const ARCHIVE_MAGIC=Buffer.from('SLCZ1');
const MAX_UPLOAD=Number(process.env.SLC4_MAX_UPLOAD||128*1024*1024);
const PORT=Number(process.env.PORT||8080);

function human(n){if(n<1024)return`${n} B`;if(n<1024**2)return`${(n/1024).toFixed(1)} KiB`;if(n<1024**3)return`${(n/1024**2).toFixed(2)} MiB`;return`${(n/1024**3).toFixed(2)} GiB`;}
function safeName(name){const base=path.basename(name||'archive');return (base.replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,180)||'archive');}
function zstdCompress(data,level=19){return zstd.compress(data,level);}
function zstdDecompress(data){return zstd.decompress(data);}
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object'&&!Buffer.isBuffer(v)){const o={};for(const k of Object.keys(v).sort())o[k]=stable(v[k]);return o;}return v;}
function semanticEqual(a,b){return JSON.stringify(stable(a))===JSON.stringify(stable(b));}
function canonicalJson(records){return Buffer.from(JSON.stringify(stable(records)),'utf8');}

function parseJsonInput(raw){let text=raw.toString('utf8');if(text.charCodeAt(0)===0xfeff)text=text.slice(1);const stripped=text.trim();if(!stripped)throw new Error('Input is empty');try{const obj=JSON.parse(stripped);if(Array.isArray(obj)){if(!obj.every(x=>x&&typeof x==='object'&&!Array.isArray(x)))throw new Error('Top-level JSON array must contain objects');return[ obj,'json-array'];}if(obj&&typeof obj==='object')return[[obj],'json-object'];throw new Error('Expected a JSON object, an array of objects, or JSONL objects');}catch(e){if(!(e instanceof SyntaxError))throw e;}
  const records=[];for(const [i,line] of text.split(/\r?\n/).entries()){if(!line.trim())continue;let item;try{item=JSON.parse(line);}catch(e){throw new Error(`Invalid JSONL at line ${i+1}: ${e.message}`);}if(!item||typeof item!=='object'||Array.isArray(item))throw new Error(`JSONL line ${i+1} is not a JSON object`);records.push(item);}if(!records.length)throw new Error('No JSONL records found');return[records,'jsonl'];}
function serializeRecords(records,inputFormat,pretty=true){if(inputFormat==='jsonl')return Buffer.from(records.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');const obj=inputFormat==='json-object'?(records[0]||{}):records;return Buffer.from(JSON.stringify(obj,null,pretty?2:0),'utf8');}
function makeArchive(slc4,inputFormat,sourceName,recordCount,level){const header={format:'SLC4Z',version:1,codec:4,input_format:inputFormat,source_name:sourceName,record_count:recordCount,zstd_level:level};const hb=msgpack.encode(header),n=Buffer.alloc(4);n.writeUInt32BE(hb.length);return zstdCompress(Buffer.concat([ARCHIVE_MAGIC,n,hb,slc4]),level);}
function openArchive(blob){const raw=zstdDecompress(blob);if(!raw.subarray(0,5).equals(ARCHIVE_MAGIC))throw new Error('Not an SLC4Z archive');if(raw.length<9)throw new Error('Truncated SLC4Z archive');const hlen=raw.readUInt32BE(5);if(raw.length<9+hlen)throw new Error('Truncated SLC4Z header');const header=msgpack.decode(raw.subarray(9,9+hlen)),slc4=raw.subarray(9+hlen);if(!slc4.subarray(0,4).equals(codec.MAGIC))throw new Error('SLC4 payload missing');return[header,slc4];}
function slc4Details(slc4){const meta=codec.inspect(slc4),columns=meta.paths.map((p,i)=>{const cm=meta.columns[i];return{path:p.join('.'),encoding:cm.enc,values:cm.n,bytes:cm.length,human:human(cm.length)};}).sort((a,b)=>b.bytes-a.bytes);return{record_count:meta.record_count,schema_count:meta.schemas.length,field_count:meta.paths.length,schema_encoding:meta.schema_seq.enc,columns};}
function analyzeBytes(raw,filename,selection,zstdLevel){const [records,inputFormat]=parseJsonInput(raw);if(!records.length)throw new Error('No records');const canonical=canonicalJson(records);codec.setSelectionMode(selection);
  let t=performance.now();const {buffer:slc4,encCounts}=codec.encode(records),encodeS=(performance.now()-t)/1000;t=performance.now();const restored=codec.decode(slc4),decodeS=(performance.now()-t)/1000;if(!semanticEqual(restored,records))throw new Error('Round-trip verification failed');
  t=performance.now();const rawZ=zstdCompress(raw,zstdLevel),rawZS=(performance.now()-t)/1000;t=performance.now();const canZ=zstdCompress(canonical,zstdLevel),canZS=(performance.now()-t)/1000;t=performance.now();const archive=makeArchive(slc4,inputFormat,filename,records.length,zstdLevel),archiveZS=(performance.now()-t)/1000;
  const d=slc4Details(slc4),sizes={input:raw.length,canonical:canonical.length,slc4:slc4.length,input_zstd:rawZ.length,canonical_zstd:canZ.length,slc4z:archive.length},result={filename,input_format:inputFormat,round_trip:true,selection,zstd_level:zstdLevel,records:d.record_count,schemas:d.schema_count,fields:d.field_count,schema_encoding:d.schema_encoding,encodings:encCounts,sizes:Object.fromEntries(Object.entries(sizes).map(([k,v])=>[k,{bytes:v,human:human(v),pct_input:+(100*v/raw.length).toFixed(3)}])),ratios:{input_to_slc4z:+(raw.length/archive.length).toFixed(3),vs_canonical_zstd_smaller_pct:+((1-archive.length/canZ.length)*100).toFixed(3),vs_input_zstd_smaller_pct:+((1-archive.length/rawZ.length)*100).toFixed(3)},timings:{encode_s:+encodeS.toFixed(4),decode_s:+decodeS.toFixed(4),input_zstd_s:+rawZS.toFixed(4),canonical_zstd_s:+canZS.toFixed(4),archive_zstd_s:+archiveZS.toFixed(4)},columns:d.columns.slice(0,50)};return[result,slc4,archive];}

function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let total=0;req.on('data',c=>{total+=c.length;if(total>MAX_UPLOAD){reject(Object.assign(new Error(`File too large; max ${human(MAX_UPLOAD)}`),{status:413}));req.destroy();return;}chunks.push(c);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});}
function json(res,status,obj){const b=Buffer.from(JSON.stringify(obj));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});res.end(b);}
function sendFile(res,file,contentType='text/html; charset=utf-8'){const b=fs.readFileSync(file);res.writeHead(200,{'Content-Type':contentType,'Content-Length':b.length});res.end(b);}
function sendBinary(res,status,b,headers={}){res.writeHead(status,{'Content-Type':'application/octet-stream','Content-Length':b.length,...headers});res.end(b);}
function qparams(url){const u=new URL(url,'http://localhost');return u;}
function paramsFor(u){const selection=u.searchParams.get('selection')||'zstd',zstdLevel=Number(u.searchParams.get('zstd_level')||19),filename=u.searchParams.get('filename')||'input.json';if(!['raw','zstd'].includes(selection))throw new Error('selection must be raw or zstd');if(!Number.isInteger(zstdLevel)||zstdLevel<1||zstdLevel>22)throw new Error('zstd_level must be 1..22');return{selection,zstdLevel,filename};}

const server=http.createServer(async(req,res)=>{try{const u=qparams(req.url);if(req.method==='GET'&&u.pathname==='/')return sendFile(res,path.join(STATIC,'index.html'));if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,codec:4,backend:'nodejs',node:process.version,max_upload:MAX_UPLOAD});if(req.method==='GET'&&u.pathname.startsWith('/static/')){const name=path.basename(u.pathname),file=path.join(STATIC,name);if(fs.existsSync(file))return sendFile(res,file,name.endsWith('.js')?'application/javascript':'text/plain');}
    if(req.method!=='POST')return json(res,404,{detail:'Not found'});const raw=await readBody(req);
    if(u.pathname==='/api/analyze'){const{selection,zstdLevel,filename}=paramsFor(u),[result]=analyzeBytes(raw,filename,selection,zstdLevel);return json(res,200,result);}
    if(u.pathname==='/api/pack'){const{selection,zstdLevel,filename}=paramsFor(u),[result,,archive]=analyzeBytes(raw,filename,selection,zstdLevel),base=path.parse(safeName(filename)).name;return sendBinary(res,200,archive,{'Content-Disposition':`attachment; filename="${base}.slc4z"`,'X-SLC4-Ratio':String(result.ratios.input_to_slc4z),'X-SLC4-Records':String(result.records)});}
    if(u.pathname==='/api/inspect-archive'){const[header,slc4]=openArchive(raw),details=slc4Details(slc4),restored=codec.decode(slc4);return json(res,200,{...details,header,archive_bytes:raw.length,archive_human:human(raw.length),round_trip_decodable:restored.length===details.record_count,columns:details.columns.slice(0,50)});}
    if(u.pathname==='/api/unpack'){const[header,slc4]=openArchive(raw),records=codec.decode(slc4),payload=serializeRecords(records,header.input_format||'json-array',true),original=path.parse(safeName(header.source_name||'unpacked.json')),suffix=header.input_format==='jsonl'?'.jsonl':'.json',outName=`${original.name}.unpacked${suffix}`;res.writeHead(200,{'Content-Type':header.input_format==='jsonl'?'application/x-ndjson; charset=utf-8':'application/json; charset=utf-8','Content-Length':payload.length,'Content-Disposition':`attachment; filename="${outName}"`,'X-SLC4-Records':String(records.length)});return res.end(payload);}
    return json(res,404,{detail:'Not found'});
  }catch(e){console.error(e);return json(res,e.status||400,{detail:e.message||String(e)});}});

if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`SLC4 JS web packer: http://127.0.0.1:${PORT}`));
module.exports={server,parseJsonInput,serializeRecords,makeArchive,openArchive,analyzeBytes,slc4Details};
