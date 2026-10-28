// Dev standard: every pick-one question lists short text keys (never numbers), and the answer is matched leniently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
const ext = await import('../../extension/index.js');
const { matchKey, keyFor, lookOptions, doorOptions, roomOptions, pickKey } = ext;

test('matchKey: exact, any case, punctuation and markdown ignored', () => {
    const keys = ['around', 'north', 'trap_door', 'window'];
    assert.equal(matchKey('north', keys), 'north');
    assert.equal(matchKey('NORTH.', keys), 'north');
    assert.equal(matchKey('**"North"**', keys), 'north');
    assert.equal(matchKey('trap door', keys), 'trap_door');
    assert.equal(matchKey('Trap-Door!', keys), 'trap_door');
});
test('matchKey: extra words around one key are fine', () => {
    const keys = ['listen', 'peek', 'open', 'look'];
    assert.equal(matchKey('They peek through the keyhole', keys), 'peek');
    assert.equal(matchKey('Answer: listen', keys), 'listen');
    assert.equal(matchKey('<think>maybe open it</think>\nlisten', keys), 'listen');
});
test('matchKey: the longest key wins; a tie or nothing is no match', () => {
    assert.equal(matchKey('the common room of the inn', ['common', 'common_room']), 'common_room');
    assert.equal(matchKey('north or south', ['north', 'south']), null);
    assert.equal(matchKey('2', ['north', 'south']), null);
    assert.equal(matchKey('', ['north']), null);
    assert.equal(matchKey('northern', ['north']), null, 'whole words only');
});
test('keyFor: short, lowercase, unique', () => {
    const t = new Set();
    assert.equal(keyFor('Common Room (The Drowned Rat)', t), 'common_room_the_drowned');
    assert.equal(keyFor('Common Room (The Drowned Rat)', t), 'common_room_the_drowned_2');
    assert.equal(keyFor('!!!', t), 'option');
});
test('look, door and place options use text keys, never numbers', () => {
    const exits = [{ direction: 'north', to: 'a' }, { direction: 'Green Door', to: 'b' }, { direction: 'window', to: 'c' }];
    assert.deepEqual(lookOptions(exits, true).map(o => o.key), ['around', 'north', 'green_door', 'window_2', 'window']);
    assert.deepEqual(lookOptions(exits, false).map(o => o.key), ['around', 'north', 'green_door', 'window_2']);
    assert.deepEqual(doorOptions(exits).map(o => o.key), ['north', 'green_door', 'window']);
    assert.deepEqual(roomOptions([{ display_name: 'Hall', summary: 'x' }, { display_name: 'Hall', summary: 'y' }]).map(o => o.key), ['hall', 'hall_2']);
    const pick = pickKey(doorOptions(exits));
    assert.equal(pick('the green door').exit.direction, 'Green Door');
    assert.equal(pick('1'), null);
});
test('every pick-one prompt asks for a key, not a number', async () => {
    const def = (await import('../../plugin/prompts/default.json', { with: { type: 'json' } })).default;
    for (const e of def.prompts) assert.ok(!/just the number/i.test(e.text), `${e.id} still asks for a number`);
    for (const id of ['look.target', 'look.closed_door', 'look.view', 'door.pick']) assert.match(def.prompts.find(e => e.id === id).text, /Reply with just the key\./, id);
    assert.ok(def.prompts.find(e => e.id === 'pick.system').locked);
});
