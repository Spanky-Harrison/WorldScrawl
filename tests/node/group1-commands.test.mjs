// Group 1, items 6 and 7 (and 9's /ws-find): commands and outright failures short-circuit (stamped, hidden with ST's own
// /hide, a notice row, no reply); narrated attempts and the not-found line go after the player's message. Through the
// real handlers: the generation interceptor with a fake abort, bracketIntent, the Remember card and its Approve, the
// real world server behind the fetch shim, applyFacts (FACTS_KEY / REMINDER_KEY capture), a /hide stand-in with ST's
// semantics (is_system plus the element attribute, then a save), the map channel and the slash commands.
//
// Macro note (documented, not asserted): {{lastUserMessage}} and {{lastCharMessage}} skip is_system rows, but
// {{lastMessage}} has no filter in ST (macros.js:388), so it can still return a hidden command's text.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

class Chan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; Chan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { for (const ch of Chan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
// The map channel opened at init is one of these, so a test can listen to the map broadcasts.
globalThis.BroadcastChannel = Chan;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
// Capture the slash commands registered at import (init runs registerSlashCommands once).
const cmds = {};
{
    const base = SillyTavern.getContext();
    base.SlashCommandParser = { addCommandObject: o => { cmds[o.name] = o; } };
    base.SlashCommand = { fromProps: p => p };
    base.SlashCommandArgument = { fromProps: p => p };
    base.SlashCommandNamedArgument = { fromProps: p => p };
    base.ARGUMENT_TYPE = { STRING: 'string', NUMBER: 'number' };
}
const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const MV = await import('../../extension/movement.mjs');
const GEN = await import('../../extension/generations.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar, chatElapsed } = await import('../../extension/clock.mjs');
await loadCalendar();
const { NPC_KEY, FOUND_KEY, framesOf } = NPC;
const { CMD_KEY, CMD_REDO_TOAST, FACTS_KEY, REMINDER_KEY, MOVE_KEY, helpText, VERBS, parseBracket } = ext;
const REMEMBER_KEY = scene.REMEMBER_KEY;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, SQ = 'riverton:streets/square';
const card = (id, name, schedule, more = {}) => ({ id, name, personality: { summary: `${name}, a local.` }, disposition: { player: { value: 'indifferent' } }, schedule, ...more });
const CARDS = [
    card('bryn', 'Bryn', [{ might: [BAR], activity: 'waiting for the tide', from: '09:00', to: '12:00' }]),
    card('nell', 'Nell', [{ might: [`${BAR}(1)`], activity: 'drinking', from: '09:00', to: '12:00' }]),
    card('vera', 'Vera', [{ might: [`${SQ}(99)`, `${BAR}(1)`], activity: 'selling eggs', from: '09:00', to: '12:00' }, { place: 'riverton:general_store/shop', activity: 'minding the store', from: '12:00', to: '18:00' }]),
];

let world = null;
function worldOnce() {
    if (world) return world;
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    // The common room's back door is locked here (a stuck door to try).
    const reg = path.join(d, 'riverton', 'regions', 'riverton.json');
    const txt = fs.readFileSync(reg, 'utf8').replace('"description": "A back door to the courtyard.", "barrier": {}', '"description": "A back door to the courtyard.", "barrier": { "locked": true }');
    assert.ok(txt.includes('"locked": true'), 'fixture: the back door is locked');
    fs.writeFileSync(reg, txt);
    for (const c of CARDS) write(path.join(d, 'riverton', 'cast', `${c.id}.json`), JSON.stringify(c, null, 2));
    world = { server: clientDir(d) };
    return world;
}

const REMEMBER_ANSWER = { name: 'Maren', personality: { summary: 'A knife-grinder.', manner: 'Watches hands.', speech: 'Quick.' }, appearance: { summary: 'wiry woman', body: 'Wiry.', outfit: 'A smock.' }, history: '', facts: ['sharpens knives in the square'], memory: ['The player paid her without haggling.'], invented: [] };
let n = 0;
/** A fresh chat at `time` in `here`. Every model call, save, toast, /hide and notice is recorded. */
function boot({ time = '10:00', here = BAR, mode = 'buttons', hide = 'slash', doc = null, intent = '' } = {}) {
    exitsCache.clear();
    const { server } = worldOnce();
    globalThis.BroadcastChannel = undefined;
    globalThis.document = doc ?? { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext(), id = `g1c${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    const rec = { calls: [], saves: [], toasts: [], slash: [], blocks: {}, aborts: 0 };
    c.saveChat = async () => { rec.saves.push(JSON.parse(JSON.stringify(c.chat))); };
    c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = (key, text) => { rec.blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        rec.calls.push({ prompt, sys });
        if (intent && /The player wrote: "/.test(prompt)) return intent; // the typed-move intent question
        if (/Reply with JSON only:\n\{"place"/.test(prompt)) return '{"place": null, "people": [], "wait": null}';
        if (sys.includes(PROMPTS.prompts.find(e => e.id === 'npc.memory_rules').text) && /"memory"/.test(sys)) return JSON.stringify(REMEMBER_ANSWER);
        return '{}';
    };
    // ST's /hide and /unhide (chats.js hideChatMessageRange): the flag, the element attribute, then the chat is saved.
    c.executeSlashCommandsWithOptions = async cmd => {
        rec.slash.push(cmd);
        const m = /^\/(un)?hide (\d+)$/.exec(cmd);
        if (!m) return;
        if (hide === 'throw') throw new Error('no /hide here');
        if (hide === 'noop') return;
        const at = Number(m[2]);
        c.chat[at].is_system = !m[1];
        globalThis.document?.querySelector?.(`#chat .mes[mesid="${at}"]`)?.setAttribute('is_system', String(!m[1]));
        await c.saveChat();
    };
    globalThis.toastr = { info: t => rec.toasts.push(t), success: t => rec.toasts.push(t), warning: t => rec.toasts.push(t), error: t => rec.toasts.push(t) };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: mode });
    c.chat = [{ is_user: false, mes: 'A quiet morning in the common room.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }];
    return { c, rec };
}
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
/** The interceptor as ST calls it: coreChat is the chat without is_system rows (script.js:4496), copied. */
async function intercept(c, rec, type = 'normal') {
    let aborted = 0;
    const core = c.chat.filter(m => !m.is_system).map(m => ({ ...m }));
    await globalThis.worldscrawlInterceptor(core, 0, () => { aborted++; }, type);
    rec.aborts += aborted;
    return { aborted, core };
}
const noticesAfter = (c, at) => c.chat.slice(at + 1).filter(m => m.extra?.worldscrawl_notice);
const reload = c => { c.chat = JSON.parse(JSON.stringify(c.chat)); };
const flushT = ms => new Promise(r => setTimeout(r, ms));
function listen() {
    globalThis.BroadcastChannel = Chan;
    const posts = [], gui = new Chan('worldscrawl');
    gui.addEventListener('message', e => { if (e.data?.type === 'state') posts.push(e.data); });
    return posts;
}
const npcsIn = post => JSON.stringify(post?.npcs ?? post);

// ---------------------------------------------------------------- [help]: a pure command
for (const text of ['[help]', 'I [help] please', '[help] move']) {
    test(`"${text}": aborted, hidden with /hide, flagged help (no failure), one notice with the full verb list`, async () => {
        const { c, rec } = boot();
        const at = say(c, text);
        const { aborted } = await intercept(c, rec);
        assert.equal(aborted, 1);
        assert.equal(rec.calls.length, 0, 'no model call');
        const m = c.chat[at];
        assert.deepEqual(m.extra[CMD_KEY], { verb: 'help' }, 'no failed, no error');
        assert.equal(m.is_system, true);
        assert.deepEqual(rec.slash, [`/hide ${at}`]);
        const notes = noticesAfter(c, at);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mes, helpText());
        assert.match(notes[0].mes, /\[find\] \(\/ws-find <name>\)/);
        reload(c);
        assert.deepEqual(c.chat[at].extra[CMD_KEY], { verb: 'help' }, 'the flag survives a reload');
        for (const type of ['regenerate', 'continue', 'swipe']) {
            const r = await intercept(c, rec, type);
            assert.equal(r.aborted, 1, `${type} refused while hidden`);
        }
        assert.equal(rec.toasts.filter(t => t.includes(CMD_REDO_TOAST)).length, 3);
    });
}

// ---------------------------------------------------------------- [remember]
for (const text of ['[remember] Maren', "I'm going to [remember] Maren, then leave", '[move] north [remember] Maren']) {
    test(`"${text}": short-circuits; flagged remember and hidden; the Remember card on it; no notice row, no move`, async () => {
        const { c, rec } = boot();
        const at = say(c, text);
        const len = c.chat.length;
        const { aborted } = await intercept(c, rec);
        assert.equal(aborted, 1);
        assert.equal(rec.calls.length, 0, 'no narrator or model call');
        const m = c.chat[at];
        assert.deepEqual(m.extra[CMD_KEY], { verb: 'remember' });
        assert.equal(m.is_system, true);
        assert.equal(m.extra[REMEMBER_KEY]?.name, 'Maren');
        assert.equal(c.chat.length, len, 'no notice row and no extra line');
        assert.equal(m.extra[MOVE_KEY], undefined, 'no move stamp');
    });
}
test('bare [remember] with nobody flagged and [remember] of someone already saved: a failure short-circuit with the reason, no card', async () => {
    for (const [text, why] of [['[remember]', /Say who to remember/], ['[remember] Bryn', /Bryn is already remembered/]]) {
        const { c, rec } = boot();
        const at = say(c, text);
        assert.equal((await intercept(c, rec)).aborted, 1, text);
        const m = c.chat[at];
        assert.equal(m.extra[CMD_KEY].verb, 'remember');
        assert.equal(m.extra[CMD_KEY].failed, true);
        assert.match(m.extra[CMD_KEY].error, why);
        assert.equal(m.is_system, true);
        const notes = noticesAfter(c, at);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mes, m.extra[CMD_KEY].error);
        assert.equal(m.extra[REMEMBER_KEY], undefined, 'no card');
    }
});

// ---------------------------------------------------------------- [find]
for (const text of ['[find] Bryn', '[find] Bryn.', '[find] Bryn and ask about the ledger', 'Looking around, [find] Bryn']) {
    test(`"${text}" when Bryn is right here: short-circuits, flagged find, hidden, the right-here decision, no notice row`, async () => {
        const { c, rec } = boot({ time: '10:00' });
        const at = say(c, text);
        const len = c.chat.length;
        assert.equal((await intercept(c, rec)).aborted, 1);
        assert.equal(rec.calls.length, 0);
        const m = c.chat[at];
        assert.deepEqual(m.extra[CMD_KEY], { verb: 'find' });
        assert.equal(m.is_system, true);
        const d = m.extra[FOUND_KEY].find(x => x.id === 'bryn');
        assert.equal(d.here, true);
        assert.equal(d.reason, 'Bryn is right here.');
        assert.equal(c.chat.length, len, 'no notice row');
    });
}
for (const text of ['[move] north [find] Bryn', '[move] out [find] Bryn', '[open] back then [move] out']) {
    test(`"${text}": two action verbs are an outright failure ("One verb per message for now."), nothing is done`, async () => {
        const { c, rec } = boot({ time: '10:00' });
        const at = say(c, text);
        const before = chatElapsed(c.chat);
        assert.equal((await intercept(c, rec)).aborted, 1);
        assert.equal(rec.calls.length, 0, 'no model call');
        const m = c.chat[at];
        assert.equal(m.extra[CMD_KEY].failed, true);
        assert.equal(m.extra[CMD_KEY].error, 'One verb per message for now.');
        assert.equal(m.is_system, true);
        const notes = noticesAfter(c, at);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mes, 'One verb per message for now.');
        assert.equal(m.extra[MOVE_KEY], undefined, 'no move');
        assert.equal(m.extra[FOUND_KEY], undefined, 'no [find] decision');
        assert.equal(m.extra.worldscrawl_door, undefined, 'no door touched');
        assert.equal(chatElapsed(c.chat), before);
    });
}
test('parse: [remember] and then [help] anywhere make the message that command; two action verbs are marked multi', () => {
    assert.equal(parseBracket('[move] north [find] Bryn').multi, 2);
    assert.equal(parseBracket('[find] Bryn [remember] Maren').verb, 'remember');
    assert.equal(parseBracket('[move] north [remember] Maren').verb, 'remember');
    assert.equal(parseBracket('[help] [remember] Maren').verb, 'remember');
    assert.equal(parseBracket('[move] out [help]').verb, 'help');
    assert.equal(parseBracket('[move] out').multi, undefined);
    assert.equal(parseBracket('[OOC: hi] then I [move] east').multi, undefined, 'unknown brackets do not count');
});
for (const [text, verb] of [['[move] out and [remember] Maren', 'remember'], ['[move] out [help]', 'help']]) {
    test(`"${text}": the system command wins (${verb}), the move is not made`, async () => {
        const { c, rec } = boot({ time: '10:00' });
        const at = say(c, text);
        assert.equal((await intercept(c, rec)).aborted, 1);
        const m = c.chat[at];
        assert.deepEqual(m.extra[CMD_KEY], { verb });
        assert.equal(m.is_system, true);
        assert.equal(m.extra[MOVE_KEY], undefined, 'no move');
        if (verb === 'remember') assert.equal(m.extra[REMEMBER_KEY]?.name, 'Maren');
        else assert.equal(noticesAfter(c, at)[0].mes, helpText());
    });
}
test('[find] someone who comes: not aborted, not hidden, the appearance stamp, Found line without a block end', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const at = say(c, '[find] Vera');
    const { aborted } = await intercept(c, rec);
    assert.equal(aborted, 0);
    const m = c.chat[at];
    assert.equal(m.is_system, undefined);
    assert.equal(m.extra[CMD_KEY], undefined);
    const d = m.extra[FOUND_KEY].find(x => x.id === 'vera');
    assert.equal(d.ok, true, d.reason);
    assert.equal(d.reason, 'Found: Vera comes here.');
    assert.ok(m.extra[NPC_KEY].some(s => s.type === 'npc_appear' && s.id === 'vera'));
});
test('[find] a known person who is not around: narrated; the firm not-found line is after the player\'s message, not in the facts', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const at = say(c, '[find] Nell');
    const { aborted } = await intercept(c, rec);
    assert.equal(aborted, 0, 'narrated');
    assert.equal(c.chat[at].is_system, undefined);
    const after = rec.blocks[REMINDER_KEY];
    assert.match(after, /You looks for Nell but does not find them\. Nell is not here and does not appear in this reply in any form: no arrival, no voice, no glimpse, no sign of them\. Nobody else stands in for Nell or answers as them\./);
    assert.doesNotMatch(rec.blocks[FACTS_KEY], /does not find them/);
    reply(c, 'Nobody comes.');
    say(c, 'I order a drink.');
    await intercept(c, rec);
    assert.doesNotMatch(rec.blocks[REMINDER_KEY], /does not find them/, 'only that turn');
});
for (const [text, why] of [['[find]', /needs a name/], ['[find] Zed', /No saved person is called "Zed"/]]) {
    test(`"${text}": a failure short-circuit (flagged, error, hidden, one notice); nobody is invented in the next prompt`, async () => {
        const { c, rec } = boot({ time: '10:00' });
        const at = say(c, text);
        assert.equal((await intercept(c, rec)).aborted, 1);
        const m = c.chat[at];
        assert.equal(m.extra[CMD_KEY].verb, 'find');
        assert.equal(m.extra[CMD_KEY].failed, true);
        assert.match(m.extra[CMD_KEY].error, why);
        assert.equal(m.is_system, true);
        assert.equal(noticesAfter(c, at).length, 1);
        say(c, 'I look around.');
        await intercept(c, rec);
        assert.doesNotMatch(`${rec.blocks[FACTS_KEY]}\n${rec.blocks[REMINDER_KEY]}`, /Zed|does not find them/);
    });
}

// ---------------------------------------------------------------- the short-circuit matrix (outright failures)
const SC = [
    ['[move] north', 'move', /north/i],
    ['[open]', 'open', /^Which door\? Doors you can open here: /],
    ['[lore] zzyzx', 'lore', /lore on file|no lore on file/],
    ['[name] Zed', 'name', /Zed/],
];
for (const [text, verb, why] of SC) {
    test(`SC "${text}": aborted, flagged ${verb} failed with the exact error, hidden, one notice, no move and no clock change`, async () => {
        const { c, rec } = boot({ time: '10:00' });
        const at = say(c, text);
        const before = chatElapsed(c.chat);
        assert.equal((await intercept(c, rec)).aborted, 1);
        assert.ok(!rec.calls.some(x => /Reply with JSON only:\n\{"place"/.test(x.prompt)), 'no tracker');
        if (verb !== 'move') assert.equal(rec.calls.length, 0, rec.calls.map(x => x.prompt.slice(0, 80)).join(' | '));
        const m = c.chat[at];
        assert.equal(m.extra[CMD_KEY].verb, verb);
        assert.equal(m.extra[CMD_KEY].failed, true);
        assert.match(m.extra[CMD_KEY].error, why);
        assert.equal(m.is_system, true);
        const notes = noticesAfter(c, at);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mes, m.extra[CMD_KEY].error, 'the stamped error is the notice text');
        assert.equal(m.extra[MOVE_KEY], undefined);
        assert.equal(chatElapsed(c.chat), before);
        reload(c);
        assert.equal(c.chat[at].extra[CMD_KEY].error, notes[0].mes, 'readable after a reload');
    });
}
test('SC [wait] until now: an error ("already HH:MM"), the clock does not move; one minute ahead is a wait', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const at = say(c, '[wait] until 10:00');
    const before = chatElapsed(c.chat);
    assert.equal((await intercept(c, rec)).aborted, 1);
    assert.match(c.chat[at].extra[CMD_KEY].error, /it is already 10:00; say how long or a later time/);
    assert.equal(chatElapsed(c.chat), before);
    const b = boot({ time: '10:00' });
    say(b.c, '[wait] until 10:01');
    assert.equal((await intercept(b.c, b.rec)).aborted, 0);
    assert.equal(chatElapsed(b.c.chat) - before, 60);
});
test('matrix pin: every verb is classified (command, short-circuit on failure, or narrated attempt)', () => {
    const CLASSES = { help: 'command', remember: 'command or SC', find: 'command (here), SC (empty/unknown) or narrated (not around)', move: 'SC or narrated (stuck door)', travel: 'SC or narrated (stuck door)',
        open: 'SC (unclear door) or narrated (stuck door)', close: 'SC', bar: 'SC', unbar: 'SC', look: 'SC or narrated (stuck door)', dig: 'narrated (failed dig)', wait: 'SC', sleep: 'SC', name: 'SC', lore: 'SC (no match)' };
    for (const v of VERBS) assert.ok(CLASSES[v.id], `verb ${v.id} has no matrix row`);
    assert.ok(!VERBS.some(v => v.id === 'found' || v.words.includes('found')), '[found] is gone');
    assert.deepEqual(VERBS.find(v => v.id === 'find'), { ...VERBS.find(v => v.id === 'find'), words: ['find'], slash: '/ws-find <name>' });
});

// ---------------------------------------------------------------- narrated attempts after the player's message
test('[open] a locked door: narrated; the stuck-door line is in the after-message slot, the facts keep the stay-put line', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const at = say(c, '[open] back');
    assert.equal((await intercept(c, rec)).aborted, 0);
    assert.equal(c.chat[at].is_system, undefined);
    assert.match(rec.blocks[REMINDER_KEY], /What just happened: You tries to open the door \(back\), but it is locked\. The door \(back\) does not open and it stays shut; nothing beyond it can be seen or reached\./);
    assert.doesNotMatch(rec.blocks[FACTS_KEY], /does not open/);
    assert.match(rec.blocks[FACTS_KEY], /You stays in Common Room \(The Drowned Rat\): no move happens\./);
    reply(c, 'It will not budge.');
    say(c, 'I sit down.');
    await intercept(c, rec);
    assert.doesNotMatch(rec.blocks[REMINDER_KEY], /does not open/, 'only that turn');
});
for (const [text, mode] of [['[move] back', 'buttons'], ['I go back', 'typed']]) {
    test(`a move into a stuck door ("${text}", ${mode}): narrated attempt, no move stamp, no time, the door stamp survives a reload`, async () => {
        const { c, rec } = boot({ time: '10:00', mode, intent: 'back' });
        const at = say(c, text);
        const before = chatElapsed(c.chat);
        assert.equal((await intercept(c, rec)).aborted, 0);
        const m = c.chat[at];
        assert.equal(m.extra[MOVE_KEY], undefined);
        assert.equal(m.extra[CMD_KEY], undefined);
        assert.equal(chatElapsed(c.chat), before);
        assert.deepEqual(m.extra.worldscrawl_door, { type: 'stuck', direction: 'back', why: 'is locked', attempt: 'move' });
        assert.match(rec.blocks[REMINDER_KEY], /You tries to go through the door \(back\), but it is locked\. The door \(back\) does not open, no one passes through it, and it stays shut\. You is still at .* and does not arrive anywhere else\. Describe the attempt failing\. Do not move You out of /);
        assert.doesNotMatch(rec.blocks[FACTS_KEY], /What just happened: You moved/, 'no narration.move');
        assert.match(rec.blocks[FACTS_KEY], /no move happens/);
        reload(c);
        assert.equal(c.chat[at].extra.worldscrawl_door.attempt, 'move');
    });
}
test('the after-message slot order is arrival, attempt, not-found, identity (source pin on applyFacts)', () => {
    const src = fs.readFileSync(new URL('../../extension/scene.mjs', import.meta.url), 'utf8');
    assert.match(src, /reminder = \[arrivalReminder\(loc, move\), \.\.\.attemptLines\(loc, move, facts\), \.\.\.\(facts\.after \?\? \[\]\)\]/);
    const nf = src.slice(src.indexOf('function notFoundLines'));
    assert.ok(nf.indexOf("'narration.npc_not_found'") < nf.indexOf("'narration.npc_identity'"));
});

// ---------------------------------------------------------------- identity line
async function notFoundFor(c, rec, id, name) {
    const at = say(c, `[find] ${name}`);
    c.chat[at].extra[FOUND_KEY] = [{ swipe: 0, name, id, ok: false, reason: 'not around', source: 'bracket', where: '', place: '' }];
    c.chat[at].extra.worldscrawl_intent_checked = true;
    await scene.applyFacts();
    return rec.blocks[REMINDER_KEY].split('\n').filter(Boolean);
}
test('identity: a known name gets "<name> is the landlady of the Drowned Rat." right after the not-found line; unknown name gets none and no real name', async () => {
    {
        const { c, rec } = boot({ time: '08:00' });
        c.chat[0].extra[NPC_KEY] = [{ type: 'npc_name', id: 'hesk', who: 'player', source: 'bracket' }];
        const lines = await notFoundFor(c, rec, 'hesk', 'Hesk');
        const i = lines.findIndex(l => /looks for Hesk but does not find them/.test(l));
        assert.ok(i >= 0, lines.join('\n'));
        assert.equal(lines[i + 1], 'Hesk is the landlady of the Drowned Rat.');
    }
    {
        const { c, rec } = boot({ time: '08:00' });
        const lines = await notFoundFor(c, rec, 'hesk', 'the landlady');
        assert.ok(lines.some(l => /looks for The landlady but does not find them/.test(l)), lines.join('\n'));
        assert.ok(!lines.some(l => / is the landlady/.test(l)), 'no identity line while the name is unknown');
        assert.doesNotMatch(lines.join('\n'), /Hesk/);
    }
});
test('identity: a saved job spot beats "Is at"; offmap job text; no pick takes the top "Is at" building; neither is the bare label; no doubled "of X"; no label, no line', async () => {
    const make = (id, name, as, extra = []) => [{ type: 'npc_create', id, name, line: 'a local', ...(as ? { unknownAs: as } : {}), facts: [] }, { type: 'npc_name', id, who: 'player', source: 'bracket' }, ...extra];
    const sched = (id, job) => ({ type: 'npc_schedule', id, schedule: [], pick: { pattern: 'works', job, job_activity: 'working', home: null, favorites: [] } });
    const cases = [
        ['ada', 'Ada', 'the cook', [sched('ada', 'riverton:general_store/shop')], /^Ada is the cook of Marlow's General Store\.$/],
        ['bo', 'Bo', 'the porter', [sched('bo', 'offmap: the docks')], /^Bo is the porter of the docks\.$/],
        ['cy', 'Cy', 'the Drowned Rat\'s potboy', [sched('cy', 'riverton:drowned_rat/cellar')], /^Cy is the Drowned Rat's potboy\.$/],
        ['di', 'Di', 'the drifter', [], /^Di is the drifter\.$/],
        ['ed', 'Ed', '', [], null],
    ];
    for (const [id, name, as, extra, want] of cases) {
        const { c, rec } = boot({ time: '10:00' });
        c.chat[0].extra[NPC_KEY] = make(id, name, as, extra);
        const lines = await notFoundFor(c, rec, id, name);
        const i = lines.findIndex(l => l.includes(`looks for ${name} but does not find them`));
        assert.ok(i >= 0, `${id}: ${lines.join(' | ')}`);
        if (want) assert.match(lines[i + 1] ?? '', want, id);
        else assert.equal(lines[i + 1], undefined, `${id}: no unknownAs, no identity line`);
    }
    // A saved card with "Is at" entries (Hesk: the common room is high importance) and no pick: that building.
    const { c, rec } = boot({ time: '08:00' });
    c.chat[0].extra[NPC_KEY] = [{ type: 'npc_name', id: 'hesk', who: 'player', source: 'bracket' }, sched('hesk', 'offmap: the smithy')];
    const lines = await notFoundFor(c, rec, 'hesk', 'Hesk');
    assert.ok(lines.includes('Hesk is the landlady of the smithy.'), `the job spot beats the "Is at" inn: ${lines.join(' | ')}`);
});

// ---------------------------------------------------------------- hide mechanism
test('hide: the interceptor runs /hide through executeSlashCommandsWithOptions; no hideChatMessageRange import anywhere', async () => {
    const doc = makeDoc([0, 1]);
    const { c, rec } = boot({ doc });
    const at = say(c, '[remember] Maren');
    await intercept(c, rec);
    assert.deepEqual(rec.slash, [`/hide ${at}`]);
    assert.equal(c.chat[at].is_system, true);
    assert.equal(doc.querySelector(`#chat .mes[mesid="${at}"]`).getAttribute('is_system'), 'true');
    assert.ok(rec.saves.some(s => s[at]?.is_system === true));
    for (const f of fs.readdirSync(new URL('../../extension/', import.meta.url))) {
        if (/\.(m?js)$/.test(f)) assert.doesNotMatch(fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8'), /hideChatMessageRange/, f);
    }
});
for (const how of ['noop', 'throw']) {
    test(`hide fallback (/hide ${how === 'noop' ? 'does nothing' : 'throws'}): is_system and the attribute set directly, the chat saved after, a call note; a reload keeps it hidden`, async () => {
        const doc = makeDoc([0, 1]);
        const { c, rec } = boot({ doc, hide: how });
        const at = say(c, '[remember] Maren');
        assert.equal((await intercept(c, rec)).aborted, 1);
        assert.equal(c.chat[at].is_system, true);
        assert.equal(doc.querySelector(`#chat .mes[mesid="${at}"]`).getAttribute('is_system'), 'true');
        const saved = rec.saves.findLast(s => s[at]?.is_system === true);
        assert.ok(saved, 'a save after the flag');
        assert.equal(saved[at].is_system, true);
        c.chat = JSON.parse(JSON.stringify(saved));
        assert.equal(c.chat[at].is_system, true, 'reloaded: still hidden');
        assert.ok(Object.values(c.chat[at].extra.worldscrawl_calls ?? {}).flat().some(x => x.kind === 'hide'), 'the fallback is in the call log');
    });
}
test('hide fallback whose save fails does not throw out of the interceptor; the reply is still aborted', async () => {
    const { c, rec } = boot({ hide: 'noop' });
    const at = say(c, '[help]');
    // Only the fallback's own save fails (the first save after it set is_system on the command).
    let failed = 0;
    c.saveChat = async () => { if (c.chat[at].is_system && failed++ === 0) throw new Error('disk full'); };
    const { aborted } = await intercept(c, rec);
    assert.equal(aborted, 1);
    assert.ok(failed >= 2, 'the fallback save failed, and later saves still ran');
    assert.equal(c.chat[at].is_system, true);
    assert.equal(noticesAfter(c, at).length, 1, 'the notice still went in');
});

// ---------------------------------------------------------------- regenerate guard
test('regenerate guard: a hidden command last refuses regenerate, swipe and continue with the toast, also with notice or system rows after it', async () => {
    for (const tail of [[], [{ is_user: false, is_system: true, mes: 'x', extra: { worldscrawl_notice: true } }], [{ is_user: false, is_system: true, mes: 'plain system', extra: {} }]]) {
        const { c, rec } = boot();
        reply(c, 'The fire crackles.');
        say(c, '[remember] Maren', { [CMD_KEY]: { verb: 'remember' } });
        c.chat.at(-1).is_system = true;
        c.chat.push(...tail);
        for (const type of ['regenerate', 'swipe', 'continue']) assert.equal((await intercept(c, rec, type)).aborted, 1, `${type} with ${tail.length} rows after`);
        assert.equal(rec.toasts.filter(t => t.includes(CMD_REDO_TOAST)).length, 3);
    }
});
test('regenerate guard falls through for a user-hidden (not flagged) line, an unhidden command, and notices after a normal reply', async () => {
    const cases = [
        c => { say(c, 'I hide this myself'); c.chat.at(-1).is_system = true; reply(c, 'A normal reply.'); },
        c => { say(c, '[remember] Maren', { [CMD_KEY]: { verb: 'remember' } }); },
        c => { reply(c, 'A normal reply.'); c.chat.push({ is_user: false, is_system: true, mes: 'n', extra: { worldscrawl_notice: true } }); },
    ];
    for (const set of cases) {
        const { c, rec } = boot();
        set(c);
        for (const type of ['regenerate', 'swipe', 'continue']) assert.equal((await intercept(c, rec, type)).aborted, 0, type);
        assert.equal(rec.toasts.length, 0);
    }
});
test('source pins: the guard sits before the tracker wait, and its flagged-and-hidden test comes before the system-row skip', () => {
    const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('globalThis.worldscrawlInterceptor'));
    assert.ok(body.indexOf('hiddenCommandLast(chat)') > 0 && body.indexOf('hiddenCommandLast(chat)') < body.indexOf('trackerSettled('));
    const fn = src.slice(src.indexOf('export function hiddenCommandLast'), src.indexOf('export async function hideCommand'));
    assert.ok(fn.indexOf('m?.extra?.[CMD_KEY] && m.is_system') < fn.indexOf('m?.is_system || m?.extra?.worldscrawl_notice'));
});

// ---------------------------------------------------------------- prompt exclusion and the is_system audit
test('a hidden command stays out of the prompt; the interceptor drops nothing; lastUserIndex counts it, turnPlayerIndex skips it; rememberStory leaves it out', async () => {
    const { c, rec } = boot();
    const at = say(c, '[remember] Maren and the secret word');
    await intercept(c, rec);
    assert.equal(MV.lastUserIndex(c.chat), at, 'the hidden command is the last player line');
    say(c, 'I hum to myself.');
    c.chat.splice(c.chat.length - 1, 1);
    reply(c, 'Time passes.');
    const p = say(c, 'I hum to myself.');
    const { core } = await intercept(c, rec);
    assert.equal(core.length, c.chat.filter(m => !m.is_system).length, 'nothing spliced');
    assert.ok(!core.some(m => /secret word/.test(m.mes)), 'ST leaves the hidden command out of coreChat');
    assert.equal(GEN.turnPlayerIndex(c.chat), p);
    assert.doesNotMatch(scene.rememberStory(c.chat, c.chat.length - 1, 'Maren'), /secret word/);
    // A line the player hid by hand is still skipped.
    const { c: c2 } = boot();
    const u = say(c2, 'mine'); c2.chat[u].is_system = true;
    assert.equal(MV.lastUserIndex(c2.chat), -1);
});
test('after a hidden [remember], applyFacts reads nothing from the previous turn (no took line, no arrival reminder, no not-found)', async () => {
    const { c, rec } = boot({ time: '10:00' });
    say(c, '[find] Nell');
    await intercept(c, rec);
    assert.match(rec.blocks[REMINDER_KEY], /does not find them/);
    reply(c, 'Nobody.');
    say(c, '[remember] Maren');
    await intercept(c, rec);
    await scene.applyFacts();
    assert.doesNotMatch(rec.blocks[REMINDER_KEY] ?? '', /does not find them/);
    assert.doesNotMatch(rec.blocks[FACTS_KEY] ?? '', /took/);
});

// ---------------------------------------------------------------- reload, Approve and unhide
test('reload: the Remember card on a hidden command still works; Approve writes the person, memories and broadcasts the map', async () => {
    const { c, rec } = boot();
    const at = say(c, '[remember] Maren');
    await intercept(c, rec);
    reload(c);
    assert.equal(c.chat[at].is_system, true);
    assert.equal(c.chat[at].extra[REMEMBER_KEY].status, 'review');
    const posts = listen();
    await scene.keepRemember(at);
    await flushT(250);
    const stamps = c.chat[at].extra[NPC_KEY];
    const made = stamps.find(s => s.type === 'npc_create');
    assert.equal(made.name, 'Maren');
    assert.deepEqual(stamps.filter(s => s.type === 'npc_memory').map(s => s.note), ['The player paid her without haggling.']);
    assert.ok(stamps.findIndex(s => s.type === 'npc_memory') > stamps.findIndex(s => s.type === 'npc_create'));
    assert.ok(framesOf(c.chat, c.chat.length - 1, scene.castPack().npcs).at(-1).get(made.id), 'replay folds the hidden row');
    assert.ok(posts.length >= 1 && npcsIn(posts.at(-1)).includes('Maren'), 'the map state lists her');
    globalThis.BroadcastChannel = undefined;
});
test('unhide: the flag stays, the verb is not re-run on the next send or a regenerate, and the brackets are removed from the prompt', async () => {
    const { c, rec } = boot();
    const at = say(c, '[remember] Maren');
    await intercept(c, rec);
    const card0 = c.chat[at].extra[REMEMBER_KEY];
    await c.executeSlashCommandsWithOptions(`/unhide ${at}`);
    assert.equal(c.chat[at].is_system, false);
    assert.deepEqual(c.chat[at].extra[CMD_KEY], { verb: 'remember' });
    assert.equal(MV.lastUserIndex(c.chat), at);
    const { aborted, core } = await intercept(c, rec, 'normal');
    assert.equal(aborted, 0);
    assert.equal(c.chat[at].extra[REMEMBER_KEY], card0, 'no second card');
    assert.ok(core.some(m => m.mes === 'remember Maren'), 'brackets removed');
    const r = await intercept(c, rec, 'regenerate');
    assert.equal(r.aborted, 0, 'regenerate after unhide replies');
    assert.equal(c.chat[at].extra[REMEMBER_KEY], card0);
    await c.executeSlashCommandsWithOptions(`/hide ${at}`);
    assert.equal((await intercept(c, rec, 'regenerate')).aborted, 1, 'hidden again: refused again');
});

// ---------------------------------------------------------------- off, slash commands
test('WorldScrawl off: nothing short-circuits and nothing is hidden', async () => {
    const { c, rec } = boot();
    c.chatMetadata = { worldscrawl_enabled: false };
    const at = say(c, '[remember] Maren');
    assert.equal((await intercept(c, rec)).aborted, 0);
    assert.equal(c.chat[at].is_system, undefined);
    assert.equal(c.chat[at].extra[CMD_KEY], undefined);
});
test('/ws-find is registered and /ws-found is gone; /ws-npc still puts the card on the last story message, with no flag', async () => {
    assert.ok(cmds['ws-find'], '/ws-find');
    assert.equal(cmds['ws-found'], undefined);
    const { c, rec } = boot();
    say(c, '[help]');
    await intercept(c, rec);
    reply(c, 'The fire crackles.');
    const last = c.chat.length - 1;
    await cmds['ws-npc'].callback({}, 'Maren');
    assert.equal(c.chat[last].extra[REMEMBER_KEY]?.name, 'Maren');
    assert.equal(c.chat[last].extra[CMD_KEY], undefined);
    assert.equal(c.chat[last].is_system, undefined);
});
test('/ws-find: right here and found make the same decisions as [find] on the last visible player line; absent and unknown are text notices with no narrator line', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const hidden = say(c, '[help]');
    await intercept(c, rec);
    const p = say(c, 'I look around.');
    c.chat[p].extra.worldscrawl_intent_checked = true;
    await cmds['ws-find'].callback({}, 'Bryn');
    let d = c.chat[p].extra[FOUND_KEY].at(-1);
    assert.equal(d.here, true);
    assert.equal(d.slash, true);
    assert.equal(c.chat[hidden].extra[FOUND_KEY], undefined, 'never the hidden command');
    await cmds['ws-find'].callback({}, 'Vera');
    d = c.chat[p].extra[FOUND_KEY].at(-1);
    assert.equal(d.reason, 'Found: Vera comes here.');
    const len = c.chat.length;
    await cmds['ws-find'].callback({}, 'Nell');
    assert.equal(c.chat.length, len + 1);
    assert.match(c.chat.at(-1).mes, /^Couldn't find Nell: /);
    await cmds['ws-find'].callback({}, 'Zed');
    assert.match(c.chat.at(-1).mes, /No saved person is called "Zed"/);
    await scene.applyFacts();
    assert.doesNotMatch(rec.blocks[REMINDER_KEY] ?? '', /does not find them/, 'a slash find never feeds the narrator');
});

// ---------------------------------------------------------------- typed notices, a look at a stuck door, regenerate
for (const [answer, kind] of [[MV.ELSEWHERE, 'not aware'], ['The Drowned Rat', 'already']]) {
    test(`typed move with a "${kind}" notice: the same failure short-circuit (flagged move, error, hidden, one notice row)`, async () => {
        const { c, rec } = boot({ time: '10:00', mode: 'typed', intent: answer });
        const at = say(c, 'I wander off somewhere');
        assert.equal((await intercept(c, rec)).aborted, 1);
        const m = c.chat[at];
        assert.equal(m.extra[CMD_KEY].verb, 'move');
        assert.equal(m.extra[CMD_KEY].failed, true);
        assert.equal(m.is_system, true);
        const notes = noticesAfter(c, at);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mes, m.extra[CMD_KEY].error);
        assert.equal(m.extra[MOVE_KEY], undefined);
    });
}
test('a regenerate of a narrated attempt keeps the same after-message line', async () => {
    const { c, rec } = boot({ time: '10:00' });
    const at = say(c, '[open] back');
    await intercept(c, rec);
    const line = rec.blocks[REMINDER_KEY];
    assert.match(line, /does not open and it stays shut/);
    // ST removes the reply, then regenerates from the player's line.
    const r = await intercept(c, rec, 'regenerate');
    assert.equal(r.aborted, 0);
    assert.equal(rec.blocks[REMINDER_KEY], line, 'the same after-slot line on a regenerate');
    assert.equal(c.chat[at].is_system, undefined);
});
test('a look that tries a stuck door (look kind closed + stuck): the stuck-door line goes to attemptLines, the facts keep only the stay-put line', async () => {
    boot({ time: '10:00' });
    const { attemptLines, factsText } = await import('../../extension/brackets.mjs');
    const { currentLocation } = await import('../../extension/doors.mjs');
    const loc = await currentLocation();
    const extra = { look: { kind: 'closed', via: 'back', word: 'door', stuck: 'is locked' } };
    const after = attemptLines(loc, null, extra);
    assert.equal(after.length, 1);
    assert.match(after[0], /^What just happened: You tries to open the door \(back\), but it is locked\. The door \(back\) does not open and it stays shut/);
    const facts = factsText(loc, null, false, extra);
    assert.doesNotMatch(facts, /is locked/);
    assert.match(facts, /no move happens/);
    assert.deepEqual(attemptLines(loc, { to: loc.address }, extra), [], 'none on a move turn');
});
