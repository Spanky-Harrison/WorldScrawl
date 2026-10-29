// Flagging the player's own message checks the narrator's reply with it; Proactive room discovery (off by default,
// overridable per scene) decides whether rooms the narration only mentions may be discovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
ext.setPrompts(def);
const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');

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
