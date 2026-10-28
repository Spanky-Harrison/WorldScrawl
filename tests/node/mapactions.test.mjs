// Map-level actions (PR B): create region / subregion / place, delete with cascade, move places and subregions
// (id clashes prompt, never overwrite; moves leave redirects like merges), merge-by-moving, and the AI expand context.
import './useprompts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { applyPatch, getRoom, PatchError, suggestId, idClash } from '../../plugin/ui/patches.mjs';
import { build_world, read_world_raw } from '../../plugin/world.mjs';
import { expandPrompt } from '../../plugin/ui/placeform.mjs';

const W2 = RIVERTON; // Riverton + Larkspur
const raw2 = () => read_world_raw(W2)[1], wj = () => read_world_raw(W2)[0];
const apply = (ops, raw = raw2()) => { const r = applyPatch(raw, { ops }, { world: wj() }); build_world(wj(), raw); return [raw, r]; };
const bad = (ops, re) => assert.throws(() => apply(ops), e => e instanceof PatchError && (!re || re.test(e.message)), re && String(re));
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'p1', note: 'test', at: 0, ops, ...extra });
const LANE = 'riverton:streets/market_lane';

const ROAD = 'riverton:east_road/road';

test('create place: needs an exit to an existing place; exits come with their way back; clashes suggest an id', () => {
    const [raw] = apply([{ op: 'create_place', area: 'riverton:streets', name: 'Old Well', description: 'A mossy well.', exits: [{ direction: 'square', to: SQUARE, return_direction: 'well' }] }]);
    const a = 'riverton:streets/old_well';
    assert.equal(getRoom(raw, a).exits[0].to, SQUARE);
    assert.ok(getRoom(raw, SQUARE).exits.some(e => e.to === a && e.direction === 'well'));
    bad([{ op: 'create_place', area: 'riverton:streets', name: 'Old Well', description: 'x', exits: [] }], /at least one exit/);
    bad([{ op: 'create_place', area: 'riverton:streets', name: 'Square', description: 'x', exits: [{ direction: 'a', to: LANE, return_direction: 'b' }] }], /suggested: "square_2"/);
});

test('create subregion and region: the wizard chain (region -> first subregion -> starting place)', () => {
    const [raw] = apply([{ op: 'create_subregion', region: 'riverton', name: 'Mill Yard', notes: 'Flour dust.', place: { name: 'Mill', description: 'A creaking mill.', exits: [{ direction: 'lane', to: LANE, return_direction: 'mill' }] } }]);
    assert.ok(getRoom(raw, 'riverton:mill_yard/mill'));
    assert.equal(raw.riverton.subregions.mill_yard.notes, 'Flour dust.');
    bad([{ op: 'create_subregion', region: 'riverton', name: 'Mill Yard', place: { name: 'Mill', description: 'x', exits: [] } }], /at least one exit/);
    bad([{ op: 'create_subregion', region: 'riverton', name: 'Streets', place: { name: 'M', description: 'x', exits: [{ direction: 'a', to: LANE, return_direction: 'b' }] } }], /suggested: "streets_2"/);
    const [r2] = apply([{ op: 'create_region', name: 'Fen Marsh', notes: 'Wet.', subregion: { name: 'Reeds', place: { name: 'Reed Hut', description: 'A hut on stilts.', exits: [{ direction: 'road', to: ROAD, return_direction: 'fen' }] } } }]);
    assert.equal(r2.fen_marsh.start, 'reeds/reed_hut');
    assert.ok(getRoom(r2, ROAD).exits.some(e => e.to === 'fen_marsh:reeds/reed_hut'));
    const [r3] = apply([{ op: 'create_region', name: 'Isle', subregion: { name: 'Shore', place: { name: 'Beach', description: 'Sand.' } } }]);
    assert.ok(getRoom(r3, 'isle:shore/beach'), 'a region\'s starting place may stand alone');
    bad([{ op: 'create_region', name: 'Larkspur', subregion: { name: 'A', place: { name: 'B', description: 'c' } } }], /suggested: "larkspur_2"/);
});

test('delete: the last place takes its subregion, the last subregion its region; the start region never goes', () => {
    let [raw, r] = apply([{ op: 'remove_location', loc: 'larkspur:bindery/shop' }]);
    assert.ok(!raw.larkspur.subregions.bindery);
    assert.match(r.summary.join(' '), /Sable's Bindery deleted with it/);
    assert.ok(getRoom(raw, r.relocate['larkspur:bindery/shop']));
    [raw, r] = apply([{ op: 'create_region', name: 'Isle', subregion: { name: 'Shore', place: { name: 'Beach', description: 'Sand.' } } }, { op: 'remove_location', loc: 'isle:shore/beach' }]);
    assert.ok(!raw.isle);
    bad([{ op: 'remove_area', area: 'riverton', contents: 'delete' }], /starting region/);
    bad([{ op: 'remove_location', loc: 'riverton:smithy/forge' }, { op: 'remove_location', loc: 'riverton:general_store/shop' }, { op: 'remove_area', area: 'riverton:streets', contents: 'delete' }, { op: 'remove_area', area: 'riverton:drowned_rat', contents: 'delete' }, { op: 'remove_area', area: 'riverton:gilded_goose', contents: 'delete' }, { op: 'remove_area', area: 'riverton:docks', contents: 'delete' }, { op: 'remove_area', area: 'riverton:temple', contents: 'delete' }, { op: 'remove_area', area: 'riverton:secret_tunnel', contents: 'delete' }, { op: 'remove_area', area: 'riverton:east_road', contents: 'delete' }], /starting region/);
    [raw, r] = apply([{ op: 'remove_area', area: 'riverton:temple', contents: 'delete' }]);
    assert.ok(!raw.riverton.subregions.temple);
    assert.ok(getRoom(raw, r.relocate['riverton:temple/nave']));
    [raw] = apply([{ op: 'remove_area', area: 'larkspur', contents: 'delete' }]);
    assert.ok(!raw.larkspur && !getRoom(raw, ROAD).exits.some(e => e.to.startsWith('larkspur:')));
});

test('delete with move = merge containers: all places to another subregion, all subregions to another region', () => {
    let [raw, r] = apply([{ op: 'remove_area', area: 'riverton:smithy', contents: 'move', into: 'riverton:streets' }]);
    assert.ok(!raw.riverton.subregions.smithy && getRoom(raw, 'riverton:streets/forge'));
    assert.equal(r.relocate['riverton:smithy/forge'], 'riverton:streets/forge');
    bad([{ op: 'remove_area', area: 'riverton:gilded_goose', contents: 'move', into: 'riverton:drowned_rat' }], /suggested: "gilded_goose_common_room"/);
    [raw] = apply([{ op: 'remove_area', area: 'riverton:gilded_goose', contents: 'move', into: 'riverton:drowned_rat', ids: { common_room: 'goose_common', upstairs: 'goose_upstairs' } }]);
    assert.ok(getRoom(raw, 'riverton:drowned_rat/goose_common') && getRoom(raw, TAVERN).description !== getRoom(raw, 'riverton:drowned_rat/goose_common').description);
    [raw, r] = apply([{ op: 'remove_area', area: 'larkspur', contents: 'move', into: 'riverton' }]);
    assert.ok(!raw.larkspur && getRoom(raw, 'riverton:green/green') && getRoom(raw, 'riverton:baths/pool'));
    assert.equal(r.relocate['larkspur:baths/pool'], 'riverton:baths/pool');
    assert.ok(getRoom(raw, ROAD).exits.some(e => e.to === 'riverton:west_road/road'));
});

test('move: places and subregions; a clash refuses with a suggested id and never overwrites', () => {
    bad([{ op: 'move_location', loc: TAVERN, area: 'riverton:gilded_goose' }], /suggested: "drowned_rat_common_room"/);
    let [raw, r] = apply([{ op: 'move_location', loc: TAVERN, area: 'riverton:gilded_goose', id: 'drowned_rat_common_room' }]);
    assert.equal(getRoom(raw, 'riverton:gilded_goose/common_room').name, raw2().riverton.subregions.gilded_goose.locations.common_room.name, 'the old one is untouched');
    assert.equal(r.relocate[TAVERN], 'riverton:gilded_goose/drowned_rat_common_room');
    assert.ok(getRoom(raw, SQUARE).exits.some(e => e.to === 'riverton:gilded_goose/drowned_rat_common_room'));
    [raw, r] = apply([{ op: 'move_location', loc: SQUARE, area: 'larkspur:green' }]);
    assert.ok(getRoom(raw, 'larkspur:green/square'));
    const mk = { op: 'create_subregion', region: 'larkspur', name: 'Streets', place: { name: 'Gate', description: 'x', exits: [{ direction: 'a', to: 'larkspur:green/green', return_direction: 'b' }] } };
    bad([mk, { op: 'move_area', area: 'riverton:streets', region: 'larkspur' }], /suggested: "riverton_streets"/);
    [raw, r] = apply([mk, { op: 'move_area', area: 'riverton:streets', region: 'larkspur', id: 'riverton_streets' }]);
    assert.ok(getRoom(raw, 'larkspur:riverton_streets/square') && getRoom(raw, 'larkspur:streets/gate'));
    assert.equal(r.relocate[LANE], 'larkspur:riverton_streets/market_lane');
    assert.deepEqual(idClash(raw2(), 'room', 'riverton:gilded_goose', 'common_room', 'drowned_rat'), { id: 'common_room', taken: true, suggest: 'drowned_rat_common_room' });
    assert.equal(suggestId(new Set(['a', 'x_a']), 'a', 'x'), 'a_2');
});

test('move redirects: old addresses resolve to the new one; turning the move off removes the redirect', () => {
    const c = client(W2);
    const res = (address, changes) => c.post('/resolve', { json: { address, changes } }).json();
    const mv = patch([{ op: 'move_area', area: 'riverton:smithy', region: 'larkspur' }]);
    assert.deepEqual([res('riverton:smithy/forge', [mv]).address, res('riverton:smithy/forge', [mv]).how], ['larkspur:smithy/forge', 'merged']);
    assert.deepEqual([res('riverton:smithy/forge', [{ ...mv, off: true }]).address, res('riverton:smithy/forge', [{ ...mv, off: true }]).how], ['riverton:smithy/forge', 'here']);
    const pl = patch([{ op: 'move_location', loc: YARD, area: 'riverton:streets' }]);
    assert.equal(res(YARD, [pl]).address, 'riverton:streets/courtyard');
    assert.equal(res(YARD, [{ ...pl, off: true }]).address, YARD);
    const pv = c.post('/patch/preview', { json: { patch: { ops: [{ op: 'move_location', loc: TAVERN, area: 'riverton:gilded_goose' }] }, changes: [] } });
    assert.equal(pv.status_code, 400);
    assert.deepEqual(pv.json().detail.clash, { kind: 'room', id: 'common_room', suggest: 'drowned_rat_common_room' });
});

test('a turned-off or failing move sends whoever stands at its new address back to the original one (synthetic)', () => {
    const c = client(W2);
    const res = (address, changes) => c.post('/resolve', { json: { address, changes } }).json();
    const ops = [{ op: 'move_area', area: 'riverton:smithy', region: 'larkspur' }];
    const pv = c.post('/patch/preview', { json: { patch: { ops }, changes: [] } }).json();
    const mv = { ...patch(ops), relocate: pv.relocate };
    assert.equal(res('larkspur:smithy/forge', [mv]).how, 'here');
    const off = res('larkspur:smithy/forge', [{ ...mv, off: true }]);
    assert.deepEqual([off.address, off.how], ['riverton:smithy/forge', 'restored']);
});

test('outline lists every container; Expand with AI sees only parent notes and the exits\' neighbors', () => {
    const c = client(W2);
    const o = c.post('/edit/outline', { json: { changes: [] } }).json();
    assert.deepEqual(o.regions.map(r => r.id).sort(), ['larkspur', 'riverton']);
    assert.ok(o.regions.find(r => r.id === 'larkspur').subregions.find(s => s.id === 'green').rooms.some(x => x.address === 'larkspur:green/green'));
    const a = c.post('/edit/ai-context', { json: { area: 'riverton:drowned_rat', rooms: [SQUARE], changes: [] } }).json();
    assert.equal(a.subregion.name, 'The Drowned Rat'); assert.equal(a.region.name, 'Riverton');
    assert.deepEqual(a.neighbors.map(n => n.name), [getRoom(raw2(), SQUARE).name]);
    assert.ok(a.neighbors[0].short.length <= 200);
    const p = expandPrompt(a, { field: 'description', text: 'smoky bar', name: 'Common Room', kind: 'room' });
    assert.ok(p.includes('smoky bar') && p.includes(a.neighbors[0].name) && p.includes('Riverton'));
    assert.ok(!p.includes('Larkspur') && !p.includes('Temple of the Tides'), 'never the whole world');
});

test('wizard helpers: last-item cascade and clash suggestions come from the outline', async () => {
    const { cascadeOf, clashes, actionsFor } = await import('../../plugin/ui/mapactions.mjs');
    const o = client(W2).post('/edit/outline', { json: { changes: [] } }).json();
    assert.deepEqual(cascadeOf(o, 'room', 'riverton:smithy/forge'), { container: "Brask's Smithy", area: 'riverton:smithy', kind: 'subregion', also: null });
    assert.equal(cascadeOf(o, 'room', TAVERN), null);
    assert.equal(cascadeOf(o, 'subregion', 'riverton:smithy'), null);
    assert.deepEqual(clashes(['common_room', 'upstairs', 'attic'], ['common_room', 'upstairs', 'cellar'], 'gilded_goose'),
        [{ id: 'common_room', suggest: 'gilded_goose_common_room' }, { id: 'upstairs', suggest: 'gilded_goose_upstairs' }]);
    assert.deepEqual(actionsFor('subregion').map(a => a[1]), ['Create place', 'Merge places', 'Move subregion', 'Delete subregion']);
    assert.deepEqual(actionsFor('world').map(a => a[0]), ['create_region']);
});
