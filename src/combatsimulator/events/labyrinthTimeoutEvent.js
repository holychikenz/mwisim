import CombatEvent from "./combatEvent";

// Hard 120-second labyrinth room cutoff. Scheduled at
// encounterStart + Labyrinth.ROOM_DURATION_NS the moment a labyrinth
// encounter begins (see CombatSimulator.startNewEncounter).
//
// Because the event queue is a min-heap ordered by time (events/eventQueue.js),
// this event is ALWAYS popped before any combat event scheduled past the 120 s
// ceiling. The killing blow that previously slipped in just after the timer
// expired — and was wrongly counted as a clear — is therefore never simulated:
// the room ends at the buzzer and is recorded as a FAILED attempt (no
// addEncounterEnd, no experience), exactly as the in-game labyrinth behaves.
//
// `encounterStartTime` lets the handler reject a stale timeout. Every room
// reset clears the queue (so a fired room's pending timeout is normally
// removed), but this is belt-and-braces against a timeout outliving the
// encounter it was scheduled for.
class LabyrinthTimeoutEvent extends CombatEvent {
    static type = "labyrinthTimeout";

    constructor(time, encounterStartTime) {
        super(LabyrinthTimeoutEvent.type, time);
        this.encounterStartTime = encounterStartTime;
    }
}

export default LabyrinthTimeoutEvent;
