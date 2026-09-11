# SLC4 — semantyczna kompresja logów

*English: [README.md](README.md) · Dokument badawczy: [docs/research.pl.md](docs/research.pl.md) (oryginał) · [docs/research.en.md](docs/research.en.md)*

## Co pokazują pomiary

Uczciwym punktem odniesienia nie jest surowy JSON, tylko to, co zrobiłby kompetentny inżynier. Na eksporcie 5 000 rekordów Cloud Run i na tabeli 50 000 wierszy, obie strony przy ZSTD-19:

| Punkt odniesienia | Logi | Tabela relacyjna |
|---|---:|---:|
| wejście + ZSTD-19 | 290,1 KiB | 2 995,9 KiB |
| Parquet, ustawienia domyślne | 260,3 KiB | 3 205,3 KiB |
| Parquet, najlepszy z przemiecionej siatki | 220,8 KiB | 2 495,7 KiB |
| **SLC4Z** | **205,8 KiB** | **2 287,0 KiB** |
| | −6,8% | −8,4% |

Czyli **jednocyfrowe procenty wobec strojonego Parqueta**, a nie 28×, które wychodzi przy mierzeniu względem nieskompresowanego JSON-a. Wynikają z tego dwie rzeczy, obie rozwinięte w dokumencie badawczym:

- Parquet pozwala czytać wybrane kolumny i filtrować bez pełnej dekompresji; SLC4 wymaga zdekodowania całości. Dla większości zastosowań archiwizacyjnych ta funkcja jest warta więcej niż 8% objętości i **Parquet pozostaje lepszym wyborem inżynierskim**.
- Tym, co różni SLC4 jakościowo, jest **wierność reprezentacji**. Spłaszczenie czternastu schematów próbki do jednego szerokiego schematu Parqueta dołożyło średnio 2,73 klucza o wartości null na rekord i dotknęło wszystkich 5 000 rekordów: format jednoschematowy nie odróżnia „pola nie ma" od „pole jest i ma null". Dla wejścia CSV i SQL round-trip SLC4 jest bajtowy.

Dokument opisuje też dwa błędy pomiarowe popełnione przy tworzeniu baseline'u Parqueta — oba działały na korzyść jednej ze stron. Są tam, bo wniosek się uogólnia: **baseline trzeba walidować równie rygorystycznie jak własny format, a jego konfigurację przemiatać, nie dobierać ręcznie.**

## O projekcie

Prototyp packera/unpackera SLC4 działający **w całości po stronie przeglądarki**.
Kodek jest w JavaScripcie, ZSTD w WebAssembly. Nie ma backendu — logi nigdy nie
opuszczają maszyny użytkownika, a serwer wyłącznie oddaje pliki statyczne.

Deployowalna aplikacja to zawartość katalogu `web/`. Nic poza tym.

## Uruchomienie na XAMPP

Nie jest potrzebny PHP, MySQL ani żadne rozszerzenie — Apache tylko serwuje pliki.

**Wariant A — dowiązanie (zalecany do pracy, edycje widać od razu):**

```bash
mklink /J C:\xampp\htdocs\slc4-web C:\python\slc4_js\web
```

**Wariant B — kopia:**

```bash
xcopy /E /I /Y C:\python\slc4_js\web C:\xampp\htdocs\slc4-web
```

Następnie otwórz `http://localhost/slc4-web/`.

Dołączony `web/.htaccess` ustawia MIME `application/wasm` dla pliku `.wasm` —
bez tego `WebAssembly.instantiateStreaming()` odrzuca moduł. Wymaga
`AllowOverride All` dla `htdocs` (domyślne w XAMPP).

## Uruchomienie bez XAMPP

```bash
npm start
```

Serwuje `web/` pod `http://127.0.0.1:8080`. `dev-server.mjs` to wyłącznie serwer
plików statycznych — nie ma żadnego API, bo cała praca dzieje się w przeglądarce.
`npm install` nie jest potrzebny: projekt nie ma zależności runtime.

## Deployment na hosting PHP (Cyber_Folks)

Wrzuć **zawartość** `web/` do `public_html/` (lub podkatalogu). To wszystko —
żadnego `composer install`, żadnego procesu Node, żadnych migracji. Wymagania:

- Apache z `mod_mime` (dla `AddType application/wasm`),
- HTTPS lub `localhost` — bez bezpiecznego kontekstu przeglądarka nie uruchomi
  modułowego Web Workera.

## Spróbuj na czymś

W `examples/` leżą dwa małe archiwa do natychmiastowego otwarcia oraz źródłowy CSV dla jednego z nich, żeby bajtową wierność dało się **sprawdzić, a nie przyjąć na wiarę**:

```bash
node cli.mjs inspect examples/logs-sample.slc4z
node cli.mjs unpack examples/orders-sample.slc4z -o odtworzone.csv
cmp odtworzone.csv examples/orders-sample.csv     # identyczne co do bajtu
```

To również na nich wciśniesz Enter po zainstalowaniu wtyczki do Total Commandera. Opis: [examples/README.md](examples/README.md).

## Pobieranie binariów

Gotowe pliki wykonywalne są publikowane jako **aktywa wydania**, a nie commitowane do repozytorium. Powód warto nazwać: `slc4.exe` waży 90 MB, bo zawiera runtime Node, każdy rebuild daje całkowicie inny blob, a git trzyma wszystkie wersje na zawsze — kilka wydań zamieniłoby repozytorium o rozmiarze 600 KB w klon ważący setki megabajtów, dla każdego, na każdej platformie, niezależnie od tego, czy binarka dla Windows jest mu potrzebna.

Oba artefakty są opcjonalne. Aplikacja webowa nie potrzebuje żadnego, a CLI działa pod dowolnym Node 18+. Jeśli jednak je pobierasz, sprawdź najpierw opublikowaną sumę SHA-256; plik wykonywalny jest **niepodpisany**, ponieważ wstrzyknięcie ładunku do kopii `node.exe` unieważnia podpis Authenticode, który ta kopia niosła, a wysyłanie uszkodzonego podpisu byłoby gorsze niż brak podpisu.

## Formaty wejściowe

Rozpoznawane po nazwie pliku, a gdy ta nic nie mówi — po pierwszych bajtach.
`--format json|jsonl|csv|sql` wymusza czytnik.

| Format | Rozszerzenia | Round-trip |
|---|---|---|
| JSON obiekt / tablica obiektów | `.json` | wartości (bez kolejności kluczy) |
| JSONL / NDJSON | `.jsonl` `.ndjson` | wartości |
| CSV / TSV | `.csv` `.tsv` | **bajtowy** |
| Zrzut PostgreSQL | `.sql` | **bajtowy** |

**CSV.** Separator (`,` `;` tab `|`), cytowanie wg RFC 4180, koniec linii (LF/CRLF),
BOM, obecność wiersza nagłówka i końcowy znak nowej linii są wykrywane i zapisywane
w nagłówku archiwum. Wartości czytane są **jako tekst**, nie jako liczby — dzięki
temu `0042` nie wraca jako `42`, a `1.50` nie wraca jako `1.5`. Kosztuje to
mniej, niż się wydaje: kodeki `uintstr` i `numtemplate` i tak kodują stringi
liczbowe jako liczby całkowite.

`--infer` zamienia pola na liczby, ale konwertuje wyłącznie te, których zapis
wraca znak w znak, więc bajtowa wierność jest zachowana. **Za to archiwum
rośnie** — zmierzone na 50 000 wierszy: 2 287,0 → 2 358,9 KiB, czyli +3,1%.
Powód jest pouczający: `"1000.00"` zostaje tekstem, bo `1000` to nie to samo co
`1000.00`, a `"3400.45"` staje się liczbą — kolumna robi się mieszana i wpada w
fallback na MessagePack. Kolumny `amount` i `score` urosły tak z 151,8 KiB do
433,4 KiB. Flaga jest więc głównie po to, by dało się wygenerować typowane dane
do porównań z formatami kolumnowymi, a nie po to, by zmniejszać archiwum.

**Zrzuty SQL.** Zrzut to nie tabela: to DDL, ustawienia i sekwencje z blokami
danych pomiędzy. Bloki `COPY ... FROM stdin;` oraz proste polecenia `INSERT`
trafiają do kolumn, a **wszystko pozostałe jest zachowywane dosłownie** jako
segmenty tekstowe. Plik składa się więc z powrotem dokładnie, łącznie z DDL,
komentarzami i pustymi liniami. Konstrukcje, których kodek nie modeluje, po
prostu zostają tekstem — degradacja jest łagodna, nigdy stratna. `\N` mapuje się
na `null`, sekwencje sterujące COPY są dekodowane. Wiele tabel w jednym zrzucie
wykorzystuje rejestr schematów: każda tabela to osobny schemat w tym samym
archiwum.

`pack` weryfikuje round-trip domyślnie i mówi wprost, czy wyszedł bajtowy, czy
tylko na poziomie wartości.

Pomiar na 50 000 wierszy tej samej tabeli w trzech reprezentacjach (ZSTD-19):

| Format | Oryginał | +ZSTD-19 | SLC4Z | SLC4Z lepszy o |
|---|---:|---:|---:|---:|
| CSV | 9,15 MiB | 2 995,9 KiB | 2 287,0 KiB | 23,7% |
| SQL | 9,22 MiB | 3 000,6 KiB | 2 306,0 KiB | 23,1% |
| JSONL | 19,33 MiB | 3 146,4 KiB | 2 280,5 KiB | 27,5% |

Warto zauważyć, że wszystkie trzy zbiegają do ~2,28 MiB: **rozmiar archiwum
jest własnością danych, nie formatu eksportu**, podczas gdy baseline'y różnią
się między sobą.

## CLI i binarka

```bash
node cli.mjs --help
```

Komendy: `pack`, `unpack`, `inspect`, `bench`, `selftest`. Diagnostyka idzie na
stderr, wynik na stdout, więc `-` działa jako stdin/stdout:

```bash
node cli.mjs pack logs.json -o logs.slc4z
node cli.mjs bench ./datasets --levels 3,9,19 --csv wyniki.csv
node cli.mjs pack logs.json -o - | node cli.mjs unpack - -o odtworzone.json
```

`bench` przechodzi katalog rekurencyjnie, dla każdego pliku × trybu selekcji ×
poziomu ZSTD liczy pełną tabelę (raw / input+zstd / canonical+zstd / slc4 /
slc4z, ratio, czasy) i zapisuje CSV — to jest narzędzie pod „Etap A: benchmark
framework" z dokumentu badawczego ([docs/research.pl.md](docs/research.pl.md)).

Samodzielny plik wykonywalny (Node Single Executable Application):

```bash
npm run build:exe
```

Powstaje `dist/slc4.exe` (~86 MiB — zawiera cały runtime Node) i od razu
uruchamia własny `selftest`. Nie wymaga zainstalowanego Node na maszynie
docelowej. Build ściąga `esbuild` i `postject` przez `npx` z przypiętymi
wersjami, więc projekt nadal nie ma zainstalowanych zależności.

Binarka produkuje archiwa **bajtowo identyczne** z `node cli.mjs` (ten sam
backend `node:zlib`).

> Uwaga o podpisie: wstrzyknięcie blobu unieważnia podpis Authenticode
> skopiowanego `node.exe`, więc build usuwa certyfikat z tablicy PE zamiast
> zostawiać uszkodzony podpis. Plik jest więc **niepodpisany** — Windows
> SmartScreen może go zgłosić przy pobraniu z sieci.

## Wtyczka do Total Commandera (.wcx64)

```bash
npm run build:exe     # najpierw binarka - wtyczka jej wola
npm run build:wcx     # potem dist/slc4.wcx64
npm run check:wcx     # test bez uruchamiania TC
```

`dist/slc4.wcx64` (189 KiB) to cienka warstwa w C — nie zna formatu SLC4, tylko
uruchamia `slc4.exe`, który musi leżeć **obok niej**. Dzięki temu kodek istnieje
w jednym miejscu, a archiwa pokazywane w TC są tymi samymi, które produkuje CLI
i aplikacja webowa.

`.slc4z` mieści jeden dokument, nie drzewo plików, więc archiwum pokazuje się
jako dwa wpisy:

```text
<nazwa>.json              odkodowany payload
<nazwa>.slc4-report.txt   wyjscie inspect: kodek wybrany per kolumna
```

Ten drugi wpis sprawia, że F3 na archiwum od razu odpowiada, *dlaczego* wyszło
tyle, ile wyszło — bez rozpakowywania czegokolwiek.

**Instalacja** (przez UI Total Commandera, nie przez edycję `wincmd.ini` — TC
nadpisuje ten plik przy zamykaniu, więc ręczna edycja przy uruchomionym
programie przepada):

1. Konfiguracja → Ustawienia → Archiwizatory → *Konfiguruj obsługę archiwów WCX*
2. Wskaż `dist/slc4.wcx64`, rozszerzenie: `slc4z`

Potem Enter na `.slc4z` wchodzi do archiwum, F5 rozpakowuje, Alt+F5 pakuje
zaznaczony `.json`/`.jsonl`.

Świadome ograniczenia w `GetPackerCaps`: brak `PK_CAPS_BY_CONTENT` (wykrywanie
po zawartości widziałoby goły nagłówek Zstandard i wtyczka zagarnęłaby wszystkie
pliki `.zst` w systemie) oraz brak `PK_CAPS_MULTIPLE` (`.slc4z` mieści jeden
dokument, więc próba spakowania dwóch plików dostaje `E_TOO_MANY_FILES` zamiast
po cichu zgubić dane). Format jest jednostrumieniowy, więc nie ma też
`PK_CAPS_MODIFY` ani usuwania z archiwum.

Otwarcie archiwum dekoduje je raz do katalogu tymczasowego; listowanie i
ekstrakcja czytają stamtąd, a `CloseArchive` sprząta.

### Testowanie wtyczki

`npm run check:wcx` buduje z [wcx/wcxtest.c](wcx/wcxtest.c) hosta, który ładuje
DLL i przepędza ją przez ten sam cykl co Total Commander — otwórz, wylistuj,
rozpakuj, zamknij, spakuj — więc wtyczkę da się sprawdzić bez uruchamiania TC.
16 kontroli, w tym: payload bajtowo identyczny z `slc4 unpack`, wywoływanie
callbacku postępu, odmowa spakowania dwóch plików i odrzucenie pliku, który nie
jest archiwum.

Kontrolą jest zgodność z CLI, nie z oryginałem sprzed pakowania — SLC4 zachowuje
wartości JSON, nie kolejność kluczy, więc bajtowa równość z oryginałem nigdy nie
była kontraktem. Zgodność z oryginałem sprawdzana jest semantycznie, po stronie
Node.

### Kompilator

`build-wcx.mjs` bierze pierwszy dostępny z: `tools/zig` → `zig` z PATH → `gcc`
(MinGW-w64) → `cl` (MSVC). W projekcie leży rozpakowany **Zig 0.16.0** w
`tools/zig` (383 MB) — pobrany z ziglang.org, suma SHA-256 zweryfikowana.
Po zbudowaniu wtyczki można go skasować; do kolejnego builda trzeba go wtedy
wskazać ponownie.

## Testy

```bash
npm run check
```

`test.mjs` sprawdza przede wszystkim **zgodność formatu**, bo kodek został
przeniesiony z `Buffer` na `Uint8Array` i nie wolno, by zmienił choć jeden bajt:

- archiwa mają identyczne SHA-256 co wzorce w `fixtures/`,
- ścieżka przeglądarkowa (z usuniętym `globalThis.Buffer`, czyli na samym shimie)
  daje te same bajty co ścieżka natywna,
- `.slc4z` z implementacji Node otwiera się w wersji webowej i odwrotnie,
  bajtowo identycznie, dla `raw`/`zstd` × poziomów 3/19,
- MessagePack koduje identycznie jak pierwotna implementacja,
- 1500 uszkodzonych strumieni kończy się czystym błędem — bez OOM i bez zwieszki,
- realny build WASM (ten sam plik, który ładuje przeglądarka) jest ładowany w Node
  przez hook `instantiateWasm` i sprawdzany w obie strony przeciw `node:zlib`.

- CSV i zrzuty SQL wracaja bajtowo identyczne przez pelna sciezke pack/unpack,
  dla wszystkich wykrywanych dialektow.

Razem 96 kontroli.

## Architektura

```text
web/
  index.html          UI (bez logiki kodeka)
  app.js              warstwa prezentacji, rozmawia z workerem
  worker.js           Web Worker: cała praca kodeka i ZSTD
  lib/
    slc4_codec.js     uniwersalny kodek V4
    slc4_archive.js   kontener .slc4z + pipeline analizy/benchmarku
    tabular.js        czytniki CSV i zrzutow PostgreSQL
    msgpack.js        minimalny MessagePack
    bytes.js          operacje na Uint8Array
    buffer-shim.js    Buffer-kompatybilna klasa; pozwala trzymać kodek
                      w jednej wersji dla Node i przeglądarki
    zstd-wasm.js      backend ZSTD dla przeglądarki (+ limit dekompresji)
    zstd-node.js      backend ZSTD dla Node (node:zlib / CLI)
    zstd/             vendorowany @bokuweb/zstd-wasm 0.0.27 (MIT)

cli.mjs               CLI: pack / unpack / inspect / bench / selftest
build-exe.mjs         build dist/slc4.exe (Node SEA)
build-wcx.mjs         build dist/slc4.wcx64 (wtyczka Total Commandera)
dev-server.mjs        serwer plików statycznych do pracy lokalnej
test.mjs              zestaw regresji kodeka
test-wcx.mjs          test wtyczki (buduje hosta udającego TC)
wcx/                  źródło wtyczki w C + host testowy
fixtures/             wzorce odniesienia dla testów zgodności formatu
tools/zig/            kompilator do zbudowania wtyczki (do skasowania)
```

Backend ZSTD jest **wstrzykiwany**, nie importowany — dlatego ten sam kodek
działa w przeglądarce i w Node bez rozwidlenia na dwie implementacje.

## Co obsługuje

- JSON object, JSON array of objects, JSONL / NDJSON, CSV/TSV, zrzuty PostgreSQL
- automatyczne wykrywanie schematów liściowych i kolumnizację wartości
- generyczne kodeki: const, bitpack, dictionary, RLE, varint, delta,
  delta-of-delta, timestamp, numeric template, IPv4, HEX, prefix, front coding,
  raw / MessagePack fallback
- wybór kandydata `raw` albo `ZSTD-aware`
- końcowy ZSTD 1..22, pack/unpack `.slc4z`, analiza i benchmark w UI

## Zgodność formatu

Format **SLC4 / SLC4Z v1** bez zmian.

Strumień semantyczny SLC4 jest bajtowo identyczny niezależnie od backendu ZSTD —
sprawdzone testem, bo to on niesie całą logikę kodeka. Natomiast **finalna
warstwa ZSTD może różnić się o ułamek procenta** między backendami: Node ma inną
wersję biblioteki zstd niż build WASM i na tym samym poziomie potrafią wyemitować
różne, obie poprawne ramki (na próbce Cloud Run: 210 780 B vs 210 438 B, 0,16%).

To nie ma znaczenia dla zgodności — różne buildy zstd czytają nawzajem swoje
ramki, a `npm run check` weryfikuje wszystkie cztery kombinacje spakuj/odczytaj
między Node a WASM.

Nie są zachowywane nieistotne dla JSON-a: whitespace i pierwotna kolejność
kluczy obiektu.

## Odporność dekodera

Archiwum `.slc4z` jest danymi niezaufanymi. Dekoder waliduje każdą liczbę z
metadanych względem bajtów, które faktycznie są w pliku, zamiast alokować na
podstawie zadeklarowanej wartości: limit rozmiaru archiwum i dekompresji,
kontrola offsetów i długości kolumn, szerokości bitowych, liczby przebiegów RLE
oraz indeksów schematów i ścieżek.

## Pliki zastane (`legacy`)

`server.js`, `static/`, `slc4_codec.js`, `msgpack.js`, `zstd.js` to wcześniejsza
wersja z backendem w Node (API `POST /api/analyze|pack|unpack|inspect-archive`).
Nadal działa (`npm run legacy:server`, `npm run legacy:check`) i służy w testach
jako niezależny punkt odniesienia dla zgodności formatu. Na hostingu PHP jest
bezużyteczna — do usunięcia, gdy przestanie być potrzebna jako referencja.

`app.py` i `slc4_codec.py` to implementacja referencyjna w Pythonie.

> Uwaga: implementacje JS i Python różnią się w rozróżnianiu int/float
> (`Number.isInteger` vs typy Pythona), a w repo nie ma testu porównującego je
> ze sobą. Deklarowana w tym pliku zgodność JS↔Python nie jest obecnie niczym
> pilnowana automatycznie.

## Konfiguracja

```bash
PORT=8080   # tylko dla dev-server.mjs
```

Limity dekodera są w `web/lib/slc4_archive.js` (`LIMITS`) oraz
`web/lib/slc4_codec.js` (`LIMITS`).

## Licencja

Kod jest na licencji **Apache License 2.0** ([LICENSE](LICENSE)), która zawiera jawne udzielenie praw patentowych.

Dokument badawczy w `docs/` jest na licencji **CC BY 4.0** ([LICENSE-DOCS.txt](LICENSE-DOCS.txt)) — wolno go kopiować, tłumaczyć i cytować, wskazując autorstwo.

**Formaty SLC4 i SLC4Z może zaimplementować każdy, w dowolnym języku i w dowolnym celu. Nie są zgłaszane do nich żadne roszczenia patentowe.** Szczegóły w [NOTICE](NOTICE).

## Pochodzenie

Pomysł, eksperymenty i pierwotny opis powstały po polsku, i to [wersja polska](docs/research.pl.md) dokumentu jest kanoniczna. [docs/research.en.md](docs/research.en.md) jest tłumaczeniem; w razie rozbieżności rozstrzyga tekst polski.

W repozytorium **nie ma żadnych danych produkcyjnych**. Wszystkie zbiory w `fixtures/` są syntetyczne i generowane kodem stąd. Katalog `test/` jest celowo wykluczony w `.gitignore`, ponieważ próbki logów z natury zawierają wartości produkcyjne.
