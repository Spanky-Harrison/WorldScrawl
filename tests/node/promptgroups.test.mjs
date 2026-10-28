// Prompt groups (one per process, with flow text), step descriptions, pieces and locked prompts in default.json,
// and the editor helpers that sort them. Purely visual: the prompt text itself is checked by promptfile.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupPrompts, isLocked } from '../../plugin/ui/prompteditor.mjs';
import { handlePrompts } from '../../plugin/prompts.mjs';
const DEF = new URL('../../plugin/prompts/default.json', import.meta.url).pathname;
const def = JSON.parse(fs.readFileSync(DEF, 'utf8'));
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));
const PREFIX = { pick: ['pick.'], intent: ['intent.', 'travel.'], dig: ['dig.'], look: ['look.'], door: ['door.'], narration: ['narration.'], change: ['change.'], discover: ['discover.'], expand: ['expand.'] };

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
test('{{who}} still works as the old name of {{party}} in saved profiles', async () => {
    const pr = await import('../../plugin/ui/prompts.mjs');
    pr.setPrompts({ 'x': 'A {{who}} B {{party}}' });
    assert.equal(pr.render('x', { party: 'Ann and Bob' }), 'A Ann and Bob B Ann and Bob');
});
test('Writing style: open by default, holds the prose prompts, each says which process uses it', () => {
    assert.equal(def.groups[0].open, true);
    assert.ok(def.groups.slice(1).every(g => !g.open));
    for (const id of ['narration.move', 'narration.travel', 'narration.look_around', 'narration.exits_hint', 'dig.style', 'expand.system', 'expand.question'])
        assert.equal(byId[id].group, 'style', id);
    for (const id of ['narration.header', 'narration.rules', 'narration.arrival_reminder', 'narration.flag_hint', 'narration.wait_hint']) { assert.equal(byId[id].group, 'narration', id); assert.ok(byId[id].locked, id); }
    for (const e of def.prompts.filter(e => e.group === 'style')) assert.match(e.description, /^Used by /, e.id);
});
