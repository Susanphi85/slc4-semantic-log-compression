'use strict';
const codec=require('./slc4_codec');
const {makeArchive,openArchive}=require('./server');
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object'&&!Buffer.isBuffer(v)){const o={};for(const k of Object.keys(v).sort())o[k]=stable(v[k]);return o;}return v;}
function eq(a,b){return JSON.stringify(stable(a))===JSON.stringify(stable(b));}
const records=[
  {ts:'2026-09-11T12:00:00.001Z',status:200,id:'ABCDEF1234567890',nested:{},ip:'192.168.1.2',latency:'0.001230s'},
  {ts:'2026-09-11T12:00:00.002Z',status:200,id:'ABCDEF1234567891',nested:{},ip:'192.168.1.3',latency:'0.001231s'},
  {ts:'2026-09-11T12:00:00.003Z',status:404,id:'ABCDEF1234567892',nested:{},ip:'192.168.1.4',latency:'0.001240s'},
];
for(const mode of ['raw','zstd']){
  codec.setSelectionMode(mode);
  const {buffer}=codec.encode(records); const restored=codec.decode(buffer);
  if(!eq(records,restored)) throw new Error(`round-trip failed: ${mode}`);
  const arc=makeArchive(buffer,'json-array','test.json',records.length,3);
  const [header,payload]=openArchive(arc);
  if(header.record_count!==records.length || !eq(codec.decode(payload),records)) throw new Error('archive round-trip failed');
}
console.log('SLC4 JS self-test: OK');
