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

## Recommendations

1. **Index at open time.** Load the Parquet into a DuckDB table with indexes, trading startup cost
   for fast lookups — essentially what HDT's index provides for free. Directly attacks the 12.7 ms.
   Viable at benchmark scale; needs care for a 498M-triple file.
2. **Push joins into DuckDB.** Widen `getSelectorShape` so Comunica delegates joins to the source
   and SQL does them in one query instead of thousands of point lookups. This is the thing COTTAS
   can do that HDT structurally cannot.

Optimising the JS side has 0.02 ms available to win. A cardinality cache (already implemented)
removed the 2.8 ms probe on repeated patterns, taking C2 from 513 s to 134 s; the remaining 10.7 ms
needs one of the two above.
