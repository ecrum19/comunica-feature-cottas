# Federation benchmark

Runs every WatDiv template against one COTTAS file and against the same data split over several
files, and checks that every split returns exactly the results of the single file.

| Layout | Sources | What it exercises |
| --- | --- | --- |
| `single` | `dataset.cottas` | the baseline: whole basic graph patterns are pushed into one file |
| `predN` | N files, split by a hash of the predicate | a pattern with a constant predicate matches one file; cross-file joins bind into a single source |
| `subjN` | N files, split by a hash of the subject | every pattern matches every file and becomes a union; joins bind into unions |
| `subj2+nt` | one COTTAS file and one N-Triples file | a union branch whose source can not take a block of bindings |

WatDiv has no blank nodes; the engine tests in `engines/query-sparql-cottas/test/QueryEngineFederation-test.ts`
cover them.

## Running

```bash
# Partition a prepared WatDiv dataset (all three index orders) into 2 and 4 parts.
node performance/federation/partition.js performance/benchmark-watdiv-cottas/generated /tmp/fed 2 --ntriples
node performance/federation/partition.js performance/benchmark-watdiv-cottas/generated /tmp/fed 4

# Run the first instance of each template on each layout, one query process at a time.
ENGINE=$PWD DATA=$PWD/performance/benchmark-watdiv-cottas/generated PARTS=/tmp/fed \
  LAYOUTS="single pred2 subj2 pred4 subj4 subj2+nt" LABEL=head OUT=/tmp/fed/results.jsonl \
  bash performance/federation/run-suite.sh

# Medians, totals and result equality.
node performance/federation/summarize.js --markdown /tmp/fed/results.jsonl
```

`ENGINE` may point at any checkout with a built engine, so two versions can be compared on the
same partitions. `run-query.js` counts the queries each kind of COTTAS call sends to DuckDB, which
shows whether joins were pushed down (`openJoin`), bound in blocks (`openBoundJoin`,
`openFilterJoin`), or resolved one pattern at a time (`countPattern`, `searchBindings`).

## Results: WatDiv-10

Measured on 2026-11-17 on a SLICES VM, with three repetitions and medians reported. The **old** engine is master
before the federation work (Comunica 5.3, `bind-source`); the **new** engine is this branch (Comunica 5.4,
`bind-sources`, pushed bindings). The totals sum the 19 templates that finish everywhere; C2 times out on `pred4`
in both engines.

| Layout | old total | new total | DuckDB queries, old → new |
| --- | ---: | ---: | ---: |
| single | 3.97 s | 4.01 s | 40 → 40 |
| pred2 | 14.3 s | 4.13 s | 5,489 → 283 |
| subj2 | 52.6 s | 6.47 s | 77,906 → 5,284 |
| pred4 | 371.7 s | 17.7 s | 58,228 → 3,346 |
| subj4 | 51.0 s | 6.84 s | 155,773 → 10,548 |
| subj2+nt | 98.7 s | 57.1 s | 39,037 → 3,134 |

Every run that finished returned exactly the result multiset of the single file: 714 of 714 runs, the other 6
being the C2 timeouts on `pred4`. In `subj2+nt`, each query takes at least about 2.7 s because the 538 k-triple
N-Triples part is parsed for every query.
