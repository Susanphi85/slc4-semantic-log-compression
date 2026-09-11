// Builds the Total Commander packer plugin (dist/slc4.wcx64).
//
//   node build-wcx.mjs
//
// The plugin is a thin shim that drives slc4.exe, so build-exe.mjs must have
// run first -- the two files live side by side and the plugin looks for the
// executable next to itself.
//
// Any of zig cc, gcc (MinGW-w64) or cl (MSVC) can build it; whichever is on
// PATH first is used.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'wcx', 'slc4_wcx.c');
const DIST = path.join(HERE, 'dist');
const OUT = path.join(DIST, 'slc4.wcx64');

const REQUIRED_EXPORTS = [
  'OpenArchive', 'OpenArchiveW', 'ReadHeader', 'ReadHeaderEx', 'ReadHeaderExW',
  'ProcessFile', 'ProcessFileW', 'CloseArchive', 'SetChangeVolProc',
  'SetProcessDataProc', 'SetProcessDataProcW', 'GetPackerCaps',
  'PackFiles', 'PackFilesW',
];

function have(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', shell: false });
  return !r.error && (r.status === 0 || r.status === null);
}

function toolchain() {
  // A Zig unpacked into tools/ wins over PATH, so a toolchain fetched just for
  // this build is used without touching the system.
  const localZig = path.join(HERE, 'tools', 'zig', process.platform === 'win32' ? 'zig.exe' : 'zig');
  const zig = fs.existsSync(localZig) ? localZig : (have('zig', ['version']) ? 'zig' : null);
  if (zig) {
    return {
      name: `zig cc (${zig === localZig ? 'tools/zig' : 'PATH'})`,
      cmd: zig,
      args: ['cc', '-shared', '-O2', '-target', 'x86_64-windows-gnu',
             '-o', OUT, SRC, '-lkernel32'],
    };
  }
  if (have('gcc')) {
    return {
      name: 'gcc (MinGW-w64)',
      cmd: 'gcc',
      args: ['-shared', '-O2', '-o', OUT, SRC, '-static-libgcc', '-lkernel32'],
    };
  }
  if (have('cl', [])) {
    return {
      name: 'cl (MSVC)',
      cmd: 'cl',
      args: ['/nologo', '/LD', '/O2', SRC, `/Fe:${OUT}`,
             `/Fo:${path.join(DIST, 'slc4_wcx.obj')}`, '/link', 'kernel32.lib'],
    };
  }
  return null;
}

// Reading the export table directly keeps the check dependency-free; dumpbin
// and objdump are not assumed to be present.
function peExports(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE image');
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x00004550) throw new Error('no PE signature');

  const sectionCount = b.readUInt16LE(pe + 6);
  const optionalSize = b.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const plus = b.readUInt16LE(optional) === 0x20b;
  const dirs = optional + (plus ? 112 : 96);
  const exportRva = b.readUInt32LE(dirs);
  if (!exportRva) return [];

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = optional + optionalSize + i * 40;
    sections.push({
      va: b.readUInt32LE(s + 12),
      size: b.readUInt32LE(s + 8),
      raw: b.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + s.size) return rva - s.va + s.raw;
    throw new Error(`RVA ${rva} is outside every section`);
  };

  const dir = toOffset(exportRva);
  const nameCount = b.readUInt32LE(dir + 24);
  const namesRva = b.readUInt32LE(dir + 32);
  if (!nameCount) return [];
  const names = toOffset(namesRva);

  const out = [];
  for (let i = 0; i < nameCount; i++) {
    const at = toOffset(b.readUInt32LE(names + i * 4));
    out.push(b.toString('latin1', at, b.indexOf(0, at)));
  }
  return out.sort();
}

// Importing this module must not start a build; the parser above is reused by
// the test suite.
if (fileURLToPath(import.meta.url) !== path.resolve(process.argv[1] || '')) {
  // imported, not run
} else {
  main();
}

function main() {
const tc = toolchain();
if (!tc) {
  console.error('No C compiler found on PATH (looked for zig, gcc, cl).');
  console.error('');
  console.error('The plugin is a native Win64 DLL, so one is required. Options:');
  console.error('  zig    portable, no system install -- https://ziglang.org/download/');
  console.error('  gcc    winget install MartinStorsjo.LLVM-MinGW.UCRT');
  console.error('  cl     Visual Studio Build Tools, "Desktop development with C++"');
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
console.log(`Building with ${tc.name}`);
const r = spawnSync(tc.cmd, tc.args, { stdio: 'inherit', cwd: HERE });
if (r.error) { console.error(r.error.message); process.exit(1); }
if (r.status !== 0) { console.error(`\n${tc.name} exited ${r.status}`); process.exit(1); }

// Linkers drop an import library and debug symbols next to the DLL; neither is
// part of what gets installed, so dist/ is left holding only what ships.
for (const leftover of ['slc4.pdb', 'slc4_wcx.lib', 'slc4_wcx.exp', 'slc4_wcx.obj', 'slc4.lib', 'slc4.exp']) {
  fs.rmSync(path.join(DIST, leftover), { force: true });
}

const exported = peExports(OUT);
const missing = REQUIRED_EXPORTS.filter(n => !exported.includes(n));
console.log(`\n${path.relative(HERE, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KiB)`);
console.log(`exports: ${exported.join(' ')}`);

if (missing.length) {
  console.error(`\nMissing required exports: ${missing.join(' ')}`);
  console.error('Total Commander would reject the plugin. Check that every entry point');
  console.error('is marked __declspec(dllexport).');
  process.exit(1);
}

const exe = path.join(DIST, process.platform === 'win32' ? 'slc4.exe' : 'slc4');
if (!fs.existsSync(exe)) {
  console.log(`\nNote: ${path.relative(HERE, exe)} is missing -- run "npm run build:exe".`);
  console.log('The plugin looks for it next to itself and will not work without it.');
} else {
  console.log(`\nOK -- all ${REQUIRED_EXPORTS.length} required exports present, slc4.exe is in place.`);
}
}

export { peExports, REQUIRED_EXPORTS };
