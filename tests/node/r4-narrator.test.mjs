// R4 (prompt revision): narrator failure lines and party grammar. N2: every narrator line reads right for "You", "Ana"
// and "Ana and Hesk"; N3: failure lines and rules say what is true (anchors kept); N6: no second stay sentence;
// N8: the time-of-day nudge (narration.time_nudge) only on a move, a wait, the first narrated reply, or a new part of
// the day. The narrator tests go through the real handlers (applyFacts, the setExtensionPrompt capture).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar, gameDate } = await import('../../extension/clock.mjs');
await loadCalendar();
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const TEXT = Object.fromEntries(PROMPTS.prompts.map(e => [e.id, e.text]));
const NUDGE = TEXT['narration.time_nudge'];

const PARTIES = ['You', 'Ana', 'Ana and Hesk'];
/** (e) R4.1: the plan's bad forms: a singular verb after "You" or after a two-name party. */
const BAD = /\b(You|and \w+) (is|has|stays|looks|tries|does|was)\b/;
/** A stricter guard on the same spot: any present-tense -s verb right after the party ("You arrives", "and Hesk opens"). */
const BAD_S = /\b(You|and Hesk) (?!always\b|still\b)[a-z]+s\b/;
/** Neutral sample values, one per placeholder; a function gets the party. An unknown placeholder fails the loop. */
const SAMPLE = {
    party: p => p, place: 'the Common Room', where: 'the Stable of The Drowned Rat', from: 'the Hall', to: 'the Common Room', via: ' (out through the door)',
    direction: 'north', door: 'north door', why: 'is locked', verb: 'opened', arrival: p => ` ${p} arrived in the Stable of The Drowned Rat.`,
    cut_short: ' (the trip was cut short there)', steps: 'A slippery step.', ended: 'it lasted 1h', description: 'A narrow room.', change: 'a guest room for the night',
    excerpt: 'The innkeeper shows them a room.', options: '- hall: the Hall', default: 'hall', name: 'Hesk', activity: 'pouring drinks', line: 'The landlady.',
    lines: 'the landlady, pouring drinks', found: 'The landlady', not_found: 'the landlady', shown: 'the landlady', role: 'the landlady of the inn',
    npcs_present: 'the landlady: a big woman', npc_focus: '', lore_places: 'The Drowned Rat', lore: 'The inn is old.', said: 'The player wrote: "I look around."',
};
const fillFor = (def, party) => Object.fromEntries((def.placeholders ?? []).map(ph => {
    assert.ok(ph.name in SAMPLE, `${def.id}: add a sample value for {{${ph.name}}} to the R4 grammar table`);
    const v = SAMPLE[ph.name];
    return [ph.name, typeof v === 'function' ? v(party) : v];
}));
const narration = PROMPTS.prompts.filter(e => e.id.startsWith('narration.'));
const withParty = PROMPTS.prompts.filter(e => !e.id.startsWith('narration.') && /\{\{party\}\}/.test(e.text));

test('R4.1 (N2): every narration.* entry reads right for "You", "Ana" and "Ana and Hesk" (no hand-picked list)', () => {
    ext.setPrompts(PROMPTS);
    assert.ok(narration.length >= 30, `found ${narration.length} narration entries`);
    for (const def of narration) for (const party of PARTIES) {
        const out = ext.render(def.id, fillFor(def, party));
        assert.doesNotMatch(out, /\{\{\w+\}\}/, `${def.id}: every placeholder is filled`);
        assert.doesNotMatch(out, BAD, `${def.id} with ${party}: ${out}`);
        assert.doesNotMatch(out, BAD_S, `${def.id} with ${party}: ${out}`);
    }
});

test('R4.1 (N2): the loop fails on a placeholder it has no sample for, so a new entry gets one', () => {
    assert.throws(() => fillFor({ id: 'narration.new', placeholders: [{ name: 'brand_new' }] }, 'You'), /add a sample value for \{\{brand_new\}\}/);
});

test('N2: every other entry that names {{party}} (side calls) reads right too; the pick questions say "the player"', () => {
    ext.setPrompts(PROMPTS);
    for (const def of withParty) for (const party of PARTIES) {
        const out = ext.render(def.id, fillFor(def, party));
        assert.doesNotMatch(out, BAD, `${def.id} with ${party}: ${out}`);
    }
    for (const id of ['dig.question', 'look.target', 'look.view', 'door.pick', 'intent.question', 'intent.bracket_target', 'travel.question', 'npc.who', 'narration.expiry_pick']) {
        assert.match(TEXT[id], /^The player is (in|at) \{\{place\}\}/, id);
        assert.doesNotMatch(TEXT[id], /\{\{party\}\}/, id);
        assert.ok(!PROMPTS.prompts.find(e => e.id === id).placeholders.some(p => p.name === 'party'), `${id}: no party placeholder left`);
    }
    assert.match(TEXT['narration.expiry_pick'], /Where does the player end up\?/);
});

test('N2: the narrator lines still built in code (stay-put, every look result, the arrival text) read right for each party', () => {
    const looks = [{ kind: 'see', peek: true, via: 'north', name: 'Hall', description: 'Long.' }, { kind: 'see', through_closed: true, via: 'window', name: 'Yard', description: 'Mud.' },
        { kind: 'see', via: 'north', name: 'Hall', description: 'Long.', opened: true, sight: 'clear' }, { kind: 'threshold', via: 'north', description: 'An oak door.', unknown: true },
        { kind: 'threshold', via: 'gate', description: 'Iron.', shut: true, name: 'Yard' }, { kind: 'closed', via: 'north', stuck: 'is locked' }, { kind: 'closed', via: 'north', word: 'way' },
        { kind: 'listen', via: 'north', sound: 'clear' }, { kind: 'listen', via: 'north', sound: 'none' }, { kind: 'listen', via: 'north' }, { kind: 'nothing', via: 'north', opened: true }];
    for (const party of PARTIES) {
        const stay = ext.stayPutLine(party, 'the Hall');
        assert.equal(stay, `Everything in this reply happens in the Hall: no move happens, and the reply ends with ${party} still there.`);
        for (const l of looks) {
            const t = ext.lookText(party, 'the Hall', l);
            assert.doesNotMatch(t, BAD, t); assert.doesNotMatch(t, BAD_S, t);
            assert.match(t, new RegExp(`^What just happened: (${party} (opened|peeked|looked|listened|tried)|${party} opened)`), t);
        }
        const loc = { address: 'r:inn/stable', name: 'Stable', subregion: { name: 'The Drowned Rat', entrance: 'r:inn/common', entrance_name: 'Common Room' }, exits: [], views: [] };
        assert.match(ext.arrival(loc, { from: 'r:lane/x', to: 'r:inn/stable', direction: 'gate', prev_name: 'Market Lane' }).text, /^arrived in the Stable of The Drowned Rat, entering through the gate from Market Lane/);
    }
});

// ---- Through applyFacts: the facts block and the after-message slot.
const serverWith = (cards = [], drop = []) => { const d = tmpPath(); copytree(path.dirname(RIVERTON), d); for (const id of drop) fs.rmSync(path.join(d, 'riverton', 'cast', `${id}.json`)); for (const card of cards) fs.writeFileSync(path.join(d, 'riverton', 'cast', `${card.id}.json`), JSON.stringify(card, null, 2)); return clientDir(d); };
const server = serverWith();
function boot(who = '', srv = server) {
    exitsCache.clear();
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = srv.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    rememberWorlds(srv.get('/worlds').json());
    const c = SillyTavern.getContext();
    c.chatId = 'r4'; c.getCurrentChatId = () => 'r4';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async () => '';
    c.substituteParams = t => t;
    Object.assign(ext.settings(), { whoMoves: who, flagNpcs: false, flagTags: true, autoKeep: false, autoKeepWaits: true, weatherNumbers: false });
    c.chat = [{ is_user: false, mes: 'Welcome to the Drowned Rat.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, blocks };
}
const say = (c, mes, extra = {}) => { c.chat.push({ is_user: true, mes, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, mes, extra = {}) => { c.chat.push({ is_user: false, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra }); return c.chat.length - 1; };
const FACTS = () => ext.FACTS_KEY ?? 'worldscrawl_facts';
const REMINDER = () => ext.REMINDER_KEY ?? 'worldscrawl_reminder';
async function turn(blocks, opts) { await scene.applyFacts(opts); return { facts: blocks[FACTS()] ?? '', after: blocks[REMINDER()] ?? '' }; }
const timeLine = f => f.split('\n').find(l => l.startsWith('Current time:')) ?? '';

test('N8: the chat\'s first narrated reply gets the nudge; a plain stay in the same part of the day gets the time alone', async () => {
    const { c, blocks } = boot();
    say(c, 'I sit at the bar.');
    const first = timeLine((await turn(blocks)).facts);
    assert.match(first, /^Current time: .+\. Let the time of day show in the narration\.$/, 'first narrated reply (only the greeting before it)');
    reply(c, 'The fire crackles.');
    // A swipe of that first reply is the first narrated reply again: the nudge stays.
    assert.ok(timeLine((await turn(blocks, { type: 'swipe' })).facts).endsWith(` ${NUDGE}`), 'swipe of the first narrated reply');
    say(c, 'I sip my ale.');
    const plain = timeLine((await turn(blocks)).facts);
    assert.match(plain, /^Current time: [^\n]+\.$/);
    assert.ok(!plain.includes(NUDGE), `plain stay, same part of the day: ${plain}`);
    // A swipe of that reply is the same turn again: still no nudge.
    reply(c, 'The fire pops.');
    assert.ok(!timeLine((await turn(blocks, { type: 'swipe' })).facts).includes(NUDGE), 'swipe of a plain stay');
});

test('N8: a wait turn and a move turn get the nudge, through applyFacts', async () => {
    const { c, blocks } = boot();
    say(c, 'I sit.'); reply(c, 'You sit.');
    say(c, 'I wait half an hour.', { worldscrawl_wait: { seconds: 1800, label: 'waited 30m' } });
    const w = await turn(blocks);
    assert.ok(timeLine(w.facts).endsWith(` ${NUDGE}`), `wait turn: ${timeLine(w.facts)}`);
    assert.match(w.facts, /What just happened: You waited here for 30m, staying put\./, 'the wait line (code) is past tense');
    reply(c, 'Time passes.');
    const m = c.chat[say(c, '[move] out')];
    await bracketIntent(m, parseBracket(m.mes));
    assert.ok(m.extra.worldscrawl_move, 'moved');
    const mv = await turn(blocks);
    assert.ok(timeLine(mv.facts).endsWith(` ${NUDGE}`), `move turn: ${timeLine(mv.facts)}`);
    assert.match(mv.facts, /What just happened: You moved out from .+ to Village Square \(Riverton Streets\)\. You arrived in Village Square\./);
    assert.match(mv.after, /^\[At the end of this reply the characters are in Village Square, and the reply ends there\./);
    assert.doesNotMatch(mv.after, /Do not narrate/);
});

test('N8: a stay turn where the morning became the afternoon (a wait the tracker read from the last reply) gets the nudge; the next stay does not', async () => {
    const { c, blocks } = boot();
    say(c, 'I sit.'); reply(c, 'You sit.');
    const before = gameDate(c.chat).part;
    say(c, 'I nurse my ale.');
    reply(c, 'Hours drift by as you nurse your ale.', { worldscrawl_wait: { seconds: 5 * 3600, label: 'waited 5h', source: 'tracker' } });
    const after = gameDate(c.chat).part;
    assert.notEqual(before, after, `the part of the day changed (${before} -> ${after})`);
    say(c, 'I stretch.');
    const t = await turn(blocks);
    assert.ok(timeLine(t.facts).endsWith(` ${NUDGE}`), `new part of the day: ${timeLine(t.facts)}`);
    assert.doesNotMatch(t.facts, /What just happened: You waited/, 'not a wait turn: the wait was the last reply\'s');
    reply(c, 'You stretch.');
    say(c, 'I yawn.');
    assert.ok(!timeLine((await turn(blocks)).facts).includes(NUDGE), 'same part of the day as the last reply was written in');
});

test('N8: the nudge is its own entry: an override changes the words, the condition stays in code', async () => {
    const { c, blocks } = boot();
    ext.setPrompts({ ...TEXT, 'narration.time_nudge': 'SHOW THE HOUR.' });
    say(c, 'I sit at the bar.');
    assert.match(timeLine((await turn(blocks)).facts), /\. SHOW THE HOUR\.$/);
    reply(c, 'Fine.'); say(c, 'I wait.');
    assert.doesNotMatch((await turn(blocks)).facts, /SHOW THE HOUR|Let the time of day show/);
    ext.setPrompts(PROMPTS);
});

test('N3 + N6 through applyFacts: look-around has one stay line; rules, exits hint and stay-put say what is true', async () => {
    const { c, blocks } = boot('Ana and Bo');
    say(c, 'We look around.');
    const { facts } = await turn(blocks);
    assert.match(facts, /^What just happened: Ana and Bo looked around Common Room \(The Drowned Rat\)\.$/m);
    assert.equal(facts.split('\n').filter(l => /still there|stays here|stays at/.test(l)).length, 1, 'N6: only the stay-put line');
    assert.match(facts, /^Everything in this reply happens in Common Room \(The Drowned Rat\): no move happens, and the reply ends with Ana and Bo still there\.$/m);
    assert.match(facts, /For an exit whose destination is not given, describe only the exit itself; where it leads stays unknown\./);
    assert.match(facts.split('\n').at(-1), /^Use only the locations and exits listed above; if a character tries some other way out, show why it does not work\.$|^Write only the narration\. Only the story's moves take Ana and Bo to another location/);
    assert.doesNotMatch(facts, /\bDo not (invent|describe|hint)|do not hint or guess|Ana and Bo (is|has|stays|looks|tries|does|was)\b/);
});

test('N3 + N2 through applyFacts: a failed break-through and a stuck door say FAILED / still shut, with a two-name party read right ("Ana and Bo": Hesk is a saved person, masked in the block)', async () => {
    const { c, blocks } = boot('Ana and Bo');
    say(c, 'We smash the wall.', { worldscrawl_dig_failed: true });
    const dig = await turn(blocks);
    assert.match(dig.after, /^What just happened: Ana and Bo tried to break through, but it FAILED: nothing gave way, and no new opening or passage exists\. Show the blow landing and the wall, floor or window holding: it stays whole, and this reply ends with Ana and Bo still at Common Room \(The Drowned Rat\)\.$/m);
    assert.doesNotMatch(dig.after, /Do not create|Ana and Bo is/);
    reply(c, 'The wall holds.');
    say(c, 'We open the back door.', { worldscrawl_door: { type: 'stuck', direction: 'back', why: 'is locked' } });
    const door = await turn(blocks);
    assert.match(door.after, /^What just happened: Ana and Bo tried to open the door \(back\), but it is locked\. Show the door \(back\) holding fast: nothing beyond it can be seen or reached, and this reply ends with it still shut and Ana and Bo still at Common Room \(The Drowned Rat\)\.$/m);
    reply(c, 'Locked.');
    say(c, 'We go back.', { worldscrawl_door: { type: 'stuck', direction: 'back', why: 'is locked', attempt: 'move' } });
    const move = await turn(blocks);
    assert.match(move.after, /^What just happened: Ana and Bo tried to go through the door \(back\), but it is locked\. Show the door \(back\) holding fast and nobody passing through it: this reply ends with it still shut and Ana and Bo still at Common Room \(The Drowned Rat\)\.$/m);
    assert.doesNotMatch(`${dig.after}\n${door.after}\n${move.after}`, /\bDo not\b/);
});

test('N6 + N2: a door opened or closed is told in the past tense, with no stay sentence of its own', async () => {
    const { c, blocks } = boot('Ana');
    say(c, 'I close the back door.', { worldscrawl_door: { type: 'close_door', direction: 'back' } });
    const { facts } = await turn(blocks);
    assert.match(facts, /^What just happened: Ana closed the door \(back\)\.$/m);
    assert.equal(facts.split('\n').filter(l => /still there|stays at/.test(l)).length, 1);
});

// Round 1 (Ast): absentAt through the real handlers, not a regex over the source. Pell fiddles in the Common Room in the
// evening and works the forge by day, so at the 08:00 start she belongs here but is elsewhere (a placed entry, not off the map).
const FORGE = 'riverton:smithy/forge';
const PELL = { id: 'pell', name: 'Pell', personality: { summary: 'The evening fiddler.' }, schedule: [
    { place: FORGE, activity: 'working the bellows', from: '06:00', to: '17:00' },
    { place: TAVERN, activity: 'fiddling', from: '18:00', to: '23:00' },
] };

test('N3 (round 1): absentAt on an absent scheduled person returns "is elsewhere right now" and fires onOffmap', async () => {
    const { absentAt } = await import('../../extension/npc.mjs');
    const { validateRecord } = await import('../../plugin/npc.mjs');
    const pell = validateRecord(PELL, { file: 'pell.json' });
    assert.equal(pell.ok, true);
    const env = { exists: () => true, relocate: {}, names: a => ({ [FORGE]: 'the forge' })[a] ?? a, playerAt: () => TAVERN,
        clock: () => ({ day: 1, hour: 8, minute: 0, minutes: 480, elapsed: 86400 + 8 * 3600 }) };
    let fired = 0;
    const lines = absentAt([{ mes: 'I sit at the bar.', is_user: true, extra: {} }], 0, [pell], env, { present: [], onOffmap: () => { fired++; } });
    assert.deepEqual(lines, ['Pell is elsewhere right now (working the bellows, the forge).']);
    assert.equal(fired, 1, 'the absent line raises the elsewhere rule');
    assert.doesNotMatch(lines.join('\n'), /do not portray/i);
});

test('N3 (round 1): through applyFacts, an absent scheduled person is "elsewhere right now" and the positive elsewhere rule follows', async () => {
    // Hesk is left out: her 08:00 entry is off the map and would raise the elsewhere rule on its own.
    const { c, blocks } = boot('', serverWith([PELL], ['hesk']));
    say(c, 'I sit at the bar.');
    const { facts } = await turn(blocks);
    const all = Object.values(blocks).join('\n');
    assert.deepEqual(facts.split('\n').filter(l => /elsewhere/.test(l)), ["Pell is elsewhere right now (working the bellows, Brask's Smithy).", TEXT['narration.offmap_found']], facts);
    assert.ok(facts.includes(TEXT['narration.offmap_found']), facts);
    assert.equal(TEXT['narration.offmap_found'], '(Anyone above who is elsewhere is not with the characters; they stay out of the scene until they actually come here.)');
    assert.doesNotMatch(all, /do not portray/i);
    assert.doesNotMatch(all, /Do not narrate them/);
});

test('round 1: narration.rules opens "Write only the narration." (no "You" for the narrator); rules_tools has no "You" either', () => {
    ext.setPrompts(PROMPTS);
    for (const party of PARTIES) {
        const out = ext.render('narration.rules', { party });
        assert.match(out, new RegExp(`^Write only the narration\\. Only the story's moves take ${party} to another location`));
    }
    assert.doesNotMatch(TEXT['narration.rules'], /\bYou\b/);
    assert.doesNotMatch(TEXT['narration.rules_tools'], /\bYou\b/);
});

test('rev 6 check: the group 4 not-found line (N3) and the wait-amount until rule (W1) still match rev 6', () => {
    const nf = TEXT['narration.npc_not_found'];
    assert.match(nf, /is somewhere else, and this reply ends without them\. Show the search coming up empty\./);
    assert.doesNotMatch(nf, /no voice|no glimpse|does not appear/);
    assert.match(TEXT['intent.wait_amount_system'], /until: a time of day as HH:MM on a 24-hour clock, to the minute the text gives \("17:15" for a quarter past five in the afternoon; never rounded\)/);
});
