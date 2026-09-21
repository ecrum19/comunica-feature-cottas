# COTTAS — change summary, code review, and PR plan

Prepared 2026-09-21. All branches are **local and unpushed**.

---

## 1. What changed

Four topic branches off `master` (`874f461`). Every one is independently reviewable; all three
feature branches merge cleanly into one another (verified).

| branch | commits | diff | what |
|---|---:|---|---|
| `fix-term-matching` | 1 | 8 files, +402/−23 | C1 + C2 correctness fixes |
| `cache-cardinality` | 2 (+1 base) | 9 files, +630/−26 | Cardinality LRU (branches off the above) |
| `benchmark-workflow` | 10 | 78 files, +1394/−151 | Your benchmark automation + all reports |
| `integration-test` | — | 87 files, +2024/−177 | Throwaway merge, used for the VM runs. **Delete it.** |

### The engine changes

- **`pageSize` (already on `master` in `874f461`).** Ported HDT's growing-page policy. Pages ramp
  128 → 8192 instead of sitting at the buffer size. 17x on a 959k-triple scan.
- **C1 — term encodings.** Constant pushdown compared one N-Triples spelling against the stored
  string, so a file using another legal encoding of the same RDF term returned nothing, silently.
  Now matches every encoding RDF calls equivalent: `xsd:string` vs simple literals, case-insensitive
  language tags, and N3's astral/control escapes against raw storage. Still fully pushed into DuckDB.
- **C2 — `unionDefaultGraph`.** The context entry was ignored, so a default-graph pattern over a
  quad file always matched `g IS NULL`. Now threaded from context through source and iterator into
  the SQL, matching Comunica's own RDF/JS source.
- **Cardinality cache.** Bounded LRU of pending `countPattern` promises. WatDiv-100 went from
  failing after 7 h 36 min to passing in 4 h 02 min, zero errors.

Tests went 67 → 71 → 86 → **95**, at 100% statement/branch/function/line throughout.

### Measured results

| | before | after |
|---|---:|---:|
| full scan, 959k triples | 229 s | 13.5 s |
| HG005 `LIMIT 10000` (498M triples) | timeout @300 s | 14.9 s |
| WatDiv-100 matrix | ❌ 7 h 36 min | ✅ **4 h 02 min**, 0 errors |
| WatDiv-100 sum of medians | 945.0 s | 685.9 s |
| BSBM-1k | ❌ endpoint timeout | ✅ 25 min |
| BSBM-10k | never run | ✅ 85 min |

`yarn run verify` passes on the merged result: build, 95 tests, lint, depcheck, 9 benchmark-script
tests, 4 JBR validations, docs (0 errors).

---

## 2. Code review of the added code

Reviewed the ~1,030 lines I added across `CottasDocument.ts`, `CottasIterator.ts`,
`QuerySourceCottas.ts` and `ActorQuerySourceIdentifyCottas.ts`.

### Fixed during this review

- **`termCondition` built its SQL in a nested template literal** — a `map` inside a `${}` inside a
  template, split across lines. Correct but genuinely hard to read. Extracted the clause list into a
  named local; same output, no cleverness.
- **`CardinalityCache.set` could delete the wrong entry.** `value.catch(() => entries.delete(key))`
  deletes by key alone. If an entry is evicted, re-created, and the *original* promise then rejects,
  the cleanup removes the newer entry. Not a correctness bug — cardinality stays right, you just
  lose a cache entry — but it is a real defect. Now compares identity before deleting, with a test.
- **The base-direction guard was unexplained.** `encodings.every(e => e.endsWith('@' + tag))` exists
  to rule out `@en--ltr`, where slicing the tag off by length would cut into the direction. Comment
  added.

### Accepted, with reasons

- **`cardinalityKey` duplicates `patternSql`'s variable numbering.** Both walk s/p/o/g and number
  variables by first occurrence. Tempting to derive the key from `patternSql`'s output instead —
  the WHERE clause plus its bound values *is* a perfect key. Rejected deliberately: `patternSql`
  serializes every bound term, and hoisting it above the cache check would pay that cost on cache
  *hits*. The first implementation did exactly that and measured **8% slower than no cache at all**
  on miss-heavy WatDiv C3. The duplication buys the hit path; the doc comment says so.
- **`CardinalityCache` is a hand-rolled LRU (~30 lines).** `lru-cache` is already in the tree as a
  transitive dependency, but adding a direct dependency to a hot-path reader for 30 lines of
  `Map`-ordering is a worse trade, and the promise-caching and rejection semantics are the parts
  that actually matter here.
- **`unescapeUnicode`'s regex has a `(.)` catch-all.** It looks odd until you see why: it consumes
  escaped backslashes left to right so `\\U0001f600` is never mistaken for a character escape.
  Commented, and there is a test for exactly that case.

### Complexity

`CottasDocument.ts` is **550 lines**, up from 378. That is the one number worth watching — it is
now doing three jobs: DuckDB lifecycle, RDF term translation, and cardinality caching. It is not
unreasonable today, and every piece has a single responsibility, but the next substantial addition
should split term serialisation/encoding into its own module rather than growing this file further.
Nothing else exceeds 130 lines.

No dead code, no `any` outside the two pre-existing casts, no new public API beyond the documented
`pageSize` parameter and the exported `CardinalityCache` (excluded from Components.js generation).

---

## 3. Submitting upstream

### The target already exists — and it is empty

`comunica/comunica-feature-cottas` exists (created 2026-08-21, public) and contains **only
`4ebc7fbe Initial commit`**, size 0. Your `master` descends from that same commit. Your `origin`
is `ecrum19/comunica-feature-cottas` and `upstream` already points at the org repo.

So this is not an incremental PR into an established codebase — it is the **initial import of the
whole feature**, ~2,000 lines plus the existing `master` work. Expect it to be reviewed as a
donation, not a patch.

### Blocking before you open it

1. **Squash-or-not decision with the maintainers.** `master` already carries `ee628c4`,
   `48b14eb` ("Codex implementation") and `874f461` ("end-to-end testing finished"). Those messages
   will not read well in the org's history. Agree up front whether they want a clean single import
   commit or the real history.
2. **Remove the three `COTTAS_IMPLEMENTATION_*.md` files** and the two report files
   (`COTTAS_REVIEW_AND_E2E_REPORT.md`, this file). They are working artefacts with no HDT
   counterpart. Fold anything durable into `CHANGELOG.md` and the package READMEs.
3. **Rewrite `CHANGELOG.md`** into HDT's `manual-git-changelog` format — the `version` script
   expects it.
4. **Reset `lerna.json`** from `5.3.0` to an honest first version, and let the Comunica
   dependencies float independently (HDT is at its own `5.0.1` against Comunica `^5.4.0`).
5. **Fix the Node engines claim** — the README promises "Node.js 22 or newer" but
   `yarn install --frozen-lockfile` fails on 22.20.0; CI hides it with `--ignore-engines`.
6. **Docker network cleanup in `ci.yml`** — the existing step removes containers only, so a rerun
   after any failure dies on a stale `jbr-*` network. One line:
   `docker network ls --filter name=jbr -q | xargs -r docker network rm`.
7. **Trim the CI benchmark matrix.** WatDiv-100 needs 242 min for one engine against a 120-minute
   job timeout, and BSBM-10k needs 85 min (≈170 on a PR, which runs base and head). Ship PRs with
   `watdiv-cottas` + `bsbm-cottas` only; move the 10x jobs to `master` pushes or a schedule.

### Not blocking, but ask

- The `integration` script points at `.../manifest-ldf-tests/sparql-cottas/cottas-manifest.ttl`,
  which **404s**. CI does not invoke it (`if: ${{ false }}`). Either ask for that manifest to be
  authored or drop the script rather than shipping a broken one.
- `yarn.lock` is committed; HDT ships none. Defensible either way — just be deliberate.
- README badges only start working once CI runs in the org.

### Suggested sequence

1. Open an issue on `comunica/comunica-feature-cottas` describing the implementation and asking how
   they want the import structured. Do this **before** pushing anything.
2. Land the housekeeping (items 2–5 above) on `master` locally.
3. Merge `fix-term-matching`, then `cache-cardinality`, then `benchmark-workflow`, keeping them as
   separate commits so each is reviewable on its own.
4. Push to `ecrum19/comunica-feature-cottas`, open the PR against `comunica:master`.
5. Expect CI to fail the Docker/Coveralls/benchmark-publish steps until org secrets
   (`DOCKER_USERNAME`, `DOCKER_PASSWORD`, `PAT`) exist. The publish steps are already guarded on
   `github.repository == 'comunica/comunica-feature-cottas'`, so they degrade rather than error.

### Known limitations to state in the PR description

- C1 does not cover escapes originating **in the file** (`<urn:café>`). That set is unbounded;
  the only complete fix is normalising the column, which costs the pushdown. The contract is
  canonical N-Triples, which both reference writers produce.
- `FROM NAMED` fails — reproduced identically with a non-COTTAS source, so it is upstream
  Comunica 5.3.0, not this feature.
- Remaining deferred optimisations are recorded under "Future optimizations" in the checklist:
  multiple DuckDB connections, and a streaming cursor for deep `OFFSET`.
