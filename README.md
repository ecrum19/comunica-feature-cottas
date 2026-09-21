<p align="center">
  <a href="https://comunica.dev/">
    <img alt="Comunica" src="https://comunica.dev/img/comunica_red.svg" width="200">
  </a>
</p>

<p align="center"><strong>Comunica for COTTAS</strong></p>

This monorepo adds Node.js querying of local [COTTAS](https://github.com/arenas-guerrero-julian/pycottas) files to [Comunica](https://github.com/comunica/comunica). Its structure follows [`comunica-feature-hdt` at `6e5972b`](https://github.com/comunica/comunica-feature-hdt/tree/6e5972b) and its packages align with Comunica `5.3.0`.

## Supported COTTAS files

A source must be one local Apache Parquet file with `VARCHAR` columns named `s`, `p`, and `o`, plus an optional `g` column. Values are N-Triples terms. In a quad table, SQL `NULL` in `g` represents the default graph. This matches the `pycottas` and `cottas-rs` reference implementations.

The reader uses DuckDB's Node API. Constants, graph restrictions, and repeated-variable equality are pushed into parameterized SQL; result pages are bounded and ordered by Parquet row number. Cardinality metadata is exact.

URLs, directories, globs, browser execution, updates, and multiple files in one COTTAS source are not supported. SPARQL solution ordering remains unspecified unless the query contains `ORDER BY`.

## Installation and command line

Use Node.js 22.22.2 or newer. Earlier 22.x releases fail `yarn install` because a development
dependency requires `^22.22.2 || ^24.15.0 || >=26`.

```bash
yarn add @elias.crum/query-sparql-cottas
comunica-sparql-cottas cottas@/absolute/path/data.cottas \
  'SELECT * WHERE { ?s ?p ?o } LIMIT 100'
```

The dynamic CLI and HTTP endpoint are also available:

```bash
comunica-dynamic-sparql-cottas cottas@/absolute/path/data.cottas \
  'ASK { ?s ?p ?o }'
comunica-sparql-cottas-http cottas@/absolute/path/data.cottas --port 3000
```

## JavaScript / TypeScript

```javascript
const { QueryEngine } = require('@elias.crum/query-sparql-cottas');

const engine = new QueryEngine();
const bindings = await engine.queryBindings(
  'SELECT * WHERE { ?s ?p ?o } LIMIT 100',
  { sources: [{ type: 'cottas', value: '/absolute/path/data.cottas' }] },
);

for await (const binding of bindings) {
  console.log(binding.toString());
}
```

## Repository layout

- `packages/actor-query-source-identify-cottas`: DuckDB adapter, source actor, buffered iterator, fixtures, and tests.
- `engines/config-query-sparql-cottas`: Components.js configuration.
- `engines/query-sparql-cottas`: programmatic engine, static/dynamic CLIs, and HTTP endpoint.
- `performance/benchmark-*`: BSBM 1k/10k and WatDiv 10/100 benchmarks with automatic COTTAS generation and PR/base comparisons; see [the benchmark guide](performance/README.md).

## Development

```bash
yarn install
yarn run build
yarn run test-ci
yarn run lint
yarn run depcheck
# Or run all checks above, benchmark-config/result-check tests, and docs:
yarn run verify
```

## License

This project follows Comunica's MIT licensing; see [LICENSE.txt](LICENSE.txt). The provenance and Apache-2.0 license of the `cottas-rs` test fixture are recorded beside that fixture.
