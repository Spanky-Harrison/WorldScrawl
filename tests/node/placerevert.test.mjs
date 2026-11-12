// A place text rebuilt when a temporary change runs out under a later change still in force, through the production
// paths: the generation interceptor (awaited before the narrator facts), the real map server in-process, a stubbed
// model, the shared job card and its Check again button.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN, YARD } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { ensurePlaceRebuilds } = await import('../../extension/placerevert.mjs');
const { toggleChange } = await import('../../extension/patches.mjs');
const { rememberWorlds, loadCalendar, chatChanges } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const COMMON_WAS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE_BOARDS = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
const JOBS = 'worldscrawl_appearance';

globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

const isRevert = p => /Before the temporary change it read:/.test(p);
/** Stubbed model: `revert` answers the rebuild call (string, function or a throw); everything else gets '{}'. */
function model(c, revert) {
    const calls = [], log = [];
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        log.push(isRevert(p) ? 'revert' : 'other');
        if (!isRevert(p)) return '{}';
        calls.push({ prompt: p, sys });
        return typeof revert === 'function' ? revert(p, sys) : revert;
    };
    return { calls, log };
}
const patch = (id, at, ops, note, extra = {}) => ({ type: 'patch', id, at, ops, note, summary: [note], swipe: 0, ...extra });
const ai = (mes, patches) => ({ is_user: false, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: patches ? { worldscrawl_patches: patches } : {} });
const user = (mes, seconds = 0) => ({ is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true, ...(seconds ? { worldscrawl_wait: { seconds } } : {}) } });

/** Smoke for an hour at 0 s; a permanent change written on top of it at 10 min; then `later` (default: the same
 *  description) and a player turn two hours on, so the smoke has run out. */
let chats = 0;
function boot(later = { op: 'set_description', loc: TAVERN, text: SMOKE_BOARDS }, { laterAt = 600 } = {}) {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [] }] });
    const c = SillyTavern.getContext();
    const id = `revert${++chats}`;
    exitsCache.clear(); // a fresh chat each time (SillyTavern's chat switch clears it too)
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {}, order = [];
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); order.push(key); };
    c.chat = [
        { is_user: true, mes: 'I step into the inn.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        ai('A pot boils over and smoke pours out.', [patch('p_smoke', 0, [{ op: 'set_description', loc: TAVERN, text: SMOKE, lasts: '1h' }], 'Smoke fills the common room')]),
        ai('A barrel rolls and smashes the floorboards.', [patch('p_boards', laterAt, [later], 'The floorboards by the hearth are splintered')]),
        user('I wait for the air to clear.', 7200),
    ];
    return { c, blocks, order };
}
const facts = blocks => blocks.worldscrawl_facts ?? Object.values(blocks).find(t => /Common Room/.test(t)) ?? '';
/** The room description the narrator facts give (the facts also name an expired change by its note). */
const here = blocks => facts(blocks).match(/This location: (.*)/)?.[1] ?? '';
const narrate = async () => { await globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal'); };
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);

test('(a) smoke runs out under a later permanent change: one rebuild call, the narrator reads the text without smoke', async () => {
    const { c, blocks, order } = boot();
    const m = model(c, () => { order.push('model'); return JSON.stringify({ text: BOARDS }); });
    // Before: the plain replay keeps the smoke the later change wrote on top.
    assert.match(chatChanges().find(x => x.id === 'p_boards').ops[0].text, /smoke/);
    await narrate();
    assert.equal(m.calls.length, 1, 'one rebuild call');
    const { prompt, sys } = m.calls[0];
    assert.match(prompt, /the description of Common Room/);
    assert.ok(prompt.includes(COMMON_WAS), 'the base is the text before the smoke');
    assert.ok(prompt.includes(SMOKE), 'the change that ended is named');
    assert.ok(prompt.includes(SMOKE_BOARDS) && prompt.includes('The floorboards by the hearth are splintered'), 'the change still in force is named');
    assert.match(sys, /How much to rewrite: light touch/);
    assert.match(sys, /DESCRIPTION RULE/);
    // The result is in place for every map reader, and the narrator facts were built after the call.
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
    assert.equal(here(blocks), BOARDS);
    assert.ok(order.lastIndexOf('worldscrawl_facts') > order.indexOf('model'), 'facts after the rebuild');
    const rec = c.chat[3].extra.worldscrawl_compose.records.find(r => r.kind === 'place');
    assert.equal(rec.text, BOARDS);
    assert.equal(c.chat[3].swipe_info[0].extra.worldscrawl_compose.records.length, 1, 'mirrored to the swipe');

    // (c) the same changes still in force on the next turn: a cache hit, no call.
    c.chat.push(ai('The air clears.'), user('I look around.', 60));
    await narrate();
    assert.equal(m.calls.length, 1, 'no second call for the same set of changes');
    assert.equal(here(blocks), BOARDS);
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
});

test('(a) a full rewrite kept on the later change asks with the full rewrite piece', async () => {
    const { c } = boot();
    c.chat[2].extra.worldscrawl_patches[0].rewrite = 'full';
    const m = model(c, JSON.stringify({ text: BOARDS }));
    await narrate();
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0].sys, /How much to rewrite: full rewrite/);
});

test('(b) an expiry with no later change on the same text: no call, the plain replay', async () => {
    for (const [later, opts] of [
        [{ op: 'set_description', loc: YARD, text: 'Broken crates litter the courtyard.' }, {}], // another room
        [{ op: 'set_description', loc: TAVERN, text: BOARDS }, { laterAt: 3600 }], // written after the smoke ended
    ]) {
        const { c, blocks } = boot(later, opts);
        const m = model(c, () => { throw new Error('no call expected'); });
        await narrate();
        assert.equal(m.calls.length, 0);
        assert.equal(c.chat[3].extra.worldscrawl_compose, undefined);
        assert.equal(c.chat[3].extra[JOBS], undefined);
        assert.equal(here(blocks), opts.laterAt ? BOARDS : COMMON_WAS);
    }
});

test('(c) turning a change off rebuilds once; turning it on again needs nothing, and off again is a cache hit', async t => {
    const { c } = boot();
    const prevDoc = globalThis.document;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    t.after(() => { globalThis.document = prevDoc; });
    c.chat[1].extra.worldscrawl_patches[0].ops[0].lasts = '1d'; // still in force at 2 h
    c.chat[3].extra.worldscrawl_wait.seconds = 60;
    const m = model(c, JSON.stringify({ text: BOARDS }));
    await narrate();
    assert.equal(m.calls.length, 0, 'nothing ran out');
    const off = await toggleChange(1, 'p_smoke', { choice: 'one' });
    assert.notEqual(off?.ok, false, JSON.stringify(off));
    assert.equal(m.calls.length, 1, 'turning the smoke off asks once');
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
    await toggleChange(1, 'p_smoke');
    assert.equal(m.calls.length, 1);
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, SMOKE_BOARDS, 'on again: the later change as written');
    await toggleChange(1, 'p_smoke', { choice: 'one' });
    assert.equal(m.calls.length, 1, 'same set again: a cache hit');
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
});

test('(d) a failed rebuild: the narrator goes ahead with the plain replay, the card shows it, Check again works', async () => {
    const { c, blocks } = boot();
    let fail = true;
    const m = model(c, () => { if (fail) throw new Error('backend down'); return JSON.stringify({ text: BOARDS }); });
    await narrate();
    assert.equal(m.calls.length, 2, 'two tries, like an appearance rebuild');
    assert.equal(here(blocks), SMOKE_BOARDS, 'the narrator still got its facts, with the plain replay');
    const job = c.chat[3].extra[JOBS].jobs.find(j => j.domain === 'place');
    assert.equal(job.status, 'failed');
    assert.match(job.reason, /backend down/);
    // No retry loop: the next turn does not ask again for the same inputs.
    c.chat.push(ai('Nothing happens.'), user('I wait.', 60));
    await narrate();
    assert.equal(m.calls.length, 2);
    c.chat.splice(-2);
    const doc = draw(c);
    // The failure is on the smoke's expiry notice (placeexpiry.test.mjs covers that card), not a second card.
    const card = doc.querySelector('.worldscrawl_placeexpired');
    assert.ok(card.textContent.includes('Rebuild of the description of Common Room failed.'), card.textContent);
    assert.equal(doc.querySelector('.worldscrawl_appearpending'), null);
    fail = false;
    byText(doc, 'Check again').click();
    for (let i = 0; i < 50 && m.calls.length < 3; i++) await flush(10);
    await flush(50);
    assert.equal(m.calls.length, 3);
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
    assert.equal((c.chat[3].extra[JOBS]?.jobs ?? []).filter(j => j.domain === 'place').length, 0, 'the failure is cleared');
    assert.equal(here(blocks), BOARDS, 'Check again refreshes the narrator facts');
});

test('(d) a timeout fails the same way', async () => {
    const { c } = boot();
    const m = model(c, () => new Promise(() => {}));
    const r = await ensurePlaceRebuilds(3, { timeout: 30 });
    assert.equal(r.called, 1);
    assert.equal(m.calls.length, 2);
    const job = c.chat[3].extra[JOBS].jobs.find(j => j.domain === 'place');
    assert.equal(job.kind, 'timeout');
    assert.match(job.reason, /did not answer in time/);
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, SMOKE_BOARDS, 'plain replay stays');
});

test('(a) an exit text: the base is the exit text before the temporary change', async () => {
    const { c } = boot({ op: 'set_exit_description', loc: TAVERN, direction: 'back', text: 'A smoke-stained back door, its frame cracked.' });
    c.chat[1].extra.worldscrawl_patches[0].ops.push({ op: 'set_exit_description', loc: TAVERN, direction: 'back', text: 'A smoke-stained back door.', lasts: '1h' });
    const m = model(c, JSON.stringify({ text: 'A back door to the courtyard, its frame cracked.' }));
    await narrate();
    assert.equal(m.calls.length, 1, 'only the exit text had a later change on top; the description just reverts');
    const exitCall = m.calls.find(x => /exit text of Common Room/.test(x.prompt));
    assert.match(exitCall.prompt, /the "back" exit text of Common Room/);
    assert.ok(exitCall.prompt.includes('A back door to the courtyard.'), exitCall.prompt);
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, 'A back door to the courtyard, its frame cracked.');
});
