// =============================================================================
// EventQueue._removeFromHeap against heap-js's Heap.remove.
// Run: cd api && node --import ./register-loader.js --test tests/heapRemove.test.mjs
//
// `_removeCollected` used to call `this.minHeap.remove(event)`. heap-js 2.7.1
// answers that with a pruned BFS over `queue.shift()`, allocating a children
// array, a filter closure, an `__read` and a `__spreadArray` per visited node —
// all to re-find an object the queue is already holding. The replacement finds
// the index with a linear identity scan and then performs the SAME mutation.
//
// WHAT HAS TO BE PROVED IS NOT "the right event was removed". It is that the
// resulting heapArray is the SAME ARRAY, element for element, because the
// permutation is what decides the order in which equal-`time` events come out
// of the queue — todo.md §3 records a single-compaction variant that passed
// every "is it a valid heap" check and still failed the parity gate, with
// ability casts landing in a different sequence.
//
// So every assertion below compares two heaps that were built identically and
// then had the same element removed by the two different routes, and it
// compares them by position, not as sets.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
const EventQueue = (await import('../../src/combatsimulator/events/eventQueue.js')).default;

// The Heap class the ENGINE resolved, taken off a live queue. Importing
// 'heap-js' here would take a second resolution path — the loader only rewrites
// bare specifiers for files under /src/combatsimulator/ — and the reference arm
// must be the same class the engine uses, or this compares nothing.
const Heap = new EventQueue().minHeap.constructor;

const COMPARE = (a, b) => a.time - b.time;

// A seeded LCG, so a failure is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Events carry a `time` (what the comparator reads) and an `id` (so a mismatch
// names the element). MANY DUPLICATE TIMES on purpose: equal keys are exactly
// where two removal routes are free to disagree about the permutation.
function makeEvents(rand, n, distinctTimes) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    time: Math.floor(rand() * distinctTimes),
    // the fields EventQueue's counter touches, so _trackRemoved is a no-op
    typeId: -1,
    source: null,
    target: null,
  }));
}

function heapOf(events) {
  const h = new Heap(COMPARE);
  for (const e of events) h.push(e);
  return h;
}

function queueOf(events) {
  const q = new EventQueue();
  for (const e of events) q.minHeap.push(e);
  return q;
}

function assertSameArray(got, want, where) {
  assert.equal(got.length, want.length, `${where}: length`);
  for (let i = 0; i < want.length; i++) {
    assert.equal(got[i], want[i], `${where}: heapArray[${i}] (ids ${got[i]?.id} vs ${want[i]?.id})`);
  }
}

// --------------------------------------------------------------------------
// 1. The differential case: 4 000 removals from randomised heaps, each one
//    performed both ways, the whole backing array compared after every one.
// --------------------------------------------------------------------------
test('_removeFromHeap leaves the identical heapArray Heap.remove leaves, over 4 000 removals', () => {
  const rand = lcg(20260921);
  let removals = 0;
  let removedRoot = 0, removedLast = 0, removedMiddle = 0;

  for (let trial = 0; trial < 400; trial++) {
    const n = 1 + Math.floor(rand() * 40);
    // Heavily duplicated times half the time, distinct times the other half.
    const distinct = rand() < 0.5 ? 3 : 1000;
    const events = makeEvents(rand, n, distinct);

    for (let k = 0; k < 10; k++) {
      const ref = heapOf(events);
      const q = queueOf(events);
      assertSameArray(q.minHeap.heapArray, ref.heapArray, `trial ${trial}: construction`);

      const victim = events[Math.floor(rand() * events.length)];
      const idx = ref.heapArray.indexOf(victim);
      if (idx === 0) removedRoot++;
      else if (idx === ref.heapArray.length - 1) removedLast++;
      else removedMiddle++;

      const refOk = ref.remove(victim);
      const gotOk = q._removeFromHeap(victim);
      assert.equal(gotOk, refOk, `trial ${trial}/${k}: return value`);
      assertSameArray(q.minHeap.heapArray, ref.heapArray, `trial ${trial}/${k}`);
      removals++;
    }
  }

  assert.equal(removals, 4000);
  // All three arms of the mutation must actually have been exercised, or the
  // test passes without touching the branch that matters.
  assert.ok(removedRoot > 0, 'the idx === 0 arm was never taken');
  assert.ok(removedLast > 0, 'the last-element arm was never taken');
  assert.ok(removedMiddle > 0, 'the splice + re-sort arm was never taken');
});

// --------------------------------------------------------------------------
// 2. Successive removals, which is what clearMatching actually does. The
//    permutation compounds, so N removals is the real test, not one.
// --------------------------------------------------------------------------
test('N successive removals produce the identical array either way', () => {
  const rand = lcg(31337);

  for (let trial = 0; trial < 200; trial++) {
    const events = makeEvents(rand, 30, rand() < 0.5 ? 4 : 1000);
    const ref = heapOf(events);
    const q = queueOf(events);

    const order = events.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const victim of order) {
      assert.equal(q._removeFromHeap(victim), ref.remove(victim), `trial ${trial}: return`);
      assertSameArray(q.minHeap.heapArray, ref.heapArray, `trial ${trial}`);
    }
    assert.equal(q.minHeap.heapArray.length, 0);
  }
});

// --------------------------------------------------------------------------
// 3. The pop ORDER, stated directly: what the engine observes is the sequence
//    the queue hands back, and among equal times that sequence is a pure
//    consequence of the permutation above.
// --------------------------------------------------------------------------
test('the drain order after a removal is identical', () => {
  const rand = lcg(999);

  for (let trial = 0; trial < 200; trial++) {
    const events = makeEvents(rand, 25, 3);
    const ref = heapOf(events);
    const q = queueOf(events);
    const victim = events[Math.floor(rand() * events.length)];
    ref.remove(victim);
    q._removeFromHeap(victim);

    const a = [], b = [];
    while (ref.heapArray.length) a.push(ref.pop().id);
    while (q.minHeap.heapArray.length) b.push(q.minHeap.pop().id);
    assert.deepEqual(b, a, `trial ${trial}: drain order`);
  }
});

// --------------------------------------------------------------------------
// 4. The edges.
// --------------------------------------------------------------------------
test('an absent object and an empty heap both return false, as upstream did', () => {
  const q = new EventQueue();
  assert.equal(q._removeFromHeap({ time: 1 }), false, 'empty heap');

  const events = makeEvents(lcg(1), 10, 5);
  for (const e of events) q.minHeap.push(e);
  const ref = heapOf(events);
  const stranger = { id: -1, time: 2 };
  assert.equal(q._removeFromHeap(stranger), ref.remove(stranger));
  assertSameArray(q.minHeap.heapArray, ref.heapArray, 'absent object leaves the heap alone');
});

test('a single-element heap empties the same way', () => {
  const only = { id: 0, time: 5, typeId: -1, source: null, target: null };
  const ref = heapOf([only]);
  const q = queueOf([only]);
  assert.equal(q._removeFromHeap(only), ref.remove(only));
  assertSameArray(q.minHeap.heapArray, ref.heapArray, 'single element');
});

// --------------------------------------------------------------------------
// 5. The dependency assertion. Both fields _removeFromHeap reaches into are
//    undocumented, so the constructor is the thing that makes a bump loud.
// --------------------------------------------------------------------------
test('the constructor refuses a heap-js without the internals _removeFromHeap uses', () => {
  const q = new EventQueue();
  for (const field of ['_sortNodeUp', '_sortNodeDown']) {
    assert.equal(typeof q.minHeap[field], 'function', `heap-js still exposes ${field}`);
  }
  assert.ok(Array.isArray(q.minHeap.heapArray), 'heap-js still exposes heapArray');

  const saved = Heap.prototype._sortNodeUp;
  try {
    delete Heap.prototype._sortNodeUp;
    assert.throws(() => new EventQueue(), /_sortNodeUp/);
  } finally {
    Heap.prototype._sortNodeUp = saved;
  }
  assert.doesNotThrow(() => new EventQueue(), 'restored');
});
