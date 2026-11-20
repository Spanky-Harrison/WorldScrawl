// 4-WN part N: who is or is not here this turn goes after the player's message (the reminder), in one fixed order:
// arrival, who is already there (narration.npc_on_arrival, new), a failed attempt, found, comings, not found, identity.
// Through the real handlers: a real world server behind the fetch shim, the [move]/[find]/[wait] brackets
// (bracketIntent), prepareNpcs and applyFacts (FACTS and REMINDER as setExtensionPrompt gets them).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir, isTrackerCall } from './helpers.mjs';
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
    // The landlady (name not known to the player): buying in the square 09:00-12:00 (the hesk-trace shape).
    { ...card('hesk', 'Hesk', [{ might: [SQ], activity: 'buying for the inn', from: '09:00', to: '12:00' }]), unknownAs: 'the landlady' },
    // Bryn: always the common room 09:00-12:00.
    card('bryn', 'Bryn', [{ might: [BAR], activity: 'waiting for the tide', from: '09:00', to: '12:00' }]),
    // Nell: 1% the common room, the rest nowhere (a [find] turns her down).
    { ...card('nell', 'Nell', [{ might: [`${BAR}(1)`], activity: 'drinking', from: '09:00', to: '12:00' }]), unknownAs: 'the fishwife' },
    // Vera: the square almost always, the common room listed directly (a [find] brings her).
    card('vera', 'Vera', [{ might: [`${SQ}(99)`, `${BAR}(1)`], activity: 'selling eggs', from: '09:00', to: '12:00' }]),
    // Tam: the common room from 10:30 (comes in while the player waits).
    card('tam', 'Tam', [{ place: SQ, activity: 'mending nets', from: '09:00', to: '10:30' }, { place: BAR, activity: 'drinking', from: '10:30', to: '12:00' }]),
];

let sv = null, chats = 0;
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
    c.chatId = `wn${++chats}`; c.getCurrentChatId = () => c.chatId;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {}, calls = [];
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => { calls.push(String(args?.prompt ?? '')); return isTrackerCall(args) ? '{"place": null, "people": [], "wait": null}' : ''; };
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
/** Type `[find] Name` (the real bracket); then the turn's own pass. */
async function find(c, name) {
    const m = say(c, `[find] ${name}`);
    await bracketIntent(m, parseBracket(m.mes));
    await scene.prepareNpcs(m);
    return { m, d: (m.extra[FOUND_KEY] ?? []).find(x => x.source === 'bracket') };
}
const move = async (c, text) => { const m = say(c, text); const r = await bracketIntent(m, parseBracket(text)); assert.notEqual(r.kind, 'bracket_failed', r.note); await scene.prepareNpcs(m); return m; };
const R = blocks => blocks[ext.REMINDER_KEY] ?? '';
const F = blocks => blocks[ext.FACTS_KEY] ?? '';
const notesOf = c => c.chat.flatMap(m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat());

const lines = blocks => R(blocks).split('\n').filter(Boolean);
const ARRIVE = 'Already in Village Square when You got there: the landlady (buying for the inn); Tam (mending nets); Vera (selling eggs). Show them in this reply.';

test('the hesk-trace case: moving out to the square, who is already there is told after the player\'s message, right after the arrival reminder, by shown name and activity', async () => {
    const { c, blocks, calls } = boot({ time: '10:00' });
    assert.equal(sched(c, 'bryn', H(10)).address, BAR, 'precondition: Bryn is in the common room');
    const m = await move(c, 'I [move] out');
    assert.ok((m.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_appear' && s.id === 'hesk'), 'her appear stamp is on the move message');
    const n = calls.length;
    await scene.applyFacts();
    assert.equal(calls.length, n, 'no model call');
    const r = lines(blocks);
    assert.match(r[0], /^\[At the end of this reply the characters are in Village Square\./);
    assert.equal(r[1], ARRIVE, r.join('\n'));
    assert.doesNotMatch(R(blocks), /Bryn/, 'whoever stayed behind is not in it');
    assert.doesNotMatch(F(blocks), /Already in/, 'not in the facts block');
    assert.match(F(blocks), /^the landlady \[\w+\]: .*Now: buying for the inn\./m, 'still listed under People here');
    // Name masking: her name is not known, so every new line says "the landlady"; the reminder never has her name.
    assert.doesNotMatch(R(blocks), /Hesk/);
    assert.ok(!notesOf(c).some(x => x.kind === 'name leak'), JSON.stringify(notesOf(c)));
});

test('a follower who came along is not "already there"; the next (stay) turn has no arrival line at all', async () => {
    const { c, blocks } = boot({ time: '10:00' });
    c.chat[0].extra[NPC_KEY] = [{ type: 'npc_create', id: 'corwin', name: 'Corwin', line: 'a ferryman with a tarred coat' }, { type: 'npc_follow', id: 'corwin' }];
    assert.ok(presentIds(c).includes('corwin'), 'precondition: Corwin is with the party');
    await move(c, '[move] out');
    await scene.applyFacts();
    assert.ok(presentIds(c).includes('corwin'), 'he came along');
    const line = lines(blocks).find(l => l.startsWith('Already in'));
    assert.ok(line, R(blocks));
    assert.doesNotMatch(line.split('got there:')[1], /Corwin/, 'not listed as already there (he is in the party words)');
    assert.match(line, /the landlady \(buying for the inn\)/);
    reply(c, 'The square is busy.');
    say(c, 'I look at the stalls.');
    await scene.applyFacts();
    assert.doesNotMatch(R(blocks), /Already in/, 'a stay turn: none');
});

test('found and comings are after the player\'s message, not in the people-here block; the found line says they are here; gone the next turn', async () => {
    const { c, blocks } = boot({ time: '10:10' });
    const w = say(c, '[wait] 30m'); await bracketIntent(w, parseBracket(w.mes)); await scene.prepareNpcs(w);
    await scene.applyFacts();
    assert.match(R(blocks), /^Since the last reply, at these times:\n[\s\S]*\[10:30\] Tam arrives\.[\s\S]*\nShow each one in this reply where its time fits: whoever left is gone at the end of it, and whoever arrived is here\.$/m);
    assert.doesNotMatch(F(blocks), /Since the last reply|Tam arrives/);
    reply(c, 'Tam comes in, shaking off the cold.');
    const { m } = await find(c, 'Vera');
    assert.equal(m.extra[FOUND_KEY].find(x => x.source === 'bracket').ok, true);
    await scene.applyFacts();
    assert.ok(lines(blocks).includes('Vera came in just now and is here at the end of this reply. Show them arriving.'), R(blocks));
    assert.doesNotMatch(F(blocks), /came in just now|has just come in/);
    reply(c, 'Vera sets down her basket.');
    say(c, 'I buy an egg.');
    await scene.applyFacts();
    assert.doesNotMatch(R(blocks), /came in just now|Since the last reply/, 'only on their own turn');
});

test('the not-found line says where they are not, positively, and the identity line follows it', async () => {
    const { c, blocks } = boot({ time: '10:00' });
    c.chat[0].extra[NPC_KEY] = [{ type: 'npc_name', id: 'nell', who: 'player', source: 'bracket' }];
    const { d } = await find(c, 'Nell');
    assert.equal(d.ok, false, d.reason);
    await scene.applyFacts();
    const r = lines(blocks), i = r.findIndex(l => l.startsWith('You looked for Nell'));
    assert.equal(r[i], 'You looked for Nell and did not find them: Nell is somewhere else, and this reply ends without them. Show the search coming up empty. Anyone who answers is one of the people listed here, speaking as themselves.');
    assert.doesNotMatch(R(blocks), /no voice|no glimpse|does not appear/);
    assert.equal(r[i + 1], 'Nell is the fishwife.');
    assert.doesNotMatch(F(blocks), /looked for Nell/);
});

test('one turn with all of them: attempt, found, comings, not found, identity, in that order', async () => {
    const { c, blocks } = boot({ time: '10:10' });
    c.chat[0].extra[NPC_KEY] = [{ type: 'npc_name', id: 'nell', who: 'player', source: 'bracket' }];
    const w = say(c, '[wait] 30m'); await bracketIntent(w, parseBracket(w.mes)); await scene.prepareNpcs(w);
    const { m } = await find(c, 'Vera'); // no reply in between: the wait's comings are still news on this turn
    m.extra.worldscrawl_dig_failed = true; // a failed attempt on the same turn
    m.extra[FOUND_KEY].push({ swipe: 0, name: 'Nell', id: 'nell', ok: false, reason: 'not around', source: 'bracket', where: '', place: '' });
    await scene.applyFacts();
    const r = lines(blocks);
    const at = re => { const i = r.findIndex(l => re.test(l)); assert.ok(i >= 0, `${re} in:\n${r.join('\n')}`); return i; };
    const order = [at(/^What just happened: You tried to break through, but it FAILED/), at(/^Vera came in just now/), at(/^Since the last reply/), at(/^You looked for Nell/), at(/^Nell is the fishwife\.$/)];
    assert.deepEqual([...order].sort((a, b) => a - b), order, r.join('\n'));
    assert.equal(r.at(-1), 'Nell is the fishwife.', 'not-found and identity stay last, nearest the reply');
});

test('a move turn: the arrival reminder first, then who is already there, then a found person (who is not repeated as already there)', async () => {
    const { c, blocks } = boot({ time: '10:00' });
    const m = await move(c, '[move] out');
    // The turn's own [find] result (as a found flag would leave it): Vera, brought into the square this turn.
    (m.extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appear' && s.id === 'vera').forEach(s => { s.whole = true; });
    await scene.applyFacts();
    const r = lines(blocks);
    assert.match(r[0], /^\[At the end of this reply/);
    assert.equal(r[1], 'Already in Village Square when You got there: the landlady (buying for the inn); Tam (mending nets). Show them in this reply.');
    assert.equal(r[2], 'Vera came in just now and is here at the end of this reply. Show them arriving.');
});
