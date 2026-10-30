// The shared patch editor's serialization / checks, and the live (patched) inspector rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, TAVERN } from './helpers.mjs';
import { cleanOp, formOps, checkOps, errorsByOp, blankOp, liveOps, editLine, OP_FIELDS } from '../../plugin/ui/patchform.mjs';
import { OPS } from '../../plugin/ui/patches.mjs';

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
