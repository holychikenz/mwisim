// =============================================================================
// The prefix-buff branch of Trigger.getDependencyValue used to read
//
//     Object.keys(source.combatBuffs).filter(b => b.startsWith(prefix))[0]
//
// and now walks the same object with for...in, returning the first match. That
// is the one hazard in this round worth a test of its own: the two forms agree
// only if for...in visits the keys in Object.keys order and the FIRST match is
// therefore the same object. If they ever diverge, a different buff is read and
// the simulation reports a plausible wrong number with no error anywhere.
//
// So this is a differential test against the retired form, including the cases
// that decide it: several buffs sharing a prefix, a prefix that is a prefix of
// another key, insertion order that is not sorted order, and no match at all.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert";

import Trigger from "../../src/combatsimulator/trigger.js";

const CONDITION = "/combat_trigger_conditions/fury";
const PREFIX = "/buff_uniques/fury";

function makeTrigger(conditionHrid = CONDITION) {
    return new Trigger(
        "/combat_trigger_dependencies/self",
        conditionHrid,
        "/combat_trigger_comparators/greater_than_equal",
        0
    );
}

// The form that was replaced, kept here as the reference implementation.
function retiredForm(combatBuffs, prefix) {
    const buffs = Object.keys(combatBuffs).filter((b) => b.startsWith(prefix));
    return combatBuffs[buffs?.[0]];
}

const CASES = [
    ["no buffs at all", {}],
    ["one exact match", { "/buff_uniques/fury": { id: 1 } }],
    ["one suffixed match", { "/buff_uniques/fury_2": { id: 2 } }],
    ["two matches, sorted insertion", { "/buff_uniques/fury": { id: 1 }, "/buff_uniques/fury_2": { id: 2 } }],
    ["two matches, reversed insertion", { "/buff_uniques/fury_2": { id: 2 }, "/buff_uniques/fury": { id: 1 } }],
    ["match preceded by a non-match", { "/buff_uniques/armor": { id: 9 }, "/buff_uniques/fury_3": { id: 3 } }],
    ["match followed by a non-match", { "/buff_uniques/fury_4": { id: 4 }, "/buff_uniques/armor": { id: 9 } }],
    ["near miss only", { "/buff_uniques/fur": { id: 8 }, "/buff_uniques/furious": { id: 7 } }],
    ["three matches", { "/buff_uniques/fury_c": { id: 3 }, "/buff_uniques/fury_a": { id: 1 }, "/buff_uniques/fury_b": { id: 2 } }],
];

test("the allocation-free prefix scan returns exactly what the filter returned", () => {
    const trigger = makeTrigger();
    for (const [label, combatBuffs] of CASES) {
        const expected = retiredForm(combatBuffs, PREFIX);
        const actual = trigger.getDependencyValue({ combatBuffs }, 0);
        assert.strictEqual(actual, expected, label);
    }
});

test("a deletion does not disturb which buff is chosen", () => {
    const trigger = makeTrigger();
    const combatBuffs = {
        "/buff_uniques/fury_a": { id: 1 },
        "/buff_uniques/fury_b": { id: 2 },
        "/buff_uniques/fury_c": { id: 3 },
    };
    delete combatBuffs["/buff_uniques/fury_a"];
    combatBuffs["/buff_uniques/fury_a"] = { id: 4 };
    assert.strictEqual(
        trigger.getDependencyValue({ combatBuffs }, 0),
        retiredForm(combatBuffs, PREFIX),
        "re-inserting a key must move both forms identically"
    );
});

test("no match yields undefined, as indexing by undefined did", () => {
    const trigger = makeTrigger();
    const combatBuffs = { "/buff_uniques/armor": { id: 9 } };
    assert.strictEqual(trigger.getDependencyValue({ combatBuffs }, 0), undefined);
    assert.strictEqual(retiredForm(combatBuffs, PREFIX), undefined);
});

// ---- the hoisted constants ---------------------------------------------------

test("buffUniqueHrid is what the concatenation built, for both buff groups", () => {
    const cases = [
        ["/combat_trigger_conditions/berserk", "/buff_uniques/berserk"],
        ["/combat_trigger_conditions/attack_coffee", "/buff_uniques/attack_coffee"],
        ["/combat_trigger_conditions/fury", "/buff_uniques/fury"],
        ["/combat_trigger_conditions/invincible_water_resistance", "/buff_uniques/invincible_water_resistance"],
    ];
    for (const [condition, expected] of cases) {
        const built = "/buff_uniques" + condition.slice(condition.lastIndexOf("/"));
        assert.strictEqual(built, expected, "the reference construction itself");
        assert.strictEqual(makeTrigger(condition).buffUniqueHrid, expected, condition);
    }
});

test("an unknown dependency still throws from isActive, not from the constructor", () => {
    // Deliberate: api/lib/triggerSearch builds Trigger objects speculatively,
    // and a trigger that is never evaluated must not bring the process down.
    let trigger;
    assert.doesNotThrow(() => {
        trigger = new Trigger("/combat_trigger_dependencies/nonsense", CONDITION, "/combat_trigger_comparators/equal", 0);
    }, "constructing a trigger with an unknown dependency must not throw");
    assert.strictEqual(trigger.dependencyDetail, undefined);
    assert.throws(() => trigger.isActive({}, null, [], [], 0), TypeError);
});

test("the dependency detail is the map entry the lookup used to fetch", () => {
    const trigger = makeTrigger();
    assert.strictEqual(trigger.dependencyDetail.isSingleTarget, true);
});
