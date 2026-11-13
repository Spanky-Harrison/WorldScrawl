// Light-touch appearance edits, through the real handlers (applyTrackerResult -> makeOwner -> fillCandidate -> the
// compose call) with a fake model: the light-only edit prompt, only the named fields asked, one call when the lasting
// and live inputs are the same, and the prompt wording (look, not the moment; tracker intent and lasts).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ext = await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const { NPC_KEY } = await import('../../extension/npc.mjs');
const { applyTrackerResult } = await import('../../extension/discovery.mjs');
const { composePlan } = await import('../../extension/owners.mjs');
const { loadCalendar, rememberWorlds } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const promptText = id => PROMPTS.prompts.find(p => p.id === id)?.text ?? '';
// Hesk's base Body and Outfit as in the Nov 11 chat.
const BASE = {
    body: 'A tall, raw-boned woman in her late forties, broad through the shoulders from years of hauling casks. Two thick copper braids, threaded with grey at the temples, hang to her waist. Her face is weathered and freckled, with a hard jaw, pale grey eyes and a thin white scar through her left eyebrow.',
    outfit: "Widow's black wool under a stained leather apron, sleeves rolled to the elbow, and a ring of keys at her belt.",
};
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: BASE.body, outfit: BASE.outfit, file: 'hesk.json' };
// A real light touch on Body: one of its three sentences reworded, the other two kept word for word.
const TIED = BASE.body.replace(/Two thick copper braids[^.]*\./, 'Her copper braids are tied back in a knot for work.');
const LIGHT_SYS = /^You make a small edit to a person's body or clothes/;
const FULL_SYS = /^You rewrite a person's body and clothes/;

/** A chat with Hesk; every compose call is recorded as {system, prompt}; `answer` gives the compose reply. */
function boot(answer = () => '{"outfit":"Widow\'s black wool, damp at the hem, under a stained leather apron."}') {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'lt'; c.getCurrentChatId = () => 'lt';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    const calls = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), system = String(args?.systemPrompt ?? '');
        if (/Looks line/.test(prompt)) return '{"looks":"a big woman with copper braids"}';
        calls.push({ system, prompt });
        return answer(prompt, system);
    };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true });
    c.chat = [{ mes: 'The landlady comes in from the courtyard.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm4', worldscrawl_npc_baseline: { hesk: { ...BASE } } } }];
    return { c, calls };
}
const ownerOn = (c, i = 0) => (c.chat[i].extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appearance').at(-1);

test('the Hesk case: the tracker\'s light outfit change (fill runs inside applyTrackerResult) asks one light edit for the outfit only; Body comes back as the base', async () => {
    const { c, calls } = boot();
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'apron wet and stained from the bucket', fields: 'outfit', scope: 'light', why: 'one detail changed' }] });
    const o = ownerOn(c);
    assert.equal(o.candidate.scope, 'light');
    assert.equal(o.candidate.fields, 'outfit');
    assert.equal(o.candidate.phase, 'review');
    assert.equal(calls.length, 1, 'one compose call: no lasts, so lasting and live are the same inputs');
    assert.match(calls[0].system, LIGHT_SYS, 'the light-only edit prompt');
    assert.doesNotMatch(calls[0].system, /full rewrite|from scratch/);
    assert.match(calls[0].prompt, /^Edit outfit for Hesk: copy the base and change only the words the intents name\./, 'the light question says Edit, not Rewrite');
    assert.match(calls[0].prompt, /- outfit: Widow's black wool/);
    assert.doesNotMatch(calls[0].prompt, /- body:/, 'Body is not asked for');
    assert.equal(o.candidate.lastingPreview.body, BASE.body, 'Body is the base, word for word');
    assert.equal(o.candidate.lastingPreview.outfit, "Widow's black wool, damp at the hem, under a stained leather apron.");
    assert.deepEqual(o.candidate.livePreview, o.candidate.lastingPreview, 'live and lasting are the same text');
    assert.equal(o.candidate.liveKey, o.candidate.lastingKey);
});

test('a light change on both fields uses the light prompt and asks both; an extra field in the answer is ignored', async () => {
    const { c, calls } = boot(() => JSON.stringify({ body: TIED, outfit: 'damp hem', looks: 'x' }));
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back, hem damp', fields: 'body,outfit', scope: 'light', why: 'two details' }] });
    const o = ownerOn(c);
    assert.equal(o.candidate.phase, 'review');
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, LIGHT_SYS);
    assert.match(calls[0].prompt, /^Edit body, outfit for Hesk:/);
    assert.deepEqual(o.candidate.lastingPreview, { body: TIED, outfit: 'damp hem' });
});

test('a body-only light change: an answer that also rewrites the outfit keeps the base outfit', async () => {
    const { c, calls } = boot(() => JSON.stringify({ body: TIED, outfit: 'a whole new outfit' }));
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back', fields: 'body', scope: 'light' }] });
    const o = ownerOn(c);
    assert.equal(o.candidate.phase, 'review');
    assert.equal(calls.length, 1);
    assert.equal(o.candidate.lastingPreview.outfit, BASE.outfit);
    assert.equal(o.candidate.lastingPreview.body, TIED);
});

test('an answer missing an asked field is still partial (nothing stored, the card fails)', async () => {
    const { c, calls } = boot(() => '{"outfit":"only an outfit"}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back', fields: 'body', scope: 'light' }] });
    const o = ownerOn(c);
    assert.equal(o.candidate.phase, 'failed');
    assert.equal(calls.length, 2, 'tried twice');
});

test('mixed light and full keeps the rewrite prompt, with each intent marked', async () => {
    const { c, calls } = boot(() => '{"body":"a furred gnoll","outfit":"damp hem"}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'turned into a gnoll', fields: 'body', scope: 'heavy', why: 'whole body' }] });
    const gnoll = ownerOn(c);
    assert.equal(gnoll.candidate.phase, 'review');
    assert.match(calls.at(-1).system, FULL_SYS, 'a full rewrite alone: the rewrite prompt');
    assert.ok(scene.decideNpc(c.chat, gnoll.identity, gnoll.decisionRev, 'approve', { token: gnoll.candidate.token, elapsed: 0 }).ok);
    c.chat.push({ mes: 'She sets the bucket down.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm5' } });
    calls.length = 0;
    await applyTrackerResult(1, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const hem = ownerOn(c, 1);
    assert.equal(hem.candidate.phase, 'review');
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, FULL_SYS, 'light + full: the old rewrite prompt');
    assert.match(calls[0].prompt, /turned into a gnoll \[body\] \(full rewrite\)/);
    assert.match(calls[0].prompt, /hem damp \[outfit\] \(light touch\)/);
    assert.match(calls[0].prompt, /^Rewrite body, outfit for Hesk\./, 'both fields: both ops name one');
});

test('a temporary change: lasting is the base (no call), live is one light edit', async () => {
    const { c, calls } = boot(() => '{"outfit":"damp hem"}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', lasts: '2 hours', scope: 'light' }] });
    const o = ownerOn(c);
    assert.equal(o.candidate.phase, 'review');
    // Lasting has no ops (the base, no call); live has the temporary op: one call.
    assert.equal(calls.length, 1);
    assert.notEqual(o.candidate.liveKey, o.candidate.lastingKey);
    assert.equal(o.candidate.lastingPreview.outfit, BASE.outfit);
    assert.equal(o.candidate.livePreview.outfit, 'damp hem');
});

test('composePlan: fields are the union the ops name; heavy anywhere picks the rewrite prompt; nothing named asks both', () => {
    const op = (fields, scope, kind = 'appearance') => ({ committed: { kind, fields, scope, intent: 'x' } });
    const LIGHT = { system: 'npc.appearance_edit_light_system', prompt: 'npc.appearance_edit_light', light: true, replaced: [] };
    assert.deepEqual(composePlan([op('outfit', 'light')]), { fields: ['outfit'], ...LIGHT });
    assert.deepEqual(composePlan([op('body', 'heavy'), op('outfit', 'light')]), { fields: ['body', 'outfit'], system: 'npc.appearance_rebuild_system', prompt: 'npc.appearance_rebuild', light: false, replaced: [] });
    assert.deepEqual(composePlan([op('looks', 'light')]), { fields: ['body', 'outfit'], ...LIGHT });
    assert.deepEqual(composePlan([{ committed: { kind: 'baseline', field: 'body', text: 't' } }, op('outfit', 'light')]).replaced, ['body'], 'typed text replaces Body: no keep check on it');
    assert.deepEqual(composePlan([{ committed: { kind: 'baseline', field: 'body', text: 't' } }]).fields, ['body']);
});

test('prompts: light edit copies the base; both rewrite prompts describe the look, not the moment; the tracker names only the change and when it wears off', () => {
    const light = PROMPTS.prompts.find(p => p.id === 'npc.appearance_edit_light_system');
    assert.ok(light.locked && light.title && /^Step 1 of 1/.test(light.description));
    assert.match(light.text, /keep every other sentence word for word/);
    assert.match(light.text, /A field no intent touches comes back exactly as the base\./);
    for (const id of ['npc.appearance_edit_light_system', 'npc.appearance_rebuild_system'])
        assert.match(promptText(id), /Describe how they look, not what they are doing, where they are, or the moment/, id);
    const tracker = promptText('npc.tracker');
    assert.match(tracker, /intent names only the change to their body or clothes \("braids tied back", "hem soaked"\), not how they arrived or what they did\./);
    assert.match(tracker, /When the change will wear off \(sweaty, disheveled, soaked, damp or wet clothes, mud on them, hair tied back for work, a bruise\)/);
});

// ---- B8: a light touch that keeps less than half of the base is asked once more, then fails visibly.
const RETRY = /Your last answer changed most of the base text\. Copy each base field word for word/;
const REWRITTEN = 'A gaunt woman with cropped black hair. Her face is smooth and young. She has dark eyes.';
test('a light touch that kept less than half of Body is asked once more with the retry line; the second answer keeps enough and is used', async () => {
    let n = 0;
    const { c, calls } = boot(() => JSON.stringify({ body: ++n === 1 ? REWRITTEN : TIED }));
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back', fields: 'body', scope: 'light' }] });
    const o = ownerOn(c);
    assert.equal(calls.length, 2, 'one retry');
    assert.doesNotMatch(calls[0].prompt, RETRY);
    assert.match(calls[1].prompt, RETRY);
    assert.match(calls[1].system, LIGHT_SYS);
    assert.equal(o.candidate.phase, 'review');
    assert.equal(o.candidate.lastingPreview.body, TIED);
});

test('a light touch that keeps less than half twice fails on the card with the reason (nothing stored)', async () => {
    const { c, calls } = boot(() => JSON.stringify({ body: REWRITTEN }));
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back', fields: 'body', scope: 'light' }] });
    const o = ownerOn(c);
    assert.equal(calls.length, 2);
    assert.equal(o.candidate.phase, 'failed');
    assert.ok(!o.candidate.lastingPreview, 'no rewritten text kept');
    assert.match(JSON.stringify(c.chat[0].extra), /the light touch changed more than half of the body/);
    const { makeDoc } = await import('./fakedom.mjs');
    const { renderPatchCards } = await import('../../extension/waits.mjs');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    assert.match(doc.querySelector('.worldscrawl_npcpending')?.textContent ?? '', /the light touch changed more than half of the body/, 'the card says why');
});

test('a full rewrite is never held to the keep check; a one-sentence field (Outfit) always counts as kept', async () => {
    let r = boot(() => JSON.stringify({ body: REWRITTEN }));
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'turned into someone else', fields: 'body', scope: 'heavy' }] });
    assert.equal(r.calls.length, 1);
    assert.equal(ownerOn(r.c).candidate.phase, 'review');
    assert.match(r.calls[0].prompt, /^Rewrite body for Hesk\./, 'the full question still says Rewrite');
    r = boot(() => '{"outfit":"A red silk gown."}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'apron off', fields: 'outfit', scope: 'light' }] });
    assert.equal(r.calls.length, 1);
    assert.equal(ownerOn(r.c).candidate.phase, 'review');
});
