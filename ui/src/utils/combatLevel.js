const SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

// The game's combat level: 0.1 × (sta + int + att + def + best offence)
// + 0.5 × the single best of att / def / mel / rng / mag.
export function combatLevel(p) {
  const lv = Object.fromEntries(SKILLS.map(s => [s, Number(p?.[`${s}Level`]) || 1]));
  const offence = Math.max(lv.melee, lv.ranged, lv.magic);
  const best = Math.max(lv.attack, lv.defense, lv.melee, lv.ranged, lv.magic);
  return Math.floor(0.1 * (lv.stamina + lv.intelligence + lv.attack + lv.defense + offence) + 0.5 * best);
}

// The XP/drop debuff for a party member far below the strongest: when
// maxCL/myCL > 1.2 it is -min(0.9, 3·(ratio - 1.2)), else 0.
// Returns copies of the DTOs with `debuffOnLevelGap` set.
export function withLevelGapDebuff(dtos) {
  const levels = dtos.map(combatLevel);
  const max = Math.max(1, ...levels);
  return dtos.map((dto, i) => {
    const ratio = max / levels[i];
    return { ...dto, debuffOnLevelGap: ratio > 1.2 ? -Math.min(0.9, 3 * (ratio - 1.2)) : 0 };
  });
}
