# Comunica SPARQL COTTAS Config

This package extends `@comunica/config-query-sparql` with
`ActorQuerySourceIdentifyCottas` and its merge-bindings mediator wiring.

```bash
yarn add @elias.crum/config-query-sparql-cottas
```

Use `config/config-default.json` as the base configuration for a COTTAS-enabled engine.
Generated Components.js files must be produced with `yarn run build:components`; they should
not be edited manually. The configured actor uses a default page buffer of 128 rows.
