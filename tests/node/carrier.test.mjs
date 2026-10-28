import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierText } from '../../plugin/ui/patchform.mjs';
test('carrier line: several changes read as a count', () => {
    assert.equal(carrierText([{ summary: ['a'] }, { summary: ['b'] }, { summary: ['c'] }]), 'Map update (3 changes)');
});
test('carrier line: one change reads as its summary', () => {
    const t = carrierText([{ summary: ['renamed hall'] }]);
    assert.match(t, /renamed hall/);
    assert.doesNotMatch(t, /changes\)/);
});
