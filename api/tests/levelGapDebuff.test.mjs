// audit-2 — the React UI computes the level-gap XP/drop debuff per party
// instead of importing the game's setting flag.
import test from 'node:test';
import assert from 'node:assert/strict';

const { withLevelGapDebuff, combatLevel } = await import('../../ui/src/utils/combatLevel.js');

const lv = (n) => ({ staminaLevel: n, intelligenceLevel: n, attackLevel: n, defenseLevel: n, meleeLevel: n, rangedLevel: n, magicLevel: n });

test('audit-2: no debuff within a 1.2 ratio, scaled and capped beyond it', () => {
  assert.equal(combatLevel(lv(100)), 100);
  const out = withLevelGapDebuff([lv(100), lv(84), lv(80), lv(20)]).map(d => d.debuffOnLevelGap);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);                                       // 100/84 = 1.19
  assert.ok(Math.abs(out[2] - -0.15) < 1e-12, `got ${out[2]}`);  // 100/80 = 1.25 → -3·0.05
  assert.equal(out[3], -0.9);                                    // 100/20 = 5 → capped
  // The strongest member need not come first.
  assert.deepEqual(withLevelGapDebuff([lv(20), lv(100)]).map(d => d.debuffOnLevelGap), [-0.9, 0]);
  // Exactly 1.2 is not "> 1.2".
  assert.equal(withLevelGapDebuff([lv(60), lv(50)])[1].debuffOnLevelGap, 0);
});

test('audit-2: a solo player and an even party carry no debuff; DTOs are copied', () => {
  const solo = [lv(10)];
  assert.equal(withLevelGapDebuff(solo)[0].debuffOnLevelGap, 0);
  assert.equal(solo[0].debuffOnLevelGap, undefined);
  assert.deepEqual(withLevelGapDebuff([lv(90), lv(90)]).map(d => d.debuffOnLevelGap), [0, 0]);
});
