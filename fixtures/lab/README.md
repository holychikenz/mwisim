# Lab parity fixtures

Automated tracking of **simulator-vs-game** parity for the labyrinth. Each
fixture records the numbers you read **in the game** and the inputs needed to
recompute the **simulator's** numbers; `npm run lab:check` diffs them and exits
non-zero on any drift (so it can run in CI / after an upstream engine rebase).

Compares **DERIVED** stats (`totalArmor`, `attackLevel`, `maxHitpoints`, the
accuracy/damage/evasion ratings, …) — i.e. the buffed values the game's stat
sheet shows, not the unbuffed base. (That base-vs-derived distinction is what
tripped earlier "discrepancies"; this harness sidesteps it.)

## Commands (run from `csim/api`)

```bash
npm run lab:check                              # diff every fixture vs the simulator
npm run lab:record -- /monsters/cyclops 150    # scaffold a monster fixture
npm run lab:record -- /monsters/cyclops 150 "My label" --force   # overwrite
```

## Record from the game (Tampermonkey) — the primary path

The `lab-parity` userscript module captures the game's **live** lab stats and
writes a fixture for you — no hand-typing.

1. Run the loader server: `cd tampermonkey && uv run start-server.py` (it hosts
   the `POST /labparity/record` write endpoint on `:17645`).
2. In-game, enable **"Lab parity recorder"** in the MWIX command palette.
3. Enter a labyrinth combat room, then either click **"Record stub now"** in the
   module's settings or run `MWIX.kernel.labParity.record()` in the console.
4. It reads the game's own `combatUnit.combatDetails` (player) + the enemy unit
   (best-effort) + your DTO / crates / lab-shop upgrades, and POSTs a fixture
   here with `expected.source = "game"`.
5. `cd csim/api && npm run lab:check` — recomputes the simulator from the
   recorded inputs and diffs it against the game's numbers.

## Workflow (manual / scripted)

### Monster fixtures (deterministic — the common case)
1. `npm run lab:record -- /monsters/<name> <roomLevel>` writes
   `<name>.room<level>.json` with `expected.monster` **seeded from the
   simulator** (`"source": "sim-baseline"`).
2. Open the game, read the monster's actual lab stats, and **replace the
   numbers** in `expected.monster`. Set `expected.source` to `"game"`.
3. `npm run lab:check`. Green = parity; red = a real divergence to chase.

A `sim-baseline` fixture still passes (sim == sim), acting as a **regression
guard**: if a code change or data update shifts a stat, check goes red.

### Player fixtures (loadout-dependent — author by hand)
Add a `player` block with a full engine **DTO** plus the lab crates / shop
upgrades, and put the game's buffed numbers in `expected.player`:

```json
{
  "label": "My char — expert coffee @ cyclops room150",
  "monster": { "hrid": "/monsters/cyclops", "roomLevel": 150 },
  "player": {
    "dto": {
      "staminaLevel": 138, "intelligenceLevel": 138, "attackLevel": 138,
      "meleeLevel": 138, "defenseLevel": 138, "rangedLevel": 138, "magicLevel": 138,
      "hrid": "player1",
      "equipment": { "/equipment_types/main_hand": { "hrid": "/items/...", "enhancementLevel": 0 } },
      "food": [null, null, null], "drinks": [null, null, null],
      "abilities": [null, null, null, null],
      "houseRooms": { "/house_rooms/dojo": 7 },
      "achievements": {}, "debuffOnLevelGap": 0
    },
    "crates": ["/items/expert_coffee_crate", "/items/expert_food_crate"],
    "labUpgrades": { "combatDamage": 0, "attackSpeed": 0, "castSpeed": 0, "criticalRate": 0 }
  },
  "expected": {
    "source": "game",
    "player": { "attackLevel": 160, "defenseLevel": 153, "maxHitpoints": 1630 }
  }
}
```

The DTO is the same shape the UI sends to the worker (see
`ui/src/utils/characterToPlayer.js`). The player computation is verified to
match a full simulation's `playerStats` snapshot exactly.

## Fixture schema

| field | meaning |
|---|---|
| `monster.hrid` / `monster.roomLevel` | which lab monster + room level |
| `player.dto` | engine player DTO (levels, equipment, houseRooms, abilities) |
| `player.crates` | selected coffee / food / tea crate item hrids |
| `player.labUpgrades` | lab-shop upgrade levels (combatDamage / attackSpeed / castSpeed / criticalRate) |
| `tolerance.abs` / `tolerance.rel` | a stat passes if `|sim − expected| ≤ max(abs, rel·\|expected\|)` (default 0.5 / 0.5%) |
| `expected.source` | `"game"` (true parity) or `"sim-baseline"` (regression guard) |
| `expected.monster` / `expected.player` | the expected DERIVED stats; `expected.monster.abilities` is also checked |

> Scope: crate + lab-shop-upgrade buffs are modelled. Global buffs (community,
> Moo pass, personal seals) are **not** in the fixture inputs — record on a
> character without them, or add the expected delta yourself.
