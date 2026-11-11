// The shared card (plugin/ui/card.mjs), editor (cardedit.mjs), descriptors (plugin/shared/cards.mjs) and the action
// layer (extension/cardacts.mjs), driven through the real renderPatchCards and real handlers with fakedom clicks.
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
const { applyTrackerResult } = await import('../../extension/discovery.mjs');
const { readTrackerAnswer } = await import('../../extension/tracker.mjs');
const { NPC_KEY, npcAt } = await import('../../extension/npc.mjs');
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
    for (const type of Object.keys(acts.HANDLERS)) assert.equal((await acts.runCardAction(type, 'approve', null)).error, 'no ticket');
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
