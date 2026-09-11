# SLC4 — Semantic Log Compression

*Polski: [README.pl.md](README.pl.md) · Badania: [docs/research.pl.md](docs/research.pl.md) (oryginał) · [docs/research.en.md](docs/research.en.md)*

A lossless codec for structured logs and tabular exports. It fingerprints record
schemas, turns values into columns, picks an encoding per column from a set of
candidates, and hands the result to Zstandard. Everything runs in the browser —
there is no backend and nothing is uploaded.

It is a research prototype with a written-up experimental record, not a product.

## What the measurements actually show

The honest comparison is not against raw JSON — it is against what a competent
engineer would otherwise do. On a 5 000-record Cloud Run export and a
50 000-row relational table, both at ZSTD-19:

| Baseline | Logs | Relational table |
|---|---:|---:|
| input + ZSTD-19 | 290.1 KiB | 2 995.9 KiB |
| Parquet, default settings | 260.3 KiB | 3 205.3 KiB |
| Parquet, best of a swept grid | 220.8 KiB | 2 495.7 KiB |
| **SLC4Z** | **205.8 KiB** | **2 287.0 KiB** |
| | −6.8% | −8.4% |

So: **single-digit percentages against a tuned Parquet**, not the 28× you get by
measuring against uncompressed JSON. Two things follow, and the research
document argues both at length:

- Parquet supports column pruning and predicate pushdown; SLC4 requires decoding
  the whole archive. For most archival work that capability is worth more than
  8% of volume, and Parquet remains the better engineering choice.
- Where SLC4 does differ in kind is **fidelity of representation**. Flattening
  the sample's 14 record schemas into one wide Parquet schema added, on average,
  2.73 null-valued keys per record and affected all 5 000 records: a
  single-schema format cannot tell "field absent" from "field present and null".
  For CSV and SQL input, SLC4's round-trip is byte-exact.

The research document also records two measurement mistakes made while producing
that Parquet baseline, both of which flattered one side. They are written up
because the lesson generalises: **validate the baseline as rigorously as your own
format, and sweep its configuration rather than picking it by hand.**

## Quick start

No build step, no dependencies, no server code. Serve `web/` with anything:

```bash
npm start
```

Then open `http://127.0.0.1:8080`. To run it under Apache (XAMPP or shared
hosting), copy the contents of `web/` into the document root; the bundled
`.htaccess` sets the `application/wasm` MIME type that
`WebAssembly.instantiateStreaming()` requires.

Command line:

```bash
node cli.mjs pack logs.json -o logs.slc4z
node cli.mjs unpack logs.slc4z -o restored.json
node cli.mjs inspect logs.slc4z
node cli.mjs bench ./datasets --levels 3,9,19 --csv results.csv
```

## Try it on something

`examples/` holds two small archives you can open immediately, plus the source
CSV for one of them so the byte-exact claim can be checked rather than believed:

```bash
node cli.mjs inspect examples/logs-sample.slc4z
node cli.mjs unpack examples/orders-sample.slc4z -o restored.csv
cmp restored.csv examples/orders-sample.csv     # identical, byte for byte
```

They are also what to press Enter on after installing the Total Commander
plugin. See [examples/README.md](examples/README.md).

## Downloads

Prebuilt binaries are published as **release attachments**, not committed to the
repository. The reason is worth stating: `slc4.exe` is 90 MB because it embeds
the Node runtime, every rebuild produces an entirely different blob, and git
keeps every version forever — a handful of releases would turn a 600 KB
repository into a multi-hundred-megabyte clone for everyone, on every platform,
whether they wanted the Windows binary or not.

Both artefacts are optional. The web application needs neither, and the CLI runs
under any Node 18+. If you do download them, check the published SHA-256 first;
the executable is unsigned, because injecting a payload into a copy of `node.exe`
invalidates the Authenticode signature it carried, and shipping a broken
signature would be worse than shipping none.

## Input formats

Detected from the file name, else from the first bytes; `--format` overrides.

| Format | Extensions | Round-trip |
|---|---|---|
| JSON object or array of objects | `.json` | values (key order not preserved) |
| JSONL / NDJSON | `.jsonl` `.ndjson` | values |
| CSV / TSV | `.csv` `.tsv` | **byte-exact** |
| PostgreSQL dump | `.sql` | **byte-exact** |

CSV and SQL values are read as text rather than type-inferred. That is not a
compromise: the `uintstr` and `numtemplate` codecs already encode
numeric-looking strings as integers, and inference measurably *hurts* — it
splits a uniform column into one holding both numbers and text, which costs more
than it saves. `--infer` exists for generating typed data for comparisons.

A SQL dump is not a table: it is DDL and settings with data blocks in between.
`COPY ... FROM stdin;` blocks and simple `INSERT` statements become columns;
everything else is kept verbatim as literal segments. Constructs the codec does
not model degrade to text — never to data loss.

## Layout

```text
web/                 the deployable application; nothing outside it is needed
  worker.js          all codec work, off the UI thread
  lib/slc4_codec.js  the V4 codec
  lib/tabular.js     CSV and PostgreSQL dump readers
  lib/zstd/          vendored WebAssembly Zstandard (MIT, see NOTICE)
cli.mjs              pack / unpack / inspect / bench / selftest
wcx/                 Total Commander packer plugin, in C
docs/                the research document
examples/            small synthetic archives, ready to open
fixtures/            synthetic reference data for format-compatibility tests
```

The ZSTD backend is injected rather than imported, which is what lets one codec
source file run in Node and in the browser without forking.

## Tests

```bash
npm run check        # 101 checks
npm run check:wcx    # Total Commander plugin, 17 checks
```

The suite is mostly about compatibility. Archives must hash identically to the
stored references; the browser path (with `globalThis.Buffer` deleted, so only
the shim exists) must produce the same bytes as the native path; archives must
be readable across implementations; CSV and SQL must return byte-identical for
every dialect detected; and 1 500 corrupted streams must fail cleanly rather
than exhaust memory.

## Building the extras

```bash
npm run build:exe    # dist/slc4.exe, a standalone binary (Node SEA)
npm run build:wcx    # dist/slc4.wcx64, the Total Commander plugin
npm run build:pdf    # release/slc4-research.{pl,en}.pdf
```

The plugin build needs a C compiler — `zig cc`, MinGW-w64 or MSVC, whichever is
found first. See [README.pl.md](README.pl.md) for details on both.

The PDF build needs pandoc plus either XeLaTeX or Typst. The documents' front
matter is written for XeLaTeX and is used as-is when a LaTeX engine is present;
with Typst the script translates the LaTeX-specific values, because
`linkcolor: blue` is not valid hex to Typst and DejaVu Serif is not among the
fonts it bundles. Typst is the lighter option by a wide margin — one 22 MB
binary against a LaTeX distribution. Built PDFs are attached to releases rather
than committed; they go stale the moment the Markdown changes.

## Licence

Code is under the **Apache License 2.0** ([LICENSE](LICENSE)), which includes an
explicit patent grant.

The research document under `docs/` is under **CC BY 4.0**
([LICENSE-DOCS.txt](LICENSE-DOCS.txt)) — reuse and translate it freely, with
attribution.

**The SLC4 and SLC4Z formats may be implemented freely by anyone, in any
language, for any purpose. No patent is claimed over them.** See [NOTICE](NOTICE).

## Origin

The idea, the experiments and the original write-up are Polish, and the canonical
version of the research document is [the Polish one](docs/research.pl.md).
[docs/research.en.md](docs/research.en.md) is a translation; where the two
disagree, the Polish text governs.

No production data is included in this repository. Every dataset under
`fixtures/` is synthetic and generated by code kept here.
