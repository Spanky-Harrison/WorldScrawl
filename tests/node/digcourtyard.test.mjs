// Knarfy's riverton playtest: "I break open the window, opening a precarious passage to the courtyard." in the Drowned Rat
// upstairs room. The named courtyard must be linked (never a new area), and a failure must be told plainly to the narrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
import './useprompts.mjs';
import { client, RIVERTON, YARD } from './helpers.mjs';
const ext = await import('../../extension/index.js');
const UP = 'riverton:drowned_rat/upstairs';
const SAID = 'I break open the window, opening a precarious passage to the courtyard.';
const c = client(RIVERTON);
const rooms = c.post('/nearby', { json: { from: UP, depth: 3, limit: 12 } }).json().rooms;
const opts = ext.digOptions(rooms.filter(r => r.address !== UP));
const up = c.get(`/location/${UP}`).json(), yard = c.get(`/location/${YARD}`).json();

test('the courtyard is within the 3-step radius and offered', () => {
    assert.ok(opts.some(o => o.room.address === YARD), JSON.stringify(opts.map(o => o.key)));
});
test('a place the player names is matched and preferred', () => {
    assert.equal(ext.namedPlace(SAID, opts)?.room.address, YARD);
    assert.equal(ext.namedPlace('I smash the wall', opts), null);
    assert.equal(ext.digWordFrom(SAID), 'window');
});
test('a return name the courtyard already uses ("in") is swapped for a free one, not a failure', () => {
    assert.ok(yard.exits.some(e => e.direction === 'in'));
    const key = opts.find(o => o.room.address === YARD).key;
    const r = ext.readDigAnswer({ existing: key, direction: 'window', return_direction: 'in', then: 'go_through' }, { loc: up, opts, canNew: false, target: yard });
    assert.equal(r.ok, true, r.error); assert.equal(r.dest.room.address, YARD); assert.equal(r.back, 'window');
    assert.ok(!yard.exits.some(e => e.direction === r.back));
});
test('a named existing place never becomes a new one', () => {
    assert.match(ext.readDigAnswer({ new: { name: 'Back Courtyard', description: 'A muddy little yard.' }, direction: 'window' }, { loc: up, opts, canNew: false }).error, /no new place/);
});
test('a failed break-through is told plainly to the narrator, outranking other notes', () => {
    const t = ext.factsText(up, null, false, { digFailed: true, look: { kind: 'window', what: 'x' }, newDoor: true });
    assert.match(t, /FAILED: nothing gave way\. No new opening or passage exists/);
    assert.match(t, /do not flag a map change or a new room/);
});
test('after a failed break-through the reply cannot add a room or passage', () => {
    const chat = [{ is_user: true, mes: SAID, extra: { worldscrawl_dig_failed: true } }, { is_user: false, mes: 'The window gives way...' }];
    assert.equal(ext.digFailedBefore(chat, 1), true);
    assert.equal(ext.digFailedBefore([{ is_user: true, mes: 'hi', extra: {} }, { mes: 'x' }], 1), false);
});
