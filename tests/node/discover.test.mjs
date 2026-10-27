import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN } from './helpers.mjs';
import { applyPatch, PatchError } from '../../plugin/ui/patches.mjs';
import { read_world_raw } from '../../plugin/world.mjs';

const c = client(RIVERTON);
const UP = 'riverton:drowned_rat/upstairs', ROOM = 'riverton:drowned_rat/guest_room';
const op = (extra = {}) => ({ op: 'discover', loc: UP, direction: 'guest room door', return_direction: 'hallway', name: 'Guest Room',
    description: 'A narrow bed and a washstand under a sloping ceiling.', ...extra });
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'd1', note: 'discovery', at: 0, ops, ...extra });
const rooms = (a, changes) => c.post('/rooms', { json: { addresses: [a], changes } }).json();

test('discover: preview makes the id from the name and adds one door pair, nothing else', () => {
    const r = c.post('/patch/preview', { json: { patch: { ops: [op()] } } }).json();
    assert.equal(r.ops[0].id, 'guest_room');
    assert.deepEqual(r.touched, [UP, ROOM]);
    assert.equal(r.before[ROOM], null);
    assert.equal(r.after[ROOM].name, 'Guest Room');
    assert.equal(r.after[UP].description, r.before[UP].description, 'the hallway description is untouched');
    assert.deepEqual(r.after[UP].exits.at(-1).barrier, {});
    assert.equal(r.after[ROOM].exits[0].to, UP);
});

test('discover: a second room with the same name gets a fresh id; stamped id is kept on replay', () => {
    const first = patch([{ ...op(), id: 'guest_room' }]);
    const r = c.post('/patch/preview', { json: { patch: { ops: [op({ direction: 'second door' })] }, changes: [first] } }).json();
    assert.equal(r.ops[0].id, 'guest_room_2');
    const got = rooms(ROOM, [first]).rooms[0];
    assert.equal(got.name, 'Guest Room');
});

test('discover: the new room is a real room with a door both ways', () => {
    const ch = [patch([{ ...op(), id: 'guest_room' }])];
    const there = c.post('/move', { json: { from: UP, direction: 'guest room door', changes: ch } }).json();
    assert.equal(there.address, ROOM);
    assert.equal(c.post('/move', { json: { from: ROOM, direction: 'hallway', changes: ch } }).json().address, UP);
});

test('discover: refused on expandable:false rooms, duplicate directions and empty text', () => {
    const [, raw] = read_world_raw(RIVERTON);
    const r0 = structuredClone(raw);
    r0.riverton.subregions.drowned_rat.locations.upstairs.expandable = false;
    assert.throws(() => applyPatch(r0, { ops: [op()] }), /expandable/);
    assert.throws(() => applyPatch(structuredClone(raw), { ops: [op({ direction: 'down' })] }), /already has an exit/);
    assert.throws(() => applyPatch(structuredClone(raw), { ops: [op({ description: '' })] }), PatchError);
    const bad = c.post('/patch/preview', { json: { patch: { ops: [op({ direction: 'down' })] } } });
    assert.equal(bad.status_code, 400);
});

test('discover: context gives the room, neighbors and area notes', () => {
    const r = c.post('/discover/context', { json: { location: UP } }).json();
    assert.equal(r.name, 'Upstairs Rooms');
    assert.equal(r.expandable, true);
    assert.ok(r.neighbors.some(n => n.address === TAVERN));
    assert.equal(typeof r.area_notes, 'string'); assert.equal(typeof r.region_notes, 'string');
});

test('discover: turning it off removes the room, its dependents fail, the party is moved to the hallway', () => {
    const ch = [patch([{ ...op(), id: 'guest_room' }], { _msg: 3 }), { type: 'patch', id: 'd2', note: 'x', at: 0, _msg: 5, ops: [{ op: 'set_description', loc: ROOM, text: 'Messy.' }] }];
    const dep = c.post('/changes/dependents', { json: { changes: ch, index: 0 } }).json();
    assert.deepEqual(dep.hard.map(h => h.msg), [5]);
    ch[0].off = true;
    assert.deepEqual(rooms(ROOM, ch).unknown, [ROOM]);
    const r = c.post('/resolve', { json: { address: ROOM, changes: ch, history: [UP, TAVERN] } }).json();
    assert.equal(r.address, UP, JSON.stringify(r));
    const r2 = c.post('/resolve', { json: { address: ROOM, changes: ch } }).json();
    assert.equal(r2.address, UP, JSON.stringify(r2));
    delete ch[0].off;
    assert.equal(rooms(ROOM, ch).rooms[0].description, 'Messy.');
});
