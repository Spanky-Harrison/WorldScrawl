// Duplicate-room guard: a "new" place that closely matches a place within about 3 steps connects to that place instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
const ext = await import('../../extension/index.js');

test('closeName: same words, articles, plurals and one typo match; different rooms do not', () => {
    for (const [a, b] of [['The Cellar', 'cellar'], ['Wine Cellars', 'wine cellar'], ['Guest Room, East', 'East Guest Room'], ['Library', 'Libary'], ['Courtyard', 'the courtyard']]) assert.ok(ext.closeName(a, b), `${a} ~ ${b}`);
    for (const [a, b] of [['East Guest Room', 'West Guest Room'], ['Guest Room', 'Guest Room 2'], ['Cellar', 'Wine Cellar'], ['Hall', 'Hill'], ['', 'Hall']]) assert.ok(!ext.closeName(a, b), `${a} !~ ${b}`);
});
test('duplicatePlace: the nearest match within 3 steps', () => {
    const rooms = [{ address: 'r:a/c2', name: 'Cellar', steps: 3 }, { address: 'r:a/c1', name: 'The Cellar', steps: 2 }, { address: 'r:a/far', name: 'Cellar', steps: 4 }];
    assert.equal(ext.duplicatePlace('cellar', rooms).address, 'r:a/c1');
    assert.equal(ext.duplicatePlace('cellar', [rooms[2]]), null, 'beyond 3 steps');
    assert.equal(ext.duplicatePlace('Attic', rooms), null);
});
test('mergeDuplicates: a create_place for a nearby place becomes its door pair; new:<ref> points at it', () => {
    const rooms = [{ address: 'r:inn/cellar', name: 'Cellar', steps: 2 }];
    const ops = [{ op: 'create_place', ref: 'c', name: 'The Cellar', description: 'Dark.', exits: [{ to: 'r:inn/hall', direction: 'up', return_direction: 'down', door: true }] },
        { op: 'set_fields', target: 'new:c', fields: { description: 'Flooded.' } }, { op: 'create_place', name: 'Attic', description: 'Dusty.', exits: [{ to: 'r:inn/hall', direction: 'down', return_direction: 'up' }] }];
    const r = ext.mergeDuplicates(ops, rooms);
    assert.deepEqual(r.merged, [{ name: 'The Cellar', to: 'r:inn/cellar', to_name: 'Cellar', steps: 2 }]);
    assert.deepEqual(r.ops[0], { op: 'add_exit', loc: 'r:inn/cellar', to: 'r:inn/hall', direction: 'up', return_direction: 'down', door: true });
    assert.equal(r.ops[1].target, 'r:inn/cellar');
    assert.equal(r.ops[2].op, 'create_place', 'other new rooms stay');
    assert.equal(ext.mergeDuplicates(ops, []).ops, ops, 'nothing nearby: unchanged');
});
