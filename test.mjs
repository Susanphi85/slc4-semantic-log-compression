// Regression suite for the browser-side SLC4 stack in web/lib.
//
// The point of this suite is compatibility: the codec was moved off Node's
// Buffer so it could run in a browser, and every check below exists to prove
// that the move did not change a single byte of the format.
//
//   node test.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
const stable = (v) => Array.isArray(v) ? v.map(stable)
  : (v && typeof v === 'object' && !(v instanceof Uint8Array)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]))
    : v);
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// ---------------------------------------------------------------------------
// A child run with globalThis.Buffer removed exercises the exact code path a
// browser takes, where the Buffer shim is the only implementation available.
// ---------------------------------------------------------------------------
if (process.argv.includes('--shim-child')) {
  delete globalThis.Buffer;
  const codec = await import('./web/lib/slc4_codec.js');
  const zstd = await import('./web/lib/zstd-node.js');
  codec.setZstdCompress(zstd.compress);
  const { Buffer: NodeBuffer } = await import('node:buffer');
  const records = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8'));
  const out = {};
  for (const mode of ['raw', 'zstd']) {
    codec.setSelectionMode(mode);
    const { buffer } = codec.encode(records);
    out[mode] = {
      sha256: crypto.createHash('sha256').update(NodeBuffer.from(buffer)).digest('hex'),
      bytes: buffer.length,
      roundTrip: JSON.stringify(stable(codec.decode(buffer))) === JSON.stringify(stable(records)),
    };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const codec = await import('./web/lib/slc4_codec.js');
const arc = await import('./web/lib/slc4_archive.js');
const zstdNode = await import('./web/lib/zstd-node.js');
const newmp = await import('./web/lib/msgpack.js');
const B = await import('./web/lib/bytes.js');
arc.setZstd(zstdNode);

const records = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8'));
const rawInput = fs.readFileSync(path.join(FIXTURES, 'sample.json'));
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden.json'), 'utf8'));

// ---------------------------------------------------------------------------
section('Format is unchanged (golden fixtures)');
for (const mode of ['raw', 'zstd']) {
  codec.setSelectionMode(mode);
  const { buffer } = codec.encode(records);
  check(`${mode}: archive is byte-identical to the reference`, sha(buffer) === golden[mode].sha256, `${buffer.length} B vs ${golden[mode].bytes} B`);
  check(`${mode}: semantic round-trip`, same(codec.decode(buffer), records));
  const ref = new Uint8Array(fs.readFileSync(path.join(FIXTURES, `golden.${mode}.slc4`)));
  check(`${mode}: decodes a stream written before the port`, same(codec.decode(ref), records));
}

// ---------------------------------------------------------------------------
section('Browser path (Buffer shim only) produces the same bytes');
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--shim-child'], { encoding: 'utf8' });
  if (r.status !== 0) {
    check('shim child ran', false, (r.stderr || '').split('\n').slice(-4).join(' '));
  } else {
    const shim = JSON.parse(r.stdout);
    for (const mode of ['raw', 'zstd']) {
      check(`${mode}: shim archive matches the reference`, shim[mode].sha256 === golden[mode].sha256);
      check(`${mode}: shim round-trip`, shim[mode].roundTrip === true);
    }
  }
}

// ---------------------------------------------------------------------------
section('.slc4z container interoperates with the Node implementation');
{
  const oldSrv = require('./server.js');
  const oldCodec = require('./slc4_codec.js');
  for (const selection of ['raw', 'zstd']) {
    for (const level of [3, 19]) {
      const tag = `selection=${selection} zstd=${level}`;
      const [, oldSlc4, oldArchive] = oldSrv.analyzeBytes(rawInput, 'sample.json', selection, level);
      const { slc4, archive } = arc.analyze(new Uint8Array(rawInput), 'sample.json', selection, level);
      check(`${tag}: SLC4 stream identical`, sha(oldSlc4) === sha(slc4));
      check(`${tag}: archive identical`, sha(oldArchive) === sha(archive));
      check(`${tag}: web reads the Node archive`, same(arc.unpackArchive(new Uint8Array(oldArchive)).records, records));
      const [header, payload] = oldSrv.openArchive(Buffer.from(archive));
      check(`${tag}: Node reads the web archive`, header.record_count === records.length && same(oldCodec.decode(payload), records));
    }
  }
}

// ---------------------------------------------------------------------------
section('MessagePack matches the original implementation');
{
  const oldmp = require('./msgpack.js');
  const norm = x => typeof x === 'bigint' ? x + 'n'
    : x instanceof Uint8Array ? 'bin:' + Buffer.from(x).toString('hex')
      : Array.isArray(x) ? x.map(norm)
        : (x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])])) : x);
  const cases = [0, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, -1, -32, -33, -128, -129,
    -32768, -32769, -2147483648, -2147483649, 9007199254740991, 1.5, -1e308, 5e-324,
    '', 'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(255), 'a'.repeat(65536), 'zażółć gęślą jaźń',
    [], {}, new Uint8Array(0), new Uint8Array(256), Array.from({ length: 65536 }, (_, i) => i % 7),
    { a: [1, { b: null }], c: true }];
  let encMismatch = 0, decMismatch = 0;
  for (const v of cases) {
    const a = oldmp.encode(v), b = newmp.encode(v);
    if (Buffer.compare(a, Buffer.from(b)) !== 0) { encMismatch++; continue; }
    if (JSON.stringify(norm(oldmp.decode(a))) !== JSON.stringify(norm(newmp.decode(b)))) decMismatch++;
  }
  check(`encoding identical across ${cases.length} values`, encMismatch === 0, `${encMismatch} mismatches`);
  check('decoding identical', decMismatch === 0, `${decMismatch} mismatches`);
}

// ---------------------------------------------------------------------------
section('Input shapes');
{
  const one = { a: 1, b: 'x', c: { d: [1, 2] } };
  const jsonl = records.slice(0, 40).map(r => JSON.stringify(r)).join('\n');
  const shapes = [
    ['JSON object', Buffer.from(JSON.stringify(one)), 'json-object', 1],
    ['JSON array', Buffer.from(JSON.stringify(records.slice(0, 40))), 'json-array', 40],
    ['JSONL', Buffer.from(jsonl), 'jsonl', 40],
  ];
  for (const [name, buf, fmt, n] of shapes) {
    const { archive } = arc.analyze(new Uint8Array(buf), `${name}.json`, 'zstd', 9);
    const back = arc.unpackArchive(archive);
    check(`${name}: detected and round-trips`, back.header.input_format === fmt && back.records.length === n);
  }
  check('empty input is rejected', (() => { try { arc.parseJsonInput(new Uint8Array(0)); return false; } catch { return true; } })());
  check('array of non-objects is rejected', (() => { try { arc.parseJsonInput(Buffer.from('[1,2,3]')); return false; } catch { return true; } })());
}

// ---------------------------------------------------------------------------
section('Hostile and corrupt archives fail cleanly');
{
  const base = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'golden.raw.slc4')));
  const clean = /^SLC4:|^Not SLC4$|MessagePack|uvarint|Truncated|out of the bounds|Invalid typed array|Offset is outside/;
  let oom = 0, weird = 0, slow = 0, rejected = 0, decoded = 0;
  const rnd = n => Math.floor(Math.random() * n);
  for (let i = 0; i < 1500; i++) {
    const b = base.slice();
    let input;
    if (i % 3 === 0) { for (let k = 0; k < 1 + rnd(6); k++) b[rnd(Math.min(2048, b.length))] = rnd(256); input = b; }
    else if (i % 3 === 1) { for (let k = 0; k < 1 + rnd(10); k++) b[rnd(b.length)] = rnd(256); input = b; }
    else input = b.subarray(0, 8 + rnd(b.length - 8));
    const t0 = Date.now();
    try { codec.decode(input); decoded++; }
    catch (e) {
      const m = String(e && e.message);
      if (e instanceof RangeError && /allocation failed|Invalid (typed )?array length|out of memory/i.test(m)) oom++;
      else if (clean.test(m)) rejected++;
      else weird++;
    }
    if (Date.now() - t0 > 1500) slow++;
  }
  check('no allocation blow-ups', oom === 0, `${oom} cases`);
  check('no unexpected error types', weird === 0, `${weird} cases`);
  check('no decode stalls', slow === 0, `${slow} cases`);
  check('corrupt streams are rejected or decoded, never hang', rejected + decoded + oom + weird + slow === 1500);

  check('oversized archive is refused before decompression',
    (() => { try { arc.openArchive(new Uint8Array(arc.LIMITS.maxArchiveBytes + 1)); return false; } catch (e) { return /above the/.test(e.message); } })());
  check('non-archive input is refused',
    (() => { try { arc.openArchive(zstdNode.compress(Buffer.from('definitely not an archive'), 1)); return false; } catch (e) { return /Not an SLC4Z/.test(e.message); } })());
}

// ---------------------------------------------------------------------------
section('The WebAssembly build the browser actually loads');
{
  // The vendored glue fetches its .wasm over HTTP, which Node cannot do for a
  // file: URL -- the instantiateWasm hook lets the very same binary be loaded
  // from disk, so this section tests the real browser backend, not a stand-in.
  const { Module } = await import('./web/lib/zstd/module.js');
  const wasmBytes = fs.readFileSync(path.join(HERE, 'web', 'lib', 'zstd', 'zstd.wasm'));
  Module['instantiateWasm'] = (imports, receive) => {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), imports);
    receive(inst);
    return inst.exports;
  };
  const zstdWasm = await import('./web/lib/zstd-wasm.js');
  await zstdWasm.init();

  const probe = Buffer.from('repeatable payload '.repeat(500));
  check('wasm compress/decompress round-trips',
    Buffer.compare(probe, Buffer.from(zstdWasm.decompress(zstdWasm.compress(new Uint8Array(probe), 19)))) === 0);

  // Two zstd builds at the same level may emit different -- both valid --
  // frames, so the guarantee that matters is mutual readability, not equal
  // bytes. Every packer/reader pairing is checked here.
  const made = {};
  for (const [name, backend] of [['node', zstdNode], ['wasm', zstdWasm]]) {
    arc.setZstd(backend);
    made[name] = arc.analyze(new Uint8Array(rawInput), 'sample.json', 'zstd', 19);
  }
  check('both backends select identical codecs',
    JSON.stringify(made.node.result.encodings) === JSON.stringify(made.wasm.result.encodings));
  check('both backends emit an identical SLC4 semantic stream',
    sha(made.node.slc4) === sha(made.wasm.slc4), `${made.node.slc4.length} B vs ${made.wasm.slc4.length} B`);

  for (const packer of ['node', 'wasm']) {
    for (const [reader, backend] of [['node', zstdNode], ['wasm', zstdWasm]]) {
      arc.setZstd(backend);
      check(`archive packed by ${packer} reads back under ${reader}`,
        same(arc.unpackArchive(new Uint8Array(made[packer].archive)).records, records));
    }
  }
  arc.setZstd(zstdNode);
}

// ---------------------------------------------------------------------------
section('Tabular input: CSV');
{
  const packUnpack = (bytes, filename, options = {}) => {
    const { records, inputFormat, meta } = arc.parseInput(bytes, { ...options, filename });
    codec.setSelectionMode('zstd');
    const { buffer } = codec.encode(records);
    const archive = arc.makeArchive(buffer, inputFormat, filename, records.length, 9, meta);
    const back = arc.unpackArchive(archive);
    return { records, inputFormat, back, archive };
  };

  const cases = [
    ['comma, header, trailing newline', 'id,name,city\n1,Anna,Warszawa\n2,Piotr,Krakow\n'],
    ['semicolon', 'a;b;c\n1;2;3\n4;5;6\n'],
    ['tab', 'a\tb\n1\t2\n3\t4\n'],
    ['CRLF', 'a,b\r\n1,2\r\n3,4\r\n'],
    ['no trailing newline', 'a,b\n1,2\n3,4'],
    ['quoted values', 'a,b\n"has, comma","has ""quote"""\n"two\nlines",x\n'],
    ['empty fields', 'a,b,c\n1,,3\n,,\n'],
    ['non-ASCII', 'imie,miasto\nZazolc,Gesla Jazn\nGrzegorz,Lodz\n'],
    ['BOM', '﻿a,b\n1,2\n3,4\n'],
    ['no header row', '1,2,3\n4,5,6\n7,8,9\n'],
  ];
  for (const [name, text] of cases) {
    const bytes = B.fromString(text);
    const { back, inputFormat } = packUnpack(bytes, 'sample.csv');
    check(`CSV ${name}: format detected`, inputFormat === 'csv', inputFormat);
    check(`CSV ${name}: byte-identical round-trip`, B.equals(bytes, back.payload));
  }

  // Text is preserved exactly, which is the whole reason values stay strings.
  const { records } = arc.parseInput(B.fromString('code,amount\n0042,1.50\n0043,2.00\n'), { filename: 'x.csv' });
  check('CSV keeps leading zeros', records[0].code === '0042', records[0].code);
  check('CSV keeps trailing decimal zeros', records[0].amount === '1.50', records[0].amount);

  const inferred = arc.parseInput(B.fromString('code,amount,n\n0042,1.50,7\n0043,2.00,8\n'),
    { filename: 'x.csv', inferTypes: true }).records;
  check('CSV --infer converts plain integers', inferred[0].n === 7, String(inferred[0].n));
  check('CSV --infer leaves ambiguous text alone', inferred[0].code === '0042' && inferred[0].amount === '1.50');

  // Inference must never break the byte-exact guarantee, so every form whose
  // numeric round-trip would change the text has to stay text.
  const tricky = ['a,b,c,d,e', '-0,1e5,+7,9007199254740993,-12', '0,2,3,4,5', ''].join('\n');
  const t = arc.parseInput(B.fromString(tricky), { filename: 't.csv', inferTypes: true });
  check('CSV --infer leaves "-0" alone', t.records[0].a === '-0', JSON.stringify(t.records[0].a));
  check('CSV --infer leaves exponent form alone', t.records[0].b === '1e5', JSON.stringify(t.records[0].b));
  check('CSV --infer leaves a leading plus alone', t.records[0].c === '+7', JSON.stringify(t.records[0].c));
  check('CSV --infer leaves unsafe integers alone', t.records[0].d === '9007199254740993', JSON.stringify(t.records[0].d));
  check('CSV --infer still round-trips byte-identically',
    B.equals(B.fromString(tricky), arc.serializeRecords(t.records, 'csv', true, t.meta)));

  const arch = packUnpack(B.fromString('a;b\n1;2\n3;4\n'), 'semi.csv').back;
  check('CSV dialect travels in the archive header', arch.header.dialect && arch.header.dialect.delimiter === ';',
    JSON.stringify(arch.header.dialect && arch.header.dialect.delimiter));
  check('CSV unpacks under its own extension', arch.filename.endsWith('.csv'), arch.filename);
}

// ---------------------------------------------------------------------------
section('Tabular input: PostgreSQL dumps');
{
  const tab = '\t';
  const dump = [
    '--', '-- PostgreSQL database dump', '--', '',
    "SET client_encoding = 'UTF8';", '',
    'CREATE TABLE public.orders (', '    id integer NOT NULL,', '    email text,', '    note text', ');', '',
    'COPY public.orders (id, email, note) FROM stdin;',
    `1${tab}anna@example.com${tab}plain note`,
    `2${tab}piotr@example.com${tab}\\N`,
    `3${tab}ewa@example.com${tab}with\\ttab and\\nnewline`,
    '\\.', '',
    'COPY public.items (sku, qty) FROM stdin;',
    `ABC-1${tab}5`,
    `ABC-2${tab}12`,
    '\\.', '',
    'ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);', '',
  ].join('\n');

  const bytes = B.fromString(dump);
  const { records, inputFormat, meta } = arc.parseInput(bytes, { filename: 'dump.sql' });
  check('SQL format detected', inputFormat === 'sql', inputFormat);
  check('SQL rows lifted from both COPY blocks', records.length === 5, String(records.length));
  check('SQL maps \\N to null', records[1].note === null, JSON.stringify(records[1].note));
  check('SQL decodes COPY escapes', records[2].note === 'with\ttab and\nnewline', JSON.stringify(records[2].note));
  check('SQL second table becomes a second schema',
    Object.keys(records[3]).join(',') === 'sku,qty', Object.keys(records[3]).join(','));

  codec.setSelectionMode('zstd');
  const { buffer } = codec.encode(records);
  const archive = arc.makeArchive(buffer, inputFormat, 'dump.sql', records.length, 9, meta);
  const back = arc.unpackArchive(archive);
  check('SQL byte-identical round-trip, DDL included', B.equals(bytes, back.payload));
  check('SQL unpacks under its own extension', back.filename.endsWith('.sql'), back.filename);

  // A dump with no data at all still has to survive intact.
  const ddlOnly = B.fromString('CREATE TABLE x (a int);\nALTER TABLE x OWNER TO postgres;\n');
  const p2 = arc.parseInput(ddlOnly, { filename: 'ddl.sql' });
  check('SQL with no rows parses to zero records', p2.records.length === 0, String(p2.records.length));
  check('SQL with no rows still reassembles',
    B.equals(ddlOnly, arc.serializeRecords(p2.records, 'sql', true, p2.meta)));

  const inserts = B.fromString(
    "SET client_encoding = 'UTF8';\n" +
    "INSERT INTO public.t (id, name, note) VALUES (1, 'Anna', NULL);\n" +
    "INSERT INTO public.t (id, name, note) VALUES (2, 'O''Brien', 'text');\n");
  const p3 = arc.parseInput(inserts, { filename: 'ins.sql' });
  check('SQL INSERT statements become records', p3.records.length === 2, String(p3.records.length));
  check('SQL INSERT unescapes doubled apostrophes', p3.records[1].name === "O'Brien", p3.records[1].name);
  check('SQL INSERT byte-identical round-trip',
    B.equals(inserts, arc.serializeRecords(p3.records, 'sql', true, p3.meta)));
}

// ---------------------------------------------------------------------------
section('Format detection');
{
  const byName = [['a.csv', 'csv'], ['a.tsv', 'csv'], ['a.sql', 'sql'], ['a.jsonl', 'jsonl'],
    ['a.ndjson', 'jsonl'], ['a.json', 'json']];
  for (const [name, want] of byName) {
    check(`${name} -> ${want}`, arc.detectFormat(B.fromString('x'), name) === want,
      arc.detectFormat(B.fromString('x'), name));
  }
  const byContent = [
    ['{"a":1}', 'json'], ['[{"a":1}]', 'json'],
    ['-- PostgreSQL database dump\nSET x = 1;', 'sql'],
    ['COPY public.t (a) FROM stdin;\n\\.', 'sql'],
    ["SET client_encoding = 'UTF8';", 'sql'],
  ];
  for (const [text, want] of byContent) {
    check(`content ${JSON.stringify(text.slice(0, 24))} -> ${want}`,
      arc.detectFormat(B.fromString(text), 'noextension') === want,
      arc.detectFormat(B.fromString(text), 'noextension'));
  }
  check('explicit format wins over the file name',
    arc.parseInput(B.fromString('a,b\n1,2\n'), { filename: 'mislabelled.json', format: 'csv' }).inputFormat === 'csv');
}

console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
