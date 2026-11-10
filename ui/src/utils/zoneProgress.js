// =============================================================================
// zoneProgress — the Progress zone finder's arithmetic (hooks/useZoneFinder.js)
//
// Scores a zone sweep's rows in the Progress tool's currency: the fraction of
// the baseline objective one hour there buys, from the gains per level the
// Progress run measured. Framework-free; the sweep worker must NOT import it
// (it pulls shared/drops.js), so allZones.js stays import-free.
// =============================================================================
import { calculateExpectedDrops } from '../../../shared/drops.js';
import { comboKey } from './allZones.js';

export const QUICK_HOURS = 3, VERIFY_HOURS = 24, FINALISTS = 15, TOP_N = 10;
const CHARM = '/equipment_types/charm';
const COFFEES = ['/items/wisdom_coffee', '/items/lucky_coffee'];

/** [{ key, charm, coffee, player }]: the worn charm, plus one per charm skill Progress measured (worn tier and enhancement, level met)
 *  times, when exactly one of wisdom / lucky is slotted, that slot holding either. */
export function finderVariants(subject, progressRows, items) {
  const worn = subject.equipment?.[CHARM];
  const meets = (hrid) => (items[hrid]?.equipmentDetail?.levelRequirements || [])
    .every((r) => Number(subject[`${r.skillHrid.split('/').pop()}Level`]) >= r.level);
  const swaps = worn ? (progressRows || []).filter((r) => r.kind === 'stat' && r.pctPerMillionXp != null)
    .map((r) => worn.hrid.replace(/[a-z]+(?=_charm$)/, r.skill)).filter((h) => items[h] && meets(h)) : [];
  const charms = worn ? [...new Set([worn.hrid, ...swaps])] : [null];
  const drinks = subject.drinks || [];
  const slot = drinks.findIndex((d) => COFFEES.includes(d?.hrid));
  const coffees = slot >= 0 && !COFFEES.every((h) => drinks.some((d) => d?.hrid === h)) ? COFFEES : [null];
  return charms.flatMap((charm) => coffees.map((coffee) => ({ key: `${charm}|${coffee}`, charm, coffee, player: {
    ...subject,
    ...(charm && { equipment: { ...subject.equipment, [CHARM]: { ...worn, hrid: charm } } }),
    ...(coffee && { drinks: drinks.map((d, i) => (i !== slot || d.hrid === coffee ? d
      : { hrid: coffee, triggers: (items[coffee].consumableDetail.defaultCombatTriggers || []).map((t) => ({ ...t })) })) }),
  } })));
}

/** A sweep row in Progress's currency: Σ gain per XP × XP/h + Σ gain per book × books/h (fraction of the baseline objective per hour). */
export function scoreZoneRow(row, progressRows, subjectHrid, monsters, items) {
  if (!row || row.error || !(row.hours > 0)) return null;
  const xp = row.experienceBySkill?.[subjectHrid] || {};
  // Dungeon loot comes only from chests, which are not modelled.
  const drops = new Map(row.isDungeon ? [] : calculateExpectedDrops(row, monsters, items, subjectHrid).map((d) => [d.itemHrid, d.amount]));
  const parts = (progressRows || []).map((p) => {
    const stat = p.kind === 'stat';
    const perHour = (stat ? Number(xp[p.skill]) || 0 : drops.get(p.bookHrid) || 0) / row.hours;
    // A level-up that reads negative is scan noise.
    const gain = Math.max(0, stat ? (p.pctPerMillionXp ?? 0) / 1e6 : p.pctPerBook ?? 0);
    return { id: p.id, label: p.label, kind: p.kind, perHour, progressPerHour: perHour * gain };
  });
  const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
  return { ...row, parts, progressPerHour: sum(parts, (p) => p.progressPerHour),
    xpPerHour: sum(Object.values(xp), Number) / row.hours,
    booksPerHour: sum(parts.filter((p) => p.kind === 'ability'), (p) => p.perHour) };
}

/** Each (zone, tier)'s best variant, best first, at most n; a zone that earns nothing is never one. */
export function topZones(scored, n) {
  const best = new Map();
  for (const row of scored) {
    if (!row) continue;
    const key = comboKey(row.zoneHrid, row.difficultyTier);
    if (!(best.get(key)?.progressPerHour >= row.progressPerHour)) best.set(key, row);
  }
  return [...best.values()].filter((r) => r.progressPerHour > 0).sort((a, b) => b.progressPerHour - a.progressPerHour).slice(0, n);
}

/** A pass's rows scored and ranked; job: { progressRows, subjectHrid, monsters, items }. */
export const rankZones = (rows, job, n) =>
  topZones(rows.map((r) => scoreZoneRow(r, job.progressRows, job.subjectHrid, job.monsters, job.items)), n);

/** The quick pass's finalists re-ranked on their VERIFY_HOURS rows. A finalist whose long run failed or never
 *  finished (stopped) keeps its QUICK_HOURS score, marked quickOnly, so a stopped second pass never loses the first's answer. */
export function rankFinalists(quickTop, rows, job, n) {
  const measured = new Map();
  for (const r of rows) {
    const s = scoreZoneRow(r, job.progressRows, job.subjectHrid, job.monsters, job.items);
    if (s) measured.set(comboKey(s.zoneHrid, s.difficultyTier), s);
  }
  return topZones(quickTop.map((q) => measured.get(comboKey(q.zoneHrid, q.difficultyTier)) ?? { ...q, quickOnly: true }), n);
}

/** { runs, failed } over a pass's rows, added to an earlier pass's counts. */
export const countRuns = (rows, before = { runs: 0, failed: 0 }) =>
  ({ runs: before.runs + rows.length, failed: before.failed + rows.filter((r) => r.error).length });
