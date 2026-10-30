// The patch prompt's rules, read from plugin/prompts/default.json.
import { DEFAULT_PROMPTS } from './useprompts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
import { opDocs as opDocs0 } from '../../plugin/ui/patches.mjs';
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

import { client, RIVERTON, TAVERN, SQUARE } from './helpers.mjs';
import { patchPrompt } from '../../plugin/ui/patches.mjs';

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
    assert.match(sys, /People and creatures mentioned in a room's description or notes are part of the room/);
    assert.match(sys, /hurt, killed, transformed, left, moved in/);
});
