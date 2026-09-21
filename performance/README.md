# COTTAS performance benchmarks

The benchmark matrix follows [`comunica-feature-hdt` at `ea0eed69`](https://github.com/comunica/comunica-feature-hdt/tree/ea0eed69addf0ee52a9389a6e8fb053c553c3c69/performance), including the larger datasets and [PR/base comparison workflow](https://github.com/comunica/comunica-feature-hdt/commit/fd19999faafe13f725982e82340bc1ff9e3a5476).

| Workspace | Dataset |
| --- | --- |
| `benchmark-watdiv-cottas` | WatDiv scale 10 |
| `benchmark-watdiv-cottas-100` | WatDiv scale 100 |
| `benchmark-bsbm-cottas` | BSBM 1,000 products |
| `benchmark-bsbm-cottas-10k` | BSBM 10,000 products |

## Automatic file preparation

BSBM uses JBR's `vcity/bsbm:v1.0` generator, just as HDT does, to produce `generated/dataset.nt` and `generated/td_data/`. WatDiv downloads the same scale-10/100 archives from `comunica-performance-assets`, pinned to commit `8b63d56f87576c3878368567d1c9ef79c2b889ee` and checked against their SHA-256 digests. Only the N-Triples and queries are extracted; the archived HDT files are not used.

After JBR preparation, `scripts/convert-cottas.js` runs the reference **pycottas 1.1.0** writer with pinned dependencies in a Docker image. It uses the writer's SPO ordering, duplicate removal, ZSTD level 22, and Parquet v2 policy. Disk mode keeps its intermediate DuckDB database on the generated-data volume. Conversion happens before timing starts.

The converter writes one file per index order: `generated/dataset.cottas` (spog), `generated/dataset.posg.cottas`, and `generated/dataset.ospg.cottas`. They hold the same triples in different row orders, so a pattern with a bound predicate or object can prune row groups rather than scan. Its companion `dataset.cottas.json` records the writer/dependency versions, compression/index policy, triple count, and input/output SHA-256 digests. A verified output is reused; changed source data, writer settings, or output bytes trigger conversion again. Output is validated before replacing the final file. Generated data and reports are ignored by Git.

The writer image and all Python requirements are pinned in `scripts/cottas-converter/`. `pycottas` was chosen because it is a reference implementation with a published Python package and a defined Parquet writer policy, avoiding a separate Rust/DuckDB compilation in CI.

## CI comparisons

All four benchmarks run on pushes and pull requests, with `fail-fast: false`. On a PR, CI checks out its base commit and runs base and head on the same runner. Both use the head's benchmark harness and exactly the same prepared RDF, query, and COTTAS files; the base engine implementation remains unchanged. This also works when the base predates the new benchmark sizes or converter scripts.

The benchmark-only `**/sparql-benchmark-runner/fetch-sparql-endpoint` resolution is applied to both checkouts. Version 7.1.1 includes the [upstream fix for manually set Content-Length headers](https://github.com/rubensworks/fetch-sparql-endpoint.js/commit/71272cadde2a33a51e1c60eb5de1ab8acb9d7af3); the older client fails when JBR loads a newer Undici dispatcher. Other base dependencies retain their existing lockfile resolutions.

Raw results, endpoint logs, and COTTAS provenance are uploaded as artifacts, including when a run fails. The consolidation job produces detailed and total JSON reports plus an Actions summary. A PR fails the performance check if a benchmark total exceeds **150% of its base time**. Missing measurements, mismatched metric sets, and query errors also fail the check. The measurements use PSBR's medians per query and sums of those medians for totals, matching the HDT reporting approach.

Comparisons support fork PRs without write permissions and do not post PR comments. Historical publication to `comunica-performance-results` runs only from the canonical Comunica repository when its existing `PAT` is configured. No workflow permissions are changed. The separate docs deployment job is unchanged.

## Verification status

Every benchmark has been run end to end on a Linux VM (8 cores, 31 GB):

| Benchmark | Result |
| --- | --- |
| `benchmark-watdiv-cottas` | 30 min, no query errors |
| `benchmark-bsbm-cottas` | 25 min, no query errors |
| `benchmark-bsbm-cottas-10k` | 85 min, no query errors (measured before join push-down) |
| `benchmark-watdiv-cottas-100` | 4 min 46 s, no query errors |

The WatDiv figure is from after basic graph patterns began being answered by a single DuckDB query;
before that the same matrix took over seven hours. BSBM 10,000 products has not been re-measured
since that change, so treat it as the job to watch against the 120-minute CI timeout on a pull
request, which runs both the base and the head commit.
