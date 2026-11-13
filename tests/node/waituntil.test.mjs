// B7: "[wait] until 17:15" lands on 17:15 by every way a wait-until reaches the clock. Through the real handlers:
// waitCommand (/ws-wait and the map's Wait button), the generation interceptor with a typed [wait] bracket,
// onReplyForFlags -> the tracker -> applyTrackerResult (a typed wait with no bracket), the narrator's wait tag, and the
// wait card's Approve edited (keepWait).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const D = await import('../../extension/discovery.mjs');
const W = await import('../../extension/waits.mjs');
const { parseWaitTag, waitArgs } = await import('../../extension/words.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar, chatElapsed, worldTimes } = CLK;
await loadCalendar();
const calendarLib = CLK.calendarLib; // set by loadCalendar (a live binding: read it after)
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const WAIT = 'worldscrawl_wait';

let n = 0;
/** A fresh chat at the start time (before 17:00). `tracker` is the tracker's JSON answer; every model call is recorded. */
function boot({ tracker = { place: null, people: [], wait: null }, autoKeepWaits = true } = {}) {
    exitsCache.clear();
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    rememberWorlds(server.get('/worlds').json());
    const c = SillyTavern.getContext(), id = `wu${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    const calls = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? '');
        calls.push(prompt);
        if (/Reply with JSON only:\n\{"place"/.test(prompt)) return JSON.stringify(tracker);
        if (/How long is this wait\?/.test(prompt)) return '{"until": "17:00"}'; // a model that rounds
        return '{}';
    };
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { c.chat.push({ is_user: true, mes: cmd.replace(/^\/send /, ''), swipe_id: 0, extra: {} }); };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, calls };
}
const clock = c => { const t = worldTimes.get('riverton'); return calendarLib.dateAt(chatElapsed(c.chat), t?.start_date ?? null, t?.calendar ?? null).time; };
const asked = calls => calls.filter(p => /How long is this wait\?/.test(p)).length;
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const intercept = () => globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();

test('the start clock is before 17:00 (the tests below wait forward to 17:15 the same day)', () => {
    const { c } = boot();
    assert.ok(clock(c) < '17:00', clock(c));
});

test('/ws-wait until 17:15 (and the map\'s Wait button, which calls the same command) lands on 17:15', async () => {
    const { c, calls } = boot();
    assert.equal(await ext.waitCommand('until 17:15'), '');
    assert.equal(clock(c), '17:15');
    assert.equal(asked(calls), 0, 'read by the parser, no model call');
});

for (const line of ['I [wait] until 17:15.', 'I [wait] until 17:15 and eat', 'I [wait] till 5:15 pm and watch the door', 'I [wait] to 17:15', 'I [wait] until about 17:15']) {
    test(`a typed bracket "${line}" lands on 17:15 without a model guess`, async () => {
        const { c, calls } = boot();
        const p = say(c, line);
        await intercept();
        assert.ok(c.chat[p].extra[WAIT]?.seconds > 0, JSON.stringify(c.chat[p].extra));
        assert.equal(clock(c), '17:15');
        assert.equal(asked(calls), 0, 'the words after the time do not send it to the model (which rounds to 17:00)');
    });
}

test('typed "I wait until 17:15" with no bracket: the tracker reads it as 17:00; the player\'s own time wins', async () => {
    const { c } = boot({ tracker: { place: null, people: [], wait: { duration: '', until: '17:00', sleep: false, reason: 'waiting for the coach' } } });
    say(c, 'I wait at the window until 17:15 for the coach.', { worldscrawl_intent_checked: true });
    const id = reply(c, 'The afternoon drags on. At last the coach rattles into the square.');
    await D.onReplyForFlags(id);
    assert.equal(c.chat[id].extra[WAIT]?.until, '17:15', JSON.stringify(c.chat[id].extra[WAIT]));
    assert.equal(clock(c), '17:15');
    assert.ok(notes(c.chat[id]).some(x => x.kind === 'tracker wait' && /until 17:15 from the player's line/.test(x.reason)), JSON.stringify(notes(c.chat[id])));
});

test('a tracker wait with no clock time on the player\'s line keeps the tracker\'s own reading', async () => {
    const { c } = boot({ tracker: { place: null, people: [], wait: { duration: '', until: '17:00', sleep: false, reason: 'until evening' } } });
    say(c, 'I wait for the evening crowd.', { worldscrawl_intent_checked: true });
    const id = reply(c, 'The light goes amber; the crowd starts to drift in.');
    await D.onReplyForFlags(id);
    assert.equal(clock(c), '17:00');
});

test('the narrator\'s wait tag "until 17:15" plans 17:15', async () => {
    const { c } = boot();
    const t = parseWaitTag('until 17:15 | the coach is late');
    const w = await W.planWait(waitArgs({ until: t.args.replace(/^until\s+/, '') }), t.sleep, t.reason);
    assert.equal(w.until, '17:15');
    assert.equal(calendarLib.dateAt(chatElapsed(c.chat) + w.seconds, worldTimes.get('riverton')?.start_date ?? null, worldTimes.get('riverton')?.calendar ?? null).time, '17:15');
});

test('the wait card\'s Approve edited with "until 17:15" lands on 17:15', async () => {
    const { c } = boot({ autoKeepWaits: false, tracker: { place: null, people: [], wait: { duration: '2h', until: '', sleep: false, reason: 'a long nap' } } });
    say(c, 'I nap in the corner.', { worldscrawl_intent_checked: true });
    const id = reply(c, 'You doze off by the fire.');
    await D.onReplyForFlags(id);
    assert.ok(c.chat[id].extra.worldscrawl_waitcard ?? Object.keys(c.chat[id].extra).some(k => /waitcard/.test(k)), JSON.stringify(Object.keys(c.chat[id].extra)));
    assert.equal(chatElapsed(c.chat), 0, 'a card, not kept yet');
    await W.keepWait(id, 'until 17:15');
    assert.equal(clock(c), '17:15');
});
