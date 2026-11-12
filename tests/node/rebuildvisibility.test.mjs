// Rebuilds are never silent, never titled with a raw id, and one rebuild is one card. Through the production paths: the
// generation interceptor, the shared card buttons (Turn off, Check again, Edit, Approve edited), the in-process map
// server and a stubbed model held at a gate so the cards can be looked at while a call runs.
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
const { exitsCache } = await import('../../extension/footer.mjs');
const { NPC_KEY, npcAt } = await import('../../extension/npc.mjs');
const { NPC_EXPIRED_KIND } = await import('../../extension/npcexpiry.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { PLACE_EXPIRED_KIND, openForms } = patchesExt;
const { rememberWorlds, loadCalendar, chatChanges } = await import('../../extension/clock.mjs');
const { editLib } = await import('../../extension/cardlib.mjs');
const C = await import('../../plugin/shared/cards.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
const until = async (f, n = 150) => { for (let i = 0; i < n && !f(); i++) await flush(10); };
let failContext = false;
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    if (failContext && /patch\/context/.test(route)) return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ detail: { error: `unknown location ${TAVERN}` } }) };
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

let chats = 0;
function boot() {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK], place_labels: { [TAVERN]: 'Common Room', 'riverton:drowned_rat': 'The Drowned Rat' } }] }); // as /worlds gives them
    const c = SillyTavern.getContext();
    const id = `vis${++chats}`;
    exitsCache.clear(); openForms.clear(); failContext = false;
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    ext.settings().autoKeepWaits = false;
    globalThis.document = makeDoc([]);
    return { c, blocks };
}
const kindOf = p => (/Looks line/.test(p) ? 'looks' : /Before the temporary change it read:/.test(p) ? 'revert' : /Reply with JSON only:\n\{"place"/.test(p) ? 'tracker' : /body/i.test(p) ? 'fields' : 'other');
/** Stubbed model. answers[kind]: a string, a function, or 'gate' (held until release(kind)). */
function model(c, answers) {
    const calls = [], gates = {};
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? ''), k = kindOf(p);
        calls.push(k);
        const a = answers[k];
        if (a === undefined) return k === 'tracker' ? '{"place": null, "people": [], "wait": null}' : '{}';
        return typeof a === 'function' ? a(p) : a;
    };
    return { calls, count: k => calls.filter(x => x === k).length, gates };
}
/** A promise held until its release(value) is called. */
function gate() { let release; const p = new Promise(r => { release = r; }); return { p, release: v => release(v) }; }
const user = (mes, extra = {}) => ({ is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true, ...extra } });
const reply = (mes, extra = {}) => ({ is_user: false, mes, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra });
const own = (owner, intent, lasts, extra = {}) => ({ swipe: 0, type: 'npc_appearance', id: 'hesk', intent, owner, start: 0, lasts, contentId: `c_${owner}`, candidate: null, decisionRev: 1,
    identity: { owner, message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent, fields: 'body', layer: {} }, ...extra });
/** Hesk with `temps` (temporary for an hour) and a scar for good on top; then the player waits two hours. */
function heskChat(temps = [['og', 'turned into a gnoll']]) {
    return [
        user('I step into the inn.', { worldscrawl_move: { to: TAVERN } }),
        reply('A flash, and a beam scars her cheek.', { worldscrawl_mid: 'm', [NPC_KEY]: [
            { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
            { swipe: 0, type: 'npc_appear', id: 'hesk', at: TAVERN },
            ...temps.map(([o, i]) => own(o, i, 60)), own('os', 'a scar across her cheek', null),
        ] }),
        user('I [wait] two hours.', { worldscrawl_wait: { seconds: 7200 } }),
    ];
}
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const mesEl = (doc, id) => doc.querySelectorAll('.mes').find(m => m.getAttribute('mesid') === String(id));
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
const jobCards = doc => doc.querySelectorAll('.worldscrawl_appearpending');
const noticeOf = (c, kind) => c.chat.findIndex(m => m.extra?.worldscrawl_notice_kind === kind);
const narrate = () => globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');
const SCARRED = '{"body":"sturdy, a scar across her cheek","outfit":"wool"}';

// ---- 1. people: visible while working
test('an expiry: the notice comes first; its card shows the appearance rebuild working, then the Looks line working; no job card; the notice line is redone after', async () => {
    const { c } = boot();
    c.chat = heskChat();
    const f = gate(), l = gate();
    const m = model(c, { fields: () => f.p, looks: () => l.p });
    const turn = narrate();
    await until(() => m.count('fields') === 1);
    const at = noticeOf(c, NPC_EXPIRED_KIND);
    assert.equal(at, 3, 'the notice sits right after the player message, before the rebuild');
    await flush(10);
    let doc = draw(c);
    let card = mesEl(doc, at).querySelector('.worldscrawl_npcexpired');
    assert.match(card.textContent, /Appearance rebuild for Hesk: working…/);
    assert.equal(jobCards(doc).length, 0, 'no second card');
    f.release(SCARRED);
    await until(() => m.count('looks') === 1);
    doc = draw(c);
    card = mesEl(doc, at).querySelector('.worldscrawl_npcexpired');
    assert.match(card.textContent, /Looks line for Hesk: working…/);
    assert.doesNotMatch(card.textContent, /Appearance rebuild/);
    l.release('{"looks":"a scarred landlady"}');
    await turn;
    doc = draw(c);
    card = mesEl(doc, at).querySelector('.worldscrawl_npcexpired');
    assert.doesNotMatch(card.textContent, /working|failed/);
    assert.deepEqual(btns(card), ['Edit']);
    assert.match(c.chat[at].mes, /Looks now: a scarred landlady/, 'the notice line has how she looks after the rebuild');
});

test('Turn off on a kept change: the rebuild shows on the job card (her name, working), then goes', async () => {
    const { c } = boot();
    c.chat = heskChat();
    c.chat[2] = user('I look at her.'); // no wait: the gnoll is still on
    const f = gate();
    const m = model(c, { fields: () => f.p, looks: '{"looks":"a gnoll"}' });
    let doc = draw(c);
    const kept = mesEl(doc, 1).querySelectorAll('.worldscrawl_npcchange').find(x => /scar/.test(x.textContent));
    byText(kept, 'Turn off').click();
    await until(() => m.count('fields') === 1);
    await flush(10);
    doc = draw(c);
    const jobs = jobCards(doc);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].textContent, /Appearance rebuild for Hesk: working…/);
    f.release('{"body":"a gnoll","outfit":"wool"}');
    await until(() => m.count('looks') === 1);
    await flush(40);
    doc = draw(c);
    assert.equal(jobCards(doc).length, 0);
});

test('a proposal\'s own rewrite shows on the proposal card (preparing), never a job card; a failure shows its reason there', async () => {
    const { c } = boot();
    c.chat = heskChat([]);
    c.chat[2] = user('I look at her.');
    const cand = { token: 't1', epoch: 0, proposedLasts: null, kind: 'appearance', intent: 'paint on her face', fields: 'body', layer: {}, scope: 'light', phase: 'failed', lastingKey: '', liveKey: '', lastingPreview: null, livePreview: null };
    c.chat[1].extra[NPC_KEY].push({ ...own('op', 'paint on her face', null), committed: null, candidate: cand });
    let fail = false;
    const f = gate();
    const m = model(c, { fields: () => (fail ? Promise.reject(new Error('backend down')) : f.p) });
    let doc = draw(c);
    let prop = mesEl(doc, 1).querySelector('.worldscrawl_npcpending');
    assert.match(prop.textContent, /did not resolve/);
    byText(prop, 'Check again').click();
    await until(() => m.count('fields') === 1);
    await flush(10);
    doc = draw(c);
    prop = mesEl(doc, 1).querySelector('.worldscrawl_npcpending');
    assert.match(prop.textContent, /Preparing a change to Hesk…/, 'the proposal card says it is working');
    assert.equal(jobCards(doc).length, 0);
    fail = true;
    f.release(Promise.reject(new Error('backend down')));
    await until(() => m.count('fields') >= 2);
    await flush(60);
    doc = draw(c);
    prop = mesEl(doc, 1).querySelector('.worldscrawl_npcpending');
    assert.match(prop.textContent, /did not resolve/);
    assert.match(prop.textContent, /⚠ /, 'the reason is on the proposal card');
    assert.equal(jobCards(doc).length, 0, 'the failed job is not a second card');
    assert.ok(scene.appearJobs(c.chat[1]).some(j => j.status === 'failed' && j.owner === 'op'), 'the failure is still recorded');
});

// ---- 2. no raw ids in titles
test('job titles: the person\'s name, the place text\'s label, or a plain phrase; never an id', async () => {
    const { c } = boot();
    c.chat = [user('I step in.', { worldscrawl_move: { to: TAVERN } }), reply('Quiet.'), user('I wait.')];
    c.chat[2].extra.worldscrawl_appearance = { swipe: 0, jobs: [
        { id: 'hesk', npc: 'hesk', key: 'k1', part: 'fields', status: 'failed', reason: 'backend down' }, // no stored name
        { id: 'zz9', npc: 'zz9', key: 'k2', part: 'looks', name: 'zz9', status: 'failed', reason: 'x' }, // nobody known
        { id: `desc:${TAVERN}`, npc: `desc:${TAVERN}`, domain: 'place', part: 'place', name: `desc:${TAVERN}`, key: 'k3', status: 'failed', reason: 'y' },
        { id: 'lore:nowhere:void', npc: 'lore:nowhere:void', domain: 'place', part: 'place', key: 'k4', status: 'failed', reason: 'z' },
    ] };
    const titles = jobCards(draw(c)).map(j => j.querySelector('.worldscrawl_card_title').textContent);
    assert.equal(titles[0], 'Appearance rebuild for Hesk failed. backend down');
    assert.equal(titles[1], 'Looks line failed. x');
    assert.equal(titles[2], 'Rebuild of the description of Common Room failed. y');
    assert.equal(titles[3], 'Rebuild of the notes of an area failed. z');
    for (const t of titles) assert.doesNotMatch(t, /hesk|zz9|desc:|lore:|riverton:/);
});

const SMOKE = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const STEAM = 'Hot steam fills the low-beamed common room. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const BOARDS_ON = 'Thick black smoke and hot steam fill the low-beamed common room. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const patch = (id, at, ops, note) => ({ type: 'patch', id, at, ops, note, summary: [note], swipe: 0 });
/** Smoke and steam on the common room for an hour each (two changes, same text), splintered boards for good on top. */
function steamChat() {
    return [
        user('I step into the inn.', { worldscrawl_move: { to: TAVERN } }),
        reply('A pot boils over.', { worldscrawl_patches: [patch('p_smoke', 0, [{ op: 'set_description', loc: TAVERN, text: SMOKE, lasts: '1h' }], 'Smoke fills the common room')] }),
        reply('The kettle screams.', { worldscrawl_patches: [patch('p_steam', 0, [{ op: 'set_description', loc: TAVERN, text: STEAM, lasts: '1h' }], 'Steam fills the common room')] }),
        reply('A barrel smashes the floor.', { worldscrawl_patches: [patch('p_boards', 600, [{ op: 'set_description', loc: TAVERN, text: BOARDS_ON }], 'The floorboards are splintered')] }),
        user('I wait for the air to clear.', { worldscrawl_wait: { seconds: 7200 } }),
    ];
}
test('a place rebuild that fails before the call: a plain title, no ids, on the expiry card', async () => {
    const { c } = boot();
    c.chat = steamChat();
    failContext = true;
    const m = model(c, {});
    await narrate();
    assert.equal(m.count('revert'), 0, 'it failed before the model');
    const at = noticeOf(c, PLACE_EXPIRED_KIND);
    const card = mesEl(draw(c), at).querySelector('.worldscrawl_placeexpired');
    assert.match(card.textContent, /⚠ Rebuild of the description of Common Room failed\. the map could not read the description of Common Room from before that change/);
    assert.doesNotMatch(card.textContent, /desc:|riverton:/);
});

// ---- 3. one rebuild, one card
test('two place changes that wrote the same text run out together: one card, one status, one Check again; Edit starts from both', async () => {
    const { c, blocks } = boot();
    c.chat = steamChat();
    let fail = true;
    const m = model(c, { revert: () => { if (fail) throw new Error('backend down'); return JSON.stringify({ text: BOARDS }); } });
    await narrate();
    assert.equal(m.count('revert'), 2, 'one rebuild (two tries)');
    const at = noticeOf(c, PLACE_EXPIRED_KIND);
    assert.equal(c.chat[at].extra.worldscrawl_notice_places.length, 2, 'the notice names both changes');
    await flush(80);
    let doc = draw(c);
    let cards = mesEl(doc, at).querySelectorAll('.worldscrawl_placeexpired');
    assert.equal(cards.length, 1, 'one card for the one rebuild');
    const sum = cards[0].querySelector('.worldscrawl_card_summary').textContent;
    assert.match(sum, /"Smoke fills the common room" ran out/);
    assert.match(sum, /"Steam fills the common room" ran out/);
    assert.equal((cards[0].textContent.match(/Rebuild of the description of [^.]+ failed/g) ?? []).length, 1, 'the status once');
    assert.deepEqual(btns(cards[0]), ['Check again', 'Edit']);
    fail = false;
    byText(cards[0], 'Check again').click();
    await until(() => m.count('revert') === 3 && /splintered/.test(blocks.worldscrawl_facts ?? '') && !/Thick black smoke/.test((blocks.worldscrawl_facts ?? '').match(/This location: (.*)/)?.[1] ?? 'Thick black smoke'));
    assert.equal(m.count('revert'), 3);
    doc = draw(c);
    cards = mesEl(doc, at).querySelectorAll('.worldscrawl_placeexpired');
    assert.deepEqual(btns(cards[0]), ['Edit']);
    byText(cards[0], 'Edit').click();
    await until(() => openForms.size > 0);
    const form = [...openForms.values()][0];
    assert.deepEqual(form.getOps().map(o => o.text), [SMOKE, STEAM], 'the editor starts from both changes, kept for good');
    assert.ok(form.getOps().every(o => !('lasts' in o)));
    doc = draw(c);
    cards = mesEl(doc, at).querySelectorAll('.worldscrawl_placeexpired');
    const intent = cards[0].querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent');
    assert.equal(intent.value, 'Smoke fills the common room; Steam fills the common room');
    byText(cards[0], 'Approve edited').click();
    await until(() => (c.chat[at].extra.worldscrawl_patches ?? []).length > 0);
    await flush(40);
    assert.equal(c.chat[at].extra.worldscrawl_patches[0].ops.length, 2);
    doc = draw(c);
    assert.deepEqual(btns(mesEl(doc, at).querySelector('.worldscrawl_placeexpired')), [], 'the one card gives way to the kept change');
});

test('two of a person\'s changes run out together: one card for her, one status, one Check again; Edit saves one change naming both', async () => {
    const { c } = boot();
    c.chat = heskChat([['og', 'turned into a gnoll'], ['oh', 'grew horns']]);
    let fail = true;
    const m = model(c, { fields: () => { if (fail) throw new Error('backend down'); return SCARRED; }, looks: '{"looks":"a scarred landlady"}' });
    await narrate();
    assert.equal(m.count('fields'), 2, 'one rebuild (two tries)');
    const at = noticeOf(c, NPC_EXPIRED_KIND);
    assert.equal(c.chat[at].extra.worldscrawl_notice_people.length, 2);
    let doc = draw(c);
    let cards = mesEl(doc, at).querySelectorAll('.worldscrawl_npcexpired');
    assert.equal(cards.length, 1, 'one card for Hesk');
    const sum = cards[0].querySelector('.worldscrawl_card_summary').textContent;
    assert.match(sum, /Hesk: "turned into a gnoll" ran out/);
    assert.match(sum, /Hesk: "grew horns" ran out/);
    assert.equal((cards[0].textContent.match(/Appearance rebuild for Hesk failed/g) ?? []).length, 1);
    assert.deepEqual(btns(cards[0]), ['Check again', 'Edit']);
    assert.equal(jobCards(doc).length, 0);
    fail = false;
    byText(cards[0], 'Check again').click();
    await until(() => m.count('fields') === 3 && !scene.appearJobs(c.chat[2]).length);
    await flush(40);
    doc = draw(c);
    cards = mesEl(doc, at).querySelectorAll('.worldscrawl_npcexpired');
    assert.deepEqual(btns(cards[0]), ['Edit']);
    byText(cards[0], 'Edit').click();
    await flush(20);
    const card = mesEl(doc, at).querySelector('.worldscrawl_npcexpired');
    const body = card.querySelectorAll('.worldscrawl_npc_text').find(t => t.dataset.field === 'body');
    assert.equal(body.value, 'sturdy, a scar across her cheek', 'the editor starts from how she looks now');
    body.value = 'sturdy, a scar and faint stubs where horns were';
    body.dispatchEvent({ type: 'input' });
    byText(card, 'Approve edited').click();
    await until(() => (c.chat[at].extra[NPC_KEY] ?? []).some(s => s.source === 'expiry_edit' && s.committed));
    const kept = c.chat[at].extra[NPC_KEY].find(s => s.source === 'expiry_edit');
    assert.match(kept.committed.intent, /after "turned into a gnoll" and "grew horns" wore off/);
    assert.equal(npcAt(c.chat, c.chat.length - 1, [HESK], 'hesk', i => scene.npcClock(c.chat, i)).body, 'sturdy, a scar and faint stubs where horns were');
});

test('the collapse rule is one shared function: groups by any shared key, in order', () => {
    const g = C.groupExpiries([{ k: ['a'] }, { k: ['b'] }, { k: ['c', 'a'] }, { k: ['b', 'd'] }, { k: ['e'] }], x => x.k);
    assert.deepEqual(g.map(x => x.map(y => y.k.join(''))), [['a', 'ca'], ['b', 'bd'], ['e']]);
    assert.deepEqual(C.groupExpiries([{ k: ['a'] }, { k: ['b'] }, { k: ['a', 'b'] }], x => x.k).map(x => x.length), [3]);
});

test('a narrator wait kept on its card: the person notice comes at once and the rebuild after it runs on that reply, shown on the notice', async () => {
    const { c } = boot();
    const { proposeWait, keepWait } = await import('../../extension/waits.mjs');
    c.chat = heskChat();
    c.chat[2] = user('I sit down.');
    c.chat.push(reply('You wait as the hours pass.'));
    proposeWait(c.chat[3], { seconds: 7200, label: '2 hours', sleep: false, reason: 'waiting' });
    const f = gate();
    const m = model(c, { fields: () => f.p, looks: '{"looks":"a scarred landlady"}' });
    const keeping = keepWait(3);
    await until(() => m.count('fields') === 1);
    const at = noticeOf(c, NPC_EXPIRED_KIND);
    assert.equal(at, 4, 'right after the reply that waited');
    await flush(10);
    let doc = draw(c);
    assert.match(mesEl(doc, at).querySelector('.worldscrawl_npcexpired').textContent, /Appearance rebuild for Hesk: working…/);
    assert.equal(jobCards(doc).length, 0);
    f.release(Promise.reject(new Error('backend down')));
    await until(() => m.count('fields') === 2);
    await keeping;
    doc = draw(c);
    assert.match(mesEl(doc, at).querySelector('.worldscrawl_npcexpired').textContent, /Appearance rebuild for Hesk failed/);
    assert.ok(scene.appearJobs(c.chat[3]).some(j => j.status === 'failed'), 'stored on the reply');
    assert.equal(jobCards(doc).length, 0);
});
