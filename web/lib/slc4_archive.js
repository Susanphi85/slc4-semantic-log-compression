// The .slc4z container and the analysis/benchmark pipeline, lifted out of the
// Node server so the exact same code runs in the browser. The ZSTD backend is
// injected, which is what lets one implementation serve both.

import * as codec from './slc4_codec.js';
import * as msgpack from './msgpack.js';
import * as B from './bytes.js';
import * as tab from './tabular.js';

const ARCHIVE_MAGIC = B.fromString('SLCZ1');

let zstd = null;
export function setZstd(backend) {
  zstd = backend;
  codec.setZstdCompress(backend.compress);
}

// --- Limits -----------------------------------------------------------------
// An archive is untrusted input: it may have been produced by anyone. Every
// limit below turns a hostile or corrupt file into a clear error instead of an
// out-of-memory kill.
export const LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
};

export function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function baseName(name) {
  const base = String(name || 'archive').split(/[\\/]/).pop();
  return base.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 180) || 'archive';
}
export function stemOf(name) { return baseName(name).replace(/\.[^.]+$/, '') || 'archive'; }

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
    return o;
  }
  return v;
}
export function semanticEqual(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
export function canonicalJson(records) { return B.fromString(JSON.stringify(stable(records))); }

// --- Input parsing ----------------------------------------------------------
export function parseJsonInput(raw) {
  let text = (raw instanceof Uint8Array) ? B.toString(raw) : String(raw);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const stripped = text.trim();
  if (!stripped) throw new Error('Input is empty');
  try {
    const obj = JSON.parse(stripped);
    if (Array.isArray(obj)) {
      if (!obj.every(x => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('Top-level JSON array must contain objects');
      return [obj, 'json-array'];
    }
    if (obj && typeof obj === 'object') return [[obj], 'json-object'];
    throw new Error('Expected a JSON object, an array of objects, or JSONL objects');
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let item;
    try { item = JSON.parse(lines[i]); }
    catch (e) { throw new Error(`Invalid JSONL at line ${i + 1}: ${e.message}`); }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`JSONL line ${i + 1} is not a JSON object`);
    records.push(item);
  }
  if (!records.length) throw new Error('No JSONL records found');
  return [records, 'jsonl'];
}

export function serializeRecords(records, inputFormat, pretty = true, meta = {}) {
  if (inputFormat === 'csv') return tab.serializeCsv(records, meta.dialect);
  if (inputFormat === 'sql') return tab.serializeSql(records, meta.layout);
  if (inputFormat === 'jsonl') return B.fromString(records.map(x => JSON.stringify(x)).join('\n') + '\n');
  const obj = inputFormat === 'json-object' ? (records[0] || {}) : records;
  return B.fromString(JSON.stringify(obj, null, pretty ? 2 : 0));
}

const EXTENSION_FOR = { csv: '.csv', sql: '.sql', jsonl: '.jsonl' };

/** Picks a reader. The file name decides when it is informative, otherwise the
 *  first bytes do; an explicit choice always wins. */
export function detectFormat(raw, filename = '') {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'sql') return 'sql';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'json') return 'json';

  const head = B.toString(raw.subarray(0, Math.min(raw.length, 8192))).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^(--|\/\*|SET\s|CREATE\s|COPY\s|INSERT\s|BEGIN;|START TRANSACTION)/i.test(head)) return 'sql';
  return 'json';   // parseJsonInput falls back to JSONL on its own
}

/** Single entry point for every supported input. Returns the records plus the
 *  format-specific metadata needed to write the file back out. */
export function parseInput(raw, options = {}) {
  const bytes = B.from(raw);
  const format = options.format || detectFormat(bytes, options.filename);

  if (format === 'csv') {
    const { records, dialect } = tab.parseCsv(bytes, options);
    if (!records.length) throw new Error('CSV input holds no data rows');
    return { records, inputFormat: 'csv', meta: { dialect } };
  }
  if (format === 'sql') {
    const { records, layout } = tab.parseSql(bytes);
    return { records, inputFormat: 'sql', meta: { layout } };
  }
  const [records, inputFormat] = parseJsonInput(bytes);
  return { records, inputFormat, meta: {} };
}

// --- Container --------------------------------------------------------------
export function makeArchive(slc4, inputFormat, sourceName, recordCount, level, meta = {}) {
  // meta is empty for JSON inputs, so their headers -- and therefore their
  // archives -- stay byte-identical to those written before tabular support.
  const header = { format: 'SLC4Z', version: 1, codec: 4, input_format: inputFormat, source_name: sourceName, record_count: recordCount, zstd_level: level, ...meta };
  const hb = msgpack.encode(header);
  const n = B.alloc(4);
  B.writeU32BE(n, hb.length);
  return B.from(zstd.compress(B.concat([ARCHIVE_MAGIC, n, hb, B.from(slc4)]), level));
}

export function openArchive(blob) {
  if (blob.length > LIMITS.maxArchiveBytes) throw new Error(`Archive is ${human(blob.length)}, above the ${human(LIMITS.maxArchiveBytes)} limit`);
  const raw = B.from(zstd.decompress(blob, { maxOutputBytes: LIMITS.maxDecompressedBytes }));
  if (raw.length < 9) throw new Error('Truncated SLC4Z archive');
  if (!B.equals(raw.subarray(0, 5), ARCHIVE_MAGIC)) throw new Error('Not an SLC4Z archive');
  const hlen = B.readU32BE(raw, 5);
  if (hlen > LIMITS.maxHeaderBytes) throw new Error('SLC4Z header implausibly large');
  if (raw.length < 9 + hlen) throw new Error('Truncated SLC4Z header');
  const header = msgpack.decode(raw.subarray(9, 9 + hlen));
  const slc4 = raw.subarray(9 + hlen);
  if (!B.equals(slc4.subarray(0, 4), B.from(codec.MAGIC))) throw new Error('SLC4 payload missing');
  return [header, slc4];
}

export function slc4Details(slc4) {
  const meta = codec.inspect(slc4);
  const columns = meta.paths.map((p, i) => {
    const cm = meta.columns[i];
    return { path: p.join('.'), encoding: cm.enc, values: cm.n, bytes: cm.length, human: human(cm.length) };
  }).sort((a, b) => b.bytes - a.bytes);
  return { record_count: meta.record_count, schema_count: meta.schemas.length, field_count: meta.paths.length, schema_encoding: meta.schema_seq.enc, columns };
}

// --- Analysis ---------------------------------------------------------------
export function analyze(raw, filename, selection, zstdLevel, onProgress = () => {}, options = {}) {
  const step = (label) => onProgress(label);

  step('Parsing input');
  const { records, inputFormat, meta } = parseInput(raw, { ...options, filename });
  // A SQL dump may legitimately carry no data rows: the DDL still has to be
  // archived, and the literal segments alone reproduce it.
  if (!records.length && inputFormat !== 'sql') throw new Error('No records');

  step('Building canonical JSON');
  const canonical = canonicalJson(records);
  codec.setSelectionMode(selection);

  step(`Semantic encode (${records.length.toLocaleString()} records)`);
  let t = performance.now();
  const { buffer: slc4, encCounts } = codec.encode(records);
  const encodeS = (performance.now() - t) / 1000;

  step('Verifying round-trip');
  t = performance.now();
  const restored = codec.decode(slc4);
  const decodeS = (performance.now() - t) / 1000;
  if (!semanticEqual(restored, records)) throw new Error('Round-trip verification failed');

  step(`Baseline: raw input at ZSTD-${zstdLevel}`);
  t = performance.now();
  const rawZ = zstd.compress(B.from(raw), zstdLevel);
  const rawZS = (performance.now() - t) / 1000;

  step(`Baseline: canonical JSON at ZSTD-${zstdLevel}`);
  t = performance.now();
  const canZ = zstd.compress(canonical, zstdLevel);
  const canZS = (performance.now() - t) / 1000;

  step(`Packing archive at ZSTD-${zstdLevel}`);
  t = performance.now();
  const archive = makeArchive(slc4, inputFormat, filename, records.length, zstdLevel, meta);
  const archiveZS = (performance.now() - t) / 1000;

  // For text formats the values surviving is only half the contract; the file
  // should also come back byte for byte. Checking it here means pack can say
  // so plainly instead of leaving the user to find out later.
  const rebuilt = serializeRecords(restored, inputFormat, true, meta);
  const byteExact = B.equals(rebuilt, B.from(raw));

  const d = slc4Details(slc4);
  const sizes = { input: raw.length, canonical: canonical.length, slc4: slc4.length, input_zstd: rawZ.length, canonical_zstd: canZ.length, slc4z: archive.length };
  const result = {
    filename, input_format: inputFormat, round_trip: true, byte_exact: byteExact, selection, zstd_level: zstdLevel,
    records: d.record_count, schemas: d.schema_count, fields: d.field_count,
    schema_encoding: d.schema_encoding, encodings: encCounts,
    sizes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, { bytes: v, human: human(v), pct_input: +(100 * v / raw.length).toFixed(3) }])),
    ratios: {
      input_to_slc4z: +(raw.length / archive.length).toFixed(3),
      vs_canonical_zstd_smaller_pct: +((1 - archive.length / canZ.length) * 100).toFixed(3),
      vs_input_zstd_smaller_pct: +((1 - archive.length / rawZ.length) * 100).toFixed(3),
    },
    timings: {
      encode_s: +encodeS.toFixed(4), decode_s: +decodeS.toFixed(4),
      input_zstd_s: +rawZS.toFixed(4), canonical_zstd_s: +canZS.toFixed(4), archive_zstd_s: +archiveZS.toFixed(4),
    },
    columns: d.columns.slice(0, 50),
  };
  return { result, slc4, archive };
}

export function inspectArchive(blob) {
  const [header, slc4] = openArchive(blob);
  const details = slc4Details(slc4);
  const restored = codec.decode(slc4);
  return { ...details, header, archive_bytes: blob.length, archive_human: human(blob.length), round_trip_decodable: restored.length === details.record_count, columns: details.columns.slice(0, 50) };
}

export function unpackArchive(blob) {
  const [header, slc4] = openArchive(blob);
  const records = codec.decode(slc4);
  const inputFormat = header.input_format || 'json-array';
  const meta = { dialect: header.dialect, layout: header.layout };
  const payload = serializeRecords(records, inputFormat, true, meta);
  const suffix = EXTENSION_FOR[inputFormat] || '.json';
  const stem = stemOf(header.source_name || 'unpacked.json');
  return {
    header, records, payload,
    // What the document was called before packing. `filename` keeps the
    // .unpacked marker so extracting next to the archive cannot silently
    // overwrite the original.
    innerName: `${stem}${suffix}`,
    filename: `${stem}.unpacked${suffix}`,
    mime: inputFormat === 'csv' ? 'text/csv'
      : inputFormat === 'sql' ? 'application/sql'
        : inputFormat === 'jsonl' ? 'application/x-ndjson' : 'application/json',
  };
}
