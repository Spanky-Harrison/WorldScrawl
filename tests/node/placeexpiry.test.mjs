// A timed place text change that runs out gets an expiry notice and card like a person's: what changed back (the shared
// before/now diff), Edit through the shared map editor, and the text rebuild after it shown on the card (working, then
// failed with Check again). Through the production paths: the generation interceptor, the wait card's keep, the real map
// server in-process, a stubbed model and the shared card layer's buttons.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN, YARD } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards, keepWait, proposeWait } = await import('../../extension/waits.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { PLACE_EXPIRED_KIND, openForms } = patchesExt;
const { rememberWorlds, loadCalendar, chatChanges } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const COMMON_WAS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE_BOARDS = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const SOOTY_DOOR = 'A back door to the courtyard, black with soot.';
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
    const calls = [];
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        if (!isRevert(p)) return '{}';
        calls.push(p);
        return typeof revert === 'function' ? revert(p) : revert;
    };
    return calls;
}
const patch = (id, at, ops, note, extra = {}) => ({ type: 'patch', id, at, ops, note, summary: [note], swipe: 0, ...extra });
const ai = (mes, patches) => ({ is_user: false, mes, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra: patches ? { worldscrawl_patches: patches } : {} });
const user = (mes, seconds = 0) => ({ is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true, ...(seconds ? { worldscrawl_wait: { seconds } } : {}) } });
const SMOKE_P = () => patch('p_smoke', 0, [{ op: 'set_description', loc: TAVERN, text: SMOKE, lasts: '1h' }], 'Smoke fills the common room');
const BOARDS_P = () => patch('p_boards', 600, [{ op: 'set_description', loc: TAVERN, text: SMOKE_BOARDS }], 'The floorboards by the hearth are splintered');

let chats = 0;
/** Smoke for an hour; a permanent change written on top of it at 10 min (`boards`); a player turn two hours on. */
function boot({ boards = true, extra = [] } = {}) {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [] }] });
    const c = SillyTavern.getContext();
    const id = `pexp${++chats}`;
    exitsCache.clear(); openForms.clear();
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    ext.settings().autoKeepWaits = false;
    c.chat = [
        { is_user: true, mes: 'I step into the inn.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        ai('A pot boils over and smoke pours out.', [SMOKE_P(), ...extra]),
        ...(boards ? [ai('A barrel rolls and smashes the floorboards.', [BOARDS_P()])] : [ai('The smoke hangs in the air.')]),
        user('I wait for the air to clear.', 7200),
    ];
    return { c, blocks };
}
const facts = blocks => blocks.worldscrawl_facts ?? '';
const here = blocks => facts(blocks).match(/This location: (.*)/)?.[1] ?? '';
const narrate = () => globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const mesEl = (doc, id) => doc.querySelectorAll('.mes').find(m => m.getAttribute('mesid') === String(id));
const cardsIn = (doc, id) => mesEl(doc, id)?.querySelectorAll('.worldscrawl_placeexpired') ?? [];
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
const noticeAt = c => c.chat.findIndex(m => m.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND);
const until = async (f, n = 100) => { for (let i = 0; i < n && !f(); i++) await flush(10); };

test('smoke runs out under a later change: the notice is posted before the rebuild, the card shows it working, then what changed back with Edit', async () => {
    const { c, blocks } = boot();
    let release;
    const gate = new Promise(r => { release = r; });
    const calls = model(c, () => gate.then(() => JSON.stringify({ text: BOARDS })));
    const turn = narrate();
    await until(() => calls.length === 1);
    // The notice sits right after the player message, and the card says the rebuild is working (no silent call).
    const at = noticeAt(c);
    assert.equal(at, 4);
    assert.equal(c.chat[at].mes, '[Engine: The temporary change "Smoke fills the common room" ran out.]');
    assert.equal(c.chat[at].is_system, true);
    const item = c.chat[at].extra.worldscrawl_notice_places[0];
    assert.deepEqual([item.id, item.ops, item.targets, item.ends], ['p_smoke', [0], [`desc:${TAVERN}`], 3600]);
    let doc = draw(c);
    let card = cardsIn(doc, at)[0];
    assert.ok(card, 'the place expiry card');
    assert.match(card.textContent, /Rebuild of the description of Common Room: working…/);
    assert.equal(mesEl(doc, 3).querySelector('.worldscrawl_appearpending'), null, 'no job card on the player message');
    release();
    await turn;
    assert.equal(calls.length, 1);
    assert.equal(here(blocks), BOARDS, 'the narrator reads the rebuilt text');
    doc = draw(c);
    await flush(80);
    card = cardsIn(doc, at)[0];
    assert.match(card.querySelector('.worldscrawl_card_summary').textContent, /Common Room: "Smoke fills the common room" ran out/);
    assert.doesNotMatch(card.textContent, /working|failed/);
    const panel = card.querySelector('.worldscrawl_diff');
    assert.ok(panel, 'the before/now panel');
    assert.match(panel.textContent, /Thick black smoke/, 'before: with the smoke');
    assert.match(panel.textContent, /splintered floorboards/, 'now: the rebuilt text');
    assert.deepEqual(btns(card), ['Edit']);
    // The next turn: no second notice for the same expiry, no second call.
    c.chat.push(ai('The air clears.'), user('I look around.', 60));
    await narrate();
    assert.equal(c.chat.filter(m => m.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND).length, 1);
    assert.equal(calls.length, 1);
});

test('a failed rebuild: the failure and Check again are on the expiry card (no job card); Check again shows working, rebuilds, refreshes the facts, and the card returns to Edit', async () => {
    const { c, blocks } = boot();
    let fail = true, release = null;
    const calls = model(c, () => { if (fail) throw new Error('backend down'); return new Promise(r => { release = () => r(JSON.stringify({ text: BOARDS })); }); });
    await narrate();
    assert.equal(calls.length, 2, 'two tries');
    assert.equal(here(blocks), SMOKE_BOARDS, 'the narrator went ahead with the plain replay');
    assert.equal(c.chat[3].extra[JOBS].jobs.find(j => j.domain === 'place')?.status, 'failed', 'the job is on the player message');
    const at = noticeAt(c);
    let doc = draw(c);
    let card = cardsIn(doc, at)[0];
    assert.match(card.textContent, /⚠ Rebuild of the description of Common Room failed\. backend down/);
    assert.deepEqual(btns(card), ['Check again', 'Edit']);
    assert.equal(mesEl(doc, 3).querySelector('.worldscrawl_appearpending'), null, 'the stand-alone job card is hidden');
    fail = false;
    const b = byText(card, 'Check again');
    b.click(); b.click();
    await until(() => !!release);
    doc = draw(c);
    card = cardsIn(doc, at)[0];
    assert.match(card.textContent, /Rebuild of the description of Common Room: working…/, 'Check again shows it working');
    assert.deepEqual(btns(card), ['Edit']);
    release();
    await until(() => !(c.chat[3].extra[JOBS]?.jobs ?? []).length && here(blocks) === BOARDS);
    await flush(30);
    assert.equal(calls.length, 3, 'one more call for a double click');
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
    assert.equal(here(blocks), BOARDS, 'the narrator facts were refreshed');
    doc = draw(c);
    card = cardsIn(doc, at)[0];
    assert.doesNotMatch(card.textContent, /failed|working/);
    assert.deepEqual(btns(card), ['Edit']);
});

test('Check again on a notice deleted before the click writes nothing', async () => {
    const { c } = boot();
    const calls = model(c, () => { throw new Error('backend down'); });
    await narrate();
    const at = noticeAt(c), doc = draw(c);
    const b = byText(cardsIn(doc, at)[0], 'Check again');
    c.chat.splice(at, 1);
    b.click();
    await flush(60);
    assert.equal(calls.length, 2, 'no new call');
    assert.equal(c.chat[3].extra[JOBS].jobs.find(j => j.domain === 'place')?.status, 'failed');
    // With the notice gone, nothing covers the failure: the job card shows it on the player message.
    const doc2 = draw(c);
    assert.ok(mesEl(doc2, 3).querySelector('.worldscrawl_appearpending'));
});

test('Edit starts from the change that ran out (kept for good); Approve edited stamps a kept change on the notice for that card only', async () => {
    // Two changes run out in the same wait: smoke in the common room, soot on the back door (another change). Nothing
    // was written on top of either, so there is no rebuild call.
    const { c, blocks } = boot({ boards: false, extra: [patch('p_soot', 0, [{ op: 'set_exit_description', loc: TAVERN, direction: 'back', text: SOOTY_DOOR, lasts: '30m' }], 'Soot blackens the back door')] });
    const calls = model(c, () => { throw new Error('no call expected'); });
    await narrate();
    assert.equal(calls.length, 0);
    assert.equal(here(blocks), COMMON_WAS, 'the plain replay');
    const at = noticeAt(c);
    assert.equal(c.chat[at].mes, '[Engine: The temporary change "Soot blackens the back door" ran out. The temporary change "Smoke fills the common room" ran out.]');
    let doc = draw(c);
    await flush(80);
    doc = draw(c);
    let cards = cardsIn(doc, at);
    assert.equal(cards.length, 2, 'one card per change, in the order they ran out');
    assert.match(cards[0].textContent, /"Soot blackens the back door" ran out/);
    assert.match(cards[0].querySelector('.worldscrawl_diff').textContent, /black with soot/);
    assert.match(cards[1].textContent, /Common Room: "Smoke fills the common room" ran out/);
    assert.match(cards[1].querySelector('.worldscrawl_diff').textContent, /Thick black smoke/);
    byText(cards[1], 'Edit').click();
    await flush(80);
    doc = draw(c);
    cards = cardsIn(doc, at);
    assert.deepEqual(btns(cards[1]), ['Close editor', 'Approve edited']);
    assert.deepEqual(btns(cards[0]), ['Edit'], 'the other card is not in edit mode');
    assert.ok(cards[1].querySelector('.worldscrawl_card_editor .wspf'), 'the shared map form');
    const intent = cards[1].querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent');
    assert.equal(intent.value, 'Smoke fills the common room');
    intent.value = 'a faint smell of smoke stays';
    intent.dispatchEvent({ type: 'input' });
    byText(cards[1], 'Approve edited').click();
    await until(() => (c.chat[at].extra.worldscrawl_patches ?? []).length > 0);
    await flush(60);
    const kept = c.chat[at].extra.worldscrawl_patches;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].source, 'expiry_edit');
    assert.equal(kept[0].expiry, c.chat[at].extra.worldscrawl_notice_places[1].key);
    assert.equal(kept[0].ops[0].op, 'set_description');
    assert.equal('lasts' in kept[0].ops[0], false, 'kept for good');
    assert.equal(here(blocks), SMOKE, 'the narrator facts have the kept text');
    doc = draw(c);
    cards = cardsIn(doc, at);
    assert.deepEqual(btns(cards[1]), [], 'the edited card gives way to the kept change');
    assert.deepEqual(btns(cards[0]), ['Edit'], 'the other card still has Edit');
});

test('no notice for a change turned off, a change with no text, or one still in force', async () => {
    const { c } = boot({ boards: false, extra: [patch('p_exit', 0, [{ op: 'add_exit', loc: TAVERN, direction: 'hole', to: YARD, lasts: '1h' }], 'A hole in the wall')] });
    c.chat[1].extra.worldscrawl_patches[0].off = true;
    c.chat.splice(2, 0, ai('Mist.', [patch('p_mist', 0, [{ op: 'set_description', loc: YARD, text: 'Mist fills the yard.', lasts: '1d' }], 'Mist')]));
    model(c, '{}');
    await narrate();
    assert.equal(noticeAt(c), -1);
});

test('a narrator wait kept on its card: the notice comes at once, the rebuild runs on that reply and shows on the card', async () => {
    const { c, blocks } = boot();
    c.chat[3] = user('I sit down.');
    c.chat.push(ai('You wait as the smoke slowly clears.'));
    proposeWait(c.chat[4], { seconds: 7200, label: '2 hours', sleep: false, reason: 'the smoke' });
    let fail = true;
    const calls = model(c, () => { if (fail) throw new Error('backend down'); return JSON.stringify({ text: BOARDS }); });
    assert.equal(await keepWait(4), '');
    const at = noticeAt(c);
    assert.equal(at, 5, 'right after the reply that waited');
    assert.equal(calls.length, 2);
    assert.equal(c.chat[4].extra[JOBS].jobs.find(j => j.domain === 'place')?.status, 'failed', 'the job is on the reply');
    const doc = draw(c);
    const card = cardsIn(doc, at)[0];
    assert.deepEqual(btns(card), ['Check again', 'Edit']);
    assert.equal(mesEl(doc, 4).querySelector('.worldscrawl_appearpending'), null);
    fail = false;
    byText(card, 'Check again').click();
    await until(() => here(blocks) === BOARDS);
    assert.equal(calls.length, 3);
    // The player's next turn: no second notice, no second call.
    c.chat.push(user('I look around.'));
    await narrate();
    assert.equal(c.chat.filter(m => m.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND).length, 1);
    assert.equal(calls.length, 3);
});

test('a rebuild with no expiry notice (Turn off) is never silent either: the job card shows it working', async () => {
    const { c } = boot();
    c.chat[1].extra.worldscrawl_patches[0].ops[0].lasts = '1d'; // still in force: nothing runs out
    c.chat[3].extra.worldscrawl_wait.seconds = 60;
    let release;
    const calls = model(c, () => new Promise(r => { release = () => r(JSON.stringify({ text: BOARDS })); }));
    await narrate();
    assert.equal(noticeAt(c), -1);
    draw(c);
    const off = patchesExt.toggleChange(1, 'p_smoke', { choice: 'one' });
    await until(() => !!release);
    let doc = draw(c);
    const job = mesEl(doc, c.chat.length - 1).querySelector('.worldscrawl_appearpending');
    assert.ok(job, 'the job card on the latest message');
    assert.match(job.textContent, /Rebuild of the description of Common Room: working…/);
    release();
    await off;
    assert.equal(calls.length, 1);
    doc = draw(c);
    assert.equal(doc.querySelector('.worldscrawl_appearpending'), null, 'gone once it landed');
    assert.equal(chatChanges().find(x => x.id === 'p_boards').ops[0].text, BOARDS);
});
