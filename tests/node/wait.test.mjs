import './ststub.mjs';
import './useprompts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cal from '../../plugin/shared/calendar.mjs';
import { checkCalendar, dateAt, parseWait, sumTravel, untilSeconds, SLEEP_DEFAULT } from '../../plugin/shared/calendar.mjs';
import { activeChanges, expiredBetween } from '../../plugin/shared/patches.mjs';
import { WAIT_TAG, waitArgs, parseWaitTag } from '../../extension/words.mjs';
import { extSource } from './helpers.mjs';
import fs from 'node:fs';

// ---- from wait.test.mjs
{
// Waiting and sleeping: duration parsing, "until" resolution, stamps on the clock, and temporary patches running out.





const START = { year: 1, month: 'January', day: 1, time: '20:00' };
const H = 3600;

test('wait durations: h/m/s, days, plain hours, no upper cap', () => {
    assert.deepEqual(parseWait('2h'), { seconds: 2 * H });
    assert.deepEqual(parseWait('1h30m'), { seconds: 5400 });
    assert.deepEqual(parseWait('45m'), { seconds: 2700 });
    assert.deepEqual(parseWait('3'), { seconds: 3 * H });
    assert.deepEqual(parseWait('for 2 hours'), { seconds: 2 * H });
    assert.deepEqual(parseWait('1d6h'), { seconds: 30 * H });
    assert.deepEqual(parseWait('400d'), { seconds: 400 * 24 * H });
    const cal = checkCalendar({ hours_per_day: 20, days_of_week: ['A'], months: [{ name: 'M', days: 30 }] });
    assert.deepEqual(parseWait('1d', cal), { seconds: 20 * H });
    for (const bad of ['', 'soon', '0m', 'until lunchtime', 'until 25:00']) assert.throws(() => parseWait(bad), bad);
    assert.deepEqual(parseWait('until morning'), { until: 'morning' });
    assert.deepEqual(parseWait('until sunrise'), { until: 'dawn' });
    assert.deepEqual(parseWait('until 14:30'), { until: '14:30' });
    assert.deepEqual(parseWait('until 5pm'), { until: '17:00' });
    assert.deepEqual(parseWait('until 5 pm'), { until: '17:00' });
    assert.deepEqual(parseWait('until 5:00pm'), { until: '17:00' });
    assert.deepEqual(parseWait('until 5:30 pm'), { until: '17:30' });
    assert.deepEqual(parseWait('until 12am'), { until: '00:00' });
    assert.deepEqual(parseWait('until 12 pm'), { until: '12:00' });
    assert.deepEqual(parseWait('until 5:30 a.m.'), { until: '05:30' });
    assert.throws(() => parseWait('until 13pm'));
    assert.equal(untilSeconds(0, parseWait('until 5pm').until, { year: 1, month: 'January', day: 1, time: '08:00' }), 9 * H);
    assert.equal(SLEEP_DEFAULT, 8 * H);
});

test('until: next occurrence, rolling to the next day', () => {
    // 20:00 -> midnight 4h, dawn (06:00 default) 10h, noon next day 16h, 21:00 same day 1h, 20:00 rolls a whole day
    assert.equal(untilSeconds(0, 'midnight', START), 4 * H);
    assert.equal(untilSeconds(0, 'dawn', START), 10 * H);
    assert.equal(untilSeconds(0, 'noon', START), 16 * H);
    assert.equal(untilSeconds(0, '21:00', START), 1 * H);
    assert.equal(untilSeconds(0, '20:00', START), 24 * H);
    const noonStart = { ...START, time: '12:00' };
    assert.equal(untilSeconds(0, 'dusk', noonStart), 7 * H);
    assert.equal(untilSeconds(0, 'noon', noonStart), 24 * H);
    // with weather daylight: sunrise 07:30, sunset 16:15
    const sun = () => ({ sunrise: 7.5 * H, sunset: 16.25 * H });
    assert.equal(untilSeconds(0, 'dawn', START, null, sun), 11.5 * H);
    assert.equal(untilSeconds(0, 'morning', START, null, sun), 12.5 * H);
    assert.equal(untilSeconds(0, 'dusk', noonStart, null, sun), 4.25 * H);
    // elapsed already into the clock
    assert.equal(untilSeconds(5 * H, 'dawn', START), 5 * H);
});

test('until on a custom calendar with a 20-hour day', () => {
    const cal = checkCalendar({ hours_per_day: 20, days_of_week: ['Moonday', 'Tideday'], months: [{ name: 'Thaw', days: 30 }] });
    const s = { year: 1, month: 'Thaw', day: 1, time: '15:00' };
    assert.equal(untilSeconds(0, 'noon', s, cal), 15 * H); // noon = 10:00, tomorrow
    assert.equal(untilSeconds(0, 'midnight', s, cal), 5 * H);
    assert.equal(untilSeconds(0, '19:00', s, cal), 4 * H);
    const d = dateAt(untilSeconds(0, 'noon', s, cal), s, cal);
    assert.deepEqual([d.day, d.time, d.weekday], [2, '10:00', 'Tideday']);
    assert.throws(() => untilSeconds(0, '21:00', s, cal));
});

test('wait stamps add to the clock with travel; deleting the message undoes them; rebase cut-off applies', () => {
    const chat = [{ extra: {} }, { extra: { worldscrawl_move: { seconds: 60 } } }, { extra: { worldscrawl_wait: { seconds: 8 * H, sleep: true } } }, { extra: { worldscrawl_wait: { seconds: 2 * H } } }];
    assert.equal(sumTravel(chat), 60 + 10 * H);
    assert.equal(sumTravel(chat.filter((_, i) => i !== 2)), 60 + 2 * H);
    assert.equal(sumTravel(chat, 2), 2 * H);
    assert.equal(sumTravel([{ extra: { worldscrawl_wait: { seconds: -5 } } }]), 0);
});

test('temporary patches run out across a wait', () => {
    const fire = { type: 'patch', id: 'p1', at: 0, summary: ['smoke over the inn', 'the inn is ruined'],
        ops: [{ op: 'set_description', target: 'a', description: 'smoke', lasts: '12h' }, { op: 'set_description', target: 'b', description: 'ruin' }] };
    const changes = [fire];
    assert.deepEqual(expiredBetween(changes, 0, 6 * H), []);
    const gone = expiredBetween(changes, 6 * H, 14 * H);
    assert.equal(gone.length, 1); assert.equal(gone[0].note, 'smoke over the inn'); assert.equal(gone[0].ends, 12 * H);
    assert.deepEqual(expiredBetween(changes, 12 * H, 20 * H), []); // already gone before this wait
    assert.equal(activeChanges(changes, 6 * H)[0].ops.length, 2);
    assert.equal(activeChanges(changes, 14 * H)[0].ops.length, 1);
    // the clock after a sleep decides it
    const now = sumTravel([{ extra: { worldscrawl_wait: { seconds: 6 * H } } }, { extra: { worldscrawl_wait: { seconds: 8 * H, sleep: true } } }]);
    assert.equal(activeChanges(changes, now)[0].ops.length, 1);
});



test('ws_wait tool args -> wait text', () => {
    assert.equal(waitArgs({ duration: '2h' }), '2h');
    assert.equal(waitArgs({ until: 'morning' }), 'until morning');
    assert.equal(waitArgs({ until: 'until dusk', duration: '3h' }), 'until dusk');
    assert.equal(waitArgs({}), '');
    assert.deepEqual(parseWait(waitArgs({ until: 'morning' })), { until: 'morning' });
});

test('[ws_wait: ...] tag parsing', () => {
    assert.equal(WAIT_TAG.exec('They rest. [ws_wait: sleep until morning]')[1], 'sleep until morning');
    assert.equal(WAIT_TAG.exec('no tag [ws_flag: wait | 2h]'), null);
    assert.deepEqual(parseWaitTag('2h'), { sleep: false, args: '2h', reason: '' });
    assert.deepEqual(parseWaitTag('sleep until morning'), { sleep: true, args: 'until morning', reason: '' });
    assert.deepEqual(parseWaitTag('sleep'), { sleep: true, args: '', reason: '' });
    assert.deepEqual(parseWaitTag('Sleep 6h'), { sleep: true, args: '6h', reason: '' });
    assert.deepEqual(parseWaitTag('wait for 3 hours'), { sleep: false, args: '3 hours', reason: '' });
    assert.deepEqual(parseWaitTag('until dusk'), { sleep: false, args: 'until dusk', reason: '' });
    assert.deepEqual(parseWaitTag('45m | searching the cellar'), { sleep: false, args: '45m', reason: 'searching the cellar' });
    assert.deepEqual(parseWaitTag('sleep until morning|sleeping the night.'), { sleep: true, args: 'until morning', reason: 'sleeping the night' });
    assert.deepEqual(parseWaitTag('2h; a long meal'), { sleep: false, args: '2h', reason: 'a long meal' });
    assert.deepEqual(parseWaitTag('until 14:00 - "crafting"'), { sleep: false, args: 'until 14:00', reason: 'crafting' });
    assert.deepEqual(parseWaitTag('1h |  '), { sleep: false, args: '1h', reason: '' });
    assert.equal(parseWaitTag(`2h | ${'x'.repeat(200)}`).reason.length, 80);
    assert.deepEqual(parseWait(parseWaitTag('wait for 3 hours').args), { seconds: 3 * H });
});
}

// ---- from waitedit.test.mjs
{
// Re-timing a kept wait moves the clock, so expiries it now crosses (or no longer reaches) are rechecked.




const { waitExpiryDelta, editKeptWait } = await import('../../extension/index.js');
const H = 3600;

test('editing an already-kept wait rechecks the expiries it now crosses or no longer crosses', () => {
    const fire = { type: 'patch', id: 'p1', at: 0, summary: ['smoke over the inn'], ops: [{ op: 'set_description', target: 'a', description: 'smoke', lasts: '12h' }] };
    const flood = { type: 'patch', id: 'p2', at: 0, summary: ['the cellar is flooded'], ops: [{ op: 'set_description', target: 'b', description: 'wet', lasts: '5h' }] };
    const ch = [fire, flood];
    // kept as 2h from 2h in (nothing ran out); re-timed to 12h: both now run out
    let d = waitExpiryDelta(ch, 2 * H, 2 * H, 12 * H, expiredBetween);
    assert.deepEqual(d.crossed.map(g => g.note).sort(), ['smoke over the inn', 'the cellar is flooded']); assert.deepEqual(d.uncrossed, []);
    // kept as 12h; shortened to 2h: neither runs out any more
    d = waitExpiryDelta(ch, 2 * H, 12 * H, 2 * H, expiredBetween);
    assert.deepEqual(d.crossed, []); assert.deepEqual(d.uncrossed.map(g => g.note).sort(), ['smoke over the inn', 'the cellar is flooded']);
    // 2h -> 4h: only the flood is newly crossed; same length: nothing changes
    d = waitExpiryDelta(ch, 2 * H, 2 * H, 4 * H, expiredBetween);
    assert.deepEqual(d.crossed.map(g => g.note), ['the cellar is flooded']);
    assert.deepEqual(waitExpiryDelta(ch, 2 * H, 4 * H, 4 * H, expiredBetween), { crossed: [], uncrossed: [] });
    // and the map follows the clock: active at the new time
    assert.equal(activeChanges(ch, 14 * H).reduce((n, c) => n + c.ops.length, 0), 0);
    assert.equal(activeChanges(ch, 6 * H).reduce((n, c) => n + c.ops.length, 0), 1);
});

test('editKeptWait refuses a message with no kept wait', async () => {
    globalThis.SillyTavern.getContext().chat = [{ extra: {} }];
    assert.match((await editKeptWait(0, '2h')).error, /no kept wait/);
});
}

// ---- from waitwords.test.mjs
{
// Loose wait amounts for [wait], [sleep] and /ws-wait, and the small model call used when even those can't be read.





const { parseWait, waitWords } = cal;
const ext = await import('../../extension/index.js');
const H = 3600, M = 60;

test('loose spoken amounts', () => {
    const cases = { '1 hour and 1 minute': H + M, 'for 1 hour and 1 minute': H + M, 'an hour': H, 'half an hour': H / 2, 'an hour and a half': 1.5 * H,
        '2 hours 30 minutes': 2.5 * H, '2 hours, 30 minutes': 2.5 * H, '90 min': 90 * M, 'a day': 86400, 'about two hours': 2 * H, 'a couple of hours': 2 * H,
        'for about 20 minutes': 20 * M, '1h30m': 1.5 * H, '1d6h': 30 * H, '2 days': 2 * 86400, '1 hr 15 mins': 75 * M, 'an hour.': H };
    for (const [t, s] of Object.entries(cases)) assert.deepEqual(parseWait(t), { seconds: s }, t);
});
test('until a time of day or a clock time', () => {
    assert.deepEqual(parseWait('until dawn'), { until: 'dawn' });
    assert.deepEqual(parseWait('until 14:30'), { until: '14:30' });
});
test('a day follows the world calendar', () => assert.equal(waitWords('a day', 30 * H), 30 * H));
test('unreadable amounts fail with a "wait" message, not "travel time"', () => {
    for (const bad of ['banana', 'for a while', '1 and', 'hour banana']) assert.throws(() => parseWait(bad), e => /^wait must look like/.test(e.message) && !/travel/.test(e.message), bad);
    assert.throws(() => parseWait('0 minutes'), /longer than zero/);
});
const withModel = async (answer, fn) => {
    const old = globalThis.SillyTavern, asked = [];
    const real = old.getContext();
    globalThis.SillyTavern = { getContext: () => new Proxy({}, { get: (t, k) => k === 'generateRaw' ? async a => { asked.push(a); return answer; } : real[k] }) };
    try { return await fn(asked); } finally { globalThis.SillyTavern = old; }
};
test('model fallback: seconds or until, checked; junk gives null', async () => {
    await withModel('{"seconds": 4500}', async asked => {
        assert.deepEqual(await ext.modelWait('a bit over an hour', null, cal), { seconds: 4500 });
        assert.match(asked[0].prompt, /a bit over an hour/); assert.match(asked[0].systemPrompt, /"seconds": N/);
    });
    await withModel('{"until": "dawn"}', async () => assert.deepEqual(await ext.modelWait('till first light', null, cal), { until: 'dawn' }));
    await withModel('{"unknown": true}', async () => assert.equal(await ext.modelWait('for a while', null, cal), null));
    await withModel('{"until": "lunchtime"}', async () => assert.equal(await ext.modelWait('till lunch', null, cal), null));
    await withModel('no idea', async () => assert.equal(await ext.modelWait('xyz', null, cal), null));
});
}

// ---- from waitcard.test.mjs
{
// Narrator waits (ws_wait tool, [ws_wait] tag, ws_flag wait) wait for the player on an Edit / Approve / Discard card.





const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
ext.setPrompts(def);
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));

test('the card stores the amount as the player would type it', () => {
    const m = {};
    ext.proposeWait(m, { seconds: 7200, sleep: false, label: 'waited 2h' });
    assert.equal(m.extra.worldscrawl_waitcard.seconds, 7200);
    assert.ok(!m.extra.worldscrawl_wait, 'nothing stamped until Keep');
    assert.equal(ext.waitAmount({ until: 'dawn', seconds: 1 }), 'until dawn');
});
test('Auto-keep waits defaults to off', () => {
    const src = extSource();
    assert.match(src, /autoKeepWaits: false/);
});
test('wait wording is in the prompt file: clearly 15 minutes or more, best guess, not dialogue or travel, if unclear don\'t', () => {
    for (const id of ['narration.wait_hint', 'narration.wait_tool']) {
        const t = byId[id].text;
        assert.ok(byId[id].locked, id);
        for (const w of ['clearly take 15 minutes or more', 'a long meal', 'searching a room', 'crafting', 'explicit time skip', 'best guess', 'travel', 'exchange of dialogue', 'single action', "If it isn't clear, don't", 'reason']) assert.ok(t.includes(w), `${id}: ${w}`);
        for (const w of ['meal or conversation', 'when in doubt']) assert.ok(!t.includes(w), `${id}: no ${w}`);
    }
    assert.match(byId['narration.wait_hint'].text, /\[ws_wait: 45m \| searching the cellar\]/);
    assert.match(byId['narration.flag_action'].text, /isn't clear, don't/);
    assert.equal(ext.render('narration.wait_tool'), byId['narration.wait_tool'].text);
});
test('guardrail: narrator waits under 15 minutes are ignored (no card, no clock change)', () => {
    const user = [{ is_user: true, mes: 'I eat', extra: {} }];
    assert.equal(ext.narratorWaitAction(user, { seconds: 14 * 60 }), 'short');
    assert.equal(ext.narratorWaitAction(user, { seconds: 15 * 60 }), 'card');
    assert.equal(ext.narratorWaitAction(user, { seconds: 3600 }, true), 'keep');
});
test('guardrail: explicit waits (/ws-wait, [wait]) already applied, so a narrator wait on that turn is ignored', () => {
    const slash = [{ is_user: true, mes: 'hi', extra: {} }, { is_user: true, mes: '*K waits for 2h.*', extra: { worldscrawl_engine: true, worldscrawl_wait: { seconds: 7200 } } }];
    assert.equal(ext.narratorWaitAction(slash, { seconds: 3600 }), 'explicit');
    const bracket = [{ is_user: true, mes: 'I [wait] 2h', extra: { worldscrawl_wait: { seconds: 7200 } } }];
    assert.equal(ext.narratorWaitAction(bracket, { seconds: 3600 }), 'explicit');
    const older = [{ is_user: true, mes: 'x', extra: { worldscrawl_wait: { seconds: 7200 } } }, { mes: 'reply' }, { is_user: true, mes: 'now', extra: {} }];
    assert.equal(ext.narratorWaitAction(older, { seconds: 3600 }), 'card', 'an earlier turn\'s wait does not count');
});
}
