# Why COTTAS queries are slow

WatDiv scale 100 (10,930,937 triples), query C2. All measurements on one 8-core/31 GB VM,
same data and same Comunica version throughout.

## Summary

Comunica plans the query as a cascade of **bind joins** — tens of thousands of point lookups.
That is the right plan for HDT, where a lookup is an in-memory index seek. On COTTAS each lookup
is a DuckDB query over Parquet costing **13.5 ms**, so the same plan is orders of magnitude more
expensive per step.

The cost is **entirely in DuckDB**, not in the RDF translation layer, and it is structural: a
COTTAS file is a plain Parquet table with no index.

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

## 4. The cost is DuckDB, not the JS layer

200 bound-subject lookups of the shape a bind join generates:

| | per lookup |
|---|---:|
| raw DuckDB (SQL only, no RDF) | 12.70 ms |
| full adapter (+ N-Triples parse, terms, bindings) | 12.71 ms |
| **JS translation overhead** | **0.02 ms** |

Split by operation: 2.8 ms cardinality probe + 10.7 ms page read.

The RDF translation layer is free at this granularity — a point lookup returns few rows. pycottas
sorts the file SPO, so DuckDB prunes row groups by subject via Parquet statistics (which is why a
lookup is 10 ms rather than a full 50 MB scan), but there is no index to seek into. HDT ships a
real SPO index, so the same lookup is a pointer chase.

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

1. **Push joins into DuckDB.** Widen `getSelectorShape` so Comunica delegates joins to the source
   and SQL does them in one query instead of thousands of point lookups. This is the thing COTTAS
   can do that HDT structurally cannot, and it removes the per-lookup cost rather than reducing it.
2. **Index at open time.** Load the Parquet into a DuckDB table with indexes, trading startup cost
   for fast lookups — what HDT's index provides for free. Viable at benchmark scale; needs care for
   a 498M-triple file.
3. **Three index orders** — done, see above. Keep it: it removes an 8.9× cliff on object-bound
   patterns for 2.7× storage. It does not close the gap on its own.

Optimising the JS side has 0.02 ms available to win. A cardinality cache (already implemented)
removed the 2.8 ms probe on repeated patterns, taking C2 from 513 s to 134 s; the remaining 10.7 ms
needs one of the two above.
