// Game time: calendar math, travel times, the clock, and saves baking the clock into start_date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GREGORIAN, advanceStart, checkCalendar, dateAt, formatDuration, monthDays, parseDuration, partOfDay, secondsBetween, sumTravel, yearDays } from '../../plugin/ui/calendar.mjs';
import { WorldError, load_world } from '../../plugin/world.mjs';
import { RIVERTON, SQUARE, TestClient, copytree, makeWorld, read, tmpPath } from './helpers.mjs';

const D = (year, month, day, time = '00:00') => ({ year, month, day, time });
const Y1 = D(1, 'January', 1);
const on = (y, m, d) => dateAt(secondsBetween(Y1, D(y, m, d)), Y1);

test('gregorian leap years: every 4th year, no century exceptions', () => {
    const feb = GREGORIAN.months[1];
    assert.equal(monthDays(feb, 2024), 29);
    assert.equal(monthDays(feb, 2000), 29);
    assert.equal(monthDays(feb, 1900), 29);
    assert.equal(monthDays(feb, 2023), 28);
    assert.equal(yearDays(GREGORIAN, 2024), 366);
    assert.equal(yearDays(GREGORIAN, 2025), 365);
    assert.equal(on(2024, 'February', 29).day, 29);
    assert.deepEqual(advanceStart(D(2024, 'February', 28, '23:30'), 3600), D(2024, 'February', 29, '00:30'));
    assert.deepEqual(advanceStart(D(2023, 'February', 28, '23:30'), 3600), D(2023, 'March', 1, '00:30'));
    assert.deepEqual(advanceStart(D(2026, 'December', 31, '23:00'), 7200), D(2027, 'January', 1, '01:00'));
});

test('gregorian weekdays match real dates', () => {
    assert.equal(on(2026, 'October', 25).weekday, 'Sunday');
    assert.equal(on(2024, 'October', 25).weekday, 'Friday');
    assert.equal(on(2000, 'January', 1).weekday, 'Saturday');
    assert.equal(on(2024, 'February', 29).weekday, 'Thursday');
    assert.equal(on(1969, 'July', 20).weekday, 'Sunday');
});

test('custom calendar: week length from day names, per-month leap rules, short days', () => {
    const cal = checkCalendar({ hours_per_day: 20, days_of_week: ['Moonday', 'Tideday', 'Fireday'],
        months: [{ name: 'Thaw', days: 30 }, { name: 'Frost', days: 28, leap_every: 3, leap_days: 2 }, { name: 'Midwinter', days: 1 }] });
    assert.equal(yearDays(cal, 3), 61); assert.equal(yearDays(cal, 4), 59);
    const d = dateAt(20 * 3600 * 58 + 3600 * 5, D(1, 'Thaw', 1), cal);
    assert.deepEqual([d.year, d.month, d.day, d.time], [1, 'Midwinter', 1, '05:00']);
    assert.equal(d.weekday, ['Moonday', 'Tideday', 'Fireday'][58 % 3]);
    assert.equal(dateAt(0, D(1, 'Thaw', 1, '10:00'), cal).part, 'afternoon'); // 10 of 20 hours = midday
    assert.throws(() => dateAt(0, D(1, 'Thaw', 1, '21:00'), cal));
    assert.throws(() => checkCalendar({ hours_per_day: 24, days_of_week: [], months: [{ name: 'A', days: 3 }] }));
    assert.throws(() => checkCalendar({ hours_per_day: 24, days_of_week: ['a'], months: [{ name: 'A', days: 0 }] }));
});

test('parts of the day', () => {
    const at = h => partOfDay(h * 3600);
    assert.deepEqual([0, 5, 6, 8, 13, 18, 22].map(at), ['night', 'dawn', 'dawn', 'morning', 'afternoon', 'evening', 'night']);
});

test('durations', () => {
    assert.equal(parseDuration('2h'), 7200); assert.equal(parseDuration('90m'), 5400);
    assert.equal(parseDuration('1h30m'), 5400); assert.equal(parseDuration('45s'), 45);
    assert.equal(parseDuration('1h 5m 10s'), 3910); assert.equal(parseDuration(30), 30);
    for (const bad of ['', 'soon', '2 hours', '1d', '-5m', '1.5h']) assert.throws(() => parseDuration(bad), bad);
    assert.equal(formatDuration(5400), '1h30m'); assert.equal(formatDuration(45), '45s'); assert.equal(formatDuration(0), '0s');
});

test('clock = sum of stamps after the latest rebase', () => {
    const mv = s => ({ extra: { worldscrawl_move: { seconds: s } } });
    const chat = [{}, mv(60), { extra: {} }, mv(7200), mv(180)];
    assert.equal(sumTravel(chat), 7440);
    assert.equal(sumTravel(chat, 3), 180);
    assert.equal(sumTravel(chat.slice(0, 3)), 60); // deleting messages undoes their time
});

test('travel_time: parsed, defaulted, validated; moves and routes report seconds', () => {
    const w = load_world(RIVERTON);
    const ex = (a, d) => w.get(a).exits.find(e => e.direction === d);
    assert.equal(w.travel_seconds(ex('riverton:east_road/road', 'east'), w.get('riverton:east_road/road')), 7200);
    assert.equal(w.travel_seconds(ex('larkspur:west_road/road', 'west'), w.get('larkspur:west_road/road')), 7200);
    const dir = makeWorld(tmpPath(), { r: { name: 'R', start: 's/a', subregions: {
        s: { name: 'S', locations: { a: { name: 'A', description: 'a', exits: [{ direction: 'e', to: 'b' }, { direction: 'out', to: 't/x' }] }, b: { name: 'B', description: 'b', exits: [] } } },
        t: { name: 'T', locations: { x: { name: 'X', description: 'x', exits: [] } } } } } });
    const w2 = load_world(dir), a = w2.get('r:s/a');
    assert.deepEqual(a.exits.map(e => w2.travel_seconds(e, a)), [60, 180]);
    const bad = makeWorld(tmpPath(), { r: { name: 'R', start: 's/a', subregions: { s: { name: 'S', locations: { a: { name: 'A', description: 'a', exits: [{ direction: 'e', to: 'a', travel_time: 'a while' }] } } } } } });
    assert.throws(() => load_world(bad), e => e instanceof WorldError && /travel time/.test(e.message));

    const c = new TestClient({ worldDir: RIVERTON });
    assert.equal(c.post('/move', { json: { from: 'riverton:east_road/road', direction: 'east' } }).json().travel_seconds, 7200);
    const t = c.post('/travel', { json: { from: SQUARE, steps: ['east', 'east', 'east'] } }).json();
    assert.equal(t.travel_seconds, t.step_seconds.reduce((x, y) => x + y, 0));
    assert.ok(t.travel_seconds > 7200 && t.step_seconds.includes(7200));
});

test('worlds list their calendar and start_date; save bakes the clock into start_date', () => {
    const wd = tmpPath();
    copytree(RIVERTON, path.join(wd, 'riverton'));
    const c = new TestClient({ worldsDir: wd });
    const info = c.get('/worlds').json().worlds.find(x => x.id === 'riverton');
    assert.deepEqual(info.start_date, D(1247, 'April', 12, '08:00'));
    assert.equal(info.calendar.months.length, 12);
    const r = c.post('/worlds/render', { json: { base: 'riverton', id: 'later', name: 'Later', elapsed: 2 * 86400 + 7200 + 30 } });
    assert.equal(r.status_code, 200);
    assert.deepEqual(JSON.parse(read(path.join(wd, 'later', 'world.json'))).start_date, D(1247, 'April', 14, '10:00:30'));
    assert.deepEqual(r.json().start_date, D(1247, 'April', 14, '10:00:30'));
    // a save of the save continues from there
    c.post('/worlds/render', { json: { base: 'later', id: 'later2', name: 'Later 2', elapsed: 3600 } });
    assert.deepEqual(JSON.parse(read(path.join(wd, 'later2', 'world.json'))).start_date, D(1247, 'April', 14, '11:00:30'));
    assert.equal(c.post('/worlds/render', { json: { base: 'riverton', id: 'neg', elapsed: -5 } }).status_code, 422);
});

test('bad start_date or calendar in world.json is a load error', () => {
    const mk = extra => { const d = makeWorld(tmpPath(), { r: { name: 'R', start: 's/a', subregions: { s: { name: 'S', locations: { a: { name: 'A', description: 'a', exits: [] } } } } } });
        const p = path.join(d, 'world.json'); const j = JSON.parse(read(p)); Object.assign(j, extra); require_write(p, j); return d; };
    assert.throws(() => load_world(mk({ start_date: D(1247, 'Smarch', 1) })), /no month/);
    assert.throws(() => load_world(mk({ start_date: D(2023, 'February', 29) })), /no day/);
    assert.throws(() => load_world(mk({ calendar: { hours_per_day: 24, months: [] } })), /days_of_week/);
    assert.ok(load_world(mk({ start_date: D(2024, 'February', 29) })));
});
import fs from 'node:fs';
function require_write(p, j) { fs.writeFileSync(p, JSON.stringify(j)); }
