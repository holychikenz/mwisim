// =============================================================================
// A target killed by an attack does not reflect damage (thorns or retaliation)
// back at the attacker. This is an assumption we chose, not something checked
// against the live game: see the note in combatUtilities.js processAttack().
//
// Run from api/:  npm test
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import CombatUtilities from '../../src/combatsimulator/combatUtilities.js';

function unit({ hp, thorns = 0, retaliation = 0, maxDamage = 100 }) {
    return {
        isPlayer: false,
        isWeakened: false,
        combatDetails: {
            currentHitpoints: hp,
            maxHitpoints: hp,
            smashAccuracyRating: 1e9,
            smashMaxDamage: maxDamage,
            smashEvasionRating: 1,
            defensiveMaxDamage: 1000,
            totalArmor: 0,
            combatStats: {
                combatStyleHrid: '/combat_styles/smash',
                damageType: '/damage_types/physical',
                physicalAmplify: 0,
                armorPenetration: 0,
                physicalThorns: thorns,
                retaliation,
                criticalRate: 0,
                criticalDamage: 0,
                damageTaken: 0,
                autoAttackDamage: 0,
                abilityDamage: 0,
                taskDamage: 0,
                lifeSteal: 0,
                manaLeech: 0,
            },
        },
    };
}

test('R1 a killing blow draws no thorns or retaliation', () => {
    for (let i = 0; i < 50; i++) {
        const attacker = unit({ hp: 1 });
        const target = unit({ hp: 1, thorns: 5, retaliation: 5 });
        const r = CombatUtilities.processAttack(attacker, target);
        assert.equal(target.combatDetails.currentHitpoints, 0, 'target dies');
        assert.equal(r.thornDamageDone, 0);
        assert.equal(r.retaliationDamageDone, 0);
        assert.equal(attacker.combatDetails.currentHitpoints, 1, 'attacker survives');
    }
});

test('R2 a target that survives still reflects', () => {
    const attacker = unit({ hp: 1e9, maxDamage: 1 });
    const target = unit({ hp: 1e9, thorns: 5, retaliation: 5 });
    let thorns = 0;
    let retaliation = 0;
    for (let i = 0; i < 50; i++) {
        const r = CombatUtilities.processAttack(attacker, target);
        thorns += r.thornDamageDone;
        retaliation += r.retaliationDamageDone;
    }
    assert.ok(thorns > 0, 'thorns still fire on a surviving target');
    assert.ok(retaliation > 0, 'retaliation still fires on a surviving target');
});
