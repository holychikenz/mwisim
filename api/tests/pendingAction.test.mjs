// =============================================================================
// The pending-action counter in EventQueue.
//
// addNextAttackEvent() asks "does this unit already have an action in flight?"
// and the engine now answers it from a counter instead of walking the heap.
// A counter is only equivalent to the walk while EVERY heap mutation maintains
// it, and the failure mode if one does not is not an error: it is a unit that
// silently stops attacking (count stuck above zero) or one that queues two
// actions at once (count stuck below). Neither throws. Both change combat
// numbers.
//
// So the central test here is DIFFERENTIAL: drive a long random sequence of
// mutations and assert after every single one that the counter agrees with
// getMatchingEitherTypeAndSource(), the scanning form it replaced, which is
// kept in the class for exactly this purpose.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

const SRC = '../../src/combatsimulator/events/';
const { default: EventQueue } = await import(SRC + 'eventQueue.js');
const { default: AutoAttackEvent } = await import(SRC + 'autoAttackEvent.js');
const { default: AbilityCastEndEvent } = await import(SRC + 'abilityCastEndEvent.js');
const { default: CheckBuffExpirationEvent } = await import(SRC + 'checkBuffExpirationEvent.js');
const { default: CombatStartEvent } = await import(SRC + 'combatStartEvent.js');

// A unit stand-in. The queue only ever uses these by identity.
const unit = (hrid) => ({ hrid });

/** The scanning form, as the single source of truth for what "pending" means. */
const scanSaysPending = (q, u) =>
    q.getMatchingEitherTypeAndSource(AbilityCastEndEvent.type, AutoAttackEvent.type, u) !== null;

const agrees = (q, units, where) => {
    for (const u of units) {
        assert.strictEqual(
            q.hasPendingAction(u),
            scanSaysPending(q, u),
            `counter disagrees with the scan for ${u.hrid} ${where}`
        );
    }
};

test('an auto-attack makes its source pending until it is popped', () => {
    const q = new EventQueue();
    const a = unit('a');

    assert.strictEqual(q.hasPendingAction(a), false);
    q.addEvent(new AutoAttackEvent(10, a));
    assert.strictEqual(q.hasPendingAction(a), true);
    q.getNextEvent();
    assert.strictEqual(q.hasPendingAction(a), false);
});

test('an ability cast end counts too, and is cleared by clearEventsForUnit', () => {
    const q = new EventQueue();
    const a = unit('a');

    q.addEvent(new AbilityCastEndEvent(10, a, null));
    assert.strictEqual(q.hasPendingAction(a), true);
    q.clearEventsForUnit(a);
    assert.strictEqual(q.hasPendingAction(a), false);
});

test('pending is per unit, not global', () => {
    const q = new EventQueue();
    const a = unit('a');
    const b = unit('b');

    q.addEvent(new AutoAttackEvent(10, a));
    assert.strictEqual(q.hasPendingAction(a), true);
    assert.strictEqual(q.hasPendingAction(b), false);
});

test('two pending actions need two removals — a count, not a flag', () => {
    const q = new EventQueue();
    const a = unit('a');
    const first = new AutoAttackEvent(10, a);
    const second = new AbilityCastEndEvent(20, a, null);

    q.addEvent(first);
    q.addEvent(second);
    q.getNextEvent(); // pops `first`, the earlier of the two
    assert.strictEqual(
        q.hasPendingAction(a),
        true,
        'one action left in the queue, so the unit is still mid-action'
    );
    q.getNextEvent();
    assert.strictEqual(q.hasPendingAction(a), false);
});

test('non-action events never make a unit pending', () => {
    const q = new EventQueue();
    const a = unit('a');

    q.addEvent(new CheckBuffExpirationEvent(10, a));
    q.addEvent(new CombatStartEvent(20));
    assert.strictEqual(q.hasPendingAction(a), false);
    assert.strictEqual(scanSaysPending(q, a), false);
});

test('clear() resets every unit, not just the ones it was asked about', () => {
    const q = new EventQueue();
    const a = unit('a');
    const b = unit('b');

    q.addEvent(new AutoAttackEvent(10, a));
    q.addEvent(new AbilityCastEndEvent(20, b, null));
    q.clear();
    assert.strictEqual(q.hasPendingAction(a), false);
    assert.strictEqual(q.hasPendingAction(b), false);
});

test('clearEventsOfType decrements only the type it removed', () => {
    const q = new EventQueue();
    const a = unit('a');

    q.addEvent(new AutoAttackEvent(10, a));
    q.addEvent(new AbilityCastEndEvent(20, a, null));
    q.clearEventsOfType(AutoAttackEvent.type);
    assert.strictEqual(
        q.hasPendingAction(a),
        true,
        'the cast end is still pending after the auto-attack was cleared'
    );
    q.clearEventsOfType(AbilityCastEndEvent.type);
    assert.strictEqual(q.hasPendingAction(a), false);
});

test('an event queued for a unit it does not source does not count', () => {
    const q = new EventQueue();
    const a = unit('a');
    const b = unit('b');

    // clearEventsForUnit matches on source OR target, so a targeted event is
    // removable by `b` while only ever being an ACTION of `a`.
    const e = new AutoAttackEvent(10, a);
    e.target = b;
    q.addEvent(e);

    assert.strictEqual(q.hasPendingAction(a), true);
    assert.strictEqual(q.hasPendingAction(b), false);

    q.clearEventsForUnit(b); // removes it by target
    assert.strictEqual(
        q.hasPendingAction(a),
        false,
        'removal by TARGET must still decrement the SOURCE count'
    );
});

test('differential: the counter agrees with the scan after every mutation', () => {
    // Deterministic PRNG — a failure must be reproducible, and Math.random()
    // would make this test report a different sequence every run.
    let seed = 0x2f6e2b1;
    const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

    const units = [unit('u0'), unit('u1'), unit('u2'), unit('u3')];
    const q = new EventQueue();
    let t = 0;
    let live = [];

    for (let step = 0; step < 4000; step++) {
        const roll = rnd();
        const u = pick(units);

        if (roll < 0.45) {
            const kind = rnd();
            const e =
                kind < 0.35
                    ? new AutoAttackEvent((t += 1 + rnd() * 10), u)
                    : kind < 0.7
                      ? new AbilityCastEndEvent((t += 1 + rnd() * 10), u, null)
                      : new CheckBuffExpirationEvent((t += 1 + rnd() * 10), u);
            q.addEvent(e);
            live.push(e);
        } else if (roll < 0.7) {
            const popped = q.getNextEvent();
            if (popped !== undefined) {
                live = live.filter((e) => e !== popped);
            }
        } else if (roll < 0.8) {
            q.clearEventsForUnit(u);
            live = live.filter((e) => e.source !== u && e.target !== u);
        } else if (roll < 0.9) {
            const type = pick([AutoAttackEvent.type, AbilityCastEndEvent.type, CheckBuffExpirationEvent.type]);
            q.clearEventsOfType(type);
            live = live.filter((e) => e.type !== type);
        } else if (roll < 0.97) {
            q.clearMatchingTypeAndSource(AutoAttackEvent.type, u);
            live = live.filter((e) => !(e.type === AutoAttackEvent.type && e.source === u));
        } else {
            q.clear();
            live = [];
        }

        agrees(q, units, `at step ${step}`);
    }

    // The sequence must actually have exercised the thing, or a counter that
    // always returned false would pass. Assert it ended somewhere interesting.
    assert.ok(live.length > 0, 'the fuzz left the queue empty — it proved nothing');
    assert.ok(
        units.some((u) => q.hasPendingAction(u)),
        'the fuzz never left a unit mid-action — it proved nothing'
    );
});
