// Group 2: schedule upgrades. (1) spotsCover matches a region key's own rooms; (2) a job may be an area (the work blocks
// wander its public rooms); (3) the `anywhere` flag on a might block lets its area options include private rooms.
// The chat side runs through the real handlers: a real world server behind the fetch shim, the real Remember card drawn
// with fakedom (offerRemember, renderPatchCards, card clicks through cardacts), the [find] bracket, prepareNpcs, the
// [wait] bracket, a fake model. Every test boots a fresh chat.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir, isTrackerCall } from './helpers.mjs';
import { validateRecord } from '../../plugin/npc.mjs';
import { loadCast, saveCastNpc } from '../../plugin/cast.mjs';
import { exportRecord, expandPattern, mightKey, pickSummary, pickValues, readMightEntry, readSchedulePick, spotsCover, metSpotBlock, SCHEDULE_FIELDS } from '../../plugin/shared/npc.mjs';
import { chatStamps, formFromRecord, mightFormRow, mightText, recordFromForm, MIGHT_HELP } from '../../plugin/ui/castdata.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const SP = await import('../../extension/schedulepick.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { groupPrompts } = await import('../../plugin/ui/prompteditor.mjs');
const { castPanel } = await import('../../plugin/ui/castpanel.mjs');
await loadCalendar();
const { NPC_KEY, FOUND_KEY, clockAtMinutes, framesOf, mightAt, mightWhy, npcWhy, presentAt, scheduleAt, visitsBetween, whoAt } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, RAT = 'riverton:drowned_rat', UP = `${RAT}/upstairs`, CELLAR = `${RAT}/cellar`, KITCH = `${RAT}/kitchens`, YARD = `${RAT}/courtyard`, STABLE = `${RAT}/stable`;
const SQ = 'riverton:streets/square', LANE = 'riverton:streets/market_lane', STORE = 'riverton:general_store/shop';
const SMITHY = 'riverton:smithy', FORGE = 'riverton:smithy/forge', TUNNEL_AREA = 'riverton:secret_tunnel', TUNNEL = 'riverton:secret_tunnel/tunnel';
const H = (h, m = 0) => h * 60 + m;
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- the harness (the shape of schedulepick.test.mjs and find-f1.test.mjs)
const servers = new Map();
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
/** A fresh chat at `time` on the Riverton start date, standing in `here`, with the real world server (Hesk) plus `cards`. */
function boot({ time = '10:00', cards = [], here = BAR } = {}) {
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
    c.chatId = 'group2'; c.getCurrentChatId = () => 'group2';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {}, calls = [];
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => { calls.push(String(args?.prompt ?? '')); return isTrackerCall(args) ? '{"place": null, "people": [], "wait": null}' : ''; };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'A quiet morning.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }];
    return { c, blocks, calls, server, dir };
}
const say = (c, text, extra = {}) => { const m = { is_user: true, mes: text, swipe_id: 0, extra }; c.chat.push(m); return m; };
const reply = (c, text, extra = {}) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }; c.chat.push(m); return m; };
const envOf = c => scene.npcEnv(c.chat, { address: c.chat.findLast?.(m => m.extra?.worldscrawl_location)?.extra.worldscrawl_location ?? BAR });
const cast = () => scene.castPack().npcs;
const folded = (c, id) => framesOf(c.chat, c.chat.length - 1, cast(), envOf(c).clock).at(-1).get(id);
const day0 = c => envOf(c).clock(0).day;
const stampsOf = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === type);
const presentIds = c => presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).map(n => n.id);
const factsText = async blocks => { await scene.applyFacts(); return Object.values(blocks).join('\n'); };
const waitFor = async (c, text) => { const m = say(c, text); const r = await bracketIntent(m, parseBracket(text)); assert.notEqual(r.kind, 'bracket_failed', r.note); await scene.prepareNpcs(m); reply(c, 'Time passes.'); return m; };
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
function draw(ids) { const doc = makeDoc(ids); globalThis.document = doc; renderPatchCards(); return doc; }
const remEl = doc => doc.querySelector('.worldscrawl_remembercard');
const box = (doc, k) => remEl(doc).querySelector(`.worldscrawl_${k}`);
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };

const isRemember = p => /Remember this person/.test(p);
const isPick = p => /^Choose a daily pattern for /.test(p);
const MAREN = { name: 'Maren', personality: { summary: 'A knife-grinder who works for Hesk.', manner: 'Brisk.', speech: 'Clipped.' }, appearance: { summary: 'wiry woman with a whetstone' }, facts: [], invented: [] };
const PICK = { pattern: 'day shift', job: BAR, job_activity: 'grinding knives', home: 'offmap: a lodging-house by the river', favorites: [SQ, LANE] };
const SMITH_PICK = { pattern: 'day shift', job: SMITHY, job_activity: 'working the forge', home: 'offmap: a room over the smithy', favorites: [SQ, LANE] };
/** The fake model: the Remember answer, the pattern answers (`pick(n, prompt)`; a string is sent as is, an Error is thrown), an empty tracker read otherwise. */
function fakeModel(c, { card = MAREN, pick = () => PICK } = {}) {
    const calls = { remember: [], pick: [], system: [], other: [] };
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (isRemember(p)) { calls.remember.push(p); return JSON.stringify(card); }
        if (isPick(p)) {
            calls.pick.push(p); calls.system.push(String(args?.systemPrompt ?? ''));
            const a = pick(calls.pick.length, p);
            if (a instanceof Error) throw a;
            return typeof a === 'string' ? a : JSON.stringify(a);
        }
        calls.other.push(p);
        return '{"place": null, "people": [], "wait": null}';
    };
    return calls;
}
/** A Remember card for Maren on message 1 (the player standing in `here`), drawn, its remember answer in (and the pattern question asked). */
async function rememberCard(opts = {}) {
    SP.scheduleErrors.clear(); SP.scheduleWarnings.clear();
    const { c, blocks, server } = boot({ time: opts.time ?? '10:00', cards: opts.cards ?? [], here: opts.here ?? BAR });
    const calls = fakeModel(c, opts);
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    let doc = draw([0, 1]);
    await flush(80);
    if (byText(remEl(doc), 'Close editor')) { byText(remEl(doc), 'Close editor').click(); await flush(10); doc = draw([0, 1]); } // an editor left open by an earlier test
    return { c, blocks, calls, doc, server, card: () => c.chat[1].extra[scene.REMEMBER_KEY] };
}
const editWith = async (r, fields) => {
    byText(remEl(r.doc), 'Edit').click();
    await flush(10);
    for (const [k, v] of Object.entries(fields)) type(box(r.doc, k), v);
    byText(remEl(r.doc), 'Approve edited').click();
    await flush(80);
};
const approveCard = async r => { byText(remEl(r.doc), 'Approve').click(); await flush(80); };
const toasts = [];
globalThis.toastr = { info: t => toasts.push(String(t)), success: t => toasts.push(String(t)), warning: t => toasts.push(String(t)), error: t => toasts.push(String(t)) };
const scheduleNotes = m => callNotes(m).filter(n => n.kind === 'schedule');
const { callNotes } = await import('../../extension/calllog.mjs');
const { placeResolver } = await import('../../plugin/ui/castdata.mjs');

// ---- the places a pick is read against (the live map's shape: rooms {name, private}, areas, stubs)
const PLACES = {
    rooms: new Map([[BAR, { name: 'Common Room' }], [SQ, { name: 'Village Square' }], [LANE, { name: 'Market Lane' }], [STORE, { name: "Marlow's General Store" }], [UP, { name: 'Upstairs', private: true }],
        ['riverton:gilded_goose/common_room', { name: 'Common Room' }], [FORGE, { name: "Brask's Smithy" }], [TUNNEL, { name: 'Secret Tunnel', private: true }], ['larkspur:green/green', { name: 'Larkspur Green' }]]),
    areas: new Map([[RAT, 'The Drowned Rat'], ['riverton:streets', 'Streets'], [SMITHY, "Brask's Smithy"], [TUNNEL_AREA, 'Secret Tunnel'], ['riverton', 'Riverton'], ['larkspur', 'Larkspur']]),
    stubs: new Map([['wikerton', 'Wikerton']]),
};
const NEAR = { rooms: new Set([...PLACES.rooms.keys()]), subs: new Set([RAT, 'riverton:streets', SMITHY, TUNNEL_AREA]), regions: new Set(['riverton', 'larkspur']), stubs: new Map([['wikerton', { name: 'Wikerton' }]]) };

// ---- 3. spotsCover
test('spotsCover: a region key covers its own rooms (and a subregion its rooms, as before); a longer key, a lookalike region or another region does not', () => {
    assert.ok(spotsCover(['riverton'], YARD));
    assert.ok(spotsCover(['riverton'], 'riverton:streets/square'));
    assert.ok(!spotsCover(['larkspur'], YARD));
    assert.ok(!spotsCover(['river'], YARD), 'a lookalike region prefix is not a region');
    assert.ok(spotsCover([BAR], BAR) && spotsCover([RAT], YARD) && spotsCover(['riverton:streets'], SQ));
    assert.ok(!spotsCover(['riverton:drowned'], YARD) && !spotsCover([RAT], SQ));
    assert.ok(!spotsCover([RAT], 'riverton:drowned_rat_annex/room'), 'a subregion key does not cover a sibling with its name as a prefix');
});
test('spotsCover through the real Remember card: a typed region favorite covers the met room, so the met room is not added to the free-time block or the card line; a subregion that does not cover it still adds it', async () => {
    const r = await rememberCard({ time: '19:00', here: STORE });
    assert.match(r.calls.pick[0], /met in Marlow's General Store at 19:00/);
    await editWith(r, { sched_favorites: 'riverton' });
    const [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.pick.favorites, ['riverton']);
    assert.deepEqual(sch.schedule.find(e => e.from === '18:30').might, ['riverton(40)'], 'one option: the region covers the store (before the fix: riverton(20) plus the store)');
    assert.deepEqual(sch.schedule.find(e => e.from === '12:00').might, ['riverton(30)']);
    assert.doesNotMatch(sch.about, /Marlow/, 'and the card line has no extra spot');
    assert.match(sch.about, /free time around Riverton$/);
    assert.equal(metSpotBlock(sch.pick, { room: STORE, minutes: H(19) }), null);
    // A subregion favorite that does not hold the room still adds it (the existing guard).
    const r2 = await rememberCard({ time: '19:00', here: STORE });
    await editWith(r2, { sched_favorites: 'riverton:streets' });
    const [s2] = stampsOf(r2.c.chat[1], 'npc_schedule');
    assert.deepEqual(s2.schedule.find(e => e.from === '18:30').might, ['riverton:streets(20)', `${STORE}(20)`]);
    assert.match(s2.about, /free time around Streets, Marlow's General Store$|free time around Riverton Streets, Marlow's General Store$/);
});

// ---- 1. Area jobs: reading
test('readSchedulePick: an area is a job by key or by name (job_area true), a room job has no job_area key, a region key is a job, an unknown key is unchanged', () => {
    const ok = (raw, opts) => { const r = readSchedulePick({ pattern: 'day shift', ...raw }, PLACES, opts); assert.ok(r.pick, r.error); return r; };
    assert.equal(ok({ job: SMITHY }).pick.job, SMITHY);
    assert.equal(ok({ job: SMITHY }).pick.job_area, true);
    assert.equal(ok({ job: 'The Drowned Rat' }).pick.job, RAT, 'by name');
    assert.equal(ok({ job: 'the drowned rat' }).pick.job_area, true);
    assert.equal(ok({ job: 'riverton' }).pick.job, 'riverton', 'a region key is a legal job (never offered by the model list)');
    assert.equal(ok({ job: 'riverton' }).pick.job_area, true);
    assert.equal('job_area' in ok({ job: BAR }).pick, false, 'a room job carries no job_area key, so room-job deepEquals are unchanged');
    assert.equal('job_area' in ok({ job: 'offmap: the tannery' }).pick, false);
    assert.equal('job_area' in ok({ job: 'wikerton' }).pick, false, 'a stub');
    assert.equal('job_area' in ok({ job: null, pattern: 'passing through' }).pick, false);
    assert.equal('job_area' in ok({ job: 'Market Lane' }).pick, false, 'a room by name');
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'riverton:nope/room' }, PLACES).error, /job "riverton:nope\/room" is not in the list/);
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'riverton:nope' }, PLACES, { strict: true }).error, /is not in the list/);
    assert.equal(ok({ job: BAR, job_area: true }).pick.job_area, undefined, 'job_area is derived from the job, never typed or answered');
    assert.equal(ok({ job: SMITHY, job_area: false }).pick.job_area, true);
    for (const strict of [false, true]) {
        assert.equal(ok({ job: SMITHY }, { strict }).warnings.length, 0);
        assert.equal(ok({ job: RAT, favorites: [SQ] }, { strict }).pick.job_area, true);
    }
});
test('readSchedulePick: an area job with no public room is an ERROR on the model\'s pick (it is asked again) and a WARNING on a typed or strict read (the pick is still returned)', () => {
    const lenient = readSchedulePick({ pattern: 'day shift', job: TUNNEL_AREA }, PLACES);
    assert.match(lenient.error, /^job "riverton:secret_tunnel" has no public room; name a room in it, or offmap: a few words$/);
    assert.equal(lenient.pick, undefined);
    const strict = readSchedulePick({ pattern: 'day shift', job: TUNNEL_AREA }, PLACES, { strict: true });
    assert.equal(strict.error, undefined);
    assert.equal(strict.pick.job, TUNNEL_AREA);
    assert.equal(strict.pick.job_area, true);
    assert.deepEqual(strict.warnings, ['job "riverton:secret_tunnel" has no public room, so they are away at work until one is public or the block is set to Anywhere']);
    // By name: the one-room area and its room share a name, the area wins.
    assert.equal(readSchedulePick({ pattern: 'night shift', job: 'Secret Tunnel' }, PLACES, { strict: true }).pick.job, TUNNEL_AREA);
    // An area with no rooms at all in the list is the same (the model list never offers one).
    const empty = { ...PLACES, areas: new Map([...PLACES.areas, ['riverton:empty', 'Empty Lot']]) };
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'riverton:empty' }, empty).error, /has no public room/);
    assert.ok(readSchedulePick({ pattern: 'day shift', job: 'riverton:empty' }, empty, { strict: true }).pick);
    // A region key is checked with the fixed spotsCover: it holds public rooms.
    assert.ok(readSchedulePick({ pattern: 'day shift', job: 'riverton' }, PLACES).pick);
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'larkspur' }, { ...PLACES, rooms: new Map([[TUNNEL, { private: true }]]) }).error, /has no public room/);
});
test('readSchedulePick: a room and its own area sharing a name read as the area (job and favorites); two rooms in different areas still say ambiguous; a home is never an area', () => {
    const lenient = raw => readSchedulePick({ pattern: 'day shift', job: BAR, ...raw }, PLACES);
    assert.equal(readSchedulePick({ pattern: 'day shift', job: "Brask's Smithy" }, PLACES).pick.job, SMITHY);
    assert.equal(readSchedulePick({ pattern: 'day shift', job: "brask's smithy" }, PLACES, { strict: true }).pick.job_area, true);
    assert.deepEqual(lenient({ favorites: ["Brask's Smithy"] }).pick.favorites, [SMITHY], 'favorites: the same rule, the area');
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'Common Room' }, PLACES).error, /matches .*common_room.*common_room.*; use the key/);
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'Common Room' }, PLACES, { strict: true }).error, /use the key/);
    // Home: a room by that name is the room; an area key is dropped with the warning (lenient) or an error (strict).
    assert.equal(lenient({ home: "Brask's Smithy" }).pick.home, FORGE);
    assert.equal(lenient({ home: "Brask's Smithy" }).pick.job_area, undefined);
    const h = lenient({ home: SMITHY });
    assert.equal(h.pick.home, null);
    assert.match(h.warnings.join(' '), /^home dropped \(off the map instead\): home "riverton:smithy" is an area; name one room in it$/);
    assert.match(readSchedulePick({ pattern: 'day shift', job: BAR, home: SMITHY }, PLACES, { strict: true }).error, /^home "riverton:smithy" is an area; name one room in it$/);
    // An area job with an area home: the job holds, the home drops.
    const both = readSchedulePick({ pattern: 'day shift', job: SMITHY, home: SMITHY }, PLACES);
    assert.deepEqual([both.pick.job, both.pick.job_area, both.pick.home], [SMITHY, true, null]);
    // Favorites unchanged: unknown and private dropped, at most three.
    const fav = lenient({ favorites: [UP, 'riverton:nope', SQ, RAT, LANE, STORE] });
    assert.deepEqual(fav.pick.favorites, [SQ, RAT, LANE]);
});
test('the editor text of an area job: shown by name, read back strict, job_area re-derived every time (it can never go stale)', () => {
    const pick = readSchedulePick({ pattern: 'day shift', job: SMITHY, job_activity: 'working the forge' }, PLACES).pick;
    const label = a => PLACES.rooms.get(a)?.name ?? PLACES.areas.get(a) ?? a;
    assert.equal(pickValues(pick, label).sched_job, "Brask's Smithy");
    const back = readSchedulePick(SP_pickFromValues(pick, {}, []), PLACES, { strict: true });
    assert.equal(back.pick.job_area, true, 'unchanged boxes keep the job and re-derive the flag');
    const toRoom = readSchedulePick(SP_pickFromValues(pick, { sched_job: 'Common Room (The Drowned Rat)' }, ['sched_job']), PLACES, { strict: true });
    assert.match(toRoom.error ?? '', /./, 'a typed name two places share is an error');
    const room = readSchedulePick(SP_pickFromValues(pick, { sched_job: BAR }, ['sched_job']), PLACES, { strict: true });
    assert.equal('job_area' in room.pick, false, 'the typed room clears it');
    const area = readSchedulePick(SP_pickFromValues({ ...pick, job: BAR, job_area: undefined }, { sched_job: RAT }, ['sched_job']), PLACES, { strict: true });
    assert.equal(area.pick.job_area, true, 'the typed area sets it');
    assert.equal(SCHEDULE_FIELDS.find(f => f[0] === 'sched_job')[2], 'a room or an area, or offmap: a few words (empty for none)');
});
import { pickFromValues as SP_pickFromValues } from '../../plugin/shared/npc.mjs';

// ---- 1. Area jobs: expansion
test('expandPattern: an area job writes the work blocks as might [area(100)], wandering, importance high; free time and home as before; no overlaps, loads clean', () => {
    const pick = { pattern: 'day shift', job: SMITHY, job_area: true, job_activity: 'working the forge', home: 'offmap: a room over the smithy', favorites: [SQ, LANE] };
    const day = expandPattern(pick, { room: FORGE, minutes: H(10) });
    assert.deepEqual(day, [
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '08:00', to: '12:00', wandering: true, importance: 'high' },
        { might: [`${SQ}(15)`, `${LANE}(15)`], activity: 'out and about', from: '12:00', to: '13:00' },
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '13:00', to: '17:00', wandering: true, importance: 'high' },
        { activity: 'at home', where: 'home', near: 'a room over the smithy', from: '17:00', to: '18:30' },
        { might: [`${SQ}(20)`, `${LANE}(20)`], activity: 'out and about', from: '18:30', to: '20:00', wandering: true },
        { activity: 'at home', where: 'home', near: 'a room over the smithy', from: '20:00', to: '08:00' },
    ]);
    const night = expandPattern({ ...pick, pattern: 'night shift' }, { room: FORGE, minutes: H(19) });
    assert.deepEqual(night.filter(e => e.might && e.importance), [
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '18:00', to: '22:00', wandering: true, importance: 'high' },
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '23:00', to: '03:00', wandering: true, importance: 'high' },
    ]);
    assert.deepEqual(night.map(e => [e.from, e.to]), [['03:00', '14:30'], ['14:30', '16:00'], ['16:00', '18:00'], ['18:00', '22:00'], ['22:00', '23:00'], ['23:00', '03:00']]);
    for (const [name, sched] of [['day', day], ['night', night]]) {
        const v = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: sched }, { file: 'x.json', places: new Set([...NEAR.rooms]), nearIndex: NEAR });
        assert.deepEqual([v.ok, v.problems, v.warnings], [true, [], []], `${name}: no overlap, no place note`);
    }
    // The work blocks are wandering and high; the room job is untouched (is-at entries, as before S2).
    const room = expandPattern({ ...pick, job: FORGE, job_area: undefined }, { room: FORGE, minutes: H(10) });
    assert.deepEqual(room[0], { place: FORGE, activity: 'working the forge', from: '08:00', to: '12:00', importance: 'high' });
    // No favorites: free time goes around the job area (an area key is its own area); a region job: the region.
    assert.deepEqual(expandPattern({ ...pick, favorites: [] }, { room: SQ, minutes: H(10) }).find(e => e.from === '12:00').might, [`${SMITHY}(30)`]);
    assert.deepEqual(expandPattern({ ...pick, job: 'riverton', favorites: [] }, { room: SQ, minutes: H(10) }).find(e => e.from === '12:00').might, ['riverton(30)']);
    assert.deepEqual(expandPattern({ ...pick, job: 'riverton' }, { room: SQ, minutes: H(10) })[0].might, ['riverton(100)']);
    // The card line says "around" for an area and "at" for a room.
    const names = { [SMITHY]: "Brask's Smithy", [FORGE]: "Brask's Smithy", [SQ]: 'Village Square', [LANE]: 'Market Lane' };
    assert.match(pickSummary(pick, { nameOf: a => names[a] }), /^Day shift around Brask's Smithy \(08:00–17:00, working the forge\), home a room over the smithy \(off the map\); free time around Village Square, Market Lane$/);
    assert.match(pickSummary({ ...pick, job: FORGE, job_area: undefined }, { nameOf: a => names[a] }), /^Day shift at Brask's Smithy /);
});
test('an area job schedule saves through /cast/save with no warnings, and the cast list reads it back', () => {
    const { server, dir } = boot({ cards: [] });
    const pick = { pattern: 'night shift', job: SMITHY, job_area: true, job_activity: 'banking the forge', home: FORGE, favorites: [SQ] };
    const npc = { id: 'brask', name: 'Brask', personality: { summary: 'A smith.' }, schedule: expandPattern(pick, { room: FORGE, minutes: H(19) }) };
    const r = server.post('/cast/save?world=riverton', { json: { npc } });
    assert.equal(r.status_code, 200, JSON.stringify(r.json()));
    assert.deepEqual(r.json().warnings ?? [], []);
    const back = server.get('/cast').json().npcs.find(n => n.id === 'brask');
    assert.equal(back.schedule.filter(e => Array.isArray(e.might) && e.importance === 'high').length, 2);
    fs.rmSync(path.join(dir, 'cast', 'brask.json'));
});

// ---- 1. Area jobs through the real handlers
test('the Brask case through the Remember card: the model names the building (an area key), one schedule call, no retry, the card says "around", Approve stamps the might job blocks and pick.job_area; typed Job by name and by key work with no model call; a typed area Home is a card error', async () => {
    const r = await rememberCard({ here: FORGE, pick: () => ({ ...SMITH_PICK, home: null, favorites: [] }) });
    assert.equal(r.calls.pick.length, 1, 'one schedule call: no retry');
    assert.match(r.calls.pick[0], /met in Brask's Smithy at 10:00/);
    assert.deepEqual(scheduleNotes(r.c.chat[1]).map(n => [n.status, n.tries ?? 1]), [['ok', 1]]);
    const line = remEl(r.doc).querySelector('.worldscrawl_schedule').textContent;
    assert.match(line, /^Schedule: Day shift around Brask's Smithy \(08:00–17:00, working the forge\), home off the map; free time around Brask's Smithy$/);
    assert.doesNotMatch(remEl(r.doc).textContent, /passing through/i);
    assert.equal(r.card().schedule.status, 'ok');
    assert.equal(r.card().schedule.pick.job_area, true);
    await approveCard(r);
    const [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.equal(sch.pick.job, SMITHY);
    assert.equal(sch.pick.job_area, true);
    assert.deepEqual(sch.schedule.filter(e => e.importance === 'high'), [
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '08:00', to: '12:00', wandering: true, importance: 'high' },
        { might: [`${SMITHY}(100)`], activity: 'working the forge', from: '13:00', to: '17:00', wandering: true, importance: 'high' },
    ]);
    assert.match(sch.about, /^Day shift around Brask's Smithy/);
    assert.equal(r.calls.pick.length, 1, 'Approve used the cached answer');
    assert.doesNotMatch(JSON.stringify(sch.schedule), /passingThrough|about their own business/);
    // Typed Job: by name and by key, no model call.
    for (const typed of ["Brask's Smithy", SMITHY]) {
        const e = await rememberCard({ here: FORGE, pick: () => ({ ...PICK, favorites: [SQ] }) });
        assert.equal(stampsOf(e.c.chat[1], 'npc_schedule').length, 0);
        await editWith(e, { sched_job: typed });
        const [s2] = stampsOf(e.c.chat[1], 'npc_schedule');
        assert.equal(e.calls.pick.length, 1, `typed ${typed}: no model call`);
        assert.deepEqual([s2.pick.job, s2.pick.job_area], [SMITHY, true]);
        assert.deepEqual(s2.schedule[0].might, [`${SMITHY}(100)`]);
        assert.equal(s2.schedule[0].wandering, true);
    }
    // A typed area Home is an error on the card, and nothing is saved.
    const h = await rememberCard({ here: FORGE, pick: () => SMITH_PICK });
    byText(remEl(h.doc), 'Edit').click();
    await flush(10);
    type(box(h.doc, 'sched_home'), SMITHY);
    byText(remEl(h.doc), 'Approve edited').click();
    await flush(60);
    assert.match(remEl(h.doc).querySelector('.worldscrawl_schedule_error').textContent, /home "riverton:smithy" is an area; name one room in it/);
    assert.equal(stampsOf(h.c.chat[1], 'npc_schedule').length, 0, 'nothing saved');
    assert.equal(h.card().status, 'review');
});

test('3b: a typed all-private area job saves with a warning (not an error); before Anywhere they are away at job hours with the "No public room" note; the chat editor sets Anywhere on those blocks and they resolve to the private room; the cast-file editor does the same with no warning', async () => {
    toasts.length = 0;
    const r = await rememberCard({ pick: () => ({ ...PICK, favorites: [SQ] }) });
    await editWith(r, { sched_job: TUNNEL_AREA });
    assert.equal(r.calls.pick.length, 1, 'no model call');
    assert.equal(remEl(r.doc), null, 'the card closed: saved');
    const [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.ok(sch, 'saved with the warning');
    assert.deepEqual(sch.schedule.filter(e => e.importance === 'high').map(e => e.might), [[`${TUNNEL_AREA}(100)`], [`${TUNNEL_AREA}(100)`]]);
    assert.equal(sch.pick.job_area, true);
    assert.ok(toasts.some(t => /Schedule: job "riverton:secret_tunnel" has no public room, so they are away at work until one is public or the block is set to Anywhere/.test(t)), toasts.join(' | '));
    assert.ok(!toasts.some(t => /error|could not|isn't|not in the list/i.test(t)), 'a warning, not an error');
    assert.equal(SP.scheduleWarnings.get(`1|remember`), 'job "riverton:secret_tunnel" has no public room, so they are away at work until one is public or the block is set to Anywhere');
    assert.equal(SP.scheduleErrors.get('1|remember'), undefined);
    // Before Anywhere: away at job hours with the note.
    const c = r.c, id = stampsOf(c.chat[1], 'npc_create')[0].id;
    const env = envOf(c);
    for (const d of [1, 2, 3]) {
        const s = scheduleAt(folded(c, id), { day: day0(c) + d, minutes: H(9) }, env);
        assert.deepEqual([s.kind, s.address], ['might', null]);
        assert.match(s.note, /^No public room in .*Secret Tunnel.* to pick, so away this time\.$/);
    }
    // The chat editor (one npc_schedule stamp) sets Anywhere on the job blocks.
    const resolve = placeResolver(r.server.get('/cast').json());
    const play = scene.mapNpcs(c.chat, { address: BAR }).find(n => n.id === id);
    const form = formFromPlay(play);
    const jobRows = form.schedule.filter(row => row.kind === 'might' && /secret_tunnel/.test(row.options));
    assert.equal(jobRows.length, 2);
    for (const row of jobRows) row.anywhere = true;
    const { stamps, cannot } = chatStamps(play, form, { resolve });
    assert.deepEqual(cannot, []);
    assert.deepEqual(stamps.map(s => s.type), ['npc_schedule'], 'one npc_schedule stamp');
    assert.deepEqual(stamps[0].schedule.filter(e => e.anywhere).map(e => [e.from, e.to]), [['08:00', '12:00'], ['13:00', '17:00']]);
    const res = await scene.npcChatEdit({ chatId: 'group2', msg: c.chat.length - 1, swipe: c.chat.at(-1).swipe_id ?? null, id, stamps });
    assert.equal(res.ok, true, JSON.stringify(res));
    const env2 = envOf(c), seen = new Set();
    for (let k = 0; k < 200; k++) {
        const s = scheduleAt(folded(c, id), { day: day0(c) + 1 + Math.floor(k / 8), minutes: H(8) + (k % 16) * 15 }, env2);
        if (s.kind === 'might' && H(8) + (k % 16) * 15 < H(12)) seen.add(s.address);
    }
    assert.deepEqual([...seen], [TUNNEL], 'over 200 segments: the private room, never away');
    const s9 = scheduleAt(folded(c, id), { day: day0(c) + 1, minutes: H(9) }, env2);
    assert.match(mightWhy(folded(c, id), s9, env2), /its only room in .*Secret Tunnel.* \(private rooms included\)\./);
    assert.match(npcWhy(folded(c, id), c.chat.length - 1, env2).schedule?.why ?? '', /./);
    // The cast-file editor: a hand-written entry with anywhere saves with no warning; without the flag it saves too and is away at runtime.
    const { server, dir } = boot({ cards: [] });
    const entry = flag => ({ might: [TUNNEL_AREA], activity: 'digging', from: '09:00', to: '12:00', ...(flag ? { anywhere: true } : {}) });
    const save = (id2, flag) => server.post('/cast/save?world=riverton', { json: { npc: { id: id2, name: id2, personality: { summary: 'Digs.' }, schedule: [entry(flag)] } } });
    const withFlag = save('digwith', true), without = save('digwithout', false);
    assert.equal(withFlag.status_code, 200, JSON.stringify(withFlag.json()));
    assert.deepEqual(withFlag.json().warnings ?? [], [], 'saves with no warning');
    assert.equal(without.status_code, 200, 'saves');
    assert.ok(!(without.json().warnings ?? []).some(w => /anywhere/.test(w)));
    const back = server.get('/cast').json().npcs;
    assert.equal(back.find(n => n.id === 'digwith').schedule[0].anywhere, true);
    assert.notEqual(back.find(n => n.id === 'digwithout').schedule[0].anywhere, true);
    assert.ok(!('anywhere' in JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'digwithout.json'), 'utf8')).schedule[0]), 'the file has no anywhere key when it is not set');
    fs.rmSync(path.join(dir, 'cast', 'digwith.json')); fs.rmSync(path.join(dir, 'cast', 'digwithout.json'));
});
import { formFromPlay } from '../../plugin/ui/castdata.mjs';

test('runtime: an area job in a one-room area is the same room every segment (no conversion to is-at), segments 15-60 minutes, never away; rooms made in play join the pool (the public one, never the private one)', async () => {
    const BRASK = { id: 'brask', name: 'Brask', personality: { summary: 'The smith, a broad man.' }, disposition: { player: { value: 'indifferent' } },
        schedule: expandPattern({ pattern: 'day shift', job: SMITHY, job_area: true, job_activity: 'working the forge', home: null, favorites: [SQ] }, { room: FORGE, minutes: H(10) }) };
    assert.equal(BRASK.schedule[0].might[0], `${SMITHY}(100)`);
    const { c } = boot({ time: '10:00', cards: [BRASK] });
    let env = envOf(c);
    for (const minutes of [H(9), H(14)]) for (let d = 0; d < 300; d++) {
        const s = scheduleAt(folded(c, 'brask'), { day: day0(c) + d, minutes }, env);
        assert.equal(s.address, FORGE, `${d} ${minutes}`);
        assert.equal(s.kind, 'might');
        assert.equal(s.entry.wandering, true);
        assert.equal(s.how, 'area');
        assert.deepEqual(s.area, { address: SMITHY, name: "Brask's Smithy", of: 1 });
        const len = s.segEnd - s.segStart;
        assert.ok(len >= 15 && len <= 60 && len % 15 === 0 || s.segEnd === s.blockEnd, `segment ${len}`);
    }
    assert.match(mightWhy(folded(c, 'brask'), scheduleAt(folded(c, 'brask'), env.clock(0), env), env), /Area: .*, its only public room in Brask's Smithy\./);
    // Rooms made in play: a public one and a private one in the smithy.
    const PUB = `${SMITHY}/back_room`, PRIV = `${SMITHY}/strongroom`;
    c.chat[0].extra.worldscrawl_patches = [
        { type: 'patch', id: 'p_back', swipe: 0, relocate: {}, summary: ['A back room'], ops: [{ op: 'create_place', area: SMITHY, id: 'back_room', name: 'Back Room', description: 'Tools on hooks.', exits: [{ direction: 'east', to: FORGE, return_direction: 'west' }] }] },
        { type: 'patch', id: 'p_strong', swipe: 0, relocate: {}, summary: ['A strongroom'], ops: [{ op: 'create_place', area: SMITHY, id: 'strongroom', name: 'Strongroom', description: 'Iron door.', exits: [{ direction: 'north', to: FORGE, return_direction: 'south' }] }, { op: 'set_private', target: PRIV, value: true }] },
    ];
    await ext.refreshLivePlaces();
    env = envOf(c);
    const seen = new Set();
    for (let d = 0; d < 300; d++) seen.add(scheduleAt(folded(c, 'brask'), { day: day0(c) + d, minutes: H(9) + (d % 4) * 15 }, env).address);
    assert.ok(seen.has(FORGE) && seen.has(PUB), [...seen].join(','));
    assert.ok(!seen.has(PRIV), 'the private room never');
    assert.equal(scheduleAt(folded(c, 'brask'), env.clock(0), env).area.of, 2, 'two public rooms now');
    c.chat[0].extra.worldscrawl_patches = [];
    await ext.refreshLivePlaces();
});

test('presence: in the forge at 09:00 Brask is stamped and present, the narrator facts carry no engine words; a [wait] across 07:00-13:00 gives one arrival per work block and one departure at lunch (the one-room merge), no per-segment lines; [find] works from a room of a bigger area job and stamps the whole block', async () => {
    const day = expandPattern({ pattern: 'day shift', job: SMITHY, job_area: true, job_activity: 'working the forge', home: null, favorites: [SQ] }, { room: FORGE, minutes: H(10) });
    const BRASK = { id: 'brask', name: 'Brask', personality: { summary: 'The smith, a broad man.' }, disposition: { player: { value: 'indifferent' } }, schedule: day };
    const INNER = { id: 'odo', name: 'Odo', personality: { summary: 'The ostler.' }, disposition: { player: { value: 'indifferent' } },
        schedule: expandPattern({ pattern: 'day shift', job: RAT, job_area: true, job_activity: 'minding the inn', home: null, favorites: [SQ] }, { room: BAR, minutes: H(10) }) };
    {
        const { c, blocks } = boot({ time: '09:00', here: FORGE, cards: [BRASK, INNER] });
        const m = say(c, 'I watch the smith.');
        await scene.prepareNpcs(m);
        const ap = stampsOf(m, 'npc_appear').filter(s => s.id === 'brask');
        assert.equal(ap.length, 1);
        assert.ok(ap[0].segStart != null && ap[0].blockStart != null, 'a wandering block: stamped with the segment');
        assert.equal(ap[0].place, FORGE);
        assert.ok(presentIds(c).includes('brask'));
        const text = await factsText(blocks);
        const people = text.slice(text.indexOf('People here'), text.indexOf('You stays'));
        assert.match(people, /Brask \[\w+\]: .*Now: working the forge/);
        assert.doesNotMatch(people, /\b(might|wandering|anywhere|area|schedule|block)\b|\d+%/i, 'in-world words only');
    }
    {
        const { c, blocks } = boot({ time: '07:00', here: FORGE, cards: [BRASK, INNER] });
        assert.ok(!presentIds(c).includes('brask'));
        await waitFor(c, '[wait] until 13:00');
        const text = await factsText(blocks);
        const lines = text.split('\n').filter(l => /Brask (arrives|leaves)/.test(l));
        assert.deepEqual(lines, ['[08:00] Brask arrives.', '[12:00] Brask leaves.', '[13:00] Brask arrives.'], 'one arrival per work block, one departure at lunch: segments merge');
        assert.doesNotMatch(text, /Brask .*(wanders|moves)/);
    }
    // [find]: Odo's work area (the Drowned Rat) holds the courtyard; find him from a room he is not in at the moment.
    const probe = boot({ time: '10:00', cards: [BRASK, INNER] });
    const pe = envOf(probe.c);
    const spot = scheduleAt(folded(probe.c, 'odo'), pe.clock(0), pe).address;
    assert.ok([BAR, YARD, STABLE].includes(spot), `public rooms only: ${spot}`);
    const here = [BAR, YARD, STABLE].find(a => a !== spot);
    const { c } = boot({ time: '10:00', here, cards: [BRASK, INNER] });
    const m = say(c, '[find] Odo');
    const rr = await bracketIntent(m, parseBracket(m.mes));
    assert.equal(rr.kind, 'found', rr.note);
    const d = (m.extra[FOUND_KEY] ?? []).find(x => x.source === 'bracket');
    assert.deepEqual([d.ok, d.moved, d.place], [true, true, here]);
    const [ap] = stampsOf(m, 'npc_appear').filter(s => s.source === 'bracket');
    assert.equal(ap.whole, true);
    assert.equal(ap.place, here);
    assert.ok(presentIds(c).includes('odo'));
});

// ---- 1. Prompts
test('the pattern prompts: same ids, titles, group, locked text and piece flag; reworded for area jobs; the Areas list omits an all-private area; the retry carries the new sentence; masked; no "anywhere" flag in them', async () => {
    const byId = Object.fromEntries(PROMPTS.prompts.map(e => [e.id, e]));
    const sys = byId['npc.schedule_pick_system'], q = byId['npc.schedule_pick'], retry = byId['npc.schedule_pick_retry'];
    assert.equal(sys.title, 'People: pick a daily pattern, system');
    assert.equal(q.title, 'People: pick a daily pattern');
    assert.equal(retry.title, 'People: pick a daily pattern, retry line');
    for (const e of [sys, q, retry]) { assert.equal(e.group, 'npc', e.id); assert.equal(typeof e.locked, 'string', e.id); }
    assert.equal(retry.piece, true);
    assert.match(sys.text, /job is a room KEY when .* or an area KEY/);
    assert.match(sys.text, /home is a room KEY/);
    assert.match(sys.text, /an area job means anywhere public in that area/);
    assert.match(sys.text, /\{\{reply\}\}: \{"pattern": "day shift\|night shift\|passing through\|unsure", "job": "KEY or offmap: short text or null"/, 'the JSON template is unchanged: the game reads the same keys');
    assert.match(PROMPTS.placeholders.place_list, /an area is listed only when it has a public room/);
    assert.match(PROMPTS.groups.find(g => g.id === 'npc').flow, /a job \(a room or an area\) and a home \(a room\)/);
    const npc = groupPrompts(PROMPTS.prompts, PROMPTS.groups).find(g => g.group.id === 'npc');
    assert.ok(npc.main.some(e => e.id === 'npc.schedule_pick') && npc.main.some(e => e.id === 'npc.schedule_pick_system'), 'both main entries show in the Prompt Manager');
    assert.ok(npc.pieces.some(e => e.id === 'npc.schedule_pick_retry'));
    // The pick can't set Anywhere: the word is only in "anywhere public in that area".
    for (const e of [sys, q, retry]) assert.doesNotMatch(e.text.replace(/anywhere public in that area/gi, ''), /anywhere/i, e.id);
    // The real handler: the question and the retry.
    const r = await rememberCard({ pick: n => (n === 1 ? { ...PICK, job: 'riverton:nope/room' } : PICK) });
    assert.equal(r.calls.pick.length, 2);
    const p = r.calls.pick[0];
    assert.match(p, /Places \(KEY: name\)\. A job may be a room KEY or an area KEY; a home must be a room KEY:\n/);
    assert.match(p, /spots at that hour\)\. If this is where they work, make it their job: this room's KEY, or its area's KEY when their work takes them around more than this room\.\n\nReply with JSON only\.$/);
    assert.match(r.calls.system[0], /job is a room KEY when .* or an area KEY/);
    assert.match(r.calls.pick[1], /\n\nYour last answer did not fit: job "riverton:nope\/room" is not in the list .*\. Fix it\. A job is a room KEY or an area KEY from the list \(or offmap: and a few words\); a home is a room KEY\.$/);
    assert.doesNotMatch(p + r.calls.system[0], /Hesk/, 'masking: the unknown landlady is not named in the sent prompt');
    assert.doesNotMatch(p + r.calls.system[0] + r.calls.pick[1], /"anywhere"|anywhere:|anywhere flag/i);
    // The Areas list: a public area is offered, an all-private area is not (it could never resolve for a job or favorite).
    const list = p.slice(p.indexOf('Areas (anywhere public inside):'), p.indexOf('\nOff the map:')).split('\n');
    assert.ok(list.includes(`- ${SMITHY}: Brask's Smithy`) || !p.includes(`${FORGE}:`), 'the smithy is offered when its room is listed');
    assert.ok(list.includes(`- ${RAT}: The Drowned Rat`));
    assert.ok(!list.some(l => l.startsWith(`- ${TUNNEL_AREA}:`)), 'the all-private Secret Tunnel is not offered as an area');
    assert.ok(p.includes(`- ${TUNNEL}: Secret Tunnel`), 'its room is still listed, marked private');
    const places = await SP.pickPlaces(BAR);
    assert.ok(!places.areas.has(TUNNEL_AREA) && !places.areas.has('riverton:catacombs') && places.areas.has(RAT));
    // A model answer that names the all-private area is not on its list at all, so it is asked again; one that tries to set anywhere is ignored.
    const bad = await rememberCard({ pick: n => (n === 1 ? { ...PICK, job: TUNNEL_AREA } : { ...PICK, job: SMITHY, anywhere: true, job_area: false }) });
    assert.equal(bad.calls.pick.length, 2);
    assert.match(bad.calls.pick[1], /Your last answer did not fit: job "riverton:secret_tunnel" is not in the list .*\. Fix it\./);
    assert.deepEqual(bad.card().schedule.pick, { pattern: 'day shift', job: SMITHY, job_activity: 'grinding knives', home: PICK.home, favorites: [SQ, LANE], job_area: true });
    await approveCard(bad);
    const [sch] = stampsOf(bad.c.chat[1], 'npc_schedule');
    assert.ok(!JSON.stringify(sch.schedule).includes('anywhere'), 'the pick and the expansion never write anywhere');
});

// ---- 2. The anywhere flag
const card = (id, name, schedule) => ({ id, name, personality: { summary: `${name}, a local.` }, disposition: { player: { value: 'indifferent' } }, schedule });
const INN = (extra = {}) => ({ might: [`${RAT}(100)`], activity: 'seeing to the inn', from: '13:00', to: '15:00', wandering: true, ...extra });
const ANY_CARDS = [
    card('wren', 'Wren', [INN({ anywhere: true })]),
    card('wick', 'Wick', [INN()]),
    card('nell', 'Nell', [{ might: [CELLAR], activity: 'fetching ale', from: '13:00', to: '15:00', anywhere: true }]),
    card('nick', 'Nick', [{ might: [CELLAR], activity: 'fetching ale', from: '13:00', to: '15:00' }]),
    card('digger', 'Digger', [{ might: [TUNNEL_AREA], activity: 'digging', from: '09:00', to: '12:00' }]),
    card('delver', 'Delver', [{ might: [TUNNEL_AREA], activity: 'digging', from: '09:00', to: '12:00', anywhere: true }]),
];
const sweep = (c, id, { from = H(13), to = H(15), days = 60 } = {}) => {
    const env = envOf(c), out = [];
    for (let d = 0; d < days; d++) for (let m = from; m < to; m += 15) out.push(scheduleAt(folded(c, id), { day: day0(c) + d, minutes: m }, env));
    return out;
};
const addrs = list => new Set(list.map(s => s.address));
const PRIVATE_RAT = [UP, KITCH, CELLAR], PUBLIC_RAT = [BAR, YARD, STABLE];

test('schema: anywhere is a boolean on a might entry (true/false read, "yes" breaks that entry only); mightKey appends it only when true so existing seeds never move; it survives tidyRecord, /cast/save, the cast list and exportRecord', async () => {
    assert.equal(readMightEntry(INN({ anywhere: true })).entry.anywhere, true);
    assert.equal(readMightEntry(INN({ anywhere: false })).entry.anywhere, false);
    assert.equal(readMightEntry(INN()).entry.anywhere, false);
    const bad = readMightEntry(INN({ anywhere: 'yes' }));
    assert.match(bad.problems.join(), /anywhere must be true or false/);
    assert.equal(bad.entry.broken, true);
    assert.match(bad.entry.problem, /anywhere must be true or false/);
    // A hand-written file: the broken entry blocks only that entry, with the load note.
    const v = validateRecord({ id: 'x', name: 'X', line: 'x', schedule: [INN({ anywhere: 'yes' }), { place: BAR, activity: 'drinking', from: '16:00', to: '18:00' }] }, { file: 'x.json', places: NEAR.rooms, nearIndex: NEAR });
    assert.match([...v.problems, ...v.warnings].join('\n'), /schedule\[0\]: anywhere must be true or false/);
    assert.equal(v.schedule[0].broken, true);
    assert.ok(!v.schedule[1].broken);
    // mightKey: byte-identical without the flag (seeds), different with it.
    const base = { might: [`${RAT}(100)`], from: '13:00', to: '15:00', wandering: true, activity: 'seeing to the inn' };
    const today = JSON.stringify([base.might, base.from, base.to, true, base.activity]);
    assert.equal(mightKey(base), today);
    assert.equal(mightKey({ ...base, anywhere: false }), today);
    assert.equal(mightKey({ ...base, anywhere: 'yes' }), today, 'only a true flag counts');
    assert.notEqual(mightKey({ ...base, anywhere: true }), today);
    assert.equal(mightKey({ ...base, anywhere: true }), JSON.stringify([base.might, base.from, base.to, true, base.activity, 'anywhere']));
    // tidyRecord keeps a boolean, drops anything else.
    const kept = tidyRecord({ id: 'x', name: 'X', personality: { summary: 'x' }, schedule: [INN({ anywhere: true }), INN({ anywhere: 'yes' })] });
    assert.equal(kept.schedule[0].anywhere, true);
    assert.ok(!('anywhere' in kept.schedule[1]));
    // /cast/save and the cast list keep it; the file carries it only when true.
    const { server, dir, c } = boot({ cards: ANY_CARDS });
    const list = server.get('/cast').json().npcs;
    assert.equal(list.find(n => n.id === 'wren').schedule[0].anywhere, true);
    assert.notEqual(list.find(n => n.id === 'wick').schedule[0].anywhere, true);
    const saved = server.post('/cast/save?world=riverton', { json: { npc: { id: 'wren2', name: 'Wren Two', personality: { summary: 'x' }, schedule: [INN({ anywhere: true })] } } });
    assert.equal(saved.status_code, 200, JSON.stringify(saved.json()));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'wren2.json'), 'utf8')).schedule[0].anywhere, true);
    fs.rmSync(path.join(dir, 'cast', 'wren2.json'));
    // exportRecord: a played person's export keeps it (authored), and the fallback row writes it too.
    const play = scene.mapNpcs(c.chat, { address: BAR }).find(n => n.id === 'wren');
    assert.equal(play.record.schedule[0].anywhere, true);
    const fallback = exportRecord({ id: 'z', name: 'Z', line: 'x', schedule: [{ might: [RAT], options: [], activity: 'x', from: '09:00', to: '10:00', wandering: true, anywhere: true }] });
    assert.equal(fallback.schedule[0].anywhere, true);
    assert.ok(!('anywhere' in exportRecord({ id: 'z', name: 'Z', line: 'x', schedule: [{ might: [RAT], options: [], activity: 'x', from: '09:00', to: '10:00' }] }).schedule[0]));
    // A flagged entry with no area option loads with a warning (not broken, saves still allowed).
    const noArea = validateRecord({ id: 'x', name: 'X', line: 'x', schedule: [{ might: [SQ, `${BAR}(10)`], activity: 'x', from: '09:00', to: '10:00', anywhere: true }] }, { file: 'x.json', places: NEAR.rooms, nearIndex: NEAR });
    assert.ok(noArea.warnings.includes('x.json schedule[0]: "anywhere" has no effect: no option is an area'), noArea.warnings.join('|'));
    assert.equal(noArea.ok, true);
    assert.deepEqual(noArea.problems, noArea.warnings, 'only the note');
    assert.ok(!noArea.schedule[0].broken);
    const withArea = validateRecord({ id: 'x', name: 'X', line: 'x', schedule: [INN({ anywhere: true })] }, { file: 'x.json', places: NEAR.rooms, nearIndex: NEAR });
    assert.deepEqual([withArea.problems, withArea.warnings], [[], []]);
    const viaServer = server.post('/cast/save?world=riverton', { json: { npc: { id: 'noarea', name: 'Noarea', personality: { summary: 'x' }, schedule: [{ might: [SQ], activity: 'x', from: '09:00', to: '10:00', anywhere: true }] } } });
    assert.equal(viaServer.status_code, 200);
    assert.match((viaServer.json().warnings ?? []).join('\n'), /"anywhere" has no effect: no option is an area/);
    fs.rmSync(path.join(dir, 'cast', 'noarea.json'));
});
import { tidyRecord } from '../../plugin/cast.mjs';

test('resolver through scheduleAt in a fresh chat: with the flag an area option picks private rooms too; without it never; a named private room works either way; an all-private area is away without the flag and picks with it', () => {
    const { c } = boot({ time: '14:00', cards: ANY_CARDS });
    const withFlag = sweep(c, 'wren');
    assert.equal(withFlag.length, 480);
    const seen = addrs(withFlag);
    for (const a of [UP, CELLAR, KITCH, ...PUBLIC_RAT]) assert.ok(seen.has(a), `anywhere: ${a} turns up in ${[...seen].join(',')}`);
    assert.ok(withFlag.every(s => s.kind === 'might' && s.how === 'area' && s.area.name === 'The Drowned Rat'));
    assert.equal(withFlag[0].area.of, 6, 'six rooms to choose from with the flag');
    const without = sweep(c, 'wick');
    assert.deepEqual([...addrs(without)].sort(), PUBLIC_RAT.sort(), 'regression: never a private room');
    assert.equal(without[0].area.of, 3);
    // Not wandering: one room per block, still honoring the flag.
    // A named private room: with and without.
    for (const id of ['nell', 'nick']) for (const s of sweep(c, id)) assert.equal(s.address, CELLAR, id);
    // An area of only private rooms.
    for (const s of sweep(c, 'digger', { from: H(9), to: H(12), days: 5 })) { assert.deepEqual([s.kind, s.address], ['might', null]); assert.match(s.note, /^No public room in .*Secret Tunnel.* to pick, so away this time\.$/); }
    for (const s of sweep(c, 'delver', { from: H(9), to: H(12), days: 5 })) { assert.equal(s.address, TUNNEL); assert.equal(s.note, undefined); }
    // The roll of an entry without the flag is the same as before: the flagged twin rolls differently (a re-roll, since the pool changed).
    const a = sweep(c, 'wick').map(s => s.roll), b = sweep(c, 'wren').map(s => s.roll);
    assert.notDeepEqual(a, b);
});

test('[find] through the typed handler: from the cellar, the flagged block brings her (whole-block stamp, narrator told in-world words); without the flag it is rejected; /ws-find and the flag source agree', async () => {
    const probe = boot({ time: '13:00', cards: ANY_CARDS });
    const times = ['13:00', '13:15', '13:30', '13:45', '14:00', '14:15'].filter(t => { const [h, m] = t.split(':').map(Number); return sweep(probe.c, 'wren', { from: H(h, m), to: H(h, m) + 1, days: 1 })[0].address !== CELLAR; });
    assert.ok(times.length > 0);
    const time = times[0];
    const find = async (c, name, via = 'bracket') => { const m = say(c, `[find] ${name}`); const r = await bracketIntent(m, parseBracket(m.mes)); return { m, r, d: (m.extra[FOUND_KEY] ?? []).find(x => x.source === 'bracket') }; };
    // With the flag.
    {
        const { c, blocks } = boot({ time, here: CELLAR, cards: ANY_CARDS });
        const before = sweep(c, 'wren', { from: H(...time.split(':').map(Number)), to: H(...time.split(':').map(Number)) + 1, days: 1 })[0];
        assert.ok(before.address && before.address !== CELLAR, 'precondition: she is elsewhere in the inn');
        const { m, r, d } = await find(c, 'Wren');
        assert.equal(r.kind, 'found', r.note);
        assert.deepEqual([d.ok, d.moved, d.place, d.here], [true, true, CELLAR, undefined]);
        assert.equal(d.reason, 'Found: Wren comes here.');
        const [ap] = stampsOf(m, 'npc_appear').filter(s => s.source === 'bracket');
        assert.deepEqual([ap.id, ap.place, ap.whole, ap.blockStart != null], ['wren', CELLAR, true, true]);
        await scene.prepareNpcs(m);
        assert.ok(presentIds(c).includes('wren'));
        const text = await factsText(blocks);
        assert.match(blocks[ext.REMINDER_KEY] ?? '', /^Wren came in just now and is here at the end of this reply\. Show them arriving\.$/m);
        const people = text.slice(text.indexOf('People here'), text.indexOf('You stays'));
        assert.match(people, /Wren \[\w+\]: .*Now: seeing to the inn/);
        assert.doesNotMatch(people, /anywhere|private|\bmight\b|wander|%|\bblock\b|\bflag\b/i, 'in-world words only: the narrator never sees the flag');
        assert.ok(whoAt(c.chat, c.chat.length - 1, cast(), envOf(c), CELLAR).some(x => x.id === 'wren' && x.here), "Who's here lists her in the cellar");
        // The slash form and the flag source go through the same judge.
        const c2 = boot({ time, here: CELLAR, cards: ANY_CARDS }).c;
        const m2 = say(c2, '/ws-find Wren');
        const slash = await scene.runFind(m2, 'Wren', { via: 'slash' });
        assert.equal(slash.outcome, 'found');
        const c3 = boot({ time, here: CELLAR, cards: ANY_CARDS }).c;
        const m3 = say(c3, 'She comes down the cellar steps.');
        const [flag] = await scene.applyFound(m3, ['Wren'], 'flag');
        assert.deepEqual([flag.ok, flag.moved, flag.place], [true, true, CELLAR]);
    }
    // Without the flag: the cellar is not an option.
    {
        const { c, blocks } = boot({ time, here: CELLAR, cards: ANY_CARDS });
        const { m, r, d } = await find(c, 'Wick');
        assert.equal(r.kind, 'found', 'narrated: a known person who is not around');
        assert.equal(d.ok, false);
        assert.equal(d.reason, "Wick wouldn't be around here right now.");
        assert.deepEqual(stampsOf(m, 'npc_appear').filter(s => s.source === 'bracket'), []);
        const c2 = boot({ time, here: CELLAR, cards: ANY_CARDS }).c;
        const slash = await scene.runFind(say(c2, '/ws-find Wick'), 'Wick', { via: 'slash' });
        assert.deepEqual([slash.outcome, slash.reason], ['absent', "Wick wouldn't be around here right now."]);
        const c3 = boot({ time, here: CELLAR, cards: ANY_CARDS }).c;
        const [flag] = await scene.applyFound(say(c3, 'x'), ['Wick'], 'flag');
        assert.equal(flag.ok, false);
        assert.equal(flag.reason, "Wick wouldn't be around here right now.");
        assert.ok(!whoAt(c.chat, c.chat.length - 1, cast(), envOf(c), CELLAR).some(x => x.id === 'wick' && x.here));
    }
});

test("Who's here and the inspector with the flag: the cellar lists her with the might reason; mightWhy says the private rooms are included (and the one-room wording)", async () => {
    // A moment she is not in the cellar: Who's here still lists her there as a place she might be, with the reason; Wick is not listed at all.
    const { c } = boot({ time: '14:00', here: CELLAR, cards: ANY_CARDS });
    const env = envOf(c);
    const sched = scheduleAt(folded(c, 'wren'), env.clock(0), env);
    const rows = whoAt(c.chat, c.chat.length - 1, cast(), env, CELLAR);
    const wren = rows.find(r => r.id === 'wren');
    assert.ok(wren, 'listed');
    if (sched.address !== CELLAR) assert.match(wren.reason, /^Not here: .*Wandering 13:00–15:00/);
    assert.ok(!rows.some(r => r.id === 'wick'), 'without the flag the cellar is not one of her places');
    assert.ok(sched.area.of === 6);
    assert.match(mightWhy(folded(c, 'wren'), sched, env), /highest of 6 rooms in The Drowned Rat \(private rooms included\)\./);
    assert.doesNotMatch(mightWhy(folded(c, 'wick'), scheduleAt(folded(c, 'wick'), env.clock(0), env), env), /private rooms included/);
    assert.match(mightWhy(folded(c, 'wick'), scheduleAt(folded(c, 'wick'), env.clock(0), env), env), /highest of 3 rooms in The Drowned Rat\./);
    // The inspector (npcWhy): the schedule reason carries the tail.
    assert.match(npcWhy(folded(c, 'wren'), c.chat.length - 1, env).schedule.why, /private rooms included/);
    // Land on a block where she IS in the cellar: here, with the might kind.
    let hit = null;
    for (let d = 0; d < 60 && !hit; d++) for (let m = H(13); m < H(15) && !hit; m += 15) { const s = scheduleAt(folded(c, 'wren'), { day: day0(c) + d, minutes: m }, env); if (s.address === CELLAR) hit = { d, m }; }
    assert.ok(hit, 'the cellar turns up for the flagged block');
});

test('cast editor: the might row has an Anywhere checkbox next to Wandering; it writes anywhere only when set, an untouched row is its authored entry byte for byte, toggling off removes the key, mightText shows it; the chat-side editor save changes only that chat', async () => {
    const { server, dir, c } = boot({ time: '14:00', cards: ANY_CARDS });
    const data = server.get('/cast').json();
    const resolve = placeResolver(data);
    const wren = data.npcs.find(n => n.id === 'wren'), wick = data.npcs.find(n => n.id === 'wick');
    // The model: carried at every spot.
    assert.equal(mightFormRow(wren.schedule[0]).anywhere, true);
    assert.equal(mightFormRow(wick.schedule[0]).anywhere, false);
    const rec = f => recordFromForm(f, { resolve }).schedule;
    const untouched = formFromRecord(wren);
    assert.equal(JSON.stringify(rec(untouched)[0]), JSON.stringify(ANY_CARDS[0].schedule[0]), 'byte for byte (key order kept)');
    const off = formFromRecord(wren); off.schedule[0].anywhere = false;
    assert.ok(!('anywhere' in rec(off)[0]), 'toggling off removes the key');
    const on = formFromRecord(wick); on.schedule[0].anywhere = true;
    assert.equal(rec(on)[0].anywhere, true);
    assert.equal(JSON.stringify(Object.keys(rec(on)[0])), JSON.stringify(['might', 'activity', 'from', 'to', 'wandering', 'anywhere']));
    assert.match(mightText({ might: [RAT], wandering: true, anywhere: true, from: '13:00', to: '15:00' }), /\(wandering, anywhere\), 13:00–15:00$/);
    assert.match(mightText({ might: [RAT], anywhere: true, from: '13:00', to: '15:00' }), /\(anywhere\), 13:00–15:00$/);
    assert.match(mightText({ might: [RAT], wandering: true, from: '13:00', to: '15:00' }), /\(wandering\), 13:00–15:00$/);
    assert.match(MIGHT_HELP, /Anywhere lets an area option include private rooms too, like Hesk anywhere in the inn\./);
    // The panel (fakedom): the row shows both boxes.
    const doc = makeDoc();
    const saved = [];
    const panel = castPanel(doc, {
        load: async () => server.get('/cast').json(), outline: async () => null, play: () => null, placeName: a => a,
        save: async (npc, original, originalFile) => { saved.push(npc); const res = server.post('/cast/save?world=riverton', { json: { npc, ...(original ? { original } : {}), ...(originalFile ? { original_file: originalFile } : {}) } }); if (res.status_code >= 400) throw new Error(JSON.stringify(res.json())); return res.json(); },
    });
    await panel.refresh();
    panel.selectId('wick', 'resolved');
    panel.el.querySelectorAll('.cast-saveas')[0].click();
    const row = () => panel.el.querySelectorAll('.cf-sched')[0];
    assert.ok(row().querySelectorAll('.cf-wandering').length === 1 && row().querySelectorAll('.cf-anywhere').length === 1, 'both boxes in the row');
    const any = row().querySelectorAll('.cf-anywhere')[0];
    assert.equal(!!any.checked, false);
    assert.match(row().textContent, /Anywhere/);
    any.checked = true; any.dispatchEvent({ type: 'change' });
    panel.el.querySelectorAll('.cast-save')[0].click();
    panel.el.querySelectorAll('.cast-confirm')[0].click();
    await flush(40);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].schedule, [{ might: [`${RAT}(100)`], activity: 'seeing to the inn', from: '13:00', to: '15:00', wandering: true, anywhere: true }]);
    // The chat-side editor: one npc_schedule stamp, honored in that chat only.
    const play = scene.mapNpcs(c.chat, { address: BAR }).find(n => n.id === 'wick');
    const form = formFromPlay(play); form.schedule[0].anywhere = true;
    const { stamps } = chatStamps(play, form, { resolve });
    assert.deepEqual(stamps.map(s => s.type), ['npc_schedule']);
    assert.equal(stamps[0].schedule[0].anywhere, true);
    const before = addrs(sweep(c, 'wick'));
    assert.ok(![...before].some(a => PRIVATE_RAT.includes(a)));
    const res = await scene.npcChatEdit({ chatId: 'group2', msg: c.chat.length - 1, swipe: c.chat.at(-1).swipe_id ?? null, id: 'wick', stamps });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = addrs(sweep(c, 'wick'));
    assert.ok(PRIVATE_RAT.every(a => after.has(a)), [...after].join(','));
    const other = boot({ time: '14:00', cards: ANY_CARDS }).c;
    assert.ok(![...addrs(sweep(other, 'wick'))].some(a => PRIVATE_RAT.includes(a)), 'a fresh chat is unchanged');
    // The saved card file for the flagged copy keeps the key.
    const files = fs.readdirSync(path.join(dir, 'cast'));
    for (const f of files.filter(x => !ANY_CARDS.some(k => `${k.id}.json` === x) && x !== 'hesk.json')) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cast', f), 'utf8')).schedule[0].anywhere, true);
        fs.rmSync(path.join(dir, 'cast', f));
    }
});
