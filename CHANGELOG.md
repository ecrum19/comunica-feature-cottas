# Changelog
All notable changes to this project will be documented in this file.

<a name="v5.0.0"></a>
## v5.0.0 - 2026-09-21

Initial release, adding COTTAS support to Comunica.

### Added
* Query engine `@comunica/query-sparql-cottas` for local COTTAS files, with static and dynamic command-line entry points and a SPARQL HTTP endpoint
* Query source actor `@comunica/actor-query-source-identify-cottas`, reading COTTAS through DuckDB and pushing constants, graph restrictions, and repeated-variable equality into the Parquet scan
* Configuration package `@comunica/config-query-sparql-cottas`
* Exact cardinality from a separately filtered `COUNT(*)`, cached per document behind a bounded LRU
* `pageSize` parameter, defaulting to `8192`: pages grow from the buffer size so that a full traversal is not quadratic in the number of pages
* BSBM and WatDiv benchmarks at two scales each, preparing their own RDF input and converting it with the pinned `pycottas` reference writer, with file provenance recorded beside each generated COTTAS file

### Changed
* Comunica dependencies are aligned with version `5.3.0`
* The feature is Node-only; the browser entry point throws an explicit unsupported-platform error rather than bundling native DuckDB code

### Fixed
* Constant pushdown now matches every legal N-Triples encoding of a term rather than one spelling, so a file that stores `"x"^^xsd:string`, an upper-case language tag, or an escaped astral character no longer returns zero solutions without an error
* `KeysQueryOperation.unionDefaultGraph` is honoured, so a default-graph pattern over a quad COTTAS file matches every graph rather than only `NULL`

### Known limitations
* Escapes originating inside the COTTAS file itself, such as `<urn:café>`, are not matched by a constant. That set of spellings is unbounded, so the format contract is canonical N-Triples, which both reference writers produce
* One COTTAS source is one local file. URLs, directories, globs, and multi-file sources are rejected
* Updates are not supported; sources are read-only
