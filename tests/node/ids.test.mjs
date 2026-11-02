// The shared name-to-id rule (plugin/shared/ids.mjs) and the ids built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../../plugin/shared/ids.mjs';
import { NPC_ID, freeId } from '../../plugin/shared/npc.mjs';
import { slugify } from '../../plugin/server.mjs';

test('slug: apostrophes are dropped, not turned into a separator', () => {
    for (const n of ["Hesk's Room", 'Hesk\u2019s Room', 'Hesk\u2018s Room']) assert.equal(slug(n), 'hesks-room', n);
    assert.equal(freeId("Marlow's General Store"), 'marlows-general-store');
    assert.equal(slugify("Marlow's World"), 'marlows-world');
});

test('slug: length limit cuts, then trims a separator left at the end', () => {
    const name = `${'a'.repeat(47)} ${'b'.repeat(10)}`; // the cut at 48 lands just after the separator
    assert.equal(slug(name, { max: 48 }), 'a'.repeat(47));
    const id = freeId(name);
    assert.equal(id, 'a'.repeat(47));
    assert.ok(NPC_ID.test(id));
    assert.ok(slugify('x'.repeat(80)).length <= 48);
    assert.equal(slug('word '.repeat(30)), `${'word-'.repeat(29)}word`); // no limit by default
});

test('slug: fallback when nothing is left', () => {
    assert.equal(slug('!!!'), '');
    assert.equal(slug(null, { fallback: 'x' }), 'x');
    assert.equal(freeId('???'), 'npc');
    assert.equal(freeId(''), 'npc');
    assert.equal(slugify('  ---  '), 'world');
    assert.equal(freeId('Tam', new Set(['tam', 'tam-2'])), 'tam-3');
});
