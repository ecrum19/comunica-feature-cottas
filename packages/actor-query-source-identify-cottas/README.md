# Comunica COTTAS Query Source Identify Actor

A Comunica query-source-identify actor for sources shaped as:

```json
{ "type": "cottas", "value": "datasets/example.cottas" }
```

The package already contains the HDT-inspired actor, query-source, buffered iterator,
metadata handling, cleanup behavior, and mock-backed unit tests. The reader-specific work
is isolated behind `CottasDocument` and is the first implementation milestone in the root
`COTTAS_IMPLEMENTATION_PLAN.md`.

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

`maxBufferSize` controls the maximum number of rows requested from a COTTAS document per
iterator read and defaults to `128` through the generated Components.js configuration.

This package is not publishable as a functioning reader until Phase 0 selects and validates
the runtime adapter.
