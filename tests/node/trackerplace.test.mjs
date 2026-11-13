// B2: the after-reply tracker reports only lasting physical place changes. Driven through the real handlers
// (onReplyForFlags -> runTracker -> applyTrackerResult) with a fake model answering the tracker.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, SQUARE, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const T = await import('../../extension/tracker.mjs');
const { answeredPlayerIndex, turnStartOf } = await import('../../extension/generations.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const LOC = 'worldscrawl_location', FLAG = 'worldscrawl_flag';

function boot(place) {
    exitsCache.clear();
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    rememberWorlds(server.get('/worlds').json());
    const c = SillyTavern.getContext();
    c.chatId = 'trk'; c.getCurrentChatId = () => 'trk';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    const calls = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? '');
        calls.push(prompt);
        if (/Reply with JSON only:\n\{"place"/.test(prompt)) return JSON.stringify({ place, people: [], wait: null });
        return '';
    };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, [LOC]: TAVERN } }];
    return { c, calls };
}
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, text, extra = {}) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }); return c.chat.length - 1; };
/** Let a kept card's map-change call finish before the next test boots (it would otherwise answer into the next chat). */
const settle = async c => { for (let i = 0; i < 100 && c.chat.some(m => m.extra?.[FLAG]?.status === 'working'); i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 50)); };
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const trackerPromptOf = calls => calls.find(p => /Reply with JSON only:\n\{"place"/.test(p)) ?? '';
const analyzeCalls = calls => calls.filter(p => !/Reply with JSON only:\n\{"place"/.test(p));

// ---- Passing scene state is not a place change.
const MORNING = { changed: true, kind: 'change', note: 'morning light fills the room; the fire has burned down to embers; the back door stands ajar', rewrite: 'light', why: 'door status updated' };

test('morning light, embers and a door ajar: no card, a note says why, the marker ends tracked', async () => {
    const { c, calls } = boot(MORNING);
    say(c, 'I wake and come downstairs.');
    const id = reply(c, 'Morning light slants through the shutters. The fire has burned down to embers, and the back door stands ajar.');
    await onReplyForFlags(id);
    const m = c.chat[id];
    assert.equal(m.extra[FLAG], undefined, 'no place card');
    assert.ok(notes(m).some(n => n.kind === 'tracker place' && n.status === 'skipped' && /only passing scene state/.test(n.reason)), JSON.stringify(notes(m)));
    assert.equal(m.extra[T.TRACKED_KEY]?.status, 'tracked');
    assert.deepEqual(analyzeCalls(calls), [], 'no map-change call');
});

test('the same morning with a real change mixed in keeps the card', async () => {
    const { c } = boot({ ...MORNING, note: `${MORNING.note}; the bar is smashed`, why: 'the bar was smashed' });
    say(c, 'I smash the bar with a chair.');
    const id = reply(c, 'Morning light slants in. The chair splinters the bar top.');
    await onReplyForFlags(id);
    const f = c.chat[id].extra[FLAG];
    assert.ok(f, 'a place card');
    assert.equal(f.source, T.TRACKER_SOURCE);
    assert.ok(!notes(c.chat[id]).some(n => n.kind === 'tracker place'));
    await settle(c);
});

// ---- Arriving by an exit is not a discovery (the Storage Nook).
const ENTERS = { changed: true, kind: 'discover', note: 'player enters the square from the inn' };

test('a discover after the player moved this turn (move on the player line) is dropped: no discovery call, no new room', async () => {
    const { c, calls } = boot(ENTERS);
    say(c, 'I go out to the square.', { [LOC]: SQUARE });
    const id = reply(c, 'You step out into the cobbled square.');
    await onReplyForFlags(id);
    assert.equal(c.chat[id].extra[FLAG], undefined);
    assert.ok(notes(c.chat[id]).some(n => n.kind === 'tracker place' && /arrival by an exit/.test(n.reason)));
    assert.deepEqual(analyzeCalls(calls), []);
    assert.equal(c.chat[id].extra.worldscrawl_patches, undefined);
});

test('the reply itself carrying the move (ws_move in tools mode, or a told expiry with no player line) counts as moved', async () => {
    let { c } = boot(ENTERS);
    say(c, 'I head outside.');
    let id = reply(c, 'You step out into the square.', { [LOC]: SQUARE }); // ws_move stamps the reply
    await onReplyForFlags(id);
    assert.equal(c.chat[id].extra[FLAG], undefined, 'tools-mode move');
    ({ c } = boot(ENTERS));
    reply(c, 'The stall folds up around you.');
    c.chat.push({ is_user: false, is_system: true, mes: '[a notice]', extra: { worldscrawl_notice: true } });
    id = reply(c, 'The stall is gone; you stand in the square.', { [LOC]: SQUARE }); // an automatic expiry reply
    assert.equal(answeredPlayerIndex(c.chat, id), -1, 'it answers no player line');
    assert.equal(turnStartOf(c.chat, id), id);
    await onReplyForFlags(id);
    assert.equal(c.chat[id].extra[FLAG], undefined, 'automatic expiry reply');
});

test('moving and opening a door on the same line still discovers; no move at all still discovers', async () => {
    let { c } = boot(ENTERS);
    say(c, 'I go out to the square and open the shed door.', { [LOC]: SQUARE });
    let id = reply(c, 'The shed door creaks open on a dusty little room.');
    await onReplyForFlags(id);
    assert.ok(c.chat[id].extra[FLAG], 'kept: the player opened a door');
    assert.ok(!notes(c.chat[id]).some(n => n.kind === 'tracker place'));
    await settle(c);
    ({ c } = boot(ENTERS));
    say(c, 'I try the little door behind the bar.');
    id = reply(c, 'It opens on a cramped storeroom.');
    await onReplyForFlags(id);
    assert.ok(c.chat[id].extra[FLAG], 'kept: nobody moved');
    await settle(c);
});

test('answeredPlayerIndex finds the player line after the reply is in (turnPlayerIndex cannot)', () => {
    const chat = [{ is_user: false, mes: 'a' }, { is_user: true, mes: 'b' }, { is_system: true, is_user: false, mes: 'n', extra: { worldscrawl_notice: true } }, { is_user: false, mes: 'c' }];
    assert.equal(answeredPlayerIndex(chat, 3), 1);
    assert.equal(answeredPlayerIndex(chat, 0), -1);
});

// ---- The tracker sees the exits; the prompt says what place is for.
test('the tracker prompt lists the exits and the never-for list', async () => {
    const { c, calls } = boot(null);
    say(c, 'I look around.');
    await onReplyForFlags(reply(c, 'The common room is quiet.'));
    const p = trackerPromptOf(calls);
    assert.match(p, /^Exits: out \(Village Square\), up \(Upstairs Rooms\), back \(Courtyard\)$/m);
    assert.match(p, /place is only for a lasting physical change to the place itself/);
    assert.match(p, /Never set place for the light or time of day, the weather, a fire being lit, banked or burning down, smells, sounds, mood, people coming and going, or a door being opened, closed or left ajar/);
    assert.match(p, /Arriving, entering or leaving by a listed exit is never a discovery\./);
    const style = id => PROMPTS.prompts.find(e => e.id === id).text;
    assert.match(style('change.style'), /Descriptions and notes are timeless/);
    assert.match(style('discover.style'), /Descriptions are timeless/);
});

// ---- Pure pieces.
test('transientOnly: every clause passing, none lasting', () => {
    for (const n of [MORNING.note, 'the room smells of smoke', 'the door is open', 'lamps lit; evening falls'])
        assert.equal(T.transientOnly(n), true, n);
    for (const n of [`${MORNING.note}; the bar is smashed`, 'the back door is barred', 'the fire spreads to the curtains', 'a hole in the wall', 'the cellar floods', 'boards nailed over the window', ''])
        assert.equal(T.transientOnly(n), false, n);
});

test('readPlace: a why that only says "status updated" is dropped, a real why kept', () => {
    assert.equal(T.readPlace({ changed: true, note: 'x', rewrite: 'light', why: 'door status updated' }).why, undefined);
    assert.equal(T.readPlace({ changed: true, note: 'x', rewrite: 'light', why: 'updated' }).why, undefined);
    assert.equal(T.readPlace({ changed: true, note: 'x', rewrite: 'light', why: 'the bar was smashed' }).why, 'the bar was smashed');
});
