// Light touch / full rewrite on place (map) change proposals, through the production paths: real tracker JSON ->
// readTrackerAnswer/readPlace -> applyTrackerResult -> flagMessage -> analyzeFlag (stubbed model, the real map server
// in-process) -> the review card's buttons.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN, YARD } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { applyTrackerResult, flagMessage } = await import('../../extension/discovery.mjs');
const { readTrackerAnswer, readPlace } = await import('../../extension/tracker.mjs');
const { analyzeFlag, swapRewrite } = await import('../../extension/carriers.mjs');
const rr = await import('../../extension/arearewrite.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const FLAG = 'worldscrawl_flag';
const server = clientDir(path.dirname(RIVERTON));
const COMMON_WAS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));

globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

/** A stubbed model: answers by which question it was asked. Records every prompt. */
function model(answers) {
    const calls = [];
    const c = SillyTavern.getContext();
    c.generateRaw = async args => {
        const p = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        calls.push({ prompt: p, sys });
        const kind = /Which places did the story change/.test(p) ? 'rooms' : /Write the patch JSON/.test(p) ? 'patch' : /Write the ops JSON/.test(p) ? 'rewrite' : 'other';
        const a = answers[kind];
        return typeof a === 'function' ? a(p, sys) : a ?? '{}';
    };
    return calls;
}
function boot() {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'area1'; c.getCurrentChatId = () => 'area1';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    ext.settings().flagTags = true; ext.settings().flagNpcs = true; ext.settings().autoKeep = false;
    c.chat = [
        { is_user: true, mes: 'I kick the stool over.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        { is_user: false, mes: 'The stool splinters the floorboards near the bar.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} },
    ];
    return c;
}
async function settled(id = 1) {
    for (let i = 0; i < 100; i++) { const f = SillyTavern.getContext().chat[id]?.extra?.[FLAG]; if (f && f.status !== 'working') return f; await flush(10); }
    throw new Error('the flag never settled');
}
const btns = root => root.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const byText = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
function draw() { const doc = makeDoc([0, 1]); globalThis.document = doc; renderPatchCards(); return doc; }

const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie near a knocked-over stool, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const PALACE = 'A gilded throne hall under a painted ceiling. An old oak bar rail shows under the gold leaf, and a marble stair sweeps up to the galleries.';
const YARD_EXIT = 'A gilded archway into the courtyard.';
const ops = list => JSON.stringify({ ops: list });
const descOp = (text, extra = {}) => ({ op: 'set_description', loc: TAVERN, text, ...extra });
const blockBack = { op: 'block_exit', loc: TAVERN, direction: 'back', lasts: '1h' };
const tracker = place => readTrackerAnswer(JSON.stringify({ place: { changed: true, kind: 'change', ...place }, people: [], wait: null }));
const flagOf = () => SillyTavern.getContext().chat[1].extra[FLAG];
async function proposed(place, patch, more = {}) {
    const c = boot();
    const calls = model({ rooms: `{"rooms":["${TAVERN}"]}`, patch, ...more });
    await applyTrackerResult(1, tracker(place));
    const f = await settled();
    assert.equal(f.status, 'review', f.error);
    return { c, calls, f };
}
const sentences = t => t.split(/(?<=\.)\s+/);

test('tracker rewrite/why: readPlace keeps them, the flag and proposal carry them, the patch prompt follows, the card shows them', async () => {
    assert.deepEqual(readPlace({ changed: true, kind: 'change', note: 'boards', rewrite: 'Full', why: 'remade' }), { changed: true, kind: 'change', note: 'boards', rewrite: 'full', why: 'remade' });
    assert.equal(readPlace({ changed: true, note: 'boards', why: 'no pick given' }).why, undefined, 'a reason without a pick is dropped');
    assert.equal(readTrackerAnswer('{"changes":[{"type":"place","note":"boards","rewrite":"light","why":"one spot"}]}').place.rewrite, 'light', 'the changes[] form too');
    const { calls, f } = await proposed({ note: 'the stool splintered the floorboards', rewrite: 'light', why: 'only the floor' }, ops([descOp(BOARDS), blockBack]));
    assert.equal(f.rewrite, 'light'); assert.equal(f.why, 'only the floor'); assert.equal(f.proposal.rewrite, 'light');
    const patchQ = calls.find(x => /Write the patch JSON/.test(x.prompt)).prompt;
    assert.match(patchQ, /How much to rewrite: light touch\. In each existing description, note or exit text you change, change only what the note names/);
    assert.match(patchQ, /Prefer one set_description with the whole edited text over append_description/);
    const doc = draw();
    assert.equal(doc.querySelector('.worldscrawl_scope').textContent, 'Light touch: only the floor');
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard']);

    const full = await proposed({ note: 'the inn became a palace', rewrite: 'full', why: 'the whole room is remade' }, ops([descOp(PALACE)]));
    assert.equal(full.f.rewrite, 'full');
    assert.match(full.calls.find(x => /Write the patch JSON/.test(x.prompt)).prompt, /How much to rewrite: full rewrite\. The change remakes the place/);
    const doc2 = draw();
    assert.equal(doc2.querySelector('.worldscrawl_scope').textContent, 'Full rewrite: the whole room is remade');
    assert.ok(byText(doc2, 'Make it a light touch'));
});

test('no pick from the tracker says "not judged"; a flag the player raised is a plain light touch; a discovery has none', async () => {
    const { f } = await proposed({ note: 'boards', why: 'invented?' }, ops([descOp(BOARDS)]));
    assert.equal(f.rewrite, 'light'); assert.equal(f.why, 'not judged, so the default');
    assert.equal(draw().querySelector('.worldscrawl_scope').textContent, 'Light touch: not judged, so the default');

    const c = boot();
    model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(BOARDS)]) });
    await flagMessage(1, { note: 'the floor splintered', source: 'command' });
    const g = await settled();
    assert.equal(g.rewrite, 'light'); assert.equal(g.why, undefined);
    assert.equal(draw().querySelector('.worldscrawl_scope').textContent, 'Light touch');

    boot();
    model({ other: '{}' });
    await flagMessage(1, { note: 'the trapdoor', kind: 'discover', source: 'command' });
    assert.equal(flagOf().rewrite, undefined, 'discoveries make new rooms: no rewrite');
});

test('a light swap rewrites only the listed text: sentences the note does not name stay, every other edit and lasts stay', async () => {
    const { calls, f } = await proposed({ note: 'the stool splintered the floorboards', rewrite: 'full', why: 'judged big' }, ops([descOp(PALACE), blockBack]));
    const before = structuredClone(f.proposal.ops), rooms = Object.keys(f.proposal.after).sort();
    assert.ok(calls.some(x => /How much to rewrite: full rewrite/.test(x.prompt)));
    const calls2 = model({ rewrite: ops([descOp(BOARDS)]) }); // the stub's light answer: one clause added, the rest as written
    byText(draw(), 'Make it a light touch').click();
    await flush(60);
    assert.equal(calls2.length, 1, 'one call, and not the which-rooms or patch steps');
    assert.match(calls2[0].prompt, /1\. the description of Common Room \(riverton:drowned_rat\/common_room\)\. Answer with \{"op":"set_description"/);
    assert.ok(calls2[0].prompt.includes(`Before the change: ${COMMON_WAS}`));
    assert.ok(calls2[0].prompt.includes(`As proposed now: ${PALACE}`));
    assert.match(calls2[0].prompt, /How much to rewrite: light touch/);
    assert.match(calls2[0].sys, /Never add other ops, never change an address, an exit name or how long anything lasts/);
    assert.match(calls2[0].sys, /about the place, not the characters/, 'the description rule and "not the characters" still apply');
    const g = flagOf();
    assert.equal(g.status, 'review');
    assert.equal(g.rewrite, 'light'); assert.equal(g.why, 'set by you');
    assert.equal(g.proposal.ops.length, 2);
    assert.deepEqual(g.proposal.ops[1], before[1], 'the blocked exit and its 1h are untouched');
    const was = sentences(COMMON_WAS), now = sentences(g.proposal.ops[0].text);
    assert.equal(now[0], was[0], 'the first sentence, which the note does not name, is identical');
    assert.equal(now.length, was.length);
    assert.deepEqual(Object.keys(g.proposal.after).sort(), rooms, 'the same rooms');
    const doc = draw();
    assert.equal(doc.querySelector('.worldscrawl_scope').textContent, 'Light touch: set by you');
    assert.ok(byText(doc, 'Make it a full rewrite'));
});

test('a full swap stays within the selected rooms; a rewrite of an unselected room or a non-text edit is rejected and the old proposal kept', async () => {
    const exitText = { op: 'set_exit_description', loc: YARD, direction: 'in', text: 'The back door into the common room, its sill splintered.' };
    const { f } = await proposed({ note: 'the inn became a palace', rewrite: 'light', why: 'judged small' }, ops([descOp(BOARDS), exitText, blockBack]),
        { rooms: `{"rooms":["${TAVERN}","${YARD}"]}` });
    const old = structuredClone(f.proposal);
    const calls = model({ rewrite: ops([descOp(PALACE), { ...exitText, text: YARD_EXIT }]) });
    byText(draw(), 'Make it a full rewrite').click();
    await flush(60);
    assert.match(calls[0].prompt, /2\. the "in" exit text of Courtyard \(riverton:drowned_rat\/courtyard\), this side only/);
    let g = flagOf();
    assert.equal(g.rewrite, 'full');
    assert.deepEqual(g.proposal.ops.map(o => [o.op, o.loc, o.direction ?? '', o.lasts ?? '']), old.ops.map(o => [o.op, o.loc, o.direction ?? '', o.lasts ?? '']));
    assert.deepEqual(Object.keys(g.proposal.after).sort(), Object.keys(old.after).sort(), 'the same rooms change');
    assert.equal(g.proposal.ops[0].text, PALACE); assert.equal(g.proposal.ops[1].text, YARD_EXIT);

    // Now back to light, but the model also rewrites the kitchens, which this change does not touch.
    const kept = structuredClone(g.proposal);
    model({ rewrite: ops([descOp(BOARDS), { op: 'set_description', loc: 'riverton:drowned_rat/kitchens', text: 'Kitchens, gilded.' }]) });
    byText(draw(), 'Make it a light touch').click();
    await flush(60);
    g = flagOf();
    assert.deepEqual(g.proposal, kept, 'rejected: the proposal is exactly as it was');
    assert.equal(g.rewrite, 'full'); assert.equal(g.why, 'set by you');
    assert.match(g.rewriteError, /Couldn't switch to a light touch: the answer rewrote riverton:drowned_rat\/kitchens, which is not one of this change's texts\. The change is as it was\./);
    const doc = draw();
    assert.match(doc.querySelector('.worldscrawl_rewrite_error').textContent, /^⚠ Couldn't switch to a light touch/);
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Edit', 'Make it a light touch', 'Approve', 'Discard'], 'the card still works');
});

test('the op-diff guard rejects a swap that changes lasts, a structural op or a target', async () => {
    for (const [answer, why] of [
        [ops([descOp(BOARDS, { lasts: '2h' })]), /changed "lasts"/],
        [ops([descOp(BOARDS), { op: 'block_exit', loc: TAVERN, direction: 'back', lasts: '3h' }]), /block_exit edit, which a rewrite can't change/],
        [ops([{ op: 'set_name', loc: TAVERN, text: 'Throne Hall' }]), /set_name edit, which a rewrite can't change/],
        [ops([{ op: 'append_description', loc: YARD, text: 'Gold.' }]), /courtyard, which is not one of this change's texts/],
        ['I would rather not', /not \{"ops": \[\.\.\.\]\} JSON/],
    ]) {
        const { f } = await proposed({ note: 'boards', rewrite: 'full' }, ops([descOp(PALACE), blockBack]));
        const old = structuredClone(f.proposal);
        model({ rewrite: answer });
        byText(draw(), 'Make it a light touch').click();
        await flush(60);
        const g = flagOf();
        assert.deepEqual(g.proposal, old, String(answer));
        assert.equal(g.rewrite, 'full');
        assert.match(g.rewriteError, why);
    }
    // The guard itself, on op lists: text may change; nothing else may.
    const a = [descOp(BOARDS), blockBack, { op: 'update_area', area: 'riverton:drowned_rat', name: 'Palace', lore: 'old' }, { op: 'set_exit', loc: YARD, direction: 'in', fields: { description: 'x', sight: 'clear' } }];
    assert.equal(rr.rewriteGuard(a, [descOp(PALACE), blockBack, { ...a[2], lore: 'new' }, { ...a[3], fields: { description: 'y', sight: 'clear' } }]), '');
    assert.equal(rr.rewriteGuard([{ op: 'append_description', loc: TAVERN, text: 'x' }], [descOp(BOARDS)]), '', 'an appended text may come back whole');
    assert.match(rr.rewriteGuard(a, [descOp(PALACE), { ...blockBack, lasts: '2h' }, a[2], a[3]]), /edit 2 \(block_exit\) changed how long it lasts/);
    assert.match(rr.rewriteGuard(a, [descOp(PALACE), { ...blockBack, op: 'lock_exit' }, a[2], a[3]]), /edit 2 became lock_exit/);
    assert.match(rr.rewriteGuard(a, [{ ...descOp(PALACE), loc: YARD }, blockBack, a[2], a[3]]), /edit 1 \(set_description\) moved to a different room/);
    assert.match(rr.rewriteGuard(a, [descOp(PALACE), blockBack, { ...a[2], name: 'Hovel' }, a[3]]), /edit 3 \(update_area\) changed more than its text/);
    assert.match(rr.rewriteGuard(a, [descOp(PALACE), blockBack, a[2], { ...a[3], fields: { description: 'y', sight: 'none' } }]), /edit 4 \(set_exit\) changed more than its text/);
    assert.match(rr.rewriteGuard(a, a.slice(0, 3)), /it has 3 edits instead of 4/);
    // Only existing prose is a target: no new rooms, structural ops, renames or a new exit's text.
    const t = rr.textTargets({ ops: [descOp(BOARDS), blockBack, { op: 'set_name', loc: TAVERN, text: 'X' }, { op: 'set_description', loc: 'riverton:drowned_rat/new_room', text: 'x' }, { op: 'set_exit_description', loc: TAVERN, direction: 'secret', text: 'x' }],
        before: { [TAVERN]: { name: 'Common Room', description: COMMON_WAS, exits: [{ direction: 'back', description: 'A back door' }] } }, after: {} });
    assert.deepEqual(t.map(x => x.key), [`desc:${TAVERN}`]);
});

test('Check again keeps the player\'s rewrite setting and note; Rewrite with this reruns both steps with the new note', async () => {
    await proposed({ note: 'the stool splintered the floorboards', rewrite: 'light', why: 'judged' }, ops([descOp(BOARDS)]));
    model({ rewrite: ops([descOp(PALACE)]) });
    byText(draw(), 'Make it a full rewrite').click();
    await flush(60);
    assert.equal(flagOf().rewrite, 'full');
    let calls = model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(PALACE)]) });
    byText(draw(), 'Check again').click();
    await settled(); await flush(30);
    let g = flagOf();
    assert.equal(g.rewrite, 'full'); assert.equal(g.why, 'set by you'); assert.equal(g.note, 'the stool splintered the floorboards');
    assert.ok(calls.some(x => /Which places did the story change/.test(x.prompt)), 'both steps ran');
    assert.match(calls.find(x => /Write the patch JSON/.test(x.prompt)).prompt, /How much to rewrite: full rewrite/);

    // Edit: the op form plus a Change box; the row follows the person card's.
    byText(draw(), 'Edit').click();
    await flush(60);
    let doc = draw();
    assert.ok(doc.querySelector('.wspf'), 'the op form is still there');
    const box = doc.querySelector('.worldscrawl_flag_intent');
    assert.equal(box.value, 'the stool splintered the floorboards');
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')).filter(b => !/^(Add|Remove|↑|↓)/.test(b)), ['Check again', 'Close editor', 'Make it a light touch', 'Rewrite with this', 'Approve edited', 'Discard']);
    box.value = 'the inn was turned into a palace';
    box.dispatchEvent({ type: 'input' });
    calls = model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(PALACE)]) });
    byText(doc, 'Rewrite with this').click();
    await settled(); await flush(30);
    g = flagOf();
    assert.equal(g.note, 'the inn was turned into a palace');
    assert.equal(g.rewrite, 'full', 'the player\'s pick is kept');
    assert.ok(calls.find(x => /Which places did the story change/.test(x.prompt)).prompt.includes('"the inn was turned into a palace"'));
    assert.ok(calls.find(x => /Write the patch JSON/.test(x.prompt)).prompt.includes('"the inn was turned into a palace"'));
    assert.ok(!patchesExt.openForms.has('1|flag'), 'the editor closed');
});

test('a swap with hand edits in the open editor asks first; no edits, no question', async () => {
    await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS), blockBack]));
    const asked = [];
    const prev = ext.hooks.confirm;
    try {
        byText(draw(), 'Edit').click();
        await flush(60);
        let calls = model({ rewrite: ops([descOp(PALACE)]) });
        ext.hooks.confirm = async t => { asked.push(t); return false; };
        byText(draw(), 'Make it a full rewrite').click();
        await flush(60);
        assert.equal(asked.length, 0, 'nothing edited: no question');
        assert.equal(flagOf().rewrite, 'full');
        assert.equal(calls.length, 1);

        byText(draw(), 'Edit').click();
        await flush(60);
        const form = patchesExt.openForms.get('1|flag');
        form.setOps([{ ...form.getOps()[0], text: 'My own words.' }, form.getOps()[1]]);
        calls = model({ rewrite: ops([descOp(BOARDS)]) });
        byText(draw(), 'Make it a light touch').click();
        await flush(60);
        assert.equal(asked.length, 1); assert.match(asked[0], /drops the edits you made in the editor/);
        assert.equal(calls.length, 0, 'cancelled: no call');
        assert.ok(patchesExt.openForms.has('1|flag'), 'cancelled: the editor and its edits stay');
        assert.equal(flagOf().rewrite, 'full');

        ext.hooks.confirm = async t => { asked.push(t); return true; };
        byText(draw(), 'Make it a light touch').click();
        await flush(60);
        assert.equal(calls.length, 1);
        assert.equal(flagOf().rewrite, 'light');
        assert.ok(!patchesExt.openForms.has('1|flag'));
    } finally { ext.hooks.confirm = prev; }
});

test('stale results: a swap answered after a swipe, a newer request or Discard writes nothing', async () => {
    const pending = () => { let release; const c = SillyTavern.getContext(); const p = new Promise(r => { release = r; }); c.generateRaw = () => p; return a => release(a); };
    // While a swap runs, the card says so and offers only Check again and Discard.
    let { f } = await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS), blockBack]));
    let release = pending();
    byText(draw(), 'Make it a full rewrite').click();
    await flush(30);
    let doc = draw();
    assert.equal(doc.querySelector('.worldscrawl_rewriting').textContent, '🗺 Rewriting the text as a full rewrite…');
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Discard']);
    // A newer request (Check again) wins over the swap still in flight.
    let calls = model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(BOARDS + ' Newer.')]) });
    byText(doc, 'Check again').click();
    await settled(); await flush(30);
    release(ops([descOp(PALACE)]));
    await flush(60);
    let g = flagOf();
    assert.equal(g.proposal.ops[0].text, BOARDS + ' Newer.');
    assert.equal(g.rewrite, 'light', 'the late swap did not land');
    assert.ok(!g.rewriteError);
    assert.ok(calls.length >= 2);

    // A swipe: the tracker's flag goes with the swipe it was on, and the late answer has nowhere to land.
    ({ f } = await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS)])));
    release = pending();
    byText(draw(), 'Make it a full rewrite').click();
    await flush(30);
    const msg = SillyTavern.getContext().chat[1];
    msg.swipe_id = 1; msg.swipes = [msg.mes, 'Another reply.']; msg.swipe_info.push({ extra: {} });
    const { onStorySwipe } = await import('../../extension/discovery.mjs');
    const r2 = pending();
    const swiping = onStorySwipe(1);
    release(ops([descOp(PALACE)]));
    await flush(60);
    r2('{"place": null, "people": [], "wait": null}');
    await swiping;
    assert.equal(msg.extra[FLAG], undefined, 'the tracker flag left with its swipe');
    assert.equal(f.proposal.ops[0].text, BOARDS, 'and the detached flag was not written to either');
    assert.equal(f.rewrite, 'light');

    // A button flag (not the tracker's) stays on the message but belongs to swipe 0: still stale.
    boot();
    model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(BOARDS)]) });
    await flagMessage(1, { note: 'boards', source: 'command' });
    const h = await settled();
    release = pending();
    byText(draw(), 'Make it a full rewrite').click();
    await flush(30);
    SillyTavern.getContext().chat[1].swipe_id = 1;
    release(ops([descOp(PALACE)]));
    await flush(60);
    assert.equal(h.proposal.ops[0].text, BOARDS); assert.equal(h.rewrite, 'light');

    // Discard during the swap: nothing comes back.
    await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS)]));
    release = pending();
    byText(draw(), 'Make it a full rewrite').click();
    await flush(30);
    byText(draw(), 'Discard').click();
    await flush(30);
    release(ops([descOp(PALACE)]));
    await flush(60);
    assert.equal(flagOf(), undefined);

    // A late analysis (Check again twice) only lands the newest.
    await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS)]));
    const first = pending();
    analyzeFlag(1);
    await flush(20);
    model({ rooms: `{"rooms":["${TAVERN}"]}`, patch: ops([descOp(BOARDS + ' Second.')]) });
    await analyzeFlag(1);
    first(`{"rooms":["${TAVERN}"]}`);
    await flush(80);
    assert.equal(flagOf().proposal.ops[0].text, BOARDS + ' Second.');
});

test('button order on the area card in each state', async () => {
    // A change with no existing text to rewrite (a door barred): no rewrite line and no switch.
    await proposed({ note: 'the back door is barred', rewrite: 'light' }, ops([blockBack]));
    let doc = draw();
    assert.equal(doc.querySelector('.worldscrawl_scope'), null);
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Edit', 'Approve', 'Discard']);
    // Text to rewrite: the switch sits after Edit, like the person card.
    await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS), blockBack]));
    doc = draw();
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard']);
    // A proposal that did not fit the map: no switch (fix it in the editor first).
    await proposed({ note: 'boards', rewrite: 'light' }, ops([{ op: 'set_description', loc: 'riverton:nowhere/room', text: 'x' }]));
    doc = draw();
    assert.ok(flagOf().proposal.invalid);
    assert.deepEqual(btns(doc.querySelector('.worldscrawl_flagreview')), ['Check again', 'Edit', 'Approve', 'Discard']);
    // Approve still keeps the proposal as before, with its text.
    await proposed({ note: 'boards', rewrite: 'light' }, ops([descOp(BOARDS)]));
    byText(draw(), 'Approve').click();
    await flush(60);
    assert.equal(flagOf().status, 'kept');
    assert.equal(SillyTavern.getContext().chat[1].extra.worldscrawl_patches[0].ops[0].text, BOARDS);
});

test('prompts: the tracker judges rewrite by the result; the patch and rewrite prompts carry the pick; nothing changes without one', async () => {
    const text = id => PROMPTS.prompts.find(e => e.id === id).text;
    assert.match(text('npc.tracker'), /"rewrite": "light", "why": "a few words"/);
    assert.match(text('npc.tracker'), /Always set rewrite for a place change, and judge it by how much of the place's description the result changes/);
    assert.match(text('npc.tracker'), /an inn turned into a palace/);
    assert.match(text('change.patch'), /\{\{what\}\}\n\{\{rewrite\}\}\{\{retry\}\}/);
    const pl = await import('../../plugin/shared/patches.mjs');
    assert.equal(pl.rewritePiece(''), '');
    assert.equal(pl.patchPrompt({ outline: [] }, {}), pl.patchPrompt({ outline: [] }, { rewrite: '' }));
    assert.match(pl.patchPrompt({ outline: [] }, { rewrite: 'full' }), /How much to rewrite: full rewrite/);
    assert.equal(rr.areaRewrite('heavy'), 'full'); assert.equal(rr.areaRewrite('medium'), 'light'); assert.equal(rr.areaRewrite(undefined), 'light');
});
