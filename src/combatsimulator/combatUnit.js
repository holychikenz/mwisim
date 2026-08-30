import { resolveMonsterStartCooldown } from "./simSettings";

class CombatUnit {
    isPlayer;
    isStunned = false;
    stunExpireTime = null;
    isBlinded = false;
    blindExpireTime = null;
    isSilenced = false;
    silenceExpireTime = null;

    isOutOfMana = false;

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

        ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"].forEach((stat) => {
            this.combatDetails[stat + "Level"] = this[stat + "Level"];
            let boosts = this.getBuffBoosts("/buff_types/" + stat + "_level");
            boosts.forEach((buff) => {
                this.combatDetails[stat + "Level"] += (this[stat + "Level"] * buff.ratioBoost);
                this.combatDetails[stat + "Level"] += buff.flatBoost;
            });
        });

        // MWIX adaptation (guild expansion, 7/13/2026): the Spirit shrine grants
        // /buff_types/max_hitpoints and /buff_types/max_manapoints — buff types
        // introduced by that patch and not read anywhere upstream, which left the
        // shrine a silent no-op. Read them here as LOCALS and fold them into the
        // formula rather than mutating combatStats.maxHitpointsRatio: this method
        // re-runs on every buff add/remove (see addBuffs/removeBuffs), so a
        // `+=` onto persistent state would compound the bonus on each call.
        let maxHitpointsBoost = this.getBuffBoost("/buff_types/max_hitpoints");
        let maxManapointsBoost = this.getBuffBoost("/buff_types/max_manapoints");

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

        let accuracyRatioBoostFromFury = this.getBuffBoost("/buff_types/fury_accuracy").ratioBoost;
        let damageRatioBoostFromFury = this.getBuffBoost("/buff_types/fury_damage").ratioBoost;
        // if (accuracyRatioBoostFromFury > 0) {
        //     console.log("Fury Boost: " + accuracyRatioBoostFromFury);
        // }

        let accuracyRatioBoost = this.getBuffBoost("/buff_types/accuracy").ratioBoost;
        let damageRatioBoost = this.getBuffBoost("/buff_types/damage").ratioBoost;

        ["stab", "slash", "smash"].forEach((style) => {
            this.combatDetails[style + "AccuracyRating"] =
                (10 + this.combatDetails.attackLevel) *
                (1 + this.combatDetails.combatStats[style + "Accuracy"]) *
                (1 + accuracyRatioBoost) *
                (1 + accuracyRatioBoostFromFury);
            this.combatDetails[style + "MaxDamage"] =
                (10 + this.combatDetails.meleeLevel) *
                (1 + this.combatDetails.combatStats[style + "Damage"]) *
                (1 + damageRatioBoost) *
                (1 + damageRatioBoostFromFury);
            let baseEvasion = (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats[style + "Evasion"]);
            this.combatDetails[style + "EvasionRating"] = baseEvasion;
            let evasionBoosts = this.getBuffBoosts("/buff_types/evasion");
            for (const boost of evasionBoosts) {
                this.combatDetails[style + "EvasionRating"] += boost.flatBoost;
                this.combatDetails[style + "EvasionRating"] += baseEvasion * boost.ratioBoost;
            }
        });

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
        let evasionBoosts = this.getBuffBoosts("/buff_types/evasion");
        for (const boost of evasionBoosts) {
            this.combatDetails.rangedEvasionRating += boost.flatBoost;
            this.combatDetails.rangedEvasionRating += baseRangedEvasion * boost.ratioBoost;
        }

        this.combatDetails.combatStats.damageTaken = this.getBuffBoost("/buff_types/damage_taken").flatBoost;
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

        this.combatDetails.combatStats.physicalAmplify += this.getBuffBoost("/buff_types/physical_amplify").flatBoost;
        this.combatDetails.combatStats.waterAmplify += this.getBuffBoost("/buff_types/water_amplify").flatBoost;
        this.combatDetails.combatStats.natureAmplify += this.getBuffBoost("/buff_types/nature_amplify").flatBoost;
        this.combatDetails.combatStats.fireAmplify += this.getBuffBoost("/buff_types/fire_amplify").flatBoost;
        this.combatDetails.combatStats.healingAmplify += this.getBuffBoost("/buff_types/healing_amplify").flatBoost;

        this.combatDetails.combatStats.attackInterval /= (1 + (this.combatDetails.attackLevel / 2000));

        let baseAttackSpeed = this.combatDetails.combatStats.attackSpeed;
        this.combatDetails.combatStats.attackInterval /= (1 + baseAttackSpeed);
        let attackIntervalBoosts = this.getBuffBoosts("/buff_types/attack_speed");
        let attackIntervalRatioBoost = attackIntervalBoosts
            .map((boost) => boost.ratioBoost)
            .reduce((prev, cur) => prev + cur, 0);
        this.combatDetails.combatStats.attackInterval /= (1 + attackIntervalRatioBoost);

        let baseArmor = 0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.armor;
        this.combatDetails.totalArmor = baseArmor;
        let armorBoosts = this.getBuffBoosts("/buff_types/armor");
        for (const boost of armorBoosts) {
            this.combatDetails.totalArmor += boost.flatBoost;
            this.combatDetails.totalArmor += baseArmor * boost.ratioBoost;
        }

        let baseWaterResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.waterResistance;
        this.combatDetails.totalWaterResistance = baseWaterResistance;
        let waterResistanceBoosts = this.getBuffBoosts("/buff_types/water_resistance");
        for (const boost of waterResistanceBoosts) {
            this.combatDetails.totalWaterResistance += boost.flatBoost;
            this.combatDetails.totalWaterResistance += baseWaterResistance * boost.ratioBoost;
        }

        let baseNatureResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.natureResistance;
        this.combatDetails.totalNatureResistance = baseNatureResistance;
        let natureResistanceBoosts = this.getBuffBoosts("/buff_types/nature_resistance");
        for (const boost of natureResistanceBoosts) {
            this.combatDetails.totalNatureResistance += boost.flatBoost;
            this.combatDetails.totalNatureResistance += baseNatureResistance * boost.ratioBoost;
        }

        let baseFireResistance =
            0.2 * this.combatDetails.defenseLevel +
            this.combatDetails.combatStats.fireResistance;
        this.combatDetails.totalFireResistance = baseFireResistance;
        let fireResistanceBoosts = this.getBuffBoosts("/buff_types/fire_resistance");
        for (const boost of fireResistanceBoosts) {
            this.combatDetails.totalFireResistance += boost.flatBoost;
            this.combatDetails.totalFireResistance += baseFireResistance * boost.ratioBoost;
        }

        let hpRegenBoosts = this.getBuffBoost("/buff_types/hp_regen");
        this.combatDetails.combatStats.hpRegenPer10 += this.combatDetails.combatStats.hpRegenPer10 * hpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.hpRegenPer10 += hpRegenBoosts.flatBoost;

        let mpRegenBoosts = this.getBuffBoost("/buff_types/mp_regen");
        this.combatDetails.combatStats.mpRegenPer10 += this.combatDetails.combatStats.mpRegenPer10 * mpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.mpRegenPer10 += mpRegenBoosts.flatBoost;

        this.combatDetails.combatStats.lifeSteal += this.getBuffBoost("/buff_types/life_steal").flatBoost;
        this.combatDetails.combatStats.physicalThorns += this.getBuffBoost(
            "/buff_types/physical_thorns"
        ).flatBoost;
        this.combatDetails.combatStats.elementalThorns += this.getBuffBoost(
            "/buff_types/elemental_thorns"
        ).flatBoost;
        this.combatDetails.combatStats.combatExperience += this.getBuffBoost("/buff_types/wisdom").flatBoost;
        this.combatDetails.combatStats.criticalRate += this.getBuffBoost("/buff_types/critical_rate").flatBoost;
        this.combatDetails.combatStats.criticalDamage += this.getBuffBoost("/buff_types/critical_damage").flatBoost;

        this.combatDetails.combatStats.castSpeed += this.getBuffBoost("/buff_types/cast_speed").flatBoost;
        this.combatDetails.combatStats.castSpeed += this.combatDetails["attackLevel"] / 2000;

        let combatDropRateBoosts = this.getBuffBoost("/buff_types/combat_drop_rate");
        this.combatDetails.combatStats.combatDropRate += (1 + this.combatDetails.combatStats.combatDropRate) * combatDropRateBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropRate += combatDropRateBoosts.flatBoost;
        let combatRareFindBoosts = this.getBuffBoost("/buff_types/rare_find");
        this.combatDetails.combatStats.combatRareFind += (1 + this.combatDetails.combatStats.combatRareFind) * combatRareFindBoosts.ratioBoost;
        this.combatDetails.combatStats.combatRareFind += combatRareFindBoosts.flatBoost;
        let combatDropQuantityBoosts = this.getBuffBoost("/buff_types/combat_drop_quantity");
        this.combatDetails.combatStats.combatDropQuantity += (1 + this.combatDetails.combatStats.combatDropQuantity) * combatDropQuantityBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropQuantity += combatDropQuantityBoosts.flatBoost;

        let baseThreat = 100 + this.combatDetails.combatStats.threat;
        this.combatDetails.totalThreat = baseThreat;
        let threatBoosts = this.getBuffBoost("/buff_types/threat");
        if (threatBoosts.ratioBoost !== 0) {
            this.combatDetails.combatStats.threat += baseThreat * threatBoosts.ratioBoost;
        } else {
            this.combatDetails.combatStats.threat = baseThreat;
        }
        this.combatDetails.combatStats.threat += threatBoosts.flatBoost;

        this.combatDetails.combatStats.retaliation += this.getBuffBoost("/buff_types/retaliation").flatBoost;
        this.combatDetails.combatStats.tenacity += this.getBuffBoost("/buff_types/tenacity").flatBoost;
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
            this._commitInstances(hrid, filtered);
        }

        // Unconditional recompute for behavior parity with the old code.
        this.updateCombatDetails();
    }

    clearBuffs() {
        this.buffInstances = {};
        this.combatBuffs = structuredClone(this.permanentBuffs);
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

    getBuffBoosts(type) {
        let boosts = [];
        Object.values(this.combatBuffs)
            .filter((buff) => buff.typeHrid == type)
            .forEach((buff) => {
                boosts.push({ ratioBoost: buff.ratioBoost, flatBoost: buff.flatBoost });
            });

        return boosts;
    }

    getBuffBoost(type) {
        let boosts = this.getBuffBoosts(type);

        let boost = {
            ratioBoost: 0,
            flatBoost: 0,
        };

        for (let i = 0; i < boosts.length; i++) {
            boost.ratioBoost += boosts[i]?.ratioBoost ?? 0;
            boost.flatBoost += boosts[i]?.flatBoost ?? 0;
        }

        return boost;
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
