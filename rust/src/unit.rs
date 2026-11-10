//! combatUnit.js (with the Player / Monster updateCombatDetails preambles from
//! player.js and monster.js). Stats are persistent state mutated in place, in
//! the JS statement order (H15). Never rebuild them from scratch.

use crate::ability::Ability;
use crate::bt;
use crate::generated::BUFF_TYPE_NAMES;
use crate::buff::{Buff, BuffEntry, PermBuff};
use crate::consumable::Consumable;
use crate::data::MonsterStatic;
use crate::equipment::Equipment;
use crate::js::{self, s, S, MIN_SAFE_INTEGER};
use crate::rng::Mulberry32;
use std::rc::Rc;

macro_rules! combat_stats {
    ($($f:ident = $js:literal = $def:expr;)*) => {
        #[derive(Clone, Debug)]
        pub struct CombatStats {
            $(pub $f: f64,)*
            pub combat_style_hrid: S,
            pub damage_type: S,
            /// "" in the defaults; None when a weapon has no primaryTraining.
            pub primary_training: Option<S>,
            pub focus_training: Option<S>,
            /// Monster residual (only copied, never read by the engine).
            pub combat_style_hrids: Option<Vec<S>>,
        }
        impl Default for CombatStats {
            fn default() -> Self {
                CombatStats {
                    $($f: $def,)*
                    combat_style_hrid: s("/combat_styles/smash"),
                    damage_type: s("/damage_types/physical"),
                    primary_training: Some(s("")),
                    focus_training: Some(s("")),
                    combat_style_hrids: None,
                }
            }
        }
        pub const STAT_NAMES: &[&str] = &[$($js,)*];
        impl CombatStats {
            pub fn by_index_mut(&mut self, i: usize) -> &mut f64 {
                let mut k = 0usize;
                $(if i == k { return &mut self.$f; } k += 1;)*
                let _ = k;
                panic!("stat index out of range")
            }
            pub fn by_index(&self, i: usize) -> f64 {
                let mut k = 0usize;
                $(if i == k { return self.$f; } k += 1;)*
                let _ = k;
                panic!("stat index out of range")
            }
        }
    };
}

combat_stats! {
    attack_interval = "attackInterval" = 3000000000.0;
    auto_attack_damage = "autoAttackDamage" = 0.0;
    ability_damage = "abilityDamage" = 0.0;
    critical_rate = "criticalRate" = 0.0;
    critical_damage = "criticalDamage" = 0.0;
    stab_accuracy = "stabAccuracy" = 0.0;
    slash_accuracy = "slashAccuracy" = 0.0;
    smash_accuracy = "smashAccuracy" = 0.0;
    ranged_accuracy = "rangedAccuracy" = 0.0;
    magic_accuracy = "magicAccuracy" = 0.0;
    stab_damage = "stabDamage" = 0.0;
    slash_damage = "slashDamage" = 0.0;
    smash_damage = "smashDamage" = 0.0;
    ranged_damage = "rangedDamage" = 0.0;
    magic_damage = "magicDamage" = 0.0;
    defensive_damage = "defensiveDamage" = 0.0;
    task_damage = "taskDamage" = 0.0;
    physical_amplify = "physicalAmplify" = 0.0;
    water_amplify = "waterAmplify" = 0.0;
    nature_amplify = "natureAmplify" = 0.0;
    fire_amplify = "fireAmplify" = 0.0;
    healing_amplify = "healingAmplify" = 0.0;
    physical_thorns = "physicalThorns" = 0.0;
    elemental_thorns = "elementalThorns" = 0.0;
    max_hitpoints = "maxHitpoints" = 0.0;
    max_manapoints = "maxManapoints" = 0.0;
    stab_evasion = "stabEvasion" = 0.0;
    slash_evasion = "slashEvasion" = 0.0;
    smash_evasion = "smashEvasion" = 0.0;
    ranged_evasion = "rangedEvasion" = 0.0;
    magic_evasion = "magicEvasion" = 0.0;
    armor = "armor" = 0.0;
    water_resistance = "waterResistance" = 0.0;
    nature_resistance = "natureResistance" = 0.0;
    fire_resistance = "fireResistance" = 0.0;
    life_steal = "lifeSteal" = 0.0;
    hp_regen_per10 = "hpRegenPer10" = 0.01;
    mp_regen_per10 = "mpRegenPer10" = 0.01;
    combat_drop_rate = "combatDropRate" = 0.0;
    combat_drop_quantity = "combatDropQuantity" = 0.0;
    combat_rare_find = "combatRareFind" = 0.0;
    combat_experience = "combatExperience" = 0.0;
    food_slots = "foodSlots" = 1.0;
    drink_slots = "drinkSlots" = 1.0;
    armor_penetration = "armorPenetration" = 0.0;
    water_penetration = "waterPenetration" = 0.0;
    nature_penetration = "naturePenetration" = 0.0;
    fire_penetration = "firePenetration" = 0.0;
    mana_leech = "manaLeech" = 0.0;
    cast_speed = "castSpeed" = 0.0;
    threat = "threat" = 100.0;
    parry = "parry" = 0.0;
    mayhem = "mayhem" = 0.0;
    pierce = "pierce" = 0.0;
    curse = "curse" = 0.0;
    ripple = "ripple" = 0.0;
    bloom = "bloom" = 0.0;
    blaze = "blaze" = 0.0;
    weaken = "weaken" = 0.0;
    fury = "fury" = 0.0;
    food_haste = "foodHaste" = 0.0;
    drink_concentration = "drinkConcentration" = 0.0;
    damage_taken = "damageTaken" = 0.0;
    attack_speed = "attackSpeed" = 0.0;
    armor_damage_ratio = "armorDamageRatio" = 0.0;
    hp_drain_ratio = "hpDrainRatio" = 0.0;
    stamina_experience = "staminaExperience" = 0.0;
    intelligence_experience = "intelligenceExperience" = 0.0;
    attack_experience = "attackExperience" = 0.0;
    defense_experience = "defenseExperience" = 0.0;
    melee_experience = "meleeExperience" = 0.0;
    ranged_experience = "rangedExperience" = 0.0;
    magic_experience = "magicExperience" = 0.0;
    retaliation = "retaliation" = 0.0;
    max_hitpoints_ratio = "maxHitpointsRatio" = 0.0;
    max_manapoints_ratio = "maxManapointsRatio" = 0.0;
    ability_haste = "abilityHaste" = 0.0;
    tenacity = "tenacity" = 0.0;
}

pub fn stat_index(name: &str) -> Option<usize> {
    STAT_NAMES.iter().position(|n| *n == name)
}

/// EQUIPMENT_COMBAT_STATS as CombatStats indices (GameData::from_json rejects unknown names first).
pub fn equipment_stat_idx() -> &'static [usize] {
    static IDX: std::sync::OnceLock<Vec<usize>> = std::sync::OnceLock::new();
    IDX.get_or_init(|| crate::generated::EQUIPMENT_COMBAT_STATS.iter().map(|n| stat_index(n).unwrap_or(0)).collect())
}

/// Level slots, in LEVEL_STATS order.
pub const STAMINA: usize = 0;
pub const INTELLIGENCE: usize = 1;
pub const ATTACK: usize = 2;
pub const MELEE: usize = 3;
pub const DEFENSE: usize = 4;
pub const RANGED: usize = 5;
pub const MAGIC: usize = 6;
pub const LEVEL_NAMES: [&str; 7] = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"];

#[derive(Clone, Debug)]
pub struct CombatDetails {
    /// staminaLevel .. magicLevel, boosted.
    pub levels: [f64; 7],
    pub max_hitpoints: f64,
    pub current_hitpoints: f64,
    pub max_manapoints: f64,
    pub current_manapoints: f64,
    /// stab, slash, smash, ranged, magic
    pub accuracy_rating: [f64; 5],
    pub max_damage: [f64; 5],
    pub evasion_rating: [f64; 5],
    pub defensive_max_damage: f64,
    pub total_armor: f64,
    pub total_water_resistance: f64,
    pub total_nature_resistance: f64,
    pub total_fire_resistance: f64,
    /// combatDetails.abilityHaste / .tenacity: declared, never written by the engine.
    pub ability_haste: f64,
    pub tenacity: f64,
    pub total_threat: f64,
    pub cs: CombatStats,
}

impl Default for CombatDetails {
    fn default() -> Self {
        CombatDetails {
            levels: [1.0; 7],
            max_hitpoints: 110.0,
            current_hitpoints: 110.0,
            max_manapoints: 110.0,
            current_manapoints: 110.0,
            accuracy_rating: [11.0; 5],
            max_damage: [11.0; 5],
            evasion_rating: [11.0; 5],
            defensive_max_damage: 0.0,
            total_armor: 0.2,
            total_water_resistance: 0.4,
            total_nature_resistance: 0.4,
            total_fire_resistance: 0.4,
            ability_haste: 0.0,
            tenacity: 0.0,
            total_threat: 100.0,
            cs: CombatStats::default(),
        }
    }
}

pub const STAB: usize = 0;
pub const SLASH: usize = 1;
pub const SMASH: usize = 2;
pub const RANGED_STYLE: usize = 3;
pub const MAGIC_STYLE: usize = 4;

pub fn style_index(hrid: &str) -> Option<usize> {
    match hrid {
        "/combat_styles/stab" => Some(STAB),
        "/combat_styles/slash" => Some(SLASH),
        "/combat_styles/smash" => Some(SMASH),
        "/combat_styles/ranged" => Some(RANGED_STYLE),
        "/combat_styles/magic" => Some(MAGIC_STYLE),
        _ => None,
    }
}

pub struct PlayerPart {
    /// Object.values(this.equipment) order: the 10 default slots, then DTO-only slots (H16).
    pub equipment: Vec<(S, Option<Equipment>)>,
    /// EQUIPMENT_COMBAT_STATS sums, computed once (equipment never changes in a run).
    pub totals: Vec<f64>,
}

impl PlayerPart {
    pub fn slot(&self, k: &str) -> Option<&Equipment> {
        self.equipment.iter().find(|(kk, _)| &**kk == k).and_then(|(_, e)| e.as_ref())
    }
}

pub struct MonsterPart {
    pub st: Rc<MonsterStatic>,
    pub difficulty_tier: f64,
    pub room_level: f64,
    pub trial_hp_scale_factor: f64,
    pub trial_attack_speed_bonus: f64,
    pub trial_cast_speed_bonus: f64,
    pub trial_ability_haste_bonus: f64,
}

pub enum UnitKind {
    Player(PlayerPart),
    Monster(MonsterPart),
}

pub struct Unit {
    pub uid: u32,
    pub is_player: bool,
    pub hrid: S,
    pub is_stunned: bool,
    pub stun_expire_time: Option<f64>,
    pub is_blinded: bool,
    pub blind_expire_time: Option<f64>,
    pub is_silenced: bool,
    pub silence_expire_time: Option<f64>,
    pub is_out_of_mana: bool,
    pub pending_action_count: u32,
    /// Unboosted base levels (staminaLevel .. magicLevel on the unit).
    pub base: [f64; 7],
    pub experience: f64,
    pub experience_rate: f64,
    pub enrage_time: f64,
    pub abilities: Vec<Option<Ability>>,
    pub food: Vec<Option<Consumable>>,
    pub drinks: Vec<Option<Consumable>>,
    /// Each house room's buffs (actionBuffs then globalBuffs), in DTO entry order.
    pub house_rooms: Vec<(S, Vec<Buff>)>,
    /// `achievements.buffs`; None for monsters (`achievements = null`).
    pub achievement_buffs: Option<Vec<Buff>>,
    pub ability_mana_costs: Vec<(S, f64)>,
    pub cd: CombatDetails,
    /// `combatBuffs` in key order; the key is kept apart from the entry (H11).
    pub combat_buffs: Vec<(S, BuffEntry)>,
    /// `buffInstances`, uniqueHrid -> instances (H12).
    pub buff_instances: Vec<(S, Vec<BuffEntry>)>,
    /// `permanentBuffs`, typeHrid -> entry, first-seen order, never deleted (H13).
    pub permanent_buffs: Vec<(S, PermBuff)>,
    pub zone_buffs: Vec<Buff>,
    pub extra_buffs: Vec<Buff>,
    /// DTO `debuffOnLevelGap` (H26).
    pub debuff_on_level_gap: crate::sim_result::Gap,
    pub kind: UnitKind,
}

impl Unit {
    pub fn blank(uid: u32, is_player: bool, hrid: S, kind: UnitKind) -> Unit {
        Unit {
            uid,
            is_player,
            hrid,
            is_stunned: false,
            stun_expire_time: None,
            is_blinded: false,
            blind_expire_time: None,
            is_silenced: false,
            silence_expire_time: None,
            is_out_of_mana: false,
            pending_action_count: 0,
            base: [1.0; 7],
            experience: 0.0,
            experience_rate: 0.0,
            enrage_time: 0.0,
            abilities: vec![None, None, None, None],
            food: vec![None, None, None],
            drinks: vec![None, None, None],
            house_rooms: Vec::new(),
            achievement_buffs: None,
            ability_mana_costs: Vec::new(),
            cd: CombatDetails::default(),
            combat_buffs: Vec::new(),
            buff_instances: Vec::new(),
            permanent_buffs: Vec::new(),
            zone_buffs: Vec::new(),
            extra_buffs: Vec::new(),
            debuff_on_level_gap: crate::sim_result::Gap::Undef,
            kind,
        }
    }

    pub fn alive(&self) -> bool {
        self.cd.current_hitpoints > 0.0
    }

    pub fn player(&self) -> Option<&PlayerPart> {
        match &self.kind {
            UnitKind::Player(p) => Some(p),
            _ => None,
        }
    }

    pub fn monster(&self) -> Option<&MonsterPart> {
        match &self.kind {
            UnitKind::Monster(m) => Some(m),
            _ => None,
        }
    }

    // ---- buff boost queries (the index/epoch cache in JS is memoisation only) ----

    /// `_buffBoostFor` for every type in one pass: each type still sums its
    /// records in combatBuffs order, from 0, so entry `ord` is exactly JS's boost for it.
    fn boost_table(&self) -> [(f64, f64); BUFF_TYPE_NAMES.len()] {
        let mut t = [(0.0, 0.0); BUFF_TYPE_NAMES.len()];
        for (_, b) in &self.combat_buffs {
            let e = &mut t[b.type_ord as usize];
            e.0 += b.ratio_boost;
            e.1 += b.flat_boost;
        }
        t
    }

    /// `_buffBoostsFor`: the (ratio, flat) records of one type, in order.
    fn boosts(&self, ord: u16) -> Vec<(f64, f64)> {
        self.combat_buffs
            .iter()
            .filter(|(_, b)| b.type_ord == ord)
            .map(|(_, b)| (b.ratio_boost, b.flat_boost))
            .collect()
    }

    // ---- updateCombatDetails ----

    pub fn update_combat_details(&mut self) {
        match &self.kind {
            UnitKind::Player(_) => self.player_pre_update(),
            UnitKind::Monster(_) => self.monster_pre_update(),
        }
        self.base_update();
        if let UnitKind::Monster(m) = &self.kind {
            let f = m.trial_hp_scale_factor;
            if js::truthy(f) && f != 1.0 {
                self.cd.max_hitpoints = (self.cd.max_hitpoints * f).floor();
            }
        }
    }

    fn player_pre_update(&mut self) {
        let UnitKind::Player(p) = &self.kind else { return };
        let cs = &mut self.cd.cs;
        let weapon = p.slot("/equipment_types/main_hand").or_else(|| p.slot("/equipment_types/two_hand"));
        if let Some(w) = weapon {
            cs.combat_style_hrid = w.combat_style();
            cs.damage_type = w.damage_type();
            cs.attack_interval = w.get_combat_stat("attackInterval");
            cs.primary_training = w.primary_training();
        } else {
            cs.combat_style_hrid = s("/combat_styles/smash");
            cs.damage_type = s("/damage_types/physical");
            cs.attack_interval = 3000000000.0;
            cs.primary_training = Some(s("/skills/melee"));
        }
        cs.focus_training = match p.slot("/equipment_types/charm") {
            Some(c) => c.focus_training(),
            None => Some(s("")),
        };
        for (i, idx) in equipment_stat_idx().iter().enumerate() {
            *cs.by_index_mut(*idx) = p.totals[i];
        }
        if let Some(pouch) = p.slot("/equipment_types/pouch") {
            cs.food_slots = 1.0 + pouch.get_combat_stat("foodSlots");
            cs.drink_slots = 1.0 + pouch.get_combat_stat("drinkSlots");
        } else {
            cs.food_slots = 1.0;
            cs.drink_slots = 1.0;
        }
    }

    fn monster_pre_update(&mut self) {
        let UnitKind::Monster(m) = &self.kind else { return };
        let st = m.st.clone();
        let d = &st.data.combat_details;
        let tier = m.difficulty_tier;
        let level_multiplier = 1.0 + 0.25 * tier;
        let def_level_multiplier = 1.0 + 0.15 * tier;
        let level_bonus = 20.0 * tier;
        let lsf = m.room_level / 100.0;
        let (asb, csb, ahb) = (m.trial_attack_speed_bonus, m.trial_cast_speed_bonus, m.trial_ability_haste_bonus);

        self.base[STAMINA] = level_multiplier * (d.stamina_level + level_bonus) * lsf;
        self.base[INTELLIGENCE] = level_multiplier * (d.intelligence_level + level_bonus) * lsf;
        self.base[ATTACK] = level_multiplier * (d.attack_level + level_bonus) * lsf;
        self.base[MELEE] = level_multiplier * (d.melee_level + level_bonus) * lsf;
        self.base[DEFENSE] = def_level_multiplier * (d.defense_level + level_bonus) * lsf;
        self.base[RANGED] = level_multiplier * (d.ranged_level + level_bonus) * lsf;
        self.base[MAGIC] = level_multiplier * (d.magic_level + level_bonus) * lsf;

        let exp_multiplier = 1.0 + 0.5 * tier;
        let exp_bonus = 5.0 * tier;
        self.experience = exp_multiplier * (st.data.experience + exp_bonus);

        let cs = &mut self.cd.cs;
        cs.combat_style_hrid = st.style0.clone();
        for (i, v) in &st.zeroed {
            *cs.by_index_mut(*i) = *v;
        }
        if let Some(v) = st.attack_interval {
            cs.attack_interval = v;
        }
        if let Some(v) = &st.combat_style_hrids {
            cs.combat_style_hrids = Some(v.clone());
        }
        if let Some(v) = &st.damage_type {
            cs.damage_type = v.clone();
        }
        if let Some(v) = st.max_hitpoints_ratio {
            cs.max_hitpoints_ratio = v;
        }
        if let Some(v) = st.max_manapoints_ratio {
            cs.max_manapoints_ratio = v;
        }

        cs.armor *= lsf;
        cs.water_resistance *= lsf;
        cs.nature_resistance *= lsf;
        cs.fire_resistance *= lsf;

        if cs.attack_interval == 0.0 {
            cs.attack_interval = d.attack_interval;
        }

        cs.attack_speed += asb;
        cs.cast_speed += csb;
        cs.ability_haste += ahb;
    }

    /// CombatUnit.updateCombatDetails, statement for statement.
    fn base_update(&mut self) {
        if self.is_player {
            let cs = &mut self.cd.cs;
            if cs.hp_regen_per10 == 0.0 {
                cs.hp_regen_per10 = 0.01;
            } else {
                cs.hp_regen_per10 = 0.01 + cs.hp_regen_per10;
            }
            if cs.mp_regen_per10 == 0.0 {
                cs.mp_regen_per10 = 0.01;
            } else {
                cs.mp_regen_per10 = 0.01 + cs.mp_regen_per10;
            }
        }

        const LEVEL_TYPES: [u16; 7] = [
            bt!("/buff_types/stamina_level"),
            bt!("/buff_types/intelligence_level"),
            bt!("/buff_types/attack_level"),
            bt!("/buff_types/melee_level"),
            bt!("/buff_types/defense_level"),
            bt!("/buff_types/ranged_level"),
            bt!("/buff_types/magic_level"),
        ];
        for i in 0..7 {
            self.cd.levels[i] = self.base[i];
            for (_, b) in self.combat_buffs.iter().filter(|(_, b)| b.type_ord == LEVEL_TYPES[i]) {
                self.cd.levels[i] += self.base[i] * b.ratio_boost;
                self.cd.levels[i] += b.flat_boost;
            }
        }

        // combat_buffs does not change inside base_update, so one table serves every query.
        let table = self.boost_table();
        let bst = |o: u16| table[o as usize];
        let max_hp_boost = bst(bt!("/buff_types/max_hitpoints"));
        let max_mp_boost = bst(bt!("/buff_types/max_manapoints"));
        let cd = &mut self.cd;
        cd.max_hitpoints = ((10.0 * (10.0 + cd.levels[STAMINA]) + cd.cs.max_hitpoints + max_hp_boost.1)
            * (1.0 + cd.cs.max_hitpoints_ratio + max_hp_boost.0))
            .floor();
        cd.max_manapoints = ((10.0 * (10.0 + cd.levels[INTELLIGENCE]) + cd.cs.max_manapoints + max_mp_boost.1)
            * (1.0 + cd.cs.max_manapoints_ratio + max_mp_boost.0))
            .floor();

        let accuracy_ratio_boost_from_fury = bst(bt!("/buff_types/fury_accuracy")).0;
        let damage_ratio_boost_from_fury = bst(bt!("/buff_types/fury_damage")).0;
        let accuracy_ratio_boost = bst(bt!("/buff_types/accuracy")).0;
        let damage_ratio_boost = bst(bt!("/buff_types/damage")).0;

        let evasion_boosts = self.boosts(bt!("/buff_types/evasion"));
        {
            let cd = &mut self.cd;
            let style_acc = [cd.cs.stab_accuracy, cd.cs.slash_accuracy, cd.cs.smash_accuracy];
            let style_dmg = [cd.cs.stab_damage, cd.cs.slash_damage, cd.cs.smash_damage];
            let style_eva = [cd.cs.stab_evasion, cd.cs.slash_evasion, cd.cs.smash_evasion];
            for i in 0..3 {
                cd.accuracy_rating[i] = (10.0 + cd.levels[ATTACK])
                    * (1.0 + style_acc[i])
                    * (1.0 + accuracy_ratio_boost)
                    * (1.0 + accuracy_ratio_boost_from_fury);
                cd.max_damage[i] = (10.0 + cd.levels[MELEE])
                    * (1.0 + style_dmg[i])
                    * (1.0 + damage_ratio_boost)
                    * (1.0 + damage_ratio_boost_from_fury);
                let base_evasion = (10.0 + cd.levels[DEFENSE]) * (1.0 + style_eva[i]);
                cd.evasion_rating[i] = base_evasion;
                for (r, f) in &evasion_boosts {
                    cd.evasion_rating[i] += *f;
                    cd.evasion_rating[i] += base_evasion * *r;
                }
            }

            cd.defensive_max_damage = (10.0 + cd.levels[DEFENSE])
                * (1.0 + cd.cs.defensive_damage)
                * (1.0 + damage_ratio_boost)
                * (1.0 + damage_ratio_boost_from_fury);
        }

        let bulwark = self
            .player()
            .and_then(|p| p.slot("/equipment_types/two_hand"))
            .map(|e| e.hrid.contains("bulwark"))
            .unwrap_or(false);
        let cd = &mut self.cd;
        if bulwark {
            cd.max_damage[SMASH] += cd.defensive_max_damage;
        }

        cd.accuracy_rating[RANGED_STYLE] = (10.0 + cd.levels[ATTACK])
            * (1.0 + cd.cs.ranged_accuracy)
            * (1.0 + accuracy_ratio_boost)
            * (1.0 + accuracy_ratio_boost_from_fury);
        cd.max_damage[RANGED_STYLE] = (10.0 + cd.levels[RANGED])
            * (1.0 + cd.cs.ranged_damage)
            * (1.0 + damage_ratio_boost)
            * (1.0 + damage_ratio_boost_from_fury);

        let base_ranged_evasion = (10.0 + cd.levels[DEFENSE]) * (1.0 + cd.cs.ranged_evasion);
        cd.evasion_rating[RANGED_STYLE] = base_ranged_evasion;
        for (r, f) in &evasion_boosts {
            cd.evasion_rating[RANGED_STYLE] += *f;
            cd.evasion_rating[RANGED_STYLE] += base_ranged_evasion * *r;
        }

        let damage_taken = bst(bt!("/buff_types/damage_taken")).1;
        let cd = &mut self.cd;
        cd.cs.damage_taken = damage_taken;

        cd.accuracy_rating[MAGIC_STYLE] = (10.0 + cd.levels[ATTACK])
            * (1.0 + cd.cs.magic_accuracy)
            * (1.0 + accuracy_ratio_boost)
            * (1.0 + accuracy_ratio_boost_from_fury);
        cd.max_damage[MAGIC_STYLE] = (10.0 + cd.levels[MAGIC])
            * (1.0 + cd.cs.magic_damage)
            * (1.0 + damage_ratio_boost)
            * (1.0 + damage_ratio_boost_from_fury);

        let base_magic_evasion = (10.0 + cd.levels[DEFENSE]) * (1.0 + cd.cs.magic_evasion);
        cd.evasion_rating[MAGIC_STYLE] = base_magic_evasion;
        for (r, f) in &evasion_boosts {
            cd.evasion_rating[MAGIC_STYLE] += *f;
            cd.evasion_rating[MAGIC_STYLE] += base_magic_evasion * *r;
        }

        let pa = bst(bt!("/buff_types/physical_amplify")).1;
        let wa = bst(bt!("/buff_types/water_amplify")).1;
        let na = bst(bt!("/buff_types/nature_amplify")).1;
        let fa = bst(bt!("/buff_types/fire_amplify")).1;
        let ha = bst(bt!("/buff_types/healing_amplify")).1;
        let attack_speed_boosts = self.boosts(bt!("/buff_types/attack_speed"));
        let armor_boosts = self.boosts(bt!("/buff_types/armor"));
        let water_boosts = self.boosts(bt!("/buff_types/water_resistance"));
        let nature_boosts = self.boosts(bt!("/buff_types/nature_resistance"));
        let fire_boosts = self.boosts(bt!("/buff_types/fire_resistance"));
        let hp_regen = bst(bt!("/buff_types/hp_regen"));
        let mp_regen = bst(bt!("/buff_types/mp_regen"));
        let life_steal = bst(bt!("/buff_types/life_steal")).1;
        let physical_thorns = bst(bt!("/buff_types/physical_thorns")).1;
        let elemental_thorns = bst(bt!("/buff_types/elemental_thorns")).1;
        let wisdom = bst(bt!("/buff_types/wisdom")).1;
        let critical_rate = bst(bt!("/buff_types/critical_rate")).1;
        let critical_damage = bst(bt!("/buff_types/critical_damage")).1;
        let cast_speed = bst(bt!("/buff_types/cast_speed")).1;
        let drop_rate = bst(bt!("/buff_types/combat_drop_rate"));
        let rare_find = bst(bt!("/buff_types/rare_find"));
        let drop_qty = bst(bt!("/buff_types/combat_drop_quantity"));
        let threat = bst(bt!("/buff_types/threat"));
        let retaliation = bst(bt!("/buff_types/retaliation")).1;
        let tenacity = bst(bt!("/buff_types/tenacity")).1;

        let cd = &mut self.cd;
        cd.cs.physical_amplify += pa;
        cd.cs.water_amplify += wa;
        cd.cs.nature_amplify += na;
        cd.cs.fire_amplify += fa;
        cd.cs.healing_amplify += ha;

        cd.cs.attack_interval /= 1.0 + (cd.levels[ATTACK] / 2000.0);

        let base_attack_speed = cd.cs.attack_speed;
        cd.cs.attack_interval /= 1.0 + base_attack_speed;
        let mut attack_interval_ratio_boost = 0.0;
        for (r, _) in &attack_speed_boosts {
            attack_interval_ratio_boost = attack_interval_ratio_boost + *r;
        }
        cd.cs.attack_interval /= 1.0 + attack_interval_ratio_boost;

        let base_armor = 0.2 * cd.levels[DEFENSE] + cd.cs.armor;
        cd.total_armor = base_armor;
        for (r, f) in &armor_boosts {
            cd.total_armor += *f;
            cd.total_armor += base_armor * *r;
        }

        let base_water = 0.2 * cd.levels[DEFENSE] + cd.cs.water_resistance;
        cd.total_water_resistance = base_water;
        for (r, f) in &water_boosts {
            cd.total_water_resistance += *f;
            cd.total_water_resistance += base_water * *r;
        }

        let base_nature = 0.2 * cd.levels[DEFENSE] + cd.cs.nature_resistance;
        cd.total_nature_resistance = base_nature;
        for (r, f) in &nature_boosts {
            cd.total_nature_resistance += *f;
            cd.total_nature_resistance += base_nature * *r;
        }

        let base_fire = 0.2 * cd.levels[DEFENSE] + cd.cs.fire_resistance;
        cd.total_fire_resistance = base_fire;
        for (r, f) in &fire_boosts {
            cd.total_fire_resistance += *f;
            cd.total_fire_resistance += base_fire * *r;
        }

        cd.cs.hp_regen_per10 += cd.cs.hp_regen_per10 * hp_regen.0;
        cd.cs.hp_regen_per10 += hp_regen.1;

        cd.cs.mp_regen_per10 += cd.cs.mp_regen_per10 * mp_regen.0;
        cd.cs.mp_regen_per10 += mp_regen.1;

        cd.cs.life_steal += life_steal;
        cd.cs.physical_thorns += physical_thorns;
        cd.cs.elemental_thorns += elemental_thorns;
        cd.cs.combat_experience += wisdom;
        cd.cs.critical_rate += critical_rate;
        cd.cs.critical_damage += critical_damage;

        cd.cs.cast_speed += cast_speed;
        cd.cs.cast_speed += cd.levels[ATTACK] / 2000.0;

        cd.cs.combat_drop_rate += (1.0 + cd.cs.combat_drop_rate) * drop_rate.0;
        cd.cs.combat_drop_rate += drop_rate.1;
        cd.cs.combat_rare_find += (1.0 + cd.cs.combat_rare_find) * rare_find.0;
        cd.cs.combat_rare_find += rare_find.1;
        cd.cs.combat_drop_quantity += (1.0 + cd.cs.combat_drop_quantity) * drop_qty.0;
        cd.cs.combat_drop_quantity += drop_qty.1;

        let base_threat = 100.0 + cd.cs.threat;
        cd.total_threat = base_threat;
        if threat.0 != 0.0 {
            cd.cs.threat += base_threat * threat.0;
        } else {
            cd.cs.threat = base_threat;
        }
        cd.cs.threat += threat.1;

        cd.cs.retaliation += retaliation;
        cd.cs.tenacity += tenacity;
    }

    // ---- buff instances ----

    fn is_active(e: &BuffEntry, now: f64) -> bool {
        !(e.expire_time <= now)
    }

    fn stronger<'a>(a: &'a BuffEntry, b: &'a BuffEntry) -> &'a BuffEntry {
        let ar = a.ratio_boost.abs();
        let br = b.ratio_boost.abs();
        if ar != br {
            return if ar > br { a } else { b };
        }
        let af = a.flat_boost.abs();
        let bf = b.flat_boost.abs();
        if af != bf {
            return if af > bf { a } else { b };
        }
        let ae = if a.expire_time.is_nan() { f64::INFINITY } else { a.expire_time };
        let be = if b.expire_time.is_nan() { f64::INFINITY } else { b.expire_time };
        if ae >= be {
            a
        } else {
            b
        }
    }

    fn effective(arr: &[BuffEntry]) -> BuffEntry {
        let mut best = &arr[0];
        for inst in &arr[1..] {
            best = Self::stronger(best, inst);
        }
        best.clone()
    }

    /// `_commitInstances`: returns whether the effective view changed.
    fn commit(&mut self, hrid: &S, arr: Vec<BuffEntry>) -> bool {
        let pos = self.combat_buffs.iter().position(|(k, _)| k == hrid);
        let ipos = self.buff_instances.iter().position(|(k, _)| k == hrid);
        if arr.is_empty() {
            if let Some(i) = ipos {
                self.buff_instances.remove(i);
            }
            if let Some(p) = pos {
                self.combat_buffs.remove(p);
                return true;
            }
            return false;
        }
        let effective = Self::effective(&arr);
        match ipos {
            Some(i) => self.buff_instances[i].1 = arr,
            None => self.buff_instances.push((hrid.clone(), arr)),
        }
        match pos {
            None => {
                self.combat_buffs.push((hrid.clone(), effective));
                true
            }
            Some(p) => {
                let prev = &self.combat_buffs[p].1;
                let changed = prev.ratio_boost != effective.ratio_boost || prev.flat_boost != effective.flat_boost;
                self.combat_buffs[p].1 = effective;
                changed
            }
        }
    }

    fn apply_buff(&mut self, buff: &Buff, now: Option<f64>, source: u32) -> bool {
        let hrid = &buff.unique_hrid;
        let mut next = Vec::new();
        if let Some((_, arr)) = self.buff_instances.iter().find(|(k, _)| k == hrid) {
            for inst in arr {
                if inst.source == source {
                    continue;
                }
                if let Some(t) = now {
                    if !Self::is_active(inst, t) {
                        continue;
                    }
                }
                next.push(inst.clone());
            }
        }
        next.push(BuffEntry {
            type_ord: buff.type_ord,
            ratio_boost: buff.ratio_boost,
            flat_boost: buff.flat_boost,
            expire_time: match now {
                Some(t) => t + buff.duration,
                None => f64::NAN,
            },
            source,
        });
        self.commit(&hrid.clone(), next)
    }

    fn remove_buff_instance(&mut self, buff: &Buff, source: u32) -> bool {
        let hrid = &buff.unique_hrid;
        let Some((_, arr)) = self.buff_instances.iter().find(|(k, _)| k == hrid) else { return false };
        if arr.is_empty() || !arr.iter().any(|i| i.source == source) {
            return false;
        }
        let filtered: Vec<BuffEntry> = arr.iter().filter(|i| i.source != source).cloned().collect();
        self.commit(&hrid.clone(), filtered)
    }

    /// `addBuffs(buffs, currentTime, sourceRef = this)`.
    pub fn add_buffs(&mut self, buffs: &[Buff], now: Option<f64>, source: Option<u32>) {
        let src = source.unwrap_or(self.uid);
        let mut need = false;
        for b in buffs {
            if self.apply_buff(b, now, src) {
                need = true;
            }
        }
        if need {
            self.update_combat_details();
        }
    }

    pub fn add_buff(&mut self, buff: &Buff, now: Option<f64>, source: Option<u32>) {
        let src = source.unwrap_or(self.uid);
        if self.apply_buff(buff, now, src) {
            self.update_combat_details();
        }
    }

    pub fn remove_buffs(&mut self, buffs: &[Buff]) {
        let src = self.uid;
        let mut need = false;
        for b in buffs {
            if self.remove_buff_instance(b, src) {
                need = true;
            }
        }
        if need {
            self.update_combat_details();
        }
    }

    fn add_permanent_buff(&mut self, b: &Buff) {
        if let Some((_, p)) = self.permanent_buffs.iter_mut().find(|(k, _)| *k == b.type_hrid) {
            p.flat_boost += b.flat_boost;
            p.ratio_boost += b.ratio_boost;
        } else {
            self.permanent_buffs.push((
                b.type_hrid.clone(),
                PermBuff { type_ord: b.type_ord, ratio_boost: b.ratio_boost, flat_boost: b.flat_boost },
            ));
        }
    }

    pub fn generate_permanent_buffs(&mut self) {
        let mut all: Vec<Buff> = Vec::new();
        for (_, bs) in &self.house_rooms {
            all.extend(bs.iter().cloned());
        }
        if let Some(a) = &self.achievement_buffs {
            all.extend(a.iter().cloned());
        }
        all.extend(self.zone_buffs.iter().cloned());
        all.extend(self.extra_buffs.iter().cloned());
        for b in &all {
            self.add_permanent_buff(b);
        }
    }

    pub fn remove_expired_buffs(&mut self, now: f64) {
        let keys: Vec<S> = self.buff_instances.iter().map(|(k, _)| k.clone()).collect();
        let mut changed = false;
        for hrid in keys {
            let Some((_, arr)) = self.buff_instances.iter().find(|(k, _)| *k == hrid) else { continue };
            if !arr.iter().any(|i| !Self::is_active(i, now)) {
                continue;
            }
            let filtered: Vec<BuffEntry> = arr.iter().filter(|i| Self::is_active(i, now)).cloned().collect();
            if self.commit(&hrid, filtered) {
                changed = true;
            }
        }
        if changed {
            self.update_combat_details();
        }
    }

    pub fn clear_buffs(&mut self) {
        self.buff_instances.clear();
        self.combat_buffs = self
            .permanent_buffs
            .iter()
            .map(|(k, p)| {
                (
                    k.clone(),
                    BuffEntry { type_ord: p.type_ord, ratio_boost: p.ratio_boost, flat_boost: p.flat_boost, expire_time: f64::NAN, source: 0 },
                )
            })
            .collect();
        self.update_combat_details();
    }

    pub fn clear_ccs(&mut self) {
        self.is_stunned = false;
        self.stun_expire_time = None;
        self.is_silenced = false;
        self.silence_expire_time = None;
        self.is_blinded = false;
        self.blind_expire_time = None;
        self.cd.cs.damage_taken = 0.0;
    }

    /// `reset(currentTime = 0)`. `random_start` is resolveMonsterStartCooldown() === "random".
    pub fn reset(&mut self, now: f64, random_start: bool, rng: &mut Mulberry32) {
        self.clear_ccs();
        if now == 0.0 || !self.is_player {
            self.clear_buffs();
            self.reset_cooldowns(now, random_start, rng);
        } else {
            self.remove_expired_buffs(now);
        }
        self.cd.current_hitpoints = self.cd.max_hitpoints;
        self.cd.current_manapoints = self.cd.max_manapoints;
    }

    pub fn reset_cooldowns(&mut self, now: f64, random_start: bool, rng: &mut Mulberry32) {
        for f in self.food.iter_mut().flatten() {
            f.last_used = MIN_SAFE_INTEGER;
        }
        for d in self.drinks.iter_mut().flatten() {
            d.last_used = MIN_SAFE_INTEGER;
        }
        let haste = self.cd.cs.ability_haste;
        let is_player = self.is_player;
        for a in self.abilities.iter_mut().flatten() {
            if is_player {
                a.last_used = MIN_SAFE_INTEGER;
            } else {
                let mut cooldown = a.cooldown_duration;
                if haste > 0.0 {
                    cooldown = cooldown * 100.0 / (100.0 + haste);
                }
                if !random_start {
                    a.last_used = now - (cooldown * 0.5).floor();
                } else {
                    a.last_used = now - (cooldown * 0.5).floor() + (rng.next_f64() * cooldown * 0.5).floor();
                }
            }
        }
    }

    pub fn add_hitpoints(&mut self, hp: f64) -> f64 {
        if self.cd.current_hitpoints >= self.cd.max_hitpoints {
            return 0.0;
        }
        let new = js::min(self.cd.current_hitpoints + hp, self.cd.max_hitpoints);
        let added = new - self.cd.current_hitpoints;
        self.cd.current_hitpoints = new;
        added
    }

    pub fn add_manapoints(&mut self, mp: f64) -> f64 {
        if self.cd.current_manapoints >= self.cd.max_manapoints {
            return 0.0;
        }
        let new = js::min(self.cd.current_manapoints + mp, self.cd.max_manapoints);
        let added = new - self.cd.current_manapoints;
        self.cd.current_manapoints = new;
        added
    }

    /// `combatStats[type + "Experience"]`.
    pub fn skill_experience(&self, i: usize) -> f64 {
        let cs = &self.cd.cs;
        match i {
            STAMINA => cs.stamina_experience,
            INTELLIGENCE => cs.intelligence_experience,
            ATTACK => cs.attack_experience,
            MELEE => cs.melee_experience,
            DEFENSE => cs.defense_experience,
            RANGED => cs.ranged_experience,
            _ => cs.magic_experience,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated;

    #[test]
    fn generated_names_resolve() {
        for n in generated::EQUIPMENT_COMBAT_STATS.iter().chain(generated::MONSTER_ZEROED_COMBAT_STATS) {
            assert!(stat_index(n).is_some(), "{n}");
        }
        for n in generated::MONSTER_RESIDUAL_STATS {
            assert!(stat_index(n).is_some() || *n == "combatStyleHrids" || *n == "damageType", "{n}");
        }
        let mut sorted = generated::BUFF_TYPE_NAMES.to_vec();
        sorted.sort();
        assert_eq!(sorted, generated::BUFF_TYPE_NAMES);
        for (i, n) in STAT_NAMES.iter().enumerate() {
            let mut cs = CombatStats::default();
            *cs.by_index_mut(i) = 7.5;
            assert_eq!(cs.by_index(i), 7.5, "{n}");
        }
    }
}
