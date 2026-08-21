# Comunica SPARQL COTTAS

A Node-only Comunica engine staged for querying local COTTAS files.

> The CLI, JavaScript API, HTTP entry point, and configuration are present, but actual COTTAS
> reads intentionally fail with a clear adapter error until Phase 0 of the implementation plan
> validates the COTTAS schema and runtime.

## Command line

```bash
comunica-sparql-cottas cottas@datasets/example.cottas \
  "CONSTRUCT WHERE { ?s ?p ?o } LIMIT 100"
```

The package also exposes `comunica-dynamic-sparql-cottas` and
`comunica-sparql-cottas-http`.

## JavaScript / TypeScript

```javascript
const { QueryEngine } = require('@comunica/query-sparql-cottas');

const engine = new QueryEngine();
const bindings = await engine.queryBindings(
  'SELECT * WHERE { ?s ?p ?o } LIMIT 100',
  { sources: [{ type: 'cottas', value: 'datasets/example.cottas' }] },
);
```

## HTTP endpoint

```bash
comunica-sparql-cottas-http cottas@datasets/example.cottas
```

Browser builds are unsupported because the planned DuckDB-backed reader uses native Node.js
bindings.
