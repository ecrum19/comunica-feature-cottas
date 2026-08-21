# Comunica COTTAS Query Source Identify Actor

A Node-only Comunica query-source actor for a local COTTAS file:

```json
{ "type": "cottas", "value": "/absolute/path/example.cottas" }
```

The file must be Parquet with `VARCHAR` columns `s`, `p`, `o`, and optional `g`. Values are N-Triples terms; a `NULL` graph is the default graph. The actor rejects unknown columns, incompatible types, URLs, directories, and globs before query evaluation.

DuckDB applies bound constants, graph constraints, and repeated-variable equality before returning a page. `file_row_number` makes offset paging deterministic, `maxBufferSize` bounds each page (default `128`), and a separate filtered `COUNT(*)` provides exact metadata. One in-memory DuckDB instance and connection are owned per source, operations on that connection are serialized, and disposal/invalidation closes both resources idempotently.

## Configuration

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-query-source-identify-cottas/^5.0.0/components/context.jsonld"
  ],
  "actors": [
    {
      "@id": "urn:comunica:default:query-source-identify/actors#cottas",
      "@type": "ActorQuerySourceIdentifyCottas",
      "mediatorMergeBindingsContext": {
        "@id": "urn:comunica:default:merge-bindings-context/mediators#main"
      },
      "maxBufferSize": 128
    }
  ]
}
```

The package includes an independently produced `cottas-rs` fixture plus generated real-Parquet tests for literals, blank nodes, optional graphs, schema failures, cardinality, pagination, and cleanup.
