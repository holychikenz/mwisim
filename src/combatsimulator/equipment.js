import { itemDetailMap, enhancementLevelTotalMultiplierTable } from "./dataProvider";

class Equipment {
    constructor(hrid, enhancementLevel) {
        this.hrid = hrid;
        let gameItem = itemDetailMap[this.hrid];
        if (!gameItem) {
            throw new Error("No equipment found for hrid: " + this.hrid);
        }
        this.gameItem = gameItem;
        this.enhancementLevel = enhancementLevel;
    }

    static createFromDTO(dto) {
        let equipment = new Equipment(dto.hrid, dto.enhancementLevel);

        return equipment;
    }

    // MWIX adaptation (performance): memoised. A profile of one simulated hour
    // of chimerical_den T0 / L600 / 5 geared players counted 2 710 422 calls to
    // this method — 213 per event processed — and it held 4.5% of self time.
    // The result is a pure function of (hrid, enhancementLevel, combatStat).
    // `hrid` is written only by the constructor. `enhancementLevel` is too, as
    // far as the engine and its callers go — every caller that "changes" gear
    // builds a NEW Equipment (src/main.js updateEquipmentState) or mutates a
    // plain DTO before Player.createFromDTO (api/lib/equipmentScan/
    // candidates.js applyEnhancement) — but nothing in the language stops an
    // assignment, and a silently stale stat is unfalsifiable from the outside.
    // So the memo is keyed on the level as well and rebuilt if it moves: one
    // integer comparison per call against a whole class of future bug.
    //
    // A Map rather than a null-prototype object: the key set here is dynamic
    // (whichever stats a caller happens to ask for), which is precisely the
    // dictionary-mode case V8 handles better with Map than with a plain object.
    getCombatStat(combatStat) {
        let memo = this._combatStatMemo;
        if (memo === undefined || this._combatStatMemoLevel !== this.enhancementLevel) {
            memo = this._combatStatMemo = new Map();
            this._combatStatMemoLevel = this.enhancementLevel;
        }
        let cached = memo.get(combatStat);
        if (cached === undefined) {
            cached = this._computeCombatStat(combatStat);
            memo.set(combatStat, cached);
        }
        return cached;
    }

    // Upstream's getCombatStat body, verbatim.
    _computeCombatStat(combatStat) {
        let multiplier = enhancementLevelTotalMultiplierTable[this.enhancementLevel];
        if(this.gameItem.equipmentDetail.combatStats[combatStat]) {
            let enhancementBonus = this.gameItem.equipmentDetail.combatEnhancementBonuses[combatStat] || 0;
            let stat = this.gameItem.equipmentDetail.combatStats[combatStat] + multiplier * enhancementBonus;
            return stat;
        }
        return 0;
    }

    getCombatStyle() {
        return this.gameItem.equipmentDetail.combatStats.combatStyleHrids[0];
    }

    getDamageType() {
        return this.gameItem.equipmentDetail.combatStats.damageType;
    }

    getPrimaryTraining() {
        return this.gameItem.equipmentDetail.combatStats.primaryTraining;
    }

    getFocusTraining(){
        return this.gameItem.equipmentDetail.combatStats.focusTraining;
    }
}

export default Equipment;
