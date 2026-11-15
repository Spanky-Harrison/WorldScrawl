// Shared by the server plugin and the extension (served at /api/plugins/worldscrawl/shared/npc.mjs). Pure: no DOM, Node or fetch.
// NPC records, stamps and context slices. The server stores nothing during play: a cast file is the
// template, and every change is a stamp on the message (extra.worldscrawl_npc), per swipe.
// A schedule address matches a room still on the live map. A relocate map is followed only when that address is gone. A bad entry is marked, never thrown.
import { slug } from './ids.mjs';

export const MEMORY_CAP = 8;

export const DISPOSITIONS = ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'];

export const NPC_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Appearance (docs/npc-design.md): 2-4 sentences, physical only. A phase-1 bridge; phase 2 is a structured body and wardrobe. */
export const APPEARANCE_MAX = 800;

export const HISTORY_MAX = 1200;

export const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Lowercase, punctuation to spaces. */
export const normName = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A name as a whole word in text. */
export function nameIn(text, name) {
    const n = normName(name);
    if (!n) return false;
    return ` ${normName(text)} `.includes(` ${n} `);
}

/** Lenient text key: exact, or the one key that is a whole word in the answer. */
export function matchEnum(text, keys) {
    const n = normName(text);
    if (!n) return null;
    const exact = keys.find(k => normName(k) === n);
    if (exact) return exact;
    const hits = keys.filter(k => ` ${n} `.includes(` ${normName(k)} `));
    return hits.length === 1 ? hits[0] : null;
}

/** An id for a person met in play. A clash gets -2, -3, ... */
export function freeId(name, taken = new Set()) {
    let id = slug(name, { max: 48, fallback: 'npc' });
    if (!NPC_ID.test(id)) id = 'npc';
    if (!taken.has(id)) return id;
    let n = 2;
    while (taken.has(`${id}-${n}`)) n++;
    return `${id}-${n}`;
}

export function str(v, max) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || (max && t.length > max)) return null;
    return t;
}

/**
 * Where a schedule address is on the live map. `exists` means that address is a room there.
 * A room that is still on the map matches (`here`), even if a patch also lists it in `relocate`
 * (a rename can leave a leftover redirect). Display names are not consulted.
 * Relocate is followed only when the address is gone: a real move, merge, or delete. The walk
 * stops at the first room that exists (`merged`). If the chain runs out, the stop is `expired`.
 * If it was never on the map and nothing redirects it, `missing`. Neighbor, subregion entrance,
 * and world-start fallbacks are not used: a stop that is truly gone does not land somewhere else.
 */
export function resolveSchedulePlace(place, { exists, relocate = {} } = {}) {
    const onMap = a => typeof a === 'string' && !!a && !!exists?.(a);
    if (onMap(place)) return { ok: true, address: place, how: 'here' };
    let a = place;
    const seen = new Set();
    while (typeof a === 'string' && a && !onMap(a) && relocate[a] && !seen.has(a) && seen.size < 32) { seen.add(a); a = relocate[a]; }
    if (onMap(a) && a !== place) return { ok: true, address: a, how: 'merged' };
    if (seen.size || (typeof place === 'string' && Object.prototype.hasOwnProperty.call(relocate, place))) return { ok: false, how: 'expired', from: place };
    return { ok: false, how: 'missing', from: place };
}

/**
 * What a schedule `near` string points at, in order: a real map address (room, subregion `region:sub`, or region id),
 * a stub-region id, or plain text. `index` is {rooms, subs, regions, stubs (Map), nameOf, exists, relocate}.
 * A single word that matches nothing is `warn: 'typo'` (a load warning). Multi-word text is `warn: 'note'`
 * (an inspector note only: "not in the list").
 */
export function resolveNear(near, index = null) {
    const raw = typeof near === 'string' ? near.trim() : '';
    if (!raw) return { kind: 'none' };
    const nameOf = index?.nameOf ?? (a => a);
    if (typeof index?.exists === 'function') {
        const r = resolveSchedulePlace(raw, { exists: index.exists, relocate: index.relocate ?? {} });
        if (r.ok) return { kind: 'map', scope: 'room', address: r.address, name: nameOf(r.address) };
    } else if (index?.rooms?.has?.(raw)) return { kind: 'map', scope: 'room', address: raw, name: nameOf(raw) };
    if (index?.subs?.has?.(raw)) return { kind: 'map', scope: 'subregion', address: raw, name: nameOf(raw) };
    if (index?.regions?.has?.(raw)) return { kind: 'map', scope: 'region', address: raw, name: nameOf(raw) };
    const stub = index?.stubs?.get?.(raw);
    if (stub && !index?.regions?.has?.(raw)) return { kind: 'stub', id: raw, name: stub.name || raw, about: stub.about || '', lore: stub.lore || '' };
    return { kind: 'text', text: raw, warn: /\s/.test(raw) ? 'note' : 'typo' };
}

/** "HH:MM" -> minutes, or null. */
export function parseHm(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

// ---- Schedules: "might be at" entries (docs/npc-design.md). An entry with `might` is a time block with options and
// percent odds; every other entry is "is at" (certain). Every roll is seeded by the person, the entry and an actual
// start time (absolute game minutes: day * minutes-per-day + minute of the day), so swipes and reloads change nothing.

/**
 * FNV-1a of the seed with a final mix (murmur3's fmix32), unsigned 32-bit. Stable for the same seed. The final mix matters:
 * plain FNV-1a barely spreads a change early in the seed into the low digits, so two entries that differ only in their
 * activity rolled the same numbers block after block.
 */
export function hashScore(seed) {
    let h = 2166136261;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}
/** 0-99, stable for the same seed. */
export const hashRoll = seed => hashScore(seed) % 100;

export const NOWHERE = 'nowhere';
/** One might option: "riverton:streets/market_lane", "the tannery(30)", "nowhere(80)" -> {text, pct (an integer percent or null)}; null when empty or the number is not 0-100. */
export function parseMightOption(raw) {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    const m = /^(.*?)\s*\(\s*(\d{1,3})\s*%?\s*\)$/.exec(t);
    const text = (m ? m[1] : t).trim();
    if (!text || text.length > 200) return null;
    if (m && +m[2] > 100) return null;
    return { text, pct: m ? +m[2] : null };
}
export const isNowhere = text => normName(text) === NOWHERE;

/**
 * The percent table for a list of parsed options: numbered options keep their number; the unnumbered ones split what is
 * left of 100 evenly, and the rounding remainder goes to the first of them. A total under 100 leaves the rest as nowhere.
 * {options: [{text, pct, share}], total, broken, problems, warnings}: over 100 is broken; unnumbered options with nothing left get 0 and a warning.
 */
export function mightTable(parsed) {
    const options = (parsed ?? []).filter(Boolean).map(o => ({ text: o.text, pct: o.pct ?? null, share: o.pct ?? 0 }));
    const problems = [], warnings = [];
    const numbered = options.filter(o => o.pct != null).reduce((a, o) => a + o.pct, 0);
    if (numbered > 100) problems.push(`the odds add up to ${numbered}%, over 100`);
    const loose = options.filter(o => o.pct == null);
    const left = Math.max(0, 100 - numbered);
    if (loose.length) {
        if (!left) warnings.push(`${loose.map(o => o.text).join(', ')}: no odds left over, so 0%`);
        const each = Math.floor(left / loose.length);
        loose.forEach((o, i) => { o.share = each + (i === 0 ? left - each * loose.length : 0); });
    }
    const total = options.reduce((a, o) => a + o.share, 0);
    return { options, total, broken: problems.length > 0, problems, warnings };
}

/** The option whose band holds `roll` (0-99), walking the options in listed order; null past the last band (nowhere). */
export function pickFromTable(options, roll) {
    let acc = 0;
    for (const o of options ?? []) { acc += o.share ?? 0; if (roll < acc) return o; }
    return null;
}

/** A stable string of a might entry (its options, times, wandering and activity): part of every seed, so an edit re-rolls. */
export const mightKey = e => JSON.stringify([e?.might ?? [], e?.from ?? '', e?.to ?? '', !!e?.wandering, e?.activity ?? '']);

/** Minutes in a block from `fromMin` to `toMin` (a block that passes midnight wraps; equal times are a whole day). */
export function blockSpan(fromMin, toMin, dayMinutes = 1440) {
    const d = ((toMin - fromMin) % dayMinutes + dayMinutes) % dayMinutes;
    return d || dayMinutes;
}
/** The actual start of the block holding absolute minute `now`: the most recent time the clock passed `fromMin`, at or before now. */
export function blockStartOf(fromMin, now, dayMinutes = 1440) {
    const tod = ((now % dayMinutes) + dayMinutes) % dayMinutes;
    return now - (((tod - fromMin) % dayMinutes) + dayMinutes) % dayMinutes;
}

/** One wandering segment starting at absolute minute `s`: its length is 15, 30, 45 or 60 minutes, clipped at `blockEnd`. */
export function wanderSegment(base, s, blockEnd) {
    const len = 15 * (1 + (hashRoll(`len|${base}|${s}`) % 4));
    return { start: s, end: Math.min(s + len, blockEnd), roll: hashRoll(`place|${base}|${s}`) };
}
/**
 * The wandering chain of a block, from `blockStart`, up to the segment holding absolute minute `t` (or the block end).
 * `base` is `${id}|${mightKey}`. Each segment seeds from its own start. Segments are contiguous: the next starts where one ends.
 */
export function wanderChain(base, blockStart, blockEnd, t = blockEnd - 1) {
    const out = [];
    let s = blockStart;
    while (s < blockEnd && out.length < 400) {
        const seg = wanderSegment(base, s, blockEnd);
        out.push(seg);
        if (t < seg.end) break;
        s = seg.end;
    }
    return out;
}

/** The highest-scoring room of `rooms` for this person, entry and start: {address, of} or null when there is none. */
export function areaPick(base, s, rooms) {
    let best = null, top = -1, of = 0;
    for (const r of rooms ?? []) {
        of++;
        const score = hashScore(`area|${base}|${s}|${r}`);
        if (score > top || (score === top && r < best)) { top = score; best = r; }
    }
    return best ? { address: best, of } : null;
}

/** Whether two time windows (minutes, [from, to), wrapping midnight; equal ends are a whole day) share any minute. */
export function windowsOverlap(a0, a1, b0, b1, dayMinutes = 1440) {
    const inside = (m, f, t) => { if (f === t) return true; return f < t ? m >= f && m < t : m >= f || m < t; };
    return inside(b0, a0, a1, dayMinutes) || inside(a0, b0, b1, dayMinutes);
}

const MIGHT_KEYS = ['might', 'activity', 'from', 'to', 'wandering', 'importance'];
/**
 * A might entry as both sides read it (the server's validateEntry and the chat's npc_schedule stamp): the parsed options and
 * percent table, the times, wandering, and `authored` (the entry as written, for export). Place checks are the caller's.
 * {entry, problems (break it), warnings (load notes)}.
 */
export function readMightEntry(e) {
    const problems = [], warnings = [];
    const list = Array.isArray(e?.might) ? e.might : [];
    if (!Array.isArray(e?.might)) problems.push('"might" must be a list of places');
    const parsed = [];
    for (const raw of list) {
        const o = parseMightOption(raw);
        if (!o) warnings.push(`option ${JSON.stringify(raw)} is not a place with an optional (percent)`);
        else parsed.push(o);
    }
    if (Array.isArray(e?.might) && !parsed.length) problems.push('"might" needs at least one option');
    const table = mightTable(parsed);
    problems.push(...table.problems);
    warnings.push(...table.warnings);
    const activity = str(e?.activity, 200) ?? '';
    if (!activity) problems.push('activity is required');
    const fromMin = parseHm(e?.from), toMin = parseHm(e?.to);
    if (fromMin == null) problems.push('from is required and must look like "10:00"');
    if (toMin == null) problems.push('to is required and must look like "13:00"');
    if (e?.wandering != null && typeof e.wandering !== 'boolean') problems.push('wandering must be true or false');
    let importance = null;
    if (e?.importance != null && String(e.importance).trim()) {
        importance = matchEnum(e.importance, ['low', 'normal', 'high']);
        if (!importance) problems.push('importance must be low, normal or high');
    }
    const authored = {};
    for (const k of MIGHT_KEYS) if (e?.[k] !== undefined) authored[k] = k === 'might' && Array.isArray(e.might) ? e.might.slice() : e[k];
    const entry = {
        might: list.filter(x => typeof x === 'string').map(x => x.trim()), options: table.options, activity,
        ...(fromMin != null ? { from: String(e.from).trim() } : {}), ...(toMin != null ? { to: String(e.to).trim() } : {}), fromMin, toMin,
        wandering: e?.wandering === true, importance: importance ?? 'low', authored,
    };
    if (problems.length) Object.assign(entry, { broken: true, problem: problems.join('; ') });
    return { entry, problems, warnings };
}
export const isMight = e => !!e && Array.isArray(e.might);

const hourText = h => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

// ---- Daily patterns (docs/npc-design.md). Remember gives a new person one of these, expanded by the engine into ordinary
// is-at entries and might-be-at blocks. A pick is {pattern, job, job_activity, home, favorites}: job and home are a place
// KEY (a room address, or a stub id from elsewhere.json), "offmap: short text", or null; favorites are up to 3 public room
// or area keys. Engine-made schedules never overlap.
export const PATTERNS = ['day shift', 'night shift', 'passing through'];
export const PICK_PATTERNS = [...PATTERNS, 'unsure'];
export const OFFMAP_MAX = 80;
export const FAVORITES_MAX = 3;
const OFFMAP_RE = /^\s*off[\s-]?map\s*:\s*/i;
/** "offmap: the tannery" -> "the tannery"; null when the text is not off-map text. */
export const offmapText = v => (typeof v === 'string' && OFFMAP_RE.test(v) ? v.replace(OFFMAP_RE, '').trim() : null);
/** The area (subregion, else region) holding room address `a`. */
export const areaOfRoom = a => { const s = String(a ?? ''); return s.includes('/') ? s.slice(0, s.indexOf('/')) : s; };
/** `total` percent split evenly over `spots`, written on each ("a(10)", "b(10)", "c(10)"); the rounding remainder goes to the first. */
export function spotShares(spots, total) {
    const list = (spots ?? []).filter(Boolean);
    if (!list.length) return [];
    const each = Math.floor(total / list.length), rest = total - each * list.length;
    return list.map((s, i) => `${s}(${each + (i === 0 ? rest : 0)})`);
}
/** An is-at entry at place value `v` (a room address, a stub id, "offmap: text" or null) for this window. */
function atEntry(v, activity, from, to, { home = false, importance = null } = {}) {
    const imp = importance ? { importance } : {};
    const off = offmapText(v);
    if (typeof v === 'string' && v && off == null && v.includes(':')) return { place: v, activity, from, to, ...imp };
    const near = off ?? (typeof v === 'string' && v ? v : null);
    return { activity, ...(home ? { where: 'home' } : {}), ...(near ? { near } : {}), from, to, ...imp };
}
/** Free-time spots: the favorites, or with none the area of the job room (on the map), else of the room they were met in. */
function spotsOf(pick, room) {
    if (pick?.favorites?.length) return pick.favorites.slice(0, FAVORITES_MAX);
    const job = pick?.job;
    const onMap = typeof job === 'string' && offmapText(job) == null && job.includes(':');
    const area = areaOfRoom(onMap ? job : room);
    return area ? [area] : [];
}
/** The free-time blocks of each shift: [from, to, total %, wandering]. */
const FREE_BLOCKS = {
    'day shift': [['12:00', '13:00', 30, false], ['18:30', '20:00', 40, true]],
    'night shift': [['14:30', '16:00', 40, true], ['22:00', '23:00', 30, false]],
};
const hhmm = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** Whether `spots` cover `room`: the room itself, or an area (any address above it) holding it. */
export const spotsCover = (spots, room) => spots.some(a => a === room || String(room).startsWith(`${a}/`));
/**
 * The met-place guard: when they were met (`room`, `minutes`) inside one of the shift's free-time blocks and the spots
 * do not already cover that room, it joins that block's options; the block's [from, to] or null. Passing through: null.
 */
export function metSpotBlock(pick, { room = '', minutes = null } = {}) {
    const blocks = pick?.job ? FREE_BLOCKS[pick.pattern] : null;
    if (!blocks || !room || minutes == null) return null;
    const m = ((minutes % 1440) + 1440) % 1440;
    const b = blocks.find(([from, to]) => m >= hhmm(from) && m < hhmm(to));
    if (!b || spotsCover(spotsOf(pick, room), room)) return null;
    return [b[0], b[1]];
}
/**
 * The schedule entries for a pick (docs/npc-design.md, "Daily patterns"). Day shift: the job 08:00-12:00 and 13:00-17:00
 * (high), home 17:00-18:30 and 20:00-08:00, lunch 12:00-13:00 at the spots (30% in all, normal), evening 18:30-20:00 at the
 * spots (40% in all, wandering). Night shift: the job 18:00-22:00 and 23:00-03:00 (high), home 03:00-14:30 and 16:00-18:00,
 * a break 22:00-23:00 at the spots (30%, normal), afternoon 14:30-16:00 at the spots (40%, wandering). Anything else (passing
 * through, unsure, no pick) is passingThrough at the met `room` and minute of the day. `room` is where they were met.
 * The met-place guard: met inside a free-time block in a room the spots do not cover, that room joins that block's spots.
 */
export function expandPattern(pick, { room = '', minutes = 0 } = {}) {
    const pattern = pick?.pattern;
    if ((pattern === 'day shift' || pattern === 'night shift') && pick.job) {
        const work = pick.job_activity || 'working', spots = spotsOf(pick, room), met = metSpotBlock(pick, { room, minutes });
        const job = (from, to) => atEntry(pick.job, work, from, to, { importance: 'high' });
        const home = (from, to) => atEntry(pick.home ?? null, 'at home', from, to, { home: true });
        const free = (total, from, to, wandering) => ({ might: spotShares(met?.[0] === from ? [...spots, room] : spots, total), activity: 'out and about', from, to, ...(wandering ? { wandering: true } : {}) });
        const [a, b] = FREE_BLOCKS[pattern];
        if (pattern === 'day shift') return [job('08:00', '12:00'), free(a[2], a[0], a[1], a[3]), job('13:00', '17:00'), home('17:00', '18:30'), free(b[2], b[0], b[1], b[3]), home('20:00', '08:00')];
        return [home('03:00', '14:30'), free(a[2], a[0], a[1], a[3]), home('16:00', '18:00'), job('18:00', '22:00'), free(b[2], b[0], b[1], b[3]), job('23:00', '03:00')];
    }
    return passingThrough(room, minutes, pick);
}
/**
 * The passing-through schedule (the Remember default, and the pattern of that name): one normal might block, the met room
 * at 50% (the rest nowhere), from an hour before the met hour (rounded down) to an hour after; home 20:00-07:00, clipped
 * around the block (so engine-made entries never overlap), at the pick's home when it has one, else off the map; the rest
 * of the day about their own business, off the map. Met at 16:17: 15:00-17:00, home 20:00-07:00. At 21:00: 20:00-22:00,
 * home 22:00-07:00.
 */
export function passingThrough(room, minutes, pick = null) {
    const h = Math.floor((((minutes ?? 0) % 1440) + 1440) % 1440 / 60);
    const block = new Set([(h + 23) % 24, h]);
    const home = new Set([20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6].filter(x => !block.has(x)));
    const runs = [];
    for (const start of [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6]) {
        if (!home.has(start) || home.has((start + 23) % 24)) continue; // a run starts where the hour before is not home
        let end = start;
        while (home.has((end + 1) % 24) && (end + 1) % 24 !== start) end = (end + 1) % 24;
        runs.push(atEntry(pick?.home ?? null, 'at home', hourText(start), hourText(end + 1), { home: true }));
    }
    return [
        { might: [`${room}(50)`], activity: 'out and about', from: hourText(h - 1), to: hourText(h + 1) },
        ...runs,
        { activity: 'about their own business' },
    ];
}

/**
 * Read a pattern pick (the model's JSON answer, or the Remember card's typed fields) against `places`:
 * {rooms: Map(address -> {name, private}), areas: Map(address -> name), stubs: Map(id -> name)}. A key or an exact name
 * (any case) is accepted; job and home are a room or a stub, "offmap: short text" (at most 80 characters), or empty;
 * favorites are rooms or areas. {pick, warnings} or {error}. Lenient (the model): unknown or private favorites and any past
 * three are dropped with a warning, a home that is not a room, a stub or off-map text becomes null (off the map) with a
 * warning, a shift with no job becomes passing through, unsure is passing through; a bad job is still an error. Strict (the
 * player's typed edit): each of those is an error instead, so a bad name shows on the card.
 */
export function readSchedulePick(raw, places = {}, { strict = false } = {}) {
    if (!isObj(raw)) return { error: 'the answer is not a JSON object' };
    const rooms = places.rooms ?? new Map(), areas = places.areas ?? new Map(), stubs = places.stubs ?? new Map();
    const warnings = [];
    let pattern = matchEnum(raw.pattern, PICK_PATTERNS);
    if (!pattern) return { error: `pattern must be one of ${PICK_PATTERNS.join(', ')}` };
    if (pattern === 'unsure') pattern = 'passing through';
    const byName = (text, kinds) => {
        const t = String(text).trim(), n = normName(t);
        if (kinds.includes('room') && rooms.has(t)) return t;
        if (kinds.includes('area') && areas.has(t)) return t;
        if (kinds.includes('stub') && stubs.has(t)) return t;
        const hits = [];
        if (kinds.includes('room')) for (const [a, r] of rooms) if (normName(r?.name) === n) hits.push(a);
        if (kinds.includes('area')) for (const [a, name] of areas) if (normName(name) === n) hits.push(a);
        if (kinds.includes('stub')) for (const [a, name] of stubs) if (normName(name) === n) hits.push(a);
        return hits.length === 1 ? hits[0] : hits.length > 1 ? { ambiguous: hits } : null;
    };
    const place = (label, v) => {
        if (v == null) return { value: null };
        if (typeof v !== 'string') return { error: `${label} must be a place key, "offmap: a few words", or null` };
        const t = v.trim();
        if (!t || /^(null|none|nowhere|unknown|-)$/i.test(t)) return { value: null };
        const off = offmapText(t);
        if (off != null) {
            if (!off) return { error: `${label}: say where after "offmap:"` };
            if (off.length > OFFMAP_MAX) return { error: `${label}: off-map text is at most ${OFFMAP_MAX} characters` };
            return { value: `offmap: ${off}` };
        }
        const hit = byName(t, ['room', 'stub']);
        if (typeof hit === 'string') return { value: hit };
        if (hit?.ambiguous) return { error: `${label} "${t}" matches ${hit.ambiguous.join(', ')}; use the key` };
        if (byName(t, ['area'])) return { error: `${label} "${t}" is an area; name one room in it` };
        return { error: `${label} "${t}" is not in the list (use a key, or "offmap: a few words" for a place off the map)` };
    };
    const job = place('job', raw.job);
    if (job.error) return { error: job.error };
    let home = place('home', raw.home);
    if (home.error) {
        if (strict) return { error: home.error };
        warnings.push(`home dropped (off the map instead): ${home.error}`);
        home = { value: null };
    }
    const favRaw = Array.isArray(raw.favorites) ? raw.favorites : typeof raw.favorites === 'string' ? raw.favorites.split(/[,;\n]/) : raw.favorites == null ? [] : null;
    if (!favRaw) return { error: 'favorites must be a list of place keys' };
    const favorites = [];
    for (const f of favRaw) {
        const t = typeof f === 'string' ? f.trim() : '';
        if (!t) continue;
        const hit = byName(t, ['room', 'area']);
        const why = typeof hit !== 'string' ? (hit?.ambiguous ? `"${t}" matches ${hit.ambiguous.join(', ')}; use the key` : `"${t}" is not in the list`)
            : rooms.get(hit)?.private ? `"${t}" is private; free time goes to public places` : favorites.includes(hit) ? null : favorites.length >= FAVORITES_MAX ? `"${t}": at most ${FAVORITES_MAX} favorites` : '';
        if (why === null) continue;
        if (why) { if (strict) return { error: `favorites: ${why}` }; warnings.push(`favorite dropped: ${why}`); continue; }
        favorites.push(hit);
    }
    if ((pattern === 'day shift' || pattern === 'night shift') && !job.value) {
        if (strict) return { error: `a ${pattern} needs a job: a room, or "offmap: a few words"` };
        warnings.push(`${pattern} with no job, so passing through`);
        pattern = 'passing through';
    }
    const act = str(raw.job_activity, OFFMAP_MAX);
    return { pick: { pattern, job: job.value, job_activity: act && !/^null$/i.test(act) ? act : null, home: home.value, favorites }, warnings };
}

/** A place value as the player reads it: a room or area by name, a stub by name, off-map text, or `none`. */
function placeWords(v, nameOf, none) {
    if (!v) return none;
    const off = offmapText(v);
    if (off != null) return `${off} (off the map)`;
    return nameOf(v) || v;
}
/** One line for the Remember card and the kept note: "Day shift at Common Room, home off the map; free time around Market Lane". */
export function pickSummary(pick, { nameOf = a => a, room = '', minutes = null } = {}) {
    if (!pick) return '';
    const home = `home ${placeWords(pick.home, nameOf, 'off the map')}`;
    if (pick.pattern === 'day shift' || pick.pattern === 'night shift') {
        const met = metSpotBlock(pick, { room, minutes });
        const spots = [...spotsOf(pick, room), ...(met ? [room] : [])].map(a => nameOf(a) || a).join(', ');
        const hours = pick.pattern === 'day shift' ? '08:00–17:00' : '18:00–03:00';
        return `${capWord(pick.pattern)} at ${placeWords(pick.job, nameOf, 'work')} (${hours}${pick.job_activity ? `, ${pick.job_activity}` : ''}), ${home}; free time around ${spots || 'nowhere in particular'}`;
    }
    return `Passing through: maybe around ${room ? nameOf(room) || room : 'where they were met'} for an hour either side of the time they were met, ${home}`;
}
const capWord = s => s.charAt(0).toUpperCase() + s.slice(1);
/** The Remember card's schedule boxes for a pick: [key, label, value, placeholder]. Names show where one place has that name. */
export const SCHEDULE_FIELDS = [
    ['sched_pattern', 'Pattern', 'day shift, night shift or passing through'],
    ['sched_job', 'Job', 'a room, or offmap: a few words (empty for none)'],
    ['sched_home', 'Home', 'a room, or offmap: a few words (empty: off the map)'],
    ['sched_favorites', 'Favorites', 'up to 3 public rooms or areas, comma separated'],
];
/** A pick as the editor's text: {sched_pattern, sched_job, sched_home, sched_favorites}. `label` gives a place's shown text. */
export function pickValues(pick, label = a => a) {
    const one = v => (!v ? '' : offmapText(v) != null ? v : label(v) || v);
    return { sched_pattern: pick?.pattern ?? 'passing through', sched_job: one(pick?.job), sched_home: one(pick?.home), sched_favorites: (pick?.favorites ?? []).map(one).join(', ') };
}
/** The editor's text back to a raw pick (then readSchedulePick, strict). Unchanged boxes keep the pick's own values. */
export function pickFromValues(pick, values = {}, changed = []) {
    const has = k => changed.includes(k);
    return {
        pattern: has('sched_pattern') ? String(values.sched_pattern ?? '') : pick?.pattern ?? 'passing through',
        job: has('sched_job') ? String(values.sched_job ?? '') : pick?.job ?? null,
        job_activity: has('sched_job') ? null : pick?.job_activity ?? null,
        home: has('sched_home') ? String(values.sched_home ?? '') : pick?.home ?? null,
        favorites: has('sched_favorites') ? String(values.sched_favorites ?? '') : [...(pick?.favorites ?? [])],
    };
}

/** A clean cast file from a played NPC (base fields plus facts, memory and disposition). Following stays in the chat. */
export function exportRecord(npc) {
    if (!npc?.id) return null;
    // A file-shaped record (nested personality / appearance, top-level history) reads as its folded form.
    if (isObj(npc.personality)) {
        const p = npc.personality, a = isObj(npc.appearance) ? npc.appearance : {};
        npc = { ...npc, line: p.summary, manner: p.manner, voice: p.speech, looks: a.summary, body: a.body, outfit: a.outfit,
            deep: { ...(npc.deep ?? {}), ...(npc.history ? { history: npc.history } : {}) } };
    }
    const out = { id: npc.id, name: npc.name }; // name-ok: a cast file export
    if (npc.unknownAs) out.unknownAs = npc.unknownAs;
    if (Array.isArray(npc.aliases) && npc.aliases.length) out.aliases = [...npc.aliases];
    out.personality = { summary: npc.line };
    if (npc.manner) out.personality.manner = npc.manner;
    if (npc.voice) out.personality.speech = npc.voice;
    const appearance = {};
    if (npc.looks) appearance.summary = npc.looks;
    if (npc.body) appearance.body = npc.body;
    if (npc.outfit) appearance.outfit = npc.outfit;
    if (Object.keys(appearance).length) out.appearance = appearance;
    if (npc.deep?.history) out.history = npc.deep.history;
    const disposition = {};
    for (const [who, row] of Object.entries(npc.disposition ?? {})) if (row?.value && row.value !== 'unknown') disposition[who] = { value: row.value, ...(row.reason ? { reason: row.reason } : {}) };
    if (Object.keys(disposition).length) out.disposition = disposition;
    if (npc.facts?.length) out.facts = npc.facts.slice();
    if (npc.memory?.length) out.memory = npc.memory.slice();
    const deep = {};
    if (npc.deep?.secrets?.length) deep.secrets = npc.deep.secrets.slice();
    if (npc.deep?.relationships && Object.keys(npc.deep.relationships).length) deep.relationships = { ...npc.deep.relationships };
    if (Object.keys(deep).length) out.deep = deep;
    const schedule = (npc.schedule ?? []).filter(e => e && !e.broken).map(e => {
        if (isMight(e)) return JSON.parse(JSON.stringify(e.authored ?? { might: e.might, activity: e.activity, from: e.from, to: e.to, ...(e.wandering ? { wandering: true } : {}) })); // as authored
        const row = { activity: e.activity };
        if (e.place) row.place = e.place;
        else {
            if (e.where) row.where = e.where;
            if (e.near) row.near = e.near;
        }
        if (e.from) row.from = e.from;
        if (e.to) row.to = e.to;
        if (e.importance) row.importance = e.importance;
        // place first when they have one, so a saved file reads like the other entries
        if (row.place) { const { place, activity, ...rest } = row; return { place, activity, ...rest }; }
        return row;
    });
    if (schedule.length) out.schedule = schedule;
    return out;
}

/**
 * What may be written to a cast file: the base appearance (file plus lasting facts and lasting effects)
 * and lasting facts only. Temporary appearance, temporary facts, and runtime (following, holds, rolls) stay out.
 */
export function authorRecord(npc) {
    if (!npc?.id) return null;
    const base = isObj(npc.base) ? npc.base : null;
    const facts = Array.isArray(npc.facts) ? npc.facts.slice() : npc.facts;
    if (Array.isArray(facts)) {
        for (const t of Array.isArray(npc.temps) ? npc.temps : []) {
            const text = typeof t === 'string' ? t : (t?.text ?? '');
            const i = facts.lastIndexOf(text);
            if (text && i >= 0) facts.splice(i, 1);
        }
    }
    const looks = base ? (base.looks ?? '') : (npc.looks ?? '');
    const body = base ? (base.body ?? '') : (npc.body ?? '');
    const outfit = base ? (base.outfit ?? '') : (npc.outfit ?? '');
    return exportRecord({ ...npc, looks, body, outfit, facts });
}

// ---- Place lore (docs/lore.md). A place has a sensory description (fed on moves and looks) and lore: background
// knowledge, fed only when the narrator asks with [ws_flag: lore | Place] or the
// player writes [lore]. The narrator always sees a one-line index of the lore on file. Cast NPCs are written as
// {{npc:castId}} tokens in lore and descriptions; the engine renders them as names before SillyTavern's macros run.
export const NPC_TOKEN = /\{\{\s*npc\s*:\s*([^{}\s]*)\s*\}\}/gi;

/** The cast ids in a text's {{npc:id}} tokens, in order, unique. */
export const npcTokenIds = text => [...new Set([...String(text ?? '').matchAll(NPC_TOKEN)].map(m => m[1].toLowerCase()))];
