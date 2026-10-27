import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { read_world_raw } from '../../plugin/world.mjs';

const c = client(RIVERTON);
const MERGED = 'riverton:drowned_rat/burnt_inn';
const patch = (id, _msg, ops) => ({ type: 'patch', id, note: id, at: 0, ops, _msg });
const chain = () => [
    patch('merge', 3, [{ op: 'merge', locs: [TAVERN, YARD], id: 'burnt_inn', name: 'Burnt Inn', description: 'Ash.' }]),
    patch('soot', 5, [{ op: 'set_description', loc: MERGED, text: 'Soot everywhere.' }]),
    patch('square', 7, [{ op: 'set_description', loc: SQUARE, text: 'Quiet square.' }]),
    patch('sign', 9, [{ op: 'append_notes', area: 'riverton:drowned_rat', text: 'Burned down.' }]),
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
