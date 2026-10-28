import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registryProblems } from '../../plugin/ui/menus.mjs';
import { lineDiff, missingPlaceholders, unknownPlaceholders } from '../../plugin/ui/prompteditor.mjs';

test('menu registry checks items', () => {
    assert.deepEqual(registryProblems([{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', toggle: true, checked: () => true, set() {} }]), []);
    assert.equal(registryProblems([{ id: 'a', label: 'A' }, { id: 'a', label: 'A', open() {} }]).length, 2);
});
test('app.js registers Tools > Prompt Editor and the two Debug items', () => {
    const src = fs.readFileSync(new URL('../../plugin/ui/app.js', import.meta.url), 'utf8');
    assert.match(src, /id: 'prompts', label: 'Prompt Editor'/);
    assert.match(src, /label: 'Show map edit messages', toggle: true/);
    assert.match(src, /label: 'Reveal map'/);
    assert.match(src, /querySelector\('\.brand'\)\.after\(buildMenu\('tools'/);
});
test('extension handles the Debug messages and the new setting', () => {
    const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    assert.match(src, /showEditMessages: false/);
    assert.match(src, /type === 'reveal'[\s\S]{0,300}revealPlaces/);
    assert.match(src, /type === 'set_debug'/);
});
test('missing and unknown placeholders', () => {
    const e = { placeholders: [{ name: 'a' }, { name: 'b', optional: true }, { name: 'edit_types', generated: true }] };
    assert.deepEqual(missingPlaceholders(e, '{{a}}'), ['edit_types']);
    assert.deepEqual(missingPlaceholders(e, '{{a}} {{edit_types}}'), []);
    assert.deepEqual(unknownPlaceholders(e, '{{a}} {{zz}}'), ['zz']);
});
test('line diff', () => {
    assert.deepEqual(lineDiff('a\nb', 'a\nc').map(d => d.op + d.line), [' a', '-b', '+c']);
    assert.deepEqual(lineDiff('same', 'same').map(d => d.op), [' ']);
});
