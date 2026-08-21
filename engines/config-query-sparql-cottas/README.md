# Comunica SPARQL COTTAS Config

This package extends `@comunica/config-query-sparql` with
`ActorQuerySourceIdentifyCottas` and its merge-bindings mediator wiring.

```bash
yarn add @comunica/config-query-sparql-cottas
```

Use `config/config-default.json` as the base configuration for a COTTAS-enabled engine.
Generated Components.js files must be produced with `yarn run build:components`; they should
not be edited manually.

The configuration is staged, but end-to-end COTTAS queries remain unavailable until the
`CottasDocument` runtime adapter is implemented.
