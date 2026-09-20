// =============================================================================
// MWIX adaptation (performance): integer ids for combat-event types.
//
// The event queue's predicate scans walk the whole heap — one simulated hour of
// chimerical_den T0 / L600 / 5 geared players visits 2 305 965 entries — and
// every visit compared a STRING type. A CPU profile of the candle put the queue
// family at ~8.3% of self time on dungeon-den-600 (Heap.remove 2.65%,
// clearMatching 2.58%, getMatching 1.58%, heap-js's __read 1.51%). An integer
// compare is the cheapest possible test, and it lets the hot scans drop their
// per-entry closure call as well.
//
// Ids are interned on first sight rather than listed. There is deliberately no
// table to keep in sync: a hand-maintained list of the 19 event types is
// exactly the kind of thing that goes stale silently when someone adds the
// twentieth, and this codebase has been bitten by an incomplete derived list
// before. Interning cannot omit a type, because the id is minted by the type's
// own first use.
//
// The assignment ORDER therefore depends on module-load order — which is fixed
// by the import graph, but it does not matter either way: an id is only ever
// compared for equality with another id from this same registry, within one
// process. Nothing is persisted, serialised, or compared across runs. If that
// ever stops being true, this must become a sorted, generated table.
// =============================================================================

const ids = new Map();

export function eventTypeId(type) {
    let id = ids.get(type);
    if (id === undefined) {
        id = ids.size;
        ids.set(type, id);
    }
    return id;
}

/** Diagnostic only: how many distinct types have been interned so far. */
export function eventTypeCount() {
    return ids.size;
}
