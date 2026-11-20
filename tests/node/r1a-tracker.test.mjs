// 4-R1a: the tracker prompt rewrite, facts permanent-only and the unreadable-answer status, through the real handlers:
// onReplyForFlags -> runTracker -> applyTrackerResult with a fake model routed by isTrackerCall, the real cards
// (renderPatchCards on fakedom, real card clicks), npcChatEdit, and the map state (npcPlayState / stampCard).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const N = await import('../../extension/names.mjs');
const T = await import('../../extension/tracker.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const { messageActivity } = await import('../../extension/activity.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { stampCard, chatStamps, formFromPlay } = await import('../../plugin/ui/castdata.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar } = CLK;
await loadCalendar();
const { NPC_KEY, npcAt, npcPlayState } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const entry = id => PROMPTS.prompts.find(e => e.id === id);
const server = clientDir(path.dirname(RIVERTON));
const FLAG = 'worldscrawl_flag', PATCH = 'worldscrawl_patches', WAIT = 'worldscrawl_wait';
const SKELETON = 'Reply with one JSON object and nothing else: {"place": null or {...}, "people": [...], "wait": null or {...}}. place, people and wait may all be set in one answer. If nothing changed and nobody gained a memory they would keep: {"place": null, "people": [], "wait": null}';

let n = 0;
/** A fresh Riverton chat at `time` in the common room (Hesk is at the bar at 17:00). `tracker` answers the tracker call
 *  (a string is sent as is; an object as JSON; a function gets the prompt). Every model call is recorded with its args. */
function boot({ time = '17:00', tracker = { place: null, people: [], wait: null }, other = null } = {}) {
    exitsCache.clear();
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
    const c = SillyTavern.getContext(), id = `r1a${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { c.chat.push({ is_user: true, mes: cmd.replace(/^\/send /, ''), swipe_id: 0, extra: {} }); };
    const calls = [];
    c.generateRaw = async args => {
        calls.push(args);
        if (isTrackerCall(args)) { const a = typeof tracker === 'function' ? tracker(String(args.prompt ?? '')) : tracker; return typeof a === 'string' ? a : JSON.stringify(a); }
        if (other) return other(args);
        if (/Looks line/.test(String(args?.prompt ?? ''))) return '{"looks":"a big woman with copper braids"}';
        return '{}';
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'Evening in the common room. The landlady pours ale.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, calls, trackerCalls: () => calls.filter(a => isTrackerCall(a)) };
}
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra: { worldscrawl_intent_checked: true, ...extra } }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
const hesk = () => N.handleOf('hesk');
const stamps = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => !type || s.type === type);
const facts = c => npcAt(c.chat, c.chat.length - 1, scene.castPack()?.npcs ?? [], 'hesk')?.facts ?? [];
const env = c => scene.npcEnv(c.chat, { address: TAVERN });
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
const noteEl = (doc, re) => [...doc.querySelectorAll('.worldscrawl_card_fact')].find(e => re.test(e.textContent));
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }

// ---------------------------------------------------------------- the prompt (T1-T8, W1, npc.tracker_time, npc.fact_rules)
test('the prompt sent: the time-of-day line from the reply\'s clock right before Weather, and the JSON skeleton with the empty default last', async () => {
    const { c, trackerCalls } = boot({ time: '08:10' });
    say(c, 'I come down for breakfast.');
    await onReplyForFlags(reply(c, 'Morning light spills across the floor.'));
    const [args] = trackerCalls();
    assert.ok(args, 'the tracker was called');
    const lines = String(args.prompt).split('\n');
    const at = lines.findIndex(l => l.startsWith('Time of day: '));
    assert.equal(lines[at], 'Time of day: morning (08:10). The game keeps the light and the hour; they are never a change to the place.');
    assert.match(lines[at - 1], /^Exits: /);
    assert.match(lines[at + 1], /^Weather \(known; not a reason to rewrite this place\): /);
    assert.equal(lines.at(-1), SKELETON, 'the answer format is the last line, where the model starts writing');
    assert.equal(args.responseLength, 700);
    assert.ok(String(args.systemPrompt).includes('You are the bookkeeper for a text adventure'));
});
test('the time line follows a kept wait: the reply after "[wait] until 10:30" is read at 10:30', async () => {
    const { c, trackerCalls } = boot({ time: '08:10' });
    assert.equal(await ext.waitCommand('until 10:30'), '');
    say(c, 'I stretch.');
    await onReplyForFlags(reply(c, 'The morning wears on.'));
    assert.match(String(trackerCalls()[0]?.prompt), /^Time of day: morning \(10:30\)\. /m);
});
test('the prompt order (T8) and wording: PLACE, PEOPLE, WAIT, each rule before the skeleton; facts and memory from the shared pieces', async () => {
    const { c, trackerCalls } = boot();
    say(c, 'I ask the landlady about the river.');
    await onReplyForFlags(reply(c, 'She shrugs and keeps pouring.'));
    const p = String(trackerCalls()[0].prompt);
    const order = ['\nPlayer: ', '\nNarrator: ', "Report only what this exchange changed. Most exchanges change nothing about the place or people's looks.", '\nPLACE. ', '\nPEOPLE. ', '\nAppearance: ', '\nFact: ', '\nMemory: ', '\nDisposition: ', '\nName: ', '\nFound: ', '"action": "leave"}: they leave the scene.', '"action": "staying"}: they agree to stay', '"action": "follow"}: they come along', '"action": "stay"}: they stay behind', '\nWAIT. ', SKELETON];
    const pos = order.map(s => p.indexOf(s));
    assert.ok(pos.every(i => i >= 0), JSON.stringify(order.filter((s, i) => pos[i] < 0)));
    assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'in this order');
    assert.ok(p.includes(entry('npc.fact_rules').text) && p.includes(entry('npc.memory_rules').text));
    assert.match(p, /Only the people listed above get items \(found is the one exception\)\. If the story changes someone who is not listed \(a stranger, a background figure, the player's own character\), it gets no item; it never goes to a listed person who happens to be nearby\./, 'T2');
    assert.match(p, /fields is exactly one of body or outfit; a change to both is two items\./, 'T3');
    assert.match(p, /scope is "light" when .* and "full" when it remakes them/, 'T6: light or full');
    assert.match(p, /a time of day as HH:MM on a 24-hour clock, to the minute the story gives \("17:15" for a quarter past five in the afternoon; never rounded\), or one of dawn, morning, noon, dusk, evening, night, midnight/, 'W1');
    assert.doesNotMatch(p, /Never set place|Do not set place|heavy|fact with lasts|A fact that will wear off/);
    assert.match(p, /set lasts to a duration such as "2h"/, 'the short form map ops accept');
    assert.doesNotMatch(p, /\b\d+ (?:hours?|minutes?)\b/, 'no long-form duration examples');
    assert.doesNotMatch(p, /\{\{\w+\}\}/, 'every placeholder filled');
    for (const id of ['npc.tracker_time', 'npc.fact_rules']) assert.ok(entry(id)?.locked && entry(id).group === 'npc', `${id}: its own prompt-manager entry`);
    assert.deepEqual(entry('npc.tracker_time').placeholders.map(x => x.name), ['part', 'time']);
});

// ---------------------------------------------------------------- the morning light (T1), with the backstop kept
const MORNING_REPLY = 'Morning light spills across the floor; the embers have burned low and the door stands ajar.';
test('morning light, low embers and a door ajar: no flag, no patch card, the marker reads tracked', async () => {
    for (const place of [{ changed: true, kind: 'change', note: 'morning light and embers burned low, door ajar' }, null]) {
        const { c, calls } = boot({ time: '08:10', tracker: { place, people: [], wait: null } });
        say(c, 'I wake and come downstairs.');
        const id = reply(c, MORNING_REPLY);
        await onReplyForFlags(id);
        const m = c.chat[id];
        assert.equal(m.extra[FLAG], undefined, 'no place flag');
        assert.equal(m.extra[PATCH], undefined, 'no patch card');
        assert.equal(m.extra[T.TRACKED_KEY]?.status, 'tracked');
        assert.equal(T.trackMark(m), 'tracked');
        assert.equal(calls.filter(a => !isTrackerCall(a)).length, 0, 'no map-change call');
        if (place) assert.ok(notes(m).some(x => x.kind === 'tracker place' && x.status === 'skipped' && /only passing scene state/.test(x.reason)), 'the transientOnly backstop still holds');
        else assert.ok(notes(m).some(x => x.kind === 'tracker' && x.status === 'ok' && x.reason === 'nothing changed'));
    }
});

// ---------------------------------------------------------------- T7 status part: an unreadable answer is a failed read
for (const [label, raw] of [['cut off mid-object', '{"place": null, "people": [{"id":'], ['empty', ''], ['prose', 'Nothing much changed in this exchange.']]) {
    test(`an unreadable tracker answer (${label}) is a failed read: call note failed, nothing applied, the marker reads failed`, async () => {
        const { c, trackerCalls } = boot({ tracker: raw });
        say(c, 'I ask the landlady about the river.');
        const id = reply(c, 'She shrugs and keeps pouring.');
        await onReplyForFlags(id);
        const m = c.chat[id];
        assert.equal(trackerCalls().length, 1, 'no retry in 4-R1a');
        const tn = notes(m).filter(x => x.kind === 'tracker');
        assert.ok(tn.some(x => x.status === 'failed' && x.reason === 'the answer was not JSON'), JSON.stringify(tn));
        assert.equal(tn.some(x => x.status === 'ok' && x.reason === 'nothing changed'), false, 'never "nothing changed"');
        assert.deepEqual(stamps(m), []);
        assert.equal(m.extra[FLAG], undefined);
        assert.equal(m.extra[T.TRACKED_KEY]?.status, 'failed');
        assert.equal(T.trackMark(m), 'failed');
    });
}
test('a valid empty answer still ends tracked, and readTrackerAnswer tells unreadable from empty', async () => {
    const { c } = boot({ tracker: '```json\n{"place": null, "people": [], "wait": null}\n```' });
    say(c, 'I nod.');
    const id = reply(c, 'She nods back.');
    await onReplyForFlags(id);
    assert.equal(c.chat[id].extra[T.TRACKED_KEY]?.status, 'tracked');
    assert.equal(T.readTrackerAnswer('{"place": null, "people": [], "wait": null}').unreadable, undefined);
    assert.equal(T.readTrackerAnswer('{"place": null, "people": [{"id":').unreadable, true);
    assert.equal(T.readTrackerAnswer('').unreadable, true);
});

// ---------------------------------------------------------------- T4 / T4c: facts are permanent-only
test('a tracker fact with a duration is dropped: no fact, no appearance in its place, and an Activity note says why', async () => {
    const { c } = boot({ tracker: () => JSON.stringify({ place: null, people: [{ id: hesk(), action: 'fact', text: 'drunk', lasts: '3h' }], wait: null }) });
    say(c, 'I buy the landlady a third ale.');
    const id = reply(c, 'She drains it and sways a little.');
    await onReplyForFlags(id);
    await flush(50);
    const m = c.chat[id];
    assert.deepEqual(stamps(m), [], 'no fact stamp, and no appearance stamp or card made in its place');
    const note = notes(m).find(x => x.kind === 'tracker fact');
    assert.deepEqual({ status: note?.status, reason: note?.reason }, { status: 'skipped', reason: 'a fact has no end: dropped (drunk, 3h)' });
    assert.ok(messageActivity(m, id).some(e => e.kind === 'call' && e.label === 'tracker fact' && /a fact has no end: dropped \(drunk, 3h\)/.test(e.reason)), 'in the Activity log');
    assert.equal(facts(c).includes('drunk'), false);
    assert.equal(m.extra[T.TRACKED_KEY]?.status, 'tracked');
});
test('a tracker fact with no duration is a pending review card; Approve adds it for good, with no "(for …)" anywhere', async () => {
    const { c } = boot({ tracker: () => JSON.stringify({ place: null, people: [{ id: hesk(), action: 'fact', text: 'runs the ferry at night', lasts: '' }], wait: null }) });
    say(c, 'I ask how she gets across the river.');
    const id = reply(c, '"I run the ferry myself, nights," she says.');
    await onReplyForFlags(id);
    const s = stamps(c.chat[id], 'npc_fact')[0];
    assert.ok(s, 'a fact stamp');
    assert.equal(s.pending, true, 'a review card, not applied at once');
    assert.equal('lasts' in s, false);
    assert.equal(facts(c).includes('runs the ferry at night'), false, 'not yet');
    const doc = draw(c);
    const el = noteEl(doc, /runs the ferry at night/);
    assert.equal(el.dataset.state, 'review');
    assert.deepEqual(btns(el), ['Edit', 'Approve', 'Discard']);
    byText(el, 'Approve').click();
    await flush(50);
    assert.equal(s.pending, undefined);
    assert.ok(facts(c).includes('runs the ferry at night'), 'permanent');
    const row = npcPlayState(c.chat, scene.castPack()?.npcs ?? [], env(c)).find(p => p.id === 'hesk').stamps.find(x => x.type === 'npc_fact');
    assert.equal(row.expiry, undefined);
    assert.equal(row.summary, 'Hesk: runs the ferry at night');
    const card = stampCard({ ...row, msg: id }, { who: 'Hesk' });
    assert.doesNotMatch(JSON.stringify(card.desc), /\(for |\(until |\(lasting\)/);
});
test('a narrator fact tag with a duration is dropped through the tag reader, with an Activity note; one with none is a review card', async () => {
    const { c } = boot();
    say(c, 'I buy the landlady a third ale.');
    const id = reply(c, 'She drains it. [ws_npc: fact | hesk | drunk | 3h] [ws_npc: fact | hesk | keeps a cudgel under the bar]');
    await onReplyForFlags(id);
    const m = c.chat[id];
    assert.doesNotMatch(m.mes, /ws_npc/, 'both tags are taken out of the story');
    assert.deepEqual(stamps(m, 'npc_fact').map(s => [s.text, s.pending, 'lasts' in s]), [['keeps a cudgel under the bar', true, false]]);
    const note = notes(m).find(x => x.kind === 'npc_fact tag');
    assert.deepEqual({ status: note?.status, reason: note?.reason }, { status: 'skipped', reason: 'a fact has no end: dropped (drunk, 3h)' });
    assert.equal(stamps(m, 'npc_appearance').length, 0, 'nothing routed into appearance');
});
test('regression: an appearance item with lasts still makes a temporary appearance change (the timed machinery is untouched)', async () => {
    const { c } = boot({ tracker: () => JSON.stringify({ place: null, people: [{ id: hesk(), action: 'appearance', intent: 'hem soaked from the river', fields: 'outfit', lasts: '3h', scope: 'light', why: 'only the hem' }], wait: null }) });
    say(c, 'I watch her wade out to the ferry rope.');
    const id = reply(c, 'She wades back in, her hem soaked from the river.');
    await onReplyForFlags(id);
    await flush(50);
    const o = stamps(c.chat[id], 'npc_appearance')[0];
    assert.ok(o, 'an appearance owner');
    assert.equal(o.lasts, 180);
    assert.equal(o.candidate?.fields ?? o.fields, 'outfit');
});
test('npcChatEdit (the Cast editor "In this chat" save) refuses a fact with a duration and stamps nothing; without one it stamps as before', async () => {
    const { c } = boot();
    const at = c.chat.length - 1;
    const refused = await scene.npcChatEdit({ chatId: c.chatId, msg: at, swipe: 0, id: 'hesk', stamps: [{ type: 'npc_fact', field: 'fact', text: 'drunk', lasts: 180 }, { type: 'npc_memory', note: 'saw the player arrive' }] });
    assert.deepEqual(refused, { ok: false, error: "Facts are permanent; they can't have a duration." });
    assert.deepEqual(stamps(c.chat[at]), [], 'nothing stamped, not even the other row');
    const ok = await scene.npcChatEdit({ chatId: c.chatId, msg: at, swipe: 0, id: 'hesk', stamps: [{ type: 'npc_fact', field: 'fact', text: 'keeps the keys' }] });
    assert.equal(ok.ok, true);
    assert.deepEqual(stamps(c.chat[at], 'npc_fact').map(s => [s.text, 'lasts' in s]), [['keeps the keys', false]]);
    assert.ok(facts(c).includes('keeps the keys'));
});
test('the Cast editor builds fact rows with no duration: chatStamps never carries lasts, and the pane has no duration control', async () => {
    const { c } = boot();
    const play = npcPlayState(c.chat, scene.castPack()?.npcs ?? [], env(c)).find(p => p.id === 'hesk');
    const seed = formFromPlay(play);
    const edited = { ...structuredClone(seed), facts: [...(seed.facts ?? []), 'owes the miller'] };
    const out = chatStamps(seed, edited).stamps;
    assert.deepEqual(out.filter(s => s.type === 'npc_fact').map(s => s.text), ['owes the miller']);
    assert.equal(out.some(s => 'lasts' in s), false);
    for (const f of ['plugin/ui/castpanel.mjs', 'plugin/ui/castdata.mjs']) {
        const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /fieldRow\(\s*'(?:lasts|duration)'|data-field="(?:lasts|duration)"/, f);
    }
});
test('a fact card typed edit never keeps a duration: Approve edited on a pending one and Save on a kept one both strip lasts', async () => {
    const { c } = boot();
    const at = c.chat.length - 1;
    scene.addNpcStamp(c.chat[at], { type: 'npc_fact', id: 'hesk', field: 'fact', text: 'owes a favor', pending: true, lasts: 180 });
    scene.addNpcStamp(c.chat[at], { type: 'npc_fact', id: 'hesk', field: 'fact', text: 'hates rats', lasts: 60 });
    const [pend, kept] = stamps(c.chat[at], 'npc_fact');
    let doc = draw(c);
    byText(noteEl(doc, /owes a favor/), 'Edit').click(); await flush(10);
    let el = noteEl(doc, /owes a favor/);
    const box = el.querySelector('.worldscrawl_note_text'); box.value = 'owes Hesk a big favor'; box.dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click(); await flush(30);
    assert.equal(pend.text, 'owes Hesk a big favor');
    assert.equal(pend.pending, undefined);
    assert.equal('lasts' in pend, false);
    doc = draw(c);
    byText(noteEl(doc, /hates rats/), 'Edit').click(); await flush(10);
    el = noteEl(doc, /hates rats/);
    const box2 = el.querySelector('.worldscrawl_note_text'); box2.value = 'hates rats and mice'; box2.dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click(); await flush(30);
    assert.equal(kept.text, 'hates rats and mice');
    assert.equal('lasts' in kept, false);
    assert.ok(facts(c).includes('hates rats and mice') && facts(c).includes('owes Hesk a big favor'));
});

// ---------------------------------------------------------------- T6: a person "full" scope composes with the rebuild prompt
test('a person item with scope "full" composes with the rebuild prompt (npc.appearance_rebuild)', async () => {
    const sys = [];
    const { c } = boot({
        tracker: () => JSON.stringify({ place: null, people: [{ id: hesk(), action: 'appearance', intent: 'turned into a gnoll', fields: 'body', scope: 'full', why: 'a whole new body' }], wait: null }),
        other: args => { sys.push(String(args?.systemPrompt ?? '')); return /Looks line/.test(String(args?.prompt ?? '')) ? '{"looks":"a grey gnoll"}' : '{"body":"A hulking grey gnoll."}'; },
    });
    say(c, 'I read the curse aloud.');
    const id = reply(c, 'Hesk howls as her body twists into a gnoll\'s.');
    await onReplyForFlags(id);
    await flush(80);
    const o = stamps(c.chat[id], 'npc_appearance')[0];
    assert.equal((o.candidate ?? o.committed)?.scope, 'heavy', '"full" reads as a full rewrite');
    const rebuild = entry('npc.appearance_rebuild_system').text.slice(0, 60);
    assert.ok(sys.some(s => s.startsWith(rebuild)), 'the rebuild system prompt, not the light touch');
    assert.equal(sys.some(s => s.startsWith(entry('npc.appearance_edit_light_system').text.slice(0, 60))), false);
});
