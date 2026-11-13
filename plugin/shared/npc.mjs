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
