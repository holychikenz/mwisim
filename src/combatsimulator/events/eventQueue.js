import Heap from "heap-js";
import { eventTypeId } from "./eventTypeIds";
import AutoAttackEvent from "./autoAttackEvent";
import AbilityCastEndEvent from "./abilityCastEndEvent";

// The two event types that mean "this unit already has an action in flight".
// Interned once at module load; see the pending-action note on the class.
const ID_AUTO_ATTACK = eventTypeId(AutoAttackEvent.type);
const ID_ABILITY_CAST_END = eventTypeId(AbilityCastEndEvent.type);

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
        if (
            typeof this.minHeap._sortNodeUp !== "function" ||
            typeof this.minHeap._sortNodeDown !== "function"
        ) {
            throw new Error(
                "heap-js no longer exposes `_sortNodeUp`/`_sortNodeDown`; EventQueue's " +
                    "_removeFromHeap performs Heap.remove's re-heapify itself and the " +
                    "removal order fixes the tie-break order among equal-time events. " +
                    "Pin heap-js back to 2.7.1, or port _removeFromHeap to the new API."
            );
        }
    }

    // =========================================================================
    // MWIX adaptation (performance): "is this unit mid-action?" is answered
    // from a counter, not by walking the heap.
    //
    // addNextAttackEvent() opens by asking whether `source` already has an
    // AutoAttackEvent or an AbilityCastEndEvent pending, and upstream answers
    // it by scanning every entry in the queue. Measured on dungeon-den-600:
    // 10 249 calls per simulated hour over a heap averaging 111 entries —
    // 56.5% of ALL heap entries this queue touches, and 81.8% of them on
    // floor-solo. Worse, it is quadratic in party size: more units means both
    // more calls and a longer heap, and per-unit cost is precisely what this
    // engine is bad at relative to the reference (see todo.md §1).
    //
    // WHY A COUNTER IS EXACTLY EQUIVALENT, AND NOT MERELY USUALLY RIGHT.
    // The scan's answer is a pure function of the heap's contents, so a count
    // maintained on every mutation gives the same answer iff every mutation is
    // covered. The heap is mutated in exactly FOUR places and they are all in
    // this file: addEvent (push), getNextEvent (pop), clear (a fresh Heap),
    // and _removeCollected — which every cancellation path funnels through.
    // Everything else in this class only READS heapArray. If a fifth mutation
    // site is ever added and does not maintain the count, this silently starts
    // returning wrong answers, so: the count is maintained HERE, beside the
    // mutations, rather than at the call site that consumes it.
    //
    // WHERE THE COUNT LIVES, AND WHY NOT IN A MAP HERE.
    // It is a field on the unit. A Map keyed by unit was measured first and it
    // LOST on the cheap cases — floor-solo +9.3%, floor-party +6.9%, both in
    // every counterbalanced round — because a shallow heap (3.9 entries on
    // floor-solo) is cheaper to scan than two Map operations are to perform,
    // and the Map was touched on every add and every removal while the scan
    // only ran on the guard. A field read is cheaper than either. It also puts
    // the state where it belongs: "am I mid-action?" is a property of the unit.
    //
    // Two deliberate departures from the scan it replaces, both unobservable
    // on today's path and both recorded so the next reader need not re-derive
    // them:
    //
    //   * The scan compared `event.source == source` (loose), which would also
    //     match a null-sourced event when asked about `undefined`. The map is
    //     keyed by identity and null/undefined sources are never tracked at
    //     all. The only caller passes a live unit, so this cannot differ.
    //   * The scan returned the matching EVENT; this returns a boolean. The
    //     only caller tests it for truthiness and discards it.
    //
    // getMatchingEitherTypeAndSource() is kept below as the scanning form. It
    // is no longer on the hot path, and it is what the differential test
    // checks this counter against.
    // =========================================================================

    /** Is `source` mid-action — auto-attack or ability cast still pending? */
    hasPendingAction(source) {
        return source._pendingActionCount > 0;
    }

    _trackAdded(event) {
        if (event.typeId !== ID_AUTO_ATTACK && event.typeId !== ID_ABILITY_CAST_END) {
            return;
        }
        let source = event.source;
        if (source == null) {
            return;
        }
        let n = source._pendingActionCount;
        source._pendingActionCount = n === undefined ? 1 : n + 1;
    }

    _trackRemoved(event) {
        if (event.typeId !== ID_AUTO_ATTACK && event.typeId !== ID_ABILITY_CAST_END) {
            return;
        }
        let source = event.source;
        if (source == null) {
            return;
        }
        if (source._pendingActionCount > 0) {
            source._pendingActionCount--;
        }
    }

    addEvent(event) {
        this.minHeap.push(event);
        this._trackAdded(event);
    }

    getNextEvent() {
        let event = this.minHeap.pop();
        if (event !== undefined) {
            this._trackRemoved(event);
        }
        return event;
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
        // Decrement before dropping the heap. The counts live on the UNITS, and
        // the units outlive this queue's contents — a wipe that discards the
        // heap without settling them would leave a unit permanently "mid-action"
        // and it would never attack again.
        let events = this.minHeap.heapArray;
        for (let i = 0; i < events.length; i++) {
            this._trackRemoved(events[i]);
        }
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

    // =========================================================================
    // MWIX adaptation (performance): find the event by a linear scan, then
    // perform Heap.remove's mutation verbatim.
    //
    // heap-js 2.7.1's `remove` (dist/heap-js.es5.js:1946) re-FINDS an object the
    // queue is already holding, and it does so expensively: a pruned BFS driven
    // by `queue.shift()` — O(n) per shift on a JS array — allocating a children
    // array via `getChildrenIndexOf`, a filter closure, `__read(children)` and
    // `__spreadArray(...)` per visited node, then `push.apply`. Those ES5
    // downlevel helpers are unavoidable through the API: 2.7.1 ships only ES5
    // bundles (`main` is dist/heap-js.umd.js, `module` is dist/heap-js.es5.js).
    // In the profile `Heap.remove` was 5.7% of engine self time and `__read` /
    // `__spreadArray` a further 4.5%.
    //
    // WHY THE SCAN FINDS THE SAME INDEX. `_removeCollected` calls remove with NO
    // callbackFn, so heap-js uses `Heap.defaultIsEqual`, which is
    // `(a, b) => a === b` (heap-js.es5.js:1480) — identity, not deep equality.
    // Events are unique object instances, so exactly ONE index in heapArray
    // satisfies it. The pruning and the level order are therefore irrelevant:
    // any search that visits every entry finds the identical index the BFS
    // finds, and an absent object yields false either way.
    //
    // THE MUTATION IS BYTE-FOR-BYTE UPSTREAM'S, and that is not cosmetic. It is
    // what fixes the heap permutation and hence the tie-break order among
    // equal-`time` events; todo.md §3 records a single-compaction variant that
    // failed the parity gate precisely because "the array one compaction
    // produces is not the array N successive removals produce". Only the SEARCH
    // changed. `_sortNodeUp`/`_sortNodeDown` are asserted in the constructor
    // beside `heapArray`, so a dependency bump fails loudly at the first
    // EventQueue rather than producing wrong numbers.
    //
    // The `o === undefined -> pop()` arm of upstream's remove is deliberately
    // NOT reproduced: the only caller passes a collected event, never undefined.
    //
    // HONEST CAVEAT. A linear scan visits idx + 1 entries where the pruned BFS
    // visits some subset of [0..idx] plus siblings, so it can visit MORE nodes.
    // Each visit is a pointer compare against the BFS's shift, filter, closure,
    // spread and read; the candle, counterbalanced, is what decided it.
    // =========================================================================
    _removeFromHeap(event) {
        let heap = this.minHeap;
        let heapArray = heap.heapArray;
        let len = heapArray.length;
        if (len === 0) {
            return false;
        }

        let idx = -1;
        for (let i = 0; i < len; i++) {
            if (heapArray[i] === event) {
                idx = i;
                break;
            }
        }
        if (idx === -1) {
            return false;
        }

        if (idx === 0) {
            heap.pop();
        } else if (idx === len - 1) {
            heapArray.pop();
        } else {
            heapArray.splice(idx, 1, heapArray.pop());
            heap._sortNodeUp(idx);
            heap._sortNodeDown(idx);
        }
        return true;
    }

    _removeCollected(matches) {
        if (matches === null) {
            return false;
        }
        for (let i = 0; i < matches.length; i++) {
            // The match is by identity, so a true return means THIS object left
            // the heap — which is what makes the decrement exact.
            if (this._removeFromHeap(matches[i])) {
                this._trackRemoved(matches[i]);
            }
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
