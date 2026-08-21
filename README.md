<p align="center">
  <a href="https://comunica.dev/">
    <img alt="Comunica" src="https://comunica.dev/img/comunica_red.svg" width="200">
  </a>
</p>

<p align="center"><strong>Comunica for COTTAS</strong></p>

This monorepo is the development home for querying
[COTTAS](https://github.com/arenas-guerrero-julian/pycottas) compressed RDF files with
[Comunica](https://github.com/comunica/comunica).

> **Scaffold status:** the repository structure, configuration, engine entry points,
> adapter contract, unit-test harnesses, and benchmark layouts are initialized. The
> COTTAS reader is intentionally not implemented until the format/runtime spike in
> [COTTAS_IMPLEMENTATION_PLAN.md](COTTAS_IMPLEMENTATION_PLAN.md) resolves the physical schema,
> term encoding, and supported DuckDB version.

The layout follows
[`comunica-feature-hdt` at `6e5972b`](https://github.com/comunica/comunica-feature-hdt/tree/6e5972b)
and is aligned with Comunica `5.3.0` conventions:

- `packages/actor-query-source-identify-cottas`: source actor, query source, iterator, and reader-adapter seam;
- `engines/config-query-sparql-cottas`: Components.js configuration for the actor;
- `engines/query-sparql-cottas`: Node-only standalone engine and CLI entry points;
- `performance/benchmark-bsbm-cottas`: staged BSBM benchmark layout;
- `performance/benchmark-watdiv-cottas`: staged WatDiv benchmark layout.

## Development setup

Use Node.js 22 or newer and Yarn 1.22.22.

```bash
git clone https://github.com/ecrum19/comunica-feature-cottas.git
cd comunica-feature-cottas
yarn install
yarn run build
yarn test
yarn lint
```

The copied integration specs and benchmark layouts are deliberately not enabled in CI
until deterministic `.cottas` fixtures and a reproducible COTTAS writer are available.

## Implementation

Start with Phase 0 in [COTTAS_IMPLEMENTATION_PLAN.md](COTTAS_IMPLEMENTATION_PLAN.md). Keep
format-specific SQL, schema validation, RDF-term conversion, and native resource ownership
behind `CottasDocument`; the Comunica actor and iterator should depend only on that contract.

## License

This project follows Comunica's MIT licensing; see [LICENSE.txt](LICENSE.txt).
