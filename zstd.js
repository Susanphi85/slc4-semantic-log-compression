'use strict';
const zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');

const hasNative=typeof zlib.zstdCompressSync==='function' && typeof zlib.zstdDecompressSync==='function';
function compress(data,level=19){
  level=Math.max(1,Math.min(22,Number(level)||19));
  if(hasNative){return zlib.zstdCompressSync(data,{params:{[zlib.constants.ZSTD_c_compressionLevel]:level}});}
  const p=spawnSync('zstd',[`-${level}`,'--stdout','--quiet'],{input:data,maxBuffer:Math.max(64*1024*1024,data.length*2+1024*1024)});
  if(p.error)throw new Error(`Native Node ZSTD unavailable and zstd CLI failed: ${p.error.message}`);
  if(p.status!==0)throw new Error((p.stderr||Buffer.alloc(0)).toString('utf8')||`zstd exited ${p.status}`);
  return p.stdout;
}
function decompress(data){
  if(hasNative)return zlib.zstdDecompressSync(data);
  const p=spawnSync('zstd',['-d','--stdout','--quiet'],{input:data,maxBuffer:1024*1024*1024});
  if(p.error)throw new Error(`Native Node ZSTD unavailable and zstd CLI failed: ${p.error.message}`);
  if(p.status!==0)throw new Error((p.stderr||Buffer.alloc(0)).toString('utf8')||`zstd exited ${p.status}`);
  return p.stdout;
}
module.exports={compress,decompress,hasNative};
