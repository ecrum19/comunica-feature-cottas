# COTTAS benchmark results

Full suite, measured 2026-09-21 on SLICES `vcf-bench-1` (8 cores, 31 GB RAM, Ubuntu, Node 26.9.0).
Engine under test: `207abae`, the first commit on which all four benchmarks pass.

## Results

`prepare` obtains the RDF input and writes the three COTTAS index orders. `run` is the measured
part, and the only part CI times against its 120-minute limit.

| Benchmark | Triples | Prepare | Run | Previously recorded |
| --- | ---: | ---: | ---: | --- |
| `benchmark-watdiv-cottas` | 1 079 876 | 0 m 50 s | **1 m 20 s** | 30 min |
| `benchmark-watdiv-cottas-100` | 10 930 937 | 6 m 16 s | **5 m 16 s** | 4 min 46 s |
| `benchmark-bsbm-cottas` | 374 911 | 1 m 28 s | **2 m 18 s** | 25 min |
| `benchmark-bsbm-cottas-10k` | 3 564 773 | 8 m 47 s | **3 m 19 s** | 85 min |
| **Total** | | **17 m 21 s** | **12 m 13 s** | |

All four exit clean. `performance:run` ends in `check-results.js`, which fails on any query error,
so a zero exit means a complete result set as well as a completed run.

## The previous figures were not comparable

Only the WatDiv scale-100 number was measured against the join push-down. The other three predate
it, and two of them could not have been reproduced at all on current code, for the reason below.

## BSBM never ran against the pushed-down engine until now

Both BSBM benchmarks failed on the first query of their mix:

```
Attempted to pass a join over 'join' to QuerySourceCottas
```

The push-down assumed the planner hands the source one flat list of patterns. As soon as a join
appeared among a join's children, `QuerySourceCottas.queryBindings` rejected it, the endpoint
answered HTTP 400, and the BSBM driver aborted before writing results — surfacing confusingly as a
missing `single.xml`.

Every BSBM query mix opens with a query of that shape: BSBM Q1 has twelve patterns sharing a bound
subject plus three `OPTIONAL` blocks. WatDiv never exposed it, because its queries are plain basic
graph patterns. So the benchmark that motivated the push-down was precisely the one that could not
detect the bug it introduced.

Staged reproduction isolated it. A plain BGP, a BGP with a variable repeated across patterns, and a
BGP with a single `OPTIONAL` all returned correct results; only the full Q1 failed.

Fixed in `207abae` by collecting the patterns recursively. Joining is associative, so a join of
joins of patterns is the same join over all of those patterns. A child that is neither a join nor a
pattern is still rejected, so the guard keeps its purpose.

## CI headroom

A pull request runs both the base and the head commit, so the relevant budget is roughly twice the
run time plus preparation. At 12 m 13 s of run time across all four, the previous concern about
`benchmark-bsbm-cottas-10k` exceeding the 120-minute timeout no longer applies — it is now the
second-fastest job in the matrix.

Preparation dominates, at 17 m 21 s, and is now the larger share of wall-clock. Most of it is ZSTD
level 22 across three index orders; `benchmark-bsbm-cottas-10k` alone spends 8 m 47 s there. It is
cached against the manifest digests, so it is only paid when the source data or writer settings
change.

## Method notes

- A fresh clone was used, with `generated/` hard-linked from the earlier working tree so the `.nt`
  inputs were reused and only the COTTAS conversion re-ran. Conversion re-ran everywhere regardless,
  because the manifest now records three index orders where it previously recorded one.
- JBR's SPARQL endpoint hook is a local Node process, not a container. Cleaning up containers and
  networks between benchmarks leaves it holding port 3001, and the next benchmark then fails with a
  connection refusal that looks nothing like a port conflict. The runner reaps the endpoint and
  asserts the port is free before each benchmark, aborting rather than recording a bogus number.
- One BSBM-10k attempt was invalidated when its endpoint was killed mid-run during that
  investigation, and was re-run from scratch; the figure above is from the clean run.

## Caveats

- Single run per benchmark, not a repeated-trial mean. JBR itself does 5 warmup runs and 10 measured
  runs per query, and the reported totals are sums of per-query medians, but the wall-clock figures
  here are one observation each and will vary by some tens of seconds.
- The machine was otherwise idle, but it is a shared VM.
- WatDiv triple counts are below the figures HDT quotes for the same scales (1 079 876 against
  1 093 111) because the writer removes duplicates. BSBM is duplicate-free and matches exactly.
