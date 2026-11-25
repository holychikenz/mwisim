// =============================================================================
// genTriggerKinds — collect(): the condition-hrid -> condition-KIND table for
// rust/src/generated.rs (tools/genRustTables.mjs). The grouping (which conditions
// read their buff by EXACT hrid, which by PREFIX, and the scalar kinds) is engine
// semantics, read from tools/engineTables.json, not guessed from the game data.
// The table is sorted, kinds come from a sort of their names, and a condition in
// two groups is an error, not a silent last-wins. lowest_hp_percentage,
// number_of_active_units and number_of_dead_units are multi-target conditions,
// handled elsewhere, so they are legitimately absent.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collect() {
    // The grouping lists, once read from trigger.js, now live in tools/engineTables.json (engine-retirement G9).
    const tables = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/engineTables.json"), "utf8"));
    const exact = tables.EXACT_BUFF_CONDITIONS;
    const prefix = tables.PREFIX_BUFF_CONDITIONS;
    const scalars = Object.entries(tables.SCALAR_CONDITION_KINDS);

    const byCondition = new Map();
    const assign = (hrid, kind) => {
        if (byCondition.has(hrid)) {
            throw new Error(`${hrid} is in two groups: ${byCondition.get(hrid)} and ${kind}`);
        }
        byCondition.set(hrid, kind);
    };
    for (const hrid of exact) assign(hrid, "EXACT_BUFF");
    for (const hrid of prefix) assign(hrid, "PREFIX_BUFF");
    for (const [hrid, kind] of scalars) assign(hrid, kind);

    // Ordinals from a sort of the NAMES, never from discovery order.
    const kinds = [...new Set(byCondition.values())].sort();
    return { kinds, conditions: [...byCondition.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}
