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
const LIGHT_SYS = /^You make a small edit to a person's appearance text/;
const FULL_SYS = /^You rewrite a person's appearance text/;

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

test('a change to the card\'s own field still makes it stale: a later Outfit card kept first, and the earlier Outfit card is asked again at once (5A)', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'hem soaked' })], wait: null });
    const a = await exchange(c, 'I wait.', 'The landlady comes in, her hem soaked by the rain.');
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'apron torn' })], wait: null });
    const b = await exchange(c, 'I watch.', 'The landlady catches her apron on a nail and it tears.');
    const first = ownerOf(c.chat[a], 'outfit'), second = ownerOf(c.chat[b], 'outfit');
    const token = first.candidate.token;
    calls.length = 0;
    btn(cardFor(draw(c), b, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(second.committed);
    // 5A (A3, Ast): its own field moved, so it is asked again at once, without waiting for its Approve.
    assert.ok(!first.committed, 'its own field moved: not kept');
    assert.equal(calls.length, 1, 'asked again');
    assert.deepEqual(calls[0].fields, ['outfit']);
    assert.equal(first.candidate.phase, 'review');
    assert.equal(first.candidate.token, token);
    calls.length = 0;
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(first.committed, 'kept after the new review');
    assert.equal(calls.length, 0, 'no further call');
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

// ---- 5A: per-field cleanup (A2 "did not change" per field, A3 sibling refresh, A4 alreadyEffect gone, A5 kept-card
// tooltips, A6 per-field compose wording). Through the same real handlers as above.
const npcLib = await import('../../extension/npc.mjs');
const sceneLib = await import('../../extension/scene.mjs');
const heskNow = c => npcLib.npcAt(c.chat, c.chat.length - 1, sceneLib.castPack().npcs, 'hesk');
const notesOf = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const warnsOf = m => (m.extra?.worldscrawl_npcwarn ?? []).map(w => (typeof w === 'string' ? w : w.text ?? JSON.stringify(w)));
const keptOf = (doc, id) => [...(doc.querySelector(`.mes[mesid="${id}"]`)?.querySelectorAll('.worldscrawl_npcchange') ?? [])];

test('5A A2: a "looks" item with new Body text and no Outfit text: a Body card only, no warning, and "the outfit did not change"', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body, outfit', { intent: 'looks', body: 'A big woman, now with a fresh scar across one cheek.' })], wait: null });
    const id = await exchange(c, 'I look at her.', 'The landlady turns; a fresh scar crosses her cheek.');
    assert.deepEqual(owners(c.chat[id]).map(o => o.candidate?.fields), ['body']);
    assert.deepEqual(warnsOf(c.chat[id]), [], 'no warning: one field did change');
    assert.ok(notesOf(c.chat[id]).some(x => x.kind === 'npc_appearance' && x.status === 'skipped' && x.reason === 'the outfit did not change'), JSON.stringify(notesOf(c.chat[id])));
    assert.equal(calls.length, 0, 'the Body text is given (no compose call), and the Outfit is never asked');
    assert.match(ownerOf(c.chat[id], 'body').candidate.lastingPreview.body, /fresh scar/);
});

test('5A A2: a real intent with Body changed and Outfit text equal to the outfit now: one Body card; the Outfit is dropped before any compose call', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    const now = heskNow(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit', { body: `${now.body} Rain runs off her braids.`, outfit: now.outfit })], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    assert.deepEqual(owners(c.chat[id]).map(o => o.candidate?.fields), ['body']);
    assert.equal(calls.filter(x => x.fields.includes('outfit')).length, 0, 'the unchanged Outfit is dropped before any compose call');
    assert.equal(calls.length, 0, 'the given Body text needs no call either');
    assert.equal(ownerOf(c.chat[id], 'body').candidate.lastingPreview.body, `${now.body} Rain runs off her braids.`);
    assert.ok(notesOf(c.chat[id]).some(x => x.reason === 'the outfit did not change'));
    assert.deepEqual(warnsOf(c.chat[id]), []);
    assert.equal(cardsOf(draw(c), id).length, 1);
});

test('5A A2: every field unchanged or saying nothing: no card and one warning; one field named: the warning names it', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    const now = heskNow(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit', { intent: 'looks', outfit: now.outfit })], wait: null });
    const id = await exchange(c, 'I look.', 'The landlady looks as she always does.');
    assert.equal(owners(c.chat[id]).length, 0);
    assert.equal(calls.length, 0);
    const w = warnsOf(c.chat[id]);
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /^Warning: a person update for Hesk did not land: appearance did not change\.$/);
    assert.deepEqual(notesOf(c.chat[id]).filter(x => x.status === 'skipped').map(x => x.reason).sort(), ['the body did not change', 'the outfit did not change']);

    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'soaked', outfit: now.outfit })], wait: null });
    const id2 = await exchange(c, 'I look again.', 'The landlady wears the same dress as ever.');
    assert.equal(owners(c.chat[id2]).length, 0);
    assert.deepEqual(warnsOf(c.chat[id2]), ["Warning: a person update did not land: Hesk's outfit did not change."]);
});

test('5A A3: approving Body refreshes the pending Outfit card at once: its preview takes the kept Body, its Approve keeps its own Outfit; two compose calls in all', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    const outfit = ownerOf(c.chat[id], 'outfit');
    const composed = outfit.candidate.lastingPreview.outfit;
    const revBefore = outfit.decisionRev;
    btn(cardFor(draw(c), id, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
    const keptBody = heskNow(c).body;
    assert.match(keptBody, /\[body changed\]$/);
    assert.equal(outfit.candidate.lastingPreview.body, keptBody, 'without a click on it, the Outfit card took the kept Body');
    assert.equal(outfit.candidate.lastingPreview.outfit, composed, 'and kept its own composed Outfit');
    assert.ok(outfit.decisionRev > revBefore, 'its decision revision moved (an older Approve is stale)');
    const oc = cardFor(draw(c), id, 'Outfit: Proposed person change:');
    assert.ok(oc);
    btn(oc, 'Approve').click(); await flush(80);
    assert.ok(outfit.committed);
    assert.equal(heskNow(c).outfit, composed);
    assert.equal(calls.length, 2, 'two compose calls in all');
});

test('5A A3: an Approve drawn before the refresh is stale: refused, the card redraws, nothing is kept until the new card is approved', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    const outfit = ownerOf(c.chat[id], 'outfit');
    const old = draw(c);
    const oldApprove = btn(cardFor(old, id, 'Outfit: Proposed person change:'), 'Approve');
    btn(cardFor(old, id, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
    calls.length = 0;
    oldApprove.click(); await flush(80);
    assert.ok(!outfit.committed, 'the old ticket never commits');
    assert.equal(outfit.candidate.phase, 'review');
    assert.equal(calls.length, 0);
    btn(cardFor(draw(c), id, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(outfit.committed, 'the redrawn card approves');
});

/** A kept Body change on an earlier message (Body0), then Body and Outfit cards on a later one; Body approved, so the
 *  Outfit card was refreshed onto Body0 + Body. Returns what the Undo test needs. */
async function undoSetup() {
    const env = boot({});
    const { c, calls } = env;
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body', { intent: 'hair cut short', why: 'a haircut' })], wait: null });
    const a = await exchange(c, 'I hand her the shears.', 'The landlady cuts her braids short.');
    btn(cardFor(draw(c), a, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
    const body0 = heskNow(c).body;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body,outfit')], wait: null });
    const b = await exchange(c, 'I wait.', SOAK);
    const outfit = ownerOf(c.chat[b], 'outfit');
    btn(cardFor(draw(c), b, 'Body: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.equal(outfit.candidate.lastingPreview.body, heskNow(c).body, 'refreshed onto the kept Body');
    return { ...env, a, b, outfit, body0, composed: outfit.candidate.lastingPreview.outfit };
}
const undoBody = async (c, b) => {
    const kept = keptOf(draw(c), b).find(e => /Character changed here/.test(e.textContent));
    assert.ok(kept, keptOf(draw(c), b).map(e => e.textContent).join(' || '));
    btn(kept, 'Undo').click(); await flush(120);
};

test('5A A3 2a: the decided Body undone, the text before it on record: the Outfit card shows that Body again with 0 compose calls', async () => {
    const { c, calls, b, outfit, body0, composed } = await undoSetup();
    calls.length = 0;
    await undoBody(c, b);
    assert.equal(calls.length, 0, 'no compose call');
    assert.equal(outfit.candidate.phase, 'review');
    assert.equal(outfit.candidate.lastingPreview.body, body0, 'the Body before the change');
    assert.equal(outfit.candidate.lastingPreview.outfit, composed, 'its own Outfit text kept');
});

test('5A A3 2b: the decided Body undone, the text before it not on record: exactly 1 compose call, then a reviewable card', async () => {
    const { c, calls, a, b, outfit, composed } = await undoSetup();
    const rec = c.chat[a].extra.worldscrawl_compose;
    rec.records = rec.records.filter(r => r.kind !== 'fields');
    calls.length = 0;
    await undoBody(c, b);
    assert.equal(calls.length, 1, 'exactly one compose call');
    assert.deepEqual(calls[0].fields, ['body'], 'the person\'s text before the change, rebuilt once');
    assert.equal(outfit.candidate.phase, 'review');
    assert.equal(outfit.candidate.lastingPreview.body, heskNow(c).body, 'the Outfit card rebased on it: no second call');
    assert.equal(outfit.candidate.lastingPreview.outfit, composed);
    assert.ok(cardFor(draw(c), b, 'Outfit: Proposed person change:'));
});

test('5A A3: a sibling that is really stale (its text before the change cannot be rebuilt) shows Preparing and is asked again on its own card', async () => {
    const env = await undoSetup();
    const { c, calls, a, b, outfit } = env;
    const rec = c.chat[a].extra.worldscrawl_compose;
    rec.records = rec.records.filter(r => r.kind !== 'fields');
    // The person's own rebuild (Body0 alone) fails; the Outfit card's full replay (Body0 + its change) answers.
    const gen = c.generateRaw;
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (/hair cut short/.test(p) && !/soaked by the rain/.test(p) && /^- body: /m.test(p)) { calls.push({ fields: ['body'], prompt: p, failed: true }); return 'not json'; }
        if (/soaked by the rain/.test(p) && !isTrackerCall(args)) seen.push({ phase: outfit.candidate?.phase, title: cardsOf(draw(c), b).map(e => e.textContent).join(' || ') });
        return gen(args);
    };
    const seen = [];
    calls.length = 0;
    await undoBody(c, b);
    const seenWorking = seen.length === 1 && seen[0].phase === 'working' && /Preparing a change to/.test(seen[0].title);
    const asked = calls.filter(x => !x.failed);
    assert.equal(asked.length, 1, JSON.stringify(calls.map(x => [x.fields, x.failed ?? false])));
    assert.match(asked[0].prompt, /soaked by the rain/, 'asked on the Outfit card');
    assert.deepEqual(asked[0].fields, ['body', 'outfit'], 'a full replay: its base (Body0 alone) is not known');
    assert.doesNotMatch(asked[0].prompt, /as it is now \(for reference only/, '5A A6: a two-field replay has no reference line');
    assert.ok(seenWorking, `it went to "working" (Preparing…) first: ${JSON.stringify(seen)}`);
    assert.equal(outfit.candidate.phase, 'review');
    assert.ok(cardFor(draw(c), b, 'Outfit: Proposed person change:'));
});

test('5A A4: alreadyEffect is gone from the extension; the same tracker item again on a later message still makes a card', async () => {
    const dir = new URL('../../extension/', import.meta.url);
    for (const f of fs.readdirSync(dir).filter(f => /\.m?js$/.test(f))) assert.doesNotMatch(fs.readFileSync(new URL(f, dir), 'utf8'), /alreadyEffect/, f);
    const { c } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit')], wait: null });
    const a = await exchange(c, 'I wait.', SOAK);
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(ownerOf(c.chat[a], 'outfit').committed);
    const b = await exchange(c, 'I wait more.', 'The landlady goes out again and comes back soaked by the rain.');
    assert.deepEqual(owners(c.chat[b]).map(o => o.candidate?.fields), ['outfit'], 'the same intent and field again: a card, as before');
    assert.ok(cardFor(draw(c), b, 'Outfit: Proposed person change:'));
});

test('5A A5: a kept one-field card names its own field in Edit (and Save while editing); the map\'s kept card too', async () => {
    const C = await import('../../plugin/shared/cards.mjs');
    const t = d => Object.fromEntries(d.actions.map(x => [x.id, x.title]));
    assert.equal(t(C.personKept({ key: 'k', text: 'x', field: 'outfit' })).edit, 'Change the words or the outfit text of this change');
    assert.equal(t(C.personKept({ key: 'k', text: 'x', field: 'outfit', editing: true })).save, 'Keep the outfit exactly as typed (or ask again for an edited Change line)');
    assert.equal(t(C.personKept({ key: 'k', text: 'x', field: 'body' })).edit, 'Change the words or the body text of this change');
    assert.equal(t(C.personKept({ key: 'k', text: 'x' })).edit, 'Change the words or the body and outfit text of this change', 'two fields: both named');

    const { c } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit')], wait: null });
    const id = await exchange(c, 'I wait.', SOAK);
    btn(cardFor(draw(c), id, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    const kept = keptOf(draw(c), id).find(e => /Character changed here/.test(e.textContent));
    assert.ok(kept);
    const edit = btn(kept, 'Edit');
    assert.equal(edit.getAttribute('title') || edit.title, 'Change the words or the outfit text of this change');
    assert.doesNotMatch(kept.innerHTML ?? kept.textContent, /body and outfit/);

    const { stampCard } = await import('../../plugin/ui/castdata.mjs');
    const card = stampCard({ type: 'npc_appearance', fields: 'outfit', identity: { owner: 'o1' }, owner: 'o1', msg: 1, index: 0, decisionRev: 1, summary: 'Hesk: outfit soaked' }, { who: 'Hesk' });
    assert.equal(Object.fromEntries(card.desc.actions.map(x => [x.id, x.title])).edit, 'Change the words or the outfit text of this change');
});

test('5A A6: a one-field compose shows the other field as it is now, for reference only; the system line names the field', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    const now = heskNow(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit')], wait: null });
    await exchange(c, 'I wait.', SOAK);
    assert.equal(calls.length, 1);
    const masked = s => s.replace(/Hesk/g, 'the landlady');
    assert.ok(calls[0].prompt.includes(`Their body as it is now (for reference only; do not write it): ${masked(now.body)}`), calls[0].prompt);
    assert.doesNotMatch(calls[0].prompt, /^- body: /m, 'not a field to write');
    assert.match(calls[0].system, /only the field\(s\) named in the request \(outfit\)/);
    assert.doesNotMatch(calls[0].system, /body and\/or outfit/);
});

test('5A A6: a heavy one-field rewrite names its field in the rebuild line and still shows the other field for reference', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    calls.length = 0;
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'the apron burns away', scope: 'full', why: 'ruined' })], wait: null });
    await exchange(c, 'I watch.', 'The landlady\'s apron catches fire and burns away.');
    assert.match(calls[0].system, FULL_SYS);
    assert.match(calls[0].system, /when the outfit is among the fields asked \(outfit\), how the clothes fit the body as it is now/);
    assert.match(calls[0].prompt, /Their body as it is now/);
});

test('5A A3 (Ast): an approved Outfit0 on an earlier message undone: the pending Outfit card on a later message shows Preparing, is asked once on its own card, returns to review with new keys, and Approve makes no further call', async () => {
    const { c, calls } = boot({});
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'hem soaked' })], wait: null });
    const a = await exchange(c, 'I wait.', 'The landlady comes in, her hem soaked by the rain.');
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    const outfit0 = ownerOf(c.chat[a], 'outfit');
    assert.ok(outfit0.committed);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'apron torn' })], wait: null });
    const b = await exchange(c, 'I watch.', 'The landlady catches her apron on a nail and it tears.');
    const pending = ownerOf(c.chat[b], 'outfit');
    assert.equal(pending.candidate.phase, 'review');
    const keys = [pending.candidate.lastingKey, pending.candidate.liveKey];
    assert.match(pending.candidate.lastingPreview.outfit, /\[outfit changed\] \[outfit changed\]$/, 'composed on top of Outfit0');
    const seen = [];
    const gen = c.generateRaw;
    c.generateRaw = async args => {
        if (!isTrackerCall(args) && /apron torn/.test(String(args?.prompt ?? ''))) seen.push({ phase: pending.candidate?.phase, cards: cardsOf(draw(c), b).map(e => e.textContent).join(' || ') });
        return gen(args);
    };
    calls.length = 0;
    const kept = keptOf(draw(c), a).find(e => /Character changed here/.test(e.textContent));
    btn(kept, 'Undo').click(); await flush(150);
    assert.equal(calls.length, 1, `exactly one compose call: ${JSON.stringify(calls.map(x => x.fields))}`);
    assert.match(calls[0].prompt, /apron torn/, 'on the pending card');
    assert.doesNotMatch(calls[0].prompt, /hem soaked/, 'Outfit0 is gone from its base');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].phase, 'working');
    assert.match(seen[0].cards, /Preparing a change to/, 'the card showed Preparing… while it was asked');
    assert.equal(pending.candidate.phase, 'review');
    assert.notDeepEqual([pending.candidate.lastingKey, pending.candidate.liveKey], keys, 'new keys');
    assert.doesNotMatch(pending.candidate.lastingPreview.outfit, /\[outfit changed\] \[outfit changed\]/, 'no longer on top of Outfit0');
    calls.length = 0;
    btn(cardFor(draw(c), b, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(pending.committed, 'kept');
    assert.equal(calls.length, 0, 'Approve makes no further call');
});

/** Two hours pass on a player line (a wait stamp), with a plain reply after it. */
function waitTwoHours(c) {
    c.chat.push({ is_user: true, mes: 'I wait two hours.', swipe_id: 0, extra: { worldscrawl_intent_checked: true, worldscrawl_wait: { seconds: 7200 } } });
    c.chat.push({ is_user: false, mes: 'Two hours pass in the common room.', swipe_id: 0, swipes: ['Two hours pass in the common room.'], swipe_info: [{ extra: {} }], extra: {} });
}
/** A kept one-hour Outfit change (hem soaked) at a; a pending Body card at b while it is in force; two hours on; then
 *  an Outfit card at c, after it ran out. */
async function expirySetup() {
    const env = boot({});
    const { c } = env;
    const H = await heskHandle(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'hem soaked', lasts: '1h' })], wait: null });
    const a = await exchange(c, 'I wait.', 'The landlady comes in, her hem soaked by the rain.');
    btn(cardFor(draw(c), a, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(80);
    assert.ok(ownerOf(c.chat[a], 'outfit').committed);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'body', { intent: 'a fresh scar on her cheek' })], wait: null });
    const b = await exchange(c, 'I look at her.', 'The landlady turns; a fresh scar crosses her cheek.');
    const body = ownerOf(c.chat[b], 'body');
    assert.equal(body.candidate.phase, 'review');
    assert.notEqual(body.candidate.liveKey, body.candidate.lastingKey, 'at b the one-hour Outfit is in force: live differs from lasting');
    waitTwoHours(c);
    c.generateRaw = withTracker(c.generateRaw, { place: null, people: [item(H, 'outfit', { intent: 'apron torn' })], wait: null });
    const cc = await exchange(c, 'I watch.', 'The landlady catches her apron on a nail and it tears.');
    assert.equal(ownerOf(c.chat[cc], 'outfit').candidate.phase, 'review');
    return { ...env, a, b, cc, body };
}

test('5A A3 (Ast round 3): a card decided after an expiry leaves an earlier pending card alone when its keys at its own time are unchanged (no needless refill)', async () => {
    const { c, calls, cc, body } = await expirySetup();
    const keys = [body.candidate.lastingKey, body.candidate.liveKey], rev = body.decisionRev, preview = structuredClone(body.candidate.livePreview);
    calls.length = 0;
    btn(cardFor(draw(c), cc, 'Outfit: Proposed person change:'), 'Discard').click(); await flush(120);
    assert.equal(calls.length, 0, 'no call');
    assert.deepEqual([body.candidate.lastingKey, body.candidate.liveKey], keys, 'its keys at its own message\'s time are unchanged');
    assert.equal(body.decisionRev, rev, 'not touched: an Approve drawn before stays good');
    assert.deepEqual(body.candidate.livePreview, preview);
    assert.equal(body.candidate.phase, 'review');
});

test('5A A3 (Ast round 3): a card kept after an expiry refreshes an earlier pending card at its own time: the one-hour change still in its live text and base', async () => {
    const { c, calls, cc, body } = await expirySetup();
    calls.length = 0;
    btn(cardFor(draw(c), cc, 'Outfit: Proposed person change:'), 'Approve').click(); await flush(150);
    assert.equal(body.candidate.phase, 'review');
    assert.notEqual(body.candidate.liveKey, body.candidate.lastingKey, 'keyed at b: the one-hour Outfit is still in force there');
    assert.ok(calls.length >= 1, 'its base at b (the one-hour change plus the new one) was never composed: asked again');
    assert.ok(calls.some(x => /hem soaked/.test(x.prompt) && /a fresh scar/.test(x.prompt)), `the refill is built on b's base, with the one-hour change: ${JSON.stringify(calls.map(x => x.prompt.slice(0, 200)))}`);
    assert.match(body.candidate.livePreview.outfit, /\[outfit changed\]/, 'its live preview carries the one-hour Outfit');
});
