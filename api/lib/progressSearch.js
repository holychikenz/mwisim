// =============================================================================
// progressSearch — what the Progress tool raises for ONE player: the stat its
// weapon damages with, attack, any extra stat asked for, and every slotted
// ability, each by N levels (never past 200), and what those levels cost.
// The paired per-level scan is scanEquipment's (equipmentScan/scan.js).
//   * levelExperienceTable (shared/, from the game's client data) is cumulative:
//     +N from the start of level L costs t[L+N] - t[L]. Abilities share it.
//   * an ability levels from books (abilityBookDetail.experienceGain XP each),
//     so +N costs ceil((t[L+N] - t[L]) / gain) books. The store keeps levels,
//     not XP: a player is taken to stand at the start of their level.
//   * the level-gap debuff is XP-only (simResult.js), so no party debuff is
//     recomputed when a level is raised.
// =============================================================================
import LEVEL_XP from '../../shared/levelExperienceTable.json';
import { abilityContext } from './abilitySearch.js';

const { abilityDetailMap, itemDetailMap } = await import('../../src/combatsimulator/dataProvider.js');

export const MAX_LEVEL = LEVEL_XP.length - 1; // 200
export const DEFAULT_LEVELS = 10;
/** Probed when asked; the weapon's damage stat and attack always are. */
export const EXTRA_STATS = ['defense', 'stamina', 'intelligence'];
const STAT_LABELS = { melee: 'Melee', ranged: 'Ranged', magic: 'Magic', attack: 'Attack', defense: 'Defense', stamina: 'Stamina', intelligence: 'Intelligence' };
/** Damage by combat style (combatUnit.js): ranged and magic their own level, stab / slash / smash melee. */
const STYLE_SKILL = { '/combat_styles/ranged': 'ranged', '/combat_styles/magic': 'magic' };

/** XP from the start of level `from` to the start of level `to`. */
export const xpBetween = (from, to) => LEVEL_XP[to] - LEVEL_XP[from];

/** The book that trains `abilityHrid`, or undefined (Promote has none). */
export const bookFor = (abilityHrid) =>
  Object.values(itemDetailMap).find((item) => item.abilityBookDetail?.abilityHrid === abilityHrid);

/** The skill the auto-attack damages with: the weapon's first combat style, read as player.js reads the weapon (main hand, else two hand, else unarmed smash). */
export function mainStatOf(dto) {
  const weapon = dto?.equipment?.['/equipment_types/main_hand'] || dto?.equipment?.['/equipment_types/two_hand'];
  const style = weapon ? itemDetailMap[weapon.hrid]?.equipmentDetail?.combatStats?.combatStyleHrids?.[0] : null;
  return STYLE_SKILL[style] ?? 'melee';
}

const levelOf = (value) => Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(value)) || 1));

/** Every probe for `subject`, scannable or not (a level at 200 has nowhere to go). Ids never contain '#'. */
export function progressRows(subject, { levels, stats } = {}) {
  const n = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(levels)) || DEFAULT_LEVELS));
  const probe = (row, from) => {
    const to = Math.min(MAX_LEVEL, from + n);
    return { ...row, from, to, step: to - from, requestedStep: n, scannable: to > from, reason: to > from ? null : `already level ${MAX_LEVEL}` };
  };
  const asked = new Set(Array.isArray(stats) ? stats.map(String) : []);
  const skills = [...new Set([mainStatOf(subject), 'attack', ...EXTRA_STATS.filter((s) => asked.has(s))])];
  const statRows = skills.map((skill) => {
    const row = probe({ id: `stat:${skill}`, kind: 'stat', skill, field: `${skill}Level` }, levelOf(subject?.[`${skill}Level`]));
    return { ...row, label: `${STAT_LABELS[skill]} +${row.step}`, xp: xpBetween(row.from, row.to) };
  });
  // Unlocked slots only (the engine never casts from a locked one); one row per ability, however many slots hold it.
  const { abilities, unlocked } = abilityContext(subject);
  const seen = new Set();
  const abilityRows = abilities.flatMap((slot, i) => {
    const hrid = slot?.hrid;
    if (!hrid || !unlocked[i] || !Object.hasOwn(abilityDetailMap, hrid) || seen.has(hrid)) return [];
    seen.add(hrid);
    const row = probe({ id: `ability:${hrid}`, kind: 'ability', hrid }, levelOf(slot.level));
    const book = bookFor(hrid);
    return [{ ...row, label: `${abilityDetailMap[hrid].name} +${row.step} lvls`, bookHrid: book?.hrid ?? null,
      books: book ? Math.ceil(xpBetween(row.from, row.to) / book.abilityBookDetail.experienceGain) : null }];
  });
  return [...statRows, ...abilityRows];
}

/** `dtos` with `row` applied to player `k`: the stat raised, or every slot holding the ability. */
export function applyProgress(dtos, k, row) {
  return dtos.map((dto, i) => {
    if (i !== k) return dto;
    if (row.kind === 'stat') return { ...dto, [row.field]: row.to };
    return { ...dto, abilities: dto.abilities.map((a) => (a?.hrid === row.hrid ? { ...a, level: row.to } : a)) };
  });
}

/** A scanned row's cost per level (XP or books) and the probe's gain per unit of it: Δ% per 1M XP, or per book. */
export function withCosts(row) {
  const per = (cost) => (row.probeDeltaPct == null || !(cost > 0) ? null : row.probeDeltaPct / cost);
  return row.kind === 'stat'
    ? { ...row, xpPerLevel: row.xp / row.step, pctPerMillionXp: per(row.xp / 1e6) }
    : { ...row, booksPerLevel: row.books == null ? null : row.books / row.step, pctPerBook: per(row.books) };
}
