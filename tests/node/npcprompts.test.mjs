// NPC updates the narrator reports: memory (things they'd remember tomorrow) and disposition, beside fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseNpcTag, takeNpcTags } from '../../plugin/npc.mjs';
import { messageActivity } from '../../extension/activity.mjs';
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const all = []; (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id && typeof o.text === 'string') all.push(o); Object.values(o).forEach(walk); } })(def);
const P = id => all.find(p => p.id === id);

test('npc_tags / npc_tools / npc_tool guide memory and disposition, keep fact, keep the locked formats', () => {
    for (const id of ['narration.npc_tags', 'narration.npc_tools', 'narration.npc_tool']) {
        const t = P(id).text;
        for (const w of ['fact', 'memory', 'disposition', 'remember tomorrow', 'lied to', 'threatened', 'helped', 'insulted', 'promise', 'point of view', 'one ', 'hostile, unfriendly, indifferent, friendly or helpful', 'reason']) assert.ok(t.includes(w), `${id}: ${w}`);
    }
    assert.equal(P('narration.npc_tags').locked, 'The game reads these [ws_npc: …] tags.');
    assert.equal(P('narration.npc_tools').locked, 'The game reads the ws_npc tool.');
    const tags = P('narration.npc_tags').text;
    assert.match(tags, /\[ws_npc: memory \| their-id \|/); assert.match(tags, /\[ws_npc: disposition \| their-id \| value \| short reason\]/);
    for (const [, body] of tags.matchAll(/\[ws_npc:\s*([^\]]+)\]/g)) if (!/their-id/.test(body)) assert.ok(parseNpcTag(body), `example parses: ${body}`);
    assert.ok(/clearly shifts/.test(tags) && /clearly shifts/.test(P('narration.npc_tools').text));
});

test('the tag parser takes memory and disposition tags, and strips them', () => {
    const { stamps, text } = takeNpcTags('She scowls. [ws_npc: memory | hesk | The stranger lied to me.] [ws_npc: disposition | hesk | unfriendly | caught lying]');
    assert.deepEqual(stamps, [{ type: 'npc_memory', id: 'hesk', note: 'The stranger lied to me.' }, { type: 'npc_disposition', id: 'hesk', who: 'player', value: 'unfriendly', reason: 'caught lying' }]);
    assert.ok(!/ws_npc/.test(text));
    assert.equal(parseNpcTag('disposition | hesk | grumpy | x'), null);
});

test('memory and disposition stamps show in the activity log with their text', () => {
    const msg = { mes: 'x', extra: { worldscrawl_npc: [{ type: 'npc_memory', id: 'hesk', note: 'The stranger lied to me.' }, { type: 'npc_disposition', id: 'hesk', who: 'player', value: 'unfriendly', reason: 'caught lying' }] } };
    const txt = JSON.stringify(messageActivity(msg, 3));
    assert.match(txt, /npc_memory/); assert.match(txt, /The stranger lied to me/);
    assert.match(txt, /npc_disposition/); assert.match(txt, /hesk: unfriendly toward player — caught lying/);
});
