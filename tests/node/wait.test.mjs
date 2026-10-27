// Waiting and sleeping: duration parsing, "until" resolution, stamps on the clock, and temporary patches running out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCalendar, dateAt, parseWait, sumTravel, untilSeconds, SLEEP_DEFAULT } from '../../plugin/ui/calendar.mjs';
import { activeChanges, expiredBetween } from '../../plugin/ui/patches.mjs';

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
