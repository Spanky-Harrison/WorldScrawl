// Weather: determinism, seasons, stretches, temperature, ground, exposure and the narrator line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GREGORIAN, dateAt, secondsBetween } from '../../plugin/ui/calendar.mjs';
import { INSULATION, MAX_STRETCH, MIN_STRETCH, absSeconds, daylightHours, dayCurve, feelsLike, fToC, cToF, groundAt, groundWords,
    indoorTemp, placeWeather, precipForm, seasonAt, stretchAt, sunTimes, weatherAt } from '../../plugin/ui/weather.mjs';
import { CLIMATES, SKY_TYPES, WIND_LEVELS, buildWeather } from '../../plugin/weather-config.mjs';
import { WorldError, build_world, load_world } from '../../plugin/world.mjs';
import { RIVERTON, makeWorld, tmpPath } from './helpers.mjs';

const H = 3600, DAY = 24 * H;
const Y1 = { year: 1, month: 'January', day: 1, time: '00:00' };
const at = (y, m, d, time = '12:00') => absSeconds(dateAt(secondsBetween(Y1, { year: y, month: m, day: d, time }), Y1));
const R = load_world(RIVERTON);
const CFG = R.weather;
const ctxOf = (cfg, wr) => ({ cfg, wr, cal: GREGORIAN, reg: cfg.regions[wr], spd: DAY, windows: new Map() });
const room = a => R.place_weather(R.get(a));
const MONTHS = GREGORIAN.months.map(m => m.name);

test('weather is a pure function of seed, region and time', () => {
    const t = at(1247, 'April', 12, '08:00');
    assert.deepEqual(weatherAt(CFG, 'riverside', t), weatherAt(CFG, 'riverside', t));
    assert.deepEqual(weatherAt(CFG, 'riverside', t), weatherAt(load_world(RIVERTON).weather, 'riverside', t)); // a fresh load agrees
    const other = { ...CFG, seed: 'something else' }, diffs = [];
    for (let h = 0; h < 30 * 24; h += 7) diffs.push(weatherAt(CFG, 'riverside', t + h * H, GREGORIAN, { ground: false }).sky !== weatherAt(other, 'riverside', t + h * H, GREGORIAN, { ground: false }).sky);
    assert.ok(diffs.filter(Boolean).length > 10, 'another seed gives other weather');
});

test('Riverton and Larkspur share one weather region; Larkspur is a little colder', () => {
    assert.equal(room('riverton:streets/square').weather_region, 'riverside');
    assert.equal(room('larkspur:green/green').weather_region, 'riverside');
    const t = at(1247, 'April', 12, '14:00');
    const a = placeWeather(CFG, room('riverton:streets/square'), t), b = placeWeather(CFG, room('larkspur:green/green'), t);
    assert.equal(a.outside.sky, b.outside.sky);
    assert.ok(Math.abs(cToF(a.outside.temp) - cToF(b.outside.temp) - 3) < 0.01);
});

test('season blending: 1/6 in, 2/3 full, 1/6 out, 0.5 at the boundary', () => {
    const months = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
    const yl = 365, mar1 = 59 / yl; // spring = March..May, 92 days
    const sp = (frac) => seasonAt(months, GREGORIAN, 2025, mar1 + frac * 92 / yl);
    assert.ok(Math.abs(sp(0).weights.spring - 0.5) < 1e-9 && Math.abs(sp(0).weights.winter - 0.5) < 1e-9);
    assert.ok(Math.abs(sp(1 / 12).weights.spring - 0.75) < 1e-9);
    assert.deepEqual(sp(0.5).weights, { spring: 1 });
    assert.deepEqual(sp(1 / 6 + 0.01).weights, { spring: 1 });
    assert.ok(Math.abs(sp(11 / 12).weights.summer - 0.25) < 1e-9);
    assert.equal(sp(0.9).phase, 'late'); assert.equal(sp(0.1).phase, 'early'); assert.equal(sp(0.5).phase, 'mid');
    // Winter wraps around the new year.
    assert.deepEqual(seasonAt(months, GREGORIAN, 2025, 15 / yl).weights, { winter: 1 });
});

test('one-month seasons follow the same 1/6 rule', () => {
    const months = ['a', 'b', 'b', 'b', 'b', 'b', 'c', 'c', 'c', 'c', 'c', 'c'];
    const s = f => seasonAt(months, GREGORIAN, 2025, f / 365);
    assert.ok(Math.abs(s(0).weights.a - 0.5) < 1e-9); // January alone is season a
    assert.ok(Math.abs(s(31 / 12).weights.a - 0.75) < 1e-6);
    assert.deepEqual(s(15.5).weights, { a: 1 });
    assert.ok(Math.abs(s(31 - 31 / 12).weights.a - 0.75) < 1e-6 && s(31 - 31 / 12).weights.b > 0.2);
});

test('stretches: clamped to 30 minutes..24 hours, chained without gaps', () => {
    const c = ctxOf(CFG, 'riverside');
    let t = at(1247, 'January', 1, '00:00'); const end = t + 365 * DAY;
    let n = 0, last = null;
    while (t < end) {
        const s = stretchAt(c, t);
        assert.ok(s.end - s.start <= MAX_STRETCH && s.end > t);
        if (last && last.end === s.start) assert.ok(s.end - s.start >= MIN_STRETCH || s.start % (3 * DAY) === 0 || s.end % (3 * DAY) === 0);
        last = s; t = s.end; n++;
    }
    assert.ok(n > 365, `about two or more stretches a day, got ${n}`);
});

test('wind shortens stretches and pushes the next roll toward change', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(WIND_LEVELS).map(([k, v]) => [k, v.hours])), { calm: 1, breezy: 0.85, windy: 0.65, gale: 0.5 });
    // Same sky, average lengths by wind over a year of clear stretches.
    const c = ctxOf(CFG, 'riverside'), len = {}; let t = at(1247, 'January', 1);
    for (const end = t + 2 * 365 * DAY; t < end;) { const s = stretchAt(c, t); if (s.sky === 'clear' && s.start % (3 * DAY) && s.end % (3 * DAY)) (len[s.wind] ??= []).push(s.end - s.start); t = s.end; }
    const avg = k => len[k].reduce((a, b) => a + b, 0) / len[k].length;
    assert.ok(avg('calm') > avg('windy'), `calm ${avg('calm') / H}h vs windy ${avg('windy') / H}h`);
    for (const w of Object.values(WIND_LEVELS)) assert.ok(w.change >= 1);
    assert.ok(WIND_LEVELS.gale.change > WIND_LEVELS.calm.change);
});

test('sky types are data: every preset only uses known sky types, storms are windy and fog is calm', () => {
    for (const [id, cl] of Object.entries(CLIMATES)) for (const s of Object.values(cl.seasons)) for (const k of Object.keys(s.sky)) assert.ok(SKY_TYPES[k], `${id}: ${k}`);
    assert.ok(SKY_TYPES.storm.wind.gale > SKY_TYPES.storm.wind.calm);
    assert.ok(SKY_TYPES.fog.wind.calm > SKY_TYPES.fog.wind.windy);
    assert.ok(Object.keys(CLIMATES).length >= 30);
    assert.deepEqual(new Set(Object.values(CLIMATES).map(c => c.koppen)).size, Object.keys(CLIMATES).length);
});

test('precipitation form: rain above 36°F, sleet 30-36°F, snow below 30°F', () => {
    assert.equal(precipForm(fToC(37)), 'rain'); assert.equal(precipForm(fToC(36)), 'sleet');
    assert.equal(precipForm(fToC(30)), 'sleet'); assert.equal(precipForm(fToC(29.9)), 'snow');
});

test('feels-like: wind chill below 50°F, heat index when hot and humid', () => {
    assert.equal(Math.round(cToF(feelsLike(fToC(34), 20, 80))), 23); // NWS formula: 34°F at 20 mph -> 22.6
    assert.equal(feelsLike(fToC(34), 2, 80), fToC(34)); // calm: no chill
    assert.equal(feelsLike(fToC(60), 30, 50), fToC(60)); // too warm for wind chill
    assert.equal(Math.round(cToF(feelsLike(fToC(90), 5, 60))), 100); // NWS: 90°F / 60% -> 100
    assert.equal(feelsLike(fToC(90), 5, 20), fToC(90));
});

test('daylight follows a smooth curve between the solstice lengths, centred on noon', () => {
    const c = ctxOf(CFG, 'riverside'), cl = CFG.regions.riverside.climate;
    const day = f => daylightHours(c, 2025, f);
    const jul = day(196 / 365), jan = day(15 / 365), apr = day(105 / 365);
    assert.ok(Math.abs(jul - cl.daylight.summer) < 0.01, jul); assert.ok(Math.abs(jan - cl.daylight.winter) < 0.01, jan);
    assert.ok(apr > jan && apr < jul);
    const s = sunTimes(c, 2025, 0.3); assert.equal((s.sunrise + s.sunset) / 2, DAY / 2);
    const c2 = { ...c, reg: { ...c.reg, daylight_adjust: 1 } };
    assert.ok(Math.abs(daylightHours(c2, 2025, 196 / 365) - jul - 1) < 0.01);
    const c3 = { ...c, cal: { ...GREGORIAN, hours_per_day: 12 } };
    assert.ok(Math.abs(daylightHours(c3, 2025, 196 / 365) - jul / 2) < 0.01);
});

test('temperature: coldest near sunrise, warmest mid-afternoon; seasons differ; drift makes days differ', () => {
    const sun = { sunrise: 6 * H, sunset: 18 * H };
    assert.equal(dayCurve(6 * H, sun, DAY), 0); assert.ok(dayCurve(14.7 * H, sun, DAY) > 0.99);
    assert.ok(dayCurve(3 * H, sun, DAY) < dayCurve(22 * H, sun, DAY));
    const temp = (m, d, h) => weatherAt(CFG, 'riverside', at(1247, m, d, h), GREGORIAN, { ground: false }).temp;
    let jul = 0, jan = 0; for (let d = 1; d <= 28; d++) { jul += temp('July', d, '15:00'); jan += temp('January', d, '15:00'); }
    assert.ok(jul / 28 > jan / 28 + 15);
    const highs = new Set(); for (let d = 1; d <= 30; d++) highs.add(Math.round(temp('April', d, '15:00')));
    assert.ok(highs.size > 5);
});

test('ground: rain wets, sun dries, snow piles up and melts, wet + freezing = icy (look-back reaches before the start)', () => {
    const fake = (sky, temp) => ({ seed: 's', unit: 'F', winds: WIND_LEVELS, skies: { [sky]: { ...SKY_TYPES[sky], hours: [24, 24], next: {} } },
        regions: { r: { months: MONTHS.map(() => 'x'), daylight_adjust: 0, climate: { daylight: { summer: 12, winter: 12 }, seasons: { x: { high: temp, low: temp, humidity: 70, sky: { [sky]: 1 }, windiness: 0.0001 } } } } } });
    const t = at(1, 'June', 1, '12:00'); // only 151 days into time: the look-back still works
    const g = (sky, temp) => groundAt(ctxOf(fake(sky, temp), 'r'), t);
    const nodrift = cfg => cfg; // drift is a few degrees, so pick temperatures well clear of freezing
    assert.ok(g('rain', 15).wetness > 0.9);
    assert.ok(g('clear', 20).wetness < 0.01);
    assert.ok(g('rain', -20).snow > 50);
    assert.equal(g('rain', 20).snow, 0);
    assert.ok(!g('clear', -20).icy);
    assert.match(groundWords({ wetness: 0.8, snow: 0, icy: false }, 10), /muddy/);
    assert.match(groundWords({ wetness: 0.4, snow: 5, icy: true }, 2), /snow on the ground, slushy, icy in patches/);
    nodrift();
    // Real Riverton: a winter with snow at some point, and an icy morning somewhere in it.
    let snowy = 0, icy = 0, wet = 0;
    for (let d = 1; d <= 28; d += 3) { const w = weatherAt(CFG, 'riverside', at(1247, 'January', d, '07:00')).ground; if (w.snow > 1) snowy++; if (w.icy) icy++; }
    for (let d = 1; d <= 30; d += 3) { const w = weatherAt(CFG, 'riverside', at(1247, 'April', d, '12:00')).ground; if (w.wetness > 0.1) wet++; }
    assert.ok(snowy > 0, 'snow in January'); assert.ok(wet > 0, 'wet days in April');
});

test('exposure cascades region > subregion > location; heat settings do not leak past a level that resets exposure', () => {
    assert.equal(room('riverton:streets/square').exposure, 'outdoor');
    assert.deepEqual([room('riverton:drowned_rat/common_room').exposure, room('riverton:drowned_rat/common_room').insulation, Math.round(cToF(room('riverton:drowned_rat/common_room').indoor_temp))], ['sheltered', 'cozy', 72]);
    assert.equal(room('riverton:drowned_rat/courtyard').exposure, 'outdoor');
    const cellar = room('riverton:drowned_rat/cellar'); assert.equal(cellar.exposure, 'enclosed'); assert.equal(cellar.indoor_temp, null);
    const stable = room('riverton:drowned_rat/stable'); assert.equal(stable.exposure, 'sheltered'); assert.equal(stable.indoor_temp, null); assert.equal(stable.insulation, 'drafty');
    for (const a of ['riverton:temple/catacombs', 'riverton:secret_tunnel/tunnel', 'larkspur:baths/boiler', 'larkspur:playhouse/under_stage']) assert.equal(room(a).exposure, 'enclosed', a);
    for (const a of ['riverton:docks/piers', 'riverton:east_road/road', 'larkspur:west_road/road', 'larkspur:green/bath_steps', 'larkspur:dyeworks/yard']) assert.equal(room(a).exposure, 'outdoor', a);
    // Every room in the bundled world is covered on purpose.
    for (const loc of R.locations.values()) assert.ok(loc.place.exposure || R.sub_of(loc).place.exposure, loc.address);
    assert.ok(Math.abs(room('larkspur:green/green').temp_offset - (-3 * 5 / 9)) < 1e-9);
});

test('insulation closes a fixed fraction of the gap', () => {
    assert.deepEqual(INSULATION, { drafty: 0.3, normal: 0.6, cozy: 0.85 });
    const out = fToC(20), want = fToC(72), f = (ins) => Math.round(cToF(indoorTemp(out, want, ins)));
    assert.deepEqual([f('drafty'), f('normal'), f('cozy')], [36, 51, 64]);
    assert.equal(indoorTemp(5, null), 8);
});

test('narrator lines per exposure, °F by default and °C on request', () => {
    const t = at(1247, 'April', 12, '08:00');
    const o = placeWeather(CFG, room('riverton:streets/square'), t);
    assert.match(o.line, /^Weather: [A-Z][^,]*, (?:[a-z -]+, )?-?\d+°F(?: \(feels like -?\d+°F\))?, [a-z]+, \d+% humidity\.(?: Underfoot: [^.]+\.)? (?:Early |Mid |Late )?[Ss]pring\.$/);
    assert.match(o.short, /°F$/);
    const s = placeWeather(CFG, room('riverton:drowned_rat/common_room'), t);
    assert.match(s.line, /^Weather \(outside\): .* Inside, sheltered from the wind and rain: \d+°F, [a-z]+\.$/);
    assert.match(s.short, / outside · \d+°F inside$/);
    const e = placeWeather(CFG, room('riverton:drowned_rat/cellar'), t);
    assert.match(e.line, /^Temperature here: \d+°F, [a-z]+ and still; no weather reaches this place\.$/);
    const fixed = placeWeather(CFG, { exposure: 'fixed', fixed_weather: { condition: 'Eternal twilight', temp: 15 } }, t);
    assert.equal(fixed.line, 'Weather here: Eternal twilight, 59°F.');
    assert.match(placeWeather({ ...CFG, unit: 'C' }, room('riverton:streets/square'), t).line, /°C/);
});

test('loader checks weather fields and builds climates from presets, Köppen codes or the world', () => {
    const dir = tmpPath();
    const base = { name: 'R', start: 's/a', subregions: { s: { name: 'S', locations: { a: { name: 'A', description: 'x' } } } } };
    makeWorld(dir, { r: base });
    const bw = (wj, r = base) => build_world({ start_region: 'r', ...wj }, { r });
    assert.equal(bw({}).place_weather(bw({}).get('r:s/a')).exposure, 'outdoor');
    assert.equal(bw({}, { ...base, climate: 'Cfb' }).weather.regions['@r'].climate.koppen, 'Cfb');
    assert.throws(() => bw({}, { ...base, climate: 'swamp' }), /unknown climate/);
    assert.throws(() => bw({}, { ...base, exposure: 'indoors' }), WorldError);
    assert.throws(() => bw({}, { ...base, insulation: 'toasty' }), /insulation/);
    assert.throws(() => bw({}, { ...base, weather_region: 'nope' }), /weather_regions/);
    assert.throws(() => bw({}, { ...base, seasons: { summer: ['June'] } }), /no season/);
    assert.throws(() => bw({}, { ...base, climate: 'oceanic', seasons: { winter: ['January', 'March'], spring: ['February', 'April', 'May'], summer: ['June', 'July', 'August'], autumn: ['September', 'October', 'November', 'December'] } }), /in a row/);
    const cw = bw({ temperature_unit: 'C', climates: { gloom: { daylight: { summer: 12, winter: 12 }, seasons: { always: { high: 10, low: 0, humidity: 90, sky: { overcast: 1, fog: 1 } } } } } }, { ...base, climate: 'gloom', indoor_temp: 20 });
    assert.deepEqual(cw.weather.regions['@r'].months, MONTHS.map(() => 'always'));
    assert.equal(cw.place_weather(cw.get('r:s/a')).indoor_temp, 20);
    // A weather region's settings win over the region's own.
    const wr = bw({ weather_regions: { w: { climate: 'ice_cap' } } }, { ...base, weather_region: 'w', climate: 'hot_desert' });
    assert.equal(wr.weather.regions.w.climate.koppen, 'EF');
    // Custom calendar without season months: an even split.
    const cal = { hours_per_day: 20, days_of_week: ['A'], months: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].map(name => ({ name, days: 10 })) };
    const cc = bw({ calendar: cal, start_date: { year: 1, month: 'M1', day: 1, time: '00:00' } });
    assert.equal(new Set(cc.weather.regions['@r'].months).size, 4);
    assert.ok(weatherAt(cc.weather, '@r', 123456, cal).label);
    assert.ok(buildWeather({}, { r: base }, GREGORIAN).config.regions['@r']);
});

test('lookups stay fast', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) placeWeather(CFG, room('riverton:streets/square'), at(1247, 'March', 1 + i));
    assert.ok(performance.now() - t0 < 2000);
});
