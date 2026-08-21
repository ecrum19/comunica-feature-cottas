# COTTAS Querying Feature Plan

Status: planning only
Target branch: `feature/cottas`
Base: `comunica/comunica:master`
Date: 2026-08-21

## Goal

Add first-class querying of COTTAS compressed RDF files to Comunica, following the architecture and developer experience of [`comunica-feature-hdt`](https://github.com/comunica/comunica-feature-hdt), but replacing HDT-specific code, source types, package names, configuration, tests, documentation, and benchmarks with COTTAS equivalents.

The intended user experience is:

```bash
comunica-sparql-cottas cottas@datasets/example.cottas \
  "CONSTRUCT WHERE { ?s ?p ?o } LIMIT 100"
```

and, from JavaScript/TypeScript:

```ts
const engine = new QueryEngine();
const result = await engine.queryBindings('SELECT * WHERE { ?s ?p ?o } LIMIT 100', {
  sources: [{ type: 'cottas', value: 'datasets/example.cottas' }],
});
```

The first implementation should target a single local COTTAS file and triple-pattern evaluation. Support for globs, multiple files, updates, or browser execution should only be added if the selected COTTAS runtime supports them cleanly.

## Reference architecture

The reference snapshot inspected was `comunica-feature-hdt` commit `6e5972b` and contains these layers:

| HDT reference | COTTAS implementation |
| --- | --- |
| `packages/actor-query-source-identify-hdt` | `packages/actor-query-source-identify-cottas` |
| `ActorQuerySourceIdentifyHdt` | `ActorQuerySourceIdentifyCottas` |
| `QuerySourceHdt` | `QuerySourceCottas` |
| `HdtIterator` | `CottasIterator` |
| `MockedHdtDocument` | `MockedCottasDocument` |
| `engines/query-sparql-hdt` | `engines/query-sparql-cottas` |
| `engines/config-query-sparql-hdt` | `engines/config-query-sparql-cottas` |
| source type `hdt` | source type `cottas` |
| `comunica-sparql-hdt` | `comunica-sparql-cottas` |
| `performance/benchmark-*-hdt` | `performance/benchmark-*-cottas` |

The implementation should be adapted to this checkout’s current Comunica `5.3.0` package conventions rather than copying the reference repository’s older package metadata verbatim.

## Phase 0 — COTTAS runtime integration spike

The recommended primary runtime is [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api). This is a good fit because COTTAS is built on Parquet and DuckDB can query Parquet directly, apply projection/filter pushdown, inspect Parquet metadata, and stream result chunks. The package also provides a promise-based Node API and prebuilt platform binaries. DuckDB documents direct Parquet access through [`read_parquet`](https://duckdb.org/docs/current/data/parquet/overview).

This does not eliminate the adapter spike. The public COTTAS materials currently describe `pycottas` and `cottas-rs` rather than a stable JavaScript COTTAS reader, so the implementation must verify the actual COTTAS schema and term encoding before writing SQL. See the [COTTAS paper](https://link.springer.com/chapter/10.1007/978-3-032-09530-5_18), [pycottas](https://github.com/arenas-guerrero-julian/pycottas), and [cottas-rs](https://docs.rs/cottas-rs/latest/cottas_rs/).

This direct approach assumes a `.cottas` artifact is a Parquet-compatible file, possibly with COTTAS-specific column encoding. If COTTAS uses a custom container around Parquet or requires decompression before DuckDB can read it, keep that format-specific step inside `CottasDocument` and use DuckDB for the resulting Parquet scan.

Use `@duckdb/node-api` as a direct dependency of the COTTAS actor package, not as an incidental transitive dependency. Select a DuckDB/API version compatible with the Node versions and operating systems supported by this Comunica branch.

The spike must answer:

1. Which COTTAS columns and types are present for subject, predicate, object, and optional graph values?
2. Are RDF terms stored as strings, encoded IDs, structs, or another representation, and how are IRIs, blank nodes, language-tagged literals, and datatyped literals reconstructed?
3. Can DuckDB open a local `.cottas` file with `read_parquet` without loading the complete dataset into memory?
4. Can the adapter express bound and unbound triple-pattern terms as parameterized DuckDB predicates?
5. Can the adapter stream rows through `DuckDBConnection.stream*`/chunk APIs and map them into RDFJS bindings in bounded batches?
6. Can exact counts be obtained affordably, or should the adapter expose estimates based on Parquet metadata and return exact counts only for selective patterns?
7. Does the COTTAS file contain named-graph information, or is the initial source triple-only?
8. How should one `DuckDBInstance`/connection be owned per `CottasDocument`, cached, and closed?
9. Are the native DuckDB binaries available for every supported CI and release platform, and what is the correct browser-build behavior?

The first adapter experiment should validate a query shape like this, adjusted to the actual COTTAS schema:

```sql
SELECT subject, predicate, object
FROM read_parquet($1)
WHERE ($2 IS NULL OR subject = $2)
  AND ($3 IS NULL OR predicate = $3)
  AND ($4 IS NULL OR object = $4)
LIMIT $5 OFFSET $6
```

The path and term values must be bound through the DuckDB API where supported. If DuckDB does not support a parameter in the `read_parquet` path argument, validate and register the local path through a narrowly scoped adapter rather than concatenating untrusted input into SQL. Use `DESCRIBE`, `parquet_schema`, and `parquet_metadata` during the spike to verify schema, statistics, and pushdown behavior.

Do not put a Python subprocess in the hot path. Keep the COTTAS-specific logic behind a small DuckDB-backed adapter so the Comunica actor does not depend on low-level SQL or Parquet details.

The adapter should expose a Comunica-oriented contract similar to:

```ts
interface CottasDocument {
  countPattern(
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph?: RDF.Term,
  ): Promise<{ totalCount: number; hasExactCount: boolean }>;

  searchBindings(
    bindingsFactory: RDF.BindingsFactory,
    subject: RDF.Term,
    predicate: RDF.Term,
    object: RDF.Term,
    graph?: RDF.Term,
    options: { offset: number; limit: number },
  ): Promise<{ bindings: RDF.Bindings[]; totalCount: number; hasExactCount: boolean }>;

  close(): Promise<void>;
}
```

The adapter should use DuckDB SQL and Parquet scans for the first implementation, but it must preserve this observable behavior. If a future native COTTAS API replaces DuckDB, only this adapter should need to change.

## Phase 1 — COTTAS query-source actor package

Create `packages/actor-query-source-identify-cottas` by following the structure of [`actor-query-source-identify-hdt`](https://github.com/comunica/comunica-feature-hdt/tree/master/packages/actor-query-source-identify-hdt).

### Package metadata

Add `package.json` with:

- name `@comunica/actor-query-source-identify-cottas`;
- version aligned with this checkout, initially `5.3.0`;
- repository directory and package description updated to COTTAS;
- keywords including `comunica`, `actor`, `query-source-identify`, and `cottas`;
- the same Comunica `5.3.0` dependencies as the HDT actor where still needed;
- a direct `@duckdb/node-api` dependency and any platform-specific packaging constraints;
- the standard `build`, `build:ts`, and `build:components` scripts.

### Actor implementation

Add `lib/ActorQuerySourceIdentifyCottas.ts`:

- extend `ActorQuerySourceIdentify`;
- accept only `querySourceUnidentified.type === 'cottas'`;
- require a string file path for the initial implementation;
- obtain the Comunica data factory from `KeysInitQuery.dataFactory`;
- create the merge-bindings factory through the existing mediator;
- open the COTTAS document through the DuckDB-backed adapter;
- return a `QuerySourceCottas` with the source context preserved;
- retain the reference actor’s HTTP invalidation listener and `WeakRef`-based source cleanup if the COTTAS runtime owns reusable file/database resources;
- expose `maxBufferSize` with the same default and semantics as the HDT actor unless the COTTAS runtime requires a separate row-group setting;
- return clear actor test failures for wrong source types and invalid values.

### Query source and iterator

Add:

- `lib/QuerySourceCottas.ts`;
- `lib/CottasIterator.ts`;
- `lib/CottasDocument.ts`, implementing the DuckDB instance/connection lifecycle and COTTAS-to-RDFJS mapping;
- `lib/index.ts` exports for the actor, query source, iterator, and public adapter types.

`QuerySourceCottas` should:

- implement `IQuerySource`;
- use `referenceValue` equal to the COTTAS path or source reference;
- expose a selector shape for a fully variable triple pattern;
- return the same filter factor convention as the HDT source initially;
- accept only known pattern operations in `queryBindings`;
- delegate bounded pattern scans to `CottasIterator`;
- return an empty stream for named graphs if the first COTTAS scope is triple-only; if the selected reader supports quads, pass graph constraints through and test them explicitly;
- preserve Comunica metadata using `MetadataValidationState`, cardinality, and variable information;
- explicitly throw for `queryQuads`, `queryBoolean`, and `queryVoid` until those operations are implemented;
- close the DuckDB connection/instance and all COTTAS resources from `dispose()`;
- use `QuerySourceCottas(...)` in `toString()` and all error messages.

`CottasIterator` should mirror `HdtIterator`:

- extend `BufferedIterator<RDF.Bindings>`;
- keep an offset/position and request at most the requested batch size;
- avoid materializing the whole COTTAS file;
- push results in source order or document the ordering guarantee if COTTAS does not guarantee one;
- expose exact or estimated cardinality as provided by DuckDB/COTTAS metadata;
- list each variable once, including correct handling of repeated variables;
- stop cleanly after the source is closed or exhausted;
- propagate reader, SQL, Parquet, native, and conversion errors through the stream.

Do not interpolate RDF terms directly into SQL. Use the selected reader’s parameter binding or a carefully isolated term-serialization layer.

`CottasDocument` should own one DuckDB instance/connection for the opened source, validate the COTTAS schema once, and use prepared statements or a validated path-registration fallback. It should query Parquet through `read_parquet`, retain projection/filter pushdown, and convert DuckDB row values into RDFJS terms before producing bindings.

## Phase 2 — Unit tests and fixtures

Create the same test set as the reference actor:

- `test/ActorQuerySourceIdentifyCottas-test.ts`;
- `test/QuerySourceCottas-test.ts`;
- `test/CottasIterator-test.ts`;
- `test/MockedCottasDocument.ts`;
- a small COTTAS fixture or a separate integration fixture if the real reader can generate one deterministically.

### Actor tests

Cover:

- constructor and inheritance from `ActorQuerySourceIdentify`;
- acceptance of `{ type: 'cottas', value: 'path/to/file.cottas' }`;
- rejection of `hdt`, `sparql`, `rdfjs`, and other source types;
- rejection of non-string source values unless glob/multi-file support is deliberately added;
- construction of `QuerySourceCottas`;
- preservation of an explicitly supplied source context;
- invalidation behavior for a targeted URL/path and for global invalidation;
- cleanup of all created sources and closed COTTAS documents;
- adapter/open failures with useful error messages.

### Query-source and iterator tests

Use a deterministic in-memory mock with the same small triple set as the HDT tests. Test:

- selector shape;
- filter factor;
- `toString()`;
- all eight combinations of bound/unbound subject, predicate, and object;
- zero matches and fully bound matches;
- default graph behavior;
- named graph behavior;
- repeated variables, literals, language tags, datatypes, blank nodes, and RDF-star terms if supported;
- exact counts, estimated counts, and metadata variables;
- batch sizes smaller than the result set to prove no rows are skipped or duplicated;
- offsets across multiple batches;
- empty/closed documents;
- reader errors and stream error propagation;
- idempotent disposal.

At least one integration test must exercise the real DuckDB-backed adapter against a small `.cottas` file. Mock-only tests are insufficient for Parquet schema interpretation, term conversion, SQL predicate generation, pushdown behavior, and resource cleanup.

## Phase 3 — COTTAS configuration package

Create `engines/config-query-sparql-cottas` by copying the HDT config package shape and replacing all HDT identifiers:

- `@comunica/config-query-sparql-cottas` package metadata;
- `config/config-default.json` importing the current `@comunica/config-query-sparql` configuration;
- `config/query-source-identify/actors.json` importing the COTTAS actor configuration;
- `config/query-source-identify/actors/cottas.json` declaring `ActorQuerySourceIdentifyCottas` and wiring the merge-bindings mediator;
- COTTAS-specific Components.js context URL and module prefix;
- `README.md` explaining installation and use as a base configuration;
- empty `lib/index.ts` if that remains the current config-package convention;
- generated Components.js output through `yarn run build:components`, never by hand.

Verify that the actor is actually reachable from the assembled configuration and that the generated context points to the local package version.

## Phase 4 — Standalone COTTAS engine

Create `engines/query-sparql-cottas` from `engines/query-sparql-hdt` and the current `engines/query-sparql` package, preserving the current Comunica `5.3.0` dependency set.

Required files:

- `package.json`;
- `README.md`;
- `bin/query.ts`;
- `bin/query-dynamic.ts`;
- `bin/http.ts`;
- `lib/QueryEngine.ts`;
- `lib/QueryEngineFactory.ts`;
- `lib/index.ts`;
- `lib/index-browser.ts` or an explicit unsupported-browser shim;
- `config/config-default.json`;
- `spec/sparql-engine.js`;
- `spec/sparql-engine-base.js`;
- Docker and build configuration matching the current engine conventions.

The package should provide these binaries:

- `comunica-sparql-cottas`;
- `comunica-sparql-cottas-http`;
- `comunica-dynamic-sparql-cottas`.

Use the source syntax `cottas@<path>` in documentation and specs. The engine README must include CLI, JavaScript/TypeScript, and HTTP endpoint examples, and must state whether the COTTAS runtime is Node-only.

The default engine config should import `@comunica/config-query-sparql-cottas` and include the COTTAS source-identify actor. Because `@duckdb/node-api` uses native platform binaries, the initial engine should be explicitly Node-only; its browser entry point should fail with a clear unsupported-runtime message rather than silently shipping a broken bundle.

## Phase 5 — Integration/spec testing

Adapt the reference `spec/sparql-engine-base.js` so source entries named `cottasFile` become `{ type: 'cottas', value: ... }`.

Add engine-level smoke coverage for:

- a simple `SELECT` over a COTTAS file;
- a `CONSTRUCT` with a limit;
- fully bound and partially bound triple patterns;
- boolean results if the engine can execute them through bindings;
- serialization through the normal result serializers;
- command-line execution;
- dynamic configuration execution;
- HTTP endpoint execution;
- failure for a missing, malformed, or unsupported COTTAS file;
- named-graph behavior according to the selected COTTAS scope.

Run the generated config through `prepare`, then run TypeScript build and targeted Jest tests before running the broader repository test suite.

## Phase 6 — Performance benchmarks

Mirror the reference benchmark packages:

- `performance/benchmark-bsbm-cottas`;
- `performance/benchmark-watdiv-cottas`.

Copy the JBR experiment structure, Docker client setup, combination files, and README conventions, replacing:

- package names and titles;
- the Comunica Docker image;
- source type and file extension;
- HDT-specific dataset-generation flags;
- configuration context URLs;
- dataset paths and descriptions.

Do not retain `generateHdt: true`. First identify or implement the equivalent COTTAS dataset-generation hook. `@duckdb/node-api` can inspect and query Parquet, but it should not be treated as a COTTAS writer until the COTTAS schema and metadata-generation contract is verified. If JBR has no COTTAS generator, use a reproducible asset-generation step or a documented remote asset rather than committing large binary datasets. The benchmark package must fail clearly when its COTTAS asset is unavailable.

The benchmark phase is complete when a CI-sized run can compare current COTTAS query performance and the benchmark can be validated without requiring a developer’s private local files.

## Phase 7 — Documentation and changelog

Update the repository documentation in the same spirit as the feature repository:

- add COTTAS engine guidance to the root `README.md` engine list;
- add a package README for the actor with install, configuration, source type, and `maxBufferSize` documentation;
- add a config-package README;
- add an engine README with CLI, application, and HTTP examples;
- document the supported COTTAS file scope, graph semantics, platform requirements, and limitations;
- link to the COTTAS format/project documentation;
- add a `CHANGELOG.md` entry under the appropriate unreleased/current section using the repository’s existing Added/Changed/Fixed style;
- document the selected runtime dependency and its license/installation constraints.

The changelog entry should explicitly say that Comunica can query COTTAS files through a new source-identify actor and standalone COTTAS engine. It should not claim updates, quads, globbing, or browser support unless those features are tested and shipped.

## Phase 8 — Dependency, generated-file, and repository checks

After adding the packages:

1. Run `yarn install` so `yarn.lock` contains `@duckdb/node-api`, its platform bindings, the COTTAS workspace links, and no unused replacement runtime.
2. Run `yarn run build:ts`.
3. Run `yarn run build:components`.
4. Run the actor’s targeted Jest suite.
5. Run the COTTAS engine build and `prepare` script.
6. Run the COTTAS engine smoke/spec tests.
7. Run `yarn lint`.
8. Run `yarn test:changed` or the repository’s equivalent targeted test command.
9. Run dependency checking for the new config package.
10. Inspect `git diff --check` and confirm generated files are either intentionally ignored or included according to repository convention.

Use `rg` to verify that the new COTTAS package and configuration contain no accidental HDT names, source types, URLs, package names, or error messages.

## Proposed implementation commits

Keep the PR reviewable with commits in this order:

1. **Reader adapter and actor skeleton** — settle the COTTAS runtime contract and add the actor/query-source/iterator implementation.
2. **Actor unit and integration tests** — add mocks, fixtures, metadata tests, error tests, and resource-lifecycle tests.
3. **COTTAS config package** — add Components.js context and actor wiring.
4. **Standalone COTTAS engine** — add engine packages, binaries, docs, config, and smoke/spec wiring.
5. **Benchmarks** — add reproducible BSBM/WatDiv COTTAS setup after the asset-generation path is confirmed.
6. **Repository documentation and changelog** — update root README, package READMEs, and `CHANGELOG.md`.
7. **Dependency lock and final verification** — update `yarn.lock`, run checks, and fix review findings.

## Acceptance criteria

The feature is ready for a PR to `comunica/comunica:master` when:

- a COTTAS file can be queried through the standalone engine and JavaScript API;
- `cottas` source identification is isolated from HDT and does not change existing source behavior;
- the actor returns correct bindings for all triple-pattern shapes and correct metadata;
- batching, backpressure, offsets, empty results, errors, and disposal are tested;
- the real DuckDB-backed adapter is exercised against a COTTAS fixture;
- DuckDB schema validation, Parquet pushdown, RDF-term conversion, and resource cleanup are tested;
- generated Components.js configuration builds successfully;
- CLI, dynamic CLI, and HTTP usage are documented and smoke-tested;
- benchmarks, or a clearly documented deferred benchmark milestone, are reproducible;
- package manifests, lockfile, README files, and changelog are complete;
- TypeScript build, lint, targeted tests, and changed-package tests pass;
- the PR contains no accidental HDT-only code or unsupported COTTAS claims.

## Open decisions to resolve before coding

- The compatible `@duckdb/node-api`/DuckDB version and supported Node versions.
- Whether the installed DuckDB binary supports all CI and release platforms required by Comunica.
- Whether `read_parquet` accepts a bound path parameter in the Node API, or requires a validated path-registration fallback.
- The exact COTTAS Parquet schema and RDF-term encoding.
- Whether the first release supports triple-only files or full quads.
- Whether `value` accepts only one path or also globs/partitioned COTTAS.
- Whether `getFilterFactor()` and cardinality can be improved using Parquet metadata.
- Whether browser builds are supported.
- How COTTAS fixtures are generated and distributed in CI.
- Whether the performance benchmark packages belong in the first PR or a follow-up once COTTAS asset generation is automated.
