# Why the large benchmarks are slow

Investigation of WatDiv-100 C2 (140 s, 0 solutions) on vcf-bench-1, 2026-09-21.
Dataset: 10,930,937 triples, identical for every measurement below.

---

## Answer in one line

Comunica plans the query as a cascade of bind joins — tens of thousands of point lookups. That is
the right plan for HDT, where a lookup is an in-memory index seek costing microseconds. On COTTAS
each lookup is a DuckDB query over Parquet costing **13.5 ms**, so the same plan is ~1000x more
expensive per step.

---

## 1. Are cardinalities properly communicated?

**The values are correct.** Every distinct pattern the engine probed was checked against DuckDB:

```
   ok          95 (duckdb        95)  ?v0 <schema.org/legalName> ?v1
   ok      120756 (duckdb    120756)  ?v0 <goodrelations/offers> ?v2
   ok        8951 (duckdb      8951)  ?v2 <schema.org/eligibleRegion> <wsdbm/Country5>
   ok      150000 (duckdb    150000)  ?v7 <wsdbm/purchaseFor> ?v3
   ...
   12 distinct patterns checked, 0 wrong; 96,052 probes total
```

Reported as `{ type: 'exact', value: N }`. No cardinality defect.

**But the metadata carries no cost signal.** The object reaching the join planner has exactly three
keys:

```
keys: state, cardinality, variables
pageSize: undefined | requestTime: undefined | order: undefined | availableOrders: undefined
```

That matters, because `ActorRdfJoin`'s cost model reads the two missing fields:

```js
getRequestInitialTimes = metadata.pageSize ? 0 : metadata.requestTime ?? 0   // -> 0
getRequestItemTimes    = metadata.pageSize ? requestTime / pageSize : 0      // -> 0
```

With both at zero, `isRemoteAccess` is false, which grants bind joins a **3x** leniency bonus in
their admission gate, and the bind join's own `requestTime` coefficient evaluates to `0 + card *
(0 + 0 + card * 0)` = **0**. The planner believes 96,052 lookups are free.

### …but fixing that does not help

Tested by patching the metadata directly:

| metadata | plan | probes | time |
|---|---|---:|---:|
| baseline (no cost fields) | 10 × `join-inner(bind)` | 96,052 | 141.1 s |
| `requestTime: 5` | 10 × `join-inner(bind)` | 96,052 | 139.8 s |
| `pageSize: 8192` + `requestTime: 50` | 10 × `join-inner(bind)` | 96,052 | 139.9 s |

Identical plan, identical probe count, identical runtime. **The missing cost metadata is a real
gap, but it is not the cause.** Worth fixing for correctness of the model, not for speed.

`cardinality.type` was also ruled out by reading the code: `'exact'` vs `'estimate'` only affects
how types propagate when combining metadata, no planning gate branches on it.

---

## 2. Is the plan different from comunica-feature-hdt?

Set up `comunica-feature-hdt` on the same VM with the `dataset.hdt` from the same WatDiv-100
archive — same data, same query, same Comunica version.

| | COTTAS | HDT |
|---|---|---|
| wall clock | **140 s** | **9.3 s** (incl. ~4.7 s one-time index build) |
| join operators | 10 × `bind` | 8 × `bind` + 1 × `multi-smallest` |
| plan shape | deep bind cascade | shallower, one level flattened |

So yes, the plans differ — but only slightly, and not enough to explain a 15x gap. HDT flattens the
outermost join into `multi-smallest`; COTTAS nests bind joins all the way down:

```
COTTAS:  bind(?v0 legalName ?v1, est 95)
           bind(Retailer1028 offers ?v2, est 130)
             bind(Offer1140 eligibleRegion Country5, est 1)
               bind(Offer1140 includes ?v3, est 1)
                 bind(?v7 purchaseFor Product17038, est 1)
                   bind(?v4 makesPurchase Purchase12460, est 1)   ...

HDT:     multi-smallest
           bind(?v0 legalName ?v1, est 95)  ->  pattern (Retailer10 offers ?v2)
           bind(undefined, est ~95)         ->  join of 8 patterns
```

---

## 3. What actually costs the time

Measured directly: 200 distinct bound-subject lookups of the shape a bind join generates, against
the same 10.9M-triple COTTAS file.

| | per lookup |
|---|---:|
| `countPattern` (cardinality probe) | **2.8 ms** |
| `searchBindings` (first page) | **10.7 ms** |
| **total per bind-join step** | **13.5 ms** |

The equivalent on HDT is an in-memory index seek — microseconds. That ratio, not the plan, is the
15x. C2's 96,052 probes at 2.8 ms each is 269 s of cardinality probing alone, which is exactly what
the cardinality cache removed when it took C2 from 513 s to 134 s.

Note *why* a lookup costs 13.5 ms: the pycottas file is sorted SPO, so DuckDB can prune row groups
by `s` using Parquet statistics, but there is no index. A bound-predicate or bound-object lookup
prunes nothing.

---

## Where this leaves us

The plan Comunica chooses is reasonable and close to HDT's. The problem is that both plans assume
point lookups are nearly free, and the source has no way to say otherwise — and as shown above,
even saying otherwise changes nothing, because the planner has no alternative to offer: the source
advertises only `pattern` operations, so every join must be executed by the engine, one lookup at a
time.

Two directions, in order of expected payoff:

1. **Push joins into DuckDB.** Widen `getSelectorShape` so Comunica can delegate joins to the
   source and let SQL do them in one query instead of thousands of point lookups. This is the thing
   COTTAS can do that HDT structurally cannot, and it attacks the actual cost driver.
2. **Make lookups cheap.** Load the Parquet into a DuckDB table with indexes at open time, trading
   startup cost for microsecond lookups — essentially replicating what HDT's index gives for free.
   Viable at benchmark scale; needs care for the 498M-triple genome file.

The already-landed cardinality cache removed the 2.8 ms half of every repeated lookup. The
remaining 10.7 ms half is only addressable by one of the two above.
