# Benchmark BSBM COTTAS (1,000 products)

This package follows the upstream Comunica BSBM benchmark with automatic RDF-to-COTTAS conversion.

```bash
yarn workspace benchmark-bsbm-cottas performance:ci
```

No COTTAS file needs to be provided. `performance:prepare` obtains the BSBM RDF input and queries, then converts `generated/dataset.nt` to `generated/dataset.cottas` with pinned pycottas tooling. `performance:run` measures the current engine and rejects query failures. The optional `performance` command compares against the published Docker image.

See [the benchmark guide](../README.md) for VM requirements, writer settings, file provenance, PR/base comparisons, and verification status.
