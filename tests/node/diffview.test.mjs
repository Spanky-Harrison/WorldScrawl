// The red/green before/after view's pure builders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN } from './helpers.mjs';
import { blockDiff, fieldDiffs, mergeLines, exitState } from '../../plugin/ui/diffview.mjs';

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
