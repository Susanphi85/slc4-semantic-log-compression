// Everything heavy runs here: schema fingerprinting, codec selection, ZSTD.
// The page itself only renders. Nothing is uploaded anywhere -- the file never
// leaves the browser.

import * as arc from './lib/slc4_archive.js';
import * as zstdWasm from './lib/zstd-wasm.js';

let ready = false;

async function ensureReady() {
  if (ready) return;
  await zstdWasm.init();
  arc.setZstd(zstdWasm);
  ready = true;
}

function reply(id, payload, transfer = []) {
  self.postMessage({ id, ...payload }, transfer);
}

self.onmessage = async (ev) => {
  const { id, op } = ev.data;
  try {
    await ensureReady();
    const progress = (label) => self.postMessage({ id, progress: label });

    switch (op) {
      case 'init':
        reply(id, { ok: true, backend: zstdWasm.backend });
        break;

      case 'analyze': {
        const { buf, filename, selection, level } = ev.data;
        const { result, archive } = arc.analyze(new Uint8Array(buf), filename, selection, level, progress);
        const out = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
        reply(id, { ok: true, result, archive: out }, [out]);
        break;
      }

      case 'inspect': {
        const details = arc.inspectArchive(new Uint8Array(ev.data.buf));
        reply(id, { ok: true, details });
        break;
      }

      case 'unpack': {
        progress('Decoding semantic archive');
        const { payload, filename, mime } = arc.unpackArchive(new Uint8Array(ev.data.buf));
        const out = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        reply(id, { ok: true, payload: out, filename, mime }, [out]);
        break;
      }

      default:
        reply(id, { ok: false, error: `Unknown operation: ${op}` });
    }
  } catch (e) {
    reply(id, { ok: false, error: (e && e.message) || String(e) });
  }
};
