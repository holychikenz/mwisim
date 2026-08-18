# All Zones — sweeping every zone and tier at once

Answers the question a single simulation cannot: **where should this build
actually fight?** One click runs every zone/tier combination the game offers in
a pool of web workers and reports them in one sortable table.

Shipped 2026-08-17. Closes gap #1 in [`ui/PARITY.md`](./ui/PARITY.md).

## What counts as a zone

`actionDetailMap` files 59 combat actions under one type, and they are not one
kind of thing:

| Kind | Test | Count | Tiers | Offered? |
|---|---|---|---|---|
| Solo monster | `randomSpawnInfo.maxSpawnCount === 1` | 44 | — | **No** |
| Planet | `maxSpawnCount > 1` | 11 | T0–T5 | Yes |
| Dungeon | `combatZoneInfo.isDungeon` | 4 | T0–T2 | Yes |

A solo action ("Fly", "Granite Golem", "Vampire") is a spawn *inside* a planet,
not a place a character can be sent — the game exposes it as an entry in the
planet's spawn table. Listing all 44 of them alongside the 15 real destinations
made the zone dropdown unusable, so the simulator now offers planets and
dungeons only. The taxonomy lives in [`ui/src/utils/zones.js`](./ui/src/utils/zones.js);
`useGameData` still builds the full list, because the drops and kills views name
solo monsters and the coercion below needs to see them.

**Stored zones are repaired, not rejected.** A session, an exported set or an
MWIX bridge payload naming a solo action is promoted to the planet it belongs to
— both share an action category, so `/actions/combat/fly` becomes Smelly Planet,
which is where that fight happens anyway. Unrecognised hrids fall back to the
default zone. Every route that writes `zone` goes through `handleZoneChange`.

**Tiers now come from the data.** `action.maxDifficulty` is the game's own
ceiling: 5 on every planet, 2 on every dungeon. The header's tier select is
derived from the selected zone and the value is clamped when the zone changes.
The previous fixed T0–T8 list offered four tiers that exist on no zone at all,
and three more that exist on no dungeon. (The upstream webpack UI agrees: its
select is T0–T5 and it disables T3+ when the dungeon toggle is on.)

## The sweep

Full grid: 11 planets × 6 tiers + 4 dungeons × 3 tiers = **78 combinations**.

```
HeaderControls ──"All Zones"──▶ AllZonesModal        (grid: rows = zones, columns = T0…T5)
                                      │ Run sweep
                                      ▼
App.handleRunAllZones ──▶ useAllZones ──▶ workers/allZonesWorker.js   (pool)
                                                   │  N × new Worker(src/worker.js)
                                                   ▼
                              summariseZoneRun(simResult) per combination
                                                   │  streamed, one row at a time
                                                   ▼
                                         AllZonesResults  (sortable table, CSV)
```

- **The party is the party.** The sweep sends exactly the DTOs, community buffs,
  seals and guild shrine levels a single Run would send. It is the same
  simulation done many times, not a different one. The party *fights* together;
  the table *reports* one member at a time — see below.
- **Hours are its own.** 24 by default rather than the header's 100: a sweep
  multiplies its duration by 78. A day of simulated combat is already thousands
  of encounters on any zone a build can clear.
- **Pool size** defaults to `hardwareConcurrency − 1`. On a 14-core machine the
  full 78-combination sweep at 3 h each finishes in about 3 seconds; at 24 h,
  under a minute.

### Why not upstream's `multiWorker.js`

It already has a `start_simulation_all_zones` handler, and it is not reused:

1. **Guild buffs.** It forwards players, zone, extra and the time limit — but not
   `guildBuffs`. Every other path in this UI ships the character's shrine levels,
   and a sweep that silently dropped them would rank zones for a character nobody
   has.
2. **Streaming.** It collects everything and posts one array at the end.
   `allZonesWorker` posts each row as it lands, so the table fills as it goes and
   a cancelled sweep keeps what it measured.
3. **Fault tolerance.** One thrown simulation rejects its whole `Promise.all`
   there. Here a failed combination becomes a row with an `error` and the sweep
   carries on — a build that cannot survive T5 Infernal Abyss should cost you
   that row, not the other seventy-seven. A shard that goes *silent* for 90s
   (the browser declining to start yet another nested worker under memory
   pressure, where `new Worker` neither throws nor fires `onerror`) is abandoned
   the same way; without that bound, one wedged runner would hold the sweep open
   forever and the user would wait out every other combination before being told
   it stalled.

Upstream's file is left untouched, per the engine-boundary rule in
[`ui/README.md`](./ui/README.md).

### What crosses the worker boundary

`summariseZoneRun` (in [`ui/src/utils/allZones.js`](./ui/src/utils/allZones.js))
runs **inside the shard**. A full `simResult` carries per-ability attack tallies,
drop tables and optional HP/MP time series — tens of kilobytes each, 78 of them,
structured-cloned to render a handful of numbers. Only that handful makes the
crossing: the encounter and dungeon counts, `experienceByPlayer`,
`deathsByPlayer`, and `consumablesUsed`, which is small, already per-player, and
needed for the effective rates.

Experience and deaths cross as **maps keyed by player hrid**, not as party
totals — five small numbers where there was one. That is a rounding error next
to a `simResult`, and it is what lets the P-tab change whose figures the table
shows without re-running anything.

That module imports nothing, deliberately: pulling in `utils/prices.js` would
drag `openableLootDropMap.json` into the worker bundle.

## The table

### One player, never the party summed

The table answers for **the player selected in the left panel** — the P-tab
whose configuration is open — and the badge beside the title says which. Every
per-character column is that member alone.

Party figures are not added together, because a party is five separate
characters and the sum belongs to none of them: they train different skills at
different rates, eat different food, and die at different rates. A combined XP/h
is dominated by whoever is strongest, so it would rank zones for a composite
nobody plays — and worse, it moves when a party member is added who is not the
character being kitted out. The sweep still simulates the whole party, because
who else is in the fight changes what every member achieves; only the *reporting*
narrows to one.

Switching the P-tab re-derives the table from rows already measured. The sweep
does not run again, exactly as changing the price source does not.

If the selected tab is a character who was **not in the swept party**, the table
falls back to the first member who was, and says so in a notice — a blank table
reads as a broken one. Ticking that character into the party and re-running is
the fix, and the notice says that too.

| Column | Meaning | Whose |
|---|---|---|
| Enc/h | Encounters per hour of combat | Party — every member fights all of them, so it is this player's figure too |
| Effective enc/h | …per hour of **total** time: combat plus the production owed for what **this player** ate | Selected player |
| XP/h | Experience across all of **this player's** skills, per combat hour | Selected player |
| Effective XP/h | The same, on the real clock | Selected player |
| Deaths/h | **This player's** deaths (monster deaths are excluded) | Selected player |
| Clears/h | Dungeon completions — column appears only when a dungeon is in the results | Party |

Each character cooks their own supper, so the effective columns charge a member
only what **they** consumed. Charging one member's production time against
another's throughput is the party sum wearing a different hat.

Sort by any column; the best value in each rate column stays highlighted whatever
the sort. "Export CSV" writes the table as sorted, to
`csim-all-zones-P<n>.csv` — the player is part of what the file means, since two
exports of one sweep for two members are different tables with identical
columns.

**Effective rates need time-denominated prices.** Only the iron (cow webapp)
price source yields seconds, and seconds are the only unit commensurable with
combat time. When things *were* consumed and none of them could be priced, the
effective columns read "—" rather than printing a figure equal to the raw one,
which would say *your food is free* when it means *we have no idea*. The
arithmetic is the shared `shared/consumableCost.js`, the same code the
single-zone results and the trigger optimiser rank on.

**Ate nothing is not the same as cannot price it.** A zone where the build never
had to eat owes no production time, so its effective rate *is* its raw rate —
that is a fact, not a guess, and `summariseConsumableCost` now says so
(`nothingConsumed`). Reporting it as unknown was actively wrong in a ranking: the
zones a build survives without eating sank to the bottom of the "effective" sort,
below zones that eat constantly, and the best-value highlight went to a costlier
zone. A build with no food slotted at all saw every row blank, under an alert
advising it to fetch prices that could not have helped.

Rates are recomputed from whatever pricing is loaded **now**, not from what was
loaded when the sweep ran: fetch your iron times afterwards and the columns fill
in without re-running anything.

## Files

| File | Role |
|---|---|
| `ui/src/utils/zones.js` | Zone taxonomy: what is simulable, tier ceilings, hrid coercion |
| `ui/src/utils/allZones.js` | Combination keys, run summarisation, estimate, persistence (worker-safe) |
| `ui/src/workers/allZonesWorker.js` | The pool: one `src/worker.js` shard per combination |
| `ui/src/hooks/useAllZones.js` | Worker lifecycle, progress, buffered row streaming, watchdog, cancel, the swept party (`meta.playerHrids`) |
| `ui/src/components/AllZonesModal.jsx` | The zone × tier grid, hours, pool size, estimate |
| `ui/src/components/AllZonesResults.jsx` | Sortable table, per-player figures, effective-rate derivation, CSV export |
| `ui/src/hooks/useGameData.js` | Zone list enriched with category / maxSpawnCount / maxDifficulty |
| `ui/src/components/HeaderControls.jsx` | Filtered zone select, data-driven tiers, the button |

## Persistence

Selection, hours and pool size are written to `localStorage` under
`csim_all_zones` on every change and restored on load — the grid you ticked is
the grid you come back to, dungeons included.

An **empty** selection is a deliberate state and is preserved as one. Only a
missing key (a first visit, or a session predating the feature) selects
everything; a stored `[]` reopens empty, with the run button disabled and the
grid saying so. The distinction is `selection: null` vs `selection: []` in
`loadAllZonesState` — collapsing the two would make "clear" impossible to mean.

The stored selection is **validated, not trusted**, on the way to the engine:
unknown hrids and tiers past a zone's ceiling are dropped, because the engine
scales monsters by formula rather than by table and would otherwise return a
plausible-looking row for a difficulty the game does not offer. The modal counts
the same validated set, so its "N combinations" cannot promise runs that will not
happen.

### The session store this uncovered

Fixing this feature's persistence exposed that the app's *own* session auto-save
(`csim_player_data` — party, levels, equipment, zone, tier, duration) had never
worked. `ImportExport` declared its save effect above its restore effect, and
effects run in declaration order: every mount wrote the blank defaults over the
stored session, and the restore beneath then read back the emptiness it had just
been handed. Guarding the save with a ref fixes production but not development,
where StrictMode's second mount runs the save after the guard is set and before
the restore's state has landed.

The session is now read in `App`'s state initialisers (`utils/session.js`), which
is how every other persisted slice here already works — the guild-trial roster,
both optimiser configs, this sweep. There is no ordering left to get wrong.
Verified: Twilight Zone T3 / 42 h / party [1,2] / P1 attack 77 stored, reloaded,
and all of it came back.

Verified across a full page reload: three hand-picked cells (planet and dungeon),
7 hours and 4 workers came back exactly, and a cleared grid came back cleared.
