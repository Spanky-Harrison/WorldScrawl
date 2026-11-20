// Group 1, items 1, 1b, 2, 3, 5, 8, 9 and 11b: the facts, appearance and memory prompt rules (captured from the real
// Remember and tracker calls), the Remember memory list (parse, card, Approve, replay), the map broadcasts after Remember
// and tracker person changes, the null-leak fixes under the faithful fake DOM, the until-now wait rules and doc lint.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

class Chan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; Chan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { for (const ch of Chan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
globalThis.BroadcastChannel = Chan; // the map channel opened at init is one of these
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const N = await import('../../extension/names.mjs');
const W = await import('../../extension/waits.mjs');
const C = await import('../../plugin/shared/cards.mjs');
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar, chatElapsed } = CLK;
await loadCalendar();
const calendarLib = CLK.calendarLib;
const { castPanel } = await import('../../plugin/ui/castpanel.mjs');
const { promptEditor } = await import('../../plugin/ui/prompteditor.mjs');
const { NPC_KEY, framesOf, readRememberAnswer } = NPC;
const { MEMORY_CAP } = await import('../../plugin/shared/npc.mjs');
const REMEMBER_KEY = scene.REMEMBER_KEY, WAIT = 'worldscrawl_wait';

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const entry = id => PROMPTS.prompts.find(e => e.id === id);
const MEMORY_RULES = entry('npc.memory_rules').text;
const FACTS_PARA = 'facts are only what is lastingly true of who they are: their role, their ties to people and places, their situation and their habits';
const TRACKER_FACT = 'A fact is something lasting about who they are that this exchange shows for the first time';
const TRACKER_LOOKS = 'Appearance is for lasting changes to the body or clothes';
const MOMENT_GUARD = 'If an active change describes only a passing moment (holding, glancing, gesturing, posture, mood) and not a lasting change to how they look, leave that field exactly as the base.';
const HESK = JSON.parse(fs.readFileSync(path.join(RIVERTON, 'cast', 'hesk.json'), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));

let n = 0;
/** A fresh Riverton chat at `time` in the common room. `answers(prompt, sys)` may answer a model call; everything is recorded. */
function boot({ time = '17:00', tracker = { place: null, people: [], wait: null }, remember = null, rewrite = null, autoKeepWaits = false } = {}) {
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
    const c = SillyTavern.getContext(), id = `g1n${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    const rec = { calls: [], toasts: [] };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { const m = /^\/send (.*)$/s.exec(cmd); if (m) c.chat.push({ is_user: true, mes: m[1], swipe_id: 0, extra: {} }); };
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        rec.calls.push({ prompt, sys });
        if (isTrackerCall(args)) return typeof tracker === 'function' ? tracker(prompt) : JSON.stringify(tracker);
        if (sys.includes(MEMORY_RULES) && /"memory"/.test(sys)) return JSON.stringify(remember ?? { name: 'Maren', personality: { summary: 'A knife-grinder.' }, facts: [], memory: [], invented: [] });
        if (/Looks line/.test(prompt)) return '{"looks":"a big woman with copper braids"}';
        if (rewrite) return JSON.stringify(rewrite);
        return '{}';
    };
    globalThis.toastr = { info: t => rec.toasts.push(t), success: t => rec.toasts.push(t), warning: t => rec.toasts.push(t), error: t => rec.toasts.push(t) };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'Evening in the common room. The landlady pours ale.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, rec };
}
const say = (c, text) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra: {} }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const flushT = ms => new Promise(r => setTimeout(r, ms));
function listen() {
    globalThis.BroadcastChannel = Chan;
    const posts = [], gui = new Chan('worldscrawl');
    gui.addEventListener('message', e => { if (e.data?.type === 'state') posts.push(e.data); });
    return posts;
}
/** Offer a Remember card for `name` on a fresh player line and Approve it (the card's real keep path). */
async function rememberAndApprove(c, name = 'Maren') {
    const at = say(c, `[remember] ${name}`);
    await scene.offerRemember(c.chat[at], name);
    await scene.keepRemember(at);
    return at;
}

// ---------------------------------------------------------------- 1 / 1b: the prompts, captured from the real calls
test('Remember: the system prompt sent to the model has the facts paragraph, the facts and memory slots, the shared memory rules and "never made up"', async () => {
    const { c, rec } = boot();
    await rememberAndApprove(c);
    const sys = rec.calls.find(x => x.sys.includes(MEMORY_RULES) && /"memory"/.test(x.sys))?.sys;
    assert.ok(sys, 'the Remember call was made');
    assert.match(sys, /"facts": \["short lasting facts about who they are"\]/);
    assert.match(sys, /"memory": \["one short line for each memory this person already has from the story so far, at most 8"\]/);
    assert.ok(sys.includes(FACTS_PARA));
    assert.match(sys, /if it is worth keeping, it goes in memory/);
    assert.match(sys, /\(memory is never filled in\)/);
    assert.match(sys, /A memory is never made up: it is not part of filling the gaps, and nothing in memory goes in invented\./);
    assert.ok(sys.includes(MEMORY_RULES), 'the shared npc.memory_rules text');
    assert.doesNotMatch(sys, /short facts the story established|\{\{memory_rules\}\}/);
});
test('tracker: the prompt sent after a reply has the fact paragraph, the appearance paragraph and the same shared memory rules', async () => {
    const { c, rec } = boot();
    say(c, 'I ask the landlady about the river.');
    const at = reply(c, 'She shrugs and keeps pouring.');
    await onReplyForFlags(at);
    const p = rec.calls.find(x => isTrackerCall(x))?.prompt ?? '';
    assert.ok(p.includes(TRACKER_FACT), 'fact paragraph');
    assert.match(p, /Most exchanges add no fact\./);
    assert.ok(p.includes(TRACKER_LOOKS), 'appearance paragraph');
    assert.match(p, /a person holding a list for a moment has not changed how they look/);
    assert.match(p, /report it as a fact with lasts, not as appearance/);
    assert.ok(p.includes(MEMORY_RULES), 'the shared npc.memory_rules text');
    assert.match(p, /Skip any memory already listed above\. Nobody has to ask you to remember\./);
    assert.doesNotMatch(p, /\{\{memory_rules\}\}/);
});
test('appearance rebuild and light-touch system prompts carry the passing-moment guard; entries exist with the right placeholders', () => {
    for (const id of ['npc.appearance_rebuild_system', 'npc.appearance_edit_light_system']) {
        const e = entry(id);
        assert.ok(e.text.includes(`${MOMENT_GUARD} No other keys, no commentary.`), id);
        assert.ok(e.locked, id);
    }
    const mr = entry('npc.memory_rules');
    assert.deepEqual(mr.placeholders, []);
    assert.equal(mr.group, 'npc');
    assert.ok(mr.locked);
    for (const id of ['npc.tracker', 'npc.remember_system']) assert.ok(entry(id).placeholders.some(p => p.name === 'memory_rules'), id);
    assert.ok(PROMPTS.placeholders.memory_rules && PROMPTS.placeholders.role);
    const want = { 'narration.door_stuck': ['door', 'party', 'place', 'why'], 'narration.door_stuck_move': ['door', 'party', 'place', 'why'], 'narration.dig_failed': ['party', 'place'], 'narration.npc_not_found': ['not_found', 'party'], 'narration.npc_identity': ['role', 'shown'] };
    for (const [id, names] of Object.entries(want)) assert.deepEqual(entry(id).placeholders.map(p => p.name).sort(), names, id);
});
test('a moment intent whose rewrite leaves the fields as they are: no card, a skipped "no change" call note', async () => {
    const { c } = boot({
        tracker: () => JSON.stringify({ place: null, people: [{ id: N.handleOf('hesk'), action: 'appearance', intent: 'holding a list', fields: 'body,outfit', scope: 'light', why: 'she holds the list' }], wait: null }),
        rewrite: { body: HESK.appearance.body, outfit: HESK.appearance.outfit },
    });
    say(c, 'I hand the landlady my list.');
    const at = reply(c, 'She holds the list up to the lamp for a moment, then hands it back.');
    await onReplyForFlags(at);
    await flushT(50);
    assert.equal((c.chat[at].extra[NPC_KEY] ?? []).some(s => s.type === 'npc_appearance'), false, 'no card left waiting');
    const skipped = notes(c.chat[at]).filter(x => x.kind === 'npc_appearance' && x.status === 'skipped');
    assert.ok(skipped.some(x => /no change: the result matches/.test(x.reason)), JSON.stringify(notes(c.chat[at])));
});

// ---------------------------------------------------------------- 1b: the memory list
test('readRememberAnswer: memory capped at 8 (the first 8), lines cut to 240, empty and duplicate lines dropped, non-array is []; invented loses memory lines', () => {
    const base = { name: 'Maren', personality: { summary: 'A knife-grinder.' } };
    const twelve = Array.from({ length: 12 }, (_, i) => `memory ${i + 1}`);
    assert.deepEqual(readRememberAnswer({ ...base, memory: twelve }).memory, twelve.slice(0, 8));
    assert.equal(readRememberAnswer({ ...base, memory: ['x'.repeat(400)] }).memory[0].length, 240);
    assert.deepEqual(readRememberAnswer({ ...base, memory: ['', '  ', 'a', 'a', ' b '] }).memory, ['a', 'b']);
    assert.deepEqual(readRememberAnswer({ ...base, memory: 'not a list' }).memory, []);
    assert.deepEqual(readRememberAnswer({ ...base, memory: ['saw the fight'], invented: ['saw the fight', 'grey eyes'] }).invented, ['grey eyes']);
    assert.ok(MEMORY_CAP === 8);
});
test('Approve: 12 memory lines write 8 npc_memory stamps after npc_create on the same message; replay holds 8; Cast pane state lists them', async () => {
    const memory = Array.from({ length: 12 }, (_, i) => `Saw the player do thing ${i + 1}.`);
    const { c } = boot({ remember: { name: 'Maren', personality: { summary: 'A knife-grinder.' }, facts: [], memory, invented: [] } });
    const at = await rememberAndApprove(c);
    const stamps = c.chat[at].extra[NPC_KEY];
    const made = stamps.find(s => s.type === 'npc_create');
    const mems = stamps.filter(s => s.type === 'npc_memory');
    assert.equal(mems.length, 8);
    assert.ok(mems.every(s => s.id === made.id));
    assert.ok(stamps.indexOf(mems[0]) > stamps.indexOf(made));
    const folded = framesOf(c.chat, c.chat.length - 1, scene.castPack().npcs).at(-1).get(made.id);
    assert.ok(folded.memory.length <= MEMORY_CAP && folded.memory.length === 8, JSON.stringify(folded.memory));
    assert.equal(folded.rel?.player?.state, 'named', 'the memory replay does not lower the relation Remember writes');
    const play = scene.mapNpcs(c.chat, await (await import('../../extension/doors.mjs')).currentLocation());
    assert.ok(JSON.stringify(play).includes('Saw the player do thing 1.'));
    // Deleting the message removes them.
    c.chat.splice(at, 1);
    assert.equal(framesOf(c.chat, c.chat.length - 1, scene.castPack().npcs).at(-1).get(made.id), undefined);
});
test('a story with no memorable moment: an empty memory list and no npc_memory stamps', async () => {
    const { c } = boot({ remember: { name: 'Maren', personality: { summary: 'A knife-grinder.' }, facts: [], memory: [], invented: [] } });
    const at = await rememberAndApprove(c);
    assert.equal(c.chat[at].extra[NPC_KEY].filter(s => s.type === 'npc_memory').length, 0);
});
test('the Remember card: Memory is a list field after Facts; the editor value round-trips; Approve edited writes the edited lines (capped at 8)', async () => {
    const i = C.REMEMBER_FIELDS.findIndex(([k]) => k === 'memory');
    assert.deepEqual(C.REMEMBER_FIELDS[i], ['memory', 'Memory', 'list']);
    assert.equal(C.REMEMBER_FIELDS[i - 1][0], 'facts');
    const got = readRememberAnswer({ name: 'Maren', personality: { summary: 'A knife-grinder.' }, memory: ['one', 'two'] });
    assert.equal(C.rememberValues(got).memory, 'one\ntwo');
    const typed = Array.from({ length: 10 }, (_, k) => `edited ${k}`).join('\n');
    const r = scene.rememberWith(got, { memory: typed }, ['memory']);
    assert.deepEqual(r.got.memory, Array.from({ length: 8 }, (_, k) => `edited ${k}`));
    const { c } = boot();
    const at = say(c, '[remember] Maren');
    await scene.offerRemember(c.chat[at], 'Maren');
    await scene.keepRemember(at, { card: r.got });
    assert.deepEqual(c.chat[at].extra[NPC_KEY].filter(s => s.type === 'npc_memory').map(s => s.note), r.got.memory);
});

// ---------------------------------------------------------------- 3: broadcasts
test('Remember Approve posts the map state once with the new person; Discard posts nothing', async () => {
    {
        const { c } = boot();
        const posts = listen();
        await rememberAndApprove(c);
        await flushT(250);
        assert.equal(posts.length, 1);
        assert.ok(JSON.stringify(posts[0].npcs).includes('Maren'));
    }
    {
        const { c } = boot();
        const at = say(c, '[remember] Maren');
        await scene.offerRemember(c.chat[at], 'Maren');
        const posts = listen();
        await scene.discardRemember(at);
        await flushT(250);
        assert.equal(posts.length, 0);
    }
    globalThis.BroadcastChannel = undefined;
});
test('tracker person changes post the map state once (two changes, one post); a no-change answer posts nothing', async () => {
    const h = () => N.handleOf('hesk');
    for (const [people, want] of [[[], 0], [[{ action: 'fact', text: 'keeps a cudgel under the bar' }], 1], [[{ action: 'fact', text: 'keeps a cudgel under the bar' }, { action: 'memory', text: 'The player asked about the river.' }], 1]]) {
        const { c } = boot({ tracker: () => JSON.stringify({ place: null, people: people.map(p => ({ id: h(), ...p })), wait: null }) });
        say(c, 'I ask the landlady about the river.');
        const at = reply(c, 'She taps the cudgel under the bar. "River\'s high," she says.');
        const posts = listen();
        await onReplyForFlags(at);
        await flushT(250);
        assert.equal(posts.length, want, JSON.stringify(people));
        if (want) assert.ok(JSON.stringify(posts[0].npcs).includes('keeps a cudgel under the bar'));
    }
    globalThis.BroadcastChannel = undefined;
});

// ---------------------------------------------------------------- 5: null leaks (the fake DOM writes null as "null" now)
test('fake DOM is faithful: append writes null, undefined and false as text and does not flatten arrays', () => {
    const doc = makeDoc();
    const el = doc.createElement('div');
    el.append(null, undefined, false, 'x');
    assert.equal(el.textContent, 'nullundefinedfalsex');
    const el2 = doc.createElement('div');
    el2.replaceChildren(['a', 'b']);
    assert.equal(el2.textContent, 'a,b');
});
test('Cast pane: the Resolved pane and the Narrator now box show no "null" (nothing pending, and pending)', async () => {
    for (const how of ['set', 'pending']) {
        const doc = makeDoc();
        globalThis.document = doc;
        const play = [{ id: 'hesk', name: 'Hesk', appearanceHow: how, looksHow: 'set', looks: 'copper braids', body: 'tall', outfit: 'black', base: { looks: 'copper braids', body: 'tall', outfit: 'black' } }];
        const panel = castPanel(doc, { load: async () => server.get('/cast').json(), outline: async () => null, play: () => play, placeName: a => a, save: async () => ({}) });
        await panel.refresh();
        panel.selectId('hesk', 'resolved');
        const pane = panel.el.querySelector('.cast-resolved');
        assert.ok(pane, 'resolved pane');
        assert.doesNotMatch(pane.textContent, /null/, how);
        if (how === 'pending') assert.ok(pane.querySelector('.cast-appearretry'), 'the Retry block renders');
        else assert.equal(pane.querySelector('.cast-appearretry'), null);
        const saveas = panel.el.querySelectorAll('.cast-saveas')[0];
        assert.ok(saveas, 'Save as opens the form with the Narrator now box');
        saveas.click();
        const box = panel.el.querySelector('.cf-effective');
        assert.ok(box && /Narrator now/.test(box.textContent), 'Narrator now box');
        assert.doesNotMatch(box.textContent, /null/, `Narrator now (${how})`);
    }
});
test('prompt editor: a non-Default profile header has no "null"; Default shows the read-only note', async () => {
    for (const selected of ['Mine', 'Default']) {
        const doc = makeDoc();
        globalThis.document = doc;
        const st = { default_profile: 'Default', selected, profiles: { Mine: { overrides: {} } }, prompts: PROMPTS.prompts, groups: PROMPTS.groups ?? [], placeholders: PROMPTS.placeholders };
        const root = doc.createElement('div');
        promptEditor(root, { get: async () => st, post: async () => st, changed: () => {} }, { unlocked: () => false });
        await flushT(20);
        const head = root.querySelector('.pe-profiles');
        assert.doesNotMatch(head.textContent, /null/, selected);
        assert.equal(!!head.querySelector('.pe-ro-note'), selected === 'Default');
    }
});

// ---------------------------------------------------------------- 8: waits
test('untilBehind and untilNow: today\'s target, same minute, edges (midnight)', () => {
    // The default start (no start_date): elapsed 0 is 08:00 on day one.
    const at = (h, m = 0, s = 0) => h * 3600 + m * 60 + s - 8 * 3600;
    const start = null;
    assert.equal(calendarLib.untilBehind(at(8), '08:00', start), 0);
    assert.equal(calendarLib.untilBehind(at(8, 4), '08:00', start), 240);
    assert.equal(calendarLib.untilBehind(at(9, 59), '10:00', start), null, 'still ahead');
    assert.equal(calendarLib.untilNow(at(17, 15), '17:15', start), true);
    assert.equal(calendarLib.untilNow(at(17, 15, 40), '17:15', start), true);
    assert.equal(calendarLib.untilNow(at(17, 15), '17:16', start), false);
    assert.equal(calendarLib.untilNow(at(24, 0, 10), '00:00', start), true, 'midnight');
    assert.equal(calendarLib.untilBehind(at(24, 3), '00:00', start), 180, 'just past midnight');
    assert.equal(calendarLib.NEAR_NOW, 300);
    assert.equal(calendarLib.untilSeconds(at(8), '08:00', start), 86400, 'the plain reader still means tomorrow');
});
test('planWait: a narrator until up to 5 minutes behind is no time ("already HH:MM"); the player\'s until-now is an error; a minute ahead waits', async () => {
    const { c } = boot({ time: '17:15' });
    const nar = await W.planWait('until 17:15', false, 'story', { narrator: true });
    assert.equal(nar.seconds, 0);
    assert.equal(nar.passed, true);
    assert.equal(nar.label, 'no time (already 17:15)');
    const nar4 = await W.planWait('until 17:11', false, 'story', { narrator: true });
    assert.equal(nar4.passed, true);
    const nar6 = await W.planWait('until 17:09', false, 'story', { narrator: true });
    assert.ok(!nar6.passed && nar6.seconds > 23 * 3600, '6 minutes behind: about a day (pin)');
    const me = await W.planWait('until 17:15', false, '');
    assert.match(me.error, /it is already 17:15; say how long or a later time/);
    const ahead = await W.planWait('until 17:16', false, '');
    assert.equal(ahead.seconds, 60);
    assert.ok(c.chat.length >= 1);
});
for (const [label, tracker, text] of [
    ['the tracker', { place: null, people: [], wait: { until: '17:15', why: 'they wait' } }, 'They settle in until a quarter past five.'],
    ['a [ws_flag: wait] tag', null, 'They wait. [ws_flag: wait | until 17:15]'],
    ['a [ws_wait] tag', null, 'They wait. [ws_wait: until 17:15]'],
]) {
    test(`narrator until-now from ${label} at 17:15: no card, no stamp, clock unchanged, the call note says "already 17:15"`, async () => {
        const { c } = boot({ time: '17:15', tracker: tracker ?? { place: null, people: [], wait: null }, autoKeepWaits: true });
        say(c, 'We sit.');
        const at = reply(c, text);
        const before = chatElapsed(c.chat);
        await onReplyForFlags(at);
        await flushT(20);
        assert.equal(c.chat[at].extra[WAIT], undefined, 'no wait stamp');
        assert.equal(c.chat[at].extra.worldscrawl_waitcard, undefined, 'no card');
        assert.equal(chatElapsed(c.chat), before);
        assert.ok(notes(c.chat[at]).some(x => /already 17:15/.test(x.reason ?? '')), JSON.stringify(notes(c.chat[at])));
    });
}
test('/ws-wait until now: an error toast, nothing stamped; [sleep] until now is a failure short-circuit', async () => {
    const { c, rec } = boot({ time: '17:15' });
    const len = c.chat.length;
    await ext.waitCommand('until 17:15');
    assert.equal(c.chat.length, len, 'nothing posted');
    assert.ok(rec.toasts.some(t => /already 17:15/.test(t)), rec.toasts.join(' | '));
    const at = say(c, '[sleep] until 17:15');
    let aborted = 0;
    c.saveChat = async () => {};
    await globalThis.worldscrawlInterceptor(c.chat.filter(m => !m.is_system), 0, () => { aborted++; }, 'normal');
    assert.equal(aborted, 1);
    assert.equal(c.chat[at].extra[ext.CMD_KEY]?.failed, true);
    assert.match(c.chat[at].extra[ext.CMD_KEY].error, /already 17:15/);
});
test('8b pin: [wait] until 17:15 with trailing words stamps exactly 17:15 (no model rounding)', async () => {
    const { c, rec } = boot({ time: '14:00' });
    const at = say(c, 'I [wait] until 17:15 and watch the door');
    await globalThis.worldscrawlInterceptor(c.chat.filter(m => !m.is_system), 0, () => {}, 'normal');
    assert.equal(c.chat[at].extra[WAIT]?.seconds, 3 * 3600 + 15 * 60);
    assert.ok(!rec.calls.some(x => /How long is this wait\?/.test(x.prompt)));
});

// ---------------------------------------------------------------- 9 / 11b: docs
test('doc lint: no [found] or /ws-found; lore and tags are not described as the narrator asking; settings labels name the after-reply check', () => {
    const read = f => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    const docs = ['README.md', ...fs.readdirSync(new URL('../../docs/', import.meta.url)).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];
    for (const f of docs) {
        const t = read(f);
        assert.doesNotMatch(t, /\[found\]|\/ws-found/, f);
    }
    assert.doesNotMatch(read('docs/lore.md'), /The narrator asks/);
    assert.doesNotMatch(read('README.md'), /the ws_flag instructions/);
    assert.match(read('docs/STYLE.md'), /\/ws-wait/);
    const settings = read('extension/settings.mjs');
    assert.match(settings, /Let the after-reply check propose map changes/);
    assert.match(settings, /Let the after-reply check propose NPC changes/);
    assert.doesNotMatch(settings, /Let the narrator flag/);
});
