import './useprompts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN } from './helpers.mjs';
import { applyPatch, PatchError, discoverToCreate } from '../../plugin/ui/patches.mjs';
import { read_world_raw } from '../../plugin/world.mjs';

const c = client(RIVERTON);
const UP = 'riverton:drowned_rat/upstairs', ROOM = 'riverton:drowned_rat/guest_room';
const op = (extra = {}) => discoverToCreate({ loc: UP, direction: 'guest room door', return_direction: 'hallway', name: 'Guest Room',
    description: 'A narrow bed and a washstand under a sloping ceiling.', ...extra });
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'd1', note: 'discovery', at: 0, ops, ...extra });
const rooms = (a, changes) => c.post('/rooms', { json: { addresses: [a], changes } }).json();

test('discover: preview makes the id from the name and adds one door pair, nothing else', () => {
    const r = c.post('/patch/preview', { json: { patch: { ops: [op()] } } }).json();
    assert.equal(r.ops[0].id, 'guest_room');
    assert.deepEqual([...r.touched].sort(), [ROOM, UP].sort());
    assert.equal(r.before[ROOM], null);
    assert.equal(r.after[ROOM].name, 'Guest Room');
    assert.equal(r.after[UP].description, r.before[UP].description, 'the hallway description is untouched');
    assert.equal(r.ops[0].op, 'create_place', 'a discovery is a normal create_place');
    assert.equal(r.ops[0].story, true);
    const door = [r.after[UP].exits.at(-1), r.after[ROOM].exits[0]].filter(x => x.barrier);
    assert.equal(door.length, 1, 'one door, shared by the pair');
    assert.equal(r.after[UP].exits.at(-1).direction, 'guest room door');
    assert.equal(r.after[ROOM].exits[0].direction, 'hallway');
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

import { build_world, load_world } from '../../plugin/world.mjs';
import { expandableOf } from '../../plugin/ui/patches.mjs';

test('expandable cascades world > region > subregion > room; nearest setting wins', () => {
    const [wj, raw0] = read_world_raw(RIVERTON);
    const exp = (mut, a = UP) => { const w = structuredClone(wj), raw = structuredClone(raw0); mut(w, raw); return [build_world(w, raw).locations.get(a).expandable, expandableOf(raw, a, w)]; };
    assert.deepEqual(exp(() => {}), [true, true], 'default: expandable');
    assert.deepEqual(exp(w => { w.expandable = false; }), [false, false], 'world says no');
    assert.deepEqual(exp((w, r) => { w.expandable = false; r.riverton.expandable = true; }), [true, true], 'region overrides world');
    assert.deepEqual(exp((w, r) => { r.riverton.expandable = true; r.riverton.subregions.drowned_rat.expandable = false; }), [false, false], 'subregion overrides region');
    assert.deepEqual(exp((w, r) => { r.riverton.subregions.drowned_rat.expandable = false; r.riverton.subregions.drowned_rat.locations.upstairs.expandable = true; }), [true, true], 'room overrides subregion');
    assert.deepEqual(exp((w, r) => { r.riverton.subregions.drowned_rat.expandable = false; }, 'riverton:streets/square'), [true, true], 'other subregions are unaffected');
    for (const m of [w => { w.expandable = 'no'; }, (w, r) => { r.riverton.expandable = 1; }, (w, r) => { r.riverton.subregions.drowned_rat.expandable = 'false'; }]) {
        assert.throws(() => exp(m), /"expandable" must be true or false/);
    }
});

test('expandable: an area-level false refuses discoveries; set_expandable edits it as a plain JSON field', () => {
    const [wj, raw0] = read_world_raw(RIVERTON);
    const raw = structuredClone(raw0); raw.riverton.subregions.drowned_rat.expandable = false;
    assert.throws(() => applyPatch(structuredClone(raw), patch([op({ id: 'guest_room' })])), /can't be expanded/);
    const w = { ...wj, expandable: false };
    assert.throws(() => applyPatch(structuredClone(raw0), patch([op({ id: 'guest_room' })]), { world: w }), /can't be expanded/, 'world.json level');
    const off = patch([{ op: 'set_expandable', target: 'riverton:drowned_rat', value: 'false' }], { id: 'e1' });
    const r = c.post('/patch/preview', { json: { patch: { ops: [op()] }, changes: [off] } });
    assert.ok(!r.ok || r.json().error, 'refused once the inn is marked not expandable');
    const onRoom = patch([{ op: 'set_expandable', target: UP, value: true }], { id: 'e2' });
    const r2 = c.post('/patch/preview', { json: { patch: { ops: [op()] }, changes: [off, onRoom] } }).json();
    assert.equal(r2.ops?.[0]?.id, 'guest_room', 'the room\'s own true wins over its area\'s false');
    const back = patch([{ op: 'set_expandable', target: 'riverton:drowned_rat', value: 'inherit' }], { id: 'e3' });
    const r3 = c.post('/patch/preview', { json: { patch: { ops: [op()] }, changes: [off, back] } }).json();
    assert.equal(r3.ops?.[0]?.id, 'guest_room', 'inherit drops the setting');
    assert.equal(c.post('/discover/context', { json: { location: UP, changes: [off] } }).json().expandable, false);
    const bad = raw0 && (() => applyPatch(structuredClone(raw0), patch([{ op: 'set_expandable', target: 'riverton:drowned_rat', value: 'maybe' }])));
    assert.throws(bad, /true, false or inherit/);
    assert.throws(() => applyPatch(structuredClone(raw0), patch([{ op: 'set_expandable', target: 'nowhere:x', value: true }])), /is not a room, subregion/);
});

test('undescribed doors: prompts allow a door that plausibly fits, the intent offers it, the narration asks for the flag only if it fits', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    const { DEFAULT_PROMPTS } = await import('./useprompts.mjs');
    const pt = id => DEFAULT_PROMPTS.prompts.find(e => e.id === id).text;
    const hint = pt('narration.discover_strict');
    assert.match(hint, /plausibly fits the room/);
    assert.match(hint, /If no such door fits, there is none: do not flag it/);
    const sys = pt('discover.system');
    assert.match(sys, /does not mention but that plausibly fits the room/);
    assert.match(src, /NEW_DOOR = 'try another door'/);
    assert.match(src, /canNewDoor = DOOR_OPEN_RE\.test\(msg\.mes \?\? ''\) && loc\.expandable !== false/);
    const line = pt('narration.new_door') + pt('narration.new_door_tools') + pt('narration.new_door_tags');
    assert.match(line, /If such a door plausibly fits/);
    assert.match(line, /If no such door fits, narrate that there is none/);
    assert.match(line, /\[ws_flag: discover \| which door\]/);
    assert.match(line, /action "discover"/);
    assert.equal(load_world(RIVERTON).locations.get(UP).expandable, true);
});
