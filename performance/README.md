# COTTAS performance benchmarks

The benchmark matrix follows [`comunica-feature-hdt` at `ea0eed69`](https://github.com/comunica/comunica-feature-hdt/tree/ea0eed69addf0ee52a9389a6e8fb053c553c3c69/performance), including the larger datasets and [PR/base comparison workflow](https://github.com/comunica/comunica-feature-hdt/commit/fd19999faafe13f725982e82340bc1ff9e3a5476).

| Workspace | Dataset |
| --- | --- |
| `benchmark-watdiv-cottas` | WatDiv scale 10 |
| `benchmark-watdiv-cottas-100` | WatDiv scale 100 |
| `benchmark-bsbm-cottas` | BSBM 1,000 products |
| `benchmark-bsbm-cottas-10k` | BSBM 10,000 products |

## Run on a VM

Use a Linux VM with Node.js 26, Yarn 1.22, Docker, and `unzip`. The larger datasets need several GB of memory and disk space during conversion. No Python installation or manually supplied COTTAS files are needed: the converter runs in Docker. Keep port 3001 free and run the benchmarks sequentially on an otherwise idle VM.

```bash
yarn install --frozen-lockfile --ignore-engines
yarn run verify

for benchmark in watdiv-cottas watdiv-cottas-100 bsbm-cottas bsbm-cottas-10k; do
  yarn workspace "benchmark-$benchmark" performance:ci || break
done
```

Each `performance:ci` command prepares its inputs, converts them to COTTAS, runs the current engine, and checks for missing measurements or query failures. It exits unsuccessfully if any query failed, even if JBR itself exits successfully. Results and endpoint logs are under `benchmark-*/combinations/combination_0/output/`.

To separate preparation from measurements:

```bash
yarn workspace benchmark-watdiv-cottas performance:prepare
yarn workspace benchmark-watdiv-cottas performance:run
```

`performance` runs the optional current/published-release Docker comparison. This additionally requires a published `comunica/query-sparql-cottas:latest` image. CI uses the locally built engine and does not need that image.

## Automatic file preparation

BSBM uses JBR's `vcity/bsbm:v1.0` generator, just as HDT does, to produce `generated/dataset.nt` and `generated/td_data/`. WatDiv downloads the same scale-10/100 archives from `comunica-performance-assets`, pinned to commit `8b63d56f87576c3878368567d1c9ef79c2b889ee` and checked against their SHA-256 digests. Only the N-Triples and queries are extracted; the archived HDT files are not used.

After JBR preparation, `scripts/convert-cottas.js` runs the reference **pycottas 1.1.0** writer with pinned dependencies in a Docker image. It uses the writer's SPO ordering, duplicate removal, ZSTD level 22, and Parquet v2 policy. Disk mode keeps its intermediate DuckDB database on the generated-data volume. Conversion happens before timing starts.

The output is `generated/dataset.cottas`. Its companion `dataset.cottas.json` records the writer/dependency versions, compression/index policy, triple count, and input/output SHA-256 digests. A verified output is reused; changed source data, writer settings, or output bytes trigger conversion again. Output is validated before replacing the final file. Generated data and reports are ignored by Git.

The writer image and all Python requirements are pinned in `scripts/cottas-converter/`. `pycottas` was chosen because it is a reference implementation with a published Python package and a defined Parquet writer policy, avoiding a separate Rust/DuckDB compilation in CI.

## CI comparisons

All four benchmarks run on pushes and pull requests, with `fail-fast: false`. On a PR, CI checks out its base commit and runs base and head on the same runner. Both use the head's benchmark harness and exactly the same prepared RDF, query, and COTTAS files; the base engine implementation remains unchanged. This also works when the base predates the new benchmark sizes or converter scripts.

The benchmark-only `**/sparql-benchmark-runner/fetch-sparql-endpoint` resolution is applied to both checkouts. Version 7.1.1 includes the [upstream fix for manually set Content-Length headers](https://github.com/rubensworks/fetch-sparql-endpoint.js/commit/71272cadde2a33a51e1c60eb5de1ab8acb9d7af3); the older client fails when JBR loads a newer Undici dispatcher. Other base dependencies retain their existing lockfile resolutions.

Raw results, endpoint logs, and COTTAS provenance are uploaded as artifacts, including when a run fails. The consolidation job produces detailed and total JSON reports plus an Actions summary. A PR fails the performance check if a benchmark total exceeds **150% of its base time**. Missing measurements, mismatched metric sets, and query errors also fail the check. The measurements use PSBR's medians per query and sums of those medians for totals, matching the HDT reporting approach.

Comparisons support fork PRs without write permissions and do not post PR comments. Historical publication to `comunica-performance-results` runs only from the canonical Comunica repository when its existing `PAT` is configured. No workflow permissions are changed. The separate docs deployment job is unchanged.

## Verification status

The converter was exercised with a 20,003-triple fixture, including a full multi-page engine scan, and with the upstream WatDiv scale-10 (1,079,876 triples) and BSBM 1k (374,911 triples) inputs. The first local WatDiv run exposed the HTTP-client issue described above. Local benchmarking was then stopped at the maintainer's request. Full timing runs, large-dataset conversion, and base/head comparisons still need validation on the VM or GitHub Actions; configuration and unit-test success do not establish performance results.
