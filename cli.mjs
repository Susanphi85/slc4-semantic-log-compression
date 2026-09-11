#!/usr/bin/env node
// SLC4 command line tool.
//
// Uses the same web/lib codec the browser runs, so anything measured here is
// what the web app produces, byte for byte.
//
// Diagnostics go to stderr and results to stdout, so `-` can be used for
// stdin/stdout and the tool composes in a pipeline.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as codec from './web/lib/slc4_codec.js';
import * as arc from './web/lib/slc4_archive.js';
import * as zstd from './web/lib/zstd-node.js';

arc.setZstd(zstd);

const VERSION = '0.4.0';
const err = (...a) => process.stderr.write(a.join(' ') + '\n');

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else if (a.startsWith('-') && a.length === 2 && a !== '-') {
      const short = { o: 'out', l: 'level', s: 'selection', f: 'format', q: 'quiet', h: 'help', v: 'version' }[a[1]];
      if (!short) usageError(`Unknown flag ${a}`);
      if (short === 'quiet' || short === 'help' || short === 'version') opts[short] = true;
      else opts[short] = argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

function usageError(msg) { err(`slc4: ${msg}`); err(`Try 'slc4 --help'.`); process.exit(2); }

const HELP = `slc4 ${VERSION} -- semantic compressor for structured logs and tables

USAGE
  slc4 pack     <input>  [-o <out.slc4z>] [options]
  slc4 unpack   <archive> [-o <out.json>] [--porcelain]
  slc4 inspect  <archive> [--json]
  slc4 bench    <file|dir> [options]
  slc4 selftest [<file>...]

  Use "-" as <input> or <archive> to read stdin, and "-o -" to write stdout.

INPUT FORMATS
  Detected from the file name, else from the first bytes:
    .json .jsonl .ndjson   JSON object, array of objects, or one per line
    .csv .tsv              delimiter, quoting, line ending and header sniffed
    .sql                   PostgreSQL dump; COPY blocks and simple INSERTs
                           become records, everything else is kept verbatim
  CSV and SQL values are read as text, so the file comes back byte-identical.
  Numeric-looking text is already encoded as integers by the uintstr and
  numtemplate codecs, so keeping it as text costs far less than it appears.

OPTIONS
  -s, --selection raw|zstd   Candidate scoring. "zstd" scores each candidate by
                             its size after ZSTD, "raw" by the semantic stream
                             alone. Default: zstd
  -l, --level <1..22>        Final ZSTD level. Default: 19
      --no-verify            Skip the decode-and-compare check after packing.
                             Packing verifies by default.
      --format <f>           Force the reader: json, jsonl, csv or sql
      --infer                csv: convert numeric-looking fields to numbers.
                             Only values that print back identically are
                             converted, so the round-trip stays byte-exact --
                             but the archive usually grows, because a column of
                             uniform text can end up holding both types.
  -q, --quiet                Suppress progress on stderr
      --json                 Machine-readable output (inspect, bench)
      --porcelain            unpack: also print "name TAB records TAB bytes" on
                             stdout, for callers that parse it
      --csv <file>           Write bench results as CSV
      --levels <a,b,...>     bench: ZSTD levels to sweep. Default: 3,19
      --selections <a,b>     bench: selection modes to sweep. Default: raw,zstd
  -h, --help                 This text
  -v, --version              Version

EXAMPLES
  slc4 pack logs.json -o logs.slc4z
  slc4 pack export.csv -o export.slc4z
  slc4 pack dump.sql -o dump.slc4z
  slc4 bench ./datasets --levels 3,9,19 --csv results.csv
  slc4 pack logs.json -o - | slc4 unpack - -o restored.json
`;

// --- io ---------------------------------------------------------------------
function readInput(name) {
  if (name === '-') return new Uint8Array(fs.readFileSync(0));
  if (!fs.existsSync(name)) usageError(`No such file: ${name}`);
  return new Uint8Array(fs.readFileSync(name));
}
function writeOutput(target, bytes) {
  if (target === '-') { process.stdout.write(Buffer.from(bytes)); return '<stdout>'; }
  fs.writeFileSync(target, Buffer.from(bytes));
  return target;
}
const human = arc.human;
const pct = (a, b) => `${((1 - a / b) * 100).toFixed(1)}%`;

function commonOpts(opts) {
  const selection = String(opts.selection ?? 'zstd');
  if (!['raw', 'zstd'].includes(selection)) usageError(`--selection must be raw or zstd, got ${selection}`);
  const level = Number(opts.level ?? 19);
  if (!Number.isInteger(level) || level < 1 || level > 22) usageError(`--level must be an integer 1..22, got ${opts.level}`);
  return { selection, level };
}

// --- commands ---------------------------------------------------------------
function cmdPack(opts) {
  const input = opts._[0];
  if (!input) usageError('pack needs an input file');
  const { selection, level } = commonOpts(opts);
  const raw = readInput(input);
  const name = input === '-' ? 'stdin.json' : path.basename(input);

  const t0 = performance.now();
  const { records, inputFormat, meta } = arc.parseInput(raw, {
    filename: name,
    format: opts.format,
    inferTypes: !!opts.infer,
  });
  codec.setSelectionMode(selection);
  const { buffer: slc4, encCounts } = codec.encode(records);
  const encodeS = (performance.now() - t0) / 1000;

  let verifyS = 0, byteExact = null;
  if (!opts['no-verify']) {
    const t1 = performance.now();
    const restored = codec.decode(slc4);
    if (!arc.semanticEqual(restored, records)) {
      err('slc4: round-trip verification FAILED; archive not written');
      process.exit(1);
    }
    // CSV and SQL are text formats, so the stronger question is whether the
    // file itself comes back unchanged, not just its values.
    byteExact = arc.serializeRecords(restored, inputFormat, true, meta);
    byteExact = byteExact.length === raw.length && byteExact.every((b, i) => b === raw[i]);
    verifyS = (performance.now() - t1) / 1000;
  }

  const archive = arc.makeArchive(slc4, inputFormat, name, records.length, level, meta);
  const target = opts.out ?? (input === '-' ? '-' : `${arc.stemOf(name)}.slc4z`);
  const written = writeOutput(target, archive);

  if (!opts.quiet) {
    err(`${name}: ${records.length.toLocaleString()} records, ${inputFormat}`);
    err(`  ${human(raw.length)} -> ${human(archive.length)}  (${(raw.length / archive.length).toFixed(2)}x)`);
    const verdict = opts['no-verify'] ? '  (round-trip NOT verified)'
      : `, verify ${verifyS.toFixed(2)}s, round-trip ok${byteExact === false ? ' (values only; the file will not come back byte-identical)' : byteExact ? ' and byte-identical' : ''}`;
    err(`  encode ${encodeS.toFixed(2)}s${verdict}`);
    err(`  codecs: ${Object.entries(encCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    err(`  -> ${written}`);
  }
}

function cmdUnpack(opts) {
  const input = opts._[0];
  if (!input) usageError('unpack needs an archive');
  const blob = readInput(input);
  const t0 = performance.now();
  const { header, records, payload, filename, innerName } = arc.unpackArchive(blob);
  const target = opts.out ?? (input === '-' ? '-' : filename);
  const written = writeOutput(target, payload);
  // One tab-separated line for callers that need the document's original name
  // and size without parsing human-readable output -- the Total Commander
  // plugin uses this to label the entry it shows.
  if (opts.porcelain && target !== '-') {
    process.stdout.write(`${innerName}\t${records.length}\t${payload.length}\n`);
  }
  if (!opts.quiet) {
    err(`${records.length.toLocaleString()} records, ${header.input_format}, ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    err(`  ${human(blob.length)} -> ${human(payload.length)}  -> ${written}`);
  }
}

function cmdInspect(opts) {
  const input = opts._[0];
  if (!input) usageError('inspect needs an archive');
  const d = arc.inspectArchive(readInput(input));
  if (opts.json) { process.stdout.write(JSON.stringify(d, null, 2) + '\n'); return; }
  const o = (s) => process.stdout.write(s + '\n');
  o(`archive       ${human(d.archive_bytes)}`);
  o(`records       ${d.record_count.toLocaleString()}`);
  o(`leaf schemas  ${d.schema_count}`);
  o(`fields        ${d.field_count}`);
  o(`schema seq    ${d.schema_encoding}`);
  o(`decodable     ${d.round_trip_decodable ? 'yes' : 'NO'}`);
  o(`header        ${JSON.stringify(d.header)}`);
  o('');
  o('largest columns');
  const w = Math.min(56, Math.max(4, ...d.columns.slice(0, 20).map(c => c.path.length)));
  for (const c of d.columns.slice(0, 20)) {
    o(`  ${c.path.slice(0, w).padEnd(w)}  ${c.encoding.padEnd(12)} ${String(c.values).padStart(9)}  ${c.human.padStart(10)}`);
  }
}

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (/\.(json|jsonl|ndjson|csv|tsv|sql)$/i.test(entry.name)) out.push(p);
  }
  return out.sort();
}

function cmdBench(opts) {
  const target = opts._[0];
  if (!target) usageError('bench needs a file or directory');
  if (!fs.existsSync(target)) usageError(`No such file or directory: ${target}`);

  const levels = String(opts.levels ?? '3,19').split(',').map(x => Number(x.trim()));
  const selections = String(opts.selections ?? 'raw,zstd').split(',').map(x => x.trim());
  for (const l of levels) if (!Number.isInteger(l) || l < 1 || l > 22) usageError(`--levels holds ${l}, outside 1..22`);
  for (const s of selections) if (!['raw', 'zstd'].includes(s)) usageError(`--selections holds ${s}`);

  const files = collectFiles(target);
  if (!files.length) usageError(`No .json/.jsonl/.ndjson files under ${target}`);
  if (!opts.quiet) err(`benchmarking ${files.length} file(s) x ${selections.length} selection(s) x ${levels.length} level(s)\n`);

  const rows = [];
  for (const file of files) {
    const raw = new Uint8Array(fs.readFileSync(file));
    for (const selection of selections) {
      for (const level of levels) {
        const label = `${path.basename(file)} ${selection} L${level}`;
        try {
          // In-place progress only makes sense on a terminal; piped or
          // redirected, the carriage returns would run every step together.
          const live = process.stderr.isTTY && !opts.quiet;
          const { result: r } = arc.analyze(raw, path.basename(file), selection, level,
            live ? (s) => process.stderr.write(`\r  ${label}: ${s}`.padEnd(78)) : () => {});
          if (live) process.stderr.write('\r'.padEnd(80) + '\r');
          rows.push({
            file, selection, level,
            records: r.records, schemas: r.schemas, fields: r.fields,
            input: r.sizes.input.bytes, input_zstd: r.sizes.input_zstd.bytes,
            canonical_zstd: r.sizes.canonical_zstd.bytes, slc4: r.sizes.slc4.bytes, slc4z: r.sizes.slc4z.bytes,
            ratio: r.ratios.input_to_slc4z,
            vs_canonical_zstd_pct: r.ratios.vs_canonical_zstd_smaller_pct,
            vs_input_zstd_pct: r.ratios.vs_input_zstd_smaller_pct,
            encode_s: r.timings.encode_s, decode_s: r.timings.decode_s,
            round_trip: r.round_trip, encodings: r.encodings, error: null,
          });
          if (!opts.quiet) {
            err(`  ${label.padEnd(42)} ${human(r.sizes.slc4z.bytes).padStart(10)}  ` +
                `${String(r.ratios.input_to_slc4z).padStart(8)}x  vs canonical+zstd ${String(r.ratios.vs_canonical_zstd_smaller_pct).padStart(6)}%`);
          }
        } catch (e) {
          rows.push({ file, selection, level, error: e.message });
          err(`  ${label.padEnd(42)} FAILED: ${e.message}`);
        }
      }
    }
  }

  if (opts.csv) {
    const cols = ['file', 'selection', 'level', 'records', 'schemas', 'fields', 'input', 'input_zstd',
      'canonical_zstd', 'slc4', 'slc4z', 'ratio', 'vs_canonical_zstd_pct', 'vs_input_zstd_pct',
      'encode_s', 'decode_s', 'round_trip', 'error'];
    const esc = (v) => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    fs.writeFileSync(opts.csv, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n');
    err(`\ncsv -> ${opts.csv}`);
  }
  if (opts.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');

  const failures = rows.filter(r => r.error || r.round_trip === false);
  if (!opts.quiet && rows.length > 1) {
    const best = rows.filter(r => !r.error).sort((a, b) => a.slc4z - b.slc4z)[0];
    if (best) err(`\nsmallest: ${path.basename(best.file)} ${best.selection} L${best.level} -> ${human(best.slc4z)}`);
  }
  if (failures.length) { err(`\n${failures.length} run(s) failed`); process.exit(1); }
}

// A standalone binary cannot rely on files sitting next to it, so with no
// arguments selftest generates a dataset that exercises every codec family and
// checks the round-trip against it.
function syntheticRecords(n = 800) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = {
      timestamp: new Date(Date.UTC(2026, 8, 11, 12, 0, 0) + i * 37).toISOString().replace('Z', (i % 3 ? '.123456' : '.1')) + 'Z',
      severity: ['INFO', 'INFO', 'INFO', 'WARNING', 'ERROR'][i % 5],   // dictionary
      insertId: 'abcdef0123456789' + String(i).padStart(16, '0'),       // hex
      trace: 'projects/p-1/traces/' + 'deadbeef'.repeat(4),             // prefix_hex
      remoteIp: `10.0.${i % 256}.${(i * 7) % 256}`,                     // ipv4
      latency: `${(i % 900) / 1000}s`,                                  // numeric template
      url: 'https://svc.example.com/api/v1/items/' + i,                 // front coding
      status: [200, 200, 404, 500][i % 4],                              // int dictionary
      counter: i * 3 - 500,                                             // delta
      ratio: i / 7,                                                     // float -> fallback
      ok: i % 2 === 0,                                                  // bit packing
      region: 'europe-central2',                                        // const
      tags: ['a', 'b', i % 2 ? 'c' : 'd'],
      empty: {},
      nothing: i % 11 ? null : 'x',
    };
    if (i % 13 === 0) delete r.url;          // second leaf schema
    if (i % 17 === 0) r.note = 'container startup';  // third
    out.push(r);
  }
  return out;
}

function cmdSelftest(opts) {
  const cases = opts._.length
    ? opts._.map(f => [path.basename(f), arc.parseJsonInput(new Uint8Array(fs.readFileSync(f)))[0]])
    : [['synthetic dataset', syntheticRecords()]];

  let bad = 0, n = 0;
  for (const [name, records] of cases) {
    for (const selection of ['raw', 'zstd']) {
      for (const level of [1, 19]) {
        n++;
        const tag = `${name} [${selection} L${level}]`;
        try {
          codec.setSelectionMode(selection);
          const { buffer } = codec.encode(records);
          const archive = arc.makeArchive(buffer, 'json-array', name, records.length, level);
          const back = arc.unpackArchive(archive);
          if (!arc.semanticEqual(back.records, records)) throw new Error('round-trip mismatch');
          err(`  ok    ${tag.padEnd(44)} ${String(records.length).padStart(6)} records  ${human(archive.length).padStart(10)}`);
        } catch (e) { bad++; err(`  FAIL  ${tag.padEnd(44)} ${e.message}`); }
      }
    }
  }
  // A corrupt archive must fail cleanly rather than take the process down.
  n++;
  try {
    const junk = new Uint8Array(64).fill(0x5a);
    arc.openArchive(junk);
    bad++; err('  FAIL  corrupt archive was accepted');
  } catch { err('  ok    corrupt archive rejected cleanly'); }

  err(`
${bad ? 'FAILED' : 'OK'} -- ${n - bad}/${n} checks`);
  process.exit(bad ? 1 : 0);
}

// --- entry ------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = parseArgs(argv);
const cmd = opts._.shift();

if (opts.version) { process.stdout.write(`slc4 ${VERSION}\n`); process.exit(0); }
if (opts.help || !cmd) { process.stdout.write(HELP); process.exit(cmd ? 0 : 2); }

try {
  switch (cmd) {
    case 'pack': cmdPack(opts); break;
    case 'unpack': cmdUnpack(opts); break;
    case 'inspect': cmdInspect(opts); break;
    case 'bench': cmdBench(opts); break;
    case 'selftest': cmdSelftest(opts); break;
    default: usageError(`Unknown command: ${cmd}`);
  }
} catch (e) {
  err(`slc4: ${(e && e.message) || e}`);
  process.exit(1);
}
