const SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

// The game's combat level: 0.1 × (sta + int + att + def + best offence)
// + 0.5 × the single best of att / def / mel / rng / mag.
export function combatLevel(p) {
  const lv = Object.fromEntries(SKILLS.map(s => [s, Number(p?.[`${s}Level`]) || 1]));
  const offence = Math.max(lv.melee, lv.ranged, lv.magic);
  const best = Math.max(lv.attack, lv.defense, lv.melee, lv.ranged, lv.magic);
  return Math.floor(0.1 * (lv.stamina + lv.intelligence + lv.attack + lv.defense + offence) + 0.5 * best);
}
