// The browser live-place refresh goes through api()'s {ok, status, body} wrapper. A rename patch must
// not empty that list, and a failed refresh must not be stored as an empty map.
import './ststub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN } from './helpers.mjs';
import { loadCast, worldPlaces } from '../../plugin/cast.mjs';
import { load_world } from '../../plugin/world.mjs';
import { presentAt, scheduleAt, whoAt } from '../../extension/npc.mjs';

const ext = await import('../../extension/index.js');
const { npcEnv } = await import('../../extension/scene.mjs');
const { rememberWorlds } = await import('../../extension/clock.mjs');

const BAR = TAVERN;
const RAT = 'riverton:drowned_rat';
const world = load_world(RIVERTON);
const loaded = loadCast(RIVERTON, world);
const basePlaces = worldPlaces(world);
const hesk = loaded.npcs.find(n => n.id === 'hesk');
const ctx = () => globalThis.SillyTavern.getContext();
const server = clientDir(path.dirname(RIVERTON));
let mode = 'live';
const savedFetch = globalThis.fetch;

function response(status, body) {
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => body };
}
globalThis.fetch = async (url, opts = {}) => {
    if (mode === 'throw') throw new Error('down');
    if (mode === 'status') return response(500, { detail: 'no' });
    if (mode === 'shapeless') return response(200, { ok: true });
    if (mode === 'empty') return response(200, { places: [], subs: [], regions: [], elsewhere: [], place_names: [], place_labels: {} });
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

function patch(id, off = false) {
    return {
        type: 'patch', id, swipe: 0, ...(off ? { off: true } : {}), relocate: {},
        ops: [
            { op: 'update_area', area: RAT, name: 'The Uncommon Room' },
            { op: 'set_name', loc: BAR, text: 'Uncommon Room' },
        ],
        summary: ['The Drowned Rat is now called The Uncommon Room', 'Common Room is now called Uncommon Room'],
    };
}
function chatWith(p) {
    return [{ is_user: true, mes: 'I wait ten hours.', extra: { worldscrawl_wait: { seconds: 10 * 3600 }, worldscrawl_patches: [p] } }];
}
async function look() {
    await ext.refreshLivePlaces();
    const chat = ctx().chat;
    const env = npcEnv(chat, { address: BAR });
    const clock = env.clock(chat.length - 1);
    const sched = scheduleAt(hesk, clock, env);
    const present = presentAt(chat, chat.length - 1, loaded.npcs, env);
    const who = whoAt(chat, chat.length - 1, loaded.npcs, env, BAR);
    return { env, clock, sched, present, who };
}

test('a rename patch keeps Hesk pouring at 18:00; a failed refresh does not invent an empty map', async () => {
    try {
        rememberWorlds({
            default: 'riverton',
            worlds: [{
                id: 'riverton', name: 'Riverton', cast: loaded.npcs,
                places: [...basePlaces.addresses], subs: basePlaces.subs, regions: basePlaces.regions,
                elsewhere: basePlaces.elsewhere, place_names: basePlaces.names, place_labels: basePlaces.labels,
                start_date: { year: 1247, month: 'April', day: 12, time: '08:00' },
            }],
        });
        await ext.loadCalendar();
        const chat = chatWith(patch('rename'));
        ctx().chat = chat;
        ctx().chatMetadata = { worldscrawl_enabled: true };
        mode = 'live';
        const on = await look();
        assert.equal(on.clock.hour, 18);
        assert.equal(on.clock.minute, 0);
        assert.equal(on.env.names(BAR), 'Uncommon Room', 'the live list, not the base name Common Room');
        assert.equal(on.env.exists(BAR), true);
        assert.equal(on.env.exists(RAT), false, 'the subregion is not a room');
        assert.equal(on.sched.address, BAR);
        assert.equal(on.sched.how, 'here');
        assert.equal(on.sched.activity, 'pouring drinks');
        assert.deepEqual(on.present.map(p => [p.id, p.activity]), [['hesk', 'pouring drinks']]);
        assert.equal(on.who.find(x => x.id === 'hesk').here, true);

        chat[0].extra.worldscrawl_patches[0].off = true;
        const off = await look();
        assert.equal(off.env.names(BAR), 'Common Room', 'no active patch: the base world');
        assert.equal(off.sched.activity, 'pouring drinks');
        assert.equal(off.present[0].id, 'hesk');
        assert.equal(off.who.find(x => x.id === 'hesk').here, true);

        delete chat[0].extra.worldscrawl_patches[0].off;
        const back = await look();
        assert.equal(back.env.names(BAR), 'Uncommon Room');
        assert.equal(back.sched.activity, 'pouring drinks');
        assert.equal(back.present[0].id, 'hesk');

        for (const [id, next, why] of [['fail-status', 'status', 'HTTP error'], ['fail-throw', 'throw', 'thrown request'], ['fail-shape', 'shapeless', 'ok answer with no place list']]) {
            chat[0].extra.worldscrawl_patches[0].id = id;
            mode = next;
            const failed = await look();
            assert.equal(failed.sched.activity, 'pouring drinks', why);
            assert.equal(failed.sched.address, BAR, why);
            assert.equal(failed.present[0]?.id, 'hesk', why);
            assert.equal(failed.env.names(BAR), 'Common Room', `${why} falls back to the base world, not an empty list`);
        }

        chat[0].extra.worldscrawl_patches[0].id = 'empty';
        mode = 'empty';
        const none = await look();
        assert.equal(none.env.exists(BAR), false);
        assert.equal(none.sched.offmap, true);
        assert.equal(none.sched.activity, 'asleep');
        assert.deepEqual(none.present, []);
        assert.equal(none.who.find(x => x.id === 'hesk').here, false);
    } finally {
        globalThis.fetch = savedFetch;
        mode = 'live';
    }
});
