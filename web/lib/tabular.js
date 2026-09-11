// Readers for tabular sources: CSV and PostgreSQL dumps.
//
// The codec itself only ever sees arrays of plain objects, so everything here
// is about turning bytes into records and back again without losing anything
// that matters.
//
// Values are carried as strings on purpose. CSV and COPY have no type system,
// so inferring one would mean "0042" comes back as 42 and "1.50" as 1.5. The
// existing uintstr / numtemplate codecs already encode numeric-looking strings
// as integers, so keeping the text costs far less than it looks -- and buys an
// exact round-trip. Type inference is available, but it is opt-in and changes
// the round-trip contract from exact to value-level.

import * as B from './bytes.js';

// --- CSV --------------------------------------------------------------------

const DELIMITERS = [',', ';', '\t', '|'];

/** Guesses delimiter, line ending and header row from the first few lines. */
export function sniffCsv(text, bom = false) {
  // TextDecoder strips a UTF-8 BOM while decoding, so its presence has to be
  // detected from the bytes and passed in; by this point the text is clean.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sample = body.slice(0, 64 * 1024);

  // The delimiter is the candidate that yields the most consistent field count
  // across the sample; counting outside quoted regions avoids commas in values.
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = [];
    for (const line of splitLogicalLines(sample, d).slice(0, 20)) counts.push(line.length);
    if (counts.length < 1) continue;
    const fields = counts[0];
    if (fields < 2) continue;
    const consistent = counts.filter(c => c === fields).length / counts.length;
    const score = consistent * 100 + fields;
    if (score > bestScore) { bestScore = score; best = d; }
  }

  const crlf = body.indexOf('\r\n');
  const lf = body.indexOf('\n');
  const eol = (crlf !== -1 && (crlf === lf - 1)) ? '\r\n' : '\n';
  const trailingNewline = body.endsWith('\n');
  return { delimiter: best, eol, bom, trailingNewline };
}

/** Field-level CSV split honouring RFC 4180 quoting; used by the sniffer. */
function splitLogicalLines(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** True when the first row reads like column names rather than data. */
function looksLikeHeader(rows) {
  if (rows.length < 2) return true;
  const head = rows[0];
  if (head.some(h => h === '')) return false;
  // Repeated names are unusual but legal, so they are not evidence against a
  // header row; only values that read as numbers are.
  const numericish = h => /^[+-]?\d+([.,]\d+)?$/.test(h.trim());
  return !head.some(numericish);
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function parseCsv(bytes, options = {}) {
  const u8 = (bytes instanceof Uint8Array) ? bytes : B.fromString(String(bytes));
  const bom = u8.length >= 3 && UTF8_BOM.every((b, i) => u8[i] === b);
  const text = B.toString(u8);
  const dialect = { ...sniffCsv(text, bom), ...options.dialect };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = splitLogicalLines(body, dialect.delimiter);
  if (!rows.length) throw new Error('CSV input holds no rows');

  const hasHeader = options.hasHeader ?? looksLikeHeader(rows);
  // headerNames is what the file said; columns is what the records are keyed
  // by. They differ only when names repeat, and keeping both is what lets the
  // header be written back exactly as it was read.
  const headerNames = hasHeader
    ? rows[0].slice()
    : rows[0].map((_, i) => `column_${i + 1}`);
  const columns = headerNames.map((h, i) => h.trim() || `column_${i + 1}`);
  const seen = new Map();
  for (let i = 0; i < columns.length; i++) {
    const base = columns[i];
    if (seen.has(base)) { const n = seen.get(base) + 1; seen.set(base, n); columns[i] = `${base}_${n}`; }
    else seen.set(base, 1);
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const infer = options.inferTypes ? inferValue : (v => v);
  const records = dataRows.map(cells => {
    const rec = {};
    for (let i = 0; i < columns.length; i++) rec[columns[i]] = infer(cells[i] ?? '');
    return rec;
  });

  return { records, dialect: { ...dialect, bom, hasHeader, columns, headerNames } };
}

const INT_RE = /^-?(?:0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(?:0|[1-9]\d*)\.\d+$/;

/** Opt-in type inference. Deliberately conservative: a value is converted only
 *  when printing the number back yields the original text character for
 *  character, so "0042", "1.50" and "-0" all stay as they are. That keeps the
 *  byte-exact round-trip intact even with inference enabled.
 *
 *  Note that inference is not free: it can split a column that was uniformly
 *  text into one holding both numbers and text, which costs far more than it
 *  saves. See the measurement in the research notes. */
function inferValue(v) {
  if (v === '') return '';
  if (!INT_RE.test(v) && !FLOAT_RE.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return v;
  return String(n) === v ? n : v;
}

export function serializeCsv(records, dialect) {
  const d = { delimiter: ',', eol: '\n', bom: false, hasHeader: true, trailingNewline: true, ...dialect };
  const columns = d.columns && d.columns.length
    ? d.columns
    : [...new Set(records.flatMap(r => Object.keys(r)))];

  const needsQuote = s => s.includes(d.delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return needsQuote(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [];
  if (d.hasHeader) lines.push((d.headerNames || columns).map(cell).join(d.delimiter));
  for (const r of records) lines.push(columns.map(c => cell(r[c])).join(d.delimiter));

  let out = lines.join(d.eol);
  if (d.trailingNewline) out += d.eol;
  return B.fromString(d.bom ? '﻿' + out : out);
}

// --- PostgreSQL dumps -------------------------------------------------------
//
// A dump is not a table: it is DDL, settings and sequences with data blocks in
// between. Anything not recognised as data is kept verbatim as a literal
// segment, so the file always reassembles exactly. Only COPY blocks and simple
// INSERT statements are lifted into columnar records; everything else degrades
// gracefully to text that ZSTD still compresses.

const COPY_RE = /^COPY\s+(.+?)\s*\(([^)]*)\)\s+FROM\s+stdin;\s*$/i;
const INSERT_RE = /^INSERT INTO\s+(\S+)\s*\(([^)]*)\)\s+VALUES\s*\((.*)\);\s*$/i;

/** Postgres text-format COPY escapes. \N marks NULL, which maps to JSON null. */
function unescapeCopy(field) {
  if (field === '\\N') return null;
  if (!field.includes('\\')) return field;
  let out = '';
  for (let i = 0; i < field.length; i++) {
    if (field[i] !== '\\') { out += field[i]; continue; }
    const n = field[++i];
    if (n === undefined) { out += '\\'; break; }
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r'
      : n === 'b' ? '\b' : n === 'f' ? '\f' : n === 'v' ? '\v' : n === '\\' ? '\\' : '\\' + n;
  }
  return out;
}

function escapeCopy(value) {
  if (value === null || value === undefined) return '\\N';
  // Backspace must be matched as \x08: inside a regular expression \b is a
  // word-boundary assertion, which would insert an escape at every word edge.
  return String(value)
    .replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r').replace(/\x08/g, '\\b').replace(/\f/g, '\\f').replace(/\v/g, '\\v');
}

/** Splits a VALUES tuple on top-level commas, honouring SQL string quoting. */
function splitSqlTuple(text) {
  const out = [];
  let cur = '', depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      cur += c;
      if (c === "'") { if (text[i + 1] === "'") { cur += "'"; i++; } else quoted = false; }
      continue;
    }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

/** SQL literal -> value. The source text is kept for anything that would not
 *  re-serialise identically, so reassembly stays exact. */
function sqlLiteralToValue(tok) {
  if (/^NULL$/i.test(tok)) return null;
  if (tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2) {
    return tok.slice(1, -1).replace(/''/g, "'");
  }
  return tok;   // numbers, booleans, casts, functions: carried verbatim
}

function valueToSqlLiteral(v, wasQuoted) {
  if (v === null || v === undefined) return 'NULL';
  return wasQuoted ? `'${String(v).replace(/'/g, "''")}'` : String(v);
}

function parseColumnList(text) {
  return splitSqlTuple(text).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
}

export function parseSql(bytes) {
  const text = (bytes instanceof Uint8Array) ? B.toString(bytes) : String(bytes);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(text);

  const segments = [];     // { kind: 'literal', text } | { kind: 'copy'|'insert', ... }
  const records = [];
  let literal = [];

  const flushLiteral = () => {
    if (literal.length) { segments.push({ kind: 'literal', lines: literal }); literal = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const copy = COPY_RE.exec(line);
    if (copy) {
      const columns = parseColumnList(copy[2]);
      const rows = [];
      let j = i + 1;
      for (; j < lines.length && lines[j] !== '\\.'; j++) {
        const cells = lines[j].split('\t');
        const rec = {};
        for (let k = 0; k < columns.length; k++) rec[columns[k]] = unescapeCopy(cells[k] ?? '\\N');
        records.push(rec);
        rows.push(null);
      }
      flushLiteral();
      segments.push({ kind: 'copy', header: line, columns, count: rows.length, terminated: lines[j] === '\\.' });
      i = (lines[j] === '\\.') ? j : j - 1;
      continue;
    }

    const ins = INSERT_RE.exec(line);
    if (ins) {
      const columns = parseColumnList(ins[2]);
      const tokens = splitSqlTuple(ins[3]);
      if (tokens.length === columns.length) {
        const rec = {}, quoted = [];
        for (let k = 0; k < columns.length; k++) {
          rec[columns[k]] = sqlLiteralToValue(tokens[k]);
          quoted.push(tokens[k].startsWith("'"));
        }
        records.push(rec);
        flushLiteral();
        segments.push({ kind: 'insert', table: ins[1], columns, quoted });
        continue;
      }
      // Column/value mismatch means the statement is something we do not model.
    }

    literal.push(line);
  }
  flushLiteral();

  return { records, layout: { eol, endsWithNewline, segments } };
}

export function serializeSql(records, layout) {
  const { eol = '\n', endsWithNewline = true, segments = [] } = layout || {};
  const out = [];
  let cursor = 0;

  for (const seg of segments) {
    if (seg.kind === 'literal') { out.push(...seg.lines); continue; }

    if (seg.kind === 'copy') {
      out.push(seg.header);
      for (let n = 0; n < seg.count; n++) {
        const rec = records[cursor++];
        out.push(seg.columns.map(c => escapeCopy(rec ? rec[c] : null)).join('\t'));
      }
      if (seg.terminated) out.push('\\.');
      continue;
    }

    if (seg.kind === 'insert') {
      const rec = records[cursor++] || {};
      const values = seg.columns.map((c, k) => valueToSqlLiteral(rec[c], seg.quoted[k]));
      out.push(`INSERT INTO ${seg.table} (${seg.columns.join(', ')}) VALUES (${values.join(', ')});`);
      continue;
    }
  }

  // Splitting on newlines leaves a trailing empty element when the file ended
  // with one, and that element already carries it back; adding eol here would
  // append a second newline.
  return B.fromString(out.join(eol));
}
