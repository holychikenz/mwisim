import Heap from "heap-js";
import { eventTypeId } from "./eventTypeIds";

// =============================================================================
// MWIX adaptation (performance): scan the heap's backing array in place.
//
// Every predicate method below used to call `this.minHeap.toArray()`. heap-js
// 2.7.1 implements that as
//
//     Heap.prototype.toArray = function () {
//         return __spreadArray([], __read(this.heapArray), false);
//     };
//
// — the TypeScript ES5 downlevel helpers, i.e. a full copy that walks the array
// through Symbol.iterator and allocates an iterator-result object PER ELEMENT.
// One simulated hour of chimerical_den T0 / L600 / 5 geared players made 32 936
// such scans over 2 305 965 heap entries (mean heap length 70); heap-js's
// `__read` alone held 4.0% of self time in the CPU profile.
//
// `heapArray` is a public, typed field on the Heap class —
//   dist/types/Heap.d.ts:  `compare: Comparator<T>;  heapArray: Array<T>;  _limit: number;`
// — with no `private`/`protected`/`@internal` marker, and heap-js's own
// `clone()` assigns to it. But it is NOT in the README's public API list and
// carries no jsdoc, so it is "public but undocumented": a minor release could
// rename it without anyone considering that a break. Two mitigations:
//
//   1. `heap-js` is pinned to an exact version (2.7.1) in every package.json
//      that declares it (root, api/, ui/) rather than `^2.2.0`, so an
//      unrelated `npm install` cannot move us onto a version where the field
//      is gone.
//   2. The constructor asserts the field exists, so a future bump fails loudly
//      at the first EventQueue rather than silently scanning nothing — which is
//      what an `undefined.length` would otherwise quietly become under `?.`.
//
// The alternatives were both worse: `toArray()` is the copy we are removing,
// `iterator()` is documented as `return this.toArray()`, and iterating the Heap
// with `for...of` DRAINS it (its Symbol.iterator yields `this.pop()`).
// =============================================================================

class EventQueue {
    constructor() {
        this.minHeap = new Heap((a, b) => a.time - b.time);

        if (!Array.isArray(this.minHeap.heapArray)) {
            throw new Error(
                "heap-js no longer exposes `heapArray`; EventQueue's in-place scans " +
                    "(containsEventOfType, getMatching, clearMatching, ...) depend on it. " +
                    "Pin heap-js back to 2.7.1, or port these methods to the new API."
            );
        }
    }

    addEvent(event) {
        this.minHeap.push(event);
    }

    getNextEvent() {
        return this.minHeap.pop();
    }

    containsEventOfType(type) {
        let events = this.minHeap.heapArray;
        let typeId = eventTypeId(type);

        for (let i = 0; i < events.length; i++) {
            if (events[i].typeId === typeId) {
                return true;
            }
        }
        return false;
    }

    containsEventOfTypeAndHrid(type, hrid) {
        let events = this.minHeap.heapArray;
        let typeId = eventTypeId(type);

        for (let i = 0; i < events.length; i++) {
            if (events[i].typeId === typeId && events[i].hrid == hrid) {
                return true;
            }
        }
        return false;
    }

    clear() {
        this.minHeap = new Heap((a, b) => a.time - b.time);
    }

    // =========================================================================
    // MWIX adaptation (performance): the specialised, closure-free scans.
    //
    // Every method below used to build a closure and call it once per heap
    // entry, and a simulated hour visits 2 305 965 entries. The queue family
    // held ~8.3% of self time on dungeon-den-600 in a CPU profile of the
    // candle. These do the same walk with the test INLINE and the type compared
    // as an integer (see events/eventTypeIds.js).
    //
    // Two things are deliberately preserved verbatim from the closures they
    // replace, because both are observable:
    //
    //   * The unit comparisons stay `==`, not `===`. Callers pass
    //     `event.target`, which can be null or undefined, and `null == undefined`
    //     is TRUE where `null === undefined` is false. Tightening it would
    //     silently stop clearing some events.
    //   * Matches are COLLECTED first and removed second, in heapArray order.
    //     `remove()` re-heapifies in place, so removing mid-walk would skip
    //     entries, and the removal order is what fixes the resulting heap
    //     permutation — and thus the tie-break order among equal-`time` events.
    //
    // The generic clearMatching(fn) / getMatching(fn) remain for the cold
    // callers that need an arbitrary predicate.
    // =========================================================================
    clearEventsForUnit(unit) {
        let events = this.minHeap.heapArray;

        let matches = null;
        for (let i = 0; i < events.length; i++) {
            let event = events[i];
            if (event.source == unit || event.target == unit) {
                if (matches === null) {
                    matches = [];
                }
                matches.push(event);
            }
        }
        return this._removeCollected(matches);
    }

    clearEventsOfType(type) {
        let events = this.minHeap.heapArray;
        let typeId = eventTypeId(type);

        let matches = null;
        for (let i = 0; i < events.length; i++) {
            if (events[i].typeId === typeId) {
                if (matches === null) {
                    matches = [];
                }
                matches.push(events[i]);
            }
        }
        return this._removeCollected(matches);
    }

    /** The (type, source) pair the buff-refresh paths ask for. */
    getMatchingTypeAndSource(type, source) {
        let events = this.minHeap.heapArray;
        let typeId = eventTypeId(type);

        for (let i = 0; i < events.length; i++) {
            if (events[i].typeId === typeId && events[i].source == source) {
                return events[i];
            }
        }
        return null;
    }

    clearMatchingTypeAndSource(type, source) {
        let events = this.minHeap.heapArray;
        let typeId = eventTypeId(type);

        let matches = null;
        for (let i = 0; i < events.length; i++) {
            if (events[i].typeId === typeId && events[i].source == source) {
                if (matches === null) {
                    matches = [];
                }
                matches.push(events[i]);
            }
        }
        return this._removeCollected(matches);
    }

    /** "Is this unit mid-action?" — either of two types, same source. */
    getMatchingEitherTypeAndSource(typeA, typeB, source) {
        let events = this.minHeap.heapArray;
        let typeIdA = eventTypeId(typeA);
        let typeIdB = eventTypeId(typeB);

        for (let i = 0; i < events.length; i++) {
            let event = events[i];
            if ((event.typeId === typeIdA || event.typeId === typeIdB) && event.source == source) {
                return event;
            }
        }
        return null;
    }

    _removeCollected(matches) {
        if (matches === null) {
            return false;
        }
        for (let i = 0; i < matches.length; i++) {
            this.minHeap.remove(matches[i]);
        }
        return true;
    }

    clearMatching(fn) {
        let events = this.minHeap.heapArray;

        // Collect FIRST, remove second. `remove()` re-heapifies in place, so
        // removing while walking `heapArray` would skip entries — the copy
        // upstream made is what protected it, and this is what replaces that
        // protection. `matches` stays null until there is something to remove,
        // which is the common case and keeps the scan allocation-free.
        let matches = null;
        for (let i = 0; i < events.length; i++) {
            if (fn(events[i])) {
                if (matches === null) {
                    matches = [];
                }
                matches.push(events[i]);
            }
        }

        return this._removeCollected(matches);
    }

    getMatching(fn) {
        let events = this.minHeap.heapArray;

        for (let i = 0; i < events.length; i++) {
            if (fn(events[i])) {
                return events[i];
            }
        }

        return null;
    }
}

export default EventQueue;
