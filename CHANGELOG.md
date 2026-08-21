# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Initialized the COTTAS feature monorepo from the structure of `comunica-feature-hdt` commit `6e5972b`.
- Added COTTAS-specific actor, configuration, standalone engine, test, and benchmark scaffolding.
- Added the `CottasDocument` adapter boundary and the phased implementation plan.
- Implemented the COTTAS reader with `@duckdb/node-api`, parameterized Parquet scans, exact cardinality, bounded deterministic paging, RDF term decoding, and resource cleanup.
- Added triple and optional-graph support, including repeated-variable equality and correct default/named-graph matching.
- Added a `cottas-rs` compatibility fixture, real DuckDB-generated format tests, and assembled-engine integration tests for SELECT, ASK, CONSTRUCT, and joins.
- Added the implementation checklist and high-level implementation changelog.

### Changed

- Aligned package metadata and Comunica dependencies with version `5.3.0`.
- Replaced scaffold-only documentation with supported-format, API, CLI, HTTP, and troubleshooting guidance.

### Known limitations

- Benchmark-scale COTTAS asset generation and benchmark execution remain deferred; the runners fail clearly until `generated/dataset.cottas` is supplied.
