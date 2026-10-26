// Weather: a pure function of (world seed, weather region, absolute game time). Nothing is saved, so swipes and deletes
// stay consistent and two chats in the same world at the same moment see the same sky. Shared by the server plugin, the
// map window and the extension (served at /api/plugins/worldscrawl/ui/weather.mjs).
//
// The config (built by the server from world.json, region files, plugin/climates/*.json, sky_types.json and
// wind_levels.json; see weatherConfig in world.mjs) looks like
//   { seed, unit: "F"|"C", skies: {...}, winds: {...},
//     regions: { wr_id: { climate: {name, daylight: {summer, winter}, seasons: {name: {high, low, humidity, sky, windiness, hours?}}},
//                          months: [season name for each calendar month], daylight_adjust } } }
// All temperatures here are °C. Sky types and wind levels are data, so the engine never names a specific one except as
// a fallback ("clear", "calm").
import { GREGORIAN, secondsPerDay, monthDays, yearDays } from './calendar.mjs';

const H = 3600;
export const MIN_STRETCH = 0.5 * H, MAX_STRETCH = 24 * H;
const WINDOW = 3 * 24 * H;          // stretches are chained inside 3-day windows starting at fixed anchors
const SNOW_LOOKBACK = 21 * 24 * H;  // weeks for the snowpack (wetness settles within a few days of that)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
export const cToF = c => c * 9 / 5 + 32;
export const fToC = f => (f - 32) * 5 / 9;

// ---- deterministic randomness
function hash(...parts) {
    let h = 0x811c9dc5;
    for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}
export function rng(...parts) {
    let a = hash(...parts);
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const unit = (...p) => rng(...p)();
function pick(weights, r) {
    const ent = Object.entries(weights).filter(([, w]) => w > 0);
    const tot = ent.reduce((s, [, w]) => s + w, 0);
    if (!ent.length) return null;
    let x = r * tot;
    for (const [k, w] of ent) { if ((x -= w) < 0) return k; }
    return ent.at(-1)[0];
}

// ---- calendar helpers (memoised: the look-back asks for the same days over and over)
const dayCache = new WeakMap();
/** {year, doy, ylen, mi} for absolute day number dn (0 = day 1 of month 1 of year 1). */
export function dayInfo(dn, cal = GREGORIAN) {
    let c = dayCache.get(cal); if (!c) dayCache.set(cal, c = { years: [0], days: new Map() });
    if (c.days.has(dn)) return c.days.get(dn);
    const ys = c.years; // ys[i] = first day number of year i+1
    while (ys.at(-1) <= dn) ys.push(ys.at(-1) + yearDays(cal, ys.length));
    let lo = 0, hi = ys.length - 1; // find i with ys[i] <= dn < ys[i+1]
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ys[m] <= dn) lo = m; else hi = m; }
    const year = lo + 1, doy = dn - ys[lo];
    let mi = 0, left = doy;
    while (left >= monthDays(cal.months[mi], year)) { left -= monthDays(cal.months[mi], year); mi++; }
    const out = { year, doy, ylen: yearDays(cal, year), mi };
    if (c.days.size > 5000) c.days.clear();
    c.days.set(dn, out);
    return out;
}
/** Absolute seconds since day 1 of year 1 for a dateAt() result. */
export const absSeconds = (d, cal = GREGORIAN) => d.day_number * secondsPerDay(cal) + d.hour * H + d.minute * 60 + d.second;

// ---- seasons
/** Season runs for a year: [{name, start (fraction of year), len}] in calendar order, merged cyclically. */
function seasonRuns(months, cal, year) {
    const yl = yearDays(cal, year), runs = [];
    let d = 0;
    cal.months.forEach((m, i) => {
        const len = monthDays(m, year), name = months[i];
        if (runs.length && runs.at(-1).name === name) runs.at(-1).len += len / yl;
        else runs.push({ name, start: d / yl, len: len / yl });
        d += len;
    });
    if (runs.length > 1 && runs[0].name === runs.at(-1).name) { const last = runs.pop(); runs[0].start = last.start - 1; runs[0].len += last.len; }
    return runs;
}
/**
 * Season weights at year-fraction f: each season spends its first sixth blending in, two thirds fully in season and its
 * last sixth blending out. At a boundary both neighbours weigh 0.5. Returns {weights: {name: w}, name, phase: early|mid|late}.
 */
export function seasonAt(months, cal, year, f) {
    const runs = seasonRuns(months, cal, year);
    if (runs.length === 1) return { weights: { [runs[0].name]: 1 }, name: runs[0].name, phase: phaseOf(((f % 1) + 1) % 1) };
    const n = runs.length;
    for (let i = 0; i < n; i++) {
        const r = runs[i];
        let p = (f - r.start) / r.len; if (p < 0) p = (f + 1 - r.start) / r.len; if (p >= 1) p = (f - 1 - r.start) / r.len;
        if (p < 0 || p >= 1) continue;
        const prev = runs[(i - 1 + n) % n].name, next = runs[(i + 1) % n].name, w = {};
        if (p < 1 / 6) { const s = 0.5 + p * 3; w[r.name] = s; w[prev] = (w[prev] ?? 0) + 1 - s; }
        else if (p > 5 / 6) { const s = 0.5 + (1 - p) * 3; w[r.name] = s; w[next] = (w[next] ?? 0) + 1 - s; }
        else w[r.name] = 1;
        return { weights: w, name: r.name, phase: phaseOf(p) };
    }
    return { weights: { [runs[0].name]: 1 }, name: runs[0].name, phase: 'mid' };
}
const phaseOf = p => (p < 1 / 3 ? 'early' : p < 2 / 3 ? 'mid' : 'late');
/** Blend a climate's per-season numbers and sky odds by season weights. */
function blendSeason(climate, weights) {
    const out = { high: 0, low: 0, humidity: 0, windiness: 0, sky: {}, hours: {} };
    for (const [name, w] of Object.entries(weights)) {
        const s = climate.seasons[name];
        for (const k of ['high', 'low', 'humidity']) out[k] += s[k] * w;
        out.windiness += (s.windiness ?? 1) * w;
        for (const [k, v] of Object.entries(s.sky)) out.sky[k] = (out.sky[k] ?? 0) + v * w;
        for (const [k, v] of Object.entries(s.hours ?? {})) if (!out.hours[k] || w > 0.5) out.hours[k] = v;
    }
    return out;
}

// ---- per-region context
function ctx(cfg, wr, cal) {
    const reg = cfg.regions[wr];
    if (!reg) throw new Error(`unknown weather region ${JSON.stringify(wr)}`);
    return { cfg, wr, cal: cal ?? GREGORIAN, reg, spd: secondsPerDay(cal ?? GREGORIAN), windows: new Map() };
}
function seasonFor(c, t) {
    const dn = Math.floor(t / c.spd), di = dayInfo(dn, c.cal);
    const f = (di.doy + (t - dn * c.spd) / c.spd) / di.ylen;
    const s = seasonAt(c.reg.months, c.cal, di.year, f);
    return { ...s, blend: blendSeason(c.reg.climate, s.weights), di, f };
}

// ---- daylight
/** Hours of daylight (in the calendar's hours) at year-fraction f: a smooth curve between the climate's solstice lengths. */
export function daylightHours(c, year, f) {
    const cl = c.reg.climate, adj = c.reg.daylight_adjust ?? 0;
    const runs = seasonRuns(c.reg.months, c.cal, year);
    const mean = n => cl.seasons[n].high + cl.seasons[n].low;
    const mid = r => (((r.start + r.len / 2) % 1) + 1) % 1;
    const hot = runs.reduce((a, b) => (mean(b.name) > mean(a.name) ? b : a)), cold = runs.reduce((a, b) => (mean(b.name) < mean(a.name) ? b : a));
    const scale = c.cal.hours_per_day / 24;
    const su = clamp(cl.daylight.summer + adj, 0, 24) * scale, wi = clamp(cl.daylight.winter - adj, 0, 24) * scale;
    if (hot === cold) return (su + wi) / 2;
    const a = mid(hot), b = mid(cold);
    const toCold = ((b - a) % 1 + 1) % 1, x = ((f - a) % 1 + 1) % 1;
    const p = x < toCold ? x / toCold : 1 - (x - toCold) / (1 - toCold); // 0 at midsummer, 1 at midwinter
    return lerp(su, wi, (1 - Math.cos(Math.PI * p)) / 2);
}
/** Sunrise/sunset as seconds of the day, centred on the middle of the day. */
export function sunTimes(c, year, f) {
    const len = daylightHours(c, year, f) * H, noon = c.spd / 2;
    return { sunrise: noon - len / 2, sunset: noon + len / 2, daylight: len };
}
function light(sod, sun, spd) {
    if (sun.daylight <= 0) return 'night';
    if (sun.daylight >= spd - 60) return 'day';
    const half = 0.5 * H;
    if (Math.abs(sod - sun.sunrise) <= half) return 'dawn';
    if (Math.abs(sod - sun.sunset) <= half) return 'dusk';
    return sod > sun.sunrise && sod < sun.sunset ? 'day' : 'night';
}

// ---- stretches
function rollWind(c, sky, windiness, r) {
    const w = {}, names = Object.keys(c.cfg.winds);
    names.forEach((n, i) => { w[n] = (c.cfg.skies[sky].wind?.[n] ?? 0) * Math.pow(windiness, i - 1); });
    return pick(w, r) ?? names[0];
}
function rollStretch(c, t, prev, r) {
    const s = seasonFor(c, t), skies = c.cfg.skies, odds = {};
    const sod = t - Math.floor(t / c.spd) * c.spd, morning = sod / c.spd > 3 / 24 && sod / c.spd < 9 / 24;
    for (const [k, w] of Object.entries(s.blend.sky)) {
        if (!skies[k]) continue;
        let x = w;
        if (prev) {
            x *= skies[prev.sky].next?.[k] ?? 1;
            if (k === prev.sky) x /= c.cfg.winds[prev.wind]?.change ?? 1; // wind blows weather through
        }
        if (morning && skies[k].morning) x *= skies[k].morning;
        odds[k] = x;
    }
    const sky = pick(odds, r()) ?? Object.keys(skies)[0];
    const wind = rollWind(c, sky, s.blend.windiness, r());
    const [lo, hi] = s.blend.hours[sky] ?? skies[sky].hours ?? [2, 12];
    const len = clamp(lerp(lo, hi, r()) * H * (c.cfg.winds[wind]?.hours ?? 1), MIN_STRETCH, MAX_STRETCH);
    return { sky, wind, start: t, end: t + len };
}
/** The stretches of anchor window k (cached per call). The first one starts at the anchor; the chain runs past the window end. */
function windowStretches(c, k) {
    if (c.windows.has(k)) return c.windows.get(k);
    const r = rng(c.cfg.seed, c.wr, 'w', k), out = [];
    let t = k * WINDOW, prev = null;
    while (t < (k + 1) * WINDOW) { const s = rollStretch(c, t, prev, r); out.push(s); prev = s; t = s.end; }
    out.at(-1).end = Math.min(out.at(-1).end, (k + 1) * WINDOW);
    if (c.windows.size > 64) c.windows.clear();
    c.windows.set(k, out);
    return out;
}
export function stretchAt(c, t) {
    const k = Math.floor(t / WINDOW), list = windowStretches(c, k);
    let i = list.findIndex(s => t < s.end); if (i < 0) i = list.length - 1;
    return { ...list[i], prev: i > 0 ? list[i - 1] : windowStretches(c, k - 1).at(-1) };
}

// ---- temperature
/** Slow seeded drift: a few °C of warm spells and cold snaps changing over days (two smooth value-noise octaves). */
export function drift(c, t) {
    const oct = (period, amp) => {
        const x = t / period, i = Math.floor(x), u = x - i, s = (1 - Math.cos(Math.PI * u)) / 2;
        const v = n => unit(c.cfg.seed, c.wr, 'drift', period, n) * 2 - 1;
        return lerp(v(i), v(i + 1), s) * amp;
    };
    return oct(4 * 24 * H, 3.5) + oct(11 * 24 * H, 2.5);
}
/** 0 at the coldest point (around sunrise), 1 at the warmest (mid-afternoon), smooth in between. */
export function dayCurve(sod, sun, spd) {
    const lo = sun.sunrise, hi = lerp(spd / 2, sun.sunset, 0.45);
    if (sod >= lo && sod <= hi) return (1 - Math.cos(Math.PI * (sod - lo) / Math.max(1, hi - lo))) / 2;
    const span = spd - (hi - lo), x = ((sod - hi) % spd + spd) % spd;
    return (1 + Math.cos(Math.PI * x / span)) / 2;
}
function skyEffect(c, st, t) {
    // Effects ease in over the first 1.5 hours of a stretch so the temperature does not jump.
    const a = c.cfg.skies[st.sky], b = c.cfg.skies[st.prev?.sky] ?? a, k = clamp((t - st.start) / (1.5 * H), 0, 1);
    return { cloud: lerp(b.cloud ?? 0, a.cloud ?? 0, k), temp: lerp(b.temp ?? 0, a.temp ?? 0, k), humidity: lerp(b.humidity ?? 0, a.humidity ?? 0, k) };
}
function airAt(c, t, st = stretchAt(c, t)) {
    const s = seasonFor(c, t), sun = sunTimes(c, s.di.year, s.f), sod = t - Math.floor(t / c.spd) * c.spd;
    const fx = skyEffect(c, st, t), curve = dayCurve(sod, sun, c.spd);
    const mean = (s.blend.high + s.blend.low) / 2, swing = (s.blend.high - s.blend.low) * (1 - 0.55 * fx.cloud);
    const temp = mean + (curve - 0.5) * swing + fx.temp + drift(c, t);
    const humidity = clamp(s.blend.humidity + fx.humidity - 12 * (curve - 0.5) * (1 - fx.cloud), 5, 100);
    return { temp, humidity, season: s, sun, sod, st };
}

// ---- precipitation, feels-like
/** "rain" above 36°F, "sleet" from 30 to 36°F, "snow" below 30°F. */
export function precipForm(tempC) { const f = cToF(tempC); return f > 36 ? 'rain' : f >= 30 ? 'sleet' : 'snow'; }
/** Feels-like °C: NWS wind chill below 50°F (wind above 3 mph), Rothfusz heat index at 80°F+ and 40%+ humidity. */
export function feelsLike(tempC, mph, humidity) {
    const T = cToF(tempC);
    if (T <= 50 && mph > 3) return fToC(35.74 + 0.6215 * T - 35.75 * mph ** 0.16 + 0.4275 * T * mph ** 0.16);
    if (T >= 80 && humidity >= 40) {
        const R = humidity;
        return fToC(-42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R
            + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R);
    }
    return tempC;
}

// ---- ground: replay the weather hour by hour over the last weeks (including before the game started)
const SNOW_CM = 1.2, WET_RAIN = 0.12;
/** {wetness 0..1, snow cm, icy bool} at time t. */
export function groundAt(c, t, stepH = 1) {
    let wet = 0, snow = 0, icy = false;
    const step = stepH * H;
    for (let x = t - SNOW_LOOKBACK; x <= t; x += step) {
        const st = stretchAt(c, x), a = airAt(c, x, st), sky = c.cfg.skies[st.sky], wind = c.cfg.winds[st.wind] ?? {};
        const p = (sky.precip ?? 0) * stepH, form = precipForm(a.temp);
        if (p > 0) {
            if (form === 'rain') wet += WET_RAIN * p;
            else if (form === 'sleet') { wet += WET_RAIN * p * 0.6; snow += SNOW_CM * p * 0.2; }
            else snow += SNOW_CM * p;
        }
        if (a.temp > 0 && snow > 0) {
            const sunny = a.sod > a.sun.sunrise && a.sod < a.sun.sunset ? 1 - (sky.cloud ?? 0) : 0;
            const melt = Math.min(snow, (0.12 * a.temp + 0.3 * sunny) * stepH);
            snow -= melt; wet += 0.03 * melt;
        }
        if (p <= 0) {
            const sun = a.sod > a.sun.sunrise && a.sod < a.sun.sunset ? 1 - (sky.cloud ?? 0) : 0;
            let dry = 0.004 + 0.02 * sun + 0.0015 * Math.max(0, a.temp) + (wind.dry ?? 0) - 0.0002 * Math.max(0, a.humidity - 60);
            if (snow > 0.5 || a.temp < 0) dry *= 0.3;
            wet -= Math.max(0.001, dry) * stepH;
        }
        wet = clamp(wet, 0, 1);
        if (a.temp < 0 && wet > 0.12) icy = true; else if (a.temp > 1 || wet <= 0.05) icy = false;
    }
    return { wetness: wet, snow, icy };
}

// ---- the public answer
/**
 * Weather in weather region `wr` at absolute game seconds `t` (see absSeconds). Returns
 * {sky, wind, precip: form|null, temp, feels, humidity, ground, season: {name, phase}, light, sunrise, sunset, label}
 * with temperatures in °C.
 */
export function weatherAt(cfg, wr, t, cal = GREGORIAN, opts = {}) {
    const c = ctx(cfg, wr, cal), st = stretchAt(c, t), a = airAt(c, t, st), sky = cfg.skies[st.sky], wind = cfg.winds[st.wind] ?? {};
    const precip = (sky.precip ?? 0) > 0 ? precipForm(a.temp) : null;
    const lt = light(a.sod, a.sun, c.spd);
    const label = (precip && precip !== 'rain' && sky[`label_${precip}`]) || ((lt === 'night') && sky.label_night) || sky.label || st.sky;
    return { sky: st.sky, wind: st.wind, precip, label, temp: a.temp, humidity: Math.round(a.humidity), feels: feelsLike(a.temp, wind.mph ?? 0, a.humidity),
        ground: opts.ground === false ? null : groundAt(c, t), season: { name: a.season.name, phase: a.season.phase, weights: a.season.weights },
        light: lt, sunrise: a.sun.sunrise, sunset: a.sun.sunset, stretch: { start: st.start, end: st.end } };
}
/** Year-average temperature of a climate (°C), used for enclosed places. */
export const climateMean = cl => { const s = Object.values(cl.seasons); return s.reduce((a, x) => a + (x.high + x.low) / 2, 0) / s.length; };

// ---- exposure and words
export const INSULATION = Object.freeze({ drafty: 0.3, normal: 0.6, cozy: 0.85 });
/** Inside temperature (°C) of a sheltered room: closes `insulation` of the gap to indoor_temp, else a few degrees above outside. */
export function indoorTemp(outside, indoor, insulation = 'normal') {
    if (indoor === null || indoor === undefined) return outside + 3;
    return outside + (indoor - outside) * (INSULATION[insulation] ?? INSULATION.normal);
}
export const feelWord = c => { const f = cToF(c); return f < 20 ? 'bitter' : f < 32 ? 'freezing' : f < 45 ? 'cold' : f < 55 ? 'cool' : f < 65 ? 'mild' : f < 78 ? 'warm' : f < 90 ? 'hot' : 'sweltering'; };
export function fmtTemp(c, u = 'F') { return u === 'C' ? `${Math.round(c)}°C` : `${Math.round(cToF(c))}°F`; }
export function groundWords(g, tempC) {
    if (!g) return '';
    const w = [];
    if (g.snow >= 15) w.push('deep snow'); else if (g.snow >= 3) w.push('snow on the ground'); else if (g.snow >= 0.5) w.push('a dusting of snow');
    if (g.snow >= 0.5 && tempC > 0.5 && g.wetness > 0.1) w.push('slushy');
    else if (g.snow < 0.5) { if (g.wetness > 0.6) w.push('muddy, puddles'); else if (g.wetness > 0.3) w.push('wet'); else if (g.wetness > 0.12) w.push('damp'); }
    if (g.icy) w.push(g.wetness > 0.5 ? 'icy' : 'icy in patches');
    return w.join(', ');
}
const seasonWord = s => `${s.phase === 'mid' ? '' : `${s.phase} `}${s.name.replace(/_/g, ' ')}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a place feels like now. place = {weather_region, exposure, indoor_temp?, insulation?, temp_offset?, fixed_weather?}
 * (temperatures °C). Returns {exposure, line (narrator), short (footer/map), outside?, inside_temp?}.
 */
export function placeWeather(cfg, place, t, cal = GREGORIAN) {
    const u = cfg.unit ?? 'F', exp = place?.exposure ?? 'outdoor', off = place?.temp_offset ?? 0;
    if (exp === 'fixed') {
        const fw = place.fixed_weather ?? {};
        const tp = fw.temp ?? null;
        return { exposure: exp, line: `Weather here: ${fw.condition ?? 'unchanging'}${tp !== null ? `, ${fmtTemp(tp, u)}` : ''}.`, short: `${fw.condition ?? 'Unchanging'}${tp !== null ? ` · ${fmtTemp(tp, u)}` : ''}`, inside_temp: tp };
    }
    const wr = place?.weather_region;
    if (!wr || !cfg.regions[wr]) return null;
    if (exp === 'enclosed') {
        const tp = place.indoor_temp ?? climateMean(cfg.regions[wr].climate) + off;
        return { exposure: exp, line: `Temperature here: ${fmtTemp(tp, u)}, ${feelWord(tp)} and still; no weather reaches this place.`, short: fmtTemp(tp, u), inside_temp: tp };
    }
    const w = weatherAt(cfg, wr, t, cal);
    w.temp += off; w.feels += off;
    const g = groundWords(w.ground, w.temp), wind = cfg.winds[w.wind]?.label ?? '';
    const feels = Math.abs(cToF(w.feels) - cToF(w.temp)) >= 3 ? ` (feels like ${fmtTemp(w.feels, u)})` : '';
    const sentence = `${w.label}${wind ? `, ${wind}` : ''}, ${fmtTemp(w.temp, u)}${feels}, ${feelWord(w.feels)}, ${w.humidity}% humidity.${g ? ` Underfoot: ${g}.` : ''} ${cap(seasonWord(w.season))}.`;
    if (exp === 'sheltered') {
        const inside = indoorTemp(w.temp, place.indoor_temp, place.insulation);
        return { exposure: exp, outside: w, inside_temp: inside,
            line: `Weather (outside): ${sentence} Inside, sheltered from the wind and rain: ${fmtTemp(inside, u)}, ${feelWord(inside)}.`,
            short: `${w.label} outside · ${fmtTemp(inside, u)} inside` };
    }
    return { exposure: exp, outside: w, line: `Weather: ${sentence}`, short: `${w.label}${wind ? `, ${wind}` : ''} · ${fmtTemp(w.temp, u)}` };
}
