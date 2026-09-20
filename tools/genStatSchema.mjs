#!/usr/bin/env node
// =============================================================================
// Generates src/combatsimulator/generated/statSchema.js — straight-line copy
// routines over the combat-stat block, compiled from the role lists the engine
// declares.
//
// WHY. Measured on node 26.8.2, a keyed store `obj[nameString] = v` costs about
// 21.5 ns once the loop touches more than one name: V8's keyed inline cache
// goes megamorphic and stays there, and the cost is flat per access however
// many names follow. The same store written as `obj.stabAccuracy = v` costs
// about 0.35 ns. The engine performs 844 458 such keyed accesses per simulated
// dungeon hour, in two loops — player.js's equipment-total copy (70 names) and
// monster.js's zero-fill (63) — which is 18.2 ms of a 132 ms hour. Compiling
// those two loops into straight-line field code is the same work, the same
// values, in the same order, for 0.3 ms.
//
// WHY GENERATED, NOT TYPED. The lists are 70 and 63 names long and this
// codebase has already had a hand-maintained stat list silently corrupted once
// — a scrape whose character class dropped the two DIGIT-carrying names
// (hpRegenPer10, mpRegenPer10) and moved kills/hr by 2%. Typing the same 133
// names out a second time, by hand, in a second place, is how that happens
// again. So: read the lists the engine already declares, compile them, commit
// the output, and let api/tests/statSchema.test.mjs re-run this generator and
// compare BYTE FOR BYTE. That test is what makes generation safe.
//
// Three deliberate choices:
//
//  * The role lists are READ FROM THE ENGINE SOURCE, not re-derived from the
//    game data. That was tried first and it is wrong: five names in
//    EQUIPMENT_COMBAT_STATS (combatDropQuantity, elementalThorns,
//    physicalAmplify, physicalThorns, retaliation) are granted by no item in
//    itemDetailMap, and three numeric item stats (attackInterval, foodSlots,
//    drinkSlots) are deliberately absent because the engine sources them from
//    the weapon and the pouch instead. The lists encode engine semantics, not
//    data. Compiling them keeps the generated code identical to the loop it
//    replaces BY CONSTRUCTION; deriving them would have changed behaviour.
//
//  * The extractor's pattern is [A-Za-z0-9_]+ and DIGITS ARE IN THE CLASS.
//    extractList is exported so the test can prove that against a synthetic
//    digit-bearing name rather than anyone eyeballing the regex.
//
//  * Names are emitted in SOURCE ORDER, not sorted. A copy over distinct keys
//    has no summation order to disturb, so order cannot move a number — but
//    emitting in source order makes the generated file diffable against the
//    list it came from, which is the property a reviewer actually needs.
//
// Usage:  node tools/genStatSchema.mjs          # write the generated file
//         node tools/genStatSchema.mjs --stdout # print it, write nothing
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = path.join(ROOT, "src/combatsimulator");
const OUT_PATH = path.join(ROOT, "src/combatsimulator/generated/statSchema.js");

// Digits ARE in the class. See the header.
const NAME_PATTERN = /"([A-Za-z0-9_]+)"/g;

/**
 * Pull a `const NAME = [ "a", "b", ... ];` array of string literals out of a
 * blob of source text. Bounded by the closing bracket so a later array in the
 * same file cannot bleed in.
 */
export function extractList(text, constName) {
    const start = text.indexOf(constName + " = [");
    if (start === -1) throw new Error("List not found in source: " + constName);
    const end = text.indexOf("];", start);
    if (end === -1) throw new Error("Unterminated list: " + constName);
    const body = text.slice(start, end);
    const names = [...body.matchAll(NAME_PATTERN)].map((m) => m[1]);
    if (names.length === 0) throw new Error("Empty list: " + constName);
    const seen = new Set();
    for (const name of names) {
        if (seen.has(name)) throw new Error("Duplicate name in " + constName + ": " + name);
        seen.add(name);
    }
    return names;
}

export function collect() {
    const playerSrc = fs.readFileSync(path.join(ENGINE_DIR, "player.js"), "utf8");
    const monsterSrc = fs.readFileSync(path.join(ENGINE_DIR, "monster.js"), "utf8");
    return {
        equipment: extractList(playerSrc, "EQUIPMENT_COMBAT_STATS"),
        monsterZeroed: extractList(monsterSrc, "MONSTER_ZEROED_COMBAT_STATS"),
    };
}

export function render({ equipment, monsterZeroed }) {
    const L = [];
    L.push("// =============================================================================");
    L.push("// GENERATED FILE — DO NOT EDIT BY HAND.");
    L.push("//");
    L.push("// Produced by tools/genStatSchema.mjs; see that file for why these loops are");
    L.push("// compiled rather than typed, and api/tests/statSchema.test.mjs, which re-runs");
    L.push("// the generator and compares this file byte for byte. Regenerate with:");
    L.push("//");
    L.push("//     node tools/genStatSchema.mjs");
    L.push("//");
    L.push("// Every name below is emitted from the list the engine declares, in that");
    L.push("// list's own order, so each routine writes the same fields with the same");
    L.push("// values in the same sequence as the keyed loop it replaces.");
    L.push("//");
    L.push("// No comments inside the function bodies: V8's inlining budget is measured in");
    L.push("// SOURCE CHARACTERS, comments included, and these are the warmest routines in");
    L.push("// the engine. Explanations belong above the function, never within it.");
    L.push("// =============================================================================");
    L.push("");
    L.push("/** Count of names each routine covers, for the tests to assert against. */");
    L.push("export const EQUIPMENT_STAT_COUNT = " + equipment.length + ";");
    L.push("export const MONSTER_ZEROED_STAT_COUNT = " + monsterZeroed.length + ";");
    L.push("");
    L.push("/**");
    L.push(" * Copy the summed equipment totals into a unit's combatStats.");
    L.push(" * Replaces the 70-iteration keyed loop in Player.updateCombatDetails.");
    L.push(" */");
    L.push("export function copyEquipmentTotals(combatStats, totals) {");
    for (const n of equipment) L.push(`    combatStats.${n} = totals.${n};`);
    L.push("}");
    L.push("");
    L.push("/**");
    L.push(" * Build the equipment-total record. A literal so every totals object shares");
    L.push(" * one hidden class and copyEquipmentTotals reads it monomorphically, where");
    L.push(" * upstream's `{}` grown by keyed stores lands in dictionary mode.");
    L.push(" */");
    L.push("export function makeEquipmentTotals() {");
    L.push("    return {");
    for (const n of equipment) L.push(`        ${n}: 0,`);
    L.push("    };");
    L.push("}");
    L.push("");
    L.push("/**");
    L.push(" * Force to 0 every stat the monster's game-data block does not declare.");
    L.push(" * Replaces the 63-iteration keyed loop in Monster.updateCombatDetails. The");
    L.push(" * `== null` test is upstream's, kept verbatim: it treats an explicit null as");
    L.push(" * absent, which a `!== undefined` test would not.");
    L.push(" */");
    L.push("export function zeroMissingMonsterStats(combatStats, gameStats) {");
    for (const n of monsterZeroed) L.push(`    if (gameStats.${n} == null) combatStats.${n} = 0;`);
    L.push("}");
    L.push("");
    return L.join("\n");
}

export function generate() {
    return render(collect());
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const text = generate();
    if (process.argv.includes("--stdout")) {
        process.stdout.write(text);
    } else {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(OUT_PATH, text);
        const { equipment, monsterZeroed } = collect();
        process.stderr.write(
            `wrote ${path.relative(ROOT, OUT_PATH)} (${equipment.length} equipment, ${monsterZeroed.length} monster-zeroed)\n`
        );
    }
}

export { OUT_PATH };
