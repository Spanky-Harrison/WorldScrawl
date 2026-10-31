// Lenient tag reading: short forms normalize to the documented tags; unreadable [ws_...] tags stay visible and warn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsTags, unreadTags, parseWaitTag } from '../../extension/words.mjs';
import { takeNpcTags, takeFoundFlags, takeNameFlags, takeNpcFlags, takeLoreFlags } from '../../plugin/npc.mjs';
import { messageActivity } from '../../extension/activity.mjs';

test('flag short forms normalize to [ws_flag: action | args]', () => {
    for (const t of ['[ws_found | Hesk]', '[ws_found: Hesk]', '[WS_Found|Hesk]', '[ ws_found :  Hesk ]', '[ws_flag | found | Hesk]', '[WS_FLAG : Found|Hesk]'])
        assert.equal(normalizeWsTags(t), '[ws_flag: found | Hesk]', t);
    assert.equal(normalizeWsTags('[ws_change | the roof caved in]'), '[ws_flag: change | the roof caved in]');
    assert.equal(normalizeWsTags('[ws_discover: a cellar]'), '[ws_flag: discover | a cellar]');
    assert.equal(normalizeWsTags('[ws_npc | Bram]'), '[ws_flag: npc | Bram]');
    assert.deepEqual(takeNpcFlags(normalizeWsTags('x [ws_npc: Bram]')).names, ['Bram']);
    assert.equal(normalizeWsTags('[ws_name: Bram]'), '[ws_flag: name | Bram]');
    assert.equal(normalizeWsTags('[ws_lore]'), '[ws_flag: lore]');
    assert.equal(normalizeWsTags('[ws_lore | Hesk]'), '[ws_flag: lore | Hesk]');
    assert.equal(normalizeWsTags('[ws_flag: place | it burns]'), '[ws_flag: place | it burns]');
    assert.deepEqual(takeFoundFlags(normalizeWsTags('They meet. [ws_found: Hesk]')), { names: ['Hesk'], text: 'They meet.' });
    assert.deepEqual(takeNameFlags(normalizeWsTags('Hi. [WS_Name|Bram]')).names, ['Bram']);
    assert.deepEqual(takeLoreFlags(normalizeWsTags('x [ws_lore|Hesk]')).places, ['Hesk']);
});

test('wait and sleep short forms', () => {
    assert.equal(normalizeWsTags('[ws_wait | 45m | mending the net]'), '[ws_wait: 45m | mending the net]');
    assert.equal(normalizeWsTags('[ws_sleep: until morning]'), '[ws_wait: sleep until morning]');
    const w = parseWaitTag('sleep until morning');
    assert.equal(!!w.sleep, true);
});

test('npc short forms read as stamps and are hidden', () => {
    const t = normalizeWsTags('Hi. [ws_disposition: hesk | friendly | saved him] [WS_MEMORY|hesk|was lied to by the player] [ws_npc:Fact|hesk|hates boats]');
    const r = takeNpcTags(t);
    assert.equal(r.text, 'Hi.');
    assert.deepEqual(r.stamps.map(s => s.type), ['npc_disposition', 'npc_memory', 'npc_fact']);
    assert.equal(r.stamps[0].value, 'friendly');
    for (const a of ['leave', 'staying', 'follow', 'stay', 'seek']) assert.match(normalizeWsTags(`[ws_${a} | hesk]`), new RegExp(`^\\[ws_npc: ${a} \\| hesk\\]$`));
});

test('unreadable [ws_...] tags stay in the text and become an activity warning', () => {
    const text = normalizeWsTags('Odd. [ws_bogus | x] [ws_found: Hesk]');
    const after = takeFoundFlags(text).text;
    assert.equal(after, 'Odd. [ws_bogus | x]');
    assert.deepEqual(unreadTags(after), ['[ws_bogus | x]']);
    const msg = { mes: after, extra: { worldscrawl_badtags: [{ swipe: 0, tags: unreadTags(after) }] } };
    const e = messageActivity(msg, 1).find(x => x.kind === 'warning');
    assert.equal(e.text, 'unreadable tag: [ws_bogus | x]');
});
