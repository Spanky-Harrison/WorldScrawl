import './ststub.mjs';
import { extSource, client, RIVERTON, TAVERN, SQUARE } from './helpers.mjs';
import { DEFAULT_PROMPTS } from './useprompts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { opDocs as opDocs0, patchPrompt } from '../../plugin/shared/patches.mjs';
import os from 'node:os';
import path from 'node:path';
import { groupPrompts, isLocked } from '../../plugin/ui/prompteditor.mjs';
import { handlePrompts, hashText, storeFile } from '../../plugin/prompts.mjs';
import { userRoot } from '../../plugin/index.mjs';
import { parseNpcTag, takeNpcTags } from '../../extension/npc.mjs';
import { messageActivity } from '../../extension/activity.mjs';

// ---- from prompt.test.mjs
{
// The patch prompt's rules, read from plugin/prompts/default.json.






const src = extSource();

const sys = DEFAULT_PROMPTS.prompts.find(e => e.id === 'change.system').text.replace('{{edit_types}}', opDocs0()).replace('{{style}}', DEFAULT_PROMPTS.prompts.find(e => e.id === 'change.style').text);

test('patch prompt: descriptions say what a place is now, traces allowed, the change itself never narrated, history in notes', () => {
    assert.match(sys, /only what the place IS now/);
    assert.match(sys, /traces of the past are fine/);
    assert.match(sys, /Never narrate the change itself: no "has been replaced by", "was transformed", "was once", "now"/);
    assert.match(sys, /History goes in notes/);
    assert.match(sys, /"op":"append_lore"/);
    assert.match(sys, /temporary change with "lasts".*may mention the event/);
    assert.doesNotMatch(sys.slice(sys.indexOf('Example')), /"text":"[^"]*(has been|was transformed|was once)/, 'the example obeys the rule');
});




test('patch prompt: one step beyond the change is included (neighbors of changed rooms and of a changed area), compactly', () => {
    const c = client(RIVERTON);
    const ctx = c.post('/patch/context', { json: { location: TAVERN, rooms: ['riverton:drowned_rat'] } }).json();
    const nb = ctx.neighbors.map(n => n.address);
    assert.ok(nb.includes(SQUARE), `the square links into the inn: ${nb}`);
    assert.ok(!nb.some(a => a.startsWith('riverton:drowned_rat/')), 'rooms inside the changed area are not "neighbors"');
    const sq = ctx.neighbors.find(n => n.address === SQUARE);
    assert.deepEqual(Object.keys(sq).sort(), ['address', 'description', 'exits', 'name']);
    const q = patchPrompt(ctx, { story: 'Magic turns the inn into a palace.', range: '#3-#5' });
    assert.match(q, /One step beyond the change/);
    assert.ok(q.includes(`${SQUARE} = ${sq.name}:`) && q.includes("The Drowned Rat's swinging sign"), 'the neighbor and its exit text that names the old place are in the prompt');
    const one = c.post('/patch/context', { json: { location: TAVERN, rooms: [TAVERN] } }).json().neighbors.map(n => n.address);
    assert.ok(one.includes(SQUARE) && one.includes('riverton:drowned_rat/upstairs'), String(one));
    assert.match(sys, /set_exit_description/);
    assert.match(sys, /never rename them/);
});

test('old-name search: region/subregion notes and other world text naming a changed place are in the context and prompt', () => {
    const c = client(RIVERTON);
    const ctx = c.post('/patch/context', { json: { location: TAVERN, rooms: ['riverton:drowned_rat'] } }).json();
    assert.ok(ctx.mentions.some(m => m.where === 'riverton:gilded_goose' || /notes/.test(m.field)), JSON.stringify(ctx.mentions.map(m => [m.where, m.field])));
    assert.ok(ctx.mentions.some(m => m.where === SQUARE && /exits/.test(m.field)), 'exit text in the square');
    assert.ok(!ctx.mentions.some(m => m.where.startsWith('riverton:drowned_rat')), 'the changed area itself is not a "mention"');
    const q = patchPrompt(ctx, {});
    assert.match(q, /Other world text that names a changed place/);
    assert.match(q, /looks down on the Drowned Rat/);
});

test('patch prompt: people and creatures in a description are part of the room', () => {
    assert.match(sys, /Unnamed scenery people and creatures in a room's description or notes are part of the room/);
    assert.match(sys, /This call writes places only/);
    assert.doesNotMatch(sys, /the narrator uses ws_npc/);
    assert.match(sys, /hurt, killed, transformed, left, moved in/);
});
}

// ---- from promptfile.test.mjs
{
// Prompts live in plugin/prompts/default.json. With the default file, every prompt must be exactly what the code
// produced before the move (fixtures/prompts.snapshot.json was made from the old code).




const root = new URL('../../', import.meta.url);
const def = JSON.parse(fs.readFileSync(new URL('plugin/prompts/default.json', root), 'utf8'));
const ext = await import('../../extension/index.js');
const uiPrompts = await import('../../plugin/shared/prompts.mjs');
const patches = await import('../../plugin/shared/patches.mjs');
const placeform = await import('../../plugin/ui/placeform.mjs');
const { cases } = await import('./fixtures/prompt-cases.mjs');
const snap = JSON.parse(fs.readFileSync(new URL('fixtures/prompts.snapshot.json', import.meta.url), 'utf8'));
ext.setPrompts(def); uiPrompts.setPrompts(def);

test('default prompts give byte-identical output to the old code', () => {
    const now = cases({ ext, patches, placeform });
    assert.deepEqual(Object.keys(now).sort(), Object.keys(snap).sort());
    for (const k of Object.keys(snap)) assert.equal(now[k], snap[k], `prompt case ${k} changed`);
});
test('every entry has id, title, description, text and placeholders that match the text', () => {
    const ids = new Set();
    for (const e of def.prompts) {
        assert.ok(e.id && !ids.has(e.id), `bad or duplicate id ${e.id}`); ids.add(e.id);
        assert.equal(typeof e.title, 'string'); assert.equal(typeof e.description, 'string'); assert.equal(typeof e.text, 'string');
        assert.deepEqual(e.placeholders.map(p => p.name).sort(), uiPrompts.placeholdersIn(e.text).sort(), `placeholders of ${e.id}`);
    }
});
test('op docs are a generated placeholder, not text in the file', () => {
    const sys = def.prompts.find(e => e.id === 'change.system');
    assert.match(sys.text, /\{\{edit_types\}\}/);
    assert.ok(sys.placeholders.find(p => p.name === 'edit_types').generated);
    assert.ok(!sys.text.includes('"op":"add_exit"'));
});
test('an override changes the prompt, values are not re-filled', () => {
    ext.setPrompts({ ...Object.fromEntries(def.prompts.map(e => [e.id, e.text])), 'dig.style': 'X {{who}} Y' });
    assert.match(ext.digPrompt({ name: 'Hall', exits: [] }, 'said {{who}}', [], [], true), /said \{\{who\}\}[\s\S]*X \{\{who\}\} Y/);
    ext.setPrompts(def);
});
}

// ---- from promptgroups.test.mjs
{
// Prompt groups (one per process, with flow text), step descriptions, pieces and locked prompts in default.json,
// and the editor helpers that sort them. Purely visual: the prompt text itself is checked by promptfile.test.mjs.







const DEF = new URL('../../plugin/prompts/default.json', import.meta.url).pathname;
const def = JSON.parse(fs.readFileSync(DEF, 'utf8'));
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));
const PREFIX = { pick: ['pick.'], intent: ['intent.', 'travel.'], dig: ['dig.'], look: ['look.'], door: ['door.'], narration: ['narration.'], npc: ['npc.'], change: ['change.'], discover: ['discover.'], expand: ['expand.'] };

test('Writing style first, then one group per process, each with a title and a plain flow description', () => {
    assert.deepEqual(def.groups.map(g => g.id), ['style', ...Object.keys(PREFIX)]);
    for (const g of def.groups) { assert.ok(g.title && typeof g.title === 'string'); assert.ok(g.flow.length > 80, `${g.id} flow`); assert.match(g.flow, /Step 1/, `${g.id} flow names its steps`); }
});
test('every prompt is in the group for its process', () => {
    for (const e of def.prompts) { assert.ok(PREFIX[e.process ?? e.group]?.some(p => e.id.startsWith(p)), `${e.id} is in ${e.group}`);
        assert.equal(e.group === 'style', !!e.process, e.id); }
});
test('every non-piece prompt says which step it is', () => {
    for (const e of def.prompts.filter(e => !e.piece)) assert.match(e.description, /^(Used by [^.]+\. )?(Steps? \d|Alongside)/, e.id);
});
test('tiny fragments are pieces', () => {
    for (const id of ['narration.travel_cut_short', 'expand.field_description', 'expand.field_notes', 'change.patch_retry', 'discover.retry', 'intent.option.exit'])
        assert.equal(byId[id].piece, true, id);
    for (const id of ['intent.question', 'narration.move', 'change.system', 'expand.question']) assert.ok(!byId[id].piece, id);
});
test('format-critical prompts are locked with a one-line reason; creative ones are not', () => {
    for (const id of ['intent.system', 'travel.system', 'dig.system', 'change.system', 'change.scope_system', 'discover.system', 'change.patch_retry', 'discover.retry',
        'narration.flag_hint', 'narration.wait_hint', 'narration.new_door_tags', 'narration.new_door_tools', 'look.closed_door',
        ...def.prompts.filter(e => e.id.startsWith('intent.option.')).map(e => e.id)]) {
        assert.equal(typeof byId[id].locked, 'string', id); assert.ok(byId[id].locked.length > 5 && !byId[id].locked.includes('\n'), id);
    }
    for (const e of def.prompts) assert.equal(!e.locked, e.group === 'style', `${e.id}: only Writing style is unlocked`);
});
test('isLocked: only locked prompts, and only while not unlocked', () => {
    assert.equal(isLocked(byId['intent.system']), true);
    assert.equal(isLocked(byId['intent.system'], true), false);
    assert.equal(isLocked(byId['narration.move']), false);
});
test('groupPrompts: file group order, pieces split out, unknown groups go to Other, empty groups dropped', () => {
    const g = groupPrompts(def.prompts, def.groups);
    assert.deepEqual(g.map(x => x.group.id), def.groups.filter(x => def.prompts.some(e => e.group === x.id)).map(x => x.id));
    assert.equal(g.reduce((n, x) => n + x.main.length + x.pieces.length, 0), def.prompts.length);
    assert.ok(g.find(x => x.group.id === 'style').pieces.some(e => e.id === 'narration.travel_cut_short'));
    assert.ok(!g.find(x => x.group.id === 'door').main.some(e => e.piece));
    const h = groupPrompts([{ id: 'a', group: 'nope' }, byId['dig.question']], def.groups);
    assert.deepEqual(h.map(x => x.group.id), ['dig', 'other']);
});
test('the editor state sends the groups', () => {
    const r = handlePrompts('GET', '/prompts', null, fs.mkdtempSync(path.join(os.tmpdir(), 'wsgroups-')), DEF);
    assert.deepEqual(r.body.groups, def.groups); assert.deepEqual(r.body.placeholders, def.placeholders);
    assert.ok(r.body.prompts.find(e => e.id === 'intent.system').locked);
});
test('engine words are back in code, not prompts', () => {
    for (const id of ['door.verb_open', 'door.verb_close', 'intent.no_exits']) assert.ok(!byId[id], id);
});
test('one placeholder dictionary describes every placeholder; fixed values are listed', () => {
    const used = new Set(def.prompts.flatMap(e => e.placeholders.map(p => p.name)));
    assert.deepEqual(Object.keys(def.placeholders).sort(), [...used].sort());
    for (const [n, d] of Object.entries(def.placeholders)) assert.ok(typeof d === 'string' && d.length > 10, n);
    assert.match(def.placeholders.verb, /"open" or "close"/);
    assert.match(def.placeholders.exits, /- \(none\)/);
    assert.match(def.placeholders.party, /Who moves/);
    assert.ok(!used.has('who') && !def.prompts.some(e => e.text.includes('{{who}}')));
});
test('Writing style: open by default, holds the prose prompts, each says which process uses it', () => {
    assert.equal(def.groups[0].open, true);
    assert.ok(def.groups.slice(1).every(g => !g.open));
    for (const id of ['narration.move', 'narration.travel', 'narration.look_around', 'narration.exits_hint', 'dig.style', 'expand.system', 'expand.question'])
        assert.equal(byId[id].group, 'style', id);
    for (const id of ['narration.header', 'narration.rules', 'narration.arrival_reminder', 'narration.flag_hint', 'narration.wait_hint']) { assert.equal(byId[id].group, 'narration', id); assert.ok(byId[id].locked, id); }
    for (const e of def.prompts.filter(e => e.group === 'style')) assert.match(e.description, /^Used by /, e.id);
});
}

// ---- from promptprofiles.test.mjs
{
// Prompt profiles on the server: stored per user, only overrides, Default read-only, survives a restart (re-read from disk).








const DEF = new URL('../../plugin/prompts/default.json', import.meta.url).pathname;
const def = JSON.parse(fs.readFileSync(DEF, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wsprompts-'));
const call = (root, m, u, b, f = DEF) => handlePrompts(m, u, b, root, f);

test('fresh user: Default selected, active prompts are the default text', () => {
    const r = call(tmp(), 'GET', '/prompts/active');
    assert.equal(r.body.profile, 'Default');
    for (const e of def.prompts) assert.equal(r.body.prompts[e.id], e.text);
    assert.equal(call(tmp(), 'GET', '/somethingelse'), null);
});
test('Default is read-only; a new profile stores only its overrides with the base text and hash', () => {
    const root = tmp();
    assert.equal(call(root, 'POST', '/prompts/override', { profile: 'Default', id: 'travel.question', text: 'x' }).status, 400);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'default' }).status, 400);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'Mine' }).status, 200);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'mine' }).status, 400, 'names are unique');
    const r = call(root, 'POST', '/prompts/override', { profile: 'Mine', id: 'travel.question', text: 'Stay? {{said}}' });
    const o = r.body.profiles.Mine.overrides['travel.question'];
    const base = def.prompts.find(e => e.id === 'travel.question').text;
    assert.deepEqual(o, { text: 'Stay? {{said}}', base_hash: hashText(base), base_text: base, default_changed: false });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(storeFile(root), 'utf8')).profiles.Mine.overrides), ['travel.question']);
    // "restart": a new read from disk
    const a = call(root, 'GET', '/prompts/active').body;
    assert.equal(a.profile, 'Mine'); assert.equal(a.prompts['travel.question'], 'Stay? {{said}}'); assert.equal(a.prompts['dig.style'], def.prompts.find(e => e.id === 'dig.style').text);
    assert.equal(fs.readFileSync(DEF, 'utf8'), fs.readFileSync(DEF, 'utf8'));
    call(root, 'POST', '/prompts/reset', { profile: 'Mine', id: 'travel.question' });
    assert.deepEqual(call(root, 'GET', '/prompts').body.profiles.Mine.overrides, {});
    call(root, 'POST', '/prompts/override', { profile: 'Mine', id: 'travel.question', text: base });
    assert.deepEqual(call(root, 'GET', '/prompts').body.profiles.Mine.overrides, {}, 'saving the default text keeps no override');
});
test('duplicate, rename, delete, select', () => {
    const root = tmp();
    call(root, 'POST', '/prompts/profile', { action: 'new', name: 'A' });
    call(root, 'POST', '/prompts/override', { profile: 'A', id: 'dig.style', text: 'N' });
    call(root, 'POST', '/prompts/profile', { action: 'duplicate', from: 'A', name: 'B' });
    assert.equal(call(root, 'GET', '/prompts/active').body.prompts['dig.style'], 'N');
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'rename', from: 'B', name: 'A' }).status, 400);
    let r = call(root, 'POST', '/prompts/profile', { action: 'rename', from: 'B', name: 'C' });
    assert.equal(r.body.selected, 'C'); assert.ok(!r.body.profiles.B);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'delete', name: 'Default' }).status, 400);
    r = call(root, 'POST', '/prompts/profile', { action: 'delete', name: 'C' });
    assert.equal(r.body.selected, 'Default');
    r = call(root, 'POST', '/prompts/select', { profile: 'A' }); assert.equal(r.body.selected, 'A');
    assert.equal(call(root, 'POST', '/prompts/select', { profile: 'Nope' }).status, 400);
});
test('when the default text changes later, the override says so and keeps the old default for a diff', () => {
    const root = tmp(), d = tmp(), f = path.join(d, 'default.json');
    fs.writeFileSync(f, JSON.stringify(def));
    call(root, 'POST', '/prompts/profile', { action: 'new', name: 'A' }, f);
    call(root, 'POST', '/prompts/override', { profile: 'A', id: 'dig.style', text: 'Mine' }, f);
    const changed = structuredClone(def); changed.prompts.find(e => e.id === 'dig.style').text = 'New default';
    fs.writeFileSync(f, JSON.stringify(changed)); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
    const o = call(root, 'GET', '/prompts', null, f).body.profiles.A.overrides['dig.style'];
    assert.equal(o.default_changed, true); assert.equal(o.base_text, def.prompts.find(e => e.id === 'dig.style').text);
});
test('per-user folder comes from SillyTavern req.user', () => {
    assert.equal(userRoot({ user: { directories: { root: '/st/data/alice' } } }, {}), '/st/data/alice');
    assert.equal(userRoot({}, { WORLDSCRAWL_USER_DIR: '/x' }), '/x');
});
}

// ---- from npcprompts.test.mjs
{
// NPC updates the narrator reports: memory (things they'd remember tomorrow) and disposition, beside fact.





const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const all = []; (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id && typeof o.text === 'string') all.push(o); Object.values(o).forEach(walk); } })(def);
const P = id => all.find(p => p.id === id);

test('npc_tags / npc_tools / npc_tool guide memory and disposition, keep fact, keep the locked formats', () => {
    for (const id of ['narration.npc_tags', 'narration.npc_tools', 'narration.npc_tool']) {
        const t = P(id).text;
        for (const w of ['fact', 'memory', 'disposition', 'appearance', 'remember tomorrow', 'lied to', 'threatened', 'helped', 'insulted', 'promise', 'point of view', 'one ', 'hostile, unfriendly, indifferent, friendly or helpful', 'reason']) assert.ok(t.includes(w), `${id}: ${w}`);
    }
    assert.equal(P('narration.npc_tags').locked, 'The game reads these [ws_npc: …] tags.');
    assert.equal(P('narration.npc_tools').locked, 'The game reads the ws_npc tool.');
    const tags = P('narration.npc_tags').text;
    const tools = P('narration.npc_tools').text;
    const tool = P('narration.npc_tool').text;
    // Appearance leads; concrete example; fact lasts drop disguise; tools intent-enough.
    assert.match(tags, /^When someone's Looks, Body or Outfit changes/);
    assert.match(tags, /\[ws_npc: appearance \| hesk \| magically young \| body \| 1 hour\]/);
    assert.doesNotMatch(tags, /a bruise, a mood, a disguise/);
    assert.match(tags, /a bruise, a mood/);
    assert.match(tools, /^When someone's Looks, Body or Outfit changes/);
    assert.match(tools, /magically young/);
    assert.match(tools, /Intent, fields and lasts are enough/);
    assert.doesNotMatch(tools, /rewritten looks\/body\/outfit text/);
    assert.match(tool, /magically young/);
    assert.match(tool, /Intent, fields and lasts are enough/);
    assert.match(tags, /\[ws_npc: memory \| their-id \|/); assert.match(tags, /\[ws_npc: disposition \| their-id \| value \| short reason\]/);
    assert.match(tags, /\[ws_npc: appearance \| their-id \|/);
    assert.match(P('change.style').text, /writes places only/);
    assert.doesNotMatch(P('change.style').text, /people-here/);
    assert.match(tags, /A place changing is not a reason to report a person update/);
    assert.match(tools, /A place changing is not a reason to call this/);
    assert.match(tool, /Do not call this because a place changed/);
    for (const t of [tags, tools, tool]) {
        assert.match(t, /only when Looks, Body or Outfit actually changed/);
        assert.match(t, /entered, was described, or was looked at/);
        assert.match(t, /intent like "looks" or "appeared"/);
        assert.match(t, /walk in soaked/);
    }
    for (const [, body] of tags.matchAll(/\[ws_npc:\s*([^\]]+)\]/g)) if (!/their-id/.test(body)) assert.ok(parseNpcTag(body), `example parses: ${body}`);
    assert.ok(/clearly shifts/.test(tags) && /clearly shifts/.test(tools));
    // Rebuild side-call prompts exist and stay locked to JSON fields.
    assert.match(P('npc.appearance_rebuild_system').text, /JSON object/);
    assert.match(P('npc.appearance_rebuild').text, /Active intents/);
    assert.ok(P('npc.appearance_rebuild_system').locked);
    const tracker = P('npc.tracker').text;
    assert.match(tracker, /place, people, and wait in the same answer/);
    assert.match(tracker, /Fog, rain, or cold outside does not rewrite the room/);
    assert.match(tracker, /walk in soaked/);
    assert.match(tracker, /Do not set looks/);
    assert.match(tracker, /the player does not have to say that it is temporary/);
    assert.match(tracker, /stance toward the player actually shifted/);
    assert.doesNotMatch(tracker, /end your reply with|\[ws_flag|\[ws_npc|\[ws_wait/);
    assert.ok(P('npc.tracker').locked);
    assert.ok(P('npc.tracker_system').locked);
});

test('the tag parser takes memory and disposition tags, and strips them', () => {
    const { stamps, text } = takeNpcTags('She scowls. [ws_npc: memory | hesk | Joe lied to me.] [ws_npc: disposition | hesk | unfriendly | caught lying]');
    assert.deepEqual(stamps, [{ type: 'npc_memory', id: 'hesk', note: 'Joe lied to me.' }, { type: 'npc_disposition', id: 'hesk', who: 'player', value: 'unfriendly', reason: 'caught lying' }]);
    assert.ok(!/ws_npc/.test(text));
    assert.equal(parseNpcTag('disposition | hesk | grumpy | x'), null);
});

test('memory and disposition stamps show in the activity log with their text', () => {
    const msg = { mes: 'x', extra: { worldscrawl_npc: [{ type: 'npc_memory', id: 'hesk', note: 'Joe lied to me.' }, { type: 'npc_disposition', id: 'hesk', who: 'player', value: 'unfriendly', reason: 'caught lying' }] } };
    const txt = JSON.stringify(messageActivity(msg, 3));
    assert.match(txt, /npc_memory/); assert.match(txt, /Joe lied to me/);
    assert.match(txt, /npc_disposition/); assert.match(txt, /hesk: unfriendly toward player — caught lying/);
    const warned = JSON.stringify(messageActivity({ mes: 'x', extra: { worldscrawl_npcwarn: [{ swipe: 0, text: 'Warning: a person update for Hesk did not land on the card.' }] } }, 4));
    assert.match(warned, /"kind":"warning"/);
    assert.match(warned, /did not land on the card/);
});
}

test('npc memory prompts demand real names', async () => {
  const { readFileSync } = await import('node:fs');
  const s = readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8');
  const j = JSON.parse(s); const all = JSON.stringify(j);
  assert.doesNotMatch(all, /The stranger lied/);
  assert.equal((all.match(/never \\"the stranger\\"/g) || []).length, 2);
});
