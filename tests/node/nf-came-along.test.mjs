// 4-NF: came_along. On a reply to a move, the tracker sees who was just left behind and may say one of them came along;
// the game holds them where the player is (npc_along, the stay hold; no following state), with a kept card (Turn off,
// Undo). Through the real handlers: the [move] bracket (bracketIntent), onReplyForFlags -> runTracker ->
// applyTrackerResult with a fake model routed by isTrackerCall, renderPatchCards on fakedom with real clicks,
// onStorySwipe, applyFacts and the [ws_npc] tag reader.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const N = await import('../../extension/names.mjs');
const T = await import('../../extension/tracker.mjs');
const D = await import('../../extension/discovery.mjs');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { messageActivity } = await import('../../extension/activity.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { addSettingsPanel } = await import('../../extension/settings.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar } = CLK;
await loadCalendar();
const { onReplyForFlags, onStorySwipe, trackerSettled, TRACKER_WAIT } = D;
const NPCM = await import('../../extension/npc.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const NPC = 'worldscrawl_npc', WARN = 'worldscrawl_npcwarn';
const GOOD = { place: null, people: [], wait: null };
const CUT = '{"place": null, "people": [{"id":';

let n = 0;
/** A fresh Riverton chat at 17:00 in the common room (Hesk, "the landlady", is at the bar). `tracker` answers each
 *  tracker call: a list is used in order (the last one repeats), a function gets the call number. `two`: Corwin is
 *  remembered and following the player. Every tracker call records the marker text drawn at that moment. */
function boot({ tracker = GOOD, retry = undefined, count = undefined, autoKeep = false, two = false, delay = 0, time = '17:00' } = {}) {
    exitsCache.clear();
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
    const c = SillyTavern.getContext(), id = `nf${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { c.chat.push({ is_user: true, mes: cmd.replace(/^\/send /, ''), swipe_id: 0, extra: {} }); };
    const seen = [], marks = [];
    c.generateRaw = async args => {
        if (!isTrackerCall(args)) return /Looks line/.test(String(args?.prompt ?? '')) ? '{"looks":"a big woman with copper braids"}' : '{}';
        const k = seen.length;
        seen.push(args);
        marks.push(globalThis.document?.querySelector?.('.worldscrawl_trackmark')?.textContent ?? null);
        if (delay) await new Promise(r => setTimeout(r, delay));
        const a0 = typeof tracker === 'function' ? tracker(k) : Array.isArray(tracker) ? tracker[Math.min(k, tracker.length - 1)] : tracker;
        const a = typeof a0 === 'function' ? a0() : a0; // a function: built at call time, when the chat's handles are set
        return typeof a === 'string' ? a : JSON.stringify(a);
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    const s = ext.settings();
    delete s.trackerRetry; delete s.trackerRetryCount;
    Object.assign(s, { flagNpcs: true, flagTags: true, autoKeep, autoKeepWaits: true, moveMode: 'buttons' }, retry ? { trackerRetry: retry } : {}, count ? { trackerRetryCount: count } : {});
    const first = { is_user: false, mes: 'Evening in the common room. The landlady pours ale.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } };
    if (two) first.extra[NPC] = [{ type: 'npc_create', id: 'corwin', name: 'Corwin', line: 'a ferryman with a tarred coat' }, { type: 'npc_follow', id: 'corwin' }];
    c.chat = [first];
    return { c, calls: () => seen.length, marks, seen, blocks };
}
const say = (c, text) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra: { worldscrawl_intent_checked: true } }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
const hesk = () => N.handleOf('hesk');
const stamps = (m, type) => (m.extra?.[NPC] ?? []).filter(s => !type || s.type === type);
/** Point the fake DOM at every message, then draw. */
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const markOf = (doc, id) => doc.querySelector(`.mes[mesid="${id}"]`)?.querySelector('.worldscrawl_trackmark') ?? null;
const btns = el => (el?.querySelectorAll('.worldscrawl_card_btn') ?? []).map(b => b.textContent);
async function exchange(c, player, story) { say(c, player); const id = reply(c, story); globalThis.document = makeDoc(c.chat.map((_, i) => i)); await onReplyForFlags(id); await flush(40); return id; }
const _soaked = (extra = {}) => ({ place: null, people: [{ id: hesk(), action: 'appearance', intent: 'cloak soaked through', fields: 'outfit', lasts: '2h', scope: 'light', why: 'only the cloak', ...extra }], wait: null });

const SQ = 'riverton:streets/square', LANE = 'riverton:streets/market_lane';
const along = (id = hesk) => ({ place: null, people: [{ id: typeof id === 'function' ? id() : id, action: 'came_along' }], wait: null });
const STOMPS = 'The landlady stomps out behind you into the square, still arguing about the rent.';
/** The player moves by the real [move] bracket; the reply follows and its tracker runs. */
async function moveTurn(c, dir, story) {
    const p = say(c, `I [move] ${dir}`);
    const r = await bracketIntent(c.chat[p], parseBracket(c.chat[p].mes));
    assert.equal(r.kind, 'move', r.note);
    await scene.prepareNpcs(c.chat[p]);
    const id = reply(c, story);
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    await onReplyForFlags(id); await flush(40);
    return id;
}
const env = c => scene.npcEnv(c.chat, null);
const at = (c, place, i = c.chat.length - 1) => NPCM.whoAt(c.chat, i, scene.castPack().npcs, env(c), place).filter(r => r.here).map(r => r.id);
const presentNow = c => NPCM.presentAt(c.chat, c.chat.length - 1, scene.castPack().npcs, env(c)).map(p => p.id);
const trackerPrompt = (seen, k) => String(seen[k]?.prompt ?? '');
const noteCard = (doc, id) => [...(doc.querySelector(`.mes[mesid="${id}"]`)?.querySelectorAll('.worldscrawl_npcchange') ?? [])].find(e => /came along/.test(e.textContent));
const byText = (el, t) => (el?.querySelectorAll('.worldscrawl_card_btn') ?? []).find(b => b.textContent === t);

test('came along: the landlady walks out behind the player; the tracker says came_along; she is held in the square, with a kept card, and is in People here next turn', async () => {
    const { c, blocks, seen } = boot({ tracker: () => along() });
    assert.ok(presentNow(c).includes('hesk'), 'precondition: she is in the common room at 17:00');
    const id = await moveTurn(c, 'out', STOMPS);
    const [s] = stamps(c.chat[id], 'npc_along');
    assert.ok(s, JSON.stringify(c.chat[id].extra[NPC]));
    assert.deepEqual([s.id, s.place, s.from, s.where, s.source], ['hesk', SQ, TAVERN, 'Village Square', 'tracker']);
    assert.equal(c.chat[id].extra.worldscrawl_tracked?.status, 'carded');
    assert.equal(seen.length, 1, 'one tracker call');
    const card = noteCard(draw(c), id);
    assert.ok(card, 'a kept person card');
    assert.match(card.textContent, /Character changed here: Hesk came along to Village Square/);
    assert.deepEqual(btns(card), ['Turn off', 'Undo']);
    say(c, 'I look around the square.');
    await scene.applyFacts();
    assert.match(blocks[ext.FACTS_KEY], /^the landlady \[\w+\]: .*Now: with the player\./m, blocks[ext.FACTS_KEY]);
    assert.ok(at(c, SQ).includes('hesk') && !at(c, TAVERN).includes('hesk'));
});

test('the prompt: on the move turn the tracker sees "Just left behind in Common Room" with her handle, after People here; on a stay turn there is no such section', async () => {
    const { c, seen } = boot();
    await moveTurn(c, 'out', 'You step out into the square.');
    const p = trackerPrompt(seen, 0);
    const i = p.indexOf('People here:'), j = p.indexOf('Just left behind in Common Room (with the player there before this move; not here unless this reply shows them here with the player now):\n');
    assert.ok(i >= 0 && j > i, p);
    assert.match(p.slice(j), new RegExp(`^the landlady \\[${hesk()}\\] \\(name not yet known\\)\\. Looks: `, 'm'));
    assert.doesNotMatch(p, /Hesk/, 'masked with the scrap');
    await exchange(c, 'I look at the well.', 'Water glints far below.');
    assert.doesNotMatch(trackerPrompt(seen, 1), /Just left behind in /);
});

test('no move: she waves from the doorway; the tracker reports nobody; she stays in the common room', async () => {
    const { c } = boot();
    const id = await moveTurn(c, 'out', 'The landlady waves from the doorway as you go.');
    assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
    say(c, 'I cross the square.');
    assert.ok(!presentNow(c).includes('hesk'));
    assert.ok(at(c, TAVERN).includes('hesk'));
});

test('guards: came_along for someone never in the last scene is dropped; for someone already here, skipped; for a candidate the reply never names, dropped', async () => {
    {
        const { c } = boot({ tracker: () => ({ place: null, people: [{ id: 'mara', action: 'came_along' }], wait: null }) });
        c.chat[0].extra[NPC] = [{ type: 'npc_create', id: 'mara', name: 'Mara', line: 'a fishwife' }];
        const id = await moveTurn(c, 'out', 'Mara comes along behind you.');
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
        assert.ok(notes(c.chat[id]).some(x => x.kind === 'came_along' && x.status === 'skipped' && x.reason === 'came_along dropped: Mara was not with the player before the move'), JSON.stringify(notes(c.chat[id])));
    }
    {
        const { c } = boot({ two: true, tracker: () => along(N.handleOf('corwin')) });
        const id = await moveTurn(c, 'out', 'Corwin walks out with you.');
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
        assert.ok(notes(c.chat[id]).some(x => x.kind === 'came_along' && x.reason === 'came_along skipped: Corwin is already here'), JSON.stringify(notes(c.chat[id])));
    }
    {
        const { c } = boot({ tracker: () => along() });
        const id = await moveTurn(c, 'out', 'Someone stomps out behind you into the square.');
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
        assert.ok(notes(c.chat[id]).some(x => x.kind === 'came_along' && x.reason === 'came_along dropped: the reply never shows the landlady'), JSON.stringify(notes(c.chat[id])));
        say(c, 'I look around.');
        assert.ok(!presentNow(c).includes('hesk'));
    }
});

test('guards: an appearance item for someone left behind is dropped (not here); a memory item for them is kept', async () => {
    const { c } = boot({ tracker: () => ({ place: null, people: [
        { id: hesk(), action: 'appearance', intent: 'apron soaked with ale', fields: 'outfit', lasts: '2h', scope: 'light', why: 'spilled' },
        { id: hesk(), action: 'memory', text: 'The player left without paying' }], wait: null }) });
    const id = await moveTurn(c, 'out', 'The landlady shouts after you that you still owe for the ale.');
    assert.deepEqual(stamps(c.chat[id], 'npc_appearance'), []);
    assert.ok(notes(c.chat[id]).some(x => x.reason === 'tracker appearance dropped: the landlady is not here'), JSON.stringify(notes(c.chat[id])));
    assert.equal(stamps(c.chat[id], 'npc_memory').length, 1);
});

test('not a following state: on the next move the reply does not show her, so she stays in the square; she is not a candidate after that; a schedule change ends the hold', async () => {
    const { c, seen } = boot({ tracker: k => (k === 0 ? along() : GOOD) });
    await moveTurn(c, 'out', STOMPS);
    await moveTurn(c, 'west', 'You walk into Market Lane alone.');
    assert.match(trackerPrompt(seen, 1), /Just left behind in Village Square/, 'she was a candidate for that move');
    say(c, 'I browse the shops.');
    assert.ok(!presentNow(c).includes('hesk'), 'not in Market Lane');
    assert.ok(at(c, SQ).includes('hesk'), 'held in the square');
    const id = await moveTurn(c, 'east', 'Back in the square.'); // the player comes back: the hold ends (rejoined), as decided in the plan (risk 4-NF)
    assert.doesNotMatch(trackerPrompt(seen, 2), /Just left behind in Market Lane/, 'nobody was left behind in Market Lane');
    say(c, 'I look around.');
    // Pinned (plan risk 4-NF): coming back ends the hold (rejoined), so her schedule is in force again; like a stay, she
    // is found where she was left, as someone due elsewhere (the existing overdue note), not with the player.
    const why = NPCM.npcWhy(NPCM.framesOf(c.chat, c.chat.length - 1, scene.castPack().npcs, env(c).clock).at(-1).get('hesk'), c.chat.length - 1, env(c));
    assert.deepEqual([why.held?.active, why.kind, why.place], [false, 'schedule', TAVERN]);
    const row = NPCM.presentAt(c.chat, c.chat.length - 1, scene.castPack().npcs, env(c)).find(p => p.id === 'hesk');
    assert.match(row?.overdue ?? '', /^The landlady is .* late for pouring drinks\.$/);
    assert.ok(id > 0);
});
test('a schedule change ends the came_along hold (she goes to bed at 02:00)', async () => {
    const { c } = boot({ time: '01:30', tracker: k => (k === 0 ? along() : GOOD) });
    await moveTurn(c, 'out', STOMPS);
    say(c, 'I look around.');
    assert.ok(presentNow(c).includes('hesk'), 'held at 01:31');
    c.chat.pop();
    assert.equal(await ext.waitCommand('1h'), '');
    assert.ok(!at(c, SQ).includes('hesk'), 'at 02:31 her entry changed: back on her schedule');
});

test('no move, but someone leaves the scene (a tracker leave on a stay turn): nobody is "Just left behind" and came_along is dropped', async () => {
    const { c, seen } = boot({ tracker: () => ({ place: null, people: [{ id: hesk(), action: 'leave' }, { id: hesk(), action: 'came_along' }], wait: null }) });
    const id = await exchange(c, 'I finish my ale.', 'The landlady unties her apron and heads out for the night.');
    assert.equal(stamps(c.chat[id], 'npc_leave').length, 1, 'the tracker leave stamps (5C B7: no reply tag)');
    assert.ok(!presentNow(c).includes('hesk'), 'she left this turn');
    assert.equal(seen.length, 1);
    assert.doesNotMatch(trackerPrompt(seen, 0), /Just left behind in /);
    assert.equal(stamps(c.chat[id], 'npc_along').length, 0);
});

test('swipe, Undo and Turn off', async () => {
    {
        const { c } = boot({ tracker: k => (k === 0 ? along() : GOOD) });
        const id = await moveTurn(c, 'out', STOMPS);
        assert.equal(stamps(c.chat[id], 'npc_along').length, 1);
        const m = c.chat[id];
        m.swipes.push('You step out alone; the landlady stays behind the bar.'); m.swipe_id = 1; m.mes = m.swipes[1]; m.swipe_info.push({ extra: {} });
        await onStorySwipe(id); await flush(40);
        assert.deepEqual(stamps(m, 'npc_along'), [], 'the swipe dropped it; the new swipe\'s answer (nothing) applies');
    }
    {
        const { c } = boot({ tracker: () => along() });
        const id = await moveTurn(c, 'out', STOMPS);
        let doc = draw(c);
        const u = byText(noteCard(doc, id), 'Undo');
        u.click(); u.click(); await flush(60); // a double click is one Undo
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
        say(c, 'I look around.');
        assert.ok(!presentNow(c).includes('hesk'), 'Undo: not here on the next turn');
    }
    {
        const { c } = boot({ tracker: () => along() });
        const id = await moveTurn(c, 'out', STOMPS);
        byText(noteCard(draw(c), id), 'Turn off').click(); await flush(60);
        const [s] = (c.chat[id].extra[NPC] ?? []).filter(x => x.type === 'npc_along');
        assert.equal(s?.off, true, 'kept, turned off');
        say(c, 'I look around.');
        assert.ok(!presentNow(c).includes('hesk'), 'off: she is not moved');
        const card = noteCard(draw(c), id);
        assert.match(card.textContent, /Character change turned off: Hesk came along to Village Square/);
    }
});

test('follow is gone from the tracker: a tracker follow item is dropped with a note; reply [ws_npc: follow] and [ws_npc: came_along] tags are removed and ignored (5C B7)', async () => {
    {
        const { c } = boot({ two: true, tracker: () => ({ place: null, people: [{ id: hesk(), action: 'follow' }], wait: null }) });
        const id = await exchange(c, 'I wave the landlady over.', 'The landlady says she will come with you.');
        assert.deepEqual(stamps(c.chat[id], 'npc_follow'), []);
        assert.ok(notes(c.chat[id]).some(x => x.kind === 'tracker follow' && x.status === 'skipped'), JSON.stringify(notes(c.chat[id])));
        const t = await exchange(c, 'Let us go.', 'The landlady unties her apron. [ws_npc: follow | hesk]');
        assert.deepEqual(stamps(c.chat[t], 'npc_follow'), [], '5C B7: the reply tag never stamps');
        assert.doesNotMatch(c.chat[t].mes, /ws_npc/, 'removed from the reply');
    }
    {
        const { c } = boot();
        const id = await moveTurn(c, 'out', 'The landlady follows you out, still talking. [ws_npc: came_along | hesk]');
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), [], '5C B7: the reply tag never holds her');
        assert.doesNotMatch(c.chat[id].mes, /ws_npc/);
        assert.ok(!at(c, SQ).includes('hesk'), 'not held in the square: the tracker did not say so');
    }
    {
        const { c } = boot();
        const id = await exchange(c, 'I sit down.', 'The landlady sits with you. [ws_npc: came_along | hesk]');
        assert.deepEqual(stamps(c.chat[id], 'npc_along'), []);
        assert.ok(!notes(c.chat[id]).some(x => x.kind === 'came_along'), '5C B7: ignored silently, no note');
    }
});

test('alongCheck (pure): candidates by handle or id; named by name, alias or unknownAs; other items', () => {
    const cand = [{ id: 'p1', npcId: 'hesk', name: 'the landlady', label: 'the landlady', unknownAs: 'the landlady', nameKnown: false, fromAddress: TAVERN }];
    const here = [{ id: 'p2', npcId: 'bryn', name: 'Bryn', label: 'Bryn' }];
    const chk = (item, reply = 'The landlady comes too.') => T.alongCheck(item, cand, here, reply).verdict;
    assert.equal(chk({ action: 'came_along', id: 'p1' }), 'keep');
    assert.equal(chk({ action: 'came_along', id: 'hesk' }), 'keep');
    assert.equal(chk({ action: 'came_along', id: 'p1' }, 'Landlady trots after you.'), 'keep', 'unknownAs without its article');
    assert.equal(chk({ action: 'came_along', id: 'p1' }, 'She comes too.'), 'drop', 'no pronoun guessing');
    assert.equal(chk({ action: 'came_along', id: 'p2' }), 'skip');
    assert.equal(chk({ action: 'came_along', id: 'zed' }), 'drop');
    assert.equal(chk({ action: 'fact', id: 'p1', text: 'owns the inn' }), 'drop');
    for (const a of ['memory', 'disposition', 'name']) assert.equal(chk({ action: a, id: 'p1' }), 'keep', a);
    assert.equal(chk({ action: 'appearance', id: 'p2' }), 'keep', 'someone here: not this guard');
});

test('fx: the after-reply tracker redraws the reply\'s exits footer: after a came_along turn it lists her as present, with no other trigger', async () => {
    const { c } = boot({ tracker: k => (k === 0 ? along() : GOOD) });
    ext.settings().showExits = true;
    const footerOf = id => globalThis.document.querySelector(`#chat .mes[mesid="${id}"]`)?.querySelector('.worldscrawl_npcs_here')?.textContent ?? '';
    const p = say(c, 'I [move] out');
    const r = await bracketIntent(c.chat[p], parseBracket(c.chat[p].mes));
    assert.equal(r.kind, 'move', r.note);
    await scene.prepareNpcs(c.chat[p]);
    const id = reply(c, STOMPS);
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    assert.equal(footerOf(id), '', 'no footer drawn before the tracker');
    await onReplyForFlags(id); await flush(80);
    assert.equal(stamps(c.chat[id], 'npc_along').length, 1);
    assert.equal(footerOf(id), 'Named NPCs present: the landlady');
});

// ---- 5C B1: someone who came along and whose hour has ended reads as with the player, not late or elsewhere.
const CELLAR = 'riverton:drowned_rat/cellar';
const heskRow = c => NPCM.presentAt(c.chat, c.chat.length - 1, scene.castPack().npcs, env(c)).find(p => p.id === 'hesk');
async function alongFromCellar(time = '15:30') {
    const b = boot({ time, tracker: k => (k === 0 ? along() : GOOD) });
    b.c.chat[0].extra.worldscrawl_location = CELLAR;
    b.c.chat[0].mes = 'The cellar. The landlady is checking the casks.';
    const id = await moveTurn(b.c, 'trapdoor', 'The landlady climbs up through the trapdoor after you, still counting casks.');
    assert.equal(stamps(b.c.chat[id], 'npc_along').length, 1, JSON.stringify(notes(b.c.chat[id])));
    return b;
}

test('5C B1: came along at 15:30, past her 16:00 entry: the people block says she came along and has stayed, where she would usually be; no "late"', async () => {
    const { c, blocks } = await alongFromCellar();
    say(c, 'I look around the yard.');
    let row = heskRow(c);
    assert.equal(row?.alongDue ?? null, null, 'before 16:00 the hold is active: no line');
    assert.equal(row?.activity, 'with the player');
    c.chat.pop();
    assert.equal(await ext.waitCommand('1h40m'), '');
    say(c, 'I look around the yard.');
    row = heskRow(c);
    assert.ok(row, 'still in the scene');
    assert.deepEqual(row.alongDue, { where: 'Common Room', activity: 'pouring drinks' });
    assert.equal(row.overdue, '');
    assert.equal(row.activity, 'with the player');
    await scene.applyFacts();
    const block = blocks[ext.FACTS_KEY];
    assert.match(block, /Now: with the player\. The landlady came along with .+ and has stayed; at this hour they would usually be at Common Room \(pouring drinks\)\./, block);
    assert.doesNotMatch(block, /is (an|\d+) hours? late for|should be at /);
});

test('5C B1: came along at 01:30, past her 02:00 offmap entry: the along line names her own room, not the absent-elsewhere line', async () => {
    const { c, blocks } = boot({ time: '01:30', tracker: k => (k === 0 ? along() : GOOD) });
    await moveTurn(c, 'out', STOMPS);
    assert.equal(await ext.waitCommand('50m'), '');
    say(c, 'I look around.');
    const row = heskRow(c);
    assert.deepEqual(row?.alongDue, { where: 'her own room', activity: 'asleep' });
    await scene.applyFacts();
    assert.match(blocks[ext.FACTS_KEY], /would usually be at her own room \(asleep\)\./);
    assert.doesNotMatch(blocks[ext.FACTS_KEY], /elsewhere/);
});

test('5C B1: a plain stay hold (not came along) keeps the "late" wording', async () => {
    const { c } = boot({ time: '15:30' });
    c.chat[0].extra.worldscrawl_location = CELLAR;
    c.chat[0].mes = 'The cellar. The landlady is checking the casks.';
    say(c, 'I wait.');
    const r = reply(c, 'The landlady says she will stay down here with you.');
    c.chat[r].extra[NPC] = [{ type: 'npc_stay', id: 'hesk', place: CELLAR }];
    assert.equal(await ext.waitCommand('1h40m'), '');
    say(c, 'I look around.');
    const row = heskRow(c);
    assert.equal(row?.alongDue ?? null, null);
    assert.match(row?.overdue ?? '', /^The landlady is an hour late for pouring drinks\.$/);
});

// Ast 5C round 1: a might entry (one of several places) takes the along branch too.
const heskSchedule = might => [
    { place: CELLAR, activity: 'checking the casks', from: '15:00', to: '16:00' },
    { might, activity: 'seeing to the inn', from: '16:00', to: '02:00' },
    { activity: 'asleep', where: 'her own room', near: 'riverton:drowned_rat', from: '02:00', to: '15:00' },
];
async function alongIntoMight(might) {
    const b = boot({ time: '15:30', tracker: k => (k === 0 ? along() : GOOD) });
    b.c.chat[0].extra[NPC] = [{ type: 'npc_schedule', id: 'hesk', schedule: heskSchedule(might) }];
    b.c.chat[0].extra.worldscrawl_location = CELLAR;
    b.c.chat[0].mes = 'The cellar. The landlady is checking the casks.';
    const id = await moveTurn(b.c, 'trapdoor', 'The landlady climbs up through the trapdoor after you, still counting casks.');
    assert.equal(stamps(b.c.chat[id], 'npc_along').length, 1, JSON.stringify(notes(b.c.chat[id])));
    assert.equal(await ext.waitCommand('1h40m'), '');
    say(b.c, 'I look around the yard.');
    return b;
}
const NOT_HERE = /is (an|\d+) hours? late for|should be at |would normally have moved on|elsewhere/;
test('5C B1 (Ast r1): came along, next entry a might entry: the first option that resolves is named; still with the player, no "late" or moved-on line', async () => {
    const { c, blocks } = await alongIntoMight(['riverton:no_such_place', 'riverton:drowned_rat/common_room', 'riverton:streets/square']);
    const row = heskRow(c);
    assert.ok(row, 'still in the scene');
    assert.equal(row.activity, 'with the player');
    assert.equal(row.overdue, '');
    assert.deepEqual(row.alongDue, { where: 'Common Room', activity: 'seeing to the inn' });
    await scene.applyFacts();
    const block = blocks[ext.FACTS_KEY];
    assert.match(block, /Now: with the player\. The landlady came along with .+ and has stayed; at this hour they would usually be at Common Room \(seeing to the inn\)\./, block);
    assert.doesNotMatch(block, NOT_HERE);
});
test('5C B1 (Ast r1): came along, next entry a might entry where no option resolves: still with the player, and the along line is left out', async () => {
    const { c, blocks } = await alongIntoMight(['riverton:no_such_place', 'nowhere(50)']);
    const row = heskRow(c);
    assert.ok(row, 'still in the scene');
    assert.equal(row.activity, 'with the player');
    assert.equal(row.overdue, '');
    assert.equal(row.alongDue, null);
    await scene.applyFacts();
    const block = blocks[ext.FACTS_KEY];
    assert.match(block, /Now: with the player\./, block);
    assert.doesNotMatch(block, /came along with/);
    assert.doesNotMatch(block, NOT_HERE);
});
