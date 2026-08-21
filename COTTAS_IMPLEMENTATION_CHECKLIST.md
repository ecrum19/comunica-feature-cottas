# COTTAS Querying Implementation Checklist

This checklist turns `COTTAS_IMPLEMENTATION_PLAN.md` into verifiable work items. A checked item is implemented and verified; an unchecked item is intentionally deferred with its reason recorded below and in `COTTAS_IMPLEMENTATION_CHANGELOG.md`.

## Phase 0 — Runtime and format decisions

- [x] Verify the COTTAS physical schema against the reference implementations: Parquet columns `s`, `p`, `o`, with optional `g`.
- [x] Verify RDF term encoding: N-Triples strings; a quad table stores the default graph as SQL `NULL`.
- [x] Select the supported runtime: `@duckdb/node-api` with its prebuilt Node.js binaries.
- [x] Scope source paths to one local file; reject URLs, globs, and directories with actionable errors.
- [x] Use prepared-statement parameters for the file path and all RDF constants.
- [x] Define cardinality as an exact `COUNT(*)` over the same pushed-down filters.
- [x] Define ordering as unspecified SPARQL solution order while making paged reads deterministic by Parquet row number.
- [x] Define browser behavior explicitly: the COTTAS actor is Node-only and is excluded from the browser bundle.

## Phase 1 — Query-source actor

- [x] Implement a DuckDB-backed `CottasDocument` lifecycle (open, validate, query, close).
- [x] Validate column names and SQL types before accepting a source.
- [x] Translate constants and repeated variables into pushed-down SQL predicates.
- [x] Decode COTTAS strings into RDF/JS terms and construct bindings without duplicate variables.
- [x] Support triple COTTAS files and the optional COTTAS graph column.
- [x] Keep each read bounded by the iterator buffer size.
- [x] Serialize connection operations and make close idempotent.
- [x] Preserve actor source identification, invalidation, and disposal behavior.

## Phase 2 — Unit tests and fixtures

- [x] Add a small real COTTAS fixture with provenance.
- [x] Test schema validation and invalid source errors against DuckDB.
- [x] Test constant pushdown, variable binding, repeated-variable equality, RDF term kinds, pagination, and cardinality.
- [x] Test default-graph and named-graph behavior for triple and quad COTTAS files.
- [x] Test resource cleanup and post-close behavior.
- [x] Retain focused mock tests for iterator and actor control flow.

## Phase 3 — Configuration package

- [x] Verify the generated Components.js actor configuration.
- [x] Verify the default config wires the COTTAS source-identify actor and buffer-size default.
- [x] Verify dependency/configuration checks.

## Phase 4 — Standalone engine

- [x] Verify the programmatic `QueryEngine` with a real COTTAS source.
- [x] Verify static and dynamic command-line entry points.
- [x] Verify the HTTP endpoint.
- [x] Verify Node-only browser shimming/exclusion.

## Phase 5 — Integration and spec testing

- [x] Exercise `SELECT`, `ASK`, and `CONSTRUCT` queries through the assembled engine.
- [x] Exercise joins and repeated variables through the assembled engine.
- [x] Exercise literals, language tags, datatypes, blank nodes, empty results, and named graphs across adapter and engine integration tests.
- [x] Include the real local integration suite in the normal CI test job; the separate hosted RDF manifest suite remains unavailable.

## Phase 6 — Performance benchmarks

- [x] Keep BSBM and WatDiv runner definitions structurally aligned with the HDT feature repository.
- [x] Fail clearly when a generated `.cottas` benchmark asset is absent.
- [ ] Add and validate a reproducible large-dataset COTTAS asset generator.
- [ ] Run the benchmark matrix and enable the performance CI job.

The last two benchmark tasks are deferred because the query feature only consumes COTTAS files; a benchmark-scale writer and its compression/index policy should be supplied by the COTTAS tooling project, not improvised in the hot-path reader. The existing runners remain opt-in and fail with exact asset-placement instructions.

## Phase 7 — Documentation and changelog

- [x] Document installation, supported inputs, API, CLI, HTTP usage, limitations, and troubleshooting.
- [x] Record the implementation architecture and decisions in `COTTAS_IMPLEMENTATION_CHANGELOG.md`.
- [x] Update the package changelog.

## Phase 8 — Repository verification

- [x] Install dependencies and refresh `yarn.lock`.
- [x] Run TypeScript build and Components.js generation.
- [x] Run lint, unit/integration tests, and coverage.
- [x] Run dependency/configuration checks.
- [x] Run engine API, CLI, dynamic CLI, and HTTP smoke checks.
- [x] Confirm generated files and Git status, then stage the implementation.
