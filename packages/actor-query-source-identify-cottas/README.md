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

### Join push-down

The actor accepts a join of triple patterns as well as a single pattern, so a basic graph pattern
reaches the source whole and is answered by **one** DuckDB query rather than a lookup per
intermediate binding. Each pattern becomes an alias over the index best suited to its own bound
components; a variable's first occurrence fixes the column it projects from and every later
occurrence becomes an equality against it, which is exactly SPARQL's join condition because join
equality is term equality and terms are stored as canonical N-Triples strings.

Results stream: the join holds one DuckDB streaming result on its own connection and fetches chunks
as the consumer reads. Paging a join with `LIMIT`/`OFFSET` would re-execute it once per page.

Only joins are pushed down. `FILTER`, `ORDER BY` and aggregates are left to Comunica, because
SPARQL compares those by value with three-valued logic where SQL would compare strings.

### Index orders

A source may ship the same data in more than one row order. Beside `data.cottas` the actor looks
for `data.posg.cottas` and `data.ospg.cottas`; each must be a complete COTTAS file with the same
columns, differing only in row order.

A pattern is answered from the order whose leading components are bound — `spog` for a bound
subject, `posg` for a bound predicate, `ospg` for a bound object — so DuckDB can prune row groups
on Parquet statistics instead of scanning. This is the selection rule used by nested-index triple
stores such as [rdf-stores.js](https://github.com/rubensworks/rdf-stores.js). Siblings are
optional: with only the primary file the actor behaves exactly as before.

### Known performance characteristics

Each iterator issues one exact `COUNT(*)` when it starts. Those results are cached per document
behind a bounded LRU, which is safe because a COTTAS file is read-only for the lifetime of the
source. With join push-down a query issues a handful of these rather than one per intermediate
binding, so the cache matters much less than it used to.

Two further optimisations are deliberately not implemented:

* All operations are serialised on a single DuckDB connection, so concurrent triple patterns in a
  join cannot overlap. DuckDB supports several connections per instance.
* Paging uses `LIMIT`/`OFFSET`. Growing page sizes removed the cost of re-scanning for a full
  traversal, but a deep explicit `OFFSET` still has to skip every preceding row; a streaming cursor
  per iterator would avoid that.

The package includes an independently produced `cottas-rs` fixture plus generated real-Parquet tests for literals, blank nodes, optional graphs, schema failures, cardinality, pagination, and cleanup.
