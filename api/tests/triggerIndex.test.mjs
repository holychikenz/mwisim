// =============================================================================
// The test that makes tools/genTriggerIndex.mjs safe to trust. Same three
// questions as api/tests/buffTypes.test.mjs and api/tests/statSchema.test.mjs:
// is the committed file current, is the extraction free of a character-class
// bug, and is the table complete with respect to the game data and the engine?
//
// The fourth question is this table's own: does every entry equal the string
// the concatenation it replaces would have produced? That is checked against
// the transformation itself, not against a re-typed expectation.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as gen from "../../tools/genTriggerIndex.mjs";
import {
    BUFF_UNIQUE_BY_CONDITION,
    TRIGGER_CONDITION_COUNT,
} from "../../src/combatsimulator/generated/triggerIndex.js";
import Trigger from "../../src/combatsimulator/trigger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(ROOT, "src/combatsimulator/data");

test("generated/triggerIndex.js is byte-for-byte what the generator produces", () => {
    assert.strictEqual(
        gen.generate(),
        fs.readFileSync(gen.OUT_PATH, "utf8"),
        "src/combatsimulator/generated/triggerIndex.js is stale or hand-edited — " +
            "regenerate with `node tools/genTriggerIndex.mjs`"
    );
});

test("every entry equals what the concatenation it replaces would build", () => {
    for (const [condition, buffUnique] of Object.entries(BUFF_UNIQUE_BY_CONDITION)) {
        assert.strictEqual(buffUnique, gen.buffUniqueHridFor(condition), condition);
    }
});

test("scanHrids keeps DIGIT-bearing condition names", () => {
    const found = gen.scanHrids('x("/combat_trigger_conditions/coffee_2"); y("/combat_trigger_conditions/plain");');
    assert.deepStrictEqual(found, [
        "/combat_trigger_conditions/coffee_2",
        "/combat_trigger_conditions/plain",
    ]);
});

test("walkJson finds conditions at any depth, in keys as well as values", () => {
    const found = gen.walkJson(
        { a: [{ b: "/combat_trigger_conditions/one" }], "/combat_trigger_conditions/two": 1 },
        new Set()
    );
    assert.deepStrictEqual(
        [...found].sort(),
        ["/combat_trigger_conditions/one", "/combat_trigger_conditions/two"]
    );
});

test("the table covers every condition the game data declares", () => {
    const conditions = JSON.parse(
        fs.readFileSync(path.join(DATA, "combatTriggerConditionDetailMap.json"), "utf8")
    );
    const missing = Object.keys(conditions).filter((c) => !(c in BUFF_UNIQUE_BY_CONDITION));
    assert.deepStrictEqual(missing, [], "regenerate with `node tools/genTriggerIndex.mjs`");
});

test("the table covers every condition trigger.js names as a literal", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/combatsimulator/trigger.js"), "utf8");
    const named = [...new Set(gen.scanHrids(src))];
    assert.ok(named.length > 40, "expected trigger.js to name many conditions, found " + named.length);
    const missing = named.filter((c) => !(c in BUFF_UNIQUE_BY_CONDITION));
    assert.deepStrictEqual(missing, []);
});

test("the table is sorted, counted and null-prototype", () => {
    const keys = Object.keys(BUFF_UNIQUE_BY_CONDITION);
    assert.deepStrictEqual(keys, [...keys].sort());
    assert.strictEqual(keys.length, TRIGGER_CONDITION_COUNT);
    assert.strictEqual(Object.getPrototypeOf(BUFF_UNIQUE_BY_CONDITION), null);
    assert.strictEqual(BUFF_UNIQUE_BY_CONDITION["constructor"], undefined);
});

// Unlike buffTypeOrdinal, an unseen condition must NOT throw: api/lib/triggerSearch
// builds Trigger objects speculatively, and the fallback computes the identical
// string rather than turning a speculative trigger into a crash.
test("an unseen condition falls back to the identical string, and does not throw", () => {
    const unseen = "/combat_trigger_conditions/not_a_real_condition_9";
    assert.ok(!(unseen in BUFF_UNIQUE_BY_CONDITION));
    const trigger = new Trigger("/combat_trigger_dependencies/self", unseen, "/combat_trigger_comparators/equal", 0);
    assert.strictEqual(trigger.buffUniqueHrid, gen.buffUniqueHridFor(unseen));
    assert.strictEqual(trigger.buffUniqueHrid, "/buff_uniques/not_a_real_condition_9");
});

test("a real condition takes the table's interned string, not a fresh one", () => {
    const condition = "/combat_trigger_conditions/fury";
    const a = new Trigger("/combat_trigger_dependencies/self", condition, "/combat_trigger_comparators/equal", 0);
    const b = new Trigger("/combat_trigger_dependencies/self", condition, "/combat_trigger_comparators/equal", 0);
    assert.strictEqual(a.buffUniqueHrid, BUFF_UNIQUE_BY_CONDITION[condition]);
    assert.strictEqual(a.buffUniqueHrid, b.buffUniqueHrid);
});
