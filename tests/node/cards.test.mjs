// The shared card (plugin/ui/card.mjs), editor (cardedit.mjs), descriptors (plugin/shared/cards.mjs) and the action
// layer (extension/cardacts.mjs), driven through the real renderPatchCards and real handlers with fakedom clicks.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, SQUARE, TAVERN } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { applyTrackerResult } = await import('../../extension/discovery.mjs');
const { readTrackerAnswer } = await import('../../extension/tracker.mjs');
const { NPC_KEY, NPC_WARN_KEY, npcAt } = await import('../../extension/npc.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const cardlib = await import('../../extension/cardlib.mjs');
const acts = await import('../../extension/cardacts.mjs');
const card = await import('../../plugin/ui/card.mjs');
const cardedit = await import('../../plugin/ui/cardedit.mjs');
const C = await import('../../plugin/shared/cards.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const FLAG = 'worldscrawl_flag';
const server = clientDir(path.dirname(RIVERTON));
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie near a knocked-over stool, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';

function boot(chat, cast = [HESK]) {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast }] });
    const c = SillyTavern.getContext();
    c.chatId = 'cards1'; c.getCurrentChatId = () => 'cards1';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    ext.settings().flagTags = true; ext.settings().flagNpcs = true; ext.settings().autoKeep = false;
    c.chat = chat;
    return c;
}
function model(answers) {
    const calls = [];
    SillyTavern.getContext().generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        calls.push(p);
        const kind = /Which places did the story change/.test(p) ? 'rooms' : /Write the patch JSON/.test(p) ? 'patch' : /Looks line/.test(p) ? 'looks' : /Rewrite body/.test(p) ? 'fields' : 'other';
        const a = answers[kind];
        return typeof a === 'function' ? a(p) : a ?? '{}';
    };
    return calls;
}
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
function draw(ids = [0, 1]) { const doc = makeDoc(ids); globalThis.document = doc; renderPatchCards(); return doc; }

/** A place proposal on message 1 through the tracker and the real analysis (stubbed model, real map server). */
async function placeProposal() {
    const c = boot([
        { is_user: true, mes: 'I kick the stool over.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        { is_user: false, mes: 'The stool splinters the floorboards near the bar.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} },
    ], []);
    model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: BOARDS }] }) });
    await applyTrackerResult(1, readTrackerAnswer(JSON.stringify({ place: { changed: true, kind: 'change', note: 'the stool splintered the floorboards', rewrite: 'light', why: 'only the floor' }, people: [], wait: null })));
    for (let i = 0; i < 100 && c.chat[1].extra[FLAG]?.status !== 'review'; i++) await flush(10);
    assert.equal(c.chat[1].extra[FLAG].status, 'review');
    return { c }; // (not the context itself: its stub answers every key, `then` too)
}
/** A person proposal (Hesk, a lasting body change) on message 0, filled and in review. */
async function personProposal(owner = 'pc1') {
    const o = scene.makeOwner({ id: 'hesk', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, message: 'm', swipe: 0, chatId: 'cards1' });
    o.owner = owner; o.identity.owner = owner;
    const c = boot([{ mes: 'Hesk is here.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm', [NPC_KEY]: [o] } }]);
    model({ looks: '{"looks":"tall copper braids"}', fields: '{"body":"a composed frame","outfit":"wool"}' });
    const filled = await scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    return { c, o };
}
/** The card's sections in order, named by what each child is. */
function skeleton(el) {
    const out = [];
    for (const ch of el.children) {
        const cls = ch.className || '';
        const name = cls.includes('worldscrawl_waiting_label') ? 'waiting' : cls.includes('worldscrawl_card_title') ? 'title' : cls.includes('worldscrawl_card_summary') ? 'summary'
            : ch.dataset?.tone ? 'notes' : cls.includes('worldscrawl_diff') ? 'panel' : cls.includes('worldscrawl_card_editor') ? 'editor' : cls.includes('worldscrawl_notice_row') ? 'row' : 'extra';
        if (out.at(-1) !== name) out.push(name);
    }
    return out;
}
const sub = (seq, of) => seq.filter(x => of.includes(x));

test('both reference cards are the same shared card: one skeleton, the canonical order, exactly the adapter\'s actions', async () => {
    await placeProposal();
    let doc = draw();
    const area = doc.querySelector('.worldscrawl_flagreview');
    assert.ok(area.className.includes('worldscrawl_card') && area.className.includes('worldscrawl_card_place'));
    assert.deepEqual(sub(skeleton(area), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']), ['waiting', 'title', 'summary', 'notes', 'panel', 'row']);
    assert.deepEqual(btns(area), ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard']);
    byText(area, 'Edit').click();
    await flush(60);
    doc = draw();
    const open = doc.querySelector('.worldscrawl_flagreview');
    assert.deepEqual(sub(skeleton(open), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']);
    assert.ok(open.querySelector('.worldscrawl_card_editor .wspf'), 'the map form is hosted in the shared editor');
    assert.ok(open.querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent'), 'with the shared Change box');
    byText(open, 'Close editor').click();
    assert.equal(patchesExt.openForms.has('1|flag'), false);

    await personProposal();
    doc = draw([0]);
    const person = doc.querySelector('.worldscrawl_npcpending');
    assert.ok(person.className.includes('worldscrawl_card') && person.className.includes('worldscrawl_card_person'));
    assert.deepEqual(sub(skeleton(person), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']), ['waiting', 'title', 'summary', 'notes', 'panel', 'row']);
    assert.deepEqual(btns(person), ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard']);
    byText(person, 'Edit').click();
    const pOpen = draw([0]).querySelector('.worldscrawl_npcpending');
    assert.deepEqual(sub(skeleton(pOpen), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']), ['waiting', 'title', 'summary', 'notes', 'panel', 'editor', 'row']);
    assert.deepEqual(btns(pOpen), ['Check again', 'Close editor', 'Make it a full rewrite', 'Rewrite with this', 'Approve edited', 'Discard']);
    // Same editor classes on both cards.
    assert.ok(pOpen.querySelector('.worldscrawl_card_editor .worldscrawl_card_intent'));
    assert.ok(open.querySelector('.worldscrawl_card_editor .worldscrawl_card_intent'));
    cardedit.closeCardEditor('pc1|npcedit');
});

test('the card orders and labels only: it shows exactly the declared actions, in the fixed order, whatever order they come in', () => {
    const doc = makeDoc();
    const shuffled = [{ id: 'discard' }, { id: 'approve' }, { id: 'scope', to: 'light' }, { id: 'again' }, { id: 'undo' }, { id: 'extra:newroom' }, { id: 'edit' }];
    const el = card.renderCard(doc, { key: 'k', type: 'place', state: 'review', title: 't', actions: shuffled });
    assert.deepEqual(btns(el), ['Check again', 'Edit', 'Make it a light touch', 'Make it a new room instead', 'Approve', 'Undo', 'Discard']);
    assert.deepEqual(btns(card.renderCard(doc, { key: 'k', state: 'review', actions: [{ id: 'approve' }] })), ['Approve'], 'nothing is added');
    assert.deepEqual(btns(card.renderCard(doc, { key: 'k', state: 'review', actions: [] })), [], 'and no actions, no row');
    assert.deepEqual(btns(card.renderCard(doc, { key: 'k', state: 'info', actions: [{ id: 'discard' }] })), ['Dismiss'], 'Dismiss only on an info card');
    assert.deepEqual(btns(card.renderCard(doc, { key: 'k', state: 'review', editor: { key: 'k2', fields: [] }, actions: [{ id: 'approve' }, { id: 'close' }] })), ['Close editor', 'Approve edited']);
    cardedit.closeCardEditor('k2');
    // Adapters can't offer what the matrix doesn't allow (a found row never gets Approve).
    assert.deepEqual(C.within('found', 'kept', [{ id: 'approve' }, { id: 'undo' }]).map(a => a.id), ['undo']);
    // Each adapter's actions are inside the matrix for its state.
    for (const v of [{ busy: '' }, { busy: 'full' }, { editing: true, scoped: true }, { scoped: true, unmerged: true, mergedNames: ['X'] }]) {
        const d = C.placeReview({ key: 'x', summary: [], preview: {}, ...v });
        for (const a of d.actions) assert.ok(C.allowedActions('place', d.state).includes(a.id), `${a.id} in place ${d.state}`);
    }
    for (const phase of ['working', 'review', 'failed']) for (const editing of [false, true]) {
        const d = C.personReview({ key: 'y', who: 'Hesk', phase, scoped: true, editing });
        for (const a of d.actions) assert.ok(C.allowedActions('person', d.state).includes(a.id), `${a.id} in person ${phase}`);
        cardedit.closeCardEditor('y');
    }
});

test('typed text and the caret survive a redraw, and incoming data never overwrites a field the player changed', async () => {
    const { c, o } = await personProposal('pc2');
    let doc = draw([0]);
    byText(doc, 'Edit').click();
    doc = draw([0]);
    const box = doc.querySelectorAll('textarea').find(t => t.dataset.field === 'body');
    assert.equal(box.value, 'a towering woman');
    box.value = 'a towering woman with a scar';
    box.selectionStart = 6; box.selectionEnd = 14;
    box.dispatchEvent({ type: 'input' });
    const intent = doc.querySelector('.worldscrawl_npc_intent');
    intent.value = 'taller and scarred'; intent.selectionStart = 3; intent.selectionEnd = 3;
    intent.dispatchEvent({ type: 'input' });
    renderPatchCards(); // a forced redraw (any chat event does this)
    const again = doc.querySelectorAll('textarea').find(t => t.dataset.field === 'body');
    assert.notEqual(again, box, 'a new box was drawn');
    assert.equal(again.value, 'a towering woman with a scar');
    assert.deepEqual([again.selectionStart, again.selectionEnd], [6, 14]);
    const intent2 = doc.querySelector('.worldscrawl_npc_intent');
    assert.equal(intent2.value, 'taller and scarred');
    assert.equal(intent2.selectionStart, 3);
    // New data arrives for the same card (a fresh candidate): the typed box keeps its text.
    o.candidate.lastingPreview = { body: 'a different proposal', outfit: 'wool' };
    o.candidate.token = 'newer';
    renderPatchCards();
    assert.equal(doc.querySelectorAll('textarea').find(t => t.dataset.field === 'body').value, 'a towering woman with a scar');
    // Approve edited sends exactly the typed text.
    byText(doc, 'Approve edited').click();
    await flush(60);
    assert.equal(o.committed?.layer?.body, 'a towering woman with a scar');
    assert.equal(cardedit.editorOpen('pc2|npcedit'), false, 'the editor and its drafts are gone after the approval');
    assert.ok(c.chat[0].extra[NPC_KEY].includes(o));
    // A clean field follows new data.
    const ed = card.renderCard(makeDoc(), { key: 'clean', state: 'review', editor: { key: 'clean', fields: [{ key: 'a', label: 'A', value: 'one' }] }, actions: [] });
    assert.equal(ed.querySelector('textarea').value, 'one');
    const ed2 = card.renderCard(makeDoc(), { key: 'clean', state: 'review', editor: { key: 'clean', fields: [{ key: 'a', label: 'A', value: 'two' }] }, actions: [] });
    assert.equal(ed2.querySelector('textarea').value, 'two');
    cardedit.closeCardEditor('clean');
});

test('stale results: an action from a card drawn before the change moved writes nothing (place and person)', async () => {
    // Person: the card was drawn, then the change was decided elsewhere (the map's Discard): its Approve is stale.
    const { c, o } = await personProposal('pc3');
    let doc = draw([0]);
    const approve = byText(doc, 'Approve');
    const discarded = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'discard', {});
    assert.equal(discarded.ok, true);
    approve.click();
    await flush(60);
    assert.equal(o.committed ?? null, null, 'the stale Approve committed nothing');
    // The layer refuses an async action with no ticket, for every type.
    for (const [type, h] of Object.entries(acts.HANDLERS)) for (const a of Object.keys(h).filter(a => acts.ASYNC_ACTIONS.has(a))) assert.equal((await acts.runCardAction(type, a, null)).error, 'no ticket', `${type} ${a}`);
    // Person: a card drawn on one swipe, clicked after a swipe.
    const p2 = await personProposal('pc4');
    doc = draw([0]);
    const ok = byText(doc, 'Approve');
    p2.c.chat[0].swipe_id = 1;
    ok.click();
    await flush(60);
    assert.equal(p2.o.committed ?? null, null);

    // Place: the card was drawn, then the flag was replaced (a new analysis): the old Approve stamps nothing.
    const { c: pc } = await placeProposal();
    doc = draw();
    const keep = byText(doc.querySelector('.worldscrawl_flagreview'), 'Approve');
    pc.chat[1].extra[FLAG] = { ...pc.chat[1].extra[FLAG] }; // a new flag object on the message
    keep.click();
    await flush(60);
    assert.equal(pc.chat[1].extra.worldscrawl_patches, undefined, 'no patch was stamped');
    // Place: a swipe between drawing and clicking.
    const { c: pd } = await placeProposal();
    doc = draw();
    const keep2 = byText(doc.querySelector('.worldscrawl_flagreview'), 'Approve');
    pd.chat[1].swipe_id = 1;
    keep2.click();
    await flush(60);
    assert.equal(pd.chat[1].extra.worldscrawl_patches, undefined);
    pd.chat[1].swipe_id = 0;
    // And a fresh card still works.
    byText(draw().querySelector('.worldscrawl_flagreview'), 'Approve').click();
    await flush(80);
    assert.equal(pd.chat[1].extra[FLAG].status, 'kept');
});

test('a missing or older plugin shows one "update the plugin" line, never the old cards', async () => {
    await personProposal('pc5');
    try {
        assert.equal(cardlib.useCardLib({ ...card, CARD_VERSION: 0 }, cardedit), false);
        assert.equal(cardlib.cardError, 'old');
        let doc = draw([0]);
        assert.equal(doc.querySelectorAll('.worldscrawl_card_btn').length, 0);
        assert.equal(doc.querySelector('.worldscrawl_update_plugin').textContent, 'WorldScrawl: update the plugin, then restart SillyTavern');
        assert.equal(cardlib.useCardLib(null, null), false);
        assert.equal(cardlib.cardError, 'missing');
        doc = draw([0]);
        assert.equal(doc.querySelectorAll('.worldscrawl_update_plugin').length, 1);
    } finally { assert.equal(cardlib.useCardLib(card, cardedit), true); }
    assert.equal(btns(draw([0])).includes('Approve'), true);
});

// ---- S1b: every person action goes through settleNpc (Check again, the scope switch, Rewrite with this)
function commitOwner(o) {
    o.committed = { kind: 'appearance', intent: o.candidate.intent, fields: o.candidate.fields, layer: { ...(o.candidate.layer ?? {}) }, scope: 'light', why: '' };
    o.kind = 'appearance'; o.lasts = o.candidate.proposedLasts; o.contentId = `c_${o.owner}`; o.candidate = null;
    return o;
}
function owner(id, intent, fields, layer, lasts) {
    const o = scene.makeOwner({ id: 'hesk', intent, fields, layer, lasts, start: 0, message: 'm', swipe: 0, chatId: 'cards1' });
    o.owner = id; o.identity.owner = id;
    return o;
}
/** Knarfy's layered test: a committed gnoll body change and a proposed stripper (body and outfit), each temporary. */
async function layered(gnollLasts, stripperLasts) {
    const gnoll = commitOwner(owner(`gnoll${gnollLasts}`, 'turned into a gnoll', 'body', { body: 'a gnoll frame' }, gnollLasts));
    const stripper = owner(`strip${stripperLasts}`, 'turned into a sexy stripper', 'body,outfit', {}, stripperLasts);
    const c = boot([{ mes: 'The spell takes hold.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm', [NPC_KEY]: [gnoll, stripper] } }]);
    const prompts = [];
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? '');
        prompts.push(p);
        if (/Looks line/.test(p)) return '{"looks":"a sultry look"}';
        if (/gnoll/.test(p) && /stripper/.test(p)) return '{"body":"a gnoll in glitter","outfit":"silver sequins"}';
        if (/stripper/.test(p)) return '{"body":"a lithe dancer","outfit":"silver sequins"}';
        return '{"body":"should not be asked","outfit":"wool"}';
    };
    await scene.fillCandidate(c.chat, stripper.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    return { c, gnoll, stripper, prompts };
}
for (const [order, gnollLasts, stripperLasts] of [['the stripper ends first', 120, 60], ['the gnoll ends first', 60, 120]]) {
    test(`layered gnoll + stripper through the card's Check again and scope switch: ${order}`, async () => {
        const { c, stripper, prompts } = await layered(gnollLasts, stripperLasts);
        let doc = draw([0]);
        const fieldAsks = () => prompts.filter(p => /Rewrite body/.test(p));
        const before = fieldAsks().length;
        byText(doc, 'Check again').click();
        await flush(60);
        assert.ok(fieldAsks().length > before, 'Check again asked the rewrite again');
        assert.equal(stripper.candidate.phase, 'review');
        assert.equal(stripper.candidate.livePreview.body, 'a gnoll in glitter', 'for now it sits on the gnoll');
        assert.deepEqual(stripper.candidate.lastingPreview, { body: 'sturdy', outfit: 'wool' }, 'the pinned baseline underneath both temporary changes');
        doc = draw([0]);
        byText(doc, 'Make it a full rewrite').click();
        await flush(60);
        assert.equal(stripper.candidate.scope, 'heavy');
        assert.match(fieldAsks().at(-1), /turned into a sexy stripper \[body,outfit\] \(full rewrite\)/);
        doc = draw([0]);
        byText(doc, 'Approve').click();
        await flush(80);
        assert.ok(stripper.committed, 'approved from the card');
        assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).outfit, 'silver sequins');
        // An hour passes: one of the two runs out, and the other is what she looks like.
        c.chat.push({ mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } });
        await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 80 });
        const hour = npcAt(c.chat, 1, [HESK], 'hesk', i => ({ elapsed: i === 0 ? 0 : 3600 }));
        if (stripperLasts < gnollLasts) assert.deepEqual([hour.body, hour.outfit], ['a gnoll frame', 'wool'], 'back to the gnoll, not to human');
        else assert.deepEqual([hour.body, hour.outfit], ['a lithe dancer', 'silver sequins'], 'the stripper alone, without the gnoll');
        assert.equal(prompts.some(p => /should not be asked/.test(p)), false);
        // Both over: back to her own body and clothes.
        c.chat.push({ mes: 'Later still.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 7200 } } });
        const late = npcAt(c.chat, 2, [HESK], 'hesk', i => ({ elapsed: i === 0 ? 0 : i === 1 ? 3600 : 10800 }));
        assert.deepEqual([late.body, late.outfit], ['sturdy', 'wool']);
    });
}

test('the person scope switch asks before dropping typed text; Rewrite with this asks again with the Change box', async () => {
    const { o } = await personProposal('pc6');
    const asked = [];
    const prev = ext.hooks.confirm;
    try {
        let doc = draw([0]);
        byText(doc, 'Edit').click();
        doc = draw([0]);
        ext.hooks.confirm = async t => { asked.push(t); return false; };
        // Nothing typed: no question.
        byText(doc, 'Make it a full rewrite').click();
        await flush(60);
        assert.equal(asked.length, 0);
        assert.equal(o.candidate.scope, 'heavy');
        doc = draw([0]);
        byText(doc, 'Edit').click();
        doc = draw([0]);
        const box = doc.querySelectorAll('textarea').find(t => t.dataset.field === 'body');
        box.value = 'my own words'; box.dispatchEvent({ type: 'input' });
        byText(doc, 'Make it a light touch').click();
        await flush(60);
        assert.equal(asked.length, 1);
        assert.match(asked[0], /drops the text you typed/);
        assert.equal(o.candidate.scope, 'heavy', 'cancelled: nothing asked');
        assert.equal(draw([0]).querySelectorAll('textarea').find(t => t.dataset.field === 'body').value, 'my own words', 'and the typed text stays');
        ext.hooks.confirm = async t => { asked.push(t); return true; };
        byText(document, 'Make it a light touch').click();
        await flush(60);
        assert.equal(o.candidate.scope, 'light');
        assert.equal(cardedit.editorOpen('pc6|npcedit'), false);
        // Rewrite with this: the typed Change line is the new intent.
        doc = draw([0]);
        byText(doc, 'Edit').click();
        doc = draw([0]);
        const intent = doc.querySelector('.worldscrawl_npc_intent');
        intent.value = 'taller and scarred'; intent.dispatchEvent({ type: 'input' });
        byText(doc, 'Rewrite with this').click();
        await flush(60);
        assert.equal(o.candidate.intent, 'taller and scarred');
    } finally { ext.hooks.confirm = prev; }
});

test('stale: a person Check again from a card drawn before the change was decided elsewhere asks nothing', async () => {
    const { c, o } = await personProposal('pc7');
    const doc = draw([0]);
    const again = byText(doc, 'Check again');
    const calls = model({ fields: '{"body":"should not land","outfit":"wool"}' });
    await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'approve', { token: o.candidate.token, elapsed: 0 });
    const committed = JSON.stringify(o.committed);
    again.click();
    await flush(60);
    assert.equal(JSON.stringify(o.committed), committed);
    assert.equal(o.candidate, null);
    assert.equal(calls.filter(p => /Rewrite body/.test(p)).length, 0);
});

// ---- S2: the place expiry notice (a temporary room ran out under the party)
const { postExpiredNotice } = await import('../../extension/expiry.mjs');
const { chatChanges } = await import('../../extension/clock.mjs');
const LANE = 'riverton:streets/market_lane', BOOTH = 'riverton:streets/stall';
const STALL_OPS = [{ op: 'create_place', area: 'riverton:streets', id: 'stall', name: 'Pop-up Stall', description: 'Canvas and crates.', lasts: '1h',
    exits: [{ direction: 'stall', to: SQUARE, return_direction: 'square' }, { direction: 'lane', to: LANE, return_direction: 'stall' }] }];
/** A pop-up stall made at message 1 for an hour, two hours pass, and the real expiry notice is posted on message 3. */
async function stallGone() {
    const c = boot([
        { is_user: true, mes: 'I duck into the stall.', swipe_id: 0, extra: { worldscrawl_move: { to: SQUARE } } },
        { is_user: false, mes: 'A pop-up stall stands here for the fair.', swipe_id: 0, swipe_info: [{ extra: {} }],
            extra: { worldscrawl_patches: [{ type: 'patch', id: 'stall', note: 'a pop-up stall for the fair', at: 0, swipe: 0, ops: STALL_OPS, summary: ['Pop-up Stall: new room'] }] } },
        { is_user: true, mes: '[wait] 2h', swipe_id: 0, extra: { worldscrawl_wait: { seconds: 7200 } } },
    ], []);
    model({});
    await postExpiredNotice(BOOTH, SQUARE, 'square');
    assert.equal(c.chat.length, 4);
    assert.equal(c.chat[3].extra.worldscrawl_notice_expired, true);
    return { c };
}
const placeGone = doc => doc.querySelector('.worldscrawl_placeexpired');

test('place expiry: the card shows the room while it lasted next to now; Edit → Approve edited stamps a kept change on the notice; deleting the notice removes it', async () => {
    const { c } = await stallGone();
    let doc = draw([0, 1, 2, 3]);
    assert.match(placeGone(doc).textContent, /Working out what changed/);
    await flush(60);
    let card = placeGone(doc);
    assert.equal(card.dataset.state, 'info');
    assert.match(card.querySelector('.worldscrawl_card_summary').textContent, /Pop-up Stall ran out/);
    const panel = card.querySelector('.worldscrawl_diff');
    assert.ok(panel, 'the before/now panel');
    assert.match(panel.textContent, /Pop-up Stall/);
    assert.match(panel.textContent, /Canvas and crates\./, 'before: the temporary room');
    assert.deepEqual(btns(card), ['Edit']);
    byText(card, 'Edit').click();
    await flush(60);
    card = placeGone(doc);
    assert.deepEqual(btns(card), ['Close editor', 'Approve edited']);
    assert.ok(card.querySelector('.worldscrawl_card_editor .wspf'), 'the map form in the shared editor');
    const intent = card.querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent');
    assert.equal(intent.value, 'a pop-up stall for the fair');
    intent.value = 'the stall stays for good';
    intent.dispatchEvent({ type: 'input' });
    byText(card, 'Approve edited').click();
    await flush(60);
    const kept = c.chat[3].extra.worldscrawl_patches ?? [];
    assert.equal(kept.length, 1);
    assert.equal(kept[0].source, 'expiry_edit');
    assert.equal(kept[0].note, 'the stall stays for good');
    assert.equal(kept[0].ops[0].op, 'create_place');
    assert.equal('lasts' in kept[0].ops[0], false, 'kept for good');
    doc = draw([0, 1, 2, 3]);
    assert.deepEqual(btns(placeGone(doc)), [], 'the card gives way to the kept change');
    assert.ok(doc.querySelectorAll('.mes')[3].textContent.includes('Map changed here'));
    assert.ok(chatChanges(c.chat).some(p => p.source === 'expiry_edit'));
    // Deleting the notice takes the kept change with it.
    c.chat.splice(3, 1);
    assert.equal(chatChanges(c.chat).some(p => p.source === 'expiry_edit'), false);
});

test('place expiry stale: a notice deleted before the click, or during the save, writes nothing', async () => {
    let { c } = await stallGone();
    let doc = draw([0, 1, 2, 3]);
    await flush(60);
    byText(placeGone(doc), 'Edit').click();
    await flush(60);
    const notice = c.chat[3];
    const ok = byText(placeGone(doc), 'Approve edited');
    c.chat.splice(3, 1);
    ok.click();
    await flush(60);
    assert.equal(notice.extra.worldscrawl_patches ?? null, null, 'deleted before the click');
    patchesExt.openForms.clear();

    ({ c } = await stallGone());
    doc = draw([0, 1, 2, 3]);
    await flush(60);
    byText(placeGone(doc), 'Edit').click();
    await flush(60);
    const n2 = c.chat[3];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { if (/patch\/preview/.test(String(url)) && c.chat[3] === n2) c.chat.splice(3, 1); return real(url, opts); };
    try {
        byText(placeGone(doc), 'Approve edited').click();
        await flush(80);
    } finally { globalThis.fetch = real; }
    assert.equal(c.chat.length, 3, 'the notice went mid-save');
    assert.equal(n2.extra.worldscrawl_patches ?? null, null, 'deleted during the save');
    patchesExt.openForms.clear();
});

// ---- S3: the Remember card
const MAREN = { name: 'Maren', personality: { summary: 'A knife-grinder.', manner: 'Brisk.', speech: 'Clipped.' }, appearance: { summary: 'wiry woman', body: 'Wiry, with grey eyes.', outfit: 'A patched smock.' },
    history: 'Came upriver years ago; a scar on the chin from a bad whetstone.', facts: ['Sharpens knives in the square'], invented: ['grey eyes', 'scar on the chin'], disposition: { value: 'friendly', reason: 'You paid.' } };
const isRemember = p => /Remember this person/.test(p);
/** A Remember card for Maren on message 1; `answer(prompt)` is the model's remember answer. */
async function rememberCard(answer) {
    const c = boot([
        { is_user: true, mes: 'I hand my knife to the grinder.', swipe_id: 0, extra: {} },
        { is_user: false, mes: 'Maren, the knife-grinder, works the wheel.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} },
    ], []);
    const calls = [];
    SillyTavern.getContext().generateRaw = async args => { const p = String(args?.prompt ?? ''); if (isRemember(p)) calls.push(p); return isRemember(p) ? answer(p, calls.length) : '{}'; };
    await scene.offerRemember(c.chat[1], 'Maren');
    return { c, calls, card: () => c.chat[1].extra[scene.REMEMBER_KEY] };
}
const remEl = doc => doc.querySelector('.worldscrawl_remembercard');
const created = c => (c.chat[1].extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_create');

test('Remember: Preparing… offers Approve, and Approve while the prefetch is in flight saves its answer with no second call', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const { c, calls } = await rememberCard(async () => { await gate; return JSON.stringify(MAREN); });
    const doc = draw([0, 1]);
    await flush(10);
    let el = remEl(doc);
    assert.equal(el.dataset.state, 'working');
    assert.match(el.textContent, /Preparing…/);
    assert.deepEqual(btns(el), ['Approve', 'Discard']);
    assert.equal(calls.length, 1, 'the prefetch is asking');
    byText(el, 'Approve').click();
    await flush(10);
    release();
    await flush(60);
    assert.equal(calls.length, 1, 'no second call');
    assert.equal(created(c).length, 1);
    assert.equal(created(c)[0].name, 'Maren');
    assert.equal(created(c)[0].line, 'A knife-grinder.');
});

test('a double-click on Approve answers once: its second click is dropped, even on the next state\'s Turn off', async () => {
    const { c } = await rememberCard(async () => JSON.stringify(MAREN));
    await flush(30);
    let doc = draw([0, 1]);
    await flush(10);
    byText(remEl(doc), 'Approve').click(1);
    await flush(60);
    assert.equal(created(c).length, 1);
    doc = draw([0, 1]);
    const kept = doc.querySelectorAll('.worldscrawl_npcchange').find(el => /Maren/.test(el.textContent));
    assert.ok(byText(kept, 'Turn off'), 'the kept card has Turn off where Approve was');
    byText(kept, 'Turn off').click(2); // the double-click's second click lands on the redrawn card
    await flush(30);
    assert.notEqual(created(c)[0].off, true, 'still on');
    byText(kept, 'Turn off').click(1); // a real click still works
    await flush(30);
    assert.equal(created(c)[0].off, true);
});

test('Remember: a failed card offers Check again, which asks again into review', async () => {
    const { calls } = await rememberCard((p, n) => (n <= 2 ? 'not json' : JSON.stringify(MAREN)));
    const doc = draw([0, 1]);
    await flush(60);
    let el = remEl(doc);
    assert.equal(el.dataset.state, 'failed');
    assert.match(el.textContent, /Could not prepare the card/);
    assert.deepEqual(btns(el), ['Check again', 'Discard']);
    byText(el, 'Check again').click();
    await flush(60);
    el = remEl(doc);
    assert.equal(el.dataset.state, 'review');
    assert.equal(calls.length, 3);
    assert.match(el.querySelector('.worldscrawl_card_summary').textContent, /New person: Maren — A knife-grinder\./);
});

test('Remember review: the new-person panel marks made-up details; Edit opens every field; Rewrite with this keeps what was typed; Approve edited clears only changed fields\' marks', async () => {
    const { c, calls, card } = await rememberCard((p, n) => JSON.stringify(n === 1 ? MAREN : { ...MAREN, personality: { ...MAREN.personality, summary: 'An old knife-grinder.' }, appearance: { ...MAREN.appearance, outfit: 'Fine robes.' } }));
    const doc = draw([0, 1]);
    await flush(60);
    let el = remEl(doc);
    assert.equal(el.dataset.state, 'review');
    assert.deepEqual(btns(el), ['Check again', 'Edit', 'Approve', 'Discard']);
    const panel = el.querySelector('.worldscrawl_diff').textContent;
    assert.match(panel, /new person/);
    assert.match(panel, /Body ⚠ made up: grey eyes/);
    assert.match(panel, /History ⚠ made up: scar on the chin/);
    assert.match(el.querySelector('.worldscrawl_invented').textContent, /⚠ grey eyes; ⚠ scar on the chin/);
    byText(el, 'Edit').click();
    await flush(10);
    el = remEl(doc);
    assert.deepEqual(btns(el), ['Check again', 'Close editor', 'Rewrite with this', 'Approve edited', 'Discard']);
    const box = k => remEl(doc).querySelector(`.worldscrawl_remember_${k}`);
    assert.deepEqual(['name', 'line', 'looks', 'manner', 'voice', 'body', 'outfit', 'history', 'starts', 'facts'].map(k => box(k)?.value),
        ['Maren', 'A knife-grinder.', 'wiry woman', 'Brisk.', 'Clipped.', 'Wiry, with grey eyes.', 'A patched smock.', MAREN.history, 'friendly — You paid.', 'Sharpens knives in the square']);
    // Rewrite with this: the Change note goes to the model, the typed outfit stays exactly.
    box('outfit').value = 'A leather apron.'; box('outfit').dispatchEvent({ type: 'input' });
    const intent = remEl(doc).querySelector('.worldscrawl_remember_intent');
    intent.value = 'older'; intent.dispatchEvent({ type: 'input' });
    byText(remEl(doc), 'Rewrite with this').click();
    await flush(60);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /The player's note on the last card: older/);
    assert.match(calls[1], /- Wearing: A leather apron\./);
    assert.equal(card().proposal.got.outfit, 'A leather apron.', 'the typed field stays');
    assert.equal(card().proposal.got.line, 'An old knife-grinder.', 'the model filled the rest');
    // Approve edited: a changed Body drops its "grey eyes" mark; the History mark stays.
    el = remEl(doc);
    assert.equal(el.dataset.state, 'review');
    byText(el, 'Edit').click();
    await flush(10);
    box('body').value = 'Wiry and stooped.'; box('body').dispatchEvent({ type: 'input' });
    box('starts').value = 'helpful — she likes you'; box('starts').dispatchEvent({ type: 'input' });
    byText(remEl(doc), 'Approve edited').click();
    await flush(60);
    const [made] = created(c);
    assert.ok(made);
    assert.equal(made.body, 'Wiry and stooped.');
    assert.equal(made.outfit, 'A leather apron.');
    assert.deepEqual(made.invented, ['scar on the chin']);
    const disp = (c.chat[1].extra[NPC_KEY] ?? []).find(s => s.type === 'npc_disposition');
    assert.equal(disp.value, 'helpful');
    assert.equal(disp.reason, 'she likes you');
    assert.equal(calls.length, 2, 'Approve edited asks nothing');
});

test('Remember: Discard declines for this scene; a stale Approve (the card was asked again since) saves nothing', async () => {
    let { c, card } = await rememberCard(() => JSON.stringify(MAREN));
    let doc = draw([0, 1]);
    await flush(60);
    byText(remEl(doc), 'Discard').click();
    await flush(30);
    assert.equal(card().status, 'declined');
    assert.ok((c.chat[1].extra[NPC_KEY] ?? []).some(s => s.type === 'npc_decline' && s.name === 'Maren'));

    ({ c, card } = await rememberCard((p, n) => JSON.stringify(n === 1 ? MAREN : { ...MAREN, name: 'Maren Vell' })));
    doc = draw([0, 1]);
    await flush(60);
    const old = byText(remEl(doc), 'Approve');
    await scene.retryRemember(1); // asked again elsewhere: a new proposal
    await flush(60);
    old.click();
    await flush(60);
    assert.equal(created(c).length, 0, 'the stale Approve saved nothing');
    assert.equal(card().status, 'review');
    // Starts must be a disposition.
    doc = draw([0, 1]);
    byText(remEl(doc), 'Edit').click();
    await flush(10);
    const st = remEl(doc).querySelector('.worldscrawl_remember_starts');
    st.value = 'grumpy'; st.dispatchEvent({ type: 'input' });
    byText(remEl(doc), 'Approve edited').click();
    await flush(30);
    assert.equal(created(c).length, 0, 'a bad Starts is refused');
    cardedit.closeCardEditor('1|remember');
});

// ---- S4: kept and committed rows
/** A kept map change on message 1 (the stool proposal, approved through its card). */
async function keptChange() {
    const { c } = await placeProposal();
    const doc = draw();
    byText(doc.querySelector('.worldscrawl_flagreview'), 'Approve').click();
    await flush(60);
    const [p] = c.chat[1].extra.worldscrawl_patches ?? [];
    assert.ok(p, 'kept');
    return { c, p };
}
const keptEl = doc => doc.querySelector('.worldscrawl_change_kept') ?? doc.querySelector('.worldscrawl_change_off');

test('kept map change: Edit opens the in-card map form (no tab), Approve edited re-stamps it; Turn off, Turn on, Undo', async () => {
    const { c, p } = await keptChange();
    const opened = [];
    globalThis.window = { open: (...a) => { opened.push(a); return {}; } };
    try {
        let doc = draw();
        let el = keptEl(doc);
        assert.equal(el.dataset.state, 'kept');
        assert.match(el.querySelector('.worldscrawl_card_title').textContent, /^🗺 Map changed here:/);
        assert.deepEqual(btns(el), ['Edit', 'Turn off', 'Undo']);
        const show = el.querySelector('.worldscrawl_change_show');
        assert.ok(show && !show.open, '"Show change" starts collapsed');
        byText(el, 'Edit').click();
        await flush(60);
        assert.equal(opened.length, 0, 'no editor tab');
        doc = draw();
        el = keptEl(doc);
        assert.deepEqual(btns(el), ['Close editor', 'Approve edited', 'Turn off', 'Undo']);
        assert.ok(el.querySelector('.worldscrawl_card_editor .wspf'), 'the same map form as the review card');
        assert.ok(el.querySelector('.worldscrawl_card_editor .worldscrawl_flag_intent'), 'with the Change box');
        const ta = el.querySelector('.wspf-text');
        assert.equal(ta.value, BOARDS);
        ta.value = 'A scorched common room, the bar charred black.';
        ta.dispatchEvent({ type: 'input' });
        byText(el, 'Approve edited').click();
        await flush(80);
        const now = c.chat[1].extra.worldscrawl_patches;
        assert.equal(now.length, 1);
        assert.equal(now[0].id, p.id, 'same change, same message');
        assert.equal(now[0].ops[0].text, 'A scorched common room, the bar charred black.');
        doc = draw();
        assert.deepEqual(btns(keptEl(doc)), ['Edit', 'Turn off', 'Undo'], 'the editor closed');
        byText(keptEl(doc), 'Turn off').click();
        await flush(80);
        assert.equal(now[0].off, true);
        doc = draw();
        el = keptEl(doc);
        assert.equal(el.dataset.state, 'off');
        assert.deepEqual(btns(el), ['Turn on', 'Undo']);
        byText(el, 'Turn on').click();
        await flush(80);
        assert.equal(now[0].off === true, false);
        doc = draw();
        byText(keptEl(doc), 'Undo').click();
        await flush(80);
        assert.equal(c.chat[1].extra.worldscrawl_patches ?? null, null, 'Undo removes it');
    } finally { delete globalThis.window; }
});

test('kept map change stale: edited elsewhere before the click, or the message deleted during the save, writes nothing', async () => {
    let { c, p } = await keptChange();
    let doc = draw();
    byText(keptEl(doc), 'Edit').click();
    await flush(60);
    doc = draw();
    let ta = keptEl(doc).querySelector('.wspf-text');
    ta.value = 'Typed here.'; ta.dispatchEvent({ type: 'input' });
    const ok = byText(keptEl(doc), 'Approve edited');
    p.ops = [{ ...p.ops[0], text: 'Edited in the map meanwhile.' }];
    ok.click();
    await flush(80);
    assert.equal(c.chat[1].extra.worldscrawl_patches[0].ops[0].text, 'Edited in the map meanwhile.', 'the stale save wrote nothing');
    patchesExt.openForms.clear(); cardedit.closeCardEditor(`1|${p.id}`);

    ({ c, p } = await keptChange());
    doc = draw();
    byText(keptEl(doc), 'Edit').click();
    await flush(60);
    doc = draw();
    ta = keptEl(doc).querySelector('.wspf-text');
    ta.value = 'Typed here.'; ta.dispatchEvent({ type: 'input' });
    const msg1 = c.chat[1];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { if (/patch\/preview/.test(String(url)) && c.chat[1] === msg1) c.chat.splice(1, 1); return real(url, opts); };
    try { byText(keptEl(doc), 'Approve edited').click(); await flush(80); } finally { globalThis.fetch = real; }
    assert.equal(msg1.extra.worldscrawl_patches[0].ops[0].text, BOARDS, 'deleted during the save: unchanged');
    patchesExt.openForms.clear(); cardedit.closeCardEditor(`1|${p.id}`);
});

/** Person notes on message 0: the stamps given, through the real addNpcStamp (owners and identity). */
function notes(stamps, cast) {
    const c = boot([{ is_user: false, mes: 'Hesk wipes the bar.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm0' } }], cast);
    for (const s of stamps) scene.addNpcStamp(c.chat[0], s);
    return { c, st: type => c.chat[0].extra[NPC_KEY].find(s => s.type === type) };
}
const noteEl = (doc, re) => [...doc.querySelectorAll('.worldscrawl_card_fact')].find(e => re.test(e.textContent));

test('a pending lasting fact is a review card: Edit → Approve edited adds it as typed; Discard drops one', async () => {
    const { c, st } = notes([{ type: 'npc_fact', id: 'hesk', field: 'fact', text: 'owes a favor', pending: true }, { type: 'npc_fact', id: 'hesk', field: 'fact', text: 'hates rats', pending: true }]);
    let doc = draw([0]);
    let el = noteEl(doc, /owes a favor/);
    assert.ok(el.className.includes('worldscrawl_npcpending'));
    assert.equal(el.dataset.state, 'review');
    assert.deepEqual(btns(el), ['Edit', 'Approve', 'Discard']);
    assert.match(el.querySelector('.worldscrawl_diff').textContent, /Fact/);
    byText(el, 'Edit').click();
    await flush(10);
    el = noteEl(doc, /owes a favor/);
    assert.deepEqual(btns(el), ['Close editor', 'Approve edited', 'Discard']);
    const box = el.querySelector('.worldscrawl_note_text');
    box.value = 'owes Hesk a big favor'; box.dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click();
    await flush(30);
    const f = c.chat[0].extra[NPC_KEY].find(s => /big favor/.test(s.text ?? ''));
    assert.ok(f && !f.pending);
    byText(noteEl(doc, /hates rats/), 'Discard').click();
    await flush(30);
    assert.equal(c.chat[0].extra[NPC_KEY].some(s => s.text === 'hates rats'), false);
    assert.equal(noteEl(doc, /big favor/).dataset.state, 'kept');
});

test('committed notes: fact, memory and disposition Edit → Approve edited → Turn off → Turn on → Undo through the card', async () => {
    for (const [s, re, typed, key] of [
        [{ type: 'npc_fact', id: 'hesk', field: 'fact', text: 'owes a favor' }, /owes a favor/, 'owes two favors', 'text'],
        [{ type: 'npc_memory', id: 'hesk', note: 'she promised a room' }, /promised a room/, 'she promised the attic room', 'note'],
        [{ type: 'npc_disposition', id: 'hesk', who: 'player', value: 'friendly', reason: 'a kind word' }, /a kind word/, 'you tipped well', 'reason'],
    ]) {
        const { c, st } = notes([s]);
        const stamp = st(s.type);
        let doc = draw([0]);
        let el = noteEl(doc, re);
        assert.ok(el.className.includes('worldscrawl_npcchange'), s.type);
        assert.deepEqual(btns(el), ['Edit', 'Turn off', 'Undo'], s.type);
        byText(el, 'Edit').click();
        await flush(10);
        el = noteEl(doc, re);
        assert.deepEqual(btns(el), ['Close editor', 'Approve edited', 'Turn off', 'Undo'], s.type);
        const box = el.querySelector('.worldscrawl_note_text');
        box.value = typed; box.dispatchEvent({ type: 'input' });
        byText(el, 'Approve edited').click();
        await flush(30);
        assert.equal(stamp[key], typed, s.type);
        const typedRe = new RegExp(typed);
        byText(noteEl(doc, typedRe), 'Turn off').click();
        await flush(30);
        assert.equal(stamp.off, true, s.type);
        el = noteEl(doc, typedRe);
        assert.equal(el.dataset.state, 'off');
        assert.deepEqual(btns(el), ['Turn on', 'Undo']);
        byText(el, 'Turn on').click();
        await flush(30);
        assert.equal(stamp.off, false, s.type);
        byText(noteEl(doc, typedRe), 'Undo').click();
        await flush(30);
        assert.equal((c.chat[0].extra[NPC_KEY] ?? []).includes(stamp), false, s.type);
    }
});

test('a remembered person: the new-person panel replaces the Looks/Body block; Edit opens every field and clears only the changed field\'s ⚠', async () => {
    const { st } = notes([{ type: 'npc_create', id: 'maren', name: 'Maren', line: 'A knife-grinder.', looks: 'wiry woman', body: 'Wiry, with grey eyes.', outfit: 'A patched smock.', history: 'A scar on the chin.', facts: [], invented: ['grey eyes', 'scar on the chin'] }]);
    const s = st('npc_create');
    let doc = draw([0]);
    let el = noteEl(doc, /Maren remembered/);
    assert.equal(doc.querySelector('.worldscrawl_npccreate_more'), null, 'no old block');
    assert.match(el.querySelector('.worldscrawl_diff').textContent, /new person/);
    assert.match(el.querySelector('.worldscrawl_invented').textContent, /grey eyes; scar on the chin/);
    byText(el, 'Edit').click();
    await flush(10);
    el = noteEl(doc, /Maren remembered/);
    const box = k => noteEl(doc, /Maren remembered/).querySelector(`.worldscrawl_remember_${k}`);
    assert.deepEqual(['name', 'line', 'looks', 'body', 'outfit', 'history'].map(k => box(k)?.value), ['Maren', 'A knife-grinder.', 'wiry woman', 'Wiry, with grey eyes.', 'A patched smock.', 'A scar on the chin.']);
    box('body').value = 'Wiry and stooped.'; box('body').dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click();
    await flush(30);
    assert.equal(s.body, 'Wiry and stooped.');
    assert.deepEqual(s.invented, ['scar on the chin']);
});

const UPSTAIRS = 'riverton:drowned_rat/upstairs', STABLE = 'riverton:drowned_rat/stable';
const ROAMER = { ...HESK, schedule: [{ activity: 'resting', where: 'her own room', near: 'riverton:drowned_rat' }] };
test('found: Edit opens the room box, Approve edited moves the find; a stale card does nothing; Turn off, Turn on, Undo', async () => {
    const { c, st } = notes([{ type: 'npc_found', id: 'hesk', where: 'her own room', place: TAVERN }], [ROAMER]);
    const s = st('npc_found');
    // The world's places, so the found check can see that her own room is near the Drowned Rat.
    const { load_world } = await import('../../plugin/world.mjs');
    const { worldPlaces } = await import('../../plugin/cast.mjs');
    const wp = worldPlaces(load_world(RIVERTON));
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [ROAMER], places: [...wp.addresses], subs: wp.subs, regions: wp.regions, elsewhere: wp.elsewhere, place_names: wp.names, place_labels: wp.labels }] });
    let doc = draw([0]);
    let el = doc.querySelector('.worldscrawl_found');
    assert.ok(el.className.includes('worldscrawl_card_found'));
    assert.deepEqual(btns(el), ['Edit', 'Turn off', 'Undo']);
    byText(el, 'Edit').click();
    await flush(10);
    el = doc.querySelector('.worldscrawl_found');
    assert.deepEqual(btns(el), ['Close editor', 'Approve edited', 'Turn off', 'Undo']);
    let box = el.querySelector('.worldscrawl_found_place');
    assert.equal(box.value, TAVERN);
    box.value = UPSTAIRS; box.dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click();
    await flush(60);
    assert.equal(s.place, UPSTAIRS, 'moved');
    // Stale: the find moved in place after the card was drawn (no revision bump, so only the ticket can tell).
    byText(doc.querySelector('.worldscrawl_found'), 'Edit').click();
    await flush(10);
    el = doc.querySelector('.worldscrawl_found');
    box = el.querySelector('.worldscrawl_found_place');
    const stale = byText(el, 'Approve edited');
    s.place = STABLE;
    box.value = TAVERN; box.dispatchEvent({ type: 'input' });
    stale.click();
    await flush(60);
    assert.equal(s.place, STABLE, 'the stale save wrote nothing');
    cardedit.closeCardEditor(`0|found|hesk|her own room`);
    doc = draw([0]);
    byText(doc.querySelector('.worldscrawl_found'), 'Turn off').click();
    await flush(30);
    assert.equal(s.off, true);
    byText(doc.querySelector('.worldscrawl_found'), 'Turn on').click();
    await flush(30);
    assert.equal(s.off, false);
    byText(doc.querySelector('.worldscrawl_found'), 'Undo').click();
    await flush(30);
    assert.equal((c.chat[0].extra[NPC_KEY] ?? []).includes(s), false);
});

test('note stale: an edit from a card drawn before the note was edited elsewhere writes nothing', async () => {
    const { c, st } = notes([{ type: 'npc_memory', id: 'hesk', note: 'she promised a room' }]);
    const s = st('npc_memory');
    let doc = draw([0]);
    byText(noteEl(doc, /promised/), 'Edit').click();
    await flush(10);
    const el = noteEl(doc, /promised/);
    const box = el.querySelector('.worldscrawl_note_text');
    box.value = 'typed here'; box.dispatchEvent({ type: 'input' });
    const ok = byText(el, 'Approve edited');
    s.note = 'she promised the cellar'; // rewritten in place (no revision bump), so only the card's ticket can tell
    ok.click();
    await flush(30);
    assert.equal(s.note, 'she promised the cellar');
});

// ---- S5: status cards
const { APPEAR_KEY } = await import('../../extension/scene.mjs');
function flagged(f) {
    const c = boot([
        { is_user: true, mes: 'I kick the stool over.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        { is_user: false, mes: 'The stool splinters the floorboards near the bar.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [FLAG]: { swipe: 0, start: 0, loc: TAVERN, ...f } } },
    ], []);
    return { c };
}
const statusEl = doc => doc.querySelector('.worldscrawl_flagstatus');

test('flag status cards: each status has its fixed buttons ("Check again", "Dismiss" only on info), and the range picker with Check again', () => {
    for (const [status, state, want] of [['user', 'info', ['Dismiss']], ['working', 'working', []], ['nothing', 'info', ['Check again', 'Dismiss']], ['cant', 'failed', ['Check again', 'Discard']], ['error', 'failed', ['Check again', 'Discard']], ['weird', 'failed', ['Check again', 'Discard']]]) {
        flagged({ status, error: 'x' });
        const el = statusEl(draw());
        assert.equal(el.dataset.state, state, status);
        assert.deepEqual(btns(el), want, status);
        assert.ok(el.querySelector(`.worldscrawl_flag_${status}`), status);
        assert.equal(!!el.querySelector('.worldscrawl_start'), want.includes('Check again'), `${status}: range picker`);
        assert.equal(el.querySelectorAll('.worldscrawl_card_btn').some(b => b.textContent === 'Retry'), false);
    }
});

test('flag status: Check again re-reads the story into a proposal; Dismiss closes the notice; a stale card does nothing', async () => {
    let { c } = flagged({ status: 'nothing' });
    const calls = model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: BOARDS }] }) });
    byText(statusEl(draw()), 'Check again').click();
    for (let i = 0; i < 100 && c.chat[1].extra[FLAG]?.status !== 'review'; i++) await flush(10);
    assert.equal(c.chat[1].extra[FLAG].status, 'review');
    assert.ok(calls.length > 0);
    assert.ok(draw().querySelector('.worldscrawl_flagreview'), 'now the review card');

    ({ c } = flagged({ status: 'user' }));
    byText(statusEl(draw()), 'Dismiss').click();
    await flush(30);
    assert.ok(!c.chat[1].extra[FLAG] || c.chat[1].extra[FLAG].status === 'discarded', JSON.stringify(c.chat[1].extra[FLAG]));
    assert.equal(statusEl(draw()), null);

    ({ c } = flagged({ status: 'cant', error: 'no' }));
    const stale = model({});
    const b = byText(statusEl(draw()), 'Check again');
    const newer = { swipe: 0, start: 0, loc: TAVERN, status: 'error', error: 'newer' };
    c.chat[1].extra[FLAG] = newer;
    b.click();
    await flush(40);
    assert.equal(stale.length, 0, 'no model call');
    assert.equal(c.chat[1].extra[FLAG], newer, 'the stale click wrote nothing');
});

/** A narrator wait proposed on message 1. */
function waiting(seconds = 7200, label = '2h') {
    const c = boot([{ is_user: true, mes: 'I sit.', extra: {} }, { is_user: false, mes: 'Hours pass.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} }], []);
    ext.proposeWait(c.chat[1], { seconds, sleep: false, label, reason: 'a long meal' });
    return { c };
}
const waitCardEl = doc => doc.querySelector('.worldscrawl_waitcard');

test('wait card: no Amount box until Edit; panel "Time passes"; Edit → Approve edited lets the typed amount pass', async () => {
    const { c } = waiting();
    let doc = draw();
    let el = waitCardEl(doc);
    assert.ok(el.className.includes('worldscrawl_card_wait') && el.className.includes('worldscrawl_pending'));
    assert.deepEqual(btns(el), ['Edit', 'Approve', 'Discard'], 'no Adjust');
    assert.equal(el.querySelector('.worldscrawl_wait_amount'), null, 'no always-open Amount box');
    assert.match(el.querySelector('.worldscrawl_wait_reason').textContent, /Why: a long meal/);
    assert.match(el.querySelector('.worldscrawl_diff').textContent, /Time passes/);
    byText(el, 'Edit').click();
    doc = draw();
    el = waitCardEl(doc);
    assert.deepEqual(btns(el), ['Close editor', 'Approve edited', 'Discard']);
    const box = el.querySelector('.worldscrawl_wait_amount');
    assert.equal(box.value, '2h');
    box.value = '6h'; box.dispatchEvent({ type: 'input' });
    byText(el, 'Approve edited').click();
    await flush(80);
    assert.equal(c.chat[1].extra.worldscrawl_wait?.seconds, 6 * 3600);
    assert.equal(c.chat[1].extra.worldscrawl_waitcard, undefined);
    doc = draw();
    assert.equal(waitCardEl(doc), null);
    assert.match(doc.querySelector('.worldscrawl_resolved').textContent, /✓ Approved \(edited\): .*6h/);
});

test('wait card: Approve lets the proposed amount pass; Discard lets none; a stale card does nothing', async () => {
    let { c } = waiting();
    byText(waitCardEl(draw()), 'Approve').click();
    await flush(80);
    assert.equal(c.chat[1].extra.worldscrawl_wait?.seconds, 7200);
    assert.match(draw().querySelector('.worldscrawl_resolved').textContent, /✓ Approved:/);

    ({ c } = waiting());
    byText(waitCardEl(draw()), 'Discard').click();
    await flush(40);
    assert.equal(c.chat[1].extra.worldscrawl_wait, undefined);
    assert.match(draw().querySelector('.worldscrawl_resolved').textContent, /✓ Discarded/);

    ({ c } = waiting());
    const b = byText(waitCardEl(draw()), 'Approve');
    ext.proposeWait(c.chat[1], { seconds: 3600, sleep: false, label: '1h', reason: 'newer' }); // a newer card replaced it
    b.click();
    await flush(60);
    assert.equal(c.chat[1].extra.worldscrawl_wait, undefined, 'the stale Approve let no time pass');
    assert.equal(c.chat[1].extra.worldscrawl_waitcard.label, '1h');
});

test('appearance job: working has no buttons; failed has Check again, which asks again; a stale card does nothing', async () => {
    const w = C.appearJob({ key: 'k', name: 'Hesk', status: 'working' });
    assert.equal(w.state, 'working');
    assert.deepEqual(w.actions, [], 'working: no buttons (a working job with no call in flight is shown as failed)');
    assert.equal(w.title, 'Appearance rebuild for Hesk: working…');
    const job = (more = {}) => ({ id: 'hesk', key: 'body', name: 'Hesk', status: 'failed', reason: 'the model timed out.', ...more });
    const c = boot([{ is_user: false, mes: 'Hesk is here.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [APPEAR_KEY]: { swipe: 0, jobs: [job()] } } }]);
    let el = draw([0]).querySelector('.worldscrawl_appearpending');
    assert.equal(el.dataset.state, 'failed');
    assert.match(el.querySelector('.worldscrawl_remember_failed').textContent, /Appearance rebuild for Hesk failed\. the model timed out\./);
    assert.deepEqual(btns(el), ['Check again']);
    // Stale: the job was retried elsewhere (a new job) after the card was drawn.
    const b = byText(el, 'Check again');
    const newer = job({ token: 't2', reason: 'again' });
    c.chat[0].extra[APPEAR_KEY] = { swipe: 0, jobs: [newer] };
    b.click();
    await flush(40);
    assert.deepEqual(c.chat[0].extra[APPEAR_KEY].jobs, [newer], 'nothing cleared');
    byText(draw([0]).querySelector('.worldscrawl_appearpending'), 'Check again').click();
    await flush(60);
    assert.equal((c.chat[0].extra[APPEAR_KEY]?.jobs ?? []).some(j => j.status === 'failed' && j.reason === 'again'), false, 'cleared and asked again');
});

test('resolved and warning lines are drawn by the shared card', () => {
    const c = boot([{ is_user: false, mes: 'x', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_decided: { remember_a: { action: 'approve', swipe: 0, text: 'remembered Maren' } }, [NPC_WARN_KEY]: [{ swipe: 0, text: 'a person update did not land' }] } }]);
    const doc = draw([0]);
    const r = doc.querySelector('.worldscrawl_resolved');
    assert.ok(r.className.includes('worldscrawl_card'));
    assert.equal(r.textContent, '✓ Approved: remembered Maren');
    const w = doc.querySelector('.worldscrawl_npcwarn');
    assert.ok(w.className.includes('worldscrawl_card'));
    assert.equal(w.textContent, '⚠ a person update did not land');
    assert.equal(btns(r).length + btns(w).length, 0);
    void c;
});

// ---- S6: the inspector's Approve edited on a kept change (map channel change_restamp)
const { openMapChannel } = await import('../../extension/mapwindow.mjs');
class FakeChan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; FakeChan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    removeEventListener(type, fn) { this.listeners = this.listeners.filter(f => f !== fn); }
    postMessage(data) { for (const ch of FakeChan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
function mapSide() {
    FakeChan.all = [];
    globalThis.BroadcastChannel = FakeChan;
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', backgroundColor: '' });
    openMapChannel();
    const gui = new FakeChan('worldscrawl');
    let n = 0;
    const ask = (type, payload) => new Promise(res => {
        const req = `t${++n}`, on = ev => { if (ev.data?.type === `${type}_result` && ev.data.req === req) { gui.removeEventListener('message', on); res(ev.data); } };
        gui.addEventListener('message', on); gui.postMessage({ type, req, chatId: 'cards1', ...payload });
    });
    return { ask };
}

test('inspector Approve edited: change_restamp re-stamps the kept change on its message; a stale sig or off state writes nothing', async () => {
    const { c, p } = await keptChange();
    const { ask } = mapSide();
    const typed = [{ ...p.ops[0], text: 'Rebuilt, smelling of fresh pine.' }];
    let r = await ask('change_restamp', { msg: 1, id: p.id, ops: typed, note: 'rebuilt', sig: JSON.stringify(p.ops), off: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    const now = c.chat[1].extra.worldscrawl_patches[0];
    assert.equal(now.id, p.id, 'same change, same message');
    assert.equal(now.ops[0].text, 'Rebuilt, smelling of fresh pine.');
    assert.equal(now.note, 'rebuilt');
    r = await ask('change_restamp', { msg: 1, id: p.id, ops: [{ ...p.ops[0], text: 'From an older inspector.' }], sig: JSON.stringify([{ ...p.ops[0], text: BOARDS }]), off: false });
    assert.equal(r.stale, true, 'drawn before the edit');
    assert.equal(now.ops[0].text, 'Rebuilt, smelling of fresh pine.');
    r = await ask('change_restamp', { msg: 1, id: p.id, ops: [{ ...p.ops[0], text: 'Drawn while it was off.' }], sig: JSON.stringify(now.ops), off: true });
    assert.equal(r.stale, true, 'drawn in another on/off state');
    assert.equal(now.ops[0].text, 'Rebuilt, smelling of fresh pine.');
});

test('the GUI cards come from the same adapters: buttons for each Changes row type', async () => {
    const { stampCard } = await import('../../plugin/ui/castdata.mjs');
    const base = { msg: 0, index: 0, identity: { owner: 'o' }, decisionRev: 1, sig: 'x', summary: 'Hesk: owes a favor' };
    const ids = x => stampCard(x, { who: 'Hesk' }).desc.actions.map(a => a.id);
    assert.deepEqual(ids({ ...base, type: 'npc_fact', text: 'owes a favor', pending: true }), ['edit', 'approve', 'discard']);
    assert.deepEqual(ids({ ...base, type: 'npc_fact', text: 'owes a favor' }), ['edit', 'off', 'undo']);
    assert.deepEqual(ids({ ...base, type: 'npc_memory', note: 'n', off: true }), ['on', 'undo']);
    assert.deepEqual(ids({ ...base, type: 'npc_found', where: 'the bar', place: TAVERN }), ['edit', 'off', 'undo']);
    assert.deepEqual(ids({ ...base, type: 'npc_appearance', fields: 'body' }), ['edit', 'off', 'undo']);
    assert.deepEqual(ids({ ...base, type: 'npc_appearance', candidate: 'failed', scopeLevel: 'light' }), ['again', 'edit', 'scope', 'discard']);
    assert.equal(stampCard({ ...base, type: 'npc_appearance_cache' }), null);
    const found = stampCard({ ...base, type: 'npc_found', where: 'the bar', place: TAVERN }, { who: 'Hesk', editing: true });
    assert.equal(found.type, 'found');
    assert.equal(found.desc.editor.fields[0].value, TAVERN);
});
