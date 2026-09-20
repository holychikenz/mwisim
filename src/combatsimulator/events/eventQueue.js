import Heap from "heap-js";

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

        for (let i = 0; i < events.length; i++) {
            if (events[i].type == type) {
                return true;
            }
        }
        return false;
    }

    containsEventOfTypeAndHrid(type, hrid) {
        let events = this.minHeap.heapArray;

        for (let i = 0; i < events.length; i++) {
            if (events[i].type == type && events[i].hrid == hrid) {
                return true;
            }
        }
        return false;
    }

    clear() {
        this.minHeap = new Heap((a, b) => a.time - b.time);
    }

    clearEventsForUnit(unit) {
        this.clearMatching((event) => event.source == unit || event.target == unit);
    }

    clearEventsOfType(type) {
        this.clearMatching((event) => event.type == type);
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

        if (matches === null) {
            return false;
        }
        for (let i = 0; i < matches.length; i++) {
            this.minHeap.remove(matches[i]);
        }
        return true;
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
