// R3 (prompt revision): appearance compose wording, through the real handlers: a tracker item -> applyTrackerResult ->
// makeOwner -> fillCandidate -> askFields (the compose call), the card's Edit (settleNpc 'edit' with the player's text)
// and approve (recompose, then the Looks summary call), with a fake model that records every call.
// A1 the light touch as a procedure; A2 the intent line from its own pieces, the player's text as "use as written";
// A3 one shared rules piece in both compose system prompts; A4 Outfit in side calls, Wearing for the narrator.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ext = await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const { NPC_KEY } = await import('../../extension/npc.mjs');
const { applyTrackerResult } = await import('../../extension/discovery.mjs');
const { loadCalendar, rememberWorlds } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const TEXT = Object.fromEntries(PROMPTS.prompts.map(e => [e.id, e.text]));
const BASE = {
    body: 'A tall, raw-boned woman in her late forties. Two thick copper braids hang to her waist. Her face is weathered, with pale grey eyes.',
    outfit: "Widow's black wool under a stained leather apron, and a ring of keys at her belt.",
};
const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: BASE.body, outfit: BASE.outfit, file: 'hesk.json' };
const RULES = TEXT['npc.appearance_rules'];
const OLD_BAN = /doorways, weather|Describe how they look, not what they are doing/;

/** A chat with Hesk; compose calls and Looks calls are recorded apart. */
function boot(answer = () => '{"outfit":"Widow\'s black wool, damp at the hem, under a stained leather apron, and a ring of keys at her belt."}') {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'r3'; c.getCurrentChatId = () => 'r3';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    const calls = [], looks = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), system = String(args?.systemPrompt ?? '');
        if (/Looks line/.test(prompt)) { looks.push({ system, prompt }); return '{"looks":"a big woman with copper braids"}'; }
        calls.push({ system, prompt });
        return answer(prompt, system);
    };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true });
    c.chat = [{ mes: 'The landlady comes in from the courtyard.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm1', worldscrawl_npc_baseline: { hesk: { ...BASE } } } }];
    return { c, calls, looks };
}
const ownersOn = (c, i) => (c.chat[i].extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appearance');
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
const say = (c, mes, mid) => { c.chat.push({ mes, is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: mid } }); return c.chat.length - 1; };
const intentsOf = prompt => prompt.slice(prompt.indexOf('Active intents (oldest first):\n') + 31, prompt.indexOf('\nReply with JSON only')).split('\n');

test('A2 (e R3.1): the player\'s text for a change reads "use as written", one field per line, never raw text {…}', async () => {
    const { c, calls } = boot((prompt) => JSON.stringify({ outfit: /hem damp/.test(prompt) && !/tied/.test(prompt) ? "Widow's black wool, damp at the hem, under a stained leather apron, and a ring of keys at her belt." : 'Widow\'s black wool under a clean apron.' }));
    // A kept light change on the Outfit first (composed by the model, so no text of its own).
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const hem = ownersOn(c, 0).at(-1);
    assert.equal(hem.candidate.phase, 'review');
    assert.ok(scene.decideNpc(c.chat, hem.identity, hem.decisionRev, 'approve', { token: hem.candidate.token, elapsed: 0 }).ok);
    // A second Outfit change, then the player edits its text on the card (Edit > Save: settleNpc 'edit' with the layer).
    const id = say(c, 'She changes into a clean apron.', 'm2');
    await applyTrackerResult(id, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'a clean apron', fields: 'outfit', scope: 'light' }] });
    const apron = ownersOn(c, id).at(-1);
    calls.length = 0;
    const typed = "Widow's black wool under a clean white apron, keys at her belt.";
    const r = await scene.settleNpc(c.chat, apron.identity, apron.decisionRev, 'edit', { intent: 'a clean apron', fields: 'outfit', scope: 'light', layer: { outfit: typed }, elapsed: 0 });
    assert.ok(r?.ok !== false, JSON.stringify(r));
    await flush();
    const asked = calls.find(x => x.prompt.includes('a clean apron'));
    assert.ok(asked, `the edited card is composed on top of the kept change: ${JSON.stringify(calls.map(x => x.prompt))}`);
    const lines = intentsOf(asked.prompt);
    assert.deepEqual(lines, [`1. a clean apron [outfit] (light touch) The player wrote outfit for it, use as written: "${typed}"`]);
    assert.doesNotMatch(asked.prompt, /text \{|"outfit":/, 'no raw layer JSON');
    assert.match(asked.prompt, /^Edit outfit for Hesk:/);
    assert.match(asked.system, /^You make a small edit to a person's appearance text \(outfit\)/);
});

test('A2 round 1: a change whose Body and Outfit were both edited gets one written line per field, each naming its field', async () => {
    const KEEP = '{"outfit":"Widow\'s black wool, damp at the hem, under a stained leather apron, and a ring of keys at her belt."}';
    const { c, calls } = boot(() => KEEP);
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const hem = ownersOn(c, 0).at(-1);
    assert.ok(scene.decideNpc(c.chat, hem.identity, hem.decisionRev, 'approve', { token: hem.candidate.token, elapsed: 0 }).ok);
    await flush();
    const id = say(c, 'She dries off by the fire.', 'm2');
    await applyTrackerResult(id, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'dried off', fields: 'body,outfit', scope: 'light' }] });
    const o = ownersOn(c, id).at(-1);
    calls.length = 0;
    const body = 'A tall, raw-boned woman with dry copper braids.', outfit = "Widow's black wool, dry now, under a leather apron.";
    const r = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'edit', { intent: 'dried off', fields: 'body,outfit', scope: 'light', layer: { body, outfit }, elapsed: 0 });
    assert.ok(r?.ok !== false, JSON.stringify(r));
    await flush();
    const asked = calls.find(x => x.prompt.includes('dried off'));
    assert.ok(asked, `the edited change is composed: ${JSON.stringify(calls.map(x => x.prompt))}`);
    const line = intentsOf(asked.prompt).find(l => l.includes('dried off'));
    assert.equal(line, `2. dried off [body,outfit] (light touch) The player wrote body for it, use as written: "${body}" The player wrote outfit for it, use as written: "${outfit}"`);
    assert.doesNotMatch(asked.prompt, /wrote this field|text \{/);
});

test('A2: each line comes from its own entry: overriding the pieces changes the line and only it', async () => {
    const { c, calls } = boot();
    ext.setPrompts({ ...TEXT, 'npc.appearance_intent_line': '#{{n}} <{{intent}}> on {{fields}} as {{how}}{{written}}' });
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    assert.deepEqual(intentsOf(calls[0].prompt), ['#1 <hem damp> on outfit as light touch']);
    ext.setPrompts(PROMPTS);
    // The baseline and written pieces render through intentLine with the same placeholders.
    const { intentLine } = await import('../../extension/owners.mjs');
    ext.setPrompts({ ...TEXT, 'npc.appearance_intent_written': 'TYPED {{fields}}[{{written_text}}]', 'npc.appearance_intent_replace': 'R{{n}} {{fields}}={{written_text}}' });
    assert.equal(intentLine({ intent: 'x', fields: 'outfit', scope: 'light', layer: { outfit: 'grey cloak' } }, 2), '2. x [outfit] (light touch) TYPED outfit[grey cloak]');
    assert.equal(intentLine({ kind: 'baseline', field: 'body', text: 'A gnoll.' }, 4), 'R4 body=A gnoll.');
    ext.setPrompts(PROMPTS);
});

test('A1 + A3: the light-touch call is a procedure for the asked field, with the shared rules; the old ban list is gone', async () => {
    const { c, calls } = boot();
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const sys = calls[0].system;
    assert.match(sys, /^You make a small edit to a person's appearance text \(outfit\) for a text adventure\./);
    assert.match(sys, /For each change, find the one phrase in the base it affects \(for "braids tied back", the phrase about the hair\) and replace only that phrase\. If no phrase covers it, add one short clause to the sentence it fits best\. Copy every other sentence exactly as written, in the same order\./);
    assert.doesNotMatch(sys, /change only the words that the active intents name/);
    assert.equal(sys.split(RULES).length - 1, 1, 'the shared rules, once');
    assert.ok(sys.indexOf(RULES) < sys.indexOf('No other keys, no commentary.'), 'before the closing line');
    assert.doesNotMatch(sys, OLD_BAN);
    assert.doesNotMatch(sys, /body and clothes|body or clothes|body and\/or outfit|\{\{/);
    assert.match(RULES, /^Write how they look in third person \(she, he, they\), as a portrait would show them: no actions, poses or setting\./);
    // Round 1: the light question says the same procedure; the rules no longer say "Do not write looks".
    assert.match(calls[0].prompt, /^Edit outfit for Hesk: replace only the phrase each intent affects and copy every other sentence as written\.\n/);
    assert.doesNotMatch(calls[0].prompt + sys, /change only the words|copy the base and/);
    assert.doesNotMatch(sys, /Do not write looks/);
    assert.match(sys, /no actions, poses or setting\. Never copy a previous combined description/);
});

test('A1 (e R3.2): a light touch that rewrites everything is asked once more with the retry line, then fails visibly', async () => {
    // A Body of three sentences (the keep check applies to a text with more than one sentence).
    const { c, calls } = boot(() => '{"body":"A slight young man with a shaved head and a fresh tattoo on his neck."}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'braids tied back', fields: 'body', scope: 'light' }] });
    const o = ownersOn(c, 0).at(-1);
    assert.equal(calls.length, 2, 'one retry');
    assert.ok(!calls[0].prompt.includes(TEXT['npc.appearance_edit_light_retry']));
    assert.ok(calls[1].prompt.endsWith(`\n${TEXT['npc.appearance_edit_light_retry']}`), 'the retry line, unchanged');
    // Round 1: the retry line asks for the same procedure.
    assert.ok(calls[1].prompt.endsWith('\nYour last answer changed most of the base text. Copy each base field word for word, in the same order, and replace only the phrase each intent affects.'));
    for (const x of calls) assert.match(x.system, /find the one phrase in the base it affects/);
    assert.equal(o.candidate.phase, 'failed');
    assert.match(JSON.stringify(c.chat[0].extra), /the light touch changed more than half of the body/, 'the reason is stored for the card');
});

test('A3: the full rewrite call names the asked field, keeps the per-field rebuild clause, and takes the same shared rules', async () => {
    const { c, calls } = boot(() => '{"body":"A hulking grey gnoll with a scarred muzzle."}');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'turned into a gnoll', fields: 'body', scope: 'full', why: 'a whole new body' }] });
    const sys = calls[0].system;
    assert.match(sys, /^You rewrite a person's appearance text \(body\) for a text adventure\./);
    assert.match(sys, /when the outfit is among the fields asked \(body\), how the clothes fit the body as it is now/, '5A per-field clause kept');
    // Round 1: the light-touch sentence is the procedure, and the full rewrite no longer asks for a stance.
    assert.match(sys, /For a light touch, replace only the phrase that intent affects and copy every other sentence as written\./);
    assert.match(sys, /head and face, hands, and, when the outfit is among the fields asked \(body\)/);
    assert.doesNotMatch(sys, /stand and move|change only the words|Do not write looks/);
    assert.equal(sys.split(RULES).length - 1, 1);
    assert.doesNotMatch(sys, OLD_BAN);
    assert.doesNotMatch(sys, /body and clothes|body and\/or outfit|\{\{/);
    // One edit of the shared entry reaches both compose system prompts.
    const b = boot();
    ext.setPrompts({ ...TEXT, 'npc.appearance_rules': 'SHARED APPEARANCE RULES.' });
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const c2 = SillyTavern.getContext(); c2.chat.push({ mes: 'x', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm9' } });
    await applyTrackerResult(1, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'turned into a gnoll', fields: 'body', scope: 'full' }] });
    assert.ok(b.calls.length >= 2);
    for (const x of b.calls) assert.match(x.system, /SHARED APPEARANCE RULES\. No other keys, no commentary\.$/);
    ext.setPrompts(PROMPTS);
});

test('A4: the Looks summary side call says Outfit:, the narrator people block keeps Wearing:', async () => {
    const { c, looks } = boot();
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'hem damp', fields: 'outfit', scope: 'light' }] });
    const o = ownersOn(c, 0).at(-1);
    await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'approve', { token: o.candidate.token, elapsed: 0 });
    await flush(60);
    assert.ok(looks.length >= 1, 'approving re-summarizes Looks');
    const q = looks.at(-1).prompt;
    assert.match(q, /^Body: A tall, raw-boned woman/m);
    assert.match(q, /^Outfit: Widow's black wool, damp at the hem/m);
    assert.doesNotMatch(q, /Wearing:/);
    // The narrator is in-world: its people block still says Wearing.
    const npcLib = await import('../../extension/npc.mjs');
    const p = { id: 'hesk', name: 'Hesk', line: 'stern', looks: 'copper braids', body: 'Tall.', outfit: "Widow's black.", manner: 'Brisk.', voice: 'Low.' };
    const s = npcLib.npcSlices([p], { id: 'hesk', depth: 'focused' }, { tiers: { hesk: { tier: 'engaged', why: 'x' } } }).npcs_present;
    assert.match(s, /Wearing: Widow's black\./);
    assert.doesNotMatch(s, /Outfit:/);
});
