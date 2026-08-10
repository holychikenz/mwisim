import { combatStyleDetailMap, abilityDetailMap, houseRoomDetailMap } from "./dataProvider";

// MWIX adaptation: collect a player's permanent buffs grouped by their
// ORIGINAL source (house room / labyrinth crate / achievements / community &
// lab-shop). The engine merges all same-type buffs into one permanentBuffs
// entry keyed by typeHrid, which discards the source — so we read the raw
// source arrays still present on the unit at combat start instead. Used to
// render the "where does every bonus come from" breakdown in the lab UI.
function _collectBuffSources(unit) {
    const sources = [];
    const add = (source, buffs) => {
        const cleaned = (buffs || [])
            .filter(Boolean)
            .map((b) => ({
                typeHrid: b.typeHrid,
                flatBoost: b.flatBoost || 0,
                ratioBoost: b.ratioBoost || 0,
            }))
            .filter((b) => b.flatBoost || b.ratioBoost);
        if (cleaned.length) {
            sources.push({ source, buffs: cleaned });
        }
    };

    for (const houseRoom of unit.houseRooms || []) {
        add(houseRoomDetailMap[houseRoom.hrid]?.name || houseRoom.hrid, houseRoom.buffs);
    }
    if (unit.achievements?.buffs?.length) {
        add("Achievements", unit.achievements.buffs);
    }
    add("Labyrinth crates", unit.zoneBuffs);

    // MWIX adaptation (guild expansion, 7/13/2026): guild shrine buffs now ride
    // in on extraBuffs for EVERY sim (they are permanent character buffs, not
    // trial-only), and guild building buffs join them inside trials. Split them
    // out so the breakdown does not file them under "community".
    const extra = unit.extraBuffs || [];
    const isGuildBuff = (b) =>
        typeof b?.uniqueHrid === "string" &&
        (b.uniqueHrid.endsWith("_guild_buff") || b.uniqueHrid.includes("guild_building_"));
    add("Community / pass / lab-shop", extra.filter((b) => !isGuildBuff(b)));
    add("Guild shrines / buildings", extra.filter(isGuildBuff));
    return sources;
}

class SimResult {
    constructor(zone, labyrinth, numberOfPlayers) {
        this.deaths = {};
        this.experienceGained = {};
        this.encounters = 0;
        this.attacks = {};
        this.consumablesUsed = {};
        this.hitpointsGained = {};
        this.manapointsGained = {};
        this.debuffOnLevelGap = {};
        this.dropRateMultiplier = {};
        this.rareFindMultiplier = {};
        this.combatDropQuantity = {};
        this.playerRanOutOfMana = {
            "player1": false,
            "player2": false,
            "player3": false,
            "player4": false,
            "player5": false
        };
        this.playerRanOutOfManaTime = {};
        this.manaUsed = {};
        this.timeSpentAlive = [];
        this.bossSpawns = [];
        this.hitpointsSpent = {};
        this.zoneName = zone?.hrid;
        this.difficultyTier = zone?.difficultyTier;
        this.labyrinthName = labyrinth?.monsterHrid;
        this.roomLevel = labyrinth?.roomLevel;
        this.isDungeon = false;
        this.isLabyrinth = labyrinth ? true : false;
        this.dungeonsCompleted = 0;
        this.dungeonsFailed = 0;
        this.maxWaveReached = 0;
        this.numberOfPlayers = numberOfPlayers;
        this.maxEnrageStack = 0;
        this.minDungenonTime = 0;
        this.maxDungenonTime = 0;
        this.lastDungeonFinishTime = 0;
        this.lastEncounterFinishTime = 0;
        // MWIX adaptation: time of the FIRST encounter completion. Stays 0
        // until addEncounterEnd is observed by combatSimulator and the
        // current simulationTime is recorded. Useful for callers that
        // want a single-attempt "clear time" (labyrinth room solve time)
        // rather than the average across many cycles.
        this.firstEncounterFinishTime = 0;
        this.labyAttemptCount = 0;

        // MWIX adaptation: per-room labyrinth outcome log. One entry per
        // RESOLVED room (win / death / timeout) with the monster's HP%
        // remaining at the moment the room ended — 0 on a win, the surviving
        // fraction on a death or timeout. Lets a caller print every attempt's
        // result to the console for debugging. Populated only for labyrinth
        // runs; the final, window-truncated room is intentionally not logged
        // (it never resolved).
        this.labRoomOutcomes = [];

        this.wipeEvents = [];

        // ---- Guild Trial results (populated only for trial runs) ------------
        // Per-iteration trial outcome. isGuildTrial gates everything; the rest
        // is written incrementally during the run and finalised in
        // finalizeGuildTrial(). Zone/labyrinth fields above are untouched.
        this.isGuildTrial = false;
        this.trialHrid = null;
        this.trialStartTier = 0;
        this.trialParticipantCount = 0;
        this.trialTiersCleared = 0;      // distinct tiers cleared (no re-clears exist)
        this.trialMaxTierCleared = 0;    // highest tier LEVEL fully cleared (0 = none)
        this.trialCurrentTier = 0;       // tier in progress (or just cleared, for "completed") when the run ended
        this.trialEndReason = null;      // "wipe" | "timeout" | "completed" (cap tier 300 cleared)
        this.trialEndTime = 0;           // sim time (ns) the run ended
        // Fraction (0..1) of the final tier's encounter total max HP removed
        // when the run ended: 1.0 for "completed"; live sum(max-current)/sum(max)
        // for "wipe"/mid-encounter "timeout"; 0 for a timeout in the respawn
        // gap (next encounter never spawned — see combatSimulator.simulate).
        this.trialFinalTierHpRemovedFrac = 0;
        this.trialTierTimes = {};        // { tier: nsSpentToClear }
        this.trialTierStartTimes = {};   // { tier: nsWhenTierBegan }
        this.trialPlayerDeaths = {};     // { hrid: [tier, ...] } tiers a player died at

        // MWIX adaptation: snapshots of the ACTUAL combat stats the engine
        // computed and used during the run, captured once at the first
        // encounter (see combatSimulator.startNewEncounter). Surfaced in the
        // UI's labyrinth "Lab Stats" panel so any discrepancy versus the live
        // game can be spotted. The player snapshot reflects all permanent
        // buffs active at combat start (house / achievements / labyrinth
        // crates / lab-shop upgrades); the monster snapshot is the
        // room-level-scaled stats plus its ability list. Populated only for
        // labyrinth runs for now.
        this.playerStats = [];
        this.monsterStats = [];

        // 时间序列数据用于图表显示
        this.timeSeriesData = {
            timestamps: [],
            players: {}
        };
    }

    // MWIX adaptation: capture the live combat-stat objects in use, once.
    // Deep-clones combatDetails so later in-combat buff mutations cannot
    // rewrite the snapshot. Idempotent — only the first call records data.
    captureStatSnapshot(players, enemies) {
        if (this.playerStats.length > 0) {
            return;
        }

        this.playerStats = (players || []).map((p) => ({
            hrid: p.hrid,
            combatStyleHrid: p.combatDetails?.combatStats?.combatStyleHrid,
            combatDetails: structuredClone(p.combatDetails),
            // Unbuffed base skill levels, so the UI can show base → +buffs →
            // final (the derived combatDetails levels already include buffs).
            baseLevels: {
                stamina: p.staminaLevel,
                intelligence: p.intelligenceLevel,
                attack: p.attackLevel,
                melee: p.meleeLevel,
                defense: p.defenseLevel,
                ranged: p.rangedLevel,
                magic: p.magicLevel,
            },
            // Permanent buffs grouped by source (Dojo, coffee crate, ...).
            buffSources: _collectBuffSources(p),
        }));

        this.monsterStats = (enemies || []).map((m) => ({
            hrid: m.hrid,
            difficultyTier: m.difficultyTier,
            roomLevel: m.roomLevel,
            combatDetails: structuredClone(m.combatDetails),
            abilities: (m.abilities || []).filter(Boolean).map((a) => ({
                hrid: a.hrid,
                name: abilityDetailMap[a.hrid]?.name,
                level: a.level,
                manaCost: a.manaCost,
                cooldownDuration: a.cooldownDuration,
                castDuration: a.castDuration,
            })),
        }));
    }

    addWipeEvent(logs, simulationTime, wave) {
        this.wipeEvents.push({
            simulationTime: simulationTime,
            logs: logs,
            wave: wave,
            timestamp: new Date().toISOString()
        });
    }
    
    addDeath(unit) {
        if (!this.deaths[unit.hrid]) {
            this.deaths[unit.hrid] = 0;
        }

        this.deaths[unit.hrid] += 1;
    }

    updateTimeSpentAlive(name, alive, time) {
        const i = this.timeSpentAlive.findIndex(e => e.name === name);
        if (alive) {
            if (i !== -1) {
                this.timeSpentAlive[i].alive = true;
                this.timeSpentAlive[i].spawnedAt = time;
            } else {
                this.timeSpentAlive.push({ name: name, timeSpentAlive: 0, spawnedAt: time, alive: true, count: 0 });
            }
        } else {
            const timeAlive = time - this.timeSpentAlive[i].spawnedAt;
            this.timeSpentAlive[i].alive = false;
            this.timeSpentAlive[i].timeSpentAlive += timeAlive;
            this.timeSpentAlive[i].count += 1;
        }
    }

    updateDungenonFinish(beginFlag, finishTime) {
        const i = this.timeSpentAlive.findIndex(e => e.name === beginFlag); 
        if (i == -1) {
            return;
        }

        const currentDungenonTime = finishTime - this.timeSpentAlive[i].spawnedAt;

        if (this.minDungenonTime == 0 || this.minDungenonTime > currentDungenonTime) {
            this.minDungenonTime = currentDungenonTime;
        }

        if (this.maxDungenonTime < currentDungenonTime) {
            this.maxDungenonTime = currentDungenonTime;
        }
    }

    addExperienceGain(unit, experience) {
        if (!unit.isPlayer) {
            return;
        }

        if (!this.experienceGained[unit.hrid]) {
            this.experienceGained[unit.hrid] = {
                stamina: 0,
                intelligence: 0,
                attack: 0,
                melee: 0,
                defense: 0,
                ranged: 0,
                magic: 0,
            };
        }

        let experienceGainedRate = {
            "stamina": 0,
            "intelligence": 0,
            "attack": 0,
            "melee": 0,
            "defense": 0,
            "ranged": 0,
            "magic": 0,
        };

        const primaryTraining = unit.combatDetails.combatStats.primaryTraining;
        experienceGainedRate[primaryTraining.split("/")[2]] = .3;

        const skillExpMap = combatStyleDetailMap[unit.combatDetails.combatStats.combatStyleHrid].skillExpMap;
        const skillExpMapLength = Object.keys(skillExpMap).length;

        const focusTraining = unit.combatDetails.combatStats.focusTraining;
        if (focusTraining && skillExpMap[focusTraining]) {
            experienceGainedRate[focusTraining.split("/")[2]] += .7;
        } else {
            Object.keys(skillExpMap).forEach(skillHrid => {
                experienceGainedRate[skillHrid.split("/")[2]] += .7 / skillExpMapLength;
            });
        }

        for (const [type, rate] of Object.entries(experienceGainedRate)) {
            if (rate <= 0) continue;

            const skillExperience = rate * (1 + unit.combatDetails.combatStats[type + "Experience"]);

            this.experienceGained[unit.hrid][type] += (
                experience
                * (1 + unit.combatDetails.combatStats.combatExperience)
                * skillExperience
                * (1 + unit.debuffOnLevelGap)

            );
        }
    }

    addEncounterEnd() {
        this.encounters++;
    }

    // MWIX adaptation: record one resolved labyrinth room. `outcome` is
    // "win" | "death" | "timeout"; `monsterHpPct` is the monster's HP%
    // remaining (0 on a win); `time` is the simulation time (ns) at the end;
    // `startTime` is the sim time (ns) when this room began. The room's own
    // duration is `time - startTime` — for a timeout that is the 120 s ceiling.
    addLabRoomOutcome(outcome, monsterHpPct, time, startTime) {
        this.labRoomOutcomes.push({ outcome, monsterHpPct, time, startTime });
    }

    // ---- Guild Trial recorders ---------------------------------------------

    // A tier's encounter just spawned. Records the tier's start time (used to
    // report partial time if the run ends mid-tier).
    recordTrialTierStart(tier, time) {
        if (this.trialTierStartTimes[tier] === undefined) {
            this.trialTierStartTimes[tier] = time;
        }
    }

    // A tier was cleared. `timeSpent` is ns from the tier's spawn to its clear.
    // Each tier is fought at most once (the run completes on clearing the cap),
    // so the undefined-guard is just defensive.
    recordTrialTierClear(tier, timeSpent, atTime) {
        if (this.trialTierTimes[tier] === undefined) {
            this.trialTierTimes[tier] = timeSpent;
        }
    }

    // A player died at `tier`. Appends so a revived-then-re-died player is
    // recorded once per death.
    recordTrialPlayerDeath(hrid, tier, time) {
        if (!this.trialPlayerDeaths[hrid]) {
            this.trialPlayerDeaths[hrid] = [];
        }
        this.trialPlayerDeaths[hrid].push(tier);
    }

    // The party wiped at `tier` — the run is over. `hpRemovedFrac` (0..1) is
    // how much of the tier's encounter total max HP had been removed at the
    // wipe. First recorded end reason wins: if the same checkEncounterEnd both
    // cleared the cap tier AND saw the party die (mutual kill via thorns),
    // "completed" was recorded first and takes precedence.
    recordTrialWipe(tier, time, hpRemovedFrac = 0) {
        if (this.trialEndReason) return;
        this.trialCurrentTier = tier;
        this.trialEndReason = "wipe";
        this.trialEndTime = time;
        this.trialFinalTierHpRemovedFrac = Math.min(1, Math.max(0, hpRemovedFrac));
    }

    // The cap tier (300) was cleared — nothing further to fight; the run is
    // COMPLETE. Distinct from "wipe" and "timeout". The final tier was fully
    // cleared, so its HP-removed fraction is exactly 1.
    recordTrialCompleted(time) {
        if (this.trialEndReason) return;
        this.trialEndReason = "completed";
        this.trialEndTime = time;
        this.trialFinalTierHpRemovedFrac = 1;
    }

    // Called once at the end of a trial run to snapshot ladder state. A wipe /
    // completion already recorded its end reason, tier and HP-removed fraction
    // (first record wins); only the timeout path — where the loop simply
    // stopped — fills them here, with `hpRemovedFrac` computed at loop exit.
    finalizeGuildTrial(guildTrial, { endReason, endTime, hpRemovedFrac } = {}) {
        this.isGuildTrial = true;
        this.trialHrid = guildTrial.trialHrid;
        this.trialStartTier = guildTrial.startTier;
        this.trialParticipantCount = guildTrial.participantCount;
        this.trialTiersCleared = guildTrial.tiersCleared;
        this.trialMaxTierCleared = guildTrial.maxTierCleared;
        if (!this.trialCurrentTier) {
            this.trialCurrentTier = guildTrial.currentTier;
        }
        if (!this.trialEndReason) {
            this.trialEndReason = endReason || "timeout";
            this.trialEndTime = endTime || this.simulatedTime;
            this.trialFinalTierHpRemovedFrac = Math.min(1, Math.max(0, hpRemovedFrac ?? 0));
        }
    }

    addAttack(source, target, ability, hit) {
        if (!this.attacks[source.hrid]) {
            this.attacks[source.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid]) {
            this.attacks[source.hrid][target.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid][ability]) {
            this.attacks[source.hrid][target.hrid][ability] = {};
        }

        if (!this.attacks[source.hrid][target.hrid][ability][hit]) {
            this.attacks[source.hrid][target.hrid][ability][hit] = 0;
        }

        this.attacks[source.hrid][target.hrid][ability][hit] += 1;
    }

    addConsumableUse(unit, consumable) {
        if (!this.consumablesUsed[unit.hrid]) {
            this.consumablesUsed[unit.hrid] = {};
        }
        if (!this.consumablesUsed[unit.hrid][consumable.hrid]) {
            this.consumablesUsed[unit.hrid][consumable.hrid] = 0;
        }

        this.consumablesUsed[unit.hrid][consumable.hrid] += 1;
    }

    addHitpointsGained(unit, source, amount) {
        if (!this.hitpointsGained[unit.hrid]) {
            this.hitpointsGained[unit.hrid] = {};
        }
        if (!this.hitpointsGained[unit.hrid][source]) {
            this.hitpointsGained[unit.hrid][source] = 0;
        }

        this.hitpointsGained[unit.hrid][source] += amount;
    }

    addManapointsGained(unit, source, amount) {
        if (!this.manapointsGained[unit.hrid]) {
            this.manapointsGained[unit.hrid] = {};
        }
        if (!this.manapointsGained[unit.hrid][source]) {
            this.manapointsGained[unit.hrid][source] = 0;
        }

        this.manapointsGained[unit.hrid][source] += amount;
    }

    setDropRateMultipliers(unit) {
        if (!this.dropRateMultiplier[unit.hrid]) {
            this.dropRateMultiplier[unit.hrid] = {};
        }
        this.dropRateMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatDropRate;

        if (!this.rareFindMultiplier[unit.hrid]) {
            this.rareFindMultiplier[unit.hrid] = {};
        }
        this.rareFindMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatRareFind;

        if (!this.combatDropQuantity[unit.hrid]) {
            this.combatDropQuantity[unit.hrid] = {};
        }
        this.combatDropQuantity[unit.hrid] = unit.combatDetails.combatStats.combatDropQuantity;

        if (!this.debuffOnLevelGap[unit.hrid]) {
            this.debuffOnLevelGap[unit.hrid] = {};
        }
        this.debuffOnLevelGap[unit.hrid] = unit.debuffOnLevelGap;
    }

    setManaUsed(unit) {
        this.manaUsed[unit.hrid] = {};
        for (let [key, value] of unit.abilityManaCosts.entries()) {
            this.manaUsed[unit.hrid][key] = value;
        }
    }

    addHitpointsSpent(unit, source, amount) {
        if (!this.hitpointsSpent[unit.hrid]) {
            this.hitpointsSpent[unit.hrid] = {};
        }
        if (!this.hitpointsSpent[unit.hrid][source]) {
            this.hitpointsSpent[unit.hrid][source] = 0;
        }

        this.hitpointsSpent[unit.hrid][source] += amount;
    }

    addRanOutOfManaCount(unit, isOutOfMana, time) {
        if (isOutOfMana) this.playerRanOutOfMana[unit.hrid] = true;

        if (!this.playerRanOutOfManaTime[unit.hrid]) {
            this.playerRanOutOfManaTime[unit.hrid] = {isOutOfMana: false, startTimeForOutOfMana:0, totalTimeForOutOfMana:0};
        }

        if (isOutOfMana) {
            if (!this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
                this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = true;
                this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana = time;
            }
        } else {
            if (this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
                this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = false;
                this.playerRanOutOfManaTime[unit.hrid].totalTimeForOutOfMana += time - this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana;
            }
        }
    }

    // 添加时间序列数据点
    addTimeSeriesSnapshot(time, players) {
        this.timeSeriesData.timestamps.push(time);
        
        players.forEach(player => {
            if (!this.timeSeriesData.players[player.hrid]) {
                this.timeSeriesData.players[player.hrid] = {
                    hp: [],
                    mp: [],
                    maxHp: [],
                    maxMp: []
                };
            }
            
            const playerData = this.timeSeriesData.players[player.hrid];
            playerData.hp.push(player.combatDetails.currentHitpoints);
            playerData.mp.push(player.combatDetails.currentManapoints);
            playerData.maxHp.push(player.combatDetails.maxHitpoints);
            playerData.maxMp.push(player.combatDetails.maxManapoints);
        });
    }
}

export default SimResult;
