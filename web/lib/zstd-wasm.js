// ZSTD backend for the browser, built on a vendored WebAssembly build of zstd.
// Verified byte-identical to native ZSTD at levels 1, 3 and 19, so archives
// produced here stay readable by the Node and Python implementations.
import { init as initWasm } from './zstd/index.web.js';
import { Module } from './zstd/module.js';
import { isError } from './zstd/errors/index.js';

let ready = null;
export const backend = 'wasm';

export function init() {
  if (!ready) ready = initWasm();
  return ready;
}

export function compress(data, level = 19) {
  level = Math.max(1, Math.min(22, Number(level) || 19));
  const src = Module['_malloc'](data.byteLength);
  const bound = Module['_ZSTD_compressBound'](data.byteLength);
  const dst = Module['_malloc'](bound);
  try {
    Module.HEAP8.set(data, src);
    const size = Module['_ZSTD_compress'](dst, bound, src, data.byteLength, level);
    if (isError(size)) throw new Error(`ZSTD compression failed (code ${size})`);
    return new Uint8Array(Module.HEAPU8.buffer, dst, size).slice();
  } finally {
    Module['_free'](dst); Module['_free'](src);
  }
}

// Hard ceiling on what a single archive may expand to. Without it a small
// hostile .slc4z could ask for an unbounded allocation.
export const DEFAULT_MAX_OUTPUT = 1024 * 1024 * 1024;

export function decompress(data, { maxOutputBytes = DEFAULT_MAX_OUTPUT } = {}) {
  const src = Module['_malloc'](data.byteLength);
  try {
    Module.HEAP8.set(data, src);
    const declared = Module['_ZSTD_getFrameContentSize'](src, data.byteLength);

    // A well-formed frame declares its size up front, which lets the limit be
    // enforced before a single byte is allocated. Frames written by a streaming
    // encoder may omit it, so those fall back to a bounded growing retry.
    const sizes = (declared >= 0)
      ? [declared]
      : [1 << 20, 1 << 23, 1 << 26, 1 << 28, maxOutputBytes];

    if (declared > maxOutputBytes) {
      throw new Error(`Archive declares ${declared} bytes, above the ${maxOutputBytes}-byte decompression limit`);
    }

    let lastError = null;
    for (const size of sizes) {
      if (size > maxOutputBytes) break;
      const dst = Module['_malloc'](size);
      try {
        const written = Module['_ZSTD_decompress'](dst, size, src, data.byteLength);
        if (!isError(written)) return new Uint8Array(Module.HEAPU8.buffer, dst, written).slice();
        lastError = written;
      } finally {
        Module['_free'](dst);
      }
    }
    throw new Error(`ZSTD decompression failed (code ${lastError}); not a valid archive, or above the ${maxOutputBytes}-byte limit`);
  } finally {
    Module['_free'](src);
  }
}
