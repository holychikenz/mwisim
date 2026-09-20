import { resolveMonsterStartCooldown } from "./simSettings";
import { BUFF_TYPE_COUNT, buffTypeOrdinal } from "./generated/buffTypes";

// MWIX adaptation (performance): the result for a buff type nothing grants.
// Frozen because getBuffBoosts hands it to callers directly, and a caller that
// pushed onto it would poison every unit in the simulation at once.
const EMPTY_BUFF_BOOSTS = Object.freeze([]);

// =============================================================================
// MWIX adaptation (performance): the two per-stat key tables that
// updateCombatDetails() used to rebuild on every call.
//
// Upstream writes both loops as an INLINE array literal driven by `.forEach`,
// with the property names formed by string concatenation inside the body —
// `this.combatDetails[stat + "Level"]`, `"/buff_types/" + stat + "_level"`,
// `combatStats[style + "Accuracy"]`, and so on. That is one array allocation
// plus ~30 string concatenations and two closure allocations EVERY recompute,
// and updateCombatDetails is the hottest method in the engine (a CPU profile of
// magic-solo + buffstack-solo attributed 3.9% of self time to the styles
// closure alone and 2.0% to the levels closure).
//
// Precomputing the concatenated keys once changes nothing about WHAT is read or
// written, or in WHAT ORDER — only when the strings are built. No arithmetic is
// reordered, so the floating-point results are bit-identical; sim:check stayed
// 3/3.
// =============================================================================
const LEVEL_STATS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"].map(
    (stat) => ({
        levelKey: stat + "Level",
        buffType: "/buff_types/" + stat + "_level",
        // Interned once at module load — see the ordinal block below.
        buffTypeOrd: buffTypeOrdinal("/buff_types/" + stat + "_level"),
    })
);

// =============================================================================
// MWIX adaptation (performance): the buff-type ordinals this file queries.
//
// A CPU profile of the candle put buff aggregation at ~16.5% of self time on
// dungeon-den-600 — _buildBuffBoostIndex at 9.39% and getBuffBoost at 3.28% —
// and updateCombatDetails alone asks for ~35 boosts on every recompute. Each
// ask was a string-keyed Map lookup. Interning the hrids once, at module load,
// turns all of them into an array index.
//
// The names come from the GENERATED table (tools/genBuffTypes.mjs), and
// buffTypeOrdinal THROWS on an hrid it has never seen, so a typo here is a
// startup crash rather than a buff that silently contributes nothing.
// =============================================================================
const BT_ACCURACY = buffTypeOrdinal("/buff_types/accuracy");
const BT_ARMOR = buffTypeOrdinal("/buff_types/armor");
const BT_ATTACK_SPEED = buffTypeOrdinal("/buff_types/attack_speed");
const BT_CAST_SPEED = buffTypeOrdinal("/buff_types/cast_speed");
const BT_COMBAT_DROP_QUANTITY = buffTypeOrdinal("/buff_types/combat_drop_quantity");
const BT_COMBAT_DROP_RATE = buffTypeOrdinal("/buff_types/combat_drop_rate");
const BT_CRITICAL_DAMAGE = buffTypeOrdinal("/buff_types/critical_damage");
const BT_CRITICAL_RATE = buffTypeOrdinal("/buff_types/critical_rate");
const BT_DAMAGE = buffTypeOrdinal("/buff_types/damage");
const BT_DAMAGE_TAKEN = buffTypeOrdinal("/buff_types/damage_taken");
const BT_ELEMENTAL_THORNS = buffTypeOrdinal("/buff_types/elemental_thorns");
const BT_EVASION = buffTypeOrdinal("/buff_types/evasion");
const BT_FIRE_AMPLIFY = buffTypeOrdinal("/buff_types/fire_amplify");
const BT_FIRE_RESISTANCE = buffTypeOrdinal("/buff_types/fire_resistance");
const BT_FURY_ACCURACY = buffTypeOrdinal("/buff_types/fury_accuracy");
const BT_FURY_DAMAGE = buffTypeOrdinal("/buff_types/fury_damage");
const BT_HEALING_AMPLIFY = buffTypeOrdinal("/buff_types/healing_amplify");
const BT_HP_REGEN = buffTypeOrdinal("/buff_types/hp_regen");
const BT_LIFE_STEAL = buffTypeOrdinal("/buff_types/life_steal");
const BT_MAX_HITPOINTS = buffTypeOrdinal("/buff_types/max_hitpoints");
const BT_MAX_MANAPOINTS = buffTypeOrdinal("/buff_types/max_manapoints");
const BT_MP_REGEN = buffTypeOrdinal("/buff_types/mp_regen");
const BT_NATURE_AMPLIFY = buffTypeOrdinal("/buff_types/nature_amplify");
const BT_NATURE_RESISTANCE = buffTypeOrdinal("/buff_types/nature_resistance");
const BT_PHYSICAL_AMPLIFY = buffTypeOrdinal("/buff_types/physical_amplify");
const BT_PHYSICAL_THORNS = buffTypeOrdinal("/buff_types/physical_thorns");
const BT_RARE_FIND = buffTypeOrdinal("/buff_types/rare_find");
const BT_RETALIATION = buffTypeOrdinal("/buff_types/retaliation");
const BT_TENACITY = buffTypeOrdinal("/buff_types/tenacity");
const BT_THREAT = buffTypeOrdinal("/buff_types/threat");
const BT_WATER_AMPLIFY = buffTypeOrdinal("/buff_types/water_amplify");
const BT_WATER_RESISTANCE = buffTypeOrdinal("/buff_types/water_resistance");
const BT_WISDOM = buffTypeOrdinal("/buff_types/wisdom");

const ATTACK_STYLES = ["stab", "slash", "smash"].map((style) => ({
    accuracyStat: style + "Accuracy",
    damageStat: style + "Damage",
    evasionStat: style + "Evasion",
    accuracyRating: style + "AccuracyRating",
    maxDamage: style + "MaxDamage",
    evasionRating: style + "EvasionRating",
}));


class CombatUnit {
    isPlayer;
    isStunned = false;
    stunExpireTime = null;
    isBlinded = false;
    blindExpireTime = null;
    isSilenced = false;
    silenceExpireTime = null;

    isOutOfMana = false;

    // MWIX adaptation (performance): how many AutoAttack/AbilityCastEnd events
    // this unit currently has in the event queue — i.e. "am I mid-action?".
    // Owned and maintained exclusively by EventQueue, which is the only thing
    // that knows when such an event enters or leaves the heap; declared here so
    // every unit has the field from birth and the shape stays monomorphic.
    // Read it through EventQueue.hasPendingAction(), not directly.
    _pendingActionCount = 0;

    // Base levels which don't change after initialization
    staminaLevel = 1;
    intelligenceLevel = 1;
    attackLevel = 1;
    meleeLevel = 1;
    defenseLevel = 1;
    rangedLevel = 1;
    magicLevel = 1;

    experience = 0;
    experienceRate = 0;
    enrageTime = 0;

    abilities = [null, null, null, null];
    food = [null, null, null];
    drinks = [null, null, null];
    houseRooms = [];
    achievements = null;
    dropTable = [];
    rareDropTable = [];
    abilityManaCosts = new Map();

    // Calculated combat stats including temporary buffs
    combatDetails = {
        staminaLevel: 1,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
        maxHitpoints: 110,
        currentHitpoints: 110,
        maxManapoints: 110,
        currentManapoints: 110,
        stabAccuracyRating: 11,
        slashAccuracyRating: 11,
        smashAccuracyRating: 11,
        rangedAccuracyRating: 11,
        magicAccuracyRating: 11,
        stabMaxDamage: 11,
        slashMaxDamage: 11,
        smashMaxDamage: 11,
        rangedMaxDamage: 11,
        magicMaxDamage: 11,
        stabEvasionRating: 11,
        slashEvasionRating: 11,
        smashEvasionRating: 11,
        rangedEvasionRating: 11,
        magicEvasionRating: 11,
        defensiveMaxDamage: 0,
        totalArmor: 0.2,
        totalWaterResistance: 0.4,
        totalNatureResistance: 0.4,
        totalFireResistance: 0.4,
        abilityHaste: 0,
        tenacity: 0,
        totalThreat: 100,
        combatStats: {
            combatStyleHrid: "/combat_styles/smash",
            damageType: "/damage_types/physical",
            attackInterval: 3000000000,
            autoAttackDamage: 0,
            abilityDamage: 0,
            criticalRate: 0,
            criticalDamage: 0,
            stabAccuracy: 0,
            slashAccuracy: 0,
            smashAccuracy: 0,
            rangedAccuracy: 0,
            magicAccuracy: 0,
            stabDamage: 0,
            slashDamage: 0,
            smashDamage: 0,
            rangedDamage: 0,
            magicDamage: 0,
            defensiveDamage: 0,
            taskDamage: 0,
            physicalAmplify: 0,
            waterAmplify: 0,
            natureAmplify: 0,
            fireAmplify: 0,
            healingAmplify: 0,
            physicalThorns: 0,
            elementalThorns: 0,
            maxHitpoints: 0,
            maxManapoints: 0,
            stabEvasion: 0,
            slashEvasion: 0,
            smashEvasion: 0,
            rangedEvasion: 0,
            magicEvasion: 0,
            armor: 0,
            waterResistance: 0,
            natureResistance: 0,
            fireResistance: 0,
            lifeSteal: 0,
            hpRegenPer10: 0.01,
            mpRegenPer10: 0.01,
            combatDropRate: 0,
            combatDropQuantity: 0,
            combatRareFind: 0,
            combatExperience: 0,
            foodSlots: 1,
            drinkSlots: 1,
            armorPenetration: 0,
            waterPenetration: 0,
            naturePenetration: 0,
            firePenetration: 0,
            manaLeech: 0,
            castSpeed: 0,
            threat: 100,
            parry: 0,
            mayhem: 0,
            pierce: 0,
            curse: 0,
            ripple: 0,
            bloom: 0,
            blaze: 0,
            weaken: 0,
            fury: 0,
            foodHaste: 0,
            drinkConcentration: 0,
            damageTaken: 0,
            attackSpeed: 0,
            armorDamageRatio: 0,
            hpDrainRatio: 0,
            primaryTraining: "",
            focusTraining: "",
            staminaExperience: 0,
            intelligenceExperience: 0,
            attackExperience: 0,
            defenseExperience: 0,
            meleeExperience: 0,
            rangedExperience: 0,
            magicExperience: 0,
            retaliation: 0,
            maxHitpointsRatio: 0,
            maxManapointsRatio: 0,
        },
    };
    combatBuffs = {};
    // MWIX adaptation (7/15/2026 patch parity): in a party a weaker source's
    // aura/debuff no longer replaces a stronger one — the strongest ACTIVE source
    // of a buff takes effect, and when it expires the next strongest takes over.
    // We track every source's instance here (uniqueHrid -> [instance, ...]);
    // `combatBuffs` becomes the derived "effective" view (uniqueHrid -> strongest
    // active instance) that all existing readers keep consuming UNCHANGED.
    buffInstances = {};
    permanentBuffs = {};
    // MWIX adaptation (performance): a lazy ORDINAL -> boosts index over
    // `combatBuffs`, and an ordinal -> summed-boost cache over that index. Both
    // were string-keyed Maps; see _invalidateBuffBoostIndex /
    // _buildBuffBoostIndex at the bottom of the buff section for why they are
    // dense arrays now, and what is reused between rebuilds.
    _buffBoostStale = true;
    _buffBoostIndex = null;
    _buffBoostFilled = null;
    _buffBoostSums = null;
    _buffBoostSumStamp = null;
    _buffBoostEpoch = 0;
    _boostArrayPool = null;
    _boostArrayUsed = 0;
    _boostRecordPool = null;
    _boostRecordUsed = 0;
    // MWIX adaptation: zoneBuffs / extraBuffs are iterated with `.forEach`
    // in generatePermanentBuffs(). Upstream defaults them to `{}` because
    // worker.js reassigns them to arrays before each simulate(). For
    // callers that drive CombatSimulator directly (no worker), the
    // object default crashes immediately. Default to [] so both paths
    // are safe; the worker still overwrites them with the real array.
    zoneBuffs = [];
    extraBuffs = [];

    constructor() { }

    updateCombatDetails() {
        if (this.isPlayer) {
            if (this.combatDetails.combatStats.hpRegenPer10 === 0) {
                this.combatDetails.combatStats.hpRegenPer10 = 0.01;
            } else {
                this.combatDetails.combatStats.hpRegenPer10 = 0.01 + this.combatDetails.combatStats.hpRegenPer10;
            }
            if (this.combatDetails.combatStats.mpRegenPer10 === 0) {
                this.combatDetails.combatStats.mpRegenPer10 = 0.01;
            } else {
                this.combatDetails.combatStats.mpRegenPer10 = 0.01 + this.combatDetails.combatStats.mpRegenPer10;
            }
        }

        // Precomputed keys, plain loops — see LEVEL_STATS at the top of the file.
        // The base level is re-read from `this[levelKey]` inside the inner loop,
        // exactly as upstream did: the running total lives on combatDetails and
        // the ratio boost always applies to the UNBOOSTED base.
        for (let i = 0; i < LEVEL_STATS.length; i++) {
            let levelKey = LEVEL_STATS[i].levelKey;
            this.combatDetails[levelKey] = this[levelKey];
            let boosts = this._buffBoostsFor(LEVEL_STATS[i].buffTypeOrd);
            for (let j = 0; j < boosts.length; j++) {
                this.combatDetails[levelKey] += (this[levelKey] * boosts[j].ratioBoost);
                this.combatDetails[levelKey] += boosts[j].flatBoost;
            }
        }

        // MWIX adaptation (guild expansion, 7/13/2026): the Spirit shrine grants
        // /buff_types/max_hitpoints and /buff_types/max_manapoints — buff types
        // introduced by that patch and not read anywhere upstream, which left the
        // shrine a silent no-op. Read them here as LOCALS and fold them into the
        // formula rather than mutating combatStats.maxHitpointsRatio: this method
        // re-runs on every buff add/remove (see addBuffs/removeBuffs), so a
        // `+=` onto persistent state would compound the bonus on each call.
        let maxHitpointsBoost = this._buffBoostFor(BT_MAX_HITPOINTS);
        let maxManapointsBoost = this._buffBoostFor(BT_MAX_MANAPOINTS);

        this.combatDetails.maxHitpoints = Math.floor(
            (10 * (10 + this.combatDetails.staminaLevel)
                + this.combatDetails.combatStats.maxHitpoints
                + maxHitpointsBoost.flatBoost)
            * (1 + this.combatDetails.combatStats.maxHitpointsRatio + maxHitpointsBoost.ratioBoost)
        );
        this.combatDetails.maxManapoints = Math.floor(
            (10 * (10 + this.combatDetails.intelligenceLevel)
                + this.combatDetails.combatStats.maxManapoints
                + maxManapointsBoost.flatBoost)
            * (1 + this.combatDetails.combatStats.maxManapointsRatio + maxManapointsBoost.ratioBoost)
        );

        let accuracyRatioBoostFromFury = this._buffBoostFor(BT_FURY_ACCURACY).ratioBoost;
        let damageRatioBoostFromFury = this._buffBoostFor(BT_FURY_DAMAGE).ratioBoost;
        // if (accuracyRatioBoostFromFury > 0) {
        //     console.log("Fury Boost: " + accuracyRatioBoostFromFury);
        // }

        let accuracyRatioBoost = this._buffBoostFor(BT_ACCURACY).ratioBoost;
        let damageRatioBoost = this._buffBoostFor(BT_DAMAGE).ratioBoost;

        // Precomputed keys, plain loop — see ATTACK_STYLES at the top of the file.
        // The evasion boosts are fetched ONCE rather than once per style: the
        // array getBuffBoosts returns is the shared, read-only index entry, so
        // all three iterations were already reading the identical object.
        let styleEvasionBoosts = this._buffBoostsFor(BT_EVASION);
        for (let i = 0; i < ATTACK_STYLES.length; i++) {
            let style = ATTACK_STYLES[i];
            this.combatDetails[style.accuracyRating] =
                (10 + this.combatDetails.attackLevel) *
                (1 + this.combatDetails.combatStats[style.accuracyStat]) *
                (1 + accuracyRatioBoost) *
                (1 + accuracyRatioBoostFromFury);
            this.combatDetails[style.maxDamage] =
                (10 + this.combatDetails.meleeLevel) *
                (1 + this.combatDetails.combatStats[style.damageStat]) *
                (1 + damageRatioBoost) *
                (1 + damageRatioBoostFromFury);
            let baseEvasion = (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats[style.evasionStat]);
            this.combatDetails[style.evasionRating] = baseEvasion;
            for (let j = 0; j < styleEvasionBoosts.length; j++) {
                this.combatDetails[style.evasionRating] += styleEvasionBoosts[j].flatBoost;
                this.combatDetails[style.evasionRating] += baseEvasion * styleEvasionBoosts[j].ratioBoost;
            }
        }

        this.combatDetails.defensiveMaxDamage = 
            (10 + this.combatDetails.defenseLevel) * 
            (1 + this.combatDetails.combatStats.defensiveDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        // when equiped bulwark
        if (this.equipment?.['/equipment_types/two_hand']?.hrid.includes("bulwark")) {
            this.combatDetails.smashMaxDamage += this.combatDetails.defensiveMaxDamage;
        }

        this.combatDetails.rangedAccuracyRating =
            (10 + this.combatDetails.attackLevel) *
            (1 + this.combatDetails.combatStats.rangedAccuracy) *
            (1 + accuracyRatioBoost) *
            (1 + accuracyRatioBoostFromFury);
        this.combatDetails.rangedMaxDamage =
            (10 + this.combatDetails.rangedLevel) *
            (1 + this.combatDetails.combatStats.rangedDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        let baseRangedEvasion = (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats.rangedEvasion);
        this.combatDetails.rangedEvasionRating = baseRangedEvasion;
        let evasionBoosts = this._buffBoostsFor(BT_EVASION);
        for (const boost of evasionBoosts) {
            this.combatDetails.rangedEvasionRating += boost.flatBoost;
            this.combatDetails.rangedEvasionRating += baseRangedEvasion * boost.ratioBoost;
        }

        this.combatDetails.combatStats.damageTaken = this._buffBoostFor(BT_DAMAGE_TAKEN).flatBoost;
        // if (this.combatDetails.combatStats.damageTaken > 0) {
        //     console.log("Damage taken: " + this.combatDetails.combatStats.damageTaken);
        // }

        this.combatDetails.magicAccuracyRating =
            (10 + this.combatDetails.attackLevel) *
            (1 + this.combatDetails.combatStats.magicAccuracy) *
            (1 + accuracyRatioBoost) *
            (1 + accuracyRatioBoostFromFury);
        this.combatDetails.magicMaxDamage =
            (10 + this.combatDetails.magicLevel) *
            (1 + this.combatDetails.combatStats.magicDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        let baseMagicEvasion = (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats.magicEvasion);
        this.combatDetails.magicEvasionRating = baseMagicEvasion;
        for (const boost of evasionBoosts) {
            this.combatDetails.magicEvasionRating += boost.flatBoost;
            this.combatDetails.magicEvasionRating += baseMagicEvasion * boost.ratioBoost;
        }

        this.combatDetails.combatStats.physicalAmplify += this._buffBoostFor(BT_PHYSICAL_AMPLIFY).flatBoost;
        this.combatDetails.combatStats.waterAmplify += this._buffBoostFor(BT_WATER_AMPLIFY).flatBoost;
        this.combatDetails.combatStats.natureAmplify += this._buffBoostFor(BT_NATURE_AMPLIFY).flatBoost;
        this.combatDetails.combatStats.fireAmplify += this._buffBoostFor(BT_FIRE_AMPLIFY).flatBoost;
        this.combatDetails.combatStats.healingAmplify += this._buffBoostFor(BT_HEALING_AMPLIFY).flatBoost;

        this.combatDetails.combatStats.attackInterval /= (1 + (this.combatDetails.attackLevel / 2000));

        let baseAttackSpeed = this.combatDetails.combatStats.attackSpeed;
        this.combatDetails.combatStats.attackInterval /= (1 + baseAttackSpeed);
        let attackIntervalBoosts = this._buffBoostsFor(BT_ATTACK_SPEED);
        let attackIntervalRatioBoost = attackIntervalBoosts
            .map((boost) => boost.ratioBoost)
            .reduce((prev, cur) => prev + cur, 0);
        this.combatDetails.combatStats.attackInterval /= (1 + attackIntervalRatioBoost);

        let baseArmor = 0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.armor;
        this.combatDetails.totalArmor = baseArmor;
        let armorBoosts = this._buffBoostsFor(BT_ARMOR);
        for (const boost of armorBoosts) {
            this.combatDetails.totalArmor += boost.flatBoost;
            this.combatDetails.totalArmor += baseArmor * boost.ratioBoost;
        }

        let baseWaterResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.waterResistance;
        this.combatDetails.totalWaterResistance = baseWaterResistance;
        let waterResistanceBoosts = this._buffBoostsFor(BT_WATER_RESISTANCE);
        for (const boost of waterResistanceBoosts) {
            this.combatDetails.totalWaterResistance += boost.flatBoost;
            this.combatDetails.totalWaterResistance += baseWaterResistance * boost.ratioBoost;
        }

        let baseNatureResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.natureResistance;
        this.combatDetails.totalNatureResistance = baseNatureResistance;
        let natureResistanceBoosts = this._buffBoostsFor(BT_NATURE_RESISTANCE);
        for (const boost of natureResistanceBoosts) {
            this.combatDetails.totalNatureResistance += boost.flatBoost;
            this.combatDetails.totalNatureResistance += baseNatureResistance * boost.ratioBoost;
        }

        let baseFireResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.fireResistance;
        this.combatDetails.totalFireResistance = baseFireResistance;
        let fireResistanceBoosts = this._buffBoostsFor(BT_FIRE_RESISTANCE);
        for (const boost of fireResistanceBoosts) {
            this.combatDetails.totalFireResistance += boost.flatBoost;
            this.combatDetails.totalFireResistance += baseFireResistance * boost.ratioBoost;
        }

        let hpRegenBoosts = this._buffBoostFor(BT_HP_REGEN);
        this.combatDetails.combatStats.hpRegenPer10 += this.combatDetails.combatStats.hpRegenPer10 * hpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.hpRegenPer10 += hpRegenBoosts.flatBoost;

        let mpRegenBoosts = this._buffBoostFor(BT_MP_REGEN);
        this.combatDetails.combatStats.mpRegenPer10 += this.combatDetails.combatStats.mpRegenPer10 * mpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.mpRegenPer10 += mpRegenBoosts.flatBoost;

        this.combatDetails.combatStats.lifeSteal += this._buffBoostFor(BT_LIFE_STEAL).flatBoost;
        this.combatDetails.combatStats.physicalThorns += this._buffBoostFor(BT_PHYSICAL_THORNS).flatBoost;
        this.combatDetails.combatStats.elementalThorns += this._buffBoostFor(BT_ELEMENTAL_THORNS).flatBoost;
        this.combatDetails.combatStats.combatExperience += this._buffBoostFor(BT_WISDOM).flatBoost;
        this.combatDetails.combatStats.criticalRate += this._buffBoostFor(BT_CRITICAL_RATE).flatBoost;
        this.combatDetails.combatStats.criticalDamage += this._buffBoostFor(BT_CRITICAL_DAMAGE).flatBoost;

        this.combatDetails.combatStats.castSpeed += this._buffBoostFor(BT_CAST_SPEED).flatBoost;
        this.combatDetails.combatStats.castSpeed += this.combatDetails["attackLevel"] / 2000;

        let combatDropRateBoosts = this._buffBoostFor(BT_COMBAT_DROP_RATE);
        this.combatDetails.combatStats.combatDropRate += (1 + this.combatDetails.combatStats.combatDropRate) * combatDropRateBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropRate += combatDropRateBoosts.flatBoost;
        let combatRareFindBoosts = this._buffBoostFor(BT_RARE_FIND);
        this.combatDetails.combatStats.combatRareFind += (1 + this.combatDetails.combatStats.combatRareFind) * combatRareFindBoosts.ratioBoost;
        this.combatDetails.combatStats.combatRareFind += combatRareFindBoosts.flatBoost;
        let combatDropQuantityBoosts = this._buffBoostFor(BT_COMBAT_DROP_QUANTITY);
        this.combatDetails.combatStats.combatDropQuantity += (1 + this.combatDetails.combatStats.combatDropQuantity) * combatDropQuantityBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropQuantity += combatDropQuantityBoosts.flatBoost;

        let baseThreat = 100 + this.combatDetails.combatStats.threat;
        this.combatDetails.totalThreat = baseThreat;
        let threatBoosts = this._buffBoostFor(BT_THREAT);
        if (threatBoosts.ratioBoost !== 0) {
            this.combatDetails.combatStats.threat += baseThreat * threatBoosts.ratioBoost;
        } else {
            this.combatDetails.combatStats.threat = baseThreat;
        }
        this.combatDetails.combatStats.threat += threatBoosts.flatBoost;

        this.combatDetails.combatStats.retaliation += this._buffBoostFor(BT_RETALIATION).flatBoost;
        this.combatDetails.combatStats.tenacity += this._buffBoostFor(BT_TENACITY).flatBoost;
    }

    // ---- MWIX adaptation (7/15/2026 patch parity): per-source buff instance
    // tracking ------------------------------------------------------------------
    //
    // An "instance" is a COPY of the incoming buff's enumerable fields plus
    // bookkeeping (startTime, expireTime, sourceKey). We never mutate the passed
    // buff object — callers frequently pass SHARED ability-effect data (see
    // combatSimulator.processAbilityBuffEffect / addBuff at ~line 1600), so
    // mutating it would corrupt the source-of-truth for every future application.
    //
    // Load-bearing NaN semantics: enrage applies buffs WITHOUT a currentTime, so
    // startTime is undefined and expireTime becomes NaN. Every `expireTime <= t`
    // comparison against NaN is false, so those instances NEVER expire. Preserve it.
    _makeBuffInstance(buff, startTime, sourceKey) {
        let instance = { ...buff };
        instance.startTime = startTime; // keep startTime for shape parity with upstream buff objects
        instance.expireTime = startTime + buff.duration; // NaN when startTime === undefined
        instance.sourceKey = sourceKey;
        return instance;
    }

    // An instance is active while it has NOT expired. The NEGATED form is
    // load-bearing: a NaN expireTime (enrage-style never-expires) makes
    // `expireTime <= currentTime` false, so !(false) === true keeps it alive.
    _isActive(inst, currentTime) {
        return !(inst.expireTime <= currentTime);
    }

    // The effective (strongest-active) view changed iff its magnitude changed.
    // Shared changed-predicate for every commit path.
    _effectChanged(prev, effective) {
        return !prev || prev.ratioBoost !== effective.ratioBoost || prev.flatBoost !== effective.flatBoost;
    }

    // Strongest = larger |ratioBoost|, then larger |flatBoost|, then later
    // expireTime (NaN — a never-expiring source — wins as +Infinity). Magnitude
    // matters because debuffs (weaken) carry NEGATIVE boosts and "stronger" means
    // larger magnitude. Assumes instances of one uniqueHrid never trade a
    // ratioBoost against a flatBoost (each buff is single-component or uniformly
    // scaled today), so the two components are compared independently.
    _strongerInstance(a, b) {
        let ar = Math.abs(a.ratioBoost ?? 0);
        let br = Math.abs(b.ratioBoost ?? 0);
        if (ar !== br) return ar > br ? a : b;
        let af = Math.abs(a.flatBoost ?? 0);
        let bf = Math.abs(b.flatBoost ?? 0);
        if (af !== bf) return af > bf ? a : b;
        let ae = Number.isNaN(a.expireTime) ? Infinity : a.expireTime;
        let be = Number.isNaN(b.expireTime) ? Infinity : b.expireTime;
        return ae >= be ? a : b;
    }

    _effectiveInstance(instances) {
        let best = null;
        for (const inst of instances) {
            best = best === null ? inst : this._strongerInstance(best, inst);
        }
        return best;
    }

    // Write buffInstances[hrid] / combatBuffs[hrid] from `arr` and report whether
    // the effective view changed vs. the previous combatBuffs entry. When arr is
    // empty BOTH maps are deleted, and deleting a previously-present entry counts
    // as a change. Recomputes the effective view via _effectiveInstance. Does NOT
    // call updateCombatDetails so callers can batch it.
    _commitInstances(hrid, arr) {
        // The ONLY place `combatBuffs` is mutated entry-by-entry (the other
        // writer is clearBuffs, which replaces the object wholesale). Both
        // branches below write, so invalidating unconditionally here is
        // sufficient — and, being at the top, cannot be skipped by the early
        // return. A grep of the whole engine confirms no third writer exists;
        // trigger.js only READS combatBuffs.
        this._invalidateBuffBoostIndex();

        let prev = this.combatBuffs[hrid];
        if (arr.length === 0) {
            delete this.buffInstances[hrid];
            delete this.combatBuffs[hrid];
            return prev !== undefined;
        }
        this.buffInstances[hrid] = arr;
        let effective = this._effectiveInstance(arr);
        this.combatBuffs[hrid] = effective;
        return this._effectChanged(prev, effective);
    }

    // Apply one buff and return whether the effective view changed (needs a
    // recompute). Does NOT call updateCombatDetails so callers can batch it.
    _applyBuff(buff, currentTime, sourceRef) {
        let hrid = buff.uniqueHrid;
        let arr = this.buffInstances[hrid];
        // Single pass (one allocation): drop expired instances AND this source's
        // prior instance. Same-source re-apply REPLACES its own instance (preserves
        // buff refresh AND fury's decay-on-miss, where a weaker self-buff must win).
        // Expiry is skipped entirely when currentTime is undefined (enrage).
        let next = [];
        if (arr) {
            for (const inst of arr) {
                if (inst.sourceKey === sourceRef) continue;
                if (currentTime !== undefined && !this._isActive(inst, currentTime)) continue;
                next.push(inst);
            }
        }
        // Push the new instance ({...buff} copy — never mutate the incoming buff).
        next.push(this._makeBuffInstance(buff, currentTime, sourceRef));
        return this._commitInstances(hrid, next);
    }

    // Remove sourceRef's instance for this buff and return whether the effective
    // view changed. The next strongest surviving source is promoted.
    _removeBuffInstance(buff, sourceRef) {
        let hrid = buff.uniqueHrid;
        let arr = this.buffInstances[hrid];
        if (!arr || arr.length === 0) {
            return false;
        }
        // Plain-loop scan first: the fury decay-on-miss path calls this often with
        // nothing to remove. Bail with zero allocations when the source is absent.
        let found = false;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].sourceKey === sourceRef) {
                found = true;
                break;
            }
        }
        if (!found) {
            return false;
        }
        let filtered = arr.filter((inst) => inst.sourceKey !== sourceRef);
        return this._commitInstances(hrid, filtered);
    }

    addBuffs(buffs, currentTime, sourceRef = this) {
        // sourceRef identifies the APPLYING unit; multiple sources of the same
        // buff arbitrate by strength (strongest active wins). Callers applying a
        // buff to a DIFFERENT unit MUST pass the applying unit as sourceRef —
        // omitting it defaults to the receiving unit and silently restores
        // last-writer-wins for that effect.
        let needUpdate = false;
        for (const buff of buffs) {
            if (this._applyBuff(buff, currentTime, sourceRef)) {
                needUpdate = true;
            }
        }

        if (needUpdate) {
            this.updateCombatDetails();
        }
    }

    addBuff(buff, currentTime, sourceRef = this) {
        this.addBuffs([buff], currentTime, sourceRef);
    }

    removeBuffs(buffs, sourceRef = this) {
        let needUpdate = false;
        for (const buff of buffs) {
            if (this._removeBuffInstance(buff, sourceRef)) {
                needUpdate = true;
            }
        }

        if (needUpdate) {
            this.updateCombatDetails();
        }
    }

    removeBuff(buff, sourceRef = this) {
        this.removeBuffs([buff], sourceRef);
    }

    addPermanentBuff(buff) {
        if (this.permanentBuffs[buff.typeHrid]) {
            this.permanentBuffs[buff.typeHrid].flatBoost += buff.flatBoost;
            this.permanentBuffs[buff.typeHrid].ratioBoost += buff.ratioBoost;
        } else {
            this.permanentBuffs[buff.typeHrid] = {
                uniqueHrid: buff.uniqueHrid,
                typeHrid: buff.typeHrid,
                flatBoost: buff.flatBoost,
                ratioBoost: buff.ratioBoost,
                duration: buff.duration
            };
        }
    }

    generatePermanentBuffs() {
        for (let i = 0; i < this.houseRooms.length; i++) {
            const houseRoom = this.houseRooms[i];
            houseRoom.buffs.forEach(buff => {
                this.addPermanentBuff(buff);
            });
        }

        if (this.achievements) {
            this.achievements.buffs.forEach(buff => {
                this.addPermanentBuff(buff);
            });
        }
        if (this.zoneBuffs) {
            this.zoneBuffs.forEach(buff => {
                this.addPermanentBuff(buff);
            });
        }
        if (this.extraBuffs) {
            this.extraBuffs.forEach(buff => {
                this.addPermanentBuff(buff);
            });
        }
    }

    removeExpiredBuffs(currentTime) {
        // Iterate instance sources only. combatBuffs entries WITHOUT a backing
        // instance array are permanent buffs (keyed by typeHrid, no startTime) —
        // they must survive untouched.
        let changed = false;
        for (const hrid of Object.keys(this.buffInstances)) {
            let arr = this.buffInstances[hrid];
            // Hot path: plain-loop scan first and SKIP the hrid entirely when
            // nothing expired — no filter allocation, no effective recompute, no
            // reassignment. This runs millions of times in the Monte-Carlo sim.
            let hasExpired = false;
            for (const inst of arr) {
                if (!this._isActive(inst, currentTime)) {
                    hasExpired = true;
                    break;
                }
            }
            if (!hasExpired) {
                continue;
            }
            let filtered = arr.filter((inst) => this._isActive(inst, currentTime));
            if (this._commitInstances(hrid, filtered)) {
                changed = true;
            }
        }

        if (changed) {
            this.updateCombatDetails();
        }
    }

    clearBuffs() {
        this.buffInstances = {};
        let fresh = {};
        for (const key in this.permanentBuffs) {
            let buff = this.permanentBuffs[key];
            fresh[key] = {
                uniqueHrid: buff.uniqueHrid,
                typeHrid: buff.typeHrid,
                flatBoost: buff.flatBoost,
                ratioBoost: buff.ratioBoost,
                duration: buff.duration,
            };
        }
        this.combatBuffs = fresh;
        this._invalidateBuffBoostIndex();
        this.updateCombatDetails();
    }

    clearCCs() {
        this.isStunned = false;
        this.stunExpireTime = null;
        this.isSilenced = false;
        this.silenceExpireTime = null;
        this.isBlinded = false;
        this.blindExpireTime = null;
        this.combatDetails.combatStats.damageTaken = 0;
    }

    // MWIX adaptation (performance): mark the boost index stale. Called from
    // every write to `combatBuffs` — _commitInstances and clearBuffs — rather
    // than trying to patch the index incrementally, because a missed write path
    // here produces WRONG COMBAT NUMBERS with no error anywhere. Rebuilding is
    // O(#combatBuffs) (a dozen or so entries), about the cost of one of the
    // 359 394 queries per simulated hour it saves.
    _invalidateBuffBoostIndex() {
        this._buffBoostStale = true;
    }

    // MWIX adaptation (performance): dense integer indexing, allocated once.
    //
    // WHAT CHANGED. Both structures were string-keyed `Map`s, rebuilt from
    // scratch on every write to `combatBuffs`: a `new Map`, an array per
    // distinct buff type, one `{ratioBoost, flatBoost}` record per buff, and
    // then a second `Map` plus one freshly allocated sum object per type
    // queried. A CPU profile of the candle put _buildBuffBoostIndex at 9.39% of
    // self time on dungeon-den-600 and getBuffBoost at 3.28% — ~16.5% of the
    // run between them, the largest family in the profile.
    //
    // They are now flat arrays indexed by the generated buff-type ordinal
    // (src/combatsimulator/generated/buffTypes.js), and everything they hold is
    // allocated ONCE per unit and reused: the per-type boost arrays and the
    // per-buff records come from pools, and each ordinal owns a single sum
    // object that is overwritten in place. A steady-state rebuild allocates
    // nothing at all.
    //
    // WHY IT IS BIT-IDENTICAL. The iteration order is untouched — still
    // `Object.values(this.combatBuffs)`, still insertion-ordered (see the note
    // on the old implementation, which stands: `for...in` would also walk
    // inherited enumerables, so a polluted Object.prototype would inject
    // phantom buffs). Within a type, records are appended in the same order as
    // before, and the summation loop adds them in that same order starting from
    // 0. No `+=` is reordered, and float addition's non-associativity therefore
    // never gets a chance to show.
    //
    // THE HAZARD, AND WHY IT IS CONTAINED. Because the arrays and records are
    // reused, a caller that held a boosts array or a sum object ACROSS a buff
    // change would now observe the new values rather than a stale snapshot.
    // That is already forbidden — both were documented shared and read-only
    // before this change — and no engine path does it: every caller reads the
    // result out within the same `updateCombatDetails`, and nothing mutates
    // `combatBuffs` during a recompute (the dependency runs the other way; a
    // buff change is what TRIGGERS a recompute). Pinned in
    // api/tests/statCaching.test.mjs.
    //
    // Staleness is a separate boolean rather than a null index, so that
    // invalidation — which happens on every buff add, remove and expiry —
    // costs one store and keeps the pools alive.
    _allocBuffBoostState() {
        this._buffBoostIndex = new Array(BUFF_TYPE_COUNT);
        this._buffBoostFilled = [];
        // Sum objects are created on first use, NOT all BUFF_TYPE_COUNT of
        // them up front. Every unit allocates this state — including the
        // several hundred monsters a simulated hour constructs — and eagerly
        // minting 67 objects per unit cost more than it saved on the cheapest
        // candle case (starter-solo 2.2 -> 2.8 ms/sim-h). Measured, not guessed.
        this._buffBoostSums = new Array(BUFF_TYPE_COUNT);
        // Stamp 0 means "never computed"; the epoch starts at 1 (see below).
        this._buffBoostSumStamp = new Int32Array(BUFF_TYPE_COUNT);
        this._buffBoostEpoch = 0;
        this._boostArrayPool = [];
        this._boostRecordPool = [];
    }

    _buildBuffBoostIndex() {
        if (this._buffBoostIndex === null) {
            this._allocBuffBoostState();
        }
        let index = this._buffBoostIndex;
        let filled = this._buffBoostFilled;
        // Clear only the slots the LAST build touched — a dozen or so, not all
        // BUFF_TYPE_COUNT of them.
        for (let i = 0; i < filled.length; i++) {
            index[filled[i]] = undefined;
        }
        filled.length = 0;
        this._boostArrayUsed = 0;
        this._boostRecordUsed = 0;

        // Bumping the epoch invalidates every memoised sum in one store. The
        // wrap guard exists only so the Int32Array stamps can never collide
        // with a live epoch; at simulation rates it is unreachable in practice.
        this._buffBoostEpoch++;
        if (this._buffBoostEpoch >= 0x7ffffffe) {
            this._buffBoostEpoch = 1;
            this._buffBoostSumStamp.fill(0);
        }

        let arrayPool = this._boostArrayPool;
        let recordPool = this._boostRecordPool;
        for (const buff of Object.values(this.combatBuffs)) {
            let ordinal = buffTypeOrdinal(buff.typeHrid);
            let boosts = index[ordinal];
            if (boosts === undefined) {
                if (this._boostArrayUsed < arrayPool.length) {
                    boosts = arrayPool[this._boostArrayUsed];
                    boosts.length = 0;
                } else {
                    boosts = [];
                    arrayPool.push(boosts);
                }
                this._boostArrayUsed++;
                index[ordinal] = boosts;
                filled.push(ordinal);
            }
            let record;
            if (this._boostRecordUsed < recordPool.length) {
                record = recordPool[this._boostRecordUsed];
            } else {
                record = { ratioBoost: 0, flatBoost: 0 };
                recordPool.push(record);
            }
            this._boostRecordUsed++;
            record.ratioBoost = buff.ratioBoost;
            record.flatBoost = buff.flatBoost;
            boosts.push(record);
        }

        this._buffBoostStale = false;
        return index;
    }

    // The ordinal-taking forms. Everything inside this file calls these with a
    // constant interned at module load, so the hot path never hashes a string.
    _buffBoostsFor(ordinal) {
        if (this._buffBoostStale) {
            this._buildBuffBoostIndex();
        }
        return this._buffBoostIndex[ordinal] ?? EMPTY_BUFF_BOOSTS;
    }

    _buffBoostFor(ordinal) {
        if (this._buffBoostStale) {
            this._buildBuffBoostIndex();
        }
        let boost = this._buffBoostSums[ordinal];
        if (boost === undefined) {
            boost = { ratioBoost: 0, flatBoost: 0 };
            this._buffBoostSums[ordinal] = boost;
        } else if (this._buffBoostSumStamp[ordinal] === this._buffBoostEpoch) {
            return boost;
        }

        let boosts = this._buffBoostIndex[ordinal];
        let ratioBoost = 0;
        let flatBoost = 0;
        if (boosts !== undefined) {
            // The `?? 0` is upstream's coercion, kept exactly: a null entry
            // must contribute zero, not NaN.
            for (let i = 0; i < boosts.length; i++) {
                ratioBoost += boosts[i]?.ratioBoost ?? 0;
                flatBoost += boosts[i]?.flatBoost ?? 0;
            }
        }
        boost.ratioBoost = ratioBoost;
        boost.flatBoost = flatBoost;
        this._buffBoostSumStamp[ordinal] = this._buffBoostEpoch;
        return boost;
    }

    // The string-taking public forms, kept for callers outside this file (the
    // API layer and the tests). They intern at the boundary and then share the
    // ordinal path above; an unknown hrid THROWS inside buffTypeOrdinal rather
    // than indexing at `undefined` and silently vanishing.
    //
    // THE RETURNED ARRAY IS SHARED AND MUST BE TREATED AS READ-ONLY. Every
    // caller in the engine only reads .ratioBoost / .flatBoost off it; if you
    // need to mutate, copy first.
    getBuffBoosts(type) {
        return this._buffBoostsFor(buffTypeOrdinal(type));
    }

    // As above, and the SUM is cached per type too — updateCombatDetails alone
    // makes ~35 boost queries, and it re-runs on every buff add/remove.
    // The returned object is shared: read-only, same contract as getBuffBoosts.
    getBuffBoost(type) {
        return this._buffBoostFor(buffTypeOrdinal(type));
    }

    reset(currentTime = 0) {
        this.clearCCs();
        
        // 只有玩家在地下城团灭重开时保留buff和CD，敌人始终完全重置
        if (currentTime == 0 || !this.isPlayer) {
            // 首次战斗开始 或 敌人重置：完全重置
            this.clearBuffs();
            // this.updateCombatDetails();
            this.resetCooldowns(currentTime);
        } else {
            // 地下城团灭重开（仅玩家）：只移除过期buff，保留CD
            this.removeExpiredBuffs(currentTime);
            // this.updateCombatDetails();
        }

        this.combatDetails.currentHitpoints = this.combatDetails.maxHitpoints;
        this.combatDetails.currentManapoints = this.combatDetails.maxManapoints;
    }

    resetCooldowns(currentTime = 0) {
        this.food.filter((food) => food != null).forEach((food) => (food.lastUsed = Number.MIN_SAFE_INTEGER));
        this.drinks.filter((drink) => drink != null).forEach((drink) => (drink.lastUsed = Number.MIN_SAFE_INTEGER));

        let haste = this.combatDetails.combatStats.abilityHaste;

        this.abilities
            .filter((ability) => ability != null)
            .forEach((ability) => {
                if (this.isPlayer) {
                    ability.lastUsed = Number.MIN_SAFE_INTEGER;
                } else {
                    let cooldownDuration = ability.cooldownDuration;
                    if (haste > 0) {
                        cooldownDuration = cooldownDuration * 100 / (100 + haste);
                    }
                    // MWIX adaptation: the opening cooldown a monster carries
                    // into a fight is measured, and differs by context — a flat
                    // half in the labyrinth, upstream's randomised U[0.5, 1.0)
                    // window in zone/dungeon combat. simSettings.js holds the
                    // capture data and resolves the two (and the manual
                    // overrides) into one of "half" / "random".
                    if (resolveMonsterStartCooldown() === "half") {
                        ability.lastUsed = currentTime - Math.floor(cooldownDuration * 0.5);
                    } else {
                        ability.lastUsed = currentTime - Math.floor(cooldownDuration * 0.5) + Math.floor(Math.random() * cooldownDuration * 0.5);
                    }
                }
            });
    }

    addHitpoints(hitpoints) {
        let hitpointsAdded = 0;

        if (this.combatDetails.currentHitpoints >= this.combatDetails.maxHitpoints) {
            return hitpointsAdded;
        }

        let newHitpoints = Math.min(this.combatDetails.currentHitpoints + hitpoints, this.combatDetails.maxHitpoints);
        hitpointsAdded = newHitpoints - this.combatDetails.currentHitpoints;
        this.combatDetails.currentHitpoints = newHitpoints;

        return hitpointsAdded;
    }

    addManapoints(manapoints) {
        let manapointsAdded = 0;

        if (this.combatDetails.currentManapoints >= this.combatDetails.maxManapoints) {
            return manapointsAdded;
        }

        let newManapoints = Math.min(
            this.combatDetails.currentManapoints + manapoints,
            this.combatDetails.maxManapoints
        );
        manapointsAdded = newManapoints - this.combatDetails.currentManapoints;
        this.combatDetails.currentManapoints = newManapoints;

        return manapointsAdded;
    }
}

export default CombatUnit;
