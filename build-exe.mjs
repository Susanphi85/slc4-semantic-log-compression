// Builds a standalone slc4 executable using Node's Single Executable
// Application support. The result embeds the Node runtime, so it needs nothing
// installed on the target machine -- at the cost of embedding the whole runtime.
//
//   node build-exe.mjs
//
// esbuild and postject are fetched through npx at build time and pinned here,
// so the project itself keeps no runtime or installed dev dependencies.

import fs from 'node:fs';
import path from 'node:path';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');
const DIST = path.join(HERE, 'dist');
const IS_WINDOWS = process.platform === 'win32';
const EXE = path.join(DIST, IS_WINDOWS ? 'slc4.exe' : 'slc4');

const ESBUILD = 'esbuild@0.28.2';
const POSTJECT = 'postject@1.0.0-alpha.6';
// Node looks for this fuse string inside its own binary to find the injected blob.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const log = (...a) => console.log(...a);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) { console.error(`\nFailed: ${cmd} ${args.join(' ')}`); process.exit(1); }
}

// npx is a shell script / .cmd, and spawning it through a shell would both
// mangle paths containing spaces and concatenate arguments unescaped. Running
// npm's own npx-cli.js under the current Node avoids the shell entirely.
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
function npx(args, opts = {}) {
  if (fs.existsSync(NPX_CLI)) return run(process.execPath, [NPX_CLI, ...args], opts);
  return run(IS_WINDOWS ? 'npx.cmd' : 'npx', args, { ...opts, shell: IS_WINDOWS });
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

// Injecting a section invalidates node.exe's Authenticode signature, and a
// binary carrying a broken signature looks tampered with. signtool ships with
// the Windows SDK and is usually absent, so the certificate is removed here
// directly: clear the PE security data directory and drop the appended blob.
function stripAuthenticode(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) return 'not a PE image';        // "MZ"
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) return 'no PE signature';  // "PE\0\0"

  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  const dirs = optional + (magic === 0x20b ? 112 : 96);               // PE32+ vs PE32
  const security = dirs + 4 * 8;                                      // directory index 4
  if (security + 8 > buf.length) return 'no data directory';

  const offset = buf.readUInt32LE(security);
  const size = buf.readUInt32LE(security + 4);
  if (!offset || !size) return 'already unsigned';

  buf.writeUInt32LE(0, security);
  buf.writeUInt32LE(0, security + 4);
  // The certificate table is appended last; anything past it is padding.
  const end = (offset + size >= buf.length) ? offset : buf.length;
  fs.writeFileSync(file, buf.subarray(0, end));
  return `removed ${size} bytes of certificate`;
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. SEA runs one self-contained CommonJS file, so the ESM sources are bundled.
log('1/4  bundling cli.mjs');
const bundle = path.join(BUILD, 'slc4.cjs');
npx(['--yes', ESBUILD, 'cli.mjs',
  '--bundle', '--platform=node', '--format=cjs', '--target=node22',
  `--outfile=${bundle}`, '--legal-comments=none'], { cwd: HERE });
log(`     ${path.relative(HERE, bundle)} (${mib(fs.statSync(bundle).size)})`);

// 2. Turn the bundle into a SEA blob.
log('2/4  preparing SEA blob');
const seaConfig = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: path.join(BUILD, 'slc4.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Copy the running Node binary; it becomes the host for the blob.
log('3/4  copying the Node runtime');
fs.copyFileSync(process.execPath, EXE);
if (IS_WINDOWS) log(`     ${stripAuthenticode(EXE)}`);

// 4. Inject.
log('4/4  injecting the blob');
const inject = ['--yes', POSTJECT, EXE, 'NODE_SEA_BLOB', path.join(BUILD, 'slc4.blob'), '--sentinel-fuse', FUSE];
if (process.platform === 'darwin') inject.push('--macho-segment-name', 'NODE_SEA');
npx(inject, { cwd: HERE });

log(`\nBuilt ${path.relative(HERE, EXE)} (${mib(fs.statSync(EXE).size)})`);

// Smoke test: a binary that cannot pass its own selftest is not shippable.
log('\nRunning the built binary:\n');
run(EXE, ['--version']);
run(EXE, ['selftest']);
log(`\nOK -- ${EXE}`);
