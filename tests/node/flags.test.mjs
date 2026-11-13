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
test('Proactive room discovery: off by default', () => {
    assert.match(src, /proactiveDiscovery: false/);
    assert.doesNotMatch(src, /reviewDiscoveries/);
    assert.equal(ext.proactiveDiscovery(), false);
});
test('a scene override (for a story engine) wins over the setting, and null falls back', () => {
    const c = SillyTavern.getContext();
    assert.equal(ext.setSceneOverride('proactiveDiscovery', true), true);
    assert.equal(ext.proactiveDiscovery(), true);
    assert.deepEqual(c.chatMetadata[ext.SCENE_KEY], { proactiveDiscovery: true });
    ext.setSceneOverride('proactiveDiscovery', null);
    assert.equal(ext.proactiveDiscovery(), false);
    assert.equal(typeof globalThis.worldscrawlScene.set, 'function');
});
test('a discovery asked for is kept at once; the tracker\'s own waits for Approve unless Auto-keep (real handlers: discoveryhygiene.test.mjs)', () => {
    assert.match(src, /if \(f\.source !== TRACKER_SOURCE \|\| settings\(\)\.autoKeep\) await keepFlag\(id, \{ quiet: true \}\);/);
});
}

// ---- from flagoutcome.test.mjs
{
// A manual map flag always ends visibly: a proposal card, a "can't show this" note, "no map change found", or an error.





const ext = await import('../../extension/index.js');
const pl = await import('../../plugin/shared/patches.mjs');

const C = await import('../../plugin/shared/cards.mjs');
const labels = f => C.placeStatus({ key: 'k', status: f.status, text: ext.flagStatusText(f, 1) });
test('cant reply: a "can\'t show this on the map" note with Check again', () => {
    const ans = pl.readChangeAnswer(ext.parseJsonAnswer('{"cant": "a mind dimension is not a place on the map"}'));
    const f = { status: 'cant', error: ans.cant, start: 3 };
    assert.equal(ext.flagStatusText(f, 5), "🗺 Can't show this on the map: a mind dimension is not a place on the map");
    const d = labels(f);
    assert.equal(d.state, 'failed');
    assert.deepEqual(d.actions.map(a => a.id), ['again', 'discard']);
});
test('empty ops reply: "no map change found" with Check again (an info notice)', () => {
    assert.deepEqual(pl.readChangeAnswer({ ops: [] }), { nothing: true });
    assert.match(ext.flagStatusText({ status: 'nothing', start: 3 }, 5), /No map change found in messages #3–#5/);
    const d = labels({ status: 'nothing', start: 3 });
    assert.equal(d.state, 'info');
    assert.deepEqual(d.actions.map(a => a.id), ['again', 'discard']);
});
test('errors and parse failures show in the bar', () => {
    assert.equal(ext.parseJsonAnswer('sorry, no'), null);
    assert.match(ext.flagStatusText({ status: 'error', error: 'map server answered 500', start: 0 }, 1), /Map change failed: map server answered 500/);
    assert.deepEqual(labels({ status: 'error', start: 0 }).actions.map(a => a.id), ['again', 'discard']);
});
test('never an empty card: review without a proposal or an unknown state still says something', () => {
    for (const status of ['review', 'weird', undefined]) {
        const t = ext.flagStatusText({ status, start: 0 }, 1);
        assert.ok(t.length > 3, String(status));
        assert.ok(labels({ status }).actions.some(a => a.id === 'again'), String(status));
    }
    assert.equal(ext.flagStatusText({ status: 'review', proposal: { ops: [] }, start: 0 }, 1), '', 'a proposal is the review card');
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

// Reporter tools are separate from movement. NPC flagging can be off without dropping the people list or a real tag.
{
const fs = await import('node:fs');
const { validateRecord } = await import('../../plugin/npc.mjs');
const { rememberWorlds } = await import('../../extension/clock.mjs');
const { applyTools } = await import('../../extension/expiry.mjs');
const { toolsToRegister } = await import('../../extension/discovery.mjs');
const ext = await import('../../extension/index.js');
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
ext.setPrompts(def);
const src = extSource();
const hesk = validateRecord({
    id: 'hesk', name: 'Hesk', personality: { summary: 'The landlady.' },
    appearance: { summary: 'copper braids', body: 'sturdy', outfit: 'wool dress' },
}, { file: 'hesk.json' });
const loc = { address: 'r', name: 'Common Room', description: 'Smoky.', exits: [], views: [] };
const people = { npcs_present: 'Hesk [hesk]: landlady. Looks: copper braids.', npc_focus: '' };
const ctx = () => SillyTavern.getContext();
const saveSettings = () => { const s = ext.settings(); return { moveMode: s.moveMode, flagNpcs: s.flagNpcs, flagTags: s.flagTags }; };
let saved;
const registered = () => {
    const names = [];
    const c = ctx();
    c.registerFunctionTool = t => names.push(t.name);
    c.unregisterFunctionTool = () => {};
    c.chatMetadata = { ...(c.chatMetadata ?? {}), worldscrawl_enabled: true };
    applyTools();
    return names;
};

test('no reporter-tools checkbox or setting: the after-reply tracker reports changes', () => {
    assert.doesNotMatch(src, /worldscrawl_reporter_tools|reporterTools/);
    assert.match(src, /id="worldscrawl_flag_npcs" type="checkbox"> Let the narrator flag NPC changes/);
    assert.match(src, /flagNpcs: true/);
    assert.doesNotMatch(src, /name="worldscrawl_mode" value="reporter/);
    ctx().extensionSettings.worldscrawl = { moveMode: 'tools', flagTags: true };
    assert.equal('reporterTools' in ext.settings(), false, 'an old model-moves save gains nothing');
});

test('story tools are not registered; movement tools still follow the movement radio', () => {
    assert.deepEqual(toolsToRegister({ moveMode: 'typed', flagNpcs: true }), []);
    assert.deepEqual(toolsToRegister({ moveMode: 'typed', flagNpcs: false }), []);
    assert.deepEqual(toolsToRegister({ moveMode: 'tools' }), ['ws_look', 'ws_move']);
    assert.deepEqual(toolsToRegister({ moveMode: 'tools', flagNpcs: true }), ['ws_look', 'ws_move']);
    ctx().extensionSettings.worldscrawl = { moveMode: 'typed', flagNpcs: true, flagTags: true };
    assert.deepEqual(registered(), []);
    ctx().extensionSettings.worldscrawl = { moveMode: 'tools', flagNpcs: false };
    assert.deepEqual(registered(), ['ws_look', 'ws_move']);
    ctx().extensionSettings.worldscrawl = { moveMode: 'tools', flagNpcs: true };
    assert.deepEqual(registered(), ['ws_look', 'ws_move']);
});

test('the story prompt keeps the people list and does not say how to report', () => {
    const story = text => { assert.doesNotMatch(text, /ws_npc|ws_flag|ws_wait|end your reply with|call ws_/); };
    const off = ext.factsText(loc, null, false, { ...people, reportNpcs: false, reportTools: true, moveTools: false });
    assert.match(off, /People here/);
    assert.match(off, /Hesk \[hesk\]/);
    story(off);
    assert.match(off, /You only narrate/);
    const tags = ext.factsText(loc, null, false, { ...people, reportNpcs: true, reportTools: false, moveTools: false });
    story(tags);
    assert.match(tags, /You only narrate/);
    const report = ext.factsText(loc, null, false, { ...people, reportNpcs: true, reportTools: true, moveTools: false });
    story(report);
    assert.match(report, /You only narrate/);
    const moving = ext.factsText(loc, null, true, { reportTools: false, moveTools: true });
    assert.match(moving, /Do not invent locations or exits that are not listed\./);
    assert.doesNotMatch(moving, /You only narrate/);
    story(moving);
    const lore = ext.loreBits({ ...loc, lore_chain: [{ level: 'subregion', name: 'The Drowned Rat', text: 'Old.' }] }, true);
    assert.match(lore.lore_index, /Places with local lore: The Drowned Rat\./);
    assert.doesNotMatch(lore.lore_index, /ws_flag/);
    assert.doesNotMatch(ext.newDoorLine('You', 'Hall', true), /ws_flag|ws_npc|ws_wait/);
});

test('a no-op appearance is warned and not rebuilt; a soaked arrival and a pasted tag still apply', async () => {
    saved = saveSettings();
    try {
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [hesk] }] });
    const c = ctx();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    c.updateMessageBlock = () => {};
    document.querySelectorAll = () => [];
    let rebuilds = 0;
    c.generateRaw = async () => { rebuilds++; return '{}'; };
    const s = ext.settings();
    s.flagNpcs = false;
    s.moveMode = 'typed';
    const reply = async mes => {
        rebuilds = 0;
        const msg = { mes, is_user: false, swipe_id: 0, extra: {} };
        c.chat = [msg];
        await ext.onReplyForFlags(0);
        return msg;
    };
    const looks = await reply('Hesk is at the bar. [ws_npc: appearance | hesk | looks | 1 hour]');
    assert.equal((looks.extra?.worldscrawl_npc ?? []).some(x => x.type === 'npc_appearance'), false);
    assert.equal(looks.extra?.worldscrawl_appearance, undefined);
    assert.equal(rebuilds, 0);
    assert.match(JSON.stringify(looks.extra?.worldscrawl_npcwarn ?? []), /appearance did not change/);
    const appeared = await reply('She is here. [ws_npc: appearance | hesk | appeared]');
    assert.equal((appeared.extra?.worldscrawl_npc ?? []).some(x => x.type === 'npc_appearance'), false);
    assert.match(JSON.stringify(appeared.extra?.worldscrawl_npcwarn ?? []), /appearance did not change/);
    const empty = await reply('[ws_npc: appearance | hesk]');
    assert.equal((empty.extra?.worldscrawl_npc ?? []).some(x => x.type === 'npc_appearance'), false);
    assert.match(JSON.stringify(empty.extra?.worldscrawl_npcwarn ?? []), /appearance did not change/);
    const soaked = await reply('Hesk walks in soaked. [ws_npc: appearance | hesk | soaked from the rain | outfit]');
    const stamp = (soaked.extra?.worldscrawl_npc ?? []).find(x => x.type === 'npc_appearance');
    assert.equal(stamp?.intent, 'soaked from the rain');
    assert.equal(stamp?.id, 'hesk');
    assert.equal(stamp?.committed, null);
    assert.equal(soaked.extra?.worldscrawl_appearance?.jobs?.[0]?.status, 'failed');
    } finally {
        const s = ext.settings();
        Object.assign(s, saved);
    }
});

test('the tracker reads one exchange into place, people, and wait, and skips what is not a story reply', () => {
    const parsed = ext.readTrackerAnswer('{"place":{"changed":true,"kind":"change","note":"the roof fell in"},"people":[{"id":"hesk","action":"appearance","intent":"soaked from the rain","fields":"outfit"},{"id":"hesk","action":"disposition","value":"friendly","reason":"they paid"}],"wait":{"duration":"45m","reason":"drying off"}}');
    assert.equal(parsed.place.note, 'the roof fell in');
    assert.equal(parsed.people.length, 2);
    assert.equal(parsed.wait.duration, '45m');
    const memory = ext.readTrackerAnswer('{"people":[{"id":"hesk","action":"memory","text":"Mara promised Hesk the cellar key."}]}');
    assert.equal(memory.people[0].action, 'memory');
    assert.equal(memory.people[0].text, 'Mara promised Hesk the cellar key.');
    assert.equal(memory.place, null);
    const list = ext.readTrackerAnswer({ changes: [{ type: 'place', note: 'the hearth collapsed' }, { type: 'person', id: 'hesk', action: 'fact', text: 'owes a favor' }, { type: 'wait', duration: '1h', reason: 'a long meal' }] });
    assert.equal(list.place.note, 'the hearth collapsed');
    assert.equal(list.people[0].text, 'owes a favor');
    assert.equal(list.wait.reason, 'a long meal');
    assert.equal(ext.readTrackerAnswer({ place: { changed: false, note: 'fog' }, people: [{ id: 'hesk', action: 'appearance', intent: 'looks' }], wait: {} }).place, null);
    const gated = ext.gateTracker(parsed, { places: false, people: false });
    assert.equal(gated.place, null);
    assert.deepEqual(gated.people, []);
    assert.equal(gated.wait.duration, '45m');
    const reply = { is_user: false, mes: 'You look around.' };
    assert.equal(ext.shouldTrackReply(reply, [{ is_user: true, mes: '...' }], 1), true);
    assert.equal(ext.shouldTrackReply(reply, [{ is_user: true, mes: '*You go out.*', extra: { worldscrawl_engine: true } }], 1), true);
    assert.equal(ext.shouldTrackReply(reply, [{ is_user: true, mes: '/ws-help' }], 1), false);
    assert.equal(ext.shouldTrackReply({ is_user: false, is_system: true, mes: 'edit' }, [], 0), false);
    assert.equal(ext.shouldTrackReply({ is_user: false, mes: '   ' }, [], 0), false);
    assert.equal(ext.shouldTrackReply(reply, [], 0), false, 'a greeting has no player line before it');
    assert.equal(ext.shouldTrackReply({ ...reply, swipes: ['You look around.'], swipe_id: 1 }, [{ is_user: true, mes: '...' }], 1), false, 'a swipe still being written');
    assert.equal(ext.newSwipePending({ mes: 'x', swipes: ['x', 'y'], swipe_id: 1 }), false);
    const prompt = ext.trackerPrompt({ scrap: 'This place: Hall\nWeather (known; not a reason to rewrite this place): Fog.\nPeople here:\nHesk [hesk]. Looks: copper braids.', player: 'I look around.', story: 'You look around.' });
    assert.match(prompt, /Fog/);
    assert.match(prompt, /does not rewrite the room/);
    assert.doesNotMatch(prompt, /yesterday|the whole chat/);
});

test('tracker payloads use the person apply, including the no-op appearance reject, and can update a person and a place together', async () => {
    saved = saveSettings();
    try {
        rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [hesk] }] });
        const c = ctx();
        c.chatMetadata = { worldscrawl_enabled: true };
        c.saveChat = async () => {};
        c.updateMessageBlock = () => {};
        let rebuilds = 0;
        c.generateRaw = async () => { rebuilds++; return '{}'; };
        const s = ext.settings();
        s.flagNpcs = true;
        s.flagTags = true;
        s.autoKeepWaits = false;
        const apply = async (answer) => {
            rebuilds = 0;
            const msg = { mes: 'Hesk is here.', is_user: false, swipe_id: 0, extra: {} };
            c.chat = [msg];
            await ext.applyTrackerResult(0, ext.readTrackerAnswer(answer));
            return msg;
        };
        const looks = await apply({ people: [{ id: 'hesk', action: 'appearance', intent: 'looks' }] });
        assert.equal(looks.extra?.worldscrawl_npc, undefined);
        assert.match(JSON.stringify(looks.extra?.worldscrawl_npcwarn ?? []), /appearance did not change/);
        assert.equal(looks.extra.worldscrawl_npcwarn[0].source, 'tracker');
        assert.equal(rebuilds, 0);
        const both = await apply({
            place: { changed: true, kind: 'change', note: 'the hearth collapsed' },
            people: [{ id: 'hesk', action: 'appearance', intent: 'soaked from the rain', fields: 'outfit' }, { id: 'hesk', action: 'disposition', value: 'friendly', reason: 'a kind word' }],
            wait: { duration: '45m', reason: 'drying off' },
        });
        const appearance = (both.extra.worldscrawl_npc ?? []).find(x => x.type === 'npc_appearance');
        const stance = (both.extra.worldscrawl_npc ?? []).find(x => x.type === 'npc_disposition');
        assert.equal(appearance?.intent, 'soaked from the rain');
        assert.equal(appearance?.source, 'tracker');
        assert.equal(stance?.value, 'friendly');
        assert.equal(both.extra.worldscrawl_flag?.note, 'the hearth collapsed');
        assert.equal(both.extra.worldscrawl_flag?.source, 'tracker');
        assert.equal(both.extra.worldscrawl_waitcard?.source, 'tracker');
        assert.match(both.extra.worldscrawl_waitcard?.label ?? '', /45m/);
        assert.equal(appearance?.committed, null, 'a bad preview is not approved');
        assert.equal(rebuilds, 2, 'an intent with no layer text asks for a preview and does not keep a partial answer');
    } finally {
        const s = ext.settings();
        Object.assign(s, saved);
    }
});

test('flag gates block tracker proposals and still allow a pasted tag; a swipe drops tracker stamps', async () => {
    saved = saveSettings();
    try {
        rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [hesk] }] });
        const c = ctx();
        c.chatMetadata = { worldscrawl_enabled: true };
        c.saveChat = async () => {};
        c.updateMessageBlock = () => {};
        c.generateRaw = async () => '{}';
        document.querySelectorAll = () => [];
        const s = ext.settings();
        s.flagNpcs = false;
        s.flagTags = false;
        const gated = { mes: 'Hesk walks in soaked.', is_user: false, swipe_id: 0, extra: {} };
        c.chat = [gated];
        await ext.applyTrackerResult(0, ext.readTrackerAnswer({ place: { changed: true, note: 'the roof fell in' }, people: [{ id: 'hesk', action: 'appearance', intent: 'soaked from the rain', fields: 'outfit' }] }));
        assert.equal(gated.extra.worldscrawl_npc, undefined);
        assert.equal(gated.extra.worldscrawl_flag, undefined);
        const pasted = { mes: 'Soaked. [ws_npc: appearance | hesk | soaked from the rain | outfit] [ws_flag: place | the roof fell in]', is_user: false, swipe_id: 0, extra: {} };
        c.chat = [pasted];
        await ext.onReplyForFlags(0);
        assert.equal((pasted.extra.worldscrawl_npc ?? []).find(x => x.type === 'npc_appearance')?.intent, 'soaked from the rain');
        assert.equal(pasted.extra.worldscrawl_flag?.source, 'tag');
        assert.match(pasted.extra.worldscrawl_flag?.note ?? '', /roof fell in/);
        const swipe = {
            mes: 'A different telling.', is_user: false, swipe_id: 1,
            swipe_info: [{ extra: { worldscrawl_npc: [{ type: 'npc_appearance', id: 'hesk', intent: 'soaked', source: 'tracker', swipe: 0 }] } }, { extra: {} }],
            extra: {
                worldscrawl_npc: [
                    { type: 'npc_appearance', id: 'hesk', intent: 'soaked', source: 'tracker', swipe: 0 },
                    { type: 'npc_fact', id: 'hesk', text: 'pasted fact', source: 'tag', swipe: 1 },
                ],
                worldscrawl_flag: { source: 'tracker', note: 'roof', swipe: 0 },
                worldscrawl_waitcard: { source: 'tracker', label: 'waited 45m', swipe: 0, seconds: 2700 },
            },
        };
        c.chat = [swipe];
        await ext.onStorySwipe(0);
        const left = swipe.extra.worldscrawl_npc ?? [];
        assert.equal(left.some(x => x.source === 'tracker'), false);
        assert.equal(left.find(x => x.type === 'npc_fact')?.text, 'pasted fact');
        assert.equal(swipe.extra.worldscrawl_flag, undefined);
        assert.equal(swipe.extra.worldscrawl_waitcard, undefined);
        assert.equal(swipe.swipe_info[0].extra.worldscrawl_npc, undefined);
    } finally {
        const s = ext.settings();
        Object.assign(s, saved);
    }
});

test('npcEnv exists means the live map: a leftover relocate does not hide a room that is still there', async () => {
    const { npcEnv } = await import('../../extension/scene.mjs');
    const { rememberWorlds } = await import('../../extension/clock.mjs');
    const { validateRecord } = await import('../../plugin/npc.mjs');
    const { scheduleAt } = await import('../../extension/npc.mjs');
    const BAR = 'riverton:drowned_rat/common_room';
    const UP = 'riverton:drowned_rat/upstairs';
    const YARD = 'riverton:drowned_rat/yard';
    const RAT = 'riverton:drowned_rat';
    const card = validateRecord({
        id: 'hesk', name: 'Hesk', unknownAs: 'the landlady', line: 'The landlady.',
        schedule: [
            { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00', importance: 'high' },
            { activity: 'asleep', where: 'her own room', near: RAT },
        ],
    }, { file: 'hesk.json', places: new Set([BAR, UP, YARD]) });
    const PATCH = 'worldscrawl_patches';
    const stamp = (relocate, off = false) => [{ mes: 'The room changes.', is_user: false, extra: { [PATCH]: [{ type: 'patch', swipe: 0, off, relocate }] } }];
    const world = places => rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [card], places: [...places], subs: [RAT], regions: ['riverton'], elsewhere: [] }] });
    const evening = { minutes: 18 * 60 };
    world([BAR, UP, YARD]);
    const on = npcEnv(stamp({ [BAR]: YARD }), { address: BAR, name: 'Uncommon Room', display_name: 'Uncommon Room (The Uncommon Room)' });
    assert.equal(on.exists(BAR), true);
    assert.equal(on.exists(RAT), false);
    assert.equal(on.playerAt(0), BAR);
    const pouring = scheduleAt(card, evening, on);
    assert.equal(pouring.address, BAR);
    assert.equal(pouring.how, 'here');
    assert.equal(pouring.activity, 'pouring drinks');
    const off = npcEnv(stamp({ [BAR]: YARD }, true), { address: BAR });
    assert.deepEqual(off.relocate, {});
    assert.equal(scheduleAt(card, evening, off).address, BAR);
    world([YARD]);
    const merged = npcEnv(stamp({ [BAR]: YARD }), { address: BAR });
    assert.equal(merged.exists(BAR), false);
    assert.equal(scheduleAt(card, evening, merged).address, YARD);
    assert.equal(scheduleAt(card, evening, merged).how, 'merged');
    world([UP]);
    const burned = npcEnv(stamp({ [BAR]: 'riverton:nowhere' }), { address: BAR });
    const asleep = scheduleAt(card, evening, burned);
    assert.equal(asleep.offmap, true);
    assert.equal(asleep.address, null);
    assert.equal(asleep.near?.address, RAT);
    assert.equal(asleep.near?.scope, 'subregion');
    assert.equal(burned.playerAt(0), BAR);
});

test('the tracker scrap is one pass over the live place and every field a person may change', async () => {
    const description = `${'The taproom is long and smoky. '.repeat(12)}The sign is new.`;
    assert.ok(description.length > 240);
    const weather = 'cold fog '.repeat(40);
    const people = ext.trackerPeopleLines([{
        id: 'hesk', name: 'Hesk', looks: 'copper braids.', body: 'Tall.', outfit: '',
        facts: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        memory: ['Joe lied about the coin.'],
        stance: 'indifferent', stanceReason: 'Strangers are customers.',
    }]);
    const scrap = ext.trackerScrap({
        placeName: 'Uncommon Room', displayName: 'Uncommon Room (The Uncommon Room)',
        placeDescription: description, weather, peopleLines: people,
    });
    assert.match(scrap, /^This place: Uncommon Room \(The Uncommon Room\)/);
    assert.match(scrap, new RegExp(`Description: ${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(scrap.split('\nWeather')[0], /…/);
    const weatherLine = scrap.split('\n').find(l => l.startsWith('Weather'));
    assert.match(weatherLine, /Weather \(known; not a reason to rewrite this place\): cold fog/);
    assert.match(weatherLine, /…$/);
    assert.ok(weatherLine.length < weather.length, 'weather is still clipped');
    assert.match(people, /Looks: copper braids/);
    assert.match(people, /Body: Tall\./);
    assert.match(people, /Outfit: \(none\)/);
    assert.match(people, /Known facts: one; two; three; four; five; six; seven/);
    assert.match(people, /Memories: Joe lied about the coin/);
    assert.match(people, /Stance toward the player: indifferent \(Strangers are customers\)/);
    assert.match(ext.trackerScrap({ placeName: 'Hall' }), /This place: Hall\nDescription: \(none\)/);
    assert.match(ext.trackerScrap({ placeName: 'Taproom', displayName: 'The Uncommon Room' }), /This place: Taproom \(The Uncommon Room\)/);
    const prompt = ext.trackerPrompt({ scrap, player: 'I look around.', story: 'You look around.' });
    assert.match(prompt, /does not rewrite the room/);
    assert.match(prompt, /memory already listed/);
    assert.match(prompt, /stance and reason listed above/);
    assert.match(prompt, /walk in soaked/);
    assert.match(prompt, /time actually passed/);
    assert.match(prompt, /"looks" or "appeared"/);
    assert.doesNotMatch(prompt, /yesterday|the whole chat|end your reply with|\[ws_npc/);
    const discovery = fs.readFileSync(new URL('../../extension/discovery.mjs', import.meta.url), 'utf8');
    assert.equal(discovery.split("gen('tracker'").length - 1, 1);
    const { listedPeople } = await import('../../extension/scene.mjs');
    const { rememberWorlds } = await import('../../extension/clock.mjs');
    const { validateRecord } = await import('../../plugin/npc.mjs');
    const BAR = 'riverton:drowned_rat/common_room';
    const card = validateRecord({
        id: 'hesk', name: 'Hesk', line: 'The landlady.',
        appearance: { summary: 'copper braids', body: 'Tall.', outfit: 'An apron.' },
        facts: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        memory: ['Joe lied about the coin.'],
        disposition: { player: { value: 'friendly', reason: 'they paid' } },
        schedule: [{ place: BAR, activity: 'pouring drinks' }],
    }, { file: 'hesk.json', places: new Set([BAR]) });
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [card], places: [BAR], subs: [], regions: ['riverton'], elsewhere: [] }] });
    const listed = listedPeople([{ mes: 'hello', is_user: true }], 0, { address: BAR, name: 'Uncommon Room', display_name: 'Uncommon Room (The Uncommon Room)' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].facts.length, 7);
    assert.deepEqual(listed[0].memory, ['Joe lied about the coin.']);
    assert.equal(listed[0].stance, 'friendly');
    assert.equal(listed[0].stanceReason, 'they paid');
    assert.equal(listed[0].looks, 'copper braids');
});
}

test('ownedCall drops a late answer when the timer wins', async () => {
    const { ownedCall } = await import('../../extension/ownedcall.mjs');
    let late;
    const raced = await ownedCall(new Promise(resolve => { late = () => resolve('too late'); }), 20);
    assert.equal(raced.timeout, true);
    late();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(raced.raw, undefined);
});

test('appearance rebuild settles complete, bad, and late answers without a partial cache', async () => {
    const fs = await import('node:fs');
    const ext = await import('../../extension/index.js');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    c.updateMessageBlock = () => {};
    document.querySelectorAll = () => [];
    const good = '{"looks":"young braids","body":"years younger","outfit":"a bright dress"}';
    const stamp = () => ({ mes: 'The beam hits Hesk.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
        { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
        { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'magically young', owner: 'oy', start: 0, lasts: null, contentId: 'cy', candidate: null, identity: { owner: 'oy', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'magically young', fields: 'body,outfit', layer: {} } },
    ] } });
    const run = async (reply, { timeout = 200 } = {}) => {
        let calls = 0;
        c.generateRaw = async () => { calls++; return typeof reply === 'function' ? reply() : reply; };
        const msg = stamp();
        c.chat = [msg];
        await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout });
        return { calls, msg, play: npcAt(c.chat, 0, [], 'hesk') };
    };
    const landed = await run(good);
    assert.equal(landed.calls, 2, 'body and outfit, then a separate Looks summary');
    assert.equal(landed.play.appearanceHow === 'pending', false);
    assert.equal(landed.play.body, 'years younger');
    assert.equal((landed.msg.extra.worldscrawl_compose?.records ?? []).some(r => r.outfit === 'a bright dress'), true);
    assert.equal(landed.msg.extra[NPC_KEY].some(s => s.type === 'npc_appearance_cache'), false);
    assert.equal(landed.msg.extra.worldscrawl_appearance, undefined);
    for (const [reply, kind] of [['{"body":"younger"}', 'partial'], ['', 'empty'], ['I cannot rewrite that.', 'refusal'], ['{"looks": "cut', 'truncated']]) {
        const bad = await run(reply);
        assert.equal(bad.calls, 2, kind);
        assert.equal(bad.play.appearanceHow, 'pending', kind);
        assert.equal(bad.msg.extra[NPC_KEY].some(s => s.type === 'npc_appearance_cache'), false, kind);
        assert.equal((bad.msg.extra.worldscrawl_compose?.records ?? []).some(r => r.body), false, kind);
        assert.equal(bad.play.body, '', kind);
        const job = scene.appearJobs(bad.msg).find(j => j.id === 'hesk');
        assert.equal(job?.status, 'failed', kind);
        assert.equal(job?.kind, kind, kind);
    }
    let late = '';
    c.generateRaw = () => new Promise(resolve => { late = () => resolve(good); });
    const hung = stamp();
    c.chat = [hung];
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 30 });
    late();
    await new Promise(r => setTimeout(r, 20));
    assert.equal((hung.extra.worldscrawl_compose?.records ?? []).some(r => r.body === 'years younger'), false);
    assert.equal(scene.appearJobs(hung).find(j => j.id === 'hesk')?.kind, 'timeout');
    let calls = 0;
    c.generateRaw = async () => { calls++; return good; };
    const dup = stamp();
    c.chat = [dup];
    const first = scene.retryAppearance(0, 'hesk', 'magically young|body+outfit');
    const second = await scene.retryAppearance(0, 'hesk', 'magically young|body+outfit');
    await first;
    assert.equal(second.error, 'Already retrying.');
    assert.equal(calls, 2);
});

test('a failed Looks summary keeps the body rewrite, and an expired layer does not keep the combined text', async () => {
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const ext = await import('../../extension/index.js');
    const fs = await import('node:fs');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    document.querySelectorAll = () => [];
    let n = 0;
    c.generateRaw = async () => { n++; return n === 1 ? '{"body":"a centaur barrel","outfit":"a harness"}' : 'I cannot rewrite that.'; };
    const msg = { mes: 'The spell lands.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
        { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
        { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'centaur', owner: 'oc', start: 0, lasts: null, contentId: 'cc', candidate: null, identity: { owner: 'oc', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'centaur', fields: 'body,outfit', layer: {} } },
    ] } };
    c.chat = [msg];
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 200 });
    const play = npcAt(c.chat, 0, [], 'hesk');
    assert.equal(play.body, 'a centaur barrel');
    assert.equal(play.outfit, 'a harness');
    assert.equal(play.looks, '');
    assert.equal(play.looksHow, 'pending');
    assert.equal(msg.extra[NPC_KEY].some(s => s.type === 'npc_appearance_cache'), false);
    assert.equal((msg.extra.worldscrawl_compose?.records ?? []).some(r => r.kind === 'looks'), false);
    const job = scene.appearJobs(msg).find(j => j.part === 'looks');
    assert.equal(job?.kind, 'refusal');
    const appearanceStamps = () => msg.extra[NPC_KEY].filter(s => s.type === 'npc_appearance').length;
    const before = appearanceStamps();
    c.generateRaw = async () => '{"looks":"a harnessed centaur"}';
    await scene.retryAppearance(0, 'hesk', job.key);
    assert.equal(appearanceStamps(), before, 'a retry does not stamp the effect again');
    assert.equal(npcAt(c.chat, 0, [], 'hesk').body, 'a centaur barrel');
});

test('engine-resolved body text asks only for a Looks summary, and Retry does not rewrite the body', async () => {
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const { rememberWorlds } = await import('../../extension/clock.mjs');
    const ext = await import('../../extension/index.js');
    const fs = await import('node:fs');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    const hesk = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' };
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [hesk] }] });
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    document.querySelectorAll = () => [];
    const prompts = [];
    const msg = { mes: 'Hesk is taller.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
        { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
        { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'taller', owner: 'ot', start: 0, lasts: null, contentId: 'ct', candidate: null, identity: { owner: 'ot', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' } } },
    ] } };
    c.chat = [msg];
    c.generateRaw = async (args) => { prompts.push(args.prompt); return 'I cannot rewrite that.'; };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 200 });
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(p => /Write one short Looks line/.test(p)), prompts.join('\n---\n'));
    assert.equal(npcAt(c.chat, 0, [hesk], 'hesk').body, 'a towering woman');
    assert.equal(npcAt(c.chat, 0, [hesk], 'hesk').looksHow, 'pending');
    const job = scene.appearJobs(msg).find(j => j.part === 'looks');
    prompts.length = 0;
    c.generateRaw = async (args) => { prompts.push(args.prompt); return '{"looks":"a towering woman with copper braids"}'; };
    await scene.retryAppearance(0, 'hesk', job.key);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Write one short Looks line/);
    assert.doesNotMatch(prompts[0], /(?:Rewrite|Edit) body/);
    const after = npcAt(c.chat, 0, [hesk], 'hesk');
    assert.equal(after.body, 'a towering woman');
    assert.equal(after.looks, 'a towering woman with copper braids');
    assert.equal(after.looksHow, 'reuse');
});

test('expiry of one layered body keeps that layer text and asks only for Looks', async () => {
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const { loadCalendar, clockAt } = await import('../../extension/clock.mjs');
    const clock = i => ({ elapsed: clockAt(i, c.chat) });
    const ext = await import('../../extension/index.js');
    const fs = await import('node:fs');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    await loadCalendar();
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    document.querySelectorAll = () => [];
    const chat = [
        { mes: 'Both forms.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
            { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
            { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'gnoll', owner: 'og', start: 0, lasts: 120, contentId: 'cg', candidate: null, identity: { owner: 'og', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'gnoll', fields: 'body', layer: { body: 'a gnoll frame' } } },
            { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'centaur', owner: 'oce', start: 0, lasts: 60, contentId: 'cce', candidate: null, identity: { owner: 'oce', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'centaur', fields: 'body', layer: { body: 'a centaur barrel' } } },
        ] } },
        { mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } },
    ];
    c.chat = chat;
    const prompts = [];
    c.generateRaw = async (args) => { prompts.push(args.prompt); return '{"looks":"a gnoll with copper braids"}'; };
    await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 200 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Write one short Looks line/);
    assert.match(prompts[0], /a gnoll frame/);
    const play = npcAt(c.chat, 1, [], 'hesk', clock);
    assert.equal(play.body, 'a gnoll frame');
    assert.equal(play.looks, 'a gnoll with copper braids');
});

test('a stale Looks answer is dropped, and undo reuses the cached summary', async () => {
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const ext = await import('../../extension/index.js');
    const fs = await import('node:fs');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    document.querySelectorAll = () => [];
    const msg = { mes: 'She grows.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
        { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
        { swipe: 0, type: 'npc_appearance', id: 'hesk', intent: 'taller', owner: 'ot2', start: 0, lasts: null, contentId: 'ct2', candidate: null, identity: { owner: 'ot2', message: 'm', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, committed: { kind: 'appearance', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' } } },
    ] } };
    c.chat = [msg];
    let release;
    const started = new Promise(resolve => {
        c.generateRaw = () => new Promise(done => { release = () => done('{"looks":"a stale line"}'); resolve(); });
    });
    const pending = scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 500 });
    await started;
    msg.extra[NPC_KEY][1].committed.layer.body = 'a different frame';
    release();
    await pending;
    assert.equal((msg.extra.worldscrawl_compose?.records ?? []).some(r => r.looks === 'a stale line' && r.body === 'a different frame'), false);
    msg.extra[NPC_KEY][1].committed.layer.body = 'a towering woman';
    let calls = 0;
    c.generateRaw = async () => { calls++; return '{"looks":"tall copper braids"}'; };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 200 });
    assert.equal(calls, 1);
    assert.equal(npcAt(c.chat, 0, [], 'hesk').looks, 'tall copper braids');
    msg.extra[NPC_KEY][1].off = true;
    calls = 0;
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 200 });
    assert.equal(calls, 0, 'base body needs no new summary');
    assert.equal(npcAt(c.chat, 0, [], 'hesk').looks, 'copper braids');
    msg.extra[NPC_KEY][1].off = false;
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 200 });
    assert.equal(calls, 0, 'the same body reuses the cached summary');
    assert.equal(npcAt(c.chat, 0, [], 'hesk').looks, 'tall copper braids');
    assert.equal(npcAt(c.chat, 0, [], 'hesk').body, 'a towering woman');
});

test('a player body edit proposes a baseline replacement and does not rewrite the body before approval', async () => {
    const scene = await import('../../extension/scene.mjs');
    const { npcAt, NPC_KEY } = await import('../../extension/npc.mjs');
    const ext = await import('../../extension/index.js');
    const fs = await import('node:fs');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    const c = SillyTavern.getContext();
    c.chatMetadata = { worldscrawl_enabled: true };
    c.chatId = 'c1';
    c.saveChat = async () => {};
    document.querySelectorAll = () => [];
    const msg = { mes: 'Edit.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { [NPC_KEY]: [
        { swipe: 0, type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
    ] } };
    c.chat = [msg];
    const prompts = [];
    c.generateRaw = async (args) => { prompts.push(args.prompt); return '{"looks":"broader, copper braids"}'; };
    const res = await scene.npcChatEdit({ chatId: 'c1', msg: 0, swipe: 0, id: 'hesk', stamps: [{ type: 'npc_baseline', field: 'body', text: 'broader shoulders' }] });
    assert.equal(res.ok, true);
    const proposal = (c.chat[0].extra[NPC_KEY] ?? []).find(s => s.type === 'npc_baseline');
    assert.equal(proposal?.committed, null);
    assert.equal(proposal?.candidate?.text, 'broader shoulders');
    assert.equal(prompts.length, 0, 'an explicit baseline replacement does not ask the model to rewrite the body');
    assert.equal(npcAt(c.chat, 0, [], 'hesk').body, 'sturdy');
});
