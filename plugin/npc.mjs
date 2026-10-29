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
        ok: rec.ok !== false, from: rec.from ?? 'cast', following: null, appearances: [], seeks: [], stays: [],
    };
}

function snapshot(state) {
    const out = new Map();
    for (const [id, n] of state) out.set(id, {
        ...n, deep: clone(n.deep), facts: n.facts.slice(), memory: n.memory.slice(), disposition: clone(n.disposition),
        fromCast: new Set(n.fromCast), appearances: n.appearances.slice(), seeks: n.seeks.slice(), stays: n.stays.slice(),
        following: n.following ? { ...n.following } : null, schedule: n.schedule, seen_at: n.seen_at,
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
    if (s.type === 'npc_follow') { n.following = { who: str(s.who, 40) || PLAYER, at: index }; return; }
    if (s.type === 'npc_stay') { n.following = null; return; }
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

function duePlace(npc, j, env, { useRoll = false } = {}) {
    if (npc.following) {
        const who = npc.following.who || PLAYER;
        const address = who === PLAYER ? env.playerAt(j) : (env.actorAt?.(j, who) || env.playerAt(j));
        return address ? { address, activity: `with ${who === PLAYER ? 'the player' : who}`, kind: 'follow', entry: null } : null;
    }
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
            if (due?.address && due.address === env.playerAt(j)) inScene = true;
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

/** People following someone after message `index` (the player, unless a stamp says otherwise). */
export function followersAt(chat, index, cast = []) {
    const frames = framesOf(chat, index, cast);
    const end = frames.length - 1;
    if (end < 0) return [];
    return [...frames[end].values()].filter(n => n.following).map(n => ({ id: n.id, name: n.name, who: n.following.who }));
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

const ROLE_STOP = new Set(['door', 'doors', 'room', 'rooms', 'way', 'ways', 'bar', 'fire', 'ale', 'beer', 'wine', 'night', 'day', 'time', 'man', 'woman', 'men', 'women', 'one', 'other', 'same', 'next', 'back', 'front', 'side', 'floor', 'wall', 'table', 'chair', 'doorway', 'stairs', 'staircase', 'place', 'world', 'story', 'thing', 'things', 'people', 'person', 'player', 'inn', 'tavern', 'street', 'square', 'window', 'windows', 'gate', 'yard', 'cellar', 'kitchen', 'stable', 'upstairs', 'downstairs', 'common', 'village', 'river', 'water', 'light', 'dark', 'coin', 'coins', 'money', 'drink', 'food', 'hand', 'hands', 'head', 'face', 'eyes', 'voice', 'house', 'shop', 'road', 'sign', 'door', 'counter']);
const PROPER_STOP = new Set(['The', 'Then', 'And', 'But', 'When', 'After', 'Before', 'Hello', 'There', 'This', 'That', 'She', 'Her', 'His', 'They', 'You', 'User', 'What', 'Where', 'Why', 'How', 'Yes', 'Please']);

function sentenceStart(text, index) {
    const before = text.slice(0, index).trimEnd();
    return before === '' || /[.!?]$/.test(before);
}

/** Names and "the role" phrases in one message. `mid` is false when a single proper name is only a sentence start. */
export function mentionsIn(text) {
    const src = String(text ?? '');
    const out = [];
    for (const m of src.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
        let label = m[1];
        const words = label.split(' ');
        while (words.length > 1 && PROPER_STOP.has(words[0])) words.shift();
        if (!words.length || (words.length === 1 && PROPER_STOP.has(words[0]))) continue;
        label = words.join(' ');
        if (label.length < 3) continue;
        out.push({ name: label, mid: label.includes(' ') || !sentenceStart(src, m.index) });
    }
    for (const m of src.matchAll(/\bthe ([a-z]{4,20})\b/gi)) {
        const word = m[1].toLowerCase();
        if (ROLE_STOP.has(word)) continue;
        out.push({ name: `the ${word}`, mid: true });
    }
    return out;
}

/**
 * People mentioned in at least `threshold` messages, who are not already saved, declined, or a place.
 * A single proper name counts only when it also appears mid-sentence. "the barmaid" counts; "the door" does not.
 */
export function suggestNames(messages, { known = [], declined = [], places = [], threshold = SUGGEST_AFTER } = {}) {
    const skip = new Set([...known, ...declined, ...places].map(normName).filter(Boolean));
    const counts = new Map();
    for (const m of messages ?? []) {
        const seen = new Set();
        for (const hit of mentionsIn(m.text ?? m.mes ?? '')) {
            const key = normName(hit.name);
            if (!key || skip.has(key) || seen.has(key)) continue;
            seen.add(key);
            const row = counts.get(key) ?? { key, label: hit.name, count: 0, mid: false };
            row.count++;
            if (hit.mid) row.mid = true;
            counts.set(key, row);
        }
    }
    return [...counts.values()].filter(r => r.count >= threshold && (r.key.startsWith('the ') || r.label.includes(' ') || r.mid));
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
