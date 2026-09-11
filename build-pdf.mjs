// Builds PDFs of the research document.
//
//   node build-pdf.mjs
//
// The documents' YAML front matter is written for XeLaTeX: `mainfont`,
// `linkcolor: blue` and `geometry: margin=22mm` are LaTeX conventions. When a
// LaTeX engine is available it is used and the front matter governs.
//
// Typst is supported as a much lighter alternative (a single 22 MB binary
// against a LaTeX distribution's several hundred MB), but it needs the
// LaTeX-specific values translated:
//
//   - `linkcolor: blue` reaches typst as rgb("blue"), which is not valid hex,
//     so an explicit hex value is passed instead;
//   - DejaVu Serif is not bundled with typst and is absent on a stock Windows,
//     so a serif that typst does ship is substituted;
//   - `toc` and `numbersections` from the front matter are read by the LaTeX
//     template but not the typst one, which wants --toc and --number-sections.
//
// The front matter is deliberately left alone rather than rewritten to suit
// typst: it records the intended typesetting, and this script adapts to
// whatever engine is present.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, 'docs');
const OUT = path.join(HERE, 'release');
const IS_WINDOWS = process.platform === 'win32';
const exe = (n) => IS_WINDOWS ? `${n}.exe` : n;

function which(name, local) {
  if (local && fs.existsSync(local)) return local;
  const probe = spawnSync(name, ['--version'], { stdio: 'pipe' });
  return probe.error ? null : name;
}

const pandoc = which('pandoc', path.join(HERE, 'tools', 'pandoc', exe('pandoc')));
if (!pandoc) {
  console.error('pandoc not found.');
  console.error('');
  console.error('Install it, or unpack the portable build into tools/pandoc:');
  console.error('  https://github.com/jgm/pandoc/releases');
  process.exit(1);
}

// A LaTeX engine renders the front matter as written, so it wins when present.
const xelatex = which('xelatex', null);
const typst = which('typst', path.join(HERE, 'tools', 'typst', exe('typst')));

if (!xelatex && !typst) {
  console.error('No PDF engine found (looked for xelatex and typst).');
  console.error('');
  console.error('  typst   a single portable binary, ~22 MB:');
  console.error('          https://github.com/typst/typst/releases');
  console.error('  xelatex part of MiKTeX or TeX Live; heavier, but the front');
  console.error('          matter of these documents was written for it.');
  process.exit(1);
}

const engine = xelatex ? 'xelatex' : typst;
const engineName = xelatex ? 'xelatex' : `typst (${typst === 'typst' ? 'PATH' : 'tools/typst'})`;

// typst is invoked by pandoc by name, so a local copy has to be reachable.
if (!xelatex && typst !== 'typst') {
  process.env.PATH = `${path.dirname(typst)}${path.delimiter}${process.env.PATH}`;
}

const typstOverrides = [
  '--toc', '--toc-depth=3', '--number-sections',
  '-V', 'linkcolor=0645AD',
  '-V', 'urlcolor=0645AD',
  '-V', 'mainfont=Libertinus Serif',   // DejaVu Serif is not available to typst
  '-V', 'monofont=DejaVu Sans Mono',   // this one typst does bundle
];

fs.mkdirSync(OUT, { recursive: true });
console.log(`pandoc: ${pandoc === 'pandoc' ? 'PATH' : 'tools/pandoc'}`);
console.log(`engine: ${engineName}\n`);

let failed = 0;
for (const lang of ['pl', 'en']) {
  const src = path.join(DOCS, `research.${lang}.md`);
  if (!fs.existsSync(src)) { console.log(`  skip  research.${lang}.md (missing)`); continue; }
  const dst = path.join(OUT, `slc4-research.${lang}.pdf`);

  const args = [src, '-o', dst,
    `--pdf-engine=${xelatex ? 'xelatex' : 'typst'}`,
    // Images are referenced relative to the document, not the working directory.
    `--resource-path=${DOCS}`,
    ...(xelatex ? ['--toc', '--toc-depth=3', '--number-sections'] : typstOverrides)];

  const r = spawnSync(pandoc, args, { stdio: 'inherit', cwd: HERE });
  if (r.status !== 0 || !fs.existsSync(dst)) { console.log(`  FAIL  research.${lang}.md`); failed++; continue; }
  console.log(`  ok    ${path.relative(HERE, dst)}  ${(fs.statSync(dst).size / 1048576).toFixed(2)} MB`);
}

if (failed) { console.error(`\n${failed} document(s) failed.`); process.exit(1); }
console.log('\nPDFs are written to release/ and are not tracked by git: they go stale');
console.log('the moment the Markdown changes. Attach them to a release instead.');
