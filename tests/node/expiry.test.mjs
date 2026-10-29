// Temporary ("lasts") changes running out: the party inside goes back the way it came, dependent changes are skipped with a
// "can't apply" note, merges/renames/doors revert, and rewinding before the expiry restores everything exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { clockAt, sumTravel } from '../../plugin/ui/calendar.mjs';

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
    assert.match(s.failed[0].inactive, /^Inactive: depends on Pop-up Stall, which expired at .+ \(lasted 1h, from message #2\)$/, s.failed[0].inactive);
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

test('inactive notes: a chain says which message it depends on; a turned-off cause says so; the expired change itself is listed', () => {
    const ch = [stall(),
        patch('cellar', 4, 600, [{ op: 'create_place', area: 'riverton:streets', id: 'stall_cellar', name: 'Stall Cellar', description: 'Damp.', exits: [{ direction: 'down', to: BOOTH, return_direction: 'up' }] }]),
        patch('crate', 7, 800, [{ op: 'set_description', loc: CELLAR2, text: 'Crates everywhere.' }])];
    const s = status(ch, H);
    assert.deepEqual(s.failed.map(f => [f.msg, f.inactive]), [[4, s.failed[0].inactive], [7, 'Inactive: depends on message #4']]);
    assert.match(s.failed[0].inactive, /depends on Pop-up Stall, which expired at/);
    // Turned off (no clock): the dependents name it.
    const off = [{ ...stall(), off: true }, ...ch.slice(1)];
    assert.deepEqual(status(off, null).failed.map(f => f.inactive), ['Inactive: depends on message #2, which is turned off', 'Inactive: depends on message #4']);
    // A change that fails on its own keeps its raw error, no inactive note.
    const own = [patch('bad', 3, 0, [{ op: 'set_description', loc: 'riverton:streets/nowhere', text: 'x' }])];
    const sf = status(own, null).failed;
    assert.equal(sf.length, 1); assert.equal(sf[0].inactive, undefined);
    // The Changes list: the expired change is a greyed "Inactive: ... expired" entry, the dependents too.
    const list = c.post('/inspect', { json: { target: 'changes', changes: ch, now: H } }).json().changes;
    const byMsg = m => list.find(x => x.msg === m);
    assert.match(byMsg(2).inactive, /^Inactive: Pop-up Stall expired at .+ \(lasted 1h, from message #2\)$/);
    assert.equal(byMsg(7).inactive, 'Inactive: depends on message #4');
});

test('change text: a note that repeats a summary line is shown once', async () => {
    const { changeText } = await import('../../plugin/ui/patches.mjs');
    const t = changeText({ note: 'new exit to Courtyard (back: Broken Window)', summary: ['Stable window: new exit to Courtyard (back: Broken Window)', 'Stable window: new exit to Courtyard (back: Broken Window)'] });
    assert.equal(t, ': Stable window: new exit to Courtyard (back: Broken Window)');
    assert.equal(changeText({ note: 'fire', summary: ['Square: description changed'] }), ' · fire: Square: description changed');
});

test('expiry: /resolve tells the narrated exit what ran out (room, its change, how it ended) and where they can go, the way in first', () => {
    const ch = [stall()];
    const r = resolve(BOOTH, ch, H, [LANE]);
    assert.equal(r.expired_room.name.includes('Pop-up Stall'), true, r.expired_room.name);
    assert.equal(r.expired_room.description, 'Canvas and crates.');
    assert.equal(r.expired_room.change.msg, 2);
    assert.ok(r.expired_room.change.summary.length > 0);
    assert.match(r.expired_room.change.ended, /Pop-up Stall expired at .+ \(lasted 1h, from message #2\)/);
    assert.deepEqual(r.options.map(o => o.address), [LANE, SQUARE]);
    assert.deepEqual(r.options.map(o => o.direction), ['lane', 'stall']);
});

test('aftermath: a one-time line when the room the narrator last saw is gone or lost exits without narration', () => {
    const ch = [stall()];
    const am = body => c.post('/aftermath', { json: body }).json();
    // Narrated in the stall at 0; now the stall expired and the party was moved to the lane.
    const gone = am({ then: { changes: ch, now: 0, address: BOOTH }, changes: ch, now: H, address: LANE });
    assert.match(gone.note, /^Pop-up Stall.* is gone \(a temporary change ended\); the party is now in Market Lane/);
    assert.match(gone.note, /Anything only in Pop-up Stall.*such as the .*no longer exists/);
    // In the square: the stall's exit from the square is gone (expiry) — a lost-exit line.
    const lost = am({ then: { changes: ch, now: 0, address: SQUARE }, changes: ch, now: H, address: SQUARE });
    assert.match(lost.note, /\(a temporary change ended\): the square in Village Square.*no longer exists/);
    // Turned off instead: says so.
    const off = am({ then: { changes: ch, now: 0, address: SQUARE }, changes: [{ ...ch[0], off: true }], now: 0, address: SQUARE });
    assert.match(off.note, /turned off or undone/);
    // Nothing changed (or already narrated): no line.
    assert.equal(am({ then: { changes: ch, now: H, address: LANE }, changes: ch, now: H, address: LANE }).note, '');
    assert.equal(am({ then: { changes: ch, now: 0, address: SQUARE }, changes: ch, now: 10, address: SQUARE }).note, '');
});

test('a pending wait card does not cross an expiry until kept; Adjust rechecks; Discard never triggers it', () => {
    const ch = [stall()];
    const card = s => ({ mes: 'They rest.', extra: { worldscrawl_waitcard: { seconds: s } } });
    const kept = s => ({ mes: 'They rest.', extra: { worldscrawl_wait: { seconds: s } } });
    const at = chat => clockAt(chat, chat.length - 1);
    const expiredAt = chat => !!resolve(BOOTH, ch, at(chat), [LANE]).expired;
    const start = [{ mes: 'hi', extra: {} }];
    assert.equal(expiredAt([...start, card(2 * H)]), false, 'pending card: no expiry yet');
    assert.equal(expiredAt([...start, kept(2 * H)]), true, 'kept: the expiry happens');
    assert.equal(expiredAt([...start, kept(10 * 60)]), false, 'adjusted down to 10 minutes: not crossed');
    assert.equal(expiredAt([...start, { mes: 'They rest.', extra: {} }]), false, 'discarded: never');
});
test('clockAt: the game time at any message, from one memo that follows edits', () => {
    const chat = [{ extra: {} }, { extra: { worldscrawl_move: { seconds: 60 } } }, { extra: { worldscrawl_wait: { seconds: 600 } } }, { extra: { worldscrawl_waitcard: { seconds: 9999 } } }, { extra: { worldscrawl_move: { seconds: 30 } } }];
    assert.deepEqual(chat.map((_, i) => clockAt(chat, i)), [0, 60, 660, 660, 690]);
    assert.equal(sumTravel(chat), 690);
    chat[2].extra.worldscrawl_wait.seconds = 1200; // Adjust after the fact
    assert.equal(clockAt(chat, 4), 1290);
    chat.splice(1, 1); // deleted message
    assert.equal(clockAt(chat, 3), 1230);
    assert.equal(clockAt(chat, 3, 1), 30, 'counts only after a rebase point');
    assert.equal(clockAt(chat, 99), 1230);
});
