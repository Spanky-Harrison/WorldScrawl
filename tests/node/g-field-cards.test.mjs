// 4-G: one person card per person per field (Body and Outfit separate) per message. Through the real handlers:
// onReplyForFlags -> runTracker -> applyTrackerResult -> applyPersonStamps -> makeOwner -> fillCandidate -> the compose
// call (a fake model routed by isTrackerCall and the prompt), renderPatchCards on fakedom with real clicks (Approve,
// Discard, the scope switch) through cardacts -> settleNpc -> decideNpc -> recompose / Looks.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const D = await import('../../extension/discovery.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar } = CLK;
await loadCalendar();
const { onReplyForFlags, mergeFieldItems } = D;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const NPC = 'worldscrawl_npc';
const LIGHT_SYS = /^You make a small edit to a person's body or clothes/;
const FULL_SYS = /^You rewrite a person's body and clothes/;

let n = 0;
/** A fresh Riverton chat at 17:00 in the common room (Hesk, "the landlady", at the bar). `tracker`: the tracker's
 *  answer (a function: built at call time). `compose(fields, base)`: the compose answer for the asked fields (default:
 *  each asked field's base with "[field changed]" added, which keeps the light-touch check happy). Every compose call is
 *  recorded as {system, prompt, fields}; Looks calls are counted. */
function boot({ tracker = null, compose = null } = {}) {
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
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time: '17:00' };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext(), id = `g${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    const calls = [], looks = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), system = String(args?.systemPrompt ?? '');
        if (isTrackerCall(args)) { const a = typeof tracker === 'function' ? tracker() : tracker; return typeof a === 'string' ? a : JSON.stringify(a ?? { place: null, people: [], wait: null }); }
        if (/Looks line/.test(prompt)) { looks.push(prompt); return '{"looks":"a big woman with copper braids"}'; }
        const base = Object.fromEntries([...prompt.matchAll(/^- (body|outfit): (.*)$/gm)].map(m => [m[1], m[2]]));
        const fields = Object.keys(base);
        calls.push({ system, prompt, fields });
        const out = compose ? compose(fields, base, prompt) : Object.fromEntries(fields.map(f => [f, `${base[f]} [${f} changed]`]));
        return JSON.stringify(out);
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    const s = ext.settings();
    delete s.trackerRetry; delete s.trackerRetryCount;
    Object.assign(s, { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'Evening in the common room. The landlady pours ale.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, calls, looks };
}
const flush = (ms = 40) => new Promise(r => setTimeout(r, ms));
async function exchange(c, player, story) {
    c.chat.push({ is_user: true, mes: player, swipe_id: 0, extra: { worldscrawl_intent_checked: true } });
    c.chat.push({ is_user: false, mes: story, swipe_id: 0, swipes: [story], swipe_info: [{ extra: {} }], extra: {} });
    const id = c.chat.length - 1;
    globalThis.document = makeDoc(c.chat.map((_, i) => i));
    await onReplyForFlags(id); await flush();
    return id;
}
const owners = (m) => (m.extra?.[NPC] ?? []).filter(s => s.type === 'npc_appearance');
const ownerOf = (m, field) => owners(m).find(s => (s.candidate?.fields ?? s.committed?.fields) === field);
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const cardsOf = (doc, id) => [...(doc.querySelector(`.mes[mesid="${id}"]`)?.querySelectorAll('.worldscrawl_npcpending') ?? [])];
const cardFor = (doc, id, title) => cardsOf(doc, id).find(e => e.textContent.includes(title));
const btn = (el, t) => (el?.querySelectorAll('.worldscrawl_card_btn') ?? []).find(b => b.textContent === t);
const item = (h, fields, extra = {}) => ({ id: h, action: 'appearance', intent: 'soaked by the rain', fields, lasts: '', scope: 'light', why: 'one detail', ...extra });
/** Route tracker calls to a fixed answer; everything else to `gen`. */
function withTracker(gen, answer) {
    return async args => (isTrackerCall(args) ? JSON.stringify(answer) : gen(args));
}
async function heskHandle(c) { await exchange(c, 'I nod.', 'The landlady nods back.'); return (await import('../../extension/names.mjs')).handleOf('hesk'); }
const SOAK = 'The landlady comes in from the yard, soaked by the rain, her braids dripping.';

test('one tracker item for Body and Outfit: two owners and two cards, each asked its own field; approving Outfit leaves Body pending', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body, outfit')], wait: null });
    const id = await exchange(c, 'I wait by the fire.', SOAK);
    const os = owners(c.chat[id]);
    assert.deepEqual(os.map(o => o.candidate.fields).sort(), ['body', 'outfit'], 'one owner per field');
    for (const o of os) { assert.equal(o.candidate.intent, 'soaked by the rain'); assert.equal(o.candidate.phase, 'review'); assert.equal(o.candidate.scope, 'light'); }
    assert.equal(calls.length, 2, 'two compose calls');
    assert.deepEqual(calls.map(x => x.fields.join(',')).sort(), ['body', 'outfit'], 'each call asks one field');
    assert.match(calls.find(x => x.fields[0] === 'body').prompt, /^Edit body for /);
    assert.match(calls.find(x => x.fields[0] === 'outfit').prompt, /^Edit outfit for /);
    const body = ownerOf(c.chat[id], 'body'), outfit = ownerOf(c.chat[id], 'outfit');
    assert.equal(body.candidate.lastingPreview.outfit, body.candidate.lastingBefore.outfit, 'the Body card leaves the outfit as it is');
    assert.equal(outfit.candidate.lastingPreview.body, outfit.candidate.lastingBefore.body, 'the Outfit card leaves the body as it is');
    let doc = draw(c);
    assert.equal(cardsOf(doc, id).length, 2);
    const oc = cardFor(doc, id, 'Outfit: Proposed person change:'), bc = cardFor(doc, id, 'Body: Proposed person change:');
    assert.ok(oc && bc, cardsOf(doc, id).map(e => e.textContent).join(' || '));
    assert.ok(!/Hesk: no change/.test(oc.textContent));
    const labels = el => (el.querySelectorAll('.wsdiff-label') ?? []).map(x => x.textContent);
    assert.deepEqual(labels(oc), ['Outfit'], 'the Outfit card\'s panel shows the Outfit only');
    assert.deepEqual(labels(bc), ['Body']);
    btn(oc, 'Approve').click(); await flush(80);
    assert.ok(outfit.committed, 'Outfit kept');
    assert.equal(outfit.committed.fields, 'outfit');
    assert.ok(!body.committed && body.candidate?.phase === 'review', 'Body still pending');
    doc = draw(c);
    assert.ok(cardFor(doc, id, 'Body: Proposed person change:'));
    assert.ok(!cardFor(doc, id, 'Outfit: Proposed person change:'));
});

test('a heavy Body item and a light Outfit item: Body uses the rewrite prompt, Outfit the light edit (B8)', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body', { intent: 'turned into a gnoll', scope: 'full', why: 'her whole body' }), item(H, 'outfit', { intent: 'apron torn' })], wait: null });
    const id = await exchange(c, 'I stare.', 'The landlady shudders and becomes a gnoll; her apron tears.');
    assert.equal(owners(c.chat[id]).length, 2);
    const b = calls.find(x => x.fields.join() === 'body'), o = calls.find(x => x.fields.join() === 'outfit');
    assert.ok(b && o, JSON.stringify(calls.map(x => x.fields)));
    assert.match(b.system, FULL_SYS);
    assert.match(b.prompt, /^Rewrite body for /);
    assert.match(o.system, LIGHT_SYS);
    assert.match(o.prompt, /^Edit outfit for /);
    assert.doesNotMatch(o.prompt, /gnoll/, 'the Outfit call does not carry the Body change');
});


test('two Outfit items for one person in one reply: one card with the merged intent and one compose call', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'hem soaked', lasts: '1h' }), item(H, 'outfit', { intent: 'apron torn', lasts: '3h', scope: 'full', why: 'the apron is ruined' })], wait: null });
    const id = await exchange(c, 'I watch.', 'The landlady comes in with her hem soaked and her apron torn.');
    const os = owners(c.chat[id]);
    assert.equal(os.length, 1, 'one card');
    assert.equal(os[0].candidate.intent, 'hem soaked; apron torn');
    assert.equal(os[0].candidate.scope, 'heavy', 'full if either is full');
    assert.equal(os[0].candidate.why, 'the apron is ruined', 'the full one\'s why');
    assert.equal(os[0].candidate.proposedLasts, 180, 'the longer lasts');
    assert.equal(calls.filter(x => x.fields.join() === 'outfit').length, 1, 'one compose call for the live text (lasting is the base)');
    assert.equal(cardsOf(draw(c), id).length, 1);
});

test('mergeFieldItems: intents joined, full wins with its why, the longer lasts, permanent if either is', () => {
    const a = { id: 'x', intent: 'a', scope: 'light', why: 'wa', lasts: '2h', fields: 'body' };
    assert.deepEqual(mergeFieldItems(a, { intent: 'b', scope: 'light', why: 'wb', lasts: '30m' }), { ...a, intent: 'a; b', scope: 'light', why: 'wa', lasts: '120m' });
    assert.equal(mergeFieldItems(a, { intent: 'b', lasts: '' }).lasts, '', 'permanent if either is');
    assert.equal(mergeFieldItems(a, { intent: 'a', lasts: '1h' }).intent, 'a', 'the same intent once');
    const m = mergeFieldItems(a, { intent: 'b', scope: 'full', why: 'big' });
    assert.equal(m.scope, 'full'); assert.equal(m.why, 'big');
});

test('the scope switch on the Body card re-asks Body only; the Outfit card is untouched', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    const outfit = ownerOf(c.chat[id], 'outfit'), body = ownerOf(c.chat[id], 'body');
    const tok = outfit.candidate.token;
    calls.length = 0;
    const bc = cardFor(draw(c), id, 'Body: Proposed person change:');
    btn(bc, 'Make it a full rewrite').click(); await flush(80);
    assert.equal(body.candidate.scope, 'heavy');
    assert.equal(calls.length, 1, 'one call');
    assert.deepEqual(calls[0].fields, ['body']);
    assert.match(calls[0].system, FULL_SYS);
    assert.equal(outfit.candidate.token, tok, 'the Outfit card is not asked again');
    assert.equal(outfit.candidate.scope, 'light');
});

test('Looks is rebuilt once: after both cards are approved, and after one approval when the other card is discarded', async () => {
    {
        const { c, calls, looks } = boot({});
        const H = await heskHandle(c);
        calls.length = 0;
        c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
        const id = await exchange(c, 'I wait.', SOAK);
        const composeCalls = calls.length;
        assert.equal(composeCalls, 2, 'both fields change: two compose calls');
        looks.length = 0; calls.length = 0;
        const outfit = ownerOf(c.chat[id], 'outfit');
        const composed = outfit.candidate.lastingPreview.outfit;
        btn(cardFor(draw(c), id, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
        const body = ownerOf(c.chat[id], 'body');
        assert.ok(body.committed);
        assert.equal(looks.length, 0, 'Looks waits for the Outfit card');
        // Review round 1: keeping Body does not make the Outfit card stale; one Approve keeps its composed text, no call.
        btn(cardFor(draw(c), id, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
        assert.ok(outfit.committed, 'kept on the first Approve');
        assert.equal(calls.length, 0, 'no third compose call: two in all');
        const live = (await import('../../extension/npc.mjs')).npcAt(c.chat, c.chat.length - 1, (await import('../../extension/scene.mjs')).castPack().npcs, 'hesk');
        assert.equal(live.outfit, composed, 'the outfit is the text the card showed');
        assert.match(live.body, /\[body changed\]$/, 'the body is the kept Body card\'s');
        assert.equal(looks.length, 1, 'one looks summary after the last card');
        assert.match(looks[0], /\[body changed\]/); assert.match(looks[0], /\[outfit changed\]/);
    }
    {
        const { c, looks } = boot({});
        const H = await heskHandle(c);
        c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
        const id = await exchange(c, 'I wait.', SOAK);
        looks.length = 0;
        btn(cardFor(draw(c), id, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
        assert.equal(looks.length, 0);
        btn(cardFor(draw(c), id, 'Outfit: Proposed person change:'), 'Discard').click(); await flush(80);
        assert.ok(!ownerOf(c.chat[id], 'outfit')?.committed);
        assert.equal(looks.length, 1, 'one looks summary once the other card is discarded');
        assert.doesNotMatch(looks[0], /\[outfit changed\]/);
    }
});

test('a no-op is dropped per field: an Outfit answer that is the outfit as it is drops that card; the Body card stays', async () => {
    const { c } = boot({ compose: (fields, base) => Object.fromEntries(fields.map(f => [f, f === 'outfit' ? base[f] : `${base[f]} [${f} changed]`])) });
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    assert.deepEqual(owners(c.chat[id]).map(o => o.candidate?.fields), ['body']);
    const notes = Object.values(c.chat[id].extra?.worldscrawl_calls ?? {}).flat();
    assert.ok(notes.some(x => x.kind === 'npc_appearance' && /^no change/.test(x.reason ?? '')), JSON.stringify(notes));
    const doc = draw(c);
    assert.equal(cardsOf(doc, id).length, 1);
    assert.ok(cardFor(doc, id, 'Body: Proposed person change:'));
});

test('the map\'s cast Changes tab draws the same one-field card (shared personReview / personField)', async () => {
    const { stampCard } = await import('../../plugin/ui/castdata.mjs');
    const x = { type: 'npc_appearance', candidate: 'review', fields: ['outfit'], scopeLevel: 'light', scope: 'light touch', identity: { owner: 'o1' }, owner: 'o1', msg: 1, index: 0, decisionRev: 1, summary: 'Hesk: outfit rewritten',
        diffs: [{ field: 'body', part: 'lasting', label: 'Body', before: 'tall', after: 'tall', changed: false }, { field: 'outfit', part: 'lasting', label: 'Outfit', before: 'black wool', after: 'black wool, soaked', changed: true }] };
    const card = stampCard(x, { who: 'Hesk' });
    assert.equal(card.desc.title, '👤 Outfit: Proposed person change:');
    assert.deepEqual(card.desc.panel.rows.map(r => r.label), ['Outfit']);
    const both = stampCard({ ...x, fields: ['body', 'outfit'] }, { who: 'Hesk' });
    assert.equal(both.desc.title, '👤 Proposed person change:');
    assert.equal(both.desc.panel.rows.length, 2);
});

test('a change to the card\'s own field still makes it stale: a later Outfit card kept first, then the earlier Outfit card asks again', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'hem soaked' })], wait: null });
    const a = await exchange(c, 'I wait.', 'The landlady comes in, her hem soaked by the rain.');
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'apron torn' })], wait: null });
    const b = await exchange(c, 'I watch.', 'The landlady catches her apron on a nail and it tears.');
    const first = ownerOf(c.chat[a], 'outfit'), second = ownerOf(c.chat[b], 'outfit');
    btn(cardFor(draw(c), b, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(second.committed);
    calls.length = 0;
    const token = first.candidate.token;
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(!first.committed, 'its own field moved: stale, not kept');
    assert.equal(calls.length, 1, 'asked again');
    assert.deepEqual(calls[0].fields, ['outfit']);
    assert.equal(first.candidate.phase, 'review');
    assert.equal(first.candidate.token, token);
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(first.committed, 'kept after the new review');
});

test('the compose prompt for a one-field card shows only its own field (the other field is not in the prompt)', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit')], wait: null });
    await exchange(c, 'I wait.', SOAK);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /^- outfit: /m);
    assert.doesNotMatch(calls[0].prompt, /^- body: /m);
});
