import './ststub.mjs';
import { extSource } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeWsTags, unreadTags, parseWaitTag } from '../../extension/words.mjs';
import { takeNpcTags, takeFoundFlags, takeNameFlags, takeNpcFlags, takeLoreFlags } from '../../extension/npc.mjs';
import { messageActivity } from '../../extension/activity.mjs';

// ---- from flagreply.test.mjs
{
// Flagging the player's own message checks the narrator's reply with it; Proactive room discovery (off by default,
// overridable per scene) decides whether rooms the narration only mentions may be discovered.





const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
ext.setPrompts(def);
const src = extSource();

test('replyAfter: the narrator reply right after a player message, skipping engine notices', () => {
    const chat = [{ is_user: true }, { is_system: true }, { is_user: false }, { is_user: true }];
    assert.equal(ext.replyAfter(chat, 0), 2);
    assert.equal(ext.replyAfter(chat, 3), -1, 'no reply yet');
    assert.equal(ext.replyAfter([{ is_user: true }, { is_user: true }, { is_user: false }], 0), -1, 'another player message first');
});
test('flagging a player message flags the reply from that message on (no "flag the reply instead" note)', () => {
    assert.doesNotMatch(src, /flag the narrator's reply instead/);
    assert.match(src, /if \(r >= 0\) return flagMessage\(r, \{ note, hint, start: id, source, kind \}\)/);
    assert.match(src, /pendingUserFlag = \{ chat: chatKey\(\), start: id/);
});
test('Proactive room discovery: off by default; off wording only counts doors actually opened, never scenery', () => {
    assert.match(src, /proactiveDiscovery: false/);
    assert.doesNotMatch(src, /reviewDiscoveries/);
    assert.equal(ext.proactiveDiscovery(), false);
    for (const t of [ext.flagHint(false), ext.flagToolText(false), ext.flagActionText(false)]) {
        assert.match(t, /actually open/); assert.match(t, /scenery/); assert.doesNotMatch(t, /\{\{/);
    }
    for (const t of [ext.flagHint(true), ext.flagToolText(true), ext.flagActionText(true)]) { assert.match(t, /names a room or passage/); assert.doesNotMatch(t, /\{\{/); }
    assert.match(ext.flagHint(false), /\[ws_flag: discover \| which door\]/);
});
test('a scene override (for a story engine) wins over the setting, and null falls back', () => {
    const c = SillyTavern.getContext();
    assert.equal(ext.setSceneOverride('proactiveDiscovery', true), true);
    assert.equal(ext.proactiveDiscovery(), true);
    assert.deepEqual(c.chatMetadata[ext.SCENE_KEY], { proactiveDiscovery: true });
    assert.match(ext.flagHint(), /names a room or passage/);
    ext.setSceneOverride('proactiveDiscovery', null);
    assert.equal(ext.proactiveDiscovery(), false);
    assert.equal(typeof globalThis.worldscrawlScene.set, 'function');
});
test('discoveries are kept at once (no Keep / Discard card)', () => {
    assert.match(src, /await keepFlag\(id, \{ quiet: true \}\); \/\/ a discovery is added at once/);
});
}

// ---- from flagoutcome.test.mjs
{
// A manual map flag always ends visibly: a proposal card, a "can't show this" note, "no map change found", or an error.





const ext = await import('../../extension/index.js');
const pl = await import('../../plugin/shared/patches.mjs');

test('cant reply: a "can\'t show this on the map" note with Retry', () => {
    const ans = pl.readChangeAnswer(ext.parseJsonAnswer('{"cant": "a mind dimension is not a place on the map"}'));
    const v = ext.flagCardView({ status: 'cant', error: ans.cant, start: 3 }, 5);
    assert.equal(v.text, "🗺 Can't show this on the map: a mind dimension is not a place on the map");
    assert.deepEqual(v.buttons, ['Retry', 'Dismiss']);
});
test('empty ops reply: "no map change found" with Retry', () => {
    assert.deepEqual(pl.readChangeAnswer({ ops: [] }), { nothing: true });
    const v = ext.flagCardView({ status: 'nothing', start: 3 }, 5);
    assert.match(v.text, /No map change found in messages #3–#5/);
    assert.ok(v.buttons.includes('Retry'));
});
test('errors and parse failures show in the bar', () => {
    assert.equal(ext.parseJsonAnswer('sorry, no'), null);
    const v = ext.flagCardView({ status: 'error', error: 'map server answered 500', start: 0 }, 1);
    assert.match(v.text, /Map change failed: map server answered 500/);
    assert.ok(v.buttons.includes('Retry'));
});
test('never an empty card: review without a proposal or an unknown state still says something', () => {
    for (const status of ['review', 'weird', undefined]) {
        const v = ext.flagCardView({ status, start: 0 }, 1);
        assert.ok(v && v.text.length > 3 && v.buttons.includes('Retry'), String(status));
    }
    assert.equal(ext.flagCardView({ status: 'review', proposal: { ops: [] }, start: 0 }, 1).buttons[0], 'review');
});
test('Debug > Show map edit messages logs the map-edit call', () => {
    const seen = [], orig = console.info; console.info = (...a) => seen.push(a);
    try {
        ext.settings().showEditMessages = false; ext.logEditCall('the change', 'Q', 'A');
        assert.equal(seen.length, 0);
        ext.settings().showEditMessages = true; ext.logEditCall('the change', 'Q', '{"ops": []}');
        assert.equal(seen.length, 1); assert.match(seen[0][0], /map edit call: the change/); assert.equal(seen[0][1].answer, '{"ops": []}');
    } finally { console.info = orig; ext.settings().showEditMessages = false; }
});
test('the flag button and the analysis cannot fail silently', () => {
    const src = extSource();
    assert.match(src, /flagMessage\(Number\(el\.getAttribute\('mesid'\)\)\)\.then\([^\n]*toastr\.error/);
    assert.match(src, /analyzeFlag\(id\)\.catch\(/);
    assert.match(src, /try \{\n\s+await ensurePrompts\(\);/);
});
}

// ---- from lenienttags.test.mjs
{
// Lenient tag reading: short forms normalize to the documented tags; unreadable [ws_...] tags stay visible and warn.






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
}
