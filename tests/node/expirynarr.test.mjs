// Narrated expiries: pick where the party ends up first (own pick-one call), then one automatic narrator reply
// told what ran out (name, description, the change that made it, an excerpt of its message) and where they are now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
ext.setPrompts(def);
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));
const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
const room = { name: 'Guest Room 1', description: 'A narrow room with a broken window.', change: { msg: 5, note: 'innkeeper shows them a room', summary: ['added place Guest Room 1', 'added exit door from Upstairs Rooms'], ended: 'Guest Room 1 expired at 9:00 PM, 3 Mar (lasted 1h, from message #5)' } };
const options = [{ address: 'inn/upstairs', direction: 'door', name: 'Upstairs Rooms' }, { address: 'inn/yard', direction: 'window', name: 'Inn Yard' }];

test('Narrate expiries is a setting, on by default, with a checkbox', () => {
    assert.match(src, /narrateExpiries: true/);
    assert.match(src, /id="worldscrawl_narrate_expiries"[^>]*> Narrate expiries/);
});
test('the narration line is an editable Writing style prompt for Narration; the pick is its own locked question', () => {
    assert.equal(byId['narration.expired'].group, 'style');
    assert.equal(byId['narration.expired'].process, 'narration');
    assert.ok(!byId['narration.expired'].locked);
    assert.ok(byId['narration.expiry_pick'].locked);
});
test('the pick: nearby places as short keys, the way in first and the default', () => {
    const opts = ext.expiryOptions(options);
    assert.deepEqual(opts.map(o => o.key), ['upstairs_rooms', 'inn_yard']);
    const q = ext.expiryPickPrompt(room, opts, opts[0].key);
    assert.match(q, /Guest Room 1, which is coming to an end: Guest Room 1 expired at 9:00 PM/);
    assert.match(q, /- upstairs_rooms: Upstairs Rooms \(out through the door\)\n- inn_yard: Inn Yard \(out through the window\)/);
    assert.match(q, /If unsure: upstairs_rooms\./);
    // Lenient matching of the answer; nonsense is no match (asked once more, then the way in).
    assert.equal(ext.pickKey(opts)('Inn yard.')?.address, 'inn/yard');
    assert.equal(ext.pickKey(opts)('the moon'), null);
});
test('the narration line: what ran out, what made it, an excerpt, and where they end up (decided, not up to the narrator)', () => {
    const msg = 'The innkeeper ' + 'leads you up the creaking stairs and '.repeat(10) + 'opens a door.';
    const ex = ext.excerptOf(msg);
    assert.ok(ex.length <= 240 && ex.endsWith('...'), ex);
    const line = ext.expiryNarrationLine(room, { address: 'inn/upstairs', name: 'Upstairs Rooms' }, 'door', 'Ann', ex);
    for (const w of ['Guest Room 1 has come to an end', 'lasted 1h, from message #5', 'A narrow room with a broken window.', 'innkeeper shows them a room; added place Guest Room 1', `"${ex}"`, 'ends up in Upstairs Rooms (out through the door)', 'free to decide why and how', 'Do not change where Ann ends up'])
        assert.ok(line.includes(w), w);
});
test('the reply carries the stamp; the context line stays as the fallback', () => {
    assert.match(src, /m\.extra\[LOC_KEY\] = p\.to/);
    assert.match(src, /automatic_trigger: true/);
    assert.match(src, /postExpiredNotice\(p\.from, p\.to, p\.via\)/);
});
test('the map the last narrator reply saw: later Turn off reverted, its room and clock', () => {
    const chat = [
        { mes: 'hi', extra: { worldscrawl_location: 'inn/upstairs' } },
        { mes: 'go', is_user: true, extra: { worldscrawl_patches: [{ id: 'p1', type: 'patch', ops: [] }] } },
        { mes: 'You enter.', extra: { worldscrawl_location: 'inn/guest_room_1' } },
        { mes: '[Engine: turned off]', is_system: true, extra: { worldscrawl_notice_kind: 'toggle', worldscrawl_notice_changes: [[1, 'p1']], worldscrawl_notice_on: false } },
    ];
    const v = ext.narratedView(chat);
    assert.equal(v.index, 2); assert.equal(v.address, 'inn/guest_room_1');
    assert.equal(v.changes.length, 1); assert.equal(v.changes[0].off, false);
});
