// The map's Edit place / subregion / region forms: the context they start from, the diff that turns them into ops,
// and the new ops (set_fields, set_exit, add_exit, move_location).
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { initialState, placeOps, areaOps, newExit, formProblems, setDirection, ROOM_FIELDS, EXIT_FIELDS } from '../../plugin/ui/placeform.mjs';
import { applyPatch, getRoom, PatchError } from '../../plugin/ui/patches.mjs';
import { read_world_raw } from '../../plugin/world.mjs';
const loadRaw = () => read_world_raw(RIVERTON)[1];

const UP = 'riverton:drowned_rat/upstairs', LANE = 'riverton:streets/market_lane';
const ctxOf = (c, target, changes = []) => c.post('/edit/context', { json: { target, changes } }).json();
const preview = (c, ops, changes = []) => c.post('/patch/preview', { json: { patch: { ops }, changes } });

test('edit context: own values, inherited ones with their source, exits with the shared door, dropdown lists', () => {
    const c = client(RIVERTON), x = ctxOf(c, TAVERN);
    assert.equal(x.kind, 'room');
    assert.equal(x.own.name, 'Common Room');
    assert.ok(!('exposure' in x.own) && !('expandable' in x.own));
    assert.deepEqual(x.inherited.exposure, { value: 'sheltered', from: 'subregion' });
    assert.deepEqual(x.inherited.expandable, { value: true, from: 'default' });
    assert.deepEqual(x.inherited.inherit_region_lore, { value: true, from: 'default' });
    const out = x.exits.find(e => e.direction === 'out');
    assert.equal(out.to, SQUARE); assert.equal(out.to_name, 'Village Square'); assert.deepEqual(out.barrier, {}); assert.equal(out.back_direction, 'in');
    assert.ok(x.subregions.some(s => s.area === 'riverton:streets'));
    assert.ok(x.rooms.some(r => r.address === LANE) && !x.rooms.some(r => r.address === TAVERN));
    // An exit target edits its room; a subregion / region gets its own form.
    assert.equal(ctxOf(c, `exit:${TAVERN}|out`).address, TAVERN);
    const s = ctxOf(c, 'sub:riverton:drowned_rat');
    assert.equal(s.kind, 'subregion'); assert.equal(s.own.entrance, 'common_room'); assert.deepEqual(s.inherited.stays_open, { value: false, from: 'default' });
    assert.ok(s.entrances.some(e => e.value === 'courtyard'));
    const r = ctxOf(c, 'region:riverton');
    assert.equal(r.kind, 'region'); assert.ok(r.entrances.some(e => e.value === 'streets'));
    assert.equal(c.post('/edit/context', { json: { target: 'riverton:nope/x' } }).status_code, 404);
    // Notes stack: parent notes are listed (read-only) with the toggle that drops them, never as an inherited value.
    assert.ok(!('description' in x.inherited));
    for (const n of x.parent_notes) assert.ok(['inherit_region_lore', 'inherit_subregion_lore'].includes(n.toggle) && n.text);
});

test('edit form diff: an untouched form makes no ops; inherited values are never copied in', () => {
    const c = client(RIVERTON);
    for (const t of [TAVERN, 'sub:riverton:drowned_rat', 'region:riverton']) {
        const x = ctxOf(c, t), st = initialState(x);
        assert.deepEqual(x.kind === 'room' ? placeOps(x, st) : areaOps(x, st), [], t);
        assert.deepEqual(formProblems(x, st), [], t);
    }
});

test('edit form diff: only changed fields become ops, in a safe order', () => {
    const c = client(RIVERTON), x = ctxOf(c, TAVERN), st = initialState(x);
    st.own.description = 'Smoky.';
    st.own.expandable = false;
    st.own.exposure = 'outdoor';
    const out = st.exits.find(e => e.orig === 'out');
    out.side.sight = 'clear'; out.side.direction = 'front'; out.travel_time = '2m'; out.side.description = 'The front door.';
    out.barrier = { locked: true };
    st.exits.find(e => e.orig === 'up').removed = true;
    const n = newExit(); n.side.direction = 'side door'; n.to = LANE; n.return_direction = 'tavern'; n.barrier = {}; st.exits.push(n);
    st.area = 'riverton:streets';
    const ops = placeOps(x, st);
    assert.deepEqual(ops.map(o => o.op), ['set_description', 'set_expandable', 'set_fields', 'set_exit_description', 'set_travel_time', 'set_exit', 'remove_exit', 'add_exit', 'move_location']);
    assert.deepEqual(ops[2].fields, { exposure: 'outdoor' });
    assert.deepEqual(ops[5].fields, { sight: 'clear', barrier: { locked: true }, direction: 'front' });
    assert.equal(ops[7].door, true);
    const r = preview(c, ops);
    assert.equal(r.status_code, 200, JSON.stringify(r.json()));
    // Reset (dropping an own value) becomes null: inherit again.
    const x2 = { ...x, own: { ...x.own, exposure: 'outdoor' } }, st2 = initialState(x2);
    delete st2.own.exposure;
    assert.deepEqual(placeOps(x2, st2), [{ op: 'set_fields', target: TAVERN, fields: { exposure: null } }]);
    // A new exit with no destination is a problem, not an op.
    const st3 = initialState(x); const n3 = newExit(); n3.side.direction = 'hole'; st3.exits.push(n3);
    assert.deepEqual(placeOps(x, st3), []);
    assert.ok(formProblems(x, st3).some(p => /destination/.test(p)));
    st3.own.name = ''; assert.ok(formProblems(x, st3).some(p => /Name/.test(p)));
});

test('area form diff: update_area for name/notes, set_fields for settings, set_expandable', () => {
    const c = client(RIVERTON), x = ctxOf(c, 'sub:riverton:drowned_rat'), st = initialState(x);
    st.own.name = 'The Rat'; st.own.stays_open = true; delete st.own.insulation; st.own.expandable = false;
    const ops = areaOps(x, st);
    assert.deepEqual(ops, [{ op: 'update_area', area: 'riverton:drowned_rat', name: 'The Rat' }, { op: 'set_expandable', target: 'riverton:drowned_rat', value: false },
        { op: 'set_fields', target: 'riverton:drowned_rat', fields: { stays_open: true, insulation: null } }]);
    assert.equal(preview(c, ops).status_code, 200);
});

test('set_fields / set_exit / add_exit / move_location apply, sync shared fields and validate', () => {
    const raw = loadRaw();
    const r = applyPatch(raw, { ops: [
        { op: 'set_fields', target: TAVERN, fields: { exposure: 'outdoor', inherit_region_lore: false } },
        { op: 'set_exit', loc: TAVERN, direction: 'out', fields: { sight: 'none', barrier: { locked: true }, travel_time: '2m', direction: 'front' } },
        { op: 'add_exit', loc: TAVERN, direction: 'side door', to: LANE, return_direction: 'tavern', door: true },
        { op: 'move_location', loc: YARD, area: 'riverton:streets' },
    ] });
    const t = getRoom(raw, TAVERN), sq = getRoom(raw, SQUARE);
    assert.equal(t.exposure, 'outdoor'); assert.equal(t.inherit_region_lore, false);
    const front = t.exits.find(e => e.direction === 'front'), back = sq.exits.find(e => e.to === TAVERN);
    assert.equal(front.sight, 'none'); assert.equal(back.sight, undefined, 'sight is per side');
    assert.deepEqual(front.barrier, { locked: true }); assert.equal(back.barrier, undefined, 'one door per pair');
    assert.equal(back.travel_time, '2m', 'travel time is shared');
    assert.equal(getRoom(raw, LANE).exits.find(e => e.to === TAVERN).direction, 'tavern');
    assert.ok(getRoom(raw, 'riverton:streets/courtyard') && !getRoom(raw, YARD));
    assert.equal(r.relocate[YARD], 'riverton:streets/courtyard');
    assert.ok(t.exits.some(e => e.to === 'riverton:streets/courtyard'), 'exits follow the moved room');
    applyPatch(raw, { ops: [{ op: 'set_fields', target: TAVERN, fields: { exposure: null } }] });
    assert.ok(!('exposure' in getRoom(raw, TAVERN)));
    const bad = ops => assert.throws(() => applyPatch(loadRaw(), { ops }), PatchError);
    bad([{ op: 'set_fields', target: TAVERN, fields: { name: 'x' } }]);
    bad([{ op: 'set_fields', target: TAVERN, fields: { exposure: 'wet' } }]);
    bad([{ op: 'set_fields', target: 'riverton:drowned_rat', fields: { entrance: 'nope' } }]);
    bad([{ op: 'set_exit', loc: TAVERN, direction: 'out', fields: { direction: 'up' } }]);
    bad([{ op: 'set_exit', loc: TAVERN, direction: 'out', fields: { to: SQUARE } }]);
    bad([{ op: 'add_exit', loc: TAVERN, direction: 'x', to: UP, return_direction: 'y' }]);
    bad([{ op: 'add_exit', loc: TAVERN, direction: 'x', to: LANE }]);
    bad([{ op: 'add_exit', loc: TAVERN, direction: 'x', to: TAVERN, return_direction: 'y' }]);
    bad([{ op: 'move_location', loc: TAVERN, area: 'riverton:drowned_rat' }]);
    bad([{ op: 'move_location', loc: TAVERN, area: 'larkspur:x' }]);
});

test('field specs: choices with 2-3 options are radios, 4+ dropdowns (per the form rules)', () => {
    const exp = ROOM_FIELDS.find(f => f.k === 'exposure'), ins = ROOM_FIELDS.find(f => f.k === 'insulation'), type = EXIT_FIELDS.find(f => f.k === 'type');
    assert.ok(exp.options.length >= 4 && ins.options.length === 3 && type.options.length === 2);
});

test('exit See/Hear destination: an unset open/no-door value defaults from the exit type (obscured: none)', async () => {
    const { exitLevelDefault } = await import('../../plugin/ui/placeform.mjs');
    assert.deepEqual(exitLevelDefault({ side: {}, barrier: {} }, 'sight'), { value: 'partial', from: 'default' });
    assert.equal(exitLevelDefault({ side: { type: 'open' }, barrier: null }, 'sound').value, 'clear');
    assert.equal(exitLevelDefault({ side: { obscured: true }, barrier: null }, 'sight').value, 'none');
});

test('exit sides: opposite directions, real-name labels, the way back filled in until edited', async () => {
    const { opposite, sideLabels, setDirection, setBackDirection } = await import('../../plugin/ui/placeform.mjs');
    assert.equal(opposite('north'), 'south'); assert.equal(opposite('Up'), 'Down'); assert.equal(opposite('out'), 'in'); assert.equal(opposite('trapdoor'), '');
    assert.deepEqual(sideLabels('Common Room', 'Cellar'), { there: 'From Common Room, go ___ to reach Cellar', back: 'From Cellar, go ___ to get back' });
    const e = newExit();
    setDirection(e, 'east'); assert.equal(e.back.direction, 'west');
    setBackDirection(e, 'bar'); setDirection(e, 'north'); assert.equal(e.back.direction, 'bar');
});

test('edit form: the way back is edited on the destination, by its own direction, renamed last', () => {
    const c = client(RIVERTON), x = ctxOf(c, TAVERN), s = initialState(x);
    const out = s.exits.find(e => e.orig === 'out');
    assert.equal(out.back_orig, 'in'); assert.ok(out.back.description);
    out.back.description = 'Back inside, under the swinging sign.'; out.back.sight = 'none'; out.back.direction = 'tavern';
    const ops = placeOps(x, s);
    assert.deepEqual(ops.find(o => o.op === 'set_exit_description'), { op: 'set_exit_description', loc: SQUARE, direction: 'in', text: 'Back inside, under the swinging sign.' });
    const se = ops.find(o => o.op === 'set_exit' && o.loc === SQUARE);
    assert.deepEqual(se.fields, { sight: 'none', direction: 'tavern' });
    assert.equal(Object.keys(se.fields).at(-1), 'direction');
    const r = preview(c, ops); assert.equal(r.status_code, 200, JSON.stringify(r.json()));
});

test('create place: the Edit place form, empty; Submit makes create_place plus what it cannot carry', () => {
    const c = client(RIVERTON), x = ctxOf(c, 'new:riverton:drowned_rat');
    assert.equal(x.create, true); assert.equal(x.kind, 'room'); assert.deepEqual(x.own, {}); assert.deepEqual(x.exits, []);
    assert.equal(x.inherited.exposure.value, 'sheltered'); assert.ok(x.parent_notes.length);
    const s = initialState(x);
    assert.ok(formProblems(x, s).some(p => /Name/.test(p)) && formProblems(x, s).some(p => /at least one exit/.test(p)));
    s.own.name = 'Common Room'; s.own.description = 'Another one.'; s.own.exposure = 'outdoor';
    const e = newExit(); e.to = TAVERN; setDirection(e, 'north'); e.side.hidden = true; e.back.sight = 'none'; e.barrier = { locked: true }; s.exits.push(e);
    assert.deepEqual(formProblems(x, s), []);
    const ops = placeOps(x, s);
    assert.equal(ops[0].op, 'create_place'); assert.equal(ops[0].id, 'common_room_2', 'a free id');
    assert.deepEqual(ops[0].exits, [{ direction: 'north', to: TAVERN, return_direction: 'south', door: true }]);
    const a = 'riverton:drowned_rat/common_room_2';
    assert.ok(ops.some(o => o.op === 'set_fields' && o.target === a && o.fields.exposure === 'outdoor'));
    assert.ok(ops.some(o => o.op === 'set_exit' && o.loc === a && o.fields.hidden === true && o.fields.barrier.locked === true));
    assert.ok(ops.some(o => o.op === 'set_exit' && o.loc === TAVERN && o.direction === 'south' && o.fields.sight === 'none'));
    const r = preview(c, ops); assert.equal(r.status_code, 200, JSON.stringify(r.json()));
});
