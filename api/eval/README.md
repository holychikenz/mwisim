# The evaluation suite

Three harnesses in this repository ask three different questions, and the
difference between them is the whole point:

| harness | question |
|---|---|
| `fixtures/lab` (`lab-parity.mjs`) | *is the simulator right about the game?* |
| `fixtures/sim` (`sim-parity.mjs`) | *does one deep result tree replay exactly?* |
| `fixtures/eval` (this) | *does the engine still behave the same across a whole catalogue, and can we say so about a version from six weeks ago?* |

```sh
cd api
npm run eval:check                          # 29 cases × 16 seeds, both tiers, ~12 s
npm run eval:record                         # (re-)record the corpus from this engine
npm run eval:check -- --only=dungeon-den-600 --tier=strict
npm run eval:backrun -- --against=dabf8c9   # the same corpus against an older engine
```

## The two tiers, and why they are kept apart

**Tier A — strict.** For each `(case, seed)`, the sha256 of the redacted
canonical `SimResult` must match the recorded one exactly. This is the
day-to-day gate. It fails on any behaviour change at all, including ones far
too small to see in a mean, and it is the tier a performance change must pass.

**Tier B — statistical.** The ensemble mean of the case's headline quantity
over the S seeds must lie inside a recorded band. It survives a legitimate
refactor that reorders RNG draws without changing what any of them is a draw
*from* — the one thing Tier A cannot tell apart from a bug.

They measure different things, and that was **verified by perturbation, not
assumed**:

| perturbation | Tier A | Tier B |
|---|---|---|
| `maxDamage` base constant 10 → 11 (+0.5 % damage at L200) | 54 / 464 | 28 / 29 |
| 10 → 20 (+4.8 %) | 48 / 464 | 22 / 29 |
| 10 → 40 (+14 %) | 46 / 464 | 15 / 29 |
| swap the crit and hit draws (same marginals, different stream order) | **4 / 464** | **29 / 29** |

The last row is the one that justifies having two tiers. A pure reordering
reddens Tier A almost completely and leaves Tier B untouched, because nothing
about the distribution moved. The first three rows show Tier B is blunt but not
blind: it needs a few percent before it fires, which is exactly the trade
being made.

## The tolerance is computed, not chosen

At record time the sample mean and sample sd over the S seeds are stored. At
check time:

```
band = max( 4 · sd_rec · sqrt(2/S) ,  0.0025 · |mean_rec| )
pass ⟺ |mean_new − mean_rec| ≤ band
```

`sd · sqrt(2/S)` is the standard error of the **difference of two S-sample
means** under equal variance — the conservative case, in which the two engines'
draws are independent rather than shared. `k = 4` gives ≈ 6 × 10⁻⁵ two-sided
per test; over ~29 cases the family-wise false-alarm rate is ≈ 1.8 × 10⁻³, or
about **one spurious red per 550 clean runs**. That number is written down here
so it can be argued with, rather than becoming folklore about how the suite
"sometimes flickers".

The **0.25 % floor** is not padding. Discrete quantities can have sd = 0: every
seed of `trial-badger-5` clears exactly tier 140, which collapses the 4·SE term
to zero and would make the band unsatisfiable by any change whatsoever. The
floor also absorbs cross-platform float noise. Both terms are written into each
fixture (`bandStatistical`, `bandFloor`, `boundBy`), so a reader can see which
one bound without recomputing anything.

## The wall-clock redaction

`src/combatsimulator/simResult.js:197` — `addWipeEvent()` stamps every wipe with
`new Date().toISOString()`. That is wall-clock time. It is not a function of the
inputs or the seed, so a hash taken over it is noise.

This had never fired, only because it had never been exercised: all three
`fixtures/sim` scenarios record `wipeEvents: []`. Measured on five bare L10
players in `chimerical_den` — **255 wipe events in a simulated hour** — two runs
*at the same seed* hash differently, with timestamps 9 ms apart. Scrubbing the
field restores bit-identity. `canonical()` in `api/lib/determinism.mjs` does
that, and two of the guard tests pin it: one that the redaction works, one that
it is not over-broad (a `timestamp` that is not inside `wipeEvents` still
reaches the hash).

The general rule, of which this is one instance: **any field carrying
wall-clock time, a UUID, a process identity, an absolute path or a memory
address must be redacted or the hash stops being a statement about behaviour.**
Redact narrowly, keyed on the containing field, never on the leaf name.

## Why the harness duplicates `runSimulation`'s body

`api/eval/engine.mjs` reimplements the ~12-line calling convention rather than
importing `api/lib/simulator.js`. That file itself drifted across the
optimisation span being measured, so a back-run that imported the historical
copy would fold harness changes into the engine comparison, and one that
imported the current copy against a historical engine would be a version
mismatch waiting to throw. Either way the answer would stop being a statement
about the engine.

The price is a duplicate that can silently diverge. It is paid for by one test:
**`api/tests/evalHarness.test.mjs`, "eval/engine.mjs reproduces runSimulation()
bit for bit"** — a solo case and a five-player dungeon, asserted to produce the
identical hash through both paths at HEAD. If that test is deleted or weakened,
this directory becomes a second engine harness that nobody is checking.

## Why `git archive` and not `git worktree`

A worktree is a checkout of the whole repository, `api/` included — and `api/`
is precisely what must *not* change between the two measurements. It would also
mean a second `node_modules` and a second loader. `git archive <ref>
src/combatsimulator | tar -x -C <scratch>/<ref>` extracts ~4.7 MB of engine and
nothing else, and the current harness loads it.

The extraction path matters: `api/loader.js` resolves bare specifiers only when
the importing file's path contains the literal substring
`/src/combatsimulator/`, and `git archive` reproduces that prefix.

## The heap-js control

`bb4d767` re-pinned `heap-js` from `^2.2.0` to exactly `2.7.1`. The loader
resolves it from the **current** `node_modules` whichever engine is loaded, so
both engines get 2.7.1. That is the correct control — it isolates engine source,
which is what the question is about — but it means a back-run says nothing
about whether the dependency bump itself changed anything. If you want to know
that, it is a different experiment.

## What a cross-version hash match does and does not prove

- A **match** is very strong evidence: identical draws consumed in identical
  order, producing an identical tree.
- A **mismatch** proves only that RNG consumption order or the result tree
  changed. It is **not** proof of a bug — see the perturbation table above,
  where a distribution-preserving reorder reddened 460 of 464 hashes.
- On a mismatch the verdict escalates to Tier B across all seeds. Agreement
  there makes the change *consistent with* behaviour preservation. That is a
  weaker claim than Tier A's, and `backrun.mjs` always names the tier its
  verdict rests on for exactly that reason.

## Cross-platform

The corpus was recorded on **node v26.8.2 / darwin-arm64**, and each fixture
records the node version and platform it came from; `eval:check` warns loudly
when they do not match. `.github/workflows/ci.yml` pins node to the recording
major.

`Math.random` is overridden, so that source of divergence is neutralised, and
key order and sort stability are specified by the language. Float formatting
and `structuredClone` behaviour across engine versions and platforms are **not**
guaranteed, and reproduction of the strict tier on linux-x64 was **unverified**
at the time of writing — it must be confirmed on the first CI run.

**Contingency, if a genuine cross-platform difference exists:** do not
re-record. Demote the strict tier to *platform-pinned* — run Tier A only on the
recording platform — and let Tier B carry CI everywhere else. Document the
demotion and the difference that forced it, here, with the platforms named. A
suite that quietly re-records itself onto whatever machine ran it last is a
suite that asserts nothing.

## What would make this suite wrong

- **A field the engine computes but does not put in `SimResult`.** Tier A
  hashes the result tree; anything outside it is invisible here.
- **A new non-deterministic field.** A second wall-clock stamp, a uuid, a
  path — added anywhere in `SimResult` — makes every hash noise, and the
  failure looks like a drift rather than like a bug in the harness. Add it to
  `REDACTIONS` in `api/lib/determinism.mjs` and say why.
- **The worker branch.** The seeded `Math.random` does not reach a worker
  realm, so nothing here covers `runSimulationWithWorker`.
- **A change that only the bench's `hours` would reveal.** Everything here runs
  at exactly one simulated hour (`EVAL_HOURS`).
- **`api/eval/engine.mjs` drifting from `api/lib/simulator.js`** — guarded by
  one test, and by nothing else.
- **Re-recording to make a failure go away.** See `fixtures/eval/README.md`.

## Files

- `cases.mjs` — what runs and at which seeds. Zone cases are `CASES` from
  `../bench/builds.mjs`, imported unchanged; the labyrinth and guild-trial
  cases are declared here because they have no `zone`.
- `engine.mjs` — `loadEngine(root)`, the engine-agnostic adapter.
- `run.mjs` — `record` / `check`, the tolerance arithmetic and the table.
- `backrun.mjs` — extraction, the data-change guard, and the verdict.
- `records/` — back-run verdicts, matching `bench/records/`.
