// Drives the Total Commander plugin through a host that mimics Total
// Commander, so the plugin is verified without a running Total Commander.
//
//   node test-wcx.mjs
//
// Needs dist/slc4.exe and dist/slc4.wcx64 (npm run build:exe, npm run build:wcx).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const PLUGIN = path.join(DIST, 'slc4.wcx64');
const EXE = path.join(DIST, 'slc4.exe');
const WORK = path.join(os.tmpdir(), `slc4-wcx-test-${process.pid}`);

function die(msg) { console.error(msg); process.exit(1); }
if (!fs.existsSync(PLUGIN)) die('dist/slc4.wcx64 is missing -- run "npm run build:wcx" first.');
if (!fs.existsSync(EXE)) die('dist/slc4.exe is missing -- run "npm run build:exe" first.');

function zigPath() {
  const local = path.join(HERE, 'tools', 'zig', process.platform === 'win32' ? 'zig.exe' : 'zig');
  if (fs.existsSync(local)) return local;
  const probe = spawnSync('zig', ['version'], { stdio: 'pipe' });
  return probe.error ? null : 'zig';
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// Build the host. It is a test artifact, so it is kept out of dist/.
const zig = zigPath();
if (!zig) die('No Zig found (tools/zig or PATH) -- cannot build the test host.');
const host = path.join(WORK, 'wcxtest.exe');
let r = spawnSync(zig, ['cc', '-O2', '-target', 'x86_64-windows-gnu', '-municode',
  '-o', host, path.join(HERE, 'wcx', 'wcxtest.c'), `-I${path.join(HERE, 'wcx')}`],
  { stdio: 'inherit' });
if (r.status !== 0) die('Failed to build the test host.');

// Pack a fixture, then produce the reference the plugin's output must match.
const source = path.join(WORK, 'sample.json');
fs.copyFileSync(path.join(HERE, 'fixtures', 'sample.json'), source);
const archive = path.join(WORK, 'sample.slc4z');
const reference = path.join(WORK, 'reference.json');

for (const args of [['pack', source, '-o', archive, '-q'],
                    ['unpack', archive, '-o', reference, '-q']]) {
  r = spawnSync(EXE, args, { stdio: 'inherit' });
  if (r.status !== 0) die(`slc4 ${args[0]} failed.`);
}

r = spawnSync(host, [PLUGIN, archive, reference, WORK], { stdio: 'inherit' });

// The byte comparison inside the host proves the plugin matches the CLI; this
// confirms the document itself survived, which byte equality cannot show
// because key order is not preserved.
const stable = v => Array.isArray(v) ? v.map(stable)
  : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
const extracted = path.join(WORK, 'out', 'sample.json');
let semantic = false;
try {
  semantic = JSON.stringify(stable(JSON.parse(fs.readFileSync(extracted, 'utf8'))))
          === JSON.stringify(stable(JSON.parse(fs.readFileSync(source, 'utf8'))));
} catch (e) { semantic = false; }
console.log(`  ${semantic ? 'ok  ' : 'FAIL'}  extracted document is semantically identical to the original`);

fs.rmSync(WORK, { recursive: true, force: true });
const failed = r.status !== 0 || !semantic;
console.log(`\n${failed ? 'FAILED' : 'OK'} -- Total Commander plugin`);
process.exit(failed ? 1 : 0);
