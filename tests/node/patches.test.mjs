import './ststub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { build_world, read_world_raw, WorldError } from '../../plugin/world.mjs';
import { activeChanges, applyPatch, parseLasts, relocated, PatchError, resolveRoom, slugId, newRoomId, normalizeOp, noopOf, getRoom, roomMatches, readChangeAnswer, opDocs, OPS } from '../../plugin/ui/patches.mjs';
import fs from 'node:fs';
import { cleanOp, formOps, checkOps, errorsByOp, blankOp, liveOps, editLine, OP_FIELDS } from '../../plugin/ui/patchform.mjs';
import { blockDiff, fieldDiffs, mergeLines, exitState, wordDiff, moveGroups, inheritLine } from '../../plugin/ui/diffview.mjs';
import { sessionFromUrl, touchedTargets, combineOps, targetOf } from '../../plugin/ui/changeedit.mjs';

// ---- from patches.test.mjs
{
const R = 'riverton:drowned_rat/';
const KITCHEN = R + 'kitchens', CELLAR = R + 'cellar', STABLE = R + 'stable', UP = R + 'upstairs';
const base = () => read_world_raw(RIVERTON);
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'p1', note: 'test', at: 0, ops, ...extra });
const worldWith = (changes, now = null) => build_world(...apply_changes(...base(), changes, { now }));
const exit = (w, a, d) => w.get(a).exits.find(e => e.direction.toLowerCase() === d);

test('description and notes ops', () => {
    const w = worldWith([patch([{ op: 'set_description', loc: TAVERN, text: 'Charred beams and ash.' }, { op: 'append_lore', area: 'riverton:drowned_rat', text: 'Burned down.' }])]);
    assert.equal(w.get(TAVERN).description, 'Charred beams and ash.');
    assert.match(w.subregions.get('riverton:drowned_rat').lore, /Burned down\.$/);
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
    const ops = [{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Palace', lore: 'Gold everywhere.' }, ...rooms.map(a => ({ op: 'set_description', loc: a, text: `Gilded ${a}.` }))];
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

test('travel_time is shared by an exit pair; hidden/label stay per side', () => {
    const w = worldWith([patch([{ op: 'set_travel_time', loc: TAVERN, direction: 'up', time: '10m' }])]);
    assert.equal(exit(w, TAVERN, 'up').travel_time, 600);
    assert.equal(exit(w, UP, 'down').travel_time, 600, 'the way back takes the same time');
    assert.throws(() => worldWith([patch([{ op: 'set_travel_time', loc: TAVERN, direction: 'up', time: 'soon' }])]), /travel time must look like/);
});

test('ambiguous bare id: not guessed, error lists the choices', () => {
    const [, raw] = base();
    const sub = Object.values(raw.riverton.subregions).find(s => s.locations && !s.locations.cellar);
    sub.locations.cellar = { name: 'Other Cellar', description: 'x', exits: [] };
    assert.ok(roomMatches(raw, 'cellar').length > 1);
    assert.equal(resolveRoom(raw, 'cellar'), 'cellar');
    let err; try { applyPatch(raw, patch([{ op: 'set_description', loc: 'cellar', text: 'Damp.' }]), { now: null }); } catch (e) { err = e; }
    assert.ok(err instanceof PatchError && err.choices?.length > 1, String(err));
});
}

// ---- from samepatch.test.mjs
{
// Ops that point at places made earlier in the same patch, and an add_exit that repeats create_place's own door pair.







const UP = 'riverton:drowned_rat/upstairs';
const raw = () => read_world_raw(RIVERTON)[1];
const mind = (extra = {}) => readChangeAnswer({ ops: [{ op: 'create_place', name: 'Secret Mind Dimension', description: 'A swirl of thought.', exits: [{ to: UP, direction: 'portal', return_direction: 'shimmering portal' }], lasts: '1h', ...extra }] }).ops[0];
const made = r => Object.entries(r.riverton.subregions.drowned_rat.locations).find(([, v]) => v.name === 'Secret Mind Dimension');

test('an add_exit repeating the door pair create_place made is dropped, its extra fields merged', () => {
    const r = raw();
    const out = applyPatch(r, { ops: [mind(), { op: 'add_exit', loc: UP, to: 'new:secret mind dimension', direction: 'shimmering portal', return_direction: 'portal', description: 'A rip in the air hums softly.' }] });
    const [id] = made(r), a = `riverton:drowned_rat/${id}`;
    const up = getRoom(r, UP).exits.filter(e => e.to === a);
    assert.equal(up.length, 1);
    assert.equal(up[0].description, 'A rip in the air hums softly.');
    assert.match(out.summary[1], /merged/);
});
test('"new:<ref>" points at a place made earlier in the patch', () => {
    const r = raw();
    applyPatch(r, { ops: [mind({ ref: 'mind' }), { op: 'set_description', loc: 'new:mind', text: 'Thoughts drift like fish.' }] });
    assert.equal(made(r)[1].description, 'Thoughts drift like fish.');
    assert.throws(() => applyPatch(raw(), { ops: [mind(), { op: 'set_description', loc: 'new:nope', text: 'x' }] }), PatchError);
});
test('a guessed address for a new place resolves to it', () => {
    const r = raw();
    applyPatch(r, { ops: [mind(), { op: 'set_description', loc: 'riverton:secret_mind_dimension/secret_mind_dimension', text: 'Guessed.' }] });
    assert.equal(made(r)[1].description, 'Guessed.');
});
test('the op docs say create_place makes the exit pair and explain ref / new:', () => {
    const d = opDocs();
    assert.match(d, /already makes the door pair/);
    assert.match(d, /never add a separate add_exit/);
    assert.match(d, /"new:label"/);
});
test('change prompts count temporary changes and drop the "lasting" wording', () => {
    const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
    const by = Object.fromEntries(def.prompts.map(e => [e.id, e.text]));
    for (const id of ['change.system', 'change.scope', 'change.scope_system', 'narration.flag_hint']) assert.doesNotMatch(by[id], /lasting|permanently/, id);
    assert.match(by['change.system'], /portal open for 1 hour/);
    assert.match(by['change.system'], /Moment-to-moment action/);
});
}

// ---- from patchform.test.mjs
{
// The shared patch editor's serialization / checks, and the live (patched) inspector rows.






const row = (d, key) => d.resolved.find(r => r.key === key);

test('patch form: every op type has fields, and blank ops serialize to only those fields', () => {
    for (const o of OPS) {
        assert.ok(OP_FIELDS[o], o);
        const op = cleanOp({ ...blankOp(o, { loc: 'a:b/c', area: 'a:b', direction: 'north', text: 'x' }), junk: 1, lasts: ' ' });
        assert.equal(op.op, o);
        assert.ok(!('junk' in op) && !('lasts' in op));
    }
    assert.deepEqual(formOps([{ op: 'set_description', loc: ' a:b/c ', text: ' Ash. ', lasts: '2d', direction: 'n' }]), [{ op: 'set_description', loc: 'a:b/c', text: 'Ash.', lasts: '2d' }]);
    assert.deepEqual(cleanOp({ op: 'merge', locs: 'a:b/c, a:b/d, a:b/c', into: 'a:b/c', name: '' }), { op: 'merge', locs: ['a:b/c', 'a:b/d'], into: 'a:b/c' });
});

test('patch form: checks required fields, merges and "lasts"', () => {
    assert.equal(checkOps([])[0].i, null);
    assert.deepEqual(checkOps(formOps([{ op: 'block_exit', loc: 'a:b/c', direction: 'up' }])), []);
    assert.match(checkOps(formOps([{ op: 'set_description', loc: 'a:b/c', text: '' }]))[0].error, /text/);
    assert.match(checkOps(formOps([{ op: 'set_name', loc: 'a:b/c', text: 'X', lasts: 'soon' }]))[0].error, /lasts/);
    assert.match(checkOps(formOps([{ op: 'merge', locs: ['a:b/c', 'a:b/d'], into: 'a:b/z' }]))[0].error, /Keep as/);
    assert.match(checkOps(formOps([{ op: 'merge', locs: ['a:b/c', 'a:b/d'], name: 'Ruins' }]))[0].error, /new place/);
    assert.deepEqual(checkOps(formOps([{ op: 'merge', locs: ['a:b/c', 'a:b/d'], id: 'ruins', name: 'Ruins', description: 'Ash.' }])), []);
    assert.equal(checkOps([{ op: 'nope' }])[0].i, 0);
    assert.deepEqual(errorsByOp('patch, op #2: "loc" "x" is not a room'), { i: 1, error: '"loc" "x" is not a room' });
    assert.deepEqual(errorsByOp('bad'), { i: null, error: 'bad' });
});

test('patch form: "Edit live" starting ops and the visible message line', () => {
    assert.deepEqual(liveOps(TAVERN, { description: 'Old.' }), [{ op: 'set_description', loc: TAVERN, text: 'Old.' }]);
    assert.deepEqual(liveOps(`exit:${TAVERN}|up`), [{ op: 'block_exit', loc: TAVERN, direction: 'up' }]);
    assert.deepEqual(liveOps('sub:riverton:drowned_rat', { lore: 'N', name: 'Rat' }), [{ op: 'update_area', area: 'riverton:drowned_rat', name: 'Rat', lore: 'N' }]);
    assert.deepEqual(liveOps('region:riverton', { name: 'Riverton' }), [{ op: 'update_area', area: 'riverton', name: 'Riverton', lore: '' }]);
    assert.equal(liveOps('region:riverton')[0].area, 'riverton');
    assert.equal(editLine(['The Drowned Rat: description rewritten']), 'Map edit: The Drowned Rat: description rewritten');
});

test('inspector: a room shows its own description; Resolved is live and tags patched values with the message', () => {
    const c = client(RIVERTON);
    const plain = c.get('/inspect', { params: { target: TAVERN } }).json();
    assert.ok(row(plain, 'description').value.length > 10);
    assert.equal(row(plain, 'description').source, 'from file');
    assert.equal(row(plain, 'name').source, 'from file');
    assert.ok(row(plain, 'inherit_region_lore'));
    const p = { type: 'patch', id: 'p1', at: 0, _msg: 7, ops: [{ op: 'set_description', loc: TAVERN, text: 'Charred beams.' }, { op: 'append_lore', area: 'riverton:drowned_rat', text: 'Burned.' }] };
    const live = c.post('/inspect', { json: { target: TAVERN, changes: [p] } }).json();
    assert.equal(row(live, 'description').value, 'Charred beams.');
    assert.equal(row(live, 'description').source, 'from message #7');
    assert.equal(row(live, 'name').source, 'from file');
    assert.match(row(live, 'subregion lore').value, /Burned\.$/);
    assert.equal(row(live, 'subregion lore').source, 'from message #7');
    const sub = c.post('/inspect', { json: { target: 'sub:riverton:drowned_rat', changes: [p] } }).json();
    assert.equal(row(sub, 'lore').source, 'from message #7');
});

test('inspector: region and subregion edits (update_area / set_lore / append_lore) are tagged with their message', () => {
    const c = client(RIVERTON);
    const p = (ops, msg) => ({ type: 'patch', id: `p${msg}`, note: 'edit', at: 0, ops, _msg: msg });
    const changes = [p([{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Rat', lore: 'Gilded.' }], 4),
        p([{ op: 'append_lore', area: 'riverton', text: 'Flooded.' }], 6)];
    const sub = c.post('/inspect', { json: { target: 'sub:riverton:drowned_rat', changes } }).json();
    assert.equal(row(sub, 'name').value, 'The Golden Rat');
    assert.equal(row(sub, 'name').source, 'from message #4'); assert.equal(row(sub, 'name').changed, true);
    assert.equal(row(sub, 'lore').source, 'from message #4');
    assert.ok(!row(sub, 'entrance').changed);
    const reg = c.post('/inspect', { json: { target: 'region:riverton', changes } }).json();
    assert.match(row(reg, 'lore').value, /Flooded\.$/); assert.equal(row(reg, 'lore').source, 'from message #6');
    const set = c.post('/inspect', { json: { target: 'region:riverton', changes: [p([{ op: 'set_lore', area: 'riverton', text: 'Rewritten.' }], 2)] } }).json();
    assert.deepEqual([row(set, 'lore').value, row(set, 'lore').source], ['Rewritten.', 'from message #2']);
    // An unchanged prefilled name/notes is a no-op in the preview; changing only the name says only that.
    const pv = c.post('/patch/preview', { json: { patch: { ops: [{ op: 'update_area', area: 'riverton:drowned_rat', name: 'Rat Hole', lore: sub.resolved.length ? row(c.get('/inspect', { params: { target: 'sub:riverton:drowned_rat' } }).json(), 'lore').value : '' }] } } }).json();
    assert.ok((pv.summary ?? []).join(' ').includes('now called Rat Hole') && !(pv.summary ?? []).join(' ').includes('lore rewritten'), JSON.stringify(pv.summary));
});
}

// ---- from toggle.test.mjs
{
const c = client(RIVERTON);
const MERGED = 'riverton:drowned_rat/burnt_inn';
const patch = (id, _msg, ops) => ({ type: 'patch', id, note: id, at: 0, ops, _msg });
const chain = () => [
    patch('merge', 3, [{ op: 'merge', locs: [TAVERN, YARD], id: 'burnt_inn', name: 'Burnt Inn', description: 'Ash.' }]),
    patch('soot', 5, [{ op: 'set_description', loc: MERGED, text: 'Soot everywhere.' }]),
    patch('square', 7, [{ op: 'set_description', loc: SQUARE, text: 'Quiet square.' }]),
    patch('sign', 9, [{ op: 'append_lore', area: 'riverton:drowned_rat', text: 'Burned down.' }]),
];
const rooms = (changes, a) => c.post('/rooms', { json: { addresses: [a], changes } }).json();

test('turned-off changes are skipped in the replay but the rest still apply', () => {
    const ch = chain(); ch[0].off = true;
    const r = c.post('/changes/status', { json: { changes: ch } }).json();
    assert.deepEqual(r.failed.map(f => [f.msg, f.id]), [[5, 'soot']]);
    assert.match(r.failed[0].error, /burnt_inn|no such|unknown|not/i);
    assert.equal(c.post('/changes/status', { json: { changes: chain() } }).json().failed.length, 0);
    assert.equal(rooms(ch, TAVERN).rooms.length, 1);
    assert.deepEqual(rooms(ch, MERGED).unknown, [MERGED]);
    assert.equal(rooms(ch, SQUARE).rooms[0].description, 'Quiet square.');
});

test('lenient apply_changes skips failures individually; strict still throws', () => {
    const [wj, raw] = read_world_raw(RIVERTON);
    const ch = chain(); ch[0].off = true;
    assert.throws(() => apply_changes(wj, raw, ch));
    const info = { patches: [] };
    apply_changes(wj, raw, ch, { lenient: true, info });
    assert.deepEqual(info.failed.map(f => f.index), [1]);
    assert.deepEqual(info.patches.map(p => p.index), [2, 3]);
});

test('dependents: hard ones fail without it, overlaps touched the same ids', () => {
    const r = c.post('/changes/dependents', { json: { changes: chain(), index: 0 } }).json();
    assert.deepEqual(r.hard.map(h => h.msg), [5]);
    assert.ok(!r.overlaps.some(o => o.msg === 5 || o.msg === 7));
    assert.equal(c.post('/changes/dependents', { json: { changes: chain(), index: 9 } }).status_code, 400);
    const none = c.post('/changes/dependents', { json: { changes: chain(), index: 2 } }).json();
    assert.deepEqual([none.hard, none.overlaps], [[], []]);
});

test('dependents: overlaps are later changes on the same room, listed as may-depend', () => {
    const ch = [patch('desc', 3, [{ op: 'set_description', loc: TAVERN, text: 'Smoky.' }]),
        patch('name', 6, [{ op: 'set_name', loc: TAVERN, text: 'Smoke Room' }]),
        patch('other', 8, [{ op: 'set_description', loc: SQUARE, text: 'x' }])];
    const r = c.post('/changes/dependents', { json: { changes: ch, index: 0 } }).json();
    assert.deepEqual(r.hard, []);
    assert.deepEqual(r.overlaps.map(o => o.msg), [6]);
    // already-off later changes are not listed
    ch[1].off = true;
    assert.deepEqual(c.post('/changes/dependents', { json: { changes: ch, index: 0 } }).json().overlaps, []);
});

test('inspect lists turned-off and failing changes so they can be turned on again', () => {
    const ch = chain(); ch[0].off = true;
    const all = c.post('/inspect', { json: { target: 'changes', changes: ch } }).json().changes;
    assert.deepEqual(all.map(x => [x.msg, !!x.off, !!x.failed]), [[3, true, false], [5, false, true], [7, false, false], [9, false, false]]);
    const room = c.post('/inspect', { json: { target: TAVERN, changes: ch } }).json().changes;
    assert.ok(room.some(x => x.msg === 3 && x.off));
});
}

// ---- from diffview.test.mjs
{
// The red/green before/after view's pure builders.





test('diff: sentences kept, removed and added; an inserted paragraph is a clean ADDED block', () => {
    assert.deepEqual(blockDiff('A cosy inn. Fire crackles.', 'A cosy inn. Smoke hangs. Fire crackles.'),
        [{ type: 'same', blocks: ['A cosy inn.'] }, { type: 'ins', blocks: ['Smoke hangs.'] }, { type: 'same', blocks: ['Fire crackles.'] }]);
    assert.deepEqual(blockDiff('Old one.', 'New one.'), [{ type: 'del', blocks: ['Old one.'] }, { type: 'ins', blocks: ['New one.'] }]);
    assert.deepEqual(blockDiff('', ''), []);
});

test('diff: per-field changes for a room, an area, exits and merges (from a real preview)', () => {
    const c = client(RIVERTON);
    const pv = c.post('/patch/preview', { json: { patch: { ops: [
        { op: 'set_description', loc: TAVERN, text: 'Burned to the rafters.' }, { op: 'block_exit', loc: TAVERN, direction: 'up' },
        { op: 'update_area', area: 'riverton:drowned_rat', name: 'The Golden Palace' }] } } }).json();
    const d = fieldDiffs(pv.before, pv.after, pv.relocate);
    const room = d.find(x => x.key === TAVERN);
    assert.equal(room.status, 'changed');
    const desc = room.fields.find(f => f.field === 'description');
    assert.ok(desc.changed && desc.new === 'Burned to the rafters.' && desc.old.length > 10);
    assert.equal(room.fields.find(f => f.field === 'name').changed, false, 'unchanged fields are marked so they can be hidden');
    const ex = room.fields.find(f => f.field === 'exits');
    assert.ok(ex.changed && ex.new.some(l => /^up .*blocked/.test(l)), JSON.stringify(ex));
    const area = d.find(x => x.key === 'riverton:drowned_rat');
    assert.equal(area.kind, 'area');
    assert.equal(area.fields.find(f => f.field === 'name').new, 'The Golden Palace');
    assert.equal(exitState({ barrier: { openable: true, locked: true } }), 'locked door');
    const md = fieldDiffs({ 'a:b/x': { name: 'X' }, 'a:b/y': { name: 'Y' }, 'a:b/z': null }, { 'a:b/x': null, 'a:b/y': null, 'a:b/z': { name: 'Z' } }, { 'a:b/x': 'a:b/z', 'a:b/y': 'a:b/z' });
    assert.deepEqual(mergeLines(md), ['rooms X, Y → Z']);
    assert.equal(md.find(x => x.key === 'a:b/z').status, 'added');
});

test('index: friendly place and area names for the form pickers', () => {
    const r = client(RIVERTON).get('/inspect/index').json();
    assert.match(r.names[TAVERN], /^Common Room \(.+\)$/);
    assert.ok(Object.values(r.areaNames).some(v => /\(region\)$/.test(v)));
});

test('word diff: only the changed words are marked', () => {
    const d = wordDiff('A smoky common room with a long bar.', 'A gilded common room with a long bar.');
    assert.deepEqual(d.filter(p => p.type !== 'same').map(p => [p.type, p.text]), [['del', 'smoky'], ['ins', 'gilded']]);
    assert.equal(d.filter(p => p.type !== 'ins').map(p => p.text).join(''), 'A smoky common room with a long bar.');
});
}

// ---- from movediff.test.mjs
{
test('move_location: one line, renamed id shown, grouped by source subregion', () => {
    const { groups, covered } = moveGroups({ ops: [{ op: 'move_location', loc: 'a:x/hall', area: 'b:y' }], relocate: { 'a:x/hall': 'b:y/hall_2' } });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].from, 'a:x'); assert.equal(groups[0].to, 'b:y');
    assert.deepEqual(groups[0].items[0].renamed, { from: 'hall', to: 'hall_2' });
    assert.ok(covered.has('a:x/hall') && covered.has('b:y/hall_2'));
});
test('move_area: one subregion line with its places as children', () => {
    const { groups } = moveGroups({ ops: [{ op: 'move_area', area: 'a:x', region: 'b' }], relocate: { 'a:x/p1': 'b:x/p1', 'a:x/p2': 'b:x/p2' } });
    const it = groups[0].items[0];
    assert.equal(it.kind, 'subregion'); assert.equal(it.new, 'b:x'); assert.equal(it.children.length, 2); assert.equal(it.renamed, null);
});
test('region bulk move: one group, one line per subregion, a shared note once per group', () => {
    const n = { kind: 'region', from: 'Larkspur', to: 'Riverton', changed: ['lore', 'climate'] };
    const { groups } = moveGroups({ ops: [{ op: 'remove_area', area: 'l', contents: 'move', into: 'r' }],
        relocate: { 'l:s1/a': 'r:s1/a', 'l:s2/b': 'r:s2/b' }, inherit: { 'l:s1/a': n, 'l:s2/b': n } });
    assert.equal(groups.length, 1); assert.equal(groups[0].items.length, 2);
    assert.ok(groups[0].note); assert.ok(groups[0].items.every(i => !i.note));
});
test('inheritance line names only the differing categories', () => {
    const t = inheritLine({ kind: 'region', from: 'Larkspur', to: 'Riverton', changed: ['lore', 'climate'] });
    assert.match(t ?? '', /Riverton/); assert.match(t ?? '', /lore/); assert.match(t ?? '', /Larkspur/);
});
}

// ---- from changeedit.test.mjs
{
// The change editor tab: URL session, touched-place tabs, and the ST-side checks before a stamp is rewritten.




const X = await import('../../extension/index.js');

test('sessionFromUrl: only edit=1 with chat, msg and change', () => {
    assert.deepEqual(sessionFromUrl('?edit=1&chat=c1&msg=4&swipe=0&change=p1&hash=abc'), { chat: 'c1', msg: '4', swipe: '0', change: 'p1', hash: 'abc' });
    assert.equal(sessionFromUrl('?chat=c1&msg=4&change=p1'), null);
    assert.equal(sessionFromUrl('?edit=1&msg=4'), null);
});
test('touchedTargets: rooms first, then areas as sub:/region:, each once', () => {
    assert.deepEqual(touchedTargets(['r:a', 'r:a/x', 'r', 'r:a/x', 'r:a/y']), ['r:a/x', 'r:a/y', 'sub:r:a', 'region:r']);
    assert.equal(targetOf('r:a/x'), 'r:a/x');
    assert.deepEqual(combineOps([{ op: 'a' }], [[{ op: 'b' }], [], [{ op: 'c' }]]).map(o => o.op), ['a', 'b', 'c']);
});
test('changeEditUrl / changeEditMismatch: chat, message, swipe and change must all still match', () => {
    const p = { id: 'p1', ops: [{ op: 'set_description', target: 'r:a/x', text: 'Burnt.' }] };
    const chat = [{ mes: 'hi' }, { mes: 'reply', swipe_id: 1, extra: { worldscrawl_patches: [{ ...p, swipe: 1 }] } }];
    const url = X.changeEditUrl(1, p, chat, 'chat-A');
    assert.match(url, /\/ui\/\?edit=1&chat=chat-A&msg=1&swipe=1&change=p1&hash=/);
    const d = sessionFromUrl(url.slice(url.indexOf('?')));
    assert.equal(X.changeEditMismatch(d, chat, 'chat-A'), '');
    assert.match(X.changeEditMismatch(d, chat, 'chat-B'), /not the one open/);
    assert.match(X.changeEditMismatch({ ...d, msg: '5' }, chat, 'chat-A'), /no longer in the chat/);
    assert.match(X.changeEditMismatch(d, [chat[0], { ...chat[1], swipe_id: 0 }], 'chat-A'), /different swipe/);
    assert.match(X.changeEditMismatch({ ...d, change: 'p2' }, chat, 'chat-A'), /no longer on its message/);
    const edited = [chat[0], { ...chat[1], extra: { worldscrawl_patches: [{ ...p, swipe: 1, ops: [{ op: 'set_description', target: 'r:a/x', text: 'Rebuilt.' }] }] } }];
    assert.match(X.changeEditMismatch(d, edited, 'chat-A'), /edited since/);
});
}
