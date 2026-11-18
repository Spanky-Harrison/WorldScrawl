// S2 schedules: the daily patterns (day shift, night shift, passing through) the engine expands, and the one pattern
// question Remember asks. The chat side runs through the real handlers: a real world server behind the fetch shim, the
// real Remember card drawn with fakedom (offerRemember, renderPatchCards, card clicks through cardacts), a fake model.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';
import { validateRecord } from '../../plugin/npc.mjs';
import { FAVORITES_MAX, PATTERNS, PICK_PATTERNS, SCHEDULE_FIELDS, expandPattern, metSpotBlock, spotsCover, passingThrough, pickFromValues, pickSummary, pickValues, readSchedulePick, spotShares } from '../../plugin/shared/npc.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const SP = await import('../../extension/schedulepick.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { liveCalls, busyLines, callLabel } = await import('../../extension/work.mjs');
const { callNotes } = await import('../../extension/calllog.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { groupPrompts } = await import('../../plugin/ui/prompteditor.mjs');
await loadCalendar();
const { NPC_KEY, framesOf, presentAt, scheduleAt, offmapAbsentLine } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, SQ = 'riverton:streets/square', LANE = 'riverton:streets/market_lane', STORE = 'riverton:general_store/shop';
const UP = 'riverton:drowned_rat/upstairs', CELLAR = 'riverton:drowned_rat/cellar', KITCH = 'riverton:drowned_rat/kitchens', YARD = 'riverton:drowned_rat/courtyard', STABLE = 'riverton:drowned_rat/stable', RAT = 'riverton:drowned_rat';
const H = (h, m = 0) => h * 60 + m;
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- the harness (the same shape as schedule-s1b.test.mjs, plus the drawn card)
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
function boot({ time = '10:00', cards = [] } = {}) {
    exitsCache.clear();
    const { server } = serverFor(cards);
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
    c.chatId = 'sched2'; c.getCurrentChatId = () => 'sched2';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'The common room is quiet.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: BAR } }];
    return { c, blocks, server };
}
const say = (c, text) => { const m = { is_user: true, mes: text, swipe_id: 0, extra: {} }; c.chat.push(m); return m; };
const reply = (c, text, extra = {}) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }; c.chat.push(m); return m; };
const envOf = c => scene.npcEnv(c.chat, { address: c.chat.findLast?.(m => m.extra?.worldscrawl_location)?.extra.worldscrawl_location ?? BAR });
const cast = () => scene.castPack().npcs;
const day0 = c => envOf(c).clock(0).day;
const stampsOf = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === type);
const playPerson = (c, id) => framesOf(c.chat, c.chat.length - 1, cast()).at(-1)?.get(id);
const waitFor = async (c, text) => { const m = say(c, text); const r = await bracketIntent(m, parseBracket(text)); assert.notEqual(r.kind, 'bracket_failed', r.note); return m; };
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
function draw(ids) { const doc = makeDoc(ids); globalThis.document = doc; renderPatchCards(); return doc; }
const remEl = doc => doc.querySelector('.worldscrawl_remembercard');
const box = (doc, k) => remEl(doc).querySelector(`.worldscrawl_${k}`);
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
const scheduleNotes = m => callNotes(m).filter(n => n.kind === 'schedule');

const isRemember = p => /Remember this person/.test(p);
const isPick = p => /^Choose a daily pattern for /.test(p);
const MAREN = { name: 'Maren', personality: { summary: 'A knife-grinder who works for Hesk.', manner: 'Brisk.', speech: 'Clipped.' }, appearance: { summary: 'wiry woman with a whetstone' }, facts: [], invented: [] };
const PICK = { pattern: 'day shift', job: BAR, job_activity: 'grinding knives', home: 'offmap: a lodging-house by the river', favorites: [SQ, LANE] };
/**
 * The fake model: the Remember answer, the pattern answers (`pick(n, prompt)`: the nth pattern call; a string is sent as
 * is, an Error is thrown), and an empty tracker read for everything else. `gate` holds the pattern answer back.
 */
function fakeModel(c, { card = MAREN, pick = () => PICK, gate = null } = {}) {
    const calls = { remember: [], pick: [], system: [], other: [] };
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (isRemember(p)) { calls.remember.push(p); return JSON.stringify(card); }
        if (isPick(p)) {
            calls.pick.push(p); calls.system.push(String(args?.systemPrompt ?? ''));
            if (gate) await gate.promise;
            const a = pick(calls.pick.length, p);
            if (a instanceof Error) throw a;
            return typeof a === 'string' ? a : JSON.stringify(a);
        }
        calls.other.push(p);
        return '{"place": null, "people": [], "wait": null}';
    };
    return calls;
}
const gateOf = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
/** A Remember card for Maren on message 1, drawn, its remember answer in (and the pattern question asked). */
async function rememberCard(opts = {}) {
    const { c, blocks } = boot({ time: opts.time ?? '10:00', cards: opts.cards ?? [] });
    const calls = fakeModel(c, opts);
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    const doc = draw([0, 1]);
    await flush(80);
    return { c, blocks, calls, doc, card: () => c.chat[1].extra[scene.REMEMBER_KEY] };
}

// ---- 1. The patterns, expanded.
test('day shift expands exactly to the plan: job 08-12 and 13-17 (high), home 17:00-18:30 and 20-08, lunch 30% normal, evening 40% wandering; no overlaps', () => {
    const s = expandPattern(PICK, { room: SQ, minutes: H(10) });
    assert.deepEqual(s, [
        { place: BAR, activity: 'grinding knives', from: '08:00', to: '12:00', importance: 'high' },
        { might: [`${SQ}(15)`, `${LANE}(15)`], activity: 'out and about', from: '12:00', to: '13:00' },
        { place: BAR, activity: 'grinding knives', from: '13:00', to: '17:00', importance: 'high' },
        { activity: 'at home', where: 'home', near: 'a lodging-house by the river', from: '17:00', to: '18:30' },
        { might: [`${SQ}(20)`, `${LANE}(20)`], activity: 'out and about', from: '18:30', to: '20:00', wandering: true },
        { activity: 'at home', where: 'home', near: 'a lodging-house by the river', from: '20:00', to: '08:00' },
    ]);
    const v = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: s }, { file: 'x.json', places: new Set([BAR, SQ, LANE]) });
    assert.deepEqual([v.ok, v.problems, v.warnings], [true, [], []], 'engine-made: no overlap note, no warning');
});

test('night shift expands exactly to the plan: job 18-22 and 23-03 (high), home 03:00-14:30 and 16-18, break 30% normal, afternoon 40% wandering; no overlaps', () => {
    const pick = { pattern: 'night shift', job: BAR, job_activity: null, home: UP, favorites: [] };
    const s = expandPattern(pick, { room: SQ, minutes: H(23) });
    assert.deepEqual(s, [
        { place: UP, activity: 'at home', from: '03:00', to: '14:30' },
        { might: [`${RAT}(40)`], activity: 'out and about', from: '14:30', to: '16:00', wandering: true },
        { place: UP, activity: 'at home', from: '16:00', to: '18:00' },
        { place: BAR, activity: 'working', from: '18:00', to: '22:00', importance: 'high' },
        { might: [`${RAT}(30)`], activity: 'out and about', from: '22:00', to: '23:00' },
        { place: BAR, activity: 'working', from: '23:00', to: '03:00', importance: 'high' },
    ], 'no favorites: the spots are the area of the job room (the Drowned Rat), not of the met room');
    const v = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: s }, { file: 'x.json', places: new Set([BAR, UP, RAT]) });
    assert.deepEqual([v.ok, v.problems, v.warnings], [true, [], []]);
    // The free-time blocks are the only wandering ones; the job and break are not.
    assert.deepEqual(s.filter(e => e.wandering).map(e => e.from), ['14:30']);
    assert.deepEqual(expandPattern({ ...pick, pattern: 'day shift' }, { room: SQ }).filter(e => e.wandering).map(e => e.from), ['18:30']);
});

test('spots: favorites split the total (remainder to the first); none: the job room\'s area, else (job off the map or a stub) the met room\'s area', () => {
    assert.deepEqual(spotShares(['a', 'b', 'c'], 30), ['a(10)', 'b(10)', 'c(10)']);
    assert.deepEqual(spotShares(['a', 'b', 'c'], 40), ['a(14)', 'b(13)', 'c(13)']);
    assert.deepEqual(spotShares(['a'], 40), ['a(40)']);
    const lunch = pick => expandPattern(pick, { room: SQ }).find(e => e.from === '12:00').might;
    assert.deepEqual(lunch({ pattern: 'day shift', job: BAR, favorites: [SQ, LANE, STORE] }), [`${SQ}(10)`, `${LANE}(10)`, `${STORE}(10)`]);
    assert.deepEqual(lunch({ pattern: 'day shift', job: 'offmap: the tannery', favorites: [] }), ['riverton:streets(30)'], 'off-map job: the met room\'s area');
    assert.deepEqual(lunch({ pattern: 'day shift', job: 'wikerton', favorites: [] }), ['riverton:streets(30)'], 'a stub job: the met room\'s area');
    const job = expandPattern({ pattern: 'day shift', job: 'offmap: the tannery', job_activity: 'tanning hides', favorites: [] }, { room: SQ })[0];
    assert.deepEqual(job, { activity: 'tanning hides', near: 'the tannery', from: '08:00', to: '12:00', importance: 'high' }, 'an off-map job: near the text');
    assert.deepEqual(expandPattern({ pattern: 'day shift', job: 'wikerton', favorites: [] }, { room: SQ })[0], { activity: 'working', near: 'wikerton', from: '08:00', to: '12:00', importance: 'high' }, 'a stub job: near the stub id');
    assert.deepEqual(expandPattern({ pattern: 'day shift', job: BAR, home: null, favorites: [] }, { room: SQ }).at(-1), { activity: 'at home', where: 'home', from: '20:00', to: '08:00' }, 'no home: off the map');
});

test('passing through is the pattern of that name and the Remember default: passingThrough(room, minutes) is exactly what Remember wrote before S2; a pick\'s home is used', () => {
    // The S1b output, written out: met at 16:17 in the common room.
    const before = [
        { might: [`${BAR}(50)`], activity: 'out and about', from: '15:00', to: '17:00' },
        { activity: 'at home', where: 'home', from: '20:00', to: '07:00' },
        { activity: 'about their own business' },
    ];
    assert.deepEqual(passingThrough(BAR, H(16, 17)), before);
    assert.deepEqual(expandPattern(null, { room: BAR, minutes: H(16, 17) }), before, 'no pick');
    for (const pattern of ['passing through', 'unsure']) assert.deepEqual(expandPattern({ pattern, job: BAR, favorites: [SQ] }, { room: BAR, minutes: H(16, 17) }), before, pattern);
    assert.deepEqual(expandPattern({ pattern: 'day shift', job: null }, { room: BAR, minutes: H(16, 17) }), before, 'a shift with no job');
    assert.deepEqual(expandPattern({ pattern: 'passing through', home: UP }, { room: BAR, minutes: H(2) }).slice(1, 3), [
        { place: UP, activity: 'at home', from: '20:00', to: '01:00' }, { place: UP, activity: 'at home', from: '03:00', to: '07:00' }]);
    const src = fs.readFileSync(new URL('../../plugin/shared/npc.mjs', import.meta.url), 'utf8');
    assert.equal(src.match(/out and about/g).length, 2, 'one free-time builder for the shifts, one block for passing through: no copy of the expander');
});

test('met-place guard: met inside a free-time block in a room the spots do not cover, that room joins that block (and only that block); covered, at work or passing through: nothing added', () => {
    const evening = (pick, room, minutes) => expandPattern(pick, { room, minutes }).find(e => e.from === '18:30').might;
    const lunch = (pick, room, minutes) => expandPattern(pick, { room, minutes }).find(e => e.from === '12:00').might;
    // A day-shifter met at 19:00 in the general store, favorites the square and the lane: the store joins the evening.
    assert.deepEqual(evening(PICK, STORE, H(19)), [`${SQ}(14)`, `${LANE}(13)`, `${STORE}(13)`]);
    assert.deepEqual(lunch(PICK, STORE, H(19)), [`${SQ}(15)`, `${LANE}(15)`], 'the other block is untouched');
    assert.deepEqual(lunch(PICK, STORE, H(12, 30)), [`${SQ}(10)`, `${LANE}(10)`, `${STORE}(10)`], 'met at lunch: the lunch block');
    assert.deepEqual(metSpotBlock(PICK, { room: STORE, minutes: H(19) }), ['18:30', '20:00']);
    // Covered: the room itself, or an area holding it (a favorite area, or the default job-room area).
    assert.deepEqual(evening(PICK, SQ, H(19)), [`${SQ}(20)`, `${LANE}(20)`]);
    assert.deepEqual(evening({ ...PICK, favorites: ['riverton:streets'] }, LANE, H(19)), ['riverton:streets(40)']);
    assert.deepEqual(evening({ ...PICK, favorites: [] }, YARD, H(19)), [`${RAT}(40)`], 'no favorites: the job room\'s area covers the courtyard');
    assert.deepEqual(evening({ ...PICK, favorites: [] }, SQ, H(19)), [`${RAT}(20)`, `${SQ}(20)`], 'but not the square');
    assert.ok(spotsCover([RAT], YARD) && !spotsCover([RAT], SQ) && !spotsCover(['riverton:drowned'], YARD));
    // At work, at home or off-shift hours: nothing added.
    for (const m of [H(9), H(15), H(17, 30), H(20), H(3)]) assert.equal(metSpotBlock(PICK, { room: STORE, minutes: m }), null, String(m));
    assert.deepEqual(expandPattern(PICK, { room: STORE, minutes: H(9) }), expandPattern(PICK, { room: SQ, minutes: H(9) }));
    // Night shift: the break and the afternoon.
    const night = { pattern: 'night shift', job: BAR, favorites: [SQ] };
    assert.deepEqual(expandPattern(night, { room: STORE, minutes: H(22, 30) }).find(e => e.from === '22:00').might, [`${SQ}(15)`, `${STORE}(15)`]);
    assert.deepEqual(expandPattern(night, { room: STORE, minutes: H(15) }).find(e => e.from === '14:30').might, [`${SQ}(20)`, `${STORE}(20)`]);
    assert.equal(metSpotBlock(night, { room: STORE, minutes: H(19) }), null, 'at work');
    // Passing through is unaffected.
    assert.equal(metSpotBlock({ pattern: 'passing through', favorites: [SQ] }, { room: STORE, minutes: H(12, 30) }), null);
    assert.deepEqual(expandPattern({ pattern: 'passing through', favorites: [SQ] }, { room: STORE, minutes: H(12, 30) }), passingThrough(STORE, H(12, 30)));
    // Engine-made still: no overlap notes; and the summary names the met room too.
    const v = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: expandPattern(PICK, { room: STORE, minutes: H(19) }) }, { file: 'x.json', places: new Set([BAR, SQ, LANE, STORE]) });
    assert.deepEqual([v.problems, v.warnings], [[], []]);
    const names = { [BAR]: 'Common Room', [SQ]: 'Village Square', [LANE]: 'Market Lane', [STORE]: "Marlow's General Store" };
    assert.match(pickSummary(PICK, { nameOf: a => names[a], room: STORE, minutes: H(19) }), /free time around Village Square, Market Lane, Marlow's General Store$/);
    assert.match(pickSummary(PICK, { nameOf: a => names[a], room: STORE, minutes: H(9) }), /free time around Village Square, Market Lane$/);
});

// ---- 2. Reading the answer.
const PLACES = {
    rooms: new Map([[BAR, { name: 'Common Room' }], [SQ, { name: 'Village Square' }], [LANE, { name: 'Market Lane' }], [STORE, { name: "Marlow's General Store" }], [UP, { name: 'Upstairs', private: true }], ['riverton:gilded_goose/common_room', { name: 'Common Room' }]]),
    areas: new Map([[RAT, 'The Drowned Rat'], ['riverton:streets', 'Streets']]),
    stubs: new Map([['wikerton', 'Wikerton']]),
};
test('readSchedulePick (the model): matchEnum leniency, unsure is passing through, keys or exact names, offmap text, unknown or private favorites dropped, at most 3, a shift with no job passes through', () => {
    assert.deepEqual(PATTERNS, ['day shift', 'night shift', 'passing through']);
    assert.deepEqual(PICK_PATTERNS, [...PATTERNS, 'unsure']);
    const ok = raw => { const r = readSchedulePick(raw, PLACES); assert.ok(r.pick, r.error); return r; };
    assert.equal(ok({ pattern: 'Day Shift', job: BAR }).pick.pattern, 'day shift');
    assert.equal(ok({ pattern: 'the NIGHT SHIFT.', job: BAR }).pick.pattern, 'night shift');
    assert.equal(ok({ pattern: 'unsure' }).pick.pattern, 'passing through');
    assert.match(readSchedulePick({ pattern: 'shift' }, PLACES).error, /pattern must be one of/);
    assert.match(readSchedulePick('day shift', PLACES).error, /not a JSON object/);
    assert.deepEqual(ok({ pattern: 'day shift', job: 'market lane', home: 'offmap: a cottage', favorites: ['Village Square'] }).pick,
        { pattern: 'day shift', job: LANE, job_activity: null, home: 'offmap: a cottage', favorites: [SQ] }, 'names match as their key');
    assert.equal(ok({ pattern: 'night shift', job: 'wikerton', job_activity: 'hauling' }).pick.job, 'wikerton', 'a stub');
    assert.equal(ok({ pattern: 'night shift', job: BAR, home: 'null', favorites: null }).pick.home, null);
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'riverton:nope/room' }, PLACES).error, /job "riverton:nope\/room" is not in the list/);
    assert.match(readSchedulePick({ pattern: 'day shift', job: 'Common Room' }, PLACES).error, /matches .*; use the key/, 'two rooms share the name');
    assert.equal(ok({ pattern: 'day shift', job: RAT }).pick.job_area, true, 'an area is a legal job now');
    assert.match(readSchedulePick({ pattern: 'day shift', job: `offmap: ${'x'.repeat(81)}` }, PLACES).error, /at most 80 characters/);
    const r = ok({ pattern: 'day shift', job: BAR, favorites: [UP, 'riverton:nope', SQ, RAT, LANE, STORE] });
    assert.deepEqual(r.pick.favorites, [SQ, RAT, LANE], 'private and unknown dropped, then at most 3');
    assert.equal(FAVORITES_MAX, 3);
    assert.equal(r.warnings.length, 3);
    // A bad home (an area, unknown, ambiguous, too long) is off the map with a warning; a bad job is still an error.
    for (const home of [RAT, 'riverton:nope/room', 'Common Room', `offmap: ${'x'.repeat(81)}`, 7]) {
        const h = ok({ pattern: 'day shift', job: BAR, home });
        assert.equal(h.pick.home, null, String(home));
        assert.match(h.warnings.join(' '), /^home dropped \(off the map instead\): home[ :]/, String(home));
        assert.match(readSchedulePick({ pattern: 'day shift', job: BAR, home }, PLACES, { strict: true }).error, /^home/, `typed ${home} stays an error`);
    }
    assert.match(ok({ pattern: 'day shift', job: RAT, home: RAT }).warnings.join(' '), /home "riverton:drowned_rat" is an area; name one room in it/, 'an area job with an area home: the home is dropped');
    const nojob = ok({ pattern: 'night shift', job: null, favorites: [SQ] });
    assert.equal(nojob.pick.pattern, 'passing through');
    assert.match(nojob.warnings.join(' '), /night shift with no job, so passing through/);
});
test('readSchedulePick (the player\'s typed edit, strict): each lenient drop is an error instead, so a bad name shows on the card', () => {
    const strict = raw => readSchedulePick(raw, PLACES, { strict: true });
    assert.match(strict({ pattern: 'day shift', job: null }).error, /a day shift needs a job/);
    assert.match(strict({ pattern: 'day shift', job: BAR, home: 'Nowhereville' }).error, /home "Nowhereville" is not in the list/);
    assert.match(strict({ pattern: 'day shift', job: BAR, favorites: 'Village Square, Nowhereville' }).error, /favorites: "Nowhereville" is not in the list/);
    assert.match(strict({ pattern: 'day shift', job: BAR, favorites: 'Upstairs' }).error, /"Upstairs" is private/);
    assert.deepEqual(strict({ pattern: 'day shift', job: BAR, favorites: 'Village Square; Market Lane' }).pick.favorites, [SQ, LANE]);
    // The editor's text and back: unchanged boxes keep the pick, a changed one is read from the box.
    const vals = pickValues(PICK, a => PLACES.rooms.get(a)?.name ?? a);
    assert.deepEqual(vals, { sched_pattern: 'day shift', sched_job: 'Common Room', sched_home: 'offmap: a lodging-house by the river', sched_favorites: 'Village Square, Market Lane' });
    assert.deepEqual(pickFromValues(PICK, { sched_favorites: 'Market Lane' }, ['sched_favorites']), { ...PICK, favorites: 'Market Lane' });
    assert.deepEqual(SCHEDULE_FIELDS.map(f => f[1]), ['Pattern', 'Job', 'Home', 'Favorites']);
});

// ---- 3. The prompts.
test('the pattern prompts: locked, group npc, in the Prompt Manager\'s People group and the flow text; every placeholder described', () => {
    const byId = Object.fromEntries(PROMPTS.prompts.map(e => [e.id, e]));
    const sys = byId['npc.schedule_pick_system'], q = byId['npc.schedule_pick'], retry = byId['npc.schedule_pick_retry'];
    assert.equal(sys.title, 'People: pick a daily pattern, system');
    assert.equal(q.title, 'People: pick a daily pattern');
    for (const e of [sys, q, retry]) { assert.equal(e.group, 'npc', e.id); assert.equal(typeof e.locked, 'string', e.id); }
    assert.equal(retry.piece, true);
    assert.match(sys.text, /\{\{reply\}\}: \{"pattern": "day shift\|night shift\|passing through\|unsure"/);
    assert.match(q.text, /\{\{place_list\}\}/);
    for (const n of ['time', 'about', 'place_list']) assert.ok(PROMPTS.placeholders[n]?.length > 10, n);
    const npc = groupPrompts(PROMPTS.prompts, PROMPTS.groups).find(g => g.group.id === 'npc');
    assert.ok(npc.main.some(e => e.id === 'npc.schedule_pick') && npc.main.some(e => e.id === 'npc.schedule_pick_system'));
    assert.ok(npc.pieces.some(e => e.id === 'npc.schedule_pick_retry'));
    assert.match(PROMPTS.groups.find(g => g.id === 'npc').flow, /People: pick a daily pattern/);
    assert.equal(callLabel('schedule'), 'working out a schedule');
});

// ---- 4. The question through the real handlers.
test('Remember asks the pattern once the card is ready: shown on the card while it runs (not on the busy line), then the pick; Approve stamps the expanded schedule, the pick, the met room and time, and a summary', async () => {
    const gate = gateOf();
    const { c, calls, doc, card } = await rememberCard({ gate });
    assert.equal(calls.remember.length, 1);
    assert.equal(calls.pick.length, 1, 'asked once the card was ready');
    let el = remEl(doc);
    assert.equal(el.dataset.state, 'review');
    assert.match(el.textContent, /Working out a schedule…/);
    assert.ok(liveCalls().some(x => x.kind === 'schedule' && x.shown === 'card'), 'the call is live, shown on the card');
    assert.ok(!busyLines().includes('working out a schedule'), 'so not on the busy line');
    assert.deepEqual(btns(el), ['Check again', 'Edit', 'Approve', 'Discard'], 'no Check schedule again while it runs');
    gate.release();
    await flush(60);
    el = remEl(doc);
    assert.match(el.querySelector('.worldscrawl_schedule').textContent, /^Schedule: Day shift at Common Room \(08:00–17:00, grinding knives\), home a lodging-house by the river \(off the map\); free time around Village Square, Market Lane$/);
    assert.deepEqual(btns(el), ['Check again', 'Edit', 'Check schedule again', 'Approve', 'Discard']);
    assert.equal(card().schedule.status, 'ok');
    assert.deepEqual(card().schedule.pick, PICK);
    assert.deepEqual(scheduleNotes(c.chat[1]).map(n => n.status), ['ok']);
    // Redraws never ask again.
    draw([0, 1]); await flush(30);
    assert.equal(calls.pick.length, 1);
    byText(remEl(doc), 'Approve').click();
    await flush(80);
    assert.equal(calls.pick.length, 1, 'Approve used the cached answer');
    const m = c.chat[1];
    const [sch] = stampsOf(m, 'npc_schedule');
    assert.deepEqual(sch.schedule, expandPattern(PICK, { room: BAR, minutes: H(10) }));
    assert.deepEqual(sch.schedule.find(e => e.from === '18:30').might, [`${SQ}(20)`, `${LANE}(20)`], 'met at work (10:00): the met room is not added');
    assert.deepEqual([sch.pick, sch.met], [PICK, { room: BAR, minutes: H(10) }]);
    assert.match(sch.about, /^Day shift at Common Room/);
    assert.deepEqual(stampsOf(m, 'npc_stay').map(s => s.place), [BAR], 'the stay still holds them where they were met');
    const doc2 = draw([0, 1]);
    const note = doc2.querySelectorAll('.worldscrawl_npcchange').find(e => /schedule/.test(e.textContent));
    assert.match(note.textContent, /Character changed here: Maren: schedule — Day shift at Common Room .* \(6 entries\)/);
    assert.deepEqual(btns(note), ['Edit', 'Turn off', 'Undo']);
});

const PLACES_HEAD = 'Places (KEY: name). A job may be a room KEY or an area KEY; a home must be a room KEY:\n';
test('the question: the met room first, nearest rooms (at most 40, private marked), their areas and places off the map; the card\'s line and looks; masked (no unknown name)', async () => {
    const { calls } = await rememberCard({ cards: [] });
    const p = calls.pick[0];
    assert.match(p, /^Choose a daily pattern for Maren, met in Common Room at 10:00\.\nA knife-grinder who works for the landlady\. Looks: wiry woman with a whetstone\n/);
    assert.doesNotMatch(p, /Hesk/, 'the name portal masks the unknown landlady');
    assert.match(p, /The story since they showed up:\nMaren, the knife-grinder, works the wheel by the fire\./);
    assert.match(p, /\n\nThey were met here, in Common Room, at 10:00: pick a pattern that fits them being here then \(at work if this is their job, otherwise in their free time; the game keeps this place among their free-time spots at that hour\)\. If this is where they work, make it their job: this room's KEY, or its area's KEY when their work takes them around more than this room\.\n\nReply with JSON only\.$/);
    const list = p.slice(p.indexOf(PLACES_HEAD) + PLACES_HEAD.length, p.indexOf('\n\nThey were met here')).split('\n');
    assert.equal(list[0], `- ${BAR}: Common Room (The Drowned Rat)`);
    const rooms = list.slice(0, list.indexOf('Areas (anywhere public inside):'));
    assert.ok(rooms.length > 5 && rooms.length <= SP.PICK_ROOMS, String(rooms.length));
    assert.ok(rooms.includes(`- ${UP}: Upstairs Rooms (The Drowned Rat) [private]`), 'private rooms are marked');
    assert.ok(rooms.some(l => l.startsWith(`- ${SQ}: `)));
    assert.ok(list.includes(`- ${RAT}: The Drowned Rat`), 'the areas holding them');
    assert.ok(list.includes('Off the map:'));
    assert.match(calls.system[0], /^You choose the daily routine/);
    assert.match(calls.system[0], /Reply with JSON only|JSON/);
});

test('a bad answer is asked once more with the error, then fits; two bad answers (or errors) fall back to passing through; every outcome is noted as kind schedule', async () => {
    // Retry, then ok.
    let r = await rememberCard({ pick: n => (n === 1 ? { ...PICK, job: 'riverton:nope/room' } : PICK) });
    assert.equal(r.calls.pick.length, 2);
    assert.match(r.calls.pick[1], /\n\nYour last answer did not fit: job "riverton:nope\/room" is not in the list .*\. Fix it\. A job is a room KEY or an area KEY from the list \(or offmap: and a few words\); a home is a room KEY\.$/);
    assert.equal(r.card().schedule.status, 'ok');
    assert.deepEqual(scheduleNotes(r.c.chat[1]).map(n => [n.status, n.tries ?? 1]), [['ok', 2]]);
    // Two unusable answers: passing through, shown and noted.
    r = await rememberCard({ pick: () => 'I think she works days.' });
    assert.equal(r.calls.pick.length, 2);
    const el = remEl(r.doc);
    assert.match(el.querySelector('.worldscrawl_schedule_failed').textContent, /^Schedule: Couldn't decide, so passing through \(the answer is not a JSON object\)$/);
    const [note] = scheduleNotes(r.c.chat[1]);
    assert.deepEqual([note.status, note.tries], ['failed', 2]);
    assert.match(note.reason, /passing through instead$/);
    byText(el, 'Approve').click();
    await flush(80);
    const [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.schedule, passingThrough(BAR, H(10)), 'the fallback is exactly passing through');
    assert.equal(sch.pick.pattern, 'passing through');
    // The model errors out: the same fallback.
    r = await rememberCard({ pick: () => new Error('server is down') });
    assert.equal(r.card().schedule.status, 'failed');
    assert.match(remEl(r.doc).textContent, /Couldn't decide, so passing through \(server is down\)/);
    // A shift with no job: passing through without a retry (a warning on the ok note).
    r = await rememberCard({ pick: () => ({ pattern: 'day shift', job: null, favorites: [UP] }) });
    assert.equal(r.calls.pick.length, 1);
    assert.equal(r.card().schedule.pick.pattern, 'passing through');
    const [w] = scheduleNotes(r.c.chat[1]);
    assert.equal(w.status, 'ok');
    assert.match(w.reason, /is private/);
});

test('met-place guard through the real card: met at 19:00 in the common room by a day-shifter whose favorites miss it, it joins the evening (card, stamp, typed edit, Check again); a favorite area covering it adds nothing', async () => {
    let r = await rememberCard({ time: '19:00' });
    assert.match(r.calls.pick[0], /They were met here, in Common Room, at 19:00:/);
    assert.match(remEl(r.doc).querySelector('.worldscrawl_schedule').textContent, /free time around Village Square, Market Lane, Common Room$/);
    byText(remEl(r.doc), 'Approve').click();
    await flush(80);
    let [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.met, { room: BAR, minutes: H(19) });
    assert.deepEqual(sch.schedule.find(e => e.from === '18:30').might, [`${SQ}(14)`, `${LANE}(13)`, `${BAR}(13)`]);
    assert.deepEqual(sch.schedule.find(e => e.from === '12:00').might, [`${SQ}(15)`, `${LANE}(15)`]);
    // Present in the evening options: on some evenings she is rolled into the common room.
    const p = playPerson(r.c, stampsOf(r.c.chat[1], 'npc_create')[0].id), env = envOf(r.c), D = day0(r.c);
    const seen = new Set(); for (let d = 1; d <= 200; d++) seen.add(scheduleAt(p, { day: D + d, minutes: H(19) }, env).address);
    assert.ok(seen.has(BAR) && seen.has(SQ) && seen.has(LANE), [...seen].join(','));
    // Covered by a favorite area (the Drowned Rat holds the common room): nothing added.
    r = await rememberCard({ time: '19:00', pick: () => ({ ...PICK, favorites: [RAT] }) });
    byText(remEl(r.doc), 'Approve').click();
    await flush(80);
    [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.schedule.find(e => e.from === '18:30').might, [`${RAT}(40)`]);
    // A typed edit gets the same rule.
    r = await rememberCard({ time: '19:00' });
    byText(remEl(r.doc), 'Edit').click();
    await flush(10);
    type(box(r.doc, 'sched_favorites'), 'Market Lane');
    byText(remEl(r.doc), 'Approve edited').click();
    await flush(80);
    [sch] = stampsOf(r.c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.schedule.find(e => e.from === '18:30').might, [`${LANE}(20)`, `${BAR}(20)`]);
    assert.equal(r.calls.pick.length, 1);
    // Check schedule again: the new answer gets it too.
    r = await rememberCard({ time: '19:00', pick: n => (n <= 2 ? 'nope' : { ...PICK, favorites: [STORE] }) });
    byText(remEl(r.doc), 'Check schedule again').click();
    await flush(80);
    assert.match(remEl(r.doc).querySelector('.worldscrawl_schedule').textContent, /free time around Marlow's General Store, Common Room$/);
    byText(remEl(r.doc), 'Approve').click();
    await flush(80);
    assert.deepEqual(stampsOf(r.c.chat[1], 'npc_schedule')[0].schedule.find(e => e.from === '18:30').might, [`${STORE}(20)`, `${BAR}(20)`]);
});

test('home: a bad home from the model keeps the pick with home off the map and a warning (no retry); a bad job still retries then passes through; a typed bad home is an error on the card', async () => {
    let r = await rememberCard({ pick: () => ({ ...PICK, home: RAT }) });
    assert.equal(r.calls.pick.length, 1, 'no retry for a bad home');
    assert.deepEqual(r.card().schedule.pick, { ...PICK, home: null });
    const [n] = scheduleNotes(r.c.chat[1]);
    assert.equal(n.status, 'ok');
    assert.match(n.reason, /home dropped \(off the map instead\): home "riverton:drowned_rat" is an area/);
    assert.match(remEl(r.doc).querySelector('.worldscrawl_schedule').textContent, /, home off the map;/);
    byText(remEl(r.doc), 'Approve').click();
    await flush(80);
    assert.deepEqual(stampsOf(r.c.chat[1], 'npc_schedule')[0].schedule.at(-1), { activity: 'at home', where: 'home', from: '20:00', to: '08:00' });
    // A bad job (with a bad home): retried, then passing through.
    r = await rememberCard({ pick: () => ({ ...PICK, job: 'riverton:nope/room', home: 'nowhere at all' }) });
    assert.equal(r.calls.pick.length, 2);
    assert.match(r.calls.pick[1], /Your last answer did not fit: job "riverton:nope\/room" is not in the list/);
    assert.equal(r.card().schedule.status, 'failed');
    byText(remEl(r.doc), 'Approve').click();
    await flush(80);
    assert.deepEqual(stampsOf(r.c.chat[1], 'npc_schedule')[0].schedule, passingThrough(BAR, H(10)));
    // Typed: strict.
    r = await rememberCard();
    byText(remEl(r.doc), 'Edit').click();
    await flush(10);
    type(box(r.doc, 'sched_home'), 'Nowhereville');
    byText(remEl(r.doc), 'Approve edited').click();
    await flush(60);
    assert.equal(stampsOf(r.c.chat[1], 'npc_create').length, 0);
    assert.match(remEl(r.doc).querySelector('.worldscrawl_schedule_error').textContent, /⚠ Schedule: home "Nowhereville" is not in the list/);
});

test('Check schedule again asks only the pattern question again (not the card)', async () => {
    const { calls, doc, card } = await rememberCard({ pick: n => (n <= 2 ? 'nope' : { ...PICK, pattern: 'night shift' }) });
    assert.equal(card().schedule.status, 'failed');
    byText(remEl(doc), 'Check schedule again').click();
    await flush(80);
    assert.equal(calls.remember.length, 1, 'the card is not asked again');
    assert.equal(calls.pick.length, 3);
    assert.equal(card().schedule.pick.pattern, 'night shift');
    assert.match(remEl(doc).querySelector('.worldscrawl_schedule').textContent, /^Schedule: Night shift at Common Room \(18:00–03:00/);
    // The card's own Check again leaves the pattern alone.
    byText(remEl(doc), 'Check again').click();
    await flush(80);
    assert.equal(calls.remember.length, 2);
    assert.equal(calls.pick.length, 3);
});

test('Edit shows Pattern, Job, Home and Favorites; Approve edited reads them against the live map with no model call: a bad name stays on the card, a good edit is expanded', async () => {
    const { c, calls, doc } = await rememberCard();
    byText(remEl(doc), 'Edit').click();
    await flush(10);
    assert.deepEqual(['pattern', 'job', 'home', 'favorites'].map(k => box(doc, `sched_${k}`)?.value),
        ['day shift', BAR, 'offmap: a lodging-house by the river', 'Village Square, Market Lane'], 'two rooms are called Common Room, so the job shows its address');
    type(box(doc, 'sched_favorites'), 'Village Square, Nowhereville');
    byText(remEl(doc), 'Approve edited').click();
    await flush(60);
    assert.equal(stampsOf(c.chat[1], 'npc_create').length, 0, 'nothing saved');
    assert.match(remEl(doc).querySelector('.worldscrawl_schedule_error').textContent, /⚠ Schedule: favorites: "Nowhereville" is not in the list\./);
    type(box(doc, 'sched_pattern'), 'night shift');
    type(box(doc, 'sched_job'), 'offmap: the watch-house');
    type(box(doc, 'sched_favorites'), 'Market Lane, riverton:streets');
    byText(remEl(doc), 'Approve edited').click();
    await flush(80);
    const [sch] = stampsOf(c.chat[1], 'npc_schedule');
    const pick = { pattern: 'night shift', job: 'offmap: the watch-house', job_activity: null, home: 'offmap: a lodging-house by the river', favorites: [LANE, 'riverton:streets'] };
    assert.deepEqual(sch.pick, pick);
    assert.deepEqual(sch.schedule, expandPattern(pick, { room: BAR, minutes: H(10) }));
    assert.equal(calls.pick.length, 1, 'no model call');
    assert.equal(calls.remember.length, 1);
});

test('Approve while the question is in flight waits for it and never asks a second time; Approve before any question asks it then', async () => {
    const gate = gateOf();
    const r = await rememberCard({ gate });
    byText(remEl(r.doc), 'Approve').click();
    await flush(40);
    assert.match(remEl(r.doc).textContent, /Saving…/);
    assert.match(remEl(r.doc).textContent, /Working out a schedule…/);
    assert.equal(stampsOf(r.c.chat[1], 'npc_create').length, 0, 'waiting');
    gate.release();
    await flush(80);
    assert.equal(r.calls.pick.length, 1);
    assert.deepEqual(stampsOf(r.c.chat[1], 'npc_schedule')[0].pick, PICK);
    // No card drawn: Approve asks the card and then the pattern, once each.
    const { c } = boot({ time: '16:17' });
    const calls = fakeModel(c);
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    await scene.keepRemember(1);
    assert.deepEqual([calls.remember.length, calls.pick.length], [1, 1]);
    assert.deepEqual(stampsOf(c.chat[1], 'npc_schedule')[0].schedule, expandPattern(PICK, { room: BAR, minutes: H(16, 17) }));
});

test('the kept schedule note: Edit shows the same boxes, Approve edited expands again at the met room and time (no model call); Undo removes it', async () => {
    const { c, calls, doc } = await rememberCard();
    byText(remEl(doc), 'Approve').click();
    await flush(80);
    let d = draw([0, 1]);
    const note = () => d.querySelectorAll('.worldscrawl_npcchange').find(e => /schedule/.test(e.textContent));
    byText(note(), 'Edit').click();
    await flush(10);
    assert.equal(note().querySelector('.worldscrawl_sched_pattern').value, 'day shift');
    type(note().querySelector('.worldscrawl_sched_favorites'), 'riverton:general_store');
    byText(note(), 'Approve edited').click();
    await flush(60);
    const [sch] = stampsOf(c.chat[1], 'npc_schedule');
    assert.deepEqual(sch.pick.favorites, ['riverton:general_store']);
    assert.deepEqual(sch.schedule, expandPattern({ ...PICK, favorites: ['riverton:general_store'] }, { room: BAR, minutes: H(10) }));
    assert.match(sch.about, /free time around Marlow's General Store$/);
    assert.equal(calls.pick.length, 1);
    d = draw([0, 1]);
    byText(note(), 'Edit').click();
    await flush(10);
    type(note().querySelector('.worldscrawl_sched_job'), '');
    byText(note(), 'Approve edited').click();
    await flush(60);
    assert.equal(stampsOf(c.chat[1], 'npc_schedule')[0].pick.job, BAR, 'a shift with no job is refused');
    d = draw([0, 1]);
    byText(note(), 'Undo').click();
    await flush(60);
    assert.equal(stampsOf(c.chat[1], 'npc_schedule').length, 0);
});

// ---- 5. The expanded schedule in play.
test('day shift in play: at the job on the hour, the lunch and evening blocks roll per the table (30% / 40%, wandering stretches 15-60 minutes); the narrator sees only in-world words', async () => {
    const { c, blocks, doc } = await rememberCard();
    byText(remEl(doc), 'Approve').click();
    await flush(80);
    const id = stampsOf(c.chat[1], 'npc_create')[0].id;
    const env = envOf(c), p = playPerson(c, id), D = day0(c);
    const at = (d, m) => scheduleAt(p, { day: D + d, minutes: m }, env);
    assert.deepEqual([at(1, H(9)).address, at(1, H(9)).activity], [BAR, 'grinding knives']);
    assert.deepEqual([at(1, H(17, 45)).address, at(1, H(17, 45)).activity, at(1, H(17, 45)).near?.text], [null, 'at home', 'a lodging-house by the river']);
    let lunch = 0, evening = 0;
    const lens = new Set();
    for (let d = 1; d <= 400; d++) {
        const l = at(d, H(12, 30));
        assert.equal(l.kind, 'might');
        assert.ok([SQ, LANE, null].includes(l.address));
        if (l.address) lunch++;
        const e = at(d, H(19));
        assert.ok(e.entry.wandering);
        lens.add(e.segEnd - e.segStart);
        if (e.address) evening++;
    }
    assert.ok(lunch > 400 * 0.22 && lunch < 400 * 0.38, `lunch ${lunch}/400`);
    assert.ok(evening > 400 * 0.32 && evening < 400 * 0.48, `evening ${evening}/400`);
    assert.ok([...lens].every(n => [15, 30, 45, 60].includes(n) || n < 15 || (H(20) - H(18, 30)) % 15 === 0), [...lens].join(','));
    // A day later in the common room: she is there, and the narrator's facts carry no engine words.
    await waitFor(c, '[wait] until 09:00');
    assert.ok(presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).some(n => n.id === id));
    await scene.applyFacts();
    const text = Object.values(blocks).join('\n');
    assert.match(text, /Maren \[\w+\]: Looks: wiry woman/);
    for (const w of ['day shift', 'night shift', 'passing through', 'pattern', '%', 'might be', 'wandering', 'nowhere']) assert.ok(!text.toLowerCase().includes(w), `"${w}" reached the narrator`);
});

test('night shift in play with an off-map job and no favorites: off the map at work with an absent line, the break picks only public rooms of the area', async () => {
    const { c, doc } = await rememberCard({ pick: () => ({ pattern: 'night shift', job: 'offmap: the watch-house', job_activity: 'keeping watch', home: null, favorites: [] }) });
    byText(remEl(doc), 'Approve').click();
    await flush(80);
    const id = stampsOf(c.chat[1], 'npc_create')[0].id;
    const env = envOf(c), p = playPerson(c, id), D = day0(c);
    const at = (d, m) => scheduleAt(p, { day: D + d, minutes: m }, env);
    const work = at(1, H(20));
    assert.deepEqual([work.address, work.offmap], [null, true]);
    assert.equal(offmapAbsentLine(p, work), 'Maren: keeping watch, elsewhere (the watch-house)');
    assert.equal(at(1, H(5)).activity, 'at home');
    const picks = new Set();
    for (let d = 1; d <= 200; d++) picks.add(at(d, H(22, 30)).address);
    picks.delete(null);
    for (const a of picks) assert.ok(a.startsWith(`${RAT}/`) && ![UP, CELLAR, KITCH].includes(a), a);
    assert.ok(picks.size >= 2, [...picks].join(','));
});
