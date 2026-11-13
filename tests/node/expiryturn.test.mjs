// The turn's expiry step and the one narration of a temporary place that ran out, through the real handlers:
// waitCommand (/ws-wait, /ws-sleep, the map's Wait button), a typed [wait], the generation interceptor, the 150 ms map
// refresh, the wait card's Approve and Auto-keep waits. SillyTavern is stood in for by a generate() that sends the same
// events in the same order (GENERATION_STARTED, the "generating" flag, the interceptor after a delay, MESSAGE_RECEIVED,
// GENERATION_ENDED), and a group wrapper that goes through its members.
import './ststub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN, SQUARE } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ET = { GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped', MESSAGE_RECEIVED: 'message_received',
    GROUP_WRAPPER_STARTED: 'group_wrapper_started', GROUP_WRAPPER_FINISHED: 'group_wrapper_finished', CHAT_CHANGED: 'chat_id_changed' };
const handlers = new Map();
const bus = { on(t, f) { if (t) (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); }, async emit(t, ...a) { for (const f of handlers.get(t) ?? []) { try { await f(...a); } catch { /* like SillyTavern's emitter: one listener's error does not stop the rest */ } } } };
const c0 = SillyTavern.getContext();
c0.eventSource = bus; c0.eventTypes = ET;
// The map window's channel: the real listener (the map's Wait button) is called with the window's message.
class FakeChannel { static all = []; constructor(n) { this.name = n; this.l = []; FakeChannel.all.push(this); } addEventListener(_t, f) { this.l.push(f); } postMessage() {} close() {} }
globalThis.BroadcastChannel = FakeChannel;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const ext = await import('../../extension/index.js');
const { exitsCache } = await import('../../extension/footer.mjs');
const { NPC_KEY } = await import('../../extension/npc.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { callNotes } = await import('../../extension/calllog.mjs');
const { proposeWait, keepWait } = await import('../../extension/waits.mjs');
const { EXPIRY_LINE_KEY, genReset, hostIndex, turnPlayerIndex } = await import('../../extension/generations.mjs');
await loadCalendar();
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BOOTH = 'riverton:streets/stall';
const FAIR = [{ op: 'create_place', area: 'riverton:streets', id: 'stall', name: 'Pop-up Stall', description: 'Canvas and crates.', lasts: '1h', exits: [{ direction: 'stall', to: SQUARE, return_direction: 'square' }] },
    { op: 'set_description', loc: TAVERN, text: 'Smoke from the fair drifts through the common room.', lasts: '1h' }];
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const gnoll = { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'turned into a gnoll', owner: 'og', start: 0, lasts: 60, contentId: 'c_og', candidate: null, decisionRev: 1,
    identity: { owner: 'og', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'turned into a gnoll', fields: 'body', layer: {} } };
const ENDS = /has come to an end/;

// ---- SillyTavern stand-in
const G = { delay: 300, gens: [], facts: '', stopNext: false, inGroup: false, n: 0 };
const user = mes => ({ name: 'You', is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} });
const reply = (mes, avatar) => ({ name: 'Bot', is_user: false, mes, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra: {}, ...(avatar ? { original_avatar: avatar } : {}) });
async function stGenerate(type = 'normal', opts = {}, { send = null, text = null } = {}) {
    const c = SillyTavern.getContext();
    if (c.groupId && !G.inGroup && type !== 'quiet') return groupWrapper(type, opts, send);
    const rec = { type, opts, facts: null, reply: null };
    G.gens.push(rec);
    await bus.emit(ET.GENERATION_STARTED, type, opts, false);
    if (send) { c.chat.push(user(send)); setTimeout(() => ext.renderAllExits?.().catch?.(() => {}), 0); }
    globalThis.document.body.dataset.generating = 'true';
    await sleep(G.delay); // SillyTavern's own work before the interceptors (ping, world info, an earlier extension's interceptor)
    let aborted = false;
    G.facts = '';
    await globalThis.worldscrawlInterceptor(c.chat.filter(m => !m.is_system).map(m => ({ ...m })), 0, () => { aborted = true; }, type);
    rec.facts = G.facts;
    if (aborted || G.stopNext) {
        G.stopNext = false; rec.stopped = true;
        await bus.emit(ET.GENERATION_STOPPED);
        delete globalThis.document.body.dataset.generating;
        await bus.emit(ET.GENERATION_ENDED, c.chat.length);
        return '';
    }
    await sleep(40);
    const mes = text ?? `Reply ${++G.n}.`;
    const avatar = opts.member != null ? c.characters[opts.member]?.avatar : null;
    let id;
    if (type === 'swipe') {
        const m = c.chat[c.chat.length - 1];
        m.swipes.push(mes); m.swipe_info.push({ extra: {} }); m.swipe_id = m.swipes.length - 1; m.mes = mes; m.extra = {};
        id = c.chat.length - 1;
    } else { c.chat.push(reply(mes, avatar)); id = c.chat.length - 1; }
    rec.reply = id;
    await bus.emit(ET.MESSAGE_RECEIVED, id, type);
    delete globalThis.document.body.dataset.generating;
    await bus.emit(ET.GENERATION_ENDED, c.chat.length);
    return mes;
}
async function groupWrapper(type, opts, send) {
    const c = SillyTavern.getContext();
    await bus.emit(ET.GROUP_WRAPPER_STARTED, {});
    if (send) c.chat.push(user(send));
    const members = Number.isInteger(opts.force_chid) ? [opts.force_chid] : [0, 1]; // list order: every member answers
    G.inGroup = true;
    try { for (const m of members) await stGenerate(type, { ...opts, member: m }); } finally { G.inGroup = false; }
    await bus.emit(ET.GROUP_WRAPPER_FINISHED, {});
}
/** Until no generation has started and the chat has not changed for `quiet` ms (the deferred narration included). */
async function settle(quiet = 1500, max = 15000) {
    const c = SillyTavern.getContext(), t0 = Date.now();
    let seen = '', since = Date.now();
    while (Date.now() - t0 < max) {
        await sleep(100);
        const now = `${G.gens.length}|${c.chat.length}|${globalThis.document.body.dataset.generating ?? ''}`;
        if (now !== seen) { seen = now; since = Date.now(); } else if (Date.now() - since >= quiet) return;
    }
}

let chats = 0;
/** A fresh chat: the party in a 1-hour pop-up stall, Hesk a gnoll for the hour, smoke in the Common Room for the hour. */
function fresh({ narrate = true, group = false, delay = 300 } = {}) {
    genReset();
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] });
    const c = SillyTavern.getContext();
    const id = `expiryturn${++chats}`;
    exitsCache.clear();
    Object.assign(G, { delay, gens: [], facts: '', stopNext: false, inGroup: false });
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = group ? undefined : 0;
    c.groupId = group ? 'g1' : undefined;
    c.groups = [{ id: 'g1', members: ['ann.png', 'bo.png'], disabled_members: [] }];
    c.characters = [{ avatar: 'ann.png', name: 'Ann' }, { avatar: 'bo.png', name: 'Bo' }];
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = (key, value) => { if (key === 'worldscrawl_facts') G.facts = value; };
    Object.assign(ext.settings(), { autoKeepWaits: false, narrateExpiries: narrate, moveMode: 'typed' });
    c.generateRaw = async () => '{"body":"sturdy","outfit":"wool"}';
    c.generate = stGenerate;
    c.executeSlashCommandsWithOptions = async cmd => { // /send: the player's line, then USER_MESSAGE_RENDERED (WorldScrawl redraws its footers)
        c.chat.push(user(cmd.replace(/^\/send /, '')));
        setTimeout(() => ext.renderAllExits?.().catch?.(() => {}), 0);
    };
    c.chat = [
        user('I duck into the pop-up stall.'),
        { ...reply('The fair is in town; Hesk, a gnoll for the hour, hands you a mug.', group ? 'bo.png' : null),
            extra: { worldscrawl_mid: `m${id}`, worldscrawl_location: BOOTH, worldscrawl_patches: [{ type: 'patch', id: `fair${id}`, note: 'the fair comes to town', at: 0, swipe: 0, ops: FAIR, summary: ['Pop-up Stall', 'Common Room: smoke'] }],
                [NPC_KEY]: [{ swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }, gnoll] } },
    ];
    c.chat[0].extra.worldscrawl_move = { to: BOOTH };
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    return c;
}
const kinds = c => c.chat.map(m => m.is_user ? (m.is_system ? 'hidden' : 'player') : m.extra?.worldscrawl_notice ? m.extra.worldscrawl_notice_kind : 'reply');
const count = (c, k) => kinds(c).filter(x => x === k).length;
const failedNotes = c => c.chat.flatMap((m, i) => callNotes(m).filter(n => n.kind === 'narrator' && n.status === 'failed').map(n => `#${i}: ${n.reason}`));
const loc = m => m?.extra?.worldscrawl_location;

const WAYS = {
    '/ws-wait': () => ext.waitCommand('2 hours'),
    '/ws-sleep': () => ext.waitCommand('2 hours', true),
    'the map\'s Wait button': () => { const c = SillyTavern.getContext(); for (const ch of FakeChannel.all) for (const f of ch.l) f({ data: { type: 'wait', chatId: c.chatId, args: '2 hours' } }); },
    'a typed [wait]': () => stGenerate('normal', { }, { send: '[wait] 2 hours' }),
};

for (const [way, run] of Object.entries(WAYS)) {
    test(`${way}, Narrate expiries on, a slow interceptor: one narrator reply tells the stall ending, with the turn's cards`, async () => {
        const c = fresh({ narrate: true });
        await run(); await settle();
        assert.equal(G.gens.length, 1, `one generation (${G.gens.map(g => g.type).join(', ')}): ${kinds(c).join(' > ')}`);
        const [g] = G.gens;
        assert.match(g.facts, ENDS, 'its prompt carries the expiry line');
        assert.match(g.facts, /Current location: Village Square/);
        const r = c.chat[g.reply];
        assert.equal(loc(r), SQUARE, 'the reply carries the move');
        assert.deepEqual(r.extra.worldscrawl_expiry_narrated, { from: BOOTH, to: SQUARE });
        assert.equal(count(c, 'npc_expired'), 1); assert.equal(count(c, 'place_expired'), 1);
        assert.equal(count(c, 'missing'), 0, 'told, so no plain notice');
        const p = turnPlayerIndex(c.chat.slice(0, g.reply));
        assert.ok(p >= 0 && c.chat[p].extra.worldscrawl_npc_ready, 'the person check ran on the player\'s line');
        assert.equal(c.chat[hostIndex(c.chat, g.reply)].extra[EXPIRY_LINE_KEY]?.to, SQUARE, 'the host keeps the told line');
        assert.deepEqual(failedNotes(c), []);
    });
    test(`${way}, Narrate expiries off, a slow interceptor: the plain notice, then the turn's cards and person check still run`, async () => {
        const c = fresh({ narrate: false });
        await run(); await settle();
        assert.equal(G.gens.length, 1, kinds(c).join(' > '));
        const [g] = G.gens;
        assert.equal(count(c, 'missing'), 1, `one "passage seals" notice: ${kinds(c).join(' > ')}`);
        assert.equal(count(c, 'npc_expired'), 1, kinds(c).join(' > ')); assert.equal(count(c, 'place_expired'), 1);
        assert.doesNotMatch(g.facts, ENDS);
        assert.match(g.facts, /Current location: Village Square/);
        const p = c.chat.findIndex(m => m.is_user && /2h|2 hours/.test(m.mes));
        assert.ok(c.chat[p].extra.worldscrawl_npc_ready, 'the person check ran on the player\'s line');
        assert.deepEqual(failedNotes(c), []);
    });
}

test('turn: the player\'s line is the last one after the last story reply; notices, system and hidden lines are skipped', () => {
    const N = { is_system: true, extra: { worldscrawl_notice: true } }, R = { mes: 'r' }, U = { is_user: true, mes: 'u' }, H = { is_user: true, is_system: true, mes: 'hidden' };
    assert.equal(turnPlayerIndex([R, U]), 1);
    assert.equal(turnPlayerIndex([R, U, N, N]), 1);
    assert.equal(turnPlayerIndex([R, U, H]), 1);
    assert.equal(turnPlayerIndex([R, H]), -1, 'a /hide\'d line is not a turn');
    assert.equal(turnPlayerIndex([R, U, R]), -1, 'a group\'s later member: a reply came after the line');
    assert.equal(turnPlayerIndex([R, U, R, N]), -1, 'an automatic reply after a notice is not a new turn');
    assert.equal(hostIndex([R, U, N, N, R], 4), 1);
});
test('a /hide\'d line after the player\'s line: the turn is still the player\'s line (its cards and person check)', async () => {
    const c = fresh({ narrate: false, delay: 0 });
    const w = user('I wait two hours.'); w.extra.worldscrawl_wait = { seconds: 7200, label: '2 hours' }; w.extra.worldscrawl_engine = true;
    c.chat.push(w, { ...user('(an aside I hid)'), is_system: true });
    await stGenerate('normal'); await settle(800);
    assert.equal(count(c, 'npc_expired'), 1, kinds(c).join(' > ')); assert.equal(count(c, 'place_expired'), 1);
    assert.ok(w.extra.worldscrawl_npc_ready);
    assert.ok(!c.chat[3].extra.worldscrawl_npc_ready, 'not the hidden one');
});

test('a narrator wait kept with Approve: exactly one automatic reply tells it', async () => {
    const c = fresh({ narrate: true, delay: 50 });
    await stGenerate('normal', {}, { send: 'I browse the stalls.' });
    const r = c.chat.length - 1;
    proposeWait(c.chat[r], { seconds: 7200, label: '2 hours', sleep: false, reason: 'browsing' });
    assert.equal(await keepWait(r), '');
    await settle();
    assert.equal(G.gens.length, 2, kinds(c).join(' > '));
    const g = G.gens[1];
    assert.equal(g.opts.automatic_trigger, true);
    assert.match(g.facts, ENDS);
    assert.equal(loc(c.chat[g.reply]), SQUARE);
    assert.equal(count(c, 'missing'), 0);
    assert.deepEqual(failedNotes(c), []);
});
test('a narrator wait kept by Auto-keep waits as the reply lands: one more automatic reply, after that reply ends', async () => {
    const c = fresh({ narrate: true, delay: 50 });
    ext.settings().autoKeepWaits = true;
    await stGenerate('normal', {}, { send: 'I browse the stalls.', text: 'You browse for a long while. [ws_wait: 2h | browsing the fair]' });
    await settle();
    assert.equal(G.gens.length, 2, kinds(c).join(' > '));
    assert.doesNotMatch(G.gens[0].facts, ENDS);
    assert.match(G.gens[1].facts, ENDS);
    assert.equal(G.gens[1].opts.automatic_trigger, true);
    assert.equal(loc(c.chat[G.gens[1].reply]), SQUARE);
    assert.deepEqual(failedNotes(c), []);
});
test('Stop during the reply that carried it: the plain notice keeps the move, no second run', async () => {
    const c = fresh({ narrate: true });
    G.stopNext = true;
    await ext.waitCommand('2 hours'); await settle();
    assert.equal(G.gens.length, 1, kinds(c).join(' > '));
    assert.match(G.gens[0].facts, ENDS);
    assert.equal(count(c, 'missing'), 1, kinds(c).join(' > '));
    const n = c.chat.find(m => m.extra?.worldscrawl_notice_kind === 'missing');
    assert.equal(loc(n), SQUARE); assert.equal(n.extra.worldscrawl_notice_expired, true);
    assert.equal(ext.getStoredLocation(), SQUARE);
});
test('a chat switch while it waits: nothing runs and nothing posts in the new chat', async () => {
    const c = fresh({ narrate: true, delay: 50 });
    await stGenerate('normal', {}, { send: 'I browse the stalls.' });
    const r = c.chat.length - 1;
    proposeWait(c.chat[r], { seconds: 7200, label: '2 hours', sleep: false, reason: 'browsing' });
    globalThis.document.body.dataset.generating = 'true'; // something else is generating: the narration waits
    await keepWait(r);
    const before = c.chat;
    c.chatId = 'another'; c.getCurrentChatId = () => 'another'; c.chat = [user('hello')];
    await bus.emit(ET.CHAT_CHANGED, 'another');
    delete globalThis.document.body.dataset.generating;
    await settle();
    assert.equal(G.gens.length, 1, 'no automatic run');
    assert.deepEqual(kinds(c), ['player'], 'nothing posted in the new chat');
    assert.equal(before.filter(m => m.extra?.worldscrawl_notice_kind === 'missing').length, 0);
});
test('a swipe of the reply that told it: the line again from its host, the stamp again, no extra run', async () => {
    const c = fresh({ narrate: true, delay: 50 });
    await ext.waitCommand('2 hours'); await settle();
    assert.equal(G.gens.length, 1);
    const at = G.gens[0].reply;
    await stGenerate('swipe'); await settle();
    assert.equal(G.gens.length, 2, `no automatic run on the swipe: ${G.gens.map(g => g.type).join(', ')}`);
    assert.match(G.gens[1].facts, ENDS, 'the swipe\'s prompt carries the line');
    assert.match(G.gens[1].facts, /Current location: Village Square/);
    assert.equal(c.chat[at].swipe_id, 1);
    assert.equal(loc(c.chat[at]), SQUARE, 'the new swipe carries the move');
    assert.equal(count(c, 'missing'), 0);
    assert.equal(ext.getStoredLocation(), SQUARE);
});
test('a group chat, /ws-wait with Narrate expiries on: only the first member\'s prompt carries it, no extra run', async () => {
    const c = fresh({ narrate: true, group: true });
    await ext.waitCommand('2 hours'); await settle();
    assert.equal(G.gens.length, 2, 'both members answer the wait');
    assert.equal(G.gens.filter(g => ENDS.test(g.facts)).length, 1, 'exactly one tells the stall ending');
    assert.match(G.gens[0].facts, ENDS);
    assert.equal(loc(c.chat[G.gens[0].reply]), SQUARE);
    assert.equal(count(c, 'npc_expired'), 1); assert.equal(count(c, 'place_expired'), 1);
    assert.deepEqual(failedNotes(c), []);
});
test('a group chat, a kept narrator wait: exactly one member (the last speaker) tells it', async () => {
    const c = fresh({ narrate: true, group: true, delay: 50 });
    const r = c.chat.length - 1; // Bo's reply
    proposeWait(c.chat[r], { seconds: 7200, label: '2 hours', sleep: false, reason: 'browsing' });
    await keepWait(r); await settle();
    assert.equal(G.gens.length, 1, kinds(c).join(' > '));
    assert.equal(G.gens[0].opts.force_chid, 1, 'Bo, who spoke last');
    assert.match(G.gens[0].facts, ENDS);
    assert.equal(loc(c.chat[G.gens[0].reply]), SQUARE);
});
test('narrator failed notes: each generation is its own record; a second start never closes the first', async () => {
    const c = fresh({ narrate: true, delay: 0 });
    c.chat.push(user('hello'));
    globalThis.document.body.dataset.generating = 'true';
    await bus.emit(ET.GENERATION_STARTED, 'normal', {}, false);
    await bus.emit(ET.GENERATION_STARTED, 'normal', { automatic_trigger: true }, false); // a second one while the first runs
    c.chat.push(reply('first')); await bus.emit(ET.MESSAGE_RECEIVED, c.chat.length - 1);
    c.chat.push(reply('second')); await bus.emit(ET.MESSAGE_RECEIVED, c.chat.length - 1);
    delete globalThis.document.body.dataset.generating;
    await bus.emit(ET.GENERATION_ENDED); await sleep(900);
    assert.deepEqual(failedNotes(c), [], 'both got their reply');
    // A stopped one still gets its note.
    globalThis.document.body.dataset.generating = 'true';
    await bus.emit(ET.GENERATION_STARTED, 'normal', {}, false);
    await bus.emit(ET.GENERATION_STOPPED);
    delete globalThis.document.body.dataset.generating;
    await bus.emit(ET.GENERATION_ENDED); await sleep(900);
    assert.deepEqual(failedNotes(c), [`#${c.chat.length - 1}: stopped before a reply (aborted)`]);
});
