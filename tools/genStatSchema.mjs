// =============================================================================
// genStatSchema — collect(): the combat-stat role lists for rust/src/generated.rs
// (tools/genRustTables.mjs). EQUIPMENT_COMBAT_STATS and MONSTER_ZEROED_COMBAT_STATS
// are engine semantics, read from tools/engineTables.json (not derivable from the
// game data: five equipment stats are granted by no item, and attackInterval,
// foodSlots and drinkSlots come from the weapon and pouch instead). The residual
// monster stats are derived from the bestiary.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The role lists, once read from player.js / monster.js, now live here (engine-retirement G9).
export const TABLES_PATH = path.join(ROOT, "tools/engineTables.json");
const DATA_DIR = path.join(ROOT, "src/combatsimulator/data");

/**
 * Every stat key any monster's game-data block carries that is NOT in the
 * zero-fill list. Derived structurally from the bestiary, sorted, because these
 * are the keys whose semantics is "write only when present" — the zero-fill
 * list's own names mean "write the value, or 0". A key that appeared in a data
 * update and was missed here would be silently dropped from every monster, so
 * api/tests/rustTables.test.mjs asserts the union covers every block.
 */
export function collectResidualMonsterStats(zeroed) {
    const zeroedSet = new Set(zeroed);
    const monsters = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, "combatMonsterDetailMap.json"), "utf8")
    );
    const residual = new Set();
    for (const hrid of Object.keys(monsters)) {
        const stats = monsters[hrid].combatDetails?.combatStats;
        if (!stats) continue;
        for (const stat of Object.keys(stats)) {
            if (!zeroedSet.has(stat)) residual.add(stat);
        }
    }
    return [...residual].sort();
}

export function collect() {
    const tables = JSON.parse(fs.readFileSync(TABLES_PATH, "utf8"));
    const monsterZeroed = tables.MONSTER_ZEROED_COMBAT_STATS;
    return {
        equipment: tables.EQUIPMENT_COMBAT_STATS,
        monsterZeroed,
        monsterResidual: collectResidualMonsterStats(monsterZeroed),
    };
}
