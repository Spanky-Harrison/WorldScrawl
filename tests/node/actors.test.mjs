// Per-actor positions: old stamps stay the player's, the memo matches a full replay, and a second actor
// can stand somewhere else. Nothing in the UI places that second actor yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PLAYER, readPositions, playerAddress, partyAddresses, partyIds, followers, positionStamp, placeStamp, replayPositions, positionsAt, positionOf, actorHistory } from '../../plugin/actors.mjs';
import { resolveActors, relocateMap } from '../../plugin/position.mjs';
import { SnapshotCache } from '../../plugin/snapcache.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { activeChanges } from '../../plugin/ui/patches.mjs';
import { build_world, read_world_raw } from '../../plugin/world.mjs';
import { buildGraph } from '../../plugin/ui/mapdata.mjs';
import { client, RIVERTON, TAVERN, SQUARE, YARD } from './helpers.mjs';
import './ststub.mjs';

const ext = await import('../../extension/index.js');
const c = client(RIVERTON);
const root = new URL('../../', import.meta.url);

test('the extension copy of actors.mjs matches the plugin one', () => {
    const plugin = fs.readFileSync(new URL('plugin/actors.mjs', root), 'utf8');
    const copy = fs.readFileSync(new URL('extension/actors.mjs', root), 'utf8');
    assert.equal(copy.split('\n').slice(1).join('\n'), plugin);
});

test('old-format stamps load as the player\'s position', () => {
    const chat = [
        { extra: { worldscrawl_location: 'inn/taproom' } },
        { mes: 'no stamp here' },
        { extra: { worldscrawl_location: 'inn/yard' } },
    ];
    assert.deepEqual(readPositions('inn/yard'), { [PLAYER]: 'inn/yard' });
    assert.equal(playerAddress('inn/taproom'), 'inn/taproom');
    assert.equal(readPositions(null), null);
    assert.deepEqual(positionOf(chat, 0), { address: 'inn/taproom', index: 0 });
    assert.equal(positionOf(chat, 1).address, 'inn/taproom', 'a message with no stamp keeps the player put');
    assert.deepEqual(positionOf(chat, 2), { address: 'inn/yard', index: 2 });
    assert.equal(positionOf(chat, 99).address, 'inn/yard');
    assert.equal(positionOf(chat, 2, 'guard'), null);
    assert.deepEqual(actorHistory(chat, 3), ['inn/yard', 'inn/taproom']);
    assert.deepEqual(partyIds(), [PLAYER]);
    assert.deepEqual(followers(), []);
    assert.deepEqual(partyAddresses('inn/yard'), ['inn/yard']);
    // What we write for the player alone is still that string, so new chats match old ones.
    assert.equal(placeStamp(null, PLAYER, 'inn/yard'), 'inn/yard');
    assert.equal(positionStamp({ [PLAYER]: 'inn/yard' }), 'inn/yard');
});

test('positions resolve per actor; a second actor is independent of the player', () => {
    const chat = [
        { extra: { worldscrawl_location: 'inn/taproom' } },
        { extra: { worldscrawl_location: { guard: 'gate' } } },
        { extra: { worldscrawl_location: { guard: 'gate', player: 'square' } } },
    ];
    assert.equal(positionOf(chat, 1, PLAYER).address, 'inn/taproom');
    assert.deepEqual(positionOf(chat, 1, 'guard'), { address: 'gate', index: 1 });
    assert.equal(positionOf(chat, 2, PLAYER).address, 'square');
    assert.equal(positionOf(chat, 2, 'guard').address, 'gate');
    assert.notEqual(positionOf(chat, 2, PLAYER).address, positionOf(chat, 2, 'guard').address);
    // A guard-only stamp is not the party, and it is not written as a bare string.
    assert.deepEqual(partyAddresses({ player: 'square', guard: 'gate' }), ['square']);
    assert.deepEqual(partyAddresses({ guard: 'gate' }), []);
    const stamped = placeStamp('inn/taproom', 'guard', 'gate');
    assert.deepEqual(stamped, { guard: 'gate', player: 'inn/taproom' });
    assert.equal(typeof stamped, 'object');
    assert.deepEqual(readPositions(stamped), { guard: 'gate', player: 'inn/taproom' });
    // The player's move history skips messages that only moved someone else.
    assert.deepEqual(actorHistory(chat, 3, PLAYER), ['square', 'inn/taproom']);
    assert.deepEqual(actorHistory(chat, 3, 'guard'), ['gate']);
});

test('the position memo equals a full replay, including after an edit', () => {
    const chat = [];
    for (let i = 0; i < 40; i++) {
        chat.push(i % 5 === 4
            ? { extra: { worldscrawl_location: { guard: `g${i}` } } }
            : { extra: { worldscrawl_location: `p${i}` } });
    }
    const same = (upTo, msg) => {
        for (let i = 0; i <= upTo; i++) assert.deepEqual(positionsAt(chat, i), replayPositions(chat, i), `${msg} @${i}`);
    };
    same(39, 'first walk');
    same(39, 'cached walk');
    chat[10].extra.worldscrawl_location = 'p10-edited';
    same(39, 'edited stamp');
    assert.equal(positionsAt(chat, 10).player.address, 'p10-edited');
    // Message 9 only moves the guard (every 5th), so the player is still where message 8 put them.
    assert.equal(positionsAt(chat, 9).player.address, 'p8');
    assert.equal(positionsAt(chat, 9).guard.address, 'g9');
    chat.splice(20, 1);
    same(chat.length - 1, 'deleted message');
    chat.push({ extra: { worldscrawl_location: { player: 'end', guard: 'end-g' } } });
    same(chat.length - 1, 'new stamp');
    assert.equal(positionOf(chat, chat.length - 1, 'guard').address, 'end-g');
    assert.equal(positionOf(chat, chat.length - 1, PLAYER).address, 'end');
});

test('resolving two actors on the snapshot cache equals a full replay', () => {
    const [WJ, RAW] = read_world_raw(RIVERTON);
    const changes = [{ type: 'patch', id: 'p1', note: 'test', at: 0, _msg: 1, swipe: 0, ops: [{ op: 'remove_location', loc: YARD }] }];
    const active = activeChanges(changes, null);
    const cache = new SnapshotCache();
    const snap = cache.build('riverton\u0000test', WJ, RAW, changes, null);
    const info = { patches: [] };
    const [wj, raw] = apply_changes(WJ, RAW, active, { now: null, info, lenient: true });
    assert.deepEqual(snap.wj, wj);
    assert.deepEqual(snap.raw, raw);
    assert.deepEqual(snap.info.patches, info.patches);
    const opts = { relocate: relocateMap(info.patches) };
    const actors = { player: SQUARE, guard: YARD };
    const fromCache = resolveActors(build_world(snap.wj, snap.raw), actors, opts);
    const fromReplay = resolveActors(build_world(wj, raw), actors, opts);
    assert.deepEqual(fromCache, fromReplay);
    assert.equal(fromReplay.player.address, SQUARE);
    assert.equal(fromReplay.player.moved, false);
    assert.equal(fromReplay.guard.moved, true);
    assert.notEqual(fromReplay.guard.address, YARD);
    assert.notEqual(fromReplay.player.address, fromReplay.guard.address);
    // The server resolves both against one cached world. The top level stays the player.
    const http = c.post('/resolve', { json: { actors, changes } });
    assert.equal(http.status_code, 200);
    const body = http.json();
    assert.equal(body.address, SQUARE);
    assert.equal(body.how, 'here');
    assert.equal(body.actors.player.address, SQUARE);
    assert.equal(body.actors.player.moved, false);
    assert.equal(body.actors.guard.moved, true);
    assert.notEqual(body.actors.guard.address, YARD);
    assert.notEqual(body.actors.guard.address, body.actors.player.address);
    // And a single old-style address still resolves as that one place, with no actors map.
    const one = c.post('/resolve', { json: { address: TAVERN, changes } });
    assert.equal(one.status_code, 200);
    assert.equal(one.json().actors, undefined);
    assert.equal(one.json().address, TAVERN);
});

test('{{party}} is the player\'s name, and the map marker is the player', () => {
    assert.deepEqual(ext.partyMembers().map(a => a.id), [PLAYER]);
    assert.equal(ext.partyText(), ext.whoMoves());
    const room = (address, name) => ({ address, name, description: name, exits: [], subregion: { id: 's', name: 'S', entrance: address }, region: { id: 'r', name: 'R', entrance: address } });
    const rooms = new Map([[TAVERN, room(TAVERN, 'Tavern')], [YARD, room(YARD, 'Yard')], [SQUARE, room(SQUARE, 'Square')]]);
    const stood = [TAVERN, YARD, SQUARE];
    const legacy = buildGraph({ location: YARD, stood, seen: [], doors_open: [] }, rooms);
    assert.equal(legacy.nodes.find(n => n.here).id, YARD);
    const marked = buildGraph({ location: TAVERN, positions: { player: YARD, guard: SQUARE }, stood, seen: [], doors_open: [] }, rooms);
    assert.equal(marked.nodes.find(n => n.here).id, YARD, 'the marker is the player, not another actor and not a stale location');
});

test('old and per-actor stamps agree on the player for narration, history and doors', () => {
    const oldChat = [
        { mes: 'hi', extra: { worldscrawl_location: 'inn/upstairs' } },
        { mes: 'You enter.', extra: { worldscrawl_location: 'inn/guest_room_1' } },
    ];
    assert.equal(ext.narratedView(oldChat).address, 'inn/guest_room_1');
    const mixed = [
        { mes: 'hi', extra: { worldscrawl_location: 'inn/upstairs' } },
        { mes: 'A guard waits.', extra: { worldscrawl_location: { guard: 'gate' } } },
        { mes: 'You enter.', extra: { worldscrawl_location: { player: 'inn/yard', guard: 'gate' } } },
    ];
    assert.equal(ext.narratedView(mixed).address, 'inn/yard');
    assert.equal(ext.previousAddress('inn/yard', mixed), 'inn/upstairs');
    const open = { type: 'open_door', door: 'd1', from: 'room-a', to: 'room-b', stays_open: false, rooms: ['room-a', 'room-b'] };
    const closedBy = loc => !ext.doorOverrides([
        { extra: { worldscrawl_change: open, worldscrawl_location: 'room-a' } },
        { extra: { worldscrawl_location: loc } },
    ]).has('d1');
    assert.equal(closedBy('room-c'), true);
    assert.equal(closedBy({ player: 'room-c', guard: 'room-a' }), true, 'the player left; a guard still inside is not the party');
    assert.equal(closedBy('room-a'), false);
});
