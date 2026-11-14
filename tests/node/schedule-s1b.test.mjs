// S1b schedules: private rooms (inheritance, set_private, the map editor control, the word list for rooms made in play,
// area picks skipping them), Remember writing a passing-through schedule and a stay (also in a room made in play), the
// cast editor's Is at / Might be at rows, and saving with warnings. The chat side runs through the real handlers (a real
// world server behind the fetch shim, offerRemember/keepRemember with a fake model, prepareNpcs, the [find] bracket).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';
import { validateRecord } from '../../plugin/npc.mjs';
import { loadCast, saveCastNpc, tidyRecord } from '../../plugin/cast.mjs';
import { NOWHERE, areaPick, blockStartOf, exportRecord, hashRoll, hashScore, mightKey, mightTable, parseMightOption, pickFromTable, readMightEntry, wanderChain } from '../../plugin/shared/npc.mjs';
import { castRows, filterRows, formFromRecord, formProblems, mightText, recordFromForm, whyRows } from '../../plugin/ui/castdata.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { castPanel } = await import('../../plugin/ui/castpanel.mjs');
const { makeDoc } = await import('./fakedom.mjs');
await loadCalendar();
const { NPC_KEY, FOUND_KEY, absMinutes, clockAtMinutes, comingsAndGoings, framesOf, judgeFound, mightAt, nextTurnUp, npcWhy, presentAt, scheduleAt, visitsBetween, whoAt } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, UP = 'riverton:drowned_rat/upstairs', CELLAR = 'riverton:drowned_rat/cellar', RAT = 'riverton:drowned_rat';
const SQ = 'riverton:streets/square', LANE = 'riverton:streets/market_lane', STORE = 'riverton:general_store/shop';
const H = (h, m = 0) => h * 60 + m;

// Tam: a wandering block 09:00-12:00 that, on the Riverton start date, goes square 09:00, away 09:30, the common room
// 10:00-10:30 (a short segment), then the square 10:30-11:30 (fixed by the seed: the person, the entry, the segment start).
const TAM = { id: 'tam', name: 'Tam', personality: { summary: 'An old net-mender with tar on his hands.' }, disposition: { player: { value: 'indifferent' } },
    schedule: [{ might: [`${BAR}(30)`, `${SQ}(30)`, 'nowhere'], activity: 'mending nets', from: '09:00', to: '12:00', wandering: true }] };
// Bryn: a normal block 09:00-12:00, always the common room; the rest of the day nowhere.
const BRYN = { id: 'bryn', name: 'Bryn', personality: { summary: 'A ferryman waiting for the tide.' }, disposition: { player: { value: 'indifferent' } },
    schedule: [{ might: [BAR], activity: 'waiting for the tide', from: '09:00', to: '12:00' }] };

const servers = new Map();
/* boot() and the helpers below are the same as schedule.test.mjs. */
function serverFor(cards) {
    const key = JSON.stringify(cards);
    if (servers.has(key)) return servers.get(key);
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    for (const card of cards) write(path.join(d, 'riverton', 'cast', `${card.id}.json`), JSON.stringify(card, null, 2));
    const sv = { server: clientDir(d), dir: path.join(d, 'riverton') };
    servers.set(key, sv);
    return sv;
}
/** A fresh chat in the common room at `time` on the Riverton start date, with the real world server (Hesk) plus `cards`. */
function boot({ time = '09:00', cards = [TAM, BRYN] } = {}) {
    exitsCache.clear();
    const { server, dir } = serverFor(cards);
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext();
    c.chatId = 'sched'; c.getCurrentChatId = () => 'sched';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {}, calls = [];
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => { calls.push(String(args?.prompt ?? '')); return /Reply with JSON only:\n\{"place"/.test(String(args?.prompt ?? '')) ? '{"place": null, "people": [], "wait": null}' : ''; };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'The common room is quiet.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: BAR } }];
    return { c, blocks, calls, server, dir };
}
const say = (c, text, extra = {}) => { const m = { is_user: true, mes: text, swipe_id: 0, extra }; c.chat.push(m); return m; };
const reply = (c, text, extra = {}) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }; c.chat.push(m); return m; };
const envOf = c => scene.npcEnv(c.chat, { address: c.chat.findLast?.(m => m.extra?.worldscrawl_location)?.extra.worldscrawl_location ?? BAR });
const cast = () => scene.castPack().npcs;
const person = id => cast().find(n => n.id === id);
const day0 = c => envOf(c).clock(0).day;
const at = (c, min) => clockAtMinutes(day0(c) * 1440 + min);
const presentIds = c => presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).map(n => n.id);
const factsText = async (blocks) => { await scene.applyFacts(); return Object.values(blocks).join('\n'); };
const waitFor = async (c, text) => { const m = say(c, text); const r = await bracketIntent(m, parseBracket(text)); assert.notEqual(r.kind, 'bracket_failed', r.note); return m; };
const appears = m => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === 'npc_appear');

import { applyPatch, getRoom, privateByName, privateOf, PRIVATE_WORDS } from '../../plugin/shared/patches.mjs';
import { build_world, read_world_raw } from '../../plugin/world.mjs';
import { initialState, placeOps, areaOps, ROOM_FIELDS, AREA_FIELDS } from '../../plugin/ui/placeform.mjs';
import { passingThrough } from '../../plugin/shared/npc.mjs';
import { formWarnings, placeResolver, mightFormRow, toggleRowKind, MIGHT_HELP } from '../../plugin/ui/castdata.mjs';

const KITCH = 'riverton:drowned_rat/kitchens', YARD = 'riverton:drowned_rat/courtyard', STABLE = 'riverton:drowned_rat/stable';
const GOOSE_UP = 'riverton:gilded_goose/upstairs', CATA = 'riverton:temple/catacombs', TUNNEL = 'riverton:secret_tunnel/tunnel';
const isRemember = p => /Remember this person/.test(p);
const ELARA = { name: 'Elara', personality: { summary: 'A traveller with a lute.', manner: 'Easy.', speech: 'Soft.' }, appearance: { summary: 'tall woman with a lute' }, facts: [], invented: [], disposition: { value: 'friendly', reason: 'You bought her a drink.' } };
const PIP = { ...ELARA, name: 'Pip', personality: { summary: 'A potgirl hiding from work.' } };
/** The fake model: the Remember answer for `card`, and an empty tracker read for everything else. */
const fakeModel = (c, card) => { c.generateRaw = async args => { const p = String(args?.prompt ?? ''); return isRemember(p) ? JSON.stringify(card) : '{"place": null, "people": [], "wait": null}'; }; };
const stampsOf = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === type);
const playPerson = (c, id) => framesOf(c.chat, c.chat.length - 1, cast()).at(-1)?.get(id);
const NOOK = 'riverton:drowned_rat/storage_nook';
const NOOK_PATCH = { type: 'patch', id: 'p_nook', swipe: 0, relocate: {}, summary: ['A storage nook off the common room'],
    ops: [{ op: 'create_place', area: RAT, id: 'storage_nook', name: 'Storage Nook', description: 'Shelves of jars and a broom.', exits: [{ direction: 'north', to: BAR, return_direction: 'south' }] }] };
const privPatch = (target, value = true) => ({ type: 'patch', id: `p_priv_${target}`, swipe: 0, relocate: {}, summary: [`${target} private`], ops: [{ op: 'set_private', target, value }] });

// ---- 1. The private flag.
test('private cascades world > region > subregion > room (nearest setting wins, default public), in the loader and privateOf', () => {
    const [wj, raw0] = read_world_raw(RIVERTON);
    const pv = (mut, a = STABLE) => { const w = structuredClone(wj), raw = structuredClone(raw0); mut(w, raw); return [build_world(w, raw).locations.get(a).private, privateOf(raw, a, w)]; };
    assert.deepEqual(pv(() => {}), [false, false], 'default: public');
    assert.deepEqual(pv(w => { w.private = true; }), [true, true], 'world says private');
    assert.deepEqual(pv((w, r) => { w.private = true; r.riverton.private = false; }), [false, false], 'region overrides world');
    assert.deepEqual(pv((w, r) => { r.riverton.subregions.drowned_rat.private = true; }), [true, true], 'subregion');
    assert.deepEqual(pv((w, r) => { r.riverton.subregions.drowned_rat.private = true; r.riverton.subregions.drowned_rat.locations.stable.private = false; }), [false, false], 'room overrides subregion');
    assert.deepEqual(pv((w, r) => { r.riverton.subregions.drowned_rat.private = true; }, SQ), [false, false], 'other subregions are unaffected');
});

test('the Riverton rooms Knarfy approved load private; the public rooms do not', () => {
    const { server } = boot({ time: '09:00', cards: [] });
    const body = server.get('/cast').json();
    assert.deepEqual([...body.private_places].sort(), [CELLAR, KITCH, UP, GOOSE_UP, CATA, TUNNEL].sort());
    for (const a of [BAR, YARD, STABLE, SQ, LANE, STORE]) assert.ok(!body.private_places.includes(a), a);
    const info = server.get('/worlds').json().worlds.find(w => w.id === 'riverton');
    assert.deepEqual([...info.private_places].sort(), [...body.private_places].sort(), '/worlds carries the same list');
});

test('set_private: apply, inherit, and the summary line; a bad target is refused', () => {
    const raw = read_world_raw(RIVERTON)[1];
    let out = applyPatch(raw, { ops: [{ op: 'set_private', target: STABLE, value: true }] });
    assert.equal(getRoom(raw, STABLE).private, true);
    assert.equal(privateOf(raw, STABLE), true);
    assert.match(out.summary[0], /: private$/);
    out = applyPatch(raw, { ops: [{ op: 'set_private', target: 'riverton:streets', value: 'true' }] });
    assert.equal(privateOf(raw, SQ), true, 'a subregion setting covers its rooms');
    out = applyPatch(raw, { ops: [{ op: 'set_private', target: 'riverton:streets', value: 'inherit' }] });
    assert.equal(raw.riverton.subregions.streets.private, undefined, 'inherit removes the setting');
    assert.match(out.summary[0], /public or private follows the level above/);
    out = applyPatch(raw, { ops: [{ op: 'set_private', target: CELLAR, value: false }] });
    assert.equal(privateOf(raw, CELLAR), false);
    assert.match(out.summary[0], /: public$/);
    assert.throws(() => applyPatch(raw, { ops: [{ op: 'set_private', target: 'nowhere:at/all', value: true }] }), /target/);
});

test('rooms made in play: a name ending in a private word starts private (last word only, not house or home)', () => {
    assert.deepEqual(PRIVATE_WORDS, ['bedroom', 'bedchamber', 'quarters', 'cottage', 'apartment', 'bath', 'privy', 'cell']);
    for (const n of ['Guest Bedroom', "Servants' Quarters", 'The Cell', 'Old Cottage', "Miller's Bath", 'Privy']) assert.equal(privateByName(n), true, n);
    for (const n of ['Bath Street', 'Bathhouse', 'Cell Block Yard', 'Old House', 'Home Hall', 'Storage Nook', '']) assert.equal(privateByName(n), false, n);
    const raw = read_world_raw(RIVERTON)[1];
    const mk = (name, n) => ({ op: 'create_place', story: true, area: RAT, name, description: 'A room.', exits: [{ direction: `door ${n}`, to: UP, return_direction: `back ${n}` }] });
    applyPatch(raw, { ops: [mk('Guest Bedroom', 1)] });
    applyPatch(raw, { ops: [mk('Bath Street', 2)] });
    const made = Object.values(raw.riverton.subregions.drowned_rat.locations);
    assert.equal(made.find(l => l.name === 'Guest Bedroom').private, true);
    assert.equal(made.find(l => l.name === 'Bath Street').private, undefined, 'public: follows the level above');
});

test('map editor: the Private control on rooms and areas, with its inherited value; set_private in the change preview', () => {
    const { server } = boot({ time: '09:00', cards: [] });
    const ctxOf = target => server.post('/edit/context', { json: { target, changes: [] } }).json();
    assert.ok(ROOM_FIELDS.some(f => f.k === 'private' && f.type === 'bool'));
    assert.ok(Object.values(AREA_FIELDS).every(list => list.some(f => f.k === 'private')));
    const x = ctxOf(BAR);
    assert.deepEqual(x.inherited.private, { value: false, from: 'default' });
    const st = initialState(x);
    assert.deepEqual(placeOps(x, st), [], 'untouched: no ops');
    st.own.private = true;
    assert.deepEqual(placeOps(x, st).filter(o => o.op === 'set_private'), [{ op: 'set_private', target: BAR, value: true }]);
    const c = ctxOf(CELLAR);
    assert.equal(c.own.private, true);
    const s = ctxOf('sub:riverton:secret_tunnel');
    assert.equal(s.own.private, true);
    assert.deepEqual(ctxOf(TUNNEL).inherited.private, { value: true, from: 'subregion' });
    const a = ctxOf('sub:riverton:streets'), ast = initialState(a);
    ast.own.private = true;
    assert.deepEqual(areaOps(a, ast).filter(o => o.op === 'set_private'), [{ op: 'set_private', target: 'riverton:streets', value: true }]);
    const pre = server.post('/patch/preview', { json: { patch: { ops: [{ op: 'set_private', target: STABLE, value: true }] }, changes: [] } });
    assert.equal(pre.status_code, 200, JSON.stringify(pre.json()));
});

// ---- 2. Area picks skip private rooms.
const GUS = { id: 'gus', name: 'Gus', personality: { summary: 'A loafer.' }, schedule: [{ might: [RAT], activity: 'loafing', from: '09:00', to: '12:00' }] };
const MOLE = { id: 'mole', name: 'Mole', personality: { summary: 'A rat-catcher.' }, schedule: [{ might: [CELLAR], activity: 'catching rats', from: '09:00', to: '12:00' }] };
const DIGGER = { id: 'digger', name: 'Digger', personality: { summary: 'A smuggler.' }, schedule: [{ might: ['riverton:secret_tunnel'], activity: 'smuggling', from: '09:00', to: '12:00' }] };

test('area picks: never a private room; making the winning room private before they appear moves the pick; a named private room still works; an area with no public room is away with a note', async () => {
    const { c } = boot({ time: '10:00', cards: [GUS, MOLE, DIGGER] });
    let env = envOf(c);
    const picks = new Set();
    for (let d = 0; d < 60; d++) picks.add(scheduleAt(person('gus'), { day: day0(c) + d, minutes: H(10) }, env).address);
    assert.deepEqual([...picks].sort(), [BAR, YARD, STABLE].sort(), 'only the public rooms of the Drowned Rat');
    const s0 = scheduleAt(person('gus'), env.clock(0), env);
    assert.equal(s0.area.of, 3);
    // The winning room turns private (a map change in this chat) before Gus has turned up: the pick moves.
    c.chat[0].extra.worldscrawl_patches = [privPatch(s0.address)];
    await ext.refreshLivePlaces();
    env = envOf(c);
    const s1 = scheduleAt(person('gus'), env.clock(0), env);
    assert.notEqual(s1.address, s0.address);
    assert.ok([BAR, YARD, STABLE].includes(s1.address));
    assert.equal(s1.area.of, 2);
    c.chat[0].extra.worldscrawl_patches = [];
    await ext.refreshLivePlaces();
    env = envOf(c);
    // Named: the cellar is private but the entry names it.
    assert.equal(scheduleAt(person('mole'), env.clock(0), env).address, CELLAR);
    // An area with only private rooms: away, with the note for the inspector.
    const dg = scheduleAt(person('digger'), env.clock(0), env);
    assert.deepEqual([dg.kind, dg.address], ['might', null]);
    assert.match(dg.note, /^No public room in .* to pick, so away this time\.$/);
});

// ---- 3. Remember writes a passing-through schedule and a stay.
test('passingThrough: a 50% block an hour either side, home 20:00-07:00 outside it, the rest open; it loads with no notes', () => {
    const one = (min, block, home) => {
        const s = passingThrough(BAR, min);
        assert.deepEqual(s[0], { might: [`${BAR}(50)`], activity: 'out and about', from: block[0], to: block[1] });
        assert.deepEqual(s.slice(1, -1).map(e => [e.where, e.from, e.to]), home.map(([a, b]) => ['home', a, b]));
        assert.deepEqual(s.at(-1), { activity: 'about their own business' });
        const v = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: s }, { file: 'x.json', places: new Set([BAR]) });
        assert.deepEqual([v.ok, v.problems, v.warnings], [true, [], []], `no overlap note at ${min}`);
    };
    one(H(16, 17), ['15:00', '17:00'], [['20:00', '07:00']]);
    one(H(21), ['20:00', '22:00'], [['22:00', '07:00']]);
    one(H(6), ['05:00', '07:00'], [['20:00', '05:00']]);
    one(H(2), ['01:00', '03:00'], [['20:00', '01:00'], ['03:00', '07:00']]);
    one(H(0), ['23:00', '01:00'], [['20:00', '23:00'], ['01:00', '07:00']]);
});

test('Remember (real handlers, fake model): npc_create, then a passing-through npc_schedule and a stay at the room; the next day inside the block [find] judges the roll, never "no schedule in force"', async () => {
    const { c } = boot({ time: '16:17', cards: [] });
    fakeModel(c, ELARA);
    reply(c, 'A traveller named Elara tunes her lute by the fire.');
    await scene.offerRemember(c.chat[1], 'Elara');
    await scene.keepRemember(1);
    const m = c.chat[1];
    const made = stampsOf(m, 'npc_create');
    assert.equal(made.length, 1);
    const id = made[0].id;
    const sch = stampsOf(m, 'npc_schedule');
    assert.equal(sch.length, 1);
    assert.equal(sch[0].id, id);
    assert.deepEqual(sch[0].schedule, passingThrough(BAR, scene.npcClock(c.chat, 1).minutes));
    assert.deepEqual([sch[0].schedule[0].from, sch[0].schedule[0].to], ['15:00', '17:00']);
    assert.deepEqual(stampsOf(m, 'npc_stay').map(s => [s.id, s.place]), [[id, BAR]]);
    assert.ok(presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).some(n => n.id === id), 'still here after Approve');
    // The next day at 16:20, inside the block: present or away by the roll, and [find] judges where she is.
    await waitFor(c, '[wait] until 08:00');
    await waitFor(c, '[wait] until 16:20');
    const env = envOf(c);
    const clock = env.clock(c.chat.length - 1);
    assert.equal(clock.day, day0(c) + 1);
    const elara = playPerson(c, id);
    assert.ok(elara, 'in the chat state');
    const s = scheduleAt(elara, clock, env);
    assert.equal(s.kind, 'might');
    assert.ok(s.address === BAR || s.address === null);
    const q = say(c, '[find] Elara');
    await bracketIntent(q, parseBracket(q.mes));
    const d = (q.extra[FOUND_KEY] ?? []).find(x => x.id === id);
    assert.ok(d, JSON.stringify(q.extra[FOUND_KEY]));
    assert.doesNotMatch(d.reason, /no schedule in force/);
    assert.equal(d.ok, s.address === BAR, d.reason);
    // Off the block (03:00 the next night) she is at home, off the map.
    const night = scheduleAt(elara, { day: day0(c) + 2, minutes: H(3) }, env);
    assert.deepEqual([night.activity, night.address], ['at home', null]);
});

test('Remember in a room made in play (the Storage Nook): the schedule and stay name the new room and resolve on the live map', async () => {
    const { c } = boot({ time: '10:00', cards: [] });
    c.chat[0].extra.worldscrawl_patches = [NOOK_PATCH];
    await ext.refreshLivePlaces();
    fakeModel(c, PIP);
    reply(c, 'In the storage nook, a potgirl named Pip hides behind the jars.', { worldscrawl_location: NOOK });
    await scene.offerRemember(c.chat[1], 'Pip');
    await scene.keepRemember(1);
    const m = c.chat[1];
    const id = stampsOf(m, 'npc_create')[0].id;
    assert.deepEqual(stampsOf(m, 'npc_schedule')[0].schedule[0].might, [`${NOOK}(50)`]);
    assert.deepEqual(stampsOf(m, 'npc_stay').map(s => s.place), [NOOK]);
    const env = envOf(c);
    const pip = playPerson(c, id);
    const picks = new Set();
    for (let d = 0; d < 40; d++) { const s = scheduleAt(pip, { day: day0(c) + d, minutes: H(10) }, env); picks.add(s.address); assert.doesNotMatch(s.note ?? '', /not on the map/); }
    assert.deepEqual([...picks].sort((a, b) => String(a).localeCompare(String(b))), [null, NOOK].sort((a, b) => String(a).localeCompare(String(b))), 'the live map has the nook: half the blocks place her there');
    c.chat[0].extra.worldscrawl_patches = [];
    await ext.refreshLivePlaces();
});

// ---- 4. The cast editor: Is at / Might be at rows, warnings that do not block.
test('editor model: a might row round-trips as written, typed names become addresses, toggling keeps what carries over', () => {
    const { server } = boot({ time: '09:00', cards: [] });
    const data = server.get('/cast').json();
    const resolve = placeResolver(data);
    assert.deepEqual(resolve('Market Lane'), { address: LANE, kind: 'room' });
    assert.deepEqual(resolve(' market lane '), { address: LANE, kind: 'room' });
    assert.equal(resolve('riverton:streets').kind, 'area');
    assert.equal(resolve("Marlow's General Store").kind, 'ambiguous', 'the subregion and its room share the name');
    assert.equal(resolve('a fishing camp').kind, 'text');
    const row = mightFormRow({ might: [LANE, 'nowhere(80)'], activity: 'errands', from: '10:00', to: '12:00' });
    assert.equal(row.kind, 'might');
    const rec = f => recordFromForm({ id: 'x', name: 'X', line: 'x', schedule: [f] }, { resolve }).schedule;
    assert.deepEqual(rec(row), [{ might: [LANE, 'nowhere(80)'], activity: 'errands', from: '10:00', to: '12:00' }]);
    row.options = 'Market Lane(30), Village Square, riverton:streets';
    row.wandering = true;
    assert.deepEqual(rec(row), [{ might: [`${LANE}(30)`, SQ, 'riverton:streets'], activity: 'errands', from: '10:00', to: '12:00', wandering: true }]);
    const at = toggleRowKind(row, 'at', resolve);
    assert.deepEqual([at.kind, at.place, at.activity, at.from, at.to], ['at', LANE, 'errands', '10:00', '12:00']);
    const back = toggleRowKind(at, 'might', resolve);
    assert.deepEqual(rec(back), [{ might: [LANE], activity: 'errands', from: '10:00', to: '12:00' }]);
    // Blocking problems vs warnings.
    const f = sched => ({ id: 'x', name: 'X', line: 'x', schedule: sched });
    const bad = { ...row, options: 'Market Lane(70), Village Square(40)' };
    assert.match(formProblems(f([bad]), { resolve })['schedule.0.options'], /110%, over 100/);
    assert.match(formProblems(f([{ ...row, options: "Marlow's General Store" }]), { resolve })['schedule.0.options'], /matches .* Use the address/);
    assert.match(formProblems(f([{ ...row, options: '' }]), { resolve })['schedule.0.options'], /List where they might be/);
    assert.match(formProblems(f([{ ...row, from: '' }]), { resolve })['schedule.0.from'], /start time is required/);
    const warnRow = { ...row, options: `Market Lane, ${NOOK}, Wikerton` };
    assert.deepEqual(formProblems(f([warnRow]), { resolve }), {}, 'warnings do not block');
    const w = formWarnings(f([warnRow, { kind: 'at', place: BAR, activity: 'drinking', from: '11:00', to: '13:00' }]), { resolve })['schedule.0.warn'];
    assert.match(w, /storage_nook is not on the map yet/);
    assert.match(w, /"Wikerton" matches no place/);
    assert.match(w, /Overlaps entry 2 \(11:00–13:00\)/);
    assert.match(MIGHT_HELP, /chances add up/);
});

test('cast panel: Is at / Might be at per row with Wandering and options; an overlap shows as a note and Save still works', async () => {
    const { server, dir } = boot({ time: '09:00', cards: [TAM, BRYN] });
    const doc = makeDoc();
    const saved = [];
    const panel = castPanel(doc, {
        load: async () => server.get('/cast').json(), outline: async () => null, play: () => null, placeName: a => a,
        save: async (npc, original, originalFile) => { saved.push(npc); const res = server.post('/cast/save?world=riverton', { json: { npc, ...(original ? { original } : {}), ...(originalFile ? { original_file: originalFile } : {}) } }); if (res.status_code >= 400) throw new Error(JSON.stringify(res.json())); return res.json(); },
    });
    await panel.refresh();
    panel.selectId('bryn', 'resolved');
    panel.el.querySelectorAll('.cast-saveas')[0].click();
    const row = () => panel.el.querySelectorAll('.cf-sched')[0];
    assert.equal(row().querySelectorAll('.cf-kind')[0].value, 'might');
    assert.equal(row().querySelectorAll('.cf-options')[0].value, BAR, 'two rooms are called Common Room, so the address shows');
    // Toggle to Is at (the place carries over) and back.
    const kind = row().querySelectorAll('.cf-kind')[0];
    kind.value = 'at'; kind.dispatchEvent({ type: 'change' });
    assert.equal(row().querySelectorAll('.cf-kind')[0].value, 'at');
    assert.ok(!row().querySelectorAll('.cf-options').length);
    const k2 = row().querySelectorAll('.cf-kind')[0];
    k2.value = 'might'; k2.dispatchEvent({ type: 'change' });
    const opts = row().querySelectorAll('.cf-options')[0];
    assert.equal(opts.value, BAR);
    opts.value = `${BAR}(40), Village Square`; opts.dispatchEvent({ type: 'input' });
    const wand = row().querySelectorAll('.cf-wandering')[0];
    wand.checked = true; wand.dispatchEvent({ type: 'change' });
    // Over 100% blocks; fixing it unblocks.
    opts.value = `${BAR}(70), Village Square(40)`; opts.dispatchEvent({ type: 'input' });
    assert.equal(panel.el.querySelectorAll('.cast-save')[0].disabled, true);
    assert.match(panel.el.querySelectorAll('.cf-err').map(e => e.textContent).join(' '), /110%, over 100/);
    opts.value = 'Common Room(40), Village Square'; opts.dispatchEvent({ type: 'input' });
    assert.match(panel.el.querySelectorAll('.cf-err').map(e => e.textContent).join(' '), /"Common Room" matches .*common_room.* Use the address/, 'an ambiguous name blocks');
    opts.value = `${BAR}(40), Village Square`; opts.dispatchEvent({ type: 'input' });
    // Add an Is at row that overlaps: a note, not a block.
    panel.el.querySelectorAll('.cf-addsched')[0].click();
    const r2 = panel.el.querySelectorAll('.cf-sched')[1];
    const act = r2.querySelectorAll('.cf-activity')[0]; act.value = 'napping'; act.dispatchEvent({ type: 'input' });
    const off = r2.querySelectorAll('.cf-offmap')[0]; off.checked = true; off.dispatchEvent({ type: 'change' });
    const r2b = panel.el.querySelectorAll('.cf-sched')[1];
    for (const [k, v] of [['from', '10:00'], ['to', '11:00']]) { const t = r2b.querySelectorAll(`.cf-${k}`)[0]; t.value = v; t.dispatchEvent({ type: 'input' }); }
    assert.match(panel.el.querySelectorAll('.cf-warn').map(e => e.textContent).join(' '), /Overlaps entry 2 \(10:00–11:00\)/);
    assert.equal(panel.el.querySelectorAll('.cast-save')[0].disabled, false, 'a warning does not block saving');
    assert.ok(panel.el.querySelectorAll('.cf-mighthelp').length, 'the authoring help is there');
    panel.el.querySelectorAll('.cast-save')[0].click();
    panel.el.querySelectorAll('.cast-confirm')[0].click();
    await new Promise(res => setTimeout(res, 30));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].schedule, [
        { might: [`${BAR}(40)`, SQ], activity: 'waiting for the tide', from: '09:00', to: '12:00', wandering: true },
        { activity: 'napping', from: '10:00', to: '11:00' },
    ]);
    const copy = fs.readdirSync(path.join(dir, 'cast')).find(x => !['hesk.json', 'tam.json', 'bryn.json'].includes(x));
    assert.ok(copy, 'written despite the overlap note');
    fs.rmSync(path.join(dir, 'cast', copy));
});

test('saving: warnings (overlap, single-word off-map, not on the map yet) never block /cast/save; real errors still do', () => {
    const { server, dir } = boot({ time: '09:00', cards: [] });
    const npc = { id: 'wanda', name: 'Wanda', personality: { summary: 'A washerwoman.' }, schedule: [
        { place: BAR, activity: 'washing', from: '09:00', to: '12:00' },
        { might: [`${SQ}(30)`, NOOK, 'Wikerton'], activity: 'wandering', from: '10:00', to: '11:00' },
    ] };
    const r = server.post('/cast/save?world=riverton', { json: { npc } });
    assert.equal(r.status_code, 200, JSON.stringify(r.json()));
    const w = r.json().warnings.join('\n');
    assert.match(w, /overlap/i);
    assert.match(w, /not on the map yet/);
    assert.match(w, /Wikerton/);
    assert.ok(fs.existsSync(path.join(dir, 'cast', 'wanda.json')));
    fs.rmSync(path.join(dir, 'cast', 'wanda.json'));
    const bad = server.post('/cast/save?world=riverton', { json: { npc: { ...npc, schedule: [{ might: [`${SQ}(70)`, `${BAR}(40)`], activity: 'x', from: '10:00', to: '11:00' }] } } });
    assert.ok(bad.status_code >= 400, 'over 100% is a real error');
    assert.ok(!fs.existsSync(path.join(dir, 'cast', 'wanda.json')));
});
