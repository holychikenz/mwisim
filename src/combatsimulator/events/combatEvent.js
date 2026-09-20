import { eventTypeId } from "./eventTypeIds";

class CombatEvent {
    constructor(type, time) {
        this.type = type;
        this.time = time;
        // MWIX adaptation (performance): the integer twin of `type`, so the
        // event queue's scans compare an int rather than a string. `type` is
        // kept and still authoritative — nothing reads typeId except
        // EventQueue. See events/eventTypeIds.js.
        this.typeId = eventTypeId(type);
    }
}

export default CombatEvent;
