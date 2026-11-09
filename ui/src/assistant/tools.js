// =============================================================================
// tools — Roboburble's ten tools and the executor.
//
// Every tool is `apply(state, args, ctx) → {summary, next?} | {summary, action}
// | {error}` over a snapshot of App state (see state.js). `next` holds only the
// slices that change; the bridge commits them with App's own setters. Tools
// validate and clamp against game data themselves, mirroring what the sheet
// and header do (PlayerConfig handlers, HeaderControls ranges, fromRoute).
// Pure: no React, no browser globals.
// =============================================================================
import { resolveRef, withAbilities } from '../utils/characterStore.js';
import { clampTier, findZone } from '../utils/zones.js';
import { TOOLS, fromRoute, isTool, supports, toRoute } from '../utils/optimizerTarget.js';
import { MAX_TIER_INDEX, tierIndexToLevel } from '../utils/trialTiers.js';
import { nameOf } from '../utils/names.js';
import { clampDuration } from '../../../shared/dungeonRuns.js';
import { SKILLS, SLOTS, catalog, resolveName } from './catalog.js';
import { validateArgs } from './schema.js';
import { clip, describeResults, describeState, describeView, editPlayer, makeUndo, resolveTarget } from './state.js';

// The system prompt explains `player` once, so the ten schemas stay small (local context is 4096).
const PLAYER = { type: ['integer', 'string'] };
const SLOT = { type: 'string', enum: SLOTS };
const TARGET_OF = { zone: 'zone', lab: 'labyrinth', trial: 'guildTrial' };
const TOOL_OF = Object.fromEntries([['simulate', 'simulate'], ...TOOLS.map(t => [t.label.toLowerCase(), t.value]), ['costs', 'itemCosts']]);
const KIND_LABEL = { zone: 'Zone', labyrinth: 'Lab', guildTrial: 'Trial' };

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const slotKey = (s) => `/equipment_types/${s}`;
const itemName = (gameData, h) => nameOf(h, { items: gameData.items });

/** The target player as a flat player, or {error}. */
function target(state, player) {
  const t = resolveTarget(state, player);
  return t.error ? t : { ...t, flat: resolveRef(state.characters, t.ref) };
}

const edited = (state, t, flat) => ({ characters: editPlayer(state.characters, t.ref, flat) });

export const REGISTRY = {
  adjust_enhancement: {
    kind: 'edit',
    description: 'Change or set the +N (0-20) of equipped gear.',
    parameters: {
      type: 'object',
      properties: {
        delta: { type: 'integer' },
        value: { type: 'integer' },
        slots: { type: 'array', items: SLOT, description: 'default: all' },
        player: PLAYER,
      },
    },
    apply(state, { delta, value, slots, player }, { gameData }) {
      if ((delta == null) === (value == null)) return { error: 'Give exactly one of delta or value.' };
      const t = target(state, player);
      if (t.error) return t;
      const named = slots?.length ? slots : null;
      const equipment = { ...t.flat.equipment };
      const changed = []; const capped = []; const empty = [];
      for (const s of named || SLOTS) {
        const cur = equipment[slotKey(s)];
        if (!cur?.itemHrid) { if (named) empty.push(s); continue; }
        const was = cur.enhancementLevel || 0;
        const raw = value ?? was + delta;
        const level = clampInt(raw, 0, 20);
        if (level !== raw) capped.push(itemName(gameData, cur.itemHrid));
        if (level !== was) {
          equipment[slotKey(s)] = { ...cur, enhancementLevel: level };
          changed.push(`${itemName(gameData, cur.itemHrid)} +${level}`);
        }
      }
      const notes = [
        capped.length ? ` ${capped.length} capped at 0-20 (${capped.join(', ')})` : '',
        empty.length ? ` Empty: ${empty.join(', ')}.` : '',
      ].join('');
      if (!changed.length && !named && !Object.values(t.flat.equipment || {}).some(g => g?.itemHrid)) {
        return { error: `${t.label} has no equipped gear.` };
      }
      if (!changed.length) return { summary: `${t.label}: nothing changed.${notes}` };
      return {
        next: edited(state, t, { ...t.flat, equipment }),
        summary: `${t.label} loadout: ${changed.length} item(s) — ${changed.join(', ')}.${notes}`,
      };
    },
  },

  set_equipment: {
    kind: 'edit',
    description: 'Equip an item by name, or item null to empty a slot.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: ['string', 'null'] },
        slot: SLOT,
        enhancement: { type: 'integer', description: 'default: keep' },
        player: PLAYER,
      },
      required: ['item'],
    },
    apply(state, { item, slot, enhancement, player }, { gameData }) {
      if (item === null && !slot) return { error: 'Name the slot to unequip.' };
      const t = target(state, player);
      if (t.error) return t;
      const equipment = { ...t.flat.equipment };
      if (item === null) {
        if (!equipment[slotKey(slot)]?.itemHrid) return { summary: `${t.label}: ${slot} is already empty.` };
        equipment[slotKey(slot)] = null;
        return { next: edited(state, t, { ...t.flat, equipment }), summary: `${t.label} loadout: ${slot} unequipped.` };
      }
      const c = catalog(gameData);
      const found = resolveName(c.gear, item, 'item');
      if (found.error) {
        // Only gear is offered; a name that resolves only among all equipment is a tool or trinket.
        const other = resolveName(c.equipment, item, 'item').item;
        return other ? { error: `${other.name} is not combat gear (${other.slot.replace(/_/g, ' ')}).` } : found;
      }
      const it = found.item;
      if (slot && slot !== it.slot) return { error: `${it.name} is ${it.slot} gear, not ${slot}.` };
      const key = slotKey(it.slot);
      const keep = equipment[key]?.enhancementLevel || 0;
      const level = enhancement == null ? keep : clampInt(enhancement, 0, 20);
      equipment[key] = { itemHrid: it.hrid, enhancementLevel: level };
      // Mirrors PlayerConfig handleEquipmentChange: two-hand excludes main and off hand.
      const cleared = [];
      const clear = (s) => { if (equipment[slotKey(s)]?.itemHrid) cleared.push(s); equipment[slotKey(s)] = null; };
      if (it.slot === 'two_hand') { clear('main_hand'); clear('off_hand'); }
      if (it.slot === 'main_hand' || it.slot === 'off_hand') clear('two_hand');
      const capped = enhancement != null && level !== enhancement ? ' (capped at 0-20)' : '';
      return {
        next: edited(state, t, { ...t.flat, equipment }),
        summary: `${t.label} loadout: ${it.slot} ${it.name} +${level}${capped}${cleared.length ? `; cleared ${cleared.join(', ')}` : ''}.`,
      };
    },
  },

  set_skill_level: {
    kind: 'edit',
    description: 'Set or change a skill level (1-200), for the character in every loadout.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: [...SKILLS, 'all'] },
        level: { type: 'integer' },
        delta: { type: 'integer' },
        player: PLAYER,
      },
      required: ['skill'],
    },
    apply(state, { skill, level, delta, player }) {
      if ((level == null) === (delta == null)) return { error: 'Give exactly one of level or delta.' };
      const t = target(state, player);
      if (t.error) return t;
      const flat = { ...t.flat };
      const out = [];
      for (const s of skill === 'all' ? SKILLS : [skill]) {
        const key = `${s}Level`;
        const raw = level ?? flat[key] + delta;
        flat[key] = clampInt(raw, 1, 200);
        out.push(`${s} ${flat[key]}${flat[key] !== raw ? ' (capped)' : ''}`);
      }
      if (SKILLS.every(s => flat[`${s}Level`] === t.flat[`${s}Level`])) return { summary: `${t.label}: nothing changed.` };
      const who = t.label.replace(/ \([^)]*\)$/, '');
      return { next: edited(state, t, flat), summary: `${who} (every loadout): ${out.join(', ')}.` };
    },
  },

  set_zone: {
    kind: 'edit',
    description: 'Where to fight: zone or dungeon (tier 0-5), labyrinth monster (level: room 1-500) or trial (tier 0-20); hours: sim time.',
    parameters: {
      type: 'object',
      properties: {
        zone: { type: 'string' },
        tier: { type: 'integer' },
        level: { type: 'integer' },
        hours: { type: 'number' },
      },
    },
    apply(state, { zone, tier, level, hours }, { gameData }) {
      if (zone == null && tier == null && level == null && hours == null) return { error: 'Give zone, tier, level or hours.' };
      const route = toRoute(state.simMode, state.optTarget);
      const c = catalog(gameData);
      let kind = route.target;
      let hit = null;
      if (zone != null) {
        for (const [k, list] of [['zone', c.zones], ['labyrinth', c.labMonsters], ['guildTrial', c.trials]]) {
          const r = resolveName(list, zone, 'zone');
          if (r.item) { kind = k; hit = r.item; break; }
        }
        if (!hit) return resolveName([...c.zones, ...c.labMonsters, ...c.trials], zone, 'zone');
      } else if (route.costs) {
        return { error: 'Costs has no fight; name a zone, labyrinth monster or trial.' };
      }
      const next = {};
      const notes = [];
      const put = (key, v) => { if (v !== state[key]) next[key] = v; };
      let where;
      if (kind === 'zone') {
        const hrid = hit?.hrid || state.zone;
        const t = clampTier(gameData.zones, hrid, tier ?? state.difficultyTier);
        if (tier != null && t !== tier) notes.push(`tier capped at ${t}`);
        put('zone', hrid);
        put('difficultyTier', t);
        where = `${findZone(gameData.zones, hrid)?.name} T${t}`;
      } else if (kind === 'labyrinth') {
        const lab = state.labConfig || {};
        const roomLevel = level == null ? lab.roomLevel : clampInt(level, 1, 500);
        if (level != null && roomLevel !== level) notes.push(`room level capped at ${roomLevel}`);
        const monsterHrid = hit?.hrid || lab.monsterHrid;
        if (monsterHrid !== lab.monsterHrid || roomLevel !== lab.roomLevel) next.labConfig = { ...lab, monsterHrid, roomLevel };
        if (tier != null) notes.push('tier ignored: the labyrinth uses a room level');
        where = `${nameOf(monsterHrid, { monsters: gameData.monsters })} room Lv ${roomLevel}`;
      } else {
        const cfg = state.trialConfig || {};
        const index = tier == null ? null : clampInt(tier, 0, MAX_TIER_INDEX);
        if (tier != null && index !== tier) notes.push(`tier capped at ${index}`);
        const trialHrid = hit?.hrid || cfg.trialHrid;
        const startTier = index == null ? cfg.startTier : tierIndexToLevel(index);
        if (trialHrid !== cfg.trialHrid || startTier !== cfg.startTier) next.trialConfig = { ...cfg, trialHrid, startTier };
        where = `${(gameData.guildTrials || []).find(x => x.hrid === trialHrid)?.name} from tier ${(startTier - 100) / 10}`;
      }
      if (level != null && kind !== 'labyrinth') notes.push('level ignored: it is the labyrinth room level');
      // A new kind of target navigates exactly as the header does.
      if (route.costs || kind !== route.target) {
        const nav = fromRoute(kind, route.tool, state.optTarget);
        put('simMode', nav.simMode);
        put('optTarget', nav.optTarget);
      }
      if (hours != null) {
        const mode = next.simMode ?? state.simMode;
        const dungeon = kind === 'zone' && findZone(gameData.zones, next.zone ?? state.zone)?.isDungeon;
        if (isTool(mode)) notes.push('hours not set: optimisers have their own fidelity');
        else if (kind === 'guildTrial') notes.push('hours not set: trials last 1 h');
        else if (dungeon) notes.push('hours not set: dungeons run by count');
        else {
          const h = clampDuration(hours);
          if (h !== hours) notes.push(`hours capped at ${h}`);
          put('duration', h);
        }
      }
      const view = describeView({ ...state, ...next, gameData });
      const note = notes.length ? ` (${notes.join('; ')})` : '';
      if (!Object.keys(next).length) return { summary: `Already ${where}: ${view}${note}.` };
      return { next, summary: `Now ${view}${note}.` };
    },
  },

  set_consumables: {
    kind: 'edit',
    description: 'Set food and/or drinks (3 each; [] empties).',
    parameters: {
      type: 'object',
      properties: {
        food: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        drinks: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        player: PLAYER,
      },
    },
    apply(state, { food, drinks, player }, { gameData }) {
      if (food == null && drinks == null) return { error: 'Give food or drinks.' };
      if (state.simMode === 'guildTrial') return { error: 'Trials strip consumables, so the trial roster has none to set.' };
      const t = target(state, player);
      if (t.error) return t;
      const c = catalog(gameData);
      const flat = { ...t.flat };
      const out = [];
      for (const [key, names, list, other, what] of [['food', food, c.food, c.drinks, 'food'], ['drinks', drinks, c.drinks, c.food, 'drink']]) {
        if (names == null) continue;
        const hrids = [];
        for (const n of names) {
          const r = resolveName(list, n, what);
          if (r.error) {
            const elsewhere = resolveName(other, n, '');
            if (elsewhere.item) return { error: `${elsewhere.item.name} is ${what === 'food' ? 'a drink, not food' : 'food, not a drink'}.` };
            return r;
          }
          if (hrids.includes(r.item.hrid)) return { error: `${r.item.name} is listed twice.` };
          hrids.push(r.item.hrid);
        }
        const old = flat[key] || [];
        // Triggers stay with the slot index, as handleFoodChange / handleDrinkChange keep them.
        flat[key] = [0, 1, 2].map(i => (hrids[i] ? { itemHrid: hrids[i], triggers: old[i]?.triggers || [] } : null));
        out.push(`${key} ${hrids.map(h => itemName(gameData, h)).join(', ') || 'empty'}`);
      }
      const note = state.simMode === 'labyrinth' ? ' Note: consumables are stripped on labyrinth entry.' : '';
      return { next: edited(state, t, flat), summary: `${t.label} loadout: ${out.join('; ')}.${note}` };
    },
  },

  set_abilities: {
    kind: 'edit',
    description: 'Set the aura (special slot) and/or abilities 1-4 in cast order.',
    parameters: {
      type: 'object',
      properties: {
        aura: { type: ['string', 'null'] },
        abilities: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        player: PLAYER,
      },
    },
    apply(state, args, { gameData }) {
      const { aura, abilities, player } = args;
      if (!('aura' in args) && abilities == null) return { error: 'Give aura or abilities.' };
      const t = target(state, player);
      if (t.error) return t;
      const c = catalog(gameData);
      const memory = t.flat.abilityMemory || {};
      // Mirrors PlayerConfig handleAbilityChange's slot swap.
      const slotFor = (hrid) => ({
        hrid,
        level: memory[hrid]?.level ?? 1,
        triggers: memory[hrid]?.triggers ?? (gameData.abilities?.[hrid]?.defaultCombatTriggers || []).map(x => ({ ...x })),
      });
      const pick = (name, list, other, what) => {
        const r = resolveName(list, name, what);
        if (r.item) return r;
        const elsewhere = resolveName(other, name, '');
        if (elsewhere.item) return { error: `${elsewhere.item.name} is ${what === 'aura' ? 'a regular ability, not a special' : 'a special (aura slot), not a regular ability'}.` };
        return r;
      };
      const slots = [...(t.flat.abilities || [])];
      while (slots.length < 5) slots.push(null);
      if ('aura' in args) {
        if (aura === null) slots[0] = null;
        else {
          const r = pick(aura, c.auras, c.abilities, 'aura');
          if (r.error) return r;
          slots[0] = slots[0]?.hrid === r.item.hrid ? slots[0] : slotFor(r.item.hrid);
        }
      }
      if (abilities != null) {
        const hrids = [];
        for (const n of abilities) {
          const r = pick(n, c.abilities, c.auras, 'ability');
          if (r.error) return r;
          if (hrids.includes(r.item.hrid)) return { error: `${r.item.name} is listed twice.` };
          hrids.push(r.item.hrid);
        }
        for (let i = 0; i < 4; i++) {
          const h = hrids[i];
          slots[i + 1] = !h ? null : slots[i + 1]?.hrid === h ? slots[i + 1] : slotFor(h);
        }
      }
      const name = (s) => (s?.hrid ? nameOf(s.hrid, { abilities: gameData.abilities }) : '—');
      return {
        next: edited(state, t, withAbilities(t.flat, slots)),
        summary: `${t.label} loadout: aura ${name(slots[0])}; abilities ${slots.slice(1).map(name).join(', ')}.`,
      };
    },
  },

  navigate: {
    kind: 'edit',
    description: 'Switch the view: target and/or tool.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: Object.keys(TARGET_OF) },
        tool: { type: 'string', enum: Object.keys(TOOL_OF) },
      },
    },
    apply(state, { target: to, tool }) {
      if (to == null && tool == null) return { error: 'Give target or tool.' };
      const route = toRoute(state.simMode, state.optTarget);
      const next = {};
      const put = (key, v) => { if (v !== state[key]) next[key] = v; };
      let note = '';
      if (tool === 'costs') put('simMode', 'itemCosts');
      else {
        const t = to ? TARGET_OF[to] : route.target || 'zone';
        const wanted = tool ? TOOL_OF[tool] : route.tool || 'simulate';
        if (!supports(wanted, t)) note = ` (${KIND_LABEL[t]} offers Simulate only)`;
        const nav = fromRoute(t, wanted, state.optTarget);
        put('simMode', nav.simMode);
        put('optTarget', nav.optTarget);
      }
      const view = describeView({ ...state, ...next });
      return Object.keys(next).length ? { next, summary: `Now ${view}${note}.` } : { summary: `Already on ${view}${note}.` };
    },
  },

  run_simulation: {
    kind: 'action',
    description: 'Press Run for the current view.',
    parameters: { type: 'object', properties: {} },
    apply(state) {
      if (state.loading) return { error: 'A run is already in progress; wait or press Stop.' };
      if (state.simMode === 'itemCosts') return { error: 'Costs is not a run view; navigate to a target first.' };
      if (state.runDisabled) return { error: 'The Run button is disabled: the optimiser is still previewing or has nothing selected.' };
      if (state.simMode === 'guildTrial') {
        if (!(state.roster || []).some(r => resolveRef(state.characters, r))) return { error: 'The trial roster is empty.' };
      } else if (!isTool(state.simMode)) {
        const live = (state.selectedPlayers || []).filter(n => resolveRef(state.characters, state.party?.[n]));
        if (!live.length) return { error: 'No selected party slot holds a character.' };
      }
      return { action: 'run', summary: `Started: ${describeView(state)}.` };
    },
  },

  get_state: {
    kind: 'read',
    description: 'Read the view, party and a player\'s levels, gear, food and abilities.',
    parameters: { type: 'object', properties: { player: PLAYER } },
    apply: (state, { player }) => ({ summary: describeState(state, player) }),
  },

  get_results: {
    kind: 'read',
    description: 'Read the latest results.',
    parameters: { type: 'object', properties: {} },
    apply: (state) => ({ summary: describeResults(state) }),
  },
};

/** Provider-neutral tool specs: [{name, description, parameters}]. */
export function toolSpecs() {
  return Object.entries(REGISTRY).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
}

const MAX_RESULT = 1600;

/**
 * Validate, apply and clip one call. Never throws for bad input; an error is a
 * readable `content` with `isError`, and no state change.
 * @returns {{id, name, kind, content, isError?, next?, undo?, action?}}
 */
export function executeTool(call, state, ctx) {
  const tool = REGISTRY[call?.name];
  const base = { id: call?.id, name: call?.name, kind: tool?.kind || 'error' };
  const fail = (content) => ({ ...base, isError: true, content: clip(content, MAX_RESULT) });
  if (!tool) return fail(`Unknown tool '${call?.name}'. Tools: ${Object.keys(REGISTRY).join(', ')}.`);
  if (call.argsError) return fail(`The arguments were not valid JSON (${call.argsError}).`);
  const { value, errors } = validateArgs(tool.parameters, call.args);
  if (errors.length) return fail(errors.join(' '));
  let r;
  try {
    r = tool.apply(state, value, ctx);
  } catch (e) {
    return fail(`${call.name} failed: ${e?.message || e}`);
  }
  if (r.error) return fail(r.error);
  const out = { ...base, content: clip(r.summary, MAX_RESULT) };
  if (r.next && Object.keys(r.next).length) {
    out.next = r.next;
    out.undo = makeUndo(state, r.next);
  }
  if (r.action) out.action = r.action;
  return out;
}
