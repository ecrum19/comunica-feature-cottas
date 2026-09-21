# Join push-down: what changed and why

Branch `join-pushdown` (commit `d027aeb` + README). Builds on `multi-index`.

## The problem

Comunica treated COTTAS as a triple-pattern store: it planned every query as a cascade of bind
joins and did the joining itself, so one WatDiv query issued tens of thousands of separate DuckDB
queries. Each costs 7–13 ms — simply what it costs to read a handful of rows from a compressed
columnar file. Index ordering, `parquet_metadata_cache`, row-group size and cost metadata were all
measured and none of them moves that number (see `COTTAS_SLOW_QUERY_INVESTIGATION.md`).

The same query written as one SQL join runs in 0.2 s. So the fix is not to make lookups cheaper but
to stop doing them.

## What changed

**1. The source advertises a wider selector shape.** Previously only `pattern`; now a disjunction
of `pattern` or a `join` whose children are patterns. This is what makes Comunica hand the source a
basic graph pattern whole instead of decomposing it.

**2. `joinSql` compiles a BGP into one query.** One alias per pattern over the index best suited to
*that pattern's* bound components (so the three index orders still pay off inside the join). A
variable's first occurrence fixes the column it projects from; every later occurrence becomes an
equality against that column.

That is sound because SPARQL join equality is *term* equality, and terms are stored as canonical
N-Triples strings — so term equality is string equality. It is the same invariant the format
already relies on.

**3. Results stream.** `openJoin` holds one DuckDB streaming result and fetches chunks as the
consumer reads. Two reasons:
- Paging a join with `LIMIT`/`OFFSET` would re-execute the whole join once per page. At 8192 rows
  per page, C3 would re-run its join 52 times.
- The cursor takes **its own connection**. A streaming result holds its connection while being
  read, so sharing one would serialise concurrent joins behind each other.

An earlier attempt used the reader's `getRowObjectsJS()` and sliced. That re-materialises every row
read so far on each page — quadratic, and C3 hung. `fetchChunk()` is the right API.

**4. Terms are decoded per distinct value, not per row.** Subjects and predicates repeat heavily
across join results, so each chunk's unique strings are parsed once in a single N-Quads pass and
looked up per row.

## What is deliberately *not* pushed down

Only joins. `FILTER`, `ORDER BY` and aggregates stay in Comunica.

SPARQL compares those **by value with three-valued logic**; SQL would compare the stored strings.
`"1"^^xsd:integer = "1.0"^^xsd:decimal` is true in SPARQL and false as strings; SPARQL's ordering is
type-aware, not lexicographic; a FILTER that errors is false, not null. Pushing joins is safe
because join equality is term equality. Pushing comparison is not. That is the boundary.

## Results

WatDiv scale 100, 10,930,937 triples, same VM, identical solution counts throughout.

| | original | + cardinality cache | **+ join push-down** |
|---|---:|---:|---:|
| full matrix, wall clock | 7 h 36 min ❌ failed | 4 h 02 min | **4 min 46 s** |
| sum of medians | 945.0 s | 685.9 s | **13.5 s** |
| errored instances | 6 of 100 | 0 | **0** |
| C2 | terminated at 1800 s | 53.4 s | **0.8 s** |
| C3 | 538.4 s | 550.6 s | **8.6 s** |

For reference: `comunica-feature-hdt` answers C2 in 9.3 s on this data, and raw SQL answers it in
0.229 s. We are now ~10x faster than HDT and within a small factor of hand-written SQL.

C3's residual (8.6 s against 0.189 s of SQL) is materialising 425,591 bindings as RDF terms in
JavaScript. That is Comunica-side cost, not COTTAS.

**This changes CI feasibility.** WatDiv-100 was 242 minutes against a 120-minute job timeout; it is
now under 5 minutes, so it fits comfortably even with a pull request running base and head.

## Correctness

- 120 unit tests, 100% statement/branch/function/line coverage, lint clean.
- e2e against DuckDB ground truth on real genome files: **32/32** at 94,919 triples (including the
  exact md5 fingerprint of a full scan) and **32/32** at 958,919 triples.
- Edge suites unchanged at 24/27 and 12/14 — the same known items (two wrong expectations in the
  harness, upstream `FROM NAMED`, and file-side escapes that are out of scope by design).
- Every measurement above returns the same solution count as the pre-change engine.

## Trade-offs and risks worth review

- **Cardinality for a pushed-down join is an exact `COUNT(*)`**, so it runs the join twice. That is
  one extra query per BGP rather than per binding, and it is cheap relative to what it replaced,
  but an estimate would halve the remaining time on large results.
- **Chunks accumulate in a buffer** between reads. Bounded by the consumer's page size in practice,
  but a consumer that stops reading mid-join holds a chunk until the iterator is destroyed.
- **The single-pattern path is unchanged.** Queries that are one triple pattern still use the
  offset-paged iterator, so nothing regressed for the genome-scale scan workloads.
