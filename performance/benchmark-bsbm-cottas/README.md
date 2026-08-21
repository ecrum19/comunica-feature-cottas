# Benchmark BSBM COTTAS

This internal package benchmarks Comunica COTTAS using the [BSBM](http://wbsg.informatik.uni-mannheim.de/bizer/berlinsparqlbenchmark/) benchmark.

Compare your current version of Comunica locally with the latest published release by running `npm run performance` from within this package.
This will output a file called `plot_queries_data.svg` that visualizes the performance differences.

If you only want to check the performance of your current version of Comunica,
you can run `npm run performance:ci` instead,
which is what the CI will run as well for continuous performance measurements.

Continuous performance results are tracked on https://github.com/comunica/comunica-performance-results.

## Required COTTAS asset

Benchmark execution is intentionally opt-in until the COTTAS tooling project supplies a reproducible benchmark-scale writer policy. Generate the BSBM RDF input with JBR, convert it with the agreed `pycottas` or `cottas-rs` workflow, and place the result at `generated/dataset.cottas`. The pre-performance check stops immediately with this path when the asset is absent.

Record the writer version, source dataset checksum, selected COTTAS index/order, Parquet compression settings, and output checksum with every benchmark run. Once this workflow is fixed and automated, enable the performance CI job described in `COTTAS_IMPLEMENTATION_CHECKLIST.md`.
