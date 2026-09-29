import CombatEvent from "./combatEvent";

// MWIX adaptation (dungeon run mode): the per-run time limit.
//
// Only scheduled when simulate() is given run limits
// ({ maxRuns, maxRunDurationNs }). It is booked the moment a dungeon run's
// first wave spawns, at runStart + maxRunDurationNs. If it pops with the run
// still going, the run fails: CombatSimulator.processDungeonRunTimeoutEvent
// books the restart through the same path as a wipe, so zone.failWave() is
// still called in exactly one place (startNewEncounter).
//
// As with LabyrinthTimeoutEvent, the queue is a min-heap on time, so this is
// popped before any combat event scheduled after the deadline.
//
// `runStartTime` lets the handler reject a timeout left over from a run that
// already ended (a new run clears the old timeout, but this is the guard).
class DungeonRunTimeoutEvent extends CombatEvent {
    static type = "dungeonRunTimeout";

    constructor(time, runStartTime) {
        super(DungeonRunTimeoutEvent.type, time);
        this.runStartTime = runStartTime;
    }
}

export default DungeonRunTimeoutEvent;
