// R6 F3: the Remember answer's budget (1200 tokens) and its failure path, through the real handlers: a real world
// server behind the fetch shim, the real Remember card drawn with fakedom (offerRemember, renderPatchCards, card clicks
// through cardacts), and a fake model. A cut-off, unparseable, empty or failed answer never saves anyone: the card
// shows "Could not prepare the card." with Check again, and an Approve that waited for it is undone.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, clientDir } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { callNotes } = await import('../../extension/calllog.mjs');
const { decisionOf } = await import('../../extension/notices.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();
const { NPC_KEY } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN;
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
let server = null;
const toasts = [];
function boot() {
    exitsCache.clear();
    if (!server) { const d = tmpPath(); copytree(path.dirname(RIVERTON), d); server = clientDir(d); }
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    toasts.length = 0;
    globalThis.toastr = { info: t => toasts.push(['info', t]), success: t => toasts.push(['success', t]), warning: t => toasts.push(['warning', t]), error: t => toasts.push(['error', t]) };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time: '10:00' };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext();
    c.chatId = 'r6rem'; c.getCurrentChatId = () => 'r6rem';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'The common room is quiet.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: BAR } }];
    return c;
}
const reply = (c, text) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }; c.chat.push(m); return m; };
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
function draw(ids) { const doc = makeDoc(ids); globalThis.document = doc; renderPatchCards(); return doc; }
const remEl = doc => doc.querySelector('.worldscrawl_remembercard');
const stampsOf = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === type);
const isRemember = p => /Remember this person/.test(p);
const MAREN = { name: 'Maren', personality: { summary: 'A knife-grinder who works for Hesk.', manner: 'Brisk.', speech: 'Clipped.' }, appearance: { summary: 'wiry woman with a whetstone' }, facts: [], invented: [] };
const FULL = JSON.stringify(MAREN);
/** The answers that are not a usable person: cut off by the budget, not JSON, empty, and a model error. */
const BAD = { 'cut off': FULL.slice(0, 70), 'not JSON': 'Maren is a knife-grinder.', empty: '', 'model error': new Error('the server is down') };
const gateOf = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
/** The fake model: `remember(n)` answers the nth Remember call (an Error is thrown); a gate holds Remember answers back. */
function fakeModel(c, { remember = () => FULL, gate = null } = {}) {
    const calls = { remember: [], other: [] };
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (isRemember(p)) {
            calls.remember.push(args);
            if (gate) await gate.promise;
            const a = remember(calls.remember.length);
            if (a instanceof Error) throw a;
            return a;
        }
        calls.other.push(args);
        if (/^Choose a daily pattern for /.test(p)) return JSON.stringify({ pattern: 'day shift', job: BAR, job_activity: 'grinding knives', home: null, favorites: [] });
        return '{"place": null, "people": [], "wait": null}';
    };
    return calls;
}
async function rememberCard(opts = {}) {
    const c = boot();
    const calls = fakeModel(c, opts);
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    const doc = draw([0, 1]);
    await flush(80);
    return { c, calls, doc, card: () => c.chat[1].extra[scene.REMEMBER_KEY] };
}
const failedCard = (el, why) => {
    assert.equal(el.dataset.state, 'failed', why);
    assert.match(el.textContent, /Could not prepare the card\./, why);
    assert.deepEqual(btns(el), ['Check again', 'Discard'], `${why}: no Approve on a failed card`);
};

test('R6 F3: the Remember question (the prefetch and Check again) may answer up to 1200 tokens', async () => {
    const { calls, doc } = await rememberCard({ remember: n => (n === 1 ? FULL : FULL) });
    assert.equal(remEl(doc).dataset.state, 'review');
    byText(remEl(doc), 'Check again').click();
    await flush(80);
    assert.equal(calls.remember.length, 2);
    assert.deepEqual(calls.remember.map(a => a.responseLength), [1200, 1200]);
});

for (const [what, bad] of Object.entries(BAD)) {
    test(`R6 F3: a Remember answer that is ${what} shows on the card as failed (both tries), saves nobody, and Check again recovers`, async () => {
        const { c, calls, doc, card } = await rememberCard({ remember: n => (n <= 2 ? bad : FULL) });
        assert.equal(calls.remember.length, 2, 'two tries');
        failedCard(remEl(doc), what);
        assert.deepEqual(card().proposal, { name: 'Maren', failed: true });
        assert.ok(callNotes(c.chat[1]).some(n => /remember/.test(n.kind) && n.status === 'failed'), 'the call note says failed');
        assert.equal(stampsOf(c.chat[1], 'npc_create').length, 0);
        byText(remEl(doc), 'Check again').click();
        await flush(80);
        assert.equal(remEl(doc).dataset.state, 'review');
        byText(remEl(doc), 'Approve').click();
        await flush(80);
        assert.equal(card().status, 'kept');
        assert.equal(stampsOf(c.chat[1], 'npc_create').length, 1);
    });
}

test('R6 F3: Approve clicked while the answer is on its way, and the answer fails: nothing is saved, the card shows the failure, the Approve is undone', async () => {
    const gate = gateOf();
    const { c, calls, doc, card } = await rememberCard({ gate, remember: n => (n <= 2 ? BAD['cut off'] : FULL) });
    byText(remEl(doc), 'Approve').click();
    await flush(40);
    assert.match(remEl(doc).textContent, /Saving…/);
    gate.release();
    await flush(120);
    assert.equal(calls.remember.length, 2, 'Approve waited for the call in flight and asked no third time');
    assert.equal(stampsOf(c.chat[1], 'npc_create').length, 0, 'no stand-in person');
    assert.ok(!(scene.castPack()?.npcs ?? []).some(n => /Maren/.test(n.name ?? '')), 'Maren is not in the cast');
    assert.equal(card().status, 'review', 'the card is still open');
    assert.equal(decisionOf(c.chat[1], card().nid) ?? null, null, 'the Approve decision is undone');
    // The live card (no manual redraw): keepRememberNow's own redraw takes it out of Saving… into failed.
    failedCard(remEl(doc), 'the live card after a failed Approve');
    assert.doesNotMatch(remEl(doc).textContent, /Saving…/);
    const el = remEl(draw([0, 1]));
    failedCard(el, 'after a failed Approve, drawn again');
    assert.ok(toasts.some(([k, t]) => k === 'warning' && t === "WorldScrawl: could not prepare Maren's card, so nothing was saved. Use Check again on the card."), JSON.stringify(toasts));
    assert.ok(!toasts.some(([k]) => k === 'success'), 'no "remembered" toast');
    // Check again, then Approve: saved for real.
    byText(el, 'Check again').click();
    await flush(80);
    byText(remEl(globalThis.document), 'Approve').click();
    await flush(80);
    assert.equal(card().status, 'kept');
    assert.equal(stampsOf(c.chat[1], 'npc_create').length, 1);
});

test('R6 F3: Approve with no card drawn (keepRemember asks itself) and a failed answer saves nobody and leaves the card failed', async () => {
    const c = boot();
    const calls = fakeModel(c, { remember: () => BAD['model error'] });
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    await scene.keepRemember(1);
    assert.equal(calls.remember.length, 2);
    const card = c.chat[1].extra[scene.REMEMBER_KEY];
    assert.equal(card.status, 'review');
    assert.deepEqual(card.proposal, { name: 'Maren', failed: true });
    assert.equal(stampsOf(c.chat[1], 'npc_create').length, 0);
    failedCard(remEl(draw([0, 1])), 'no card drawn');
});
