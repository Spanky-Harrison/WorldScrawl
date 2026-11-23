// R2 (prompt revision): the map change scope and patch prompts, through the production paths: a tracker place answer
// -> applyTrackerResult -> flagMessage -> analyzeFlag (stubbed model, the real map server in-process); the player's
// flag (/ws-change, the flag button, Edit's Change line) and a pasted [ws_flag] tag (onReplyForFlags) the same way.
// C1 no filled-in area example; C2 person is not place in the scope system prompt; C3 the light example;
// C4/C5 the description rule and the shared timeless line; C6 {{what}} worded by who raised the change, no aftermath.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { applyTrackerResult, flagMessage, onReplyForFlags, discoverSys } = await import('../../extension/discovery.mjs');
const { readTrackerAnswer } = await import('../../extension/tracker.mjs');
const { analyzeFlag, rewriteSys, patchSys, scopeSys } = await import('../../extension/carriers.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(await import('../../plugin/ui/diffview.mjs'));
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const shared = await import('../../plugin/shared/patches.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const TEXT = Object.fromEntries(PROMPTS.prompts.map(e => [e.id, e.text]));
const FLAG = 'worldscrawl_flag';
const AREA = 'riverton:drowned_rat';
const server = clientDir(path.dirname(RIVERTON));
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));

let aftermathAsked = 0;
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search;
    if (route.startsWith('/aftermath')) aftermathAsked++;
    const json = opts.body ? JSON.parse(opts.body) : undefined;
    const r = server.request(opts.method || 'GET', route, { json });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};

/** A stubbed model: answers by which question it was asked, records every call. */
function model(answers) {
    const calls = [];
    SillyTavern.getContext().generateRaw = async args => {
        const p = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        const kind = /Which places did the story change/.test(p) ? 'rooms' : /Write the patch JSON/.test(p) ? 'patch' : 'other';
        calls.push({ kind, prompt: p, sys });
        const a = answers[kind];
        return typeof a === 'function' ? a(p, sys) : a ?? '{}';
    };
    return calls;
}
function boot(reply = 'The stool splinters the floorboards near the bar.') {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'r2'; c.getCurrentChatId = () => 'r2';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    ext.settings().flagTags = true; ext.settings().autoKeep = false;
    c.chat = [
        { is_user: true, mes: 'I kick the stool over.', swipe_id: 0, extra: { worldscrawl_move: { to: TAVERN } } },
        { is_user: false, mes: reply, swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} },
    ];
    return c;
}
async function settled(id = 1) {
    for (let i = 0; i < 100; i++) { const f = SillyTavern.getContext().chat[id]?.extra?.[FLAG]; if (f && f.status !== 'working') return f; await flush(10); }
    throw new Error('the flag never settled');
}
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie near a knocked-over stool, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const ops = list => JSON.stringify({ ops: list });
const ANSWERS = { rooms: `{"rooms":["${TAVERN}"],"areas":[]}`, patch: ops([{ op: 'set_description', loc: TAVERN, text: BOARDS }]) };
const tracker = place => readTrackerAnswer(JSON.stringify({ place: { changed: true, kind: 'change', rewrite: 'light', why: 'one spot', ...place }, people: [], wait: null }));
const scopeAsk = p => p.slice(p.indexOf('Which places did the story change'));
const OLD_WHAT = /The player or narrator noted/;
/** The flag card's status line for message 1, as drawn. */
function cardText() {
    const doc = makeDoc([0, 1]); globalThis.document = doc; renderPatchCards();
    return doc.querySelector('.worldscrawl_patchcard')?.textContent ?? '';
}

test('C1 + C2: the scope question has no filled-in area example and the scope system prompt says a person is not a place', async () => {
    boot();
    const calls = model(ANSWERS);
    await applyTrackerResult(1, tracker({ note: 'the stool splintered the floorboards' }));
    const f = await settled();
    assert.equal(f.status, 'review', f.error);
    const q = calls.find(x => x.kind === 'rooms');
    assert.ok(q.prompt.includes(`(${AREA})`), 'the map header still names the area the party is in');
    const ask = scopeAsk(q.prompt);
    assert.ok(!ask.includes(AREA), `the reply shape names no area id: ${ask}`);
    assert.doesNotMatch(q.prompt, /e\.g\. "riverton/);
    assert.match(ask, /"areas": \[\]/);
    assert.match(ask, /Put an area id in areas only when the building or district as a whole changed: it was renamed, or its notes no longer hold\. One room changing is a room, not its area\./);
    assert.match(ask, /or \{"rooms": \[\], "areas": \[\]\} if nothing on the map changed\.$/, 'the shape and the empty default are last');
    assert.match(q.sys, /A change to a person \(how they look, what they wear, an injury, their mood, where they went\) is not a map change, even when a room's or area's notes mention them\. The person tracker handles people\. If the story changed only people, reply \{"rooms": \[\], "areas": \[\]\}\./);
    assert.ok(q.sys.endsWith(TEXT['pick.base_json'] + '.'), 'the shared JSON base still ends the scope system prompt');
    assert.equal(q.sys, scopeSys());
});

test('C2 path: a people-only story answered with no rooms and no areas is "nothing", with no patch call and no card proposal', async () => {
    boot('Hesk ties her braids back and limps to the door, wincing at her ankle.');
    const calls = model({ rooms: '{"rooms":[],"areas":[]}', patch: ANSWERS.patch });
    await flagMessage(1, { note: "Hesk's ankle is hurt", source: 'command' });
    const f = await settled();
    assert.equal(f.status, 'nothing');
    assert.equal(f.proposal, undefined);
    assert.deepEqual(calls.map(x => x.kind), ['rooms'], 'no patch call');
    assert.match(scopeAsk(calls[0].prompt), /\{"rooms": \[\], "areas": \[\]\}/);
    // Round 1: the card says so plainly (display text only; the model never sees it).
    assert.equal(f.empty, true); assert.ok(!f.error, f.error);
    const card = cardText();
    assert.ok(card.includes('🗺 Nothing on the map changed (messages #0–#1).'), card);
    assert.doesNotMatch(card, /no known room was named|No map change found/);
    assert.ok(calls.every(x => !/Nothing on the map changed/.test(x.prompt + x.sys)), 'not model text');
    // "Check again" on a story that did change something clears it.
    model(ANSWERS);
    await analyzeFlag(1);
    const g = await settled();
    assert.equal(g.status, 'review'); assert.equal(g.empty, undefined);
});

test('empty scope card (round 1): places named that are not on the map keep "no known room was named"', async () => {
    boot();
    model({ rooms: '{"rooms":["riverton:nowhere/attic"],"areas":[]}', patch: ANSWERS.patch });
    await flagMessage(1, { note: 'the attic', source: 'command' });
    const f = await settled();
    assert.equal(f.status, 'nothing'); assert.equal(f.error, 'no known room was named'); assert.equal(f.empty, undefined);
    const card = cardText();
    assert.ok(card.includes('🗺 No map change found in messages #0–#1. (no known room was named)'), card);
});

test('C6: {{what}} is worded by who raised the change, in both steps; Edit\'s Change line makes it the player\'s', async () => {
    // The after-reply tracker.
    boot();
    let calls = model(ANSWERS);
    await applyTrackerResult(1, tracker({ note: 'the stool splintered the floorboards' }));
    assert.equal((await settled()).status, 'review');
    for (const k of ['rooms', 'patch']) {
        const p = calls.find(x => x.kind === k).prompt;
        assert.match(p, /The change to look for: "the stool splintered the floorboards"\./, k);
        assert.doesNotMatch(p, /noted:/, k); assert.doesNotMatch(p, OLD_WHAT, k);
    }
    // Edit > Change: "Rewrite with this" on the tracker's flag: now the player's note.
    calls = model(ANSWERS);
    await analyzeFlag(1, { note: 'only the boards by the bar' });
    for (const k of ['rooms', 'patch']) {
        const p = calls.find(x => x.kind === k).prompt;
        assert.match(p, /The player noted: "only the boards by the bar"\./, k);
        assert.doesNotMatch(p, /The change to look for/, k);
    }

    // /ws-change and the flag button: the player.
    for (const source of ['command', 'button']) {
        boot();
        calls = model(ANSWERS);
        await flagMessage(1, { note: 'the floor splintered', source });
        assert.equal((await settled()).status, 'review', source);
        for (const k of ['rooms', 'patch']) {
            const p = calls.find(x => x.kind === k).prompt;
            assert.match(p, /The player noted: "the floor splintered"\./, `${source} ${k}`);
            assert.doesNotMatch(p, /The narrator noted|The change to look for/, `${source} ${k}`); assert.doesNotMatch(p, OLD_WHAT);
        }
    }

    // A [ws_flag] tag in the reply: the narrator, with the place it names.
    boot('The stool splinters the floorboards near the bar. [ws_flag: The Drowned Rat | the floor splintered]');
    calls = model(ANSWERS);
    await onReplyForFlags(1);
    const g = await settled();
    assert.equal(g.source, 'tag'); assert.equal(g.status, 'review', g.error);
    for (const k of ['rooms', 'patch']) {
        const p = calls.find(x => x.kind === k).prompt;
        assert.match(p, /The narrator noted: "the floor splintered"\. Place mentioned: "The Drowned Rat"\./, k);
        assert.doesNotMatch(p, /The player noted|The change to look for/, k); assert.doesNotMatch(p, OLD_WHAT);
    }

    // No note: {{what}} is empty, no piece at all.
    boot();
    calls = model(ANSWERS);
    await flagMessage(1, { source: 'command' });
    await settled();
    assert.doesNotMatch(calls.find(x => x.kind === 'rooms').prompt, /noted:|The change to look for/);
});

test('C6: each note piece is its own prompt entry: an override changes only its own source', async () => {
    ext.setPrompts({ ...TEXT, 'change.what_tracker': 'TRACKER SAYS {{note}}', 'change.what_player': 'PLAYER SAYS {{note}}', 'change.what_narrator': 'NARRATOR SAYS {{note}}' });
    const f = { note: 'smoke', hint: 'The Rat' };
    assert.equal(ext.flagWhat({ ...f, source: 'tracker' }), 'TRACKER SAYS smoke Place mentioned: "The Rat".');
    assert.equal(ext.flagWhat({ ...f, source: 'tracker', noteBy: 'player' }), 'PLAYER SAYS smoke Place mentioned: "The Rat".');
    assert.equal(ext.flagWhat({ ...f, source: 'command' }), 'PLAYER SAYS smoke Place mentioned: "The Rat".');
    assert.equal(ext.flagWhat({ ...f, source: 'button' }), 'PLAYER SAYS smoke Place mentioned: "The Rat".');
    assert.equal(ext.flagWhat({ ...f, source: 'tag' }), 'NARRATOR SAYS smoke Place mentioned: "The Rat".');
    assert.equal(ext.flagWhat({ source: 'tracker' }), '');
    ext.setPrompts(PROMPTS);
});

test('C6: the narrator\'s aftermath line ("Do not describe it.") is not sent to the map change calls', async () => {
    // A kept change on the chat, so the map has changed around the party (the aftermath check would run).
    boot();
    let calls = model(ANSWERS);
    await flagMessage(1, { note: 'the floor splintered', source: 'command' });
    assert.equal((await settled()).status, 'review');
    const doc = makeDoc([0, 1]); globalThis.document = doc; renderPatchCards();
    doc.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === 'Approve').click();
    await flush(60);
    const c = SillyTavern.getContext();
    assert.ok(c.chat.some(m => m?.extra?.worldscrawl_patches?.length), 'the change was kept');
    c.chat.push({ is_user: true, mes: 'I set a candle on the bar.', swipe_id: 0, extra: {} }, { is_user: false, mes: 'Smoke fills the room.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_location: TAVERN } }); // the narrated reply carries where the party is
    const id = c.chat.length - 1;
    aftermathAsked = 0;
    calls = model(ANSWERS);
    await flagMessage(id, { note: 'smoke fills the room', source: 'command' });
    await settled(id);
    assert.equal(aftermathAsked, 0, 'the change calls never ask for the aftermath line');
    for (const x of calls) assert.doesNotMatch(x.prompt, /Do not describe|Since the last reply|is gone; the characters are now in/);
});

test('C3: the patch system prompt has the light one-room example first, then the full rewrite with update_area + lore', () => {
    ext.setPrompts(PROMPTS);
    const sys = patchSys(shared);
    const light = sys.indexOf('Example, light touch, one room (a smashed bar): {"ops":[{"op":"set_description","loc":"riverton:drowned_rat/common_room","text":"<the same description with only the bar sentence changed>"}]}');
    const full = sys.indexOf('Example, a full rewrite (a whole inn turned into a palace): {"ops":[{"op":"update_area","area":"riverton:drowned_rat","name":"The Golden Palace","lore":"<the area\'s whole notes, rewritten for the palace, keeping what still holds; then: formerly the Drowned Rat inn, turned into a palace by magic>"}');
    assert.ok(light > 0 && full > light, 'light first, then the full rewrite');
    assert.match(sys, /update_area and append_lore are for a building that changed as a whole\./);
    // Both examples parse as JSON ops of the right shape.
    const exOps = s => JSON.parse(s.slice(s.indexOf('{"ops"'), s.indexOf('\n', s.indexOf('{"ops"')))).ops;
    const lightOps = exOps(sys.slice(light)), fullOps = exOps(sys.slice(full));
    assert.deepEqual(lightOps.map(o => o.op), ['set_description']);
    assert.deepEqual(fullOps.map(o => o.op), ['update_area', 'set_description', 'set_description']);
    assert.equal(typeof fullOps[0].lore, 'string', 'the palace example teaches lore, not text');
    assert.equal(fullOps[0].text, undefined);
    assert.match(fullOps[0].lore, /^<the area's whole notes, rewritten for the palace, keeping what still holds/, 'round 1: a placeholder that keeps the old notes, not a literal that replaces them');
});

test('C4 + C5: the description rule says what to write; the timeless line is one shared entry in change.style and discover.style', () => {
    ext.setPrompts(PROMPTS);
    const T = TEXT['change.timeless'];
    assert.equal(T, 'Descriptions are timeless: write what a visitor would find at any hour with nobody about. The game adds the time, light, weather, who is there and which doors stand open each turn, so the description leaves those to it.');
    for (const [name, sys] of [['patch', patchSys(shared)], ['discover', discoverSys()], ['rewrite', rewriteSys(shared, 'light')]]) {
        assert.equal(sys.split(T).length - 1, 1, `${name}: the shared timeless line once`);
        assert.ok(!sys.includes('{{timeless}}'), name);
        assert.doesNotMatch(sys, /whether a fire is lit|whether a door stands open/, `${name}: the old ban list is gone`);
    }
    const sys = patchSys(shared);
    assert.match(sys, /DESCRIPTION RULE: write each description as if the place had always been this way: what a visitor finds there today, including visible traces of the past \("scorch marks blacken the beams", "an old brass rail shows under the gold leaf"\)\. How it came to be this way is history: leave it out of descriptions\. When the building or district as a whole changed, put it in that area's notes\./);
    assert.doesNotMatch(sys, /short append_lore on the area/, 'round 1: no area op for a one-room change');
    assert.doesNotMatch(sys, /has been replaced by|was transformed|"was once"|"now"/, 'no quoted forbidden phrases');
    // One edit of the shared entry reaches every call that uses it.
    ext.setPrompts({ ...TEXT, 'change.timeless': 'SHARED TIMELESS LINE.' });
    for (const s of [patchSys(shared), discoverSys(), rewriteSys(shared, 'full')]) assert.match(s, /SHARED TIMELESS LINE\./);
    ext.setPrompts(PROMPTS);
});
