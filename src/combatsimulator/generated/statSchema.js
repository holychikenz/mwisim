// =============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by tools/genStatSchema.mjs; see that file for why these loops are
// compiled rather than typed, and api/tests/statSchema.test.mjs, which re-runs
// the generator and compares this file byte for byte. Regenerate with:
//
//     node tools/genStatSchema.mjs
//
// Every name below is emitted from the list the engine declares, in that
// list's own order, so each routine writes the same fields with the same
// values in the same sequence as the keyed loop it replaces.
//
// No comments inside the function bodies: V8's inlining budget is measured in
// SOURCE CHARACTERS, comments included, and these are the warmest routines in
// the engine. Explanations belong above the function, never within it.
// =============================================================================

/** Count of names each routine covers, for the tests to assert against. */
export const EQUIPMENT_STAT_COUNT = 70;
export const MONSTER_ZEROED_STAT_COUNT = 63;

/**
 * Copy the summed equipment totals into a unit's combatStats.
 * Replaces the 70-iteration keyed loop in Player.updateCombatDetails.
 */
export function copyEquipmentTotals(combatStats, totals) {
    combatStats.stabAccuracy = totals.stabAccuracy;
    combatStats.slashAccuracy = totals.slashAccuracy;
    combatStats.smashAccuracy = totals.smashAccuracy;
    combatStats.rangedAccuracy = totals.rangedAccuracy;
    combatStats.magicAccuracy = totals.magicAccuracy;
    combatStats.stabDamage = totals.stabDamage;
    combatStats.slashDamage = totals.slashDamage;
    combatStats.smashDamage = totals.smashDamage;
    combatStats.rangedDamage = totals.rangedDamage;
    combatStats.magicDamage = totals.magicDamage;
    combatStats.defensiveDamage = totals.defensiveDamage;
    combatStats.taskDamage = totals.taskDamage;
    combatStats.physicalAmplify = totals.physicalAmplify;
    combatStats.waterAmplify = totals.waterAmplify;
    combatStats.natureAmplify = totals.natureAmplify;
    combatStats.fireAmplify = totals.fireAmplify;
    combatStats.healingAmplify = totals.healingAmplify;
    combatStats.stabEvasion = totals.stabEvasion;
    combatStats.slashEvasion = totals.slashEvasion;
    combatStats.smashEvasion = totals.smashEvasion;
    combatStats.rangedEvasion = totals.rangedEvasion;
    combatStats.magicEvasion = totals.magicEvasion;
    combatStats.armor = totals.armor;
    combatStats.waterResistance = totals.waterResistance;
    combatStats.natureResistance = totals.natureResistance;
    combatStats.fireResistance = totals.fireResistance;
    combatStats.maxHitpoints = totals.maxHitpoints;
    combatStats.maxManapoints = totals.maxManapoints;
    combatStats.lifeSteal = totals.lifeSteal;
    combatStats.hpRegenPer10 = totals.hpRegenPer10;
    combatStats.mpRegenPer10 = totals.mpRegenPer10;
    combatStats.physicalThorns = totals.physicalThorns;
    combatStats.elementalThorns = totals.elementalThorns;
    combatStats.combatDropRate = totals.combatDropRate;
    combatStats.combatRareFind = totals.combatRareFind;
    combatStats.combatDropQuantity = totals.combatDropQuantity;
    combatStats.combatExperience = totals.combatExperience;
    combatStats.criticalRate = totals.criticalRate;
    combatStats.criticalDamage = totals.criticalDamage;
    combatStats.armorPenetration = totals.armorPenetration;
    combatStats.waterPenetration = totals.waterPenetration;
    combatStats.naturePenetration = totals.naturePenetration;
    combatStats.firePenetration = totals.firePenetration;
    combatStats.abilityHaste = totals.abilityHaste;
    combatStats.tenacity = totals.tenacity;
    combatStats.manaLeech = totals.manaLeech;
    combatStats.castSpeed = totals.castSpeed;
    combatStats.threat = totals.threat;
    combatStats.parry = totals.parry;
    combatStats.mayhem = totals.mayhem;
    combatStats.pierce = totals.pierce;
    combatStats.curse = totals.curse;
    combatStats.fury = totals.fury;
    combatStats.weaken = totals.weaken;
    combatStats.ripple = totals.ripple;
    combatStats.bloom = totals.bloom;
    combatStats.blaze = totals.blaze;
    combatStats.attackSpeed = totals.attackSpeed;
    combatStats.foodHaste = totals.foodHaste;
    combatStats.drinkConcentration = totals.drinkConcentration;
    combatStats.autoAttackDamage = totals.autoAttackDamage;
    combatStats.abilityDamage = totals.abilityDamage;
    combatStats.staminaExperience = totals.staminaExperience;
    combatStats.intelligenceExperience = totals.intelligenceExperience;
    combatStats.attackExperience = totals.attackExperience;
    combatStats.defenseExperience = totals.defenseExperience;
    combatStats.meleeExperience = totals.meleeExperience;
    combatStats.rangedExperience = totals.rangedExperience;
    combatStats.magicExperience = totals.magicExperience;
    combatStats.retaliation = totals.retaliation;
}

/**
 * Build the equipment-total record. A literal so every totals object shares
 * one hidden class and copyEquipmentTotals reads it monomorphically, where
 * upstream's `{}` grown by keyed stores lands in dictionary mode.
 */
export function makeEquipmentTotals() {
    return {
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
        stabEvasion: 0,
        slashEvasion: 0,
        smashEvasion: 0,
        rangedEvasion: 0,
        magicEvasion: 0,
        armor: 0,
        waterResistance: 0,
        natureResistance: 0,
        fireResistance: 0,
        maxHitpoints: 0,
        maxManapoints: 0,
        lifeSteal: 0,
        hpRegenPer10: 0,
        mpRegenPer10: 0,
        physicalThorns: 0,
        elementalThorns: 0,
        combatDropRate: 0,
        combatRareFind: 0,
        combatDropQuantity: 0,
        combatExperience: 0,
        criticalRate: 0,
        criticalDamage: 0,
        armorPenetration: 0,
        waterPenetration: 0,
        naturePenetration: 0,
        firePenetration: 0,
        abilityHaste: 0,
        tenacity: 0,
        manaLeech: 0,
        castSpeed: 0,
        threat: 0,
        parry: 0,
        mayhem: 0,
        pierce: 0,
        curse: 0,
        fury: 0,
        weaken: 0,
        ripple: 0,
        bloom: 0,
        blaze: 0,
        attackSpeed: 0,
        foodHaste: 0,
        drinkConcentration: 0,
        autoAttackDamage: 0,
        abilityDamage: 0,
        staminaExperience: 0,
        intelligenceExperience: 0,
        attackExperience: 0,
        defenseExperience: 0,
        meleeExperience: 0,
        rangedExperience: 0,
        magicExperience: 0,
        retaliation: 0,
    };
}

/**
 * Force to 0 every stat the monster's game-data block does not declare.
 * The direct form of the 63-iteration keyed loop in
 * Monster.updateCombatDetails. The `== null` test is upstream's, kept
 * verbatim: it treats an explicit null as absent, which `!== undefined`
 * would not.
 *
 * The engine does NOT call this on the hot path — see the mask trio below,
 * which is 53x faster again. It is kept because it is the readable
 * statement of the contract, and the tests check the mask against it.
 */
export function zeroMissingMonsterStats(combatStats, gameStats) {
    if (gameStats.stabAccuracy == null) combatStats.stabAccuracy = 0;
    if (gameStats.slashAccuracy == null) combatStats.slashAccuracy = 0;
    if (gameStats.smashAccuracy == null) combatStats.smashAccuracy = 0;
    if (gameStats.rangedAccuracy == null) combatStats.rangedAccuracy = 0;
    if (gameStats.magicAccuracy == null) combatStats.magicAccuracy = 0;
    if (gameStats.stabDamage == null) combatStats.stabDamage = 0;
    if (gameStats.slashDamage == null) combatStats.slashDamage = 0;
    if (gameStats.smashDamage == null) combatStats.smashDamage = 0;
    if (gameStats.rangedDamage == null) combatStats.rangedDamage = 0;
    if (gameStats.magicDamage == null) combatStats.magicDamage = 0;
    if (gameStats.defensiveDamage == null) combatStats.defensiveDamage = 0;
    if (gameStats.taskDamage == null) combatStats.taskDamage = 0;
    if (gameStats.physicalAmplify == null) combatStats.physicalAmplify = 0;
    if (gameStats.waterAmplify == null) combatStats.waterAmplify = 0;
    if (gameStats.natureAmplify == null) combatStats.natureAmplify = 0;
    if (gameStats.fireAmplify == null) combatStats.fireAmplify = 0;
    if (gameStats.healingAmplify == null) combatStats.healingAmplify = 0;
    if (gameStats.stabEvasion == null) combatStats.stabEvasion = 0;
    if (gameStats.slashEvasion == null) combatStats.slashEvasion = 0;
    if (gameStats.smashEvasion == null) combatStats.smashEvasion = 0;
    if (gameStats.rangedEvasion == null) combatStats.rangedEvasion = 0;
    if (gameStats.magicEvasion == null) combatStats.magicEvasion = 0;
    if (gameStats.armor == null) combatStats.armor = 0;
    if (gameStats.waterResistance == null) combatStats.waterResistance = 0;
    if (gameStats.natureResistance == null) combatStats.natureResistance = 0;
    if (gameStats.fireResistance == null) combatStats.fireResistance = 0;
    if (gameStats.maxHitpoints == null) combatStats.maxHitpoints = 0;
    if (gameStats.maxManapoints == null) combatStats.maxManapoints = 0;
    if (gameStats.lifeSteal == null) combatStats.lifeSteal = 0;
    if (gameStats.hpRegenPer10 == null) combatStats.hpRegenPer10 = 0;
    if (gameStats.mpRegenPer10 == null) combatStats.mpRegenPer10 = 0;
    if (gameStats.physicalThorns == null) combatStats.physicalThorns = 0;
    if (gameStats.elementalThorns == null) combatStats.elementalThorns = 0;
    if (gameStats.combatDropRate == null) combatStats.combatDropRate = 0;
    if (gameStats.combatRareFind == null) combatStats.combatRareFind = 0;
    if (gameStats.combatDropQuantity == null) combatStats.combatDropQuantity = 0;
    if (gameStats.combatExperience == null) combatStats.combatExperience = 0;
    if (gameStats.criticalRate == null) combatStats.criticalRate = 0;
    if (gameStats.criticalDamage == null) combatStats.criticalDamage = 0;
    if (gameStats.armorPenetration == null) combatStats.armorPenetration = 0;
    if (gameStats.waterPenetration == null) combatStats.waterPenetration = 0;
    if (gameStats.naturePenetration == null) combatStats.naturePenetration = 0;
    if (gameStats.firePenetration == null) combatStats.firePenetration = 0;
    if (gameStats.abilityHaste == null) combatStats.abilityHaste = 0;
    if (gameStats.tenacity == null) combatStats.tenacity = 0;
    if (gameStats.manaLeech == null) combatStats.manaLeech = 0;
    if (gameStats.castSpeed == null) combatStats.castSpeed = 0;
    if (gameStats.threat == null) combatStats.threat = 0;
    if (gameStats.parry == null) combatStats.parry = 0;
    if (gameStats.mayhem == null) combatStats.mayhem = 0;
    if (gameStats.pierce == null) combatStats.pierce = 0;
    if (gameStats.curse == null) combatStats.curse = 0;
    if (gameStats.fury == null) combatStats.fury = 0;
    if (gameStats.weaken == null) combatStats.weaken = 0;
    if (gameStats.ripple == null) combatStats.ripple = 0;
    if (gameStats.bloom == null) combatStats.bloom = 0;
    if (gameStats.blaze == null) combatStats.blaze = 0;
    if (gameStats.attackSpeed == null) combatStats.attackSpeed = 0;
    if (gameStats.foodHaste == null) combatStats.foodHaste = 0;
    if (gameStats.drinkConcentration == null) combatStats.drinkConcentration = 0;
    if (gameStats.autoAttackDamage == null) combatStats.autoAttackDamage = 0;
    if (gameStats.abilityDamage == null) combatStats.abilityDamage = 0;
    if (gameStats.retaliation == null) combatStats.retaliation = 0;
}

/**
 * A per-block presence mask: true where the game-data block leaves the stat
 * absent and the recompute must therefore write 0.
 *
 * WHY THIS EXISTS, rather than reading the game data directly. Monster stat
 * blocks carry only the stats that monster actually has, so the bestiary
 * presents about 95 distinct object shapes. A read of `gameStats.armor` is
 * therefore megamorphic however it is written, and compiling the loop alone
 * recovers only a third of its cost. Measured over all 95 real blocks:
 * keyed loop 3844 ns, compiled named loads 2306 ns, mask 43.6 ns. The
 * megamorphic reads happen ONCE per distinct block, at build-of-mask time;
 * the recompute then reads a mask of one fixed shape.
 *
 * The mask MUST be cached against the game-data object's IDENTITY, never
 * against the monster hrid: dataProvider.setOverrides() can replace the whole
 * monster map at runtime and installs fresh nested objects, and an
 * hrid-keyed cache would then serve a previous game version's presence set
 * with no error at all.
 */
export function makeMonsterZeroMask() {
    return {
        stabAccuracy: false,
        slashAccuracy: false,
        smashAccuracy: false,
        rangedAccuracy: false,
        magicAccuracy: false,
        stabDamage: false,
        slashDamage: false,
        smashDamage: false,
        rangedDamage: false,
        magicDamage: false,
        defensiveDamage: false,
        taskDamage: false,
        physicalAmplify: false,
        waterAmplify: false,
        natureAmplify: false,
        fireAmplify: false,
        healingAmplify: false,
        stabEvasion: false,
        slashEvasion: false,
        smashEvasion: false,
        rangedEvasion: false,
        magicEvasion: false,
        armor: false,
        waterResistance: false,
        natureResistance: false,
        fireResistance: false,
        maxHitpoints: false,
        maxManapoints: false,
        lifeSteal: false,
        hpRegenPer10: false,
        mpRegenPer10: false,
        physicalThorns: false,
        elementalThorns: false,
        combatDropRate: false,
        combatRareFind: false,
        combatDropQuantity: false,
        combatExperience: false,
        criticalRate: false,
        criticalDamage: false,
        armorPenetration: false,
        waterPenetration: false,
        naturePenetration: false,
        firePenetration: false,
        abilityHaste: false,
        tenacity: false,
        manaLeech: false,
        castSpeed: false,
        threat: false,
        parry: false,
        mayhem: false,
        pierce: false,
        curse: false,
        fury: false,
        weaken: false,
        ripple: false,
        bloom: false,
        blaze: false,
        attackSpeed: false,
        foodHaste: false,
        drinkConcentration: false,
        autoAttackDamage: false,
        abilityDamage: false,
        retaliation: false,
    };
}

/** Build the mask for one game-data stat block. Once per block, not per recompute. */
export function buildMonsterZeroMask(gameStats) {
    const mask = makeMonsterZeroMask();
    mask.stabAccuracy = gameStats.stabAccuracy == null;
    mask.slashAccuracy = gameStats.slashAccuracy == null;
    mask.smashAccuracy = gameStats.smashAccuracy == null;
    mask.rangedAccuracy = gameStats.rangedAccuracy == null;
    mask.magicAccuracy = gameStats.magicAccuracy == null;
    mask.stabDamage = gameStats.stabDamage == null;
    mask.slashDamage = gameStats.slashDamage == null;
    mask.smashDamage = gameStats.smashDamage == null;
    mask.rangedDamage = gameStats.rangedDamage == null;
    mask.magicDamage = gameStats.magicDamage == null;
    mask.defensiveDamage = gameStats.defensiveDamage == null;
    mask.taskDamage = gameStats.taskDamage == null;
    mask.physicalAmplify = gameStats.physicalAmplify == null;
    mask.waterAmplify = gameStats.waterAmplify == null;
    mask.natureAmplify = gameStats.natureAmplify == null;
    mask.fireAmplify = gameStats.fireAmplify == null;
    mask.healingAmplify = gameStats.healingAmplify == null;
    mask.stabEvasion = gameStats.stabEvasion == null;
    mask.slashEvasion = gameStats.slashEvasion == null;
    mask.smashEvasion = gameStats.smashEvasion == null;
    mask.rangedEvasion = gameStats.rangedEvasion == null;
    mask.magicEvasion = gameStats.magicEvasion == null;
    mask.armor = gameStats.armor == null;
    mask.waterResistance = gameStats.waterResistance == null;
    mask.natureResistance = gameStats.natureResistance == null;
    mask.fireResistance = gameStats.fireResistance == null;
    mask.maxHitpoints = gameStats.maxHitpoints == null;
    mask.maxManapoints = gameStats.maxManapoints == null;
    mask.lifeSteal = gameStats.lifeSteal == null;
    mask.hpRegenPer10 = gameStats.hpRegenPer10 == null;
    mask.mpRegenPer10 = gameStats.mpRegenPer10 == null;
    mask.physicalThorns = gameStats.physicalThorns == null;
    mask.elementalThorns = gameStats.elementalThorns == null;
    mask.combatDropRate = gameStats.combatDropRate == null;
    mask.combatRareFind = gameStats.combatRareFind == null;
    mask.combatDropQuantity = gameStats.combatDropQuantity == null;
    mask.combatExperience = gameStats.combatExperience == null;
    mask.criticalRate = gameStats.criticalRate == null;
    mask.criticalDamage = gameStats.criticalDamage == null;
    mask.armorPenetration = gameStats.armorPenetration == null;
    mask.waterPenetration = gameStats.waterPenetration == null;
    mask.naturePenetration = gameStats.naturePenetration == null;
    mask.firePenetration = gameStats.firePenetration == null;
    mask.abilityHaste = gameStats.abilityHaste == null;
    mask.tenacity = gameStats.tenacity == null;
    mask.manaLeech = gameStats.manaLeech == null;
    mask.castSpeed = gameStats.castSpeed == null;
    mask.threat = gameStats.threat == null;
    mask.parry = gameStats.parry == null;
    mask.mayhem = gameStats.mayhem == null;
    mask.pierce = gameStats.pierce == null;
    mask.curse = gameStats.curse == null;
    mask.fury = gameStats.fury == null;
    mask.weaken = gameStats.weaken == null;
    mask.ripple = gameStats.ripple == null;
    mask.bloom = gameStats.bloom == null;
    mask.blaze = gameStats.blaze == null;
    mask.attackSpeed = gameStats.attackSpeed == null;
    mask.foodHaste = gameStats.foodHaste == null;
    mask.drinkConcentration = gameStats.drinkConcentration == null;
    mask.autoAttackDamage = gameStats.autoAttackDamage == null;
    mask.abilityDamage = gameStats.abilityDamage == null;
    mask.retaliation = gameStats.retaliation == null;
    return mask;
}

/**
 * Apply a prebuilt mask. Same names, same order, same written value as the
 * keyed loop this replaces, so no number can move.
 */
export function applyMonsterZeroMask(combatStats, mask) {
    if (mask.stabAccuracy) combatStats.stabAccuracy = 0;
    if (mask.slashAccuracy) combatStats.slashAccuracy = 0;
    if (mask.smashAccuracy) combatStats.smashAccuracy = 0;
    if (mask.rangedAccuracy) combatStats.rangedAccuracy = 0;
    if (mask.magicAccuracy) combatStats.magicAccuracy = 0;
    if (mask.stabDamage) combatStats.stabDamage = 0;
    if (mask.slashDamage) combatStats.slashDamage = 0;
    if (mask.smashDamage) combatStats.smashDamage = 0;
    if (mask.rangedDamage) combatStats.rangedDamage = 0;
    if (mask.magicDamage) combatStats.magicDamage = 0;
    if (mask.defensiveDamage) combatStats.defensiveDamage = 0;
    if (mask.taskDamage) combatStats.taskDamage = 0;
    if (mask.physicalAmplify) combatStats.physicalAmplify = 0;
    if (mask.waterAmplify) combatStats.waterAmplify = 0;
    if (mask.natureAmplify) combatStats.natureAmplify = 0;
    if (mask.fireAmplify) combatStats.fireAmplify = 0;
    if (mask.healingAmplify) combatStats.healingAmplify = 0;
    if (mask.stabEvasion) combatStats.stabEvasion = 0;
    if (mask.slashEvasion) combatStats.slashEvasion = 0;
    if (mask.smashEvasion) combatStats.smashEvasion = 0;
    if (mask.rangedEvasion) combatStats.rangedEvasion = 0;
    if (mask.magicEvasion) combatStats.magicEvasion = 0;
    if (mask.armor) combatStats.armor = 0;
    if (mask.waterResistance) combatStats.waterResistance = 0;
    if (mask.natureResistance) combatStats.natureResistance = 0;
    if (mask.fireResistance) combatStats.fireResistance = 0;
    if (mask.maxHitpoints) combatStats.maxHitpoints = 0;
    if (mask.maxManapoints) combatStats.maxManapoints = 0;
    if (mask.lifeSteal) combatStats.lifeSteal = 0;
    if (mask.hpRegenPer10) combatStats.hpRegenPer10 = 0;
    if (mask.mpRegenPer10) combatStats.mpRegenPer10 = 0;
    if (mask.physicalThorns) combatStats.physicalThorns = 0;
    if (mask.elementalThorns) combatStats.elementalThorns = 0;
    if (mask.combatDropRate) combatStats.combatDropRate = 0;
    if (mask.combatRareFind) combatStats.combatRareFind = 0;
    if (mask.combatDropQuantity) combatStats.combatDropQuantity = 0;
    if (mask.combatExperience) combatStats.combatExperience = 0;
    if (mask.criticalRate) combatStats.criticalRate = 0;
    if (mask.criticalDamage) combatStats.criticalDamage = 0;
    if (mask.armorPenetration) combatStats.armorPenetration = 0;
    if (mask.waterPenetration) combatStats.waterPenetration = 0;
    if (mask.naturePenetration) combatStats.naturePenetration = 0;
    if (mask.firePenetration) combatStats.firePenetration = 0;
    if (mask.abilityHaste) combatStats.abilityHaste = 0;
    if (mask.tenacity) combatStats.tenacity = 0;
    if (mask.manaLeech) combatStats.manaLeech = 0;
    if (mask.castSpeed) combatStats.castSpeed = 0;
    if (mask.threat) combatStats.threat = 0;
    if (mask.parry) combatStats.parry = 0;
    if (mask.mayhem) combatStats.mayhem = 0;
    if (mask.pierce) combatStats.pierce = 0;
    if (mask.curse) combatStats.curse = 0;
    if (mask.fury) combatStats.fury = 0;
    if (mask.weaken) combatStats.weaken = 0;
    if (mask.ripple) combatStats.ripple = 0;
    if (mask.bloom) combatStats.bloom = 0;
    if (mask.blaze) combatStats.blaze = 0;
    if (mask.attackSpeed) combatStats.attackSpeed = 0;
    if (mask.foodHaste) combatStats.foodHaste = 0;
    if (mask.drinkConcentration) combatStats.drinkConcentration = 0;
    if (mask.autoAttackDamage) combatStats.autoAttackDamage = 0;
    if (mask.abilityDamage) combatStats.abilityDamage = 0;
    if (mask.retaliation) combatStats.retaliation = 0;
}
