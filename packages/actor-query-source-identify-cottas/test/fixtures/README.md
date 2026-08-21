# COTTAS test fixtures

`example.cottas` is copied byte-for-byte from `tests/data/example.cottas` in [`cottas-rdf/cottas-rs`](https://github.com/cottas-rdf/cottas-rs), commit `3d3d508719d5902d2b133f447856f8bfa2b2604d` (retrieved 2026-08-21). It is licensed under Apache-2.0; the upstream license is included as `LICENSE-APACHE-2.0.txt`. The fixture has SHA-256 `e47b77dac2f7f82df216afeaa0880849e71ad4b67021e0af5474b2735c0b531a`.

It contains these three triples:

```turtle
<http://example.org/Alice> <http://example.org/knows> <http://example.org/Bob> .
<http://example.org/Bob> <http://example.org/knows> <http://example.org/Charlie> .
<http://example.org/Charlie> <http://example.org/knows> <http://example.org/Alice> .
```

Tests generate additional small Parquet files in the operating system's temporary directory to cover literals, blank nodes, quad columns, and invalid schemas without committing redundant binary fixtures.
