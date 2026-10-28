import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { resolvePosition } from '../../plugin/position.mjs';
import { build_world, read_world_raw } from '../../plugin/world.mjs';

const c = client(RIVERTON);
const patch = (ops, extra = {}) => ({ type: 'patch', id: 'p1', note: 'test', at: 0, ops, ...extra });
const resolve = (address, changes = [], extra = {}) => { const r = c.post('/resolve', { json: { address, changes, ...extra } }); assert.equal(r.status_code, 200); return r.json(); };
const exists = (a, changes = [], now) => c.post('/rooms', { json: { addresses: [a], changes, now } }).json();
const MERGED = 'riverton:drowned_rat/burnt_inn';
const merge = (extra = {}) => patch([{ op: 'merge', locs: [TAVERN, YARD], id: 'burnt_inn', name: 'Burnt Inn', description: 'Ash and beams.', ...extra }]);

test('resolver: an existing room stays put', () => {
    assert.deepEqual([resolve(TAVERN).address, resolve(TAVERN).moved, resolve(TAVERN).how], [TAVERN, false, 'here']);
});
test('resolver: a removed room moves the party to a surviving room', () => {
    const r = resolve(YARD, [patch([{ op: 'remove_location', loc: YARD }])]);
    assert.equal(r.moved, true); assert.notEqual(r.address, YARD); assert.match(r.how, /merged|neighbor/);
});
test('resolver: a merged room follows the merge redirect', () => {
    const r = resolve(YARD, [merge()]);
    assert.deepEqual([r.address, r.how, r.name], [MERGED, 'merged', 'Burnt Inn']);
});
test('resolver: an expired temporary merge puts the party back in an original room (#47)', () => {
    const r = resolve(MERGED, [merge({ lasts: '1h' })], { now: 999999 });
    assert.equal(r.how, 'restored'); assert.ok([TAVERN, YARD].includes(r.address));
});
test('resolver: an expired temporary removal keeps the restored room', () => {
    assert.equal(resolve(YARD, [patch([{ op: 'remove_location', loc: YARD, lasts: '1h' }])], { now: 999999 }).address, YARD);
});
test('resolver: while a temporary removal is active the party is moved out', () => {
    assert.notEqual(resolve(YARD, [patch([{ op: 'remove_location', loc: YARD, lasts: '1h' }])], { now: 10 }).address, YARD);
});
test('resolver: a swiped/deleted change that made the room falls back to the subregion entrance', () => {
    const r = resolve(MERGED, []);
    assert.equal(r.how, 'subregion'); assert.equal(r.address.split('/')[0], 'riverton:drowned_rat');
});
test('resolver: exits of the previous map state lead to a surviving neighbour', () => {
    // A room added then removed without a redirect: its old exits point somewhere real.
    const w = build_world(...read_world_raw(RIVERTON));
    const fake = { locations: new Map([['riverton:streets/kiosk', { exits: [{ to: SQUARE }] }]]) };
    const r = resolvePosition(w, 'riverton:streets/kiosk', { before: a => (a === 'riverton:streets/kiosk' ? fake : null) });
    assert.deepEqual([r.address, r.how], [SQUARE, 'neighbor']);
});
test('resolver: unknown subregion falls back to the region entrance, unknown region to the start', () => {
    const w = build_world(...read_world_raw(RIVERTON));
    assert.equal(resolve('riverton:nowhere/void').how, 'region');
    assert.equal(resolve('riverton:nowhere/void').address, w.regions.get('riverton').entrance);
    assert.deepEqual([resolve('atlantis:x/y').address, resolve('atlantis:x/y').how], [w.start, 'start']);
});
test('resolver: an active move redirects forward even for a position stamped after it (e.g. while it was off)', () => {
    const ch = [{ ...merge(), _msg: 2 }];
    assert.equal(resolve(YARD, ch, { since: 5 }).how, 'merged');
});
test('resolver: swiping away the change that made the room walks back the move history', () => {
    const r = resolve(MERGED, [], { history: ['riverton:gone/x', SQUARE, TAVERN] });
    assert.deepEqual([r.address, r.how], [SQUARE, 'history']);
});
