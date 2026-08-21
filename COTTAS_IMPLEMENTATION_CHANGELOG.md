# COTTAS Querying Implementation Changelog

## 2026-08-21 — Initial querying implementation

### Format and runtime decisions

- Verified against `pycottas` and `cottas-rs` that COTTAS is an Apache Parquet table with `s`, `p`, `o`, and optional `g` columns. All present columns must be `VARCHAR`.
- Verified that cells contain N-Triples RDF terms. Quad tables use `NULL` in `g` for the default graph and a serialized named or blank node for a named graph.
- Selected `@duckdb/node-api` `^1.5.5-r.4`. It supplies promise-based, prebuilt native bindings for supported Linux, macOS, and Windows architectures.
- Scoped one source to one local regular file. URLs, globs, directories, and multi-file sources are rejected to keep source identity, invalidation, and lifecycle ownership unambiguous.
- Kept the feature Node-only. The engine browser entry point throws an explicit unsupported-platform error before native DuckDB code can be bundled.

### Reader architecture

- Implemented `CottasDocument` as the only DuckDB-aware layer. Each open document owns an in-memory DuckDB instance and connection.
- Validation uses `DESCRIBE SELECT * FROM read_parquet($path)` with a bound path. Queries also bind the path, RDF constants, limit, and offset; user-controlled values are never interpolated into SQL.
- Pattern translation pushes constants, default/named-graph restrictions, and repeated-variable equality into DuckDB. Triple files answer only default-graph patterns; graph variables range over non-null named graphs in quad files.
- RDF/JS constants are serialized with N3's N-Triples writer. Bounded result pages are parsed as N-Quads through the Comunica data factory, with blank-node labels preserved consistently across pages.
- Pages select at most the iterator-requested limit and use DuckDB's Parquet `file_row_number` for deterministic pagination. SPARQL result order remains semantically unspecified without `ORDER BY`.
- Cardinality is an exact, separately filtered `COUNT(*)`. Connection operations are serialized to avoid concurrent use of one native connection.
- `close()` is idempotent, refuses subsequent operations, waits for queued work, and closes the connection and instance. Actor invalidation and query-source disposal call this lifecycle boundary.

### Query source, configuration, and engine

- Extended iterator metadata and bindings to include a graph variable when the file has a graph column.
- Made selector shape reflect whether the source is a triple or quad table.
- Retained the HDT-feature package/config/engine organization and generated Components.js default of 128 rows per page.
- Verified the assembled `QueryEngine`, static CLI, dynamic CLI, and HTTP endpoint against a real COTTAS file.

### Tests and fixtures

- Added `cottas-rs`'s independently generated `example.cottas`, with source commit, license, and SHA-256 recorded beside it.
- Added real DuckDB-generated Parquet tests for schema/type rejection, bound constants, literals, language tags, datatypes, escaped values, blank nodes, repeated variables, exact counts, paging, triple/quad graph behavior, invalid term encoding, invalid paths, and cleanup.
- Added assembled-engine tests for SELECT, joins, ASK, CONSTRUCT, and empty results.

### Deferred benchmark milestone

- Kept the BSBM and WatDiv layouts and their explicit missing-asset guard.
- Deferred benchmark-scale `.cottas` generation and performance runs. A writer supplied by the COTTAS tooling ecosystem must define and reproduce compression, distinctness, ordering/index, and metadata policy; inventing a second writer in the query reader would undermine format compatibility and benchmark reproducibility.
- To resume: generate the benchmark RDF input with JBR, convert it with the agreed COTTAS writer, place it at each benchmark package's `generated/dataset.cottas`, validate the JBR configs, run both matrices, and then enable the performance CI job.

### Primary references used

- [pycottas source](https://github.com/arenas-guerrero-julian/pycottas)
- [cottas-rs source](https://github.com/cottas-rdf/cottas-rs)
- [DuckDB Node API](https://www.npmjs.com/package/@duckdb/node-api)
- [DuckDB Parquet overview](https://duckdb.org/docs/stable/data/parquet/overview)

### Verification record

- Environment: Node.js `24.16.0`, Yarn `1.22.22`, macOS arm64.
- `yarn install --frozen-lockfile --ignore-scripts --offline`: passed after lockfile refresh.
- `yarn run verify`: passed TypeScript compilation, Components.js generation, 67 Jest tests, 100% statement/branch/function/line coverage, lint, dependency checks, and both JBR configuration validations.
- `yarn run doc`: generated documentation with no errors (seven inherited unresolved-link warnings from Comunica/AsyncIterator base types).
- Static CLI and dynamic CLI: returned `boolean: true` for an ASK query over the reference fixture.
- HTTP endpoint: returned HTTP 200 and `boolean: true` for the same real-fixture ASK query.
- Browser shim: threw the documented Node-only error.
- BSBM and WatDiv guards: produced the expected `Missing generated/dataset.cottas` failure when assets were absent.
