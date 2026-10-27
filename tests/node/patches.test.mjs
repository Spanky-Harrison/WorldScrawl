import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { build_world, read_world_raw, WorldError } from '../../plugin/world.mjs';
import { activeChanges, applyPatch, parseLasts, relocated, PatchError } from '../../plugin/ui/patches.mjs';

const R = 'riverton:drowned_rat/';
const KITCHEN = R + 'kitchens', CELLAR = R + 'cellar', STABLE = R + 'stable', UP = R + 'upstairs';
const base = () => read_world_raw(RIVERTON);
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'p1', note: 'test', at: 0, ops, ...extra });
const worldWith = (changes, now = null) => build_world(...apply_changes(...base(), changes, { now }));
const exit = (w, a, d) => w.get(a).exits.find(e => e.direction.toLowerCase() === d);

test('description and notes ops', () => {
    const w = worldWith([patch([{ op: 'set_description', loc: TAVERN, text: 'Charred beams and ash.' }, { op: 'append_notes', area: 'riverton:drowned_rat', text: 'Burned down.' }])]);
    assert.equal(w.get(TAVERN).description, 'Charred beams and ash.');
    assert.match(w.subregions.get('riverton:drowned_rat').notes, /Burned down\.$/);
});

test('block, open, break and remove exits (both sides)', () => {
    let w = worldWith([patch([{ op: 'block_exit', loc: YARD, direction: 'trapdoor' }])]);
    assert.equal(exit(w, YARD, 'trapdoor').blocked, true);
    assert.equal(exit(w, CELLAR, 'trapdoor').blocked, true, 'the other side shares the barrier');
    w = worldWith([patch([{ op: 'break_exit', loc: TAVERN, direction: 'out' }])]);
    assert.equal(exit(w, TAVERN, 'out').barrier, null);
    assert.equal(exit(w, SQUARE, 'in').barrier, null);
    w = worldWith([patch([{ op: 'open_exit', loc: YARD, direction: 'kitchen' }])]);
    assert.equal(exit(w, YARD, 'kitchen').barrier.starts_open, true);
    w = worldWith([patch([{ op: 'remove_exit', loc: TAVERN, direction: 'up' }])]);
    assert.equal(exit(w, TAVERN, 'up'), undefined);
    assert.equal(exit(w, UP, 'down'), undefined);
});

test('merge into a new room rewires exits and relocates', () => {
    const info = {};
    const [wj, raw] = apply_changes(...base(), [patch([{ op: 'merge', locs: [TAVERN, YARD, KITCHEN, UP], id: 'ruins', name: 'Burned Ruins', description: 'Ash.' }])], { info });
    const w = build_world(wj, raw), ruins = R + 'ruins';
    for (const a of [TAVERN, YARD, KITCHEN, UP]) assert.equal(w.get(a), null);
    const r = w.get(ruins);
    assert.equal(r.name, 'Burned Ruins');
    assert.ok(!r.exits.some(e => [TAVERN, YARD, KITCHEN, UP, ruins].includes(e.to)), 'no exits between merged rooms');
    assert.ok(r.exits.some(e => e.to === SQUARE) && r.exits.some(e => e.to === CELLAR) && r.exits.some(e => e.to === STABLE));
    assert.equal(exit(w, SQUARE, 'in').to, ruins, 'outside exits rerouted');
    assert.equal(exit(w, STABLE, 'yard').to, ruins);
    assert.equal(info.patches[0].relocate[TAVERN], ruins);
    assert.equal(w.sub_of(r).entrance, ruins);
    assert.equal(w.regions.get('riverton').entrance, 'riverton:streets/square');
    assert.equal(w.start, 'riverton:drowned_rat/ruins');
});

test('merge keeping one room, and dedupe of exits sharing a target', () => {
    const w = worldWith([patch([{ op: 'merge', locs: [YARD, KITCHEN, STABLE], into: YARD, description: 'One big yard.' }])]);
    assert.equal(w.get(YARD).description, 'One big yard.');
    assert.equal(w.get(KITCHEN), null);
    const toLane = w.get(YARD).exits.filter(e => e.to === 'riverton:streets/market_lane');
    assert.equal(toLane.length, 1);
    const lane = w.get('riverton:streets/market_lane');
    assert.equal(lane.exits.filter(e => e.to === YARD).length, 1);
});

test('collapse a whole subregion into a room elsewhere', () => {
    const rooms = ['common_room', 'courtyard', 'cellar', 'kitchens', 'stable', 'upstairs'].map(x => R + x);
    const w = worldWith([patch([{ op: 'merge', locs: rooms, id: 'rubble', area: 'riverton:streets', name: 'Rubble Heap', description: 'All that is left of the inn.' }])]);
    assert.equal(w.subregions.get('riverton:drowned_rat'), undefined);
    assert.ok(w.get('riverton:streets/rubble'));
    assert.equal(w.start, 'riverton:streets/rubble');
});

test('remove a location', () => {
    const info = {};
    const [wj, raw] = apply_changes(...base(), [patch([{ op: 'remove_location', loc: KITCHEN }])], { info });
    const w = build_world(wj, raw);
    assert.equal(w.get(KITCHEN), null);
    assert.equal(exit(w, YARD, 'kitchen'), undefined);
    assert.equal(info.patches[0].relocate[KITCHEN], YARD);
});

test('validation: clear errors', () => {
    const bad = ops => assert.throws(() => worldWith([patch(ops)]), WorldError);
    bad([{ op: 'explode', loc: TAVERN }]);
    bad([{ op: 'set_description', loc: 'riverton:nope/x', text: 'a' }]);
    bad([{ op: 'block_exit', loc: TAVERN, direction: 'sideways' }]);
    bad([{ op: 'merge', locs: [TAVERN], into: YARD }]);
    bad([{ op: 'merge', locs: [TAVERN, YARD] }]);
    bad([{ op: 'merge', locs: [TAVERN, YARD], id: 'square', area: 'riverton:streets', name: 'x', description: 'y' }]);
    bad([{ op: 'set_description', loc: TAVERN, text: 'a', lasts: 'forever' }]);
    assert.throws(() => applyPatch(base()[1], { ops: [] }), PatchError);
    assert.throws(() => worldWith([patch([{ op: 'set_name', loc: TAVERN, text: 'x' }]), { type: 'add_exit', from: TAVERN, direction: 'zz', to: 'riverton:none/x' }]), /does not exist/);
});

test('lasts expires on the game clock', () => {
    assert.equal(parseLasts('3d'), 259200);
    assert.equal(parseLasts('1d 12h'), 129600);
    const p = patch([{ op: 'block_exit', loc: YARD, direction: 'trapdoor', lasts: '1d' }, { op: 'set_name', loc: TAVERN, text: 'The Ashes' }], { at: 1000 });
    assert.equal(activeChanges([p], 1000 + 86399)[0].ops.length, 2);
    assert.equal(activeChanges([p], 1000 + 86400)[0].ops.length, 1);
    assert.equal(exit(worldWith([p], 2000), YARD, 'trapdoor').blocked, true);
    assert.equal(exit(worldWith([p], 1000 + 90000), YARD, 'trapdoor').blocked, false);
    assert.equal(activeChanges([patch([{ op: 'set_name', loc: TAVERN, text: 'x', lasts: '1h' }])], 99999).length, 0);
});

test('undo by deletion: the base world is untouched and without the patch nothing changes', () => {
    const before = JSON.stringify(base());
    const c = client(RIVERTON);
    const p = patch([{ op: 'merge', locs: [TAVERN, YARD], id: 'ruins', name: 'Ruins', description: 'Ash.' }]);
    const moved = c.post('/move', { json: { from: SQUARE, direction: 'in', changes: [p] } });
    assert.equal(moved.status_code, 200);
    assert.equal(moved.json().address, R + 'ruins');
    assert.equal(c.post('/move', { json: { from: SQUARE, direction: 'in', changes: [] } }).json().address, TAVERN);
    assert.equal(JSON.stringify(base()), before);
    assert.equal(relocated(TAVERN, [{ ...p, relocate: { [TAVERN]: R + 'ruins' } }]), R + 'ruins');
});

test('server: preview, context, rooms and inspector with patches', () => {
    const c = client(RIVERTON);
    const pv = c.post('/patch/preview', { json: { changes: [], patch: { ops: [{ op: 'remove_location', loc: KITCHEN }] } } });
    assert.equal(pv.status_code, 200);
    assert.match(pv.json().summary[0], /removed/);
    assert.equal(c.post('/patch/preview', { json: { patch: { ops: [{ op: 'remove_location', loc: 'x:y/z' }] } } }).status_code, 400);
    const ctxR = c.post('/patch/context', { json: { location: TAVERN, rooms: [TAVERN, 'riverton:drowned_rat'] } }).json();
    assert.ok(ctxR.outline.some(o => o.address === KITCHEN));
    assert.equal(ctxR.rooms[TAVERN].name, 'Common Room');
    assert.ok(ctxR.areas['riverton:drowned_rat']);
    const p = { ...patch([{ op: 'set_name', loc: TAVERN, text: 'The Ashes' }]), _msg: 7 };
    const rooms = c.post('/rooms', { json: { addresses: [TAVERN], changes: [p] } }).json();
    assert.equal(rooms.rooms[0].name, 'The Ashes');
    const ins = c.post('/inspect', { json: { target: TAVERN, changes: [p] } }).json();
    assert.equal(ins.changes[0].msg, 7);
    const list = c.post('/inspect', { json: { target: 'changes', changes: [p] } }).json();
    assert.equal(list.kind, 'changes');
    assert.match(list.resolved[0].value, /The Ashes/);
    assert.equal(c.post('/move', { json: { from: TAVERN, direction: 'out', changes: [patch([{ op: 'block_exit', loc: TAVERN, direction: 'out' }])] } }).status_code, 400);
});
