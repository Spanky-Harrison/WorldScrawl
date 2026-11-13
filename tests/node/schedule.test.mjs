// S1a schedules: "might be at" entries. Percent tables, the seeded block roll, wandering chains, area picks, presence and
// the appearance stamp, [find] checking where they are now, waits listing comings and goings, the inspector and cast panel
// lines, export, the editor round trip, and the narrator never seeing the mechanics. The chat side runs through the real
// handlers (a real world server behind the fetch shim, prepareNpcs, applyFacts, the [find] and [wait] brackets).
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

// ---- 1. Percent tables.
test('percent parsing: numbered, unnumbered shares, the rest as nowhere, over 100 broken, nothing left is 0 with a warning, times required', () => {
    const t = list => mightTable(list.map(parseMightOption));
    const shares = list => t(list).options.map(o => o.share);
    assert.deepEqual(shares(['a(20)', 'b(80)']), [20, 80]);
    assert.deepEqual(shares(['a(10)', 'b(10)', 'c']), [10, 10, 80]);
    assert.deepEqual(shares(['a', 'b', 'c']), [34, 33, 33], 'the rounding remainder goes to the first');
    const under = t(['a(20)', 'b(30)']);
    assert.equal(under.total, 50, 'under 100: the rest is nowhere');
    assert.equal(pickFromTable(under.options, 49).text, 'b');
    assert.equal(pickFromTable(under.options, 50), null, 'past the last band is nowhere');
    const over = t(['a(60)', 'b(50)']);
    assert.equal(over.broken, true);
    assert.match(over.problems[0], /110%, over 100/);
    const none = t(['a(100)', 'b']);
    assert.deepEqual(none.options.map(o => o.share), [100, 0]);
    assert.match(none.warnings[0], /b: no odds left over, so 0%/);
    assert.equal(parseMightOption('the tannery (30%)').pct, 30);
    assert.equal(parseMightOption('x(101)'), null);
    const places = new Set([BAR, SQ]);
    const rec = sched => validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: [sched] }, { file: 'x.json', places });
    assert.equal(rec({ might: [BAR], activity: 'drinking', from: '10:00' }).schedule[0].broken, true, 'missing to');
    assert.match(rec({ might: [BAR], activity: 'drinking', to: '10:00' }).problems.join(), /from is required/);
    assert.equal(rec({ might: [`${BAR}(60)`, `${SQ}(50)`], activity: 'drinking', from: '10:00', to: '11:00' }).schedule[0].broken, true);
    const ok = rec({ might: [`${BAR}(20)`, SQ], activity: 'drinking', from: '10:00', to: '11:00' });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.schedule[0].options.map(o => [o.text, o.share]), [[BAR, 20], [SQ, 80]]);
});

// ---- 2. Block start.
test('block start: the most recent pass of from; a 22:00-02:00 block at 01:00 uses 22:00 of the previous date', () => {
    const D = 1440;
    assert.equal(blockStartOf(H(10), 5 * D + H(12, 30)), 5 * D + H(10));
    assert.equal(blockStartOf(H(10), 5 * D + H(10)), 5 * D + H(10));
    assert.equal(blockStartOf(H(22), 5 * D + H(1)), 4 * D + H(22));
    const late = validateRecord({ id: 'nell', name: 'Nell', line: 'A night owl.', schedule: [{ might: [BAR], activity: 'drinking late', from: '22:00', to: '02:00' }] }, { file: 'nell.json', places: new Set([BAR]) });
    const env = { exists: a => a === BAR, relocate: {} };
    const s = scheduleAt(late, { day: 5, minutes: H(1) }, env);
    assert.equal(s.kind, 'might');
    assert.equal(s.blockStart, 4 * D + H(22));
    assert.equal(s.blockEnd, 5 * D + H(2));
    assert.equal(s.roll, hashRoll(`block|nell|${mightKey(late.schedule[0])}|${4 * D + H(22)}`));
    assert.equal(scheduleAt(late, { day: 4, minutes: H(23) }, env).roll, s.roll, 'the same block before midnight');
});

// ---- 3. Normal block.
test('normal block: one pick for the whole block, stable, a later or next-day block rolls fresh, bands in order, and the odds hold', () => {
    const places = new Set([BAR, SQ]);
    const env = { exists: a => places.has(a), relocate: {} };
    const n = validateRecord({ id: 'osk', name: 'Osk', line: 'A carter.', schedule: [{ might: [`${BAR}(20)`, `${SQ}(30)`], activity: 'resting', from: '10:00', to: '13:00' }] }, { file: 'osk.json', places });
    const key = mightKey(n.schedule[0]);
    const picks = new Set();
    for (let m = H(10); m < H(13); m += 7) { const s = scheduleAt(n, { day: 3, minutes: m }, env); picks.add(`${s.roll}|${s.pick}`); assert.equal(s.blockStart, 3 * 1440 + H(10)); }
    assert.equal(picks.size, 1, 'one pick all block');
    const again = scheduleAt(structuredClone(n), { day: 3, minutes: H(11) }, env);
    assert.equal(`${again.roll}|${again.pick}`, [...picks][0], 'same on a reload (nothing kept in memory)');
    const rolls = new Set(Array.from({ length: 30 }, (_, d) => scheduleAt(n, { day: d, minutes: H(11) }, env).roll));
    assert.ok(rolls.size > 10, 'each day rolls fresh');
    assert.equal(scheduleAt(n, { day: 4, minutes: H(11) }, env).roll, hashRoll(`block|osk|${key}|${4 * 1440 + H(10)}`));
    const bands = n.schedule[0].options;
    assert.equal(pickFromTable(bands, 0).text, BAR);
    assert.equal(pickFromTable(bands, 19).text, BAR);
    assert.equal(pickFromTable(bands, 20).text, SQ);
    assert.equal(pickFromTable(bands, 49).text, SQ);
    assert.equal(pickFromTable(bands, 50), null);
    const count = { [BAR]: 0, [SQ]: 0, [NOWHERE]: 0 };
    const N = 6000;
    for (let d = 0; d < N; d++) count[scheduleAt(n, { day: d, minutes: H(11) }, env).pick]++;
    assert.ok(Math.abs(count[BAR] / N - 0.2) < 0.025, `bar ${count[BAR]}`);
    assert.ok(Math.abs(count[SQ] / N - 0.3) < 0.025, `square ${count[SQ]}`);
    assert.ok(Math.abs(count[NOWHERE] / N - 0.5) < 0.025, `nowhere ${count[NOWHERE]}`);
    const before = scheduleAt(n, { day: 3, minutes: H(9, 59) }, env);
    assert.equal(before, null, 'no other entry: outside the block there is nothing (never a fallback)');
});

// ---- 4. Wandering chain.
test('wandering chain: 15/30/45/60 lengths, contiguous, clipped at the block end, deterministic, nowhere mid-chain, the straight odds', () => {
    const lens = new Set();
    let clipped = 0, nowhereMid = 0;
    const count = { a: 0, b: 0, none: 0 };
    const table = mightTable(['a(20)', 'b(30)'].map(parseMightOption)).options;
    for (let d = 0; d < 400; d++) {
        const start = d * 1440 + H(10), end = d * 1440 + H(12, 10); // 130 minutes: the last segment is often cut short
        const chain = wanderChain(`p|k${d % 7}`, start, end);
        assert.equal(chain[0].start, start);
        assert.equal(chain.at(-1).end, end, 'the last segment ends at the block end');
        chain.forEach((s, i) => {
            if (i) assert.equal(s.start, chain[i - 1].end, 'no gaps');
            if (i < chain.length - 1) lens.add(s.end - s.start);
            else if (![15, 30, 45, 60].includes(s.end - s.start)) clipped++;
            const pick = pickFromTable(table, s.roll);
            count[pick?.text ?? 'none']++;
            if (!pick && i > 0 && i < chain.length - 1) nowhereMid++;
        });
        const t = start + 77;
        assert.deepEqual(wanderChain(`p|k${d % 7}`, start, end, t), wanderChain(`p|k${d % 7}`, start, end, t), 'walking to T is deterministic');
        const upTo = wanderChain(`p|k${d % 7}`, start, end, t);
        assert.ok(upTo.at(-1).start <= t && t < upTo.at(-1).end);
    }
    assert.deepEqual([...lens].sort((x, y) => x - y), [15, 30, 45, 60]);
    assert.ok(clipped > 0, 'some chains clip their last segment');
    assert.ok(nowhereMid > 0, 'nowhere comes up mid-chain');
    const all = count.a + count.b + count.none;
    assert.ok(Math.abs(count.a / all - 0.2) < 0.03 && Math.abs(count.b / all - 0.3) < 0.03, JSON.stringify(count));
});

// ---- 5. Area rendezvous.
test('area pick: the highest score wins; a lower new room leaves it, a higher one moves it only before they appear; removing the winner re-picks; all rooms count', () => {
    const base = 'hesk|k', s = 1000;
    const rooms = Array.from({ length: 24 }, (_, i) => `r:a/${i + 1}`);
    const score = r => hashScore(`area|${base}|${s}|${r}`);
    const top = [...rooms].sort((x, y) => score(y) - score(x));
    assert.deepEqual(areaPick(base, s, rooms.slice(0, 5)), { address: [...rooms.slice(0, 5)].sort((x, y) => score(y) - score(x))[0], of: 5 });
    const first4 = rooms.slice(0, 4), best4 = [...first4].sort((x, y) => score(y) - score(x))[0];
    const lower = rooms.slice(4).find(r => score(r) < score(best4)), higher = rooms.slice(4).find(r => score(r) > score(best4));
    assert.ok(lower && higher);
    assert.equal(areaPick(base, s, [...first4, lower]).address, best4, 'a lower-scoring new room leaves the pick');
    assert.equal(areaPick(base, s, [...first4, higher]).address, higher, 'a higher-scoring new room changes it');
    assert.equal(areaPick(base, s, first4.filter(r => r !== best4)).address, [...first4].filter(r => r !== best4).sort((x, y) => score(y) - score(x))[0], 'removing the winner re-picks');
    assert.equal(top.length, 24);
    // Through the chat side: the inn as an area (every room counts, upstairs too); a stamp freezes the pick.
    const places = new Set([BAR, UP, CELLAR]);
    let live = new Set(places);
    const index = { rooms: places, subs: new Set([RAT]), regions: new Set(['riverton']), stubs: new Map(), nameOf: a => a, exists: a => live.has(a), relocate: {} };
    const env = { exists: a => live.has(a), relocate: {}, index, names: a => a, playerAt: () => BAR, clock: () => ({ day: 2, minutes: H(14), elapsed: 2 * 86400 + H(14) * 60 }) };
    const n = validateRecord({ id: 'hesk', name: 'Hesk', line: 'The landlady.', schedule: [{ might: [RAT], activity: 'seeing to the inn', from: '13:00', to: '15:00' }] }, { file: 'hesk.json', places, nearIndex: index });
    const sch = scheduleAt(n, { day: 2, minutes: H(14) }, env);
    assert.equal(sch.how, 'area');
    assert.equal(sch.area.of, 3);
    const k = `hesk|${mightKey(n.schedule[0])}`, bs = 2 * 1440 + H(13);
    assert.equal(sch.address, [BAR, CELLAR, UP].sort((x, y) => hashScore(`area|${k}|${bs}|${y}`) - hashScore(`area|${k}|${bs}|${x}`))[0]);
    live = new Set([...places].filter(a => a !== sch.address));
    index.rooms = live;
    const moved = scheduleAt(n, { day: 2, minutes: H(14) }, env);
    assert.notEqual(moved.address, sch.address, 'the winner gone: re-picked');
    const stamped = { ...n, appearances: [{ place: sch.address, blockStart: bs, at: 0 }] };
    const chat = [{ is_user: false, mes: 'x', extra: {} }];
    const frozen = NPC.npcWhy(stamped, 0, { ...env, exists: a => places.has(a), index: { ...index, rooms: places } });
    assert.equal(frozen.place, sch.address, 'once they appeared, the stamp holds the room');
    assert.ok(chat);
});

// ---- 6 and 10. Presence through prepareNpcs, and waits.
test('presence: prepareNpcs stamps only in the pick\'s room, presentAt needs the stamp, deleting the message undoes it; a normal block\'s stamp covers the block', async () => {
    const { c } = boot({ time: '09:00' });
    // 09:00: Tam is on the square, Bryn (normal block, always the bar) is due here.
    assert.deepEqual(presentIds(c), [], 'no stamp yet: nobody has turned up');
    const m = say(c, 'I look around the room.');
    await scene.prepareNpcs(m);
    const st = appears(m);
    assert.deepEqual(st.map(s => s.id), ['bryn'], 'only Bryn: Tam\'s pick is the square');
    assert.equal(st[0].place, BAR);
    assert.equal(st[0].blockStart, day0(c) * 1440 + H(9));
    assert.equal(st[0].segStart, undefined, 'a normal block has no segment');
    assert.deepEqual(presentIds(c), ['bryn']);
    c.chat.pop();
    assert.deepEqual(presentIds(c), [], 'deleting the message undoes it');
    c.chat.push(m);
    reply(c, 'Bryn nods from the bench.');
    await waitFor(c, '[wait] 2h');
    assert.deepEqual(presentIds(c), ['bryn'], 'the stamp covers the whole block');
    const p = presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).find(n => n.id === 'bryn');
    assert.equal(p.overdue, '');
});

test('wandering: the stamp holds them in the scene when the chain moves on, no mid-block note, the note at block end; leaving and coming back follows the chain', async () => {
    const { c } = boot({ time: '10:10' });
    const m = say(c, 'I order a drink.');
    await scene.prepareNpcs(m);
    const tam = appears(m).find(s => s.id === 'tam');
    assert.ok(tam, 'Tam\'s 10:00-10:30 segment is the common room');
    assert.equal(tam.segStart, day0(c) * 1440 + H(10));
    reply(c, 'An old man mends a net by the fire.');
    await waitFor(c, '[wait] 30m'); // 10:40: his chain is on the square now
    const env = envOf(c);
    assert.equal(scheduleAt(person('tam'), env.clock(c.chat.length - 1), env).address, SQ);
    let p = presentAt(c.chat, c.chat.length - 1, cast(), env).find(n => n.id === 'tam');
    assert.ok(p, 'he does not vanish mid-scene');
    assert.equal(p.overdue, '', 'no note mid-block');
    reply(c, 'He keeps at the net.');
    await waitFor(c, '[wait] 1h30m'); // 12:10: the block is over
    p = presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).find(n => n.id === 'tam');
    assert.match(p.overdue, /^Tam would normally have moved on by now\.$/);
    // Leave and come back at 10:40 in another chat: the chain (the square), not the old stamp.
    const b = boot({ time: '10:10' });
    const m2 = say(b.c, 'I order a drink.');
    await scene.prepareNpcs(m2);
    reply(b.c, 'He nods.', { worldscrawl_location: SQ });
    reply(b.c, 'The square.', { worldscrawl_wait: { seconds: 30 * 60 } });
    reply(b.c, 'Back inside.', { worldscrawl_location: BAR });
    assert.deepEqual(presentIds(b.c).filter(id => id === 'tam'), [], 'back at 10:40: his chain has him on the square');
    const there = say(b.c, 'Anyone about?', { worldscrawl_location: SQ });
    await scene.prepareNpcs(there);
    assert.ok(appears(there).some(s => s.id === 'tam' && s.place === SQ && s.segStart === day0(b.c) * 1440 + H(10, 30)), 'out on the square he turns up');
});

test('wait: a short wandering segment inside a wait gives both an arrival and a departure line, through applyFacts', async () => {
    const { c, blocks } = boot({ time: '09:00' });
    const m = say(c, 'I sit down.');
    await scene.prepareNpcs(m);
    assert.ok(!appears(m).some(s => s.id === 'tam'), 'Tam is on the square at 09:00');
    reply(c, 'Bryn waits for the tide.');
    await waitFor(c, '[wait] 2h'); // 11:00: Tam is back on the square
    const text = await factsText(blocks);
    assert.match(text, /\[10:00\] Tam arrives\./);
    assert.match(text, /\[10:30\] Tam leaves\./);
    assert.ok(text.indexOf('[10:00] Tam arrives.') < text.indexOf('[10:30] Tam leaves.'));
    assert.doesNotMatch(text, /Bryn (arrives|leaves)/, 'Bryn was already here');
    const env = envOf(c);
    const lines = comingsAndGoings(c.chat, c.chat.length - 1, cast(), env);
    assert.deepEqual(lines.filter(l => /Tam/.test(l)), ['[10:00] Tam arrives.', '[10:30] Tam leaves.']);
    assert.ok(!presentIds(c).includes('tam'), 'nobody stays without a stamp: he came and went');
});

test('wait: an arrival is timed at the segment start, and nextTurnUp finds the first hit mid-chain', async () => {
    const { c, blocks } = boot({ time: '09:40' });
    reply(c, 'Rain on the shutters.');
    const w = await waitFor(c, '[wait] 30m'); // 10:10, inside Tam's common-room segment
    await scene.prepareNpcs(w); // the turn's own pass: he turns up here
    assert.ok(appears(w).some(s => s.id === 'tam' && s.segStart === day0(c) * 1440 + H(10)));
    const text = await factsText(blocks);
    assert.match(text, /\[10:00\] Tam arrives\./);
    assert.doesNotMatch(text, /Tam leaves/);
    const env = envOf(c);
    const hit = nextTurnUp(person('tam'), at(c, H(9)), at(c, H(12)), BAR, env);
    assert.equal(hit.at, day0(c) * 1440 + H(10), 'the third segment of the chain, not the block start');
    assert.equal(nextTurnUp(person('tam'), at(c, H(10, 30)), at(c, H(11, 15)), BAR, env), null, 'on the square 10:30-11:30');
    assert.equal(nextTurnUp(person('tam'), at(c, H(10, 30)), at(c, H(12)), BAR, env).at, day0(c) * 1440 + H(11, 30));
    assert.deepEqual(visitsBetween(person('tam'), day0(c) * 1440 + H(9), day0(c) * 1440 + H(12), SQ, env).map(v => [v.start - day0(c) * 1440, v.end - day0(c) * 1440]), [[H(9), H(9, 30)], [H(10, 30), H(11, 30)]]);
    // A normal block's arrival is its block start.
    const b = boot({ time: '08:30' });
    reply(b.c, 'Morning.');
    await scene.prepareNpcs(await waitFor(b.c, '[wait] 1h'));
    assert.match(await factsText(b.blocks), /\[09:00\] Bryn arrives\./);
});

// ---- 7. [find].
test('[find]: accepted only where they are now, rejected elsewhere with a reason, no seek stamp; the off-map path is unchanged', async () => {
    const { c } = boot({ time: '10:10' });
    const m = say(c, '[find] Tam');
    await bracketIntent(m, parseBracket(m.mes));
    const d = m.extra[FOUND_KEY].find(x => x.id === 'tam');
    assert.equal(d.ok, true, d.reason);
    assert.equal(d.reason, 'Accepted: Tam is here right now.');
    assert.match(d.detail, /^Wandering 09:00–12:00: .* 10:00–10:30 \(rolled \d+\)/);
    assert.ok(appears(m).some(s => s.id === 'tam' && s.place === BAR && s.source === 'bracket'));
    assert.ok(!(m.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_seek'), 'no by-name roll');
    assert.ok(presentIds(c).includes('tam'));
    const b = boot({ time: '10:40' });
    const n = say(b.c, '[find] Tam');
    await bracketIntent(n, parseBracket(n.mes));
    const r = n.extra[FOUND_KEY].find(x => x.id === 'tam');
    assert.equal(r.ok, false);
    assert.equal(r.reason, "Tam isn't around here right now.");
    assert.match(r.detail, /Village Square|square/i);
    assert.ok(!appears(n).length && !(n.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_seek'));
    // Hesk asleep off the map (02:00-10:00, near the inn): the old placeless [find] path.
    const h = boot({ time: '08:00' });
    const q = say(h.c, '[find] Hesk');
    await bracketIntent(q, parseBracket(q.mes));
    const hd = q.extra[FOUND_KEY].find(x => x.id === 'hesk');
    assert.equal(hd.ok, true, hd.reason);
    assert.equal(hd.where, 'her own room');
    assert.ok((q.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_found' && s.id === 'hesk' && s.where === 'her own room'));
});

// ---- 8. Overlaps and fallback.
test('overlap: a hand-written overlap gets a load note and the might block wins; never a fallback outside its window', () => {
    const places = new Set([BAR, SQ, UP]);
    const n = validateRecord({ id: 'x', name: 'X', line: 'Someone.', schedule: [
        { place: UP, activity: 'sleeping', from: '00:00', to: '12:00' },
        { might: [SQ], activity: 'selling eggs', from: '10:00', to: '11:00' },
    ] }, { file: 'x.json', places });
    assert.ok(n.problems.some(p => /overlap/i.test(p)), n.problems.join('; '));
    const env = { exists: a => places.has(a), relocate: {} };
    assert.equal(scheduleAt(n, { day: 1, minutes: H(10, 30) }, env).kind, 'might', 'the might block wins');
    assert.equal(scheduleAt(n, { day: 1, minutes: H(9) }, env).address, UP);
    const only = validateRecord({ id: 'y', name: 'Y', line: 'Someone.', schedule: [{ place: BAR, activity: 'drinking', from: '18:00', to: '20:00' }, { might: [SQ], activity: 'selling eggs', from: '10:00', to: '11:00' }] }, { file: 'y.json', places });
    assert.deepEqual(only.problems, []);
    const off = scheduleAt(only, { day: 1, minutes: H(14) }, env);
    assert.equal(off.kind, 'schedule', 'outside both windows the is-at entry is the fallback, never the might block');
    assert.equal(off.address, BAR);
});

// ---- 9. Hesk.
test('Hesk loads with no warnings and her day follows the plan (fixed seed: the Riverton start date)', async () => {
    const { c, server } = boot({ time: '08:00', cards: [] });
    const body = server.get('/cast').json();
    const hesk = body.npcs.find(n => n.id === 'hesk');
    assert.deepEqual(hesk.problems, []);
    assert.equal(hesk.schedule.length, 5);
    const env = envOf(c);
    const h = person('hesk');
    const s = hm => { const [a, b] = hm.split(':').map(Number); return scheduleAt(h, at(c, H(a, b)), env); };
    assert.equal(s('03:00').activity, 'asleep');
    assert.equal(s('03:00').address, null);
    const ten = s('10:20'), eleven = s('11:40');
    assert.deepEqual([ten.kind, ten.pick, ten.segStart - day0(c) * 1440, ten.segEnd - day0(c) * 1440, ten.roll], ['might', NOWHERE, H(10), H(10, 30), 73], 'away for this segment of the chain');
    assert.deepEqual([eleven.address, eleven.segStart - day0(c) * 1440, eleven.segEnd - day0(c) * 1440, eleven.roll], [LANE, H(11), H(12), 13]);
    const two = s('14:00');
    assert.equal(two.how, 'area');
    assert.equal(two.address, 'riverton:drowned_rat/courtyard');
    assert.equal(two.area.of, 6);
    assert.equal(s('15:30').address, CELLAR);
    assert.equal(s('20:00').address, BAR);
    assert.equal(s('20:00').activity, 'pouring drinks');
});

// ---- 11. The narrator never sees the mechanics.
test('narrator text: no %, roll, "might be at", nowhere, wandering or pattern words, across a day of facts blocks', async () => {
    const bad = /%|\broll|might be at|nowhere|wander|passing ?through|\bblock\b|segment/i;
    const seen = [];
    for (const [time, wait] of [['09:00', '2h'], ['09:40', '30m'], ['10:10', '1h'], ['13:30', '1h'], ['11:50', '20m']]) {
        const { c, blocks } = boot({ time, cards: [TAM, BRYN] });
        const m = say(c, 'I look around.');
        await scene.prepareNpcs(m);
        reply(c, 'The room is warm.');
        await scene.prepareNpcs(await waitFor(c, `[wait] ${wait}`));
        const m2 = say(c, '[find] Tam');
        await bracketIntent(m2, parseBracket(m2.mes));
        const text = await factsText(blocks);
        assert.doesNotMatch(text, bad, `${time}: ${text.match(bad)?.[0]}`);
        seen.push(text);
    }
    const all = seen.join('\n');
    assert.match(all, /Tam arrives/, 'the comings lines were in what was checked');
    assert.match(all, /Bryn \[p[0-9a-z]+\]:|Bryn:/, 'and people here');
});

// ---- 12. Who's here, Why, cast panel lines; export; seen_at is gone.
test('who\'s here, why and cast panel lines for both block kinds; export writes might entries as written; a seen_at file loads with a note', async () => {
    const { c, server, dir } = boot({ time: '10:40' });
    const env = envOf(c);
    const end = c.chat.length - 1;
    const here = whoAt(c.chat, end, cast(), env, BAR);
    const tam = here.find(x => x.id === 'tam'), bryn = here.find(x => x.id === 'bryn');
    assert.equal(bryn.here, true);
    assert.equal(bryn.kind, 'might');
    assert.equal(tam.here, false);
    assert.match(tam.reason, /^Not here: Entry 1: Wandering 09:00–12:00: .*10:30–11:30 \(rolled \d+\)/);
    const sq = whoAt(c.chat, end, cast(), env, SQ).find(x => x.id === 'tam');
    assert.equal(sq.here, true, 'the chain has him on the square');
    const w = npcWhy(person('bryn'), end, env);
    assert.match(w.schedule.why, /^Entry 1: Might be here 09:00–12:00: rolled \d+ → /);
    assert.equal(w.schedule.might.stamped, false);
    const wt = npcWhy(person('tam'), end, env).schedule.might;
    assert.deepEqual([wt.wandering, wt.segStart - day0(c) * 1440, wt.segEnd - day0(c) * 1440, wt.pick], [true, H(10, 30), H(11, 30), SQ]);
    const rows = whyRows({ id: 'tam', name: 'Tam', why: npcWhy(person('tam'), end, env), record: person('tam') });
    assert.ok(rows.some(([k, v]) => k === 'Schedule' && /Wandering/.test(v)), JSON.stringify(rows));
    assert.ok(!rows.some(([k]) => k === 'Sighting'));
    const body = server.get('/cast').json();
    const rec = body.npcs.find(n => n.id === 'tam');
    assert.equal(mightText(rec.schedule[0], a => body.place_labels?.[a] ?? a), `might be at ${body.place_labels?.[BAR] ?? BAR} 30%, ${body.place_labels?.[SQ] ?? SQ} 30% (wandering), 09:00–12:00`);
    assert.equal(mightText({ might: ['riverton:drowned_rat/common_room(20)', 'the docks', 'nowhere(50)'], from: '10:00', to: '13:00' }), 'might be at riverton:drowned_rat/common_room 20%, the docks 30%, 10:00–13:00');
    const cr = castRows(body.npcs, []);
    assert.deepEqual(filterRows(cr, { place: SQ }).map(r => r.id).sort(), ['hesk', 'tam']);
    assert.deepEqual(exportRecord(rec).schedule, TAM.schedule, 'export writes the entry as authored');
    assert.deepEqual(tidyRecord(TAM).schedule, TAM.schedule);
    write(path.join(dir, 'cast', 'old.json'), JSON.stringify({ id: 'old', name: 'Old Sal', line: 'A gossip.', seen_at: { place: SQ, hour: 16, chance: 0.5 } }));
    const old = loadCast(dir, null).npcs.find(n => n.id === 'old');
    assert.equal(old.ok, true);
    assert.ok(old.problems.some(p => /unknown field "seen_at" \(ignored; use a "might" schedule entry instead\)/.test(p)), old.problems.join('; '));
    assert.equal(old.seen_at, undefined);
    fs.rmSync(path.join(dir, 'cast', 'old.json'));
});

// ---- 13. Editor round trip.
test('editor: might rows show read-only and a save through the form leaves the file byte-identical', async () => {
    const { server, dir } = boot({ time: '09:00', cards: [TAM, BRYN] });
    const file = path.join(dir, 'cast', 'hesk.json');
    const bytes = fs.readFileSync(file, 'utf8');
    const rec = server.get('/cast').json().npcs.find(n => n.id === 'hesk');
    const f = formFromRecord(rec);
    assert.deepEqual(f.schedule.filter(e => e.mightRow).map(e => e.mightRow), JSON.parse(bytes).schedule.filter(e => e.might));
    assert.deepEqual(formProblems(f, { places: new Set(server.get('/cast').json().places), ids: new Set() }), {});
    const r = server.post('/cast/save?world=riverton', { json: { npc: recordFromForm(f), original: 'hesk' } });
    assert.equal(r.status_code, 200, JSON.stringify(r.json()));
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'byte-identical');
    // The panel's editor: the might rows are read-only text, and Save as new writes them unchanged.
    const doc = makeDoc();
    const saved = [];
    const panel = castPanel(doc, {
        load: async () => server.get('/cast').json(), outline: async () => null, play: () => null, placeName: a => a,
        save: async (npc, original, originalFile) => { saved.push(npc); const res = server.post('/cast/save?world=riverton', { json: { npc, ...(original ? { original } : {}), ...(originalFile ? { original_file: originalFile } : {}) } }); if (res.status_code >= 400) throw new Error(JSON.stringify(res.json())); return res.json(); },
    });
    await panel.refresh();
    panel.selectId('hesk', 'resolved');
    const saveAs = panel.el.querySelectorAll('.cast-saveas')[0];
    assert.ok(saveAs);
    saveAs.click();
    const rows = panel.el.querySelectorAll('.cf-might');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /^might be at riverton:streets\/market_lane 20%, riverton:general_store\/shop 20%, riverton:streets\/square 20% \(wandering\), 10:00–13:00 · buying for the inn/);
    assert.equal(rows[0].querySelectorAll('input').length + rows[0].querySelectorAll('select').length, 0, 'read-only');
    assert.ok(!panel.el.querySelectorAll('.cf-seen').length, 'the Sighting box is gone');
    panel.el.querySelectorAll('.cast-save')[0].click();
    const confirm = panel.el.querySelectorAll('.cast-confirm')[0];
    assert.ok(confirm, 'the review shows what will be written');
    confirm.click();
    await new Promise(res => setTimeout(res, 30));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].schedule, JSON.parse(bytes).schedule, 'the might rows went out exactly as written');
    const copy = fs.readdirSync(path.join(dir, 'cast')).find(x => !['hesk.json', 'tam.json', 'bryn.json'].includes(x));
    assert.ok(copy, fs.readdirSync(path.join(dir, 'cast')).join());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cast', copy), 'utf8')).schedule, JSON.parse(bytes).schedule);
    fs.rmSync(path.join(dir, 'cast', copy));
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
