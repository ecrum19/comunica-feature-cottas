# Benchmark BSBM COTTAS (10,000 products)

This package follows the upstream Comunica BSBM benchmark with automatic RDF-to-COTTAS conversion.

```bash
yarn workspace benchmark-bsbm-cottas-10k performance:ci
```

No COTTAS file needs to be provided. `performance:prepare` obtains the BSBM RDF input and queries, then converts `generated/dataset.nt` to `generated/dataset.cottas` with pinned pycottas tooling. `performance:run` measures the current engine and rejects query failures. The optional `performance` command compares against the published Docker image.

See [the benchmark guide](../README.md) for writer settings, file provenance, PR/base comparisons, and verification status.
