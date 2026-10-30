// Copy of plugin/npc.mjs (the extension cannot import plugin files statically). Keep them the same; a test checks.
// NPC records, stamps and context slices. The server stores nothing during play: a cast file is the
// template, and every change is a stamp on the message (extra.worldscrawl_npc), per swipe.
// Schedules resolve through the same kind of redirect a player position uses. A bad entry is marked, never thrown.

export const NPC_KEY = 'worldscrawl_npc';
export const PLAYER = 'player';
export const SUGGEST_AFTER = 3;
export const MEMORY_CAP = 8;
export const READBACK_CAP = 24;
export const STAY_SECONDS = 3600;
export const DISPOSITIONS = ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'];
export const DISPOSITION_ALL = ['unknown', ...DISPOSITIONS];
export const IMPORTANCE = ['low', 'normal', 'high'];
export const NPC_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const LADDER = DISPOSITIONS;
const DAY_MINUTES = 1440;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

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

/** 0-99, stable for the same seed. Same seed all day, so a swipe cannot flip a sighting. */
export function hashRoll(seed) {
    let h = 2166136261;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) % 100;
}

/** Hours away from the peak hour, around a clock of `span` hours. */
export function hourDistance(hour, peak, span = 24) {
    const s = span > 0 ? span : 24;
    const d = Math.abs((hour % s) - (peak % s));
    return Math.min(d, s - d);
}

/**
 * Chance at `distance` hours from the peak. `peak` (default 0.5) is the peak hour only.
 * One hour out is 0.2, two is 0.05, three or more is 0.02, and never higher than the peak.
 */
export function sightChance(distance, peak = 0.5) {
    const p = Number.isFinite(peak) ? peak : 0.5;
    const base = distance <= 0 ? p : distance === 1 ? 0.2 : distance === 2 ? 0.05 : 0.02;
    return Math.min(base, p);
}

/** "HH:MM" -> minutes, or null. */
export function parseHm(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

/** True when `minutes` sits in [from, to). A window that passes midnight wraps. No times means always. */
export function inTimeWindow(minutes, from, to, dayMinutes = DAY_MINUTES) {
    if (from == null && to == null) return true;
    const start = from ?? 0, end = to ?? dayMinutes;
    if (start === end) return true;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
}

const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
/** An id for a person met in play. A clash gets -2, -3, ... */
export function freeId(name, taken = new Set()) {
    let id = slug(name) || 'npc';
    if (!NPC_ID.test(id)) id = 'npc';
    if (!taken.has(id)) return id;
    let n = 2;
    while (taken.has(`${id}-${n}`)) n++;
    return `${id}-${n}`;
}

function str(v, max) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || (max && t.length > max)) return null;
    return t;
}

/**
 * One cast record. Never throws. `places` (a Set of addresses), when given, marks a schedule or
 * sighting place that is not in the world as broken. A place that exists here can still expire later;
 * that is decided when the schedule is resolved, not here.
 */
export function validateRecord(raw, { file = 'npc', places = null } = {}) {
    const problems = [];
    const errors = [];
    const fail = m => { problems.push(m); errors.push(m); };
    const note = m => problems.push(m);
    if (!isObj(raw)) return { ok: false, id: '', name: '', line: '', problems: [`${file}: not an object`], schedule: [], from: 'cast' };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!NPC_ID.test(id)) fail(`${file}: "id" must be a lowercase slug (letters, digits, dashes or underscores)`);
    const stem = String(file).replace(/\.json$/i, '');
    if (id && stem && stem !== id && stem !== 'npc') note(`${file}: file name should match "id" (${id})`);
    const name = str(raw.name, 80);
    if (!name) fail(`${file}: "name" is required`);
    const line = str(raw.line, 400);
    if (!line) fail(`${file}: "line" is required (one sentence)`);
    const manner = str(raw.manner, 400) ?? '';
    const voice = str(raw.voice, 400) ?? '';
    if (raw.manner != null && !manner) fail(`${file}: "manner" must be a short string`);
    if (raw.voice != null && !voice) fail(`${file}: "voice" must be a short string`);
    const disposition = {};
    if (raw.disposition != null) {
        if (!isObj(raw.disposition)) fail(`${file}: "disposition" must be an object keyed by person`);
        else for (const [who, row] of Object.entries(raw.disposition)) {
            if (!isObj(row)) { fail(`${file}: disposition.${who} must be {value, reason}`); continue; }
            const value = matchEnum(row.value, DISPOSITION_ALL);
            if (!value || value === 'unknown') { note(`${file}: disposition.${who} value must be one of ${DISPOSITIONS.join(', ')}`); continue; }
            disposition[who] = { value, reason: str(row.reason, 240) ?? '' };
        }
    }
    const schedule = [];
    if (raw.schedule != null) {
        if (!Array.isArray(raw.schedule)) fail(`${file}: "schedule" must be a list`);
        else raw.schedule.forEach((e, i) => schedule.push(validateEntry(e, `${file} schedule[${i}]`, places, note)));
    }
    let seen_at = null;
    if (raw.seen_at != null) {
        if (!isObj(raw.seen_at)) fail(`${file}: "seen_at" must be {place, hour, chance}`);
        else {
            const place = str(raw.seen_at.place, 200);
            const hour = raw.seen_at.hour;
            const chance = raw.seen_at.chance == null ? 0.5 : raw.seen_at.chance;
            const bad = !place || !Number.isInteger(hour) || hour < 0 || hour > 23 || typeof chance !== 'number' || chance < 0 || chance > 1;
            if (bad) note(`${file}: "seen_at" needs a place, an hour 0-23, and a chance from 0 to 1`);
            else {
                const missing = places && !places.has(place);
                if (missing) note(`${file}: seen_at place ${place} is not in this world`);
                seen_at = { place, hour, chance, ...(missing ? { broken: true, problem: 'place is not in this world' } : {}) };
            }
        }
    }
    const deep = cleanDeep(raw.deep, file, fail);
    const facts = Array.isArray(raw.facts) ? raw.facts.map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean).slice(0, 24) : [];
    const memory = Array.isArray(raw.memory) ? raw.memory.map(f => (typeof f === 'string' ? f.trim() : isObj(f) ? str(f.note, 240) : '')).filter(Boolean).slice(-MEMORY_CAP) : [];
    const ok = errors.length === 0 && !!id && !!name && !!line;
    return { ok, id, name: name ?? '', line: line ?? '', manner, voice, disposition, schedule, seen_at, deep, facts, memory, problems, from: 'cast' };
}

function validateEntry(e, where, places, fail) {
    if (!isObj(e)) { fail(`${where}: must be an object`); return { place: '', activity: '', broken: true, problem: 'not an object' }; }
    const place = str(e.place, 200) ?? '';
    const activity = str(e.activity, 200) ?? '';
    const problems = [];
    if (!place) problems.push('place is required');
    if (!activity) problems.push('activity is required');
    let fromMin = null, toMin = null, from = null, to = null;
    if (e.from != null) {
        fromMin = parseHm(e.from);
        if (fromMin == null) problems.push('from must look like "08:00"');
        else from = String(e.from).trim();
    }
    if (e.to != null) {
        toMin = parseHm(e.to);
        if (toMin == null) problems.push('to must look like "17:00"');
        else to = String(e.to).trim();
    }
    let importance = null;
    if (e.importance != null && String(e.importance).trim()) {
        importance = matchEnum(e.importance, IMPORTANCE);
        if (!importance) problems.push('importance must be low, normal or high');
    }
    let broken = problems.length > 0;
    let problem = problems.join('; ');
    if (!broken && places && place && !places.has(place)) {
        broken = true;
        problem = 'place is not in this world';
        fail(`${where}: ${problem} (${place})`);
    } else if (broken) fail(`${where}: ${problem}`);
    return { place, activity, ...(from ? { from } : {}), ...(to ? { to } : {}), fromMin, toMin, ...(importance ? { importance } : {}), ...(broken ? { broken: true, problem } : {}) };
}

function cleanDeep(raw, file, fail) {
    if (raw == null) return {};
    if (!isObj(raw)) { fail(`${file}: "deep" must be an object`); return {}; }
    const out = {};
    if (raw.history != null) {
        const h = str(raw.history, 800);
        if (!h) fail(`${file}: deep.history must be a string`);
        else out.history = h;
    }
    if (raw.secrets != null) {
        if (!Array.isArray(raw.secrets)) fail(`${file}: deep.secrets must be a list of strings`);
        else out.secrets = raw.secrets.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, 12);
    }
    if (raw.relationships != null) {
        if (!isObj(raw.relationships)) fail(`${file}: deep.relationships must be an object`);
        else {
            out.relationships = {};
            for (const [k, v] of Object.entries(raw.relationships)) {
                const t = str(v, 240);
                if (t) out.relationships[k] = t;
                else fail(`${file}: deep.relationships.${k} must be a short string`);
            }
        }
    }
    return out;
}

/** Follow a relocate map. Expired (removed, and the target is gone) is not a crash. Missing means it was never here. */
export function resolveSchedulePlace(place, { exists, relocate = {} } = {}) {
    const live = a => typeof a === 'string' && a && exists?.(a) && !Object.prototype.hasOwnProperty.call(relocate, a);
    if (live(place)) return { ok: true, address: place, how: 'here' };
    let a = place;
    const seen = new Set();
    while (typeof a === 'string' && relocate[a] && !seen.has(a) && seen.size < 32) { seen.add(a); a = relocate[a]; }
    if (live(a)) return { ok: true, address: a, how: 'merged' };
    if (seen.size || (typeof place === 'string' && Object.prototype.hasOwnProperty.call(relocate, place))) return { ok: false, how: 'expired', from: place };
    return { ok: false, how: 'missing', from: place };
}

/** The schedule entry in force at `clock.minutes`, or null when nothing valid is in force (off the map). */
export function scheduleAt(npc, clock, env) {
    const entries = (npc?.schedule ?? []).filter(e => e && !e.broken);
    if (!entries.length) return null;
    const minutes = clock?.minutes ?? 0;
    const day = env?.dayMinutes ?? DAY_MINUTES;
    const timed = entries.filter(e => e.fromMin != null || e.toMin != null);
    const open = entries.filter(e => e.fromMin == null && e.toMin == null);
    const matching = timed.filter(e => inTimeWindow(minutes, e.fromMin, e.toMin, day));
    const order = [...matching, ...open, ...timed.filter(e => !matching.includes(e))];
    for (const entry of order) {
        const r = resolveSchedulePlace(entry.place, env);
        if (r.ok) return { address: r.address, how: r.how, activity: entry.activity, entry, kind: 'schedule' };
    }
    return null;
}

function sightPlaceOf(npc, env) {
    if (!npc?.seen_at || npc.seen_at.broken) return null;
    if ((npc.schedule ?? []).some(e => e && !e.broken)) return null; // a real schedule replaces the sighting
    const r = resolveSchedulePlace(npc.seen_at.place, env);
    return r.ok ? r.address : null;
}

/** The sighting check for this day and hour. Present only when an appearance stamp covers it, unless `roll` is set. */
export function sightCheck(npc, clock, playerPlace, env, { appearances = [], seeks = [], useRoll = false } = {}) {
    const place = sightPlaceOf(npc, env);
    if (!place || playerPlace !== place) return { present: false, place, byName: !place && !!npc?.seen_at && !(npc.schedule ?? []).some(e => e && !e.broken) };
    const day = clock?.day, hour = clock?.hour;
    const stamped = (appearances ?? []).some(a => a.day === day && a.hour === hour && a.place === place);
    if (stamped) return { present: true, place, stamped: true };
    if (!useRoll) return { present: false, place, needsStamp: true };
    const dist = hourDistance(hour ?? 0, npc.seen_at.hour, env?.hoursPerDay ?? 24);
    const chance = sightChance(dist, npc.seen_at.chance ?? 0.5);
    const roll = hashRoll(`sight|${npc.id}|${place}|${day}`);
    const sought = (seeks ?? []).some(s => s.day === day);
    const seekRoll = sought ? hashRoll(`seek|${npc.id}|${place}|${day}`) : roll;
    const used = Math.min(roll, seekRoll);
    const present = used < Math.round(chance * 100);
    return { present, place, roll: used, chance, sought, needsStamp: present };
}

/** One step along the attitude ladder, unless this is the first value or something dramatic happened. */
export function clampDisposition(from, to, dramatic = false) {
    const next = matchEnum(to, DISPOSITIONS);
    if (!next) return null;
    if (dramatic || !from || from === 'unknown' || !LADDER.includes(from)) return next;
    const a = LADDER.indexOf(from), b = LADDER.indexOf(next);
    if (Math.abs(b - a) <= 1) return next;
    return LADDER[a + Math.sign(b - a)];
}

function blankFrom(rec) {
    return {
        id: rec.id, name: rec.name, line: rec.line, manner: rec.manner ?? '', voice: rec.voice ?? '',
        deep: clone(rec.deep ?? {}), facts: [...(rec.facts ?? [])], memory: [...(rec.memory ?? [])].slice(-MEMORY_CAP),
        disposition: clone(rec.disposition ?? {}), fromCast: new Set(Object.keys(rec.disposition ?? {})),
        schedule: (rec.schedule ?? []).map(e => ({ ...e })), seen_at: rec.seen_at ? { ...rec.seen_at } : null,
        ok: rec.ok !== false, from: rec.from ?? 'cast', following: null, held: null, appearances: [], seeks: [], stays: [],
    };
}

function snapshot(state) {
    const out = new Map();
    for (const [id, n] of state) out.set(id, {
        ...n, deep: clone(n.deep), facts: n.facts.slice(), memory: n.memory.slice(), disposition: clone(n.disposition),
        fromCast: new Set(n.fromCast), appearances: n.appearances.slice(), seeks: n.seeks.slice(), stays: n.stays.slice(),
        following: n.following ? { ...n.following } : null, held: n.held ? { ...n.held } : null, schedule: n.schedule, seen_at: n.seen_at,
    });
    return out;
}

function setDeep(deep, field, text) {
    const parts = String(field).split('.').slice(1);
    if (!parts.length) return;
    if (parts[0] === 'history') { deep.history = text; return; }
    if (parts[0] === 'secrets') { deep.secrets = [...(deep.secrets ?? []), text].slice(-12); return; }
    if (parts[0] === 'relationships' && parts[1]) {
        deep.relationships = { ...(deep.relationships ?? {}), [parts[1]]: text };
    }
}

function applyStamp(state, s, index) {
    if (!s || s.off === true || typeof s.type !== 'string') return;
    const id = s.id;
    if (s.type === 'npc_create') {
        if (!id || !NPC_ID.test(id) || state.has(id)) return;
        const name = str(s.name, 80), line = str(s.line, 400);
        if (!name || !line) return;
        state.set(id, blankFrom({ id, name, line, manner: str(s.manner, 400) ?? '', voice: str(s.voice, 400) ?? '', facts: Array.isArray(s.facts) ? s.facts : [], ok: true, from: 'play', schedule: [], disposition: {} }));
        return;
    }
    if (s.type === 'npc_decline') return;
    const n = id ? state.get(id) : null;
    if (!n) return;
    if (s.type === 'npc_fact') {
        const text = str(s.text, 400);
        if (!text) return;
        const field = String(s.field ?? 'fact');
        if (field === 'line' || field === 'manner' || field === 'voice') n[field] = text;
        else if (field.startsWith('deep.')) setDeep(n.deep, field, text);
        else n.facts.push(text);
        return;
    }
    if (s.type === 'npc_memory') {
        const note = str(s.note, 240);
        if (!note) return;
        n.memory.push(note);
        if (n.memory.length > MEMORY_CAP) n.memory.splice(0, n.memory.length - MEMORY_CAP);
        return;
    }
    if (s.type === 'npc_disposition') {
        const who = typeof s.who === 'string' && s.who ? s.who : PLAYER;
        const cur = n.disposition[who]?.value ?? 'unknown';
        const value = clampDisposition(cur, s.value, !!s.dramatic);
        if (!value) return;
        n.disposition[who] = { value, reason: str(s.reason, 240) ?? '' };
        return;
    }
    if (s.type === 'npc_follow') { n.following = { who: str(s.who, 40) || PLAYER, at: index }; n.held = null; return; }
    if (s.type === 'npc_stay') {
        n.following = null;
        const place = str(s.place, 200);
        // No place (a stamp from before holds existed): back on the schedule, as that older stamp meant.
        n.held = place ? { place, at: index } : null;
        return;
    }
    if (s.type === 'npc_staying') { n.stays.push({ at: index, elapsed: Number.isFinite(s.elapsed) ? s.elapsed : 0 }); return; }
    if (s.type === 'npc_appear') {
        if (typeof s.place !== 'string' || !Number.isInteger(s.day) || !Number.isInteger(s.hour)) return;
        n.appearances.push({ place: s.place, day: s.day, hour: s.hour, at: index });
        return;
    }
    if (s.type === 'npc_seek') { if (Number.isInteger(s.day)) n.seeks.push({ day: s.day, at: index }); }
}

/** Stamps on one message that count (a turned-off stamp does not). `swipe` keeps each swipe's own list. */
export function stampsOn(msg, swipe = null) {
    const list = msg?.extra?.[NPC_KEY];
    if (!Array.isArray(list)) return [];
    return list.filter(s => s && typeof s === 'object' && s.off !== true && (swipe == null || s.swipe == null || s.swipe === swipe));
}

/** State after each message through `index`. Cast entries that did not validate are left out. */
export function framesOf(chat, index, cast = []) {
    const end = Math.max(-1, Math.min(index ?? -1, (chat?.length ?? 0) - 1));
    const state = new Map();
    for (const rec of cast ?? []) if (rec?.ok && rec.id && !state.has(rec.id)) state.set(rec.id, blankFrom(rec));
    const frames = [];
    for (let i = 0; i <= end; i++) {
        for (const s of stampsOn(chat[i])) applyStamp(state, s, i);
        frames.push(snapshot(state));
    }
    return frames;
}

export function sceneStart(end, playerAt) {
    const here = playerAt(end);
    for (let i = end; i >= 0; i--) if (playerAt(i) !== here) return i + 1;
    return 0;
}

function entryKey(sched) {
    if (!sched?.entry) return '';
    const e = sched.entry;
    return `${e.place}|${e.from ?? ''}|${e.to ?? ''}|${e.activity ?? ''}`;
}

/** The player left the held place and has come back by message `j`. */
function rejoined(npc, j, env) {
    const h = npc.held;
    if (!h?.place || j <= h.at) return false;
    let left = false;
    for (let i = h.at + 1; i <= j; i++) {
        const at = env.playerAt?.(i);
        if (!at) continue;
        if (at !== h.place) left = true;
        else if (left) return true;
    }
    return false;
}

/**
 * A stay stamp holds them at that place until the schedule entry in force changes (the next one
 * started, or the old one ended), a one-off's hour ends, or the player comes back after leaving.
 * Following again clears the hold. Until then they do not return to the schedule.
 */
function holdActive(npc, j, env) {
    const h = npc.held;
    if (!h?.place || j < h.at) return false;
    if (rejoined(npc, j, env)) return false;
    const then = env.clock?.(h.at) ?? {};
    const now = env.clock?.(j) ?? then;
    const thenSched = scheduleAt(npc, then, env);
    const nowSched = scheduleAt(npc, now, env);
    if (entryKey(thenSched) !== entryKey(nowSched)) return false;
    if (!thenSched && npc.seen_at && !npc.seen_at.broken && (now.day !== then.day || now.hour !== then.hour)) return false;
    return true;
}

function duePlace(npc, j, env, { useRoll = false } = {}) {
    if (npc.following) {
        const who = npc.following.who || PLAYER;
        const address = who === PLAYER ? env.playerAt(j) : (env.actorAt?.(j, who) || env.playerAt(j));
        return address ? { address, activity: `with ${who === PLAYER ? 'the player' : who}`, kind: 'follow', entry: null } : null;
    }
    if (holdActive(npc, j, env)) return { address: npc.held.place, activity: 'waiting', kind: 'stay', entry: null };
    const clock = env.clock(j);
    const sched = scheduleAt(npc, clock, env);
    if (sched) return sched;
    const sight = sightCheck(npc, clock, env.playerAt(j), env, { appearances: npc.appearances, seeks: npc.seeks, useRoll });
    if (sight.present) return { address: sight.place, activity: 'here', kind: 'sight', entry: null };
    return null;
}

function placeLabel(env, address) {
    return env.names?.(address) || address;
}

function overdueNote(npc, sched, clock, env) {
    const act = sched.entry?.activity || 'elsewhere';
    const where = placeLabel(env, sched.address);
    const imp = sched.entry?.importance;
    let hours = 0;
    if (sched.entry?.fromMin != null) {
        let late = (clock.minutes ?? 0) - sched.entry.fromMin;
        const day = env.dayMinutes ?? DAY_MINUTES;
        if (late < 0) late += day;
        hours = Math.floor(late / 60);
    }
    if (hours <= 0) return `${npc.name} is due at ${where} (${act}${imp ? `, ${imp} importance` : ''}).`;
    const why = imp ? ` (${imp} importance)` : '';
    if (hours === 1) return `${npc.name} is an hour late for ${act}${why}.`;
    return `${npc.name} is ${hours} hours late for ${act}${why}.`;
}

function stayCovers(npc, scene, clock) {
    const stay = [...(npc.stays ?? [])].reverse().find(s => s.at >= scene);
    if (!stay || !Number.isFinite(clock?.elapsed)) return false;
    return clock.elapsed - stay.elapsed < STAY_SECONDS;
}

/**
 * Who is in the player's scene after message `index`.
 * An NPC already in the scene is not removed when their hour ends; the narrator gets an overdue note instead.
 * Saved people are never filled in as unnamed strangers: they are here only by schedule, sighting stamp, or following.
 */
export function presentAt(chat, index, cast, env) {
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    if (!chat?.length) return [];
    const frames = framesOf(chat, end, cast);
    if (!frames.length) return [];
    const scene = sceneStart(end, i => env.playerAt(Math.min(i, end)));
    const here = env.playerAt(end);
    const clock = env.clock(end);
    const out = [];
    for (const npc of frames[end].values()) {
        let inScene = false, ban = false;
        for (let j = scene; j <= end; j++) {
            const then = frames[j].get(npc.id);
            if (!then) continue;
            const stamps = stampsOn(chat[j]).filter(s => s.id === npc.id);
            if (stamps.some(s => s.type === 'npc_leave')) { ban = true; inScene = false; }
            if (stamps.some(s => s.type === 'npc_follow')) ban = false;
            if (ban) continue;
            const due = duePlace(then, j, env);
            const hereJ = env.playerAt(j);
            if (due?.address && due.address === hereJ) inScene = true;
            else if (then.held?.place && then.held.place === hereJ && rejoined(then, j, env)) inScene = true;
        }
        if (!inScene) continue;
        const now = frames[end].get(npc.id);
        const due = duePlace(now, end, env);
        let overdue = '';
        if (!now.following && (!due || due.address !== here)) {
            const sched = scheduleAt(now, clock, env);
            if (sched && sched.address !== here) overdue = stayCovers(now, scene, clock) ? '' : overdueNote(now, sched, clock, env);
            else if (now.seen_at && !sched) overdue = stayCovers(now, scene, clock) ? '' : `${now.name}'s hour here has passed.`;
        }
        out.push({ ...publicNpc(now), activity: due?.activity ?? '', place: due?.address ?? here, here, overdue, kind: due?.kind ?? 'scene' });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Saved people who belong here (a schedule stop at this place, or a {{npc:id}} token in the lore being fed, `lore`)
 * but are not in the scene now. One line each, from the schedule entry in force; with none, no place is named (never invented).
 */
export function absentAt(chat, index, cast, env, { lore = '', present = [] } = {}) {
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    if (!chat?.length) return [];
    const frames = framesOf(chat, end, cast);
    if (!frames.length) return [];
    const here = env.playerAt(end);
    const clock = env.clock(end);
    const ids = new Set((present ?? []).map(p => p.id));
    const named = new Set(npcTokenIds(lore));
    const out = [];
    for (const npc of frames[end].values()) {
        if (ids.has(npc.id) || npc.following) continue;
        const stops = (npc.schedule ?? []).filter(e => e && !e.broken).some(e => resolveSchedulePlace(e.place, env).address === here);
        if (!stops && !named.has(String(npc.id).toLowerCase())) continue;
        const sched = scheduleAt(npc, clock, env);
        const where = sched && sched.address !== here
            ? ` (${[sched.activity, env.names ? env.names(sched.address) : sched.address].filter(Boolean).join(', ')})` : '';
        out.push(`${npc.name} isn't here right now${where}; do not portray ${npc.name}.`);
    }
    return out.sort();
}

function publicNpc(n) {
    const disposition = {};
    for (const [who, row] of Object.entries(n.disposition ?? {})) disposition[who] = { ...row };
    if (!disposition[PLAYER]) disposition[PLAYER] = { value: 'unknown', reason: '' };
    return {
        id: n.id, name: n.name, line: n.line, manner: n.manner ?? '', voice: n.voice ?? '', deep: clone(n.deep ?? {}),
        facts: n.facts.slice(), memory: n.memory.slice(), disposition, fromCast: [...n.fromCast],
        following: n.following ? { ...n.following } : null, from: n.from, seen_at: n.seen_at ? { ...n.seen_at } : null,
        schedule: n.schedule.map(e => ({ ...e })),
    };
}

/** The latest folded NPC, for export and the character bar. */
export function npcAt(chat, index, cast, id) {
    const frames = framesOf(chat, index, cast);
    const end = frames.length - 1;
    if (end < 0) return null;
    const n = frames[end].get(id);
    return n ? publicNpc(n) : null;
}

/**
 * Where everyone stands at the end of the chat, for the map's cast browser: the folded NPC, where they are and why,
 * whether they are in the player's scene, and every stamp about them (with its message index). `cast` is the cast list.
 */
export function npcPlayState(chat, cast, env) {
    const end = (chat?.length ?? 0) - 1;
    if (end < 0) return [];
    const frames = framesOf(chat, end, cast);
    const last = frames[end];
    if (!last) return [];
    let present = new Set();
    try { present = new Set(presentAt(chat, end, cast, env).map(n => n.id)); } catch { /* no position without a clock */ }
    let declined = new Set();
    try { declined = declinesInScene(chat, end, i => env.playerAt(i)); } catch { /* no position */ }
    const stamps = new Map();
    chat.forEach((msg, i) => {
        const list = msg?.extra?.[NPC_KEY];
        if (!Array.isArray(list)) return;
        const swipe = msg.swipe_id ?? null;
        for (const s of list) {
            if (!s || typeof s !== 'object' || typeof s.id !== 'string' || (swipe != null && s.swipe != null && s.swipe !== swipe)) continue;
            if (!stamps.has(s.id)) stamps.set(s.id, []);
            stamps.get(s.id).push({ msg: i, type: s.type, off: s.off === true, summary: stampSummary(s, last.get(s.id)?.name ?? s.name ?? s.id) });
        }
    });
    const out = [];
    for (const n of last.values()) {
        let due = null;
        try { due = duePlace(n, end, env); } catch { /* no clock */ }
        out.push({ ...publicNpc(n), held: n.held ? { ...n.held } : null, position: due ? { place: due.address, kind: due.kind, activity: due.activity ?? '' } : null,
            present: present.has(n.id), stamps: stamps.get(n.id) ?? [], record: exportRecord(n), why: npcWhy(n, end, env, { declined }) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Under the hood, for the map's inspector: why `n` (a folded NPC) is where they are after message `j`.
 * Every roll is the same seeded one presentAt uses, so this never disagrees with the narrator.
 */
export function npcWhy(n, j, env, { declined = null } = {}) {
    const clock = (() => { try { return env.clock(j); } catch { return null; } })();
    const deepKeys = Object.keys(n.deep ?? {}).filter(k => (Array.isArray(n.deep[k]) ? n.deep[k].length : n.deep[k] && (typeof n.deep[k] !== 'object' || Object.keys(n.deep[k]).length)));
    const tier = n.manner || n.voice || deepKeys.length ? 'full' : 'stub';
    const out = { clock: clock ? { day: clock.day, hour: clock.hour, minute: clock.minute } : null, tier, from: n.from, following: n.following ? { ...n.following } : null,
        held: null, schedule: null, sighting: null, kind: null, place: null, reason: '', declined: false };
    if (declined && declined.has(normName(n.name))) out.declined = true;
    if (!clock) { out.reason = 'No game clock yet.'; return out; }
    let due = null; try { due = duePlace(n, j, env); } catch { /* no position */ }
    out.kind = due?.kind ?? null; out.place = due?.address ?? null;
    try { if (n.held?.place) out.held = { place: n.held.place, at: n.held.at, active: holdActive(n, j, env) }; } catch { /* ignore */ }
    const entries = n.schedule ?? [];
    const sched = (() => { try { return scheduleAt(n, clock, env); } catch { return null; } })();
    if (entries.length) {
        const i = sched ? entries.indexOf(sched.entry) : -1;
        const e = sched?.entry;
        const timed = e && (e.fromMin != null || e.toMin != null);
        const inside = timed && inTimeWindow(clock.minutes ?? 0, e.fromMin, e.toMin, env?.dayMinutes ?? DAY_MINUTES);
        out.schedule = { entry: i, address: sched?.address ?? null, how: sched?.how ?? null, activity: sched?.activity ?? '',
            why: i < 0 ? 'No entry resolves to a place in this world.' : inside ? `Entry ${i + 1} covers ${e.from}–${e.to}.` : !timed ? `No timed entry covers now; entry ${i + 1} has no times and fills the rest of the day.` : `No entry covers now; entry ${i + 1} is the first that resolves.`,
            broken: entries.map((x, k) => (x?.broken ? k : -1)).filter(k => k >= 0) };
    }
    if (n.seen_at) {
        const sp = sightPlaceOf(n, env);
        const r = { place: n.seen_at.place, hour: n.seen_at.hour, chance: n.seen_at.chance ?? 0.5, resolved: sp, active: !!sp };
        if (sp) {
            const dist = hourDistance(clock.hour ?? 0, n.seen_at.hour, env?.hoursPerDay ?? 24);
            const chance = sightChance(dist, n.seen_at.chance ?? 0.5);
            const roll = hashRoll(`sight|${n.id}|${sp}|${clock.day}`);
            const sought = (n.seeks ?? []).some(x => x.day === clock.day);
            const seekRoll = sought ? hashRoll(`seek|${n.id}|${sp}|${clock.day}`) : null;
            const used = seekRoll == null ? roll : Math.min(roll, seekRoll);
            const stamped = (n.appearances ?? []).some(a => a.day === clock.day && a.hour === clock.hour && a.place === sp);
            Object.assign(r, { day: clock.day, now: Math.round(chance * 100), roll, seekRoll, used, sought, stamped, wouldShow: used < Math.round(chance * 100) });
        } else r.note = (entries.some(e => e && !e.broken)) ? 'A real schedule replaces the sighting.' : 'The sighting place is not in this world.';
        out.sighting = r;
    }
    const dw = n.disposition?.[PLAYER];
    out.disposition = dw ? { ...dw } : { value: 'unknown', reason: '' };
    out.memory = [...(n.memory ?? [])];
    out.reason = n.following ? `Following ${n.following.who === PLAYER ? 'the player' : n.following.who}.`
        : out.held?.active ? 'Told to stay; the hold is still on.'
            : due?.kind === 'schedule' ? out.schedule?.why ?? 'On their schedule.'
                : due?.kind === 'sight' ? `Sighting: rolled ${out.sighting?.used} under ${out.sighting?.now}.`
                    : out.sighting?.active ? `Not on a schedule; today's sighting roll is ${out.sighting.used} against ${out.sighting.now}${out.sighting.wouldShow ? ' (would show, waiting for the hour)' : ' (no-show)'}.`
                        : 'Nowhere this hour.';
    return out;
}

/**
 * Who's at `place` after message `index`: everyone due there, plus everyone whose schedule or sighting points there but who is
 * not there now, with the reason (another entry, a no-show roll, following someone, told to stay elsewhere).
 */
export function whoAt(chat, index, cast, env, place) {
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    if (!chat?.length || !place) return [];
    const frames = framesOf(chat, end, cast);
    const last = frames[end];
    if (!last) return [];
    let present = new Set();
    try { present = new Set(presentAt(chat, end, cast, env).map(n => n.id)); } catch { /* no clock */ }
    const out = [];
    for (const n of last.values()) {
        const w = npcWhy(n, end, env);
        let due = null; try { due = duePlace(n, end, env, { useRoll: true }); } catch { /* no clock */ }
        const pointsHere = (n.schedule ?? []).some(e => e && !e.broken && (resolveSchedulePlace(e.place, env).address ?? e.place) === place) || (n.seen_at && !n.seen_at.broken && (resolveSchedulePlace(n.seen_at.place, env).address ?? n.seen_at.place) === place) || n.held?.place === place;
        const here = due?.address === place;
        if (!here && !pointsHere && !present.has(n.id)) continue;
        let reason = w.reason;
        if (!here && pointsHere) {
            if (n.following) reason = `Not here: following ${n.following.who === PLAYER ? 'the player' : n.following.who}.`;
            else if (w.held?.active && n.held.place !== place) reason = 'Not here: told to stay somewhere else.';
            else if (w.sighting?.active && w.sighting.resolved === place && !w.sighting.wouldShow) reason = `No-show today: rolled ${w.sighting.used}, needed under ${w.sighting.now}${w.sighting.sought ? ' (with a by-name roll)' : ''}.`;
            else if (w.schedule && w.schedule.address !== place) reason = `Not here: ${w.schedule.why} (${placeLabel(env, w.schedule.address ?? '') || 'nowhere'}${w.schedule.activity ? `, ${w.schedule.activity}` : ''})`;
            else reason = `Not here now. ${w.reason}`;
        }
        out.push({ id: n.id, name: n.name, here, inScene: present.has(n.id), kind: here ? due?.kind ?? null : null, activity: here ? due?.activity ?? '' : '', reason });
    }
    out.sort((a, b) => (b.here - a.here) || a.name.localeCompare(b.name));
    return out;
}

/**
 * What the narrator was told for the reply at message `reply`: the scene as it stood after the message before, the stored
 * focus (or the focus rules on that user message), and the npcSlices text, with who was listed at which depth and which memories went in.
 */
export function narratorView(chat, reply, cast, env, focusKey = 'worldscrawl_focus') {
    const before = reply - 1;
    if (!chat?.length || before < 0) return null;
    let present = [];
    try { present = presentAt(chat, before, cast, env); } catch (e) { return { reply, error: e.message }; }
    let ui = -1;
    for (let i = before; i >= 0; i--) if (chat[i]?.is_user) { ui = i; break; }
    const stored = ui >= 0 ? chat[ui]?.extra?.[focusKey] : null;
    const focus = stored && stored.depth ? stored : focusRules(ui >= 0 ? chat[ui]?.mes ?? '' : '', present);
    const slices = npcSlices(present, focus);
    const listed = present.map(p => ({ id: p.id, name: p.name, depth: focus?.id === p.id && focus.depth !== 'present' ? focus.depth : 'present',
        memories: focus?.id === p.id && focus.depth && focus.depth !== 'present' ? [...(p.memory ?? [])] : [] }));
    return { reply, user: ui, focus: focus ? { id: focus.id ?? null, depth: focus.depth ?? 'present', stored: !!(stored && stored.depth) } : null, listed, ...slices };
}

/**
 * People the engine is counting toward a Remember card: names the narrator flagged ([ws_flag: npc | Name]) in this scene
 * that no one has saved, with their reply count against the threshold, and whether a "no" was said for them in this scene.
 */
export function unsavedPeople(chat, { known = [], threshold = SUGGEST_AFTER, playerAt = () => '', rememberKey = 'worldscrawl_remember' } = {}) {
    const end = (chat?.length ?? 0) - 1;
    if (end < 0) return [];
    const declined = declinesInScene(chat, end, playerAt);
    const cards = new Map();
    for (const m of chat) { const r = m?.extra?.[rememberKey]; if (r?.name) cards.set(normName(r.name), r.status ?? ''); }
    return flaggedPeople(chat, sceneStartOf(chat, end, playerAt), end, { known, threshold })
        .map(r => ({ name: r.name, count: r.count, threshold, ready: r.ready && !declined.has(r.key), declined: declined.has(r.key), card: cards.get(r.key) ?? null }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** People following someone after message `index` (the player, unless a stamp says otherwise). */
export function followersAt(chat, index, cast = []) {
    const frames = framesOf(chat, index, cast);
    const end = frames.length - 1;
    if (end < 0) return [];
    return [...frames[end].values()].filter(n => n.following).map(n => ({ id: n.id, name: n.name, who: n.following.who }));
}

/** Index where the scene holding message `index` starts (player at the same place). */
export function sceneStartOf(chat, index, playerAt) {
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    return sceneStart(end, i => playerAt(Math.min(i, end)));
}
export function declinesInScene(chat, index, playerAt) {
    const end = Math.max(-1, Math.min(index ?? -1, (chat?.length ?? 0) - 1));
    if (end < 0) return new Set();
    const scene = sceneStart(end, i => playerAt(Math.min(i, end)));
    const names = new Set();
    for (let i = scene; i <= end; i++) for (const s of stampsOn(chat[i])) if (s.type === 'npc_decline' && s.name) names.add(normName(s.name));
    return names;
}

const DEEP_RE = /\b(secrets?|past|histor(?:y|ies)|used to|childhood|owes?|sister|brother|mother|father|think of (?:me|us|you)|remember when)\b/i;
const TALK_RE = /\b(talk(?:s|ed|ing)?|speak(?:s|ing)?|spoke|ask(?:s|ed|ing)?|tell(?:s|ing)?|told|greet(?:s|ed|ing)?|approach(?:es|ed|ing)?|chat(?:s|ted|ting)?)\b/i;
const LOOK_AT_RE = /\b(look(?:s|ed|ing)?|watch(?:es|ed|ing)?|stud(?:y|ies|ied)|examin(?:e|es|ed)|inspect(?:s|ed|ing)?)\b/i;

/**
 * Who the message is about, from the words alone. `ambiguous` means the caller should ask a pick-one
 * question (names + nobody). Depth is a rule, not a second model call.
 */
export function focusRules(text, present) {
    const said = String(text ?? '');
    const named = (present ?? []).filter(p => nameIn(said, p.name) || nameIn(said, p.id));
    let id = null, ambiguous = false;
    if (named.length === 1) id = named[0].id;
    else if (named.length > 1) ambiguous = true;
    else if ((TALK_RE.test(said) || LOOK_AT_RE.test(said)) && present.length === 1) id = present[0].id;
    else if ((TALK_RE.test(said) || LOOK_AT_RE.test(said)) && present.length > 1) ambiguous = true;
    const addressed = !!(id && (named.length || TALK_RE.test(said) || LOOK_AT_RE.test(said)));
    const depth = !id ? 'present' : DEEP_RE.test(said) ? 'deep' : addressed ? 'focused' : 'present';
    return { id, depth, ambiguous };
}

function dispositionLine(n) {
    const d = n.disposition?.[PLAYER];
    if (!d || !d.value || d.value === 'unknown') return '';
    return ` Disposition toward the player: ${d.value}${d.reason ? ` (${d.reason})` : ''}.`;
}

/** Prompt slices. Present is the short line; focus adds manner, voice, memory and (when deep) the deep fields. */
export function npcSlices(present, focus = {}) {
    const list = present ?? [];
    if (!list.length) return { npcs_present: '', npc_focus: '' };
    const lines = list.map(p => {
        const act = p.activity ? ` Now: ${p.activity}.` : '';
        const due = p.overdue ? ` ${p.overdue}` : '';
        return `${p.name} (${p.id}): ${p.line}${act}${dispositionLine(p)}${due}`;
    });
    const who = focus?.id ? list.find(p => p.id === focus.id) : null;
    let npc_focus = '';
    if (who && focus.depth && focus.depth !== 'present') {
        const bits = [`${who.name}, in focus.`];
        if (who.manner) bits.push(`Manner: ${who.manner}`);
        if (who.voice) bits.push(`Voice: ${who.voice}`);
        if (who.facts?.length) bits.push(`Known facts: ${who.facts.join('; ')}`);
        if (who.memory?.length) bits.push(`Memory: ${who.memory.map(m => `- ${m}`).join('\n')}`);
        if (focus.depth === 'deep' && who.deep) {
            if (who.deep.history) bits.push(`History: ${who.deep.history}`);
            if (who.deep.secrets?.length) bits.push(`Secrets: ${who.deep.secrets.join('; ')}`);
            if (who.deep.relationships && Object.keys(who.deep.relationships).length) bits.push(`Relationships: ${Object.entries(who.deep.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
        npc_focus = bits.join('\n');
    }
    return { npcs_present: lines.join('\n'), npc_focus };
}

/** A clean cast file from a played NPC (base fields plus facts, memory and disposition). Following stays in the chat. */
export function exportRecord(npc) {
    if (!npc?.id) return null;
    const out = { id: npc.id, name: npc.name, line: npc.line };
    if (npc.manner) out.manner = npc.manner;
    if (npc.voice) out.voice = npc.voice;
    const disposition = {};
    for (const [who, row] of Object.entries(npc.disposition ?? {})) if (row?.value && row.value !== 'unknown') disposition[who] = { value: row.value, ...(row.reason ? { reason: row.reason } : {}) };
    if (Object.keys(disposition).length) out.disposition = disposition;
    if (npc.facts?.length) out.facts = npc.facts.slice();
    if (npc.memory?.length) out.memory = npc.memory.slice();
    const deep = {};
    if (npc.deep?.history) deep.history = npc.deep.history;
    if (npc.deep?.secrets?.length) deep.secrets = npc.deep.secrets.slice();
    if (npc.deep?.relationships && Object.keys(npc.deep.relationships).length) deep.relationships = { ...npc.deep.relationships };
    if (Object.keys(deep).length) out.deep = deep;
    const schedule = (npc.schedule ?? []).filter(e => e && !e.broken).map(e => {
        const row = { place: e.place, activity: e.activity };
        if (e.from) row.from = e.from;
        if (e.to) row.to = e.to;
        if (e.importance) row.importance = e.importance;
        return row;
    });
    if (schedule.length) out.schedule = schedule;
    else if (npc.seen_at && !npc.seen_at.broken) out.seen_at = { place: npc.seen_at.place, hour: npc.seen_at.hour, chance: npc.seen_at.chance ?? 0.5 };
    return out;
}

function diffLine(field, from, to, lines) {
    const a = from ?? '', b = to ?? '';
    if (a === b) return;
    lines.push({ field, from: a, to: b });
}

/** What changed between a cast file and the record play would write. Empty when they match. */
export function recordDiff(before, after) {
    const a = exportRecord(before) ?? (isObj(before) ? before : {});
    const b = exportRecord(after) ?? (isObj(after) ? after : {});
    const lines = [];
    for (const k of ['name', 'line', 'manner', 'voice']) diffLine(k, a[k] ?? '', b[k] ?? '', lines);
    const whos = new Set([...Object.keys(a.disposition ?? {}), ...Object.keys(b.disposition ?? {})]);
    const disp = d => (d ? `${d.value}${d.reason ? ` (${d.reason})` : ''}` : '');
    for (const who of [...whos].sort()) diffLine(`disposition.${who}`, disp(a.disposition?.[who]), disp(b.disposition?.[who]), lines);
    const list = xs => (xs ?? []).join('; ');
    diffLine('facts', list(a.facts), list(b.facts), lines);
    diffLine('memory', list(a.memory), list(b.memory), lines);
    diffLine('deep.history', a.deep?.history ?? '', b.deep?.history ?? '', lines);
    diffLine('deep.secrets', list(a.deep?.secrets), list(b.deep?.secrets), lines);
    const rels = new Set([...Object.keys(a.deep?.relationships ?? {}), ...Object.keys(b.deep?.relationships ?? {})]);
    for (const k of [...rels].sort()) diffLine(`deep.relationships.${k}`, a.deep?.relationships?.[k] ?? '', b.deep?.relationships?.[k] ?? '', lines);
    diffLine('schedule', JSON.stringify(a.schedule ?? []), JSON.stringify(b.schedule ?? []), lines);
    diffLine('seen_at', JSON.stringify(a.seen_at ?? null), JSON.stringify(b.seen_at ?? null), lines);
    const text = lines.map(l => `${l.field}\n- ${l.from || '(empty)'}\n+ ${l.to || '(empty)'}`).join('\n');
    return { changed: lines.length > 0, lines, text };
}

export const NPC_FLAG_KEY = 'worldscrawl_npc_flags';
/** The narrator's [ws_flag: npc | Name] tags: the names come back, the text without the tags. */
export const NPC_FLAG_TAG = /\s*\[ws_flag:\s*npc\s*\|\s*([^\]|]{1,60})\]/gi;
export function takeNpcFlags(text) {
    const names = [];
    const cleaned = String(text ?? '').replace(NPC_FLAG_TAG, (_all, n) => { const v = n.trim(); if (v) names.push(v); return ''; });
    return { names, text: cleaned };
}
/** Names the narrator flagged on message m (the shown swipe). */
export const flagsOn = m => (m?.extra?.[NPC_FLAG_KEY] ?? []).filter(f => (f?.swipe ?? 0) === (m?.swipe_id ?? 0)).flatMap(f => f.names ?? []);

/**
 * Unsaved people the narrator flagged in this scene (messages from..to), counted once per reply, most recent first.
 * Saved names (`known`) and the scene's no (`declined`, normalized) are skipped. `ready` when count >= threshold.
 */
export function flaggedPeople(chat, from, to, { known = [], declined = [], threshold = SUGGEST_AFTER } = {}) {
    const skip = new Set([...known.map(normName), ...declined].filter(Boolean));
    const rows = new Map();
    for (let i = Math.max(0, from); i <= to && i < (chat?.length ?? 0); i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const seen = new Set();
        for (const name of flagsOn(m)) {
            const key = normName(name);
            if (!key || seen.has(key) || skip.has(key) || known.some(k => nameIn(name, k) || nameIn(k, name))) continue;
            seen.add(key);
            const row = rows.get(key) ?? { key, name, count: 0, last: i };
            row.count++; row.last = i; row.name = name;
            rows.set(key, row);
        }
    }
    return [...rows.values()].map(r => ({ ...r, ready: r.count >= threshold })).sort((a, b) => b.last - a.last);
}

/** Messages from the first one that names them, capped at the most recent `cap` of that span. */
export function readBack(messages, name, cap = READBACK_CAP) {
    const list = messages ?? [];
    let first = -1;
    for (let i = 0; i < list.length; i++) if (nameIn(list[i].text ?? list[i].mes ?? '', name)) { first = i; break; }
    const span = first < 0 ? list : list.slice(first);
    const sliced = span.slice(-cap);
    return { start: first < 0 ? 0 : (list[first].index ?? first), messages: sliced, truncated: span.length > sliced.length };
}

const TAG_KIND = { fact: 'npc_fact', memory: 'npc_memory', disposition: 'npc_disposition', leave: 'npc_leave', staying: 'npc_staying', follow: 'npc_follow', stay: 'npc_stay', seek: 'npc_seek' };

/** One [ws_npc: ...] body -> a stamp, or null when it does not parse. */
export function parseNpcTag(body) {
    const p = String(body ?? '').split('|').map(s => s.trim());
    const kind = (p[0] ?? '').toLowerCase();
    const type = TAG_KIND[kind];
    const id = p[1] ?? '';
    if (!type || !NPC_ID.test(id)) return null;
    if (type === 'npc_fact') { const text = p.slice(2).join(' | ').trim(); return text ? { type, id, field: 'fact', text } : null; }
    if (type === 'npc_memory') { const note = p.slice(2).join(' | ').trim(); return note ? { type, id, note } : null; }
    if (type === 'npc_disposition') {
        const value = matchEnum(p[2], DISPOSITIONS);
        if (!value) return null;
        return { type, id, who: PLAYER, value, reason: p.slice(3).join(' | ').trim() };
    }
    if (type === 'npc_follow') return { type, id, who: NPC_ID.test(p[2] ?? '') ? p[2] : PLAYER };
    if (type === 'npc_seek') return { type, id };
    return { type, id };
}

export const NPC_TAG = /\[ws_npc:\s*([^\]]{0,400})\]/gi;

/** Pull every NPC tag out of a reply. The story text comes back without the tags. */
export function takeNpcTags(text) {
    const stamps = [];
    const cleaned = String(text ?? '').replace(NPC_TAG, (_all, body) => {
        const s = parseNpcTag(body);
        if (s) stamps.push(s);
        return '';
    }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    return { stamps, text: cleaned };
}

/** JSON from the remember question. Empty manner and voice are fine. Null when it is not that JSON. */
export function readRememberAnswer(ans) {
    if (!isObj(ans)) return null;
    const name = str(ans.name, 80);
    const line = str(ans.line, 400);
    if (!name || !line) return null;
    const facts = Array.isArray(ans.facts) ? ans.facts.map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean).slice(0, 8) : [];
    return { name, line, manner: str(ans.manner, 400) ?? '', voice: str(ans.voice, 400) ?? '', facts };
}

/** A one-line description of one stamp, for the "Character changed here" bar. */
export function stampSummary(s, name = '') {
    const who = name || s?.id || 'Someone';
    if (!s) return who;
    if (s.type === 'npc_fact') return `${who}: ${s.text}`;
    if (s.type === 'npc_memory') return `${who}: remembered — ${s.note}`;
    if (s.type === 'npc_disposition') return `${who}: ${s.value}${s.reason ? ` (${s.reason})` : ''}`;
    if (s.type === 'npc_follow') return `${who} comes along`;
    if (s.type === 'npc_stay') return `${who} stays behind`;
    if (s.type === 'npc_leave') return `${who} leaves`;
    if (s.type === 'npc_staying') return `${who} is staying`;
    if (s.type === 'npc_create') return `${who} remembered`;
    if (s.type === 'npc_appear') return `${who} is here`;
    if (s.type === 'npc_seek') return `Looking for ${who}`;
    return who;
}

// ---- Place lore (docs/lore.md). A place has a sensory description (fed on moves and looks) and lore: background
// knowledge, fed only when the narrator asks with [ws_flag: lore | Place] (or the ws_flag tool's "lore" action) or the
// player writes [lore]. The narrator always sees a one-line index of the lore on file. Cast NPCs are written as
// {{npc:castId}} tokens in lore and descriptions; the engine renders them as names before SillyTavern's macros run.
export const NPC_TOKEN = /\{\{\s*npc\s*:\s*([^{}\s]*)\s*\}\}/gi;
/** The cast ids in a text's {{npc:id}} tokens, in order, unique. */
export const npcTokenIds = text => [...new Set([...String(text ?? '').matchAll(NPC_TOKEN)].map(m => m[1].toLowerCase()))];
/**
 * {{npc:id}} -> that NPC's name. An unknown id renders as the bare id ("someone" when empty) and is passed to `onUnknown`.
 * `cast` is a list of {id, name} (or a Map id -> name).
 */
export function renderNpcTokens(text, cast, onUnknown = null) {
    const byId = cast instanceof Map ? cast : new Map((cast ?? []).filter(n => n?.id).map(n => [String(n.id).toLowerCase(), n.name]));
    return String(text ?? '').replace(NPC_TOKEN, (_all, id) => {
        const name = byId.get(String(id).toLowerCase());
        if (name) return name;
        onUnknown?.(id);
        return id || 'someone';
    });
}

export const LORE_KEY = 'worldscrawl_lore';
/** The narrator's [ws_flag: lore | Place] tags: the places come back, the text without the tags. */
export const LORE_FLAG_TAG = /\s*\[ws_flag:\s*lore\s*(?:\|\s*([^\]|]{0,80}))?\]/gi;
export function takeLoreFlags(text) {
    const places = [];
    const cleaned = String(text ?? '').replace(LORE_FLAG_TAG, (_all, n) => { places.push(String(n ?? '').trim()); return ''; });
    return { places, text: cleaned };
}
/** "Lore on file: The Drowned Rat, Riverton" for a lore chain (innermost first); '' when there is none. */
export const loreIndexLine = chain => (chain?.length ? `Lore on file: ${chain.map(c => c.name).join(', ')}` : '');
/** The chain entries a request names: "" / "here" / "all" -> every one; else the entry whose name matches. */
export function loreFor(chain, place) {
    const p = normName(place);
    if (!p || ['here', 'all', 'this place', 'everything'].includes(p)) return [...(chain ?? [])];
    const exact = (chain ?? []).filter(c => normName(c.name) === p);
    if (exact.length) return exact;
    return (chain ?? []).filter(c => nameIn(place, c.name) || nameIn(c.name, place)).slice(0, 1);
}
/**
 * A lore request, stamped on the message it came from: {swipe, place, level, address, source: 'flag' | 'bracket'}.
 * `place` is the place's name as matched in the lore chain (or as asked, when nothing matched; then level is '').
 */
export function addLoreRequest(msg, req) {
    msg.extra = msg.extra ?? {};
    const list = Array.isArray(msg.extra[LORE_KEY]) ? msg.extra[LORE_KEY] : [];
    msg.extra[LORE_KEY] = [...list, { swipe: msg.swipe_id ?? 0, place: String(req.place ?? ''), level: String(req.level ?? ''), address: String(req.address ?? ''), source: req.source === 'bracket' ? 'bracket' : 'flag' }];
}
/** The lore requests on message m (its shown swipe). */
export const loreRequestsOn = m => (Array.isArray(m?.extra?.[LORE_KEY]) ? m.extra[LORE_KEY] : []).filter(r => r && (r.swipe ?? 0) === (m?.swipe_id ?? 0));
/**
 * Every lore request in a chat, oldest first, for the inspector's lore-request log:
 * [{index, place, level, address, source: 'flag' | 'bracket'}] (index = the message it is stamped on).
 */
export function loreRequests(chat) {
    const out = [];
    (chat ?? []).forEach((m, index) => { for (const r of loreRequestsOn(m)) out.push({ index, place: r.place, level: r.level, address: r.address, source: r.source }); });
    return out;
}
/**
 * The lore to feed at message `index`: chain entries (innermost first) asked for by a request in this scene at this
 * place. A request sticks until the player's place changes. `extra` are requests not stamped yet (this turn's [lore]).
 */
export function activeLore(chat, index, chain, playerAt, extra = []) {
    if (!chain?.length) return [];
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    const here = playerAt(end);
    const from = chat?.length ? sceneStartOf(chat, end, playerAt) : 0;
    const asked = [...extra];
    for (let i = from; i <= end && i < (chat?.length ?? 0); i++) for (const r of loreRequestsOn(chat[i])) if (!r.address || r.address === here) asked.push(r);
    const levels = new Set();
    for (const r of asked) for (const c of (r.level ? chain.filter(c => c.level === r.level) : loreFor(chain, r.place))) levels.add(c.level);
    return chain.filter(c => levels.has(c.level));
}
/** The fed-lore block for the narrator ('' when nothing is fed), tokens left in (render afterwards). */
export const loreBlock = fed => (fed?.length ? `Background knowledge (lore; what locals know, not what the senses show; use it only where it fits):\n${fed.map(c => `- ${c.name}: ${c.text}`).join('\n')}` : '');
