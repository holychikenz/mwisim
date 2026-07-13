import Monster from "./monster";
import { labyrinthCrateDetailMap } from "./dataProvider";

class Labyrinth{
    // In-game labyrinth room timer: each room must be cleared within 120 s or
    // it counts as a failed attempt. Single source of truth — consumed both by
    // checkTimeout() and by CombatSimulator when it schedules the hard-cutoff
    // LabyrinthTimeoutEvent.
    static ROOM_DURATION_NS = 120 * 1e9;

    constructor(monsterHrid, roomLevel, crates=[]) {
        this.monsterHrid = monsterHrid;
        this.roomLevel = roomLevel;

        this.buffs = [];
        if (crates) {
            for (let crate of crates) {
                this.buffs = this.buffs.concat(labyrinthCrateDetailMap[crate]);
            }
        }

        this.attemptCount = 0;
    }

    getMonster () {
        this.attemptCount ++;
        return [new Monster(this.monsterHrid, 0, this.roomLevel)];
    }

    updateEnconterStartTime (enconterStartTime) {
        this.enconterStartTime = enconterStartTime;
    }
    
    checkTimeout (currentTime) {
        return currentTime - this.enconterStartTime > Labyrinth.ROOM_DURATION_NS;
    }

}

export default Labyrinth;
