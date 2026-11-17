# Comunica Inner Multi Bind Sources RDF Join Actor

An [RDF Join](https://github.com/comunica/comunica/tree/master/packages/bus-rdf-join) actor that inner-joins two or more
streams by taking the one with the lowest cardinality, cutting it into blocks, and pushing every block into the
sources of another entry, **also when that entry is spread over several sources**.

It generalises [`bind-source`](https://github.com/comunica/comunica/tree/master/packages/actor-rdf-join-inner-multi-bind-source),
which only applies when all remaining entries share a single source. In a federation, every triple pattern that
matches more than one source becomes a union of per-source patterns, and the only bind join left would send one
request per binding. This actor sends each block to every branch of such a union and unions the results: the bound
join of FedX.

* **One source for all remaining entries:** they are bound into together, exactly like `bind-source`.
* **Remaining entries over different sources:** the entry sharing most variables with the first one is bound into,
  and the result is handed back to the join bus with the other entries, building a left-deep plan.
* **A union branch whose source can not take a block:** that branch is bound one binding at a time; the others still
  get blocks, so sources of any kind can be mixed.
* **Bindings holding a blank node:** always bound one at a time. A source answering a block returns the pushed
  bindings merged with its own results, and Comunica re-skolemizes every blank node in that output as if it came
  from that source, which would rename blank nodes of other sources.

A source takes part when its selector shape accepts `joinBindings` for the operation.

This module is part of the [Comunica framework](https://github.com/comunica/comunica),
and should only be used by [developers that want to build their own query engine](https://comunica.dev/docs/modify/).

## Install

```bash
$ yarn add @comunica/actor-rdf-join-inner-multi-bind-sources
```

## Configure

It replaces `bind-source` in the COTTAS engine; see `engines/config-query-sparql-cottas/config/rdf-join/`.

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-rdf-join-inner-multi-bind-sources/^5.0.0/components/context.jsonld"
  ],
  "actors": [
    {
      "@id": "urn:comunica:default:rdf-join/actors#inner-multi-bind-sources",
      "@type": "ActorRdfJoinMultiBindSources",
      "mediatorJoinSelectivity": { "@id": "urn:comunica:default:rdf-join-selectivity/mediators#main" },
      "mediatorJoinEntriesSort": { "@id": "urn:comunica:default:rdf-join-entries-sort/mediators#main" },
      "mediatorJoin": { "@id": "urn:comunica:default:rdf-join/mediators#main" },
      "mediatorMergeBindingsContext": { "@id": "urn:comunica:default:merge-bindings-context/mediators#main" }
    }
  ]
}
```

### Config Parameters

* `mediatorJoinSelectivity`: A mediator over the [RDF Join Selectivity bus](https://github.com/comunica/comunica/tree/master/packages/bus-rdf-join-selectivity).
* `mediatorJoinEntriesSort`: A mediator over the [RDF Join Entries Sort bus](https://github.com/comunica/comunica/tree/master/packages/bus-rdf-join-entries-sort).
* `mediatorJoin`: A mediator over the [RDF Join bus](https://github.com/comunica/comunica/tree/master/packages/bus-rdf-join), for the entries left after binding.
* `mediatorMergeBindingsContext`: A mediator over the [Merge Bindings Context bus](https://github.com/comunica/comunica/tree/master/packages/bus-merge-bindings-context).
* `blockSize`: The maximum number of bindings sent to a source per request, defaults to `256`.
* `selectivityModifier`: Multiplier for selectivity values, defaults to `0.0001`.

### Cost model

Each block costs one request per branch that accepts bindings, and each binding one request per branch that does
not, charged at the request time those entries report. It reports one block of the first entry as persisted, and
the first entry, the joined result, and the entries left for later as iterations.
