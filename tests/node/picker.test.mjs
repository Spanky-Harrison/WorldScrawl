import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEntries, pickValid, pickSearch, pathOf } from '../../plugin/ui/picker.mjs';

const outline = { regions: [
    { id: 'coast', name: 'Coast', subregions: [
        { id: 'village', area: 'coast:village', name: 'Village', rooms: [{ id: 'square', address: 'coast:village/square', name: 'Village Square' }, { id: 'inn', address: 'coast:village/inn', name: 'Drowned Rat' }] },
        { id: 'temple', area: 'coast:temple', name: 'Temple', rooms: [{ id: 'hall', address: 'coast:temple/hall', name: 'Hall' }] }] },
    { id: 'hills', name: 'Hills', subregions: [{ id: 'empty', area: 'hills:empty', name: 'Empty Vale', rooms: [] }] }] };

test('entries carry full paths per kind', () => {
    assert.deepEqual(pickEntries(outline, 'region').map(e => e.path), ['Coast', 'Hills']);
    assert.deepEqual(pickEntries(outline, 'subregion').map(e => e.id), ['coast:village', 'coast:temple', 'hills:empty']);
    assert.equal(pathOf(outline, 'room', 'coast:village/inn'), 'Coast › Village › Drowned Rat');
    assert.equal(pathOf(outline, 'subregion', 'hills:empty'), 'Hills › Empty Vale');
});
test('valid: right kind, not excluded, in allowed', () => {
    const spec = { kind: 'room', outline, exclude: ['coast:village/square'] };
    assert.equal(pickValid(spec, 'coast:village/inn'), true);
    assert.equal(pickValid(spec, 'coast:village/square'), false);
    assert.equal(pickValid(spec, 'coast:village'), false); // a subregion is the wrong kind
    assert.equal(pickValid({ ...spec, allowed: ['coast:temple/hall'] }, 'coast:village/inn'), false);
});
test('search matches words across the path, best names first', () => {
    const spec = { kind: 'room', outline, exclude: ['coast:temple/hall'] };
    assert.deepEqual(pickSearch(spec, 'village').map(r => r.path), ['Coast › Village › Village Square', 'Coast › Village › Drowned Rat']);
    assert.equal(pickSearch(spec, 'hall')[0].valid, false);
    assert.deepEqual(pickSearch(spec, ''), []);
    assert.deepEqual(pickSearch({ kind: 'subregion', outline }, 'vale').map(r => r.id), ['hills:empty']);
});
