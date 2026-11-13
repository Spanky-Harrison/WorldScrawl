// B6: the next turn waits (capped, shown on the busy line) for the last reply's tracker, and reads its [brackets] from
// the turn's player line. Through the real handlers: onReplyForFlags -> runTracker (a fake model held at a gate), the
// generation interceptor, the busy line (work.mjs).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const D = await import('../../extension/discovery.mjs');
const { busyLines } = await import('../../extension/work.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar, chatElapsed } = await import('../../extension/clock.mjs');
await loadCalendar();
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const LOC = 'worldscrawl_location', WAIT = 'worldscrawl_wait', TRACKED = 'worldscrawl_tracked';
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
function gate() { let release; const p = new Promise(r => { release = r; }); return { p, release }; }
const TRACKER_Q = /Reply with JSON only:\n\{"place"/;

let n = 0;
/** A chat with one reply whose tracker is held at a gate; `answer` is what it says when released (or a function that throws). */
function boot({ answer = { place: null, people: [], wait: { duration: '2 hours', reason: 'they wait out the rain' } } } = {}) {
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
    const c = SillyTavern.getContext(), id = `tw${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    const g = gate();
    c.generateRaw = async args => {
        if (!TRACKER_Q.test(String(args?.prompt ?? ''))) return '{}';
        await g.p;
        if (typeof answer === 'function') return answer();
        return JSON.stringify(answer);
    };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: 'buttons' });
    D.TRACKER_WAIT.cap = 25000;
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, [LOC]: TAVERN } },
        { is_user: true, mes: 'I sit by the window.', swipe_id: 0, extra: { worldscrawl_intent_checked: true } },
        { is_user: false, mes: 'Rain drums on the shutters. You sit and watch it for a long while.', swipe_id: 0, swipes: ['x'], swipe_info: [{ extra: {} }], extra: {} }];
    const tracking = D.onReplyForFlags(2); // the reply arrived: its tracker starts and is held
    return { c, g, tracking };
}
const say = (c, text, extra = { worldscrawl_intent_checked: true }) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const intercept = (type = 'normal') => globalThis.worldscrawlInterceptor([], 0, () => {}, type);
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
async function tracking(c) { for (let i = 0; i < 100 && c.chat[2].extra?.[TRACKED]?.status !== 'tracking'; i++) await flush(5); }

test('the next turn waits for the last reply\'s tracker: its auto-kept wait is in the turn\'s time; the busy line says so while it waits', async () => {
    const { c, g, tracking: t } = boot();
    await tracking(c);
    say(c, 'I keep watching.');
    let done = false, at = null;
    const turn = intercept().then(() => { done = true; at = chatElapsed(c.chat); });
    await flush(60);
    assert.equal(done, false, 'the turn waits');
    assert.deepEqual(busyLines(), ["finishing the last reply's check"]);
    g.release();
    await turn; await t;
    assert.equal(c.chat[2].extra[WAIT]?.seconds, 7200, 'the tracked wait is on the reply it came from');
    assert.equal(at, 7200, 'the turn was built after it');
    assert.deepEqual(busyLines(), []);
});

test('at the cap the turn goes ahead without it (noted on that reply); the late answer still lands on that reply', async () => {
    const { c, g, tracking: t } = boot();
    await tracking(c);
    D.TRACKER_WAIT.cap = 150;
    const p = say(c, 'I keep watching.');
    const t0 = Date.now();
    await intercept();
    assert.ok(Date.now() - t0 < 2000, 'no hang');
    assert.equal(chatElapsed(c.chat), 0, 'built without the wait');
    assert.ok(notes(c.chat[2]).some(x => x.kind === 'tracker' && x.status === 'skipped' && /still running; the reply went ahead without it/.test(x.reason)), JSON.stringify(notes(c.chat[2])));
    assert.deepEqual(busyLines(), []);
    g.release(); await t;
    assert.equal(c.chat[2].extra[WAIT]?.seconds, 7200, 'the late wait is kept on the reply it came from');
    assert.equal(c.chat[p].extra[WAIT], undefined, 'not on the new player line');
    assert.ok(['tracked', 'carded'].includes(c.chat[2].extra[TRACKED]?.status), 'the marker ends on that reply');
});

test('a tracker that fails does not block the turn', async () => {
    const { c, g, tracking: t } = boot({ answer: () => { throw new Error('model down'); } });
    await tracking(c);
    say(c, 'I keep watching.');
    g.release();
    await intercept(); await t;
    assert.equal(c.chat[2].extra[TRACKED]?.status, 'failed');
    assert.equal(chatElapsed(c.chat), 0);
});

test('Stop ends the wait and the turn does nothing more (its [bracket] is left unread)', async () => {
    const { c, g, tracking: t } = boot();
    await tracking(c);
    const p = say(c, 'I [wait] 1 hour.', {});
    const turn = intercept();
    await flush(40);
    D.stopTrackerWait();
    await turn;
    assert.equal(c.chat[p].extra.worldscrawl_intent_checked, undefined, 'the bracket was not handled');
    assert.equal(c.chat[p].extra[WAIT], undefined);
    assert.deepEqual(busyLines(), []);
    g.release(); await t;
});

test('regenerate and swipe never wait for the reply being thrown away; its late answer stamps nothing', async () => {
    const { c, g, tracking: t } = boot();
    await tracking(c);
    const gone = c.chat[2];
    c.chat.splice(2, 1); // regenerate: SillyTavern deleted the reply before building the prompt
    const t0 = Date.now();
    await intercept('regenerate');
    assert.ok(Date.now() - t0 < 500, 'no wait');
    g.release(); await t;
    assert.equal(gone.extra[WAIT], undefined, 'no stamp on the deleted reply');
    assert.equal(chatElapsed(c.chat), 0);

    const s = boot();
    await tracking(s.c);
    const t1 = Date.now();
    await intercept('swipe'); // the reply being swiped is the last message: not waited for
    assert.ok(Date.now() - t1 < 500);
    s.c.chat[2].swipe_id = 1; s.c.chat[2].mes = 'A new swipe.';
    s.g.release(); await s.tracking;
    assert.equal(s.c.chat[2].extra[WAIT], undefined, 'the old swipe\'s answer is dropped');
});

// ---- (d) brackets from the turn's player line
for (const [label, after] of [
    ['a WorldScrawl notice', { name: 'WorldScrawl', is_user: false, is_system: true, mes: '[Engine: x]', extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'text' } }],
    ['a /sys line', { name: 'System', is_user: false, is_system: true, mes: 'A system line.', extra: {} }],
    ['a /hide\'d line', { name: 'You', is_user: true, is_system: true, mes: 'A hidden line.', extra: {} }],
]) {
    test(`a [wait] on the turn's player line is read with ${label} after it`, async () => {
        const { c, g, tracking: t } = boot({ answer: { place: null, people: [], wait: null } });
        g.release(); await t;
        const p = say(c, 'I [wait] 2 hours.', {});
        c.chat.push(after);
        await intercept();
        assert.equal(c.chat[p].extra[WAIT]?.seconds, 7200, JSON.stringify(c.chat[p].extra));
        assert.equal(c.chat[p].extra.worldscrawl_intent_checked, true);
    });
}

test('a group\'s later member: no turn line, no bracket handling', async () => {
    const { c, g, tracking: t } = boot({ answer: { place: null, people: [], wait: null } });
    g.release(); await t;
    const p = say(c, 'I [wait] 2 hours.', {});
    c.chat.push({ is_user: false, name: 'Member one', mes: 'First member answers.', swipe_id: 0, swipes: ['x'], swipe_info: [{ extra: {} }], extra: {} });
    await intercept();
    assert.equal(c.chat[p].extra[WAIT], undefined);
    assert.equal(c.chat[p].extra.worldscrawl_intent_checked, undefined);
});
