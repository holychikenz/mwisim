// =============================================================================
// bench/builds.mjs — the STANDARD CANDLE: a fixed catalogue of character builds
// and scenarios, and the two adapters that turn each one into engine input.
//
// WHY A CATALOGUE AND NOT A SCRIPT
// --------------------------------
// A benchmark is only a candle if it does not move. Every number this repo has
// quoted about engine speed so far came from an ad-hoc script with its own
// hand-rolled loadout, which makes two measurements taken a week apart
// incomparable — and makes a comparison against another engine an argument
// about whether the two were fed the same thing.
//
// So the builds live here, declaratively, and BOTH adapters below derive their
// input from the same declaration. If csim and a rival engine disagree on
// throughput, it is not because one of them was handed different gear.
//
// DO NOT EDIT A BUILD TO MAKE A NUMBER LOOK BETTER. Adding a case is fine and
// welcome; changing an existing one silently invalidates every prior reading.
// If a build must change, rename it, so old and new never sit in one table.
//
// WHAT THE CASES ARE FOR
// ----------------------
// The matrix is not a cross product. Each case was chosen to load a different
// part of the engine, so a regression shows up somewhere specific rather than
// being smeared across the mean:
//
//   floor-*        no equipment, no consumables, no abilities. The event loop,
//                  the heap and the damage roll and nothing else. A change here
//                  is a change to the engine's irreducible cost.
//   starter/mid-*  partial kit. Catches anything that is accidentally O(worn
//                  slots) in a way that only shows on a full kit.
//   <style>-solo   endgame melee / ranged / magic, one player, one monster.
//                  The classic microbench, and the shape most users run.
//   tank/healer    buff-heavy and cross-unit: stresses buff scanning and
//                  target selection rather than damage.
//   buffstack      five auras and nothing else. Deliberately pathological for
//                  the buff path; the case that moves most when buff lookup
//                  changes.
//   *-swarm        multi-spawn zone: several live monsters, deeper event queue.
//   party-*        2 and 3 players in an open zone: per-unit work × party size.
//   dungeon-*      the real load. 5 mixed players, 50 waves, the deepest queue
//                  and the most stat recomputation. This is what users wait on.
// =============================================================================

// ---- gear -------------------------------------------------------------------
// Slot is derived from the game data at materialise time, not asserted here, so
// a data update that moves an item between slots is picked up rather than
// silently mis-slotted.

const ENDGAME_ACCESSORIES = [
  ["/items/philosophers_earrings", 10],
  ["/items/philosophers_necklace", 10],
  ["/items/philosophers_ring", 10],
  ["/items/expert_task_badge", 10],
  ["/items/guzzling_pouch", 10],
];

const ENDGAME_FOOD = ["/items/spaceberry_cake", "/items/star_fruit_gummy", "/items/spaceberry_donut"];

export const BUILDS = {
  // The engine floor. Nothing worn, nothing drunk, nothing cast.
  bare: {
    label: "bare",
    equipment: [],
    abilities: [],
    food: [],
    drinks: [],
  },

  // A level-20-ish character: a weapon, a shield, one of everything cheap.
  starter: {
    label: "starter melee",
    equipment: [
      ["/items/cheese_sword", 0],
      ["/items/cheese_buckler", 0],
      ["/items/cheese_helmet", 0],
      ["/items/cheese_plate_body", 0],
      ["/items/cheese_plate_legs", 0],
      ["/items/cheese_boots", 0],
      ["/items/cheese_gauntlets", 0],
      ["/items/basic_attack_charm", 0],
      ["/items/small_pouch", 0],
    ],
    abilities: [["/abilities/poke", 1]],
    food: ["/items/cupcake"],
    drinks: ["/items/stamina_coffee"],
  },

  // Mid-game: a full but unrefined kit, modest enhancement, three abilities.
  "mid-melee": {
    label: "mid melee",
    equipment: [
      ["/items/rainbow_sword", 3],
      ["/items/rainbow_buckler", 3],
      ["/items/rainbow_helmet", 3],
      ["/items/rainbow_plate_body", 3],
      ["/items/rainbow_plate_legs", 3],
      ["/items/rainbow_boots", 3],
      ["/items/rainbow_gauntlets", 3],
      ["/items/expert_attack_charm", 3],
      ["/items/advanced_task_badge", 3],
      ["/items/ring_of_rare_find", 3],
      ["/items/necklace_of_wisdom", 3],
      ["/items/earrings_of_rare_find", 3],
      ["/items/giant_pouch", 3],
    ],
    abilities: [
      ["/abilities/cleave", 5],
      ["/abilities/maim", 5],
      ["/abilities/precision", 5],
    ],
    food: ["/items/marsberry_cake", "/items/dragon_fruit_gummy"],
    drinks: ["/items/super_melee_coffee", "/items/super_attack_coffee"],
  },

  // Endgame one-hand slash + shield.
  melee: {
    label: "endgame melee",
    equipment: [
      ["/items/regal_sword_refined", 10],
      ["/items/knights_aegis_refined", 10],
      ["/items/acrobatic_hood_refined", 10],
      ["/items/anchorbound_plate_body_refined", 10],
      ["/items/anchorbound_plate_legs_refined", 10],
      ["/items/pathbreaker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/sinister_cape_refined", 10],
      ["/items/grandmaster_attack_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/berserk", 10],
      ["/abilities/cleave", 10],
      ["/abilities/crippling_slash", 10],
      ["/abilities/precision", 10],
      ["/abilities/critical_aura", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_melee_coffee", "/items/ultra_attack_coffee", "/items/critical_coffee"],
  },

  // Endgame two-hand bow. No off-hand — exercises the two_hand branch of
  // updateCombatDetails, which is a different code path from main_hand.
  ranged: {
    label: "endgame ranged",
    equipment: [
      ["/items/cursed_bow_refined", 10],
      ["/items/corsair_helmet_refined", 10],
      ["/items/kraken_tunic_refined", 10],
      ["/items/kraken_chaps_refined", 10],
      ["/items/pathfinder_boots_refined", 10],
      ["/items/marksman_bracers_refined", 10],
      ["/items/chimerical_quiver_refined", 10],
      ["/items/grandmaster_ranged_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/aqua_arrow", 10],
      ["/abilities/rain_of_arrows", 10],
      ["/abilities/penetrating_shot", 10],
      ["/abilities/steady_shot", 10],
      ["/abilities/precision", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_ranged_coffee", "/items/ultra_attack_coffee", "/items/critical_coffee"],
  },

  // Endgame magic. Spells cost mana, so this build also exercises the mana
  // regen / out-of-mana branches that the physical builds never reach.
  magic: {
    label: "endgame magic",
    equipment: [
      ["/items/blazing_trident_refined", 10],
      ["/items/bishops_codex_refined", 10],
      ["/items/magicians_hat_refined", 10],
      ["/items/royal_fire_robe_top_refined", 10],
      ["/items/royal_fire_robe_bottoms_refined", 10],
      ["/items/pathseeker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/enchanted_cloak_refined", 10],
      ["/items/grandmaster_magic_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/firestorm", 10],
      ["/abilities/flame_blast", 10],
      ["/abilities/elemental_affinity", 10],
      ["/abilities/mana_spring", 10],
      ["/abilities/mystic_aura", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_magic_coffee", "/items/ultra_intelligence_coffee", "/items/channeling_coffee"],
  },

  // Maximum survivability and maximum threat. Provoke/taunt force the target
  // selection path to re-evaluate; toughness and spike_shell keep the buff list
  // populated. Dies rarely, so a dungeon run with one of these lasts longer.
  tank: {
    label: "tank",
    equipment: [
      ["/items/griffin_bulwark_refined", 10],
      ["/items/acrobatic_hood_refined", 10],
      ["/items/maelstrom_plate_body_refined", 10],
      ["/items/maelstrom_plate_legs_refined", 10],
      ["/items/pathbreaker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/sinister_cape_refined", 10],
      ["/items/grandmaster_defense_charm", 10],
      ["/items/earrings_of_armor", 10],
      ["/items/fighter_necklace", 10],
      ["/items/ring_of_armor", 10],
      ["/items/expert_task_badge", 10],
      ["/items/guzzling_pouch", 10],
    ],
    abilities: [
      ["/abilities/provoke", 10],
      ["/abilities/taunt", 10],
      ["/abilities/toughness", 10],
      ["/abilities/spike_shell", 10],
      ["/abilities/guardian_aura", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_defense_coffee", "/items/ultra_stamina_coffee", "/items/super_defense_coffee"],
  },

  // Heals other units, which is the only build that routinely reads and writes
  // state on a unit that is not itself.
  healer: {
    label: "healer",
    equipment: [
      ["/items/chaotic_flail_refined", 10],
      ["/items/bishops_codex_refined", 10],
      ["/items/magicians_hat_refined", 10],
      ["/items/royal_nature_robe_top_refined", 10],
      ["/items/royal_nature_robe_bottoms_refined", 10],
      ["/items/pathseeker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/enchanted_cloak_refined", 10],
      ["/items/grandmaster_magic_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/heal", 10],
      ["/abilities/rejuvenate", 10],
      ["/abilities/quick_aid", 10],
      ["/abilities/mystic_aura", 10],
      ["/abilities/revive", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_intelligence_coffee", "/items/channeling_coffee", "/items/wisdom_coffee"],
  },

  // Five auras and nothing else: every buff slot occupied, permanently, on
  // every unit. Deliberately pathological for anything that scans the buff
  // list per event. Not a build anybody would play — it is a stress test.
  buffstack: {
    label: "buff stack (stress)",
    equipment: [
      ["/items/regal_sword_refined", 10],
      ["/items/knights_aegis_refined", 10],
      ["/items/acrobatic_hood_refined", 10],
      ["/items/anchorbound_plate_body_refined", 10],
      ["/items/anchorbound_plate_legs_refined", 10],
      ["/items/pathbreaker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/sinister_cape_refined", 10],
      ["/items/grandmaster_attack_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/critical_aura", 10],
      ["/abilities/fierce_aura", 10],
      ["/abilities/speed_aura", 10],
      ["/abilities/guardian_aura", 10],
      ["/abilities/mystic_aura", 10],
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_melee_coffee", "/items/ultra_attack_coffee", "/items/critical_coffee"],
  },

  // The recompute storm. `buffstack` is five AURAS — applied once and then
  // permanent, so it stresses the per-event buff SCAN. This build is the other
  // half of that story: five SELF-buffs carrying fourteen buffs between them,
  // four of the five on a 30 s cooldown. Every cast rewrites the buff set and
  // forces a full stat recompute, and every expiry forces another, so the cost
  // lands on the APPLY path rather than the read path.
  //
  // It exists because a user reported that "abilities like elemental affinity"
  // made simulations crawl, and a controlled sweep confirmed it: on an
  // otherwise identical magic build, adding `elemental_affinity` alone took a
  // simulated hour from 6.1 to 11.9 ms, and `toughness` (four buffs, 30 s) to
  // 14.0 — the single most expensive ability in the game at the time. Nothing
  // in the candle isolated that, so the sweep could not be replayed from the
  // committed cases. Now it can.
  //
  // Not a build anybody would play — the abilities are drawn from three
  // different combat styles on purpose, to maximise buffs per cast.
  selfbuff: {
    label: "self-buff churn (stress)",
    equipment: [
      ["/items/regal_sword_refined", 10],
      ["/items/knights_aegis_refined", 10],
      ["/items/acrobatic_hood_refined", 10],
      ["/items/anchorbound_plate_body_refined", 10],
      ["/items/anchorbound_plate_legs_refined", 10],
      ["/items/pathbreaker_boots_refined", 10],
      ["/items/dodocamel_gauntlets_refined", 10],
      ["/items/sinister_cape_refined", 10],
      ["/items/grandmaster_attack_charm", 10],
      ...ENDGAME_ACCESSORIES,
    ],
    abilities: [
      ["/abilities/toughness", 10],            // 4 buffs, 30 s
      ["/abilities/elemental_affinity", 10],   // 3 buffs, 30 s
      ["/abilities/precision", 10],            // 1 buff,  30 s
      ["/abilities/berserk", 10],              // 1 buff,  30 s
      ["/abilities/invincible", 10],           // 5 buffs, 90 s
    ],
    food: ENDGAME_FOOD,
    drinks: ["/items/ultra_melee_coffee", "/items/ultra_attack_coffee", "/items/critical_coffee"],
  },
};

// A realistic five-person dungeon group, in the order a party would be built.
export const MIXED_PARTY = ["tank", "healer", "melee", "ranged", "magic"];

// ---- cases ------------------------------------------------------------------
// EVERY CASE MUST BE A PARTY THE GAME WOULD ALLOW. Open zones cap the party at
// 3 and most single-monster zones at 1; only dungeons take 5. csim does not
// enforce this and will happily simulate five players against a fly, but a
// rival engine is entitled to assume its caller validated first — metz's wasm
// kernel traps outright, because its server layer checks maxPartySize before
// the kernel ever sees the job. An illegal case therefore does not compare two
// engines, it compares one engine against a crash. validateCases() below is
// run by the harness at startup so this is caught at the door rather than
// showing up as an unexplained ERR in a results table.
//
// party: a build name (all players identical) or an array of build names.
// hours: the two simulated-hour points used for the marginal fit. The pair is
//   chosen per case so the slow cases do not dominate the wall clock; the
//   REPORTED number is ms per simulated hour, which is comparable across pairs.

export const CASES = [
  // --- engine floor ---
  { id: "floor-solo",      party: "bare",        n: 1, level: 10,  zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "floor-party",     party: "bare",        n: 3, level: 50,  zone: "smelly_planet",       tier: 0, hours: [2, 10] },

  // --- gear depth ---
  { id: "starter-solo",    party: "starter",     n: 1, level: 20,  zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "mid-solo",        party: "mid-melee",   n: 1, level: 60,  zone: "gobo_planet",         tier: 0, hours: [2, 10] },

  // --- endgame styles, one player, one monster ---
  { id: "melee-solo",      party: "melee",       n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "ranged-solo",     party: "ranged",      n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "magic-solo",      party: "magic",       n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "tank-solo",       party: "tank",        n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "healer-solo",     party: "healer",      n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "buffstack-solo",  party: "buffstack",   n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },
  { id: "selfbuff-solo",   party: "selfbuff",    n: 1, level: 200, zone: "fly",                 tier: 0, hours: [2, 10] },

  // --- multi-spawn zones: deeper queue, several live monsters ---
  { id: "melee-swarm",     party: "melee",       n: 1, level: 200, zone: "aqua_planet",         tier: 0, hours: [2, 10] },
  { id: "melee-abyss",     party: "melee",       n: 1, level: 200, zone: "infernal_abyss",      tier: 0, hours: [2, 10] },
  { id: "magic-abyss-t3",  party: "magic",       n: 1, level: 600, zone: "infernal_abyss",      tier: 3, hours: [2, 10] },

  // --- open-zone parties ---
  { id: "party2-eyes",     party: "melee",       n: 2, level: 200, zone: "planet_of_the_eyes",  tier: 0, hours: [1, 5] },
  { id: "party3-swarm",    party: MIXED_PARTY,   n: 3, level: 200, zone: "aqua_planet",         tier: 0, hours: [1, 5] },
  { id: "party3-sorcerer", party: MIXED_PARTY,   n: 3, level: 600, zone: "sorcerers_tower",     tier: 1, hours: [1, 5] },

  // --- dungeons: the load users actually wait on ---
  { id: "dungeon-den-200", party: MIXED_PARTY,   n: 5, level: 200, zone: "chimerical_den",      tier: 0, hours: [1, 5] },
  { id: "dungeon-den-600", party: MIXED_PARTY,   n: 5, level: 600, zone: "chimerical_den",      tier: 0, hours: [1, 5] },
  { id: "dungeon-circus",  party: MIXED_PARTY,   n: 5, level: 600, zone: "sinister_circus",     tier: 0, hours: [1, 5] },
  { id: "dungeon-fort-t2", party: MIXED_PARTY,   n: 5, level: 600, zone: "enchanted_fortress",  tier: 2, hours: [1, 5] },
  { id: "dungeon-pirate",  party: MIXED_PARTY,   n: 5, level: 600, zone: "pirate_cove",         tier: 0, hours: [1, 5] },
];

/**
 * Assert every case is legal against the game data, and that every build it
 * names exists. Throws with all violations at once rather than the first.
 *
 * @param actionData the engine's actionDetailMap
 */
export function validateCases(actionData, cases = CASES) {
  const bad = [];
  for (const kase of cases) {
    const action = actionData[`/actions/combat/${kase.zone}`];
    if (!action) {
      bad.push(`${kase.id}: no such combat zone "${kase.zone}"`);
      continue;
    }
    const maxParty = Number(action.maxPartySize) || 0;
    if (maxParty > 0 && kase.n > maxParty) {
      bad.push(`${kase.id}: party of ${kase.n} but ${kase.zone} allows ${maxParty}`);
    }
    const maxTier = Number(action.maxDifficulty) || 0;
    if (kase.tier < 0 || kase.tier > maxTier) {
      bad.push(`${kase.id}: tier ${kase.tier} but ${kase.zone} has tiers 0..${maxTier}`);
    }
    for (const name of partyBuilds(kase)) {
      if (!BUILDS[name]) bad.push(`${kase.id}: no such build "${name}"`);
    }
    const [h0, h1] = kase.hours || [];
    if (!(h1 > h0 && h0 > 0)) bad.push(`${kase.id}: hours must be an increasing positive pair`);
  }
  if (bad.length) throw new Error(`bench: invalid case(s)\n  ${bad.join("\n  ")}`);
}

// Resolve a case's `party` + `n` to a list of build names, one per player.
export function partyBuilds(kase) {
  const spec = Array.isArray(kase.party) ? kase.party : [kase.party];
  return Array.from({ length: kase.n }, (_, i) => spec[i % spec.length]);
}

// ---- adapters ---------------------------------------------------------------
// Both take the SAME build declaration and the SAME item/ability data shape.
// `items` and `abilityData` are whichever game-data maps the target engine
// ships, so each engine is fed gear it agrees exists.

function trigger(t) {
  return {
    dependencyHrid: t.dependencyHrid,
    conditionHrid: t.conditionHrid,
    comparatorHrid: t.comparatorHrid,
    value: t.value,
  };
}

// Throw loudly on an unknown hrid. A build that silently loses its weapon is a
// benchmark that silently measures something else.
function mustItem(items, hrid, what) {
  const item = items[hrid];
  if (!item) throw new Error(`bench: unknown ${what} "${hrid}" — game data has no such item`);
  return item;
}

/** csim player DTO (src/combatsimulator/player.js Player.createFromDTO). */
export function toCsimPlayer(build, { level, index, items, abilityData }) {
  const equipment = {};
  for (const [hrid, enh] of build.equipment) {
    const type = mustItem(items, hrid, "equipment").equipmentDetail?.type;
    if (!type) throw new Error(`bench: "${hrid}" is not equipment`);
    equipment[type] = { hrid, enhancementLevel: enh };
  }

  // Food, drinks and abilities all need an explicit `triggers` array —
  // createFromDTO maps over it unconditionally and throws on undefined.
  const consumable = (hrid) => ({
    hrid,
    triggers: (mustItem(items, hrid, "consumable").consumableDetail?.defaultCombatTriggers || []).map(trigger),
  });

  return {
    hrid: "player" + index,
    staminaLevel: level,
    intelligenceLevel: level,
    attackLevel: level,
    meleeLevel: level,
    defenseLevel: level,
    rangedLevel: level,
    magicLevel: level,
    equipment,
    food: build.food.map(consumable),
    drinks: build.drinks.map(consumable),
    abilities: build.abilities.map(([hrid, abilityLevel]) => {
      const detail = abilityData[hrid];
      if (!detail) throw new Error(`bench: unknown ability "${hrid}"`);
      return { hrid, level: abilityLevel, triggers: (detail.defaultCombatTriggers || []).map(trigger) };
    }),
    houseRooms: {},
    achievements: {},
    debuffOnLevelGap: 0,
  };
}

/** metz kernel player (server/zoneImport.mjs record/loadout shape). */
export function toMetzPlayer(build, { level, index, items }) {
  for (const [hrid] of build.equipment) mustItem(items, hrid, "equipment");
  return {
    record: {
      name: "player" + index,
      levels: {
        stamina: level,
        intelligence: level,
        attack: level,
        melee: level,
        defense: level,
        ranged: level,
        magic: level,
      },
      rooms: {},
      combatBuffs: [],
    },
    loadout: {
      equipment: build.equipment.map(([itemHrid, enhancementLevel]) => ({ itemHrid, enhancementLevel })),
      abilities: build.abilities.map(([hrid, abilityLevel]) => ({ hrid, level: abilityLevel })),
      abilityTriggers: {},
      food: { "/action_types/combat": build.food.map((itemHrid) => ({ itemHrid })) },
      drinks: { "/action_types/combat": build.drinks.map((itemHrid) => ({ itemHrid })) },
    },
  };
}
