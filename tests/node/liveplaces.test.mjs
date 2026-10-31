// Rooms made by this chat's map changes count for every NPC-side check (one live-map lookup), and a chat-only room
// is never written into a base schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, RIVERTON } from './helpers.mjs';
import { NPC_KEY, foundEditOk, judgeFound, presentAt, validateRecord } from '../../plugin/npc.mjs';
import { permanentProblem, CHAT_ONLY_ROOM } from '../../plugin/ui/castdata.mjs';

const RAT = 'riverton:drowned_rat', BAR = `${RAT}/common_room`, UP = `${RAT}/upstairs`, NEW = `${RAT}/hesks_room`;
const changes = [{ type: 'patch', id: 'p1', ops: [{ op: 'create_place', area: RAT, name: "Hesk's Room", description: 'A small room.', exits: [{ to: UP, direction: 'out', return_direction: 'hesk' }] }] }];

function envFrom(places, here) {
    const rooms = new Set(places.places);
    const index = { rooms, subs: new Set(places.subs), regions: new Set(places.regions), stubs: new Map(), nameOf: a => places.place_labels[a] ?? a, exists: a => rooms.has(a), relocate: {} };
    return { exists: a => rooms.has(a), relocate: {}, names: a => places.place_labels[a] ?? a, index, playerAt: () => here, clock: () => ({ day: 1, hour: 8, minute: 0, minutes: 480, elapsed: 0 }) };
}

test('live places include a room discovered in this chat; found, presence and the found edit accept it', () => {
    const c = client(RIVERTON);
    const base = c.get('/cast').json(), live = c.post('/cast/places', { json: { changes, now: 0 } }).json();
    assert.equal(base.places.includes(NEW), false);
    assert.equal(live.places.includes(NEW), true);
    assert.equal(live.place_labels[NEW], "Hesk's Room");
    const env = envFrom(live, NEW), baseEnv = envFrom(base, NEW);
    const n = validateRecord({ id: 'hesk', name: 'Hesk', line: 'The landlady.', schedule: [{ activity: 'resting', where: 'her own room', near: RAT }] }, { file: 'hesk.json', places: new Set(live.places), nearIndex: env.index });
    const j = judgeFound(n, { minutes: 480 }, NEW, env);
    assert.equal(j.ok, true, j.reason);
    const chat = [{ mes: 'found', is_user: true, extra: { [NPC_KEY]: [{ type: 'npc_found', id: 'hesk', where: 'her own room', place: NEW, source: 'bracket', swipe: 0 }] } }];
    assert.deepEqual(presentAt(chat, 0, [n], env).map(p => p.id), ['hesk']);
    assert.deepEqual(presentAt(chat, 0, [n], baseEnv).map(p => p.id), [], 'the old base-only lookup lost her');
    assert.equal(foundEditOk(n, 'her own room', NEW, env).ok, true);
    assert.match(foundEditOk(n, 'her own room', NEW, baseEnv).reason, /not on the map/);
});

test('make permanent refuses a room that only exists in this chat', () => {
    const base = client(RIVERTON).get('/cast').json().places;
    assert.equal(permanentProblem(NEW, base), CHAT_ONLY_ROOM);
    assert.match(CHAT_ONLY_ROOM, /only exists in this chat; save the room to the world first/);
    assert.equal(permanentProblem(UP, base), '');
});
