// F1 [find]: no roll. Right here is a notice; a might block whose options (the roll's own resolver) include the player's
// room brings them here for the rest of the block; nowhere, off the map, an is-at entry elsewhere or a room that is not an
// option: can't be found. Through the real handlers: a real world server behind the fetch shim, the [find] bracket
// (bracketIntent -> applyFound), prepareNpcs, the [wait] bracket and applyFacts (the narrator's facts block).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';
import { NOWHERE } from '../../plugin/shared/npc.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();
const { NPC_KEY, FOUND_KEY, clockAtMinutes, framesOf, npcWhy, presentAt, scheduleAt, whoAt } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, RAT = 'riverton:drowned_rat', UP = `${RAT}/upstairs`, SQ = 'riverton:streets/square', STORE = 'riverton:general_store/shop';
const H = (h, m = 0) => h * 60 + m;
const card = (id, name, schedule) => ({ id, name, personality: { summary: `${name}, a local.` }, disposition: { player: { value: 'indifferent' } }, schedule });

// Rolls are seeded (person, entry, block start), so on the Riverton start date each of these lands where its test needs it;
// every test asserts that precondition first, so a changed seed fails loudly instead of testing the wrong case.
const CARDS = [
    // Vera: the square almost always, the common room listed directly; then the store from 12:00 (an is-at entry).
    card('vera', 'Vera', [{ might: [`${SQ}(99)`, `${BAR}(1)`], activity: 'selling eggs', from: '09:00', to: '12:00' }, { place: STORE, activity: 'minding the store', from: '12:00', to: '18:00' }]),
    // Bryn: always the common room 09:00-12:00.
    card('bryn', 'Bryn', [{ might: [BAR], activity: 'waiting for the tide', from: '09:00', to: '12:00' }]),
    // Nell: 1% the common room, the rest nowhere.
    card('nell', 'Nell', [{ might: [`${BAR}(1)`], activity: 'drinking', from: '09:00', to: '12:00' }]),
    // Odo: almost always off the map (plain words), the common room listed.
    card('odo', 'Odo', [{ might: ['a fishing camp up the river(99)', `${BAR}(1)`], activity: 'fishing', from: '09:00', to: '12:00' }]),
    // Ash: the square almost always, or the Drowned Rat as an area (its public rooms; upstairs is private).
    card('ash', 'Ash', [{ might: [`${SQ}(99)`, `${RAT}(1)`], activity: 'delivering', from: '09:00', to: '12:00' }]),
    // Pim: the square almost always, or upstairs (private) named outright.
    card('pim', 'Pim', [{ might: [`${SQ}(99)`, `${UP}(1)`], activity: 'cleaning', from: '09:00', to: '12:00' }]),
    // Sol: only the square.
    card('sol', 'Sol', [{ might: [SQ], activity: 'preaching', from: '09:00', to: '12:00' }]),
    // Tam: wandering 09:00-12:00 between the common room, the square and nowhere (the schedule test's Tam).
    card('tam', 'Tam', [{ might: [`${BAR}(30)`, `${SQ}(30)`, 'nowhere'], activity: 'mending nets', from: '09:00', to: '12:00', wandering: true }]),
];

let sv = null;
function serverOnce() {
    if (sv) return sv;
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    for (const c of CARDS) write(path.join(d, 'riverton', 'cast', `${c.id}.json`), JSON.stringify(c, null, 2));
    sv = { server: clientDir(d) };
    return sv;
}
/** A fresh chat at `time` on the Riverton start date, standing in `here`, with the real world server (Hesk) plus CARDS. */
function boot({ time = '10:00', here = BAR } = {}) {
    exitsCache.clear();
    const { server } = serverOnce();
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
    c.chatId = 'find'; c.getCurrentChatId = () => 'find';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {}, calls = [];
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => { calls.push(String(args?.prompt ?? '')); return /Reply with JSON only:\n\{"place"/.test(String(args?.prompt ?? '')) ? '{"place": null, "people": [], "wait": null}' : ''; };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'A quiet morning.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }];
    return { c, blocks, calls };
}
const say = (c, text, extra = {}) => { const m = { is_user: true, mes: text, swipe_id: 0, extra }; c.chat.push(m); return m; };
const reply = (c, text) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }; c.chat.push(m); return m; };
const envOf = c => scene.npcEnv(c.chat, { address: c.chat.findLast(m => m.extra?.worldscrawl_location)?.extra.worldscrawl_location ?? BAR });
const cast = () => scene.castPack().npcs;
const folded = (c, id) => framesOf(c.chat, c.chat.length - 1, cast(), envOf(c).clock).at(-1).get(id);
const day0 = c => envOf(c).clock(0).day;
const sched = (c, id, min) => scheduleAt(folded(c, id), clockAtMinutes(day0(c) * 1440 + min), envOf(c));
const presentIds = c => presentAt(c.chat, c.chat.length - 1, cast(), envOf(c)).map(n => n.id);
/** Where Who's here and the cast panel put them now (duePlace through npcWhy). */
const placeNow = (c, id) => npcWhy(folded(c, id), c.chat.length - 1, envOf(c)).place;
const factsText = async blocks => { await scene.applyFacts(); return Object.values(blocks).join('\n'); };
const waitFor = async (c, text) => { const m = say(c, text); const r = await bracketIntent(m, parseBracket(text)); assert.notEqual(r.kind, 'bracket_failed', r.note); await scene.prepareNpcs(m); reply(c, 'Time passes.'); return m; };
/** Type `[find] Name` (the real bracket) and return the decision and the message. */
async function find(c, name, extra = {}) {
    const m = say(c, `[find] ${name}`, extra);
    const r = await bracketIntent(m, parseBracket(m.mes));
    assert.equal(r.kind, 'found');
    const d = (m.extra[FOUND_KEY] ?? []).find(x => x.source === 'bracket');
    return { d, m, appear: (m.extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appear' && s.source === 'bracket') };
}

test('already here: a "right here" notice, nothing stamped, nothing moves; the narrator is not told anyone came in', async () => {
    const { c, blocks } = boot({ time: '10:00' });
    assert.equal(sched(c, 'bryn', H(10)).address, BAR, 'precondition: Bryn is in the common room');
    const { d, m, appear } = await find(c, 'Bryn');
    assert.equal(d.ok, true);
    assert.equal(d.here, true);
    assert.equal(d.moved, undefined);
    assert.equal(d.reason, 'Bryn is right here.');
    assert.deepEqual(appear, [], 'no stamp from [find]');
    assert.equal(m.extra.worldscrawl_bracket.status, 'ok');
    await scene.prepareNpcs(m); // the turn's own pass: she turns up as usual (her roll put her here)
    assert.ok(presentIds(c).includes('bryn'));
    assert.doesNotMatch(await factsText(blocks), /has just come in/);
});

test('nowhere this block: can\'t be found, even where an option points; no stamp', async () => {
    const { c } = boot({ time: '10:00' });
    assert.equal(sched(c, 'nell', H(10)).pick, NOWHERE, 'precondition: Nell rolled nowhere');
    const { d, appear, m } = await find(c, 'Nell');
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'Nell is nowhere to be found right now.');
    assert.deepEqual(appear, []);
    assert.equal(m.extra.worldscrawl_bracket.status, 'rejected');
    assert.equal(placeNow(c, 'nell'), null);
});

test('off the map this block counts as nowhere: can\'t be found from a room the block lists', async () => {
    const { c } = boot({ time: '10:00' });
    const s = sched(c, 'odo', H(10));
    assert.equal(s.how, 'offmap', 'precondition: Odo rolled the fishing camp');
    const { d, appear } = await find(c, 'Odo');
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'Odo is nowhere to be found right now.');
    assert.deepEqual(appear, []);
});

test('is-at entries: elsewhere on the map, or off the map (asleep near the inn): can\'t be found; standing where they are is "right here"', async () => {
    const cellar = boot({ time: '15:30' });
    assert.equal(sched(cellar.c, 'hesk', H(15, 30)).kind, 'schedule', 'precondition: Hesk is on an is-at entry (the cellar)');
    const a = await find(cellar.c, 'Hesk');
    assert.equal(a.d.ok, false);
    assert.match(a.d.reason, /is somewhere else right now\.$/);
    assert.deepEqual(a.appear, []);
    const asleep = boot({ time: '08:00', here: UP });
    assert.equal(sched(asleep.c, 'hesk', H(8)).offmap, true, 'precondition: asleep, off the map near the Drowned Rat');
    const b = await find(asleep.c, 'Hesk');
    assert.equal(b.d.ok, false, 'the old placeless [find] is gone for the player');
    assert.match(b.d.reason, /is nowhere to be found right now\.$/);
    assert.ok(!(b.m.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_found'), 'no found room');
    const bar = boot({ time: '20:00' });
    const h = await find(bar.c, 'Hesk');
    assert.equal(h.d.here, true);
    assert.match(h.d.reason, /is right here\.$/);
});

test('a room the block lists directly: she comes here, guaranteed, until the block ends; the narrator is told; then the store as usual', async () => {
    const { c, blocks } = boot({ time: '10:00' });
    assert.equal(sched(c, 'vera', H(10)).address, SQ, 'precondition: Vera rolled the square');
    assert.equal(placeNow(c, 'vera'), SQ);
    const { d, appear, m } = await find(c, 'Vera');
    assert.equal(d.ok, true, d.reason);
    assert.equal(d.moved, true);
    assert.equal(d.reason, 'Found: Vera comes here, until 12:00.');
    assert.equal(appear.length, 1);
    assert.deepEqual({ place: appear[0].place, whole: appear[0].whole, blockStart: appear[0].blockStart }, { place: BAR, whole: true, blockStart: day0(c) * 1440 + H(9) });
    assert.equal(m.extra.worldscrawl_bracket.status, 'ok');
    await scene.prepareNpcs(m);
    assert.equal((m.extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appear' && s.id === 'vera').length, 1, 'the turn\'s own pass adds no second stamp');
    assert.equal(placeNow(c, 'vera'), BAR);
    assert.ok(presentIds(c).includes('vera'));
    const text = await factsText(blocks);
    assert.match(text, /Vera has just come in\./);
    assert.doesNotMatch(text, /%|\broll|might be at|nowhere|wander|\bblock\b|segment|\[find\]/i, 'in-world facts only');
    // Who's here for the common room agrees with the cast panel.
    assert.ok(whoAt(c.chat, c.chat.length - 1, cast(), envOf(c), BAR).some(r => r.id === 'vera' && r.here));
    reply(c, 'Vera comes in with a basket of eggs.');
    say(c, 'I nod to her.');
    assert.doesNotMatch(await factsText(blocks), /has just come in/, 'only on the turn of the [find]');
    reply(c, 'She nods back.');
    await waitFor(c, '[wait] 1h'); // 11:00: still the same block
    assert.equal(placeNow(c, 'vera'), BAR);
    // The player leaves: she stays in the common room for the rest of the block.
    say(c, 'I step out to the square.', { worldscrawl_location: SQ }); reply(c, 'The square.');
    assert.equal(placeNow(c, 'vera'), BAR);
    assert.ok(!presentIds(c).includes('vera'));
    await waitFor(c, '[wait] 1h30m'); // 12:30: the block is over
    assert.equal(placeNow(c, 'vera'), STORE, 'her normal schedule again');
    // Next day, same block: the [find] is long gone; the roll decides again.
    await waitFor(c, '[wait] 22h');
    assert.equal(placeNow(c, 'vera'), sched(c, 'vera', H(10) + 1440).address);
});

test('an area option: a public room inside it counts and she comes there; standing in a private room of it, she can\'t be found', async () => {
    const pub = boot({ time: '10:00' });
    assert.equal(sched(pub.c, 'ash', H(10)).address, SQ, 'precondition: Ash rolled the square');
    const a = await find(pub.c, 'Ash');
    assert.equal(a.d.ok, true, a.d.reason);
    assert.equal(a.d.moved, true);
    assert.equal(a.appear[0].place, BAR);
    assert.equal(placeNow(pub.c, 'ash'), BAR);
    const priv = boot({ time: '10:00', here: UP });
    const b = await find(priv.c, 'Ash');
    assert.equal(b.d.ok, false);
    assert.equal(b.d.reason, "Ash wouldn't be around here right now.");
    assert.deepEqual(b.appear, []);
    assert.equal(placeNow(priv.c, 'ash'), SQ);
});

test('a private room the block names outright counts: she comes up', async () => {
    const { c } = boot({ time: '10:00', here: UP });
    assert.equal(sched(c, 'pim', H(10)).address, SQ, 'precondition: Pim rolled the square');
    const { d, appear } = await find(c, 'Pim');
    assert.equal(d.ok, true, d.reason);
    assert.equal(appear[0].place, UP);
    assert.equal(placeNow(c, 'pim'), UP);
    assert.ok(presentIds(c).includes('pim'));
});

test('a wandering block (Hesk buying for the inn): a nowhere stretch can\'t be found; from a listed room she comes and holds through every stretch to the block end', async () => {
    const early = boot({ time: '10:10', here: STORE });
    assert.equal(sched(early.c, 'hesk', H(10, 10)).pick, NOWHERE, 'precondition: this stretch (10:00-10:30) is nowhere');
    const no = await find(early.c, 'Hesk');
    assert.equal(no.d.ok, false);
    assert.match(no.d.reason, /is nowhere to be found right now\.$/);
    const { c } = boot({ time: '11:10', here: STORE });
    const s = sched(c, 'hesk', H(11, 10));
    assert.equal(s.address, 'riverton:streets/market_lane', 'precondition: this stretch (11:00-12:00) is Market Lane');
    assert.equal(sched(c, 'hesk', H(12, 10)).pick, NOWHERE, 'precondition: the next stretch is nowhere by itself');
    const { d, appear, m } = await find(c, 'Hesk');
    assert.equal(d.ok, true, d.reason);
    assert.match(d.reason, /^Found: .* comes here, until 13:00\.$/);
    assert.equal(appear[0].whole, true);
    assert.equal(appear[0].segStart, undefined, 'the whole block, not one stretch');
    await scene.prepareNpcs(m);
    reply(c, 'She comes in with a list.');
    await waitFor(c, '[wait] 1h'); // 12:10: past the 12:00 boundary, into a stretch that rolled nowhere
    assert.equal(placeNow(c, 'hesk'), STORE);
    assert.ok(presentIds(c).includes('hesk'));
    await waitFor(c, '[wait] 30m'); // 12:40: another boundary (12:30)
    assert.equal(placeNow(c, 'hesk'), STORE);
    await waitFor(c, '[wait] 40m'); // 13:20: the block is over; the next block (the Drowned Rat) decides
    assert.equal(placeNow(c, 'hesk'), sched(c, 'hesk', H(13, 20)).address);
    assert.notEqual(placeNow(c, 'hesk'), STORE);
});

test('not one of the block\'s options: can\'t be found; a second [find] from a listed room later in the block moves her again', async () => {
    const { c } = boot({ time: '10:00' });
    assert.equal(sched(c, 'sol', H(10)).address, SQ, 'precondition: Sol is on the square');
    const no = await find(c, 'Sol');
    assert.equal(no.d.ok, false);
    assert.equal(no.d.reason, "Sol wouldn't be around here right now.");
    assert.deepEqual(no.appear, []);
    assert.equal(placeNow(c, 'sol'), SQ);
    // Vera: found in the common room, then the player goes to the square (a listed room) and finds her there.
    const v = await find(c, 'Vera');
    assert.equal(v.d.moved, true);
    reply(c, 'Vera comes in.');
    const sq = await find(c, 'Vera', { worldscrawl_location: SQ });
    assert.equal(sq.d.here, undefined);
    assert.equal(sq.d.moved, true, sq.d.reason);
    assert.equal(placeNow(c, 'vera'), SQ);
});

test('a re-run of the same [find] on the same message judges from before it (the swipe or reload path), never "right here" from its own stamp', async () => {
    const { c } = boot({ time: '10:00' });
    const { m } = await find(c, 'Vera');
    const again = await scene.applyFound(m, ['Vera'], 'bracket');
    assert.equal(again[0].moved, true, again[0].reason);
    assert.equal((m.extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appear' && s.source === 'bracket').length, 1);
});

test('unknown name and the tracker path: no saved person is a plain rejection; the story\'s found still uses the placeless near', async () => {
    const { c } = boot({ time: '08:00', here: UP });
    const { d } = await find(c, 'Zed');
    assert.equal(d.ok, false);
    assert.match(d.reason, /No saved person is called "Zed"/);
    const m = say(c, 'She comes down the stairs.');
    const got = await scene.applyFound(m, ['Hesk'], 'tracker');
    assert.equal(got[0].ok, true, got[0].reason);
    assert.ok((m.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_found' && s.where === 'her own room' && s.place === UP));
});
