// Two rules for what the player sees, through the production paths (the generation interceptor, the real expiry
// notice, the shared card buttons, the in-process map server and a stubbed model held at a gate):
// 1. one change that ran out is ONE expiry card, even across a vanished-room notice and a text notice;
// 2. no model call is silent: every call goes through gen() and shows on a card or on the shared busy line.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, SQUARE, TAVERN, REPO } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards, modelWait } = await import('../../extension/waits.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { PLACE_EXPIRED_KIND, openForms } = patchesExt;
const { postExpiredNotice } = await import('../../extension/expiry.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const work = await import('../../extension/work.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
const until = async (f, n = 150) => { for (let i = 0; i < n && !f(); i++) await flush(10); };
function gate() { let release; const p = new Promise(r => { release = r; }); return { p, release: v => release(v) }; }

let chats = 0;
function boot(chat) {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [], place_labels: { [TAVERN]: 'Common Room' } }] });
    const c = SillyTavern.getContext();
    const id = `ntc${++chats}`;
    exitsCache.clear(); openForms.clear();
    c.chatId = id; c.getCurrentChatId = () => id;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    ext.settings().autoKeepWaits = false;
    c.generateRaw = async () => '{}';
    c.chat = chat;
    globalThis.document = makeDoc(chat.map((_, i) => i));
    return c;
}
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const mesEl = (doc, id) => doc.querySelectorAll('.mes').find(m => m.getAttribute('mesid') === String(id));
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
const placeCards = doc => doc.querySelectorAll('.worldscrawl_placeexpired');
const look = () => ({ is_user: true, mes: 'I look around.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true } });
const narrate = () => globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');

// ---- 1. one change, one expiry card
const SMOKE = 'Smoke from the fair drifts through the low-beamed common room.';
const STALL = [{ op: 'create_place', area: 'riverton:streets', id: 'stall', name: 'Pop-up Stall', description: 'Canvas and crates.', lasts: '1h',
    exits: [{ direction: 'stall', to: SQUARE, return_direction: 'square' }] },
{ op: 'set_description', loc: TAVERN, text: SMOKE, lasts: '1h' }];
/** One change makes a pop-up stall for an hour (the party goes in) and fills the common room with smoke for the same hour; two hours pass. */
const fairChat = () => [
    { is_user: true, mes: 'I duck into the stall.', swipe_id: 0, extra: { worldscrawl_move: { to: SQUARE } } },
    { is_user: false, mes: 'A pop-up stall stands here for the fair.', swipe_id: 0, swipes: ['x'], swipe_info: [{ extra: {} }],
        extra: { worldscrawl_patches: [{ type: 'patch', id: 'fair', note: 'the fair comes to town', at: 0, swipe: 0, ops: STALL, summary: ['Pop-up Stall: new room', 'Common Room: smoke'] }] } },
    { is_user: true, mes: 'I [wait] two hours.', swipe_id: 0, extra: { worldscrawl_intent_checked: true, worldscrawl_wait: { seconds: 7200 } } },
];

for (const order of ['text notice first', 'passage notice first']) {
    test(`one change made a room and rewrote text elsewhere (${order}): ONE expiry card with the passage and the text together; Edit opens the whole change`, async () => {
        const c = boot(fairChat());
        if (order === 'text notice first') { await narrate(); await postExpiredNotice('riverton:streets/stall', SQUARE, 'square'); }
        else { await postExpiredNotice('riverton:streets/stall', SQUARE, 'square'); c.chat.push(look()); await narrate(); }
        const text = c.chat.findIndex(m => m.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND), room = c.chat.findIndex(m => m.extra?.worldscrawl_notice_expired);
        assert.ok(text > 2 && room > 2, 'both notices are in the chat (the narrator still gets both lines)');
        const host = Math.min(text, room);
        draw(c); await flush(80);
        let doc = draw(c);
        assert.equal(placeCards(doc).length, 1, 'one card for the change');
        let card = mesEl(doc, host).querySelector('.worldscrawl_placeexpired');
        assert.ok(card, 'on the first of the two notices');
        assert.deepEqual(card.querySelectorAll('.worldscrawl_card_summary li').map(li => li.textContent), ['Pop-up Stall ran out', 'Common Room: "Common Room: smoke" ran out']);
        const panel = card.querySelector('.worldscrawl_diff').textContent;
        assert.match(panel, /Canvas and crates\./, 'the room while it lasted');
        assert.match(panel, /Smoke from the fair/, 'and the smoke while it lasted');
        assert.deepEqual(btns(card), ['Edit']);
        byText(card, 'Edit').click();
        await flush(60);
        doc = globalThis.document;
        card = mesEl(doc, host).querySelector('.worldscrawl_placeexpired');
        const [key, form] = [...openForms.entries()][0];
        assert.match(key, new RegExp(`^${host}\\|expiry`));
        assert.deepEqual(form.getOps().map(o => o.op).sort(), ['create_place', 'set_description'], 'the whole change, kept for good');
        assert.ok(form.getOps().every(o => o.lasts === undefined));
        const intent = card.querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent');
        assert.equal(intent.value, 'the fair comes to town');
        byText(card, 'Approve edited').click();
        await flush(80);
        const kept = c.chat[host].extra.worldscrawl_patches ?? [];
        assert.equal(kept.length, 1, 'one kept change on that notice');
        assert.deepEqual(kept[0].ops.map(o => o.op).sort(), ['create_place', 'set_description']);
        doc = draw(c);
        assert.equal(placeCards(doc).length, 1);
        assert.deepEqual(btns(placeCards(doc)[0]), [], 'edited: done');
    });
}

test('the same change with the text lasting longer: two expiries at two times, two cards', async () => {
    const chat = fairChat();
    chat[1].extra.worldscrawl_patches[0].ops = [STALL[0], { ...STALL[1], lasts: '90m' }];
    const c = boot(chat);
    await postExpiredNotice('riverton:streets/stall', SQUARE, 'square');
    c.chat.push(look());
    await narrate();
    assert.ok(c.chat.some(m => m.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND));
    draw(c); await flush(80);
    assert.equal(placeCards(draw(c)).length, 2);
});

// ---- 2. no model call is silent
const SRC = ['extension', 'plugin'].flatMap(d => fs.readdirSync(path.join(REPO, d), { recursive: true }).filter(f => /\.m?js$/.test(f) && !/node_modules/.test(f)).map(f => path.join(d, f)));
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
test('the rule, guarded: the model is called in one place (gen), which shows every call; card claims are only the known ones', () => {
    const raw = SRC.flatMap(f => [...read(f).matchAll(/\b(generateRaw|generateQuietPrompt|sendGenerationRequest|ConnectionManagerRequestService)\s*\(/g)].map(m => `${f}: ${m[1]}`));
    assert.deepEqual(raw, ['extension/dig.mjs: generateRaw'], 'only gen() (dig.mjs) calls the model');
    const dig = read('extension/dig.mjs');
    assert.match(dig, /function gen\(kind, args, \{[^}]*shown = null \} = \{\}\) \{\n\s+return withCall\(kind, shown, \(\) => genNow\(/, 'gen runs every call through withCall');
    assert.equal([...dig.matchAll(/\bgenNow\(/g)].length, 2, 'genNow: its definition and gen, nothing else');
    // ST's own reply (its own indicator) is the only other generation.
    const replies = SRC.flatMap(f => [...read(f).matchAll(/\.generate\(\s*'normal'/g)].map(() => f));
    assert.deepEqual(replies.sort(), ['extension/index.js', 'extension/movement.mjs']);
    const claims = SRC.flatMap(f => [...read(f).matchAll(/shown: '(\w+)'/g)].map(m => m[1]));
    assert.ok(claims.length >= 5);
    for (const s of claims) assert.ok(work.CALL_SHOWN.includes(s), s);
    // Every kind the source asks with has words for the busy line (never the plain fallback).
    const kinds = SRC.flatMap(f => [...read(f).matchAll(/\bgen\(\s*'([^']+)'|askValid\(\s*'([^']+)'|askTried\(\s*'([^']+)'|askModel\(c, '([^']+)'/g)].map(m => m[1] ?? (m[2] ? `pick: ${m[2]}` : m[3] ?? `map edit: ${m[4]}`)));
    assert.ok(kinds.length >= 15, kinds.join());
    for (const k of kinds) assert.notEqual(work.callLabel(k), 'working', k);
});

test('a call no card shows (a loose wait amount) shows the busy line under the latest message while it runs, then it goes', async () => {
    const c = boot([{ is_user: true, mes: 'I wait.', swipe_id: 0, extra: {} }]);
    const g = gate();
    c.generateRaw = () => g.p;
    const asking = modelWait('a little while');
    await until(() => work.liveCalls().length === 1);
    await flush(10);
    const line = globalThis.document.querySelector('.worldscrawl_busymark');
    assert.ok(line, 'the busy line');
    assert.equal(line.textContent, 'WorldScrawl: working out how long you wait…');
    assert.ok(mesEl(globalThis.document, 0).querySelector('.worldscrawl_busymark'), 'under the latest message');
    g.release('{"seconds": 600}');
    assert.deepEqual(await asking, { seconds: 600 });
    await flush(10);
    assert.equal(globalThis.document.querySelector('.worldscrawl_busymark'), null);
});

test('the who / disposition picks in prepareNpcs show on the busy line during the reply', async () => {
    const c = boot([{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } },
        { is_user: true, mes: 'I wave at everyone in the room.', swipe_id: 0, extra: {} }]);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) for (const n of w.cast ?? []) if (n.id === 'hesk') { n.schedule = [{ place: TAVERN, activity: 'pouring drinks', from: '00:00', to: '23:59', fromMin: 0, toMin: 1439, importance: 'high' }]; delete n.disposition; } // all day in the common room, a first meeting: her attitude is asked
    rememberWorlds(worlds); // Hesk pours drinks in the common room all day
    const seen = [];
    c.generateRaw = async () => { await flush(5); seen.push(globalThis.document.querySelector('.worldscrawl_busymark')?.textContent ?? ''); return 'friendly'; };
    await (await import('../../extension/scene.mjs')).prepareNpcs(c.chat[1]);
    assert.ok(seen.length, 'side calls ran');
    assert.ok(seen.every(t => /^WorldScrawl: .+…$/.test(t)), JSON.stringify(seen));
    assert.ok(seen.some(t => /how they feel about you|who you're talking to/.test(t)), JSON.stringify(seen));
});

test('the shared status: a call its card shows (the tracker\'s "tracking…") stays off the busy line; one with no card is on it', async () => {
    const c = boot([]);
    let during = null;
    await work.withCall('tracker', 'marker', async () => { await flush(10); during = { calls: work.liveCalls().length, lines: work.busyLines() }; });
    assert.deepEqual(during, { calls: 1, lines: [] });
    await work.withCall('intent', null, async () => { await flush(10); during = work.busyLines(); });
    assert.deepEqual(during, ['reading your move']);
    assert.equal(work.liveCalls().length, 0);
    void c;
});
