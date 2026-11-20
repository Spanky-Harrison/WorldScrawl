// 4-R1b: the ownership guard (T2b, no model call) and the retry setting for an unreadable tracker answer (T7), through
// the real handlers: onReplyForFlags -> runTracker -> applyTrackerResult with a fake model routed by isTrackerCall, the
// marker and cards drawn by renderPatchCards on fakedom with real clicks, trackerSettled, onStorySwipe and the settings panel.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const N = await import('../../extension/names.mjs');
const T = await import('../../extension/tracker.mjs');
const D = await import('../../extension/discovery.mjs');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { messageActivity } = await import('../../extension/activity.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { addSettingsPanel } = await import('../../extension/settings.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar } = CLK;
await loadCalendar();
const { onReplyForFlags, onStorySwipe, trackerSettled, TRACKER_WAIT } = D;
const { ownerCheck, RIVAL_NOUNS, UNLISTED_RIVAL_DROPS } = T;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const NPC = 'worldscrawl_npc', WARN = 'worldscrawl_npcwarn';
const GOOD = { place: null, people: [], wait: null };
const CUT = '{"place": null, "people": [{"id":';

let n = 0;
/** A fresh Riverton chat at 17:00 in the common room (Hesk, "the landlady", is at the bar). `tracker` answers each
 *  tracker call: a list is used in order (the last one repeats), a function gets the call number. `two`: Corwin is
 *  remembered and following the player. Every tracker call records the marker text drawn at that moment. */
function boot({ tracker = GOOD, retry = undefined, count = undefined, autoKeep = false, two = false, delay = 0 } = {}) {
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
    const c = SillyTavern.getContext(), id = `r1b${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { c.chat.push({ is_user: true, mes: cmd.replace(/^\/send /, ''), swipe_id: 0, extra: {} }); };
    const seen = [], marks = [];
    c.generateRaw = async args => {
        if (!isTrackerCall(args)) return /Looks line/.test(String(args?.prompt ?? '')) ? '{"looks":"a big woman with copper braids"}' : '{}';
        const k = seen.length;
        seen.push(args);
        marks.push(globalThis.document?.querySelector?.('.worldscrawl_trackmark')?.textContent ?? null);
        if (delay) await new Promise(r => setTimeout(r, delay));
        const a0 = typeof tracker === 'function' ? tracker(k) : Array.isArray(tracker) ? tracker[Math.min(k, tracker.length - 1)] : tracker;
        const a = typeof a0 === 'function' ? a0() : a0; // a function: built at call time, when the chat's handles are set
        return typeof a === 'string' ? a : JSON.stringify(a);
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    const s = ext.settings();
    delete s.trackerRetry; delete s.trackerRetryCount;
    Object.assign(s, { flagNpcs: true, flagTags: true, autoKeep, autoKeepWaits: true, moveMode: 'buttons' }, retry ? { trackerRetry: retry } : {}, count ? { trackerRetryCount: count } : {});
    const first = { is_user: false, mes: 'Evening in the common room. The landlady pours ale.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } };
    if (two) first.extra[NPC] = [{ type: 'npc_create', id: 'corwin', name: 'Corwin', line: 'a ferryman with a tarred coat' }, { type: 'npc_follow', id: 'corwin' }];
    c.chat = [first];
    return { c, calls: () => seen.length, marks };
}
const say = (c, text) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra: { worldscrawl_intent_checked: true } }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
const hesk = () => N.handleOf('hesk');
const stamps = (m, type) => (m.extra?.[NPC] ?? []).filter(s => !type || s.type === type);
/** Point the fake DOM at every message, then draw. */
function draw(c) { const doc = makeDoc(c.chat.map((_, i) => i)); globalThis.document = doc; renderPatchCards(); return doc; }
const markOf = (doc, id) => doc.querySelector(`.mes[mesid="${id}"]`)?.querySelector('.worldscrawl_trackmark') ?? null;
const btns = el => (el?.querySelectorAll('.worldscrawl_card_btn') ?? []).map(b => b.textContent);
async function exchange(c, player, story) { say(c, player); const id = reply(c, story); globalThis.document = makeDoc(c.chat.map((_, i) => i)); await onReplyForFlags(id); await flush(40); return id; }
const soaked = (extra = {}) => ({ place: null, people: [{ id: hesk(), action: 'appearance', intent: 'cloak soaked through', fields: 'outfit', lasts: '2h', scope: 'light', why: 'only the cloak', ...extra }], wait: null });

// ================================================================ T2b, the ownership guard (prompt-plan R1 test 3)
// Review round 1: an owner found only by the rival-noun list warns (the item stays a card); only a named listed person drops.
const STRANGER_WARN = 'This change may belong to the stranger, not the landlady; check it.';
for (const autoKeep of [false, true]) {
    test(`3a: "A stranger stumbles in from the rain, her cloak soaked through." on the landlady's handle is a warned card, not applied and not dropped${autoKeep ? ' (auto-keep on)' : ''}`, async () => {
        const { c } = boot({ autoKeep, tracker: () => soaked() });
        const id = await exchange(c, 'I watch the door.', 'A stranger stumbles in from the rain, her cloak soaked through.');
        const m = c.chat[id];
        const o = stamps(m, 'npc_appearance')[0];
        assert.ok(o, 'not dropped: the item stays');
        assert.equal(o.committed ?? null, null, 'not applied: a card for the player');
        assert.deepEqual((m.extra[WARN] ?? []).map(w => [w.text, w.source]), [[STRANGER_WARN, 'tracker']]);
        assert.equal(notes(m).some(x => x.kind === 'tracker owner'), false, 'no drop note');
        assert.ok(messageActivity(m, id).some(e => (e.reason ?? '').includes(STRANGER_WARN)), 'the warning is in the Activity log');
        const el = draw(c).querySelector(`.mes[mesid="${id}"]`);
        assert.ok(el.querySelector('.worldscrawl_card_person'), 'the review card is drawn');
        assert.ok(el.textContent.includes(`⚠ ${STRANGER_WARN}`));
    });
}
test('3a, a fact too: the stranger\'s line about the ferry stays a pending fact card with the warning', async () => {
    const { c } = boot({ tracker: () => ({ place: null, people: [{ id: hesk(), action: 'fact', text: 'runs the ferry at night' }], wait: null }) });
    const id = await exchange(c, 'I ask who runs the ferry.', 'A stranger by the hearth says he runs the ferry at night.');
    assert.deepEqual(stamps(c.chat[id], 'npc_fact').map(s => [s.text, s.pending]), [['runs the ferry at night', true]]);
    assert.deepEqual((c.chat[id].extra[WARN] ?? []).map(w => w.text), [STRANGER_WARN]);
    assert.equal(notes(c.chat[id]).some(x => x.kind === 'tracker owner'), false);
});
for (const autoKeep of [false, true]) {
    test(`3b: "She wrings out her soaked cloak." with nobody named is kept with a warning on its card${autoKeep ? ' (auto-keep on: still a card)' : ''}`, async () => {
        const { c } = boot({ autoKeep, tracker: () => soaked() });
        const id = await exchange(c, 'I wait by the fire.', 'She wrings out her soaked cloak.');
        const m = c.chat[id];
        const o = stamps(m, 'npc_appearance')[0];
        assert.ok(o, 'the item stays');
        assert.equal(o.committed ?? null, null, 'a card for the player, not kept on its own');
        assert.deepEqual((m.extra[WARN] ?? []).map(w => [w.text, w.source]), [["This reply never names the landlady; check this change is really the landlady's.", 'tracker']]);
        const doc = draw(c);
        assert.match(doc.querySelector(`.mes[mesid="${id}"]`).textContent, /⚠ This reply never names the landlady; check this change is really the landlady's\./);
        assert.ok(doc.querySelector(`.mes[mesid="${id}"]`).querySelector('.worldscrawl_card_person'), 'the review card is drawn');
    });
}
test('3c: "The landlady wrings out her soaked cloak." is kept with no warning', async () => {
    const { c } = boot({ tracker: () => soaked() });
    const id = await exchange(c, 'I wait by the fire.', 'The landlady wrings out her soaked cloak.');
    assert.equal(stamps(c.chat[id], 'npc_appearance').length, 1);
    assert.equal(c.chat[id].extra[WARN], undefined);
    assert.equal(notes(c.chat[id]).some(x => x.kind === 'tracker owner'), false);
});
test('3c: named in the player\'s own line counts too', async () => {
    const { c } = boot({ tracker: () => soaked() });
    const id = await exchange(c, 'I hand the landlady a towel.', 'She wrings out her soaked cloak.');
    assert.equal(stamps(c.chat[id], 'npc_appearance').length, 1);
    assert.equal(c.chat[id].extra[WARN], undefined);
});
test('3d: two listed people; "Corwin\'s boots are caked in mud" on the landlady\'s handle is dropped', async () => {
    const { c } = boot({ two: true, tracker: () => ({ place: null, people: [{ id: hesk(), action: 'appearance', intent: 'boots caked in mud', fields: 'outfit', lasts: '2h', scope: 'light', why: 'boots' }], wait: null }) });
    const id = await exchange(c, 'I look at the ferryman.', "Corwin's boots are caked in mud.");
    const listed = scene.listedPeople(c.chat, id, { address: TAVERN }).map(p => p.name).sort();
    assert.deepEqual(listed, ['Corwin', 'the landlady'], 'both are listed');
    assert.deepEqual(stamps(c.chat[id], 'npc_appearance'), []);
    assert.ok(notes(c.chat[id]).some(x => x.kind === 'tracker owner' && x.reason === "tracker item dropped: the change reads as Corwin's, not the landlady's"), JSON.stringify(notes(c.chat[id])));
});
test('3e: a memory item with the landlady unnamed is kept (the guard covers appearance and fact only)', async () => {
    const { c } = boot({ tracker: () => ({ place: null, people: [{ id: hesk(), action: 'memory', text: 'the player paid for the whole room' }], wait: null }) });
    const id = await exchange(c, 'I pay for everyone.', 'A stranger raises his mug. She counts the coins twice.');
    assert.deepEqual(stamps(c.chat[id], 'npc_memory').map(s => s.text ?? s.note), ['the player paid for the whole room']);
    assert.equal(c.chat[id].extra[WARN], undefined);
    assert.equal(notes(c.chat[id]).some(x => x.kind === 'tracker owner'), false);
});
test('3f: ownerCheck (pure): only a named listed person drops; the noun list still finds an unlisted owner, which warns', () => {
    const P = { name: 'Hesk', unknownAs: 'the landlady', nameKnown: false, label: 'the landlady' };
    const COR = { name: 'Corwin', nameKnown: true, label: 'Corwin' };
    const it = { action: 'appearance', intent: 'cloak soaked through' };
    const r = (text, listed = [], person = P, item = it) => ownerCheck(item, person, text, listed);
    const v = (...a) => r(...a).verdict;
    assert.equal(UNLISTED_RIVAL_DROPS, false, 'review round 1: the noun list warns, it does not drop');
    assert.equal(v('The landlady stands in the rain, her cloak soaked through.'), 'keep', '"the landlady" names her, never a rival while she is listed');
    assert.equal(v('Landlady, your cloak is soaked through!'), 'keep', 'unknownAs without its article');
    assert.equal(v('Hesk wrings out her soaked cloak.'), 'warn', 'her real name does not count before the player knows it');
    assert.equal(v('Hesk wrings out her soaked cloak.', [], { ...P, nameKnown: true, label: 'Hesk' }), 'keep');
    assert.equal(v('Red wrings out her soaked cloak.', [], { ...P, aliases: ['Red'] }), 'keep', 'an alias');
    // The noun list is kept: every noun is still found as the likely owner, and named in the warning.
    for (const noun of RIVAL_NOUNS) {
        const got = r(`The ${noun} comes in, cloak soaked through.`);
        assert.equal(got.verdict, 'warn', noun);
        assert.equal(got.rival, `the ${noun.replace(/^men$/, 'man').replace(/^women$/, 'woman')}`, noun);
    }
    for (const [text, rival] of [['One of the patrons shakes out a soaked cloak.', 'the patron'], ['An old, grizzled sailor stamps in; his cloak is soaked.', 'the sailor'],
        ['A stranger stumbles in. Her cloak is soaked through.', 'the stranger'], ['The figure by the door wrings out a soaked cloak.', 'the figure'], ['The drunk spills ale; his cloak is soaked.', 'the drunk']]) {
        assert.deepEqual(r(text), { verdict: 'warn', reason: `This change may belong to ${rival}, not the landlady; check it.`, rival }, text);
    }
    assert.equal(r('A stranger stumbles in. The fire crackles. Her cloak is soaked through.').rival, undefined, 'not two sentences back: the plain warning');
    assert.equal(r('A stranger nods. The cloak by the fire is soaked.').reason, "This reply never names the landlady; check this change is really the landlady's.", 'another sentence without a pronoun lead');
    assert.equal(v('The man says he runs the ferry at night.', [], P, { action: 'fact', text: 'runs the ferry at night' }), 'warn', 'facts read their text');
    // Drops: a named listed person only.
    assert.equal(v("Corwin's cloak is soaked through.", [COR]), 'drop', 'a listed person named in the same sentence');
    assert.equal(v('Corwin laughs. She shakes her soaked cloak.', [COR]), 'drop', 'a listed person named in the sentence before a pronoun lead');
    assert.equal(v('A stranger and Corwin come in, cloaks soaked through.', [COR]), 'drop', 'a named listed person wins over a noun-list phrase');
    assert.equal(v('A stranger stumbles in, cloak soaked. Corwin laughs.', [COR]), 'warn', 'a listed person in another sentence is not the owner');
    assert.equal(v('The old man shakes his soaked cloak.', [], { name: 'Bram', unknownAs: 'the old man', nameKnown: false, label: 'the old man' }), 'keep', 'her own unknownAs is a name, not a rival');
    assert.equal(v('The old man shakes his soaked cloak.', [{ name: 'Bram', unknownAs: 'the old man', nameKnown: false, label: 'the old man' }]), 'drop', 'a listed person named by what the list calls them');
    assert.equal(v('She shakes her soaked cloak.', [COR]), 'warn', 'no gender guessing between two listed people');
    assert.equal(r("Corwin's cloak is soaked through.", [COR]).reason, "tracker item dropped: the change reads as Corwin's, not the landlady's");
    assert.match(r('Her cloak is soaked.', [], { ...P, label: 'Wells' }).reason, /check this change is really Wells'\.$/);
});

// ================================================================ T7 retry: off / ask / auto
test('the retry setting defaults to ask with one retry', () => {
    boot();
    assert.equal(D.trackerRetryMode(), 'ask');
    assert.equal(D.trackerRetryCount(), 1);
    Object.assign(ext.settings(), { trackerRetry: 'bogus', trackerRetryCount: 9 });
    assert.equal(D.trackerRetryMode(), 'ask');
    assert.equal(D.trackerRetryCount(), 3);
    ext.settings().trackerRetryCount = 0;
    assert.equal(D.trackerRetryCount(), 1);
});
test('off: cut-off JSON is one call, a failed call note, nothing stamped, and the plain "tracking failed" marker with no button', async () => {
    const { c, calls } = boot({ retry: 'off', tracker: [CUT, soaked] });
    const id = await exchange(c, 'I nod.', 'The landlady nods back.');
    assert.equal(calls(), 1);
    assert.ok(notes(c.chat[id]).some(x => x.kind === 'tracker' && x.status === 'failed' && x.reason === 'the answer was not JSON'));
    assert.deepEqual(stamps(c.chat[id]), []);
    const mark = markOf(draw(c), id);
    assert.equal(mark.textContent, 'tracking failed');
    assert.deepEqual(btns(mark), []);
});
test('ask: the failed marker is the shared card with Retry on the latest reply only; one click is one call, shown as "try 2", and a good answer stamps', async () => {
    const { c, calls, marks } = boot({ retry: 'ask', tracker: [CUT, soaked] });
    const id = await exchange(c, 'I nod.', 'The landlady wrings out her soaked cloak.');
    assert.equal(calls(), 1, 'ask makes no second call on its own');
    assert.equal(T.trackMark(c.chat[id]), 'failed');
    let doc = draw(c);
    const card = markOf(doc, id);
    assert.ok(card.className.includes('worldscrawl_card_track'), card.className);
    assert.match(card.textContent, /^tracking failed: the answer could not be read\. Nothing was added\./);
    assert.deepEqual(btns(card), ['Retry']);
    assert.equal(card.querySelector('.worldscrawl_card_btn').title, 'Read this reply again for changes');
    card.querySelector('.worldscrawl_card_btn').click();
    await flush(60);
    assert.equal(calls(), 2, 'exactly one more call');
    assert.equal(marks[1], 'tracking… (try 2)', 'the try shows on the marker while it runs');
    assert.equal(stamps(c.chat[id], 'npc_appearance').length, 1, 'the good answer stamped');
    assert.equal(T.trackMark(c.chat[id]), '', 'its card stands in for the marker');
    assert.ok(notes(c.chat[id]).some(x => x.kind === 'tracker' && x.status === 'ok'));
    doc = draw(c);
    assert.equal(doc.querySelector('.worldscrawl_card_track'), null);
});
test('ask: a Retry that fails again says so and offers Retry again ("try 3" next)', async () => {
    const { c, calls, marks } = boot({ retry: 'ask', tracker: [CUT, 'Nothing.', GOOD] });
    const id = await exchange(c, 'I nod.', 'The landlady nods back.');
    markOf(draw(c), id).querySelector('.worldscrawl_card_btn').click(); await flush(60);
    assert.ok(notes(c.chat[id]).some(x => x.reason === 'the answer was not JSON (try 2)'), JSON.stringify(notes(c.chat[id])));
    const card = markOf(draw(c), id);
    assert.match(card.textContent, /could not be read \(2 tries\)/);
    card.querySelector('.worldscrawl_card_btn').click(); await flush(60);
    assert.equal(calls(), 3);
    assert.deepEqual(marks.slice(1), ['tracking… (try 2)', 'tracking… (try 3)']);
    assert.equal(T.trackMark(c.chat[id]), 'tracked');
});
test('ask: the Retry card is only under the latest story reply; a stale card writes nothing', async () => {
    const { c, calls } = boot({ retry: 'ask', tracker: [CUT, GOOD] });
    const first = await exchange(c, 'I nod.', 'The landlady nods back.');
    let doc = draw(c);
    const old = markOf(doc, first).querySelector('.worldscrawl_card_btn');
    const second = await exchange(c, 'I sit.', 'The fire crackles.');
    doc = draw(c);
    assert.equal(markOf(doc, first), null, 'not under an older reply');
    assert.equal(doc.querySelectorAll('.worldscrawl_card_track').length, 0, 'the latest read went fine');
    assert.equal(T.trackMark(c.chat[second]), 'tracked');
    const before = calls();
    c.chat[first].swipe_id = 0; c.chat[first].extra.worldscrawl_tracked = { swipe: 0, status: 'tracked' }; // that read is no longer the failed one
    old.click(); await flush(40);
    assert.equal(calls(), before, 'the old drawing is stale: no call');
});
test('auto, count 2: garbage, garbage, then valid is three calls, each try on the marker, and the result stamped', async () => {
    const { c, calls, marks } = boot({ retry: 'auto', count: 2, tracker: ['nope', CUT, soaked] });
    const id = await exchange(c, 'I nod.', 'The landlady wrings out her soaked cloak.');
    assert.equal(calls(), 3);
    assert.deepEqual(marks, ['tracking…', 'tracking… (try 2 of 3)', 'tracking… (try 3 of 3)']);
    assert.deepEqual(notes(c.chat[id]).filter(x => x.kind === 'tracker' && x.status === 'failed').map(x => x.reason), ['the answer was not JSON (try 1 of 3)', 'the answer was not JSON (try 2 of 3)']);
    assert.equal(stamps(c.chat[id], 'npc_appearance').length, 1);
});
test('auto, count 1: two unreadable answers end failed with the Retry card ("2 tries")', async () => {
    const { c, calls } = boot({ retry: 'auto', count: 1, tracker: ['nope'] });
    const id = await exchange(c, 'I nod.', 'The landlady nods back.');
    assert.equal(calls(), 2);
    assert.equal(T.trackMark(c.chat[id]), 'failed');
    const card = markOf(draw(c), id);
    assert.match(card.textContent, /could not be read \(2 tries\)/);
    assert.deepEqual(btns(card), ['Retry']);
});
for (const mode of ['off', 'ask', 'auto']) {
    test(`${mode}: a valid empty answer is never retried`, async () => {
        const { c, calls } = boot({ retry: mode, count: 3, tracker: [GOOD, CUT] });
        const id = await exchange(c, 'I nod.', 'The landlady nods back.');
        assert.equal(calls(), 1);
        assert.equal(T.trackMark(c.chat[id]), 'tracked');
    });
}
test('a call that errors is a failed read with no Retry card (retry is for unreadable answers only)', async () => {
    const { c } = boot({ retry: 'auto', count: 2 });
    let k = 0;
    c.generateRaw = async args => { if (isTrackerCall(args)) { k++; throw new Error('backend down'); } return '{}'; };
    const id = await exchange(c, 'I nod.', 'The landlady nods back.');
    assert.equal(k, 1, 'no auto retry on an error');
    assert.equal(T.trackMark(c.chat[id]), 'failed');
    const mark = markOf(draw(c), id);
    assert.equal(mark.textContent, 'tracking failed');
    assert.deepEqual(btns(mark), []);
});
test('a swipe clears the failed state and reads the new swipe', async () => {
    const { c, calls } = boot({ retry: 'ask', tracker: [CUT, GOOD] });
    const id = await exchange(c, 'I nod.', 'The landlady nods back.');
    assert.equal(T.trackMark(c.chat[id]), 'failed');
    const m = c.chat[id];
    m.swipes.push('The landlady shrugs.'); m.swipe_info.push({ extra: {} }); m.swipe_id = 1; m.mes = 'The landlady shrugs.';
    await onStorySwipe(id); await flush(40);
    assert.equal(calls(), 2);
    assert.equal(T.trackMark(m), 'tracked');
    assert.equal(draw(c).querySelector('.worldscrawl_card_track'), null);
});
test('trackerSettled waits for the auto retries, and its cap still holds', async () => {
    let r = boot({ retry: 'auto', count: 2, delay: 40, tracker: ['nope', 'nope', GOOD] });
    say(r.c, 'I nod.');
    let id = reply(r.c, 'The landlady nods back.');
    let run = onReplyForFlags(id);
    await flush(10);
    say(r.c, 'Next.');
    assert.equal(await trackerSettled(r.c.chat.length - 1), 'done');
    assert.equal(r.calls(), 3, 'all three tries were waited for');
    await run;
    r = boot({ retry: 'auto', count: 3, delay: 80, tracker: ['nope'] });
    say(r.c, 'I nod.');
    id = reply(r.c, 'The landlady nods back.');
    run = onReplyForFlags(id);
    await flush(10);
    say(r.c, 'Next.');
    assert.equal(await trackerSettled(r.c.chat.length - 1, 120), 'cap');
    assert.ok(r.calls() < 4, 'went ahead before the tries ran out');
    await run;
    assert.equal(TRACKER_WAIT.cap > 0, true);
});

// ================================================================ the settings panel round trip (fakedom)
test('settings: the retry select and count round-trip through the panel', () => {
    boot();
    const doc = makeDoc([0]);
    const els = {};
    const html = [];
    doc.getElementById = id => (id === 'extensions_settings2' ? { insertAdjacentHTML: (_, h) => html.push(h) } : (els[id] ??= Object.assign(doc.createElement(/count|url|name|nudge/.test(id) ? 'input' : 'select'), { id })));
    doc.querySelectorAll = () => [];
    globalThis.document = doc;
    Object.assign(ext.settings(), { trackerRetry: 'auto', trackerRetryCount: 2 });
    addSettingsPanel();
    const page = html.join('');
    assert.match(page, /When the after-reply check can't read its answer/);
    assert.match(page, /<option value="off">Off<\/option><option value="ask">Ask \(Retry button\)<\/option><option value="auto">Retry automatically<\/option>/);
    assert.match(page, /Retries: 1-3/);
    assert.ok(page.indexOf('worldscrawl_tracker_retry') > page.indexOf('<div>Map changes</div>') && page.indexOf('worldscrawl_tracker_retry') < page.indexOf('<div>Movement</div>'), 'under Map changes');
    const sel = els.worldscrawl_tracker_retry, num = els.worldscrawl_tracker_retry_count;
    assert.equal(sel.value, 'auto');
    assert.equal(num.value, '2');
    sel.value = 'off'; sel.dispatchEvent({ type: 'change' });
    assert.equal(ext.settings().trackerRetry, 'off');
    num.value = '7'; num.dispatchEvent({ type: 'change' });
    assert.equal(ext.settings().trackerRetryCount, 3);
    assert.equal(num.value, '3', 'clamped in the box too');
    num.value = '0'; num.dispatchEvent({ type: 'change' });
    assert.equal(ext.settings().trackerRetryCount, 1);
});
