// =============================================================================
// state — what the assistant's tools read and write: which player a call
// means, the sheet's own write path, undo, and the compact text views a model
// reads. Every function is pure over a snapshot of App state:
//   { gameData, characters, party, activeTab, selectedPlayers, roster,
//     selectedEntryId, simMode, optTarget, zone, difficultyTier, duration,
//     labConfig, trialConfig, results, loading, progress, error, runDisabled }
// Pure: no React, no browser globals.
// =============================================================================
import { resolveRef, setLoadout, splitPlayer, upsertCharacter } from '../utils/characterStore.js';
import { findZone } from '../utils/zones.js';
import { TARGETS, TOOLS, toRoute } from '../utils/optimizerTarget.js';
import { formatTier } from '../utils/trialTiers.js';
import { nameOf } from '../utils/names.js';
import { SKILLS, SLOTS } from './catalog.js';

const PARTY_SLOTS = [1, 2, 3, 4, 5];
const ONE_HOUR = 3600e9;
const SHORT = { stamina: 'sta', intelligence: 'int', attack: 'att', melee: 'mel', defense: 'def', ranged: 'rng', magic: 'mag' };

export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

const characterOf = (state, ref) => state.characters?.characters?.[ref?.characterId];
const refLabel = (state, ref) => `${characterOf(state, ref)?.name || ref?.characterId} (${ref?.loadoutName})`;

/** The rows a `player` argument picks from: party slots, or roster rows in Trial. */
function rows(state) {
  if (state.simMode === 'guildTrial') {
    return (state.roster || []).map((r, i) => ({
      n: i + 1, ref: r, open: r.id === state.selectedEntryId, prefix: `Row ${i + 1}`, count: r.count,
    }));
  }
  return PARTY_SLOTS.map(n => ({ n, ref: state.party?.[n] || null, open: n === state.activeTab, prefix: `P${n}` }));
}

/**
 * The player a tool edits. `player` omitted: the open slot (Trial: the selected
 * roster row). An integer: that slot or row. A string: a character name —
 * exact (ignoring case), then a unique word match — among bound rows.
 * @returns {{ref, label}|{error}}
 */
export function resolveTarget(state, player) {
  const list = rows(state);
  const trial = state.simMode === 'guildTrial';
  let row;
  if (player == null || player === '') {
    row = list.find(r => r.open);
    if (!row) return { error: trial ? 'No roster row is selected.' : 'No slot is open.' };
  } else if (typeof player === 'number') {
    row = list.find(r => r.n === player);
    if (!row) return { error: trial ? `There is no roster row ${player}.` : `There is no P${player}; slots are 1-5.` };
  } else {
    const bound = list.filter(r => resolveRef(state.characters, r.ref));
    const want = String(player).trim().toLowerCase();
    let hits = bound.filter(r => (characterOf(state, r.ref)?.name || '').toLowerCase() === want);
    if (!hits.length) {
      const w = want.split(/\s+/);
      hits = bound.filter(r => { const name = (characterOf(state, r.ref)?.name || '').toLowerCase().split(/\s+/); return w.every(x => name.includes(x)); });
      if (new Set(hits.map(r => r.ref.characterId)).size > 1) {
        return { error: `Several players match '${player}': ${hits.map(r => characterOf(state, r.ref).name).join(', ')}.` };
      }
    }
    if (!hits.length) return { error: `No ${trial ? 'roster row' : 'party slot'} holds '${player}'.` };
    row = hits.find(r => r.open) || hits[0];
  }
  if (!resolveRef(state.characters, row.ref)) return { error: `${row.prefix} is empty.` };
  return { ref: row.ref, label: `${row.prefix} ${refLabel(state, row.ref)}` };
}

/**
 * The sheet's own write path — a mirror of App.jsx applyPlayerEdit: the
 * character half lands on the character (shared by every slot wearing it), the
 * loadout half on that loadout.
 */
export function editPlayer(store, ref, flat) {
  const existing = store?.characters?.[ref.characterId];
  if (!existing) return store;
  const { character, loadout } = splitPlayer(flat);
  const merged = upsertCharacter(store, { ...existing, ...character });
  return setLoadout(merged, ref.characterId, ref.loadoutName, loadout);
}

/**
 * The undo record for one edit. Non-character slices keep their prior value BY
 * REFERENCE (primitives, or labConfig/trialConfig, which are never mutated).
 * For `characters`, only the characters whose object changed keep their prior
 * object, so undo puts back exactly those and leaves other characters' later
 * edits alone. Undo restores the snapshot: a later edit to the same slice or the
 * same character (any loadout or level) is overwritten. One shot, no redo.
 */
export function makeUndo(before, next) {
  const undo = { slices: {}, characters: null };
  for (const key of Object.keys(next)) {
    if (key !== 'characters') { undo.slices[key] = before[key]; continue; }
    const prev = before.characters?.characters || {};
    const now = next.characters?.characters || {};
    undo.characters = {};
    for (const id of new Set([...Object.keys(prev), ...Object.keys(now)])) {
      if (prev[id] !== now[id]) undo.characters[id] = prev[id];
    }
  }
  return undo;
}

/** The patch that applies `undo` to the CURRENT state, or {error}. */
export function undoPatch(current, undo) {
  const patch = { ...undo.slices };
  if (undo.characters) {
    const chars = { ...(current.characters?.characters || {}) };
    for (const [id, prior] of Object.entries(undo.characters)) {
      if (prior === undefined) delete chars[id];
      else if (!chars[id]) return { error: 'That character no longer exists.' };
      else chars[id] = prior;
    }
    patch.characters = { ...current.characters, characters: chars };
  }
  return patch;
}

// -- text views ---------------------------------------------------------------

const zoneName = (state, hrid) => findZone(state.gameData?.zones, hrid)?.name || nameOf(hrid);
const trialName = (state, hrid) => (state.gameData?.guildTrials || []).find(t => t.hrid === hrid)?.name || nameOf(hrid);

/** "Zone · Simulate · Bear With It T3 · 12 h" — where the user is. */
export function describeView(state) {
  const route = toRoute(state.simMode, state.optTarget);
  if (route.costs) return 'Costs';
  const target = TARGETS.find(t => t.value === route.target)?.label;
  const tool = route.tool === 'simulate' ? 'Simulate' : TOOLS.find(t => t.value === route.tool)?.label;
  const parts = [target, tool];
  const sim = route.tool === 'simulate';
  if (route.target === 'zone') {
    const dungeon = findZone(state.gameData?.zones, state.zone)?.isDungeon;
    parts.push(`${zoneName(state, state.zone)} T${state.difficultyTier}${dungeon ? ' (dungeon)' : ''}`);
    if (sim && !dungeon) parts.push(`${state.duration} h`);
  } else if (route.target === 'labyrinth') {
    const lab = state.labConfig || {};
    parts.push(`${nameOf(lab.monsterHrid, { monsters: state.gameData?.monsters })} room Lv ${lab.roomLevel}`);
    if (sim) parts.push(`${state.duration} h`);
  } else {
    const cfg = state.trialConfig || {};
    parts.push(`${trialName(state, cfg.trialHrid)} from ${formatTier(cfg.startTier)}`);
  }
  return parts.join(' · ');
}

/** The one line the system prompt carries about the current state. */
export function describeNow(state) {
  const open = resolveTarget(state);
  return `${describeView(state)} · ${open.error ? 'no open player' : `open ${open.label}`}`;
}

function describePlayer(state, flat) {
  const name = (h) => nameOf(h, { items: state.gameData?.items, abilities: state.gameData?.abilities });
  const levels = SKILLS.map(s => `${SHORT[s]} ${flat[`${s}Level`]}`).join(' ');
  const gearList = SLOTS.map(s => [s, flat.equipment?.[`/equipment_types/${s}`]])
    .filter(([, g]) => g?.itemHrid)
    .map(([s, g]) => `${s} ${name(g.itemHrid)} +${g.enhancementLevel || 0}`);
  const list = (xs) => xs.filter(x => x?.itemHrid || x?.hrid).map(x => name(x.itemHrid || x.hrid)).join(', ') || 'none';
  const [aura, ...rest] = flat.abilities || [];
  return [
    `Levels: ${levels}`,
    `Gear: ${gearList.join(', ') || 'none'}`,
    `Food: ${list(flat.food || [])} · Drinks: ${list(flat.drinks || [])}`,
    `Aura: ${aura?.hrid ? name(aura.hrid) : 'none'} · Abilities: ${list(rest)}`,
  ].join('\n');
}

/** get_state: the view, the party (or roster) and the target player, by name. */
export function describeState(state, player) {
  const trial = state.simMode === 'guildTrial';
  const lines = [`View: ${describeView(state)}`];
  const list = rows(state).map(r => {
    if (!resolveRef(state.characters, r.ref)) return `${r.prefix} —`;
    const mark = trial ? ` ×${r.count || 1}` : (state.selectedPlayers || []).includes(r.n) ? '*' : '';
    return `${r.prefix} ${refLabel(state, r.ref)}${mark}${r.open ? ' (open)' : ''}`;
  });
  lines.push(trial ? `Roster: ${list.join(', ') || 'empty'}` : `Party (* = in the run): ${list.join(', ')}`);
  const t = resolveTarget(state, player);
  if (t.error) lines.push(t.error);
  else lines.push(`${t.label}:`, describePlayer(state, resolveRef(state.characters, t.ref)));
  return clip(lines.join('\n'), 1400);
}

/** get_results: a short summary of what the results pane shows. */
export function describeResults(state) {
  const r = state.results;
  if (state.loading) return `Running ${Math.round(state.progress || 0)}%.`;
  if (!r) return state.error ? `No results; the last run failed: ${state.error.message || state.error}` : 'No results yet.';
  if (r.__kind === 'guildTrial') {
    const a = r.aggregate || {};
    return clip(`Trial: expected tiers cleared ${fmt(a.expectedTiersCleared, 2)}, expected max Lv ${fmt(a.expectedMaxTierCleared, 1)}.`, 800);
  }
  if (r.__kind) return 'The optimiser results are in the pane; they are tool-specific tables.';
  const hours = (r.simulatedTime || 0) / ONE_HOUR || 1;
  const names = r.meta?.playerNames || {};
  if (r.isLabyrinth) return clip(`Labyrinth: cleared ${r.encounters || 0} of ${r.labyAttemptCount || 0} rooms.`, 800);
  if (r.isDungeon) return clip(`Dungeon: ${r.dungeonsCompleted || 0} completed, ${r.dungeonsFailed || 0} failed in ${fmt(hours, 1)} h.`, 800);
  const xp = Object.entries(r.experienceGained || {}).map(([p, bySkill]) => {
    const total = Object.values(bySkill || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    return `${nameOf(p, { playerNames: names })} ${fmt(total / hours)} XP/h`;
  });
  const deaths = Object.entries(r.deaths || {}).filter(([p]) => /^player\d+$/.test(p)).reduce((a, [, n]) => a + (n || 0), 0);
  return clip(`Zone: ${fmt((r.encounters || 0) / hours, 1)} encounters/h; ${xp.join(', ') || 'no XP'}; ${fmt(deaths / hours, 2)} player deaths/h.`, 800);
}
