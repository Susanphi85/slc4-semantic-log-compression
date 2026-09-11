// ZSTD backend for Node: native node:zlib when available (Node 22.15+),
// otherwise the system `zstd` CLI. Browsers use ./zstd-wasm.js instead.
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const hasNative = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

function cli(args, data, maxBuffer) {
  const p = spawnSync('zstd', args, { input: data, maxBuffer });
  if (p.error) throw new Error(`Native Node ZSTD unavailable and zstd CLI failed: ${p.error.message}`);
  if (p.status !== 0) throw new Error((p.stderr || Buffer.alloc(0)).toString('utf8') || `zstd exited ${p.status}`);
  return p.stdout;
}

export function compress(data, level = 19) {
  level = Math.max(1, Math.min(22, Number(level) || 19));
  if (hasNative) return zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  return cli([`-${level}`, '--stdout', '--quiet'], data, Math.max(64 * 1024 * 1024, data.length * 2 + 1024 * 1024));
}

export function decompress(data) {
  if (hasNative) return zlib.zstdDecompressSync(data);
  return cli(['-d', '--stdout', '--quiet'], data, 1024 * 1024 * 1024);
}

export const backend = hasNative ? 'node:zlib' : 'zstd-cli';
export async function init() { /* nothing to load */ }
