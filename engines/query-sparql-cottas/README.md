# Comunica SPARQL COTTAS

A Node-only Comunica engine for querying local COTTAS files through DuckDB.

## Command line

```bash
comunica-sparql-cottas cottas@datasets/example.cottas \
  "CONSTRUCT WHERE { ?s ?p ?o } LIMIT 100"
```

The package also exposes `comunica-dynamic-sparql-cottas` and
`comunica-sparql-cottas-http`.

## JavaScript / TypeScript

```javascript
const { QueryEngine } = require('@elias.crum/query-sparql-cottas');

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

Browser builds are unsupported because the DuckDB-backed reader uses native Node.js
bindings.

The source must be one local path and have COTTAS `s`, `p`, `o`, and optional `g` columns. See the repository README for the complete format contract and limitations.
