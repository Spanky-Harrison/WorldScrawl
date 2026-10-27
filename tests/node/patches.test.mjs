import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { build_world, read_world_raw, WorldError } from '../../plugin/world.mjs';
import { activeChanges, applyPatch, parseLasts, relocated, PatchError, resolveRoom, slugId, newRoomId, normalizeOp, noopOf, getRoom } from '../../plugin/ui/patches.mjs';

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
    const [wj, raw] = apply_changes(...base(), [patch([{ op: 'merge', locs: [TAVERN, YARD, KITCHEN, UP], id: 'ignored', name: 'Ruins', description: 'Ash.' }])], { info });
    const w = build_world(wj, raw), ruins = R + 'ruins';
    for (const a of [TAVERN, YARD, KITCHEN, UP]) assert.equal(w.get(a), null);
    const r = w.get(ruins);
    assert.equal(r.name, 'Ruins');
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
    const w = worldWith([patch([{ op: 'merge', locs: rooms, area: 'riverton:streets', name: 'Rubble', description: 'All that is left of the inn.' }])]);
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
    bad([{ op: 'merge', locs: [TAVERN, YARD], area: 'riverton:streets', name: '!!', description: 'y' }]);
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

test('ids: full addresses or bare ids are accepted; new room ids come from the name, deduped', () => {
    const raw = base()[1];
    assert.equal(resolveRoom(raw, 'kitchens'), KITCHEN);
    assert.equal(resolveRoom(raw, 'drowned_rat/common_room'), TAVERN);
    assert.equal(resolveRoom(raw, ' Riverton:Drowned_Rat/Common_Room '), TAVERN);
    assert.equal(resolveRoom(raw, 'nowhere'), 'nowhere');
    assert.equal(slugId('riverton:golden_palace/common_room'), 'common_room');
    assert.equal(newRoomId('The Burned Hall!'), 'the_burned_hall');
    const n = normalizeOp(raw, { op: 'merge', locs: ['drowned_rat/common_room', 'courtyard'], id: 'riverton:streets/Big Hole', name: 'Hole', description: 'x' });
    assert.deepEqual(n.locs, [TAVERN, YARD]); assert.equal(n.id, 'big_hole'); assert.equal(n.area, 'riverton:streets');
    assert.equal(normalizeOp(raw, { op: 'block_exit', loc: 'kitchens', direction: 'up' }).loc, KITCHEN);
    // the bug report: a full address as the new id no longer fails, and bare loc refs work
    const w = worldWith([patch([{ op: 'merge', locs: ['drowned_rat/common_room', 'courtyard'], id: 'riverton:golden_palace/common_room', name: 'Common Room', description: 'Ash.' }])]);
    assert.ok(w.get(TAVERN), 'name "Common Room" in its own area reuses the freed id');
    const w2 = worldWith([patch([{ op: 'merge', locs: [YARD, KITCHEN], area: 'riverton:drowned_rat', name: 'Common Room', description: 'Ash.' }])]);
    assert.ok(w2.get(TAVERN) && w2.get(R + 'common_room_2'), 'taken id gets _2');
    const r = applyPatch(base()[1], { ops: [{ op: 'set_name', loc: 'drowned_rat/common_room', text: 'X' }] });
    assert.equal(r.ops[0].loc, TAVERN, 'normalized ops are returned');
});

test('update_area: the Drowned Rat becomes a golden palace (area renamed, every room re-described, ids and exits unchanged)', () => {
    const rooms = ['common_room', 'courtyard', 'cellar', 'kitchens', 'stable', 'upstairs'].map(x => R + x);
    const before = worldWith([]);
    const ops = [{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Palace', notes: 'Gold everywhere.' }, ...rooms.map(a => ({ op: 'set_description', loc: a, text: `Gilded ${a}.` }))];
    const w = worldWith([patch(ops)]);
    assert.equal(w.subregions.get('riverton:drowned_rat').name, 'The Golden Palace');
    for (const a of rooms) {
        assert.equal(w.get(a).description, `Gilded ${a}.`);
        assert.deepEqual(w.get(a).exits.map(e => [e.direction, e.to]), before.get(a).exits.map(e => [e.direction, e.to]));
    }
    assert.equal(exit(w, SQUARE, 'in').to, TAVERN);
    assert.throws(() => worldWith([patch([{ op: 'update_area', area: 'riverton:drowned_rat' }])]), WorldError);
    assert.throws(() => worldWith([patch([{ op: 'update_area', area: 'riverton:golden_palace', name: 'x' }])]), WorldError);
    const r = applyPatch(base()[1], { ops: [{ op: 'update_area', area: 'riverton', name: 'Goldton', lasts: '1d' }] });
    assert.match(r.summary[0], /Goldton/);
});

test('no-ops: a rename to the same name or identical text is dropped from a preview, and a patch of only no-ops is refused', () => {
    const raw = structuredClone(base()[1]);
    const name = getRoom(raw, TAVERN).name;
    const r = applyPatch(raw, { ops: [{ op: 'set_name', loc: TAVERN, text: name }, { op: 'set_description', loc: TAVERN, text: 'Ash.' }] }, { dropNoops: true });
    assert.deepEqual(r.noops.map(n => n.i), [0]);
    assert.equal(r.ops.length, 1);
    assert.equal(noopOf(raw, { op: 'set_description', loc: TAVERN, text: 'Ash.' }) !== '', true);
    assert.throws(() => applyPatch(structuredClone(base()[1]), { ops: [{ op: 'set_name', loc: TAVERN, text: name }] }, { dropNoops: true }), /nothing changes/);
    // replaying stamped patches never drops anything
    assert.equal(applyPatch(structuredClone(base()[1]), { ops: [{ op: 'set_name', loc: TAVERN, text: name }] }).ops.length, 1);
});

test('exit pairs: shared door state follows both sides, per-side fields (description, hidden) stay on one side', () => {
    // edit on one side: locking from the yard locks the cellar side too
    let w = worldWith([patch([{ op: 'lock_exit', loc: YARD, direction: 'trapdoor' }])]);
    assert.equal(exit(w, YARD, 'trapdoor').barrier.locked, true);
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.locked, true);
    // removal on one side removes the pair
    w = worldWith([patch([{ op: 'remove_exit', loc: CELLAR, direction: 'trapdoor' }])]);
    assert.equal(exit(w, CELLAR, 'trapdoor'), undefined);
    assert.equal(exit(w, YARD, 'trapdoor'), undefined);
    // per-side: rewriting one side's description leaves the way back as written
    const before = exit(worldWith([]), SQUARE, 'in').description, back0 = exit(worldWith([]), TAVERN, 'out').description;
    w = worldWith([patch([{ op: 'set_exit_description', loc: SQUARE, direction: 'in', text: 'A golden sign blazes over the door.' }])]);
    assert.notEqual(before, 'A golden sign blazes over the door.');
    assert.equal(exit(w, SQUARE, 'in').description, 'A golden sign blazes over the door.');
    assert.equal(exit(w, TAVERN, 'out').description, back0);
    // per-side: breaking the hidden cellar door open reveals it from the cellar only, not from the tunnel
    const tunnel = 'riverton:secret_tunnel/tunnel';
    w = worldWith([patch([{ op: 'break_exit', loc: CELLAR, direction: 'narrow door' }])]);
    assert.equal(exit(w, CELLAR, 'narrow door').view, 'open');
    assert.equal(exit(w, tunnel, 'narrow door').flags.hidden, true, 'the tunnel side keeps its own visibility');
});

test('renames: unlabeled exits show the destination\'s current name; hand-written exit names stay as written', () => {
    const w = worldWith([patch([{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Palace' }, { op: 'set_name', loc: CELLAR, text: 'Treasury' }])]);
    const sq = w.to_dict(w.get(SQUARE)), into = sq.exits.find(e => e.direction === 'in');
    assert.equal(into.to_label, 'The Golden Palace');
    assert.ok(!JSON.stringify(sq.exits.map(e => e.to_label ?? '')).includes('Drowned Rat'));
    const c = client(RIVERTON);
    const ins = c.post('/inspect', { json: { target: SQUARE, changes: [patch([{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Palace' }])] } }).json();
    assert.ok(JSON.stringify(ins).includes('The Golden Palace'), 'resolved view names the new place');
    // the hand-labeled hidden door from the tunnel keeps its own name ("narrow door"), never the renamed target
    const tun = w.to_dict(w.get('riverton:secret_tunnel/tunnel')).exits.map(e => e.direction);
    assert.ok(tun.includes('narrow door') && !tun.some(d => /treasury/i.test(d)));
    const yard = w.to_dict(w.get(YARD)).exits.find(e => e.direction === 'trapdoor');
    assert.equal(yard.direction, 'trapdoor');
});
