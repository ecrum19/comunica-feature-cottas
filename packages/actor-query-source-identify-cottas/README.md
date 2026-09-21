# Comunica COTTAS Query Source Identify Actor

A Node-only Comunica query-source actor for a local COTTAS file:

```json
{ "type": "cottas", "value": "/absolute/path/example.cottas" }
```

The file must be Parquet with `VARCHAR` columns `s`, `p`, `o`, and optional `g`. Values are N-Triples terms; a `NULL` graph is the default graph. The actor rejects unknown columns, incompatible types, URLs, directories, and globs before query evaluation.

DuckDB applies bound constants, graph constraints, and repeated-variable equality before returning a page. `file_row_number` makes offset paging deterministic, pages grow from `maxBufferSize` up to `pageSize`, and a separate filtered `COUNT(*)` provides exact metadata. One in-memory DuckDB instance and connection are owned per source, operations on that connection are serialized, and disposal/invalidation closes both resources idempotently.

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
      }
    }
  ]
}
```

### Config Parameters

* `httpInvalidator`: An optional actor that listens to HTTP invalidation events.
* `mediatorMergeBindingsContext`: A mediator over the [Merge Bindings Context bus](https://github.com/comunica/comunica/tree/master/packages/bus-merge-bindings-context).
* `maxBufferSize`: The number of bindings this actor's iterators buffer ahead of their consumer, defaults to `128`.
* `pageSize`: The number of bindings to request from a COTTAS file in a single call, defaults to `8192`. Every call is a separate scan of the file that seeks to its offset, and that seek is linear in the offset, so small pages make a full traversal quadratic. Pages grow from `maxBufferSize` up to this value.

### Known performance characteristics

Each iterator issues one exact `COUNT(*)` when it starts, and bind joins create one iterator per
binding, so the same pattern is counted repeatedly. Those results are cached per document behind a
bounded LRU, which is safe because a COTTAS file is read-only for the lifetime of the source.

Two further optimisations are deliberately not implemented:

* All operations are serialised on a single DuckDB connection, so concurrent triple patterns in a
  join cannot overlap. DuckDB supports several connections per instance.
* Paging uses `LIMIT`/`OFFSET`. Growing page sizes removed the cost of re-scanning for a full
  traversal, but a deep explicit `OFFSET` still has to skip every preceding row; a streaming cursor
  per iterator would avoid that.

The package includes an independently produced `cottas-rs` fixture plus generated real-Parquet tests for literals, blank nodes, optional graphs, schema failures, cardinality, pagination, and cleanup.
