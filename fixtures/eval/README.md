# `fixtures/eval` — the evaluation corpus

Recorded and checked by `api/eval/run.mjs`. The reasoning — the two tiers, the
tolerance arithmetic, the wall-clock redaction, the back-run — is in
`api/eval/README.md`; this file is the convention for the fixtures themselves.

```sh
cd api
npm run eval:check                        # every case, both tiers
npm run eval:record                       # re-record all of them
npm run eval:record -- --only=mid-solo    # just one
```

One file per case, named for the case id. **One file per case on purpose:**
two people re-recording different cases on different branches produce two
one-file diffs that merge, rather than one enormous file that conflicts.

## What is in a file

| field | what it is |
|---|---|
| `case` | the frozen case declaration — a recorded fixture never re-derives its input |
| `evalHours` | simulated hours per run. Always 1, declared in `cases.mjs`, deliberately **not** the bench's `hours` |
| `seeds` | how many seeds. The seeds themselves are derived from the case id, so they are reproducible and are not stored |
| `node`, `platform` | where this was recorded. `eval:check` warns loudly on a mismatch |
| `stats` | `mean`, `sd`, the two band terms, and `boundBy` — which term actually bound |
| `headlineFirstSeed` | the full headline of the first seed, once, for orientation |
| `runs[]` | one line per seed: `seed`, `sha256`, the asserted `value`, `deaths`, `dungeons` |

`runs` is written one run per line rather than pretty-printed. Sixteen lines is
a diff a reviewer reads; a hundred and thirty is one nobody reads twice.

The per-run record is deliberately **not** the whole headline. `encounters` is
already `value` for a zone case, `elapsedTime` is null on every `SimResult` the
engine produces, and `experienceKeys` is a constant — storing those 464 times
cost 45 % of the corpus to say nothing. The whole corpus is ~88 KB.

## Seeds

```
seed_i = fnv1a32(case.id) + i · 7919
```

A case's seeds depend on its own id and nothing else. Adding, removing or
reordering a case never renumbers another case's seeds, so a re-record is
always a local diff. A prefix of a longer seed list is the shorter seed list,
so `--seeds=4` checks the first four of the sixteen that were recorded — a
faster, weaker check, never a different one.

Changing `fnv1a32` or the stride renumbers every seed and invalidates all 464
hashes. That is allowed, but it is a deliberate act, and a guard test in
`api/tests/evalHarness.test.mjs` pins the literals so it cannot happen by
accident.

## Re-recording

Re-record when:

- the **game data** changes (`src/combatsimulator/data/*.json`, an upstream
  client pull), or
- a combat **rule** deliberately changes, or
- a **case is added** — and then only that case's file, which is why the seeds
  are derived the way they are.

Note the reason in the commit message, and say which of the three it was.

## Re-recording is not how you make a failing optimisation pass

This is the same rule `fixtures/sim/README.md` states, and it is the rule the
whole corpus rests on. If `eval:check` drifts after a change that was supposed
to be behaviour-preserving, **the change altered behaviour.** The run is
seeded; that is not noise.

The honest paths out of a red strict tier are:

1. find the behaviour change and fix it;
2. establish that it is a distribution-preserving reorder — Tier B green across
   every case, and an argument for *why* the draws moved — and record that
   argument, with the tier it rests on named, in `api/eval/records/` and in
   `todo.md`. Tier B agreement is weaker evidence than Tier A's and must be
   reported as such;
3. decide the change is correct and the old behaviour was wrong, and re-record
   *as a rule change*, saying so.

What is not a path out is re-recording quietly, or widening a band. The band is
computed from the recorded sample's own spread precisely so that nobody has to
choose a number, and so that choosing one would be visible.
