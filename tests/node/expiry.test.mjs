// Temporary ("lasts") changes running out: the party inside goes back the way it came, dependent changes are skipped with a
// "can't apply" note, merges/renames/doors revert, and rewinding before the expiry restores everything exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';

const c = client(RIVERTON);
const LANE = 'riverton:streets/market_lane', STABLE = 'riverton:drowned_rat/stable', KITCHEN = 'riverton:drowned_rat/kitchens';
const BOOTH = 'riverton:streets/stall', CELLAR2 = 'riverton:streets/stall_cellar';
const H = 3600;
const patch = (id, _msg, at, ops) => ({ type: 'patch', id, note: id, at, _msg, ops });
// A pop-up stall between the square and the lane, lasting 1 hour.
const stall = () => patch('stall', 2, 0, [{ op: 'create_place', area: 'riverton:streets', id: 'stall', name: 'Pop-up Stall', description: 'Canvas and crates.', lasts: '1h',
    exits: [{ direction: 'stall', to: SQUARE, return_direction: 'square' }, { direction: 'lane', to: LANE, return_direction: 'stall' }] }]);
const rooms = (changes, a, now) => c.post('/rooms', { json: { addresses: [a], changes, now } }).json();
const status = (changes, now) => c.post('/changes/status', { json: { changes, now } }).json();
const resolve = (address, changes, now, history = []) => c.post('/resolve', { json: { address, changes, now, history } }).json();
const map = (changes, now) => c.post('/patches/list', { json: { changes, now } }).json();

test('expiry: standing in a room that expires sends the party back out the way it came in, flagged as expired', () => {
    const ch = [stall()];
    assert.equal(rooms(ch, BOOTH, H - 1).rooms.length, 1);
    assert.deepEqual(rooms(ch, BOOTH, H).unknown, [BOOTH]);
    // Came in from the lane: back out to the lane, not the first exit (the square).
    const r = resolve(BOOTH, ch, H, [LANE, TAVERN]);
    assert.equal(r.address, LANE, JSON.stringify(r)); assert.equal(r.expired, true); assert.equal(r.how, 'came_from');
    assert.equal(r.via, 'lane');
    const r2 = resolve(BOOTH, ch, H, [SQUARE]);
    assert.equal(r2.address, SQUARE); assert.equal(r2.via, 'stall'); // the stall's own exit name for the way to the square
    // No history: still a surviving neighbour, still flagged.
    const r3 = resolve(BOOTH, ch, H);
    assert.ok([SQUARE, LANE].includes(r3.address)); assert.equal(r3.expired, true);
    // Before the expiry: still here, not flagged.
    const r4 = resolve(BOOTH, ch, H - 1, [LANE]);
    assert.equal(r4.address, BOOTH); assert.ok(!r4.expired);
});

test('expiry: later changes built on an expired room are skipped with a "can\'t apply" note, then come back on rewind', () => {
    const ch = [stall(),
        patch('cellar', 4, 600, [{ op: 'create_place', area: 'riverton:streets', id: 'stall_cellar', name: 'Stall Cellar', description: 'Damp.', exits: [{ direction: 'down', to: BOOTH, return_direction: 'up' }] }]),
        patch('square', 6, 700, [{ op: 'set_description', loc: SQUARE, text: 'Busy square.' }])];
    assert.equal(status(ch, H - 1).failed?.length ?? 0, 0);
    const s = status(ch, H);
    assert.deepEqual(s.failed.map(f => f.msg), [4]);
    assert.equal(s.failed[0].expired_dependency, true);
    assert.match(s.failed[0].error, /temporary change .*ran out/);
    // The cellar (permanent, but hung off the stall) drops out cleanly: no room, no dangling exit anywhere.
    assert.deepEqual(rooms(ch, CELLAR2, H).unknown, [CELLAR2]);
    const sq = rooms(ch, SQUARE, H).rooms[0];
    assert.equal(sq.description, 'Busy square.');
    assert.ok(!sq.exits.some(e => e.to === BOOTH || e.to === CELLAR2), JSON.stringify(sq.exits));
    assert.ok(!rooms(ch, LANE, H).rooms[0].exits.some(e => e.to === BOOTH));
    // Rewind (clock before the expiry): exactly as it was.
    assert.equal(rooms(ch, CELLAR2, H - 1).rooms.length, 1);
    assert.ok(rooms(ch, BOOTH, H - 1).rooms[0].exits.some(e => e.to === CELLAR2));
});

test('expiry: a temporary merge and a rename of the merged room revert; the pieces get their own names and exits back', () => {
    const MERGED = 'riverton:drowned_rat/burnt_inn';
    const base = { tavern: rooms([], TAVERN).rooms[0], yard: rooms([], YARD).rooms[0] };
    const ch = [patch('merge', 2, 0, [{ op: 'merge', locs: [TAVERN, YARD], id: 'burnt_inn', name: 'Burnt Inn', description: 'Ash.', lasts: '1h' }]),
        patch('rename', 3, 60, [{ op: 'set_name', loc: MERGED, text: 'The Cinders' }]),
        patch('renameTemp', 4, 60, [{ op: 'set_name', loc: SQUARE, text: 'Fair Square', lasts: '30m' }])];
    assert.equal(rooms(ch, MERGED, 100).rooms[0].name, 'The Cinders');
    assert.equal(rooms(ch, SQUARE, 100).rooms[0].name, 'Fair Square');
    assert.equal(rooms(ch, SQUARE, 60 + 1800).rooms[0].name, rooms([], SQUARE).rooms[0].name);
    const after = H;
    assert.deepEqual(rooms(ch, MERGED, after).unknown, [MERGED]);
    assert.deepEqual(rooms(ch, TAVERN, after).rooms[0], base.tavern);
    assert.deepEqual(rooms(ch, YARD, after).rooms[0], base.yard);
    assert.deepEqual(status(ch, after).failed.map(f => f.msg), [3]);
    // Standing in the merged room when it splits: back to one of its pieces.
    const r = resolve(MERGED, ch, after, [YARD]);
    assert.equal(r.address, YARD, JSON.stringify(r)); assert.equal(r.expired, true);
});

test('expiry: temporary door states revert to the door the map had', () => {
    const doorOf = (changes, now) => rooms(changes, YARD, now).rooms[0].exits.find(e => e.direction === 'kitchen');
    const plain = doorOf([], null);
    const ch = [patch('bar', 2, 0, [{ op: 'set_exit', loc: YARD, direction: 'kitchen', fields: { barrier: { openable: true, locked: true } }, lasts: '1h' }]),
        patch('block', 3, 0, [{ op: 'block_exit', loc: YARD, direction: 'stable', lasts: '2h' }]),
        patch('break', 4, 0, [{ op: 'break_exit', loc: KITCHEN, direction: 'out', lasts: '1h' }])];
    const lockedNow = doorOf(ch.slice(0, 1), 10);
    assert.equal(lockedNow.barrier.locked, true);
    assert.equal(doorOf(ch, 10).barrier, undefined, 'broken open from the other side while both last');
    const during = doorOf(ch, 10);
    assert.deepEqual(doorOf(ch, H), plain);
    assert.deepEqual(doorOf(ch.slice(0, 1), H), plain, 'the lock runs out: back to the plain door');
    const stable = now => rooms(ch, YARD, now).rooms[0].exits.find(e => e.direction === 'stable');
    assert.ok(stable(H).blocked || stable(H).barrier, JSON.stringify(stable(H)));
    assert.deepEqual(stable(2 * H), rooms([], YARD).rooms[0].exits.find(e => e.direction === 'stable'));
    assert.deepEqual(rooms(ch, KITCHEN, H).rooms[0], rooms([], KITCHEN).rooms[0]);
    assert.equal(status(ch, 2 * H).failed?.length ?? 0, 0);
    // A temporary bar on the door runs out: no bar left on either side.
    const barred = [patch('barT', 5, 0, [{ op: 'set_exit', loc: YARD, direction: 'kitchen', fields: { barrier: { ...plain.barrier, barred_from: 'this_side' } }, lasts: '1h' }])];
    assert.equal(doorOf(barred, 10).barrier.barred_from, 'this_side');
    assert.equal(rooms(barred, KITCHEN, 10).rooms[0].exits.find(e => e.direction === 'out').barrier.barred_from, 'other_side');
    assert.deepEqual(doorOf(barred, H), plain);
    assert.deepEqual(rooms(barred, KITCHEN, H).rooms[0], rooms([], KITCHEN).rooms[0]);
    // Rewind: the barred door is back.
    assert.deepEqual(doorOf(ch, 10), during);
    assert.deepEqual(doorOf(ch.slice(0, 1), 10), lockedNow);
});

test('expiry: rewinding (an earlier clock, or deleting the message) restores the whole map exactly', () => {
    const ch = [stall(), patch('cellar', 4, 600, [{ op: 'create_place', area: 'riverton:streets', id: 'stall_cellar', name: 'Stall Cellar', description: 'Damp.', exits: [{ direction: 'down', to: BOOTH, return_direction: 'up' }] }])];
    const before = c.post('/inspect/index', { json: { changes: ch, now: H - 1 } }).json();
    c.post('/inspect/index', { json: { changes: ch, now: H } });
    assert.deepEqual(c.post('/inspect/index', { json: { changes: ch, now: H - 1 } }).json(), before);
    assert.deepEqual(c.post('/inspect/index', { json: { changes: ch.slice(0, 1), now: 10 } }).json(), c.post('/inspect/index', { json: { changes: [stall()], now: 10 } }).json());
});
