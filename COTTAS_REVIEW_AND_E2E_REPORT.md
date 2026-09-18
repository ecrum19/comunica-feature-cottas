# COTTAS Comunica feature — review + end-to-end test report

**Date:** 2026-09-18 · **Commit:** `48b14eb` (+ the `pageSize` fix below) · **Host:** `vcf-bench-1` (8 cores, 31 GB, Node 24.16.0)
**Scratch:** `~/cottas-e2e-test` on the VM (repo clone + harnesses + logs). Existing VM data was only read.

---

## TL;DR

- **Correctness is solid for the data you actually have.** 64/64 checks against DuckDB ground truth passed on two real pycottas genome files, including an exact md5 fingerprint of a 94,919-triple full scan across 742 pages.
- **Two real bugs.** One silently drops results (term canonicalisation), one ignores a Comunica context flag (`unionDefaultGraph`).
- **Performance was the real problem — now fixed.** Paging re-scanned the Parquet file on every ~64-row page. Porting HDT's growing-page policy (see "Fix applied") made a full 959k-triple scan **17× faster** and turned `LIMIT 10000` on the 498M-triple HG005 file from a 5-minute timeout into **14.9 s**.

---

## Bugs

### 🔴 C1 — Constant pushdown does raw string equality → silent missing results

`CottasDocument.serializeTerm` serialises the query constant with N3's N-Triples writer, then does `o = $term` in SQL. Any **legal but non-canonical** N-Triples encoding in the file decodes fine on read but can *never* be matched by a constant.

Demonstrated 4× — read the term back out of the file, feed it straight back in as a constant, get **0 rows, no error**:

| stored in file | read back as | re-query result |
|---|---|---|
| `<urn:café>` | `urn:café` ✅ | **0** ❌ |
| `"café"` | `café` ✅ | **0** ❌ |
| `"hi"@EN` | `"hi"@en` ✅ | **0** ❌ |
| `"plain"^^<xsd:string>` | `"plain"` ✅ | **0** ❌ |

Controls (canonical `<urn:café>`, `"hi"@en`) → 1 row ✅.

RDF 1.1 says language tags compare case-insensitively and `"x"` ≡ `"x"^^xsd:string`, so cases 3 and 4 are outright spec violations, not just encoding pedantry.

**Impact today: none for your VCF data** — I checked the real files, pycottas writes canonical forms (`"1"`, `"1"^^<…integer>`, `<…>`). But nothing in the reader enforces or checks this, and the failure mode is silent.

**Options:** normalise/validate at `openCottasDocument`; or widen the SQL predicate (case-insensitive compare on the lang-tag suffix, accept both `"x"` and `"x"^^<xsd:string>`); or at minimum document the canonicalisation requirement and fail loudly.

### 🟠 C2 — `unionDefaultGraph` is ignored

`patternSql` unconditionally pushes `g IS NULL` for a default-graph pattern. Comunica's own RDF/JS source honours `KeysQueryOperation.unionDefaultGraph`. Measured side by side in one engine on identical data:

```
SELECT * WHERE { ?s ?p ?o }   with unionDefaultGraph: true
  cottas source        -> 2 solutions   ❌
  serialized n-quads   -> 4 solutions   ✅
```

Only affects quad `.cottas` files. Your genome files are triple-only, so no impact today.

---

## Design / robustness notes

- **D1 — paging was the cost, and the page was ~64 rows, not 128.** ✅ *Fixed — see "Fix applied" below.* Every `_read` issues a fresh `read_parquet(...) ORDER BY file_row_number LIMIT n OFFSET k`. Instrumented a 100k-row scan: **1,517 DuckDB round trips**, limit histogram dominated by `64` and `68` — `BufferedIterator` tops up in half-buffer increments, so `maxBufferSize: 128` yields ~64-row pages. Per-page cost **8.9 ms @ offset 0 → 34.7 ms @ offset 800k**.
  Raising `maxBufferSize` does **not** help (128 → 32768 for 32k rows: 5.26 s → 5.11 s) because the top-up size decides, not the config.
  A single `searchBindings(limit=32000)` is only **322 ms** — so the adapter is fine; it's the round-trip count + OFFSET rescans. **Fixed by porting HDT's growing-page policy — see "Fix applied" below.**
- **D2 — one connection, fully serialised.** `enqueue()` chains every operation on a single `DuckDBConnection`, so concurrent patterns in a join can't overlap. DuckDB supports multiple connections per instance.
- **D3 — `countPattern` fires from the `CottasIterator` constructor.** Cheap in isolation (2 ms, Parquet metadata), but it's one extra query per iterator — with bind joins that's one per binding.
- **D4 — `_read` silently truncates on a closed document.** `if (doc.closed) { this.close(); done(); }` emits `end`, not an error. An `httpInvalidator` event mid-query (`clearCache()` with no URL disposes *all* cottas sources) would hand back partial results with no signal.
- **D5 — no disposal path.** Over 1000 queries on one engine: `openCottasDocument` called **1×** (good — source is cached), `close()` called **0×**. The DuckDB instance lives as long as the engine with no documented release API. RSS 182 → 424 MB over those 1000 trivial queries, 352 MB after GC — worth a look, not attributed to a specific defect.
- **D6 — README's Node claim is wrong.** "Node.js 22 or newer" — `yarn install --frozen-lockfile` **fails on Node 22.20.0** (`npm-check-updates` needs `^22.22.2 || ^24.15.0 || >=26`). Fine on 24.16.0.

### Checked and *not* COTTAS bugs

- `FROM NAMED` → `none of the configured actors were able to handle the operation type pattern`. **Identical failure with a `serialized` N-Quads source in the same engine** → upstream Comunica 5.3.0 issue, not yours.
- Blank nodes come back as `bc_0_x` — that's Comunica skolemisation, correct. Identity holds across page boundaries and joins (verified with the same bnode in rows 0 and 901 of a 903-row file).

### Test-suite gap

67/67 unit tests passed at **100% coverage** — but every fixture is ≤ 5 rows. **Nothing in the repo exercises more than one buffer page**, so the entire paging path (the part that's both slow and easiest to get wrong) was untested. The checklist's Phase 5 "joins and integration" claim rests on a 4-triple fixture.

---

## What was tested

Files (all pycottas output; schema confirmed `s`/`p`/`o` VARCHAR, no `g`):

| file | triples | size |
|---|---:|---:|
| `test-1k.cottas` | 94,919 | 179 KB |
| `test-10k.cottas` | 958,919 | 1.4 MB |
| `HG005_GRCh38_1_22_v4.2.1_benchmark.cottas` | 497,642,517 | 1.27 GB |

| suite | result |
|---|---|
| unit suite (`yarn test-ci`) | **67/67** before, **71/71** after the fix — 100% coverage throughout |
| e2e vs DuckDB ground truth — test-1k | **32/32** (re-run after the fix: still 32/32) |
| e2e vs DuckDB ground truth — test-10k | **32/32** (re-run after the fix: still 32/32) |
| edge cases (terms, graphs, errors, federation) | 22/27 → fails = C1, C2, upstream `FROM NAMED`, 2 bad expectations of mine |
| edge cases 2 (bnodes, non-canonical encodings) | 10/14 → all 4 fails are C1 |
| static CLI + dynamic CLI | ✅ SELECT/ASK/CONSTRUCT/COUNT, clean error on missing file |
| HTTP endpoint | ✅ GET+POST, JSON/CSV, 400 on bad syntax, 3 concurrent queries correct |

Correctness highlights:

- Full scan of test-1k reproduced the **exact md5 fingerprint** of the 94,919-triple multiset over 742 pages — 0 duplicates, 0 gaps.
- Same equality (count + distinct s/p/o) at **958,919 triples over 7,492 pages**.
- First 20 solutions matched Parquet row order exactly (the documented determinism claim holds).
- `LIMIT` at 1/2/127/**128**/129/256/257/512 all exact and duplicate-free; `OFFSET 127 LIMIT 3` straddles the page boundary correctly.
- Joins (object–subject, star, 3-pattern), `ASK`, `CONSTRUCT`, `COUNT(*)`, `DISTINCT`, `FILTER`, `OPTIONAL`, typed/plain literal pushdown, repeated variables, `GRAPH ?g` over a triple file, two-source federation — all matched DuckDB.
- Error paths all give actionable messages: missing file, directory, glob, URL, non-VARCHAR column, wrong/extra column names.

---

## Performance

**test-10k — 958,919 triples**

| query | before | after (fixed) | speed-up | DuckDB |
|---|---:|---:|---:|---:|
| full `?s ?p ?o` scan | 229 s | **13.5 s** | 17× | < 1 s |
| `SELECT (COUNT(*) AS ?c)` | 226 s | **13.6 s** | 16.6× | — |
| `SELECT DISTINCT ?p` | 226 s | **12.3 s** | 18.3× | — |
| most frequent predicate (179,811 rows) | 21.8 s | **1.8 s** | 12× | — |
| typed-literal object (59,930 rows) | 6.1 s | **0.67 s** | 9.2× | — |

Before the fix, throughput *degraded* with read depth — 128 µs/row @ 2k → 325 µs/row @ 64k. After, it *improves* with depth and converges on the DuckDB floor:

| solutions read | before µs/row | after µs/row | DuckDB µs/row |
|---:|---:|---:|---:|
| 1,000 | 201 | 119 | 18 |
| 8,000 | 192 | 17.4 | 8.6 |
| 64,000 | 325 | **12.7** | 4.6 |

The engine went from **25–70× slower than raw DuckDB and widening** to **~2.7× slower and narrowing**.

**HG005 full genome — 497.6M triples**

| query | before | after (fixed) |
|---|---:|---:|
| open + exact cardinality (497,642,517) | 0.5 s ✅ | 0.6 s ✅ |
| `LIMIT 1` | 2.3 s | 2.4 s |
| `LIMIT 128` | 5.9 s | 4.4 s |
| `LIMIT 1000` | 45.8 s | **10.7 s** |
| `LIMIT 10000` | ⏱ **timeout @ 300 s** | **14.9 s** |
| `ASK` present / absent | 4.3 s / 3.8 s | 2.6 s / 1.8 s |
| rarest predicate (1 result) | 7.4 s | 3.6 s |
| `OFFSET 400000000 LIMIT 5` | ⏱ timeout @ 300 s | ⏱ **still times out** |

Sustained throughput went from ≈22 solutions/s to ≈2,100 solutions/s once the page ramp reaches 8192 (the first ~2.4 s is fixed startup). A 1M-solution result drops from ~13 hours to roughly **8 minutes**.

**Still slow:** a large explicit `OFFSET` (400M rows deep) times out either way — `pageSize` doesn't help there, because DuckDB must still skip 400M rows to serve the page. Rare in practice, but it's the one shape that hasn't improved.

---

## Fix applied — growing page sizes (`pageSize`)

Ported from `comunica-feature-hdt@3c013d6` ("Read HDT documents in growing pages instead of buffer-sized chunks", #36). That commit exists upstream; this repo was forked before it landed.

### What changed

| file | change |
|---|---|
| `lib/CottasIterator.ts` | new `pageSize` option (default `0` = old behaviour). `_read` now requests `limit = max(count, min(pageSize, nextPageSize))` and doubles `nextPageSize` each page, so pages ramp 128 → 256 → … → 8192 and then stay there. |
| `lib/QuerySourceCottas.ts` | takes `pageSize`, forwards it to the iterator. |
| `lib/ActorQuerySourceIdentifyCottas.ts` | new `pageSize` config parameter, `@range {integer}`, `@default {8192}`. |
| `README.md` (actor) | added the Comunica-standard **Config Parameters** list documenting `maxBufferSize` and `pageSize`. |
| 3 test files | constructor args updated; 3 new `CottasIterator` tests (growth ramp, buffer-sized control, `pageSize < maxBufferSize`) and 1 new actor test (parameter forwarding). |

`maxBufferSize` keeps its old meaning (how far the iterator buffers ahead of its consumer); `pageSize` is now a separate knob for how much one DuckDB call fetches. That separation is the whole point — the old code conflated them, and `BufferedIterator` tops its buffer up in half-buffer increments, which is why the effective page was ~64 rather than the configured 128.

I deliberately kept the three places where this repo is *better* than HDT: `position += bindings.length` inside the callback (HDT advances by `limit` synchronously), `destroy(error)` rather than `emit('error')`, and the idempotent `dispose()`.

### Verification

- `yarn run build` ✅ — `componentsjs-generator` emits `pageSize` with `default: 8192`, `range: xsd:integer`; recompiled `engine-default.js` contains `pageSize': 8192`.
- `yarn run lint` ✅ clean.
- `yarn run test-ci` ✅ **71/71 tests** (was 67), **100% statement/branch/function/line coverage** held.
- Full e2e re-run vs DuckDB ground truth: **32/32 on test-1k, 32/32 on test-10k** — unchanged.
- Both edge suites: **same 5 and 4 failures as before, no new ones** (C1, C2, upstream `FROM NAMED`, and 2 wrong expectations in my own harness). No correctness regression.

### The round-trip collapse

Instrumented `searchBindings` over a 100,000-solution read of test-10k:

| | before | after |
|---|---:|---:|
| DuckDB round trips | **1,517** | **18** |
| page sizes requested | mostly `64` and `68` | `128, 256, 512, 1024, 2048, 4096, 8192×12` |
| wall clock | 33.0 s | **1.45 s** |

**84× fewer round trips, 22.8× faster.** The doubling ramp is exactly as designed.

### Note on one stale row

The `scaling.cjs` "effect of page size" table still reads ~5.2 s at every `maxBufferSize` from 128 to 32768. That is not a regression — that probe drives `CottasIterator` directly *without* passing `pageSize`, so it still measures the old path. It now serves as the control that proves the point: turning `maxBufferSize` up alone does nothing, which is precisely why a separate `pageSize` was needed.

---

## Benchmark workflow — VM validation (branch `benchmark-workflow`)

Run on **vcf-bench-1** and **vcf-bench-2** (each 8 cores, 31 GB, Ubuntu, Docker 29.7.2), Node 26.9.0,
from a clean checkout of commit `7782bbd` in `~/cottas-bench-test`. Existing VM data untouched.

### Works

| Step | Result |
|---|---|
| `yarn install --frozen-lockfile --ignore-engines` | ✅ 59 s |
| `yarn run test-performance` | ✅ 9/9 script tests + 4 JBR config validations |
| WatDiv-10 `performance:prepare` | ✅ **47 s** — checksum-verified asset fetch, JBR prepare, Docker image build, pycottas conversion |
| WatDiv-10 `performance:run` | ✅ **30.4 min**, exit 0, 0 query errors, `check-results.js` passed |
| BSBM-1k `performance:ci` (vcf-bench-2) | ▶ running at time of writing |

Conversion output is sound: 152 MB `dataset.nt` → **4.76 MB `dataset.cottas`** (32× smaller) for
1,079,876 triples, with `dataset.cottas.json` recording pycottas 1.1.0 / duckdb 1.4.3 / pyoxigraph
0.3.18 versions, the SPO+ZSTD-22+Parquet-v2 policy, the triple count, and both SHA-256 digests.

### Measurements — WatDiv scale 10, 100 query instances × (1 warmup + 3 replications)

20 metrics, **sum of medians 89.0 s**. Two templates are 78% of that:

| Template | Median | Rows returned |
|---|---:|---:|
| C3 | 40.1 s | 244,010 |
| C2 | 30.0 s | 0 |
| C1 | 5.8 s | 0 |
| F2/F3 | ~1.2 s | 3 / 4 |
| everything else | < 1 s | small |

**Seven of twenty templates (C1, C2, F1, S3, S4, S5, S7) return zero rows on every instantiation**,
with `error=false`. I checked this against DuckDB rather than assuming: for S3, 162 subjects are in
`ProductCategory8` but none carries all of `caption` + `hasGenre` + `publisher`, so **0 is the
correct answer**. The WatDiv instantiations are simply selective — not an engine defect. It does
mean a large part of the suite measures empty-result latency rather than result throughput.

### Issues found

- 🔴 **The 120-minute CI timeout will not hold.** WatDiv-10 alone took 30.4 min for the head engine.
  On a pull request the job runs base *and* head sequentially, so that benchmark is already ~61 min
  of the 120-minute budget before WatDiv-100 or BSBM-10k are considered. WatDiv-100 is ten times the
  data. Either raise `timeout-minutes`, cut `queryRunnerReplication`, or split the matrix further.
- 🟠 **`libatomic1` is an undocumented prerequisite.** Node 26 will not start on a stock Ubuntu image
  without it (`error while loading shared libraries: libatomic.so.1`). Needs
  `sudo apt-get install -y libatomic1`; `ubuntu-latest` on GitHub Actions already has it, so this
  only bites on a VM. Worth a line wherever the Node requirement is stated.
- 🟡 **`performance:run` is not idempotent against a stale endpoint.** Port 3001 must be free; a
  leftover endpoint from an interrupted run makes the next one measure the wrong engine silently.
  A pre-flight port check in `performance:run` would be cheap insurance.

### Not yet validated

WatDiv-100 and BSBM-10k (the large-dataset conversion path, and the main memory/disk risk), and the
PR/base comparison path including `summarize-results.js --compare` against real artifacts. The
unit tests cover the comparison arithmetic and the 150% threshold, but not a real two-checkout run.

---

## Suggested priority

1. ~~**D1** — paging~~ ✅ **done** (see "Fix applied"). 17× on a 959k-triple scan; HG005 `LIMIT 10000` went from a 5-minute timeout to 14.9 s.
2. **C1** — silent wrong answers are now the worst outstanding item, even if your current data dodges it.
3. Add a **> 128-row fixture** to the unit suite. The fix added three page-ramp tests against the mock, but there is still no *real* multi-page Parquet fixture in the repo.
4. C2, D4, D6 are small.
5. If genome-scale reads matter more later, the next step beyond `pageSize` is a real DuckDB streaming cursor per iterator — that would also fix the deep-`OFFSET` case, which `pageSize` does not help.
6. Raise the benchmark CI timeout before enabling the matrix on pull requests (see the benchmark section).

---

## Reproducing

Everything is on `vcf-bench-1` under `~/cottas-e2e-test` (1.1 GB, self-contained Node 24 + repo clone + harnesses):

```bash
export PATH=$HOME/cottas-e2e-test/node/bin:$PATH
cd ~/cottas-e2e-test
node e2e.cjs <file.cottas> --profile=small   # full battery vs DuckDB ground truth
node e2e-edge.cjs                            # terms, graphs, error paths
node e2e-edge2.cjs                           # bnodes + non-canonical encodings
node scaling.cjs <file.cottas>               # throughput vs read depth
node pagesize.cjs <file.cottas> 100000       # round-trip count + LIMIT histogram
node profile.cjs <file.cottas> 32000         # per-phase cost breakdown
node bigprobe.cjs <file.cottas> 300000       # bounded probe on a huge file
```

Post-fix logs are in `~/cottas-e2e-test/after/`; the pre-fix logs are in `~/cottas-e2e-test/` itself. The patched sources are in the working tree of `~/cottas-e2e-test/repo` (and locally in this checkout) — **not committed**.
