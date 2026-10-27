// Game time: calendars, dates and durations. Pure functions, shared by the server plugin, the map window and the
// extension (served at /api/plugins/worldscrawl/ui/calendar.mjs). The clock is always a number of elapsed seconds since
// a world's start_date; this module turns that into a date and back.
//
// Calendar shape (world.json "calendar", optional; default = modern Gregorian):
//   { hours_per_day: 24, days_of_week: ["Monday", ...], months: [{ name, days, leap_every?, leap_days? }] }
// A week is as long as days_of_week. A year is all its months added up. Hours, minutes and seconds are fixed (60/60).
// Leap rules are per month: in years divisible by leap_every the month gets leap_days extra days (default 1).
// (No century exceptions: the default calendar is Gregorian with a leap day every 4th year.)

export const GREGORIAN = Object.freeze({
    hours_per_day: 24,
    days_of_week: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    months: [
        { name: 'January', days: 31 }, { name: 'February', days: 28, leap_every: 4, leap_days: 1 },
        { name: 'March', days: 31 }, { name: 'April', days: 30 }, { name: 'May', days: 31 }, { name: 'June', days: 30 },
        { name: 'July', days: 31 }, { name: 'August', days: 31 }, { name: 'September', days: 30 }, { name: 'October', days: 31 },
        { name: 'November', days: 30 }, { name: 'December', days: 31 },
    ],
    // Optional: index in days_of_week of day 1 of month 1 of year 1 (default 0). 6 makes weekdays match real dates from
    // 1 Mar 1900 to 28 Feb 2100 (no century exceptions here, so dates outside that drift from the real calendar).
    first_weekday: 6,
});
export const DEFAULT_START = Object.freeze({ year: 1, month: null, day: 1, time: '08:00' }); // month null = first month

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = v => Number.isInteger(v) && v > 0;
const div = (y, n) => posInt(n) && y % n === 0;

/** Throws Error with a readable message when a calendar is malformed; returns the calendar (GREGORIAN for null/undefined). */
export function checkCalendar(cal, where = 'calendar') {
    if (cal === undefined || cal === null) return GREGORIAN;
    if (!isObj(cal)) throw new Error(`${where}: must be an object`);
    if (!posInt(cal.hours_per_day)) throw new Error(`${where}: "hours_per_day" must be a whole number above 0`);
    if (!Array.isArray(cal.days_of_week) || !cal.days_of_week.length || !cal.days_of_week.every(d => typeof d === 'string' && d.trim())) throw new Error(`${where}: "days_of_week" must be a non-empty list of names`);
    if (!Array.isArray(cal.months) || !cal.months.length) throw new Error(`${where}: "months" must be a non-empty list`);
    const seen = new Set();
    cal.months.forEach((m, i) => {
        const w = `${where}: month #${i + 1}`;
        if (!isObj(m) || typeof m.name !== 'string' || !m.name.trim()) throw new Error(`${w}: needs a "name"`);
        if (seen.has(m.name.toLowerCase())) throw new Error(`${w}: the name "${m.name}" is used twice`);
        seen.add(m.name.toLowerCase());
        if (!posInt(m.days)) throw new Error(`${w} (${m.name}): "days" must be a whole number above 0`);
        for (const k of ['leap_every']) if (k in m && !posInt(m[k])) throw new Error(`${w} (${m.name}): "${k}" must be a whole number above 0`);
        if ('leap_days' in m && !(Number.isInteger(m.leap_days) && m.leap_days >= 0)) throw new Error(`${w} (${m.name}): "leap_days" must be a whole number`);
    });
    if ('first_weekday' in cal && !(Number.isInteger(cal.first_weekday) && cal.first_weekday >= 0)) throw new Error(`${where}: "first_weekday" must be a whole number`);
    return cal;
}

export const secondsPerDay = cal => cal.hours_per_day * 3600;
/** Days month m (object) has in year y. */
export function monthDays(m, y) {
    if (!posInt(m.leap_every) || !div(y, m.leap_every)) return m.days;
    return m.days + (m.leap_days ?? 1);
}
export const yearDays = (cal, y) => cal.months.reduce((s, m) => s + monthDays(m, y), 0);

/** Day number (0 = day 1 of month 1 of year 1) for {year, month index, day}. Years before 1 are not supported. */
function dayNumber(cal, year, mi, day) {
    let n = 0;
    for (let y = 1; y < year; y++) n += yearDays(cal, y);
    for (let i = 0; i < mi; i++) n += monthDays(cal.months[i], year);
    return n + day - 1;
}

/** Parse "HH:MM" or "HH:MM:SS" into seconds of the day. */
export function parseClock(t, cal = GREGORIAN) {
    const m = /^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(t ?? ''));
    if (!m) throw new Error(`time must look like "08:00", got ${JSON.stringify(t)}`);
    const [h, mi, s] = [+m[1], +m[2], +(m[3] ?? 0)];
    if (h >= cal.hours_per_day || mi > 59 || s > 59) throw new Error(`time ${JSON.stringify(t)} is outside the day`);
    return h * 3600 + mi * 60 + s;
}

/** Validate a start_date against a calendar; returns {year, mi, day, secs}. */
export function checkStart(sd, cal = GREGORIAN, where = 'start_date') {
    sd = sd ?? DEFAULT_START;
    if (!isObj(sd)) throw new Error(`${where}: must be an object like {"year": 1247, "month": "${cal.months[0].name}", "day": 1, "time": "08:00"}`);
    const year = sd.year ?? 1;
    if (!posInt(year)) throw new Error(`${where}: "year" must be a whole number above 0`);
    const mname = sd.month ?? cal.months[0].name;
    const mi = cal.months.findIndex(m => m.name.toLowerCase() === String(mname).toLowerCase());
    if (mi < 0) throw new Error(`${where}: there is no month ${JSON.stringify(mname)} in the calendar`);
    const day = sd.day ?? 1;
    if (!posInt(day) || day > monthDays(cal.months[mi], year)) throw new Error(`${where}: ${cal.months[mi].name} ${year} has no day ${JSON.stringify(day)}`);
    let secs;
    try { secs = parseClock(sd.time ?? '00:00', cal); } catch (e) { throw new Error(`${where}: ${e.message}`); }
    return { year, mi, day, secs };
}

const pad = n => String(n).padStart(2, '0');

/**
 * The date `elapsed` seconds after `start` (start_date object). Returns
 * {year, month, month_index, day, weekday, weekday_index, hour, minute, second, time "HH:MM", part, day_number}.
 */
export function dateAt(elapsed = 0, start = null, cal = null) {
    cal = checkCalendar(cal);
    const s = checkStart(start, cal);
    const spd = secondsPerDay(cal);
    const total = dayNumber(cal, s.year, s.mi, s.day) * spd + s.secs + Math.max(0, Math.floor(Number(elapsed) || 0));
    let dn = Math.floor(total / spd), sod = total - dn * spd;
    const absDay = dn;
    let year = 1;
    for (let yd = yearDays(cal, year); dn >= yd; yd = yearDays(cal, year)) { dn -= yd; year++; }
    let mi = 0;
    for (let md = monthDays(cal.months[0], year); dn >= md; md = monthDays(cal.months[mi], year)) { dn -= md; mi++; }
    const week = cal.days_of_week.length;
    const wi = (((absDay + (cal.first_weekday ?? 0)) % week) + week) % week;
    const hour = Math.floor(sod / 3600), minute = Math.floor((sod % 3600) / 60), second = sod % 60;
    return { year, month: cal.months[mi].name, month_index: mi, day: dn + 1, weekday: cal.days_of_week[wi], weekday_index: wi,
        hour, minute, second, time: `${pad(hour)}:${pad(minute)}`, part: partOfDay(sod, cal), day_number: absDay };
}

/** start_date object for the date `elapsed` seconds after `start` (what a save bakes in). */
export function advanceStart(start, elapsed, cal = null) {
    const d = dateAt(elapsed, start, cal);
    return { year: d.year, month: d.month, day: d.day, time: d.second ? `${d.time}:${pad(d.second)}` : d.time };
}

/** Elapsed seconds from `start` to the date `to` (both start_date objects; to must not be earlier). */
export function secondsBetween(start, to, cal = null) {
    cal = checkCalendar(cal);
    const a = checkStart(start, cal), b = checkStart(to, cal), spd = secondsPerDay(cal);
    return (dayNumber(cal, b.year, b.mi, b.day) - dayNumber(cal, a.year, a.mi, a.day)) * spd + b.secs - a.secs;
}

// Parts of the day, as fractions of the day (scaled to hours_per_day): on a 24-hour day night is 21:00-05:00,
// dawn 05:00-07:00, morning 07:00-12:00, afternoon 12:00-17:00, evening 17:00-21:00.
export const DAY_PARTS = [[5 / 24, 'night'], [7 / 24, 'dawn'], [12 / 24, 'morning'], [17 / 24, 'afternoon'], [21 / 24, 'evening'], [1, 'night']];
export function partOfDay(secondOfDay, cal = GREGORIAN) {
    const f = secondOfDay / secondsPerDay(cal);
    return DAY_PARTS.find(([end]) => f < end)?.[1] ?? 'night';
}

const ordinal = n => { const t = n % 100, o = n % 10; return `${n}${t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th'}`; };
/** "Tuesday morning, 12th of April, year 1247 (08:00)" */
export function describeDate(d) {
    return `${d.weekday} ${d.part}, ${ordinal(d.day)} of ${d.month}, year ${d.year} (${d.time})`;
}
/** Short form for footers: "Tue 12 Apr 1247, 08:00 (morning)" style, using the first three letters of names. */
export function shortDate(d) {
    const ab = s => (s.length > 4 ? s.slice(0, 3) : s);
    return `${ab(d.weekday)} ${d.day} ${ab(d.month)} ${d.year}, ${d.time} (${d.part})`;
}

/** Parse a travel time like "2h", "90m", "1h30m", "45s", "1h 5m 10s" (or a plain number of seconds) into seconds. */
export function parseDuration(v) {
    if (Number.isInteger(v) && v >= 0) return v;
    const s = String(v ?? '').trim().toLowerCase();
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(s);
    if (!s || !m || !(m[1] || m[2] || m[3])) throw new Error(`travel time must look like "2h", "90m", "1h30m" or "45s", got ${JSON.stringify(v)}`);
    return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
}
/** Seconds -> "2h", "1h30m", "5m", "45s". */
export function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s || !sec ? `${s}s` : ''}`;
}

// Exits without travel_time: a step inside one subregion (a building's rooms, along one street) takes 1 minute,
// into another subregion of the same region 3 minutes, into another region 10 minutes.
export const DEFAULT_TRAVEL = Object.freeze({ same_subregion: 60, same_region: 180, other_region: 600 });
export function defaultTravel(fromAddress, toAddress) {
    const [fr, fs] = String(fromAddress).split(/[:/]/), [tr, ts] = String(toAddress).split(/[:/]/);
    if (fr !== tr) return DEFAULT_TRAVEL.other_region;
    return fs === ts ? DEFAULT_TRAVEL.same_subregion : DEFAULT_TRAVEL.same_region;
}

/**
 * Game seconds stamped on chat messages after index `after` (the latest rebase; -1 = all): travel
 * (extra.worldscrawl_move.seconds) plus waiting/sleeping (extra.worldscrawl_wait.seconds). Both live on the message, so
 * deleting the message undoes them and swipes keep them.
 */
export function sumTravel(chat, after = -1) {
    let sum = 0;
    (chat ?? []).forEach((m, i) => {
        if (i <= after) return;
        for (const k of ['worldscrawl_move', 'worldscrawl_wait']) { const s = m?.extra?.[k]?.seconds; if (Number.isFinite(s) && s > 0) sum += s; }
    });
    return sum;
}

// ---- Waiting and sleeping. "/ws-wait 2h", "/ws-wait 1h30m", "/ws-wait 2d", "/ws-wait until dawn", "/ws-wait until 14:30".
export const WAIT_TARGETS = ['dawn', 'morning', 'noon', 'dusk', 'evening', 'night', 'midnight'];
export const SLEEP_DEFAULT = 8 * 3600;
/** Parse wait arguments: {seconds} for a duration (days allowed: "2d", "1d6h"), {until} for a time of day; throws. */
export function parseWait(text, cal = GREGORIAN) {
    const s = String(text ?? '').trim().toLowerCase().replace(/^for\s+/, '');
    if (!s) throw new Error('say how long, e.g. "2h", "1h30m", or "until morning"');
    const u = /^(?:until|till|til|to)\s+(.+)$/.exec(s);
    if (u) {
        const t = u[1].trim().replace(/^the\s+/, '');
        if (t === 'sunrise') return { until: 'dawn' };
        if (t === 'sunset') return { until: 'dusk' };
        if (WAIT_TARGETS.includes(t)) return { until: t };
        parseClock(t, cal);
        return { until: t };
    }
    const d = /^(\d+)\s*d(?:ays?)?\s*(.*)$/.exec(s);
    const days = d ? +d[1] * secondsPerDay(cal) : 0, rest = d ? d[2].trim() : s;
    const n = rest ? (/^\d+$/.test(rest) ? +rest * 3600 : parseDuration(rest.replace(/hours?|hrs?/g, 'h').replace(/minutes?|mins?/g, 'm').replace(/\s+/g, ''))) : 0;
    if (days + n <= 0) throw new Error('the wait must be longer than zero');
    return { seconds: days + n };
}
/**
 * Seconds from game time `elapsed` until the next `target` (a WAIT_TARGETS word or "HH:MM") - always in the future,
 * rolling to the next day when today's has passed. sunAt(elapsedNearNoonOfThatDay) may return {sunrise, sunset}
 * (seconds of the day, from the weather's daylight); without it dawn/dusk use the day-part boundaries.
 */
export function untilSeconds(elapsed, target, start = null, cal = null, sunAt = null) {
    cal = checkCalendar(cal);
    const spd = secondsPerDay(cal), d = dateAt(elapsed, start, cal);
    const sod = d.hour * 3600 + d.minute * 60 + d.second, dayStart = Math.max(0, Math.floor(elapsed)) - sod;
    const frac = f => Math.round(f * spd);
    for (let k = 0; k < 3; k++) {
        const day0 = dayStart + k * spd;
        let sun = null; try { sun = sunAt?.(Math.max(0, day0 + spd / 2)) ?? null; } catch { sun = null; }
        const okSun = sun && Number.isFinite(sun.sunrise) && Number.isFinite(sun.sunset) && sun.sunset > sun.sunrise;
        const at = { dawn: okSun ? sun.sunrise : frac(6 / 24), morning: okSun ? Math.min(sun.sunrise + 3600, frac(0.5)) : frac(7 / 24),
            noon: frac(0.5), dusk: okSun ? sun.sunset : frac(19 / 24), evening: frac(17 / 24), night: frac(21 / 24), midnight: spd }[target]
            ?? parseClock(target, cal);
        const t = day0 + Math.round(at);
        if (t > elapsed) return t - Math.floor(elapsed);
    }
    throw new Error(`could not find the next ${target}`);
}

