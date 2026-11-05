import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NPC_KEY, NPC_FLAG_KEY, framesOf, nameKnown, npcSlices, relOf, relLine, parseRelArg, stampSummary } from '../../extension/npc.mjs';
import { relText, playSummary, whyRows } from '../../plugin/ui/castdata.mjs';

const bot = (stamps = [], extra = {}) => ({ mes: 'x', is_user: false, swipe_id: 0, extra: { ...(stamps.length ? { [NPC_KEY]: stamps.map(s => ({ swipe: 0, ...s })) } : {}), ...extra } });
const HESK = { id: 'hesk', name: 'Hesk', line: 'The landlady.', unknownAs: 'the landlady', ok: true, schedule: [] };
const fold = chat => framesOf(chat, chat.length - 1, [HESK]).at(-1).get('hesk');

test('rel: unmet until the first engagement, which sets met and moves unknown to indifferent', () => {
    assert.deepEqual(relOf(fold([bot()])), { state: 'unmet', at: null, by: '' });
    const h = fold([bot(), bot([{ type: 'npc_memory', id: 'hesk', note: 'Joe asked about rooms.' }])]);
    assert.deepEqual(h.rel.player, { state: 'met', at: 1, by: 'memory' });
    assert.deepEqual(h.disposition.player, { value: 'indifferent', reason: 'just met' });
    const f = fold([bot([], { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Hesk'] }] })]);
    assert.deepEqual(f.rel.player, { state: 'met', at: 0, by: 'npc flag' });
    const d = fold([bot([{ type: 'npc_disposition', id: 'hesk', value: 'friendly', reason: 'tipped well' }])]);
    assert.equal(d.rel.player.by, 'disposition');
    assert.equal(fold([bot([{ type: 'npc_follow', id: 'hesk' }])]).rel.player.state, 'met');
});

test('rel: the #95 name tools write named; automatic changes never go back; only a player edit does', () => {
    const named = [bot([{ type: 'npc_name', id: 'hesk', who: 'player', source: 'bracket' }]), bot([{ type: 'npc_memory', id: 'hesk', note: 'Joe paid.' }])];
    const h = fold(named);
    assert.deepEqual(h.rel.player, { state: 'named', at: 0, by: 'name bracket' });
    assert.deepEqual(nameKnown(h, named, 1), { known: true, reason: 'known: name bracket' });
    named.push(bot([{ type: 'npc_rel', id: 'hesk', who: 'player', state: 'met' }]));
    assert.deepEqual(fold(named).rel.player, { state: 'met', at: 2, by: 'player edit' });
    assert.equal(nameKnown(fold(named), named, 2).known, false);
    named.push(bot([{ type: 'npc_rel', id: 'hesk', state: 'bogus' }]));
    assert.equal(fold(named).rel.player.state, 'met', 'unknown state ignored');
    assert.match(stampSummary({ type: 'npc_rel', id: 'hesk', state: 'unmet' }, 'Hesk'), /The player set Hesk to hasn't met/);
});

test('rel: /ws-know arguments', () => {
    assert.deepEqual(parseRelArg('Hesk | met'), { name: 'Hesk', state: 'met' });
    assert.deepEqual(parseRelArg('Hesk | knows the name'), { name: 'Hesk', state: 'named' });
    assert.deepEqual(parseRelArg("Hesk | hasn't met"), { name: 'Hesk', state: 'unmet' });
    assert.equal(parseRelArg('Hesk').state, null);
});

test('rel: the line and the name-leak guard go with the memories', () => {
    const p = { id: 'hesk', name: 'Hesk', line: 'The landlady.', unknownAs: 'the landlady', known: { known: false }, memory: ['Joe lied about the coin.'], rel: { player: { state: 'met', at: 1, by: 'memory' } }, disposition: {} };
    assert.equal(relLine(p, 'Joe'), "Met Joe but doesn't know Joe by name.");
    assert.equal(relLine({}, 'Joe'), 'Has not met Joe before.');
    const engaged = npcSlices([p], { id: 'x' }, { tiers: { hesk: { tier: 'engaged' } }, pc: 'Joe' }).npcs_present;
    assert.match(engaged, /Met Joe but doesn't know Joe by name\. \(Their memories use real names for clarity; the landlady does not know the name Joe and must not say it\.\) Remembers: Joe lied/);
    const focus = npcSlices([p], { id: 'hesk', depth: 'focus' }, { pc: 'Joe' }).npc_focus.split('\n');
    assert.deepEqual(focus.slice(0, 3), ['the landlady, in focus.', "Met Joe but doesn't know Joe by name.", '(Their memories use real names for clarity; the landlady does not know the name Joe and must not say it.)']);
    const known = { ...p, known: { known: true }, rel: { player: { state: 'named', at: 0, by: 'name flag' } } };
    const k = npcSlices([known], { id: 'hesk', depth: 'focus' }, { pc: 'Joe' }).npc_focus;
    assert.match(k, /Knows Joe by name\./);
    assert.doesNotMatch(k, /must not say/);
});

test('rel: the inspector shows the state and the stamp that set it', () => {
    assert.equal(relText({ state: 'met', at: 4, by: 'memory' }), "met you, doesn't know your name (message #4, memory)");
    assert.equal(relText(null), "hasn't met you");
    assert.equal(relText({ state: 'named', at: null }), 'knows your name');
    const play = { rel: { player: { state: 'named', at: 2, by: 'name flag' } }, disposition: {}, why: { disposition: {} } };
    assert.deepEqual(playSummary(play, a => a).find(r => r[0] === 'Knows you'), ['Knows you', 'knows your name (message #2, name flag)']);
    assert.deepEqual(whyRows(play, a => a).find(r => r[0] === 'Knows the player'), ['Knows the player', 'knows your name (message #2, name flag)']);
});
