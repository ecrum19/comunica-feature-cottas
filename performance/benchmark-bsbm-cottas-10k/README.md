# Benchmark BSBM COTTAS 10k

This internal package benchmarks Comunica COTTAS using the [BSBM](http://wbsg.informatik.uni-mannheim.de/bizer/berlinsparqlbenchmark/) benchmark,
at 10 000 products instead of the 1 000 used by [`benchmark-bsbm-cottas`](../benchmark-bsbm-cottas),
which is 3 564 773 triples instead of 374 911.

Compare your current version of Comunica locally with the latest published release by running `npm run performance` from within this package.
This will output a file called `plot_queries_data.svg` that visualizes the performance differences.

If you only want to check the performance of your current version of Comunica,
you can run `npm run performance:ci` instead,
which is what the CI will run as well for continuous performance measurements.

No COTTAS file has to be supplied. `performance:prepare` obtains the RDF input and queries and converts them with the pinned
`pycottas` writer, which emits one file per index order; see [the benchmark guide](../README.md) for the writer settings and
file provenance.

Continuous performance results are tracked on https://github.com/comunica/comunica-performance-results.
