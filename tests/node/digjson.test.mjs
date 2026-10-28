// Breaking through: one JSON answer, connecting to an existing nearby place or making a new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
const { readDigAnswer, digOptions, roomOptions } = await import('../../extension/index.js');
const loc = { name: 'Upstairs Rooms', exits: [{ direction: 'down' }] };
const rooms = [{ address: 'r:s/square', name: 'Village Square', display_name: 'Village Square (Streets)', summary: 'Busy.' },
    { address: 'r:t/cellar', name: 'Cellar', display_name: 'Cellar (Tavern)', summary: 'Dark.' }];
const opts = digOptions(rooms);
test('place keys are short names; the area only when two places share a name', () => {
    assert.deepEqual(opts.map(o => o.key), ['village_square', 'cellar']);
    const dup = roomOptions([{ name: 'Cellar', display_name: 'Cellar (Tavern)', summary: '' }, { name: 'Cellar', display_name: 'Cellar (Temple)', summary: '' }]);
    assert.deepEqual(dup.map(o => o.key), ['cellar_tavern', 'cellar_temple']);
});
test('connect to an existing place, matched leniently; default return name; only a clear "stay" stays', () => {
    const r = readDigAnswer({ existing: 'The Village Square', direction: 'Window', then: 'go through' }, { loc, opts, canNew: true });
    assert.equal(r.ok, true); assert.equal(r.dest.room.address, 'r:s/square'); assert.equal(r.direction, 'window'); assert.equal(r.back, 'back'); assert.equal(r.stay, false);
    assert.equal(readDigAnswer({ existing: 'cellar', direction: 'hole', return_direction: 'hole', then: 'stay' }, { loc, opts, canNew: false }).stay, true);
});
test('a new place: name tidied, description gets a full stop', () => {
    const r = readDigAnswer({ new: { name: 'dusty crawl space', description: 'A cramped crawlspace full of cobwebs' }, direction: 'hole' }, { loc, opts, canNew: true });
    assert.deepEqual(r.dest, { name: 'Dusty Crawl Space', description: 'A cramped crawlspace full of cobwebs.' });
});
test('errors (sent back on the retry): not expandable, unknown key, taken exit, not JSON', () => {
    assert.match(readDigAnswer({ new: { name: 'Hole', description: 'A hole in the ground.' }, direction: 'hole' }, { loc, opts, canNew: false }).error, /no new place/);
    assert.match(readDigAnswer({ existing: 'the moon', direction: 'up' }, { loc, opts, canNew: true }).error, /place keys: village_square, cellar/);
    assert.match(readDigAnswer({ existing: 'cellar', direction: 'down' }, { loc, opts, canNew: true }).error, /already an exit "down"/);
    assert.match(readDigAnswer('banana', { loc, opts, canNew: true }).error, /not a JSON object/);
});
