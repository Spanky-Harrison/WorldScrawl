import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveGroups, inheritLine } from '../../plugin/ui/diffview.mjs';

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
    const n = { kind: 'region', from: 'Larkspur', to: 'Riverton', changed: ['notes', 'climate'] };
    const { groups } = moveGroups({ ops: [{ op: 'remove_area', area: 'l', contents: 'move', into: 'r' }],
        relocate: { 'l:s1/a': 'r:s1/a', 'l:s2/b': 'r:s2/b' }, inherit: { 'l:s1/a': n, 'l:s2/b': n } });
    assert.equal(groups.length, 1); assert.equal(groups[0].items.length, 2);
    assert.ok(groups[0].note); assert.ok(groups[0].items.every(i => !i.note));
});
test('inheritance line names only the differing categories', () => {
    const t = inheritLine({ kind: 'region', from: 'Larkspur', to: 'Riverton', changed: ['notes', 'climate'] });
    assert.match(t ?? '', /Riverton/); assert.match(t ?? '', /notes/); assert.match(t ?? '', /Larkspur/);
});
