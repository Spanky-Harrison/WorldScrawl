// 4-WN part W: wait-time words ("quarter past five", "5.15 pm", "17h15"); an hour with no am/pm takes the next one;
// a wait until now (a clock time or the part of the day it already is) is the hidden error; "tomorrow ..." asks for
// the next one; the story's one until-time wins within 30 minutes of the tracker's. Through the real handlers: the
// generation interceptor with a typed [wait], /ws-wait (waitCommand), onReplyForFlags -> tracker -> applyTrackerResult.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, clientDir, isTrackerCall } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const D = await import('../../extension/discovery.mjs');
const W = await import('../../extension/waits.mjs');
const { parseWaitTag, waitArgs } = await import('../../extension/words.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const CLK = await import('../../extension/clock.mjs');
const { rememberWorlds, loadCalendar, chatElapsed, worldTimes } = CLK;
await loadCalendar();
const calendarLib = CLK.calendarLib; // set by loadCalendar (a live binding: read it after)
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const server = clientDir(path.dirname(RIVERTON));
const WAIT = 'worldscrawl_wait';

let n = 0;
/** A fresh chat at the start time (before 17:00). `tracker` is the tracker's JSON answer; every model call is recorded. */
function boot({ tracker = { place: null, people: [], wait: null }, autoKeepWaits = true, time = '08:00', model = '{"until": "17:00"}', hours = 24 } = {}) {
    exitsCache.clear();
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) { w.start_date = { ...w.start_date, time }; if (hours !== 24) w.calendar = { ...calendarLib.GREGORIAN, hours_per_day: hours }; } // 5C B6: a short-day world, built in-process
    rememberWorlds(worlds);
    const c = SillyTavern.getContext(), id = `wn${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = () => {};
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    const calls = [];
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? '');
        calls.push(prompt);
        if (isTrackerCall(args)) return JSON.stringify(tracker);
        if (/How long is this wait\?/.test(prompt)) return model; // by default a model that rounds to the hour
        return '{}';
    };
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async cmd => { c.chat.push({ is_user: true, mes: cmd.replace(/^\/send /, ''), swipe_id: 0, extra: {} }); };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits, moveMode: 'buttons' });
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, calls };
}
const clock = c => { const t = worldTimes.get('riverton'); return calendarLib.dateAt(chatElapsed(c.chat), t?.start_date ?? null, t?.calendar ?? null).time; };
const asked = calls => calls.filter(p => /How long is this wait\?/.test(p)).length;
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
const intercept = () => globalThis.worldscrawlInterceptor([], 0, () => {}, 'normal');
const notes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();

const day = c => { const t = worldTimes.get('riverton'); return calendarLib.dateAt(chatElapsed(c.chat), t?.start_date ?? null, t?.calendar ?? null).day; };
/** Type `text` as the player's turn and run the generation interceptor on it (the real bracket path). */
async function typed(c, text) { const p = say(c, text); await intercept(); return c.chat[p]; }
const hidden = m => m.is_system === true && m.extra?.worldscrawl_cmd?.failed === true;

// ---------------------------------------------------------------- the reader
test('wait-time words: each form reads as its clock time (an hour with two readings carries both)', () => {
    const P = t => { const { until, alt, tomorrow } = calendarLib.parseWait(t); return [until, alt ?? null, !!tomorrow]; };
    const table = [
        ['until 5.15 pm', '17:15', null], ['until 5:15 PM', '17:15', null], ['until 5:15pm', '17:15', null], ['until 5 pm', '17:00', null],
        ['until 9 am', '09:00', null], ['until 12 am', '00:00', null], ['until 12 pm', '12:00', null],
        ['until 17h15', '17:15', null], ['until 1715', '17:15', null], ['until 0930', '09:30', null], ['until 17:15', '17:15', null], ['until 05:15', '05:15', null],
        ['until a quarter past five', '05:15', '17:15'], ['until quarter past 5', '05:15', '17:15'], ['until half past five', '05:30', '17:30'],
        ['until a quarter to six', '05:45', '17:45'], ['until quarter to one', '12:45', '00:45'], ["until five o'clock", '05:00', '17:00'],
        ['until five', '05:00', '17:00'], ['until 9', '09:00', '21:00'], ['until 9:30', '09:30', '21:30'], ['until twelve', '12:00', '00:00'],
        ['until 5:15 in the evening', '17:15', null], ['until half past eight in the morning', '08:30', null], ['until 9 tonight', '21:00', null], ['until ten at night', '22:00', null],
        ['until the evening', 'evening', null], ['until sundown', 'dusk', null], ['until nightfall', 'dusk', null], ['until sunup', 'dawn', null],
        ['until first light', 'dawn', null], ['until daybreak', 'dawn', null], ['until tonight', 'night', null], ['until afternoon', 'afternoon', null],
        ['till 17:15 and eat', '17:15', null], ['17h15', '17:15', null], ['5:15 pm', '17:15', null],
    ];
    for (const [t, until, alt] of table) assert.deepEqual(P(t), [until, alt, false], t);
    assert.deepEqual(P('until tomorrow morning'), ['morning', null, true]);
    assert.deepEqual(P('until tomorrow at 9:30'), ['09:30', null, true], 'tomorrow takes the time as written (no second reading)');
    for (const bad of ['until 5 hours', 'until twenty', 'until 25:00', 'until 2400', 'until tomorrow']) assert.throws(() => calendarLib.parseWait(bad), /say the time like|outside the day|past the end of this world's 24-hour day/, bad); // 5C B6: an hour past the day says so
});
test('the reader on a line: every until-time, the next reading of an ambiguous hour, no day-part words or tomorrow', () => {
    const at = (h, m = 0) => h * 3600 + m * 60;
    assert.deepEqual(calendarLib.untilClocksIn('I wait until a quarter past five, then till 9.', undefined, { now: at(14) }), ['17:15', '21:00']);
    assert.deepEqual(calendarLib.untilClocksIn('I wait until 9:30.', undefined, { now: at(9, 31) }), ['21:30']);
    assert.deepEqual(calendarLib.untilClocksIn('I wait until 9:30.', undefined, { now: at(3) }), ['09:30']);
    assert.deepEqual(calendarLib.untilClocksIn('Wait until 9:30', undefined, { now: at(9, 30) }), ['21:30'], 'the one right now is never next');
    assert.deepEqual(calendarLib.untilClocksIn('Rest until evening, or until tomorrow at nine.'), []);
    assert.deepEqual(calendarLib.untilClocksIn('The ship leaves at nine.'), [], 'no until: not a wait time');
    assert.equal(calendarLib.untilClockIn('until 17:15 or until 5:15 pm'), '17:15');
    assert.deepEqual(calendarLib.untilClocksIn('until 17:15 or until 5:15 pm'), ['17:15'], 'the same time twice counts once');
});

// ---------------------------------------------------------------- the next 9:30
for (const now of ['09:30', '21:30']) {
    test(`at ${now}, a typed [wait] until 9:30 is the same-minute error (hidden, the clock unchanged), never a 12 or 24 hour wait`, async () => {
        const { c, calls } = boot({ time: now });
        const m = await typed(c, 'I [wait] until 9:30');
        assert.ok(hidden(m), JSON.stringify(m.extra));
        assert.match(m.extra.worldscrawl_cmd.error, new RegExp(`it is already ${now}; say how long or a later time`));
        assert.equal(clock(c), now);
        assert.equal(m.extra[WAIT], undefined);
        assert.equal(asked(calls), 0);
        assert.equal(await ext.waitCommand('until 9:30'), `it is already ${now}; say how long or a later time`, '/ws-wait: the same');
        assert.equal(clock(c), now);
    });
}
test('at 09:31 "until 9:30" waits until 21:30 the same day; at 08:00 until 09:30', async () => {
    { const { c } = boot({ time: '09:31' }); const d0 = day(c); await typed(c, 'I [wait] until 9:30'); assert.equal(clock(c), '21:30'); assert.equal(day(c), d0); }
    { const { c } = boot({ time: '08:00' }); await typed(c, 'I [wait] until 9:30'); assert.equal(clock(c), '09:30'); }
});
test('[wait] until a quarter past five at 14:00 lands on 17:15 with no model call', async () => {
    const { c, calls } = boot({ time: '14:00' });
    const m = await typed(c, 'I [wait] until a quarter past five');
    assert.equal(m.extra[WAIT]?.until, '17:15', JSON.stringify(m.extra[WAIT]));
    assert.equal(clock(c), '17:15');
    assert.equal(asked(calls), 0);
});
test('"5.15 pm" and "17h15" land on 17:15', async () => {
    for (const t of ['I [wait] until 5.15 pm', 'I [wait] until 17h15']) { const { c } = boot({ time: '14:00' }); await typed(c, t); assert.equal(clock(c), '17:15', t); }
});

// ---------------------------------------------------------------- the tracker and the story's clock
const coach = { place: null, people: [], wait: { duration: '', until: '17:00', sleep: false, reason: 'waiting for the coach' } };
async function trackerTurn({ line, story, tracker = coach, time = '14:00', hours = 24 }) {
    const { c, calls } = boot({ tracker, time, hours });
    say(c, line, { worldscrawl_intent_checked: true });
    const id = reply(c, story);
    await D.onReplyForFlags(id);
    return { c, calls, id, n: notes(c.chat[id]).filter(x => x.kind === 'tracker wait') };
}
test('typed "I wait until half past five" (no bracket): the tracker reads 17:00; the player\'s 17:30 wins, with a note', async () => {
    const { c, n } = await trackerTurn({ line: 'I wait until half past five.', story: 'The afternoon drags.' });
    assert.equal(clock(c), '17:30');
    assert.ok(n.some(x => x.reason === "until 17:30 from the player's line (the tracker read until 17:00)"), JSON.stringify(n));
});
test('the reply\'s one until-time within 30 minutes of the tracker\'s wins, with a note', async () => {
    const { c, id, n } = await trackerTurn({ line: 'I wait for the coach.', story: 'You wait by the window until a quarter past five, when the coach finally rattles in.' });
    assert.equal(c.chat[id].extra[WAIT]?.until, '17:15');
    assert.equal(clock(c), '17:15');
    assert.ok(n.some(x => x.reason === 'until 17:15 from the reply (the tracker read until 17:00)'), JSON.stringify(n));
});
test('the reply\'s time across midnight counts the short way round (23:50 vs 00:10)', async () => {
    const { c } = await trackerTurn({ line: 'I wait for the night watch.', story: 'You keep watch until 00:10.', tracker: { ...coach, wait: { ...coach.wait, until: '23:50' } } });
    assert.equal(clock(c), '00:10');
});
for (const [what, story] of [
    ['no until-time ("The ship leaves at nine")', 'The ship leaves at nine. You wait for the coach.'],
    ['two until-times', 'You wait until 17:15, then until 17:20 for the second coach.'],
    ['one more than 30 minutes away', 'You wait until a quarter to six for the coach.'],
]) {
    test(`the reply with ${what}: the tracker's 17:00 stands, no note`, async () => {
        const { c, n } = await trackerTurn({ line: 'I wait for the coach.', story });
        assert.equal(clock(c), '17:00');
        assert.deepEqual(n, []);
    });
}
test('a day-part word from the tracker is not adjusted by the reply\'s clock time', async () => {
    const { c } = await trackerTurn({ line: 'I wait for the evening.', story: 'You wait until 17:15.', tracker: { ...coach, wait: { ...coach.wait, until: 'evening' } } });
    assert.equal(clock(c), '17:00');
});

// ---------------------------------------------------------------- the model's guess
test('an amount the parser can\'t read that names minutes: a model answer on the hour is unreadable (error, hidden, clock unchanged)', async () => {
    const { c, calls } = boot({ time: '14:00' });
    const m = await typed(c, 'I [wait] a quarter-ish past five');
    assert.equal(asked(calls), 1, 'one model call, with its own status');
    assert.ok(hidden(m), JSON.stringify(m.extra));
    assert.equal(clock(c), '14:00');
    const n = notes(m).filter(x => x.kind === 'wait amount');
    assert.equal(n.length, 1, 'one call note');
    assert.deepEqual([n[0].status, n[0].answer, n[0].reason], ['failed', '{"until": "17:00"}', 'the answer 17:00 is on the hour, but the amount names minutes'], 'the rejected answer shows as failed, not ok');
    assert.match(m.extra.worldscrawl_cmd.error, /wait must look like .*got "quarter-ish past five"/, 'the parser\'s own error stands');
});
test('the same amount with a model answer to the minute is kept', async () => {
    const { c } = boot({ time: '14:00', model: '{"until": "17:15"}' });
    const m = await typed(c, 'I [wait] a quarter-ish past five');
    assert.equal(clock(c), '17:15');
    assert.equal(notes(m).find(x => x.kind === 'wait amount')?.status, 'ok');
});

// ---------------------------------------------------------------- parts of the day
test('"until morning" during the morning is the hidden error; "until tomorrow morning" waits for the next one', async () => {
    {
        const { c } = boot({ time: '10:00' });
        const m = await typed(c, 'I [wait] until morning');
        assert.ok(hidden(m));
        assert.match(m.extra.worldscrawl_cmd.error, /it is already morning; say how long or a later time/);
        assert.equal(clock(c), '10:00');
    }
    {
        const { c } = boot({ time: '10:00' });
        const d0 = day(c);
        const m = await typed(c, 'I [wait] until tomorrow morning');
        assert.equal(day(c), d0 + 1);
        assert.ok(clock(c) < '10:00' && clock(c) >= '05:00', clock(c));
        assert.equal(m.extra[WAIT]?.until, 'tomorrow morning');
    }
});
test('"until evening" at 18:30 is the same error; at 16:00 it waits one hour', async () => {
    {
        const { c } = boot({ time: '18:30' });
        const m = await typed(c, 'I [wait] until evening');
        assert.match(m.extra.worldscrawl_cmd?.error ?? '', /it is already evening/);
        assert.equal(clock(c), '18:30');
    }
    { const { c } = boot({ time: '16:00' }); const m = await typed(c, 'I [wait] until evening'); assert.equal(m.extra[WAIT]?.seconds, 3600); assert.equal(clock(c), '17:00'); }
    { const { c } = boot({ time: '13:00' }); assert.match(await ext.waitCommand('until afternoon'), /it is already afternoon/); assert.equal(clock(c), '13:00'); }
});
test('a tracker wait "until evening" at 17:20: already evening, no time passes, no card', async () => {
    const { c, id } = await trackerTurn({ line: 'I wait a bit.', story: 'The lamps are lit.', time: '17:20', tracker: { ...coach, wait: { ...coach.wait, until: 'evening' } } });
    assert.equal(clock(c), '17:20');
    assert.equal(c.chat[id].extra[WAIT], undefined);
    assert.equal(c.chat[id].extra.worldscrawl_waitcard, undefined);
    assert.ok(notes(c.chat[id]).some(x => /no time \(already evening\)/.test(x.kind) && x.status === 'skipped'), JSON.stringify(notes(c.chat[id])));
});

// ---------------------------------------------------------------- noon and midnight are clock points (review round 1)
test('"until midnight" at exactly 00:00: the same-minute error for the player (hidden, clock unchanged), no time for the narrator; never a 24-hour wait', async () => {
    {
        const { c } = boot({ time: '00:00' });
        const m = await typed(c, 'I [wait] until midnight');
        assert.ok(hidden(m), JSON.stringify(m.extra));
        assert.match(m.extra.worldscrawl_cmd.error, /it is already 00:00; say how long or a later time/);
        assert.equal(clock(c), '00:00');
        assert.equal(await ext.waitCommand('until midnight'), 'it is already 00:00; say how long or a later time');
        const w = await W.planWait('until midnight', false, 'the bells', { narrator: true });
        assert.deepEqual([w.seconds, w.passed, w.label], [0, true, 'no time (already 00:00)']);
    }
    {
        const { c, id } = await trackerTurn({ line: 'I keep watch.', story: 'The bells ring out.', time: '00:00', tracker: { ...coach, wait: { ...coach.wait, until: 'midnight' } } });
        assert.equal(clock(c), '00:00');
        assert.equal(c.chat[id].extra[WAIT], undefined);
        assert.equal(c.chat[id].extra.worldscrawl_waitcard, undefined, 'no card');
    }
    { const { c } = boot({ time: '00:01' }); const d0 = day(c); await typed(c, 'I [wait] until midnight'); assert.equal(clock(c), '00:00'); assert.equal(day(c), d0 + 1, 'a minute past: the next midnight'); }
    { const { c } = boot({ time: '23:00' }); const d0 = day(c); const m = await typed(c, 'I [wait] until midnight'); assert.equal(m.extra[WAIT]?.seconds, 3600); assert.equal(day(c), d0 + 1); }
});
test('"until noon" is a clock point: during the afternoon it waits for the next noon; at exactly 12:00 it is the same-minute error; in the morning it waits for today\'s', async () => {
    { const { c } = boot({ time: '13:00' }); const d0 = day(c); const m = await typed(c, 'I [wait] until noon'); assert.equal(m.extra[WAIT]?.seconds, 23 * 3600); assert.equal(clock(c), '12:00'); assert.equal(day(c), d0 + 1); }
    { const { c } = boot({ time: '12:00' }); const m = await typed(c, 'I [wait] until noon'); assert.match(m.extra.worldscrawl_cmd?.error ?? '', /it is already 12:00/); assert.equal(clock(c), '12:00'); }
    { const { c } = boot({ time: '11:00' }); await typed(c, 'I [wait] until noon'); assert.equal(clock(c), '12:00'); }
    { const w = (boot({ time: '13:00' }), await W.planWait('until noon', false, '', { narrator: true })); assert.equal(w.seconds, 23 * 3600, 'the narrator too: an hour past noon is not "no time"'); }
});
test('only morning, afternoon, evening and night are parts of the day', () => {
    boot({ time: '00:00' });
    const w = worldTimes.get('riverton'), now = (t, h) => calendarLib.untilPartNow(h * 3600, t, w.start_date, w.calendar);
    assert.deepEqual(['morning', 'afternoon', 'evening', 'night'].map(t => [now(t, 10), now(t, 13), now(t, 18), now(t, 23), now(t, 3)]),
        [[true, false, false, false, false], [false, true, false, false, false], [false, false, true, false, false], [false, false, false, true, true]]);
    for (const t of ['noon', 'midnight', 'dawn', 'dusk', '09:30']) for (const h of [0, 6, 12, 19]) assert.equal(now(t, h), false, `${t} at ${h}`);
});

// ---------------------------------------------------------------- the prompt
test('the wait-amount prompt asks for HH:MM on a 24-hour clock to the minute, and lists afternoon', () => {
    const e = PROMPTS.prompts.find(p => p.id === 'intent.wait_amount_system');
    assert.match(e.text, /until: a time of day as HH:MM on a 24-hour clock, to the minute the text gives \("17:15" for a quarter past five in the afternoon; never rounded\), or one of dawn, morning, noon, afternoon, dusk, evening, night, midnight\./);
});

// ---------------------------------------------------------------- 5C B6: the story clock uses the world's calendar
const CAL20 = { ...calendarLib.GREGORIAN, hours_per_day: 20 };
const until = (u, reason = 'waiting') => ({ place: null, people: [], wait: { duration: '', until: u, sleep: false, reason } });
const storyNotes = (c, id) => notes(c.chat[id]).filter(x => x.kind === 'story clock');
test('5C B6 (1, 2c): on a 20-hour day "I wait until 9:30" at 19:00 reads 09:30 (no 21:30), and the wait ends at 09:30 the next day', async () => {
    assert.deepEqual(calendarLib.untilClocksIn('until 9:30', CAL20, { now: 19 * 3600 }), ['09:30'], 'one reading: 21:30 is not a time that day has');
    assert.deepEqual(calendarLib.untilClocksIn('until 9:30', calendarLib.GREGORIAN, { now: 19 * 3600 }), ['21:30'], 'a 24-hour day still takes the next one');
    const { c, id, n } = await trackerTurn({ line: 'I wait until 9:30.', story: 'You doze by the fire.', tracker: until('09:00'), time: '19:00', hours: 20 });
    const d0 = calendarLib.dateAt(0, worldTimes.get('riverton').start_date, worldTimes.get('riverton').calendar).day;
    assert.equal(c.chat[id].extra[WAIT]?.until, '09:30', JSON.stringify(c.chat[id].extra[WAIT]));
    assert.equal(clock(c), '09:30');
    assert.equal(day(c), d0 + 1, 'the next day');
    assert.equal(c.chat[id].extra[WAIT].seconds, (20 - 19) * 3600 + 9.5 * 3600, 'a 20-hour day: 14h30m');
    assert.ok(n.some(x => x.reason === "until 09:30 from the player's line (the tracker read until 09:00)"), JSON.stringify(n));
});
test('5C B6 (2): tracker 19:50, reply "until 0:10": 20 minutes apart on a 20-hour day (the story wins); 260 on a 24-hour day (the tracker stands)', async () => {
    { const { c } = await trackerTurn({ line: 'I wait for the watch.', story: 'You keep watch until 0:10.', tracker: until('19:50'), time: '19:00', hours: 20 }); assert.equal(clock(c), '00:10', '20-hour day'); }
    { const { c } = await trackerTurn({ line: 'I wait for the watch.', story: 'You keep watch until 0:10.', tracker: until('19:50'), time: '19:00' }); assert.equal(clock(c), '19:50', '24-hour day'); }
});
test('5C B6 (2b): "[wait] until 11 pm" on a 20-hour day: no wait, and the notice says it is past the end of the day; /ws-wait the same', async () => {
    const { c, calls } = boot({ time: '10:00', hours: 20 });
    const m = await typed(c, 'I [wait] until 11 pm');
    assert.ok(hidden(m), JSON.stringify(m.extra));
    assert.match(m.extra.worldscrawl_cmd.error, /"11 pm" is past the end of this world's 20-hour day/);
    assert.equal(m.extra[WAIT], undefined);
    assert.equal(clock(c), '10:00');
    assert.equal(asked(calls), 0);
    assert.equal(await ext.waitCommand('until 11 pm'), '"11 pm" is past the end of this world\'s 20-hour day');
    assert.equal(clock(c), '10:00');
});
test('5C B6 (2b): the player line "I wait until 11 pm" with a tracker wait: no override, a failed story clock note, the tracker\'s own time stamped', async () => {
    const { c, id, n } = await trackerTurn({ line: 'I wait until 11 pm.', story: 'You wait.', tracker: until('19:50'), time: '19:00', hours: 20 });
    assert.deepEqual(storyNotes(c, id).map(x => [x.status, x.reason]), [['failed', '"11 pm" is past the end of this world\'s 20-hour day']]);
    assert.equal(clock(c), '19:50');
    assert.ok(!n.some(x => /from the player's line/.test(x.reason)), JSON.stringify(n));
});
test('5C B6 (2b): an impossible time in the reply is a failed story clock note and never overrides', async () => {
    const { c, id } = await trackerTurn({ line: 'I wait for the watch.', story: 'You keep watch until 11 pm.', tracker: until('19:50'), time: '19:00', hours: 20 });
    assert.deepEqual(storyNotes(c, id).map(x => x.status), ['failed']);
    assert.equal(clock(c), '19:50');
});
test('5C B6 (2b): a tracker until "23:00" on a 20-hour day fails visibly (a failed tracker wait note) and is never wrapped to 03:00', async () => {
    const { c, id, n } = await trackerTurn({ line: 'I wait for the watch.', story: 'You wait.', tracker: until('23:00'), time: '19:00', hours: 20 });
    assert.equal(c.chat[id].extra[WAIT], undefined);
    assert.equal(clock(c), '19:00');
    assert.deepEqual(n.map(x => [x.status, x.reason]), [['failed', '"23:00" is past the end of this world\'s 20-hour day']]);
});
test('5C B6 (2d): clockGap measures on the world\'s day and is Infinity for a time that day does not have', () => {
    assert.equal(D.clockGap('19:50', '21:30', CAL20), Infinity);
    assert.equal(D.clockGap('21:30', '19:50', CAL20), Infinity);
    assert.equal(D.clockGap('19:50', '00:10', CAL20), 20);
    assert.equal(D.clockGap('19:50', '00:10', calendarLib.GREGORIAN), 260);
    assert.equal(D.clockGap('23:50', '00:10'), 20, 'GREGORIAN when none is given');
});
test('5C B6: readUntil on a 20-hour day: impossible times are named with why (never null, never wrapped); valid ones read once', () => {
    const R = t => calendarLib.readUntil(t, CAL20);
    assert.deepEqual(R('11 pm'), { impossible: '11 pm', why: "past the end of this world's 20-hour day", rest: '' });
    assert.deepEqual(R('eleven at night and sleep'), { impossible: 'eleven at night', why: "past the end of this world's 20-hour day", rest: 'and sleep' });
    assert.deepEqual(R('23:00'), { impossible: '23:00', why: "past the end of this world's 20-hour day", rest: '' });
    assert.deepEqual(R('2130'), { impossible: '2130', why: "past the end of this world's 20-hour day", rest: '' });
    assert.equal(R('9 am').impossible, '9 am', 'a short day has no am or pm');
    assert.match(R('9 am').why, /has no am or pm/);
    assert.deepEqual(R('9:30'), { until: '09:30', rest: '' });
    assert.deepEqual(R('19:59'), { until: '19:59', rest: '' });
    assert.deepEqual(calendarLib.untilClocksRead('until 9:30, or until 11 pm', CAL20, { now: 0 }), { clocks: ['09:30'], impossible: [{ said: '11 pm', why: "past the end of this world's 20-hour day" }] });
    assert.throws(() => calendarLib.parseWait('until 11 pm', CAL20), e => e.impossible === true && e.message === '"11 pm" is past the end of this world\'s 20-hour day', 'the wait tag and the tracker until fail with the same line');
    assert.deepEqual(calendarLib.readUntil('11 pm'), { until: '23:00', rest: '' }, '24-hour day unchanged');
});
