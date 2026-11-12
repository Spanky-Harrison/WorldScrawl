// Check again on the expiry notice (a failed appearance rebuild after a temporary change ran out) and the small
// "tracking…" / "tracked" marker under the latest reply, through the production paths: the generation interceptor,
// the after-reply hook (onReplyForFlags), a swipe (onStorySwipe), the in-process map server, a stubbed model, and the
// shared card layer's buttons.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { onReplyForFlags, onStorySwipe } = await import('../../extension/discovery.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { NPC_KEY, npcAt } = await import('../../extension/npc.mjs');
const { NPC_EXPIRED_KIND } = await import('../../extension/npcexpiry.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));

globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

let chats = 0;
function boot() {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] });
    const c = SillyTavern.getContext();
    const id = `rt${++chats}`;
    exitsCache.clear();
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    c.addOneMessage = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    ext.settings().flagTags = true; ext.settings().flagNpcs = true; ext.settings().autoKeepWaits = false;
    return { c, blocks };
}
const isTracker = p => /Reply with JSON only:\n\{"place"/.test(p);
const user = (mes, extra = {}) => ({ is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true, ...extra } });
const reply = mes => ({ is_user: false, mes, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra: {} });
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const mesEl = (doc, id) => doc.querySelectorAll('.mes').find(m => m.getAttribute('mesid') === String(id));
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);

// ---- 1. Check again on the expiry notice
/** Hesk: a gnoll for an hour, and a scar for good on top; then the player waits two hours (the gnoll runs out, so
 *  the scar has to be written again on her own body: one model call). */
function heskChat() {
    const own = (owner, intent, lasts) => ({ swipe: 0, type: 'npc_appearance', id: 'hesk', intent, owner, start: 0, lasts, contentId: `c_${owner}`, candidate: null,
        identity: { owner, message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent, fields: 'body', layer: {} } });
    return [
        user('I step into the inn.', { worldscrawl_move: { to: TAVERN } }),
        { ...reply('A flash: Hesk turns into a gnoll, and a beam scars her cheek.'), extra: { worldscrawl_mid: 'm', [NPC_KEY]: [
            { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
            { swipe: 0, type: 'npc_appear', id: 'hesk', at: TAVERN },
            own('og', 'turned into a gnoll', 60), own('os', 'a scar across her cheek', null),
        ] } },
        user('I [wait] two hours.', { worldscrawl_wait: { seconds: 7200 } }),
    ];
}
test('a failed rebuild after an expiry: the notice shows the failure and Check again; no second card; Check again rebuilds and refreshes the facts', async () => {
    const { c, blocks } = boot();
    c.chat = heskChat();
    let fail = true, calls = 0;
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (/Looks line/.test(p)) return '{"looks":"a scarred landlady"}';
        if (isTracker(p)) return '{"place": null, "people": [], "wait": null}';
        calls++;
        if (fail) throw new Error('backend down');
        return '{"body":"sturdy, a scar across her cheek","outfit":"wool"}';
    };
    await globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');
    assert.equal(calls, 2, 'the rebuild was asked (two tries) and failed');
    const host = 2, job = scene.appearJobs(c.chat[host]).find(j => j.id === 'hesk');
    assert.equal(job?.status, 'failed');
    const noticeAt = c.chat.findIndex(m => m.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND);
    assert.equal(noticeAt, host + 1, 'the expiry notice sits right after the player message');
    let doc = draw(c);
    const notice = mesEl(doc, noticeAt).querySelector('.worldscrawl_npcexpired');
    assert.ok(notice, 'the expiry card');
    assert.match(notice.textContent, /A temporary change ran out/);
    assert.match(notice.textContent, /Appearance rebuild for Hesk failed\. backend down/);
    assert.deepEqual(btns(notice), ['Check again', 'Edit']);
    assert.equal(mesEl(doc, host).querySelector('.worldscrawl_appearpending'), null, 'no second card on the player message');
    // Double click: the shared layer locks the row; one rebuild.
    fail = false;
    const b = byText(notice, 'Check again');
    b.click(); b.click();
    for (let i = 0; i < 50 && scene.appearJobs(c.chat[host]).length; i++) await flush(10);
    await flush(30);
    assert.equal(calls, 3, 'one more call, not two');
    assert.equal(scene.appearJobs(c.chat[host]).length, 0, 'the failure is cleared');
    assert.equal(npcAt(c.chat, c.chat.length - 1, [HESK], 'hesk', i => scene.npcClock(c.chat, i)).body, 'sturdy, a scar across her cheek');
    assert.match(blocks.worldscrawl_facts ?? '', /a scar across her cheek/, 'the narrator facts were refreshed');
    doc = draw(c);
    const after = mesEl(doc, noticeAt).querySelector('.worldscrawl_npcexpired');
    assert.doesNotMatch(after.textContent, /failed/);
    assert.deepEqual(btns(after), ['Edit']);
});

test('a failed rebuild with no expiry notice after it keeps its own job card (Check again)', async () => {
    const { c } = boot();
    c.chat = heskChat();
    c.generateRaw = async () => { throw new Error('backend down'); };
    await scene.ensureAppearanceRebuilds(2);
    assert.equal(scene.appearJobs(c.chat[2]).find(j => j.id === 'hesk')?.status, 'failed');
    const doc = draw(c);
    const card = mesEl(doc, 2).querySelector('.worldscrawl_appearpending');
    assert.ok(card);
    assert.match(card.textContent, /Appearance rebuild for hesk failed\. backend down/i);
    assert.deepEqual(btns(card), ['Check again']);
});

// ---- 2. the tracked marker
const mark = (doc, id) => mesEl(doc, id)?.querySelector('.worldscrawl_trackmark')?.textContent ?? '';
function trackerModel(c, answer) {
    const reads = [];
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (isTracker(p)) { reads.push(p); return typeof answer === 'function' ? answer(p) : answer; }
        return '{}';
    };
    return reads;
}
const NOTHING = '{"place": null, "people": [], "wait": null}';

test('tracking… while the tracker reads, then tracked with nothing to add; only on the latest reply; survives a reload', async () => {
    const { c } = boot();
    let release;
    const gate = new Promise(r => { release = r; });
    trackerModel(c, () => gate.then(() => NOTHING));
    c.chat = [user('I step in.', { worldscrawl_move: { to: TAVERN } }), reply('A smoky bar.')];
    const reading = onReplyForFlags(1);
    await flush(30);
    assert.equal(mark(draw(c), 1), 'tracking…');
    release();
    await reading;
    let doc = draw(c);
    assert.equal(mark(doc, 1), 'tracked');
    assert.match(mesEl(doc, 1).querySelector('.worldscrawl_trackmark').title, /nothing to add/);
    assert.deepEqual(c.chat[1].swipe_info[0].extra.worldscrawl_tracked, { swipe: 0, status: 'tracked' }, 'mirrored to the swipe');
    // The next exchange: the marker moves to the newest reply.
    trackerModel(c, NOTHING);
    c.chat.push(user('I order a drink.'), reply('The barkeep pours.'));
    await onReplyForFlags(3);
    doc = draw(c);
    assert.equal(mark(doc, 1), '', 'older replies show nothing');
    assert.equal(mark(doc, 3), 'tracked');
    // A reload: the stored state comes back as it was.
    c.chat = JSON.parse(JSON.stringify(c.chat));
    assert.equal(mark(draw(c), 3), 'tracked');
});

test('a read in flight when the page reloads shows nothing afterwards (tracking… is live only)', async () => {
    const { c } = boot();
    let release;
    const gate = new Promise(r => { release = r; });
    trackerModel(c, () => gate.then(() => NOTHING));
    c.chat = [user('I step in.', { worldscrawl_move: { to: TAVERN } }), reply('A smoky bar.')];
    const reading = onReplyForFlags(1);
    await flush(30);
    assert.equal(mark(draw(c), 1), 'tracking…');
    const live = c.chat;
    c.chat = JSON.parse(JSON.stringify(c.chat)); // the reloaded chat: new message objects, nothing in flight
    assert.equal(mark(draw(c), 1), '');
    c.chat = live; release(); await reading; // let the old read end (it ran for the page that is gone)
});

test('a tracker card replaces the marker', async () => {
    const { c } = boot();
    trackerModel(c, '{"place": null, "people": [], "wait": {"duration": "45m", "reason": "a long meal"}}');
    c.chat = [user('I eat.', { worldscrawl_move: { to: TAVERN } }), reply('You eat a long meal.')];
    await onReplyForFlags(1);
    const doc = draw(c);
    assert.ok(c.chat[1].extra.worldscrawl_waitcard, 'the wait card');
    assert.ok(mesEl(doc, 1).querySelector('.worldscrawl_patchcard'));
    assert.equal(mark(doc, 1), '');
});

test('skipped reads show nothing: a greeting, a slash command', async () => {
    const { c } = boot();
    const reads = trackerModel(c, NOTHING);
    c.chat = [reply('Welcome, traveler.')];
    await onReplyForFlags(0);
    assert.equal(reads.length, 0);
    assert.equal(mark(draw(c), 0), '');
    c.chat = [user('/sys hi', { worldscrawl_move: { to: TAVERN } }), reply('Hi.')];
    await onReplyForFlags(1);
    assert.equal(reads.length, 0);
    assert.equal(mark(draw(c), 1), '');
});

test('a failed read says so, muted', async () => {
    const { c } = boot();
    trackerModel(c, () => { throw new Error('backend down'); });
    c.chat = [user('I step in.', { worldscrawl_move: { to: TAVERN } }), reply('A smoky bar.')];
    await onReplyForFlags(1);
    const doc = draw(c), el = mesEl(doc, 1).querySelector('.worldscrawl_trackmark');
    assert.equal(el.textContent, 'tracking failed');
    assert.match(el.style.cssText, /opacity/);
});

test('a swipe starts over: nothing while the new swipe is written, then its own marker', async () => {
    const { c } = boot();
    trackerModel(c, NOTHING);
    const r = reply('Old telling.');
    c.chat = [user('I step in.', { worldscrawl_move: { to: TAVERN } }), r];
    await onReplyForFlags(1);
    assert.equal(mark(draw(c), 1), 'tracked');
    r.swipe_id = 1; // SillyTavern while it writes the new swipe
    await onStorySwipe(1);
    assert.equal(mark(draw(c), 1), '', 'the old swipe\'s marker is gone');
    r.swipes.push('New telling.'); r.mes = 'New telling.'; r.swipe_info.push({ extra: {} });
    trackerModel(c, () => { throw new Error('backend down'); });
    await onReplyForFlags(1);
    assert.equal(mark(draw(c), 1), 'tracking failed', 'the new swipe has its own state');
});
