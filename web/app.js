// UI layer. All codec work is delegated to worker.js; this file only reads
// files, renders results and hands blobs to the browser's download path.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

let packFile = null, unpackFile = null;
let lastPack = null;   // { key, archive } -- lets Pack reuse the archive Analyze already built

// --- Worker plumbing --------------------------------------------------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;

worker.onmessage = (ev) => {
  const { id, progress } = ev.data;
  const entry = pending.get(id);
  if (!entry) return;
  if (progress !== undefined) { entry.onProgress(progress); return; }
  pending.delete(id);
  if (ev.data.ok) entry.resolve(ev.data);
  else entry.reject(new Error(ev.data.error || 'Worker failed'));
};
worker.onerror = (e) => {
  const msg = e.message || 'Worker failed to start';
  for (const [, entry] of pending) entry.reject(new Error(msg));
  pending.clear();
};

function call(op, payload = {}, onProgress = () => {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, ...payload }, transfer);
  });
}

// --- File pickers -----------------------------------------------------------
function setupDrop(dropId, inputId, onFile) {
  const drop = $(dropId), input = $(inputId);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}

setupDrop('packDrop', 'packFile', f => {
  packFile = f; lastPack = null;
  setStatus('packStatus', `Selected: ${f.name} · ${(f.size / 1024 / 1024).toFixed(2)} MiB`);
  $('analyzeBtn').disabled = false; $('packBtn').disabled = false;
});
setupDrop('unpackDrop', 'unpackFile', f => {
  unpackFile = f;
  setStatus('unpackStatus', `Selected: ${f.name} · ${(f.size / 1024).toFixed(1)} KiB`);
  $('inspectBtn').disabled = false; $('unpackBtn').disabled = false;
});

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const pack = b.dataset.tab === 'pack';
  $('packPanel').classList.toggle('hidden', !pack);
  $('unpackPanel').classList.toggle('hidden', pack);
}));

function setStatus(id, msg, error = false) { const e = $(id); e.textContent = msg; e.classList.toggle('error', error); }
function downloadBytes(bytes, name, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const params = () => ({ selection: $('selection').value, level: Number($('zlevel').value) });
const packKey = () => { const p = params(); return `${packFile.name}|${packFile.size}|${p.selection}|${p.level}`; };

// --- Pack / analyze ---------------------------------------------------------
async function runAnalysis(statusVerb) {
  const { selection, level } = params();
  if (!Number.isInteger(level) || level < 1 || level > 22) throw new Error('ZSTD level must be an integer between 1 and 22');
  setStatus('packStatus', `${statusVerb} ${packFile.name}…`);
  const buf = await packFile.arrayBuffer();
  const res = await call('analyze',
    { buf, filename: packFile.name, selection, level },
    (label) => setStatus('packStatus', `${label}…`),
    [buf]);
  lastPack = { key: packKey(), archive: res.archive };
  return res.result;
}

$('analyzeBtn').onclick = async () => {
  if (!packFile) return;
  $('analyzeBtn').disabled = true; $('packBtn').disabled = true;
  try {
    const d = await runAnalysis('Analyzing');
    renderAnalysis(d);
    setStatus('packStatus', `Analysis complete in ${d.timings.encode_s.toFixed(2)} s encode + ${d.timings.decode_s.toFixed(2)} s verify.`);
  } catch (e) { setStatus('packStatus', e.message, true); }
  finally { $('analyzeBtn').disabled = false; $('packBtn').disabled = false; }
};

$('packBtn').onclick = async () => {
  if (!packFile) return;
  $('analyzeBtn').disabled = true; $('packBtn').disabled = true;
  try {
    if (!lastPack || lastPack.key !== packKey()) {
      const d = await runAnalysis('Packing');
      renderAnalysis(d);
    }
    const archive = lastPack.archive;
    downloadBytes(archive, `${packFile.name.replace(/\.[^.]+$/, '') || 'archive'}.slc4z`);
    setStatus('packStatus', `Packed ${(archive.byteLength / 1024).toFixed(1)} KiB · download started.`);
  } catch (e) { setStatus('packStatus', e.message, true); }
  finally { $('analyzeBtn').disabled = false; $('packBtn').disabled = false; }
};

function renderAnalysis(d) {
  $('results').classList.remove('hidden');
  $('records').textContent = d.records.toLocaleString();
  $('schemas').textContent = d.schemas;
  $('fields').textContent = d.fields;
  $('ratio').textContent = d.ratios.input_to_slc4z + '×';
  $('roundtrip').textContent = !d.round_trip ? 'round-trip failed'
    : d.byte_exact ? 'round-trip ✓ byte-identical' : 'round-trip ✓ values';
  const defs = [['Input', d.sizes.input], ['Input + ZSTD', d.sizes.input_zstd], ['Canonical + ZSTD', d.sizes.canonical_zstd], ['SLC4 semantic', d.sizes.slc4], ['SLC4Z', d.sizes.slc4z]];
  const max = Math.max(...defs.map(x => x[1].bytes));
  $('benchRows').innerHTML = defs.map(([name, x]) =>
    `<div class="benchrow"><div>${name}</div><div class="barbox"><div class="bar ${name === 'SLC4Z' ? 'best' : ''}" style="width:${Math.max(1, 100 * x.bytes / max)}%"></div></div><div class="mono">${x.human}</div></div>`).join('');
  $('encSummary').textContent = Object.entries(d.encodings).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ');
  $('cols').innerHTML = d.columns.map(c =>
    `<tr><td class="path mono" title="${esc(c.path)}">${esc(c.path)}</td><td>${esc(c.encoding)}</td><td>${c.values.toLocaleString()}</td><td class="mono">${c.human}</td></tr>`).join('');
}

// --- Unpack -----------------------------------------------------------------
$('inspectBtn').onclick = async () => {
  if (!unpackFile) return;
  $('inspectBtn').disabled = true;
  setStatus('unpackStatus', 'Inspecting archive…');
  try {
    const buf = await unpackFile.arrayBuffer();
    const { details: d } = await call('inspect', { buf }, () => {}, [buf]);
    $('archiveInfo').classList.remove('hidden');
    $('arRecords').textContent = d.record_count.toLocaleString();
    $('arSchemas').textContent = d.schema_count;
    $('arFields').textContent = d.field_count;
    $('arSize').textContent = d.archive_human;
    $('headerJson').textContent = JSON.stringify(d.header, null, 2);
    setStatus('unpackStatus', d.round_trip_decodable ? 'Archive decoded successfully.' : 'Archive validation failed.', !d.round_trip_decodable);
  } catch (e) { setStatus('unpackStatus', e.message, true); }
  finally { $('inspectBtn').disabled = false; }
};

$('unpackBtn').onclick = async () => {
  if (!unpackFile) return;
  $('unpackBtn').disabled = true;
  try {
    const buf = await unpackFile.arrayBuffer();
    const r = await call('unpack', { buf }, (label) => setStatus('unpackStatus', `${label}…`), [buf]);
    downloadBytes(r.payload, r.filename, r.mime);
    setStatus('unpackStatus', `Decoded ${(r.payload.byteLength / 1024 / 1024).toFixed(2)} MiB · download started.`);
  } catch (e) { setStatus('unpackStatus', e.message, true); }
  finally { $('unpackBtn').disabled = false; }
};

// --- Boot -------------------------------------------------------------------
call('init').then(({ backend }) => {
  $('engineBadge').textContent = `research prototype · codec v4 · ${backend === 'wasm' ? 'WebAssembly, in-browser' : backend}`;
}).catch(e => {
  setStatus('packStatus', `Codec failed to start: ${e.message}`, true);
  setStatus('unpackStatus', `Codec failed to start: ${e.message}`, true);
});
