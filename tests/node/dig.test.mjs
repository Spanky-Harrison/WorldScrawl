import './ststub.mjs';
import './useprompts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON, YARD } from './helpers.mjs';

// ---- from digcourtyard.test.mjs
{
// Knarfy's riverton playtest: "I break open the window, opening a precarious passage to the courtyard." in the Drowned Rat
// upstairs room. The named courtyard must be linked (never a new area), and a failure must be told plainly to the narrator.





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
}

// ---- from digjson.test.mjs
{
// Breaking through: one JSON answer, connecting to an existing nearby place or making a new one.



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

// Discovery: the opened door may lead to a place already on the map (one door pair, add_exit) instead of a new room.
const { existingDiscovery } = await import('../../extension/index.js');
test('discovery: connect to an existing place, matched leniently; a new-room answer is left alone', () => {
    const ex = roomOptions(rooms);
    assert.deepEqual(existingDiscovery({ existing: 'Village Square.', direction: 'green door', exit_description: 'A green door.' }, ex, 'r:t/hall').op,
        { op: 'add_exit', loc: 'r:t/hall', to: 'r:s/square', direction: 'green door', return_direction: 'out', door: true, description: 'A green door.', return_description: undefined });
    assert.equal(existingDiscovery({ name: 'Guest Room', description: 'Small.' }, ex, 'r:t/hall'), null);
    assert.match(existingDiscovery({ existing: 'the moon', direction: 'x' }, ex, 'r:t/hall').error, /place keys: village_square, cellar/);
    assert.match(existingDiscovery({ existing: 'cellar' }, ex, 'r:t/hall').error, /direction/);
});

test('style wording lives in Writing style entries; the system prompts keep only the locked format and render as before', async () => {
    const { DEFAULT_PROMPTS } = await import('./useprompts.mjs');
    const by = Object.fromEntries(DEFAULT_PROMPTS.prompts.map(e => [e.id, e]));
    for (const id of ['discover.style', 'change.style', 'dig.style']) { assert.equal(by[id].group, 'style', id); assert.ok(!by[id].locked, id); }
    for (const id of ['discover.system', 'change.system', 'dig.question']) assert.ok(by[id].locked, id);
    assert.ok(by['discover.system'].text.includes('{{style}}') && !by['discover.system'].text.includes('present tense'));
    assert.ok(by['change.system'].text.includes('{{style}}') && !by['change.system'].text.includes('DESCRIPTION RULE'));
    assert.match(by['change.style'].text, /DESCRIPTION RULE/);
});
}

// ---- from dupguard.test.mjs
{
// Duplicate-room guard: a "new" place that closely matches a place within about 3 steps connects to that place instead.



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
}

// ---- from pickkeys.test.mjs
{
// Dev standard: every pick-one question lists short text keys (never numbers), and the answer is matched leniently.



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
}
