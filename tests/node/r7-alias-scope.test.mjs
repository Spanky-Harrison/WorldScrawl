// R7: alias scope bias. Two saved people share a label ("a guard"); the scope ladder (names.mjs resolvePerson, fed by
// scene.mjs personScope at the resolved message's clock and position) picks the nearer one, or names both ("Which one?")
// when they are equally near. Through the real handlers: a real world server (Riverton plus guard cast files) behind
// the fetch shim, the [find] / [name] brackets (bracketIntent), /ws-know (setRelOn), onReplyForFlags -> runTracker ->
// applyTrackerResult with a fake model routed by isTrackerCall, the real [move] bracket for came_along, and swipes.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, SQUARE, copytree, tmpPath, write, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const N = await import('../../extension/names.mjs');
const scene = await import('../../extension/scene.mjs');
const NPCM = await import('../../extension/npc.mjs');
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const { messageActivity } = await import('../../extension/activity.mjs');
const { callNotes } = await import('../../extension/calllog.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const LANE = 'riverton:streets/market_lane', DOCKS = 'riverton:docks/piers', GREEN = 'larkspur:green/green', BATHS = 'larkspur:baths/hall';
const NPC = 'worldscrawl_npc', WARN = 'worldscrawl_npcwarn', FOUND = 'worldscrawl_found';
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- the cast: guards who share a label, each always at one place (or off the map near one).
const guard = (id, name, place, extra = {}) => ({
    id, name, unknownAs: 'a guard', personality: { summary: `${name}, a town guard.` },
    schedule: [{ place, activity: 'standing guard', from: '00:00', to: '23:59', importance: 'high' }], ...extra,
});
const BRAN = (place = SQUARE) => guard('guard_a', 'Bran', place);
const TOBIN = (place = GREEN) => guard('guard_b', 'Tobin', place);
const REAL = /\b(Bran|Tobin|Corla|Dace)\b/;

const servers = new Map();
function serverFor(cards) {
    const key = JSON.stringify(cards);
    if (!servers.has(key)) {
        const d = tmpPath();
        copytree(path.dirname(RIVERTON), d);
        for (const card of cards) write(path.join(d, 'riverton', 'cast', `${card.id}.json`), JSON.stringify(card, null, 2));
        servers.set(key, clientDir(d));
    }
    return servers.get(key);
}
let n = 0;
/** A fresh chat with the player at `here` (12:00), the cast plus `cards`; `tracker` answers each tracker call. */
function boot({ cards = [BRAN(), TOBIN()], here = SQUARE, tracker = { place: null, people: [], wait: null }, time = '12:00' } = {}) {
    exitsCache.clear();
    const server = serverFor(cards);
    globalThis.BroadcastChannel = undefined;
    globalThis.document = makeDoc([0]);
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext(), id = `r7_${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    const seen = [];
    c.generateRaw = async args => {
        if (!isTrackerCall(args)) return '{}';
        const a0 = typeof tracker === 'function' ? tracker(seen.length) : tracker;
        seen.push(args);
        return typeof a0 === 'string' ? a0 : JSON.stringify(a0);
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'The street is busy.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }];
    return { c, seen };
}
const say = (c, text) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra: {} }); return c.chat.length - 1; };
const reply = (c, text, extra = {}) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }); return c.chat.length - 1; };
const stamps = (m, type) => (m.extra?.[NPC] ?? []).filter(s => !type || s.type === type);
const matchNotes = m => callNotes(m).filter(x => x.kind === 'person match');
async function bracket(c, text) { const i = say(c, text); c.chat[i].extra.worldscrawl_intent_checked = true; const r = await bracketIntent(c.chat[i], parseBracket(text)); return { r, i, msg: c.chat[i] }; }
async function exchange(c, player, story) { say(c, player); const id = reply(c, story); globalThis.document = makeDoc(c.chat.map((_, i) => i)); await onReplyForFlags(id); await flush(40); return id; }
const people = (...items) => ({ place: null, people: items, wait: null });
const env = c => scene.npcEnv(c.chat, null);

// ---- 7. The ladder itself (pure).
test('R7.7 the ladder: same room 0, same subregion 1, same region 2, elsewhere 3; a person is the nearer of now and their anchors + 1, off-map near included', () => {
    const { placeLevel, scopeLevel } = N;
    assert.equal(placeLevel(SQUARE, SQUARE), 0);
    assert.equal(placeLevel(SQUARE, LANE), 1);
    assert.equal(placeLevel(SQUARE, 'riverton:streets'), 1, 'an area address is at the area level');
    assert.equal(placeLevel(SQUARE, DOCKS), 2);
    assert.equal(placeLevel(SQUARE, 'riverton'), 2);
    assert.equal(placeLevel(SQUARE, GREEN), 3);
    assert.equal(placeLevel(SQUARE, ''), 3, 'no known place');
    assert.equal(placeLevel('', SQUARE), 3, 'no player position');
    assert.equal(scopeLevel(SQUARE, { now: [SQUARE] }), 0);
    assert.equal(scopeLevel(SQUARE, { now: [], anchors: [SQUARE] }), 1, 'works here sometimes: one level wider');
    assert.equal(scopeLevel(SQUARE, { now: [GREEN], anchors: [LANE] }), 2, 'min(3, 1 + 1)');
    assert.equal(scopeLevel(SQUARE, { now: [LANE], anchors: [SQUARE] }), 1, 'due in the area beats an anchor in the room (1 vs 0 + 1)');
    assert.equal(scopeLevel(SQUARE, {}), 3);
    assert.equal(scopeLevel(BATHS, { now: ['larkspur:baths'] }), 1, 'off the map near the baths: the area level');
});

test('R7.7 personPlaces through the real env: an is-at guard is due at her place; an off-map entry counts by its near; anchors list every schedule place', async () => {
    const off = guard('guard_c', 'Corla', '', { schedule: [{ activity: 'asleep in the barracks', where: 'the barracks', near: 'riverton:docks', from: '00:00', to: '23:59' }, { place: LANE, activity: 'patrolling', from: '06:00', to: '07:00' }] });
    const { c } = boot({ cards: [BRAN(), off] });
    const cast = scene.castPack().npcs;
    const p = NPCM.personPlaces(cast.find(x => x.id === 'guard_a'), 0, env(c));
    assert.deepEqual(p, { now: [SQUARE], anchors: [SQUARE] });
    const q = NPCM.personPlaces(cast.find(x => x.id === 'guard_c'), 0, env(c));
    assert.deepEqual(q.now, ['riverton:docks'], JSON.stringify(q));
    assert.ok(q.anchors.includes('riverton:docks') && q.anchors.includes(LANE), JSON.stringify(q));
    const scope = scene.personScope(c.chat, 0);
    assert.equal(scope.levelOf(cast.find(x => x.id === 'guard_c')), 2, 'from the square: off the map near the Docks (2) and the lane anchor (1 + 1)');
    const there = boot({ cards: [BRAN(), off], here: LANE }).c;
    assert.equal(scene.personScope(there.chat, 0).levelOf(scene.castPack().npcs.find(x => x.id === 'guard_c')), 1, 'from the lane: the lane anchor (0 + 1)');
});

// ---- 1. [find] picks the nearer guard, with the Activity note at the town level.
test('R7.1 [find] a guard: from the Drowned Rat the Riverton guard (same town) wins over the Larkspur one, with the Activity note; from her own square no note', async () => {
    let { c } = boot({ here: TAVERN });
    let { r, msg } = await bracket(c, '[find] a guard');
    const [d] = msg.extra[FOUND];
    assert.equal(d.id, 'guard_a', JSON.stringify(d));
    assert.notEqual(r.kind, 'bracket_failed');
    assert.deepEqual(matchNotes(msg).map(x => x.reason), ["'guard' read as a guard at Village Square, nearest to you"], 'the bracket target, as [find] read it');
    assert.ok(messageActivity(msg, 1).some(e => e.label === 'person match' && /read as a guard at Village Square, nearest to you/.test(e.reason ?? e.text ?? '')), JSON.stringify(messageActivity(msg, 1)));
    ({ c } = boot({ here: SQUARE }));
    ({ r, msg } = await bracket(c, '[find] a guard'));
    assert.equal(msg.extra[FOUND][0].id, 'guard_a');
    assert.equal(msg.extra[FOUND][0].here, true, 'she is right here');
    assert.deepEqual(matchNotes(msg), [], 'a same-room pick is not noted');
});

// ---- 2. Equally near: no guess, "Which one?".
test('R7.2 [find] a guard with both equally far (the player in Larkspur, the guards in two Riverton areas): "Which one?" with shown names and places, no stamp, no reply', async () => {
    const { c } = boot({ cards: [BRAN(SQUARE), TOBIN(DOCKS)], here: GREEN });
    const { r, msg } = await bracket(c, '[find] a guard');
    assert.equal(r.kind, 'bracket_failed');
    assert.equal(r.command, true, 'the short-circuit: no narrator reply');
    assert.equal(r.note, 'Which one? a guard (Village Square), a guard (River Docks)');
    assert.equal(msg.extra[FOUND][0].id, '');
    assert.deepEqual(stamps(msg), []);
    assert.deepEqual(matchNotes(msg), []);
});

test('R7.2b the "Which one?" notice never leaks a name the player has not learned: [find], [name], /ws-know and /ws-find; a learned name shows', async () => {
    const { c } = boot({ cards: [BRAN(SQUARE), TOBIN(DOCKS)], here: GREEN });
    const reasons = [];
    reasons.push((await bracket(c, '[find] a guard')).r.note);
    reasons.push((await bracket(c, '[name] a guard')).r.note);
    const k = say(c, 'I think about the guards.');
    reasons.push((await scene.setRelOn(c.chat[k], 'a guard | met')).reason);
    const notices = [];
    const realAdd = c.chat.length;
    await ext.findCommand('a guard');
    for (const m of c.chat.slice(realAdd)) notices.push(String(m.mes ?? ''));
    for (const t of reasons) assert.equal(t, 'Which one? a guard (Village Square), a guard (River Docks)');
    assert.deepEqual(notices, ['Which one? a guard (Village Square), a guard (River Docks)'], '/ws-find: the same text as a notice');
    for (const t of [...reasons, ...notices, JSON.stringify(c.chat.map(m => m.extra?.[FOUND] ?? []))]) assert.doesNotMatch(t, REAL, t);
    // Bran's name learned: the notice may say it; Tobin's never.
    c.chat[k].extra[NPC] = [{ type: 'npc_name', id: 'guard_a', who: 'player', source: 'bracket', swipe: 0 }];
    const after = (await bracket(c, '[find] a guard')).r.note;
    assert.equal(after, 'Which one? Bran (Village Square), a guard (River Docks)');
    assert.doesNotMatch(after, /Tobin/);
});

// ---- 3. Tracker stamps.
test('R7.3 a tracker fact for "a guard": the guard in this square gets it; two guards here: the warning, not applied', async () => {
    const fact = people({ id: 'a guard', action: 'fact', text: 'Keeps the gate keys.' });
    const story = 'A guard leans on her spear by the well. "I keep the gate keys," the guard says.';
    let { c } = boot({ tracker: fact });
    let id = await exchange(c, 'I nod to the guard.', story);
    assert.deepEqual(stamps(c.chat[id], 'npc_fact').map(s => s.id), ['guard_a'], JSON.stringify(c.chat[id].extra));
    assert.deepEqual(c.chat[id].extra[WARN] ?? [], []);
    ({ c } = boot({ cards: [BRAN(SQUARE), guard('guard_d', 'Dace', SQUARE)], tracker: fact }));
    id = await exchange(c, 'I nod to the guards.', story);
    assert.deepEqual(stamps(c.chat[id], 'npc_fact'), []);
    assert.deepEqual((c.chat[id].extra[WARN] ?? []).map(w => w.text), ['Warning: a person update did not land: "a guard" matches 2 saved people here; not applied.']);
});

// ---- 4. Name learning: the near guard, and judgeLearn still applies.
test('R7.4 learning a name: the tracker\'s name item for "a guard" lands on the guard here (judgeLearn passes); from the inn it is the same guard, refused as not here; [name] a guard lands on the near one', async () => {
    const named = people({ id: 'a guard', action: 'name', name: 'Bran' });
    let { c } = boot({ tracker: named });
    let id = await exchange(c, 'Who are you?', 'The guard straightens. "Bran," she says.');
    assert.deepEqual(stamps(c.chat[id], 'npc_name').map(s => [s.id, s.source]), [['guard_a', 'tracker']], JSON.stringify(c.chat[id].extra));
    ({ c } = boot({ tracker: named, here: TAVERN }));
    id = await exchange(c, 'Who are you?', 'Across town, someone says "Bran".');
    assert.deepEqual(stamps(c.chat[id], 'npc_name'), []);
    assert.ok(callNotes(c.chat[id]).some(x => x.kind === 'name learn' && x.status === 'skipped' && /Bran is not here/.test(x.reason)), JSON.stringify(callNotes(c.chat[id])));
    ({ c } = boot({ here: SQUARE }));
    const { r, msg } = await bracket(c, '[name] a guard');
    assert.equal(r.kind, 'name');
    assert.deepEqual(stamps(msg, 'npc_name').map(s => s.id), ['guard_a']);
});

// ---- 5 and 8. Tier against level.
const GATE = guard('guard_g', 'Corla', SQUARE, { unknownAs: 'the gate guard', aliases: ['gate guard'] });
const DOCKER = guard('guard_d', 'Dace', DOCKS);
test('R7.8 room beats a distant generic label: [find] guard in the gate guard\'s square picks her (a loose match) over the Docks guard ("a guard", an exact unknownAs only, not a proper name)', async () => {
    const { c } = boot({ cards: [GATE, DOCKER], here: SQUARE });
    const { msg } = await bracket(c, '[find] guard');
    assert.equal(msg.extra[FOUND][0].id, 'guard_g');
    assert.equal(msg.extra[FOUND][0].here, true);
});
test('R7.8b both in the room: the exact match ("a guard") beats the loose one (the gate guard\'s alias) among them', async () => {
    const { c } = boot({ cards: [GATE, guard('guard_d', 'Dace', SQUARE)], here: SQUARE });
    const { msg } = await bracket(c, '[find] guard');
    assert.equal(msg.extra[FOUND][0].id, 'guard_d', JSON.stringify(msg.extra[FOUND]));
    assert.deepEqual(matchNotes(msg), []);
});
test('R7.5 no tier jumping: from the market lane (the gate guard\'s area, level 1, loose) the Docks guard (level 2, exact) wins, with the note', async () => {
    const { c } = boot({ cards: [GATE, DOCKER], here: LANE });
    const { msg } = await bracket(c, '[find] guard');
    assert.equal(msg.extra[FOUND][0].id, 'guard_d', JSON.stringify(msg.extra[FOUND]));
    assert.deepEqual(matchNotes(msg).map(x => x.reason), ["'guard' read as a guard at River Docks, nearest to you"]);
});

// ---- 6. Handles and ids skip the ladder.
test('R7.6 a handle or a cast id names its person wherever they are: [find] guard_b and a tracker fact by handle reach the far guard', async () => {
    let { c } = boot({ here: SQUARE });
    const { msg } = await bracket(c, '[find] guard_b');
    assert.equal(msg.extra[FOUND][0].id, 'guard_b');
    assert.deepEqual(matchNotes(msg), []);
    const r = N.resolvePerson('guard_b', scene.castPack().npcs, scene.personScope(c.chat, 0));
    assert.deepEqual([r.person?.id, r.biased, r.level], ['guard_b', false, null]);
    const h = N.resolvePerson(N.handleOf('guard_b'), scene.castPack().npcs, scene.personScope(c.chat, 0));
    assert.deepEqual([h.person?.id, h.biased], ['guard_b', false]);
    ({ c } = boot({ here: SQUARE, tracker: () => people({ id: N.handleOf('guard_b'), action: 'memory', text: 'Heard about the stranger in Riverton.' }) }));
    const id = await exchange(c, 'I wave.', 'The guard waves back.');
    assert.deepEqual(stamps(c.chat[id], 'npc_memory').map(s => s.id), ['guard_b'], JSON.stringify(c.chat[id].extra));
});

// ---- 9. Stable on rebuild, re-run and swipe.
test('R7.9 stable: a tracker "a guard" stamp resolved at message k keeps its guard after the player moves to Larkspur and time passes; re-running message k resolves the same', async () => {
    const { c } = boot({ tracker: people({ id: 'a guard', action: 'memory', text: 'The stranger asked about the gate.' }) });
    const k = await exchange(c, 'Which way to the gate?', 'A guard points down the lane.');
    assert.deepEqual(stamps(c.chat[k], 'npc_memory').map(s => s.id), ['guard_a']);
    // Later: the player is on Larkspur Green, next to the other guard, hours later.
    say(c, 'I walk to Larkspur.');
    reply(c, 'You reach Larkspur Green by evening.', { worldscrawl_location: GREEN });
    const w = say(c, '[wait] 6h'); c.chat[w].extra.worldscrawl_intent_checked = true;
    const wr = await bracketIntent(c.chat[w], parseBracket('[wait] 6h'));
    assert.notEqual(wr.kind, 'bracket_failed', wr.note);
    reply(c, 'The evening drags on.');
    assert.equal(env(c).playerAt(c.chat.length - 1), GREEN, 'precondition: the player is in Larkspur now');
    assert.ok(env(c).clock(c.chat.length - 1).elapsed > env(c).clock(k).elapsed, 'precondition: time passed');
    // Rebuild: the frames still hold the memory on the Riverton guard.
    const last = NPCM.framesOf(c.chat, c.chat.length - 1, scene.castPack().npcs).at(-1);
    assert.ok((last.get('guard_a').memory ?? []).includes('The stranger asked about the gate.'));
    assert.ok(!(last.get('guard_b').memory ?? []).includes('The stranger asked about the gate.'));
    // Re-run (a swipe of k re-reads it): the same guard.
    c.chat[k].extra[NPC] = [];
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    await onReplyForFlags(k); await flush(40);
    assert.deepEqual(stamps(c.chat[k], 'npc_memory').map(s => s.id), ['guard_a'], JSON.stringify(c.chat[k].extra));
    // And the scope at k is k's own: the square, not Larkspur.
    assert.equal(scene.personScope(c.chat, k).here, SQUARE);
});

// ---- came_along (rev 6): the "Just left behind" candidate from the old room.
test('R7 came_along: "a guard" came along out of the inn: the guard who was in the common room, not the one in the market lane (nearer the new square)', async () => {
    const { c } = boot({ cards: [BRAN(TAVERN), TOBIN(LANE)], here: TAVERN, time: '17:00', tracker: () => people({ id: 'a guard', action: 'came_along' }) });
    const p = say(c, 'I [move] out');
    c.chat[p].extra.worldscrawl_intent_checked = true;
    const r = await bracketIntent(c.chat[p], parseBracket(c.chat[p].mes));
    assert.equal(r.kind, 'move', r.note);
    await scene.prepareNpcs(c.chat[p]);
    const id = reply(c, 'A guard follows you out of the inn into the square.');
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    await onReplyForFlags(id); await flush(40);
    const along = stamps(c.chat[id], 'npc_along');
    assert.deepEqual(along.map(s => [s.id, s.from, s.place]), [['guard_a', TAVERN, SQUARE]], JSON.stringify(c.chat[id].extra));
    assert.equal(scene.personScope(c.chat, id).here, SQUARE, 'the reply itself is in the square');
    assert.deepEqual(scene.alongScopeOf(c.chat, id)[1], { from: TAVERN });
});

// ---- Round 2 (review): the note's message, one note per re-apply, placeless ties.
test('R7 r2 came_along: a level 2/3 came_along pick notes "person match" on the reply being resolved, not on the message before the move (its scope)', async () => {
    // No guard was in the common room: the ladder reads "a guard" from the old room, and the nearest is in the square (level 2).
    const { c } = boot({ cards: [BRAN(SQUARE), TOBIN(GREEN)], here: TAVERN, time: '17:00', tracker: () => people({ id: 'a guard', action: 'came_along' }) });
    const p = say(c, 'I [move] out');
    c.chat[p].extra.worldscrawl_intent_checked = true;
    assert.equal((await bracketIntent(c.chat[p], parseBracket(c.chat[p].mes))).kind, 'move');
    await scene.prepareNpcs(c.chat[p]);
    const id = reply(c, 'A guard follows you out of the inn into the square.');
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    await onReplyForFlags(id); await flush(40);
    const [before] = scene.alongScopeOf(c.chat, id);
    assert.ok(before < id);
    assert.deepEqual(matchNotes(c.chat[id]).map(x => x.reason), ["'a guard' read as a guard at Village Square, nearest to you"], JSON.stringify(callNotes(c.chat[id])));
    for (let i = 0; i < id; i++) assert.deepEqual(matchNotes(c.chat[i]), [], `no person-match note on message ${i}`);
});

test('R7 r2 re-applying the same reply (re-run, a second apply) leaves exactly one "person match" note', async () => {
    const fact = people({ id: 'a guard', action: 'fact', text: 'Keeps the gate keys.' });
    const { c } = boot({ here: TAVERN, tracker: fact });
    const id = await exchange(c, 'I ask about the guards.', 'The barkeep says a guard in the square keeps the gate keys.');
    assert.deepEqual(stamps(c.chat[id], 'npc_fact').map(s => s.id), ['guard_a'], JSON.stringify(c.chat[id].extra));
    assert.equal(matchNotes(c.chat[id]).length, 1, JSON.stringify(callNotes(c.chat[id])));
    // Re-run: stamps cleared and the reply read again; then once more without clearing.
    c.chat[id].extra[NPC] = [];
    await onReplyForFlags(id); await flush(40);
    await onReplyForFlags(id); await flush(40);
    assert.deepEqual(matchNotes(c.chat[id]).map(x => x.reason), ["'a guard' read as a guard at Village Square, nearest to you"], JSON.stringify(callNotes(c.chat[id])));
    // The same [find] resolved twice on one message: still one.
    const k = say(c, '[find] a guard');
    scene.resolveAt(c.chat, k, 'a guard', [BRAN(SQUARE), TOBIN(GREEN)].map(g => ({ ...g })));
    scene.resolveAt(c.chat, k, 'a guard', [BRAN(SQUARE), TOBIN(GREEN)].map(g => ({ ...g })));
    assert.equal(matchNotes(c.chat[k]).length, 1);
});

test('R7 r2 a tie with no place: "(somewhere else)", entries that read the same get their handle; no unlearned name leaks', async () => {
    const LOST_A = guard('guard_a', 'Bran', SQUARE, { schedule: [] }), LOST_B = guard('guard_b', 'Tobin', SQUARE, { schedule: [] });
    let { c } = boot({ cards: [LOST_A, LOST_B], here: GREEN });
    const ha = N.handleOf('guard_a'), hb = N.handleOf('guard_b');
    assert.notEqual(ha, hb);
    const want = `Which one? a guard (somewhere else) [${ha}], a guard (somewhere else) [${hb}]`;
    const reasons = [(await bracket(c, '[find] a guard')).r.note, (await bracket(c, '[name] a guard')).r.note];
    const k = say(c, 'I think about the guards.');
    reasons.push((await scene.setRelOn(c.chat[k], 'a guard | met')).reason);
    const from = c.chat.length;
    await ext.findCommand('a guard');
    reasons.push(...c.chat.slice(from).map(m => String(m.mes ?? '')));
    assert.equal(reasons.length, 4);
    for (const t of reasons) { assert.equal(t, want); assert.doesNotMatch(t, REAL, t); }
    // The handle shown picks that one.
    const pick = await bracket(c, `[find] ${hb}`);
    assert.equal(pick.msg.extra[FOUND][0].id, 'guard_b');
    // One placed, one placeless: places tell them apart, no handle needed.
    ({ c } = boot({ cards: [BRAN(DOCKS), LOST_B], here: GREEN }));
    const mixed = (await bracket(c, '[find] a guard')).r.note;
    assert.equal(mixed, 'Which one? a guard (River Docks), a guard (somewhere else)');
    assert.doesNotMatch(mixed, REAL);
});

// ---- Round 3 (Knarfy, t460u): an exact proper name (real name or saved alias) names that person wherever they are.
const TAM = guard('tam', 'Tam', DOCKS, { unknownAs: 'a net-mender' });
const OLD_TAM = guard('old_tam', 'Old Tam', SQUARE, { unknownAs: 'an old fisherman' });
test('R7 r3 [find] Tam with "Old Tam" in the room and Tam at the Docks: Tam (an exact name not yet learned), also via /ws-know and a tracker stamp', async () => {
    let { c } = boot({ cards: [TAM, OLD_TAM], here: SQUARE });
    const { r, msg } = await bracket(c, '[find] Tam');
    assert.notEqual(r.kind, 'bracket_failed', r.note);
    assert.equal(msg.extra[FOUND][0].id, 'tam', JSON.stringify(msg.extra[FOUND]));
    assert.deepEqual(matchNotes(msg), [], 'a proper name is not a guess: no "nearest to you" note');
    const k = say(c, 'I think about Tam.');
    const rel = await scene.setRelOn(c.chat[k], 'Tam | met');
    assert.equal(rel.ok, true, rel.reason);
    assert.deepEqual(stamps(c.chat[k], 'npc_rel').map(s => s.id), ['tam']);
    // The loose match still works when no proper name is typed: "old" reads Old Tam.
    assert.equal(scene.resolveAt(c.chat, k, 'Old', [TAM, OLD_TAM]).person?.id, 'old_tam');
    ({ c } = boot({ cards: [TAM, OLD_TAM], here: SQUARE, tracker: people({ id: 'Tam', action: 'fact', text: 'Mends nets at the piers.' }) }));
    const id = await exchange(c, 'I ask Old Tam about his friend.', 'Old Tam says his friend mends nets down at the piers.');
    assert.deepEqual(stamps(c.chat[id], 'npc_fact').map(s => s.id), ['tam'], JSON.stringify(c.chat[id].extra));
});

test('R7 r3 an exact saved alias elsewhere beats a loose match in the room', async () => {
    const FAR_GATE = guard('guard_g', 'Corla', DOCKS, { unknownAs: 'a guard', aliases: ['gate guard'] });
    const NORTH = guard('guard_n', 'Dace', SQUARE, { aliases: ['north gate guard'] });
    const { c } = boot({ cards: [FAR_GATE, NORTH], here: SQUARE });
    const { msg } = await bracket(c, '[find] gate guard');
    assert.equal(msg.extra[FOUND][0].id, 'guard_g', JSON.stringify(msg.extra[FOUND]));
});

test('R7 r3 two people with the same exact real name: the nearer wins; equally far, "Which one?" with shown names only', async () => {
    const TWIN = guard('guard_x', 'Bran', DOCKS);
    let { c } = boot({ cards: [BRAN(SQUARE), TWIN], here: LANE });
    let { r, msg } = await bracket(c, '[find] Bran');
    assert.equal(msg.extra[FOUND][0].id, 'guard_a', JSON.stringify(msg.extra[FOUND]));
    assert.deepEqual(matchNotes(msg), [], 'level 1: no note');
    ({ c } = boot({ cards: [BRAN(SQUARE), TWIN], here: GREEN }));
    ({ r, msg } = await bracket(c, '[find] Bran'));
    assert.equal(r.kind, 'bracket_failed');
    assert.equal(r.note, 'Which one? a guard (Village Square), a guard (River Docks)');
    assert.doesNotMatch(r.note, REAL);
    assert.equal(msg.extra[FOUND][0].id, '');
});

test('R7 r3 resolveAt with a negative message index notes on message 0 (noteAt clamped), not on the last message', async () => {
    const { c } = boot({ here: TAVERN });
    say(c, 'Hello.'); reply(c, 'The barkeep nods.');
    const hit = scene.resolveAt(c.chat, -1, 'a guard', [BRAN(SQUARE), TOBIN(GREEN)]);
    assert.equal(hit.person?.id, 'guard_a');
    assert.equal(matchNotes(c.chat[0]).length, 1, JSON.stringify(callNotes(c.chat[0])));
    assert.deepEqual(matchNotes(c.chat.at(-1)), []);
});
