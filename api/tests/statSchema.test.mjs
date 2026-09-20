// =============================================================================
// The test that makes tools/genStatSchema.mjs safe to trust.
//
// Three separate questions, deliberately not conflated:
//
//  1. Is the committed generated file what the generator produces RIGHT NOW?
//     Byte for byte, so a hand edit or a stale checkout fails loudly.
//  2. Do the generated routines do exactly what the keyed loops they replace
//     did? Differentially, against the real game data, not against a
//     re-statement of the same expectation.
//  3. Is the hand-maintained role list still COMPLETE with respect to the game
//     data? This is the question that was answered wrongly once before, when a
//     scrape dropped hpRegenPer10/mpRegenPer10 and moved kills/hr by 2%.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as gen from "../../tools/genStatSchema.mjs";
import {
    EQUIPMENT_STAT_COUNT,
    MONSTER_ZEROED_STAT_COUNT,
    copyEquipmentTotals,
    makeEquipmentTotals,
    zeroMissingMonsterStats,
} from "../../src/combatsimulator/generated/statSchema.js";
import { EQUIPMENT_COMBAT_STATS } from "../../src/combatsimulator/player.js";
import { MONSTER_ZEROED_COMBAT_STATS } from "../../src/combatsimulator/monster.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(ROOT, "src/combatsimulator/data");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// ---- 1. the file on disk is the file the generator makes --------------------

test("generated/statSchema.js is byte-for-byte what the generator produces", () => {
    const onDisk = fs.readFileSync(gen.OUT_PATH, "utf8");
    assert.strictEqual(
        gen.generate(),
        onDisk,
        "src/combatsimulator/generated/statSchema.js is stale or hand-edited — " +
            "regenerate with `node tools/genStatSchema.mjs`"
    );
});

test("extractList keeps DIGIT-bearing names", () => {
    const src = 'const X = [\n    "hpRegenPer10",\n    "mpRegenPer10",\n    "armor",\n];';
    assert.deepStrictEqual(gen.extractList(src, "X"), ["hpRegenPer10", "mpRegenPer10", "armor"]);
});

test("extractList is bounded by its own closing bracket", () => {
    const src = 'const A = [\n    "one",\n];\nconst B = [\n    "two",\n];';
    assert.deepStrictEqual(gen.extractList(src, "A"), ["one"]);
    assert.deepStrictEqual(gen.extractList(src, "B"), ["two"]);
});

test("extractList refuses a duplicate, a missing list and an unterminated one", () => {
    assert.throws(() => gen.extractList('const X = [\n"a",\n"a",\n];', "X"), /Duplicate/);
    assert.throws(() => gen.extractList("const X = [];", "Y"), /not found/);
    assert.throws(() => gen.extractList('const X = [\n"a",', "X"), /Unterminated/);
});

// ---- 2. the generated routines match the loops they replace ------------------

test("the generated counts match the lists the engine declares", () => {
    assert.strictEqual(EQUIPMENT_STAT_COUNT, EQUIPMENT_COMBAT_STATS.length);
    assert.strictEqual(MONSTER_ZEROED_STAT_COUNT, MONSTER_ZEROED_COMBAT_STATS.length);
    assert.strictEqual(EQUIPMENT_STAT_COUNT, 70);
    assert.strictEqual(MONSTER_ZEROED_STAT_COUNT, 63);
});

test("copyEquipmentTotals writes exactly what the keyed loop wrote", () => {
    const totals = makeEquipmentTotals();
    let n = 1;
    for (const stat of EQUIPMENT_COMBAT_STATS) totals[stat] = n++ * 0.5;

    const viaLoop = {};
    for (let i = 0; i < EQUIPMENT_COMBAT_STATS.length; i++) {
        const stat = EQUIPMENT_COMBAT_STATS[i];
        viaLoop[stat] = totals[stat];
    }
    const viaGenerated = {};
    copyEquipmentTotals(viaGenerated, totals);

    assert.deepStrictEqual(Object.keys(viaGenerated), Object.keys(viaLoop));
    assert.deepStrictEqual(viaGenerated, viaLoop);
});

test("makeEquipmentTotals declares every name the copy reads, and nothing else", () => {
    assert.deepStrictEqual(Object.keys(makeEquipmentTotals()), [...EQUIPMENT_COMBAT_STATS]);
});

test("zeroMissingMonsterStats matches the keyed loop on EVERY real monster block", () => {
    const monsters = readJson("combatMonsterDetailMap.json");
    const hrids = Object.keys(monsters);
    assert.ok(hrids.length > 90, "expected the full bestiary, got " + hrids.length);

    let checked = 0;
    for (const hrid of hrids) {
        const gameStats = monsters[hrid].combatDetails?.combatStats;
        if (!gameStats) continue;

        const viaLoop = {};
        for (let i = 0; i < MONSTER_ZEROED_COMBAT_STATS.length; i++) {
            const stat = MONSTER_ZEROED_COMBAT_STATS[i];
            if (gameStats[stat] == null) viaLoop[stat] = 0;
        }
        const viaGenerated = {};
        zeroMissingMonsterStats(viaGenerated, gameStats);

        assert.deepStrictEqual(Object.keys(viaGenerated), Object.keys(viaLoop), hrid);
        assert.deepStrictEqual(viaGenerated, viaLoop, hrid);
        checked++;
    }
    assert.ok(checked > 90, "checked only " + checked + " monster blocks");
});

test("zeroMissingMonsterStats treats an explicit null as absent, as upstream did", () => {
    const gameStats = { armor: null, tenacity: 0 };
    const out = {};
    zeroMissingMonsterStats(out, gameStats);
    assert.strictEqual(out.armor, 0, "an explicit null must be treated as absent");
    assert.ok(!("tenacity" in out), "a declared 0 must NOT be overwritten");
});

// ---- 3. the role list is still complete with respect to the game data --------

// Numeric item stats the equipment sum deliberately does NOT cover, each with
// the reason it is excluded. A new game stat that nobody adds to
// EQUIPMENT_COMBAT_STATS will fail the test below rather than silently
// contributing nothing — which is the failure mode that has already cost this
// project a 2% error in kills/hr.
const DELIBERATELY_UNSUMMED = new Map([
    ["attackInterval", "sourced from the weapon in Player.updateCombatDetails, not summed"],
    ["foodSlots", "sourced from the pouch, and defaults to 1 rather than 0"],
    ["drinkSlots", "sourced from the pouch, and defaults to 1 rather than 0"],
]);

test("every numeric stat any item grants is summed, or is named as excluded", () => {
    const items = readJson("itemDetailMap.json");
    const numeric = new Set();
    for (const hrid of Object.keys(items)) {
        const stats = items[hrid].equipmentDetail?.combatStats;
        if (!stats) continue;
        for (const [stat, value] of Object.entries(stats)) {
            if (typeof value === "number") numeric.add(stat);
        }
    }
    const covered = new Set(EQUIPMENT_COMBAT_STATS);
    const missing = [...numeric].filter((s) => !covered.has(s) && !DELIBERATELY_UNSUMMED.has(s));
    assert.deepStrictEqual(
        missing.sort(),
        [],
        "the game data grants these stats but no equipment sum collects them — " +
            "add them to EQUIPMENT_COMBAT_STATS in player.js, or to " +
            "DELIBERATELY_UNSUMMED here with the reason"
    );
});

test("the digit-bearing regen stats survived, in both lists", () => {
    for (const stat of ["hpRegenPer10", "mpRegenPer10"]) {
        assert.ok(EQUIPMENT_COMBAT_STATS.includes(stat), stat + " missing from EQUIPMENT_COMBAT_STATS");
        assert.ok(MONSTER_ZEROED_COMBAT_STATS.includes(stat), stat + " missing from MONSTER_ZEROED_COMBAT_STATS");
        const generated = fs.readFileSync(gen.OUT_PATH, "utf8");
        assert.ok(generated.includes("." + stat + " ="), stat + " missing from the generated copy");
    }
});

test("every stat the monster zero-fill covers is also one the equipment sum covers", () => {
    const covered = new Set(EQUIPMENT_COMBAT_STATS);
    const stray = MONSTER_ZEROED_COMBAT_STATS.filter((s) => !covered.has(s));
    assert.deepStrictEqual(stray, [], "monster zero-fill names not in EQUIPMENT_COMBAT_STATS");
});
