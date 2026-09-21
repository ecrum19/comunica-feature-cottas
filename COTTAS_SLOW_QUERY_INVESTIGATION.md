# Why COTTAS queries are slow

WatDiv scale 100 (10,930,937 triples), query C2. All measurements on one 8-core/31 GB VM,
same data and same Comunica version throughout.

## Summary

**The COTTAS format is not the problem, and neither is our SQL.** DuckDB answers these queries
over the very same file in ~0.2 s — faster than HDT. The paper's parity claim is credible.

The gap is architectural. Comunica decomposes a SPARQL query into individual triple-pattern
lookups and performs the joins itself. Each lookup is a separate DuckDB query costing 7–13 ms,
which is simply what it costs to read ~100 rows out of a compressed columnar file. C2 issues
**96,052** of them.

| query | one SQL join in DuckDB | Comunica + COTTAS | HDT |
|---|---:|---:|---:|
| C2 (0 solutions) | **0.229 s** | 98–141 s | 9.3 s |
| C3 (425,591 solutions) | **0.189 s** | 536–557 s | — |

Both SQL runs return exactly the solution counts Comunica does. Allowing ~1.7 s to materialise
425,591 bindings as RDF terms in JS (measured at ~4 µs/row), a join-pushdown implementation of C3
should land near 2 s against the current 536 s.

We are using a query engine as if it were a triple-pattern store.

## 1. Cardinalities are correct

Every distinct pattern the engine probed was checked against DuckDB — 12/12 exact, e.g. `?v0
<schema.org/legalName> ?v1` → 95, `?v7 <wsdbm/purchaseFor> ?v3` → 150,000. Reported as
`{ type: 'exact', value: N }`. No defect here.

## 2. Cost metadata is missing, but it is not the cause

The metadata reaching the join planner has only `state`, `cardinality`, `variables`. Comunica's
cost model reads `pageSize` and `requestTime`, which are undefined, so a bind join's cost evaluates
to zero and it gets a 3× leniency bonus in its admission gate.

Patching those fields in changes nothing:

| metadata | plan | probes | time |
|---|---|---:|---:|
| baseline | 10 × bind | 96,052 | 141.1 s |
| `requestTime: 5` | 10 × bind | 96,052 | 139.8 s |
| `pageSize: 8192` + `requestTime: 50` | 10 × bind | 96,052 | 139.9 s |

Worth fixing for model correctness; irrelevant to performance.

## 3. The plan barely differs from HDT's

Built `comunica-feature-hdt` on the same VM against the `dataset.hdt` from the same WatDiv archive:

| | COTTAS | HDT |
|---|---|---|
| wall clock | **140 s** | **9.3 s** (incl. ~4.7 s one-time index build) |
| join operators | 10 × bind | 8 × bind + 1 × multi-smallest |

HDT flattens the outermost join; COTTAS nests bind joins all the way down. A minor difference —
nowhere near a 15× gap.

## 4. The per-lookup cost is irreducible, and it is not our SQL

200 bound-subject lookups, WatDiv-100:

| | per lookup |
|---|---:|
| raw DuckDB (SQL only, no RDF) | 12.70 ms |
| full adapter (+ N-Triples parse, terms, bindings) | 12.71 ms |
| **JS translation overhead** | **0.02 ms** |

Things ruled out as causes, each measured:

| hypothesis | result |
|---|---|
| our SQL differs from pycottas's | pycottas's exact form: 8.69 ms vs our 9.90 ms |
| missing `SET parquet_metadata_cache=true` (pycottas sets it) | 7.86 → 7.27 ms |
| `file_row_number` + `ORDER BY` we add for paging | 9.90 → 9.12 ms |
| bound `$path` parameter instead of a literal | no measurable difference |
| DuckDB's late-materialization optimisation | disabling it: 7.86 → 7.99 ms |
| row groups too large (122,880 rows) | 32,768 rows: 7.0 ms; 8,192 rows: **16.1 ms**, worse |

`EXPLAIN ANALYZE` confirms pruning works perfectly — the filtered scan finds its 95 rows in 0.00 s.
The remaining milliseconds are decompressing the Parquet pages that hold them. That is the price of
one point lookup against a ZSTD-22 columnar file, and pycottas pays it too.

**The per-lookup cost cannot be optimised away. It can only be amortised by doing fewer lookups.**

## 5. Three index orders: tried, measured

Implemented on branch `multi-index`. The converter now writes `dataset.cottas` (spog),
`dataset.posg.cottas` and `dataset.ospg.cottas` — the same triples in three row orders. The actor
discovers the siblings and answers each pattern from the order whose leading components are bound,
the selection rule nested-index stores such as rdf-stores.js use. Siblings are optional; with only
the primary file behaviour is unchanged.

**Per-lookup cost by pattern shape** (WatDiv-100, 100 lookups each, count + first page):

| pattern | one index | three indexes | |
|---|---:|---:|---:|
| `? ? O` | **158.3 ms** | **17.9 ms** | **8.9×** |
| `? P ?` | 17.9 ms | 10.1 ms | 1.77× |
| `? P O` | 18.3 ms | 14.3 ms | 1.28× |
| `S ? ?` | 17.0 ms | 16.7 ms | 1.02× |
| `S P ?` | 13.2 ms | 13.7 ms | 0.96× |

Object-bound lookups were the pathological case — with only spo ordering they scan the whole file.
That is now fixed. Subject-bound patterns were already served well by spo and are unchanged.

**End-to-end** (same data, identical solution counts):

| query | one index | three indexes | |
|---|---:|---:|---:|
| C2 | 141.5 s | **97.9 s** | 1.45× |
| C3 | 536.4 s | 557.4 s | 0.96× |

Storage grows 2.7× — 48.3 MB becomes 128 MB across the three files.

**Verdict: worth having, but not the fix.** C2 improves because its bind joins hit object- and
predicate-bound patterns. C3 does not — its lookups are mostly subject-bound, where spo already
won, and it comes out marginally slower, plausibly because the working set is now spread over
128 MB of Parquet rather than 48 MB.

The floor is still 10–18 ms per lookup. Ordering fixes *which* row groups DuckDB reads; it does not
change the cost of reading one — decompressing a ZSTD-22 row group and scanning it. That residual,
not the ordering, is what separates this from HDT's microsecond index seek.

A cheaper follow-up in the same direction: pycottas writes DuckDB's default row-group size, so
pruning granularity is coarse. Smaller row groups would prune finer for point lookups, at some
compression cost. Untested.

## Recommendations

1. **Push joins into DuckDB.** This is not an optimisation, it is the architecture the format is
   built for, and the measurements above put the prize at two to three orders of magnitude.
   Comunica supports this in two tiers:
   - `joinBindings: true` on the selector shape. `ActorRdfJoinMultiBindSource` (already in the
     engine) then hands the source a *block* of bindings instead of one at a time, and the source
     answers with a single SQL query joining against a `VALUES` list. Bounded semantics — still
     just triple patterns plus an equijoin — and it collapses 96,052 lookups into a few hundred.
     This is the cheap, safe win.
   - A wider selector shape accepting `join` over patterns, compiled to one SQL query. Bigger
     prize, bigger surface. Safe for basic graph patterns, because join equality is term equality
     and that is string equality on canonical N-Triples. **Not** safe to extend to `FILTER`,
     `ORDER BY` or aggregates without care: SPARQL uses value semantics and three-valued logic
     where SQL would give string comparison. Pushing down joins only is the defensible boundary.
   - Note that paging a pushed-down join with `LIMIT`/`OFFSET` would re-execute the join per page.
     This needs DuckDB's streaming reads (`startStream`/`streamAndRead`), which the Node API does
     expose.

2. **Three index orders** — implemented, see section 5. Keep it: it removes an 8.9x cliff on
   object-bound lookups for 2.7x storage. It does not change the conclusion above.

3. **Do not** pursue smaller row groups, the metadata-cache setting, or removing `file_row_number`.
   All three were measured and none of them moves the number.
